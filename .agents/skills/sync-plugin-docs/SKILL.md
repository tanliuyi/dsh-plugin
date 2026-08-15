---
name: sync-plugin-docs
description: 同步 dsh 上游（deepseek-ai/deepseek-harness）的插件开发文档变更到本仓库。检测上游 docs/user/develop、cordis 教程/API、官方 SKILL、架构笔记等关注文件的变更，评估影响后移植到 docs/development 与 docs/spec，并同步本地插件清单。运行 pnpm docs:upstream 检测变更、移植后 pnpm docs:sync 刷新本地。任何插件包元数据、目录布局、命名、代码规范、发布流程的改动，或上游文档更新后，都应先加载本 SKILL。
---

# 同步 dsh 上游的文档变更

本 SKILL 的核心职责：**把 dsh 上游（deepseek-harness）的插件开发文档变更同步到本仓库**，保证 `docs/development/`（开发文档）与 `docs/spec/`（规范文档）与上游实际契约一致。上游处于 developer preview、迭代很快，这是本仓库文档漂移的主要来源。

次要职责：本地代码 ↔ 文档同步（`pnpm docs:sync` 插件清单），在上游移植涉及本地包变更时执行。

## 机制

- **基线**：`scripts/upstream-baseline.json`（提交进 git）记录上次同步时的上游 commit SHA 与每个关注文件的 sha256。
- **检测**：`pnpm docs:upstream`（`scripts/sync-upstream.mjs`）对比上游当前 master 与基线，报告 added / changed / removed 文件并更新基线；`pnpm docs:upstream:check` 只检测不更新（CI/巡检门禁，有变更非零退出）。
- **关注清单**：脚本内 `WATCH` 数组——官方插件开发教程（`docs/user/develop/**`）、`docs/cordis-primer.md`、`docs/cordis-tutorial/**`、`docs/cordis-api/**`、cookbook（tool/package/extension）、`docs/capability-seams.md`、官方 Cordis SKILL（`apps/cli/config/agent-presets/cordis/skills/**`）、插件机制架构笔记（profile-plugin-bundles、client-plugin-loading、plugin-commands、web-plugin-configuration、plugin-settings-tabs）、`packages/extensions/README.md`、仓库 `README.md`。

## 标准工作流

### 1. 检测上游变更

```sh
pnpm docs:upstream
```

- 输出"上游无变更"：无需移植，直接结束。
- 输出变更列表：进入第 2 步。每个变更给出状态（🆕 added / ✏️ changed / 🗑️ removed）与 GitHub compare 链接。
- 首次运行（无基线）会建立基线，不会报变更。

### 2. 评估影响（逐一）

对每个变更文件，读上游内容/对比链接，判断对本仓库的影响面：

| 上游文件 | 影响 | 移植目标 |
| --- | --- | --- |
| `docs/user/develop/basic/tool.md`、`cookbook/adding-a-tool.md` | 工具定义契约（defineTool 字段、参数/输出约定） | `docs/development/tools.md`、`docs/spec/code.md` |
| `docs/user/develop/basic/config.md` | 配置 Schema 约定 | `docs/development/config.md`、`docs/spec/code.md` |
| `docs/user/develop/basic/index.md`、`framework/index.md` | 插件形态、生命周期（Fiber 状态机） | `docs/development/first-plugin.md` |
| `docs/user/develop/framework/service.md`、`events.md` | 服务/事件契约、inject 规则、事件模式 | `docs/development/services.md`、`events.md`、`docs/spec/code.md` |
| `docs/user/develop/basic/publish.md`、笔记 `2026-08-05-profile-plugin-bundles*` | bundle/profile 机制、层顺序、安装方式 | `docs/development/bundling.md`、`docs/spec/package.md`、`release.md` |
| `docs/cordis-primer.md`、`docs/cordis-tutorial/**`、`docs/cordis-api/**` | Cordis 框架语义（inject/effect/事件模式） | `docs/development/index.md`（五要素）、各章 |
| 官方 SKILL（`cordis-plugin-development/SKILL.md` 等） | 动态插件/平台能力约定 | `docs/development/` 相关章节、`docs/spec/code.md` |
| 笔记 `2026-07-19-plugin-command-registration*` 等 | 命令、客户端插件、配置 UI 机制 | `docs/development/`、`docs/spec/` 对应章节 |
| `README.md` | dsh 版本/兼容信息 | 根 `README.md`、`docs/spec/release.md`（版本对齐） |

判断原则：

- **契约变更**（API 签名、事件模式、包结构、CLI 行为、命名规则）→ 必须移植，同步改 `packages/example-hello` 与本地包。
- **示例/叙述变更** → 有改进才移植；不照抄（本仓库文档是原创中文版，不是上游翻译）。
- **无关变更**（非插件开发面）→ 忽略，但基线已记录，后续不会重复报。

### 3. 移植到本地文档

按上表更新 `docs/development/` 与 `docs/spec/` 对应章节，两套文档对同一约定的描述必须一致。上游改了什么行为，本地文档就改什么行为；本地文档中失效的示例、命令、字段名一并修正。

若约定变化影响示例插件（如 defineTool 字段、bundle 清单格式、命名规则）：

1. 更新 `packages/example-hello/`（源码/清单/README/测试）
2. `pnpm build && pnpm test` 验证

### 4. 刷新本地与验证

```sh
pnpm docs:sync             # 重新生成插件清单 + 本地符合性检查
pnpm docs:check            # 本地无漂移
pnpm docs:upstream:check   # 上游无未同步变更（基线已更新后应通过）
```

## 本地代码 ↔ 文档同步（常规流程）

改动本地插件包（新增/重命名/删除/改元数据）或仓库约定时：

```sh
pnpm docs:sync
```

脚本扫描 `packages/*` → 重新生成 `docs/plugins/INDEX.md` → 规范符合性检查（包命名、README、license、build、bundle patch 等），检查失败必须修复。约定变更要同时更新 `docs/development/` 与 `docs/spec/` 对应章节（映射表见上表，本地约定部分见 `docs/spec/index.md`）。

## 验证自检清单

- [ ] `pnpm docs:upstream:check` 通过（基线为最新，无未同步变更）
- [ ] `docs/plugins/INDEX.md` 列出所有 `packages/*` 包，无 ❌
- [ ] 每个包的 `README.md` 存在且与包行为一致（配置字段与 Config Schema 一致）
- [ ] `docs/development/` 与 `docs/spec/` 对同一约定的描述不冲突
- [ ] docs 中引用的路径（示例包、脚本、SKILL）真实存在
- [ ] 上游契约变更已体现在示例插件中（若有影响）

## 常见漂移与修复

| 漂移 | 修复 |
| --- | --- |
| `docs:upstream` 报变更但未移植 | 按工作流第 2~3 步评估移植，然后更新基线（脚本已自动更新） |
| `docs:upstream:check` 失败 | 有未同步的上游变更或基线缺失；先跑 `pnpm docs:upstream` |
| 基线被误改/冲突 | 以脚本生成的 JSON 为准重新生成（删掉后跑 `pnpm docs:upstream`） |
| 上游文件被删除 | 移除本地对应引用；若上游删了机制，删本地对应章节 |
| INDEX.md 过期 | `pnpm docs:sync` |
| 包缺 README / description / license | 补上后 `pnpm docs:sync` |
| development 与 spec 描述同一约定不一致 | 以实际代码/上游契约为准，统一两处 |
