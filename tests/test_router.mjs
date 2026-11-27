import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildLiveCatalog,
  detectDirectNoTool,
  loadDomainsConfig,
  loadOrSyncCatalog,
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

  console.log('test_router.mjs PASSED (7/7)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
