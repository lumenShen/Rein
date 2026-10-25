/**
 * 统一工具注册表：聚合各域 AppTool，并适配成 pi-agent-core 的 AgentTool。
 *
 * 新增一个模型可调用能力的完整路径：
 * 1. 在本目录对应域文件里 defineTool（入参用模型友好形状，execute 内换算）；
 * 2. 在下方 APP_TOOLS 里登记；
 * 3. 若属于新分组，在 GROUP_POLICY 里登记该组的装载策略（常驻 / 按需 + 插件门禁）。
 *
 * 渐进迁移（2026-10 起）：已搬 Rust 的域（context / web，见
 * src-tauri/src/modules/ai/agent/tools/）从本表移除 —— defs 与执行都在 Rust 注册表，
 * 按组下发（RustAgent 的 toolGroups）；此处保留的是仍在 WebView 执行的域。
 *
 * 装载策略（避免每轮把 83 个工具的 schema 全量塞给模型）：
 * - `always: true` 的组恒常驻（主流程缺了就坏：饮食卡协议、知识库检索、待办、记忆与笔记）；
 * - 其余组按需装载：本轮消息命中关键词、或模型调 `load_tools` 当场装载；
 * - `plugin` 指向功能插件 id：用户关掉对应的功能模块（课表 / 运动 / 健康方案 / 记账 /
 *   专注 / 语音）后整组不再出现（含系统提示词段落）。
 * 粒度是「组」而不是单个工具：装载就要给全（含 delete / update），半截组会让模型计划一个做不完的任务。
 */

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import { isTauri } from '@/services/transport'

import { campusTools } from './campus'
import { campusProgramTools } from './campusProgram'
import { dietTools } from './diet'
import { exerciseTools } from './exercise'
import { imageTools } from './image'
import { knowledgeTools } from './knowledge'
import { ledgerTools } from './ledger'
import { memoryTools } from './memory'
import { modelTools } from './models'
import { noteTools } from './notes'
import { nutritionTools } from './nutrition'
import { planTools } from './plan'
import { pomodoroTools } from './pomodoro'
import { programTools } from './program'
import { providerTools } from './providers'
import { sessionTools } from './session'
import { defineTool, type AppTool, type ToolGroup } from './types'
import { todoTools } from './todo'
import { voiceTools } from './voice'
import { workspaceTools } from './workspace'

/** 各域工具（不含聊天自身的 JSON 输出协议，也不含元工具 —— 见下方 APP_TOOLS） */
const DOMAIN_TOOLS: AppTool[] = [
  ...dietTools,
  ...nutritionTools,
  ...todoTools,
  ...ledgerTools,
  ...exerciseTools,
  ...planTools,
  ...programTools,
  ...pomodoroTools,
  ...sessionTools,
  ...knowledgeTools,
  ...memoryTools,
  ...noteTools,
  ...workspaceTools,
  ...modelTools,
  ...providerTools,
  ...voiceTools,
  ...imageTools,
  ...campusTools,
  ...campusProgramTools,
]

/* ---- 装载策略：哪些组恒常驻、哪些按需、谁受功能开关管 ---- */

export interface GroupPolicy {
  /** 中文短名（组目录展示；也是给模型的分组说法） */
  label: string
  /** 这组管什么、什么时候该装载它（模型据此判断要不要调 load_tools） */
  hint: string
  /** true = 每轮都挂；false = 按需（关键词命中或 load_tools 装载） */
  always?: boolean
  /** 功能插件 id（见 src/plugins/builtin）：关掉该插件后整组不出现，也不可装载 */
  plugin?: string
  /** 本轮消息命中即装载该组（仅按需组需要；词取用户会说的口语说法） */
  keywords?: RegExp
}

/**
 * 分组的装载策略。判据是「缺了会不会把主流程弄坏」+「用户多久说一次」：
 * 常驻的是每轮都可能用到的（饮食卡协议强制 search_food→create_food、知识库是统一检索面、
 * 待办是应用主轴），按需的是低频域与自配置（模型 / 语音 / 教务 / 记账 / 运动 / 方案）。
 */
export const GROUP_POLICY: Record<ToolGroup, GroupPolicy> = {
  diet: { label: '饮食', hint: '食物库检索、记餐与三餐查询', always: true },
  nutrition: { label: '营养', hint: '每日营养汇总、目标、画像与体测', always: true },
  todo: { label: '待办', hint: '日程清单、分布与增删改', always: true },
  knowledge: { label: '知识库', hint: '跨来源检索、读正文、按路径找、笔记与文件治理', always: true },
  memory: { label: '长期记忆', hint: '用户认知的查看与增删改', always: true },
  context: { label: '历史检索', hint: '在过去的对话里找原话', always: true },
  web: { label: '联网', hint: '搜索与抓取网页正文', always: true },
  image: { label: '看图', hint: '按像素坐标放大图片局部细节', always: true },
  session: {
    label: '当前训练会话',
    hint:
      '正在进行的那一场：看清现场与动作清单、改这一组的重量/次数与推进流程，以及只改这一场的换动作/插入/删除/改组数（不写课程库）',
    always: true,
  },
  system: { label: '工具装载', hint: '装载其它工具分组（元工具）', always: true },
  ledger: {
    label: '记账',
    hint: '账目流水与预算',
    plugin: 'ledger',
    keywords: /记账|账本|账单|流水|花了|花销|开销|消费|支出|收入|预算|报销|转账|工资|零花|省钱|钱包|多少钱/,
  },
  exercise: {
    label: '运动记录与动作库',
    hint:
      '运动打卡、消耗估算、记录查询，动作库的增改与肌群标注，以及动作详解（准备 3 条 / 轨迹 / 注意 / 每次循环秒数）的读写 —— 详解是覆盖层，内置动作也能改，可恢复基线',
    plugin: 'sports',
    keywords:
      /运动|锻炼|健身|跑步|跑了|撸铁|有氧|力量训练|步数|消耗|打卡|心率|动作库|自建动作|肌群|肌肉|动作要点|动作详解|详解|要领|教学|注意事项/,
  },
  plan: {
    label: '训练课程',
    hint: '课程编排、动作库与力量进步',
    plugin: 'sports',
    keywords: /训练计划|课程|动作|深蹲|卧推|硬拉|引体|组数|次数|重量|1rm|换课|力量/,
  },
  program: {
    label: '健康方案',
    hint: '三档方案基线、日程展开与复盘调参',
    plugin: 'program',
    keywords: /方案|基线|复盘|调参|三档/,
  },
  pomodoro: {
    label: '专注',
    hint: '番茄钟记录与专注时长',
    plugin: 'focus',
    keywords: /番茄|专注|计时/,
  },
  models: {
    label: '模型与服务商',
    hint:
      'AI 模型列表、增改、探测与默认项切换，以及提供商账号（服务商 Key）、模型目录拉取与四个服务模型槽位（主对话 / 多模态 / 语音识别 / 向量）的切换（AI 自管理）',
    keywords:
      /模型|api\s*key|apikey|密钥|接口地址|base\s*url|探测|视觉能力|思考能力|默认模型|供应商|服务商|提供商|provider|方舟|百炼|硅基|通义|向量|embedding|识别模型|语音识别|多模态|asr/i,
  },
  voice: {
    label: '语音服务',
    hint: '语音对话的识别/朗读配置、音色与连通性测试',
    plugin: 'voice',
    keywords: /语音|转写|朗读|音色|asr|tts|豆包|识别|录音/i,
  },
  campus: {
    label: '校园教务',
    hint: '培养方案、学分完成度与课程清单',
    plugin: 'campus',
    keywords: /教务|课表|培养方案|学分|课程表/,
  },
  // 课表的**子模块**（默认关闭）：门禁认 'campus-grab'，而它的可用性又取决于
  // 父模块「课表」开着 —— 这一层继承在 `stores/features.ts::isEnabled` 里统一判定，
  // 所以这里不必写成 ['campus','campus-grab'] 那种复合条件。
  campusGrab: {
    label: '抢课',
    hint: '选课批次、抢课编排与现场诊断（课表的子模块，默认关闭）',
    plugin: 'campus-grab',
    keywords: /选课|抢课|教学班|志愿|预约|开课|抢|退课/,
  },
}

/** 常驻组（含元工具组） */
export const ALWAYS_GROUPS = (Object.keys(GROUP_POLICY) as ToolGroup[]).filter(
  (g) => GROUP_POLICY[g].always,
)

/** 按需组的稳定顺序（组目录与提示词展示都依它） */
export const ON_DEMAND_GROUPS = (Object.keys(GROUP_POLICY) as ToolGroup[]).filter(
  (g) => !GROUP_POLICY[g].always,
)

function isToolGroup(v: unknown): v is ToolGroup {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(GROUP_POLICY, v)
}

/** 分组 → 工具名（顺序同 APP_TOOLS，稳定） */
export function toolNamesForGroups(groups: Iterable<ToolGroup>): string[] {
  const want = new Set(groups)
  return APP_TOOLS.filter((t) => want.has(t.group)).map((t) => t.name)
}

/** 组在当前功能开关下是否可用（无 plugin 声明 = 恒可用） */
function groupAllowed(g: ToolGroup, plugins?: string[]): boolean {
  const p = GROUP_POLICY[g].plugin
  if (!p) return true
  return plugins === undefined ? true : plugins.includes(p)
}

export interface ToolPlanInput {
  /** 判定意图的文本（本轮消息；纪要整理等任务另传被整理的正文） */
  text?: string
  /** 已启用的功能插件 id；缺省视为全部启用（非聊天链路不必传） */
  plugins?: string[]
  /** 会话内已装载过的组（粘住：同一话题的追问不该再猜一次） */
  sticky?: Iterable<ToolGroup>
}

export interface ToolPlan {
  /** 本轮初始装载的组（常驻 + 命中 + 粘住） */
  loaded: Set<ToolGroup>
  /** 还能装载的按需组（未装载、未被功能开关挡住） */
  available: ToolGroup[]
}

/**
 * 解析本轮要装载哪些工具组：
 * 常驻组 ∪ 粘住组 ∪ 关键词命中的按需组；再算一遍「还可以装什么」给组目录。
 * 只做加法不做减法 —— 猜错时可由 `load_tools` 当场补救，不必回头问用户。
 */
export function resolveToolPlan(input: ToolPlanInput = {}): ToolPlan {
  const loaded = new Set<ToolGroup>(ALWAYS_GROUPS)
  for (const g of input.sticky ?? []) {
    if (isToolGroup(g) && groupAllowed(g, input.plugins) && !GROUP_POLICY[g].always) loaded.add(g)
  }
  const text = input.text ?? ''
  if (text.trim()) {
    for (const g of ON_DEMAND_GROUPS) {
      if (GROUP_POLICY[g].keywords?.test(text) && groupAllowed(g, input.plugins)) loaded.add(g)
    }
  }
  return {
    loaded,
    available: ON_DEMAND_GROUPS.filter((g) => !loaded.has(g) && groupAllowed(g, input.plugins)),
  }
}

/** 组目录文案（系统提示词用）：只列「此刻还能装载」的组，装完就缩短 */
export function toolGroupCatalog(available: Iterable<ToolGroup>): string {
  const rows = [...available].map((g) => {
    const p = GROUP_POLICY[g]
    const names = toolNamesForGroups([g]).join('、')
    return `- ${g}（${p.label}）：${p.hint}。工具：${names}`
  })
  if (rows.length === 0) return ''
  return `【工具装载】你的工具按分组装载，下面这些分组此刻不在手边。需要时先调 load_tools 传组名（可一次传多个），装载后**当轮**即可调用，不必让用户再说一遍：
${rows.join('\n')}
`
}

/* ---- 元工具：装载其它分组 ---- */

export const loaderTools: AppTool[] = [
  defineTool({
    name: 'load_tools',
    group: 'system',
    label: '装载工具分组',
    description:
      '装载当前不在手边的工具分组（组名见系统提示词的【工具装载】段）。传组名数组，装载后当轮即可调用该组工具；已装载的组重复传也无害。',
    parameters: Type.Object({
      groups: Type.Array(Type.String({ description: '要装载的分组名，如 ["ledger","campus"]' }), {
        description: '分组名数组（可多个）',
      }),
    }),
    async execute(args) {
      const asked = args.groups.map((s) => s.trim()).filter(Boolean)
      if (asked.length === 0) throw new Error('groups 不能为空，传要装载的分组名数组，如 ["ledger"]')
      const ok: ToolGroup[] = []
      const unknown: string[] = []
      for (const name of asked) {
        // 常驻组与元工具组无可装载，按名不对处理，免得模型以为「再装一次」有效
        if (!isToolGroup(name) || GROUP_POLICY[name].always) {
          unknown.push(name)
          continue
        }
        if (!ok.includes(name)) ok.push(name)
      }
      const toolNames = toolNamesForGroups(ok)
      const done = ok.map((g) => `${GROUP_POLICY[g].label}（${toolNamesForGroups([g]).length} 个）`).join('、')
      const miss = unknown.length > 0 ? `没有这些分组：${unknown.join('、')}；` : ''
      return {
        loadedGroups: ok,
        toolNames,
        message:
          ok.length > 0
            ? `${miss}已装载 ${done}，当轮即可调用。可用组名见系统提示词的【工具装载】段。`
            : `${miss}可用组名见系统提示词的【工具装载】段。`,
      }
    },
  }),
]

/** 全部应用数据工具 + 元工具（loaderTools 必须在此处拼接：它在上面才完成声明） */
export const APP_TOOLS: AppTool[] = [...DOMAIN_TOOLS, ...loaderTools]

const BY_NAME = new Map(APP_TOOLS.map((t) => [t.name, t]))

/** 按工具名查定义（UI 过程卡取 label / dangerous 用） */
export function findAppTool(name: string): AppTool | undefined {
  return BY_NAME.get(name)
}

/** AppTool → AgentTool：默认结果包成 {ok:true,data} 文本；rawContent 工具原样透传内容块（可含图片）；失败 throw 由框架回灌错误 */
function toAgentTool(t: AppTool): AgentTool {
  return {
    name: t.name,
    label: t.label,
    description: t.description,
    parameters: t.parameters,
    execute: async (_toolCallId, params) => {
      const data = await t.execute(params as never)
      if (t.rawContent) return data as AgentToolResult<unknown>
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }],
        details: data,
      }
    },
  }
}

/** 注册表 → Agent 工具集；传 onlyNames 时只挂指定工具（如视觉识别轮只给 search_food） */
export function buildAppAgentTools(onlyNames?: string[]): AgentTool[] {
  const tools = onlyNames ? APP_TOOLS.filter((t) => onlyNames.includes(t.name)) : APP_TOOLS
  return tools.map(toAgentTool)
}

/** 按分组装载（聊天主链路用）：只给这些组的工具，组内不做裁剪 */
export function buildAgentToolsForGroups(groups: Iterable<ToolGroup>): AgentTool[] {
  return buildAppAgentTools(toolNamesForGroups(groups))
}

/**
 * 浏览器直连（`npm run dev`，后端是内存 mock）时把工具直调暴露到 `window.__REIN_TOOL__`，
 * 供 e2e 断言「工具 → service → 命令」这条链。
 *
 * 为什么需要它：模型不在环里 —— 无头浏览器里没有真模型可调，而这条链上真正会坏的
 * 是参数形状与命令名，不是模型的措辞。与 `window.__REIN_MOCK_*` 那批钩子同一套路，
 * 且与 `transport.isTauri` 同一判据：真机上（桌面 / Android）永远不存在这个钩子。
 */
if (!isTauri) {
  ;(window as unknown as { __REIN_TOOL__?: unknown }).__REIN_TOOL__ = async (
    name: string,
    args?: unknown,
  ): Promise<unknown> => {
    const t = findAppTool(name)
    if (!t) throw new Error(`没有这个工具：${name}`)
    return t.execute((args ?? {}) as never)
  }
}
