# 代码规范

## 类型与构建

- 源码为 TypeScript，必须通过 `tsc` 严格模式构建（`strict: true`，见示例包 `tsconfig.json`）。
- 所有包 `pnpm build` 零错误是 CI 门禁。
- 插件是普通 TS 模块：导出 `apply`（以及可选 `name`/`inject`/`Config`）。类形态仅用于提供服务。

## JSDoc 完整性

**导出 API 必须有完整 JSDoc**——这不仅是文档要求，更是生成 API 目录的前提（上游仓库对此有 JSDoc 完整性门禁）。要求：

- 每个导出函数/类/接口/常量：`/** 一句话说明 + 可选 @param/@returns */`；
- 每个事件声明（declaration merging 的 `Events` 接口成员）：说明事件含义与**派发模式**（`@mode emit|bail|serial|parallel|waterfall`），模式是事件公开契约的一部分；
- 每个服务公开方法：说明行为与参数/返回值。

示例：

```ts
/**
 * 注册一个问候工具。
 * @param ctx - 插件上下文
 * @param config - 插件配置
 */
export function apply(ctx: Context, config: Config) { /* ... */ }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 插件就绪通知。
     * @mode emit
     */
    'my-plugin/ready': (payload: { id: string }) => void
  }
}
```

## 生命周期与副作用

- **注册即 effect**：一切通过 `ctx` 注册的监听器、工具、服务、定时器在卸载时自动回收；不要 `removeListener`/`clearInterval` 手动清理（除非是 disposer 语义）。
- 外部订阅/连接用 `ctx.effect(() => { …; return disposer })` 提供回收。
- 依赖清理顺序时，把相关清理放进**同一个** `ctx.effect()` 的 disposer 中串行 await；不要把顺序敏感的清理拆到多个并发 disposer。
- 禁止模块级/`apply` 外的进程级或页面级副作用。
- 不要在插件里直接 `setTimeout`/`setInterval`——用 `timer` 服务（`inject: ['timer']`，`ctx.timeout`/`ctx.interval`）。

## 依赖声明

- 必需服务用 `inject` 声明；可选能力用 `ctx.get(name)` + 缺失检查。
- 不声明 `inject` 就别用 `ctx.xxx` 直接访问（会被 Guard 拒绝）。
- 不要为了省一个 undefined 检查滥用 `inject`。

## 行为约定

- **可配置值不做硬编码**：任何两个部署可能想设成不同值的量都是配置字段（判据：`cordis.yml` 能否不改代码改变它）。
- **非法配置 fail loudly**：自包含约束写进 Schema，加载期失败。
- **JSON 边界**：工具参数/返回值、RPC 载荷、事件载荷必须是可 JSON 序列化的标量/普通对象；禁止传 Service、React 元素、类实例、Context。
- **不枚举/序列化内部活数据**：Service 实例、事件载荷、会话快照等 DSH 内部对象，只取当前功能需要的叶子字段，不整体 `JSON.stringify`/`structuredClone`/复制。
- **覆盖是整体替换**：patch 覆盖别包的行时重述全部 key（见 development/config.md）。
- 工具注册前确认工具名不冲突；事件名遵循 `<plugin>/<action>`。

## 错误处理

- 预期内的失败返回结构化结果，不要吞异常；抛错要让错误信息可操作（"哪个配置非法、怎么改"）。
- 异步注册/清理要 await 完成，避免未处理的 rejection。
