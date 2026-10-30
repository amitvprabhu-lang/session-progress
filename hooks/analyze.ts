import type {
  ActivityShare,
  ContextPoint,
  ContextSlice,
  Recommendation,
  Report,
  StepStatus,
  SubagentReport,
  TaskReport,
  Tokens,
} from '../types'

/*
 * Reads a Claude Code transcript (JSONL) and works out where the tokens went.
 *
 * Every request is priced in input-equivalent tokens with the API's standard
 * ratios: fresh input 1, cache write 1.25 (5-minute) or 2 (1-hour), cache read
 * 0.1, output 5. That makes requests comparable without knowing the model's
 * price, and the session's real dollar total (when the host keeps one) is
 * shared out in the same proportions.
 */

const W_CACHE_WRITE_5M = 1.25
const W_CACHE_WRITE_1H = 2
const W_CACHE_READ = 0.1
const W_OUTPUT = 5
const CHARS_PER_TOKEN = 4
const CACHE_REBUILD_MIN = 20_000

export const emptyTokens = (): Tokens => ({
  input: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
  thinking: 0,
})

export const weigh = (t: Tokens): number =>
  t.input +
  (t.cacheWrite - t.cacheWrite1h) * W_CACHE_WRITE_5M +
  t.cacheWrite1h * W_CACHE_WRITE_1H +
  t.cacheRead * W_CACHE_READ +
  t.output * W_OUTPUT

const addInto = (into: Tokens, t: Tokens): void => {
  into.input += t.input
  into.cacheWrite += t.cacheWrite
  into.cacheWrite1h += t.cacheWrite1h
  into.cacheRead += t.cacheRead
  into.output += t.output
  into.thinking += t.thinking
}

const promptSize = (t: Tokens): number => t.input + t.cacheWrite + t.cacheRead

type Json = Record<string, any>

type ToolUse = { id: string; name: string; target: string; category: string }

type Request = {
  key: string
  ts: number
  model: string
  tokens: Tokens
  tools: ToolUse[]
  task: number
  step: string | null
  afterCompaction: boolean
}

type ToolResult = {
  tool: string
  target: string
  tokens: number
  /** Index of the first main request that carried it. */
  firstRequest: number
  task: number
}

type PlanItem = { title: string; status: StepStatus }

type TaskAcc = {
  title: string
  startedAt: number
  endedAt: number
  requests: number[]
  plan: PlanItem[]
  stepUse: Map<string, { requests: number; weighted: number }>
  subagents: SubagentReport[]
  subagentTokens: Tokens
  words: Set<string>
}

export type SubagentInput = {
  meta: { agentType?: string; description?: string; toolUseId?: string }
  text: string
}

export type AnalyzeContext = {
  now: number
  usd: number | null
  context: { tokens: number | null; window: number; percent: number | null }
  slices: ContextSlice[]
  transcriptBytes: number
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'ToolSearch'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const PLAN_TOOLS = new Set(['TodoWrite', 'Skill', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'])
const READ_COMMAND =
  /^\s*(cat|head|tail|ls|find|grep|rg|wc|tree|stat|file|less|jq|du|pwd|echo|which|sed -n|git (status|log|diff|show|blame))\b/

/** Variable assignments and a `cd` in front of the real command. */
const LEADING_SETUP = /^(\s*(\w+=("[^"]*"|'[^']*'|\S*)|cd\s+("[^"]*"|\S+))\s*(;|&&)?)+/

export const ACTIVITY = {
  think: 'Thinking & answering',
  read: 'Reading & searching',
  edit: 'Editing files',
  run: 'Running commands',
  web: 'Web & browser',
  agent: 'Subagents',
  mcp: 'Connectors (MCP)',
  plan: 'Planning & app UI',
} as const

const categorize = (name: string, input: Json): string => {
  if (READ_TOOLS.has(name)) return ACTIVITY.read
  if (EDIT_TOOLS.has(name)) return ACTIVITY.edit
  if (WEB_TOOLS.has(name)) return ACTIVITY.web
  if (AGENT_TOOLS.has(name)) return ACTIVITY.agent
  if (PLAN_TOOLS.has(name)) return ACTIVITY.plan
  if (name === 'Bash') {
    const command = String(input.command ?? '').replace(LEADING_SETUP, '')

    return READ_COMMAND.test(command) ? ACTIVITY.read : ACTIVITY.run
  }
  if (/^mcp__(Claude_Browser|claude-in-chrome|playwright|agent-browser|Control_Chrome)/.test(name)) {
    return ACTIVITY.web
  }
  if (/^mcp__ccd_/.test(name)) return ACTIVITY.plan
  if (name.startsWith('mcp__')) return ACTIVITY.mcp

  return ACTIVITY.run
}

const shortName = (name: string): string => {
  if (!name.startsWith('mcp__')) return name
  const parts = name.split('__')

  return parts.at(-1) ?? name
}

const clip = (text: string, length: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat
}

const baseName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

const targetOf = (name: string, input: Json): string => {
  if (typeof input.file_path === 'string') return baseName(input.file_path)
  if (typeof input.notebook_path === 'string') return baseName(input.notebook_path)
  if (typeof input.command === 'string') return clip(input.command, 60)
  if (typeof input.pattern === 'string') return clip(input.pattern, 40)
  if (typeof input.url === 'string') return clip(input.url, 60)
  if (typeof input.query === 'string') return clip(input.query, 50)
  if (typeof input.description === 'string') return clip(input.description, 50)
  if (typeof input.skill === 'string') return input.skill

  return shortName(name)
}

const readPathOf = (use: ToolUse, input: Json): string | null => {
  if (use.name === 'Read' && typeof input.file_path === 'string') return input.file_path
  if (use.name === 'Bash' && typeof input.command === 'string') {
    const cat = /^\s*(cat|head|tail|sed -n \S+)\s+("[^"]+"|'[^']+'|\S+)\s*$/.exec(input.command)
    if (cat?.[2]) return cat[2].replace(/^["']|["']$/g, '')
  }

  return null
}

const tokensOf = (usage: Json | undefined): Tokens => {
  const t = emptyTokens()
  if (!usage) return t
  t.input = Number(usage.input_tokens) || 0
  t.cacheWrite = Number(usage.cache_creation_input_tokens) || 0
  t.cacheWrite1h = Math.min(t.cacheWrite, Number(usage.cache_creation?.ephemeral_1h_input_tokens) || 0)
  t.cacheRead = Number(usage.cache_read_input_tokens) || 0
  t.output = Number(usage.output_tokens) || 0
  t.thinking = Number(usage.output_tokens_details?.thinking_tokens) || 0

  return t
}

/** Rows of one request repeat its usage; streaming may grow it. Keep the largest. */
const maxInto = (into: Tokens, t: Tokens): void => {
  into.input = Math.max(into.input, t.input)
  into.cacheWrite = Math.max(into.cacheWrite, t.cacheWrite)
  into.cacheWrite1h = Math.max(into.cacheWrite1h, t.cacheWrite1h)
  into.cacheRead = Math.max(into.cacheRead, t.cacheRead)
  into.output = Math.max(into.output, t.output)
  into.thinking = Math.max(into.thinking, t.thinking)
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .filter((b: Json) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: Json) => b.text as string)
    .join('\n')
}

const resultChars = (block: Json): number => {
  const c = block.content
  if (typeof c === 'string') return c.length
  if (!Array.isArray(c)) return 0

  return c.reduce((n: number, b: Json) => {
    if (typeof b?.text === 'string') return n + b.text.length
    if (b?.type === 'image') return n + 6000

    return n
  }, 0)
}

/** Commands answered without the model; they never start a task of their own. */
const LOCAL_COMMANDS =
  /^\/(progress|cost|context|usage|status|model|config|effort|help|clear|compact|resume|rewind|plugin|reload-plugins|fast|theme|login|logout|doctor|memory|permissions|hooks|mcp|agents|stats|tasks|ide|vim|terminal-setup|export|release-notes|bug|feedback)\b/i

const promptTitle = (raw: string): string => {
  const command = /<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/.exec(raw)
  if (command?.[1]) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1] ?? ''
    const name = command[1].startsWith('/') ? command[1] : `/${command[1]}`

    return clip(`${name} ${args}`, 90)
  }
  const visible = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<[a-z][\w-]*(?:\s[^>]*)?>[\s\S]*?<\/[a-z][\w-]*>/g, ' ')

  return clip(visible, 90)
}

const STOP_WORDS = new Set(
  'this that with from have should would could about also want make them they there what when which will your into just like know able need some more than then only other sure okay please thing things give show tell does done doing been being were here where while because'.split(
    ' ',
  ),
)

/** A prompt's content words, crudely stemmed, for telling a new topic from a follow-up. */
const wordsOf = (text: string): Set<string> =>
  new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [])
      .filter(w => !STOP_WORDS.has(w))
      .map(w => w.replace(/(ing|ed|es|s)$/, '')),
  )

/** A follow-up shares a good part of its words with what came before; a short one, at least two. */
const isFollowUp = (words: Set<string>, before: Set<string>): boolean => {
  if (words.size === 0) return true
  let shared = 0
  for (const w of words) if (before.has(w)) shared += 1

  return shared / words.size >= 0.25 || shared >= Math.min(3, words.size)
}

const isHumanPrompt = (row: Json, content: unknown): boolean => {
  if (row.isMeta || row.isCompactSummary || row.toolUseResult !== undefined) return false
  if (Array.isArray(content) && content.some((b: Json) => b?.type === 'tool_result')) return false
  if (row.origin && typeof row.origin === 'object') return row.origin.kind === 'human'
  const text = textOf(content).trim()

  return text.length > 0 && !text.startsWith('[Request interrupted') && !text.startsWith('<local-command')
}

const planOf = (items: unknown): PlanItem[] =>
  Array.isArray(items)
    ? items
        .filter((i: Json) => typeof i?.content === 'string')
        .map((i: Json) => ({
          title: clip(i.content, 70),
          status: (['completed', 'in_progress', 'pending'].includes(i.status) ? i.status : 'pending') as StepStatus,
        }))
    : []

const applyPlanTool = (plan: PlanItem[], name: string, input: Json): PlanItem[] => {
  if (name === 'TodoWrite') return planOf(input.todos)
  if (name.endsWith('__wrap_up')) return plan.map(p => ({ ...p, status: 'completed' }))
  if (!name.endsWith('__update_plan')) return plan
  if (Array.isArray(input.items)) return planOf(input.items)
  const next = plan.map(p => ({ ...p }))
  if (input.advance) {
    const at = next.findIndex(p => p.status === 'in_progress')
    if (at >= 0) next[at]!.status = 'completed'
    const pending = next.findIndex((p, i) => i > at && p.status === 'pending')
    if (pending >= 0) next[pending]!.status = 'in_progress'
  }
  for (const n of Array.isArray(input.done) ? input.done : []) {
    const item = next[Number(n) - 1]
    if (item) item.status = 'completed'
  }
  if (typeof input.start === 'number') {
    const item = next[input.start - 1]
    if (item) item.status = 'in_progress'
  }

  return next
}

const splitLines = (text: string): string[] => text.split('\n')

const parseLine = (line: string): Json | null => {
  if (line.length < 2) return null
  try {
    return JSON.parse(line) as Json
  } catch {
    return null
  }
}

/** Only rows whose type matters are parsed; the rest are skipped by a substring test. */
const WANTED = /"type":"(assistant|user|system|custom-title)"/

/** Everything one pass over a transcript has taken in so far. */
type Pass = {
  requests: Request[]
  byKey: Map<string, Request>
  results: ToolResult[]
  pendingUses: Map<string, { use: ToolUse; request: number; input: Json }>
  readPaths: Map<string, number[]>
  toolUseTask: Map<string, { task: number; step: string | null }>
  tasks: TaskAcc[]
  title: string
  cwd: string
  plan: PlanItem[]
  compactedSince: boolean
  compactions: number
  editedFiles: Set<string>
  /** MCP servers whose tools were called, by the key in their tool names. */
  serversUsed: Set<string>
  /** Skills invoked, as the Skill tool names them (`plugin:skill`). */
  skillsUsed: Set<string>
}

const createPass = (): Pass => ({
  requests: [],
  byKey: new Map(),
  results: [],
  pendingUses: new Map(),
  readPaths: new Map(),
  toolUseTask: new Map(),
  tasks: [],
  title: '',
  cwd: '',
  plan: [],
  compactedSince: false,
  compactions: 0,
  editedFiles: new Set(),
  serversUsed: new Set(),
  skillsUsed: new Set(),
})

const newTask = (s: Pass, name: string, ts: number, words = new Set<string>()): void => {
  s.tasks.push({
    words,
    title: name,
    startedAt: ts,
    endedAt: ts,
    requests: [],
    plan: [],
    stepUse: new Map(),
    subagents: [],
    subagentTokens: emptyTokens(),
  })
}

const feedRow = (s: Pass, line: string): void => {
  if (line.startsWith('{"type":"api-') || !WANTED.test(line)) return
  const row = parseLine(line)
  if (!row || row.isSidechain) return
  const ts = Date.parse(row.timestamp ?? '') || 0
  if (!s.cwd && typeof row.cwd === 'string') s.cwd = row.cwd

  if (row.type === 'custom-title' && typeof row.customTitle === 'string') {
    s.title = row.customTitle

    return
  }
  if (row.type === 'system' && row.subtype === 'compact_boundary') {
    s.compactedSince = true
    s.compactions += 1

    return
  }

  if (row.type === 'user') {
    const content = row.message?.content
    if (isHumanPrompt(row, content)) {
      const raw = textOf(content)
      const name = promptTitle(raw)
      if (!LOCAL_COMMANDS.test(name) && name.length > 0) {
        newTask(s, name, ts, wordsOf(raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')))
        s.plan = []
      }

      return
    }
    if (Array.isArray(content)) {
      for (const block of content as Json[]) {
        if (block?.type !== 'tool_result') continue
        const pending = s.pendingUses.get(String(block.tool_use_id))
        if (!pending) continue
        s.pendingUses.delete(String(block.tool_use_id))
        const tokens = Math.round(resultChars(block) / CHARS_PER_TOKEN)
        s.results.push({
          tool: pending.use.name,
          target: pending.use.target,
          tokens,
          firstRequest: s.requests.length,
          task: Math.max(0, s.tasks.length - 1),
        })
        const path = readPathOf(pending.use, pending.input)
        if (path) s.readPaths.set(path, [...(s.readPaths.get(path) ?? []), s.results.length - 1])
      }
    }

    return
  }

  if (row.type !== 'assistant') return
  const message = row.message ?? {}
  if (message.model === '<synthetic>') return
  if (s.tasks.length === 0) newTask(s, 'Session start', ts)
  const taskIndex = s.tasks.length - 1
  const task = s.tasks[taskIndex]!
  const key = String(row.requestId ?? message.id ?? row.uuid)
  let request = s.byKey.get(key)
  if (!request) {
    request = {
      key,
      ts,
      model: String(message.model ?? ''),
      tokens: emptyTokens(),
      tools: [],
      task: taskIndex,
      step: null,
      afterCompaction: s.compactedSince,
    }
    s.compactedSince = false
    s.byKey.set(key, request)
    s.requests.push(request)
    task.requests.push(s.requests.length - 1)
  }
  maxInto(request.tokens, tokensOf(message.usage))
  task.endedAt = Math.max(task.endedAt, ts)

  for (const block of Array.isArray(message.content) ? (message.content as Json[]) : []) {
    if (block?.type !== 'tool_use') continue
    const name = String(block.name ?? '')
    const input = (block.input ?? {}) as Json
    const use: ToolUse = { id: String(block.id), name, target: targetOf(name, input), category: categorize(name, input) }
    request.tools.push(use)
    s.pendingUses.set(use.id, { use, request: s.requests.length - 1, input })
    if (EDIT_TOOLS.has(name) && typeof input.file_path === 'string') s.editedFiles.add(input.file_path)
    if (name.startsWith('mcp__')) s.serversUsed.add(name.split('__')[1] ?? '')
    if (name === 'Skill' && typeof input.skill === 'string') s.skillsUsed.add(input.skill)
    const before = s.plan
    s.plan = applyPlanTool(s.plan, name, input)
    if (s.plan !== before) task.plan = s.plan
  }
  const active = s.plan.find(p => p.status === 'in_progress')
  request.step = active?.title ?? request.step
  for (const use of request.tools) s.toolUseTask.set(use.id, { task: taskIndex, step: request.step })
}

/**
 * Takes a transcript in pieces, so a long one is never held whole: complete
 * lines are read as they arrive and a partial last line waits for the rest.
 * `report` can be asked any number of times; `feed` more and ask again.
 */
export type TranscriptReader = {
  feed: (text: string) => void
  report: (subagents: SubagentInput[], ctx: AnalyzeContext) => Report
}

export const createReader = (): TranscriptReader => {
  const pass = createPass()
  let carry = ''

  return {
    feed: text => {
      const lines = (carry + text).split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) feedRow(pass, line)
    },
    report: (subagents, ctx) => {
      // A last line with no newline yet is read once it parses whole.
      if (carry && parseLine(carry)) {
        feedRow(pass, carry)
        carry = ''
      }

      return reportOf(pass, subagents, ctx)
    },
  }
}

export const analyze = (main: string, subagents: SubagentInput[], ctx: AnalyzeContext): Report => {
  const reader = createReader()
  reader.feed(main)

  return reader.report(subagents, ctx)
}

const reportOf = (pass: Pass, subagents: SubagentInput[], ctx: AnalyzeContext): Report => {
  const { requests, results, readPaths, toolUseTask, tasks, title, cwd, compactions, editedFiles, serversUsed, skillsUsed } = pass
  // What follows derives from the pass without changing it, so it can run again after more is fed.
  for (const task of tasks) {
    task.stepUse = new Map()
    task.subagents = []
    task.subagentTokens = emptyTokens()
  }

  // Per-request weights, tasks, steps and activities.
  const totals = emptyTokens()
  const activity = new Map<string, { weighted: number; requests: number }>()
  const addActivity = (label: string, weighted: number, count: number): void => {
    const now = activity.get(label) ?? { weighted: 0, requests: 0 }
    now.weighted += weighted
    now.requests += count
    activity.set(label, now)
  }
  for (const request of requests) {
    addInto(totals, request.tokens)
    const weighted = weigh(request.tokens)
    const categories = [...new Set(request.tools.map(t => t.category))]
    if (categories.length === 0) addActivity(ACTIVITY.think, weighted, 1)
    for (const c of categories) addActivity(c, weighted / categories.length, 1)
    const task = tasks[request.task]
    if (task && request.step) {
      const use = task.stepUse.get(request.step) ?? { requests: 0, weighted: 0 }
      use.requests += 1
      use.weighted += weighted
      task.stepUse.set(request.step, use)
    }
  }

  // Subagents: their own transcripts, charged to the task and step that spawned them.
  const subagentTotal = emptyTokens()
  const subagentModels = new Set<string>()
  for (const sub of subagents) {
    const seen = new Map<string, Tokens>()
    let model = ''
    const subUses: string[] = []
    for (const line of splitLines(sub.text)) {
      if (!line.includes('"type":"assistant"')) continue
      const row = parseLine(line)
      const message = row?.message
      if (!message || message.model === '<synthetic>') continue
      model = String(message.model ?? model)
      const key = String(row!.requestId ?? message.id ?? row!.uuid)
      const t = seen.get(key) ?? emptyTokens()
      maxInto(t, tokensOf(message.usage))
      seen.set(key, t)
      for (const block of Array.isArray(message.content) ? (message.content as Json[]) : []) {
        if (block?.type === 'tool_use') subUses.push(String(block.id))
      }
    }
    const tokens = emptyTokens()
    for (const t of seen.values()) addInto(tokens, t)
    const weighted = weigh(tokens)
    addInto(subagentTotal, tokens)
    if (model) subagentModels.add(model)
    const owner = toolUseTask.get(String(sub.meta.toolUseId)) ?? { task: Math.max(0, tasks.length - 1), step: null }
    for (const id of subUses) toolUseTask.set(id, owner)
    const task = tasks[owner.task]
    if (task) {
      task.subagents.push({
        label: clip(sub.meta.description ?? sub.meta.agentType ?? 'Subagent', 60),
        type: sub.meta.agentType ?? 'agent',
        model,
        requests: seen.size,
        weighted,
      })
      addInto(task.subagentTokens, tokens)
      if (owner.step) {
        const use = task.stepUse.get(owner.step) ?? { requests: 0, weighted: 0 }
        use.weighted += weighted
        task.stepUse.set(owner.step, use)
      }
    }
    addActivity(ACTIVITY.agent, weighted, seen.size)
  }
  addInto(totals, subagentTotal)
  const totalWeighted = Math.max(1, weigh(totals))

  // Timeline of the main thread's prompt size.
  const timeline: ContextPoint[] = requests.map((r, i) => ({
    tokens: promptSize(r.tokens),
    task: r.task,
    isCompaction: r.afterCompaction,
    isCacheRebuild: i > 0 && !r.afterCompaction && r.tokens.cacheWrite >= CACHE_REBUILD_MIN,
  }))

  const seen = new Set<string>()
  const taskReports: TaskReport[] = tasks.map((task, index) => {
    const isNewTopic = index > 0 && !isFollowUp(task.words, seen)
    for (const w of task.words) seen.add(w)
    const tokens = emptyTokens()
    const tools = new Map<string, { calls: number; resultTokens: number }>()
    let model = ''
    for (const i of task.requests) {
      const r = requests[i]!
      addInto(tokens, r.tokens)
      model = r.model || model
      for (const use of r.tools) {
        const name = shortName(use.name)
        const t = tools.get(name) ?? { calls: 0, resultTokens: 0 }
        t.calls += 1
        tools.set(name, t)
      }
    }
    for (const r of results) {
      if (tasks[r.task] !== task) continue
      const t = tools.get(shortName(r.tool))
      if (t) t.resultTokens += r.tokens
    }
    addInto(tokens, task.subagentTokens)
    const first = task.requests[0]
    const steps = task.plan.map(p => ({
      title: p.title,
      status: p.status,
      requests: task.stepUse.get(p.title)?.requests ?? 0,
      weighted: task.stepUse.get(p.title)?.weighted ?? 0,
    }))

    return {
      title: task.title,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      requests: task.requests.length,
      tokens,
      weighted: weigh(tokens),
      startContext: first === undefined ? 0 : promptSize(requests[first]!.tokens),
      isNewTopic,
      model,
      tools: [...tools.entries()]
        .map(([name, t]) => ({ name, ...t }))
        .sort((a, b) => b.calls - a.calls),
      steps,
      subagents: task.subagents,
    }
  })

  const activities: ActivityShare[] = [...activity.entries()]
    .map(([label, a]) => ({ label, ...a }))
    .filter(a => a.weighted > 0)
    .sort((a, b) => b.weighted - a.weighted)

  const byModel = new Map<string, number>()
  for (const r of requests) byModel.set(r.model, (byModel.get(r.model) ?? 0) + weigh(r.tokens))
  const model = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''

  const baseline = requests[0] ? promptSize(requests[0].tokens) : 0
  const promptTotal = totals.input + totals.cacheRead + totals.cacheWrite
  const cacheHitRate = promptTotal > 0 ? totals.cacheRead / promptTotal : 0

  // A past session has no live reading: its last request stands for its context.
  const last = timeline.at(-1)
  const context =
    ctx.context.tokens === null && last && ctx.context.window > 0
      ? { tokens: last.tokens, window: ctx.context.window, percent: (last.tokens / ctx.context.window) * 100 }
      : ctx.context
  const reads = results.filter(r => READ_TOOLS.has(r.tool) || r.tool === 'Bash' || WEB_TOOLS.has(r.tool))
  const averageReadTokens = reads.length > 0 ? reads.reduce((n, r) => n + r.tokens, 0) / reads.length : 0

  const recommendations = recommend({
    requests,
    results,
    readPaths,
    tasks: taskReports,
    timeline,
    baseline,
    slices: ctx.slices,
    context,
    totals,
    subagentTotal,
    subagentModels,
    compactions,
    totalWeighted,
    activities,
  })
  const wins = winsOf({ requests, results, cacheHitRate, subagentCount: subagents.length, editedFiles: editedFiles.size })
  const saving = recommendations.reduce((n, r) => n + r.saving, 0)
  const score = Math.max(0, Math.min(100, Math.round(100 - (saving / totalWeighted) * 100)))

  return {
    generatedAt: ctx.now,
    title,
    cwd,
    model,
    startedAt: tasks[0]?.startedAt ?? requests[0]?.ts ?? ctx.now,
    endedAt: requests.at(-1)?.ts ?? ctx.now,
    requests: requests.length + [...taskReports].reduce((n, t) => n + t.subagents.reduce((m, s) => m + s.requests, 0), 0),
    toolCalls: requests.reduce((n, r) => n + r.tools.length, 0),
    filesChanged: editedFiles.size,
    tokens: totals,
    weighted: totalWeighted,
    usd: ctx.usd,
    context,
    averageReadTokens,
    serversUsed: [...serversUsed].filter(Boolean),
    skillsUsed: [...skillsUsed],
    baseline,
    baselineSlices: ctx.slices,
    cacheHitRate,
    tasks: taskReports,
    activities,
    timeline,
    recommendations,
    wins,
    score,
    transcriptBytes: ctx.transcriptBytes,
  }
}

type Facts = {
  requests: Request[]
  results: ToolResult[]
  readPaths: Map<string, number[]>
  tasks: TaskReport[]
  timeline: ContextPoint[]
  baseline: number
  slices: ContextSlice[]
  context: AnalyzeContext['context']
  totals: Tokens
  subagentTotal: Tokens
  subagentModels: Set<string>
  compactions: number
  totalWeighted: number
  activities: ActivityShare[]
}

/** Each recommendation by what it is, for counting it across sessions. */
export const ISSUES: Record<string, { label: string; action: string }> = {
  'big-results': {
    label: 'Oversized tool outputs',
    action: 'Grep before reading, read ranges with offset/limit, and pipe long command output through head or grep.',
  },
  rereads: { label: 'Files read more than once', action: 'Refer back to the earlier read, or read only the changed range.' },
  parallel: { label: 'Look-ups made one at a time', action: 'Ask for related reads and checks together so they run in one step.' },
  cache: {
    label: 'Prompt cache rebuilt mid-session',
    action: 'Keep one model per session, avoid toggling connectors mid-task, and do not leave long sessions idle past the cache window.',
  },
  baseline: {
    label: 'Large starting overhead',
    action: 'Turn off connectors and plugins you do not need for the work, and keep CLAUDE.md and memory files short.',
  },
  carryover: { label: 'Unrelated tasks in one session', action: 'Start a new session (or /clear) when the topic changes.' },
  'context-full': { label: 'Context filled up', action: 'Run /compact with what to keep, or finish the task and start fresh.' },
  effort: { label: 'Heavy thinking on routine steps', action: 'Use a lower effort for mechanical work.' },
  'subagent-model': { label: 'Subagents on the largest model', action: 'Give exploration subagents a smaller model.' },
  'small-tasks': { label: 'Quick questions on the largest model', action: 'Use a smaller, faster model for quick lookups.' },
  'long-history': {
    label: 'Long history carried on every request',
    action: 'Compact after each finished feature or plan step, or continue in a new session with a short brief.',
  },
  browser: {
    label: 'Heavy browser automation',
    action: 'Prefer page text and element search over screenshots, and batch browser actions.',
  },
}

export const fmtTokens = (n: number): string => {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`

  return `${(n / 1_000_000).toFixed(2)}M`
}

/** How many later main requests re-sent a tool result, until a compaction dropped it. */
const carriedFor = (facts: Facts, result: ToolResult): number => {
  let n = 0
  for (let i = result.firstRequest; i < facts.requests.length; i++) {
    if (i > result.firstRequest && facts.requests[i]!.afterCompaction) break
    n += 1
  }

  return n
}

const carriedCost = (tokens: number, carried: number): number =>
  carried === 0 ? 0 : tokens * W_CACHE_WRITE_5M + tokens * W_CACHE_READ * Math.max(0, carried - 1)

const severityOf = (saving: number, total: number): Recommendation['severity'] => {
  const share = saving / total
  if (share >= 0.08) return 'high'
  if (share >= 0.025) return 'medium'

  return 'low'
}

const ADVICE_BY_TOOL: Record<string, string> = {
  Read: 'Grep for the part you need first, then Read with offset/limit instead of whole files.',
  Bash: 'Pipe long output through head, tail or grep, or write it to a file and read only the part that matters.',
  WebFetch: 'Ask WebFetch a specific question so it returns an extract, not the page.',
  Agent: 'Ask subagents to return a short summary (conclusions, paths, line numbers), not file dumps.',
}

const recommend = (facts: Facts): Recommendation[] => {
  const out: Recommendation[] = []
  const total = facts.totalWeighted
  const push = (r: Omit<Recommendation, 'severity'>): void => {
    if (r.saving <= total * 0.004) return
    out.push({ ...r, severity: severityOf(r.saving, total) })
  }

  // 1. Big tool results that stayed in context for many requests.
  const heavy = facts.results
    .map(r => ({ r, carried: carriedFor(facts, r) }))
    .map(x => ({ ...x, cost: carriedCost(x.r.tokens, x.carried) }))
    .filter(x => x.r.tokens >= 5000)
    .sort((a, b) => b.cost - a.cost)
  if (heavy.length > 0) {
    const tools = [...new Set(heavy.map(x => x.r.tool))]
    push({
      id: 'big-results',
      title: `Trim ${heavy.length} oversized tool output${heavy.length > 1 ? 's' : ''}`,
      evidence: heavy
        .slice(0, 3)
        .map(
          x =>
            `${shortName(x.r.tool)} ${x.r.target}: ~${fmtTokens(x.r.tokens)} tokens, re-sent in ${x.carried} later request${x.carried === 1 ? '' : 's'}`,
        ),
      action: tools
        .map(t => ADVICE_BY_TOOL[t] ?? ADVICE_BY_TOOL[t.startsWith('mcp__') ? 'WebFetch' : 'Bash'])
        .filter((a, i, all) => a && all.indexOf(a) === i)
        .join(' '),
      saving: heavy.reduce((n, x) => n + x.cost, 0) * 0.6,
    })
  }

  // 2. The same file read more than once.
  const rereads = [...facts.readPaths.entries()].filter(([, idx]) => idx.length > 1)
  if (rereads.length > 0) {
    const saving = rereads.reduce(
      (n, [, idx]) =>
        n +
        idx.slice(1).reduce((m, i) => {
          const r = facts.results[i]!

          return m + carriedCost(r.tokens, carriedFor(facts, r))
        }, 0),
      0,
    )
    push({
      id: 'rereads',
      title: `Avoid re-reading ${rereads.length} file${rereads.length > 1 ? 's' : ''}`,
      evidence: rereads
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 3)
        .map(([path, idx]) => `${baseName(path)} was read ${idx.length} times`),
      action: 'The first read is still in context: refer back to it, or read only the changed range after an edit.',
      saving: saving * 0.9,
    })
  }

  // 3. Look-ups made one request at a time.
  const isLookup = (r: Request): boolean => r.tools.length === 1 && r.tools[0]!.category === ACTIVITY.read
  let chains = 0
  let chained = 0
  let longest = 0
  let chainCost = 0
  for (let i = 0; i < facts.requests.length; ) {
    let j = i
    while (j < facts.requests.length && isLookup(facts.requests[j]!) && facts.requests[j]!.task === facts.requests[i]!.task) j++
    const length = j - i
    if (length >= 2) {
      chains += 1
      chained += length
      longest = Math.max(longest, length)
      const run = facts.requests.slice(i, j)
      const avg = run.reduce((n, r) => n + weigh(r.tokens), 0) / length
      chainCost += Math.floor((length - 1) / 2) * avg
    }
    i = Math.max(j, i + 1)
  }
  if (chains > 0) {
    push({
      id: 'parallel',
      title: 'Batch independent look-ups into one step',
      evidence: [
        `${chained} read/search calls ran one per request, in ${chains} chain${chains > 1 ? 's' : ''} (longest ${longest} in a row)`,
        'Each request re-sends the whole conversation, so every extra round trip pays for it again',
      ],
      action:
        'Ask for related reads, greps and status checks together ("check X, Y and Z") so they go out in parallel in one request.',
      saving: chainCost,
    })
  }

  // 4. Prompt cache rebuilt mid-session.
  const rebuilds = facts.requests
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => i > 0 && !r.afterCompaction && r.tokens.cacheWrite >= CACHE_REBUILD_MIN)
  if (rebuilds.length > 0) {
    const causes = rebuilds.map(({ r, i }) => {
      const prev = facts.requests[i - 1]!
      const gap = (r.ts - prev.ts) / 60_000
      if (prev.model && r.model && prev.model !== r.model) return 'model switch'
      if (gap >= 60) return 'idle over an hour'
      if (gap >= 5 && r.tokens.cacheWrite1h === 0) return 'idle over 5 minutes'

      return 'earlier context changed'
    })
    const counts = new Map<string, number>()
    for (const c of causes) counts.set(c, (counts.get(c) ?? 0) + 1)
    push({
      id: 'cache',
      title: `Prompt cache was rebuilt ${rebuilds.length} time${rebuilds.length > 1 ? 's' : ''}`,
      evidence: [
        ...[...counts.entries()].map(([cause, n]) => `${n}× ${cause}`),
        `${fmtTokens(rebuilds.reduce((n, x) => n + x.r.tokens.cacheWrite, 0))} tokens written to cache again at full price`,
      ],
      action:
        'Keep one model per session, avoid toggling connectors or plugins mid-task, and resume within the cache window instead of leaving a session idle for long.',
      saving: rebuilds.reduce((n, { r }) => n + r.tokens.cacheWrite * (W_CACHE_WRITE_5M - W_CACHE_READ), 0),
    })
  }

  // 5. The fixed overhead every request carries.
  if (facts.baseline >= 30_000 && facts.requests.length > 3) {
    const slices = facts.slices.filter(s => !/messages|free|buffer|autocompact/i.test(s.name)).slice(0, 4)
    const trimmable = facts.slices
      .filter(s => /mcp|skill|agent|memory|plugin/i.test(s.name))
      .reduce((n, s) => n + s.tokens, 0)
    const share = trimmable > 0 ? trimmable : facts.baseline * 0.25
    push({
      id: 'baseline',
      title: `Shrink the ~${fmtTokens(facts.baseline)}-token starting overhead`,
      evidence: [
        `Every one of ${facts.requests.length} requests starts with ~${fmtTokens(facts.baseline)} tokens of system prompt, tools and instructions`,
        ...slices.map(s => `${s.name}: ${fmtTokens(s.tokens)}`),
      ],
      action:
        'Turn off connectors (MCP servers) and plugins you do not need for this kind of work, and keep CLAUDE.md and memory files short.',
      saving: share * facts.requests.length * W_CACHE_READ + share * W_CACHE_WRITE_5M,
    })
  }

  // 6. Later tasks paying for earlier, unrelated ones.
  if (facts.tasks.length > 1) {
    const inherited = facts.tasks
      .slice(1)
      .filter(t => t.isNewTopic)
      .map(t => ({ t, extra: Math.max(0, t.startContext - facts.baseline) }))
    const worst = [...inherited].sort((a, b) => b.extra - a.extra)[0]
    const saving = inherited.reduce((n, x) => n + x.extra * x.t.requests * W_CACHE_READ, 0)
    if (worst && worst.extra >= 25_000) {
      push({
        id: 'carryover',
        title: 'Start unrelated tasks in a fresh session (or /clear)',
        evidence: [
          `"${clip(worst.t.title, 50)}" looks like a new topic, yet began with ${fmtTokens(worst.extra)} tokens of earlier work in context`,
          `That history was re-sent on each of its ${worst.t.requests} requests`,
        ],
        action:
          'When the topic changes, /clear or open a new session; when it continues, /compact with a note of what to keep.',
        saving: saving * 0.7,
      })
    }
  }

  // 7. History riding along on every request of a long session.
  const grace = 30_000
  const carried = facts.requests.map(r => Math.max(0, promptSize(r.tokens) - facts.baseline - grace))
  const averageCarried = carried.reduce((n, c) => n + c, 0) / Math.max(1, carried.length)
  if (facts.requests.length >= 50 && averageCarried >= 80_000) {
    const heavy = facts.requests.filter(r => promptSize(r.tokens) >= 300_000).length
    push({
      id: 'long-history',
      title: 'Compact at milestones: history rides along on every request',
      evidence: [
        `The average request carried ~${fmtTokens(averageCarried)} tokens of earlier conversation (peak ${fmtTokens(Math.max(...carried) + facts.baseline + grace)} in context)`,
        ...(heavy > 0 ? [`${heavy} of ${facts.requests.length} requests ran with over 300k tokens in context`] : []),
        `${facts.compactions === 0 ? 'The session was never compacted' : `Compacted ${facts.compactions} time${facts.compactions === 1 ? '' : 's'}`}`,
      ],
      action:
        'After each finished feature or plan step, /compact with a note of what to keep, or continue in a new session with a short brief.',
      saving: carried.reduce((n, c) => n + c, 0) * W_CACHE_READ * 0.5,
    })
  }

  // 8. Browser automation.
  const browser = facts.activities.find(a => a.label === ACTIVITY.web)
  if (browser && browser.weighted / total >= 0.15 && browser.requests >= 20) {
    push({
      id: 'browser',
      title: 'Lighten browser automation',
      evidence: [
        `Web and browser steps took ${Math.round((browser.weighted / total) * 100)}% of the spend over ${browser.requests} requests`,
        'Screenshots and full-page reads are large, and each stays in context for every later request',
      ],
      action:
        'Prefer page text, accessibility reads and element search over screenshots; screenshot at reduced scale only when layout matters; batch clicks and typing into one step.',
      saving: browser.weighted * 0.3,
    })
  }

  // 9. Context nearly full.
  const percent = facts.context.percent ?? 0
  if (percent >= 60) {
    push({
      id: 'context-full',
      title: `Context is ${Math.round(percent)}% full`,
      evidence: [`${fmtTokens(facts.context.tokens ?? 0)} of ${fmtTokens(facts.context.window)} tokens in use now`],
      action: 'Run /compact with what to keep before the next big step, or finish this task and start fresh.',
      saving: (facts.context.tokens ?? 0) * 0.5 * W_CACHE_READ * 10,
    })
  }

  // 10. Heavy thinking.
  const thinking = facts.totals.thinking
  if (facts.totals.output >= 15_000 && thinking / Math.max(1, facts.totals.output) >= 0.5) {
    push({
      id: 'effort',
      title: 'Lower the effort level for routine steps',
      evidence: [
        `${Math.round((thinking / facts.totals.output) * 100)}% of output tokens (${fmtTokens(thinking)}) were thinking`,
        'Output is the most expensive token type (5× fresh input)',
      ],
      action: 'Use a lower effort for mechanical edits, renames and lookups; keep high effort for design and debugging.',
      saving: thinking * 0.3 * W_OUTPUT,
    })
  }

  // 11. Expensive subagents.
  const subWeighted = weigh(facts.subagentTotal)
  if (subWeighted / facts.totalWeighted >= 0.25 && [...facts.subagentModels].some(m => /opus/i.test(m))) {
    push({
      id: 'subagent-model',
      title: 'Run exploration subagents on a smaller model',
      evidence: [`Subagents used ${Math.round((subWeighted / facts.totalWeighted) * 100)}% of the session's spend on ${[...facts.subagentModels].join(', ')}`],
      action: 'Give read-only explorers model "sonnet" or "haiku"; keep the big model for the main thread.',
      saving: subWeighted * 0.4,
    })
  }

  // 12. Small tasks on the largest model.
  const small = facts.tasks.filter(t => /opus/i.test(t.model) && t.requests > 0 && t.requests <= 3 && t.tokens.output < 3000)
  if (small.length >= 2) {
    push({
      id: 'small-tasks',
      title: `${small.length} quick questions ran on the largest model`,
      evidence: small.slice(0, 3).map(t => `"${clip(t.title, 50)}": ${t.requests} request${t.requests > 1 ? 's' : ''}`),
      action: 'Quick lookups and Q&A run fine on a smaller, faster model; switch for them, or ask them in a separate session.',
      saving: small.reduce((n, t) => n + t.weighted, 0) * 0.4,
    })
  }

  return out.sort((a, b) => b.saving - a.saving)
}

const winsOf = (facts: {
  requests: Request[]
  results: ToolResult[]
  cacheHitRate: number
  subagentCount: number
  editedFiles: number
}): string[] => {
  const wins: string[] = []
  if (facts.cacheHitRate >= 0.8) {
    wins.push(`Prompt cache served ${Math.round(facts.cacheHitRate * 100)}% of input tokens at a tenth of the price`)
  }
  const parallel = facts.requests.filter(r => r.tools.length >= 2).length
  if (parallel > 0) wins.push(`${parallel} request${parallel > 1 ? 's' : ''} ran several tool calls in parallel`)
  if (facts.results.length > 3 && facts.results.every(r => r.tokens < 5000)) {
    wins.push('Every tool output stayed under ~5k tokens')
  }
  if (facts.subagentCount > 0) {
    wins.push(`${facts.subagentCount} subagent${facts.subagentCount > 1 ? 's' : ''} kept exploration out of the main context`)
  }

  return wins
}
