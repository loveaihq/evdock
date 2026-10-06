#!/usr/bin/env node
// A demo MCP server with the Events extension, for trying evdock without any account.
// It offers one event type, `incident.created`, and makes up a new incident every few seconds.
//
//   node examples/demo-server.mjs [--port 8790] [--every 15]
//
// Needs `npm run build` first (it uses evdock's mock server from dist/). TEST ONLY: it accepts
// plain-http callbacks on this machine, which real MCP servers must refuse.

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { port: { type: 'string', default: '8790' }, every: { type: 'string', default: '15' } },
});
const every = Number(values.every);
if (!/^[0-9]+(\.[0-9]+)?$/.test(values.every) || every < 1) {
  console.error('--every must be a number of seconds, 1 or more');
  process.exit(2);
}
const MOCK = new URL('../dist/src/conformance/mock-server.js', import.meta.url);
const { startMockServer } = await import(MOCK.href).catch((err) => {
  if (err?.code === 'ERR_MODULE_NOT_FOUND' && err.message.includes('mock-server.js')) {
    console.error('dist/ is missing: run `npm run build` first.');
    process.exit(1);
  }
  throw err;
});

const TOKEN = 'demo-token';
const server = await startMockServer({
  token: TOKEN,
  port: Number(values.port),
  eventTypes: [
    {
      name: 'incident.created',
      description: 'A new incident was opened (made up by the demo server)',
      inputSchema: { type: 'object', properties: { severity: { type: 'string', enum: ['P1', 'P2', 'P3'] } } },
      payloadSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, title: { type: 'string' }, severity: { type: 'string' } },
      },
      replay: true,
    },
  ],
  defaultTtlMs: 10 * 60 * 1000,
  retry: { attempts: 5, baseDelayMs: 1000 },
  allowInsecureCallbacks: true,
}).catch((err) => {
  if (err?.code !== 'EADDRINUSE') throw err;
  console.error(`port ${values.port} is in use: is the demo server already running? Otherwise pick another with --port.`);
  process.exit(1);
});

console.log(`demo MCP server: ${server.url}  (bearer token: ${TOKEN})`);
console.log(`making up an incident every ${every} s; Ctrl+C to stop`);

const titles = ['Database connection pool exhausted', 'Checkout latency above 2 s', 'Disk 90% full on web-3', 'Certificate expires in 5 days'];
let n = 0;
setInterval(() => {
  n++;
  const incident = { id: `INC-${1000 + n}`, title: titles[(n - 1) % titles.length], severity: ['P1', 'P2', 'P3'][n % 3] };
  const { eventId } = server.emit('incident.created', incident);
  const subscribers = server.subscriptions().length;
  console.log(`emitted ${eventId}: ${incident.id} ${incident.severity} "${incident.title}" -> ${subscribers} subscription(s)`);
}, every * 1000);

process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
