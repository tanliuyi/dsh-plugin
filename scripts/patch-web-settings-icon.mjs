#!/usr/bin/env node
/**
 * 把设置面板导航里 `subagents` 分区的图标从默认齿轮改为智能体图标。
 *
 * 背景：dsh rc.6 的 web 外壳把设置导航图标硬编码在 shell 客户端模块
 * `@deepseek-ai/dsh-client-ui-settings-general` 的 `navIcon(id)` 里——
 * 只映射 models / agent-presets / plugins，其余 id（含 subagents）回退到
 * 设置齿轮图标。`settings.section` 的注册契约只有 id/order/label，插件侧
 * 没有任何挂点能指定导航图标，因此只能补丁 shell 客户端模块。
 *
 * 本脚本幂等：找到已打补丁则直接成功退出。dsh 升级/重装后重新运行一次即可
 * 恢复（补丁打在全局安装的 node_modules 里，不随本仓库持久化）。
 *
 * 用法：
 *   node scripts/patch-web-settings-icon.mjs
 * 或（指定 dsh 安装位置，默认从 `npm root -g` 推导）：
 *   DSH_SETTINGS_UI_FILE=/path/to/dsh-client-ui-settings-general/lib/client.js \
 *     node scripts/patch-web-settings-icon.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

/** 要插入的 navIcon 分支（与文件既有风格一致：3 层 tab 缩进）。 */
const SUBAGENTS_CASE = `\t\t\tif (id === "subagents") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconAgentPresetOutline16, {
\t\t\t\tclassName: SettingsRoot_module_css_default.navIcon,
\t\t\t\tsize: 16
\t\t\t});\n`

/** 回退分支（gear）起始两行——插入点之前的唯一锚点。 */
const ANCHOR = `\t\t\treturn (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutline16, {\n\t\t\t\tclassName: SettingsRoot_module_css_default.navIcon,`

/** 已补丁标志。 */
const PATCHED_MARK = `id === "subagents"`

function findTarget() {
  if (process.env.DSH_SETTINGS_UI_FILE) {
    if (!existsSync(process.env.DSH_SETTINGS_UI_FILE)) {
      throw new Error(`DSH_SETTINGS_UI_FILE 不存在：${process.env.DSH_SETTINGS_UI_FILE}`)
    }
    return process.env.DSH_SETTINGS_UI_FILE
  }
  const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim()
  if (!npmRoot) throw new Error('无法获取 npm 全局根目录（npm root -g）')
  const rel = 'lib/client.js'
  const candidates = [
    join(npmRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-general', rel),
    join(npmRoot, '@deepseek-ai', 'dsh-client-ui-settings-general', rel),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`未找到 dsh-client-ui-settings-general 客户端模块，请用 DSH_SETTINGS_UI_FILE 指定。已尝试：\n${candidates.join('\n')}`)
}

const target = findTarget()
const source = readFileSync(target, 'utf8')

if (source.includes(PATCHED_MARK)) {
  console.log(`✅ 已打过补丁（${target}）`)
  process.exit(0)
}

if (!source.includes(ANCHOR)) {
  throw new Error(`未找到 navIcon 回退分支锚点，外壳版本可能已变更：${target}`)
}

const patched = source.replace(ANCHOR, SUBAGENTS_CASE + ANCHOR)
if (patched === source) {
  throw new Error('补丁未生效（替换无变化），请人工检查锚点')
}
writeFileSync(target, patched)
console.log(`✅ 已把 subagents 设置导航图标改为智能体图标：\n   ${target}`)
console.log('   刷新 Web UI（http://127.0.0.1:3080）后生效；dsh 升级后重新运行本脚本。')
