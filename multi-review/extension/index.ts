/**
 * Multi-Review — multi-model code review led by the main agent (DESIGN: ../README.md · ../install.md)
 *
 * Surfaces:
 *   /multi-review [--spec=path] [--verify] [--quick] [--direct] [PR-number | focus]
 *     → hands off to the main agent (buildHandoffPrompt), which drafts the
 *       reviewer brief and calls the tool; --direct / print / RPC run the
 *       pipeline here with an external judge instead.
 *   multi_review (tool) — brief params (intent, spec_path, requirements,
 *     context_files, focus, scope) + verify/quick; returns findings +
 *     lead-judgment instructions to the agent.
 *
 * Pipeline:
 *   buildReviewTarget (PR / working-tree diff / area) + buildBrief
 *     → runAllReviewers (nested read-only agents or registry calls, per-reviewer timeout)
 *     → groupFindings (semantic clustering, lexical fallback)
 *     → runVerification (--verify: non-raisers confirm/refute each issue)
 *     → agent lead judgment (tool result) | runJudge (direct mode)
 *     → render via the multi-review renderer (tool result or custom message)
 *
 * Persistent defaults: $PI_CODING_AGENT_DIR/multi-review.json loaded once,
 * unknown keys / bad JSON / missing file → silent in-code defaults.
 *
 * Constraint enforced throughout: this extension never writes to
 * ~/.pi/agent/models.json. It only reads ctx.modelRegistry.
 *
 * This file only registers commands, the tool and the renderer. The rest is
 * in src/, one concern per module:
 *   config      MultiReviewConfig, DEFAULTS, loadConfig, reviewer specs
 *   args        slash-command flags and scope parsing, completions
 *   models      registry lookups, pool resolution, callModel
 *   target      ReviewTarget: PR / working-tree diff / text area, PR checkout
 *   discover    gitignore-aware file discovery for area reviews
 *   brief       ReviewBrief: intent, spec, requirements, context files, checks
 *   prompts     reviewer system prompt + tool addenda, the reviewer user prompt
 *   findings    ReviewerFinding, lenient JSON parsing and repair
 *   reviewers   nested reviewer sessions, effort nudge, fan-out with straggler cutoff
 *   agent-tools progress, git and run tools for reviewer sessions
 *   sandbox     nono (Landlock) sandbox: runInSandbox, sandboxInvocation, probe
 *   checks      brief/auto checks (mr-cxx-check), check output for prompts and results
 *   xref        clangd navigation service and tool
 *   web-search  web search for reviewers: native where the gateway serves it, else proxied
 *   grouping    clustering findings into issues (model, lexical fallback), suspicions
 *   verify      verification round: assignment, verifier prompt, verdicts
 *   pr-comments fetching and classifying a PR's existing review comments
 *   synthesis   result.md for the lead (lead view, suspicions, PR comments, checks)
 *   judge       --direct mode judge
 *   lead        handoff prompt and lead-judgment instructions for the main agent
 *   pipeline    runMultiReviewFromArgs → runReviewPipeline (the phases in order)
 *   headless    multi_review tool requests, /multi-review-run
 *   render      TUI message renderer;  picker  reviewer picker TUI
 *   progress / trace   status line, live progress, progress.json + trace.jsonl
 *   util        abortable, withTimeout, mapWithConcurrency
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { completeReviewArgs, parseBoolFlag, parseReviewArgs, parseReviewFlags, parseValueFlag } from "./src/args.ts";
import { readSpecFile } from "./src/brief.ts";
import { DEFAULTS, cacheConfigForFreshRead, loadConfig } from "./src/config.ts";
import { runAgentLedReview, runHeadless } from "./src/headless.ts";
import { buildHandoffPrompt } from "./src/lead.ts";
import { describePool } from "./src/models.ts";
import { persistReviewerChoices, pickReviewersViaTUI } from "./src/picker.ts";
import { runMultiReviewFromArgs, setTransientReviewers } from "./src/pipeline.ts";
import { setStatus } from "./src/progress.ts";
import { type MultiReviewDetails, renderMultiReviewMessage } from "./src/render.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const cfg = loadConfig();
		setStatus(`multi-review · ${describePool(cfg)}`, ctx);
		ctx.ui.notify(`multi-review loaded · ${describePool(cfg)}`, "info");
	});

	pi.registerMessageRenderer("multi-review", renderMultiReviewMessage as unknown as Parameters<ExtensionAPI["registerMessageRenderer"]>[1]);

	/**
	 * Run the full pipeline OR fall back to the picker when the pool is empty
	 * AND UI is available. Centralized so both `/multi-review` and the tool
	 * benefit from the same fallback behavior.
	 */
	async function runWithOptionalPicker(args: string, ctx: ExtensionContext): Promise<void> {
		const cfg = loadConfig();
		if (cfg.reviewers.length === 0 && ctx.hasUI) {
			const available = await ctx.modelRegistry.getAvailable();
			if (available.length > 0) {
				const open = await ctx.ui.confirm(
					"No reviewers configured — pick now?",
					"multi-review.json has no 'reviewers' array. Open the picker so you can select models from your registry? (cancellable; existing file is preserved except for the 'reviewers' key on save.)",
				);
				if (open) {
					ctx.ui.notify("multi-review: opening reviewer picker…", "info");
					const picked = await pickReviewersViaTUI(ctx, available, []);
					if (!picked || picked.length === 0) {
						ctx.ui.notify("multi-review: picker cancelled; nothing to do.", "warning");
						return;
					}
					const persist = await ctx.ui.confirm(
						"Save reviewers to multi-review.json?",
						`Persist ${picked.length} reviewer${picked.length === 1 ? "" : "s"} to ~/.pi/agent/multi-review.json so future /multi-review invocations use this pool without the picker? ` +
							`(Pick "no" to use the selection for THIS run only without persisting.)`,
					);
					if (persist) {
						const result = persistReviewerChoices(picked);
						if (result.ok) {
							ctx.ui.notify(`multi-review · saved ${picked.length} reviewers to ${result.path}`, "info");
							cacheConfigForFreshRead();
						} else {
							ctx.ui.notify(`multi-review · could not save (${result.error}); proceeding for this run only`, "warning");
							setTransientReviewers(picked);
						}
					} else {
						ctx.ui.notify("multi-review · using picked pool for this run only (not persisted)", "info");
						setTransientReviewers(picked);
					}
				}
			}
		}
		// Hand off to the main agent unless asked not to, or there's no agent
		// turn to hand off to (print/RPC modes exit when the command returns).
		const direct = parseBoolFlag(args, "direct");
		args = direct.rest;
		if (!direct.present && ctx.hasUI && ctx.model) {
			const { flags, rest: afterFlags } = parseReviewFlags(args, { verify: cfg.verify, quick: false });
			const { value: specPath, rest: afterSpec } = parseValueFlag(afterFlags, "spec");
			const prC = parseBoolFlag(afterSpec, "pr-comments");
			const nits = parseBoolFlag(prC.rest, "nits");
			const resolvedThreads = parseBoolFlag(nits.rest, "resolved");
			const rest = resolvedThreads.rest;
			const prComments = prC.present ? { includeNits: nits.present, includeResolved: resolvedThreads.present } : undefined;
			if (prComments && parseReviewArgs(rest).kind !== "pr") {
				ctx.ui.notify("multi-review: --pr-comments needs a PR (e.g. #1234 or a PR URL)", "error");
				return;
			}
			if (specPath) {
				const spec = readSpecFile(ctx.cwd, specPath);
				if ("error" in spec) {
					ctx.ui.notify(`multi-review: ${spec.error}`, "error");
					return;
				}
			}
			const prompt = buildHandoffPrompt(rest, flags, specPath, prComments);
			if (ctx.isIdle()) pi.sendUserMessage(prompt);
			else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			return;
		}
		const result = await runMultiReviewFromArgs(pi, ctx, args, undefined);
		ctx.ui.notify(result.notifyMessage, result.notifyLevel);
		if (result.injectMessage) {
			pi.sendMessage({ ...result.injectMessage, display: true });
		}
	}

	// Slash command — surface-level UI entry point.
	pi.registerCommand("multi-review", {
		description:
			"Fan-out code review across configured models. Usage: " +
			"/multi-review [--spec=path] [--verify] [--quick] [--direct] [PR-number [--pr-comments [--nits] [--resolved]] | free-text focus]. " +
			"The main agent drafts the reviewer brief from your args (and spec), then judges the results. " +
			"--direct skips the agent and uses the configured judge.",
		// Argument autocomplete hints the call shape so users don't have to
		// remember to type '#' vs raw digits.
		getArgumentCompletions: (prefix) => completeReviewArgs(prefix),
		handler: async (args, ctx) => {
			// Slash commands fire outside active turns, so ctx.signal is
			// undefined; we pass undefined and accept that the user can't
			// hard-cancel mid-fan-out from here. The tool surface (next
			// sibling) does pass signal — ctrl+c in tool context works.
			await runWithOptionalPicker(args, ctx);
		},
	});

	// Headless entry for other harnesses (Claude Code etc.): brief in, findings out.
	pi.registerCommand("multi-review-run", {
		description:
			"Headless review for external harnesses: /multi-review-run --brief=<brief.json> [--out=<result.json>] [--max-seconds=540]. " +
			"Brief fields mirror the multi_review tool. Writes findings + lead instructions to <out> and <out>.md.",
		handler: async (args, ctx) => {
			await runHeadless(pi, args, ctx);
		},
	});

	// Slash command — picker entry point. Opens the multi-select TUI
	// directly without running the rest of the pipeline. Useful for
	// configuring the pool in advance without dragging scope into it.
	pi.registerCommand("multi-review-pick", {
		description:
			"Open the multi-select picker for reviewer models. " +
			"Saves selection to ~/.pi/agent/multi-review.json on confirm.",
		handler: async (_args, ctx) => {
			const available = await ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify(
					"multi-review-pick: no models in registry. Add them to ~/.pi/agent/models.json or /login first.",
					"error",
				);
				return;
			}
			const cfg = loadConfig();
			const picked = await pickReviewersViaTUI(ctx, available, cfg.reviewers);
			if (!picked || picked.length === 0) {
				ctx.ui.notify("multi-review-pick: cancelled.", "info");
				return;
			}
			const persist = await ctx.ui.confirm(
				"Save reviewers to multi-review.json?",
				`Persist ${picked.length} reviewer${picked.length === 1 ? "" : "s"} to ~/.pi/agent/multi-review.json? ` +
					`${
						cfg.judge
							? `(existing judge ${cfg.judge} will be preserved)`
							: `(existing judge ${DEFAULTS.judge} will be set as the default if missing)`
					}`,
			);
			if (!persist) {
				ctx.ui.notify("multi-review-pick: cancelled at persist step.", "info");
				return;
			}
			const result = persistReviewerChoices(picked);
			if (result.ok) {
				ctx.ui.notify(`multi-review-pick · saved ${picked.length} reviewers to ${result.path}`, "info");
				cacheConfigForFreshRead();
			} else {
				ctx.ui.notify(`multi-review-pick · save failed: ${result.error}`, "error");
			}
		},
	});

	// LLM-callable tool — the main agent briefs the reviewers and judges the results.
	pi.registerTool({
		name: "multi_review",
		label: "Multi-Model Code Review",
		description:
			"Send a code change to N reviewer models (other model families, each with read-only repo access) in parallel. " +
			"You write the brief: intent, optional spec + requirements, related files, focus. Returns deduplicated findings " +
			"with per-model attribution; you then act as lead reviewer and give the user a verdict. Read-only — never edits code.",
		promptSnippet:
			"Run a multi-model code review on the current change (PR, working-tree diff, or a described area), optionally against a spec.",
		promptGuidelines: [
			"Use multi_review when the user asks for a code review, a second opinion, or a check of an implementation against a spec.",
			"Before calling, understand the change yourself and write the brief: reviewers do not see the conversation. Give them what they can't discover, not where you think the bugs are — independent discovery is what makes their agreement meaningful.",
			"`intent`: goals plus facts reviewers can't find in the repo (external API behaviour, constraints, out-of-scope items) — not a narration of the implementation. With a spec, pass spec_path and list its checkable requirements.",
			"`focus`: risk areas only, never hypotheses. Put your specific bug hypotheses in `suspicions`; they are hidden from reviewers and checked against what they find on their own.",
			"`context_files` are repo paths reviewers should read in full (callers, types, tests) — not files already whole in the diff.",
			"`checks` are up to 4 fast commands (type-check, targeted tests) run once in a sandbox (repo read-only, no network) before the review; reviewers see their output. C/C++ changes are compile-checked automatically.",
			"Set verify=true for high-stakes changes (independent cross-check of every finding); quick=true for small diffs or a cheap first look.",
			"For a PR that already has review comments (CodeRabbit, collaborators), set pr_comments=true to triage them: each is verified and you report valid/invalid per comment plus new issues, and draft replies to a local file. Never post to GitHub.",
			"After results return, follow the lead-judgment instructions in the result. Do not apply fixes unless asked.",
		],
		parameters: Type.Object({
			intent: Type.Optional(Type.String({
				description: "One paragraph: what the change is supposed to accomplish and which constraints matter.",
				maxLength: 4000,
			})),
			spec_path: Type.Optional(Type.String({
				description: "Repo-relative path to a spec/design doc. Passed verbatim to reviewers as the source of truth.",
			})),
			requirements: Type.Optional(Type.Array(Type.String({ maxLength: 600 }), {
				description: "Concrete, checkable requirements (usually from the spec) reviewers must verify one by one.",
				maxItems: 40,
			})),
			suspicions: Type.Optional(Type.Array(Type.String({ maxLength: 600 }), {
				description:
					"Your own hypotheses about possible bugs. NOT shown to reviewers (they'd anchor on them); checked against " +
					"what reviewers find independently and, with verify, cross-checked by verifiers.",
				maxItems: 20,
			})),
			context_files: Type.Optional(Type.Array(Type.String(), {
				description: "Repo-relative paths reviewers should see in full beyond the diff (callers, types, tests). Max 12.",
				maxItems: 12,
			})),
			checks: Type.Optional(Type.Array(Type.String(), {
				description: "Up to 4 fast shell commands that type-check or run the tests covering the change (e.g. \"npx tsc --noEmit\", \"python3 -m pytest -q -p no:cacheprovider tests/test_x.py\"). They run once, before the review, on the reviewed code in a sandbox (repo read-only, writable $TMPDIR, no network; 120s total by default), and reviewers see their output. Commands that write into the repo (in-tree builds) or download dependencies fail there. Changed C/C++ files get a compile + cppcheck check automatically. Never the full test suite.",
				maxItems: 4,
			})),
			scope: Type.Optional(StringEnum(["diff", "area"] as const, {
				description:
					"'diff' (default): the working-tree diff vs the default branch, or the PR when pr_number is set. " +
					"'area': no diff — review the part of the codebase described in `focus` (reviewers explore it with tools).",
			})),
			pr_number: Type.Optional(Type.Number({
				description: "PR number to review (e.g. 4321 from a GitHub PR URL). Omit to review the working-tree diff.",
				minimum: 0,
			})),
			focus: Type.Optional(Type.String({
				description:
					"Risk AREAS to scrutinize (not hypotheses — use `suspicions`), or, with scope='area', the area to review. " +
					"Examples: 'the token refresh path', 'config-file merge lifecycle'.",
				maxLength: 2000,
			})),
			verify: Type.Optional(Type.Boolean({
				description:
					"Cross-check round: each finding goes to reviewers who did NOT raise it, who confirm or refute it with " +
					"evidence. Roughly doubles cost; use for high-stakes changes or when false positives are expensive.",
			})),
			pr_comments: Type.Optional(Type.Boolean({
				description:
					"With pr_number: fetch the PR's existing review comments (CodeRabbit, collaborators), extract checkable claims, " +
					"and verify each (hidden from reviewers, matched against their independent findings). Do not copy those comments into the brief.",
			})),
			include_nits: Type.Optional(Type.Boolean({ description: "With pr_comments: also verify nitpick-level claims." })),
			include_resolved: Type.Optional(Type.Boolean({ description: "With pr_comments: also check resolved review threads." })),
			quick: Type.Optional(Type.Boolean({
				description: "Fast reviewer pool, single completions without tools. For small diffs or a cheap first look.",
			})),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const out = await runAgentLedReview(pi, ctx, params, signal, onUpdate);
			if ("error" in out) throw new Error(out.error);
			return {
				content: [{ type: "text", text: out.text }],
				details: { ...out.details, markdown: out.markdown },
			};
		},
		renderResult(result, options, theme) {
			const details = result.details as MultiReviewDetails | undefined;
			if (options.isPartial || !details?.groups) {
				const text = result.content.find((c) => c.type === "text");
				return new Text(theme.fg("dim", text && "text" in text ? text.text : "multi-review running…"), 0, 0);
			}
			return renderMultiReviewMessage(
				{ content: details.markdown ?? "", details },
				{ expanded: options.expanded },
				theme as unknown as Parameters<typeof renderMultiReviewMessage>[2],
				undefined,
			) as ReturnType<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]>>;
		},
	});
}
