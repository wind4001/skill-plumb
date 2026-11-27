# env-diff-audit Reference Guide

## 1. CLI Contract & Exit Codes

```bash
node <skill_dir>/scripts/probe_env_diff_audit.mjs <project_dir> [--out <report.json>]
```

- `0` (`env_clean`): Every key in `.env.example` exists in `.env`, `.env` has no undeclared extra keys, and no `.env` value is empty or a placeholder.
- `1` (`error`): Unknown CLI flag, missing `<project_dir>`, extra positional arguments, missing `--out` value, non-directory target, missing `.env.example` or `.env`, or symlink pointing outside `<project_dir>`. Writes structured error JSON to `stderr`.
- `2` (`env_drift_or_placeholders`): Scan completed and found one or more `missing_keys`, `extra_keys`, or `placeholder_or_empty` entries.

## 2. `.env` / `.env.example` Parsing Semantics

- Strips optional UTF-8 BOM (`\uFEFF`) and handles both LF (`\n`) and CRLF (`\r\n`).
- Ignores blank lines and full-line comments starting with `#` (with optional leading whitespace).
- Supports optional `export ` prefix (`export KEY=value`) without misparsing key names starting with `export_` (e.g., `export_mode=true`).
- Splits strictly on the first `=`, preserving `=` inside values (e.g., base64 tokens, DSN query strings).
- Supports double-quoted (`"..."`), single-quoted (`'...'`), backtick-quoted (`` `...` ``), and unquoted values.
  - Inline `# comments` preceded by whitespace outside quotes are stripped; `#` inside quotes or directly attached inside unquoted tokens (e.g., `abc#123`) is preserved.
- On duplicate keys in the same file, the later declaration overrides the earlier one (matching dotenv / shell behavior).

## 3. Drift & Placeholder Detection Rules

1. **Missing keys (`missing_in_env`)**: Key exists in `.env.example` but is absent from `.env`.
2. **Extra keys (`extra_in_env`)**: Key exists in `.env` but is absent from `.env.example`.
3. **Empty or placeholder values (`placeholder_or_empty`)**:
   - `empty_value`: Empty unquoted value (`KEY=`), empty quotes (`""` / `''`), comment-only right-hand side (`KEY= # todo`), or whitespace-only quoted value.
   - `placeholder_change_me`: `CHANGE_ME`, `changeme`, `change-me`, `change_this` (including embedded in URLs/DSNs).
   - `placeholder_replace_me`: `REPLACE_ME`, `replace_me`, `replace-me`, `replace_with`.
   - `placeholder_your_prefix`: `YOUR_...` / `your-...` / `your <key|secret|token|password>`.
   - `placeholder_angle_brackets`: `<...>`, `<API_KEY>`, `<your_token>`, or template placeholders like `postgres://<USER>:<PASS>@host/db`.
   - `placeholder_todo`: `TODO`, `FIXME`, `TBD`.
   - `placeholder_xxx`: `xxx`, `XXXX`, `sk-xxx`, `key_xxxx`.
   - `placeholder_keyword`: `placeholder`, `my_placeholder`, `PLACEHOLDER_*`.
   - `placeholder_template_marker`: `***`, `...`, `fill_me`, `insert_here`, `paste_*_here`.
   - `identical_to_example_placeholder`: Non-empty `.env` value is still byte-for-byte identical to a template-style value in `.env.example` (e.g., `example-*`, `sample_*`, `dummy_*`, `example.com`, `default_secret`, or bare literals like `secret` / `password` / `token`). Legitimate shared defaults (`PORT=3000`, `NODE_ENV=production`) are not flagged.

## 4. Zero-Plaintext Secret Policy

- Neither `stdout`, `stderr`, nor `--out <report.json>` ever embeds raw `.env` or `.env.example` values.
- Reports expose only key names, line numbers, aggregate `counts`, classification `reason`, `identical_to_example` boolean, and `[REDACTED]` / `<empty>` markers.

## 5. Report JSON Schema

```json
{
  "scan_completed": true,
  "exit_code": 2,
  "exit_meaning": "env_drift_or_placeholders",
  "status": "findings_detected",
  "project_dir": "/abs/path/to/project",
  "files": { "env_example": ".env.example", "env": ".env" },
  "counts": {
    "example_keys": 5,
    "env_keys": 5,
    "missing_keys": 1,
    "extra_keys": 1,
    "empty_or_placeholder_keys": 2,
    "total_findings": 4
  },
  "missing_keys": [{ "key": "MISSING_KEY", "example_line": 2 }],
  "extra_keys": [{ "key": "EXTRA_KEY", "env_line": 6 }],
  "placeholder_or_empty": [
    {
      "key": "API_KEY",
      "env_line": 3,
      "reason": "placeholder_your_prefix",
      "identical_to_example": true,
      "redacted_preview": "[REDACTED]",
      "redacted": true
    }
  ],
  "findings": []
}
```

## 6. Sibling Skill Boundaries

- Use **env-diff-audit** to audit `.env` vs `.env.example` schema/placeholder readiness before running or deploying a project.
- Use **pre-publish-audit** for repository-wide secret/key scanning across git history, hardcoded paths, or Markdown link checks before publishing/open-sourcing.
- Use **docker-web-deploy** for full single-project Docker build/save/scp/compose/nginx deployment workflows.
- Use **docker-portal-platform** for multi-app Docker tar hosting platform setup and MCP deployment engines.
