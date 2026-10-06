// Conformance checks for an MCP Events webhook receiver. Plays the MCP server side:
// signs and POSTs deliveries to a receiver URL and judges the HTTP responses.
//
// Self-contained on purpose (Node built-ins only, nothing from evdock) so it can be
// pointed at any receiver. Requirement levels follow the MCP Events design sketch
// (docs/spec/design-sketch-2026-10-06.md); only MUST failures make a receiver non-conformant.

import { createHmac, randomBytes } from 'node:crypto';

export type Level = 'MUST' | 'SHOULD' | 'MAY' | 'UNSPECIFIED';
export type Outcome = 'pass' | 'fail' | 'info';

export interface Target {
  /** The receiver's callback URL. */
  url: string;
  /** The whsec_ secret the receiver expects deliveries to be signed with. */
  secret: string;
  /** Value for X-MCP-Subscription-Id. */
  subscriptionId: string;
}

export interface Attempt {
  status?: number;
  body?: string;
  error?: string;
}

export interface CaseResult {
  id: string;
  title: string;
  level: Level;
  expected: string;
  actual: string;
  outcome: Outcome;
  note?: string;
  attempts: Attempt[];
}

export interface Report {
  tool: string;
  spec: string;
  target: string;
  subscriptionId: string;
  startedAt: string;
  finishedAt: string;
  conformant: boolean;
  counts: Record<Level, { pass: number; fail: number; info: number }>;
  results: CaseResult[];
}

const SPEC = 'MCP Events design sketch, experimental-ext-triggers-events@28ec35e';
const MAX_BODY_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;

function decodeSecret(secret: string): Buffer {
  const encoded = secret.startsWith('whsec_') ? secret.slice(6) : '';
  const key = Buffer.from(encoded, 'base64');
  if (!encoded || key.length < 24 || key.length > 64) {
    throw new Error('secret must be whsec_ followed by base64 of 24-64 bytes');
  }
  return key;
}

function sign(key: Buffer, id: string, timestamp: string, body: Buffer): string {
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.`, 'utf8').update(body).digest('base64');
  return `v1,${mac}`;
}

const random = () => randomBytes(9).toString('base64url');
const is2xx = (a: Attempt) => a.status !== undefined && a.status >= 200 && a.status < 300;
const describe = (a: Attempt) => (a.error ? `error: ${a.error}` : String(a.status));

interface DeliveryOptions {
  id: string;
  body: Buffer;
  /** Unix seconds; defaults to now. */
  timestamp?: number;
  /** Replaces the computed signature header. */
  signature?: string;
  /** Header to leave out. */
  omit?: string;
}

export interface SuiteOptions {
  /**
   * False when the receiver proves intent another way (server allowlist, out-of-band
   * registration, or a well-known document): the handshake check is then recorded, not counted.
   */
  handshake?: boolean;
  now?: () => number;
}

export async function runSuite(target: Target, options: SuiteOptions = {}): Promise<Report> {
  const now = options.now ?? Date.now;
  const handshake = options.handshake ?? true;
  const key = decodeSecret(target.secret);
  const otherKey = randomBytes(32);
  const startedAt = new Date(now()).toISOString();
  const nowSeconds = () => Math.floor(now() / 1000);

  async function deliver(opts: DeliveryOptions): Promise<Attempt> {
    const timestamp = String(opts.timestamp ?? nowSeconds());
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'webhook-id': opts.id,
      'webhook-timestamp': timestamp,
      'webhook-signature': opts.signature ?? sign(key, opts.id, timestamp, opts.body),
      'x-mcp-subscription-id': target.subscriptionId,
    };
    if (opts.omit) delete headers[opts.omit];
    try {
      const res = await fetch(target.url, {
        method: 'POST',
        headers,
        body: new Uint8Array(opts.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { status: res.status, body: await res.text() };
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      return { error: cause?.code ?? (err as Error).message };
    }
  }

  function eventBody(eventId: string, extra: Record<string, unknown> = {}): Buffer {
    return Buffer.from(
      JSON.stringify({
        eventId,
        name: 'conformance.test',
        timestamp: new Date(now()).toISOString(),
        data: { note: 'sent by the conformance suite' },
        ...extra,
      }),
    );
  }

  const results: CaseResult[] = [];
  function record(
    c: Omit<CaseResult, 'outcome' | 'actual'>,
    passed: boolean,
    actual = c.attempts.map(describe).join(', '),
    counted = c.level !== 'UNSPECIFIED',
  ) {
    const outcome: Outcome = !counted ? 'info' : passed ? 'pass' : 'fail';
    results.push({ ...c, actual, outcome });
  }

  // 1. Baseline: a correctly signed event is accepted.
  {
    const id = `evt_conformance_${random()}`;
    const a = await deliver({ id, body: eventBody(id, { cursor: `cursor_conformance_${random()}` }) });
    record(
      { id: 'valid-event', title: 'Valid event delivery', level: 'MUST', expected: '2xx', attempts: [a] },
      is2xx(a),
    );
  }

  // 2. A signature made with a different secret is rejected.
  {
    const id = `evt_conformance_${random()}`;
    const body = eventBody(id);
    const timestamp = String(nowSeconds());
    const a = await deliver({ id, body, signature: sign(otherKey, id, timestamp, body), timestamp: Number(timestamp) });
    record(
      { id: 'bad-signature', title: 'Signature from a different secret', level: 'MUST', expected: 'non-2xx', attempts: [a] },
      !is2xx(a) && a.error === undefined,
    );
  }

  // 3. A correctly signed delivery with a 10-minute-old timestamp is rejected.
  {
    const id = `evt_conformance_${random()}`;
    const a = await deliver({ id, body: eventBody(id), timestamp: nowSeconds() - 600 });
    record(
      { id: 'stale-timestamp', title: 'Timestamp 10 minutes old', level: 'SHOULD', expected: 'non-2xx', attempts: [a] },
      !is2xx(a) && a.error === undefined,
    );
  }

  // 4. The identical request twice. Dedup itself is invisible from outside; this checks
  //    the duplicate is answered as accepted (2xx) or "don't retry" (410), not as an error.
  {
    const id = `evt_conformance_${random()}`;
    const body = eventBody(id);
    const timestamp = nowSeconds();
    const first = await deliver({ id, body, timestamp });
    const second = await deliver({ id, body, timestamp });
    record(
      {
        id: 'replay',
        title: 'Same request sent twice',
        level: 'SHOULD',
        expected: '2xx, then 2xx or 410',
        attempts: [first, second],
        note: 'Whether the duplicate was stored once cannot be seen from outside the receiver.',
      },
      is2xx(first) && (is2xx(second) || second.status === 410),
    );
  }

  // 5. A retry: same webhook-id, regenerated timestamp and signature.
  {
    const id = `evt_conformance_${random()}`;
    const body = eventBody(id);
    const first = await deliver({ id, body, timestamp: nowSeconds() - 30 });
    const second = await deliver({ id, body, timestamp: nowSeconds() });
    record(
      {
        id: 'retry',
        title: 'Retry with new timestamp and signature',
        level: 'SHOULD',
        expected: '2xx, then 2xx or 410',
        attempts: [first, second],
        note: 'Whether the retry was stored once cannot be seen from outside the receiver.',
      },
      is2xx(first) && (is2xx(second) || second.status === 410),
    );
  }

  // 6. Secret rotation: two space-delimited v1 signatures, one from an unknown secret, in both orders.
  {
    const attempts: Attempt[] = [];
    for (const order of ['unknown-first', 'known-first']) {
      const id = `evt_conformance_${random()}`;
      const body = eventBody(id);
      const timestamp = String(nowSeconds());
      const known = sign(key, id, timestamp, body);
      const unknown = sign(otherKey, id, timestamp, body);
      const signature = order === 'unknown-first' ? `${unknown} ${known}` : `${known} ${unknown}`;
      attempts.push(await deliver({ id, body, timestamp: Number(timestamp), signature }));
    }
    record(
      { id: 'rotation', title: 'Two v1 signatures, one old one new', level: 'MUST', expected: '2xx, 2xx', attempts },
      attempts.every(is2xx),
    );
  }

  // 7. Raw-body verification: whitespace, key order and escapes that re-serialization would change.
  {
    const id = `evt_conformance_${random()}`;
    const body = Buffer.from(
      `{\n  "timestamp" : "${new Date(now()).toISOString()}",\n\t"name":"conformance.test" ,` +
        `  "data": { "z": 1, "a": [ 1.0, 2e0 ], "note": "caf\\u00e9 / café" },\r\n "eventId": "${id}"  }\n`,
    );
    const a = await deliver({ id, body });
    record(
      {
        id: 'raw-body',
        title: 'Non-canonical JSON (whitespace, key order, escapes)',
        level: 'MUST',
        expected: '2xx',
        attempts: [a],
        note: 'Fails if the receiver verifies a re-serialized body instead of the raw bytes.',
      },
      is2xx(a),
    );
  }

  // 8. Verification handshake: the challenge comes back in a 2xx JSON body.
  {
    const challenge = randomBytes(24).toString('base64url');
    const a = await deliver({
      id: `msg_verification_${random()}`,
      body: Buffer.from(JSON.stringify({ type: 'verification', challenge })),
    });
    let echoed: unknown;
    try {
      echoed = (JSON.parse(a.body ?? '') as { challenge?: unknown }).challenge;
    } catch {
      echoed = undefined;
    }
    const ok = is2xx(a) && echoed === challenge;
    record(
      {
        id: 'verification',
        title: 'Verification handshake',
        level: 'MUST',
        expected: '2xx with {"challenge": <same nonce>}',
        attempts: [a],
        note: handshake
          ? 'Required of receivers that prove intent by handshake. Run with --no-handshake if this receiver uses an allowlist, out-of-band registration or a well-known document instead.'
          : 'Recorded only (--no-handshake): the receiver proves intent another way.',
      },
      ok,
      `${describe(a)}${is2xx(a) ? (echoed === challenge ? ', challenge echoed' : ', challenge missing or wrong') : ''}`,
      handshake,
    );
  }

  // 9. gap control envelope is accepted (the endpoint must forward control envelopes).
  {
    const a = await deliver({
      id: `msg_gap_${random()}`,
      body: Buffer.from(JSON.stringify({ type: 'gap', cursor: `cursor_conformance_${random()}` })),
    });
    record({ id: 'gap', title: 'gap control envelope', level: 'MUST', expected: '2xx', attempts: [a] }, is2xx(a));
  }

  // 10. A correctly signed body just over 256 KiB.
  {
    const id = `evt_conformance_${random()}`;
    const base = eventBody(id, { data: { padding: '' } }).length;
    const body = eventBody(id, { data: { padding: 'x'.repeat(MAX_BODY_BYTES - base + 1) } });
    const a = await deliver({ id, body });
    record(
      { id: 'oversized', title: `Body of ${body.length} bytes (> 256 KiB)`, level: 'MAY', expected: '413', attempts: [a] },
      a.status === 413,
    );
  }

  // 11-14. Each required header missing in turn. Without webhook-id, -timestamp or -signature
  //        the signature cannot be verified, so acceptance would mean processing unverified input.
  for (const header of ['webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id']) {
    const id = `evt_conformance_${random()}`;
    const a = await deliver({ id, body: eventBody(id), omit: header });
    const unspecified = header === 'x-mcp-subscription-id';
    record(
      {
        id: `missing-${header}`,
        title: `Missing ${header} header`,
        level: unspecified ? 'UNSPECIFIED' : 'MUST',
        expected: unspecified ? 'not specified (recorded only)' : 'non-2xx',
        attempts: [a],
      },
      !is2xx(a) && a.error === undefined,
    );
  }

  // 15. terminated last: a receiver may tear the subscription down after it.
  {
    const a = await deliver({
      id: `msg_terminated_${random()}`,
      body: Buffer.from(
        JSON.stringify({
          type: 'terminated',
          error: { code: -32012, message: 'Forbidden', data: { reason: 'conformance suite' } },
        }),
      ),
    });
    record(
      {
        id: 'terminated',
        title: 'terminated control envelope (sent last)',
        level: 'MUST',
        expected: '2xx',
        attempts: [a],
        note: 'The receiver may end the subscription after this; register a fresh one before re-running.',
      },
      is2xx(a),
    );
  }

  const counts = {} as Report['counts'];
  for (const level of ['MUST', 'SHOULD', 'MAY', 'UNSPECIFIED'] as Level[]) {
    const of = results.filter((r) => r.level === level);
    counts[level] = {
      pass: of.filter((r) => r.outcome === 'pass').length,
      fail: of.filter((r) => r.outcome === 'fail').length,
      info: of.filter((r) => r.outcome === 'info').length,
    };
  }

  return {
    tool: 'evdock-conformance',
    spec: SPEC,
    target: target.url,
    subscriptionId: target.subscriptionId,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    conformant: counts.MUST.fail === 0,
    counts,
    results,
  };
}

export function formatTable(report: Report): string {
  const rows = report.results.map((r, i) => [
    String(i + 1),
    r.id,
    r.level,
    r.expected,
    r.actual,
    r.outcome.toUpperCase(),
  ]);
  const header = ['#', 'case', 'level', 'expected', 'actual', 'result'];
  const widths = header.map((h, col) => Math.max(h.length, ...rows.map((row) => row[col]!.length)));
  const line = (cells: string[]) => cells.map((cell, col) => cell.padEnd(widths[col]!)).join('  ').trimEnd();
  const c = report.counts;
  const recordedOnly = Object.values(c).reduce((sum, level) => sum + level.info, 0);
  const baselineFailed = report.results.find((r) => r.id === 'valid-event')?.outcome === 'fail';
  return [
    `Target: ${report.target}`,
    `Spec:   ${report.spec}`,
    '',
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
    '',
    'Notes:',
    ...report.results.filter((r) => r.note).map((r) => `  ${r.id}: ${r.note}`),
    ...(baselineFailed
      ? ['', 'Warning: the valid-event baseline failed, so a PASS on a check that expects rejection says little.']
      : []),
    '',
    `MUST ${c.MUST.pass}/${c.MUST.pass + c.MUST.fail} passed, ` +
      `SHOULD ${c.SHOULD.pass}/${c.SHOULD.pass + c.SHOULD.fail}, ` +
      `MAY ${c.MAY.pass}/${c.MAY.pass + c.MAY.fail}, recorded only ${recordedOnly}`,
    `Conformant: ${report.conformant ? 'yes' : 'no'} (only MUST failures count)`,
  ].join('\n');
}
