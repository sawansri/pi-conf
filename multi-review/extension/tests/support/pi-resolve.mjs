import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const version = fs.readFileSync(path.join(agentDir, "install", "current-version"), "utf8").trim();
// A file inside pi's node_modules, to resolve bare specifiers from.
const fromPi = pathToFileURL(path.join(agentDir, "install", "releases", version, "node_modules", "_.js")).href;

export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context);
	} catch (err) {
		if (/^(\.|\/|node:|file:)/.test(specifier)) throw err;
		// pi publishes as @earendil-works and aliases the old scope for extensions.
		return next(specifier.replace(/^@mariozechner\//, "@earendil-works/"), { ...context, parentURL: fromPi });
	}
}
