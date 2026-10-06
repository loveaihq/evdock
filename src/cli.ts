#!/usr/bin/env node
// evdock command line. `serve` runs the receiver, the refresh loop and the relay fetch loop;
// `relay serve` runs a relay on this host; the other commands manage servers, subscriptions
// and the relay setting in the same database.

import { parseArgs } from 'node:util';
import { startDaemon } from './daemon.js';
import { describeError, listEvents } from './events-api.js';
import { Inbox } from './inbox.js';
import { liveOn, relayFromInbox } from './relay-client.js';
import { startRelayServer } from './relay/node.js';
import { DEFAULT_MAX_PER_HOUR, DEFAULT_WINDOW_MS } from './actions.js';
import { printable } from './text.js';
import { clientFromEnv, connect, label, subscribe, unsubscribe, type Context } from './subscriptions.js';

const USAGE = `usage:
  evdock serve         [--host 127.0.0.1] [--port 8787]
  evdock server add    <name> --url <mcp-endpoint> --token-env <ENV_VAR>
  evdock events        <server>
  evdock subscribe     <server> <event> [--args <json>] [--callback-base <url>]
  evdock unsubscribe   <subscription-id>
  evdock subscriptions
  evdock relay use     <relay-url> --key-env <ENV_VAR>
  evdock relay clear
  evdock relay serve   --key-env <ENV_VAR> [--host 127.0.0.1] [--port 8788]
  evdock action set    <subscription-id> [--max-per-hour 6] [--window 10] -- <command> [args...]
  evdock action clear  <subscription-id>
  evdock actions
All commands take --db <file> (default evdock.db; relay.db for relay serve). Tokens and the
relay key are read from the environment variables named with --token-env / --key-env; they
are never stored.
subscribe sends callbacks to the relay if one is set (evdock relay use), otherwise to
--callback-base (default http://127.0.0.1:8787, which needs \`evdock serve\` running).`;

const OPTIONS = {
  db: { type: 'string' },
  host: { type: 'string', default: '127.0.0.1' },
  port: { type: 'string' },
  url: { type: 'string' },
  'token-env': { type: 'string' },
  'key-env': { type: 'string' },
  args: { type: 'string', default: '{}' },
  'callback-base': { type: 'string' },
  'max-per-hour': { type: 'string' },
  window: { type: 'string' },
} as const;

class UsageError extends Error {}

/** Opens the database; `withRelay` also loads the relay (and so needs its key in the environment). */
function context(dbPath: string, withRelay: boolean): Context {
  const inbox = new Inbox(dbPath);
  try {
    const relay = withRelay ? relayFromInbox(inbox) : undefined;
    return { inbox, client: clientFromEnv, now: Date.now, log: (line) => console.log(line), relay };
  } catch (err) {
    inbox.close();
    throw err;
  }
}

/** Refuses to move the relay setting away from subscriptions that still receive through it. */
function assertNoneOn(inbox: Inbox, action: string): void {
  const current = inbox.getRelay();
  if (!current) return;
  const live = liveOn(inbox, current.url);
  if (live.length === 0) return;
  inbox.close();
  throw new Error(
    `${live.length} subscription(s) still receive through ${current.url}: ${live.map(label).join(', ')}. ` +
      `${action} would leave them delivering to a relay nobody fetches from. Unsubscribe them first.`,
  );
}

function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError('--args must be a JSON object');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new UsageError('--args must be a JSON object');
  return value as Record<string, unknown>;
}

async function main(argv: string[]): Promise<void> {
  // Everything after `--` is an action's command line, taken verbatim (never parsed as options).
  const dashDash = argv.indexOf('--');
  const commandLine = dashDash === -1 ? [] : argv.slice(dashDash + 1);
  const { values: given, positionals } = parseArgs({
    args: dashDash === -1 ? argv : argv.slice(0, dashDash),
    options: OPTIONS,
    allowPositionals: true,
  });
  const [command, ...rest] = positionals;
  const actionSet = command === 'action' && rest[0] === 'set';
  if (dashDash !== -1 && !actionSet) throw new UsageError('`--` is only used by `action set`');
  const relayServe = command === 'relay' && rest[0] === 'serve';
  const values = { ...given, db: given.db ?? (relayServe ? 'relay.db' : 'evdock.db') };

  if (relayServe) {
    const keyEnv = values['key-env'];
    if (!keyEnv) throw new UsageError('relay serve needs --key-env');
    const key = process.env[keyEnv];
    if (!key) throw new Error(`environment variable ${keyEnv} (relay key) is not set`);
    const relay = await startRelayServer({
      dbPath: values.db,
      key,
      host: values.host,
      port: Number(values.port ?? 8788),
      log: (line) => console.log(line),
    });
    console.log(`evdock relay on ${relay.url} (plain HTTP: put TLS in front of it)`);
    const shutdown = () => void relay.close().then(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  if (command === 'relay' && rest[0] === 'use' && rest[1]) {
    const keyEnv = values['key-env'];
    if (!keyEnv) throw new UsageError('relay use needs --key-env');
    const url = rest[1].replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) throw new UsageError('relay url must start with https:// (or http:// for local testing)');
    if (url.startsWith('http://') && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(url)) {
      console.log('warning: plain http to a remote relay sends the relay key and events unencrypted');
    }
    const inbox = new Inbox(values.db);
    if (inbox.getRelay()?.url !== url) assertNoneOn(inbox, 'Switching relays');
    inbox.setRelay({ url, keyEnv });
    inbox.close();
    console.log(`relay ${url} (key from $${keyEnv}); new subscriptions will use it`);
    return;
  }

  if (command === 'relay' && rest[0] === 'clear') {
    const inbox = new Inbox(values.db);
    assertNoneOn(inbox, 'Clearing the relay');
    inbox.setRelay(undefined);
    inbox.close();
    console.log('relay cleared; new subscriptions will call back to --callback-base');
    return;
  }

  if (command === 'serve') {
    const daemon = await startDaemon({
      dbPath: values.db,
      host: values.host,
      port: Number(values.port ?? 8787),
      log: (line) => console.log(line),
    });
    console.log(`evdock receiving on ${daemon.url}/hooks/<token>`);
    const shutdown = () => void daemon.stop().then(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  if (command === 'server' && rest[0] === 'add' && rest[1]) {
    if (!values.url || !values['token-env']) throw new UsageError('server add needs --url and --token-env');
    const inbox = new Inbox(values.db);
    inbox.addServer({ name: rest[1], url: values.url, tokenEnv: values['token-env'] });
    inbox.close();
    console.log(`server ${rest[1]}: ${values.url} (token from $${values['token-env']})`);
    return;
  }

  if (command === 'events' && rest[0]) {
    const ctx = context(values.db, false);
    try {
      const events = await listEvents(await connect(ctx, rest[0]));
      for (const e of events) {
        const usable = e.delivery.includes('webhook') ? '' : '  (no webhook delivery: not usable by evdock)';
        // Names and descriptions come from the server: printed through printable().
        const modes = e.delivery.map((d) => printable(d, 20)).join(', ');
        const description = e.description ? `\n    ${printable(e.description, 300)}` : '';
        console.log(`${printable(e.name, 100)}  [${modes}]${usable}${description}`);
      }
    } finally {
      ctx.inbox.close();
    }
    return;
  }

  if (command === 'subscribe' && rest[0] && rest[1]) {
    const ctx = context(values.db, true);
    try {
      const sub = await subscribe(ctx, {
        server: rest[0],
        eventName: rest[1],
        arguments: parseJsonObject(values.args),
        // The relay if one is set, unless a callback base is given explicitly.
        callbackBase: values['callback-base'] ?? (ctx.relay ? undefined : 'http://127.0.0.1:8787'),
      });
      const until = sub.refreshBefore === null ? 'no expiry' : new Date(sub.refreshBefore).toISOString();
      console.log(`subscribed ${label(sub)} to ${sub.eventName} on ${sub.server}, refresh before ${until}`);
    } finally {
      ctx.inbox.close();
    }
    return;
  }

  if (command === 'unsubscribe' && rest[0]) {
    const ctx = context(values.db, true);
    try {
      const sub = ctx.inbox.findSubscription(rest[0]);
      if (!sub) throw new UsageError(`no subscription ${rest[0]}`);
      await unsubscribe(ctx, sub);
      console.log(`unsubscribed ${label(sub)}`);
    } finally {
      ctx.inbox.close();
    }
    return;
  }

  if (actionSet && rest[1]) {
    if (rest.length > 2) throw new UsageError(`unexpected ${JSON.stringify(rest.slice(2).join(' '))}: the command goes after --`);
    if (commandLine.length === 0 || !commandLine[0]) throw new UsageError('action set needs a command after --');
    const maxPerHourText = values['max-per-hour'] ?? String(DEFAULT_MAX_PER_HOUR);
    const windowText = values.window ?? String(DEFAULT_WINDOW_MS / 1000);
    if (!/^[0-9]+$/.test(maxPerHourText) || Number(maxPerHourText) < 1) {
      throw new UsageError('--max-per-hour must be a whole number, 1 or more');
    }
    if (!/^[0-9]+(\.[0-9]+)?$/.test(windowText)) throw new UsageError('--window must be a number of seconds, 0 or more');
    const maxPerHour = Number(maxPerHourText);
    const windowSeconds = Number(windowText);
    const inbox = new Inbox(values.db);
    try {
      const sub = inbox.findSubscription(rest[1]);
      if (!sub) throw new UsageError(`no subscription ${rest[1]}`);
      inbox.setAction(sub.token, commandLine, maxPerHour, Math.round(windowSeconds * 1000));
      console.log(
        `action for ${label(sub)}: ${JSON.stringify(commandLine)} (at most ${maxPerHour}/hour, ${windowSeconds} s window); ` +
          'runs for messages arriving from now on, while `evdock serve` is running',
      );
    } finally {
      inbox.close();
    }
    return;
  }

  if (command === 'action' && rest[0] === 'clear' && rest[1]) {
    const inbox = new Inbox(values.db);
    try {
      const sub = inbox.findSubscription(rest[1]);
      if (!sub) throw new UsageError(`no subscription ${rest[1]}`);
      console.log(inbox.clearAction(sub.token) ? `action for ${label(sub)} removed` : `${label(sub)} has no action`);
    } finally {
      inbox.close();
    }
    return;
  }

  if (command === 'actions') {
    const inbox = new Inbox(values.db);
    try {
      for (const action of inbox.listActions()) {
        const sub = inbox.getSubscription(action.token);
        const waiting = inbox.pendingAfter(action.token, action.doneSeq).count;
        console.log(
          [
            sub ? label(sub) : `${action.token.slice(0, 6)}…`,
            JSON.stringify(action.argv),
            `${action.maxPerHour}/hour`,
            `window ${action.windowMs / 1000} s`,
            `waiting ${waiting}`,
            action.failures > 0 ? `failed ${action.failures}x, next try ${new Date(action.retryAt).toISOString()}` : '',
          ]
            .filter(Boolean)
            .join('  '),
        );
      }
    } finally {
      inbox.close();
    }
    return;
  }

  if (command === 'subscriptions') {
    const inbox = new Inbox(values.db);
    try {
      for (const sub of inbox.listSubscriptions()) {
        const cursor = inbox.cursor(sub.token);
        const until = sub.refreshBefore === null ? '-' : new Date(sub.refreshBefore).toISOString();
        console.log(
          [
            label(sub),
            sub.status,
            `${sub.server ?? '-'}/${sub.eventName ?? '-'}`,
            sub.arguments ?? '-',
            `refreshBefore=${until}`,
            `cursor=${cursor?.cursor ?? '-'}`,
            cursor?.possibleGap ? 'POSSIBLE GAP' : '',
            sub.lastError ? `lastError=${printable(sub.lastError)}` : '',
          ]
            .filter(Boolean)
            .join('  '),
        );
      }
    } finally {
      inbox.close();
    }
    return;
  }

  throw new UsageError('');
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(err.message ? `${err.message}\n\n${USAGE}` : USAGE);
    process.exitCode = 2;
  } else {
    console.error(`error: ${describeError(err)}`);
    process.exitCode = 1;
  }
});
