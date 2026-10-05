# M1：接收核心和一致性测试套件

本地运行，不带中继，不做订阅管理。做完后应该有一个能收、能验、能存的接收端，和一个能对任意接收端打分的模拟服务端。

## 交付

### 1. 项目骨架

- `package.json`（`"type": "module"`，`engines.node >= 22`）、`tsconfig.json`、`src/`、`test/`、`LICENSE`（MIT）、`.gitignore`
- `git init`，第一次提交只含骨架和规范快照

### 2. 规范快照

把草案原文存到 `docs/spec/design-sketch-<日期>.md`。后面每一条都对照它核实，下面列的细节如果和快照不一致，以快照为准并告诉我。

### 3. 验签

- 签名内容：`webhook-id + "." + webhook-timestamp + "." + 原始 body 字节`
- 密钥：`whsec_` 后面那段 base64 解码得到的字节
- 算法：HMAC-SHA256，结果 base64，带 `v1,` 前缀
- `webhook-signature` 里可能有多个用空格分开的签名，任一个 `v1,` 通过即接受；其他前缀（如 `v1a,`）忽略
- 常数时间比较
- 必须对原始字节验，不能先解析再序列化

### 4. 时间戳

`webhook-timestamp` 和"收到时刻"相差超过 5 分钟就拒收。"收到时刻"作为参数传入，不要直接读系统时间，M3 中继要用。

### 5. 去重

按 `webhook-id` 去重，用 SQLite 唯一索引实现。重复投递不重复入库，但仍回 2xx。

### 6. 消息分类

- body 顶层有 `type` 字段：控制包，分 `gap`、`terminated`、`verification`
- 没有 `type`：事件，字段 `eventId`、`name`、`timestamp`、`data`、可选的 `cursor`
- `cursor` 缺失等同于 `null`

### 7. 收件箱

SQLite 三张表：事件、订阅、游标。写盘成功之后才能回 2xx。

### 8. 本地 HTTP 接收端

`POST /hooks/<令牌>`。M1 用明文 http 就行，https 是 M3 中继的事。

| 情况 | 响应 |
| --- | --- |
| 验签通过，已写盘 | 200 |
| 重复的 `webhook-id` | 200，不重复入库 |
| verification 包，路径已登记 | 2xx，body 为 `{"challenge":"<原样回显>"}` |
| 路径已登记，订阅未确认 | 503 |
| body 超过 256 KiB | 413 |
| 缺少四个必需头之一 | 规范没定，自己选并记入 `docs/decisions.md` |
| 验签失败、时间戳过期、路径未登记 | 同上 |

四个必需头：`webhook-id`、`webhook-timestamp`、`webhook-signature`、`X-MCP-Subscription-Id`。

### 9. 一致性测试套件

一个命令行工具，扮演 MCP Events 服务端，对着给定的接收地址发下面这些情况，输出逐项通过或失败的表格和一份 JSON 报告。

- 正常投递
- 签名错误
- 时间戳过期
- 同一个 `webhook-id` 重放
- 重试：同一个 `webhook-id`，重新生成时间戳和签名
- 轮换期双签名，一新一旧
- body 的空白和键顺序与"规范化 JSON"不同（验证接收端确实对原始字节验签）
- verification 握手
- gap 控制包
- terminated 控制包
- 超大 body
- 缺必需头

它要能独立于 evdock 使用，别人拿去测自己的接收端也能跑。

## 验收

1. `npm test` 全部通过，贴出输出。
2. 测试套件对 evdock 自己的接收端全部通过，贴出报告。
3. 故意改坏三处再跑：签名、时间戳、重复 ID，三种都被拒，贴出输出。
4. 独立 subagent 的审查意见和处理结果。
5. `docs/decisions.md` 里列出所有规范没写清、自己做了选择的地方。

## 不做

订阅管理（M2）、中继和外连通道（M3）、动作执行器和本地 MCP 服务（M4）。
