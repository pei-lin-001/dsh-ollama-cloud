# dsh-ollama-cloud

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）接入 Ollama Cloud。
一个 API key，不用装本地 Ollama。

[English](README.md) | 中文

![侧栏额度条](docs/ui-main.png)

## 安装

```sh
# 桌面版 profile 和/或 web profile
dsh plugin --profile desktop add git:github.com/pei-lin-001/dsh-ollama-cloud
dsh plugin --profile web add git:github.com/pei-lin-001/dsh-ollama-cloud
```

打开 **设置 → Ollama Cloud**，粘贴 [ollama.com/settings/keys](https://ollama.com/settings/keys) 的
key，点 **保存并同步**。key 存进凭据服务（`$DSH_HOME/.credentials.yaml`），浏览器拿不到明文；目录
写进 `llm-pi-ai` 设置项的 `ollama-cloud` 路由，模型随即出现在选择器里。

也可以用环境变量 `OLLAMA_API_KEY`。进程环境变量会遮蔽已保存的 key，此时凭据服务拒绝写入。

开发用 `link:`：

```sh
git clone git@github.com:pei-lin-001/dsh-ollama-cloud.git ~/Dev/dsh-ollama-cloud
cd ~/Dev/dsh-ollama-cloud && dsh plugin --profile web add link:$PWD
./scripts/link-peers.sh   # schemastery、dsh-credentials、dsh-settings、dsh-tools
```

被链接的包从自己的 `node_modules` 解析 peer，所以最后一步不能省。

## 它做什么

启动时、凭据变更时、手动触发时，插件拉取账号的模型目录并写成 `llm-pi-ai` 的一条路由：
`GET /v1/models` 取 id，每个模型一次 `POST /api/show` 取细节。对话、工具、视觉、思考由
`dsh-llm-pi-ai` 承载（`api: openai-completions`，`baseURL: https://ollama.com/v1`）；插件提供目录和
凭据，传输由适配器负责。

模型条目来自 `/api/show`：

- `capabilities` 决定是否给 tools、vision 和思考档位。没有 `tools` 的模型默认跳过，
  `includeNonToolModels` 可放开。
- `<arch>.context_length` 变成 `contextWindow`。
- `thinking.values` 变成 `reasoningEfforts`。`false` 对应 `off: 'none'`，因为不发参数会退回模型
  默认（通常是开）；`true` 对应一个 `medium` 档；其余分级值一一对应，同时声明 `xhigh` 和 `max`
  的模型两档都给。

结果整体替换该路由的模型列表；内容没变就不重写。

另外注册两个工具：`ollama_web_search`、`ollama_web_fetch`，用同一把 key 调 `/api/web_search` 和
`/api/web_fetch`。

额度与用量来自 `GET /api/balance`（5h 会话、7d 每周）和 `GET /api/usage`。当前套餐会在 usage 里
返回 token 与费用，旧版套餐只给请求数。旧版套餐下，插件挂 `llm/stream` 读自己每次请求发出的
`usage` chunk，按「小时|模型」累计 input/cached/output，30 天保留在
`$DSH_HOME/ollama-cloud-usage.json`，再按 balance 的重置时刻把总量对齐到相同窗口。其他客户端的
流量不进这个计量，所以有服务端数字时以服务端为准。

历史里的图片每一步都会重新发送，请求体过大时 ollama.com 的网关会在模型之前直接 413（实测约 12 MB）。
插件把图片 base64 压在 6 MiB 以内：`0.2.x` 上会把 `maxRequestImageBytes` 写进路由，适配器到界即停，
由 harness 去掉最旧的图、换成占位并重试；`0.1.0-rc.x` 的适配器没有这个界限，插件就在出站请求里自己
丢掉最旧的图。文本不计入这个预算。

## 界面

![设置页：连接与套餐额度](docs/ui-settings-quota.png)

![设置页：用量图表与模型分布](docs/ui-settings-usage.png)

设置页五块：连接、额度条、图表、模型上下文、模型分布。24 小时图固定为每小时请求数。7 天图在请求和 token 之间
切换，因为请求数是每种套餐都会返回的序列。侧栏底部也显示这两个额度窗口。

## 配置

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
    maxRequestImageBytes: 6291456 # 单次请求的图片 base64 预算；0 表示交给适配器默认
```

模型的 `contextWindow` 来自 `/api/show`。可以在设置页的「模型上下文」里覆盖，选择存在
`$DSH_HOME/ollama-cloud-context.json`，每次目录同步都会叠加上去；恢复目录值即删除覆盖。

## 对外接口

`/ollama-cloud [status|sync|usage]`，默认 `usage`：

```
Ollama Cloud 用量：
  会话（5h） ▕█░░░░░░░░░▏ 已用 7.2% · 3 小时后重置
  每周（7d） ▕█░░░░░░░░░▏ 已用 6.4% · 18 小时后重置
  5h 统计：267 次请求 · 输入 8.9k · 输出 127
  7d 统计：1.2k 次请求 · 输入 8.9k · 输出 127
```

下面这些路由同源，设置页和侧栏在用，脚本也可以调。

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/_dsh/ollama-cloud/status` | 是否已配置 key、路由名、模型数、上次同步 |
| `GET` | `/_dsh/ollama-cloud/usage[?force=1]` | 额度窗口、用量、token 合计 |
| `POST` | `/_dsh/ollama-cloud/key` | `{ "key": "…" }` 保存并同步，`{ "remove": true }` 删除 |
| `POST` | `/_dsh/ollama-cloud/sync` | 重新拉取目录 |

`/key` 和 `/sync` 是写操作：只接受应用自身页面（同源，或 Electron 的 `file://` 不透明源），且
`Host` 必须是回环主机名或 IP 字面量；其他一律 403。

## 运行时兼容

| 运行时 | 设置接缝 | 行为 |
|---|---|---|
| `0.1.0-rc.x` | `ctx.settings.register` / `get` | 插件自己持有 `ollama-cloud` 设置项；适配器设置项用 `get('llm-pi-ai')` 读 |
| `0.2.x`（桌面版） | `describe` / `mutate` | 条目配置本身就是设置项；适配器的条目用 `describe()` 读、`mutate()` 写 |

`engines.dsh` 接受 `>=0.1.0-rc.6 <1.0.0`，两个运行时都会加载。已在 `0.1.0-rc.6`（CLI）和
`0.2.1-rc.2`（桌面版自带运行时）上验证过。CSS token 都带字面回退值，老运行时结构一致、配色略朴素。

## 已知限制

没法从这里限制输出长度。pi-ai 的兼容性探测发 `max_completion_tokens`，Ollama 只认 `max_tokens`，
而 `dsh-llm-pi-ai` 没有暴露这个字段的开关。

本机计量只看得到当前 harness home 的流量。换台机器、换个客户端，token 统计里都不会出现；按小时
分桶也意味着窗口边缘最多差一小时。

目录有变化时，同步会整体替换 `llm-pi-ai.providers.ollama-cloud`，对该路由的手改会丢；把
`syncOnStart` 设为 `false` 可以让同步变成手动步骤。

`webTools` 和 `includeNonToolModels` 在注册工具时读取，改动要重启；前端侧的改动同理。

用量端点限速 10 次/分钟/用户，一次刷新打三个请求，所以结果有缓存，侧栏五分钟轮询一次。

## 开发

```sh
node test/smoke.mjs   # 目录映射、思考等级、用量计算、计量、路由守卫
```

没有构建步骤。宿主侧是纯 ESM，前端侧按 loader 的工厂形式写
（`window.__ModuleLoader__.load({ id, factory })`）。

用桌面版自带运行时跑 web profile：

```sh
APP="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
CLI="$APP/../Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
ELECTRON_RUN_AS_NODE=1 DSH_HOME=/tmp/probe "$APP" --expose-internals "$CLI" --profile web --port 8130 --no-open
```

许可证：MIT。
