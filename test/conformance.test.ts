import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { runSuite } from '../src/conformance/suite.js';
import { createReceiver } from '../src/http.js';
import { Inbox } from '../src/inbox.js';
import { handleDelivery, MAX_BODY_BYTES } from '../src/receiver.js';
import { decodeSecret, verifySignature } from '../src/signature.js';
import { close, listen, newSecret, newToken, tempDir } from './helpers.js';

test('evdock passes every check, including SHOULD and MAY', async (t) => {
  const { dir, cleanup } = tempDir();
  const inbox = new Inbox(join(dir, 'inbox.db'));
  const server = createReceiver({ inbox });
  const base = await listen(server);
  t.after(async () => {
    await close(server);
    inbox.close();
    cleanup();
  });
  const token = newToken();
  const secret = newSecret();
  inbox.addSubscription({ token, secret });
  inbox.confirmSubscription(token, 'sub_conformance');

  const report = await runSuite({ url: `${base}/hooks/${token}`, secret, subscriptionId: 'sub_conformance' });
  const failed = report.results.filter((r) => r.outcome === 'fail').map((r) => `${r.id}: ${r.actual}`);
  assert.deepEqual(failed, []);
  assert.equal(report.conformant, true);
  assert.equal(report.results.length, 15);
});

test('a receiver that accepts everything is caught', async (t) => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(200).end());
  });
  const base = await listen(server);
  t.after(() => close(server));

  const report = await runSuite({ url: `${base}/hooks/x`, secret: newSecret(), subscriptionId: 'sub_x' });
  const failed = report.results.filter((r) => r.outcome === 'fail').map((r) => r.id);
  assert.equal(report.conformant, false);
  for (const id of [
    'bad-signature',
    'stale-timestamp',
    'verification',
    'oversized',
    'missing-webhook-id',
    'missing-webhook-timestamp',
    'missing-webhook-signature',
  ]) {
    assert.ok(failed.includes(id), id);
  }
});

test('a receiver that verifies re-serialized JSON fails raw-body', async (t) => {
  const secret = newSecret();
  const key = decodeSecret(secret);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let reserialized: Buffer;
      try {
        reserialized = Buffer.from(JSON.stringify(JSON.parse(Buffer.concat(chunks).toString())));
      } catch {
        return res.writeHead(400).end();
      }
      const h = req.headers as Record<string, string | undefined>;
      const [id, ts, sig] = [h['webhook-id'], h['webhook-timestamp'], h['webhook-signature']];
      if (!id || !ts || !sig) return res.writeHead(400).end();
      const ok = verifySignature(key, id, ts, reserialized, sig);
      res.writeHead(ok ? 200 : 401).end();
    });
  });
  const base = await listen(server);
  t.after(() => close(server));

  const report = await runSuite({ url: `${base}/hooks/x`, secret, subscriptionId: 'sub_x' });
  const byId = new Map(report.results.map((r) => [r.id, r.outcome]));
  assert.equal(byId.get('valid-event'), 'pass', 'compact JSON survives re-serialization');
  assert.equal(byId.get('raw-body'), 'fail');
  assert.equal(report.conformant, false);
});

test('a receiver that proves intent without the handshake passes with handshake: false', async (t) => {
  // evdock's checks, except verification gets an empty 204 instead of the echoed challenge.
  const { dir, cleanup } = tempDir();
  const inbox = new Inbox(join(dir, 'inbox.db'));
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    if (body.length > MAX_BODY_BYTES) return res.writeHead(413).end();
    const token = req.url!.slice('/hooks/'.length);
    const headers = req.headers as Record<string, string>;
    const result = handleDelivery(inbox, { token, headers, body, receivedAtMs: Date.now() });
    res.writeHead(result.json ? 204 : result.status).end();
  });
  const base = await listen(server);
  t.after(async () => {
    await close(server);
    inbox.close();
    cleanup();
  });
  // Each run ends with terminated, which removes the subscription, so each gets a fresh path.
  const freshTarget = () => {
    const token = newToken();
    const secret = newSecret();
    inbox.addSubscription({ token, secret });
    inbox.confirmSubscription(token, 'sub_x');
    return { url: `${base}/hooks/${token}`, secret, subscriptionId: 'sub_x' };
  };

  const strict = await runSuite(freshTarget());
  assert.deepEqual(
    strict.results.filter((r) => r.outcome === 'fail').map((r) => r.id),
    ['verification'],
  );
  assert.equal(strict.conformant, false);

  const lenient = await runSuite(freshTarget(), { handshake: false });
  assert.equal(lenient.results.find((r) => r.id === 'verification')?.outcome, 'info');
  assert.equal(lenient.conformant, true);
});

test('an unreachable receiver fails without throwing', async () => {
  const server = createServer();
  const base = await listen(server);
  await close(server);
  const report = await runSuite({ url: `${base}/hooks/x`, secret: newSecret(), subscriptionId: 'sub_x' });
  assert.equal(report.conformant, false);
  assert.match(report.results[0]!.actual, /^error: /);
});
