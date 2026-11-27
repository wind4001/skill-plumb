/**
 * Portable routing-rule plugin / AGENTS.md generator (`skill-plumb init-plugin`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_TMPL_DIR = path.resolve(HERE, '..', 'templates', 'plugin');

export function runInitPlugin(opts = {}) {
  const format = opts.format || 'plugin';
  if (!['plugin', 'agents-md'].includes(format)) {
    return { exitCode: 1, error: `--format must be plugin | agents-md (got ${format})` };
  }

  const cwd = opts.cwd || process.cwd();
  const pluginJson = fs.readFileSync(path.join(PLUGIN_TMPL_DIR, 'plugin.json'), 'utf8');
  const agentsMd = fs.readFileSync(path.join(PLUGIN_TMPL_DIR, 'rules', 'AGENTS.md'), 'utf8');

  const planned = [];
  let targetRoot;

  if (format === 'plugin') {
    targetRoot = path.resolve(cwd, opts.outDir || 'skill-plumb-router');
    planned.push({ abs: path.join(targetRoot, 'plugin.json'), rel: 'plugin.json', content: pluginJson });
    planned.push({ abs: path.join(targetRoot, 'rules', 'AGENTS.md'), rel: 'rules/AGENTS.md', content: agentsMd });
  } else {
    const outArg = opts.outDir || 'AGENTS.md';
    const resolved = path.resolve(cwd, outArg);
    const outFile = outArg.toLowerCase().endsWith('.md') ? resolved : path.join(resolved, 'AGENTS.md');
    targetRoot = path.dirname(outFile);
    planned.push({ abs: outFile, rel: path.basename(outFile), content: agentsMd });
  }

  const conflicts = planned.filter((f) => fs.existsSync(f.abs)).map((f) => f.abs.replace(/\\/g, '/'));
  if (!opts.dryRun && conflicts.length > 0 && !opts.force) {
    return {
      exitCode: 2,
      result: {
        initialized: false,
        exit_code: 2,
        exit_meaning: 'target_exists_use_force',
        format,
        conflicts,
      },
    };
  }

  if (!opts.dryRun) {
    for (const f of planned) {
      fs.mkdirSync(path.dirname(f.abs), { recursive: true });
      fs.writeFileSync(f.abs, f.content, 'utf8');
    }
  }

  return {
    exitCode: 0,
    result: {
      initialized: !opts.dryRun,
      dry_run: Boolean(opts.dryRun),
      format,
      target: targetRoot.replace(/\\/g, '/'),
      files: planned.map((f) => f.abs.replace(/\\/g, '/')),
    },
  };
}
