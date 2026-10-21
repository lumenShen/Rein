/**
 * 秒 → 时钟读数（mm:ss / HH:MM:SS）的唯一实现。
 *
 * 为什么从 pomodoro store 抽到这里：全局浮窗是**第二个 webview**，拿不到 Pinia 的
 * computed，只能按快照里的「基准秒数 + 时刻」自己走秒并格式化。如果浮窗另抄一份
 * 格式化，两处就会在补零、分钟进位这些边界上悄悄漂 —— 而用户看到的是同一个计时器
 * 的两个读数，差一秒都会被当成 bug。所以格式只留这一份：store 的 displayTime /
 * clockTime 与浮窗的本地走秒都调它。
 */

/** 秒 → `mm:ss`（浮条 / 浮窗 blob 这类窄面用；分钟超过 99 时自然进位成三位，不截断） */
export function fmtClockSec(total: number): string {
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 秒 → `HH:MM:SS`（卡片 / 沉浸层的大读数用，与参考设计的三段式一致） */
export function fmtClockHms(total: number): string {
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
