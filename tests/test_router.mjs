import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildLiveCatalog,
  detectDirectNoTool,
  execSafe,
  extractRoutingClauses,
  loadDomainsConfig,
  loadOrSyncCatalog,
  parseDescription,
  runInspect,
  scoreTwoStage,
  syncLiveCatalog,
} from '../src/index.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-router-test-with spaces-'));
try {
  const skillsDir = path.join(tmp, 'skills');
  const skillsDir2 = path.join(tmp, 'skills-extra');
  const ovrFile = path.join(tmp, 'router_overrides.json');
  const catFile = path.join(tmp, 'live_catalog.json');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(skillsDir2, { recursive: true });
  fs.writeFileSync(ovrFile, JSON.stringify({ _doc: 'test', overrides: {} }, null, 2));

  const common = {
    skillsDirs: [skillsDir],
    noMcp: true,
    overridesPath: ovrFile,
    outFile: catFile,
  };

  // 1. Initial skill triggers auto_synced: true, then cached auto_synced: false
  fs.mkdirSync(path.join(skillsDir, 'deploy-helper'), { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, 'deploy-helper', 'SKILL.md'),
    '---\nname: deploy-helper\nx-domain: deploy\ndescription: "Deploy compose services. Use when deploying compose apps. Not for DB migrations."\n---\n# Helper\n'
  );
  const firstLoad = loadOrSyncCatalog(common);
  assert.equal(firstLoad.auto_synced, true);
  assert.equal(firstLoad.catalog.length, 1);

  const secondLoad = loadOrSyncCatalog(common);
  assert.equal(secondLoad.auto_synced, false);

  // 2. Drop new skill with x-domain: db without calling sync -> auto-refreshes
  fs.mkdirSync(path.join(skillsDir, 'pg-schema-audit'), { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, 'pg-schema-audit', 'SKILL.md'),
    '---\nname: pg-schema-audit\nx-domain: db\ndescription: "Audit Postgres permissions. Use when checking database grants and schema foreign keys. Not for Docker deploy."\n---\n# PG\n'
  );
  const thirdLoad = loadOrSyncCatalog(common);
  assert.equal(thirdLoad.auto_synced, true);
  assert.equal(thirdLoad.catalog.length, 2);

  const insDb = runInspect('checking pg-schema-audit database grants', common);
  assert.equal(insDb.exitCode, 0);
  assert.equal(insDb.result.auto_synced, false);
  assert.equal(insDb.result.predicted, 'db/pg-schema-audit');

  // 3. Direct-no-tool abstention (English + Chinese)
  assert.equal(detectDirectNoTool('fix typo in README.md').isDirect, true);
  assert.equal(detectDirectNoTool('check git status').isDirect, true);
  assert.equal(detectDirectNoTool('把 README.md 第一行标题里的 Draft 删掉').isDirect, true);
  assert.equal(detectDirectNoTool('audit .env against .env.example before deploy').isDirect, false);

  // 4. Crowded missing Not-for triggers sync warning & inspect ambiguity; overrides fix without editing SKILL.md
  const extDir = path.join(tmp, 'ext-skills');
  const extOvr = path.join(tmp, 'ext_overrides.json');
  const extCat = path.join(tmp, 'ext_catalog.json');
  const extOpts = { skillsDirs: [extDir], noMcp: true, overridesPath: extOvr, outFile: extCat };
  fs.mkdirSync(path.join(extDir, 'pg-helper-a'), { recursive: true });
  fs.mkdirSync(path.join(extDir, 'pg-helper-b'), { recursive: true });
  fs.writeFileSync(extOvr, JSON.stringify({ _doc: 'ext', overrides: {} }, null, 2));

  const pathA = path.join(extDir, 'pg-helper-a', 'SKILL.md');
  const pathB = path.join(extDir, 'pg-helper-b', 'SKILL.md');
  fs.writeFileSync(
    pathA,
    '---\nname: pg-helper-a\nx-domain: db\ndescription: "PostgreSQL schema foreign key index check tool. Use when tuning database indexes."\n---\n# A\n'
  );
  fs.writeFileSync(
    pathB,
    '---\nname: pg-helper-b\nx-domain: db\ndescription: "PostgreSQL query slow runtime index check tool. Use when tuning database queries."\n---\n# B\n'
  );
  const hashA = crypto.createHash('sha256').update(fs.readFileSync(pathA)).digest('hex');
  const hashB = crypto.createHash('sha256').update(fs.readFileSync(pathB)).digest('hex');

  const extSync = syncLiveCatalog(extOpts);
  assert.equal(extSync.summary.missing_not_for_count, 2);
  assert.equal(extSync.summary.crowded_missing_not_for.length, 2);
  assert.ok(extSync.summary.crowded_missing_not_for[0].suggested_override.not_for.length >= 1);

  const ambig = runInspect('PostgreSQL database tuning index check', extOpts);
  assert.equal(ambig.result.ambiguous, true);
  assert.equal(ambig.result.missing_not_for_warning, true);
  assert.equal(ambig.result.recommended_action, 'llm_disambiguate_top_candidates');
  assert.ok(ambig.result.candidates.length >= 2);

  // Zero-invasion overrides resolve ambiguity without altering SKILL.md bytes
  fs.writeFileSync(extOvr, JSON.stringify({
    _doc: 'resolved',
    overrides: {
      'pg-helper-a': {
        domain: 'db',
        aka: ['schema foreign key index check'],
        not_for: ['slow query runtime tuning'],
      },
      'pg-helper-b': {
        domain: 'db',
        aka: ['slow query runtime tuning'],
        not_for: ['schema foreign key index check'],
      },
    },
  }, null, 2));

  const resolved = runInspect('PostgreSQL schema foreign key index check', extOpts);
  assert.equal(resolved.result.auto_synced, true);
  assert.equal(resolved.result.predicted, 'db/pg-helper-a');
  assert.equal(resolved.result.ambiguous, false);
  assert.equal(resolved.result.missing_not_for_warning, false);

  const cleanSync = syncLiveCatalog(extOpts);
  assert.equal(cleanSync.summary.missing_not_for_count, 0);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(pathA)).digest('hex'), hashA);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(pathB)).digest('hex'), hashB);

  // 5. Non-array not_for emits explicit warning instead of silent drop
  const warnOvr = path.join(tmp, 'warn_overrides.json');
  fs.writeFileSync(warnOvr, JSON.stringify({
    overrides: {
      'pg-helper-a': {
        domain: 'db',
        not_for: 'slow query runtime tuning',
      },
    },
  }, null, 2));
  const warnSync = syncLiveCatalog({ ...extOpts, overridesPath: warnOvr });
  assert.ok(warnSync.summary.override_warnings.length >= 1);
  assert.equal(warnSync.summary.override_warnings[0].field, 'not_for');

  // 6. Sibling brand-token self-penalty protection
  const siblingCatalog = [
    {
      id: 'meta_collab/codex-cli-calling',
      name: 'codex-cli-calling',
      domain: 'meta_collab',
      kind: 'skill',
      purpose: 'Invoke Codex CLI non-interactively via codex exec for CI scripts.',
      use_when: 'running single-shot codex exec CLI commands or CI automation',
      not_for: ['multi-phase collaborative review loops (use codex-collab)'],
      aka: ['codex exec', 'headless codex'],
      entry: 'skill:codex-cli-calling',
    },
    {
      id: 'meta_collab/codex-collab',
      name: 'codex-collab',
      domain: 'meta_collab',
      kind: 'skill',
      purpose: 'Multi-phase dual-agent planning and adversarial review loops with Codex.',
      use_when: 'multi-phase Codex review and adversarial iteration',
      not_for: ['single-shot non-interactive codex exec snippets (use codex-cli-calling)'],
      aka: ['codex collaboration'],
      entry: 'skill:codex-collab',
    },
  ];
  const sibRes = scoreTwoStage(siblingCatalog, 'codex exec single-shot CI script');
  assert.equal(sibRes.predicted, 'meta_collab/codex-cli-calling');
  assert.equal(sibRes.top_k[0].penalized.length, 0, 'Self brand token must not self-penalize');

  // 7. Custom domains.json support + multi-dir deduplication
  const customDomainsFile = path.join(tmp, 'domains.json');
  fs.writeFileSync(customDomainsFile, JSON.stringify({
    domains: {
      ml_ops: {
        brief: 'Machine learning training and GPU pipelines',
        priors: 'pytorch cuda lora training dataset',
        namePatterns: ['^ml-'],
        textPatterns: ['\\b(?:pytorch|cuda|lora)\\b'],
      },
    },
  }, null, 2));
  fs.mkdirSync(path.join(skillsDir2, 'ml-lora-tune'), { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir2, 'ml-lora-tune', 'SKILL.md'),
    '---\nname: ml-lora-tune\ndescription: "Fine-tune LoRA weights on PyTorch. Use when training LoRA adapters. Not for SQL queries."\n---\n# ML\n'
  );
  // Duplicate skill name in second dir should deduplicate to first dir
  fs.mkdirSync(path.join(skillsDir2, 'deploy-helper'), { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir2, 'deploy-helper', 'SKILL.md'),
    '---\nname: deploy-helper\nx-domain: deploy\ndescription: "Duplicate"\n---\n'
  );
  const domCfg = loadDomainsConfig(customDomainsFile, tmp);
  assert.equal(domCfg.ok, true);
  const multiCat = buildLiveCatalog({
    skillsDirs: [skillsDir, skillsDir2],
    noMcp: true,
    domainsPath: customDomainsFile,
    overridesPath: ovrFile,
  });
  assert.equal(multiCat.length, 3);
  const mlItem = multiCat.find((x) => x.name === 'ml-lora-tune');
  assert.equal(mlItem?.domain, 'ml_ops');

  // 8. Custom domain priority beats built-in domains when both match
  const prioDomFile = path.join(tmp, 'prio_domains.json');
  fs.writeFileSync(prioDomFile, JSON.stringify({
    domains: {
      ml_sec: {
        brief: 'ML security & model adversarial defense',
        priors: 'pytorch adversarial security',
        namePatterns: ['^ml-'],
        textPatterns: ['\\badversarial\\b'],
      },
    },
  }, null, 2));
  const prioSkills = path.join(tmp, 'prio-skills');
  fs.mkdirSync(path.join(prioSkills, 'ml-guard'), { recursive: true });
  fs.writeFileSync(
    path.join(prioSkills, 'ml-guard', 'SKILL.md'),
    '---\nname: ml-guard\ndescription: "Adversarial security check. Use when auditing security. Not for SQL."\n---\n# Guard\n'
  );
  const prioCat = buildLiveCatalog({ skillsDirs: [prioSkills], noMcp: true, domainsPath: prioDomFile });
  assert.equal(prioCat[0].domain, 'ml_sec');

  // 9. Invalid regex in domains.json returns { ok: false } instead of crashing
  const badDomFile = path.join(tmp, 'bad_domains.json');
  fs.writeFileSync(badDomFile, JSON.stringify({
    domains: { broken: { namePatterns: ['['] } },
  }, null, 2));
  const badDomRes = loadDomainsConfig(badDomFile, tmp);
  assert.equal(badDomRes.ok, false);
  assert.match(badDomRes.error, /Invalid regex/);

  // 10. Explicit nonexistent --mcp-cfg throws cleanly
  assert.throws(
    () => buildLiveCatalog({ skillsDirs: [skillsDir], mcpCfgPath: path.join(tmp, 'missing-mcp.json') }),
    /MCP config file not found/
  );

  // 11. UTF-8 BOM, multiline block scalar with blank line, plain continuation, Not-for before Use-when
  const bomSkillMd = '\uFEFF---\nname: bom-skill\nx-domain: db\ndescription: >-\n  Audit Postgres tables.\n\n  Not for Docker deploy.\n  Use when checking Postgres indexes.\n---\n';
  const parsedBomDesc = parseDescription(bomSkillMd);
  assert.match(parsedBomDesc, /Audit Postgres tables\./);
  assert.match(parsedBomDesc, /Use when checking Postgres indexes\./);
  const bomDir = path.join(tmp, 'bom-skills');
  fs.mkdirSync(path.join(bomDir, 'bom-skill'), { recursive: true });
  fs.writeFileSync(path.join(bomDir, 'bom-skill', 'SKILL.md'), bomSkillMd);
  const bomCat = buildLiveCatalog({ skillsDirs: [bomDir], noMcp: true });
  assert.equal(bomCat[0].domain, 'db');
  assert.match(bomCat[0].use_when, /checking Postgres indexes/);
  assert.deepEqual(bomCat[0].not_for, ['Docker deploy']);

  const plainMultiline = '---\nname: plain-ml\ndescription: First line\n  second line continuation.\n---\n';
  assert.equal(parseDescription(plainMultiline), 'First line second line continuation.');

  // 12. Fingerprint tracks scripts/probe_*.mjs additions & recovers corrupt cache JSON
  const fpCatFile = path.join(tmp, 'fp_cat.json');
  const fpOpts = { skillsDirs: [bomDir], noMcp: true, outFile: fpCatFile };
  const fp1 = loadOrSyncCatalog(fpOpts);
  assert.equal(fp1.auto_synced, true);
  fs.mkdirSync(path.join(bomDir, 'bom-skill', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(bomDir, 'bom-skill', 'scripts', 'probe_bom_skill.mjs'), '// probe\n');
  const fp2 = loadOrSyncCatalog(fpOpts);
  assert.equal(fp2.auto_synced, true);
  assert.match(fp2.catalog[0].entry, /probe_bom_skill\.mjs/);

  fs.writeFileSync(fpCatFile, '{corrupt json', 'utf8');
  const fp3 = loadOrSyncCatalog(fpOpts);
  assert.equal(fp3.auto_synced, true);
  assert.equal(fp3.catalog.length, 1);

  // 13. inspect --domain validation, NONE non-ambiguous, and tightened simpleReadOrStatus guard
  const badDomInspect = runInspect('anything', { ...fpOpts, domain: 'nonexistent-domain' });
  assert.equal(badDomInspect.exitCode, 1);
  const explicitDomInspect = runInspect('just read postgres indexes', { ...fpOpts, domain: 'db' });
  assert.equal(explicitDomInspect.exitCode, 0);
  assert.equal(explicitDomInspect.result.direct_no_tool, false);
  assert.equal(explicitDomInspect.result.predicted, 'db/bom-skill');

  assert.equal(detectDirectNoTool('check git log for bot commits').isDirect, false);
  assert.equal(detectDirectNoTool('check package.json lifecycle scripts').isDirect, false);

  const lowScorePair = [
    { id: 'db/a', name: 'a', domain: 'db', kind: 'skill', purpose: 'alpha', use_when: 'alpha', not_for: [], aka: [], entry: 'skill:a' },
    { id: 'db/b', name: 'b', domain: 'db', kind: 'skill', purpose: 'beta', use_when: 'beta', not_for: [], aka: [], entry: 'skill:b' },
  ];
  const lowIns = scoreTwoStage(lowScorePair, 'completely unrelated zzz');
  assert.equal(lowIns.predicted, 'NONE');

  // 14. Windows execSafe handles spaces in BOTH .cmd path and arguments
  if (process.platform === 'win32') {
    const cmdDir = path.join(tmp, 'bin with spaces');
    fs.mkdirSync(cmdDir, { recursive: true });
    const cmdFile = path.join(cmdDir, 'my tool.cmd');
    fs.writeFileSync(cmdFile, '@echo off\r\necho %~1^|%~2\r\n', 'utf8');
    const cmdOut = execSafe(cmdFile, ['hello world', 'second arg'], { encoding: 'utf8' }).trim();
    assert.equal(cmdOut, 'hello world|second arg');
  }

  // 15. General-domain Chinese queries, topDomScore===0 -> NONE, CJK+ASCII compound matching, bare git status, Use immediately before, unknown override domain
  const genSkillsDir = path.join(tmp, 'gen-skills');
  fs.mkdirSync(path.join(genSkillsDir, 'photo-fix'), { recursive: true });
  fs.mkdirSync(path.join(genSkillsDir, 'story-deslop'), { recursive: true });
  fs.mkdirSync(path.join(genSkillsDir, 'story-long-write'), { recursive: true });
  fs.mkdirSync(path.join(genSkillsDir, 'quality-gate'), { recursive: true });
  fs.writeFileSync(path.join(genSkillsDir, 'photo-fix', 'SKILL.md'), '---\nname: photo-fix\nx-domain: web_media\ndescription: "Retouch photos. Use when editing photo lighting. Not for novel writing."\n---\n');
  fs.writeFileSync(path.join(genSkillsDir, 'story-deslop', 'SKILL.md'), '---\nname: story-deslop\ndescription: "小说正文去AI味润色。Use when 「帮这章去AI味」「网文去AI味润色」。Not for 制定长篇全局写作纪律。"\n---\n');
  fs.writeFileSync(path.join(genSkillsDir, 'story-long-write', 'SKILL.md'), '---\nname: story-long-write\ndescription: "长篇网文规划与连载写作。Use when 「我想写小说」「帮我开书」「出卷纲」。Not for 短篇小说创作。"\n---\n');
  fs.writeFileSync(path.join(genSkillsDir, 'quality-gate', 'SKILL.md'), '---\nname: quality-gate\nx-domain: meta_collab\ndescription: "长篇全局质量闸门。Use when 制定长篇写作纪律或质量体系，不用于单章已成稿做三层表达式去 AI 味润色（use story-deslop）。"\n---\n');

  const genOvrPath = path.join(tmp, 'gen-overrides.json');
  fs.writeFileSync(genOvrPath, JSON.stringify({
    overrides: {
      'photo-fix': { domain: 'web_media', aka: ['修照片'] },
      'bogus-entry': { domain: 'no_such_domain' },
    },
  }, null, 2));

  const genCat = buildLiveCatalog({ skillsDirs: [genSkillsDir], noMcp: true, overridesPath: genOvrPath });
  assert.ok(buildLiveCatalog.lastMeta.overrideWarnings.some((w) => w.field === 'domain' && /no_such_domain/.test(w.message)));

  const novelRes = scoreTwoStage(genCat, '我想写小说');
  assert.equal(novelRes.predicted, 'general/story-long-write');
  const deslopRes = scoreTwoStage(genCat, '帮这章去AI味');
  assert.equal(deslopRes.predicted, 'general/story-deslop');
  const unrelatedRes = scoreTwoStage(genCat, 'totally_unrelated_quantum_foobar');
  assert.equal(unrelatedRes.predicted, 'NONE');
  assert.deepEqual(unrelatedRes.stage1_domains, []);

  assert.equal(detectDirectNoTool('git status').isDirect, true);
  assert.equal(detectDirectNoTool('git status --short').isDirect, true);
  assert.equal(detectDirectNoTool('git status audit secrets').isDirect, false);

  const immClauses = extractRoutingClauses('Verify evidence. Use immediately before any completion claim, commit, or PR，不用于 early exploration.');
  assert.equal(immClauses.hasUseWhen, true);
  assert.equal(immClauses.hasNotFor, true);
  assert.match(immClauses.notFor[0], /early exploration/);

  console.log('test_router.mjs PASSED (15/15)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
