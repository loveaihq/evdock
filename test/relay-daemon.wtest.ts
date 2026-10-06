// The end-to-end relay scenarios against the Cloudflare Worker relay under `wrangler dev`
// (docs/M3-TASK.md 交付 5). Run with `npm run test:worker`.
//
// One Worker serves every scenario: starting and killing wrangler per test is slow, and on
// Windows its workerd can hold ports and files for a moment after being killed. Scenarios use
// fresh paths each, and whatever one leaves behind the next daemon answers 404 and acknowledges.

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { relayScenarios } from './relay-scenarios.js';
import { startWorkerRelay, type WorkerRelay } from './worker-relay.js';

const dir = mkdtempSync(join(tmpdir(), 'evdock-worker-e2e-'));
let shared: Promise<WorkerRelay> | undefined;

after(async () => {
  if (shared) await (await shared).close();
  // Retried: Windows can hold on to the SQLite files of the just-killed workerd for a moment.
  await rm(dir, { recursive: true, force: true, maxRetries: 10 });
});

relayScenarios(async (_dir, key) => {
  shared ??= startWorkerRelay({ key, persistDir: join(dir, 'worker-state') });
  const relay = await shared;
  return { url: relay.url, close: async () => {} };
});
