// The Cloudflare Worker relay (relay-worker/) under `wrangler dev --local`, for npm run test:worker.
// Runs entirely in the local workerd: no Cloudflare account, no login, nothing deployed.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRANGLER = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');
// This file runs from dist/test/; the Worker's source and config stay in the source tree.
const CONFIG = fileURLToPath(new URL('../../relay-worker/wrangler.jsonc', import.meta.url));

export interface WorkerRelayOptions {
  key: string;
  port?: number;
  /** Where the Durable Object's SQLite lives. Start again with the same directory to keep what was stored. */
  persistDir: string;
}

export interface WorkerRelay {
  url: string;
  /** Everything wrangler and the Worker printed so far (stdout and stderr). */
  output(): string;
  close(): Promise<void>;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

export async function startWorkerRelay(options: WorkerRelayOptions): Promise<WorkerRelay> {
  const port = options.port ?? (await freePort());
  const url = `http://127.0.0.1:${port}`;
  const args = [
    WRANGLER,
    'dev',
    '--local',
    '--config',
    CONFIG,
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--persist-to',
    options.persistDir,
    '--show-interactive-dev-session=false',
  ];
  // RELAY_KEY is a required secret (wrangler.jsonc), which wrangler takes from the environment
  // below, but only when there is no .dev.vars: that file would win.
  const devVars = join(dirname(CONFIG), '.dev.vars');
  if (existsSync(devVars)) throw new Error(`${devVars} would replace the test's relay key: move it away while testing`);
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      // Not --var: wrangler prints the values of vars on startup, and secrets as "(hidden)".
      RELAY_KEY: options.key,
      WRANGLER_SEND_METRICS: 'false',
      // No network: the banner's npm update check and Miniflare's download of request.cf data.
      WRANGLER_HIDE_BANNER: 'true',
      CLOUDFLARE_CF_FETCH_ENABLED: 'false',
      // Keep wrangler's log files and dev registry out of the user's home directory.
      WRANGLER_WRITE_LOGS: 'false',
      WRANGLER_REGISTRY_PATH: join(options.persistDir, 'registry'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX: its own process group, so close() reaches wrangler's workerd children too.
    detached: process.platform !== 'win32',
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (text: string) => (output += text));
  child.stderr.setEncoding('utf8').on('data', (text: string) => (output += text));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let running = true;
  void exited.then(() => (running = false));

  // Wrangler runs workerd in child processes; killing wrangler alone would leave them holding the
  // port and the SQLite files. Resolves once all of them are gone.
  async function close(): Promise<void> {
    if (process.platform !== 'win32') {
      const signalGroup = (signal: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, signal);
        } catch {
          // The group is gone.
        }
      };
      signalGroup('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
      // Whatever is left of the group, workerd included.
      signalGroup('SIGKILL');
      await exited;
      return;
    }
    // Windows has no process groups and no SIGTERM to catch: taskkill ends the tree, reporting
    // each process as "... PID <n> ..." (in any display language), and returns before they are gone.
    if (!running) return;
    const report = await new Promise<string>((resolve) =>
      execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], (_error, stdout) => resolve(String(stdout))),
    );
    const pids = [...report.matchAll(/PID (\d+)/g)].map((match) => Number(match[1])).filter((pid) => pid !== process.pid);
    await exited;
    const deadline = Date.now() + 10_000;
    while (pids.some(alive)) {
      if (Date.now() > deadline) throw new Error(`wrangler processes still running after taskkill: ${pids.filter(alive).join(' ')}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // Ready when the relay itself answers: only the relay core sends 401 to a request without the key.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = await fetch(`${url}/relay/deliveries`).then(
      (res) => res.status,
      () => 0,
    );
    if (status === 401) break;
    if (!running || Date.now() > deadline) {
      await close();
      throw new Error(`wrangler dev did not start (${running ? 'timed out' : 'exited'}):\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { url, output: () => output, close };
}
