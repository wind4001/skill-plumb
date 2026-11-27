#!/usr/bin/env node
/**
 * D-group deterministic `.env` vs `.env.example` drift & placeholder auditor (`probe_env_diff_audit.mjs`).
 * Zero third-party dependencies; built-in Node modules only.
 *
 * Enforces:
 *   - Strict CLI validation (`<project_dir> [--out <report.json>]`, `--help`)
 *   - `realpath` containment against symlink escapes
 *   - Zero plaintext secret echo in stdout, stderr, or `--out` JSON
 *   - Deterministic 0 / 1 / 2 exit codes
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function isWithinRoot(rootReal, targetReal) {
  const rel = path.relative(rootReal, targetReal);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function parseQuotedValue(rawAfterEq, quoteChar) {
  let out = '';
  let i = 1;
  while (i < rawAfterEq.length) {
    const ch = rawAfterEq[i];
    if (quoteChar === '"' && ch === '\\' && i + 1 < rawAfterEq.length) {
      const next = rawAfterEq[i + 1];
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else out += next;
      i += 2;
      continue;
    }
    if (ch === quoteChar) {
      return out;
    }
    out += ch;
    i++;
  }
  return rawAfterEq.slice(1).trim();
}

function parseValue(rawRightSide) {
  const trimmedStart = rawRightSide.trimStart();
  if (!trimmedStart) return '';
  const first = trimmedStart[0];
  if (first === '"' || first === "'" || first === '`') {
    return parseQuotedValue(trimmedStart, first);
  }
  if (trimmedStart.startsWith('#')) return '';
  const commentMatch = trimmedStart.match(/\s+#/);
  const withoutComment = commentMatch ? trimmedStart.slice(0, commentMatch.index) : trimmedStart;
  return withoutComment.trim();
}

export function parseEnvContent(content) {
  const clean = String(content || '').replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/);
  const entries = new Map();

  for (let idx = 0; idx < lines.length; idx++) {
    const trimmed = lines[idx].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const body = trimmed.replace(/^export\s+/, '');
    const eqIdx = body.indexOf('=');
    if (eqIdx <= 0) continue;

    const key = body.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue;

    const value = parseValue(body.slice(eqIdx + 1));
    entries.set(key, { key, value, line: idx + 1 });
  }
  return entries;
}

function classifyDirectPlaceholder(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed === '') return 'empty_value';
  if (/change[-_ ]?(?:me|this)/i.test(trimmed)) return 'placeholder_change_me';
  if (/replace[-_ ]?(?:me|this|with)/i.test(trimmed)) return 'placeholder_replace_me';
  if (/(?:^|[^a-z0-9])your[_-][^\s"'`]+/i.test(trimmed) || /^your\s+(?:api[_-]?key|secret|token|password|key|value)\b/i.test(trimmed)) {
    return 'placeholder_your_prefix';
  }
  if (
    /^<[^<>\s][^<>]*>$/.test(trimmed) ||
    /<(?:your[_-]|change|replace|todo|placeholder|example|user|pass|password|secret|token|key|host|port|db|dbname|\.\.\.|[A-Z][A-Z0-9_]{1,})[^>]*>/.test(trimmed)
  ) {
    return 'placeholder_angle_brackets';
  }
  if (/^(?:todo|fixme|tbd)(?:$|[\s:_-].*)/i.test(trimmed) || /\b(?:TODO|FIXME)\b/.test(trimmed)) {
    return 'placeholder_todo';
  }
  if (/(?:^|[-_:/\s])x{3,}(?:$|[-_:/\s])/i.test(trimmed)) return 'placeholder_xxx';
  if (/\bplaceholder\b|placeholder[_-]|[_-]placeholder/i.test(trimmed)) return 'placeholder_keyword';
  if (/^\*{3,}$/.test(trimmed) || /^\.{3,}$/.test(trimmed)) return 'placeholder_template_marker';
  if (
    /^(?:fill[_-]?me|insert[_-]?here|paste[_-]?here)$/i.test(trimmed) ||
    /(?:paste|insert|enter|put|fill)[_-](?:your[_-])?(?:key|token|secret|password|value|.*)[_-]here/i.test(trimmed)
  ) {
    return 'placeholder_template_marker';
  }
  return null;
}

function isExampleTemplateValue(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return false;
  if (classifyDirectPlaceholder(trimmed) !== null) return true;
  if (/\b(?:example|sample|dummy|template|changethis|fillme|unset)\b/i.test(trimmed)) return true;
  if (/(?:^|[_-])(?:example|sample|dummy|template|changethis|fillme|default[-_]?secret|dev[-_]?secret|test[-_]?secret)(?:$|[_-])/i.test(trimmed)) {
    return true;
  }
  if (/example\.(?:com|org|net)\b/i.test(trimmed)) return true;
  if (/^(?:secret|password|passwd|token|apikey|api[-_]?key|none|null|n\/a|123456|12345678|000000|abcdef)$/i.test(trimmed)) {
    return true;
  }
  return false;
}

function parseArgs(argv) {
  const opts = { projectDir: '', out: null, help: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--out') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        return { ok: false, error: 'Missing file path value for --out' };
      }
      opts.out = argv[++i];
    } else if (a.startsWith('--out=')) {
      const val = a.slice('--out='.length);
      if (!val) return { ok: false, error: 'Missing file path value for --out=' };
      opts.out = val;
    } else if (a.startsWith('-')) {
      return { ok: false, error: `Unknown flag: ${a}` };
    } else {
      pos.push(a);
    }
  }
  if (opts.help) return { ok: true, opts };
  if (pos.length === 0) return { ok: false, error: 'Missing required argument: <project_dir>' };
  if (pos.length > 1) return { ok: false, error: `Unexpected extra positional arguments: ${pos.slice(1).join(' ')}` };
  opts.projectDir = pos[0];
  return { ok: true, opts };
}

function printHelp() {
  console.log(`Usage:
  node probe_env_diff_audit.mjs <project_dir> [--out <report.json>]

Compares <project_dir>/.env.example and <project_dir>/.env for missing keys,
extra keys, empty values, and placeholder values without echoing raw secrets.

Options:
  --out <report.json>   Write structured JSON audit report to file
  -h, --help            Show this help message and exit 0

Exit codes:
  0 = clean (.env matches .env.example with no empty or placeholder values)
  1 = CLI/usage error, missing/non-directory target, missing .env.example/.env, or symlink escape
  2 = drift or empty/placeholder findings detected`);
}

function resolveContainedFile(rootReal, filename) {
  const target = path.join(rootReal, filename);
  let lst;
  try {
    lst = fs.lstatSync(target);
  } catch {
    return { ok: false, error: `Missing required file ${filename} in ${rootReal}` };
  }
  let fileReal;
  try {
    fileReal = fs.realpathSync(target);
  } catch (err) {
    const kind = lst.isSymbolicLink() ? 'Broken symlink' : 'Unreadable file';
    return { ok: false, error: `${kind} for ${filename}: ${err.message}` };
  }
  if (!isWithinRoot(rootReal, fileReal)) {
    return { ok: false, error: `Symlink escape rejected for ${filename}: points outside ${rootReal}` };
  }
  const st = fs.statSync(fileReal);
  if (!st.isFile()) {
    return { ok: false, error: `Expected regular file for ${filename}, found non-file` };
  }
  return { ok: true, fileReal };
}

export function runAudit(rawProjectDir) {
  if (!rawProjectDir || !String(rawProjectDir).trim()) {
    return { exitCode: 1, error: 'Missing required argument: <project_dir>' };
  }
  const absDir = path.resolve(rawProjectDir);
  if (!fs.existsSync(absDir)) {
    return { exitCode: 1, error: `Project directory does not exist: ${rawProjectDir}` };
  }
  let rootReal;
  try {
    rootReal = fs.realpathSync(absDir);
  } catch (err) {
    return { exitCode: 1, error: `Cannot resolve project directory: ${err.message}` };
  }
  if (!fs.statSync(rootReal).isDirectory()) {
    return { exitCode: 1, error: `Target path is not a directory: ${rawProjectDir}` };
  }

  const exampleFile = resolveContainedFile(rootReal, '.env.example');
  if (!exampleFile.ok) return { exitCode: 1, error: exampleFile.error };
  const envFile = resolveContainedFile(rootReal, '.env');
  if (!envFile.ok) return { exitCode: 1, error: envFile.error };

  const exampleMap = parseEnvContent(fs.readFileSync(exampleFile.fileReal, 'utf8'));
  const envMap = parseEnvContent(fs.readFileSync(envFile.fileReal, 'utf8'));

  const missingKeys = [];
  const extraKeys = [];
  const placeholderOrEmpty = [];
  const findings = [];

  for (const [key, exEntry] of exampleMap.entries()) {
    if (!envMap.has(key)) {
      missingKeys.push({ key, example_line: exEntry.line });
      findings.push({
        type: 'missing_key',
        severity: 'HIGH',
        key,
        line: exEntry.line,
        reason: 'missing_in_env',
        redacted: true,
        message: `Key ${key} defined in .env.example (line ${exEntry.line}) is missing in .env`,
      });
    }
  }

  for (const [key, envEntry] of envMap.entries()) {
    if (!exampleMap.has(key)) {
      extraKeys.push({ key, env_line: envEntry.line });
      findings.push({
        type: 'extra_key',
        severity: 'MEDIUM',
        key,
        line: envEntry.line,
        reason: 'extra_in_env',
        redacted: true,
        message: `Key ${key} in .env (line ${envEntry.line}) is not declared in .env.example`,
      });
    }

    const exEntry = exampleMap.get(key);
    const identicalToExample = Boolean(exEntry && exEntry.value !== '' && envEntry.value === exEntry.value);
    let reason = classifyDirectPlaceholder(envEntry.value);
    if (!reason && identicalToExample && isExampleTemplateValue(exEntry.value)) {
      reason = 'identical_to_example_placeholder';
    }

    if (reason) {
      const isEmpty = reason === 'empty_value';
      placeholderOrEmpty.push({
        key,
        env_line: envEntry.line,
        reason,
        identical_to_example: identicalToExample,
        redacted_preview: isEmpty ? '<empty>' : '[REDACTED]',
        redacted: true,
      });
      findings.push({
        type: isEmpty ? 'empty_value' : 'placeholder_value',
        severity: 'HIGH',
        key,
        line: envEntry.line,
        reason,
        identical_to_example: identicalToExample,
        redacted: true,
        message: isEmpty
          ? `Key ${key} in .env (line ${envEntry.line}) has an empty value`
          : `Key ${key} in .env (line ${envEntry.line}) appears to hold a placeholder (${reason}; value [REDACTED])`,
      });
    }
  }

  const exitCode = findings.length > 0 ? 2 : 0;
  return {
    exitCode,
    result: {
      scan_completed: true,
      exit_code: exitCode,
      exit_meaning: exitCode === 0 ? 'env_clean' : 'env_drift_or_placeholders',
      status: exitCode === 0 ? 'clean' : 'findings_detected',
      project_dir: rootReal,
      files: {
        env_example: '.env.example',
        env: '.env',
      },
      counts: {
        example_keys: exampleMap.size,
        env_keys: envMap.size,
        missing_keys: missingKeys.length,
        extra_keys: extraKeys.length,
        empty_or_placeholder_keys: placeholderOrEmpty.length,
        total_findings: findings.length,
      },
      missing_keys: missingKeys,
      extra_keys: extraKeys,
      placeholder_or_empty: placeholderOrEmpty,
      findings,
    },
  };
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(
      JSON.stringify({ scan_completed: false, exit_code: 1, exit_meaning: 'error', error: parsed.error }, null, 2) + '\n'
    );
    process.exit(1);
  }
  if (parsed.opts.help) {
    printHelp();
    process.exit(0);
  }

  const outcome = runAudit(parsed.opts.projectDir);
  if (outcome.exitCode === 1) {
    process.stderr.write(
      JSON.stringify({ scan_completed: false, exit_code: 1, exit_meaning: 'error', error: outcome.error }, null, 2) + '\n'
    );
    process.exit(1);
  }

  const serialized = JSON.stringify(outcome.result, null, 2) + '\n';
  if (parsed.opts.out) {
    try {
      const outAbs = path.resolve(parsed.opts.out);
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      fs.writeFileSync(outAbs, serialized, 'utf8');
    } catch (err) {
      process.stderr.write(
        JSON.stringify({
          scan_completed: false,
          exit_code: 1,
          exit_meaning: 'error',
          error: `Failed to write --out report: ${err.message}`,
        }, null, 2) + '\n'
      );
      process.exit(1);
    }
  }
  process.stdout.write(serialized);
  process.exit(outcome.exitCode);
}
