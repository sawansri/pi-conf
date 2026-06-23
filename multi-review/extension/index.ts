/**
 * Multi-Review — fan-out code reviewer (DESIGN: ../README.md)
 *
 * Commands registered:
 *   /multi-review [PR-number | free-text focus]
 *
 * Persistent defaults: reads $PI_CODING_AGENT_DIR/multi-review.json once on
 * first access. Unknown fields, bad JSON, or missing file all fall back to
 * in-code defaults silently.
 *
 * Status + display: session_start notifies with the resolved reviewer pool
 * size; the same info appears as a footer status. Each command run pushes
 * live status ('resolving scope…' → 'target=…' → etc) so Ctrl+C is visible.
 *
 * Status of this commit: scope resolution lands here (PR via gh+git fallback,
 * default-branch diff, free-text). Parallel fan-out + structured prompt,
 * dedupe, judge pass, and chat-render still land in subsequent commits.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExecResult } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

/** Provider/model-id pair as written in the defaults file and the picker. */
export type ModelSpec = `${string}/${string}`;

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

	// `find` is fine here even on macOS / git-bash / WSL. We deliberately
	// exclude heavy dirs so the listing isn't useless: node_modules, .git,
	// build outputs, lockfiles. A future polish commit can read the
	// gitignore instead.
	const find = await exec(pi, "find", [
		cwd,
		"-type", "f",
		"-not", "-path", "*/.git/*",
		"-not", "-path", "*/node_modules/*",
		"-not", "-path", "*/dist/*",
		"-not", "-path", "*/build/*",
		"-not", "-path", "*/.next/*",
		"-not", "-path", "*/target/*",
		"-not", "-name", "*.lock",
		"-not", "-name", "package-lock.json",
	], cwd, 15_000);
	if (find.code === 0) {
		const paths = find.stdout.split("\n").filter(Boolean).map((p) => p.startsWith(cwd) ? p.slice(cwd.length + 1) : p);
		target.files = paths.slice(0, 200).map((p) => ({ path: p, lines: 0 }));
		target.metaLines.push(`directory listing: ${paths.length} file${paths.length === 1 ? "" : "s"} (capped at 200)`);
	} else {
		target.warnings.push(`find failed (exit ${find.code}); reviewers will only see your text hint`);
	}
	return target;
}

export async function buildReviewTarget(pi: ExtensionAPI, parsed: ParsedReviewArgs, cwd: string): Promise<ReviewTarget> {
	if (parsed.kind === "pr") return buildPrTarget(pi, parsed, cwd);
	if (parsed.kind === "default") return buildDefaultTarget(pi, cwd);
	return buildTextTarget(pi, cwd, parsed.value);
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

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const cfg = loadConfig();
		setStatus(`multi-review · ${describePool(cfg)}`, ctx);
		ctx.ui.notify(`multi-review loaded · ${describePool(cfg)}`, "info");
	});

	pi.registerCommand("multi-review", {
		description:
			"Fan-out code review across configured models. Usage: " +
			"/multi-review [PR-number | free-text focus]. " +
			"Subsequent commits wire in fan-out, dedupe, judge, render.",
		handler: async (args, ctx) => {
			const cfg = loadConfig();
			const judge = resolveJudge(ctx, cfg);
			setStatus(
				`multi-review · ${cfg.reviewers.length} cfg / ${judge ? "judge=ok" : "judge=MISSING"}`,
				ctx,
			);

			if (cfg.reviewers.length === 0) {
				ctx.ui.notify(
					"multi-review: no reviewers configured.\n\n" +
						`Drop a "$PI_CODING_AGENT_DIR/multi-review.json" like:\n` +
						`  { "reviewers": ["fireworks/.../model-a", "fireworks/.../model-b"], "judge": "fireworks/.../judge" }\n` +
						`Then /reload.\n\nArgs: ${args.trim() || "(none)"}`,
					"warning",
				);
				return;
			}

			const pool = await resolveReviewerPool(ctx, cfg);
			if (!pool) {
				ctx.ui.notify(
					`multi-review: none of the configured reviewers resolved.\n` +
						describeResolved([], cfg.reviewers) +
						`\nArgs: ${args.trim() || "(none)"}`,
					"error",
				);
				return;
			}
			if (!judge) {
				ctx.ui.notify(
					`multi-review: judge model missing in registry: ${cfg.judge}\n` +
						`Add it to ~/.pi/agent/models.json (or /login) and /reload.\n` +
						`Args: ${args.trim() || "(none)"}`,
					"error",
				);
				return;
			}

			const parsed = parseReviewArgs(args);
			setStatus(`multi-review · resolving scope…`, ctx);
			const target = await buildReviewTarget(pi, parsed, ctx.cwd);
			setStatus(`multi-review · target=${target.label}`, ctx);

			// Build the shared reviewer-side prompt once.
			const userPrompt = buildReviewUserPrompt(target);

			// Progress notifies the user; final summarize wrapped here until
			// dedupe + judge land in subsequent commits.
			setStatus(`multi-review · fanning out to ${pool.resolved.length} reviewers (cap ${cfg.concurrency})`, ctx);
			const completedRunResults = await runAllReviewers(
				pool.resolved,
				REVIEWER_SYSTEM_PROMPT,
				userPrompt,
				cfg.concurrency,
				cfg.temperature,
				undefined, // command context — wire signal in the polish commit
				ctx,
			);
			setStatus(`multi-review · dedupe pass`, ctx);

			const groups = dedupeReviewerFindings(completedRunResults);
			setStatus(`multi-review · ${groups.length} groups · invoking judge ${cfg.judge}`, ctx);

			const failedSpecs = completedRunResults.filter((r) => !r.ok).map((r) => r.spec);
			const judgeResult = await runJudge(judge!, groups, target, failedSpecs, ctx, undefined, cfg.temperature);
			setStatus(`multi-review · judge finished (${(judgeResult.durationMs / 1000).toFixed(1)}s)`, ctx);

			const lines: string[] = [
				`multi-review · fan-out + dedupe + judge finished`,
				`scope: ${target.label}   files: ${target.files.length}   diff bytes: ${target.diffText.length}`,
				`judge: ${cfg.judge}   (${(judgeResult.durationMs / 1000).toFixed(1)}s${judgeResult.usage ? `, $${judgeResult.usage.cost.toFixed(4)}` : ""})`,
				``,
				`per-reviewer:`,
			];
			for (const r of completedRunResults) {
				const icon = r.ok ? (r.findings.length > 0 ? "✓" : "·") : "✗";
				const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
				const usage = r.usage ? ` ↑${r.usage.input} ↓${r.usage.output} $${r.usage.cost.toFixed(4)}` : "";
				lines.push(`  ${icon} ${r.spec}  findings=${r.findings.length}  ${dur}${usage}`);
				if (!r.ok && r.errorMessage) lines.push(`      error: ${r.errorMessage.slice(0, 240)}`);
			}
			lines.push(`  → ${groups.length} deduped groups; consensus on ${groups.filter((g) => g.consensus).length}`);

			// Show the first chunk of judge markdown inline (notify caps at a few KB anyway).
			const previewChars = 4000;
			const judgePreview = judgeResult.markdown.length > previewChars
				? judgeResult.markdown.slice(0, previewChars) + "\n…(truncated for notify; full text lands in commit 7 render)"
				: judgeResult.markdown;
			lines.push(``, `--- judge output ---`, judgePreview);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
