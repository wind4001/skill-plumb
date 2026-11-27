<div align="center">

# SkillPlumb

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/wind4001/skill-plumb/actions/workflows/ci.yml/badge.svg)](https://github.com/wind4001/skill-plumb/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/skill-plumb.svg)](https://www.npmjs.com/package/skill-plumb)
![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-339933)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

</div>

**Stop writing 300-line `SKILL.md` essays hoping your coding agent obeys every step.**

Most `SKILL.md` files today mix fragile bash snippets, prose reminders ("remember not to print secrets", "check page 2 of the API"), and domain rules into one bloated Markdown file. Once you install 50–100+ of them, your agent gets slower, burns thousands of extra tokens per turn, misfires heavy workflows on *"fix a typo"*, and wipes out your manual `SKILL.md` tweaks on every plugin update.

**SkillPlumb** is a zero-dependency Node.js (`>= 20`) CLI built to fix that architecture from the ground up:
- **Shrink `SKILL.md` to a 1-page judgment contract** (`<= 150` lines) while moving repeatable environment checks into **zero-dependency `0/1/2` Node probes** that never silently hide gaps.
- **Route 50–100+ skills in two stages (`inspect`)** — cutting scanned candidates by ~91% and returning `NONE` on trivial local edits.
- **Fix third-party skill collisions without editing upstream files** via external `router_overrides.json` (SHA-256 byte-identical preservation).
- **Audit, scaffold, and black-box gate (`doctor`, `scaffold`, `gate`)** every skill across Claude Code, Codex, Antigravity, Gemini CLI, and `.agents/skills`.

---

## Why We Built This (What We Tried & Killed)

SkillPlumb did not start as "yet another skill linter". It came out of testing three competing architectures in blind paired evaluations ([full benchmark report](docs/benchmarks-summary.md)):

| Generation | How It Worked | What Happened in Real Benchmarks | Verdict |
|---|---|---|---|
| **1. Traditional Long Prose `SKILL.md`** | 250–400 lines of instructions + inline bash/grep/python snippets | **75% (3/4) of blind pre-publish runs leaked raw secrets** into reports; agents missed API page-2 pagination & privacy docs; burned 14–19 KB per trigger. | Fails on objective checks |
| **2. Heavy Custom Protocol / Wrapper** | Custom runtime wrapping every step with hash receipts & strict CLI ceremony | Enforced redaction, but triggered a **"black-box distrust tax"**: strong models spent **5–8 extra turns (~25k chars)** reading the wrapper's source code to verify coverage, plus 7–11 extra calls on small tasks. | **Killed** |
| **3. SkillPlumb (Thin Contract + `0/1/2` Probes + External Router)** | 1-page `SKILL.md` + transparent local scripts emitting JSON + `calibration` counts + `scopes_skipped` | Secret leaks dropped to **0%**; distrust tax vanished; `SKILL.md` shrunk **~87%**; wall time dropped **11%–22%** & tool calls **13%–40%** across public-repo benchmarks. | **Production architecture** |

### Hard Numbers at a Glance

| Benchmark | Baseline | With SkillPlumb | Impact |
|---|---:|---:|---|
| **Credential leakage in blind audit** | 75% (`3/4` leaked) | **0%** | Eliminated via tool-boundary redaction |
| **`SKILL.md` size on real audit skills** | 278–380 lines | **37–58 lines** | **~87% smaller** context footprint |
| **Public-repo paired benchmarks** *(security, live PG18, CI/CD)* | 1.0x | **-11% to -22% wall time** | **-13% to -40% tool calls** |
| **N=100 Offline Top-1 Routing** *(40 queries)* | 75.0% (`30/40`, scan 100) | **90.0% (`36/40`, scan 8.5)** | **18/18** real tools, **-91.5%** scan fan-out |
| **N=100 Live LLM Paired Runs** | `2/4` Step-1 compliance | **`4/4` Step-1 compliance** | **-33.9%** turn-1 input / **-40.6%** total input tokens |
| **Third-party `SKILL.md` edits needed** | Manual patches lost on update | **0 bytes touched** | **SHA-256 identical** via `router_overrides.json` |

---

## Try It in 30 Seconds (`doctor`)

Scan every installed skill folder on your machine in one read-only command — **zero files modified** (zero-install via `npx`, or install globally with `npm i -g skill-plumb`):

```bash
npx skill-plumb doctor
```

Auto-discovers `./.agents/skills`, `~/.agents/skills`, `~/.claude/skills` (Claude Code), `~/.codex/skills` (Codex), and `~/.gemini/config/skills` (Antigravity / Gemini), plus MCP configs:

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

## The 3 Design Bets That Make It Work

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

1. **Honest `0 / 1 / 2` Probes (No Silent False Negatives)**:
   - `0` = check completed cleanly (still inspect `findings` / `calibration` — `0` means coverage finished, not "rubber-stamp safe").
   - `1` = bad CLI flags, missing target, or symlink escape (`realpathSync` containment).
   - `2` = verified findings **or incomplete coverage** (`scopes_skipped`, offline API, oversized files). Agents are forbidden from reporting "clean" on `exit 2`.
2. **Zero-Invasion `router_overrides.json` + Ambiguity Escalation**:
   - Plugin managers overwrite upstream `SKILL.md` files on upgrade. Keep custom `domain`, bilingual `aka` aliases, and `not_for` exclusions externally in `router_overrides.json`.
   - `inspect` auto-refreshes via `mtimeMs + size` SHA-256 fingerprint, strips `(use sibling)` hints and self-slug tokens so siblings never self-penalize, and emits `ambiguous: true` when two crowded candidates tie within 20% and lack `Not for`.
3. **Self-Service Authoring + 6-Gate Acceptance (`scaffold` + `gate`)**:
   - Coding agents can scaffold a new skill (`full`, `lite`, or `ops`), write domain checks, and validate frontmatter, line/byte budgets, relative links, probe `--help`/bad-flag behavior, `verify_*.mjs`, and self-routing before shipping.

---

## Where This Does NOT Fit — And Why

We explicitly tested where deterministic probes and two-stage routing **fail to help** so you don't force them onto the wrong work:

| Case That Doesn't Fit | Why (Evidence & Technical Reason) | What to Do Instead |
|---|---|---|
| **Pure coding-discipline skills** *(e.g., TDD, debugging habits)* | In our paired real-repo TDD experiment (`tomli`), adding a mechanical script gate produced **0% correctness gain** (`20/20` hidden tests passed in both arms) and distorted small red-green cycles into coarse batches. | Use `--mode lite` (concise prose + `references/`, zero probe scripts). |
| **Creative, writing, persona, or aesthetic skills** *(fiction, copy tone, UI taste)* | No deterministic `0/1/2` script can score prose voice or visual taste; forcing probe scripts creates fake busywork. | Use `--mode lite` + curated good/bad examples in `references/`. |
| **One-off, single-repo scripts** | Deterministic probes + `verify_*.mjs` carry upfront authoring and maintenance cost. If reuse doesn't amortize it, a global `SKILL.md` only clutters your registry. | Keep it in `package.json`, `Makefile`, or `--mode ops` inside that repo. |
| **Small skill collections (< 15–20 non-overlapping skills)** | Flat prompt exposure already fits cleanly in context; adding a CLI `inspect` hop adds latency without meaningful token savings. | Skip `inspect`; use `doctor` / `gate` selectively if you want lint checks. |
| **Expecting zero-config embedding / semantic search** | SkillPlumb deliberately uses zero-dependency lexical + CJK n-gram + domain prior + `Not for` scoring (no API keys, no vector DBs). Vague overlapping skills without `aka` or `Not for` return `ambiguous: true` instead of guessing semantically. | Add `aka` / `not_for` in `router_overrides.json`, or use an embedding router for fuzzy retrieval. |
| **Web-only chat UIs or sandboxes without Node `>= 20` / shell** | Probes and `inspect` require local Node.js execution (`>= 20`). | Inline concise rules directly in your chat/project instructions. |
| **Treating `exit 0` as human/security sign-off** | Scripts verify mechanical facts (missing env keys, broken links, regex patterns), not business logic, threat models, or architectural trade-offs. | Treat probe JSON as grounded evidence for LLM/human review, never a rubber stamp. |

---

## CLI Quick Reference

*(From a cloned repository, you can replace `npx skill-plumb` with `node bin/skill-plumb.mjs`.)*

```bash
# 1. Read-only ecosystem audit (human table or --json)
npx skill-plumb doctor
npx skill-plumb doctor --skills-dir ./skills --no-mcp --json

# 2. Scaffold a skill (modes: full | lite | ops)
npx skill-plumb scaffold \
  --name env-diff-audit --domain deploy \
  --summary "Audit .env against .env.example drift without secret echo." \
  --use-when "checking .env and .env.example before deploy" \
  --not-for "repo-wide git history secret audits (use pre-publish-audit)" \
  --mode full --out-dir ./.agents/skills

# 3. Validate all 6 gates on a skill directory
npx skill-plumb gate ./.agents/skills/env-diff-audit

# 4. Route queries & inspect domains
npx skill-plumb brief
npx skill-plumb list deploy
npx skill-plumb inspect "compare .env against .env.example before deploy" --limit 3
npx skill-plumb sync

# 5. Generate a portable routing-rule plugin or AGENTS.md snippet
npx skill-plumb init-plugin --format plugin --out ./skill-plumb-router
npx skill-plumb init-plugin --format agents-md --out ./AGENTS.md
```

* **Customize routing boundaries**: [templates/router_overrides.example.json](templates/router_overrides.example.json)
* **Add custom domains** (extends the 12 built-in domains `db`, `sec`, `deploy`, `repo`, `eval`, `audit_qa`, `frontend_viz`, `docs_io`, `code_graph`, `web_media`, `meta_collab`, `general`): [templates/domains.example.json](templates/domains.example.json)

---

## Showcase Skills (`examples/`) & Tests

Every example passes `skill-plumb gate`, `skill-plumb doctor`, and its own isolated `os.tmpdir()` black-box suite:

| Example | Domain | What It Demonstrates |
|---|---|---|
| [`env-diff-audit`](examples/env-diff-audit/SKILL.md) | `deploy` | Autonomously scaffolded D-Full skill comparing `.env` vs `.env.example` with zero plaintext secret echo |
| [`oss-eval`](examples/oss-eval/SKILL.md) | `eval` | Third-party GitHub/OSS vetting (install hooks, telemetry, activity) with `--api-only` fast triage |
| [`pre-publish-audit`](examples/pre-publish-audit/SKILL.md) | `repo` | Pre-release scanner for secrets (incl. git history), PII, hardcoded paths, ports, and Markdown links |
| [`skill-creator`](examples/skill-creator/SKILL.md) | `meta_collab` | Thin D-Full authoring workflow calling `scaffold`, `gate`, and `doctor` |

Run the full isolated test suite (`os.tmpdir()` only — never reads or mutates `~/.agents/skills/`):

```bash
npm test
```

---

## Documentation & License

* [Benchmark Summary & Ablations](docs/benchmarks-summary.md)
* [Architecture & Production Lessons](docs/architecture.md)
* [MIT License](LICENSE)
