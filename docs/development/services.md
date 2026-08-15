# 服务与依赖（Service & Inject）

服务是一个插件暴露给其他插件的能力。`tools`、`llm`、`agents` 都是服务——每个都是挂在 `ctx` 上的命名能力。任何插件都可以提供服务给其他插件消费。

## 消费服务

用 `inject` 声明必需服务，`apply` 运行时该服务一定就绪：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'
export const inject = ['tools']  // ctx.tools 就绪后插件才会加载

export function apply(ctx: Context) {
  ctx.tools.register(/* ... */)
}
```

可选依赖：不写 `inject`，在使用点用 `ctx.get()` 查询并处理缺失：

```ts
export function apply(ctx: Context) {
  const metrics = ctx.get('metrics')
  metrics?.record('plugin_loaded', 1)
}
```

不要为了省一个 undefined 检查而滥用 `inject`。

## 提供服务

### 继承 Service

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

export default class MetricsService extends Service {
  static inject = ['llm']  // 服务也可以依赖其他服务

  constructor(ctx: Context) {
    super(ctx, 'metrics')  // 'metrics' 是服务名
  }

  record(event: string, value: number) {
    // ...
  }
}
```

加载后，消费者通过 `ctx.metrics` 访问：

```ts
export const inject = ['metrics']

export function apply(ctx: Context) {
  ctx.metrics.record('tool_call', 1)
}
```

### 声明类型

用 TypeScript declaration merging 给 `ctx.metrics` 提供类型：

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    metrics: MetricsService
  }
}

export default class MetricsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'metrics')
  }

  record(event: string, value: number) { /* ... */ }
}
```

## 依赖行为

- **必需依赖**：服务缺失时插件不加载；运行中必需服务消失（提供者卸载）时，依赖插件自动卸载，服务回来后再加载。这保证插件不会调用已不存在的服务。
- **隔离（isolate）**：`cordis.yml` 可以把服务隔离，让不同插件组看到同一个服务的不同实例：

```yaml
- id: group-a
  name: '@deepseek-ai/cordis-plugin-group'
  group: true
  isolate:
    shell: true
  config:
    - name: '@deepseek-ai/dsh-bash-local'
      config:
        timeoutMs: 5000
    - name: './src/plugin-a.ts'

- id: group-b
  name: '@deepseek-ai/cordis-plugin-group'
  group: true
  isolate:
    shell: true
  config:
    - name: '@deepseek-ai/dsh-bash-local'
      config:
        timeoutMs: 60000
    - name: './src/plugin-b.ts'
```

`plugin-a` 与 `plugin-b` 各看到自己组内的 Bash 实例，互不影响。

## 内置服务

Harness 生成的服务名、公开方法与源码位置记录在上游仓库各子系统的文档页（如 `tools` 服务见 `docs/subsystems/tools.md`）。开发插件时以生成区与服务的 TypeScript 接口为准，不要维护第二份静态清单。

## 实践建议

- 行为封装进插件：工具流水线事件属于 `ctx.tools`，模型流式属于 `ctx.llm`，实时 agent 协调属于 `ctx.agents`。
- 拦截/策略用事件，直接能力调用用服务方法。
- 服务接口（Service Definition）与实现（Provider）分层时，参考上游 [capability layering](https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/develop/practice) 文档。

## 下一步

- [events.md](events.md) — 无紧耦合的插件间通信
- [spec/code.md](../spec/code.md) — 服务 JSDoc 完整规范
