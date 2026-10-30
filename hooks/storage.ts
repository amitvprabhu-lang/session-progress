/*
 * Disk and memory: parsing what the host's tools print, and deciding what is
 * safe to offer for removal. Pure: register.tsx runs the commands.
 */

export type Proc = {
  pid: number
  ppid: number
  /** Resident memory, KiB. */
  rss: number
  elapsedSec: number
  cpuSec: number
  args: string
}

export type SessionProc = {
  pid: number
  sessionId: string
  title: string
  /** The process and everything it started (MCP servers, shells), KiB. */
  memoryKb: number
  runningSec: number
  /** Since the session's log last changed; null when the log was not found. */
  idleMs: number | null
  isCurrent: boolean
}

export type AppProc = {
  /** The main process to signal. */
  pid: number
  name: string
  memoryKb: number
  runningSec: number
  cpuSec: number
  /** Quit through the app (`osascript`), or by signal for a plain process. */
  isApp: boolean
}

export type DiskItem = {
  id: string
  label: string
  detail: string
  /** Every path that goes to the Trash together (a session log and its folder). */
  paths: string[]
  bytes: number
  lastUsedMs: number
  /** Only shown in Finder: data the Claude app manages itself. */
  isRevealOnly: boolean
  /** Run after the move: `git worktree prune` for a removed worktree. */
  pruneRepo?: string
}

export type DiskGroup = {
  id: string
  title: string
  note: string
  items: DiskItem[]
}

export type MemoryInfo = { totalBytes: number; usedBytes: number }

/** `etime` as ps prints it: [[dd-]hh:]mm:ss. */
export const parseElapsed = (text: string): number => {
  const [days, rest] = text.includes('-') ? text.split('-') : ['0', text]
  const parts = (rest ?? '').split(':').map(Number)
  while (parts.length < 3) parts.unshift(0)
  const [h, m, s] = parts as [number, number, number]

  return Number(days) * 86_400 + h * 3600 + m * 60 + s
}

/** `time` as ps prints it: [hh:]mm:ss.ss, or with days. */
export const parseCpu = (text: string): number => parseElapsed(text.replace(/\.\d+$/, ''))

/** Lines of `ps -axo pid=,ppid=,rss=,etime=,time=,args=`. */
export const parsePs = (stdout: string): Proc[] =>
  stdout
    .split('\n')
    .map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rss: Number(m[3]),
      elapsedSec: parseElapsed(m[4]!),
      cpuSec: parseCpu(m[5]!),
      args: m[6]!,
    }))

const childrenOf = (procs: Proc[]): Map<number, Proc[]> => {
  const out = new Map<number, Proc[]>()
  for (const p of procs) out.set(p.ppid, [...(out.get(p.ppid) ?? []), p])

  return out
}

const treeKb = (pid: number, kids: Map<number, Proc[]>, self: Proc): number => {
  let total = self.rss
  const stack = [...(kids.get(pid) ?? [])]
  const seen = new Set<number>([pid])
  while (stack.length > 0) {
    const p = stack.pop()!
    if (seen.has(p.pid)) continue
    seen.add(p.pid)
    total += p.rss
    stack.push(...(kids.get(p.pid) ?? []))
  }

  return total
}

const CLI = /\/claude\.app\/Contents\/MacOS\/claude(\s|$)/
const SESSION_ARG = /--(?:resume|session-id)[= ]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/

export const isClaudeCli = (p: Proc): boolean => CLI.test(p.args) && !p.args.includes('/Helpers/disclaimer')

/** The session's id from a Claude Code process's arguments; a new session's carries none. */
export const sessionIdOf = (p: Proc): string => SESSION_ARG.exec(p.args)?.[1] ?? ''

/** The Claude Code process `pid` runs under: itself or its nearest such ancestor. */
export const owningCli = (procs: Proc[], pid: number): number | null => {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  let at = byPid.get(pid)
  for (let hops = 0; at && hops < 20; hops++) {
    if (isClaudeCli(at)) return at.pid
    at = byPid.get(at.ppid)
  }

  return null
}

/**
 * The Claude Code processes the desktop app keeps, one per open session.
 * `sessions` names them by id; `byPid` names those started without one.
 */
export const sessionProcs = (
  procs: Proc[],
  current: { id: string; pid: number | null },
  sessions: Map<string, { title: string; lastActivityMs: number }>,
  byPid: Map<number, { title: string; lastActivityMs: number }>,
  now: number,
): SessionProc[] => {
  const kids = childrenOf(procs)

  return procs
    .filter(isClaudeCli)
    .map(p => {
      const sessionId = sessionIdOf(p)
      const known = sessions.get(sessionId) ?? byPid.get(p.pid)

      return {
        pid: p.pid,
        sessionId,
        title: known?.title ?? (sessionId ? `Session ${sessionId.slice(0, 8)}` : 'Unnamed session'),
        memoryKb: treeKb(p.pid, kids, p),
        runningSec: p.elapsedSec,
        idleMs: known ? Math.max(0, now - known.lastActivityMs) : null,
        isCurrent: p.pid === current.pid || (sessionId !== '' && sessionId === current.id),
      }
    })
    .sort((a, b) => b.memoryKb - a.memoryKb)
}

/** Lines of `lsof -a -d cwd -Fpn -p <pids>`: each process's working directory. */
export const parseLsofCwd = (stdout: string): Map<number, string> => {
  const out = new Map<number, string>()
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) out.set(pid, line.slice(1))
  }

  return out
}

/** Never offered for quitting: the system, the shell around you, and Claude itself. */
const PROTECTED =
  /\/(Claude|Finder|Dock|SystemUIServer|loginwindow|WindowServer|ControlCenter|NotificationCenter|Spotlight|coreaudiod|launchd|kernel_task|mds|mds_stores|cloudd|bird|Terminal|iTerm2)(\s|$)|\/Claude\.app\//

const appOf = (args: string): { name: string; isApp: boolean; isMain: boolean } => {
  const app = /\/([^/]+)\.app\/Contents\/MacOS\/([^/]+?)(?:\s|$)/.exec(args)
  if (app) {
    const outer = /\/([^/]+)\.app\//.exec(args)?.[1] ?? app[1]!

    return { name: outer, isApp: true, isMain: !args.includes('Helper') && !args.includes('/Frameworks/') }
  }
  const bin = args.split(/\s+/)[0]?.split('/').at(-1) ?? args

  return { name: bin, isApp: false, isMain: true }
}

/** The heaviest apps and processes outside Claude, grouped by app, memory summed. */
export const heavyApps = (procs: Proc[], minKb: number): AppProc[] => {
  const byName = new Map<string, AppProc>()
  for (const p of procs) {
    if (CLI.test(p.args) || PROTECTED.test(p.args) || p.args.startsWith('/System/') || p.args.startsWith('/usr/libexec/')) continue
    const { name, isApp, isMain } = appOf(p.args)
    const now = byName.get(name) ?? { pid: p.pid, name, memoryKb: 0, runningSec: p.elapsedSec, cpuSec: 0, isApp }
    now.memoryKb += p.rss
    now.cpuSec += p.cpuSec
    if (isMain) {
      now.pid = p.pid
      now.runningSec = p.elapsedSec
    }
    byName.set(name, now)
  }

  return [...byName.values()].filter(a => a.memoryKb >= minKb).sort((a, b) => b.memoryKb - a.memoryKb)
}

/** `vm_stat` and `sysctl -n hw.memsize`: memory in use is active, wired and compressed pages. */
export const parseMemory = (vmStat: string, memsize: string): MemoryInfo => {
  const page = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1] ?? 4096)
  const pages = (label: string): number => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(vmStat)?.[1] ?? 0)
  const used = (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page

  return { totalBytes: Number(memsize.trim()) || 0, usedBytes: used }
}

/** Lines of `du -sk <paths>`: KiB, a tab, the path. */
export const parseDu = (stdout: string): Map<string, number> => {
  const out = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const m = /^(\d+)\t(.+)$/.exec(line)
    if (m) out.set(m[2]!, Number(m[1]) * 1024)
  }

  return out
}

/** Lines of `stat -f '%z\t%m\t%N'`: bytes, seconds since the epoch, path. */
export const parseStat = (stdout: string): { path: string; bytes: number; mtimeMs: number }[] =>
  stdout
    .split('\n')
    .map(line => /^(\d+)\t(\d+)\t(.+)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => ({ bytes: Number(m[1]), mtimeMs: Number(m[2]) * 1000, path: m[3]! }))

/**
 * A path may go to the Trash only inside these places (never one of the
 * places itself), or when the scan found it exactly (a worktree, a
 * node_modules); never what `keep` holds or anything holding it.
 */
export const isSafeToTrash = (path: string, home: string, found: string[], keep: string[]): boolean => {
  if (!path.startsWith('/') || path.includes('/../') || path.endsWith('/..')) return false
  const clean = path.replace(/\/+$/, '')
  if (keep.some(k => clean === k || k.startsWith(`${clean}/`) || clean.startsWith(`${k}/`))) return false
  if (found.includes(clean)) return true
  const inside = [
    `${home}/.claude/projects/`,
    `${home}/.claude/file-history/`,
    `${home}/.claude/shell-snapshots/`,
    `${home}/.claude/debug/`,
    `${home}/.claude/dev-mods/`,
    `${home}/.claude/paste-cache/`,
    `${home}/.claude/todos/`,
    `${home}/Library/Application Support/Claude/claude-code/`,
    `${home}/Downloads/`,
  ]

  return inside.some(a => clean.startsWith(a) && clean.length > a.length)
}

/** Folders a package manager or build rebuilds on its own. */
export const REBUILDABLE = ['node_modules', '.next', '.nuxt', '.venv', 'venv', '.turbo', '.parcel-cache', '.svelte-kit']

export const fmtBytes = (n: number): string => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`

  return `${n} B`
}

export const fmtAge = (ms: number): string => {
  const days = ms / 86_400_000
  if (days >= 2) return `${Math.floor(days)} days`
  const hours = ms / 3_600_000
  if (hours >= 1) return `${Math.floor(hours)}h`

  return `${Math.max(1, Math.round(ms / 60_000))}m`
}
