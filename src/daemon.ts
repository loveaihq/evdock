// `evdock serve`: the receiver plus the refresh loop over every active subscription.

import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createReceiver } from './http.js';
import { Inbox, type Server, type Subscription } from './inbox.js';
import type { McpClient } from './mcp-client.js';
import { clientFromEnv, connect, refresh, type Context } from './subscriptions.js';

/** Refresh once two thirds of the granted lifetime has passed. */
const REFRESH_AT = 2 / 3;
/** Never refresh one subscription more often than this, whatever the server grants. */
const MIN_REFRESH_INTERVAL_MS = 1000;
/** For a no-expiry grant: still refresh now and then, which is where the cursor advances. */
const NO_EXPIRY_REFRESH_MS = 60 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 1000;

export interface DaemonOptions {
  dbPath: string;
  host?: string;
  port?: number;
  client?: (server: Server) => McpClient;
  /** How often to look for subscriptions due a refresh. */
  tickMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Daemon {
  /** Base URL of the receiver, e.g. http://127.0.0.1:8787 */
  url: string;
  inbox: Inbox;
  stop(): Promise<void>;
}

/** When a subscription is next due, from its last grant. */
export function refreshDue(sub: Subscription): number {
  if (sub.grantedAt === null) return 0;
  if (sub.refreshBefore === null) return sub.grantedAt + NO_EXPIRY_REFRESH_MS;
  return sub.grantedAt + Math.max((sub.refreshBefore - sub.grantedAt) * REFRESH_AT, MIN_REFRESH_INTERVAL_MS);
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const inbox = new Inbox(options.dbPath);
  const ctx: Context = { inbox, client: options.client ?? clientFromEnv, now, log };

  // The receiver must be up first: re-subscribing may trigger a verification handshake.
  const receiver: HttpServer = createReceiver({ inbox, now, log });
  await new Promise<void>((resolve, reject) => {
    receiver.once('error', reject);
    receiver.listen(options.port ?? 8787, options.host ?? '127.0.0.1', () => resolve());
  });
  const address = receiver.address() as AddressInfo;
  const url = `http://${options.host ?? '127.0.0.1'}:${address.port}`;

  // One discovered client per server, kept for the life of the process.
  const clients = new Map<string, Promise<McpClient>>();
  const clientFor = (server: string) => {
    let client = clients.get(server);
    if (!client) {
      client = connect(ctx, server);
      client.catch(() => clients.delete(server));
      clients.set(server, client);
    }
    return client;
  };

  const inFlight = new Map<string, Promise<void>>();
  const retry = new Map<string, { failures: number; nextAt: number }>();

  function run(sub: Subscription, resubscribe: boolean): Promise<void> {
    const task = (async () => {
      let outcome;
      try {
        outcome = await refresh(ctx, await clientFor(sub.server ?? ''), sub, resubscribe);
      } catch (err) {
        // Could not even connect (discover failed, token missing): retry like a failed refresh.
        inbox.recordError(sub.token, (err as Error).message);
        log(`refresh of ${sub.subscriptionId ?? 'subscription'} failed, will retry: ${(err as Error).message}`);
        outcome = 'failed' as const;
      }
      if (outcome === 'failed') {
        const failures = (retry.get(sub.token)?.failures ?? 0) + 1;
        const delay = Math.min(1000 * 2 ** (failures - 1), MAX_RETRY_DELAY_MS);
        retry.set(sub.token, { failures, nextAt: now() + delay });
      } else {
        retry.delete(sub.token);
      }
    })()
      .catch(() => {
        // Only reachable once the inbox is closed on stop(); nothing left to record.
      })
      .finally(() => inFlight.delete(sub.token));
    inFlight.set(sub.token, task);
    return task;
  }

  const active = () => inbox.listSubscriptions().filter((s) => s.status === 'active' && s.server !== null);

  // On start, replay from the saved cursor: anything abandoned by the server while we were down
  // would otherwise be lost (docs/M2-TASK.md, "规范缺口").
  await Promise.all(active().map((sub) => run(sub, true)));

  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    let subs: Subscription[];
    try {
      subs = active();
    } catch {
      return;
    }
    for (const sub of subs) {
      if (inFlight.has(sub.token)) continue;
      const due = Math.max(refreshDue(sub), retry.get(sub.token)?.nextAt ?? 0);
      if (now() >= due) void run(sub, false);
    }
  }, options.tickMs ?? 1000);

  return {
    url,
    inbox,
    async stop() {
      stopped = true;
      clearInterval(timer);
      receiver.closeAllConnections();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
      await Promise.allSettled(inFlight.values());
      inbox.close();
    },
  };
}
