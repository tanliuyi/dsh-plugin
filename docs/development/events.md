# 事件（Events）

事件是 Cordis 插件间的主要通信机制，也是 Harness 广泛使用的松耦合扩展点。

## 基本用法

```ts
// 监听
ctx.on('event-name', (payload) => {
  // 处理事件
})

// 派发
ctx.emit('event-name', payload)
```

监听器注册后即成为 effect：插件卸载时自动移除，无需手动清理。

## 派发模式

| 模式 | 等待？ | 顺序 | 返回值 | 用途 |
| --- | --- | --- | --- | --- |
| `emit` | 否 | 按注册顺序 | 无 | 广播通知 |
| `bail` | 否 | 按注册顺序 | 第一个非空结果 | 短路决策 |
| `serial` | 是 | 按注册顺序 | 第一个非空结果后停止 | 有序执行 |
| `parallel` | 是 | 并行 | 无 | 并行扇出 |
| `waterfall` | 否 | 按注册顺序 | 链式包装结果 | 中间件流水线 |

### emit — 广播

```ts
ctx.emit('my-plugin/ready', { id: 'worker-1' })

ctx.on('my-plugin/ready', ({ id }) => {
  console.log(`${id} is ready`)
})
```

### bail — 短路

```ts
const result = ctx.bail('some-check', input)

ctx.on('some-check', (input) => {
  if (shouldBlock(input)) return 'blocked'
  // 返回 null / false / undefined 继续下一个监听器。
})
```

### waterfall — 流水线

监听器**必须调用 `next()`** 委托下游，省略调用即短路整个流水线（这是设计，用于拦截与网关）：

```ts
const output = await ctx.waterfall('my-plugin/transform', input, async () => input)

ctx.on('my-plugin/transform', async (_input, next) => {
  const downstream = await next()
  return downstream.trim()
})
```

> 单个决策事件用短路设计：策略监听器拥有决策时可以省略 `next()`；只做标注/观察的监听器必须委托。需要用 `prepend: true` 的场景仅限于监听器必须先于普通注册运行。

## 类型安全事件

用 TypeScript declaration merging 声明事件签名：

```ts
import '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'my-plugin/ready': (payload: { id: string }) => void
    'my-plugin/check': (input: string) => boolean | undefined
    'my-plugin/transform': (input: string, next: () => Promise<string>) => Promise<string>
  }
}
```

之后 `ctx.on('my-plugin/ready', ...)` 与 `ctx.emit('my-plugin/ready', ...)` 自动获得类型推断。

## 命名与既有事件

- Harness 的 Cordis 事件使用 `namespace/action` 命名，例如 `agent/step`、`agent/request`、`tools/result`、`session/event`。完整签名与模式见上游子系统文档的 cordis-surface 生成区。
- `turn/*`、`step/*`、`tool/call`、`tool/result`、`compaction/*` 是**持久会话事件类型**，不是同名的 Cordis 事件。要观察它们，监听 `session/event` 并检查 `event.type`。
- 本仓库自定义事件遵循同样约定：`<plugin>/<action>`，小写，用 `/` 分隔。

## 示例：工具日志插件

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-tools'

export const name = 'tool-logger'

export function apply(ctx: Context) {
  ctx.on('tools/result', (exec, result) => {
    console.log(`[tool] ${exec.name}(${JSON.stringify(exec.arguments)})`)
    const text = result.content
      .map((block) => block.type === 'text' ? block.text : '')
      .join('')
    console.log(`[tool result] ${text.slice(0, 100)}`)
  })
}
```

## 下一步

- [spec/code.md](../spec/code.md) — 事件命名与 `@mode` 文档规范
- [bundling.md](bundling.md) — 把插件打包发布
