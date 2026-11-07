// tests/js/run-all.mjs — run every tests/js/run_*.mjs suite in order.
// Used by `npm test` and by CI. Exits non-zero if any suite fails.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(dir).filter((f) => /^run_.*\.mjs$/.test(f) && f !== 'run-all.mjs').sort();

let failed = 0;
for (const suite of suites) {
  console.log(`\n===== ${suite} =====`);
  const r = spawnSync(process.execPath, [path.join(dir, suite)], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed += 1;
    console.error(`SUITE FAILED: ${suite} (exit ${r.status})`);
    if (r.signal) console.error(`  killed by signal: ${r.signal}`);
    if (r.error) console.error(`  spawn error: ${r.error.message}`);
  }
}

console.log(`\n${suites.length} suite(s), ${failed} failed`);
process.exit(failed ? 1 : 0);
