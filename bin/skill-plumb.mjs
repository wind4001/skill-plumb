#!/usr/bin/env node
/**
 * Unified CLI entrypoint for `skill-plumb`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatDoctorReport,
  runBrief,
  runDoctor,
  runGate,
  runInitPlugin,
  runInspect,
  runList,
  runScaffold,
  syncLiveCatalog,
} from '../src/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(HERE, '..', 'package.json');

function getVersion() {
  try {
    return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version || '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function printMainHelp() {
  console.log(`skill-plumb v${getVersion()} — Thin behavioral contracts, 0/1/2 probes, black-box gating & two-stage routing.

Usage:
  skill-plumb <command> [options]

Commands:
  doctor                  Read-only ecosystem audit (thinness, crowded Not-for, broken links, overrides)
  scaffold                Generate a D-Full, D-Lite, or Ops-Only skill skeleton from templates
  gate <skill_dir>        Run 6 acceptance gates (frontmatter, thinness, links, probes/verify, routing)
  inspect "<query>"       Run two-stage O(domain) routing with direct-action guard
  brief                   Show active domains and skill counts (auto-syncs via source fingerprint)
  list <domain>           List skills & MCPs inside a domain
  sync                    Force-rebuild catalog cache and report missing Not-for boundaries
  init-plugin             Generate a portable routing-rule plugin or AGENTS.md snippet

Global / Common Options:
  --skills-dir <dir>      Skill directory to scan (repeatable; disables default host probing)
  --mcp-cfg <file>        Explicit MCP config JSON path
  --no-mcp                Disable MCP config scanning
  --overrides <file>      Explicit router_overrides.json path
  --domains <file>        Explicit domains.json / .skill-plumb.json path
  --catalog <file>        Catalog cache file path (sync/brief/list/inspect/gate)
  --out <file>            Write command JSON output to <file> (or output dir for scaffold/init-plugin)
  -h, --help              Show help
  -v, --version           Show version`);
}

function printSubHelp(cmd) {
  const helps = {
    doctor: `Usage: skill-plumb doctor [--skills-dir <dir>]... [--mcp-cfg <file> | --no-mcp] [--overrides <file>] [--domains <file>] [--max-lines 150] [--max-bytes 9000] [--json] [--out <file>]`,
    scaffold: `Usage: skill-plumb scaffold --name <slug> --domain <domain> --summary "<desc>" [--mode full|lite|ops] [--out-dir <dir>] [--out <file>] [--skills-dir <dir>]... [--use-when "<trigger>"] [--not-for "<exclusions>"] [--dry-run] [--force]`,
    gate: `Usage: skill-plumb gate <skill_dir> [--mode auto|full|lite] [--max-lines 150] [--max-bytes 9000] [--skills-dir <dir>]... [--overrides <file>] [--domains <file>] [--catalog <file>] [--check-mirror <dir>] [--no-mcp] [--skip-routing] [--skip-verify] [--no-sync] [--out <file>]`,
    sync: `Usage: skill-plumb sync [--skills-dir <dir>]... [--mcp-cfg <file> | --no-mcp] [--overrides <file>] [--domains <file>] [--catalog <file>] [--out <file>]`,
    brief: `Usage: skill-plumb brief [--skills-dir <dir>]... [--mcp-cfg <file> | --no-mcp] [--overrides <file>] [--domains <file>] [--catalog <file>] [--out <file>]`,
    list: `Usage: skill-plumb list <domain> [--skills-dir <dir>]... [--mcp-cfg <file> | --no-mcp] [--overrides <file>] [--domains <file>] [--catalog <file>] [--out <file>]`,
    inspect: `Usage: skill-plumb inspect "<query>" [--domain <d>] [--limit 5] [--skills-dir <dir>]... [--mcp-cfg <file> | --no-mcp] [--overrides <file>] [--domains <file>] [--catalog <file>] [--out <file>]`,
    'init-plugin': `Usage: skill-plumb init-plugin [--out-dir <dir_or_file>] [--out <file>] [--format plugin|agents-md] [--force] [--dry-run]`,
  };
  console.log(helps[cmd] || helps.doctor);
}

const VALUE_FLAGS = new Set([
  '--skills-dir', '--mcp-cfg', '--overrides', '--domains', '--catalog', '--out', '--out-dir',
  '--name', '--domain', '--summary', '--use-when', '--not-for', '--mode',
  '--max-lines', '--max-bytes', '--limit', '--format', '--check-mirror',
]);

function assignValueFlag(opts, flag, val) {
  if (flag === '--skills-dir') opts.skillsDirs.push(val);
  else if (flag === '--mcp-cfg') opts.mcpCfgPath = val;
  else if (flag === '--overrides') opts.overridesPath = val;
  else if (flag === '--domains') opts.domainsPath = val;
  else if (flag === '--catalog') opts.catalogPath = val;
  else if (flag === '--out') opts.out = val;
  else if (flag === '--out-dir') opts.outDir = val;
  else if (flag === '--name') opts.name = val;
  else if (flag === '--domain') opts.domain = val;
  else if (flag === '--summary') opts.summary = val;
  else if (flag === '--use-when') opts.useWhen = val;
  else if (flag === '--not-for') opts.notFor = val;
  else if (flag === '--mode') opts.mode = val;
  else if (flag === '--max-lines') opts.maxLines = Number(val);
  else if (flag === '--max-bytes') opts.maxBytes = Number(val);
  else if (flag === '--limit') opts.limit = Number(val);
  else if (flag === '--format') opts.format = val;
  else if (flag === '--check-mirror') opts.checkMirror = val;
}

function parseSubArgs(argv) {
  const opts = {
    skillsDirs: [],
    pos: [],
    help: false,
    json: false,
    noMcp: false,
    dryRun: false,
    force: false,
    skipRouting: false,
    skipVerify: false,
    noSync: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--no-mcp') {
      opts.noMcp = true;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--force') {
      opts.force = true;
    } else if (a === '--skip-routing') {
      opts.skipRouting = true;
    } else if (a === '--skip-verify') {
      opts.skipVerify = true;
    } else if (a === '--no-sync') {
      opts.noSync = true;
    } else if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= argv.length || !argv[i + 1].trim() || argv[i + 1].startsWith('-')) {
        return { ok: false, error: `Missing value for ${a}` };
      }
      assignValueFlag(opts, a, argv[++i]);
    } else if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      const flag = a.slice(0, eq);
      const val = a.slice(eq + 1);
      if (!VALUE_FLAGS.has(flag)) {
        return { ok: false, error: `Unknown flag: ${flag}` };
      }
      if (!val.trim()) {
        return { ok: false, error: `Missing value for ${flag}` };
      }
      assignValueFlag(opts, flag, val);
    } else if (a.startsWith('-')) {
      return { ok: false, error: `Unknown flag: ${a}` };
    } else {
      opts.pos.push(a);
    }
  }
  return { ok: true, opts };
}

function isPositiveIntOption(val) {
  return val === undefined || (Number.isInteger(val) && val > 0);
}

function writeOutFile(outPath, content) {
  const abs = path.resolve(outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function emitJsonAndExit(code, payload, outPath = null) {
  const serialized = JSON.stringify(payload, null, 2) + '\n';
  if (outPath && code !== 1) {
    try {
      writeOutFile(outPath, serialized);
    } catch (err) {
      process.stderr.write(JSON.stringify({ exit_code: 1, error: `Failed to write --out "${outPath}": ${err.message}` }, null, 2) + '\n');
      process.exit(1);
    }
  }
  if (code === 1) process.stderr.write(serialized);
  else process.stdout.write(serialized);
  process.exit(code);
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  printMainHelp();
  process.exit(0);
}
if (cmd === '--version' || cmd === '-v') {
  console.log(getVersion());
  process.exit(0);
}

const KNOWN_COMMANDS = new Set([
  'doctor', 'scaffold', 'gate', 'sync', 'brief', 'list', 'inspect', 'init-plugin',
]);
if (!KNOWN_COMMANDS.has(cmd)) {
  emitJsonAndExit(1, {
    exit_code: 1,
    error: `Unknown command "${cmd}". Run "skill-plumb --help" for valid commands.`,
  });
}

const parsed = parseSubArgs(argv.slice(1));
if (!parsed.ok) {
  emitJsonAndExit(1, { exit_code: 1, error: parsed.error });
}
const opts = parsed.opts;
if (opts.help) {
  printSubHelp(cmd);
  process.exit(0);
}

if (cmd === 'doctor') {
  if (opts.pos.length > 0) {
    emitJsonAndExit(1, { scan_completed: false, exit_code: 1, error: `Unexpected positional arguments: ${opts.pos.join(' ')}` });
  }
  if (!isPositiveIntOption(opts.maxLines) || !isPositiveIntOption(opts.maxBytes)) {
    emitJsonAndExit(1, { scan_completed: false, exit_code: 1, error: '--max-lines and --max-bytes must be positive integers' });
  }
  const out = runDoctor(opts);
  if (out.exitCode === 1) emitJsonAndExit(1, { scan_completed: false, exit_code: 1, error: out.error });
  const serialized = JSON.stringify(out.result, null, 2) + '\n';
  if (opts.out) {
    try {
      writeOutFile(opts.out, serialized);
    } catch (err) {
      emitJsonAndExit(1, { scan_completed: false, exit_code: 1, error: `Failed to write --out "${opts.out}": ${err.message}` });
    }
  }
  if (opts.json) process.stdout.write(serialized);
  else process.stdout.write(formatDoctorReport(out.result));
  process.exit(out.exitCode);
} else if (cmd === 'scaffold') {
  if (opts.pos.length > 0) {
    emitJsonAndExit(1, { scaffolded: false, exit_code: 1, error: `Unexpected positional arguments: ${opts.pos.join(' ')}` });
  }
  try {
    const out = runScaffold({ ...opts, outDir: opts.outDir || opts.out });
    if (out.exitCode === 1 && !out.result) {
      emitJsonAndExit(1, { scaffolded: false, exit_code: 1, error: out.error });
    }
    emitJsonAndExit(out.exitCode, out.result, opts.outDir ? opts.out : null);
  } catch (err) {
    emitJsonAndExit(1, { scaffolded: false, exit_code: 1, error: err.message });
  }
} else if (cmd === 'gate') {
  if (opts.pos.length !== 1) {
    emitJsonAndExit(1, { gate_passed: false, exit_code: 1, error: 'Provide exactly one <skill_dir> path' });
  }
  if (!isPositiveIntOption(opts.maxLines) || !isPositiveIntOption(opts.maxBytes)) {
    emitJsonAndExit(1, { gate_passed: false, exit_code: 1, error: '--max-lines and --max-bytes must be positive integers' });
  }
  try {
    const out = runGate({ ...opts, skillDir: opts.pos[0], outFile: opts.catalogPath });
    if (out.exitCode === 1 && !out.result) {
      emitJsonAndExit(1, { gate_passed: false, exit_code: 1, error: out.error });
    }
    emitJsonAndExit(out.exitCode, out.result, opts.out);
  } catch (err) {
    emitJsonAndExit(1, { gate_passed: false, exit_code: 1, error: err.message });
  }
} else if (cmd === 'sync') {
  if (opts.pos.length > 0) {
    emitJsonAndExit(1, { synced: false, exit_code: 1, error: `Unexpected positional arguments: ${opts.pos.join(' ')}` });
  }
  try {
    const { summary } = syncLiveCatalog({ ...opts, outFile: opts.catalogPath });
    const hasWarnings = (summary.override_warnings && summary.override_warnings.length > 0);
    emitJsonAndExit(summary.missing_not_for_count > 0 || hasWarnings ? 2 : 0, summary, opts.out);
  } catch (err) {
    emitJsonAndExit(1, { synced: false, exit_code: 1, error: err.message });
  }
} else if (cmd === 'brief') {
  if (opts.pos.length > 0) {
    emitJsonAndExit(1, { exit_code: 1, error: `Unexpected positional arguments: ${opts.pos.join(' ')}` });
  }
  try {
    const out = runBrief({ ...opts, outFile: opts.catalogPath });
    emitJsonAndExit(out.exitCode, out.result, opts.out);
  } catch (err) {
    emitJsonAndExit(1, { exit_code: 1, error: err.message });
  }
} else if (cmd === 'list') {
  if (opts.pos.length !== 1) {
    emitJsonAndExit(1, { exit_code: 1, error: 'Provide exactly one <domain> argument for list' });
  }
  try {
    const out = runList(opts.pos[0], { ...opts, outFile: opts.catalogPath });
    if (out.exitCode === 1) emitJsonAndExit(1, { exit_code: 1, error: out.error });
    emitJsonAndExit(out.exitCode, out.result, opts.out);
  } catch (err) {
    emitJsonAndExit(1, { exit_code: 1, error: err.message });
  }
} else if (cmd === 'inspect') {
  if (!isPositiveIntOption(opts.limit)) {
    emitJsonAndExit(1, { exit_code: 1, error: '--limit must be a positive integer' });
  }
  try {
    const out = runInspect(opts.pos.join(' '), { ...opts, outFile: opts.catalogPath });
    if (out.exitCode === 1) emitJsonAndExit(1, { exit_code: 1, error: out.error });
    emitJsonAndExit(out.exitCode, out.result, opts.out);
  } catch (err) {
    emitJsonAndExit(1, { exit_code: 1, error: err.message });
  }
} else if (cmd === 'init-plugin') {
  if (opts.pos.length > 0) {
    emitJsonAndExit(1, { initialized: false, exit_code: 1, error: `Unexpected positional arguments: ${opts.pos.join(' ')}` });
  }
  try {
    const out = runInitPlugin({ ...opts, outDir: opts.outDir || opts.out });
    if (out.exitCode === 1 && !out.result) {
      emitJsonAndExit(1, { initialized: false, exit_code: 1, error: out.error });
    }
    emitJsonAndExit(out.exitCode, out.result, opts.outDir ? opts.out : null);
  } catch (err) {
    emitJsonAndExit(1, { initialized: false, exit_code: 1, error: err.message });
  }
}
