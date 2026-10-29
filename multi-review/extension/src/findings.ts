import type { Model, ModelSpec, ThinkingLevelAlias } from "./config.ts";

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
	/** Title + core comment (no evidence/suggestion), used for dedupe matching. */
	match_text?: string;
	/** Structured parts of `comment` (which keeps them merged for display/judge). */
	parts?: FindingParts;
}

export interface FindingParts {
	core: string;
	evidence?: string;
	/** Concrete trigger → observed vs expected; makes the finding test-ready. */
	repro?: string;
	suggestion?: string;
}

export interface ReviewerRunResult {
	/** The spec as the user wrote it — with the @level suffix when present. */
	formattedSpec: string;
	spec: ModelSpec;
	thinking: ThinkingLevelAlias;
	/** True when Model.thinkingLevelMap clamped the requested level to a softer value. */
	clamped: boolean;
	model: Model;
	ok: boolean;
	findings: ReviewerFinding[];
	rawText: string;
	stopReason: string;
	errorMessage?: string;
	usage?: { input: number; output: number; total: number; cost: number };
	toolCalls?: number;
	durationMs: number;
}

/**
 * Strip a JSON-array-shaped response from any junk the model wraps around it.
 * Some models — especially Fireworks-hosted ones — sometimes honor the
 * 'ONLY JSON' rule by wrapping in a ```json fence. This is tolerant of both.
 */
/**
 * JSON.parse, retrying once on a repaired copy. Review comments quote code,
 * so models routinely emit raw backslashes (`\d`), raw newlines, and bare
 * quotes (`uses "-q"`) inside JSON strings — one bad character shouldn't
 * discard a reviewer's whole output.
 */
export function parseJsonLenient(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (err) {
		const repaired = repairJsonText(text);
		if (repaired === text) throw err;
		return JSON.parse(repaired);
	}
}

/**
 * String-aware repair scan. Inside strings: escape raw control characters,
 * double backslashes that don't start a valid escape, and escape a quote
 * unless the next non-space character could legally follow a string
 * (`,` `}` `]` `:`), which marks it as the real closing quote.
 */
export function repairJsonText(text: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (!inString) {
			if (ch === '"') inString = true;
			out += ch;
			continue;
		}
		if (ch === "\\") {
			const next = text[i + 1] ?? "";
			if (/["\\/bfnrt]/.test(next)) {
				out += ch + next;
				i++;
			} else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
				out += text.slice(i, i + 6);
				i += 5;
			} else {
				out += "\\\\";
			}
			continue;
		}
		if (ch === '"') {
			const rest = text.slice(i + 1).match(/^\s*(.)/);
			if (!rest || /[,}\]:]/.test(rest[1])) {
				inString = false;
				out += ch;
			} else {
				out += '\\"';
			}
			continue;
		}
		if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "\t") out += "\\t";
		else out += ch;
	}
	return out;
}

/** First non-empty string among `keys` (trimmed), or "". */
export function pickText(obj: Record<string, unknown>, keys: string[]): string {
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return "";
}

/** Map schema and common off-schema severity words onto the ladder; unknown → info. */
function normalizeSeverity(raw: string): ReviewerFinding["severity"] {
	const v = raw.toLowerCase().trim();
	if (["critical", "high", "medium", "low", "info", "none"].includes(v)) return v as ReviewerFinding["severity"];
	if (["blocker", "severe", "fatal"].includes(v)) return "critical";
	if (["error", "major", "bug"].includes(v)) return "high";
	if (["warning", "warn", "moderate"].includes(v)) return "medium";
	if (["minor", "nit", "nitpick", "suggestion", "style"].includes(v)) return v === "minor" ? "low" : "info";
	return "info";
}

export function parseReviewerJson(rawText: string): ReviewerFinding[] {
	const text = rawText.trim();
	// Strip a wrapping fence if present. A bare array is used as-is, and the
	// match runs first fence to last: findings often quote fenced code, and a
	// lazy match would land between two of those inner fences.
	const fenceMatch = text.startsWith("[") ? null : text.match(/```(?:json)?\s*([\s\S]*)\s*```/i);
	const inner = fenceMatch ? fenceMatch[1] : text;
	// Find first '[' and last ']' to ignore any wrapper text. A reply with no
	// array at all is a protocol failure, not "no findings" — only an explicit
	// [] means clean.
	const start = inner.indexOf("[");
	const end = inner.lastIndexOf("]");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error(`no JSON array in reply: ${JSON.stringify(text.slice(0, 120))}`);
	}
	let parsed = parseJsonLenient(inner.slice(start, end + 1)) as any;
	// Tolerate {"findings": [...]} wrappers some models emit despite the schema.
	if (!Array.isArray(parsed) && Array.isArray(parsed?.findings)) parsed = parsed.findings;
	if (!Array.isArray(parsed)) throw new Error("reply JSON is not an array");
	const findings: ReviewerFinding[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object") continue;
		const f = item as Partial<ReviewerFinding>;
		const rec = item as Record<string, unknown>;
		const num = (...keys: string[]): number | null => {
			for (const k of keys) {
				const v = typeof rec[k] === "string" ? Number(rec[k]) : rec[k];
				if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
			}
			return null;
		};
		const lineStart = num("line_start", "start_line", "line");
		const lineEnd = num("line_end", "end_line") ?? lineStart;
		const severity = normalizeSeverity(pickText(rec, ["severity", "level", "priority"]));
		const category = String(f.category ?? "general").slice(0, 32).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "general";
		const raw = item as Record<string, unknown>;
		// Models drift from the schema's field names; accept the common synonyms
		// so a finding never arrives as an empty "(untitled)" shell.
		const core = pickText(raw, ["comment", "description", "issue", "problem", "message", "details", "explanation"]);
		const title = (pickText(raw, ["title", "summary", "name", "headline"]) || core.slice(0, 80) || "(untitled)").slice(0, 200);
		const evidenceText = pickText(raw, ["evidence", "reasoning", "justification", "trace", "proof"]);
		const suggestionText = pickText(raw, ["suggestion", "fix", "recommendation", "remediation"]);
		const reproText = pickText(raw, ["repro", "reproduction", "trigger", "steps", "test_case", "example"]);
		const evidence = evidenceText ? `\nEvidence: ${evidenceText}` : "";
		const repro = reproText ? `\nRepro: ${reproText}` : "";
		const suggestion = suggestionText ? `\nSuggestion: ${suggestionText}` : "";
		const comment = (core + evidence + repro + suggestion).slice(0, 2800);
		const filePath = pickText(raw, ["file", "path", "filename", "file_path"]);
		if (!filePath) continue;
		findings.push({
			file: filePath, line_start: lineStart, line_end: lineEnd, severity, category, title, comment,
			match_text: `${title} ${core}`,
			parts: {
				core,
				evidence: evidenceText || undefined,
				repro: reproText || undefined,
				suggestion: suggestionText || undefined,
			},
		});
	}
	// Entries existed but none was usable: a protocol failure, not a clean review.
	if (parsed.length > 0 && findings.length === 0) {
		throw new Error(`${parsed.length} finding(s) in reply but none had a file: ${JSON.stringify(JSON.stringify(parsed[0]).slice(0, 120))}`);
	}
	return findings;
}
