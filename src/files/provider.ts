/**
 * 虚拟文件系统的 provider 抽象。
 *
 * 本地工作区只是**一个** provider（`kb://`，数据在 `kb_files` + `kb_docs` 里）；
 * 接口刻意按「目录列举 + 原子操作 + 能力声明」三件事收窄，将来接云/网络/压缩包 provider
 * 时上层（选择、队列、菜单、快捷键）一行都不用改。
 *
 * 分工：
 * - provider = 一个条目的原子操作（快、无 UI 概念，失败就抛错）；
 * - 上层 = 把原子操作排成队列（进度、取消、逐条失败报告、撤销提示），见 opQueue.ts。
 *   批量语义**不在 provider 里**——那会让每个 provider 都实现一遍队列与冲突策略。
 */

import { kbService } from '@/services/kbService'
import type { KbEntry, KbTrashEntry } from '@/types'
import { displayNameOf, splitExt } from './sort'
import type { DirListing, FileAction, FileItem, FileKind } from './types'

/** 本地虚拟文件系统的 scheme。id 用 `kb:{path}`，将来 `cloud:{path}` 自然分家。 */
export const KB_PROVIDER_ID = 'kb'

const DERIVED_REASON = '这是应用数据的只读投影，改内容要回它自己的页面'
const SYSTEM_REASON = '系统文件随应用版本更新，不可修改'

/**
 * SQLite 时间串 → 毫秒。`YYYY-MM-DD HH:MM:SS` 按 UTC 解析（补 T/Z），坏值返回 undefined。
 * 导出给同样要读 `KbEntry.updatedAt` 的投影页面复用，避免各页再抄一份解析规则。
 */
export function toMs(v: string | null | undefined): number | undefined {
  if (!v) return undefined
  // SQLite 存的是 `YYYY-MM-DD HH:MM:SS`（UTC），补上 T/Z 才不会被当本地时间
  const iso = v.includes('T') ? v : `${v.replace(' ', 'T')}Z`
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : undefined
}

function toKind(kind: string): FileKind {
  return kind === 'folder' ||
    kind === 'image' ||
    kind === 'audio' ||
    kind === 'video' ||
    kind === 'file'
    ? kind
    : 'text'
}

/** KbEntry → FileItem（视图模型）。权限与只读原因在这里一次算清，UI 不重复判断。
 *
 *  `hideExtension` 默认 **false**：扩展名是信息不是噪音（.md / .wav / .zip 的区别有意义），
 *  隐藏是显示层偏好，由界面按用户设置再覆盖（见 sort.ts::withDisplayName）。
 */
export function toFileItem(e: KbEntry, hideExtension = false): FileItem {
  const isDir = e.kind === 'folder'
  // sourceType 非 note 的 = 应用数据的派生投影（日程/运动/饮食…），只读
  const derived = !isDir && !!e.sourceType && e.sourceType !== 'note'
  const readOnly = e.system || derived
  const { ext } = splitExt(e.name)
  const modifiedAt = toMs(e.updatedAt)
  return {
    id: `${KB_PROVIDER_ID}:${e.path}`,
    uri: `${KB_PROVIDER_ID}://${e.path}`,
    name: e.name,
    displayName: displayNameOf(e.name, hideExtension),
    // 排序名恒用完整名字：换「隐藏扩展名」开关不该把顺序也搅乱
    sortName: e.name.toLowerCase(),
    extension: ext || undefined,
    kind: toKind(e.kind),
    isDir,
    size: e.size,
    modifiedAt,
    createdAt: modifiedAt,
    occurredOn: e.occurredOn,
    attributes: {
      hidden: e.name.startsWith('.'),
      readOnly,
      system: e.system,
    },
    permissions: {
      canRead: true,
      canWrite: !readOnly && !isDir,
      canDelete: !readOnly,
      canRename: !readOnly,
    },
    childCount: e.childCount,
    rating: e.rating,
    tags: e.tags,
    hasNote: e.hasNote,
    pinned: e.pinned,
    classifyState: e.classifyState,
    modalities: e.modalities,
    readOnlyReason: e.system ? SYSTEM_REASON : derived ? DERIVED_REASON : undefined,
    docId: e.id > 0 ? e.id : undefined,
    fileId: e.fileId ?? undefined,
    sourceType: e.sourceType || undefined,
    title: e.title,
    cloudState: 'local',
    providerId: KB_PROVIDER_ID,
  }
}

/** 回收站条目 → FileItem（没有文件实体功能：只能恢复或彻底删除） */
export function trashToFileItem(t: KbTrashEntry, hideExtension = false): FileItem {
  const { ext } = splitExt(t.name)
  const modifiedAt = toMs(t.trashedAt)
  return {
    id: `${KB_PROVIDER_ID}:${t.path}`,
    uri: `${KB_PROVIDER_ID}://${t.path}`,
    name: t.name,
    displayName: displayNameOf(t.name, hideExtension),
    sortName: t.name.toLowerCase(),
    extension: ext || undefined,
    kind: toKind(t.kind),
    isDir: t.kind === 'folder',
    size: t.size,
    modifiedAt,
    createdAt: modifiedAt,
    attributes: { hidden: false, readOnly: false, system: t.system },
    permissions: { canRead: false, canWrite: false, canDelete: true, canRename: false },
    childCount: 0,
    rating: 0,
    tags: [],
    hasNote: false,
    pinned: false,
    classifyState: '',
    modalities: [],
    fileId: t.fileId,
    title: t.name,
    cloudState: 'local',
    providerId: KB_PROVIDER_ID,
  }
}

/** 文件管理器里一次操作要用的 provider 形状 */
export interface IFileSystemProvider {
  readonly id: string
  readonly label: string
  listDir(path: string): Promise<DirListing>
  listTrash(): Promise<FileItem[]>
  /** 按文件名检索（跨目录）。正文检索走知识库页（FTS + 向量），这里只做名字 */
  search(keyword: string, limit?: number): Promise<FileItem[]>
  mkdir(path: string): Promise<void>
  /** 改名（只改名字，同目录）；返回新路径 */
  rename(item: FileItem, nextName: string): Promise<string>
  /** 移动到目标目录；返回新路径。`asName` 非空时用它当目标名（冲突策略「保留两者」用） */
  move(item: FileItem, toDir: string, asName?: string): Promise<string>
  /** 复制一个条目到目标目录（文本走内容、多模态走本体）；返回新路径 */
  duplicate(item: FileItem, toDir: string, asName?: string): Promise<string>
  trash(item: FileItem): Promise<void>
  restore(item: FileItem): Promise<void>
  purge(item: FileItem): Promise<void>
  emptyTrash(): Promise<void>
  /** 该条目能不能做这件事；不能就给一句人话原因（菜单据此禁用并提示） */
  capability(item: FileItem, action: FileAction): { ok: boolean; reason?: string }
}

/** 工作区当前路径下的目录名（改名/移动的目标目录用） */
export function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

export const kbProvider: IFileSystemProvider = {
  id: KB_PROVIDER_ID,
  label: '工作区',

  async listDir(path) {
    const l = await kbService.listDir(path)
    return {
      path: l.path,
      items: l.entries.map((e) => toFileItem(e)),
      total: l.total,
      truncated: l.truncated,
    }
  },

  async listTrash() {
    const rows = await kbService.trashList(200)
    return rows.map((t) => trashToFileItem(t))
  },

  async search(keyword, limit = 200) {
    const kw = keyword.trim().replace(/[*?/\\]/g, '')
    if (!kw) return []
    const hits = await kbService.glob(`**/*${kw}*`, limit)
    return hits.map((h) =>
      toFileItem({
        id: h.id,
        fileId: null,
        path: h.path,
        name: h.path.split('/').pop() ?? h.path,
        kind: h.kind,
        sourceType: h.sourceType,
        title: h.title,
        system: h.system,
        editable: h.editable,
        size: 0,
        childCount: 0,
        occurredOn: h.occurredOn,
        updatedAt: '',
        pinned: false,
        classifyState: '',
        modalities: ['text'],
        // 名字检索（glob）不返回用户元数据：列表里这几列留空，不假装有
        rating: 0,
        tags: [],
        hasNote: false,
      }),
    )
  },

  async mkdir(path) {
    await kbService.fsMkdir(path, '用户在文件管理器新建', 'user')
  },

  async rename(item, nextName) {
    if (item.fileId === undefined) throw new Error('该条目没有文件实体，不能改名')
    const target = joinPath(parentOf(item.uri.split('://')[1] ?? item.name), nextName)
    const f = await kbService.fileRename(item.fileId, target)
    return f.path
  },

  async move(item, toDir, asName) {
    const path = item.uri.split('://')[1] ?? item.name
    const name = asName ?? item.name
    if (item.isDir) {
      // 目录只有占位节点，「移动目录」= 改目录本身的名字前缀（其子项由路径派生，跟着走）
      const f = await kbService.fileRename(item.fileId ?? item.docId ?? 0, joinPath(toDir, name))
      return f.path
    }
    // 真实文件走治理层移动（保留区让位、审计、可按批撤销）。
    // asName 指定了目标名时：改名到目标目录（rename 语义，不再让位）——那是「保留两者」用过的名字。
    if (asName && item.fileId !== undefined) {
      const f = await kbService.fileRename(item.fileId, joinPath(toDir, name))
      return f.path
    }
    if (item.fileId !== undefined || item.docId !== undefined) {
      const res = await kbService.fsMove(
        item.docId ?? item.fileId!,
        toDir,
        '用户在文件管理器移动',
        'user',
      )
      return res.to
    }
    throw new Error(`不能移动 ${path}`)
  },

  async duplicate(item, toDir, asName) {
    const target = joinPath(toDir, asName ?? item.name)
    // 多模态：本体也要跟着复制，否则副本是个空壳
    if (item.modalities?.some((m) => m !== 'text') && item.docId !== undefined) {
      const m = await kbService.mediaGet(item.docId, item.modalities.find((x) => x !== 'text')!)
      if (m.dataUrl) {
        const f = await kbService.mediaWrite({
          path: target,
          name: item.name,
          mime: m.mime ?? 'application/octet-stream',
          dataBase64: m.dataUrl,
          text: `【副本】${item.title ?? item.name}`,
        })
        return f.path
      }
    }
    if (item.fileId === undefined) throw new Error('该条目没有文件实体，不能复制')
    const src = await kbService.fileGet(item.fileId)
    const f = await kbService.fileWrite({ path: target, content: src.content })
    return f.path
  },

  async trash(item) {
    if (item.fileId === undefined) throw new Error('该条目没有文件实体，不能删除')
    await kbService.trash(item.fileId)
  },

  async restore(item) {
    if (item.fileId === undefined) throw new Error('该条目没有文件实体，不能恢复')
    const r = await kbService.trashRestore([item.fileId])
    if (r.failed.length) throw new Error(r.failed[0])
  },

  async purge(item) {
    if (item.fileId === undefined) throw new Error('该条目没有文件实体，不能彻底删除')
    const r = await kbService.trashPurge([item.fileId])
    if (r.failed.length) throw new Error(r.failed[0])
  },

  async emptyTrash() {
    await kbService.trashEmpty()
  },

  /**
   * 能力声明。UI（菜单、快捷键、按钮）**只问这里**，不自己读 system/kind 去猜：
   * 判据只有一处，将来接别的 provider 也不会出现「菜单能点但执行报错」。
   */
  capability(item, action) {
    const deny = (reason: string): { ok: boolean; reason?: string } => ({ ok: false, reason })
    // 搜索结果与派生投影没有文件实体（`fileId === undefined`）——rename/move/delete/copy
    // 在实现里都会抛「该条目没有文件实体」。能力声明必须先按同一判据拒绝，
    // 否则菜单是亮的、一点必失败（全选搜索结果批量删除就是 20 条逐条报错）。
    const noEntity = deny(
      item.sourceType && item.sourceType !== 'note'
        ? DERIVED_REASON
        : '搜索结果只能打开，操作请到原目录',
    )
    switch (action) {
      case 'open':
        // 目录也能「打开」（进入它），所以这里恒为真
        return { ok: true }
      case 'preview':
        return item.permissions.canRead ? { ok: true } : deny('回收站里的条目没有可读内容')
      case 'rename':
      case 'move': {
        if (!item.permissions.canRename) {
          return deny(item.readOnlyReason ?? (action === 'move' ? '没有移动权限' : '没有改名权限'))
        }
        return item.fileId !== undefined ? { ok: true } : noEntity
      }
      case 'delete': {
        if (!item.permissions.canDelete) return deny(item.readOnlyReason ?? '没有删除权限')
        return item.fileId !== undefined ? { ok: true } : noEntity
      }
      case 'copy': {
        if (item.isDir) return deny('暂不支持复制目录')
        // 与 duplicate 的两条路径对齐：有文件实体，或多模态投影（有本体可复制）
        const canCopy =
          item.fileId !== undefined ||
          (item.docId !== undefined && (item.modalities ?? []).some((m) => m !== 'text'))
        return canCopy ? { ok: true } : noEntity
      }
      case 'pin':
        return item.sourceType === 'note' && !item.attributes.system
          ? { ok: true }
          : deny('只有工作区里的笔记/文件可以钉住')
      case 'restore':
      case 'purge':
        return item.fileId !== undefined ? { ok: true } : deny('该条目没有文件实体')
      default:
        return { ok: true }
    }
  },
}
