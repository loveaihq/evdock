// The three webhook-mode events/* calls (docs/spec/sep-3415-2026-10-06.md "Webhook-Based Delivery").
// Written to accept what the design sketch, SEP-3415 and OpenAI's guide each send
// (docs/M2-TASK.md section 7).

import type { Grant } from './inbox.js';
import { McpError, type McpClient } from './mcp-client.js';

type Json = Record<string, unknown>;

// The design sketch numbered these -32011..-32015; SEP-3415 renumbered them -32023..-32027
// (provisional) because the old range is closed to new codes in MCP 2026-07-28.
const ERROR_NAMES: Record<number, string> = {
  [-32011]: 'NotFound',
  [-32012]: 'Forbidden',
  [-32013]: 'ResourceExhausted',
  [-32014]: 'Unsupported',
  [-32015]: 'CallbackEndpointError',
  [-32023]: 'NotFound',
  [-32024]: 'Forbidden',
  [-32025]: 'ResourceExhausted',
  [-32026]: 'Unsupported',
  [-32027]: 'CallbackEndpointError',
  [-32602]: 'InvalidParams',
  [-32601]: 'MethodNotFound',
};

export function errorName(err: unknown): string | undefined {
  return err instanceof McpError ? ERROR_NAMES[err.code] : undefined;
}

/** One-line description of an events error for logs and the CLI: name, code and data.reason/kind. */
export function describeError(err: unknown): string {
  if (!(err instanceof McpError)) return (err as Error).message;
  const data = err.data as { reason?: unknown; kind?: unknown } | undefined;
  const detail = data?.reason ?? data?.kind;
  return `${ERROR_NAMES[err.code] ?? 'error'} ${err.code}${detail === undefined ? '' : ` (${String(detail)})`}: ${err.message}`;
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
  let refreshBefore: number | null = null;
  if (typeof result.refreshBefore === 'string') {
    refreshBefore = Date.parse(result.refreshBefore);
    if (Number.isNaN(refreshBefore)) throw new Error('events/subscribe: refreshBefore is not a timestamp');
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
