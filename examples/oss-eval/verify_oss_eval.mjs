#!/usr/bin/env node
// Comprehensive 22-case black-box regression test suite for oss-eval.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVAL_ALL = path.join(HERE, 'scripts', 'eval_all.mjs');
const AUDIT_ACTIVITY = path.join(HERE, 'scripts', 'audit_activity_claims.mjs');

function runScript(scriptPath, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    cwd: HERE,
    env: { ...process.env, ...extraEnv },
  });
  let j = null;
  try { j = JSON.parse(r.stdout || ''); } catch {}
  return { code: r.status, json: j, out: r.stdout || '', err: r.stderr || '' };
}

function runScriptAsync(scriptPath, args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [scriptPath, ...args], {
      encoding: 'utf8',
      cwd: HERE,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, ...extraEnv },
    }, (err, stdout, stderr) => {
      let j = null;
      try { j = JSON.parse(stdout || ''); } catch {}
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, json: j, out: stdout || '', err: stderr || '' });
    });
  });
}

function runEval(args, extraEnv = {}) { return runScript(EVAL_ALL, args, extraEnv); }
function runEvalAsync(args, extraEnv = {}) { return runScriptAsync(EVAL_ALL, args, extraEnv); }

function gitInitCommit(dir, commits, originUrl = null) {
  const g = (args, extraEnv = {}) => spawnSync('git', args, {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...extraEnv },
  });
  g(['init', '-q']);
  if (originUrl) g(['remote', 'add', 'origin', originUrl]);
  for (const c of commits) {
    for (const [rel, content] of Object.entries(c.files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    g(['add', '.']);
    g(['-c', `user.name=${c.author}`, '-c', `user.email=${c.email}`, 'commit', '-qm', c.msg], c.date ? { GIT_AUTHOR_DATE: c.date, GIT_COMMITTER_DATE: c.date } : {});
  }
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}
function ok(v, m) { if (!v) throw new Error(m || 'expected truthy'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

console.log('=== oss-eval Black-Box Regression Suite ===');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-eval-d-test-'));

try {
  // 01 Clean zero-dep MIT repo
  const cleanDir = path.join(tmpRoot, 'clean');
  fs.mkdirSync(cleanDir, { recursive: true });
  gitInitCommit(cleanDir, [{
    author: 'Alice', email: 'alice@example.org', msg: 'feat: initial implementation',
    files: {
      'LICENSE': 'MIT License\nPermission is hereby granted, free of charge...',
      'README.md': '# Clean Tool\n\nOffline CLI tool.\n',
      'package.json': JSON.stringify({ name: 'clean-tool', license: 'MIT', dependencies: {} }),
      'src/index.mjs': 'export function add(a, b) { return a + b; }\n',
    },
  }]);

  await t('01 clean zero-dep MIT repo exits 0 with positive signals and repo_identity.head_commit', () => {
    const r = runEval([cleanDir]);
    eq(r.code, 0, 'clean exit 0');
    eq(r.json.summary.red_flags.length, 0, 'zero red flags');
    eq(r.json.network_deps.dependencies.summary.zero_external_runtime_deps, true, 'zero runtime deps');
    ok(r.json.repo_identity?.head_commit && r.json.repo_identity.head_commit.length === 40, '40-char HEAD recorded');
    ok(r.json.summary.positive_signals.includes('no_package_lifecycle_install_hooks'), 'no install hooks');
    ok(r.json.summary.positive_signals.includes('no_external_http_domains_in_non_test_code'), 'no outbound code domains');
  });

  // 02 Minefield repo
  await t('02 minefield catches postinstall tampering, SSPL, dist/ telemetry, bot ratio, href="#" badge', () => {
    const d = path.join(tmpRoot, 'minefield');
    fs.mkdirSync(d, { recursive: true });
    gitInitCommit(d, [
      {
        author: 'RealDev', email: 'dev@example.org', msg: 'feat: core code',
        date: '2025-01-10T00:00:00Z',
        files: {
          'LICENSE': 'Server Side Public License (SSPL) v1',
          'README.md': '# ShinyPlugin\n\n<a href="#"><img src="https://img.shields.io/badge/users-600k+-blue"></a>\nTrusted by 500k+ users. Zero telemetry!\n',
          'package.json': JSON.stringify({
            name: 'shiny-plugin', license: 'SSPL-1.0',
            scripts: { postinstall: 'node scripts/install.mjs' },
            dependencies: { axios: '^1.7.0', 'posthog-node': '^4.0.0' },
          }),
          'scripts/install.mjs': 'import fs from "node:fs";\n// writes ~/.claude/settings.json enabledPlugins\nfs.writeFileSync("~/.claude/settings.json", "{}");\n',
          'dist/runtime.js': 'import posthog from "posthog-node";\nfetch("https://collector.evil-analytics.example/v1/event");\n',
          '.github/workflows/update-stats.yml': 'name: update stats\n',
        },
      },
      { author: 'github-actions[bot]', email: 'bot@example.org', msg: 'ci: update install stats', files: { 'stats.json': '{"n":1}' } },
      { author: 'github-actions[bot]', email: 'bot@example.org', msg: 'ci: update install stats', files: { 'stats.json': '{"n":2}' } },
      { author: 'github-actions[bot]', email: 'bot@example.org', msg: 'ci: update install stats', files: { 'stats.json': '{"n":3}' } },
      { author: 'github-actions[bot]', email: 'bot@example.org', msg: 'ci: update install stats', files: { 'stats.json': '{"n":4}' } },
    ]);
    const r = runEval([d]);
    eq(r.code, 0, 'minefield scan completes exit 0');
    const kinds = (r.json.install.findings || []).map((f) => f.kind);
    ok(kinds.includes('non_osi_license'), 'caught SSPL');
    ok(kinds.includes('host_settings_write'), 'caught settings.json tampering');
    ok(kinds.includes('plugin_enable_tamper'), 'caught enabledPlugins tampering');
    ok(r.json.network_deps.telemetry_signals.some((s) => s.file === 'dist/runtime.js'), 'caught dist/ telemetry');
    eq(r.json.activity_claims.git_activity.bot_ratio_pct, 80, '80% bot ratio');
    ok(r.json.activity_claims.claims.unclickable_badges.length >= 1, 'caught href="#"');
  });

  // 03 Strict --offline behavior (local dir exits 2; URL + missing dir refuses network clone with exit 1)
  await t('03 --offline records github_api gap on local dir and refuses network clone on missing dir', () => {
    const r1 = runEval([cleanDir, '--offline']);
    eq(r1.code, 2, 'local offline exits 2');
    ok(r1.json.summary.scopes_skipped.some((s) => s.scope === 'github_api'), 'github_api skipped');

    const emptyDest = path.join(tmpRoot, 'does-not-exist-clone');
    const r2 = runEval(['https://github.com/upstash/context7', '--workdir', emptyDest, '--offline']);
    eq(r2.code, 1, 'offline missing checkout refuses clone with exit 1');
    eq(r2.json.scan_completed, false, 'scan_completed false');
    ok(!fs.existsSync(emptyDest), 'did not clone over network');
    eq(r2.json.summary.positive_signals.length, 0, 'no positive signals on refused clone');
  });

  // 04 Codex High 1: URL + mismatched existing local git directory MUST fail (refuse identity merge)
  await t('04 URL + mismatched existing --workdir refuses to merge evidence (exit 1)', () => {
    const r = runEval(['https://github.com/upstash/context7', '--workdir', cleanDir, '--offline']);
    eq(r.code, 1, 'identity mismatch exits 1');
    eq(r.json.repo_identity.matched, false, 'matched=false');
    ok(String(r.json.error || '').includes('mismatch'), 'explicit mismatch error');
    eq(r.json.summary.positive_signals.length, 0, 'zero positive signals on mismatch');
  });

  // 05 Codex High 2: Mock GitHub API partial failures (503 releases, PR-only page 1, org maintainer association, pagination)
  await t('05 GitHub API partial failure / PR-only page 1 / org maintainer association / Link next handled accurately', async () => {
    const mockDir = path.join(tmpRoot, 'mock-org-repo');
    fs.mkdirSync(mockDir, { recursive: true });
    gitInitCommit(mockDir, [{
      author: 'Alice', email: 'alice@example.org', msg: 'feat: init',
      files: { 'LICENSE': 'MIT License', 'README.md': '# OrgTool\n', 'src/a.mjs': 'export const x = 1;\n' },
    }], 'https://github.com/acme-org/demo-tool.git');

    let mode = 'partial';
    let seenAuthHeader = null;
    const srv = http.createServer((req, res) => {
      if (req.headers.authorization) seenAuthHeader = req.headers.authorization;
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/repos/acme-org/demo-tool') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          owner: { login: 'acme-org', type: 'Organization' },
          stargazers_count: 10000, forks_count: 500, watchers_count: 10000, subscribers_count: 55,
          open_issues_count: 12, license: { spdx_id: 'MIT' },
          created_at: '2025-01-01T00:00:00Z', pushed_at: '2026-11-18T00:00:00Z',
          size: 400, language: 'TypeScript', archived: false,
        }));
      } else if (u.pathname === '/repos/acme-org/demo-tool/releases') {
        if (mode === 'partial') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Service Unavailable' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([{ tag_name: 'v1.0.0', published_at: '2026-11-10T00:00:00Z' }]));
        }
      } else if (u.pathname === '/repos/acme-org/demo-tool/issues') {
        if (mode === 'partial') {
          // 25 items, ALL pull_requests + Link rel="next"
          const prs = Array.from({ length: 25 }, (_, i) => ({ number: i + 1, state: 'open', comments: 0, title: `PR ${i}`, pull_request: {} }));
          res.writeHead(200, { 'Content-Type': 'application/json', Link: '<http://127.0.0.1/next>; rel="next"' });
          res.end(JSON.stringify(prs));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            { number: 1, state: 'closed', comments: 2, title: 'Fix Windows path' },
            { number: 2, state: 'open', comments: 0, title: 'Feature idea' },
          ]));
        }
      } else if (u.pathname === '/repos/acme-org/demo-tool/issues/comments') {
        const cmts = [
          { user: { login: 'alice-dev' }, author_association: 'MEMBER', created_at: '2026-11-15T00:00:00Z' },
          { user: { login: 'bob-maint' }, author_association: 'COLLABORATOR', created_at: '2026-11-16T00:00:00Z' },
          { user: { login: 'random-user' }, author_association: 'NONE', created_at: '2026-11-17T00:00:00Z' },
        ];
        const hdrs = mode === 'partial'
          ? { 'Content-Type': 'application/json', Link: '<http://127.0.0.1/cnext>; rel="next"' }
          : { 'Content-Type': 'application/json' };
        res.writeHead(200, hdrs);
        res.end(JSON.stringify(cmts));
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    });

    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;
    const base = `http://127.0.0.1:${port}`;
    try {
      // Partial mode assertions (ambient GITHUB_TOKEN / GH_TOKEN MUST NOT leak to custom --api-base!)
      const rp = await runEvalAsync([mockDir, '--api-base', base], { GITHUB_TOKEN: 'demo-mock-token', GH_TOKEN: 'demo-gh-token' });
      eq(rp.code, 2, 'partial API failure MUST exit 2 (not 0)');
      eq(seenAuthHeader, null, 'ambient GITHUB_TOKEN/GH_TOKEN MUST NOT be sent to custom --api-base');
      const g = rp.json.activity_claims.github_api;
      eq(g.watchers_subscribers_count, 55, 'uses subscribers_count=55, NOT watchers_count=10000');
      eq(g.watchers_to_stars_pct, 0.55, 'exact ratio 0.55%');
      eq(g.endpoints.releases.ok, false, 'releases endpoint marked failed');
      eq(g.endpoints.releases.http_status, 503, 'releases HTTP 503 recorded');
      eq(g.recent_issues.sampled_pure_issues, 0, '0 pure issues on PR-only page');
      eq(g.recent_issues.sample_complete, false, 'PR-only page with next link is incomplete');
      eq(g.recent_issues.zero_reply_pct, null, 'zero_reply_pct MUST be null (unknown), NEVER 0');
      eq(g.issue_comments_sample.comments_matching_repo_owner_login, 0, 'owner login count honestly 0');
      eq(g.issue_comments_sample.comments_by_maintainer_association, 2, 'org maintainer association counts MEMBER+COLLABORATOR=2');
      eq(g.issue_comments_sample.window_fully_covered, false, 'Link rel=next marks window truncated');
      const skippedScopes = rp.json.summary.scopes_skipped.map((x) => x.scope);
      ok(skippedScopes.includes('github_releases'), 'github_releases in scopes_skipped');
      ok(skippedScopes.includes('github_issues'), 'github_issues in scopes_skipped on PR-only page');
      ok(skippedScopes.includes('github_issue_comments_90d'), 'github_issue_comments_90d in scopes_skipped on next link');

      // Full clean 200 mode assertions
      mode = 'full';
      const rf = await runEvalAsync([mockDir, '--api-base', base]);
      eq(rf.code, 0, 'full clean API exits 0');
      eq(rf.json.activity_claims.github_api.releases.length, 1, 'releases populated');
      eq(rf.json.activity_claims.github_api.recent_issues.sample_complete, true, 'last page issue sample complete');
      eq(rf.json.activity_claims.github_api.recent_issues.zero_reply_pct, 50, '1/2 zero reply = 50%');
      eq(rf.json.activity_claims.github_api.issue_comments_sample.window_fully_covered, true, 'window fully covered');
    } finally {
      srv.close();
    }
  });

  // 06 Codex High 3: Monorepo sub-package README & docs disclosure
  await t('06 monorepo sub-package README & docs disclosure caught even when root README is silent', () => {
    const d = path.join(tmpRoot, 'monorepo');
    fs.mkdirSync(d, { recursive: true });
    gitInitCommit(d, [{
      author: 'Dev', email: 'dev@example.org', msg: 'feat: mono',
      files: {
        'LICENSE': 'MIT License',
        'README.md': '# Mono\n\nSimple intro without mentioning network.\n',
        'packages/cli/README.md': '# CLI\n\nTelemetry can be disabled via CTX7_TELEMETRY_DISABLED=1.\n',
        'docs/clients/cli.mdx': '# CLI Docs\n\nUpdate check runs every 24h.\n',
        'packages/cli/src/track.js': 'export function send() { fetch("https://api.example-tool.io/events"); }\n',
      },
    }]);
    const r = runEval([d]);
    eq(r.code, 0, 'monorepo exits 0');
    const disc = r.json.network_deps.readme_disclosure;
    eq(disc.root_readme_hits, 0, 'root README hits = 0');
    ok(disc.package_readme_hits >= 1, 'sub-package README disclosure caught');
    ok(disc.docs_hits >= 1, 'docs disclosure caught');
    ok(String(disc.note || '').includes('子包'), 'explicit note explaining sub-package disclosure');
  });

  // 07 Codex High 4A: Python pyproject.toml declared dependencies NOT misreported as zero_external_runtime_deps
  await t('07 Python pyproject.toml declared deps prevent false zero_external_runtime_deps', () => {
    const d = path.join(tmpRoot, 'py-proj');
    fs.mkdirSync(d, { recursive: true });
    gitInitCommit(d, [{
      author: 'PyDev', email: 'py@example.org', msg: 'feat: py',
      files: {
        'LICENSE': 'MIT License',
        'README.md': '# PyTool\n',
        'pyproject.toml': '[project]\nname = "pytool"\ndependencies = [\n  "httpx>=0.27.0",\n  "pydantic>=2.0"\n]\n',
        'app.py': 'import json\nprint(json.dumps({"ok": True}))\n',
      },
    }]);
    const r = runEval([d]);
    eq(r.code, 0, 'py repo exits 0');
    const sum = r.json.network_deps.dependencies.summary;
    eq(sum.total_python_declared_deps, 2, '2 declared deps in pyproject.toml');
    eq(sum.python_observed_third_party_imports_count, 0, '0 observed imports in app.py (distinct from declared!)');
    eq(sum.zero_external_runtime_deps, false, 'zero_external_runtime_deps MUST be false');
    ok(!r.json.summary.positive_signals.includes('zero_external_runtime_dependencies'), 'no false zero-dep positive signal');
  });

  // 08 Codex High 4B: Nonexistent directory exits 1 with ZERO positive signals
  await t('08 nonexistent target dir exits 1 with empty positive_signals', () => {
    const r = runEval([path.join(tmpRoot, 'totally-nonexistent-dir-xyz')]);
    eq(r.code, 1, 'nonexistent exits 1');
    eq(r.json.scan_completed, false, 'scan_completed false');
    eq(r.json.summary.positive_signals.length, 0, 'zero positive signals when target missing');
  });

  // 09 Codex Detail: Explicit truncation totals & flags (>40 telemetry hits, >25 domains)
  await t('09 capped telemetry hits (>40) and outbound domains (>25) report full totals and truncated=true', () => {
    const d = path.join(tmpRoot, 'trunc-test');
    fs.mkdirSync(d, { recursive: true });
    const telLines = Array.from({ length: 45 }, (_, i) => `const t${i} = telemetry.send(${i});`).join('\n');
    const domLines = Array.from({ length: 28 }, (_, i) => `const u${i} = "https://svc${i}.vendor-demo.io/api";`).join('\n');
    gitInitCommit(d, [{
      author: 'Dev', email: 'dev@example.org', msg: 'feat: many',
      files: { 'LICENSE': 'MIT License', 'README.md': '# Many\n', 'src/a.js': `${telLines}\n${domLines}\n` },
    }]);
    const r = runEval([d]);
    eq(r.code, 0, 'trunc test exits 0');
    eq(r.json.network_deps.telemetry_signals.length, 40, 'telemetry capped at 40');
    eq(r.json.network_deps.telemetry_signals_total, 45, 'exact total 45 recorded');
    eq(r.json.network_deps.telemetry_signals_truncated, true, 'telemetry_signals_truncated=true');
    eq(r.json.network_deps.outbound_code_domains.length, 25, 'domains capped at 25');
    eq(r.json.network_deps.outbound_code_domains_total, 28, 'exact total 28 recorded');
    eq(r.json.network_deps.outbound_code_domains_truncated, true, 'outbound_code_domains_truncated=true');
  });

  // 10 Codex Detail: Token never interpolated into PowerShell argv + real Context7 offline verification
  await t('10 PowerShell proxy fallback passes token via env only + real Context7 offline smoke check', () => {
    const src = fs.readFileSync(path.join(HERE, 'scripts', 'audit_activity_claims.mjs'), 'utf8');
    const psBlock = src.slice(src.indexOf('const psScript = ['), src.indexOf('const ps = spawnSync'));
    ok(psBlock.includes('$env:OSS_EVAL_GH_TOKEN'), 'PowerShell reads token from env');
    ok(!psBlock.includes('${token'), 'token NOT interpolated into PowerShell command string');

    const ctxDir = process.env.OSS_EVAL_CONTEXT7_DIR || '';
    if (ctxDir && fs.existsSync(ctxDir)) {
      const r = runEval(['https://github.com/upstash/context7', '--workdir', ctxDir, '--offline']);
      eq(r.code, 2, 'Context7 offline exits 2 (github_api + minified bundle skipped)');
      eq(r.json.repo_identity.matched, true, 'Context7 identity verified matched');
      eq(r.json.network_deps.readme_disclosure.root_readme_hits, 0, 'Context7 root README hits = 0');
      ok(r.json.network_deps.readme_disclosure.package_readme_hits > 0, 'Context7 packages/cli/README.md disclosure caught');
      ok(r.json.network_deps.readme_disclosure.docs_hits > 0, 'Context7 docs/ disclosure caught');
      const mentions = r.json.network_deps.readme_network_mentions || [];
      ok(mentions.some((m) => m.file === 'docs/clients/cli.mdx' && (m.line === 330 || m.line === 333)), 'Context7 returned excerpts include docs/clients/cli.mdx:330/333');
      ok(mentions.some((m) => m.file === 'packages/cli/README.md' && m.line === 242), 'Context7 returned excerpts include packages/cli/README.md:242');
      eq(r.json.network_deps.telemetry_signals_truncated, true, 'Context7 telemetry truncation flagged');
      ok(r.json.network_deps.telemetry_signals_total > 40, `Context7 true telemetry hit count=${r.json.network_deps.telemetry_signals_total} > 40`);
    }
  });

  // 11 Live Windows WinINET fallback end-to-end test (200 with env-only Bearer token + Link header, and 503 status)
  if (process.platform === 'win32') {
    await t('11 live Windows WinINET fallback reads env token, parses Link rel=next, and reports HTTP 503', async () => {
      const seenAuth = {};
      const srv = http.createServer((req, res) => {
        seenAuth[req.url] = req.headers.authorization || null;
        if (req.url === '/ok') {
          res.writeHead(200, { 'Content-Type': 'application/json', Link: '<http://127.0.0.1/p2>; rel="next"' });
          res.end(JSON.stringify({ subscribers_count: 77 }));
        } else {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'unavailable' }));
        }
      });
      await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
      const port = srv.address().port;
      const modUrl = new URL('./scripts/audit_activity_claims.mjs', import.meta.url).href;
      const helperScript = `import { fetchViaWinInet } from '${modUrl}'; console.log(JSON.stringify({ okRes: fetchViaWinInet('http://127.0.0.1:${port}/ok', 'env-token-123'), errRes: fetchViaWinInet('http://127.0.0.1:${port}/err', '') }));`;
      try {
        const out = await new Promise((resolve) => {
          execFile(process.execPath, ['--input-type=module', '-e', helperScript], { encoding: 'utf8' }, (err, stdout, stderr) => {
            resolve({ err, stdout, stderr });
          });
        });
        ok(out.stdout.trim(), `child stdout empty: ${out.stderr}`);
        const j = JSON.parse(out.stdout);
        eq(seenAuth['/ok'], 'Bearer env-token-123', 'env token sent in Authorization header on /ok');
        eq(seenAuth['/err'], null, 'no auth header sent when token empty');
        eq(j.okRes.ok, true, '200 call ok');
        eq(j.okRes.via, 'win-wininet', 'via win-wininet');
        eq(j.okRes.has_next_page, true, 'Link rel=next parsed');
        eq(j.okRes.data.subscribers_count, 77, 'JSON body parsed');
        eq(j.errRes.ok, false, '503 call not ok');
        eq(j.errRes.http_status, 503, 'exact HTTP 503 status preserved');
      } finally {
        srv.close();
      }
    });
  }

  // 12 Codex R24 P1 #1: --repo mismatch refused across eval_all & standalone audit_activity_claims (0 API hits); unverified local export marked unverified
  await t('12 P1 #1: --repo identity conflicts refused before API calls; unverified local export marked unverified', async () => {
    const repoOne = path.join(tmpRoot, 'fixture-one');
    fs.mkdirSync(repoOne, { recursive: true });
    gitInitCommit(repoOne, [{
      author: 'Dev', email: 'dev@example.org', msg: 'feat: widget',
      files: { 'LICENSE': 'MIT License', 'README.md': '# Widget\n', 'src/index.js': 'export const w = 1;\n' },
    }], 'https://github.com/fixture-one/widget.git');

    const localExport = path.join(tmpRoot, 'local-export-no-git');
    fs.mkdirSync(localExport, { recursive: true });
    fs.writeFileSync(path.join(localExport, 'LICENSE'), 'MIT License\n');
    fs.writeFileSync(path.join(localExport, 'README.md'), '# Exported\n');
    fs.writeFileSync(path.join(localExport, 'index.js'), 'export const a = 1;\n');

    const apiPaths = [];
    const srv = http.createServer((req, res) => {
      apiPaths.push(req.url);
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/repos/fixture-two/other') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          owner: { login: 'fixture-two', type: 'User' },
          stargazers_count: 100, forks_count: 10, subscribers_count: 1,
          open_issues_count: 0, license: { spdx_id: 'MIT' },
          created_at: '2025-01-01T00:00:00Z', pushed_at: '2026-11-18T00:00:00Z',
          size: 50, language: 'JavaScript', archived: false,
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      }
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${srv.address().port}`;

    try {
      // 12A: localDir(fixture-one/widget) + --repo fixture-two/other -> exit 1, 0 API requests
      const rA = await runEvalAsync([repoOne, '--repo', 'fixture-two/other', '--api-base', base]);
      eq(rA.code, 1, '12A localDir + conflicting --repo exits 1');
      eq(rA.json.scan_completed, false, '12A scan_completed false');
      eq(rA.json.repo_identity.matched, false, '12A matched false');
      eq(rA.json.summary.positive_signals.length, 0, '12A empty positive signals');
      eq(apiPaths.length, 0, '12A zero API requests made on conflict');

      // 12B: URL(fixture-one/widget) + matching --workdir + --repo fixture-two/other -> exit 1, 0 API requests
      const rB = await runEvalAsync(['https://github.com/fixture-one/widget', '--workdir', repoOne, '--repo', 'fixture-two/other', '--api-base', base]);
      eq(rB.code, 1, '12B URL + workdir + conflicting --repo exits 1');
      eq(rB.json.repo_identity.matched, false, '12B matched false');
      eq(apiPaths.length, 0, '12B zero API requests made on conflict');

      // 12C: standalone audit_activity_claims.mjs localDir + --repo fixture-two/other -> exit 1, 0 API requests
      const rC = await runScriptAsync(AUDIT_ACTIVITY, [repoOne, '--repo', 'fixture-two/other', '--api-base', base]);
      eq(rC.code, 1, '12C standalone audit_activity_claims refuses conflict with exit 1');
      eq(rC.json.scan_completed, false, '12C standalone scan_completed false');
      eq(rC.json.repo_identity.matched, false, '12C standalone matched false');
      eq(apiPaths.length, 0, '12C zero API requests made on standalone conflict');

      // 12D: local export WITHOUT git origin + --repo fixture-two/other -> allowed, explicitly marked unverified & exit 2
      const rD = await runEvalAsync([localExport, '--repo', 'fixture-two/other', '--api-base', base]);
      eq(rD.code, 2, '12D unverified local export + --repo exits 2 (partial/unverified boundary)');
      eq(rD.json.repo_identity.identity_verified, false, '12D identity_verified=false');
      eq(rD.json.repo_identity.identity_status, 'unverified_local_export', '12D identity_status=unverified_local_export');
      eq(rD.json.repo_identity.matched, null, '12D matched=null (not true!)');
      eq(rD.json.repo_identity.effective_api_slug, 'fixture-two/other', '12D effective_api_slug recorded');
      ok(rD.json.summary.caution_flags.some((c) => c.includes('repo_identity_unverified')), '12D caution flag warns identity unverified');
      ok(apiPaths.some((p) => p === '/repos/fixture-two/other'), '12D queried declared repo');
    } finally {
      srv.close();
    }
  });

  // 13 Codex R24 P1 #2: Credential isolation (ambient GITHUB_TOKEN/GH_TOKEN blocked on custom --api-base; origin_url credentials stripped)
  await t('13 P1 #2: custom --api-base blocks ambient GitHub tokens, binds custom token to origin, and strips origin_url credentials', async () => {
    const credRepo = path.join(tmpRoot, 'cred-origin-repo');
    fs.mkdirSync(credRepo, { recursive: true });
    const fakePass = 'fake-embedded-pass-987654';
    gitInitCommit(credRepo, [{
      author: 'Dev', email: 'dev@example.org', msg: 'feat: init',
      files: { 'LICENSE': 'MIT License', 'README.md': '# CredTest\n', 'a.js': 'export const a = 1;\n' },
    }], `https://alice:${fakePass}@github.com/fixture-one/cred-widget.git?token=leakquery`);

    // 13A: Normal report & mismatch error report MUST NOT leak embedded origin credentials
    const rNorm = runEval([credRepo, '--offline']);
    ok(!rNorm.out.includes(fakePass), '13A normal report strips embedded password from origin_url');
    ok(!rNorm.out.includes('leakquery'), '13A normal report strips query string from origin_url');
    eq(rNorm.json.repo_identity.local_origin_slug, 'fixture-one/cred-widget', '13A slug parsed despite embedded creds');
    eq(rNorm.json.repo_identity.local_origin_url, 'https://github.com/fixture-one/cred-widget', '13A sanitized origin URL');

    const rErr = runEval(['https://github.com/other/repo', '--workdir', credRepo, '--offline']);
    eq(rErr.code, 1, '13A mismatch exits 1');
    ok(!rErr.out.includes(fakePass), '13A mismatch error report strips embedded password');
    ok(!rErr.out.includes('leakquery'), '13A mismatch error report strips query string');

    // 13B: Custom API origin binding & official-host check
    const seenAuths = [];
    const srv = http.createServer((req, res) => {
      seenAuths.push(req.headers.authorization || null);
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/repos/fixture-one/cred-widget') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          owner: { login: 'fixture-one', type: 'User' },
          stargazers_count: 100, forks_count: 10, subscribers_count: 1,
          open_issues_count: 0, license: { spdx_id: 'MIT' },
          created_at: '2025-01-01T00:00:00Z', pushed_at: '2026-11-18T00:00:00Z',
          size: 10, language: 'JS', archived: false,
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      }
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${srv.address().port}`;

    try {
      // Ambient GITHUB_TOKEN + mismatched custom origin -> MUST be anonymous (null)
      await runEvalAsync([credRepo, '--api-base', base], {
        GITHUB_TOKEN: 'ambient-gh-secret',
        GH_TOKEN: 'ambient-gh-cli-secret',
        OSS_EVAL_CUSTOM_API_TOKEN: 'custom-enterprise-token',
        OSS_EVAL_CUSTOM_API_ORIGIN: 'http://127.0.0.1:1',
      });
      ok(seenAuths.length >= 1 && seenAuths.every((a) => a === null), `13B custom base must be anonymous when origin mismatches; saw ${JSON.stringify(seenAuths)}`);

      // Exact matching OSS_EVAL_CUSTOM_API_ORIGIN -> sends custom token (never GITHUB_TOKEN)
      seenAuths.length = 0;
      await runEvalAsync([credRepo, '--api-base', base], {
        GITHUB_TOKEN: 'ambient-gh-secret',
        OSS_EVAL_CUSTOM_API_TOKEN: 'custom-enterprise-token',
        OSS_EVAL_CUSTOM_API_ORIGIN: base,
      });
      ok(seenAuths.length >= 1 && seenAuths.every((a) => a === 'Bearer custom-enterprise-token'), `13B matching custom origin sends custom token; saw ${JSON.stringify(seenAuths)}`);
    } finally {
      srv.close();
    }

    // 13C: Verify isOfficialGithubApiBase rejects spoofed origins
    const mod = await import(new URL('./scripts/audit_activity_claims.mjs', import.meta.url).href);
    eq(mod.isOfficialGithubApiBase('https://api.github.com'), true, 'official https://api.github.com accepted');
    eq(mod.isOfficialGithubApiBase('http://api.github.com'), false, 'plain http rejected');
    eq(mod.isOfficialGithubApiBase('https://api.github.com.evil.example'), false, 'lookalike host rejected');
    eq(mod.isOfficialGithubApiBase('https://api.github.com:8443'), false, 'non-standard port rejected');
    eq(mod.isOfficialGithubApiBase('https://api.github.com/proxy'), false, 'subpath rejected');
  });

  // 14 Codex R24 P2 #1: Issue pagination (24 PRs + 1 issue + next page) and exact-100 comments without next page
  await t('14 P2 #1: issues paginate up to 20 pure issues (incomplete -> exit 2) and exact-100 comments without Link next exits 0', async () => {
    const pagDir = path.join(tmpRoot, 'pag-repo');
    fs.mkdirSync(pagDir, { recursive: true });
    gitInitCommit(pagDir, [{
      author: 'Dev', email: 'dev@example.org', msg: 'feat: pag',
      files: { 'LICENSE': 'MIT License', 'README.md': '# Pag\n', 'src/a.js': 'export const a = 1;\n' },
    }], 'https://github.com/pag-org/pag-repo.git');

    let scenario = 'incomplete_1_of_20';
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/repos/pag-org/pag-repo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          owner: { login: 'pag-org', type: 'Organization' },
          stargazers_count: 500, forks_count: 20, subscribers_count: 3,
          open_issues_count: 20, license: { spdx_id: 'MIT' },
          created_at: '2025-01-01T00:00:00Z', pushed_at: '2026-11-18T00:00:00Z',
          size: 50, language: 'JavaScript', archived: false,
        }));
      } else if (u.pathname === '/repos/pag-org/pag-repo/releases') {
        const rels = Array.from({ length: 8 }, (_, i) => ({ tag_name: `v1.0.${i}`, published_at: '2026-11-10T00:00:00Z' }));
        res.writeHead(200, { 'Content-Type': 'application/json', Link: '<http://127.0.0.1/r2>; rel="next"' });
        res.end(JSON.stringify(rels));
      } else if (u.pathname === '/repos/pag-org/pag-repo/issues') {
        const page = Number(u.searchParams.get('page') || '1');
        if (scenario === 'incomplete_1_of_20') {
          if (page === 1) {
            // Exact Codex case: 24 PRs + 1 unanswered issue + Link rel="next"
            const items = [
              ...Array.from({ length: 24 }, (_, i) => ({ number: 100 + i, state: 'closed', comments: 0, title: `PR ${i}`, pull_request: {} })),
              { number: 200, state: 'open', comments: 0, title: 'Only issue on page 1' },
            ];
            res.writeHead(200, { 'Content-Type': 'application/json', Link: '<http://127.0.0.1/p2>; rel="next"' });
            res.end(JSON.stringify(items));
          } else {
            // Next page fails (503) so only 1/20 pure issues collected
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'rate limited on page 2' }));
          }
        } else if (scenario === 'complete_across_2_pages') {
          if (page === 1) {
            const items = [
              ...Array.from({ length: 24 }, (_, i) => ({ number: 100 + i, state: 'closed', comments: 0, title: `PR ${i}`, pull_request: {} })),
              { number: 200, state: 'open', comments: 0, title: 'Issue 1 on page 1' },
            ];
            res.writeHead(200, { 'Content-Type': 'application/json', Link: '<http://127.0.0.1/p2>; rel="next"' });
            res.end(JSON.stringify(items));
          } else {
            const items = Array.from({ length: 19 }, (_, i) => ({ number: 300 + i, state: 'closed', comments: 2, title: `Issue ${i + 2}` }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(items));
          }
        }
      } else if (u.pathname === '/repos/pag-org/pag-repo/issues/comments') {
        // Exact Codex case: EXACTLY 100 comments and NO Link rel="next"
        const cmts = Array.from({ length: 100 }, (_, i) => ({
          user: { login: i % 2 === 0 ? 'maint-alice' : 'community-user' },
          author_association: i % 2 === 0 ? 'MEMBER' : 'NONE',
          created_at: '2026-11-15T00:00:00Z',
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cmts));
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${srv.address().port}`;

    try {
      // 14A: 24 PRs + 1 issue on p1, p2 fails -> exit 2, sample_complete=false, github_issues in scopes_skipped; comments 100 no-next is complete!
      const rA = await runEvalAsync([pagDir, '--api-base', base]);
      eq(rA.code, 2, '14A incomplete 1/20 issues MUST exit 2 (not 0)');
      const issA = rA.json.activity_claims.github_api.recent_issues;
      eq(issA.sampled_pure_issues, 1, '14A honest denominator 1');
      eq(issA.sample_target, 20, '14A target 20');
      eq(issA.sample_complete, false, '14A sample_complete=false');
      ok(rA.json.summary.scopes_skipped.some((s) => s.scope === 'github_issues'), '14A github_issues in scopes_skipped');
      eq(rA.json.activity_claims.github_api.issue_comments_sample.sampled_comments, 100, '14A 100 comments sampled');
      eq(rA.json.activity_claims.github_api.issue_comments_sample.window_fully_covered, true, '14A exact-100 comments without Link next is fully covered');
      ok(!rA.json.summary.scopes_skipped.some((s) => s.scope === 'github_issue_comments_90d'), '14A exact-100 comments NOT in scopes_skipped');

      // 14B: 24 PRs + 1 issue on p1 + 19 issues on p2 + 8 releases + exact-100 comments (no next) -> exit 0!
      scenario = 'complete_across_2_pages';
      const rB = await runEvalAsync([pagDir, '--api-base', base]);
      eq(rB.code, 0, '14B full 20 pure issues across 2 pages + 100 comments without next + 8 releases exits 0');
      const issB = rB.json.activity_claims.github_api.recent_issues;
      eq(issB.sampled_pure_issues, 20, '14B collected full 20 pure issues');
      eq(issB.pages_fetched, 2, '14B fetched 2 pages');
      eq(issB.sample_complete, true, '14B sample_complete=true');
      eq(issB.zero_reply_pct, 5, '14B 1/20 zero reply = 5%');
    } finally {
      srv.close();
    }
  });

  // 15 Codex R24 P2 #2: Indirect & dynamic Python dependencies (setuptools dynamic file, requirements -r, and unsupported dynamic)
  await t('15 P2 #2: Python indirect deps (setuptools dynamic file & requirements -r) resolved; unsupported dynamic -> unknown (exit 2)', () => {
    // 15A: setuptools dynamic dependencies = { file = ["deps/base.in"] }
    const dDyn = path.join(tmpRoot, 'py-setuptools-dyn');
    fs.mkdirSync(dDyn, { recursive: true });
    gitInitCommit(dDyn, [{
      author: 'PyDev', email: 'py@example.org', msg: 'feat: dyn',
      files: {
        'LICENSE': 'MIT License',
        'README.md': '# DynPy\n',
        'pyproject.toml': '[project]\nname = "dynpy"\ndynamic = ["dependencies"]\n\n[tool.setuptools.dynamic]\ndependencies = { file = ["deps/base.in"] }\n',
        'deps/base.in': 'httpx>=0.27\n',
        'app.py': 'import json\nprint(json.dumps({}))\n',
      },
    }]);
    const rA = runEval([dDyn]);
    eq(rA.code, 0, '15A setuptools dynamic file exits 0');
    eq(rA.json.network_deps.dependencies.summary.total_python_declared_deps, 1, '15A resolves httpx from deps/base.in');
    eq(rA.json.network_deps.dependencies.summary.zero_external_runtime_deps, false, '15A zero_external_runtime_deps=false');
    ok(!rA.json.summary.positive_signals.includes('zero_external_runtime_dependencies'), '15A no false zero-dep signal');

    // 15B: requirements.txt with -r deps/base.in
    const dReq = path.join(tmpRoot, 'py-req-include');
    fs.mkdirSync(dReq, { recursive: true });
    gitInitCommit(dReq, [{
      author: 'PyDev', email: 'py@example.org', msg: 'feat: req',
      files: {
        'LICENSE': 'MIT License',
        'README.md': '# ReqPy\n',
        'requirements.txt': '-r deps/base.in\n',
        'deps/base.in': 'httpx>=0.27\n',
        'app.py': 'import os\n',
      },
    }]);
    const rB = runEval([dReq]);
    eq(rB.code, 0, '15B requirements -r exits 0');
    eq(rB.json.network_deps.dependencies.summary.total_python_declared_deps, 1, '15B resolves httpx via -r');
    eq(rB.json.network_deps.dependencies.summary.zero_external_runtime_deps, false, '15B zero_external_runtime_deps=false');
    ok(!rB.json.summary.positive_signals.includes('zero_external_runtime_dependencies'), '15B no false zero-dep signal');

    // 15C: Unsupported dynamic dependencies -> unknown (null), scopes_skipped, exit 2, NO zero-dep signal
    const dUnres = path.join(tmpRoot, 'py-unres-dyn');
    fs.mkdirSync(dUnres, { recursive: true });
    gitInitCommit(dUnres, [{
      author: 'PyDev', email: 'py@example.org', msg: 'feat: unres',
      files: {
        'LICENSE': 'MIT License',
        'README.md': '# UnresPy\n',
        'pyproject.toml': '[project]\nname = "unrespy"\ndynamic = ["dependencies"]\n\n[tool.setuptools.dynamic]\ndependencies = { attr = "unrespy._deps.REQS" }\n',
        'app.py': 'import os\n',
      },
    }]);
    const rC = runEval([dUnres]);
    eq(rC.code, 2, '15C unsupported dynamic deps exits 2');
    eq(rC.json.network_deps.dependencies.summary.zero_external_runtime_deps, null, '15C zero_external_runtime_deps MUST be null (unknown)');
    ok(rC.json.network_deps.dependencies.unresolved_sources.length >= 1, '15C unresolved_sources recorded');
    ok(rC.json.summary.scopes_skipped.some((s) => s.scope === 'dependency_weight'), '15C dependency_weight in scopes_skipped');
    ok(!rC.json.summary.positive_signals.includes('zero_external_runtime_dependencies'), '15C no false zero-dep signal');
  });

  // 16 Codex R24 P2 #3: Unreadable root README.md degrades to exit 2 and still executes GitHub API collection
  await t('16 P2 #3: unreadable root README.md records skipped/scopes_skipped (exit 2) without aborting GitHub API', async () => {
    const d = path.join(tmpRoot, 'unreadable-readme');
    fs.mkdirSync(d, { recursive: true });
    gitInitCommit(d, [{
      author: 'Dev', email: 'dev@example.org', msg: 'feat: init',
      files: { 'LICENSE': 'MIT License', 'README.md': '# Secret Readme\n', 'src/a.js': 'export const a = 1;\n' },
    }], 'https://github.com/readme-org/readme-repo.git');

    const readmeAbs = path.join(d, 'README.md');
    let apiCalled = false;
    const srv = http.createServer((req, res) => {
      apiCalled = true;
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/repos/readme-org/readme-repo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          owner: { login: 'readme-org', type: 'Organization' },
          stargazers_count: 200, forks_count: 10, subscribers_count: 2,
          open_issues_count: 0, license: { spdx_id: 'MIT' },
          created_at: '2025-01-01T00:00:00Z', pushed_at: '2026-11-18T00:00:00Z',
          size: 10, language: 'JS', archived: false,
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      }
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${srv.address().port}`;

    // Make README.md unreadable (Windows icacls deny Read; POSIX chmod 000)
    if (process.platform === 'win32') {
      spawnSync('icacls', [readmeAbs, '/deny', `${process.env.USERNAME}:(R)`], { encoding: 'utf8' });
    } else {
      fs.chmodSync(readmeAbs, 0o000);
    }

    try {
      const r = await runEvalAsync([d, '--api-base', base]);
      eq(r.code, 2, '16 unreadable README exits 2 (NOT 1)');
      eq(r.json.scan_completed, true, '16 scan_completed=true');
      eq(r.json.activity_claims.scan_completed, true, '16 activity_claims completed');
      eq(r.json.activity_claims.claims.readme_unreadable, true, '16 readme_unreadable=true');
      ok(r.json.activity_claims.skipped.some((s) => s.file === 'README.md' && s.reason.startsWith('READ_ERROR')), '16 README READ_ERROR recorded in activity_claims.skipped');
      ok(r.json.summary.scopes_skipped.some((s) => s.scope === 'readme_claims'), '16 readme_claims recorded in scopes_skipped');
      eq(apiCalled, true, '16 GitHub API still executed despite unreadable README');
      eq(r.json.activity_claims.github_api.stars, 200, '16 GitHub API metadata collected');
    } finally {
      srv.close();
      if (process.platform === 'win32') {
        spawnSync('icacls', [readmeAbs, '/remove:d', process.env.USERNAME], { encoding: 'utf8' });
        spawnSync('icacls', [readmeAbs, '/reset'], { encoding: 'utf8' });
      } else {
        try { fs.chmodSync(readmeAbs, 0o644); } catch {}
      }
    }
  });

  // 17 Codex R25 #1: Strict GitHub remote parsing (rejects lookalike/relative/subpath remotes) & API full_name mismatch detection
  await t('17 R25 #1: strict GitHub remote parsing rejects non-GitHub remotes and API canonical full_name mismatch exits 2', async () => {
    const mod = await import(new URL('./scripts/audit_activity_claims.mjs', import.meta.url).href);
    // Strict remote URL parser tests
    eq(mod.parseGithubRemoteUrl('https://github.com/upstash/context7.git'), 'upstash/context7', 'https github accepted');
    eq(mod.parseGithubRemoteUrl('git@github.com:upstash/context7.git'), 'upstash/context7', 'SCP git@github.com accepted');
    eq(mod.parseGithubRemoteUrl('ssh://git@github.com/upstash/context7.git'), 'upstash/context7', 'ssh://github.com accepted');
    eq(mod.parseGithubRemoteUrl('https://mirror.evil.example/github.com/upstash/context7.git'), null, 'substring github.com in non-GitHub host rejected');
    eq(mod.parseGithubRemoteUrl('https://notgithub.com/upstash/context7.git'), null, 'notgithub.com rejected');
    eq(mod.parseGithubRemoteUrl('file://' + '/C:/repos/github.com/upstash/context7'), null, 'file:// URL rejected');
    eq(mod.parseGithubRemoteUrl('upstash/context7'), null, 'relative path shorthand rejected as Git remote');
    eq(mod.parseGithubRemoteUrl('../github.com/upstash/context7'), null, 'relative parent path rejected');
    eq(mod.parseGithubRemoteUrl('https://github.com:8443/upstash/context7.git'), null, 'non-standard port rejected');

    // Repo with non-GitHub mirror origin containing "github.com" substring MUST NOT be treated as verified GitHub origin
    const fakeOriginDir = path.join(tmpRoot, 'fake-mirror-origin');
    fs.mkdirSync(fakeOriginDir, { recursive: true });
    gitInitCommit(fakeOriginDir, [{
      author: 'Dev', email: 'dev@example.org', msg: 'feat: mirror',
      files: { 'LICENSE': 'MIT License', 'README.md': '# Mirror\n', 'src/a.js': 'export const a = 1;\n' },
    }], 'https://mirror.evil.example/github.com/upstash/context7.git');

    const rMirror = runEval([fakeOriginDir, '--offline']);
    eq(rMirror.json.repo_identity.local_origin_slug, null, '17A non-GitHub mirror has local_origin_slug=null');
    eq(rMirror.json.repo_identity.local_origin_kind, 'non_github', '17A local_origin_kind=non_github');
    eq(rMirror.json.repo_identity.local_origin_url, 'https://mirror.evil.example/github.com/upstash/context7.git', '17A non-GitHub URL not rewritten to github.com');

    const rUrlMismatch = runEval(['https://github.com/upstash/context7', '--workdir', fakeOriginDir, '--offline']);
    eq(rUrlMismatch.code, 1, '17A GitHub URL against non-GitHub mirror workdir refused with exit 1');
    eq(rUrlMismatch.json.repo_identity.matched, false, '17A matched=false');

    // Repo with relative-path origin "upstash/context7" MUST NOT be treated as verified GitHub origin
    const relOriginDir = path.join(tmpRoot, 'rel-path-origin');
    fs.mkdirSync(relOriginDir, { recursive: true });
    gitInitCommit(relOriginDir, [{
      author: 'Dev', email: 'dev@example.org', msg: 'feat: rel',
      files: { 'LICENSE': 'MIT License', 'README.md': '# Rel\n', 'src/a.js': 'export const a = 1;\n' },
    }], 'upstash/context7');
    const rRel = runEval([relOriginDir, '--offline']);
    eq(rRel.json.repo_identity.local_origin_slug, null, '17A relative-path remote has local_origin_slug=null');
    eq(rRel.json.repo_identity.local_origin_kind, 'non_github', '17A relative-path remote kind=non_github');

    // 17B: API returns canonical full_name different from requested slug (rename/transfer redirect)
    const renamedDir = path.join(tmpRoot, 'renamed-repo');
    fs.mkdirSync(renamedDir, { recursive: true });
    gitInitCommit(renamedDir, [{
      author: 'Dev', email: 'dev@example.org', msg: 'feat: old',
      files: { 'LICENSE': 'MIT License', 'README.md': '# Old\n', 'src/a.js': 'export const a = 1;\n' },
    }], 'https://github.com/old-owner/old-repo.git');

    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/repos/old-owner/old-repo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          full_name: 'new-org/renamed-repo',
          owner: { login: 'new-org', type: 'Organization' },
          stargazers_count: 1000, forks_count: 50, subscribers_count: 5,
          open_issues_count: 2, license: { spdx_id: 'MIT' },
          created_at: '2025-01-01T00:00:00Z', pushed_at: '2026-11-18T00:00:00Z',
          size: 50, language: 'JavaScript', archived: false,
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      }
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      const rRen = await runEvalAsync([renamedDir, '--api-base', base]);
      eq(rRen.code, 2, '17B API canonical full_name mismatch exits 2 (not 0)');
      eq(rRen.json.repo_identity.effective_api_slug, 'old-owner/old-repo', '17B requested/effective slug preserved');
      eq(rRen.json.repo_identity.api_canonical_full_name, 'new-org/renamed-repo', '17B canonical full_name preserved');
      eq(rRen.json.repo_identity.api_name_differs, true, '17B api_name_differs=true');
      eq(rRen.json.repo_identity.identity_verified, false, '17B identity_verified=false on canonical mismatch');
      eq(rRen.json.activity_claims.github_api.requested_repo, 'old-owner/old-repo', '17B github_api.requested_repo kept');
      eq(rRen.json.activity_claims.github_api.canonical_full_name, 'new-org/renamed-repo', '17B github_api.canonical_full_name kept');
      ok(rRen.json.summary.scopes_skipped.some((s) => s.scope === 'repo_identity_verification'), '17B repo_identity_verification in scopes_skipped');
      ok(rRen.json.summary.caution_flags.some((c) => c.includes('repo_canonical_name_differs')), '17B caution flag warns canonical mismatch');
    } finally {
      srv.close();
    }
  });

  // 18 Codex R25 #2: Python dependency refs via symlink / Windows junction pointing outside repo MUST NOT be read (exit 2, unknown deps)
  await t('18 R25 #2: Python dep refs escaping repo via symlink/Windows junction are refused (zero_external_runtime_deps=null, exit 2)', () => {
    const outsideDir = path.join(tmpRoot, 'outside-secret-dir');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.in'), 'evil-outside-dep>=1.0\n');

    const createdLinks = [];
    const makeDirLink = (linkPath, targetPath) => {
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      if (process.platform === 'win32') {
        fs.symlinkSync(targetPath, linkPath, 'junction');
      } else {
        fs.symlinkSync(targetPath, linkPath, 'dir');
      }
      createdLinks.push(linkPath);
    };

    try {
      // 18A: requirements.txt -r deps/ext_link/secret.in
      const dReq = path.join(tmpRoot, 'py-link-req');
      fs.mkdirSync(dReq, { recursive: true });
      gitInitCommit(dReq, [{
        author: 'PyDev', email: 'py@example.org', msg: 'feat: link req',
        files: {
          'LICENSE': 'MIT License',
          'README.md': '# LinkReq\n',
          'requirements.txt': '-r deps/ext_link/secret.in\n',
          'app.py': 'import os\n',
        },
      }]);
      makeDirLink(path.join(dReq, 'deps', 'ext_link'), outsideDir);

      const rA = runEval([dReq]);
      eq(rA.code, 2, '18A symlink/junction escape in requirements.txt exits 2');
      eq(rA.json.network_deps.dependencies.summary.total_python_declared_deps, 0, '18A did NOT read outside dep');
      eq(rA.json.network_deps.dependencies.summary.zero_external_runtime_deps, null, '18A zero_external_runtime_deps=null (unknown)');
      ok(rA.json.network_deps.dependencies.unresolved_sources.some((u) => u.reason.startsWith('REF_ESCAPES_REPO_VIA_LINK')), '18A recorded REF_ESCAPES_REPO_VIA_LINK');
      ok(!rA.json.summary.positive_signals.includes('zero_external_runtime_dependencies'), '18A no false zero-dep signal');

      // 18B: pyproject.toml [tool.setuptools.dynamic] dependencies = { file = ["deps/ext_link/secret.in"] }
      const dDyn = path.join(tmpRoot, 'py-link-dyn');
      fs.mkdirSync(dDyn, { recursive: true });
      gitInitCommit(dDyn, [{
        author: 'PyDev', email: 'py@example.org', msg: 'feat: link dyn',
        files: {
          'LICENSE': 'MIT License',
          'README.md': '# LinkDyn\n',
          'pyproject.toml': '[project]\nname = "linkdyn"\ndynamic = ["dependencies"]\n\n[tool.setuptools.dynamic]\ndependencies = { file = ["deps/ext_link/secret.in"] }\n',
          'app.py': 'import os\n',
        },
      }]);
      makeDirLink(path.join(dDyn, 'deps', 'ext_link'), outsideDir);

      const rB = runEval([dDyn]);
      eq(rB.code, 2, '18B symlink/junction escape in pyproject.toml exits 2');
      eq(rB.json.network_deps.dependencies.summary.total_python_declared_deps, 0, '18B did NOT read outside dep');
      eq(rB.json.network_deps.dependencies.summary.zero_external_runtime_deps, null, '18B zero_external_runtime_deps=null (unknown)');
      ok(rB.json.network_deps.dependencies.unresolved_sources.some((u) => u.reason.startsWith('REF_ESCAPES_REPO_VIA_LINK')), '18B recorded REF_ESCAPES_REPO_VIA_LINK');
      ok(!rB.json.summary.positive_signals.includes('zero_external_runtime_dependencies'), '18B no false zero-dep signal');
    } finally {
      for (const lp of createdLinks) {
        try { fs.rmSync(lp, { force: true }); } catch {}
      }
    }
  });

  // 19 Codex R25 UX: --out writes full UTF-8 JSON (no UTF-16 BOM) and prints compact stdout summary with key file:line pointers
  await t('19 R25 UX: --out writes full UTF-8 report and prints compact stdout summary (plus --help)', () => {
    const h = runEval(['--help']);
    eq(h.code, 0, '--help exits 0');
    ok(h.out.includes('--out') && h.out.includes('--api-base'), '--help documents --out and --api-base');

    const ctxDir = process.env.OSS_EVAL_CONTEXT7_DIR || '';
    const targetDir = ctxDir && fs.existsSync(ctxDir) ? ctxDir : cleanDir;
    const outFile = path.join(tmpRoot, 'reports', 'full-report.json');
    const r = runEval([targetDir, '--offline', '--out', outFile]);
    eq(r.code, 2, '19 --out offline exits 2');
    ok(fs.existsSync(outFile), '19 full report file created');
    const rawBuf = fs.readFileSync(outFile);
    ok(!(rawBuf[0] === 0xff && rawBuf[1] === 0xfe), '19 output file is clean UTF-8 (NOT UTF-16LE)');
    const fullJson = JSON.parse(rawBuf.toString('utf8'));
    eq(fullJson.scan_completed, true, '19 full report has scan_completed=true');
    eq(r.json.full_report_path, path.resolve(outFile), '19 compact stdout references full_report_path');
    ok(r.json.key_pointers && r.json.repo_identity && r.json.summary, '19 compact stdout has repo_identity, summary, key_pointers');
    if (ctxDir && fs.existsSync(ctxDir)) {
      ok(r.out.length < rawBuf.length * 0.5, `19 compact stdout (${r.out.length}B) much smaller than full JSON (${rawBuf.length}B)`);
      const topDisc = r.json.key_pointers.network_deps.top_disclosure_mentions || [];
      ok(topDisc.some((m) => m.file === 'packages/cli/README.md' && m.line === 242), '19 compact stdout directly surfaces packages/cli/README.md:242');
      ok(topDisc.some((m) => m.file === 'docs/clients/cli.mdx' && (m.line === 330 || m.line === 333)), '19 compact stdout directly surfaces docs/clients/cli.mdx:330/333');
    }
  });

  // 20 Codex R26 #1: Missing option values (e.g. --out --offline, trailing --out) refuse with exit 1, 0 API requests, 0 files created
  await t('20 R26 #1: missing flag values (--out --offline, trailing --out, unknown flags) exit 1 with 0 API calls and no stray files', async () => {
    const cliDir = path.join(tmpRoot, 'cli-arg-repo');
    const cwdCheck = path.join(tmpRoot, 'cli-arg-cwd');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.mkdirSync(cwdCheck, { recursive: true });
    gitInitCommit(cliDir, [{
      author: 'Dev', email: 'dev@example.org', msg: 'feat: init',
      files: { 'LICENSE': 'MIT License', 'README.md': '# CliArg\n', 'src/a.js': 'export const a = 1;\n' },
    }], 'https://github.com/arg-org/arg-repo.git');

    let reqCount = 0;
    const srv = http.createServer((req, res) => {
      reqCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${srv.address().port}`;

    const runInCwd = (scriptPath, args) => new Promise((resolve) => {
      execFile(process.execPath, [scriptPath, ...args], {
        encoding: 'utf8', cwd: cwdCheck, maxBuffer: 10 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        let j = null;
        try { j = JSON.parse(stdout || ''); } catch {}
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, json: j, out: stdout || '', err: stderr || '' });
      });
    });

    try {
      // Exact Codex repro: --out --offline must NOT swallow --offline or create file "--offline" or hit API
      const r1 = await runInCwd(EVAL_ALL, [cliDir, '--api-base', base, '--out', '--offline']);
      eq(r1.code, 1, '20A --out --offline exits 1');
      eq(r1.json?.summary?.exit_meaning, 'invalid_cli_arguments', '20A invalid_cli_arguments');
      eq(reqCount, 0, '20A zero API requests made');
      eq(fs.existsSync(path.join(cwdCheck, '--offline')), false, '20A did NOT create file named --offline');

      // Trailing --out with missing value
      const r2 = await runInCwd(EVAL_ALL, [cliDir, '--api-base', base, '--offline', '--out']);
      eq(r2.code, 1, '20B trailing --out exits 1');
      eq(reqCount, 0, '20B zero API requests');

      // Missing value on --workdir and unknown flag
      const r3 = await runInCwd(EVAL_ALL, [cliDir, '--api-base', base, '--workdir', '--offline']);
      eq(r3.code, 1, '20C --workdir --offline exits 1');
      const r4 = await runInCwd(EVAL_ALL, [cliDir, '--api-base', base, '--nonexistent-flag']);
      eq(r4.code, 1, '20D unknown flag exits 1');
      eq(reqCount, 0, '20C/D zero API requests');

      // Standalone audit_activity_claims.mjs --repo --offline
      const r5 = await runInCwd(AUDIT_ACTIVITY, [cliDir, '--api-base', base, '--repo', '--offline']);
      eq(r5.code, 1, '20E standalone --repo --offline exits 1');
      eq(reqCount, 0, '20E zero API requests');

      // Control: normal --offline --out result.json succeeds offline with 0 API calls and creates report
      const validOut = path.join(cwdCheck, 'result.json');
      const r6 = await runInCwd(EVAL_ALL, [cliDir, '--api-base', base, '--offline', '--out', validOut]);
      eq(r6.code, 2, '20F normal --offline --out exits 2 (github_api skipped)');
      eq(reqCount, 0, '20F normal --offline makes 0 API calls');
      ok(fs.existsSync(validOut), '20F normal --out creates report file');
    } finally {
      srv.close();
    }
  });

  // 21 Codex R26 #2: Versioned/subpath GitHub URLs (/tree/<sha>, /commit/<sha>) refused with exit 1 instead of silently shrinking to repo root
  await t('21 R26 #2: versioned GitHub URLs (/tree/<sha>, /commit/<sha>) are refused (exit 1) and never silently verified against HEAD', () => {
    const revDir = path.join(tmpRoot, 'rev-check-repo');
    fs.mkdirSync(revDir, { recursive: true });
    gitInitCommit(revDir, [
      {
        author: 'Dev', email: 'dev@example.org', msg: 'feat: parent commit',
        files: { 'LICENSE': 'MIT License', 'README.md': '# Rev\n', 'src/a.js': 'export const v = 1;\n' },
      },
      {
        author: 'Dev', email: 'dev@example.org', msg: 'feat: head commit',
        files: { 'src/a.js': 'export const v = 2;\n' },
      },
    ], 'https://github.com/upstash/context7.git');

    const parentSha = spawnSync('git', ['rev-parse', 'HEAD~1'], { cwd: revDir, encoding: 'utf8' }).stdout.trim();
    const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: revDir, encoding: 'utf8' }).stdout.trim();
    ok(parentSha && headSha && parentSha !== headSha, 'distinct parent and HEAD SHAs created');

    // 21A: /tree/<parentSha> against checkout at <headSha> MUST be refused with exit 1 & keep full URL in input
    const treeUrl = `https://github.com/upstash/context7/tree/${parentSha}`;
    const rTree = runEval([treeUrl, '--workdir', revDir, '--offline']);
    eq(rTree.code, 1, '21A /tree/<sha> exits 1');
    eq(rTree.json.scan_completed, false, '21A scan_completed=false');
    eq(rTree.json.summary.exit_meaning, 'unsupported_url_refused', '21A exit_meaning=unsupported_url_refused');
    eq(rTree.json.repo_identity.identity_verified, false, '21A identity_verified=false');
    eq(rTree.json.repo_identity.matched, false, '21A matched=false');
    eq(rTree.json.input, treeUrl, '21A input preserves full /tree/<sha> URL (not shrunk to repo root)');

    // 21B: /commit/<parentSha> and --repo with /tree/<sha> also refused
    const commitUrl = `https://github.com/upstash/context7/commit/${parentSha}`;
    const rCommit = runEval([commitUrl, '--workdir', revDir, '--offline']);
    eq(rCommit.code, 1, '21B /commit/<sha> exits 1');
    eq(rCommit.json.summary.exit_meaning, 'unsupported_url_refused', '21B exit_meaning=unsupported_url_refused');

    const rBadRepo = runEval([revDir, '--repo', treeUrl, '--offline']);
    eq(rBadRepo.code, 1, '21B --repo with /tree/<sha> exits 1');

    // 21C: Control — repo root URL (with or without trailing slash) works cleanly against matching workdir
    const rRoot = runEval(['https://github.com/upstash/context7/', '--workdir', revDir, '--offline']);
    eq(rRoot.code, 2, '21C root URL offline exits 2');
    eq(rRoot.json.repo_identity.matched, true, '21C root URL matched=true');
    eq(rRoot.json.repo_identity.head_commit, headSha, '21C HEAD matches checkout');
  });

  // 22 --api-only / --no-clone lightweight remote triage mode
  await t('22 --api-only lightweight remote triage skips clone cleanly & enforces boundary errors', async () => {
    const readmeMd = [
      '# huge-sdk',
      '',
      'Telemetry is collected by default (`OPT_OUT=1`).',
      'Install: `pip install huge-sdk`',
      '[![Build](https://img.shields.io/badge/build-passing-green)](#)',
      '',
    ].join('\n');
    const srv22 = http.createServer((req, res) => {
      const u = (req.url || '').split('?')[0];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (u === '/repos/org/huge-sdk') {
        res.end(JSON.stringify({
          full_name: 'org/huge-sdk',
          stargazers_count: 5000,
          subscribers_count: 35,
          forks_count: 400,
          open_issues_count: 25,
          license: { spdx_id: 'Apache-2.0' },
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2026-11-20T00:00:00Z',
          size: 250000,
          language: 'C++',
          archived: false,
          owner: { login: 'org', type: 'Organization' },
        }));
      } else if (u === '/repos/org/huge-sdk/releases') {
        res.end(JSON.stringify([{ tag_name: 'v2026.1.0', published_at: '2026-11-10T00:00:00Z' }]));
      } else if (u === '/repos/org/huge-sdk/readme') {
        res.end(JSON.stringify({
          name: 'README.md',
          encoding: 'base64',
          size: Buffer.byteLength(readmeMd, 'utf8'),
          content: Buffer.from(readmeMd, 'utf8').toString('base64'),
        }));
      } else {
        res.end(JSON.stringify([]));
      }
    });
    await new Promise((resolve) => srv22.listen(0, '127.0.0.1', resolve));
    const base22 = `http://127.0.0.1:${srv22.address().port}`;
    try {
      // Case A: --api-only with --out compact summary
      const outA = path.join(tmpRoot, 'api-only-report.json');
      const rA = await runEvalAsync(['--api-only', 'https://github.com/org/huge-sdk', '--api-base', base22, '--out', outA]);
      eq(rA.code, 2, '22A --api-only exits 2 (partial coverage)');
      eq(rA.json?.summary?.exit_meaning, 'api_only_partial_coverage', '22A compact exit_meaning');
      eq(rA.json?.key_pointers?.install, null, '22A compact install is null');
      eq(rA.json?.key_pointers?.network_deps, null, '22A compact network_deps is null');
      const fullA = JSON.parse(fs.readFileSync(outA, 'utf8'));
      eq(fullA.mode, 'api_only', '22A full report mode=api_only');
      eq(fullA.activity_claims.github_api.size_kb, 250000, '22A size_kb=250000');
      eq(fullA.activity_claims.remote_readme.found, true, '22A remote_readme.found=true');
      ok(fullA.activity_claims.remote_readme.telemetry_mentions_count >= 1, '22A readme telemetry detected');
      const skippedScopes = (fullA.summary.scopes_skipped || []).map((s) => s.scope);
      ok(skippedScopes.includes('git_clone'), '22A scopes_skipped includes git_clone');
      ok(skippedScopes.includes('install_audit'), '22A scopes_skipped includes install_audit');
      ok(skippedScopes.includes('network_deps_audit'), '22A scopes_skipped includes network_deps_audit');

      // Case B: --api-only + --offline refused with exit 1
      const rB = await runEvalAsync(['--api-only', '--offline', 'https://github.com/org/huge-sdk']);
      eq(rB.code, 1, '22B --api-only --offline exits 1');
      eq(rB.json?.summary?.exit_meaning, 'api_only_incompatible_with_offline', '22B incompatible exit_meaning');

      // Case C: --api-only on plain non-GitHub dir without --repo refused with exit 1
      const plainDir = path.join(tmpRoot, 'plain-non-gh-dir');
      fs.mkdirSync(plainDir, { recursive: true });
      const rC = await runEvalAsync([plainDir, '--no-clone']);
      eq(rC.code, 1, '22C --no-clone without GitHub repo exits 1');
      eq(rC.json?.summary?.exit_meaning, 'api_only_requires_github_repo', '22C requires GitHub repo exit_meaning');
    } finally {
      srv22.close();
    }
  });

  const dSkill = fs.readFileSync(path.join(HERE, 'SKILL.md'), 'utf8');
  console.log(`\nD-group SKILL.md: ${dSkill.split(/\r?\n/).length} lines, ${dSkill.length} chars`);
} finally {
  if (process.platform === 'win32') {
    // Clear read-only attributes on .git/objects pack files before removal to avoid Windows EPERM on custom TMPDIR
    spawnSync('attrib', ['-R', '/S', '/D', path.join(tmpRoot, '*')], { encoding: 'utf8' });
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  } catch (e) {
    if (process.platform === 'win32') {
      spawnSync('cmd', ['/c', 'rd', '/s', '/q', tmpRoot], { encoding: 'utf8' });
    } else {
      fail++;
      console.error(`  ✗ cleanup failed: ${e.message}`);
    }
  }
  if (fs.existsSync(tmpRoot)) {
    fail++;
    console.error(`  ✗ cleanup verification failed: temporary directory still exists (${tmpRoot})`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
