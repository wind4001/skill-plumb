#!/usr/bin/env node
/**
 * Unified OS-portable test runner for `skill-plumb` (`npm test`).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES = [
  'test_router.mjs',
  'test_dfactory.mjs',
  'test_doctor.mjs',
  'test_cli.mjs',
  'test_examples.mjs',
];

const started = Date.now();
for (const file of SUITES) {
  const t0 = Date.now();
  const full = path.join(HERE, file);
  const out = execFileSync('node', [full], { encoding: 'utf8', timeout: 90000 }).trim();
  console.log(`[PASS] ${file} (${Date.now() - t0}ms): ${out}`);
}
console.log(`\nALL ${SUITES.length} TEST SUITES PASSED in ${Date.now() - started}ms.`);
