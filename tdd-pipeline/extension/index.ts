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
 *   /build <feature>       start pipeline
 *   /build-status          show current phase + model + next action
 *   /build-next            force advance to next phase
 *   /build-pause           stop auto-advancing; stay in current phase
 *   /build-reset           clear pipeline state
 *   /build-model <id>      override model for the current phase
 *
 * Phase completion detectors (auto-advance when satisfied):
 *   plan      → grill-me session entry has output phase approved
 *   test      → last assistant message contains "Test Command:"
 *   implement → last assistant message contains "Status: Green"
 *
 * Any user message you send during the pipeline is naturally absorbed —
 * pi routes it as steer/followUp, and the next agent_end only auto-advances
 * when the assistant's *current* response is conclusive.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATE_ENTRY = "tdd-pipeline-state";
const STATUS_KEY = "tdd-pipeline";

type Phase = "idle" | "plan" | "test" | "implement" | "verify";

interface PipelineState {
	phase: Phase;
	feature: string;
	paused: boolean;
	plannerModel: string;
	plannerThinking: "high" | "xhigh";
	testerModel: string;
	testerThinking: "medium" | "high";
	implementerModel: string;
	implementerThinking: "high" | "xhigh";
	startedAt: number;
	updatedAt: number;
	log: Array<{ at: number; from: Phase | "idle"; to: Phase; reason: string }>;
}

function defaultState(): PipelineState {
	return {
		phase: "idle",
		feature: "",
		paused: false,
		plannerModel: "openai/gpt-5.5",
		plannerThinking: "high",
		testerModel: "openai/gpt-5.5",
		testerThinking: "medium",
		implementerModel: "fireworks/accounts/fireworks/models/deepseek-v4-pro",
		implementerThinking: "xhigh",
		startedAt: 0,
		updatedAt: 0,
		log: [],
	};
}

interface TransitionPlan {
	toPhase: Phase;
	model: string;
	thinking: PipelineState["plannerThinking"] | PipelineState["testerThinking"] | PipelineState["implementerThinking"];
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
	const flag = state.paused ? " (paused)" : "";
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

	// Auto-advance detector on every turn end
	pi.on("agent_end", async (_event, ctx) => {
		const state = loadState(ctx);
		if (!state || state.phase === "idle" || state.paused) return;
		if (state.phase === "verify") return; // verify is terminal

		let satisified = false;
		if (state.phase === "plan") satisified = isPlanApprovedByGrillMe(ctx);
		else if (state.phase === "test") satisified = isTestAuthored(ctx);
		else if (state.phase === "implement") satisified = isImplementationGreen(ctx);

		if (!satisified) return;

		await attemptAdvance(state, ctx, "auto");
	});

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
		description: "Start TDD pipeline: grill-me plan → scoped tests → fireworks green loop → verify",
		argumentHint: "<feature request>",
		handler: async (args, ctx) => {
			const feature = args.trim();
			if (!feature) {
				ctx.ui.notify("Usage: /build <feature request>", "error");
				return;
			}
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
			saveState(state, pi);
			setStatusWidget(state, ctx);

			// Enter plan phase
			const ok = await applyModel(pi, ctx, state.plannerModel, state.plannerThinking);
			if (!ok) {
				ctx.ui.notify("Pipeline cannot start: model switch failed", "error");
				return;
			}

			// Quote-wrap so /grill sees the whole feature in one go
			const quoted = feature.includes("\n") ? feature : feature;
			pi.sendUserMessage(`/grill ${quoted}`);
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
				`Phase:        ${state.phase}${state.paused ? " (paused)" : ""}`,
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

	pi.registerCommand("build-reset", {
		description: "Clear TDD pipeline state",
		handler: async (_args, ctx) => {
			pi.appendEntry(STATE_ENTRY, defaultState()); // overwrites previous state
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.notify("Build state cleared. /build <feature> to start fresh.", "info");
		},
	});

	pi.registerCommand("build-model", {
		description: "Override model for the current build phase",
		argumentHint: "<provider/model-id>",
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

	// ---------- core advance ----------

	async function attemptAdvance(state: PipelineState, ctx: ExtensionContext, trigger: "auto" | "manual") {
		const { plan, why } = transitionPlanFor(state);
		if (!plan) {
			if (trigger === "manual") ctx.ui.notify(`Cannot advance: ${why}`, "info");
			return;
		}
		const from = state.phase;
		logTransition(state, plan.toPhase, plan.reason);
		saveState(state, pi);
		setStatusWidget(state, ctx);

		const ok = await applyModel(pi, ctx, plan.model, plan.thinking as string);
		if (!ok) {
			ctx.ui.notify(`Phase advance halted: could not switch to ${plan.model}`, "error");
			return;
		}
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
