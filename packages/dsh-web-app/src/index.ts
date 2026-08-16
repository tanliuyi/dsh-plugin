/**
 * @dsh-plugins/dsh-web-app 主插件（host half）：独立 Web UI 的运行时 glue。
 *
 * 职责：
 * 1. 占住 webserver 的 fallback seat，服务本包 web/ 下的静态 SPA
 *    （index.html + assets），与官方 dsh-host-frontend-static 同语义：
 *    traversal 拒绝、SPA index 回落、未知扩展 octet-stream、非 GET/HEAD 405。
 * 2. 打印 URL 行（就绪信号）。
 *
 * 不注入 __DSH_BOOT__、不挂 client-modules、不加载任何 ui-* 包：
 * 前端是独立 SPA，通过 /api 协议与 host 通信。
 */

import { readFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** 稳定插件名（patch 行 id: web-runtime）。 */
export const name = 'dsh-web-app'

/** 服务依赖：webserver（挂 fallback）与 webStartup（host/port/trustedHosts）。 */
export const inject = ['webServer', 'webStartup']

/** 独立前端 dist 根：本包 web/dist（Vite 构建产物）。 */
const DIST_ROOT = fileURLToPath(new URL('../web/dist', import.meta.url))

/** 插件配置：是否打印 URL 行。 */
export interface Config {
  printUrl?: boolean
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/** 服务一次 GET/HEAD 静态请求（或 SPA 回落 index.html）。 */
export async function serveStatic(
  pathname: string,
  res: ServerResponse,
  distRoot: string,
  distIndex: string,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  const serveIndex = async (): Promise<void> => {
    const body = await readFile(distIndex)
    res.writeHead(200, { 'content-type': MIME['.html'] })
    res.end(body)
  }
  if (target === distRoot || target === distIndex) {
    await serveIndex()
    return
  }
  try {
    const body = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    await serveIndex()
  }
}

/** 挂 fallback + 打印 URL。 */
export function apply(ctx: Context, config?: Config): void {
  const distIndex = join(DIST_ROOT, 'index.html')
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const rawPath = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    await serveStatic(decodeURIComponent(rawPath), res, DIST_ROOT, distIndex)
  }), 'dsh-web-app: fallback seat')

  if (config?.printUrl !== false) {
    // 就绪信号：loader 沉降后打印（与官方 web-app 同语义，简化版直接打印）。
    const settled = ctx.get('loader')?.await()
    const printUrl = (): void => {
      const port = ctx.get('webServer')?.port
      if (port === undefined) return
      console.log(`dsh wui: http://127.0.0.1:${String(port)}`)
    }
    if (settled === undefined) printUrl()
    else void settled.then(printUrl, () => {})
  }
}
