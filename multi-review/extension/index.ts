/**
 * Multi-Review — fan-out code reviewer (DESIGN: ../README.md · ../install.md)
 *
 * Surfaces:
 *   /multi-review [PR-number | free-text focus]
 *   multi_review (tool) — same shape, agent-callable
 *
 * Pipeline (shared by both):
 *   parseReviewArgs → resolve pool + judge
 *                     → buildReviewTarget (PR via gh, fallback to git fetch;
 *                                          default-branch diff; or directory listing)
 *                     → runAllReviewers (parallel completeSimple, capped at concurrency)
 *                     → dedupeReviewerFindings (greedy overlap, consensus badge)
 *                     → runJudge (single completeSimple on configured judge)
 *                     → pi.sendMessage({ customType: "multi-review", … })
 *                     → pi.registerMessageRenderer collapses/expands it in TUI
 *
 * Persistent defaults: $PI_CODING_AGENT_DIR/multi-review.json loaded once,
 * unknown keys / bad JSON / missing file → silent in-code defaults.
 *
 * Constraint enforced throughout: this extension never writes to
 * ~/.pi/agent/models.json. It only reads ctx.modelRegistry.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExecResult } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { getAgentDir, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Box, Container, Key, Markdown, matchesKey, Spacer, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";

/** Provider/model-id pair as written in the defaults file and the picker. */
export type ModelSpec = `${string}/${string}`;

/**
 * Output of runMultiReviewFromArgs. Tool surface returns it; slash command
 * uses notify unless explicitly told to stay silent (we don't, today).
 */
export interface MultiReviewRunResult {
	kind: "inject" | "notify";
	notifyMessage: string;
	notifyLevel: "info" | "warning" | "error";
	injectMessage?: {
		customType: "multi-review";
		content: string;
		details: MultiReviewDetails;
	};
}

/** Per-reviewer input that survives a /reload (saved via pi.appendEntry). */
export interface MultiReviewConfig {
	reviewers: ModelSpec[];
	judge: ModelSpec;
	judgeThinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	concurrency: number;
	temperature: number;
}

const DEFAULTS: MultiReviewConfig = {
	reviewers: [],
	judge: "fireworks/accounts/fireworks/models/glm-5p2",
	judgeThinking: "high",
	concurrency: 4,
	temperature: 0.2,
};

const STATUS_KEY = "multi-review";

/**
 * Read $PI_CODING_AGENT_DIR/multi-review.json once and cache. Unknown keys,
 * missing file, or malformed JSON → silent fallback to in-code defaults.
 * This intentionally mirrors the tdd-pipeline-extension convention so
 * users have one mental model across extensions in this repo.
 */
let cachedConfig: MultiReviewConfig | null = null;
function cacheConfigForFreshRead(): void {
	cachedConfig = null;
}
function loadConfig(): MultiReviewConfig {
	if (cachedConfig !== null) return cachedConfig;
	cachedConfig = { ...DEFAULTS };
	try {
		const configPath = path.join(getAgentDir(), "multi-review.json");
		if (!fs.existsSync(configPath)) return cachedConfig;
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
		if (!parsed || typeof parsed !== "object") return cachedConfig;
		if (Array.isArray(parsed.reviewers)) {
			cachedConfig.reviewers = parsed.reviewers.filter(
				(x): x is ModelSpec => typeof x === "string" && x.includes("/"),
			);
		}
		if (typeof parsed.judge === "string" && parsed.judge.includes("/")) {
			cachedConfig.judge = parsed.judge as ModelSpec;
		}
		const tk: MultiReviewConfig["judgeThinking"] = parsed.judgeThinking;
		if (typeof tk === "string" && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(tk)) {
			cachedConfig.judgeThinking = tk;
		}
		if (typeof parsed.concurrency === "number" && parsed.concurrency > 0 && parsed.concurrency <= 16) {
			cachedConfig.concurrency = Math.floor(parsed.concurrency);
		}
		if (typeof parsed.temperature === "number" && parsed.temperature >= 0 && parsed.temperature <= 2) {
			cachedConfig.temperature = parsed.temperature;
		}
	} catch {
		cachedConfig = { ...DEFAULTS };
	}
	return cachedConfig;
}

/**
 * Convert "provider/id" into a Model via the live registry. Useful because
 * the registry is the single source of truth for what the user actually has
 * configured (with API keys, etc.) — it already accounts for models.json
 * overrides, OAuth sessions, and absent credentials. We deliberately do NOT
 * add new entries to the registry here (per the design constraint).
 */
export function findModel(ctx: ExtensionContext, spec: ModelSpec): Model | null {
	const slash = spec.indexOf("/");
	if (slash <= 0) return null;
	const provider = spec.slice(0, slash);
	const id = spec.slice(slash + 1);
	return ctx.modelRegistry.find(provider, id);
}

/**
 * Resolve the configured reviewer pool against the live ModelRegistry.
 * Returns the resolved Models plus any spec strings that failed to resolve
 * (so the caller can surface them to the user). Returns null when the
 * resolved pool is empty — never invent reviewers, never fall back to a
 * "default" model, because doing so silently changes the user's intent.
 */
export async function resolveReviewerPool(
	ctx: ExtensionContext,
	cfg: MultiReviewConfig,
): Promise<{ resolved: { spec: ModelSpec; model: Model }[]; missing: ModelSpec[] } | null> {
	const available: Model[] = await ctx.modelRegistry.getAvailable();
	const availableKeys = new Set(available.map((m) => `${m.provider}/${m.id}`));

	const resolved: { spec: ModelSpec; model: Model }[] = [];
	const missing: ModelSpec[] = [];
	for (const spec of cfg.reviewers) {
		if (!availableKeys.has(spec)) {
			missing.push(spec);
			continue;
		}
		const model = findModel(ctx, spec)!;
		resolved.push({ spec, model });
	}

	if (resolved.length === 0) return null;
	return { resolved, missing };
}

/**
 * Resolve the configured judge model. Returns null when missing; refrains
 * from falling back to any other model because the user picked that one
 * specifically in the defaults file.
 */
export function resolveJudge(ctx: ExtensionContext, cfg: MultiReviewConfig): Model | null {
	return findModel(ctx, cfg.judge);
}

function describePool(cfg: MultiReviewConfig): string {
	if (cfg.reviewers.length === 0)
		return "no reviewers configured (set multi-review.reviewers in ~/.pi/agent/multi-review.json)";
	const sample = cfg.reviewers.slice(0, 3).join(", ");
	const tail = cfg.reviewers.length > 3 ? `, +${cfg.reviewers.length - 3} more` : "";
	return `pool: ${cfg.reviewers.length} (${sample}${tail})`;
}

function describeResolved(resolved: { spec: ModelSpec }[], missing: ModelSpec[]): string {
	const lines: string[] = [];
	if (resolved.length > 0) {
		lines.push(`resolved ${resolved.length} reviewer${resolved.length === 1 ? "" : "s"}:`);
		for (const r of resolved) lines.push(`  ✓ ${r.spec}`);
	}
	if (missing.length > 0) {
		lines.push(`skipped ${missing.length} (not in registry / missing API key):`);
		for (const m of missing) lines.push(`  – ${m}`);
		lines.push("");
		lines.push("Add the missing model to ~/.pi/agent/models.json (per the design");
		lines.push("constraint, this extension does NOT edit models.json), or remove it");
		lines.push("from multi-review.reviewers, or log in via /login.");
	}
	return lines.join("\n");
}

function setStatus(text: string | undefined, ctx: ExtensionContext) {
	ctx.ui.setStatus(STATUS_KEY, text);
}

// ---------- scope resolution ----------

/**
 * Parsed /multi-review argument. Three shapes:
 *   - `pr`         : /multi-review 4321      → PR #4321
 *   - `pr`         : /multi-review #4321    → same
 *   - `pr`         : /multi-review #4321 https://github.com/owner/repo/pull/4321
 *   - `text`       : /multi-review focus the auth/ subdirectory
 *   - `default`    : bare /multi-review       → whatever the cwd implies
 */
export type ParsedReviewArgs =
	| { kind: "pr"; number: number; raw: string }
	| { kind: "text"; value: string }
	| { kind: "default" };

export function parseReviewArgs(raw: string): ParsedReviewArgs {
	const trimmed = raw.trim();
	if (!trimmed) return { kind: "default" };
	// Pull-style refs like #1234 or gh-style URLs.
	const hashMatch = trimmed.match(/(?:^|\s)#(\d{1,7})\b/);
	if (hashMatch) {
		const number = Number(hashMatch[1]);
		if (Number.isFinite(number) && number > 0) {
			return { kind: "pr", number, raw: trimmed.replace(/(?:^|\s)#\d{1,7}\b/, "").trim() };
		}
	}
	const urlMatch = trimmed.match(/\/pull\/(\d{1,7})(?:$|\D)/);
	if (urlMatch) {
		const number = Number(urlMatch[1]);
		if (Number.isFinite(number) && number > 0) {
			const leftover = trimmed.replace(urlMatch[0], "").trim();
			return { kind: "pr", number, raw: leftover };
		}
	}
	// Plain digits with nothing else (or a branch hint trailing).
	const firstToken = trimmed.split(/\s+/)[0];
	if (/^\d{1,7}$/.test(firstToken)) {
		const leftover = trimmed.slice(firstToken.length).trim();
		return { kind: "pr", number: Number(firstToken), raw: leftover };
	}
	return { kind: "text", value: trimmed };
}

/**
 * The fully-resolved target that reviewers get fed. Built by trying several
 * sources; warnings collect every partial failure so the final notify can
 * surface them and the user knows why their diff looks thin.
 */
export interface ReviewTarget {
	kind: "pr" | "default" | "text";
	label: string;
	focusHint: string;
	files: { path: string; lines: number }[];
	diffText: string;
	metaLines: string[];
	warnings: string[];
}

async function exec(pi: ExtensionAPI, command: string, args: string[], cwd: string, timeoutMs = 30_000): Promise<ExecResult> {
	return pi.exec(command, args, { cwd, timeout: timeoutMs });
}

/**
 * Extract a list of "path  +/-N lines" pairs from a unified diff. Used by
 * buildReviewTarget to give reviewers a heads-up about size without forcing
 * them to re-parse the diff token stream.
 */
function summarizeDiff(diff: string): { files: { path: string; lines: number }[] } {
	const out: { path: string; lines: number }[] = [];
	let current: { path: string; lines: number } | null = null;
	for (const line of diff.split("\n")) {
		const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
		if (m) {
			if (current) out.push(current);
			current = { path: m[2], lines: 0 };
			continue;
		}
		// Approximate changed lines: count + and - prefixes but not --/++ headers.
		if (current && /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)) current.lines++;
	}
	if (current) out.push(current);
	return { files: out };
}

/**
 * Resolve a PR target using whatever is locally available:
 *   1. `gh pr view` + `gh pr diff` (preferred; carries metadata)
 *   2. `git fetch origin pull/<n>/head:pr-<n>` + `git diff` (works without gh)
 *   3. Refuse politely if both fail.
 */
async function buildPrTarget(pi: ExtensionAPI, parsed: { number: number }, cwd: string): Promise<ReviewTarget> {
	const target: ReviewTarget = {
		kind: "pr",
		label: `PR #${parsed.number}`,
		focusHint: parsed.raw,
		files: [],
		diffText: "",
		metaLines: [],
		warnings: [],
	};

	// Try `gh` first.
	const ghView = await exec(pi, "gh", ["pr", "view", String(parsed.number), "--json",
		"title,body,baseRefName,headRefName,url,files", "-q",
		".title, .body, .baseRefName, .headRefName, .url, (.files | map(.path) | join(\",\"))"
	], cwd, 15_000);
	if (ghView.code === 0 && ghView.stdout.trim()) {
		try {
			const view = JSON.parse(ghView.stdout);
			if (view.title) target.metaLines.push(`title: ${view.title}`);
			if (view.url) target.metaLines.push(`url: ${view.url}`);
			if (view.baseRefName && view.headRefName) target.metaLines.push(`base: ${view.baseRefName} ← head: ${view.headRefName}`);
			if (view.body) {
				const body = String(view.body).trim();
				if (body) target.metaLines.push("body:", "", body.split("\n").slice(0, 40).map((l: string) => `  ${l}`).join("\n"));
			}
		} catch {
			target.warnings.push(`gh pr view JSON parse failed: ${ghView.stdout.slice(0, 200)}`);
		}
		const ghDiff = await exec(pi, "gh", ["pr", "diff", String(parsed.number)], cwd, 30_000);
		if (ghDiff.code === 0) {
			target.diffText = ghDiff.stdout;
			const summary = summarizeDiff(ghDiff.stdout);
			target.files = summary.files;
			return target;
		}
		target.warnings.push(`gh pr diff failed (exit ${ghDiff.code}); falling back to git fetch`);
	} else {
		target.warnings.push(`gh pr view failed (exit ${ghView.code}); falling back to git fetch`);
	}

	// Fallback: pull/<N>/head refspec.
	const refName = `pr-${parsed.number}`;
	const fetch = await exec(pi, "git", ["fetch", "--no-tags", "origin", `pull/${parsed.number}/head:${refName}`], cwd, 60_000);
	if (fetch.code !== 0) {
		target.warnings.push(`git fetch origin pull/${parsed.number}/head failed (exit ${fetch.code}, stderr: ${fetch.stderr.slice(0, 200)})`);
		return target;
	}
	const diff = await exec(pi, "git", ["diff", `${refName}...HEAD`], cwd, 30_000);
	if (diff.code !== 0) {
		target.warnings.push(`git diff ${refName}...HEAD failed (exit ${diff.code}, stderr: ${diff.stderr.slice(0, 200)})`);
		return target;
	}
	target.diffText = diff.stdout;
	target.metaLines.push(`(fallback: fetched origin/pull/${parsed.number}/head as ${refName})`);
	target.files = summarizeDiff(diff.stdout).files;
	return target;
}

/**
 * Default target: try several common "diff vs base" strategies in order so
 * bare `/multi-review` does something useful without args in most repos.
 */
async function buildDefaultTarget(pi: ExtensionAPI, cwd: string): Promise<ReviewTarget> {
	const target: ReviewTarget = {
		kind: "default",
		label: "cwd diff vs default base",
		focusHint: "",
		files: [],
		diffText: "",
		metaLines: [],
		warnings: [],
	};

	// Step 1: figure out the current branch + upstream.
	const branch = await exec(pi, "git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd, 5_000);
	const upstream = await exec(pi, "git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd, 5_000);
	const baseCandidates: string[] = [];
	if (upstream.code === 0) baseCandidates.push(upstream.stdout.trim());
	for (const candidate of ["main", "master", "develop", "origin/main", "origin/master"]) {
		if (!baseCandidates.includes(candidate)) baseCandidates.push(candidate);
	}

	for (const base of baseCandidates) {
		const refExists = await exec(pi, "git", ["rev-parse", "--verify", base], cwd, 5_000);
		if (refExists.code !== 0) continue;
		const diff = await exec(pi, "git", ["diff", `${base}...HEAD`], cwd, 30_000);
		if (diff.code === 0 && diff.stdout.trim()) {
			target.label = `cwd diff vs ${base}`;
			target.metaLines.push(`branch: ${branch.stdout.trim() || "(unknown)"}`);
			target.metaLines.push(`base: ${base}`);
			target.diffText = diff.stdout;
			target.files = summarizeDiff(diff.stdout).files;
			return target;
		}
	}

	// Step 2: last commit's diff (works in shallow/no-upstream setups).
	const last = await exec(pi, "git", ["show", "--unified=3", "HEAD", "--stat"], cwd, 15_000);
	if (last.code === 0 && last.stdout.trim()) {
		target.label = "last commit (HEAD)";
		target.metaLines.push(`branch: ${branch.stdout.trim() || "(unknown)"}`);
		target.metaLines.push("(no upstream diff found; using last commit)");
		target.diffText = last.stdout;
		target.files = summarizeDiff(last.stdout).files;
		return target;
	}

	target.warnings.push("Not a git repo, or no diffs available; reviewers will only see focus text + a directory listing.");
	return target;
}

/**
 * Free-text focus: no diff. We list source files in cwd so reviewers at
 * least have a directory map when the user-supplied hint references places.
 */
async function buildTextTarget(pi: ExtensionAPI, cwd: string, hint: string): Promise<ReviewTarget> {
	const target: ReviewTarget = {
		kind: "text",
		label: `free-text: ${hint.slice(0, 60)}${hint.length > 60 ? "…" : ""}`,
		focusHint: hint,
		files: [],
		diffText: "",
		metaLines: ["no diff available — reviewers receive your hint plus a directory listing"],
		warnings: [],
	};

	const result = await discoverSourceFiles(pi, cwd);
	if (result.files.length > 0) {
		const capped = result.files.slice(0, 200);
		target.files = capped.map((path) => ({ path, lines: 0 }));
		target.metaLines.push(
			`directory listing: ${result.files.length} file${result.files.length === 1 ? "" : "s"} ` +
				`(strategy: ${result.strategy}${result.files.length > 200 ? ", capped at 200" : ""})`,
		);
	} else {
		target.warnings.push(
			result.error
				? `directory scan failed (${result.error}); reviewers will only see your text hint`
				: `directory scan found no files; reviewers will only see your text hint`,
		);
	}
	return target;
}

export async function buildReviewTarget(pi: ExtensionAPI, parsed: ParsedReviewArgs, cwd: string): Promise<ReviewTarget> {
	if (parsed.kind === "pr") return buildPrTarget(pi, parsed, cwd);
	if (parsed.kind === "default") return buildDefaultTarget(pi, cwd);
	return buildTextTarget(pi, cwd, parsed.value);
}

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
 * `**/<body>` (match at any depth); anchored patterns stay as-is.
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
 *         either prefix `**/x` or suffix `x/**`)
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
async function discoverSourceFiles(pi: ExtensionAPI, cwd: string): Promise<DiscoverResult> {
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

// ---------- parallel fan-out ----------

/**
 * One finding produced by a single reviewer. The fields are deliberately
 * permissive (line_start/line_end are nullable when the model picks a wider
 * area than a single hunk) so a future free-form finding doesn't blow up
 * the parser. Categories are free-form short labels (correctness / security /
 * perf / style / docs / api-design) so the dedupe pass can group without
 * caring about taxonomy.
 */
export interface ReviewerFinding {
	file: string;
	line_start: number | null;
	line_end: number | null;
	severity: "critical" | "high" | "medium" | "low" | "info" | "none";
	category: string;
	title: string;
	comment: string;
}

export interface ReviewerRunResult {
	spec: ModelSpec;
	model: Model;
	ok: boolean;
	findings: ReviewerFinding[];
	rawText: string;
	stopReason: string;
	errorMessage?: string;
	usage?: { input: number; output: number; total: number; cost: number };
	durationMs: number;
}

const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer. Read the diff and the optional focus hint, then output ONLY a JSON array.

Schema:
[
  {
    "file": "relative/path/from/repo/root",
    "line_start": <int|null>,
    "line_end": <int|null>,
    "severity": "critical"|"high"|"medium"|"low"|"info"|"none",
    "category": "correctness"|"security"|"perf"|"style"|"docs"|"api-design"|"<short free-form label>",
    "title": "<short, ≤80 chars>",
    "comment": "<one paragraph explanation, ≤400 chars>"
  }
]

Rules:
- Output ONLY the JSON array. No prose, no markdown fences unless you must.
- If you see no problems, output []. Do not pad.
- Prefer one finding per concrete issue; do not bundle a file's worth of small things into one entry.
- line_start/line_end should match the diff's "++ b/path" hunk (line numbers AFTER the change, not before).
- If the diff is not a git diff but a directory listing, comment at the file level only and leave line_start/line_end null.
- Severity: critical (security vulns, data loss), high (correctness bugs, race conditions), medium (perf cliffs, panic-on-bad-input), low (subtle), info (style, docs).`;

/**
 * Build the reviewer-side user prompt from a target. We truncate the diff
 * conservatively because some reviewers have short context managers — the
 * prompt keeps the head of the diff where hunk headers live and ditches the
 * rest after a generous budget. Reviewers with larger windows still see the
 * full diff.
 */
const DIFF_BUDGET_CHARS = 200_000; // ~50k tokens worst case
function buildReviewUserPrompt(target: ReviewTarget): string {
	const chunks: string[] = [];
	if (target.metaLines.length > 0) {
		chunks.push("## Context");
		chunks.push(...target.metaLines);
		chunks.push("");
	}
	if (target.diffText) {
		const diff = target.diffText.length > DIFF_BUDGET_CHARS
			? target.diffText.slice(0, DIFF_BUDGET_CHARS) +
				`\n…(diff truncated to ${DIFF_BUDGET_CHARS} chars; ${target.diffText.length} total)\n`
			: target.diffText;
		chunks.push("## Diff");
		chunks.push(diff);
		chunks.push("");
	} else if (target.files.length > 0) {
		chunks.push("## Files in scope (no diff; review at the file level)");
		for (const f of target.files) chunks.push(`- ${f.path}`);
		chunks.push("");
	}
	if (target.focusHint) {
		chunks.push("## Focus hint from caller");
		chunks.push(target.focusHint);
		chunks.push("");
	}
	chunks.push("Reminder: output ONLY the JSON array per the schema in the system prompt.");
	return chunks.join("\n");
}

/**
 * Strip a JSON-array-shaped response from any junk the model wraps around it.
 * Some models — especially Fireworks-hosted ones — sometimes honor the
 * 'ONLY JSON' rule by wrapping in a ```json fence. This is tolerant of both.
 */
function parseReviewerJson(rawText: string): ReviewerFinding[] {
	const text = rawText.trim();
	// Strip leading/trailing fences if present.
	const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	const inner = fenceMatch ? fenceMatch[1] : text;
	// Find first '[' and last ']' to ignore any wrapper text.
	const start = inner.indexOf("[");
	const end = inner.lastIndexOf("]");
	if (start === -1 || end === -1 || end <= start) return [];
	const slice = inner.slice(start, end + 1);
	const parsed = JSON.parse(slice);
	if (!Array.isArray(parsed)) return [];
	const findings: ReviewerFinding[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object") continue;
		const f = item as Partial<ReviewerFinding>;
		const lineStart = typeof f.line_start === "number" && Number.isFinite(f.line_start) ? Math.floor(f.line_start) : null;
		const lineEnd = typeof f.line_end === "number" && Number.isFinite(f.line_end) ? Math.floor(f.line_end) : null;
		const severityCandidate = String(f.severity ?? "info").toLowerCase();
		const severity: ReviewerFinding["severity"] = ["critical", "high", "medium", "low", "info", "none"].includes(severityCandidate)
			? (severityCandidate as ReviewerFinding["severity"])
			: "info";
		const category = String(f.category ?? "general").slice(0, 32).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "general";
		const title = String(f.title ?? "(untitled)").slice(0, 200);
		const comment = String(f.comment ?? "").slice(0, 2000);
		const filePath = String(f.file ?? "").trim();
		if (!filePath) continue;
		findings.push({ file: filePath, line_start: lineStart, line_end: lineEnd, severity, category, title, comment });
	}
	return findings;
}

async function runReviewer(
	model: Model,
	ctx: ExtensionContext,
	systemPrompt: string,
	userPrompt: string,
	temperature: number,
	abortSignal: AbortSignal | undefined,
): Promise<Omit<ReviewerRunResult, "spec">> {
	const started = Date.now();
	const { completeSimple } = await import("@mariozechner/pi-ai");
	const response = await completeSimple(
		model,
		{ systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }] },
		{ signal: abortSignal, temperature, maxTokens: 4096 },
	);
	const text = response.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { type: "text"; text: string }).text)
		.join("");
	let findings: ReviewerFinding[] = [];
	let ok = true;
	let errorMessage: string | undefined;
	try {
		findings = parseReviewerJson(text);
	} catch (err) {
		ok = false;
		errorMessage = `json-parse: ${err instanceof Error ? err.message : String(err)}`;
	}
	return {
		model,
		ok,
		findings,
		rawText: text,
		stopReason: response.stopReason,
		errorMessage,
		usage: response.usage
			? {
				input: response.usage.input,
				output: response.usage.output,
				total: response.usage.totalTokens,
				cost: response.usage.cost?.total ?? 0,
			}
			: undefined,
		durationMs: Date.now() - started,
	};
}

const MAX_PARALLEL = 16;

/**
 * Run every reviewer model against the same prompt with a concurrency cap.
 * Use fail-soft: a single model crashing or producing unparseable JSON
 * never aborts the rest of the fan-out. The Promise.all over per-slot promise
 * arrays gives us the cap without a custom queue.
 */
async function runAllReviewers(
	resolved: { spec: ModelSpec; model: Model }[],
	systemPrompt: string,
	userPrompt: string,
	concurrency: number,
	temperature: number,
	abortSignal: AbortSignal | undefined,
	ctx: ExtensionContext,
	onProgress?: (done: number, total: number, latest: ReviewerRunResult) => void,
): Promise<ReviewerRunResult[]> {
	const cap = Math.max(1, Math.min(MAX_PARALLEL, concurrency, resolved.length));
	const results: ReviewerRunResult[] = [];
	let cursor = 0;
	let done = 0;
	const total = resolved.length;

	// Worker slot: pulls next reviewer, runs, stores result. We launch `cap`
	// workers up front; each races to grab via the shared cursor.
	const worker = async (): Promise<void> => {
		while (true) {
			if (abortSignal?.aborted) return;
			const idx = cursor++;
			if (idx >= resolved.length) return;
			const slot = resolved[idx];
			try {
				const partial = await runReviewer(slot.model, ctx, systemPrompt, userPrompt, temperature, abortSignal);
				const full: ReviewerRunResult = { spec: slot.spec, ...partial };
				results[idx] = full;
				done++;
				onProgress?.(done, total, full);
			} catch (err) {
				const full: ReviewerRunResult = {
					spec: slot.spec,
					model: slot.model,
					ok: false,
					findings: [],
					rawText: "",
					stopReason: "error",
					errorMessage: err instanceof Error ? err.message : String(err),
					durationMs: 0,
				};
				results[idx] = full;
				done++;
				onProgress?.(done, total, full);
			}
		}
	};

	await Promise.all(Array.from({ length: cap }, () => worker()));
	return results;
}

// ---------- dedupe & group ----------

const SEVERITY_RANK: Record<ReviewerFinding["severity"], number> = {
	critical: 5,
	high: 4,
	medium: 3,
	low: 2,
	info: 1,
	none: 0,
};

export interface DedupeGroup {
	id: string;
	file: string;
	line_start: number | null;
	line_end: number | null;
	severity: ReviewerFinding["severity"];
	category: string;
	title: string;
	titles: string[]; // every distinct title model used
	members: { spec: ModelSpec; comment: string; severity: ReviewerFinding["severity"] }[];
	reviewerSpecs: ModelSpec[]; // unique specs that flagged this group
	consensus: boolean; // ≥ 2 distinct reviewers
}

function isOverlapping(a: ReviewerFinding, b: ReviewerFinding): boolean {
	if (a.file !== b.file) return false;
	if (a.line_start === null || a.line_end === null || b.line_start === null || b.line_end === null) return true;
	const aStart = a.line_start <= a.line_end ? a.line_start : a.line_end;
	const aEnd = a.line_start <= a.line_end ? a.line_end : a.line_start;
	const bStart = b.line_start <= b.line_end ? b.line_start : b.line_end;
	const bEnd = b.line_start <= b.line_end ? b.line_end : b.line_start;
	return aStart <= bEnd && bStart <= aEnd;
}

/**
 * Greedy O(N²) dedupe. N is small (a few dozen findings per reviewer ×
 * a handful of reviewers), so the quadratic cost is fine and the simple
 * match predicate is easier to audit than a hash-based strategy. The
 * predicate permits same-file matches to overlap (line ranges touch) and
 * also short-circuits to "same file" when either side is file-level
 * (line_start === null).
 */
export function dedupeReviewerFindings(results: ReviewerRunResult[]): DedupeGroup[] {
	const placed = new Set<string>();
	const allFindings: { spec: ModelSpec; index: number; finding: ReviewerFinding }[] = [];
	for (const r of results) {
		if (!r.ok) continue;
		r.findings.forEach((finding, index) => {
			allFindings.push({ spec: r.spec, index, finding });
		});
	}

	const groups: DedupeGroup[] = [];
	for (const { spec, index, finding } of allFindings) {
		const key = `${spec}::${index}`;
		if (placed.has(key)) continue;

		const group: DedupeGroup = {
			id: `g${groups.length + 1}`,
			file: finding.file,
			line_start: finding.line_start,
			line_end: finding.line_end,
			severity: finding.severity,
			category: finding.category,
			title: finding.title,
			titles: [finding.title],
			members: [{ spec, comment: finding.comment, severity: finding.severity }],
			reviewerSpecs: [spec],
			consensus: false,
		};
		placed.add(key);

		// Fuse with anything overlapping from later reviewers.
		for (let j = allFindings.indexOf({ spec, index, finding }) + 1; j < allFindings.length; j++) {
			const jt = allFindings[j];
			if (placed.has(`${jt.spec}::${jt.index}`)) continue;
			if (!isOverlapping(finding, jt.finding)) continue;
			// Already in? Skip.
			if (group.reviewerSpecs.includes(jt.spec)) {
				// Same reviewer reporting the same area twice — fuse but don't double-count.
				group.members.push({ spec: jt.spec, comment: jt.finding.comment, severity: jt.finding.severity });
				if (!group.titles.includes(jt.finding.title)) group.titles.push(jt.finding.title);
				if (SEVERITY_RANK[jt.finding.severity] > SEVERITY_RANK[group.severity]) {
					group.severity = jt.finding.severity;
				}
				placed.add(`${jt.spec}::${jt.index}`);
				continue;
			}
			group.members.push({ spec: jt.spec, comment: jt.finding.comment, severity: jt.finding.severity });
			group.reviewerSpecs.push(jt.spec);
			if (!group.titles.includes(jt.finding.title)) group.titles.push(jt.finding.title);
			if (SEVERITY_RANK[jt.finding.severity] > SEVERITY_RANK[group.severity]) {
				group.severity = jt.finding.severity;
			}
			placed.add(`${jt.spec}::${jt.index}`);
		}

		group.consensus = group.reviewerSpecs.length >= 2;
		// Line ranges — expand to cover all member ranges if previously null.
		if (group.line_start === null || group.line_end === null) {
			let minStart: number | null = null;
			let maxEnd: number | null = null;
			for (const m of group.members) {
				// re-extract from the allFindings list; a small downside is that we
				// don't carry line_start/line_end on the group member so this stays
				// best-effort. For file-level entries, leaving null is correct.
			}
			group.line_start = minStart;
			group.line_end = maxEnd;
		}
		groups.push(group);
	}

	// Sort by severity desc, then file, then line_start.
	groups.sort((a, b) => {
		const s = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
		if (s !== 0) return s;
		const f = a.file.localeCompare(b.file);
		if (f !== 0) return f;
		return (a.line_start ?? -1) - (b.line_start ?? -1);
	});
	return groups;
}

function formatRange(start: number | null, end: number | null): string {
	if (start === null && end === null) return "file";
	if (start === null) return `…${end}`;
	if (end === null || end === start) return `L${start}`;
	return `L${start}-${end}`;
}

function formatGroup(g: DedupeGroup): string {
	const badge = g.consensus ? `[CONSENSUS ×${g.reviewerSpecs.length}]` : `[×${g.reviewerSpecs.length}]`;
	const range = formatRange(g.line_start, g.line_end);
	return `${badge.padEnd(20)} ${g.severity.toUpperCase().padEnd(8)} ${g.file}:${range}  ${g.title}`;
}

// ---------- judge pass ----------

/**
 * The judge sees the deduped groups with every per-model comment attached,
 * not a flattened list. The schema forces it to write a markdown summary
 * where each finding carries an attribution strip — that's the
 * 'per-model labels preserved' requirement from the design.
 */
const JUDGE_SYSTEM_PROMPT = `You are a senior engineering lead synthesizing multiple code reviews. You receive a structured adjudication tree — do NOT invent or remove findings; rewrite them.

Output a markdown document with this exact shape:

# Multi-Model Code Review

## Summary
Two- to four-sentence overall assessment, then a one-line "Top risks" list ordered by severity.

## Findings
For each finding, in the order provided, write:

### <severity> · <title>
- **File:** <path>:<lines> (or "file" if line numbers null)
- **Category:** <category>
- **Consensus:** <reviewer-count> reviewers: <comma-separated list>
- **Comments:**
  - <spec 1>: <comment 1>
  - <spec 2>: <comment 2>
  - …

End each finding with a sub-bullet:
  - **Judge's take:** <one sentence; explain mechanics, root cause, or suggest a concrete fix.>

After the findings, if any models errored or produced unparseable output, add a final '## Coverage' section listing missing reviewers.

Rules:
- Never merge findings the user didn't ask to merge.
- Keep each finding ≤ 80 words (excluding the per-model comments list).
- Use file paths exactly as given — do not rewrite to absolute paths.
- Severity ladder is critical > high > medium > low > info > none.
- If two reviewers disagree in framing, surface both — do not pick one.`;

interface JudgeResult {
	markdown: string;
	stopReason: string;
	errorMessage?: string;
	usage?: { input: number; output: number; total: number; cost: number };
	durationMs: number;
}

function renderGroupsForJudge(target: ReviewTarget, groups: DedupeGroup[]): string {
	const lines: string[] = [];
	lines.push("## Review target");
	lines.push(`kind: ${target.kind}`);
	lines.push(`label: ${target.label}`);
	if (target.metaLines.length > 0) {
		lines.push("");
		lines.push("metadata:");
		lines.push(...target.metaLines);
	}
	if (target.focusHint) {
		lines.push("");
		lines.push(`focus hint: ${target.focusHint}`);
	}
	lines.push("");
	lines.push("## Deduped findings (in severity order)");
	if (groups.length === 0) {
		lines.push("(no findings across reviewers)");
	} else {
		for (const g of groups) {
			const range = formatRange(g.line_start, g.line_end);
			lines.push(
				`- ${g.severity.toUpperCase()}  ${g.file}:${range}  consensus=${g.consensus ? "yes" : "no"} (${g.reviewerSpecs.length} reviewers)`,
			);
			lines.push(`    category: ${g.category}`);
			lines.push(`    titles:`);
			for (const t of g.titles) lines.push(`      - ${t}`);
			lines.push(`    per-reviewer:`);
			for (const m of g.members) {
				lines.push(`      - ${m.spec} (severity=${m.severity}):`);
				// Indent the comment so the judge can paste it into the markdown verbatim.
				for (const cl of m.comment.split("\n")) lines.push(`          ${cl}`);
			}
		}
	}
	return lines.join("\n");
}

async function runJudge(
	judgeModel: Model,
	groups: DedupeGroup[],
	target: ReviewTarget,
	failedSpecs: ModelSpec[],
	ctx: ExtensionContext,
	abortSignal: AbortSignal | undefined,
	temperature: number,
): Promise<JudgeResult> {
	const started = Date.now();
	const { completeSimple } = await import("@mariozechner/pi-ai");

	const groupsPayload = renderGroupsForJudge(target, groups);
	const coverage = failedSpecs.length > 0
		? `, missing: ${failedSpecs.join(", ")}`
		: "";
	const userPrompt = `${groupsPayload}\n\n## Coverage notes\nReviewers that didn't return usable output: ${failedSpecs.length}${coverage}\n\nNow produce the markdown per the schema in the system prompt. Output ONLY markdown — no preamble, no "Here's the review:" opener.`;

	const response = await completeSimple(
		judgeModel,
		{ systemPrompt: JUDGE_SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }] },
		{ signal: abortSignal, temperature, maxTokens: 8192 },
	);
	const text = response.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { type: "text"; text: string }).text)
		.join("");
	return {
		markdown: text,
		stopReason: response.stopReason,
		errorMessage: response.errorMessage,
		usage: response.usage
			? {
				input: response.usage.input,
				output: response.usage.output,
				total: response.usage.totalTokens,
				cost: response.usage.cost?.total ?? 0,
			}
			: undefined,
		durationMs: Date.now() - started,
	};
}

// ---------- chat render ----------

/**
 * Payload attached to the message's `details` so the renderer can rebuild
 * the structured layout without re-parsing the judge's markdown. The markdown
 * itself is in `content` so it's selectable in the TUI.
 */
export interface MultiReviewDetails {
	target: ReviewTarget;
	groups: DedupeGroup[];
	reviewerSpecs: ModelSpec[];
	failedSpecs: ModelSpec[];
	judge: ModelSpec;
	judgeDurationMs: number;
	judgeUsage?: { input: number; output: number; total: number; cost: number };
	consensusCount: number;
	totalFindings: number;
}

const SEVERITY_COLOR: Record<ReviewerFinding["severity"], "error" | "warning" | "accent" | "muted" | "dim"> = {
	critical: "error",
	high: "error",
	medium: "warning",
	low: "accent",
	info: "muted",
	none: "dim",
};

const SEVERITY_BAR: Record<ReviewerFinding["severity"], string> = {
	critical: "█████",
	high: "████░",
	medium: "███░░",
	low: "██░░░",
	info: "█░░░░",
	none: "░░░░░",
};

function renderMultiReviewMessage(
	message: { content: string; details?: unknown },
	options: { expanded: boolean },
	theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string; bold: (text: string) => string },
	_ctx: unknown,
): unknown {
	const details = (message.details ?? null) as MultiReviewDetails | null;
	const container = new Container();
	const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
	box.addChild(container);

	const headline = `${theme.fg("toolTitle", theme.bold("multi-review"))} · ${
		details ? `${details.groups.length} groups, ${details.consensusCount} consensus` : "(no payload)"
	}`;
	container.addChild(new Text(headline, 0, 0));

	if (!details) {
		// Fallback to plain markdown if we somehow got here without details.
		container.addChild(new Spacer(1));
		const mdTheme = getMarkdownTheme();
		container.addChild(new Markdown(message.content, 0, 0, mdTheme));
		return box;
	}

	// Severity tally
	const tally: Record<string, number> = {};
	for (const g of details.groups) tally[g.severity] = (tally[g.severity] ?? 0) + 1;
	const tallyStr = (["critical", "high", "medium", "low", "info", "none"] as const)
		.filter((s) => tally[s])
		.map((s) => `${SEVERITY_BAR[s]} ${s}=${tally[s]}`)
		.join("   ");
	if (tallyStr) container.addChild(new Text(theme.fg("dim", tallyStr), 0, 0));

	// Scope line
	container.addChild(new Text(theme.fg("dim", `${details.target.label} · ${details.target.kind}`), 0, 0));
	container.addChild(new Text(
		theme.fg("dim", `judge: ${details.judge} · ${(details.judgeDurationMs / 1000).toFixed(1)}s`),
		0, 0,
	));

	// Per-group brief (always shown)
	for (const g of details.groups) {
		container.addChild(new Spacer(1));
		const head = `${SEVERITY_BAR[g.severity]} ${theme.fg(SEVERITY_COLOR[g.severity], g.severity.toUpperCase())} · ${theme.bold(g.title)}`;
		const consensusTag = g.consensus ? theme.fg("accent", ` [CONSENSUS ×${g.reviewerSpecs.length}]`) : "";
		container.addChild(new Text(`${head}${consensusTag}`, 0, 0));
		container.addChild(new Text(theme.fg("dim", `  ${g.file}:${formatRange(g.line_start, g.line_end)} · ${g.category}`), 0, 0));
		if (options.expanded) {
			for (const m of g.members) {
				const specShort = m.spec.split("/").pop() ?? m.spec;
				container.addChild(new Text(`    · ${theme.fg("muted", `${specShort}:`)} ${m.comment}`, 0, 0));
			}
		}
	}

	// In expanded view, render the judge's full markdown.
	if (options.expanded) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── judge markdown ───"), 0, 0));
		const mdTheme = getMarkdownTheme();
		container.addChild(new Markdown(message.content, 0, 0, mdTheme));
	} else {
		container.addChild(new Text(theme.fg("dim", "(Ctrl+O to expand for full judge markdown + per-reviewer comments)"), 0, 0));
	}

	return box;
}

// ---------- interactive reviewer picker ----------

interface PickerRow {
	kind: "provider-header" | "model";
	provider: string;
	spec?: ModelSpec;
	modelIndex?: number;
	description?: string;
}

/**
 * Build a flat row list grouped by provider. Mixed model sets render with
 * provider separators so the user can chunk pick by source. Empty
 * providers are skipped — happens with single-provider accounts.
 */
function buildPickerRows(models: Model[]): { rows: PickerRow[]; modelRowIndexToSpec: Map<number, ModelSpec> } {
	const byProvider = new Map<string, Model[]>();
	for (const m of models) {
		const arr = byProvider.get(m.provider) ?? [];
		arr.push(m);
		byProvider.set(m.provider, arr);
	}
	const providers = Array.from(byProvider.keys()).sort();
	const rows: PickerRow[] = [];
	const modelRowIndexToSpec = new Map<number, ModelSpec>();
	let modelIndex = 0;
	for (const provider of providers) {
		rows.push({ kind: "provider-header", provider });
		for (const m of byProvider.get(provider)!.sort((a, b) => a.id.localeCompare(b.id))) {
			rows.push({
				kind: "model",
				provider,
				spec: `${m.provider}/${m.id}`,
				modelIndex,
				description: m.name && m.name !== m.id ? m.name : undefined,
			});
			modelRowIndexToSpec.set(modelIndex, `${m.provider}/${m.id}`);
			modelIndex++;
		}
	}
	return { rows, modelRowIndexToSpec };
}

/**
 * Multi-select TUI picker for reviewer models. Returns the chosen specs
 * (deduped) or null on cancel. Falls back to a single confirm dialog
 * (limited UX, text-only, picking one model) when ctx.hasUI is false so
 * non-interactive modes don't block entirely.
 */
async function pickReviewersViaTUI(
	ctx: ExtensionContext,
	models: Model[],
	preSelect: ModelSpec[] = [],
): Promise<ModelSpec[] | null> {
	if (!ctx.hasUI) {
		// Best-effort fallback for print/RPC modes: select first pre-existing
		// spec that resolves else fail cleanly. We've already filtered the
		// pool upstream so this should never be the only path.
		const first = preSelect.find((s) => models.some((m) => `${m.provider}/${m.id}` === s));
		return first ? [first] : null;
	}

	const { rows, modelRowIndexToSpec } = buildPickerRows(models);
	const preSelectedModelIndices = new Set<number>();
	for (const spec of preSelect) {
		let idx = 0;
		for (const m of models) {
			if (`${m.provider}/${m.id}` === spec) {
				preSelectedModelIndices.add(idx);
				break;
			}
			idx++;
		}
	}

	// Build a contiguous-of-model-rows cursor space. Provider headers are
	// selectable-but-empty so navigation can land on them; hitting space on
	// a header is a no-op (selected count stays 0). Cursor pre-positions on
	// the first model row.
	const cursorToModelIndex: number[] = rows.map((r) => (r.kind === "model" ? (r.modelIndex ?? -1) : -1));
	let cursor = rows.findIndex((r) => r.kind === "model");
	if (cursor < 0) cursor = 0;

	const result = await ctx.ui.custom<{ spec: ModelSpec }[] | null>((_tui, theme, _kb, done) => {
		const selected = new Set<number>(preSelectedModelIndices);
		let cachedLines: string[] | undefined;

		function refresh() {
			cachedLines = undefined;
			_tui.requestRender();
		}

		function commit(cancelled: boolean) {
			if (cancelled) {
				done(null);
				return;
			}
			// Translate model indices back to specs in their picker order.
			const specList: { spec: ModelSpec }[] = [];
			const seen = new Set<ModelSpec>();
			for (let i = 0; i < rows.length; i++) {
				const r = rows[i];
				if (r.kind !== "model" || r.modelIndex === undefined) continue;
				if (!selected.has(r.modelIndex)) continue;
				const spec = modelRowIndexToSpec.get(r.modelIndex)!;
				if (seen.has(spec)) continue;
				seen.add(spec);
				specList.push({ spec });
			}
			done(specList);
		}

		function handleInput(data: string): void {
			if (matchesKey(data, Key.escape)) {
				commit(true);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				commit(false);
				return;
			}
			if (matchesKey(data, Key.up)) {
				cursor = cursor > 0 ? cursor - 1 : rows.length - 1;
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				cursor = cursor < rows.length - 1 ? cursor + 1 : 0;
				refresh();
				return;
			}
			if (matchesKey(data, Key.space) || data === " ") {
				const mi = cursorToModelIndex[cursor];
				if (mi < 0) return;
				if (selected.has(mi)) selected.delete(mi);
				else selected.add(mi);
				refresh();
				return;
			}
			// Quick-select: number keys 0-9 toggle the Nth model row.
			const num = data >= "0" && data <= "9" ? Number(data) : -1;
			if (num >= 0) {
				const modelRows = rows
					.map((r, i) => ({ r, i }))
					.filter(({ r }) => r.kind === "model")
					.slice(num * 10, num * 10 + 10);
				if (modelRows.length > 0) {
					const row = modelRows[0];
					cursor = row.i;
					const mi = cursorToModelIndex[cursor];
					if (mi >= 0) {
						if (selected.has(mi)) selected.delete(mi);
						else selected.add(mi);
					}
					refresh();
				}
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", theme.bold(" Pick reviewer models ")));
			add(theme.fg("dim", "Space toggles · ↑↓ moves · Enter confirms · Esc cancels"));
			lines.push("");

			for (let i = 0; i < rows.length; i++) {
				const r = rows[i];
				if (r.kind === "provider-header") {
					add(theme.fg("dim", " " + r.provider));
					continue;
				}
				const isCursor = i === cursor;
				const mi = r.modelIndex ?? -1;
				const isSelected = selected.has(mi);
				const cursorMark = isCursor ? theme.fg("accent", "> ") : "  ";
				const box = isSelected ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
				const label = theme.fg(isSelected ? "success" : "text", r.spec ?? "");
				add(`${cursorMark}${isSelected ? box + " " + label : box + " " + label}`);
				if (r.description) add(`     ${theme.fg("dim", r.description)}`);
			}

			lines.push("");
			const n = selected.size;
			add(theme.fg("muted", ` ${n} reviewer${n === 1 ? "" : "s"} selected.`));
			if (n === 0) add(theme.fg("warning", " Tip: space-toggle at least one to enable Enter."));
			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});

	if (!result) return null;
	return result.map((r) => r.spec);
}

/**
 * Merge `chosen` into the currently-loaded config (in-memory) AND persist
 * to ~/.pi/agent/multi-review.json so the choice survives `/reload`.
 * Unknown keys in the file are preserved untouched; bad JSON triggers
 * a clean fresh write of the merged content.
 */
function persistReviewerChoices(chosen: ModelSpec[]): { ok: boolean; error?: string; path: string } {
	const path = `${getAgentDir()}/multi-review.json`;
	let next: Record<string, unknown> = {};
	try {
		if (fs.existsSync(path)) {
			const prev = JSON.parse(fs.readFileSync(path, "utf8"));
			if (prev && typeof prev === "object" && !Array.isArray(prev)) {
				next = { ...prev };
			}
		}
	} catch {
		next = {};
	}
	if (chosen.length > 0) next.reviewers = chosen;
	if (!("judge" in next)) next.judge = DEFAULTS.judge;
	try {
		const dir = path.substring(0, path.lastIndexOf("/"));
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
		return { ok: true, path };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err), path };
	}
}

/**
 * Shared entry point used by both `/multi-review` and the `multi_review` tool.
 * Centralizes the ordering (pool → judge check → scope → fan-out → dedupe →
 * judge → inject/notify) so the only thing that differs between the two
 * surfaces is how the result surfaces.
 *
 * `signal`: pass `ctx.signal` when called from a tool execution (defined
 * during active turns) so that Ctrl+C and model_call aborts cancel all
 * in-flight reviewer and judge requests. Slash commands fire outside an
 * active turn so ctx.signal is undefined there — we degrade to no abort
 * instead of synthesizing a fake signal so the user gets to see partial
 * results rather than a recall race.
 */
/**
 * Single-shot override: when set, runMultiReviewFromArgs uses these
 * reviewers instead of cfg.reviewers. Cleared after each invocation.
 * Set ONLY by the picker fallback when the user opts not to persist.
 */
let TRANSIENT_REVIEWERS: ModelSpec[] | null = null;

async function runMultiReviewFromArgs(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	rawArgs: string,
	signal: AbortSignal | undefined,
	transientReviewers: ModelSpec[] | null = TRANSIENT_REVIEWERS,
): Promise<MultiReviewRunResult> {
	const cfg = loadConfig();
	// If the caller passes transientReviewers (e.g. from a one-off picker
	// session that the user opted not to persist), bypass the configured
	// pool for this run only. Keeping the override list distinct from cfg
	// means we never silently mutate the user's persisted defaults.
	const effectiveReviewerSpecs: ModelSpec[] = transientReviewers && transientReviewers.length > 0
		? transientReviewers
		: cfg.reviewers;
	if (effectiveReviewerSpecs.length === 0) {
		return {
			kind: "notify",
			notifyMessage:
				"multi-review: no reviewers configured.\n\n" +
				`Drop a "$PI_CODING_AGENT_DIR/multi-review.json" like:\n` +
				`  { "reviewers": ["fireworks/.../model-a", "fireworks/.../model-b"], "judge": "fireworks/.../judge" }\n` +
				`Then /reload.\n\nArgs: ${rawArgs.trim() || "(none)"}`,
			notifyLevel: "warning",
		};
	}

	// Resolve the override list against the live registry (same gate as the
	// configured pool: missing API key or absent model → dropped with surface
	// feedback in the notify).
	const available = await ctx.modelRegistry.getAvailable();
	const availableKeys = new Set(available.map((m) => `${m.provider}/${m.id}`));
	const resolved: { spec: ModelSpec; model: Model }[] = [];
	const missingPool: ModelSpec[] = [];
	for (const spec of effectiveReviewerSpecs) {
		if (!availableKeys.has(spec)) { missingPool.push(spec); continue; }
		const model = findModel(ctx, spec)!;
		resolved.push({ spec, model });
	}
	if (resolved.length === 0) {
		return {
			kind: "notify",
			notifyMessage:
				`multi-review: none of the ${transientReviewers ? "transient" : "configured"} reviewers resolved.\n` +
				describeResolved([], effectiveReviewerSpecs) +
				`\nArgs: ${rawArgs.trim() || "(none)"}`,
			notifyLevel: "error",
		};
	}
	const judge = resolveJudge(ctx, cfg);

	if (!judge) {
		return {
			kind: "notify",
			notifyMessage:
				`multi-review: judge model missing in registry: ${cfg.judge}\n` +
				`Add it to ~/.pi/agent/models.json (or /login) and /reload.\n` +
				`\nArgs: ${rawArgs.trim() || "(none)"}`,
			notifyLevel: "error",
		};
	}

	const parsed = parseReviewArgs(rawArgs);
	setStatus(`multi-review · resolving scope…`, ctx);
	const target = await buildReviewTarget(pi, parsed, ctx.cwd);
	const userPrompt = buildReviewUserPrompt(target);

	setStatus(`multi-review · fanning out to ${resolved.length} reviewers (cap ${cfg.concurrency})`, ctx);
	const completedRunResults = await runAllReviewers(
		resolved,
		REVIEWER_SYSTEM_PROMPT,
		userPrompt,
		cfg.concurrency,
		cfg.temperature,
		signal,
		ctx,
	);
	setStatus(`multi-review · dedupe pass`, ctx);

	const groups = dedupeReviewerFindings(completedRunResults);
	setStatus(`multi-review · ${groups.length} groups · invoking judge ${cfg.judge}`, ctx);

	const failedSpecs = completedRunResults.filter((r) => !r.ok).map((r) => r.spec);
	const judgeResult = await runJudge(judge, groups, target, failedSpecs, ctx, signal, cfg.temperature);
	setStatus(`multi-review · done`, ctx);

	const details: MultiReviewDetails = {
		target,
		groups,
		reviewerSpecs: completedRunResults.map((r) => r.spec),
		failedSpecs,
		judge: cfg.judge,
		judgeDurationMs: judgeResult.durationMs,
		judgeUsage: judgeResult.usage,
		consensusCount: groups.filter((g) => g.consensus).length,
		totalFindings: groups.reduce((s, g) => s + g.members.length, 0),
	};

	return {
		kind: "inject",
		notifyMessage:
			`multi-review · done — review injected into chat\n` +
			`scope: ${target.label}   files: ${target.files.length}   diff bytes: ${target.diffText.length}\n` +
			`judge: ${cfg.judge}   (${(judgeResult.durationMs / 1000).toFixed(1)}s${judgeResult.usage ? `, $${judgeResult.usage.cost.toFixed(4)}` : ""})\n` +
			`reviewers: ${completedRunResults.length}   dedupe groups: ${groups.length}   consensus: ${details.consensusCount}\n` +
			`Press Ctrl+O on the chat entry to expand per-model attribution + full judge markdown.`,
		notifyLevel: "info",
		injectMessage: {
			customType: "multi-review",
			content: judgeResult.markdown,
			details,
		},
	};
	// Single-shot override clears after consumption.
	if (transientReviewers === TRANSIENT_REVIEWERS) TRANSIENT_REVIEWERS = null;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const cfg = loadConfig();
		setStatus(`multi-review · ${describePool(cfg)}`, ctx);
		ctx.ui.notify(`multi-review loaded · ${describePool(cfg)}`, "info");
	});

	pi.registerMessageRenderer("multi-review", renderMultiReviewMessage as unknown as Parameters<ExtensionAPI["registerMessageRenderer"]>[1]);

	/**
	 * Run the full pipeline OR fall back to the picker when the pool is empty
	 * AND UI is available. Centralized so both `/multi-review` and the tool
	 * benefit from the same fallback behavior.
	 */
	async function runWithOptionalPicker(args: string, ctx: ExtensionContext): Promise<void> {
		const cfg = loadConfig();
		if (cfg.reviewers.length === 0 && ctx.hasUI) {
			const available = await ctx.modelRegistry.getAvailable();
			if (available.length > 0) {
				const open = await ctx.ui.confirm(
					"No reviewers configured — pick now?",
					"multi-review.json has no 'reviewers' array. Open the picker so you can select models from your registry? (cancellable; existing file is preserved except for the 'reviewers' key on save.)",
				);
				if (open) {
					ctx.ui.notify("multi-review: opening reviewer picker…", "info");
					const picked = await pickReviewersViaTUI(ctx, available, []);
					if (!picked || picked.length === 0) {
						ctx.ui.notify("multi-review: picker cancelled; nothing to do.", "warning");
						return;
					}
					const persist = await ctx.ui.confirm(
						"Save reviewers to multi-review.json?",
						`Persist ${picked.length} reviewer${picked.length === 1 ? "" : "s"} to ~/.pi/agent/multi-review.json so future /multi-review invocations use this pool without the picker? ` +
							`(Pick "no" to use the selection for THIS run only without persisting.)`,
					);
					if (persist) {
						const result = persistReviewerChoices(picked);
						if (result.ok) {
							ctx.ui.notify(`multi-review · saved ${picked.length} reviewers to ${result.path}`, "success");
							cacheConfigForFreshRead();
						} else {
							ctx.ui.notify(`multi-review · could not save (${result.error}); proceeding for this run only`, "warning");
							TRANSIENT_REVIEWERS = picked;
						}
					} else {
						ctx.ui.notify("multi-review · using picked pool for this run only (not persisted)", "info");
						TRANSIENT_REVIEWERS = picked;
					}
				}
			}
		}
		const result = await runMultiReviewFromArgs(pi, ctx, args, undefined);
		ctx.ui.notify(result.notifyMessage, result.notifyLevel);
		if (result.injectMessage) {
			pi.sendMessage({ ...result.injectMessage, display: true });
		}
	}

	// Slash command — surface-level UI entry point.
	pi.registerCommand("multi-review", {
		description:
			"Fan-out code review across configured models. Usage: " +
			"/multi-review [PR-number | free-text focus].",
		// Argument autocomplete hints the call shape so users don't have to
		// remember to type '#' vs raw digits.
		getArgumentCompletions: (_prefix): Array<{ value: string; label: string; description?: string }> | null => [
			{ value: "", label: "(default)", description: "review current cwd's diff vs main/master" },
			{ value: "#1234", label: "#1234", description: "review PR #1234" },
			{ value: "https://github.com/owner/repo/pull/1234", label: "PR URL", description: "extract number from URL" },
			{ value: "focus: ", label: "focus: <text>", description: "free-text focus hint, no PR" },
		],
		handler: async (args, ctx) => {
			// Slash commands fire outside active turns, so ctx.signal is
			// undefined; we pass undefined and accept that the user can't
			// hard-cancel mid-fan-out from here. The tool surface (next
			// sibling) does pass signal — ctrl+c in tool context works.
			await runWithOptionalPicker(args, ctx);
		},
	});

	// Slash command — picker entry point. Opens the multi-select TUI
	// directly without running the rest of the pipeline. Useful for
	// configuring the pool in advance without dragging scope into it.
	pi.registerCommand("multi-review-pick", {
		description:
			"Open the multi-select picker for reviewer models. " +
			"Saves selection to ~/.pi/agent/multi-review.json on confirm.",
		handler: async (_args, ctx) => {
			const available = await ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify(
					"multi-review-pick: no models in registry. Add them to ~/.pi/agent/models.json or /login first.",
					"error",
				);
				return;
			}
			const cfg = loadConfig();
			const picked = await pickReviewersViaTUI(ctx, available, cfg.reviewers);
			if (!picked || picked.length === 0) {
				ctx.ui.notify("multi-review-pick: cancelled.", "info");
				return;
			}
			const persist = await ctx.ui.confirm(
				"Save reviewers to multi-review.json?",
				`Persist ${picked.length} reviewer${picked.length === 1 ? "" : "s"} to ~/.pi/agent/multi-review.json? ` +
					`${
						cfg.judge
							? `(existing judge ${cfg.judge} will be preserved)`
							: `(existing judge ${DEFAULTS.judge} will be set as the default if missing)`
					}`,
			);
			if (!persist) {
				ctx.ui.notify("multi-review-pick: cancelled at persist step.", "info");
				return;
			}
			const result = persistReviewerChoices(picked);
			if (result.ok) {
				ctx.ui.notify(`multi-review-pick · saved ${picked.length} reviewers to ${result.path}`, "success");
				cacheConfigForFreshRead();
			} else {
				ctx.ui.notify(`multi-review-pick · save failed: ${result.error}`, "error");
			}
		},
	});

	// LLM-callable tool — agent-driven UI entry point.
	pi.registerTool({
		name: "multi_review",
		label: "Multi-Model Code Review",
		description:
			"Fan-out a code review to N configured reviewer models in parallel and have a judge " +
			"synthesize the findings. Use when the user asks for a review, asks to double-check " +
			"edits, or asks for a second opinion across models. Result lands in chat as a " +
			"collapsible entry with per-model attribution. Same shape as `/multi-review`.",
		promptSnippet:
			"Run a multi-model code review on the current scope (PR, default-branch diff, or focus text).",
		promptGuidelines: [
			"Use multi_review when the user asks for a code review, wants another set of eyes, or asks for a security/perf/correctness check by name.",
			"Pass either pr_number (numeric, no '#') or focus (free-text). Both can be combined.",
			"Do NOT use multi_review to read or summarize a single file — use the read tool for that.",
			"Do NOT use multi_review to write or edit code — it's read-only and returns findings attributed to each model.",
		],
		parameters: Type.Object({
			pr_number: Type.Optional(Type.Number({
				description: "PR number to review (e.g. 4321 from a GitHub PR URL).",
				minimum: 0,
			})),
			focus: Type.Optional(Type.String({
				description:
					"Free-text hint about what to focus on. Examples: 'the auth/ subdirectory', " +
					"'error handling in the diff', 'concurrency in the new code'.",
				maxLength: 2000,
			})),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const parts: string[] = [];
			if (typeof params.pr_number === "number") parts.push(String(params.pr_number));
			if (typeof params.focus === "string" && params.focus.trim()) parts.push(params.focus.trim());
			const result = await runMultiReviewFromArgs(pi, ctx, parts.join(" "), signal);
			ctx.ui.notify(result.notifyMessage, result.notifyLevel);
			if (!result.injectMessage) {
				return {
					content: [{ type: "text", text: result.notifyMessage }],
					details: { ok: false, notifyLevel: result.notifyLevel },
				};
			}
			// Inject the synthesized review as a session message so the chat
			// transcript is the canonical record (not just a tool result entry).
			pi.sendMessage({ ...result.injectMessage, display: true });
			const summary = `Multi-model review injected: ${result.injectMessage.details.groups.length} groups, ` +
				`${result.injectMessage.details.consensusCount} consensus. ` +
				`See chat for per-model attribution.`;
			return {
				content: [{ type: "text", text: summary }],
				details: { ok: true, ...result.injectMessage.details },
			};
		},
	});
}
