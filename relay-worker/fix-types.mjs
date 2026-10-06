// Run after `wrangler types` (npm run typecheck:worker). The generated Workers runtime types
// declare both TextDecoder options as required ({ fatal: boolean; ignoreBOM: boolean }), though
// workerd, like the WHATWG Encoding spec, takes either alone: the worker tests run
// src/relay/core.ts's `new TextDecoder('utf-8', { fatal: true })` on workerd. Made optional here
// so the shared core also type-checks against the Workers types. Fails once the generated types
// change, so this goes away when it is no longer needed.

import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('./worker-configuration.d.ts', import.meta.url);
const types = readFileSync(file, 'utf8');
const declared = (optional) =>
  new RegExp(`(interface TextDecoderConstructorOptions \\{\\s*)fatal${optional}: boolean;(\\s*)ignoreBOM${optional}: boolean;`);
// wrangler types leaves the file alone when it is up to date, so it may be fixed already.
if (!declared('\\?').test(types)) {
  if (!declared('').test(types)) {
    throw new Error('TextDecoderConstructorOptions is no longer as expected: check whether relay-worker/fix-types.mjs is still needed');
  }
  writeFileSync(file, types.replace(declared(''), '$1fatal?: boolean;$2ignoreBOM?: boolean;'));
}
