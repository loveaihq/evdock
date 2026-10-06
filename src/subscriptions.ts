// Subscribe, refresh and unsubscribe against an MCP server (docs/M2-TASK.md section 3), and keep
// the relay's receive paths in step when the callback goes through a relay (docs/M3-TASK.md).

import { randomBytes } from 'node:crypto';
import {
  describeError,
  errorName,
  subscribe as callSubscribe,
  unsubscribe as callUnsubscribe,
  type SubscribeResult,
} from './events-api.js';
import type { Inbox, Server, Subscription } from './inbox.js';
import { McpClient, supportsEvents } from './mcp-client.js';
import type { RelayClient } from './relay-client.js';
import { printable } from './text.js';

export interface Context {
  inbox: Inbox;
  /** Builds a client for a registered server. */
  client: (server: Server) => McpClient;
  now: () => number;
  log: (line: string) => void;
  /** The configured relay, if any. */
  relay?: RelayClient;
}

/** The default client factory: the bearer token comes from the environment variable named for the server. */
export function clientFromEnv(server: Server): McpClient {
  const token = process.env[server.tokenEnv];
  if (!token) throw new Error(`environment variable ${server.tokenEnv} (token for ${server.name}) is not set`);
  return new McpClient({ url: server.url, token });
}

/** Builds a client and checks the server speaks 2026-07-28 and advertises Events. */
export async function connect(ctx: Context, serverName: string): Promise<McpClient> {
  const server = ctx.inbox.getServer(serverName);
  if (!server) throw new Error(`unknown server ${serverName}; add it with: evdock server add`);
  const client = ctx.client(server);
  // SEP-3415: a client MUST NOT send events/* to a server that has not advertised the extension.
  if (!supportsEvents(await client.discover())) throw new Error(`${serverName} does not advertise the Events extension`);
  return client;
}

/** Removes the subscription's receive path from the relay, if it has one there. Failures are only logged. */
export async function releasePath(ctx: Context, sub: Subscription): Promise<void> {
  if (!ctx.relay?.carries(sub)) return;
  try {
    await ctx.relay.deletePath(sub.token);
  } catch (err) {
    ctx.log(`could not remove ${label(sub)}'s path from the relay: ${(err as Error).message}`);
  }
}

/**
 * Tells the relay to store events for this path. Idempotent; repeated after every refresh and
 * on daemon start, so a missed confirmation (or a relay that lost its paths) heals by itself.
 */
export async function confirmPath(ctx: Context, sub: Subscription): Promise<void> {
  if (!ctx.relay?.carries(sub)) return;
  try {
    await ctx.relay.setPath(sub.token, 'confirmed');
  } catch (err) {
    ctx.log(`could not confirm ${label(sub)} on the relay, will retry: ${(err as Error).message}`);
  }
}

/** How a subscription is named in logs and CLI output: never the secret, never the full path token. */
export function label(sub: Subscription): string {
  // The subscription id comes from the server.
  return sub.subscriptionId ? printable(sub.subscriptionId, 100) : `${sub.token.slice(0, 6)}…`;
}

function report(ctx: Context, sub: Subscription, result: SubscribeResult): void {
  if (result.truncated && result.cursor !== null) {
    ctx.log(`${label(sub)}: server skipped events (truncated); marked as a possible gap`);
  }
  const status = result.deliveryStatus;
  if (status?.active === false) {
    ctx.log(`${label(sub)}: WARNING delivery suspended by the server (lastError=${printable(status.lastError, 40)})`);
  }
  if (status?.throttled === true) ctx.log(`${label(sub)}: server is throttling deliveries`);
}

function callParams(sub: Subscription) {
  if (!sub.eventName || sub.arguments === null || !sub.callbackUrl) {
    throw new Error(`${label(sub)} was not created by evdock subscribe; nothing to refresh`);
  }
  return {
    name: sub.eventName,
    arguments: JSON.parse(sub.arguments) as Record<string, unknown>,
    url: sub.callbackUrl,
    secret: sub.secret,
  };
}

export interface NewSubscriptionRequest {
  server: string;
  eventName: string;
  arguments: Record<string, unknown>;
  /** Public base URL of the receiver; the path /hooks/<token> is appended. Defaults to the relay. */
  callbackBase?: string;
}

/**
 * Creates a subscription. The path is registered as pending first, locally and on the relay if
 * the callback goes through one: the server verifies the endpoint before answering. Without a
 * relay, `evdock serve` must be running to echo the challenge.
 */
export async function subscribe(ctx: Context, req: NewSubscriptionRequest): Promise<Subscription> {
  const client = await connect(ctx, req.server);
  const callbackBase = req.callbackBase ?? ctx.relay?.url;
  if (!callbackBase) throw new Error('no callback address: configure a relay or pass --callback-base');
  const token = randomBytes(24).toString('base64url');
  const secret = `whsec_${randomBytes(32).toString('base64')}`;
  const url = `${callbackBase.replace(/\/+$/, '')}/hooks/${token}`;
  ctx.inbox.addSubscription(
    {
      token,
      secret,
      server: req.server,
      eventName: req.eventName,
      arguments: JSON.stringify(req.arguments),
      callbackUrl: url,
    },
    ctx.now(),
  );

  const pending = ctx.inbox.getSubscription(token)!;
  let result: SubscribeResult;
  try {
    // Pending on the relay: it echoes the handshake but answers events 503 until confirmed.
    if (ctx.relay?.carries(pending)) await ctx.relay.setPath(token, 'pending');
    result = await callSubscribe(client, { name: req.eventName, arguments: req.arguments, url, secret, cursor: null });
  } catch (err) {
    ctx.inbox.deleteSubscription(token);
    await releasePath(ctx, pending);
    throw err;
  }
  // Locally active first, then confirmed on the relay: anything the relay stores from then on
  // has an active subscription to land in.
  ctx.inbox.applyGrant(token, result, ctx.now());
  const sub = ctx.inbox.getSubscription(token)!;
  report(ctx, sub, result);
  // Until confirmed, the relay answers events 503 and the server's retries run down; the next
  // chance after this is the first refresh. So try a few times now.
  if (ctx.relay?.carries(sub)) {
    for (let attempt = 1; ; attempt++) {
      try {
        await ctx.relay.setPath(token, 'confirmed');
        break;
      } catch (err) {
        if (attempt === 3) {
          ctx.log(`WARNING could not confirm ${label(sub)} on the relay (${(err as Error).message}); events get 503 until the next refresh confirms it`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  return sub;
}

/** Errors after which refreshing again cannot help. Anything else is retried. */
const PERMANENT = new Set(['Forbidden', 'NotFound', 'Unsupported', 'InvalidParams', 'MethodNotFound']);

export type RefreshOutcome = 'refreshed' | 'stopped' | 'failed' | 'ended';

/**
 * Re-calls events/subscribe with the same key and the last saved cursor.
 *
 * With `resubscribe`, it first unsubscribes so the server creates a fresh subscription that
 * replays from the saved cursor. While a subscription is live the server ignores the cursor,
 * and events whose retries ran out while evdock was down are skipped without `truncated`
 * (docs/M2-TASK.md, "规范缺口"). Only useful when there is a cursor to replay from.
 */
export async function refresh(
  ctx: Context,
  client: McpClient,
  sub: Subscription,
  resubscribe = false,
): Promise<RefreshOutcome> {
  try {
    const params = callParams(sub);
    const cursor = ctx.inbox.cursor(sub.token)?.cursor ?? null;
    if (resubscribe && cursor !== null) await callUnsubscribe(client, params);
    const result = await callSubscribe(client, { ...params, cursor });
    if (!ctx.inbox.applyGrant(sub.token, result, ctx.now())) {
      // It ended while this call was in flight (`evdock unsubscribe`, or a terminated envelope),
      // and the call may have re-created it on the server: unsubscribe so the server stops posting.
      await callUnsubscribe(client, params).catch(() => {});
      await releasePath(ctx, sub);
      return 'ended';
    }
    report(ctx, sub, result);
    await confirmPath(ctx, sub);
    const until = result.refreshBefore === null ? 'no expiry' : new Date(result.refreshBefore).toISOString();
    ctx.log(`${resubscribe && cursor !== null ? 'resubscribed' : 'refreshed'} ${label(sub)} until ${until}`);
    return 'refreshed';
  } catch (err) {
    const message = describeError(err);
    if (PERMANENT.has(errorName(err) ?? '')) {
      ctx.inbox.stopSubscription(sub.token, message);
      ctx.log(`stopped ${label(sub)}: ${message}`);
      await releasePath(ctx, sub);
      return 'stopped';
    }
    ctx.inbox.recordError(sub.token, message);
    ctx.log(`refresh of ${label(sub)} failed, will retry: ${message}`);
    return 'failed';
  }
}

/** Calls events/unsubscribe (a missing subscription counts as success) and marks it unsubscribed locally. */
export async function unsubscribe(ctx: Context, sub: Subscription): Promise<void> {
  if (sub.status === 'active' || sub.status === 'pending' || sub.status === 'stopped') {
    const client = await connect(ctx, sub.server ?? '');
    const { name, arguments: args, url } = callParams(sub);
    await callUnsubscribe(client, { name, arguments: args, url });
  }
  ctx.inbox.setStatus(sub.token, 'unsubscribed');
  await releasePath(ctx, sub);
}
