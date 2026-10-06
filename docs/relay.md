# 中继：部署和使用

中继替守护进程收 webhook 投递并暂存，守护进程每 5 秒从中继取一次，所以内网不用开入站端口。中继有两种跑法，任选其一：

- **Cloudflare Worker**（推荐）：免费层够用，自带 https 和 `*.workers.dev` 域名，不用自己维护机器。
- **Node 主机**：任何能跑 Node 22 的公网机器，TLS 要自己解决。

设计和取舍见 `docs/M3-TASK.md`，实现细节见 `docs/decisions.md` 的 M3 一节。

## 中继密钥

守护进程和中继之间用一个"中继密钥"认证。生成一个足够长的随机串，例如：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

两边都放在环境变量里，不写进任何文件。下面用 `EVDOCK_RELAY_KEY` 作变量名。

## 跑法一：Cloudflare Worker

<!-- WORKER-SECTION -->

## 跑法二：Node 主机

```bash
EVDOCK_RELAY_KEY=<中继密钥> evdock relay serve --key-env EVDOCK_RELAY_KEY --host 127.0.0.1 --port 8788 --db relay.db
```

- 中继只提供明文 HTTP。MCP 服务端只往 https 地址投递，所以前面要有一层 TLS，比如反向代理（Caddy、nginx）或者隧道。
- 对外只需要暴露 `/hooks/` 和 `/relay/` 两个前缀。
- `relay.db` 存着还没被取走的投递，备份或迁移机器时连同 `-wal` 文件一起带走。

## 守护进程连上中继

```bash
evdock relay use https://<中继地址> --key-env EVDOCK_RELAY_KEY
EVDOCK_RELAY_KEY=<中继密钥> evdock serve
```

- 此后 `evdock subscribe` 默认把回调地址设在中继上，并在中继登记这条路径。
- `serve` 每 5 秒取一次；有积压时连续取，直到取完。
- 中继暂存的投递，守护进程处理完才会确认删除。守护进程离线多久都不会丢，前提是中继的存储没满（1 万条或 200 MB，满了中继回 503，服务端会重试）。
- `evdock relay clear` 取消中继。已有的订阅回调地址还在中继上，要换就退订再订。

## 检查

- `evdock subscriptions`：看每个订阅的状态、游标、有没有可能漏了事件。
- 中继日志每个请求一行：状态码、结果、路径令牌前 6 位、`webhook-id`。不会出现 body 和密钥。
