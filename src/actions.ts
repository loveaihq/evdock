// The action executor (docs/M4-TASK.md, 设计决定 2): when messages arrive for a subscription
// that has an action, run its command once per batch, with the batch as JSON on stdin.
//
// Event content is untrusted (DESIGN.md). The command line is fixed at configuration time and
// run without a shell; event content only ever reaches the command through stdin.

import { spawn, type ChildProcess } from 'node:child_process';
import { win32 } from 'node:path';
import type { Action, Inbox, MessageRow } from './inbox.js';
import { printable } from './text.js';

export const DEFAULT_MAX_PER_HOUR = 6;
export const DEFAULT_WINDOW_MS = 10_000;
/** Messages handed over in one run at most; the rest go in the next. */
const MAX_BATCH = 100;
const HOUR_MS = 60 * 60 * 1000;

export interface ActionRunnerOptions {
  now?: () => number;
  log?: (line: string) => void;
  /** How often to look for actions that are due. */
  tickMs?: number;
  /** A run taking longer than this is ended and counts as failed. */
  timeoutMs?: number;
  /** Waits before each retry of a failed batch; once they are used up the batch is skipped. */
  retryDelaysMs?: number[];
  /** POSIX: a command still running this long after SIGTERM gets SIGKILL. */
  killGraceMs?: number;
}

export interface ActionRunner {
  /** Stops scheduling and ends running commands; their batches run again on the next start. */
  stop(): Promise<void>;
}

function label(inbox: Inbox, token: string): string {
  try {
    // The subscription id comes from the server.
    const id = inbox.getSubscription(token)?.subscriptionId;
    return id ? printable(id, 100) : `${token.slice(0, 6)}…`;
  } catch {
    return `${token.slice(0, 6)}…`; // the inbox is already closed (stopping)
  }
}

function parseBody(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null; // cannot happen for stored messages: they were parsed on arrival
  }
}

/** What the command reads on stdin. Everything in `messages[].body` comes from the sender: untrusted. */
export function batchPayload(inbox: Inbox, token: string, messages: MessageRow[]): string {
  const sub = inbox.getSubscription(token);
  return JSON.stringify({
    subscription: sub
      ? {
          id: sub.subscriptionId,
          server: sub.server,
          event: sub.eventName,
          arguments: sub.arguments === null ? null : (JSON.parse(sub.arguments) as unknown),
          status: sub.status,
        }
      : null,
    messages: messages.map((m) => ({
      kind: m.kind,
      seq: m.seq,
      webhookId: m.webhookId,
      eventId: m.eventId,
      receivedAt: new Date(m.receivedAt).toISOString(),
      body: parseBody(m.body),
    })),
  });
}

interface RunResult {
  code: number | null;
  error?: string;
  timedOut: boolean;
}

/** evdock's environment without the variables that hold server tokens or the relay key. */
function childEnv(secretNames: string[]): NodeJS.ProcessEnv {
  const fold = (name: string) => (process.platform === 'win32' ? name.toUpperCase() : name); // Windows ignores case
  const hidden = new Set(secretNames.map(fold));
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !hidden.has(fold(name))));
}

/**
 * Ends the command and everything it started. On Windows a `cmd.exe /c` wrapper would otherwise
 * leave the real agent running; on POSIX the command runs as its own process group.
 */
function endTree(child: ChildProcess, graceMs: number): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // /T: the whole tree. /F: console programs get no gentler signal that works reliably.
    // By full path: a bare name would be looked up in the current directory first.
    const taskkill = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      .once('error', () => child.kill())
      .once('exit', (code) => {
        if (code !== 0) child.kill(); // at least the command itself, so the run ends
      });
    return;
  }
  signalGroup(pid, 'SIGTERM');
  setTimeout(() => signalGroup(pid, 'SIGKILL'), graceMs).unref();
}

/** POSIX: signals the process group the command leads. */
function signalGroup(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(-pid, name);
  } catch {
    // Already gone.
  }
}

function run(
  argv: string[],
  input: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  graceMs: number,
  started: (child: ChildProcess) => void,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      // shell: false is the point: argv[0] is executed directly, nothing is interpreted.
      child = spawn(argv[0]!, argv.slice(1), {
        shell: false,
        stdio: ['pipe', 'inherit', 'inherit'],
        env,
        windowsHide: true,
        // POSIX: its own process group, so ending it ends what it started too.
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      return resolve({ code: null, error: (err as Error).message, timedOut: false });
    }
    started(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      endTree(child, graceMs);
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, error: err.message, timedOut });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut });
    });
    // The command may exit without reading stdin; that is its business.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export function startActionRunner(inbox: Inbox, options: ActionRunnerOptions = {}): ActionRunner {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const retryDelays = options.retryDelaysMs ?? [60_000, 5 * 60_000, 15 * 60_000];
  const graceMs = options.killGraceMs ?? 5000;
  /** How long stop() waits for ended commands to exit before giving up on them. */
  const stopWaitMs = graceMs + 2000;
  const running = new Map<string, { child?: ChildProcess; done: Promise<void> }>();
  let stopped = false;

  /** Whether this action has a batch to run now: something pending, window passed, under the hourly limit. */
  function due(action: Action, at: number): boolean {
    if (action.retryAt > at) return false;
    const pending = inbox.pendingAfter(action.token, action.doneSeq);
    if (pending.count === 0 || pending.oldestReceivedAt === null) return false;
    // Coalescing: wait the window out from the first message of the batch, so a burst wakes the agent once.
    if (at < pending.oldestReceivedAt + action.windowMs) return false;
    // Over the hourly limit: nothing is dropped, the batch just waits and grows.
    return inbox.countActionRuns(action.token, at - HOUR_MS) < action.maxPerHour;
  }

  async function execute(action: Action, batch: MessageRow[]): Promise<void> {
    const name = label(inbox, action.token);
    const startedAt = now();
    inbox.recordActionRun(action.token, startedAt, startedAt - HOUR_MS);
    log(`action ${name}: running ${action.argv[0]} with ${batch.length} message(s)`);
    const entry = running.get(action.token)!;
    const input = batchPayload(inbox, action.token, batch);
    const result = await run(action.argv, input, childEnv(inbox.secretEnvNames()), timeoutMs, graceMs, (child) => {
      entry.child = child;
    });
    // Ended by stop(): leave the batch as it is, so it runs again next time (at least once).
    if (stopped) return;

    const lastSeq = batch.at(-1)!.seq;
    if (result.code === 0 && !result.timedOut) {
      inbox.finishActionBatch(action.token, lastSeq);
      log(`action ${name}: done in ${now() - startedAt} ms`);
      return;
    }
    const why = result.timedOut
      ? `timed out after ${timeoutMs} ms`
      : result.error !== undefined
        ? `could not run: ${result.error}`
        : `exit code ${String(result.code)} after ${now() - startedAt} ms`;
    const failures = action.failures + 1;
    if (failures > retryDelays.length) {
      // Give up on this batch rather than block every later message behind it.
      inbox.finishActionBatch(action.token, lastSeq);
      log(`WARNING action ${name}: ${why}; skipped ${batch.length} message(s) after ${failures} attempts`);
      return;
    }
    const delay = retryDelays[failures - 1]!;
    inbox.failActionBatch(action.token, failures, now() + delay);
    log(`action ${name}: ${why}; retrying in ${Math.round(delay / 1000)} s`);
  }

  function tick(): void {
    const at = now();
    for (const action of inbox.listActions()) {
      if (running.has(action.token) || !due(action, at)) continue;
      const batch = inbox.messagesAfter(action.token, action.doneSeq, MAX_BATCH);
      if (batch.length === 0) continue;
      const entry: { child?: ChildProcess; done: Promise<void> } = { done: Promise.resolve() };
      running.set(action.token, entry);
      entry.done = execute(action, batch)
        .catch((err: unknown) => log(`action ${label(inbox, action.token)}: ${(err as Error).message}`))
        .finally(() => running.delete(action.token));
    }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    try {
      tick();
    } catch (err) {
      log(`actions: ${(err as Error).message}`);
    }
  }, options.tickMs ?? 1000);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      const children = [...running.values()].flatMap((r) => (r.child ? [r.child] : []));
      for (const child of children) endTree(child, graceMs);
      let wait: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((resolve) => {
        wait = setTimeout(() => resolve('late'), stopWaitMs);
      });
      const ended = Promise.allSettled([...running.values()].map((r) => r.done));
      if ((await Promise.race([ended, late])) === 'late') {
        log(`WARNING actions: ${running.size} command(s) still running after ${stopWaitMs} ms; not waiting for them`);
      }
      clearTimeout(wait);
      // POSIX: what a command started can outlive it, and the SIGKILL timer would die with evdock.
      if (process.platform !== 'win32') for (const { pid } of children) if (pid !== undefined) signalGroup(pid, 'SIGKILL');
    },
  };
}
