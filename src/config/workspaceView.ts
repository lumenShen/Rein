/**
 * 「关于你」的虚拟工作区投影 —— **纯前端声明，不新增存储、不移动任何物理路径**。
 *
 * 这个文件只回答两个问题：
 *   1. 用户能认出来的生活分组有哪些（`WORKSPACE_GROUPS`），各自对应哪些**物理顶层目录**；
 *   2. 系统与自动生成的投影有哪些（`PROGRAM_DATA_ROOTS`），供「程序数据」页按物理目录读。
 *
 * 投影判据（不是按可写性、也不是按 kb_docs / kb_files 分）：
 *
 * 1. **人类分组**：用户能认出「这是我的」—— 关于你（用户记忆文件）、健康（体测/运动/方案）、
 *    生活（日程/饮食）、语音笔记（语音）、笔记与文档（笔记/文档/未分类）、Rein 的角落
 *    （记忆/对话/附件）。健康/生活/角落本身是只读派生投影，仍进人类分组：它们是用户的
 *    生活记录，不是程序配置。
 * 2. **程序数据**：系统提示词、规范、课程库、食物库、菜单等配置/知识类目录，以及全部
 *    派生投影的**物理索引**（只读、弱化、最后一张）。同一批文件可以同时出现在人类分组
 *    与程序数据 —— 「按主题读」与「按物理目录读」是两种视图，不是两份数据。
 * 3. **`文档/` 留在笔记与文档**：它是用户上传文档的全文归档（发送时由前端自动写入），
 *    写入时机是程序触发的，但内容所有权是用户的文档，不是系统配置。
 * 4. **显式排除 `视频/` 与 `纪要/`**：两者目前都没有活跃写入（`视频` 只有根声明、
 *    `纪要` 是旧版语音目录），不为了凑数做成空卡；它们仍可从高级文件管理器 `/ai/files`
 *    看到。这是有意边界，不是遗漏。
 *
 * 计数口径：首页用一次 `kbService.listDir('')` 拿每个 root 的 `childCount` 求和。
 * Rust `listing.rs` 的 `child_count` 就是「直接子项数」，且与文件节点同规则地把
 * `kb_docs` 派生文档算进去 —— 和逐 root 列举的 `entries.length` 同值，但只花一次 IPC。
 * 不要改用 `kb_usage.areas[].count`：那条 SQL 只查 `kb_files`，投影根会系统性显示 0。
 */

import type { Component } from 'vue'
import {
  Activity,
  CalendarDays,
  Crown,
  Database,
  Footprints,
  HeartPulse,
  Mic,
  Moon,
  NotebookPen,
  Sparkles,
} from 'lucide-vue-next'

/** 六个可下钻的人类分组。`program` 不在其中：它不是主题分组，而是物理目录索引。 */
export type WorkspaceGroupKey = 'about' | 'health' | 'life' | 'voice' | 'notes' | 'corner'

export type WorkspaceGroupKind = 'about' | 'folder' | 'health'

/** 健康分组里的子分组（体测 / 运动 / 方案）：详情页先展示它们，再展示合并文件。 */
export interface WorkspaceNestedGroup {
  title: string
  sources: readonly string[]
}

export interface WorkspaceGroup {
  key: WorkspaceGroupKey
  /** 首页卡片与详情页标题 */
  title: string
  /** 首页一句话 / 详情页副标题 */
  hint: string
  icon: Component
  /** 模块色变量名（如 `--mod-program`，不带 -soft/-strong 后缀） */
  accent: string
  /** 物理顶层目录名；不移动、不复制 */
  sources: readonly string[]
  kind: WorkspaceGroupKind
  /** 详情页里的二级分组（仅健康有） */
  nested?: readonly WorkspaceNestedGroup[]
  testid: string
}

type GroupSeed = Omit<WorkspaceGroup, 'testid'>

/** 单一来源：`title` / `accent` / `sources` 是契约名，testid 由 key 派生，避免两处漂移。 */
function defineGroup(seed: GroupSeed): WorkspaceGroup {
  return {
    ...seed,
    testid: `about-folder-${seed.key}`,
  }
}

export const WORKSPACE_GROUPS: readonly WorkspaceGroup[] = [
  defineGroup({
    key: 'about',
    title: '关于你',
    hint: '角色设定与全局规范',
    icon: Crown,
    accent: '--mod-ledger',
    sources: ['用户记忆'],
    kind: 'about',
  }),
  defineGroup({
    key: 'health',
    title: '健康',
    hint: '体测 · 运动 · 方案',
    icon: HeartPulse,
    accent: '--mod-program',
    sources: ['体测', '运动', '方案'],
    kind: 'health',
    nested: [
      { title: '体测', sources: ['体测'] },
      { title: '运动', sources: ['运动'] },
      { title: '方案', sources: ['方案'] },
    ],
  }),
  defineGroup({
    key: 'life',
    title: '生活',
    hint: '日程与饮食',
    icon: CalendarDays,
    accent: '--mod-todo',
    sources: ['日程', '饮食'],
    kind: 'folder',
  }),
  defineGroup({
    key: 'voice',
    title: '语音笔记',
    hint: '录音与转写',
    icon: Mic,
    accent: '--mod-record',
    sources: ['语音'],
    kind: 'folder',
  }),
  defineGroup({
    key: 'notes',
    title: '笔记与文档',
    hint: '笔记、文档与未分类',
    icon: NotebookPen,
    accent: '--mod-focus',
    sources: ['笔记', '文档', '未分类数据'],
    kind: 'folder',
  }),
  defineGroup({
    key: 'corner',
    title: 'Rein 的角落',
    hint: '记忆、对话与附件',
    icon: Sparkles,
    accent: '--mod-ai',
    sources: ['记忆', '对话', '附件'],
    kind: 'folder',
  }),
]

const GROUP_BY_KEY = new Map<string, WorkspaceGroup>(
  WORKSPACE_GROUPS.map((g) => [g.key, g]),
)

/** 把 URL 里的 `?key=` 解析成分组；未知 key 返回 undefined，由页面显示空态。 */
export function groupByKey(key: string | null | undefined): WorkspaceGroup | undefined {
  return key ? GROUP_BY_KEY.get(key) : undefined
}

/** 分组计数 = 各物理 root 的直接子项数之和；缺失目录按 0。 */
export function countSources(
  sources: readonly string[],
  counts: ReadonlyMap<string, number>,
): number {
  return sources.reduce((sum, root) => sum + (counts.get(root) ?? 0), 0)
}

/** 健康大卡的四个固定指标磁贴。testid 是契约，不随 metric key 改名。 */
export interface HealthTile {
  metric: string
  label: string
  icon: Component
  testid: string
}

export const HEALTH_TILES: readonly HealthTile[] = [
  { metric: 'sleep_min', label: '睡眠', icon: Moon, testid: 'about-health-tile-sleep' },
  {
    metric: 'resting_hr_bpm',
    label: '静息心率',
    icon: HeartPulse,
    testid: 'about-health-tile-resting-hr',
  },
  { metric: 'hrv_rmssd_ms', label: 'HRV', icon: Activity, testid: 'about-health-tile-hrv' },
  { metric: 'steps', label: '步数', icon: Footprints, testid: 'about-health-tile-steps' },
]

/** 程序数据页的一行：`id` 是稳定英文 slug（testid 用），`root` 是物理目录名。 */
export interface ProgramRoot {
  id: string
  root: string
  hint: string
}

/** 固定顺序与文案；即使目录当前不存在也渲染（计数显示 0），入口不随数据有无而跳动。 */
export const PROGRAM_DATA_ROOTS: readonly ProgramRoot[] = [
  { id: 'system-prompt', root: '系统提示词', hint: '角色与语气、工作区约定 · 只读' },
  { id: 'spec', root: '规范', hint: '知识库规范 · 只读' },
  { id: 'plans', root: '课程', hint: '训练课程投影' },
  { id: 'foods', root: '食物', hint: '自建食物投影' },
  { id: 'menus', root: '菜单', hint: '方案菜单投影' },
  { id: 'body', root: '体测', hint: '身体测量投影' },
  { id: 'workouts', root: '运动', hint: '运动记录投影' },
  { id: 'program', root: '方案', hint: '健康方案投影' },
  { id: 'todos', root: '日程', hint: '日程投影' },
  { id: 'meals', root: '饮食', hint: '饮食记录投影' },
  { id: 'chats', root: '对话', hint: '聊天记录投影' },
  { id: 'attachments', root: '附件', hint: '对话与日程附件' },
  { id: 'memories', root: '记忆', hint: '长期记忆投影' },
]

/** 首页最后一张「程序数据」卡与程序数据页共用的展示配置。 */
export interface ProgramGroup {
  kind: 'program'
  title: string
  hint: string
  icon: Component
  accent: string
  sources: readonly string[]
  testid: string
}

export const PROGRAM_GROUP: ProgramGroup = {
  kind: 'program',
  title: '程序数据',
  hint: '系统提示词、规范与自动生成的投影 · 只读',
  icon: Database,
  accent: '--text-3',
  sources: PROGRAM_DATA_ROOTS.map((r) => r.root),
  testid: 'about-program-card',
}
