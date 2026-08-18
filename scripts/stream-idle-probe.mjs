// 验证：host 流上的 remote-event 不再触发全量 session.list 刷新
// 统计一段时间内 /api/session.list 与 /api/session.models 的请求次数
import { chromium } from 'playwright'
const BASE = 'http://localhost:5173'
const CHROME = 'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe'
const browser = await chromium.launch({ executablePath: CHROME })
const page = await browser.newPage()
const counts = { list: 0, models: 0, other: 0 }
page.on('request', (req) => {
  const url = req.url()
  if (url.includes('/api/session.list')) counts.list++
  else if (url.includes('/api/session.models')) counts.models++
  else if (url.includes('/api/')) counts.other++
})
try {
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForSelector('[data-slot="aui_thread-startup-loading"]', { state: 'detached', timeout: 30_000 }).catch(() => {})
  const input = page.locator('.aui-composer-input').first()
  await input.waitFor({ state: 'visible', timeout: 30_000 })
  // 先建会话触发运行
  await page.evaluate(async () => {
    const { useDsh } = await import('/src/dsh/store.ts')
    const s = useDsh.getState()
    if (!s.currentSessionId) await s.createSession(false)
  })
  await page.waitForTimeout(4000)
  const baseline = { ...counts }
  // 空闲 8s：若 remote-event 会触发全量刷新，session.list 会持续增长
  await page.waitForTimeout(8000)
  const idle = { ...counts }
  const listDelta = idle.list - baseline.list
  const modelsDelta = idle.models - baseline.models
  console.log(`baseline: ${JSON.stringify(baseline)}`)
  console.log(`after 8s idle: ${JSON.stringify(idle)}`)
  console.log(`RESULT: session.list delta=${listDelta}, session.models delta=${modelsDelta}`)
  const ok = listDelta <= 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  idle keeps session.list stable（remote-event 不再触发全量刷新）`)
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.log('异常:', e instanceof Error ? e.message : String(e))
  process.exit(1)
} finally {
  await browser.close()
}