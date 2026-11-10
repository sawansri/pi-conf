import type { EngineInterface } from 'claude-code'

// Whether the last multi-review still covers the code. When a run starts,
// the mod captures what the reviewers read: the working tree, untracked
// files included, as a tree (snapshot below), or the PR head for a PR
// review. When the run succeeds, that tree or commit is kept per repository
// and branch in $.store, across sessions. Afterwards
// `git diff --shortstat <reviewed> <snapshot now>` says how much changed since.

export interface Review {
  root: string
  branch: string
  /** The tree (or PR-head commit) the reviewers read. */
  sha: string
  /**
   * Files untracked when a working tree was reviewed: still uncommitted at
   * a push, they're scratch (notes), not pushed. Unset for PR reviews and
   * reviews recorded before this was kept.
   */
  untracked?: string[]
  pr?: number
  /** When the review finished. */
  at: number
  /** pi's run mode (`balanced+verify`). */
  mode: string
  result?: string
}

export type Target = Pick<Review, 'root' | 'branch' | 'sha' | 'pr' | 'untracked'>

export interface Freshness {
  review: Review
  files: number
  insertions: number
  deletions: number
  /** The reviewed tree is gone (gc'd, or another clone): changes are unknown. */
  isMissing?: boolean
}

export interface BriefInfo {
  socratic?: boolean
  pr_number?: number
}

interface RunOpts {
  env?: Record<string, string>
  stdin?: string
  /** Keep stdout as is: `-z` output, where a path may start with a space. */
  raw?: boolean
}

async function run($: EngineInterface, argv: string[], cwd?: string, opts: RunOpts = {}): Promise<string | undefined> {
  const { env, stdin, raw } = opts
  const r = await $.process.run(argv, { ...(cwd ? { cwd } : {}), ...(env ? { env } : {}), ...(stdin !== undefined ? { stdin } : {}), timeoutMs: 15_000 }).catch(() => undefined)
  if (r?.exitCode !== 0) return undefined
  return raw ? r.stdout : r.stdout.trim()
}

/** NUL-separated paths (`git … -z`). */
const paths = (out: string | undefined) => (out ?? '').split('\0').filter(Boolean)
const nulJoined = (ps: string[]) => ps.map((p) => `${p}\0`).join('')

/**
 * The working tree as git would commit it with `git add -A`: tracked and
 * untracked files, minus ignored ones. `git stash create` and
 * `git diff <commit>` both skip untracked files, and new files are most of
 * a typical change. Staged into an index of the mod's own beside the real
 * one, which is never touched; kept between calls, so its stat cache spares
 * rehashing unchanged files.
 */
export function snapshot($: EngineInterface, root: string): Promise<string | undefined> {
  // One at a time: overlapping calls (a refresh, a run starting, a push) would fail on the index's lock.
  const next = snapshots.then(() => snapshotNow($, root))
  snapshots = next.catch(() => undefined)
  return next
}

let snapshots: Promise<unknown> = Promise.resolve()

async function snapshotNow($: EngineInterface, root: string): Promise<string | undefined> {
  const index = await run($, ['git', 'rev-parse', '--path-format=absolute', '--git-path', 'multi-review-index'], root)
  if (!index) return undefined
  const own: RunOpts = { env: { GIT_INDEX_FILE: index } }
  if ((await run($, ['git', 'add', '-A'], root, own)) === undefined) return undefined
  // Tracked files that match .gitignore (a committed build output): `add -A`
  // into a fresh index skips them as ignored, so force-add them, by literal
  // name (`:x` or `a[1]` would be pathspec magic). Not the ones off disk:
  // deleted (`add -A` already dropped them) or outside a sparse checkout
  // (tag S); naming a path that isn't there fails the add.
  const listed = paths(await run($, ['git', 'ls-files', '-z', '-t', '-c', '-i', '--exclude-standard'], root, { raw: true }))
    .map((e) => ({ tag: e[0], path: e.slice(2) }))
  const tracked = new Set(listed.map((e) => e.path))
  const deleted = new Set(paths(await run($, ['git', 'ls-files', '-z', '-d'], root, { raw: true })))
  const present = listed.filter((e) => e.tag !== 'S' && !deleted.has(e.path)).map((e) => e.path)
  // Force-added once, an entry stays in this index after the real one stops
  // tracking it (`git rm --cached`); it's an ignored file again, so drop it.
  const untracked = paths(await run($, ['git', 'ls-files', '-z', '-c', '-i', '--exclude-standard'], root, { ...own, raw: true })).filter((p) => !tracked.has(p))
  if (untracked.length > 0) {
    await run($, ['git', '--literal-pathspecs', 'rm', '--cached', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], root, { ...own, stdin: nulJoined(untracked) })
  }
  // Best effort: a snapshot short of a few build outputs beats none.
  if (present.length > 0) {
    await run($, ['git', '--literal-pathspecs', 'add', '-A', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], root, { ...own, stdin: nulJoined(present) })
  }
  return run($, ['git', 'write-tree'], root, own)
}

/** `--brief=<path>` when it's a plain absolute path. */
export function briefPath(command: string): string | undefined {
  const m = command.match(/--brief=(?:"([^"]+)"|'([^']+)'|([^\s"']+))/)
  const path = m && (m[1] ?? m[2] ?? m[3])
  return path && path.startsWith('/') && !/[$`~]/.test(path) ? path : undefined
}

/**
 * Whether pi runs the brief as a Socratic discussion, by its rules
 * (extension/src/headless.ts parseReviewRequest): `socratic`, else
 * `discuss`, `mode: "socratic"|"discuss"`, or `rounds`.
 */
export function isSocratic(b: Record<string, unknown>): boolean {
  if (typeof b.socratic === 'boolean') return b.socratic
  if (typeof b.discuss === 'boolean') return b.discuss
  if (typeof b.mode === 'string' && ['socratic', 'discuss'].includes(b.mode.toLowerCase())) return true
  return typeof b.rounds === 'number'
}

export async function readBrief($: EngineInterface, path: string | undefined): Promise<BriefInfo> {
  if (!path) return {}
  try {
    const b = JSON.parse(await $.fs.read(path)) as Record<string, unknown>
    return {
      socratic: isSocratic(b),
      ...(typeof b.pr_number === 'number' ? { pr_number: b.pr_number } : typeof b.pr_number === 'string' && /^\d+$/.test(b.pr_number) ? { pr_number: Number(b.pr_number) } : {}),
    }
  } catch {
    return {}
  }
}

/** The repository and branch the session is in, or undefined outside git. */
export async function where($: EngineInterface): Promise<{ root: string; branch: string } | undefined> {
  const root = await run($, ['git', 'rev-parse', '--show-toplevel'])
  if (!root) return undefined
  const branch = (await run($, ['git', 'branch', '--show-current'], root)) || 'HEAD'
  return { root, branch }
}

/** What the reviewers of a run starting now will read. */
export async function captureTarget($: EngineInterface, brief: BriefInfo): Promise<Target | undefined> {
  if (brief.socratic) return undefined
  const here = await where($)
  if (!here) return undefined
  if (brief.pr_number !== undefined) {
    const out = await run($, ['gh', 'pr', 'view', String(brief.pr_number), '--json', 'headRefOid,headRefName'], here.root)
    if (!out) return undefined
    try {
      const pr = JSON.parse(out) as { headRefOid: string; headRefName: string }
      return { root: here.root, branch: pr.headRefName, sha: pr.headRefOid, pr: brief.pr_number }
    } catch {
      return undefined
    }
  }
  const sha = await snapshot($, here.root)
  if (!sha) return undefined
  // Kept for the push check; a list this long is a build tree, not notes.
  const untracked = paths(await run($, ['git', 'ls-files', '-z', '-o', '--exclude-standard'], here.root, { raw: true }))
  return { ...here, sha, ...(untracked.length <= MAX_UNTRACKED_KEPT ? { untracked } : {}) }
}

const MAX_UNTRACKED_KEPT = 2000

export const storeKey = (root: string, branch: string) => `review:${root}:${branch}`

export async function remember($: EngineInterface, review: Review): Promise<void> {
  await $.store.set(storeKey(review.root, review.branch), review).catch(() => undefined)
}

/**
 * How far the code here has moved from the last review of this branch, if
 * there was one: the working tree, or `HEAD` (what a push sends).
 */
export async function freshness($: EngineInterface, against: 'worktree' | 'HEAD' = 'worktree'): Promise<Freshness | undefined> {
  const here = await where($)
  if (!here) return undefined
  const review = (await $.store.get(storeKey(here.root, here.branch)).catch(() => undefined)) as Review | undefined
  if (!review?.sha) return undefined
  // ^{tree}: a working-tree snapshot is a tree, a PR head a commit.
  if ((await run($, ['git', 'cat-file', '-e', `${review.sha}^{tree}`], here.root)) === undefined) {
    return { review, files: 0, insertions: 0, deletions: 0, isMissing: true }
  }
  const now = against === 'HEAD' ? await run($, ['git', 'rev-parse', 'HEAD^{tree}'], here.root) : await snapshot($, here.root)
  if (!now) return undefined
  // Per file, so a push can leave some out; no pathspecs (a directory's
  // exclusion would hide new files under it, and argv has a size limit).
  const numstat = await run($, ['git', 'diff', '--numstat', '-z', '--no-renames', review.sha, now], here.root, { raw: true })
  if (numstat === undefined) return undefined
  let files = parseNumstat(numstat)
  if (against === 'HEAD') files = await pushedFiles($, here.root, review, now, files)
  return { review, files: files.length, insertions: sum(files, 'insertions'), deletions: sum(files, 'deletions') }
}

interface FileStat {
  path: string
  insertions: number
  deletions: number
}

const sum = (fs: FileStat[], k: 'insertions' | 'deletions') => fs.reduce((n, f) => n + f[k], 0)

/** `git diff --numstat -z --no-renames`: "added\tdeleted\tpath\0"; a binary file is "-\t-\tpath". */
export function parseNumstat(out: string): FileStat[] {
  return paths(out).flatMap((entry) => {
    const m = entry.match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/)
    if (!m) return []
    const [, ins = '-', del = '-', path = ''] = m
    return [{ path, insertions: ins === '-' ? 0 : Number(ins), deletions: del === '-' ? 0 : Number(del) }]
  })
}

/**
 * At a push, the changed files that are part of it. Left out: files that
 * were untracked when reviewed and still aren't committed (scratch notes,
 * in the snapshot but never pushed), and files outside a sparse checkout
 * (never on disk, so never reviewed). A review recorded before untracked
 * files were kept leaves out every deletion instead, as before.
 */
async function pushedFiles($: EngineInterface, root: string, review: Review, head: string, files: FileStat[]): Promise<FileStat[]> {
  if (review.pr !== undefined || files.length === 0) return files
  const gone = new Set(paths(await run($, ['git', 'diff', '--name-only', '-z', '--no-renames', '--diff-filter=D', review.sha, head], root, { raw: true })))
  const scratch = review.untracked ? new Set(review.untracked.filter((p) => gone.has(p))) : gone
  const sparse = (await run($, ['git', 'config', '--bool', 'core.sparseCheckout'], root)) === 'true'
    ? new Set(paths(await run($, ['git', 'ls-files', '-z', '-t'], root, { raw: true })).filter((e) => e.startsWith('S ')).map((e) => e.slice(2)))
    : new Set<string>()
  return files.filter((f) => !scratch.has(f.path) && !sparse.has(f.path))
}

/** Any file: renames, mode changes and binary files change no lines. */
export const isStale = (f: Freshness) => f.isMissing === true || f.files > 0

export function age(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

/** The band's words for it. */
export function describe(f: Freshness, now: number): string {
  const when = age(now - f.review.at)
  if (f.isMissing) return ` · ⚠ reviewed ${when}, but that snapshot is gone; changes since are unknown`
  if (!isStale(f)) return ` · ✓ covers the code here · ${when} (${f.review.mode})`
  return ` · ⚠ +${f.insertions} −${f.deletions} in ${f.files} file${f.files === 1 ? '' : 's'} since the review ${when} (${f.review.mode})`
}
