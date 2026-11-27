#!/usr/bin/env node
/**
 * Isolated black-box regression suite for `skill-creator` (`verify_skill_creator.mjs`).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(SKILL_DIR, 'scripts', 'probe_d_factory.mjs');

function runProbe(args) {
  try {
    const stdout = execFileSync('node', [PROBE, ...args], { encoding: 'utf8', timeout: 15000 });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function quoteWinCmdArg(arg) {
  const s = String(arg);
  if (s.length > 0 && !/[\s"&|<>^()!%]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function runCli(cliPath, args) {
  if (cliPath.endsWith('.mjs') || cliPath.endsWith('.js')) {
    return execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', timeout: 15000 });
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) {
    const cmdLine = [quoteWinCmdArg(cliPath), ...args.map(quoteWinCmdArg)].join(' ');
    return execFileSync('cmd.exe', ['/d', '/s', '/c', `"${cmdLine}"`], {
      encoding: 'utf8',
      timeout: 15000,
      windowsVerbatimArguments: true,
    });
  }
  return execFileSync(cliPath, args, { encoding: 'utf8', timeout: 15000 });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-verify-with spaces-'));
try {
  // 1. --help returns 0
  assert.equal(runProbe(['--help']).status, 0);

  // 2. Bogus flag & missing dir return 1
  assert.equal(runProbe(['--bogus-d-gate-flag']).status, 1);
  assert.equal(runProbe([path.join(tmp, 'missing-dir')]).status, 1);

  // 3. Detects skill-plumb CLI & self SKILL.md cleanly
  const outPath = path.join(tmp, 'sc-probe.json');
  const res = runProbe([SKILL_DIR, '--out', outPath]);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(parsed.target_has_skill_md, true);
  assert.ok(parsed.cli_path);

  // 4. Dry-run scaffold succeeds in isolated temp dir without touching ~/.agents/skills
  const isoSkills = path.join(tmp, 'iso-skills');
  fs.mkdirSync(isoSkills, { recursive: true });
  const dry = runCli(parsed.cli_path, [
    'scaffold',
    '--name', 'demo-check',
    '--domain', 'repo',
    '--summary', 'Check repository format demo.',
    '--out-dir', isoSkills,
    '--skills-dir', isoSkills,
    '--no-mcp',
    '--dry-run',
  ]);
  const dryJson = JSON.parse(dry);
  assert.equal(dryJson.dry_run, true);
  assert.equal(dryJson.files.length, 4);

  console.log('ALL skill-creator VERIFICATION CHECKS PASSED (4/4)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
