import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor, runGate } from '../src/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES_DIR = path.join(ROOT, 'examples');

const examples = ['env-diff-audit', 'oss-eval', 'pre-publish-audit', 'skill-creator'];

// 1. Run each example's own black-box verify_*.mjs suite
for (const name of examples) {
  const dir = path.join(EXAMPLES_DIR, name);
  const vf = fs.readdirSync(dir).find((f) => /^verify_.*\.mjs$/.test(f));
  assert.ok(vf, `Missing verify_*.mjs in examples/${name}`);
  execFileSync('node', [path.join(dir, vf)], { encoding: 'utf8', timeout: 45000 });
}

// 2. Pass skill-plumb gate on every example skill (without touching user home dirs)
for (const name of examples) {
  const dir = path.join(EXAMPLES_DIR, name);
  const res = runGate({
    skillDir: dir,
    skillsDirs: [EXAMPLES_DIR],
    noMcp: true,
    noSync: true,
    skipVerify: true, // already verified right above
  });
  assert.equal(
    res.exitCode,
    0,
    `Example "${name}" failed D-Gate: ${JSON.stringify(res.result?.failures, null, 2)}`
  );
}

// 3. Doctor reports all examples healthy
const doc = runDoctor({ skillsDirs: [EXAMPLES_DIR], noMcp: true });
assert.equal(doc.exitCode, 0, `Doctor failed on examples/: ${JSON.stringify(doc.result?.findings, null, 2)}`);

console.log('test_examples.mjs PASSED (4 examples verified + gated + doctor clean)');
