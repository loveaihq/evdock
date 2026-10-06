// The action executor (docs/M4-TASK.md, 设计决定 2): when messages arrive for a subscription
// that has an action, run its command once per batch, with the batch as JSON on stdin.
//
// Event content is untrusted (DESIGN.md). The command line is fixed at configuration time and
// run without a shell; event content only ever reaches the command through stdin.

import { spawn, type ChildProcess } from 'node:child_process';
import type { Action, Inbox, MessageRow } from './inbox.js';

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
}

export interface ActionRunner {
  /** Stops scheduling and ends running commands; their batches run again on the next start. */
  stop(): Promise<void>;
}

function label(inbox: Inbox, token: string): string {
  try {
    return inbox.getSubscription(token)?.subscriptionId ?? `${token.slice(0, 6)}…`;
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
    subscription: sub && {
      id: sub.subscriptionId,
      server: sub.server,
      event: sub.eventName,
      arguments: sub.arguments === null ? null : (JSON.parse(sub.arguments) as unknown),
      status: sub.status,
    },
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

function run(argv: string[], input: string, timeoutMs: number, started: (child: ChildProcess) => void): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      // shell: false is the point: argv[0] is executed directly, nothing is interpreted.
      child = spawn(argv[0]!, argv.slice(1), { shell: false, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
    } catch (err) {
      return resolve({ code: null, error: (err as Error).message, timedOut: false });
    }
    started(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
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
  const running = new Map<string, { child?: ChildProcess; done: Promise<void> }>();
  let stopped = false;

  /** Whether this action has a batch to run now: something pending, window passed, under the hourly limit. */
  function due(action: Action, at: number): MessageRow[] | undefined {
    if (action.retryAt > at) return undefined;
    const pending = inbox.messagesAfter(action.token, action.doneSeq, MAX_BATCH);
    if (pending.length === 0) return undefined;
    // Coalescing: wait the window out from the first message of the batch, so a burst wakes the agent once.
    if (at < pending[0]!.receivedAt + action.windowMs) return undefined;
    // Over the hourly limit: nothing is dropped, the batch just waits and grows.
    if (inbox.actionRunsSince(action.token, at - HOUR_MS).length >= action.maxPerHour) return undefined;
    return pending;
  }

  async function execute(action: Action, batch: MessageRow[]): Promise<void> {
    const name = label(inbox, action.token);
    const startedAt = now();
    inbox.recordActionRun(action.token, startedAt);
    log(`action ${name}: running ${action.argv[0]} with ${batch.length} message(s)`);
    const entry = running.get(action.token)!;
    const result = await run(action.argv, batchPayload(inbox, action.token, batch), timeoutMs, (child) => {
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
        : `exit code ${String(result.code)}`;
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

  const timer = setInterval(() => {
    if (stopped) return;
    let actions: Action[];
    try {
      actions = inbox.listActions();
    } catch {
      return;
    }
    const at = now();
    for (const action of actions) {
      if (running.has(action.token)) continue;
      const batch = due(action, at);
      if (!batch) continue;
      const entry: { child?: ChildProcess; done: Promise<void> } = { done: Promise.resolve() };
      running.set(action.token, entry);
      entry.done = execute(action, batch)
        .catch((err: unknown) => log(`action ${label(inbox, action.token)}: ${(err as Error).message}`))
        .finally(() => running.delete(action.token));
    }
  }, options.tickMs ?? 1000);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      for (const { child } of running.values()) child?.kill();
      await Promise.allSettled([...running.values()].map((r) => r.done));
    },
  };
}
