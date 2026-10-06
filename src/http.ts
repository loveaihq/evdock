// Local plain-HTTP receiver: POST /hooks/<token>. HTTPS is the relay's job (M3).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Inbox } from './inbox.js';
import { handleDelivery, MAX_BODY_BYTES } from './receiver.js';

export interface ReceiverOptions {
  inbox: Pick<Inbox, 'getSubscription' | 'store'>;
  /** Clock for the receive time; tests override it. */
  now?: () => number;
  log?: (line: string) => void;
}

const HOOK_PATH = /^\/hooks\/([A-Za-z0-9_-]+)$/;

// Reads the whole body. Past the limit it keeps draining (so the client gets a clean
// 413 rather than a reset connection) but stops buffering.
function readBody(req: IncomingMessage): Promise<Buffer | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) chunks.length = 0;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(size > MAX_BODY_BYTES ? 'too-large' : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Node exposes header bytes as latin1 strings. Senders encode values as UTF-8 (the
// signature prefix is UTF-8), so recover the wire bytes and decode them as UTF-8.
// Repeated webhook-signature lines are one space-delimited list.
function readHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, values] of Object.entries(req.headersDistinct)) {
    if (!values) continue;
    const joined = values.join(name === 'webhook-signature' ? ' ' : ', ');
    headers[name] = Buffer.from(joined, 'latin1').toString('utf8');
  }
  return headers;
}

// webhook-id comes from an unauthenticated request; keep it printable and short in logs.
function forLog(value: string | undefined): string {
  if (value === undefined) return '-';
  return value.replace(/[^\x21-\x7e]/g, '?').slice(0, 80);
}

export function createReceiver(options: ReceiverOptions): Server {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const receivedAtMs = now();
    // Matched as a plain string: request targets are attacker-controlled and need not be valid URLs.
    // Absolute-form targets (http://host/path) are reduced to their path, as HTTP/1.1 requires.
    const target = (req.url ?? '').replace(/^https?:\/\/[^/]*/i, '');
    const match = HOOK_PATH.exec(target.split('?')[0]!);
    const reply = (status: number, outcome: string, json?: unknown) => {
      if (json === undefined) {
        res.writeHead(status).end();
      } else {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
      }
      const token = match ? `${match[1]!.slice(0, 6)}…` : '-';
      log(`${status} ${outcome} hook=${token} webhook-id=${forLog(req.headers['webhook-id'] as string | undefined)}`);
    };

    if (!match) {
      req.resume();
      return reply(404, 'not-a-hook-path');
    }
    if (req.method !== 'POST') {
      req.resume();
      res.setHeader('allow', 'POST');
      return reply(405, 'method-not-allowed');
    }

    try {
      const body = await readBody(req);
      if (body === 'too-large') return reply(413, 'too-large');
      const result = handleDelivery(options.inbox, {
        token: match[1]!,
        headers: readHeaders(req),
        body,
        receivedAtMs,
      });
      reply(result.status, result.outcome, result.json);
    } catch {
      if (!res.headersSent) reply(500, 'internal-error');
    }
  }

  return createServer((req, res) => {
    serve(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
}
