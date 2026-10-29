import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { abortable } from "./util.ts";

const OUTPUT_CAPTURE_CHARS = 2_000_000;

export interface CommandResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
	durationMs: number;
	/** Set when the command couldn't start or was aborted. */
	error?: string;
}

/** Head for context, tail for the errors (build and test output ends with them). */
export function clipOutput(text: string, head: number, tail: number): string {
	if (text.length <= head + tail) return text;
	return `${text.slice(0, head)}\n…(${text.length - head - tail} chars omitted)…\n${text.slice(-tail)}`;
}

/** Spawn with merged stdout/stderr, a hard timeout, and abort; `kill` replaces the default SIGKILL. */
export function runCommand(
	cmd: string,
	args: string[],
	opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; kill?: (child: ReturnType<typeof spawn>) => void },
): Promise<CommandResult> {
	const started = Date.now();
	return new Promise((resolve) => {
		let out = "";
		let timedOut = false;
		let error: string | undefined;
		let settled = false;
		let killed = false;
		const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
		const collect = (chunk: Buffer) => {
			out += chunk.toString("utf8");
			if (out.length > OUTPUT_CAPTURE_CHARS) out = out.slice(0, 4_000) + "\n…(output too large, middle dropped)…\n" + out.slice(-OUTPUT_CAPTURE_CHARS / 2);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const kill = (why: "timeout" | "abort") => {
			if (settled || killed) return;
			killed = true;
			if (why === "timeout") timedOut = true;
			else error = "aborted";
			if (opts.kill) opts.kill(child);
			else child.kill("SIGKILL");
		};
		const timer = setTimeout(() => kill("timeout"), opts.timeoutMs);
		const onAbort = () => kill("abort");
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts.signal?.aborted) onAbort();
		const done = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({ exitCode, output: out, timedOut, durationMs: Date.now() - started, error });
		};
		child.on("error", (err) => {
			error = err.message;
			done(null);
		});
		child.on("close", (code) => done(code));
	});
}

export function formatCommandResult(r: CommandResult, head = 2_000, tail = 10_000): string {
	const status = r.timedOut
		? `timed out after ${Math.round(r.durationMs / 1000)}s`
		: r.error
			? `failed to run: ${r.error}`
			: `exit ${r.exitCode} (${(r.durationMs / 1000).toFixed(1)}s)`;
	const body = r.output.trim() ? clipOutput(r.output, head, tail) : "(no output)";
	return `${status}\n${body}`;
}

export const SANDBOX_STATE_DIR = path.join(os.homedir(), ".cache", "multi-review");
/** Helper scripts shipped with the extension (mr-cxx-check), on PATH inside the sandbox. */
const SANDBOX_TOOLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools");
/** Analysis tools from tools/install-cxx-analysis (clang-tidy, lizard, clangd), readable and on PATH in the sandbox. */
export const ANALYSIS_TOOLS_HOME = process.env.MR_TOOLS_HOME ?? path.join(os.homedir(), ".local", "share", "multi-review");
const ANALYSIS_TOOLS_PATH = [path.join(ANALYSIS_TOOLS_HOME, "venv", "bin")];
/** Host directories every toolchain needs, readable in the sandbox. */
const SANDBOX_HOST_DIRS = ["/usr", "/etc", "/opt", "/snap", "/nix"];
/**
 * nono's built-in groups grant read access to system files; drop the one that
 * makes /tmp writable, where PR worktrees and other runs' traces live.
 */
const NONO_PROFILE = { meta: { name: "multi-review-sandbox" }, groups: { exclude: ["system_write_linux"] } };

/** Per-run additions to the sandbox: extra read-only and writable paths, and environment. */
export interface SandboxExtras {
	readPaths?: string[];
	writePaths?: string[];
	env?: Record<string, string>;
}

export function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function gitRoots(dir: string): { top: string; commonDir?: string } {
	const r = spawnSync("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], { cwd: dir, encoding: "utf8", timeout: 5_000 });
	if (r.status !== 0) return { top: dir };
	const [top, common] = r.stdout.trim().split("\n");
	return { top: top || dir, commonDir: common ? path.resolve(dir, common) : undefined };
}

function nonoBinary(): string {
	const local = path.join(os.homedir(), ".local", "bin", "nono");
	const onPath = (process.env.PATH ?? "").split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, "nono")));
	return !onPath && fs.existsSync(local) ? local : "nono";
}

/**
 * nono gives each run its own cgroup when resource limits are set; killing
 * it takes every process in the run, including ones that setsid'd away.
 */
function killNonoCgroup(pid: number | undefined): void {
	if (pid === undefined || typeof process.getuid !== "function") return;
	const uid = process.getuid();
	const cg = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/nono.${pid}`;
	try {
		fs.writeFileSync(path.join(cg, "cgroup.kill"), "1");
		setTimeout(() => fs.rmdir(cg, () => {}), 1_000).unref?.();
	} catch {
		/* already gone */
	}
}

/**
 * The nono command line that runs `argv` in the sandbox, plus the scratch
 * directory it may write (callers delete it). Shared by one-shot scripts
 * and long-lived sandboxed processes such as clangd.
 */
export function sandboxInvocation(
	dir: string,
	argv: string[],
	homeDirs: string[],
	extras: SandboxExtras = {},
): { bin: string; args: string[]; env: NodeJS.ProcessEnv; scratch: string } {
	fs.mkdirSync(SANDBOX_STATE_DIR, { recursive: true });
	const profile = path.join(SANDBOX_STATE_DIR, "nono-profile.json");
	fs.writeFileSync(profile, JSON.stringify(NONO_PROFILE));
	// Not under /tmp: it is often noexec, and a compiled repro must run.
	const scratch = fs.mkdtempSync(path.join(SANDBOX_STATE_DIR, "scratch-"));
	const home = os.homedir();
	const { top, commonDir } = gitRoots(dir);
	const args = [
		"-s", "run", "--no-audit", "--no-rollback", "--no-diagnostics", "-p", profile,
		"--block-net", "--memory", "8G", "--max-processes", "4096",
		"--allow", scratch, "--allow-file", "/dev/null", "--read", top, "--workdir", dir,
	];
	for (const w of extras.writePaths ?? []) args.push("--allow", w);
	const read = [...SANDBOX_HOST_DIRS, ...homeDirs.map((rel) => path.join(home, rel)), SANDBOX_TOOLS_DIR, ANALYSIS_TOOLS_HOME, ...(extras.readPaths ?? [])];
	// Worktrees (PR checkouts) keep their git objects in the main repo.
	if (commonDir && !isInside(commonDir, top)) read.push(commonDir);
	for (const p of read) {
		const st = fs.statSync(p, { throwIfNoEntry: false });
		if (st) args.push(st.isDirectory() ? "--read" : "--read-file", p);
	}
	const env: Record<string, string> = {
		PATH: [SANDBOX_TOOLS_DIR, ...ANALYSIS_TOOLS_PATH, process.env.PATH ?? "/usr/bin:/bin"].join(":"),
		HOME: scratch,
		LANG: process.env.LANG ?? "C.UTF-8",
		TERM: "dumb",
		CI: "1",
		TMPDIR: scratch,
		XDG_CACHE_HOME: path.join(scratch, ".cache"),
		npm_config_cache: path.join(scratch, ".npm"),
		...extras.env,
	};
	// nono itself needs the real HOME (its state lives there); the command gets only `env`.
	args.push("--", "/usr/bin/env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...argv);
	return { bin: nonoBinary(), args, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: env.LANG }, scratch };
}

/** SIGTERM lets nono tear its cgroup down; the cgroup kill is the backstop. */
export function stopSandboxed(child: ReturnType<typeof spawn>): void {
	child.kill("SIGTERM");
	setTimeout(() => {
		child.kill("SIGKILL");
		killNonoCgroup(child.pid);
	}, 3_000).unref?.();
}

/**
 * Run a bash script against the code under review under nono (Landlock):
 * the repo and the host toolchain are read-only, TCP is blocked, the rest of
 * $HOME is unreadable (so credentials there stay out of reach of whatever the
 * script prints back to a model), and the only writable place is a scratch
 * directory that serves as HOME and TMPDIR and is deleted afterwards. DNS
 * lookups are not blocked: Landlock filters TCP only.
 */
export async function runInSandbox(
	dir: string,
	script: string,
	timeoutMs: number,
	homeDirs: string[],
	signal?: AbortSignal,
	extras: SandboxExtras = {},
): Promise<CommandResult> {
	const inv = sandboxInvocation(dir, ["/usr/bin/bash", "-c", script], homeDirs, extras);
	try {
		return await runCommand(inv.bin, inv.args, { cwd: dir, timeoutMs, signal, env: inv.env, kill: stopSandboxed });
	} finally {
		fs.rmSync(inv.scratch, { recursive: true, force: true });
	}
}

let sandboxProbe: Promise<string | null> | undefined;

/** Null when the sandbox works on this machine, else why not. Probed once per process. */
export function sandboxUnavailable(signal?: AbortSignal): Promise<string | null> {
	sandboxProbe ??= (async () => {
		fs.mkdirSync(SANDBOX_STATE_DIR, { recursive: true });
		const dir = fs.mkdtempSync(path.join(SANDBOX_STATE_DIR, "probe-"));
		try {
			const r = await runInSandbox(dir, `(echo x > f) 2>/dev/null && echo WROTE; echo probe > "$TMPDIR/p" && cat "$TMPDIR/p"`, 20_000, []);
			if (r.exitCode === 0 && r.output.includes("probe") && !r.output.includes("WROTE")) return null;
			if (r.error?.includes("ENOENT")) return "nono is not installed (https://nono.sh)";
			return `nono sandbox probe failed: ${(r.error ?? r.output.trim()).slice(0, 200) || `exit ${r.exitCode}`}`;
		} catch (err) {
			return `nono sandbox unavailable: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	})();
	// A cancelled run stops waiting; the probe itself finishes and stays cached.
	return abortable(sandboxProbe, signal, () => "aborted");
}
