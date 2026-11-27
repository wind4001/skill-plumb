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
  assert.ok(failedGates.has('frontmatter_boundary'));
  assert.ok(failedGates.has('thinness'));
  assert.ok(failedGates.has('links_hygiene'));

  console.log('test_dfactory.mjs PASSED (5/5)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
