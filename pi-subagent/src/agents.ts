/**
 * Agent definitions: the same Markdown files pi-lite-subagent reads, so one
 * definition serves both pi's `subagent` tool and `pi-agent` from Claude Code.
 *
 * YAML frontmatter (`name`, `description`, optional `tools`, `model`,
 * `thinking`) plus a body that is appended to pi's system prompt. Found in
 * `~/.pi/agent/agents/` (or `$PI_CODING_AGENT_DIR/agents/`) and the nearest
 * `.pi/agents/` above the working directory; a project agent overrides a user
 * agent of the same name.
 *
 * Pure apart from reading those directories, so tests can point it at fixtures.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

/**
 * The frontmatter subset agent files use: `key: value` scalars (optionally
 * quoted), inline `[a, b]` lists and block `- item` lists. Not a YAML parser;
 * anything else is kept as a raw string, and a file without frontmatter has
 * none.
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
	if (!m) return { frontmatter: {}, body: content };
	const frontmatter: Record<string, unknown> = {};
	let listKey: string | undefined;
	for (const line of m[1].split(/\r?\n/)) {
		const item = line.match(/^\s+-\s+(.*)$/);
		if (item && listKey) {
			(frontmatter[listKey] as string[]).push(unquote(item[1].trim()));
			continue;
		}
		const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
		if (!kv) continue;
		const [, key, raw] = kv;
		const value = raw.trim();
		listKey = undefined;
		if (value === "") {
			frontmatter[key] = [];
			listKey = key;
		} else if (value.startsWith("[") && value.endsWith("]")) {
			frontmatter[key] = value
				.slice(1, -1)
				.split(",")
				.map((s) => unquote(s.trim()))
				.filter(Boolean);
		} else {
			frontmatter[key] = unquote(value);
		}
	}
	return { frontmatter, body: content.slice(m[0].length) };
}

function unquote(s: string): string {
	if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
		return s.slice(1, -1);
	}
	return s;
}

function parseTools(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

export function parseThinking(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
		? (value as ThinkingLevel)
		: undefined;
}

/** One agent file, or undefined when it lacks `name` or `description`. */
export function parseAgent(content: string, source: "user" | "project", filePath: string): AgentConfig | undefined {
	const { frontmatter: fm, body } = parseFrontmatter(content);
	if (typeof fm.name !== "string" || !fm.name || typeof fm.description !== "string") return undefined;
	return {
		name: fm.name,
		description: fm.description,
		tools: parseTools(fm.tools),
		model: typeof fm.model === "string" && fm.model ? fm.model : undefined,
		thinking: parseThinking(fm.thinking),
		systemPrompt: body.trim(),
		source,
		filePath,
	};
}

function loadDir(dir: string, source: "user" | "project"): AgentConfig[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const agents: AgentConfig[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".md") || !(entry.isFile() || entry.isSymbolicLink())) continue;
		const filePath = path.join(dir, entry.name);
		try {
			const agent = parseAgent(fs.readFileSync(filePath, "utf-8"), source, filePath);
			if (agent) agents.push(agent);
		} catch {
			// A bad file never hides the others.
		}
	}
	return agents;
}

export function userAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "agents");
}

/** The nearest `.pi/agents` at or above `cwd`, or undefined. */
export function projectAgentsDir(cwd: string): string | undefined {
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, ".pi", "agents");
		if (fs.existsSync(candidate)) return candidate;
		if (path.dirname(dir) === dir) return undefined;
	}
}

/** User agents, then project agents, which override user agents of the same name. */
export function discoverAgents(cwd: string, env: NodeJS.ProcessEnv = process.env): AgentConfig[] {
	const byName = new Map<string, AgentConfig>();
	for (const a of loadDir(userAgentsDir(env), "user")) byName.set(a.name, a);
	const projectDir = projectAgentsDir(cwd);
	if (projectDir) for (const a of loadDir(projectDir, "project")) byName.set(a.name, a);
	return [...byName.values()];
}
