/**
 * Ollama Cloud API client for the harness side of dsh-ollama-cloud.
 *
 * Everything here is pure data plumbing: it never touches settings,
 * credentials, tools, or Cordis. The plugin (lib/index.js) owns policy.
 *
 * Endpoints used:
 *   GET  /v1/models               -> model ids (OpenAI-compatible listing)
 *   POST /api/show                -> per-model capabilities, context, thinking levels
 *   POST /api/web_search          -> hosted web search
 *   POST /api/web_fetch           -> hosted page fetch
 *   GET  /api/usage?range=24h|7d  -> request counts (5h is windowed from 24h buckets)
 */

/** Ollama Cloud origin; the OpenAI-compatible surface lives under `/v1`. */
export const CLOUD_BASE = 'https://ollama.com'

const REQUEST_TIMEOUT_MS = 20000

/**
 * Fetch JSON with a hard timeout and caller cancellation.
 * @param {string} url
 * @param {{method?: string, key?: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<{ok: boolean, status: number, data: any, text: string}>}
 */
async function requestJson(url, options = {}) {
  const { method = 'GET', key, body, signal, timeoutMs = REQUEST_TIMEOUT_MS } = options
  // `abort` already fired means its listener will never be called: fail now
  // instead of running the request to completion behind a cancelled tool call.
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Ollama Cloud request aborted'), { name: 'AbortError' })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const forward = () => controller.abort()
  signal?.addEventListener('abort', forward, { once: true })
  const headers = { Accept: 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`
  const init = { method, signal: controller.signal, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  try {
    const response = await fetch(url, init)
    const text = await response.text()
    let data
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      data = undefined
    }
    return { ok: response.ok, status: response.status, data, text }
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error(`Ollama Cloud request failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

/** Human-readable failure for a non-2xx Ollama Cloud response. */
function httpFailure(what, response) {
  const detail = response.data?.error ?? response.text?.slice(0, 200) ?? ''
  if (response.status === 401 || response.status === 403) {
    return new Error(`Ollama Cloud ${what} rejected the API key (${response.status}). ${detail}`.trim())
  }
  if (response.status === 429) return new Error(`Ollama Cloud ${what} is rate limited (429). Try again shortly.`)
  return new Error(`Ollama Cloud ${what} failed (${response.status}). ${detail}`.trim())
}

/** Trailing-slash-free origin for a configured base URL. */
export function origin(baseURL = CLOUD_BASE) {
  return String(baseURL || CLOUD_BASE).replace(/\/+$/, '')
}

/** Model ids advertised by the account's catalog. */
export async function listModels({ base, key, signal } = {}) {
  const response = await requestJson(`${origin(base)}/v1/models`, { key, signal })
  if (!response.ok) throw httpFailure('model list', response)
  const rows = Array.isArray(response.data?.data) ? response.data.data : []
  const ids = rows.map((row) => row?.id).filter((id) => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) throw new Error('Ollama Cloud model list returned no models.')
  return ids
}

/** Per-model details: capabilities, context length, and advertised thinking levels. */
export async function showModel({ base, key, id, signal } = {}) {
  const response = await requestJson(`${origin(base)}/api/show`, { method: 'POST', key, body: { model: id }, signal })
  if (!response.ok) throw httpFailure(`/api/show for ${id}`, response)
  return response.data ?? {}
}

/** Run `worker` over `items` with a bounded number of in-flight tasks. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** Context length from a `/api/show` `model_info` bag (`<arch>.context_length`). */
export function contextLength(modelInfo) {
  if (modelInfo === null || typeof modelInfo !== 'object') return undefined
  for (const [key, value] of Object.entries(modelInfo)) {
    if (!key.endsWith('.context_length')) continue
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

/**
 * Translate Ollama's advertised thinking levels into harness `reasoningEfforts`.
 *
 * Ollama reports `thinking.values` as the wire values it accepts:
 *   - `false`      thinking can be turned off -> `off: 'none'` (sending nothing
 *                  would fall back to the model default, which is often ON)
 *   - `true`       a binary model: one "on" level, offered as `medium`
 *   - graded names (`low`…`max`) map to the same-named harness level, so a
 *                  model advertising `xhigh` and `max` offers both.
 * A model advertising nothing but `thinking` keeps a permissive gradation.
 * A declaration that cannot offer anything beyond `off` is a non-reasoning
 * model, reported as `false` (the harness refuses an all-off map).
 * @param {{values?: unknown[]}|undefined} thinking
 * @returns {Record<string, string>|false}
 */
export function reasoningEfforts(thinking) {
  const graded = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const values = Array.isArray(thinking?.values) ? thinking.values : undefined
  if (values === undefined) return { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'max' }
  const efforts = {}
  for (const value of values) {
    if (value === false || value === 'none') efforts.off = 'none'
    else if (value === true) efforts.medium = 'medium'
    else if (graded.includes(value)) efforts[value] = value
  }
  const thinks = Object.keys(efforts).some((level) => level !== 'off')
  return thinks ? efforts : false
}

/**
 * Build one `llm-pi-ai` catalog entry from a `/api/show` payload.
 * @param {string} id
 * @param {any} show
 * @param {{includeNonToolModels?: boolean}} options
 * @returns {Record<string, unknown>|undefined} undefined when the model is skipped
 */
export function modelEntry(id, show, { includeNonToolModels = false } = {}) {
  const capabilities = Array.isArray(show?.capabilities) ? show.capabilities : []
  if (!includeNonToolModels && !capabilities.includes('tools')) return undefined
  const entry = { id, name: id }
  const context = contextLength(show?.model_info)
  if (context !== undefined) entry.contextWindow = context
  if (capabilities.includes('vision')) entry.input = ['text', 'image']
  if (capabilities.includes('thinking')) entry.reasoningEfforts = reasoningEfforts(show.thinking)
  return entry
}

/**
 * Fetch the whole live catalog, one `/api/show` per model.
 * A single model that fails to describe itself is reported, never fatal.
 * @returns {Promise<{total: number, models: object[], skipped: string[], failures: {id: string, message: string}[]}>}
 */
export async function fetchCatalog({ base, key, includeNonToolModels = false, signal, concurrency = 6 } = {}) {
  const ids = await listModels({ base, key, signal })
  const described = await mapLimit(ids, concurrency, async (id) => {
    try {
      return { id, show: await showModel({ base, key, id, signal }) }
    } catch (error) {
      return { id, error: error instanceof Error ? error.message : String(error) }
    }
  })
  const models = []
  const skipped = []
  const failures = []
  for (const row of described) {
    if (row.error !== undefined) {
      failures.push({ id: row.id, message: row.error })
      continue
    }
    const entry = modelEntry(row.id, row.show, { includeNonToolModels })
    if (entry === undefined) skipped.push(row.id)
    else models.push(entry)
  }
  models.sort((left, right) => left.id.localeCompare(right.id))
  return { total: ids.length, models, skipped, failures }
}

/** Hosted web search. Returns the result rows the API reported. */
export async function webSearch({ base, key, query, maxResults = 8, signal } = {}) {
  const response = await requestJson(`${origin(base)}/api/web_search`, {
    method: 'POST',
    key,
    body: { query, max_results: maxResults },
    signal,
  })
  if (!response.ok) throw httpFailure('web search', response)
  const results = Array.isArray(response.data?.results) ? response.data.results : []
  return results.map((row) => ({
    title: typeof row?.title === 'string' ? row.title : '',
    url: typeof row?.url === 'string' ? row.url : '',
    snippet: typeof row?.content === 'string' ? row.content.trim() : '',
  }))
}

/** Hosted page fetch, returning extracted text plus the page's links. */
export async function webFetch({ base, key, url, signal } = {}) {
  const response = await requestJson(`${origin(base)}/api/web_fetch`, {
    method: 'POST',
    key,
    body: { url },
    signal,
  })
  if (!response.ok) throw httpFailure('web fetch', response)
  return {
    title: typeof response.data?.title === 'string' ? response.data.title : '',
    content: typeof response.data?.content === 'string' ? response.data.content : '',
    links: Array.isArray(response.data?.links) ? response.data.links.filter((link) => typeof link === 'string') : [],
  }
}

/** Read one usage-summary object (`totals`) or bucket into our fields. */
function summarize(source) {
  if (source === null || typeof source !== 'object') return undefined
  const summary = {}
  if (typeof source.request_count === 'number') summary.requests = source.request_count
  if (typeof source.input_tokens === 'number') summary.inputTokens = source.input_tokens
  if (typeof source.cached_input_tokens === 'number') summary.cachedTokens = source.cached_input_tokens
  if (typeof source.output_tokens === 'number') summary.outputTokens = source.output_tokens
  if (typeof source.reasoning_tokens === 'number') summary.reasoningTokens = source.reasoning_tokens
  if (typeof source.usage_usd === 'number') summary.usd = source.usage_usd
  const groups = Array.isArray(source.groups) ? source.groups : []
  if (groups.length > 0) {
    summary.models = groups.map((group) => ({
      model: typeof group?.model === 'string' ? group.model : 'unknown',
      requests: typeof group?.request_count === 'number' ? group.request_count : 0,
      inputTokens: typeof group?.input_tokens === 'number' ? group.input_tokens : undefined,
      outputTokens: typeof group?.output_tokens === 'number' ? group.output_tokens : undefined,
      usd: typeof group?.usage_usd === 'number' ? group.usage_usd : undefined,
    }))
  }
  return summary
}

/** Merge `right` into `left`, summing numbers and combining model rows by name. */
function mergeSummary(left, right) {
  if (right === undefined) return left
  if (left === undefined) return right
  const merged = { ...left }
  for (const field of ['requests', 'inputTokens', 'cachedTokens', 'outputTokens', 'reasoningTokens', 'usd']) {
    if (right[field] === undefined) continue
    merged[field] = (merged[field] ?? 0) + right[field]
  }
  if (right.models !== undefined) {
    const rows = new Map((left.models ?? []).map((row) => [row.model, { ...row }]))
    for (const row of right.models) {
      const existing = rows.get(row.model)
      if (existing === undefined) {
        rows.set(row.model, { ...row })
        continue
      }
      existing.requests += row.requests
      for (const field of ['inputTokens', 'outputTokens', 'usd']) {
        if (row[field] === undefined) continue
        existing[field] = (existing[field] ?? 0) + row[field]
      }
    }
    merged.models = [...rows.values()].sort((a, b) => b.requests - a.requests)
  }
  return merged
}

/** Percent used (0-100) from a documented `remaining_percent`, or undefined. */
function usedPercentOf(window) {
  const remaining = window?.remaining_percent
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return undefined
  const clamped = Math.min(Math.max(remaining, 0), 100)
  return Math.round((100 - clamped) * 10) / 10
}

/** Normalize one `/api/balance` window. */
function balanceWindow(window) {
  const usedPercent = usedPercentOf(window)
  return {
    usedPercent,
    remainingPercent: usedPercent === undefined ? undefined : Math.round((100 - usedPercent) * 10) / 10,
    resetsAt: typeof window?.resets_at === 'string' && window.resets_at.length > 0 ? window.resets_at : undefined,
  }
}

/**
 * Fetch the plan balance: the two quota windows the Ollama UI draws as bars.
 * `session` is the rolling 5h window, `weekly` the 7d one; each carries a
 * remaining percentage and the moment it resets.
 * @returns {Promise<{session: object, weekly: object, purchasedUsd?: number}>}
 */
export async function fetchBalance({ base, key, signal } = {}) {
  const response = await requestJson(`${origin(base)}/api/balance`, { key, signal })
  if (!response.ok) throw httpFailure('balance', response)
  const data = response.data ?? {}
  return {
    session: balanceWindow(data.included?.session),
    weekly: balanceWindow(data.included?.weekly),
    purchasedUsd: typeof data.purchased?.balance_usd === 'number' ? data.purchased.balance_usd : undefined,
  }
}

/**
 * Fetch plan balance plus usage.
 *
 * The balance supplies the quota percentages. The usage endpoint supplies request
 * counts, per-model breakdown, and — on current plans — token counts and cost; a
 * legacy plan reports request counts only, which `tokenSource` records so the
 * caller can fall back to local metering. The 5h window is the part of the 24h
 * hourly report that falls inside the session's own quota window.
 * @returns {Promise<{balance: object, fiveHour: object, sevenDay: object, tokenSource: 'server'|'legacy', fetchedAt: number}>}
 */
export async function fetchUsage({ base, key, signal, now = Date.now() } = {}) {
  const root = origin(base)
  const [balance, day, week] = await Promise.all([
    requestJson(`${root}/api/balance`, { key, signal }),
    requestJson(`${root}/api/usage?range=24h&group_by=model`, { key, signal }),
    requestJson(`${root}/api/usage?range=7d&group_by=model`, { key, signal }),
  ])
  if (!balance.ok) throw httpFailure('balance', balance)
  if (!day.ok) throw httpFailure('usage', day)
  if (!week.ok) throw httpFailure('usage', week)

  const plan = {
    session: balanceWindow(balance.data?.included?.session),
    weekly: balanceWindow(balance.data?.included?.weekly),
    purchasedUsd: typeof balance.data?.purchased?.balance_usd === 'number' ? balance.data.purchased.balance_usd : undefined,
  }

  // The session window ends when the balance resets, so its start is that
  // moment minus five hours; without a reset time, fall back to a rolling 5h.
  const sessionEnd = plan.session.resetsAt === undefined ? now : Date.parse(plan.session.resetsAt)
  const sessionStart = (Number.isFinite(sessionEnd) ? sessionEnd : now) - 5 * 3600_000
  const hourlyBuckets = Array.isArray(day.data?.buckets) ? day.data.buckets : []
  let fiveHour
  for (const bucket of hourlyBuckets) {
    const start = typeof bucket?.from === 'string' ? Date.parse(bucket.from) : Number.NaN
    if (!Number.isFinite(start) || start + 3600_000 <= sessionStart) continue
    fiveHour = mergeSummary(fiveHour, summarize(bucket))
  }
  fiveHour ??= summarize({})

  const sevenDay = summarize(week.data?.totals ?? {})
  const weekBuckets = (Array.isArray(week.data?.buckets) ? week.data.buckets : []).map((bucket) => ({
    from: typeof bucket?.from === 'string' ? bucket.from : '',
    partial: bucket?.partial === true,
    ...summarize(bucket),
  }))
  // The 24h hourly buckets are the activity chart's data, not only a sum, so
  // each one is normalized to the same shape a total uses.
  const hourly = hourlyBuckets.map((bucket) => ({
    from: typeof bucket?.from === 'string' ? bucket.from : '',
    partial: bucket?.partial === true,
    ...summarize(bucket),
  }))

  return {
    balance: plan,
    fiveHour,
    sevenDay: { ...sevenDay, buckets: weekBuckets },
    hourly,
    tokenSource: typeof sevenDay.inputTokens === 'number' ? 'server' : 'legacy',
    fetchedAt: now,
  }
}

/** Compact token count: 1234 -> "1.2k", 1200000 -> "1.2M". */
export function formatTokens(count) {
  if (typeof count !== 'number' || !Number.isFinite(count)) return '—'
  if (count < 1000) return String(Math.round(count))
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/** Ten-cell quota bar for a 0-100 used percentage. */
export function quotaBar(percent) {
  const used = typeof percent === 'number' && Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0
  const filled = Math.min(Math.max(Math.round(used / 10), 0), 10)
  return `▕${'█'.repeat(filled)}${'░'.repeat(10 - filled)}▏`
}

/** "3 小时 12 分后重置" for an ISO reset timestamp. */
export function formatReset(resetsAt, now = Date.now()) {
  if (typeof resetsAt !== 'string') return ''
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return ''
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  if (minutes < 60) return `${minutes} 分钟后重置`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分后重置`
  return `${Math.floor(hours / 24)} 天后重置`
}

/** One quota line for the command: bar, used %, and reset countdown. */
function quotaLine(label, window, now) {
  if (window === undefined || window.usedPercent === undefined) return `  ${label}：额度信息不可用`
  const reset = formatReset(window.resetsAt, now)
  const used = `已用 ${window.usedPercent}%`
  return `  ${label} ${quotaBar(window.usedPercent)} ${used}${reset === '' ? '' : ` · ${reset}`}`
}

/** Token + request line for one window. */
function windowLine(window) {
  if (window === undefined) return '    —'
  const parts = [`${window.requests ?? 0} 次请求`]
  if (typeof window.inputTokens === 'number') parts.push(`输入 ${formatTokens(window.inputTokens)}`)
  if (typeof window.cachedTokens === 'number' && window.cachedTokens > 0) parts.push(`缓存 ${formatTokens(window.cachedTokens)}`)
  if (typeof window.outputTokens === 'number') parts.push(`输出 ${formatTokens(window.outputTokens)}`)
  if (typeof window.usd === 'number') parts.push(`$${window.usd.toFixed(4)}`)
  return `    ${parts.join(' · ')}`
}

/**
 * Human-readable usage summary for the `/ollama-cloud` command: the two quota
 * bars, then per-window tokens and the busiest models.
 * @param {{balance: object, fiveHour: object, sevenDay: object, tokenSource?: string}} usage
 */
export function formatUsage(usage, now = Date.now()) {
  const lines = ['Ollama Cloud 用量：']
  lines.push(quotaLine('会话（5h）', usage.balance?.session, now))
  lines.push(quotaLine('每周（7d）', usage.balance?.weekly, now))
  lines.push('  5h 统计：', windowLine(usage.fiveHour))
  lines.push('  7d 统计：', windowLine(usage.sevenDay))
  if (usage.tokenSource === 'legacy') {
    lines.push('    （token 统计来自本机 dsh 计量：官方接口对旧版套餐只返回请求数）')
  }
  if (typeof usage.balance?.purchasedUsd === 'number') {
    lines.push(`  附加额度余额：$${usage.balance.purchasedUsd.toFixed(2)}`)
  }
  const models = usage.sevenDay?.models ?? []
  if (models.length > 0) {
    lines.push('  7d 模型分布：')
    for (const row of models.slice(0, 6)) {
      const tokens = typeof row.inputTokens === 'number' ? ` · 输入 ${formatTokens(row.inputTokens)} / 输出 ${formatTokens(row.outputTokens)}` : ''
      lines.push(`    ${row.model}：${row.requests} 次${tokens}`)
    }
  }
  return lines.join('\n')
}
