// A stand-in for an agent, for the action executor tests.
// Usage: node agent-stub.mjs <record-file> <ok|fail|hang> [more args...]
// Appends one JSON line {argv, stdin} to the record file, then succeeds, fails or hangs.
import { appendFileSync } from 'node:fs';

const [recordFile, mode] = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
appendFileSync(recordFile, `${JSON.stringify({ argv: process.argv.slice(2), stdin: JSON.parse(input) })}\n`);
if (mode === 'fail') process.exit(3);
if (mode === 'hang') await new Promise((resolve) => setTimeout(resolve, 60_000));
