import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * 插件名：example-hello。
 */
export const name = 'example-hello'

/**
 * 插件依赖：等待工具注册表（ctx.tools）就绪。
 */
export const inject = ['tools']

/**
 * 插件配置。
 */
export interface Config {
  /** 问候语模板，`greet` 工具用它拼接输出。 */
  greeting: string
}

/**
 * 插件配置 Schema：加载时校验并填充默认值。
 */
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
})

/**
 * 插件入口：注册一个 `greet` 工具。
 * @param ctx - 插件上下文（`ctx.tools` 已就绪）
 * @param config - 插件配置
 */
export function apply(ctx: Context, config: Config) {
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
      return `${config.greeting}, ${args.name}!`
    },
  }))
}
