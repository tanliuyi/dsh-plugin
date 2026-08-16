/**
 * 把本包的 client bundle 注册进 web 外壳的客户端模块表（clientModules）。
 *
 * 背景：dsh rc.6 的 dsh.client 扫描（dsh-client-modules 的 processOne）经
 * loader 的 baseUrl（profile 目录）解析包清单——包只要导出 `./package.json`
 * 即可被原生发现，无需 NODE_PATH。本模块是防御性兜底：若扫描因故未收录本包
 * （如未来版本改变解析基准），把本包行直接写入 clientModules 表
 * （table/composed/compose/notifyGraphChanged 均为该服务的公开成员），
 * 扫描器对已在表中的行保持不动（processOne 命中后直接返回）。
 *
 * 若未来 dsh 版本改动了表结构，本函数在 try/catch 下安静失败，不影响路由；
 * 原生扫描路径（经 loader baseUrl 解析）不受本兜底影响。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

// 注意：URL 的 '..' 语义与文件系统不同——从 lib/web-client.js（或 src/web-client.ts）
// 出发，'../package.json' 才指向包根（'../../package.json' 会多跳一级到 packages/）。
const PACKAGE_JSON = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name?: string
  dsh?: { client?: { inject?: string[]; immediately?: boolean } }
  exports?: Record<string, { default?: string } | string>
}

/** 本包名（client 模块 id；单一事实来源 = package.json）。 */
export const CLIENT_PACKAGE_NAME: string = PACKAGE_JSON.name ?? '@dsh-plugins/dsh-subagents'

interface ClientModuleRegistryFace {
  table: Map<string, { entry: Record<string, unknown>; clientPath: string }>
  composed: unknown
  compose(): unknown
  notifyGraphChanged(): void
  initialBundleRevision(pkgName: string, clientPath: string): string
}

function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/** 读取本包的 dsh.client 声明与 client 导出（单一事实来源，与 package.json 一致）。 */
export function readClientDeclaration(): { clientPath: string; inject?: string[]; immediately: boolean } | undefined {
  const decl = PACKAGE_JSON.dsh?.client
  const clientExport = PACKAGE_JSON.exports?.['./client']
  const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
  if (!decl || typeof clientRel !== 'string') return undefined
  return {
    clientPath: fileURLToPath(new URL(`../${clientRel}`, import.meta.url)),
    inject: decl.inject,
    immediately: decl.immediately === true,
  }
}

/**
 * 注册 client bundle 行。返回：
 * - 'registered'：本包已写入/已在表中（零配置生效）
 * - 'no-registry'：当前组合无 clientModules（TUI/headless）
 * - 'unavailable'：bundle 未构建或注册失败（原生扫描仍可能已收录本包）
 */
export function registerClientBundle(ctx: Context): 'registered' | 'no-registry' | 'unavailable' {
  const registry = ctx.get('clientModules') as ClientModuleRegistryFace | undefined
  if (!registry || !registry.table) return 'no-registry'
  if (registry.table.has(CLIENT_PACKAGE_NAME)) return 'registered'
  const declaration = readClientDeclaration()
  if (!declaration) return 'unavailable'
  try {
    readFileSync(declaration.clientPath) // 未构建时抛错，走 unavailable
    const rev = registry.initialBundleRevision(CLIENT_PACKAGE_NAME, declaration.clientPath)
    registry.table.set(CLIENT_PACKAGE_NAME, {
      entry: {
        id: CLIENT_PACKAGE_NAME,
        url: `/plugins/${CLIENT_PACKAGE_NAME}/client.js?rev=${rev}`,
        rev,
        ...declaration.inject !== undefined ? { inject: declaration.inject } : {},
        ...declaration.immediately ? { immediately: true } : {},
      },
      clientPath: declaration.clientPath,
    })
    registry.composed = registry.compose()
    registry.notifyGraphChanged()
    return 'registered'
  } catch {
    return 'unavailable'
  }
}
