import { expect, test, type TestBody } from 'claude-code/testing'

import { messageChunks, parseWaitLines, safeId, shownAs, splitModel, startArgv } from '../hooks/register'

const LIST = JSON.stringify([
  { name: 'explore', description: 'Read-only search.', tools: ['read', 'grep'] },
  { name: 'bad name!', description: 'skipped' },
])

/** The events a pi run writes: a grep, its result, the answer, done. */
const EVENTS = [
  { type: 'start', runDir: '/runs/r1' },
  { type: 'message', thinking: 'Plan: grep.', text: 'Let me look.', toolCalls: [{ id: 'call.1', name: 'grep', args: { pattern: 'foo' } }], stopReason: 'toolUse' },
  { type: 'tool_end', id: 'call.1', name: 'grep', isError: false, text: 'src/a.ts:3: foo' },
  { type: 'message', thinking: '', text: 'Found it in src/a.ts:3', toolCalls: [], stopReason: 'stop' },
  { type: 'done', ok: true, text: 'Found it in src/a.ts:3', summary: 'pi-agent: ok · explore' },
]

/** `pi-agent wait` over EVENTS, as src/cli.ts waitEvents reads a file. */
function fakeWait(argv: readonly string[]): string {
  const from = Number(argv[argv.indexOf('--from') + 1])
  const untilTool = argv.includes('--until-tool') ? argv[argv.indexOf('--until-tool') + 1] : undefined
  const out: string[] = []
  for (let n = from; n < EVENTS.length; n++) {
    const event = EVENTS[n]!
    if (untilTool && (event.type === 'message' || event.type === 'done')) break
    out.push(JSON.stringify({ n, event }))
    if (untilTool ? event.type === 'tool_end' && 'id' in event && event.id === untilTool : event.type === 'message' || event.type === 'done') break
  }
  return out.map(l => `${l}\n`).join('')
}

/** Engine stand-ins shared by the tests; returns what the mod did. */
function fakeEngine(on: Parameters<TestBody>[1], agents: Array<{ id: string, type: string }>) {
  const seen = { agents: [] as string[], tools: [] as string[], runs: [] as string[][], waits: [] as string[][], notices: [] as string[], engineSteps: 0, engineToolCalls: 0 }
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const argv = e.argv
    seen.runs.push([...argv])
    if (argv[1] === 'list') return ok(LIST)
    if (argv[1] === 'start') return ok(JSON.stringify({ runDir: '/runs/r1', events: '/runs/r1/events-1.jsonl', pid: 1 }))
    return ok('')
  })
  on('tool.register', (_, e) => {
    seen.tools.push(e.name)
    return { value: { tool: `mcp__pi-subagent__${e.name}` } }
  })
  on('agent.register', (_, e) => {
    seen.agents.push(e.name)
    return { value: { agent: `pi-subagent:${e.name}` } }
  })
  on('agent.list', () => ({ value: agents.map(a => ({ ...a, description: '', status: 'running' })) }))
  on('session.append', (_, e, next) => {
    const block = e.message.content[0]
    if (block && 'text' in block) seen.notices.push(String(block.text))
    return next(e)
  })
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('process.spawn', async function* (_, e) {
    seen.waits.push([...e.argv])
    const text = fakeWait(e.argv)
    if (text) yield { stream: 'stdout' as const, text }
    return { value: { code: 0, signal: null } }
  })
  on('turn.step', async function* (_, e) {
    seen.engineSteps++
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'from claude', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('tool.call', () => {
    seen.engineToolCalls++
    return { result: 'engine ran it' }
  })
  return seen
}

async function drain<C, R>(stream: AsyncGenerator<C, R>): Promise<{ chunks: C[], result: R }> {
  const chunks: C[] = []
  for (;;) {
    const r = await stream.next()
    if (r.done) return { chunks, result: r.value }
    chunks.push(r.value)
  }
}

test('registers the display tools, each valid pi agent and the default one', async ($, on) => {
  const seen = fakeEngine(on, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(seen.agents).toEqual(['explore', 'pi'])
  expect(seen.tools).toEqual(['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'web_search', 'web_extract', 'tool'])
})

test("a pi agent's turn replays pi's messages and tool calls instead of calling the model", async ($, on) => {
  const seen = fakeEngine(on, [{ id: 'a1', type: 'pi-subagent:explore' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'pi-model: amd-gateway/x:low\nFind foo', agentId: 'a1' })

  // Step 0: pi's first message, its grep as a tool_use of the mod's grep tool.
  const step0 = await drain($.turn.step({ turnId: 't1', index: 0, model: 'haiku', messageCount: 1, agentId: 'a1' }))
  expect(seen.runs.find(r => r[1] === 'start')).toEqual(['pi-agent', 'start', 'explore', '--timeout', '1800', '--model', 'amd-gateway/x:low', '--', 'Find foo'])
  expect(step0.chunks.map(c => c.kind)).toEqual(['thinking', 'text', 'tool', 'input', 'stop'])
  expect(step0.chunks[2]).toEqual({ kind: 'tool', index: 2, id: 'pi_call_1', name: 'mcp__pi-subagent__grep' })
  expect(step0.result?.toolUses).toEqual([{ name: 'mcp__pi-subagent__grep', input: { pattern: 'foo' } }])
  expect(step0.result?.stopReason).toBe('tool_use')

  // The engine runs that tool_use: the mod answers with pi's result, nothing runs.
  const call = await $.tool.call({ tool: 'mcp__pi-subagent__grep', tool_use_id: 'pi_call_1', agentId: 'a1', pattern: 'foo' })
  expect(call).toEqual({ result: 'src/a.ts:3: foo' })
  expect(seen.waits.at(-1)).toEqual(['pi-agent', 'wait', '/runs/r1/events-1.jsonl', '--from', '2', '--until-tool', 'call.1'])

  // Step 1: pi's answer, after its done line.
  const step1 = await drain($.turn.step({ turnId: 't1', index: 1, model: 'haiku', messageCount: 3, agentId: 'a1' }))
  expect(step1.result?.answer).toBe('Found it in src/a.ts:3')
  expect(step1.result?.stopReason).toBe('end_turn')
  expect(seen.notices).toEqual(['pi run: /runs/r1', 'pi-agent: ok · explore'])
  expect(seen.engineSteps).toBe(0)
  expect(seen.engineToolCalls).toBe(0)

  // A follow-up to the same agent resumes its pi run.
  await $.turn.start({ turnId: 't2', text: 'And bar?', agentId: 'a1' })
  const resumeStep = $.turn.step({ turnId: 't2', index: 0, model: 'haiku', messageCount: 5, agentId: 'a1' })
  await resumeStep.next()
  expect(seen.runs.filter(r => r[1] === 'start').at(-1)).toEqual(['pi-agent', 'start', '/runs/r1', '--timeout', '1800', '--', 'And bar?'])
  await resumeStep.return(undefined as never)
})

test('other agents and the main loop still reach the model; the display tools refuse them', async ($, on) => {
  const seen = fakeEngine(on, [{ id: 'a2', type: 'Explore' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await drain($.turn.step({ turnId: 't3', index: 0, model: 'opus', messageCount: 1, agentId: 'a2' }))
  await drain($.turn.step({ turnId: 't4', index: 0, model: 'opus', messageCount: 1 }))
  expect(seen.engineSteps).toBe(2)
  expect(seen.runs.some(r => r[1] === 'start')).toBe(false)
  const call = await $.tool.call({ tool: 'mcp__pi-subagent__bash', command: 'rm -rf /' })
  expect('deny' in call && call.deny).toMatch(/only shows a pi agent's tool calls/)
  expect(seen.engineToolCalls).toBe(0)
})

test('helpers: model line, argv for the default agent, tool names, ids, wait lines', () => {
  expect(splitModel('do it')).toEqual({ task: 'do it' })
  expect(startArgv('pi', 'x', undefined).slice(0, 3)).toEqual(['pi-agent', 'start', 'none'])
  expect(shownAs('lsp_hover', { a: 1 })).toEqual({ tool: 'mcp__pi-subagent__tool', input: { tool: 'lsp_hover', args: { a: 1 } } })
  expect(safeId('', 4)).toBe('pi_call_4')
  expect(parseWaitLines('{"n":1,"event":{"type":"done","ok":true}}\nnoise\n')).toEqual([{ n: 1, event: { type: 'done', ok: true } }])
  const { chunks } = messageChunks({ type: 'message', thinking: '', text: '', toolCalls: [], stopReason: 'stop' }, 0)
  expect(chunks).toEqual([{ kind: 'stop', stopReason: 'end_turn', usage: null }])
})
