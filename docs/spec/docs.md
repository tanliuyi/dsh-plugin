# 文档规范

本仓库的文档分三层，各有维护者与同步机制：

| 层 | 位置 | 内容 | 维护 |
| --- | --- | --- | --- |
| 仓库文档 | `docs/development/`、`docs/spec/` | 插件开发指南与规范 | 人工，约定变更时更新 |
| 插件清单 | `docs/plugins/INDEX.md` | 所有插件包一览 + 符合性报告 | 自动（`pnpm docs:sync`） |
| 包文档 | `packages/*/README.md` | 每个包的用途/安装/配置/示例 | 人工，随包变更更新 |

## 同步规则

1. **上游变了 → 移植文档**：运行 `pnpm docs:upstream` 检测 dsh 上游（deepseek-harness）插件开发文档的变更（基线：`scripts/upstream-baseline.json`），按 SKILL（`.agents/skills/sync-plugin-docs/SKILL.md`）评估影响，把契约变更移植到 `docs/development/` 与 `docs/spec/` 对应章节；不影响本仓库的纯叙述性变更不照抄。上游契约变更影响本地包时，同步更新 `packages/example-hello` 与本地插件包。
2. **代码/元数据变了 → 刷新清单**：新增、重命名、删除、修改 `description`/`version`/`dsh.bundle`/依赖的包，运行 `pnpm docs:sync` 重新生成 `docs/plugins/INDEX.md`。`docs/plugins/INDEX.md` 禁止手改。
3. **约定变了 → 同步两套文档**：任何影响插件作者行为的约定变更（目录布局、命名、依赖策略、代码风格、发布流程），必须同时更新 `docs/development/` 对应章节与 `docs/spec/` 对应章节，保持二者一致。
4. **文档引用的文件必须存在**：docs 中引用的路径（示例包、脚本、SKILL）应可点击直达。
5. 自动化流程见 [`.agents/skills/sync-plugin-docs/SKILL.md`](../../.agents/skills/sync-plugin-docs/SKILL.md)。

## 包 README 模板

每个插件包的 `README.md` 必须包含：

```markdown
# <包名>

一句话说明：这个插件做什么。

## 安装

    dsh plugin --profile <name> add <包名>

## 配置

列出配置字段与默认值（与 Config Schema 一致）。

## 使用

示例：启动后如何验证/调用。

## 开发

构建与测试命令（pnpm build / pnpm test）。
```

## JSDoc 与生成文档

源码中的 JSDoc 是 API 文档的单一事实来源（见 [code.md](code.md) 的 JSDoc 完整性要求）。对外 API 的签名变更必须同步更新 JSDoc；不得出现"代码已改、注释还描述旧行为"的漂移。

## 语言

仓库文档以中文为主，专有名词（Cordis、bundle、profile、apply、inject 等）保留英文原词。上游链接指向英文文档时保留原文标题。
