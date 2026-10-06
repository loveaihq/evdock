// SQLite inbox: servers, subscriptions, received messages (events and control envelopes), cursors.
// A write returns only after the transaction commits; callers answer 2xx after that.
// The CLI and `evdock serve` are separate processes sharing this file.

import { DatabaseSync } from 'node:sqlite';
import type { Message } from './classify.js';
import { printable } from './text.js';

/**
 * pending: path registered, events/subscribe not answered yet (verification is echoed, events get 503).
 * active: confirmed and refreshed. stopped: refresh hit a permanent error. unsubscribed / terminated: ended.
 */
export type SubscriptionStatus = 'pending' | 'active' | 'stopped' | 'unsubscribed' | 'terminated';

export interface Subscription {
  token: string;
  secret: string;
  /** Server-derived id from the subscribe response; null until confirmed. */
  subscriptionId: string | null;
  status: SubscriptionStatus;
  server: string | null;
  eventName: string | null;
  /** Subscription arguments as JSON text, re-sent unchanged on every refresh. */
  arguments: string | null;
  callbackUrl: string | null;
  /** Epoch ms of the granted expiry; null for no expiry or not granted yet. */
  refreshBefore: number | null;
  /** Epoch ms when the current grant was received. */
  grantedAt: number | null;
  lastError: string | null;
}

export interface NewSubscription {
  token: string;
  secret: string;
  server?: string;
  eventName?: string;
  arguments?: string;
  callbackUrl?: string;
}

export interface Server {
  name: string;
  url: string;
  /** Name of the environment variable holding the bearer token. The token itself is never stored. */
  tokenEnv: string;
}

export interface RelaySetting {
  /** Base URL of the relay, e.g. https://evdock-relay.example.workers.dev */
  url: string;
  /** Name of the environment variable holding the relay key. */
  keyEnv: string;
}

export interface Grant {
  id: string;
  refreshBefore: number | null;
  cursor: string | null;
  truncated: boolean;
}

/** Everything except verification, which is answered and never stored. */
export type StoredMessage = Exclude<Message, { kind: 'verification' }>;

export interface StoreInput {
  token: string;
  subscriptionId: string;
  webhookId: string;
  message: StoredMessage;
  body: Buffer;
  receivedAtMs: number;
}

export interface MessageRow {
  seq: number;
  token: string;
  subscriptionId: string;
  webhookId: string;
  kind: StoredMessage['kind'];
  eventId: string | null;
  cursor: string | null;
  body: Uint8Array;
  receivedAt: number;
}

export interface CursorRow {
  cursor: string | null;
  possibleGap: boolean;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS servers (
  name TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  token_env TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS subscriptions (
  token TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  subscription_id TEXT,
  status TEXT NOT NULL,
  server TEXT,
  event_name TEXT,
  arguments TEXT,
  callback_url TEXT,
  refresh_before INTEGER,
  granted_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_id TEXT,
  name TEXT,
  event_timestamp TEXT,
  cursor TEXT,
  body BLOB NOT NULL,
  received_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS events_dedup ON events (token, webhook_id);
CREATE TABLE IF NOT EXISTS cursors (
  token TEXT PRIMARY KEY,
  cursor TEXT,
  possible_gap INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) STRICT;
`;

interface SubscriptionRow {
  token: string;
  secret: string;
  subscription_id: string | null;
  status: SubscriptionStatus;
  server: string | null;
  event_name: string | null;
  arguments: string | null;
  callback_url: string | null;
  refresh_before: number | null;
  granted_at: number | null;
  last_error: string | null;
}

function toSubscription(r: SubscriptionRow): Subscription {
  return {
    token: r.token,
    secret: r.secret,
    subscriptionId: r.subscription_id,
    status: r.status,
    server: r.server,
    eventName: r.event_name,
    arguments: r.arguments,
    callbackUrl: r.callback_url,
    refreshBefore: r.refresh_before,
    grantedAt: r.granted_at,
    lastError: r.last_error,
  };
}

export class Inbox {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // There is no migration: nothing was deployed before M2. An M1 file is refused rather than misread.
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('subscriptions')").all() as Array<{ name: string }>;
    if (columns.length > 0 && !columns.some((c) => c.name === 'status')) {
      this.db.close();
      throw new Error(`${path} was created by an older evdock; delete it and start again`);
    }
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  addServer(server: Server): void {
    this.db
      .prepare(
        `INSERT INTO servers (name, url, token_env) VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET url = excluded.url, token_env = excluded.token_env`,
      )
      .run(server.name, server.url, server.tokenEnv);
  }

  /** The relay this daemon uses, if any. The key itself is never stored: only the variable that holds it. */
  getRelay(): RelaySetting | undefined {
    const rows = this.db.prepare("SELECT key, value FROM settings WHERE key IN ('relay.url', 'relay.keyEnv')").all() as Array<{
      key: string;
      value: string;
    }>;
    const get = (key: string) => rows.find((r) => r.key === key)?.value;
    const url = get('relay.url');
    const keyEnv = get('relay.keyEnv');
    return url && keyEnv ? { url, keyEnv } : undefined;
  }

  setRelay(relay: RelaySetting | undefined): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("DELETE FROM settings WHERE key IN ('relay.url', 'relay.keyEnv')").run();
      if (relay) {
        const put = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
        put.run('relay.url', relay.url);
        put.run('relay.keyEnv', relay.keyEnv);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Already rolled back.
      }
      throw err;
    }
  }

  getServer(name: string): Server | undefined {
    const row = this.db.prepare('SELECT name, url, token_env FROM servers WHERE name = ?').get(name) as
      | { name: string; url: string; token_env: string }
      | undefined;
    return row && { name: row.name, url: row.url, tokenEnv: row.token_env };
  }

  /** Registers a receive path as pending. */
  addSubscription(sub: NewSubscription, nowMs = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO subscriptions (token, secret, status, server, event_name, arguments, callback_url, created_at)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(
        sub.token,
        sub.secret,
        sub.server ?? null,
        sub.eventName ?? null,
        sub.arguments ?? null,
        sub.callbackUrl ?? null,
        nowMs,
      );
  }

  /** Marks a path active under the server-derived id, without a grant (tests and hand-registered paths). */
  confirmSubscription(token: string, subscriptionId: string): void {
    const result = this.db
      .prepare("UPDATE subscriptions SET subscription_id = ?, status = 'active' WHERE token = ?")
      .run(subscriptionId, token);
    if (result.changes === 0) throw new Error('no subscription registered at that path');
  }

  /**
   * Records a subscribe/refresh response: the subscription becomes active under the returned id,
   * a non-null cursor is saved, and truncated marks a possible gap. truncated with a null cursor
   * is ignored: the type has no replay, so there is no position to have skipped past (SEP 709).
   * Ignored altogether (returns false) if the subscription ended meanwhile, e.g. a terminated
   * envelope arrived or `evdock unsubscribe` ran during the call.
   */
  applyGrant(token: string, grant: Grant, nowMs = Date.now()): boolean {
    const gap = grant.truncated && grant.cursor !== null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.db
        .prepare(
          `UPDATE subscriptions SET subscription_id = ?, status = 'active', refresh_before = ?, granted_at = ?,
             last_error = NULL
           WHERE token = ? AND status IN ('pending', 'active')`,
        )
        .run(grant.id, grant.refreshBefore, nowMs, token);
      if (updated.changes > 0 && grant.cursor !== null) {
        this.db
          .prepare(
            `INSERT INTO cursors (token, cursor, possible_gap, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (token) DO UPDATE SET cursor = excluded.cursor,
               possible_gap = max(cursors.possible_gap, excluded.possible_gap), updated_at = excluded.updated_at`,
          )
          .run(token, grant.cursor, gap ? 1 : 0, nowMs);
      }
      this.db.exec('COMMIT');
      return updated.changes > 0;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Already rolled back.
      }
      throw err;
    }
  }

  /** Sets the status unconditionally: for the user's own actions, such as `evdock unsubscribe`. */
  setStatus(token: string, status: SubscriptionStatus, lastError: string | null = null): void {
    this.db.prepare('UPDATE subscriptions SET status = ?, last_error = ? WHERE token = ?').run(status, lastError, token);
  }

  /** Stops an active subscription after a permanent refresh error. Leaves an already-ended one (and its reason) alone. */
  stopSubscription(token: string, lastError: string): void {
    this.db
      .prepare("UPDATE subscriptions SET status = 'stopped', last_error = ? WHERE token = ? AND status = 'active'")
      .run(lastError, token);
  }

  /** Notes a failed refresh without changing the status. */
  recordError(token: string, lastError: string): void {
    this.db.prepare('UPDATE subscriptions SET last_error = ? WHERE token = ?').run(lastError, token);
  }

  /** Removes a path that never became a subscription (events/subscribe failed). */
  deleteSubscription(token: string): void {
    this.db.prepare('DELETE FROM subscriptions WHERE token = ?').run(token);
  }

  getSubscription(token: string): Subscription | undefined {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE token = ?').get(token) as SubscriptionRow | undefined;
    return row && toSubscription(row);
  }

  /** Finds a subscription by path token or by server-derived id. */
  findSubscription(ref: string): Subscription | undefined {
    const row = this.db
      .prepare('SELECT * FROM subscriptions WHERE token = ? OR subscription_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(ref, ref) as SubscriptionRow | undefined;
    return row && toSubscription(row);
  }

  listSubscriptions(): Subscription[] {
    const rows = this.db.prepare('SELECT * FROM subscriptions ORDER BY created_at').all() as unknown as SubscriptionRow[];
    return rows.map(toSubscription);
  }

  /** Stores one delivery. Dedup is per (path token, webhook-id). */
  store(input: StoreInput): 'stored' | 'duplicate' {
    const { token, message, receivedAtMs } = input;
    const event = message.kind === 'event' ? message : undefined;
    const cursor = message.kind === 'event' || message.kind === 'gap' ? message.cursor : null;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = this.db
        .prepare(
          `INSERT INTO events (token, subscription_id, webhook_id, kind, event_id, name, event_timestamp, cursor, body, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (token, webhook_id) DO NOTHING`,
        )
        .run(
          token,
          input.subscriptionId,
          input.webhookId,
          message.kind,
          event?.eventId ?? null,
          event?.name ?? null,
          event?.timestamp ?? null,
          cursor,
          input.body,
          receivedAtMs,
        );
      if (inserted.changes === 0) {
        this.db.exec('COMMIT');
        return 'duplicate';
      }

      if (message.kind === 'event' && cursor !== null) {
        // A null cursor means no replay for this event type: nothing to persist.
        this.db
          .prepare(
            `INSERT INTO cursors (token, cursor, possible_gap, updated_at) VALUES (?, ?, 0, ?)
             ON CONFLICT (token) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
          )
          .run(token, cursor, receivedAtMs);
      } else if (message.kind === 'gap') {
        this.db
          .prepare(
            `INSERT INTO cursors (token, cursor, possible_gap, updated_at) VALUES (?, ?, 1, ?)
             ON CONFLICT (token) DO UPDATE SET cursor = coalesce(excluded.cursor, cursors.cursor),
               possible_gap = 1, updated_at = excluded.updated_at`,
          )
          .run(token, cursor, receivedAtMs);
      } else if (message.kind === 'terminated') {
        // The subscription no longer exists server-side: stop refreshing it. The row stays so the
        // reason can be seen and the subscription re-created; the stored message is the notice for
        // the output side; the cursor is kept for a resubscribe.
        this.db
          .prepare("UPDATE subscriptions SET status = 'terminated', last_error = ? WHERE token = ? AND status = 'active'")
          .run(printable(`terminated: ${message.code} ${message.message}`), token);
      }

      this.db.exec('COMMIT');
      return 'stored';
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Some errors end the transaction themselves; nothing left to roll back.
      }
      throw err;
    }
  }

  messages(token: string): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT seq, token, subscription_id, webhook_id, kind, event_id, cursor, body, received_at
         FROM events WHERE token = ? ORDER BY seq`,
      )
      .all(token) as Array<{
      seq: number;
      token: string;
      subscription_id: string;
      webhook_id: string;
      kind: StoredMessage['kind'];
      event_id: string | null;
      cursor: string | null;
      body: Uint8Array;
      received_at: number;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      token: r.token,
      subscriptionId: r.subscription_id,
      webhookId: r.webhook_id,
      kind: r.kind,
      eventId: r.event_id,
      cursor: r.cursor,
      body: r.body,
      receivedAt: r.received_at,
    }));
  }

  cursor(token: string): CursorRow | undefined {
    const row = this.db.prepare('SELECT cursor, possible_gap FROM cursors WHERE token = ?').get(token) as
      | { cursor: string | null; possible_gap: number }
      | undefined;
    return row && { cursor: row.cursor, possibleGap: row.possible_gap === 1 };
  }
}
