#!/usr/bin/env node
// D-group oss-eval composite entry: runs all 3 deterministic scripts in-process (zero nested node spawn).
// Enforces strict remote identity, token-origin binding, and bounded pagination:
// - Unified repo identity reconciliation (URL + local origin + --repo) upfront before clone or API calls
// - Sanitizes remote URLs (never echoes embedded credentials in normal or error reports)
// - Enforces strict --offline (never runs git clone when offline)
// - Never emits positive_signals when a sub-module failed or has skipped coverage gaps
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run as runInstall } from './audit_install.mjs';
import { run as runNetworkDeps } from './audit_network_deps.mjs';
import {
  run as runActivityClaims,
  analyzeGithubApi,
  analyzeRemoteReadme,
  inspectLocalGitIdentity,
  reconcileRepoIdentity,
  sanitizeRemoteUrl,
  parseCliArgs,
} from './audit_activity_claims.mjs';

function parseGithubUrl(input, displayInput) {
  const s = String(input || '').trim();
  if (!/^https?:\/\//i.test(s)) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;

  const defaultPort = u.protocol.toLowerCase() === 'https:' ? '443' : '80';
  if (u.port && u.port !== defaultPort) {
    return {
      ok: false,
      error: `unsupported GitHub URL port in ${displayInput}: only standard repository root URLs (https://github.com/<owner>/<repo>) are supported`,
    };
  }
  const parts = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length < 2) {
    return {
      ok: false,
      error: `incomplete GitHub URL (${displayInput}): expected repository root URL https://github.com/<owner>/<repo>`,
    };
  }
  if (parts.length > 2) {
    return {
      ok: false,
      error: `unsupported GitHub URL with subpath/ref (${displayInput}): only repository root URLs (https://github.com/<owner>/<repo>) are supported — check out the specific branch/commit locally and pass the local directory path instead`,
    };
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    return {
      ok: false,
      error: `invalid GitHub repository path in ${displayInput}`,
    };
  }
  return { ok: true, owner, repo, slug: `${owner}/${repo}`, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

function makeRefusedResult(sanitizedInput, targetDir, identity, error, exitMeaning = 'identity_mismatch_refused', scopesSkipped = []) {
  return {
    facts: {
      scan_completed: false,
      input: sanitizedInput,
      ...(targetDir ? { target_dir: targetDir } : {}),
      repo_identity: identity,
      error,
      summary: {
        exit_meaning: exitMeaning,
        red_flags: [],
        caution_flags: [],
        positive_signals: [],
        scopes_checked: [],
        scopes_skipped: scopesSkipped,
        skipped_files_count: 0,
      },
    },
    exitCode: 1,
  };
}

export async function run(options = {}) {
  const rawInput = options.target || process.cwd();
  const offline = !!options.offline;
  const displayInput = /^https?:\/\//i.test(String(rawInput).trim()) ? sanitizeRemoteUrl(rawInput) : rawInput;
  const ghParsed = parseGithubUrl(rawInput, displayInput);

  if (ghParsed && !ghParsed.ok) {
    return makeRefusedResult(
      displayInput,
      options.workdir ? path.resolve(options.workdir) : null,
      {
        requested_slug: null,
        explicit_repo_arg: null,
        local_origin_slug: null,
        local_origin_url: null,
        local_origin_kind: 'none',
        effective_api_slug: null,
        api_canonical_full_name: null,
        api_name_differs: false,
        head_commit: null,
        is_git_repo: false,
        identity_verified: false,
        identity_status: 'unsupported_url_refused',
        matched: false,
      },
      ghParsed.error,
      'unsupported_url_refused',
    );
  }
  const gh = ghParsed;

  // Early identity reconciliation BEFORE touching filesystem or network (catches URL vs --repo conflict & invalid --repo)
  const preCheck = reconcileRepoIdentity({
    urlSlug: gh ? gh.slug : null,
    explicitRepoSpec: options.repoSpec || null,
    localId: null,
    requireLocalMatchForUrl: false,
  });
  if (!preCheck.ok) {
    return makeRefusedResult(displayInput, null, preCheck.identity, preCheck.error);
  }

  if (options.apiOnly) {
    if (offline) {
      return makeRefusedResult(
        displayInput,
        null,
        preCheck.identity,
        '--api-only cannot be combined with --offline',
        'api_only_incompatible_with_offline',
      );
    }
    const slug = preCheck.identity.effective_api_slug || (gh ? gh.slug : null);
    if (!slug) {
      return makeRefusedResult(
        displayInput,
        null,
        preCheck.identity,
        '--api-only requires a GitHub repository URL or --repo owner/repo',
        'api_only_requires_github_repo',
      );
    }
    const apiIdentity = {
      ...preCheck.identity,
      effective_api_slug: slug,
      is_git_repo: false,
      identity_status: 'remote_api_only',
      identity_verified: true,
      matched: true,
    };
    const actFacts = {
      scan_completed: false,
      repo_identity: apiIdentity,
      git_activity: null,
      claims: null,
      remote_readme: null,
      github_api: null,
      scopes_checked: [],
      scopes_skipped: [],
      skipped: [],
    };
    const apiOpts = {
      apiBase: options.apiBase,
      disableGh: options.disableGh,
      customApiToken: options.customApiToken,
    };
    await analyzeGithubApi(slug, actFacts, apiOpts);
    if (!actFacts.github_api?.endpoints?.repo?.ok) {
      return makeRefusedResult(
        displayInput,
        null,
        actFacts.repo_identity,
        `GitHub API repo metadata fetch failed: ${actFacts.github_api?.endpoints?.repo?.reason || 'unknown error'}`,
        'remote_api_failed',
        actFacts.scopes_skipped,
      );
    }
    await analyzeRemoteReadme(slug, actFacts, apiOpts);
    actFacts.scan_completed = true;

    const scopesSkipped = [
      ...actFacts.scopes_skipped,
      { scope: 'git_clone', reason: '--api-only requested: skipped local git clone' },
      { scope: 'install_audit', reason: '--api-only requested: local install scripts/hooks not scanned' },
      { scope: 'network_deps_audit', reason: '--api-only requested: local source outbound/telemetry code not scanned' },
    ];
    const cautionFlags = [
      'api_only_local_source_not_scanned (install hooks and source-level network/telemetry require local clone before installing untrusted packages)',
    ];
    if (actFacts.repo_identity.api_name_differs) {
      cautionFlags.push(`repo_canonical_name_differs (requested ${actFacts.repo_identity.effective_api_slug} but GitHub API returned ${actFacts.repo_identity.api_canonical_full_name}; verify rename/transfer before merging)`);
    }
    if (actFacts.github_api.archived) cautionFlags.push('repo_archived');
    if (Number(actFacts.github_api.size_kb || 0) >= 100000) {
      cautionFlags.push(`large_repository_size_kb (${actFacts.github_api.size_kb} KB)`);
    }
    if (actFacts.github_api.watchers_ratio_calibration === 'below_baseline_0.37pct') {
      cautionFlags.push(`watchers_to_stars_below_baseline (${actFacts.github_api.watchers_to_stars_pct}%)`);
    }
    if ((actFacts.remote_readme?.unclickable_badges_count || 0) > 0) {
      cautionFlags.push(`unclickable_badges (${actFacts.remote_readme.unclickable_badges_count})`);
    }

    const facts = {
      scan_completed: true,
      mode: 'api_only',
      input: displayInput,
      target_dir: null,
      repo_identity: actFacts.repo_identity,
      summary: {
        exit_meaning: 'api_only_partial_coverage',
        red_flags: [],
        caution_flags: cautionFlags,
        positive_signals: [],
        scopes_checked: actFacts.scopes_checked,
        scopes_skipped: scopesSkipped,
        skipped_files_count: 0,
      },
      install: null,
      network_deps: null,
      activity_claims: actFacts,
      skipped: [],
    };
    return { facts, exitCode: 2 };
  }

  let targetDir = null;
  let clonedDir = null;

  if (gh) {
    const dest = options.workdir
      ? path.resolve(options.workdir)
      : path.join(os.tmpdir(), `oss-eval-${gh.owner}-${gh.repo}-${Date.now()}`);
    const hasExistingGit = fs.existsSync(dest) && fs.existsSync(path.join(dest, '.git'));
    if (hasExistingGit) {
      const existingLocalId = inspectLocalGitIdentity(dest);
      const existingRec = reconcileRepoIdentity({
        urlSlug: gh.slug,
        explicitRepoSpec: options.repoSpec || null,
        localId: existingLocalId,
        requireLocalMatchForUrl: true,
      });
      if (!existingRec.ok) {
        return makeRefusedResult(displayInput, dest, existingRec.identity, existingRec.error);
      }
      targetDir = dest;
      clonedDir = dest;
    } else if (offline) {
      // Strict offline guarantee: NEVER invoke git clone over network when --offline is requested
      return makeRefusedResult(
        displayInput,
        dest,
        {
          requested_slug: gh.slug,
          explicit_repo_arg: preCheck.identity.explicit_repo_arg,
          local_origin_slug: null,
          local_origin_url: null,
          effective_api_slug: null,
          head_commit: null,
          is_git_repo: false,
          identity_verified: false,
          identity_status: 'offline_missing_local_checkout',
          matched: false,
        },
        `offline mode: local git checkout not found at ${dest}; refusing network clone`,
        'offline_missing_local_checkout',
        [{ scope: 'git_clone', reason: 'offline mode requested and no matching local checkout exists' }],
      );
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const cl = spawnSync('git', ['clone', '--depth', '50', '--no-tags', gh.cloneUrl, dest], {
        encoding: 'utf8',
        timeout: 120000,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      });
      if (cl.error || cl.status !== 0) {
        return makeRefusedResult(
          displayInput,
          dest,
          preCheck.identity,
          `git clone failed: ${cl.error ? cl.error.message : (cl.stderr || '').trim()}`,
          'clone_failed',
        );
      }
      targetDir = dest;
      clonedDir = dest;
    }
  } else {
    targetDir = path.resolve(rawInput);
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      return makeRefusedResult(
        displayInput,
        targetDir,
        preCheck.identity,
        `target directory not found: ${targetDir}`,
        'execution_failed',
      );
    }
  }

  // Unified identity check against resolved local targetDir BEFORE running any module or API call
  const localId = inspectLocalGitIdentity(targetDir);
  const finalRec = reconcileRepoIdentity({
    urlSlug: gh ? gh.slug : null,
    explicitRepoSpec: options.repoSpec || null,
    localId,
    requireLocalMatchForUrl: !!gh,
  });
  if (!finalRec.ok) {
    return makeRefusedResult(displayInput, targetDir, finalRec.identity, finalRec.error);
  }

  const r1 = await runInstall({ target: targetDir });
  const r2 = await runNetworkDeps({ target: targetDir });
  const r3 = await runActivityClaims({
    target: targetDir,
    urlSlug: gh ? gh.slug : null,
    repoSpec: options.repoSpec || null,
    offline,
    apiBase: options.apiBase,
    disableGh: options.disableGh,
    customApiToken: options.customApiToken,
  });

  const finalIdentity = r3.facts.repo_identity
    ? { ...finalRec.identity, ...r3.facts.repo_identity }
    : finalRec.identity;

  const scopesChecked = [...new Set([
    ...(r1.facts.scopes_checked || []),
    ...(r2.facts.scopes_checked || []),
    ...(r3.facts.scopes_checked || []),
  ])];
  const scopesSkipped = [
    ...(r1.facts.scopes_skipped || []),
    ...(r2.facts.scopes_skipped || []),
    ...(r3.facts.scopes_skipped || []),
  ];
  const skipped = [
    ...(r1.facts.skipped || []).map((x) => ({ module: 'install', ...x })),
    ...(r2.facts.skipped || []).map((x) => ({ module: 'network_deps', ...x })),
    ...(r3.facts.skipped || []).map((x) => ({ module: 'activity_claims', ...x })),
  ];

  const redFlags = [];
  const cautionFlags = [];
  const positiveSignals = [];

  if (finalIdentity.identity_status === 'unverified_local_export') {
    cautionFlags.push(`repo_identity_unverified (api target ${finalIdentity.effective_api_slug} is user-declared against a local export without verifiable GitHub origin)`);
  }
  if (finalIdentity.api_name_differs) {
    cautionFlags.push(`repo_canonical_name_differs (requested ${finalIdentity.effective_api_slug} but GitHub API returned ${finalIdentity.api_canonical_full_name}; verify rename/transfer before merging)`);
  }

  // Only emit signals from modules that actually completed!
  let testInstallFindingsCount = 0;
  if (r1.facts.scan_completed) {
    const grouped = new Map();
    for (const f of r1.facts.findings || []) {
      if (f.is_test_or_fixture) {
        testInstallFindingsCount++;
        continue;
      }
      const key = `${f.severity}|${f.kind}|${f.file}`;
      if (!grouped.has(key)) grouped.set(key, { severity: f.severity, kind: f.kind, file: f.file, reason: f.reason, lines: [] });
      grouped.get(key).lines.push(f.line);
    }
    for (const g of grouped.values()) {
      const lineStr = g.lines.length <= 3 ? g.lines.join(',') : `${g.lines.slice(0, 3).join(',')} (+${g.lines.length - 3})`;
      const msg = `${g.kind} (${g.file}:${lineStr}): ${g.reason}`;
      if (g.severity === 'high') redFlags.push(msg);
      else cautionFlags.push(msg);
    }
    if ((r1.facts.package_lifecycle_scripts || []).length > 0) {
      cautionFlags.push(`package_lifecycle_scripts: ${r1.facts.package_lifecycle_scripts.map((x) => `${x.file}#${x.hook}`).join(', ')}`);
    } else if ((r1.facts.skipped || []).length === 0 && (r1.facts.scopes_skipped || []).length === 0) {
      positiveSignals.push('no_package_lifecycle_install_hooks');
    }
  }

  if (r2.facts.scan_completed) {
    const nonTestTel = (r2.facts.telemetry_signals || []).filter((x) => !x.is_test_or_doc);
    if (nonTestTel.length > 0) {
      cautionFlags.push(`telemetry_signals_in_code (${r2.facts.telemetry_signals_non_test_total} non-test / ${r2.facts.telemetry_signals_total} total hits${r2.facts.telemetry_signals_truncated ? ', truncated' : ''}; verify root & sub-package disclosure)`);
    }
    const nonTestDomains = (r2.facts.outbound_code_domains || []).filter((d) => d.non_test_hits > 0);
    if (nonTestDomains.length === 0 && (r2.facts.skipped || []).length === 0 && (r2.facts.scopes_skipped || []).length === 0) {
      positiveSignals.push('no_external_http_domains_in_non_test_code');
    } else if (nonTestDomains.length > 0) {
      cautionFlags.push(`outbound_code_domains (${r2.facts.outbound_code_domains_non_test_total} non-test / ${r2.facts.outbound_code_domains_total} total${r2.facts.outbound_code_domains_truncated ? ', truncated' : ''}): ${nonTestDomains.slice(0, 8).map((d) => d.domain).join(', ')}`);
    }
    if (
      r2.facts.dependencies?.summary?.zero_external_runtime_deps === true
      && (r2.facts.skipped || []).length === 0
      && (r2.facts.scopes_skipped || []).length === 0
    ) {
      positiveSignals.push('zero_external_runtime_dependencies');
    }
  }

  if (r3.facts.scan_completed) {
    if (r3.facts.git_activity) {
      const ga = r3.facts.git_activity;
      if (ga.bot_ratio_pct != null && ga.bot_ratio_pct >= 70) cautionFlags.push(`high_bot_commit_ratio (${ga.bot_ratio_pct}%)`);
      if (ga.latest_human_source_commit?.days_ago != null) {
        if (ga.latest_human_source_commit.days_ago >= 90) cautionFlags.push(`source_frozen_${ga.latest_human_source_commit.days_ago}d`);
        else if (ga.latest_human_source_commit.days_ago <= 30) positiveSignals.push(`recent_human_source_commit_${ga.latest_human_source_commit.days_ago}d_ago`);
      }
    }
    if ((r3.facts.claims?.unclickable_badges || []).length > 0) {
      cautionFlags.push(`unclickable_badges (${r3.facts.claims.unclickable_badges.length})`);
    }
  }

  const allCompleted = !!(r1.facts.scan_completed && r2.facts.scan_completed && r3.facts.scan_completed);
  const exitCode = !allCompleted ? 1 : (skipped.length || scopesSkipped.length) ? 2 : 0;

  const facts = {
    scan_completed: allCompleted,
    input: displayInput,
    target_dir: targetDir,
    ...(clonedDir ? { cloned_dir: clonedDir } : {}),
    repo_identity: finalIdentity,
    summary: {
      exit_meaning: exitCode === 0 ? 'all_requested_scopes_complete' : exitCode === 2 ? 'partial_coverage_report_gaps' : 'execution_failed',
      red_flags: redFlags,
      caution_flags: cautionFlags,
      test_install_findings_count: testInstallFindingsCount,
      positive_signals: positiveSignals,
      scopes_checked: scopesChecked,
      scopes_skipped: scopesSkipped,
      skipped_files_count: skipped.length,
    },
    install: r1.facts,
    network_deps: r2.facts,
    activity_claims: r3.facts,
    skipped,
  };
  return { facts, exitCode };
}

export function buildCompactSummary(facts, exitCode, fullReportPath) {
  if (!facts.scan_completed) {
    return {
      full_report_path: fullReportPath,
      exit_code: exitCode,
      scan_completed: false,
      input: facts.input,
      target_dir: facts.target_dir || null,
      repo_identity: facts.repo_identity || null,
      error: facts.error || null,
      summary: facts.summary || null,
    };
  }
  const isApiOnly = facts.mode === 'api_only' || facts.install == null;
  const inst = facts.install || {};
  const net = facts.network_deps || {};
  const act = facts.activity_claims || {};
  const nonTestTel = (net.telemetry_signals || []).filter((x) => !x.is_test_or_doc);
  const nonTestUpd = (net.update_check_signals || []).filter((x) => !x.is_test_or_doc);
  const nonTestDomains = (net.outbound_code_domains || []).filter((d) => d.non_test_hits > 0);

  const mentions = net.readme_network_mentions || [];
  const topDisclosureMentions = [
    ...mentions.filter((m) => m.scope === 'root_readme').slice(0, 6),
    ...mentions.filter((m) => m.scope === 'package_readme').slice(0, 8),
    ...mentions.filter((m) => m.scope === 'docs').slice(0, 8),
  ];

  return {
    full_report_path: fullReportPath,
    exit_code: exitCode,
    scan_completed: true,
    ...(facts.mode ? { mode: facts.mode } : {}),
    input: facts.input,
    target_dir: facts.target_dir,
    repo_identity: facts.repo_identity,
    summary: facts.summary,
    key_pointers: {
      install: isApiOnly ? null : {
        license_info: inst.license_info || [],
        package_lifecycle_scripts: inst.package_lifecycle_scripts || [],
        findings_total: (inst.findings || []).length,
        non_test_findings_total: (inst.findings || []).filter((f) => !f.is_test_or_fixture).length,
        findings: (inst.findings || []).filter((f) => !f.is_test_or_fixture).slice(0, 15),
        install_and_plugin_files: (inst.install_and_plugin_files || []).slice(0, 20),
      },
      network_deps: isApiOnly ? null : {
        telemetry_signals_total: net.telemetry_signals_total || 0,
        telemetry_signals_non_test_total: net.telemetry_signals_non_test_total || 0,
        telemetry_signals_truncated: !!net.telemetry_signals_truncated,
        non_test_telemetry_samples: nonTestTel.slice(0, 12).map((x) => ({ file: x.file, line: x.line, match: x.match, snippet: x.snippet })),
        update_check_signals_total: net.update_check_signals_total || 0,
        non_test_update_samples: nonTestUpd.slice(0, 6).map((x) => ({ file: x.file, line: x.line, match: x.match, snippet: x.snippet })),
        outbound_code_domains_total: net.outbound_code_domains_total || 0,
        outbound_code_domains_non_test_total: net.outbound_code_domains_non_test_total || 0,
        outbound_code_domains_truncated: !!net.outbound_code_domains_truncated,
        non_test_outbound_domains: nonTestDomains.slice(0, 12).map((d) => ({
          domain: d.domain,
          non_test_hits: d.non_test_hits,
          first_sample: d.samples?.[0] ? `${d.samples[0].file}:${d.samples[0].line}` : null,
        })),
        readme_disclosure: net.readme_disclosure || null,
        top_disclosure_mentions: topDisclosureMentions,
        dependencies_summary: net.dependencies?.summary || null,
        unresolved_dependency_sources: net.dependencies?.unresolved_sources || [],
      },
      activity_claims: {
        git_activity: act.git_activity ? {
          head_commit: act.git_activity.head_commit,
          is_shallow: act.git_activity.is_shallow,
          commits_sampled: act.git_activity.commits_sampled,
          human_commits: act.git_activity.human_commits,
          bot_commits: act.git_activity.bot_commits,
          bot_ratio_pct: act.git_activity.bot_ratio_pct,
          latest_human_source_commit: act.git_activity.latest_human_source_commit,
          top_authors: (act.git_activity.top_authors || []).slice(0, 5),
        } : null,
        claims: act.claims ? {
          readme_found: act.claims.readme_found,
          readme_unreadable: !!act.claims.readme_unreadable,
          workflows: act.claims.workflows || [],
          unclickable_badges_count: (act.claims.unclickable_badges || []).length,
          metric_generator_files: (act.claims.metric_generator_files || []).slice(0, 10),
        } : null,
        remote_readme: act.remote_readme || null,
        github_api: act.github_api || null,
      },
      skipped_files_total: (facts.skipped || []).length,
      skipped_files: (facts.skipped || []).slice(0, 15),
    },
  };
}

const __isCli = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (__isCli) {
  const parsed = parseCliArgs(process.argv.slice(2), {
    valueFlags: ['--workdir', '--repo', '--api-base', '--out'],
    boolFlags: ['--offline', '--api-only', '--no-clone', '--help', '-h'],
  });
  if (!parsed.ok) {
    console.log(JSON.stringify({
      scan_completed: false,
      error: `invalid arguments: ${parsed.error}`,
      summary: {
        exit_meaning: 'invalid_cli_arguments',
        red_flags: [],
        caution_flags: [],
        positive_signals: [],
        scopes_checked: [],
        scopes_skipped: [],
        skipped_files_count: 0,
      },
    }, null, 2));
    process.exit(1);
  }
  if (parsed.flags['--help'] || parsed.flags['-h']) {
    console.log([
      'Usage: node scripts/eval_all.mjs <dir_or_github_root_url> [options]',
      '',
      'Options:',
      '  --workdir <dir>     Existing checkout or destination directory for GitHub URL',
      '  --repo <owner/repo> Explicit GitHub repository (refused if conflicting with local origin/URL)',
      '  --api-base <url>    Custom GitHub REST API base URL (anonymous by default)',
      '  --offline           Skip GitHub API and refuse network git clone',
      '  --api-only          Fetch GitHub API metadata, releases, issues & README without cloning',
      '  --no-clone          Alias for --api-only (lightweight remote triage for large repos)',
      '  --out <file>        Write complete UTF-8 JSON report to <file> and print compact summary to stdout',
      '  -h, --help          Show this help message',
    ].join('\n'));
    process.exit(0);
  }
  const target = parsed.target || process.cwd();
  const workdir = parsed.values['--workdir'] || null;
  const repoSpec = parsed.values['--repo'] || null;
  const apiBase = parsed.values['--api-base'] || null;
  const outPath = parsed.values['--out'] || null;
  const offline = !!parsed.flags['--offline'];
  const apiOnly = !!(parsed.flags['--api-only'] || parsed.flags['--no-clone']);

  const { facts, exitCode } = await run({ target, workdir, repoSpec, apiBase, offline, apiOnly });
  if (outPath && exitCode !== 1 && facts.scan_completed) {
    const resolvedOut = path.resolve(outPath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, JSON.stringify(facts, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify(buildCompactSummary(facts, exitCode, resolvedOut), null, 2));
  } else {
    console.log(JSON.stringify(facts, null, 2));
  }
  process.exit(exitCode);
}
