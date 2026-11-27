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
import { buildLiveCatalog, parseDescription, syncLiveCatalog } from './catalog.mjs';
import { DEFAULT_DOMAINS, inferDomain, loadDomainsConfig, parseFrontmatterDomain } from './domains.mjs';
import { scoreTwoStage } from './scorer.mjs';

function isWithinRoot(rootReal, targetReal) {
  const rel = path.relative(rootReal, targetReal);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function extractFrontmatter(raw, fallbackName) {
  const fm = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return { ok: false, name: null, desc: '' };
  const body = fm[1];
  const nameMatch = body.match(/^name\s*:\s*["']?([^\r\n"']+)/m);
  const desc = parseDescription(raw);
  return {
    ok: true,
    name: nameMatch ? nameMatch[1].trim() : fallbackName,
    desc,
  };
}

export function findHardcodedUserPaths(text) {
  const hits = [];
  const winRe = /[A-Za-z]:[/\\]Users[/\\]([^/\\\s"'`>]+)/gi;
  const posixRe = /(?:^|[\s"'`(])(\/(?:Users|home)\/([a-zA-Z0-9._-]+)\/)/g;
  const placeholders = new Set(['user', 'username', 'your-user', 'alice', 'bob', '<user>', '<username>', 'runner', 'ci']);

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

export function runGate(opts = {}) {
  const maxLines = opts.maxLines ?? 150;
  const maxBytes = opts.maxBytes ?? 9000;
  const modeOpt = opts.mode || 'auto';

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
  const lines = rawMd.split(/\r?\n/);
  const bytes = Buffer.byteLength(rawMd, 'utf8');

  // Gate 1: Frontmatter & Use when / Not for boundary
  const fm = extractFrontmatter(rawMd, path.basename(skillReal));
  if (!fm.ok || !fm.name) {
    failures.push({ gate: 'frontmatter', reason: 'Missing valid YAML frontmatter or `name:` field' });
  }
  const hasUseWhen = /(?:Use when|MUST USE|触发(?:方式|词|场景)?|何时用)/i.test(fm.desc);
  const notForMatch = fm.desc.match(/(?:Not for|不用于|Don't use for|不适用于)[：:\s]*(.+)$/i);
  const hasNotFor = Boolean(notForMatch && notForMatch[1].trim().length >= 5);
  if (!hasUseWhen) failures.push({ gate: 'frontmatter_boundary', reason: 'Description missing explicit `Use when` trigger conditions' });
  if (!hasNotFor) failures.push({ gate: 'frontmatter_boundary', reason: 'Description missing explicit non-empty `Not for` exclusions' });

  // Gate 2: Thinness & inline giant code dump check
  if (lines.length > maxLines) failures.push({ gate: 'thinness', reason: `SKILL.md line count ${lines.length} exceeds limit ${maxLines}` });
  if (bytes > maxBytes) failures.push({ gate: 'thinness', reason: `SKILL.md byte size ${bytes} exceeds limit ${maxBytes}` });
  let inFence = false;
  let fenceLen = 0;
  let maxFence = 0;
  for (const l of lines) {
    if (/^\s*```/.test(l)) {
      if (!inFence) { inFence = true; fenceLen = 0; }
      else { if (fenceLen > maxFence) maxFence = fenceLen; inFence = false; }
    } else if (inFence) {
      fenceLen++;
    }
  }
  if (maxFence > 35) failures.push({ gate: 'thinness', reason: `Found huge inline code block (${maxFence} lines > 35); move into scripts/ or references/` });

  // Gate 3: Links & path hygiene
  const linkErrors = [];
  for (const m of rawMd.matchAll(/\[[^\]]+\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g)) {
    const target = m[1];
    if (/^(?:https?:|mailto:|customization:|file:)/.test(target)) continue;
    const resolved = path.resolve(skillReal, target);
    if (!fs.existsSync(resolved)) {
      linkErrors.push(`Missing link target: ${target}`);
    } else {
      const realT = fs.realpathSync(resolved);
      if (!isWithinRoot(skillReal, realT)) linkErrors.push(`Escaping relative link: ${target}`);
    }
  }
  if (linkErrors.length > 0) failures.push({ gate: 'links_hygiene', reason: linkErrors.join('; ') });

  const pathLeaks = findHardcodedUserPaths(rawMd);
  if (pathLeaks.length > 0) {
    failures.push({
      gate: 'links_hygiene',
      reason: `SKILL.md contains hardcoded user-profile paths (${pathLeaks.slice(0, 3).join(', ')}); use <skill_dir> or relative paths`,
    });
  }

  // Gate 4: Scripts & Verify execution
  const scriptsDir = path.join(skillReal, 'scripts');
  const scriptFiles = fs.existsSync(scriptsDir)
    ? fs.readdirSync(scriptsDir).filter((f) => /^(?:probe|preflight)_.*\.mjs$/i.test(f))
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
        execFileSync('node', [sp, '--help'], { encoding: 'utf8', timeout: 8000 });
        probeResults.push({ script: sf, help_exit: 0 });
      } catch (e) {
        failures.push({ gate: 'probe_cli', reason: `${sf} --help failed (exit ${e.status})` });
      }
      try {
        execFileSync('node', [sp, '--bogus-d-gate-flag'], { encoding: 'utf8', timeout: 8000, stdio: 'pipe' });
        failures.push({ gate: 'probe_cli', reason: `${sf} failed to reject unknown flag with exit != 0` });
      } catch (e) {
        if ((e.status ?? 1) !== 1) failures.push({ gate: 'probe_cli', reason: `${sf} rejected unknown flag with exit ${e.status}, expected 1` });
      }
    }

    if (!opts.skipVerify) {
      for (const vf of verifyFiles) {
        const vp = path.join(skillReal, vf);
        try {
          const vOut = execFileSync('node', [vp], { encoding: 'utf8', timeout: 30000 });
          verifyResults.push({ file: vf, status: 'PASS', summary: vOut.trim().split(/\r?\n/).pop() });
        } catch (e) {
          failures.push({ gate: 'verify_suite', reason: `${vf} failed (exit ${e.status}): ${String(e.stderr || e.stdout || e.message).slice(0, 200)}` });
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
      const domRes = loadDomainsConfig(opts.domainsPath || null, opts.cwd || process.cwd());
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

    const withoutSelf = live.filter((x) => x.name !== fm.name);
    const fmDomain = parseFrontmatterDomain(rawMd);
    const domain = fmDomain || (live.find((x) => x.name === fm.name)?.domain) || inferDomain(fm.name, fm.desc, domainsMap);
    const syntheticSelf = {
      id: `${domain}/${fm.name}`,
      name: fm.name,
      domain,
      kind: 'skill',
      purpose: fm.desc.slice(0, 180),
      use_when: fm.desc.slice(0, 140),
      not_for: notForMatch ? notForMatch[1].split(/[.;。；]/).map((s) => s.trim()).filter((s) => s.length >= 3) : [],
      aka: [fm.name],
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

  // Gate 6: Optional mirror symlink parity check (only when explicitly requested or mirror root already exists)
  const globalSkillsPath = path.join(os.homedir(), '.agents', 'skills');
  const globalSkillsRoot = fs.existsSync(globalSkillsPath) ? fs.realpathSync(globalSkillsPath) : null;
  const mirrorRoot = opts.checkMirror || path.join(os.homedir(), '.gemini', 'config', 'skills');
  let symlinkCheck = { checked: false };
  const insideGlobal = Boolean(globalSkillsRoot && isWithinRoot(globalSkillsRoot, skillReal));
  if (opts.checkMirror || (insideGlobal && fs.existsSync(mirrorRoot))) {
    const mirror = path.join(mirrorRoot, path.basename(skillReal));
    const exists = fs.existsSync(mirror);
    symlinkCheck = { checked: true, mirror_exists: exists, mirror_path: mirror };
    if (!exists) {
      failures.push({ gate: 'symlink_parity', reason: `Missing mirror symlink at ${mirror}` });
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
      metrics: { lines: lines.length, bytes, max_inline_code_fence: maxFence },
      probes_checked: probeResults,
      verify_results: verifyResults,
      routing_smoke: routingCheck,
      symlink_parity: symlinkCheck,
      router_synced: routerSynced,
      failures,
    },
  };
}
