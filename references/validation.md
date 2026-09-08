# 验证记录

2026-09-08，Windows / Node.js 24.18.0。

- Skill Creator 的 `quick_validate.py` 检查通过（UTF-8 模式）。
- `npm test` 离线与本地模拟服务测试通过，涵盖安装与更新备份、同目录误覆盖保护、配置解析、Claude 未确认即拒绝、精确模型证据、进程超时、熔断/锁/损坏状态、workspace symlink、模型不可路由、MCP 配置传递、WebSocket 401 重连和禁止无限重试。正式计数以当前 CI 为准。
- 新接入层在本机通过真实 stdio MCP `list` 和已配置 DSH Host 的认证目录检查；自定义配置路径确实传至 MCP 子进程。空配置的新用户模式亦可列出工具。
- 使用独立端口和全新 DSH 数据目录，恢复器真实完成“Host 未启动 → 单次启动 → 认证健康”，记录 `recovered: true`、`startedThisCall: true`。测试没有停止用户原来的 Host。
- 在这份新 DSH 数据目录中通过新桥接提交最小无文件操作任务，真实得到 `MISSING_CREDENTIAL`：没有为 `deepseek-official` 配置 API key。保留该失败，提供 Web Models 配置引导；检查 session 空闲、无 queue/jobs 后释放 claim，并停止测试专用 Host。这证明 catalog 可路由不代表 key 已配置。
- 移植过程由真实 DSH 完成接入层实现与离线自测，主 Codex 复验并修复集成问题，独立 Codex 审查修复后的脚本和接入层，未留待修复缺陷。

未运行 Claude 真实审查：本次没有收到当前网络环境的明确确认，按规则使用 Codex 独立审查。跨机器配置不会携带确认状态。

未在本机模拟 macOS/Linux 为真实系统运行。三系统 CI 执行离线和本地模拟测试；POSIX 真实 DSH 自动恢复、不同账号真实 Claude/DSH 调用、跨机器长任务续作需在目标环境验证。测试不代表零故障保证，也不代表经过 Claude 批准。
