/**
 * @dsh-plugins/dsh-web-app startup provider：解析独立 Web app 的命令行
 * 参数（--host / --port / --trusted-host），发布为 webStartup 服务。
 *
 * 与官方 @deepseek-ai/dsh-web-app/startup 同契约，但不依赖 dsh-web-app：
 * 手写解析，不引入 commander / parseCmdline。
 */

import type { Context } from '@deepseek-ai/cordis'

/** 稳定插件名（patch 行 id: web-startup）。 */
export const name = 'web-startup'

/** 服务依赖：launcher 提供的不可变命令行快照。 */
export const inject = ['cmdlineArgs']

/** webStartup 服务的值形状（webserver 行读 host/port，connection 行读 trustedHosts）。 */
export interface WebStartupValues {
  /** --host，未传时缺省（webserver 行回落到 127.0.0.1）。 */
  host?: string
  /** --port，未传时缺省（webserver 行回落到 3090）。 */
  port?: number
  /** --trusted-host 权威列表（host 或 host:port），按参数顺序。 */
  trustedHosts: string[]
}

/** 本服务在 ctx 上的键（patch 行以 `ctx.webStartup.*` 引用）。 */
export const WEB_STARTUP_SERVICE = 'webStartup'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webStartup?: WebStartupValues
  }
}

/** 解析独立 Web app 的参数快照（与官方同语义的子集）。 */
export function parseWebArgs(args: readonly string[]): WebStartupValues {
  let host: string | undefined
  let port: number | undefined
  const trustedHosts: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const next = (): string | undefined => args[i + 1]
    if (arg === '--host') {
      const value = next()
      if (value === undefined) throw new Error('web-startup: --host requires a value')
      i += 1
      host = value
    } else if (arg === '--port') {
      const value = next()
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error(`web-startup: --port must be a number, got ${JSON.stringify(value)}`)
      }
      i += 1
      port = Number(value)
    } else if (arg === '--trusted-host') {
      const value = next()
      if (value === undefined) throw new Error('web-startup: --trusted-host requires a value')
      i += 1
      trustedHosts.push(value)
    }
    // 其他参数忽略：独立 app 暂不定义更多旗标。
  }
  return {
    ...(host !== undefined && { host }),
    ...(port !== undefined && { port }),
    trustedHosts,
  }
}

/** 发布 webStartup（launcher 参数缺失时提供空值，让 webserver 行落到默认值）。 */
export function apply(ctx: Context): void {
  const cmdline = ctx.get('cmdlineArgs')
  const args = cmdline?.get() ?? []
  const values = parseWebArgs(args)
  ctx.provide(WEB_STARTUP_SERVICE, values)
}
