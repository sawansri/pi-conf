/**
 * TDD Pipeline — stateful extension
 *
 * Drives the plan → tests → green → verify loop with model switching,
 * phase injection, and explicit manual override at every boundary.
 *
 * Design + how-it-works: ../README.md
 * Install steps:           ../install.md
 *
 * Commands registered:
 *   /build <feature> [--autonomous]
 *                         start pipeline (--autonomous flips auto-advance on)
 *   /build-status          show current phase + model + next action
 *   /build-next            force advance to next phase
 *   /build-continue [..]   re-inject current phase prompt (no transition)
 *   /build-pause           stop auto-advancing; stay in current phase
 *   /build-autonomous      toggle auto-advance for the current build
 *   /build-rewind          tree-navigate back to where current phase started
 *   /build-reset           clear pipeline state
 *   /build-model <id>      override model for the current phase
 *   /build-models <spec>…  set model+thinking for one or more phases atomically
 *
 * Persistent defaults: reads $PI_CODING_AGENT_DIR/tdd-pipeline.json on
 * first defaultState() call (cached for the lifetime of the extension).
 * Drop in any of: plannerModel, plannerThinking, testerModel, testerThinking,
 * implementerModel, implementerThinking. Unknown fields are ignored. Bad
 * JSON or missing file falls back to in-code defaults silently.
 *
 * Tree integration: each phase transition snapshots the entry ID it landed at
 * (`state.phaseAnchorEntryId`). `/build-rewind` uses pi's native
 * `ctx.navigateTree()` to rewind the conversation to that exact entry,
 * generating a summary of the abandoned branch so you can revisit via /tree.
 * After a rewind, `/build-continue` re-injects the phase prompt without
 * re-entering from the previous phase.
 *
 * Tree integration: each phase transition snapshots the entry ID it landed at
 * (`state.phaseAnchorEntryId`). `/build-rewind` uses pi's native
 * `ctx.navigateTree()` to rewind the conversation to that exact entry,
 * generating a summary of the abandoned branch so you can revisit via /tree.
 * After a rewind, `/build-continue` re-injects the phase prompt without
 * re-entering from the previous phase.
 *
 * Phase completion detectors (auto-advance when satisfied):
 *   plan      → grill-me session entry has output phase approved
 *   test      → last assistant message contains "Test Command:"
 *   implement → last assistant message contains "Status: Green"
 *
 * Auto-advance is OFF by default (state.autonomous = false). When off,
 * firing detectors notify the user that a phase looks complete and the
 * user invokes /build-next (or /build-continue / /build-rewind) to act.
 * Default is manual because phase boundaries are exactly the right place
 * for human clarification or scope correction.
 *
 * Any user message you send during the pipeline is naturally absorbed —
 * pi routes it as steer/followUp, and the next agent_end only auto-advances
 * when the assistant's *current* response is conclusive AND the build is
 * flagged autonomous.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

const STATE_ENTRY = "tdd-pipeline-state";
const STATUS_KEY = "tdd-pipeline";

type Phase = "idle" | "plan" | "test" | "implement" | "verify";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface PipelineState {
	phase: Phase;
	feature: string;
	paused: boolean;
	// autonomous=false: completion detectors notify but do not change state.
	//                      User advances manually with /build-next.
	// autonomous=true:  completion detectors call attemptAdvance(...,"auto")
	//                      and the pipeline progresses without intervention.
	autonomous: boolean;
	plannerModel: string;
	plannerThinking: ThinkingLevel;
	testerModel: string;
	testerThinking: ThinkingLevel;
	implementerModel: string;
	implementerThinking: ThinkingLevel;
	startedAt: number;
	updatedAt: number;
	log: Array<{ at: number; from: Phase | "idle"; to: Phase; reason: string }>;
	// Recorded at every phase transition, used by /build-continue and
	// /build-rewind. Absent on phase=idle and on builds that started before
	// this version of the extension.
	currentPhasePrompt?: string;
	phaseAnchorEntryId?: string;
}

function defaultState(): PipelineState {
	return {
		phase: "idle",
		feature: "",
		paused: false,
		// Default is manual: completion detectors notify but do not advance.
		// Flip to true (via --autonomous flag on /build, /build-autonomous
		// toggle, or "autonomous": true in tdd-pipeline.json) when you want
		// the pipeline to progress without intervention.
		autonomous: false,
		// ChatGPT Plus / Codex providers — OAuth via /login openai-codex.
		// If pi's bundled registry predates your target model, add it to
		// ~/.pi/agent/models.json under provider "openai-codex" with the
		// drop-in snippet from README.md → "Adding newer Codex models".
		plannerModel: "openai-codex/gpt-5.5",
		plannerThinking: "high",
		testerModel: "openai-codex/gpt-5.4-mini",
		testerThinking: "medium",
		implementerModel: "fireworks/accounts/fireworks/models/deepseek-v4-pro",
		implementerThinking: "xhigh",
		startedAt: 0,
		updatedAt: 0,
		log: [],
		...loadDefaults(),
	};
}

// Read $PI_CODING_AGENT_DIR/tdd-pipeline.json once. Unknown / wrong-type
// fields are dropped silently so a malformed file never breaks the pipeline.
let cachedDefaults: Partial<PipelineState> | null = null;
function loadDefaults(): Partial<PipelineState> {
	if (cachedDefaults !== null) return cachedDefaults;
	cachedDefaults = {};
	try {
		const configPath = path.join(getAgentDir(), "tdd-pipeline.json");
		if (!fs.existsSync(configPath)) return cachedDefaults;
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
		if (parsed && typeof parsed === "object") {
			const thinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
			const models: Array<keyof PipelineState> = [
				"plannerModel",
				"testerModel",
				"implementerModel",
			];
			const thinking: Array<keyof PipelineState> = [
				"plannerThinking",
				"testerThinking",
				"implementerThinking",
			];
			for (const k of models) {
				if (typeof parsed[k] === "string" && parsed[k].includes("/")) {
					(cachedDefaults as any)[k] = parsed[k];
				}
			}
			for (const k of thinking) {
				if (typeof parsed[k] === "string" && thinkingLevels.includes(parsed[k] as ThinkingLevel)) {
					(cachedDefaults as any)[k] = parsed[k];
				}
			}
			if (typeof parsed.autonomous === "boolean") {
				cachedDefaults.autonomous = parsed.autonomous;
			}
		}
	} catch {
		// Bad JSON or IO error — fall back to in-code defaults.
		cachedDefaults = {};
	}
	return cachedDefaults;
}

interface TransitionPlan {
	toPhase: Phase;
	model: string;
	thinking: ThinkingLevel;
	prompt: string;
	reason: string;
}

function transitionPlanFor(state: PipelineState): {
	plan: TransitionPlan | null;
	why: string;
} {
	if (state.paused) return { plan: null, why: "pipeline is paused — hit /build-next to resume" };
	if (state.phase === "idle") return { plan: null, why: "no active build — /build <feature> to start" };

	if (state.phase === "plan") {
		const next: TransitionPlan = {
			toPhase: "test",
			model: state.testerModel,
			thinking: state.testerThinking,
			prompt:
				"You are the test author for an approved feature plan. " +
				"Role: write a scope-locked set of FAILING tests. Do NOT write implementation code. " +
				"Use the project's existing test runner — detect it (package.json scripts, pytest config, " +
				"Cargo.toml test section, go.mod, etc.) and use it. " +
				"\n\nFeature: " +
				state.feature +
				"\n\nThe approved grill-me checkpoint is in your earlier conversation context. " +
				"Scope your tests strictly to the behaviors the user approved. " +
				"\n\nFinal response MUST include a clearly marked line 'Test Command: <exact command>' " +
				"that runs ONLY your new tests. List expected failures per file. " +
				"Stop after writing tests — the implementer phase will take it from here.",
			reason: "plan approved",
		};
		return { plan: next, why: "auto-advancing plan → test" };
	}

	if (state.phase === "test") {
		const next: TransitionPlan = {
			toPhase: "implement",
			model: state.implementerModel,
			thinking: state.implementerThinking,
			prompt:
				"You are the TDD green step for an approved feature plan. " +
				"Iterate until all tests pass — write code, run the test command, parse failures, " +
				"edit code, re-run. Loop with minimal edits. " +
				"\n\nFeature: " +
				state.feature +
				"\n\nThe test command (from the previous phase) is in conversation context. " +
				"Read the failing tests, implement smallest-diff production code, re-run. " +
				"\n\nHard rules: never disable/skip/delete a test; never widen the test command to " +
				"unrelated suites; never install network deps without surfacing it; never commit/push. " +
				"If 8 consecutive edits show no progress, STOP and report the blocker concretely. " +
				"\n\nWhen fully green your final response MUST include the line " +
				"'Status: Green' followed by a one-line summary and the changed files list. " +
				"If blocked, final response must include 'Status: Blocked' and the blocker.",
			reason: "tests authored",
		};
		return { plan: next, why: "auto-advancing test → implement" };
	}

	if (state.phase === "implement") {
		return {
			plan: {
				toPhase: "verify",
				model: state.testerModel, // back to a familiar model for the review summary
				thinking: state.testerThinking,
				prompt:
					"Implementation is reportedly green. Verify by hand:\n\n" +
					"1. Run the test command from the test phase.\n" +
					"2. Show a `git diff --stat` of changed files.\n" +
					"3. List any wider-suite regressions if you ran `npm test` / `pytest` / etc.\n" +
					"4. Summarize what was built, where it lives, and any risks.\n\n" +
					"Do NOT modify production code during this verify step — only investigate.",
				reason: "implementation reported green",
			},
			why: "auto-advancing implement → verify",
		};
	}

	return { plan: null, why: "verify is the human checkpoint — review and /build-reset when done" };
}

// ---------- state persistence ----------

function loadState(ctx: ExtensionContext): PipelineState | null {
	// Scan from end backwards — we always want the LATEST state entry,
	// since each save appends a new one rather than mutating in place.
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as any;
		if (entry?.type === "custom" && entry?.customType === STATE_ENTRY && entry.data) {
			return entry.data as PipelineState;
		}
	}
	return null;
}

function saveState(state: PipelineState, pi: ExtensionAPI) {
	pi.appendEntry(STATE_ENTRY, state);
}

// Capture the ID of the latest *message* entry (not custom entries). This is
// the entry that existed just before we transitioned — it's the safe anchor
// for tree rewinds. We use the LAST message entry, which is the most recent
// assistant or user message visible before our transition.
function snapshotAnchor(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e: any = entries[i];
		if (e?.type === "message" && e?.id) return e.id;
	}
	return undefined;
}

// ---------- /build-models parser ----------

interface ParsedBuildModel {
	phase: Phase;
	model: string;
	thinking?: string;
}

function parseBuildModelsTokens(tokens: string[]): ParsedBuildModel[] {
	const phaseAliases: Record<string, Phase> = {
		plan: "plan",
		planner: "plan",
		test: "test",
		tester: "test",
		implement: "implement",
		impl: "implement",
		implementer: "implement",
	};
	const out: ParsedBuildModel[] = [];
	for (const token of tokens) {
		const eq = token.indexOf("=");
		if (eq === -1) continue;
		const phaseKey = token.slice(0, eq).trim().toLowerCase();
		if (!(phaseKey in phaseAliases)) continue;
		const phase = phaseAliases[phaseKey];
		const spec = token.slice(eq + 1).trim();
		const atIdx = spec.lastIndexOf("@");
		let model: string;
		let thinking: string | undefined;
		if (atIdx > 0) {
			model = spec.slice(0, atIdx).trim();
			thinking = spec.slice(atIdx + 1).trim();
		} else {
			model = spec;
		}
		out.push({ phase, model, thinking });
	}
	return out;
}

// ---------- completion detectors ----------

function getLatestAssistantText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as any;
		if (e?.type === "message" && e?.message?.role === "assistant") {
			const msg = e.message;
			if (typeof msg.content === "string") return msg.content;
			if (Array.isArray(msg.content)) {
				return msg.content
					.filter((p: any) => p.type === "text")
					.map((p: any) => p.text)
					.join("\n");
			}
		}
	}
	return "";
}

function isPlanApprovedByGrillMe(ctx: ExtensionContext): boolean {
	// Grill-me writes session entries with customType "grill-me-state"
	// Look at the latest such entry: phase "output" + an approvedOutputPlan field
	// means the user has approved an output set.
	const entries = ctx.sessionManager.getEntries();
	let latest: any | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as any;
		if (e?.type === "custom" && e?.customType === "grill-me-state") {
			latest = e.data;
			break;
		}
	}
	if (!latest) return false;
	return Boolean(
		latest.outputPhase === true || (latest.phase === "output" && latest.approvedOutputPlan),
	);
}

function isTestAuthored(ctx: ExtensionContext): boolean {
	const text = getLatestAssistantText(ctx);
	return /Test Command:\s*\S+/i.test(text) || /## Test Command\b/.test(text);
}

function isImplementationGreen(ctx: ExtensionContext): boolean {
	const text = getLatestAssistantText(ctx);
	return /\bStatus:\s*Green\b/.test(text);
}

// ---------- model switching ----------

function findModel(ctx: ExtensionContext, modelSpec: string) {
	const [provider, ...rest] = modelSpec.split("/");
	const id = rest.join("/");
	return ctx.modelRegistry.find(provider, id);
}

async function applyModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	modelSpec: string,
	thinking: string,
) {
	const model = findModel(ctx, modelSpec);
	if (!model) {
		ctx.ui.notify(`Model not found: ${modelSpec}`, "error");
		return false;
	}
	const ok = await pi.setModel(model);
	if (!ok) {
		ctx.ui.notify(`No API key for ${modelSpec}`, "error");
		return false;
	}
	pi.setThinkingLevel(thinking as any);
	return true;
}

// ---------- status widget ----------

function setStatusWidget(state: PipelineState, ctx: ExtensionContext) {
	const phaseLabel = state.phase.charAt(0).toUpperCase() + state.phase.slice(1);
	const flag = state.paused
		? " (paused)"
		: state.autonomous
			? " (auto)"
			: " (manual)";
	const modelForPhase =
		state.phase === "plan"
			? state.plannerModel
			: state.phase === "test"
				? state.testerModel
				: state.phase === "implement"
					? state.implementerModel
					: "—";
	ctx.ui.setStatus(STATUS_KEY, `build:${phaseLabel}${flag} · ${modelForPhase}`);
}

function logTransition(state: PipelineState, to: Phase, reason: string) {
	state.log.push({ at: Date.now(), from: state.phase, to, reason });
	state.phase = to;
	state.updatedAt = Date.now();
}

// ---------- extension entry point ----------

export default function (pi: ExtensionAPI) {
	// Boot display on session start
	pi.on("session_start", async (_event, ctx) => {
		const state = loadState(ctx);
		if (state && state.phase !== "idle") {
			setStatusWidget(state, ctx);
			ctx.ui.notify(`Resumed build (phase=${state.phase}, paused=${state.paused})`, "info");
		}
	});

	// Phase completion detector on every turn end. Two outcomes:
	//   state.autonomous === true  → attempt advance, fire next phase prompt.
	//   state.autonomous === false → notify the user that the phase looks
	//                                 done; user reviews and hits /build-next.
	// In both cases the user can intervene with /build-continue / /build-rewind
	// at any time, regardless of automation mode.
	pi.on("agent_end", async (_event, ctx) => {
		const state = loadState(ctx);
		if (!state || state.phase === "idle" || state.paused) return;
		if (state.phase === "verify") return; // verify is terminal

		let satisified = false;
		if (state.phase === "plan") satisified = isPlanApprovedByGrillMe(ctx);
		else if (state.phase === "test") satisified = isTestAuthored(ctx);
		else if (state.phase === "implement") satisified = isImplementationGreen(ctx);

		if (!satisified) return;

		if (state.autonomous) {
			await attemptAdvance(state, ctx, "auto");
		} else {
			// Manual mode: surface a hint without changing state.
			const hint =
				state.phase === "plan"
					? "Plan looks approved by grill-me."
					: state.phase === "test"
						? "Tests have been authored."
						: "Implementation reports green.";
			ctx.ui.notify(
				`${hint} Phase ${state.phase} → ${nextPhaseLabel(state.phase)} boundary — /build-next to advance (or /build-continue "…" to push, /build-rewind to retry).`,
				"info",
			);
		}
	});

	function nextPhaseLabel(current: Phase): Phase | "verify" {
		if (current === "plan") return "test";
		if (current === "test") return "implement";
		if (current === "implement") return "verify";
		return current;
	}

	// Cancel auto-advance if user submits input mid-pipeline.
	// We don't actually need to do anything special here — pi handles steer/
	// followUp naturally, and the next agent_end only auto-advances when the
	// assistant response itself satisfies a completion predicate. This handler
	// is a placeholder so future "pause on user activity" logic has a hook.
	pi.on("input" as any, async (_event: unknown, ctx: ExtensionContext) => {
		const state = loadState(ctx);
		if (!state || state.phase === "idle") return;
		// Reserved for future pause-on-typing behaviour.
	});

	// ---------- commands ----------

	pi.registerCommand("build", {
		description: "Start TDD pipeline: <feature request> [--autonomous] → grill-me plan → tests → green loop → verify",
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify(
					"Usage: /build <feature request> [--autonomous]\n" +
						"--autonomous flips auto-advance ON for this build (default OFF).",
					"error",
				);
				return;
			}
			// Parse --autonomous flag (lab-mixed is fine: --AUTONOMOUS works too).
			const wantsAutonomous = /(^|\s)--autonomous(\s|$)/i.test(raw);
			const feature = raw
				.replace(/(^|\s)--autonomous(\s|$)/gi, "$1$2")
				.replace(/\s+/g, " ")
				.trim();

			const existing = loadState(ctx);
			if (existing && existing.phase !== "idle") {
				const ok = await ctx.ui.confirm(
					"Replace active build?",
					`A build is already in phase '${existing.phase}' for: ${existing.feature.slice(0, 80)}…\n` +
						`Reset and start a new one?`,
				);
				if (!ok) return;
			}

			const state = defaultState();
			state.feature = feature;
			state.phase = "plan";
			state.startedAt = Date.now();
			state.updatedAt = Date.now();
			state.currentPhasePrompt = `/grill ${feature}`;
			// --autonomous flag overrides the (typically false) JSON default.
			if (wantsAutonomous) state.autonomous = true;
			saveState(state, pi);
			state.phaseAnchorEntryId = snapshotAnchor(ctx);
			saveState(state, pi);
			setStatusWidget(state, ctx);

			// Enter plan phase
			const ok = await applyModel(pi, ctx, state.plannerModel, state.plannerThinking);
			if (!ok) {
				ctx.ui.notify("Pipeline cannot start: model switch failed", "error");
				return;
			}

			pi.sendUserMessage(`/grill ${feature}`);
		},
	});

	pi.registerCommand("build-status", {
		description: "Show TDD pipeline state",
		handler: async (_args, ctx) => {
			const state = loadState(ctx);
			if (!state || state.phase === "idle") {
				ctx.ui.notify("No active build. Use /build <feature> to start.", "info");
				return;
			}
			const lines = [
				`Phase:        ${state.phase}${state.paused ? " (paused)" : ""}${state.autonomous ? " (auto)" : " (manual)"}`,
				`Feature:      ${state.feature}`,
				`Started:      ${new Date(state.startedAt).toISOString()}`,
				`Updated:      ${new Date(state.updatedAt).toISOString()}`,
				`Planner:      ${state.plannerModel} @ ${state.plannerThinking}`,
				`Tester:       ${state.testerModel} @ ${state.testerThinking}`,
				`Implementer:  ${state.implementerModel} @ ${state.implementerThinking}`,
				`Transitions:  ${state.log.length}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("build-next", {
		description: "Advance the TDD pipeline to the next phase",
		handler: async (_args, ctx) => {
			const state = loadState(ctx);
			if (!state || state.phase === "idle") {
				ctx.ui.notify("No active build.", "info");
				return;
			}
			await attemptAdvance(state, ctx, "manual");
		},
	});

	pi.registerCommand("build-continue", {
		description: "Re-inject current phase prompt; [optional nudge] appended. No transition.",
		handler: async (args, ctx) => {
			const state = loadState(ctx);
			if (!state || state.phase === "idle") {
				ctx.ui.notify("No active build.", "info");
				return;
			}
			if (state.phase === "verify") {
				ctx.ui.notify("Verify is a human checkpoint; nothing to continue.", "info");
				return;
			}
			if (!state.currentPhasePrompt) {
				ctx.ui.notify(
					"No recorded prompt for this phase (build started before /build-continue existed). " +
						"Use /build-next to advance or /tree to navigate manually.",
					"error",
				);
				return;
			}
			if (state.paused) {
				state.paused = false;
				state.updatedAt = Date.now();
				saveState(state, pi);
				setStatusWidget(state, ctx);
			}
			const nudge = args.trim();
			const toSend = nudge
				? state.currentPhasePrompt + "\n\nUser nudge: " + nudge
				: state.currentPhasePrompt;
			pi.sendUserMessage(toSend, { deliverAs: "followUp" });
			ctx.ui.notify(
				nudge ? `Re-injected ${state.phase} prompt with nudge` : `Re-injected ${state.phase} prompt`,
				"info",
			);
		},
	});

	pi.registerCommand("build-rewind", {
		description: "Tree-navigate back to where the current phase started",
		handler: async (_args, ctx) => {
			const state = loadState(ctx);
			if (!state || state.phase === "idle") {
				ctx.ui.notify("No active build.", "info");
				return;
			}
			if (!state.phaseAnchorEntryId) {
				ctx.ui.notify(
					"No tree anchor recorded (build started before /build-rewind existed). " +
						"Use /tree directly to navigate manually.",
					"error",
				);
				return;
			}
			const ok = await ctx.ui.confirm(
				"Rewind current phase?",
				`This rolls the session tree back to where the ${state.phase} phase started. ` +
					`Everything ${state.phase} produced will be summarized into a single branch entry ` +
					`(visible via /tree). Pipeline state itself is unchanged — after the rewind, ` +
					`/build-continue will re-inject the ${state.phase} prompt.`,
			);
			if (!ok) return;
			const result = await ctx.navigateTree(state.phaseAnchorEntryId, {
				summarize: true,
				label: `rewind-${state.phase}`,
			});
			if (result.cancelled) {
				ctx.ui.notify("Rewind cancelled.", "info");
				return;
			}
			ctx.ui.notify(
				`Rewound to start of ${state.phase}. Summary recorded. /build-status to confirm.`,
				"info",
			);
		},
	});

	pi.registerCommand("build-pause", {
		description: "Pause auto-advance; stay in current phase until /build-next",
		handler: async (_args, ctx) => {
			const state = loadState(ctx);
			if (!state || state.phase === "idle") return;
			state.paused = true;
			state.updatedAt = Date.now();
			saveState(state, pi);
			setStatusWidget(state, ctx);
			ctx.ui.notify(`Pipeline paused at phase=${state.phase}. /build-next to advance.`, "info");
		},
	});

	pi.registerCommand("build-autonomous", {
		description: "Toggle auto-advance for the current build (default is manual)",
		handler: async (_args, ctx) => {
			const state = loadState(ctx);
			if (!state || state.phase === "idle") {
				ctx.ui.notify("No active build.", "info");
				return;
			}
			state.autonomous = !state.autonomous;
			state.updatedAt = Date.now();
			saveState(state, pi);
			setStatusWidget(state, ctx);
			ctx.ui.notify(
				state.autonomous
					? "Auto-advance ENABLED. Phase completion detectors will progress the build autonomously."
					: "Auto-advance DISABLED. Completion detectors will notify only — you drive via /build-next.",
				"info",
			);
		},
	});

	pi.registerCommand("build-reset", {
		description: "Clear TDD pipeline state",
		handler: async (_args, ctx) => {
			pi.appendEntry(STATE_ENTRY, defaultState()); // overwrites previous state
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.notify("Build state cleared. /build <feature> to start fresh.", "info");
		},
	});

	pi.registerCommand("build-model", {
		description: "Override model for current phase: <provider>/<model-id>",
		handler: async (args, ctx) => {
			const state = loadState(ctx);
			if (!state || state.phase === "idle") {
				ctx.ui.notify("No active build.", "info");
				return;
			}
			const spec = args.trim();
			if (!spec || !spec.includes("/")) {
				ctx.ui.notify("Usage: /build-model <provider>/<model-id>", "error");
				return;
			}
			if (state.phase === "plan") state.plannerModel = spec;
			else if (state.phase === "test") state.testerModel = spec;
			else if (state.phase === "implement") state.implementerModel = spec;
			else {
				ctx.ui.notify("Cannot change model in verify phase", "info");
				return;
			}
			state.updatedAt = Date.now();
			saveState(state, pi);
			const ok = await applyModel(pi, ctx, spec, currentThinkingFor(state));
			if (!ok) ctx.ui.notify("Model not applied — fix spec and retry", "error");
			setStatusWidget(state, ctx);
		},
	});

	pi.registerCommand("build-models", {
		description: "Set model+thinking for one or more phases: planner=X@y tester=X@y impl=X@y (atomic)",
		handler: async (args, ctx) => {
			const state = loadState(ctx);
			if (!state || state.phase === "idle") {
				ctx.ui.notify("No active build. /build <feature> first.", "info");
				return;
			}
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const parsed = parseBuildModelsTokens(tokens);
			if (parsed.length === 0) {
				ctx.ui.notify(
					"Usage: /build-models planner=<provider>/<model>[@thinking] " +
						"tester=<provider>/<model>[@thinking] impl=<provider>/<model>[@thinking]\n" +
						"Phase aliases: planner|plan, tester|test, impl|implement|implementer\n" +
						"Example: /build-models impl=fireworks/accounts/fireworks/models/glm-5p2@xhigh",
					"error",
				);
				return;
			}

			// Validate ALL specs first. If anything is wrong, refuse to commit
			// (atomic semantics: never half-apply).
			const thinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
			const errors: string[] = [];
			const verified: ParsedBuildModel[] = [];
			for (const spec of parsed) {
				if (!spec.model.includes("/")) {
					errors.push(`phase=${spec.phase}: model "${spec.model}" missing provider/id separator`);
					continue;
				}
				const parts = spec.model.split("/");
				const provider = parts[0];
				const id = parts.slice(1).join("/");
				const found = ctx.modelRegistry.find(provider, id);
				if (!found) {
					errors.push(`phase=${spec.phase}: unknown model "${spec.model}"`);
					continue;
				}
				if (spec.thinking && !thinkingLevels.includes(spec.thinking as ThinkingLevel)) {
					errors.push(`phase=${spec.phase}: invalid thinking "${spec.thinking}" (allowed: ${thinkingLevels.join(", ")})`);
					continue;
				}
				verified.push(spec);
			}
			if (errors.length > 0) {
				ctx.ui.notify(
					`/build-models aborted; no changes committed. Errors:\n${errors.join("\n")}`,
					"error",
				);
				return;
			}

			// Commit atomically.
			const phaseLabel: Record<Phase, string> = {
				plan: "planner",
				test: "tester",
				implement: "impl",
				verify: "verify",
				idle: "idle",
			};
			const applied: string[] = [];
			for (const spec of verified) {
				if (spec.phase === "plan") {
					state.plannerModel = spec.model;
					if (spec.thinking) state.plannerThinking = spec.thinking as ThinkingLevel;
				} else if (spec.phase === "test") {
					state.testerModel = spec.model;
					if (spec.thinking) state.testerThinking = spec.thinking as ThinkingLevel;
				} else if (spec.phase === "implement") {
					state.implementerModel = spec.model;
					if (spec.thinking) state.implementerThinking = spec.thinking as ThinkingLevel;
				}
				applied.push(
					`${phaseLabel[spec.phase]}=${spec.model}${spec.thinking ? "@" + spec.thinking : ""}`,
				);
			}
			state.updatedAt = Date.now();
			saveState(state, pi);
			setStatusWidget(state, ctx);
			ctx.ui.notify(`/build-models applied:\n${applied.join("\n")}\n\nTip: /build-models also reads $PI_CODING_AGENT_DIR/tdd-pipeline.json.`, "info");
		},
	});

	// ---------- core advance ----------

	async function attemptAdvance(state: PipelineState, ctx: ExtensionContext, trigger: "auto" | "manual") {
		const { plan, why } = transitionPlanFor(state);
		if (!plan) {
			if (trigger === "manual") ctx.ui.notify(`Cannot advance: ${why}`, "info");
			return;
		}
		const from = state.phase;
		logTransition(state, plan.toPhase, plan.reason);
		state.currentPhasePrompt = plan.prompt;
		saveState(state, pi);
		setStatusWidget(state, ctx);

		const ok = await applyModel(pi, ctx, plan.model, plan.thinking as string);
		if (!ok) {
			ctx.ui.notify(`Phase advance halted: could not switch to ${plan.model}`, "error");
			return;
		}

		// Snapshot the latest message entry BEFORE we inject the next prompt.
		// That entry is the safe tree anchor for `/build-rewind`: rewinding
		// to it puts the session exactly where this phase began.
		state.phaseAnchorEntryId = snapshotAnchor(ctx);
		saveState(state, pi);

		if (trigger === "auto") ctx.ui.notify(`auto: ${from} → ${plan.toPhase}`, "info");
		pi.sendUserMessage(plan.prompt, { deliverAs: "followUp" });
	}

	function currentThinkingFor(state: PipelineState): string {
		if (state.phase === "plan") return state.plannerThinking;
		if (state.phase === "test") return state.testerThinking;
		if (state.phase === "implement") return state.implementerThinking;
		return "off";
	}
}
