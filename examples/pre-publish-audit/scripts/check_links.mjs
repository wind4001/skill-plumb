#!/usr/bin/env node
// D-group pre-publish-audit: §7 Structural Markdown local link & image predicate.
// Independent non-regex predicate (verifies whether local paths actually resolve inside the repo).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCliArgs,
  findEnclosingGitMarker,
  getGitFileSets,
  walkSafe,
  safeReadTextFile,
  isPathInsideRoot,
  normalizePosix,
} from './shared.mjs';

const EXTERNAL_SCHEME_RE = /^(?:https?:\/\/|mailto:|tel:|data:|javascript:|\/\/)/i;
const OS_ABSOLUTE_LINK_RE = /^(?:file:|\/(?:data|home|Users|root|tmp|opt|var|mnt|srv|etc|usr|private)(?:\/|$)|[A-Za-z]:[\\/])/i;

function stripInlineCode(line) {
  // Linear-time O(N) inline code span stripper (immune to regex backtracking on unclosed backticks)
  if (!line.includes('`')) return line;
  const out = line.split('');
  const n = out.length;
  let i = 0;
  while (i < n) {
    if (out[i] !== '`') {
      i++;
      continue;
    }
    let tickCount = 0;
    while (i + tickCount < n && out[i + tickCount] === '`') tickCount++;
    const delim = '`'.repeat(tickCount);
    // Find next exact tickCount-long backtick run
    let j = i + tickCount;
    let found = -1;
    while (j < n) {
      const idx = line.indexOf(delim, j);
      if (idx === -1) break;
      const beforeOk = idx === 0 || line[idx - 1] !== '`';
      const afterEnd = idx + tickCount;
      const afterOk = afterEnd === n || line[afterEnd] !== '`';
      if (beforeOk && afterOk) {
        found = afterEnd;
        break;
      }
      j = idx + 1;
    }
    if (found !== -1) {
      for (let k = i; k < found; k++) out[k] = ' ';
      i = found;
    } else {
      i += tickCount;
    }
  }
  return out.join('');
}

function extractLinksFromLine(rawLine) {
  const line = stripInlineCode(rawLine);
  const results = [];
  let i = 0;

  while (i < line.length) {
    const openBracket = line.indexOf('[', i);
    if (openBracket === -1) break;
    const isImage = openBracket > 0 && line[openBracket - 1] === '!';

    // Find matching ']' (handling escaped brackets)
    let j = openBracket + 1;
    let bracketDepth = 1;
    while (j < line.length && bracketDepth > 0) {
      if (line[j] === '\\') {
        j += 2;
        continue;
      }
      if (line[j] === '[') bracketDepth++;
      else if (line[j] === ']') bracketDepth--;
      j++;
    }
    if (bracketDepth !== 0) {
      i = openBracket + 1;
      continue;
    }

    // Must immediately be followed by '('
    if (line[j] !== '(') {
      i = j;
      continue;
    }

    // Parse destination inside (...) with balanced parentheses and angle-bracket support
    let k = j + 1;
    let parenDepth = 1;
    let inAngle = false;
    let inQuote = null;

    while (k < line.length && parenDepth > 0) {
      const ch = line[k];
      if (ch === '\\') {
        k += 2;
        continue;
      }
      if (!inQuote && ch === '<' && !inAngle) {
        inAngle = true;
      } else if (inAngle && ch === '>') {
        inAngle = false;
      } else if (!inAngle && (ch === '"' || ch === "'")) {
        if (inQuote === ch) inQuote = null;
        else if (!inQuote) inQuote = ch;
      } else if (!inAngle && !inQuote) {
        if (ch === '(') parenDepth++;
        else if (ch === ')') {
          parenDepth--;
          if (parenDepth === 0) break;
        }
      }
      k++;
    }

    if (parenDepth === 0) {
      const rawDest = line.slice(j + 1, k).trim();
      if (rawDest) {
        results.push({ rawDest, isImage });
      }
      const innerLabel = line.slice(openBracket + 1, j - 1);
      i = innerLabel.includes('[') ? openBracket + 1 : k + 1;
    } else {
      i = j + 1;
    }
  }

  return results;
}

function parseLinkTarget(rawDest) {
  let s = String(rawDest || '').trim();
  if (!s) return '';
  if (s.startsWith('<')) {
    const close = s.indexOf('>');
    if (close > 0) {
      s = s.slice(1, close).trim();
    } else {
      s = s.replace(/^<+|>+$/g, '').trim();
    }
  } else {
    // Strip optional title: `path "title"` or `path 'title'`
    s = s.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, '').trim();
  }
  // Strip anchor & query string
  s = s.split('#')[0].split('?')[0].trim();
  return s;
}

export async function run(options = {}) {
  const targetDir = path.resolve(options.target || process.cwd());
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    return {
      facts: {
        scan_completed: false,
        error: `target directory does not exist or is not a directory: ${targetDir}`,
      },
      exitCode: 1,
    };
  }

  const ctx = options._ctx || null;
  const gitInfo = ctx ? ctx.gitInfo : findEnclosingGitMarker(targetDir);
  let gitSets = ctx ? ctx.gitSets : { ok: false, tracked: new Set(), untracked: new Set() };
  if (!ctx && gitInfo.is_work_tree) {
    gitSets = getGitFileSets(targetDir, gitInfo);
  }

  const walked = ctx ? ctx.walked : walkSafe(targetDir);
  const skipped = [...walked.skipped];
  const findings = [];

  let rootBoundaryReal = walked.rootReal;
  if (gitInfo.is_work_tree && gitInfo.repo_root) {
    try {
      rootBoundaryReal = fs.realpathSync(gitInfo.repo_root);
    } catch {}
  }

  let markdownFilesChecked = 0;
  let localLinksChecked = 0;
  let externalLinksSkipped = 0;
  let rootRelativeLinksSkipped = 0;

  for (const f of walked.files) {
    if (!/\.md$/i.test(f.rel)) continue;
    if (gitSets.ok && !gitSets.tracked.has(f.rel) && !gitSets.untracked.has(f.rel)) {
      continue;
    }

    const readRes = safeReadTextFile(f.full, f.rel, f.size);
    if (readRes.status !== 'ok') {
      skipped.push({ path: f.rel, reason: readRes.reason || readRes.status });
      continue;
    }
    markdownFilesChecked++;

    let inFence = false;
    let fenceChar = null;
    let fenceLen = 0;

    for (let i = 0; i < readRes.lines.length; i++) {
      const rawLine = readRes.lines[i];
      const lineNo = i + 1;

      // Track fenced code blocks (``` or ~~~)
      const fenceM = rawLine.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fenceM) {
        const marker = fenceM[1];
        if (!inFence) {
          inFence = true;
          fenceChar = marker[0];
          fenceLen = marker.length;
          continue;
        } else if (marker[0] === fenceChar && marker.length >= fenceLen && /^\s*$/.test(rawLine.slice(fenceM[0].length))) {
          inFence = false;
          fenceChar = null;
          fenceLen = 0;
          continue;
        }
      }
      if (inFence) continue;

      const links = extractLinksFromLine(rawLine);
      for (const item of links) {
        const target = parseLinkTarget(item.rawDest);
        if (!target) continue;

        if (EXTERNAL_SCHEME_RE.test(target)) {
          externalLinksSkipped++;
          continue;
        }

        localLinksChecked++;

        let decoded = target;
        try {
          decoded = decodeURIComponent(target);
        } catch {
          decoded = target;
        }

        // 1. OS absolute path or file:// URI
        if (OS_ABSOLUTE_LINK_RE.test(decoded)) {
          findings.push({
            severity: 'high',
            kind: 'absolute_local_link',
            file: f.rel,
            line: lineNo,
            link: target,
            note: 'Markdown 中包含绝对路径或 file:// 本地链接，跨机器失效且泄露本机目录结构',
          });
          continue;
        }

        // 2. Non-OS web-root leading `/` site route (e.g. `/docs/install/`, `/assets/hero.png` in Astro/Next/Vite)
        // OS absolute roots (`/data/`, `/Users/`, `/home/`, `/var/`, etc.) were already caught above as `absolute_local_link`.
        if (decoded.startsWith('/')) {
          rootRelativeLinksSkipped++;
          continue;
        }

        // 3. Relative local link (resolved relative to the Markdown file's own directory!)
        const mdDir = path.dirname(f.full);
        const resolved = path.resolve(mdDir, decoded);

        if (!isPathInsideRoot(resolved, rootBoundaryReal)) {
          findings.push({
            severity: 'high',
            kind: 'escaping_repo_link',
            file: f.rel,
            line: lineNo,
            link: target,
            note: '相对链接越出仓库根目录',
          });
          continue;
        }

        let exists = false;
        try {
          fs.lstatSync(resolved);
          exists = true;
        } catch {
          exists = false;
        }

        if (!exists) {
          // Check classic §3 pitfall: author wrote repo-root path inside `docs/x.md` (e.g. `docs/assets/y.png` -> `docs/docs/assets/y.png`)
          const fromRootCandidate = path.resolve(rootBoundaryReal, decoded);
          const rootCandidateExists = isPathInsideRoot(fromRootCandidate, rootBoundaryReal) && fs.existsSync(fromRootCandidate);
          const suggestedRel = rootCandidateExists
            ? normalizePosix(path.relative(mdDir, fromRootCandidate))
            : null;
          findings.push({
            severity: 'high',
            kind: 'broken_local_link',
            file: f.rel,
            line: lineNo,
            link: target,
            ...(rootCandidateExists
              ? {
                  hint: 'possible_repo_root_relative_path',
                  suggested_relative_link: suggestedRel,
                  note: `相对路径按文档所在目录解析不存在；该目标在仓库根存在，可能应改为 ${suggestedRel}`,
                }
              : {
                  note: '本地链接目标不存在',
                }),
          });
          continue;
        }

        // Verify resolved realpath does not escape repo via symlink / Windows junction
        try {
          const realTarget = fs.realpathSync(resolved);
          if (!isPathInsideRoot(realTarget, rootBoundaryReal)) {
            findings.push({
              severity: 'high',
              kind: 'escaping_symlink_link',
              file: f.rel,
              line: lineNo,
              link: target,
              note: '本地链接通过符号链接/联接指向仓库外部路径',
            });
          }
        } catch (e) {
          findings.push({
            severity: 'high',
            kind: 'broken_local_link',
            file: f.rel,
            line: lineNo,
            link: target,
            note: `符号链接目标无效: ${e.code || e.message}`,
          });
        }
      }
    }
  }

  const incomplete = skipped.length > 0;
  const highCount = findings.filter((f) => f.severity === 'high').length;
  const mediumCount = findings.filter((f) => f.severity === 'medium').length;

  return {
    facts: {
      scan_completed: true,
      target_dir: targetDir,
      calibration: {
        markdown_files_checked: markdownFilesChecked,
        local_links_checked: localLinksChecked,
        external_links_skipped: externalLinksSkipped,
        root_relative_links_skipped: rootRelativeLinksSkipped,
      },
      findings_count: findings.length,
      high_count: highCount,
      medium_count: mediumCount,
      findings,
      scopes_checked: ['markdown_structural_links'],
      scopes_skipped: [],
      skipped,
    },
    exitCode: incomplete ? 2 : 0,
  };
}

function printHelp() {
  console.log(`Usage: node check_links.mjs [target_dir] [--out <file>] [--help]
Structural validator for local Markdown links and images (detects broken relative paths, docs/docs/ doubled paths, absolute OS links, and repo-escaping links/symlinks).
Exit codes: 0 = full coverage scan complete, 1 = error/invalid CLI, 2 = incomplete coverage.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const parsed = parseCliArgs(process.argv.slice(2), { valueFlags: ['out'] });
  if (!parsed.ok) {
    console.log(JSON.stringify({ scan_completed: false, error: parsed.error }, null, 2));
    process.exit(1);
  }
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }
  const { facts, exitCode } = await run({ target: parsed.target || process.cwd() });
  if (parsed.flags.out && facts.scan_completed) {
    const outPath = path.resolve(parsed.flags.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(facts, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify(facts, null, 2));
  process.exit(exitCode);
}
