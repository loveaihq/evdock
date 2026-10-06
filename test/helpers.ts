import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Webhook } from 'standardwebhooks';
import type { Subscription } from '../src/inbox.js';

export function newSecret(bytes = 32): string {
  return `whsec_${randomBytes(bytes).toString('base64')}`;
}

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

/** A temp directory removed by the returned cleanup. */
export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'evdock-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Signs with the official standardwebhooks library, independent of src/signature.ts. */
export function officialSign(secret: string, id: string, timestampSeconds: number, body: string): string {
  return new Webhook(secret).sign(id, new Date(timestampSeconds * 1000), body);
}

/** A confirmed subscription row, for stubs that bypass the inbox. */
export function activeSubscription(token: string, secret: string): Subscription {
  return {
    token,
    secret,
    subscriptionId: 'sub_test',
    status: 'active',
    server: null,
    eventName: null,
    arguments: null,
    callbackUrl: null,
    refreshBefore: null,
    grantedAt: null,
    lastError: null,
  };
}
