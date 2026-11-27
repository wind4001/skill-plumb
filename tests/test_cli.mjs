import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'skill-plumb.mjs');

function runCli(args, cwd = ROOT) {
  try {
    const stdout = execFileSync('node', [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 25000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cli-test-with spaces-'));
try {
  // 1. --help & --version & unknown command
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /skill-plumb v0\.1\.0/);

  const ver = runCli(['--version']);
  assert.equal(ver.status, 0);
  assert.equal(ver.stdout.trim(), '0.1.0');

  const unk = runCli(['does-not-exist']);
  assert.equal(unk.status, 1);

  // 2. init-plugin (both formats) with zero personal path leaks
  const pluginDir = path.join(tmp, 'my-plugin');
  const initRes = runCli(['init-plugin', '--out', pluginDir]);
  assert.equal(initRes.status, 0, initRes.stderr);
  assert.ok(fs.existsSync(path.join(pluginDir, 'plugin.json')));
  const agentsContent = fs.readFileSync(path.join(pluginDir, 'rules', 'AGENTS.md'), 'utf8');
  assert.match(agentsContent, /npx --yes skill-plumb inspect/);
  assert.equal(/[A-Za-z]:[/\\]Users[/\\]/i.test(agentsContent), false);

  const agentsFile = path.join(tmp, 'AGENTS.md');
  const initMd = runCli(['init-plugin', '--format', 'agents-md', '--out', agentsFile]);
  assert.equal(initMd.status, 0);
  assert.ok(fs.existsSync(agentsFile));

  // 3. scaffold -> gate -> sync -> brief -> list -> inspect -> doctor via CLI (--catalog vs --out)
  const skillsDir = path.join(tmp, 'skills');
  const catalogOut = path.join(tmp, 'catalog.json');
  const common = ['--skills-dir', skillsDir, '--no-mcp', '--catalog', catalogOut];

  const scaf = runCli([
    'scaffold',
    '--name', 'lockfile-cve-check',
    '--domain', 'sec',
    '--summary', 'Audit lockfiles for known CVE advisories.',
    '--use-when', 'scanning package-lock.json or uv.lock for CVEs',
    '--not-for', 'checking .env config drift (use env-diff-audit)',
    '--out-dir', skillsDir,
    '--skills-dir', skillsDir,
    '--no-mcp',
  ]);
  assert.equal(scaf.status, 0, scaf.stderr);

  const gate = runCli([
    'gate',
    path.join(skillsDir, 'lockfile-cve-check'),
    '--skills-dir', skillsDir,
    '--no-mcp',
    '--no-sync',
  ]);
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);

  const syncReport = path.join(tmp, 'sync-report.json');
  const sync = runCli(['sync', ...common, '--out', syncReport]);
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(JSON.parse(sync.stdout).skills, 1);
  assert.equal(JSON.parse(fs.readFileSync(syncReport, 'utf8')).skills, 1);
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(catalogOut, 'utf8'))));

  const brief = runCli(['brief', ...common]);
  assert.equal(brief.status, 0);
  assert.equal(JSON.parse(brief.stdout).total_entries, 1);

  const list = runCli(['list', 'sec', ...common]);
  assert.equal(list.status, 0);
  assert.equal(JSON.parse(list.stdout).items[0].id, 'sec/lockfile-cve-check');

  const inspectReport = path.join(tmp, 'inspect-report.json');
  const inspect = runCli(['inspect', 'scan lockfile-cve-check for CVEs', ...common, '--out', inspectReport]);
  assert.equal(inspect.status, 0);
  assert.equal(JSON.parse(inspect.stdout).predicted, 'sec/lockfile-cve-check');
  assert.equal(JSON.parse(fs.readFileSync(inspectReport, 'utf8')).predicted, 'sec/lockfile-cve-check');
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(catalogOut, 'utf8'))), '--out on inspect must not overwrite --catalog');

  const doc = runCli(['doctor', '--skills-dir', skillsDir, '--no-mcp', '--json']);
  assert.equal(doc.status, 0, doc.stdout);
  assert.equal(JSON.parse(doc.stdout).summary.findings_count, 0);

  // 4. sync exits 2 when override_warnings exist even if missing_not_for_count === 0
  const warnOvr = path.join(tmp, 'warn-overrides.json');
  fs.writeFileSync(warnOvr, JSON.stringify({
    overrides: {
      'lockfile-cve-check': { domain: 'sec', not_for: 'non-array string warning' },
    },
  }, null, 2));
  const warnSync = runCli(['sync', '--skills-dir', skillsDir, '--no-mcp', '--overrides', warnOvr, '--catalog', catalogOut]);
  assert.equal(warnSync.status, 2);
  assert.ok(JSON.parse(warnSync.stdout).override_warnings.length >= 1);

  // 5. Invalid positive integer options, --out -h, --flag=, extra positionals, and gate --mode bogus exit 1
  assert.equal(runCli(['doctor', '--max-lines', '0', '--skills-dir', skillsDir, '--no-mcp']).status, 1);
  assert.equal(runCli(['inspect', 'scan CVEs', '--limit', 'abc', ...common]).status, 1);
  assert.equal(runCli(['doctor', '--out', '-h', '--skills-dir', skillsDir, '--no-mcp']).status, 1);
  assert.equal(runCli(['doctor', '--mcp-cfg=', '--skills-dir', skillsDir]).status, 1);
  assert.equal(runCli(['doctor', 'extra-arg', '--skills-dir', skillsDir, '--no-mcp']).status, 1);
  assert.equal(runCli(['gate', path.join(skillsDir, 'lockfile-cve-check'), '--mode', 'bogus']).status, 1);

  // 6. scaffold --out <dir> and --flag=val work as documented
  const scafOutFlagDir = path.join(tmp, 'skills-via-out');
  const scafOutRes = runCli([
    'scaffold',
    '--name=out-flag-skill',
    '--domain=repo',
    '--summary=Verify --out works as scaffold output directory.',
    `--out=${scafOutFlagDir}`,
    '--skills-dir', skillsDir,
    '--no-mcp',
  ]);
  assert.equal(scafOutRes.status, 0, scafOutRes.stderr);
  assert.ok(fs.existsSync(path.join(scafOutFlagDir, 'out-flag-skill', 'SKILL.md')));

  console.log('test_cli.mjs PASSED (6/6)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
