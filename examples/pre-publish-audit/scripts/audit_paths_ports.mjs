#!/usr/bin/env node
// D-group pre-publish-audit: §2 Hardcoded absolute paths (Drive + POSIX),
// §4 Privacy/sensitive file tracking (git ls-files + git add -n, NEVER git check-ignore),
// §5 Compose ports & default passwords, §6 Doc drift hints, §9 Git commit identity.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCliArgs,
  findEnclosingGitMarker,
  getGitFileSets,
  verifyGitAddDryRun,
  runGit,
  walkSafe,
  safeReadTextFile,
  maskEmail,
  normalizePosix,
  isTestOrFixturePath,
} from './shared.mjs';

const DRIVE_PATH_RE = /(?<![A-Za-z0-9_./:-])([A-Za-z]):[\\\/]([A-Za-z0-9_.\u4e00-\u9fff][^\s"'`<>|]*)/;
const POSIX_ABS_RE = /(?:["'`(\s=:,]|^)(\/(?:Users|home|root|data|opt|var|tmp|mnt|srv)\/[A-Za-z0-9_.\-\u4e00-\u9fff][^\s"'`<>|)]*)/;
const FILE_URI_RE = /\bfile:\/\/\/[^\s"'`<>)]+/i;
const YAML_EXT_RE = /\.ya?ml$/i;
const YAML_VOL_LINE_RE = /^\s*-\s*["']?[A-Za-z0-9_.-]+:\/[^\s"']*["']?\s*(?:#.*)?$/;
const CONTAINER_FILE_RE = /(?:^|\/)(?:Dockerfile(?:\.[^/]+)?|[^/]+\.dockerfile|(?:docker-)?compose(?:\.[^/]+)?\.ya?ml)$/i;

const PRIVACY_FILE_RE = /(?:^|\/)(?:\.env(?:\.[^/]+)?|[^/]+\.(?:pem|key|p12|pfx|jks|keystore|wav|mp3|m4a|mp4|mov|avi|mkv|ogg|flac|aac|sqlite|sqlite3|db|dump|pcap|har|kdbx)|[^/]+\.sql\.gz)$/i;
const EXAMPLE_ENV_RE = /(?:^|\/)\.env\.(?:example|sample|template|dist|defaults?)$/i;

const COMPOSE_FILE_RE = /(?:^|\/)(?:docker-)?compose(?:\.[^/]+)?\.ya?ml$/i;
const DOC_FILE_RE = /(?:^|\/)(?:README[^/]*\.md|docs\/.*\.md)$/i;
// Keep TODO/FIXME/TBD/WIP case-sensitive so Kanban UI column "Todo" does not false-match
const STALE_DOC_MARKER_RE = /\b(?:TODO|FIXME|TBD|WIP)\b|尚未|待补|暂未|不挂载|未挂载|手动建表|\bcoming soon\b/;

const PASSWORD_KEY_RE = /^\s*(?:-\s*)?["']?([A-Za-z0-9_]*(?:PASSWORD|PASSWD|password|passwd))["']?\s*[:=]\s*(.+?)\s*$/;
const SAFE_PLACEHOLDER_PW_RE = /^(?:["']?\s*["']?|["']?<[^>]+>["']?|["']?your[_-].*["']?|["']?placeholder.*["']?|["']?replace[_-]?me.*["']?|["']?change[_-]?me.*["']?|["']?\$\{[A-Za-z0-9_]+(?::?\?[^}]*)?\}["']?)$/i;

function classifyEmail(email) {
  const s = String(email || '').trim();
  if (!s) return 'empty';
  if (/@users\.noreply\.(?:github|gitlab)\.com$/i.test(s) || /^noreply@/i.test(s) || /\[bot\]@/i.test(s)) {
    return 'noreply';
  }
  if (/@(?:example\.(?:com|org|net)|localhost|invalid|test\.local)$/i.test(s)) {
    return 'example';
  }
  return 'non_noreply';
}

function isLoopbackPortSpec(spec) {
  const s = String(spec || '').trim().replace(/^["']|["']$/g, '');
  if (!s) return true;
  if (/^(?:127\.0\.0\.1|\[::1\]|localhost):/i.test(s)) return true;
  if (/^\$\{[^}]+:-127\.0\.0\.1\}:/i.test(s)) return true;
  if (/^\$\{[^}]+:-localhost\}:/i.test(s)) return true;
  if (/^\$\{[^}]+:-\[::1\]\}:/i.test(s)) return true;
  // Container-only port without host binding (single port e.g. "80" or "80/tcp") still publishes random host port on 0.0.0.0 in Compose!
  return false;
}

function auditComposeFile(relPath, lines, findings) {
  let loopbackPorts = 0;
  let exposedPorts = 0;

  // 1. Indentation-aware ports: block parser (handles both short & long compose syntax)
  let inPorts = false;
  let portsIndent = -1;
  let inLongEntry = false;
  let longEntryIndent = -1;
  let longEntryStartLine = -1;
  let longEntryPublished = null;
  let longEntryHostIp = null;

  function flushLongEntry() {
    if (!inLongEntry) return;
    if (longEntryPublished !== null) {
      if (longEntryHostIp && /^(?:127\.0\.0\.1|::1|localhost)$/i.test(longEntryHostIp)) {
        loopbackPorts++;
      } else {
        exposedPorts++;
        findings.push({
          severity: 'medium',
          kind: 'compose_exposed_port',
          file: relPath,
          line: longEntryStartLine,
          mapping: `${longEntryHostIp || '0.0.0.0'}:${longEntryPublished}`,
          note: '端口未绑定回环地址（默认监听 0.0.0.0），本机开发服务建议改为 127.0.0.1',
        });
      }
    }
    inLongEntry = false;
    longEntryIndent = -1;
    longEntryStartLine = -1;
    longEntryPublished = null;
    longEntryHostIp = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const trimmed = raw.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = raw.match(/^(\s*)/)[1].length;

    if (inPorts) {
      const isListAtSameIndent = indent === portsIndent && trimmed.startsWith('-');
      if (indent < portsIndent || (indent === portsIndent && !isListAtSameIndent)) {
        flushLongEntry();
        inPorts = false;
      } else {
        // Inside ports: block
        const shortMatch = trimmed.match(/^-\s+(?!(?:target|published|host_ip|protocol|mode|app_protocol)\s*:)(.+?)(?:\s+#.*)?$/);
        if (shortMatch) {
          flushLongEntry();
          const spec = shortMatch[1].trim().replace(/^["']|["']$/g, '');
          if (spec && !spec.startsWith('{')) {
            if (isLoopbackPortSpec(spec)) {
              loopbackPorts++;
            } else {
              exposedPorts++;
              findings.push({
                severity: 'medium',
                kind: 'compose_exposed_port',
                file: relPath,
                line: lineNo,
                mapping: spec,
                note: '端口未绑定 127.0.0.1（Docker Compose 默认监听 0.0.0.0）',
              });
            }
          }
          continue;
        }
        // Long syntax entry: `- target: 5432` / `  published: 5432` / `  host_ip: 127.0.0.1`
        if (trimmed.startsWith('-')) {
          flushLongEntry();
          inLongEntry = true;
          longEntryIndent = indent;
          longEntryStartLine = lineNo;
        }
        if (inLongEntry && indent >= longEntryIndent) {
          const pubM = trimmed.match(/^(?:-\s*)?published\s*:\s*["']?([^"'\s#]+)["']?/);
          if (pubM) longEntryPublished = pubM[1];
          const ipM = trimmed.match(/^(?:-\s*)?host_ip\s*:\s*["']?([^"'\s#]+)["']?/);
          if (ipM) longEntryHostIp = ipM[1];
        }
        continue;
      }
    }

    const portsStart = raw.match(/^(\s*)ports\s*:\s*(?:#.*)?$/);
    if (portsStart) {
      inPorts = true;
      portsIndent = portsStart[1].length;
    }
  }
  flushLongEntry();

  // 2. Default passwords in compose file
  auditDefaultPasswords(relPath, lines, findings);

  return { loopbackPorts, exposedPorts };
}

function auditDefaultPasswords(relPath, lines, findings) {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Strip inline comment outside quotes
    const noComment = raw.replace(/\s+#.*$/, '');
    const m = noComment.match(PASSWORD_KEY_RE);
    if (!m) continue;
    const varName = m[1];
    const val = m[2].trim();
    if (!val || SAFE_PLACEHOLDER_PW_RE.test(val)) continue;
    // Ignore YAML mapping keys with nested blocks (val is empty) or boolean flags
    if (/^(?:true|false|null|none|~)$/i.test(val)) continue;

    const usesFallback = /\$\{[^}]+:-[^}]+\}/.test(val);
    const isPostgres = /POSTGRES_PASSWORD/i.test(varName);
    findings.push({
      severity: 'medium',
      kind: 'default_password_in_config',
      file: relPath,
      line: i + 1,
      var_name: varName,
      uses_env_default_fallback: usesFallback,
      is_postgres_password: isPostgres,
      value_redacted: true,
      note: isPostgres
        ? '包含默认数据库口令；注意 POSTGRES_PASSWORD 仅在数据卷为空时生效，已有卷直接改它会导致连接失败'
        : '配置文件包含非空默认口令，公开或上服务器前需确认是否应改为必填环境变量并说明修改方式',
    });
  }
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
  const scopesChecked = [];
  const scopesSkipped = [];
  const findings = [];
  const skipped = [];

  const walked = ctx ? ctx.walked : walkSafe(targetDir);
  skipped.push(...walked.skipped);

  let gitSets = ctx ? ctx.gitSets : { ok: false, tracked: new Set(), untracked: new Set(), error: null };
  if (gitInfo.is_work_tree) {
    if (!ctx) gitSets = getGitFileSets(targetDir, gitInfo);
    if (!gitSets.ok) {
      scopesSkipped.push({ scope: 'git_tracking', reason: gitSets.error });
    } else {
      scopesChecked.push('paths_tracked_and_untracked', 'privacy_file_tracking');
    }
  } else {
    scopesChecked.push('paths_working_tree');
    scopesSkipped.push({
      scope: 'git_tracking',
      reason: gitInfo.error || 'not_a_git_repository',
    });
  }

  // §4 Privacy files tracking check
  const privacyTracked = [];
  const privacyUntrackedCandidates = [];
  const privacySafelyIgnored = [];

  if (gitSets.ok) {
    for (const rel of gitSets.tracked) {
      if (PRIVACY_FILE_RE.test(rel) && !EXAMPLE_ENV_RE.test(rel)) {
        privacyTracked.push(rel);
        findings.push({
          severity: 'high',
          kind: 'tracked_privacy_file',
          file: rel,
          note: '隐私/媒体/密钥文件已被 git 跟踪，提交或公开仓库会直接泄露',
        });
      }
    }
  }

  const composeFilesChecked = [];
  const envExampleFilesChecked = [];
  const staleDocMarkers = [];
  let staleDocMarkersTotal = 0;
  let filesScanned = 0;
  let binaryFilesSkipped = 0;
  let totalLoopbackPorts = 0;
  let totalExposedPorts = 0;

  for (const f of walked.files) {
    const isExampleEnv = EXAMPLE_ENV_RE.test(f.rel);
    const isPrivacyFile = PRIVACY_FILE_RE.test(f.rel) && !isExampleEnv;

    if (gitSets.ok) {
      const isTracked = gitSets.tracked.has(f.rel);
      const isUntracked = gitSets.untracked.has(f.rel);

      if (!isTracked && !isUntracked) {
        if (isPrivacyFile) privacySafelyIgnored.push(f.rel);
        continue;
      }

      if (isUntracked && isPrivacyFile) {
        privacyUntrackedCandidates.push(f.rel);
      }
    } else if (isPrivacyFile) {
      findings.push({
        severity: 'high',
        kind: 'working_tree_privacy_file',
        file: f.rel,
        note: '非 git 目录中存在隐私/媒体/密钥文件，无法确认忽略状态',
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

    const isYaml = YAML_EXT_RE.test(f.rel);
    const isContainerFile = CONTAINER_FILE_RE.test(f.rel);
    const isTest = isTestOrFixturePath(f.rel);

    // §2 Hardcoded absolute paths (Form A drive + Form B POSIX + file:///)
    for (let i = 0; i < readRes.lines.length; i++) {
      const line = readRes.lines[i];
      if (!line) continue;
      const lineNo = i + 1;

      const fileUriM = line.match(FILE_URI_RE);
      if (fileUriM) {
        findings.push({
          severity: isTest ? 'low' : 'high',
          kind: 'file_uri_absolute_path',
          file: f.rel,
          line: lineNo,
          ...(isTest ? { is_test_or_fixture: true } : {}),
          match: fileUriM[0].slice(0, 120),
          snippet: line.trim().slice(0, 140),
        });
      }

      const driveM = line.match(DRIVE_PATH_RE);
      if (driveM) {
        if (isYaml && YAML_VOL_LINE_RE.test(line)) {
          findings.push({
            severity: 'low',
            kind: 'yaml_volume_mount_needs_review',
            needs_review: true,
            file: f.rel,
            line: lineNo,
            match: driveM[0].slice(0, 120),
            snippet: line.trim().slice(0, 140),
          });
        } else {
          findings.push({
            severity: isTest ? 'low' : 'high',
            kind: 'hardcoded_drive_path',
            file: f.rel,
            line: lineNo,
            ...(isTest ? { is_test_or_fixture: true } : {}),
            match: driveM[0].slice(0, 120),
            snippet: line.trim().slice(0, 140),
          });
        }
      }

      const posixM = line.match(POSIX_ABS_RE);
      if (posixM) {
        const matchedPath = posixM[1];
        const isContainerCommon = isContainerFile && /^\/(?:var|opt|tmp)\//.test(matchedPath);
        if (isContainerCommon) {
          findings.push({
            severity: 'low',
            kind: 'container_posix_path_needs_review',
            needs_review: true,
            file: f.rel,
            line: lineNo,
            match: matchedPath.slice(0, 120),
            snippet: line.trim().slice(0, 140),
          });
        } else {
          const isPersonalOrData = /^\/(?:Users|home|root|data)\//.test(matchedPath);
          findings.push({
            severity: isTest ? 'low' : (isPersonalOrData ? 'high' : 'medium'),
            kind: 'hardcoded_posix_path',
            file: f.rel,
            line: lineNo,
            ...(isTest ? { is_test_or_fixture: true } : {}),
            match: matchedPath.slice(0, 120),
            snippet: line.trim().slice(0, 140),
          });
        }
      }

      // §6 Stale doc markers in README / docs/
      if (DOC_FILE_RE.test(f.rel) && STALE_DOC_MARKER_RE.test(line)) {
        staleDocMarkersTotal++;
        if (staleDocMarkers.length < 30) {
          staleDocMarkers.push({
            file: f.rel,
            line: lineNo,
            snippet: line.trim().slice(0, 140),
          });
        }
      }
    }

    // §5 Compose files & .env.example
    if (COMPOSE_FILE_RE.test(f.rel)) {
      composeFilesChecked.push(f.rel);
      const res = auditComposeFile(f.rel, readRes.lines, findings);
      totalLoopbackPorts += res.loopbackPorts;
      totalExposedPorts += res.exposedPorts;
    } else if (isExampleEnv) {
      envExampleFilesChecked.push(f.rel);
      auditDefaultPasswords(f.rel, readRes.lines, findings);
    }
  }

  // Confirm untracked privacy files via `git add -n` (NEVER git check-ignore!)
  const privacyUntrackedConfirmed = [];
  if (gitSets.ok && privacyUntrackedCandidates.length > 0) {
    const dry = verifyGitAddDryRun(targetDir, privacyUntrackedCandidates);
    const repoRootReal = gitInfo.repo_root ? fs.realpathSync(gitInfo.repo_root) : null;
    const subdirPrefix = repoRootReal && gitInfo.is_subdir
      ? normalizePosix(path.relative(repoRootReal, walked.rootReal)) + '/'
      : '';

    for (const rel of privacyUntrackedCandidates) {
      if (dry.wouldAdd.has(rel) || (subdirPrefix && dry.wouldAdd.has(subdirPrefix + rel))) {
        privacyUntrackedConfirmed.push(rel);
        findings.push({
          severity: 'high',
          kind: 'untracked_unignored_privacy_file',
          file: rel,
          note: '未被 git 忽略，经 `git add -n` 实测会被纳入提交',
        });
      } else {
        privacySafelyIgnored.push(rel);
      }
    }
    if (!dry.ok) {
      scopesSkipped.push({ scope: 'git_add_dry_run_privacy', reason: dry.errors.join('; ') });
    }
  }

  scopesChecked.push('compose_ports_and_passwords', 'doc_stale_markers');

  // §6 Changed files summary (git diff --stat HEAD)
  const docDriftHints = {
    changed_files_checked: false,
    changed_files_count: 0,
    changed_files: [],
    stale_markers_total: staleDocMarkersTotal,
    stale_markers_truncated: staleDocMarkersTotal > staleDocMarkers.length,
    stale_markers: staleDocMarkers,
  };

  if (gitInfo.is_work_tree && gitInfo.has_commits) {
    const diffRes = runGit(['-c', 'core.quotepath=false', 'diff', '--name-only', 'HEAD'], targetDir);
    if (!diffRes.error && diffRes.status === 0) {
      const changed = diffRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      docDriftHints.changed_files_checked = true;
      docDriftHints.changed_files_count = changed.length;
      docDriftHints.changed_files = changed.slice(0, 50);
    }
  }

  // §9 Git commit identity (author & committer emails + local config override)
  const gitIdentity = {
    checked: false,
    historical_emails_count: 0,
    historical_emails_masked: [],
    effective_email_masked: null,
    effective_email_kind: null,
    config_origin: null,
    has_local_email_override: null,
  };

  if (!gitInfo.is_work_tree) {
    scopesSkipped.push({ scope: 'git_identity', reason: gitInfo.error || 'not_a_git_repository' });
  } else {
    const repoRoot = gitInfo.repo_root || targetDir;
    let identityOk = true;

    if (gitInfo.has_commits) {
      const logEmails = runGit(['log', '--all', '--format=%ae%n%ce'], repoRoot);
      if (logEmails.error || logEmails.status !== 0) {
        identityOk = false;
        scopesSkipped.push({
          scope: 'git_identity_history',
          reason: (logEmails.error?.message || logEmails.stderr || 'git log email query failed').trim(),
        });
      } else {
        const uniq = [...new Set(logEmails.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
        gitIdentity.historical_emails_count = uniq.length;
        for (const em of uniq) {
          const kind = classifyEmail(em);
          const masked = maskEmail(em);
          gitIdentity.historical_emails_masked.push({ email_masked: masked, kind });
          if (kind === 'non_noreply') {
            findings.push({
              severity: 'medium',
              kind: 'historical_non_noreply_email',
              file: '.git (commit history)',
              email_masked: masked,
              note: '提交历史 author/committer 含非 noreply 邮箱，公开前需确认是否需要脱敏/孤儿分支重建历史',
            });
          }
        }
      }
    }

    const effRes = runGit(['config', '--show-origin', '--get', 'user.email'], repoRoot);
    const localRes = runGit(['config', '--local', '--get', 'user.email'], repoRoot);
    const hasLocal = !localRes.error && localRes.status === 0 && !!localRes.stdout.trim();
    gitIdentity.has_local_email_override = hasLocal;

    if (!effRes.error && effRes.status === 0 && effRes.stdout.trim()) {
      const parts = effRes.stdout.trim().split('\t');
      const origin = parts.length >= 2 ? parts[0] : 'unknown';
      const email = parts.length >= 2 ? parts.slice(1).join('\t').trim() : parts[0].trim();
      const kind = classifyEmail(email);
      const masked = maskEmail(email);
      gitIdentity.effective_email_masked = masked;
      gitIdentity.effective_email_kind = kind;
      gitIdentity.config_origin = origin;

      if (kind === 'non_noreply' && !hasLocal) {
        findings.push({
          severity: 'medium',
          kind: 'missing_local_email_override',
          file: '.git/config',
          email_masked: masked,
          config_origin: origin,
          note: '当前生效的 user.email 来自全局/系统配置且无仓库 local 覆盖，下一次普通 git commit 会写入真实邮箱',
        });
      }
    }

    if (identityOk) {
      gitIdentity.checked = true;
      scopesChecked.push('git_identity');
    }
  }

  const incomplete = scopesSkipped.length > 0 || skipped.length > 0;
  const highCount = findings.filter((f) => f.severity === 'high').length;
  const mediumCount = findings.filter((f) => f.severity === 'medium').length;
  const lowCount = findings.filter((f) => f.severity === 'low').length;

  return {
    facts: {
      scan_completed: true,
      target_dir: targetDir,
      calibration: {
        files_scanned: filesScanned,
        binary_files_skipped: binaryFilesSkipped,
      },
      privacy_files: {
        tracked_count: privacyTracked.length,
        untracked_unignored_count: privacyUntrackedConfirmed.length,
        safely_ignored_count: privacySafelyIgnored.length,
        safely_ignored_sample: privacySafelyIgnored.slice(0, 10),
      },
      compose_and_env: {
        compose_files_checked: composeFilesChecked,
        env_example_files_checked: envExampleFilesChecked,
        loopback_ports_count: totalLoopbackPorts,
        exposed_ports_count: totalExposedPorts,
      },
      doc_drift_hints: docDriftHints,
      git_identity: gitIdentity,
      findings_count: findings.length,
      high_count: highCount,
      medium_count: mediumCount,
      low_count: lowCount,
      findings,
      scopes_checked: scopesChecked,
      scopes_skipped: scopesSkipped,
      skipped,
    },
    exitCode: incomplete ? 2 : 0,
  };
}

function printHelp() {
  console.log(`Usage: node audit_paths_ports.mjs [target_dir] [--out <file>] [--help]
Checks hardcoded drive/POSIX paths, privacy file tracking (git add -n), compose ports/default passwords, doc drift hints, and git commit identity.
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
