# dsh-plugins

DeepSeek Harness（`dsh`）插件集仓库。采用 pnpm workspace 管理，**一个插件一个包**，所有插件包位于 `packages/` 下。

> 兼容目标：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（developer preview，可能有破坏性变更），本地安装版本 `@deepseek-ai/dsh@0.1.0-rc.8`。

## 目录结构

```
.
├── docs/                     # 文档（插件开发文档 + 插件规范文档）
│   ├── development/          #   开发文档：从零写一个插件
│   ├── spec/                 #   规范文档：包结构、代码、文档、发布约定
│   └── plugins/INDEX.md      #   插件清单（由同步脚本自动生成，勿手改）
├── packages/                 # 插件包（一个插件一个包）
│   └── example-hello/        #   示例插件：工具注册 + 配置 Schema + Bundle 打包
├── scripts/
│   ├── sync-docs.mjs         # 本地文档同步：扫描 packages/ 生成插件清单并做规范符合性检查
│   ├── sync-upstream.mjs     # 上游文档同步：检测 deepseek-harness 插件开发文档变更（基线比对）
│   └── upstream-baseline.json # 上游同步基线（上次同步的 commit + 文件哈希，随仓库提交）
└── .agents/
    └── skills/
        └── sync-plugin-docs/ # SKILL：同步 dsh 上游文档变更到 docs/development 与 docs/spec
```

## 快速开始

```sh
# 1. 安装依赖并构建所有插件包
pnpm install
pnpm build

# 2. 把一个插件安装进 dsh profile（示例：example-hello）
dsh plugin --profile demo add ./packages/example-hello

# 3. 启动 dsh（Web UI 默认 http://127.0.0.1:3080）
dsh --profile demo
```

## 文档

- [插件开发文档](docs/development/index.md) — 插件是什么、怎么写、怎么发布
- [插件规范文档](docs/spec/index.md) — 本仓库的包结构、命名、代码、文档与发布规范
- [插件清单](docs/plugins/INDEX.md) — 当前仓库所有插件包的一览表（自动生成）

## 文档同步

`docs/` 与上游及本地代码的同步由两个脚本维护：

```sh
pnpm docs:upstream          # 检测 dsh 上游插件开发文档变更（基线 scripts/upstream-baseline.json）+ 更新基线
pnpm docs:upstream:check    # 只检测（CI 门禁）：有未同步的上游变更则非零退出
pnpm docs:sync              # 重新生成 docs/plugins/INDEX.md + 本地规范符合性检查
pnpm docs:check             # 只检查（CI 门禁）：有漂移则非零退出
```

- **上游变更**：运行 `pnpm docs:upstream`，按 [.agents/skills/sync-plugin-docs/SKILL.md](.agents/skills/sync-plugin-docs/SKILL.md) 评估并把契约变更移植到 `docs/development/` 与 `docs/spec/`。
- **本地变更**：新增/修改插件包后运行 `pnpm docs:sync`；约定变更时同步更新两套文档。

## License

[MIT](LICENSE)
