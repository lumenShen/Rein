/**
 * 跑步采集（Android 前台服务 = 运动真源）。
 *
 * 锁屏后 WebView 会注销 navigator.geolocation，所以取点/计时/落盘全部搬进
 * location 类型的前台服务；**定位请求本身由 Rust `modules/tracking/location.rs`
 * 通过 JNI 持有**（fused/GPS、QUALITY_HIGH_ACCURACY、1s/500ms），Kotlin 只保留
 * 保活/通知/WakeLock 与 RunCore 记账。前端只消费快照：live/trackTake 走 pull，
 * 原生另有 evaluateJavascript 的 push 通道做秒级平滑（Activity 销毁/页面重载后
 * push 丢失，由 pull + 轨迹文件兜底）。
 * 命令族一律「缓存 + 异步刷新」：exec 没有回执通道（wry-0.57.0/src/android/mod.rs:492-501），
 * 命令返回上次缓存值，调用方按 400ms 重试收敛（形状见 stores/run.ts）。
 * 桌面/浏览器下 status().native === false，同一批命令返回兜底常量，
 * 调用方据此沿用 WebView 的 navigator.geolocation（桌面分支现状不变）。
 * 契约见 Rust `modules/tracking/commands.rs`。
 */
import { invoke } from './transport'

export interface TrackingStatus {
  granted: boolean
  busy: boolean
  notify: boolean
  native: boolean
}

export interface TrackingRunConfig {
  runId: string
  autoPauseEnterSecPerKm: number
  autoPauseExitSecPerKm: number
  baselineElapsedMs: number
  baselineDistanceM: number
}

export interface NativeRunLive {
  active: boolean
  autoPaused: boolean
  /** 运动毫秒（已扣除暂停与 slow/drop 空窗） */
  elapsedMs: number
  /** 入账距离（米，含自动暂停恢复补距与 fast 空窗 ll 直线入账） */
  distanceM: number
  /** 10s 窗口瞬时配速；>15s 无新 fix 为 null */
  paceSecPerKm: number | null
  /** 最近 fix 墙钟 epoch ms（0=无） */
  lastFixMs: number
  /** 最近 fix 水平精度（米，0=未知） */
  accM: number
  /** 最近 fix 坐标（无 fix 为 0） */
  lat: number
  lon: number
  /** "fused"|"gps"|"network"|"" */
  provider: string
  gapSlowCount: number
  gapFastCount: number
  gapDropCount: number
  gapSlowMs: number
  gapFastMs: number
  gapDropMs: number
  /** = slow+fast+drop */
  gapCount: number
  /** = slow+fast+drop（仅统计） */
  gapMs: number
}

export interface NativeRunPoint {
  t: number
  lat: number
  lon: number
  acc: number
  alt: number | null
  altAcc: number | null
  brk: boolean
}

export interface TrackingTrackChunk {
  lines: number
  data: string
}

/** 无缓存/桌面端的兜底快照：与 Rust 侧常量、mock 返回值逐字一致 */
export const FALLBACK_LIVE: NativeRunLive = { active:false, autoPaused:false, elapsedMs:0, distanceM:0, paceSecPerKm:null, lastFixMs:0, accM:0, lat:0, lon:0, provider:'', gapSlowCount:0, gapFastCount:0, gapDropCount:0, gapSlowMs:0, gapFastMs:0, gapDropMs:0, gapCount:0, gapMs:0 }

export const trackingService = {
  /** 拉起/停掉前台服务。mode='specialUse' 供训练课常驻通知用（不取定位、不需要定位权限） */
  async setKeepalive(enable: boolean, mode: 'location' | 'specialUse' = 'location'): Promise<void> {
    try {
      await invoke('tracking_keepalive', { enable, mode })
    } catch (e) {
      console.warn('[tracking] 保活命令不可用', e)
    }
  },

  /** 状态快照；查询不可用时按「已就绪 + 非原生」兜底，交回 GPS 自身的失败路径 */
  async status(): Promise<TrackingStatus> {
    try {
      return await invoke<TrackingStatus>('tracking_status')
    } catch {
      return { granted: true, busy: false, notify: true, native: false }
    }
  },

  /**
   * 开跑：原生采集器初始化（baseline = 恢复出来的累计值，阈值 0=关闭自动暂停）。
   * 与其它命令不同，这里**让错误抛出** —— 调用方按「连续失败」判定二级降级。
   */
  async runBegin(cfg: TrackingRunConfig): Promise<void> {
    await invoke('tracking_run_begin', {
      runId: cfg.runId,
      autoPauseEnterSecPerKm: cfg.autoPauseEnterSecPerKm,
      autoPauseExitSecPerKm: cfg.autoPauseExitSecPerKm,
      baselineElapsedMs: cfg.baselineElapsedMs,
      baselineDistanceM: cfg.baselineDistanceM,
    })
  },

  /** 相位同步（暂停/继续）：原生据此停/恢复累计与判定 */
  async runPhase(phase: 'running' | 'paused'): Promise<void> {
    try {
      await invoke('tracking_run_phase', { phase })
    } catch (e) {
      console.warn('[tracking] 相位同步失败', e)
    }
  },

  /** 结束：停定位更新、结账自动暂停段、停服务（通知消失）；轨迹文件保留待取 */
  async runEnd(): Promise<void> {
    try {
      await invoke('tracking_run_end')
    } catch (e) {
      console.warn('[tracking] 结束命令失败', e)
    }
  },

  /** 上次缓存的 live 快照（本命令顺带触发一次异步刷新） */
  async live(): Promise<NativeRunLive> {
    try {
      const parsed = JSON.parse(await invoke<string>('tracking_live')) as NativeRunLive
      return typeof parsed?.lastFixMs === 'number' ? parsed : FALLBACK_LIVE
    } catch {
      return FALLBACK_LIVE
    }
  },

  /** 取走轨迹文件（交付后文件被删除；调用方按 lines>0 重试直到取到） */
  async trackTake(runId: string): Promise<TrackingTrackChunk> {
    try {
      const parsed = JSON.parse(await invoke<string>('tracking_track_take', { runId })) as TrackingTrackChunk
      if (typeof parsed?.lines !== 'number' || typeof parsed?.data !== 'string') {
        return { lines: 0, data: '' }
      }
      return parsed
    } catch {
      return { lines: 0, data: '' }
    }
  },

  /** 推送通知载荷（原生只渲染不判断；形状见 Rust validate_notify_payload） */
  async notify(payload: string): Promise<void> {
    try {
      await invoke('tracking_notify', { payload })
    } catch (e) {
      console.warn('[tracking] 通知同步失败', e)
    }
  },

  /** 冷启动待办：点通知进应用时落下的 'run'|'course'（读走即清） */
  async openPending(): Promise<string> {
    try {
      const v = await invoke<string>('tracking_open_pending')
      return v === 'run' || v === 'course' ? v : ''
    } catch {
      return ''
    }
  },
}
