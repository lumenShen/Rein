#!/usr/bin/env node
/**
 * 下载 HarmonyOS 设计文档里的全部配图（images.json 里的原图 URL）。
 *
 * 为什么单独一个脚本：这些图是判断「间距 / 圆角 / 字号」到底怎么落地的唯一依据 ——
 * 文档正文只给数值表，配图才看得出「卡片里 12 到底是哪两个块之间」。
 * 上一次只手工存了 13 张，剩下 90 张没看过，等于规范只读了一半。
 *
 * 用法：node scripts/fetch-hw-images.mjs [--force]
 * 产物：docs/design/huawei/img-all/<doc 短名>-<序号>.<ext>（已存在则跳过）
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'docs/design/huawei'
const OUT = join(ROOT, 'img-all')
const FORCE = process.argv.includes('--force')

const SHORT = {
  'interval-parameter-0000002562577161': 'interval',
  'corner-radius-parameter-0000002556468705': 'radius',
  'typography-0000002622688363': 'type',
  'general_overview-0000001929599380': 'overview',
}

const list = JSON.parse(readFileSync(join(ROOT, 'images.json'), 'utf8'))
mkdirSync(OUT, { recursive: true })

let saved = 0
let skipped = 0
const failed = []

for (const item of list) {
  const short = SHORT[item.id] ?? 'doc'
  const idx = String(item.idx).padStart(2, '0')
  const guessExt = /\.png(\?|$)/i.test(item.url) ? 'png' : 'jpg'
  const base = join(OUT, `${short}-${idx}`)
  if (!FORCE && (existsSync(`${base}.${guessExt}`) || existsSync(`${base}.png`) || existsSync(`${base}.jpg`))) {
    skipped += 1
    continue
  }
  try {
    const res = await fetch(item.url, {
      headers: {
        // 这些图床按 referer 判热度，直接空 referer 也能拿到，但带上文档站更稳
        referer: 'https://developer.huawei.com/consumer/cn/doc/',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      },
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const type = res.headers.get('content-type') ?? ''
    const ext = /png/i.test(type) ? 'png' : /webp/i.test(type) ? 'webp' : 'jpg'
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 500) throw new Error('太小，可能是占位：' + buf.length)
    writeFileSync(`${base}.${ext}`, buf)
    saved += 1
    console.log('✓', `${short}-${idx}.${ext}`, Math.round(buf.length / 1024) + 'KB', createHash('md5').update(buf).digest('hex').slice(0, 8))
  } catch (e) {
    failed.push(`${short}-${idx}: ${e.message}`)
  }
}

console.log(`\n保存 ${saved} / 跳过 ${skipped} / 失败 ${failed.length}`)
for (const f of failed) console.log('  ✖', f)
