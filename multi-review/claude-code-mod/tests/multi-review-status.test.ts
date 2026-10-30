import type { On, ToolCallResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { isRunCommand, outDir } from '../hooks/register.js'

const DIR = '/tmp/mr-run'
const COMMAND = `pi -p "/multi-review-run --brief=${DIR}/brief.json --out=${DIR}/result.json" < /dev/null`

const BAND = {
  plugin: 'multi-review-status',
  component: 'AbovePrompt',
  surface: 'terminal',
  viewport: { columns: 140, rows: 40 },
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 135, scroll: { offset: 0, bodyRows: 19 }, view: {} },
} as const

const SPINNER = {
  plugin: 'multi-review-status',
  component: 'Spinner',
  surface: 'terminal',
  viewport: { columns: 140, rows: 40 },
  props: { word: 'Baking', message: null, suffix: '…', mode: 'tool-use' },
} as const

/** A progress.json the stubs serve, with its mtime, and the runs pi announced. */
interface Fake {
  mtimeMs?: number
  body?: unknown
  announced?: Array<{ pid: number, progress: string, startedAt: number }>
}

const RUNS = '/home/me/.cache/multi-review/runs'

function snapshot(phase: string, extra: Record<string, unknown> = {}) {
  return {
    run: { mode: 'balanced+verify', phase, events: [], startedAt: 0, finished: false, ...extra },
    activity: [],
  }
}

/** Stubs every call the mod makes; `bash` answers the Bash call. */
function stub(on: On, file: Fake, bash: () => Promise<ToolCallResult> | ToolCallResult) {
  const clock = mock.clock(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.list', ($, e) => (e.path === RUNS
    ? { value: (file.announced ?? []).map((a) => ({ name: `${a.pid}.json`, kind: 'file', size: 1, mtimeMs: a.startedAt, isLink: false })) }
    : { deny: 'ENOENT' }))
  on('fs.stat', ($, e) => (file.mtimeMs === undefined || e.path !== `${DIR}/progress.json`
    ? { deny: 'ENOENT' }
    : { value: { kind: 'file', size: 1, mtimeMs: file.mtimeMs, isLink: false } }))
  on('fs.read', ($, e) => {
    const announced = file.announced?.find((a) => e.path === `${RUNS}/${a.pid}.json`)
    if (announced) return { value: JSON.stringify(announced) }
    return e.path === `${DIR}/progress.json` ? { value: JSON.stringify(file.body) } : { deny: 'ENOENT' }
  })
  on('tool.call', () => bash())
  // Claude Code's own drawing; the spinner's shows the suffix it was given
  on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: [e.component === 'Spinner' ? `${e.props.word}${e.props.suffix}` : 'engine'] }))
  return clock
}

test('outDir takes --out only when it is a plain absolute path', () => {
  expect(isRunCommand(COMMAND)).toBe(true)
  expect(isRunCommand('ls --out=/tmp/x/y.json')).toBe(false)
  expect(outDir(COMMAND)).toBe(DIR)
  expect(outDir(`pi -p '/multi-review-run --brief=b.json --out="/a b/r.json"' < /dev/null`)).toBe('/a b')
  expect(outDir('pi -p "/multi-review-run --brief=b.json --out=r.json"')).toBeUndefined()
  expect(outDir('pi -p "/multi-review-run --brief=$D/b.json --out=$D/r.json"')).toBeUndefined()
  expect(outDir('pi -p "/multi-review-run --brief=b.json --out=~/r.json"')).toBeUndefined()
  expect(outDir('pi -p "/multi-review-run --brief=b.json"')).toBeUndefined()
})

test('a run whose --out is a shell variable is found through its announcement', async ($, on) => {
  const file: Fake = { announced: [{ pid: 7, progress: '/elsewhere/progress.json', startedAt: 0 }] }
  const clock = stub(on, file, () => new Promise(() => {}))
  await clock.set(60_000)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  void $.tool.call({ tool: 'Bash', command: `cd /wt; D=$(cat /x/mr-dir); pi -p "/multi-review-run --brief=$D/brief.json --out=$D/result.json" < /dev/null 2>&1 | tail -15` })
  await clock.settle()
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: / · starting · / })).toBeDefined()

  // An announcement from before the call is another run's; this one's comes next
  file.announced = [...file.announced!, { pid: 8, progress: `${DIR}/progress.json`, startedAt: 60_500 }]
  file.mtimeMs = 61_000
  file.body = snapshot('reviewers running', { done: 0, total: 3 })
  await clock.advance(1000)
  expect(await band.find({ type: 'Text', text: / · reviewers running 0\/3 / })).toBeDefined()
})

test('a foreground run shows pi\'s widget lines while it runs, then clears', async ($, on) => {
  const file: Fake = {}
  let finish: (() => void) | undefined
  const clock = stub(on, file, () => new Promise((resolve) => { finish = () => resolve({ result: { stdout: '', stderr: '', interrupted: false } }) }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.settle()

  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /starting/ })).toBeDefined()

  file.mtimeMs = 500
  file.body = {
    ...snapshot('reviewers running', { done: 1, total: 3, latest: '✓ sonnet (1/3) — 2 findings', events: ['✓ sonnet (1/3) — 2 findings'] }),
    activity: ['gpt-6.1-sol review · 40s · turn 3 · 5 tools'],
  }
  await clock.advance(1000)
  expect(await band.find({ type: 'Text', text: / · reviewers running 1\/3 ████░░░░░░░░ · 1s$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'latest: ✓ sonnet (1/3) — 2 findings' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '  ⋯ gpt-6.1-sol review · 40s · turn 3 · 5 tools' })).toBeDefined()

  const spinner = await $.ui.mount(SPINNER)
  expect(await spinner.find({ type: 'Text', text: 'Baking · multi-review: reviewers running 1/3…' })).toBeDefined()

  file.body = snapshot('done', { finished: true })
  finish?.()
  await call
  await clock.settle()
  expect(await band.find({ type: 'Text', text: / · done · / })).toBeDefined()
  await clock.advance(5000)
  expect(await band.find({ type: 'Text', text: / · done · / })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: 'engine' })).toBeDefined()
})

test('a backgrounded run stays until progress.json says it finished', async ($, on) => {
  const file: Fake = { mtimeMs: 10, body: snapshot('grouping findings') }
  const clock = stub(on, file, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  const band = await $.ui.mount(BAND)

  await clock.advance(1000)
  expect(await band.find({ type: 'Text', text: / · grouping findings · / })).toBeDefined()
  await clock.advance(30_000)
  expect(await band.find({ type: 'Text', text: / · grouping findings · / })).toBeDefined()

  file.mtimeMs = 32_000
  file.body = snapshot('done', { finished: true })
  await clock.advance(1000)
  expect(await band.find({ type: 'Text', text: / · done · / })).toBeDefined()
  await clock.advance(5000)
  expect(await band.find({ type: 'Text', text: / · done · / })).toBeUndefined()
})

test('a progress.json left by an earlier run in the same directory is ignored', async ($, on) => {
  const file: Fake = { mtimeMs: 0, body: snapshot('done', { finished: true }) }
  const clock = stub(on, file, () => new Promise(() => {}))
  await clock.set(60_000)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  void $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(1000)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: / · starting · 1s$/ })).toBeDefined()
})

test('other Bash calls draw nothing', async ($, on) => {
  const clock = stub(on, {}, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await clock.advance(1000)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: 'engine' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /multi-review/ })).toBeUndefined()
})
