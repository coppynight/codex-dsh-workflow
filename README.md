# DSH × Astra：顶级智能，日常预算

让 DeepSeek 主导理解、实现与自测，用独立验收发现缺口，按需使用 Astra。
目标是接近强模型交付、约十分之一运行成本；**目标尚未证实**。形态不再限于 Skill。
现有 Codex 主控 Skill 继续保留，新方向提供一个可审查的 DSH 主控命令行原型。

**[介绍页面](https://coppynight.github.io/codex-dsh-workflow/) · [公开案例、数据与复现](https://github.com/coppynight/codex-dsh-workflow/tree/main/examples)**

**当前成果：[实验与数据](examples/dsh-led-v5/README.md) · [产品判断](examples/dsh-led-v5/DECISION.md) · [运行原型](prototype/README.md)。**

本轮保存 22 次任务尝试，涉及 4 个任务；只有前 3 个完成三臂对照，第四个因重试费用未知而停止。
初始高思考强度 DSH 的产物通过 3/3，费用约为 Astra 的 13–15%，耗时约 2 倍；降低思考强度
能进入约 5–7% 费用区间，但语义错误和交付中断增多。任务中专家咨询次数为 **0**，因此不能
把这些节约归功于顾问策略。完整费用包含返工，未知不填零，失败源码可离线重放。

费用为官方冻结价格的 API 等价估算，不是订阅扣减或发票，也不能推导一个账号等于十个。
研究与原型开发成本未分摊到任务费。原型已有独立 Host、原生 MCP 顾问、有界修复、账本及
停止恢复机制；新的一体化入口、跨系统真实运行和专家升级收益仍待验证。

```text
npm ci
node prototype/task.mjs run task.json
```

任务格式与本地配置见 [原型说明](prototype/README.md)。以下是仍可使用的旧 Skill 安装路径。

## 在另一台机器安装

需要 Git、Node.js 24+ 与可用的 Codex。本仓库公开，可直接克隆。

```text
git clone https://github.com/coppynight/codex-dsh-workflow.git
cd codex-dsh-workflow
node scripts/install.mjs
```

安装器默认复制到 `$CODEX_HOME/skills/codex-dsh-workflow`，未设置 `CODEX_HOME` 时使用 `~/.codex/skills/codex-dsh-workflow`；输出实际目录。也可用 `--dest` 指定当前 Codex 的 skill 目录。已有普通目录用 `--update` 更新，旧版本备份到用户目录的 `skill-backups`；不会删掉配置、key 或 DSH 状态。若是 symlink/junction，先检查目标再对真实目标更新。安装中断留下的暂存目录只在确认没有安装器运行后手动处理。

进入输出的安装目录，运行 `npm ci` 安装接入层依赖，再按 [安装与配置](references/setup.md) 配置 DSH。**只使用 Codex 兜底时，不需要 DSH key 或 Claude 订阅。** Codex 未发现 skill 时重新加载或新开会话。

在 Codex 中说：

> 使用 $codex-dsh-workflow 开发这个项目。由你主控；DSH 负责合适的实现与自测；先确认网络环境，再选择 Claude 或独立 Codex 审查。

## 行为与边界

| 情况 | 行为 |
|---|---|
| 未确认、不是稳定境外 IP、地区或账号资格不确定 | 不调用 Claude，改用 Codex；确认不会跨机器迁移 |
| Claude 登录、模型、配额或连接失败 | 保存不完整审查状态，转 Codex，不切 API 账单或暗换模型 |
| DSH 未安装或 key 未配置 | 给出本地安装/设置步骤，Codex 继续可安全开展的工作 |
| 后台没启动 | 已启用 autoStart 时，检查进程与端口后有界启动、验证就绪 |
| 端口被占、状态不明、请求响应丢失 | 保留 checkpoint 和原任务 ID，不杀未知进程、不重复提交 |
| 反复失败 | 持久熔断与冷却；隔离工作目录，保留可恢复证据 |

稳定 IP 不等于免封号保证。本项目不更改代理、绕过地区限制或代管凭据。多模型不可用时能继续用 Codex，但原写入者是否空闲不明时，必须先隔离目录。

## 项目内容与验证

- [SKILL.md](SKILL.md)：Codex 实际加载的规则。
- [setup.md](references/setup.md)：Windows/macOS/Linux 安装、配置和 key 引导。
- [reliability.md](references/reliability.md)：故障分类、恢复和续作。
- [claude-review.md](references/claude-review.md)：网络门槛、只读审查与模型证据。
- `scripts/`：安装、诊断、Claude 门槛和 DSH 恢复；`bridge/`：随 skill 安装的 MCP/CLI 接入层；`tests/`：离线回归。

```text
npm ci
npm test
node scripts/doctor.mjs
```

接入层依赖锁定在 `package-lock.json`；DSH 是单独安装的可选运行时，当前适配 `0.1.2-rc.1` 的官方 Session Remote 描述符。默认 DSH 路由为 `deepseek-official / deepseek-v4-flash / high`，Claude 精确模型为 `claude-opus-5`，均可在本地配置中显式调整；不承诺账号具备这些模型。CLI 协议变化时停止该依赖并用 Codex，先验证兼容性再升级。

Windows 本机运行及模拟故障验证结果见 [validation.md](references/validation.md)。仓库 CI 为三系统执行离线测试；跨系统真实 DSH/Claude 调用与不同账号资格需在目标机器验证。项目不承诺无人值守或零故障运行。

资料依据：[OpenAI skill 文档](https://learn.chatgpt.com/docs/build-skills)、[Claude Code CLI 文档](https://code.claude.com/docs/en/cli-reference)、[DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)。
