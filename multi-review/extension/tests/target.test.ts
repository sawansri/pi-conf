import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildReviewTarget } from "../src/target.ts";

const fakePi = {
	exec: async (command: string, args: string[], opts: { cwd: string }) => {
		try {
			return { code: 0, stdout: execFileSync(command, args, { cwd: opts.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
		} catch (err) {
			const e = err as { status?: number; stdout?: string; stderr?: string };
			return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
		}
	},
} as never;

function repo(): { dir: string; git: (...args: string[]) => string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-target-"));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	return { dir, git };
}

test("a since target reviews only what changed after the ref, uncommitted changes included", async () => {
	const { dir, git } = repo();
	fs.writeFileSync(path.join(dir, "feature.ts"), "feature\n");
	git("add", "."); git("commit", "-qm", "feature");
	const before = git("rev-parse", "HEAD").trim();
	fs.writeFileSync(path.join(dir, "fix.ts"), "fix\n");
	git("add", "."); git("commit", "-qm", "fix");
	fs.writeFileSync(path.join(dir, "wip.ts"), "wip\n");
	git("add", "wip.ts");
	const target = await buildReviewTarget(fakePi, { kind: "default", since: before }, dir);
	assert.deepEqual(target.files.map((f) => f.path).sort(), ["fix.ts", "wip.ts"]);
	assert.doesNotMatch(target.diffText, /feature\.ts/);
	assert.match(target.metaLines.join("\n"), /fix round: the diff is only what changed since/);
});

test("a since ref git can't resolve is a warning, not an empty clean review", async () => {
	const { dir, git } = repo();
	fs.writeFileSync(path.join(dir, "a.ts"), "a\n");
	git("add", "."); git("commit", "-qm", "a");
	const target = await buildReviewTarget(fakePi, { kind: "default", since: "no-such-ref" }, dir);
	assert.equal(target.diffText, "");
	assert.match(target.warnings.join("\n"), /git diff no-such-ref failed/);
});

test("ssh and https remotes name the same repo", async () => {
	const { normalizeRemote } = await import("../src/target.ts");
	assert.equal(normalizeRemote("git@github.com:Lemonade-SDK/lemonade.git\n"), "github.com/lemonade-sdk/lemonade");
	assert.equal(normalizeRemote("https://github.com/lemonade-sdk/lemonade"), "github.com/lemonade-sdk/lemonade");
	assert.equal(normalizeRemote("https://user@github.com/lemonade-sdk/lemonade.git"), "github.com/lemonade-sdk/lemonade");
});
