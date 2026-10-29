import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExecResult } from "@mariozechner/pi-coding-agent";
import type { ParsedReviewArgs } from "./args.ts";
import type { ReviewBrief } from "./brief.ts";
import type { CheckResult } from "./checks.ts";
import { discoverSourceFiles } from "./discover.ts";

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
	/** Reviewer brief, usually drafted by the main agent. Empty for bare runs. */
	brief?: ReviewBrief;
	/** PR identity for PR targets (from `gh pr view`). */
	pr?: { number: number; url: string; owner: string; repo: string; headSha: string };
	/** Where reviewers' tools read files: the PR-head worktree when one was needed. */
	reviewDir?: string;
	/** Outcomes of the brief's checks, run before the fan-out. */
	checkResults?: CheckResult[];
}

export async function exec(pi: ExtensionAPI, command: string, args: string[], cwd: string, timeoutMs = 30_000): Promise<ExecResult> {
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
async function buildPrTarget(pi: ExtensionAPI, parsed: { number: number; raw: string }, cwd: string): Promise<ReviewTarget> {
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
	// No `-q`: a jq projection prints raw strings, which JSON.parse can't read.
	const ghView = await exec(pi, "gh", ["pr", "view", String(parsed.number), "--json",
		"title,body,baseRefName,headRefName,url,headRefOid"
	], cwd, 15_000);
	if (ghView.code === 0 && ghView.stdout.trim()) {
		try {
			const view = JSON.parse(ghView.stdout);
			const repoMatch = typeof view.url === "string" ? view.url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/) : null;
			if (repoMatch && view.headRefOid) {
				target.pr = { number: parsed.number, url: view.url, owner: repoMatch[1], repo: repoMatch[2], headSha: view.headRefOid };
			}
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
	// The PR's changes are base...head. Prefer the remote default branch as the
	// base; HEAD is only a last resort (it's whatever the user has checked out).
	let base = "HEAD";
	const originHead = await exec(pi, "git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd, 5_000);
	if (originHead.code === 0 && originHead.stdout.trim()) base = originHead.stdout.trim();
	const diff = await exec(pi, "git", ["diff", `${base}...${refName}`], cwd, 30_000);
	if (diff.code !== 0) {
		target.warnings.push(`git diff ${base}...${refName} failed (exit ${diff.code}, stderr: ${diff.stderr.slice(0, 200)})`);
		return target;
	}
	target.diffText = diff.stdout;
	target.metaLines.push(`(fallback: fetched origin/pull/${parsed.number}/head as ${refName}; diff ${base}...${refName})`);
	target.files = summarizeDiff(diff.stdout).files;
	return target;
}

/**
 * Give reviewers the PR's actual code. The local checkout is reused when it
 * IS the PR head (HEAD == headSha, no tracked modifications) — the usual
 * case after pushing your own branch. Otherwise a detached worktree at the
 * head commit is created (fetching pull/N/head if needed) and removed by
 * `cleanup`. Never touches the user's checkout, branches, or stash. On any
 * failure, falls back to cwd with a warning.
 */
export async function preparePrCheckout(
	pi: ExtensionAPI,
	cwd: string,
	pr: NonNullable<ReviewTarget["pr"]>,
): Promise<{ dir: string; note: string; warning?: string; cleanup: () => Promise<void> }> {
	const noop = async () => {};
	const top = await exec(pi, "git", ["rev-parse", "--show-toplevel"], cwd, 5_000);
	if (top.code !== 0) return { dir: cwd, note: "", warning: "not a git checkout; reviewers read local files, the diff is authoritative", cleanup: noop };
	const root = top.stdout.trim();
	const head = await exec(pi, "git", ["rev-parse", "HEAD"], root, 5_000);
	const dirty = await exec(pi, "git", ["status", "--porcelain", "--untracked-files=no"], root, 10_000);
	if (head.stdout.trim() === pr.headSha && dirty.code === 0 && !dirty.stdout.trim()) {
		return { dir: root, note: `reviewers read the local checkout (it is the PR head ${pr.headSha.slice(0, 7)})`, cleanup: noop };
	}
	const have = await exec(pi, "git", ["cat-file", "-e", `${pr.headSha}^{commit}`], root, 5_000);
	if (have.code !== 0) {
		const fetched = await exec(pi, "git", ["fetch", "--no-tags", `https://github.com/${pr.owner}/${pr.repo}.git`, `pull/${pr.number}/head`], root, 120_000);
		if (fetched.code !== 0) {
			return { dir: root, note: "", warning: `could not fetch PR head (${fetched.stderr.trim().slice(0, 120)}); reviewers read the local checkout, the diff is authoritative`, cleanup: noop };
		}
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `multi-review-pr${pr.number}-`));
	const added = await exec(pi, "git", ["worktree", "add", "--detach", dir, pr.headSha], root, 60_000);
	if (added.code !== 0) {
		fs.rmSync(dir, { recursive: true, force: true });
		return { dir: root, note: "", warning: `could not create PR worktree (${added.stderr.trim().slice(0, 120)}); reviewers read the local checkout`, cleanup: noop };
	}
	return {
		dir,
		note: `reviewers read a temporary worktree at PR head ${pr.headSha.slice(0, 7)} (your checkout differs)`,
		cleanup: async () => {
			await exec(pi, "git", ["worktree", "remove", "--force", dir], root, 30_000);
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
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
	const defaultBranches = ["main", "master", "develop"];
	const current = branch.stdout.trim();
	const upstreamRef = upstream.code === 0 ? upstream.stdout.trim() : "";
	// A feature branch tracking its own remote copy (origin/feature) is not a
	// base: diffing against it hides everything already pushed. Only trust
	// the upstream for default branches, where it means "not yet pushed".
	const upstreamIsOwnCopy = upstreamRef.split("/").slice(1).join("/") === current && !defaultBranches.includes(current);
	if (upstreamRef && !upstreamIsOwnCopy) baseCandidates.push(upstreamRef);
	for (const candidate of [...defaultBranches, "origin/main", "origin/master"]) {
		if (!baseCandidates.includes(candidate)) baseCandidates.push(candidate);
	}

	for (const base of baseCandidates) {
		const mergeBase = await exec(pi, "git", ["merge-base", base, "HEAD"], cwd, 5_000);
		if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) continue;
		// Diff the working tree (not HEAD) against the merge-base so committed,
		// staged, and unstaged changes are all in scope.
		const diff = await exec(pi, "git", ["diff", mergeBase.stdout.trim()], cwd, 30_000);
		if (diff.code === 0 && diff.stdout.trim()) {
			target.label = `cwd diff vs ${base} (incl. uncommitted)`;
			target.metaLines.push(`branch: ${branch.stdout.trim() || "(unknown)"}`);
			target.metaLines.push(`base: ${base}`);
			target.diffText = diff.stdout;
			target.files = summarizeDiff(diff.stdout).files;
			return target;
		}
	}

	// Step 2: last commit's diff (works in shallow/no-upstream setups).
	// `--stat` alone would replace the patch with a summary; `--patch` keeps both.
	const last = await exec(pi, "git", ["show", "--unified=3", "--stat", "--patch", "HEAD"], cwd, 15_000);
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
