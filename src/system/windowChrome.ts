import { getCurrentWindow } from '@tauri-apps/api/window'
import type { UnlistenFn } from '@tauri-apps/api/event'

import { isTauri } from '@/services/transport'

/**
 * 桌面窗口外壳（自绘标题栏 / 无边框缩放）的平台层。
 *
 * 判定只有这一处：**Tauri 且不是 Android**。浏览器预览（npm run dev）没有窗口 API，
 * 所以这里每个函数在非桌面环境都必须安静地什么都不做、不抛错 —— 标题栏在浏览器里
 * 根本不渲染，但同一份封装会被浮窗标题栏与测试工装复用，空实现比调用方各自判平台好。
 *
 * 所有窗口控制都吞异常：能力清单（capabilities/default.json）漏一条权限时，抛出去
 * 就是一个未捕获的 Promise rejection（控制台红字，还可能带崩调用链）；而用户要的只是
 * 「这一下没反应」，不是报错。窗口在关闭动画中被销毁时同理。
 */

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''

/** 是否运行在桌面 Tauri 窗口里（浏览器预览与 Android 都是 false） */
export const isTauriDesktopWindow = isTauri && !/Android/i.test(ua)

/**
 * 自绘标题栏的基准高度，与 tokens.css 的 --titlebar-h 同值（CSS 读不到 TS 常量，
 * 两处必须一起改）。需要数值的地方（窗口尺寸计算 / 脚本工装）用它，样式里用令牌。
 * 浮窗紧凑版在 TitleBarBase 里用 --titlebar-h-compact（32）：430×92 的固定小窗
 * 装不下 40 高的标题栏 + 浮条本体（见 docs/GLOBAL-FLOAT.md §3.4 / §3.5）。
 */
export const TITLEBAR_H = 40

/** 当前窗口；非桌面环境（或 Tauri 注入尚未就绪）返回 null，而不是抛错 */
function currentWindow(): ReturnType<typeof getCurrentWindow> | null {
  if (!isTauriDesktopWindow) return null
  try {
    return getCurrentWindow()
  } catch {
    /* 极早期调用（注入脚本还没落地）时 getCurrentWindow 会抛：按「没有窗口」处理 */
    return null
  }
}

/** 最小化当前窗口 */
export async function minimizeWindow(): Promise<void> {
  const win = currentWindow()
  if (!win) return
  try {
    await win.minimize()
  } catch {
    /* 权限缺失 / 窗口已销毁：静默降级（按钮这一下就是没反应，不是报错） */
  }
}

/**
 * 切换最大化 / 还原。
 *
 * 先问 isMaximizable 再切：Tauri 的 toggleMaximize 命令本身不检查这条
 * （浮窗 resizable/maximizable 都是 false，但 maximize 调用在 Windows 上仍可能生效），
 * 而双击标题栏是无差别挂在 TitleBarBase 上的 —— 不加这道闸，在浮窗上双击就会把
 * 430×92 的小窗放大。is-maximizable 权限在 core:window:default 里（core:default 已覆盖）。
 */
export async function toggleMaximizeWindow(): Promise<void> {
  const win = currentWindow()
  if (!win) return
  try {
    if (!(await win.isMaximizable())) return
    await win.toggleMaximize()
  } catch {
    /* 权限缺失 / 窗口已销毁：静默 */
  }
}

/** 关闭当前窗口（主窗口 = 退出应用；系统会走既有的关闭拦截逻辑） */
export async function closeWindow(): Promise<void> {
  const win = currentWindow()
  if (!win) return
  try {
    await win.close()
  } catch {
    /* 同上 */
  }
}

/** 当前是否最大化（非桌面 / 读取失败一律 false：没最大化就按普通态画按钮） */
export async function isWindowMaximized(): Promise<boolean> {
  const win = currentWindow()
  if (!win) return false
  try {
    return await win.isMaximized()
  } catch {
    return false
  }
}

/**
 * 订阅最大化状态变化，返回取消订阅函数。
 *
 * 用 onResized 而不是轮询：最大化 / 还原必然改变窗口尺寸，一条 resize 事件就够；
 * 用户手动拖边缘缩放时也会触发，此时读到的仍是「此刻是否最大化」，多读一次无害。
 * 非桌面环境返回一个空函数 —— 调用方因此不必再自己判平台。
 */
export async function onMaximizedChange(handler: (maximized: boolean) => void): Promise<UnlistenFn> {
  const win = currentWindow()
  if (!win) return () => {}
  try {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unlisten = await win.onResized(() => {
      // 拖边缘缩放会连续发 resize 事件（每秒几十条），每次都问一次 IPC 是纯浪费；
      // 图标只要在动作停下来时是准的，80ms 的合并延迟肉眼看不出来。
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void isWindowMaximized().then(handler)
      }, 80)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unlisten()
    }
  } catch {
    return () => {}
  }
}
