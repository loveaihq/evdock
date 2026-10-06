// Mock MCP server offering the Events extension in webhook mode only, for exercising
// evdock's MCP client and subscription manager. Follows SEP-3415
// (docs/spec/sep-3415-2026-10-06.md, "SEP" below) on base protocol 2026-07-28
// (docs/spec/mcp-2026-07-28/). Line numbers refer to those snapshots.
//
// Part of the conformance tooling: Node built-ins only, nothing from evdock's own src/.
// Everything is in memory. Quiet: it never logs, so secrets cannot leak through it.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type AddressInfo, type LookupFunction } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export interface MockEventType {
  name: string;
  description: string;
  /** JSON Schema for subscription arguments: type object, string properties. */
  inputSchema: Record<string, unknown>;
  payloadSchema: Record<string, unknown>;
  /** False: an emit-only type, cursors are always null. */
  replay: boolean;
}

export interface MockServerOptions {
  /** Static bearer token. The principal is derived from it. */
  token: string;
  eventTypes: MockEventType[];
  /** Granted when the client omits ttlMs, and the cap on any suggestion. */
  defaultTtlMs: number;
  /** attempts counts the first one; the delay before attempt n+1 is baseDelayMs * 2^(n-1). */
  retry: { attempts: number; baseDelayMs: number };
  /** Upstream log entries kept for replay; an older cursor gets truncated: true. Default: unlimited. */
  retentionEvents?: number;
  /** TEST ONLY: accept http:// and loopback/private callback URLs. The spec forbids both. Default false. */
  allowInsecureCallbacks?: boolean;
  /** events/list page size, to exercise nextCursor. Default: everything in one page. */
  listPageSize?: number;
  /** Answer JSON-RPC requests as text/event-stream instead of application/json. */
  sseResponses?: boolean;
  /** How long a webhook POST may take before it fails with "timeout". Default 5000. */
  deliveryTimeoutMs?: number;
  host?: string;
  port?: number;
}

export interface MockServer {
  /** The MCP endpoint, e.g. http://127.0.0.1:PORT/mcp */
  url: string;
  /** Appends to the upstream log and delivers to matching subscriptions. */
  emit(name: string, data: Record<string, unknown>): { eventId: string; cursor: string | null };
  /** POSTs a signed terminated envelope (default error Forbidden) and removes the subscription. */
  terminate(subscriptionId: string, error?: { code: number; message: string; data?: unknown }): Promise<void>;
  /** Live subscriptions. verified is always true: one only exists once its endpoint is verified. */
  subscriptions(): Array<{
    id: string;
    url: string;
    name: string;
    arguments: Record<string, unknown>;
    expiresAt: number;
    verified: boolean;
  }>;
  /**
   * Every completed webhook POST, verification and terminated included; one cut short because
   * its subscription ended is not listed. at: when it started. error: a lastError category.
   */
  attempts(): Array<{ subscriptionId: string; webhookId: string; status?: number; error?: string; at: number }>;
  /** Stops the HTTP server, all timers and all in-flight deliveries. */
  close(): Promise<void>;
}

const PROTOCOL_VERSION = '2026-07-28';
const EVENTS_EXTENSION = 'io.modelcontextprotocol/events';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_META = { 'io.modelcontextprotocol/serverInfo': { name: 'evdock-mock-server', version: '0.0.0' } };

// JSON-RPC and MCP codes (basic-index.mdx 109-135), events codes (SEP 748-757).
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;
const NOT_FOUND = -32023;
const FORBIDDEN = -32024;
const UNSUPPORTED = -32026;
const CALLBACK_ENDPOINT_ERROR = -32027;

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_ECHO_BYTES = 64 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const invalidParams = (message: string) => new RpcError(INVALID_PARAMS, `Invalid params: ${message}`);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Sorted keys at every level, so equal arguments give equal keys (SEP 491).
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const random = () => randomBytes(12).toString('hex');
const sha256 = (text: string) => createHash('sha256').update(text).digest();

// SEP 459, 643: whsec_ + standard base64 of 24-64 bytes.
function decodeSecret(value: unknown): Buffer {
  if (typeof value !== 'string' || !value.startsWith('whsec_')) {
    throw invalidParams('delivery.secret must start with whsec_');
  }
  const encoded = value.slice(6);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw invalidParams('delivery.secret is not valid base64');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64) throw invalidParams('delivery.secret must decode to 24-64 bytes');
  return key;
}

// Not globally routable: the SEP's illustrative list (SEP 617) plus a few obvious neighbours.
// BlockList also matches IPv4-mapped IPv6 addresses against the IPv4 rules.
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 3],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}
const isBlocked = (ip: string) => blocked.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');

// Delivery-time check of resolved addresses, so DNS rebinding cannot slip past the
// subscribe-time check (SEP 617). The connection goes to the address checked here.
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    if (addresses.length === 0 || addresses.some((a) => isBlocked(a.address))) {
      return callback(Object.assign(new Error('callback host is not globally routable'), { code: 'EBLOCKED' }), '');
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

// lastError categories (SEP 609). Network failures other than refusal, timeout and TLS
// (reset, DNS failure, a blocked address) fall back to connection_refused, the closest one.
function networkCategory(err: unknown, timedOut: boolean): string {
  if (timedOut) return 'timeout';
  const code = String((err as { code?: unknown }).code ?? '');
  if (/^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/.test(code)) return 'tls_error';
  return 'connection_refused';
}
// No 3xx category exists; a redirect is never followed (SEP 617), so it counts as a 4xx-class failure.
const statusCategory = (status: number) => (status >= 500 ? 'http_5xx' : 'http_4xx');
const is2xx = (status: number) => status >= 200 && status < 300;

interface LogEntry {
  seq: number;
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
}

interface Subscription {
  id: string;
  url: string;
  name: string;
  arguments: Record<string, unknown>;
  replay: boolean;
  secret: Buffer;
  expiresAt: number;
  expiry?: NodeJS.Timeout;
  /** Log position up to which every matching entry has been queued. */
  scanned: number;
  /** Matching entries queued and not yet acknowledged or abandoned, by log position. */
  pending: Map<number, LogEntry>;
  /** Aborted when the subscription ends: stops in-flight attempts and retry waits. */
  stop: AbortController;
  lastDeliveryAt: number | null;
  lastError: string | null;
}

type Target = Pick<Subscription, 'id' | 'url' | 'secret'>;
type SendResult = { status: number; body: Buffer } | { error: string };
type Params = Record<string, unknown>;

export async function startMockServer(options: MockServerOptions): Promise<MockServer> {
  const insecure = options.allowInsecureCallbacks ?? false;
  const timeoutMs = options.deliveryTimeoutMs ?? 5000;
  const types = new Map(options.eventTypes.map((t) => [t.name, t]));
  // The principal is the token, kept as a digest so derived ids never carry the token itself.
  const principal = sha256(options.token).toString('hex');
  const expectedAuth = sha256(`Bearer ${options.token}`);
  // Random per instance: eventIds stay unique across mocks, cursors from another instance are foreign.
  const instance = randomBytes(4).toString('hex');

  const log: LogEntry[] = [];
  let head = 0;
  const subs = new Map<string, Subscription>();
  const verified = new Set<string>();
  const attemptLog: ReturnType<MockServer['attempts']> = [];
  const closing = new AbortController();
  let origin = ''; // set once listening

  // --- Cursors: an opaque string for a position in the log (SEP 684). ---

  const encodeCursor = (seq: number) => `cur_${instance}_${seq}`;
  function decodeCursor(cursor: string): number | null {
    const match = /^cur_([0-9a-f]{8})_(\d{1,15})$/.exec(cursor);
    if (!match || match[1] !== instance) return null;
    const seq = Number(match[2]);
    return seq <= head ? seq : null;
  }

  // The safe watermark (SEP 462, 535): every matching entry at or before it has been
  // acknowledged or abandoned. In an event's own payload that event is left out: SEP 535
  // has event N carry cursor_N once everything before N is done, and the receiver
  // persists that cursor only by acknowledging N.
  function watermark(sub: Subscription, carrying?: number): number {
    let first = Infinity;
    for (const seq of sub.pending.keys()) if (seq !== carrying && seq < first) first = seq;
    return first === Infinity ? sub.scanned : first - 1;
  }

  // --- Webhook POSTs ---

  function post(url: URL, headers: Record<string, string>, body: Buffer, signal: AbortSignal) {
    return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      // http.request never follows redirects (SEP 617). One connection per POST.
      const req = send(
        url,
        {
          method: 'POST',
          headers: { ...headers, 'content-length': String(body.length) },
          agent: false,
          signal,
          ...(insecure ? {} : { lookup: guardedLookup }),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_ECHO_BYTES) chunks.push(chunk);
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on('close', () => {
            if (!res.complete) reject(new Error('response aborted'));
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  // One signed attempt (SEP 633-641): fresh timestamp and signature every time.
  async function send(target: Target, webhookId: string, body: string, lifetime: AbortSignal): Promise<SendResult> {
    const at = Date.now();
    const bytes = Buffer.from(body, 'utf8');
    const timestamp = String(Math.floor(at / 1000));
    const signature = createHmac('sha256', target.secret)
      .update(`${webhookId}.${timestamp}.`, 'utf8')
      .update(bytes)
      .digest('base64');
    const headers = {
      'content-type': 'application/json',
      'webhook-id': webhookId,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
      'X-MCP-Subscription-Id': target.id,
    };
    const timeout = AbortSignal.timeout(timeoutMs);
    let result: SendResult;
    try {
      result = await post(new URL(target.url), headers, bytes, AbortSignal.any([lifetime, timeout]));
    } catch (err) {
      result = { error: networkCategory(err, timeout.aborted && !lifetime.aborted) };
    }
    if (!lifetime.aborted) {
      attemptLog.push({
        subscriptionId: target.id,
        webhookId,
        ...('error' in result ? { error: result.error } : { status: result.status }),
        at,
      });
    }
    return result;
  }

  // Each event is retried on its own, with exponential backoff (SEP 536). 410 and 413 are
  // not retried (SEP 536, 656). Abandoned events count as done for the watermark.
  async function deliver(sub: Subscription, entry: LogEntry): Promise<void> {
    const { signal } = sub.stop;
    for (let attempt = 1; ; attempt++) {
      const cursor = sub.replay ? encodeCursor(watermark(sub, entry.seq)) : null;
      const body = JSON.stringify({
        eventId: entry.eventId,
        name: entry.name,
        timestamp: entry.timestamp,
        data: entry.data,
        cursor,
      });
      const result = await send(sub, entry.eventId, body, signal);
      if (signal.aborted) return;
      if ('status' in result && is2xx(result.status)) {
        sub.lastDeliveryAt = Date.now();
        sub.lastError = null;
        sub.pending.delete(entry.seq);
        return;
      }
      sub.lastError = 'error' in result ? result.error : statusCategory(result.status);
      const final = 'status' in result && (result.status === 410 || result.status === 413);
      if (final || attempt >= options.retry.attempts) {
        sub.pending.delete(entry.seq);
        return;
      }
      try {
        await sleep(options.retry.baseDelayMs * 2 ** (attempt - 1), undefined, { signal, ref: false });
      } catch {
        return;
      }
    }
  }

  // All entries go into pending before any attempt computes a watermark.
  function enqueue(sub: Subscription, entries: LogEntry[]): void {
    for (const entry of entries) sub.pending.set(entry.seq, entry);
    for (const entry of entries) void deliver(sub, entry);
  }

  // Endpoint verification before the first delivery to an unverified (principal, url) (SEP 619-628).
  async function verify(target: Target): Promise<void> {
    const challenge = randomBytes(24).toString('base64url');
    const body = JSON.stringify({ type: 'verification', challenge });
    const result = await send(target, `msg_verification_${random()}`, body, closing.signal);
    let reason: string | null = null;
    if ('error' in result) reason = result.error;
    else if (!is2xx(result.status)) reason = statusCategory(result.status);
    else if (!echoes(result.body, challenge)) reason = 'challenge_failed';
    if (reason) throw new RpcError(CALLBACK_ENDPOINT_ERROR, 'CallbackEndpointError', { reason });
  }

  function echoes(body: Buffer, challenge: string): boolean {
    let echoed: unknown;
    try {
      echoed = JSON.parse(body.toString('utf8'));
    } catch {
      return false;
    }
    if (!isObject(echoed) || typeof echoed.challenge !== 'string') return false;
    const a = Buffer.from(echoed.challenge);
    const b = Buffer.from(challenge);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // --- Subscriptions ---

  // Deterministic over (principal, delivery.url, name, arguments) (SEP 460, 495).
  const subscriptionId = (url: string, name: string, args: Record<string, unknown>) =>
    `sub_${sha256(canonical([principal, url, name, args])).toString('hex').slice(0, 16)}`;

  function remove(sub: Subscription): void {
    if (subs.get(sub.id) === sub) subs.delete(sub.id);
    clearTimeout(sub.expiry);
    sub.stop.abort();
  }

  // Expired subscriptions are dropped here too, so a late timer never lets one linger.
  function live(id: string): Subscription | undefined {
    const sub = subs.get(id);
    if (sub && Date.now() >= sub.expiresAt) {
      remove(sub);
      return undefined;
    }
    return sub;
  }

  function arm(sub: Subscription): void {
    clearTimeout(sub.expiry);
    const ms = Math.min(Math.max(sub.expiresAt - Date.now(), 0), MAX_TIMER_MS);
    sub.expiry = setTimeout(() => (Date.now() >= sub.expiresAt ? remove(sub) : arm(sub)), ms);
    sub.expiry.unref();
  }

  // SEP 471-473. Omitted: the default. null asks for no expiry, which this in-memory mock
  // declines with a finite grant (SEP 465, 473, 480). Finite: at most the suggestion and
  // at most the default; a non-positive one is clamped up to 1 ms (SEP 472 allows a floor).
  function grant(sub: Subscription, ttlMs: number | null | undefined): string {
    const ms =
      ttlMs === undefined || ttlMs === null
        ? options.defaultTtlMs
        : Math.max(1, Math.min(ttlMs, options.defaultTtlMs));
    sub.expiresAt = Date.now() + ms;
    arm(sub);
    return new Date(sub.expiresAt).toISOString();
  }

  // Where a new subscription starts (SEP 461, 686-709). null: the head. A position older
  // than the retained window: the oldest retained entry, truncated. A cursor this log never
  // issued (another instance, i.e. a restart): the head, truncated (SEP 1062).
  function startPosition(replay: boolean, cursor: string | null): { position: number; truncated: boolean } {
    if (!replay || cursor === null) return { position: head, truncated: false };
    const seq = decodeCursor(cursor);
    if (seq === null) return { position: head, truncated: true };
    const oldest = log[0]?.seq ?? head + 1;
    if (seq < oldest - 1) return { position: oldest - 1, truncated: true };
    return { position: seq, truncated: false };
  }

  const matches = (sub: Subscription, entry: LogEntry) =>
    entry.name === sub.name && Object.entries(sub.arguments).every(([k, v]) => entry.data[k] === v);

  function findType(name: unknown): MockEventType {
    if (typeof name !== 'string') throw invalidParams('name must be a string');
    const type = types.get(name);
    if (!type) throw new RpcError(NOT_FOUND, 'NotFound', { kind: 'event' });
    return type;
  }

  // Only what MockEventType promises: an object schema with string properties.
  function readArguments(type: MockEventType, value: unknown): Record<string, unknown> {
    if (value === undefined) return {};
    if (!isObject(value)) throw invalidParams('arguments must be an object');
    const schema = type.inputSchema;
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [key, v] of Object.entries(value)) {
      const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (property === undefined && schema.additionalProperties === false) {
        throw invalidParams(`unknown argument ${key}`);
      }
      if (isObject(property) && property.type === 'string' && typeof v !== 'string') {
        throw invalidParams(`argument ${key} must be a string`);
      }
    }
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === 'string' && !Object.hasOwn(value, key)) throw invalidParams(`argument ${key} is required`);
    }
    return value;
  }

  // https only, and no loopback or private hosts (SEP 617, 632). Hostnames are checked
  // again after resolution, at delivery time (guardedLookup).
  function readCallbackUrl(value: unknown): string {
    if (typeof value !== 'string') throw invalidParams('delivery.url must be a string');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalidParams('delivery.url is not a valid URL');
    }
    if (insecure) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalidParams('delivery.url must be http(s)');
      return value;
    }
    if (url.protocol !== 'https:') throw invalidParams('delivery.url must use https');
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (isIP(host) ? isBlocked(host) : host === 'localhost' || host.endsWith('.localhost')) {
      throw invalidParams('delivery.url must not point at a loopback, private or link-local address');
    }
    return value;
  }

  function readTtl(value: unknown): number | null | undefined {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidParams('ttlMs must be a number or null');
    return value;
  }

  // Absent means null (SEP 690).
  function readCursor(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw invalidParams('cursor must be a string or null');
    return value;
  }

  function deliveryStatus(sub: Subscription) {
    return {
      active: true, // never suspended
      lastDeliveryAt: sub.lastDeliveryAt === null ? null : new Date(sub.lastDeliveryAt).toISOString(),
      lastError: sub.lastError,
    };
  }

  // --- Methods ---

  function discover(): Params {
    // SEP 54-75: the extension goes under capabilities.extensions, not a top-level events key.
    return { supportedVersions: [PROTOCOL_VERSION], capabilities: { extensions: { [EVENTS_EXTENSION]: {} } } };
  }

  function list(params: Params): Params {
    let start = 0;
    if (params.cursor !== undefined && params.cursor !== null) {
      const match = typeof params.cursor === 'string' ? /^page_(\d{1,9})$/.exec(params.cursor) : null;
      if (!match || Number(match[1]) > options.eventTypes.length) throw invalidParams('unknown cursor');
      start = Number(match[1]);
    }
    const size = Math.max(1, options.listPageSize ?? options.eventTypes.length);
    const end = start + size;
    const events = options.eventTypes.slice(start, end).map((t) => ({
      name: t.name,
      description: t.description,
      delivery: ['webhook'],
      inputSchema: t.inputSchema,
      payloadSchema: t.payloadSchema,
    }));
    return end < options.eventTypes.length ? { events, nextCursor: `page_${end}` } : { events };
  }

  async function subscribe(params: Params): Promise<Params> {
    const type = findType(params.name);
    const args = readArguments(type, params.arguments);
    const delivery = params.delivery;
    if (!isObject(delivery)) throw invalidParams('delivery must be an object');
    if (typeof delivery.mode !== 'string') throw invalidParams('delivery.mode must be a string');
    if (delivery.mode !== 'webhook') {
      throw new RpcError(UNSUPPORTED, 'Unsupported', { feature: 'deliveryMode', value: delivery.mode });
    }
    const url = readCallbackUrl(delivery.url);
    const secret = decodeSecret(delivery.secret);
    const ttlMs = readTtl(params.ttlMs);
    const cursor = readCursor(params.cursor);
    const id = subscriptionId(url, type.name, args);

    let sub = live(id);
    if (!sub) {
      const verifiedKey = `${principal}\n${url}`;
      if (!verified.has(verifiedKey)) {
        await verify({ id, url, secret });
        verified.add(verifiedKey);
      }
      if (closing.signal.aborted) throw new RpcError(INTERNAL_ERROR, 'Server closing');
      sub = live(id); // a concurrent subscribe may have created it during the handshake
    }

    // Existing key: replace the secret, grant again; the cursor is a no-op (SEP 497-504).
    if (sub) {
      sub.secret = secret;
      const refreshBefore = grant(sub, ttlMs);
      return {
        id,
        refreshBefore,
        cursor: sub.replay ? encodeCursor(watermark(sub)) : null,
        truncated: false,
        deliveryStatus: deliveryStatus(sub),
      };
    }

    const { position, truncated } = startPosition(type.replay, cursor);
    const created: Subscription = {
      id,
      url,
      name: type.name,
      arguments: args,
      replay: type.replay,
      secret,
      expiresAt: 0,
      scanned: head,
      pending: new Map(),
      stop: new AbortController(),
      lastDeliveryAt: null,
      lastError: null,
    };
    subs.set(id, created);
    const refreshBefore = grant(created, ttlMs);
    enqueue(
      created,
      log.filter((e) => e.seq > position && matches(created, e)),
    );
    return {
      id,
      refreshBefore,
      cursor: type.replay ? encodeCursor(watermark(created)) : null,
      truncated,
    };
  }

  function unsubscribe(params: Params): Params {
    if (typeof params.name !== 'string') throw invalidParams('name must be a string');
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isObject(args)) throw invalidParams('arguments must be an object');
    // delivery.mode is not part of the key; tolerated if present.
    if (!isObject(params.delivery) || typeof params.delivery.url !== 'string') {
      throw invalidParams('delivery.url must be a string');
    }
    const sub = live(subscriptionId(params.delivery.url, params.name, args));
    if (!sub) throw new RpcError(NOT_FOUND, 'NotFound', { kind: 'subscription' });
    remove(sub);
    return {};
  }

  const methods = new Map<string, (params: Params) => Params | Promise<Params>>([
    ['server/discover', discover],
    ['events/list', list],
    ['events/subscribe', subscribe],
    ['events/unsubscribe', unsubscribe],
  ]);

  // --- HTTP ---

  function readBody(req: IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_REQUEST_BYTES) chunks.push(chunk);
      });
      req.on('end', () => resolve(size > MAX_REQUEST_BYTES ? null : Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function authorized(header: string | undefined): boolean {
    if (header === undefined) return false;
    const match = /^bearer +(.+)$/i.exec(header);
    return match !== null && timingSafeEqual(sha256(`Bearer ${match[1]}`), expectedAuth);
  }

  function json(res: ServerResponse, status: number, message: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(message));
  }

  const errorMessage = (id: unknown, code: number, message: string, data?: unknown) => ({
    jsonrpc: '2.0',
    ...(id === undefined ? {} : { id }),
    error: data === undefined ? { code, message } : { code, message, data },
  });

  // Method results and method errors go out as 200, as JSON or SSE. Transport-level
  // rejections (400, 404) are always plain JSON.
  function respond(res: ServerResponse, message: unknown): void {
    if (!options.sseResponses) return json(res, 200, message);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no', // streamable-http.mdx 136-142
    });
    // A comment first: progress and log notifications need the client to opt in
    // (basic-index.mdx 352, 356), and this request did not.
    res.write(': evdock mock server\n\n');
    res.end(`data: ${JSON.stringify(message)}\n\n`);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if ((req.url ?? '').split('?')[0] !== '/mcp') {
      req.resume();
      return void res.writeHead(404).end();
    }
    if (req.method !== 'POST') {
      req.resume();
      return void res.writeHead(405, { allow: 'POST' }).end(); // streamable-http.mdx 683-684
    }
    // DNS-rebinding guard (streamable-http.mdx 58-62). Non-browser clients send no Origin.
    if (req.headers.origin !== undefined && req.headers.origin !== origin) {
      req.resume();
      return void res.writeHead(403).end();
    }
    if (!authorized(req.headers.authorization)) {
      req.resume();
      return void res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
    }

    const raw = await readBody(req);
    if (raw === null) return void res.writeHead(413).end();
    let message: unknown;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      return json(res, 400, errorMessage(null, PARSE_ERROR, 'Parse error'));
    }
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      const id = isObject(message) ? message.id : undefined;
      const readable = typeof id === 'string' || typeof id === 'number';
      return json(res, 400, errorMessage(readable ? id : null, INVALID_REQUEST, 'Invalid Request'));
    }
    // No client notifications are defined (streamable-http.mdx 93-105); accept and ignore.
    if (!('id' in message)) return void res.writeHead(202).end();
    const { id, method } = message;
    if (typeof id !== 'string' && typeof id !== 'number') {
      return json(res, 400, errorMessage(null, INVALID_REQUEST, 'Invalid Request: id must be a string or number'));
    }

    // Request metadata (streamable-http.mdx 250-281, 580-631; basic-index.mdx 365-382).
    const version = req.headers['mcp-protocol-version'];
    if (version === undefined) {
      return json(res, 400, errorMessage(id, HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version is missing'));
    }
    if (version !== PROTOCOL_VERSION) {
      return json(
        res,
        400,
        errorMessage(id, UNSUPPORTED_VERSION, 'Unsupported protocol version', {
          supported: [PROTOCOL_VERSION],
          requested: version,
        }),
      );
    }
    if (req.headers['mcp-method'] !== method) {
      return json(res, 400, errorMessage(id, HEADER_MISMATCH, 'Header mismatch: Mcp-Method does not match the body'));
    }
    const params = message.params === undefined ? {} : message.params;
    const meta = isObject(params) && isObject(params._meta) ? params._meta : undefined;
    if (!isObject(params) || !meta || typeof meta[META_VERSION] !== 'string' || !isObject(meta[META_CAPABILITIES])) {
      const text = `Invalid params: _meta needs ${META_VERSION} and ${META_CAPABILITIES}`;
      return json(res, 400, errorMessage(id, INVALID_PARAMS, text));
    }
    if (meta[META_VERSION] !== version) {
      const text = 'Header mismatch: MCP-Protocol-Version does not match _meta';
      return json(res, 400, errorMessage(id, HEADER_MISMATCH, text));
    }
    // An unknown method is a 404 with -32601 (streamable-http.mdx 271-275).
    const handler = methods.get(method);
    if (!handler) return json(res, 404, errorMessage(id, METHOD_NOT_FOUND, 'Method not found'));

    try {
      const result = await handler(params);
      // Every result carries resultType (SEP 41; basic-index.mdx 73) and serverInfo (basic-index.mdx 396-402).
      respond(res, { jsonrpc: '2.0', id, result: { resultType: 'complete', ...result, _meta: SERVER_META } });
    } catch (err) {
      if (err instanceof RpcError) respond(res, errorMessage(id, err.code, err.message, err.data));
      else respond(res, errorMessage(id, INTERNAL_ERROR, 'Internal error'));
    }
  }

  const httpServer = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 0, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const { port } = httpServer.address() as AddressInfo;
  origin = `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;

  return {
    url: `${origin}/mcp`,

    emit(name, data) {
      const type = types.get(name);
      if (!type) throw new Error(`unknown event type: ${name}`);
      if (!isObject(data)) throw new Error('data must be an object');
      const seq = ++head;
      const entry: LogEntry = {
        seq,
        eventId: `evt_${instance}_${seq}`,
        name,
        timestamp: new Date().toISOString(),
        data: structuredClone(data),
      };
      log.push(entry);
      if (options.retentionEvents !== undefined && log.length > options.retentionEvents) {
        log.splice(0, log.length - options.retentionEvents);
      }
      for (const sub of [...subs.values()]) {
        if (!live(sub.id)) continue;
        // Advance first, so the entry's own payload cursor can cover it.
        sub.scanned = seq;
        if (matches(sub, entry)) enqueue(sub, [entry]);
      }
      return { eventId: entry.eventId, cursor: type.replay ? encodeCursor(seq) : null };
    },

    async terminate(subscriptionId, error) {
      const sub = live(subscriptionId);
      if (!sub) throw new Error(`no live subscription ${subscriptionId}`);
      // Removed before the envelope goes out, so no event delivery can follow it (SEP 548, 719).
      remove(sub);
      const body = JSON.stringify({ type: 'terminated', error: error ?? { code: FORBIDDEN, message: 'Forbidden' } });
      await send(sub, `msg_terminated_${random()}`, body, closing.signal);
    },

    subscriptions() {
      return [...subs.keys()].flatMap((id) => {
        const sub = live(id);
        return sub
          ? [
              {
                id: sub.id,
                url: sub.url,
                name: sub.name,
                arguments: structuredClone(sub.arguments),
                expiresAt: sub.expiresAt,
                verified: true,
              },
            ]
          : [];
      });
    },

    attempts() {
      return attemptLog.map((a) => ({ ...a }));
    },

    async close() {
      closing.abort();
      for (const sub of [...subs.values()]) remove(sub);
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
