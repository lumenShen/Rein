/**
 * 安卓 SAF 文件工具（8 个）。
 *
 * 真实执行在 Kotlin `FileOps`（`DocumentsContract`）；这里只做：
 * - 参数形状（root/path/limit/offset 等）与本地字节上限预检；
 * - 写操作前的连接/写入许可检查 + `askToolConfirm`（四次确认）；
 * - 结果投影与分页（native 只返回 ≤1MB 全文，工具层按 offset/maxChars 切片）。
 *
 * `root` 是 `list_phone_roots` 返回的 opaque id（只有 `filesystem:default`），
 * 不是 URI/路径；Kotlin 侧仍会再校验一次。
 */

import { Type } from '@earendil-works/pi-ai'

import { connectedAppService } from '@/services/connectedAppService'
import { useConnectedAppsStore } from '@/stores/connectedApps'
import { askToolConfirm } from '@/system/toolConfirm'
import type { ConnectedAppInvokeMeta } from '@/types'
import { defineTool, type AppTool } from './types'

const APP_ID = 'filesystem' as const
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_READ_CHARS = 50_000
const DEFAULT_READ_CHARS = 20_000

interface FileEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  size: number | null
  lastModified: number | null
}

interface RootEntry {
  id: string
  label: string
  writable: boolean
}

interface CallResult<T> {
  data: T
  meta?: ConnectedAppInvokeMeta
}

interface RootsData {
  root?: string
  roots?: RootEntry[]
}

interface ListData {
  root: string
  path: string
  items?: FileEntry[]
  truncated?: boolean
}

interface ReadData {
  root: string
  path: string
  displayName: string
  content: string
  bytes: number
  truncated?: boolean
}

interface SearchData {
  root: string
  path: string
  query: string
  items?: FileEntry[]
  scanned: number
  truncated?: boolean
}

interface WriteData {
  root: string
  path: string
  displayName: string
  bytes: number
  written: boolean
}

interface FolderData {
  root: string
  path: string
  displayName: string
  created: boolean
  segments?: string[]
}

interface DeleteData {
  root: string
  path: string
  type: 'file' | 'dir'
  deleted: boolean
}

interface RenameData {
  root: string
  from: string
  to: string
  displayName: string
  renamed: boolean
}

const GUIDANCE = '请让用户打开「连接应用 → 安卓文件系统」完成授权/允许写入后重试'

function fail(code: string, message: string): Error {
  return new Error(`[${code}] ${message}（${GUIDANCE}）`)
}

async function callPhoneFiles<T>(method: string, payload: unknown): Promise<CallResult<T>> {
  const reply = await connectedAppService.call<T>(APP_ID, method, payload)
  if (!reply.ok) {
    throw fail(
      reply.error?.code ?? 'connected_app_native_error',
      reply.error?.message ?? '安卓文件调用失败',
    )
  }
  return { data: (reply.data ?? {}) as T, meta: reply.meta }
}

function withMeta<T extends object>(result: CallResult<T>): T & {
  meta?: ConnectedAppInvokeMeta
} {
  return { ...result.data, meta: result.meta }
}

/** 写操作前的本地门禁：已连接 + 允许 AI + 允许写入；缺一个都先报错，不让用户白确认。 */
async function assertWritable(): Promise<void> {
  const store = useConnectedAppsStore()
  await store.ensureLoaded()
  const status = store.statusFor(APP_ID)
  if (!status) {
    throw fail('connected_app_not_connected', '还没有加载安卓文件系统状态')
  }
  if (!status.enabled) {
    throw fail('connected_app_not_connected', '安卓文件系统尚未连接')
  }
  if (!status.connected) {
    throw fail(
      'connected_app_not_connected',
      status.reason ?? '安卓文件系统的授权文件夹不可用',
    )
  }
  if (!store.aiEnabled(APP_ID)) {
    throw fail('connected_app_not_connected', '还没有允许 AI 使用安卓文件系统')
  }
  if (!status.writeAllowed) {
    throw fail('connected_app_write_not_allowed', '还没有允许写入，或授权文件夹不可写')
  }
}

async function auditDenied(method: string, summary: string): Promise<void> {
  try {
    await connectedAppService.call(APP_ID, '__audit', {
      decision: 'denied',
      method,
      summary: summary.slice(0, 300),
    })
  } catch {
    // 审计失败不能掩盖「用户拒绝」这个真实原因。
  }
}

async function confirmWrite(req: {
  title: string
  body: string
  method: string
  summary: string
}): Promise<void> {
  await assertWritable()
  const allowed = await askToolConfirm({
    title: req.title,
    body: req.body,
    danger: true,
  })
  if (!allowed) {
    await auditDenied(req.method, req.summary)
    throw new Error('[connected_app_user_denied] 用户拒绝了本次写入操作')
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

const ROOT_PARAM = Type.String({
  description: 'list_phone_roots 返回的根 id（当前只有 filesystem:default）',
})

const PATH_PARAM = Type.String({
  minLength: 1,
  maxLength: 512,
  description: '相对授权文件夹的路径，用 / 分段；不能是绝对路径或包含 ..',
})

function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  const n = Number.isFinite(v) ? Math.trunc(v as number) : fallback
  return Math.min(max, Math.max(min, n))
}

export const tools: AppTool[] = [
  defineTool({
    name: 'list_phone_roots',
    group: 'appPhoneFiles',
    label: '列出手机文件夹',
    description:
      '列出手机当前持久授权的 SAF 文件夹（0/1 个），返回 root id、显示名与是否可写。没有根时先引导用户在「连接应用 → 安卓文件系统」选择文件夹；后续所有文件工具都要用这里返回的 root。只读。',
    parameters: Type.Object({}),
    async execute() {
      const result = await callPhoneFiles<RootsData>('files_roots', {})
      const roots = (result.data.roots ?? []).map(({ id, label, writable }) => ({
        id,
        label,
        writable,
      }))
      return { roots, meta: result.meta }
    },
  }),

  defineTool({
    name: 'list_phone_files',
    group: 'appPhoneFiles',
    label: '浏览手机文件',
    description:
      '列出授权文件夹内某个相对目录的文件与子目录（目录在前），返回 name/path/type/size。只读；path 省略 = 根目录；每次最多 200 条。path 必须是相对路径，不能包含 .. 或绝对路径。',
    parameters: Type.Object({
      root: ROOT_PARAM,
      path: Type.Optional(
        Type.String({
          maxLength: 512,
          description: '相对目录路径；省略或空串表示根目录',
        }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 200, description: '最多返回条数，默认 100' }),
      ),
    }),
    async execute(args) {
      const result = await callPhoneFiles<ListData>('files_list', {
        root: args.root,
        path: args.path ?? '',
        limit: clampInt(args.limit, 1, 200, 100),
      })
      return withMeta(result)
    },
  }),

  defineTool({
    name: 'read_phone_file',
    group: 'appPhoneFiles',
    label: '读取手机文件',
    description:
      '读取授权文件夹内的文本文件（≤1MB，UTF-8；含 NUL 的二进制文件会返回 not_text）。只读。大文件用 offset/maxChars 分页：默认返回 2 万字符，单次最多 5 万字符；根据 nextOffset 继续读，nextOffset=null 表示已到结尾。',
    parameters: Type.Object({
      root: ROOT_PARAM,
      path: PATH_PARAM,
      offset: Type.Optional(
        Type.Integer({ minimum: 0, description: '从第几个字符开始，默认 0' }),
      ),
      maxChars: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_READ_CHARS,
          description: `本次最多返回字符数，默认 ${DEFAULT_READ_CHARS}`,
        }),
      ),
    }),
    async execute(args) {
      const result = await callPhoneFiles<ReadData>('read_phone_file', {
        root: args.root,
        path: args.path,
      })
      const content = result.data.content ?? ''
      const offset = clampInt(args.offset, 0, Number.MAX_SAFE_INTEGER, 0)
      const maxChars = clampInt(args.maxChars, 1, MAX_READ_CHARS, DEFAULT_READ_CHARS)
      const slice = content.slice(offset, offset + maxChars)
      const nextOffset = offset + slice.length < content.length ? offset + slice.length : null
      return {
        ...result.data,
        content: slice,
        offset,
        nextOffset,
        truncated: nextOffset !== null || result.data.truncated === true,
        meta: result.meta,
      }
    },
  }),

  defineTool({
    name: 'search_phone_files',
    group: 'appPhoneFiles',
    label: '搜索手机文件',
    description:
      '在授权文件夹内按文件名（不区分大小写，只匹配名称，不搜正文）搜索文件与目录。只读。从 path（默认根）向下最多 4 层；扫描上限 2000 项、结果最多 50 条；truncated=true 表示触达上限。',
    parameters: Type.Object({
      root: ROOT_PARAM,
      query: Type.String({ minLength: 1, maxLength: 64, description: '文件名关键词' }),
      path: Type.Optional(
        Type.String({ maxLength: 512, description: '搜索起点（相对目录），默认根目录' }),
      ),
      maxDepth: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 4, description: '最大深度，默认 2' }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 50, description: '最多返回条数，默认 20' }),
      ),
    }),
    async execute(args) {
      const result = await callPhoneFiles<SearchData>('search_phone_files', {
        root: args.root,
        path: args.path ?? '',
        query: args.query,
        maxDepth: clampInt(args.maxDepth, 1, 4, 2),
        limit: clampInt(args.limit, 1, 50, 20),
      })
      return withMeta(result)
    },
  }),

  defineTool({
    name: 'write_phone_file',
    group: 'appPhoneFiles',
    label: '写入手机文件',
    description:
      '把文本写入授权文件夹内的相对路径（≤1MB UTF-8），父目录必须已存在。写操作，调用前会弹确认；默认不覆盖已有文件（overwrite:false），需要覆盖时显式传 true。返回 provider 实际使用的 path/displayName 与字节数；不要按请求名假设成功。',
    dangerous: true,
    parameters: Type.Object({
      root: ROOT_PARAM,
      path: PATH_PARAM,
      content: Type.String({ maxLength: MAX_WRITE_BYTES, description: 'UTF-8 文本，最多 1MB' }),
      overwrite: Type.Optional(
        Type.Boolean({ description: '是否覆盖已存在的文件，默认 false' }),
      ),
    }),
    async execute(args) {
      const bytes = byteLength(args.content)
      if (bytes > MAX_WRITE_BYTES) {
        throw fail('connected_app_too_large', `写入内容 ${bytes} 字节，超过 1MB 上限`)
      }
      const overwrite = args.overwrite === true
      await confirmWrite({
        title: '写入手机文件',
        body: `在「${args.root}」授权文件夹写入「${args.path}」（${bytes} 字节）。${
          overwrite ? '同名文件会被覆盖。' : '同名文件已存在时不会覆盖。'
        }`,
        method: 'write_phone_file',
        summary: `write ${args.path}`,
      })
      const result = await callPhoneFiles<WriteData>('write_phone_file', {
        root: args.root,
        path: args.path,
        content: args.content,
        overwrite,
      })
      return withMeta(result)
    },
  }),

  defineTool({
    name: 'create_phone_folder',
    group: 'appPhoneFiles',
    label: '新建手机文件夹',
    description:
      '在授权文件夹内逐段创建目录（mkdir -p 语义）；已存在目录会跳过，遇到同名文件则失败。写操作，调用前会弹确认。path 必须是相对路径；返回 provider 实际使用的 path/displayName。',
    dangerous: true,
    parameters: Type.Object({
      root: ROOT_PARAM,
      path: PATH_PARAM,
    }),
    async execute(args) {
      await confirmWrite({
        title: '新建手机文件夹',
        body: `在「${args.root}」授权文件夹中创建目录「${args.path}」。已存在的目录会跳过；同名文件会报错。`,
        method: 'create_phone_folder',
        summary: `mkdir ${args.path}`,
      })
      const result = await callPhoneFiles<FolderData>('create_phone_folder', {
        root: args.root,
        path: args.path,
      })
      return withMeta(result)
    },
  }),

  defineTool({
    name: 'delete_phone_file',
    group: 'appPhoneFiles',
    label: '删除手机文件',
    description:
      '删除授权文件夹内的单个文件或空目录；非空目录会被拒绝（connected_app_not_empty），不会递归删除。写操作，调用前会弹确认。',
    dangerous: true,
    parameters: Type.Object({
      root: ROOT_PARAM,
      path: PATH_PARAM,
    }),
    async execute(args) {
      await confirmWrite({
        title: '删除手机文件',
        body: `删除「${args.path}」；只能删单个文件或空目录，非空目录会被拒绝，且无法恢复。`,
        method: 'delete_phone_file',
        summary: `delete ${args.path}`,
      })
      const result = await callPhoneFiles<DeleteData>('delete_phone_file', {
        root: args.root,
        path: args.path,
      })
      return withMeta(result)
    },
  }),

  defineTool({
    name: 'rename_phone_file',
    group: 'appPhoneFiles',
    label: '重命名手机文件',
    description:
      '把授权文件夹内的文件/目录改名：只能改同一目录下的名称（to 不含 /），目标名称必须不存在。写操作，调用前会弹确认；返回 provider 实际使用的 to。',
    dangerous: true,
    parameters: Type.Object({
      root: ROOT_PARAM,
      from: Type.String({
        minLength: 1,
        maxLength: 512,
        description: '现有文件/目录的相对路径',
      }),
      to: Type.String({
        minLength: 1,
        maxLength: 255,
        description: '同目录下的新文件名（不能含 /）',
      }),
    }),
    async execute(args) {
      if (args.to.includes('/')) {
        throw fail('connected_app_bad_request', 'to 必须是同目录下的文件名，不能包含 /')
      }
      await confirmWrite({
        title: '重命名手机文件',
        body: `把「${args.from}」重命名为同目录下的「${args.to}」。目标名称已存在时会失败。`,
        method: 'rename_phone_file',
        summary: `rename ${args.from} -> ${args.to}`,
      })
      const result = await callPhoneFiles<RenameData>('rename_phone_file', {
        root: args.root,
        from: args.from,
        to: args.to,
      })
      return withMeta(result)
    },
  }),
]

export const appPhoneFilesTools = tools

/** 与其它 app 工具文件一致的短名别名（registry 两种命名都能接）。 */
export const phoneFilesTools = tools
