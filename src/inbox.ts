// SQLite inbox: subscriptions, received messages (events and control envelopes), cursors.
// A write returns only after the transaction commits; callers answer 2xx after that.

import { DatabaseSync } from 'node:sqlite';
import type { Message } from './classify.js';

export interface Subscription {
  token: string;
  secret: string;
  /** Server-derived id from the subscribe response; null until confirmed. */
  subscriptionId: string | null;
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
CREATE TABLE IF NOT EXISTS subscriptions (
  token TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  subscription_id TEXT,
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

export class Inbox {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  addSubscription(token: string, secret: string, nowMs = Date.now()): void {
    this.db
      .prepare('INSERT INTO subscriptions (token, secret, subscription_id, created_at) VALUES (?, ?, NULL, ?)')
      .run(token, secret, nowMs);
  }

  confirmSubscription(token: string, subscriptionId: string): void {
    const result = this.db
      .prepare('UPDATE subscriptions SET subscription_id = ? WHERE token = ?')
      .run(subscriptionId, token);
    if (result.changes === 0) throw new Error('no subscription registered at that path');
  }

  getSubscription(token: string): Subscription | undefined {
    const row = this.db
      .prepare('SELECT token, secret, subscription_id FROM subscriptions WHERE token = ?')
      .get(token) as { token: string; secret: string; subscription_id: string | null } | undefined;
    return row && { token: row.token, secret: row.secret, subscriptionId: row.subscription_id };
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
        // The subscription no longer exists server-side. The stored message is the notice for the output side.
        this.db.prepare('DELETE FROM subscriptions WHERE token = ?').run(token);
        this.db.prepare('DELETE FROM cursors WHERE token = ?').run(token);
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
