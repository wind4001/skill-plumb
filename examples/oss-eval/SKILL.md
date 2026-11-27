---
name: oss-eval
description: >-
  评估第三方开源项目 / Codex 插件 / MCP / skill 是否值得引入：查安装脚本对本机的
  侵入性、出网与遥测行为、真实维护活跃度，并拿产物核实其营销话术是否属实。
  Use when 用户给一个 GitHub 链接问「这个项目怎么样 / 值不值得用 / 靠谱吗 / 帮我看看这个
  插件」，或在引入任何第三方依赖前要做尽调。
  Not for 评估自己的代码质量（用 code-review）。
---

# 第三方项目评估

在技能根目录运行，参数为本地仓库目录或 GitHub 仓库根 URL（带 `/tree/`、`/commit/` 等版本子路径请先本地切出后传目录），输出 JSON；四条命令可汇总也可单跑。

| 命令 | 检查范围 |
|---|---|
| `node scripts/eval_all.mjs <目录或GitHub根URL> [--workdir <目录>] [--repo owner/repo] [--api-base <URL>] [--offline] [--api-only \| --no-clone] [--out <json>]` | 汇总以下三项；传 `--out` 时落盘完整 JSON 并输出精简摘要与 `file:line` 指针（推荐）；未传 `--workdir` 克隆 GitHub URL 时会在系统临时目录保留浅克隆副本供人工核验；大型官仓或仅给 URL 快速初筛时优先加 `--api-only`（不克隆，仅拉 GitHub API 与远程 README，返回退出码 `2` 并须在结论标明本地源码未扫）；`--offline` 禁止联网克隆 |
| `node scripts/audit_install.mjs <目录> [--out <json>]` | 安装脚本/hooks/插件清单、宿主配置写入或卸载复活痕迹、`package.json` 生命周期、许可证 |
| `node scripts/audit_network_deps.mjs <目录> [--out <json>]` | 遥测与更新检查信号、外联代码域名对照根/子包 README 与文档披露、声明与导入依赖重量（Node/Python，含静态引用与真实路径防逃逸） |
| `node scripts/audit_activity_claims.mjs <目录> [--repo owner/repo] [--api-base <URL>] [--offline]` | 人类 vs 机器人提交、README 徽章/`href="#"`/工作流、可选 GitHub API（`.subscribers_count` 基线 0.37%–0.86%、`full_name` 规范名核对、逐端点状态与翻页截断标记） |

退出码：`0` = 所请求范围全部完成（**仍须核对 `repo_identity`、`findings`、截断标记 `*_truncated` 与关键源码**）；`2` = 覆盖不完整（分别写入 API/身份缺口 `scopes_skipped` 与本地跳过文件 `skipped`，含 `sample_complete: false` / `zero_external_runtime_deps: null`，绝不把未知当成零或凭空填缝）；`1` = 参数错误、执行失败或仓库身份冲突。

复核与判断纪律：
- 每条结论必须指向具体证据（`file:line`、命令或 API 字段）；正则命中先看上下文，区分「有开关的更新检查」与「未披露遥测」，并核查子包 README/docs 披露。
- **安装与卸载同作用域对称性**：若项目包含向宿主写入配置的命令（如 `setup`/`install`），必须对照读取对应的卸载分支（`remove`/`uninstall`），核查同作用域（如 `--project` / `--global`）能否真正撤回，警惕安装回落写全局而同作用域卸载漏删。
- **采集缺口不等于负面结论**：API 限流、分页截断、只查根文档、或未做动态安装测试，各自只产生对应的「未验范围 / 待查项」，不得叠加推出「别装」。
- 结论结构：**先写清「适用接入方式 + 用户前提约束 + 已核实事实 + 未验/待自测项」**，再给最终一句话建议（**能装 / 只借鉴思路 / 别装**），并列不同接入路径的取舍：
  - **别装**：已核实安装脚本不可控改写宿主配置 / 卸载复活 / 源码存在未披露出网 / 许可证具体条款明确禁止用户的拟议用途。
  - **只借鉴思路**：非机器人源码长期停滞且存在影响用户场景的未修问题 / 维护响应明显真空（须基于完整或已标注边界的样本判断）。
  - **能装**：无侵入性安装钩子 / 无出网或出网已披露且可控 / 维护与问题闭环满足用户场景（存在云端数据流或平台局限时写明推荐接入方式与规避项）。

必须拒绝的偷懒借口：
- ❌ 未打开命中源码核实上下文，就把脚本的 `red_flags` 直接当确认恶意行为上报；
- ❌ 看到 `Exit 2`（API 限流、分页截断、超大/不可读跳过文件）却将其省略或淡化为「未发现问题」；
- ❌ 发现宿主配置写入命令却不对照阅读同作用域卸载逻辑。
