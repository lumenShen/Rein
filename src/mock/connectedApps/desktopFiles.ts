/**
 * 桌面文件 · 7 个桌面 app 共享的 mock 样例树。
 *
 * 与真实 Rust 行为保持同一组语义（不冒充成功）：
 * - 路径必须是相对根，拒绝绝对路径 / `..` / 空段；
 * - 读不存在的文件 → `connected_app_not_found`；
 * - 写默认不覆盖，已存在 → `connected_app_exists`；
 * - 删除只支持单文件或空目录，非空 → `connected_app_not_empty`；
 * - 重命名同目录、目标不存在；
 * - 建目录逐段创建，遇同名文件 → `connected_app_exists`。
 *
 * 写权限的整体拒绝（`__REIN_MOCK_APP_WRITE_DENIED__`）由 `mock/connectedApps/index.ts`
 * 在进入 handler 之前统一处理。
 */

import { clampInt, fail, ok, text, type MockAppHandler, type MockPayload } from './shared'

interface DesktopRoot {
  id: string
  label: string
  path: string
  writable: boolean
}

const ROOTS: Record<string, DesktopRoot> = {
  'win-desktop': {
    id: 'win-desktop:default',
    label: '桌面',
    path: 'C:\\Users\\Mock\\Desktop',
    writable: true,
  },
  'win-documents': {
    id: 'win-documents:default',
    label: '文稿',
    path: 'C:\\Users\\Mock\\Documents',
    writable: true,
  },
  'win-downloads': {
    id: 'win-downloads:default',
    label: '下载',
    path: 'C:\\Users\\Mock\\Downloads',
    writable: true,
  },
  'win-local': {
    id: 'win-local:local-1',
    label: 'Projects',
    path: 'C:\\Users\\Mock\\Projects',
    writable: true,
  },
  'mac-desktop': {
    id: 'mac-desktop:default',
    label: '桌面',
    path: '/Users/mock/Desktop',
    writable: true,
  },
  'linux-desktop': {
    id: 'linux-desktop:default',
    label: '桌面',
    path: '/home/mock/Desktop',
    writable: true,
  },
  'linux-documents': {
    id: 'linux-documents:default',
    label: '文稿',
    path: '/home/mock/Documents',
    writable: true,
  },
}

const SAMPLES: Record<string, Record<string, string>> = {
  'win-desktop': {
    'notes.md': '# Windows 桌面样例\n\n- 整理桌面\n- 归档截图\n',
    'todo.txt': '整理连接应用契约\n',
    'Projects/readme.md': '项目说明：桌面文件 mock 样例。\n',
  },
  'win-documents': {
    'notes.md': '# 文稿样例\n\n周报与合同都在这里。\n',
    'todo.txt': '归档 2026 年文档\n',
    'contracts/demo.txt': '示例合同文本（mock）。\n',
  },
  'win-downloads': {
    'notes.md': '# 下载样例\n\n安装包与临时文件。\n',
    'todo.txt': '清理下载目录\n',
    'installers/demo.txt': '示例安装包说明（mock）。\n',
  },
  'win-local': {
    'notes.md': '# 授权文件夹样例\n\n这个根由用户在选择器里授权。\n',
    'todo.txt': '检查本地项目\n',
    'src/main.rs': 'fn main() {\n    println!("mock");\n}\n',
  },
  'mac-desktop': {
    'notes.md': '# Mac 桌面样例\n\n未在本机验证。\n',
    'todo.txt': '检查 Mac 桌面\n',
  },
  'linux-desktop': {
    'notes.md': '# Linux 桌面样例\n\n未在本机验证。\n',
    'todo.txt': '检查 Linux 桌面\n',
  },
  'linux-documents': {
    'notes.md': '# Linux 文稿样例\n\n未在本机验证。\n',
    'todo.txt': '整理文稿\n',
  },
}

const files = new Map<string, Map<string, string>>()
const explicitDirs = new Map<string, Set<string>>()

function tree(app: string): Map<string, string> {
  let t = files.get(app)
  if (!t) {
    t = new Map(Object.entries(SAMPLES[app] ?? { 'notes.md': `# ${app} 样例\n` }))
    files.set(app, t)
  }
  return t
}

function dirs(app: string): Set<string> {
  let d = explicitDirs.get(app)
  if (!d) {
    d = new Set()
    explicitDirs.set(app, d)
  }
  return d
}

/** 空串 = 根；格式非法返回 null（绝对路径 / 盘符 / `..` / `.` / 空段 / 过长）。 */
function safeRel(raw: string): string | null {
  const value = raw.trim()
  if (!value) return ''
  if (value.length > 512) return null
  if (/^[\\/]/.test(value) || /^[A-Za-z]:/.test(value)) return null
  const parts = value.replace(/\\/g, '/').split('/')
  if (parts.some((seg) => seg === '' || seg === '.' || seg === '..')) return null
  return parts.join('/')
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx < 0 ? '' : path.slice(0, idx)
}

/** UTF-8 字节数（与 Rust 的 1MB 上限同一口径）。 */
function byteLen(value: string): number {
  return new TextEncoder().encode(value).length
}

function isDir(app: string, path: string): boolean {
  if (!path) return true
  if (dirs(app).has(path)) return true
  const prefix = `${path}/`
  return [...tree(app).keys()].some((p) => p.startsWith(prefix))
}

function hasChildren(app: string, path: string): boolean {
  const prefix = `${path}/`
  return (
    [...tree(app).keys()].some((p) => p.startsWith(prefix)) ||
    [...dirs(app)].some((d) => d.startsWith(prefix))
  )
}

function children(app: string, dir: string) {
  const prefix = dir ? `${dir}/` : ''
  const names = new Set<string>()
  for (const path of tree(app).keys()) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    if (!rest) continue
    names.add(rest.split('/')[0])
  }
  for (const path of dirs(app)) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    if (!rest) continue
    names.add(rest.split('/')[0])
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 200)
    .map((name) => {
      const full = prefix + name
      const directory = isDir(app, full)
      return {
        name,
        path: full,
        type: directory ? 'dir' : 'file',
        size: directory ? null : byteLen(tree(app).get(full) ?? ''),
      }
    })
}

function badPath(app: string, method: string) {
  return fail(
    app,
    method,
    'connected_app_path_denied',
    '路径必须是根内的相对路径（拒绝绝对路径、盘符与 ..）',
  )
}

export const desktopFilesMock: MockAppHandler = (app, method, payload: MockPayload) => {
  const root = ROOTS[app]
  if (!root) return fail(app, method, 'connected_app_bad_request', `没有 ${app} 的桌面文件样例`)

  switch (method) {
    case 'files_roots':
      return ok(app, method, { roots: [root] })

    case 'files_list': {
      const path = safeRel(text(payload.path))
      if (path === null) return badPath(app, method)
      if (!isDir(app, path)) {
        return fail(app, method, 'connected_app_not_found', '文件夹不存在')
      }
      const limit = clampInt(payload.limit, 1, 200, 100)
      const items = children(app, path)
      return ok(app, method, {
        root: root.id,
        path,
        items: items.slice(0, limit),
        truncated: items.length > limit,
      })
    }

    case 'read_desktop_file': {
      const path = safeRel(text(payload.path))
      if (path === null || !path) return badPath(app, method)
      const content = tree(app).get(path)
      if (content === undefined) {
        if (isDir(app, path)) {
          return fail(app, method, 'connected_app_bad_request', '目标是文件夹，不能按文本读取')
        }
        return fail(app, method, 'connected_app_not_found', '文件不存在')
      }
      const maxChars = clampInt(payload.maxChars, 1, 50_000, 20_000)
      const offset = clampInt(payload.offset, 0, 1_000_000, 0)
      const total = content.length
      const start = Math.min(offset, total)
      const page = content.slice(start, start + maxChars)
      const next = start + page.length
      const truncated = next < total
      return ok(app, method, {
        root: root.id,
        path,
        content: page,
        offset: start,
        nextOffset: truncated ? next : null,
        bytes: byteLen(content),
        totalChars: total,
        truncated,
      })
    }

    case 'search_desktop_files': {
      const base = safeRel(text(payload.path))
      if (base === null) return badPath(app, method)
      if (!isDir(app, base)) {
        return fail(app, method, 'connected_app_not_found', '搜索起点不存在')
      }
      const query = text(payload.query).trim()
      if (!query || query.length > 64) {
        return fail(app, method, 'connected_app_bad_request', '搜索词需为 1..64 个字符')
      }
      const maxDepth = clampInt(payload.maxDepth, 1, 4, 4)
      const limit = clampInt(payload.limit, 1, 50, 20)
      const prefix = base ? `${base}/` : ''
      const needle = query.toLowerCase()
      const candidates = [...tree(app).keys()]
      const dirCandidates = [...dirs(app)]
      let scanned = 0
      const items: Array<{ name: string; path: string; type: string; size: number }> = []
      for (const path of candidates) {
        if (scanned >= 5000 || items.length >= limit) break
        if (!path.startsWith(prefix)) continue
        scanned += 1
        const rest = path.slice(prefix.length)
        if (rest.split('/').length > maxDepth) continue
        const name = rest.split('/').pop() ?? rest
        if (name.toLowerCase().includes(needle)) {
          items.push({ name, path, type: 'file', size: byteLen(tree(app).get(path) ?? '') })
        }
      }
      for (const path of dirCandidates) {
        if (scanned >= 5000 || items.length >= limit) break
        if (!path.startsWith(prefix)) continue
        scanned += 1
        const rest = path.slice(prefix.length)
        if (rest.split('/').length > maxDepth) continue
        const name = rest.split('/').pop() ?? rest
        if (name.toLowerCase().includes(needle)) {
          items.push({ name, path, type: 'dir', size: 0 })
        }
      }
      return ok(app, method, {
        root: root.id,
        path: base,
        query,
        items,
        scanned,
        truncated: items.length >= limit,
      })
    }

    case 'write_desktop_file': {
      const path = safeRel(text(payload.path))
      if (path === null || !path) return badPath(app, method)
      if (isDir(app, path)) {
        return fail(app, method, 'connected_app_exists', '同名文件夹已存在，不能按文件写入')
      }
      const exists = tree(app).has(path)
      if (exists && payload.overwrite !== true) {
        return fail(
          app,
          method,
          'connected_app_exists',
          '文件已存在；如需覆盖请显式传 overwrite:true',
        )
      }
      if (!isDir(app, parentOf(path))) {
        return fail(app, method, 'connected_app_not_found', '父文件夹不存在')
      }
      const content = text(payload.content)
      if (byteLen(content) > 1024 * 1024) {
        return fail(app, method, 'connected_app_too_large', '写入内容超过 1MB 上限')
      }
      tree(app).set(path, content)
      return ok(app, method, {
        root: root.id,
        path,
        bytes: byteLen(content),
        overwritten: exists,
      })
    }

    case 'create_desktop_folder': {
      const path = safeRel(text(payload.path))
      if (path === null || !path) return badPath(app, method)
      let created = false
      let current = ''
      for (const seg of path.split('/')) {
        current = current ? `${current}/${seg}` : seg
        if (tree(app).has(current)) {
          return fail(app, method, 'connected_app_exists', '同名文件已存在，无法创建文件夹')
        }
        if (dirs(app).has(current) || isDir(app, current)) continue
        dirs(app).add(current)
        created = true
      }
      return ok(app, method, { root: root.id, path, created })
    }

    case 'delete_desktop_file': {
      const path = safeRel(text(payload.path))
      if (path === null || !path) return badPath(app, method)
      if (tree(app).has(path)) {
        tree(app).delete(path)
        return ok(app, method, { root: root.id, path, deleted: true, type: 'file' })
      }
      if (isDir(app, path)) {
        if (hasChildren(app, path)) {
          return fail(app, method, 'connected_app_not_empty', '文件夹非空；请先清空后再删除')
        }
        dirs(app).delete(path)
        return ok(app, method, { root: root.id, path, deleted: true, type: 'dir' })
      }
      return fail(app, method, 'connected_app_not_found', '文件或文件夹不存在')
    }

    case 'rename_desktop_file': {
      const from = safeRel(text(payload.from))
      const to = safeRel(text(payload.to))
      if (from === null || to === null || !from || !to) return badPath(app, method)
      if (parentOf(from) !== parentOf(to)) {
        return fail(app, method, 'connected_app_bad_request', '只能在同一个文件夹内重命名')
      }
      if (!tree(app).has(from) && !isDir(app, from)) {
        return fail(app, method, 'connected_app_not_found', '原文件或文件夹不存在')
      }
      if (tree(app).has(to) || isDir(app, to)) {
        return fail(app, method, 'connected_app_exists', '重命名目标已存在')
      }
      if (tree(app).has(from)) {
        const content = tree(app).get(from) as string
        tree(app).delete(from)
        tree(app).set(to, content)
      } else {
        const prefix = `${from}/`
        for (const [path, content] of [...tree(app)]) {
          if (!path.startsWith(prefix)) continue
          tree(app).delete(path)
          tree(app).set(to + path.slice(from.length), content)
        }
        for (const path of [...dirs(app)]) {
          if (path !== from && !path.startsWith(prefix)) continue
          dirs(app).delete(path)
          dirs(app).add(to + path.slice(from.length))
        }
      }
      return ok(app, method, { root: root.id, from, to, renamed: true })
    }

    default:
      return fail(app, method, 'connected_app_unknown_method', `桌面文件样例不支持方法 ${method}`)
  }
}
