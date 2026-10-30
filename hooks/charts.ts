import type { ContextPoint, SessionSummary, Tokens } from '../types'

/*
 * SVG drawings for the surfaces that have `Svg` (desktop, VS Code, mobile).
 * They animate themselves with CSS, so the pane never redraws to move them.
 * Colors are the validated categorical slots, stepped for light and dark.
 */

export const SERIES = {
  fresh: { light: '#2a78d6', dark: '#3987e5', label: 'Fresh input' },
  write: { light: '#eb6834', dark: '#d95926', label: 'Cache write' },
  read: { light: '#1baf7a', dark: '#199e70', label: 'Cache read' },
  output: { light: '#eda100', dark: '#c98500', label: 'Output' },
} as const

export const STATUS = { good: '#1a8f5a', warning: '#c98500', critical: '#e34948' } as const

export type MixPart = { key: keyof typeof SERIES; value: number }

const style = `
<style>
  .ink { fill: #3d3d3a; } .muted { fill: #73726c; } .grid { stroke: #73726c; stroke-opacity: .25; }
  .surface { fill: #fcfcfb; stroke: #fcfcfb; }
  ${(Object.keys(SERIES) as (keyof typeof SERIES)[]).map(k => `.s-${k} { fill: ${SERIES[k].light}; stroke: ${SERIES[k].light}; }`).join('\n  ')}
  @media (prefers-color-scheme: dark) {
    .ink { fill: #e8e6e3; } .muted { fill: #a3a29b; } .surface { fill: #1f1f1e; stroke: #1f1f1e; }
    ${(Object.keys(SERIES) as (keyof typeof SERIES)[]).map(k => `.s-${k} { fill: ${SERIES[k].dark}; stroke: ${SERIES[k].dark}; }`).join('\n    ')}
  }
  @keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  @keyframes rise { from { transform: scaleY(0); } to { transform: scaleY(1); } }
  @keyframes draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ring { from { stroke-dashoffset: var(--full); } to { stroke-dashoffset: var(--to); } }
  @keyframes pulse { 0% { r: 3; opacity: .9; } 70% { r: 7; opacity: 0; } 100% { r: 7; opacity: 0; } }
  .grow { transform-box: fill-box; transform-origin: left; animation: grow .9s cubic-bezier(.2,.8,.2,1) both; }
  .fade { animation: fade .6s ease-out both; }
  .rise { transform-box: fill-box; transform-origin: bottom; animation: rise .8s cubic-bezier(.2,.8,.2,1) both; }
</style>`

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const svg = (width: number, height: number, body: string, label: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">${style}${body}</svg>`

/** The efficiency score as a ring that sweeps to its value. */
export const ringSvg = (score: number): string => {
  const size = 112
  const r = 46
  const full = 2 * Math.PI * r
  const to = full * (1 - score / 100)
  const color = score >= 80 ? STATUS.good : score >= 60 ? STATUS.warning : STATUS.critical
  const body = `
  <circle cx="56" cy="56" r="${r}" fill="none" class="grid" stroke-width="10"/>
  <circle cx="56" cy="56" r="${r}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"
    transform="rotate(-90 56 56)" stroke-dasharray="${full.toFixed(1)}" stroke-dashoffset="${to.toFixed(1)}"
    style="--full:${full.toFixed(1)};--to:${to.toFixed(1)};animation: ring 1.3s cubic-bezier(.2,.8,.2,1) both"/>
  <text x="56" y="58" text-anchor="middle" class="ink fade" font-size="28" font-weight="600" font-family="system-ui, sans-serif" style="animation-delay:.5s">${score}</text>
  <text x="56" y="76" text-anchor="middle" class="muted fade" font-size="11" font-family="system-ui, sans-serif" style="animation-delay:.7s">of 100</text>`

  return svg(size, size, body, `Efficiency score ${score} of 100`)
}

/** Two stacked bars: how many tokens of each kind, and what each kind cost. */
export const mixSvg = (rows: { label: string; parts: MixPart[] }[], width: number): string => {
  const labelWidth = 52
  const barHeight = 16
  const rowHeight = 30
  const plot = width - labelWidth - 4
  let body = ''
  rows.forEach((row, ri) => {
    const total = row.parts.reduce((n, p) => n + p.value, 0) || 1
    const y = 6 + ri * rowHeight
    body += `<text x="0" y="${y + 12}" class="muted" font-size="11" font-family="system-ui, sans-serif">${esc(row.label)}</text>`
    let x = labelWidth
    const visible = row.parts.filter(p => p.value / total >= 0.004)
    visible.forEach((p, pi) => {
      const w = Math.max(2, (p.value / total) * plot - (pi < visible.length - 1 ? 2 : 0))
      const delay = (ri * 0.25 + pi * 0.12).toFixed(2)
      const pct = Math.round((p.value / total) * 100)
      body += `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${barHeight}" rx="4" class="s-${p.key} grow" style="animation-delay:${delay}s"><title>${esc(`${SERIES[p.key].label}: ${pct}% of ${row.label.toLowerCase()}`)}</title></rect>`
      x += w + 2
    })
  })

  return svg(width, 6 + rows.length * rowHeight, body, 'Token mix: share of tokens and share of cost by token type')
}

/** At most `limit` points: each bucket keeps its peak, its last task and any marker in it. */
export const downsample = (points: ContextPoint[], limit: number): { point: ContextPoint; first: number; last: number }[] => {
  if (points.length <= limit) return points.map((point, i) => ({ point, first: i, last: i }))
  const out: { point: ContextPoint; first: number; last: number }[] = []
  for (let b = 0; b < limit; b++) {
    const first = Math.floor((b / limit) * points.length)
    const last = Math.max(first, Math.floor(((b + 1) / limit) * points.length) - 1)
    const slice = points.slice(first, last + 1)
    out.push({
      first,
      last,
      point: {
        tokens: Math.max(...slice.map(p => p.tokens)),
        task: slice.at(-1)!.task,
        isCacheRebuild: slice.some(p => p.isCacheRebuild),
        isCompaction: slice.some(p => p.isCompaction),
      },
    })
  }

  return out
}

/** Prompt size per request, drawn left to right, with cache rebuilds and task starts marked. */
export const timelineSvg = (all: ContextPoint[], window: number, width: number): string => {
  const height = 120
  const pad = { top: 14, right: 8, bottom: 16, left: 36 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const buckets = downsample(all, Math.max(40, Math.min(240, Math.floor(plotW / 2))))
  const points = buckets.map(b => b.point)
  const peak = Math.max(1, ...points.map(p => p.tokens))
  const top = peak > window * 0.6 ? window : peak * 1.15
  const x = (i: number): number => pad.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW)
  const y = (v: number): number => pad.top + plotH - (v / top) * plotH
  const fmt = (n: number): string => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
  const taskStarts = points.map((p, i) => i > 0 && p.task !== points[i - 1]!.task).filter(Boolean).length

  let body = ''
  for (const f of [0, 0.5, 1]) {
    const gy = y(top * f)
    body += `<line x1="${pad.left}" x2="${width - pad.right}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" class="grid" stroke-width="1"/>`
    body += `<text x="${pad.left - 4}" y="${(gy + 3).toFixed(1)}" text-anchor="end" class="muted" font-size="9" font-family="system-ui, sans-serif">${fmt(top * f)}</text>`
  }
  if (top === window) {
    body += `<text x="${width - pad.right}" y="${pad.top - 4}" text-anchor="end" class="muted" font-size="9" font-family="system-ui, sans-serif">context window</text>`
  }
  // Task starts are marked only while there are few enough to read.
  if (taskStarts <= 20) {
    points.forEach((p, i) => {
      if (i > 0 && p.task !== points[i - 1]!.task) {
        body += `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${pad.top}" y2="${pad.top + plotH}" class="grid" stroke-dasharray="3 3"/>`
        body += `<text x="${(x(i) + 3).toFixed(1)}" y="${pad.top + 8}" class="muted" font-size="9" font-family="system-ui, sans-serif">task ${p.task + 1}</text>`
      }
    })
  }
  if (points.length > 0) {
    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.tokens).toFixed(1)}`).join(' ')
    const area = `${line} L${x(points.length - 1).toFixed(1)},${(pad.top + plotH).toFixed(1)} L${x(0).toFixed(1)},${(pad.top + plotH).toFixed(1)} Z`
    body += `<path d="${area}" class="s-fresh fade" fill-opacity=".12" stroke="none" style="animation-delay:.9s"/>`
    body += `<path d="${line}" fill="none" class="s-fresh" style="fill:none;stroke-dasharray:1;stroke-dashoffset:1;animation: draw 1.4s ease-out forwards" pathLength="1" stroke-width="2" stroke-linejoin="round"/>`
  }
  buckets.forEach(({ point: p, first, last }, i) => {
    const range = first === last ? `Request ${first + 1}` : `Requests ${first + 1}–${last + 1}`
    const tip = `<title>${esc(`${range} · ${fmt(p.tokens)} tokens · task ${p.task + 1}${p.isCacheRebuild ? ' · cache rebuilt' : ''}${p.isCompaction ? ' · after compaction' : ''}`)}</title>`
    const delay = (0.2 + (i / Math.max(1, points.length)) * 1.3).toFixed(2)
    if (p.isCacheRebuild || p.isCompaction) {
      body += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.tokens).toFixed(1)}" r="5" class="surface" stroke-width="2"/>`
      body += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.tokens).toFixed(1)}" r="4" class="${p.isCompaction ? 's-read' : 's-write'} fade" style="animation-delay:${delay}s">${tip}</circle>`
    } else {
      body += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.tokens).toFixed(1)}" r="6" fill="transparent">${tip}</circle>`
    }
  })
  body += `<text x="${pad.left}" y="${height - 3}" class="muted" font-size="9" font-family="system-ui, sans-serif">request 1</text>`
  body += `<text x="${width - pad.right}" y="${height - 3}" text-anchor="end" class="muted" font-size="9" font-family="system-ui, sans-serif">request ${all.length}</text>`

  return svg(width, height, body, `Context size over ${all.length} requests`)
}

/** A dot that keeps pulsing while Claude works. */
export const pulseSvg = (): string =>
  svg(
    16,
    16,
    `<circle cx="8" cy="8" r="3" fill="${STATUS.good}"/><circle cx="8" cy="8" r="3" fill="${STATUS.good}" style="animation: pulse 1.4s ease-out infinite"/>`,
    'Claude is working',
  )

const SPARKS = '▁▂▃▄▅▆▇█'

/** The terminal's timeline: one block glyph per column, revealed left to right. */
export const sparkline = (points: ContextPoint[], columns: number, reveal: number): string => {
  if (points.length === 0) return ''
  const cells = Math.max(1, Math.min(columns, points.length))
  const peak = Math.max(1, ...points.map(p => p.tokens))
  let out = ''
  for (let c = 0; c < Math.round(cells * reveal); c++) {
    const from = Math.floor((c / cells) * points.length)
    const to = Math.max(from + 1, Math.floor(((c + 1) / cells) * points.length))
    const v = Math.max(...points.slice(from, to).map(p => p.tokens))
    out += SPARKS[Math.min(SPARKS.length - 1, Math.floor((v / peak) * (SPARKS.length - 1)))]
  }

  return out
}

export const mixParts = (t: Tokens, weighted: boolean): MixPart[] => {
  const w5m = t.cacheWrite - t.cacheWrite1h

  return [
    { key: 'fresh', value: t.input },
    { key: 'write', value: weighted ? w5m * 1.25 + t.cacheWrite1h * 2 : t.cacheWrite },
    { key: 'read', value: weighted ? t.cacheRead * 0.1 : t.cacheRead },
    { key: 'output', value: weighted ? t.output * 5 : t.output },
  ]
}

/** Spend per past session, oldest on the left; the tallest bar sets the scale. */
export const historySvg = (sessions: SessionSummary[], width: number, label: (s: SessionSummary) => string): string => {
  const height = 110
  const pad = { top: 8, bottom: 16, left: 4, right: 4 }
  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt)
  const peak = Math.max(1, ...ordered.map(s => s.weighted))
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const slot = plotW / Math.max(1, ordered.length)
  const bar = Math.max(2, Math.min(18, slot - 2))
  let body = `<line x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top + plotH}" y2="${pad.top + plotH}" class="grid"/>`
  ordered.forEach((s, i) => {
    const h = Math.max(2, (s.weighted / peak) * plotH)
    const x = pad.left + i * slot + (slot - bar) / 2
    const y = pad.top + plotH - h
    const delay = (i * (0.9 / Math.max(1, ordered.length))).toFixed(2)
    body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bar.toFixed(1)}" height="${h.toFixed(1)}" rx="3" class="s-fresh rise" style="animation-delay:${delay}s"><title>${esc(label(s))}</title></rect>`
  })
  body += `<text x="${pad.left}" y="${height - 3}" class="muted" font-size="9" font-family="system-ui, sans-serif">oldest</text>`
  body += `<text x="${width - pad.right}" y="${height - 3}" text-anchor="end" class="muted" font-size="9" font-family="system-ui, sans-serif">newest</text>`

  return svg(width, height, body, `Spend across ${ordered.length} past sessions`)
}
