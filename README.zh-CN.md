<div align="center">

# SkillPlumb（技准）

**让 Agent Skills 真正可用、测得准、不走偏：薄契约 + `0/1/2` 确定性探针 + 黑盒门禁 + 零侵入两段式路由。**

*装了 50+ 个 Skill 后，别再看着你的 Coding Agent 越用越慢、越贵、越爱偷懒。*

[English](README.md) | 简体中文

[![CI](https://github.com/wind4001/skill-plumb/actions/workflows/ci.yml/badge.svg)](https://github.com/wind4001/skill-plumb/actions/workflows/ci.yml)
![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-339933)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

</div>

---

## 为什么装了 50+ 个 Skill 后，Agent 反而变笨了？

装 5 个 Skill 时体验惊艳，装到 50–100+ 个之后，大多数 Skill 集合都会撞上三个结构性瓶颈：

1. **`SKILL.md` 沦为 300 行散文论文**：Prompt 越写越长，Agent 要么直接跳过第一步检查，要么假装“已验证通过”，同时每轮都在白烧数千 Token。
2. **扁平全量暴露导致路由碰撞**：把 50–100+ 条技能描述一股脑塞进首轮系统提示词，信噪比暴跌——连 *“把 README 里的错别字改掉”* 这种小活都会误触发重型审查流程。
3. **第三方技能更新覆写**：为了加一条 `Not for` 反向边界而直接去改插件同步来的 `SKILL.md`，下次一升级就会被原样覆盖清零。

**SkillPlumb（技准）** 用**零外部运行时依赖（纯 Node.js >= 20）**把 `SKILL.md` 变成可度量、可门禁、可路由的工程化基础设施。

---

## 实测对比数据（受控 N=100 基准测试）

以下数据均来自开源拆仓前的受控对照实测（完整实验设置与消融数据见 [docs/benchmarks-summary.md](docs/benchmarks-summary.md)）：

| 指标 | 扁平 N=100 基线 | SkillPlumb 两段式 | 变化幅度 |
|---|---:|---:|---|
| **离线 Top-1 路由准确率**（40 条查询） | 75.0%（`30/40`） | **90.0%（`36/40`）** | **+15.0 个百分点**（真实工具 `18/18`） |
| **单次查询扫描候选数** | 100.0 | **8.5** | **-91.5% 扫描扇出** |
| **Step-1 确定性探针遵从率**（真实 LLM） | `2/4` | **`4/4`** | **100% 按契约先跑探针** |
| **平均首轮输入 Token**（真实 LLM） | 18,294.8 | **12,099.3** | **-33.9% 首轮输入** |
| **总输入 Token / 平均耗时**（4 组配对） | 172,735 / 129.8s | **102,657 / 102.5s** | **-40.6% 总输入 / -21.0% 耗时** |
| **第三方 `SKILL.md` 侵入改动** | 需手工改原文件 | **0 字节修改** | **SHA-256 逐字节一致** |

---

## 30 秒只读体检（`doctor`）

一条命令扫描你本机所有 Skill 目录，**绝不修改任何用户文件**：

```bash
# 克隆仓库后直接运行（发布 npm 后亦可直接 npx skill-plumb doctor）
node bin/skill-plumb.mjs doctor
```

输出示例（自动识别膨胀契约、拥挤域冲突、断链，并生成可粘贴的零侵入修复片段）：

```text
SkillPlumb Doctor — ISSUES FOUND (exit 2)
Dirs scanned (2): ~/.agents/skills, ~/.claude/skills
Entries: 48 (43 skills, 5 MCPs across 11 domains)

| Check | Count |
|---|---:|
| Bloated SKILL.md (>150 lines or >9KB or >35-line fence) | 2 |
| Crowded domain missing Not-for (domain_count >= 2) | 3 |
| Broken or escaping relative links | 1 |
| Hardcoded personal user-home paths | 0 |
| Overrides schema warnings | 0 |
| Solo-domain missing Not-for (informational) | 4 |

Findings:
- [MEDIUM] legacy-deploy (bloated_skill_md): Exceeds thin contract budget (lines: 242/150, bytes: 11420/9000, max_fence: 48/35)
- [HIGH] pg-helper-a (crowded_missing_not_for): Missing `Not for` in crowded domain "db" (3 competing entries)
- [HIGH] api-reviewer (broken_link): Broken relative link: references/checklist.md

Suggested router_overrides.json snippet (zero-invasion fix):
{
  "_doc": "Paste into router_overrides.json to fix crowded-domain collisions without modifying SKILL.md",
  "overrides": {
    "pg-helper-a": {
      "domain": "db",
      "not_for": [
        "slow query runtime tuning (use pg-query-tuner)"
      ]
    }
  }
}
```

---

## 改造前 vs. 改造后

| 维度 | 传统 50+ Skill 堆砌 | 接入 SkillPlumb 之后 |
|---|---|---|
| **`SKILL.md` 形态** | 200–400 行散文 + 大段内联脚本 | **薄行为契约**（`<= 150` 行、`<= 9 KB`、按需加载 `references/`） |
| **客观检查执行** | LLM 靠肉眼读文件“拍脑袋过关” | **`0 / 1 / 2` 确定性探针**（`0` 通过、`1` 报错、`2` 发现问题/覆盖不全） |
| **技能路由机制** | 每轮全量 N 选 1 扁平注入 | **两段式 `O(domain)`** 粗筛 + `Not for` 负向惩罚 + 直连守卫 |
| **改错别字等小操作** | 动辄误触发重型工作流 | **直连免工具守卫**直接返回 `NONE`（零额外开销） |
| **第三方技能冲突** | 改 `SKILL.md` 后被插件更新覆盖 | **外置 `router_overrides.json`**（零侵入、升级不丢） |
| **运行时依赖** | Python + Node + YAML + 向量库 | **零外部依赖**（仅标准 Node.js `>= 20` 内置模块） |

---

## 开箱兼容主流 Agent 宿主目录

默认自动探测常见宿主目录与 MCP 配置，也支持用 `--skills-dir`（可重复指定多目录）、`--mcp-cfg` / `--no-mcp` 显式覆盖：

| 宿主 / 规范 | 自动探测技能目录 | 说明 |
|---|---|---|
| **项目级工作区** | `./.agents/skills` | 优先级最高，适合项目专属 Skill |
| **通用全局目录** | `~/.agents/skills` | 按 `realpathSync` 与技能名自动去重 |
| **Claude Code** | `~/.claude/skills` | 同时探测 `~/.config/claude/mcp_config.json` 与 `~/.claude.json` |
| **Codex CLI** | `~/.codex/skills` | 跨平台支持 Windows / macOS / Linux |
| **Antigravity / Gemini** | `~/.gemini/config/skills` | 同时探测 `~/.gemini/config/mcp_config.json` |

---

## 核心工作流与四大支柱

```text
  [作者 / AI]
       │
       ▼
  skill-plumb scaffold  ──►  薄 SKILL.md（Use when / Not for + <skill_dir> 探针入口）
       │                     scripts/probe_*.mjs  (0 = 干净, 1 = 报错, 2 = 发现问题/缺口)
       │                     verify_*.mjs         (基于 os.tmpdir() 的黑盒隔离回归测试)
       ▼
  skill-plumb gate      ──►  6 道门禁验收：Frontmatter 边界、篇幅预算、相对链接卫生、
                             探针 CLI 契约、verify 实跑、实时路由自触发冒烟
       │
       ▼
  skill-plumb inspect   ──►  Stage 1：直连免工具守卫 (NONE) + O(domain) 域粗筛
  (指纹自动热刷新)            Stage 2：正向触发分 - Not-for 负向惩罚
                             歧义兜底：拥挤域缺少 Not-for 时交还 LLM 消歧
                               ▲
                               │  零侵入外置护栏
                     router_overrides.json（永不改写第三方 SKILL.md）
```

1. **薄契约（Thin Contracts）**：强制 `<= 150` 行、`<= 9,000` 字节、无超过 35 行的内联代码块，把长文档与规范外移至 `references/`。
2. **`0 / 1 / 2` 确定性探针**：明确区分 `0`（干净/就绪）、`1`（CLI 错/目标缺失/软链越界）、`2`（发现阻塞项或覆盖不全，绝不把跳过当零问题），并内置 `realpathSync` 防越界与零明文凭据脱敏。
3. **6 道黑盒门禁（`gate`）**：新写或改造完 Skill 后一键验收，杜绝“写了脚本没测 `--help` / 错参”、“写死本机绝对路径”、“Markdown 断链”等常见返工。
4. **零侵入两段式路由（`inspect`）**：基于 `mtimeMs + size` SHA-256 指纹自动增量刷新，无需每次手动 `sync`；Stage 2 自动剥离 `(use sibling-skill)` 引用并排除自身 slug 词，防止兄弟技能间因共享品牌词产生自惩罚。

---

## CLI 常用命令速查

```bash
# 1. 全机只读健康体检（人类可读表格 或 --json）
node bin/skill-plumb.mjs doctor
node bin/skill-plumb.mjs doctor --skills-dir ./skills --no-mcp --json

# 2. 生成新 Skill 骨架（支持 full | lite | ops 三种模式）
node bin/skill-plumb.mjs scaffold \
  --name env-diff-audit \
  --domain deploy \
  --summary "Audit .env against .env.example drift without secret echo." \
  --use-when "checking .env and .env.example before deploy" \
  --not-for "repo-wide git history secret audits (use pre-publish-audit)" \
  --mode full \
  --out-dir ./.agents/skills

# 3. 执行 6 道黑盒门禁验收
node bin/skill-plumb.mjs gate ./.agents/skills/env-diff-audit

# 4. 两段式路由查询与域浏览
node bin/skill-plumb.mjs brief
node bin/skill-plumb.mjs list deploy
node bin/skill-plumb.mjs inspect "compare .env against .env.example before deploy" --limit 3
node bin/skill-plumb.mjs sync

# 5. 生成跨宿主路由规范插件或 AGENTS.md 片段
node bin/skill-plumb.mjs init-plugin --format plugin --out ./skill-plumb-router
node bin/skill-plumb.mjs init-plugin --format agents-md --out ./AGENTS.md
```

### 外置规则配置示例（`router_overrides.json` & `domains.json`）

不改第三方 `SKILL.md` 即可为其补充域归属、双语别名 `aka` 与反向边界 `not_for`（完整模板见 [templates/router_overrides.example.json](templates/router_overrides.example.json)）：

```json
{
  "overrides": {
    "third-party-postgres-linter": {
      "domain": "db",
      "aka": ["postgres lint", "pg schema check"],
      "not_for": ["live slow-query EXPLAIN tuning (use pg-query-tuner)"]
    }
  }
}
```

内置 12 个通用软件工程域（`db`、`sec`、`deploy`、`repo`、`eval`、`audit_qa`、`frontend_viz`、`docs_io`、`code_graph`、`web_media`、`meta_collab`、`general`），可在项目根目录放置 `./domains.json`、`.skill-plumb.json` 或传 `--domains <file>` 自定义扩展（见 [templates/domains.example.json](templates/domains.example.json)）。

---

## 内置高质量示范技能（`examples/`）

`examples/` 下 4 个可运行技能全部通过 `skill-plumb gate`、`skill-plumb doctor` 与各自的 `os.tmpdir()` 黑盒回归套件：

| 示范技能 | 所属域 | 核心演示能力 |
|---|---|---|
| [`env-diff-audit`](examples/env-diff-audit/SKILL.md) | `deploy` | 自主脚手架产出的 D-Full 典范：零明文泄露比对 `.env` 与 `.env.example` |
| [`oss-eval`](examples/oss-eval/SKILL.md) | `eval` | 第三方 GitHub/开源项目尽调（安装钩子、遥测、活跃度）与 `--api-only` 轻量化初筛 |
| [`pre-publish-audit`](examples/pre-publish-audit/SKILL.md) | `repo` | 开源/提交前自查（含 Git 历史密钥、PII、硬编码路径、Compose 端口与 Markdown 断链） |
| [`skill-creator`](examples/skill-creator/SKILL.md) | `meta_collab` | 串联 `scaffold`、`gate` 与 `doctor` 的薄契约技能生产工作流 |

运行全套跨平台隔离测试（全程仅使用 `os.tmpdir()`，绝不读写 `~/.agents/skills/`）：

```bash
npm test
```

---

## 进阶文档与开源协议

* [基准评测与消融数据报告](docs/benchmarks-summary.md) — N=100 离线路由消融、真实 LLM A/B 实测与自主创作沙盒结果
* [架构设计与实战避坑清单](docs/architecture.md) — `0/1/2` 探针规范、打分细节、Windows `.cmd` `EINVAL` 与 PowerShell 5.1 兼容实践
* [MIT License](LICENSE)
