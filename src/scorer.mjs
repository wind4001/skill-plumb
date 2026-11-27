/**
 * Two-stage O(domain) + Not-For + Direct-Restraint router scorer.
 */
import { DEFAULT_DOMAINS } from './domains.mjs';

const ASCII_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'when', 'use', 'not',
  'how', 'can', 'help', 'check', 'file', 'files', 'repo', 'project', 'tool', 'skill',
  'code', 'run', 'using', 'used', 'via', 'mode', 'all', 'any', 'are', 'you', 'your',
]);

const CJK_STOP_GRAMS = new Set([
  '一下', '这个', '那个', '怎么', '如何', '需要', '进行', '使用', '可以', '什么',
  '一个', '不是', '是不是', '有没有', '里面', '检查', '分析', '一下这', '帮我',
  '请问', '直接', '只是', '目前', '已经', '不要', '或者', '以及',
]);

export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const ascii = new Set();
  const cjk2 = new Set();
  const cjk3 = new Set();

  const words = s.match(/[a-z0-9][a-z0-9_.+/-]{1,}/g) || [];
  for (const w of words) {
    if (!ASCII_STOP.has(w)) ascii.add(w);
    const parts = w.split(/[-_./+]+/).filter((p) => p.length >= 2 && !ASCII_STOP.has(p));
    for (const p of parts) ascii.add(p);
  }

  const cjkSpans = s.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const span of cjkSpans) {
    for (let i = 0; i <= span.length - 2; i++) {
      const g2 = span.slice(i, i + 2);
      if (!CJK_STOP_GRAMS.has(g2)) cjk2.add(g2);
    }
    for (let i = 0; i <= span.length - 3; i++) {
      const g3 = span.slice(i, i + 3);
      if (!CJK_STOP_GRAMS.has(g3)) cjk3.add(g3);
    }
  }
  return { ascii, cjk2, cjk3, raw: s };
}

function overlapScore(qTok, fTok, excludeAscii = null) {
  let score = 0;
  const hits = [];
  for (const t of qTok.ascii) {
    if (excludeAscii && excludeAscii.has(t)) continue;
    if (fTok.ascii.has(t)) {
      score += 2.2;
      hits.push(t);
    }
  }
  for (const g of qTok.cjk3) {
    if (fTok.cjk3.has(g)) {
      score += 1.9;
      hits.push(g);
    }
  }
  for (const g of qTok.cjk2) {
    if (fTok.cjk2.has(g)) {
      score += 0.95;
      hits.push(g);
    }
  }
  return { score, hits: [...new Set(hits)] };
}

/**
 * Strip parenthetical sibling cross-references such as `(use sibling-skill)` or `（用 xxx）`
 * so mentioning a competing tool in `not_for` does not trigger brand-token self-penalties.
 */
function stripSiblingHints(text) {
  return String(text || '')
    .replace(/\(\s*(?:use|see|try|prefer)\s+[^)]+\)/gi, ' ')
    .replace(/（\s*(?:用|请用|见|改用)\s*[^）]+）/g, ' ');
}

/**
 * Direct-No-Tool ("NONE") detector for trivial / deterministic local actions
 * where pulling any Skill or MCP server is unnecessary overhead.
 */
export function detectDirectNoTool(query) {
  const raw = String(query || '').trim();
  const s = raw.toLowerCase();

  // Explicit heavy-audit / domain workflow intents are NEVER suppressed
  const heavyToolIntent = /(?:audit|security|cve|owasp|explain|analyze|buffers|migration|diagram|mermaid|callers|callees|impact|playwright|vitest|docker|compose|helm|nginx|pre-publish|secret|hardcoded|broken link|telemetry|scaffold|d-gate|\.env|审计|尽调|扫密钥|硬编码|断链|遥测|值不值得|外键缺索引|rls|行级安全|迁移|架构图|时序图|影响面|pdf转|文档转|复用.*登录态|cdp|e2e测试|托管平台|漏洞)/i;
  if (heavyToolIntent.test(raw)) {
    return { isDirect: false, reason: null };
  }

  const literalEdit = /(?:把.{1,40}(?:里的|中的|第\d+行).{0,25}(?:改成|改为|替换成|删掉|删除|去掉)|只改.{1,25}(?:文案|标题|副标题|常量|版本号|拼写|错别字)|fix (?:a )?typo\b|rename local\b|remove ['"`(]?draft['"`)]?)/i;
  const simpleReadOrStatus = /^(?:(?:看看|查一下|列出|读取|统计|执行|跑一下).{0,30}(?:git log|git status|git diff|行数|前\s*\d+\s*行|后\s*\d+\s*行|package\.json|tsconfig|npm test|pytest|格式化\s*json)|(?:run|check|show|read|list)\s+(?:git status|git log|git diff|package\.json|tsconfig\.json|npm test|pytest)\b)/i;
  const explicitNoSkill = /(?:不用查文档|直接动手|不需要扩展工具|just read|direct edit|no skill needed)/i;

  if (literalEdit.test(raw) || simpleReadOrStatus.test(s) || explicitNoSkill.test(raw)) {
    return {
      isDirect: true,
      reason: 'Single-file literal edit, simple local read, or trivial deterministic git/test command requires built-in tools only (NONE).',
    };
  }
  return { isDirect: false, reason: null };
}

function buildDomainIndex(catalog) {
  const byDomain = new Map();
  for (const item of catalog) {
    if (!byDomain.has(item.domain)) byDomain.set(item.domain, []);
    byDomain.get(item.domain).push(item);
  }
  return byDomain;
}

export function scoreFlat(catalog, query, opts = {}) {
  const qTok = tokenize(query);
  const scored = catalog.map((item) => {
    const idTok = tokenize(`${item.id} ${item.name || ''}`);
    const bodyTok = tokenize(`${item.purpose || ''} ${item.use_when || ''}`);
    const idHit = overlapScore(qTok, idTok);
    const bodyHit = overlapScore(qTok, bodyTok);
    const total = Number((idHit.score * 1.3 + bodyHit.score).toFixed(3));
    return {
      id: item.id,
      domain: item.domain,
      kind: item.kind,
      score: total,
      matched: [...new Set([...idHit.hits, ...bodyHit.hits])].slice(0, 8),
      penalized: [],
      entry: item.entry,
      use_when: item.use_when,
      not_for: item.not_for || [],
    };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const threshold = opts.minScore ?? 0.5;
  const predicted = !top || top.score < threshold ? 'NONE' : top.id;
  return {
    predicted,
    top_k: scored.slice(0, opts.limit || 5),
    candidates_scanned: catalog.length,
    stage1_domains: null,
  };
}

export function scoreTwoStage(catalog, query, opts = {}) {
  const direct = detectDirectNoTool(query);
  if (direct.isDirect && !opts.ignoreDirectGuard) {
    return {
      predicted: 'NONE',
      direct_no_tool: true,
      direct_reason: direct.reason,
      stage1_domains: [],
      candidates_scanned: 0,
      top_k: [],
    };
  }

  const domainsMap = opts.domains || DEFAULT_DOMAINS;
  const qTok = tokenize(query);
  const byDomain = buildDomainIndex(catalog);

  let domainScores = [];
  if (opts.domain && byDomain.has(opts.domain)) {
    domainScores = [{ domain: opts.domain, score: 99, hits: ['explicit --domain'] }];
  } else {
    for (const [dom, items] of byDomain.entries()) {
      const domDef = domainsMap[dom] || {};
      const priorText = `${domDef.brief || ''} ${domDef.priors || ''}`;
      const priorHit = overlapScore(qTok, tokenize(priorText));
      let maxMemberHit = 0;
      for (const it of items) {
        const idxTok = tokenize(`${it.id} ${(it.aka || []).join(' ')}`);
        const m = overlapScore(qTok, idxTok).score;
        if (m > maxMemberHit) maxMemberHit = m;
      }
      const domScore = Number((priorHit.score * 0.9 + maxMemberHit * 0.7).toFixed(3));
      domainScores.push({ domain: dom, score: domScore, hits: priorHit.hits.slice(0, 5) });
    }
    domainScores.sort((a, b) => b.score - a.score);
  }

  const topDomScore = domainScores[0]?.score || 0;
  const selectedDomains = [];
  for (const ds of domainScores) {
    if (selectedDomains.length === 0) selectedDomains.push(ds.domain);
    else if (selectedDomains.length < 2 && ds.score >= topDomScore * 0.45 && ds.score > 0.8) selectedDomains.push(ds.domain);
    else if (selectedDomains.length < 3 && ds.score >= topDomScore * 0.75 && ds.score > 1.5) selectedDomains.push(ds.domain);
  }

  const candidatePool = selectedDomains.flatMap((d) => byDomain.get(d) || []);

  const scored = candidatePool.map((item) => {
    const idTok = tokenize(`${item.id} ${item.name || ''}`);
    const akaTok = tokenize((item.aka || []).join(' '));
    const useTok = tokenize(`${item.use_when || ''} ${item.purpose || ''}`);
    const notTok = tokenize(stripSiblingHints((item.not_for || []).join(' ')));

    const idHit = overlapScore(qTok, idTok);
    const akaHit = overlapScore(qTok, akaTok);
    const useHit = overlapScore(qTok, useTok);
    // Exclude candidate's own id/name ASCII tokens from Not-For penalty so sibling brand words don't self-penalize
    const notHit = overlapScore(qTok, notTok, idTok.ascii);

    const pos = idHit.score * 1.45 + akaHit.score * 1.35 + useHit.score * 1.05;
    const neg = !opts.disableNotFor && notHit.score >= 1.5 ? notHit.score * 1.9 : 0;
    const total = Number((pos - neg).toFixed(3));

    return {
      id: item.id,
      domain: item.domain,
      kind: item.kind,
      score: total,
      pos: Number(pos.toFixed(2)),
      neg: Number(neg.toFixed(2)),
      matched: [...new Set([...idHit.hits, ...akaHit.hits, ...useHit.hits])].slice(0, 8),
      penalized: neg > 0 ? notHit.hits.slice(0, 6) : [],
      use_when: item.use_when,
      not_for: item.not_for || [],
      entry: item.entry,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const minThreshold = opts.minScore ?? 1.8;
  const predicted = !best || best.score < minThreshold ? 'NONE' : best.id;

  return {
    predicted,
    direct_no_tool: predicted === 'NONE',
    direct_reason: predicted === 'NONE' ? 'Top candidate score below abstention threshold; handle directly.' : null,
    stage1_domains: selectedDomains,
    domain_scores_top4: domainScores.slice(0, 4),
    candidates_scanned: candidatePool.length,
    top_k: scored.slice(0, opts.limit || 5),
  };
}
