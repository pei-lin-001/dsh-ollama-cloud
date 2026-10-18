# dsh-ollama-cloud

Ollama Cloud for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

Give it one API key. It pulls the live Ollama Cloud model catalog, writes it as an
`llm-pi-ai` provider route, exposes each model's real thinking levels, adds the hosted
web tools, and shows 5h/7d usage — no local Ollama server, no hand-written model list.

## What it does

| Capability | How |
|---|---|
| One-key setup | The key lives in the credentials service (`$DSH_HOME/.credentials.yaml`); the browser never sees it. Saving a key triggers the first catalog pull automatically. |
| Auto-pulled catalog | `GET /v1/models` + one `POST /api/show` per model, then written to the `llm-pi-ai` settings namespace as route `ollama-cloud`. Runs on boot, on credential change, and on demand. |
| Thinking levels | Per-model `reasoningEfforts` derived from each model's own `/api/show` `thinking.values`, so only the levels that model really accepts are offered (binary models get off + one level, `max`/`xhigh` models get both). |
| Chat, tools, vision | Served by `@deepseek-ai/dsh-llm-pi-ai` (`api: openai-completions`, `baseURL: https://ollama.com/v1`) — this plugin owns data, not transport. |
| Web tools | `ollama_web_search` and `ollama_web_fetch` call Ollama Cloud's hosted `/api/web_search` and `/api/web_fetch` with the same key. |
| Quota bars | `GET /api/balance` gives both quota windows the Ollama UI draws: `session` (5h) and `weekly` (7d), each with a remaining percentage and the moment it resets. Rendered as progress bars in Settings, as two labelled rows in the sidebar chip, and as text bars in `/ollama-cloud`. |
| Usage + tokens | `GET /api/usage?range=24h|7d&group_by=model`: request counts, per-model breakdown, and — on current plans — input/cached/output tokens and cost. A legacy plan reports request counts only, so the plugin meters this harness's own token usage locally (`llm/stream` → `usage` chunk) and aligns it to the same quota windows via each window's reset time. |
| UI | Settings → **Ollama Cloud** (key, status, last sync, re-pull, usage) plus a sidebar footer chip that refreshes every five minutes. |

## Install

```sh
dsh plugin --profile web add link:/path/to/dsh-ollama-cloud
dsh plugin --profile desktop add link:/path/to/dsh-ollama-cloud   # the desktop app's profile
```

Then start the profile (`dsh --profile web`), open **Settings → Ollama Cloud**, paste the
key from [ollama.com](https://ollama.com), and press **保存并同步**. The catalog lands in
`$DSH_HOME/settings.yaml` under `llm-pi-ai.providers.ollama-cloud` and the models appear in
the model picker immediately.

A published copy (a real directory in the profile's `node_modules`) needs nothing else. A
`link:` checkout resolves its peers from its own `node_modules`, so for development run
`scripts/link-peers.sh` once — it symlinks `schemastery`, `dsh-credentials`, `dsh-settings`,
and `dsh-tools` from the profile's hoisted `node_modules`.

## Configuration

Entry config is the base layer of the `ollama-cloud` settings section; the user layer
overrides it. Override in the profile's `cordis.patch.yml`:

```yaml
- id: ollama-cloud
  config:
    provider: ollama-cloud        # llm-pi-ai route name
    displayName: Ollama Cloud
    apiKeyRef: OLLAMA_API_KEY     # credential reference, never the secret
    baseURL: https://ollama.com
    syncOnStart: true             # pull the catalog on boot
    includeNonToolModels: false   # keep tool-less models out of the picker
    webTools: true                # register ollama_web_search / ollama_web_fetch
    maxOutputChars: 20000         # per ollama_web_fetch result
    usageCacheSeconds: 120        # /api/usage cache
```

The key can also come from the environment (`OLLAMA_API_KEY=...`), which the credentials
service layers above the file. Note that a process-environment value shadows the stored
one — the credentials seam refuses writes while it is shadowed.

## Surfaces

**Command** — `/ollama-cloud [status|sync|usage]` (default `usage`).

The UI copy is Chinese; the write routes accept the app's own page (Electron serves it over
`file://`, so an opaque or file origin counts as the app itself) and refuse any other origin.

**Web routes** (same-origin, used by the client half; safe to script):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/_dsh/ollama-cloud/status` | key configured?, route, model count, last sync |
| `GET` | `/_dsh/ollama-cloud/usage[?force=1]` | balance windows + usage + token totals (cached) |
| `POST` | `/_dsh/ollama-cloud/key` | `{ "key": "..." }` to store + sync, `{ "remove": true }` to delete |
| `POST` | `/_dsh/ollama-cloud/sync` | re-pull the catalog |

## Runtime compatibility

One build serves both settings seams the harness has shipped:

| Runtime | Settings seam | Behavior |
|---|---|---|
| `0.1.0-rc.x` | namespace registration (`ctx.settings.register`/`get`) | the plugin owns the `ollama-cloud` section; the adapter section is read via `get('llm-pi-ai')` |
| `0.2.x` (desktop app) | profile-entry forms (`describe`/`mutate`) | the entry config *is* the section; the adapter's `llm-pi-ai` entry is read from `describe()` and written through `mutate()` |

`engines.dsh: ">=0.1.0-rc.6 <1.0.0"` replaces the peer-range check, so both runtimes load
the bundle instead of skipping it as incompatible. Verified against `0.1.0-rc.6` (CLI) and
`0.2.1-rc.2` (the desktop app's bundled runtime): catalog sync, chat, web tools, Settings
section, and the footer chip.

## Usage display

The Settings section follows the harness settings pages (same card, type and spacing
tokens), and reads top to bottom as one story: **connection → quota → trend → per model**.

| Block | Contents | Chart |
|---|---|---|
| 连接 | key field, endpoint tag, last sync, re-pull | — |
| 套餐额度 | both quota windows with used %, remaining % and the reset countdown | horizontal bar per window, with ticks at the 60%/80% warn thresholds, colored by usage |
| 用量统计 | six tiles: 5h/7d × requests / input / output | segmented bar of the 7d token split (input · cached · output) with a legend |
| 最近 24 小时 / 近 7 天 | per-hour requests, per-day tokens | column charts drawn with flex boxes (crisp text, container-width responsive), zero hours kept as a baseline, peak/total caption in the header |
| 模型分布 | top models with magnitude | table with an inline bar per model; token and cost columns appear only when the plan discloses them |

Chart colors come from the DeepSeek brand token (`--dsw-static-deepseek-450`) so bars read
the same in light and dark themes; quota bars use the state tokens (green → amber → red).
Every token has a literal fallback, so the older web runtime renders the same structure
with slightly plainer colors.

The sidebar footer shows the same two windows as two labelled rows (`5h ▕██░░░░▏ 4.5%`), each
bar colored by its own usage; the sidebar's collapsed rail only has room for the bars, so the
labels and numbers drop out there. Every row carries the full used / remaining / reset detail
in its tooltip.

The section deliberately carries no prose: labels, numbers, charts and tooltips only.

Data sources, in the order they win:

1. `GET /api/balance` — the two quota windows (server truth).
2. `GET /api/usage?range=24h|7d&group_by=model` — requests, buckets, per-model rows, and
   tokens/cost on a current plan.
3. The local meter — tokens only, when the plan is legacy (see below).

```
会话 · 5h   [██░░░░░░░░░░░░░░░░░░]  已用 3.9%     剩余 96.1% · 4 小时后重置
每周 · 7d   [██░░░░░░░░░░░░░░░░░░]  已用 5.8%     剩余 94.2% · 19 小时后重置
────────────────────────────────────────────────────────────
5h 次请求 144  5h 输入 —  5h 输出 —  7d 次请求 1.1k  7d 输入 —  7d 输出 —
最近 24 小时  每小时请求数                          峰值 284 · 合计 448
近 7 天       每日 token                            峰值 556 · 合计 1.1k
模型分布      deepseek-v4.1-flash 648 ▇▇▇▇▇▇▇▇ · glm-5.3-flash 22 ▏
```

The endpoint allows 10 requests/minute per user; one refresh is three calls, so answers are
cached (`usageCacheSeconds`, default 120) and the sidebar chip polls every five minutes. The
client bundle is served from a boot-graph hash, so a UI change needs a dsh restart.

## Known limits

- **No hard output cap.** pi-ai's compatibility detection picks `max_completion_tokens`,
  which Ollama ignores (it honors `max_tokens`); `dsh-llm-pi-ai` exposes only
  `compat.thinkingFormat` and `compat.supportsReasoningEffort`, so the plugin cannot correct
  the field. Requests work; `maxTokens` is advisory only.
- **Tokens depend on the plan.** A legacy plan returns request counts only from
  `/api/usage`; the local meter covers this harness's own traffic, not other clients.
- **Local metering is per harness home.** The meter file follows `DSH_HOME`, so two homes
  keep two ledgers, and hourly buckets mean a window edge can be off by up to an hour.
- **Sync owns the route.** Every sync rewrites `llm-pi-ai.providers.ollama-cloud` wholesale,
  so hand edits to that route (its models, levels) are replaced on the next pull. Set
  `syncOnStart: false` and sync by hand if you want to keep local tweaks.
- `webTools` and `includeNonToolModels` are read when tools are registered; changing them
  needs a restart.

## Development

```sh
node test/smoke.mjs    # pure-function checks: mapping, thinking levels, usage math
```

No build step: the client half is written directly in the loader's factory form
(`window.__ModuleLoader__.load({ id, factory })`), and the host half is plain ESM.

Testing against the desktop app core runtime (its core is newer than the Homebrew CLI):

```sh
APP="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
ELECTRON_RUN_AS_NODE=1 DSH_HOME=/tmp/probe "$APP" --expose-internals "$CLI" --profile web --port 8130 --no-open
```

The `desktop` profile itself is bootable only by the Electron app, so it is exercised through
the composition it shares with `web` (`dsh-base` + `dsh-web-app`).
