/**
 * 负重口径（Load Basis）· 与 `docs/design/weight-load-basis.md` 对应。
 *
 * 现状的病根：全链路只有一个标量 `weightKg`，但「40」在挂片机上是**每侧**、
 * 在插片机上是**插销读数**、在杠铃上是**含杠总重**、在哑铃上是**每只**、
 * 在助力机上是**减重**（越大越轻）。数字一样，物理量不一样，用户在器械前无法执行。
 *
 * 这里补的就是那个缺失的维度：口径不描述动作，只描述「这个数字怎么读」。
 * 同一个动作在不同健身房可以是两种器械（插片 / 挂片），所以口径是**可被用户覆盖**的，
 * 动作库推断只提供 `inferred = true` 的暂定值。
 */

/** 七种读数。`null`（不在本枚举里）表示这类动作根本不涉及负重（计时 / 有氧 / 拉伸）。 */
export const LOAD_BASES = ['stack', 'side', 'total', 'hand', 'assist', 'band', 'bw'] as const

export type LoadBasis = (typeof LOAD_BASES)[number]

/** 一个动作的负重口径配置（P0 由动作库推断，P1 起可由用户按器械覆盖） */
export interface LoadSetup {
  /** null = 不涉及负重：不要显示任何重量 */
  basis: LoadBasis | null
  /** 杠重 kg（`total` 用）：标准杆 20 / 女杆 15 / EZ 10 / 短杆 7 */
  barKg: number
  /** 左右可独立记录（单臂 / 单腿）；开启后单组只覆盖一侧 */
  unilateral: boolean
  /** 单侧可用片库存（`side` / `total` 用），降序 */
  plateStock: number[]
  /** 取整步进 kg；0 = 不取整（挂片由片组合决定，不用常数） */
  step: number
  /** 推断值尚未被用户确认（双形态名单里的机器） */
  pendingConfirm: boolean
  /** 是否由推断得来（用户确认过的配置为 false） */
  inferred: boolean
}

/** 一次「读法」渲染结果：主数字 + 单位 + 副标 + 统计口径的等效负荷 */
export interface LoadReadout {
  /** 主数字（操作数优先：挂片=每侧、哑铃=每只、杠铃=总重） */
  main: string
  /** 单位；自重动作为空 */
  unit: string
  /** 灰字副标：给合计 / 含杠 / 档位等换算 */
  sub: string
  /** 读法徽标（每侧 / 含杠 / 每只 / 读数 / 减重 / 带 / 自重 / 无负重） */
  chip: string
  /** 等效负荷：容量、e1RM、PR 一律按它算 */
  workload: number
}
