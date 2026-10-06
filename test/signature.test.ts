import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Webhook } from 'standardwebhooks';
import { computeSignature, decodeSecret, verifySignature } from '../src/signature.js';
import { newSecret, officialSign } from './helpers.js';

const now = () => Math.floor(Date.now() / 1000);

test('accepts signatures made by the official standardwebhooks library', () => {
  for (const bytes of [24, 32, 64]) {
    const secret = newSecret(bytes);
    const id = `evt_${randomBytes(6).toString('hex')}`;
    const ts = now();
    const body = JSON.stringify({ eventId: id, name: 'x', timestamp: 't', data: { n: bytes } });
    const header = officialSign(secret, id, ts, body);
    assert.equal(verifySignature(decodeSecret(secret), id, String(ts), Buffer.from(body), header), true);
  }
});

test('the official library accepts signatures made here', () => {
  const secret = newSecret();
  const id = 'evt_789';
  const ts = String(now());
  const body = '{"eventId":"evt_789","name":"incident.created","timestamp":"2026-02-19T16:00:00Z","data":{}}';
  const signature = `v1,${computeSignature(decodeSecret(secret), id, ts, Buffer.from(body))}`;
  assert.doesNotThrow(() =>
    new Webhook(secret).verify(body, { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signature }),
  );
});

test('signs the raw bytes: id.timestamp. in UTF-8, then the body as-is', () => {
  const key = randomBytes(32);
  const body = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]); // not valid UTF-8
  const expected = createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from('msg_1.1700000000.', 'utf8'), body]))
    .digest('base64');
  assert.equal(computeSignature(key, 'msg_1', '1700000000', body), expected);
});

test('verifies the raw body, not a re-serialized one', () => {
  const secret = newSecret();
  const key = decodeSecret(secret);
  const raw = '{ "data": {"b":1, "a":2},  "eventId":"e1", "name":"n", "timestamp":"t" }\n';
  const header = officialSign(secret, 'e1', 1700000000, raw);
  assert.equal(verifySignature(key, 'e1', '1700000000', Buffer.from(raw), header), true);
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw)));
  assert.equal(verifySignature(key, 'e1', '1700000000', reserialized, header), false);
});

test('multiple signatures: any v1 match is enough; other versions are ignored', () => {
  const secret = newSecret();
  const key = decodeSecret(secret);
  const body = Buffer.from('{}');
  const good = officialSign(secret, 'm', 1700000000, '{}');
  const bad = officialSign(newSecret(), 'm', 1700000000, '{}');
  const goodValue = good.slice(3);
  const check = (header: string) => verifySignature(key, 'm', '1700000000', body, header);

  assert.equal(check(`${bad} ${good}`), true);
  assert.equal(check(`${good} ${bad}`), true);
  assert.equal(check(`v1a,${randomBytes(64).toString('base64')} ${good}`), true);
  assert.equal(check(`  ${good}  `), true);
  assert.equal(check(`v1a,${goodValue}`), false, 'a matching value under v1a must not count');
  assert.equal(check(`v2,${goodValue}`), false);
  assert.equal(check(bad), false);
  assert.equal(check(''), false);
  assert.equal(check(`v1,${goodValue}x`), false);
});

test('any change to id, timestamp or body breaks the signature', () => {
  const secret = newSecret();
  const key = decodeSecret(secret);
  const header = officialSign(secret, 'evt_1', 1700000000, '{"a":1}');
  assert.equal(verifySignature(key, 'evt_1', '1700000000', Buffer.from('{"a":1}'), header), true);
  assert.equal(verifySignature(key, 'evt_2', '1700000000', Buffer.from('{"a":1}'), header), false);
  assert.equal(verifySignature(key, 'evt_1', '1700000001', Buffer.from('{"a":1}'), header), false);
  assert.equal(verifySignature(key, 'evt_1', '1700000000', Buffer.from('{"a":2}'), header), false);
  assert.equal(verifySignature(decodeSecret(newSecret()), 'evt_1', '1700000000', Buffer.from('{"a":1}'), header), false);
});

test('secrets must be whsec_ plus base64 of 24 to 64 bytes', () => {
  assert.equal(decodeSecret(newSecret(24)).length, 24);
  assert.equal(decodeSecret(newSecret(64)).length, 64);
  assert.throws(() => decodeSecret(newSecret(23)));
  assert.throws(() => decodeSecret(newSecret(65)));
  assert.throws(() => decodeSecret(randomBytes(32).toString('base64')), /whsec_/);
  assert.throws(() => decodeSecret('whsec_not*base64!'));
  assert.throws(() => decodeSecret('whsec_'));
});
