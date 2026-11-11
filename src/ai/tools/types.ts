/**
 * 统一工具层类型：把各域 service 封装成模型可调用的 AppTool。
 *
 * 设计约定：
 * - 入参用「模型友好」形状（日期可缺省=今天、时间用 HH:mm 字符串、金额用元），
 *   由 execute 内部换算成 service 层的存储形状（分 / 分钟数 / 枚举）；
 * - execute 返回给模型的是裁剪后的投影（列表只留关键字段），避免撑爆上下文；
 * - 失败直接 throw 中文 Error，Agent 循环会把消息作为错误结果回灌给模型重试。
 */

import type { Static, TSchema } from '@earendil-works/pi-ai'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'

import { todayStr } from '@/utils/date'

/** 工具分组（提示词组织与 UI 归类用） */
export type ToolGroup =
  | 'diet' // 食物库与饮食记录
  | 'nutrition' // 营养目标 / 个人资料 / 身体测量
  | 'todo' // 待办
  | 'ledger' // 记账
  | 'exercise' // 运动记录
  | 'plan' // 训练课程
  | 'program' // 健康方案（程序计算 + AI 调参）
  | 'pomodoro' // 番茄钟
  | 'session' // 进行中的训练课会话（独立工具集：读 / 动这一组 / 改这一场编排）
  | 'context' // 历史聊天检索
  | 'knowledge' // 知识库混合检索（跨来源）
  | 'memory' // 长期记忆（用户认知）
  | 'models' // AI 模型配置（AI 自管理）
  | 'voice' // 语音对话服务配置（ASR/TTS 凭据、音色与连通性，AI 自管理）
  | 'web' // 联网搜索 / 抓取网页
  | 'image' // 图片查看（放大镜）
  | 'campus' // 校园教务（课表域）：培养方案与学分完成度
  | 'campusGrab' // 校园教务（课表的子模块，默认关闭）：抢课编排、选课、现场诊断与带会话的原始请求
  // 连接本机应用（按 app 分组，默认不可见；用户连接并允许 AI 后才可由 load_tools 装载）
  | 'appAlarm' // 闹钟和计时器（Android）
  | 'appUsage' // 安卓使用时间（只读）
  | 'appCalendar' // 安卓日历（读写）
  | 'appContacts' // 通讯录（读写）
  | 'appPhoneFiles' // 安卓 SAF 文件（读写）
  | 'appLocation' // 位置（只读）
  | 'appNotification' // 通知（读取 + 清除）
  | 'appSms' // 短信（读取 + 发送）
  | 'appDesktopFiles' // 桌面文件（Windows / Mac / Linux 共享组）
  | 'appTerminal' // 命令行（Windows / Mac 共享组）
  | 'system' // 元工具：工具分组装载（load_tools），自身恒常驻

/**
 * 单轮工具执行上下文：由聊天链路按当前会话算出，随 AgentTool 闭包透传给 `execute`。
 *
 * - `plugins`：已启用的功能插件 id（组门禁）；
 * - `apps`：本轮已连接且允许 AI 的连接应用 id（app 组门禁）；
 * - `loadable`：本轮可装载 = 已装载 ∪ 可装载；`load_tools` 只接受这里的组。
 *
 * 旧调用（e2e / 非聊天直调）不传 ctx 时必须安全降级：app 组一律不可装载。
 */
export interface ToolContext {
  plugins?: string[]
  apps?: string[]
  loadable?: ReadonlySet<ToolGroup>
}

/** rawContent 工具的返回：直接作为工具结果内容块（可含图片），details 附带元数据 */
export interface RawToolResult {
  content: (TextContent | ImageContent)[]
  details?: unknown
}

export interface AppTool<TParameters extends TSchema = TSchema> {
  /** 全局唯一工具名（snake_case，供模型调用） */
  name: string
  group: ToolGroup
  /** 中文短名（工具过程卡展示） */
  label: string
  /** 给模型的能力说明（一句话，含关键约束） */
  description: string
  parameters: TParameters
  /** 删除等高危操作：UI 红色标注，仅限用户明确要求时调用 */
  dangerous?: boolean
  /** 结果含图片等原始内容块：execute 返回 RawToolResult，注册表原样透传 */
  rawContent?: boolean
  /**
   * 执行入参 + 本轮上下文。ctx 可选：现有单参 execute 全部兼容
   * （TS 允许少参数函数赋给多参数类型）；app 工具靠它做门禁与确认。
   */
  execute: (args: Static<TParameters>, ctx?: ToolContext) => Promise<unknown>
}

/** defineTool：仅为让参数 schema 与 execute 入参类型联动推断 */
export function defineTool<T extends TSchema>(t: AppTool<T>): AppTool<T> {
  return t
}

/* ---- 各域共用的换算 / 校验小工具 ---- */

/** 元 → 分（四舍五入到整分） */
export function yuanToCents(yuan: number): number {
  return Math.round(yuan * 100)
}

/** 分 → 元（两位小数内） */
export function centsToYuan(cents: number): number {
  return Math.round(cents) / 100
}

/** "HH:mm" → 距 00:00 的分钟数；非法格式抛错 */
export function hhmmToMin(s: string): number {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new Error(`时间格式应为 HH:mm（如 "8:30"），收到「${s}」`)
  }
  return Number(m[1]) * 60 + Number(m[2])
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 必为日期的入参：缺省 = 今天；模型传了相对日期等非法值时抛错让其重试 */
export function resolveDate(v: string | undefined, field = 'date'): string {
  const d = v?.trim()
  if (!d) return todayStr()
  if (!DATE_RE.test(d)) throw new Error(`${field} 格式应为 YYYY-MM-DD（可传"今天"对应的 ${todayStr()}），收到「${v}」`)
  return d
}

/** 可空日期入参：缺省 = null（如待办的收件箱）；传了则校验格式 */
export function optDate(v: string | undefined, field = 'date'): string | null {
  const d = v?.trim()
  if (!d) return null
  if (!DATE_RE.test(d)) throw new Error(`${field} 格式应为 YYYY-MM-DD，收到「${v}」`)
  return d
}
