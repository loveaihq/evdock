import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFresh, parseTimestamp, TOLERANCE_SECONDS } from '../src/timestamp.js';

test('tolerance is 5 minutes', () => {
  assert.equal(TOLERANCE_SECONDS, 300);
});

test('rejects timestamps more than 5 minutes from the receive time, in either direction', () => {
  const received = 1_700_000_000_000;
  const t = 1_700_000_000;
  assert.equal(isFresh(t, received), true);
  assert.equal(isFresh(t - 300, received), true);
  assert.equal(isFresh(t - 301, received), false);
  assert.equal(isFresh(t + 300, received), true);
  assert.equal(isFresh(t + 301, received), false);
});

test('compares against the receive time passed in, not the current clock', () => {
  const longAgo = Date.UTC(2020, 0, 1);
  const ts = Math.floor(longAgo / 1000) - 60;
  assert.equal(isFresh(ts, longAgo), true);
  assert.equal(isFresh(ts, Date.now()), false);
});

test('receive time is truncated to whole seconds', () => {
  assert.equal(isFresh(1_700_000_000 - 300, 1_700_000_000_999), true);
});

test('webhook-timestamp must be integer seconds', () => {
  assert.equal(parseTimestamp('1739980800'), 1739980800);
  for (const bad of ['', ' 1739980800', '1739980800.5', '-1', '1e9', '0x10', '2026-02-19T16:00:00Z']) {
    assert.equal(parseTimestamp(bad), null, bad);
  }
});
