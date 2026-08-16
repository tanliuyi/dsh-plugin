/**
 * Web 设置页的宿主侧 HTTP 路由（挂在 webServer 上）。
 *
 * 传输：浏览器端 client 插件用同源 fetch 访问，因此必须自证信任——
 * 与 dsh api-proxy 的 browser-trust fence 同款判据：Host 是回环地址，
 * 且（携带 Origin 时）Origin 与 Host 同源。默认部署绑定 127.0.0.1，
 * 回环即信任；非回环部署当前不支持（见 README 限制）。
 *
 * 路由（exact，优先于 api-proxy 注册的 /api 前缀）：
 *   GET    /api/subagents/settings → { baseline, effective, overrides, restartKeys }
 *   PUT    /api/subagents/settings → body { effective }；宿主计算与 baseline 的
 *                                    差异落盘并 live-apply
 *                                   → { applied, restartRequired, overrides, effective }
 *   DELETE /api/subagents/settings → 清除全部覆盖，live-apply 复位到 baseline
 *                                   → { overrides, effective }
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// 类型面引入即激活 cordis Context 的 webServer 服务增强。
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { SubagentsConfig } from './types.ts'
import {
  RESTART_REQUIRED_KEYS,
  applyWebValues,
  classifyOverrides,
  computeOverrides,
  extractWebValues,
  loadWebSettings,
  sanitizeWebValues,
  saveWebSettings,
  type WebSettingsOverrides,
  type WebSettingsValue,
} from './web-settings.ts'
import {
  getWatchdogUserSettingsPath,
  readSettingsFileStrict,
  resolveWatchdogConfig,
  writeSettingsFile,
} from './watchdog/settings.ts'

/** 路由挂载点。 */
export const WEB_SETTINGS_PATH = '/api/subagents/settings'

/** 回环主机名集合。 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/** 读取单个请求头（大小写不敏感）。 */
function header(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()]
  return typeof value === 'string' ? value : undefined
}

/**
 * 从 authority（host[:port] 或 IPv6 字面量）中提取主机名：
 * - "[::1]:3080" → "::1"（方括号 IPv6）
 * - "127.0.0.1:3080" / "localhost:3080" → "127.0.0.1" / "localhost"（host:port）
 * - "::1"（无端口 IPv6 字面量）→ "::1"
 */
function parseHostname(authority: string): string {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    return end === -1 ? '' : authority.slice(1, end)
  }
  const colon = authority.lastIndexOf(':')
  if (colon === -1) return authority
  const host = authority.slice(0, colon)
  const port = authority.slice(colon + 1)
  // host:port 形式：host 部分不含冒号且 port 全数字；否则整个是无端口 IPv6 字面量
  if (!host.includes(':') && /^\d+$/.test(port)) return host
  return authority
}

/**
 * 浏览器信任判据（与 dsh client-connection 的 isTrustedApiRequest 同款，
 * 外加两层强化）：
 * - 实际 TCP 对端（req.socket.remoteAddress）必须是回环地址——即使攻击者
 *   伪造 Host/Origin 头（如同机进程），非回环连接一律拒绝；
 * - 状态改变请求（POST/PUT/PATCH/DELETE）必须携带同源 Origin——CSRF 关键
 *   约束：跨站可写请求（表单 POST、fetch 简单请求）在现代与旧浏览器中都带
 *   Origin；无 Origin 的写请求一律拒绝，不依赖 sec-fetch-site 是否发送。
 *   读请求（GET/HEAD/OPTIONS）Origin 可选：携带时须同源，缺失时依赖对端
 *   回环 + Host 回环 + sec-fetch-site 判据（响应无 CORS 放行，跨站不可读）。
 *
 * 信任模型：fail-closed——任一判据不满足即 403。webServer 默认只监听回环；
 * 非回环（LAN）部署或经反向代理暴露时，代理必须保留原始回环 Host 头才会
 * 被接受（否则一律拒绝），因此本路由不应通过代理暴露给不可信来源。
 */
export function isTrustedRequest(req: IncomingMessage): boolean {
  // 1) 实际 TCP 对端必须是回环（防伪造 Host 头；IPv4-mapped IPv6 归一化）
  const rawRemote = req.socket?.remoteAddress ?? ''
  const remote = rawRemote.startsWith('::ffff:') ? rawRemote.slice('::ffff:'.length) : rawRemote
  if (!LOOPBACK.has(parseHostname(remote))) return false
  // 2) Host 头必须是回环地址
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  if (!LOOPBACK.has(parseHostname(host))) return false
  // 3) CSRF 兜底：cross-site 请求一律拒绝（现代浏览器跨站请求必带此头）
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  // 4) Origin 校验：写请求必须携带且同源；读请求携带时须同源
  const method = (req.method ?? 'GET').toUpperCase()
  const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
  const origin = header(req.headers, 'origin')
  if (origin === undefined) return !isWrite
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

/** 请求体大小上限（64KB；设置表单远小于此，防 DoS）。 */
export const MAX_BODY_BYTES = 64 * 1024

/** 读取并解析 JSON 请求体；超限或坏 JSON 返回 undefined（按 400 处理）。 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 注册设置路由。返回 disposer；仅在 webServer 可用时调用。
 * 注意：webServer 经参数传入（调用方从 `ctx.get('webServer')` 取得），
 * 因为 cordis 的 `ctx.webServer` 属性访问要求本插件显式 inject 该服务，
 * 而 webServer 在 TUI/headless profile 中不存在，不能作为必选注入。
 *
 * @param config - 内存中的有效配置（live-apply 的修改目标，即 deps.config）
 * @param baseline - 不含 web 覆盖的基线配置（apply 时快照）
 */
/** 设置页 API 的依赖面（config = live-apply 目标，baseline = 无覆盖快照）。 */
export interface WebSettingsApiDeps {
  config: SubagentsConfig
  baseline: SubagentsConfig
  home: string
}

/** API 响应：HTTP 状态码 + JSON 体。 */
export interface WebSettingsApiResult {
  status: number
  body: Record<string, unknown>
}

/**
 * 纯请求处理（与 HTTP 传输解耦，便于单测）：
 * - GET：返回 baseline/effective/overrides/restartKeys
 * - PUT：body.effective 校验 → 计算与 baseline 的差异 → 落盘 → live-apply
 * - DELETE：清空覆盖文件并复位内存配置到 baseline
 * - 其余方法：405
 */
export async function handleSettingsApi(
  method: string,
  body: unknown,
  deps: WebSettingsApiDeps,
): Promise<WebSettingsApiResult> {
  const { config, baseline, home } = deps

  // watchdog 三键与用户级 watchdog 文件（watchdog/settings.ts 的用户面）同步：
  // 设置页是用户级设置的 UI，运行时按「配置面 → 用户文件 → 项目文件 → 会话覆盖」
  // 解析，若设置页只写配置面，用户文件里的显式值会压过页面关闭（历史 bug）。
  const syncWatchdogFile = (values: WebSettingsValue, mode: 'apply' | 'clear'): void => {
    const settingsPath = getWatchdogUserSettingsPath(home)
    const file = readSettingsFileStrict(settingsPath)
    if (mode === 'clear') {
      delete file.enabled
      if (file.main && typeof file.main === 'object') {
        delete (file.main as Record<string, unknown>).model
        delete (file.main as Record<string, unknown>).thinking
      }
    } else {
      if (values.watchdogEnabled !== undefined) file.enabled = values.watchdogEnabled
      if (values.watchdogMainModel !== undefined || values.watchdogMainThinking !== undefined) {
        const main = (file.main && typeof file.main === 'object' ? file.main : {}) as Record<string, unknown>
        if (values.watchdogMainModel !== undefined) main.model = values.watchdogMainModel
        if (values.watchdogMainThinking !== undefined) main.thinking = values.watchdogMainThinking
        file.main = main
      }
    }
    writeSettingsFile(settingsPath, file)
  }

  // 设置页的 watchdog 三键显示解析后的有效值（配置面 + 文件面），与运行时一致。
  const resolvedWatchdog = (cwd: string): Record<string, unknown> => {
    const resolved = resolveWatchdogConfig(cwd, { config: deps.config.watchdog, home }).config
    return {
      watchdogEnabled: resolved.main.enabled,
      watchdogMainModel: resolved.main.model,
      watchdogMainThinking: resolved.main.thinking,
    }
  }

  if (method === 'GET') {
    const overrides = await loadWebSettings(home)
    const effective = { ...extractWebValues(config), ...resolvedWatchdog(process.cwd()) }
    return {
      status: 200,
      body: {
        baseline: extractWebValues(baseline),
        effective,
        overrides,
        restartKeys: [...RESTART_REQUIRED_KEYS],
      },
    }
  }
  if (method === 'PUT') {
    const effectiveRaw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).effective : undefined
    const result = sanitizeWebValues(effectiveRaw)
    if (!result.ok) {
      return { status: 400, body: { error: 'invalid settings value', issues: result.errors } }
    }
    const effective = result.value
    const overrides = computeOverrides(extractWebValues(baseline), effective)
    await saveWebSettings(home, overrides)
    // live-apply：applyWebValues 是整体替换语义（缺键写 undefined），因此
    // 不能直接应用 effective——未提供的键 = 表单里的「继承默认」，必须回落
    // 到 baseline 默认值，否则默认值会被 undefined 覆盖（如 asyncByDefault）。
    applyWebValues(config, { ...extractWebValues(baseline), ...effective })
    // watchdog 键若实际变化（与 baseline 不同）则同步到用户 watchdog 文件，
    // 未触碰的键不动（避免覆盖 slash 命令的配置）。
    const watchdogChanges = (['watchdogEnabled', 'watchdogMainModel', 'watchdogMainThinking'] as const).filter((key) => overrides[key] !== undefined)
    if (watchdogChanges.length > 0) {
      const picked = {} as WebSettingsValue
      for (const key of watchdogChanges) (picked as Record<string, unknown>)[key] = effective[key]
      syncWatchdogFile(picked, 'apply')
    }
    const { applied, restartRequired } = classifyOverrides(overrides)
    return { status: 200, body: { applied, restartRequired, overrides, effective: extractWebValues(config) } }
  }
  if (method === 'DELETE') {
    await saveWebSettings(home, {})
    applyWebValues(config, extractWebValues(baseline))
    syncWatchdogFile({}, 'clear')
    return { status: 200, body: { overrides: {}, effective: extractWebValues(config) } }
  }
  return { status: 405, body: { error: 'method not allowed' } }
}

export function registerWebSettingsRoute(
  ctx: Context,
  webServer: WebServer,
  deps: WebSettingsApiDeps,
): () => void {
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { error: 'forbidden: request is not browser-trusted' })
      return
    }
    const { status, body } = await handleSettingsApi(req.method ?? 'GET', await readJsonBody(req), deps)
    sendJson(res, status, body)
  }
  return webServer.register({ kind: 'exact', path: WEB_SETTINGS_PATH, handler })
}
