/* 验证滚动 + 发送全流程。 */
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

await page.goto('http://127.0.0.1:3090', { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)

// 打开大会话
await page.locator('[data-slot="aui_thread-list-item"]').nth(2).click()
await page.waitForTimeout(5000)

// 1. 滚动到顶部再检查 scrollTop 变化
const vp = page.locator('[data-slot="aui_thread-viewport"]')
const canScroll = await vp.evaluate((el) => el.scrollHeight > el.clientHeight)
console.log('can scroll:', canScroll)
if (canScroll) {
  await vp.evaluate((el) => { el.scrollTop = 0 })
  await page.waitForTimeout(300)
  const top = await vp.evaluate((el) => el.scrollTop)
  await vp.evaluate((el) => { el.scrollTop = 500 })
  await page.waitForTimeout(300)
  const mid = await vp.evaluate((el) => el.scrollTop)
  console.log('scrollTop: top=', top, 'after scroll=', mid)
}

// 2. 新建会话发送 pong
await page.getByRole('button', { name: 'New thread' }).click()
await page.waitForTimeout(1500)
await page.locator('.aui-composer-input').fill('只回复 pong')
await page.locator('.aui-composer-input').press('Enter')
const deadline = Date.now() + 120000
let ok = false
while (Date.now() < deadline) {
  const running = await page.getByRole('button', { name: 'Stop generating' }).count()
  const texts = await page.locator('[data-slot="aui_assistant-message-root"]').allTextContents()
  if (running === 0 && texts.some((t) => t.includes('pong'))) { ok = true; break }
  await page.waitForTimeout(2000)
}
console.log('pong reply:', ok)
console.log('errors:', errors.length ? errors.slice(0, 2) : 'none')
await browser.close()
