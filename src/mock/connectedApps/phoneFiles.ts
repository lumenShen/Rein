/**
 * 安卓 SAF 文件 · mock 样例（内存树）。
 *
 * 与 Kotlin `FileOps` 保持同一套语义，供浏览器 e2e 断言：
 * - root id 固定 `filesystem:default`；
 * - 路径必须是相对路径，拒绝 `/` 开头、`..`、`.`、空段、NUL、>512；
 * - 读 ≤1MB，含 NUL → `connected_app_not_text`；写 ≤1MB，默认不覆盖；
 * - 删除只删单文件或空目录，非空 → `connected_app_not_empty`；
 * - 写/建目录返回 provider 风格的实际 path/displayName（mock 不改名）。
 */

import { clampInt, fail, ok, text, type MockAppHandler, type MockPayload } from './shared'

const ROOT = { id: 'filesystem:default', label: 'Demo 文档', writable: true }
const MAX_PATH = 512
const MAX_SEGMENT = 255
const MAX_READ_BYTES = 1024 * 1024
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_SCAN = 2000

const files = new Map<string, string>([
  ['notes/today.md', '# 今天\n\n- 写手机文件工具\n'],
  ['notes/ideas.txt', '一个想法：把连接应用做成 AI 工具组。\n'],
  ['readme.txt', 'Rein 手机文件 mock\n'],
  ['projects/rein/roadmap.md', '# Roadmap\n\n- SAF 读写\n- 工具确认\n'],
  // 二进制样例：读取必须返回 connected_app_not_text。
  ['photos/pixel.bin', 'PNG\u0000\u0001\u0002mock-binary'],
])

const dirs = new Set<string>(['notes', 'projects', 'projects/rein', 'photos', 'empty'])

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

/** 相对路径 → 规范形式；非法返回 null。空串 = 根。 */
function normalizePath(raw: string): string | null {
  const value = raw.trim()
  if (!value) return ''
  if (value.length > MAX_PATH) return null
  if (value.startsWith('/')) return null
  const trimmed = value.replace(/\/+$/, '')
  if (!trimmed) return ''
  const parts = trimmed.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return null
    if (part.length > MAX_SEGMENT) return null
    if (part.includes('\u0000')) return null
    out.push(part)
  }
  return out.join('/')
}

function isDir(path: string): boolean {
  return path === '' || dirs.has(path)
}

function hasChildren(dir: string): boolean {
  const prefix = dir ? `${dir}/` : ''
  for (const path of files.keys()) {
    if (path.startsWith(prefix) && path !== dir) return true
  }
  for (const path of dirs) {
    if (path !== dir && path.startsWith(prefix)) return true
  }
  return false
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function join(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

interface Entry {
  name: string
  path: string
  type: 'file' | 'dir'
  size: number | null
  lastModified: number | null
}

/** 某目录的直接子项（目录在前、名称排序）。 */
function children(dir: string): Entry[] {
  const prefix = dir ? `${dir}/` : ''
  const entries = new Map<string, Entry>()
  const now = Date.now()

  for (const path of dirs) {
    if (path === dir || !path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const head = rest.split('/')[0]
    if (!head) continue
    entries.set(join(dir, head), {
      name: head,
      path: join(dir, head),
      type: 'dir',
      size: null,
      lastModified: now,
    })
  }
  for (const [path, content] of files) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    if (!rest) continue
    const head = rest.split('/')[0]
    if (rest.includes('/')) {
      if (!entries.has(join(dir, head))) {
        entries.set(join(dir, head), {
          name: head,
          path: join(dir, head),
          type: 'dir',
          size: null,
          lastModified: now,
        })
      }
      continue
    }
    entries.set(path, {
      name: head,
      path,
      type: 'file',
      size: byteLength(content),
      lastModified: now,
    })
  }

  return [...entries.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function addDirChain(path: string, created: string[]): { ok: true; actual: string } | { ok: false; code: string } {
  if (!path) return { ok: true, actual: '' }
  let current = ''
  const actual: string[] = []
  for (const segment of path.split('/')) {
    const target = join(current, segment)
    if (files.has(target)) return { ok: false, code: 'connected_app_exists' }
    if (!dirs.has(target)) {
      dirs.add(target)
      created.push(target)
    }
    actual.push(segment)
    current = target
  }
  return { ok: true, actual: actual.join('/') }
}

function moveDir(from: string, to: string): void {
  const prefix = `${from}/`
  for (const path of [...dirs]) {
    if (path === from) continue
    if (path.startsWith(prefix)) {
      dirs.delete(path)
      dirs.add(to + path.slice(from.length))
    }
  }
  for (const [path, content] of [...files]) {
    if (!path.startsWith(prefix)) continue
    files.delete(path)
    files.set(to + path.slice(from.length), content)
  }
  dirs.delete(from)
  dirs.add(to)
}

/** 所有非根操作统一校验 root；未知 root 返回 no_root。 */
function rootError(payload: MockPayload): ReturnType<typeof fail> | null {
  const root = text(payload.root).trim()
  if (root && root !== ROOT.id) {
    return fail('filesystem', 'files_roots', 'connected_app_no_root', `未知的文件根：${root}`, 'folder')
  }
  return null
}

export const phoneFilesMock: MockAppHandler = (app, method, payload: MockPayload) => {
  if (method === 'files_roots') {
    return ok(app, method, { root: ROOT.id, roots: [ROOT] })
  }

  const rootIssue = rootError(payload)
  if (rootIssue) return { ...rootIssue, app, method }

  switch (method) {
    case 'files_list': {
      const raw = text(payload.path)
      const path = normalizePath(raw)
      if (path === null) {
        return fail(app, method, 'connected_app_bad_request', 'path 必须是相对路径，且不能包含 .. 或空段')
      }
      if (!isDir(path)) {
        return fail(app, method, 'connected_app_not_found', `目录不存在：${path}`)
      }
      const limit = clampInt(payload.limit, 1, 200, 100)
      const all = children(path)
      return ok(app, method, {
        root: ROOT.id,
        path,
        items: all.slice(0, limit),
        truncated: all.length > limit,
      })
    }

    case 'read_phone_file': {
      const path = normalizePath(text(payload.path))
      if (path === null) {
        return fail(app, method, 'connected_app_bad_request', 'path 必须是相对路径，且不能包含 .. 或空段')
      }
      if (!path) return fail(app, method, 'connected_app_bad_request', 'path 不能为空')
      if (isDir(path)) return fail(app, method, 'connected_app_bad_request', `不能读取目录：${path}`)
      const content = files.get(path)
      if (content === undefined) {
        return fail(app, method, 'connected_app_not_found', `文件不存在：${path}`)
      }
      const bytes = byteLength(content)
      if (bytes > MAX_READ_BYTES) {
        return fail(app, method, 'connected_app_too_large', `文件超过 1MB 上限：${bytes} 字节`)
      }
      if (content.includes('\u0000')) {
        return fail(app, method, 'connected_app_not_text', '文件包含二进制内容（NUL），不是文本')
      }
      return ok(app, method, {
        root: ROOT.id,
        path,
        displayName: baseName(path),
        content,
        bytes,
        truncated: false,
      })
    }

    case 'search_phone_files': {
      const query = text(payload.query).trim()
      if (!query || query.length > 64) {
        return fail(app, method, 'connected_app_bad_request', 'query 长度必须为 1..64')
      }
      const start = normalizePath(text(payload.path))
      if (start === null) {
        return fail(app, method, 'connected_app_bad_request', 'path 必须是相对路径，且不能包含 .. 或空段')
      }
      if (!isDir(start)) {
        return fail(app, method, 'connected_app_not_found', `目录不存在：${start}`)
      }
      const maxDepth = clampInt(payload.maxDepth, 1, 4, 2)
      const limit = clampInt(payload.limit, 1, 50, 20)
      const needle = query.toLowerCase()
      const items: Entry[] = []
      let scanned = 0
      let truncated = false

      const queue: Array<{ path: string; depth: number }> = [{ path: start, depth: 0 }]
      while (queue.length) {
        const current = queue.shift()
        if (!current) break
        const list = children(current.path)
        scanned += list.length
        if (scanned > MAX_SCAN) {
          truncated = true
          break
        }
        for (const entry of list) {
          if (entry.name.toLowerCase().includes(needle)) {
            items.push(entry)
            if (items.length >= limit) {
              truncated = true
              break
            }
          }
          const childDepth = current.depth + 1
          if (entry.type === 'dir' && childDepth < maxDepth) {
            queue.push({ path: entry.path, depth: childDepth })
          }
        }
        if (items.length >= limit) break
      }

      return ok(app, method, {
        root: ROOT.id,
        path: start,
        query,
        items,
        scanned,
        truncated,
      })
    }

    case 'write_phone_file': {
      const path = normalizePath(text(payload.path))
      if (path === null || !path) {
        return fail(app, method, 'connected_app_bad_request', 'path 不能为空且必须是相对路径')
      }
      const content = text(payload.content)
      const bytes = byteLength(content)
      if (bytes > MAX_WRITE_BYTES) {
        return fail(app, method, 'connected_app_too_large', `写入内容超过 1MB（${bytes} 字节）`)
      }
      const parent = parentOf(path)
      if (!isDir(parent)) {
        return fail(app, method, 'connected_app_not_found', `父目录不存在：${parent || '（根）'}`)
      }
      if (isDir(path)) {
        return fail(app, method, 'connected_app_exists', `同名目录已存在：${baseName(path)}`)
      }
      if (files.has(path) && payload.overwrite !== true) {
        return fail(
          app,
          method,
          'connected_app_exists',
          `文件已存在：${baseName(path)}（需要覆盖请传 overwrite:true）`,
        )
      }
      files.set(path, content)
      return ok(app, method, {
        root: ROOT.id,
        path,
        displayName: baseName(path),
        bytes,
        written: true,
      })
    }

    case 'create_phone_folder': {
      const path = normalizePath(text(payload.path))
      if (path === null || !path) {
        return fail(app, method, 'connected_app_bad_request', 'path 不能为空且必须是相对路径')
      }
      const created: string[] = []
      const result = addDirChain(path, created)
      if (!result.ok) {
        return fail(app, method, result.code, '同名文件已存在，无法创建目录')
      }
      return ok(app, method, {
        root: ROOT.id,
        path: result.actual,
        displayName: baseName(result.actual),
        created: true,
        segments: result.actual ? result.actual.split('/') : [],
      })
    }

    case 'delete_phone_file': {
      const path = normalizePath(text(payload.path))
      if (path === null || !path) {
        return fail(app, method, 'connected_app_bad_request', '不能删除根目录')
      }
      if (isDir(path)) {
        if (hasChildren(path)) {
          return fail(app, method, 'connected_app_not_empty', `目录非空，未删除：${path}`)
        }
        dirs.delete(path)
        return ok(app, method, { root: ROOT.id, path, type: 'dir', deleted: true })
      }
      if (!files.has(path)) {
        return fail(app, method, 'connected_app_not_found', `文件或目录不存在：${path}`)
      }
      files.delete(path)
      return ok(app, method, { root: ROOT.id, path, type: 'file', deleted: true })
    }

    case 'rename_phone_file': {
      const from = normalizePath(text(payload.from))
      if (from === null || !from) {
        return fail(app, method, 'connected_app_bad_request', 'from 不能为空且必须是相对路径')
      }
      const to = text(payload.to).trim()
      if (!to || to === '.' || to === '..' || to.includes('/') || to.includes('\u0000')) {
        return fail(app, method, 'connected_app_bad_request', 'to 必须是同目录下的文件名（不能含 /）')
      }
      if (!files.has(from) && !isDir(from)) {
        return fail(app, method, 'connected_app_not_found', `文件或目录不存在：${from}`)
      }
      const target = join(parentOf(from), to)
      if (target === from) {
        return ok(app, method, {
          root: ROOT.id,
          from,
          to: from,
          displayName: to,
          renamed: true,
        })
      }
      if (files.has(target) || isDir(target)) {
        return fail(app, method, 'connected_app_exists', `目标名称已存在：${to}`)
      }
      if (isDir(from)) {
        moveDir(from, target)
      } else {
        const content = files.get(from)
        if (content === undefined) {
          return fail(app, method, 'connected_app_not_found', `文件不存在：${from}`)
        }
        files.delete(from)
        files.set(target, content)
      }
      return ok(app, method, {
        root: ROOT.id,
        from,
        to: target,
        displayName: to,
        renamed: true,
      })
    }

    default:
      return fail(app, method, 'connected_app_unknown_method', `文件系统不支持方法 ${method}`)
  }
}
