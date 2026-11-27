#!/usr/bin/env node
/**
 * Zero-dependency readiness probe for `skill-creator` (`probe_d_factory.mjs`).
 * Locates `skill-plumb` CLI via `--cli`, `SKILL_PLUMB_BIN`, repo-local `bin/skill-plumb.mjs`, or PATH.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function findExecutable(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, name + ext);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch { /* ignore */ }
    }
  }
  return null;
}

function resolveCli(explicitCli) {
  if (explicitCli !== null && explicitCli !== undefined) {
    const absCli = explicitCli ? path.resolve(explicitCli) : '';
    try {
      if (absCli && fs.existsSync(absCli) && fs.statSync(absCli).isFile()) {
        return { ok: true, cliPath: absCli };
      }
    } catch { /* fall through to explicit error */ }
    return { ok: false, error: `Explicit --cli not found or not a file: ${explicitCli}` };
  }

  const candidates = [
    process.env.SKILL_PLUMB_BIN ? path.resolve(process.env.SKILL_PLUMB_BIN) : null,
    path.resolve(SKILL_DIR, '..', '..', 'bin', 'skill-plumb.mjs'),
    findExecutable('skill-plumb'),
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return { ok: true, cliPath: c };
    } catch { /* ignore */ }
  }
  return { ok: true, cliPath: null };
}

function parseArgs(argv) {
  const opts = { target: '.', cli: null, out: null, help: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--target' || a === '--out' || a === '--cli') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        return { ok: false, error: `Missing value for ${a}` };
      }
      const v = argv[++i];
      if (a === '--target') opts.target = v;
      else if (a === '--out') opts.out = v;
      else opts.cli = v;
    } else if (a.startsWith('-')) {
      return { ok: false, error: `Unknown flag: ${a}` };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { ok: false, error: `Unexpected positional arguments: ${pos.slice(1).join(' ')}` };
  if (pos.length === 1) opts.target = pos[0];
  return { ok: true, opts };
}

function printHelp() {
  console.log(`Usage:
  node probe_d_factory.mjs [<target_skill_or_dir>] [--target <dir>] [--cli <skill-plumb>] [--out <report.json>]

Checks availability of the skill-plumb CLI and inspects whether <target> contains a SKILL.md.

Exit codes:
  0 = skill-plumb CLI located and target directory valid
  1 = invalid CLI arguments or missing target path
  2 = skill-plumb CLI could not be located`);
}

export function runProbe(rawTarget, explicitCli = null) {
  const abs = path.resolve(rawTarget || '.');
  if (!fs.existsSync(abs)) return { exitCode: 1, error: `Target path not found: ${rawTarget}` };
  const realTarget = fs.realpathSync(abs);
  if (!fs.statSync(realTarget).isDirectory()) {
    return { exitCode: 1, error: `Target path is not a directory: ${rawTarget}` };
  }

  const cliRes = resolveCli(explicitCli);
  if (!cliRes.ok) {
    return { exitCode: 1, error: cliRes.error };
  }
  const cliPath = cliRes.cliPath;
  const hasTargetSkillMd = fs.existsSync(path.join(realTarget, 'SKILL.md'));
  const exitCode = cliPath ? 0 : 2;

  return {
    exitCode,
    result: {
      scan_completed: true,
      exit_code: exitCode,
      exit_meaning: cliPath ? 'skill_plumb_ready' : 'skill_plumb_missing',
      skill_creator_dir: SKILL_DIR.replace(/\\/g, '/'),
      target: realTarget.replace(/\\/g, '/'),
      target_has_skill_md: hasTargetSkillMd,
      calibration: { target_checked: true },
      scopes_checked: ['cli_discovery', 'target_skill_md'],
      scopes_skipped: [],
      cli_path: cliPath ? cliPath.replace(/\\/g, '/') : null,
    },
  };
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(JSON.stringify({ scan_completed: false, exit_code: 1, error: parsed.error }, null, 2) + '\n');
    process.exit(1);
  }
  if (parsed.opts.help) {
    printHelp();
    process.exit(0);
  }
  const out = runProbe(parsed.opts.target, parsed.opts.cli);
  if (out.exitCode === 1 && !out.result) {
    process.stderr.write(JSON.stringify({ scan_completed: false, exit_code: 1, error: out.error }, null, 2) + '\n');
    process.exit(1);
  }
  const serialized = JSON.stringify(out.result, null, 2) + '\n';
  if (parsed.opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(parsed.opts.out)), { recursive: true });
    fs.writeFileSync(parsed.opts.out, serialized, 'utf8');
  }
  process.stdout.write(serialized);
  process.exit(out.exitCode);
}
