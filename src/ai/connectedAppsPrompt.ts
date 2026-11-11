/**
 * 连接应用工具的系统提示词段落（plan §4.5）。
 *
 * 纪律：**只对已装载的 app 组出现对应段落** —— 讲了工具却不给工具（或反过来）
 * 会让模型空转甚至幻觉调用。没有装载任何 app 组时返回空串，提示词与旧版逐字一致。
 */

import type { ToolGroup } from './tools/types'

type AppGroup = Extract<ToolGroup, `app${string}`>

interface AppSection {
  group: AppGroup
  line: string
}

/** 分组段的顺序与 GROUP_POLICY 里 app 组一致（只影响可读性，不参与门禁） */
const APP_SECTIONS: readonly AppSection[] = [
  {
    group: 'appAlarm',
    line: '闹钟和计时器：Android 没有公开的「列出全部闹钟」接口，只能读「下一个闹钟」和设置/取消；设置结果以系统时钟为准，只代表 intent 已发出。',
  },
  {
    group: 'appUsage',
    line: '使用时间：按天聚合，非实时；OEM 系统可能返回空数据，如实告诉用户即可。',
  },
  {
    group: 'appCalendar',
    line: '日历：查询只读；新建/修改/删除前会弹一次确认。重复日程的修改/删除作用于整个系列。',
  },
  {
    group: 'appContacts',
    line: '通讯录：隐私敏感，用具体姓名/号码/邮箱查询，不要导出全部；新建/修改/删除前会弹确认，删除会同步到已登录账户。',
  },
  {
    group: 'appPhoneFiles',
    line: '手机文件：`path` 一律相对于工具返回的 `root`，不要拼绝对路径或 `..`；只支持文本、单文件 ≤1MB；写入/建目录/删除/重命名前会弹确认；删除只支持单文件或空目录。',
  },
  {
    group: 'appLocation',
    line: '位置：只返回当前位置或最后已知位置的坐标与精度，不反查地址、不记录轨迹。',
  },
  {
    group: 'appNotification',
    line: '通知：只能查看最近通知与清除（逐次确认），不能代发、回复或修改通知内容；ongoing 通知会被跳过。',
  },
  {
    group: 'appSms',
    line: '短信：隐私敏感，必须带具体会话/号码/关键词查询，不要导出全部；只能读取和发送（发送前确认收件人与正文），不会标记已读或删除。',
  },
  {
    group: 'appDesktopFiles',
    line: '桌面文件：`root` 来自 `list_desktop_roots`，`path` 一律相对于该 root，不要拼绝对路径或 `..`；只支持文本、单文件 ≤1MB；写入/建目录/删除/重命名前会弹确认；删除只支持单文件或空目录、不进回收站。',
  },
  {
    group: 'appTerminal',
    line: '命令行：一次只运行一条命令，用 `program + args`（argv）而不是 shell 字符串；cwd 受允许目录限制；每次执行前都会弹确认并展示完整命令；stdout/stderr 各有上限，超时会终止进程。不要尝试提权。',
  },
]

/**
 * 生成连接应用提示词块；`has(g)` 表示该组本轮已装载。
 * 没有任何 app 组时返回 ''（调用方不要插入空段落）。
 */
export function connectedAppsPrompt(has: (g: ToolGroup) => boolean): string {
  const sections = APP_SECTIONS.filter((s) => has(s.group))
  if (sections.length === 0) return ''

  return `【连接应用】本轮你可以使用用户已连接并允许 AI 的部分本机应用能力：
- 这些能力只对「用户已连接并允许 AI」的应用有效；返回 connected_app_permission_denied / connected_app_not_connected / connected_app_ai_disabled / connected_app_write_not_allowed 时不要重试，告诉用户去「连接应用 → 对应应用 → 去授权 / 允许 AI 使用」（写权限缺口是「允许写入」）。
- 读类工具不要一次性导出全部数据：用具体的查询词、日期范围或数量上限；结果带 meta.mock=true 表示是浏览器样例数据，要如实说明。
- 写类工具执行前会弹一次确认（用户能看清完整动作）；用户拒绝就停手，不要换参数重试，也不要绕过工具直接假设成功。
- 文件路径一律相对于工具返回的 root；不要拼绝对路径、盘符或 ..
${sections.map((s) => `- ${s.line}`).join('\n')}
`
}
