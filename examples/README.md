# 公开案例与证据 · 2026-09-08

[开放探索 v4](exploration-v4/README.md)：拆解高耗时来源，真实对比推理强度与自测范围，保留最快但有缺陷的结果，以及模型审查误报；给出候选方向排序与否证实验。

## 最新：按任务分工评估成本与人工介入

[第三版实验](budget-v3/README.md)以「Astra 规划与验收、DeepSeek 执行」为目标重新记账：17/17 产物验收下，Astra 等价成本下降 37.7%，含 DeepSeek 的已记录成本下降 18.7%；双方人工请求均为 0，未证明干预减少。主控开销缺失与临时目录契约偏差均已披露。

## 历史实验

后续基线核查：[原生工具与工作流的真实差异](native-baseline-audit.md)。以下保留早期受控实验原始结果，它不代表完整原生 Codex 与 skill 的端到端比较；不预设省 token 是主要优势。

当前实测没有证明这套流程能在小任务上省 Astra token。两个配对案例的 Astra 子会话合计从 **30,743 增至 33,650（+9.46%）**，最终两条路径都通过验收。我们保留这个负结果，并把它用于改进路由。

有一个可观察的审查收益：日志脱敏的 DSH 实现通过可见自测，却误改了普通 `key=hello`。未看到独立断言的 Astra 审查修复了问题，独立验收由 11/12 变为 12/12。Astra 直接生成也通过 12/12，因此它证明审查对这次 DSH 结果有效，**不证明优于 Astra 单独完成**。

| 案例 | A：Astra 直接生成 tokens | B：DSH 后 Astra 审查 tokens | Astra 增加 | 最终独立验收 A / B | DSH tokens（单列） |
|---|---:|---:|---:|---|---:|
| 日志脱敏 | 15,365 | 16,505 | 7.42% | 12/12 · 12/12 | 276,172 |
| checkpoint 存储 | 15,378 | 17,145 | 11.49% | 18/18 · 18/18 | 358,048 |
| 合计 | 30,743 | 33,650 | 9.46% | 两条路径均通过 | 634,220 |

输入缓存也会被计数；表格不是账单估算。Astra 四个有效子会话的缓存命中均为 0。DSH 自测次数和完整工具上下文不同，不能直接比较两种模型的 token 效率。用量只覆盖指定阶段，不含本次主会话规划、委派、验收调用、页面制作和 DSH 自动会话标题。

## 证据怎么读

- [配对汇总与用量](results/paired.json)：输入、输出、缓存、用量来源、代码哈希、验收和阶段时间。每个案例目录保存两路代码、DSH 原始实现、原始 usage 字段摘录和实际模型请求文本。完整 JSONL 的哈希用于本地核对；不发布内部推理、账号环境或原始 Host 日志。
- [实验口径与勘误](benchmarks/PROTOCOL.md)：预先选定两例，顺序交替，单轮、不静默重跑。初次工具执行被策略拒绝，消耗 **75,381 Astra tokens** 且无实现，单列在 [pilot](results/pilot-environment-failure.json)，没有把它当作夸大收益的分母。后续双方均采用只读、无工具的 Astra 代码输出和统一执行验收。
- [验收勘误前记录](results/log-redaction/acceptance-before-spec-correction.json)：初版大写 JSON 键断言超出冻结需求，已从双方评分移除；未重跑模型。换行生成器语法错误在有效试验前修复。勘误时点和理由公开，不能称为完全未修改过的盲测。
- [恢复回归](results/reliability.json)：三个最小故障重建，故障版测试失败、修复版通过。它们是明确保护的回归证据，不是历史模型 A/B，也不是通用交付率。
- [精简轮询](results/poll-volume.json)：固定合成夹具的十次观察，124,600 → 18,504 字节，**减少 85.15%**。新输出保留请求、阻塞、结束与错误；最后仍取完整证据。字节量不能换称 token、账单或延迟收益。

DSH 用量摘自每条 `assistant/message.data.usage`，排除相同 `assistant/chunk` 的副本。官方安装包 `@deepseek-ai/dsh-llm` 的 `TokenUsage` 定义中，`inputTokens` 是未缓存输入，缓存字段另列；直接使用 `totalTokens`。Astra CLI 则用 `input_tokens + output_tokens`，其中 `cached_input_tokens` 已包含在 input 中，不重复相加。所有原始字段保留。

时间：日志 A 72.118 秒，B 的 DSH 298.759 秒 + Astra 97.044 秒；checkpoint A 49.665 秒，B 的 DSH 149.216 秒 + Astra 61.205 秒。为节省整个实验的等待，两例在独立目录中存在并发阶段；这些是阶段耗时，不是串行端到端交付时间，也不是速度结论。

执行偏差：checkpoint 的 DSH 创建后删除了临时自测脚本，超出了仅修改 solution.mjs 的任务约束；最终可见测试未被修改。日志 DSH 报告过一次 stdin 自测方式受限。这些事实不被最终通过掩盖；未知环境应先确认可用执行路径。最终验收只覆盖所列断言，并非穷尽原子写入、故障注入或所有输入组合。

## 本轮优化

1. 小任务优先 Codex 直接完成；明确实现成本大于委派/审查开销才路由 DSH。不为了流程形式强制加审查。
2. 权限与任务匹配后才启动外部执行者；一次策略拒绝就停该路径，保存证据。只读审查建议由有权限的执行者落实并验证。
3. `dsh_status` / `dsh_wait` 增加可选 `detail: "summary"` 与 `afterCursor`，避免反复读取长历史。默认 full 向后兼容；结束/阻塞时仍读完整证据并独立验收。

优化后完整项目的省量与交付率尚未测得。下一步目标是预先登记更大实现任务和真实集成任务，记录主控阶段用量、故障恢复、合入后验收、总时间及全部模型用量；若做修订实验，双方重跑、原结果保留。不能把本轮直接完成的小任务路由当成新增实测收益。

## 免费离线复现

Node.js 24+，在仓库执行：

```text
npm ci
npm test
node examples/benchmarks/replay-published.mjs
node examples/reliability/replay.mjs
node examples/reliability/poll-volume.mjs
node examples/build-site-data.mjs
```

`replay-published` 执行六份公开源码（含 DSH 原始实现的预期失败），验证结果与公开记录相符。回放不会调用模型或索要 key。重跑恢复回放会更新时间/平台字段；不应把自己机器的结果冒充原始运行。

## 重新运行模型案例

这会实际消耗模型额度；需要已配置的 Codex、DSH 和允许的工作目录。先读 PROTOCOL，使用全新绝对目录并保存每次结果。默认 CLI 可由 `CODEX_EXECUTABLE` 指定。本次请求的是 `gpt-6-astra / medium`，JSONL 未单独证明服务端最终模型，字段明确记为 requested。

```text
node examples/benchmarks/run-astra.mjs log-redaction implement "A运行目录绝对路径"
node examples/benchmarks/accept.mjs log-redaction "A运行目录绝对路径"
node examples/benchmarks/prepare-dsh.mjs log-redaction "B运行目录绝对路径" unique-task-id
node bridge/invoke.mjs dsh_delegate "B运行目录绝对路径/request.json"
```

按 skill 查询原 taskId；十分钟未结束则取消该 turn 并确认后台工作空闲，保留超时结果，不盲目重发。DSH 完成后独立验收，保存原实现与结果，再释放 claim；之后才能运行 `run-astra.mjs CASE review ABS_B` 与统一 `accept.mjs`。第二例交换 A/B 顺序。`accept.mjs` 自身退出 0 表示程序完成，实际通过与否必须读 JSON 的 `passed` 和 `details`。

页面数据由 `build-site-data.mjs` 从公开结果生成；不手工填写更好看的收益数。网站源代码位于 `site/`，通过三个系统 CI 后由 GitHub Actions 发布 Pages。
