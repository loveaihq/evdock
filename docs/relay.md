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

两边都放在环境变量里，不写进任何文件。下面用 `EVDOCK_RELAY_KEY` 作变量名，在跑命令的那个终端里设好：

| 终端 | 设置 |
|---|---|
| bash / zsh | `export EVDOCK_RELAY_KEY=<中继密钥>` |
| PowerShell | `$env:EVDOCK_RELAY_KEY = "<中继密钥>"` |
| cmd | `set EVDOCK_RELAY_KEY=<中继密钥>` |

下面的命令和 README 一样，在仓库目录里用 `node dist/src/cli.js` 运行（先 `npm run build`）。正文里说的 `evdock <命令>` 就是 `node dist/src/cli.js <命令>`。

## 跑法一：Cloudflare Worker

代码在 `relay-worker/`：一个 Worker 把所有请求交给一个带 SQLite 的 Durable Object，后者跑的就是 `src/relay/core.ts`。免费层只支持 SQLite 版的 Durable Object，配置里已经按这个写好了。

下面这些都要用你自己的 Cloudflare 账号，由你来做：

1. 注册 Cloudflare 账号，免费计划即可。
2. 登录 wrangler，会打开浏览器授权：
   ```bash
   npx wrangler login
   ```
3. 部署：
   ```bash
   npx wrangler deploy -c relay-worker/wrangler.jsonc
   ```
   部署成功后会打印地址，形如 `https://evdock-relay.<你的子域>.workers.dev`。在下一步设好密钥之前，中继对所有请求都回 500。
4. 设置中继密钥。按提示粘贴，密钥不会出现在命令行历史里：
   ```bash
   npx wrangler secret put RELAY_KEY -c relay-worker/wrangler.jsonc
   ```
5. 检查：
   ```bash
   curl -i https://evdock-relay.<你的子域>.workers.dev/relay/deliveries
   ```
   应该返回 401，因为没带密钥。

注意：

- **免费额度。** 每天 10 万次请求，守护进程每 5 秒取一次，约用掉 18%。超出不会扣费，只会在 UTC 0 点之前返回错误。这期间服务端的投递会失败，重试用尽的事件会被服务端放弃（就是上报给工作组的那个规范缺口）。额度恢复后重启一次 `evdock serve`，它会带着保存的游标重订，把这些事件补回来。
- **Cloudflare 自己的日志。** `wrangler tail` 和 Workers Logs 会记录请求地址，里面有完整的路径令牌（evdock 自己的日志行只记前 6 位）。这些日志在你自己的账号里。拿到令牌的人能往这条路径塞投递，但塞进来的都过不了守护进程的验签，最多占点存储和请求额度。
- **本地试跑。** 不用账号：`npm run test:worker` 会用 `wrangler dev` 在本机起一个 Worker 跑完整测试，全程不联网。

## 跑法二：Node 主机

```bash
node dist/src/cli.js relay serve --key-env EVDOCK_RELAY_KEY --host 127.0.0.1 --port 8788 --db relay.db
```

- 中继只提供明文 HTTP。MCP 服务端只往 https 地址投递，所以前面要有一层 TLS，比如反向代理（Caddy、nginx）或者隧道。
- 对外只需要暴露 `/hooks/` 和 `/relay/` 两个前缀。
- `relay.db` 存着还没被取走的投递，备份或迁移机器时连同 `-wal` 文件一起带走。

## 守护进程连上中继

```bash
node dist/src/cli.js relay use https://<中继地址> --key-env EVDOCK_RELAY_KEY
node dist/src/cli.js serve
```

- 此后 `evdock subscribe` 默认把回调地址设在中继上，并在中继登记这条路径。
- `serve` 每 5 秒取一次；有积压时连续取，直到取完。
- 中继暂存的投递，守护进程处理完才会确认删除。守护进程离线多久都不会丢，前提是中继一直可用、存储没满（1 万条或 200 MB，满了中继回 503，服务端会重试）。
- `evdock relay clear` 取消中继，`evdock relay use <新地址>` 换中继。只要还有订阅的回调地址在当前中继上，这两个命令都会拒绝并列出这些订阅：否则服务端会继续往旧中继投递、拿到 2xx，却再也没人去取。先退订它们，换好中继后再重新订阅。

## 检查

- `evdock subscriptions`：看每个订阅的状态、游标、有没有可能漏了事件。
- 中继日志每个请求一行：状态码、结果、路径令牌前 6 位、`webhook-id`。不会出现 body 和密钥。
