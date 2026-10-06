import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Inbox } from '../src/inbox.js';
import { newSecret, tempDir } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const run = promisify(execFile);

async function evdock(...args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, out: e.stdout + e.stderr };
  }
}

test('relay clear / switching relays is refused while subscriptions still receive through the relay', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const db = join(dir, 'evdock.db');
  const inbox = new Inbox(db);
  inbox.setRelay({ url: 'https://relay.example', keyEnv: 'EVDOCK_RELAY_KEY' });
  inbox.addSubscription({ token: 'tok_relay_000000000001', secret: newSecret(), callbackUrl: 'https://relay.example/hooks/tok_relay_000000000001' });
  inbox.confirmSubscription('tok_relay_000000000001', 'sub_on_relay');
  inbox.close();

  let r = await evdock('relay', 'clear', '--db', db);
  assert.equal(r.code, 1);
  assert.match(r.out, /1 subscription\(s\) still receive through https:\/\/relay\.example: sub_on_relay/);

  r = await evdock('relay', 'use', 'https://other.example', '--key-env', 'EVDOCK_RELAY_KEY', '--db', db);
  assert.equal(r.code, 1, 'switching away is refused too');

  r = await evdock('relay', 'use', 'https://relay.example', '--key-env', 'OTHER_VAR', '--db', db);
  assert.equal(r.code, 0, 'same relay, different key variable: fine');

  const reopened = new Inbox(db);
  reopened.setStatus('tok_relay_000000000001', 'unsubscribed');
  reopened.close();
  r = await evdock('relay', 'clear', '--db', db);
  assert.equal(r.code, 0, 'nothing left on it');
});

test('relay use warns about plain http to a remote host', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const db = join(dir, 'evdock.db');
  const remote = await evdock('relay', 'use', 'http://relay.example', '--key-env', 'K', '--db', db);
  assert.match(remote.out, /warning: plain http/);
  const local = await evdock('relay', 'use', 'http://127.0.0.1:8788', '--key-env', 'K', '--db', db);
  assert.doesNotMatch(local.out, /warning/);
});
