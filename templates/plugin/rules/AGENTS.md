# SkillPlumb Two-Stage Routing Discipline

Use progressive routing to keep agent context lean and prevent skill misrouting as your installed registry grows:

1. **Direct Action First (No Unnecessary Skills)**
   Simple literal edits, targeted file reads, `git status`/`commit`, or running existing project test/build commands do NOT require invoking `skill-plumb inspect` or loading external skills.

2. **Clear Single-Skill Match**
   When one skill unmistakably fits the request (for example explicit `/skill-name` or a unique workflow), read its `SKILL.md` directly without extra routing hops.

3. **Ambiguous, Crowded-Domain, Multi-Skill, or Newly Added Skills**
   Run the two-stage router before guessing (`npx --yes skill-plumb`, or `node <cli_path>` if running from a checkout):
   ```bash
   npx --yes skill-plumb inspect "<task intent>" --limit 3
   ```
   - `skill-plumb` automatically refreshes its catalog cache whenever `SKILL.md` files or `router_overrides.json` change (zero manual sync needed).
   - If `predicted` is `"NONE"` (`direct_no_tool: true`), solve directly with built-in tools.
   - If `ambiguous: true` or `missing_not_for_warning: true`, compare each candidate's `use_when` and `not_for` boundaries before choosing.

4. **Skill Authoring & Zero-Invasion External Hygiene**
   - Author or validate new skills with `npx --yes skill-plumb scaffold` and `npx --yes skill-plumb gate <skill_dir>`.
   - Audit installed skills anytime with `npx --yes skill-plumb doctor`.
   - For third-party or auto-synced skills, keep domain, `aka`, and `not_for` guards in `router_overrides.json` instead of editing upstream `SKILL.md` files.
