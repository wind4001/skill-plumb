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
  --out <file>            Write JSON output (or output dir for scaffold/init-plugin)
  -h, --help              Show help
  -v, --version           Show version`);
}

function printSubHelp(cmd) {
  const helps = {
    doctor: `Usage: skill-plumb doctor [--skills-dir <dir>]... [--mcp-cfg <file> | --no-mcp] [--overrides <file>] [--domains <file>] [--max-lines 150] [--max-bytes 9000] [--json] [--out <file>]`,
    scaffold: `Usage: skill-plumb scaffold --name <slug> --domain <domain> --summary "<desc>" [--mode full|lite|ops] [--out-dir <dir>] [--skills-dir <dir>]... [--use-when "<trigger>"] [--not-for "<exclusions>"] [--dry-run] [--force]`,
    gate: `Usage: skill-plumb gate <skill_dir> [--mode auto|full|lite] [--max-lines 150] [--max-bytes 9000] [--skills-dir <dir>]... [--overrides <file>] [--domains <file>] [--no-mcp] [--skip-routing] [--skip-verify] [--no-sync] [--out <file>]`,
    sync: `Usage: skill-plumb sync [--skills-dir <dir>]... [--mcp-cfg <file> | --no-mcp] [--overrides <file>] [--domains <file>] [--out <catalog.json>]`,
    brief: `Usage: skill-plumb brief [--skills-dir <dir>]... [--mcp-cfg <file> | --no-mcp] [--overrides <file>] [--domains <file>] [--out <catalog.json>]`,
    list: `Usage: skill-plumb list <domain> [--skills-dir <dir>]... [--mcp-cfg <file> | --no-mcp] [--overrides <file>] [--domains <file>] [--out <catalog.json>]`,
    inspect: `Usage: skill-plumb inspect "<query>" [--domain <d>] [--limit 5] [--skills-dir <dir>]... [--mcp-cfg <file> | --no-mcp] [--overrides <file>] [--domains <file>] [--out <catalog.json>]`,
    'init-plugin': `Usage: skill-plumb init-plugin [--out <dir_or_file>] [--format plugin|agents-md] [--force] [--dry-run]`,
  };
  console.log(helps[cmd] || helps.doctor);
}

const VALUE_FLAGS = new Set([
  '--skills-dir', '--mcp-cfg', '--overrides', '--domains', '--out', '--out-dir',
  '--name', '--domain', '--summary', '--use-when', '--not-for', '--mode',
  '--max-lines', '--max-bytes', '--limit', '--format', '--check-mirror',
]);

const BOOL_FLAGS = new Set([
  '--no-mcp', '--json', '--dry-run', '--force', '--skip-routing', '--skip-verify',
  '--no-sync', '--help', '-h',
]);

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
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        return { ok: false, error: `Missing value for ${a}` };
      }
      const v = argv[++i];
      if (a === '--skills-dir') opts.skillsDirs.push(v);
      else if (a === '--mcp-cfg') opts.mcpCfgPath = v;
      else if (a === '--overrides') opts.overridesPath = v;
      else if (a === '--domains') opts.domainsPath = v;
      else if (a === '--out') opts.out = v;
      else if (a === '--out-dir') opts.outDir = v;
      else if (a === '--name') opts.name = v;
      else if (a === '--domain') opts.domain = v;
      else if (a === '--summary') opts.summary = v;
      else if (a === '--use-when') opts.useWhen = v;
      else if (a === '--not-for') opts.notFor = v;
      else if (a === '--mode') opts.mode = v;
      else if (a === '--max-lines') opts.maxLines = Number(v);
      else if (a === '--max-bytes') opts.maxBytes = Number(v);
      else if (a === '--limit') opts.limit = Number(v);
      else if (a === '--format') opts.format = v;
      else if (a === '--check-mirror') opts.checkMirror = v;
    } else if (a.startsWith('-')) {
      return { ok: false, error: `Unknown flag: ${a}` };
    } else {
      opts.pos.push(a);
    }
  }
  return { ok: true, opts };
}

function writeOutFile(outPath, content) {
  const abs = path.resolve(outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function emitJsonAndExit(code, payload, outPath = null) {
  const serialized = JSON.stringify(payload, null, 2) + '\n';
  if (outPath) writeOutFile(outPath, serialized);
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
  if (Number.isNaN(opts.maxLines) || Number.isNaN(opts.maxBytes)) {
    emitJsonAndExit(1, { exit_code: 1, error: '--max-lines and --max-bytes must be valid numbers' });
  }
  const out = runDoctor(opts);
  if (out.exitCode === 1) emitJsonAndExit(1, { scan_completed: false, exit_code: 1, error: out.error });
  const serialized = JSON.stringify(out.result, null, 2) + '\n';
  if (opts.out) writeOutFile(opts.out, serialized);
  if (opts.json) process.stdout.write(serialized);
  else process.stdout.write(formatDoctorReport(out.result));
  process.exit(out.exitCode);
} else if (cmd === 'scaffold') {
  const out = runScaffold(opts);
  if (out.exitCode === 1 && !out.result) {
    emitJsonAndExit(1, { scaffolded: false, exit_code: 1, error: out.error });
  }
  emitJsonAndExit(out.exitCode, out.result);
} else if (cmd === 'gate') {
  if (opts.pos.length !== 1) {
    emitJsonAndExit(1, { gate_passed: false, exit_code: 1, error: 'Provide exactly one <skill_dir> path' });
  }
  if (Number.isNaN(opts.maxLines) || Number.isNaN(opts.maxBytes)) {
    emitJsonAndExit(1, { gate_passed: false, exit_code: 1, error: '--max-lines and --max-bytes must be valid numbers' });
  }
  const out = runGate({ ...opts, skillDir: opts.pos[0] });
  if (out.exitCode === 1 && !out.result) {
    emitJsonAndExit(1, { gate_passed: false, exit_code: 1, error: out.error });
  }
  emitJsonAndExit(out.exitCode, out.result, opts.out);
} else if (cmd === 'sync') {
  try {
    const { summary } = syncLiveCatalog({ ...opts, outFile: opts.out });
    emitJsonAndExit(summary.missing_not_for_count > 0 ? 2 : 0, summary);
  } catch (err) {
    emitJsonAndExit(1, { synced: false, exit_code: 1, error: err.message });
  }
} else if (cmd === 'brief') {
  try {
    const out = runBrief({ ...opts, outFile: opts.out });
    emitJsonAndExit(out.exitCode, out.result);
  } catch (err) {
    emitJsonAndExit(1, { exit_code: 1, error: err.message });
  }
} else if (cmd === 'list') {
  try {
    const out = runList(opts.pos[0], { ...opts, outFile: opts.out });
    if (out.exitCode === 1) emitJsonAndExit(1, { exit_code: 1, error: out.error });
    emitJsonAndExit(out.exitCode, out.result);
  } catch (err) {
    emitJsonAndExit(1, { exit_code: 1, error: err.message });
  }
} else if (cmd === 'inspect') {
  try {
    const out = runInspect(opts.pos.join(' '), { ...opts, outFile: opts.out });
    if (out.exitCode === 1) emitJsonAndExit(1, { exit_code: 1, error: out.error });
    emitJsonAndExit(out.exitCode, out.result);
  } catch (err) {
    emitJsonAndExit(1, { exit_code: 1, error: err.message });
  }
} else if (cmd === 'init-plugin') {
  const out = runInitPlugin({ ...opts, outDir: opts.out || opts.outDir });
  if (out.exitCode === 1 && !out.result) {
    emitJsonAndExit(1, { initialized: false, exit_code: 1, error: out.error });
  }
  emitJsonAndExit(out.exitCode, out.result);
}
