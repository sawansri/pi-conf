import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { type DeadlineWarning, HARVEST_MS, type HarvestableSession, type LateSession, StragglerCutoff, armSpendCap, armWarning, harvest, harvestPrompt, startDeadline, warningText } from "../src/deadline.ts";
import { shouldArmStragglerCutoff, stragglerQuorum } from "../src/reviewers.ts";

const MIN = 60_000;

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 }));
afterEach(() => mock.timers.reset());

function warnings(d: ReturnType<typeof startDeadline>): DeadlineWarning[] {
	const seen: DeadlineWarning[] = [];
	d.listen((w) => seen.push(w));
	return seen;
}

test("on its own: warned at 75% of the working time, cut a harvest before the timeout, ended at it", () => {
	const d = startDeadline(10 * MIN);
	const seen = warnings(d);
	// 75% of the 9 working minutes
	mock.timers.tick(6.75 * MIN - 1);
	assert.deepEqual(seen, []);
	mock.timers.tick(1);
	assert.deepEqual(seen, [{ secondsLeft: 135, why: "75% of your time is gone" }]);
	mock.timers.tick(9 * MIN - 6.75 * MIN);
	assert.equal(d.cut.aborted, true);
	assert.equal(d.cut.reason, "timed out after 600s");
	assert.equal(d.end.aborted, false);
	mock.timers.tick(HARVEST_MS);
	assert.equal(d.end.aborted, true);
	assert.equal(seen.length, 1);
});

test("a short timeout gives the harvest a fifth of it", () => {
	const d = startDeadline(100_000);
	mock.timers.tick(80_000);
	assert.equal(d.cut.aborted, true);
	assert.equal(d.end.aborted, false);
	mock.timers.tick(20_000);
	assert.equal(d.end.aborted, true);
});

test("the straggler cutoff warns at once with the pool's status and moves the cut", () => {
	const cutoff = new StragglerCutoff();
	const d = startDeadline(10 * MIN, cutoff);
	const seen = warnings(d);
	mock.timers.tick(2 * MIN);
	cutoff.arm(5 * MIN, "cut as straggler: 3/4 reviewers finished in 120s, waited 180s more", "3 of 4 reviewers have finished");
	assert.deepEqual(seen, [{ secondsLeft: 180, why: "3 of 4 reviewers have finished" }]);
	// The 75% mark later doesn't warn again.
	mock.timers.tick(3 * MIN);
	assert.equal(d.cut.aborted, true);
	assert.match(String(d.cut.reason), /^cut as straggler/);
	mock.timers.tick(HARVEST_MS - 1);
	assert.equal(d.end.aborted, false);
	mock.timers.tick(1);
	assert.equal(d.end.aborted, true);
	assert.equal(seen.length, 1);
});

test("whichever comes first: a cutoff after the session's own cut changes nothing", () => {
	const cutoff = new StragglerCutoff();
	const d = startDeadline(10 * MIN, cutoff);
	const seen = warnings(d);
	mock.timers.tick(7 * MIN);
	assert.equal(seen.length, 1);
	cutoff.arm(20 * MIN, "cut as straggler", "3 of 4 reviewers have finished");
	assert.equal(seen.length, 1);
	mock.timers.tick(2 * MIN);
	assert.equal(d.cut.reason, "timed out after 600s");
});

test("a session started after the cutoff passed is cut before it starts, unwarned", () => {
	const cutoff = new StragglerCutoff();
	cutoff.arm(MIN, "cut as straggler", "3 of 4 reviewers have finished");
	mock.timers.tick(2 * MIN);
	const d = startDeadline(10 * MIN, cutoff);
	assert.equal(d.cut.aborted, true);
	assert.deepEqual(warnings(d), []);
});

test("a warning due before anyone listens is delivered on listen", () => {
	const cutoff = new StragglerCutoff();
	cutoff.arm(3 * MIN, "cut as straggler", "3 of 4 reviewers have finished");
	const d = startDeadline(10 * MIN, cutoff);
	mock.timers.tick(MIN);
	assert.deepEqual(warnings(d), [{ secondsLeft: 120, why: "3 of 4 reviewers have finished" }]);
});

test("an error retry's new session is warned too, with the time left now", () => {
	const d = startDeadline(10 * MIN);
	const first = warnings(d);
	mock.timers.tick(7 * MIN);
	assert.equal(first.length, 1);
	const retry = warnings(d);
	assert.deepEqual(retry, [{ secondsLeft: 120, why: "75% of your time is gone" }]);
	assert.equal(first.length, 1);
});

test("without a session to harvest (a single completion), the cut is at the timeout", () => {
	const d = startDeadline(10 * MIN, undefined, { harvest: false });
	mock.timers.tick(10 * MIN - 1);
	assert.equal(d.cut.aborted, false);
	mock.timers.tick(1);
	assert.equal(d.cut.aborted, true);
});

test("dispose stops every timer", () => {
	const d = startDeadline(10 * MIN);
	const seen = warnings(d);
	d.dispose();
	mock.timers.tick(20 * MIN);
	assert.equal(d.cut.aborted, false);
	assert.deepEqual(seen, []);
});

test("the warning names what to skip", () => {
	const text = warningText({ secondsLeft: 90, why: "4 of 5 reviewers have finished" }, { items: ["a", "b", "c", "d"], done: 1 }, "Output ONLY the JSON.");
	assert.match(text, /4 of 5 reviewers have finished\. You have about 90s left/);
	assert.match(text, /Skip the rest of your plan: "c", "d"\./);
	assert.match(text, /Output ONLY the JSON\.$/);
	assert.doesNotMatch(warningText({ secondsLeft: 9, why: "x" }, { items: ["a"], done: 0 }, "F"), /Skip/);
});

// ---------- the session side ----------

function fakeSession(reply: string | (() => Promise<never>), answered = true) {
	const s = {
		tools: ["read", "grep", "progress"],
		messages: (answered ? [{ role: "user" }, { role: "assistant", content: [{ type: "text", text: "looking…" }] }] : []) as unknown[],
		prompts: [] as Array<{ text: string; tools: string[] }>,
		steers: [] as string[],
		aborts: 0,
		async prompt(text: string) {
			s.prompts.push({ text, tools: [...s.tools] });
			if (typeof reply !== "string") return reply();
			s.messages.push({ role: "user" }, { role: "assistant", content: [{ type: "text", text: reply }] });
		},
		async abort() { s.aborts++; },
		async waitForIdle() {},
		async steer(text: string) { s.steers.push(text); },
		cleared: 0,
		clearQueue() { s.cleared++; },
		listeners: new Set<(e: AgentSessionEvent) => void>(),
		subscribe(l: (e: AgentSessionEvent) => void) { s.listeners.add(l); return () => s.listeners.delete(l); },
		emit(type: string) { for (const l of s.listeners) l({ type } as AgentSessionEvent); },
		getActiveToolNames: () => [...s.tools],
		setActiveToolsByName(names: string[]) { s.tools = [...names]; },
	};
	return s satisfies HarvestableSession;
}

const lateFor = (deadline: ReturnType<typeof startDeadline>, userSignal?: AbortSignal): LateSession => ({ deadline, userSignal, finalFormat: "Output ONLY the JSON." });

test("the warning is steered in at the next tool call, with the plan, and the progress tool starts telling the time", () => {
	const d = startDeadline(10 * MIN);
	const s = fakeSession("[]");
	const progress: { plan: string[]; done: number; calls: number; secondsLeft?: () => number } = { plan: ["a", "b", "c"], done: 0, calls: 1 };
	const events: unknown[] = [];
	const unwarn = armWarning(s, lateFor(d), progress, (e) => events.push(e));
	assert.equal(progress.secondsLeft, undefined);
	mock.timers.tick(6.75 * MIN);
	assert.equal(progress.secondsLeft?.(), 135);
	assert.deepEqual(events, [{ type: "multi_review_deadline_warn", secondsLeft: 135, why: "75% of your time is gone" }]);
	// Mid-answer (no tool call): nothing steered, so the final answer isn't redone.
	s.emit("message_update");
	assert.deepEqual(s.steers, []);
	mock.timers.tick(15_000);
	s.emit("tool_execution_start");
	s.emit("tool_execution_start");
	assert.equal(s.steers.length, 1);
	assert.match(s.steers[0], /about 120s left/);
	assert.match(s.steers[0], /Skip the rest of your plan: "b", "c"/);
	unwarn();
	assert.equal(s.listeners.size, 0);
});

test("after the cut, the harvest asks once with tools off and gives them back", async () => {
	const d = startDeadline(10 * MIN);
	mock.timers.tick(9 * MIN);
	const s = fakeSession('[{"title":"x"}]');
	assert.equal(await harvest(s, lateFor(d)), '[{"title":"x"}]');
	assert.deepEqual(s.prompts, [{ text: harvestPrompt("Output ONLY the JSON."), tools: [] }]);
	assert.ok(s.aborts >= 1);
	assert.equal(s.cleared, 1);
	assert.deepEqual(s.tools, ["read", "grep", "progress"]);
});

test("the harvest answer is the harvest's own reply, never the stopped turn's last words", async () => {
	const d = startDeadline(10 * MIN);
	mock.timers.tick(9 * MIN);
	const s = fakeSession("");
	// the stopped turn's text lands while it settles; the harvest gets no reply
	s.waitForIdle = async () => { s.messages.push({ role: "assistant", content: [{ type: "text", text: "Let me check x[0]" }] }); };
	assert.equal(await harvest(s, lateFor(d)), undefined);
});

test("a harvest reply that ended in an error isn't an answer, whatever text it has", async () => {
	const d = startDeadline(10 * MIN);
	mock.timers.tick(9 * MIN);
	const s = fakeSession("");
	s.prompt = async (text: string) => {
		s.prompts.push({ text, tools: [...s.tools] });
		s.messages.push({ role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: content_filter", content: [{ type: "text", text: "[]" }] });
	};
	assert.equal(await harvest(s, lateFor(d)), undefined);
});

test("a turn that never started (a Socratic round cut before it began) isn't harvested from earlier rounds", async () => {
	const d = startDeadline(10 * MIN);
	mock.timers.tick(9 * MIN);
	const s = fakeSession("an answer from round 1's context");
	assert.equal(await harvest(s, lateFor(d), undefined, s.messages.length), undefined);
	assert.deepEqual(s.prompts, []);
	// cut mid-turn: there is this turn's work to harvest
	s.messages.push({ role: "user" }, { role: "assistant", content: [{ type: "text", text: "reading…" }] });
	assert.equal(await harvest(s, lateFor(d), undefined, s.messages.length - 2), "an answer from round 1's context");
});

test("no harvest before the cut, after the caller's abort, or for a session that never answered", async () => {
	const before = startDeadline(10 * MIN);
	assert.equal(await harvest(fakeSession("[]"), lateFor(before)), undefined);

	const d = startDeadline(10 * MIN);
	mock.timers.tick(9 * MIN);
	const user = new AbortController();
	user.abort("esc");
	const s = fakeSession("[]");
	assert.equal(await harvest(s, lateFor(d, user.signal)), undefined);
	assert.equal(await harvest(fakeSession("[]", false), lateFor(d)), undefined);
	assert.deepEqual(s.prompts, []);
});

test("the harvest prompt doesn't read like a prompt injection", () => {
	// gpt-6.1-sol's gateway blocked "your tools are now disabled. Do not try to call any." every time.
	const p = harvestPrompt("Output ONLY the JSON.");
	assert.doesNotMatch(p, /disabled|do not try/i);
	assert.match(p, /final answer now, based on what you have already checked/);
	assert.match(p, /Output ONLY the JSON\.$/);
});

test("a harvest that doesn't answer in time gives up at the hard end", async () => {
	const d = startDeadline(10 * MIN);
	mock.timers.tick(9 * MIN);
	const s = fakeSession(() => new Promise<never>(() => {}));
	const result = harvest(s, lateFor(d));
	// let it reach the prompt, then run out the harvest's minute
	await new Promise((r) => setImmediate(r));
	mock.timers.tick(HARVEST_MS);
	assert.equal(await result, undefined);
	assert.deepEqual(s.tools, ["read", "grep", "progress"]);
});

// ---------- unreachable straggler quorum ----------

test("a quorum that can no longer be reached still arms the cutoff", () => {
	// Regression: with 5 reviewers, quorum is 4. In a real run 2 timed out, so
	// the quorum became unreachable, the cutoff never armed, and the survivors
	// each burned their full 355s timeout to a useless harvest.
	assert.equal(stragglerQuorum(5), 4);
	assert.deepEqual(shouldArmStragglerCutoff(5, 2, 2), { arm: true, reason: "impossible" });
	// Still waiting while the quorum is genuinely reachable.
	assert.deepEqual(shouldArmStragglerCutoff(5, 1, 1), { arm: false, reason: "wait" });
	// Fires the normal way once the quorum is met.
	assert.deepEqual(shouldArmStragglerCutoff(5, 4, 0), { arm: true, reason: "quorum" });
	// A pool of ≤2 has an infinite quorum ("wait for everyone"), so a failure
	// can never make it unreachable: its cutoff stays the plain timeout.
	assert.equal(stragglerQuorum(2), Number.POSITIVE_INFINITY);
	assert.deepEqual(shouldArmStragglerCutoff(2, 1, 1), { arm: false, reason: "wait" });
});

test("cutNow cuts at once and still leaves the harvest its budget", () => {
	const d = startDeadline(10 * MIN);
	mock.timers.tick(2 * MIN);
	d.cutNow("spent $1.62 of its $1.50 budget");
	assert.equal(d.cut.aborted, true);
	assert.equal(d.cut.reason, "spent $1.62 of its $1.50 budget");
	mock.timers.tick(HARVEST_MS - 1);
	assert.equal(d.end.aborted, false);
	mock.timers.tick(1);
	assert.equal(d.end.aborted, true);
});

test("cutNow after the cut changes nothing", () => {
	const d = startDeadline(10 * MIN);
	mock.timers.tick(9 * MIN);
	d.cutNow("spent too much");
	assert.equal(d.cut.reason, "timed out after 600s");
});

function spendingSession() {
	const listeners = new Set<(e: AgentSessionEvent) => void>();
	const s = {
		stats: { tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, toolCalls: 0 },
		getSessionStats: () => s.stats,
		subscribe(l: (e: AgentSessionEvent) => void) {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		emit: (type: string) => { for (const l of listeners) l({ type } as AgentSessionEvent); },
		listeners,
	};
	return s;
}

test("the spend cap cuts a session once its billed spend, cache included, crosses the cap", () => {
	const d = startDeadline(10 * MIN);
	const s = spendingSession();
	// $2/M input: 7M cached reads bill $0.70 the catalog price leaves out.
	armSpendCap(s, d, { maxUsd: 1.5, inputPerMillion: 2 });
	s.stats = { ...s.stats, cost: 0.79, tokens: { ...s.stats.tokens, cacheRead: 7_000_000 } };
	s.emit("message_end");
	assert.equal(d.cut.aborted, false);
	s.stats = { ...s.stats, cost: 0.81 };
	s.emit("message_end");
	assert.equal(d.cut.aborted, true);
	assert.equal(d.cut.reason, "spent $1.510 of its $1.500 budget");
});

test("no cap, or a cap of 0, never cuts and doesn't listen", () => {
	const d = startDeadline(10 * MIN);
	const s = spendingSession();
	const off = armSpendCap(s, d, { maxUsd: 0, inputPerMillion: 2 });
	assert.equal(s.listeners.size, 0);
	s.stats = { ...s.stats, cost: 100 };
	s.emit("message_end");
	assert.equal(d.cut.aborted, false);
	off();
});

test("the spend cap's unsubscribe stops it", () => {
	const d = startDeadline(10 * MIN);
	const s = spendingSession();
	const off = armSpendCap(s, d, { maxUsd: 1, inputPerMillion: 2 });
	off();
	s.stats = { ...s.stats, cost: 5 };
	s.emit("message_end");
	assert.equal(d.cut.aborted, false);
});
