import type { ReviewFlags } from "./config.ts";

/**
 * Pull `--verify` / `--quick` (and legacy `--mode=…`) out of the args.
 * Legacy modes map onto the flags: council → verify, triage → quick,
 * balanced/light → defaults (agent-led balanced subsumes both).
 */
export function parseReviewFlags(rawArgs: string, defaults: ReviewFlags): { flags: ReviewFlags; rest: string } {
	const flags = { ...defaults };
	let rest = rawArgs;
	const verify = parseBoolFlag(rest, "verify");
	rest = verify.rest;
	if (verify.present) flags.verify = true;
	const quick = parseBoolFlag(rest, "quick");
	rest = quick.rest;
	if (quick.present) flags.quick = true;
	const legacy = parseValueFlag(rest, "mode");
	rest = legacy.rest;
	if (legacy.value?.toLowerCase() === "council") flags.verify = true;
	if (legacy.value?.toLowerCase() === "triage") flags.quick = true;
	return { flags, rest };
}

/** Extract a `--name=value` flag (value without spaces) anywhere in the args. */
export function parseValueFlag(rawArgs: string, name: string): { value?: string; rest: string } {
	const re = new RegExp(`(^|\\s)--${name}=(\\S+)(?=\\s|$)`);
	const m = rawArgs.match(re);
	if (!m) return { rest: rawArgs };
	return { value: m[2], rest: rawArgs.replace(re, "$1").replace(/\s+/g, " ").trim() };
}

/** Extract a bare `--name` switch anywhere in the args. */
export function parseBoolFlag(rawArgs: string, name: string): { present: boolean; rest: string } {
	const re = new RegExp(`(^|\\s)--${name}(?=\\s|$)`);
	if (!re.test(rawArgs)) return { present: false, rest: rawArgs };
	return { present: true, rest: rawArgs.replace(re, "$1").replace(/\s+/g, " ").trim() };
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

const ARG_COMPLETIONS: Array<{ token: string; label: string; description: string }> = [
	{ token: "--spec=", label: "--spec=<path>", description: "review the implementation against a spec file" },
	{ token: "--verify", label: "--verify", description: "cross-check each finding with reviewers who didn't raise it" },
	{ token: "--quick", label: "--quick", description: "fast reviewer pool, no tools" },
	{ token: "--direct", label: "--direct", description: "skip the main agent; external judge synthesizes" },
	{ token: "--pr-comments", label: "--pr-comments", description: "with a PR: verify its existing review comments (CodeRabbit, collaborators)" },
	{ token: "--nits", label: "--nits", description: "with --pr-comments: include nitpicks" },
	{ token: "--resolved", label: "--resolved", description: "with --pr-comments: include resolved threads" },
	{ token: "#", label: "#<pr>", description: "review a PR by number" },
];

/**
 * Complete only the token being typed. The returned value replaces the whole
 * argument string, so it must carry everything before that token — a static
 * list (or an empty "(default)" item) would wipe typed args on Enter.
 */
export function completeReviewArgs(prefix: string): Array<{ value: string; label: string; description?: string }> | null {
	const lastSpace = prefix.lastIndexOf(" ");
	const head = prefix.slice(0, lastSpace + 1);
	const token = prefix.slice(lastSpace + 1);
	if (token && !token.startsWith("-") && !token.startsWith("#")) return null;
	const items = ARG_COMPLETIONS
		.filter((c) => c.token.startsWith(token) && c.token !== token)
		.map((c) => ({ value: head + c.token, label: c.label, description: c.description }));
	return items.length > 0 ? items : null;
}
