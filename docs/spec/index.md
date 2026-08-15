# 插件规范文档

> 本仓库（dsh-plugins）的插件包规范：结构、命名、代码、文档与发布约定。**机器可检查的部分由 `scripts/sync-docs.mjs` 校验**，人工部分靠 Code Review 与本文档约束。

## 规范总览

| 主题 | 文档 | 机器检查 |
| --- | --- | --- |
| 包结构、命名、版本、依赖、清单字段 | [package.md](package.md) | 部分（sync-docs 检查） |
| 代码风格、类型、JSDoc、行为约定 | [code.md](code.md) | 部分（typecheck/build 门禁） |
| 包 README、JSDoc、插件清单同步 | [docs.md](docs.md) | 部分（sync-docs 检查） |
| 版本策略与发布流程 | [release.md](release.md) | 否 |

## 核心约定（一句话版）

1. **一个插件一个包**：所有插件包在 `packages/` 下，包名 `@dsh-plugins/<kebab-name>`，目录名与包名一致。
2. **插件包必须声明 `dsh.bundle`**；纯库包不声明。
3. **每个包必须有 `README.md`**，且包的任何元数据变更都要跑 `pnpm docs:sync` 刷新插件清单。
4. **代码必须通过 `tsc --strict` 构建**；导出 API 必须有完整 JSDoc。
5. **注册即 effect**：通过 `ctx` 注册的一切在卸载时自动回收，禁止模块级副作用。
6. **可配置值不做硬编码**；非法配置在加载期 fail loudly。
7. **版本与 `dsh` 兼容线对齐**：peer 依赖使用与安装的 `dsh` 一致的 rc 版本线。

## 新增一个插件包（Checklist）

```sh
cp -r packages/example-hello packages/<plugin-name>
```

- [ ] `package.json`：`name` → `@dsh-plugins/<plugin-name>`；`description` 一句话说明用途；版本按 [release.md](release.md)
- [ ] `src/index.ts`：导出 `name` / `inject` / `Config` / `apply`，全部公开 API 带 JSDoc
- [ ] `cordis.patch.yml`：插入本包的行（`id` + `name: '@dsh-plugins/<plugin-name>'`）
- [ ] `README.md`：按 [docs.md](docs.md) 模板
- [ ] 代码通过 `pnpm build`（strict 类型检查）
- [ ] `test` 脚本可运行（`pnpm test`）
- [ ] `pnpm docs:sync` 通过（生成 INDEX + 符合性检查零失败）

## 符合性检查

```sh
pnpm docs:sync    # 重新生成 docs/plugins/INDEX.md + 全量检查
pnpm docs:check   # 只检查（CI 用），有漂移非零退出
```

sync-docs 当前检查项（随 `scripts/sync-docs.mjs` 演进）：

- 包目录名与 `package.json.name` 的短名一致
- 名称匹配 `@dsh-plugins/<kebab-case>` 且不含大写
- `version` 是合法 semver
- `description` 非空
- `README.md` 存在
- `license` 是合法 SPDX 表达式
- `type: module`（ESM）
- bundle 包：`dsh.bundle.patch` 指向的文件存在
- `main` 指向的文件存在（构建产物）
- `docs/plugins/INDEX.md` 与扫描结果一致（`--check` 模式下漂移即失败）
