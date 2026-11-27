/**
 * Read-only ecosystem health scanner (`skill-plumb doctor`).
 * Audits installed SKILL.md files for thinness, crowded missing `Not for`,
 * broken relative links, hardcoded user paths, and malformed overrides.
 *
 * Exit codes:
 *   0 = healthy (zero findings)
 *   1 = CLI or config error
 *   2 = one or more findings detected
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  buildCrowdedMissingNotFor,
  buildLiveCatalog,
  extractRoutingClauses,
  parseDescription,
  resolveCatalogContext,
} from './catalog.mjs';
import { collectSkillEntries, realpathNative } from './discovery.mjs';
import { findSkillUserPathLeaks, measureSkillMarkdown, stripFencedCodeBlocks } from './gate.mjs';

function isWithinRoot(rootReal, targetReal) {
  const rel = path.relative(rootReal, targetReal);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function checkRelativeLinks(skillReal, rawMd) {
  const issues = [];
  const stripped = stripFencedCodeBlocks(rawMd);
  for (const m of stripped.matchAll(/\[[^\]]+\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g)) {
    const target = m[1];
    if (/^(?:https?:|mailto:|customization:)/.test(target)) continue;
    if (/^file:/i.test(target)) {
      issues.push({ type: 'broken_link', target });
      continue;
    }
    const resolved = path.resolve(skillReal, target);
    if (!fs.existsSync(resolved)) {
      issues.push({ type: 'broken_link', target });
    } else {
      const realT = realpathNative(resolved);
      if (!isWithinRoot(skillReal, realT)) {
        issues.push({ type: 'escaping_link', target });
      }
    }
  }
  return issues;
}

export function runDoctor(opts = {}) {
  const maxLines = opts.maxLines ?? 150;
  const maxBytes = opts.maxBytes ?? 9000;
  const maxFenceLines = opts.maxFenceLines ?? 35;

  let ctx;
  let catalog;
  try {
    ctx = resolveCatalogContext(opts);
    catalog = buildLiveCatalog(opts);
  } catch (err) {
    return { exitCode: 1, error: err.message };
  }

  const skillEntries = collectSkillEntries(ctx.skillDirs);
  const entryByName = new Map(skillEntries.map((e) => [e.name, e]));
  const crowdedList = buildCrowdedMissingNotFor(catalog);
  const crowdedByName = new Map(crowdedList.map((c) => [c.name, c]));
  const domainCounts = new Map();
  for (const item of catalog) {
    domainCounts.set(item.domain, (domainCounts.get(item.domain) || 0) + 1);
  }

  const findings = [];
  const bloatedSkills = [];
  const brokenLinkSkills = [];
  const pathLeakSkills = [];
  const missingFrontmatterSkills = [];
  const soloMissingNotFor = [];

  for (const item of catalog) {
    if (item.kind !== 'skill') {
      const crowdedMcp = crowdedByName.get(item.name);
      if (crowdedMcp) {
        findings.push({
          kind: 'crowded_missing_not_for',
          severity: 'high',
          skill: item.name,
          entry_kind: item.kind,
          domain: item.domain,
          domain_count: crowdedMcp.domain_count,
          file: ctx.mcpCfgPath ? ctx.mcpCfgPath.replace(/\\/g, '/') : null,
          detail: `Missing \`Not for\` on ${item.kind} "${item.name}" in crowded domain "${item.domain}" (${crowdedMcp.domain_count} competing entries)`,
          suggested_override: crowdedMcp.suggested_override,
        });
      } else if (!item.not_for || item.not_for.length === 0) {
        soloMissingNotFor.push(item.id);
      }
      continue;
    }
    const disk = entryByName.get(item.name);
    if (!disk) continue;

    const raw = fs.readFileSync(disk.mdPath, 'utf8').replace(/^\uFEFF/, '');
    const { lineCount, bytes, maxFence } = measureSkillMarkdown(raw);
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const nameMatch = fm ? fm[1].match(/^name\s*:\s*["']?([^\r\n"']+)/m) : null;
    const desc = parseDescription(raw);
    const clauses = extractRoutingClauses(desc);

    if (!fm || !nameMatch) {
      missingFrontmatterSkills.push(item.name);
      findings.push({
        kind: 'missing_frontmatter',
        severity: 'high',
        skill: item.name,
        domain: item.domain,
        file: disk.mdPath.replace(/\\/g, '/'),
        detail: 'Missing valid YAML frontmatter or `name:` field',
      });
    } else if (!clauses.hasUseWhen) {
      missingFrontmatterSkills.push(item.name);
      findings.push({
        kind: 'missing_use_when',
        severity: 'medium',
        skill: item.name,
        domain: item.domain,
        file: disk.mdPath.replace(/\\/g, '/'),
        detail: 'Description missing explicit `Use when` trigger clause',
      });
    }

    if (lineCount > maxLines || bytes > maxBytes || maxFence > maxFenceLines) {
      bloatedSkills.push({
        name: item.name,
        domain: item.domain,
        lines: lineCount,
        bytes,
        max_fence: maxFence,
      });
      findings.push({
        kind: 'bloated_skill_md',
        severity: 'medium',
        skill: item.name,
        domain: item.domain,
        file: disk.mdPath.replace(/\\/g, '/'),
        lines: lineCount,
        bytes,
        max_fence: maxFence,
        detail: `Exceeds thin contract budget (lines: ${lineCount}/${maxLines}, bytes: ${bytes}/${maxBytes}, max_fence: ${maxFence}/${maxFenceLines})`,
      });
    }

    const linkIssues = checkRelativeLinks(disk.realDir, raw);
    if (linkIssues.length > 0) {
      brokenLinkSkills.push({ name: item.name, issues: linkIssues });
      for (const li of linkIssues) {
        findings.push({
          kind: li.type,
          severity: 'high',
          skill: item.name,
          domain: item.domain,
          file: disk.mdPath.replace(/\\/g, '/'),
          target: li.target,
          detail: `${li.type === 'escaping_link' ? 'Escaping' : 'Broken'} relative link: ${li.target}`,
        });
      }
    }

    const leakReport = findSkillUserPathLeaks(disk.realDir, raw);
    if (leakReport.paths.length > 0) {
      pathLeakSkills.push({ name: item.name, paths: leakReport.paths, files: leakReport.files });
      findings.push({
        kind: 'hardcoded_user_path',
        severity: 'high',
        skill: item.name,
        domain: item.domain,
        file: disk.mdPath.replace(/\\/g, '/'),
        files: leakReport.files,
        paths: leakReport.paths,
        detail: `Hardcoded user-profile path(s) in ${leakReport.files.join(', ')}: ${leakReport.paths.slice(0, 3).join(', ')}`,
      });
    }

    const crowded = crowdedByName.get(item.name);
    if (crowded) {
      findings.push({
        kind: 'crowded_missing_not_for',
        severity: 'high',
        skill: item.name,
        domain: item.domain,
        domain_count: crowded.domain_count,
        file: disk.mdPath.replace(/\\/g, '/'),
        detail: `Missing \`Not for\` in crowded domain "${item.domain}" (${crowded.domain_count} competing entries)`,
        suggested_override: crowded.suggested_override,
      });
    } else if (!item.not_for || item.not_for.length === 0) {
      soloMissingNotFor.push(item.id);
    }
  }

  const overrideWarnings = buildLiveCatalog.lastMeta?.overrideWarnings || ctx.overridesRes.warnings || [];
  for (const w of overrideWarnings) {
    findings.push({
      kind: 'override_schema_warning',
      severity: 'medium',
      skill: w.skill,
      field: w.field,
      file: ctx.overridesPath ? ctx.overridesPath.replace(/\\/g, '/') : null,
      detail: w.message,
    });
  }

  const suggestedOverridesObj = {};
  for (const c of crowdedList) {
    suggestedOverridesObj[c.name] = c.suggested_override;
  }

  const exitCode = findings.length > 0 ? 2 : 0;
  return {
    exitCode,
    result: {
      scan_completed: true,
      exit_code: exitCode,
      exit_meaning: exitCode === 0 ? 'healthy' : 'findings_detected',
      skill_dirs_scanned: ctx.skillDirs.map((d) => d.replace(/\\/g, '/')),
      mcp_config: ctx.mcpCfgPath ? ctx.mcpCfgPath.replace(/\\/g, '/') : null,
      overrides_path: ctx.overridesPath ? ctx.overridesPath.replace(/\\/g, '/') : null,
      domains_config: ctx.domainsRes.configPath ? ctx.domainsRes.configPath.replace(/\\/g, '/') : null,
      summary: {
        total_entries: catalog.length,
        skills_scanned: catalog.filter((x) => x.kind === 'skill').length,
        mcps_scanned: catalog.filter((x) => x.kind === 'mcp').length,
        domains_active: domainCounts.size,
        findings_count: findings.length,
        missing_frontmatter_or_use_when_count: missingFrontmatterSkills.length,
        bloated_count: bloatedSkills.length,
        crowded_missing_not_for_count: crowdedList.length,
        broken_links_count: brokenLinkSkills.reduce((acc, s) => acc + s.issues.length, 0),
        hardcoded_path_count: pathLeakSkills.length,
        override_warnings_count: overrideWarnings.length,
        solo_missing_not_for_count: soloMissingNotFor.length,
      },
      findings,
      suggested_overrides: Object.keys(suggestedOverridesObj).length > 0
        ? {
            _doc: 'Paste into router_overrides.json to fix crowded-domain collisions without modifying SKILL.md',
            overrides: suggestedOverridesObj,
          }
        : null,
    },
  };
}

export function formatDoctorReport(res) {
  const s = res.summary;
  const lines = [];
  lines.push(`SkillPlumb Doctor — ${res.exit_code === 0 ? 'HEALTHY' : 'ISSUES FOUND'} (exit ${res.exit_code})`);
  lines.push(`Dirs scanned (${res.skill_dirs_scanned.length}): ${res.skill_dirs_scanned.join(', ') || '(none)'}`);
  lines.push(
    `Entries: ${s.total_entries} (${s.skills_scanned} skills, ${s.mcps_scanned} MCPs across ${s.domains_active} domains)`
  );
  lines.push('');

  const rows = [
    ['Missing YAML frontmatter / name / Use when', s.missing_frontmatter_or_use_when_count],
    ['Bloated SKILL.md (>150 lines or >9KB or >35-line fence)', s.bloated_count],
    ['Crowded domain missing Not-for (domain_count >= 2)', s.crowded_missing_not_for_count],
    ['Broken or escaping relative links', s.broken_links_count],
    ['Hardcoded personal user-home paths', s.hardcoded_path_count],
    ['Overrides schema warnings', s.override_warnings_count],
    ['Solo-domain missing Not-for (informational)', s.solo_missing_not_for_count],
  ];

  lines.push('| Check | Count |');
  lines.push('|---|---:|');
  for (const [label, count] of rows) {
    lines.push(`| ${label} | ${count} |`);
  }

  if (res.findings.length > 0) {
    lines.push('');
    lines.push('Findings:');
    for (const f of res.findings) {
      lines.push(`- [${f.severity.toUpperCase()}] ${f.skill} (${f.kind}): ${f.detail}`);
    }
  }

  if (res.suggested_overrides) {
    lines.push('');
    lines.push('Suggested router_overrides.json snippet (zero-invasion fix):');
    lines.push('```json');
    lines.push(JSON.stringify(res.suggested_overrides, null, 2));
    lines.push('```');
  }

  return lines.join('\n') + '\n';
}
