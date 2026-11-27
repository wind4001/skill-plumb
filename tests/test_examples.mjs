import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

// 2. Pass skill-plumb gate on every example skill (verifying probes_checked >= 1 on every example!)
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
  assert.ok(
    res.result.probes_checked.length >= 1,
    `Example "${name}" must have >= 1 entry/probe script verified by Gate 4`
  );
}

// 3. Doctor reports all examples healthy
const doc = runDoctor({ skillsDirs: [EXAMPLES_DIR], noMcp: true });
assert.equal(doc.exitCode, 0, `Doctor failed on examples/: ${JSON.stringify(doc.result?.findings, null, 2)}`);

// 4. skill-creator probe_d_factory.mjs exits 1 without writing stray --out on missing target or invalid --cli
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ex-probe-'));
try {
  const strayOut = path.join(tmp, 'stray.json');
  let status = 0;
  try {
    execFileSync(
      'node',
      [path.join(EXAMPLES_DIR, 'skill-creator', 'scripts', 'probe_d_factory.mjs'), path.join(tmp, 'missing'), '--out', strayOut],
      { encoding: 'utf8', stdio: 'pipe' }
    );
  } catch (e) {
    status = e.status ?? 1;
  }
  assert.equal(status, 1);
  assert.equal(fs.existsSync(strayOut), false);

  let badCliStatus = 0;
  try {
    execFileSync(
      'node',
      [path.join(EXAMPLES_DIR, 'skill-creator', 'scripts', 'probe_d_factory.mjs'), EXAMPLES_DIR, '--cli', path.join(tmp, 'missing-cli.mjs')],
      { encoding: 'utf8', stdio: 'pipe' }
    );
  } catch (e) {
    badCliStatus = e.status ?? 1;
  }
  assert.equal(badCliStatus, 1);

  // 5. oss-eval standalone scripts handle --help (0) and reject bogus flags (1)
  for (const sc of ['audit_install.mjs', 'audit_network_deps.mjs']) {
    const sp = path.join(EXAMPLES_DIR, 'oss-eval', 'scripts', sc);
    const helpOut = execFileSync('node', [sp, '--help'], { encoding: 'utf8' });
    assert.match(helpOut, /Usage:/);
    let bogusStatus = 0;
    try {
      execFileSync('node', [sp, '--bogus-flag'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      bogusStatus = e.status ?? 1;
    }
    assert.equal(bogusStatus, 1);
  }

  // 6. pre-publish-audit preserves '#' inside quoted passwords & classifies verify_*.mjs as test fixtures
  const pwRepo = path.join(tmp, 'pw-repo');
  fs.mkdirSync(pwRepo, { recursive: true });
  fs.writeFileSync(path.join(pwRepo, 'docker-compose.yml'), 'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: "admin#123"\n');
  const { run: runPathsPorts } = await import('../examples/pre-publish-audit/scripts/audit_paths_ports.mjs');
  const pwRes = await runPathsPorts({ target: pwRepo });
  assert.ok(pwRes.facts.findings.some((f) => f.kind === 'default_password_in_config'));

  const { run: runAuditAll } = await import('../examples/pre-publish-audit/scripts/audit_all.mjs');
  const selfAudit = await runAuditAll({ target: ROOT, noHistory: true });
  assert.equal(selfAudit.facts.secrets.findings_count, 0, `Working tree secrets should be 0: ${JSON.stringify(selfAudit.facts.secrets.findings)}`);
  assert.equal(selfAudit.facts.links.findings_count, 0);
  const nonTestPathFindings = selfAudit.facts.paths_ports.findings.filter((f) => !f.is_test_or_fixture);
  assert.equal(nonTestPathFindings.length, 0, `Unexpected prod path findings: ${JSON.stringify(nonTestPathFindings)}`);

  // 7. Windows 8.3 short-path regression check (RUNNER~1 vs runneradmin)
  if (process.platform === 'win32') {
    const longRepo = path.join(tmp, 'runneradmin_shortpath_test');
    fs.mkdirSync(path.join(longRepo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(longRepo, 'README.md'), '# Short Path Test\n', 'utf8');
    fs.writeFileSync(path.join(longRepo, 'docs', 'guide.md'), '# Guide\n\nSee [Root](../README.md).\n', 'utf8');
    execFileSync('git', ['init', '-q'], { cwd: longRepo });
    execFileSync('git', ['config', '--local', 'user.name', 'Test User'], { cwd: longRepo });
    execFileSync('git', ['config', '--local', 'user.email', '12345+test@users.noreply.github.com'], { cwd: longRepo });
    execFileSync('git', ['add', '-A'], { cwd: longRepo });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: longRepo });
    fs.writeFileSync(path.join(longRepo, '.env'), 'FOO=bar\n', 'utf8');

    const psRes = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${longRepo.replace(/'/g, "''")}').ShortPath`],
      { encoding: 'utf8' }
    );
    const shortRepo = (psRes.stdout || '').trim();
    if (psRes.status === 0 && shortRepo && shortRepo.includes('~') && shortRepo.toLowerCase() !== longRepo.toLowerCase()) {
      const shortAudit = await runAuditAll({ target: shortRepo, noHistory: true });
      assert.equal(shortAudit.facts.git.is_subdir, false, '8.3 short path should match repo_root');
      assert.equal(shortAudit.facts.links.findings_count, 0, `8.3 short path links should pass: ${JSON.stringify(shortAudit.facts.links.findings)}`);
      assert.ok(
        shortAudit.facts.secrets.findings.some((f) => f.kind === 'untracked_unignored_sensitive_file' && f.file === '.env'),
        '8.3 short path should catch untracked .env'
      );
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('test_examples.mjs PASSED (4 examples verified + probes gated + doctor clean)');
