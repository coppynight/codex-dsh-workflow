---
name: codex-dsh-workflow
description: Coordinate substantial development with Codex owning design and acceptance, DSH implementing bounded tasks, and optional Claude Code review. Includes portable setup, explicit Claude network confirmation, bounded recovery and Codex fallback. Use for Codex/DSH/Claude collaboration; handle small edits directly.
---

# Codex 主控开发工作流

Codex 负责需求、架构、拆解、环境诊断、集成和最终验收；DSH 实现边界明确的任务并自测；Claude Code 按需独立审查。依赖不可用时继续用 Codex 完成可安全进行的工作。使用者的明确指令优先于本 skill，已有授权不重复询问。

所有脚本路径相对本 `SKILL.md` 所在目录；先解析实际安装目录，执行时使用绝对路径。不要复制示例机器的盘符、账号、密钥或历史运行状态。

## 1. 首次路由：先确认 Claude 使用环境

每台机器的每个新工作会话，先询问一次：**“当前是否为稳定境外 IP，且所在地区与账号符合 Claude Code 的使用要求？否或不确定时将使用 Codex 审查。”** 当前会话已明确回答且网络未变时不重复询问。

- **是**：记下当前会话的明确答复，才可进行 Claude 登录检查或调用。每次调用 helper 传 `--network-confirmed stable-supported`；不得代替用户推断或填写确认。
- **否、不确定、未回答**：不启动 Claude、不尝试登录、不发探测请求；用独立 Codex 上下文审查，继续其他工作。等待答案不阻塞 DSH/Codex。
- 换机器、换网络、代理出口变化、地区相关错误或上下文中无法确认原答复时，原确认失效；重新询问或继续 Codex。
- 确认不写进可迁移配置，不根据 GeoIP、已购买订阅、以往成功、环境变量或静态配置推断“安全”。稳定 IP 不是免封号保证；不帮助绕过地区限制、风控或更换身份。

这是用户要求的 Claude 前置条件，仅约束 Claude；不增加发布、安装或其他操作的无关审批。调用方法和审查边界见 [references/claude-review.md](references/claude-review.md)。

## 2. 安装与诊断

首次使用、换机器或缺依赖时读 [references/setup.md](references/setup.md)。运行 `node <skill>/scripts/doctor.mjs`：默认只做本地诊断，不联系 Claude，不提交模型任务。

配置保存在用户目录或 `WORKFLOW_CONFIG` 指定的绝对 JSON 路径；密钥只由使用者在 DSH 自己的设置界面填写。没有 DSH 或 key 时给出具体配置步骤，并用 Codex 继续，不声称 DSH 已通过真实执行。

第一次 DSH 委派前运行 `node <skill>/scripts/dsh-recover.mjs`，然后 `node <skill>/scripts/doctor.mjs --online-dsh`，区分后台连通与模型就绪。已配置 `autoStart: true` 代表使用者允许恢复已配置的本地服务；脚本在确认无监听者且无匹配 Host 进程时启动一次。新安装不自动修改用户其他服务或占用端口。

## 3. 路由与任务契约

- 小改动由 Codex 直接完成。可独立验收的实现交给 DSH；重要接口、数据结构、鉴权、迁移、大范围重构或重大设计不确定性按需安排独立设计/交付审查，不强制每个任务调用所有模型。
- Astra 省量是路由目标，不是保证：当需求已清楚且实现明显大于委派/复验开销时再用 DSH。小任务、源码需整体回灌的任务或首轮实测无收益时优先 Codex 直接完成；不要为展示工作流增加无用审查。评估时分列 Astra、DSH、缓存和主会话开销，缺失不算 0。
- 启动外部执行者前确认其权限与任务匹配；已知只读环境不能安排写入/自测任务。遇到一次策略拒绝就保存证据并停止该执行路径，不反复消耗模型上下文；可让只读审查者返回建议，由有权限的主 Codex 验证和修改，明确由谁实际执行。
- Claude 不可用或网络未确认时，可使用可用的 **Codex 独立审查子代理**，明确只读范围和证据；本 skill 允许这种按需委派。无子代理能力时由主 Codex 二次检查，并明确“未完成独立审查”，不把自查写成独立通过。
- 任务包必须包含：唯一 taskId、绝对 cwd、原始需求、基线 revision（无 Git 则注明）、允许修改路径、接口约束、验收条件、实际验证命令、停止/升级条件。DSH 返回改动文件、实际测试及结果、假设与未解决问题，不得削弱验收标准来通过测试。
- 一份工作目录同一时间只有一个写入者。并行实现用独立 worktree/目录；审查针对稳定快照。不要在 DSH 尚可能写入时由 Codex 接管原目录。
- 工具存在时使用 `dsh_local` MCP；不在当前工具集时使用本项目的 `bridge/invoke.mjs`，不假装已注册 MCP。两种方式必须使用同一配置和持久状态。

## 4. 执行、恢复与验收

先读 [references/reliability.md](references/reliability.md) 处理长任务或异常；工具参数与任务模板见 [references/task-contract.md](references/task-contract.md)。

1. 在写入者目录以外保存原始任务包、唯一 taskId/operationId 和 checkpoint，再提交。记录 sessionId/requestId。
2. `dsh_wait` 每次最多 30 秒。观察失败先恢复 Host，再查询**原 taskId/requestId**。响应丢失不等于未执行，不能新建任务盲目重发。
   新版 bridge 支持 `detail: "summary"` 和上次 `afterCursor`，轮询优先使用以减少重复历史；结束、错误或需要原文证据时读一次 `detail: "full"`。旧 MCP 不支持这些参数时按原 schema 调用，不盲目重试；状态相同不重读源码/日志。summary 保留当前请求、结束原因、所有待审批/问题，不能作为省略验收的理由。
3. 需要用户审批或回答时展示真实 DSH Web 待办；不自动批准、不把等待当崩溃。DSH sandbox 的 EPERM 等环境限制交给主 Codex 执行对应检查，不循环升级权限。
4. DSH 返回后检查当前 turn、队列、后台 jobs 和有关本地进程是否仍可能写入。完成响应本身不是正确性或空闲证明。主 Codex 检查真实文件/diff 并复跑适用检查，再安排必要审查。
5. 修复有效问题，复跑受影响检查；只有严重问题或大改动才做定向复审。流程完成且任务空闲后释放 workspace claim。

缺 key、登录/配额失败、版本不兼容、服务持续失败：保存证据并转 Codex。若原写入者状态不明，只在另一个隔离目录做实现或做只读工作；解决原所有权后再合并。不得清锁、伪造结束事件或杀未知进程来恢复表面可用。

长任务在委派前、阶段完成后、上下文交接前及有进展时至少每五分钟保存 checkpoint。恢复后先读取 checkpoint 和实时状态，再继续原任务。后台恢复仅在 Codex 正执行任务时发生；关机、休眠、关闭应用后的自动唤醒需用户另行请求调度。

最终说明真实执行者、实际测试与结果、审查者、降级原因和未验证项。**安装成功、协议检查、真实模型执行、续作、独立测试和独立审查是不同证据状态。** 不把 mock 或脚本退出成功当成真实模型验证。既有用户授权决定发布/推送范围；本 skill 本身不额外授权发布、部署或发送消息。
