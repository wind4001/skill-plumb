/**
 * Multi-host skill directory, MCP config, and override file discovery + safe cross-platform execution.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function discoverSkillDirs({ skillsDirs = null, cwd = process.cwd() } = {}) {
  if (Array.isArray(skillsDirs) && skillsDirs.length > 0) {
    const seen = new Set();
    const out = [];
    for (const dir of skillsDirs) {
      if (!dir) continue;
      const abs = path.resolve(cwd, dir);
      let key = abs;
      try {
        if (fs.existsSync(abs)) key = fs.realpathSync(abs);
      } catch { /* ignore */ }
      if (!seen.has(key)) {
        seen.add(key);
        out.push(abs);
      }
    }
    return out;
  }

  const home = os.homedir();
  const candidates = [
    path.join(cwd, '.agents', 'skills'),
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.codex', 'skills'),
    path.join(home, '.gemini', 'config', 'skills'),
  ];

  const seen = new Set();
  const existing = [];
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      const real = fs.realpathSync(dir);
      if (!seen.has(real)) {
        seen.add(real);
        existing.push(dir);
      }
    } catch { /* ignore */ }
  }
  return existing;
}

export function collectSkillEntries(skillDirs) {
  const seenFiles = new Set();
  const seenNames = new Set();
  const entries = [];

  for (const root of skillDirs) {
    if (!root || !fs.existsSync(root)) continue;
    let names;
    try {
      names = fs.readdirSync(root).sort();
    } catch {
      continue;
    }

    for (const name of names) {
      if (name.startsWith('.')) continue;
      const dir = path.join(root, name);
      const mdPath = path.join(dir, 'SKILL.md');
      try {
        if (!fs.existsSync(mdPath) || !fs.statSync(mdPath).isFile()) continue;
        const realMd = fs.realpathSync(mdPath);
        const realDir = fs.realpathSync(dir);
        if (seenFiles.has(realMd) || seenNames.has(name)) continue;
        seenFiles.add(realMd);
        seenNames.add(name);
        entries.push({
          name,
          dir,
          realDir,
          mdPath: realMd,
          sourceRoot: root,
        });
      } catch { /* ignore unreadable/broken symlink */ }
    }
  }
  return entries;
}

export function discoverMcpConfig({ mcpCfgPath = undefined, noMcp = false, cwd = process.cwd() } = {}) {
  if (noMcp || mcpCfgPath === null) return null;
  if (typeof mcpCfgPath === 'string' && mcpCfgPath.trim()) {
    return path.resolve(cwd, mcpCfgPath);
  }

  const home = os.homedir();
  const candidates = [
    path.join(cwd, '.mcp.json'),
    path.join(home, '.gemini', 'config', 'mcp_config.json'),
    path.join(home, '.config', 'claude', 'mcp_config.json'),
    path.join(home, '.claude.json'),
  ];

  for (const c of candidates) {
    try {
      if (!fs.existsSync(c) || !fs.statSync(c).isFile()) continue;
      const parsed = JSON.parse(fs.readFileSync(c, 'utf8'));
      if (parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers !== null) {
        return c;
      }
    } catch { /* ignore invalid candidate */ }
  }
  return null;
}

export function discoverOverridesPath({ overridesPath = null, cwd = process.cwd() } = {}) {
  if (overridesPath) return path.resolve(cwd, overridesPath);
  const home = os.homedir();
  const candidates = [
    path.join(cwd, 'router_overrides.json'),
    path.join(cwd, '.skill-plumb', 'router_overrides.json'),
    path.join(home, '.config', 'skill-plumb', 'router_overrides.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function defaultCachePath() {
  const dir = process.env.SKILL_PLUMB_CACHE_DIR || path.join(os.homedir(), '.cache', 'skill-plumb');
  return path.join(dir, 'live_catalog.json');
}

export function findExecutable(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, name + ext);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch { /* ignore */ }
    }
  }
  return null;
}

/**
 * Safely execute binaries on Windows (wrapping `.cmd`/`.bat` shims via `cmd.exe /d /s /c`
 * to prevent Node 24+ `EINVAL` spawn errors).
 */
export function execSafe(bin, args = [], opts = {}) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    return execFileSync('cmd.exe', ['/d', '/s', '/c', bin, ...args], opts);
  }
  return execFileSync(bin, args, opts);
}
