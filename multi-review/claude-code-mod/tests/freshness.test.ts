import type { On, ToolCallResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { briefPath, describe as describeFresh, parseShortstat } from '../hooks/freshness.js'

const DIR = '/tmp/mr-run'
const COMMAND = `pi -p "/multi-review-run --brief=${DIR}/brief.json --out=${DIR}/result.json" < /dev/null`

const BAND = {
  plugin: 'multi-review-status',
  component: 'AbovePrompt',
  surface: 'terminal',
  viewport: { columns: 140, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 135, scroll: { offset: 0, bodyRows: 19 }, view: {} },
} as const

interface Repo {
  brief: unknown
  result: unknown
  /** `git diff --shortstat <reviewed> <now>` output. */
  shortstat: string
  /** What `git write-tree` prints: the working tree, untracked files included. */
  tree: string
  /** Objects that exist. */
  objects: Set<string>
  argvs: string[]
  /** git calls that ran on the real index. */
  onRealIndex: string[]
}

const OWN_INDEX = '/work/.git/multi-review-index'

function stub(on: On, repo: Repo) {
  const clock = mock.clock(on)
  mock.store(on)
  const toasts: string[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('fs.stat', ($, e) => (e.path === `${DIR}/progress.json` ? { value: { kind: 'file', size: 1, mtimeMs: 1e12, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', ($, e) => {
    if (e.path === `${DIR}/brief.json`) return { value: JSON.stringify(repo.brief) }
    if (e.path === `${DIR}/result.json`) return { value: JSON.stringify(repo.result) }
    if (e.path === `${DIR}/progress.json`) return { value: JSON.stringify({ run: { mode: 'balanced+verify', phase: 'done', events: [], startedAt: 0, finished: true }, activity: [] }) }
    return { deny: 'ENOENT' }
  })
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    repo.argvs.push(argv)
    const ownIndex = e.init?.env?.GIT_INDEX_FILE === OWN_INDEX
    if (/^git (add|write-tree)/.test(argv) && !ownIndex) repo.onRealIndex.push(argv)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv === 'git rev-parse --show-toplevel') return out('/work\n')
    if (argv === 'git branch --show-current') return out('feat/x\n')
    if (argv === 'git rev-parse --path-format=absolute --git-path multi-review-index') return out(`${OWN_INDEX}\n`)
    if (argv === 'git add -A') return out('')
    if (argv === 'git write-tree') return out(`${repo.tree}\n`)
    if (argv.startsWith('git cat-file -e ')) return out('', repo.objects.has(argv.slice(16).replace('^{tree}', '')) ? 0 : 1)
    if (argv.startsWith('git diff --shortstat ')) return out(repo.shortstat)
    if (argv.startsWith('gh pr view 4102')) return out(JSON.stringify({ headRefOid: 'prhead', headRefName: 'feat/x' }))
    return out('', 1)
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', (): ToolCallResult => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  return { clock, toasts }
}

const repo = (over: Partial<Repo> = {}): Repo => ({ brief: {}, result: { ok: true }, shortstat: '', tree: 'tree1', objects: new Set(['tree1', 'prhead']), argvs: [], onRealIndex: [], ...over })

test('a successful review covers the code until it changes, and a push after that is flagged', async ($, on) => {
  const r = repo()
  const { clock, toasts } = stub(on, r)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND })
  // the finished run's own line lingers first
  await clock.advance(5000)

  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /✓ covers the code here · just now \(balanced\+verify\)/ })).toBeDefined()
  expect(r.argvs).toContain('git diff --shortstat tree1 tree1')

  r.tree = 'tree2'
  r.shortstat = ' 2 files changed, 10 insertions(+), 3 deletions(-)\n'
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(2500)
  expect(await band.find({ type: 'Text', text: /⚠ \+10 −3 in 2 files since the review/ })).toBeDefined()

  const pushed = await $.tool.call({ tool: 'Bash', command: 'git push -u origin feat/x' })
  expect(toasts.some((t) => /changes made after the last review/.test(t))).toBe(true)
  expect(pushed.context?.join('\n')).toMatch(/review is stale/)
})

test('a file created after the review makes it stale, through the mod\'s own index', async ($, on) => {
  const r = repo()
  const { clock } = stub(on, r)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND })
  // past the finished run's own line
  await clock.advance(5000)

  // an untracked file: only a snapshot that stages untracked files sees it
  r.tree = 'tree2'
  r.shortstat = ' 1 file changed, 4 insertions(+)\n'
  await $.tool.call({ tool: 'Bash', command: 'printf "x\\n" > new.ts' })
  await clock.advance(2500)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /⚠ \+4 −0 in 1 file since the review/ })).toBeDefined()
  expect(r.argvs).toContain('git diff --shortstat tree1 tree2')
  expect(r.argvs.some((a) => a.startsWith('git stash'))).toBe(false)
  expect(r.onRealIndex).toEqual([])
})

test('a PR review is measured from the PR head', async ($, on) => {
  const r = repo({ brief: { pr_number: 4102 } })
  const { clock } = stub(on, r)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.settle()
  expect(r.argvs).toContain('git diff --shortstat prhead tree1')
})

for (const [name, over] of [['a failed run', { result: { ok: false, error: 'x' } }], ['a Socratic discussion', { brief: { socratic: true, topic: 't' } }]] as const) {
  test(`${name} is not a review`, async ($, on) => {
    const r = repo(over)
    const { clock } = stub(on, r)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Bash', command: COMMAND })
    await clock.advance(5000)
    expect(r.argvs.some((a) => a.startsWith('git diff --shortstat'))).toBe(false)
    const band = await $.ui.mount(BAND)
    expect(await band.find({ type: 'Text', text: /covers the code/ })).toBeUndefined()
  })
}

test('a push while the review still covers the code says nothing', async ($, on) => {
  const r = repo()
  const { clock, toasts } = stub(on, r)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.settle()
  const pushed = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(toasts).toEqual([])
  expect(pushed.context).toBeUndefined()
})

test('only a real push of stale code is flagged', async ($, on) => {
  const r = repo()
  const { clock, toasts } = stub(on, r)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.settle()
  r.tree = 'tree2'
  r.shortstat = ' 1 file changed, 1 insertion(+)\n'
  for (const command of ['git stash push -m wip', 'git commit -m "push fix"', 'git log --grep=push']) {
    const ran = await $.tool.call({ tool: 'Bash', command })
    expect(ran.context).toBeUndefined()
  }
  expect(toasts).toEqual([])
  for (const command of ['git -C /work push origin feat/x', 'git add -A && git --no-pager push', 'gh pr ready 4102']) {
    const ran = await $.tool.call({ tool: 'Bash', command })
    expect(ran.context?.join('\n')).toMatch(/review is stale/)
  }
  expect(toasts).toHaveLength(3)
})

test('helpers', () => {
  expect(briefPath(COMMAND)).toBe(`${DIR}/brief.json`)
  expect(briefPath('pi -p "/multi-review-run --brief=$D/b.json"')).toBeUndefined()
  expect(parseShortstat(' 1 file changed, 1 insertion(+)')).toEqual({ files: 1, insertions: 1, deletions: 0 })
  const review = { root: '/w', branch: 'b', sha: 's', at: 0, mode: 'quick' }
  expect(describeFresh({ review, files: 0, insertions: 0, deletions: 0, isMissing: true }, 3 * 3_600_000)).toMatch(/3h ago, but that snapshot is gone/)
})
