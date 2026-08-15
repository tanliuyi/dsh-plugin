# 包结构规范

## 目录布局

```
packages/<plugin-name>/
├── package.json        # 必选。包清单（见下）
├── cordis.patch.yml    # 插件包必选。配置层
├── src/index.ts        # 必选。插件入口（导出 apply）
├── src/…               # 可选。其他源码模块
├── tests/              # 可选。测试（或 tests 内联）
├── tsconfig.json       # 必选。构建配置
└── README.md           # 必选。包文档（见 docs.md）
```

- 构建产物输出到 `lib/`（`gitignore` 已忽略），发布时随 `files` 进包。
- 一个包只做一个插件的职责；需要多个插件模块时作为子路径导出（如 `@dsh-plugins/x/startup`），而不是开多个包。

## 命名规范

- 包名：`@dsh-plugins/<kebab-case>`，全小写、用连字符分词，如 `@dsh-plugins/example-hello`。
- 目录名 = 包短名（`packages/example-hello/`）。
- 插件 `name`（源码导出）：小写，可用连字符，如 `export const name = 'example-hello'`。
- 工具名：全小写，如 `greet`；事件名：`<plugin>/<action>` 小写斜杠分隔。
- 服务名：camelCase，如 `myService`。

## package.json 字段要求

```json
{
  "name": "@dsh-plugins/example-hello",
  "version": "0.1.0",
  "description": "一句话说明这个插件做什么",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": { ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" } },
  "files": ["lib", "cordis.patch.yml"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "node --test lib/**/*.test.js"
  },
  "license": "MIT",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.6"
  },
  "devDependencies": { "typescript": "^5.6.0" }
}
```

| 字段 | 要求 |
| --- | --- |
| `name` | `@dsh-plugins/<kebab-case>`（sync-docs 检查） |
| `version` | 合法 semver（sync-docs 检查） |
| `description` | 非空，一句话（sync-docs 检查） |
| `type` | `module`（ESM，sync-docs 检查） |
| `main`/`types`/`exports` | 指向构建产物 `lib/`；`main` 指向的文件必须存在（sync-docs 检查） |
| `files` | 至少包含 `lib`；插件包还须含 `cordis.patch.yml` |
| `scripts.build` | 必选，产出 `lib/` |
| `scripts.test` | 必选，可运行 |
| `license` | 合法 SPDX（sync-docs 检查）；本仓库默认 `MIT` |
| `dsh.bundle` | 插件包必选：`{ "patch": "./cordis.patch.yml" }`（sync-docs 检查 patch 文件存在）；库包不写 |
| `repository` | 可选，但发布到 npm 的包建议声明 |

## 依赖规范

- **宿主运行时**（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-base` 等）放 `peerDependencies`，版本与本地安装的 `dsh` 兼容线对齐（当前 `cordis@^4.0.1`、`dsh-tools@^0.1.0-rc.6`）。
- `devDependencies` 重复声明 peer 依赖，供本地构建解析类型。
- 纯数据/算法库（如 `@deepseek-ai/schemastery`）放 `dependencies`。
- 不把 `lib/` 或 `node_modules` 提交进 git；`pnpm-lock.yaml` 提交。

## 版本规范

见 [release.md](release.md)。摘要：语义化版本；`dsh` 处于 developer preview（可能有破坏性变更），本仓库包的 peer 依赖范围须容纳当前 rc 兼容线。
