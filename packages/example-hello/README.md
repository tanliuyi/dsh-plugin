# @dsh-plugins/example-hello

示例插件：注册一个 `greet` 工具，演示工具注册、配置 Schema 与 Bundle 打包。新插件以此包为骨架。

## 安装

```sh
# 本仓库内（本地路径）
dsh plugin --profile demo add ./packages/example-hello

# 发布后（npm registry）
dsh plugin --profile demo add @dsh-plugins/example-hello
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `greeting` | string | `'Hello'` | 问候语模板，`greet` 工具用它拼接输出 |

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: example-hello
  name: '@dsh-plugins/example-hello'
  config:
    greeting: 'Hi there'
```

## 使用

启动后向模型提问："Use the greet tool to greet Ada."，工具返回 `Hello, Ada!`（或配置的问候语）。

## 开发

```sh
pnpm build   # tsc → lib/
pnpm test    # node:test + tsx
```
