// A stand-in for an agent, for the action executor tests.
// Usage: node agent-stub.mjs <record-file> <ok|fail|hang|hang-tree|trap> [more args...]
// Appends one JSON line {argv, stdin, pid, childPid?, env} to the record file, then succeeds,
// fails, hangs, hangs with a child process of its own (hang-tree), or hangs ignoring SIGTERM (trap).
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const [recordFile, mode] = process.argv.slice(2);
if (mode === 'trap') process.on('SIGTERM', () => {});
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const childPid =
  mode === 'hang-tree' ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid : undefined;
const record = { argv: process.argv.slice(2), stdin: JSON.parse(input), pid: process.pid, childPid, env: Object.keys(process.env) };
appendFileSync(recordFile, `${JSON.stringify(record)}\n`);
if (mode === 'fail') process.exit(3);
if (mode === 'hang' || mode === 'hang-tree' || mode === 'trap') await new Promise((resolve) => setTimeout(resolve, 60_000));
