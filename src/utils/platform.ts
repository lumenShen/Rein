import { isTauri } from '@/services/transport'
import { useUpdateStore } from '@/stores/update'

/**
 * 展示用的平台判定（**不是能力真源**）。
 *
 * 为什么单独一份：`system/globalFloat.ts` 的 `isAndroidShell` 管「浮窗能不能盖在别的
 * 应用上」、`system/windowChrome.ts` 的 `isTauriDesktopWindow` 管「窗口要不要自绘标题
 * 栏」——它们各自带着自己的降级语义，复用任何一份到导航/页签判断上都会把两件事绑死。
 * 这里只回答「用户现在坐在哪个平台上」，给「连接应用」的平台页签这类**展示性**选择用。
 *
 * 三条纪律：
 *   ① 不联网、不新增 IPC：平台只从 UA 与（Tauri 下）更新快照的 `platform` 字段读；
 *   ② 浏览器预览一律 `browser`，不冒充真实平台（CI 可能是 macOS/Linux，e2e 不应依赖平台）；
 *   ③ 结果只用于展示与默认页签，不写进任何持久化偏好，也不拿来判断「这个功能有没有」。
 */

/** 用户所在的平台。`browser` 是「浏览器预览」这一种运行形态，不是操作系统。 */
export type PlatformKey = 'android' | 'windows' | 'mac' | 'ios' | 'linux' | 'browser'

/** UA → 平台。认不出（或 UA 只报引擎）时返回 null，交给更新快照兜底。 */
function detectByUserAgent(ua: string): PlatformKey | null {
  // 顺序有意义：Android 的 UA 里也有 `Linux`，iPadOS 的桌面模式 UA 里也有 `Macintosh`
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Windows/i.test(ua)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac'
  if (/Linux/i.test(ua)) return 'linux'
  return null
}

/**
 * 更新快照里的 `platform` 是 Rust `update::platform_key()` 的产物，命名与
 * tauri-plugin-updater 的 target 一致（`windows-x86_64` / `darwin-aarch64` /
 * `android-aarch64` / `linux-x86_64`）。这里只取前缀，不解析架构。
 *
 * 只在 Tauri 下读，且 store 未初始化（如模块级调用、单测环境没有 Pinia）时静默返回
 * null —— 平台判定不该为了一个展示值把整个模块炸掉。
 */
function platformFromUpdateSnapshot(): PlatformKey | null {
  if (!isTauri) return null
  let platform: string | null = null
  try {
    platform = useUpdateStore().snapshot?.platform ?? null
  } catch {
    return null
  }
  if (!platform) return null
  const os = platform.split('-')[0]
  if (os === 'windows') return 'windows'
  if (os === 'darwin') return 'mac'
  if (os === 'android') return 'android'
  if (os === 'linux') return 'linux'
  if (os === 'ios') return 'ios'
  return null
}

/**
 * 当前平台：优先 UA（移动 shell 的 UA 最可靠），Tauri 桌面 UA 认不出时退到更新快照；
 * 两者都拿不到才按本机主目标 `windows` 处理（只影响默认页签，不影响任何能力判定）。
 *
 * 浏览器预览直接返回 `browser`，连 UA 都不看 —— 预览页面的平台是「浏览器」，不是宿主 OS。
 */
export function currentPlatform(): PlatformKey {
  if (!isTauri) return 'browser'
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return detectByUserAgent(ua) ?? platformFromUpdateSnapshot() ?? 'windows'
}
