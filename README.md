<div align="center">

# SkillPlumb

**Make Agent Skills plumb: Thin Contracts, `0/1/2` Deterministic Probes, Black-Box Gating & Zero-Invasion Two-Stage Routing.**

*Stop watching your coding agent get slower, pricier, and sloppier after skill #50.*

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/wind4001/skill-plumb/actions/workflows/ci.yml/badge.svg)](https://github.com/wind4001/skill-plumb/actions/workflows/ci.yml)
![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-339933)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

</div>

---

## The "50-Skill Cliff" (And Why Your Agent Degrades)

Installing 5 agent skills feels like magic. Installing 50–100+ skills turns into a tax on every single prompt:

1. **Prompt Bloat Inside `SKILL.md`**: Skills balloon into 300-line prose essays. Agents skim past Step 1, skip verification checks, and hallucinate "all checks passed".
2. **Flat Registry Collision**: Dumping 50–100+ skill descriptions flat into every system prompt bloats turn-1 input tokens, degrades signal-to-noise ratio, and causes trivial tasks (*"fix a typo in README.md"*) to misfire heavyweight workflows.
3. **Hostile Plugin Overwrites**: Manually editing an installed third-party `SKILL.md` to add missing routing boundaries (`Not for`) gets wiped out on the next plugin update.

**SkillPlumb** turns `SKILL.md` engineering into deterministic, zero-dependency Node.js (`>= 20`) plumbing.

---

## Measured Proof (Controlled N=100 Benchmarks)

All metrics below come from reproducible controlled evaluations before open-source extraction ([full benchmark report](docs/benchmarks-summary.md)):

| Metric | Flat N=100 Baseline | SkillPlumb Two-Stage | Delta |
|---|---:|---:|---|
| **Offline Top-1 Routing Accuracy** (40 queries) | 75.0% (`30/40`) | **90.0% (`36/40`)** | **+15.0 pts** (`18/18` real tools) |
| **Candidates Scanned per Query** | 100.0 | **8.5** | **-91.5% scan fan-out** |
| **Step-1 Deterministic Probe Compliance** (Live LLM) | `2/4` | **`4/4`** | **100% protocol compliance** |
| **Avg First-Turn Input Tokens** (Live LLM) | 18,294.8 | **12,099.3** | **-33.9% input tokens** |
| **Total Input Tokens / Wall Time** (4 paired runs) | 172,735 / 129.8s | **102,657 / 102.5s** | **-40.6% tokens / -21.0% latency** |
| **Third-Party `SKILL.md` Mutation** | Often patched manually | **0 bytes changed** | **SHA-256 byte-identical** |

---

## 30-Second Test Drive (`doctor`)

Audit every skill folder on your machine in one read-only command — **zero files modified**:

```bash
# Run directly from a local clone (or `npx skill-plumb doctor` once published)
node bin/skill-plumb.mjs doctor
```

Example output on a messy multi-skill setup:

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

## Before vs. After

| Dimension | Typical 50+ Skill Setup | With SkillPlumb |
|---|---|---|
| **`SKILL.md` structure** | 200–400 lines of prose & inline scripts | **Thin behavioral contract** (`<= 150` lines, `<= 9 KB`, refs on demand) |
| **Verification checks** | LLM "eyeballs" files & guesses pass | **`0 / 1 / 2` deterministic probes** (`0` clean, `1` error, `2` findings/gaps) |
| **Skill routing** | Flat N-way prompt dump every turn | **Two-stage `O(domain)`** shortlist + `Not for` penalty + `NONE` guard |
| **Trivial edits (`fix typo`)** | Often triggers heavy review workflows | **Direct-action guard** returns `NONE` (zero skill overhead) |
| **Third-party skill fixes** | Edit `SKILL.md` → overwritten on update | **Zero-invasion `router_overrides.json`** + SHA-256 safe |
| **Runtime dependencies** | Python + Node + YAML + vector DBs | **Zero external dependencies** (pure Node.js `>= 20` built-ins) |

---

## Works Out of the Box With Your Agent Hosts

`skill-plumb` automatically probes common skill and MCP locations (or accepts explicit `--skills-dir` / `--mcp-cfg` / `--no-mcp` flags):

| Host / Standard | Auto-Discovered Skill Root | Notes |
|---|---|---|
| **Workspace-local** | `./.agents/skills` | Highest precedence for project-scoped skills |
| **Shared global** | `~/.agents/skills` | Deduplicated by `realpathSync` & skill name |
| **Claude Code** | `~/.claude/skills` | Also probes `~/.config/claude/mcp_config.json` & `~/.claude.json` |
| **Codex CLI** | `~/.codex/skills` | Cross-platform Windows / macOS / Linux |
| **Antigravity / Gemini** | `~/.gemini/config/skills` | Also probes `~/.gemini/config/mcp_config.json` |

---

## How SkillPlumb Works

```text
  [Author / AI]
       │
       ▼
  skill-plumb scaffold  ──►  Thin SKILL.md (Use when / Not for + <skill_dir> probe call)
       │                     scripts/probe_*.mjs  (0 = clean, 1 = error, 2 = findings/gaps)
       │                     verify_*.mjs         (isolated os.tmpdir() black-box tests)
       ▼
  skill-plumb gate      ──►  6-Gate Validator: frontmatter, thinness, relative links,
                             CLI --help/bad-flag exits, verify suite, routing smoke test
       │
       ▼
  skill-plumb inspect   ──►  Stage 1: Direct-action NONE guard + O(domain) shortlist
  (Auto-sync via hash)       Stage 2: Positive (id/aka/use_when) - Not-for penalty
                             Ambiguity fallback: Flags crowded candidates for LLM choice
                               ▲
                               │  Zero-invasion external guardrails
                     router_overrides.json  (never modifies upstream SKILL.md)
```

### Four Core Pillars

1. **Thin Behavioral Contracts (`SKILL.md`)**: Keep `SKILL.md` under `150` lines and `9,000` bytes with explicit `Use when` and `Not for` clauses. Move deep docs to `references/` and deterministic checks to `scripts/`.
2. **`0 / 1 / 2` Deterministic Probe Contract**: Probes never fail silently or equate skipped checks with zero findings:
   - `0` = clean / ready
   - `1` = invalid CLI args, missing target, or symlink escape (`realpathSync` containment)
   - `2` = verified findings or incomplete coverage (`scopes_skipped` / `skipped` reported explicitly)
3. **6-Gate Black-Box Acceptance (`gate`)**: Automates contract hygiene before any skill ships — including catching bloated code blocks (`> 35` lines), broken relative links, hardcoded user-home paths, missing `verify_*.mjs`, and self-routing failures.
4. **Zero-Invasion Two-Stage Routing (`inspect`)**: Uses `mtimeMs + size` SHA-256 fingerprinting so edits to `SKILL.md` or `router_overrides.json` auto-refresh without manual `sync`. Strips `(use sibling-skill)` cross-references and excludes self-slug tokens from `not_for` penalties so sibling skills never self-penalize.

---

## CLI Cookbook

```bash
# 1. Read-only ecosystem health check (human-readable table or --json)
node bin/skill-plumb.mjs doctor
node bin/skill-plumb.mjs doctor --skills-dir ./skills --no-mcp --json

# 2. Scaffold a new thin skill (modes: full | lite | ops)
node bin/skill-plumb.mjs scaffold \
  --name env-diff-audit \
  --domain deploy \
  --summary "Audit .env against .env.example drift without secret echo." \
  --use-when "checking .env and .env.example before deploy" \
  --not-for "repo-wide git history secret audits (use pre-publish-audit)" \
  --mode full \
  --out-dir ./.agents/skills

# 3. Run all 6 acceptance gates on a skill directory
node bin/skill-plumb.mjs gate ./.agents/skills/env-diff-audit

# 4. Two-stage routing inspection & domain browsing
node bin/skill-plumb.mjs brief
node bin/skill-plumb.mjs list deploy
node bin/skill-plumb.mjs inspect "compare .env against .env.example before deploy" --limit 3
node bin/skill-plumb.mjs sync

# 5. Generate a portable routing-rule plugin or AGENTS.md snippet
node bin/skill-plumb.mjs init-plugin --format plugin --out ./skill-plumb-router
node bin/skill-plumb.mjs init-plugin --format agents-md --out ./AGENTS.md
```

### Zero-Invasion `router_overrides.json` & Custom `domains.json`

Override domain classification, add bilingual `aka` aliases, and inject `not_for` exclusions for third-party skills without modifying their `SKILL.md` (see [templates/router_overrides.example.json](templates/router_overrides.example.json)):

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

SkillPlumb ships with 12 general software-engineering domains (`db`, `sec`, `deploy`, `repo`, `eval`, `audit_qa`, `frontend_viz`, `docs_io`, `code_graph`, `web_media`, `meta_collab`, `general`). Extend or override them anytime via `./domains.json`, `./.skill-plumb.json`, or `--domains <file>` (see [templates/domains.example.json](templates/domains.example.json)).

---

## Included Showcase Skills (`examples/`)

Every example skill passes `skill-plumb gate`, `skill-plumb doctor`, and its own isolated `os.tmpdir()` black-box verification suite:

| Example | Domain | What It Demonstrates |
|---|---|---|
| [`env-diff-audit`](examples/env-diff-audit/SKILL.md) | `deploy` | Autonomously scaffolded D-Full skill comparing `.env` vs `.env.example` with zero plaintext secret echo |
| [`oss-eval`](examples/oss-eval/SKILL.md) | `eval` | Third-party GitHub/OSS vetting (install hooks, telemetry, activity) with `--api-only` fast triage |
| [`pre-publish-audit`](examples/pre-publish-audit/SKILL.md) | `repo` | Pre-release scanner for secrets (incl. git history), PII, hardcoded paths, ports, and Markdown links |
| [`skill-creator`](examples/skill-creator/SKILL.md) | `meta_collab` | Thin D-Full authoring skill orchestrating `scaffold`, `gate`, and `doctor` |

Run the entire isolated test suite (`os.tmpdir()` only — never reads or modifies `~/.agents/skills/`):

```bash
npm test
```

---

## Documentation & License

* [Benchmark Evidence & Ablations](docs/benchmarks-summary.md) — N=100 offline routing, live LLM A/B metrics, and self-service authoring sandbox results
* [Architecture & Production Lessons](docs/architecture.md) — 0/1/2 probe specification, routing math, Windows Node `.cmd` `EINVAL` & PowerShell 5.1 hardening
* [MIT License](LICENSE)
