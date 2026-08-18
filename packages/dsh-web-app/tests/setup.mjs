// 让 node --test 能加载 Web 源码里的 .ts 模块：注册本地 resolver，
// 把「相对路径、无扩展名」的源码内 import（如 store.ts 的 './api'）解析为同名 .ts。
import { register } from 'node:module'
register(new URL('./resolve-ts-loader.mjs', import.meta.url))
