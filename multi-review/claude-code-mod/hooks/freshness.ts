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
  pr?: number
  /** When the review finished. */
  at: number
  /** pi's run mode (`balanced+verify`). */
  mode: string
  result?: string
}

export type Target = Pick<Review, 'root' | 'branch' | 'sha' | 'pr'>

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

async function run($: EngineInterface, argv: string[], cwd?: string, env?: Record<string, string>): Promise<string | undefined> {
  const r = await $.process.run(argv, { ...(cwd ? { cwd } : {}), ...(env ? { env } : {}), timeoutMs: 15_000 }).catch(() => undefined)
  return r?.exitCode === 0 ? r.stdout.trim() : undefined
}

/**
 * The working tree as git would commit it with `git add -A`: tracked and
 * untracked files, minus ignored ones. `git stash create` and
 * `git diff <commit>` both skip untracked files, and new files are most of
 * a typical change. Staged into an index of the mod's own beside the real
 * one, which is never touched; kept between calls, so its stat cache spares
 * rehashing unchanged files.
 */
export async function snapshot($: EngineInterface, root: string): Promise<string | undefined> {
  const index = await run($, ['git', 'rev-parse', '--path-format=absolute', '--git-path', 'multi-review-index'], root)
  if (!index) return undefined
  const env = { GIT_INDEX_FILE: index }
  if ((await run($, ['git', 'add', '-A'], root, env)) === undefined) return undefined
  return run($, ['git', 'write-tree'], root, env)
}

/** `--brief=<path>` when it's a plain absolute path. */
export function briefPath(command: string): string | undefined {
  const m = command.match(/--brief=(?:"([^"]+)"|'([^']+)'|([^\s"']+))/)
  const path = m && (m[1] ?? m[2] ?? m[3])
  return path && path.startsWith('/') && !/[$`~]/.test(path) ? path : undefined
}

export async function readBrief($: EngineInterface, path: string | undefined): Promise<BriefInfo> {
  if (!path) return {}
  try {
    const b = JSON.parse(await $.fs.read(path)) as Record<string, unknown>
    return {
      socratic: b.socratic === true,
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
  return sha ? { ...here, sha } : undefined
}

export const storeKey = (root: string, branch: string) => `review:${root}:${branch}`

export async function remember($: EngineInterface, review: Review): Promise<void> {
  await $.store.set(storeKey(review.root, review.branch), review).catch(() => undefined)
}

/** `3 files changed, 40 insertions(+), 2 deletions(-)` */
export function parseShortstat(out: string): { files: number; insertions: number; deletions: number } {
  const num = (re: RegExp) => Number(out.match(re)?.[1] ?? 0)
  return { files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?\(\+\)/), deletions: num(/(\d+) deletions?\(-\)/) }
}

/** How far the code here has moved from the last review of this branch, if there was one. */
export async function freshness($: EngineInterface): Promise<Freshness | undefined> {
  const here = await where($)
  if (!here) return undefined
  const review = (await $.store.get(storeKey(here.root, here.branch)).catch(() => undefined)) as Review | undefined
  if (!review?.sha) return undefined
  // ^{tree}: a working-tree snapshot is a tree, a PR head a commit.
  if ((await run($, ['git', 'cat-file', '-e', `${review.sha}^{tree}`], here.root)) === undefined) {
    return { review, files: 0, insertions: 0, deletions: 0, isMissing: true }
  }
  const now = await snapshot($, here.root)
  if (!now) return undefined
  const stat = await run($, ['git', 'diff', '--shortstat', review.sha, now], here.root)
  if (stat === undefined) return undefined
  return { review, ...parseShortstat(stat) }
}

export const isStale = (f: Freshness) => f.isMissing === true || f.insertions + f.deletions > 0

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
