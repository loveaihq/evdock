// `evdock relay serve`: the relay on any Node host. Plain HTTP; put TLS in front of it
// (reverse proxy or tunnel), since MCP servers only deliver to https callbacks.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createRelay, RelayStore, type HeaderReader, type Row, type Sql, type SqlValue } from './core.js';

/** node:sqlite behind the relay's Sql interface. Durable before returning, like the inbox. */
export function nodeSql(path: string): Sql & { close(): void } {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  return {
    exec: (query: string, ...params: SqlValue[]) => db.prepare(query).all(...params) as Row[],
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Already rolled back.
        }
        throw err;
      }
    },
    close: () => db.close(),
  };
}

export interface RelayServerOptions {
  dbPath: string;
  key: string;
  host?: string;
  port?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface RelayServer {
  url: string;
  close(): Promise<void>;
}

// Request targets are attacker-controlled: matched as plain strings, never parsed as URLs
// (the M1 receiver learned this the hard way). Absolute-form targets are reduced to their path.
function requestPath(req: IncomingMessage): string | undefined {
  const target = (req.url ?? '').replace(/^https?:\/\/[^/]*/i, '').split('?')[0]!;
  return /^\/[A-Za-z0-9_\-./]*$/.test(target) ? target : undefined;
}

/** How much unread body the server will swallow after answering; past it the connection is cut. */
const DRAIN_LIMIT = 1024 * 1024;

// The request body as a web stream. Unlike Readable.toWeb, cancelling it (the core does past
// 256 KiB) does not destroy the socket, so the 413 can still reach the sender. stop() ends the
// buffering once nobody reads the stream any more, so unread bodies do not pile up in memory.
function bodyStream(req: IncomingMessage): { stream: ReadableStream<Uint8Array>; stop(): void } {
  let stopped = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      req.on('data', (chunk: Buffer) => {
        if (!stopped) controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length));
      });
      req.on('end', () => {
        if (!stopped) controller.close();
      });
      req.on('error', (err) => {
        if (!stopped) controller.error(err);
      });
    },
    cancel() {
      stopped = true;
    },
  });
  return { stream, stop: () => void (stopped = true) };
}

// After an early answer (404, 401, 413): read the rest of the body and throw it away before
// responding, so the sender gets the status rather than a reset connection (which it would
// retry; 413 tells it not to). Answering first and draining after was tried: senders then saw
// resets for bodies well within the limit. Past DRAIN_LIMIT the connection is cut instead.
function drained(req: IncomingMessage): Promise<boolean> {
  if (req.readableEnded) return Promise.resolve(true);
  return new Promise((resolve) => {
    let left = DRAIN_LIMIT;
    req.on('data', (chunk: Buffer) => {
      left -= chunk.length;
      if (left < 0) {
        req.destroy();
        resolve(false);
      }
    });
    req.on('end', () => resolve(true));
    req.on('close', () => resolve(req.readableEnded));
    req.resume();
  });
}

// Header values as the sender meant them. Node exposes header bytes as latin1 strings; senders
// encode values as UTF-8 (the signature prefix is UTF-8). Same rule as the local receiver
// (src/http.ts). They cannot go into a Headers object this way (it only takes byte strings).
function headerReader(req: IncomingMessage): HeaderReader {
  return (name) => {
    const values = req.headersDistinct[name];
    return values ? Buffer.from(values.join(', '), 'latin1').toString('utf8') : null;
  };
}

export async function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const sql = nodeSql(options.dbPath);
  const handle = createRelay(new RelayStore(sql), { key: options.key, now: options.now, log: options.log });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = requestPath(req);
      if (path === undefined) {
        req.resume();
        return void res.writeHead(404).end();
      }
      const headers = new Headers();
      for (const [name, values] of Object.entries(req.headersDistinct)) {
        for (const value of values ?? []) headers.append(name, value);
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const body = hasBody ? bodyStream(req) : undefined;
      const request = new Request(`http://relay.local${path}`, {
        method: req.method,
        headers,
        body: body?.stream ?? null,
        // Required by Node's fetch types for a streamed request body.
        ...(hasBody ? { duplex: 'half' } : {}),
      } as RequestInit);
      const response = await handle(request, headerReader(req));
      body?.stop();
      const out = Buffer.from(await response.arrayBuffer());
      if (hasBody && !(await drained(req))) return;
      res.writeHead(response.status, Object.fromEntries(response.headers)).end(out);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8788, options.host ?? '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const host = options.host ?? '127.0.0.1';
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sql.close();
    },
  };
}
