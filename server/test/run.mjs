/**
 * Runs every test file in this folder, each in its own process so one
 * replacing `globalThis.fetch` cannot affect the next.
 *
 * Nothing here touches the network: every test replaces `fetch` with canned
 * responses, so the results do not depend on Steam being reachable or on which
 * game happens to have a trailer today.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here).filter((name) => name.endsWith('.test.mjs')).sort();

let failed = 0;
for (const file of files) {
  console.log(`\n── ${file} ${'─'.repeat(Math.max(0, 60 - file.length))}`);
  const result = spawnSync(process.execPath, [path.join(here, file)], { stdio: 'inherit' });
  if (result.status !== 0) failed += 1;
}

console.log(
  failed === 0 ? `\n${files.length} file(s), all passed.` : `\n${failed} of ${files.length} file(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
