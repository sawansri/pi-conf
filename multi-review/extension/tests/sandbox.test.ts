import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { ANALYSIS_TOOLS_HOME, sandboxReadPaths } from "../src/sandbox.ts";
import { outcomesPath, runsHome } from "../src/outcomes.ts";

test("the sandbox reads the analysis tools, not past runs or the outcomes log", () => {
	// Runs moved into ~/.local/share/multi-review, which the sandbox could read
	// whole: code under review could read old briefs and findings, and a
	// verifier could read the live traces of the reviewers it is checking.
	const read = sandboxReadPaths("/home/u", [], {});
	assert.ok(read.includes(path.join(ANALYSIS_TOOLS_HOME, "venv")));
	assert.ok(read.includes(path.join(ANALYSIS_TOOLS_HOME, "clangd-index")));
	for (const p of read) {
		assert.ok(!(runsHome() + "/").startsWith(p + "/") && runsHome() !== p, `${p} exposes ${runsHome()}`);
		assert.ok(!outcomesPath().startsWith(p + "/"), `${p} exposes ${outcomesPath()}`);
	}
});
