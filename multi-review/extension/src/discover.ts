import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { exec } from "./target.ts";

// ---------- gitignore-aware directory scan ----------

interface GitignorePattern {
	/** True if pattern starts with '/' — anchored to the .gitignore file's directory. */
	anchored: boolean;
	/** True if pattern ends with '/' — only matches directories. */
	dirOnly: boolean;
	/** True if pattern starts with '!'. */
	negated: boolean;
	/** The pattern body to test (anchored and dirOnly stripped). */
	pattern: string;
}

interface DiscoverResult {
	files: string[];
	strategy: "git-ls-files" | "gitignore-walk";
	truncated: boolean;
	error?: string;
}

/**
 * Parse one .gitignore file's content into a list of pattern descriptors.
 * Lines starting with `#` (with optional leading whitespace) are comments;
 * empty lines are skipped. We keep the pattern body verbatim — glob-to-regex
 * conversion happens at match time so we don't bake invalid assumptions
 * about separators into the AST.
 */
function parseGitignore(content: string): GitignorePattern[] {
	const out: GitignorePattern[] = [];
	for (const rawLine of content.split(/\r?\n/)) {
		const hashIdx = rawLine.indexOf("#");
		const line = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim();
		if (!line) continue;
		let working = line;
		let negated = false;
		if (working.startsWith("!")) {
			negated = true;
			working = working.slice(1);
		}
		// Escape leading '\' (rare; we only handle the simple case).
		if (working.startsWith("\\")) working = working.slice(1);
		const anchored = working.startsWith("/");
		if (anchored) working = working.slice(1);
		const dirOnly = working.endsWith("/");
		if (dirOnly) working = working.slice(0, -1);
		out.push({ anchored, dirOnly, negated, pattern: working });
	}
	return out;
}

/**
 * Adapt a parsed gitignore pattern into the string we feed to the regex
 * compiler. Unanchored patterns with no internal '/' behave like
 * a globstar-prefix form (match at any depth); anchored patterns stay as-is.
 */
function patternSemanticsFor(p: GitignorePattern): { candidate: string; anchored: boolean } {
	let body = p.pattern;
	const anchored = p.anchored;
	if (!anchored && !body.includes("/")) {
		body = `**/${body}`;
	}
	return { candidate: body, anchored };
}

/**
 * Compile a single gitignore pattern body into a RegExp.
 *
 * Supports:
 *   `*`   any chars except '/'
 *   `?`   any single char except '/'
 *   `[abc]` character class (uses JS regex semantics, including ranges)
 *   `**`  any chars including '/' (only meaningful when paired with `/`,
 *         either as a globstar prefix or suffix)
 *
 * Limitations (documented):
 * - No alternation `{a,b}` and no extglob `+(a|b)`.
 * - Trailing `/` on the candidate path is appended to also handle the
 *   directory case from a parent gitignore when evaluating the child.
 */
function gitignorePatternToRegex(glob: string, anchored: boolean): RegExp {
	let out = "^";
	let i = 0;
	while (i < glob.length) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				const before = i > 0 ? glob[i - 1] : "";
				const after = glob[i + 2];
				if (after === "/") {
					// `**/x` — any depth; treat `**/` as zero or more dirs.
					out += "(?:.*/)?";
					i += 3;
					continue;
				}
				if (i > 0 && before === "/" && (i + 2 === glob.length)) {
					// `x/**` — anything after x. The next iteration's chars
					// are appended after `.*` for the trailing '/' design.
					out += ".*";
					i += 2;
					continue;
				}
				out += "[^/]*";
				i += 2;
				continue;
			}
			out += "[^/]*";
			i += 1;
			continue;
		}
		if (ch === "?") {
			out += "[^/]";
			i += 1;
			continue;
		}
		if (/[.+^$(){}|\\\[\]]/.test(ch)) {
			out += "\\" + ch;
			i += 1;
			continue;
		}
		out += ch;
		i += 1;
	}
	if (anchored) {
		out += "(?:/.*)?$";
	} else {
		out += "$";
	}
	return new RegExp(out);
}

/**
 * Walk a .gitignore stack to decide whether `relPath` is ignored. Last
 * match wins within a single .gitignore; we accumulate across ancestry.
 * For each ancestor .gitignore, candidate path is re-expressed relative
 * to that ancestor's directory before pattern matching.
 */
function pathIsIgnoredByStack(
	relPath: string,
	isDir: boolean,
	gitignores: Array<{ dir: string; patterns: GitignorePattern[] }>,
): boolean {
	let result = false;
	const sorted = [...gitignores].sort((a, b) => a.dir.length - b.dir.length);
	for (const gi of sorted) {
		const dirRel = gi.dir;
		// The gitignore applies to files at-or-below dirRel.
		if (dirRel !== "" && !relPath.startsWith(dirRel + "/")) continue;
		const within = dirRel === "" ? relPath : relPath.slice(dirRel.length + 1);
		for (const p of gi.patterns) {
			if (p.dirOnly && !isDir) continue;
			const sem = patternSemanticsFor(p);
			const re = gitignorePatternToRegex(sem.candidate, sem.anchored);
			if (re.test(within) || re.test(within + "/")) {
				result = p.negated ? false : true;
			}
		}
	}
	return result;
}

/**
 * Iterative DFS through `root` collecting files (paths relative to root)
 * and every .gitignore it finds along with the relative directory each
 * applies to. Hard-excludes the usual heavy directories irrespective of
 * gitignore (so a project missing `.gitignore` still gets a sensible
 * listing).
 *
 * Symlinks are listed but never followed (no recursion into loops).
 */
async function walkAndCollectGitignores(
	root: string,
): Promise<{ files: string[]; gitignores: Array<{ dir: string; patterns: GitignorePattern[] }>; error?: string }> {
	const files: string[] = [];
	const gitignores: Array<{ dir: string; patterns: GitignorePattern[] }> = [];

	const HARD_EXCLUDE_DIRS = new Set([
		".git", "node_modules", "dist", "build", ".next", "target",
		".cache", ".turbo", "coverage", ".venv", "__pycache__",
	]);
	const MAX_DEPTH = 12;
	const MAX_ENTRIES = 200_000;

	type Stack = { abs: string; relDir: string; depth: number };
	const stack: Stack[] = [{ abs: root, relDir: "", depth: 0 }];
	let entries = 0;

	try {
		while (stack.length > 0) {
			if (entries++ > MAX_ENTRIES) {
				return { files, gitignores, error: "max-entry-walk-cap-exceeded" };
			}
			const node = stack.pop()!;
			if (node.depth > MAX_DEPTH) continue;
			let listing: fs.Dirent[];
			try {
				listing = fs.readdirSync(node.abs, { withFileTypes: true });
			} catch {
				continue;
			}
			listing.sort((a, b) => a.name.localeCompare(b.name));
			for (const dirent of listing) {
				const childAbs = path.join(node.abs, dirent.name);
				const childRel = node.relDir === "" ? dirent.name : `${node.relDir}/${dirent.name}`;
				if (dirent.isDirectory()) {
					if (HARD_EXCLUDE_DIRS.has(dirent.name)) continue;
					stack.push({ abs: childAbs, relDir: childRel, depth: node.depth + 1 });
				} else if (dirent.isFile() || dirent.isSymbolicLink()) {
					files.push(childRel);
					if (dirent.name === ".gitignore") {
						try {
							const content = fs.readFileSync(childAbs, "utf8");
							gitignores.push({ dir: node.relDir, patterns: parseGitignore(content) });
						} catch {
							/* malformed file — skip silently */
						}
					}
				}
			}
		}
	} catch (err) {
		return {
			files,
			gitignores,
			error: err instanceof Error ? err.message : String(err),
		};
	}
	return { files, gitignores };
}

/**
 * Public entry point. Tries `git ls-files --cached --others
 * --exclude-standard` first (handles gitignore natively for git repos).
 * If git isn't available, the cwd isn't a repo, or the result is empty,
 * falls back to a managed walker that respects .gitignore explicitly.
 *
 * The result excludes .gitignore itself, configs in .gitignore'd dirs,
 * and binary/lockfile outputs. Intended use is "what range of files
 * should reviewers see when given a free-text focus hint".
 */
export async function discoverSourceFiles(pi: ExtensionAPI, cwd: string): Promise<DiscoverResult> {
	// Strategy 1: git ls-files. Single call covers tracked + untracked-non-ignored.
	const lsFiles = await exec(
		pi,
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		cwd,
		20_000,
	);
	if (lsFiles.code === 0) {
		const files = lsFiles.stdout
			.split("\0")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
		if (files.length > 0) {
			return { files, strategy: "git-ls-files", truncated: false };
		}
	}

	// Strategy 2: filesystem walk + gitignore parser.
	const walked = await walkAndCollectGitignores(cwd);
	if (walked.error) {
		return { files: [], strategy: "gitignore-walk", truncated: false, error: walked.error };
	}
	const filtered: string[] = [];
	for (const file of walked.files) {
		const fileDir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
		const stack: Array<{ dir: string; patterns: GitignorePattern[] }> = [];
		for (const gi of walked.gitignores) {
			if (gi.dir === fileDir || (gi.dir !== "" && fileDir.startsWith(gi.dir + "/"))) {
				stack.push(gi);
			}
		}
		if (!pathIsIgnoredByStack(file, false, stack)) filtered.push(file);
	}
	return { files: filtered, strategy: "gitignore-walk", truncated: false };
}
