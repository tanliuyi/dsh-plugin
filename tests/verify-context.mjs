/* 验证：注入消息折叠为 context 行，用户消息保持气泡。 */
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

await page.goto('http://127.0.0.1:3090', { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)

// 打开含注入的会话（第 3 个）
await page.locator('[data-slot="aui_thread-list-item"]').nth(2).click()
await page.waitForTimeout(5000)

const ctxRows = await page.locator('[data-slot="aui_context-injection"]').count()
const userMsgs = await page.locator('[data-slot="aui_user-message-root"]').count()
const longTexts = await page.locator('.aui_user-message-root p').evaluateAll((ps) =>
  ps.filter((p) => (p.textContent ?? '').length > 300).length,
)

console.log('context rows:', ctxRows)
console.log('user messages:', userMsgs)
console.log('long user paragraphs (>300):', longTexts)
if (ctxRows > 0) {
  const first = await page.locator('[data-slot="aui_context-injection"]').first().textContent()
  console.log('first context row:', JSON.stringify(first?.trim().slice(0, 100)))
}
console.log('errors:', errors.length ? errors.slice(0, 2) : 'none')
await browser.close()
