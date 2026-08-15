# 插件开发文档

> 面向本仓库（dsh-plugins）的插件作者。以 DeepSeek Harness（`dsh`）官方文档与 Cordis 框架为准，本文档是落地到本仓库的实操指南。

## 插件是什么

在 Harness 中，**插件（plugin）是一个导出 `apply` 函数的 TypeScript 模块**。框架加载插件时调用 `apply` 并传入 `ctx` 上下文对象，插件通过 `ctx` 注册各种能力（工具、事件监听、服务、定时器等）：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  // 在这里注册能力。
}
```

所有通过 `ctx` 注册的东西（事件监听、工具、定时器）在插件卸载时**自动清理**，无需手动 removeListener / clearInterval。需要显式清理的资源用 `ctx.effect()` 提供 disposer。

## Cordis 五要素（快速版）

| 概念 | 说明 |
| --- | --- |
| Plugin | 实现 Service 的对象：函数（含可选 `inject`/`apply` 字段）或 `Service` 子类 |
| Context | 服务的仓库。服务占用稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`），其他插件通过 key 查找服务而非 import 具体实现 |
| `inject` | 声明插件依赖的服务。声明的服务就绪后插件才会加载，加载顺序由服务依赖表达 |
| Event | 插件间通信。`emit`/`waterfall`/`parallel`/`serial`/`bail` 多种派发模式，通过 TS declaration merging 获得类型安全 |
| Effect | 可逆的注册。通过 `ctx.effect()`/`ctx.on()` 安装的一切在卸载时按逆序回收，保证重载与卸载可预测 |

## 本仓库约定（摘要）

本仓库**一个插件一个包**，全部位于 `packages/` 下，由 pnpm workspace 管理：

```
packages/<plugin-name>/
├── package.json        # 声明 dsh.bundle（插件包）或纯依赖（库包）
├── cordis.patch.yml    # 本包贡献的配置层（插入/覆盖插件行）
├── src/index.ts        # 插件源码（导出 apply）
├── tsconfig.json
└── README.md           # 包文档（规范要求每个包必须有）
```

完整约定见[规范文档](../spec/index.md)。新增插件前先读它。

## 文档地图

| 主题 | 文档 |
| --- | --- |
| 第一个插件：包结构、插件形态、生命周期 | [first-plugin.md](first-plugin.md) |
| 注册一个工具（Tool） | [tools.md](tools.md) |
| 插件配置（Config + Schema） | [config.md](config.md) |
| 服务：消费与提供 | [services.md](services.md) |
| 事件：监听与派发 | [events.md](events.md) |
| Bundle 打包、安装与发布 | [bundling.md](bundling.md) |
| 测试 | [testing.md](testing.md) |

## 快速开始

```sh
# 1. 从示例包复制一个骨架
cp -r packages/example-hello packages/my-plugin

# 2. 改包名、写代码
#    package.json: name → @dsh-plugins/my-plugin
#    src/index.ts: 导出 name / inject / Config / apply

# 3. 构建并安装进 profile 验证
pnpm build
dsh plugin --profile demo add ./packages/my-plugin
dsh --profile demo

# 4. 同步文档与规范检查
pnpm docs:sync
```

> 前置条件：`dsh` CLI 已安装（`npx @deepseek-ai/dsh` 或本地安装），本仓库已 `pnpm install`。
