# 注册工具（Tool）

工具是插件暴露给模型调用的能力。通过 `ctx.tools.register()` 注册，用 `defineTool` 定义。

## 最小示例

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']  // 等待工具注册表就绪

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))
}
```

## 字段说明

| 字段 | 作用 |
| --- | --- |
| `name` | 工具名（模型调用时使用，全小写）。注册前应先确认不与现有工具冲突 |
| `description` | 工具说明，模型据此决定何时调用 |
| `parameters` | 参数 JSON Schema。`defineTool` 会根据它推断并校验 `args` 类型 |
| `output.schema` | `execute` 返回值（canonical value）的 JSON Schema |
| `output.render` | 把 canonical value 转换为模型/UI 可见的内容 |
| `execute` | 业务执行函数，返回 `output.schema` 声明的值 |

## 注意

- **JSON 兼容**：参数与返回值必须是可 JSON 序列化的数据。不要把 Service、React 元素、类实例等运行时对象塞进参数或返回值。
- **注册即 effect**：`ctx.tools.register()` 返回的注册属于当前插件 Fiber，插件停止/更新时自动移除。
- **命名冲突**：注册前用工具目录确认 `name` 未被占用；工具名冲突会破坏调用。
- **可配置性**：工具行为中任何部署间可能有差异的值都应做成配置字段（见 [config.md](config.md)）。

## 更复杂的参数

嵌套对象、数组、枚举都可以写进 `parameters`：

```ts
ctx.tools.register(defineTool({
  name: 'search',
  description: 'Search documents.',
  parameters: {
    query: { type: 'string', required: true, description: 'Search query' },
    limit: { type: 'number', description: 'Max results' },
    filters: {
      type: 'object',
      description: 'Field filters',
      properties: {
        author: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  output: {
    schema: { type: 'array', items: { type: 'string' } },
    render: (_args, value) => value.map((v) => ({ type: 'text', text: v })),
  },
  async execute(args) {
    // args 已按 parameters 校验。
    return []
  },
}))
```

## 下一步

- [config.md](config.md) — 让工具行为可配置
- [spec/code.md](../spec/code.md) — 工具命名与 JSDoc 规范
