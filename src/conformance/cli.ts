#!/usr/bin/env node
// evdock-conformance: run the receiver checks against any MCP Events webhook endpoint.

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { formatTable, runSuite } from './suite.js';

const USAGE = `usage: evdock-conformance --url <callback-url> --secret <whsec_...> --subscription-id <id> [--json <report.json>]

Plays the MCP server: signs deliveries with the given secret and POSTs them to the URL.
The last check sends a terminated envelope, which may end the subscription on the receiver.
Exit code: 0 conformant, 1 a MUST check failed, 2 usage error.`;

async function main(): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        url: { type: 'string' },
        secret: { type: 'string' },
        'subscription-id': { type: 'string' },
        json: { type: 'string', default: 'conformance-report.json' },
      },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const { url, secret } = values;
  const subscriptionId = values['subscription-id'];
  if (!url || !secret || !subscriptionId) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  let report;
  try {
    report = await runSuite({ url, secret, subscriptionId });
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 2;
    return;
  }
  console.log(formatTable(report));
  writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`JSON report: ${values.json}`);
  process.exitCode = report.conformant ? 0 : 1;
}

await main();
