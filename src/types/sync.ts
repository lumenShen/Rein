/**
 * 多设备同步的类型出口 · 对应 modules/sync
 *
 * 三条传输路径的标识固定为 `lan` / `punch` / `relay`（库里、日志里、事件里都用它），
 * 界面文案另有一层 label（局域网直连 / 打洞直连 / 云端中继）—— 用户看的是后者，
 * 排查问题时要的是前者。
 */

/** 一台已配对的设备。 */
export interface SyncPeerInfo {
  device: string
  /** 设备号前 8 位，界面显示用 */
  short: string
  name: string
  /** 公钥指纹（人工核对配对是否被中间人掉包） */
  fingerprint: string
  /** 上次同步走成的路径：lan / punch / relay */
  path: string | null
  lastSeen: number | null
  seqSent: number
  seqAck: number
}

/** 本机同步状态：设置页那张卡片的全部输入。 */
export interface SyncStatus {
  deviceId: string
  deviceShort: string
  deviceName: string
  fingerprint: string
  inGroup: boolean
  groupId: string | null
  peers: SyncPeerInfo[]
  /** 本机已有的同步对象数 / 墓碑数 / 复制日志长度 */
  objects: number
  tombstones: number
  logLen: number
  /** 变更捕获队列积压 */
  pending: number
  /** 表结构变了、等待重新补录的表数 */
  staleTables: number
  conflicts: number
  lastAt: number | null
  lastPath: string | null
  lastUp: number
  lastDown: number
}

/** 配对第一步：念给另一台设备的短码。 */
export interface PairOffer {
  code: string
  expiresAt: number
}

/** 配对过程中的状态。 */
export interface PairStatus {
  pending: boolean
  peer: SyncPeerInfo | null
  room: string | null
}

/** 本机的自动同步设置（存 Rust 侧 `sync_meta`，只在本机生效）。 */
export interface SyncSettings {
  /** 打开应用时自动同步 */
  auto: boolean
  /** 自动同步的最小间隔（分钟） */
  intervalMin: number
  /** 允许走蜂窝网络同步媒体（大块） */
  mediaOverCellular: boolean
  /** 打洞失败时自动落云端中继 */
  autoOverRelay: boolean
}

/** 只带要改的字段。 */
export type SyncSettingsPatch = Partial<SyncSettings>

/** 一轮同步的结果（`sync://result` 事件的载荷）。 */
export interface SyncRunStats {
  peer: string
  peerName: string
  path: string
  pathLabel: string
  applied: number
  conflicts: number
  unresolved: number
  up: number
  down: number
  ms: number
  notes: string[]
}

export interface SyncRunResult {
  ok: boolean
  stats?: SyncRunStats[]
  errors?: string[]
  error?: string
  /** 这轮是启动 / 定时自动触发的：界面不弹结果浮条，只更新页内状态 */
  auto?: boolean
}
