import { expect, mock, test } from 'claude-code/testing'

import { actionsFor, advise, insight, loadedServers, ruleAction, summarize } from './advise'
import { analyze } from './analyze'
import { heavyApps, isSafeToTrash, owningCli, parseElapsed, parseMemory, parsePs, sessionProcs } from './storage'

const PROJECTS = '/Users/u/.claude/projects'
const LOG_PATH = `${PROJECTS}/-work/s1.jsonl`
const OLD_PATH = `${PROJECTS}/-work/old.jsonl`

const row = (o: object): string => JSON.stringify(o)
const at = (minute: number): string => new Date(Date.UTC(2026, 9, 30, 9, minute)).toISOString()
const usage = (input: number, write: number, read: number, output: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  output_tokens: output,
  cache_creation: { ephemeral_1h_input_tokens: write },
})
const assistant = (id: string, minute: number, u: object, content: object[]) =>
  row({ type: 'assistant', requestId: id, timestamp: at(minute), cwd: '/work', message: { model: 'claude-opus-5-5', usage: u, content } })
const result = (id: string, minute: number, chars: number) =>
  row({ type: 'user', timestamp: at(minute), toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(chars) }] } })

const logOf = (title: string, prompt: string): string =>
  [
    row({ type: 'custom-title', customTitle: title }),
    row({ type: 'user', timestamp: at(0), origin: { kind: 'human' }, message: { role: 'user', content: prompt } }),
    assistant('r1', 1, usage(10, 40_000, 0, 300), [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/work/src/auth.ts' } }]),
    result('t1', 1, 40_000),
    assistant('r2', 2, usage(10, 10_000, 40_000, 200), [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/work/src/auth.ts' } }]),
    result('t2', 2, 40_000),
    assistant('r3', 3, usage(10, 10_000, 50_000, 400), [{ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/work/src/auth.ts' } }]),
    result('t3', 3, 100),
    assistant('r4', 4, usage(10, 500, 60_000, 900), [{ type: 'text', text: 'Fixed.' }]),
  ].join('\n')

const LOG = logOf('Login bug', 'Fix the login bug')
const OLD = logOf('Old signup work', 'Build the signup form')

const CONTEXT = {
  now: 0,
  usd: 2,
  context: { tokens: 60_000, window: 200_000, percent: 30 },
  slices: [],
  transcriptBytes: LOG.length,
}

test('the log is split into requests, tasks and recommendations', () => {
  const report = analyze(LOG, [], CONTEXT)

  expect(report.title).toBe('Login bug')
  expect(report.cwd).toBe('/work')
  expect(report.model).toBe('claude-opus-5-5')
  expect(report.requests).toBe(4)
  expect(report.tasks[0]!.title).toBe('Fix the login bug')
  expect(report.recommendations.map(r => r.id)).toEqual(expect.arrayContaining(['big-results', 'rereads']))
  expect(actionsFor('rereads').map(a => a.scope)).toEqual(['session', 'future'])
})

test('a prompt on a new topic is told apart from a follow-up', () => {
  const prompt = (minute: number, text: string) =>
    row({ type: 'user', timestamp: at(minute), origin: { kind: 'human' }, message: { role: 'user', content: text } })
  const reply = (id: string, minute: number) => assistant(id, minute, usage(10, 1000, 1000, 100), [{ type: 'text', text: 'ok' }])
  const report = analyze(
    [
      prompt(0, 'Fix the login bug in the auth module'),
      reply('a', 1),
      prompt(2, 'Also fix the login bug on mobile'),
      reply('b', 3),
      prompt(4, 'Write a haiku about autumn leaves falling'),
      reply('c', 5),
    ].join('\n'),
    [],
    CONTEXT,
  )

  expect(report.tasks.map(t => t.isNewTopic)).toEqual([false, false, true])
})

const ADVICE = {
  now: 0,
  lastActivity: 0,
  isTurnRunning: false,
  contextTokens: 30_000,
  window: 200_000,
  baseline: 25_000,
  cacheTtlMs: 3_600_000,
  isPlanDone: null,
  averageReadTokens: 2_000,
  usdPerWeighted: null,
  background: [] as string[],
}

test('the advisor weighs the cache window and the context fill', () => {
  expect(advise({ ...ADVICE, now: 60_000, lastActivity: 1 }).verdict).toBe('continue')

  const cold = advise({ ...ADVICE, now: 3 * 3_600_000, lastActivity: 1, contextTokens: 150_000, baseline: 100_000, window: 1_000_000 })
  expect(cold.verdict).toBe('new-session')
  expect(cold.isUrgent).toBe(true)

  const full = advise({ ...ADVICE, now: 60_000, lastActivity: 1, contextTokens: 160_000, isPlanDone: false })
  expect(full.verdict).toBe('compact')
  expect(full.isUrgent).toBe(true)
})

test('history counts the same issue across sessions', () => {
  const file = { folder: '-work', size: 1, mtimeMs: 1 }
  const a = summarize(analyze(LOG, [], CONTEXT), { ...file, id: 'a', path: '/a.jsonl' })
  const b = summarize(analyze(OLD, [], CONTEXT), { ...file, id: 'b', path: '/b.jsonl' })
  const h = insight([a, b], { 'claude-opus-5-5': 0.00001 })

  expect(a.project).toBe('work')
  expect(h.sessions).toBe(2)
  expect(h.usd).toBeGreaterThan(0)
  expect(h.recurring.find(x => x.id === 'rereads')?.sessions).toBe(2)
})

const PANE = {
  plugin: 'session-progress',
  component: 'Pane',
  requestId: 'session-progress',
  props: {
    title: 'Session progress',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

test('/progress draws the session, hands a fix to Claude, and opens a past session', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 30, 9, 6) })
  const sent: string[] = []
  mock.env(on, { HOME: '/Users/u' })
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 60_000, window: 200_000, percent: 30 }, rateLimits: [], cost: { usd: 2 } },
  }))
  on('fs.exists', (_, e) => ({ value: e.path === LOG_PATH }))
  on('fs.list', (_, e) => ({
    value:
      e.path === PROJECTS
        ? [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
        : e.path === `${PROJECTS}/-work`
          ? [
              { name: 's1.jsonl', kind: 'file', size: LOG.length, mtimeMs: 2, isLink: false },
              { name: 'old.jsonl', kind: 'file', size: OLD.length, mtimeMs: 1, isLink: false },
            ]
          : [],
  }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: e.path === OLD_PATH ? OLD.length : LOG.length, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_, e) => ({ value: e.path === LOG_PATH ? LOG : e.path === OLD_PATH ? OLD : '' }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)

    return { text: e.text }
  })

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'progress', args: '' } as never)
  await clock.advance(5_000)

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: /Efficiency \d+\/100/ })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: /WHAT NEXT/ })).toBeDefined()
  await terminal.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Keep going here/ })).toBeDefined()

  await ui.press({ key: 'tab-tips' })
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: /Avoid re-reading 1 file/ })).toBeDefined()
  await ui.press({ key: 'rec-rereads-do-rereads' })
  await clock.advance(100)
  expect(sent.at(-1)).toMatch(/do not re-read files/)
  await ui.press({ key: 'rec-rereads-rule-rereads' })
  await clock.advance(100)
  expect(sent.at(-1)).toMatch(/~\/\.claude\/CLAUDE\.md/)

  await ui.press({ key: 'tab-history' })
  await clock.advance(5_000)
  expect(await ui.find({ type: 'Text', text: /WHAT KEEPS COSTING YOU/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Files read more than once/ })).toBeDefined()

  await ui.press({ key: 'hist-0-old' })
  await clock.advance(5_000)
  expect(await ui.find({ type: 'Text', text: /Past session · work/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /WHAT NEXT/ })).toBeUndefined()
  await ui.unmount()
})

const PS = [
  '  100   1  400000 02-18:01:20 298:02.19 /Applications/Claude.app/Contents/MacOS/Claude',
  '  200 100   10000    56:23   2:27.56 /Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- /Users/u/Library/Application Support/Claude/claude-code/2.1.308/x/claude.app/Contents/MacOS/claude --resume=11111111-1111-1111-1111-111111111111',
  '  201 200  290000    56:23   2:27.56 /Users/u/Library/Application Support/Claude/claude-code/2.1.308/x/claude.app/Contents/MacOS/claude --output-format stream --resume=11111111-1111-1111-1111-111111111111',
  '  202 201   60000    56:20   0:01.00 node /Users/u/mcp/server.js',
  '  301   1  120000 02-17:47:46  29:50.77 /Users/u/Library/Application Support/Claude/claude-code/2.1.308/x/claude.app/Contents/MacOS/claude --resume=22222222-2222-2222-2222-222222222222',
  '  400   1  300000 02-14:33:48  54:48.26 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '  401 400  250000 02-14:33:40   4:48.26 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)',
].join('\n')

test('processes are read, sessions told apart, and Claude itself never offered', () => {
  expect(parseElapsed('02-18:01:20')).toBe(2 * 86_400 + 18 * 3600 + 60 + 20)
  const procs = parsePs(PS)
  expect(procs.length).toBe(7)
  const now = Date.UTC(2026, 9, 30)
  const titles = new Map([['22222222-2222-2222-2222-222222222222', { title: 'Old work', lastActivityMs: now - 2 * 86_400_000 }]])
  // Found by its own process when its arguments carry no id.
  expect(owningCli(procs, 202)).toBe(201)
  const sessions = sessionProcs(procs, { id: 'none', pid: owningCli(procs, 202) }, titles, new Map(), now)
  expect(sessions.map(x => [x.pid, x.isCurrent, x.memoryKb])).toEqual([[201, true, 350000], [301, false, 120000]])
  expect(sessions[1]!.title).toBe('Old work')
  const apps = heavyApps(procs, 150 * 1024)
  expect(apps.map(a => [a.name, a.pid, a.isApp])).toEqual([['Google Chrome', 400, true]])
  expect(parseMemory('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active: 100.\nPages wired down: 50.\nPages occupied by compressor: 10.\n', '8589934592\n')).toEqual({ totalBytes: 8589934592, usedBytes: 160 * 16384 })
})

test('only places this mod knows may go to the Trash', () => {
  const home = '/Users/u'
  const keep = ['/Users/u/.claude/projects/-work/s1.jsonl', '/Users/u/work']
  expect(isSafeToTrash('/Users/u/.claude/projects/-old/a.jsonl', home, [], keep)).toBe(true)
  expect(isSafeToTrash('/Users/u/.claude/projects/', home, [], keep)).toBe(false)
  expect(isSafeToTrash('/Users/u/.claude/projects/-work/s1.jsonl', home, [], keep)).toBe(false)
  expect(isSafeToTrash('/Users/u/.claude/projects/../settings.json', home, [], keep)).toBe(false)
  expect(isSafeToTrash('/Users/u/Documents/thesis.pdf', home, [], keep)).toBe(false)
  expect(isSafeToTrash('/Users/u/site/node_modules', home, ['/Users/u/site/node_modules'], keep)).toBe(true)
  expect(isSafeToTrash('/Users/u/work/node_modules', home, ['/Users/u/work/node_modules'], keep)).toBe(false)
})

test('clicks while Claude works wait, stale queued clicks are skipped, and Edit first falls back to the clipboard', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 30, 9, 6) })
  const sent: string[] = []
  const ran: string[][] = []
  const aborted: string[] = []
  mock.env(on, { HOME: '/Users/u', USER: 'u' })
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.fill', () => ({ isFilled: false }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 60_000, window: 200_000, percent: 30 }, rateLimits: [], cost: { usd: 2 } } }))
  on('fs.exists', (_, e) => ({ value: e.path === LOG_PATH }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: LOG.length, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_, e) => ({ value: e.path === LOG_PATH ? LOG : '' }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', (_, e) => {
    sent.push(e.text)

    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.abort', (_, e) => {
    aborted.push(e.turnId)

    return { value: undefined }
  })

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'progress', args: '' } as never)
  await clock.advance(5_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-tips' })
  await clock.advance(2_000)

  // A request queued by a click before this load is skipped.
  await $.turn.start({ text: ruleAction('rereads')!.text, turnId: 'stale' } as never)
  expect(aborted).toEqual(['stale'])

  // While Claude works, a click waits and goes once the turn ends.
  await $.turn.start({ text: 'Fix the login bug', turnId: 'work' } as never)
  await ui.press({ key: 'rec-rereads-do-rereads' })
  await ui.press({ key: 'rec-rereads-do-rereads' })
  await clock.advance(100)
  expect(sent).toEqual([])
  await $.turn.complete({ turnId: 'work', answer: 'done', reason: 'answer', durationMs: 1, isAborted: false } as never)
  await clock.advance(2_000)
  expect(sent.length).toBe(1)
  expect(sent[0]).toMatch(/do not re-read files/)

  // Edit first copies the text when the prompt box cannot be filled.
  await ui.press({ key: 'rec-rereads-draft' })
  await clock.advance(100)
  expect(ran.some(argv => argv[0] === 'pbcopy')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Copied to your clipboard/ })).toBeDefined()
  await ui.unmount()
})

test('the storage tab lists old logs and moves one to the Trash only after a confirming press', async ($, on) => {
  const now = Date.UTC(2026, 9, 30, 9, 6)
  const clock = mock.clock(on, { now })
  const ran: string[][] = []
  const OLD_ID = '33333333-3333-3333-3333-333333333333'
  const OLD_LOG = `${PROJECTS}/-old/${OLD_ID}.jsonl`
  mock.env(on, { HOME: '/Users/u', USER: 'u' })
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 60_000, window: 200_000, percent: 30 }, rateLimits: [], cost: { usd: 2 } } }))
  on('fs.exists', (_, e) => ({ value: e.path === LOG_PATH || e.path === OLD_LOG }))
  on('fs.list', (_, e) => ({
    value:
      e.path === PROJECTS
        ? [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }, { name: '-old', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
        : e.path === `${PROJECTS}/-work`
          ? [{ name: 's1.jsonl', kind: 'file', size: LOG.length, mtimeMs: now, isLink: false }]
          : e.path === `${PROJECTS}/-old`
            ? [{ name: `${OLD_ID}.jsonl`, kind: 'file', size: 3 * 1024 * 1024, mtimeMs: now - 60 * 86_400_000, isLink: false }]
            : [],
  }))
  on('fs.stat', () => ({ value: { kind: 'file', size: LOG.length, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_, e) => ({ value: e.path === LOG_PATH ? LOG : '' }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const stdout =
      e.argv[0] === 'ps' ? PS : e.argv[0] === 'sysctl' ? '8589934592\n' : e.argv[0] === 'head' ? '{"cwd":"/Users/u/oldproj"}' : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'progress', args: '' } as never)
  await clock.advance(5_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-storage' })
  await clock.advance(5_000)

  expect(await ui.find({ type: 'Text', text: /OLD SESSION LOGS|Old session logs/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Old work|Session 33333333/ })).toBeDefined()

  await ui.press({ key: `trash-log-${OLD_ID}` })
  await clock.advance(100)
  expect(ran.some(argv => argv[0] === 'mv')).toBe(false)
  await ui.press({ key: `trash-log-${OLD_ID}` })
  await clock.advance(100)
  const moves = ran.filter(argv => argv[0] === 'mv')
  expect(moves.length).toBe(1)
  expect(moves[0]![2]).toBe(OLD_LOG)
  expect(moves[0]![3]).toMatch(/^\/Users\/u\/\.Trash\//)
  await ui.unmount()
})

test('background work keeps the advice on this session, and loaded connectors are named and weighed', () => {
  const cold = advise({ ...ADVICE, now: 3 * 3_600_000, lastActivity: 1, contextTokens: 150_000, baseline: 100_000, window: 1_000_000, background: ['shell: npm test'] })
  expect(cold.verdict).toBe('continue')
  expect(cold.isUrgent).toBe(false)
  expect(cold.headline).toMatch(/1 background task still running/)

  const tools = [
    { name: 'mcp__00000000-0000-4000-8000-000000000001__TaskTracker_get_tasks', description: '', mcp: true },
    { name: 'mcp__00000000-0000-4000-8000-000000000001__TaskTracker_add_task', description: '', mcp: true },
    { name: 'mcp__ccd_turn__wrap_up', description: '', mcp: true },
    { name: 'mcp__playwright__browser_click', description: '', mcp: true },
    { name: 'Bash', description: '', mcp: false },
  ]
  const servers = loadedServers(tools, ['playwright'], [])
  expect(servers.map(x => [x.label, x.tools, x.isUsedHere, x.isUsedInProject])).toEqual([
    ['TaskTracker', 2, false, null],
    ['browser', 1, true, null],
  ])
})

test('while background work runs the cache is kept warm, and a coached tip reaches Claude with the next prompt', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 30, 9, 6) })
  const forks: string[] = []
  const contexts: string[][] = []
  mock.env(on, { HOME: '/Users/u', USER: 'u' })
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 60_000, window: 200_000, percent: 30 }, rateLimits: [], cost: { usd: 2 } } }))
  on('fs.exists', (_, e) => ({ value: e.path === LOG_PATH }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: LOG.length, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_, e) => ({ value: e.path === LOG_PATH ? LOG : '' }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [] }))
  let agents: object[] = []
  on('agent.list', () => ({ value: agents as never }))
  on('model.fork', (_, e) => {
    forks.push(e.prompt)

    return { value: { isAnswered: true, text: 'OK', usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 0 } } }
  })
  on('prompt.submit', (_, e) => {
    contexts.push([...(e.context ?? [])])

    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'progress', args: '' } as never)
  await clock.advance(5_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'toggle-coach' })
  await clock.advance(100)

  // A turn ends with a background subagent still running: the cache is kept warm before it lapses.
  agents = [{ id: 'a1', description: 'Explore the repo', type: 'Explore', status: 'running' }]
  await $.turn.start({ text: 'Explore the repo in the background', turnId: 't1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'started', reason: 'answer', durationMs: 1, isAborted: false } as never)
  await clock.advance(3_000)
  expect(forks.length).toBe(0)
  await clock.advance(56 * 60_000)
  expect(forks.length).toBe(1)

  // The tip found after that turn goes to Claude, once, with the next prompt.
  await $.prompt.submit({ text: 'What next?' } as never)
  expect(contexts.at(-1)?.join(' ')).toMatch(/Token-efficiency note from the session-progress mod/)
  await $.prompt.submit({ text: 'And then?' } as never)
  expect(contexts.at(-1)?.join(' ') ?? '').not.toMatch(/Token-efficiency note/)
  await ui.unmount()
})
