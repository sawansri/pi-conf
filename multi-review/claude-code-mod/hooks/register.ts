import type { EngineInterface, On, Timer } from 'claude-code'

import { age, briefPath, captureTarget, describe, type Freshness, freshness, isStale, readBrief, remember, type Target } from './freshness'

// Shows a running multi-review in Claude Code the way pi's progress widget
// does. The skill runs `pi -p "/multi-review-run --brief=… --out=<dir>/result.json"`
// through Bash; the run rewrites <dir>/progress.json every 2s with the
// widget's state (`run`) and one line per running reviewer (`activity`).
// This mod notices that Bash call, finds the run's progress.json, polls it,
// and draws the lines in the band above the prompt, with a short phase
// after the spinner's word.
//
// The progress.json is `--out`'s directory when that's a plain absolute path.
// Otherwise (`--out=$D/…`, a relative path after a `cd`) it's the one the
// run announces in ~/.cache/multi-review/runs/<pid>.json
// (extension/src/headless.ts RUNS_DIR).
//
// Between runs it says whether the last successful review still covers the
// code (hooks/freshness.ts): a warning line while anything changed since,
// and a note to the model and a toast when such a change is pushed.

const POLL_MS = 1000
/** pi clears its widget this long after a run ends. */
const LINGER_MS = 4000
/** Drop a background run whose progress.json stopped changing this long ago. */
const STALE_MS = 2 * 60_000
const BAR_WIDTH = 12
/** A run's announcement may land a little before the mod's clock read. */
const ANNOUNCE_SLACK_MS = 2000
/** A review that still covers the code is shown this long after it finished. */
const FRESH_SHOWN_MS = 15 * 60_000
/** Tools after which the code may have changed. */
const CHANGES_CODE = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** `git push` (after any global options, like `-C dir`), not `git stash push`; `gh pr create/ready/merge`. */
const PUSHES = /\bgit(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+push(?![\w-])|\bgh\s+pr\s+(?:ready|merge|create)(?![\w-])/

/** progress.json's `run`: pi's progress widget state (extension/src/progress.ts RunSnapshot). */
interface RunSnapshot {
  mode: string
  phase: string
  done?: number
  total?: number
  latest?: string
  events: string[]
  startedAt: number
  finished: boolean
}

interface Run {
  /** The run's progress.json, once known. */
  progress?: string
  startedAt: number
  background: boolean
  endedAt?: number
  snap?: RunSnapshot
  /** pi's per-reviewer activity lines. */
  activity?: string[]
  /** What the reviewers read, captured as the run started. */
  target?: Promise<Target | undefined>
  isRecorded?: boolean
  isRecording?: boolean
}

interface Line {
  head?: string
  text: string
  isWarning?: boolean
}

/** Runs being shown, oldest first. */
let runs: Run[] = []
/** pids of announced runs already matched to a Bash call. */
const claimed = new Set<number>()
/** How the last review of this branch compares with the code now. */
let fresh: Freshness | undefined
let refreshTimer: Timer | undefined

/** Whether `command` pushes; heredoc bodies and quoted text (a commit message, a script) don't count. */
export function isPush(command: string): boolean {
  const code = command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, '')
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
    .replace(/(^|\s)#[^\n]*/g, '$1')
  return PUSHES.test(code)
}

export function isRunCommand(command: unknown): command is string {
  return typeof command === 'string' && command.includes('/multi-review-run')
}

/**
 * `<dir>` of `--out=<dir>/result.json` when it's a plain absolute path, else
 * undefined: a shell variable, `~` or a relative path (after a `cd`) can't be
 * resolved here.
 */
export function outDir(command: string): string | undefined {
  const m = command.match(/--out=(?:"([^"]+)"|'([^']+)'|([^\s"']+))/)
  const out = m && (m[1] ?? m[2] ?? m[3])
  if (!out || !out.startsWith('/') || /[$`~]/.test(out)) return undefined
  return out.slice(0, out.lastIndexOf('/')) || '/'
}

/** Matches the run to the earliest unclaimed announcement made after its Bash call started. */
async function claim($: EngineInterface, run: Run): Promise<void> {
  const home = await $.env.get('HOME')
  if (!home) return
  const dir = `${home}/.cache/multi-review/runs`
  const entries = await $.fs.list(dir).catch(() => [])
  let best: { pid: number, progress: string, startedAt: number } | undefined
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    let a: { pid?: unknown, progress?: unknown, startedAt?: unknown }
    try {
      a = JSON.parse(await $.fs.read(`${dir}/${entry.name}`))
    } catch {
      continue
    }
    if (typeof a.pid !== 'number' || typeof a.progress !== 'string' || typeof a.startedAt !== 'number') continue
    if (claimed.has(a.pid) || a.startedAt < run.startedAt - ANNOUNCE_SLACK_MS) continue
    if (!best || a.startedAt < best.startedAt) best = { pid: a.pid, progress: a.progress, startedAt: a.startedAt }
  }
  if (!best) return
  claimed.add(best.pid)
  run.progress = best.progress
}

function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000))
  return secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s` : `${secs}s`
}

function counts(snap: RunSnapshot | undefined): string {
  return snap && snap.done !== undefined && snap.total !== undefined ? ` ${snap.done}/${snap.total}` : ''
}

function bar(snap: RunSnapshot | undefined): string {
  if (!snap || snap.done === undefined || snap.total === undefined) return ''
  const pct = snap.total ? Math.max(0, Math.min(1, snap.done / snap.total)) : 0
  const filled = Math.round(pct * BAR_WIDTH)
  return ` ${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`
}

function phaseOf(run: Run): string {
  if (run.snap) return run.snap.phase
  return run.endedAt === undefined ? 'starting' : 'ended'
}

/** The band's lines for one run: header, latest, the last events, live reviewers. */
export function runLines(run: Run, now: number): Line[] {
  const snap = run.snap
  const startedAt = snap?.startedAt ?? run.startedAt
  const elapsed = formatElapsed((run.endedAt ?? now) - startedAt)
  const lines: Line[] = [{
    head: `multi-review · ${snap?.mode ?? 'run'}`,
    text: ` · ${phaseOf(run)}${counts(snap)}${bar(snap)} · ${elapsed}`,
  }]
  if (snap?.latest) lines.push({ text: `latest: ${snap.latest}` })
  for (const ev of snap?.events ?? []) lines.push({ text: `  ${ev}` })
  if (run.endedAt === undefined) for (const a of run.activity ?? []) lines.push({ text: `  ⋯ ${a}` })
  return lines
}

/** Reads the run's progress.json into it; a file older than the run is a previous run's. */
async function poll($: EngineInterface, run: Run): Promise<void> {
  if (!run.progress) await claim($, run)
  const path = run.progress
  if (!path) return
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat || stat.mtimeMs < run.startedAt - 1000) return
  const now = await $.clock.now()
  let parsed: { run?: RunSnapshot, activity?: unknown }
  try {
    parsed = JSON.parse(await $.fs.read(path))
  } catch {
    return // caught mid-write; the next poll gets it
  }
  run.activity = Array.isArray(parsed.activity) ? parsed.activity.filter((a): a is string => typeof a === 'string') : []
  if (parsed.run) run.snap = parsed.run
  if (run.endedAt === undefined && parsed.run?.finished) run.endedAt = now
  if (run.endedAt === undefined && run.background && now - stat.mtimeMs > STALE_MS) run.endedAt = now
}

async function refresh($: EngineInterface): Promise<void> {
  fresh = await freshness($).catch(() => undefined)
  $.ui.invalidate('ui.render')
}

/** Refreshes once the burst of tool calls that may have changed the code settles. */
function refreshSoon($: EngineInterface): void {
  refreshTimer?.cancel()
  refreshTimer = $.clock.after(2000, () => void refresh($))
}

/** Keeps an ended run as the branch's last review when its result.json says it succeeded. */
async function keepReview($: EngineInterface, run: Run): Promise<void> {
  if (run.isRecorded || run.isRecording) return
  run.isRecording = true
  try {
    const target = await run.target
    if (!target || !run.progress) {
      run.isRecorded = true
      return
    }
    const result = `${run.progress.slice(0, run.progress.lastIndexOf('/'))}/result.json`
    let ok: unknown
    try {
      ok = (JSON.parse(await $.fs.read(result)) as { ok?: unknown }).ok
    } catch {
      // pi marks progress.json finished just before it writes result.json: try again next tick.
      return
    }
    run.isRecorded = true
    if (ok !== true) return
    await remember($, { ...target, at: await $.clock.now(), mode: run.snap?.mode ?? 'review', result: result.replace(/\.json$/, '.md') })
    await refresh($)
  } finally {
    run.isRecording = false
  }
}

async function tick($: EngineInterface): Promise<void> {
  if (runs.length === 0) return
  const now = await $.clock.now()
  for (const run of runs) if (run.endedAt === undefined) await poll($, run)
  for (const run of runs) if (run.endedAt !== undefined && !run.isRecorded) await keepReview($, run)
  runs = runs.filter((r) => r.endedAt === undefined || now - r.endedAt < LINGER_MS)
  $.ui.invalidate('ui.render')
}

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    $.clock.every(POLL_MS, () => tick($))
    void refresh($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    refreshSoon($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (CHANGES_CODE.has(String(e.tool))) refreshSoon($)
    return ran
  }).catch(($, e, next) => next(e))

  // The Bash call that starts a run. A foreground run ends when the call
  // returns; a backgrounded one when progress.json says it finished.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isRunCommand(e.command)) {
      if (!isPush(e.command)) return next(e)
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError) return ran
      const f = await freshness($, 'HEAD').catch(() => undefined)
      if (!f || !isStale(f)) return ran
      const since = f.isMissing ? 'by an unknown amount' : `by +${f.insertions} −${f.deletions} in ${f.files} files`
      $.ui.toast(`multi-review: this push includes changes made after the last review (${since})`, { timeoutMs: 8000 })
      const note = `multi-review-status: the code pushed has changed ${since} since the last multi-review of ${f.review.branch} (${age((await $.clock.now()) - f.review.at)}, ${f.review.mode}, ${f.review.result ?? 'result unknown'}). Tell the user the review is stale and offer to run it again.`
      return { ...ran, context: [...(ran.context ?? []), note] }
    }
    const dir = outDir(e.command)
    const run: Run = { startedAt: await $.clock.now(), background: e.run_in_background === true }
    run.target = readBrief($, briefPath(e.command)).then((brief) => captureTarget($, brief)).catch(() => undefined)
    if (dir) run.progress = `${dir}/progress.json`
    runs = [...runs.filter((r) => !run.progress || r.progress !== run.progress), run]
    $.ui.invalidate('ui.render')
    try {
      const result = await next(e)
      const record = 'result' in result ? (result.result as { backgroundTaskId?: string } | undefined) : undefined
      if (record?.backgroundTaskId) run.background = true
      else {
        await poll($, run)
        run.endedAt ??= await $.clock.now()
        if (!('isError' in result && result.isError)) await keepReview($, run)
      }
      return result
    } catch (err) {
      run.endedAt ??= await $.clock.now()
      throw err
    } finally {
      $.ui.invalidate('ui.render')
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await $.clock.now()
    const lines = runs.flatMap((run) => runLines(run, now))
    if (runs.length === 0 && fresh && (isStale(fresh) || now - fresh.review.at < FRESH_SHOWN_MS)) {
      lines.push({ head: 'multi-review', text: describe(fresh, now), isWarning: isStale(fresh) })
    }
    if (lines.length === 0 || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const ours = lines.map((line) =>
      line.head
        ? Text({ wrap: 'truncate-end', children: [Text({ color: line.isWarning ? 'warning' : 'claude', children: [line.head] }), line.text] })
        : Text({ wrap: 'truncate-end', dimColor: true, children: [line.text] }),
    )
    const theirs = await next(e)
    return Box({ flexDirection: 'column', children: theirs ? [...ours, theirs] : ours })
  })

  // A compact phase after the spinner's word; the only view in VS Code, which has no band.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const run = runs.findLast((r) => r.endedAt === undefined)
    if (!run) return next(e)
    return next({ ...e, props: { ...e.props, suffix: ` · multi-review: ${phaseOf(run)}${counts(run.snap)}…` } })
  })
}
