#!/usr/bin/env node
// Comprehensive 17-case permanent regression suite for D-group pre-publish-audit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_ALL = path.join(HERE, 'scripts', 'audit_all.mjs');
const AUDIT_SECRETS = path.join(HERE, 'scripts', 'audit_secrets.mjs');
const AUDIT_PATHS = path.join(HERE, 'scripts', 'audit_paths_ports.mjs');
const CHECK_LINKS = path.join(HERE, 'scripts', 'check_links.mjs');

function runScript(scriptPath, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    cwd: HERE,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  let j = null;
  try { j = JSON.parse(r.stdout || ''); } catch {}
  return { code: r.status, json: j, out: r.stdout || '', err: r.stderr || '' };
}

function runAll(args, extraEnv = {}) { return runScript(AUDIT_ALL, args, extraEnv); }

function git(dir, args, extraEnv = {}) {
  return spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...extraEnv },
  });
}

function initRepo(dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  const name = opts.localName || 'Alice';
  const email = opts.localEmail !== undefined ? opts.localEmail : '12345+alice@users.noreply.github.com';
  if (name) git(dir, ['config', '--local', 'user.name', name]);
  if (email) git(dir, ['config', '--local', 'user.email', email]);
}

function writeFiles(dir, fileMap) {
  for (const [rel, content] of Object.entries(fileMap)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (Buffer.isBuffer(content)) fs.writeFileSync(full, content);
    else fs.writeFileSync(full, content, 'utf8');
  }
}

function commitAll(dir, msg, extraEnv = {}) {
  git(dir, ['add', '-A']);
  const r = git(dir, ['commit', '-qm', msg], extraEnv);
  if (r.status !== 0) throw new Error(`git commit failed: ${r.stderr || r.stdout}`);
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}
function ok(v, m) { if (!v) throw new Error(m || 'expected truthy'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

console.log('=== D-Group pre-publish-audit Regression Suite ===');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-publish-d-test-'));
const emptyGlobalGitCfg = path.join(tmpRoot, 'empty.gitconfig');
fs.writeFileSync(emptyGlobalGitCfg, '', 'utf8');
const isolatedGitEnv = { GIT_CONFIG_GLOBAL: emptyGlobalGitCfg, GIT_CONFIG_NOSYSTEM: '1', PRE_PUBLISH_PII: '' };
const aclRestores = [];

try {
  // 01 Clean repo (loopback compose, safely ignored .env & .wav, valid links & PNG asset, noreply identity)
  await t('01 clean repo exits 0 with safely ignored .env/.wav, loopback compose, and valid links', () => {
    const d = path.join(tmpRoot, '01-clean');
    initRepo(d);
    writeFiles(d, {
      '.gitignore': '.env\nrecordings/\n',
      'README.md': [
        '# Clean Project',
        '',
        '![demo](docs/assets/demo.png "Demo Screenshot")',
        '[Guide](<docs/my guide.md#install>)',
        '[Encoded](docs/my%20guide.md)',
        '',
        '```md',
        '![ignore-fenced](does/not/exist.png)',
        '```',
        'Inline code example: `![ignore-inline](also/missing.png)`',
      ].join('\n'),
      'docs/my guide.md': '# Install\n\nSee [Root](../README.md).\n',
      'docs/assets/demo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      'compose.yaml': [
        'services:',
        '  db:',
        '    image: postgres:16',
        '    ports:',
        '      - "127.0.0.1:5432:5432"',
        '    environment:',
        '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}',
      ].join('\n'),
      'src/app.py': 'import os\nKEY = os.getenv("API_KEY")\n',
    });
    commitAll(d, 'feat: clean baseline', isolatedGitEnv);
    // Add properly ignored local files AFTER commit
    writeFiles(d, {
      '.env': 'API_KEY=real_local_ignored_secret_987654321\n',
      'recordings/sample.wav': Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00]),
    });

    const r = runAll([d], isolatedGitEnv);
    eq(r.code, 0, 'clean exit 0');
    eq(r.json.summary.verdict, 'clean_automated_checks', 'verdict clean');
    eq(r.json.summary.high_count, 0, '0 high');
    eq(r.json.summary.medium_count, 0, '0 medium');
    ok(r.json.secrets.safely_ignored_sensitive_files.includes('.env'), '.env safely ignored');
    eq(r.json.paths_ports.privacy_files.safely_ignored_count, 2, '.env and sample.wav safely ignored');
    eq(r.json.paths_ports.compose_and_env.loopback_ports_count, 1, '1 loopback port');
    ok(r.json.links.calibration.local_links_checked >= 4, '4+ local links checked');
    eq(r.json.links.findings_count, 0, '0 broken links');
  });

  // 02 Secrets across all 3 scopes + signed URL + raw-secret non-leakage
  await t('02 secrets caught across tracked, untracked .env (git add -n), git history, signed URL with zero raw leak', () => {
    const d = path.join(tmpRoot, '02-secrets');
    initRepo(d);
    const awsKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const skKey = 'sk-' + 'live-' + '9a8b7c6d5e4f3a2b1c0d9e8f';
    const ghTok = 'ghp_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const sigVal = '9f8e7d6c5b4a3210abcdef1234567890';

    writeFiles(d, {
      'src/old.py': `OLD_KEY = "${awsKey}"\n`,
      '.env.prod': 'SECRET=1\n',
    });
    commitAll(d, 'init with leaked key', isolatedGitEnv);

    // Delete old leaked key & .env.prod in commit 2 (still lives in history!)
    fs.unlinkSync(path.join(d, '.env.prod'));
    writeFiles(d, {
      'src/old.py': 'OLD_KEY = ""\n',
      'src/current.js': `const token = "${skKey}";\nconst gh = "${ghTok}";\n`,
      'docs/img.md': `![pic](https://bucket.cos.ap-shanghai.myqcloud.com/a.png?${'q-' + 'ak='}${'AKID' + '1234567890abcdef'}${'&q-' + 'signature='}${sigVal})\n`,
      'certs/server.pem': '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIE...\n',
    });
    commitAll(d, 'remove old key, add new leaks', isolatedGitEnv);

    // Untracked unignored .env
    writeFiles(d, {
      '.env': 'DB_PASS=unignored_local_env_secret_value\n',
    });

    const outPath = path.join(tmpRoot, '02-report.json');
    const r = runAll([d, '--out', outPath], isolatedGitEnv);
    eq(r.code, 0, 'full coverage exit 0');
    const fullText = fs.readFileSync(outPath, 'utf8');
    const full = JSON.parse(fullText);

    // Raw-secret non-leakage invariant across BOTH stdout and full JSON file
    for (const secret of [awsKey, skKey, ghTok, sigVal]) {
      ok(!r.out.includes(secret), `stdout must NOT contain raw secret ${secret.slice(0, 6)}`);
      ok(!fullText.includes(secret), `report JSON must NOT contain raw secret ${secret.slice(0, 6)}`);
    }

    const kinds = new Set(full.secrets.findings.map((f) => `${f.scope}:${f.kind}`));
    ok(kinds.has('git_history:aws_access_key'), 'caught deleted AWS key in git history');
    ok(kinds.has('git_history:history_sensitive_file'), 'caught historical .env.prod');
    ok(kinds.has('tracked:openai_sk_key'), 'caught tracked sk- key');
    ok(kinds.has('tracked:github_pat'), 'caught tracked GitHub PAT');
    ok(kinds.has('tracked:signed_url'), 'caught signed URL');
    ok(kinds.has('tracked:tracked_sensitive_file'), 'caught tracked server.pem');
    ok(kinds.has('tracked:private_key_header'), 'caught PRIVATE KEY header');
    ok(kinds.has('untracked:untracked_unignored_sensitive_file'), 'caught untracked .env via git add -n');
  });

  // 03 False-positive guards (§1 task-<hex>, PGP Signature=, YAML volume mount, container /var/)
  await t('03 false-positive guards block task-<hex>, PGP Signature=, placeholders, and YAML volume mounts', () => {
    const d = path.join(tmpRoot, '03-fp-guards');
    initRepo(d);
    writeFiles(d, {
      'src/ids.ts': [
        'export const taskId = "task-0123456789abcdef0123456789abcdef";',
        'export const pgp = "-----BEGIN PGP SIGNATURE-----\\nPGP Signature=deadbeef1234567890abcdef";',
        'export const placeholder = "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx";',
        'export const envRead = process.env.API_KEY;',
        'export const schema = { password: "string" };',
      ].join('\n'),
      'compose.yaml': [
        'services:',
        '  asr:',
        '    image: asr:latest',
        '    volumes:',
        '      - asr_models:/models',
        '      - v:/data',
        '      - /var/lib/postgresql/data:/var/lib/postgresql/data',
      ].join('\n'),
    });
    commitAll(d, 'add benign patterns', isolatedGitEnv);

    const r = runAll([d], isolatedGitEnv);
    eq(r.code, 0, 'exit 0');
    eq(r.json.secrets.findings_count, 0, '0 secret false positives');
    const pathHigh = r.json.paths_ports.findings.filter((f) => f.severity === 'high');
    eq(pathHigh.length, 0, '0 high path false positives');
    ok(!r.json.paths_ports.findings.some((f) => (f.snippet || '').includes('asr_models:/models')), 'asr_models:/models ignored');
    ok(r.json.paths_ports.findings.some((f) => f.kind === 'yaml_volume_mount_needs_review' && f.severity === 'low'), 'v:/data downgraded to low needs_review');
    ok(r.json.paths_ports.findings.some((f) => f.kind === 'container_posix_path_needs_review' && f.severity === 'low'), '/var/... in compose downgraded to low');
  });

  // 04 §1b PII substring exhaustion across untracked test file & git history + zero raw PII leak
  await t('04 §1b PII split substrings caught in untracked test file + deleted git history with zero raw PII leak', () => {
    const d = path.join(tmpRoot, '04-pii');
    initRepo(d);
    const fakePhone = '158' + '5291' + '9462';
    const fakeMerchant = '星河' + '优选' + '商贸';

    writeFiles(d, {
      'src/prompt.txt': 'sample id 9462 was used earlier\n',
    });
    commitAll(d, 'add fragment', isolatedGitEnv);

    // Clean working tree in commit 2 (still in history diff!)
    writeFiles(d, {
      'src/prompt.txt': 'cleaned prompt\n',
    });
    commitAll(d, 'clean prompt', isolatedGitEnv);

    // Newly written UNTRACKED test file re-introducing split halves + CJK fragment
    writeFiles(d, {
      'tests/guard.test.js': [
        '// split phone halves',
        'const a = "15852";',
        'const b = "2919462";',
        'const shop = "星河优";',
      ].join('\n'),
    });

    const outPath = path.join(tmpRoot, '04-pii-report.json');
    const r = runAll([d, '--pii', `${fakePhone},${fakeMerchant}`, '--out', outPath], isolatedGitEnv);
    eq(r.code, 0, 'exit 0');
    const fullText = fs.readFileSync(outPath, 'utf8');
    const full = JSON.parse(fullText);

    eq(full.summary.pii_terms_checked, 2, '2 PII terms');
    const piiFindings = full.secrets.findings.filter((f) => f.kind === 'pii_substring_match');
    ok(piiFindings.some((f) => f.scope === 'untracked' && f.file === 'tests/guard.test.js' && f.pii_id === 'pii#1'), 'caught split phone in untracked test');
    ok(piiFindings.some((f) => f.scope === 'untracked' && f.file === 'tests/guard.test.js' && f.pii_id === 'pii#2'), 'caught CJK merchant fragment in untracked test');
    ok(piiFindings.some((f) => f.scope === 'git_history' && f.pii_id === 'pii#1'), 'caught 4-digit phone fragment in git history');

    // Zero raw PII or matched fragment leakage anywhere in stdout or report JSON
    for (const forbidden of [fakePhone, '15852', '2919462', '9462', fakeMerchant, '星河优']) {
      ok(!r.out.includes(forbidden), `stdout must NOT contain PII fragment ${forbidden}`);
      ok(!fullText.includes(forbidden), `report JSON must NOT contain PII fragment ${forbidden}`);
    }
  });

  // 05 §2 Hardcoded drive paths, POSIX paths, and file:/// URIs
  await t('05 §2 catches Windows drive paths, POSIX /data & /Users paths, and file:/// URIs', () => {
    const d = path.join(tmpRoot, '05-paths');
    initRepo(d);
    writeFiles(d, {
      'src/config.py': [
        'MODEL = r"E:\\models\\whisper\\large.bin"',
        'CACHE = "/data/cache/embeddings.db"',
        'HOME = "/Users/alice/Desktop/notes.txt"',
        'URI = "file:///C:/Users/alice/secret.json"',
      ].join('\n'),
    });
    commitAll(d, 'add hardcoded paths', isolatedGitEnv);

    const r = runAll([d], isolatedGitEnv);
    eq(r.code, 0, 'exit 0');
    const kinds = r.json.paths_ports.findings.map((f) => f.kind);
    ok(kinds.includes('hardcoded_drive_path'), 'caught drive path');
    ok(kinds.includes('hardcoded_posix_path'), 'caught POSIX path');
    ok(kinds.includes('file_uri_absolute_path'), 'caught file:/// URI');
    ok(r.json.summary.auto_fixable_count >= 4, 'classified as auto_fixable');
  });

  // 06 §4 Privacy media tracking via git ls-files + git add -n (even with blank lines in .gitignore)
  await t('06 §4 distinguishes tracked, untracked-unignored (git add -n), and safely-ignored audio files', () => {
    const d = path.join(tmpRoot, '06-privacy');
    initRepo(d);
    writeFiles(d, {
      '.gitignore': '\n\nignored_audio/\n\n',
      'audio/tracked.wav': Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00]),
    });
    commitAll(d, 'accidentally track wav', isolatedGitEnv);
    writeFiles(d, {
      'audio/unignored.mp3': Buffer.from([0x49, 0x44, 0x33, 0x00]),
      'ignored_audio/safe1.wav': Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00]),
      'ignored_audio/safe2.m4a': Buffer.from([0x00, 0x00, 0x00, 0x20]),
    });

    const r = runAll([d], isolatedGitEnv);
    eq(r.code, 0, 'exit 0');
    eq(r.json.paths_ports.privacy_files.tracked_count, 1, '1 tracked wav');
    eq(r.json.paths_ports.privacy_files.untracked_unignored_count, 1, '1 untracked unignored mp3');
    eq(r.json.paths_ports.privacy_files.safely_ignored_count, 2, '2 safely ignored audio files');
    const kinds = new Set(r.json.paths_ports.findings.map((f) => `${f.kind}:${f.file}`));
    ok(kinds.has('tracked_privacy_file:audio/tracked.wav'), 'flagged tracked wav');
    ok(kinds.has('untracked_unignored_privacy_file:audio/unignored.mp3'), 'flagged unignored mp3');
  });

  // 07 §5 Compose exposed ports (>6 lines under ports:, long syntax, both compose.yaml & docker-compose.yml) + default passwords
  await t('07 §5 catches >6th exposed port, long syntax, both compose filenames, and redacted default passwords', () => {
    const d = path.join(tmpRoot, '07-compose');
    initRepo(d);
    const dbSecret = 'SuperSecretPgPass99';
    writeFiles(d, {
      'compose.yaml': [
        'services:',
        '  web:',
        '    ports:',
        '      - "127.0.0.1:8001:8001"',
        '      - "127.0.0.1:8002:8002"',
        '      - "127.0.0.1:8003:8003"',
        '      - "127.0.0.1:8004:8004"',
        '      - "127.0.0.1:8005:8005"',
        '      - "127.0.0.1:8006:8006"',
        '      - "5432:5432"',
        '    environment:',
        `      POSTGRES_PASSWORD: ${dbSecret}`,
      ].join('\n'),
      'docker-compose.yml': [
        'services:',
        '  api:',
        '    ports:',
        '      - target: 8080',
        '        published: 8080',
      ].join('\n'),
      '.env.example': `REDIS_PASSWORD=dev_redis_12345\nAPI_KEY=\n`,
    });
    commitAll(d, 'add compose & env.example', isolatedGitEnv);

    const r = runAll([d], isolatedGitEnv);
    eq(r.code, 0, 'exit 0');
    eq(r.json.paths_ports.compose_and_env.compose_files_checked.length, 2, 'checked both compose.yaml and docker-compose.yml');
    eq(r.json.paths_ports.compose_and_env.env_example_files_checked.length, 1, 'checked .env.example');
    eq(r.json.paths_ports.compose_and_env.loopback_ports_count, 6, '6 loopback ports');
    eq(r.json.paths_ports.compose_and_env.exposed_ports_count, 2, '2 exposed ports (7th short + long syntax)');
    const pgPw = r.json.paths_ports.findings.find((f) => f.kind === 'default_password_in_config' && f.is_postgres_password);
    ok(pgPw && pgPw.value_redacted === true, 'flagged POSTGRES_PASSWORD with redaction');
    ok(!r.out.includes(dbSecret), 'must NOT echo raw compose password');
    ok(r.json.paths_ports.findings.some((f) => f.kind === 'default_password_in_config' && f.file === '.env.example'), 'flagged .env.example default password');
  });

  // 08 §7 Structural Markdown links (broken, docs/docs/ doubled, /data/ absolute, nested badge, escaping ../)
  await t('08 §7 structural link predicate catches docs/docs/ doubled path, /data/ absolute, nested badge, and ../ escape', () => {
    const d = path.join(tmpRoot, '08-links');
    initRepo(d);
    writeFiles(d, {
      'docs/assets/chart.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
      'docs/guide.md': [
        '# Guide',
        '![doubled](docs/assets/chart.png)',
        '![abs](/data/output/leak.png)',
        '[![nested](missing_badge.png)](https://example.com)',
        '[escape](../../outside.txt)',
        '![valid](assets/chart.png "Chart")',
      ].join('\n'),
    });
    commitAll(d, 'add broken links', isolatedGitEnv);

    const r = runScript(CHECK_LINKS, [d], isolatedGitEnv);
    eq(r.code, 0, 'exit 0');
    const doubled = r.json.findings.find((f) => f.link === 'docs/assets/chart.png');
    ok(doubled && doubled.hint === 'possible_repo_root_relative_path' && doubled.suggested_relative_link === 'assets/chart.png', 'caught doubled docs/docs/ with exact suggestion');
    ok(r.json.findings.some((f) => f.kind === 'absolute_local_link' && f.link === '/data/output/leak.png'), 'caught /data/ absolute markdown link');
    ok(r.json.findings.some((f) => f.kind === 'broken_local_link' && f.link === 'missing_badge.png'), 'caught nested image inside external link');
    ok(r.json.findings.some((f) => f.kind === 'escaping_repo_link' && f.link === '../../outside.txt'), 'caught ../ escaping link');
    eq(r.json.findings_count, 4, 'exact 4 link findings (valid chart.png passed)');
  });

  // 09 Symlink / Windows junction escaping repo refused & flagged
  await t('09 symlink/junction escaping repo is refused (never read, exit 2) and flagged in check_links', () => {
    const extDir = path.join(tmpRoot, '09-external');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'outside_secret.txt'), 'AKIA' + 'IOSFODNN7EXAMPLE\n', 'utf8');

    const d = path.join(tmpRoot, '09-symlink-repo');
    initRepo(d);
    writeFiles(d, {
      'README.md': '[leak](linked_ext/outside_secret.txt)\n',
    });
    commitAll(d, 'init', isolatedGitEnv);

    const linkPath = path.join(d, 'linked_ext');
    fs.symlinkSync(extDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

    const r = runAll([d], isolatedGitEnv);
    eq(r.code, 2, 'symlink escape causes incomplete coverage exit 2');
    ok(r.json.summary.skipped_sample.some((s) => s.reason === 'symlink_outside_repo'), 'walkSafe recorded symlink_outside_repo');
    eq(r.json.secrets.findings_count, 0, 'never read external file behind junction');
    ok(r.json.links.findings.some((f) => f.kind === 'escaping_symlink_link'), 'check_links caught escaping symlink link');
  });

  // 10 §9 Git commit identity (committer leak + missing local override) + §10 refs/original
  await t('10 §9 catches committer personal email + missing local override, and §10 catches refs/original', () => {
    const d = path.join(tmpRoot, '10-identity');
    initRepo(d, { localEmail: '' }); // NO local email override!
    const customGlobal = path.join(tmpRoot, '10-global.gitconfig');
    fs.writeFileSync(customGlobal, '[user]\n\tname = Bob\n\temail = bob.personal@corp.example\n', 'utf8');
    const envWithGlobal = { GIT_CONFIG_GLOBAL: customGlobal, GIT_CONFIG_NOSYSTEM: '1', PRE_PUBLISH_PII: '' };

    writeFiles(d, { 'README.md': '# Hello\n' });
    // Author is noreply, COMMITTER is personal!
    commitAll(d, 'commit with personal committer', {
      ...envWithGlobal,
      GIT_AUTHOR_NAME: 'Alice',
      GIT_AUTHOR_EMAIL: '12345+alice@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'Alice',
      GIT_COMMITTER_EMAIL: 'alice.real@gmail.com',
    });
    // Simulate leftover filter-branch refs/original
    const headSha = git(d, ['rev-parse', 'HEAD']).stdout.trim();
    git(d, ['update-ref', 'refs/original/refs/heads/main', headSha]);

    const r = runAll([d], envWithGlobal);
    eq(r.code, 0, 'exit 0');
    const histEmail = r.json.paths_ports.findings.find((f) => f.kind === 'historical_non_noreply_email');
    ok(histEmail && histEmail.email_masked === 'al***@gmail.com', 'caught & masked committer email');
    ok(!r.out.includes('alice.real@gmail.com'), 'never echoes raw personal committer email');
    const missingLocal = r.json.paths_ports.findings.find((f) => f.kind === 'missing_local_email_override');
    ok(missingLocal && missingLocal.email_masked === 'bo***@corp.example', 'caught global email without local override');
    ok(!r.out.includes('bob.personal@corp.example'), 'never echoes raw global email');
    ok(r.json.secrets.findings.some((f) => f.kind === 'leftover_filter_branch_backup_refs'), 'caught refs/original');
  });

  // 11 Subdirectory & Git worktree (.git file)
  await t('11 subdirectory and git worktree (.git file) resolve enclosing git repo cleanly', () => {
    const mainRepo = path.join(tmpRoot, '11-main');
    initRepo(mainRepo);
    writeFiles(mainRepo, {
      'README.md': '# Main\n',
      'packages/sub/index.js': 'export const ok = true;\n',
      'packages/sub/README.md': '[Home](../../README.md)\n',
    });
    commitAll(mainRepo, 'init main', isolatedGitEnv);

    // 11A: Subdirectory audit
    const subDir = path.join(mainRepo, 'packages', 'sub');
    const rSub = runAll([subDir], isolatedGitEnv);
    eq(rSub.code, 0, 'subdir exit 0');
    eq(rSub.json.git.is_work_tree, true, 'subdir is_work_tree');
    eq(rSub.json.git.is_subdir, true, 'subdir is_subdir');
    eq(rSub.json.links.findings_count, 0, 'subdir link to ../../README.md inside repo_root is valid');

    // 11B: Worktree audit (.git is a file!)
    const wtDir = path.join(tmpRoot, '11-worktree');
    const wtAdd = git(mainRepo, ['worktree', 'add', '-q', '-b', 'wt-branch', wtDir]);
    eq(wtAdd.status, 0, 'worktree add succeeded');
    const rWt = runAll([wtDir], isolatedGitEnv);
    eq(rWt.code, 0, 'worktree exit 0');
    eq(rWt.json.git.is_work_tree, true, 'worktree is_work_tree');
    eq(rWt.json.git.marker_type, 'file', 'worktree marker_type=file');
  });

  // 12 Non-git directory & --no-history fail-closed (exit 2)
  await t('12 non-git dir and --no-history fail closed with exit 2 (while standalone check_links exits 0)', () => {
    const noGit = path.join(tmpRoot, '12-no-git');
    writeFiles(noGit, {
      'README.md': '# Standalone\n[Doc](doc.md)\n',
      'doc.md': '# Doc\n',
    });
    // Use GIT_CEILING_DIRECTORIES to isolate from any enclosing repo
    const envCeil = { ...isolatedGitEnv, GIT_CEILING_DIRECTORIES: tmpRoot };

    const rNoGit = runAll([noGit], envCeil);
    eq(rNoGit.code, 2, 'non-git dir exits 2');
    eq(rNoGit.json.summary.verdict, 'incomplete_coverage', 'verdict incomplete_coverage');
    ok(rNoGit.json.summary.scopes_skipped.some((s) => s.scope === 'git_history'), 'git_history skipped');

    const rLinksOnly = runScript(CHECK_LINKS, [noGit], envCeil);
    eq(rLinksOnly.code, 0, 'standalone check_links on clean non-git exits 0');

    // --no-history on clean git repo -> exit 2
    const cleanGit = path.join(tmpRoot, '01-clean');
    const rNoHist = runAll([cleanGit, '--no-history'], isolatedGitEnv);
    eq(rNoHist.code, 2, '--no-history exits 2');
    ok(rNoHist.json.summary.scopes_skipped.some((s) => s.scope === 'git_history'), '--no-history logged in scopes_skipped');
  });

  // 13 Pre-first-commit (git init with 0 commits)
  await t('13 git init with 0 commits audits cleanly without git log error', () => {
    const d = path.join(tmpRoot, '13-unborn');
    initRepo(d);
    writeFiles(d, {
      'README.md': '# Brand New Repo\n',
      'src/main.js': 'console.log("hi");\n',
    });
    const r = runAll([d], isolatedGitEnv);
    eq(r.code, 0, 'unborn HEAD clean repo exits 0');
    eq(r.json.git.is_work_tree, true, 'is_work_tree=true');
    eq(r.json.git.head_commit, null, 'head_commit=null');
    eq(r.json.secrets.history.checked, true, 'history marked checked (0 commits)');
  });

  // 14 Unreadable file, oversized text file, and invalid UTF-8 .md -> graceful degradation (exit 2)
  await t('14 unreadable file, >512KB file, and invalid UTF-8 .md degrade cleanly to exit 2 without crash', () => {
    const d = path.join(tmpRoot, '14-degrade');
    initRepo(d);
    writeFiles(d, {
      'README.md': '# Normal\n',
      'docs/bad_utf8.md': Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x80, 0x0a]),
      'big.txt': 'a'.repeat(530 * 1024) + '\n',
      'locked.txt': 'cannot read me\n',
    });
    commitAll(d, 'add files', isolatedGitEnv);

    const lockedPath = path.join(d, 'locked.txt');
    const isUnreadable = (p) => {
      try {
        fs.readFileSync(p);
        return false;
      } catch {
        return true;
      }
    };
    let lockedOk = false;
    if (process.platform === 'win32') {
      const user = process.env.USERNAME || '';
      if (user) {
        const deny = spawnSync('icacls', [lockedPath, '/deny', `${user}:(R)`], { encoding: 'utf8' });
        if (deny.status === 0) {
          aclRestores.push(() => {
            spawnSync('icacls', [lockedPath, '/remove:d', user], { encoding: 'utf8' });
            spawnSync('icacls', [lockedPath, '/reset'], { encoding: 'utf8' });
          });
          lockedOk = isUnreadable(lockedPath);
        }
      }
      if (!lockedOk) {
        const denyEveryone = spawnSync('icacls', [lockedPath, '/inheritance:r', '/deny', '*S-1-1-0:(R)'], { encoding: 'utf8' });
        if (denyEveryone.status === 0) {
          aclRestores.push(() => {
            spawnSync('icacls', [lockedPath, '/remove:d', '*S-1-1-0'], { encoding: 'utf8' });
            spawnSync('icacls', [lockedPath, '/inheritance:e'], { encoding: 'utf8' });
            spawnSync('icacls', [lockedPath, '/reset'], { encoding: 'utf8' });
          });
          lockedOk = isUnreadable(lockedPath);
        }
      }
    } else {
      fs.chmodSync(lockedPath, 0o000);
      aclRestores.push(() => fs.chmodSync(lockedPath, 0o644));
      lockedOk = isUnreadable(lockedPath);
    }

    const r = runAll([d], isolatedGitEnv);
    eq(r.code, 2, 'degraded scan exits 2');
    eq(r.json.scan_completed, true, 'scan_completed=true');
    const reasons = r.json.summary.skipped_sample.map((s) => `${s.path}|${s.reason}`).join('\n');
    ok(reasons.includes('docs/bad_utf8.md') && reasons.includes('invalid_utf8'), 'recorded invalid UTF-8 .md');
    ok(reasons.includes('big.txt') && reasons.includes('file_too_large'), 'recorded >512KB file');
    if (lockedOk) {
      ok(reasons.includes('locked.txt') && (reasons.includes('read_failed') || reasons.includes('stat_failed')), 'recorded unreadable file');
    }
  });

  // 15 --out UTF-8 full report + compact stdout + --help
  await t('15 --out writes full UTF-8 JSON (no BOM) and prints compact summary; --help exits 0', () => {
    const d = path.join(tmpRoot, '01-clean');
    const outPath = path.join(tmpRoot, 'out dir', 'audit_report.json');
    const r = runAll([d, '--out', outPath], isolatedGitEnv);
    eq(r.code, 0, 'exit 0');
    eq(r.json.full_report_path, outPath, 'stdout includes full_report_path');
    ok(!r.json.secrets, 'compact stdout omits full secrets array');
    ok(r.json.calibration && r.json.calibration.secrets_files_scanned > 0, 'compact stdout includes calibration');

    const rawBytes = fs.readFileSync(outPath);
    ok(!(rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf), 'no UTF-8 BOM');
    const full = JSON.parse(rawBytes.toString('utf8'));
    ok(full.secrets && full.paths_ports && full.links, 'full report has all 3 sub-module sections');

    const h = runAll(['--help']);
    eq(h.code, 0, '--help exits 0');
    ok(h.out.includes('Usage:'), '--help prints usage');
  });

  // 16 Strict CLI flag validation & nonexistent dir (exit 1, zero stray files)
  await t('16 strict CLI rejects missing flag values, unknown flags, and nonexistent dir (exit 1, 0 stray files)', () => {
    const strayOut = path.join(tmpRoot, 'should-never-exist.json');
    const r1 = runAll(['--out', '--no-history']);
    eq(r1.code, 1, '--out --no-history exits 1');
    ok(!fs.existsSync(path.join(HERE, '--no-history')), 'no --no-history stray file created');

    const r2 = runAll([path.join(tmpRoot, '01-clean'), '--out']);
    eq(r2.code, 1, 'trailing --out exits 1');

    const r3 = runAll([path.join(tmpRoot, '01-clean'), '--pii']);
    eq(r3.code, 1, 'trailing --pii exits 1');

    const r4 = runAll([path.join(tmpRoot, '01-clean'), '--bogus-flag']);
    eq(r4.code, 1, 'unknown flag exits 1');

    const r5 = runAll([path.join(tmpRoot, 'does-not-exist'), '--out', strayOut]);
    eq(r5.code, 1, 'nonexistent dir exits 1');
    ok(!fs.existsSync(strayOut), 'nonexistent dir does NOT create --out file');

    const r6 = runScript(AUDIT_SECRETS, ['--unknown']);
    eq(r6.code, 1, 'audit_secrets rejects unknown flag');
    const r7 = runScript(AUDIT_PATHS, ['--out']);
    eq(r7.code, 1, 'audit_paths_ports rejects trailing --out');
  });

  // 17 §6 Doc drift hints (changed_files & stale_markers)
  await t('17 §6 captures uncommitted changed_files and stale doc markers in README/docs', () => {
    const d = path.join(tmpRoot, '17-drift');
    initRepo(d);
    writeFiles(d, {
      'README.md': '# App\n\n注意：当前尚未挂载 init.sql，需要手动建表。\nTODO: 补全部署说明。\n',
      'src/server.js': 'export const port = 3000;\n',
    });
    commitAll(d, 'init', isolatedGitEnv);
    // Modify tracked file without committing
    writeFiles(d, { 'src/server.js': 'export const port = 8080;\n' });

    const r = runAll([d], isolatedGitEnv);
    eq(r.code, 0, 'exit 0');
    eq(r.json.paths_ports.doc_drift_hints.changed_files_checked, true, 'changed_files checked');
    ok(r.json.paths_ports.doc_drift_hints.changed_files.includes('src/server.js'), 'captured modified src/server.js');
    eq(r.json.paths_ports.doc_drift_hints.stale_markers_total, 2, 'captured 2 stale doc marker lines');
  });

  // 18 Real-world signal-to-noise guards (unclosed backtick ReDoS, web-root / links, case-sensitive TODO, test path ranking)
  await t('18 signal-to-noise: linear backtick strip, web-root / routes skipped, case-sensitive TODO, test paths ranked below prod', () => {
    const d = path.join(tmpRoot, '18-snr');
    initRepo(d);
    writeFiles(d, {
      'README.md': [
        '# Board',
        'Columns: Backlog, Todo, In progress, Done.',
        'Unclosed backtick: `' + 'a'.repeat(500) + ' [doc](/docs/install/) ![hero](/assets/hero.png)',
        'Bad OS abs link: ![leak](/data/private.png)',
      ].join('\n'),
      'tests/parser.test.ts': 'const p = "/Users/fake/test.txt";\n',
      'src/loader.ts': 'const real = "/Users/alice/prod.txt";\n',
    });
    commitAll(d, 'init snr', isolatedGitEnv);

    const t0 = Date.now();
    const r = runAll([d], isolatedGitEnv);
    const ms = Date.now() - t0;
    eq(r.code, 0, 'exit 0');
    ok(ms < 10000, `fast linear scan (${ms}ms)`);
    eq(r.json.paths_ports.doc_drift_hints.stale_markers_total, 0, '"Todo" does not trigger TODO stale marker');
    eq(r.json.links.calibration.root_relative_links_skipped, 2, '2 web-root / routes skipped cleanly');
    eq(r.json.links.findings_count, 1, 'only /data/private.png flagged');
    eq(r.json.links.findings[0].kind, 'absolute_local_link', 'OS /data/ still caught');
    const autoFiles = r.json.summary.auto_fixable_grouped.items.map((x) => x.file);
    ok(autoFiles.includes('src/loader.ts'), 'production path present in auto_fixable');
    ok(!autoFiles.includes('tests/parser.test.ts'), 'test-fixture path does not pollute auto_fixable');
    ok(r.json.paths_ports.findings.some((f) => f.file === 'tests/parser.test.ts' && f.severity === 'low' && f.is_test_or_fixture), 'test path downgraded to low');
  });

  const dSkill = fs.readFileSync(path.join(HERE, 'SKILL.md'), 'utf8');
  console.log(`\nD-group pre-publish-audit SKILL.md: ${dSkill.split(/\r?\n/).length} lines, ${dSkill.length} chars`);
} finally {
  for (const fn of aclRestores) {
    try { fn(); } catch {}
  }
  if (process.platform === 'win32') {
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
