# Changelog

All notable changes to `skill-plumb` will be documented in this file.

## [0.1.0] - 2026-11-27

### Added
- **Zero-dependency CLI (`skill-plumb`)** built strictly on Node.js `>= 20` built-in modules (`doctor`, `scaffold`, `gate`, `inspect`, `brief`, `list`, `sync`, `init-plugin`).
- **Two-stage `O(domain)` + `Not for` + direct-action router (`inspect`)** with SHA-256 source-fingerprinted cache auto-refresh (`sync`), `router_overrides.json` zero-invasion boundaries, and custom `domains.json` presets.
- **6-Gate black-box skill validator (`gate`)** enforcing frontmatter `Use when` / `Not for` boundaries, `<= 150`-line / `9 KB` thin-contract budgets, relative link & `references/*.md` user-path hygiene, deterministic `0/1/2` probe CLI behavior, `verify_*.mjs` isolation execution, and live routing smoke checks (plus opt-in `--check-mirror`).
- **Read-only ecosystem health auditor (`doctor`)** auto-discovering Claude Code (`~/.claude/skills`), Codex (`~/.codex/skills`), Antigravity / Gemini (`~/.gemini/config/skills`), `~/.agents/skills`, `./.agents/skills`, and MCP server configs.
- **Scaffolding & templates (`templates/`)** for `D-Full`, `D-Lite`, `Ops-Only`, `probe_*.mjs`, `verify_*.mjs`, and portable host plugins (`init-plugin`).
- **4 verified showcase skills (`examples/`)**: `env-diff-audit`, `oss-eval`, `pre-publish-audit`, and `skill-creator`, plus isolated cross-platform tests in `tests/` (`os.tmpdir()` only).
