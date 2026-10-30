/** The four token counts the API reports, plus the share of output spent thinking. */
export type Tokens = {
  input: number
  cacheWrite: number
  cacheWrite1h: number
  cacheRead: number
  output: number
  thinking: number
}

export type StepStatus = 'completed' | 'in_progress' | 'pending'

export type StepReport = {
  title: string
  status: StepStatus
  requests: number
  weighted: number
}

export type ToolUseCount = { name: string; calls: number; resultTokens: number }

export type SubagentReport = {
  label: string
  type: string
  model: string
  requests: number
  weighted: number
}

export type TaskReport = {
  title: string
  startedAt: number
  endedAt: number
  requests: number
  tokens: Tokens
  weighted: number
  /** Prompt size of the task's first request: what it inherited. */
  startContext: number
  /** Shares little wording with the prompts before it. */
  isNewTopic: boolean
  model: string
  tools: ToolUseCount[]
  steps: StepReport[]
  subagents: SubagentReport[]
}

export type ActivityShare = { label: string; weighted: number; requests: number }

/** One main-thread request on the context timeline. */
export type ContextPoint = {
  tokens: number
  task: number
  isCacheRebuild: boolean
  isCompaction: boolean
}

export type Severity = 'high' | 'medium' | 'low'

export type Recommendation = {
  id: string
  severity: Severity
  title: string
  evidence: string[]
  action: string
  /** Estimated avoidable spend, in input-equivalent tokens. */
  saving: number
}

export type ContextSlice = { name: string; tokens: number }

export type Report = {
  generatedAt: number
  title: string
  /** The directory the session ran in. */
  cwd: string
  /** The model behind most of the spend. */
  model: string
  startedAt: number
  endedAt: number
  requests: number
  toolCalls: number
  filesChanged: number
  tokens: Tokens
  /** Input-equivalent tokens: what every count costs, priced as fresh input. */
  weighted: number
  usd: number | null
  context: { tokens: number | null; window: number; percent: number | null }
  /** Tokens an average read, search or fetch result added to context. */
  averageReadTokens: number
  /** MCP servers whose tools were called, by the key in their tool names. */
  serversUsed: string[]
  /** Skills invoked (`plugin:skill` for a plugin's). */
  skillsUsed: string[]
  baseline: number
  baselineSlices: ContextSlice[]
  cacheHitRate: number
  tasks: TaskReport[]
  activities: ActivityShare[]
  timeline: ContextPoint[]
  recommendations: Recommendation[]
  wins: string[]
  score: number
  transcriptBytes: number
}

export type Tab = 'overview' | 'tasks' | 'tips' | 'history'

export type ReviewState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; text: string; tokens: number }
  | { status: 'error'; text: string }

export type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string }

/** What the history list keeps of one past session. */
export type SessionSummary = {
  id: string
  path: string
  project: string
  title: string
  startedAt: number
  endedAt: number
  requests: number
  tasks: number
  weighted: number
  tokens: number
  model: string
  score: number
  issues: { id: string; saving: number }[]
  /** Absent in summaries made before the mod recorded them. */
  serversUsed?: string[]
  skillsUsed?: string[]
  size: number
  mtimeMs: number
}

/** The history file: summaries by transcript path, and dollars per input-equivalent token by model. */
export type HistoryCache = {
  version: 1
  sessions: Record<string, SessionSummary>
  rates: Record<string, number>
  /** The directory each project folder's sessions ran in. */
  cwds?: Record<string, string>
  settings?: Partial<Settings>
}

/** What the mod does on its own, switched from the pane. */
export type Settings = {
  /** A tip above the prompt when a new issue shows up. */
  autoTips: boolean
  /** While background work runs, a tiny request before the cache would expire. */
  keepWarm: boolean
  /** A one-line note to Claude with the next prompt when a new issue shows up. */
  coach: boolean
}

/** A loaded MCP server and whether it earned its place. */
export type LoadedServer = {
  key: string
  label: string
  tools: number
  /** Rough tokens its tool names and descriptions add to every request. */
  tokens: number
  isUsedHere: boolean
  /** Used in any of this project's known past sessions; null when none are known. */
  isUsedInProject: boolean | null
}

export type RecurringIssue = {
  id: string
  label: string
  action: string
  sessions: number
  saving: number
}

export type HistoryInsight = {
  sessions: number
  weighted: number
  usd: number | null
  avoidable: number
  averageScore: number
  averageRequests: number
  recurring: RecurringIssue[]
  habits: string[]
}

export type AdviceId = 'continue' | 'compact' | 'new-session' | 'subagent'

export type AdviceOption = {
  id: AdviceId
  title: string
  when: string
  detail: string
}

export type Advice = {
  verdict: AdviceId
  headline: string
  reasons: string[]
  options: AdviceOption[]
  /** Worth interrupting for, above the prompt. */
  isUrgent: boolean
}
