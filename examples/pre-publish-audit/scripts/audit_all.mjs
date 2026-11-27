#!/usr/bin/env node
// D-group pre-publish-audit composite entry: runs all 3 deterministic modules in-process
// (secrets/PII/signed-URLs + paths/privacy/ports/passwords/identity + structural Markdown links).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCliArgs,
  findEnclosingGitMarker,
  getGitFileSets,
  walkSafe,
} from './shared.mjs';
import { run as runSecrets } from './audit_secrets.mjs';
import { run as runPathsPorts } from './audit_paths_ports.mjs';
import { run as runLinks } from './check_links.mjs';

const AUTO_FIXABLE_KINDS = new Set([
  'hardcoded_drive_path',
  'hardcoded_posix_path',
  'file_uri_absolute_path',
  'broken_local_link',
  'broken_root_relative_link',
  'absolute_local_link',
  'escaping_repo_link',
  'escaping_symlink_link',
]);

const DECISION_KINDS = new Set([
  'aws_access_key',
  'tencent_secret_id',
  'openai_sk_key',
  'github_pat',
  'private_key_header',
  'generic_secret_assign',
  'signed_url',
  'pii_substring_match',
  'tracked_sensitive_file',
  'untracked_unignored_sensitive_file',
  'working_tree_sensitive_file',
  'history_sensitive_file',
  'leftover_filter_branch_backup_refs',
  'tracked_privacy_file',
  'untracked_unignored_privacy_file',
  'working_tree_privacy_file',
  'compose_exposed_port',
  'default_password_in_config',
  'historical_non_noreply_email',
  'missing_local_email_override',
]);

function dedupByKey(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function groupFindingsForSummary(findings, maxGroups = 30) {
  const map = new Map();
  for (const f of findings) {
    const loc = f.commit ? `${f.file}@${f.commit}` : (f.file || '(unknown)');
    const k = `${f.severity}|${f.kind}|${loc}`;
    let g = map.get(k);
    if (!g) {
      g = {
        severity: f.severity,
        kind: f.kind,
        file: f.file || '(unknown)',
        ...(f.is_test_or_fixture ? { is_test_or_fixture: true } : {}),
        ...(f.scope ? { scope: f.scope } : {}),
        ...(f.commit ? { commit: f.commit } : {}),
        lines: [],
        count: 0,
        note: f.note || null,
        ...(f.suggested_relative_link ? { suggested_relative_link: f.suggested_relative_link } : {}),
        ...(f.email_masked ? { email_masked: f.email_masked } : {}),
        ...(f.var_name ? { var_name: f.var_name } : {}),
        ...(f.is_postgres_password ? { is_postgres_password: true } : {}),
        ...(f.pii_id ? { pii_id: f.pii_id } : {}),
      };
      map.set(k, g);
    }
    g.count++;
    if (f.line && !g.lines.includes(f.line)) g.lines.push(f.line);
  }
  const severityRank = { high: 0, medium: 1, low: 2 };
  // Rank non-test production/doc files ahead of test fixtures, then severity, then hit count
  const groups = [...map.values()].sort(
    (a, b) =>
      (a.is_test_or_fixture ? 1 : 0) - (b.is_test_or_fixture ? 1 : 0) ||
      (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) ||
      b.count - a.count,
  );
  return {
    total_groups: groups.length,
    truncated: groups.length > maxGroups,
    items: groups.slice(0, maxGroups).map((g) => ({
      ...g,
      lines: g.lines.slice(0, 8),
      ...(g.lines.length > 8 ? { more_lines: g.lines.length - 8 } : {}),
    })),
  };
}

export async function run(options = {}) {
  const targetDir = path.resolve(options.target || process.cwd());
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    return {
      facts: {
        scan_completed: false,
        target_dir: targetDir,
        error: `target directory does not exist or is not a directory: ${targetDir}`,
        summary: {
          exit_meaning: 'error',
          verdict: 'error',
          high_count: 0,
          medium_count: 0,
          low_count: 0,
          auto_fixable_count: 0,
          needs_user_decision_count: 0,
          scopes_checked: [],
          scopes_skipped: [],
          skipped_count: 0,
        },
      },
      exitCode: 1,
    };
  }

  // Compute shared directory walk + git state once (avoids 3x duplicate tree walks & git calls)
  const gitInfo = findEnclosingGitMarker(targetDir);
  const gitSets = gitInfo.is_work_tree
    ? getGitFileSets(targetDir, gitInfo)
    : { ok: false, tracked: new Set(), untracked: new Set(), error: gitInfo.error || 'not_a_git_repository' };
  const walked = walkSafe(targetDir);
  const sharedCtx = { gitInfo, gitSets, walked };

  const [secRes, pathRes, linkRes] = await Promise.all([
    runSecrets({ target: targetDir, pii: options.pii, noHistory: !!options.noHistory, _ctx: sharedCtx }),
    runPathsPorts({ target: targetDir, _ctx: sharedCtx }),
    runLinks({ target: targetDir, _ctx: sharedCtx }),
  ]);

  if (secRes.exitCode === 1 || pathRes.exitCode === 1 || linkRes.exitCode === 1) {
    return {
      facts: {
        scan_completed: false,
        target_dir: targetDir,
        error: secRes.facts.error || pathRes.facts.error || linkRes.facts.error || 'sub-module failed',
        secrets: secRes.facts,
        paths_ports: pathRes.facts,
        links: linkRes.facts,
        summary: {
          exit_meaning: 'error',
          verdict: 'error',
          high_count: 0,
          medium_count: 0,
          low_count: 0,
          auto_fixable_count: 0,
          needs_user_decision_count: 0,
          scopes_checked: [],
          scopes_skipped: [],
          skipped_count: 0,
        },
      },
      exitCode: 1,
    };
  }

  // Deduplicate tracked/untracked sensitive files that overlap between audit_secrets (.env/.pem/.key) and audit_paths_ports (§4)
  const secSensitiveFiles = new Set(
    secRes.facts.findings
      .filter((f) => ['tracked_sensitive_file', 'untracked_unignored_sensitive_file', 'working_tree_sensitive_file'].includes(f.kind))
      .map((f) => f.file),
  );
  const pathFindingsDeduped = pathRes.facts.findings.filter((f) => {
    if (['tracked_privacy_file', 'untracked_unignored_privacy_file', 'working_tree_privacy_file'].includes(f.kind)) {
      return !secSensitiveFiles.has(f.file);
    }
    return true;
  });

  const allFindings = [
    ...secRes.facts.findings.map((f) => ({ module: 'secrets', ...f })),
    ...pathFindingsDeduped.map((f) => ({ module: 'paths_ports', ...f })),
    ...linkRes.facts.findings.map((f) => ({ module: 'links', ...f })),
  ];

  const autoFixable = [];
  const needsDecision = [];
  const needsReviewLow = [];

  for (const f of allFindings) {
    if (f.severity === 'low') {
      needsReviewLow.push(f);
    } else if (AUTO_FIXABLE_KINDS.has(f.kind)) {
      autoFixable.push(f);
    } else if (DECISION_KINDS.has(f.kind)) {
      needsDecision.push(f);
    } else {
      needsDecision.push(f);
    }
  }

  const scopesChecked = [...new Set([
    ...(secRes.facts.scopes_checked || []),
    ...(pathRes.facts.scopes_checked || []),
    ...(linkRes.facts.scopes_checked || []),
  ])];

  const scopesSkipped = dedupByKey(
    [
      ...(secRes.facts.scopes_skipped || []),
      ...(pathRes.facts.scopes_skipped || []),
      ...(linkRes.facts.scopes_skipped || []),
    ],
    (x) => `${x.scope}|${x.reason}`,
  );

  const skipped = dedupByKey(
    [
      ...(secRes.facts.skipped || []),
      ...(pathRes.facts.skipped || []),
      ...(linkRes.facts.skipped || []),
    ],
    (x) => `${x.path}|${x.reason}`,
  );

  const incomplete =
    secRes.exitCode === 2 ||
    pathRes.exitCode === 2 ||
    linkRes.exitCode === 2 ||
    scopesSkipped.length > 0 ||
    skipped.length > 0;

  const highCount = allFindings.filter((f) => f.severity === 'high').length;
  const mediumCount = allFindings.filter((f) => f.severity === 'medium').length;
  const lowCount = allFindings.filter((f) => f.severity === 'low').length;
  const testFixtureCount = allFindings.filter((f) => f.is_test_or_fixture).length;

  const manualRemaining = [
    '§6 文档与实现语义一致性（对照 changed_files 与代码核实文档说法）',
    '§8 无上下文读者子 agent 复核（仅 README/重要文档改动时按需执行）',
    ...(secRes.facts.pii_config.terms_count === 0
      ? ['§1b 个人敏感信息子串穷举未启用（未提供 --pii / PRE_PUBLISH_PII）']
      : []),
  ];

  let verdict = 'clean_automated_checks';
  if (highCount > 0) verdict = 'blocking_findings';
  else if (mediumCount > 0) verdict = 'review_required';
  else if (incomplete) verdict = 'incomplete_coverage';

  const summary = {
    exit_meaning: incomplete ? 'incomplete_coverage' : 'complete_coverage',
    verdict,
    high_count: highCount,
    medium_count: mediumCount,
    low_count: lowCount,
    auto_fixable_count: autoFixable.length,
    needs_user_decision_count: needsDecision.length,
    needs_review_low_count: needsReviewLow.length,
    test_fixture_findings_count: testFixtureCount,
    pii_terms_checked: secRes.facts.pii_config.terms_count,
    auto_fixable_grouped: groupFindingsForSummary(autoFixable, 25),
    needs_user_decision_grouped: groupFindingsForSummary(needsDecision, 25),
    needs_review_low_grouped: groupFindingsForSummary(needsReviewLow, 15),
    scopes_checked: scopesChecked,
    scopes_skipped: scopesSkipped,
    skipped_count: skipped.length,
    skipped_sample: skipped.slice(0, 15),
    manual_checks_remaining: manualRemaining,
  };

  return {
    facts: {
      scan_completed: true,
      target_dir: targetDir,
      git: secRes.facts.git,
      summary,
      secrets: secRes.facts,
      paths_ports: pathRes.facts,
      links: linkRes.facts,
    },
    exitCode: incomplete ? 2 : 0,
  };
}

export function buildCompactSummary(fullFacts, outPath) {
  return {
    scan_completed: fullFacts.scan_completed,
    target_dir: fullFacts.target_dir,
    full_report_path: outPath,
    git: fullFacts.git,
    summary: fullFacts.summary,
    calibration: {
      secrets_files_scanned: fullFacts.secrets?.calibration?.files_scanned ?? null,
      tracked_files_count: fullFacts.secrets?.calibration?.tracked_files_count ?? null,
      untracked_files_count: fullFacts.secrets?.calibration?.untracked_files_count ?? null,
      safely_ignored_sensitive_files: fullFacts.secrets?.safely_ignored_sensitive_files?.length ?? 0,
      safely_ignored_privacy_files: fullFacts.paths_ports?.privacy_files?.safely_ignored_count ?? 0,
      compose_files_checked: fullFacts.paths_ports?.compose_and_env?.compose_files_checked ?? [],
      env_example_files_checked: fullFacts.paths_ports?.compose_and_env?.env_example_files_checked ?? [],
      markdown_files_checked: fullFacts.links?.calibration?.markdown_files_checked ?? null,
      local_links_checked: fullFacts.links?.calibration?.local_links_checked ?? null,
    },
    doc_drift_hints: fullFacts.paths_ports?.doc_drift_hints ?? null,
    git_identity: fullFacts.paths_ports?.git_identity ?? null,
  };
}

function printHelp() {
  console.log(`Usage: node audit_all.mjs [target_dir] [--pii <csv>] [--no-history] [--out <file>] [--help]
Runs all deterministic pre-publish audit checks in-process:
  1. Secrets (tracked / untracked via git add -n / git history), §1b PII substrings, §3 signed URLs, §10 refs/original
  2. §2 Drive & POSIX paths, §4 privacy file tracking, §5 compose ports & default passwords, §6 doc drift hints, §9 git commit identity
  3. §7 Structural Markdown local link & image validation (independent non-regex predicate)
When --out <file> is provided, writes full UTF-8 JSON to <file> and prints a compact summary to stdout.
Exit codes: 0 = full coverage scan complete, 1 = error/invalid CLI, 2 = incomplete coverage (never claim clean).`);
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
    console.log(JSON.stringify(buildCompactSummary(facts, outPath), null, 2));
  } else {
    console.log(JSON.stringify(facts, null, 2));
  }
  process.exit(exitCode);
}
