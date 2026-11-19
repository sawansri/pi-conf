import type { EngineInterface, Register, TurnStepChunk, TurnStepResult } from 'claude-code'

// Makes pi agents native Claude Code subagents, as visible as Claude's own.
// Each pi agent definition (~/.pi/agent/agents/*.md, .pi/agents/*.md, as
// `pi-agent list` finds them) is registered as the agent type
// `pi-subagent:<name>`, plus `pi-subagent:pi` for pi's default agent. Claude
// dispatches them with the Agent tool, so they show in the tasks list, run in
// the background, and open as a transcript.
//
// No Claude model runs for them. pi runs detached (`pi-agent start`) and
// writes each assistant message and tool result to an events file. A
// `turn.step` hook answers each of the subagent's model requests with pi's
// next message: its text and its tool calls as real tool_use blocks naming this mod's tools (`mcp__pi-subagent__read`, …).
// The engine then "runs" those, and the `tool.call` hook answers each with
// the result pi got, so the transcript shows every pi tool call with its
// input and output, the way a Claude subagent's are shown. pi's thinking
// goes in as a notice before each message: the engine shows thinking a hook
// streams but records only thinking the model signed, so a streamed block
// would vanish from the transcript once the run ended. Hooks wait for pi
// inside a `pi-agent wait` child, which costs none of a hook's 10 s budget.
// Interrupting the subagent stops pi; a follow-up (SendMessage) resumes the
// same pi session.

const PLUGIN = 'pi-subagent'
const PREFIX = `${PLUGIN}:`
const TOOL_PREFIX = `mcp__${PLUGIN}__`
/** pi's default agent: no definition, every tool. */
const DEFAULT_AGENT = 'pi'
/** pi-agent's own `none`. */
const PI_AGENT_NONE = 'none'
/** A subagent has no Bash call's 10-minute cap; this bounds a runaway one. */
const TIMEOUT_S = 1800
/** A first line `pi-model: provider/id[:level]` picks the model for that task. */
const MODEL_LINE = /^\s*pi-model:\s*(\S+)\s*\n/
/** pi's built-in and usual extension tools, each shown under its own name; others go through `tool`. */
export const PI_TOOLS = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'web_search', 'web_extract'] as const
const OTHER_TOOL = 'tool'

interface PiAgent {
  name: string
  description: string
  model?: string
  thinking?: string
  tools?: string[]
}

/** A line of an events file (pi-agent's `--events`). */
export type PiEvent =
  | { type: 'start', runDir: string }
  | { type: 'message', thinking: string, text: string, toolCalls: Array<{ id: string, name: string, args: unknown }>, stopReason?: string, errorMessage?: string }
  | { type: 'tool_end', id: string, name: string, isError: boolean, text: string }
  | { type: 'done', ok: boolean, text?: string, error?: string, summary?: string, runDir?: string }

/** One pi run as the mod follows it, per subagent. */
interface Run {
  runDir: string
  events: string
  /** The next events-file line to read. */
  cursor: number
  /** Tool results by the tool_use id the engine knows. */
  results: Map<string, { text: string, isError: boolean }>
  /** The engine's tool_use id → pi's tool call id. */
  piIds: Map<string, string>
}

const runs = new Map<string, Run>()
/** agentId → whether it's one of ours, once asked. */
const isOurs = new Map<string, boolean>()
/** turnId → the text the turn began with. */
const turnText = new Map<string, string>()

export function agentDescription(a: PiAgent): string {
  const how = [a.model ?? "pi's default model", a.thinking && `@${a.thinking}`].filter(Boolean).join('')
  const tools = a.tools ? `tools: ${a.tools.join(', ')}` : 'all tools'
  return `[pi · ${how} · ${tools}] ${a.description} Runs in pi, not Claude; it doesn't see this conversation, so give it the whole task. A first line \`pi-model: provider/id[:level]\` picks another pi model.`
}

/** The task without a leading `pi-model:` line, and that line's model. */
export function splitModel(task: string): { task: string, model?: string } {
  const m = task.match(MODEL_LINE)
  return m ? { task: task.slice(m[0].length), model: m[1] } : { task }
}

/** `pi-agent start` argv: a new run of `agent`, or a follow-up in `runDir`. */
export function startArgv(agent: string, task: string, runDir: string | undefined): string[] {
  const { task: body, model } = splitModel(task)
  const argv = ['pi-agent', 'start', runDir ?? (agent === DEFAULT_AGENT ? PI_AGENT_NONE : agent), '--timeout', String(TIMEOUT_S)]
  if (model) argv.push('--model', model)
  argv.push('--', body)
  return argv
}

/** The mod's tool that shows pi's `name`, and the input it's shown with. */
export function shownAs(name: string, args: unknown): { tool: string, input: unknown } {
  return (PI_TOOLS as readonly string[]).includes(name)
    ? { tool: `${TOOL_PREFIX}${name}`, input: args }
    : { tool: `${TOOL_PREFIX}${OTHER_TOOL}`, input: { tool: name, args } }
}

/** A tool_use id the engine accepts, unique within the run. */
export function safeId(id: string, n: number): string {
  const clean = id.replace(/[^\w-]/g, '_')
  return clean ? `pi_${clean}` : `pi_call_${n}`
}

/** Parses `pi-agent wait` output (`{ n, event }` per line). */
export function parseWaitLines(stdout: string): Array<{ n: number, event: PiEvent }> {
  const out: Array<{ n: number, event: PiEvent }> = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (typeof parsed?.n === 'number' && parsed.event) out.push(parsed)
    } catch {
      // Only JSON comes out of wait; skip anything else.
    }
  }
  return out
}

/** Records tool results; returns the step's line (a message or done), if it came. */
function absorb(run: Run, lines: Array<{ n: number, event: PiEvent }>): PiEvent | undefined {
  let stepLine: PiEvent | undefined
  for (const { n, event } of lines) {
    run.cursor = Math.max(run.cursor, n + 1)
    if (event.type === 'tool_end') {
      for (const [engineId, piId] of run.piIds) {
        if (piId === event.id) run.results.set(engineId, { text: event.text, isError: event.isError })
      }
    } else if (event.type === 'message' || event.type === 'done') {
      stepLine = event
    }
  }
  return stepLine
}

/**
 * Runs `pi-agent wait` from the run's cursor, inside a child so the hook's
 * budget doesn't run: until the next message or done, or `piToolId`'s result.
 */
async function waitFor($: EngineInterface, run: Run, piToolId?: string): Promise<PiEvent | undefined> {
  const argv = ['pi-agent', 'wait', run.events, '--from', String(run.cursor)]
  if (piToolId) argv.push('--until-tool', piToolId)
  let stdout = ''
  for await (const chunk of $.process.spawn({ argv })) {
    if (chunk.stream === 'stdout') stdout += chunk.text
  }
  return absorb(run, parseWaitLines(stdout))
}

/** Stops the pi run when the dispatch waiting on it is abandoned (an interrupt). */
function stopOnAbort($: EngineInterface, signal: AbortSignal, run: Run): () => void {
  const stop = () => void $.process.run(['pi-agent', 'stop', run.runDir]).catch(() => {})
  signal.addEventListener('abort', stop, { once: true })
  return () => signal.removeEventListener('abort', stop)
}

async function registerAll($: EngineInterface): Promise<void> {
  let agents: PiAgent[] = []
  try {
    const r = await $.process.run(['pi-agent', 'list', '--json'])
    if (r.exitCode === 0) agents = JSON.parse(r.stdout)
    else $.ui.log(`pi-subagent: pi-agent list failed: ${r.stderr.trim()}`)
  } catch (err) {
    $.ui.log(`pi-subagent: pi-agent isn't runnable (${String(err)}); only pi-subagent:pi is offered`)
  }
  for (const name of [...PI_TOOLS, OTHER_TOOL]) {
    await $.tool.register({
      name,
      description: name === OTHER_TOOL
        ? 'Shows a pi agent\'s call of a tool with no tool of its own here. Only pi-subagent agents use it; it runs nothing.'
        : `Shows a pi agent's \`${name}\` call and its result. Only pi-subagent agents use it; it runs nothing.`,
      inputSchema: { type: 'object', additionalProperties: true },
      isDeferred: true,
    })
  }
  const toolNames = [...PI_TOOLS, OTHER_TOOL].map(t => `${TOOL_PREFIX}${t}`)
  const all: PiAgent[] = [
    ...agents.filter(a => /^[\w-]{1,64}$/.test(a.name) && a.name !== DEFAULT_AGENT),
    { name: DEFAULT_AGENT, description: "pi's default coding agent, for any task you'd hand a general-purpose agent." },
  ]
  const failed: string[] = []
  for (const a of all) {
    await $.agent.register({
      name: a.name,
      description: agentDescription(a),
      // The turn.step hook answers every request, so this model only runs if
      // the mod didn't (unloaded mid-run, say). Its tools are the mod's
      // display tools, which refuse any call outside a pi run.
      prompt: `Reply with exactly this and nothing else: "The pi-subagent mod didn't run pi for this task; nothing was done. Retry, or run \`pi-agent run ${a.name === DEFAULT_AGENT ? PI_AGENT_NONE : a.name} -- <task>\` with Bash."`,
      tools: toolNames,
      model: 'haiku',
    }).catch((err: unknown) => failed.push(`${a.name} (${String(err)})`))
  }
  if (failed.length) $.ui.log(`pi-subagent: couldn't register ${failed.join(', ')}`)
  else $.ui.log(`pi-subagent: ${all.length} pi agents ready (${all.map(a => a.name).join(', ')})`, { to: 'debug' })
}

async function ours($: EngineInterface, agentId: string): Promise<boolean> {
  const known = isOurs.get(agentId)
  if (known !== undefined) return known
  const agent = (await $.agent.list()).find(a => a.id === agentId)
  if (!agent) return false
  const mine = agent.type.startsWith(PREFIX)
  isOurs.set(agentId, mine)
  return mine
}

/** The prompt this turn answers: what the turn began with, else the conversation's last user text. */
async function taskOf($: EngineInterface, agentId: string, turnId: string): Promise<string> {
  const text = turnText.get(turnId)
  if (text) return text
  const messages = await $.session.messages({ agentId })
  if (!Array.isArray(messages)) return ''
  return messages.findLast(m => m.role === 'user' && m.text.trim() !== '')?.text ?? ''
}

async function notice($: EngineInterface, agentId: string, text: string): Promise<void> {
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] }, agentId }).catch(() => {})
}

/** The chunks of one replayed pi message, and the engine ids of its tool calls. */
export function messageChunks(event: Extract<PiEvent, { type: 'message' }>, idBase: number): { chunks: TurnStepChunk[], toolIds: Array<[string, string]> } {
  const chunks: TurnStepChunk[] = []
  const toolIds: Array<[string, string]> = []
  let index = 0
  if (event.text) chunks.push({ kind: 'text', index: index++, text: event.text })
  event.toolCalls.forEach((call, i) => {
    const id = safeId(call.id, idBase + i)
    const { tool, input } = shownAs(call.name, call.args)
    toolIds.push([id, call.id])
    chunks.push({ kind: 'tool', index, id, name: tool })
    chunks.push({ kind: 'input', index: index++, json: JSON.stringify(input ?? {}) })
  })
  chunks.push({ kind: 'stop', stopReason: event.toolCalls.length ? 'tool_use' : 'end_turn', usage: null })
  return { chunks, toolIds }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await registerAll($)
    return started
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId !== undefined) turnText.set(e.turnId, e.text)
    return next(e)
  })

  on('turn.step', async function* ($, e, next): AsyncGenerator<TurnStepChunk, TurnStepResult | void> {
    if (e.agentId === undefined || !(await ours($, e.agentId))) return yield* next(e)
    const agentId = e.agentId
    const result = (answer: string, toolUses: TurnStepResult['toolUses'] = []): TurnStepResult => ({
      turnId: e.turnId, index: e.index, answer, toolUses, stopReason: toolUses.length ? 'tool_use' : 'end_turn', usage: null,
    })
    const finish = function* (answer: string): Generator<TurnStepChunk, TurnStepResult> {
      yield { kind: 'text', index: 0, text: answer }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return result(answer)
    }

    let run = runs.get(agentId)
    if (e.index === 0) {
      // A new task, or a follow-up to the same agent: start pi (resuming its session).
      const type = (await $.agent.list()).find(a => a.id === agentId)?.type ?? `${PREFIX}${DEFAULT_AGENT}`
      const task = await taskOf($, agentId, e.turnId)
      turnText.delete(e.turnId)
      const started = await $.process.run(startArgv(type.slice(PREFIX.length), task, run?.runDir))
      let info: { runDir?: string, events?: string } = {}
      try {
        info = JSON.parse(started.stdout)
      } catch {
        // Reported below.
      }
      if (started.exitCode !== 0 || !info.runDir || !info.events) {
        return yield* finish(`The pi agent didn't start: ${started.stderr.trim() || started.stdout.trim() || `exit ${started.exitCode}`}`)
      }
      run = { runDir: info.runDir, events: info.events, cursor: 0, results: new Map(), piIds: new Map() }
      runs.set(agentId, run)
      await notice($, agentId, `pi run: ${run.runDir}`)
    } else if (!run) {
      return yield* finish('pi-subagent lost track of this pi run (the mod reloaded mid-run). Its output is in ~/.local/share/pi-subagent/runs/.')
    }

    const unhook = stopOnAbort($, next.signal, run)
    try {
      let line = await waitFor($, run)
      // A message without tool calls is pi's answer; its done line says how the run ended.
      if (line?.type === 'message' && line.toolCalls.length === 0) {
        const answer = line
        const done = await waitFor($, run)
        if (done?.type === 'done' && done.summary) await notice($, agentId, done.summary)
        if (answer.stopReason === 'error' || (done?.type === 'done' && !done.ok)) {
          const why = answer.errorMessage ?? (done?.type === 'done' ? done.error : undefined) ?? 'unknown error'
          return yield* finish(`${answer.text ? `${answer.text}\n\n` : ''}The pi agent failed: ${why}\nRun: ${run.runDir}`)
        }
        line = { ...answer, text: answer.text || '(the pi agent gave no text answer)' }
        if (answer.thinking) {
          await notice($, agentId, `∴ Thinking\n${answer.thinking}`)
          line = { ...line, thinking: '' }
        }
      }
      if (!line) return yield* finish(`pi-agent wait returned nothing. Run: ${run.runDir}`)
      if (line.type === 'done') {
        if (line.summary) await notice($, agentId, line.summary)
        return yield* finish(line.ok ? (line.text || '(the pi agent gave no text answer)') : `The pi agent failed: ${line.error ?? 'unknown error'}\nRun: ${run.runDir}`)
      }
      if (line.type !== 'message') return yield* finish(`Unexpected pi event. Run: ${run.runDir}`)

      if (line.thinking) await notice($, agentId, `∴ Thinking\n${line.thinking}`)
      const { chunks, toolIds } = messageChunks(line, run.piIds.size)
      for (const [engineId, piId] of toolIds) run.piIds.set(engineId, piId)
      for (const chunk of chunks) yield chunk
      const toolUses = line.toolCalls.map(c => {
        const { tool, input } = shownAs(c.name, c.args)
        return { name: tool, input }
      })
      return result(line.text, toolUses)
    } finally {
      unhook()
    }
  })

  on('tool.check', ($, e, next) => {
    // The call already ran in pi; there's nothing here to ask about.
    if (e.tool.startsWith(TOOL_PREFIX) && e.agentId !== undefined && runs.has(e.agentId)) return { decision: 'allow' }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!e.tool.startsWith(TOOL_PREFIX)) return next(e)
    const run = e.agentId === undefined ? undefined : runs.get(e.agentId)
    const piId = run?.piIds.get(e.tool_use_id)
    if (!run || piId === undefined) return { deny: 'This tool only shows a pi agent\'s tool calls inside a pi-subagent run; it runs nothing.' }
    if (!run.results.has(e.tool_use_id)) {
      const unhook = stopOnAbort($, next.signal, run)
      try {
        await waitFor($, run, piId)
      } finally {
        unhook()
      }
    }
    const r = run.results.get(e.tool_use_id)
    if (!r) return { result: '(pi ended before this tool call finished)' }
    return r.isError ? { result: `Error: ${r.text}` } : { result: r.text || '(no output)' }
  })
}
