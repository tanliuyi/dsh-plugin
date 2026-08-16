/* 官方 UI 端到端：新建 → 发送 → 回复。 */
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

await page.goto('http://127.0.0.1:3090', { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)

console.log('thread list items:', await page.locator('[data-slot="aui_thread-list-item"]').count())
console.log('composer:', await page.locator('.aui-composer-input').count())
console.log('send btn:', await page.getByRole('button', { name: 'Send message' }).count())

// 打开一个非活跃会话看历史
await page.locator('[data-slot="aui_thread-list-item"]').nth(2).click()
await page.waitForTimeout(4000)
const msgs = await page.locator('[data-slot="aui_user-message-root"], [data-slot="aui_assistant-message-root"]').count()
console.log('messages loaded:', msgs)
console.log('tool cards:', await page.locator('[data-slot="aui_assistant-message-tool"]').count())

// 新建会话 → 发送
await page.getByRole('button', { name: 'New thread' }).click()
await page.waitForTimeout(1500)
const input = page.locator('.aui-composer-input')
await input.fill('只回复 pong，不要调用任何工具。')
await input.press('Enter')

const deadline = Date.now() + 120000
let reply = ''
while (Date.now() < deadline) {
  const texts = await page.locator('.aui-md').allTextContents()
  const running = await page.getByRole('button', { name: 'Stop generating' }).count()
  if (texts.length > 0) reply = texts[texts.length - 1].trim()
  if (running === 0 && reply.length > 0) break
  await page.waitForTimeout(2000)
}
console.log('REPLY:', JSON.stringify(reply.slice(0, 100)))
console.log('errors:', errors.length ? errors.slice(0, 3) : 'none')
await browser.close()
