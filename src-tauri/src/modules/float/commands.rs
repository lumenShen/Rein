//! 全局沉浸浮窗命令族（docs/GLOBAL-FLOAT.md §5.2，共 8 条）。
//!
//! 薄壳：只做「平台分支 + 组装返回值」，实现分别在 `mod.rs` 的桌面 / Android 段。
//! 全部是**同步 fn** —— Tauri 同步命令跑在主线程，建窗 / 改尺寸才安全（改 async 会在
//! 线程池里碰 Win32 窗口，直接 panic）。命令清单三处同步：这里 ↔ `lib.rs` 的
//! `generate_handler!` ↔ 前端 `services/floatService.ts`（mock 同名实现），漏一处
//! `npm run contract` 会红。
//!
//! 返回值语义两端不同，但形状一致（前端只认一个 `GlobalFloatStatus`）：
//! - Windows：supported / permitted 恒 true；visible = 窗口存在且可见。建窗失败的那一次
//!   open 返回 supported=false，前端据此静默降级为程序内浮条（不重试、不弹错）。
//! - Android：supported 恒 true；permitted / visible 来自**上一次** JNI snapshot 缓存
//!   （exec 无回执通道，见 `mod.rs` 文件头），调用方按轮询收敛，不要假设 open 后立即 true。
//! - 其它平台（macOS / Linux 桌面、iOS）：全部 no-op，supported=false。

use serde::Serialize;

use crate::error::Result;

/// 浮窗能力 / 权限 / 显示状态快照（前端 `GlobalFloatStatus`，§5.1）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalFloatStatus {
    /// 本平台是否支持系统浮窗
    pub supported: bool,
    /// 系统浮窗权限是否已授予（桌面恒 true；Android 看「在其他应用上显示」）
    pub permitted: bool,
    /// 浮窗此刻是否在显示（Android 是「服务在跑」的近似值，见文件头）
    pub visible: bool,
}

/// 其它平台统一回「不支持」：前端读到它就走程序内浮条，与浏览器 mock 同形（§2）
#[cfg(not(any(target_os = "windows", target_os = "android")))]
const UNSUPPORTED: GlobalFloatStatus = GlobalFloatStatus {
    supported: false,
    permitted: false,
    visible: false,
};

/// 能力 / 权限 / 显示状态。Android 顺带触发一次 snapshot 刷新（返回的仍是上次缓存）。
#[tauri::command]
pub fn global_float_status(webview: tauri::Webview<tauri::Wry>) -> Result<GlobalFloatStatus> {
    #[cfg(target_os = "windows")]
    {
        Ok(GlobalFloatStatus {
            // 桌面能建第二窗口（建不起来的失败在 open 里发现，不在 status 里预判）
            supported: true,
            permitted: true,
            visible: super::desktop_visible(&webview),
        })
    }
    #[cfg(target_os = "android")]
    {
        super::android_refresh(&webview);
        let (permitted, running) = super::android_status();
        Ok(GlobalFloatStatus {
            // API < 23 / 未授权由 Kotlin 侧 snapshot 兜底，Rust 不重复判平台版本
            supported: true,
            permitted,
            visible: running && permitted,
        })
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        let _ = webview;
        Ok(UNSUPPORTED)
    }
}

/// 显示系统浮窗：桌面建窗（已存在则 show）/ Android 有权限则起前台服务。
/// 返回值是**操作后的尽力快照**：Android 的服务启动是异步的，这一拍往往还是旧值。
#[tauri::command]
pub fn global_float_open(webview: tauri::Webview<tauri::Wry>) -> Result<GlobalFloatStatus> {
    #[cfg(target_os = "windows")]
    {
        if !super::desktop_open(&webview) {
            // 建窗失败：这一次如实回 supported=false，让前端降级；下次会话变化时还会再试
            return Ok(GlobalFloatStatus {
                supported: false,
                permitted: true,
                visible: false,
            });
        }
        Ok(GlobalFloatStatus {
            supported: true,
            permitted: true,
            visible: super::desktop_visible(&webview),
        })
    }
    #[cfg(target_os = "android")]
    {
        super::android_open(&webview);
        let (permitted, running) = super::android_status();
        Ok(GlobalFloatStatus {
            supported: true,
            permitted,
            visible: running && permitted,
        })
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        let _ = webview;
        Ok(UNSUPPORTED)
    }
}

/// 收起系统浮窗（桌面 hide 不销毁 / Android 停服务）。会话本身不受影响。
#[tauri::command]
pub fn global_float_close(webview: tauri::Webview<tauri::Wry>) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        super::desktop_close(&webview);
        Ok(())
    }
    #[cfg(target_os = "android")]
    {
        super::android_close(&webview);
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        let _ = webview;
        Ok(())
    }
}

/// 推送内容快照（JSON 文本，前端 `JSON.stringify(GlobalFloatStatePayload)` 的产物）。
///
/// Rust 只负责缓存 + 转发，**不解析字段**：前后端共用同一份 JSON 契约，
/// 多解析一层只会多一个漂移点，也让「加一种沉浸会话」变成 Rust 也要改。
#[tauri::command]
pub fn global_float_push(
    webview: tauri::Webview<tauri::Wry>,
    payload: String,
) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        super::desktop_push(&webview, payload);
        Ok(())
    }
    #[cfg(target_os = "android")]
    {
        super::android_push(&webview, payload);
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        let _ = (webview, payload);
        Ok(())
    }
}

/// 最近一次推送的载荷（浮窗首帧用；没有则空串）。不触发任何原生调用。
#[tauri::command]
pub fn global_float_latest() -> Result<String> {
    #[cfg(any(target_os = "windows", target_os = "android"))]
    {
        Ok(super::latest_payload())
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        Ok(String::new())
    }
}

/// 切换浮窗窗口形状：`bar` / `blob` 为持久形态，`confirm` 为结束确认的临时长高；
/// 其它值忽略并保持当前尺寸（不猜、不改，免得前端拼错时静默错位）。
#[tauri::command]
pub fn global_float_set_form(
    webview: tauri::Webview<tauri::Wry>,
    form: String,
) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        super::desktop_set_form(&webview, &form);
        Ok(())
    }
    #[cfg(target_os = "android")]
    {
        super::android_set_form(&webview, form);
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        let _ = (webview, form);
        Ok(())
    }
}

/// Android：跳「在其他应用上显示」授权页；桌面是空操作（恒已授权）。
#[tauri::command]
pub fn global_float_request_permission(
    webview: tauri::Webview<tauri::Wry>,
) -> Result<GlobalFloatStatus> {
    #[cfg(target_os = "windows")]
    {
        Ok(GlobalFloatStatus {
            supported: true,
            permitted: true,
            visible: super::desktop_visible(&webview),
        })
    }
    #[cfg(target_os = "android")]
    {
        super::android_request_permission(&webview);
        let (permitted, running) = super::android_status();
        Ok(GlobalFloatStatus {
            supported: true,
            permitted,
            visible: running && permitted,
        })
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        let _ = webview;
        Ok(UNSUPPORTED)
    }
}

/// Android：读走原生浮层产生的动作 JSON（读走即清；桌面恒空串）。
///
/// 与 `tracking_open_pending` 同一条「缓存 + 异步刷新」路径：命令先把 exec 扔出去，
/// 返回的是上一次 exec 写进缓存的动作。冷启动 / 进程冻结期的点击就靠 visibilitychange
/// 再调一次兜回来（§5.3）。
#[tauri::command]
pub fn global_float_take_action(webview: tauri::Webview<tauri::Wry>) -> Result<String> {
    #[cfg(target_os = "android")]
    {
        super::android_take_action(&webview);
        Ok(super::take_pending_action())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = webview;
        Ok(String::new())
    }
}
