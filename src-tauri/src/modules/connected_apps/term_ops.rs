//! 命令行执行能力：argv、环境白名单、超时、进程树、输出上限、审计。
//!
//! 安全口径（plan §6.2 + 本次任务硬约束）：
//! - `program` 只接受裸可执行名（1..128，不含 `/` `\` `:`、空白、NUL、shell 元字符）；
//!   拒绝 `cmd` / `wscript` / `cscript` / `mshta` 与提权程序
//!   `sudo` / `su` / `doas` / `runas` / `gsudo` / `pkexec`（大小写不敏感，含 `.exe`）。
//! - `powershell(.exe)` / `pwsh(.exe)` / `bash` / `sh` 只允许 **脚本模式**：
//!   `-File <允许根内脚本>`（PowerShell）或 `[flags] <允许根内脚本>`（sh/bash）；
//!   `-Command` / `-c` / `-EncodedCommand` 一律拒绝。整段脚本不会被拼成 shell 字符串。
//! - `args` 原样传给进程 argv，Rein 不做任何 shell 解析/拼接。
//! - 普通程序在 Windows 上通过一个**固定的 PowerShell 启动器脚本**执行：程序与参数
//!   以独立 argv 传给启动器，再用 PowerShell 的调用运算符把字符串数组原样展开；
//!   不把用户输入拼成命令文本。Unix 用 `/usr/bin/env` 做同样的 argv 传递。
//! - `cwd`：缺省 `temp_dir()/rein-terminal`；支持 `sandbox|desktop|documents|downloads`
//!   别名（可带子路径）或绝对路径；canonicalize 后必须在主目录或允许根内。
//! - 环境：`env_clear()` + 白名单；绝不继承 `*_API_KEY` / `TOKEN` / `SECRET` / `REIN_*`。
//! - Windows `CREATE_NO_WINDOW`；Unix `process_group(0)`；超时杀进程树。
//! - stdout/stderr 各 ≤64KB，超出继续排空但不保留，结果带「输出已截断」标记。
//! - 每次真正执行（含启动失败/超时）追加一行 `connected_apps/audit.jsonl`；
//!   参数按键名脱敏，summary ≤300 字符，单文件 1MB 轮转。

#![allow(dead_code)]

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{ReinError, Result};

use super::paths::{root_contains, validate_relative};

/* ---------------- 上限（plan §6.5） ---------------- */

pub(crate) const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// 本次任务硬约束：timeout_ms ≤ 90000（plan §6.2 写 120s，按任务书收紧）。
pub(crate) const MAX_TIMEOUT_MS: u64 = 90_000;
/// 工具 schema 的下限是 1000ms；内部允许更小值，便于单测覆盖超时分支。
pub(crate) const MIN_TIMEOUT_MS: u64 = 100;
pub(crate) const MAX_PROGRAM_CHARS: usize = 128;
pub(crate) const MAX_ARGS: usize = 64;
pub(crate) const MAX_ARG_BYTES: usize = 4096;
pub(crate) const MAX_ARGS_TOTAL_BYTES: usize = 16_384;
pub(crate) const MAX_CWD_BYTES: usize = 512;
pub(crate) const MAX_OUTPUT_BYTES: usize = 65_536;

const MAX_AUDIT_BYTES: u64 = 1024 * 1024;
const AUDIT_BACKUP: &str = "audit.1.jsonl";
const TRUNCATED_MARK: &str = "…[输出已截断]";

/* ---------------- 请求 ---------------- */

#[derive(Debug, Clone, Default)]
pub struct TerminalRequest {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub timeout_ms: Option<u64>,
    /// 单测/内部用；工具层不暴露，上限 64KB。
    pub max_output_bytes: Option<usize>,
}

impl TerminalRequest {
    /// 解析 `connected_app_invoke` 的 payload；类型错误统一 `connected_app_bad_request`。
    pub(crate) fn parse(payload: &Value) -> Result<Self> {
        let obj = payload
            .as_object()
            .ok_or_else(|| bad_request("payload 必须是对象"))?;

        let program = match obj.get("program") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => return Err(bad_request("缺少 program")),
            Some(_) => return Err(bad_request("program 必须是字符串")),
        };

        let args = match obj.get("args") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    match item {
                        Value::String(s) => out.push(s.clone()),
                        _ => return Err(bad_request("args 必须是字符串数组")),
                    }
                }
                out
            }
            Some(_) => return Err(bad_request("args 必须是字符串数组")),
        };

        let cwd = match obj.get("cwd") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => return Err(bad_request("cwd 必须是字符串")),
        };

        let timeout_ms = match obj.get("timeoutMs") {
            None | Some(Value::Null) => None,
            Some(v) => Some(
                v.as_u64()
                    .ok_or_else(|| bad_request("timeoutMs 必须是非负整数"))?,
            ),
        };

        let max_output_bytes = match obj.get("maxOutputBytes") {
            None | Some(Value::Null) => None,
            Some(v) => {
                let n = v
                    .as_u64()
                    .ok_or_else(|| bad_request("maxOutputBytes 必须是非负整数"))?;
                Some(n.min(usize::MAX as u64) as usize)
            }
        };

        Ok(Self {
            program,
            args,
            cwd,
            timeout_ms,
            max_output_bytes,
        })
    }
}

/// 由 `apps/terminal.rs` 组装的执行上下文。
#[derive(Debug, Clone, Default)]
pub struct TerminalOptions {
    /// 审计 `app` 字段（`win-terminal` / `mac-terminal`）。
    pub app_id: String,
    /// 额外允许根（win-local 授权目录等）；当前 handler 无 AppHandle，先留空。
    pub extra_roots: Vec<PathBuf>,
    /// `None` = 不写审计（单测/未定位数据目录）。
    pub audit_path: Option<PathBuf>,
}

/* ---------------- 结果 ---------------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutcome {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub duration_ms: u64,
    pub timed_out: bool,
    /// 审计行是否成功落盘（不改变执行结果）。
    #[serde(skip)]
    pub audited: bool,
}

impl TerminalOutcome {
    pub(crate) fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| json!({}))
    }
}

/// 校验后确定的启动方式。每个分支在 `build_launch_plan` 里都对应
/// `Command::new(<字面量>)`：程序名永远不会作为 `Command` 的构造参数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LaunchProgram {
    Powershell,
    Pwsh,
    Bash,
    Sh,
    /// Windows 普通程序：固定 PowerShell 启动器 + 已解析的绝对程序路径。
    WindowsLauncherPowershell,
    /// Windows 普通程序：固定 pwsh 启动器（没有 Windows PowerShell 时）。
    WindowsLauncherPwsh,
    /// Unix 普通程序：`/usr/bin/env <已解析路径> <args...>`。
    UnixEnv,
}

#[derive(Debug)]
struct ResolvedInvocation {
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    timeout_ms: u64,
    max_output_bytes: usize,
    /// 普通程序的绝对路径（脚本模式为 None）。
    executable: Option<PathBuf>,
    launch: LaunchProgram,
}

struct LaunchPlan {
    command: Command,
    /// Windows 启动器脚本是每次执行新建的临时文件，执行后删除。
    cleanup: Option<PathBuf>,
}

/* ---------------- 入口 ---------------- */

/// 执行一条 argv 命令。所有校验失败都返回带判据的 `ReinError`。
pub(crate) fn run(req: &TerminalRequest, opts: &TerminalOptions) -> Result<TerminalOutcome> {
    let invocation = validate(req, opts)?;
    execute(invocation, opts)
}

/// 断开终端时杀掉所有运行中的进程树。
///
/// `connected_app_update(enabled=false)` 会调用本函数（commands.rs）；这里保留
/// 幂等入口，重复调用只清空运行表。
pub(crate) fn kill_all() {
    let pids: Vec<u32> = ACTIVE_PIDS
        .lock()
        .map(|guard| guard.iter().copied().collect())
        .unwrap_or_default();
    for pid in pids {
        let _ = kill_pid_tree(pid);
    }
    if let Ok(mut guard) = ACTIVE_PIDS.lock() {
        guard.clear();
    }
}

/// Windows / Mac 是否具备可用的 shell（状态页的 `writable` 判据之一）。
pub(crate) fn shell_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        powershell_available() || find_program("pwsh").is_some()
    }
    #[cfg(unix)]
    {
        find_program("bash").is_some() || find_program("sh").is_some()
    }
    #[cfg(not(any(target_os = "windows", unix)))]
    {
        false
    }
}

/* ---------------- 校验 ---------------- */

fn validate(req: &TerminalRequest, opts: &TerminalOptions) -> Result<ResolvedInvocation> {
    validate_program_name(&req.program)?;
    validate_args(&req.args)?;

    let timeout_ms = req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    if timeout_ms < MIN_TIMEOUT_MS || timeout_ms > MAX_TIMEOUT_MS {
        return Err(bad_request(format!(
            "timeoutMs 必须在 {MIN_TIMEOUT_MS}..={MAX_TIMEOUT_MS} 之间"
        )));
    }

    let max_output_bytes = req.max_output_bytes.unwrap_or(MAX_OUTPUT_BYTES);
    if max_output_bytes > MAX_OUTPUT_BYTES {
        return Err(bad_request("maxOutputBytes 不能超过 65536"));
    }

    let roots = allowed_roots(&opts.extra_roots);
    let cwd = resolve_cwd(req.cwd.as_deref(), &roots)?;
    let (launch, executable) = validate_program_args(&req.program, &req.args, &cwd, &roots)?;

    Ok(ResolvedInvocation {
        program: req.program.clone(),
        args: req.args.clone(),
        cwd,
        timeout_ms,
        max_output_bytes,
        executable,
        launch,
    })
}

fn validate_program_name(program: &str) -> Result<()> {
    let chars = program.chars().count();
    if chars == 0 || chars > MAX_PROGRAM_CHARS {
        return Err(bad_request(format!(
            "program 长度必须在 1..={MAX_PROGRAM_CHARS} 之间"
        )));
    }
    if program
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || c == '\0')
    {
        return Err(bad_request("program 不能包含空白或控制字符"));
    }
    if program.contains('/') || program.contains('\\') || program.contains(':') {
        return Err(path_denied(
            "program 只允许裸可执行名；不接受路径、盘符或 UNC",
        ));
    }
    if program.contains('=') {
        return Err(bad_request("program 不能包含 ="));
    }
    if program.chars().any(|c| {
        matches!(
            c,
            '*' | '?'
                | '['
                | ']'
                | '&'
                | '|'
                | ';'
                | '<'
                | '>'
                | '('
                | ')'
                | '{'
                | '}'
                | '"'
                | '\''
                | '`'
                | '$'
                | '^'
        )
    }) {
        return Err(path_denied("program 包含 shell 元字符"));
    }
    if program == "." || program == ".." || program.starts_with('-') {
        return Err(path_denied("program 非法"));
    }
    Ok(())
}

fn validate_args(args: &[String]) -> Result<()> {
    if args.len() > MAX_ARGS {
        return Err(bad_request(format!("args 不能超过 {MAX_ARGS} 个")));
    }
    let mut total = 0usize;
    for arg in args {
        if arg.contains('\0') {
            return Err(bad_request("args 不能包含 NUL"));
        }
        if arg.len() > MAX_ARG_BYTES {
            return Err(bad_request(format!(
                "单个参数不能超过 {MAX_ARG_BYTES} 字节"
            )));
        }
        total = total.saturating_add(arg.len());
    }
    if total > MAX_ARGS_TOTAL_BYTES {
        return Err(bad_request(format!(
            "args 总长度不能超过 {MAX_ARGS_TOTAL_BYTES} 字节"
        )));
    }
    Ok(())
}

fn normalize_program(program: &str) -> String {
    let lower = program.to_ascii_lowercase();
    lower
        .strip_suffix(".exe")
        .unwrap_or(lower.as_str())
        .to_string()
}

const DENIED_PROGRAMS: &[&str] = &[
    // 无法安全 argv 化的脚本宿主 / shell 字符串入口
    "cmd", "wscript", "cscript", "mshta", // 提权
    "sudo", "su", "doas", "runas", "gsudo", "pkexec",
    // 不在允许脚本模式里的其它 shell：作为普通程序会把 -c 重新变成 shell 入口。
    "zsh", "fish", "csh", "tcsh", "ksh", "dash", "ash", "busybox",
    // argv 包装器：`env sudo ...` / `env sh -c ...` 会绕过上面的提权与 -c 检查。
    "env",
];

const POWERSHELL_PROGRAMS: &[&str] = &["powershell", "pwsh"];
const POSIX_SHELL_PROGRAMS: &[&str] = &["bash", "sh"];

/// 这些扩展名会落到 shell / 脚本宿主解释器，必须走显式脚本模式，不能当普通程序。
fn is_forbidden_extension(program: &str) -> bool {
    let lower = program.to_ascii_lowercase();
    [
        ".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta", ".msi",
        ".scr",
    ]
    .iter()
    .any(|extension| lower.ends_with(extension))
}

fn validate_program_args(
    program: &str,
    args: &[String],
    cwd: &Path,
    roots: &[PathBuf],
) -> Result<(LaunchProgram, Option<PathBuf>)> {
    let normalized = normalize_program(program);
    if DENIED_PROGRAMS.contains(&normalized.as_str()) {
        return Err(permission_denied(format!(
            "不允许执行提权/脚本宿主程序：{program}"
        )));
    }
    if POWERSHELL_PROGRAMS.contains(&normalized.as_str()) {
        validate_powershell_script(args, cwd, roots)?;
        let launch = if normalized == "pwsh" {
            if find_program("pwsh").is_none() {
                return Err(unavailable("找不到 pwsh"));
            }
            LaunchProgram::Pwsh
        } else {
            if !powershell_available() {
                return Err(unavailable("找不到 powershell"));
            }
            LaunchProgram::Powershell
        };
        return Ok((launch, None));
    }
    if POSIX_SHELL_PROGRAMS.contains(&normalized.as_str()) {
        validate_shell_script(args, cwd, roots)?;
        let launch = if find_program("bash").is_some() {
            LaunchProgram::Bash
        } else if find_program("sh").is_some() {
            LaunchProgram::Sh
        } else {
            return Err(unavailable("找不到 bash/sh"));
        };
        return Ok((launch, None));
    }
    if is_forbidden_extension(program) {
        return Err(permission_denied(format!(
            "脚本/安装包必须用显式脚本模式执行，不能作为普通程序：{program}"
        )));
    }

    let executable =
        find_program(program).ok_or_else(|| bad_request(format!("找不到可执行程序：{program}")))?;

    #[cfg(target_os = "windows")]
    let launch = if powershell_available() {
        LaunchProgram::WindowsLauncherPowershell
    } else if find_program("pwsh").is_some() {
        LaunchProgram::WindowsLauncherPwsh
    } else {
        return Err(unavailable("找不到 powershell/pwsh，无法启动命令"));
    };

    #[cfg(unix)]
    let launch = {
        if !unix_env_available() {
            return Err(unavailable("找不到 env，无法启动命令"));
        }
        LaunchProgram::UnixEnv
    };

    #[cfg(not(any(target_os = "windows", unix)))]
    let launch = return Err(unavailable("当前平台不支持命令行"));

    Ok((launch, Some(executable)))
}

/// PowerShell：`[-NoProfile] [-NonInteractive] [-ExecutionPolicy X] -File <script> [script args...]`
fn validate_powershell_script(args: &[String], cwd: &Path, roots: &[PathBuf]) -> Result<()> {
    let mut file_pos = None;
    let mut i = 0usize;
    while i < args.len() {
        let arg = &args[i];
        let normalized = arg.to_ascii_lowercase().replace('/', "-");
        if normalized == "-file" {
            file_pos = Some(i);
            break;
        }
        match normalized.as_str() {
            "-noprofile" | "-nologo" | "-noninteractive" => i += 1,
            "-executionpolicy" => {
                let policy = args
                    .get(i + 1)
                    .ok_or_else(|| bad_request("-ExecutionPolicy 缺少参数"))?;
                validate_execution_policy(policy)?;
                i += 2;
            }
            _ if normalized.starts_with("-executionpolicy:") => {
                let policy = arg
                    .split_once(':')
                    .map(|(_, value)| value)
                    .ok_or_else(|| bad_request("-ExecutionPolicy 缺少参数"))?;
                validate_execution_policy(policy)?;
                i += 1;
            }
            _ => {
                return Err(permission_denied(format!(
                    "powershell/pwsh 只允许 -File <允许目录内的脚本>；不接受参数 {arg}"
                )));
            }
        }
    }

    let pos = file_pos.ok_or_else(|| {
        permission_denied(
            "powershell/pwsh 只允许 -File <允许目录内的脚本>；不接受 -Command/-EncodedCommand",
        )
    })?;
    let script = args
        .get(pos + 1)
        .ok_or_else(|| bad_request("-File 缺少脚本路径"))?;
    resolve_script(script, cwd, roots)?;
    // pos + 2.. 是传给脚本的参数，原样传递。
    Ok(())
}

fn validate_execution_policy(policy: &str) -> Result<()> {
    let p = policy.trim().to_ascii_lowercase();
    if matches!(
        p.as_str(),
        "bypass" | "remotesigned" | "allsigned" | "restricted" | "unrestricted" | "default"
    ) {
        Ok(())
    } else {
        Err(bad_request(format!("未知的 ExecutionPolicy：{policy}")))
    }
}

/// sh/bash：`[-euxE...] [--] <script> [script args...]`；拒绝 `-c`。
fn validate_shell_script(args: &[String], cwd: &Path, roots: &[PathBuf]) -> Result<()> {
    let mut i = 0usize;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--" {
            i += 1;
            break;
        }
        if arg.starts_with('-') {
            let flags = &arg[1..];
            if flags.is_empty() || !flags.chars().all(|c| matches!(c, 'e' | 'u' | 'x' | 'E')) {
                return Err(permission_denied(format!(
                    "shell 只允许执行允许目录内的脚本文件；不接受参数 {arg}"
                )));
            }
            i += 1;
            continue;
        }
        break;
    }

    let script = args
        .get(i)
        .ok_or_else(|| permission_denied("shell 只允许执行允许目录内的脚本文件；不接受 -c"))?;
    resolve_script(script, cwd, roots)?;
    // 脚本后的参数原样传给脚本。
    Ok(())
}

fn resolve_script(raw: &str, cwd: &Path, roots: &[PathBuf]) -> Result<PathBuf> {
    if raw.is_empty() || raw.len() > MAX_CWD_BYTES {
        return Err(bad_request("脚本路径为空或过长"));
    }
    if raw.contains('\0') {
        return Err(bad_request("脚本路径包含 NUL"));
    }
    let path = Path::new(raw);
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    let canonical =
        std::fs::canonicalize(&candidate).map_err(|_| bad_request(format!("脚本不存在：{raw}")))?;
    let meta = std::fs::metadata(&canonical).map_err(|_| bad_request("脚本不可读取"))?;
    if !meta.is_file() {
        return Err(bad_request("脚本路径不是文件"));
    }
    if !roots.iter().any(|root| root_contains(root, &canonical)) {
        return Err(path_denied("脚本路径不在允许的目录内"));
    }
    Ok(canonical)
}

/* ---------------- cwd ---------------- */

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(|| {
                let drive = std::env::var_os("HOMEDRIVE")?;
                let path = std::env::var_os("HOMEPATH")?;
                let mut joined = PathBuf::from(drive);
                joined.push(path);
                Some(joined)
            })
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn sandbox_dir() -> PathBuf {
    std::env::temp_dir().join("rein-terminal")
}

fn push_canonical(roots: &mut Vec<PathBuf>, path: PathBuf) {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        if canonical.is_dir() {
            roots.push(canonical);
        }
    }
}

/// 允许根：sandbox + 桌面/文稿/下载（含 OneDrive）+ 额外授权根。
/// `cwd` 必须在这些根内；用户主目录本身不在白名单里（plan §6.2 / docs §8.2）。
fn allowed_roots(extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let sandbox = sandbox_dir();
    let _ = std::fs::create_dir_all(&sandbox);
    push_canonical(&mut roots, sandbox);

    if let Some(home) = home_dir() {
        for sub in ["Desktop", "Documents", "Downloads"] {
            push_canonical(&mut roots, home.join(sub));
        }
        if let Some(one_drive) = std::env::var_os("OneDrive") {
            for sub in ["Desktop", "Documents"] {
                push_canonical(&mut roots, PathBuf::from(&one_drive).join(sub));
            }
        }
    }

    for root in extra {
        push_canonical(&mut roots, root.clone());
    }

    roots.sort();
    roots.dedup();
    roots
}

/// 解析别名：返回（根目录, 可选子路径）。
fn resolve_alias(raw: &str) -> Option<(PathBuf, Option<String>)> {
    let normalized = raw.replace('\\', "/");
    let mut parts = normalized.splitn(2, '/');
    let head = parts.next().unwrap_or("");
    let rest = parts.next().map(|segment| segment.to_string());
    let base = match head.to_ascii_lowercase().as_str() {
        "sandbox" => sandbox_dir(),
        "desktop" => home_dir()?.join("Desktop"),
        "documents" => home_dir()?.join("Documents"),
        "downloads" => home_dir()?.join("Downloads"),
        _ => return None,
    };
    Some((base, rest))
}

fn resolve_cwd(raw: Option<&str>, roots: &[PathBuf]) -> Result<PathBuf> {
    if let Some(raw) = raw {
        if raw.len() > MAX_CWD_BYTES {
            return Err(bad_request("cwd 过长"));
        }
    }

    // `from_alias`：sandbox/desktop/documents/downloads 本身就是白名单项，
    // 且相对尾部已过 `validate_relative`；目录可能是这次才创建的，不能再要求它
    // 在 `allowed_roots` 计算时已经存在。
    let (candidate, create, from_alias) = match raw {
        None | Some("") => (sandbox_dir(), true, true),
        Some(raw) => {
            if let Some((base, rest)) = resolve_alias(raw) {
                if let Some(rest) = rest {
                    validate_relative(&rest)?;
                    (base.join(rest), true, true)
                } else {
                    (base, true, true)
                }
            } else if Path::new(raw).is_absolute() {
                (PathBuf::from(raw), false, false)
            } else {
                return Err(path_denied(
                    "cwd 只接受 sandbox/desktop/documents/downloads 别名或允许根内的绝对路径",
                ));
            }
        }
    };

    if create {
        std::fs::create_dir_all(&candidate)
            .map_err(|error| bad_request(format!("cwd 无法创建：{error}")))?;
    }
    let canonical =
        std::fs::canonicalize(&candidate).map_err(|_| bad_request("cwd 不存在或不可访问"))?;
    let meta = std::fs::metadata(&canonical).map_err(|_| bad_request("cwd 不可访问"))?;
    if !meta.is_dir() {
        return Err(bad_request("cwd 不是目录"));
    }
    if !from_alias && !roots.iter().any(|root| root_contains(root, &canonical)) {
        return Err(path_denied(
            "cwd 不在 sandbox/桌面/文稿/下载/已授权根内",
        ));
    }
    Ok(canonical)
}

/* ---------------- 执行 ---------------- */

fn execute(inv: ResolvedInvocation, opts: &TerminalOptions) -> Result<TerminalOutcome> {
    let started = Instant::now();
    let LaunchPlan {
        mut command,
        cleanup,
    } = build_launch_plan(&inv)?;

    command
        .current_dir(command_cwd(&inv.cwd))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    apply_env(&mut command);
    configure_process(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if let Some(path) = cleanup.as_deref() {
                let _ = std::fs::remove_file(path);
            }
            let err = spawn_error(&inv.program, error);
            audit(opts, &inv, None, 0, false, Some(err.code()), "error", false);
            return Err(err);
        }
    };

    let pid = child.id();
    register(pid);

    let stdout_reader = child.stdout.take();
    let stderr_reader = child.stderr.take();
    let cap = inv.max_output_bytes;
    let stdout_thread =
        stdout_reader.map(|reader| std::thread::spawn(move || read_capped(reader, cap)));
    let stderr_thread =
        stderr_reader.map(|reader| std::thread::spawn(move || read_capped(reader, cap)));

    let (timed_out, exit_code) = wait_with_timeout(&mut child, inv.timeout_ms);
    unregister(pid);

    let (stdout_bytes, stdout_truncated) = stdout_thread
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let (stderr_bytes, stderr_truncated) = stderr_thread
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();

    if let Some(path) = cleanup.as_deref() {
        let _ = std::fs::remove_file(path);
    }

    let duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let (stdout, out_cut) = render(stdout_bytes, stdout_truncated);
    let (stderr, err_cut) = render(stderr_bytes, stderr_truncated);
    let truncated = out_cut || err_cut;

    let code = if timed_out {
        Some("connected_app_timeout")
    } else {
        None
    };
    let audited = audit(
        opts,
        &inv,
        exit_code,
        duration_ms,
        timed_out,
        code,
        if timed_out { "error" } else { "allowed" },
        !timed_out,
    );

    Ok(TerminalOutcome {
        program: inv.program,
        args: inv.args,
        cwd: display_path(&inv.cwd),
        exit_code,
        stdout,
        stderr,
        truncated,
        duration_ms,
        timed_out,
        audited,
    })
}

fn build_launch_plan(inv: &ResolvedInvocation) -> Result<LaunchPlan> {
    match inv.launch {
        LaunchProgram::Powershell => {
            let mut command = Command::new("powershell");
            command.args(&inv.args);
            Ok(LaunchPlan {
                command,
                cleanup: None,
            })
        }
        LaunchProgram::Pwsh => {
            let mut command = Command::new("pwsh");
            command.args(&inv.args);
            Ok(LaunchPlan {
                command,
                cleanup: None,
            })
        }
        LaunchProgram::Bash => {
            let mut command = Command::new("bash");
            command.args(&inv.args);
            Ok(LaunchPlan {
                command,
                cleanup: None,
            })
        }
        LaunchProgram::Sh => {
            let mut command = Command::new("sh");
            command.args(&inv.args);
            Ok(LaunchPlan {
                command,
                cleanup: None,
            })
        }
        LaunchProgram::WindowsLauncherPowershell => windows_launcher_plan(inv, false),
        LaunchProgram::WindowsLauncherPwsh => windows_launcher_plan(inv, true),
        LaunchProgram::UnixEnv => {
            let executable = inv
                .executable
                .as_ref()
                .ok_or_else(|| native_error("缺少已解析的程序路径"))?;
            let mut command = if Path::new("/usr/bin/env").is_file() {
                Command::new("/usr/bin/env")
            } else {
                Command::new("env")
            };
            command.arg(executable).args(&inv.args);
            Ok(LaunchPlan {
                command,
                cleanup: None,
            })
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_launcher_plan(inv: &ResolvedInvocation, use_pwsh: bool) -> Result<LaunchPlan> {
    let executable = inv
        .executable
        .as_ref()
        .ok_or_else(|| native_error("缺少已解析的程序路径"))?;
    let launcher = write_launcher_script()?;
    let mut command = if use_pwsh {
        Command::new("pwsh")
    } else {
        Command::new("powershell")
    };
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&launcher)
        .arg(executable)
        .args(&inv.args);
    Ok(LaunchPlan {
        command,
        cleanup: Some(launcher),
    })
}

#[cfg(not(target_os = "windows"))]
fn windows_launcher_plan(_inv: &ResolvedInvocation, _use_pwsh: bool) -> Result<LaunchPlan> {
    Err(unavailable("当前平台不支持 Windows 命令启动器"))
}

/// 固定启动器：程序与参数以独立 argv 传入，再用调用运算符展开字符串数组。
/// 脚本里没有把用户输入拼进命令文本的路径。
#[cfg(target_os = "windows")]
const LAUNCHER_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
if ($args.Count -lt 1) {
  [Console]::Error.WriteLine('rein: missing program')
  exit 120
}
$program = [string]$args[0]
$rest = @()
if ($args.Count -gt 1) {
  $rest = $args[1..($args.Count - 1)]
}
if (-not [System.IO.Path]::IsPathRooted($program)) {
  $cmd = Get-Command -Name $program -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $cmd) {
    [Console]::Error.WriteLine("rein: program not found: $program")
    exit 127
  }
  $program = $cmd.Path
}
& $program @rest
if ($null -eq $LASTEXITCODE) {
  exit 0
}
exit [int]$LASTEXITCODE
"#;

#[cfg(target_os = "windows")]
fn write_launcher_script() -> Result<PathBuf> {
    let dir = sandbox_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|error| native_error(format!("无法创建终端沙箱目录：{error}")))?;
    let canonical_dir = std::fs::canonicalize(&dir)
        .map_err(|error| native_error(format!("终端沙箱目录不可访问：{error}")))?;

    for attempt in 0..8u32 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let path = dir.join(format!(
            "rein-launch-{}-{nanos}-{attempt}.ps1",
            std::process::id()
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(LAUNCHER_SCRIPT.as_bytes()) {
                    let _ = std::fs::remove_file(&path);
                    return Err(native_error(format!("无法写入命令启动器：{error}")));
                }
                drop(file);
                let canonical = std::fs::canonicalize(&path)
                    .map_err(|error| native_error(format!("命令启动器不可访问：{error}")))?;
                if !canonical.starts_with(&canonical_dir) {
                    let _ = std::fs::remove_file(&path);
                    return Err(path_denied("命令启动器不在沙箱目录内"));
                }
                // `-File` 不接受 `\\?\` 前缀，返回非 verbatim 路径。
                return Ok(strip_verbatim(&path));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(native_error(format!("无法创建命令启动器：{error}")));
            }
        }
    }
    Err(native_error("无法创建命令启动器"))
}

fn wait_with_timeout(child: &mut Child, timeout_ms: u64) -> (bool, Option<i32>) {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return (false, status.code()),
            Ok(None) => {
                if Instant::now() >= deadline {
                    kill_tree(child);
                    let status = child.wait().ok();
                    return (true, status.and_then(|value| value.code()));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                kill_tree(child);
                let status = child.wait().ok();
                return (false, status.and_then(|value| value.code()));
            }
        }
    }
}

/* ---------------- 环境白名单 ---------------- */

#[cfg(target_os = "windows")]
const ENV_WHITELIST: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PROCESSOR_ARCHITECTURE",
];

#[cfg(not(target_os = "windows"))]
const ENV_WHITELIST: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "TZ",
];

fn apply_env(command: &mut Command) {
    let mut vars = collect_whitelisted(std::env::vars());

    // Windows PowerShell 不一定在用户 PATH 里（尤其被精简过的 PATH）。把它补到
    // PATH 最前面，保证固定启动器能被 CreateProcess 找到；仍然只传白名单键。
    #[cfg(target_os = "windows")]
    {
        if let Some(dir) = powershell_dir() {
            if let Some((_, path)) = vars
                .iter_mut()
                .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
            {
                if !path.split(';').any(|part| part.eq_ignore_ascii_case(&dir)) {
                    path.insert_str(0, &format!("{dir};"));
                }
            } else {
                vars.push(("PATH".to_string(), dir));
            }
        }
    }

    for (key, value) in vars {
        if !value.is_empty() {
            command.env(key, value);
        }
    }
}

/// 纯函数：从父进程环境里挑白名单键（单测直接喂假环境）。
///
/// Windows 环境变量名大小写不敏感，`std::env::vars()` 返回的常见写法是
/// `Path` / `Pathext` 而不是 `PATH` / `PATHEXT`；这里必须按大小写不敏感匹配，
/// 否则子进程会拿不到 PATH，PowerShell 5.1 连托管运行时都加载失败。
fn collect_whitelisted<I>(vars: I) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (String, String)>,
{
    vars.into_iter()
        .filter(|(key, _)| env_key_allowed(key))
        .collect()
}

fn env_key_allowed(key: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        ENV_WHITELIST
            .iter()
            .any(|allowed| key.eq_ignore_ascii_case(allowed))
    }
    #[cfg(not(target_os = "windows"))]
    {
        ENV_WHITELIST.contains(&key)
    }
}

/* ---------------- 进程树 ---------------- */

static ACTIVE_PIDS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

fn register(pid: u32) {
    if let Ok(mut guard) = ACTIVE_PIDS.lock() {
        guard.push(pid);
    }
}

fn unregister(pid: u32) {
    if let Ok(mut guard) = ACTIVE_PIDS.lock() {
        guard.retain(|active| *active != pid);
    }
}

fn kill_tree(child: &mut Child) {
    let pid = child.id();
    if !kill_pid_tree(pid) {
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[cfg(target_os = "windows")]
fn configure_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(unix)]
fn configure_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // 新进程组：超时时可以整组 kill，而不只杀 leader。
    command.process_group(0);
}

#[cfg(not(any(target_os = "windows", unix)))]
fn configure_process(_command: &mut Command) {}

#[cfg(target_os = "windows")]
fn kill_pid_tree(pid: u32) -> bool {
    // 字面量程序名：不让任何用户输入成为 Command 的构造参数。
    // CreateProcess 的搜索顺序会先查 System32，再查 PATH。
    let mut command = Command::new("taskkill");
    command
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_process(&mut command);
    command
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Unix 直接调用 libc `kill(2)`：负数 pid = 进程组。
#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

#[cfg(unix)]
const SIGTERM: i32 = 15;
#[cfg(unix)]
const SIGKILL: i32 = 9;

#[cfg(unix)]
fn unix_kill_group(pid: u32, signal: i32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    unsafe { kill(-(pid as i32), signal) == 0 }
}

#[cfg(unix)]
fn kill_pid_tree(pid: u32) -> bool {
    if !unix_kill_group(pid, SIGTERM) {
        return false;
    }
    // 最多等 1s；进程组里还有任何进程就继续等。
    for _ in 0..20 {
        std::thread::sleep(Duration::from_millis(50));
        if !unix_kill_group(pid, 0) {
            return true;
        }
    }
    let _ = unix_kill_group(pid, SIGKILL);
    true
}

#[cfg(not(any(target_os = "windows", unix)))]
fn kill_pid_tree(_pid: u32) -> bool {
    false
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg(target_os = "windows")]
fn has_executable_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| matches!(extension.to_ascii_lowercase().as_str(), "exe" | "com"))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn find_program(program: &str) -> Option<PathBuf> {
    if let Some(found) = find_in_path(program) {
        if has_executable_extension(&found) {
            return Some(found);
        }
    }

    if let Some(root) = std::env::var_os("SystemRoot") {
        let system32 = PathBuf::from(root).join("System32");
        let direct = system32.join(program);
        if direct.is_file() && has_executable_extension(&direct) {
            return Some(direct);
        }
        for extension in [".exe", ".com"] {
            let candidate = system32.join(format!("{program}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    let path_ext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE".to_string());
    for extension in path_ext.split(';') {
        let extension = extension.trim().to_ascii_lowercase();
        if extension != ".exe" && extension != ".com" {
            continue;
        }
        let candidate = format!("{program}{extension}");
        if let Some(found) = find_in_path(&candidate) {
            return Some(found);
        }
    }
    None
}

#[cfg(unix)]
fn find_program(program: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    find_in_path(program).filter(|candidate| {
        candidate
            .metadata()
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    })
}

#[cfg(not(any(target_os = "windows", unix)))]
fn find_program(_program: &str) -> Option<PathBuf> {
    None
}

#[cfg(target_os = "windows")]
fn powershell_dir() -> Option<String> {
    let root = std::env::var_os("SystemRoot")?;
    let dir = PathBuf::from(root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0");
    if dir.is_dir() {
        Some(dir.display().to_string())
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn powershell_available() -> bool {
    if powershell_dir().is_some() {
        return true;
    }
    find_program("powershell").is_some()
}

#[cfg(not(target_os = "windows"))]
fn powershell_available() -> bool {
    find_program("powershell").is_some()
}

#[cfg(unix)]
fn unix_env_available() -> bool {
    Path::new("/usr/bin/env").is_file() || find_program("env").is_some()
}

fn spawn_error(program: &str, error: std::io::Error) -> ReinError {
    match error.kind() {
        std::io::ErrorKind::NotFound => bad_request(format!("找不到可执行程序：{program}")),
        std::io::ErrorKind::PermissionDenied => {
            permission_denied(format!("没有权限执行：{program}"))
        }
        _ => ReinError::coded(
            "connected_app_native_error",
            format!("启动 {program} 失败：{error}"),
        ),
    }
}

/* ---------------- 输出 ---------------- */

/// 边读边截断：超过 `cap` 的字节继续排空（避免管道阻塞），但不保留。
fn read_capped<R: Read>(mut reader: R, cap: usize) -> (Vec<u8>, bool) {
    let mut kept = Vec::with_capacity(cap.min(8192));
    let mut buffer = [0u8; 8192];
    let mut total = 0usize;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(bytes_read) => {
                total = total.saturating_add(bytes_read);
                if kept.len() < cap {
                    let take = (cap - kept.len()).min(bytes_read);
                    kept.extend_from_slice(&buffer[..take]);
                }
            }
            Err(ref error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    (kept, total > cap)
}

fn render(bytes: Vec<u8>, truncated: bool) -> (String, bool) {
    let mut text = decode_output(&bytes);
    if truncated {
        text.push('\n');
        text.push_str(TRUNCATED_MARK);
    }
    (text, truncated)
}

/// Windows PowerShell 5.1 重定向输出是 UTF-16LE；其它程序多为 UTF-8/GBK。
/// 这里只做保守识别：UTF-16 BOM 或「奇数位大量 NUL」时按 UTF-16LE 解码，
/// 否则按 UTF-8 lossy（GBK 仍可能乱码，见 plan 风险清单）。
fn decode_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        return decode_utf16_le(&bytes[2..]);
    }
    if bytes.len() >= 4 && bytes.len() % 2 == 0 {
        let odd_nuls = bytes
            .iter()
            .skip(1)
            .step_by(2)
            .filter(|byte| **byte == 0)
            .count();
        let even_nuls = bytes.iter().step_by(2).filter(|byte| **byte == 0).count();
        if odd_nuls > bytes.len() / 4 && even_nuls == 0 {
            return decode_utf16_le(bytes);
        }
    }
    String::from_utf8_lossy(bytes).to_string()
}

fn decode_utf16_le(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

#[cfg(target_os = "windows")]
fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

#[cfg(not(target_os = "windows"))]
fn display_path(path: &Path) -> String {
    path.display().to_string()
}

/// 去掉 Windows verbatim 前缀（`\\?\` / `\\?\UNC\`），供 PowerShell `-File` 使用。
#[cfg(target_os = "windows")]
fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.display().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

/// 子进程的 current_dir 也必须是普通路径：PowerShell 5.1 在 verbatim `\\?\`
/// 工作目录下加载托管运行时失败（0x8009001D）。
#[cfg(target_os = "windows")]
fn command_cwd(path: &Path) -> PathBuf {
    strip_verbatim(path)
}

#[cfg(not(target_os = "windows"))]
fn command_cwd(path: &Path) -> PathBuf {
    path.to_path_buf()
}

/* ---------------- 审计 ---------------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalAuditEntry {
    at: String,
    app: String,
    method: String,
    kind: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    decision: String,
    duration_ms: u64,
    summary: String,
}

static AUDIT_LOCK: Mutex<()> = Mutex::new(());

/// 终端审计路径。与 `db::data_dir` 的桌面分支一致；`REIN_DATA_DIR` 隔离优先。
///
/// 为什么这里重复一份：`apps::handle` 没有 `AppHandle` 参数，拿不到
/// `db::data_dir(app)`；这里按同一 data_dir 规则解析（`REIN_DATA_DIR` 优先），
/// 审计字段与 `audit::write` 同形。
pub(crate) fn default_audit_path() -> Option<PathBuf> {
    let base = data_dir_fallback()?;
    Some(base.join("connected_apps").join("audit.jsonl"))
}

fn data_dir_fallback() -> Option<PathBuf> {
    if let Some(raw) = std::env::var_os("REIN_DATA_DIR") {
        let raw = raw.to_string_lossy().trim().to_string();
        if !raw.is_empty() {
            let mut path = PathBuf::from(raw);
            if !path.is_absolute() {
                if let Ok(cwd) = std::env::current_dir() {
                    path = cwd.join(path);
                }
            }
            return Some(path);
        }
    }

    #[cfg(target_os = "windows")]
    let base: Option<PathBuf> = std::env::var_os("APPDATA").map(PathBuf::from);

    #[cfg(target_os = "macos")]
    let base: Option<PathBuf> = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library/Application Support"));

    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
    let base: Option<PathBuf> = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));

    #[cfg(any(target_os = "android", not(any(target_os = "windows", unix))))]
    let base: Option<PathBuf> = None;

    Some(base?.join("com.gozaoo.rein"))
}

fn audit(
    opts: &TerminalOptions,
    invocation: &ResolvedInvocation,
    exit_code: Option<i32>,
    duration_ms: u64,
    timed_out: bool,
    code: Option<&'static str>,
    decision: &str,
    ok: bool,
) -> bool {
    let Some(path) = opts.audit_path.as_deref() else {
        return false;
    };
    let entry = TerminalAuditEntry {
        at: chrono::Local::now().to_rfc3339(),
        app: opts.app_id.clone(),
        method: "run_terminal_command".to_string(),
        kind: "write".to_string(),
        ok,
        code: code.map(|value| value.to_string()),
        decision: decision.to_string(),
        duration_ms,
        summary: audit_summary(invocation, exit_code, timed_out),
    };
    write_audit_with_limit(path, &entry, MAX_AUDIT_BYTES)
}

fn audit_summary(
    invocation: &ResolvedInvocation,
    exit_code: Option<i32>,
    timed_out: bool,
) -> String {
    let args = redact_args(&invocation.args).join(" ");
    let exit = if timed_out {
        "timeout".to_string()
    } else {
        exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_string())
    };
    let summary = format!(
        "program={} args=[{}] cwd={} exit={}",
        invocation.program,
        args,
        display_path(&invocation.cwd),
        exit
    );
    summary.chars().take(300).collect()
}

/// 参数脱敏：`--token x`、`PASSWORD=x`、`Authorization: Bearer x` 等值替换 `***`。
pub(crate) fn redact_args(args: &[String]) -> Vec<String> {
    const SECRET_KEYS: &[&str] = &[
        "api_key",
        "apikey",
        "token",
        "secret",
        "password",
        "passwd",
        "authorization",
        "bearer",
    ];
    let mut out = Vec::with_capacity(args.len());
    let mut mask_next = false;
    for arg in args {
        let lower = arg.to_ascii_lowercase();
        let sensitive = SECRET_KEYS.iter().any(|key| lower.contains(key));
        let rendered = if mask_next {
            "***".to_string()
        } else if sensitive {
            mask_value(arg)
        } else {
            arg.clone()
        };
        out.push(rendered);
        mask_next = is_sensitive_flag(arg);
    }
    out
}

fn is_sensitive_flag(arg: &str) -> bool {
    let trimmed = arg.trim_start_matches('-').trim_start_matches('/');
    // `--token abc` 的值在下一个参数；`password=abc` / `Authorization: Bearer x`
    // 的值已经内联，不应把下一个无关参数也打码。
    if trimmed.contains('=') || trimmed.contains(':') {
        return false;
    }
    let key = trimmed.to_ascii_lowercase();
    matches!(
        key.as_str(),
        "api_key"
            | "apikey"
            | "api-key"
            | "token"
            | "secret"
            | "password"
            | "passwd"
            | "authorization"
            | "bearer"
    )
}

fn mask_value(arg: &str) -> String {
    if let Some((key, _)) = arg.split_once('=') {
        format!("{key}=***")
    } else if let Some((key, _)) = arg.split_once(':') {
        format!("{key}:***")
    } else {
        "***".to_string()
    }
}

fn write_audit_with_limit(path: &Path, entry: &TerminalAuditEntry, limit: u64) -> bool {
    let _guard = AUDIT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    rotate_if_needed(path, limit);
    let line = match serde_json::to_string(entry) {
        Ok(line) => line,
        Err(_) => return false,
    };
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        Ok(mut file) => file.write_all(format!("{line}\n").as_bytes()).is_ok(),
        Err(error) => {
            eprintln!("[connected_apps] 终端审计写入失败：{error}");
            false
        }
    }
}

fn rotate_if_needed(path: &Path, limit: u64) {
    let too_big = std::fs::metadata(path)
        .map(|meta| meta.len() > limit)
        .unwrap_or(false);
    if !too_big {
        return;
    }
    let backup = path.with_file_name(AUDIT_BACKUP);
    let _ = std::fs::remove_file(&backup);
    let _ = std::fs::rename(path, &backup);
}

/* ---------------- 错误构造 ---------------- */

fn bad_request(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_bad_request", message)
}

fn permission_denied(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_permission_denied", message)
}

fn path_denied(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_path_denied", message)
}

fn unavailable(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_unavailable", message)
}

fn native_error(message: impl Into<String>) -> ReinError {
    ReinError::coded("connected_app_native_error", message)
}

/* ---------------- 单测 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("rein-term-{label}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn request(
        program: &str,
        args: &[&str],
        cwd: Option<&str>,
        timeout_ms: u64,
    ) -> TerminalRequest {
        TerminalRequest {
            program: program.to_string(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            cwd: cwd.map(|cwd| cwd.to_string()),
            timeout_ms: Some(timeout_ms),
            max_output_bytes: None,
        }
    }

    fn options(extra: Vec<PathBuf>) -> TerminalOptions {
        TerminalOptions {
            app_id: "win-terminal".to_string(),
            extra_roots: extra,
            audit_path: None,
        }
    }

    #[test]
    fn rejects_path_program() {
        for program in [
            r"C:\Windows\System32\cmd.exe",
            "/bin/sh",
            r"..\evil.exe",
            "dir/evil",
            "./evil",
        ] {
            let err = validate_program_name(program).unwrap_err();
            assert_eq!(err.code(), "connected_app_path_denied", "{program}");
        }
    }

    #[test]
    fn rejects_shell_metacharacters_in_program() {
        for program in ["a&b", "a|b", "a;b", "a$(x)", "a*b", "a?b", "a[b]"] {
            let err = validate_program_name(program).unwrap_err();
            assert!(
                err.code() == "connected_app_path_denied"
                    || err.code() == "connected_app_bad_request",
                "{program}: {}",
                err.code()
            );
        }
    }

    #[test]
    fn rejects_privilege_escalation_and_script_hosts() {
        for program in [
            "sudo",
            "su",
            "doas",
            "runas",
            "gsudo",
            "pkexec",
            "SUDO.EXE",
            "cmd",
            "cmd.exe",
            "wscript.exe",
            "cscript",
            "mshta.exe",
        ] {
            let err = validate(
                &request(program, &[], Some("sandbox"), 1_000),
                &options(Vec::new()),
            )
            .unwrap_err();
            assert_eq!(err.code(), "connected_app_permission_denied", "{program}");
        }
    }

    #[test]
    fn powershell_requires_file_mode() {
        let err = validate(
            &request(
                "powershell.exe",
                &["-NoProfile", "-Command", "Get-Process"],
                Some("sandbox"),
                1_000,
            ),
            &options(Vec::new()),
        )
        .unwrap_err();
        assert_eq!(err.code(), "connected_app_permission_denied");
    }

    #[test]
    fn shell_rejects_command_flag() {
        for program in ["bash", "sh"] {
            let err = validate(
                &request(program, &["-c", "id"], Some("sandbox"), 1_000),
                &options(Vec::new()),
            )
            .unwrap_err();
            assert_eq!(err.code(), "connected_app_permission_denied", "{program}");
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn powershell_accepts_file_script_in_allowed_root() {
        let dir = unique_dir("ps");
        let script = dir.join("hello.ps1");
        std::fs::write(&script, "Write-Output hi").unwrap();
        let invocation = validate(
            &request(
                "powershell.exe",
                &[
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    &script.display().to_string(),
                ],
                Some(&dir.display().to_string()),
                1_000,
            ),
            &options(vec![dir.clone()]),
        )
        .unwrap();
        assert_eq!(invocation.program, "powershell.exe");
        assert_eq!(invocation.args.len(), 5);
        assert_eq!(invocation.launch, LaunchProgram::Powershell);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn shell_accepts_script_in_allowed_root() {
        let dir = unique_dir("sh");
        let script = dir.join("hello.sh");
        std::fs::write(&script, "echo hi").unwrap();
        let invocation = validate(
            &request(
                "bash",
                &["-eu", &script.display().to_string()],
                Some(&dir.display().to_string()),
                1_000,
            ),
            &options(vec![dir.clone()]),
        )
        .unwrap();
        assert_eq!(invocation.program, "bash");
        assert_eq!(invocation.launch, LaunchProgram::Bash);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_script_outside_allowed_roots() {
        #[cfg(target_os = "windows")]
        let outside = r"C:\Windows\win.ini";
        #[cfg(unix)]
        let outside = "/etc/hosts";
        let err = validate(
            &request("bash", &[outside], Some("sandbox"), 1_000),
            &options(Vec::new()),
        )
        .unwrap_err();
        assert!(
            err.code() == "connected_app_path_denied" || err.code() == "connected_app_bad_request",
            "unexpected code {}",
            err.code()
        );
    }

    #[test]
    fn rejects_too_many_or_too_long_args() {
        let many: Vec<String> = (0..=MAX_ARGS).map(|i| i.to_string()).collect();
        let mut req = request("hostname", &[], Some("sandbox"), 1_000);
        req.args = many;
        assert_eq!(
            validate(&req, &options(Vec::new())).unwrap_err().code(),
            "connected_app_bad_request"
        );

        let mut req = request("hostname", &[], Some("sandbox"), 1_000);
        req.args = vec!["a".repeat(MAX_ARG_BYTES + 1)];
        assert_eq!(
            validate(&req, &options(Vec::new())).unwrap_err().code(),
            "connected_app_bad_request"
        );

        let mut req = request("hostname", &[], Some("sandbox"), 1_000);
        req.args = (0..5).map(|_| "a".repeat(4_000)).collect();
        assert_eq!(
            validate(&req, &options(Vec::new())).unwrap_err().code(),
            "connected_app_bad_request"
        );
    }

    #[test]
    fn rejects_timeout_out_of_bounds() {
        let mut req = request("hostname", &[], Some("sandbox"), 1_000);
        req.timeout_ms = Some(MAX_TIMEOUT_MS + 1);
        assert_eq!(
            validate(&req, &options(Vec::new())).unwrap_err().code(),
            "connected_app_bad_request"
        );
        req.timeout_ms = Some(MIN_TIMEOUT_MS - 1);
        assert_eq!(
            validate(&req, &options(Vec::new())).unwrap_err().code(),
            "connected_app_bad_request"
        );
    }

    #[test]
    fn rejects_cwd_outside_allowed_roots() {
        #[cfg(target_os = "windows")]
        let outside = r"C:\Windows\System32";
        #[cfg(unix)]
        let outside = "/etc";
        let err = validate(
            &request("hostname", &[], Some(outside), 1_000),
            &options(Vec::new()),
        )
        .unwrap_err();
        assert_eq!(err.code(), "connected_app_path_denied");
    }

    #[test]
    fn rejects_home_directory_as_cwd() {
        let Some(home) = home_dir() else {
            return;
        };
        let raw = home.to_string_lossy().to_string();
        let err = validate(
            &request("hostname", &[], Some(raw.as_str()), 1_000),
            &options(Vec::new()),
        )
        .unwrap_err();
        assert_eq!(err.code(), "connected_app_path_denied");
    }

    #[test]
    fn rejects_env_wrapper() {
        let err = validate(
            &request("env", &["sudo", "id"], Some("sandbox"), 1_000),
            &options(Vec::new()),
        )
        .unwrap_err();
        assert_eq!(err.code(), "connected_app_permission_denied");
    }

    #[test]
    fn rejects_relative_cwd_that_is_not_alias() {
        let err = validate(
            &request("hostname", &[], Some("../escape"), 1_000),
            &options(Vec::new()),
        )
        .unwrap_err();
        assert_eq!(err.code(), "connected_app_path_denied");
    }

    #[test]
    fn rejects_alias_parent_segments() {
        let err = validate(
            &request("hostname", &[], Some("desktop/../escape"), 1_000),
            &options(Vec::new()),
        )
        .unwrap_err();
        assert_eq!(err.code(), "connected_app_path_denied");
    }

    #[test]
    fn allows_sandbox_alias() {
        let invocation = validate(
            &request("hostname", &[], Some("sandbox"), 1_000),
            &options(Vec::new()),
        )
        .unwrap();
        assert!(invocation.cwd.ends_with("rein-terminal"));
    }

    #[test]
    fn env_whitelist_excludes_secrets() {
        let vars = vec![
            ("PATH".to_string(), "/bin".to_string()),
            ("REIN_API_KEY".to_string(), "secret".to_string()),
            ("OPENAI_API_KEY".to_string(), "secret".to_string()),
            ("SERVICE_TOKEN".to_string(), "secret".to_string()),
            ("DATABASE_PASSWORD".to_string(), "secret".to_string()),
        ];
        let kept = collect_whitelisted(vars);
        assert!(kept.iter().any(|(key, _)| key == "PATH"));
        assert!(!kept.iter().any(|(key, _)| key.contains("API_KEY")
            || key.contains("TOKEN")
            || key.contains("PASSWORD")));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn env_whitelist_is_case_insensitive_on_windows() {
        let vars = vec![
            ("Path".to_string(), "C:\\Windows".to_string()),
            ("Pathext".to_string(), ".EXE".to_string()),
            ("OpenAI_Api_Key".to_string(), "secret".to_string()),
        ];
        let kept = collect_whitelisted(vars);
        assert!(kept.iter().any(|(key, _)| key.eq_ignore_ascii_case("PATH")));
        assert!(kept
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("PATHEXT")));
        assert!(!kept
            .iter()
            .any(|(key, _)| key.to_ascii_lowercase().contains("api_key")));
    }

    #[test]
    fn output_cap_truncates_and_marks() {
        let (bytes, truncated) = read_capped(std::io::Cursor::new(vec![b'a'; 100_000]), 1_024);
        assert_eq!(bytes.len(), 1_024);
        assert!(truncated);
        let (text, cut) = render(bytes, truncated);
        assert!(cut);
        assert!(text.ends_with(TRUNCATED_MARK));
    }

    #[test]
    fn decodes_utf16le_output() {
        let bytes: Vec<u8> = "hello"
            .encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();
        assert_eq!(decode_output(&bytes), "hello");
    }

    #[test]
    fn redacts_terminal_args() {
        let args = vec![
            "--token".to_string(),
            "abc".to_string(),
            "password=hunter2".to_string(),
            "--name".to_string(),
            "rein".to_string(),
            "Authorization: Bearer xyz".to_string(),
        ];
        let redacted = redact_args(&args);
        assert_eq!(redacted[0], "***");
        assert_eq!(redacted[1], "***");
        assert_eq!(redacted[2], "password=***");
        assert_eq!(redacted[3], "--name");
        assert_eq!(redacted[4], "rein");
        assert_eq!(redacted[5], "Authorization:***");
    }

    #[test]
    fn audit_rotates_at_limit() {
        let dir = unique_dir("audit");
        let path = dir.join("connected_apps").join("audit.jsonl");
        let entry = TerminalAuditEntry {
            at: "2026-11-10T00:00:00+08:00".to_string(),
            app: "win-terminal".to_string(),
            method: "run_terminal_command".to_string(),
            kind: "write".to_string(),
            ok: true,
            code: None,
            decision: "allowed".to_string(),
            duration_ms: 1,
            summary: "program=echo".to_string(),
        };
        assert!(write_audit_with_limit(&path, &entry, 10));
        assert!(write_audit_with_limit(&path, &entry, 10));
        assert!(path.with_file_name(AUDIT_BACKUP).is_file());
        assert!(path.is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_program_is_bad_request() {
        let req = request(
            "rein-definitely-not-a-real-program-xyz",
            &[],
            Some("sandbox"),
            1_000,
        );
        let err = run(&req, &options(Vec::new())).unwrap_err();
        assert_eq!(err.code(), "connected_app_bad_request");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn executes_simple_program() {
        let outcome = run(
            &request("hostname", &[], Some("sandbox"), 10_000),
            &options(Vec::new()),
        )
        .unwrap();
        assert_eq!(outcome.exit_code, Some(0));
        assert!(!outcome.timed_out);
        assert!(!outcome.stdout.trim().is_empty());
        assert!(outcome.duration_ms < 10_000);
    }

    #[cfg(unix)]
    #[test]
    fn executes_simple_program() {
        let outcome = run(
            &request("uname", &[], Some("sandbox"), 5_000),
            &options(Vec::new()),
        )
        .unwrap();
        assert_eq!(outcome.exit_code, Some(0));
        assert!(!outcome.timed_out);
        assert!(!outcome.stdout.trim().is_empty());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn timeout_kills_process_tree() {
        let outcome = run(
            &request("ping", &["-n", "10", "127.0.0.1"], Some("sandbox"), 300),
            &options(Vec::new()),
        )
        .unwrap();
        assert!(outcome.timed_out);
        assert!(outcome.duration_ms < 6_000);
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_process_tree() {
        let outcome = run(
            &request("sleep", &["5"], Some("sandbox"), 300),
            &options(Vec::new()),
        )
        .unwrap();
        assert!(outcome.timed_out);
        assert!(outcome.duration_ms < 4_000);
    }
}
