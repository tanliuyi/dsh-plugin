# 插件配置（Config）

插件通过 `cordis.yml` / `cordis.patch.yml` 接收用户配置。配置用 Schemastery Schema 声明，加载时校验并填充默认值。

## 定义 Config

导出同名的 `Config` 类型与 Schema，默认值直接写在 Schema 字段上：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

export interface Config {
  greeting: string
  maxRetries: number
  verbose?: boolean
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) {
  console.log(config.greeting)  // 用户值或 Schema 默认值
}
```

> 不要导出普通对象作为 `Config`——它不实现 Cordis 需要的 Standard Schema 接口。

## 在配置层传参

```yaml
- insert:
    - id: hello
      name: '@dsh-plugins/my-plugin'
      config:
        greeting: 'Hi there'
        maxRetries: 5
```

## 严格校验

```ts
export const Config = Schema.object({
  apiKey: Schema.string().required(),
  timeout: Schema.number().default(30000),
  mode: Schema.union(['fast', 'accurate']).default('fast'),
})
```

Schema 在插件加载时执行，配置非法会让加载失败并给出可操作的错误信息。

## 设计原则

### 可配置值不做硬编码

**任何两个部署可能想设置成不同值的量都必须是配置字段**。判据：`cordis.yml` 能否不改代码就改变该值。

```ts
// 错误：硬编码超时
const TIMEOUT = 30000

// 正确：可配置
export interface Config {
  timeoutMs: number  // 默认 30000
}
```

### 非法配置尽早失败

自包含的约束（取值范围、必填、枚举）写进 Schema，让非法配置在加载期失败，而不是运行期炸掉。引用服务或已注册资源的不变量则需要依赖注入（见 [services.md](services.md)）。

### 覆盖是整体替换

配置层按行覆盖：后层覆盖前层时，`config` 是**整体替换**而不是深合并。因此：

- 本包覆盖其他包的行时，必须重述该行需要的全部 key，而非只写改动的 key；
- 用户在其 profile 的 `cordis.patch.yml` 中可覆盖本包的行，所以默认值要选用户大概率保留的值，其余交给 Schema 兜底。

## 与 HMR

编辑配置会热替换插件：框架卸载旧实例、加载新实例。因为注册都是 effect 且会自清理，替换不会残留旧实例的注册。

## 下一步

- [services.md](services.md) — 把依赖的服务注入配置校验流程
- [spec/code.md](../spec/code.md) — 配置 Schema 的 JSDoc 规范
