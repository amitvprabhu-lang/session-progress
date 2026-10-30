import type {
  LoadedServer,
  Advice,
  AdviceOption,
  HistoryInsight,
  RecurringIssue,
  Report,
  SessionSummary,
} from '../types'
import { fmtTokens, ISSUES } from './analyze'

/*
 * What to do next, what keeps going wrong across sessions, and the actions
 * that hand a fix to Claude. Pure: register.tsx gathers the inputs.
 */

const W_CACHE_READ = 0.1

// ---------------------------------------------------------------- actions

export type ActionKind = 'prompt' | 'compact' | 'clear'

export type Action = {
  key: string
  label: string
  kind: ActionKind
  /** The prompt Claude is sent, or /compact's instructions. */
  text: string
  /** `session` acts on the live session; `future` on every session after it. */
  scope: 'session' | 'future'
}

const COMPACT_INSTRUCTIONS =
  'Keep: the current goal, decisions made, open steps, and the file paths and commands that matter. Drop: raw tool output, dead-end exploration and finished side tasks.'

const SUBAGENT_TEXT =
  'For the next step, do the broad reading, searching or research in a subagent on a smaller model, and bring back only a short summary with file paths and line numbers.'

const HANDOFF =
  'I am switching to a new, unrelated task. Start a new session for it with a short brief of anything from this session it needs (decisions, file paths, conventions). If I have not said what the new task is, ask me first.'

const RULES: Record<string, string> = {
  'big-results': 'Keep tool output small: search before reading, read large files in ranges, and pipe long command output through head, tail or grep.',
  rereads: 'Do not re-read a file that is already in context unless it changed; after an edit, read only the changed range.',
  parallel: 'Batch independent reads, searches and checks into one step so they run in parallel.',
  cache: 'When a long session has been idle past the prompt-cache window, suggest /compact or a new session before continuing.',
  carryover: 'When I switch to an unrelated topic in a long session, suggest starting a new session with a short handoff brief.',
  'context-full': 'When context passes 60%, suggest /compact with what to keep before the next big step.',
  effort: 'Suggest a lower effort level for routine, mechanical steps.',
  'subagent-model': 'Give read-only exploration subagents a smaller model (sonnet or haiku).',
  'small-tasks': 'For quick questions and lookups, suggest switching to a smaller, faster model.',
  'long-history': 'When a feature or plan step is finished and context is over 200k tokens, suggest /compact (with what to keep) or a new session.',
  browser: 'In browser automation, prefer page text, accessibility reads and element search over screenshots; screenshot at reduced scale only when layout matters; batch browser actions.',
}

const SESSION_PROMPTS: Record<string, { label: string; text: string }> = {
  'big-results': {
    label: 'Keep outputs small',
    text: 'For the rest of this session, keep tool output small: search before reading, read large files with offset/limit, and pipe long command output through head, tail or grep.',
  },
  rereads: {
    label: 'Stop re-reading',
    text: 'For the rest of this session, do not re-read files that are already in context unless they changed; refer back to the earlier read, or read only the changed range after an edit.',
  },
  parallel: {
    label: 'Batch look-ups',
    text: 'For the rest of this session, batch independent reads, searches and status checks into a single step so they run in parallel.',
  },
  baseline: {
    label: 'Review connectors',
    text: 'List the connectors (MCP servers) and plugins loaded in this session, mark which ones this session actually used, and offer to turn off the unused ones for this project. Do not change anything until I confirm.',
  },
  effort: {
    label: 'Lower effort',
    text: 'Lower this session’s effort level to medium for routine steps, and tell me when a step needs high effort.',
  },
  'subagent-model': {
    label: 'Smaller subagents',
    text: 'For the rest of this session, when you spawn subagents for reading, searching or research, give them model "sonnet" (or "haiku" for simple lookups).',
  },
  browser: {
    label: 'Lighter browser steps',
    text: 'For the rest of this session, in browser automation prefer page text, accessibility reads and element search over screenshots, screenshot at reduced scale only when layout matters, and batch clicks and typing into one step.',
  },
  'small-tasks': {
    label: 'Use a faster model',
    text: 'Switch this session to a smaller, faster model for quick questions, and tell me which one you picked.',
  },
}

export const ruleAction = (id: string): Action | null => {
  const rule = RULES[id]

  return rule
    ? {
        key: `rule-${id}`,
        label: 'Make it a rule',
        kind: 'prompt',
        scope: 'future',
        text: `Add this rule to a "Token efficiency" section of my user-level ~/.claude/CLAUDE.md, so every session follows it (create the section if missing, keep it to one line, skip it if an equivalent rule is there, and show me the line before saving):\n${rule}`,
      }
    : null
}

/** The buttons a recommendation offers, live-session ones first. */
export const actionsFor = (id: string): Action[] => {
  const out: Action[] = []
  const prompt = SESSION_PROMPTS[id]
  if (prompt) out.push({ key: `do-${id}`, label: prompt.label, kind: 'prompt', scope: 'session', text: prompt.text })
  if (id === 'context-full' || id === 'long-history') {
    out.push({ key: 'do-compact', label: 'Compact now', kind: 'compact', scope: 'session', text: COMPACT_INSTRUCTIONS })
  }
  if (id === 'carryover') {
    out.push({ key: 'do-handoff', label: 'New session with brief', kind: 'prompt', scope: 'session', text: HANDOFF })
  }
  const rule = ruleAction(id)
  if (rule) out.push(rule)

  return out
}

/** One prompt that turns the top recurring issues into standing rules. */
export const rulesForAll = (ids: string[]): Action | null => {
  const rules = ids.map(id => RULES[id]).filter((r): r is string => Boolean(r))
  if (rules.length === 0) return null

  return {
    key: 'rules-all',
    label: 'Make these rules for every session',
    kind: 'prompt',
    scope: 'future',
    text: `Add these rules to a "Token efficiency" section of my user-level ~/.claude/CLAUDE.md, so every session follows them (create the section if missing, one line each, skip any that an existing rule already covers, and show me the lines before saving):\n${rules.map(r => `- ${r}`).join('\n')}`,
  }
}

// ---------------------------------------------------------------- what to do next

export type AdviceInput = {
  now: number
  lastActivity: number
  isTurnRunning: boolean
  contextTokens: number
  window: number
  baseline: number
  /** How long the prompt cache keeps the conversation. */
  cacheTtlMs: number
  /** Whether the latest plan is all done; null with no plan. */
  isPlanDone: boolean | null
  /** Tokens an average read-type tool result added to context. */
  averageReadTokens: number
  usdPerWeighted: number | null
  /** Background work still running (shells, subagents, monitors, workflows) and wake-ups scheduled. */
  background: string[]
}

const money = (weighted: number, rate: number | null): string =>
  rate === null ? `~${fmtTokens(weighted)} input-eq. tokens` : `≈ $${(weighted * rate).toFixed(weighted * rate < 1 ? 3 : 2)}`

export const advise = (a: AdviceInput): Advice => {
  const writeWeight = a.cacheTtlMs > 5 * 60_000 ? 2 : 1.25
  const idleMs = a.isTurnRunning ? 0 : Math.max(0, a.now - a.lastActivity)
  const isCold = a.lastActivity > 0 && idleMs > a.cacheTtlMs
  const baseline = Math.min(a.baseline || a.contextTokens, a.contextTokens)
  const history = Math.max(0, a.contextTokens - baseline)
  const share = a.window > 0 ? a.contextTokens / a.window : 0
  const nextCost = a.contextTokens * (isCold ? writeWeight : W_CACHE_READ)
  const freshCost = baseline * writeWeight
  const perRequest = history * W_CACHE_READ
  const breakEven = perRequest > 0 ? Math.ceil((baseline * (writeWeight - W_CACHE_READ)) / perRequest) : Infinity
  const idleText = idleMs >= 3_600_000 ? `${Math.floor(idleMs / 3_600_000)}h ${Math.round((idleMs % 3_600_000) / 60_000)}m` : `${Math.round(idleMs / 60_000)}m`

  const options: AdviceOption[] = [
    {
      id: 'continue',
      title: 'Continue here',
      when: 'The next step builds on what is already in this conversation.',
      detail: `Next request reads ${fmtTokens(a.contextTokens)} tokens${isCold ? ', re-written to cache at full price' : ' from cache'} (${money(nextCost, a.usdPerWeighted)}).`,
    },
    {
      id: 'compact',
      title: 'Compact, then continue',
      when: 'Same topic, but the history is long and most of it is no longer needed.',
      detail: `Shrinks ~${fmtTokens(history)} of history to a short summary; every later request is lighter by about that much.`,
    },
    {
      id: 'new-session',
      title: 'Start a new session',
      when: 'The next request is a new, unrelated topic.',
      detail: isCold
        ? `Cheaper from the first request: re-caches only the ~${fmtTokens(baseline)} base (${money(freshCost, a.usdPerWeighted)}) instead of all ${fmtTokens(a.contextTokens)}.`
        : history < 5_000
          ? 'Little history here yet, so staying costs about the same.'
          : `Re-caches the ~${fmtTokens(baseline)} base once (${money(freshCost, a.usdPerWeighted)}), then saves ~${fmtTokens(history)} per request: pays off after ${breakEven} request${breakEven === 1 ? '' : 's'}.`,
    },
    {
      id: 'subagent',
      title: 'Hand it to a subagent or side session',
      when: 'The next step is broad reading, searching or research, or a side quest you do not need in this thread.',
      detail:
        a.averageReadTokens > 0
          ? `Reads here averaged ~${fmtTokens(a.averageReadTokens)} tokens each and stay for every later request; a subagent keeps them out and returns only its summary.`
          : 'Its reads and searches stay out of this context; only its summary comes back.',
    },
  ]

  const reasons: string[] = []
  // Background work reports back into this session: leaving it now would strand the results.
  if (a.background.length > 0) {
    const n = a.background.length
    for (const o of options) {
      if (o.id === 'new-session' || o.id === 'compact') o.detail = `Wait until the background work is done. ${o.detail}`
    }

    return {
      verdict: 'continue',
      headline: `${n} background task${n === 1 ? '' : 's'} still running: stay in this session; the results come back here.`,
      reasons: a.background.slice(0, 4).map(b => `Running: ${b}`),
      options,
      isUrgent: false,
    }
  }
  let verdict: Advice['verdict'] = 'continue'
  let headline = 'Keep going here: context is small and the cache is warm.'
  let isUrgent = false

  if (share >= 0.75) {
    verdict = a.isPlanDone === true ? 'new-session' : 'compact'
    headline =
      verdict === 'compact'
        ? `Context is ${Math.round(share * 100)}% full: compact before the next big step.`
        : `Context is ${Math.round(share * 100)}% full and the plan is done: start the next task in a new session.`
    reasons.push(`${fmtTokens(a.contextTokens)} of ${fmtTokens(a.window)} tokens in use; quality and cost both suffer as it fills.`)
    isUrgent = true
  } else if (isCold && history >= 30_000) {
    verdict = a.isPlanDone === false ? 'compact' : 'new-session'
    headline =
      verdict === 'new-session'
        ? `Idle ${idleText}, the cache has expired: a new session is cheaper for anything new.`
        : `Idle ${idleText}, the cache has expired: compact so the re-cache is small.`
    reasons.push(`Continuing re-writes all ${fmtTokens(a.contextTokens)} tokens to cache (${money(a.contextTokens * writeWeight, a.usdPerWeighted)}).`)
    isUrgent = true
  } else if (a.isPlanDone === true && history >= 40_000) {
    verdict = 'new-session'
    headline = 'The plan is done. If the next request is a new topic, start a new session.'
    reasons.push(`This session carries ~${fmtTokens(history)} of history that a new topic would pay for on every request.`)
  } else if (share >= 0.5) {
    verdict = 'compact'
    headline = `Context is ${Math.round(share * 100)}% full: compact at the next natural break.`
    reasons.push(`${fmtTokens(history)} of conversation history rides along with each request.`)
  }
  if (!isCold && a.lastActivity > 0 && !a.isTurnRunning) {
    const left = Math.max(0, a.cacheTtlMs - idleMs)
    reasons.push(`Cache stays warm for about ${Math.round(left / 60_000)} more minute${Math.round(left / 60_000) === 1 ? '' : 's'}.`)
  }

  return { verdict, headline, reasons, options, isUrgent }
}

export const adviceActions = (id: Advice['verdict']): Action[] => {
  if (id === 'compact') {
    return [{ key: 'advice-compact', label: 'Compact now', kind: 'compact', scope: 'session', text: COMPACT_INSTRUCTIONS }]
  }
  if (id === 'new-session') {
    return [
      { key: 'advice-handoff', label: 'New session with brief', kind: 'prompt', scope: 'session', text: HANDOFF },
      { key: 'advice-clear', label: 'Clear this session', kind: 'clear', scope: 'session', text: '' },
    ]
  }
  if (id === 'subagent') {
    return [
      {
        key: 'advice-subagent',
        label: 'Use subagents for this',
        kind: 'prompt',
        scope: 'session',
        text: SUBAGENT_TEXT,
      },
    ]
  }

  return []
}

// ---------------------------------------------------------------- history

const baseName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

export const projectLabel = (cwd: string, folder: string): string => {
  if (cwd.includes('/scratch-workspaces/')) return 'No folder'
  const worktree = /^(.*)\/\.claude\/worktrees\/[^/]+/.exec(cwd)
  if (worktree?.[1]) return `${baseName(worktree[1])} · worktree`
  if (cwd) return baseName(cwd)

  return folder.replace(/^-/, '').split('-').filter(Boolean).at(-1) ?? folder
}

export const summarize = (
  r: Report,
  file: { id: string; path: string; folder: string; size: number; mtimeMs: number },
): SessionSummary => ({
  id: file.id,
  path: file.path,
  project: projectLabel(r.cwd, file.folder),
  title: r.title || r.tasks.find(t => t.requests > 0)?.title || 'Untitled session',
  startedAt: r.startedAt,
  endedAt: r.endedAt,
  requests: r.requests,
  tasks: r.tasks.filter(t => t.requests > 0).length,
  weighted: r.weighted,
  tokens: r.tokens.input + r.tokens.cacheWrite + r.tokens.cacheRead + r.tokens.output,
  model: r.model,
  score: r.score,
  issues: r.recommendations.map(x => ({ id: x.id, saving: x.saving })),
  serversUsed: r.serversUsed,
  skillsUsed: r.skillsUsed,
  size: file.size,
  mtimeMs: file.mtimeMs,
})

export const usdOf = (s: { weighted: number; model: string }, rates: Record<string, number>): number | null => {
  const rate = rates[s.model]

  return rate === undefined ? null : s.weighted * rate
}

export const insight = (sessions: SessionSummary[], rates: Record<string, number>): HistoryInsight => {
  const weighted = sessions.reduce((n, s) => n + s.weighted, 0)
  const priced = sessions.map(s => usdOf(s, rates))
  const usd = priced.some(p => p !== null) ? priced.reduce<number>((n, p) => n + (p ?? 0), 0) : null
  const avoidable = sessions.reduce((n, s) => n + s.issues.reduce((m, i) => m + i.saving, 0), 0)
  const byIssue = new Map<string, RecurringIssue>()
  for (const s of sessions) {
    for (const i of s.issues) {
      const known = ISSUES[i.id]
      if (!known) continue
      const now = byIssue.get(i.id) ?? { id: i.id, label: known.label, action: known.action, sessions: 0, saving: 0 }
      now.sessions += 1
      now.saving += i.saving
      byIssue.set(i.id, now)
    }
  }
  const count = Math.max(1, sessions.length)
  const habits: string[] = []
  if (sessions.length > 0) {
    const multi = sessions.filter(s => s.tasks > 1).length
    const long = sessions.filter(s => s.endedAt - s.startedAt > 3 * 3_600_000).length
    habits.push(`Sessions average ${Math.round(sessions.reduce((n, s) => n + s.requests, 0) / count)} requests and ${(sessions.reduce((n, s) => n + s.tasks, 0) / count).toFixed(1)} tasks`)
    if (multi > 0) habits.push(`${multi} of ${sessions.length} sessions handled more than one task`)
    if (long > 0) habits.push(`${long} session${long === 1 ? '' : 's'} ran longer than 3 hours`)
    const models = new Map<string, number>()
    for (const s of sessions) models.set(s.model, (models.get(s.model) ?? 0) + 1)
    const top = [...models.entries()].sort((a, b) => b[1] - a[1])[0]
    if (top) habits.push(`${top[1]} of ${sessions.length} sessions ran mainly on ${top[0] || 'an unknown model'}`)
  }

  return {
    sessions: sessions.length,
    weighted,
    usd,
    avoidable,
    averageScore: Math.round(sessions.reduce((n, s) => n + s.score, 0) / count),
    averageRequests: Math.round(sessions.reduce((n, s) => n + s.requests, 0) / count),
    recurring: [...byIssue.values()].sort((a, b) => b.saving - a.saving),
    habits,
  }
}


/** Whether a prompt is one this mod's buttons send: how a click queued before a reload is told apart. */
export const isActionText = (text: string): boolean =>
  text === HANDOFF ||
  text === SUBAGENT_TEXT ||
  Object.values(SESSION_PROMPTS).some(p => p.text === text) ||
  Object.keys(RULES).some(id => ruleAction(id)?.text === text) ||
  text.startsWith('Add these rules to a "Token efficiency" section of my user-level ~/.claude/CLAUDE.md') ||
  text.startsWith('These MCP servers are loaded but were not used')

// ---------------------------------------------------------------- tips as you go

/** A recommendation offered above the prompt while the session runs. */
export type Tip = {
  id: string
  title: string
  detail: string
  actions: Action[]
}

const RANK = { low: 1, medium: 2, high: 3 } as const

/**
 * The tip worth showing now: the largest saving not dismissed, that is new
 * or has grown more severe since it was last shown.
 */
export const pickTip = (
  recs: readonly { id: string; title: string; evidence: string[]; action: string; severity: keyof typeof RANK; saving: number }[],
  shown: ReadonlyMap<string, number>,
  dismissed: ReadonlySet<string>,
): Tip | null => {
  const fresh = recs
    .filter(r => !dismissed.has(r.id) && r.severity !== 'low' && RANK[r.severity] > (shown.get(r.id) ?? 0))
    .sort((a, b) => b.saving - a.saving)[0]

  return fresh
    ? { id: fresh.id, title: fresh.title, detail: fresh.evidence[0] ?? fresh.action, actions: actionsFor(fresh.id) }
    : null
}

export const tipRank = (severity: keyof typeof RANK): number => RANK[severity]

/** What keeps happening in this project's past sessions, offered once as a rule. */
export const projectTip = (sessions: SessionSummary[], dismissed: ReadonlySet<string>): Tip | null => {
  if (sessions.length < 3) return null
  const top = insight(sessions, {}).recurring.find(
    r => r.sessions / sessions.length >= 0.5 && !dismissed.has(`project-${r.id}`) && ruleAction(r.id),
  )

  return top
    ? {
        id: `project-${top.id}`,
        title: `In this project: ${top.label.toLowerCase()} (${top.sessions} of ${sessions.length} past sessions)`,
        detail: top.action,
        actions: [ruleAction(top.id)!],
      }
    : null
}

// ---------------------------------------------------------------- what is loaded but unused

/** Servers built into the app: always loaded, not something to switch off. */
const BUILT_IN = /^(ccd_|plugin-authoring$|session-progress$|Claude_Browser$|Claude_Code_iOS_Simulator$|visualize$|terminal$|scheduled-tasks$|mcp-registry$)/

/**
 * Groups the loaded MCP tools by server, names each by its tools' common
 * prefix (a connector's key is an id), and marks what this session and this
 * project's past sessions used.
 */
export const loadedServers = (
  tools: readonly { name: string; description: string; mcp: boolean }[],
  usedHere: readonly string[],
  past: readonly SessionSummary[],
): LoadedServer[] => {
  const byKey = new Map<string, { names: string[]; chars: number }>()
  for (const t of tools) {
    if (!t.mcp || !t.name.startsWith('mcp__')) continue
    const key = t.name.split('__')[1] ?? ''
    if (!key || BUILT_IN.test(key)) continue
    const now = byKey.get(key) ?? { names: [], chars: 0 }
    now.names.push(t.name.split('__').slice(2).join('__'))
    now.chars += t.name.length + 12
    byKey.set(key, now)
  }
  const known = past.filter(p => p.serversUsed !== undefined)

  return [...byKey.entries()]
    .map(([key, v]) => {
      const prefixes = new Map<string, number>()
      for (const n of v.names) {
        const prefix = /^([A-Za-z]+)_/.exec(n)?.[1]
        if (prefix) prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1)
      }
      const top = [...prefixes.entries()].sort((a, b) => b[1] - a[1])[0]
      const isId = /^[0-9a-f]{8}-/.test(key)
      const label = top && top[1] >= v.names.length / 2 ? top[0] : isId ? `Connector ${key.slice(0, 8)}` : key.replace(/_/g, ' ')

      return {
        key,
        label,
        tools: v.names.length,
        tokens: Math.round(v.chars / 3.2),
        isUsedHere: usedHere.includes(key),
        isUsedInProject: known.length === 0 ? null : known.some(p => p.serversUsed!.includes(key)),
      }
    })
    .sort((a, b) => b.tokens - a.tokens)
}

/** The prompt that hands switching them off to Claude, which asks before changing anything. */
export const switchOffAction = (servers: readonly LoadedServer[]): Action | null =>
  servers.length === 0
    ? null
    : {
        key: 'switch-off-unused',
        label: `Turn off ${servers.length} unused`,
        kind: 'prompt',
        scope: 'session',
        text: `These MCP servers are loaded but were not used in this session${servers.some(s => s.isUsedInProject === false) ? ' or in this project’s recent sessions' : ''}: ${servers.map(s => `${s.label} (${s.tools} tools)`).join(', ')}. Check the list, then offer to turn them off for this session: connectors with the connectors tool, and for desktop extensions or MCP servers in my settings tell me where to switch them off. Say that a connector switched off here also stays off for new sessions until I turn it back on. Change nothing until I confirm.`,
      }
