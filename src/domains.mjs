/**
 * Built-in generic software-engineering domain presets and optional user `domains.json` loader.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DOMAINS = {
  db: {
    brief: 'Databases & storage diagnostics (Postgres/SQLite/Redis schema, indexes, RLS, EXPLAIN, migrations, backups)',
    priors: 'database postgres postgresql pg sql sqlite redis schema foreign key rls permissions slow query explain analyze buffers lock vacuum backup migration 数据库 慢查询 外键 迁移 备份',
    namePatterns: [/^(?:pg|postgres|sql|sqlite|redis|db)[-_]/i],
    textPatterns: [/\b(?:pg|postgres|postgresql|sql|sqlite|redis|db|database|rls|explain|vacuum)\b|(?:数据库|慢查询|外键|行级安全)/i],
  },
  sec: {
    brief: 'Application security audits (OWASP, auth, injection) and lockfile dependency CVE scanning',
    priors: 'security vulnerability owasp auth ssrf injection csrf xss cve lockfile advisory secret scan 安全 漏洞 鉴权 注入 依赖漏洞',
    namePatterns: [/^(?:sec|security|owasp|cve)[-_]/i],
    textPatterns: [/\b(?:sec|security|cve|owasp|ssrf|xss|csrf|vuln)\b|(?:漏洞|鉴权|安全审计)/i],
  },
  deploy: {
    brief: 'Containers, deployment, reverse proxies, .env drift checks, Kubernetes/Helm & TLS ops',
    priors: 'deploy release docker compose portal container tar allowlist image scan trivy k8s helm nginx reverse proxy systemd env dotenv tls ssl 部署 容器 托管平台 反代 环境变量 证书',
    namePatterns: [/^(?:docker-|env-diff|k8s-|helm-|nginx-|deploy-)/i],
    textPatterns: [/\b(?:nginx|k8s|helm|systemd|ssl|tls|docker|compose|deploy|dotenv|env)\b|(?:容器|部署|网关|反代|环境变量)/i],
  },
  repo: {
    brief: 'Pre-publish repo hygiene (secrets, hardcoded paths, broken links), CI pipelines, git history & releases',
    priors: 'pre-publish preflight secret hardcoded path broken link github actions ci yaml workflow git history purge changelog release monorepo pr 提交前 开源前 自查 密钥 硬编码 断链 流水线',
    namePatterns: [/^pre-publish/i, /^(?:ci|release|changelog|repo)-/i],
    textPatterns: [/\b(?:pre-publish|ci|git|pr|changelog|monorepo|repo|hardcoded|broken link)\b|(?:流水线|发布前|开源前|提交前|断链|硬编码|扫密钥)/i],
  },
  eval: {
    brief: 'Third-party OSS/GitHub repository vetting, license & telemetry audits, and model/tool benchmarks',
    priors: 'third-party oss github repo vetting install hook telemetry maintenance license spdx npm pypi wheel mcp eval benchmark 第三方 开源项目 尽调 遥测 活跃度 值不值得 评测',
    namePatterns: [/^oss-eval$/i, /^(?:eval|vet|bench)-/i],
    textPatterns: [/\b(?:eval|vetting|license|spdx|bench|benchmark|telemetry|oss)\b|(?:尽调|第三方|值不值得|评测对比|遥测)/i],
  },
  audit_qa: {
    brief: 'Engineering quality discipline (TDD, systematic debugging, verification, code review, API/type checks)',
    priors: 'code review tdd test-driven debug debugging verification openapi contract lint typecheck dead code wcag accessibility 代码审查 测试驱动 调试 排错 契约 类型检查',
    namePatterns: [/^(?:requesting-code|verification|systematic|test-driven)/i],
    textPatterns: [/\b(?:openapi|typecheck|lint|wcag|qa|tdd|test|debug|review|verification)\b|(?:契约|类型检查|排查|无障碍|代码审查|测试驱动)/i],
  },
  frontend_viz: {
    brief: 'Architecture/sequence diagrams (HTML/SVG/Mermaid), UI design, frontend performance & E2E scaffolding',
    priors: 'architecture diagram sequence state mermaid svg ui design frontend react vue tailwind vitest playwright e2e 架构图 时序图 状态图 流程图 前端设计 前端测试',
    namePatterns: [/^(?:frontend-|archify)/i],
    textPatterns: [/\b(?:react|vue|tailwind|bundle|svg|viz|frontend|archify|mermaid|vitest|playwright|diagram)\b|(?:架构图|时序图|组件性能|前端测试|视觉设计)/i],
  },
  docs_io: {
    brief: 'Document conversion (PDF/Office to Markdown), live library docs lookup, ADR/README verification',
    priors: 'pdf word excel powerpoint markdown markitdown library docs context7 api documentation adr readme glossary 文档转换 官方文档 术语',
    namePatterns: [/^(?:docs-|markitdown|context7|adr-)/i],
    textPatterns: [/\b(?:pdf|docx|xlsx|adr|readme|glossary|docs|markitdown|context7|markdown)\b|(?:转markdown|文档|术语|官方文档)/i],
  },
  code_graph: {
    brief: 'Code semantic call graphs (caller/callee/impact), AST refactoring & repository knowledge graphs',
    priors: 'call graph caller callee impact symbol codegraph ast ast-grep refactor knowledge graph graphify lineage 调用链 影响面 图谱 重构 血缘',
    namePatterns: [/^(?:graphify|codegraph|ast-)/i],
    textPatterns: [/\b(?:ast|lineage|graph|codegraph|caller|callee|callers|callees|impact|graphify)\b|(?:调用链|影响面|血缘|图谱)/i],
  },
  web_media: {
    brief: 'Web research, CDP browser session reuse, headless automation, image OCR/vision & media extraction',
    priors: 'web research search browser cdp chrome playwright headless screenshot image ocr vision rss youtube audio video 全网调研 登录态 截图 识图 提取',
    namePatterns: [/^(?:agent-reach|browser-cdp|image-vision)/i],
    textPatterns: [/\b(?:ocr|rss|youtube|tts|browser|cdp|vision|reach|playwright|scrape|media)\b|(?:全网调研|截图|网页抓取|识图|登录态)/i],
  },
  meta_collab: {
    brief: 'Skill authoring/reviewing/gating, multi-agent collaboration, CLI wrappers & memory consolidation',
    priors: 'create skill author scaffold gate review skill-creator skill-reviewer codex cli subagent collab memory consolidate capture 做skill 创建skill 评审skill 协作 子代理 沉淀',
    namePatterns: [/^(?:skill-|codex-|grok-|hermes-|kimi-|review-skills|capture|memory-)/i],
    textPatterns: [/\b(?:codex|skill|skills|scaffold|d-gate|capture|subagent|collab|cli|memory)\b|(?:沉淀|智能体|协作|做skill|创建skill|评审skill)/i],
  },
  general: {
    brief: 'General-purpose utilities and uncategorized skills',
    priors: 'utility helper general workflow',
    namePatterns: [],
    textPatterns: [],
  },
};

function compilePatternList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const item of rawList) {
    if (item instanceof RegExp) {
      out.push(item);
    } else if (typeof item === 'string' && item.trim()) {
      out.push(new RegExp(item.trim(), 'i'));
    }
  }
  return out;
}

function cloneDefaultDomains() {
  const out = {};
  for (const [k, v] of Object.entries(DEFAULT_DOMAINS)) {
    out[k] = {
      brief: v.brief,
      priors: v.priors,
      namePatterns: [...v.namePatterns],
      textPatterns: [...v.textPatterns],
    };
  }
  return out;
}

export function loadDomainsConfig(configPath = null, cwd = process.cwd()) {
  const domains = cloneDefaultDomains();
  let resolvedPath = null;

  if (configPath) {
    resolvedPath = path.resolve(cwd, configPath);
    if (!fs.existsSync(resolvedPath)) {
      return { ok: false, domains, configPath: resolvedPath, error: `Domains config not found: ${configPath}` };
    }
  } else {
    const candidates = [
      path.join(cwd, 'domains.json'),
      path.join(cwd, '.skill-plumb.json'),
      path.join(os.homedir(), '.config', 'skill-plumb', 'domains.json'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        resolvedPath = c;
        break;
      }
    }
  }

  if (!resolvedPath) {
    return { ok: true, domains, configPath: null, error: null };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (err) {
    return { ok: false, domains, configPath: resolvedPath, error: `Invalid JSON in domains config ${resolvedPath}: ${err.message}` };
  }

  const section = raw && typeof raw === 'object' && raw.domains && typeof raw.domains === 'object'
    ? raw.domains
    : raw;

  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    return { ok: false, domains, configPath: resolvedPath, error: `Domains config must be an object: ${resolvedPath}` };
  }

  for (const [domName, def] of Object.entries(section)) {
    if (domName.startsWith('_') || domName === '$schema') continue;
    if (typeof def === 'string') {
      const existing = domains[domName] || { brief: '', priors: '', namePatterns: [], textPatterns: [] };
      domains[domName] = { ...existing, brief: def };
      continue;
    }
    if (!def || typeof def !== 'object') continue;
    const existing = domains[domName] || { brief: domName, priors: '', namePatterns: [], textPatterns: [] };
    domains[domName] = {
      brief: typeof def.brief === 'string' ? def.brief : existing.brief,
      priors: typeof def.priors === 'string' ? `${existing.priors} ${def.priors}`.trim() : existing.priors,
      namePatterns: [...compilePatternList(def.namePatterns || def.name_patterns), ...existing.namePatterns],
      textPatterns: [...compilePatternList(def.textPatterns || def.text_patterns), ...existing.textPatterns],
    };
  }

  return { ok: true, domains, configPath: resolvedPath, error: null };
}

export function parseFrontmatterDomain(raw) {
  const fm = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const body = fm[1];
  const mDirect = body.match(/^x-domain\s*:\s*["']?([a-z0-9_-]+)["']?/mi);
  if (mDirect) return mDirect[1].toLowerCase().trim();
  const mMeta = body.match(/^metadata\s*:\s*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+domain\s*:\s*["']?([a-z0-9_-]+)["']?/mi);
  if (mMeta) return mMeta[1].toLowerCase().trim();
  return null;
}

export function inferDomain(name, positiveDesc = '', domainsMap = DEFAULT_DOMAINS) {
  const entries = Object.entries(domainsMap);

  // Pass 1: Explicit name slug patterns (custom domains merged ahead of built-ins)
  for (const [dom, def] of entries) {
    for (const re of def.namePatterns || []) {
      if (re.test(name)) return dom;
    }
  }

  // Pass 2: Name first, then name + positive description against text patterns
  for (const text of [name, `${name} ${positiveDesc}`]) {
    for (const [dom, def] of entries) {
      for (const re of def.textPatterns || []) {
        if (re.test(text)) return dom;
      }
    }
  }

  return 'general';
}
