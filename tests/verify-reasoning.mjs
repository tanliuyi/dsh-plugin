/* 验证 reasoning 折叠渲染 + 正文分离。 */
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

await page.goto('http://127.0.0.1:3090', { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)

// 新建会话 → 发一个会触发思考的请求
await page.getByRole('button', { name: 'New thread' }).click()
await page.waitForTimeout(1500)
await page.locator('.aui-composer-input').fill('你好，请简单介绍一下你自己。')
await page.locator('.aui-composer-input').press('Enter')

// 等回复完成
const deadline = Date.now() + 120000
let done = false
while (Date.now() < deadline) {
  const running = await page.getByRole('button', { name: 'Stop generating' }).count()
  const msgs = await page.locator('[data-slot="aui_assistant-message-root"]').count()
  if (running === 0 && msgs > 0) { done = true; break }
  await page.waitForTimeout(2000)
}
console.log('reply done:', done)

// 检查正文是否包含 JSON 序列化的 reasoning
const markdown = await page.locator('.aui-md').allTextContents()
const leaked = markdown.some((t) => t.includes('"type":"reasoning"') || t.includes('{"type":"reasoning'))
console.log('reasoning JSON leaked into text:', leaked)
console.log('markdown blocks:', markdown.length, markdown.map((t) => t.slice(0, 40)))
console.log('errors:', errors.length ? errors.slice(0, 2) : 'none')
await browser.close()
