import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const src = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

// 独立前端：无 window.__DSH_BOOT__、无 dsh client 运行时，直连 /api。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: src('.'),
  base: '/',
  resolve: {
    alias: {
      '@': src('src'),
    },
  },
  build: {
    outDir: src('dist'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // 本地开发：代理 /api 到独立 profile（dsh wui）。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3090',
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          const rewriteTrustHeaders = (proxyReq: { setHeader(name: string, value: string): void }) => {
            proxyReq.setHeader('host', '127.0.0.1:3090')
            proxyReq.setHeader('origin', 'http://127.0.0.1:3090')
          }
          proxy.on('proxyReq', rewriteTrustHeaders)
          proxy.on('proxyReqWs', rewriteTrustHeaders)
        },
      },
    },
  },
})
