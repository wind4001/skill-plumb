#!/usr/bin/env node
// D-group pre-publish-audit: §1 Secrets (Scope A tracked / B untracked / C git history),
// §1b PII substring exhaustion (working tree + git history), §3 Signed URLs, §10 refs/original.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseCliArgs,
  findEnclosingGitMarker,
  getGitFileSets,
  verifyGitAddDryRun,
  runGit,
  walkSafe,
  safeReadTextFile,
  redactSnippet,
  normalizePosix,
  realpathNative,
  isTestOrFixturePath,
} from './shared.mjs';

const SENSITIVE_FILE_RE = /(?:^|\/)(?:\.env(?:\.[^/]+)?|[^/]+\.(?:pem|key|p12|pfx|jks|keystore)|(?:id_rsa|id_ed25519|id_ecdsa|credentials\.json|service[-_]?account.*\.json))$/i;
const EXAMPLE_ENV_RE = /(?:^|\/)\.env\.(?:example|sample|template|dist|defaults?)$/i;

const HIGH_CONF_PATTERNS = [
  { kind: 'aws_access_key', severity: 'high', re: /(?<![A-Za-z0-9_])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9_])/ },
  { kind: 'tencent_secret_id', severity: 'high', re: /(?<![A-Za-z0-9_])AKID[A-Za-z0-9]{16,}(?![A-Za-z0-9_])/ },
  { kind: 'openai_sk_key', severity: 'high', re: /(?<![A-Za-z0-9_-])sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/ },
  { kind: 'github_pat', severity: 'high', re: /(?<![A-Za-z0-9_])(?:ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|ghu_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})(?![A-Za-z0-9_])/ },
  { kind: 'private_key_header', severity: 'high', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
];

const SIGNED_URL_RE = new RegExp([
  'q-' + 'ak=', 'q-' + 'signature=', 'X-Amz-' + 'Credential=', 'X-Amz-' + 'Signature=',
  'X-Oss-' + 'Signature=', 'X-Cos-' + 'Signature=', 'sig=[A-Za-z0-9%+/=]{20,}&' + 'se=',
].join('|'), 'i');

// Cheap pre-filter for high-volume git log -p diff lines (skips 99.9% of normal code lines in O(1))
const HISTORY_FAST_PREFILTER_RE = new RegExp([
  'AKIA', 'ASIA', 'AKID', 'sk-', 'gh[pous]_', 'github_pat_', 'PRIVATE KEY',
  'q-' + 'ak=', 'q-' + 'signature=', 'X-Amz-', 'X-Oss-', 'X-Cos-', '&' + 'se=',
].join('|'), 'i');

const GENERIC_ASSIGN_RE = /\b(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?key|bearer[_-]?token|passwd|password)\s*["']?\s*[:=]\s*["']([A-Za-z0-9_\-+/=.]{8,})["']/i;

const PLACEHOLDER_LINE_RE = /os\.getenv|os\.environ|process\.env|ENV\[|\$\{|\{\{|placeholder|your[_-]|changeme|example|dummy|sample|replace[_-]?me|fake[_-]|mock[_-]|<[^>]+>|xxxx|\*{3,}/i;
const TRIVIAL_VALUE_RE = /^(?:string|number|boolean|undefined|null|required|optional|password|secret|token|apikey|true|false|localhost|postgres|mysql|redis|admin|root|test|demo|0+|1+|x+|a+)$/i;

function isPlaceholderMatch(kind, matchedStr, line) {
  if (kind === 'openai_sk_key') {
    const body = matchedStr.replace(/^sk-(?:proj-|live-|test-)?/i, '');
    if (/^(.)\1{7,}$/.test(body)) return true;
    if (/placeholder|your|example|dummy|sample|xxxx|testkey/i.test(body)) return true;
  }
  if (kind === 'generic_secret_assign') {
    if (PLACEHOLDER_LINE_RE.test(line)) return true;
    if (TRIVIAL_VALUE_RE.test(matchedStr)) return true;
    if (/^(.)\1{5,}$/.test(matchedStr)) return true;
  }
  return false;
}

function buildPiiMatchers(rawTerms) {
  const unique = [];
  const seen = new Set();
  for (const item of rawTerms) {
    const parts = String(item || '').split(/[\r\n,]+/);
    for (const p of parts) {
      const v = p.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      unique.push(v);
    }
  }

  return unique.map((raw, idx) => {
    const isPureCjk = /^[\u4e00-\u9fff]+$/.test(raw);
    const minLen = isPureCjk ? Math.min(raw.length, 3) : Math.min(raw.length, 4);
    const lower = raw.toLowerCase();
    const subs = new Set();
    for (let i = 0; i <= lower.length - minLen; i++) {
      subs.add(lower.slice(i, i + minLen));
    }
    return {
      id: `pii#${idx + 1}`,
      rawLength: raw.length,
      minLen,
      lower,
      subs: [...subs],
    };
  });
}

function matchAndRedactPii(line, piiMatchers) {
  if (!piiMatchers.length || !line) return null;
  const lineLower = line.toLowerCase();
  const hits = [];
  const intervals = [];

  for (const m of piiMatchers) {
    let matchedAny = false;
    for (const sub of m.subs) {
      let pos = lineLower.indexOf(sub);
      while (pos !== -1) {
        matchedAny = true;
        intervals.push([pos, pos + sub.length]);
        pos = lineLower.indexOf(sub, pos + 1);
      }
    }
    if (matchedAny) {
      // Compute longest contiguous matched substring length for reporting (without exposing raw text)
      let longest = m.minLen;
      if (lineLower.includes(m.lower)) {
        longest = m.rawLength;
      } else {
        for (let L = m.rawLength - 1; L > m.minLen; L--) {
          let found = false;
          for (let i = 0; i <= m.lower.length - L; i++) {
            if (lineLower.includes(m.lower.slice(i, i + L))) {
              longest = L;
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }
      hits.push({
        pii_id: m.id,
        matched_length: longest,
        is_full_match: longest === m.rawLength,
      });
    }
  }

  if (!hits.length) return null;

  // Merge overlapping/adjacent intervals so zero raw PII chars survive redaction
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const iv of intervals) {
    if (!merged.length || iv[0] > merged[merged.length - 1][1]) {
      merged.push([iv[0], iv[1]]);
    } else if (iv[1] > merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = iv[1];
    }
  }

  let redacted = '';
  let cursor = 0;
  for (const [s, e] of merged) {
    redacted += line.slice(cursor, s) + '***REDACTED_PII***';
    cursor = e;
  }
  redacted += line.slice(cursor);

  return { hits, snippet: redactSnippet(redacted) };
}

function scanTextLines(lines, relPath, scope, piiMatchers, isExampleEnv, findings) {
  const isTest = isTestOrFixturePath(relPath);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const lineNo = i + 1;

    for (const pat of HIGH_CONF_PATTERNS) {
      const m = line.match(pat.re);
      if (m && !isPlaceholderMatch(pat.kind, m[0], line)) {
        findings.push({
          severity: pat.severity,
          kind: pat.kind,
          scope,
          file: relPath,
          line: lineNo,
          ...(isTest ? { is_test_or_fixture: true } : {}),
          snippet: redactSnippet(line, [m[0]]),
        });
      }
    }

    if (SIGNED_URL_RE.test(line)) {
      findings.push({
        severity: 'high',
        kind: 'signed_url',
        scope,
        file: relPath,
        line: lineNo,
        ...(isTest ? { is_test_or_fixture: true } : {}),
        snippet: redactSnippet(line),
      });
    }

    if (!isExampleEnv) {
      const gm = line.match(GENERIC_ASSIGN_RE);
      if (gm && !isPlaceholderMatch('generic_secret_assign', gm[1], line)) {
        findings.push({
          severity: 'medium',
          kind: 'generic_secret_assign',
          scope,
          file: relPath,
          line: lineNo,
          needs_review: true,
          ...(isTest ? { is_test_or_fixture: true } : {}),
          snippet: redactSnippet(line, [gm[1]]),
        });
      }
    }

    if (piiMatchers.length) {
      const pii = matchAndRedactPii(line, piiMatchers);
      if (pii) {
        for (const h of pii.hits) {
          findings.push({
            severity: 'high',
            kind: 'pii_substring_match',
            scope,
            file: relPath,
            line: lineNo,
            ...(isTest ? { is_test_or_fixture: true } : {}),
            pii_id: h.pii_id,
            matched_length: h.matched_length,
            is_full_match: h.is_full_match,
            snippet: pii.snippet,
          });
        }
      }
    }
  }
}

function streamGitHistoryScan(repoRoot, piiMatchers) {
  return new Promise((resolve) => {
    const findings = [];
    const seenKeys = new Set();
    let totalMatches = 0;
    let truncated = false;
    const MAX_HISTORY_FINDINGS = 150;

    const child = spawn(
      'git',
      ['-c', 'core.quotepath=false', 'log', '--all', '-p', '--no-color', '--pretty=format:___AUDIT_COMMIT___%H'],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let currentCommit = null;
    let currentFile = '(commit)';
    let buf = '';
    let stderr = '';
    let spawnErr = null;

    function recordFinding(f) {
      totalMatches++;
      const key = `${f.kind}|${f.commit}|${f.file}|${f.pii_id || ''}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      if (findings.length < MAX_HISTORY_FINDINGS) {
        findings.push(f);
      } else {
        truncated = true;
      }
    }

    function processLine(line) {
      if (line.startsWith('___AUDIT_COMMIT___')) {
        currentCommit = line.slice('___AUDIT_COMMIT___'.length).trim().slice(0, 12);
        currentFile = '(commit)';
        return;
      }
      if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6).trim();
        return;
      }
      if (line.startsWith('--- a/') && currentFile === '(commit)') {
        currentFile = line.slice(6).trim();
        return;
      }
      // Only inspect added/deleted diff content lines (skip +++ / --- file headers)
      if (!line || (line[0] !== '+' && line[0] !== '-')) return;
      if (line.startsWith('+++ ') || line.startsWith('--- ')) return;

      const content = line.slice(1);
      if (!content) return;
      // Fast-path skip normal code lines unless PII matching is active or secret prefilter hits
      const secretHint = content.length <= 16384 && HISTORY_FAST_PREFILTER_RE.test(content);
      if (!secretHint && !piiMatchers.length) return;

      const isTest = isTestOrFixturePath(currentFile);

      if (secretHint) {
        for (const pat of HIGH_CONF_PATTERNS) {
          const m = content.match(pat.re);
          if (m && !isPlaceholderMatch(pat.kind, m[0], content)) {
            recordFinding({
              severity: pat.severity,
              kind: pat.kind,
              scope: 'git_history',
              commit: currentCommit,
              file: currentFile,
              diff_op: line[0],
              ...(isTest ? { is_test_or_fixture: true } : {}),
              snippet: redactSnippet(content, [m[0]]),
            });
          }
        }

        if (SIGNED_URL_RE.test(content)) {
          recordFinding({
            severity: 'high',
            kind: 'signed_url',
            scope: 'git_history',
            commit: currentCommit,
            file: currentFile,
            diff_op: line[0],
            ...(isTest ? { is_test_or_fixture: true } : {}),
            snippet: redactSnippet(content),
          });
        }
      }

      if (piiMatchers.length && content.length <= 65536) {
        const pii = matchAndRedactPii(content, piiMatchers);
        if (pii) {
          for (const h of pii.hits) {
            recordFinding({
              severity: 'high',
              kind: 'pii_substring_match',
              scope: 'git_history',
              commit: currentCommit,
              file: currentFile,
              diff_op: line[0],
              ...(isTest ? { is_test_or_fixture: true } : {}),
              pii_id: h.pii_id,
              matched_length: h.matched_length,
              is_full_match: h.is_full_match,
              snippet: pii.snippet,
            });
          }
        }
      }
    }

    child.on('error', (err) => {
      spawnErr = err;
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        processLine(line);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });

    child.on('close', (code) => {
      if (buf) processLine(buf.replace(/\r$/, ''));
      resolve({
        ok: !spawnErr && code === 0,
        error: spawnErr ? spawnErr.message : (code !== 0 ? (stderr.trim() || `git log exited ${code}`) : null),
        findings,
        total_matches: totalMatches,
        truncated,
      });
    });
  });
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

  const noHistory = !!options.noHistory;
  const rawPii = [
    ...(Array.isArray(options.pii) ? options.pii : (options.pii ? [options.pii] : [])),
    ...(process.env.PRE_PUBLISH_PII ? [process.env.PRE_PUBLISH_PII] : []),
  ];
  const piiMatchers = buildPiiMatchers(rawPii);

  const ctx = options._ctx || null;
  const gitInfo = ctx ? ctx.gitInfo : findEnclosingGitMarker(targetDir);
  const scopesChecked = [];
  const scopesSkipped = [];
  const findings = [];
  const safelyIgnoredSensitiveFiles = [];
  const skipped = [];

  const walked = ctx ? ctx.walked : walkSafe(targetDir);
  skipped.push(...walked.skipped);

  let gitSets = ctx ? ctx.gitSets : { ok: false, tracked: new Set(), untracked: new Set(), error: null };
  if (gitInfo.is_work_tree) {
    if (!ctx) gitSets = getGitFileSets(targetDir, gitInfo);
    if (!gitSets.ok) {
      scopesSkipped.push({ scope: 'git_tracking', reason: gitSets.error });
    } else {
      scopesChecked.push('tracked_working_tree', 'untracked_working_tree');
    }
  } else {
    scopesChecked.push('working_tree_no_git');
    scopesSkipped.push({
      scope: 'git_tracking',
      reason: gitInfo.error || 'not_a_git_repository',
    });
  }

  let filesScanned = 0;
  let binaryFilesSkipped = 0;

  // Classify sensitive filenames on disk + verify untracked via `git add -n`
  const untrackedSensitiveCandidates = [];
  const fileByRel = new Map();
  for (const f of walked.files) {
    fileByRel.set(f.rel, f);
  }

  // Also catch tracked sensitive files from git ls-files even if deleted locally or under skipped dirs
  if (gitSets.ok) {
    for (const rel of gitSets.tracked) {
      if (SENSITIVE_FILE_RE.test(rel) && !EXAMPLE_ENV_RE.test(rel)) {
        findings.push({
          severity: 'high',
          kind: 'tracked_sensitive_file',
          scope: 'tracked',
          file: rel,
          note: '敏感文件已被 git 跟踪，push 会直接泄露',
        });
      }
    }
  }

  for (const f of walked.files) {
    const isExampleEnv = EXAMPLE_ENV_RE.test(f.rel);
    const isSensitiveName = SENSITIVE_FILE_RE.test(f.rel) && !isExampleEnv;

    if (gitSets.ok) {
      const isTracked = gitSets.tracked.has(f.rel);
      const isUntracked = gitSets.untracked.has(f.rel);

      if (!isTracked && !isUntracked) {
        // Properly ignored by .gitignore — record if sensitive name, do not scan ignored secrets as publish leaks
        if (isSensitiveName) {
          safelyIgnoredSensitiveFiles.push(f.rel);
        }
        continue;
      }

      if (isUntracked && isSensitiveName) {
        untrackedSensitiveCandidates.push(f.rel);
      }

      const scope = isTracked ? 'tracked' : 'untracked';
      const readRes = safeReadTextFile(f.full, f.rel, f.size);
      if (readRes.status === 'binary_asset' || readRes.status === 'binary_content') {
        binaryFilesSkipped++;
        continue;
      }
      if (readRes.status !== 'ok') {
        skipped.push({ path: f.rel, reason: readRes.reason });
        continue;
      }
      filesScanned++;
      scanTextLines(readRes.lines, f.rel, scope, piiMatchers, isExampleEnv, findings);
    } else {
      if (isSensitiveName) {
        findings.push({
          severity: 'high',
          kind: 'working_tree_sensitive_file',
          scope: 'working_tree',
          file: f.rel,
          note: '非 git 目录或无法确认忽略状态，存在敏感文件',
        });
      }
      const readRes = safeReadTextFile(f.full, f.rel, f.size);
      if (readRes.status === 'binary_asset' || readRes.status === 'binary_content') {
        binaryFilesSkipped++;
        continue;
      }
      if (readRes.status !== 'ok') {
        skipped.push({ path: f.rel, reason: readRes.reason });
        continue;
      }
      filesScanned++;
      scanTextLines(readRes.lines, f.rel, 'working_tree', piiMatchers, isExampleEnv, findings);
    }
  }

  // Confirm untracked sensitive filenames via ground-truth `git add -n` (per SKILL.md §4)
  if (gitSets.ok && untrackedSensitiveCandidates.length > 0) {
    const dry = verifyGitAddDryRun(targetDir, untrackedSensitiveCandidates);
    const repoRootReal = gitInfo.repo_root ? realpathNative(gitInfo.repo_root) : null;
    const targetReal = walked.rootReal;
    const subdirPrefix = repoRootReal && gitInfo.is_subdir
      ? normalizePosix(path.relative(repoRootReal, targetReal)) + '/'
      : '';

    for (const rel of untrackedSensitiveCandidates) {
      if (dry.wouldAdd.has(rel) || (subdirPrefix && dry.wouldAdd.has(subdirPrefix + rel))) {
        findings.push({
          severity: 'high',
          kind: 'untracked_unignored_sensitive_file',
          scope: 'untracked',
          file: rel,
          note: '未被 git 忽略，`git add .` 会直接纳入提交（经 git add -n 实测确认）',
        });
      } else {
        safelyIgnoredSensitiveFiles.push(rel);
      }
    }
    if (!dry.ok) {
      scopesSkipped.push({ scope: 'git_add_dry_run', reason: dry.errors.join('; ') });
    }
  }

  // Scope C: Git history
  let historySummary = {
    checked: false,
    commits_present: gitInfo.has_commits,
    history_sensitive_files: [],
    leftover_backup_refs: [],
    history_diff_matches_total: 0,
    truncated: false,
  };

  if (noHistory) {
    scopesSkipped.push({ scope: 'git_history', reason: 'disabled_by_flag (--no-history)' });
  } else if (!gitInfo.is_work_tree) {
    scopesSkipped.push({ scope: 'git_history', reason: gitInfo.error || 'not_a_git_repository' });
  } else if (!gitInfo.has_commits) {
    scopesChecked.push('git_history');
    historySummary.checked = true;
  } else {
    const repoRoot = gitInfo.repo_root || targetDir;

    // 1. Check historical added sensitive filenames
    const histNamesRes = runGit(['-c', 'core.quotepath=false', 'log', '--all', '--diff-filter=A', '--name-only', '--pretty=format:'], repoRoot);
    if (histNamesRes.error || histNamesRes.status !== 0) {
      scopesSkipped.push({
        scope: 'git_history_filenames',
        reason: (histNamesRes.error?.message || histNamesRes.stderr || 'git log --name-only failed').trim(),
      });
    } else {
      const seenHistFiles = new Set();
      for (const rawLine of histNamesRes.stdout.split(/\r?\n/)) {
        const rel = normalizePosix(rawLine.trim());
        if (!rel || seenHistFiles.has(rel)) continue;
        if (SENSITIVE_FILE_RE.test(rel) && !EXAMPLE_ENV_RE.test(rel)) {
          seenHistFiles.add(rel);
          historySummary.history_sensitive_files.push(rel);
          findings.push({
            severity: 'high',
            kind: 'history_sensitive_file',
            scope: 'git_history',
            file: rel,
            note: '敏感文件曾被提交进 git 历史（清理工作区无法消除历史记录）',
          });
        }
      }
    }

    // 2. Check leftover filter-branch refs/original (§10)
    const origRefs = runGit(['for-each-ref', '--format=%(refname)', 'refs/original'], repoRoot);
    if (!origRefs.error && origRefs.status === 0) {
      const refs = origRefs.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (refs.length > 0) {
        historySummary.leftover_backup_refs = refs;
        findings.push({
          severity: 'high',
          kind: 'leftover_filter_branch_backup_refs',
          scope: 'git_history',
          file: '.git/refs/original',
          refs,
          note: '检测到 filter-branch 残留备份引用 refs/original，旧历史对象仍未清除',
        });
      }
    }

    // 3. Check commit messages for high-confidence secrets & PII
    const msgRes = runGit(['log', '--all', '--pretty=format:%H%x1f%s %b%x1e'], repoRoot);
    if (!msgRes.error && msgRes.status === 0) {
      for (const rec of msgRes.stdout.split('\x1e')) {
        const sep = rec.indexOf('\x1f');
        if (sep < 0) continue;
        const sha = rec.slice(0, sep).trim().slice(0, 12);
        const msg = rec.slice(sep + 1).trim();
        if (!msg) continue;
        for (const pat of HIGH_CONF_PATTERNS) {
          const m = msg.match(pat.re);
          if (m && !isPlaceholderMatch(pat.kind, m[0], msg)) {
            findings.push({
              severity: pat.severity,
              kind: pat.kind,
              scope: 'git_history',
              commit: sha,
              file: '(commit-message)',
              snippet: redactSnippet(msg, [m[0]]),
            });
          }
        }
        if (piiMatchers.length) {
          const pii = matchAndRedactPii(msg, piiMatchers);
          if (pii) {
            for (const h of pii.hits) {
              findings.push({
                severity: 'high',
                kind: 'pii_substring_match',
                scope: 'git_history',
                commit: sha,
                file: '(commit-message)',
                pii_id: h.pii_id,
                matched_length: h.matched_length,
                is_full_match: h.is_full_match,
                snippet: pii.snippet,
              });
            }
          }
        }
      }
    }

    // 4. Stream full git log --all -p diff
    const histDiff = await streamGitHistoryScan(repoRoot, piiMatchers);
    if (!histDiff.ok) {
      scopesSkipped.push({ scope: 'git_history', reason: histDiff.error });
    } else {
      scopesChecked.push('git_history');
      historySummary.checked = true;
      historySummary.history_diff_matches_total = histDiff.total_matches;
      historySummary.truncated = histDiff.truncated;
      findings.push(...histDiff.findings);
    }
  }

  const incomplete = scopesSkipped.length > 0 || skipped.length > 0;
  const highCount = findings.filter((f) => f.severity === 'high').length;
  const mediumCount = findings.filter((f) => f.severity === 'medium').length;

  return {
    facts: {
      scan_completed: true,
      target_dir: targetDir,
      git: {
        is_work_tree: gitInfo.is_work_tree,
        repo_root: gitInfo.repo_root,
        is_subdir: gitInfo.is_subdir,
        marker_type: gitInfo.marker_type,
        head_commit: gitInfo.head_commit,
      },
      pii_config: {
        terms_count: piiMatchers.length,
        terms_meta: piiMatchers.map((m) => ({ id: m.id, length: m.rawLength, min_substring_len: m.minLen })),
      },
      calibration: {
        files_scanned: filesScanned,
        binary_files_skipped: binaryFilesSkipped,
        tracked_files_count: gitSets.ok ? gitSets.tracked.size : null,
        untracked_files_count: gitSets.ok ? gitSets.untracked.size : null,
      },
      safely_ignored_sensitive_files: safelyIgnoredSensitiveFiles,
      history: historySummary,
      findings_count: findings.length,
      high_count: highCount,
      medium_count: mediumCount,
      findings,
      scopes_checked: scopesChecked,
      scopes_skipped: scopesSkipped,
      skipped,
    },
    exitCode: incomplete ? 2 : 0,
  };
}

function printHelp() {
  console.log(`Usage: node audit_secrets.mjs [target_dir] [--pii <csv>] [--no-history] [--out <file>] [--help]
Scans tracked files, untracked unignored files, and git history for secrets, signed URLs, and PII substrings.
Exit codes: 0 = full coverage scan complete, 1 = error/invalid CLI, 2 = incomplete coverage.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const parsed = parseCliArgs(process.argv.slice(2), {
    valueFlags: ['out'],
    multiValueFlags: ['pii'],
    boolFlags: ['no-history'],
  });
  if (!parsed.ok) {
    console.log(JSON.stringify({ scan_completed: false, error: parsed.error }, null, 2));
    process.exit(1);
  }
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }
  const { facts, exitCode } = await run({
    target: parsed.target || process.cwd(),
    pii: parsed.flags.pii,
    noHistory: !!parsed.flags['no-history'],
  });
  if (parsed.flags.out && facts.scan_completed) {
    const outPath = path.resolve(parsed.flags.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(facts, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify(facts, null, 2));
  process.exit(exitCode);
}
