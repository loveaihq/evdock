// The relay on Cloudflare: the Worker hands every request to one SQLite-backed Durable Object,
// which runs the shared relay core (src/relay/core.ts) over its embedded SQLite.

import { DurableObject } from 'cloudflare:workers';
import { createRelay, RelayStore, type Row, type Sql, type SqlValue } from '../../src/relay/core.js';

/** Durable Object SQLite behind the relay's Sql interface: same value types as node:sqlite. */
function durableSql(storage: DurableObjectStorage): Sql {
  return {
    exec(query: string, ...params: SqlValue[]): Row[] {
      // Consumed at once: a cursor held across an await has no snapshot isolation.
      const rows = storage.sql.exec(query, ...params).toArray();
      // BLOBs come back as ArrayBuffer; the core expects Uint8Array, as node:sqlite returns.
      return rows.map((row) => {
        const out: Row = {};
        for (const [name, value] of Object.entries(row)) out[name] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
        return out;
      });
    },
    transaction: <T>(fn: () => T): T => storage.transactionSync(fn),
  };
}

export class Relay extends DurableObject<Env> {
  private readonly handle: (request: Request) => Promise<Response>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!env.RELAY_KEY) throw new Error('RELAY_KEY is not set (wrangler secret put RELAY_KEY)');
    // Shows in `wrangler tail`. The core logs no bodies, keys or full path tokens.
    this.handle = createRelay(new RelayStore(durableSql(ctx.storage)), { key: env.RELAY_KEY, log: (line) => console.log(line) });
  }

  override fetch(request: Request): Promise<Response> {
    return this.handle(request);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    // Everything else is noise: answer it here without spending a Durable Object request.
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/hooks/') && !pathname.startsWith('/relay/')) return new Response(null, { status: 404 });
    const relay = env.RELAY.get(env.RELAY.idFromName('relay'));
    // Answer only with the object's response: its output gate holds that response until the
    // delivery is durably stored, so no 2xx goes out for a write that could still be lost.
    return await relay.fetch(request);
  },
} satisfies ExportedHandler<Env>;
