#!/usr/bin/env node
/**
 * 客户端 bundle 构建：把 src/client/index.ts 打包成 dsh 客户端模块系统
 * 要求的自注册脚本（lib/client.js）。
 *
 * 格式约定（见 @deepseek-ai/dsh-client-modules）：
 *   window.__ModuleLoader__.load({
 *     id: "<包名>",
 *     factory: (require) => { <CJS bundle>; return module.exports }
 *   })
 *
 * react / react/jsx-runtime 与 DSH UI primitives 是平台静态模块，作为 external；
 * 其余依赖（如有）全部内联。type-only 导入（cordis 类型等）在打包时被擦除，
 * 不会进入 bundle。
 */

import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 单一事实来源：loader 的模块 id 就是包名 spec（见 dsh-client-modules 的
// stripClientSuffix），读 package.json 避免与包名漂移。
const PKG_NAME = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name

const result = await build({
  entryPoints: [join(ROOT, 'src', 'client', 'index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  write: false,
  logLevel: 'info',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
})

// esbuild 出错时通常以 rejection 抛出，但显式检查更稳：绝不带着失败
// 结果继续写文件（否则会留下上一次成功的陈旧 lib/client.js）。
if (result.errors.length > 0) {
  for (const error of result.errors) {
    const where = error.location
      ? `${error.location.file}:${error.location.line}:${error.location.column}`
      : 'esbuild'
    console.error(`build-client: ${where}: ${error.text}`)
  }
  process.exit(1)
}
if (result.warnings.length > 0) {
  for (const warning of result.warnings) {
    console.warn(`build-client: warning: ${warning.text}`)
  }
}

const code = result.outputFiles[0]?.text
if (!code) {
  console.error('build-client: esbuild produced no output')
  process.exit(1)
}

const wrapped = [
  'window.__ModuleLoader__.load({',
  `	id: ${JSON.stringify(PKG_NAME)},`,
  '	factory: (require) => {',
  '		var module = { exports: {} };',
  '		var exports = module.exports;',
  '		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  code,
  '		return module.exports;',
  '	}',
  '});',
  '',
].join('\n')

// lib/ 是构建输出（gitignore），干净检出上可能不存在；先确保目录存在。
mkdirSync(join(ROOT, 'lib'), { recursive: true })
writeFileSync(join(ROOT, 'lib', 'client.js'), wrapped)
console.log('build-client: wrote lib/client.js')
