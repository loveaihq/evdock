// The three webhook-mode events/* calls (docs/spec/sep-3415-2026-10-06.md "Webhook-Based Delivery").
// Written to accept what the design sketch, SEP-3415 and OpenAI's guide each send
// (docs/M2-TASK.md section 7).

import type { Grant } from './inbox.js';
import { McpError, type McpClient } from './mcp-client.js';
import { printable } from './text.js';

type Json = Record<string, unknown>;

// SEP-3415's codes (provisional) plus the JSON-RPC ones we branch on.
const ERROR_NAMES: Record<number, string> = {
  [-32023]: 'NotFound',
  [-32024]: 'Forbidden',
  [-32025]: 'ResourceExhausted',
  [-32026]: 'Unsupported',
  [-32027]: 'CallbackEndpointError',
  [-32602]: 'InvalidParams',
  [-32601]: 'MethodNotFound',
};

// The design sketch's numbering, still used by servers written to it (OpenAI's guide uses -32015).
// MCP 2026-07-28 says receivers MUST NOT assume a meaning for -32000..-32019
// (docs/spec/mcp-2026-07-28/basic-index.mdx 117-121), so a legacy code only counts when the
// message or the typed data says the same thing.
const LEGACY: Record<number, [name: string, agrees: (message: string, data: Record<string, unknown>) => boolean]> = {
  [-32011]: ['NotFound', (m, d) => /not ?found/i.test(m) || 'kind' in d],
  [-32012]: ['Forbidden', (m) => /forbidden/i.test(m)],
  [-32013]: ['ResourceExhausted', (m, d) => /resource ?exhausted/i.test(m) || 'limit' in d],
  [-32014]: ['Unsupported', (m, d) => /unsupported/i.test(m) || 'feature' in d],
  [-32015]: ['CallbackEndpointError', (m, d) => /callback/i.test(m) || 'reason' in d],
};

export function errorName(err: unknown): string | undefined {
  if (!(err instanceof McpError)) return undefined;
  const name = ERROR_NAMES[err.code];
  if (name) return name;
  const legacy = LEGACY[err.code];
  const data = typeof err.data === 'object' && err.data !== null ? (err.data as Record<string, unknown>) : {};
  return legacy && legacy[1](err.message, data) ? legacy[0] : undefined;
}

/** One-line description of an error for logs and the CLI: name, code and data.reason/kind. */
export function describeError(err: unknown): string {
  if (!(err instanceof McpError)) return printable((err as Error).message);
  const data = err.data as { reason?: unknown; kind?: unknown } | undefined;
  const detail = data?.reason ?? data?.kind;
  const name = errorName(err) ?? 'error';
  return `${name} ${err.code}${detail === undefined ? '' : ` (${printable(detail, 40)})`}: ${printable(err.message)}`;
}

export interface EventType {
  name: string;
  description?: string;
  delivery: string[];
  inputSchema?: unknown;
  payloadSchema?: unknown;
}

const MAX_PAGES = 100;

/** events/list, following nextCursor. */
export async function listEvents(client: McpClient): Promise<EventType[]> {
  const all: EventType[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.request('events/list', cursor === undefined ? {} : { cursor });
    for (const item of Array.isArray(result.events) ? result.events : []) {
      const e = item as Json;
      if (typeof e.name !== 'string') continue;
      all.push({
        name: e.name,
        description: typeof e.description === 'string' ? e.description : undefined,
        delivery: Array.isArray(e.delivery) ? e.delivery.filter((d): d is string => typeof d === 'string') : [],
        inputSchema: e.inputSchema,
        payloadSchema: e.payloadSchema,
      });
    }
    if (typeof result.nextCursor !== 'string') return all;
    cursor = result.nextCursor;
  }
  throw new Error(`events/list returned more than ${MAX_PAGES} pages`);
}

export interface SubscribeParams {
  name: string;
  arguments: Json;
  url: string;
  secret: string;
  cursor: string | null;
}

/** A subscribe/refresh response. refreshBefore is epoch ms, or null for no expiry. */
export type SubscribeResult = Grant & { deliveryStatus?: Json };

/** events/subscribe (also used to refresh). ttlMs and maxAgeMs are not sent: server default, unbounded replay. */
export async function subscribe(client: McpClient, p: SubscribeParams): Promise<SubscribeResult> {
  const result = await client.request('events/subscribe', {
    name: p.name,
    arguments: p.arguments,
    delivery: { mode: 'webhook', url: p.url, secret: p.secret },
    cursor: p.cursor,
  });
  if (typeof result.id !== 'string' || result.id === '') throw new Error('events/subscribe: response has no id');
  // Always present; only an explicit null means no expiry. Anything else is a server bug we
  // should not paper over with a guessed lifetime.
  let refreshBefore: number | null = null;
  if (result.refreshBefore !== null) {
    refreshBefore = typeof result.refreshBefore === 'string' ? Date.parse(result.refreshBefore) : NaN;
    if (Number.isNaN(refreshBefore)) throw new Error('events/subscribe: refreshBefore is missing or not a timestamp');
  }
  return {
    id: result.id,
    refreshBefore,
    // Absent means null, as everywhere for cursors.
    cursor: typeof result.cursor === 'string' ? result.cursor : null,
    truncated: result.truncated === true,
    deliveryStatus: typeof result.deliveryStatus === 'object' && result.deliveryStatus !== null
      ? (result.deliveryStatus as Json)
      : undefined,
  };
}

/** events/unsubscribe. A missing subscription counts as success (OpenAI's guide makes unsubscribe idempotent). */
export async function unsubscribe(client: McpClient, p: { name: string; arguments: Json; url: string }): Promise<void> {
  try {
    await client.request('events/unsubscribe', {
      name: p.name,
      arguments: p.arguments,
      delivery: { mode: 'webhook', url: p.url },
    });
  } catch (err) {
    if (errorName(err) !== 'NotFound') throw err;
  }
}
