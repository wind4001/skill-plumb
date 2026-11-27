/**
 * Live skill & MCP catalog builder, source-fingerprinted auto-sync, and crowded-domain analyzer.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_DOMAINS,
  inferDomain,
  loadDomainsConfig,
  parseFrontmatterDomain,
} from './domains.mjs';
import {
  collectSkillEntries,
  defaultCachePath,
  discoverMcpConfig,
  discoverOverridesPath,
  discoverSkillDirs,
} from './discovery.mjs';
import { loadOverrides } from './overrides.mjs';
import { detectDirectNoTool, scoreTwoStage } from './scorer.mjs';

const GENERIC_MCP_META = {
  markitdown: {
    domain: 'docs_io',
    purpose: 'Convert PDF, Office documents, and HTML to Markdown',
    use_when: 'converting local PDF or Office documents to Markdown',
    not_for: ['fetching live third-party library docs (use context7)', 'querying code call graphs'],
  },
  playwright: {
    domain: 'web_media',
    purpose: 'Headless browser automation, DOM inspection, and screenshots via Playwright MCP',
    use_when: 'automating or inspecting a live headless browser page',
    not_for: ['reusing an existing logged-in Chrome CDP session'],
  },
  codegraph: {
    domain: 'code_graph',
    purpose: 'Semantic code call graph queries (callers, callees, impact)',
    use_when: 'querying exact function callers, callees, or change impact',
    not_for: ['whole-repo cross-modal knowledge graphs', 'converting PDFs to Markdown'],
  },
  context7: {
    domain: 'docs_io',
    purpose: 'Fetch up-to-date official documentation and examples for external libraries',
    use_when: 'looking up current external library/SDK API documentation',
    not_for: ['converting local PDF or Office files'],
  },
  github: {
    domain: 'repo',
    purpose: 'Interact with GitHub repositories, issues, and pull requests via MCP',
    use_when: 'managing GitHub issues, PRs, or remote repo metadata',
    not_for: ['local pre-publish secret/path audits'],
  },
  postgres: {
    domain: 'db',
    purpose: 'Inspect PostgreSQL schemas and run read-only SQL diagnostics via MCP',
    use_when: 'inspecting live PostgreSQL tables or query plans',
    not_for: ['Docker compose deployment pipelines'],
  },
};

export function parseFrontmatter(raw) {
  const fm = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return { ok: false, name: null, description: '', domain: null, body: '' };
  const body = fm[1];
  const nameMatch = body.match(/^name\s*:\s*["']?([^\r\n"']+)/m);
  const description = parseDescription(raw);
  const domain = parseFrontmatterDomain(raw);
  return {
    ok: true,
    name: nameMatch ? nameMatch[1].trim() : null,
    description,
    domain,
    body,
  };
}

export function parseDescription(raw) {
  const fm = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return '';
  const body = fm[1];
  const mBlock = body.match(/description:\s*[>|]-?\r?\n((?:[ \t]+.*\r?\n?)*)/);
  const mQuoted = body.match(/description:\s*"((?:[^"\\]|\\.)*)"/);
  const mSingleQ = body.match(/description:\s*'((?:[^'\\]|\\.)*)'/);
  const mSingle = body.match(/description:\s*([^\r\n]+)/);
  if (mQuoted) {
    try { return JSON.parse('"' + mQuoted[1] + '"').trim(); } catch { return mQuoted[1].trim(); }
  }
  if (mBlock) return mBlock[1].replace(/^[ \t]+/gm, '').replace(/\r?\n/g, ' ').trim();
  if (mSingleQ) return mSingleQ[1].trim();
  if (mSingle) return mSingle[1].trim();
  return '';
}

function detectEntry(skillDir, name) {
  const preferred = [
    'scripts/eval_all.mjs',
    'scripts/audit_all.mjs',
  ];
  for (const rel of preferred) {
    if (fs.existsSync(path.join(skillDir, rel))) {
      return `node ${path.join(skillDir, rel).replace(/\\/g, '/')}`;
    }
  }
  const scriptsDir = path.join(skillDir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    const probes = fs.readdirSync(scriptsDir).filter((f) => /^(?:probe|preflight)_.*\.mjs$/i.test(f)).sort();
    if (probes.length > 0) {
      return `node ${path.join(scriptsDir, probes[0]).replace(/\\/g, '/')}`;
    }
  }
  return `skill:${name}`;
}

export function resolveCatalogContext(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const explicitSkills = Array.isArray(opts.skillsDirs) && opts.skillsDirs.length > 0
    ? opts.skillsDirs
    : (opts.skillsDir ? [opts.skillsDir] : null);
  const skillDirs = discoverSkillDirs({ skillsDirs: explicitSkills, cwd });
  const mcpCfgPath = discoverMcpConfig({ mcpCfgPath: opts.mcpCfgPath, noMcp: opts.noMcp, cwd });
  const overridesPath = discoverOverridesPath({ overridesPath: opts.overridesPath, cwd });
  const domainsRes = loadDomainsConfig(opts.domainsPath || null, cwd);
  const overridesRes = loadOverrides(overridesPath, { explicit: Boolean(opts.overridesPath) });
  const outFile = opts.outFile || defaultCachePath();

  return {
    cwd,
    skillDirs,
    mcpCfgPath,
    overridesPath,
    outFile,
    domainsRes,
    overridesRes,
  };
}

export function buildLiveCatalog(opts = {}) {
  const ctx = resolveCatalogContext(opts);
  if (!ctx.domainsRes.ok) {
    throw new Error(ctx.domainsRes.error);
  }
  if (!ctx.overridesRes.ok) {
    throw new Error(ctx.overridesRes.error);
  }

  const domainsMap = ctx.domainsRes.domains || DEFAULT_DOMAINS;
  const overrides = ctx.overridesRes.overrides || {};
  const entries = [];
  const skillEntries = collectSkillEntries(ctx.skillDirs);

  for (const sk of skillEntries) {
    const raw = fs.readFileSync(sk.mdPath, 'utf8');
    const desc = parseDescription(raw);
    const notForMatch = desc.match(/(?:Not for|不用于|Don't use for|不适用于)[：:\s]*(.+)$/i);
    const beforeNotFor = notForMatch ? desc.slice(0, notForMatch.index).trim() : desc;
    const useWhenMatch = beforeNotFor.match(/(?:Use when|MUST USE|触发(?:方式|词|场景)*|当用户)[：:\s]*([^。;\n]+)/i);
    const parsedNotFor = notForMatch
      ? notForMatch[1].split(/[.;。；]/).map((s) => s.trim()).filter((s) => s.length >= 3)
      : [];

    const ovr = overrides[sk.name] || {};
    const fmDomain = parseFrontmatterDomain(raw);
    const domain = ovr.domain || fmDomain || inferDomain(sk.name, beforeNotFor, domainsMap);
    const mergedNotFor = [...new Set([...parsedNotFor, ...(ovr.not_for || [])])];
    const mergedAka = [...new Set(ovr.aka || [])];

    const entryStr = detectEntry(sk.realDir, sk.name);
    const dirFiles = fs.readdirSync(sk.realDir);
    const verifyFile = dirFiles.find((f) => /^verify_.*\.(mjs|js)$/.test(f)) || null;
    const mdBytes = Buffer.byteLength(raw, 'utf8');

    entries.push({
      id: `${domain}/${sk.name}`,
      name: sk.name,
      domain,
      kind: 'skill',
      purpose: beforeNotFor.slice(0, 220),
      use_when: useWhenMatch ? useWhenMatch[1].trim() : beforeNotFor.slice(0, 160),
      not_for: mergedNotFor,
      aka: mergedAka,
      entry: entryStr,
      verify_script: verifyFile ? path.join(sk.realDir, verifyFile).replace(/\\/g, '/') : null,
      skill_md_bytes: mdBytes,
      source_dir: sk.realDir.replace(/\\/g, '/'),
    });
  }

  if (ctx.mcpCfgPath && fs.existsSync(ctx.mcpCfgPath)) {
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(ctx.mcpCfgPath, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid JSON in MCP config ${ctx.mcpCfgPath}: ${err.message}`);
    }
    for (const mName of Object.keys(cfg.mcpServers || {}).sort()) {
      const serverDef = cfg.mcpServers[mName] || {};
      const ovr = overrides[`mcp:${mName}`] || overrides[mName] || {};
      const fallback = GENERIC_MCP_META[mName];
      const serverDesc = typeof serverDef.description === 'string' ? serverDef.description.trim() : '';
      const domain = ovr.domain || fallback?.domain || inferDomain(mName, serverDesc, domainsMap);
      const purpose = serverDesc || fallback?.purpose || `MCP server ${mName}`;
      const useWhen = serverDesc || fallback?.use_when || mName;
      const notFor = [...new Set([...(fallback?.not_for || []), ...(ovr.not_for || [])])];
      const aka = [...new Set(ovr.aka || [])];

      entries.push({
        id: `${domain}/mcp-${mName}`,
        name: `mcp:${mName}`,
        domain,
        kind: 'mcp',
        purpose,
        use_when: useWhen,
        not_for: notFor,
        aka,
        entry: `mcp:${mName}`,
        verify_script: null,
        skill_md_bytes: null,
      });
    }
  }

  buildLiveCatalog.lastMeta = {
    skillDirs: ctx.skillDirs,
    mcpCfgPath: ctx.mcpCfgPath,
    overridesPath: ctx.overridesPath,
    domainsConfigPath: ctx.domainsRes.configPath,
    domains: domainsMap,
    overrideWarnings: ctx.overridesRes.warnings,
  };

  return entries;
}

export function computeSourceFingerprint(opts = {}) {
  const ctx = resolveCatalogContext(opts);
  const parts = [];
  const skillEntries = collectSkillEntries(ctx.skillDirs);
  for (const sk of skillEntries) {
    try {
      const st = fs.statSync(sk.mdPath);
      parts.push(`s:${sk.name}:${Math.trunc(st.mtimeMs)}:${st.size}`);
    } catch { /* ignore */ }
  }
  for (const [tag, p] of [['m', ctx.mcpCfgPath], ['o', ctx.overridesPath], ['d', ctx.domainsRes.configPath]]) {
    if (p && fs.existsSync(p)) {
      try {
        const st = fs.statSync(p);
        parts.push(`${tag}:${Math.trunc(st.mtimeMs)}:${st.size}`);
      } catch { /* ignore */ }
    }
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function metaPathFor(outFile) {
  const parsed = path.parse(path.resolve(outFile));
  return path.join(parsed.dir, `${parsed.name}.meta.json`);
}

export function buildCrowdedMissingNotFor(cat) {
  const byDom = new Map();
  for (const item of cat) {
    if (!byDom.has(item.domain)) byDom.set(item.domain, []);
    byDom.get(item.domain).push(item);
  }
  const out = [];
  for (const item of cat) {
    if (item.not_for && item.not_for.length > 0) continue;
    const peers = (byDom.get(item.domain) || []).filter((p) => p.name !== item.name);
    if (peers.length === 0) continue;
    const suggestedNotFor = peers.slice(0, 3).map((p) => {
      const snippet = String(p.use_when || p.purpose || p.name).split(/[，,.;。；]/)[0].trim();
      return `${snippet} (use ${p.name})`;
    });
    out.push({
      id: item.id,
      name: item.name,
      domain: item.domain,
      domain_count: peers.length + 1,
      suggested_override: {
        domain: item.domain,
        not_for: suggestedNotFor,
      },
    });
  }
  return out;
}

export function syncLiveCatalog(opts = {}) {
  const ctx = resolveCatalogContext(opts);
  const outFile = ctx.outFile;
  const metaFile = metaPathFor(outFile);

  const cat = buildLiveCatalog(opts);
  const metaInfo = buildLiveCatalog.lastMeta || {};
  const fingerprint = computeSourceFingerprint(opts);

  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(cat, null, 2) + '\n', 'utf8');
  fs.writeFileSync(metaFile, JSON.stringify({
    fingerprint,
    synced_at: new Date().toISOString(),
    total: cat.length,
    skill_dirs: ctx.skillDirs,
  }, null, 2) + '\n', 'utf8');

  const missingNotFor = cat.filter((x) => !x.not_for || x.not_for.length === 0).map((x) => x.id);
  const crowdedMissingNotFor = buildCrowdedMissingNotFor(cat);
  const verifiedCount = cat.filter((x) => x.verify_script).length;

  return {
    catalog: cat,
    domains: metaInfo.domains || DEFAULT_DOMAINS,
    summary: {
      synced: true,
      out: path.resolve(outFile),
      skill_dirs: ctx.skillDirs,
      mcp_cfg: ctx.mcpCfgPath,
      overrides_path: ctx.overridesPath,
      domains_config: ctx.domainsRes.configPath,
      override_warnings: metaInfo.overrideWarnings || [],
      fingerprint,
      total: cat.length,
      skills: cat.filter((x) => x.kind === 'skill').length,
      mcps: cat.filter((x) => x.kind === 'mcp').length,
      verified_d_skills: verifiedCount,
      missing_not_for_count: missingNotFor.length,
      missing_not_for: missingNotFor,
      crowded_missing_not_for: crowdedMissingNotFor,
    },
  };
}

export function loadOrSyncCatalog(opts = {}) {
  const ctx = resolveCatalogContext(opts);
  if (!ctx.domainsRes.ok) throw new Error(ctx.domainsRes.error);
  if (!ctx.overridesRes.ok) throw new Error(ctx.overridesRes.error);

  const outFile = ctx.outFile;
  const metaFile = metaPathFor(outFile);
  const currentFp = computeSourceFingerprint(opts);

  let cachedFp = null;
  if (fs.existsSync(metaFile) && fs.existsSync(outFile)) {
    try {
      cachedFp = JSON.parse(fs.readFileSync(metaFile, 'utf8')).fingerprint || null;
    } catch { cachedFp = null; }
  }

  if (cachedFp === currentFp && fs.existsSync(outFile)) {
    return {
      catalog: JSON.parse(fs.readFileSync(outFile, 'utf8')),
      domains: ctx.domainsRes.domains || DEFAULT_DOMAINS,
      override_warnings: ctx.overridesRes.warnings || [],
      auto_synced: false,
    };
  }

  const synced = syncLiveCatalog(opts);
  return {
    catalog: synced.catalog,
    domains: synced.domains,
    override_warnings: synced.summary.override_warnings || [],
    auto_synced: true,
    sync_summary: synced.summary,
  };
}

export function runBrief(opts = {}) {
  const { catalog: cat, domains, override_warnings, auto_synced } = loadOrSyncCatalog(opts);
  const byDom = new Map();
  for (const item of cat) {
    if (!byDom.has(item.domain)) byDom.set(item.domain, []);
    byDom.get(item.domain).push(item);
  }
  return {
    exitCode: 0,
    result: {
      auto_synced,
      total_entries: cat.length,
      domain_count: byDom.size,
      override_warnings,
      direct_action_rule: 'Simple literal edits, targeted file reads, or running git/test commands do NOT require inspect or external skills.',
      domains: [...byDom.entries()].map(([domain, items]) => ({
        domain,
        count: items.length,
        brief: domains[domain]?.brief || domain,
      })),
    },
  };
}

export function runList(domain, opts = {}) {
  const { catalog: cat, override_warnings, auto_synced } = loadOrSyncCatalog(opts);
  const byDom = new Map();
  for (const item of cat) {
    if (!byDom.has(item.domain)) byDom.set(item.domain, []);
    byDom.get(item.domain).push(item);
  }
  if (!domain || !byDom.has(domain)) {
    return {
      exitCode: 1,
      error: `Unknown domain "${domain || ''}". Valid: ${[...byDom.keys()].join(', ') || '(none)'}`,
    };
  }
  return {
    exitCode: 0,
    result: {
      auto_synced,
      domain,
      count: byDom.get(domain).length,
      override_warnings,
      items: byDom.get(domain).map((x) => ({
        id: x.id,
        use_when: String(x.use_when || '').slice(0, 95),
        not_for: (x.not_for || []).slice(0, 2),
        entry: x.entry,
      })),
    },
  };
}

export function runInspect(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) {
    return { exitCode: 1, error: 'Provide a non-empty query string for inspect.' };
  }
  const { catalog: cat, domains, override_warnings, auto_synced } = loadOrSyncCatalog(opts);
  const direct = detectDirectNoTool(q);
  if (direct.isDirect) {
    return {
      exitCode: 0,
      result: {
        query: q,
        auto_synced,
        predicted: 'NONE',
        direct_no_tool: true,
        direct_reason: direct.reason,
        ambiguous: false,
        missing_not_for_warning: false,
        override_warnings,
      },
    };
  }

  const scored = scoreTwoStage(cat, q, {
    domain: opts.domain || null,
    limit: opts.limit || 5,
    domains,
  });
  const top1 = scored.top_k?.[0];
  const top2 = scored.top_k?.[1];
  const top1Missing = Boolean(top1 && (!top1.not_for || top1.not_for.length === 0));
  const top2Missing = Boolean(top2 && (!top2.not_for || top2.not_for.length === 0));
  const closeMargin = Boolean(top1 && top2 && top1.score > 0 && ((top1.score - top2.score) / top1.score) < 0.2);

  const isAmbiguous = closeMargin && (top1Missing || top2Missing);
  const missingWarn = isAmbiguous || (scored.predicted !== 'NONE' && top1Missing);

  const outObj = {
    query: q,
    auto_synced,
    ...scored,
    ambiguous: isAmbiguous,
    missing_not_for_warning: missingWarn,
    override_warnings,
  };
  if (isAmbiguous) {
    outObj.recommended_action = 'llm_disambiguate_top_candidates';
    outObj.candidates = scored.top_k.slice(0, 3).map((c) => ({
      id: c.id,
      domain: c.domain,
      score: c.score,
      use_when: c.use_when,
      not_for: c.not_for,
      entry: c.entry,
    }));
  }
  return { exitCode: 0, result: outObj };
}
