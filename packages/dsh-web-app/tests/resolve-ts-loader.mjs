/** 仅用于本地单元测试的 ESM loader：把「相对路径、无扩展名的 .ts 源码导入」解析为
 *  Web 源码目录里的同名 .ts 文件（如 store.ts 的 `import ... from './api'`）。
 *  生产构建（tsc/vite）不受影响；node --test 默认 type-stripping 不重写 import 说明符。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
    const candidates = [`${specifier}.ts`, `${specifier}/index.ts`]
    for (const candidate of candidates) {
      try {
        return await nextResolve(candidate, context)
      } catch {
        // try the next candidate
      }
    }
  }
  return nextResolve(specifier, context)
}
