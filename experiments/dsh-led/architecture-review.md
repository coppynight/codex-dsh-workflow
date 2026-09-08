# DSH 主控接入 Astra：0.1.2-rc.1 独立架构审查

审查日期：2026-09-09。仅检查本机已安装源码；没有启动 Host、调用模型、安装包、读取实际凭据值或修改用户设置。下列配置是待主线程离线启动验证的配置建议，不代表已通过实际启动或真实调用。

## 结论

首选独立 `DSH_HOME`、`web` profile、自定义 agent preset，并在 preset 内加载已安装的 `@deepseek-ai/dsh-mcp-client`，公开一个 `consult_astra` 工具。正常 standard 编码工具可保留。Astra 的调用、用量、取消和进程退出由独立 MCP helper 负责；DSH 决定何时咨询、问什么、是否采纳和如何完成任务。无需修改用户全局配置，也无需安装官方可选 Codex provider。

父程序解析 DSH 最终文本中的咨询协议也是可行原型，但应标为“DSH 决策 + 确定性咨询中继”，不能把该实验单独解释成 DSH 原生工具编排。只要中继不让父模型选择问题、增加诊断、修复协议或决定重试，它仍能检验低成本模型能否担任决策者；额外 turn、消息身份和提示开销必须进入账本。

## 最小配置与启动接口

在 repo 外的私有实验目录创建新的运行 home，例如 `%LOCALAPPDATA%/dsh-led-private/<run-id>/home`。以下路径均为模板，不能在 repo 内写入真实凭据、用户 settings 副本或完整运行日志。

建议目录：

```text
<private-run>/
  home/
    .credentials.yaml       # 可选，仅实验所需的一个 DeepSeek ref
    settings.yaml           # 可省略；如创建，只含本次所需配置
  presets/
    dsh-led/
      agent.cordis.yml      # 从安装版 standard 整目录复制而来，再追加下面 MCP 行
  overlay.yml
  host.stdout.log
  host.stderr.log
  advisor-ledger/
```

`<private-run>/overlay.yml` 最小示例：

```yaml
- id: session-title-llm
  disabled: true

- id: settings
  config:
    path: '<private-run>/home/settings.yaml'
    watch: false

- id: credentials
  config:
    path: '<private-run>/home/.credentials.yaml'
    watch: false

- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-flash

- id: llm-deepseek
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    # 如本次必须沿用现有非默认 endpoint，明确复制已核对的 baseURL。
    # baseURL: 'https://...'
    # reasoningEffort: high

- id: agent-presets
  config:
    default: dsh-led
    roots:
      - path: '<private-run>/presets'
        trust: user
    includeShippedRoot: true
    includeUserRoot: false
```

Loader 的 patch 会替换目标行的整个 `config`，不是递归合并。不要把示例中未写出的用户 adapter 字段误认为仍被继承。实验 home 内若存在 `settings.yaml`，其中 `llm-deepseek` 和 `agent-default-model` 仍会覆盖上述基础行。

将安装版 `dsh-agent-presets/presets/standard` 整个目录复制为 `presets/dsh-led`；preset 没有 “extends standard + patch” 语义。追加顶层插件行：

```yaml
- id: astra-consult-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: stdio
    serverName: astra_consult
    command: '<absolute-node-executable>'
    args:
      - '<absolute-path-to-consult-mcp.mjs>'
      - '--run-config'
      - '<private-run>/advisor-config.json'
    cwd: '<fixed-task-workspace>'
    env: {}
    toolCallTimeoutMs: 210000
    failOnStartupError: true
    reconnect:
      enabled: false
```

这里 `--run-config` 是待实现 helper 自己的接口，不是 DSH 参数。helper 内部截止时间应短于 MCP 超时，且取消后必须等子进程真正退出。`failOnStartupError:true` 使咨询工具不可用时 session 创建失败，避免把“没有加载咨询工具”的运行错记为 DSH 选择不咨询。关闭自动重连减少原型的未知执行状态；恢复可观察，不应自动重新提交付费请求。

DSH 模型可见名称为 `mcp__astra_consult__consult_astra`。stdio 子进程环境默认会过滤 credential-shaped 变量和 `DSH_*`；不要为了兼容把整个父环境重新写进 `env`。Codex 自己的认证、只读模式、模型选择和允许工具由 helper 明确配置。

启动形状：

```text
<absolute-node> <DSH-install>/lib/bin.js --profile web --patch <private-run>/overlay.yml --host 127.0.0.1 --port 0 --no-open
```

只对该子进程设置 `DSH_HOME=<private-run>/home` 和 `DSH_TELEMETRY_DISABLED=1`，通过进程参数数组启动；不修改持久环境变量。`--port 0` 由 OS 分配端口，从 Host 的实际 URL 记录获得地址；将 runner 的独立 `WORKFLOW_CONFIG` 指向该地址，不能默默退回现有用户 Host。Windows 后台 helper 使用隐藏窗口。

`web` profile 在新 home 中会自动初始化，bundle 从当前 DSH 安装解析，不需要运行 `dsh plugin add`。只换 `--profile` 名称不会隔离 home 级 patch、settings 和凭据；`--profile` 也不是任意目录参数。不要在现有 home 中使用 `--dump-config` 作为“纯读取”：launcher 的 prepareProfile 会重写 profile 的空 `cordis.yml`。

新会话使用 `session.create({sessionId,cwd,agentPreset:'dsh-led'})`。`agentPreset` 是已发现的目录 id，不能直接传 YAML 绝对路径。现有 runner 硬编码 `standard` 时，改默认 preset 不会生效，必须修改调用参数或移除显式值。

## 凭据与模型设置的严格隔离

推荐不复制整个用户 settings，也不把 credential provider 的 `path` 指回用户文件：

1. 确定原 Host 实际使用的 `apiKeyEnv`，默认是 `DEEPSEEK_API_KEY`，以及必要的 `llm-deepseek.baseURL`、`thinking`、`reasoningEffort`、模型目录、maxTokens、retryPolicy 等非密钥字段。只复制维持本次实验路由所必需的字段到私有 overlay/settings。默认官方 Flash 路由通常只需一个 ref；是否适用于本机仍需原 Host 元数据核对。
2. 由确定性本地程序只读解析原生凭据文件，仅取本次需要的 `refs[apiKeyEnv]`，写入私有 home 的原生 version 1 文件；不打印值，不把值放入 argv，不写 repo，不复制其他 OAuth records。也可仅将该值注入 DSH 子进程环境，使 credential seam 将它视为不可写环境凭据。没有对应 ref 时停止，不能自动扩大到扫描其他账号文件。
3. 私有 settings 可不创建，缺文件等于空用户层。需要准确指定模型和 reasoning 时，在私有 settings 中写 `agent-default-model: {provider, model, reasoningEffort}`，或在隔离 Host 上调用 selectModel。两种情况均只能写实验副本。

原生最小凭据结构为 `version: 1`、`refs: {<apiKeyEnv>: <secret>}`；`records` 可省略。原生 settings 是 namespace mapping，模型选择 namespace 为 `agent-default-model`，DeepSeek adapter namespace 为 `llm-deepseek`。

不要声称 `watch:false` 等于只读。`credentials-local` 没有 readonly 选项，旧版 flat layout 甚至会在启动时原地迁移。直接引用原文件技术上可行，但不能满足“保证不写用户配置”的边界。复制会增加一份本地秘密，应只留所用 ref、位于 repo 外的私有目录；Windows 需要实际 ACL，POSIX 目录 0700/文件 0600。`DSH_HOME` 是配置隔离，不是 OS 沙箱，拥有 shell 的同一用户仍能读取用户目录。

同样，session.selectModel 的文档称 session-local，但实现随即调用 `agentDefaultModel.saveSelection`。它会修改 settings 默认，绝不能在用户原 Host 上做无副作用实验。

## 工具权限与调用身份

session.create RPC 没有 `tools`、`allowMultiAgent` 或 `model` 字段。工具按 preset 的站立 scope 组合，子代理继承父 preset。保留 standard 会保留 subagent、subagent_fork、workflow、ralph。若做“禁用多代理”消融，应在实验 preset 移除/disabled 整个 delegation group，同时记录它是受限消融；不能把它当全功能 baseline。禁止名称靠提示不构成实际工具限制。

原生 `ctx.tools.restrict()` 能限制继承层工具，`ctx.tools.guard()` 能在执行时拒绝，且能按 agent scope 注册；它们是插件接口，不是 session RPC。preset 自己注册的工具不能靠同层 restrict 删除，最小做法仍是不给 preset 挂载该工具。MCP client 在 preset 中注册工具，不提供全局 Service，不需要 isolate realm。

原生 MCP bridge 只传 `name` 和模型提供的 `arguments`，未附可信 DSH sessionId、toolCallId 或 cwd。多个 session 使用一个 preset 时会共享一个 MCP server 实例。最小实验应固定每个独立 Host 一个任务 workspace，helper 从受控启动参数绑定 workspace 和账本目录，拒绝模型任意指定 cwd、shell 命令、权限或 model。模型提供的 consultationId 可辅助去重，但不是可信运行身份。

若需多个并发任务严格归属、可靠去重和父/子代理限制，薄 Cordis 自定义工具比裸 MCP 更直接：`execute(args,exec)` 可读可信 `exec.agent`/调用身份/取消信号，再调用同一 helper。该插件可通过 preset 相对/绝对模块路径加载，无需安装；代价是依赖 DSH 0.1.2 的工具 API，迁移性弱于 MCP。这是小适配层，不需要常驻队列重构。

咨询 helper 最少需要：固定只读 Codex 路由和权限；有界文本参数；原子记录 planned/started/completed/failed/unknown；并发和累计咨询次数上限；取消传播；子进程退出证据；原生 usage/failure 输出；未知结果不得付费重试；返回简短建议及证据引用。服务已经收到请求但响应丢失时，仅依赖进程内计数不够。

## 用量与“后台已经空闲”的证据

使用 `session.follow` 的 opening `projections.values.tokenUsage` 与后续 projection 更新，保留 `asOfSeq`；或从完整 turn 事件调用原生 `deriveTurnTokenUsage(events)`。`tokenUsage` 会替换同一 attempt 的 streaming/final 样本，并把 retry 作为另一付费 attempt。只累加 assistant/message 会漏失败的 streaming usage；把 message 和 chunk 都相加又会重复。

投影缺失表示未知。`contextPressure`/`contextBreakdown` 是上下文估计，不可当成本。DSH 日志的 tokenUsage 不会包括外部 Codex 用量；必须合并 helper 的独立账本。实际模型路由应依据 `request/header`，不能只依据请求选择事件。预算里的 USD 代理估算和订阅套餐用量不是同一指标。

原生空闲证据是请求对应的成功 turn/end、session.list 的 running=false、session.control 中该 session 无 queued/steering/context 项、无 running/stopping jobs、没有待用户问题/审批。标准工具支持多代理时，要递归覆盖 `parentSessionId` 后代并汇总日志、队列、jobs 和用量。MCP helper 还需单独证明没有咨询子进程存活。

这仍不能证明所有辅助模型调用都结束：默认自动标题使用自己的 inFlight 集合，不是 jobs，也不写 assistant/message usage。关闭 `session-title-llm` 是本实验最小且明确的处理。其他被启用的辅助调用如压缩、总结也必须检查是否进入主会话账本，未知部分不能写成 0。完成自然语言文本与 parent session running=false 单独都不够。

## 主要本地源码证据

- `D:/AI/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/types.d.ts:245`：create 只有 identity/cwd/preset；`:417` follow snapshot；`:436` queue、jobs、control 类型。
- `D:/AI/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js:122`：selectModel；`:140` session 选择；`:142` 保存默认设置。
- `D:/AI/dsh/node_modules/@deepseek-ai/dsh-agent-default-model/lib/index.js:66`：settings.replace 持久化入口。
- `D:/AI/dsh/node_modules/@deepseek-ai/dsh-agent-presets/README.md:32`：同 preset 共享 composition、子代理继承；`:38` roots schema；`:79` 非空会话不能换 preset；`:178` 无 extends/patch。
- `D:/AI/dsh/node_modules/@deepseek-ai/dsh-agent-presets/lib/types/specifier.js:30`：相对/绝对插件文件解析。
- `D:/AI/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml:168`：delegation 组合；`:203` 可选 Codex provider 默认关闭。
- `D:/AI/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js:94`：MCP 调用仅 name/arguments；`:151` scoped tools 注册；`:738` schema；`:765` 激活与严格失败。
- `D:/AI/dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts:597`：register/restrict/guard；`:631` restriction 对继承层生效。
- `D:/AI/dsh/node_modules/@deepseek-ai/dsh/lib/profile-boot-BTzzdrGY.js:161`：prepareProfile 写空根配置；`:167` patch 层顺序。
- `D:/AI/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:323`：profile 路径；`:847` 初始化与安装包解析。
- `D:/AI/dsh/node_modules/@deepseek-ai/dsh-web-app/lib/startup.js:22`：host/port/no-open 参数；`D:/AI/dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:441`：preset 服务。
- `D:/AI/dsh/node_modules/@deepseek-ai/dsh-credentials-local/lib/types/index.d.ts:44`：无 readonly 参数；`lib/index.js:647`：启动读取与原地迁移。
- `D:/AI/dsh/node_modules/@deepseek-ai/dsh-settings-file/README.md:44`：独立 settings path；`D:/AI/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/types/index.d.ts:42`：adapter 字段。
- `D:/AI/dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js:86`：完整 usage fold；`lib/types/turn-usage.d.ts:24`：精确 turn 用量缺证据时返回 undefined。
- `D:/AI/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/control.js:52`：control baseline；`lib/types/list.js:154`：running 的判定。
- `D:/AI/dsh/node_modules/@deepseek-ai/dsh-session-title-llm/lib/index.js:209`：独立标题请求；`:229`：直接 LLM stream；`D:/AI/dsh/node_modules/@deepseek-ai/dsh-session-title/lib/index.js:570`：独立 inFlight。

## 验证界限

这些判断来自实际安装版源码及包文档，未运行启动、schema 导出、MCP handshake 或付费调用。最先需要验证的是：独立 home 启动成功、创建 dsh-led 时 MCP 工具确实注册、凭据解析不改原文件、失败/取消不遗留 helper、用量与后代工作闭合。父程序文本中继的实验可继续作为原型，但不要把未加载 MCP 的运行混记为原生工具版本。

## 第一轮原型代码审查

以下行号对应 2026-09-09 第一版 `prototype/*.mjs`，后续实现可能移动。这里仅修改审查文档；没有修改实现或运行模型。

### 必须在真实对照前修复

1. **费用和 deadline 的提交前检查不闭合。** `prototype/runner.mjs:76` 遇到 terminal 先 break，绕过 `:77` 的 DSH 阈值；`:94` 已发起专家调用后才在 `:100–101` 检查合计费用。`:100` 还把 `record.cost.usd=null` 隐式当作 0。`:57` 的时间检查发生在 idle RPC 之前，`:95` 可能给已经过期的调用传非正 timeout。触发：DSH 最后一步达到阈值后要求咨询、DSH usage 不完整、或 idle 检查耗尽剩余时间。最小修复：在每次实际 prompt/consult 提交前，统一检查最新费用是否已知、总费用阈值和正的剩余 deadline；未知费用停止新付费工作，不把未知折成零。这是 stop-before-next-call，不是供应商硬扣费上限。

2. **“专家无工具”目前不成立。** `prototype/protocol.mjs:15/19` 声明专家没有工具，但 `prototype/codex.mjs:12` 只设置 read-only；读取文件、shell 查询、MCP 和委派并不会由这个选项全部禁止。`prototype/runner.mjs:97` 不检查 `expert.toolResults`，工具调用后的建议仍算有效咨询。触发：专家使用实际工具补充 DSH 没有提供的证据。最小修复：在可验证的执行配置中关闭咨询臂的工具/MCP/委派，并把任何工具调用视为该实验臂的协议违规；如果实际版本做不到，应改称“只读工具专家”，将提示和对照假设一并修改，不能继续宣称 input-only。只添加一句提示不算执行隔离。

3. **Codex 超时可能杀复用 PID、漏后代或永久等待。** `prototype/codex.mjs:24` 等的是 stdio 全部关闭后的 close；父 CLI 已退出但后代持有 pipe 时，`:29–31` 仍拿原 PID 调 taskkill，没有检查 exitCode/signalCode，存在 PID 复用风险。POSIX `:33` 只杀父进程，taskkill 非零退出也无人处理，`:36` 没有第二个有界退出期限。最小修复：生成自有进程组、检查父进程是否已退出、以组/树取消、等待实际结束并设置有界 grace；不能证明后代退出时记录 unknown。`scripts/dsh-recover.mjs:709–775` 已有可复用的退出检查与 pipe cleanup。所有 spawn 后失败路径需要 finally 清理，外部取消也要传入 helper。

4. **DSH 账本漏失败 attempt 和后代，并可能套错价格。** `prototype/runner.mjs:70/117` 只取 assistant/message，失败后仅有 assistant/chunk usage 的 attempt 会丢失。`:71` 保存的是用户 model/selection，不是实际 request/header；`:72/118` 对任意配置路由都套 DeepSeek 单一价目。standard 允许子代理，父会话 usage 不包含其开销。最小修复：按完整 turn 调用官方 `@deepseek-ai/dsh-token-meter/client` 的 `deriveTurnTokenUsage`，缺证据返回 unknown；递归收齐后代并以实际 route 决定价格或拒绝无法归属的混合路由。官方 tokenUsage projection 可作运行中已报告用量的下界/交叉检查，但它缺少 complete 标志，不能仅因投影数字存在就称完整账本。

5. **空闲标记在继续执行前没有失效，且只覆盖父会话。** `prototype/runner.mjs:81` 置 idleVerified=true，之后 `:63` 发新 prompt、`:94` 开专家都不清回 false，保存的 record 在任务重新工作时仍报告空闲。`:22–26` 仅查父 session running/queue/jobs，不能证明 continuable 子代理、外部专家或辅助标题调用结束。catch `:108` 只在 request summarize 为 running 时 cancel；未知 admission/活动后代不会因此停止。最小修复：每次提交前先持久化 idle=false，区分 DSH 父会话空闲和整次 run 空闲；最后检查所有自有后代/专家且刷新最终用量，失败时保留 unknown 与可接管 identity，不允许以旧标记放行复用 workspace。

6. **workspace 排他性只锁了输出目录。** `prototype/runner.mjs:33` 的 owner.json 只能拦相同 outputDir，`:50–51` 的 list 检查不是原子的，也只比较相同 cwd。两个不同 outputDir 的 runner 可同时通过预检并编辑同一 workspace；嵌套工作目录和父会话已经 idle 的后台子代理也会漏掉。最小修复：复用 `bridge/service.mjs:64–79` 的 canonical/overlap claim 思路，在创建 session 前获取 workspace claim，直到所有自有工作已证实结束才释放。单任务独立 worktree 的固定实验可先由 harness 强制这一前提，但不能据此把 runner 标成可安全并发。

7. **Codex JSONL 接收静默容错会把损坏轨迹当有效咨询。** `prototype/codex.mjs:19–20` 把每个 Buffer 独立转为字符串，跨 chunk 的 UTF-8 会损坏；`:40` 丢弃所有 JSON 解析失败行，`:47` 只从剩余行找失败；runner 又仅按 exitCode/已解析 failures/usage 判成功。触发：分块边界切中文字，或 stdout 含损坏/截断 JSONL，但仍保留一个成功用量事件。最小修复：使用 StringDecoder 或设 utf8 encoding、按行持续保存原日志；将非协议内容/解析错误标记为轨迹不完整，要求已关联的 thread/turn 成功终态和明确最终答复，不能拼接所有 agent_message 当唯一最终答复。输出应流式写私有文件并限制内存缓冲，避免工具输出导致 observer 崩溃后失去清理能力。

### 已做的离线验证与用量接入细节

只运行了一段纯本地合成 fixture：第一次 attempt 报告 input=1000/output=100 后 retry，第二次成功报告 input=2000/output=200。现有 message-only 账本给出 2000/200；已安装官方 `deriveTurnTokenUsage` 正确给出 3000/300、total=3300。这证明漏计的是实际 attempt 生命周期，而不只是字段命名问题；没有产生任何真实模型用量。

官方公开 export 是 `@deepseek-ai/dsh-token-meter/client`，安装锚点解析后落到 `lib/types/client.js`，再 export `deriveTurnTokenUsage`。不要从 plugin 主入口导入并启动服务。输入为一个 turn/start 至匹配 turn/end 的事件段，包含 step/start、step/end、llm/retry、llm/retry-started 和 usage/assistant 事件。不能把全 session 的多个 turns 一次传入，也不能把所有 usage 样本直接相加。

`bridge/client.mjs:172` 返回的 projections 是 follow 打开时 snapshot 的 projection，cursor 却可能包含之后 10 秒 live events。因此不能把这个 projection 当作新 cursor 的最终费用；最终空闲检查后重新取 seconds=0 的快照并记录其 asOfSeq，或使用完整 turn fold。当前 packed history 只打包 delta 文本/参数，usage 和 lifecycle 仍为独立 events，现有 readEvents 的事件筛选不会丢掉这些计费用事件。

没有发现 runner 在同一次运行里主动重新提交未知 prompt/consult 的盲重试：requestId 在提交前已保存，异常分支进入检查/停止。这个优点不解决跨 run 并发 claim、未知费用放行或进程残留；应保留该不重试行为。
