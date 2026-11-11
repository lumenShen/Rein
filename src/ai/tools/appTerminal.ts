/**
 * 命令行工具：以 argv 运行本机程序（Windows / Mac 共用 `appTerminal` 组）。
 *
 * 设计边界：
 * - 每次执行先 `askToolConfirm`，展示完整 program / args / cwd / timeout；拒绝则不调用 native。
 * - 不把整段脚本拼成 shell 字符串；参数走 `args` 数组。
 * - `powershell`/`pwsh`/`bash`/`sh` 只允许 `-File` 脚本模式；`-Command`/`-c` 在本地先拒绝。
 * - 结果带 `meta.mock`（浏览器样例数据）并原样透传；错误统一 `[code] message`。
 * - 拒绝/失败会尽力写一条 `__audit`；成功执行的详细审计由 Rust `term_ops` 落盘。
 */
import { Type } from '@earendil-works/pi-ai'

import { connectedAppService } from '@/services/connectedAppService'
import { useConnectedAppsStore } from '@/stores/connectedApps'
import { askToolConfirm } from '@/system/toolConfirm'
import type { ConnectedAppId, ConnectedAppInvokeMeta } from '@/types'
import { currentPlatform } from '@/utils/platform'

import { defineTool, type AppTool } from './types'

const MAX_PROGRAM_CHARS = 128
const MAX_ARGS = 64
const MAX_ARG_CHARS = 4096
const MAX_ARGS_TOTAL_CHARS = 16_384
const MAX_CWD_CHARS = 512
const DEFAULT_TIMEOUT_MS = 30_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 90_000

/** 始终拒绝的脚本宿主/提权程序（大小写不敏感，含 `.exe`）。 */
const DENIED_PROGRAMS = new Set([
  'cmd',
  'wscript',
  'cscript',
  'mshta',
  'sudo',
  'su',
  'doas',
  'runas',
  'gsudo',
  'pkexec',
  // 不在允许脚本模式里的其它 shell：作为普通程序会把 -c 重新变成 shell 入口。
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'ash',
  'busybox',
  // argv 包装器：`env sudo ...` / `env sh -c ...` 会绕过提权与 -c 检查。
  'env',
])

const POWERSHELL_PROGRAMS = new Set(['powershell', 'pwsh'])
const POSIX_SHELL_PROGRAMS = new Set(['bash', 'sh'])

const FORBIDDEN_EXTENSIONS = [
  '.bat',
  '.cmd',
  '.ps1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.hta',
  '.msi',
  '.scr',
]

const SHELL_META = '*?[]&|;<>(){}"\'`$^'

const SECRET_KEYS = [
  'api_key',
  'apikey',
  'api-key',
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'bearer',
]

type TerminalAppId = Extract<ConnectedAppId, 'win-terminal' | 'mac-terminal'>

interface TerminalData {
  program: string
  args: string[]
  cwd: string
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  durationMs: number
  timedOut: boolean
}

interface TerminalCallResult {
  data: TerminalData
  meta?: ConnectedAppInvokeMeta
}

function badRequest(message: string): Error {
  return new Error(`[connected_app_bad_request] ${message}`)
}

function permissionDenied(message: string): Error {
  return new Error(`[connected_app_permission_denied] ${message}`)
}

function normalizeProgram(program: string): string {
  const lower = program.toLowerCase()
  return lower.endsWith('.exe') ? lower.slice(0, -4) : lower
}

/** 本地快速校验：与 Rust `term_ops::validate_program_name` 保持同一口径。 */
function validateProgram(program: string): string {
  const chars = [...program].length
  if (chars === 0 || chars > MAX_PROGRAM_CHARS) {
    throw badRequest(`program 长度必须在 1..=${MAX_PROGRAM_CHARS} 之间`)
  }
  if (/\s/.test(program) || [...program].some((char) => char.charCodeAt(0) < 0x20)) {
    throw badRequest('program 不能包含空白或控制字符')
  }
  if (/[\\/:]/.test(program)) {
    throw permissionDenied('program 只允许裸可执行名；不接受路径、盘符或 UNC')
  }
  if (program.includes('=')) {
    throw badRequest('program 不能包含 =')
  }
  if ([...program].some((char) => SHELL_META.includes(char))) {
    throw permissionDenied('program 包含 shell 元字符')
  }
  if (program === '.' || program === '..' || program.startsWith('-')) {
    throw permissionDenied('program 非法')
  }
  const normalized = normalizeProgram(program)
  if (DENIED_PROGRAMS.has(normalized)) {
    throw permissionDenied(`不允许执行提权/脚本宿主程序：${program}`)
  }
  if (FORBIDDEN_EXTENSIONS.some((extension) => program.toLowerCase().endsWith(extension))) {
    throw permissionDenied(`脚本/安装包必须用显式脚本模式执行，不能作为普通程序：${program}`)
  }
  return normalized
}

function validateArgs(args: string[]): void {
  if (args.length > MAX_ARGS) {
    throw badRequest(`args 不能超过 ${MAX_ARGS} 个`)
  }
  let total = 0
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw badRequest('args 必须是字符串数组')
    }
    if (arg.includes('\0')) {
      throw badRequest('args 不能包含 NUL')
    }
    if (arg.length > MAX_ARG_CHARS) {
      throw badRequest(`单个参数不能超过 ${MAX_ARG_CHARS} 字符`)
    }
    total += arg.length
  }
  if (total > MAX_ARGS_TOTAL_CHARS) {
    throw badRequest(`args 总长度不能超过 ${MAX_ARGS_TOTAL_CHARS} 字符`)
  }
}

/** shell 只允许脚本模式；`-Command` / `-c` 在确认前就拒绝。 */
function validateShellArgs(normalized: string, args: string[]): void {
  if (POWERSHELL_PROGRAMS.has(normalized)) {
    const lower = args.map((arg) => arg.toLowerCase().replace(/^\//, '-'))
    const fileIndex = lower.indexOf('-file')
    if (fileIndex < 0) {
      throw permissionDenied(
        'powershell/pwsh 只允许 -File <允许目录内的脚本>；不支持 -Command/-EncodedCommand',
      )
    }
    const beforeFile = lower.slice(0, fileIndex)
    if (
      beforeFile.some((arg) =>
        ['-command', '-c', '-encodedcommand', '-ec', '-e', '-encodedarguments'].includes(arg),
      )
    ) {
      throw permissionDenied('powershell/pwsh 只允许 -File 脚本模式')
    }
    if (!args[fileIndex + 1]) {
      throw badRequest('-File 缺少脚本路径')
    }
    return
  }
  if (POSIX_SHELL_PROGRAMS.has(normalized)) {
    if (args.some((arg) => arg === '--command' || /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))) {
      throw permissionDenied('bash/sh 只允许执行脚本文件；不支持 -c')
    }
    const scriptIndex = args.findIndex((arg) => arg !== '--' && !arg.startsWith('-'))
    if (scriptIndex < 0) {
      throw permissionDenied('bash/sh 只允许执行允许目录内的脚本文件；不支持交互式 shell')
    }
    const flags = args.slice(0, scriptIndex)
    if (flags.some((arg) => arg !== '--' && !/^-[euxE]+$/.test(arg))) {
      throw permissionDenied('bash/sh 只允许 -e/-u/-x/-E 与脚本路径')
    }
  }
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw badRequest(`timeoutMs 必须是 ${MIN_TIMEOUT_MS}..=${MAX_TIMEOUT_MS} 之间的整数`)
  }
}

function isSensitiveFlag(arg: string): boolean {
  const key = arg
    .replace(/^[-/]+/, '')
    .split(/[=:]/)[0]
    ?.toLowerCase()
  return key !== undefined && SECRET_KEYS.includes(key)
}

function maskValue(arg: string): string {
  const equals = arg.indexOf('=')
  if (equals >= 0) return `${arg.slice(0, equals)}=***`
  const colon = arg.indexOf(':')
  if (colon >= 0) return `${arg.slice(0, colon)}:***`
  return '***'
}

/** 审计脱敏：敏感键的下一个参数、`KEY=value`、`Authorization: Bearer x`。 */
function redactArgs(args: string[]): string[] {
  let maskNext = false
  return args.map((arg) => {
    const lower = arg.toLowerCase()
    const sensitive = SECRET_KEYS.some((key) => lower.includes(key))
    const rendered = maskNext ? '***' : sensitive ? maskValue(arg) : arg
    maskNext = isSensitiveFlag(arg)
    return rendered
  })
}

function auditSummary(
  program: string,
  args: string[],
  cwd: string,
  exitCode: number | null,
  timedOut: boolean,
): string {
  const exit = timedOut ? 'timeout' : exitCode === null ? 'signal' : String(exitCode)
  return `program=${program} args=[${redactArgs(args).join(' ')}] cwd=${cwd} exit=${exit}`
}

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function confirmBody(
  program: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): string {
  return [
    `程序：${program}`,
    `参数：${args.length > 0 ? args.map(quoteArg).join(' ') : '（无）'}`,
    `工作目录：${cwd}`,
    `超时：${Math.round(timeoutMs / 1000)} 秒`,
    '命令以你的用户身份运行，可访问你有权限的任何文件；Rein 不提供沙箱隔离。请确认命令来源可信。',
  ].join('\n')
}

/** 按当前平台 / 已连接+AI 选终端 app；缺失时抛 `connected_app_not_connected`。 */
async function resolveTerminalApp(): Promise<{ id: TerminalAppId; label: string }> {
  const store = useConnectedAppsStore()
  await store.ensureLoaded()

  const platform = currentPlatform()
  const candidates: TerminalAppId[] =
    platform === 'windows'
      ? ['win-terminal']
      : platform === 'mac'
        ? ['mac-terminal']
        : platform === 'browser'
          ? ['win-terminal', 'mac-terminal']
          : []

  const enabled = new Set(store.aiEnabledAppIds())
  const id = candidates.find((candidate) => enabled.has(candidate))
  if (!id) {
    throw new Error(
      '[connected_app_not_connected] 没有已连接并允许 AI 使用的命令行应用；请让用户打开「连接应用」连接 Windows 命令行 / Mac 命令行',
    )
  }

  const status = store.statusFor(id)
  if (!status?.writeAllowed) {
    throw new Error(
      '[connected_app_write_not_allowed] 还没有允许执行命令；请让用户在连接应用里打开「允许写入」',
    )
  }

  return { id, label: id === 'win-terminal' ? 'Windows 命令行' : 'Mac 命令行' }
}

/** 尽力写审计；失败不阻断（与 Rust 审计同策略）。 */
async function writeAudit(
  appId: TerminalAppId,
  decision: 'allowed' | 'denied' | 'error',
  summary: string,
): Promise<void> {
  try {
    await connectedAppService.call(appId, '__audit', {
      method: 'run_terminal_command',
      decision,
      summary: summary.slice(0, 300),
    })
  } catch {
    /* 审计失败不影响执行结果 */
  }
}

async function callTerminal(
  appId: TerminalAppId,
  payload: { program: string; args: string[]; cwd: string; timeoutMs: number },
): Promise<TerminalCallResult> {
  const reply = await connectedAppService.call<TerminalData>(appId, 'run_terminal_command', payload)
  if (!reply.ok) {
    const code = reply.error?.code ?? 'connected_app_native_error'
    const message = reply.error?.message ?? '命令行执行失败'
    throw new Error(`[${code}] ${message}`)
  }
  if (!reply.data) {
    throw new Error('[connected_app_native_error] 命令行返回缺少结果')
  }
  return { data: reply.data, meta: reply.meta }
}

export const tools: AppTool[] = [
  defineTool({
    name: 'run_terminal_command',
    group: 'appTerminal',
    label: '运行命令',
    description:
      '以 argv 运行本机程序（不经过 shell 拼接）。每次执行都会弹确认并显示完整 program/args/cwd。' +
      'cwd 缺省 sandbox（临时目录），也可用 desktop/documents/downloads 别名或允许根内的绝对路径。' +
      'timeoutMs 默认 30000、上限 90000；stdout/stderr 各最多 64KB。' +
      'powershell/pwsh/bash/sh 只允许 -File 执行允许目录内的脚本，禁止 -Command/-c。',
    dangerous: true,
    parameters: Type.Object({
      program: Type.String({
        description: '裸可执行名（不含路径、盘符、空白与 shell 元字符），如 git、node、hostname',
        minLength: 1,
        maxLength: MAX_PROGRAM_CHARS,
      }),
      args: Type.Optional(
        Type.Array(Type.String({ maxLength: MAX_ARG_CHARS }), {
          maxItems: MAX_ARGS,
          description: 'argv 数组；原样传给程序，不做 shell 解析',
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          maxLength: MAX_CWD_CHARS,
          description: 'sandbox/desktop/documents/downloads 别名（可带子路径）或允许根内的绝对路径；缺省 sandbox',
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: MIN_TIMEOUT_MS,
          maximum: MAX_TIMEOUT_MS,
          description: '超时毫秒数；默认 30000，上限 90000',
        }),
      ),
    }),
    async execute(args) {
      const program = args.program
      const argList = Array.isArray(args.args) ? args.args : []
      const normalized = validateProgram(program)
      validateArgs(argList)
      validateShellArgs(normalized, argList)

      const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS
      validateTimeout(timeoutMs)

      const cwd = args.cwd && args.cwd.length > 0 ? args.cwd : 'sandbox'
      if (cwd.length > MAX_CWD_CHARS) {
        throw badRequest(`cwd 不能超过 ${MAX_CWD_CHARS} 字符`)
      }

      const app = await resolveTerminalApp()
      const allowed = await askToolConfirm({
        title: `运行命令 · ${app.label}`,
        body: confirmBody(program, argList, cwd, timeoutMs),
        danger: true,
      })
      if (!allowed) {
        await writeAudit(app.id, 'denied', auditSummary(program, argList, cwd, null, false))
        throw new Error('[connected_app_user_denied] 用户拒绝执行该命令')
      }

      const result = await callTerminal(app.id, {
        program,
        args: argList,
        cwd,
        timeoutMs,
      }).catch(async (error: unknown) => {
        await writeAudit(app.id, 'error', auditSummary(program, argList, cwd, null, false))
        throw error
      })

      const data = result.data
      if (data.timedOut) {
        await writeAudit(app.id, 'error', auditSummary(program, argList, cwd, null, true))
        const tail = `${data.stdout}${data.stderr}`.slice(-1000)
        throw new Error(
          `[connected_app_timeout] 命令超时（${Math.round(timeoutMs / 1000)} 秒），已终止进程树${
            tail ? `；已捕获输出：\n${tail}` : ''
          }`,
        )
      }

      return { ...data, meta: result.meta }
    },
  }),
]

export const appTerminalTools = tools
