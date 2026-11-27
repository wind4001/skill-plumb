# Benchmark Summary

All numbers below come from reproducible controlled evaluations run prior to extracting this standalone open-source repository.

---

## 1. Two-Stage Routing vs. Flat Prompt Exposure (Offline N=100 Ablation)

**Arm Legend**:
- `R0` / `R1`: Flat prompt exposure baseline (scans every entry blindly at N=46 and N=100, with no domain shortlist, no `Not for` penalty, and no direct-action guard).
- `R2`: SkillPlumb two-stage `O(domain)` router with `Not for` negative penalties and direct-action `NONE` abstention.
- `Arm F` / `Arm R`: Live paired LLM subagent runs comparing flat 100-skill prompt exposure (`Arm F`) against two-stage routing (`Arm R`).

**Setup**: Scaled a real 46-entry skill/MCP catalog to **100 entries** by adding 54 closely competing neighbor skills across domains, evaluated on **40 queries** (`18` real installed-tool intents, `14` congested N=100 neighbor intents, and `8` trivial direct-action tasks that should NOT invoke any skill, expecting `NONE`).

### Scale Effect on Identical 26-Query Baseline (`real_46` + `direct_none`)

| Arm | Catalog Size | Top-1 Accuracy | Avg Candidates Scanned | `real_46` (18) | `direct_none` (8) |
|---|---:|---:|---:|---:|---:|
| `R0_flat_46_real_subset` | 46 | 61.5% (16/26) | 46.0 | 88.9% (16/18) | 0.0% (0/8) |
| `R1_flat_100_same_26_subset` | 100 | 61.5% (16/26) | 100.0 | 88.9% (16/18) | 0.0% (0/8) |
| **`R2_cap_100_same_26_subset`** | **100** | **84.6% (22/26)** | **8.9** | **100.0% (18/18)** | **50.0% (4/8)** |

### Full 40-Query Component Ablation at N=100

| Arm | Top-1 Accuracy | Avg Scanned | `real_46` (18) | `n100_neighbor` (14) | `direct_none` (8) |
|---|---:|---:|---:|---:|---:|
| `R1_flat_100_all40` (flat baseline) | 75.0% (30/40) | 100.0 | 88.9% (16/18) | 100.0% (14/14) | 0.0% (0/8) |
| `R2_ablation_no_notfor_no_guard_100_all40` | 77.5% (31/40) | 9.2 | 94.4% (17/18) | 100.0% (14/14) | 0.0% (0/8) |
| `R2_ablation_no_guard_with_notfor_100_all40` | 80.0% (32/40) | 9.2 | 100.0% (18/18) | 100.0% (14/14) | 0.0% (0/8) |
| **`R2_cap_twostage_100_all40` (full)** | **90.0% (36/40)** | **8.5** | **100.0% (18/18)** | **100.0% (14/14)** | **50.0% (4/8)** |

**Takeaway**: Domain pre-filtering drops per-query scan fan-out by ~91% (`100 → 8.5`), `Not for` negative penalties eliminate all cross-skill misroutes on real tools (`16/18 → 18/18`), and the direct-action guard stops half of trivial tasks from over-firing tools while still leaving room for stricter abstention rules.

---

## 2. Live End-to-End LLM A/B Evaluation at N=100 (4 Paired Tasks)

**Setup**: Identical subagent tasks executed against a 100-skill registry in two arms:
* **Arm F (`F_flat_100`)**: Flat 100-entry skill list exposed upfront.
* **Arm R (`R_cap_twostage`)**: Two-stage brief + `inspect` routing.

| Metric | Arm F (Flat N=100) | Arm R (Two-Stage) | Delta |
|---|---:|---:|---|
| Runs completed | 4 | 4 | — |
| Target skill / direct-edit choice accuracy | 4/4 | 4/4 | — |
| **Step-1 deterministic probe protocol compliance** | **2/4** | **4/4** | **+2/4** |
| Avg first-turn input tokens | 18,294.8 | **12,099.3** | **-33.9%** |
| Sum total input tokens (4 runs) | 172,735 | **102,657** | **-40.6%** |
| Sum cache-read tokens (4 runs) | 407,144 | **305,095** | **-25.1%** |
| Sum output tokens (4 runs) | 22,596 | **18,961** | **-16.1%** |
| Avg task latency | 129.8s | **102.5s** | **-21.0%** |

---

## 3. End-to-End Self-Service Authoring & Zero-Invasion Override Sandbox Test

**Setup**: An isolated authoring subagent was given only a natural-language specification for a new skill (`env-diff-audit`) and instructed to use `skill-creator` + `skill-plumb scaffold` + `skill-plumb gate`. A separate isolated router tested dropping in an overlapping third-party skill missing both domain metadata and `Not for`, followed by a `router_overrides.json` hot-fix.

* **Result**: **13/13** automated black-box checks passed.
* **Autonomous Authoring**: Generated `SKILL.md` (`30` lines, `2,192` bytes) + deterministic probe + verification suite in 22 planner turns (`337s`); passed `skill-plumb gate` and independent hidden `.env` vs `.env.example` fixtures (`0` clean, `1` error, `2` drift/placeholders) with **zero plaintext secret leakage**.
* **Zero-Manual-Sync & Disambiguation**: Dropping in an overlapping third-party skill triggered `auto_synced: true` without running `sync`, flagged `crowded_missing_not_for` (`exit 2`), and emitted `ambiguous: true` + `recommended_action: "llm_disambiguate_top_candidates"` on an overlapping query (`13.75` vs `13.31`).
* **Zero-Invasion Resolution**: Adding `not_for` + `aka` entries in `router_overrides.json` widened the score separation (`13.75` vs `7.92`, flipping `ambiguous` and `missing_not_for_warning` to `false`), cleanly routed all 3 sibling `deploy` skills to their respective intents, returned `sync exit 0` (`missing_not_for_count: 0`), and kept the third-party `SKILL.md` **SHA-256 byte-identical**.

---

## 4. Why Thin Contracts + Deterministic Probes Beat Both Long Prose and Heavy Wrappers

Prior to building the CLI package, three generations of agent skill designs were tested in controlled paired evaluations across security audits, live database tuning, CI/CD configuration, and a 6,418-file TypeScript monorepo:

1. **Prose vs. Tool-Boundary Secret Redaction**:
   - In paired blind runs on a pre-publish audit task, traditional long-prose `SKILL.md` prompts leaked raw credentials into **75% (3/4)** of final reports despite explicit prose warnings.
   - Moving scanning and redaction into deterministic zero-dependency scripts dropped raw credential leakage to **0%**.
2. **Eliminating the "Black-Box Distrust Tax"**:
   - An earlier heavy wrapper protocol enforced redaction, but caused strong models to spend **5–8 extra turns (~25,000 characters)** inspecting the wrapper's source code because they could not verify coverage scope, alongside a **7–11 command ceremony tax** on small tasks.
   - Switching to transparent zero-dependency probes that emit explicit `calibration` counts (`files_scanned`, `tracked_files_count`, `local_links_checked`) and `scopes_skipped` eliminated the distrust tax while cutting `SKILL.md` size by **~87%** (`278–380` lines → `37–58` lines).
3. **Cross-Domain Public-Repo Paired Benchmarks**:
   - Across public security, live PostgreSQL 18, and CI/CD benchmarks, pairing a 1-page rule index with deterministic local probes reduced session wall-clock time by **11%–22%** and tool calls by **13%–40%**, while eliminating silent false negatives such as truncated GitHub API page-2 pagination, skipped repository privacy docs, and `git check-ignore` traps.
4. **Negative Boundary Experiment (TDD Mechanical Gate)**:
   - On a real Python TOML parser repository paired against a popular TDD skill, adding a mechanical script gate produced **zero measurable correctness gain** (`20/20` hidden acceptance tests passed on both arms) while coercing the agent's small red-green micro-cycles into coarser batches.
   - **Conclusion**: Deterministic `0/1/2` probes belong on **high-entropy objective environment checks** (file trees, `.env` drift, schemas/EXPLAIN, dependency/security audits), NOT on pure coding-discipline or creative/stylistic skills (`--mode lite`).
