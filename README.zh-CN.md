<div align="center">

# SkillPlumb（技准）

[English](README.md) | 简体中文

[![CI](https://github.com/wind4001/skill-plumb/actions/workflows/ci.yml/badge.svg)](https://github.com/wind4001/skill-plumb/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/skill-plumb.svg)](https://www.npmjs.com/package/skill-plumb)
![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-339933)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

</div>

**别再写 300 行的 `SKILL.md` 小作文，然后祈祷 Coding Agent 乖乖照做了。**

现在的 `SKILL.md` 大多把脆弱的 bash 片段、人工提醒（“记得别打印密钥”“记得查 API 第二页”）和领域规则全混在一份长 Markdown 里。装到 50–100+ 个之后，Agent 不仅变慢、每轮白烧几千 Token、遇到 *“改个错别字”* 也会误触发重型工作流；而且你为了修误触去改第三方 `SKILL.md`，下次插件一更新就被冲掉。

**SkillPlumb（技准）** 是一套零外部依赖的 Node.js（`>= 20`）CLI，专门从底层重构这套用法：
- **把可重复的客观环境检查下沉为零依赖 `0/1/2` 本地脚本**，`SKILL.md` 只留 1 页判断契约（`<= 150` 行），不再靠模型肉眼猜结果。
- **两段式路由 `inspect` 治理 50–100+ 技能库**：按域粗筛再减去 `Not for` 惩罚，扫描量砍掉 ~91%，简单改文案直接返回 `NONE`。
- **用外置 `router_overrides.json` 零侵入修第三方冲突**：不改上游 `SKILL.md` 一个字节，插件升级不丢失。
- **用 `doctor` / `scaffold` / `gate` 管好全生命周期**：自动适配 Claude Code、Codex、Antigravity、Gemini CLI 与 `.agents/skills`。

---

## 我们为什么做它（以及亲手淘汰掉的弯路）

SkillPlumb 不是拍脑袋造出来的“又一个 Skill Linter”，而是历经三代盲测对照后收敛出的工程方案（完整实验见 [docs/benchmarks-summary.md](docs/benchmarks-summary.md)）：

| 演进代际 | 做法 | 真实对照踩出的问题 | 最终结论 |
|---|---|---|---|
| **1. 传统长散文 `SKILL.md`** | 250–400 行文字说明 + 10 几段手工命令 | 盲测发布前自查任务时，**75%（3/4）的报告把明文密钥直接泄漏了出去**；模型经常漏翻 GitHub API 第 2 页和隐私文档；每次触发吃掉 14–19 KB 上下文。 | 客观检查不可靠 |
| **2. 重协议 / 重外壳包装** | 独立运行时 + 哈希回执链 + 严格协议仪式 | 确实堵住了泄密，但引爆了**“黑盒不信任税”**：强模型跑完后反而多花 **5–8 轮（~2.5 万字符）** 去翻脚本源码确认有没有漏扫，小任务也要走 7–11 次协议调用。 | **整套废除** |
| **3. SkillPlumb（薄契约 + `0/1/2` 探针 + 外置路由）** | 1 页 `SKILL.md` + 零依赖透明脚本（返回 JSON + `calibration` 校准计数 + `scopes_skipped`） | 凭据泄漏降到 **0%**；消除不信任税；`SKILL.md` 压缩 **~87%**；真实公开仓实测耗时降 **11%–22%**、工具调用降 **13%–40%**。 | **现役标准** |

### 核心硬数据一览

| 对比维度 | 基线做法 | 接入 SkillPlumb | 实测变化 |
|---|---|---|---|
| **盲测审计凭据明文泄漏** | 75%（`3/4` 泄漏） | **0%** | 工具边界自动区间脱敏 |
| **高频审计类 `SKILL.md` 体积** | 278–380 行 | **37–58 行** | 上下文占用减少 **~87%** |
| **真实公开仓配对实测** *(安全、活库 PG18、CI/CD)* | 1.0x | **耗时 -11% ~ -22%** | **工具调用 -13% ~ -40%** |
| **N=100 离线 Top-1 路由准确率**（40 条查询） | 75.0%（`30/40`，扫 100 个） | **90.0%（`36/40`，扫 8.5 个）** | 真实工具 **18/18**，扫描扇出 **-91.5%** |
| **N=100 真实 LLM 配对实跑** | Step-1 探针遵从 `2/4` | **Step-1 探针遵从 `4/4`** | 首轮输入 Token **-33.9%** / 总输入 **-40.6%** |
| **第三方 `SKILL.md` 侵入修改** | 手工改原文件（升级被覆盖） | **0 字节修改** | `router_overrides.json` 保持 **SHA-256 一致** |

---

## 30 秒先看自己本机的问题（`doctor`）

一条只读命令扫描你本机所有 Skill 目录——**绝不修改任何文件**（零安装直接跑，也可用 `npm i -g skill-plumb` 或在源码仓运行 `node bin/skill-plumb.mjs`）：

```bash
npx skill-plumb doctor
```

自动探测 `./.agents/skills`、`~/.agents/skills`、`~/.claude/skills`（Claude Code）、`~/.codex/skills`（Codex）、`~/.gemini/config/skills`（Antigravity / Gemini）及常见 MCP 配置：

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

## 核心机制：三件事拉开与普通 Linter/路由器的差距

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
                             歧义兜底：拥挤域缺 Not-for 时返回候选清单由 LLM 裁决
                               ▲
                               │  零侵入外置护栏
                     router_overrides.json（永不改写第三方 SKILL.md）
```

1. **绝不把未知当“干净”的 `0 / 1 / 2` 探针契约**：
   - `0` = 检查完整跑完且无异常（仍需核对 `calibration` 与 `findings`）。
   - `1` = CLI 参数错误、目标缺失或软链越界（`realpathSync` 校验）。
   - `2` = 发现阻塞项，**或任何覆盖不全**（如离线 `--offline`、无 git 历史、`>512KB` 超大文件、API 截断）。遇到 `exit 2` 严禁宣称“全部干净”。
2. **零侵入 `router_overrides.json` + 拥挤歧义主动上报**：
   - 第三方插件升级时会覆写全局 `SKILL.md`，因此一律在外部 `router_overrides.json` 中补 `domain`、双语 `aka` 与 `not_for`。
   - `inspect` 基于 `mtimeMs + size` 指纹自动热刷新；打分时自动剥离 `(use sibling)` 并排除自身 slug 词防止兄弟技能自惩罚；Top-2 分差 <20% 且缺 `Not for` 时置位 `ambiguous: true` 交给 LLM 裁决。
3. **AI 自助造轮子 + 6 道门禁验收（`scaffold` + `gate`）**：
   - 不仅人能用，AI Agent 也能直接调 `scaffold` 生成骨架，写完逻辑后自动跑通 `gate`（Frontmatter、篇幅与 `<= 35` 行代码块、断链、本机路径泄露、探针 `--help`/错参退出、`verify_*.mjs` 与路由冒烟）。

---

## 哪些场景不适配（以及为什么）

我们在对照实验里专门验证过“不该用它”的边界，避免把工程门禁硬套在不合适的地方：

| 不适配场景 | 为什么不适配（实验依据与技术原因） | 正确替代方式 |
|---|---|---|
| **纯编码纪律类 Skill** *(如 TDD、调试心法)* | 我们在真实 Python 库 `tomli` 上的 TDD 对照实测证实：强加机械门禁脚本对正确性 **0 增益**（两组隐藏验收均过 `20/20`），反而把小步红绿微循环扭曲成大步粗批次。 | 用 `--mode lite`（精简规则 + `references/`，不加探针脚本）。 |
| **纯创作、文风、人设或审美类 Skill** | 文笔、人设语气、视觉审美没有客观的 `0/1/2` 脚本真值；硬写门禁只会制造形式主义。 | 用 `--mode lite` + 正反例语料库。 |
| **低频、一次性、单仓库自用脚本** | 写探针和 `verify_*.mjs` 有明确的前期开发与维护成本，低频使用摊不平脚本成本，封装成全局 `SKILL.md` 还会污染全局列表。 | 留在项目自己的 `package.json`、`Makefile` 或 `--mode ops` 里。 |
| **技能总共不到 15–20 个且互不重叠** | 扁平注入完全放得下且不会撞车，再加一层 `inspect` 反而多一次 CLI 调度开销。 | 不用开两段式路由；偶尔跑 `doctor` / `gate` 体检即可。 |
| **指望零配置做语义向量 / Embedding 检索** | SkillPlumb 刻意坚持零外部依赖（无向量库、无 API Key），采用词法 + 中文 n-gram + 域先验 + `Not for` 打分。描述含糊又没补 `aka`/`Not for` 时会返回 `ambiguous: true`，不会靠向量硬猜。 | 在 `router_overrides.json` 补齐 `aka` 与 `not_for`，或接入专用 Embedding 路由器。 |
| **无 Node.js `>= 20` 或无本地 Shell 的纯网页沙盒** | 本地探针与 `inspect` 依赖本机执行 Node 命令。 | 在平台提示词或 Project Instructions 中直接内联精简规则。 |
| **把 `exit 0` 当成业务与安全最终背书** | 脚本只能验证机械事实（`.env` 缺键、断链、正则命中密钥），不能替代业务逻辑理解、威胁建模或架构取舍。 | 把探针 JSON 当作事实依据交给 LLM 或人工复核，切勿盲信绿灯。 |

---

## CLI 速查与配置

*(在已克隆源码仓内也可把 `npx skill-plumb` 替换为 `node bin/skill-plumb.mjs`。)*

```bash
# 1. 只读健康体检（表格输出 或 --json）
npx skill-plumb doctor
npx skill-plumb doctor --skills-dir ./skills --no-mcp --json

# 2. 生成新 Skill 骨架（支持 full | lite | ops）
npx skill-plumb scaffold \
  --name env-diff-audit --domain deploy \
  --summary "Audit .env against .env.example drift without secret echo." \
  --use-when "checking .env and .env.example before deploy" \
  --not-for "repo-wide git history secret audits (use pre-publish-audit)" \
  --mode full --out-dir ./.agents/skills

# 3. 执行 6 道黑盒门禁验收
npx skill-plumb gate ./.agents/skills/env-diff-audit

# 4. 两段式路由查询与域浏览
npx skill-plumb brief
npx skill-plumb list deploy
npx skill-plumb inspect "compare .env against .env.example before deploy" --limit 3
npx skill-plumb sync

# 5. 生成跨宿主路由规范插件或 AGENTS.md 片段
npx skill-plumb init-plugin --format plugin --out ./skill-plumb-router
npx skill-plumb init-plugin --format agents-md --out ./AGENTS.md
```

* **外置边界覆盖示例**：[templates/router_overrides.example.json](templates/router_overrides.example.json)
* **自定义领域扩展示例**（在内置 12 个通用软件工程域 `db`、`sec`、`deploy`、`repo`、`eval`、`audit_qa`、`frontend_viz`、`docs_io`、`code_graph`、`web_media`、`meta_collab`、`general` 上扩展）：[templates/domains.example.json](templates/domains.example.json)

---

## 内置示范技能（`examples/`）与测试

`examples/` 下 4 个示范技能全部通过 `skill-plumb gate`、`skill-plumb doctor` 与各自的 `os.tmpdir()` 黑盒回归套件：

| 示范技能 | 所属域 | 核心演示能力 |
|---|---|---|
| [`env-diff-audit`](examples/env-diff-audit/SKILL.md) | `deploy` | 自主脚手架产出的薄契约典范：零明文泄露比对 `.env` 与 `.env.example` |
| [`oss-eval`](examples/oss-eval/SKILL.md) | `eval` | 第三方 GitHub/开源项目尽调（安装钩子、遥测、活跃度）与 `--api-only` 快速初筛 |
| [`pre-publish-audit`](examples/pre-publish-audit/SKILL.md) | `repo` | 开源/提交前自查（含 Git 历史密钥、PII、硬编码路径、Compose 端口与 Markdown 断链） |
| [`skill-creator`](examples/skill-creator/SKILL.md) | `meta_collab` | 串联 `scaffold`、`gate` 与 `doctor` 的薄契约技能生产工作流 |

运行全套跨平台隔离测试（全程仅使用 `os.tmpdir()`，绝不读写 `~/.agents/skills/`）：

```bash
npm test
```

---

## 进阶文档与开源协议

* [基准评测与消融数据报告](docs/benchmarks-summary.md)
* [架构设计与实战避坑清单](docs/architecture.md)
* [MIT License](LICENSE)
