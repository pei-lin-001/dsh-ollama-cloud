/**
 * Self-check for the pure halves of dsh-ollama-cloud: catalog mapping, thinking
 * levels, usage normalization, and the shape written into llm-pi-ai.
 *
 * Run with `node test/smoke.mjs` — no API key, no network (fetch is stubbed).
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accumulate, hourKey, hourStart, openMeter, windowModels, windowTotals } from '../lib/meter.js'
import {
  contextLength,
  fetchCatalog,
  fetchUsage,
  formatReset,
  formatTokens,
  formatUsage,
  modelEntry,
  quotaBar,
  reasoningEfforts,
} from '../lib/ollama.js'
import { deepEqual, sameOriginPost } from '../lib/index.js'

// --- Thinking levels ---------------------------------------------------------

assert.deepEqual(reasoningEfforts({ values: [false, 'low', 'high', 'max'] }), {
  off: 'none',
  low: 'low',
  high: 'high',
  max: 'max',
})
assert.deepEqual(reasoningEfforts({ values: ['low', 'medium', 'high'] }), { low: 'low', medium: 'medium', high: 'high' })
assert.deepEqual(reasoningEfforts({ values: [false, true] }), { off: 'none', medium: 'medium' }, 'binary models offer one on-level')
assert.equal(Object.hasOwn(reasoningEfforts(undefined), 'off'), true, 'unknown models keep an off level')
assert.equal(reasoningEfforts({ values: [] }), false, 'an all-off advertisement declares a non-reasoning model')

// --- Catalog mapping --------------------------------------------------------

const show = (capabilities, extra = {}) => ({
  capabilities,
  model_info: { 'glm5_next.context_length': 1048576 },
  ...extra,
})

assert.equal(modelEntry('no-tools', show(['completion'])), undefined, 'tool-less models are skipped by default')
assert.deepEqual(modelEntry('no-tools', show(['completion']), { includeNonToolModels: true }), {
  id: 'no-tools',
  name: 'no-tools',
  contextWindow: 1048576,
})
assert.deepEqual(modelEntry('glm-5.3-flash', show(['completion', 'thinking', 'tools', 'vision'], { thinking: { values: ['low', 'high', 'max'] } })), {
  id: 'glm-5.3-flash',
  name: 'glm-5.3-flash',
  contextWindow: 1048576,
  input: ['text', 'image'],
  reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
})
assert.equal(contextLength({ 'x.embedding_length': 4096 }), undefined)
assert.equal(contextLength(undefined), undefined)

// --- Catalog fetch with a stubbed API --------------------------------------

const replies = {
  'https://ollama.com/v1/models': { data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
  'https://ollama.com/api/show': undefined,
}
globalThis.fetch = async (url, init) => {
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  const payload =
    replies[url] !== undefined
      ? replies[url]
      : body.model === 'a'
        ? show(['completion', 'tools'])
        : body.model === 'b'
          ? show(['completion', 'tools', 'thinking'], { thinking: { values: [false, 'high'] } })
          : { error: 'b was retired' }
  return { ok: payload.error === undefined, status: payload.error === undefined ? 200 : 404, text: async () => JSON.stringify(payload) }
}
const catalog = await fetchCatalog({ base: 'https://ollama.com', key: 'test', concurrency: 2 })
assert.equal(catalog.total, 3)
assert.deepEqual(catalog.models.map((model) => model.id), ['a', 'b'])
assert.deepEqual(catalog.skipped, [])
assert.deepEqual(catalog.failures.map((row) => row.id), ['c'], 'a retired model is reported, not fatal')
assert.deepEqual(catalog.models[1].reasoningEfforts, { off: 'none', high: 'high' })

// --- Usage: balance bars + windowed totals ---------------------------------

const hourBucket = (hoursAgo, count, tokens) => ({
  from: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  request_count: count,
  ...tokens || {},
})
const DAY = 24 * 3600_000
globalThis.fetch = async (url) => {
  const payload = url.endsWith('/api/balance')
    ? {
        included: {
          session: { remaining_percent: 87.6, resets_at: new Date(Date.now() + 2 * 3600_000).toISOString() },
          weekly: { remaining_percent: 45, resets_at: new Date(Date.now() + 3 * DAY).toISOString() },
        },
        purchased: { balance_usd: 4.5 },
      }
    : url.includes('range=24h')
      ? {
          range: '24h',
          // -8h sits outside the 5h session window, -3h and -1h are inside.
          buckets: [hourBucket(8, 100), hourBucket(3, 5), hourBucket(1, 7)],
          totals: { request_count: 112 },
        }
      : {
          range: '7d',
          buckets: [hourBucket(24, 10), hourBucket(48, 4)],
          totals: {
            request_count: 714,
            input_tokens: 106000,
            cached_input_tokens: 46000,
            output_tokens: 13600,
            usage_usd: 0.01718,
            groups: [{ model: 'glm-5.3-flash', request_count: 700, input_tokens: 100000, output_tokens: 10000, usage_usd: 0.01 }],
          },
        }
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
}
const usage = await fetchUsage({ base: 'https://ollama.com', key: 'test' })
assert.equal(usage.balance.session.usedPercent, 12.4, 'used% is the inverse of the reported remaining%')
assert.equal(usage.balance.session.remainingPercent, 87.6)
assert.equal(usage.balance.weekly.usedPercent, 55)
assert.equal(usage.balance.purchasedUsd, 4.5)
assert.equal(usage.fiveHour.requests, 12, 'only buckets inside the 5h session window count')
assert.equal(usage.sevenDay.requests, 714)
assert.equal(usage.sevenDay.inputTokens, 106000)
assert.equal(usage.tokenSource, 'server')
assert.equal(usage.sevenDay.models[0].model, 'glm-5.3-flash')
assert.equal(usage.sevenDay.buckets.length, 2)
assert.equal(usage.hourly.length, 3, 'hourly buckets are normalized for the chart')
assert.deepEqual(usage.hourly.map((bucket) => bucket.requests), [100, 5, 7])
assert.equal(typeof usage.sevenDay.buckets[0].requests, 'number', 'daily buckets carry chart-ready request counts')

const text = formatUsage(usage)
assert.match(text, /会话（5h） ▕█░+▏ 已用 12\.4% · 2 小时 0 分后重置/)
assert.match(text, /7d 统计：\n    714 次请求 · 输入 106k · 缓存 46k · 输出 14k · \$0\.0172/)
assert.match(text, /glm-5\.3-flash：700 次/)
assert.equal(formatTokens(999), '999')
assert.equal(formatTokens(1234), '1.2k')
assert.equal(formatTokens(1_200_000), '1.2M')
assert.equal(quotaBar(0), '▕░░░░░░░░░░▏')
assert.equal(quotaBar(100), '▕██████████▏')
assert.match(formatReset(new Date(Date.now() + 90 * 60_000).toISOString()), /1 小时 30 分后重置|1 小时 29 分后重置/)

// A legacy plan reports request counts only, so tokenSource says so.
globalThis.fetch = async (url) => {
  const payload = url.endsWith('/api/balance')
    ? { included: { session: { remaining_percent: 50 }, weekly: { remaining_percent: 50 } }, purchased: { balance_usd: 0 } }
    : { range: url.includes('24h') ? '24h' : '7d', buckets: [hourBucket(1, 3)], totals: { request_count: 3 } }
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
}
const legacy = await fetchUsage({ base: 'https://ollama.com', key: 'test' })
assert.equal(legacy.tokenSource, 'legacy')
assert.equal(legacy.fiveHour.inputTokens, undefined)
assert.match(formatUsage(legacy), /token 统计来自本机 dsh 计量/)

// --- Local token meter ------------------------------------------------------

const rows = new Map()
const nowMs = Date.parse('2026-10-18T04:30:00Z')
accumulate(rows, { model: 'glm-5.3-flash', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 }, at: nowMs })
accumulate(rows, { model: 'glm-5.3-flash', usage: { inputTokens: 50, outputTokens: 10 }, at: nowMs })
accumulate(rows, { model: 'kimi-k3', usage: { inputTokens: 1000, outputTokens: 200 }, at: nowMs - 2 * 3600_000 })
assert.deepEqual(windowTotals(rows), { requests: 3, inputTokens: 1150, outputTokens: 230, cachedTokens: 40 })
assert.equal(windowTotals(rows, { from: nowMs - 3600_000 }).inputTokens, 150, 'the 2h-old request is outside a 1h window')
assert.deepEqual(windowModels(rows).map((row) => row.model), ['kimi-k3', 'glm-5.3-flash'])
assert.equal(hourKey(nowMs), '2026-10-18T04')
assert.equal(hourStart('2026-10-18T04'), nowMs - 30 * 60_000)

const dir = await mkdtemp(join(tmpdir(), 'dsh-oc-'))
const meterPath = join(dir, 'usage.json')
const meter = await openMeter({ path: meterPath, now: () => nowMs })
meter.record({ model: 'glm-5.3-flash', usage: { inputTokens: 10, outputTokens: 5 } })
assert.equal(meter.totals({ from: 0 }).inputTokens, 10)
await meter.flush()
const reopened = await openMeter({ path: meterPath, now: () => nowMs })
assert.equal(reopened.totals({ from: 0 }).outputTokens, 5, 'totals survive a restart')
await rm(dir, { recursive: true, force: true })

// --- Settings write guard ---------------------------------------------------

const post = (headers) => sameOriginPost({ method: 'POST', headers })
assert.equal(post({ origin: null }), true, 'Electron file:// pages send an opaque origin')
assert.equal(post({ origin: 'null' }), true)
assert.equal(post({ origin: 'file://' }), true)
assert.equal(post({}), true, 'a same-origin POST may omit Origin entirely')
assert.equal(post({ host: '127.0.0.1:8123', origin: 'http://127.0.0.1:8123' }), true)
assert.equal(post({ host: '127.0.0.1:8123', origin: 'http://evil.example' }), false)
assert.equal(post({ 'sec-fetch-site': 'cross-site', origin: 'null' }), false, 'cross-site is refused even from a file origin')
assert.equal(post({ host: '127.0.0.1:8123', origin: 'not a url' }), false)

// --- Provider-profile change detector --------------------------------------

assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true)
assert.equal(deepEqual({ a: 1 }, { a: 2 }), false)
assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), false, 'an added key is a change')

console.log('dsh-ollama-cloud smoke: ok')
