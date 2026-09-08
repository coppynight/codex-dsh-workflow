# Claude Code 审查

前置：当前机器、当前会话已有使用者明确确认稳定境外 IP，所在地区及账号符合服务要求。任何未知状态均使用 Codex。helper 的 `--network-confirmed` 是对当前答复的记录，不能从配置推断或自动填入。更换网络/机器后不得复用。

```text
node scripts/claude-review.mjs --cwd "项目绝对目录" --packet "审查包绝对路径.md" --out "新的绝对输出目录" --network-confirmed stable-supported
```

三个路径均必须为绝对路径；每次输出目录必须全新，已有目录不会覆盖。可选 `--resume` 必须显式提供原 session UUID；续评也需有效网络确认，并固定配置中的精确模型。不使用移动的 `opus` 别名或暗换便宜模型。默认 `claude-opus-5`；模型不支持时转 Codex，需要换模型由使用者明确配置。

默认 12 turns、600 秒；用 `--max-turns`、`--timeout-seconds` 设置有界值。脚本产生 `status.json`、输入包和事件元数据；完成时生成 `review.md` 与最终结果。超时会尝试停止直接 CLI 子进程并停止等待管道；**这不证明子孙进程全部退出**，重试前检查原 PID/session，保留原输出。不要自动重跑不确定调用。

## 审查包

提供原始需求、适用项目规则、稳定源码/快照路径、真实 diff（含有关新文件）、验收条件、实际测试结果和已知限制。只提供完成审查需要的源码，排除 `.env`、账号资料和原始 Host 日志。审查者报告严重程度、文件/行号、触发条件、影响、最小修正，区分确认缺陷、证据不足和可选改进。

helper 使用 safe mode、只加载 user settings，禁用扩展、MCP 和写入/执行工具，仅保留 Read/Glob/Grep。这是工具能力限制，**不是操作系统级路径沙箱**；提示词中的路径约束不保证隔离任意本地文件。需要强隔离时，在只包含允许文件的独立用户/容器/环境运行，或用平台已有沙箱的 Codex 审查。

只读 reviewer 不运行测试、不编辑、不再次委派、不请求额外凭据。主 Codex 负责实际测试、修复和验收。helper 检查订阅 authMethod 和 provider，并拒绝已发现的 API/provider 覆盖项；不打印其值、不替用户修改配置。

## 证据与降级

核对 stream 的初始模型、assistant 消息模型与最终 modelUsage；格式错误、模型不一致、permission denial、非成功结果、空结果均保留为 incomplete。`completed` 仅代表所选模型完成了响应，不等于审查通过或最终验收。

网络/登录/配额/版本/模型失败后不自动尝试其他 Claude 路由。改用独立 Codex 审查并明确审查者；没有独立上下文时报告主 Codex 自查和缺失的独立审查。当前源代码有严重缺陷时修复再做定向复审，不设置无止境互审循环。
