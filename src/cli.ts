#!/usr/bin/env node
// evdock serve     run the local receiver
// evdock register  add a receive path and secret by hand (stand-in until subscription management, M2)

import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createReceiver } from './http.js';
import { Inbox } from './inbox.js';

const USAGE = `usage:
  evdock serve    [--db evdock.db] [--host 127.0.0.1] [--port 8787]
  evdock register [--db evdock.db] [--base-url http://127.0.0.1:8787] [--subscription-id <id>]

register prints the hook URL and its whsec_ secret for testing. Without
--subscription-id the path stays unconfirmed and event deliveries get 503.`;

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      db: { type: 'string', default: 'evdock.db' },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8787' },
      'base-url': { type: 'string', default: 'http://127.0.0.1:8787' },
      'subscription-id': { type: 'string' },
    },
  });

  if (command === 'serve') {
    const inbox = new Inbox(values.db);
    const server = createReceiver({ inbox, log: (line) => console.log(line) });
    server.listen(Number(values.port), values.host, () => {
      console.log(`evdock receiving on http://${values.host}:${values.port}/hooks/<token>`);
    });
    return;
  }

  if (command === 'register') {
    const inbox = new Inbox(values.db);
    const token = randomBytes(24).toString('base64url');
    const secret = `whsec_${randomBytes(32).toString('base64')}`;
    inbox.addSubscription(token, secret);
    const subscriptionId = values['subscription-id'] ?? null;
    if (subscriptionId !== null) inbox.confirmSubscription(token, subscriptionId);
    inbox.close();
    const url = `${values['base-url'].replace(/\/$/, '')}/hooks/${token}`;
    console.log(JSON.stringify({ url, secret, subscriptionId }, null, 2));
    return;
  }

  console.error(USAGE);
  process.exitCode = 2;
}

main(process.argv.slice(2));
