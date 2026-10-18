/**
 * Local token metering.
 *
 * Ollama Cloud's `/api/usage` reports token counts and cost only for accounts on
 * a current plan; a legacy plan returns request counts alone. This meter fills
 * that gap for work done **by this harness**: it taps the `usage` chunk every
 * request already emits and accumulates input/cached/output tokens per model in
 * hourly buckets, so the plugin can show token totals inside the same quota
 * windows the server reports.
 *
 * Scope, deliberately: it counts what dsh itself sends. Usage from other
 * clients (the pi CLI, curl, other machines) is invisible here and is why the
 * server numbers, when they exist, still win.
 * @module dsh-ollama-cloud/meter
 */
import { readFile, rename, writeFile } from 'node:fs/promises'

const VERSION = 1
const RETENTION_MS = 30 * 24 * 3600_000
const WRITE_DEBOUNCE_MS = 5000

/** Hour key (`2026-10-18T04`) — the bucket the API itself reports in. */
export function hourKey(ms) {
  return new Date(ms).toISOString().slice(0, 13)
}

/** Start of the hour a key names, in epoch milliseconds. */
export function hourStart(key) {
  return Date.parse(`${key}:00:00.000Z`)
}

/**
 * Accumulate one request's tokens into rows keyed by `hour|model`.
 * @param {Map<string, {requests: number, inputTokens: number, outputTokens: number, cachedTokens: number, reasoningTokens: number}>} rows
 * @param {{model: string, usage: {inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, reasoningTokens?: number}, at?: number}} event
 */
export function accumulate(rows, event) {
  const at = event.at ?? Date.now()
  const key = `${hourKey(at)}|${event.model}`
  const row = rows.get(key) ?? { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 }
  row.requests += 1
  row.inputTokens += Math.max(0, Math.round(event.usage?.inputTokens ?? 0))
  row.outputTokens += Math.max(0, Math.round(event.usage?.outputTokens ?? 0))
  row.cachedTokens += Math.max(0, Math.round(event.usage?.cacheReadTokens ?? 0))
  // Reasoning is a subset of output (pi-ai folds it into completion tokens);
  // it is tracked separately for display, never added to the total again.
  row.reasoningTokens += Math.max(0, Math.round(event.usage?.reasoningTokens ?? 0))
  rows.set(key, row)
}

/**
 * Sum rows inside `[from, to]`, optionally split per model.
 * @param {Map<string, any>} rows
 * @param {{from?: number, to?: number, model?: string}} window
 * @returns {{requests: number, inputTokens: number, outputTokens: number, cachedTokens: number, reasoningTokens: number}}
 */
export function windowTotals(rows, { from = 0, to = Number.MAX_SAFE_INTEGER, model } = {}) {
  const total = { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 }
  for (const [key, row] of rows) {
    const split = key.lastIndexOf('|')
    const start = hourStart(key.slice(0, split))
    if (start + 3600_000 <= from || start > to) continue
    if (model !== undefined && key.slice(split + 1) !== model) continue
    total.requests += row.requests
    total.inputTokens += row.inputTokens
    total.outputTokens += row.outputTokens
    total.cachedTokens += row.cachedTokens
    total.reasoningTokens += row.reasoningTokens ?? 0
  }
  return total
}

/**
 * Hourly series inside a window, chronological — the shape a chart wants.
 * @param {Map<string, any>} rows
 * @param {{from?: number, to?: number}} window
 * @returns {{hour: string, requests: number, inputTokens: number, outputTokens: number, cachedTokens: number, reasoningTokens: number}[]}
 */
export function windowSeries(rows, { from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
  const hours = new Map()
  for (const [key, row] of rows) {
    const split = key.lastIndexOf('|')
    const hour = key.slice(0, split)
    const start = hourStart(hour)
    if (start + 3600_000 <= from || start > to) continue
    const bucket = hours.get(hour) ?? { hour, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 }
    bucket.requests += row.requests
    bucket.inputTokens += row.inputTokens
    bucket.outputTokens += row.outputTokens
    bucket.cachedTokens += row.cachedTokens
    bucket.reasoningTokens += row.reasoningTokens ?? 0
    hours.set(hour, bucket)
  }
  return [...hours.values()].sort((left, right) => left.hour.localeCompare(right.hour))
}

/** Per-model totals inside a window, largest first. */
export function windowModels(rows, { from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
  const models = new Map()
  for (const key of rows.keys()) {
    const model = key.slice(key.lastIndexOf('|') + 1)
    if (!models.has(model)) models.set(model, windowTotals(rows, { from, to, model }))
  }
  return [...models]
    .map(([model, totals]) => ({ model, ...totals }))
    .sort((left, right) => right.inputTokens + right.outputTokens - (left.inputTokens + left.outputTokens))
}

/** The numeric fields one meter row accumulates. */
const FIELDS = ['requests', 'inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens']

/** A zero row, so a merge into a key the other process never wrote still works. */
const emptyRow = () => ({ requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 })

/** Load one meter file; undefined when absent, corrupt, or from another version. */
async function readRows(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed?.version !== VERSION || !Array.isArray(parsed.rows)) return undefined
    const rows = new Map()
    for (const [key, row] of parsed.rows) {
      if (typeof key !== 'string' || row === null || typeof row !== 'object') continue
      if (typeof row.requests !== 'number') continue
      rows.set(key, {
        requests: row.requests,
        inputTokens: Number(row.inputTokens) || 0,
        outputTokens: Number(row.outputTokens) || 0,
        cachedTokens: Number(row.cachedTokens) || 0,
        reasoningTokens: Number(row.reasoningTokens) || 0,
      })
    }
    return rows
  } catch {
    return undefined
  }
}

/** Snapshot a row map so later mutations cannot disturb it. */
function cloneRows(rows) {
  return new Map([...rows].map(([key, row]) => [key, { ...row }]))
}

/** Hour start of the bucket a `hour|model` key names. */
function keyStart(key) {
  return hourStart(key.slice(0, key.lastIndexOf('|')))
}

/**
 * Open the persisted meter.
 *
 * A missing or unreadable file starts an empty meter — accounting is a display
 * concern, never a reason to fail plugin activation.
 *
 * Several harness processes (the desktop app and a CLI) share one file at
 * `$DSH_HOME/ollama-cloud-usage.json`. Each flush therefore re-reads the file
 * and adds only this process's *delta* since its own last write, rather than
 * replacing the file wholesale and dropping the other process's rows.
 * @param {{path: string, now?: () => number}} options
 */
export async function openMeter({ path, now = Date.now }) {
  /** @type {Map<string, {requests: number, inputTokens: number, outputTokens: number, cachedTokens: number}>} */
  const rows = (await readRows(path)) ?? new Map()
  /** The rows as of this process's last flush, so a flush adds only what is new. */
  let persisted = cloneRows(rows)
  let timer
  let writing

  const prune = () => {
    const cutoff = now() - RETENTION_MS
    for (const key of [...rows.keys()]) if (keyStart(key) + 3600_000 < cutoff) rows.delete(key)
  }
  prune()

  const persist = async () => {
    const disk = (await readRows(path)) ?? new Map()
    for (const [key, row] of rows) {
      const before = persisted.get(key)
      const delta = emptyRow()
      for (const field of FIELDS) delta[field] = (row[field] ?? 0) - (before?.[field] ?? 0)
      if (FIELDS.every((field) => delta[field] === 0)) continue
      const target = disk.get(key) ?? emptyRow()
      for (const field of FIELDS) target[field] += delta[field]
      disk.set(key, target)
    }
    const cutoff = now() - RETENTION_MS
    for (const key of [...disk.keys()]) if (keyStart(key) + 3600_000 < cutoff) disk.delete(key)
    const body = JSON.stringify({ version: VERSION, rows: [...disk] })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, body, { mode: 0o600 })
    await rename(temp, path)
    persisted = cloneRows(rows)
  }

  const flush = async () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    writing = writing === undefined ? persist() : writing.then(persist, persist)
    return writing
  }

  return {
    /** Count one finished request. */
    record(event) {
      accumulate(rows, { ...event, at: now() })
      prune()
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined
          void flush().catch(() => {})
        }, WRITE_DEBOUNCE_MS)
        timer.unref?.()
      }
    },
    totals: (window) => windowTotals(rows, window),
    models: (window) => windowModels(rows, window),
    series: (window) => windowSeries(rows, window),
    flush,
    dispose: () => flush(),
  }
}
