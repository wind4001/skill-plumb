#!/usr/bin/env node
/**
 * Permanent black-box regression suite for `env-diff-audit` (`verify_env_diff_audit.mjs`).
 * Covers: exit 0, exit 1, exit 2, --out JSON schema, dotenv edge syntax, and zero secret leakage.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(SKILL_DIR, 'scripts', 'probe_env_diff_audit.mjs');

function runProbeCli(args, envExtra = {}) {
  const res = spawnSync('node', [PROBE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...envExtra },
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

function assertNoLeaks(outputs, forbiddenTokens) {
  for (const text of outputs) {
    for (const token of forbiddenTokens) {
      assert.equal(
        text.includes(token),
        false,
        `Secret leak detected: found forbidden token "${token}" in output`
      );
    }
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env_diff_audit-verify-with spaces-'));
try {
  // 1. --help and -h exit 0 with usage output
  for (const flag of ['--help', '-h']) {
    const helpRes = runProbeCli([flag]);
    assert.equal(helpRes.status, 0, `${flag} should exit 0`);
    assert.match(helpRes.stdout, /Usage:/);
  }

  // 2. Exit 1 error cases (usage, unknown flag, missing arg, non-dir, missing .env* files)
  const noArgs = runProbeCli([]);
  assert.equal(noArgs.status, 1);
  assert.equal(noArgs.stdout, '');
  assert.equal(JSON.parse(noArgs.stderr).exit_code, 1);

  const bogusFlag = runProbeCli(['--bogus-d-gate-flag']);
  assert.equal(bogusFlag.status, 1);
  assert.match(bogusFlag.stderr, /Unknown flag/);

  const missingOutVal = runProbeCli([tmp, '--out']);
  assert.equal(missingOutVal.status, 1);
  assert.match(missingOutVal.stderr, /--out/);

  const extraPos = runProbeCli([tmp, tmp]);
  assert.equal(extraPos.status, 1);
  assert.match(extraPos.stderr, /extra positional/i);

  const missingDir = runProbeCli([path.join(tmp, 'does-not-exist')]);
  assert.equal(missingDir.status, 1);
  assert.match(missingDir.stderr, /does not exist/i);

  const regularFile = path.join(tmp, 'not-a-dir.txt');
  fs.writeFileSync(regularFile, 'hello', 'utf8');
  const nonDirRes = runProbeCli([regularFile]);
  assert.equal(nonDirRes.status, 1);
  assert.match(nonDirRes.stderr, /not a directory/i);

  const missingExampleDir = path.join(tmp, 'missing-example');
  fs.mkdirSync(missingExampleDir);
  fs.writeFileSync(path.join(missingExampleDir, '.env'), 'PORT=3000\n', 'utf8');
  const missingExRes = runProbeCli([missingExampleDir]);
  assert.equal(missingExRes.status, 1);
  assert.match(missingExRes.stderr, /\.env\.example/);

  const missingEnvDir = path.join(tmp, 'missing-env');
  fs.mkdirSync(missingEnvDir);
  fs.writeFileSync(path.join(missingEnvDir, '.env.example'), 'PORT=3000\n', 'utf8');
  const missingEnvRes = runProbeCli([missingEnvDir]);
  assert.equal(missingEnvRes.status, 1);
  assert.match(missingEnvRes.stderr, /\.env\b/);

  // Optional symlink escape test (skipped cleanly if OS denies unprivileged symlinks)
  const outsideSecret = path.join(tmp, 'outside-secret.env');
  fs.writeFileSync(outsideSecret, 'API_KEY=should-never-read-escape\n', 'utf8');
  const escapeDir = path.join(tmp, 'symlink-escape');
  fs.mkdirSync(escapeDir);
  fs.writeFileSync(path.join(escapeDir, '.env.example'), 'API_KEY=YOUR_API_KEY\n', 'utf8');
  let symlinkCreated = false;
  try {
    fs.symlinkSync(outsideSecret, path.join(escapeDir, '.env'));
    symlinkCreated = true;
  } catch {
    symlinkCreated = false;
  }
  if (symlinkCreated) {
    const escRes = runProbeCli([escapeDir]);
    assert.equal(escRes.status, 1);
    assert.match(escRes.stderr, /Symlink escape/i);
    assertNoLeaks([escRes.stdout, escRes.stderr], ['should-never-read-escape']);
  }

  // 3. Exit 0 clean case (comments, blanks, export prefix, '=' in values, quotes, safe shared defaults)
  const cleanDir = path.join(tmp, 'clean project');
  fs.mkdirSync(cleanDir);
  const cleanSentinels = [
    ['sk', 'clean-live-secret-99887766'].join('-'),
    'realPass=with=equals#hash',
    'jwt-super-secret-value-alpha-01',
    'env-process-sentinel-4455',
  ];
  fs.writeFileSync(
    path.join(cleanDir, '.env.example'),
    [
      '\uFEFF# App config template',
      '',
      'PORT=3000 # default listen port',
      'NODE_ENV=production',
      'TOKEN_TTL=3600',
      'export API_KEY=YOUR_API_KEY',
      'DATABASE_URL="postgres://user:pass@localhost:5432/app"',
      "JWT_SECRET='CHANGE_ME'",
      'export_mode=true',
      'HASH_LITERAL=abc#def',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(cleanDir, '.env'),
    [
      '# Local runtime env',
      'PORT=3000',
      'NODE_ENV=production',
      'TOKEN_TTL=3600',
      `export API_KEY = "${cleanSentinels[0]}" # inline comment`,
      `DATABASE_URL='postgres://app:${cleanSentinels[1]}@db:5432/prod?sslmode=require'`,
      `JWT_SECRET="${cleanSentinels[2]}"`,
      'export_mode=true',
      'HASH_LITERAL=abc#def',
    ].join('\r\n'),
    'utf8'
  );
  const cleanOutPath = path.join(tmp, 'reports', 'clean.json');
  const cleanRes = runProbeCli([cleanDir, '--out', cleanOutPath], { TEST_SECRET: cleanSentinels[3] });
  assert.equal(cleanRes.status, 0, `Expected clean exit 0, got ${cleanRes.status}: ${cleanRes.stdout} ${cleanRes.stderr}`);
  const cleanJsonRaw = fs.readFileSync(cleanOutPath, 'utf8');
  const cleanReport = JSON.parse(cleanJsonRaw);
  assert.equal(cleanReport.scan_completed, true);
  assert.equal(cleanReport.exit_code, 0);
  assert.equal(cleanReport.exit_meaning, 'env_clean');
  assert.equal(cleanReport.status, 'clean');
  assert.equal(cleanReport.counts.example_keys, 8);
  assert.equal(cleanReport.counts.env_keys, 8);
  assert.equal(cleanReport.counts.missing_keys, 0);
  assert.equal(cleanReport.counts.extra_keys, 0);
  assert.equal(cleanReport.counts.empty_or_placeholder_keys, 0);
  assert.equal(cleanReport.counts.total_findings, 0);
  assert.deepEqual(cleanReport.findings, []);
  assertNoLeaks([cleanRes.stdout, cleanRes.stderr, cleanJsonRaw], cleanSentinels);

  // 4. Exit 2 drift + placeholder cases + strict zero-plaintext-secret assertions
  const dirtyDir = path.join(tmp, 'dirty project');
  fs.mkdirSync(dirtyDir);
  const dirtySentinels = [
    ['sk', 'hidden-prefix-leak-1122'].join('-'),
    'tail-secret-9988',
    'extra-live-secret-sentinel-5566',
    'real-db-host-secret-4321',
  ];
  fs.writeFileSync(
    path.join(dirtyDir, '.env.example'),
    [
      'MISSING_KEY=required',
      'EMPTY_UNQUOTED=',
      'EMPTY_QUOTED=""',
      'WS_QUOTED="   "',
      'COMMENT_ONLY=',
      'P_CHANGE=CHANGE_ME',
      'P_LOWER=changeme',
      'P_YOUR=YOUR_API_KEY',
      'P_ANGLES=<...>',
      'P_TODO=TODO',
      'P_REPLACE=REPLACE_ME',
      'P_XXX=xxx',
      'P_PLACEHOLDER=placeholder',
      'P_MIXED=CHANGE_ME',
      'P_IDENTICAL_TEMPLATE=example-webhook-secret',
      'P_IDENTICAL_PASS=password',
      'P_DSN_PLACEHOLDER=postgres://user:CHANGE_ME@localhost/db',
      'VALID_SECRET=YOUR_VALID_SECRET',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dirtyDir, '.env'),
    [
      '# MISSING_KEY intentionally omitted',
      'EMPTY_UNQUOTED=',
      'EMPTY_QUOTED=""',
      'WS_QUOTED="   "',
      'COMMENT_ONLY= # unfilled',
      'P_CHANGE=CHANGE_ME',
      'P_LOWER=changeme',
      'P_YOUR=YOUR_SERVICE_TOKEN',
      'P_ANGLES=<your_token>',
      'P_TODO=TODO',
      'P_REPLACE=REPLACE_ME',
      'P_XXX=sk-xxx',
      'P_PLACEHOLDER=my_placeholder_value',
      `P_MIXED=${dirtySentinels[0]}-CHANGE_ME-${dirtySentinels[1]}`,
      'P_IDENTICAL_TEMPLATE=example-webhook-secret',
      'P_IDENTICAL_PASS=password',
      `P_DSN_PLACEHOLDER=postgres://u:changeme@${dirtySentinels[3]}:5432/db`,
      'VALID_SECRET=actual-cryptographic-value-ready-001',
      `EXTRA_KEY=${dirtySentinels[2]}`,
    ].join('\n'),
    'utf8'
  );
  const dirtyOutPath = path.join(tmp, 'reports', 'dirty.json');
  const dirtyRes = runProbeCli([dirtyDir, '--out', dirtyOutPath]);
  assert.equal(dirtyRes.status, 2, `Expected exit 2, got ${dirtyRes.status}`);
  assert.equal(dirtyRes.stderr, '');
  const dirtyJsonRaw = fs.readFileSync(dirtyOutPath, 'utf8');
  const dirtyReport = JSON.parse(dirtyJsonRaw);

  assert.equal(dirtyReport.scan_completed, true);
  assert.equal(dirtyReport.exit_code, 2);
  assert.equal(dirtyReport.exit_meaning, 'env_drift_or_placeholders');
  assert.equal(dirtyReport.status, 'findings_detected');
  assert.equal(dirtyReport.counts.missing_keys, 1);
  assert.equal(dirtyReport.counts.extra_keys, 1);
  assert.equal(dirtyReport.counts.empty_or_placeholder_keys, 16);
  assert.equal(dirtyReport.counts.total_findings, 18);

  assert.deepEqual(dirtyReport.missing_keys.map((x) => x.key), ['MISSING_KEY']);
  assert.deepEqual(dirtyReport.extra_keys.map((x) => x.key), ['EXTRA_KEY']);

  const flaggedKeys = new Set(dirtyReport.placeholder_or_empty.map((x) => x.key));
  for (const expectedKey of [
    'EMPTY_UNQUOTED',
    'EMPTY_QUOTED',
    'WS_QUOTED',
    'COMMENT_ONLY',
    'P_CHANGE',
    'P_LOWER',
    'P_YOUR',
    'P_ANGLES',
    'P_TODO',
    'P_REPLACE',
    'P_XXX',
    'P_PLACEHOLDER',
    'P_MIXED',
    'P_IDENTICAL_TEMPLATE',
    'P_IDENTICAL_PASS',
    'P_DSN_PLACEHOLDER',
  ]) {
    assert.ok(flaggedKeys.has(expectedKey), `Expected ${expectedKey} in placeholder_or_empty`);
  }
  assert.equal(flaggedKeys.has('VALID_SECRET'), false, 'Valid secret should not be flagged');

  for (const item of dirtyReport.placeholder_or_empty) {
    assert.equal(item.redacted, true);
    assert.ok(item.redacted_preview === '<empty>' || item.redacted_preview === '[REDACTED]');
    assert.equal('value' in item, false, 'Raw value field must never exist');
  }

  assertNoLeaks(
    [dirtyRes.stdout, dirtyRes.stderr, dirtyJsonRaw],
    [
      ...dirtySentinels,
      'actual-cryptographic-value-ready-001',
      'YOUR_SERVICE_TOKEN',
      '<your_token>',
      'my_placeholder_value',
      'example-webhook-secret',
    ]
  );

  console.log('ALL env-diff-audit VERIFICATION CHECKS PASSED (exit 0/1/2 + schema + zero-leak)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
