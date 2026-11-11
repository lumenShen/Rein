//! Rust 侧工具注册表（Phase 4 渐进迁移）。
//!
//! 约定：**Rust 优先，未注册回退前端桥接**。执行器（`commands.rs` 的
//! HybridExecutor）先查这里的 `run_tool`，返回 `None`（工具还没搬）才走
//! 「事件 → 前端注册表 → ai_agent_tool_result」。请求 defs 同理：
//! [`defs_for_groups`] 给出已迁移工具的 schema，与前端传来的 `params.tools`
//! 按名去重合并 —— 前端在对应 TS 工具文件删除前后都无需改一行。
//!
//! 新搬一个工具的完整路径：
//! 1. 在对应域子模块写 `fn def() -> RegisteredTool` + `async fn run(app, args) -> Result<Value>`；
//! 2. 在 [`registry()`] 静态表登记；
//! 3. 组名沿用前端 `ToolGroup`（registry.ts），装载策略仍由前端 resolveToolPlan 决定。

pub mod kb;
pub mod misc;
pub mod web;

use std::sync::OnceLock;

use serde_json::Value;

use crate::error::Result;

use super::llm::LlmToolDef;
use super::models::ToolOutcome;

/// 一个已迁移到 Rust 的工具
#[derive(Debug, Clone)]
pub struct RegisteredTool {
    pub name: &'static str,
    /// 前端 ToolGroup 同名（装载策略在前端 resolveToolPlan）
    pub group: &'static str,
    /// 中文短名（UI 过程卡展示）
    #[allow(dead_code)] // 由描述表统一携带，当前无读取点
    pub label: &'static str,
    pub description: &'static str,
    /// JSON Schema（对齐 TS defineTool 的 TypeBox 形状）
    pub parameters: Value,
}

impl RegisteredTool {
    pub fn def(&self) -> LlmToolDef {
        LlmToolDef {
            name: self.name.to_string(),
            description: self.description.to_string(),
            parameters: self.parameters.clone(),
        }
    }
}

/// 已迁移工具的清单。
///
/// 进程内只构造一次（实测重建约 0.06 ms/步，本身不是瓶颈）——缓存主要是为了
/// 让 [`is_registered`] 与 defs 走同一份表：**两者必须永远一致**，
/// 一旦「登记了但 run_tool 不认」，前端会因为 kernel=true 跳过 TS 执行而静默失效。
pub fn registry() -> &'static [RegisteredTool] {
    static REGISTRY: OnceLock<Vec<RegisteredTool>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        vec![
            misc::search_history(),
            web::web_search_def(),
            web::web_fetch_def(),
            kb::search_knowledge(),
            kb::read_knowledge(),
            kb::glob_knowledge(),
            kb::write_note(),
            kb::rename_note(),
            kb::delete_note(),
            kb::read_modal(),
            kb::classify_move(),
            kb::pin_file(),
            kb::make_folder(),
            kb::list_archive(),
            kb::extract_archive(),
            kb::workspace_usage(),
            kb::find_large_files(),
            kb::present_file(),
            kb::list_memories(),
            kb::recall_memory(),
            kb::remember(),
            kb::edit_memory(),
            kb::forget(),
        ]
    })
}

/// 该名字是否由 Rust 注册表执行。
///
/// 前端据此**跳过 TS 侧同名工具的重复执行**（见 `AgentEvent::ToolStarted.kernel`）：
/// 迁移后内核自己会跑，前端再跑一遍等于同一次副作用做两遍（写库、移动文件都会重复）。
pub fn is_registered(name: &str) -> bool {
    registry().iter().any(|t| t.name == name)
}

/// 按组取工具 defs（保持登记顺序）
pub fn defs_for_groups(groups: &[String]) -> Vec<LlmToolDef> {
    registry()
        .iter()
        .filter(|t| groups.iter().any(|g| g == t.group))
        .map(|t| t.def())
        .collect()
}

/// 执行一个工具；`None` = 未注册（调用方回退前端桥接）。
///
/// 失败收敛为 `is_error: true` 的结果（模型据此自纠正），不抛 IPC 错误 ——
/// 与前端注册表「失败 throw 由框架回灌错误」的语义一致。
pub async fn run_tool(app: &tauri::AppHandle, name: &str, args: &Value) -> Option<ToolOutcome> {
    // 各域实现需要的 State 从 app 现取（任务里 app 是 'static 的）。
    // 分派按各域的 `handles` 名单走：名单既是分派依据，也是测试断言
    // 「注册表 ⊆ 各域认领」的依据，只有一份、不会两处漂移。
    let outcome = if misc::handles(name) {
        Some(misc::run(app, args).await)
    } else if web::handles(name) {
        Some(web::run(app, name, args).await)
    } else if kb::handles(name) {
        kb::run(app, name, args).await
    } else {
        None
    };
    let Some(outcome) = outcome else {
        // 「已登记但没人执行」是内核 bug：前端看到 kernel=true 就不再跑 TS 侧同名工具，
        // 这里再静默返回 None，这次调用就无声消失了。宁可吵一声。
        if is_registered(name) {
            eprintln!("[ai-agent] 工具 {name} 已登记但没有执行器（内核 bug）");
            return Some(ToolOutcome::error(format!(
                "[内部错误] 工具 {name} 已登记但未接入执行器，请把这条反馈给开发者"
            )));
        }
        return None;
    };
    Some(match outcome {
        Ok(v) => ToolOutcome::ok(v.to_string()),
        Err(e) => ToolOutcome::error(e.to_string()),
    })
}

/* ---------- 共享小工具（各域复用） ---------- */

/// 读对象字段里的有限数值；`default` 在缺省/非法时生效
pub(crate) fn num_arg(args: &Value, key: &str, default: f64) -> f64 {
    args.get(key).and_then(|v| v.as_f64()).filter(|v| v.is_finite()).unwrap_or(default)
}

/// 读字符串参数（缺失/非字符串报错）
pub(crate) fn str_arg<'a>(args: &'a Value, key: &str) -> crate::error::Result<&'a str> {
    args.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| crate::error::ReinError::Message(format!("参数 {key} 缺失或不是字符串")))
}

/// 本地今天（YYYY-MM-DD）
#[allow(dead_code)] // 工具入参解析的公共件，当前无调用点
pub(crate) fn today_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// 日期入参：缺省 = 今天；传了则校验 YYYY-MM-DD（对齐 TS resolveDate）
#[allow(dead_code)] // 同上：留给工具实现接线
pub(crate) fn resolve_date(args: &Value, key: &str) -> crate::error::Result<String> {
    let v = match args.get(key).and_then(|x| x.as_str()) {
        Some(s) => s.trim(),
        None => return Ok(today_str()),
    };
    if v.is_empty() {
        return Ok(today_str());
    }
    let b = v.as_bytes();
    let ok = v.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && v[..4].bytes().all(|c| c.is_ascii_digit())
        && v[5..7].bytes().all(|c| c.is_ascii_digit())
        && v[8..].bytes().all(|c| c.is_ascii_digit());
    if !ok {
        return Err(crate::error::ReinError::Message(format!(
            "{key} 格式应为 YYYY-MM-DD（可传『今天』对应的 {}），收到「{v}」",
            today_str()
        )));
    }
    Ok(v.to_string())
}

/// 结果投影统一 JSON 化（serde_json::json! 直接构造则无需此函数）
#[allow(dead_code)] // 恒等投影：留作统一出口，当前无调用点
pub(crate) fn to_outcome_json(v: Result<Value>) -> Result<Value> {
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_unique_names_and_known_groups() {
        let reg = registry();
        assert!(reg.len() >= 3, "首批至少 3 个工具");
        let mut names: Vec<_> = reg.iter().map(|t| t.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), reg.len(), "工具名不得重复");
        for t in reg {
            assert!(!t.group.is_empty());
            assert!(t.parameters.is_object(), "{} 的 parameters 应为 JSON Schema object", t.name);
            assert!(t.parameters["type"] == "object", "{} 缺 type:object", t.name);
            assert!(!t.description.is_empty());
        }
    }

    /// 名字集一致性：`is_registered` 决定前端是否跳过 TS 侧执行（AgentEvent::ToolStarted.kernel），
    /// 一旦「登记了但没人执行」就会出现「前端不跑、后端也不跑」的静默失效。
    ///
    /// 断言方向是**注册表 → 各域认领**（而不是反过来列一串名字）：前者才是危险方向。
    #[test]
    fn registered_names_match_dispatcher() {
        for c in [misc::SEARCH_HISTORY_NAME, web::WEB_SEARCH_NAME, web::WEB_FETCH_NAME] {
            assert!(is_registered(c), "{c} 应在注册表里");
        }
        assert!(!is_registered("load_tools"), "未迁移的工具不该被当成内核工具");
        assert!(!is_registered("完全不存在的工具"));
        for t in registry() {
            let claimed = kb::handles(t.name) || web::handles(t.name) || misc::handles(t.name);
            assert!(
                claimed,
                "工具 {} 已登记但没有域认领：前端会跳过 TS 执行，等于静默失效",
                t.name
            );
        }
    }

    #[test]
    fn defs_for_groups_filters_and_maps() {
        let defs = defs_for_groups(&["web".to_string()]);
        assert_eq!(defs.len(), 2, "web 组应有 web_search + web_fetch");
        assert!(defs.iter().any(|d| d.name == "web_search"));
        assert!(defs.iter().any(|d| d.name == "web_fetch"));
        assert!(defs_for_groups(&["nonexistent".to_string()]).is_empty());
        // schema 直通：发给 LLM 的 parameters 就是注册的 JSON Schema
        let def = defs.iter().find(|d| d.name == "web_search").unwrap();
        assert_eq!(def.parameters["properties"]["query"]["type"], "string");
    }

    #[test]
    fn num_arg_defaults_on_missing_or_invalid() {
        let args = serde_json::json!({ "a": 5, "b": "x", "c": null });
        assert_eq!(num_arg(&args, "a", 8.0), 5.0);
        assert_eq!(num_arg(&args, "b", 8.0), 8.0);
        assert_eq!(num_arg(&args, "c", 8.0), 8.0);
        assert_eq!(num_arg(&args, "missing", 8.0), 8.0);
    }
}
