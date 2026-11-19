import { expect, test, type TestBody } from 'claude-code/testing'

import { piAgentArgv, splitModel, takeLines } from '../hooks/register'

const LIST = JSON.stringify([
  { name: 'explore', description: 'Read-only search.', tools: ['read', 'grep'] },
  { name: 'bad name!', description: 'skipped' },
])

const STREAM = [
  '{"type":"start","agent":"explore","runDir":"/runs/r1"}\n{"type":"tool","text":"grep foo"}\n',
  '{"type":"text","text":"Looking in src."}\n{"type":"done","ok":true,"text":"Found it in src/a.ts:3","summary":"pi-agent: ok · explore","runDir":"/runs/r1"}\n',
]

/** Engine stand-ins shared by the tests; returns what the mod did. */
function fakeEngine(on: Parameters<TestBody>[1], agents: Array<{ id: string, type: string }>) {
  const seen = { registered: [] as string[], spawned: [] as string[][], notices: [] as string[], engineSteps: 0 }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: LIST, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.register', (_, e) => {
    seen.registered.push(e.name)
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
    seen.spawned.push([...e.argv])
    for (const text of STREAM) yield { stream: 'stdout' as const, text }
    return { value: { code: 0, signal: null } }
  })
  on('turn.step', async function* (_, e) {
    seen.engineSteps++
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'from claude', toolUses: [], stopReason: 'end_turn' as const, usage: null }
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

test('registers each valid pi agent plus the default one', async ($, on) => {
  const seen = fakeEngine(on, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(seen.registered).toEqual(['explore', 'pi'])
})

test("a pi agent's turn runs pi-agent instead of the model and returns its answer", async ($, on) => {
  const seen = fakeEngine(on, [{ id: 'a1', type: 'pi-subagent:explore' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'pi-model: amd-gateway/x:low\nFind foo', agentId: 'a1' })

  const { chunks, result } = await drain($.turn.step({ turnId: 't1', index: 0, model: 'haiku', messageCount: 1, agentId: 'a1' }))

  expect(seen.engineSteps).toBe(0)
  expect(seen.spawned[0]).toEqual(['pi-agent', 'run', 'explore', '--stream-json', '--timeout', '1800', '--model', 'amd-gateway/x:low', '--', 'Find foo'])
  expect(chunks.some(c => c.kind === 'text' && c.text === 'Found it in src/a.ts:3')).toBe(true)
  expect(result?.answer).toBe('Found it in src/a.ts:3')
  expect(seen.notices).toEqual(['pi run: /runs/r1', '→ grep foo', 'Looking in src.', 'pi-agent: ok · explore'])

  // A follow-up to the same agent resumes its pi run.
  await $.turn.start({ turnId: 't2', text: 'And bar?', agentId: 'a1' })
  await drain($.turn.step({ turnId: 't2', index: 0, model: 'haiku', messageCount: 3, agentId: 'a1' }))
  expect(seen.spawned[1]).toEqual(['pi-agent', 'resume', '/runs/r1', '--stream-json', '--timeout', '1800', '--', 'And bar?'])
})

test('other agents and the main loop still reach the model', async ($, on) => {
  const seen = fakeEngine(on, [{ id: 'a2', type: 'Explore' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await drain($.turn.step({ turnId: 't3', index: 0, model: 'opus', messageCount: 1, agentId: 'a2' }))
  await drain($.turn.step({ turnId: 't4', index: 0, model: 'opus', messageCount: 1 }))
  expect(seen.engineSteps).toBe(2)
  expect(seen.spawned).toEqual([])
})

test('helpers: model line, argv for the default agent, line splitting', () => {
  expect(splitModel('do it')).toEqual({ task: 'do it' })
  expect(piAgentArgv('pi', 'x', undefined).slice(0, 3)).toEqual(['pi-agent', 'run', 'none'])
  const out: unknown[] = []
  expect(takeLines('{"type":"tool","text":"a"}\n{"type":"to', out as never)).toBe('{"type":"to')
  expect(out).toEqual([{ type: 'tool', text: 'a' }])
})
