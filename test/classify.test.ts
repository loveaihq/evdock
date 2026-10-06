import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, MalformedBody } from '../src/classify.js';

const parse = (value: unknown) => classify(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));

test('a body without type is an event', () => {
  assert.deepEqual(
    parse({ eventId: 'evt_789', name: 'incident.created', timestamp: '2026-02-19T16:00:00Z', data: { a: 1 }, cursor: 'c1' }),
    { kind: 'event', eventId: 'evt_789', name: 'incident.created', timestamp: '2026-02-19T16:00:00Z', cursor: 'c1' },
  );
});

test('an absent cursor is the same as null', () => {
  const absent = parse({ eventId: 'e', name: 'n', timestamp: 't', data: {} });
  const explicit = parse({ eventId: 'e', name: 'n', timestamp: 't', data: {}, cursor: null });
  assert.deepEqual(absent, explicit);
  assert.equal(absent.kind === 'event' && absent.cursor, null);
  assert.deepEqual(parse({ type: 'gap' }), { kind: 'gap', cursor: null });
});

test('_meta and unknown fields on events are allowed', () => {
  assert.equal(parse({ eventId: 'e', name: 'n', timestamp: 't', data: {}, _meta: { x: 1 }, extra: true }).kind, 'event');
});

test('control envelopes: gap, terminated, verification', () => {
  assert.deepEqual(parse({ type: 'gap', cursor: 'fresh' }), { kind: 'gap', cursor: 'fresh' });
  assert.deepEqual(
    parse({ type: 'terminated', error: { code: -32012, message: 'Forbidden', data: { reason: 'Access revoked' } } }),
    { kind: 'terminated', code: -32012, message: 'Forbidden' },
  );
  assert.deepEqual(parse({ type: 'verification', challenge: 'nonce' }), { kind: 'verification', challenge: 'nonce' });
});

test('an unknown type is still a control envelope', () => {
  assert.deepEqual(parse({ type: 'something.new', x: 1 }), { kind: 'unknown_control', type: 'something.new' });
});

test('malformed bodies are rejected', () => {
  const bad: unknown[] = [
    'not json',
    '[1,2]',
    'null',
    { name: 'n', timestamp: 't', data: {} },
    { eventId: '', name: 'n', timestamp: 't', data: {} },
    { eventId: 'e', name: 'n', timestamp: 't' },
    { eventId: 'e', name: 'n', timestamp: 't', data: [] },
    { eventId: 'e', name: 'n', timestamp: 't', data: {}, cursor: 5 },
    { type: 7 },
    { type: null },
    { type: 'gap', cursor: {} },
    { type: 'terminated' },
    { type: 'terminated', error: { code: 'x', message: 'm' } },
    { type: 'verification' },
  ];
  for (const body of bad) assert.throws(() => parse(body), MalformedBody, JSON.stringify(body));
  assert.throws(() => classify(Buffer.from([0x7b, 0xff, 0x7d])), MalformedBody, 'invalid UTF-8');
});
