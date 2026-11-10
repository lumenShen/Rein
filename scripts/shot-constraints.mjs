/** 个人约束抽屉重设计验证：默认态 / 忌口选中态 / 滚动到底 / 桌面窄窗 */
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 430, height: 932 } })
await page.goto('http://localhost:1437/#/me', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
// 更新弹层挡点击：藏掉（与 shot-addworkout 同款处理）
await page.evaluate(() => {
  for (const sel of ['.up-backdrop', '.up-card']) {
    for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
  }
})
await page.waitForTimeout(200)

// 打开个人约束抽屉（关于你 › 健康大卡里的「编辑」）
await page.locator('[data-testid="about-constraints-edit"]').click()
await page.waitForTimeout(700)

// 拖到最大档
const handle = page.locator('.grabber-zone')
const box = await handle.boundingBox()
await page.mouse.move(box.x + box.width / 2, box.y + 10)
await page.mouse.down()
await page.mouse.move(box.x + box.width / 2, 100, { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(900)

const h = await page.locator('.panel').evaluate((el) => el.getBoundingClientRect().height)
console.log('展开后抽屉高度: ' + Math.round(h))
console.log('底部保存条存在: ' + (await page.locator('.foot').count()))

// 顶部整貌
await page.screenshot({ path: 'docs/shots/constraints-top.png' })

// 点几个忌口预设 + 添加一个自定义，看选中态
await page.locator('.chip', { hasText: '海鲜' }).first().click()
await page.locator('.chip', { hasText: '坚果' }).first().click()
await page.locator('.cinput').fill('芒果')
await page.locator('.cinput').press('Enter')
await page.waitForTimeout(400)

// 滚到底（忌口区 + 钉底保存）
await page.locator('.body').evaluate((el) => el.scrollTo(0, el.scrollHeight))
await page.waitForTimeout(500)
await page.screenshot({ path: 'docs/shots/constraints-bottom.png' })

// 溢出体检：横向滚动 + 卡内文本溢出
const overflow = await page.locator('.body').evaluate((el) => ({
  scrollW: el.scrollWidth,
  clientW: el.clientWidth,
  scrollH: el.scrollHeight,
  clientH: el.clientHeight,
}))
console.log('body 横向溢出: ' + (overflow.scrollW > overflow.clientW ? '有 ' + overflow.scrollW + '>' + overflow.clientW : '无'))

// ---- 功能回环：设生日（验证日随月收口）→ 保存 → 重开抽屉回读 ----
await page.locator('.body').evaluate((el) => el.scrollTo(0, 0))
await page.waitForTimeout(300)
const setSel = ([label, val]) => {
  const sel = document.querySelector(`.bsel[aria-label="${label}"]`)
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(sel, val)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
}
await page.evaluate(setSel, ['出生年份', '1996'])
await page.evaluate(setSel, ['出生月份', '2'])
await page.waitForTimeout(150)
const dayCount = await page.locator('.bsel[aria-label="出生日"] option').count()
console.log('1996年2月 日期选项数(含占位,应为30): ' + dayCount)
await page.evaluate(setSel, ['出生日', '29'])
await page.waitForTimeout(150)
await page.locator('.save').click()
await page.waitForTimeout(900)
console.log('保存后抽屉关闭: ' + ((await page.locator('.panel').count()) === 0))
await page.locator('[data-testid="about-constraints-edit"]').click()
await page.waitForTimeout(600)
const back = await page.evaluate(() => ({
  y: document.querySelector('.bsel[aria-label="出生年份"]')?.value,
  m: document.querySelector('.bsel[aria-label="出生月份"]')?.value,
  d: document.querySelector('.bsel[aria-label="出生日"]')?.value,
}))
console.log('重开回读生日(应 1996/2/29): ' + JSON.stringify(back))
await page.screenshot({ path: 'docs/shots/constraints-reopen.png' })

// ---- 暗色模式 ----
const dark = await browser.newPage({ viewport: { width: 430, height: 932 }, colorScheme: 'dark' })
await dark.goto('http://localhost:1437/#/me', { waitUntil: 'networkidle' })
await dark.waitForTimeout(1000)
await dark.evaluate(() => {
  for (const sel of ['.up-backdrop', '.up-card']) {
    for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
  }
})
await dark.locator('[data-testid="about-constraints-edit"]').click()
await dark.waitForTimeout(700)
await dark.screenshot({ path: 'docs/shots/constraints-dark.png' })
await browser.close()
