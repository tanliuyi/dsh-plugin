# 版本与发布规范

## 版本策略

- 使用[语义化版本](https://semver.org/)（`MAJOR.MINOR.PATCH`），`0.x` 阶段 `MINOR` 变更可含破坏性变更。
- **与 `dsh` 兼容线对齐**：`dsh` 处于 developer preview，可能有破坏性变更。本仓库包的 peer 依赖必须指向与本地安装一致的 rc 兼容线（当前 `@deepseek-ai/dsh-tools@^0.1.0-rc.6`、`@deepseek-ai/cordis@^4.0.1`）。
- 升级 peer 依赖线（如 `dsh` 发布新 rc 且 API 变化）时：升版本（破坏性变更 → `MINOR`，0.x 阶段）、跑全量构建与测试、`pnpm docs:sync` 刷新清单。

## 发布前检查（Checklist）

- [ ] `pnpm build` 全部包零错误（strict 类型检查通过）
- [ ] `pnpm -r test` 通过
- [ ] `pnpm docs:check` 通过（INDEX 无漂移、符合性零失败）
- [ ] 包 `README.md` 与实际行为一致
- [ ] `files` 包含构建产物 `lib/` 与 `cordis.patch.yml`；`main`/`exports` 指向真实文件
- [ ] `license` 已声明；发布到 npm 的包建议补 `repository`

## 发布流程

### 发布到 npm（推荐）

```sh
pnpm build
pnpm docs:sync
pnpm -r publish --access public    # pnpm -r 按依赖拓扑顺序发布
```

`--access public` 仅首次发布 scoped 包时需要。发布的是预构建代码（`lib/` 在 `files` 中），用户 `dsh plugin add` 即可安装，无需构建权限。

### 发布到 Git

git 安装拉取源码，因此必须提供自包含的 `prepare` 脚本（构建发布入口，不假设 monorepo 环境），并在发布说明中告知用户 pnpm ≥10 的 `allowBuilds` 允许步骤（见 [development/bundling.md](../development/bundling.md)）。固定 commit 引用（`github:you/repo#<sha>`）。

### 本仓库内部（workspace）

未发布的新包可直接用本地路径安装验证：

```sh
dsh plugin --profile demo add ./packages/<plugin-name>
```

## 变更记录

- 每个包的破坏性变更在版本号与 README 中声明。
- 仓库级约定变更记录在 `docs/spec/` 对应章节与 commit message 中（遵循仓库 commit 规范：变更同步文档的提交注明 `docs:sync` 已运行）。
