#!/usr/bin/env node
// evdock command line. `serve` runs the receiver and the refresh loop; the other commands
// manage servers and subscriptions in the same database.

import { parseArgs } from 'node:util';
import { startDaemon } from './daemon.js';
import { describeError, listEvents } from './events-api.js';
import { Inbox } from './inbox.js';
import { clientFromEnv, connect, label, subscribe, unsubscribe, type Context } from './subscriptions.js';

const USAGE = `usage:
  evdock serve         [--host 127.0.0.1] [--port 8787]
  evdock server add    <name> --url <mcp-endpoint> --token-env <ENV_VAR>
  evdock events        <server>
  evdock subscribe     <server> <event> [--args <json>] [--callback-base http://127.0.0.1:8787]
  evdock unsubscribe   <subscription-id>
  evdock subscriptions
All commands take --db <file> (default evdock.db). The bearer token is read from the
environment variable named with --token-env; it is never stored.
subscribe needs \`evdock serve\` running: the server verifies the callback before answering.`;

const OPTIONS = {
  db: { type: 'string', default: 'evdock.db' },
  host: { type: 'string', default: '127.0.0.1' },
  port: { type: 'string', default: '8787' },
  url: { type: 'string' },
  'token-env': { type: 'string' },
  args: { type: 'string', default: '{}' },
  'callback-base': { type: 'string', default: 'http://127.0.0.1:8787' },
} as const;

class UsageError extends Error {}

function context(dbPath: string): Context {
  return { inbox: new Inbox(dbPath), client: clientFromEnv, now: Date.now, log: (line) => console.log(line) };
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
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command, ...rest] = positionals;

  if (command === 'serve') {
    const daemon = await startDaemon({
      dbPath: values.db,
      host: values.host,
      port: Number(values.port),
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
    const ctx = context(values.db);
    try {
      const events = await listEvents(await connect(ctx, rest[0]));
      for (const e of events) {
        const usable = e.delivery.includes('webhook') ? '' : '  (no webhook delivery: not usable by evdock)';
        console.log(`${e.name}  [${e.delivery.join(', ')}]${usable}${e.description ? `\n    ${e.description}` : ''}`);
      }
    } finally {
      ctx.inbox.close();
    }
    return;
  }

  if (command === 'subscribe' && rest[0] && rest[1]) {
    const ctx = context(values.db);
    try {
      const sub = await subscribe(ctx, {
        server: rest[0],
        eventName: rest[1],
        arguments: parseJsonObject(values.args),
        callbackBase: values['callback-base'],
      });
      const until = sub.refreshBefore === null ? 'no expiry' : new Date(sub.refreshBefore).toISOString();
      console.log(`subscribed ${label(sub)} to ${sub.eventName} on ${sub.server}, refresh before ${until}`);
    } finally {
      ctx.inbox.close();
    }
    return;
  }

  if (command === 'unsubscribe' && rest[0]) {
    const ctx = context(values.db);
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
            sub.lastError ? `lastError=${sub.lastError}` : '',
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
