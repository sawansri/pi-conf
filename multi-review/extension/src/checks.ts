import * as fs from "node:fs";
import * as path from "node:path";
import { type CommandResult, SANDBOX_STATE_DIR, type SandboxExtras, clipOutput, gitRoots, runInSandbox } from "./sandbox.ts";
import type { ReviewTarget } from "./target.ts";

export interface CheckResult extends CommandResult {
	command: string;
	/** Set when the check never ran (budget spent, sandbox missing). */
	skipped?: string;
}

/**
 * Run the brief's checks once, all at the same time, inside `budgetMs`, so
 * every reviewer and verifier reads the same build/type-check/test output
 * instead of guessing whether the change compiles. Each runs in its own
 * sandbox with its own scratch directory; results keep the checks' order.
 */
export async function runChecks(
	dir: string,
	checks: string[],
	budgetMs: number,
	homeDirs: string[],
	extras: SandboxExtras,
	signal: AbortSignal | undefined,
	onStart: (command: string) => void,
): Promise<CheckResult[]> {
	if (budgetMs < 5_000 || signal?.aborted) {
		return checks.map((command) => ({ command, exitCode: null, output: "", timedOut: false, durationMs: 0, skipped: "check time budget spent" }));
	}
	onStart(checks.length === 1 ? checks[0] : `${checks.length} checks in parallel`);
	return Promise.all(checks.map(async (command) => ({ command, ...(await runInSandbox(dir, command, budgetMs, homeDirs, signal, extras)) })));
}

export const CXX_FILE = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp)$/i;

/** compile_commands.json under `root`, where CMake and friends usually put it. */
export function findCompileDb(root: string): string | undefined {
	const candidates = [path.join(root, "compile_commands.json")];
	try {
		for (const d of fs.readdirSync(root).filter((n) => n.startsWith("build")).sort()) {
			candidates.push(path.join(root, d, "compile_commands.json"));
			try {
				for (const sub of fs.readdirSync(path.join(root, d)).sort()) candidates.push(path.join(root, d, sub, "compile_commands.json"));
			} catch { /* not a directory */ }
		}
		for (const sub of fs.readdirSync(path.join(root, "out")).sort()) candidates.push(path.join(root, "out", sub, "compile_commands.json"));
	} catch { /* no out/ */ }
	return candidates.find((c) => fs.existsSync(c));
}

function shellQuote(s: string): string {
	return /^[\w./+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The built-in C/C++ check: mr-cxx-check on the changed files that still
 * exist. A PR worktree has no build directory, so it borrows the main
 * checkout's compile database (readable in the sandbox) with paths remapped.
 */
export function cxxAutoCheck(
	files: string[],
	reviewDir: string,
	localDir: string,
	warnings: string[],
	diffText = "",
): { command: string; extras: SandboxExtras } | undefined {
	const reviewTop = gitRoots(reviewDir).top;
	const cxx = files.filter((f) => CXX_FILE.test(f) && fs.existsSync(path.join(reviewTop, f)));
	if (cxx.length === 0) return undefined;
	const command = `cd ${shellQuote(reviewTop)} && mr-cxx-check ${cxx.slice(0, 40).map(shellQuote).join(" ")}`;
	// The review's own diff decides which lines count as changed, for this
	// check and for verifiers who rerun it (MR_CXX_DIFF).
	const diffExtras: SandboxExtras = diffText ? { readPaths: [writeDiffFile(diffText)] } : {};
	if (diffExtras.readPaths) diffExtras.env = { MR_CXX_DIFF: diffExtras.readPaths[0] };
	if (findCompileDb(reviewTop)) return { command, extras: diffExtras };
	const localTop = gitRoots(localDir).top;
	const db = localTop !== reviewTop ? findCompileDb(localTop) : undefined;
	if (db) {
		return {
			command,
			extras: {
				readPaths: [path.dirname(db), ...(diffExtras.readPaths ?? [])],
				env: { MR_CXX_DB: db, MR_CXX_REMAP: `${localTop}=${reviewTop}`, ...diffExtras.env },
			},
		};
	}
	warnings.push("C/C++ files changed but no compile_commands.json was found, so they weren't compile-checked (configure with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON)");
	return undefined;
}

/** The diff as a file the sandbox can read; files from runs over a day old are pruned. */
function writeDiffFile(diffText: string): string {
	const dir = path.join(SANDBOX_STATE_DIR, "diffs");
	fs.mkdirSync(dir, { recursive: true });
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		if (Date.now() - fs.statSync(p).mtimeMs > 86_400_000) fs.rmSync(p, { force: true });
	}
	const file = path.join(dir, `${process.pid}-${Date.now()}.diff`);
	fs.writeFileSync(file, diffText);
	return file;
}

function checkStatus(r: CheckResult): string {
	if (r.skipped) return `not run (${r.skipped})`;
	if (r.timedOut) return `timed out after ${Math.round(r.durationMs / 1000)}s`;
	if (r.error) return `failed to run: ${r.error}`;
	return `${r.exitCode === 0 ? "passed" : `FAILED (exit ${r.exitCode})`}, ${(r.durationMs / 1000).toFixed(1)}s`;
}

/** Check output for reviewers: failures in full-ish, passes as a short tail. */
export function checkPromptLines(results: CheckResult[]): string[] {
	const lines = ["## Check results", "The lead's commands, run on the code under review in a sandbox before this review. Treat failures as evidence; don't re-report a failure as a finding unless the change causes it."];
	for (const r of results) {
		lines.push(`### \`${r.command}\` — ${checkStatus(r)}`);
		if (r.skipped) continue;
		const ok = r.exitCode === 0 && !r.timedOut && !r.error;
		lines.push("```", r.output.trim() ? clipOutput(r.output.trim(), ok ? 0 : 1_500, ok ? 1_500 : 6_000) : "(no output)", "```");
	}
	lines.push("");
	return lines;
}

/** Check summary for the lead's result view. */
export function checkLines(target: ReviewTarget): string[] {
	const results = target.checkResults ?? [];
	if (results.length === 0) return [];
	const lines = ["## Checks (run before the review)"];
	for (const r of results) {
		lines.push(`- \`${r.command}\` — ${checkStatus(r)}`);
		const ok = r.exitCode === 0 && !r.timedOut && !r.error;
		if (!ok && !r.skipped && r.output.trim()) lines.push("  ```", ...clipOutput(r.output.trim(), 0, 3_000).split("\n").map((l) => `  ${l}`), "  ```");
	}
	lines.push("");
	return lines;
}
