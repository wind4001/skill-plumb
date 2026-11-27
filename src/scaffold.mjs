/**
 * SkillPlumb Scaffolding Engine (`src/scaffold.mjs`).
 * Queries existing catalog neighbors, suggests `Not for` exclusions, and generates
 * portable D-Full, D-Lite, or Ops-Only skeletons from `templates/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLiveCatalog } from './catalog.mjs';
import { DEFAULT_DOMAINS, loadDomainsConfig } from './domains.mjs';
import { scoreTwoStage } from './scorer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(HERE, '..', 'templates');

function render(tmplName, vars) {
  let txt = fs.readFileSync(path.join(TEMPLATES_DIR, tmplName), 'utf8');
  for (const [k, v] of Object.entries(vars)) {
    txt = txt.replaceAll(`{{${k}}}`, v);
  }
  return txt;
}

export function runScaffold(opts = {}) {
  const mode = opts.mode || 'full';
  if (!opts.name || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(opts.name)) {
    return { exitCode: 1, error: 'Provide lowercase kebab-case --name <slug> (2-61 chars, a-z0-9-)' };
  }
  if (!['full', 'lite', 'ops'].includes(mode)) {
    return { exitCode: 1, error: `--mode must be full | lite | ops (got ${mode})` };
  }
  if (!opts.domain || !/^[a-z0-9][a-z0-9_-]{0,60}$/i.test(opts.domain)) {
    return { exitCode: 1, error: 'Provide valid --domain <slug> (a-z0-9_-)' };
  }
  if (!opts.summary) {
    return { exitCode: 1, error: 'Both --domain and --summary are required' };
  }

  let catalog = [];
  let domainsMap = DEFAULT_DOMAINS;
  try {
    const domRes = loadDomainsConfig(opts.domainsPath || null, opts.cwd || process.cwd());
    if (!domRes.ok) return { exitCode: 1, error: domRes.error };
    domainsMap = domRes.domains;
    catalog = buildLiveCatalog({
      cwd: opts.cwd,
      skillsDirs: opts.skillsDirs,
      skillsDir: opts.skillsDir,
      allowMissingSkillsDir: true,
      mcpCfgPath: opts.mcpCfgPath,
      noMcp: opts.noMcp,
      overridesPath: opts.overridesPath,
      domainsPath: opts.domainsPath,
    });
  } catch (err) {
    return { exitCode: 1, error: err.message };
  }

  const sameName = catalog.find((x) => x.name === opts.name);
  const domNeighbors = catalog.filter((x) => x.domain === opts.domain && x.name !== opts.name);
  const queryRes = scoreTwoStage(
    catalog,
    `${opts.name} ${opts.summary} ${opts.useWhen || ''}`,
    { limit: 3, ignoreDirectGuard: true, domains: domainsMap }
  );
  const nearest = (queryRes.top_k || []).slice(0, 3).map((x) => ({
    id: x.id,
    score: x.score,
    use_when: String(x.use_when || '').slice(0, 80),
  }));

  const suggestedNotFor = opts.notFor
    || (nearest.length > 0
      ? nearest.map((n) => `${n.use_when.split(/[，,.;]/)[0]} (use ${n.id.split('/')[1]})`).join('; ')
      : 'unrelated single-file literal edits or tasks covered by dedicated sibling skills');

  const scriptStem = opts.name.replace(/-/g, '_');
  const cwd = opts.cwd || process.cwd();
  const outRoot = opts.outDir || path.join(cwd, '.agents', 'skills');
  const targetDir = path.resolve(cwd, outRoot, opts.name);
  const absPosix = targetDir.replace(/\\/g, '/');

  if (!opts.dryRun && fs.existsSync(targetDir) && !opts.force) {
    return {
      exitCode: 2,
      result: {
        scaffolded: false,
        exit_code: 2,
        exit_meaning: 'target_exists_use_force_or_edit_owner',
        existing_dir: absPosix,
        existing_catalog_owner: sameName || null,
        nearest_neighbors: nearest,
        domain_neighbors_count: domNeighbors.length,
        suggested_not_for: suggestedNotFor,
      },
    };
  }

  const vars = {
    SLUG: opts.name,
    DOMAIN: opts.domain,
    TITLE: opts.name,
    SCRIPT_STEM: scriptStem,
    SKILL_REF_DIR: '<skill_dir>',
    SUMMARY: opts.summary.replace(/\s+/g, ' ').trim(),
    USE_WHEN: (opts.useWhen || opts.summary).replace(/\s+/g, ' ').trim(),
    NOT_FOR: suggestedNotFor.replace(/\s+/g, ' ').trim(),
  };

  const planned = [];
  if (mode === 'full') {
    planned.push({ rel: 'SKILL.md', content: render('d-full-skill.md.tmpl', vars) });
    planned.push({ rel: `scripts/probe_${scriptStem}.mjs`, content: render('probe-script.mjs.tmpl', vars) });
    planned.push({ rel: `verify_${scriptStem}.mjs`, content: render('verify-script.mjs.tmpl', vars) });
    planned.push({
      rel: 'references/guide.md',
      content: `# ${opts.name} Detailed Reference\n\nPlace deep methodology, edge-case tables, and platform recipes here for on-demand loading.\n`,
    });
  } else if (mode === 'lite') {
    planned.push({ rel: 'SKILL.md', content: render('d-lite-skill.md.tmpl', vars) });
    planned.push({
      rel: 'references/guide.md',
      content: `# ${opts.name} Full Rules & Examples\n`,
    });
  } else {
    planned.push({ rel: `scripts/probe_${scriptStem}.mjs`, content: render('probe-script.mjs.tmpl', vars) });
    planned.push({ rel: `verify_${scriptStem}.mjs`, content: render('verify-script.mjs.tmpl', vars) });
  }

  if (!opts.dryRun) {
    for (const f of planned) {
      const full = path.join(targetDir, f.rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content, 'utf8');
    }
  }

  return {
    exitCode: 0,
    result: {
      scaffolded: !opts.dryRun,
      dry_run: Boolean(opts.dryRun),
      mode,
      target_dir: absPosix,
      files: planned.map((f) => f.rel),
      existing_catalog_owner: sameName ? sameName.id : null,
      domain_neighbors_count: domNeighbors.length,
      nearest_neighbors: nearest,
      applied_not_for: vars.NOT_FOR,
    },
  };
}
