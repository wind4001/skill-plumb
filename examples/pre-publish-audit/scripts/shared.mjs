// Shared zero-dep utilities for D-group pre-publish-audit scripts.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const DEFAULT_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.cache',
  '.idea',
  '.vscode',
]);

export const BINARY_ASSET_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.lib', '.pdb',
  '.pyc', '.pyo', '.class', '.jar', '.war', '.wasm',
  '.wav', '.mp3', '.m4a', '.mp4', '.mov', '.avi', '.mkv', '.ogg', '.flac', '.aac', '.webm',
  '.sqlite', '.sqlite3', '.db', '.p12', '.pfx', '.jks', '.keystore', '.kdbx',
]);

export const MAX_TEXT_BYTES = 512 * 1024;

export function parseCliArgs(argv, schema = {}) {
  const valueFlags = new Set(schema.valueFlags || []);
  const multiValueFlags = new Set(schema.multiValueFlags || []);
  const boolFlags = new Set(schema.boolFlags || []);
  const flags = {};
  for (const k of multiValueFlags) flags[k] = [];
  const positionals = [];
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '-h' || raw === '--help') {
      help = true;
      continue;
    }
    if (raw === '--') {
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j]);
      break;
    }
    if (raw.startsWith('--')) {
      const eqIdx = raw.indexOf('=');
      const name = eqIdx >= 0 ? raw.slice(2, eqIdx) : raw.slice(2);
      const inlineVal = eqIdx >= 0 ? raw.slice(eqIdx + 1) : null;

      if (boolFlags.has(name)) {
        if (eqIdx >= 0) {
          return { ok: false, error: `flag --${name} does not accept a value` };
        }
        flags[name] = true;
        continue;
      }

      if (valueFlags.has(name) || multiValueFlags.has(name)) {
        let val;
        if (eqIdx >= 0) {
          val = inlineVal;
          if (!val || !val.trim()) {
            return { ok: false, error: `flag --${name} requires a non-empty value` };
          }
        } else {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('-')) {
            return { ok: false, error: `flag --${name} requires a value` };
          }
          val = next;
          i++;
        }
        if (multiValueFlags.has(name)) {
          flags[name].push(val);
        } else {
          if (flags[name] !== undefined) {
            return { ok: false, error: `flag --${name} specified multiple times` };
          }
          flags[name] = val;
        }
        continue;
      }

      return { ok: false, error: `unknown flag: --${name}` };
    }
    if (raw.startsWith('-') && raw.length > 1) {
      return { ok: false, error: `unknown short flag: ${raw}` };
    }
    positionals.push(raw);
  }

  if (positionals.length > 1) {
    return { ok: false, error: `unexpected extra positional arguments: ${positionals.slice(1).join(' ')}` };
  }

  return { ok: true, help, target: positionals[0] || null, flags };
}

export function normalizePosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

const TEST_OR_FIXTURE_RE = /(?:^|\/)(?:__tests__|__mocks__|tests?|specs?|fixtures?|mocks?)\/|\.(?:test|spec)\.[^/]+$|(?:^|\/)verify_[^/]+\.mjs$/i;

export function isTestOrFixturePath(relPath) {
  return TEST_OR_FIXTURE_RE.test(normalizePosix(relPath));
}

export function isPathInsideRoot(candidatePath, rootReal) {
  const rel = path.relative(rootReal, candidatePath);
  if (rel === '') return true;
  if (rel === '..') return false;
  if (rel.startsWith('..' + path.sep)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

export function runGit(args, cwd, extraEnv = {}, maxBuffer = 20 * 1024 * 1024) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer,
    env: { ...process.env, ...extraEnv },
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error || null,
  };
}

export function findEnclosingGitMarker(targetDir) {
  const abs = path.resolve(targetDir);
  if (!fs.existsSync(abs)) {
    return {
      has_git_marker: false,
      marker_path: null,
      marker_type: 'none',
      repo_root: null,
      is_subdir: false,
      git_available: false,
      is_work_tree: false,
      head_commit: null,
      has_commits: false,
      error: `target path does not exist: ${abs}`,
    };
  }

  let hasMarker = false;
  let markerPath = null;
  let markerType = 'none';

  if (process.env.GIT_DIR && process.env.GIT_DIR.trim()) {
    hasMarker = true;
    markerPath = path.resolve(abs, process.env.GIT_DIR.trim());
    markerType = 'env';
  } else {
    const ceilings = (process.env.GIT_CEILING_DIRECTORIES || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((c) => path.resolve(c));

    let cur = abs;
    while (true) {
      const candidate = path.join(cur, '.git');
      try {
        const st = fs.lstatSync(candidate);
        hasMarker = true;
        markerPath = candidate;
        markerType = st.isDirectory() ? 'dir' : 'file';
        break;
      } catch {
        // continue walking upward
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      if (ceilings.some((c) => c === parent || (process.platform === 'win32' && c.toLowerCase() === parent.toLowerCase()))) {
        break;
      }
      cur = parent;
    }
  }

  if (!hasMarker) {
    return {
      has_git_marker: false,
      marker_path: null,
      marker_type: 'none',
      repo_root: null,
      is_subdir: false,
      git_available: true,
      is_work_tree: false,
      head_commit: null,
      has_commits: false,
      error: null,
    };
  }

  const wt = runGit(['rev-parse', '--is-inside-work-tree'], abs);
  if (wt.error) {
    return {
      has_git_marker: true,
      marker_path: markerPath,
      marker_type: markerType,
      repo_root: null,
      is_subdir: false,
      git_available: false,
      is_work_tree: false,
      head_commit: null,
      has_commits: false,
      error: `git execution failed: ${wt.error.message}`,
    };
  }
  if (wt.status !== 0 || wt.stdout.trim() !== 'true') {
    return {
      has_git_marker: true,
      marker_path: markerPath,
      marker_type: markerType,
      repo_root: null,
      is_subdir: false,
      git_available: true,
      is_work_tree: false,
      head_commit: null,
      has_commits: false,
      error: `git rev-parse failed inside enclosing git marker: ${(wt.stderr || wt.stdout).trim()}`,
    };
  }

  const top = runGit(['rev-parse', '--show-toplevel'], abs);
  const repoRoot = top.status === 0 && top.stdout.trim() ? path.resolve(top.stdout.trim()) : null;
  let absReal = abs;
  let rootReal = repoRoot;
  try { absReal = fs.realpathSync(abs); } catch {}
  try { if (repoRoot) rootReal = fs.realpathSync(repoRoot); } catch {}
  const isSubdir = !!(rootReal && absReal.toLowerCase() !== rootReal.toLowerCase());

  const head = runGit(['rev-parse', '--verify', 'HEAD'], abs);
  const hasCommits = head.status === 0 && /^[0-9a-f]{40}$/i.test(head.stdout.trim());

  return {
    has_git_marker: true,
    marker_path: markerPath,
    marker_type: markerType,
    repo_root: repoRoot,
    is_subdir: isSubdir,
    git_available: true,
    is_work_tree: true,
    head_commit: hasCommits ? head.stdout.trim() : null,
    has_commits: hasCommits,
    error: null,
  };
}

export function getGitFileSets(targetDir, gitInfo) {
  if (!gitInfo || !gitInfo.is_work_tree || !gitInfo.repo_root) {
    return { ok: false, tracked: new Set(), untracked: new Set(), error: gitInfo?.error || 'not_a_git_repository' };
  }
  const absTarget = path.resolve(targetDir);
  let targetReal = absTarget;
  let rootReal = path.resolve(gitInfo.repo_root);
  try { targetReal = fs.realpathSync(absTarget); } catch {}
  try { rootReal = fs.realpathSync(rootReal); } catch {}

  const trackedRes = runGit(['ls-files', '-z'], absTarget);
  if (trackedRes.error || trackedRes.status !== 0) {
    return {
      ok: false,
      tracked: new Set(),
      untracked: new Set(),
      error: `git ls-files failed: ${(trackedRes.error?.message || trackedRes.stderr || '').trim()}`,
    };
  }
  const tracked = new Set();
  for (const rel of trackedRes.stdout.split('\0')) {
    if (!rel) continue;
    tracked.add(normalizePosix(rel));
  }

  // Note: git status --porcelain prints paths relative to repo_root even when cwd is a subdir.
  const statusRes = runGit(['status', '--porcelain', '-z', '--untracked-files=all', '--', '.'], absTarget);
  if (statusRes.error || statusRes.status !== 0) {
    return {
      ok: false,
      tracked,
      untracked: new Set(),
      error: `git status failed: ${(statusRes.error?.message || statusRes.stderr || '').trim()}`,
    };
  }
  const untracked = new Set();
  const tokens = statusRes.stdout.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const repoRel = entry.slice(3);
    // For rename/copy entries (R/C), consume the second NUL-delimited path token
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    if (xy === '??') {
      const full = path.resolve(rootReal, repoRel);
      if (isPathInsideRoot(full, targetReal)) {
        const relToTarget = normalizePosix(path.relative(targetReal, full));
        if (relToTarget && !relToTarget.startsWith('..')) {
          untracked.add(relToTarget);
        }
      }
    }
  }

  return { ok: true, tracked, untracked, error: null };
}

export function verifyGitAddDryRun(targetDir, relPaths) {
  // Uses `git add -n -- <paths>` (the ground truth per SKILL.md §4; NEVER git check-ignore).
  const wouldAdd = new Set();
  const errors = [];
  if (!relPaths || relPaths.length === 0) return { ok: true, wouldAdd, errors };

  const chunkSize = 80;
  for (let i = 0; i < relPaths.length; i += chunkSize) {
    const chunk = relPaths.slice(i, i + chunkSize);
    const r = runGit(['-c', 'core.quotepath=false', 'add', '-n', '--', ...chunk], targetDir);
    if (r.error) {
      errors.push(r.error.message);
      continue;
    }
    // Note: git add -n exits 1 if ALL passed paths are ignored (prints "The following paths are ignored...").
    // That is expected when checking ignored files; parse stdout `add '<path>'` lines as truth.
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(/^add '(.+)'$/);
      if (m) {
        const repoOrTargetRel = normalizePosix(m[1]);
        wouldAdd.add(repoOrTargetRel);
      }
    }
  }
  return { ok: errors.length === 0, wouldAdd, errors };
}

export function walkSafe(rootDir, opts = {}) {
  const skipDirs = opts.skipDirs || DEFAULT_SKIP_DIRS;
  const absRoot = path.resolve(rootDir);
  const rootReal = fs.realpathSync(absRoot);
  const files = [];
  const skipped = [];
  const visitedDirs = new Set([rootReal]);

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      skipped.push({
        path: normalizePosix(path.relative(absRoot, dir)) || '.',
        reason: `unreadable_dir: ${e.code || e.message}`,
      });
      return;
    }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = normalizePosix(path.relative(absRoot, full));
      let lst;
      try {
        lst = fs.lstatSync(full);
      } catch (e) {
        skipped.push({ path: rel, reason: `stat_failed: ${e.code || e.message}` });
        continue;
      }

      if (lst.isSymbolicLink()) {
        let targetReal;
        try {
          targetReal = fs.realpathSync(full);
        } catch (e) {
          skipped.push({ path: rel, reason: `broken_symlink: ${e.code || e.message}` });
          continue;
        }
        if (!isPathInsideRoot(targetReal, rootReal)) {
          skipped.push({ path: rel, reason: 'symlink_outside_repo' });
          continue;
        }
        let targetStat;
        try {
          targetStat = fs.statSync(targetReal);
        } catch (e) {
          skipped.push({ path: rel, reason: `symlink_stat_failed: ${e.code || e.message}` });
          continue;
        }
        if (targetStat.isDirectory()) {
          if (skipDirs.has(ent.name)) continue;
          if (visitedDirs.has(targetReal)) continue;
          visitedDirs.add(targetReal);
          walk(full);
        } else if (targetStat.isFile()) {
          files.push({ rel, full, size: targetStat.size, isSymlink: true });
        }
        continue;
      }

      if (lst.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        let dirReal = full;
        try { dirReal = fs.realpathSync(full); } catch {}
        if (!isPathInsideRoot(dirReal, rootReal)) {
          skipped.push({ path: rel, reason: 'dir_outside_repo' });
          continue;
        }
        if (visitedDirs.has(dirReal)) continue;
        visitedDirs.add(dirReal);
        walk(full);
      } else if (lst.isFile()) {
        files.push({ rel, full, size: lst.size, isSymlink: false });
      }
    }
  }

  walk(absRoot);
  return { rootReal, files, skipped };
}

const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true });

export function safeReadTextFile(fullPath, relPath, sizeHint = null, maxBytes = MAX_TEXT_BYTES) {
  const ext = path.extname(relPath).toLowerCase();
  if (BINARY_ASSET_EXTS.has(ext)) {
    return { status: 'binary_asset' };
  }
  let size = sizeHint;
  if (size === null) {
    try {
      size = fs.statSync(fullPath).size;
    } catch (e) {
      return { status: 'error', reason: `stat_failed: ${e.code || e.message}` };
    }
  }
  if (size > maxBytes) {
    return { status: 'too_large', reason: `file_too_large (${size} bytes > ${maxBytes})` };
  }

  let buf;
  try {
    buf = fs.readFileSync(fullPath);
  } catch (e) {
    return { status: 'error', reason: `read_failed: ${e.code || e.message}` };
  }

  // Detect NUL bytes -> binary content
  const checkLen = Math.min(buf.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) {
      return { status: 'binary_content' };
    }
  }

  let text;
  try {
    text = utf8FatalDecoder.decode(buf);
  } catch {
    return { status: 'non_utf8', reason: 'invalid_utf8_text' };
  }

  // Guard against minified single-line bundles
  const lines = text.split(/\r?\n/);
  const maxLineLen = lines.reduce((m, l) => (l.length > m ? l.length : m), 0);
  if (maxLineLen > 12000 && lines.length < 30 && size > 64 * 1024) {
    return { status: 'minified', reason: `minified_bundle (max_line=${maxLineLen})` };
  }

  return { status: 'ok', text, lines };
}

export function redactSnippet(line, patternsToMask = []) {
  let out = String(line || '').trim();
  for (const pat of patternsToMask) {
    if (!pat) continue;
    if (typeof pat === 'string') {
      if (pat.length > 0) {
        out = out.split(pat).join('***REDACTED***');
      }
    } else if (pat instanceof RegExp) {
      const flags = pat.flags.includes('g') ? pat.flags : pat.flags + 'g';
      const re = new RegExp(pat.source, flags);
      out = out.replace(re, '***REDACTED***');
    }
  }
  // Always mask high-confidence secrets & query credentials as defense-in-depth
  out = out
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '***REDACTED_AWS_KEY***')
    .replace(/\bAKID[A-Za-z0-9]{16,}\b/g, '***REDACTED_TENCENT_ID***')
    .replace(/(?<![A-Za-z0-9_-])sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, '***REDACTED_SK_KEY***')
    .replace(/\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{36}\b/g, '***REDACTED_GH_TOKEN***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '***REDACTED_GH_TOKEN***')
    .replace(/((?:q-ak|q-signature|X-Amz-Credential|X-Amz-Signature|X-Oss-Signature|X-Cos-Signature)=)[^&\s"'<>)]+/gi, '$1***REDACTED***')
    .replace(/((?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?key|bearer[_-]?token|passwd|password)\s*["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-+/=.]{6,})/gi, '$1***REDACTED***');

  if (out.length > 160) {
    out = out.slice(0, 157) + '...';
  }
  return out;
}

export function maskEmail(email) {
  const s = String(email || '').trim();
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (/@users\.noreply\.(github|gitlab)\.com$/i.test(s) || /^noreply@/i.test(s)) {
    return s;
  }
  const prefix = local.length <= 2 ? local[0] : local.slice(0, 2);
  return `${prefix}***@${domain}`;
}
