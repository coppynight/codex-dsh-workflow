# DSH 主控原型

这个入口让 DeepSeek 负责理解、实现和自测，以独立验收决定交付。Astra 是可选的技术顾问。
它复用原生 DSH 和 Codex，不需要 Astra 在外面反复读日志、派工和判断完成。

**实验 alpha。** 当前真实验证来自 Windows、Node 24、DSH 0.1.2-rc.1。离线检查进入三系统
CI；macOS/Linux 的真实模型运行和自动进程树回收尚未验证。未知状态会保留占用，不能把
“有兜底”理解为“永远自动继续”。当前没有证据支持一般任务上的 90/10 或套餐倍率承诺。
真实实验直接使用核心 runner；新组合入口 `task.mjs run` 尚未完成付费端到端验证。

## 运行一个任务

在仓库目录运行 `npm ci`。按 [现有配置指南](../references/setup.md) 配置 DSH 安装目录、
原生数据目录和共享 stateDir；配置文件默认在 `~/.codex-dsh-workflow/config.json`。
DSH key 由使用者在本地 DSH 的 Settings → Models 中配置，也支持原生环境变量引用。
不要把 key 放进 task.json、聊天、仓库或诊断输出。新原型会读取凭据，向自有 DSH 进程
的环境传入所需单个 key；不会把整个凭据文件复制到仓库或修改原 DSH 默认模型。

需要可用的原生 `codex` 可执行文件及它自己的登录。Windows 使用 `codex.exe`，不是通过
shell 自动执行 `.cmd` 包装器。非 PATH 安装可用 `CODEX_EXECUTABLE` 指定原生绝对路径。
如果只试 DSH，设置 `advisor:false`，不会调用 Codex 顾问。

创建 UTF-8 的 `task.json`：

```json
{
  "cwd": "../my-project",
  "taskFile": "task.md",
  "verify": ["node", "--test", "test/acceptance.test.mjs"],
  "advisor": true,
  "model": "deepseek-v4-flash",
  "reasoningEffort": "high"
}
```

`cwd` 和 `taskFile` 相对 task.json 解析；也可以用 `task` 直接提供任务文字。
`verify` 是可信的可执行文件及参数数组，工作目录为项目目录，不是 shell 命令字符串。
例如不要把 `npm test && deploy` 当成一个参数。先在可还原的工作副本中尝试。

```text
node prototype/task.mjs run task.json
```

启动时立即输出本次 `specFile` 路径；请保留它。完成后输出验收、全部已知模型费、
修复和咨询次数，以及自有 Host 是否已清理。记录保存在本机私有工作目录，原始事件
可能含项目内容和模型推理，不应直接上传公共仓库。

默认 Flash/high：初步实验中 low 虽便宜，但出现了更多语义错误。`low` 可显式试验；
另支持精确型号 `deepseek-v4-pro` 并按 Pro 价格核算，不能将 Pro 调用冒充 Flash 费用。
这里没有一个已经证实适合所有任务的模型选择规则。
Pro 的价格路由和离线检查已接入，但预定实测因未知费用保护而没有启动。

对于不需要测试进程隔离的 Node 小组件，可在任务和自测中使用
`node --test --test-isolation=none ...`，使测试在同一 Node 进程运行。它不改变 DSH
沙箱或审批规则；对依赖进程隔离的测试套件不应默默替换命令。
[Node 官方说明](https://nodejs.org/download/release/v24.15.0/docs/api/cli.html#--test-isolationmode)。

## 执行和升级规则

1. 为每个任务创建独立 Host、home 和 preset；关闭未归属的自动标题调用，绑定唯一工作目录。
2. 保留 DSH 标准工具；MCP 顾问只接受有限问题和上下文，不能替换工作目录。
3. 原生 turn 结束、任务树和后台工作空闲后，才运行使用者提供的验收。
4. 验收失败最多修复一次，使用同一便宜模型的 high 思考强度，并传回失败输出。
   验收程序缺失、超时或退出未知属于基础设施问题，不用再次调用模型“修代码”。
5. 再次验收仍失败就报告失败。不会静默把整项任务转给 Astra 重写，也不会绕过审批。

“独立验收”指由程序在模型运行后调用，而非模型声称测试通过。验收的有效性取决于提供的
检查；模型能修改工作目录中的测试，所以关键验收宜放在模型不能写入的位置，或在外部
核验其哈希。当前通用入口不自动保护任意测试文件，也不把测试通过等同于安全或业务完整。

顾问最多调用两次，使用原生 Codex 登录和固定 Astra 型号。相同咨询 ID 和相同请求
重放返回已有建议；冲突 ID、正在执行或状态未知都不会重复计费提交。顾问提示要求
只给文字建议，不使用工具；read-only 沙箱本身不等于禁止全部读取工具，实际发生工具
调用则判为协议违规，保留费用并不向 DSH 透传违规建议。

默认任务观察时限 10 分钟，每次咨询 150 秒，验收 30 秒；后代进程清理另有短宽限。
DSH 观察费用达到 $2 会停止继续工作，专家历史费用达到 $1 会停止下一次咨询；续作前
也检查合计费用。它们是**下一次调用前的软阈值**，不是在途账单硬上限。未知费用不能填零。

## 状态与恢复

```text
node prototype/task.mjs inspect "启动时输出的 specFile 绝对路径"
```

这是只读操作，不会再次提交模型请求。正常完成且 Host 已清理时读取保存的结果。

| 状态或问题 | 处理 |
|---|---|
| `verified` | 配置的验收通过；检查交付内容是否满足无法机器验证的要求 |
| `model-completed-unverified` | 未配置独立验收，不能据模型自述认定完整交付 |
| `verification-failed` | 已用完本次有界修复，保留失败输出与产物 |
| key/运行时未配置 | `npm run doctor`；按 setup.md 完成本地设置后再开始任务 |
| Host 未启动 | 新入口启动自己独立的 Host，不需要原来的后台服务已经运行 |
| 权限或问题需要用户处理 | 保留证据并停止，不自动回答或升级沙箱权限 |
| 请求响应丢失、执行/账本未知 | 检查同一 session/request 与专家账本；不盲目重跑，不靠删锁绕过占用 |
| 工作目录被占用 | 确认原任务树及专家已退出；必要时在独立副本继续，不能并发改同一目录 |

原型目前没有跨机器搬迁活动进程或自动恢复未知远端提交的功能。迁移代码和任务，
重新建立本机认证；不要复制凭据、cookie、PID、锁文件或“网络已经确认”的记录。

## Claude 与旧 Skill

新的 DSH 主控原型只接入了 Astra 顾问。Claude 仍是原 Skill 的可选审查路径，未在本次
实验中调用。启用前需要使用者在当前环境确认稳定境外网络和地区/账号使用资格；
未知则使用 Codex，不做 Claude 登录或网络探针，不承诺稳定 IP 就不会封号。

`node scripts/install.mjs` 安装的是原来的 Codex 主控 Skill；它不会自动将此实验入口
注册成新产品。[旧规则](../SKILL.md)与[旧页面](https://coppynight.github.io/codex-dsh-workflow/legacy.html)保留。

## 开发验证

```text
npm test
npm run test:prototype
npm run test:accounting
node examples/dsh-led-v5/replay.mjs
```

计量测试使用已安装 DSH 的官方用量函数，需 DSH 运行时，但不调用模型。
replay 不需要模型、密钥或 DSH，只重放公开产物的验收；历史失败应仍然失败。
