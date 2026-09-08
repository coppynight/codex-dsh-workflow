# 安装、配置与首次运行

## 最小模式

Codex + 本 skill 即可使用主控和自查。可用时安排独立 Codex 子代理。DSH 和 Claude 均为可选依赖：缺失时说明能力降级，不阻塞全部任务。

README 的安装器只复制 skill，不下载第三方运行时、不修改全局 PATH、不覆盖 Codex 配置。后续命令在实际安装的 skill 目录执行。路径有空格时使用引号；脚本无需管理员权限。Windows 需要 PowerShell 和 Node.js 24+；macOS/Linux 需要 Node.js 24+ 与 `ps`。缺乏进程/端口观察权限时恢复会停止启动动作，继续 Codex。

## DSH 新机器设置

1. 在 skill 安装目录执行 `npm ci` 安装 MCP SDK 等依赖。
2. 执行 `node scripts/doctor.mjs --init --workspace "项目或专用项目父目录的绝对路径" --auto-start`。该目录必须存在。建议精确项目目录；只允许该目录或其后代。去掉 `--auto-start` 则只诊断，不自动启动。已存在配置不会覆盖；用本地编辑器修改。
3. 默认配置文件是 `~/.codex-dsh-workflow/config.json`，运行时是 `~/.codex-dsh-workflow/runtime`。把路径展开为本机绝对路径后执行：

   ```text
   npm install --prefix "DSH运行时绝对目录" --save-exact @deepseek-ai/dsh@0.1.2-rc.1
   ```

   安装失败时检查 Node/npm 版本、目录权限、网络和 registry。不要反复重装、改代理或使用来历不明镜像。保存错误类别并先用 Codex。首次成功后保存该运行时自己的 lockfile，升级时在独立目录验证，不覆盖有活动任务的运行时。
4. 执行 `node scripts/dsh-recover.mjs`。退出码 0 只说明 Host 连通；再执行 `node scripts/doctor.mjs --online-dsh` 查看所选 provider/model 是否就绪。
5. 首次模型未配置：使用 DSH 官方 Web 入口完成本地登录，然后在 **Settings/设置 → Models/模型** 中选择配置的服务商、填写该服务商 API key 并保存；设置入口名称可能随 DSH 版本变化。key 由使用者在自己的本地界面输入，不发聊天、不放任务包、Git、环境诊断输出或 MCP 参数。启动日志包含带本地认证的 URL，只由使用者在本地查看；代理不要打印/上传原始日志或带 token 链接。无 key 时 Codex 可继续。
6. 保存 key 后再次运行 `doctor --online-dsh`；如果服务商可路由但真实请求返回 401/403、余额不足或额度限制，仍视作模型不可用。请使用者在原服务商的本地/官方设置中处理；不要自动更换 key、provider、模型或购买额度。

`doctor` 默认只读本地文件，`--online-dsh` 只查询本地 Host 模型目录，不提交收费的模型任务。Catalog 就绪不能证明 key 有效或真实调用一定成功。

## 配置格式

除 `version` 外均可省略，采用脚本计算的本机默认值。以下路径需替换为目标机器的**绝对路径**，不可原样复制占位文字。Windows JSON 中建议使用 `/` 或转义后的 `\\`。

```json
{
  "version": 1,
  "dsh": {
    "installDir": "DSH安装目录的绝对路径",
    "origin": "http://127.0.0.1:3080",
    "homeDir": "DSH数据目录的绝对路径",
    "logPath": "Host标准输出日志文件的绝对路径",
    "stateDir": "接入层持久状态目录的绝对路径",
    "workspaceRoots": ["允许实现的项目绝对路径"],
    "autoStart": true,
    "model": {"provider": "deepseek-official", "model": "deepseek-v4-flash", "reasoningEffort": "high"}
  },
  "claude": {"model": "claude-opus-5"}
}
```

Claude 可选 `executable` 为绝对可执行文件路径或裸命令名；默认 Windows `claude.exe`，其他系统 `claude`。配置不接受密钥字段或永久网络确认。主版本或格式错误会明确失败，保留文件。系统时区自动读取，可用顶层 `timeZone` 明确指定 IANA 时区。

另一配置文件用 `WORKFLOW_CONFIG` 指定：PowerShell 用 `$env:WORKFLOW_CONFIG = '绝对路径'`；bash/zsh 用 `export WORKFLOW_CONFIG='/绝对路径'`。MCP 与 CLI 必须指向同一份配置、同一 `stateDir`，否则无法共享幂等记录和 workspace claim。运行中的会话不要更换状态目录。

**复用已有 DSH**：只调整 installDir、homeDir、logPath、stateDir、origin；保持已有桥接状态路径以延续老 taskId。不要复制另一台机器的 cookie、key、账号文件、host PID、锁或“网络已确认”记录。跨机器续作需保存任务与代码快照，在原写入者停止/空闲后才迁移；不直接搬运运行状态。

## MCP 与 CLI

无需注册 MCP 也可调用：

```text
node bridge/invoke.mjs list
node bridge/invoke.mjs dsh_host_status
node bridge/invoke.mjs dsh_delegate "已保存任务参数JSON的绝对路径"
```

希望注册 MCP 时，先检查现有 `dsh_local`，避免覆盖已用配置。依据目标 Codex 当前 `codex mcp --help`/设置界面添加 stdio 服务，command 为实际 Node 路径，args 为本 skill 的 `bridge/server.mjs` 绝对路径。可在命令支持时使用：`codex mcp add dsh_local -- node "bridge/server.mjs的绝对路径"`。自定义配置时同时设置该服务的 `WORKFLOW_CONFIG`。重载 Codex 后验证工具是否真实出现在工具列表；注册失败时继续用 CLI，既有记录不变。

## Claude

先完成 [SKILL.md](../SKILL.md) 的当前会话网络确认。未明确确认时连 `claude auth status` 都不运行。

确认后再检查 CLI 是否存在和版本是否兼容；安装使用 [Claude 官方安装文档](https://code.claude.com/docs/en/setup)。已配置模型仍须账号实际有权使用。本 helper 当前要求 CLI 2.1.219+；原生 CLI 优先，Windows `.cmd` 包装器不通过 shell 自动执行。命令不兼容或找不到可执行文件时用 Codex。

由使用者在自己的终端执行 `claude auth login --claudeai` 完成订阅登录，再由 helper 检查。不要索取登录 token 或浏览器授权码。本项目不自动切 API key 付费、不升级套餐，不把订阅开通当作登录成功或模型调用成功。
