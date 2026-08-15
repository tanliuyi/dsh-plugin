# 测试

插件测试分两层：**单元测试**（直接驱动插件模块）与**集成验证**（在真实 profile 组合中启动）。

## 单元测试

使用 Node 内置测试运行器（`node:test`）保持零额外依赖；源码是 TS，用 `tsx` 跑测试：

```json
{
  "scripts": {
    "test": "tsx --test tests/**/*.test.ts"
  },
  "devDependencies": {
    "tsx": "^4.0.0"
  }
}
```

### 驱动插件

在测试中构造一个 Cordis 上下文（或 mock 注入的服务），加载插件模块并调用 `apply`，然后断言注册效果：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('greet tool registers', async () => {
  const { apply, name } = await import('../src/index.ts')
  assert.equal(name, 'example-hello')

  const registered: any[] = []
  const ctx = {
    on() {},
    effect() {},
    get: (key: string) => key === 'tools' ? { register: (t: any) => registered.push(t) } : undefined,
  } as any

  await apply(ctx, { greeting: 'Hello' })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'greet')
  assert.equal(await registered[0].execute({ name: 'Ada' }), 'Hello, Ada!')
})
```

要点：

- 断言**注册效果**（工具列表、监听器、服务方法），而不是只断言 apply 没抛错；
- 用 `node:test` 的 mock（`mock.method`）或手写 stub 注入服务；
- 对纯函数（工具 `execute`、渲染函数）做直接输入/输出断言；
- 覆盖配置默认值与非法配置：非法配置应在加载期抛错。

## 集成验证

在真实组合中验证配置层与加载：

```sh
# 构建后查看组合中本包的层
dsh --profile demo --dump-config

# 启动并观察加载日志 / 调用工具
dsh --profile demo
```

CI 中至少跑：

```sh
pnpm docs:check   # 文档与规范符合性门禁（含 INDEX.md 漂移检查）
pnpm -r test      # 全部包的单测
```

## 规范要求

- 每个插件包必须提供 `test` 脚本（可无用例，但必须可运行）；
- 对外公开的纯函数/渲染器必须有直接用例；
- 配置 Schema 必须有默认值与非法输入的用例。

见 [spec/package.md](../spec/package.md) 与 [spec/code.md](../spec/code.md)。
