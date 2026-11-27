# AGENTS.md — Workspace Engineering Rules

1. **Zero External Runtime Dependencies**: Core CLI, router, gate, and showcase probe scripts MUST run on standard Node.js built-ins only (`node >= 20`). Never require users to `npm install` heavy frameworks just to lint or route skills.
2. **Test Isolation**: Tests in `tests/` MUST use `os.tmpdir()` and local fixtures, and MUST clean up temp dirs in `try/finally`. NEVER read, mutate, or rely on the developer's live `~/.agents/skills/`, `~/.claude/skills/`, or `~/.gemini/` state in automated test assertions.
3. **Deterministic 0 / 1 / 2 Probe Contract**: Probes and gates must distinguish clean pass (`0`), CLI/execution error (`1`), and verified findings or coverage gaps (`2`). Never silently treat skipped checks or missing fields as zero issues.
4. **Windows & Cross-Platform Safety**:
   - Quote paths safely; test temp directories with spaces.
   - Never invoke `.cmd`/`.bat` shims directly via `execFileSync` on Windows without wrapping through `cmd.exe /d /s /c`.
   - Avoid chaining commands with `&&` in cross-platform docs/scripts targeting Windows PowerShell 5.1.
5. **Pre-Publish Hygiene**: Before any public commit, release tag, or PR, run `examples/pre-publish-audit/scripts/audit_all.mjs` on this repository and verify zero hardcoded user-home or drive-letter paths, zero credentials, and zero broken Markdown links.
6. **Evidence Before Claims**: Only report tests or checks as passing after executing them on the final edited files and observing zero failures.
