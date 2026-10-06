// Decides the response to one webhook POST. Transport-free so the HTTP server here
// and the relay (M3) can share it. Status choices the spec leaves open are in docs/decisions.md.

import { classify, MalformedBody } from './classify.js';
import type { Inbox } from './inbox.js';
import { decodeSecret, verifySignature } from './signature.js';
import { isFresh, parseTimestamp } from './timestamp.js';

/** Bodies larger than this get 413 (the spec's 256 KiB delivery profile). */
export const MAX_BODY_BYTES = 256 * 1024;

const REQUIRED_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id'] as const;

export interface DeliveryRequest {
  /** The `<token>` from `/hooks/<token>`. */
  token: string;
  /** Header values keyed by lower-case name. */
  headers: Record<string, string | undefined>;
  /** Raw body bytes exactly as received. */
  body: Buffer;
  /** When the request was received. Passed in so a relay can supply its own receive time. */
  receivedAtMs: number;
}

export interface DeliveryResponse {
  status: number;
  json?: unknown;
  /** Short reason for logs. Never contains the body or the secret. */
  outcome: string;
}

export function handleDelivery(
  inbox: Pick<Inbox, 'getSubscription' | 'store'>,
  req: DeliveryRequest,
): DeliveryResponse {
  let subscription;
  try {
    subscription = inbox.getSubscription(req.token);
  } catch {
    return { status: 503, outcome: 'inbox-unavailable' };
  }
  // Ended subscriptions (stopped, unsubscribed, terminated) are no longer receive paths.
  if (!subscription || (subscription.status !== 'pending' && subscription.status !== 'active')) {
    return { status: 404, outcome: 'unknown-path' };
  }

  for (const name of REQUIRED_HEADERS) {
    if (!req.headers[name]) return { status: 400, outcome: `missing-${name}` };
  }
  const webhookId = req.headers['webhook-id']!;
  const timestampHeader = req.headers['webhook-timestamp']!;
  const signatureHeader = req.headers['webhook-signature']!;
  const subscriptionIdHeader = req.headers['x-mcp-subscription-id']!;

  const timestamp = parseTimestamp(timestampHeader);
  if (timestamp === null) return { status: 400, outcome: 'malformed-webhook-timestamp' };

  // The secret is chosen by path, not by X-MCP-Subscription-Id: verification arrives
  // before the subscribe response, when the receiver does not know the id yet.
  const key = decodeSecret(subscription.secret);
  if (!verifySignature(key, webhookId, timestampHeader, req.body, signatureHeader)) {
    return { status: 401, outcome: 'bad-signature' };
  }
  if (!isFresh(timestamp, req.receivedAtMs)) return { status: 401, outcome: 'stale-timestamp' };

  let message;
  try {
    message = classify(req.body);
  } catch (err) {
    if (err instanceof MalformedBody) return { status: 400, outcome: 'malformed-body' };
    throw err;
  }

  // Answered even before the subscription is confirmed, and never deduplicated:
  // a re-sent challenge must be echoed again.
  if (message.kind === 'verification') {
    return { status: 200, json: { challenge: message.challenge }, outcome: 'verification' };
  }

  // Both are "an id this path has not been told to route": retryable, per the spec's 503/425.
  if (subscription.status === 'pending' || subscription.subscriptionId === null) {
    return { status: 503, outcome: 'unconfirmed' };
  }
  if (subscriptionIdHeader !== subscription.subscriptionId) {
    return { status: 503, outcome: 'subscription-id-mismatch' };
  }

  let result;
  try {
    result = inbox.store({
      token: req.token,
      subscriptionId: subscriptionIdHeader,
      webhookId,
      message,
      body: req.body,
      receivedAtMs: req.receivedAtMs,
    });
  } catch {
    return { status: 503, outcome: 'store-failed' };
  }
  return { status: 200, outcome: `${result}-${message.kind}` };
}
