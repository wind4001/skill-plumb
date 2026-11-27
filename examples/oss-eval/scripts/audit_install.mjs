#!/usr/bin/env node
// D-group oss-eval: Install scripts, plugin/hook manifests, host config tampering, and license check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from './audit_activity_claims.mjs';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);
const INSTALL_FILE_RE = /(?:^|\/)(?:preinstall|postinstall|install|uninstall|setup)\.(?:sh|bash|zsh|js|mjs|cjs|ts|py|ps1|bat|cmd)$|(?:^|\/)(?:\.(?:claude|codex|antigravity)-plugin\/.*|plugin\.json|hooks\.json|mcp_config\.json|\.mcp\.json)$/i;
const LIFECYCLE_KEYS = new Set(['preinstall', 'install', 'postinstall', 'prepare', 'preuninstall', 'uninstall', 'postuninstall']);

const HOST_TAMPER_RULES = [
  { kind: 'host_settings_write', re: /(?:~|HOME|USERPROFILE|\.claude|\.codex|\.gemini)[^\n]{0,80}(?:settings\.json|installed_plugins\.json|mcp_config\.json|hooks\.json)/i, reason: '引用宿主配置/插件状态文件（需核实是否写入或修改）' },
  { kind: 'plugin_enable_tamper', re: /\b(?:enabledPlugins|installed_plugins\.json)\b/i, reason: '涉及插件启用表（曾出现项目级安装改全局或卸载复活问题）' },
  { kind: 'symlink_or_shim', re: /\b(?:symlinkSync|fs\.symlink|mklink|New-Item\s+.*SymbolicLink|Junction)\b|npm[\w-]*shim/i, reason: '创建符号链接/junction 或涉及 npm shim' },
  { kind: 'persistence_mechanism', re: /\b(?:crontab|schtasks|LaunchAgents|systemd|\.bashrc|\.zshrc|Microsoft\.PowerShell_profile)\b/i, reason: '涉及系统持久化/启动项或 shell profile' },
  { kind: 'curl_pipe_shell', re: /(?:curl|wget)[^\n|]{1,160}\|\s*(?:sh|bash|zsh|pwsh|powershell)/i, reason: '下载远程脚本并直接管道执行（高风险安装模式）' },
];

const NON_OSI_LICENSES = [
  { tag: 'SSPL', re: /\bSSPL\b|Server Side Public License/i, note: '非 OSI 开源许可（需按具体条款与拟议商用/托管用途核对）' },
  { tag: 'ELv2', re: /\bELv2\b|Elastic License/i, note: '非 OSI 开源许可（需按具体条款与拟议商用/托管用途核对）' },
  { tag: 'BSL/BUSL', re: /\bBUSL\b|Business Source License/i, note: '非 OSI 源码可用许可（需按附加生产限制条款核对）' },
  { tag: 'Commons-Clause', re: /Commons Clause/i, note: '含 Commons Clause 条款（需核对商用销售限制）' },
  { tag: 'PolyForm', re: /PolyForm/i, note: '非 OSI 源码可用许可（需核对具体 PolyForm 变体条款）' },
  { tag: 'FSL', re: /Functional Source License/i, note: '非 OSI 源码可用许可（需核对竞品使用条款）' },
];
const COPYLEFT_RE = /\bAGPL(?:-?3\.0)?\b|Affero General Public License/i;

function walk(dir, rootDir, out, skippedDirs, skipped) {
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
      if (EXCLUDED_DIRS.has(e.name)) {
        skippedDirs.push(rel);
        continue;
      }
      walk(abs, rootDir, out, skippedDirs, skipped);
    } else if (e.isFile()) {
      out.push({ abs, rel });
    }
  }
}

function readUtf8Safe(abs, maxBytes = 512 * 1024) {
  let st;
  try { st = fs.statSync(abs); } catch (e) { return { ok: false, reason: `STAT_ERROR: ${e.code || e.message}` }; }
  if (st.size > maxBytes) return { ok: false, reason: `OVERSIZED_${st.size}B` };
  let buf;
  try { buf = fs.readFileSync(abs); } catch (e) { return { ok: false, reason: `READ_ERROR: ${e.code || e.message}` }; }
  if (buf.includes(0)) return { ok: false, reason: 'BINARY' };
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
  } catch {
    return { ok: false, reason: 'NOT_UTF8' };
  }
}

function sanitizeSnippet(line) {
  return String(line)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(?<![A-Za-z0-9])(AKIA|AKID)[A-Za-z0-9]{8,}/g, '$1***')
    .trim()
    .slice(0, 140);
}

function detectLicenseText(text) {
  for (const rule of NON_OSI_LICENSES) {
    if (rule.re.test(text)) return { spdx_guess: rule.tag, osi_compliant: false, note: rule.note };
  }
  if (COPYLEFT_RE.test(text)) return { spdx_guess: 'AGPL', osi_compliant: true, copyleft_strong: true, note: '强传染开源许可（网络服务部署需核对公开源码义务）' };
  if (/MIT License|Permission is hereby granted, free of charge/i.test(text)) return { spdx_guess: 'MIT', osi_compliant: true };
  if (/Apache License[\s\S]{0,40}Version 2\.0/i.test(text)) return { spdx_guess: 'Apache-2.0', osi_compliant: true };
  if (/Creative Commons Attribution 4\.0|CC-BY-4\.0/i.test(text)) return { spdx_guess: 'CC-BY-4.0', osi_compliant: true, note: '内容/数据署名许可' };
  if (/GNU GENERAL PUBLIC LICENSE/i.test(text)) return { spdx_guess: 'GPL', osi_compliant: true, copyleft_strong: true };
  if (/BSD 3-Clause|BSD 2-Clause|ISC License/i.test(text)) return { spdx_guess: 'BSD/ISC', osi_compliant: true };
  return { spdx_guess: 'UNKNOWN', osi_compliant: null, note: '未识别出常见许可模板，请人工阅读 LICENSE 文件' };
}

export async function run(options = {}) {
  const target = path.resolve(options.target || process.cwd());
  const facts = {
    scan_completed: false,
    target: path.basename(target),
    total_files_seen: 0,
    excluded_dirs: [],
    install_and_plugin_files: [],
    package_lifecycle_scripts: [],
    license_info: [],
    findings: [],
    needs_review: [],
    skipped: [],
    scopes_checked: [],
    scopes_skipped: [],
  };

  try {
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return { facts: { ...facts, error: `target directory not found: ${target}` }, exitCode: 1 };
    }
    const files = [];
    walk(target, target, files, facts.excluded_dirs, facts.skipped);
    facts.total_files_seen = files.length;

    const candidateFilesForTamper = new Set();

    for (const { abs, rel } of files) {
      const base = path.basename(rel);
      if (INSTALL_FILE_RE.test(rel)) {
        facts.install_and_plugin_files.push(rel);
        candidateFilesForTamper.add(rel);
      }

      if (base === 'package.json') {
        const rd = readUtf8Safe(abs);
        if (!rd.ok) {
          facts.skipped.push({ file: rel, reason: rd.reason });
          continue;
        }
        try {
          const pkg = JSON.parse(rd.text);
          if (pkg.license) {
            const licStr = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license);
            const nonOsi = NON_OSI_LICENSES.find((r) => r.re.test(licStr));
            const entry = {
              source: rel,
              declared: licStr,
              osi_compliant: nonOsi ? false : (COPYLEFT_RE.test(licStr) ? true : null),
              ...(nonOsi ? { note: nonOsi.note } : {}),
            };
            facts.license_info.push(entry);
            if (nonOsi) {
              facts.findings.push({
                severity: 'high', kind: 'non_osi_license', file: rel, line: 0,
                snippet: `license: ${licStr}`, reason: nonOsi.note,
              });
            }
          }
          if (pkg.scripts && typeof pkg.scripts === 'object') {
            for (const [k, v] of Object.entries(pkg.scripts)) {
              if (!LIFECYCLE_KEYS.has(k)) continue;
              const cmd = String(v);
              facts.package_lifecycle_scripts.push({ file: rel, hook: k, command: sanitizeSnippet(cmd) });
              facts.needs_review.push({
                kind: 'package_lifecycle_hook', file: rel, hook: k,
                snippet: sanitizeSnippet(cmd),
                reason: `package.json 声明了生命周期脚本 ${k}，npm install 时可能自动执行`,
              });
              for (const rule of HOST_TAMPER_RULES) {
                if (rule.re.test(cmd)) {
                  facts.findings.push({
                    severity: 'high', kind: rule.kind, file: rel, line: 0,
                    snippet: `${k}: ${sanitizeSnippet(cmd)}`, reason: rule.reason,
                  });
                }
              }
            }
          }
        } catch (e) {
          facts.skipped.push({ file: rel, reason: `JSON_PARSE_ERROR: ${e.message}` });
        }
      }

      if (/^(?:LICENSE|LICENCE|COPYING)(?:\.[A-Za-z0-9]+)?$/i.test(base) && !rel.includes('/')) {
        const rd = readUtf8Safe(abs);
        if (rd.ok) {
          const det = detectLicenseText(rd.text);
          facts.license_info.push({ source: rel, ...det });
          if (det.osi_compliant === false) {
            facts.findings.push({
              severity: 'high', kind: 'non_osi_license', file: rel, line: 1,
              snippet: det.spdx_guess, reason: det.note,
            });
          }
        } else {
          facts.skipped.push({ file: rel, reason: rd.reason });
        }
      }

      if (/\.(?:sh|bash|zsh|ps1|bat|cmd|js|mjs|cjs|ts|py|json)$/i.test(base) && (candidateFilesForTamper.has(rel) || /(?:install|setup|hook|plugin|cli|init|config)/i.test(rel))) {
        const rd = readUtf8Safe(abs);
        if (!rd.ok) {
          if (rd.reason !== 'BINARY') facts.skipped.push({ file: rel, reason: rd.reason });
          continue;
        }
        const isTestOrFixture = /(?:^|\/)(?:test|tests|__tests__|spec|examples?|fixtures?)\//i.test(rel) || /\.(?:test|spec)\./i.test(base);
        const lines = rd.text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          for (const rule of HOST_TAMPER_RULES) {
            if (rule.re.test(line)) {
              facts.findings.push({
                severity: rule.kind === 'curl_pipe_shell' || rule.kind === 'plugin_enable_tamper' ? 'high' : 'medium',
                kind: rule.kind,
                file: rel,
                line: i + 1,
                is_test_or_fixture: isTestOrFixture,
                snippet: sanitizeSnippet(line),
                reason: rule.reason,
              });
            }
          }
        }
      }
    }

    if (facts.license_info.length === 0) {
      facts.needs_review.push({
        kind: 'missing_license', file: '.', reason: '根目录未找到 LICENSE 文件且 package.json 未声明 license（需核对许可条款）',
      });
    }

    facts.scopes_checked = ['install_files', 'package_scripts', 'license'];
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
    console.log('Usage: node scripts/audit_install.mjs [dir] [--out <file>]');
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
