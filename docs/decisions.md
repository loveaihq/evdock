# 规范没写清、自己做了选择的地方

依据：`docs/spec/design-sketch-2026-10-06.md`（下称"草案"）和 `docs/spec/standard-webhooks-2026-10-06.md`（下称"SW"）。草案改了要回来对一遍。

## M1

### 开工前和你确认过的

| # | 选择 | 理由 |
| --- | --- | --- |
| 1 | 时间戳两个方向都查：和收到时刻相差超过 300 秒就拒，正好 300 秒收 | 草案只说"超过 5 分钟旧"（SHOULD）。SW 说"在容差内"，官方 `standardwebhooks` 库两个方向都拒。超前的时间戳同样能用来延长重放窗口。 |
| 2 | 去重键是（路径令牌, `webhook-id`），不是只有 `webhook-id` | 草案规定事件的 `webhook-id` 就是 `eventId`，且 SHOULD 用上游稳定 id。同一个上游事件命中两个订阅时 `webhook-id` 相同，只按 `webhook-id` 去重会把第二个订阅的事件当重复丢掉。 |
| 3 | 测试套件每项标 MUST / SHOULD / MAY / 未规定，只有 MUST 失败算不合格 | 草案对各项要求的强度不同，见下面"测试套件"一节。 |
| 4 | 套件不加查库接口；"重复不入库"由 `npm test` 查表证明 | 套件是黑盒，只看得到状态码。 |
| 5 | `engines.node` 写 `>=22.13` | `node:sqlite` 从 22.5 才有，22.13 起不用加 `--experimental-sqlite`。 |
| 6 | Standard Webhooks 规范也存快照 | 草案的签名细节引用它。 |

### 接收端状态码

草案只规定了 2xx（已接受）、413（MAY）、503 或 425（未确认，SHOULD），以及 410 表示"这条别重试"。其余是自己选的：

| 情况 | 状态码 | 说明 |
| --- | --- | --- |
| body 超过 256 KiB | 413 | 大于 262144 字节拒，正好 262144 收。超限后把剩下的读完丢掉再回 413，客户端能拿到状态码，而不是连接被重置。已知限制见文末。 |
| 路径没登记 | 404 | 按普通失败处理。草案里 410 的意思是"认出了这条投递，但不想被重试"，没登记的路径谈不上认出。 |
| 缺四个必需头之一 | 400 | |
| `webhook-timestamp` 不是整数秒（只允许 1 到 15 位数字） | 400 | |
| 验签失败 | 401 | |
| 时间戳超出 5 分钟 | 401 | 服务端每次重试都会重新生成时间戳，回可重试的状态码就行。 |
| body 不是合法 UTF-8 的 JSON 对象，或字段类型不对 | 400 | 必须先验签通过才会走到这一步。 |
| verification，签名和时间戳都通过 | 200，body `{"challenge":"<原样>"}` | 不管订阅确认没有都回。 |
| 路径已登记，订阅未确认 | 503 | 草案允许 503 或 425，按 DESIGN.md 选 503。 |
| `X-MCP-Subscription-Id` 和登记的 id 不一致 | 503 | 属于草案说的"这个 id 还没告诉接收方怎么路由"，草案要求回 503 或 425 这类可重试的码。最初写的 400，审查后改成 503。 |
| 重复的 `webhook-id` | 200 | 草案也允许回 410，选 200。 |
| 读库或写库失败 | 503 | 让服务端重试。 |
| 不是 POST | 405 | |
| 不是 `/hooks/<令牌>` 路径 | 404 | 请求目标按纯字符串匹配，不当 URL 解析。请求目标是外部可控的，不一定是合法 URL。带协议和主机的完整写法（`http://host/hooks/…`）先去掉协议和主机再匹配，HTTP/1.1 要求服务器接受这种写法。 |

### 请求头

- Node 把头的原始字节当 latin1 字符串交出来。发送方按 UTF-8 编码（签名串前缀规定是 UTF-8），所以先还原成原始字节，再按 UTF-8 解码，之后才去验签和入库。非 ASCII 的 `webhook-id` 因此能正确验签。
- `webhook-signature` 如果分成多行重复的头发送，按空格合并成一个列表。HTTP 默认用 ", " 合并，会让第一个签名后面多出逗号而验不过。

### 检查顺序

body 大小（读 body 时）→ 路径是否登记 → 四个必需头 → 时间戳格式 → 验签 → 时间戳窗口 → 解析 body → verification 回显 → 订阅是否确认 → 订阅 id 是否一致 → 写盘。

- 验签放在解析 body 之前：草案要求"验签之后才处理"。
- 时间戳窗口放在验签之后：两者都会拒，顺序只影响回哪个码，先认身份再查新鲜度。
- verification 放在"订阅是否确认"之前：服务端在激活投递之前发 verification，失败时让 `events/subscribe` 直接返回 -32015，所以握手一定发生在 subscribe 返回之前，那时订阅还没确认。

### 密钥按路径选

草案说 `X-MCP-Subscription-Id` 是为了"不解析 body 就能选对密钥"。但 verification 到达时接收方还不知道订阅 id（理由同上），所以 evdock 按路径令牌选密钥；`X-MCP-Subscription-Id` 只在订阅确认后用来核对。

### 消息分类

- 顶层有 `type` 字段就是控制包，不管值是什么；`type` 不是字符串回 400。
- 未知的 `type`：回 200，存进收件箱（kind 记为 `unknown_control`）。草案要求接收端把控制包转交给客户端，以后新增的控制包类型不该被拒掉。
- 事件只检查：`eventId` 是非空字符串，`name` 和 `timestamp` 是字符串，`data` 是对象，`cursor` 是字符串或 null 或不存在。`timestamp` 不检查 ISO 8601 格式，`_meta` 和其他字段照存不检查。
- 不检查事件里的 `eventId` 是否等于 `webhook-id`，去重只按 `webhook-id`。
- 不检查 `name` 是否和订阅的事件名一致：M1 不知道订阅的是哪个事件，等 M2。
- `gap` 只检查 `cursor`；`terminated` 检查 `error.code` 是整数、`error.message` 是字符串。不合格回 400。

### 收件箱

- 三张表：`subscriptions`、`events`、`cursors`。`events` 除了事件，也存 gap、terminated 和未知类型的控制包（`kind` 列区分）。草案要求控制包"和事件走同一条通道"转交给客户端，M4 的输出端从这一张表读。
- verification 不入库，也不参与去重：服务端重发同一个 challenge 时要能再回显一次。
- body 存原始字节，不重新序列化。
- 开 WAL，`synchronous = FULL`。事务提交返回后才回 200。
- 游标：
  - 事件的 `cursor` 不为 null 才保存，覆盖旧值。草案规定 null 不能持久化；而且同一事件类型要么一直有游标，要么一直是 null。
  - 按到达顺序保存。草案说最近收到的游标总是安全的（它是水位线，不是这条事件自己的位置）。
  - 重复投递不动游标。
  - gap：`cursor` 不为 null 就覆盖保存，并且 `possible_gap = 1`；`cursor` 为 null 只做标记。`possible_gap` 由以后的消费方清除（M2/M4）。
- terminated：删掉订阅行，消息本身留在 `events` 表，作为给输出端的通知。之后这条路径的投递回 404。游标行保留：草案要求重新订阅时带上最后保存的游标（比如因为 schema 变更被 terminated 后重新订阅），删掉就找不回来了。要不要用它由 M2 决定。最初写的是连游标一起删，审查后改了。

### 签名

- 签名串：`webhook-id + "." + webhook-timestamp + "."` 按 UTF-8 编码，后面直接接原始 body 字节。时间戳用头里的原字符串，不重新格式化。
- `webhook-signature` 按单个空格切分，空项跳过；只认 `v1,` 开头的项，`v1a,` 等其他前缀忽略，哪怕值碰巧对得上。
- 比较的是 base64 字符串：长度不同直接判不等（SHA-256 的签名长度是公开的 44 字符），长度相同用 `timingSafeEqual`。
- 密钥：`whsec_` 后面必须是标准 base64（长度是 4 的倍数），解码后 24 到 64 字节。

和官方 `standardwebhooks` 库（1.1.1）的两处差别，测试里避开了：
- 库用 `parseInt` 解析时间戳后再格式化回字符串去签名，所以 `0017…` 这种头在库里和在这里结果不同。这里按草案签头里的原字符串。
- 库把 Buffer 形式的 body 先按 UTF-8 解码成字符串再签，非 UTF-8 字节会变。这里签原始字节。

### 日志

每个请求一行：状态码、结果、路径令牌前 6 位、`webhook-id`（不可见字符换成 `?`，截到 80 字符）。不记 body，不记密钥，不记完整令牌。不检查 `Content-Type`。

### 本地运行

- `evdock serve` 默认只监听 `127.0.0.1:8787`，明文 http。
- `evdock register` 是 M2 之前手工登记路径的临时命令，会把 `whsec_` 密钥打到 stdout，因为扮演服务端的测试套件需要它，相当于正式流程里 `events/subscribe` 把密钥交给服务端。只用于本地测试，M2 用订阅管理替换。

### 测试套件

套件扮演服务端，对一个接收地址发 15 个请求场景，只依赖 Node 自带模块，不引用 evdock 自己的代码。输出是英文，因为 M4 要提交到工作组仓库。

| 场景 | 等级 | 期望 | 等级依据 |
| --- | --- | --- | --- |
| valid-event | MUST | 2xx | 基线；这项不过，其余结果没有意义 |
| bad-signature | MUST | 非 2xx | 接收方 MUST 先验签再处理 |
| stale-timestamp | SHOULD | 非 2xx | 草案：SHOULD 拒绝超过 5 分钟的。用 10 分钟前，避开边界和时钟误差 |
| replay | SHOULD | 2xx，然后 2xx 或 410 | 去重是 SHOULD；黑盒只能看状态码 |
| retry | SHOULD | 2xx，然后 2xx 或 410 | 同上 |
| rotation | MUST | 两次都 2xx | 草案："任一签名通过即接受"。新旧顺序各测一次 |
| raw-body | MUST | 2xx | 接收方 MUST 对原始 body 算 HMAC |
| verification | MUST（有条件） | 2xx，且 body 的 challenge 一致 | 草案给了四种证明接收意愿的方式，握手只是其一。默认计入；接收方用白名单、带外登记或 well-known 文档时加 `--no-handshake`，这项就只记录不计入。最初是无条件计入，审查发现会把合规的接收方判成不合格，于是加了这个开关 |
| gap | MUST | 2xx | 接收端 MUST 转交控制包 |
| oversized | MAY | 413 | 草案：接收方 MAY 用 413 拒绝 |
| missing-webhook-id / -timestamp / -signature | MUST | 非 2xx | 缺了就没法验签；收下等于处理了未验证的数据 |
| missing-x-mcp-subscription-id | 未规定 | 只记录 | 草案只要求服务端带上，没说接收方缺了该怎么办 |
| terminated | MUST | 2xx | 同 gap。放在最后发，因为接收方收到后可能删掉订阅 |

退出码：0 合格，1 有 MUST 失败，2 用法错误。JSON 报告默认写到 `conformance-report.json`。表格下面列出每项的说明；基线 valid-event 没过时会额外提示：那些"期望被拒"的项显示通过也说明不了什么。

### 已知限制

- 超过 256 KiB 的 body 会一直读到结束，只受 Node 默认的 300 秒 `requestTimeout` 约束。M1 只在本机监听，影响不大。M3 中继面向公网，在那里加：`Content-Length` 超限直接拒，读取量设硬上限。
