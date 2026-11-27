---
name: skill-creator
x-domain: meta_collab
description: >-
  Creates, refactors, and gates reusable Agent Skills (SKILL.md) with thin behavioral
  contracts, zero-dependency 0/1/2 probes, verify_*.mjs black-box suites, and
  two-stage routing hygiene. Use when building a new skill, refactoring an existing
  skill to thin contracts, or validating skill readiness before release. Not for
  read-only audits of third-party OSS repos (use oss-eval), repository secret/link
  pre-publish checks (use pre-publish-audit), or .env drift checks (use env-diff-audit).
---

# Skill Creator

Author or upgrade reusable skills with `skill-plumb`, starting at the earliest unfinished stage and verifying consumer behavior before claiming completion.

## Step 1: Probe Readiness & Existing Owners

```bash
node <skill_dir>/scripts/probe_d_factory.mjs "<target_dir>"
```

| Exit Code | `exit_meaning` | Next Action |
|---:|---|---|
| `0` | `skill_plumb_ready` | Inspect `cli_path` and existing `target_has_skill_md`, then scaffold or gate |
| `1` | CLI error or missing target | Fix arguments or target path and rerun |
| `2` | `skill_plumb_missing` | Install or pass `--cli <path-to-skill-plumb>` before scaffolding |

## Step 2: Scaffold, Author, and Gate

Use the `cli_path` returned in Step 1 (`node "<cli_path>" ...`, or `npx --yes skill-plumb` when installed globally):

1. Check domain neighbors and generate a clean skeleton (`full`, `lite`, or `ops`):
   ```bash
   node "<cli_path>" scaffold --name <slug> --domain <domain> --summary "<desc>" --mode full --not-for "<exclusions>"
   ```
2. Keep `SKILL.md` under 150 lines / 9 KB and place deep schemas or recipes in `references/guide.md`.
3. Validate all 6 structural, probe, verification, and routing gates:
   ```bash
   node "<cli_path>" gate "<skill_dir>"
   node "<cli_path>" doctor
   ```

Detailed mode selection, verification tiers, and backup checklist: [references/guide.md](references/guide.md)
