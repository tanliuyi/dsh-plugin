import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const template = await readFile(join(root, 'client.js'), 'utf8')
const fonts = {
  'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/cc27851ad-DDVos-BJ.woff2': 'fonts/anthropic-sans.woff2',
  'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c0f671921-DiY3GvqQ.woff2': 'fonts/anthropicons-variable.woff2',
  'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c5dbe0935-CQcSkHaI.woff2': 'fonts/anthropic-mono.woff2',
}

let bundle = template
for (const [remote, relative] of Object.entries(fonts)) {
  const bytes = await readFile(join(root, relative))
  const data = `data:font/woff2;base64,${bytes.toString('base64')}`
  bundle = bundle.replaceAll(remote, data)
}

await mkdir(join(root, 'lib'), { recursive: true })
await writeFile(join(root, 'lib', 'client.js'), bundle)
console.log('claude-visual-theme: embedded local font assets into lib/client.js')
