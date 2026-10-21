/**
 * 展示格式化 · 纯函数。全应用共用一份：同一个量在两个页面显示成不同精度
 * （0 位 vs 1 位）是小事，但会让用户以为数据对不上。
 */

/** 体积：`decimals` 只影响 MB 档；GB 固定两位、KB 取整（档位之间差别本来就够大） */
export function humanBytes(n: number, decimals = 1): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1073741824).toFixed(2)} GB`
  if (n >= 1024 * 1024) return `${(n / 1048576).toFixed(decimals)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/** 配速：秒/公里 → 「5'30"」。先取整，避免出现 6'60" */
export function fmtPace(secPerKm: number): string {
  const t = Math.round(secPerKm)
  return `${Math.floor(t / 60)}'${String(t % 60).padStart(2, '0')}"`
}

/** 毫秒 → mm:ss（语音 / 录音 / 语音输入共用；`padMinutes` 给需要定宽的时间脊） */
export function fmtMmSs(ms: number, opts: { padMinutes?: boolean } = {}): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const mm = opts.padMinutes ? String(m).padStart(2, '0') : String(m)
  return `${mm}:${String(s % 60).padStart(2, '0')}`
}

/** 计时：3785 → 1:03:05；75 → 01:15（跑步 / 训练课共用） */
export function fmtClock(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 重量：整数不带小数，62.5 保留一位（力量训练全域共用） */
export function fmtKg(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** 营养素数值：100 以上取整，以下保留一位（食品库 / 食品详情共用） */
export function fmtNutrient(v: number): string {
  if (!v) return '0'
  return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
}

/** YYYY-MM-DD → M/D */
export function fmtShortDate(s: string): string {
  const [, m, d] = s.split('-')
  return `${Number(m)}/${Number(d)}`
}

/** YYYY-MM-DD → 「M月D日」（不经过 Date，避免 UTC 解析把日期挪一天） */
export function fmtMonthDayDate(s: string): string {
  const [, m, d] = s.split('-')
  return `${Number(m)}月${Number(d)}日`
}

/** ISO / 毫秒时间戳 → 「刚刚 / N 分钟前 / N 小时前 / M月D日 HH:mm」 */
export function fmtRelativeTime(
  input: string | number | null | undefined,
  invalid = '—',
): string {
  if (input == null || input === '') return invalid
  const ms = typeof input === 'number' ? input : Date.parse(input)
  if (!Number.isFinite(ms) || ms <= 0) return invalid
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(ms).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** ISO → 「M月D日」 */
export function fmtMonthDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** ISO → 今天「HH:mm」，否则「MM-DD HH:mm」（会话列表 / 最近使用共用） */
export function fmtSameDayTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`
}

/** ISO → 「M月D日 HH:mm」 */
export function fmtMonthDayTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${fmtMonthDay(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
