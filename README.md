# dsh-ollama-cloud

Ollama Cloud for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — one API key, no local Ollama server.

**[English](#english) · [中文](#中文)**

![Main window: quota chip in the sidebar](docs/ui-main.png)

---

## English

One API key is the whole setup. The plugin pulls the live Ollama Cloud catalog, registers it as an
`llm-pi-ai` provider route with each model's real thinking levels, adds the hosted web tools, and
shows plan quota plus token usage in the harness UI.

### Features

| | |
|---|---|
| **One-key setup** | The key lives in the credentials service (`$DSH_HOME/.credentials.yaml`); the browser never sees it. Saving a key triggers the first catalog pull. |
| **Auto-pulled catalog** | `GET /v1/models` plus one `POST /api/show` per model, written into the `llm-pi-ai` settings namespace as route `ollama-cloud`. Runs on boot, on credential change, on demand. |
| **Real thinking levels** | Per-model `reasoningEfforts` derived from the model's own `/api/show` `thinking.values`, so only levels that model accepts are offered. |
| **Chat, tools, vision** | Served by `@deepseek-ai/dsh-llm-pi-ai` (`api: openai-completions`, `baseURL: https://ollama.com/v1`). This plugin owns data, not transport. |
| **Hosted web tools** | `ollama_web_search` and `ollama_web_fetch` call Ollama Cloud's `/api/web_search` and `/api/web_fetch` with the same key. |
| **Quota bars** | `GET /api/balance` gives the two windows the Ollama UI draws — 5h session and 7d weekly — each with a remaining percentage and reset time. |
| **Usage and tokens** | Requests, per-model breakdown, and tokens/cost from `/api/usage`; where the plan hides tokens, a local meter fills them in. |
| **Chinese UI** | Settings section, sidebar chip and command output are Chinese; tool descriptions stay English because they steer the model. |

### Install

```sh
# the desktop app's profile and/or the web profile
dsh plugin --profile desktop add git:github.com/pei-lin-001/dsh-ollama-cloud
dsh plugin --profile web add git:github.com/pei-lin-001/dsh-ollama-cloud
```

Start the profile, open **Settings → Ollama Cloud**, paste the key from
[ollama.com/settings/keys](https://ollama.com/settings/keys), press **保存并同步**. The catalog lands
in the profile patch under `llm-pi-ai.providers.ollama-cloud` and the models appear in the picker
immediately. `OLLAMA_API_KEY` in the environment also works; a process-environment value shadows the
stored one and the credentials seam then refuses writes.

**Development checkout** (`link:` instead of `git:`) — a linked package resolves peers from its own
`node_modules`:

```sh
git clone git@github.com:pei-lin-001/dsh-ollama-cloud.git ~/Dev/dsh-ollama-cloud
cd ~/Dev/dsh-ollama-cloud && dsh plugin --profile web add link:$PWD
./scripts/link-peers.sh          # symlinks schemastery, dsh-credentials, dsh-settings, dsh-tools
```

### The UI

The Settings section follows the harness settings pages (same card, type and spacing tokens) and
reads top to bottom as one story: **connection → quota → trend → per model**. No prose, only labels,
numbers, charts and tooltips.

![Settings: connection and plan quota](docs/ui-settings-quota.png)

Two horizontal bars, one per window, with ticks at the 60% / 80% warn thresholds and colors that
follow usage (green → amber → red). Each row carries used %, remaining % and the reset countdown.
Below them six tiles put the numbers behind the bars — requests plus input/output tokens for both
windows — and a segmented bar shows the 7d token split.

![Settings: usage charts and per-model table](docs/ui-settings-usage.png)

Column charts drawn with flex boxes (crisp labels, container-width responsive), zero hours kept as a
baseline, peak/total caption in each header. The 24h chart is always per-hour requests; the 7d chart
toggles between **请求** and **token** because requests are the series every plan reports. The
per-model table keeps magnitude bars and drops its token/cost columns when the plan hides them.

The sidebar footer carries the same two windows as two labelled rows; in the collapsed rail the
labels and numbers drop out and only the bars remain. Full used / remaining / reset detail is in each
row's tooltip.

### How it works

**Catalog.** `/v1/models` lists ids; one `/api/show` per id yields `capabilities`
(`tools` / `thinking` / `vision`), `<arch>.context_length`, and `thinking.values`. Models without
`tools` are skipped unless `includeNonToolModels` is on. The result replaces the route's model list
whole, and an identical section is not rewritten (no churn for the adapter).

**Thinking levels.** `thinking.values` is what the model accepts: `false` becomes `off: 'none'`
(sending nothing would fall back to the model default, usually thinking *on*), `true` becomes one
`medium` level, graded names map one-to-one — a model advertising both `xhigh` and `max` offers both.

**Tokens.** `/api/usage` reports tokens and cost only on a current plan; a legacy plan returns request
counts alone. The plugin taps the `usage` chunk every request already emits (`llm/stream`),
accumulates input/cached/output per model in hourly buckets, keeps 30 days in
`$DSH_HOME/ollama-cloud-usage.json` (debounced atomic write, `0600`), and anchors those totals to the
windows the balance reports via each window's reset time. Traffic from other clients is invisible to
that meter, which is why server numbers win whenever they exist.

### Configuration

Entry config is the `ollama-cloud` settings section; override it in the profile patch:

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
    usageCacheSeconds: 120        # /api/balance + /api/usage cache
```

### Surfaces

**Command** — `/ollama-cloud [status|sync|usage]` (default `usage`), plain text for any client:

```
Ollama Cloud 用量：
  会话（5h） ▕█░░░░░░░░░▏ 已用 7.2% · 3 小时后重置
  每周（7d） ▕█░░░░░░░░░▏ 已用 6.4% · 18 小时后重置
  5h 统计：267 次请求 · 输入 8.9k · 输出 127
  7d 统计：1.2k 次请求 · 输入 8.9k · 输出 127
```

**Web routes** (same-origin, used by the client half; scriptable):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/_dsh/ollama-cloud/status` | key configured?, route, model count, last sync |
| `GET` | `/_dsh/ollama-cloud/usage[?force=1]` | balance windows + usage + token totals (cached) |
| `POST` | `/_dsh/ollama-cloud/key` | `{ "key": "…" }` stores and syncs, `{ "remove": true }` deletes |
| `POST` | `/_dsh/ollama-cloud/sync` | re-pull the catalog |

Writes are accepted from the app's own page only (Electron serves it over `file://`, so an opaque or
file origin counts as the app itself) and refused for any other origin.

### API coverage

Everything an API key can reach on `ollama.com` that a coding harness can use:

| Endpoint | Used by |
|---|---|
| `POST /v1/chat/completions` | chat, tools, thinking, vision (via `dsh-llm-pi-ai`) |
| `GET /v1/models`, `POST /api/show` | catalog sync |
| `POST /api/web_search`, `POST /api/web_fetch` | the two tools |
| `GET /api/usage`, `GET /api/balance` | quota bars, usage charts, command |

Deliberately unused: native `/api/chat` / `/api/generate`, Anthropic `/v1/messages` and
`/v1/responses` (same capability, another wire the harness does not speak), `/api/tags` detail fields
(no display slot in a dsh model entry). Not reachable on cloud at all: `/api/ps`, `/api/embed`,
`/api/systemone`, `/api/version` (placeholder), and local model management
(`create`/`copy`/`pull`/`push`/`delete`) — those answer `401` for an API key.

### Runtime compatibility

One build serves both settings seams the harness has shipped:

| Runtime | Settings seam | Behavior |
|---|---|---|
| `0.1.0-rc.x` | namespace registration (`ctx.settings.register`/`get`) | the plugin owns the `ollama-cloud` section; the adapter section is read via `get('llm-pi-ai')` |
| `0.2.x` (desktop app) | profile-entry forms (`describe`/`mutate`) | the entry config *is* the section; the adapter's `llm-pi-ai` entry is read from `describe()` and written through `mutate()` |

`engines.dsh: ">=0.1.0-rc.6 <1.0.0"` replaces the peer-range check, so both runtimes load the bundle
instead of skipping it as incompatible. Verified against `0.1.0-rc.6` (CLI) and `0.2.1-rc.2` (the
desktop app's bundled runtime). CSS tokens carry literal fallbacks so the older runtime renders the
same structure with plainer colors.

### Known limits

- **No hard output cap.** pi-ai's compatibility detection sends `max_completion_tokens`, which Ollama
  ignores (it honors `max_tokens`); `dsh-llm-pi-ai` exposes only `compat.thinkingFormat` and
  `compat.supportsReasoningEffort`, so the field cannot be corrected from here.
- **Local metering is per harness home.** Another machine or client does not appear in the token
  totals, and hourly buckets mean a window edge can be off by up to an hour.
- **Sync owns the route.** Every sync rewrites `llm-pi-ai.providers.ollama-cloud` whole, so hand edits
  to that route are replaced; set `syncOnStart: false` to sync by hand.
- `webTools` and `includeNonToolModels` are read when tools are registered; changing them needs a
  restart. The client bundle is served from a boot-graph hash, so UI changes also need a restart.
- The usage endpoint allows 10 requests/minute per user; one refresh is three calls, hence the cache
  and the five-minute sidebar poll.

### Development

```sh
node test/smoke.mjs      # catalog mapping, thinking levels, usage math, meter, write guard
```

No build step: the host half is plain ESM, the client half is written directly in the loader's factory
form (`window.__ModuleLoader__.load({ id, factory })`).

Testing against the desktop app's own runtime (its core is newer than the Homebrew CLI):

```sh
APP="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
CLI="$APP/../Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
ELECTRON_RUN_AS_NODE=1 DSH_HOME=/tmp/probe "$APP" --expose-internals "$CLI" --profile web --port 8130 --no-open
```

The `desktop` profile itself is bootable only by the Electron app, so it is exercised through the
composition it shares with `web` (`dsh-base` + `dsh-web-app`).

License: MIT.

---

## 中文

只需一个 API key。插件会拉取 Ollama Cloud 的实时模型目录，写入 `llm-pi-ai` 的 `ollama-cloud`
路由（含每个模型真实的思考等级），注册云端联网工具，并在界面里展示套餐额度与 token 用量。

### 能力

| | |
|---|---|
| **一次性配置** | key 存在凭据服务里（`$DSH_HOME/.credentials.yaml`），浏览器永远拿不到明文；保存 key 即触发首次目录拉取。 |
| **目录自动拉取** | `GET /v1/models` + 逐模型 `POST /api/show`，写入 `llm-pi-ai` 设置项的 `ollama-cloud` 路由。启动时、凭据变更时、手动触发时各跑一次。 |
| **真实思考等级** | 每个模型的 `reasoningEfforts` 来自它自己的 `/api/show` → `thinking.values`，只提供该模型真正接受的档位。 |
| **对话 / 工具 / 视觉** | 由 `@deepseek-ai/dsh-llm-pi-ai` 承载（`api: openai-completions`，`baseURL: https://ollama.com/v1`）。本插件只负责数据，不重复造传输层。 |
| **云端联网工具** | `ollama_web_search`、`ollama_web_fetch`，用同一把 key 调云端 `/api/web_search`、`/api/web_fetch`。 |
| **额度进度条** | `GET /api/balance` 给出与 ollama.com 官方用量页一致的两个窗口——5h 会话与 7d 每周——各带剩余百分比和重置时刻。 |
| **用量与 token** | 请求数、模型分布、token 与费用取自 `/api/usage`；套餐不返回 token 时由本机计量补全。 |
| **中文界面** | 设置页、侧栏额度条、命令输出均为中文；工具描述保持英文（它们用于驱动模型）。 |

### 安装

```sh
# 桌面版 profile 和/或 web profile
dsh plugin --profile desktop add git:github.com/pei-lin-001/dsh-ollama-cloud
dsh plugin --profile web add git:github.com/pei-lin-001/dsh-ollama-cloud
```

启动 profile，打开 **设置 → Ollama Cloud**，粘贴 [ollama.com/settings/keys](https://ollama.com/settings/keys)
的 key，点 **保存并同步**。目录会写进 profile patch 的 `llm-pi-ai.providers.ollama-cloud`，模型立刻
出现在模型选择器里。也可以用环境变量 `OLLAMA_API_KEY`；进程环境变量会遮蔽已保存的 key，此时凭据
服务会拒绝写入。

**开发用 `link:` 方式**（需要让被链接的包能找到同版本的 peer）：

```sh
git clone git@github.com:pei-lin-001/dsh-ollama-cloud.git ~/Dev/dsh-ollama-cloud
cd ~/Dev/dsh-ollama-cloud && dsh plugin --profile web add link:$PWD
./scripts/link-peers.sh          # 软链 schemastery、dsh-credentials、dsh-settings、dsh-tools
```

### 界面

设置页沿用官方设置页的设计语言（同一套卡片、字号、间距 token），自上而下一条叙事：**连接 → 额度 →
趋势 → 模型**。没有多余说明文字，只有标签、数字、图表和 tooltip。

![设置页：连接与套餐额度](docs/ui-settings-quota.png)

两条横向进度条，一条一个窗口，60% / 80% 处有告警刻度，颜色随使用量变化（绿 → 琥珀 → 红）；每行还
带已用百分比、剩余百分比和重置倒计时。下方六个数字块把条形背后的数据摊开——两个窗口的请求数与
输入/输出 token——再下面是 7 天 token 构成的分段条。

![设置页：用量图表与模型分布](docs/ui-settings-usage.png)

柱状图用 flex 盒子绘制（文字清晰、随容器宽度自适应），零值保留基线，标题右侧给出「峰值 · 合计」。
24 小时图固定为每小时请求数；7 天图可在 **请求 / token** 之间切换，因为请求数是每种套餐都会返回的
序列。模型分布表保留量级条，套餐不披露 token/费用时自动收起那几列。

侧栏底部把同样的两个窗口显示为两行；侧栏收起时只留条形，标签和数字隐去，完整信息在每行的 tooltip 里。

### 工作原理

**目录。** `/v1/models` 给 id；每个 id 一次 `/api/show` 拿到 `capabilities`（`tools` / `thinking` /
`vision`）、`<arch>.context_length` 和 `thinking.values`。没有 `tools` 的模型默认跳过（`includeNonToolModels`
可放开）。结果整体替换该路由的模型列表，内容相同则不重写（不折腾适配器）。

**思考等级。** `thinking.values` 是模型接受的值：`false` → `off: 'none'`（不发参数会退回模型默认，
通常是想），`true` → 一个 `medium` 档，其余分级值一一对应——同时声明 `xhigh` 与 `max` 的模型两档都给。

**token。** `/api/usage` 只对当前套餐返回 token 与费用，旧版套餐只给请求数。插件因此挂 `llm/stream`
读每次请求都会发出的 `usage` chunk，按「小时|模型」累计，30 天保留在
`$DSH_HOME/ollama-cloud-usage.json`（防抖 + 原子写 + `0600`），并按 balance 给的重置时刻把这些总量对
齐到相同的窗口。其他客户端的流量不会进入本机计量，所以有服务端数字时以服务端为准。

### 配置

入口配置就是 `ollama-cloud` 设置项，在 profile patch 里覆盖：

```yaml
- id: ollama-cloud
  config:
    provider: ollama-cloud        # llm-pi-ai 路由名
    displayName: Ollama Cloud
    apiKeyRef: OLLAMA_API_KEY     # 凭据引用，绝不是密钥本身
    baseURL: https://ollama.com
    syncOnStart: true             # 启动时拉取目录
    includeNonToolModels: false   # 不把无工具能力的模型放进选择器
    webTools: true                # 注册 ollama_web_search / ollama_web_fetch
    maxOutputChars: 20000         # 单次 ollama_web_fetch 输出上限
    usageCacheSeconds: 120        # /api/balance + /api/usage 缓存
```

### 对外接口

**命令** —— `/ollama-cloud [status|sync|usage]`（默认 `usage`），纯文本，任何客户端都能用：

```
Ollama Cloud 用量：
  会话（5h） ▕█░░░░░░░░░▏ 已用 7.2% · 3 小时后重置
  每周（7d） ▕█░░░░░░░░░▏ 已用 6.4% · 18 小时后重置
  5h 统计：267 次请求 · 输入 8.9k · 输出 127
  7d 统计：1.2k 次请求 · 输入 8.9k · 输出 127
```

**Web 路由**（同源，供前端使用，也可脚本调用）：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/_dsh/ollama-cloud/status` | 是否已配置 key、路由名、模型数、上次同步 |
| `GET` | `/_dsh/ollama-cloud/usage[?force=1]` | 额度窗口 + 用量 + token 合计（带缓存） |
| `POST` | `/_dsh/ollama-cloud/key` | `{ "key": "…" }` 保存并同步，`{ "remove": true }` 删除 |
| `POST` | `/_dsh/ollama-cloud/sync` | 重新拉取目录 |

写操作只接受应用自身页面（Electron 用 `file://` 载入，因此不透明源或 file 源视为应用本身），其他源一律拒绝。

### 接口覆盖

API key 在 `ollama.com` 上能触达、且编码代理用得上的端点：

| 端点 | 用在哪 |
|---|---|
| `POST /v1/chat/completions` | 对话、工具、思考、视觉（经 `dsh-llm-pi-ai`） |
| `GET /v1/models`、`POST /api/show` | 目录同步 |
| `POST /api/web_search`、`POST /api/web_fetch` | 两个联网工具 |
| `GET /api/usage`、`GET /api/balance` | 额度条、用量图表、命令 |

刻意不接：native `/api/chat` / `/api/generate`、Anthropic `/v1/messages`、`/v1/responses`（同一能力换
了条协议，harness 不走这套），`/api/tags` 的扩展字段（dsh 模型条目没有展示位）。云端根本不开放：
`/api/ps`、`/api/embed`、`/api/systemone`、`/api/version`（占位值），以及本地模型管理
（`create`/`copy`/`pull`/`push`/`delete`）——这些用 API key 访问一律 `401`。

### 运行时兼容

同一份代码适配 harness 先后提供的两套设置接缝：

| 运行时 | 设置接缝 | 行为 |
|---|---|---|
| `0.1.0-rc.x` | 命名空间注册（`ctx.settings.register`/`get`） | 插件自己持有 `ollama-cloud` 设置项；适配器设置项用 `get('llm-pi-ai')` 读 |
| `0.2.x`（桌面版） | profile-entry 表单（`describe`/`mutate`） | 条目配置本身就是设置项；适配器的 `llm-pi-ai` 条目用 `describe()` 读、`mutate()` 写 |

`engines.dsh: ">=0.1.0-rc.6 <1.0.0"` 取代 peer 版本门，避免新运行时把整个 bundle 判为不兼容而静默跳过。
已在 `0.1.0-rc.6`（CLI）和 `0.2.1-rc.2`（桌面版自带运行时）上验证：目录同步、对话、联网工具、设置页、
侧栏额度条。CSS token 都带字面回退值，老运行时结构一致、配色略朴素。

### 已知限制

- **无法硬性限制输出长度。** pi-ai 的兼容性探测会发 `max_completion_tokens`，Ollama 只认 `max_tokens`；
  `dsh-llm-pi-ai` 只暴露 `compat.thinkingFormat` 与 `compat.supportsReasoningEffort`，此处无法纠正。
- **本机计量跟着 harness home 走。** 另一台机器或其他客户端的用量不会出现在 token 统计里；按小时分桶
  意味着窗口边缘最多有一小时误差。
- **同步独占该路由。** 每次同步整体重写 `llm-pi-ai.providers.ollama-cloud`，对该路由的手改会被覆盖；
  需要保留手改就设 `syncOnStart: false`。
- `webTools` 与 `includeNonToolModels` 在注册工具时读取，改动需重启；前端 bundle 走启动哈希，改 UI 也需重启。
- 用量端点限速 10 次/分钟/用户，一次刷新会打三个请求，因此有缓存、侧栏五分钟轮询一次。

### 开发

```sh
node test/smoke.mjs      # 目录映射、思考等级、用量计算、计量、写入守卫
```

没有构建步骤：宿主侧是纯 ESM，前端侧直接按 loader 的工厂形式书写
（`window.__ModuleLoader__.load({ id, factory })`）。

用桌面版自带运行时做验证（它的内核比 Homebrew CLI 新）：

```sh
APP="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
CLI="$APP/../Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
ELECTRON_RUN_AS_NODE=1 DSH_HOME=/tmp/probe "$APP" --expose-internals "$CLI" --profile web --port 8130 --no-open
```

`desktop` profile 只能由 Electron 应用启动，因此通过它与 `web` 共享的合成（`dsh-base` + `dsh-web-app`）来验证。

许可证：MIT。
