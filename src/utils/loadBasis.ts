/**
 * 负重口径的纯函数层：推断 / 读法 / 片组合。
 *
 * 纪律（见 `docs/design/weight-load-basis.md` §2）：
 *  - **推断只处理能看见器械的情况**：`assist` / `band` 永远不由推断产出，只能用户显式指定；
 *  - **双形态名单要窄**：只有真实健身房里插片式与挂片式都常见的机器才标「待确认」
 *    （现有 81 个动作里只有 2 个：器械推胸、站姿提踵）；
 *  - **操作数优先**：挂片显示每侧、哑铃显示每只、杠铃显示含杠总重；
 *    合计/档位只当灰字副标，永远不做第二个大字号 kg；
 *  - **统计口径统一**：`workload` 是等效负荷，容量 / e1RM / PR 一律按它算。
 */

import type { ExerciseEquipment, ExerciseKind } from '@/types'
import type { LoadBasis, LoadReadout, LoadSetup } from '@/types/load'

import { fmtKg } from './format'

/** 单侧默认片库存（kg，一片的量），降序 */
export const DEFAULT_PLATE_STOCK = [20, 15, 10, 5, 2.5, 1.25]

/** 标准奥杆；挂片机的挂片臂按 0 算（器械自重不入账） */
export const DEFAULT_BAR_KG = 20

/** 读法徽标文案（口径 → 这个词 readable） */
export const LOAD_CHIP_LABELS: Record<LoadBasis, string> = {
  stack: '读数',
  side: '每侧',
  total: '含杠',
  hand: '每只',
  assist: '减重',
  band: '带',
  bw: '自重',
}

/** 器械徽标文案（另一枚，说的是「这是哪种器械」） */
export const GEAR_LABELS: Partial<Record<ExerciseEquipment, string>> = {
  barbell: '杠铃',
  dumbbell: '哑铃',
  machine: '器械',
  cable: '绳索',
  bodyweight: '自重',
  band: '弹力带',
  cardio: '有氧',
  other: '其他',
}

/**
 * 双形态名单：真实健身房「插片式」与「挂片式」都常见的机器。
 *
 * 只收这类：问一次值得，问错代价大。蝴蝶机夹胸、腿屈伸、腿弯举、坐姿提踵、髋外展在真实
 * 健身房几乎清一色插片，把它们也标成「待确认」只会多问五次没用的问题。
 */
function isDualFormMachine(name: string): boolean {
  return (
    name.includes('推胸') ||
    name.includes('站姿提踵') ||
    name.includes('腿举') ||
    name.includes('哈克') ||
    name.includes('臀推')
  )
}

/**
 * 推断一个动作的负重口径。
 *
 * `kind` 先于 `equipment` 判断：计时 / 有氧 / 拉伸根本不涉及负重，
 * 否则「跳绳」「泡沫轴」会被 `other` 兜底成自重，凭空长出一列重量。
 */
export function inferLoadSetup(
  kind: ExerciseKind | string,
  equipment: ExerciseEquipment | null | undefined,
  name: string,
  weightStep = 0,
): LoadSetup {
  const base: LoadSetup = {
    basis: null,
    barKg: DEFAULT_BAR_KG,
    unilateral: false,
    plateStock: [...DEFAULT_PLATE_STOCK],
    step: weightStep > 0 ? weightStep : 0,
    pendingConfirm: false,
    inferred: true,
  }

  if (kind !== 'strength') return base

  switch (equipment) {
    case 'barbell':
      return { ...base, basis: 'total', barKg: DEFAULT_BAR_KG, step: 0 }
    case 'dumbbell':
      return { ...base, basis: 'hand', step: weightStep > 0 ? weightStep : 2 }
    case 'machine':
      // 双形态名单 → 暂定挂片（每侧），等用户确认；其余一律插片读数
      return isDualFormMachine(name)
        ? { ...base, basis: 'side', pendingConfirm: true }
        : { ...base, basis: 'stack' }
    case 'cable':
      if (name.includes('单臂') || name.includes('单侧')) {
        return { ...base, basis: 'side', unilateral: true }
      }
      return { ...base, basis: 'stack' }
    case 'band':
      return { ...base, basis: 'band', step: 0 }
    case 'other':
      return name.includes('壶铃')
        ? { ...base, basis: 'hand', step: weightStep > 0 ? weightStep : 2 }
        : { ...base, basis: 'bw' }
    case 'bodyweight':
      return { ...base, basis: 'bw' }
    default:
      return { ...base, basis: 'bw' }
  }
}

/** 杠铃总重 → 每侧片重（负数按 0：空杆也不算负片） */
export function perSideOf(totalKg: number, barKg: number): number {
  return Math.max(0, (totalKg - barKg) / 2)
}

/**
 * 片组合（贪心降序，够用即可）：返回凑出的片与凑不出的余量。
 *
 * 挂片机的步进本质是「片的组合可解性」—— 21 kg 不可达，20 与 22.5 可达。
 * 余量 > 0 时调用方应该提示「凑不出，最接近的是 X」。
 */
export function platesFor(perSideKg: number, stock: number[] = DEFAULT_PLATE_STOCK): {
  plates: number[]
  rest: number
} {
  const plates: number[] = []
  let left = Math.max(0, Math.round(perSideKg * 100) / 100)
  for (const p of [...stock].sort((a, b) => b - a)) {
    while (left >= p - 1e-6) {
      plates.push(p)
      left = Math.round((left - p) * 100) / 100
    }
  }
  return { plates, rest: left }
}

/** 细粒度重量（片重 / 每侧片重）：1.25 这种不能按一位小数截成 1.3 */
export function fmtFine(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
}

/** 片组合 → 「10 + 10 + 2.5」 */
export function fmtPlates(plates: number[]): string {
  if (!plates.length) return '未挂片'
  const counts = new Map<number, number>()
  for (const p of plates) counts.set(p, (counts.get(p) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([p, n]) => (n > 1 ? `${fmtFine(p)}×${n}` : fmtFine(p)))
    .join(' + ')
}

/**
 * 等效负荷：容量 / e1RM / PR 的统一口径。
 *
 * `assist` / `band` 恒为 0（助力与弹力带不能与杠铃负荷相加）；
 * `bw` 只算附加负重（纯自重为 0，次数另行统计）。
 */
export function workloadOf(kg: number | null, setup: LoadSetup): number {
  if (kg == null || kg <= 0) return 0
  switch (setup.basis) {
    case 'side':
    case 'hand':
      return setup.unilateral ? kg : kg * 2
    case 'assist':
    case 'band':
      return 0
    default:
      return kg
  }
}

/**
 * 把一个重量数字按口径读出来。
 *
 * 主数字永远是**操作数**（用户在器械前要做的那个数），合计/含杠/档位只进副标。
 */
export function readLoad(kg: number | null, setup: LoadSetup): LoadReadout {
  const chip = setup.basis ? LOAD_CHIP_LABELS[setup.basis] : '无负重'

  if (setup.basis == null) {
    return { main: '—', unit: '', sub: '这类动作不记重量', chip, workload: 0 }
  }

  if (kg == null || (kg <= 0 && setup.basis !== 'bw')) {
    return {
      main: '—',
      unit: '',
      sub: hintOf(setup),
      chip,
      workload: 0,
    }
  }

  const n = fmtKg(kg)
  switch (setup.basis) {
    case 'stack':
      return { main: n, unit: 'kg', sub: '插片档位', chip, workload: workloadOf(kg, setup) }
    case 'side': {
      const total = setup.unilateral ? kg : kg * 2
      return {
        main: n,
        unit: 'kg/侧',
        sub: `合计 ${fmtKg(total)} kg`,
        chip,
        workload: workloadOf(kg, setup),
      }
    }
    case 'total': {
      const per = perSideOf(kg, setup.barKg)
      const { plates, rest } = platesFor(per, setup.plateStock)
      return {
        main: n,
        unit: 'kg',
        sub: `含杠 ${fmtFine(setup.barKg)} · 每侧 ${fmtFine(per)}${
          rest > 0 || plates.length > 1 ? `（${fmtPlates(plates)}${rest > 0 ? ` + 差 ${fmtFine(rest)}` : ''}）` : ''
        }`,
        chip,
        workload: workloadOf(kg, setup),
      }
    }
    case 'hand':
      return {
        main: n,
        unit: 'kg/只',
        sub: setup.unilateral ? '仅这一侧' : `一对 ${fmtKg(kg * 2)} kg`,
        chip,
        workload: workloadOf(kg, setup),
      }
    case 'assist':
      return { main: `减 ${n}`, unit: 'kg', sub: '越大越轻 · 不计容量', chip, workload: 0 }
    case 'band':
      return { main: n, unit: '号带', sub: '阻力随拉伸变化 · 不计容量', chip, workload: 0 }
    case 'bw':
      return kg > 0
        ? { main: n, unit: 'kg', sub: '自重 + 附加负重', chip, workload: kg }
        : { main: '自重', unit: '', sub: '无附加负重', chip, workload: 0 }
    default:
      return { main: n, unit: 'kg', sub: '', chip, workload: kg }
  }
}

/** 没有数字时的口径提示（首次记录 / 未填） */
function hintOf(setup: LoadSetup): string {
  switch (setup.basis) {
    case 'side':
      return '按每侧挂片记录'
    case 'total':
      return '按含杠总重记录'
    case 'hand':
      return '按每只记录'
    case 'stack':
      return '按插销读数记录'
    case 'assist':
      return '按减重记录（越大越轻）'
    case 'band':
      return '按带号记录'
    default:
      return '自重'
  }
}
