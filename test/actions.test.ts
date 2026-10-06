import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startActionRunner, type ActionRunner, type ActionRunnerOptions } from '../src/actions.js';
import type { StoredMessage } from '../src/inbox.js';
import { Inbox } from '../src/inbox.js';
import { newSecret, tempDir } from './helpers.js';

const STUB = fileURLToPath(new URL('../../test/fixtures/agent-stub.mjs', import.meta.url));
const TOKEN = 'tok_actions_00000000001';

async function until(what: string, condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
type Mode = 'ok' | 'fail' | 'hang' | 'hang-tree' | 'trap';
interface Run {
  argv: string[];
  stdin: { subscription: Record<string, unknown>; messages: Array<Record<string, unknown>> };
  pid: number;
  childPid?: number;
  env: string[];
}

function setup(t: { after: (fn: () => Promise<void> | void) => void }) {
  const { dir, cleanup } = tempDir();
  const inbox = new Inbox(join(dir, 'evdock.db'));
  inbox.addSubscription({ token: TOKEN, secret: newSecret(), server: 'mock', eventName: 'incident.created', arguments: '{"severity":"P1"}', callbackUrl: 'u' });
  inbox.confirmSubscription(TOKEN, 'sub_actions');
  const record = join(dir, 'runs.jsonl');
  let clock = Date.UTC(2026, 9, 6, 12, 0, 0);
  const logs: string[] = [];
  const runners: ActionRunner[] = [];
  t.after(async () => {
    for (const r of runners) await r.stop();
    inbox.close();
    cleanup();
  });
  let seq = 0;
  return {
    inbox,
    logs,
    record,
    now: () => clock,
    advance: (ms: number) => void (clock += ms),
    /** Stores a message as if just received (at the current clock). */
    put(message: StoredMessage | Record<string, unknown>, body?: unknown) {
      seq++;
      const m: StoredMessage =
        'kind' in message
          ? (message as StoredMessage)
          : { kind: 'event', eventId: `evt_${seq}`, name: 'incident.created', timestamp: 't', cursor: null };
      const payload = body ?? { eventId: `evt_${seq}`, name: 'incident.created', timestamp: 't', data: message };
      inbox.store({ token: TOKEN, subscriptionId: 'sub_actions', webhookId: `wh_${seq}`, message: m, body: Buffer.from(JSON.stringify(payload)), receivedAtMs: clock });
    },
    action(mode: Mode, { maxPerHour = 6, windowMs = 0, extra = [] as string[] } = {}) {
      inbox.setAction(TOKEN, [process.execPath, STUB, record, mode, ...extra], maxPerHour, windowMs);
    },
    /**
     * A command whose work runs in a grandchild of evdock. On Windows that is README's recipe,
     * cmd.exe /c in front of the agent (Node's own children die with it anyway, cmd's do not);
     * elsewhere the stub starts a child of its own.
     */
    treeAction() {
      if (process.platform === 'win32') inbox.setAction(TOKEN, ['cmd.exe', '/d', '/s', '/c', 'node', STUB, record, 'hang'], 6, 0);
      else inbox.setAction(TOKEN, [process.execPath, STUB, record, 'hang-tree'], 6, 0);
    },
    start(options: ActionRunnerOptions = {}) {
      const runner = startActionRunner(inbox, { now: () => clock, log: (l) => logs.push(l), tickMs: 20, ...options });
      runners.push(runner);
      return runner;
    },
    runs(): Run[] {
      return existsSync(record)
        ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [];
    },
  };
}

test('one run per window: a burst within the window wakes the command once', async (t) => {
  const s = setup(t);
  s.action('ok', { windowMs: 5000 });
  s.put({ n: 1 });
  s.put({ n: 2 });
  s.advance(1000);
  s.put({ n: 3 });
  s.start();
  await sleep(200);
  assert.equal(s.runs().length, 0, 'still inside the window');
  s.advance(4000); // 5 s after the first message
  await until('one run', () => s.runs().length === 1);
  await until('marked done', () => s.inbox.listActions()[0]!.doneSeq === 3);
  assert.deepEqual(
    s.runs()[0]!.stdin.messages.map((m) => (m.body as { data: { n: number } }).data.n),
    [1, 2, 3],
  );
});

test('a new action reacts to what arrives from now on, not to history', async (t) => {
  const s = setup(t);
  s.put({ n: 1 });
  s.action('ok');
  s.start();
  await sleep(200);
  assert.equal(s.runs().length, 0);
  s.put({ n: 2 });
  await until('one run', () => s.runs().length === 1);
  assert.equal(s.runs()[0]!.stdin.messages.length, 1);
});

test('hourly limit: nothing is dropped, the batch waits and grows', async (t) => {
  const s = setup(t);
  s.action('ok', { maxPerHour: 1 });
  s.start();
  s.put({ n: 1 });
  await until('first run', () => s.runs().length === 1);
  s.put({ n: 2 });
  s.put({ n: 3 });
  await sleep(300);
  assert.equal(s.runs().length, 1, 'over the limit: waits');
  s.advance(60 * 60 * 1000);
  await until('second run', () => s.runs().length === 2);
  assert.equal(s.runs()[1]!.stdin.messages.length, 2);
});

test('failures: retried after each delay, then the batch is skipped with a warning', async (t) => {
  const s = setup(t);
  s.action('fail');
  s.start({ retryDelaysMs: [1000, 5000, 15000] });
  s.put({ n: 1 });
  await until('first attempt', () => s.runs().length === 1);
  await until('failure recorded', () => s.inbox.listActions()[0]!.failures === 1);
  for (const [i, delay] of [1000, 5000, 15000].entries()) {
    await sleep(100);
    assert.equal(s.runs().length, i + 1, 'not before the delay');
    s.advance(delay);
    await until(`attempt ${i + 2}`, () => s.runs().length === i + 2);
  }
  await until('skipped', () => s.inbox.listActions()[0]!.doneSeq === 1);
  assert.equal(s.inbox.listActions()[0]!.failures, 0);
  assert.ok(s.logs.some((l) => l.startsWith('WARNING') && l.includes('exit code 3') && l.includes('skipped 1 message(s) after 4 attempts')));
});

test('a command that hangs past the timeout is ended and counts as a failure', async (t) => {
  const s = setup(t);
  s.action('hang');
  s.start({ timeoutMs: 300 });
  s.put({ n: 1 });
  await until('failure recorded', () => s.inbox.listActions()[0]!.failures === 1, 5000);
  assert.ok(s.logs.some((l) => l.includes('timed out after 300 ms')));
});

test('a timeout ends the processes the command started too', async (t) => {
  const s = setup(t);
  s.treeAction();
  s.start({ timeoutMs: 300 });
  s.put({ n: 1 });
  await until('failure recorded', () => s.inbox.listActions()[0]!.failures === 1, 5000);
  const { pid, childPid } = s.runs()[0]!;
  await until('everything it started is gone', () => !alive(pid) && !(childPid && alive(childPid)), 5000);
});

test('POSIX: a command that ignores SIGTERM is killed after the grace period', { skip: process.platform === 'win32' && 'POSIX only' }, async (t) => {
  const s = setup(t);
  s.action('trap');
  s.start({ timeoutMs: 300, killGraceMs: 300 });
  s.put({ n: 1 });
  await until('failure recorded', () => s.inbox.listActions()[0]!.failures === 1, 5000);
  assert.ok(!alive(s.runs()[0]!.pid));
});

test('POSIX: stopping does not hang on a command that ignores SIGTERM', { skip: process.platform === 'win32' && 'POSIX only' }, async (t) => {
  const s = setup(t);
  s.action('trap');
  const runner = s.start({ killGraceMs: 300 });
  s.put({ n: 1 });
  await until('started', () => s.runs().length === 1);
  const started = Date.now();
  await runner.stop();
  assert.ok(Date.now() - started < 3000, 'stop() returned');
  await until('gone', () => !alive(s.runs()[0]!.pid), 3000);
});

test('stopping ends the processes the command started too', async (t) => {
  const s = setup(t);
  s.treeAction();
  const runner = s.start();
  s.put({ n: 1 });
  await until('started', () => s.runs().length === 1);
  await runner.stop();
  const { pid, childPid } = s.runs()[0]!;
  await until('everything it started is gone', () => !alive(pid) && !(childPid && alive(childPid)), 5000);
});

test('the command does not see server tokens or the relay key', async (t) => {
  const s = setup(t);
  const names = ['EVDOCK_TEST_SERVER_TOKEN', 'EVDOCK_TEST_RELAY_KEY', 'EVDOCK_TEST_OTHER'];
  for (const name of names) process.env[name] = 'value';
  t.after(() => {
    for (const name of names) delete process.env[name];
  });
  s.inbox.addServer({ name: 'gh', url: 'https://mcp.example.invalid/mcp', tokenEnv: 'EVDOCK_TEST_SERVER_TOKEN' });
  // Windows variable names ignore case, so a differently cased setting still names the same variable.
  s.inbox.setRelay({ url: 'https://relay.example.invalid', keyEnv: process.platform === 'win32' ? 'evdock_test_relay_key' : 'EVDOCK_TEST_RELAY_KEY' });
  s.action('ok');
  s.start();
  s.put({ n: 1 });
  await until('one run', () => s.runs().length === 1);
  const env = s.runs()[0]!.env.map((n) => n.toUpperCase());
  assert.ok(!env.includes('EVDOCK_TEST_SERVER_TOKEN'), 'server token hidden');
  assert.ok(!env.includes('EVDOCK_TEST_RELAY_KEY'), 'relay key hidden');
  assert.ok(env.includes('EVDOCK_TEST_OTHER'), 'the rest of the environment is passed on');
});

test('a new command line starts retries afresh; the same command line keeps its back-off', async (t) => {
  const s = setup(t);
  s.action('fail');
  s.start({ retryDelaysMs: [60_000] });
  s.put({ n: 1 });
  await until('failure recorded', () => s.inbox.listActions()[0]!.failures === 1);
  s.action('fail', { maxPerHour: 3 });
  assert.equal(s.inbox.listActions()[0]!.failures, 1, 'same command: still backing off');
  assert.ok(s.inbox.listActions()[0]!.retryAt > 0);
  s.action('ok');
  assert.deepEqual([s.inbox.listActions()[0]!.failures, s.inbox.listActions()[0]!.retryAt], [0, 0]);
  await until('runs again without waiting out the back-off', () => s.runs().length === 2);
  await until('done', () => s.inbox.listActions()[0]!.doneSeq === 1);
});

test('stopping ends a running command; its batch runs again on the next start (at least once)', async (t) => {
  const s = setup(t);
  s.action('hang');
  const first = s.start();
  s.put({ n: 1 });
  await until('started', () => s.runs().length === 1);
  await first.stop();
  assert.equal(s.inbox.listActions()[0]!.doneSeq, 0, 'not marked done');
  s.action('ok'); // same subscription, keeps its progress
  s.start();
  await until('ran again', () => s.runs().length === 2);
  assert.equal(s.runs()[1]!.stdin.messages[0]!.eventId, s.runs()[0]!.stdin.messages[0]!.eventId);
});

test('no shell: the command line is exactly as configured; event content only on stdin', async (t) => {
  const s = setup(t);
  const nasty = '$(whoami) `id` "; rm -rf / && echo pwned & del /q C:\\ | calc';
  s.action('ok', { extra: ['--literal=a b', '%PATH%', '$HOME'] });
  s.start();
  s.put({ title: nasty });
  await until('one run', () => s.runs().length === 1);
  const run = s.runs()[0]!;
  assert.deepEqual(run.argv, [s.record, 'ok', '--literal=a b', '%PATH%', '$HOME']);
  assert.equal((run.stdin.messages[0]!.body as { data: { title: string } }).data.title, nasty);
});

test('stdin: subscription and messages, control envelopes included with their kind', async (t) => {
  const s = setup(t);
  s.action('ok');
  s.put({ n: 1 });
  s.put({ kind: 'gap', cursor: 'c9' }, { type: 'gap', cursor: 'c9' });
  s.put({ kind: 'terminated', code: -32024, message: 'Forbidden' }, { type: 'terminated', error: { code: -32024, message: 'Forbidden' } });
  s.start();
  await until('one run', () => s.runs().length === 1);
  const { subscription, messages } = s.runs()[0]!.stdin;
  assert.deepEqual(subscription, {
    id: 'sub_actions',
    server: 'mock',
    event: 'incident.created',
    arguments: { severity: 'P1' },
    status: 'terminated',
  });
  assert.deepEqual(
    messages.map((m) => m.kind),
    ['event', 'gap', 'terminated'],
  );
  assert.deepEqual(Object.keys(messages[0]!).sort(), ['body', 'eventId', 'kind', 'receivedAt', 'seq', 'webhookId']);
  assert.deepEqual(messages[1]!.body, { type: 'gap', cursor: 'c9' });
});

test('a command that cannot be started counts as a failure', async (t) => {
  const s = setup(t);
  s.inbox.setAction(TOKEN, ['definitely-not-a-command-evdock'], 6, 0);
  s.start();
  s.put({ n: 1 });
  await until('failure recorded', () => s.inbox.listActions()[0]!.failures === 1);
  assert.ok(s.logs.some((l) => l.includes('could not run')));
});

test('end to end: an event from the server wakes the command through evdock serve', async (t) => {
  const { startMockServer } = await import('../src/conformance/mock-server.js');
  const { startDaemon } = await import('../src/daemon.js');
  const { McpClient } = await import('../src/mcp-client.js');
  const { subscribe } = await import('../src/subscriptions.js');
  const { dir, cleanup } = tempDir();
  const mock = await startMockServer({
    token: 'demo',
    eventTypes: [{ name: 'incident.created', description: 'x', inputSchema: { type: 'object' }, payloadSchema: { type: 'object' }, replay: true }],
    defaultTtlMs: 60_000,
    retry: { attempts: 3, baseDelayMs: 50 },
    allowInsecureCallbacks: true,
  });
  const client = (server: { url: string }) => new McpClient({ url: server.url, token: 'demo' });
  const daemon = await startDaemon({ dbPath: join(dir, 'evdock.db'), port: 0, client, actions: { tickMs: 20 } });
  t.after(async () => {
    await daemon.stop();
    await mock.close();
    cleanup();
  });
  daemon.inbox.addServer({ name: 'mock', url: mock.url, tokenEnv: 'UNUSED' });
  const sub = await subscribe(
    { inbox: daemon.inbox, client, now: Date.now, log: () => {} },
    { server: 'mock', eventName: 'incident.created', arguments: {}, callbackBase: daemon.url },
  );
  const record = join(dir, 'runs.jsonl');
  daemon.inbox.setAction(sub.token, [process.execPath, STUB, record, 'ok'], 6, 200);
  const sent = mock.emit('incident.created', { title: 'Database down' }).eventId;
  await until('the command ran', () => existsSync(record));
  const run = JSON.parse(readFileSync(record, 'utf8').trim()) as { stdin: { subscription: { id: string }; messages: Array<{ eventId: string; body: { data: { title: string } } }> } };
  assert.equal(run.stdin.subscription.id, sub.subscriptionId);
  assert.equal(run.stdin.messages[0]!.eventId, sent);
  assert.equal(run.stdin.messages[0]!.body.data.title, 'Database down');
});
