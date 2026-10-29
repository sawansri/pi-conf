import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type MultiReviewConfig, parseReviewerSpec } from "./config.ts";
import { parseJsonLenient } from "./findings.ts";
import type { Verification } from "./grouping.ts";
import { callModel, findModel } from "./models.ts";
import { type ReviewTarget, exec } from "./target.ts";
import { withTimeout } from "./util.ts";

// ---------- PR review comments (CodeRabbit, collaborators) ----------

/** One reviewable unit fetched from the PR: a review thread, a review body, or a conversation comment. */
export interface PrCommentItem {
	id: string;
	kind: "thread" | "review" | "conversation";
	author: string;
	bot: boolean;
	url: string;
	path?: string;
	line?: number | null;
	outdated?: boolean;
	resolved?: boolean;
	hunk?: string;
	text: string;
	/** Later replies in the thread (author: text), e.g. "fixed in abc123". */
	replies?: string[];
	/** Resolved thread kept only so bots' summary bodies don't resurrect it as a new claim. */
	contextOnly?: boolean;
}

/** A checkable claim extracted from a PR comment, verified like a suspicion. */
export interface PrClaim {
	id: string;
	itemId: string;
	author: string;
	url: string;
	path?: string;
	line?: number | null;
	outdated?: boolean;
	hunk?: string;
	claim: string;
	nit: boolean;
	raisedBy: string[];
	verifications?: Verification[];
	verificationNote?: string;
}

/** A PR comment that isn't a checkable defect claim: answered or noted by the lead, not verified. */
export interface PrNonClaim {
	itemId: string;
	author: string;
	url: string;
	type: "question" | "preference";
	summary: string;
}

export interface PrCommentsReport {
	claims: PrClaim[];
	others: PrNonClaim[];
	stats: { threads: number; reviews: number; conversation: number; skippedResolved: number; skippedNits: number; noise: number };
}

/**
 * Strip markup that carries no review content: HTML comments (bot state),
 * images/badges, and CodeRabbit's "Prompt for AI Agents" blocks (a restated
 * copy of the comment). Keeps details/summary text.
 */
export function cleanCommentBody(body: string): string {
	return body
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<details>\s*<summary>[^<]*Prompt for AI Agents[^<]*<\/summary>[\s\S]*?<\/details>/gi, "")
		.replace(/<(picture|source|img)[^>]*>(<\/picture>)?/gi, "")
		// Known HTML tags only — a generic <…> strip would eat code like Cache<V>.
		.replace(/<\/?(details|summary|blockquote|div|span|p|br|hr|sub|sup|b|i|em|strong|code|pre|kbd|a|dl|dt|dd|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6])(\s[^>]*)?\/?>/gi, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const PR_THREADS_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          isResolved isOutdated path line originalLine
          comments(first: 30) { nodes { author { login __typename } body url diffHunk } }
        }
      }
    }
  }
}`;

/**
 * Fetch every review surface of a PR with gh (read-only). Resolved threads
 * are skipped unless asked; outdated ones are kept (does it still apply?).
 */
export async function fetchPrComments(
	pi: ExtensionAPI,
	cwd: string,
	pr: NonNullable<ReviewTarget["pr"]>,
	includeResolved: boolean,
	warnings: string[],
): Promise<{ items: PrCommentItem[]; skippedResolved: number }> {
	const items: PrCommentItem[] = [];
	let skippedResolved = 0;
	const gql = await exec(pi, "gh", ["api", "graphql", "-f", `query=${PR_THREADS_QUERY}`, "-F", `owner=${pr.owner}`, "-F", `name=${pr.repo}`, "-F", `n=${pr.number}`], cwd, 60_000);
	if (gql.code !== 0) {
		warnings.push(`could not fetch PR review threads: ${gql.stderr.trim().slice(0, 160)}`);
	} else {
		const threads = JSON.parse(gql.stdout)?.data?.repository?.pullRequest?.reviewThreads;
		if (threads?.pageInfo?.hasNextPage) warnings.push("PR has more than 100 review threads; only the first 100 were checked");
		for (const t of threads?.nodes ?? []) {
			const comments = t.comments?.nodes ?? [];
			if (comments.length === 0) continue;
			const skip = Boolean(t.isResolved) && !includeResolved;
			if (skip) skippedResolved++;
			const [first, ...rest] = comments;
			const text = cleanCommentBody(String(first.body ?? ""));
			if (!text) continue;
			items.push({
				id: `c${items.length + 1}`,
				kind: "thread",
				author: first.author?.login ?? "ghost",
				bot: first.author?.__typename === "Bot",
				url: first.url,
				path: t.path,
				line: t.line ?? t.originalLine ?? null,
				outdated: Boolean(t.isOutdated),
				resolved: Boolean(t.isResolved),
				hunk: typeof first.diffHunk === "string" ? first.diffHunk.split("\n").slice(-12).join("\n") : undefined,
				text: text.slice(0, skip ? 1200 : 4000),
				replies: rest.map((c: { author?: { login?: string }; body?: string }) => `${c.author?.login ?? "ghost"}: ${cleanCommentBody(String(c.body ?? "")).slice(0, 400)}`),
				contextOnly: skip,
			});
		}
	}
	const rest = async (endpoint: string, kind: PrCommentItem["kind"]) => {
		const res = await exec(pi, "gh", ["api", "--paginate", endpoint, "--jq", ".[] | {user: .user.login, type: .user.type, body, url: .html_url}"], cwd, 60_000);
		if (res.code !== 0) {
			warnings.push(`could not fetch ${endpoint}: ${res.stderr.trim().slice(0, 160)}`);
			return;
		}
		for (const line of res.stdout.split("\n")) {
			if (!line.trim()) continue;
			const c = JSON.parse(line);
			const text = cleanCommentBody(String(c.body ?? ""));
			if (!text) continue;
			items.push({ id: `c${items.length + 1}`, kind, author: c.user, bot: c.type === "Bot", url: c.url, text: text.slice(0, 12_000) });
		}
	};
	await rest(`repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, "review");
	await rest(`repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`, "conversation");
	return { items, skippedResolved };
}

const CLASSIFY_SYSTEM_PROMPT = `You triage review comments on a pull request (from bots like CodeRabbit and from human collaborators) for a verification pipeline.

For each item, extract every distinct CHECKABLE defect claim it makes — something about the code that can be shown true or false by reading it ("X can be null at Y", "the test never runs in CI", "this leaks the key into the file"). One item may hold many claims (bot review bodies list several, including "outside diff range" and nitpick sections); one claim per entry.

Classify what's left of each item:
- "question": asks the author something ("why not use X?") — summarize it.
- "preference": style/design taste without a checkable defect — summarize it.
- "noise": approvals, praise, walkthroughs/summaries of the change, tool boilerplate, "fixed"/"done" replies.

Items marked "RESOLVED — context only" are threads the PR participants already settled. Extract NO claims from them, and do not extract the same defect again from any other item (bots often repeat inline comments in their review summary bodies). Give them type "noise".

Mark a claim "nit": true when it's cosmetic/minor (the bot calls it a nitpick, or it's naming/formatting/comment wording).

Output ONLY a JSON array, one entry per item:
[{"id": "c1", "claims": [{"claim": "<one self-contained sentence, include the identifier/file it's about>", "path": "<file or null>", "line": <int or null>, "nit": false}], "type": "claims"|"question"|"preference"|"noise", "summary": "<≤160 chars, for question/preference>"}]`;

/** One model call turns raw PR comments into claims vs questions/preferences/noise. */
export async function classifyPrComments(
	ctx: ExtensionContext,
	cfg: MultiReviewConfig,
	items: PrCommentItem[],
	includeNits: boolean,
	signal: AbortSignal | undefined,
): Promise<Omit<PrCommentsReport, "stats"> & { skippedNits: number; noise: number; error?: string }> {
	const empty = { claims: [], others: [], skippedNits: 0, noise: 0 };
	if (items.length === 0) return empty;
	const parsedSpec = parseReviewerSpec(cfg.dedupeModel && cfg.dedupeModel !== "lexical" ? cfg.dedupeModel : cfg.judge, "low");
	const model = parsedSpec ? findModel(ctx, parsedSpec.spec) : null;
	if (!parsedSpec || !model) return { ...empty, error: "no model available to classify PR comments" };
	const listing = items.map((it) => [
		`### ${it.id} · ${it.kind} · @${it.author}${it.bot ? " (bot)" : ""}${it.path ? ` · ${it.path}:${it.line ?? "?"}` : ""}${it.outdated ? " · outdated" : ""}${it.contextOnly ? " · RESOLVED — context only" : ""}`,
		it.text,
		...(it.replies?.length ? ["Replies:", ...it.replies] : []),
	].join("\n")).join("\n\n");
	const call = await callModel(ctx, model, CLASSIFY_SYSTEM_PROMPT, listing, { thinking: parsedSpec.thinking, temperature: 0, signal: withTimeout(signal, 180_000) });
	if (call.errorMessage) return { ...empty, error: call.errorMessage };
	let parsed: unknown;
	try {
		parsed = parseJsonLenient(call.text.slice(call.text.indexOf("["), call.text.lastIndexOf("]") + 1));
	} catch (err) {
		return { ...empty, error: `classifier JSON: ${err instanceof Error ? err.message : String(err)}` };
	}
	const byId = new Map(items.map((it) => [it.id, it]));
	const claims: PrClaim[] = [];
	const others: PrNonClaim[] = [];
	let skippedNits = 0;
	let noise = 0;
	for (const entry of Array.isArray(parsed) ? parsed : []) {
		const it = byId.get(String(entry?.id ?? ""));
		if (!it || it.contextOnly) continue;
		const type = String(entry?.type ?? "");
		for (const c of Array.isArray(entry?.claims) ? entry.claims : []) {
			const text = typeof c?.claim === "string" ? c.claim.trim() : "";
			if (!text) continue;
			if (c?.nit === true && !includeNits) {
				skippedNits++;
				continue;
			}
			claims.push({
				id: `p${claims.length + 1}`,
				itemId: it.id,
				author: it.author,
				url: it.url,
				path: typeof c?.path === "string" && c.path ? c.path : it.path,
				line: typeof c?.line === "number" ? c.line : it.line,
				outdated: it.outdated,
				hunk: it.hunk,
				claim: text.slice(0, 600),
				nit: c?.nit === true,
				raisedBy: [],
			});
		}
		if (type === "question" || type === "preference") {
			others.push({ itemId: it.id, author: it.author, url: it.url, type, summary: String(entry?.summary ?? "").slice(0, 200) });
		} else if (type === "noise") {
			noise++;
		}
	}
	return { claims, others, skippedNits, noise };
}
