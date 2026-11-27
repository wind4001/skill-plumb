---
name: env-diff-audit
x-domain: deploy
description: "Audit .env against .env.example for missing, extra, empty, or placeholder config keys without echoing raw secrets. Use when checking .env and .env.example drift before deploy or app startup. Not for general repo secret/key git-history audits (use pre-publish-audit); multi-app portal deployments (use docker-portal-platform); or full single-project compose/nginx deployment (use docker-web-deploy)."
---

# env-diff-audit（薄契约）

Compare `<project_dir>/.env.example` and `<project_dir>/.env` deterministically to catch configuration drift and unfilled placeholders before deployment or service launch, with zero plaintext secret exposure.

## 第一步：运行确定性探针（勿手工猜测差异或读取明文）

```bash
node <skill_dir>/scripts/probe_env_diff_audit.mjs "<project_dir>" [--out <report.json>]
```

| 退出码 | `exit_meaning` | 下一步分支 |
|---:|---|---|
| `0` | `env_clean` | 键集合完全对齐且无空值/占位符，可继续启动或部署流程 |
| `1` | CLI 参数错误 / 目标目录无效 / 缺少 `.env.example` 或 `.env` / 软链越界 | 根据 `stderr` 错误提示修正输入或补齐文件后重跑 |
| `2` | `env_drift_or_placeholders` | 按 `missing_keys` / `extra_keys` / `placeholder_or_empty` 逐项定位键名并引导用户补全或确认 |

## 核心判断边界与反偷懒红线

1. **严禁回显或落盘任何明文值**：探针报告、stdout、stderr、`--out` JSON 及最终对话汇报仅允许出现键名、行号、计数、脱敏原因标签（`reason`）和 `[REDACTED]`，绝不输出 `.env` 明文内容。
2. **不可替代用户裁决配置值**：对于缺失键（`missing_keys`）、多余键（`extra_keys`）或占位符键（`placeholder_or_empty`），只定位具体键名与行号，由用户决定真实值或是否清理 `.env` / 更新 `.env.example`。
3. **验证先于宣称**：修改 `.env` 或 `.env.example` 后必须重新实跑探针至退出码 `0` 方可宣称对齐。

详细规则、解析语法边界与脱敏规范见：[references/guide.md](references/guide.md)
