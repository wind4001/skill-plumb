import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGate, runScaffold } from '../src/index.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-dfactory-test-with spaces-'));
try {
  const skillsOut = path.join(tmp, 'skills');
  fs.mkdirSync(skillsOut, { recursive: true });

  // 1. Dry-run scaffold does not write files
  const dryRes = runScaffold({
    name: 'dry-sample',
    domain: 'deploy',
    summary: 'Dry run sample skill.',
    outDir: skillsOut,
    skillsDirs: [skillsOut],
    noMcp: true,
    dryRun: true,
  });
  assert.equal(dryRes.exitCode, 0);
  assert.equal(dryRes.result.dry_run, true);
  assert.equal(fs.existsSync(path.join(skillsOut, 'dry-sample')), false);

  // 2. Scaffold D-Full skill -> portable <skill_dir>, no host absolute path, immediately passes gate
  const fullRes = runScaffold({
    name: 'nginx-502-triage',
    domain: 'deploy',
    summary: 'Diagnose Nginx upstream 502 timeouts and resolver cache stalls cleanly.',
    useWhen: 'investigating HTTP 502 Bad Gateway or upstream DNS failure in Nginx configs',
    notFor: 'building new Docker Compose deployment pipelines (use docker-web-deploy) or SSL cert renewal',
    mode: 'full',
    outDir: skillsOut,
    skillsDirs: [skillsOut],
    noMcp: true,
  });
  assert.equal(fullRes.exitCode, 0);
  assert.equal(fullRes.result.scaffolded, true);
  assert.equal(fullRes.result.files.length, 4);

  const skillDir = path.join(skillsOut, 'nginx-502-triage');
  const md = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(md, /^x-domain:\s*deploy$/m);
  assert.match(md, /<skill_dir>\/scripts\/probe_nginx_502_triage\.mjs/);
  assert.equal(/[A-Za-z]:[/\\]Users[/\\]/i.test(md), false, 'Scaffolded SKILL.md must not embed host paths');

  const gateOut = runGate({
    skillDir,
    skillsDirs: [skillsOut],
    noMcp: true,
    noSync: true,
  });
  assert.equal(gateOut.exitCode, 0, JSON.stringify(gateOut.result?.failures));
  assert.equal(gateOut.result.gate_passed, true);
  assert.equal(gateOut.result.routing_smoke.expected, 'deploy/nginx-502-triage');
  assert.equal(gateOut.result.routing_smoke.pass, true);
  assert.equal(gateOut.result.verify_results[0].status, 'PASS');

  // Verify scaffolded probe template emits calibration/scopes_skipped and never writes --out on exit 1
  const { execFileSync } = await import('node:child_process');
  const probeScript = path.join(skillDir, 'scripts', 'probe_nginx_502_triage.mjs');
  const nestedProbeOut = path.join(tmp, 'nested', 'probe-ok.json');
  const okProbeStdout = execFileSync('node', [probeScript, skillDir, '--out', nestedProbeOut], { encoding: 'utf8' });
  const probeJson = JSON.parse(okProbeStdout);
  assert.equal(probeJson.calibration.targets_checked, 1);
  assert.deepEqual(probeJson.scopes_skipped, []);
  assert.ok(fs.existsSync(nestedProbeOut));

  const badProbeOut = path.join(tmp, 'nested', 'should-not-exist.json');
  let badProbeStatus = 0;
  try {
    execFileSync('node', [probeScript, path.join(tmp, 'missing-target'), '--out', badProbeOut], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    badProbeStatus = e.status ?? 1;
    assert.equal(JSON.parse(e.stderr).exit_code, 1);
  }
  assert.equal(badProbeStatus, 1);
  assert.equal(fs.existsSync(badProbeOut), false, 'exit 1 must not write stray --out file');

  // 3. Overwrite blocked without --force, allowed with --force
  const conflictRes = runScaffold({
    name: 'nginx-502-triage',
    domain: 'deploy',
    summary: 'Duplicate',
    outDir: skillsOut,
    skillsDirs: [skillsOut],
    noMcp: true,
  });
  assert.equal(conflictRes.exitCode, 2);

  const forceRes = runScaffold({
    name: 'nginx-502-triage',
    domain: 'deploy',
    summary: 'Forced update.',
    useWhen: 'investigating HTTP 502 Bad Gateway',
    notFor: 'SSL renewal',
    mode: 'lite',
    outDir: skillsOut,
    skillsDirs: [skillsOut],
    noMcp: true,
    force: true,
  });
  assert.equal(forceRes.exitCode, 0);
  assert.equal(forceRes.result.mode, 'lite');

  // 4. Scaffold D-Lite & Ops-Only modes cleanly
  const liteRes = runScaffold({
    name: 'review-discipline',
    domain: 'audit_qa',
    summary: 'Concise code review discipline.',
    useWhen: 'performing peer code reviews',
    notFor: 'running static secret scanners',
    mode: 'lite',
    outDir: skillsOut,
    skillsDirs: [skillsOut],
    noMcp: true,
  });
  assert.equal(liteRes.exitCode, 0);
  const liteGate = runGate({
    skillDir: path.join(skillsOut, 'review-discipline'),
    skillsDirs: [skillsOut],
    noMcp: true,
    noSync: true,
  });
  assert.equal(liteGate.exitCode, 0);
  assert.equal(liteGate.result.mode, 'lite');

  const opsRes = runScaffold({
    name: 'ops-check',
    domain: 'repo',
    summary: 'Ops only script.',
    mode: 'ops',
    outDir: skillsOut,
    skillsDirs: [skillsOut],
    noMcp: true,
  });
  assert.equal(opsRes.exitCode, 0);
  assert.equal(opsRes.result.files.length, 2);

  // 5. Gate rejects bloated, missing-Not-for, broken-link, path-leaking skill & handles missing name cleanly
  const badDir = path.join(tmp, 'broken-skill');
  fs.mkdirSync(badDir);
  const filler = Array.from({ length: 165 }, (_, i) => `Line ${i}`).join('\n');
  const fakeUserPath = ['C:', 'Users', 'alice-dev', 'workspace', 'script.mjs'].join('/');
  fs.writeFileSync(
    path.join(badDir, 'SKILL.md'),
    `---\ndescription: "Generic helper without name"\n---\n\nRun \`${fakeUserPath}\`\nSee [missing](references/missing.md)\n${filler}\n`,
    'utf8'
  );
  const badGate = runGate({ skillDir: badDir, skipRouting: true, noMcp: true, noSync: true });
  assert.equal(badGate.exitCode, 2);
  assert.equal(typeof badGate.result.name, 'string', 'Fallback name must be a string, not a function');
  assert.equal(badGate.result.name, 'broken-skill');
  const failedGates = new Set(badGate.result.failures.map((f) => f.gate));
  assert.ok(failedGates.has('frontmatter'), 'Missing `name:` in YAML frontmatter must fail frontmatter gate');
  assert.ok(failedGates.has('frontmatter_boundary'));
  assert.ok(failedGates.has('thinness'));
  assert.ok(failedGates.has('links_hygiene'));

  // 6. Unclosed >35-line code fence fails thinness; ~~~ fence & inline code links ignored; file:// disallowed; ..foo allowed; VAR=/home/alice caught
  const fenceDir = path.join(tmp, 'fence-check');
  fs.mkdirSync(path.join(fenceDir, '..foo'), { recursive: true });
  fs.writeFileSync(path.join(fenceDir, '..foo', 'guide.md'), '# Double dot name\n');
  const unclosedFence = ['```bash', ...Array.from({ length: 40 }, (_, i) => `echo ${i}`)].join('\n');
  fs.writeFileSync(
    path.join(fenceDir, 'SKILL.md'),
    `---\nname: fence-check\nx-domain: repo\ndescription: "Check fences. Use when testing fences. Not for db checks."\n---\n\nInline \`[ex](references/inline-ignored.md)\` and valid [dotdot](..foo/guide.md)\n\n~~~\n[tilde](references/tilde-ignored.md)\n~~~\n\n${unclosedFence}\n`,
    'utf8'
  );
  const fenceGate = runGate({ skillDir: fenceDir, skipRouting: true, noMcp: true, noSync: true });
  assert.equal(fenceGate.exitCode, 2);
  const fenceGates = new Set(fenceGate.result.failures.map((f) => f.gate));
  assert.ok(fenceGates.has('thinness'), 'Unclosed >35-line fence must fail thinness');
  assert.equal(fenceGates.has('links_hygiene'), false, 'Links inside ~~~ / inline code and ..foo/ must not fail links_hygiene');

  // 7. Invalid gate --mode rejected (exit 1); file:// link and VAR=/home/bobdev/ flagged; relative scaffold outDir respects cwd & rejects bad domain
  assert.equal(runGate({ skillDir: fenceDir, mode: 'bogus' }).exitCode, 1);

  const leakDir = path.join(tmp, 'leak-check');
  fs.mkdirSync(leakDir);
  const eqPath = ['/home', 'bobdev', 'bin'].join('/');
  fs.writeFileSync(
    path.join(leakDir, 'SKILL.md'),
    `---\nname: leak-check\nx-domain: repo\ndescription: "Leak check. Use when checking leaks. Not for db checks."\n---\n\nVAR=${eqPath}/tool\n[bad](file:///etc/passwd)\n`,
    'utf8'
  );
  const leakGate = runGate({ skillDir: leakDir, skipRouting: true, noMcp: true, noSync: true });
  assert.equal(leakGate.exitCode, 2);
  assert.ok(leakGate.result.failures.some((f) => f.gate === 'links_hygiene' && /file:\/\//.test(f.reason)));
  assert.ok(leakGate.result.failures.some((f) => f.gate === 'links_hygiene' && /hardcoded user-profile/.test(f.reason)));

  assert.equal(runScaffold({ name: 'bad-dom', domain: 'bad domain!', summary: 'x' }).exitCode, 1);
  const cwdBase = path.join(tmp, 'cwd-base');
  fs.mkdirSync(cwdBase, { recursive: true });
  const cwdScaf = runScaffold({
    name: 'rel-skill',
    domain: 'repo',
    summary: 'Relative outDir test.',
    cwd: cwdBase,
    outDir: 'rel-skills',
    skillsDirs: [skillsOut],
    noMcp: true,
    dryRun: true,
  });
  assert.equal(cwdScaf.exitCode, 0);
  assert.equal(cwdScaf.result.target_dir, path.join(cwdBase, 'rel-skills', 'rel-skill').replace(/\\/g, '/'));

  console.log('test_dfactory.mjs PASSED (7/7)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
