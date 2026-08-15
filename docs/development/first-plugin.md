# 第一个插件

本文通过本仓库的示例包 `packages/example-hello` 介绍插件包的最小结构与三种插件形态。

## 包结构

```
packages/example-hello/
├── package.json        # 包清单，声明 dsh.bundle 与依赖
├── cordis.patch.yml    # 配置层：把插件行插入到组合中
├── src/index.ts        # 插件源码
├── tsconfig.json       # 构建配置（tsc → lib/）
└── README.md           # 包文档
```

### package.json

插件包通过 `dsh.bundle` 声明自己是**插件包（bundle）**——一个"贡献配置层"的 npm 包：

```json
{
  "name": "@dsh-plugins/example-hello",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": ["lib", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.6"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.6",
    "@deepseek-ai/schemastery": "^3.18.1",
    "typescript": "^5.6.0"
  },
  "scripts": { "build": "tsc -p tsconfig.json" }
}
```

要点：

- `dsh.bundle.patch` 指向本包的 `cordis.patch.yml`——当用户把本包加入某个 profile 时，该文件作为一层配置被应用。
- **不声明** `dsh.bundle` 的包仍可安装，但只作为普通依赖（库包），不激活任何配置层。
- `cordis` 与 `dsh-tools` 是宿主提供的运行时，用 `peerDependencies` 声明；`devDependencies` 里重复一份用于本地构建时的类型解析。

### cordis.patch.yml

配置层是一个 YAML 数组，与 `dsh --patch` 覆盖层写法一致，区别是插件行按**包名**引用（Node 解析会找到 profile 里安装的代码），而不是相对源码路径：

```yaml
- insert:
    - id: example-hello
      name: '@dsh-plugins/example-hello'
```

`id` 是行标识（同一行可以被后面层按 id 覆盖），`name` 是插件模块名。需要传配置时加 `config` 字段（见 [config.md](config.md)）。

### 插件源码

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'example-hello'

export function apply(ctx: Context) {
  // 注册能力……
  console.log('[example-hello] plugin loaded!')
}
```

`export const name` 是插件名，`apply(ctx, config)` 在插件加载时被调用。

## 三种插件形态

### 函数形态（最常用）

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  // ...
}
```

### 对象形态

```ts
import type { Context } from '@deepseek-ai/cordis'

export default {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context) {
    // ...
  },
}
```

### 类形态（提供服务时使用）

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

export default class MyService extends Service {
  static inject = ['tools']

  constructor(ctx: Context) {
    super(ctx, 'myService')
    // 构造器内做同步初始化。
  }
}
```

函数形态足够覆盖大多数场景；需要向其他插件提供服务时用类形态（见 [services.md](services.md)）。

## 生命周期

每个加载的插件拥有一个 **Fiber** 作用域，状态机如下：

```
PENDING → LOADING → ACTIVE
                 ↘ FAILED
ACTIVE → UNLOADING → DISPOSED
```

| 状态 | 含义 |
| --- | --- |
| PENDING | 已声明，但必需依赖未就绪 |
| LOADING | 依赖就绪，`apply` 正在执行 |
| ACTIVE | 插件运行中 |
| FAILED | `apply` 抛错 |
| UNLOADING | 卸载中，正在回收资源 |
| DISPOSED | 完全卸载 |

要点：

- **依赖驱动加载**：声明了 `inject` 的插件会等待所有必需服务就绪；运行中必需服务消失（如提供者被替换）时，插件自动卸载，服务回来后再加载。
- **自动清理**：`ctx.on()`、`ctx.tools.register()`、`ctx.effect()` 等注册在卸载时逆序回收；多个异步 disposer 并发执行、无串行完成保证，依赖顺序的清理要放进同一个 `ctx.effect()` 的 disposer 里串行 await。
- **HMR**：开发时编辑插件源码会触发热替换——卸载旧实例、加载新代码、重跑 `apply`。因为注册都是 effect，热替换不会残留旧实例的注册。

## 验证

安装到 profile 后启动即可看到加载日志：

```sh
dsh plugin --profile demo add ./packages/example-hello
dsh --profile demo --dump-config   # 查看配置层，应看到 "# == @dsh-plugins/example-hello"
dsh --profile demo
```

## 下一步

- [tools.md](tools.md) — 注册一个模型可调用的工具
- [config.md](config.md) — 接收用户配置
- [spec/package.md](../spec/package.md) — 包结构完整规范
