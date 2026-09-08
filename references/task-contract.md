# DSH 工具与任务模板

工具存在时使用 MCP；否则在 skill 安装目录执行 `node bridge/invoke.mjs 工具名 参数文件绝对路径`。输入文件为 UTF-8 JSON；先保存再调用。无参数工具可不传文件。认证和 key 不进入参数。

| 工具 | 参数 |
|---|---|
| dsh_host_status | `{}` |
| dsh_delegate | `{"taskId":"feature-001","cwd":"项目绝对路径","prompt":"完整任务包"}` |
| dsh_status | `{"taskId":"feature-001"}` |
| dsh_wait | `{"taskId":"feature-001","seconds":20}`（0–30） |
| dsh_followup | `{"taskId":"feature-001","operationId":"fix-001","prompt":"修复包"}` |
| dsh_cancel | `{"taskId":"feature-001"}` |
| dsh_release_workspace | `{"taskId":"feature-001"}` |

taskId/operationId 只用 `[A-Za-z0-9_-]`，长度 1–100。taskId 复用仅限同 cwd/同原 prompt；operationId 复用仅限相同 prompt 的原操作观察。重试是否提交由持久记录决定，不由上一条聊天回复猜测。

任务包的实际内容：

```text
目标与原始需求：
绝对 cwd 与基线 revision：
当前写入者：DSH（其他参与者只读）
允许修改路径：
接口/数据约束与不能弱化的验收条件：
适用项目指令：
实际测试命令及预期可观察结果：
停止条件：扩大范围、需要凭据或外部写入时报告；环境阻塞时保存证据，不无限重试。
交付：修改文件、真实测试结果、未解决项、假设；不得把未运行检查写成通过。
```

接入层 workspace claim 是合作锁，不是 OS 沙箱。工作目录的 realpath 必须位于明确允许根下；不允许 symlink 绕过白名单，不自动扩充根。默认不会自动批准 DSH Web 里的权限或问题。

## 精简观察参数（可选，向后兼容）

新版 dsh_status / dsh_wait 接受 detail: "summary" 和 afterCursor（上次返回的 cursor）。首次不传 afterCursor；后续传上次 cursor。summary 只带新进展摘要，保留当前请求、结束原因、审批/问题、错误与诊断；它不证明文件正确或 workspace 已空闲。终态、阻塞或需要详细证据时再取 detail: "full"。旧版本 schema 没有这些参数就继续旧调用，不以错误重试来探测。CLI 把相同 JSON 参数保存到文件再传给 bridge/invoke.mjs。

```json
{"taskId":"existing-task-id","seconds":20,"detail":"summary","afterCursor":100}
```

这只精简发回主模型的内容，不减少 Host 内部读取的完整事件，也不承诺具体 token 节省。示例 afterCursor 必须替换为真实返回值。
