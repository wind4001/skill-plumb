# SkillPlumb Architecture & Engineering Lessons

SkillPlumb separates agent workflows into **deterministic zero-dependency scripts** and **thin LLM behavioral contracts** (`SKILL.md`), governed by an external zero-invasion router.

---

## 1. Thin Behavioral Contracts (`SKILL.md`)

A `SKILL.md` file is a contract, not a tutorial:
- **Frontmatter (`name`, `x-domain`, `description`)**:
  - `Use when`: positive triggering criteria.
  - `Not for`: explicit negative exclusions separating sibling skills in the same domain.
- **Line & Byte Budgets**: `<= 150` lines, `<= 9,000` bytes, and no inline fenced code blocks `> 35` lines. Deep guides, schemas, and examples live in `references/*.md` for on-demand loading.
- **Portability**: Contracts reference `<skill_dir>/scripts/probe_*.mjs` rather than developer-specific absolute filesystem paths.

---

## 2. Deterministic 0 / 1 / 2 Probe Contract

Objective checks (environment validation, secret/PII scanning, `.env` drift, link integrity, dependency audits) belong in zero-dependency Node (`>= 20`) scripts under `scripts/probe_*.mjs` or `scripts/audit_*.mjs`.

| Exit Code | Meaning | Required Agent Behavior |
|---:|---|---|
| `0` | Clean / Ready | Proceed using structured JSON output (`--out` or stdout) |
| `1` | CLI error / missing target / symlink escape | Fix inputs and rerun; never guess past errors |
| `2` | Verified findings or incomplete coverage | Report concrete findings or `scopes_skipped` / `skipped` honestly; never treat skipped checks as zero issues |

All probes must enforce:
- `fs.realpathSync` containment checks (`isWithinRoot`) to reject symlink escapes.
- Strict CLI flag validation (`--help`, reject unknown flags with exit `1`).
- Zero plaintext credential echo (only key names, line numbers, and `[REDACTED]` markers).

---

## 3. Black-Box Gating (`skill-plumb gate`)

`skill-plumb gate <skill_dir>` runs 6 automated checks:
1. **Frontmatter Boundary**: valid YAML frontmatter, `name`, `Use when`, and non-empty `Not for`.
2. **Thinness**: line count, byte size, and max inline code fence length.
3. **Links & Path Hygiene**: all local Markdown links resolve inside `<skill_dir>` with zero hardcoded user-home paths.
4. **Probes & Regression Suite**: every `scripts/probe_*.mjs`, `scripts/preflight_*.mjs`, `scripts/eval_all.mjs`, or `scripts/audit_all.mjs` exits `0` on `--help` and `1` on unknown flags; every `verify_*.mjs` suite passes in an isolated `os.tmpdir()`.
5. **Routing Smoke Check**: verifies the skill matches its own name/trigger when placed in the live catalog.
6. **Optional Mirror Parity**: opt-in via `--check-mirror <dir>` to verify mirror symlink parity against `<skill_dir>`.

---

## 4. Zero-Invasion Two-Stage Routing

1. **Stage 1 — Direct-Action Guard + Domain Shortlist (`O(domains)`)**:
   - Trivial single-file edits, typo fixes, and simple `git status`/`npm test` commands return `predicted: "NONE"` (`direct_no_tool: true`) with zero skill overhead.
   - Otherwise, queries score against ~12 configurable domain clusters (`DEFAULT_DOMAINS` + optional `domains.json` / `.skill-plumb.json`) and scan only the top 1–3 matching domains.
2. **Stage 2 — Positive Match minus `Not-For` Penalty**:
   - Combines `id`, `aka` aliases, and `use_when` overlap, then subtracts `not_for` overlap (while stripping parenthetical sibling references like `(use sibling-skill)` and excluding the skill's own slug tokens to avoid self-penalties).
   - If two top candidates score within 20% and either lacks `not_for`, `inspect` sets `ambiguous: true` and `recommended_action: "llm_disambiguate_top_candidates"`.
3. **Source-Fingerprinted Auto-Sync**:
   - `brief`, `list`, and `inspect` compute a SHA-256 fingerprint over `SKILL.md` (`mtimeMs + size`), MCP config, `router_overrides.json`, and `domains.json`, automatically refreshing the cache whenever anything changes.

---

## 5. Production Lessons Preserved in `v0.1.0`

1. **Windows Node `.cmd`/`.bat` `EINVAL` Trap**: On Windows (especially Node 24+), invoking `.cmd` / `.bat` shims directly via `execFileSync` throws `EINVAL`. Use `execSafe()` (`src/discovery.mjs`) which wraps `.cmd`/`.bat` invocations through `cmd.exe /d /s /c`.
2. **Non-Array `not_for` Trap in `router_overrides.json`**: A single string `"not_for": "..."` previously got silently ignored by `Array.isArray(...)`. `src/overrides.mjs` emits explicit `override_warnings` (surfaced by `doctor` and `sync`) and coerces non-empty strings so rules never vanish silently.
3. **Third-Party Auto-Resurrecting Skills**: Plugin managers overwrite global `SKILL.md` files on upgrade. Never patch third-party `SKILL.md` files directly — keep custom `domain`, `aka`, and `not_for` guards in `router_overrides.json`.
4. **Bilingual & Sibling Brand-Token Self-Penalty**: Pure English skills can lose to bilingual siblings unless `aka` aliases are added, and citing a sibling skill like `(use codex-collab)` in `not_for` can penalize the skill itself on `codex`. Stage 2 strips `(use ...)` hints and excludes the candidate's own slug tokens from `not_for` scoring.
5. **Large Repo `--api-only` Mode**: In `examples/oss-eval`, huge repositories support `--api-only` / `--no-clone`, returning exit `2` with explicit `scopes_skipped` instead of forcing multi-GB clones.
6. **Windows PowerShell 5.1 Compatibility**: Cross-platform docs and scripts avoid `&&` chaining (unsupported in PS 5.1) and avoid bare `curl` (which aliases `Invoke-WebRequest`), preferring Node built-ins or `curl.exe`.
