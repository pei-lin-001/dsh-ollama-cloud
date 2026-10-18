/**
 * dsh-ollama-cloud — browser half.
 *
 * Written directly in the loader's factory form (no bundler, no build step):
 * executing this file only registers the factory; the plugin body runs when the
 * shell materializes it. Everything it needs from the host arrives over the
 * same-origin routes the host half registers, so no Typert codegen is involved
 * and the API key never reaches the browser.
 *
 * Contributes:
 *   - a Settings section styled like the shipped settings pages (one CSS pass,
 *     design tokens with fallbacks so the older web runtime still renders)
 *   - a sidebar footer chip with the two quota bars
 */
window.__ModuleLoader__.load({
  id: 'dsh-ollama-cloud',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const Button = primitives.Button

    const ROUTES = {
      status: '/_dsh/ollama-cloud/status',
      usage: '/_dsh/ollama-cloud/usage',
      key: '/_dsh/ollama-cloud/key',
      sync: '/_dsh/ollama-cloud/sync',
      context: '/_dsh/ollama-cloud/context',
    }
    const USAGE_POLL_MS = 5 * 60 * 1000

    /** UI copy. Chinese-first: the harness locale differs per install. */
    const copy = {
      nav: 'Ollama Cloud',
      title: 'Ollama Cloud',
      keyLabel: 'API Key',
      connection: '连接',
      keyPlaceholder: '粘贴 ollama.com 的 API key',
      save: '保存并同步',
      saving: '同步中…',
      replace: '更新密钥',
      remove: '删除密钥',
      resync: '重新拉取模型',
      configured: '已配置',
      missing: '未配置',
      models: '个模型',
      lastSync: '上次同步',
      never: '从未',
      synced: '目录已同步',
      unchanged: '目录无变化',
      quota: '套餐额度',
      session: '会话',
      weekly: '每周',
      used: '已用',
      remaining: '剩余',
      resetting: '即将重置',
      minutesLater: '分钟后重置',
      hoursLater: '小时后重置',
      daysLater: '天后重置',
      unused: '额度信息不可用',
      requests: '次请求',
      inputTokens: '输入',
      cachedTokens: '缓存',
      outputTokens: '输出',
      thinking: '其中思考',
      cost: '费用',
      hourlyTitle: '最近 24 小时',
      dailyTitle: '近 7 天',
      hourlyUnit: '每小时请求数',
      dailyUnitRequests: '每日请求数',
      dailyUnitTokens: '每日 token',
      metricRequests: '请求',
      metricTokens: 'token',
      contextTitle: '模型上下文',
      contextModelLabel: '模型',
      contextWindowLabel: '上下文窗口',
      contextSave: '保存',
      contextReset: '恢复目录值',
      contextHint: '覆盖 /api/show 报告的上下文长度，保存后立即重新同步路由；恢复目录值即删除覆盖。',
      contextInvalid: '上下文长度必须是正整数。',
      contextSaved: '上下文已更新，路由已重新同步。',
      contextRestored: '已恢复目录值。',
      overridden: '已覆盖',
      catalogValue: '目录值',
      modelSection: '模型分布',
      modelName: '模型',
      noUsage: '配置 API key 后显示额度与用量。',
      updated: '更新于',
      purchased: '附加额度余额',
      refreshUsage: '刷新用量',
      loading: '加载中…',
      keySet: '密钥已保存，目录已更新。',
      keySetSyncFailed: '密钥已保存，但目录同步失败',
      syncFailed: '目录同步失败',
      keyRemoved: '密钥已删除。',
      chipTitle: 'Ollama Cloud 套餐额度（5h / 7d）',
      emptySeries: '暂无数据',
      peak: '峰值',
      total: '合计',
      today: '今天',
    }

    const t = (key) => copy[key] || key

    /** Design tokens of the shipped settings pages, with older-runtime fallbacks. */
    const css = `
.doc-section{max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px;font:inherit}
.doc-head{display:flex;align-items:flex-start;gap:12px}
.doc-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.doc-status{display:inline-flex;align-items:center;gap:6px;margin-left:auto;flex:none;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.doc-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary,#16a34a)}
.doc-dot[data-missing="true"]{background:var(--dsw-alias-state-error-primary,#dc2626)}
.doc-rows{display:flex;flex-direction:column;gap:12px}
.doc-card{border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,rgba(0,0,0,.12)));background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,transparent));border-radius:var(--dsw-radius-xl,14px);padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.doc-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.doc-card-title{font-size:13px;font-weight:500;line-height:20px}
.doc-card-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.doc-card-actions{margin-left:auto;display:inline-flex;gap:6px}
.doc-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.doc-field{display:flex;align-items:center;gap:10px;flex:1 1 100%}
.doc-input{flex:1 1 240px;box-sizing:border-box;height:36px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:var(--dsw-radius-md,10px);padding:0 10px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.doc-input:focus{border-color:var(--dsw-static-deepseek-450,var(--dsw-alias-brand-primary,#4d6bfe));box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,rgba(77,107,254,.25))}
.doc-input:disabled{opacity:.55;cursor:not-allowed}
.doc-field-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:64px;flex:none}
.doc-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.doc-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#dc2626)}
.doc-success{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary,#16a34a)}
.doc-sep{height:1px;background:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2,rgba(0,0,0,.08)));margin:2px 0}
.doc-quota{display:flex;flex-direction:column;gap:4px}
.doc-quota-line{display:flex;align-items:center;gap:12px;min-width:0}
.doc-quota-label{flex:0 0 86px;font-size:13px;line-height:20px}
.doc-quota-track{position:relative;flex:1 1 auto;min-width:0;height:10px;border-radius:999px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.14));box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3,rgba(0,0,0,.06))}
.doc-quota-fill{position:absolute;inset:0 auto 0 0;min-width:3px;border-radius:999px;transition:width 240ms ease}
.doc-quota-tick{position:absolute;top:0;bottom:0;width:1px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.75))}
.doc-quota-value{flex:0 0 88px;text-align:right;font-size:13px;line-height:20px;font-variant-numeric:tabular-nums}
.doc-quota-meta{align-self:flex-end;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));white-space:nowrap}
.doc-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.doc-stat{border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:var(--dsw-radius-md,10px);padding:8px 10px;display:flex;flex-direction:column;gap:2px}
.doc-stat-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.doc-stat-value{font-size:15px;line-height:22px;font-weight:500;font-variant-numeric:tabular-nums}
.doc-split{display:flex;height:8px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-border-l2,rgba(0,0,0,.08)))}
.doc-split-part{height:100%}
.doc-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.doc-legend-item{display:inline-flex;align-items:center;gap:6px}
.doc-swatch{width:8px;height:8px;border-radius:2px;flex:none}
.doc-chart{position:relative;height:64px;margin:2px 0 6px}
.doc-chart[data-weekly="true"]{height:72px}
.doc-chart svg{display:block;width:100%;height:100%;overflow:visible}
.doc-chart-line{fill:none}
.doc-chart-hit{fill:transparent}
.doc-chart-guide{stroke:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));stroke-width:1;opacity:0;pointer-events:none;transition:opacity 120ms ease}
.doc-chart-hit-group:hover .doc-chart-guide{opacity:.45}
.doc-axis{display:flex;justify-content:space-between;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.doc-axis-weekly{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));text-align:center}
.doc-table{display:flex;flex-direction:column;gap:2px}
.doc-table[data-compact="true"] .doc-table-head,.doc-table[data-compact="true"] .doc-table-row{grid-template-columns:minmax(0,1.6fr) 72px}
.doc-table-head,.doc-table-row{display:grid;grid-template-columns:minmax(0,1.5fr) 60px 88px 88px 68px;gap:10px;align-items:center;padding:6px 8px;border-radius:var(--dsw-radius-sm,8px)}
.doc-table-head{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.doc-table-row{font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.doc-table-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.doc-table-model{display:flex;align-items:center;gap:8px;min-width:0}
.doc-table-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doc-table-bar{position:relative;height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-border-l2,rgba(0,0,0,.08)));flex:1 1 40px;min-width:32px}
.doc-table-bar-fill{position:absolute;inset:0 auto 0 0;border-radius:999px;background:var(--dsw-static-deepseek-450,var(--dsw-alias-brand-primary,#4d6bfe))}
.doc-num{text-align:right;color:var(--dsw-alias-label-secondary)}
.doc-toggle{display:inline-flex;gap:2px;padding:2px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06)))}
.doc-toggle button{border:none;background:none;font:inherit;font-size:11px;line-height:16px;padding:2px 8px;border-radius:999px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.doc-toggle button[data-active="true"]{background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.doc-chip{display:flex;flex-direction:column;gap:5px;box-sizing:border-box;flex:1 1 100%;min-width:0;max-width:100%;font:inherit;font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));background:none;border:none;padding:2px 0 4px;cursor:default}
.doc-chip[data-wide="false"]{align-items:center;gap:4px}
.doc-chip-row{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;gap:6px;min-width:0}
.doc-chip[data-wide="false"] .doc-chip-row{grid-template-columns:minmax(0,1fr);gap:0}
.doc-chip-label{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.doc-chip-track{position:relative;display:block;height:6px;border-radius:999px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.14));box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3,rgba(0,0,0,.05));overflow:hidden}
.doc-chip[data-wide="false"] .doc-chip-track{height:4px;width:100%}
.doc-chip-fill{position:absolute;inset:0 auto 0 0;display:block;min-width:4px;border-radius:999px;transition:width 240ms ease}
.doc-chip-value{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
@media(max-width:560px){.doc-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.doc-quota-label{flex-basis:64px}.doc-quota-value{flex-basis:76px}.doc-table-head,.doc-table-row{grid-template-columns:minmax(0,1.4fr) 56px 80px 80px}.doc-table-head span:nth-child(5),.doc-table-row span:nth-child(5){display:none}}
`

    let styleInstalled = false
    function installStyles() {
      if (styleInstalled || typeof document === 'undefined') return
      const element = document.createElement('style')
      element.dataset.plugin = 'dsh-ollama-cloud'
      element.textContent = css
      document.head.appendChild(element)
      styleInstalled = true
    }

    // --- data helpers ---------------------------------------------------------

    /** Same-origin JSON call against the host half; throws the host's message. */
    async function call(path, options) {
      const response = await fetch(path, {
        credentials: 'same-origin',
        ...options,
        headers: { Accept: 'application/json', ...(options && options.body ? { 'Content-Type': 'application/json' } : {}) },
      })
      const body = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error((body && body.error && body.error.message) || `HTTP ${response.status}`)
      if (body && body.ok === false) throw new Error((body.error && body.error.message) || 'request failed')
      return body
    }

    /** 1234 -> "1.2k", 1200000 -> "1.2M"; undefined stays a dash. */
    const num = (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value < 1000) return String(Math.round(value))
      if (value < 1000000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`
      return `${(value / 1000000).toFixed(1)}M`
    }
    const clock = (value) => {
      const at = Date.parse(value)
      if (!Number.isFinite(at)) return ''
      return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
    const day = (value) => {
      const at = Date.parse(value)
      if (!Number.isFinite(at)) return ''
      return new Date(at).toLocaleDateString([], { month: 'numeric', day: 'numeric' })
    }
    /** Quota color: green until 60% used, amber to 80%, red beyond. */
    const quotaColor = (used) =>
      used >= 80
        ? 'var(--dsw-alias-state-error-primary,#dc2626)'
        : used >= 60
          ? 'var(--dsw-alias-state-warn-primary,#d97706)'
          : 'var(--dsw-alias-state-success-primary,#16a34a)'

    /** Reset countdown in the app's own phrasing. */
    function resetText(resetsAt) {
      const at = Date.parse(resetsAt)
      if (!Number.isFinite(at)) return ''
      const minutes = Math.max(0, Math.round((at - Date.now()) / 60000))
      if (minutes < 1) return t('resetting')
      if (minutes < 60) return `${minutes} ${t('minutesLater')}`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours} ${t('hoursLater')}`
      return `${Math.floor(hours / 24)} ${t('daysLater')}`
    }

    // --- presentational pieces ------------------------------------------------

    /** One quota row: a fixed-width line (label, track, used %) plus reset detail. */
    function QuotaRow(props) {
      // `window` is a global in the browser half: take it as `quota` locally.
      const { label, window: quota } = props
      if (quota === undefined || quota.usedPercent === undefined) {
        return h(
          'div',
          { className: 'doc-quota' },
          h(
            'div',
            { className: 'doc-quota-line' },
            h('span', { className: 'doc-quota-label' }, label),
            h('span', { className: 'doc-hint' }, t('unused')),
          ),
        )
      }
      const used = Math.min(Math.max(quota.usedPercent, 0), 100)
      return h(
        'div',
        { className: 'doc-quota' },
        h(
          'div',
          { className: 'doc-quota-line' },
          h('span', { className: 'doc-quota-label' }, label),
          h(
            'span',
            { className: 'doc-quota-track', title: `${t('used')} ${used}%` },
            h('span', { className: 'doc-quota-fill', style: { width: `${used}%`, background: quotaColor(used) } }),
            h('span', { className: 'doc-quota-tick', style: { left: '60%' } }),
            h('span', { className: 'doc-quota-tick', style: { left: '80%' } }),
          ),
          h('span', { className: 'doc-quota-value' }, `${t('used')} ${used}%`),
        ),
        h(
          'span',
          { className: 'doc-quota-meta' },
          typeof quota.remainingPercent === 'number' ? `${t('remaining')} ${quota.remainingPercent}%` : '',
          resetText(quota.resetsAt) === '' ? '' : ` · ${resetText(quota.resetsAt)}`,
        ),
      )
    }

    /**
     * Segmented token composition. The counts are disjoint: input excludes cache
     * reads, and output already includes reasoning, so the widths are taken over
     * all three rather than making the cache segment overflow the bar.
     */
    function TokenSplit(props) {
      const { window: quota } = props
      if (quota === undefined) return null
      const input = typeof quota.inputTokens === 'number' ? quota.inputTokens : undefined
      const cached = typeof quota.cachedTokens === 'number' ? quota.cachedTokens : undefined
      const output = typeof quota.outputTokens === 'number' ? quota.outputTokens : undefined
      const reasoning = typeof quota.reasoningTokens === 'number' ? quota.reasoningTokens : 0
      if (input === undefined && output === undefined) return null
      const total = Math.max((input ?? 0) + (cached ?? 0) + (output ?? 0), 1)
      const text = (part) =>
        part.key === 'outputTokens' && reasoning > 0
          ? `${t(part.key)} ${num(part.value)}（${t('thinking')} ${num(reasoning)}）`
          : `${t(part.key)} ${num(part.value)}`
      const parts = [
        { key: 'inputTokens', value: input, opacity: 0.35 },
        { key: 'cachedTokens', value: cached, opacity: 0.18 },
        { key: 'outputTokens', value: output, opacity: 1 },
      ].filter((part) => typeof part.value === 'number' && part.value > 0)
      if (parts.length === 0) return null
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h(
          'div',
          { className: 'doc-split' },
          ...parts.map((part) =>
            h('span', {
              key: part.key,
              className: 'doc-split-part',
              style: { width: `${(part.value / total) * 100}%`, background: 'var(--dsw-static-deepseek-450,var(--dsw-alias-brand-primary,#4d6bfe))', opacity: part.opacity },
              title: text(part),
            }),
          ),
        ),
        h(
          'div',
          { className: 'doc-legend' },
          ...parts.map((part) =>
            h(
              'span',
              { key: part.key, className: 'doc-legend-item' },
              h('span', { className: 'doc-swatch', style: { background: 'var(--dsw-static-deepseek-450,var(--dsw-alias-brand-primary,#4d6bfe))', opacity: part.opacity } }),
              text(part),
            ),
          ),
        ),
      )
    }

    // --- curve chart ----------------------------------------------------------

    const CURVE_WIDTH = 100
    const CURVE_HEIGHT = 100
    const CURVE_TOP = 6
    const round2 = (value) => Math.round(value * 100) / 100

    /** Evenly spaced points in the viewBox, scaled against the series peak. */
    function curvePoints(values, peak) {
      const count = values.length
      return values.map((value, index) => ({
        x: count === 1 ? CURVE_WIDTH / 2 : (index / (count - 1)) * CURVE_WIDTH,
        y: CURVE_HEIGHT - (Math.max(0, value) / peak) * (CURVE_HEIGHT - CURVE_TOP),
      }))
    }

    /** Catmull-Rom cubic segments; the caller supplies the leading `M`. */
    function curveSegments(points) {
      let d = ''
      for (let index = 0; index < points.length - 1; index++) {
        const before = points[index - 1] ?? points[index]
        const from = points[index]
        const to = points[index + 1]
        const after = points[index + 2] ?? to
        const c1x = from.x + (to.x - before.x) / 6
        const c1y = Math.min(CURVE_HEIGHT, Math.max(0, from.y + (to.y - before.y) / 6))
        const c2x = to.x - (after.x - from.x) / 6
        const c2y = Math.min(CURVE_HEIGHT, Math.max(0, to.y - (after.y - from.y) / 6))
        d += ` C${round2(c1x)},${round2(c1y)} ${round2(c2x)},${round2(c2y)} ${round2(to.x)},${round2(to.y)}`
      }
      return d
    }

    function linePath(points) {
      if (points.length === 0) return ''
      return `M${round2(points[0].x)},${round2(points[0].y)}${curveSegments(points)}`
    }

    function areaPath(points) {
      if (points.length === 0) return ''
      const first = points[0]
      const last = points[points.length - 1]
      return `M${round2(first.x)},${CURVE_HEIGHT} L${round2(first.x)},${round2(first.y)}${curveSegments(points)} L${round2(last.x)},${CURVE_HEIGHT} Z`
    }

    /** The band between two curves: upper forward, lower backward. */
    function bandPath(lower, upper) {
      if (lower.length === 0 || upper.length === 0) return ''
      const reversed = [...lower].reverse()
      return `${linePath(upper)} L${round2(reversed[0].x)},${round2(reversed[0].y)}${curveSegments(reversed)} Z`
    }

    /**
     * Smooth area chart. Points live in a 100x100 viewBox and the SVG stretches
     * to the container, so nothing needs measuring and it stays sharp on resize.
     * @param {{buckets: object[], weekly?: boolean, tokens?: boolean}} props
     */
    function CurveChart(props) {
      const { buckets } = props
      if (!Array.isArray(buckets) || buckets.length === 0) return h('span', { className: 'doc-hint' }, t('emptySeries'))
      // A legacy plan reports no tokens, so a token chart falls back to requests
      // instead of drawing a flat empty curve.
      const useTokens = props.tokens === true && buckets.some((bucket) => typeof bucket.inputTokens === 'number' || typeof bucket.outputTokens === 'number')
      const values = buckets.map((bucket) =>
        useTokens ? { input: bucket.inputTokens ?? 0, output: bucket.outputTokens ?? 0 } : { input: 0, output: bucket.requests ?? 0 },
      )
      const totals = values.map((value) => value.input + value.output)
      const peak = Math.max(1, ...totals)
      const totalPoints = curvePoints(totals, peak)
      const inputPoints = curvePoints(values.map((value) => value.input), peak)
      const fill = 'var(--dsw-static-deepseek-450,var(--dsw-alias-brand-primary,#4d6bfe))'
      const tooltip = (bucket, index) =>
        useTokens
          ? `${day(bucket.from)} · ${t('inputTokens')} ${num(values[index].input)} · ${t('outputTokens')} ${num(values[index].output)}`
          : `${clock(bucket.from)} · ${totals[index]} ${t('requests')}`
      return h(
        'div',
        { className: 'doc-chart', 'data-weekly': props.weekly === true ? 'true' : 'false', title: `${t('peak')} ${num(peak)}` },
        h(
          'svg',
          { viewBox: `0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`, preserveAspectRatio: 'none' },
          h('line', {
            key: 'baseline',
            x1: 0,
            y1: CURVE_HEIGHT,
            x2: CURVE_WIDTH,
            y2: CURVE_HEIGHT,
            stroke: 'var(--dsw-alias-border-l2,rgba(0,0,0,.12))',
            strokeWidth: 1,
            vectorEffect: 'non-scaling-stroke',
          }),
          useTokens
            ? h('path', { key: 'band', d: bandPath(inputPoints, totalPoints), fill, opacity: 0.55 })
            : h('path', { key: 'area', d: areaPath(totalPoints), fill, opacity: 0.18 }),
          useTokens ? h('path', { key: 'area', d: areaPath(inputPoints), fill, opacity: 0.25 }) : null,
          h('path', {
            key: 'line',
            className: 'doc-chart-line',
            d: linePath(totalPoints),
            stroke: fill,
            strokeWidth: 1.5,
            vectorEffect: 'non-scaling-stroke',
          }),
          ...buckets.map((bucket, index) => {
            const left = index === 0 ? 0 : (totalPoints[index - 1].x + totalPoints[index].x) / 2
            const right = index === buckets.length - 1 ? CURVE_WIDTH : (totalPoints[index].x + totalPoints[index + 1].x) / 2
            // A full-height column is the hit area, but the feedback a line
            // chart should give is a cursor line at the point, not a bar.
            return h(
              'g',
              { key: `hit-${bucket.from || index}`, className: 'doc-chart-hit-group' },
              h(
                'rect',
                {
                  className: 'doc-chart-hit',
                  x: round2(left),
                  y: 0,
                  width: round2(Math.max(0.5, right - left)),
                  height: CURVE_HEIGHT,
                },
                h('title', null, tooltip(bucket, index)),
              ),
              h('line', {
                className: 'doc-chart-guide',
                x1: round2(totalPoints[index].x),
                x2: round2(totalPoints[index].x),
                y1: 0,
                y2: CURVE_HEIGHT,
                vectorEffect: 'non-scaling-stroke',
              }),
            )
          }),
        ),
      )
    }

    /** "峰值 47" summary for a series, so a chart carries its own scale. */
    function peakNote(buckets, tokens) {
      if (!Array.isArray(buckets) || buckets.length === 0) return ''
      // Mirror the chart's own fallback: token columns exist only on a current plan.
      const hasTokens = buckets.some((bucket) => typeof bucket.inputTokens === 'number' || typeof bucket.outputTokens === 'number')
      const useTokens = tokens === true && hasTokens
      const values = buckets.map((bucket) => (useTokens ? (bucket.inputTokens ?? 0) + (bucket.outputTokens ?? 0) : (bucket.requests ?? 0)))
      const peak = Math.max(0, ...values)
      const total = values.reduce((sum, value) => sum + value, 0)
      return `${t('peak')} ${num(peak)} · ${t('total')} ${num(total)}`
    }

    /** Axis captions for a bucket series (hours for 24h, dates for a week). */
    function Axis(props) {
      const { buckets, weekly } = props
      if (!Array.isArray(buckets) || buckets.length === 0) return null
      if (weekly === true) {
        return h(
          'div',
          { className: 'doc-axis-weekly' },
          ...buckets.map((bucket, index) =>
            h('span', { key: bucket.from || index }, bucket.partial === true ? t('today') : day(bucket.from)),
          ),
        )
      }
      const first = buckets[0] && buckets[0].from
      const middle = buckets[Math.floor(buckets.length / 2)] && buckets[Math.floor(buckets.length / 2)].from
      const last = buckets[buckets.length - 1] && buckets[buckets.length - 1].from
      return h('div', { className: 'doc-axis' }, h('span', null, clock(first)), h('span', null, clock(middle)), h('span', null, clock(last)))
    }

    /** One headline number. */
    function Stat(props) {
      return h(
        'div',
        { className: 'doc-stat' },
        h('span', { className: 'doc-stat-label' }, props.label),
        h('span', { className: 'doc-stat-value' }, props.value),
      )
    }

    /** Per-model breakdown table with an inline magnitude bar. */
    function ModelTable(props) {
      const { models } = props
      if (!Array.isArray(models) || models.length === 0) return h('span', { className: 'doc-hint' }, t('emptySeries'))
      const rows = models.slice(0, 8)
      const peak = Math.max(1, ...rows.map((row) => row.requests ?? 0))
      // A legacy plan discloses nothing per model beyond request counts, so the
      // numeric columns it cannot fill are dropped instead of dotted with dashes.
      const compact = !rows.some((row) => typeof row.inputTokens === 'number' || typeof row.usd === 'number')
      return h(
        'div',
        { className: 'doc-table', 'data-compact': compact ? 'true' : 'false' },
        h(
          'div',
          { className: 'doc-table-head' },
          h('span', null, t('modelName')),
          h('span', { className: 'doc-num' }, t('requests')),
          compact ? null : h('span', { className: 'doc-num' }, t('inputTokens')),
          compact ? null : h('span', { className: 'doc-num' }, t('outputTokens')),
          compact ? null : h('span', { className: 'doc-num' }, t('cost')),
        ),
        ...rows.map((row) =>
          h(
            'div',
            { key: row.model, className: 'doc-table-row' },
            h(
              'span',
              { className: 'doc-table-model' },
              h('span', { className: 'doc-table-name', title: row.model }, row.model),
              h(
                'span',
                { className: 'doc-table-bar' },
                h('span', { className: 'doc-table-bar-fill', style: { width: `${((row.requests ?? 0) / peak) * 100}%` } }),
              ),
            ),
            h('span', { className: 'doc-num' }, String(row.requests ?? 0)),
            compact ? null : h('span', { className: 'doc-num' }, num(row.inputTokens)),
            compact ? null : h('span', { className: 'doc-num' }, num(row.outputTokens)),
            compact ? null : h('span', { className: 'doc-num' }, typeof row.usd === 'number' ? `$${row.usd.toFixed(3)}` : '—'),
          ),
        ),
      )
    }

    // --- settings section -----------------------------------------------------

    function SettingsSection() {
      installStyles()
      const [status, setStatus] = React.useState(undefined)
      const [usage, setUsage] = React.useState(undefined)
      const [keyDraft, setKeyDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)
      // Requests are the series every plan reports; tokens exist only for current plans.
      const [dailyMetric, setDailyMetric] = React.useState('requests')
      const [contextModel, setContextModel] = React.useState(undefined)
      const [contextDraft, setContextDraft] = React.useState('')

      const loadStatus = React.useCallback(async () => {
        try {
          const next = await call(ROUTES.status)
          setStatus(next)
          return next
        } catch (cause) {
          setError(cause.message)
          return undefined
        }
      }, [])
      const loadUsage = React.useCallback(async (force) => {
        try {
          const next = await call(`${ROUTES.usage}${force ? '?force=1' : ''}`)
          setUsage(next.ok ? next.usage : undefined)
          if (!next.ok && next.error) setError(next.error.message)
          return next
        } catch (cause) {
          setError(cause.message)
          return undefined
        }
      }, [])

      React.useEffect(() => {
        let live = true
        loadStatus().then((next) => {
          if (live && next && next.configured) loadUsage(false)
        })
        return () => {
          live = false
        }
      }, [loadStatus, loadUsage])

      const run = async (work) => {
        setBusy(true)
        setError(undefined)
        setNotice(undefined)
        try {
          await work()
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }
      /** Sync outcome of a write: a failed sync must never read as success. */
      const syncOf = (result) => (result && result.status && result.status.sync) || {}
      const syncError = (title, sync) => new Error(`${title}：${sync.message || sync.code || 'unknown'}`)
      const save = () =>
        run(async () => {
          const key = keyDraft.trim()
          if (key.length === 0) throw new Error(t('keyPlaceholder'))
          const result = await call(ROUTES.key, { method: 'POST', body: JSON.stringify({ key }) })
          setStatus(result.status)
          setKeyDraft('')
          const sync = syncOf(result)
          if (sync.ok !== true) throw syncError(t('keySetSyncFailed'), sync)
          setNotice(t('keySet'))
          await loadUsage(true)
        })
      const remove = () =>
        run(async () => {
          const result = await call(ROUTES.key, { method: 'POST', body: JSON.stringify({ remove: true }) })
          setStatus(result.status)
          setUsage(undefined)
          setNotice(t('keyRemoved'))
        })
      const resync = () =>
        run(async () => {
          const result = await call(ROUTES.sync, { method: 'POST', body: '{}' })
          setStatus(result.status)
          const sync = syncOf(result)
          if (sync.ok !== true) throw syncError(t('syncFailed'), sync)
          setNotice(sync.changed ? t('synced') : t('unchanged'))
        })
      const refreshUsage = () =>
        run(async () => {
          await loadUsage(true)
        })
      const chooseContextModel = (id) => {
        setContextModel(id)
        const entry = catalog.find((row) => row.id === id)
        setContextDraft(typeof entry?.contextWindow === 'number' ? String(entry.contextWindow) : '')
      }
      const saveContext = () =>
        run(async () => {
          const value = Number(contextDraft)
          if (!Number.isInteger(value) || value <= 0) throw new Error(t('contextInvalid'))
          const result = await call(ROUTES.context, { method: 'POST', body: JSON.stringify({ model: contextId, contextWindow: value }) })
          setStatus(result.status)
          const sync = syncOf(result)
          if (sync.ok !== true) throw syncError(t('syncFailed'), sync)
          setNotice(t('contextSaved'))
        })
      const resetContext = () =>
        run(async () => {
          const result = await call(ROUTES.context, { method: 'POST', body: JSON.stringify({ model: contextId, contextWindow: null }) })
          setStatus(result.status)
          const sync = syncOf(result)
          if (sync.ok !== true) throw syncError(t('syncFailed'), sync)
          setNotice(t('contextRestored'))
        })

      const catalog = (status && status.catalog) || []
      const contextId = catalog.some((row) => row.id === contextModel) ? contextModel : catalog[0]?.id
      const contextEntry = catalog.find((row) => row.id === contextId)
      // Follow the selected model's current value until the user starts typing.
      React.useEffect(() => {
        if (contextEntry === undefined) return
        setContextDraft(typeof contextEntry.contextWindow === 'number' ? String(contextEntry.contextWindow) : '')
      }, [contextId, contextEntry && contextEntry.contextWindow])

      const configured = status !== undefined && status.configured === true
      const sync = (status && status.sync) || {}
      const lastSync =
        sync.at === undefined || sync.at === 0
          ? t('never')
          : `${new Date(sync.at).toLocaleString()}${sync.ok === false ? ` — ${sync.message || sync.code}` : ''}`
      const balance = (usage && usage.balance) || {}
      const fiveHour = usage && usage.fiveHour
      const sevenDay = usage && usage.sevenDay
      const hourly = (usage && usage.hourly) || []
      const daily = (usage && usage.sevenDay && usage.sevenDay.buckets) || []
      const models =
        (usage && usage.sevenDay && usage.sevenDay.models) ||
        (usage && usage.local && usage.local.sevenDay && usage.local.sevenDay.models) ||
        []

      return h(
        'section',
        { className: 'doc-section', 'aria-label': t('title') },
        h(
          'div',
          { className: 'doc-head' },
          h('div', null, h('h2', { className: 'doc-title' }, t('title'))),
          h(
            'span',
            { className: 'doc-status' },
            h('span', { className: 'doc-dot', 'data-missing': configured ? 'false' : 'true' }),
            status === undefined ? t('loading') : configured ? `${t('configured')} · ${status.modelCount} ${t('models')}` : t('missing'),
          ),
        ),

        h(
          'div',
          { className: 'doc-rows' },
          h(
            'div',
            { className: 'doc-card' },
            h(
              'div',
              { className: 'doc-card-head' },
              h('span', { className: 'doc-card-title' }, t('connection')),
              configured
                ? h(
                    'span',
                    { className: 'doc-card-actions' },
                    h(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: resync, disabled: busy }, t('resync')),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'doc-field' },
              h('span', { className: 'doc-field-label' }, t('keyLabel')),
              h('input', {
                className: 'doc-input',
                type: 'password',
                value: keyDraft,
                placeholder: configured ? '••••••••••••' : t('keyPlaceholder'),
                autoComplete: 'off',
                spellCheck: false,
                disabled: busy,
                'aria-label': t('keyLabel'),
                onChange: (event) => setKeyDraft(event.target.value),
              }),
              h(Button, { type: 'button', size: 'sm', variant: 'primary', onClick: save, disabled: busy }, busy ? t('saving') : configured ? t('replace') : t('save')),
              configured ? h(Button, { type: 'button', size: 'sm', variant: 'ghost', onClick: remove, disabled: busy }, t('remove')) : null,
            ),
            h('div', { className: 'doc-row' }, h('span', { className: 'doc-hint' }, `${t('lastSync')}：${lastSync}`)),
            error ? h('p', { className: 'doc-error' }, error) : null,
            notice ? h('p', { className: 'doc-success' }, notice) : null,
          ),

          configured
            ? h(
                'div',
                { className: 'doc-card' },
                h(
                  'div',
                  { className: 'doc-card-head' },
                  h('span', { className: 'doc-card-title' }, t('quota')),
                  h(
                    'span',
                    { className: 'doc-card-actions' },
                    h(Button, { type: 'button', size: 'sm', variant: 'ghost', onClick: refreshUsage, disabled: busy }, t('refreshUsage')),
                  ),
                ),
                h(QuotaRow, { label: `${t('session')} · 5h`, window: balance.session }),
                h(QuotaRow, { label: `${t('weekly')} · 7d`, window: balance.weekly }),
                h('div', { className: 'doc-sep' }),
                h(
                  'div',
                  { className: 'doc-stats' },
                  h(Stat, { label: `5h ${t('requests')}`, value: num(fiveHour && fiveHour.requests) }),
                  h(Stat, { label: `5h ${t('inputTokens')}`, value: num(fiveHour && fiveHour.inputTokens) }),
                  h(Stat, { label: `5h ${t('outputTokens')}`, value: num(fiveHour && fiveHour.outputTokens) }),
                  h(Stat, { label: `7d ${t('requests')}`, value: num(sevenDay && sevenDay.requests) }),
                  h(Stat, { label: `7d ${t('inputTokens')}`, value: num(sevenDay && sevenDay.inputTokens) }),
                  h(Stat, { label: `7d ${t('outputTokens')}`, value: num(sevenDay && sevenDay.outputTokens) }),
                ),
                h(TokenSplit, { window: sevenDay }),
                balance.purchasedUsd !== undefined && balance.purchasedUsd > 0
                  ? h('p', { className: 'doc-hint' }, `${t('purchased')}：$${balance.purchasedUsd.toFixed(2)}`)
                  : null,
                usage && usage.fetchedAt
                  ? h('p', { className: 'doc-hint' }, `${t('updated')} ${clock(new Date(usage.fetchedAt).toISOString())}`)
                  : null,
              )
            : null,

          configured
            ? h(
                'div',
                { className: 'doc-card' },
                h(
                  'div',
                  { className: 'doc-card-head' },
                  h('span', { className: 'doc-card-title' }, t('hourlyTitle')),
                  h('span', { className: 'doc-card-note' }, t('hourlyUnit')),
                  h('span', { className: 'doc-card-note', style: { marginLeft: 'auto' } }, peakNote(hourly, false)),
                ),
                h(CurveChart, { buckets: hourly }),
                h(Axis, { buckets: hourly }),
                h('div', { className: 'doc-sep' }),
                h(
                  'div',
                  { className: 'doc-card-head' },
                  h('span', { className: 'doc-card-title' }, t('dailyTitle')),
                  h('span', { className: 'doc-card-note' }, dailyMetric === 'tokens' ? t('dailyUnitTokens') : t('dailyUnitRequests')),
                  h(
                    'span',
                    { className: 'doc-toggle', style: { marginLeft: 'auto' } },
                    h('button', { type: 'button', 'data-active': dailyMetric === 'requests' ? 'true' : 'false', onClick: () => setDailyMetric('requests') }, t('metricRequests')),
                    h('button', { type: 'button', 'data-active': dailyMetric === 'tokens' ? 'true' : 'false', onClick: () => setDailyMetric('tokens') }, t('metricTokens')),
                  ),
                  h('span', { className: 'doc-card-note' }, peakNote(daily, dailyMetric === 'tokens')),
                ),
                h(CurveChart, { buckets: daily, weekly: true, tokens: dailyMetric === 'tokens' }),
                h(Axis, { buckets: daily, weekly: true }),
              )
            : null,

          configured
            ? h(
                'div',
                { className: 'doc-card' },
                h(
                  'div',
                  { className: 'doc-card-head' },
                  h('span', { className: 'doc-card-title' }, t('contextTitle')),
                  contextEntry && contextEntry.overridden ? h('span', { className: 'doc-card-note' }, t('overridden')) : null,
                ),
                h(
                  'div',
                  { className: 'doc-field' },
                  h('span', { className: 'doc-field-label' }, t('contextModelLabel')),
                  h(
                    'select',
                    {
                      className: 'doc-input',
                      value: contextId ?? '',
                      disabled: busy || catalog.length === 0,
                      onChange: (event) => chooseContextModel(event.target.value),
                    },
                    ...catalog.map((row) => h('option', { key: row.id, value: row.id }, row.id)),
                  ),
                ),
                h(
                  'div',
                  { className: 'doc-field' },
                  h('span', { className: 'doc-field-label' }, t('contextWindowLabel')),
                  h('input', {
                    className: 'doc-input',
                    type: 'text',
                    inputMode: 'numeric',
                    value: contextDraft,
                    placeholder: '262144',
                    disabled: busy || catalog.length === 0,
                    onChange: (event) => setContextDraft(event.target.value),
                  }),
                  h(Button, { type: 'button', size: 'sm', variant: 'primary', onClick: saveContext, disabled: busy || contextId === undefined }, t('contextSave')),
                  contextEntry && contextEntry.overridden
                    ? h(Button, { type: 'button', size: 'sm', variant: 'ghost', onClick: resetContext, disabled: busy }, t('contextReset'))
                    : null,
                ),
                h('p', { className: 'doc-hint' }, t('contextHint')),
              )
            : null,

          configured
            ? h(
                'div',
                { className: 'doc-card' },
                h('div', { className: 'doc-card-head' }, h('span', { className: 'doc-card-title' }, t('modelSection'))),
                h(ModelTable, { models }),
              )
            : null,

          !configured && status !== undefined ? h('p', { className: 'doc-hint' }, t('noUsage')) : null,
        ),
      )
    }

    // --- sidebar chip ---------------------------------------------------------

    /** Compact footer chip: the two quota bars, hidden without a key. */
    function FooterChip(props) {
      installStyles()
      const [usage, setUsage] = React.useState(undefined)
      const [visible, setVisible] = React.useState(false)

      React.useEffect(() => {
        let live = true
        const load = async () => {
          try {
            const status = await call(ROUTES.status)
            if (!live) return
            setVisible(status.configured === true)
            if (status.configured !== true) {
              setUsage(undefined)
              return
            }
            const next = await call(ROUTES.usage)
            if (live && next.ok) setUsage(next.usage)
          } catch {
            if (live) setVisible(false)
          }
        }
        load()
        const timer = setInterval(load, USAGE_POLL_MS)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [])

      const balance = usage && usage.balance
      if (!visible || balance === undefined) return null
      // The sidebar hands footer registrants its `wide` flag; the rail has room
      // for two labelled rows, the collapsed rail only for the bars themselves.
      const wide = props.wide !== false
      const row = (label, quota) => {
        if (quota === undefined || quota.usedPercent === undefined) return null
        const used = Math.min(Math.max(quota.usedPercent, 0), 100)
        const detail = [
          `${label} ${t('used')} ${used}%`,
          typeof quota.remainingPercent === 'number' ? `${t('remaining')} ${quota.remainingPercent}%` : '',
          resetText(quota.resetsAt),
        ]
          .filter(Boolean)
          .join(' · ')
        return h(
          'span',
          { key: label, className: 'doc-chip-row', title: detail },
          wide ? h('span', { className: 'doc-chip-label' }, label) : null,
          h(
            'span',
            { className: 'doc-chip-track' },
            h('span', { className: 'doc-chip-fill', style: { width: `${used}%`, background: quotaColor(used) } }),
          ),
          wide ? h('span', { className: 'doc-chip-value' }, `${used}%`) : null,
        )
      }
      return h(
        'span',
        { className: 'doc-chip', 'data-wide': wide ? 'true' : 'false', title: t('chipTitle') },
        row('5h', balance.session),
        row('7d', balance.weekly),
      )
    }

    /** Plugin entry: the Settings section and the footer chip. */
    function apply(ctx) {
      installStyles()
      const slots = ctx.get('slots')
      if (slots === undefined) return
      ctx.effect(
        () =>
          slots.inject('settings.section', () =>
            slots.register({ name: 'settings.section', id: 'ollama-cloud', order: 46, label: () => t('nav') }, SettingsSection),
          ),
        'dsh-ollama-cloud: settings section',
      )
      ctx.effect(
        () =>
          slots.inject('sidebar.footer.action', () =>
            slots.register({ name: 'sidebar.footer.action', id: 'ollama-cloud-usage', order: 10 }, FooterChip),
          ),
        'dsh-ollama-cloud: footer chip',
      )
    }

    module.exports.apply = apply
    module.exports.inject = ['slots']
    return module.exports
  },
})
