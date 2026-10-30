import type { EngineInterface, Register, RenderChildren, RenderSurface, Timer } from 'claude-code'

import type {
  Advice,
  HistoryCache,
  LoadState,
  Report,
  ReviewState,
  SessionSummary,
  StepReport,
  Tab,
  TaskReport,
} from '../types'
import {
  type Action,
  actionsFor,
  adviceActions,
  advise,
  insight,
  isActionText,
  projectLabel,
  rulesForAll,
  summarize,
  usdOf,
} from './advise'
import { createReader, fmtTokens, type SubagentInput, type TranscriptReader } from './analyze'
import { historySvg, mixParts, mixSvg, pulseSvg, ringSvg, SERIES, sparkline, STATUS, timelineSvg } from './charts'
import {
  type AppProc,
  type DiskGroup,
  type DiskItem,
  fmtAge,
  fmtBytes,
  heavyApps,
  isClaudeCli,
  isSafeToTrash,
  type MemoryInfo,
  owningCli,
  parseDu,
  parseLsofCwd,
  parseMemory,
  parsePs,
  parseStat,
  REBUILDABLE,
  type SessionProc,
  sessionIdOf,
  sessionProcs,
} from './storage'

type $ = EngineInterface

const PANE = 'session-progress'
const COMMAND = 'progress'
const FRAMES = 12
const FRAME_MS = 100
const LIVE_REFRESH_MS = 15_000
const READ_LIMIT = 4 * 1024 * 1024 - 4096
const WINDOW = 3 * 1024 * 1024
const HISTORY_PAGE = 30
const TASKS_SHOWN = 25
const ITEMS_SHOWN = 8
const SVG_LIMIT = 120_000
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

type Load = LoadState & { done?: number; total?: number }
type StorageTab = 'storage'
type PaneTab = Tab | StorageTab

type Storage = {
  scannedAt: number
  memory: MemoryInfo
  sessions: SessionProc[]
  apps: AppProc[]
  groups: DiskGroup[]
  /** Paths the scan found exactly, which may go to the Trash. */
  found: string[]
  keep: string[]
  home: string
}

/** What the pane draws. A reload starts it over; /progress reads the log again. */
const view = {
  report: null as Report | null,
  load: { status: 'idle' } as Load,
  frame: FRAMES,
  tab: 'overview' as PaneTab,
  isTurnRunning: false,
  lastActivity: 0,
  usage: null as { tokens: number | null; window: number; percent: number | null } | null,
  review: { status: 'idle' } as ReviewState,
  transcriptPath: null as string | null,
  history: [] as SessionSummary[],
  historyLimit: HISTORY_PAGE,
  historyAvailable: 0,
  historyLoad: { status: 'idle' } as Load,
  isProjectOnly: false,
  selected: null as SessionSummary | null,
  selectedReport: null as Report | null,
  selectedLoad: { status: 'idle' } as Load,
  isAllTasks: false,
  storage: null as Storage | null,
  storageLoad: { status: 'idle' } as Load,
  storageDays: 30,
  expanded: new Set<string>(),
  pending: null as string | null,
  sent: new Set<string>(),
  held: null as Action | null,
  draft: null as Action | null,
  notice: null as { text: string; isError: boolean; at: number } | null,
  dismissed: null as Advice['verdict'] | null,
}

let cache: HistoryCache | null = null
let ticker: Timer | undefined
let live: Timer | undefined
let isPaneOpen = false
let isBusy = false
let isIndexing = false
let isScanning = false
/** The live session's log, read once and then only from where it left off. */
let liveLog: { path: string; offset: number; reader: TranscriptReader } | null = null
const subagentCache = new Map<string, { size: number; input: SubagentInput }>()
/** Prompts this load sent and expects to start turns: a click queued before a reload is not among them. */
const expected = new Map<string, number>()
let skipped = 0

const redraw = ($: $): void => $.ui.invalidate('ui.render')

// ---------------------------------------------------------------- animation

const ease = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)

/** Plays the entrance: counters count up and bars grow over FRAMES frames. */
const animate = ($: $): void => {
  ticker?.cancel()
  let n = 0
  view.frame = 0
  redraw($)
  ticker = $.clock.every(FRAME_MS, () => {
    n += 1
    view.frame = n
    redraw($)
    if (n >= FRAMES) {
      ticker?.cancel()
      ticker = undefined
    }
  })
}

const spin = ($: $): void => {
  ticker?.cancel()
  let n = 0
  ticker = $.clock.every(FRAME_MS, () => {
    n += 1
    view.frame = n
    redraw($)
  })
}

// ---------------------------------------------------------------- status and errors

const folders = async ($: $) => {
  const home = (await $.env.get('HOME')) ?? ''
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`

  return {
    home,
    config,
    projects: `${config}/projects`,
    cacheFile: `${config}/session-progress/history.json`,
    logFile: `${config}/session-progress/actions.log`,
  }
}

/** Shown at the top of the pane for a few seconds, and as a toast where the surface shows them. */
const notify = ($: $, text: string, isError = false): void => {
  const at = Date.now()
  view.notice = { text, isError, at }
  redraw($)
  try {
    $.ui.toast(text)
  } catch {
    // The pane line is enough.
  }
  $.clock.after(9000, () => {
    if (view.notice?.at === at) {
      view.notice = null
      redraw($)
    }
  })
}

/** Keeps the last 200 failures in ~/.claude/session-progress/actions.log, for finding out what went wrong. */
const logFailure = async ($: $, what: string, error: unknown): Promise<void> => {
  const { logFile } = await folders($)
  const before = await $.fs.read(logFile).catch(() => '')
  const line = `${new Date().toISOString()} ${what}: ${error instanceof Error ? error.message : JSON.stringify(error)}`
  await $.fs.write(logFile, [...before.split('\n').filter(Boolean).slice(-199), line].join('\n') + '\n').catch(() => undefined)
}

const run = async ($: $, argv: string[], timeoutMs = 60_000): Promise<string> => {
  try {
    const result = await $.process.run(argv, { timeoutMs })

    return result.stdout
  } catch (error) {
    await logFailure($, `run ${argv[0]}`, error)

    return ''
  }
}

// ---------------------------------------------------------------- reading sessions

const findTranscript = async ($: $): Promise<string | null> => {
  const known = view.transcriptPath
  if (known && (await $.fs.exists(known))) return known
  const id = await $.session.id()
  const { projects } = await folders($)
  const root = await $.session.root()
  const candidates = [`${projects}/${root.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`]
  for (const entry of await $.fs.list(projects).catch(() => [])) {
    if (entry.kind === 'dir') candidates.push(`${projects}/${entry.name}/${id}.jsonl`)
  }
  for (const path of candidates) {
    if (await $.fs.exists(path)) {
      view.transcriptPath = path

      return path
    }
  }

  return null
}

/**
 * Feeds bytes [from, to) of a log to `take`, in 3 MiB pieces so a long log is
 * never held whole; resolves how far it read. `$.fs.read` stops at 4 MiB, so
 * the pieces are cut on the host.
 */
const readRange = async (
  $: $,
  path: string,
  from: number,
  to: number,
  take: (text: string) => void,
  progress?: (at: number) => void,
): Promise<number> => {
  if (from === 0 && to <= READ_LIMIT) {
    const text = await $.fs.read(path)
    take(text)

    return new TextEncoder().encode(text).length
  }
  for (let at = from; at < to; at += WINDOW) {
    const length = Math.min(WINDOW, to - at)
    const { stdout } = await $.process.run(
      ['/bin/sh', '-c', 'tail -c +"$1" "$3" | head -c "$2"', 'sh', String(at + 1), String(length), path],
      { timeoutMs: 60_000 },
    )
    take(stdout)
    progress?.(at + length)
  }

  return to
}

const readWhole = async ($: $, path: string, size: number): Promise<string> => {
  const parts: string[] = []
  await readRange($, path, 0, size, text => parts.push(text))

  return parts.join('')
}

const readSubagents = async ($: $, path: string): Promise<SubagentInput[]> => {
  const dir = `${path.replace(/\.jsonl$/, '')}/subagents`
  const entries = await $.fs.list(dir).catch(() => [])
  const out: SubagentInput[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
    const file = `${dir}/${entry.name}`
    const known = subagentCache.get(file)
    if (known && known.size === entry.size) {
      out.push(known.input)
      continue
    }
    const meta = await $.fs
      .read(`${dir}/${entry.name.replace(/\.jsonl$/, '.meta.json')}`)
      .then(text => JSON.parse(text) as SubagentInput['meta'])
      .catch(() => ({}))
    const input = { meta, text: await readWhole($, file, entry.size) }
    subagentCache.set(file, { size: entry.size, input })
    out.push(input)
  }

  return out
}

const analyzeFile = async (
  $: $,
  path: string,
  size: number,
  usd: number | null,
  context: Report['context'],
  slices: Report['baselineSlices'],
  progress?: (at: number) => void,
): Promise<Report> => {
  const reader = createReader()
  await readRange($, path, 0, size, text => reader.feed(text), progress)

  return reader.report(await readSubagents($, path), { now: await $.clock.now(), usd, context, slices, transcriptBytes: size })
}

const getCache = async ($: $): Promise<HistoryCache> => {
  if (cache) return cache
  const { cacheFile } = await folders($)
  const text = await $.fs.read(cacheFile).catch(() => '')
  try {
    const parsed = JSON.parse(text) as HistoryCache
    if (parsed.version === 1) cache = parsed
  } catch {
    // A missing or damaged cache is rebuilt.
  }
  cache ??= { version: 1, sessions: {}, rates: {} }

  return cache
}

const saveCache = async ($: $): Promise<void> => {
  if (!cache) return
  const { cacheFile } = await folders($)
  await $.fs.write(cacheFile, JSON.stringify(cache)).catch(error => logFailure($, 'save cache', error))
}

const sessionUsage = async ($: $) => {
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => $.session.usage())
  const slices = (usage.context.breakdown?.categories ?? [])
    .filter(c => c.kind === 'used' && c.tokens > 0)
    .map(c => ({ name: c.name, tokens: c.tokens }))
    .sort((a, b) => b.tokens - a.tokens)

  return {
    usd: usage.cost?.usd ?? null,
    context: { tokens: usage.context.tokens ?? null, window: usage.context.window, percent: usage.context.percent ?? null },
    slices,
  }
}

const refresh = async ($: $, isQuiet = false): Promise<void> => {
  if (isBusy) return
  isBusy = true
  if (!isQuiet) {
    view.load = { status: 'loading' }
    spin($)
  }
  try {
    const path = await findTranscript($)
    if (!path) throw new Error('Could not find this session’s transcript file under ~/.claude/projects.')
    const { size } = await $.fs.stat(path)
    const usage = await sessionUsage($)
    view.usage = usage.context
    if (!liveLog || liveLog.path !== path || size < liveLog.offset) liveLog = { path, offset: 0, reader: createReader() }
    const log = liveLog
    if (size > log.offset) {
      const start = log.offset
      log.offset = await readRange($, path, start, size, text => log.reader.feed(text), at => {
        if (!isQuiet && size - start > READ_LIMIT) {
          view.load = { status: 'loading', done: at - start, total: size - start }
          redraw($)
        }
      })
    }
    const next = log.reader.report(await readSubagents($, path), {
      now: await $.clock.now(),
      usd: usage.usd,
      context: usage.context,
      slices: usage.slices,
      transcriptBytes: size,
    })
    view.report = next
    view.lastActivity = Math.max(view.lastActivity, next.endedAt)
    view.load = { status: 'ready' }
    // What a dollar buys on this model, so past sessions can be priced.
    if (usage.usd !== null && next.model && next.weighted > 10_000) {
      const known = await getCache($)
      const rate = usage.usd / next.weighted
      if (Math.abs((known.rates[next.model] ?? 0) - rate) > rate * 0.02) {
        known.rates[next.model] = rate
        await saveCache($)
      }
    }
    if (isQuiet) redraw($)
    else animate($)
  } catch (error) {
    ticker?.cancel()
    ticker = undefined
    view.frame = FRAMES
    view.load = { status: 'error', message: error instanceof Error ? error.message : String(error) }
    await logFailure($, 'refresh', error)
    redraw($)
  } finally {
    isBusy = false
  }
}

const indexHistory = async ($: $): Promise<void> => {
  if (isIndexing) return
  isIndexing = true
  view.historyLoad = { status: 'loading', done: 0, total: 0 }
  redraw($)
  try {
    const { projects } = await folders($)
    const known = await getCache($)
    const current = `${await $.session.id()}.jsonl`
    const files: { folder: string; name: string; size: number; mtimeMs: number }[] = []
    for (const dir of await $.fs.list(projects).catch(() => [])) {
      if (dir.kind !== 'dir') continue
      for (const file of await $.fs.list(`${projects}/${dir.name}`).catch(() => [])) {
        if (file.kind === 'file' && file.name.endsWith('.jsonl') && file.name !== current && file.size > 2_000) {
          files.push({ folder: dir.name, name: file.name, size: file.size, mtimeMs: file.mtimeMs })
        }
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const picked = files.slice(0, view.historyLimit)
    view.historyAvailable = files.length
    view.historyLoad = { status: 'loading', done: 0, total: picked.length }
    const out: SessionSummary[] = []
    let isChanged = false
    for (const file of picked) {
      const path = `${projects}/${file.folder}/${file.name}`
      let summary = known.sessions[path]
      // A session still being written is re-read at most every half hour.
      const isCurrent = summary && (summary.size === file.size || file.mtimeMs - summary.mtimeMs < 30 * 60_000)
      if (!isCurrent) {
        const window = view.usage?.window ?? 200_000
        const report = await analyzeFile($, path, file.size, null, { tokens: null, window, percent: null }, []).catch(
          error => logFailure($, `history ${file.name}`, error).then(() => null),
        )
        if (!report) continue
        summary = summarize(report, { ...file, id: file.name.replace(/\.jsonl$/, ''), path })
        known.sessions[path] = summary
        isChanged = true
      }
      if (summary && summary.requests > 0) out.push(summary)
      view.historyLoad = { status: 'loading', done: out.length, total: picked.length }
      if (out.length % 4 === 0) {
        view.history = [...out]
        redraw($)
      }
    }
    view.history = out
    view.historyLoad = { status: 'ready' }
    if (isChanged) await saveCache($)
  } catch (error) {
    view.historyLoad = { status: 'error', message: error instanceof Error ? error.message : String(error) }
    await logFailure($, 'history', error)
  } finally {
    isIndexing = false
    animate($)
  }
}

const openPast = async ($: $, summary: SessionSummary): Promise<void> => {
  view.selected = summary
  view.selectedReport = null
  view.selectedLoad = { status: 'loading' }
  view.tab = 'overview'
  spin($)
  try {
    const rates = (await getCache($)).rates
    const window = view.usage?.window ?? 200_000
    view.selectedReport = await analyzeFile(
      $,
      summary.path,
      summary.size,
      usdOf(summary, rates),
      { tokens: null, window, percent: null },
      [],
      at => {
        if (summary.size > READ_LIMIT) {
          view.selectedLoad = { status: 'loading', done: at, total: summary.size }
          redraw($)
        }
      },
    )
    view.selectedLoad = { status: 'ready' }
  } catch (error) {
    view.selectedLoad = { status: 'error', message: error instanceof Error ? error.message : String(error) }
    await logFailure($, 'open past session', error)
  }
  animate($)
}

/** Runs work on a timer so it outlives the press or command that asked for it. */
const later = ($: $, work: () => Promise<void>): void => {
  $.clock.after(0, () => void work().catch(error => logFailure($, 'action', error)))
}

const openPane = async ($: $, tab?: PaneTab): Promise<void> => {
  if (tab) view.tab = tab
  await $.ui.open({ id: PANE, title: 'Session progress' })
  isPaneOpen = true
  later($, () => refresh($))
}

const startLive = ($: $): void => {
  live?.cancel()
  live = $.clock.every(LIVE_REFRESH_MS, () => {
    if (isPaneOpen) void refresh($, true)
  })
}

// ---------------------------------------------------------------- acting on advice

const copyText = async ($: $, text: string, surface: RenderSurface): Promise<boolean> => {
  try {
    if ((await $.ui.copy({ text, surface })).isCopied) return true
  } catch {
    // Not every build or surface copies; the host's clipboard below still does.
  }
  // The desktop app's clipboard is the Mac's.
  const host = await $.process.run(['pbcopy'], { stdin: text, timeoutMs: 5000 }).catch(() => null)

  return host?.exitCode === 0
}

const sendPrompt = async ($: $, action: Action, surface: RenderSurface): Promise<void> => {
  expected.set(action.text, (expected.get(action.text) ?? 0) + 1)
  try {
    await $.prompt.submit({ text: action.text, asUser: true })
    view.sent.add(action.key)
    notify($, `Sent to Claude: ${action.label}.`)
  } catch (error) {
    expected.set(action.text, Math.max(0, (expected.get(action.text) ?? 1) - 1))
    await logFailure($, `send ${action.key}`, error)
    view.draft = action
    const copied = await copyText($, action.text, surface)
    notify($, copied ? 'Could not send it directly, so it is copied: paste it into the prompt box.' : 'Could not send it directly: copy the text shown below.', true)
  }
  redraw($)
}

const runAction = async ($: $, action: Action, surface: RenderSurface): Promise<void> => {
  if (action.kind === 'clear' && view.pending !== action.key) {
    view.pending = action.key
    redraw($)

    return
  }
  view.pending = null
  if (action.kind === 'prompt') {
    if (view.sent.has(action.key)) {
      notify($, 'Already sent to Claude in this session.')

      return
    }
    if (view.isTurnRunning) {
      // One request waits, sent once the turn ends: clicks while Claude works do not pile up.
      view.held = action
      notify($, `Claude is busy. “${action.label}” will be sent once, when this turn ends.`)

      return
    }
    await sendPrompt($, action, surface)

    return
  }
  if (view.isTurnRunning) {
    notify($, 'Claude is busy: press it again once this turn ends.', true)

    return
  }
  if (action.kind === 'compact') {
    try {
      await $.session.compact({ instructions: action.text })
      view.sent.add(action.key)
      notify($, 'Compacted the conversation.')
    } catch (error) {
      await logFailure($, 'compact', error)
      view.draft = { ...action, kind: 'prompt', text: `/compact ${action.text}` }
      notify($, 'Could not compact from here: type the /compact line below into the prompt box.', true)
    }
  } else {
    try {
      await $.command.run({ command: 'clear', args: '' })
      notify($, 'Cleared the conversation.')
    } catch (error) {
      await logFailure($, 'clear', error)
      notify($, 'Could not clear from here: type /clear in the prompt box.', true)
    }
  }
  redraw($)
}

const draftAction = async ($: $, action: Action, surface: RenderSurface): Promise<void> => {
  const filled = await $.prompt.fill({ text: action.text }).catch(() => ({ isFilled: false }))
  if (filled.isFilled) {
    notify($, 'Put in your prompt box: edit it, then send.')

    return
  }
  // The desktop app keeps a prompt box of its own that a mod cannot write to.
  view.draft = action
  const copied = await copyText($, action.text, surface)
  notify($, copied ? 'Copied: paste it into the prompt box, edit, then send.' : 'Select the text below to copy it.')
}

// ---------------------------------------------------------------- disk and memory

const cwdOf = async ($: $, folder: string, newest: string): Promise<string> => {
  const known = (await getCache($)).cwds ?? {}
  if (known[folder]) return known[folder]!
  const head = await run($, ['head', '-c', '65536', newest], 10_000)
  const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1]?.replace(/\\(.)/g, '$1') ?? ''
  if (cwd) {
    const c = await getCache($)
    c.cwds = { ...(c.cwds ?? {}), [folder]: cwd }
  }

  return cwd
}

const scanStorage = async ($: $): Promise<void> => {
  if (isScanning) return
  isScanning = true
  view.storageLoad = { status: 'loading', done: 0, total: 7 }
  spin($)
  const step = (done: number): void => {
    view.storageLoad = { status: 'loading', done, total: 7 }
    redraw($)
  }
  try {
    const { home, config, projects } = await folders($)
    const user = (await $.env.get('USER')) ?? ''
    const appData = `${home}/Library/Application Support/Claude`
    const now = await $.clock.now()
    const cutoff = now - view.storageDays * 86_400_000
    const currentId = await $.session.id()
    const currentLog = await findTranscript($)
    const currentRoot = await $.session.root()
    const known = await getCache($)

    // Sessions on disk, newest log per project.
    const logs: { folder: string; id: string; path: string; size: number; mtimeMs: number }[] = []
    for (const dir of await $.fs.list(projects).catch(() => [])) {
      if (dir.kind !== 'dir') continue
      for (const file of await $.fs.list(`${projects}/${dir.name}`).catch(() => [])) {
        if (file.kind === 'file' && file.name.endsWith('.jsonl')) {
          logs.push({ folder: dir.name, id: file.name.replace(/\.jsonl$/, ''), path: `${projects}/${dir.name}/${file.name}`, size: file.size, mtimeMs: file.mtimeMs })
        }
      }
    }
    const lastUse = new Map<string, number>()
    const newestLog = new Map<string, string>()
    for (const l of logs) {
      if ((lastUse.get(l.folder) ?? 0) < l.mtimeMs) {
        lastUse.set(l.folder, l.mtimeMs)
        newestLog.set(l.folder, l.path)
      }
    }
    const titles = new Map<string, { title: string; lastActivityMs: number }>()
    for (const l of logs) {
      titles.set(l.id, { title: known.sessions[l.path]?.title ?? `Session ${l.id.slice(0, 8)}`, lastActivityMs: l.mtimeMs })
    }
    if (view.report) titles.set(currentId, { title: view.report.title || 'This session', lastActivityMs: now })
    step(1)

    // Memory.
    const [ps, vm, memsize] = await Promise.all([
      run($, ['ps', '-x', '-U', user, '-o', 'pid=,ppid=,rss=,etime=,time=,args=']),
      run($, ['vm_stat']),
      run($, ['sysctl', '-n', 'hw.memsize']),
    ])
    const procs = parsePs(ps)
    // This session's own process: the Claude Code process above the shell the mod starts.
    const shellParent = Number((await run($, ['/bin/sh', '-c', 'echo $PPID'])).trim())
    const currentPid = owningCli(procs, shellParent)
    // Sessions started without an id are named by the folder they run in and its newest log.
    const unnamed = procs.filter(p => isClaudeCli(p) && !sessionIdOf(p) && p.pid !== currentPid)
    const cwds = unnamed.length > 0 ? parseLsofCwd(await run($, ['lsof', '-a', '-d', 'cwd', '-Fpn', '-p', unnamed.map(p => p.pid).join(',')])) : new Map<number, string>()
    const byPid = new Map<number, { title: string; lastActivityMs: number }>()
    for (const p of unnamed) {
      const cwd = cwds.get(p.pid)
      if (!cwd) continue
      const folder = cwd.replace(/[^a-zA-Z0-9]/g, '-')
      const startedAt = now - p.elapsedSec * 1000
      const log = logs.filter(l => l.folder === folder && l.mtimeMs >= startedAt).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
      byPid.set(p.pid, {
        title: log ? (known.sessions[log.path]?.title ?? `New session in ${projectLabel(cwd, folder)}`) : `New session in ${projectLabel(cwd, folder)}`,
        lastActivityMs: log?.mtimeMs ?? startedAt,
      })
    }
    const sessions = sessionProcs(procs, { id: currentId, pid: currentPid }, titles, byPid, now)
    const running = new Set(sessions.map(s => s.sessionId))
    const apps = heavyApps(procs, 150 * 1024)
    step(2)

    const found: string[] = []
    const keep = [
      currentLog ?? '',
      currentLog ? currentLog.replace(/\.jsonl$/, '') : '',
      currentRoot,
      `${config}/dev-mods/${currentId}`,
      `${config}/mods`,
      `${config}/session-progress`,
    ].filter(Boolean)
    const groups: DiskGroup[] = []

    // 1. Old session logs.
    const oldLogs = logs.filter(l => l.mtimeMs < cutoff && l.id !== currentId && !running.has(l.id) && l.size >= 512 * 1024)
    groups.push({
      id: 'sessions',
      title: 'Old session logs',
      note: 'Each is one past conversation. Removing it drops that session from Claude’s history; the work in your files stays.',
      items: oldLogs.map(l => ({
        id: `log-${l.id}`,
        label: titles.get(l.id)?.title ?? `Session ${l.id.slice(0, 8)}`,
        detail: `${projectLabel(known.cwds?.[l.folder] ?? '', l.folder)} · last used ${fmtAge(now - l.mtimeMs)} ago`,
        paths: [l.path, l.path.replace(/\.jsonl$/, '')],
        bytes: l.size,
        lastUsedMs: l.mtimeMs,
        isRevealOnly: false,
      })),
    })
    step(3)

    // 2. Old Claude Code versions next to the one running.
    const inUse = new Set(procs.map(p => /\/claude-code\/([^/]+)\//.exec(p.args)?.[1]).filter((v): v is string => Boolean(v)))
    const versions = (await $.fs.list(`${appData}/claude-code`).catch(() => [])).filter(v => v.kind === 'dir' && !inUse.has(v.name))
    const versionSizes = versions.length > 0 ? parseDu(await run($, ['du', '-sk', ...versions.map(v => `${appData}/claude-code/${v.name}`)])) : new Map()
    groups.push({
      id: 'versions',
      title: 'Old Claude Code versions',
      note: 'Versions the app no longer runs; it keeps the current one and downloads new ones itself.',
      items: versions.map(v => ({
        id: `ver-${v.name}`,
        label: `Claude Code ${v.name}`,
        detail: 'not running',
        paths: [`${appData}/claude-code/${v.name}`],
        bytes: versionSizes.get(`${appData}/claude-code/${v.name}`) ?? 0,
        lastUsedMs: 0,
        isRevealOnly: false,
      })),
    })
    step(4)

    // 3. Worktrees and 4. rebuildable folders in projects not used lately.
    const worktrees: DiskItem[] = []
    const artifacts: DiskItem[] = []
    for (const [folder, newest] of newestLog) {
      const used = lastUse.get(folder) ?? 0
      if (used >= cutoff) continue
      const cwd = await cwdOf($, folder, newest)
      if (!cwd || cwd === currentRoot || cwd.includes('/scratch-workspaces/') || !(await $.fs.exists(cwd))) continue
      if (cwd.includes('/.claude/worktrees/')) {
        worktrees.push({
          id: `wt-${folder}`,
          label: cwd.split('/.claude/worktrees/')[1] ?? cwd,
          detail: `${projectLabel(cwd, folder)} · last used ${fmtAge(now - used)} ago`,
          paths: [cwd],
          bytes: 0,
          lastUsedMs: used,
          isRevealOnly: false,
          pruneRepo: cwd.split('/.claude/worktrees/')[0],
        })
        continue
      }
      const names = REBUILDABLE.flatMap((n, i) => (i === 0 ? ['-name', n] : ['-o', '-name', n]))
      const hits = (await run($, ['find', cwd, '-maxdepth', '4', '-type', 'd', '(', ...names, ')', '-prune', '-print'], 30_000))
        .split('\n')
        .filter(Boolean)
      for (const hit of hits) {
        artifacts.push({
          id: `art-${hit}`,
          label: hit.slice(cwd.length + 1) || hit,
          detail: `${projectLabel(cwd, folder)} · project idle ${fmtAge(now - used)}`,
          paths: [hit],
          bytes: 0,
          lastUsedMs: used,
          isRevealOnly: false,
        })
      }
    }
    for (const list of [worktrees, artifacts]) {
      const sizes = list.length > 0 ? parseDu(await run($, ['du', '-sk', ...list.map(i => i.paths[0]!)], 120_000)) : new Map()
      for (const item of list) {
        item.bytes = sizes.get(item.paths[0]!) ?? 0
        found.push(item.paths[0]!)
      }
    }
    groups.push({
      id: 'worktrees',
      title: 'Worktrees of finished work',
      note: 'Separate checkouts Claude made for parallel work. Commit or push anything you need first; git forgets them after removal.',
      items: worktrees,
    })
    groups.push({
      id: 'artifacts',
      title: 'Rebuildable folders in idle projects',
      note: 'node_modules, virtualenvs and build caches: npm install (or your build) recreates them.',
      items: artifacts.filter(a => a.bytes >= 20 * 1024 * 1024),
    })
    step(5)

    // 5. Claude Code's own leftovers.
    const leftovers: DiskItem[] = []
    for (const sub of ['file-history', 'dev-mods']) {
      const children = (await $.fs.list(`${config}/${sub}`).catch(() => [])).filter(c => c.kind === 'dir' && c.name !== currentId)
      if (children.length === 0) continue
      const paths = children.map(c => `${config}/${sub}/${c.name}`)
      const stats = parseStat(await run($, ['stat', '-f', '%z\t%m\t%N', ...paths]))
      const sizes = parseDu(await run($, ['du', '-sk', ...paths]))
      const old = stats.filter(s => s.mtimeMs < cutoff)
      if (old.length === 0) continue
      leftovers.push({
        id: `left-${sub}`,
        label: sub === 'file-history' ? `Edit snapshots of ${old.length} old sessions` : `Mods of ${old.length} old sessions`,
        detail: `~/.claude/${sub}`,
        paths: old.map(s => s.path),
        bytes: old.reduce((n, s) => n + (sizes.get(s.path) ?? 0), 0),
        lastUsedMs: Math.max(...old.map(s => s.mtimeMs)),
        isRevealOnly: false,
      })
    }
    for (const sub of ['shell-snapshots', 'debug', 'paste-cache', 'todos']) {
      const files = (await $.fs.list(`${config}/${sub}`).catch(() => [])).filter(f => f.kind === 'file' && f.mtimeMs < cutoff)
      if (files.length === 0) continue
      leftovers.push({
        id: `left-${sub}`,
        label: `${files.length} old ${sub.replace('-', ' ')} files`,
        detail: `~/.claude/${sub}`,
        paths: files.map(f => `${config}/${sub}/${f.name}`),
        bytes: files.reduce((n, f) => n + f.size, 0),
        lastUsedMs: Math.max(...files.map(f => f.mtimeMs)),
        isRevealOnly: false,
      })
    }
    groups.push({
      id: 'leftovers',
      title: 'Claude Code leftovers',
      note: 'Per-session snapshots, shell captures and logs Claude Code keeps after a session ends.',
      items: leftovers.filter(l => l.bytes >= 1024 * 1024),
    })
    step(6)

    // 6. Large old downloads, and 7. what the Claude app manages itself.
    const downloads = parseStat(
      await run($, ['find', `${home}/Downloads`, '-type', 'f', '-size', '+50M', '-mtime', `+${view.storageDays}`, '-exec', 'stat', '-f', '%z\t%m\t%N', '{}', '+'], 60_000),
    )
    groups.push({
      id: 'downloads',
      title: 'Large old downloads',
      note: 'Files over 50 MB in Downloads that have not changed in a while.',
      items: downloads.map(d => ({
        id: `dl-${d.path}`,
        label: d.path.split('/').at(-1) ?? d.path,
        detail: `last changed ${fmtAge(now - d.mtimeMs)} ago`,
        paths: [d.path],
        bytes: d.bytes,
        lastUsedMs: d.mtimeMs,
        isRevealOnly: false,
      })),
    })
    const managed = [
      ['vm_bundles', 'Cowork virtual machine', 'Only used by Cowork. To reclaim it, quit Claude and delete it in Finder; Claude downloads it again if you use Cowork.'],
      ['Cache', 'Claude app web cache', 'Rebuilds by itself. Delete it in Finder only while Claude is quit.'],
      ['Code Cache', 'Claude app code cache', 'Rebuilds by itself. Delete it in Finder only while Claude is quit.'],
      ['Partitions', 'Preview browser data', 'Browser data for previews Claude ran. Delete old ones in Finder while Claude is quit.'],
    ] as const
    const managedSizes = parseDu(await run($, ['du', '-sk', ...managed.map(([dir]) => `${appData}/${dir}`)], 120_000))
    groups.push({
      id: 'managed',
      title: 'Managed by the Claude app',
      note: 'Shown for size only: removing these while Claude runs can break it, so they open in Finder instead.',
      items: managed
        .map(([dir, label, note]) => ({
          id: `app-${dir}`,
          label,
          detail: note,
          paths: [`${appData}/${dir}`],
          bytes: managedSizes.get(`${appData}/${dir}`) ?? 0,
          lastUsedMs: now,
          isRevealOnly: true,
        }))
        .filter(i => i.bytes >= 50 * 1024 * 1024),
    })
    for (const g of groups) g.items.sort((a, b) => b.bytes - a.bytes)
    await saveCache($)

    view.storage = { scannedAt: now, memory: parseMemory(vm, memsize), sessions, apps, groups, found, keep, home }
    view.storageLoad = { status: 'ready' }
  } catch (error) {
    view.storageLoad = { status: 'error', message: error instanceof Error ? error.message : String(error) }
    await logFailure($, 'scan storage', error)
  } finally {
    isScanning = false
    animate($)
  }
}

/** Moves items to the Trash: restorable there until the Trash is emptied. */
const trashItems = async ($: $, items: DiskItem[]): Promise<void> => {
  const s = view.storage
  if (!s) return
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  let moved = 0
  let bytes = 0
  const failed: string[] = []
  for (const item of items) {
    let isMoved = false
    for (const path of item.paths) {
      if (!(await $.fs.exists(path))) continue
      if (!isSafeToTrash(path, s.home, s.found, s.keep)) {
        failed.push(`${path} (outside the places this mod may clean)`)
        continue
      }
      const name = path.split('/').at(-1) ?? 'item'
      const result = await $.process
        .run(['mv', '-n', path, `${s.home}/.Trash/${name} (removed ${stamp})`], { timeoutMs: 120_000 })
        .catch(error => ({ exitCode: 1, stderr: String(error) }))
      if (result.exitCode === 0) isMoved = true
      else failed.push(path)
    }
    if (item.pruneRepo) await run($, ['git', '-C', item.pruneRepo, 'worktree', 'prune'])
    if (isMoved) {
      moved += 1
      bytes += item.bytes
      for (const g of s.groups) g.items = g.items.filter(i => i.id !== item.id)
    }
  }
  if (failed.length > 0) await logFailure($, 'trash', failed.join('; '))
  notify(
    $,
    failed.length > 0
      ? `Moved ${moved} item${moved === 1 ? '' : 's'} (${fmtBytes(bytes)}) to the Trash; ${failed.length} could not be moved.`
      : `Moved ${moved} item${moved === 1 ? '' : 's'} (${fmtBytes(bytes)}) to the Trash. Empty the Trash to free the space.`,
    failed.length > 0,
  )
}

const quitProcesses = async ($: $, targets: { pid: number; name: string; isApp: boolean }[]): Promise<void> => {
  let done = 0
  for (const t of targets) {
    const argv =
      t.isApp && /^[\w .()-]+$/.test(t.name)
        ? ['osascript', '-e', `quit app "${t.name}"`]
        : ['kill', '-TERM', String(t.pid)]
    const result = await $.process.run(argv, { timeoutMs: 20_000 }).catch(error => ({ exitCode: 1, stderr: String(error) }))
    if (result.exitCode === 0) done += 1
    else await logFailure($, `quit ${t.name}`, result.stderr)
  }
  notify($, `Asked ${done} of ${targets.length} to quit.`, done < targets.length)
  // Look again once they have had a moment to exit.
  $.clock.after(2500, () => void scanStorage($))
}

const reveal = async ($: $, path: string): Promise<void> => {
  await run($, ['open', '-R', path])
}

// ---------------------------------------------------------------- Claude's own review

const summarizeForReview = (r: Report): string => {
  const share = (w: number): string => `${Math.round((w / r.weighted) * 100)}%`
  const lines = [
    `Requests: ${r.requests}, tool calls: ${r.toolCalls}, cache hit: ${Math.round(r.cacheHitRate * 100)}%, starting overhead per request: ${fmtTokens(r.baseline)} tokens.`,
    'Tasks (share of spend): ' + r.tasks.slice(-40).map(t => `"${t.title.slice(0, 60)}" ${share(t.weighted)} over ${t.requests} requests`).join('; '),
    'Activities: ' + r.activities.map(a => `${a.label} ${share(a.weighted)}`).join(', '),
    'Flagged: ' + r.recommendations.map(x => `${x.title} (${x.evidence.join('; ')})`).join(' | '),
  ]

  return lines.join('\n').slice(0, 4000)
}

const runReview = async ($: $): Promise<void> => {
  const current = view.report
  view.review = { status: 'running' }
  redraw($)
  const result = await $.model.fork({
    prompt: [
      'Review THIS session (the conversation above) for token and time efficiency, as a coach for the user.',
      'The session-progress mod measured:',
      current ? summarizeForReview(current) : '(no measurements yet)',
      '',
      'Write 4-6 markdown bullets, each specific to what actually happened here (name the step, file, command or prompt):',
      'how the same work could have used fewer tokens or less time — prompting, batching, model or effort choice,',
      'session hygiene (/clear, /compact, new sessions), tool output size, subagents. Then one bullet on what went well.',
      'Under 220 words. Do not call tools.',
    ].join('\n'),
  })
  if (result.isAnswered) {
    const u = result.usage
    view.review = {
      status: 'done',
      text: result.text,
      tokens: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens + u.output_tokens,
    }
  } else {
    const why =
      result.reason === 'nothing-to-fork'
        ? 'Nothing to review yet: wait for a turn to finish, then try again.'
        : `The review did not come back (${result.reason}).`
    view.review = { status: 'error', text: why }
  }
  redraw($)
}

// ---------------------------------------------------------------- what to do next

const currentAdvice = (now: number): Advice | null => {
  const r = view.report
  const tokens = view.usage?.tokens ?? r?.context.tokens ?? r?.timeline.at(-1)?.tokens ?? null
  if (tokens === null) return null
  const plan = r ? [...r.tasks].reverse().find(t => t.steps.length > 0) : undefined
  const rate = r?.usd && r.weighted ? r.usd / r.weighted : r ? (cache?.rates[r.model] ?? null) : null

  return advise({
    now,
    lastActivity: view.lastActivity || r?.endedAt || 0,
    isTurnRunning: view.isTurnRunning,
    contextTokens: tokens,
    window: view.usage?.window ?? r?.context.window ?? 200_000,
    baseline: r?.baseline ?? 0,
    cacheTtlMs: r && r.tokens.cacheWrite1h > 0 ? 3_600_000 : 300_000,
    isPlanDone: plan ? plan.steps.every(s => s.status === 'completed') : null,
    averageReadTokens: r?.averageReadTokens ?? 0,
    usdPerWeighted: rate,
  })
}

// ---------------------------------------------------------------- formatting

const fmtUsd = (usd: number): string => (usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`)

const fmtDuration = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`
  if (minutes < 60) return `${minutes}m`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })

const pct = (part: number, whole: number): string => `${Math.round((part / Math.max(1, whole)) * 100)}%`

const costOf = (r: Report, weighted: number): string =>
  r.usd === null ? `${fmtTokens(weighted)} eq.` : fmtUsd((r.usd * weighted) / r.weighted)

const progressText = (load: Load, what: string): string =>
  load.total && load.done !== undefined && load.total > 0
    ? `${what}… ${Math.round((load.done / load.total) * 100)}%${load.total > 7 ? ` of ${fmtBytes(load.total)}` : ''}`
    : `${what}…`

const STEP_MARK: Record<StepReport['status'], string> = { completed: '✓', in_progress: '▶', pending: '○' }

const SEVERITY = {
  high: { label: 'HIGH', color: STATUS.critical },
  medium: { label: 'MEDIUM', color: STATUS.warning },
  low: { label: 'LOW', color: undefined },
} as const

const TABS: [PaneTab, string][] = [
  ['overview', 'Overview'],
  ['tasks', 'Tasks'],
  ['tips', 'Tips'],
  ['history', 'History'],
  ['storage', 'Storage & memory'],
]

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Session progress, token use, past sessions, storage and memory, with fixes Claude can apply',
      immediate: true,
    })
    // Re-checks the cache window once a minute, so the hint above the prompt keeps up.
    $.clock.every(60_000, () => {
      if (!view.isTurnRunning && view.lastActivity > 0) redraw($)
    })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await openPane($)

    return { text: 'Opened the session progress pane.' }
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const waiting = expected.get(e.text) ?? 0
    if (isActionText(e.text) && waiting === 0) {
      // A click queued before this load (or a repeat of one): not run twice.
      await $.turn.abort({ turnId: e.turnId }).catch(error => logFailure($, 'skip stale request', error))
      skipped += 1
      notify($, `Skipped ${skipped} stale request${skipped === 1 ? '' : 's'} queued by earlier clicks.`)

      return result
    }
    if (waiting > 0) expected.set(e.text, waiting - 1)
    view.isTurnRunning = true
    view.dismissed = null
    redraw($)
    startLive($)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      live?.cancel()
      live = undefined
      view.isTurnRunning = false
      view.lastActivity = await $.clock.now()
      const held = view.held
      if (held) {
        view.held = null
        $.clock.after(800, () => void sendPrompt($, held, 'desktop'))
      }
      const isStale = !view.report || view.lastActivity - view.report.generatedAt > 5 * 60_000
      if (isPaneOpen || isStale) $.clock.after(1500, () => void refresh($, true))
      else {
        const usage = await $.session.usage()
        view.usage = { tokens: usage.context.tokens ?? null, window: usage.context.window, percent: usage.context.percent ?? null }
        redraw($)
      }
    }

    return result
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      isPaneOpen = false
      live?.cancel()
      ticker?.cancel()
    }

    return next(e)
  })

  // The hint above the prompt: only when switching would clearly pay off.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || view.isTurnRunning) return next(e)
    const advice = currentAdvice(await $.clock.now())
    if (!advice?.isUrgent || view.dismissed === advice.verdict) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const action = adviceActions(advice.verdict)[0]

    return (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        <Text color={STATUS.warning}>◆</Text>
        <Text>{advice.headline}</Text>
        {action ? (
          <Button
            key={`band-${action.key}`}
            label={view.pending === action.key ? `Confirm: ${action.label}` : action.label}
            variant="primary"
            onPress={() => later($, () => runAction($, action, e.surface))}
          />
        ) : null}
        <Button key="band-details" label="Options" onPress={() => later($, () => openPane($, 'overview'))} />
        <Button
          key="band-dismiss"
          label="Not now"
          dimColor
          onPress={() => {
            view.dismissed = advice.verdict
            redraw($)
          }}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = table
    // Every table carries an Svg; the terminal's draws nothing, so it gets text charts instead.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const now = await $.clock.now()
    const f = view.frame
    const running = view.isTurnRunning
    const isPast = view.selected !== null && view.tab !== 'history' && view.tab !== 'storage'
    const r = isPast ? view.selectedReport : view.report
    const status = isPast ? view.selectedLoad : view.load
    const columns = e.props.bodyColumns
    const p = status.status === 'loading' && !r ? 0 : ease(f / FRAMES)
    const svgWidth = Math.max(260, Math.min(640, columns * 7))

    const section = (title: string, ...children: RenderChildren[]) => (
      <Box flexDirection="column">
        <Text bold>{title.toUpperCase()}</Text>
        {children}
      </Box>
    )

    const meter = (share: number, color: string, label: string, value: string, key: string) => (
      <Box key={key} flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text wrap="truncate-end">{label}</Text>
          <Text dimColor>{value}</Text>
        </Box>
        <Box flexDirection="row" width="100%">
          <Box width={`${Math.max(1, Math.min(100, Math.round(share * 100 * p)))}%`} backgroundColor={color}>
            <Text> </Text>
          </Box>
        </Box>
      </Box>
    )

    const tile = (label: string, value: string, sub: string) => (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} flexGrow={1} minWidth={16}>
        <Text dimColor>{label}</Text>
        <Text bold>{value}</Text>
        <Text dimColor>{sub}</Text>
      </Box>
    )

    /** A chart, or the text fallback where the surface has no Svg or the chart would be too long to draw. */
    const chart = (source: string, alt: string, fallback: string) =>
      Svg && source.length < SVG_LIMIT ? (
        <Svg source={source} alt={alt} width={svgWidth} isInteractive />
      ) : (
        <Text color={SERIES.fresh.light}>{fallback}</Text>
      )

    const confirmLabel = (key: string, label: string): string => (view.pending === key ? `Confirm: ${label}` : label)

    /** Runs `work` on the second press: the first only asks for confirmation. */
    const confirmed = (key: string, work: () => Promise<void>) => () => {
      if (view.pending !== key) {
        view.pending = key
        redraw($)

        return
      }
      view.pending = null
      later($, work)
    }

    const draftBox = (action: Action, keyPrefix: string) => (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Text dimColor>Copied to your clipboard. Paste it into the prompt box, edit it, and send:</Text>
        <Text>{action.text}</Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {action.kind === 'prompt' && !action.text.startsWith('/') ? (
            <Button
              key={`${keyPrefix}-draft-send`}
              label="Send as is"
              variant="primary"
              onPress={() => {
                view.draft = null
                later($, () => runAction($, action, e.surface))
              }}
            />
          ) : null}
          <Button key={`${keyPrefix}-draft-copy`} label="Copy again" onPress={() => later($, () => copyText($, action.text, e.surface).then(() => undefined))} />
          <Button
            key={`${keyPrefix}-draft-close`}
            label="Close"
            dimColor
            onPress={() => {
              view.draft = null
              redraw($)
            }}
          />
        </Box>
      </Box>
    )

    const actionRow = (actions: Action[], keyPrefix: string) => {
      const usable = actions.filter(a => !isPast || a.scope === 'future')
      const draftable = usable.find(a => a.kind === 'prompt')
      if (usable.length === 0) return null
      const shownDraft = view.draft && usable.some(a => a.key === view.draft?.key) ? view.draft : null

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {usable.map((a, i) => (
              <Button
                key={`${keyPrefix}-${a.key}`}
                label={
                  view.sent.has(a.key)
                    ? `✓ ${a.label}`
                    : view.held?.key === a.key
                      ? `⏳ ${a.label}`
                      : confirmLabel(a.key, a.label)
                }
                variant={i === 0 ? 'primary' : 'secondary'}
                onPress={() => later($, () => runAction($, a, e.surface))}
              />
            ))}
            {draftable ? (
              <Button key={`${keyPrefix}-draft`} label="Edit first" dimColor onPress={() => later($, () => draftAction($, draftable, e.surface))} />
            ) : null}
          </Box>
          {shownDraft ? draftBox(shownDraft, keyPrefix) : null}
        </Box>
      )
    }

    // Header
    const activeTask = r ? [...r.tasks].reverse().find(t => t.steps.length > 0) : undefined
    const activeStep = activeTask?.steps.find(s => s.status === 'in_progress')
    const tabs = (
      <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
        {TABS.map(([id, label]) => (
          <Button
            key={`tab-${id}`}
            label={id === 'tips' && r ? `${label} (${r.recommendations.length})` : label}
            variant={view.tab === id ? 'primary' : 'secondary'}
            onPress={() => {
              view.tab = id
              if (id === 'history' && view.historyLoad.status === 'idle') later($, () => indexHistory($))
              if (id === 'storage' && view.storageLoad.status === 'idle') later($, () => scanStorage($))
              animate($)
            }}
          />
        ))}
      </Box>
    )
    const heading =
      view.tab === 'history'
        ? 'Session history'
        : view.tab === 'storage'
          ? 'Storage & memory'
          : isPast
            ? (view.selected?.title ?? 'Past session')
            : r?.title || 'Session progress'
    const isLoadingNow =
      view.tab === 'history' ? view.historyLoad.status === 'loading' : view.tab === 'storage' ? view.storageLoad.status === 'loading' : status.status === 'loading'
    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1}>
            {running && Svg && !isPast ? <Svg source={pulseSvg()} alt="Claude is working" width={16} height={16} isInteractive /> : null}
            {running && !Svg && !isPast ? <Text color={STATUS.good}>●</Text> : null}
            <Text bold wrap="truncate-end">
              {heading}
            </Text>
          </Box>
          <Button
            key="refresh"
            label={isLoadingNow ? 'Refreshing…' : 'Refresh'}
            onPress={() =>
              later($, () => {
                if (view.tab === 'history') {
                  cache = null

                  return indexHistory($)
                }
                if (view.tab === 'storage') return scanStorage($)
                if (isPast && view.selected) return openPast($, view.selected)

                return refresh($)
              })
            }
          />
        </Box>
        {isPast && view.selected ? (
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            <Text dimColor>{`Past session · ${view.selected.project} · ${fmtDate(view.selected.startedAt)}`}</Text>
            <Button
              key="back-live"
              label="Back to this session"
              dimColor
              onPress={() => {
                view.selected = null
                view.selectedReport = null
                animate($)
              }}
            />
          </Box>
        ) : r && view.tab !== 'history' && view.tab !== 'storage' ? (
          <Text dimColor>
            {running ? `Working${activeStep ? ` on “${activeStep.title}”` : ''} · ` : ''}
            {fmtDuration(r.endedAt - r.startedAt)} · {r.tasks.length} task{r.tasks.length === 1 ? '' : 's'} · {r.filesChanged} file
            {r.filesChanged === 1 ? '' : 's'} changed
          </Text>
        ) : null}
        {tabs}
        {view.notice ? (
          <Box borderStyle="round" borderColor={view.notice.isError ? STATUS.warning : STATUS.good} paddingX={1} marginTop={1}>
            <Text color={view.notice.isError ? STATUS.warning : STATUS.good}>{view.notice.text}</Text>
          </Box>
        ) : null}
      </Box>
    )

    // ------------------------------------------------ What next (live session only)
    const adviceCard = () => {
      const advice = currentAdvice(now)
      if (!advice) return null

      return (
        <Box flexDirection="column" borderStyle="round" borderColor={advice.isUrgent ? STATUS.warning : undefined} borderDimColor={!advice.isUrgent} paddingX={1}>
          <Text bold>WHAT NEXT</Text>
          <Text>{advice.headline}</Text>
          {advice.reasons.map((line, i) => (
            <Text key={`why-${i}`} dimColor>{`• ${line}`}</Text>
          ))}
          {actionRow(adviceActions(advice.verdict), 'advice')}
          {advice.options.map(o => (
            <Box key={`opt-${o.id}`} flexDirection="column" marginTop={1}>
              <Text color={o.id === advice.verdict ? STATUS.good : undefined} bold={o.id === advice.verdict}>
                {`${o.id === advice.verdict ? '▶' : '○'} ${o.title}`}
              </Text>
              <Text dimColor>{`  When: ${o.when}`}</Text>
              <Text dimColor>{`  ${o.detail}`}</Text>
            </Box>
          ))}
        </Box>
      )
    }

    // ------------------------------------------------ Overview
    const overview = (rep: Report) => {
      const allTokens = rep.tokens.input + rep.tokens.cacheWrite + rep.tokens.cacheRead + rep.tokens.output
      const saving = rep.recommendations.reduce((n, x) => n + x.saving, 0)
      const plan = [...rep.tasks].reverse().find(t => t.steps.length > 0)
      const done = plan ? plan.steps.filter(s => s.status === 'completed').length : 0
      const mixRows = [
        { label: 'Tokens', parts: mixParts(rep.tokens, false) },
        { label: 'Cost', parts: mixParts(rep.tokens, true) },
      ]
      const weightedParts = mixParts(rep.tokens, true)
      const countParts = mixParts(rep.tokens, false)

      return [
        isPast ? null : adviceCard(),

        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {tile(
            rep.usd === null ? 'Spend (input-eq.)' : 'Est. cost',
            rep.usd === null ? fmtTokens(rep.weighted * p) : fmtUsd(rep.usd * p),
            rep.usd === null ? 'tokens priced as fresh input' : isPast ? 'at this model’s learned rate' : 'API-equivalent',
          )}
          {tile('Tokens processed', fmtTokens(allTokens * p), `${Math.round(rep.cacheHitRate * 100 * p)}% from cache`)}
          {tile('Requests', String(Math.round(rep.requests * p)), `${Math.round(rep.toolCalls * p)} tool calls`)}
          {tile(
            isPast ? 'Context at end' : 'Context now',
            rep.context.percent === null ? '—' : `${Math.round(rep.context.percent * p)}%`,
            rep.context.tokens === null ? `of ${fmtTokens(rep.context.window)}` : `${fmtTokens(rep.context.tokens)} of ${fmtTokens(rep.context.window)}`,
          )}
        </Box>,

        <Box flexDirection="row" gap={2} alignItems="center">
          {Svg ? (
            <Svg source={ringSvg(rep.score)} alt={`Efficiency ${rep.score} of 100`} width={112} height={112} isInteractive />
          ) : (
            <Text color={rep.score >= 80 ? STATUS.good : rep.score >= 60 ? STATUS.warning : STATUS.critical}>
              {'▰'.repeat(Math.round((rep.score / 10) * p)).padEnd(10, '▱')}
            </Text>
          )}
          <Box flexDirection="column" flexShrink={1}>
            <Text bold>Efficiency {Math.round(rep.score * p)}/100</Text>
            <Text dimColor>
              {saving > 0
                ? `About ${pct(saving, rep.weighted)} of ${isPast ? 'that' : 'this'} session’s spend looks avoidable${rep.usd === null ? '' : ` (≈ ${fmtUsd((rep.usd * saving) / rep.weighted)})`}.`
                : 'Nothing flagged as avoidable.'}
            </Text>
            {rep.recommendations.length > 0 ? (
              <Button
                key="see-tips"
                label={`See ${rep.recommendations.length} fix${rep.recommendations.length === 1 ? '' : 'es'}`}
                dimColor
                onPress={() => {
                  view.tab = 'tips'
                  animate($)
                }}
              />
            ) : null}
          </Box>
        </Box>,

        plan
          ? section(
              `Plan · ${done}/${plan.steps.length} done`,
              meter(done / Math.max(1, plan.steps.length), STATUS.good, plan.title, pct(done, plan.steps.length), 'plan-bar'),
              ...plan.steps.map((s, i) => (
                <Box key={`step-${i}`} flexDirection="row" justifyContent="space-between" gap={1}>
                  <Text
                    color={s.status === 'completed' ? STATUS.good : s.status === 'in_progress' ? SERIES.fresh.light : undefined}
                    dimColor={s.status === 'pending'}
                    wrap="truncate-end"
                  >
                    {`${STEP_MARK[s.status]} ${s.title}`}
                  </Text>
                  <Text dimColor>{s.weighted > 0 ? `${pct(s.weighted, plan.weighted)} · ${costOf(rep, s.weighted)}` : ''}</Text>
                </Box>
              )),
            )
          : null,

        section(
          'Token mix',
          Svg ? (
            <Svg source={mixSvg(mixRows, svgWidth)} alt="Share of tokens and of cost by token type" width={svgWidth} isInteractive />
          ) : (
            <Box flexDirection="column">
              {mixRows.map(row => {
                const total = row.parts.reduce((n, x) => n + x.value, 0) || 1
                const cells = Math.max(10, columns - 10)

                return (
                  <Box flexDirection="row" gap={1}>
                    <Text dimColor>{row.label.padEnd(6)}</Text>
                    <Text>
                      {row.parts.map(x => (
                        <Text color={SERIES[x.key].light}>{'█'.repeat(Math.round((x.value / total) * cells * p))}</Text>
                      ))}
                    </Text>
                  </Box>
                )
              })}
            </Box>
          ),
          ...countParts.map((x, i) => (
            <Box key={`mix-${x.key}`} flexDirection="row" justifyContent="space-between">
              <Text>
                <Text color={SERIES[x.key].light}>■ </Text>
                {SERIES[x.key].label}
              </Text>
              <Text dimColor>{`${fmtTokens(x.value)} tokens · ${pct(weightedParts[i]!.value, rep.weighted)} of cost`}</Text>
            </Box>
          )),
        ),

        section(
          'Context per request',
          chart(timelineSvg(rep.timeline, rep.context.window, svgWidth), 'Prompt size of each request', sparkline(rep.timeline, Math.max(10, columns - 2), p)),
          <Text dimColor>
            {`Starts at ${fmtTokens(rep.baseline)} (system prompt + tools) · `}
            <Text color={SERIES.write.light}>●</Text>
            {' cache rebuilt · '}
            <Text color={SERIES.read.light}>●</Text>
            {' after compaction'}
          </Text>,
        ),

        section(
          'Where the spend went',
          ...rep.activities.map((a, i) =>
            meter(a.weighted / rep.weighted, SERIES.fresh.light, a.label, `${pct(a.weighted, rep.weighted)} · ${costOf(rep, a.weighted)}`, `act-${i}`),
          ),
        ),
      ]
    }

    // ------------------------------------------------ Tasks
    const taskCard = (rep: Report, t: TaskReport, index: number) => (
      <Box key={`task-${index}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text bold wrap="truncate-end">{`${index + 1}. ${t.title}`}</Text>
          <Text>{costOf(rep, t.weighted)}</Text>
        </Box>
        {meter(
          t.weighted / rep.weighted,
          SERIES.fresh.light,
          `${pct(t.weighted, rep.weighted)} of session spend`,
          `${fmtTokens(t.tokens.input + t.tokens.cacheWrite + t.tokens.cacheRead + t.tokens.output)} tokens`,
          `task-bar-${index}`,
        )}
        <Text dimColor>
          {`${t.requests} request${t.requests === 1 ? '' : 's'} · ${fmtDuration(t.endedAt - t.startedAt)} · started with ${fmtTokens(t.startContext)} in context${t.model ? ` · ${t.model}` : ''}${index > 0 ? (t.isNewTopic ? ' · new topic' : ' · follow-up') : ''}`}
        </Text>
        {t.tools.length > 0 ? (
          <Text>
            <Text dimColor>Tools </Text>
            {t.tools
              .slice(0, 6)
              .map(x => `${x.name} ×${x.calls}${x.resultTokens >= 1000 ? ` (${fmtTokens(x.resultTokens)} out)` : ''}`)
              .join(' · ')}
          </Text>
        ) : null}
        {t.steps.map((s, i) => (
          <Box key={`task-${index}-step-${i}`} flexDirection="row" justifyContent="space-between" gap={1}>
            <Text dimColor={s.status === 'pending'} wrap="truncate-end">
              {`${STEP_MARK[s.status]} ${s.title}`}
            </Text>
            <Text dimColor>{s.weighted > 0 ? `${pct(s.weighted, t.weighted)} · ${s.requests} req` : ''}</Text>
          </Box>
        ))}
        {t.subagents.map((s, i) => (
          <Text key={`task-${index}-agent-${i}`}>
            <Text dimColor>Subagent </Text>
            {`${s.label} · ${s.requests} req · ${costOf(rep, s.weighted)}`}
          </Text>
        ))}
      </Box>
    )
    const tasks = (rep: Report) => {
      const visible = rep.tasks.map((t, i) => ({ t, i })).filter(x => x.t.requests > 0)
      const newestFirst = [...visible].reverse()
      const shown = view.isAllTasks ? newestFirst : newestFirst.slice(0, TASKS_SHOWN)

      return visible.length === 0
        ? [<Text dimColor>No model requests yet.</Text>]
        : [
            visible.length > TASKS_SHOWN ? (
              <Text dimColor>{`${visible.length} tasks, newest first${view.isAllTasks ? '' : `; showing the latest ${TASKS_SHOWN}`}.`}</Text>
            ) : null,
            ...shown.map(({ t, i }) => taskCard(rep, t, i)),
            visible.length > TASKS_SHOWN ? (
              <Button
                key="tasks-all"
                label={view.isAllTasks ? `Show the latest ${TASKS_SHOWN}` : `Show all ${visible.length} tasks`}
                onPress={() => {
                  view.isAllTasks = !view.isAllTasks
                  redraw($)
                }}
              />
            ) : null,
          ]
    }

    // ------------------------------------------------ Tips
    const tips = (rep: Report) => {
      const saving = rep.recommendations.reduce((n, x) => n + x.saving, 0)
      const shown = Math.ceil((f / FRAMES) * Math.max(1, rep.recommendations.length))

      return [
        <Text dimColor>
          {saving > 0
            ? `Fixing these could have saved about ${pct(saving, rep.weighted)} of ${isPast ? 'that' : 'this'} session’s spend${rep.usd === null ? '' : ` (≈ ${fmtUsd((rep.usd * saving) / rep.weighted)})`}. Estimates, largest first. Buttons hand the fix to Claude; while Claude is busy, one waits and goes when the turn ends.`
            : 'Nothing looks wasteful.'}
        </Text>,
        ...rep.recommendations.slice(0, f >= FRAMES ? undefined : shown).map(rec => (
          <Box key={`rec-${rec.id}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text bold>{rec.title}</Text>
              <Text color={SEVERITY[rec.severity].color} dimColor={rec.severity === 'low'} bold>
                {SEVERITY[rec.severity].label}
              </Text>
            </Box>
            {rec.evidence.map((line, i) => (
              <Text key={`rec-${rec.id}-ev-${i}`} dimColor>{`• ${line}`}</Text>
            ))}
            <Text>{`→ ${rec.action}`}</Text>
            <Text color={STATUS.good}>
              {`Est. saving: ${pct(rec.saving, rep.weighted)}${rep.usd === null ? '' : ` · ≈ ${fmtUsd((rep.usd * rec.saving) / rep.weighted)}`}`}
            </Text>
            {actionRow(actionsFor(rec.id), `rec-${rec.id}`)}
          </Box>
        )),
        rep.wins.length > 0
          ? section(
              'What went well',
              ...rep.wins.map((w, i) => (
                <Text key={`win-${i}`}>
                  <Text color={STATUS.good}>✓ </Text>
                  {w}
                </Text>
              )),
            )
          : null,
        isPast
          ? null
          : section(
              'Deeper review by Claude',
              view.review.status === 'done' ? (
                <Box flexDirection="column">
                  <Markdown text={view.review.text} />
                  <Text dimColor>{`This review used ${fmtTokens(view.review.tokens)} tokens, mostly read from cache.`}</Text>
                </Box>
              ) : view.review.status === 'running' ? (
                <Box flexDirection="row" gap={1} alignItems="center">
                  {Svg ? <Svg source={pulseSvg()} alt="Reviewing" width={16} height={16} isInteractive /> : null}
                  <Text dimColor>Claude is reviewing this session…</Text>
                </Box>
              ) : (
                <Box flexDirection="column">
                  {view.review.status === 'error' ? <Text color={STATUS.warning}>{view.review.text}</Text> : null}
                  <Text dimColor>
                    Asks Claude, over this conversation, for advice specific to what happened. One extra request, mostly served from cache.
                  </Text>
                </Box>
              ),
              view.review.status === 'running' ? null : (
                <Button
                  key="review"
                  label={view.review.status === 'done' ? 'Ask again' : 'Ask Claude for a deeper review'}
                  onPress={() => later($, () => runReview($))}
                />
              ),
            ),
        <Text dimColor>
          Spend is priced in input-equivalent tokens with the API’s ratios: output ×5, cache write ×1.25 (5 min) or ×2 (1 h), cache
          read ×0.1. Dollar figures share the session’s /cost total in the same proportions.
        </Text>,
      ]
    }

    // ------------------------------------------------ History
    const history = () => {
      const projectFolder = view.transcriptPath?.split('/').at(-2)
      const sessions = view.history.filter(s => !view.isProjectOnly || (projectFolder && s.path.includes(`/${projectFolder}/`)))
      const rates = cache?.rates ?? {}
      const stats = insight(sessions, rates)
      const load = view.historyLoad
      const price = (s: SessionSummary): string => {
        const usd = usdOf(s, rates)

        return usd === null ? `${fmtTokens(s.weighted)} eq.` : `≈ ${fmtUsd(usd)}`
      }
      const allRules = rulesForAll(stats.recurring.slice(0, 5).map(x => x.id))

      return [
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button
            key="scope-all"
            label="All projects"
            variant={view.isProjectOnly ? 'secondary' : 'primary'}
            onPress={() => {
              view.isProjectOnly = false
              animate($)
            }}
          />
          <Button
            key="scope-project"
            label="This project"
            variant={view.isProjectOnly ? 'primary' : 'secondary'}
            onPress={() => {
              view.isProjectOnly = true
              animate($)
            }}
          />
        </Box>,
        load.status === 'loading' ? (
          <Text dimColor>{`${SPINNER[f % SPINNER.length]} Analyzing past sessions… ${load.done ?? 0}/${load.total ?? '?'} (each is read once, then cached)`}</Text>
        ) : null,
        load.status === 'error' ? <Text color={STATUS.critical}>{load.message}</Text> : null,
        sessions.length === 0 && load.status === 'ready' ? <Text dimColor>No past sessions found.</Text> : null,
        sessions.length > 0 ? (
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {tile('Sessions', String(Math.round(stats.sessions * p)), `of ${view.historyAvailable} on this machine`)}
            {tile('Spend', stats.usd === null ? fmtTokens(stats.weighted * p) : fmtUsd(stats.usd * p), stats.usd === null ? 'input-eq. tokens' : 'estimated at learned rates')}
            {tile('Avg. efficiency', `${Math.round(stats.averageScore * p)}/100`, `${stats.averageRequests} requests per session`)}
            {tile('Avoidable', pct(stats.avoidable * p, stats.weighted), 'of spend, by the same checks')}
          </Box>
        ) : null,
        sessions.length > 0
          ? section(
              'Spend per session',
              chart(
                historySvg(sessions, svgWidth, s => `${s.title} · ${s.project} · ${fmtDate(s.startedAt)} · ${price(s)} · score ${s.score}`),
                'Spend per past session',
                sparkline(
                  [...sessions].sort((a, b) => a.startedAt - b.startedAt).map((s, i) => ({ tokens: s.weighted, task: i, isCacheRebuild: false, isCompaction: false })),
                  Math.max(10, columns - 2),
                  p,
                ),
              ),
            )
          : null,
        stats.recurring.length > 0
          ? section(
              'What keeps costing you',
              <Text dimColor>The same checks as Tips, counted across these sessions. Rules apply to every future session.</Text>,
              ...stats.recurring.slice(0, 6).map(issue => (
                <Box key={`rec-hist-${issue.id}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
                  <Box flexDirection="row" justifyContent="space-between" gap={1}>
                    <Text bold>{issue.label}</Text>
                    <Text dimColor>{`${issue.sessions} of ${stats.sessions} sessions`}</Text>
                  </Box>
                  {meter(
                    issue.saving / Math.max(1, stats.weighted),
                    STATUS.warning,
                    `${pct(issue.saving, stats.weighted)} of spend avoidable`,
                    stats.usd === null ? `${fmtTokens(issue.saving)} eq.` : `≈ ${fmtUsd((stats.usd * issue.saving) / Math.max(1, stats.weighted))}`,
                    `hist-bar-${issue.id}`,
                  )}
                  <Text>{`→ ${issue.action}`}</Text>
                  {actionRow(actionsFor(issue.id).filter(a => a.scope === 'future' || issue.id === 'baseline'), `hist-${issue.id}`)}
                </Box>
              )),
              allRules ? actionRow([allRules], 'hist-all') : null,
            )
          : null,
        stats.habits.length > 0 ? section('Habits', ...stats.habits.map((line, i) => <Text key={`habit-${i}`}>{`• ${line}`}</Text>)) : null,
        sessions.length > 0
          ? section(
              'Sessions · newest first',
              ...sessions.map((s, i) => (
                <Button
                  key={`hist-${i}-${s.id}`}
                  plain
                  label={`${s.title.slice(0, 60)} · ${s.project} · ${fmtDate(s.startedAt)} · ${price(s)} · ${s.score}/100`}
                  onPress={() => later($, () => openPast($, s))}
                />
              )),
            )
          : null,
        view.historyAvailable > view.historyLimit && load.status === 'ready' ? (
          <Button
            key="history-more"
            label={`Load ${HISTORY_PAGE} older sessions`}
            onPress={() => {
              view.historyLimit += HISTORY_PAGE
              later($, () => indexHistory($))
            }}
          />
        ) : null,
        <Text dimColor>
          Past sessions are priced with the dollars-per-token this mod learns from your current sessions’ /cost totals; models it has not seen yet show input-equivalent tokens.
        </Text>,
      ]
    }

    // ------------------------------------------------ Storage & memory
    const storage = () => {
      const s = view.storage
      const load = view.storageLoad
      if (!s) {
        return [
          load.status === 'error' ? (
            <Text color={STATUS.critical}>{load.message}</Text>
          ) : (
            <Text dimColor>{`${SPINNER[f % SPINNER.length]} Measuring disk and memory… step ${load.done ?? 0} of ${load.total ?? 7}`}</Text>
          ),
        ]
      }
      const disk = s.groups.flatMap(g => g.items)
      const reclaimable = disk.filter(i => !i.isRevealOnly).reduce((n, i) => n + i.bytes, 0)
      const idle = s.sessions.filter(x => !x.isCurrent && (x.idleMs ?? 0) >= 3 * 3_600_000)
      const idleKb = idle.reduce((n, x) => n + x.memoryKb, 0)
      const memShare = s.memory.totalBytes > 0 ? s.memory.usedBytes / s.memory.totalBytes : 0

      const itemRow = (group: DiskGroup, item: DiskItem) => (
        <Box key={`item-${item.id}`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text wrap="truncate-end">{item.label}</Text>
            <Text bold>{fmtBytes(item.bytes)}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">{item.detail}</Text>
          <Box flexDirection="row" gap={1}>
            {item.isRevealOnly ? null : (
              <Button
                key={`trash-${item.id}`}
                label={confirmLabel(`trash-${item.id}`, 'Move to Trash')}
                dimColor={view.pending !== `trash-${item.id}`}
                onPress={confirmed(`trash-${item.id}`, () => trashItems($, [item]))}
              />
            )}
            <Button key={`reveal-${item.id}`} label="Show in Finder" dimColor onPress={() => later($, () => reveal($, item.paths[0]!))} />
          </Box>
        </Box>
      )

      return [
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          <Text dimColor>Not used for</Text>
          {[7, 30, 90].map(days => (
            <Button
              key={`days-${days}`}
              label={`${days} days`}
              variant={view.storageDays === days ? 'primary' : 'secondary'}
              onPress={() => {
                view.storageDays = days
                later($, () => scanStorage($))
              }}
            />
          ))}
        </Box>,
        load.status === 'loading' ? <Text dimColor>{`${SPINNER[f % SPINNER.length]} Measuring again…`}</Text> : null,
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {tile('Reclaimable disk', fmtBytes(reclaimable * p), `${disk.filter(i => !i.isRevealOnly).length} items, to the Trash`)}
          {tile('Memory in use', s.memory.totalBytes ? `${Math.round(memShare * 100 * p)}%` : '—', `${fmtBytes(s.memory.usedBytes)} of ${fmtBytes(s.memory.totalBytes)}`)}
          {tile('Idle Claude sessions', String(Math.round(idle.length * p)), `${fmtBytes(idleKb * 1024)} of memory`)}
        </Box>,

        section(
          'Memory',
          s.memory.totalBytes ? meter(memShare, memShare > 0.85 ? STATUS.critical : memShare > 0.7 ? STATUS.warning : STATUS.good, 'In use (active, wired, compressed)', `${fmtBytes(s.memory.usedBytes)} of ${fmtBytes(s.memory.totalBytes)}`, 'mem-bar') : null,
          <Text dimColor>The desktop app keeps a Claude Code process running for each session you opened. Quitting one frees its memory and keeps its history; opening that session again starts it again.</Text>,
          ...s.sessions.map(x => (
            <Box key={`proc-${x.pid}`} flexDirection="row" justifyContent="space-between" gap={1} alignItems="center">
              <Box flexDirection="column" flexShrink={1}>
                <Text wrap="truncate-end">{`${x.isCurrent ? '● ' : ''}${x.title}`}</Text>
                <Text dimColor>{`${fmtBytes(x.memoryKb * 1024)} · running ${fmtAge(x.runningSec * 1000)}${x.idleMs === null ? '' : ` · idle ${fmtAge(x.idleMs)}`}${x.isCurrent ? ' · this session' : ''}`}</Text>
              </Box>
              {x.isCurrent ? null : (
                <Button
                  key={`quit-${x.pid}`}
                  label={confirmLabel(`quit-${x.pid}`, 'Quit')}
                  dimColor={view.pending !== `quit-${x.pid}`}
                  onPress={confirmed(`quit-${x.pid}`, () => quitProcesses($, [{ pid: x.pid, name: x.title, isApp: false }]))}
                />
              )}
            </Box>
          )),
          idle.length > 1 ? (
            <Button
              key="quit-idle"
              label={confirmLabel('quit-idle', `Quit ${idle.length} sessions idle over 3h (frees ~${fmtBytes(idleKb * 1024)})`)}
              variant="primary"
              onPress={confirmed('quit-idle', () => quitProcesses($, idle.map(x => ({ pid: x.pid, name: x.title, isApp: false }))))}
            />
          ) : null,
          s.apps.length > 0 ? <Text bold>Other apps using over 150 MB</Text> : null,
          ...s.apps.slice(0, 10).map(a => (
            <Box key={`app-${a.name}`} flexDirection="row" justifyContent="space-between" gap={1} alignItems="center">
              <Box flexDirection="column" flexShrink={1}>
                <Text wrap="truncate-end">{a.name}</Text>
                <Text dimColor>{`${fmtBytes(a.memoryKb * 1024)} · running ${fmtAge(a.runningSec * 1000)}`}</Text>
              </Box>
              <Button
                key={`quitapp-${a.name}`}
                label={confirmLabel(`quitapp-${a.name}`, 'Quit')}
                dimColor={view.pending !== `quitapp-${a.name}`}
                onPress={confirmed(`quitapp-${a.name}`, () => quitProcesses($, [{ pid: a.pid, name: a.name, isApp: a.isApp }]))}
              />
            </Box>
          )),
        ),

        ...s.groups
          .filter(g => g.items.length > 0)
          .map(g => {
            const total = g.items.reduce((n, i) => n + i.bytes, 0)
            const isOpen = view.expanded.has(g.id)
            const trashable = g.items.filter(i => !i.isRevealOnly)

            return (
              <Box key={`group-${g.id}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} gap={1}>
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Text bold>{g.title}</Text>
                  <Text bold>{fmtBytes(total)}</Text>
                </Box>
                <Text dimColor>{g.note}</Text>
                {(isOpen ? g.items : g.items.slice(0, ITEMS_SHOWN)).map(item => itemRow(g, item))}
                <Box flexDirection="row" gap={1} flexWrap="wrap">
                  {g.items.length > ITEMS_SHOWN ? (
                    <Button
                      key={`more-${g.id}`}
                      label={isOpen ? 'Show fewer' : `Show all ${g.items.length}`}
                      dimColor
                      onPress={() => {
                        if (isOpen) view.expanded.delete(g.id)
                        else view.expanded.add(g.id)
                        redraw($)
                      }}
                    />
                  ) : null}
                  {trashable.length > 1 ? (
                    <Button
                      key={`trash-all-${g.id}`}
                      label={confirmLabel(`trash-all-${g.id}`, `Move all ${trashable.length} to Trash (${fmtBytes(trashable.reduce((n, i) => n + i.bytes, 0))})`)}
                      onPress={confirmed(`trash-all-${g.id}`, () => trashItems($, trashable))}
                    />
                  ) : null}
                </Box>
              </Box>
            )
          }),
        disk.length === 0 ? <Text dimColor>{`Nothing unused for ${view.storageDays} days was found.`}</Text> : null,
        <Text dimColor>
          Removed items go to the Trash and can be put back until you empty it. This session, its project and this mod are never offered.
        </Text>,
      ]
    }

    if (view.tab !== 'history' && view.tab !== 'storage' && !r) {
      return (
        <Box flexDirection="column" gap={1} paddingX={1}>
          {header}
          {status.status === 'error' ? (
            <Text color={STATUS.critical}>{status.message}</Text>
          ) : (
            <Text dimColor>{`${SPINNER[f % SPINNER.length]} ${progressText(status, `Reading ${isPast ? 'that' : 'this'} session’s log`)}`}</Text>
          )}
        </Box>
      )
    }

    const body =
      view.tab === 'history'
        ? history()
        : view.tab === 'storage'
          ? storage()
          : !r
            ? []
            : view.tab === 'tasks'
              ? tasks(r)
              : view.tab === 'tips'
                ? tips(r)
                : overview(r)

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {header}
        {status.status === 'error' && view.tab !== 'history' && view.tab !== 'storage' ? <Text color={STATUS.critical}>{status.message}</Text> : null}
        {status.status === 'loading' && r && view.tab !== 'history' && view.tab !== 'storage' && status.total ? (
          <Text dimColor>{`${SPINNER[f % SPINNER.length]} ${progressText(status, 'Reading new log entries')}`}</Text>
        ) : null}
        {body}
        {r && view.tab !== 'history' && view.tab !== 'storage' ? (
          <Text dimColor>
            {`Updated ${new Date(r.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${fmtBytes(r.transcriptBytes)} log${running && !isPast ? ' · refreshes while Claude works' : ''}`}
          </Text>
        ) : null}
      </Box>
    )
  })
}
