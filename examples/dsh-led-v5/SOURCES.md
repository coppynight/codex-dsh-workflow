# 一手依据与推论边界

核对日期：2026-09-09。下列外部结果只用于判断方向是否值得试，不并入本项目成绩。

| 来源 | 可以支持的事实 | 不可以推出的结论 |
|---|---|---|
| [Anthropic：The advisor strategy](https://claude.com/blog/the-advisor-strategy) | 官方报告 Sonnet 4.6 主执行、Opus 4.6 顾问在 SWE-bench Multilingual 上相对 Sonnet 路径提升 2.7 个百分点、每任务成本下降 11.9%；注意文中的 thinking 配置差异 | 不是 DeepSeek + Astra 的结果，也不是通用 10 倍收益 |
| [SWE-Router 论文，Table 1](https://arxiv.org/html/2607.00053v1) | 其 500 题、75 步设定下，DeepSeek V3.2 为 62.4%、$22.6；Gemini 3 Pro 为 70.4%、$391.3。两项单模型基线之比约为 88.6% 得分、5.8% 费用 | 比值来自论文特定设置；不是本项目路由器、当前 Flash 型号或套餐权益的证明 |
| [TwinRouterBench 论文](https://arxiv.org/html/2605.18859v1) | 报告的训练路由器 75/100、$25.66；Opus 4.6 74/100、$54.73。另一规则路由器 73/100、$172.56，说明路由也可能变贵 | 不同 agent、模型与测试设定不能直接拼成我们的预期收益 |
| [DSH 原生 Codex 子代理](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent-codex/README.md) | DSH 已具备调用原生 Codex 的基础能力 | 所以“能调另一个 CLI”本身不是差异化价值；本地检查还发现需补充结构化计量、去重和恢复 |
| [DSH 原生 Claude Code 子代理](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent-claude-code/README.md) | 存在官方适配方向 | 本项目新原型未验证 Claude，不替代网络与账号资格要求 |

## 价格与工具

- [Astra 官方模型页](https://developers.openai.com/api/docs/models/gpt-6-astra)：标准输入 $10/M，
  缓存输入 $1/M，输出 $50/M。超 272K 输入请求有分档倍率；CLI 给的是 turn 汇总，无法确认
  逐请求档位时保持未知。请求型号明确与实际路由证据是两个字段。
- [DeepSeek 官方价格页](https://api-docs.deepseek.com/quick_start/pricing/)：Flash 峰时
  输入/缓存/输出为 $0.44/$0.014/$1.32 每 M，Pro 为 $1.32/$0.044/$3.96 每 M；非峰时一半。
  当前公布峰时为周一至周五 UTC 01:00–04:00、06:00–10:00；本轮统一冻结峰时价格比较，
  不把时段折扣当成调度收益。实际发票未核对。
- [Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)：使用官方原生 CLI
  和自身认证，保留普通执行工具及其审批机制；不使用 bypass。
- [Node 测试隔离选项](https://nodejs.org/download/release/v24.15.0/docs/api/cli.html#--test-isolationmode)：
  `--test-isolation=none` 让适用测试在同进程运行，不等于改变外层 agent 沙箱。

本地 DSH 0.1.2-rc.1 的官方 tokenUsage 投影与逐 turn 计量函数是本次 DSH 用量汇总依据。
每步累计最终值替换流式临时值，失败尝试单独累加，fork 继承事件不重复计量，实际子代理
另计。来源缺失、辅助调用未归属、实际路由不符或专家退出未知都会阻止“完整费用”结论。
费用实现与离线检查见 [prototype/usage.mjs](../../prototype/usage.mjs) 和
[prototype/accounting.test.mjs](../../prototype/accounting.test.mjs)。

外部材料与本轮实测共同支持继续研究廉价主执行和有限升级；并不支持发布“一个账号顶十个”
或把 API 等价费当成订阅额度。项目判断见 [DECISION.md](DECISION.md)。
