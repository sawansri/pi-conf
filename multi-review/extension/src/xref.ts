import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { CXX_FILE, findCompileDb } from "./checks.ts";
import { ANALYSIS_TOOLS_HOME, gitRoots, isInside, sandboxInvocation, stopSandboxed } from "./sandbox.ts";

// ---------- xref: clangd code navigation for reviewers ----------

export const XREF_TOOL = "xref";
const XREF_QUERIES = ["definition", "references", "callers", "callees", "symbol"] as const;
const XREF_MAX_RESULTS = 60;
const CLANGD_BIN = path.join(ANALYSIS_TOOLS_HOME, "venv", "bin", "clangd");

/**
 * Where a repo's clangd index lives: a copy of its compile_commands.json in
 * a per-repo directory, because clangd's background index writes its shards
 * next to the compile database it reads. Keyed by basename + sha256(path).
 */
export function xrefIndexDir(top: string): string {
	const real = fs.realpathSync(top);
	const hash = createHash("sha256").update(real).digest("hex").slice(0, 12);
	return path.join(ANALYSIS_TOOLS_HOME, "clangd-index", `${path.basename(real)}-${hash}`);
}

interface LspLocation { uri: string; range: { start: { line: number; character: number } } }

/**
 * One sandboxed clangd per review, shared by every reviewer and verifier
 * session: precise definitions, references and call hierarchy. Its
 * background index persists between reviews (only changed files are
 * re-indexed; a cold start on lemonade took 35s), and the change's own
 * files are opened up front so what they add is visible even before then.
 */
export class XrefService {
	private child?: ReturnType<typeof spawn>;
	private scratch?: string;
	private nextId = 0;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private readonly opened = new Map<string, Promise<void>>();
	private readonly parsed = new Map<string, () => void>();
	private ready?: Promise<void>;
	private buffer = Buffer.alloc(0);
	private dead?: string;
	/** Background indexing progress from clangd's $/progress, while it runs. */
	private indexing?: { percentage?: number };
	private indexToken?: string | number;

	constructor(
		readonly top: string,
		/** Directory holding the compile database copy and the index shards. */
		private readonly indexDir: string,
		private readonly homeDirs: string[],
		/** Index paths (main checkout) → paths under `top` (PR worktree). */
		private readonly remap?: { from: string; to: string },
		private readonly readPaths: string[] = [],
		/** The change's own C/C++ files, opened up front so code they add is indexed now. */
		private readonly changedFiles: string[] = [],
	) {}

	/** Start clangd (and its background indexing) now; queries await this. */
	start(): Promise<void> {
		this.ready ??= (async () => {
			const argv = [
				CLANGD_BIN, `--compile-commands-dir=${this.indexDir}`, "--background-index", "--enable-config=false",
				// Index with half the machine: reviewers and checks run alongside.
				"--limit-references=1000", "--limit-results=200", "--log=error", `-j=${Math.max(4, Math.floor(os.cpus().length / 2))}`,
			];
			const inv = sandboxInvocation(this.top, argv, this.homeDirs, { readPaths: this.readPaths, writePaths: [this.indexDir] });
			this.scratch = inv.scratch;
			const child = spawn(inv.bin, inv.args, { cwd: this.top, env: inv.env, stdio: ["pipe", "pipe", "ignore"] });
			this.child = child;
			child.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
			child.on("exit", (code) => this.fail(`clangd exited (${code})`));
			child.on("error", (err) => this.fail(err.message));
			await this.request("initialize", { processId: null, rootUri: `file://${this.top}`, capabilities: { window: { workDoneProgress: true } } });
			this.notify("initialized", {});
			await Promise.all(this.changedFiles.slice(0, 20).map((f) => this.open(f)));
		})();
		return this.ready;
	}

	private fail(why: string): void {
		this.dead ??= why;
		for (const p of this.pending.values()) p.reject(new Error(why));
		this.pending.clear();
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const sep = this.buffer.indexOf("\r\n\r\n");
			if (sep < 0) return;
			const len = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, sep).toString())?.[1] ?? -1);
			if (len < 0 || this.buffer.length < sep + 4 + len) return;
			const msg = JSON.parse(this.buffer.subarray(sep + 4, sep + 4 + len).toString()) as {
				id?: number; method?: string; result?: unknown; error?: { message: string };
				params?: { uri?: string; token?: string | number; value?: { kind?: string; title?: string; percentage?: number } };
			};
			this.buffer = this.buffer.subarray(sep + 4 + len);
			if (msg.method && msg.id !== undefined) {
				// Server requests (window/workDoneProgress/create): acknowledge.
				this.send({ id: msg.id, result: null });
			} else if (msg.id !== undefined && this.pending.has(msg.id)) {
				const p = this.pending.get(msg.id)!;
				this.pending.delete(msg.id);
				if (msg.error) p.reject(new Error(msg.error.message));
				else p.resolve(msg.result);
			} else if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri) {
				this.parsed.get(msg.params.uri)?.();
			} else if (msg.method === "$/progress" && msg.params?.value) {
				const v = msg.params.value;
				if (v.kind === "begin" && /index/i.test(v.title ?? "")) {
					this.indexToken = msg.params.token;
					this.indexing = { percentage: v.percentage };
				} else if (msg.params.token === this.indexToken) {
					this.indexing = v.kind === "end" ? undefined : { percentage: v.percentage ?? this.indexing?.percentage };
				}
			}
		}
	}

	private send(msg: Record<string, unknown>): void {
		const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }));
		this.child?.stdin?.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
	}

	private notify(method: string, params: unknown): void {
		this.send({ method, params });
	}

	private request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
		if (this.dead) return Promise.reject(new Error(this.dead));
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`clangd: ${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => { clearTimeout(timer); resolve(v as T); },
				reject: (e) => { clearTimeout(timer); reject(e); },
			});
			this.send({ id, method, params });
		});
	}

	/** Open a file once and wait until clangd has parsed it (its first diagnostics). */
	private open(abs: string): Promise<void> {
		const uri = `file://${abs}`;
		let p = this.opened.get(uri);
		if (!p) {
			p = new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 90_000);
				this.parsed.set(uri, () => { clearTimeout(timer); resolve(); });
				this.notify("textDocument/didOpen", { textDocument: { uri, languageId: "cpp", version: 1, text: fs.readFileSync(abs, "utf8") } });
			});
			this.opened.set(uri, p);
		}
		return p;
	}

	private display(uri: string, line: number): string {
		let p = decodeURIComponent(uri.replace(/^file:\/\//, ""));
		if (this.remap && isInside(p, this.remap.from)) p = path.join(this.remap.to, path.relative(this.remap.from, p));
		const rel = isInside(p, this.top) ? path.relative(this.top, p) : p;
		let text = "";
		try {
			text = fs.readFileSync(p, "utf8").split("\n")[line]?.trim() ?? "";
		} catch { /* outside what we can read */ }
		return `${rel}:${line + 1}${text ? `: ${text.length > 140 ? `${text.slice(0, 139)}…` : text}` : ""}`;
	}

	private list(title: string, items: string[]): string {
		const unique = [...new Set(items)];
		const note = this.indexing
			? `\n(note: the project index is still being built${this.indexing.percentage !== undefined ? ` (${this.indexing.percentage}%)` : ""}; results from files the change doesn't touch may be incomplete — ask again later)`
			: "";
		if (unique.length === 0) return `${title}: none found${note}`;
		const shown = unique.slice(0, XREF_MAX_RESULTS);
		return `${title} (${unique.length}${unique.length > shown.length ? `, first ${shown.length} shown` : ""}):\n${shown.join("\n")}${note}`;
	}

	async query(q: { query: string; symbol: string; file?: string; line?: number }): Promise<string> {
		await this.start();
		if (q.query === "symbol") {
			const syms = (await this.request<Array<{ name: string; containerName?: string; location: LspLocation }>>("workspace/symbol", { query: q.symbol })) ?? [];
			return this.list(`symbols matching "${q.symbol}"`, syms.map((s) => `${s.containerName ? `${s.containerName}::` : ""}${s.name} — ${this.display(s.location.uri, s.location.range.start.line)}`));
		}
		if (!q.file || !q.line) return "xref: this query needs `file` and `line` (the line where the symbol appears)";
		const abs = path.resolve(this.top, q.file);
		if (!isInside(abs, this.top) || !fs.existsSync(abs)) return `xref: ${q.file} is not a file in the repository`;
		const text = fs.readFileSync(abs, "utf8").split("\n")[q.line - 1] ?? "";
		const col = new RegExp(`\\b${q.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).exec(text)?.index;
		if (col === undefined) return `xref: "${q.symbol}" does not appear on ${q.file}:${q.line} (${text.trim().slice(0, 100)})`;
		await this.open(abs);
		const pos = { textDocument: { uri: `file://${abs}` }, position: { line: q.line - 1, character: col } };
		if (q.query === "definition") {
			const defs = (await this.request<LspLocation[] | LspLocation | null>("textDocument/definition", pos)) ?? [];
			return this.list(`definition of ${q.symbol}`, (Array.isArray(defs) ? defs : [defs]).map((d) => this.display(d.uri, d.range.start.line)));
		}
		if (q.query === "references") {
			const refs = (await this.request<LspLocation[]>("textDocument/references", { ...pos, context: { includeDeclaration: false } })) ?? [];
			return this.list(`references to ${q.symbol}`, refs.map((r) => this.display(r.uri, r.range.start.line)));
		}
		const items = (await this.request<unknown[]>("textDocument/prepareCallHierarchy", pos)) ?? [];
		if (items.length === 0) return `xref: ${q.symbol} at ${q.file}:${q.line} is not a function`;
		type Call = { from?: { name: string; uri: string }; to?: { name: string; uri: string }; fromRanges: Array<{ start: { line: number } }> };
		const incoming = q.query === "callers";
		const calls = (await this.request<Call[]>(incoming ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls", { item: items[0] })) ?? [];
		return this.list(
			`${incoming ? "callers of" : "functions called by"} ${q.symbol}`,
			calls.map((c) => {
				const other = (incoming ? c.from : c.to)!;
				// fromRanges are call sites in the caller (incoming) or in this function (outgoing).
				const at = this.display(incoming ? other.uri : `file://${abs}`, c.fromRanges[0]?.start.line ?? 0);
				return `${other.name} — ${at}`;
			}),
		);
	}

	dispose(): void {
		const child = this.child;
		const scratch = this.scratch;
		// clangd writes temp files there until it exits; remove it after.
		const removeScratch = () => {
			if (scratch) fs.rm(scratch, { recursive: true, force: true }, () => {});
		};
		if (child && child.exitCode === null) {
			// Ask clangd to exit (it stops indexing and flushes shards), then make sure.
			this.send({ id: ++this.nextId, method: "shutdown", params: null });
			this.notify("exit", null);
			const timer = setTimeout(() => stopSandboxed(child), 2_000);
			timer.unref?.();
			child.once("exit", () => {
				clearTimeout(timer);
				removeScratch();
			});
		} else {
			removeScratch();
		}
		this.fail("disposed");
	}
}

export function createXrefTool(service: XrefService) {
	return {
		name: XREF_TOOL,
		label: "Xref",
		description:
			"Precise C/C++ code navigation (clangd), more reliable than grep for overloaded or common names. Queries: " +
			"definition / references / callers / callees of `symbol` as it appears on `file`:`line`; or symbol (search the project index by name, no file/line). " +
			"Results are file:line with the source line. Paths are repo-relative.",
		parameters: Type.Object({
			query: StringEnum(XREF_QUERIES),
			symbol: Type.String({ description: "Identifier as written in the code, e.g. pull or ModelIngest" }),
			file: Type.Optional(Type.String({ description: "Repo-relative file where the symbol appears" })),
			line: Type.Optional(Type.Number({ description: "1-based line in that file where the symbol appears" })),
		}),
		async execute(_id: string, params: { query: string; symbol: string; file?: string; line?: number }) {
			let text: string;
			try {
				text = await service.query(params);
			} catch (err) {
				text = `xref failed: ${err instanceof Error ? err.message : String(err)}`;
			}
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	};
}

/**
 * The xref service for a C/C++ review, started right away so indexing
 * overlaps the checks and reviews; undefined when clangd isn't installed or
 * there is no compile database. A PR worktree uses the main checkout's
 * index and database (its own changed files are opened, and index paths are
 * mapped back onto the worktree), so each PR doesn't re-index from scratch.
 */
export function createXrefService(files: string[], reviewDir: string, localDir: string, homeDirs: string[]): XrefService | undefined {
	if (!files.some((f) => CXX_FILE.test(f)) || !fs.existsSync(CLANGD_BIN)) return undefined;
	const reviewTop = gitRoots(reviewDir).top;
	const changed = files.filter((f) => CXX_FILE.test(f)).map((f) => path.join(reviewTop, f)).filter((f) => fs.existsSync(f));
	const ownDb = findCompileDb(reviewTop);
	const localTop = gitRoots(localDir).top;
	const db = ownDb ?? (localTop !== reviewTop ? findCompileDb(localTop) : undefined);
	if (!db) return undefined;
	const owner = ownDb ? reviewTop : localTop;
	const indexDir = xrefIndexDir(owner);
	fs.mkdirSync(indexDir, { recursive: true });
	const copy = path.join(indexDir, "compile_commands.json");
	if ((fs.statSync(copy, { throwIfNoEntry: false })?.mtimeMs ?? 0) < fs.statSync(db).mtimeMs) fs.copyFileSync(db, copy);
	const service = ownDb
		? new XrefService(reviewTop, indexDir, homeDirs, undefined, [path.dirname(db)], changed)
		: new XrefService(reviewTop, indexDir, homeDirs, { from: localTop, to: reviewTop }, [localTop, path.dirname(db)], changed);
	service.start().catch(() => {});
	return service;
}
