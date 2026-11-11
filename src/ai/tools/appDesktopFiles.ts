/**
 * 桌面文件工具（appDesktopFiles，7 个桌面 app 共享）。
 *
 * 工具名与 native method 的映射：
 * - `list_desktop_roots` → 对每个已连接 + 允许 AI 的 app 调 `files_roots` 后合并；
 * - 其余工具 → 同名 native method。
 *
 * `root` 是 opaque id（`win-desktop:default` / `win-local:local-1`），
 * TS 只取冒号前的前缀做路由提示；Rust 再按根表校验，绝不把 root 当路径。
 *
 * 门禁/确认/审计统一走 `./connectedApps` 的 helper：
 * - 读工具：`assertAppReady`（已连接 + 允许 AI）后 `callConnectedApp`；
 * - 写工具：`callConnectedAppWrite`（本地写许可 → 确认 → 拒绝审计 → native）。
 */

import { Type } from '@earendil-works/pi-ai'

import { useConnectedAppsStore } from '@/stores/connectedApps'
import type { ConnectedAppStatus } from '@/types'
import {
  assertAppReady,
  callConnectedApp,
  callConnectedAppWrite,
  withMeta,
} from './connectedApps'
import { defineTool, type AppTool } from './types'

const DESKTOP_APP_IDS = [
  'win-desktop',
  'win-documents',
  'win-downloads',
  'win-local',
  'mac-desktop',
  'linux-desktop',
  'linux-documents',
] as const

type DesktopAppId = (typeof DESKTOP_APP_IDS)[number]

const APP_TITLES: Record<DesktopAppId, string> = {
  'win-desktop': 'Windows 桌面',
  'win-documents': 'Windows 文稿',
  'win-downloads': 'Windows 下载',
  'win-local': 'Windows 本地文件',
  'mac-desktop': 'Mac 桌面',
  'linux-desktop': 'Linux 桌面',
  'linux-documents': 'Linux 文稿',
}

const MAX_WRITE_BYTES = 1024 * 1024

interface DesktopRootView {
  id: string
  label: string
  writable: boolean
}

function isDesktopAppId(v: string): v is DesktopAppId {
  return (DESKTOP_APP_IDS as readonly string[]).includes(v)
}

/** `win-local:local-1` → `win-local`；格式不对直接在本地拒绝（Rust 仍会再校验）。 */
function routeRoot(root: string): DesktopAppId {
  const value = root.trim()
  const idx = value.indexOf(':')
  if (idx <= 0 || idx === value.length - 1) {
    throw new Error(`[connected_app_bad_request] 根 id 无效：${root}；请先调用 list_desktop_roots`)
  }
  const appId = value.slice(0, idx)
  if (!isDesktopAppId(appId)) {
    throw new Error(`[connected_app_bad_request] 未知桌面文件根：${root}；请先调用 list_desktop_roots`)
  }
  return appId
}

/** 先过 shared 门禁，再取 store 里的状态用于确认文案（root 标签）。 */
async function readyStatus(appId: DesktopAppId, write = false): Promise<ConnectedAppStatus> {
  await assertAppReady(appId, { write })
  const status = useConnectedAppsStore().statusFor(appId)
  if (!status) {
    throw new Error(
      `[connected_app_not_connected] 连接应用「${APP_TITLES[appId]}」状态未知；请让用户重新打开「连接应用」`,
    )
  }
  return status
}

function rootLabel(status: ConnectedAppStatus, root: string): string {
  return status.roots.find((r) => r.id === root)?.label ?? root
}

function contentBytes(content: string): number {
  return new TextEncoder().encode(content).length
}

const ROOT_PARAM = Type.String({
  description: 'list_desktop_roots 返回的根 id，如 win-desktop:default / win-local:local-1',
})

export const tools: AppTool[] = [
  defineTool({
    name: 'list_desktop_roots',
    group: 'appDesktopFiles',
    label: '列出桌面文件根',
    description:
      '列出已连接并允许 AI 使用的桌面文件根（桌面/文稿/下载/授权文件夹）。返回根 id、名称与是否可写；不返回绝对路径。写文件前必须先用它拿到 root。没有根时提示用户去「连接应用」选择文件夹。',
    parameters: Type.Object({}),
    async execute() {
      const store = useConnectedAppsStore()
      await store.ensureLoaded()
      const appIds = DESKTOP_APP_IDS.filter((id) => store.aiEnabled(id))
      if (appIds.length === 0) {
        throw new Error(
          '[connected_app_not_connected] 没有已连接并允许 AI 使用的桌面文件应用；请让用户先在「连接应用」连接桌面/文稿/下载/本地文件并打开「允许 AI 使用」',
        )
      }

      const roots: DesktopRootView[] = []
      const failed: Array<{ app: string; message: string }> = []
      let anyMock = false
      let firstError: string | null = null
      for (const appId of appIds) {
        try {
          const reply = await callConnectedApp<{
            roots?: Array<DesktopRootView & { path?: string }>
          }>(appId, 'files_roots')
          if (reply.meta?.mock) anyMock = true
          for (const root of reply.data?.roots ?? []) {
            // 只给模型 id/label/writable，绝对路径必须剥离。
            roots.push({ id: root.id, label: root.label, writable: root.writable })
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          failed.push({ app: appId, message })
          firstError ??= message
        }
      }
      if (roots.length === 0) {
        throw new Error(
          firstError ??
            '[connected_app_no_root] 已连接的桌面文件应用还没有可用的根；请让用户去「连接应用」选择授权文件夹',
        )
      }
      return {
        roots,
        apps: appIds,
        ...(failed.length > 0 ? { failed } : {}),
        meta: { count: roots.length, ...(anyMock ? { mock: true } : {}) },
      }
    },
  }),

  defineTool({
    name: 'list_desktop_files',
    group: 'appDesktopFiles',
    label: '浏览桌面文件',
    description:
      '列出某个根下的一层文件与文件夹（不递归，最多 200 条）。path 是相对根的路径，缺省为根目录；拒绝绝对路径与 ..。符号链接只标记、不跟随。',
    parameters: Type.Object({
      root: ROOT_PARAM,
      path: Type.Optional(Type.String({ description: '相对根的路径，缺省为根目录' })),
      limit: Type.Optional(Type.Number({ description: '最多返回条数，1..200，默认 100' })),
    }),
    async execute(args) {
      const appId = routeRoot(args.root)
      await assertAppReady(appId)
      return withMeta(
        await callConnectedApp<Record<string, unknown>>(appId, 'files_list', {
          root: args.root,
          path: args.path ?? '',
          limit: args.limit ?? 100,
        }),
      )
    },
  }),

  defineTool({
    name: 'read_desktop_file',
    group: 'appDesktopFiles',
    label: '读取桌面文件',
    description:
      '按相对路径读取文本文件（≤1MB）。二进制/含 NUL 返回 not_text。长文本用 offset/maxChars 分页（默认 20000 字符，上限 50000），返回 nextOffset 时用同一个 offset 继续读。',
    parameters: Type.Object({
      root: ROOT_PARAM,
      path: Type.String({ description: '相对根的文件路径，如 notes/today.md' }),
      offset: Type.Optional(Type.Number({ description: '从第几个字符开始，默认 0' })),
      maxChars: Type.Optional(
        Type.Number({ description: '本次最多返回字符数，1..50000，默认 20000' }),
      ),
    }),
    async execute(args) {
      const appId = routeRoot(args.root)
      await assertAppReady(appId)
      return withMeta(
        await callConnectedApp<Record<string, unknown>>(appId, 'read_desktop_file', {
          root: args.root,
          path: args.path,
          offset: args.offset ?? 0,
          maxChars: args.maxChars ?? 20000,
        }),
      )
    },
  }),

  defineTool({
    name: 'search_desktop_files',
    group: 'appDesktopFiles',
    label: '搜索桌面文件',
    description:
      '在某个根内按文件名搜索（不搜内容）。深度 ≤4、扫描 ≤5000 个条目、结果 ≤50；跳过符号链接。query 1..64 字符。',
    parameters: Type.Object({
      root: ROOT_PARAM,
      query: Type.String({ description: '文件名关键词，1..64 字符' }),
      path: Type.Optional(Type.String({ description: '搜索起点（相对根），缺省为根目录' })),
      maxDepth: Type.Optional(Type.Number({ description: '最大深度 1..4，默认 4' })),
      limit: Type.Optional(Type.Number({ description: '最多返回 1..50 条，默认 20' })),
    }),
    async execute(args) {
      const appId = routeRoot(args.root)
      await assertAppReady(appId)
      return withMeta(
        await callConnectedApp<Record<string, unknown>>(appId, 'search_desktop_files', {
          root: args.root,
          query: args.query,
          path: args.path ?? '',
          maxDepth: args.maxDepth ?? 4,
          limit: args.limit ?? 20,
        }),
      )
    },
  }),

  defineTool({
    name: 'write_desktop_file',
    group: 'appDesktopFiles',
    label: '写入桌面文件',
    description:
      '写入文本文件（≤1MB）。默认不覆盖（目标存在返回 connected_app_exists）；overwrite:true 才覆盖，且用同目录临时文件 + rename。路径必须相对根、父目录已存在；每次写入都会弹确认。',
    dangerous: true,
    parameters: Type.Object({
      root: ROOT_PARAM,
      path: Type.String({ description: '相对根的文件路径' }),
      content: Type.String({ description: 'UTF-8 文本内容，≤1MB' }),
      overwrite: Type.Optional(Type.Boolean({ description: '是否覆盖已有文件，默认 false' })),
    }),
    async execute(args) {
      const appId = routeRoot(args.root)
      const status = await readyStatus(appId, true)
      const bytes = contentBytes(args.content)
      if (bytes > MAX_WRITE_BYTES) {
        throw new Error('[connected_app_too_large] 写入内容超过 1MB 上限')
      }
      const overwrite = args.overwrite === true
      return withMeta(
        await callConnectedAppWrite<Record<string, unknown>>(
          appId,
          'write_desktop_file',
          {
            root: args.root,
            path: args.path,
            content: args.content,
            overwrite,
          },
          {
            title: '写入桌面文件',
            danger: true,
            summary: `write_desktop_file ${args.root}/${args.path}`,
            body: [
              `应用：${APP_TITLES[appId]}`,
              `根：${rootLabel(status, args.root)}`,
              `路径：${args.path}`,
              overwrite ? '模式：覆盖已有文件' : '模式：不覆盖（目标存在会失败）',
              `内容：${bytes} 字节`,
              args.content ? `预览：${args.content.slice(0, 200)}` : '内容为空',
            ].join('\n'),
          },
        ),
      )
    },
  }),

  defineTool({
    name: 'create_desktop_folder',
    group: 'appDesktopFiles',
    label: '新建桌面文件夹',
    description:
      '逐段创建文件夹（mkdir -p）。已存在的目录跳过；同名文件返回 connected_app_exists。路径必须相对根，每段都检查根包含与链接；每次创建都会弹确认。',
    dangerous: true,
    parameters: Type.Object({
      root: ROOT_PARAM,
      path: Type.String({ description: '相对根的文件夹路径，可含多级，如 projects/2026' }),
    }),
    async execute(args) {
      const appId = routeRoot(args.root)
      const status = await readyStatus(appId, true)
      return withMeta(
        await callConnectedAppWrite<Record<string, unknown>>(
          appId,
          'create_desktop_folder',
          { root: args.root, path: args.path },
          {
            title: '新建桌面文件夹',
            danger: true,
            summary: `create_desktop_folder ${args.root}/${args.path}`,
            body: [
              `应用：${APP_TITLES[appId]}`,
              `根：${rootLabel(status, args.root)}`,
              `路径：${args.path}`,
              '已存在的目录会跳过；遇到同名文件会失败。',
            ].join('\n'),
          },
        ),
      )
    },
  }),

  defineTool({
    name: 'delete_desktop_file',
    group: 'appDesktopFiles',
    label: '删除桌面文件',
    description:
      '永久删除单个文件或空文件夹（不进回收站、不递归）。非空目录返回 connected_app_not_empty。每次删除都会弹确认并警告不可恢复。',
    dangerous: true,
    parameters: Type.Object({
      root: ROOT_PARAM,
      path: Type.String({ description: '相对根的文件或文件夹路径' }),
    }),
    async execute(args) {
      const appId = routeRoot(args.root)
      const status = await readyStatus(appId, true)
      return withMeta(
        await callConnectedAppWrite<Record<string, unknown>>(
          appId,
          'delete_desktop_file',
          { root: args.root, path: args.path },
          {
            title: '删除桌面文件',
            danger: true,
            summary: `delete_desktop_file ${args.root}/${args.path}`,
            body: [
              `应用：${APP_TITLES[appId]}`,
              `根：${rootLabel(status, args.root)}`,
              `路径：${args.path}`,
              '警告：永久删除，不进回收站；只支持单文件或空文件夹。',
            ].join('\n'),
          },
        ),
      )
    },
  }),

  defineTool({
    name: 'rename_desktop_file',
    group: 'appDesktopFiles',
    label: '重命名桌面文件',
    description:
      '在同一文件夹内重命名文件或文件夹；目标必须不存在（否则 connected_app_exists），不能跨目录/跨根。每次重命名都会弹确认。',
    dangerous: true,
    parameters: Type.Object({
      root: ROOT_PARAM,
      from: Type.String({ description: '原相对路径' }),
      to: Type.String({ description: '新相对路径，必须与原路径在同一目录' }),
    }),
    async execute(args) {
      const appId = routeRoot(args.root)
      const status = await readyStatus(appId, true)
      return withMeta(
        await callConnectedAppWrite<Record<string, unknown>>(
          appId,
          'rename_desktop_file',
          { root: args.root, from: args.from, to: args.to },
          {
            title: '重命名桌面文件',
            danger: true,
            summary: `rename_desktop_file ${args.root}/${args.from}`,
            body: [
              `应用：${APP_TITLES[appId]}`,
              `根：${rootLabel(status, args.root)}`,
              `从：${args.from}`,
              `到：${args.to}`,
              '目标必须不存在；不能跨目录或跨根。',
            ].join('\n'),
          },
        ),
      )
    },
  }),
]

export const appDesktopFilesTools = tools
