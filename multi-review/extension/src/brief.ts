import * as fs from "node:fs";
import * as path from "node:path";

/** Raw brief fields as they arrive from the tool call (or the --spec flag). */
export interface BriefInput {
	intent?: string;
	requirements?: string[];
	suspicions?: string[];
	specPath?: string;
	contextFiles?: string[];
	/** Shell commands (type-check, build, targeted tests) run once in the sandbox before the fan-out. */
	checks?: string[];
}

export function hasBriefInput(b: BriefInput): boolean {
	return Boolean(b.intent?.trim() || b.specPath || b.requirements?.length || b.contextFiles?.length || b.suspicions?.length || b.checks?.length);
}

/**
 * What reviewers are told about the change beyond the diff. The main agent
 * drafts this (it has the conversation context the reviewers lack); the
 * spec, when given, is passed through verbatim as the source of truth.
 */
export interface ReviewBrief {
	intent: string;
	requirements: string[];
	/** The lead's own bug hypotheses. Never shown to finding reviewers (anchoring); see SuspicionResult. */
	suspicions: string[];
	spec?: { path: string; text: string };
	contextFiles: { path: string; text: string }[];
	checks: string[];
}

const SPEC_BUDGET_CHARS = 60_000;
const CONTEXT_FILE_BUDGET_CHARS = 40_000;
const CONTEXT_TOTAL_BUDGET_CHARS = 150_000;
const MAX_CONTEXT_FILES = 12;
const MAX_SUSPICIONS = 20;
const MAX_CHECKS = 4;

function clip(text: string, budget: number, label: string): string {
	if (text.length <= budget) return text;
	return text.slice(0, budget) + `\n…(${label} truncated to ${budget} chars; ${text.length} total)\n`;
}

/**
 * Resolve a spec path relative to cwd and read it. Returns an error string
 * instead of throwing so callers can surface it as a notify.
 */
export function readSpecFile(cwd: string, specPath: string): { path: string; text: string } | { error: string } {
	const abs = path.resolve(cwd, specPath);
	try {
		const text = fs.readFileSync(abs, "utf8");
		if (!text.trim()) return { error: `spec file is empty: ${specPath}` };
		return { path: path.relative(cwd, abs) || specPath, text: clip(text, SPEC_BUDGET_CHARS, "spec") };
	} catch (err) {
		return { error: `cannot read spec ${specPath}: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/** Read the files the brief asks reviewers to see in full; unreadable ones become warnings. */
export function buildBrief(
	cwd: string,
	input: BriefInput,
	warnings: string[],
): ReviewBrief {
	const brief: ReviewBrief = {
		intent: input.intent?.trim() ?? "",
		requirements: (input.requirements ?? []).map((r) => r.trim()).filter(Boolean),
		suspicions: (input.suspicions ?? []).map((r) => r.trim()).filter(Boolean).slice(0, MAX_SUSPICIONS),
		contextFiles: [],
		checks: (input.checks ?? []).map((c) => c.trim()).filter(Boolean),
	};
	if (brief.checks.length > MAX_CHECKS) {
		warnings.push(`only the first ${MAX_CHECKS} of ${brief.checks.length} checks run`);
		brief.checks = brief.checks.slice(0, MAX_CHECKS);
	}
	if (input.specPath) {
		const spec = readSpecFile(cwd, input.specPath);
		if ("error" in spec) warnings.push(spec.error);
		else brief.spec = spec;
	}
	let total = 0;
	for (const rel of (input.contextFiles ?? []).slice(0, MAX_CONTEXT_FILES)) {
		try {
			const text = clip(fs.readFileSync(path.resolve(cwd, rel), "utf8"), CONTEXT_FILE_BUDGET_CHARS, rel);
			if (total + text.length > CONTEXT_TOTAL_BUDGET_CHARS) {
				warnings.push(`context file skipped (total budget): ${rel}`);
				continue;
			}
			total += text.length;
			brief.contextFiles.push({ path: rel, text });
		} catch (err) {
			warnings.push(`context file unreadable: ${rel} (${err instanceof Error ? err.message : String(err)})`);
		}
	}
	return brief;
}
