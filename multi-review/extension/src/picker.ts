import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionContext, getAgentDir } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { DEFAULTS, type Model, type ModelSpec, parseReviewerSpec } from "./config.ts";

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
export async function pickReviewersViaTUI(
	ctx: ExtensionContext,
	models: Model[],
	preSelect: string[] = [],
): Promise<ModelSpec[] | null> {
	if (!ctx.hasUI) {
		// Best-effort fallback for print/RPC modes: select first pre-existing
		// spec that resolves else fail cleanly. We keep the bare spec only
		// (drop any @level suffix from the storage form).
		const first = preSelect.find((s) => {
			const bare = parseReviewerSpec(s)?.spec ?? s;
			return models.some((m) => `${m.provider}/${m.id}` === bare);
		});
		if (!first) return null;
		const bare = parseReviewerSpec(first)?.spec ?? first;
		return [bare];
	}

	const { rows, modelRowIndexToSpec } = buildPickerRows(models);
	const specToModelIndex = new Map<ModelSpec, number>();
	for (const [idx, spec] of modelRowIndexToSpec) specToModelIndex.set(spec, idx);

	const preSelectedModelIndices = new Set<number>();
	for (const spec of preSelect) {
		const parsed = parseReviewerSpec(spec);
		const bareSpec = (parsed?.spec ?? spec) as ModelSpec;
		const idx = specToModelIndex.get(bareSpec);
		if (idx !== undefined) preSelectedModelIndices.add(idx);
	}

	const cursorToModelIndex: number[] = rows.map((r) => (r.kind === "model" ? (r.modelIndex ?? -1) : -1));
	const firstModelRow = rows.findIndex((r) => r.kind === "model");
	let cursor = firstModelRow >= 0 ? firstModelRow : 0;
	let scrollTop = 0;

	const result = await ctx.ui.custom<{ spec: ModelSpec }[] | null>((_tui, theme, _kb, done) => {
		const selected = new Set<number>(preSelectedModelIndices);
		let cachedLines: string[] | undefined;
		let cachedWidth: number | undefined;
		const visibleBodyRows = 16;

		function isModelRow(i: number): boolean {
			return i >= 0 && i < rows.length && rows[i].kind === "model";
		}

		function moveCursor(delta: number): void {
			if (rows.length === 0) return;
			let next = cursor;
			for (let n = 0; n < rows.length; n++) {
				next = (next + delta + rows.length) % rows.length;
				if (isModelRow(next)) {
					cursor = next;
					return;
				}
			}
		}

		function jumpModels(delta: number): void {
			const dir = delta < 0 ? -1 : 1;
			for (let i = 0; i < Math.abs(delta); i++) moveCursor(dir);
		}

		function adjustScroll(): void {
			if (cursor < scrollTop) scrollTop = cursor;
			if (cursor >= scrollTop + visibleBodyRows) scrollTop = cursor - visibleBodyRows + 1;
			scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, rows.length - visibleBodyRows)));
		}

		function refresh() {
			cachedLines = undefined;
			cachedWidth = undefined;
			adjustScroll();
			_tui.requestRender();
		}

		function commit(cancelled: boolean) {
			if (cancelled) {
				done(null);
				return;
			}
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

		function toggleCursor(): void {
			const mi = cursorToModelIndex[cursor];
			if (mi < 0) return;
			if (selected.has(mi)) selected.delete(mi);
			else selected.add(mi);
		}

		function handleInput(data: string): void {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
				commit(true);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				commit(false);
				return;
			}
			if (matchesKey(data, Key.up)) {
				moveCursor(-1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				moveCursor(1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.pageUp)) {
				jumpModels(-10);
				refresh();
				return;
			}
			if (matchesKey(data, Key.pageDown)) {
				jumpModels(10);
				refresh();
				return;
			}
			if (matchesKey(data, Key.home)) {
				cursor = firstModelRow >= 0 ? firstModelRow : 0;
				refresh();
				return;
			}
			if (matchesKey(data, Key.end)) {
				for (let i = rows.length - 1; i >= 0; i--) {
					if (isModelRow(i)) {
						cursor = i;
						break;
					}
				}
				refresh();
				return;
			}
			if (matchesKey(data, Key.space) || data === " ") {
				toggleCursor();
				refresh();
				return;
			}
			if (data === "a") {
				for (const idx of modelRowIndexToSpec.keys()) selected.add(idx);
				refresh();
				return;
			}
			if (data === "A") {
				selected.clear();
				refresh();
			}
		}

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			adjustScroll();
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", theme.bold(" Pick reviewer models ")));
			add(theme.fg("dim", "Space toggles · ↑↓ moves · PgUp/PgDn jumps · a selects all · A clears · Enter confirms · Esc cancels"));
			lines.push("");

			const end = Math.min(rows.length, scrollTop + visibleBodyRows);
			if (scrollTop > 0) add(theme.fg("dim", ` … ${scrollTop} row${scrollTop === 1 ? "" : "s"} above`));
			for (let i = scrollTop; i < end; i++) {
				const r = rows[i];
				if (r.kind === "provider-header") {
					add(theme.fg("dim", ` ${r.provider}`));
					continue;
				}
				const isCursor = i === cursor;
				const mi = r.modelIndex ?? -1;
				const isSelected = selected.has(mi);
				const cursorMark = isCursor ? theme.fg("accent", "> ") : "  ";
				const box = isSelected ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
				const label = theme.fg(isSelected ? "success" : "text", r.spec ?? "");
				const desc = r.description ? theme.fg("dim", ` — ${r.description}`) : "";
				add(`${cursorMark}${box} ${label}${desc}`);
			}
			if (end < rows.length) add(theme.fg("dim", ` … ${rows.length - end} row${rows.length - end === 1 ? "" : "s"} below`));

			lines.push("");
			const n = selected.size;
			add(theme.fg("muted", ` ${n} reviewer${n === 1 ? "" : "s"} selected · showing ${scrollTop + 1}-${end} of ${rows.length} rows.`));
			if (n === 0) add(theme.fg("warning", " Tip: space-toggle at least one to enable Enter."));
			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
				cachedWidth = undefined;
			},
			handleInput,
		};
	}, {
		overlay: true,
		overlayOptions: { width: "90%", minWidth: 60, maxHeight: "80%", anchor: "center" },
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
export function persistReviewerChoices(chosen: ModelSpec[]): { ok: boolean; error?: string; path: string } {
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
