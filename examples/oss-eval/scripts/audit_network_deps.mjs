#!/usr/bin/env node
// D-group oss-eval: Outbound network/telemetry signals, root + sub-package README/docs disclosure,
// explicit truncation & dir read error tracking, and declared vs observed runtime dependency weight.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from './audit_activity_claims.mjs';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'target']);
const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.rb', '.sh', '.bash', '.ps1', '.php', '.java']);
const BENIGN_DOMAINS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', 'example.com', 'example.org', 'example.net', 'example.invalid',
  'www.w3.org', 'w3.org', 'json-schema.org', 'json.schemastore.org', 'spdx.org', 'opensource.org',
  'creativecommons.org', 'mozilla.org', 'developer.mozilla.org', 'nodejs.org', 'npmjs.com', 'www.npmjs.com',
]);

const TELEMETRY_RE = /\b(posthog|sentry|mixpanel|amplitude|segment\.io|analytics-node|plausible|google-analytics|gtag|telemetry|phone[_-]?home|trackEvent|captureException)\b/i;
const UPDATE_CHECK_RE = /\b(update-notifier|check[_-]?update|latest[_-]?version|checkForUpdates)\b/i;
const HTTP_CLIENT_RE = /\b(fetch\s*\(|axios\.|https?\.request\s*\(|requests\.(?:get|post|put|request)\s*\(|httpx\.|urllib\.request)\b/;
const URL_RE = /https?:\/\/([a-zA-Z0-9.-]+)(?::\d+)?(?:\/[^\s"'`<>)\]}]*)?/g;
const DISCLOSURE_RE = /(telemetry|analytics|privacy|opt[- ]?out|do_not_track|offline|phone home|update check|telemetry_disabled|api\.|sends?\s+|遥测|隐私|出网|联网)/i;
const OPT_OUT_DISCLOSURE_RE = /(opt[- ]?out|do_not_track|telemetry_disabled|disabl(?:e|es|ed|ing)\s+telemetry|anonymous\s+usage|关闭遥测|禁用遥测)/i;
const HIGH_SIGNAL_DISCLOSURE_RE = /(telemetry|analytics|privacy|phone\s+home|usage\s+stats?|遥测|隐私|匿名)/i;
const DISCLOSURE_DOC_RE = /(?:^|\/)docs\/.*(?:privacy|security|telemetry|cli|data|network).*\.(?:md|mdx|rst|txt)$/i;

const CAPS = {
  telemetry: 40,
  update_check: 20,
  domains: 25,
  http_files: 30,
  disclosure: 40,
};

const PY_STDLIB = new Set([
  'abc', 'argparse', 'asyncio', 'base64', 'collections', 'concurrent', 'configparser', 'contextlib',
  'copy', 'csv', 'ctypes', 'dataclasses', 'datetime', 'decimal', 'difflib', 'email', 'enum', 'errno',
  'fnmatch', 'functools', 'gc', 'getpass', 'glob', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http',
  'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json', 'logging', 'math', 'mimetypes',
  'multiprocessing', 'numbers', 'operator', 'os', 'pathlib', 'pickle', 'platform', 'plistlib', 'posixpath',
  'pprint', 'queue', 'random', 're', 'secrets', 'select', 'shlex', 'shutil', 'signal', 'socket',
  'socketserver', 'sqlite3', 'ssl', 'stat', 'statistics', 'string', 'struct', 'subprocess', 'sys',
  'sysconfig', 'tarfile', 'tempfile', 'textwrap', 'threading', 'time', 'timeit', 'tomllib', 'traceback',
  'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uuid', 'warnings', 'weakref', 'xml', 'zipfile', 'zlib', '__future__',
]);

function walk(dir, rootDir, files, excluded, skipped) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    const rel = path.relative(rootDir, dir).replaceAll('\\', '/') || '.';
    skipped.push({ file: rel, reason: `DIR_READ_ERROR: ${e.code || e.message}` });
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(rootDir, abs).replaceAll('\\', '/');
    if (e.isDirectory()) {
      if (EXCLUDED_DIRS.has(e.name)) { excluded.push(rel); continue; }
      walk(abs, rootDir, files, excluded, skipped);
    } else if (e.isFile()) {
      files.push({ abs, rel });
    }
  }
}

function sanitizeSnippet(line) {
  return String(line)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(?<![A-Za-z0-9])(AKIA|AKID)[A-Za-z0-9]{8,}/g, '$1***')
    .trim()
    .slice(0, 140);
}

function realpathNative(p) {
  return typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

function isWithinLexical(absPath, rootDir) {
  const rel = path.relative(rootDir, absPath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveSafeRepoFile(refSpec, baseDir, rootDir) {
  let rootReal;
  try {
    rootReal = realpathNative(rootDir);
  } catch (e) {
    return { ok: false, reason: `ROOT_REALPATH_ERROR: ${e.code || e.message}` };
  }
  const candidateAbs = path.resolve(baseDir, refSpec);
  if (!isWithinLexical(candidateAbs, rootDir) && !isWithinLexical(candidateAbs, rootReal)) {
    return { ok: false, reason: `REF_OUTSIDE_REPO: ${refSpec}` };
  }
  try {
    fs.lstatSync(candidateAbs);
  } catch (e) {
    return { ok: false, reason: e.code === 'ENOENT' ? `MISSING_REF: ${refSpec}` : `STAT_REF_ERROR: ${refSpec} (${e.code || e.message})` };
  }
  let targetReal;
  try {
    targetReal = realpathNative(candidateAbs);
  } catch (e) {
    return { ok: false, reason: `UNRESOLVABLE_REF_LINK: ${refSpec} (${e.code || e.message})` };
  }
  const relReal = path.relative(rootReal, targetReal);
  if (relReal === '' || relReal.startsWith('..') || path.isAbsolute(relReal)) {
    return { ok: false, reason: `REF_ESCAPES_REPO_VIA_LINK: ${refSpec}` };
  }
  try {
    if (!fs.statSync(targetReal).isFile()) {
      return { ok: false, reason: `REF_NOT_A_FILE: ${refSpec}` };
    }
  } catch (e) {
    return { ok: false, reason: `STAT_REF_ERROR: ${refSpec} (${e.code || e.message})` };
  }
  return { ok: true, absPath: targetReal, relPath: relReal.replaceAll('\\', '/') };
}

function stripTomlComment(rawLine) {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < rawLine.length; i++) {
    const ch = rawLine[i];
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inDouble = false;
    } else if (inSingle) {
      if (ch === "'") inSingle = false;
    } else {
      if (ch === '"') inDouble = true;
      else if (ch === "'") inSingle = true;
      else if (ch === '#') return rawLine.slice(0, i);
    }
  }
  return rawLine;
}

function extractTomlStrings(str) {
  const out = [];
  for (const m of String(str || '').matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'/g)) {
    out.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return out;
}

function extractPkgName(spec) {
  const s = String(spec || '').trim();
  if (!s) return null;
  if (/^(?:git\+|https?:\/\/|svn\+|hg\+)/i.test(s)) {
    const egg = s.match(/[#&]egg=([A-Za-z0-9_.-]+)/i);
    return egg ? egg[1] : s.slice(0, 80);
  }
  const pkg = s.split(/[><=!~;\s\[@]/)[0].trim();
  return pkg || null;
}

function parseRequirementsFile(absPath, rootDir, visited = new Set()) {
  const resolved = path.resolve(absPath);
  const relCurrent = path.relative(rootDir, resolved).replaceAll('\\', '/');
  const deps = new Set();
  const referenced_files = [];
  const unresolved = [];

  if (visited.has(resolved)) return { deps, referenced_files, unresolved };
  visited.add(resolved);

  let text;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (e) {
    unresolved.push({ file: relCurrent, reason: `UNREADABLE_REQUIREMENTS_FILE: ${e.code || e.message}` });
    return { deps, referenced_files, unresolved };
  }

  // Join backslash line continuations
  const joined = text.replace(/\\\r?\n/g, ' ');
  for (const rawLine of joined.split(/\r?\n/)) {
    const line = rawLine.replace(/(?:^|\s)#.*$/, '').trim();
    if (!line) continue;

    // Indirect requirement include: -r file, --requirement file, --requirement=file, -rfile
    const mReq = line.match(/^(?:-r\s*|--requirement(?:=|\s+))(.+)$/i);
    if (mReq) {
      const refSpec = mReq[1].trim().replace(/^["']|["']$/g, '');
      if (/^https?:\/\//i.test(refSpec)) {
        unresolved.push({ file: relCurrent, reason: `REMOTE_REQUIREMENTS_REF: ${refSpec.slice(0, 100)}` });
        continue;
      }
      const safe = resolveSafeRepoFile(refSpec, path.dirname(resolved), rootDir);
      if (!safe.ok) {
        unresolved.push({ file: relCurrent, reason: safe.reason });
        continue;
      }
      referenced_files.push(safe.relPath);
      const sub = parseRequirementsFile(safe.absPath, rootDir, visited);
      for (const d of sub.deps) deps.add(d);
      for (const rf of sub.referenced_files) referenced_files.push(rf);
      for (const u of sub.unresolved) unresolved.push(u);
      continue;
    }

    // Editable install: -e <spec> / --editable <spec>
    const mEdit = line.match(/^(?:-e\s+|--editable(?:=|\s+))(.+)$/i);
    if (mEdit) {
      const spec = mEdit[1].trim();
      if (/^(?:git\+|https?:\/\/|svn\+|hg\+)/i.test(spec)) {
        const pkg = extractPkgName(spec);
        if (pkg) deps.add(pkg);
      } else if (!/^\.(?:\/|\\|$)/.test(spec) && !spec.startsWith('./') && !spec.startsWith('.\\')) {
        unresolved.push({ file: relCurrent, reason: `EDITABLE_DEP_SPEC: ${spec.slice(0, 80)}` });
      }
      continue;
    }

    // Standard pip options (constraints, index URLs, hashes, etc.)
    if (line.startsWith('-')) continue;

    const pkg = extractPkgName(line);
    if (pkg) deps.add(pkg);
  }
  return { deps, referenced_files, unresolved };
}

function parsePyprojectFile(absPath, rootDir) {
  const rel = path.relative(rootDir, absPath).replaceAll('\\', '/');
  const text = fs.readFileSync(absPath, 'utf8');
  const deps = new Set();
  const referenced_files = [];
  const unresolved = [];

  const lines = text.split(/\r?\n/);
  let section = '';
  let collectMode = null; // 'proj_deps' | 'proj_dynamic' | 'st_dyn_deps' | 'st_dyn_file'
  let collectBuf = '';
  let dynamicIncludesDeps = false;
  const setuptoolsDynamicFiles = [];
  let setuptoolsDynamicUnsupported = false;

  const flushCollect = (mode, buf) => {
    if (mode === 'proj_deps') {
      for (const s of extractTomlStrings(buf)) {
        const pkg = extractPkgName(s);
        if (pkg) deps.add(pkg);
      }
    } else if (mode === 'proj_dynamic') {
      for (const s of extractTomlStrings(buf)) {
        if (s.trim().toLowerCase() === 'dependencies') dynamicIncludesDeps = true;
      }
    } else if (mode === 'st_dyn_deps') {
      // Inline table like { file = ["deps/base.in"] } or { file = "deps/base.in" } or { attr = "..." }
      const fileMatch = buf.match(/\bfile\s*=\s*(\[[\s\S]*?\]|"[^"]*"|'[^']*')/);
      if (fileMatch) {
        for (const f of extractTomlStrings(fileMatch[1])) setuptoolsDynamicFiles.push(f);
      } else {
        setuptoolsDynamicUnsupported = true;
      }
      if (/\battr\s*=/.test(buf)) setuptoolsDynamicUnsupported = true;
    } else if (mode === 'st_dyn_file') {
      for (const f of extractTomlStrings(buf)) setuptoolsDynamicFiles.push(f);
    }
  };

  const countBalance = (str, openCh, closeCh) => {
    let bal = 0;
    let inS = false, inD = false, esc = false;
    for (const ch of str) {
      if (inD) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inD = false; }
      else if (inS) { if (ch === "'") inS = false; }
      else {
        if (ch === '"') inD = true;
        else if (ch === "'") inS = true;
        else if (ch === openCh) bal++;
        else if (ch === closeCh) bal--;
      }
    }
    return bal;
  };

  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    if (collectMode) {
      collectBuf += '\n' + line;
      const done = (collectMode === 'st_dyn_deps')
        ? countBalance(collectBuf, '{', '}') <= 0
        : countBalance(collectBuf, '[', ']') <= 0;
      if (done) {
        flushCollect(collectMode, collectBuf);
        collectMode = null;
        collectBuf = '';
      }
      continue;
    }

    const secMatch = line.match(/^\[([^\]]+)\]$/);
    if (secMatch) {
      section = secMatch[1].trim();
      continue;
    }

    if (section === 'project') {
      if (/^dependencies\s*=\s*\[/.test(line)) {
        const after = line.slice(line.indexOf('['));
        if (countBalance(after, '[', ']') <= 0) flushCollect('proj_deps', after);
        else { collectMode = 'proj_deps'; collectBuf = after; }
      } else if (/^dynamic\s*=\s*\[/.test(line)) {
        const after = line.slice(line.indexOf('['));
        if (countBalance(after, '[', ']') <= 0) flushCollect('proj_dynamic', after);
        else { collectMode = 'proj_dynamic'; collectBuf = after; }
      }
    } else if (section === 'tool.poetry.dependencies') {
      const m = line.match(/^([A-Za-z0-9_.-]+)\s*=/);
      if (m && m[1].toLowerCase() !== 'python') deps.add(m[1]);
    } else if (section === 'tool.setuptools.dynamic') {
      if (/^dependencies\s*=\s*\{/.test(line)) {
        const after = line.slice(line.indexOf('{'));
        if (countBalance(after, '{', '}') <= 0) flushCollect('st_dyn_deps', after);
        else { collectMode = 'st_dyn_deps'; collectBuf = after; }
      } else if (/^dependencies\s*=/.test(line)) {
        setuptoolsDynamicUnsupported = true;
      }
    } else if (section === 'tool.setuptools.dynamic.dependencies') {
      if (/^file\s*=\s*\[/.test(line)) {
        const after = line.slice(line.indexOf('['));
        if (countBalance(after, '[', ']') <= 0) flushCollect('st_dyn_file', after);
        else { collectMode = 'st_dyn_file'; collectBuf = after; }
      } else if (/^file\s*=\s*["']/.test(line)) {
        flushCollect('st_dyn_file', line.slice(line.indexOf('=') + 1));
      } else if (/^attr\s*=/.test(line)) {
        setuptoolsDynamicUnsupported = true;
      }
    }
  }
  if (collectMode) {
    flushCollect(collectMode, collectBuf);
  }

  for (const refSpec of setuptoolsDynamicFiles) {
    const safe = resolveSafeRepoFile(refSpec, path.dirname(absPath), rootDir);
    if (!safe.ok) {
      unresolved.push({ file: rel, reason: safe.reason });
      continue;
    }
    referenced_files.push(safe.relPath);
    const sub = parseRequirementsFile(safe.absPath, rootDir);
    for (const d of sub.deps) deps.add(d);
    for (const rf of sub.referenced_files) referenced_files.push(rf);
    for (const u of sub.unresolved) unresolved.push(u);
  }

  if (setuptoolsDynamicUnsupported) {
    unresolved.push({ file: rel, reason: 'UNRESOLVED_DYNAMIC_DEPENDENCIES: unsupported setuptools dynamic dependencies directive' });
  } else if (dynamicIncludesDeps && setuptoolsDynamicFiles.length === 0) {
    unresolved.push({ file: rel, reason: 'UNRESOLVED_DYNAMIC_DEPENDENCIES: [project].dynamic declares "dependencies" without statically resolvable file mapping' });
  }

  return {
    deps: [...deps].sort(),
    referenced_files: [...new Set(referenced_files)].sort(),
    unresolved,
    dynamic_declared: dynamicIncludesDeps,
  };
}

function parseSetupCfgFile(absPath, rootDir) {
  const rel = path.relative(rootDir, absPath).replaceAll('\\', '/');
  const text = fs.readFileSync(absPath, 'utf8');
  const deps = new Set();
  const referenced_files = [];
  const unresolved = [];
  const lines = text.split(/\r?\n/);
  let section = '';
  let inInstallRequires = false;

  for (const rawLine of lines) {
    if (/^\s*#/.test(rawLine) || !rawLine.trim()) continue;
    const sec = rawLine.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      inInstallRequires = false;
      continue;
    }
    if (section !== 'options') continue;
    if (/^install_requires\s*=/.test(rawLine)) {
      inInstallRequires = true;
      const rhs = rawLine.slice(rawLine.indexOf('=') + 1).trim();
      if (/^file:\s*/i.test(rhs)) {
        const refList = rhs.replace(/^file:\s*/i, '').split(',').map((s) => s.trim()).filter(Boolean);
        for (const refSpec of refList) {
          const safe = resolveSafeRepoFile(refSpec, path.dirname(absPath), rootDir);
          if (!safe.ok) {
            unresolved.push({ file: rel, reason: safe.reason });
            continue;
          }
          referenced_files.push(safe.relPath);
          const sub = parseRequirementsFile(safe.absPath, rootDir);
          for (const d of sub.deps) deps.add(d);
          for (const u of sub.unresolved) unresolved.push(u);
        }
        inInstallRequires = false;
      } else if (rhs) {
        const pkg = extractPkgName(rhs);
        if (pkg) deps.add(pkg);
      }
      continue;
    }
    if (inInstallRequires) {
      if (/^\s+/.test(rawLine)) {
        const pkg = extractPkgName(rawLine.trim());
        if (pkg) deps.add(pkg);
      } else {
        inInstallRequires = false;
      }
    }
  }
  return {
    deps: [...deps].sort(),
    referenced_files: [...new Set(referenced_files)].sort(),
    unresolved,
    dynamic_declared: false,
  };
}

function selectBalancedDisclosures(buckets, cap) {
  const order = ['root_readme', 'package_readme', 'docs'];
  const pickFromBucket = (items, limit) => {
    if (!items.length || limit <= 0) return [];
    const byFile = new Map();
    for (const item of items) {
      if (!byFile.has(item.file)) byFile.set(item.file, { t1: [], t2: [], t3: [] });
      const b = byFile.get(item.file);
      if (OPT_OUT_DISCLOSURE_RE.test(item.snippet)) b.t1.push(item);
      else if (HIGH_SIGNAL_DISCLOSURE_RE.test(item.snippet)) b.t2.push(item);
      else b.t3.push(item);
    }
    // Order files so files with opt-out/disable-telemetry disclosures come first, then high-signal, then alphabetically
    const fileQueues = [...byFile.entries()]
      .sort((a, b) => (b[1].t1.length > 0 ? 1 : 0) - (a[1].t1.length > 0 ? 1 : 0)
        || (b[1].t2.length > 0 ? 1 : 0) - (a[1].t2.length > 0 ? 1 : 0)
        || a[0].localeCompare(b[0]))
      .map(([, q]) => [...q.t1, ...q.t2, ...q.t3]);

    const picked = [];
    let round = 0;
    while (picked.length < limit) {
      let added = false;
      for (const q of fileQueues) {
        if (round < q.length) {
          picked.push(q[round]);
          added = true;
          if (picked.length >= limit) break;
        }
      }
      if (!added) break;
      round++;
    }
    return picked;
  };

  // Compute balanced quotas across non-empty buckets, redistributing unused slots
  const quotas = { root_readme: 0, package_readme: 0, docs: 0 };
  let remaining = cap;
  let active = order.filter((k) => buckets[k].length > 0);
  while (remaining > 0 && active.length > 0) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    let progress = false;
    const nextActive = [];
    for (const k of active) {
      if (remaining <= 0) break;
      const avail = buckets[k].length - quotas[k];
      const give = Math.min(avail, share, remaining);
      if (give > 0) {
        quotas[k] += give;
        remaining -= give;
        progress = true;
      }
      if (buckets[k].length > quotas[k]) nextActive.push(k);
    }
    if (!progress) break;
    active = nextActive;
  }

  return [
    ...pickFromBucket(buckets.root_readme, quotas.root_readme),
    ...pickFromBucket(buckets.package_readme, quotas.package_readme),
    ...pickFromBucket(buckets.docs, quotas.docs),
  ];
}

export async function run(options = {}) {
  const target = path.resolve(options.target || process.cwd());
  const facts = {
    scan_completed: false,
    top_level_entries: [],
    excluded_dirs: [],
    code_files_scanned: 0,
    telemetry_signals: [],
    telemetry_signals_total: 0,
    telemetry_signals_non_test_total: 0,
    telemetry_signals_truncated: false,
    update_check_signals: [],
    update_check_signals_total: 0,
    update_check_signals_truncated: false,
    outbound_code_domains: [],
    outbound_code_domains_total: 0,
    outbound_code_domains_non_test_total: 0,
    outbound_code_domains_truncated: false,
    http_client_files: [],
    http_client_files_total: 0,
    http_client_files_truncated: false,
    readme_disclosure: {
      root_readme_found: false,
      root_readme_hits: 0,
      package_readme_files_scanned: [],
      package_readme_hits: 0,
      docs_files_scanned: [],
      docs_hits: 0,
      mentions_total: 0,
      mentions_truncated: false,
      note: null,
    },
    readme_network_mentions: [],
    dependencies: {
      node_packages: [],
      python_manifests: [],
      python_observed_third_party_imports: [],
      unresolved_sources: [],
      summary: {},
    },
    skipped: [],
    scopes_checked: [],
    scopes_skipped: [],
  };

  try {
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return { facts: { ...facts, error: `target directory not found: ${target}` }, exitCode: 1 };
    }
    facts.top_level_entries = fs.readdirSync(target).filter((n) => n !== '.git').sort();
    const files = [];
    walk(target, target, files, facts.excluded_dirs, facts.skipped);

    const domainHits = new Map();
    const httpClientSet = new Set();
    const pyLocalMods = new Set();
    const pyImports = new Set();
    const disclosureBuckets = { root_readme: [], package_readme: [], docs: [] };
    const telNonTest = [];
    const telTest = [];
    let manifestParseErrors = 0;

    for (const { rel } of files) {
      if (rel.endsWith('.py')) {
        const parts = rel.split('/');
        pyLocalMods.add(parts[0].replace(/\.py$/, ''));
        if (parts.length > 1) pyLocalMods.add(parts[1].replace(/\.py$/, ''));
      }
    }

    const pushDisclosure = (scope, file, line, snippet) => {
      facts.readme_disclosure.mentions_total++;
      if (scope === 'root_readme') facts.readme_disclosure.root_readme_hits++;
      else if (scope === 'package_readme') facts.readme_disclosure.package_readme_hits++;
      else facts.readme_disclosure.docs_hits++;
      disclosureBuckets[scope].push({ scope, file, line, snippet });
    };

    for (const { abs, rel } of files) {
      const base = path.basename(rel);
      const ext = path.extname(base).toLowerCase();
      const isTestOrFixture = /(?:^|\/)(?:test|tests|__tests__|spec|examples?|fixtures?)\//i.test(rel);

      // Disclosure scan: root README + sub-package READMEs + security/privacy/cli docs
      const isRootReadme = /^readme(?:\.[a-z0-9_-]+)?\.md$/i.test(base) && !rel.includes('/');
      const isSubReadme = /^readme(?:\.[a-z0-9_-]+)?\.md$/i.test(base) && rel.includes('/') && !isTestOrFixture;
      const isDisclosureDoc = DISCLOSURE_DOC_RE.test(rel) && !isTestOrFixture;
      if (isRootReadme || isSubReadme || isDisclosureDoc) {
        if (isRootReadme) facts.readme_disclosure.root_readme_found = true;
        else if (isSubReadme) facts.readme_disclosure.package_readme_files_scanned.push(rel);
        else facts.readme_disclosure.docs_files_scanned.push(rel);
        try {
          const text = fs.readFileSync(abs, 'utf8');
          const lines = text.split(/\r?\n/);
          const scope = isRootReadme ? 'root_readme' : isSubReadme ? 'package_readme' : 'docs';
          for (let i = 0; i < lines.length; i++) {
            if (DISCLOSURE_RE.test(lines[i])) {
              pushDisclosure(scope, rel, i + 1, sanitizeSnippet(lines[i]));
            }
          }
        } catch (e) {
          facts.skipped.push({ file: rel, reason: `READ_ERROR: ${e.code || e.message}` });
        }
      }

      // Node manifest dependencies
      if (base === 'package.json') {
        try {
          const pkg = JSON.parse(fs.readFileSync(abs, 'utf8'));
          const deps = Object.keys(pkg.dependencies || {});
          const devDeps = Object.keys(pkg.devDependencies || {});
          const optDeps = Object.keys(pkg.optionalDependencies || {});
          facts.dependencies.node_packages.push({
            file: rel,
            name: pkg.name || null,
            runtime_dep_count: deps.length,
            runtime_deps: deps.slice(0, 30),
            runtime_deps_truncated: deps.length > 30,
            dev_dep_count: devDeps.length,
            optional_dep_count: optDeps.length,
          });
        } catch (e) {
          manifestParseErrors++;
          facts.skipped.push({ file: rel, reason: `JSON_PARSE_ERROR: ${e.message}` });
        }
      }

      // Python manifest dependencies (pyproject.toml / requirements*.txt / setup.cfg)
      if (base === 'pyproject.toml' || base === 'setup.cfg' || /^requirements(?:[._-][a-z0-9_-]+)?\.txt$/i.test(base)) {
        try {
          let parsed;
          if (base === 'pyproject.toml') {
            parsed = parsePyprojectFile(abs, target);
          } else if (base === 'setup.cfg') {
            parsed = parseSetupCfgFile(abs, target);
          } else {
            const r = parseRequirementsFile(abs, target);
            parsed = {
              deps: [...r.deps].sort(),
              referenced_files: [...new Set(r.referenced_files)].sort(),
              unresolved: r.unresolved,
              dynamic_declared: false,
            };
          }
          facts.dependencies.python_manifests.push({
            file: rel,
            declared_count: parsed.deps.length,
            declared_deps: parsed.deps.slice(0, 40),
            declared_deps_truncated: parsed.deps.length > 40,
            ...(parsed.referenced_files.length ? { referenced_files: parsed.referenced_files } : {}),
            ...(parsed.dynamic_declared ? { dynamic_declared: true } : {}),
            ...(parsed.unresolved.length ? { unresolved_count: parsed.unresolved.length } : {}),
          });
          for (const u of parsed.unresolved) {
            facts.dependencies.unresolved_sources.push(u);
          }
        } catch (e) {
          manifestParseErrors++;
          facts.skipped.push({ file: rel, reason: `MANIFEST_READ_ERROR: ${e.code || e.message}` });
        }
      }

      // Python setup.py install_requires detection (static list or dynamic unresolved marker)
      if (base === 'setup.py') {
        try {
          const setupText = fs.readFileSync(abs, 'utf8');
          const mIr = setupText.match(/\binstall_requires\s*=\s*([^\n#]+)/);
          if (mIr) {
            const rhsStart = mIr[1].trim();
            if (/^\[\s*\]/.test(rhsStart)) {
              facts.dependencies.python_manifests.push({ file: rel, declared_count: 0, declared_deps: [], declared_deps_truncated: false });
            } else {
              const listBlock = setupText.slice(setupText.indexOf(mIr[0])).match(/\binstall_requires\s*=\s*(\[[\s\S]*?\])/);
              if (listBlock && /^\[[\s"',A-Za-z0-9_.><=!~;\-\[\]()@\n\r/+:]*\]$/.test(listBlock[1])) {
                const parsedDeps = [...new Set(extractTomlStrings(listBlock[1]).map(extractPkgName).filter(Boolean))].sort();
                facts.dependencies.python_manifests.push({
                  file: rel,
                  declared_count: parsedDeps.length,
                  declared_deps: parsedDeps.slice(0, 40),
                  declared_deps_truncated: parsedDeps.length > 40,
                });
              } else {
                facts.dependencies.unresolved_sources.push({
                  file: rel,
                  reason: 'UNRESOLVED_SETUP_PY_INSTALL_REQUIRES: dynamic or non-literal install_requires in setup.py',
                });
              }
            }
          }
        } catch (e) {
          manifestParseErrors++;
          facts.skipped.push({ file: rel, reason: `MANIFEST_READ_ERROR: ${e.code || e.message}` });
        }
      }

      if (!CODE_EXTS.has(ext)) continue;

      let st;
      try { st = fs.statSync(abs); } catch (e) { facts.skipped.push({ file: rel, reason: `STAT_ERROR: ${e.code || e.message}` }); continue; }
      if (st.size > 512 * 1024) {
        facts.skipped.push({ file: rel, reason: `OVERSIZED_CODE_FILE_${st.size}B` });
        continue;
      }
      let buf;
      try { buf = fs.readFileSync(abs); } catch (e) { facts.skipped.push({ file: rel, reason: `READ_ERROR: ${e.code || e.message}` }); continue; }
      if (buf.includes(0)) {
        facts.skipped.push({ file: rel, reason: 'BINARY_WITH_CODE_EXT' });
        continue;
      }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch { facts.skipped.push({ file: rel, reason: 'NOT_UTF8' }); continue; }

      facts.code_files_scanned++;
      const isTestOrDoc = /(?:^|\/)(?:test|tests|__tests__|spec|examples?|fixtures?|docs?)\//i.test(rel) || /\.(?:test|spec)\./i.test(base);
      const lines = text.split(/\r?\n/);

      const maxLineLen = lines.reduce((m, l) => Math.max(m, l.length), 0);
      if (maxLineLen > 8000 && lines.length <= 20) {
        facts.skipped.push({ file: rel, reason: `MINIFIED_BUNDLE_LINE_${maxLineLen}C` });
        continue;
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const mTel = line.match(TELEMETRY_RE);
        if (mTel) {
          facts.telemetry_signals_total++;
          if (!isTestOrDoc) facts.telemetry_signals_non_test_total++;
          const rec = {
            file: rel, line: i + 1, match: mTel[1], is_test_or_doc: isTestOrDoc,
            snippet: sanitizeSnippet(line),
          };
          if (!isTestOrDoc && telNonTest.length < CAPS.telemetry) telNonTest.push(rec);
          else if (isTestOrDoc && telTest.length < CAPS.telemetry) telTest.push(rec);
        }
        const mUpd = line.match(UPDATE_CHECK_RE);
        if (mUpd) {
          facts.update_check_signals_total++;
          if (facts.update_check_signals.length < CAPS.update_check) {
            facts.update_check_signals.push({
              file: rel, line: i + 1, match: mUpd[1], is_test_or_doc: isTestOrDoc,
              snippet: sanitizeSnippet(line),
            });
          }
        }
        if (!isTestOrDoc && HTTP_CLIENT_RE.test(line)) {
          httpClientSet.add(rel);
        }
        for (const mUrl of line.matchAll(URL_RE)) {
          const domain = mUrl[1].toLowerCase();
          if (BENIGN_DOMAINS.has(domain) || domain.endsWith('.local')) continue;
          if (!domainHits.has(domain)) {
            domainHits.set(domain, { domain, total: 0, non_test_hits: 0, samples: [] });
          }
          const rec = domainHits.get(domain);
          rec.total++;
          if (!isTestOrDoc) rec.non_test_hits++;
          if (rec.samples.length < 3) {
            rec.samples.push({ file: rel, line: i + 1, is_test_or_doc: isTestOrDoc, url: mUrl[0].slice(0, 120) });
          }
        }
        if (ext === '.py' && !isTestOrDoc) {
          const mPy = line.match(/^\s*(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)/);
          if (mPy) {
            const mod = mPy[1];
            if (!PY_STDLIB.has(mod) && !pyLocalMods.has(mod)) pyImports.add(mod);
          }
        }
      }
    }

    // Prioritize non-test telemetry signals so test fixtures never crowd out real code hits
    facts.telemetry_signals = [...telNonTest, ...telTest].slice(0, CAPS.telemetry);

    // Balanced, high-signal-prioritized excerpt selection across root README, sub-package READMEs, and docs
    facts.readme_network_mentions = selectBalancedDisclosures(disclosureBuckets, CAPS.disclosure);

    const sortedDomains = [...domainHits.values()]
      .sort((a, b) => b.non_test_hits - a.non_test_hits || b.total - a.total);
    facts.outbound_code_domains_total = sortedDomains.length;
    facts.outbound_code_domains_non_test_total = sortedDomains.filter((d) => d.non_test_hits > 0).length;
    facts.outbound_code_domains = sortedDomains.slice(0, CAPS.domains);
    facts.outbound_code_domains_truncated = sortedDomains.length > CAPS.domains;

    const sortedHttp = [...httpClientSet].sort();
    facts.http_client_files_total = sortedHttp.length;
    facts.http_client_files = sortedHttp.slice(0, CAPS.http_files);
    facts.http_client_files_truncated = sortedHttp.length > CAPS.http_files;

    facts.telemetry_signals_truncated = facts.telemetry_signals_total > facts.telemetry_signals.length;
    facts.update_check_signals_truncated = facts.update_check_signals_total > facts.update_check_signals.length;
    facts.readme_disclosure.mentions_truncated = facts.readme_disclosure.mentions_total > facts.readme_network_mentions.length;
    facts.readme_disclosure.package_readme_files_scanned.sort();
    facts.readme_disclosure.docs_files_scanned.sort();
    if (facts.readme_disclosure.root_readme_hits === 0 && (facts.readme_disclosure.package_readme_hits > 0 || facts.readme_disclosure.docs_hits > 0)) {
      facts.readme_disclosure.note = '根 README 未提及网络/遥测，但在子包 README 或 docs/ 中发现披露条目';
    } else if (facts.readme_disclosure.mentions_total === 0) {
      facts.readme_disclosure.note = '根 README、子包 README 与匹配 docs/ 中均未命中网络/遥测关键词';
    }

    facts.dependencies.python_observed_third_party_imports = [...pyImports].sort();
    const totalNodeRuntimeDeps = facts.dependencies.node_packages.reduce((s, p) => s + p.runtime_dep_count, 0);
    const totalPyDeclaredDeps = facts.dependencies.python_manifests.reduce((s, p) => s + p.declared_count, 0);
    const pyObservedCount = facts.dependencies.python_observed_third_party_imports.length;
    const unresolvedCount = facts.dependencies.unresolved_sources.length;
    if (unresolvedCount > 0) {
      facts.scopes_skipped.push({
        scope: 'dependency_weight',
        reason: `unresolved indirect/dynamic dependency sources (${facts.dependencies.unresolved_sources.map((u) => `${u.file}: ${u.reason}`).join('; ')})`,
      });
    }
    const hasCoverageGap = manifestParseErrors > 0 || unresolvedCount > 0 || facts.skipped.length > 0;
    const hasAnyDepEvidence = totalNodeRuntimeDeps > 0 || totalPyDeclaredDeps > 0 || pyObservedCount > 0;

    facts.dependencies.summary = {
      node_package_files: facts.dependencies.node_packages.length,
      total_node_runtime_deps: totalNodeRuntimeDeps,
      python_manifest_files: facts.dependencies.python_manifests.length,
      total_python_declared_deps: totalPyDeclaredDeps,
      python_observed_third_party_imports_count: pyObservedCount,
      unresolved_dependency_sources_count: unresolvedCount,
      // 若有已知依赖 -> false；若无已知依赖且无解析/遍历/动态未解跳过 -> true；若存在跳过或未解动态来源导致无法确认无依赖 -> null (unknown)
      zero_external_runtime_deps: hasAnyDepEvidence ? false : (hasCoverageGap ? null : true),
    };

    facts.scopes_checked = ['outbound_and_telemetry', 'readme_and_subpackage_disclosure', 'dependency_weight'];
    facts.scan_completed = true;
    return { facts, exitCode: (facts.skipped.length || facts.scopes_skipped.length) ? 2 : 0 };
  } catch (e) {
    return { facts: { ...facts, scan_completed: false, error: String(e.message || e) }, exitCode: 1 };
  }
}

const __isCli = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (__isCli) {
  const parsed = parseCliArgs(process.argv.slice(2), {
    valueFlags: ['--out'],
    boolFlags: ['--help', '-h'],
  });
  if (!parsed.ok) {
    process.stderr.write(JSON.stringify({ scan_completed: false, error: `invalid arguments: ${parsed.error}` }, null, 2) + '\n');
    process.exit(1);
  }
  if (parsed.flags['--help'] || parsed.flags['-h']) {
    console.log('Usage: node scripts/audit_network_deps.mjs [dir] [--out <file>]');
    process.exit(0);
  }
  const { facts, exitCode } = await run({ target: parsed.target || process.cwd() });
  const serialized = JSON.stringify(facts, null, 2) + '\n';
  if (parsed.values['--out'] && exitCode !== 1 && facts.scan_completed) {
    const outAbs = path.resolve(parsed.values['--out']);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, serialized, 'utf8');
  }
  process.stdout.write(serialized);
  process.exit(exitCode);
}
