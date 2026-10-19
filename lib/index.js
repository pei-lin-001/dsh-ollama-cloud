/**
 * dsh-ollama-cloud — Ollama Cloud for DeepSeek Harness.
 *
 * One API key is the whole setup: the Host half resolves it, pulls the live
 * Ollama Cloud catalog (`/v1/models` + one `/api/show` per model), and writes
 * the result as an `llm-pi-ai` provider profile so the existing adapter serves
 * chat, tools, thinking levels, and vision. Nothing here re-implements an LLM
 * adapter: `@deepseek-ai/dsh-llm-pi-ai` owns transport, and this plugin owns the
 * catalog, the credential, the hosted web tools, and usage.
 *
 * Surface:
 *   - settings namespace `ollama-cloud` (entry config is the base layer)
 *   - `llm-pi-ai` provider route `ollama-cloud` (written, not hand-authored)
 *   - tools `ollama_web_search` / `ollama_web_fetch`
 *   - Web routes under `/_dsh/ollama-cloud/*` for the client half
 *   - command `/ollama-cloud [status|sync|usage]`
 * @module dsh-ollama-cloud
 */
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openContextOverrides } from './context.js'
import { openMeter } from './meter.js'
import { CLOUD_BASE, fetchCatalog, fetchUsage, formatUsage, origin, webFetch, webSearch } from './ollama.js'

export const name = 'dsh-ollama-cloud'
export const inject = ['credentials', 'settings', 'llm']

/** Settings section owned by this plugin (its fields are the switches). */
export const SETTINGS_NAMESPACE = 'ollama-cloud'
/** Namespace of the pi-ai adapter that actually serves the route. */
const LLM_NAMESPACE = 'llm-pi-ai'

/** Browser-facing routes, same-origin with the Web application. */
export const ROUTES = {
  status: '/_dsh/ollama-cloud/status',
  usage: '/_dsh/ollama-cloud/usage',
  key: '/_dsh/ollama-cloud/key',
  sync: '/_dsh/ollama-cloud/sync',
  context: '/_dsh/ollama-cloud/context',
}

export const Config = z.object({
  provider: z.string().default('ollama-cloud'),
  displayName: z.string().default('Ollama Cloud'),
  apiKeyRef: z.string().default('OLLAMA_API_KEY'),
  baseURL: z.string().default(CLOUD_BASE),
  syncOnStart: z.boolean().default(true),
  includeNonToolModels: z.boolean().default(false),
  webTools: z.boolean().default(true),
  maxOutputChars: z.number().default(20000),
  usageCacheSeconds: z.number().default(120),
  /**
   * Base64 image payload one request may carry. Ollama Cloud's gateway rejects
   * a request by size before the model runs (roughly 12 MB observed), and every
   * history image is re-sent on every step. 6 MiB leaves room for the system
   * prompt, text history and tool schemas; 0 disables the budget.
   */
  maxRequestImageBytes: z.number().default(6 * 1024 * 1024),
})

/** Provider-schema field naming a route's per-request image budget. */
const IMAGE_BOUND_FIELD = 'maxRequestImageBytes'

/** Model-facing placeholder for an image the request budget could not carry. */
const IMAGE_OMITTED_TEXT = '[image omitted to fit the request size limit; ask the user to attach it again if needed]'

/**
 * The configured image budget, or undefined when the setting is disabled.
 * @param {any} cfg - resolved plugin settings
 * @returns {number|undefined}
 */
export function requestImageBudget(cfg) {
  const value = cfg?.maxRequestImageBytes
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/** Base64 length of an encoded byte count (0 for an absent or invalid size). */
export function base64Length(bytes) {
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? Math.ceil(bytes / 3) * 4 : 0
}

/**
 * Whether a serialized schemastery schema declares one object property. Tells a
 * runtime whose adapter honors {@link IMAGE_BOUND_FIELD} (0.2.x) from one with
 * no image bound at all (0.1.0-rc.x), where the plugin must trim requests.
 * @param {unknown} schema - `describe()` schema JSON
 * @param {string} name - property name to find
 * @param {Set<object>} [seen] - cycle guard
 * @returns {boolean}
 */
export function schemaDeclaresProperty(schema, name, seen = new Set()) {
  if (schema === null || typeof schema !== 'object' || seen.has(schema)) return false
  seen.add(schema)
  // schemastery's `toJSON()` is a ref graph whose object nodes keep their
  // fields under `dict`; a plain JSON-schema view would use `properties`.
  for (const map of [schema.dict, schema.properties]) {
    if (map !== null && typeof map === 'object' && Object.hasOwn(map, name)) return true
  }
  for (const value of Object.values(schema)) {
    if (value !== schema && schemaDeclaresProperty(value, name, seen)) return true
  }
  return false
}

/** Image blocks of one content tree, in request order (tool results included). */
function collectImageBlocks(blocks, out = []) {
  if (!Array.isArray(blocks)) return out
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'image') {
      if (block.offloaded !== true) out.push(block)
    } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
      collectImageBlocks(block.content, out)
    }
  }
  return out
}

/**
 * Replace dropped image blocks by identity, copying only the containers on a
 * path to one. Frozen messages from the session log stay untouched.
 */
function replaceDroppedImages(blocks, drop) {
  if (!Array.isArray(blocks)) return blocks
  let changed = false
  const next = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object') {
      if (block.type === 'image' && drop.has(block)) {
        next.push({ type: 'text', text: IMAGE_OMITTED_TEXT })
        changed = true
        continue
      }
      if (block.type === 'tool-result' && Array.isArray(block.content)) {
        const content = replaceDroppedImages(block.content, drop)
        if (content !== block.content) {
          next.push({ ...block, content })
          changed = true
          continue
        }
      }
    }
    next.push(block)
  }
  return changed ? next : blocks
}

/**
 * Drop the oldest images until the base64 payload fits `maxBytes`.
 *
 * This is the fallback for runtimes whose adapter has no image bound: the
 * 0.2.x adapter enforces the route budget itself and the harness records a
 * durable `image/offload` decision, which is preferable to an outgoing-only
 * rewrite. Messages are immutable and shared with the session, so nothing here
 * mutates them; only containers on the path to a dropped image are copied.
 * @param {readonly any[]} messages - request messages
 * @param {number} maxBytes - base64 budget
 * @returns {{messages: readonly any[], total: number, trimmed: number}}
 */
export function trimRequestImages(messages, maxBytes) {
  const list = Array.isArray(messages) ? messages : []
  const images = []
  for (const message of list) collectImageBlocks(message?.content, images)
  let total = 0
  for (const block of images) total += base64Length(block.attachment?.bytes)
  if (maxBytes === undefined || total <= maxBytes) return { messages: list, total, trimmed: 0 }
  const drop = new Set()
  let kept = total
  for (const block of images) {
    if (kept <= maxBytes) break
    drop.add(block)
    kept -= base64Length(block.attachment?.bytes)
  }
  const next = list.map((message) => {
    const content = replaceDroppedImages(message?.content, drop)
    return content === message?.content ? message : { ...message, content }
  })
  return { messages: next, total: kept, trimmed: drop.size }
}

/** Truncate tool output so one page cannot swallow the context window. */
function truncate(text, max) {
  if (typeof text !== 'string') return ''
  if (!Number.isInteger(max) || max <= 0 || text.length <= max) return text
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`
}

/** JSON body reader with a size cap, mirroring the shipped Web-backend posture. */
async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += part.length
    if (bytes > maxBytes) throw new RangeError(`request body exceeds ${maxBytes} bytes`)
    chunks.push(part)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Hostnames that only ever name this machine. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Whether a `Host` header names a machine rather than a domain.
 *
 * A browser cannot be made to send a state-changing request to this server by a
 * page on another site, because the page's `Origin` would not match. The one
 * exception is DNS rebinding: the attacker's *domain* resolves to `127.0.0.1`,
 * so the browser treats the request as same-origin and both `Origin` and `Host`
 * carry the attacker's domain. Requiring a loopback name or an IP literal —
 * which a rebinding attack cannot produce — closes that hole. A domain-based
 * reverse proxy in front of this port would be refused; the application binds
 * loopback and is reached by address, so that is the intended posture.
 * @param {string|undefined} host - raw `Host` header
 * @returns {boolean}
 */
export function localHost(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return isIP(bare) !== 0
}

/**
 * Refuse state-changing requests that did not come from the application's own
 * page. Electron serves the app over `file://`, where Chromium sends
 * `Origin: null` (or `file://`), so an opaque or file origin counts as the
 * app itself; anything else must name this very host. A cross-site fetch is
 * refused outright, and a `Host` that is not this machine is refused before
 * `Origin` is even consulted.
 */
export function sameOriginPost(req) {
  const host = req.headers.host
  if (!localHost(host)) return false
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite === 'cross-site') return false
  const requestOrigin = req.headers.origin
  if (typeof requestOrigin !== 'string' || requestOrigin.length === 0) return true
  if (requestOrigin === 'null' || requestOrigin.startsWith('file:')) return true
  try {
    const parsed = new URL(requestOrigin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}
function sendJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.writeHead(status)
  res.end(bytes)
}

/**
 * Structural equality over JSON-shaped data — the change detector for the
 * provider profile we are about to write.
 */
export function deepEqual(left, right) {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return false
    if (!deepEqual(left[key], right[key])) return false
  }
  return true
}

/**
 * Bind this plugin's own configuration to the settings service of the running
 * runtime. Two seams exist: the namespace-registration seam (`register` +
 * `get`, where the service owns the user layer) and the profile-entry seam
 * (0.2.x: the entry config *is* the section, and Cordis re-applies the plugin
 * when it changes). Feature-detected, so one build serves both.
 * @returns {{read: () => any, watch: (handler: (next: any, prev: any) => void) => unknown}}
 */
function installSettings(ctx, config) {
  const settings = ctx.settings
  if (typeof settings?.register === 'function' && typeof settings?.get === 'function') {
    const scope = settings.register(SETTINGS_NAMESPACE, Config, { base: config, applies: 'live' })
    return { read: () => scope.get(), watch: (handler) => scope.watch(handler) }
  }
  const value = Config(config ?? {})
  return { read: () => value, watch: () => () => {} }
}

/**
 * Read another plugin's settings section (the pi-ai adapter's `providers`).
 * `get(ns)` is the namespace seam; `describe()` is the profile-entry seam.
 * @returns {any} the section value, or undefined when that entry is absent
 */
function readSettingsSection(ctx, ns) {
  const settings = ctx.settings
  if (typeof settings?.get === 'function') return settings.get(ns)
  const descriptor = settings?.describe?.().find((row) => row.ns === ns)
  return descriptor?.value
}

/** The route fields this plugin writes; the adapter's schema owns the rest. */
const PROFILE_FIELDS = ['displayName', 'api', 'baseURL', 'apiKeyEnv', 'models', IMAGE_BOUND_FIELD]

/** Absent and empty modalities are the same claim: none declared. */
function modalities(value) {
  return Array.isArray(value) && value.length > 0 ? value : undefined
}

/**
 * One model entry, compared on the fields this plugin writes. The resolved
 * entry also carries `input: []` (materialized when no modalities are
 * declared) and `compat: {}`; neither may count as a change.
 */
function sameModel(current, next) {
  if (current === null || typeof current !== 'object') return false
  if (next === null || typeof next !== 'object') return false
  return (
    current.id === next.id &&
    current.name === next.name &&
    current.contextWindow === next.contextWindow &&
    deepEqual(modalities(current.input), modalities(next.input)) &&
    deepEqual(current.reasoningEfforts, next.reasoningEfforts)
  )
}

/** Whether two model lists describe the same catalog in the same order. */
function sameModels(current, next) {
  if (!Array.isArray(current) || !Array.isArray(next)) return false
  if (current.length !== next.length) return false
  return current.every((model, index) => sameModel(model, next[index]))
}

/**
 * Whether the live route already carries this profile.
 *
 * Only the fields this plugin writes are compared. The adapter's profile schema
 * materializes extras on every read — route defaults (`defaultContextWindow`,
 * `defaultMaxTokens`, `defaultInput`, `streamIdleTimeoutMs`) and per-model
 * `input: []` / `compat: {}` — so a strict comparison reported a change on
 * every sync and rewrote an unchanged route each time.
 * @param {any} current - the route as the settings service resolved it
 * @param {any} next - the profile about to be written
 * @returns {boolean}
 */
export function profileEqual(current, next) {
  if (current === null || typeof current !== 'object') return false
  if (next === null || typeof next !== 'object') return false
  return PROFILE_FIELDS.every((field) => {
    // A field the profile omits is one this runtime does not take (the image
    // bound on 0.1.0-rc.x); comparing it would rewrite the route every sync.
    if (next[field] === undefined) return true
    if (field === 'models') return sameModels(current[field], next[field])
    return deepEqual(current[field], next[field])
  })
}

/**
 * Routes this plugin wrote under an earlier `provider` name. Matched by the
 * profile fingerprint — display name, API, base URL, and credential reference —
 * so a hand-authored route with a different name or key is never touched.
 * Renaming `provider` used to leave the old route behind in the model selector.
 * @param {any} providers - the `llm-pi-ai` providers section
 * @param {string} current - the route about to be written
 * @param {any} profile - the profile about to be written
 * @returns {string[]} route names to unset
 */
export function staleRoutes(providers, current, profile) {
  if (providers === null || typeof providers !== 'object') return []
  return Object.keys(providers).filter((route) => {
    if (route === current) return false
    const entry = providers[route]
    if (entry === null || typeof entry !== 'object') return false
    return (
      entry.displayName === profile.displayName &&
      entry.api === profile.api &&
      entry.baseURL === profile.baseURL &&
      entry.apiKeyEnv === profile.apiKeyEnv
    )
  })
}

/** Overlay locally metered token fields onto a server window summary. */
export function withTokens(summary, local) {
  // No request from this harness inside the window means no token data to
  // add; leaving the fields absent keeps the UI from claiming a real zero.
  if (local === undefined || !(local.requests > 0)) return summary
  return {
    ...summary,
    inputTokens: summary?.inputTokens ?? local.inputTokens,
    cachedTokens: summary?.cachedTokens ?? local.cachedTokens,
    outputTokens: summary?.outputTokens ?? local.outputTokens,
    reasoningTokens: summary?.reasoningTokens ?? local.reasoningTokens,
    models: summary?.models !== undefined && summary.models.length > 0 ? summary.models : local.models,
  }
}

/**
 * Fold the locally metered tokens into a legacy-plan usage report.
 *
 * A legacy plan's `/api/usage` answers with request counts only, so this is
 * where its 5h/7d totals and both charts get token columns. The 24h chart maps
 * the hourly series onto the server's hourly buckets; the 7d chart aggregates
 * the *weekly* series by day — using the 24h series there (as this once did)
 * left every day older than yesterday without token columns.
 * @param {any} usage - normalized report from {@link fetchUsage}
 * @param {{fiveHour?: any, sevenDay?: any, hourly?: any[], week?: any[]}} local - meter output
 * @returns {any} the same usage object, updated in place
 */
export function overlayLocalTokens(usage, local) {
  if (usage === undefined || local === undefined) return usage
  usage.fiveHour = withTokens(usage.fiveHour, local.fiveHour)
  usage.sevenDay = withTokens(usage.sevenDay, local.sevenDay)
  // Charts follow the same rule: fill token columns from the meter hour by hour.
  const byHour = new Map((local.hourly ?? []).map((row) => [row.hour, row]))
  usage.hourly = (usage.hourly ?? []).map((bucket) => {
    const hour = typeof bucket.from === 'string' ? bucket.from.slice(0, 13) : undefined
    const counted = hour === undefined ? undefined : byHour.get(hour)
    return counted === undefined ? bucket : { ...bucket, inputTokens: counted.inputTokens, outputTokens: counted.outputTokens }
  })
  const byDay = new Map()
  for (const row of local.week ?? local.hourly ?? []) {
    const day = row.hour.slice(0, 10)
    const total = byDay.get(day) ?? { inputTokens: 0, outputTokens: 0 }
    total.inputTokens += row.inputTokens
    total.outputTokens += row.outputTokens
    byDay.set(day, total)
  }
  if (usage.sevenDay !== undefined) {
    usage.sevenDay.buckets = (usage.sevenDay.buckets ?? []).map((bucket) => {
      const counted = typeof bucket.from === 'string' ? byDay.get(bucket.from.slice(0, 10)) : undefined
      return counted === undefined ? bucket : { ...bucket, ...counted }
    })
  }
  return usage
}

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<z.infer<typeof Config>>} config - composition entry config.
 */
export function apply(ctx, config = {}) {
  const scope = installSettings(ctx, config)
  const settings = () => scope.read()

  /**
   * Whether the mounted adapter honors a route-level image bound. `undefined`
   * until its namespace is visible; later syncs and requests re-check instead of
   * guessing, because the answer decides between handing the budget to the
   * adapter (0.2.x) and trimming requests here (0.1.0-rc.x).
   */
  let imageBoundSupport
  function detectImageBound() {
    if (imageBoundSupport !== undefined) return imageBoundSupport
    if (typeof ctx.settings?.describe !== 'function') return undefined
    let descriptor
    try {
      descriptor = ctx.settings.describe().find((row) => row.ns === LLM_NAMESPACE)
    } catch {
      return undefined
    }
    if (descriptor === undefined) return undefined
    imageBoundSupport = schemaDeclaresProperty(descriptor.schema, IMAGE_BOUND_FIELD)
    return imageBoundSupport
  }

  /** Per-model contextWindow overrides, see lib/context.js. */
  const contextPath = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ollama-cloud-context.json')
  const contextStore = openContextOverrides({ path: contextPath() }).catch((error) => {
    ctx.logger.warn('dsh-ollama-cloud: context overrides unavailable: %s', error instanceof Error ? error.message : String(error))
    return undefined
  })

  /** Token accounting for this harness's own requests (see lib/meter.js). */
  const meterPath = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ollama-cloud-usage.json')
  let meter
  const meterReady = openMeter({ path: meterPath() })
    .then((opened) => {
      meter = opened
      return opened
    })
    .catch((error) => {
      ctx.logger.warn('dsh-ollama-cloud: token metering unavailable: %s', error instanceof Error ? error.message : String(error))
      return undefined
    })

  /** Log one local trim, at most once a minute for an unchanged count. */
  let lastTrimKey = ''
  let lastTrimAt = 0
  function noteImageTrim(options, count, budget) {
    const key = `${options.model ?? 'unknown'}:${count}`
    const now = Date.now()
    if (key === lastTrimKey && now - lastTrimAt < 60_000) return
    lastTrimKey = key
    lastTrimAt = now
    ctx.logger.warn(
      'dsh-ollama-cloud: omitted %d oldest image(s) to hold %s under %d bytes (this adapter has no image bound)',
      count,
      options.model ?? 'unknown',
      budget,
    )
  }

  /**
   * Intercept the llm service so requests are trimmed where the adapter has no
   * image bound of its own (0.1.0-rc.x).
   *
   * The agent loop deep-freezes the request it hands to the adapter, so an
   * `llm/stream` listener cannot substitute messages. The service entry point
   * is the last place that can: it receives the frozen request and passes a
   * cloned one on. The loop dispatches through `prepareCall()`, so both entry
   * points are wrapped.
   *
   * A clone is not in the loop's request WeakSet (`markAgentLoopRequest`), which
   * session-title consults before starting title work. Trimming only happens
   * once a session already exceeds the image budget, i.e. after the first
   * requests that would have started a title, so this costs nothing in practice.
   */
  const REQUEST_GUARD = Symbol.for('dsh-ollama-cloud/request-guard')
  function installRequestGuard() {
    const llm = ctx.llm
    if (llm === null || typeof llm !== 'object') return undefined
    if (typeof llm.stream !== 'function' || typeof llm.prepareCall !== 'function') return undefined
    if (llm[REQUEST_GUARD] !== undefined) return undefined
    const original = { stream: llm.stream, prepareCall: llm.prepareCall }
    const trim = (options) => {
      try {
        if (options?.provider !== settings().provider) return options
        if (detectImageBound() !== false) return options
        const budget = requestImageBudget(settings())
        if (budget === undefined) return options
        const trimmed = trimRequestImages(options.messages, budget)
        if (trimmed.trimmed === 0) return options
        noteImageTrim(options, trimmed.trimmed, budget)
        return { ...options, messages: trimmed.messages }
      } catch (error) {
        ctx.logger.warn('dsh-ollama-cloud: request image guard skipped: %s', String(error?.message ?? error))
        return options
      }
    }
    try {
      llm[REQUEST_GUARD] = original
      llm.stream = function stream(options) {
        return original.stream.call(this, trim(options))
      }
      llm.prepareCall = async function prepareCall(config, signal) {
        const prepared = await original.prepareCall.call(this, config, signal)
        if (prepared === null || typeof prepared !== 'object' || typeof prepared.stream !== 'function') return prepared
        return Object.freeze({
          ...prepared,
          stream: (options) => prepared.stream(trim(options)),
        })
      }
    } catch (error) {
      // A locked-down service must not take the plugin down with it.
      llm.stream = original.stream
      llm.prepareCall = original.prepareCall
      delete llm[REQUEST_GUARD]
      throw error
    }
    return () => {
      if (llm[REQUEST_GUARD] !== original) return
      llm.stream = original.stream
      llm.prepareCall = original.prepareCall
      delete llm[REQUEST_GUARD]
    }
  }
  let disposeRequestGuard
  try {
    disposeRequestGuard = installRequestGuard()
  } catch (error) {
    ctx.logger.warn('dsh-ollama-cloud: request image guard unavailable: %s', String(error?.message ?? error))
  }

  // Tap the usage chunk of every request this route serves. Ollama Cloud only
  // reports tokens for current plans, so this is what makes token statistics
  // exist for a legacy plan — and it counts the harness's own traffic only.
  ctx.on('llm/stream', (options, next) => {
    if (options?.provider !== settings().provider) return next()
    const source = next()
    return (async function* tap() {
      for await (const chunk of source) {
        if (chunk?.type === 'usage' && chunk.usage !== undefined) {
          const active = meter ?? (await meterReady)
          active?.record({
            model: typeof options.model === 'string' ? options.model : 'unknown',
            usage: chunk.usage,
          })
        }
        yield chunk
      }
    })()
  })

  /** Last catalog sync outcome, surfaced to the UI and the command. */
  const syncState = {
    at: 0,
    ok: false,
    code: undefined,
    message: undefined,
    route: undefined,
    models: 0,
    changed: false,
  }
  /** Last usage read, cached so a polling footer cannot hammer the endpoint. */
  const usageState = { at: 0, data: undefined, error: undefined }

  async function resolveKey() {
    const ref = settings().apiKeyRef
    if (typeof ref !== 'string' || ref.length === 0) return undefined
    const hit = await ctx.credentials.resolve(credentialRef(ref))
    return hit?.value
  }

  function recordSync(patch) {
    Object.assign(syncState, patch, { at: Date.now() })
    return syncState
  }

  /**
   * Pull the live catalog and write it as the pi-ai provider profile.
   * A no-op write (identical section) is skipped so the adapter is not churned.
   * @param {{reason?: string}} options
   */
  let inFlight
  function syncCatalog(options = {}) {
    if (inFlight !== undefined) return inFlight
    inFlight = runSync(options).finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  /** Run a sync that is guaranteed to see writes made just before it. */
  async function syncAfterCurrent(options = {}) {
    if (inFlight !== undefined) await inFlight.catch(() => {})
    return syncCatalog(options)
  }

  async function runSync({ reason = 'manual' } = {}) {
    const cfg = settings()
    const mounted = readSettingsSection(ctx, LLM_NAMESPACE)
    if (mounted === undefined) {
      return recordSync({
        ok: false,
        code: 'llm-pi-ai-absent',
        message: '当前合成中没有挂载 llm-pi-ai 设置项。',
        route: cfg.provider,
        models: 0,
        changed: false,
      })
    }
    try {
      const key = await resolveKey()
      if (key === undefined) {
        return recordSync({
          ok: false,
          code: 'no-key',
          message: `未配置凭据 ${cfg.apiKeyRef}。`,
          route: cfg.provider,
          models: 0,
          changed: false,
        })
      }
      const catalog = await fetchCatalog({
        base: cfg.baseURL,
        key,
        includeNonToolModels: cfg.includeNonToolModels,
      })
      // Settings-page overrides win over what `/api/show` reported.
      const overrides = (await contextStore)?.all() ?? {}
      const models = catalog.models.map((model) =>
        overrides[model.id] === undefined ? model : { ...model, contextWindow: overrides[model.id] },
      )
      const profile = {
        displayName: cfg.displayName,
        api: 'openai-completions',
        baseURL: `${origin(cfg.baseURL)}/v1`,
        apiKeyEnv: cfg.apiKeyRef,
        models,
      }
      // Only a runtime whose adapter declares the field can enforce it; writing
      // it elsewhere would be stored but never acted on.
      const budget = requestImageBudget(cfg)
      if (budget !== undefined && detectImageBound() === true) profile[IMAGE_BOUND_FIELD] = budget
      const current = mounted?.providers?.[cfg.provider]
      const stale = staleRoutes(mounted?.providers, cfg.provider, profile)
      const changed = !profileEqual(current, profile) || stale.length > 0
      if (changed) {
        const ops = [{ op: 'set', path: ['providers', cfg.provider], value: profile }]
        for (const route of stale) ops.push({ op: 'unset', path: ['providers', route] })
        await ctx.settings.mutate(LLM_NAMESPACE, ops)
        if (stale.length > 0) {
          ctx.logger.info('dsh-ollama-cloud: removed stale route(s) %s from a previous provider name', stale.join(', '))
          // A route supplied by a lower settings layer (the profile's entry
          // config) cannot be unset from the user layer; say so instead of
          // silently retrying on every sync.
          const remaining = staleRoutes(readSettingsSection(ctx, LLM_NAMESPACE)?.providers, cfg.provider, profile)
          if (remaining.length > 0) {
            ctx.logger.warn(
              'dsh-ollama-cloud: route(s) %s still resolve after removal — they come from a lower settings layer; delete them from that profile entry.',
              remaining.join(', '),
            )
          }
        }
      }
      if (catalog.failures.length > 0) {
        ctx.logger.warn(
          'dsh-ollama-cloud: %d model(s) could not describe themselves and were left out: %s',
          catalog.failures.length,
          catalog.failures.map((row) => row.id).join(', '),
        )
      }
      ctx.logger.info(
        'dsh-ollama-cloud: catalog synced (%s), %d of %d models registered on route %s%s',
        reason,
        catalog.models.length,
        catalog.total,
        cfg.provider,
        changed ? '' : ' — unchanged',
      )
      return recordSync({
        ok: true,
        code: undefined,
        message: undefined,
        route: cfg.provider,
        models: catalog.models.length,
        changed,
        skipped: catalog.skipped.length,
        failures: catalog.failures.length,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('dsh-ollama-cloud: catalog sync failed (%s): %s', reason, message)
      return recordSync({ ok: false, code: 'catalog-failed', message, route: cfg.provider, models: 0, changed: false })
    }
  }

  /**
   * Local token totals for the two quota windows. The balance reports when a
   * window resets, so the windows are anchored to those instants rather than to
   * a rolling clock, and a window that already reset (no data yet) reads zero.
   */
  async function localWindows(balance) {
    const active = meter ?? (await meterReady)
    const now = Date.now()
    const windowOf = (resetIso, spanMs) => {
      const end = typeof resetIso === 'string' ? Date.parse(resetIso) : Number.NaN
      if (!Number.isFinite(end)) return { from: now - spanMs, to: now }
      return { from: end - spanMs, to: now }
    }
    if (active === undefined) return { fiveHour: undefined, sevenDay: undefined, hourly: [], week: [] }
    const session = windowOf(balance?.session?.resetsAt, 5 * 3600_000)
    const weekly = windowOf(balance?.weekly?.resetsAt, 7 * 24 * 3600_000)
    return {
      fiveHour: { ...active.totals(session), models: active.models(session) },
      sevenDay: { ...active.totals(weekly), models: active.models(weekly) },
      // The 24h chart reads the hourly series; the 7d chart needs every day of
      // the weekly window, which is wider than the last 24 hours.
      hourly: active.series({ from: now - 24 * 3600_000, to: now }),
      week: active.series(weekly),
    }
  }

  /** Read usage, reusing a cached answer inside the configured window. */
  async function readUsage({ force = false } = {}) {
    const ttl = Math.max(0, settings().usageCacheSeconds) * 1000
    if (!force && usageState.data !== undefined && Date.now() - usageState.at < ttl) {
      return { ok: true, usage: usageState.data, fetchedAt: usageState.at }
    }
    try {
      const key = await resolveKey()
      if (key === undefined) {
        return { ok: false, error: { code: 'no-key', message: `未配置凭据 ${settings().apiKeyRef}。` } }
      }
      const usage = await fetchUsage({ base: settings().baseURL, key })
      const local = await localWindows(usage.balance)
      // A current plan reports tokens itself; a legacy plan does not, and the
      // local meter is then the only source of token counts.
      if (usage.tokenSource === 'legacy') overlayLocalTokens(usage, local)
      // The weekly series is only an input to the 7d chart, not a payload the
      // client renders, so it stays on the host.
      usage.local = { fiveHour: local.fiveHour, sevenDay: local.sevenDay, hourly: local.hourly }
      usageState.data = usage
      usageState.error = undefined
      usageState.at = Date.now()
      return { ok: true, usage, fetchedAt: usageState.at }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      usageState.error = message
      return { ok: false, error: { code: 'usage-failed', message } }
    }
  }

  /** The deployment default for fresh agents, when that service is mounted. */
  const defaultSelection = () => {
    try {
      return ctx.get('agentDefaultModel')?.currentSelection() ?? undefined
    } catch {
      return undefined
    }
  }

  /** Everything the client half renders, minus the secret. */
  async function status() {
    const cfg = settings()
    const key = await resolveKey()
    const section = readSettingsSection(ctx, LLM_NAMESPACE)?.providers?.[cfg.provider]
    const overrides = (await contextStore)?.all() ?? {}
    return {
      ok: true,
      configured: key !== undefined,
      provider: cfg.provider,
      displayName: cfg.displayName,
      keyRef: cfg.apiKeyRef,
      baseURL: `${origin(cfg.baseURL)}/v1`,
      registered: section !== undefined,
      modelCount: Array.isArray(section?.models) ? section.models.length : 0,
      models: Array.isArray(section?.models) ? section.models.map((row) => row.id) : [],
      catalog: Array.isArray(section?.models)
        ? section.models.map((row) => ({
            id: row.id,
            contextWindow: typeof row.contextWindow === 'number' ? row.contextWindow : null,
            overridden: overrides[row.id] !== undefined,
          }))
        : [],
      defaultModel: defaultSelection(),
      webTools: cfg.webTools,
      imageBudget: requestImageBudget(cfg) ?? null,
      imageBudgetSupported: detectImageBound() ?? null,
      routeImageBudget: typeof section?.[IMAGE_BOUND_FIELD] === 'number' ? section[IMAGE_BOUND_FIELD] : null,
      sync: { ...syncState },
      usageFetchedAt: usageState.at === 0 ? undefined : usageState.at,
      usageError: usageState.error,
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  // A stored key is the only setup step: sync on boot, and again whenever the
  // credential this plugin references changes (the settings UI writes one).
  if (settings().syncOnStart) void syncCatalog({ reason: 'startup' })

  ctx.on('credentials/updated', (ref) => {
    if (ref === settings().apiKeyRef) void syncCatalog({ reason: 'credential' })
  })

  scope.watch((next, previous) => {
    const reprofile =
      next.apiKeyRef !== previous.apiKeyRef ||
      next.baseURL !== previous.baseURL ||
      next.provider !== previous.provider ||
      next.includeNonToolModels !== previous.includeNonToolModels ||
      next.maxRequestImageBytes !== previous.maxRequestImageBytes
    if (reprofile) void syncCatalog({ reason: 'settings' })
  })

  // --- Hosted web tools ------------------------------------------------------

  ctx.inject(['tools'], (toolCtx) => {
    if (!settings().webTools) return
    const callKey = async () => {
      const key = await resolveKey()
      if (key === undefined) throw new Error(`Ollama Cloud web tools need a credential for ${settings().apiKeyRef}.`)
      return key
    }
    toolCtx.effect(
      () =>
        toolCtx.tools.register(
          defineTool({
            name: 'ollama_web_search',
            description:
              'Search the web through Ollama Cloud and return result titles, URLs, and content snippets. Use it for information newer than training data.',
            parameters: {
              query: { type: 'string', required: true, description: 'The search query.' },
              maxResults: {
                type: 'integer',
                description: 'How many results to return (default 8, max 20).',
              },
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  results: {
                    type: 'array',
                    required: true,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        title: { type: 'string' },
                        url: { type: 'string' },
                        snippet: { type: 'string' },
                      },
                    },
                  },
                },
              },
              render: (_args, value) => [
                {
                  type: 'text',
                  text:
                    value.results.length === 0
                      ? 'No results.'
                      : value.results
                          .map((row, index) => `${index + 1}. ${row.title || row.url}\n   ${row.url}\n   ${row.snippet}`)
                          .join('\n\n'),
                },
              ],
            },
            timeoutMs: 40000,
            isConcurrencySafe: () => true,
            async execute(args, exec) {
              const query = typeof args?.query === 'string' ? args.query.trim() : ''
              if (query.length === 0) throw new Error('query must be a non-empty string')
              const requested = Number(args?.maxResults)
              const maxResults = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 20) : 8
              const results = await webSearch({
                base: settings().baseURL,
                key: await callKey(),
                query,
                maxResults,
                signal: exec.signal,
              })
              return { results }
            },
          }),
        ),
      'dsh-ollama-cloud: ollama_web_search',
    )
    toolCtx.effect(
      () =>
        toolCtx.tools.register(
          defineTool({
            name: 'ollama_web_fetch',
            description:
              'Fetch one HTTP(S) page through Ollama Cloud and return its extracted text plus the links it contains.',
            parameters: {
              url: { type: 'string', required: true, description: 'Absolute HTTP(S) URL to fetch.' },
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  url: { type: 'string', required: true },
                  title: { type: 'string' },
                  content: { type: 'string' },
                  links: { type: 'array', items: { type: 'string' } },
                  truncated: { type: 'boolean' },
                },
              },
              render: (_args, value) => [
                {
                  type: 'text',
                  text: [`# ${value.title || value.url}`, value.url, '', value.content].join('\n'),
                },
              ],
            },
            timeoutMs: 40000,
            isConcurrencySafe: () => true,
            async execute(args, exec) {
              const url = typeof args?.url === 'string' ? args.url.trim() : ''
              if (!/^https?:\/\//i.test(url)) throw new Error('url must be an absolute HTTP(S) URL')
              const page = await webFetch({
                base: settings().baseURL,
                key: await callKey(),
                url,
                signal: exec.signal,
              })
              const content = truncate(page.content, settings().maxOutputChars)
              return {
                url,
                title: page.title,
                content,
                links: page.links.slice(0, 50),
                truncated: content !== page.content,
              }
            },
          }),
        ),
      'dsh-ollama-cloud: ollama_web_fetch',
    )
  })

  // --- Web routes for the client half ---------------------------------------

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = [
        webCtx.webServer.register({
          kind: 'exact',
          path: ROUTES.status,
          handler: async (req, res) => {
            if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: { code: 'method', message: '只接受 GET' } })
            try {
              sendJson(res, 200, await status())
            } catch (error) {
              sendJson(res, 500, { ok: false, error: { code: 'status', message: String(error?.message ?? error) } })
            }
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: ROUTES.usage,
          handler: async (req, res) => {
            if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: { code: 'method', message: '只接受 GET' } })
            try {
              const force = new URL(req.url ?? '/', 'http://localhost').searchParams.get('force') === '1'
              sendJson(res, 200, await readUsage({ force }))
            } catch (error) {
              sendJson(res, 500, { ok: false, error: { code: 'usage', message: String(error?.message ?? error) } })
            }
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: ROUTES.key,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'method', message: '只接受 POST' } })
            if (!sameOriginPost(req)) {
              return sendJson(res, 403, { ok: false, error: { code: 'origin', message: '已拒绝来自其他站点的写入' } })
            }
            try {
              const body = await readJsonBody(req)
              const ref = credentialRef(settings().apiKeyRef)
              if (body?.remove === true) {
                await ctx.credentials.unset(ref)
                return sendJson(res, 200, { ok: true, removed: true, status: await status() })
              }
              const key = typeof body?.key === 'string' ? body.key.trim() : ''
              if (!/^[\x21-\x7E]+$/.test(key)) {
                return sendJson(res, 400, {
                  ok: false,
                  error: { code: 'invalid-key', message: 'API key 必须是非空的可打印 ASCII 字符。' },
                })
              }
              await ctx.credentials.set(ref, key)
              await syncCatalog({ reason: 'key' })
              sendJson(res, 200, { ok: true, status: await status() })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: { code: 'key', message: String(error?.message ?? error) } })
            }
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: ROUTES.sync,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'method', message: '只接受 POST' } })
            if (!sameOriginPost(req)) {
              return sendJson(res, 403, { ok: false, error: { code: 'origin', message: '已拒绝来自其他站点的写入' } })
            }
            try {
              await syncCatalog({ reason: 'manual' })
              sendJson(res, 200, { ok: true, status: await status() })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: { code: 'sync', message: String(error?.message ?? error) } })
            }
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: ROUTES.context,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'method', message: '只接受 POST' } })
            if (!sameOriginPost(req)) {
              return sendJson(res, 403, { ok: false, error: { code: 'origin', message: '已拒绝来自其他站点的写入' } })
            }
            try {
              const body = await readJsonBody(req)
              const model = typeof body?.model === 'string' ? body.model.trim() : ''
              const section = readSettingsSection(ctx, LLM_NAMESPACE)?.providers?.[settings().provider]
              if (model.length === 0 || !Array.isArray(section?.models) || !section.models.some((row) => row.id === model)) {
                return sendJson(res, 400, { ok: false, error: { code: 'unknown-model', message: '未知的模型，先同步目录再设置。' } })
              }
              const store = await contextStore
              if (store === undefined) {
                return sendJson(res, 503, { ok: false, error: { code: 'context-store', message: '上下文覆盖文件不可用。' } })
              }
              if (body?.contextWindow === null) {
                await store.delete(model)
              } else {
                const value = Number(body?.contextWindow)
                if (!Number.isInteger(value) || value <= 0) {
                  return sendJson(res, 400, { ok: false, error: { code: 'invalid-context', message: '上下文长度必须是正整数。' } })
                }
                await store.set(model, value)
              }
              await syncAfterCurrent({ reason: 'context' })
              sendJson(res, 200, { ok: true, status: await status() })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: { code: 'context', message: String(error?.message ?? error) } })
            }
          },
        }),
      ]
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    }, 'dsh-ollama-cloud: web routes')
  })

  // --- Human command ---------------------------------------------------------

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(
      () =>
        commandCtx.commands.register({
          name: 'ollama-cloud',
          description: 'Ollama Cloud status, catalog sync, and 5h/7d usage',
          input: { hint: '[status|sync|usage]' },
          handler: async (invocation) => {
            const verb = invocation.rawInput.trim().toLowerCase() || 'usage'
            if (verb === 'sync') {
              const result = await syncCatalog({ reason: 'command' })
              return {
                kind: result.ok ? 'success' : 'error',
                text: result.ok
                  ? `Ollama Cloud 目录：路由 ${result.route} 共 ${result.models} 个模型${result.changed ? '（已更新）' : '（无变化）'}。`
                  : `Ollama Cloud 目录同步失败：${result.message}`,
              }
            }
            if (verb === 'status') {
              const current = await status()
              return {
                kind: 'success',
                text: [
                  `Ollama Cloud（${current.provider}）`,
                  `  密钥：${current.keyRef} ${current.configured ? '已配置' : '未配置'}`,
                  `  接口：${current.baseURL}`,
                  `  模型：${current.modelCount}${current.registered ? '' : '（尚未注册路由）'}`,
                  `  上次同步：${current.sync.at === 0 ? '从未' : new Date(current.sync.at).toLocaleString()}${
                    current.sync.ok ? '' : ` — ${current.sync.message ?? current.sync.code}`
                  }`,
                ].join('\n'),
              }
            }
            if (verb !== 'usage') {
              return { kind: 'error', text: `无法识别的参数“${verb}”。用法：/ollama-cloud [status|sync|usage]` }
            }
            const usage = await readUsage({ force: true })
            if (!usage.ok) return { kind: 'error', text: `读取 Ollama Cloud 用量失败：${usage.error.message}` }
            return { kind: 'success', text: formatUsage(usage.usage) }
          },
        }),
      'dsh-ollama-cloud: /ollama-cloud command',
    )
  })

  return () => {
    disposeRequestGuard?.()
    usageState.data = undefined
    void meter?.flush().catch(() => {})
  }
}
