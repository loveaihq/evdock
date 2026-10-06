// The daemon's side of the relay's /relay/* endpoints (docs/M3-TASK.md, "交付" 1).
// The daemon always connects out; the relay never connects in.

import type { Inbox, Subscription } from './inbox.js';
import type { PathState } from './relay/core.js';

const TIMEOUT_MS = 30_000;

export class RelayError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

export interface FetchedDelivery {
  seq: number;
  token: string;
  receivedAt: number;
  headers: Record<string, string>;
  body: Buffer;
}

export class RelayClient {
  readonly url: string;

  constructor(
    url: string,
    private readonly key: string,
  ) {
    this.url = url.replace(/\/+$/, '');
  }

  /** True if the subscription's callback goes through this relay. */
  carries(sub: Subscription): boolean {
    return sub.callbackUrl?.startsWith(`${this.url}/hooks/`) === true;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.key}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      throw new RelayError(`relay ${method} ${path.split('/').slice(0, 3).join('/')}: ${cause?.code ?? (err as Error).message}`);
    }
    if (res.status === 401) throw new RelayError('relay rejected the relay key (HTTP 401)', 401);
    if (!res.ok) throw new RelayError(`relay ${method} ${path.split('/').slice(0, 3).join('/')}: HTTP ${res.status}`, res.status);
    return res;
  }

  /** Registers a receive path (pending: handshake only) or confirms it (events are stored). */
  async setPath(token: string, state: PathState): Promise<void> {
    await this.call('PUT', `/relay/paths/${token}`, { state });
  }

  async deletePath(token: string): Promise<void> {
    await this.call('DELETE', `/relay/paths/${token}`);
  }

  async fetchDeliveries(): Promise<{ deliveries: FetchedDelivery[]; more: boolean }> {
    const res = await this.call('GET', '/relay/deliveries');
    const parsed = (await res.json()) as {
      deliveries?: Array<Omit<FetchedDelivery, 'body'> & { body: string }>;
      more?: boolean;
    };
    const deliveries = (parsed.deliveries ?? []).map((d) => ({ ...d, body: Buffer.from(d.body, 'base64') }));
    return { deliveries, more: parsed.more === true };
  }

  async ack(upTo: number): Promise<void> {
    await this.call('POST', '/relay/ack', { upTo });
  }
}

/**
 * Subscriptions still receiving through the relay at `relayUrl`. Switching relays away from
 * under them would lose events silently: the server keeps delivering there and getting 2xx,
 * but nobody fetches any more.
 */
export function liveOn(inbox: Inbox, relayUrl: string): Subscription[] {
  const prefix = `${relayUrl.replace(/\/+$/, '')}/hooks/`;
  return inbox
    .listSubscriptions()
    .filter((s) => (s.status === 'active' || s.status === 'pending') && s.callbackUrl?.startsWith(prefix) === true);
}

/** The configured relay with its key from the environment, or undefined when none is configured. */
export function relayFromInbox(inbox: Inbox): RelayClient | undefined {
  const setting = inbox.getRelay();
  if (!setting) return undefined;
  const key = process.env[setting.keyEnv];
  if (!key) throw new Error(`environment variable ${setting.keyEnv} (relay key) is not set`);
  return new RelayClient(setting.url, key);
}
