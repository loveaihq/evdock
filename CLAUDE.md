# evdock

让不在公网上的 agent 也能收 MCP Events 的 webhook 投递。设计见 `DESIGN.md`。

## 先读

1. `DESIGN.md`：设计。按它做；要偏离，先停下来说明原因并等确认。
2. `docs/M1-TASK.md`：当前任务。
3. 规范草案（会改）：
   https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md
   开工第一步把原文存成 `docs/spec/design-sketch-<日期>.md`。之后协议细节一律对照这份本地快照，不凭记忆写。

## 技术决定

- TypeScript，Node 22，ESM。
- 存储用 Node 自带的 `node:sqlite`。测试用 Node 自带的 `node:test`。
- 验签用 `node:crypto` 自己实现；测试里用官方 `standardwebhooks` 库做独立对照。
- 依赖越少越好。加任何运行时依赖前先说明理由。
- 许可证 MIT。只用免费的工具和服务。

## 范围

- 一次只做一个里程碑。现在是 M1。不要提前做 M2 到 M4 的内容。
- `DESIGN.md` 里"v0 不做"的不做。
- 只做任务要求的，不顺手加功能、加配置项、加抽象层。

## 完成的标准

- 跑测试，贴出真实输出。不接受"应该能通过"。
- 规范没写清楚的地方，在 `docs/decisions.md` 里记下选了什么、为什么。
- 里程碑收尾时起一个独立的 subagent 做审查：对照规范快照，逐条核对接收方的要求。审查通过才算完成，审查意见和处理结果一并报告。

## 安全

- 签名密钥只存在于守护进程。日志里不打印密钥，也不打印完整 body。
- 事件内容一律当不可信数据处理。
