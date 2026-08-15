# Bundle 打包、安装与发布

插件以 npm 包（**bundle**）形式分发，安装进 **profile**（`dsh` 可启动的组合配置）使用。本文覆盖打包、安装方式、配置层顺序与发布。

## 两个概念，两个清单

两者都由 `package.json` 描述，但 `dsh` key 下携带不同清单：

| 概念 | 清单 | 回答的问题 | 谁写 |
| --- | --- | --- | --- |
| **Bundle**（插件包） | `dsh.bundle` | "这个包贡献什么？"——一个插入/覆盖插件行的 patch 文件 | 插件作者 |
| **Profile**（启动组合） | `dsh.profile` | "哪些 bundle 按什么顺序组成这个启动配置？" | `dsh plugin` 自动维护 |

一个包要么是 bundle 要么是 profile，不会既是。**bundle 是你编写和分发的东西，profile 是用户启动的东西。**

### Bundle 清单

```json
{
  "name": "@dsh-plugins/example-hello",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "files": ["lib", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

不声明 `dsh.bundle` 的包安装后只是普通依赖（`dsh plugin` 会打印警告、不激活任何层）——库包用这个格式，插件用户直接 enable 的包用 bundle 格式。

### Profile 清单

profile 目录（`$DSH_HOME/profiles/<name>/`）含两个文件：

- `package.json` — 由 pnpm 管理的 out-of-tree 插件依赖 + `dsh.profile` 清单（有序 `bundles` 列表）
- `cordis.patch.yml` — 用户自己的补丁层，在**所有** bundle 层之后应用

profile 清单永远不手写，由 `dsh plugin` 创建与维护。

## 安装到 profile

```sh
# 本地包（workspace 或任意目录）
dsh plugin --profile demo add ./packages/example-hello

# npm registry
dsh plugin --profile demo add @dsh-plugins/example-hello

# GitHub（注意 prepare 脚本问题，见下）
dsh plugin --profile demo add github:you/hello-plugin#<sha>
```

`dsh plugin --profile <name> <args...>` 是 pnpm 在 profile 目录的转发器，因此所有 pnpm 动词都可用（`add`/`remove`/`upgrade`…）。首次使用会初始化 profile（以 `@deepseek-ai/dsh-base` 为第一个 bundle），pnpm 链接依赖，`dsh` 检测到包声明 `dsh.bundle` 后追加到 `dsh.profile.bundles`。

验证层（不启动）：

```sh
dsh --profile demo --dump-config   # 应看到 "# == @dsh-plugins/example-hello" 层
```

移除：

```sh
dsh plugin --profile demo remove @dsh-plugins/example-hello
```

## 配置层顺序

有效配置在空根上按以下顺序叠加：

1. profile 的 `dsh.profile.bundles` 列表中的每个 bundle patch，按列表顺序（`@deepseek-ai/dsh-base` 最先，之后按加入顺序）；
2. profile 自己的 `cordis.patch.yml`；
3. 机器级 `$DSH_HOME/cordis.patch.yml`（所有 profile 共享的个人偏好）；
4. 每个 `--patch <path>` 覆盖层，按 argv 顺序。

后层按行覆盖，且 patch 替换的是整行 `config` 值而非深合并。两个推论：

- 本包可以按 `id` 覆盖更早层的行（就像 `@deepseek-ai/dsh-web-app` 覆盖 `dsh-base` 的行），但必须重述该行需要的全部 key；
- 用户可以在自己 profile 的 `cordis.patch.yml` 覆盖本包的行而不碰包文件——所以默认值选用户大概率保留的，其余交给 Schema。

内置 bundle 名（`@deepseek-ai/dsh-base` 等）总是从 dsh 安装本体解析；pnpm 只管理 out-of-tree 包。因此本包可以放心依赖 `@deepseek-ai/dsh-base` 存在且为当前版本。

## 从 GitHub 安装：build 脚本陷阱

git 安装拉取的是**源码而非构建产物**：不会运行你的 `build` 脚本，TS 包会因缺少 `lib/` 输出而加载失败。两侧各需一件事：

- **作者侧**：提供 `prepare` 脚本——pnpm 会在 git 安装后运行它，从源码构建发布入口，且必须自包含（不能假设 monorepo 兄弟目录等 dev-only 环境）。上游示例 [turtle-ui](https://github.com/deepseek-harness/turtle-ui)。
- **用户侧**：允许构建。pnpm ≥10 拒绝运行 git 依赖的 `prepare`，直到在 profile 的 `pnpm-workspace.yaml` 显式允许：

  ```yaml
  allowBuilds:
    '@dsh-plugins/example-hello': true
  ```

  然后重新 `add`。这个允许等于**允许该包代码在安装时于你的机器上执行**（在 agent 沙箱之外），只允许信任的源码，并固定 commit（`github:you/hello-plugin#<sha>`）。

不想让用户做这个允许，就分发构建产物（两种都无需构建权限）：

- **发布到 npm**：`lib/` 在 `pnpm publish` 时已构建，用户 `dsh plugin add your-package` 安装预构建代码；
- **发 tarball**：`pnpm pack` 产物，用户 `dsh plugin add ./your-package-0.1.0.tgz`。

## 本仓库内的发布流程

见 [spec/release.md](../spec/release.md)。摘要：

```sh
pnpm -r build        # 构建全部插件包
pnpm docs:sync       # 同步文档（包描述/版本变更会进 INDEX）
pnpm -r publish      # 按依赖顺序发布（pnpm -r 自动拓扑排序）
```

## 下一步

- [testing.md](testing.md) — 插件测试
- [spec/release.md](../spec/release.md) — 版本与发布规范
