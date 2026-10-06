// `evdock serve`: the receiver, the refresh loop over every active subscription, the action
// executor (docs/M4-TASK.md), and, when a relay is configured, the loop that fetches what the
// relay stored (docs/M3-TASK.md).

import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describeError } from './events-api.js';
import { createReceiver } from './http.js';
import { Inbox, type Server, type Subscription } from './inbox.js';
import type { McpClient } from './mcp-client.js';
import { startActionRunner, type ActionRunnerOptions } from './actions.js';
import { handleDelivery } from './receiver.js';
import { relayFromInbox, type RelayClient } from './relay-client.js';
import { clientFromEnv, confirmPath, connect, label, refresh, releasePath, type Context } from './subscriptions.js';
import { printable } from './text.js';

/** Refresh once two thirds of the granted lifetime has passed. */
const REFRESH_AT = 2 / 3;
/** Never refresh one subscription more often than this, whatever the server grants. */
const MIN_REFRESH_INTERVAL_MS = 1000;
/** For a no-expiry grant: still refresh now and then, which is where the cursor advances. */
const NO_EXPIRY_REFRESH_MS = 60 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 1000;
/** How often to ask the relay for new deliveries (docs/M3-TASK.md, 设计决定 4). */
const RELAY_POLL_MS = 5000;

export interface DaemonOptions {
  dbPath: string;
  host?: string;
  port?: number;
  client?: (server: Server) => McpClient;
  /** The relay to fetch from. Default: the one configured in the database (`evdock relay use`); null for none. */
  relay?: RelayClient | null;
  /** How often to look for subscriptions due a refresh. */
  tickMs?: number;
  /** How often to poll the relay when it has nothing waiting. */
  pollMs?: number;
  /** Overrides for the action executor (tests). */
  actions?: ActionRunnerOptions;
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
  let relay: RelayClient | undefined;
  try {
    relay = options.relay === undefined ? relayFromInbox(inbox) : (options.relay ?? undefined);
  } catch (err) {
    inbox.close();
    throw err;
  }
  const ctx: Context = { inbox, client: options.client ?? clientFromEnv, now, log, relay };

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
  // Subscriptions still owed the startup resubscribe. The flag stays until it succeeds (or the
  // subscription stops or ends): a failed attempt must not fall back to a plain refresh, which
  // would leave the gap open (docs/M2-TASK.md, "规范缺口").
  const needsResubscribe = new Set<string>();

  function run(sub: Subscription): Promise<void> {
    const task = (async () => {
      let outcome;
      try {
        outcome = await refresh(ctx, await clientFor(sub.server ?? ''), sub, needsResubscribe.has(sub.token));
      } catch (err) {
        // Could not even connect (discover failed, token missing): retry like a failed refresh.
        const message = describeError(err);
        inbox.recordError(sub.token, message);
        log(`refresh of ${label(sub)} failed, will retry: ${message}`);
        outcome = 'failed' as const;
      }
      if (outcome === 'failed') {
        const failures = (retry.get(sub.token)?.failures ?? 0) + 1;
        const delay = Math.min(1000 * 2 ** (failures - 1), MAX_RETRY_DELAY_MS);
        retry.set(sub.token, { failures, nextAt: now() + delay });
      } else {
        retry.delete(sub.token);
        needsResubscribe.delete(sub.token);
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
  let stopped = false;

  // --- Relay fetch loop ---

  let pollTimer: NodeJS.Timeout | undefined;
  let polling: Promise<void> | undefined;
  let pollFailures = 0;

  // One batch: each delivery goes through the same checks as a direct POST, with the relay's
  // receive time for the timestamp window. Returns true if more is waiting.
  async function fetchBatch(relay: RelayClient): Promise<boolean> {
    const { deliveries, more } = await relay.fetchDeliveries();
    let upTo: number | undefined;
    for (const d of deliveries) {
      let outcome: string;
      try {
        const result = handleDelivery(inbox, { token: d.token, headers: d.headers, body: d.body, receivedAtMs: d.receivedAt });
        outcome = result.outcome;
        log(`${result.status} ${outcome} hook=${d.token.slice(0, 6)}… webhook-id=${printable(d.headers['webhook-id'] ?? '-', 80)} (relay #${d.seq})`);
      } catch (err) {
        // A bug, not a transient failure: one bad record must not block everything behind it.
        outcome = 'dropped';
        log(`dropped relay #${d.seq}: ${(err as Error).message}`);
      }
      // Only a local failure to store is worth fetching again; every other answer is final.
      if (outcome === 'store-failed' || outcome === 'inbox-unavailable') {
        if (upTo !== undefined) await relay.ack(upTo);
        return false;
      }
      upTo = d.seq;
      if (outcome === 'stored-terminated') {
        const sub = inbox.getSubscription(d.token);
        if (sub) await releasePath(ctx, sub);
      }
    }
    if (upTo !== undefined) await relay.ack(upTo);
    return more;
  }

  function schedulePoll(relay: RelayClient, delay: number): void {
    if (stopped) return;
    pollTimer = setTimeout(() => {
      polling = (async () => {
        let next = options.pollMs ?? RELAY_POLL_MS;
        try {
          if (await fetchBatch(relay)) next = 0; // more waiting: fetch again straight away
          pollFailures = 0;
        } catch (err) {
          pollFailures++;
          next = Math.min(next * 2 ** (pollFailures - 1), MAX_RETRY_DELAY_MS);
          if (!stopped) log(`relay fetch failed, retrying in ${Math.round(next / 1000)} s: ${(err as Error).message}`);
        }
        schedulePoll(relay, next);
      })();
    }, delay);
    pollTimer.unref();
  }

  if (relay) {
    // Make sure the relay stores events for every active subscription before anything is
    // re-sent: a confirmation can have been missed, or the relay may have lost its paths.
    await Promise.all(active().map((sub) => confirmPath(ctx, sub)));
    // Take in what the relay held while we were away before re-subscribing: the cursors those
    // deliveries carry are newer, so the resubscribe below replays less. (Run concurrently, the
    // resubscribe could read the old cursor first, then write back the server's older one.)
    try {
      while (await fetchBatch(relay)) {
        // keep going while the relay says more is waiting
      }
    } catch (err) {
      log(`relay fetch failed, continuing: ${(err as Error).message}`);
    }
  }

  // On start, replay from the saved cursor: anything abandoned by the server while we were down
  // would otherwise be lost (docs/M2-TASK.md, "规范缺口").
  const atStart = active();
  for (const sub of atStart) needsResubscribe.add(sub.token);
  await Promise.all(atStart.map(run));
  if (relay) schedulePoll(relay, 0);

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
      const retryAt = retry.get(sub.token)?.nextAt ?? 0;
      // A pending resubscribe goes on the backoff alone, not at the normal refresh point.
      const due = needsResubscribe.has(sub.token) ? retryAt : Math.max(refreshDue(sub), retryAt);
      if (now() >= due) void run(sub);
    }
  }, options.tickMs ?? 1000);
  // The receiver keeps `serve` alive; the timer alone should not.
  timer.unref();

  // Commands to run when messages arrive.
  const actions = startActionRunner(inbox, { now, log, ...options.actions });

  return {
    url,
    inbox,
    async stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(pollTimer);
      await actions.stop();
      await polling?.catch(() => {});
      receiver.closeAllConnections();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
      await Promise.allSettled(inFlight.values());
      inbox.close();
    },
  };
}
