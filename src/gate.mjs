/**
 * SkillPlumb 6-Gate Black-Box Acceptance Validator (`src/gate.mjs`).
 *
 * Exit codes:
 *   0 = all applicable gates PASSED
 *   1 = invalid CLI arguments or missing target directory
 *   2 = one or more gates FAILED
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildLiveCatalog,
  extractRoutingClauses,
  parseDescription,
  syncLiveCatalog,
} from './catalog.mjs';
import { DEFAULT_DOMAINS, inferDomain, loadDomainsConfig, parseFrontmatterDomain } from './domains.mjs';
import { scoreTwoStage } from './scorer.mjs';

function isWithinRoot(rootReal, targetReal) {
  const rel = path.relative(rootReal, targetReal);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

export function stripFencedCodeBlocks(raw) {
  const clean = String(raw || '').replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/);
  const out = [];
  let fenceChar = null;
  let fenceMinLen = 0;

  for (const line of lines) {
    const openOrClose = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (openOrClose) {
      const marker = openOrClose[1];
      const rest = openOrClose[2].trim();
      if (!fenceChar) {
        fenceChar = marker[0];
        fenceMinLen = marker.length;
        out.push('');
        continue;
      } else if (marker[0] === fenceChar && marker.length >= fenceMinLen && rest === '') {
        fenceChar = null;
        fenceMinLen = 0;
        out.push('');
        continue;
      }
    }
    if (fenceChar) {
      out.push('');
    } else {
      out.push(line.replace(/`+[^`\n]*`+/g, ''));
    }
  }
  return out.join('\n');
}

export function measureSkillMarkdown(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const bytes = Buffer.byteLength(text, 'utf8');
  let fenceChar = null;
  let fenceMinLen = 0;
  let fenceLen = 0;
  let maxFence = 0;
  for (const l of lines) {
    const m = l.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (m) {
      const marker = m[1];
      const rest = m[2].trim();
      if (!fenceChar) {
        fenceChar = marker[0];
        fenceMinLen = marker.length;
        fenceLen = 0;
        continue;
      } else if (marker[0] === fenceChar && marker.length >= fenceMinLen && rest === '') {
        if (fenceLen > maxFence) maxFence = fenceLen;
        fenceChar = null;
        fenceMinLen = 0;
        continue;
      }
    }
    if (fenceChar) {
      fenceLen++;
    }
  }
  if (fenceChar && fenceLen > maxFence) {
    maxFence = fenceLen;
  }
  return { lines, lineCount: lines.length, bytes, maxFence };
}

function extractFrontmatter(raw, fallbackName) {
  const clean = String(raw || '').replace(/^\uFEFF/, '');
  const fm = clean.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return { ok: false, hasName: false, name: null, desc: '' };
  const body = fm[1];
  const nameMatch = body.match(/^name\s*:\s*["']?([^\r\n"']+)/m);
  const parsedName = nameMatch ? nameMatch[1].trim() : '';
  const desc = parseDescription(clean);
  return {
    ok: true,
    hasName: Boolean(parsedName),
    name: parsedName || fallbackName,
    desc,
  };
}

export function findHardcodedUserPaths(text) {
  const hits = [];
  const winRe = /[A-Za-z]:[/\\]Users[/\\]([^/\\\s"'`>]+)/gi;
  const posixRe = /(?:^|[\s"'`(=])(\/(?:Users|home)\/([a-zA-Z0-9._-]+)\/)/g;
  const placeholders = new Set(['user', 'username', 'your-user', 'alice', 'bob', '<user>', '<username>', 'runner', 'ci', '...']);

  for (const m of String(text || '').matchAll(winRe)) {
    const userSeg = m[1].toLowerCase();
    if (!placeholders.has(userSeg) && !userSeg.startsWith('<')) {
      hits.push(m[0]);
    }
  }
  for (const m of String(text || '').matchAll(posixRe)) {
    const userSeg = m[2].toLowerCase();
    if (!placeholders.has(userSeg) && !userSeg.startsWith('<')) {
      hits.push(m[1]);
    }
  }
  return [...new Set(hits)];
}

export function findSkillUserPathLeaks(skillReal, rawMd) {
  const allPaths = [];
  const leakFiles = [];

  const mdLeaks = findHardcodedUserPaths(rawMd);
  if (mdLeaks.length > 0) {
    allPaths.push(...mdLeaks);
    leakFiles.push('SKILL.md');
  }

  const refsDir = path.join(skillReal, 'references');
  if (fs.existsSync(refsDir)) {
    function walkRefs(dir, depth) {
      if (depth > 2) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        let real;
        try {
          real = fs.realpathSync(full);
          if (!isWithinRoot(skillReal, real)) continue;
        } catch { continue; }
        const st = fs.statSync(real);
        if (st.isDirectory()) {
          walkRefs(real, depth + 1);
        } else if (st.isFile() && /\.md$/i.test(ent.name)) {
          const refText = fs.readFileSync(real, 'utf8');
          const leaks = findHardcodedUserPaths(refText);
          if (leaks.length > 0) {
            allPaths.push(...leaks);
            leakFiles.push(path.relative(skillReal, real).replace(/\\/g, '/'));
          }
        }
      }
    }
    try {
      const refsReal = fs.realpathSync(refsDir);
      if (isWithinRoot(skillReal, refsReal) && fs.statSync(refsReal).isDirectory()) {
        walkRefs(refsReal, 0);
      }
    } catch { /* ignore */ }
  }

  return {
    paths: [...new Set(allPaths)],
    files: [...new Set(leakFiles)],
  };
}

export function runGate(opts = {}) {
  const maxLines = opts.maxLines ?? 150;
  const maxBytes = opts.maxBytes ?? 9000;
  const modeOpt = opts.mode || 'auto';

  if (!['auto', 'full', 'lite'].includes(modeOpt)) {
    return { exitCode: 1, error: `--mode must be auto | full | lite (got ${modeOpt})` };
  }
  if (!opts.skillDir) {
    return { exitCode: 1, error: 'Provide exactly one <skill_dir> path' };
  }
  const abs = path.resolve(opts.cwd || process.cwd(), opts.skillDir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { exitCode: 1, error: `Skill directory not found: ${opts.skillDir}` };
  }
  const skillReal = fs.realpathSync(abs);
  const mdPath = path.join(skillReal, 'SKILL.md');
  if (!fs.existsSync(mdPath)) {
    return {
      exitCode: 2,
      result: {
        gate_passed: false,
        exit_code: 2,
        skill_dir: skillReal,
        failures: [{ gate: 'frontmatter', reason: 'Missing SKILL.md' }],
      },
    };
  }

  const failures = [];
  const rawMd = fs.readFileSync(mdPath, 'utf8');
  const { lineCount, bytes, maxFence } = measureSkillMarkdown(rawMd);

  // Gate 1: Frontmatter & Use when / Not for boundary
  const fm = extractFrontmatter(rawMd, path.basename(skillReal));
  if (!fm.ok || !fm.hasName) {
    failures.push({ gate: 'frontmatter', reason: 'Missing valid YAML frontmatter or `name:` field' });
  }
  const clauses = extractRoutingClauses(fm.desc);
  if (!clauses.hasUseWhen) failures.push({ gate: 'frontmatter_boundary', reason: 'Description missing explicit `Use when` trigger conditions' });
  if (!clauses.hasNotFor) failures.push({ gate: 'frontmatter_boundary', reason: 'Description missing explicit non-empty `Not for` exclusions' });

  // Gate 2: Thinness & inline giant code dump check
  if (lineCount > maxLines) failures.push({ gate: 'thinness', reason: `SKILL.md line count ${lineCount} exceeds limit ${maxLines}` });
  if (bytes > maxBytes) failures.push({ gate: 'thinness', reason: `SKILL.md byte size ${bytes} exceeds limit ${maxBytes}` });
  if (maxFence > 35) failures.push({ gate: 'thinness', reason: `Found huge inline code block (${maxFence} lines > 35); move into scripts/ or references/` });

  // Gate 3: Links & path hygiene (ignore links inside fenced code blocks / inline code)
  const linkErrors = [];
  const strippedMd = stripFencedCodeBlocks(rawMd);
  for (const m of strippedMd.matchAll(/\[[^\]]+\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g)) {
    const target = m[1];
    if (/^(?:https?:|mailto:|customization:)/.test(target)) continue;
    if (/^file:/i.test(target)) {
      linkErrors.push(`Local file:// link disallowed: ${target}`);
      continue;
    }
    const resolved = path.resolve(skillReal, target);
    if (!fs.existsSync(resolved)) {
      linkErrors.push(`Missing link target: ${target}`);
    } else {
      const realT = fs.realpathSync(resolved);
      if (!isWithinRoot(skillReal, realT)) linkErrors.push(`Escaping relative link: ${target}`);
    }
  }
  if (linkErrors.length > 0) failures.push({ gate: 'links_hygiene', reason: linkErrors.join('; ') });

  const leakReport = findSkillUserPathLeaks(skillReal, rawMd);
  if (leakReport.paths.length > 0) {
    failures.push({
      gate: 'links_hygiene',
      reason: `${leakReport.files.join(', ')} contains hardcoded user-profile paths (${leakReport.paths.slice(0, 3).join(', ')}); use <skill_dir> or relative paths`,
    });
  }

  // Gate 4: Scripts & Verify execution
  const scriptsDir = path.join(skillReal, 'scripts');
  const scriptFiles = fs.existsSync(scriptsDir)
    ? fs.readdirSync(scriptsDir).filter((f) => /^(?:probe|preflight)_.*\.mjs$|^(?:eval|audit)_all\.mjs$/i.test(f))
    : [];
  const verifyFiles = fs.readdirSync(skillReal).filter((f) => /^verify_.*\.mjs$/i.test(f));
  const detectedMode = modeOpt === 'auto'
    ? (scriptFiles.length > 0 || verifyFiles.length > 0 ? 'full' : 'lite')
    : modeOpt;

  const probeResults = [];
  const verifyResults = [];

  if (detectedMode === 'full') {
    if (verifyFiles.length === 0) failures.push({ gate: 'verify_suite', reason: 'D-Full skill missing verify_*.mjs regression suite' });

    for (const sf of scriptFiles) {
      const sp = path.join(scriptsDir, sf);
      try {
        execFileSync(process.execPath, [sp, '--help'], { encoding: 'utf8', timeout: 8000, stdio: 'pipe' });
        probeResults.push({ script: sf, help_exit: 0 });
      } catch (e) {
        failures.push({ gate: 'probe_cli', reason: `${sf} --help failed (exit ${e.status ?? e.signal ?? 'error'})` });
      }
      try {
        execFileSync(process.execPath, [sp, '--bogus-d-gate-flag'], { encoding: 'utf8', timeout: 8000, stdio: 'pipe' });
        failures.push({ gate: 'probe_cli', reason: `${sf} failed to reject unknown flag with exit != 0` });
      } catch (e) {
        if (e.signal || e.status !== 1) {
          failures.push({
            gate: 'probe_cli',
            reason: `${sf} rejected unknown flag with exit ${e.status ?? 'null'}${e.signal ? ` (signal ${e.signal})` : ''}, expected 1`,
          });
        }
      }
    }

    if (!opts.skipVerify) {
      for (const vf of verifyFiles) {
        const vp = path.join(skillReal, vf);
        try {
          const vOut = execFileSync(process.execPath, [vp], { encoding: 'utf8', timeout: 60000, stdio: 'pipe' });
          verifyResults.push({ file: vf, status: 'PASS', summary: vOut.trim().split(/\r?\n/).pop() });
        } catch (e) {
          failures.push({ gate: 'verify_suite', reason: `${vf} failed (exit ${e.status ?? e.signal ?? 'error'}): ${String(e.stderr || e.stdout || e.message).slice(0, 200)}` });
        }
      }
    }
  }

  // Gate 5: Live catalog routing smoke check
  let routingCheck = { checked: false };
  if (!opts.skipRouting && fm.name) {
    let live = [];
    let domainsMap = DEFAULT_DOMAINS;
    try {
      const domRes = loadDomainsConfig(opts.domainsPath !== undefined ? opts.domainsPath : null, opts.cwd || process.cwd());
      if (!domRes.ok) return { exitCode: 1, error: domRes.error };
      domainsMap = domRes.domains;
      live = buildLiveCatalog({
        cwd: opts.cwd,
        skillsDirs: opts.skillsDirs,
        skillsDir: opts.skillsDir,
        mcpCfgPath: opts.mcpCfgPath,
        noMcp: opts.noMcp,
        overridesPath: opts.overridesPath,
        domainsPath: opts.domainsPath,
      });
    } catch (err) {
      return { exitCode: 1, error: err.message };
    }

    const liveSelf = live.find((x) => x.name === fm.name);
    const withoutSelf = live.filter((x) => x.name !== fm.name);
    const fmDomain = parseFrontmatterDomain(rawMd);
    const domain = liveSelf?.domain || fmDomain || inferDomain(fm.name, clauses.purpose, domainsMap);
    const syntheticSelf = {
      id: `${domain}/${fm.name}`,
      name: fm.name,
      domain,
      kind: 'skill',
      purpose: clauses.purpose,
      use_when: clauses.useWhen,
      not_for: [...new Set([...clauses.notFor, ...(liveSelf?.not_for || [])])],
      aka: [...new Set([fm.name, ...(liveSelf?.aka || [])])],
      entry: `skill:${fm.name}`,
    };
    const merged = [...withoutSelf, syntheticSelf];
    const probeQ = `${fm.name} ${syntheticSelf.use_when.slice(0, 50)}`;
    const r = scoreTwoStage(merged, probeQ, { ignoreDirectGuard: true, domains: domainsMap });
    routingCheck = { checked: true, query: probeQ, predicted: r.predicted, expected: syntheticSelf.id, pass: r.predicted === syntheticSelf.id };
    if (r.predicted !== syntheticSelf.id) {
      failures.push({ gate: 'routing_smoke', reason: `Self-trigger probe routed to "${r.predicted}" instead of "${syntheticSelf.id}"` });
    }
  }

  // Gate 6: Opt-in mirror symlink parity check (--check-mirror <dir>)
  const globalSkillsPath = path.join(os.homedir(), '.agents', 'skills');
  const globalSkillsRoot = fs.existsSync(globalSkillsPath) ? fs.realpathSync(globalSkillsPath) : null;
  const insideGlobal = Boolean(globalSkillsRoot && isWithinRoot(globalSkillsRoot, skillReal));
  let symlinkCheck = { checked: false };
  if (opts.checkMirror) {
    const mirrorRoot = path.resolve(opts.cwd || process.cwd(), opts.checkMirror);
    const mirror = path.join(mirrorRoot, path.basename(skillReal));
    const exists = fs.existsSync(mirror);
    let pointsToSkill = false;
    if (exists) {
      try {
        pointsToSkill = fs.realpathSync(mirror) === skillReal;
      } catch { pointsToSkill = false; }
    }
    symlinkCheck = { checked: true, mirror_exists: exists, points_to_skill: pointsToSkill, mirror_path: mirror };
    if (!exists || !pointsToSkill) {
      failures.push({
        gate: 'symlink_parity',
        reason: !exists ? `Missing mirror symlink at ${mirror}` : `Mirror ${mirror} does not resolve to ${skillReal}`,
      });
    }
  }

  const passed = failures.length === 0;
  let routerSynced = false;
  if (passed && !opts.noSync && insideGlobal) {
    syncLiveCatalog({
      cwd: opts.cwd,
      skillsDirs: opts.skillsDirs,
      skillsDir: opts.skillsDir,
      mcpCfgPath: opts.mcpCfgPath,
      noMcp: opts.noMcp,
      overridesPath: opts.overridesPath,
      domainsPath: opts.domainsPath,
      outFile: opts.outFile,
    });
    routerSynced = true;
  }

  return {
    exitCode: passed ? 0 : 2,
    result: {
      gate_passed: passed,
      exit_code: passed ? 0 : 2,
      exit_meaning: passed ? 'all_d_gates_passed' : 'd_gate_failed',
      name: fm.name,
      mode: detectedMode,
      skill_dir: skillReal,
      metrics: { lines: lineCount, bytes, max_inline_code_fence: maxFence },
      probes_checked: probeResults,
      verify_results: verifyResults,
      routing_smoke: routingCheck,
      symlink_parity: symlinkCheck,
      router_synced: routerSynced,
      failures,
    },
  };
}
