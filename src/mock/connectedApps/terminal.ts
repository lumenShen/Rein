/**
 * 命令行 · mock。
 *
 * 只返回固定的安全样例（echo / pwd / hostname / whoami / ls），其余程序与所有
 * 脚本解释器明确返回 `connected_app_mock_unavailable`；绝不冒充本机执行成功。
 */
import { fail, num, ok, text, type MockAppHandler, type MockPayload } from './shared'

const MAX_TIMEOUT_MS = 90_000
const MAX_ARGS = 64
const MAX_ARG_CHARS = 4_096
const MAX_ARGS_TOTAL_CHARS = 16_384

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
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'ash',
  'busybox',
])

const SHELL_PROGRAMS = new Set(['powershell', 'pwsh', 'bash', 'sh'])

function normalizeProgram(program: string): string {
  const lower = program.toLowerCase()
  return lower.endsWith('.exe') ? lower.slice(0, -4) : lower
}

function sample(
  app: string,
  method: string,
  program: string,
  args: string[],
  cwd: string,
  stdout: string,
) {
  return ok(app, method, {
    program,
    args,
    cwd,
    exitCode: 0,
    stdout,
    stderr: '',
    truncated: false,
    durationMs: 12,
    timedOut: false,
    simulated: true,
  })
}

export const terminalMock: MockAppHandler = (app, method, payload: MockPayload) => {
  if (method !== 'run_terminal_command') return ok(app, method, {})

  const program = text(payload.program)
  const args = Array.isArray(payload.args)
    ? payload.args.filter((value): value is string => typeof value === 'string')
    : []
  const cwd = text(payload.cwd) || 'sandbox'
  const timeoutMs = num(payload.timeoutMs, 30_000)

  if (!program) {
    return fail(app, method, 'connected_app_bad_request', '缺少 program')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    return fail(
      app,
      method,
      'connected_app_bad_request',
      `timeoutMs 必须是 1..=${MAX_TIMEOUT_MS} 之间的整数`,
    )
  }
  if (args.length > MAX_ARGS) {
    return fail(app, method, 'connected_app_bad_request', `args 不能超过 ${MAX_ARGS} 个`)
  }
  const total = args.reduce((sum, arg) => sum + arg.length, 0)
  if (args.some((arg) => arg.length > MAX_ARG_CHARS) || total > MAX_ARGS_TOTAL_CHARS) {
    return fail(app, method, 'connected_app_bad_request', 'args 超过长度上限')
  }
  if (/[\\/:]/.test(program)) {
    return fail(
      app,
      method,
      'connected_app_path_denied',
      'program 只允许裸可执行名；不接受路径、盘符或 UNC',
    )
  }

  const normalized = normalizeProgram(program)
  if (DENIED_PROGRAMS.has(normalized)) {
    return fail(
      app,
      method,
      'connected_app_permission_denied',
      `不允许执行提权/脚本宿主程序：${program}`,
    )
  }
  if (SHELL_PROGRAMS.has(normalized)) {
    return fail(
      app,
      method,
      'connected_app_mock_unavailable',
      '浏览器 mock 不执行脚本；真实脚本需要在桌面端运行。',
    )
  }
  if (normalized === 'echo') {
    return sample(app, method, program, args, cwd, `${args.join(' ')}\n`)
  }
  if (normalized === 'pwd') {
    return sample(app, method, program, args, cwd, `/mock/${cwd}\n`)
  }
  if (normalized === 'hostname') {
    return sample(app, method, program, args, cwd, 'mock-host\n')
  }
  if (normalized === 'whoami') {
    return sample(app, method, program, args, cwd, 'mock-user\n')
  }
  if (normalized === 'ls' || normalized === 'dir') {
    return sample(app, method, program, args, cwd, 'notes.md\ntodo.txt\n')
  }

  return fail(
    app,
    method,
    'connected_app_mock_unavailable',
    '浏览器 mock 只模拟 echo / pwd / hostname / whoami / ls；真实命令需要在桌面端运行。',
  )
}
