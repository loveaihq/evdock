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
  assert.doesNotMatch(local.out, /warning: plain http/); // Node 22 adds its own SQLite ExperimentalWarning
});

test('action set / actions / action clear', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const db = join(dir, 'evdock.db');
  const inbox = new Inbox(db);
  inbox.addSubscription({ token: 'tok_cli_actions_000001', secret: newSecret() });
  inbox.confirmSubscription('tok_cli_actions_000001', 'sub_cli');
  inbox.close();

  let r = await evdock('action', 'set', 'sub_cli', '--max-per-hour', '2', '--window', '3', '--db', db, '--', 'node', 'agent.mjs', '--flag', '--db');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\["node","agent\.mjs","--flag","--db"\]/, 'everything after -- is the command, even option-like words');
  r = await evdock('actions', '--db', db);
  assert.match(r.out, /sub_cli {2}\["node","agent\.mjs","--flag","--db"\] {2}2\/hour {2}window 3 s {2}waiting 0/);
  r = await evdock('action', 'set', 'sub_cli', '--db', db);
  assert.equal(r.code, 2, 'no command');
  r = await evdock('action', 'set', 'sub_cli', '--max-per-hour', '0', '--db', db, '--', 'x');
  assert.equal(r.code, 2);
  for (const window of ['', '0x10', '1e3', 'ten']) {
    r = await evdock('action', 'set', 'sub_cli', '--window', window, '--db', db, '--', 'x');
    assert.equal(r.code, 2, `--window ${JSON.stringify(window)}`);
  }
  r = await evdock('action', 'set', 'sub_cli', '--max-per-hour', '99999999999999999999', '--db', db, '--', 'x');
  assert.equal(r.code, 2, 'too large for the limit');
  r = await evdock('action', 'set', 'sub_cli', 'extra', 'words', '--db', db, '--', 'x');
  assert.equal(r.code, 2, 'words before -- are not the command');
  assert.match(r.out, /the command goes after --/);
  r = await evdock('serve', '--db', db, '--', 'x');
  assert.equal(r.code, 2, '-- belongs to action set only');
  r = await evdock('actions', '--db', db);
  assert.match(r.out, /\["node","agent\.mjs","--flag","--db"\]/, 'refused commands changed nothing');
  r = await evdock('action', 'clear', 'sub_cli', '--db', db);
  assert.match(r.out, /action for sub_cli removed/);
});
