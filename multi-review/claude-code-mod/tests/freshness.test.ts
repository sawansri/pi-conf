import type { On, ToolCallResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { briefPath, describe as describeFresh, isStale, parseNumstat } from '../hooks/freshness.js'
import { isPush } from '../hooks/register.js'

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
  /** The change between the reviewed tree and now, as git's summary; the stub serves it as --numstat. */
  shortstat: string
  /** What `git write-tree` prints: the working tree, untracked files included. */
  tree: string
  /** Reads of result.json that find nothing yet (pi writes it just after progress.json). */
  resultMisses?: number
  resultReads?: number
  /** Tracked files matching .gitignore ("S path" outside a sparse checkout), and files deleted from disk (real index). */
  trackedIgnored?: string[]
  deleted?: string[]
  /** Ignored entries in the mod's own index. */
  ownIgnored?: string[]
  /** What `git add -f` and `git rm --cached` were handed on stdin. */
  forced?: string[]
  dropped?: string[]
  /** Untracked files when a run starts; changed files the push lacks (the first changed files). */
  untracked?: string[]
  absentNow?: string[]
  /** Files outside the sparse checkout; unset: not sparse. */
  sparseOut?: string[]
  /** `git rev-parse HEAD^{tree}`: what a push sends. */
  headTree: string
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
    if (e.path === `${DIR}/result.json`) {
      repo.resultReads = (repo.resultReads ?? 0) + 1
      if (repo.resultMisses) {
        repo.resultMisses--
        return { deny: 'ENOENT' }
      }
      return { value: JSON.stringify(repo.result) }
    }
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
    if (argv === 'git rev-parse HEAD^{tree}') return out(`${repo.headTree}\n`)
    const nul = (ps: string[] = []) => out(ps.map((p) => `${p}\0`).join(''))
    const stdin = () => (e.init?.stdin ?? '').split('\0').filter(Boolean)
    if (argv === 'git ls-files -z -d') return nul(repo.deleted)
    if (argv === 'git ls-files -z -t -c -i --exclude-standard') return nul((repo.trackedIgnored ?? []).map((p) => (/^[A-Z] /.test(p) ? p : `H ${p}`)))
    if (argv === 'git ls-files -z -c -i --exclude-standard' && ownIndex) return nul(repo.ownIgnored)
    if (argv === 'git --literal-pathspecs add -A -f --pathspec-from-file=- --pathspec-file-nul' && ownIndex) {
      repo.forced = stdin()
      return out('')
    }
    if (argv === 'git --literal-pathspecs rm --cached -q --ignore-unmatch --pathspec-from-file=- --pathspec-file-nul' && ownIndex) {
      repo.dropped = stdin()
      return out('')
    }
    if (argv === 'git ls-files -z -o --exclude-standard') return nul(repo.untracked)
    if (argv.startsWith('git diff --name-only -z --no-renames --diff-filter=D ')) return nul(repo.absentNow)
    if (argv === 'git config --bool core.sparseCheckout') return repo.sparseOut ? out('true\n') : out('', 1)
    if (argv === 'git ls-files -z -t') return nul([...(repo.sparseOut ?? []).map((p) => `S ${p}`), 'H keep.ts'])
    if (argv.startsWith('git diff --numstat -z --no-renames ')) {
      const [a, b] = argv.slice(35).split(' ')
      if (a === b) return out('')
      const num = (re: RegExp) => Number(repo.shortstat.match(re)?.[1] ?? 0)
      const files = num(/(\d+) files? changed/)
      const names = [...(repo.absentNow ?? []), ...(repo.sparseOut ?? [])]
      while (names.length < files) names.push(`file${names.length}.ts`)
      return out(names.slice(0, files).map((p, i) => `${i ? 0 : num(/(\d+) insertions?/)}\t${i ? 0 : num(/(\d+) deletions?/)}\t${p}\0`).join(''))
    }
    if (argv === 'git write-tree') return out(`${repo.tree}\n`)
    if (argv.startsWith('git cat-file -e ')) return out('', repo.objects.has(argv.slice(16).replace('^{tree}', '')) ? 0 : 1)
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

const repo = (over: Partial<Repo> = {}): Repo => ({ brief: {}, result: { ok: true }, shortstat: '', tree: 'tree1', headTree: 'tree1', objects: new Set(['tree1', 'prhead']), argvs: [], onRealIndex: [], ...over })

test('a successful review covers the code until it changes, and a push after that is flagged', async ($, on) => {
  const r = repo()
  const { clock, toasts } = stub(on, r)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND })
  // the finished run's own line lingers first
  await clock.advance(5000)

  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /✓ covers the code here · just now \(balanced\+verify\)/ })).toBeDefined()
  expect(r.argvs).toContain('git diff --numstat -z --no-renames tree1 tree1')

  r.tree = 'tree2'
  r.shortstat = ' 2 files changed, 10 insertions(+), 3 deletions(-)\n'
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(2500)
  expect(await band.find({ type: 'Text', text: /⚠ \+10 −3 in 2 files since the review/ })).toBeDefined()

  r.headTree = 'tree2' // committed
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
  expect(r.argvs).toContain('git diff --numstat -z --no-renames tree1 tree2')
  expect(r.argvs.some((a) => a.startsWith('git stash'))).toBe(false)
  expect(r.onRealIndex).toEqual([])
})

test('a PR review is measured from the PR head', async ($, on) => {
  const r = repo({ brief: { pr_number: 4102 } })
  const { clock } = stub(on, r)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.settle()
  expect(r.argvs).toContain('git diff --numstat -z --no-renames prhead tree1')
})

for (const [name, over] of [
  ['a failed run', { result: { ok: false, error: 'x' } }],
  ['a Socratic discussion', { brief: { socratic: true, topic: 't' } }],
  ['a discussion briefed with `discuss`', { brief: { discuss: true, topic: 't' } }],
  ['a discussion briefed with `mode`', { brief: { mode: 'Socratic', topic: 't' } }],
  ['a discussion briefed with `rounds`', { brief: { rounds: 3, topic: 't' } }],
] as const) {
  test(`${name} is not a review`, async ($, on) => {
    const r = repo(over)
    const { clock } = stub(on, r)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Bash', command: COMMAND })
    await clock.advance(5000)
    expect(r.argvs.some((a) => a.startsWith('git diff --numstat'))).toBe(false)
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
  r.headTree = 'tree2'
  r.shortstat = ' 1 file changed, 1 insertion(+)\n'
  for (const command of ['git stash push -m wip', 'git commit -m "push fix"', 'git log --grep=push', 'git commit -m "remember to git push later"']) {
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

test('a push is measured by what it sends: uncommitted edits don\'t count', async ($, on) => {
  const r = repo()
  const { clock, toasts } = stub(on, r)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.settle()
  r.tree = 'tree2'
  r.shortstat = ' 1 file changed, 2 insertions(+)\n'
  const pushed = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(toasts).toEqual([])
  expect(pushed.context).toBeUndefined()
})

test('a push leaves out untracked files nobody committed', async ($, on) => {
  const r = repo({ untracked: ['notes.txt'], absentNow: ['notes.txt'], shortstat: ' 1 file changed, 3 deletions(-)\n' })
  const { clock, toasts } = stub(on, r)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.settle()
  r.headTree = 'tree2'
  const pushed = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(toasts).toEqual([])
  expect(pushed.context).toBeUndefined()
})

test('a push of a file deleted and committed after the review is flagged', async ($, on) => {
  // gone.ts was tracked when reviewed (not added on top of HEAD's tree), and the push lacks it
  const r = repo({ untracked: ['notes.txt'], absentNow: ['gone.ts'], shortstat: ' 1 file changed, 12 deletions(-)\n' })
  const { clock, toasts } = stub(on, r)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.settle()
  r.headTree = 'tree2'
  const pushed = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(toasts).toHaveLength(1)
  expect(pushed.context?.join('\n')).toMatch(/\+0 −12 in 1 files/)
})

test('tracked files matching .gitignore are snapshotted, except ones deleted from disk', async ($, on) => {
  const r = repo({ trackedIgnored: ['dist/app.js', 'dist/old.js'], deleted: ['dist/old.js'] })
  const { clock } = stub(on, r)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.settle()
  expect(r.forced).toEqual(['dist/app.js'])
})

test('files outside a sparse checkout, or untracked again since, stay out of the snapshot', async ($, on) => {
  const r = repo({ trackedIgnored: ['dist/app.js', 'S vendor/lib.js'], ownIgnored: ['dist/app.js', 'dist/old.js'] })
  const { clock } = stub(on, r)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.settle()
  expect(r.forced).toEqual(['dist/app.js'])
  expect(r.dropped).toEqual(['dist/old.js'])
})

test('a push of a sparse checkout leaves out the files it never had', async ($, on) => {
  const r = repo({ untracked: [], sparseOut: ['vendor/lib.js'], shortstat: ' 1 file changed, 40 insertions(+)\n' })
  const { clock, toasts } = stub(on, r)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.settle()
  r.headTree = 'tree2'
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(toasts).toEqual([])
})

test('a file staged when reviewed, then committed and deleted, makes a push stale', async ($, on) => {
  // staged, so not among the untracked files when the run started
  const r = repo({ untracked: ['notes.txt'], absentNow: ['new.txt'], shortstat: ' 1 file changed, 2 deletions(-)\n' })
  const { clock, toasts } = stub(on, r)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.settle()
  r.headTree = 'tree2'
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(toasts).toHaveLength(1)
})

test('a run whose result.json lands after progress.json says finished is still recorded', async ($, on) => {
  const r = repo({ resultMisses: 1 })
  const { clock } = stub(on, r)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: COMMAND })
  expect(r.resultReads).toBe(1)
  expect(r.argvs.some((a) => a.startsWith('git diff --numstat'))).toBe(false)
  await clock.advance(1500)
  expect(r.resultReads).toBe(2)
  expect(r.argvs).toContain('git diff --numstat -z --no-renames tree1 tree1')
})

test('helpers', () => {
  // a rename, a mode change or a binary file changes no lines
  const review = { root: '/w', branch: 'b', sha: 's', at: 0, mode: 'quick' }
  expect(isStale({ review, files: 1, insertions: 0, deletions: 0 })).toBe(true)
  // -z keeps a path's leading space; a binary file has no line counts
  expect(parseNumstat('3\t1\t a.ts\0-\t-\tlogo.png\0')).toEqual([{ path: ' a.ts', insertions: 3, deletions: 1 }, { path: 'logo.png', insertions: 0, deletions: 0 }])
  expect(isPush('git commit -m "remember to git push later"')).toBe(false)
  expect(isPush("git log --format='%s' && git push")).toBe(true)
  expect(isPush("python3 - <<'EOF'\nrun('git push -u origin x')\nEOF\ngit status")).toBe(false)
  expect(isPush("cat > f <<EOF\nx\nEOF\ngit push")).toBe(true)
  expect(isPush('git push-to-checkout')).toBe(false)
  expect(isPush('git log --oneline # git push later')).toBe(false)
  expect(isPush('git log # note\ngit push')).toBe(true)
  expect(briefPath(COMMAND)).toBe(`${DIR}/brief.json`)
  expect(briefPath('pi -p "/multi-review-run --brief=$D/b.json"')).toBeUndefined()
  expect(describeFresh({ review, files: 0, insertions: 0, deletions: 0, isMissing: true }, 3 * 3_600_000)).toMatch(/3h ago, but that snapshot is gone/)
})
