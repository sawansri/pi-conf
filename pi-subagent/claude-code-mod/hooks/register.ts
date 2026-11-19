import type { EngineInterface, Register, TurnStepChunk, TurnStepResult } from 'claude-code'

// Makes pi agents native Claude Code subagents. Each pi agent definition
// (~/.pi/agent/agents/*.md, .pi/agents/*.md, as `pi-agent list` finds them)
// is registered as the agent type `pi-subagent:<name>`, plus `pi-subagent:pi`
// for pi's default agent. Claude dispatches them with the Agent tool like any
// other type, so they show in the tasks list, run in the background, and open
// as a transcript.
//
// No Claude model runs for them: a `turn.step` hook answers each of their
// model requests itself by running `pi-agent run --stream-json` (or `resume`
// for a follow-up sent to the same agent), posting each pi tool call into the
// subagent's transcript as a notice and returning pi's final answer as the
// response. Interrupting the subagent kills pi.

const PREFIX = 'pi-subagent:'
/** pi's default agent: no definition, every tool. */
const DEFAULT_AGENT = 'pi'
/** pi-agent's own `none`. */
const PI_AGENT_NONE = 'none'
/** A subagent has no Bash call's 10-minute cap; this bounds a runaway one. */
const TIMEOUT_S = 1800
/** A first line `pi-model: provider/id[:level]` picks the model for that task. */
const MODEL_LINE = /^\s*pi-model:\s*(\S+)\s*\n/

interface PiAgent {
  name: string
  description: string
  model?: string
  thinking?: string
  tools?: string[]
}

/** What `pi-agent --stream-json` writes, one per line. */
type StreamLine =
  | { type: 'start', runDir: string }
  | { type: 'tool' | 'text', text: string }
  | { type: 'done', ok: boolean, text?: string, error?: string, summary?: string, runDir?: string }

/** agentId → its pi run, so a follow-up resumes the same pi session. */
const runDirs = new Map<string, string>()
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

/** `pi-agent` argv for a new task, or a follow-up when the agent already has a run. */
export function piAgentArgv(agent: string, task: string, runDir: string | undefined): string[] {
  const { task: body, model } = splitModel(task)
  const argv = runDir
    ? ['pi-agent', 'resume', runDir]
    : ['pi-agent', 'run', agent === DEFAULT_AGENT ? PI_AGENT_NONE : agent]
  argv.push('--stream-json', '--timeout', String(TIMEOUT_S))
  if (model) argv.push('--model', model)
  argv.push('--', body)
  return argv
}

/** Parses complete lines out of `buffer`; returns what's left over. */
export function takeLines(buffer: string, out: StreamLine[]): string {
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // pi-agent writes only JSON to stdout in this mode; skip anything else.
    }
  }
  return rest
}

async function registerAgents($: EngineInterface): Promise<void> {
  let agents: PiAgent[] = []
  try {
    const r = await $.process.run(['pi-agent', 'list', '--json'])
    if (r.exitCode === 0) agents = JSON.parse(r.stdout)
    else $.ui.log(`pi-subagent: pi-agent list failed: ${r.stderr.trim()}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`pi-subagent: pi-agent isn't runnable (${String(err)}); only pi-subagent:pi is offered`, { to: 'debug' })
  }
  const all: PiAgent[] = [
    ...agents.filter(a => /^[\w-]{1,64}$/.test(a.name) && a.name !== DEFAULT_AGENT),
    { name: DEFAULT_AGENT, description: "pi's default coding agent, for any task you'd hand a general-purpose agent." },
  ]
  for (const a of all) {
    await $.agent.register({
      name: a.name,
      description: agentDescription(a),
      // Never sent: the turn.step hook answers every request. The registration
      // just needs a valid definition; no tools keeps the engine from offering any.
      prompt: `You are the pi agent "${a.name}". pi runs this agent; this prompt is not used.`,
      tools: [],
      model: 'haiku',
    })
  }
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await registerAgents($)
    return started
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId !== undefined) turnText.set(e.turnId, e.text)
    return next(e)
  })

  on('turn.step', async function* ($, e, next): AsyncGenerator<TurnStepChunk, TurnStepResult | void> {
    if (e.agentId === undefined || !(await ours($, e.agentId))) return yield* next(e)
    const agentId = e.agentId
    const done = (answer: string): TurnStepResult => ({
      turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null,
    })
    // pi answered the turn whole at step 0; nothing asks for another step.
    if (e.index > 0) {
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return done('')
    }

    const type = (await $.agent.list()).find(a => a.id === agentId)?.type ?? `${PREFIX}${DEFAULT_AGENT}`
    const task = await taskOf($, agentId, e.turnId)
    turnText.delete(e.turnId)
    const argv = piAgentArgv(type.slice(PREFIX.length), task, runDirs.get(agentId))

    let answer = ''
    let finished: Extract<StreamLine, { type: 'done' }> | undefined
    let stderr = ''
    let buffer = ''
    const lines: StreamLine[] = []
    try {
      for await (const chunk of $.process.spawn({ argv })) {
        if (chunk.stream === 'stderr') {
          stderr += chunk.text
          continue
        }
        buffer = takeLines(buffer + chunk.text, lines)
        for (const line of lines.splice(0)) {
          if (line.type === 'start') {
            runDirs.set(agentId, line.runDir)
            await notice($, agentId, `pi run: ${line.runDir}`)
          } else if (line.type === 'tool') {
            await notice($, agentId, `→ ${line.text}`)
          } else if (line.type === 'text') {
            await notice($, agentId, line.text)
          } else if (line.type === 'done') {
            finished = line
          }
        }
      }
    } catch (err) {
      stderr += String(err)
    }

    if (finished?.ok) {
      answer = finished.text?.trim() || '(the pi agent gave no text answer)'
      if (finished.summary) await notice($, agentId, finished.summary)
    } else {
      const why = finished?.error ?? (stderr.trim().split('\n').slice(-5).join('\n') || 'pi-agent ended without a result')
      answer = `The pi agent failed: ${why}${finished?.runDir ? `\nRun: ${finished.runDir}` : ''}`
      if (finished?.summary) await notice($, agentId, finished.summary)
    }
    yield { kind: 'text', index: 0, text: answer }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return done(answer)
  })
}
