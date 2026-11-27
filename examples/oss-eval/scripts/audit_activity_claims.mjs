#!/usr/bin/env node
// D-group oss-eval: Git human-vs-bot activity, README badges/claims/workflows, and optional GitHub API metrics.
// Enforces strict remote identity, token-origin binding, and bounded pagination:
// - Unified repo identity reconciliation (URL + local origin + --repo) before any API call; refuses conflicts (exit 1)
// - Ambient GITHUB_TOKEN/GH_TOKEN strictly bound to official https://api.github.com; custom --api-base defaults to anonymous
// - Sanitizes remote origin URLs (never echoes embedded user:pass@ or query tokens)
// - Multi-page pure-issue sampling up to 20 issues; comments truncation judged strictly by Link rel="next"
// - Unreadable root README degrades cleanly into skipped/scopes_skipped (exit 2) without aborting GitHub API
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BOT_AUTHOR_RE = /\[bot\]$|dependabot|renovate|github-actions|snyk-bot|greenkeeper|mergify|semantic-release-bot|allcontributors/i;
const BOT_SUBJECT_RE = /^(?:ci:\s*update.*stats|chore\(deps(?:-dev)?\):|bump\s+\S+\s+from|auto-?update\s+badge|update\s+install\s+stats)/i;
const NON_SOURCE_FILE_RE = /^(?:\.github\/|docs?\/|README|CHANGELOG|LICENSE|NOTICE|CONTRIBUTING|SECURITY|.*(?:badge|stats|metrics).*\.json$)/i;
const CLAIM_LINE_RE = /(\b\d+(?:\.\d+)?[kKmM]\+?\s*(?:users?|downloads?|stars?|installs?)|benchmark|used by|trusted by|no telemetry|zero telemetry|multilingual|default\s+(?:model|support))/i;
const PLATFORM_ISSUE_RE = /\b(windows|win32|powershell|path|eperm|uninstall|settings\.json|enabledPlugins|telemetry|encoding|gbk|utf-?8)\b/i;
const MAINTAINER_ASSOC = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const TARGET_PURE_ISSUES = 20;
const ISSUE_PER_PAGE = 30;
const MAX_ISSUE_PAGES = 5;
const TARGET_RELEASES = 8;

function gitRun(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function isValidSlugSegment(seg) {
  return typeof seg === 'string' && /^[A-Za-z0-9_.-]+$/.test(seg) && seg !== '.' && seg !== '..';
}

export function parseGithubRemoteUrl(input, { allowSubpath = false } = {}) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;

  // 1) Explicit URL scheme: https://, http://, ssh://, git://, git+https://, git+http://, git+ssh://
  const schemeMatch = s.match(/^(?:git\+)?(https?|ssh|git):\/\//i);
  if (schemeMatch) {
    const normalized = s.replace(/^git\+/i, '');
    try {
      const u = new URL(normalized);
      const proto = u.protocol.toLowerCase();
      const host = u.hostname.toLowerCase();
      if (host !== 'github.com' && host !== 'www.github.com') return null;
      const defaultPorts = { 'https:': '443', 'http:': '80', 'ssh:': '22', 'git:': '9418' };
      if (u.port && u.port !== defaultPorts[proto]) return null;
      const parts = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean);
      if (parts.length < 2) return null;
      if (!allowSubpath && parts.length !== 2) return null;
      const owner = parts[0];
      const repo = parts[1].replace(/\.git$/i, '');
      if (!isValidSlugSegment(owner) || !isValidSlugSegment(repo)) return null;
      return `${owner}/${repo}`;
    } catch {
      return null;
    }
  }

  // 2) Anchored SCP-style SSH remote ONLY: git@github.com:owner/repo(.git)
  const scp = s.match(/^(?:[A-Za-z0-9._-]+@)?github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  if (scp && isValidSlugSegment(scp[1]) && isValidSlugSegment(scp[2])) {
    return `${scp[1]}/${scp[2]}`;
  }
  return null;
}

export function parseExplicitRepoSpec(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  const fromRemote = parseGithubRemoteUrl(s, { allowSubpath: false });
  if (fromRemote) return fromRemote;
  const clean = s.replace(/[?#].*$/, '');
  const parts = clean.split('/');
  if (parts.length === 2) {
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    if (isValidSlugSegment(owner) && isValidSlugSegment(repo)) return `${owner}/${repo}`;
  }
  return null;
}

export function parseGithubSlug(input) {
  return parseExplicitRepoSpec(input);
}

export function sanitizeRemoteUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const ghSlug = parseGithubRemoteUrl(s, { allowSubpath: false });
  if (ghSlug) return `https://github.com/${ghSlug}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, '$1').replace(/[?#].*$/, '');
    }
  }
  return s.replace(/^([^:@/\s]+):[^@/\s]+@/, '$1@').replace(/[?#].*$/, '');
}

export function parseCliArgs(argv, { valueFlags = [], boolFlags = [] } = {}) {
  const valSet = new Set(valueFlags);
  const boolSet = new Set(boolFlags);
  const values = {};
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--') && arg.includes('=')) {
      const eqIdx = arg.indexOf('=');
      const flag = arg.slice(0, eqIdx);
      const val = arg.slice(eqIdx + 1);
      if (!valSet.has(flag)) {
        return { ok: false, error: `unknown or non-value option: ${flag}` };
      }
      if (!val || val.startsWith('-')) {
        return { ok: false, error: `option ${flag} requires a non-flag value` };
      }
      values[flag] = val;
      continue;
    }
    if (boolSet.has(arg)) {
      flags[arg] = true;
      continue;
    }
    if (valSet.has(arg)) {
      const next = argv[i + 1];
      if (next === undefined || next === '' || next.startsWith('-')) {
        return {
          ok: false,
          error: `option ${arg} requires a value (got ${next === undefined ? 'end of arguments' : JSON.stringify(next)})`,
        };
      }
      values[arg] = next;
      i++;
      continue;
    }
    if (arg.startsWith('-')) {
      return { ok: false, error: `unknown option: ${arg}` };
    }
    positionals.push(arg);
    if (positionals.length > 1) {
      return { ok: false, error: `unexpected extra positional argument: ${arg}` };
    }
  }
  return { ok: true, target: positionals[0] || null, values, flags };
}

export function isOfficialGithubApiBase(apiBase) {
  try {
    const u = new URL(String(apiBase || ''));
    const cleanPath = u.pathname.replace(/\/+$/, '');
    return u.protocol === 'https:'
      && u.hostname.toLowerCase() === 'api.github.com'
      && (u.port === '' || u.port === '443')
      && cleanPath === '';
  } catch {
    return false;
  }
}

export function inspectLocalGitIdentity(target) {
  const inGit = gitRun(target, ['rev-parse', '--is-inside-work-tree']);
  if (inGit.error || inGit.status !== 0 || (inGit.stdout || '').trim() !== 'true') {
    return { is_git_repo: false, head_commit: null, origin_url: null, origin_slug: null, origin_kind: 'none' };
  }
  const head = (gitRun(target, ['rev-parse', 'HEAD']).stdout || '').trim() || null;
  const rem = gitRun(target, ['remote', 'get-url', 'origin']);
  const rawOriginUrl = (!rem.error && rem.status === 0) ? (rem.stdout || '').trim() : null;
  const originSlug = parseGithubRemoteUrl(rawOriginUrl, { allowSubpath: false });
  return {
    is_git_repo: true,
    head_commit: head,
    origin_url: sanitizeRemoteUrl(rawOriginUrl),
    origin_slug: originSlug,
    origin_kind: originSlug ? 'github' : (rawOriginUrl ? 'non_github' : 'none'),
  };
}

export function reconcileRepoIdentity({ urlSlug = null, explicitRepoSpec = null, localId = null, requireLocalMatchForUrl = false } = {}) {
  const id = localId || { is_git_repo: false, head_commit: null, origin_url: null, origin_slug: null, origin_kind: 'none' };
  const normUrlSlug = urlSlug ? parseExplicitRepoSpec(urlSlug) : null;
  const hasExplicit = explicitRepoSpec != null && String(explicitRepoSpec).trim() !== '';
  const explicitSlug = hasExplicit ? parseExplicitRepoSpec(explicitRepoSpec) : null;
  const localSlug = id.origin_slug || null;

  const baseIdentity = {
    requested_slug: normUrlSlug || explicitSlug || null,
    explicit_repo_arg: explicitSlug,
    local_origin_slug: localSlug,
    local_origin_url: id.origin_url,
    local_origin_kind: id.origin_kind || (localSlug ? 'github' : (id.origin_url ? 'non_github' : 'none')),
    effective_api_slug: null,
    api_canonical_full_name: null,
    api_name_differs: false,
    head_commit: id.head_commit,
    is_git_repo: !!id.is_git_repo,
    identity_verified: false,
    identity_status: 'mismatch_refused',
    matched: false,
  };

  if (hasExplicit && !explicitSlug) {
    return {
      ok: false,
      error: `invalid --repo specification (${String(explicitRepoSpec).slice(0, 80)}); expected owner/repo or GitHub URL`,
      identity: baseIdentity,
    };
  }

  if (normUrlSlug && explicitSlug && normUrlSlug.toLowerCase() !== explicitSlug.toLowerCase()) {
    return {
      ok: false,
      error: `repo identity conflict: requested URL (${normUrlSlug}) conflicts with --repo (${explicitSlug}); refusing to merge evidence`,
      identity: baseIdentity,
    };
  }

  if (normUrlSlug && requireLocalMatchForUrl) {
    if (!localSlug || localSlug.toLowerCase() !== normUrlSlug.toLowerCase()) {
      return {
        ok: false,
        error: `repo identity mismatch: requested ${normUrlSlug} does not match existing workdir origin (${localSlug || 'none'}); refusing to merge evidence`,
        identity: baseIdentity,
      };
    }
  }

  if (explicitSlug && localSlug && explicitSlug.toLowerCase() !== localSlug.toLowerCase()) {
    return {
      ok: false,
      error: `repo identity conflict: --repo (${explicitSlug}) does not match local origin (${localSlug}); refusing to merge evidence`,
      identity: baseIdentity,
    };
  }

  if (normUrlSlug) {
    const effective = localSlug || normUrlSlug;
    return {
      ok: true,
      identity: {
        ...baseIdentity,
        requested_slug: normUrlSlug,
        effective_api_slug: effective,
        identity_verified: !!localSlug && localSlug.toLowerCase() === normUrlSlug.toLowerCase(),
        identity_status: (localSlug && localSlug.toLowerCase() === normUrlSlug.toLowerCase()) ? 'verified_match' : 'url_requested',
        matched: localSlug ? localSlug.toLowerCase() === normUrlSlug.toLowerCase() : null,
      },
    };
  }

  if (explicitSlug) {
    if (localSlug) {
      return {
        ok: true,
        identity: {
          ...baseIdentity,
          requested_slug: explicitSlug,
          effective_api_slug: localSlug,
          identity_verified: true,
          identity_status: 'verified_match',
          matched: true,
        },
      };
    }
    return {
      ok: true,
      identity: {
        ...baseIdentity,
        requested_slug: explicitSlug,
        effective_api_slug: explicitSlug,
        identity_verified: false,
        identity_status: 'unverified_local_export',
        matched: null,
      },
    };
  }

  if (localSlug) {
    return {
      ok: true,
      identity: {
        ...baseIdentity,
        requested_slug: null,
        effective_api_slug: localSlug,
        identity_verified: true,
        identity_status: 'local_origin',
        matched: true,
      },
    };
  }

  return {
    ok: true,
    identity: {
      ...baseIdentity,
      requested_slug: null,
      effective_api_slug: null,
      identity_verified: true,
      identity_status: 'local_only',
      matched: true,
    },
  };
}

function analyzeGitActivity(target, facts) {
  const inGit = gitRun(target, ['rev-parse', '--is-inside-work-tree']);
  if (inGit.error || inGit.status !== 0 || (inGit.stdout || '').trim() !== 'true') {
    facts.scopes_skipped.push({ scope: 'git_activity', reason: inGit.error ? `git unavailable (${inGit.error.code || inGit.error.message})` : 'target is not a git work tree' });
    return;
  }
  facts.scopes_checked.push('git_activity');

  const isShallow = (gitRun(target, ['rev-parse', '--is-shallow-repository']).stdout || '').trim() === 'true';
  const headFull = (gitRun(target, ['rev-parse', 'HEAD']).stdout || '').trim() || null;
  const logRes = gitRun(target, ['log', '-n', '50', '--format=---COMMIT---%n%H%x1f%aI%x1f%an%x1f%ae%x1f%s', '--name-only']);
  if (logRes.error || logRes.status !== 0) {
    facts.scopes_skipped.push({ scope: 'git_activity', reason: `git log failed: ${logRes.error?.code || logRes.stderr || logRes.status}` });
    return;
  }

  const blocks = (logRes.stdout || '').split('---COMMIT---\n').filter((b) => b.trim());
  const commits = [];
  const authorCounts = new Map();
  let botCount = 0;
  let humanCount = 0;
  let latestHumanSource = null;

  for (const blk of blocks) {
    const lines = blk.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const [hash, dateIso, author, email, ...subjParts] = lines[0].split('\x1f');
    const subject = subjParts.join('\x1f');
    const files = lines.slice(1);
    const isBot = BOT_AUTHOR_RE.test(author || '') || BOT_AUTHOR_RE.test(email || '') || BOT_SUBJECT_RE.test(subject || '');
    const touchesSource = files.some((f) => !NON_SOURCE_FILE_RE.test(f));
    if (isBot) botCount++; else humanCount++;
    authorCounts.set(author || 'unknown', (authorCounts.get(author || 'unknown') || 0) + 1);
    const rec = { hash: (hash || '').slice(0, 10), date: dateIso, author, subject: (subject || '').slice(0, 80), is_bot: isBot, touches_source: touchesSource };
    commits.push(rec);
    if (!isBot && touchesSource && !latestHumanSource) {
      const daysAgo = Math.round((Date.now() - Date.parse(dateIso)) / 86400_000);
      latestHumanSource = { ...rec, days_ago: Number.isFinite(daysAgo) ? daysAgo : null };
    }
  }

  facts.git_activity = {
    head_commit: headFull,
    is_shallow: isShallow,
    commits_sampled: commits.length,
    human_commits: humanCount,
    bot_commits: botCount,
    bot_ratio_pct: commits.length ? Math.round((botCount / commits.length) * 1000) / 10 : null,
    latest_commit: commits[0] || null,
    latest_human_source_commit: latestHumanSource,
    top_authors: [...authorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })),
  };
}

function analyzeClaimsAndWorkflows(target, facts) {
  facts.scopes_checked.push('claims_and_workflows');
  const wfDir = path.join(target, '.github', 'workflows');
  try {
    if (fs.existsSync(wfDir) && fs.statSync(wfDir).isDirectory()) {
      facts.claims.workflows = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/i.test(f)).sort();
    }
  } catch (e) {
    facts.skipped.push({ file: '.github/workflows', reason: `DIR_READ_ERROR: ${e.code || e.message}` });
  }

  const walkSmall = (dir, depth = 0) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) {
      facts.skipped.push({ file: path.relative(target, dir).replaceAll('\\', '/') || '.', reason: `DIR_READ_ERROR: ${e.code || e.message}` });
      return;
    }
    for (const e of entries) {
      if (['.git', 'node_modules', '.venv'].includes(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(target, abs).replaceAll('\\', '/');
      if (e.isDirectory()) walkSmall(abs, depth + 1);
      else if (/(?:stats|badge|metrics|benchmark)/i.test(rel)) facts.claims.metric_generator_files.push(rel);
    }
  };
  walkSmall(target);
  facts.claims.metric_generator_files.sort();

  let rootEntries;
  try {
    rootEntries = fs.readdirSync(target);
  } catch (e) {
    facts.skipped.push({ file: '.', reason: `DIR_READ_ERROR: ${e.code || e.message}` });
    facts.scopes_skipped.push({ scope: 'readme_claims', reason: `root dir unreadable: ${e.code || e.message}` });
    return;
  }

  const readmePath = rootEntries.find((f) => /^readme(?:\.[a-z0-9_-]+)?\.md$/i.test(f));
  if (!readmePath) {
    facts.claims.readme_found = false;
    return;
  }
  facts.claims.readme_found = true;

  let text;
  try {
    text = fs.readFileSync(path.join(target, readmePath), 'utf8');
  } catch (e) {
    facts.claims.readme_unreadable = true;
    facts.skipped.push({ file: readmePath, reason: `READ_ERROR: ${e.code || e.message}` });
    facts.scopes_skipped.push({ scope: 'readme_claims', reason: `${readmePath}: READ_ERROR: ${e.code || e.message}` });
    return;
  }
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(/https?:\/\/img\.shields\.io\/[^\s"'`<>)\]]+/gi)) {
      facts.claims.shields_badges.push({ line: i + 1, url: m[0].slice(0, 180) });
    }
    if (/href\s*=\s*["']#["']|\]\(#\)/i.test(line)) {
      facts.claims.unclickable_badges.push({ line: i + 1, snippet: line.trim().slice(0, 140) });
    }
    if (CLAIM_LINE_RE.test(line)) {
      facts.claims.marketing_claim_lines_total++;
      if (facts.claims.marketing_claim_lines.length < 25) {
        facts.claims.marketing_claim_lines.push({ line: i + 1, snippet: line.trim().slice(0, 140) });
      }
    }
  }
  facts.claims.marketing_claim_lines_truncated = facts.claims.marketing_claim_lines_total > facts.claims.marketing_claim_lines.length;
}

function hasNextLink(linkHeader) {
  return typeof linkHeader === 'string' && /;\s*rel=["']?next["']?/i.test(linkHeader);
}

export function fetchViaWinInet(fullUrl, token = '') {
  const psScript = [
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
    "$h=@{'User-Agent'='oss-eval-d/1.2';'Accept'='application/vnd.github+json'};",
    "if ($env:OSS_EVAL_GH_TOKEN) { $h['Authorization'] = 'Bearer ' + $env:OSS_EVAL_GH_TOKEN };",
    "try {",
    "  $r = Invoke-WebRequest -UseBasicParsing -Uri $env:OSS_EVAL_GH_URL -Headers $h -TimeoutSec 15;",
    "  $out = @{ ok = $true; status = [int]$r.StatusCode; link = [string]$r.Headers['Link']; body = [string]$r.Content };",
    "} catch {",
    "  $sc = $null; try { $sc = [int]$_.Exception.Response.StatusCode } catch {};",
    "  $out = @{ ok = $false; status = $sc; reason = [string]$_.Exception.Message };",
    "}",
    "$out | ConvertTo-Json -Compress",
  ].join(' ');
  const childEnv = { ...process.env, OSS_EVAL_GH_URL: fullUrl };
  if (token) childEnv.OSS_EVAL_GH_TOKEN = token;
  else delete childEnv.OSS_EVAL_GH_TOKEN;
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', psScript], {
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 20000, env: childEnv,
  });
  if (!ps.error && ps.status === 0 && (ps.stdout || '').trim()) {
    try {
      const envOut = JSON.parse(ps.stdout);
      if (envOut.ok) {
        return {
          ok: true, via: 'win-wininet', http_status: envOut.status || 200,
          has_next_page: hasNextLink(envOut.link || ''), data: JSON.parse(envOut.body),
        };
      }
      return {
        ok: false, via: 'win-wininet', http_status: envOut.status ?? null,
        has_next_page: false, reason: envOut.status ? `HTTP ${envOut.status}: ${String(envOut.reason || '').slice(0, 120)}` : String(envOut.reason || 'wininet error').slice(0, 160),
      };
    } catch {}
  }
  const errTxt = (ps.stderr || '').trim().split(/\r?\n/)[0] || 'wininet fallback failed';
  return { ok: false, via: 'win-wininet', http_status: null, has_next_page: false, reason: errTxt.slice(0, 160) };
}

function resolveApiToken(apiBase, opts = {}) {
  if (isOfficialGithubApiBase(apiBase)) {
    return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  }
  // Custom --api-base defaults to anonymous; NEVER leak ambient GITHUB_TOKEN / GH_TOKEN.
  if (opts.customApiToken) return String(opts.customApiToken);
  const customTok = process.env.OSS_EVAL_CUSTOM_API_TOKEN || '';
  const customOrigin = process.env.OSS_EVAL_CUSTOM_API_ORIGIN || '';
  if (customTok && customOrigin) {
    try {
      if (new URL(apiBase).origin === new URL(customOrigin).origin) {
        return customTok;
      }
    } catch {}
  }
  return '';
}

export async function fetchGithubJson(apiPath, opts = {}) {
  const apiBase = (opts.apiBase || process.env.OSS_EVAL_GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
  const isOfficialBase = isOfficialGithubApiBase(apiBase);

  // Prefer authenticated gh CLI only for official https://api.github.com
  if (isOfficialBase && !opts.disableGh) {
    const ghCheck = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
    if (!ghCheck.error && ghCheck.status === 0) {
      const res = spawnSync('gh', ['api', '-i', apiPath], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      if (!res.error && res.status === 0) {
        const splitIdx = res.stdout.indexOf('\r\n\r\n') >= 0 ? res.stdout.indexOf('\r\n\r\n') : res.stdout.indexOf('\n\n');
        const sepLen = res.stdout.indexOf('\r\n\r\n') >= 0 ? 4 : 2;
        const hdrBlock = splitIdx >= 0 ? res.stdout.slice(0, splitIdx) : '';
        const bodyBlock = splitIdx >= 0 ? res.stdout.slice(splitIdx + sepLen) : res.stdout;
        return { ok: true, via: 'gh', http_status: 200, has_next_page: hasNextLink(hdrBlock), data: JSON.parse(bodyBlock) };
      }
      return { ok: false, via: 'gh', http_status: null, has_next_page: false, reason: (res.stderr || `gh exit ${res.status}`).trim().slice(0, 160) };
    }
  }

  const token = resolveApiToken(apiBase, opts);
  const headers = { 'User-Agent': 'oss-eval-d/1.2', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fullUrl = `${apiBase}/${apiPath.replace(/^\/+/, '')}`;
  try {
    const resp = await fetch(fullUrl, { headers, signal: AbortSignal.timeout(10000) });
    const linkHdr = resp.headers.get('link') || '';
    if (!resp.ok) {
      const rem = resp.headers.get('x-ratelimit-remaining');
      const reset = resp.headers.get('x-ratelimit-reset');
      const hint = rem === '0' ? `HTTP ${resp.status} rate limit exceeded (reset_unix=${reset})` : `HTTP ${resp.status}`;
      return { ok: false, via: 'https', http_status: resp.status, has_next_page: false, reason: hint };
    }
    return { ok: true, via: 'https', http_status: resp.status, has_next_page: hasNextLink(linkHdr), data: await resp.json() };
  } catch (e) {
    // Windows fallback: PowerShell Invoke-WebRequest honors WinINET system proxy; official GitHub origin only
    if (process.platform === 'win32' && isOfficialBase) {
      return fetchViaWinInet(fullUrl, token);
    }
    return { ok: false, via: 'https', http_status: null, has_next_page: false, reason: String(e.message || e) };
  }
}

export async function analyzeGithubApi(slug, facts, opts = {}) {
  const endpoints = {};
  const metaRes = await fetchGithubJson(`repos/${slug}`, opts);
  endpoints.repo = { ok: metaRes.ok, http_status: metaRes.http_status, via: metaRes.via, ...(metaRes.ok ? {} : { reason: metaRes.reason }) };
  if (!metaRes.ok) {
    facts.scopes_skipped.push({ scope: 'github_api', reason: `${metaRes.via}: ${metaRes.reason}` });
    facts.github_api = { repo: slug, endpoints };
    return;
  }
  const m = metaRes.data;
  const canonicalFullName = (typeof m.full_name === 'string' && parseExplicitRepoSpec(m.full_name))
    ? parseExplicitRepoSpec(m.full_name)
    : null;
  const canonicalMismatch = !!(canonicalFullName && canonicalFullName.toLowerCase() !== slug.toLowerCase());
  if (facts.repo_identity) {
    facts.repo_identity.api_canonical_full_name = canonicalFullName;
    facts.repo_identity.api_name_differs = canonicalMismatch;
    if (canonicalMismatch) {
      facts.repo_identity.identity_verified = false;
      facts.repo_identity.identity_status = 'api_canonical_name_mismatch';
      facts.repo_identity.matched = false;
      facts.scopes_skipped.push({
        scope: 'repo_identity_verification',
        reason: `GitHub API canonical full_name "${canonicalFullName}" differs from requested "${slug}" (possible rename, transfer, or redirect; verify identity before merging)`,
      });
    }
  }
  const stars = Number(m.stargazers_count || 0);
  // CRITICAL oss-eval invariant: MUST use subscribers_count, NEVER watchers_count
  const watchers = Number(m.subscribers_count || 0);
  const ratioPct = stars > 0 ? Math.round((watchers / stars) * 10000) / 100 : null;
  const ratioStatus = ratioPct == null ? 'no_stars'
    : ratioPct < 0.37 ? 'below_baseline_0.37pct'
      : ratioPct <= 0.86 ? 'within_normal_baseline_0.37_0.86pct'
        : 'above_baseline_0.86pct';

  facts.github_api = {
    via: metaRes.via,
    requested_repo: slug,
    repo: slug,
    canonical_full_name: canonicalFullName,
    repo_name_mismatch: canonicalMismatch,
    owner_login: m.owner?.login || slug.split('/')[0],
    owner_type: m.owner?.type || null,
    stars,
    forks: m.forks_count,
    watchers_subscribers_count: watchers,
    watchers_to_stars_pct: ratioPct,
    watchers_ratio_calibration: ratioStatus,
    open_issues_count: m.open_issues_count,
    license: m.license?.spdx_id || m.license?.name || null,
    created_at: m.created_at,
    pushed_at: m.pushed_at,
    size_kb: m.size,
    language: m.language,
    archived: !!m.archived,
    releases: null,
    recent_issues: null,
    issue_comments_sample: null,
    endpoints,
  };

  // 1) Releases — contract samples up to 8 most recent releases; failure MUST record scopes_skipped
  const relRes = await fetchGithubJson(`repos/${slug}/releases?per_page=${TARGET_RELEASES}`, opts);
  if (relRes.ok && Array.isArray(relRes.data)) {
    facts.github_api.releases = relRes.data.map((r) => ({ tag: r.tag_name, published_at: (r.published_at || '').slice(0, 10) }));
    endpoints.releases = {
      ok: true, http_status: relRes.http_status,
      sampled: relRes.data.length, sample_target: TARGET_RELEASES,
      has_more_releases: relRes.has_next_page,
      contract_note: `samples up to ${TARGET_RELEASES} most recent releases`,
    };
    facts.scopes_checked.push('github_releases');
  } else {
    endpoints.releases = { ok: false, http_status: relRes.http_status, reason: relRes.reason || 'invalid payload' };
    facts.scopes_skipped.push({ scope: 'github_releases', reason: relRes.reason || 'invalid payload' });
  }

  // 2) Recent issues — paginate until TARGET_PURE_ISSUES (20) pure non-PR issues, last page, or cap/error
  const pureIssues = [];
  const seenKeys = new Set();
  let pagesFetched = 0;
  let totalItemsFetched = 0;
  let prsFiltered = 0;
  let lastStatus = null;
  let lastHasNextPage = false;
  let stopReason = null;
  let firstPageError = null;
  let nextPageError = null;
  let paginationStalled = false;

  for (let page = 1; page <= MAX_ISSUE_PAGES; page++) {
    const issRes = await fetchGithubJson(`repos/${slug}/issues?state=all&per_page=${ISSUE_PER_PAGE}&page=${page}`, opts);
    if (!issRes.ok || !Array.isArray(issRes.data)) {
      if (page === 1) {
        firstPageError = { status: issRes.http_status, reason: issRes.reason || 'invalid payload' };
      } else {
        nextPageError = { page, status: issRes.http_status, reason: issRes.reason || 'invalid payload' };
        stopReason = 'next_page_failed';
      }
      break;
    }
    pagesFetched++;
    lastStatus = issRes.http_status;
    lastHasNextPage = issRes.has_next_page;
    totalItemsFetched += issRes.data.length;

    let newOnPage = 0;
    for (const item of issRes.data) {
      const key = item.number != null ? `n:${item.number}` : (item.id != null ? `id:${item.id}` : null);
      if (key && seenKeys.has(key)) continue;
      if (key) seenKeys.add(key);
      newOnPage++;
      if (item.pull_request) {
        prsFiltered++;
      } else if (pureIssues.length < TARGET_PURE_ISSUES) {
        pureIssues.push(item);
      }
    }

    if (pureIssues.length >= TARGET_PURE_ISSUES) {
      stopReason = 'target_reached';
      break;
    }
    if (!issRes.has_next_page) {
      stopReason = 'end_of_pages';
      break;
    }
    if (issRes.data.length === 0) {
      stopReason = 'empty_page';
      break;
    }
    if (page > 1 && newOnPage === 0) {
      paginationStalled = true;
      stopReason = 'pagination_stalled_duplicate_page';
      break;
    }
    if (page >= MAX_ISSUE_PAGES) {
      stopReason = 'page_cap_reached';
    }
  }

  if (firstPageError) {
    endpoints.issues = { ok: false, http_status: firstPageError.status, reason: firstPageError.reason };
    facts.scopes_skipped.push({ scope: 'github_issues', reason: firstPageError.reason });
  } else {
    const openCnt = pureIssues.filter((x) => x.state === 'open').length;
    const closedCnt = pureIssues.filter((x) => x.state === 'closed').length;
    const commentLen = (c) => (Array.isArray(c) ? c.length : Number(c || 0));
    const zeroReply = pureIssues.filter((x) => commentLen(x.comments) === 0).length;
    const platformHits = pureIssues
      .filter((x) => PLATFORM_ISSUE_RE.test(`${x.title} ${x.body || ''}`))
      .map((x) => ({ number: x.number, state: x.state, comments: commentLen(x.comments), title: String(x.title || '').slice(0, 80) }));

    const sampleComplete = (pureIssues.length >= TARGET_PURE_ISSUES) || (!lastHasNextPage && !nextPageError && !paginationStalled);

    endpoints.issues = {
      ok: !nextPageError,
      http_status: lastStatus,
      pages_fetched: pagesFetched,
      items_fetched: totalItemsFetched,
      pure_issues_sampled: pureIssues.length,
      sample_target: TARGET_PURE_ISSUES,
      prs_filtered: prsFiltered,
      has_next_page: lastHasNextPage,
      sample_complete: sampleComplete,
      stop_reason: stopReason,
      ...(nextPageError ? { next_page_error: nextPageError } : {}),
    };
    facts.github_api.recent_issues = {
      sampled_pure_issues: pureIssues.length,
      sample_target: TARGET_PURE_ISSUES,
      sample_complete: sampleComplete,
      pages_fetched: pagesFetched,
      prs_filtered: prsFiltered,
      has_next_page: lastHasNextPage,
      stop_reason: stopReason,
      open: openCnt,
      closed: closedCnt,
      zero_reply_count: pureIssues.length ? zeroReply : null,
      zero_reply_pct: pureIssues.length ? Math.round((zeroReply / pureIssues.length) * 1000) / 10 : null,
      platform_or_security_hits: platformHits.slice(0, 10),
    };
    if (!sampleComplete) {
      const detail = nextPageError
        ? `page ${nextPageError.page} failed (${nextPageError.reason})`
        : stopReason;
      facts.scopes_skipped.push({
        scope: 'github_issues',
        reason: `incomplete issue sample: collected ${pureIssues.length}/${TARGET_PURE_ISSUES} pure issues across ${pagesFetched} page(s) (${prsFiltered} PRs filtered; has_next_page=${lastHasNextPage}; stop=${detail})`,
      });
    } else {
      facts.scopes_checked.push('github_issues');
    }
  }

  // 3) 90-day issue comments — judge truncation strictly by Link rel="next" (NOT items.length >= 100)
  const sinceIso = new Date(Date.now() - 90 * 86400_000).toISOString();
  const ownerLogin = String(m.owner?.login || slug.split('/')[0]).toLowerCase();
  const cmtRes = await fetchGithubJson(`repos/${slug}/issues/comments?since=${encodeURIComponent(sinceIso)}&per_page=100`, opts);
  if (cmtRes.ok && Array.isArray(cmtRes.data)) {
    const items = cmtRes.data;
    const truncated = !!cmtRes.has_next_page;
    const dates = items.map((c) => c.created_at).filter(Boolean).sort();
    const byOwnerLogin = items.filter((c) => String(c.user?.login || '').toLowerCase() === ownerLogin).length;
    const maintainerItems = items.filter((c) => MAINTAINER_ASSOC.has(String(c.author_association || '').toUpperCase()));
    const maintainerLogins = [...new Set(maintainerItems.map((c) => c.user?.login).filter(Boolean))].sort();

    endpoints.issue_comments = {
      ok: true, http_status: cmtRes.http_status,
      sampled: items.length, has_next_page: cmtRes.has_next_page,
      window_requested_since: sinceIso,
      earliest_comment_in_sample: dates[0] || null,
      latest_comment_in_sample: dates[dates.length - 1] || null,
      window_fully_covered: !truncated,
    };
    facts.github_api.issue_comments_sample = {
      window_requested_since: sinceIso,
      sampled_comments: items.length,
      window_fully_covered: !truncated,
      earliest_comment_in_sample: dates[0] || null,
      latest_comment_in_sample: dates[dates.length - 1] || null,
      owner_type: m.owner?.type || null,
      comments_matching_repo_owner_login: byOwnerLogin,
      comments_by_maintainer_association: maintainerItems.length,
      maintainer_logins_in_sample: maintainerLogins,
      ...(m.owner?.type === 'Organization' ? { note: '组织仓库请看 comments_by_maintainer_association（OWNER/MEMBER/COLLABORATOR），组织账号名通常不直接发评论' } : {}),
    };
    if (truncated) {
      facts.scopes_skipped.push({
        scope: 'github_issue_comments_90d',
        reason: `only 1 page (${items.length} comments) sampled; 90-day window truncated (Link rel="next" present)`,
      });
    } else {
      facts.scopes_checked.push('github_issue_comments_90d');
    }
  } else {
    endpoints.issue_comments = { ok: false, http_status: cmtRes.http_status, reason: cmtRes.reason || 'invalid payload' };
    facts.scopes_skipped.push({ scope: 'github_issue_comments_90d', reason: cmtRes.reason || 'invalid payload' });
  }

  facts.scopes_checked.push('github_repo_metadata');
}

export async function analyzeRemoteReadme(slug, facts, opts = {}) {
  const res = await fetchGithubJson(`repos/${slug}/readme`, opts);
  if (!res.ok || !res.data) {
    const reason = res.reason || 'readme fetch failed';
    facts.scopes_skipped.push({ scope: 'github_readme', reason });
    facts.remote_readme = { found: false, reason };
    return;
  }
  const sizeBytes = Number(res.data.size || 0);
  if (sizeBytes > 524288) {
    const reason = `remote README exceeds 512 KiB (${sizeBytes} bytes)`;
    facts.scopes_skipped.push({ scope: 'github_readme', reason });
    facts.remote_readme = { found: false, name: res.data.name || 'README', size_bytes: sizeBytes, reason };
    return;
  }
  if (res.data.encoding !== 'base64' || typeof res.data.content !== 'string') {
    const reason = `unsupported remote README encoding: ${res.data.encoding || 'unknown'}`;
    facts.scopes_skipped.push({ scope: 'github_readme', reason });
    facts.remote_readme = { found: false, name: res.data.name || 'README', reason };
    return;
  }

  const text = Buffer.from(res.data.content.replace(/\s+/g, ''), 'base64').toString('utf8');
  const lines = text.split(/\r?\n/);
  const TEL_RE = /(telemetry|analytics|tracking|opt-?out|metrics|beacon|phone home|privacy)/i;
  const INST_RE = /(?:npm\s+(?:i|install)|npx\s+|pip\s+install|uv\s+pip|cargo\s+install|brew\s+install|docker\s+(?:run|pull)|winget\s+install|conda\s+install|curl\s+[^|\n]+\|\s*(?:ba)?sh)/i;
  const UNCLICK_RE = /\[!\[[^\]]*\]\([^)]+\)\]\(\s*#\s*\)/g;

  let telemetryCount = 0;
  const telemetrySamples = [];
  const installSamples = [];
  let unclickableCount = 0;
  const marketingClaims = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNum = i + 1;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (TEL_RE.test(rawLine)) {
      telemetryCount++;
      if (telemetrySamples.length < 8) telemetrySamples.push({ line: lineNum, snippet: trimmed.slice(0, 180) });
    }
    if (INST_RE.test(rawLine) && installSamples.length < 8) {
      installSamples.push({ line: lineNum, snippet: trimmed.slice(0, 180) });
    }
    const badgeMatches = rawLine.match(UNCLICK_RE);
    if (badgeMatches) unclickableCount += badgeMatches.length;
    if (CLAIM_LINE_RE.test(rawLine) && marketingClaims.length < 8) {
      marketingClaims.push({ line: lineNum, snippet: trimmed.slice(0, 180) });
    }
  }

  facts.remote_readme = {
    found: true,
    name: res.data.name || 'README',
    size_bytes: res.data.size ?? Buffer.byteLength(text, 'utf8'),
    telemetry_mentions_count: telemetryCount,
    telemetry_mention_samples: telemetrySamples,
    install_command_samples: installSamples,
    unclickable_badges_count: unclickableCount,
    marketing_claim_lines: marketingClaims,
  };
  facts.scopes_checked.push('github_readme');
}

export async function run(options = {}) {
  const target = path.resolve(options.target || process.cwd());
  const offline = !!options.offline;
  const facts = {
    scan_completed: false,
    repo_identity: null,
    git_activity: null,
    claims: {
      readme_found: false,
      readme_unreadable: false,
      workflows: [],
      metric_generator_files: [],
      shields_badges: [],
      unclickable_badges: [],
      marketing_claim_lines: [],
      marketing_claim_lines_total: 0,
      marketing_claim_lines_truncated: false,
    },
    github_api: null,
    scopes_checked: [],
    scopes_skipped: [],
    skipped: [],
  };

  try {
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return { facts: { ...facts, error: `target directory not found: ${target}` }, exitCode: 1 };
    }
    const localId = inspectLocalGitIdentity(target);
    const reconciled = reconcileRepoIdentity({
      urlSlug: options.urlSlug || null,
      explicitRepoSpec: options.repoSpec || null,
      localId,
      requireLocalMatchForUrl: !!options.urlSlug,
    });
    facts.repo_identity = reconciled.identity;
    if (!reconciled.ok) {
      return { facts: { ...facts, scan_completed: false, error: reconciled.error }, exitCode: 1 };
    }

    if (reconciled.identity.identity_status === 'unverified_local_export') {
      facts.scopes_skipped.push({
        scope: 'repo_identity_verification',
        reason: `local directory has no verifiable GitHub origin; --repo (${reconciled.identity.effective_api_slug}) is user-declared only`,
      });
    }

    analyzeGitActivity(target, facts);
    analyzeClaimsAndWorkflows(target, facts);

    const slug = reconciled.identity.effective_api_slug;
    if (offline) {
      facts.scopes_skipped.push({ scope: 'github_api', reason: 'offline mode requested' });
    } else if (slug) {
      await analyzeGithubApi(slug, facts, {
        apiBase: options.apiBase,
        disableGh: options.disableGh,
        customApiToken: options.customApiToken,
      });
    } else {
      facts.scopes_checked.push('non_github_local_repo');
    }

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
    valueFlags: ['--repo', '--api-base'],
    boolFlags: ['--offline', '--help', '-h'],
  });
  if (!parsed.ok) {
    console.log(JSON.stringify({ scan_completed: false, error: `invalid arguments: ${parsed.error}` }, null, 2));
    process.exit(1);
  }
  if (parsed.flags['--help'] || parsed.flags['-h']) {
    console.log('Usage: node scripts/audit_activity_claims.mjs [dir] [--repo owner/repo] [--api-base <url>] [--offline]');
    process.exit(0);
  }
  const { facts, exitCode } = await run({
    target: parsed.target || process.cwd(),
    repoSpec: parsed.values['--repo'] || null,
    apiBase: parsed.values['--api-base'] || null,
    offline: !!parsed.flags['--offline'],
  });
  console.log(JSON.stringify(facts, null, 2));
  process.exit(exitCode);
}
