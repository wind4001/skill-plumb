# Skill Creator Reference Guide

## 1. Choosing the Right Mode

| Mode | Generated Files | Best For |
|---|---|---|
| `full` | `SKILL.md` + `scripts/probe_*.mjs` + `verify_*.mjs` + `references/guide.md` | High-entropy workflows (files, CLI checks, env/config/dependency/security audits) |
| `lite` | `SKILL.md` + `references/guide.md` | Pure judgment disciplines, coding guidelines, review rubrics (no fake probe scripts) |
| `ops` | `scripts/probe_*.mjs` + `verify_*.mjs` | Single-repo operational scripts without a reusable skill contract |

## 2. Verification Tiers

- **Tier 1 (typo / copy / small contract fix)**: Run `skill-plumb gate <skill_dir>` and any affected single assertion.
- **Tier 2 (limited behavior change / 1–2 edge cases)**: Add fixture coverage in `verify_*.mjs`, run `skill-plumb gate`, and review diff.
- **Tier 3 (new skill / major script refactor / new routing domain)**: Full `verify_*.mjs` + `skill-plumb gate` + `skill-plumb doctor` + `skill-plumb inspect` smoke queries across sibling tools.

## 3. Safe Editing Discipline for Existing Skills

1. Before editing an existing user-owned skill, snapshot its files (e.g., SHA-256 checksums or a clean backup copy outside the skill directory).
2. Never modify third-party or auto-synced skills directly in place if an external `router_overrides.json` entry can supply `domain`, `aka`, or `not_for`.
3. Keep `SKILL.md` under 150 lines / 9,000 bytes and avoid inline code blocks longer than 35 lines.
