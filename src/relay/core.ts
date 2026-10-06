// The relay: takes webhook POSTs for the daemon while it is away and keeps them until the
// daemon fetches them (docs/M3-TASK.md). Written against Web-standard Request/Response and a
// small synchronous SQL interface, so the Node server (node:sqlite) and the Cloudflare Worker
// (Durable Object SQLite) run this same code. Nothing here may import node:* modules.
//
// The relay never holds a signing secret: it does not verify signatures, check timestamps or
// deduplicate. The daemon does all of that after fetching, using the receive time recorded here.

import { printable } from '../text.js';

export type SqlValue = string | number | null | Uint8Array;
export type Row = Record<string, SqlValue>;

/** node:sqlite and Durable Object SQLite behind one interface. Both are synchronous. */
export interface Sql {
  exec(query: string, ...params: SqlValue[]): Row[];
  /** Runs fn atomically: all of its writes commit or none do. */
  transaction<T>(fn: () => T): T;
}

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_STORED_DELIVERIES = 10_000;
export const MAX_STORED_BYTES = 200 * 1024 * 1024;
const BATCH_COUNT = 20;
// Bounds the size of one fetch response and its base64 work.
const BATCH_BYTES = 512 * 1024;
// Verification envelopes are tiny; bodies above this are never parsed here.
const MAX_VERIFICATION_BYTES = 4096;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const REQUIRED_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id'] as const;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS paths (token TEXT PRIMARY KEY, state TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS deliveries (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     token TEXT NOT NULL,
     received_at INTEGER NOT NULL,
     headers TEXT NOT NULL,
     body BLOB NOT NULL,
     size INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS deliveries_token ON deliveries (token)`,
  // Running totals, so the storage cap costs one row read instead of a scan.
  `CREATE TABLE IF NOT EXISTS totals (id INTEGER PRIMARY KEY CHECK (id = 1), count INTEGER NOT NULL, bytes INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO totals (id, count, bytes) VALUES (1, 0, 0)`,
];

export type PathState = 'pending' | 'confirmed';

export interface Delivery {
  seq: number;
  token: string;
  /** Epoch ms when the relay received it; the daemon checks webhook-timestamp against this. */
  receivedAt: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export class RelayStore {
  constructor(private readonly sql: Sql) {
    for (const statement of SCHEMA) sql.exec(statement);
  }

  pathState(token: string): PathState | undefined {
    const row = this.sql.exec('SELECT state FROM paths WHERE token = ?', token)[0];
    return row ? (row.state as PathState) : undefined;
  }

  setPath(token: string, state: PathState): void {
    this.sql.exec(
      'INSERT INTO paths (token, state) VALUES (?, ?) ON CONFLICT (token) DO UPDATE SET state = excluded.state',
      token,
      state,
    );
  }

  /** Removes a path and whatever was stored for it and not yet fetched. */
  deletePath(token: string): void {
    this.sql.transaction(() => {
      const gone = this.sql.exec('SELECT count(*) AS n, coalesce(sum(size), 0) AS b FROM deliveries WHERE token = ?', token)[0]!;
      this.sql.exec('DELETE FROM deliveries WHERE token = ?', token);
      this.sql.exec('UPDATE totals SET count = count - ?, bytes = bytes - ? WHERE id = 1', gone.n as number, gone.b as number);
      this.sql.exec('DELETE FROM paths WHERE token = ?', token);
    });
  }

  /** Stores one delivery. Returns its sequence number, or 'full' when the storage cap is reached. */
  insert(token: string, receivedAt: number, headers: Record<string, string>, body: Uint8Array): number | 'full' {
    const headerText = JSON.stringify(headers);
    // Headers count towards the cap too: they can be large (up to 128 KB on Cloudflare).
    const size = body.length + headerText.length;
    return this.sql.transaction(() => {
      const totals = this.sql.exec('SELECT count, bytes FROM totals WHERE id = 1')[0]!;
      if ((totals.count as number) >= MAX_STORED_DELIVERIES || (totals.bytes as number) + size > MAX_STORED_BYTES) {
        return 'full' as const;
      }
      const row = this.sql.exec(
        'INSERT INTO deliveries (token, received_at, headers, body, size) VALUES (?, ?, ?, ?, ?) RETURNING seq',
        token,
        receivedAt,
        headerText,
        body,
        size,
      )[0]!;
      this.sql.exec('UPDATE totals SET count = count + 1, bytes = bytes + ? WHERE id = 1', size);
      return row.seq as number;
    });
  }

  /** The oldest unfetched deliveries: up to BATCH_COUNT, and BATCH_BYTES of bodies (always at least one). */
  oldest(): { deliveries: Delivery[]; more: boolean } {
    const rows = this.sql.exec(
      'SELECT seq, token, received_at, headers, body FROM deliveries ORDER BY seq LIMIT ?',
      BATCH_COUNT + 1,
    );
    const deliveries: Delivery[] = [];
    let bytes = 0;
    for (const row of rows) {
      const body = row.body as Uint8Array;
      if (deliveries.length === BATCH_COUNT || (deliveries.length > 0 && bytes + body.length > BATCH_BYTES)) break;
      bytes += body.length;
      deliveries.push({
        seq: row.seq as number,
        token: row.token as string,
        receivedAt: row.received_at as number,
        headers: JSON.parse(row.headers as string) as Record<string, string>,
        body,
      });
    }
    return { deliveries, more: rows.length > deliveries.length };
  }

  /** The daemon has stored everything up to seq: forget it. */
  ackUpTo(seq: number): void {
    this.sql.transaction(() => {
      const gone = this.sql.exec('SELECT count(*) AS n, coalesce(sum(size), 0) AS b FROM deliveries WHERE seq <= ?', seq)[0]!;
      this.sql.exec('DELETE FROM deliveries WHERE seq <= ?', seq);
      this.sql.exec('UPDATE totals SET count = count - ?, bytes = bytes - ? WHERE id = 1', gone.n as number, gone.b as number);
    });
  }
}

export interface RelayOptions {
  /** The relay key the daemon authenticates with (bearer). */
  key: string;
  now?: () => number;
  log?: (line: string) => void;
}

function base64(bytes: Uint8Array): string {
  // Native where the runtime has it; otherwise apply() over chunks (spreading a typed array
  // goes through its iterator and is several times slower).
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(binary);
}

/** Header values as the sender meant them. Runtimes that hand out raw latin1 bytes supply their own. */
export type HeaderReader = (name: string) => string | null;

// Several webhook-signature header lines arrive joined with ", " (HTTP field combination), which
// would glue a comma onto all but the last signature. Entries are `v<n>,<base64>` and base64 has
// no commas, so ", v1,…" can only be a boundary: make it the space Standard Webhooks uses.
function signatureList(value: string): string {
  return value.replace(/,\s*(?=v\d+[a-z]*,)/g, ' ');
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// Compares digests, so the time taken does not depend on where the key differs or on its length.
async function sameKey(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Reads at most `max` bytes; stops reading and reports 'too-large' past that. */
async function readCapped(request: Request, max: number): Promise<Uint8Array | 'too-large'> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return 'too-large';
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/** The challenge, if this body is a verification envelope. */
function verificationChallenge(body: Uint8Array): string | undefined {
  if (body.length > MAX_VERIFICATION_BYTES) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const { type, challenge } = parsed as Record<string, unknown>;
      if (type === 'verification' && typeof challenge === 'string') return challenge;
    }
  } catch {
    // Not JSON: an event the daemon will reject. Stored like any other.
  }
  return undefined;
}

const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const empty = (status: number) => new Response(null, { status });

export function createRelay(
  store: RelayStore,
  options: RelayOptions,
): (request: Request, header?: HeaderReader) => Promise<Response> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});

  // POST /hooks/<token>: from MCP servers, public.
  async function hook(request: Request, header: HeaderReader, token: string, receivedAt: number): Promise<[Response, string]> {
    const state = store.pathState(token);
    if (state === undefined) return [empty(404), 'unknown-path'];
    const length = Number(request.headers.get('content-length') ?? NaN);
    if (length > MAX_BODY_BYTES) return [empty(413), 'too-large'];
    for (const name of REQUIRED_HEADERS) {
      if (!header(name)) return [empty(400), `missing-${name}`];
    }
    const body = await readCapped(request, MAX_BODY_BYTES);
    if (body === 'too-large') return [empty(413), 'too-large'];

    // Echoed for any registered path: registration by the daemon is the consent the handshake
    // proves. The signature cannot be checked here (no secret), and need not be.
    const challenge = verificationChallenge(body);
    if (challenge !== undefined) return [json(200, { challenge }), 'verification'];

    // Registered but the subscribe response has not arrived yet: retryable (SEP-3415 538).
    if (state === 'pending') return [empty(503), 'unconfirmed'];

    // Stored as the sender meant them: the daemon verifies the signature over these exact values.
    const headers: Record<string, string> = {};
    for (const name of REQUIRED_HEADERS) headers[name] = header(name)!;
    headers['webhook-signature'] = signatureList(headers['webhook-signature']!);
    let seq;
    try {
      seq = store.insert(token, receivedAt, headers, body);
    } catch {
      return [empty(503), 'store-failed'];
    }
    if (seq === 'full') return [empty(503), 'full'];
    return [empty(200), `stored-${seq}`];
  }

  // /relay/*: from the daemon, with the relay key.
  async function control(request: Request, path: string): Promise<[Response, string]> {
    const auth = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '');
    if (!auth || !(await sameKey(auth[1]!, options.key))) return [empty(401), 'unauthorized'];

    const pathMatch = /^\/relay\/paths\/([^/]+)$/.exec(path);
    if (pathMatch) {
      const token = pathMatch[1]!;
      if (!TOKEN.test(token)) return [empty(400), 'bad-token'];
      if (request.method === 'DELETE') {
        store.deletePath(token);
        return [empty(204), 'path-deleted'];
      }
      if (request.method === 'PUT') {
        const body = (await request.json().catch(() => undefined)) as { state?: unknown } | undefined;
        if (body?.state !== 'pending' && body?.state !== 'confirmed') return [empty(400), 'bad-state'];
        store.setPath(token, body.state);
        return [empty(204), `path-${body.state}`];
      }
      return [empty(405), 'method-not-allowed'];
    }
    if (path === '/relay/deliveries' && request.method === 'GET') {
      const { deliveries, more } = store.oldest();
      const out = deliveries.map((d) => ({ ...d, body: base64(d.body) }));
      return [json(200, { deliveries: out, more }), `fetched-${deliveries.length}`];
    }
    if (path === '/relay/ack' && request.method === 'POST') {
      const body = (await request.json().catch(() => undefined)) as { upTo?: unknown } | undefined;
      if (!Number.isSafeInteger(body?.upTo)) return [empty(400), 'bad-ack'];
      store.ackUpTo(body!.upTo as number);
      return [empty(204), `acked-${String(body!.upTo)}`];
    }
    return [empty(404), 'not-found'];
  }

  return async (request, header = (name) => request.headers.get(name)) => {
    const receivedAt = now();
    const path = new URL(request.url).pathname;
    const hookMatch = /^\/hooks\/([A-Za-z0-9_-]+)$/.exec(path);
    let response: Response;
    let outcome: string;
    if (hookMatch && request.method === 'POST') {
      [response, outcome] = await hook(request, header, hookMatch[1]!, receivedAt);
    } else if (path.startsWith('/relay/')) {
      [response, outcome] = await control(request, path);
    } else {
      [response, outcome] = [empty(404), 'not-found'];
    }
    // Never the body, never the key, never a full path token.
    const label = hookMatch ? `${hookMatch[1]!.slice(0, 6)}…` : '-';
    log(`${response.status} ${outcome} hook=${label} webhook-id=${printable(header('webhook-id') ?? '-', 80)}`);
    return response;
  };
}
