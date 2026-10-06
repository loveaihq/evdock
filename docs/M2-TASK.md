# M2：订阅管理

2026-10-06 确认。

守护进程以 MCP 客户端身份向服务端订阅、续订、退订 webhook 事件，把 M1 的接收端接到真实的订阅上。仍然不带中继，回调地址直接指向本机接收端。

## 依据

- 事件扩展：以 `docs/spec/sep-3415-2026-10-06.md`（SEP-3415）为准。它是设计草案按 MCP 2026-07-28 改写的版本，webhook 的线上格式和草案完全一样，只改了三处：能力声明的位置、错误码编号、结果里加 `resultType`。M1 的接收端不受影响。
- MCP 基础协议：`docs/spec/mcp-2026-07-28/`。只支持 2026-07-28，不回退到 2025-11-25：SEP-3415 和 OpenAI 文档都只定义在 2026-07-28 上。
- OpenAI 的 MCP Events 文档：`docs/spec/openai-mcp-events-2026-10-06.md`（只在本地）。
- 三份文档不一致的地方按下面第 7 节处理。

## 交付

### 1. 规范快照

已存进 `docs/spec/`，来源和版本见 `docs/spec/README.md`。CLAUDE.md 的"先读"和"现在是 M1"跟着改。

### 2. 最小 MCP 客户端

- 只走 Streamable HTTP。每个请求都是 POST，带这些头：
  - `Content-Type: application/json`
  - `Accept: application/json, text/event-stream`
  - `MCP-Protocol-Version: 2026-07-28`
  - `Mcp-Method: <方法名>`
  - `Authorization: Bearer <令牌>`
- `params._meta` 带三项：
  - `io.modelcontextprotocol/protocolVersion`
  - `io.modelcontextprotocol/clientCapabilities`（声明 `extensions["io.modelcontextprotocol/events"]: {}`）
  - `io.modelcontextprotocol/clientInfo`
- 响应可能是 JSON，也可能是 SSE 流，两种都要处理。SSE 里先到的通知忽略，只取和请求 id 对应的那条响应。流断了，换一个新 id 重发。
- `resultType` 缺失时当作 `complete`；是别的值就报错。
- 先调 `server/discover`：
  - `supportedVersions` 里没有 2026-07-28 就报错。
  - 事件能力出现在 `capabilities.extensions["io.modelcontextprotocol/events"]`（SEP）或顶层 `capabilities.events`（草案、OpenAI 文档）都算支持。
  - 两处都没有，就不发任何 `events/*` 请求。
- 令牌只从环境变量读，库里只存环境变量名。日志里不打印令牌。

### 3. 订阅管理

命令行：

| 命令 | 作用 |
| --- | --- |
| `evdock server add <名字> --url <MCP 地址> --token-env <环境变量名>` | 登记一个服务端 |
| `evdock events <服务端>` | 调 `events/list`（按 `nextCursor` 翻页），列出支持 webhook 的事件 |
| `evdock subscribe <服务端> <事件名> [--args <JSON>] [--callback-base <地址>]` | 订阅，过程见下 |
| `evdock unsubscribe <订阅>` | 退订 |
| `evdock subscriptions` | 列出本地订阅：状态、refreshBefore、游标、是否可能漏事件 |
| `evdock serve` | 接收端 + 续订循环 |

`subscribe` 的过程：

1. 生成路径令牌和 32 字节的 `whsec_` 密钥，登记为"未确认"。
2. 调 `events/subscribe`：
   - `delivery` 为 `{mode: "webhook", url: <回调基址>/hooks/<令牌>, secret}`
   - `cursor` 为 `null`
   - 不带 `ttlMs`（用服务端默认），不带 `maxAgeMs`
3. 服务端在返回之前会发 verification，所以 `evdock serve` 必须已经在跑。M1 已经支持未确认的路径回显 challenge。
4. 成功：记下 `id`（订阅转为已确认）和 `refreshBefore`；`cursor` 不为 `null` 才存；`truncated: true` 时标记"可能漏了事件"。
5. 失败：删掉登记，报出错误名和 `data.reason`。

`unsubscribe`：发 `{name, arguments, delivery: {mode: "webhook", url}}`。服务端回 NotFound 也当作成功（OpenAI 文档要求退订幂等）。退订后本地订阅标记为已退订，已收到的消息保留。

`serve` 里的续订循环：

- 时机：从上次拿到授权算起，已授予时长过了 2/3 就续订。`refreshBefore` 为 `null` 时每小时续一次（因为不请求无期限，正常情况下不会出现）。
- 续订请求：`name`、`arguments` 和 `delivery`（同一个 url、同一个 secret）都不变，`cursor` 带最近保存的游标。
- 处理响应：
  - `cursor` 不为 `null` 就保存。
  - `truncated: true` 时标记"可能漏了事件"。
  - `deliveryStatus.active === false` 时在日志里告警，带上 `lastError` 类别。
  - `throttled` 记一条日志。
- 失败处理：
  - 网络错误或 5xx：退避重试，直到 `refreshBefore`。
  - Forbidden、NotFound（`kind: event`）、Unsupported：标记为已停止并记下原因，不自动重订。
- 收件箱里收到 terminated：停止续订这个订阅。

`serve` 启动时：每个游标不为 `null` 的活动订阅，先 `events/unsubscribe`，再带着保存的游标 `events/subscribe`，强制服务端从游标重放；游标为 `null` 的只做普通续订。为什么这么做，见下面"规范缺口"一节。

### 4. 收件箱改动

- `subscriptions` 表加列：服务端、事件名、arguments、回调 URL、状态（未确认 / 活动 / 已停止 / 已退订 / terminated）、refreshBefore、最后一次错误。新增 `servers` 表。
- terminated：从"删除订阅行"改为"标记为 terminated"，保留元数据，方便查看原因和手动重订。接收端对非活动的路径照旧回 404。
- 命令行和 `serve` 是两个进程，共用一个 SQLite 文件：设 `busy_timeout`。

### 5. 模拟服务端（测试套件的一部分，不引用 evdock 的代码）

按 SEP-3415 写，只做 webhook 模式：

- `server/discover`（能力放在 `extensions` 下）、`events/list`、`events/subscribe`、`events/unsubscribe`，静态 bearer 令牌。
- 可重放的"上游"：一个进程内的有序事件日志，游标就是日志里的位置。测试代码可以往里追加事件。
- 投递：
  - 每条都签名，载荷里的 `cursor` 按水位线计算。
  - 失败时指数退避重试，次数和时间窗口都可配，测试里调短。
  - 重试用尽就放弃，水位线越过这条事件。
- 订阅期限：按可配的默认 TTL 授予，测试里设几秒；过期后停止投递。
- verification 握手，结果按（principal, url）缓存。
- 游标早于保留窗口时，返回 `truncated: true`。
- 返回 `deliveryStatus`。
- 允许 http 回调和回环地址：只为本地测试，默认关闭，测试里显式打开。规范要求回调必须是 https，并且要拦截内网地址。

### 6. 按 OpenAI 文档写的示例服务端

照 OpenAI MCP Events 页面用 TypeScript 写，签名用 `standardwebhooks` 库，和页面上的 Node 示例一样。它和模拟服务端恰好是两种写法，正好都覆盖到：

- 能力声明在顶层 `capabilities.events`。
- 错误码用 `-32015`。
- 退订是幂等的。
- 不发 gap 和 terminated。
- 订阅持久保存。

同样需要上面那个允许 http 回调的测试开关。

### 7. 三份文档不一致时怎么处理

| 项 | 草案 | SEP-3415 | OpenAI 文档 | 客户端怎么做 |
| --- | --- | --- | --- | --- |
| 能力声明位置 | 顶层 `events` | `extensions["io.modelcontextprotocol/events"]` | 顶层 `events` | 两处都认 |
| 错误码 | -32011 到 -32015 | -32023 到 -32027（暂定） | -32015 | 两套编号都认，尽量按 `data` 区分情况 |
| `resultType` | 无 | 必带 | 无 | 有没有都接受 |
| 退订时找不到订阅 | NotFound | NotFound | 幂等，回 `{}` | NotFound 当作成功 |
| gap 和 terminated | 必须转交 | 必须转交 | 不支持 | 不依赖它们，靠续订响应的 `truncated` 和续订报错来发现 |

另外，草案的错误码落在基础规范 2026-07-28 划给"历史遗留"的区段里（-32000 到 -32019，"新的码 MUST NOT 分到这里"）。SEP-3415 正是为此把它们改了号。

## 规范缺口：重试用尽的事件会被悄悄跳过

依据（草案行号；SEP-3415 内容相同）：

- 服务端对每条事件的重试有上限，用尽就放弃。被放弃的事件在水位线上算作"已处理"（435–436 行）。
- 续订响应里的游标就是这条水位线（361 行），客户端照存（578 行）。
- 订阅还活着时，续订带的游标被当作空操作，不会触发重放（359 行）。

所以守护进程停机的时间一旦超过服务端的重试窗口，而订阅又还没过期，这段时间的事件就会被放弃。重启后的第一次续订拿到的是越过这些事件的游标，从此再也补不回来，而且服务端不会给出 `truncated`。M3 有了常驻中继，问题会小很多；M2 没有中继，正好会碰到。

处理办法：采用上面第 3 节的"启动时先退订、再带游标订阅"。退订之后订阅就不存在了。再订阅时，非 null 的游标表示要求从这个位置重放（359 行），服务端会用它新建订阅（362 行）。

另建议把这个缺口报给工作组。要不要发、用什么方式发，由你决定。

## 验收

1. `npm test` 全部通过，贴出输出。
2. 对模拟服务端和 OpenAI 文档示例服务端各跑一遍完整流程，贴出输出：
   1. discover
   2. list
   3. subscribe，握手成功
   4. 收到事件
   5. 至少续订两次（TTL 设短），且没有事件的这段时间里游标也在前进
   6. unsubscribe，之后不再收到事件
3. 重启不重不漏（对模拟服务端）：服务端持续产生 N 条事件，中途杀掉 `serve`，分三种停机时长再启动：
   - a. 短于重试窗口
   - b. 长于重试窗口、短于 TTL（就是上面那个缺口）
   - c. 长于 TTL
   
   每种都核对：收件箱里的 eventId 集合和服务端产生的完全相同，每个只出现一次。
4. 独立 subagent 的审查意见和处理结果。
5. `docs/decisions.md` 记下规范没写清、自己做了选择的地方。

## 不做

- 中继和 https（M3）
- 动作执行器和本地 MCP 服务（M4）
- OAuth（v0 不做）
- poll 和 push 两种投递方式
- 回退到 2025-11-25
- 密钥轮换
- 因 schema 变更被 terminated 后自动重订
- `maxAgeMs`
