//! Rein 应用入口：装配状态、注册所有模块命令。
//!
//! 新增命令的完整步骤见 docs/ARCHITECTURE.md「扩展指南」；
//! 每次在这里登记新命令时，必须同步更新前端 `src/services/*Service.ts`。

mod db;
mod error;
mod modules;
mod state;

use tauri::Manager;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 系统通知：抢课结果的**最后一块**。引擎的前提是「用户不在场」，
        // 而在此之前结果只存在于 App 内部（一条 12 秒的浮条 + 一个要主动点进去的面板）——
        // 手机在兜里的时候，那等于没有结果。
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let conn = db::init(app.handle())?;
            // 多设备同步：变更捕获的钩子必须在连接交出去之前装 —— 钩子只往脏队列记一笔
            // （表名/rowid/操作），真正的读行与拼对象由下面的 rein-sync 线程成批做。
            let dirty = std::sync::Arc::new(modules::sync::engine::Dirty::new());
            modules::sync::engine::install_hook(&conn, std::sync::Arc::clone(&dirty));
            // 番茄钟重启恢复语义（contract §14.1，用户定稿）：应用关闭期间倒计时走完时，
            // 补写一行专注记录并清掉陈旧键；未到零 / 休息相位只清键。必须在把连接交给
            // AppState 之前（这里还独占 `conn`），与网关同批 —— 网关不启动时也要恢复。
            if let Err(e) = modules::gateway::runtime::recover_focus(&conn, chrono::Utc::now()) {
                eprintln!("番茄钟运行态恢复失败：{e}");
            }
            app.manage(AppState::new(conn));
            app.manage(crate::state::VoiceHub::new());
            app.manage(crate::state::CampusHub::new());
            // AI 内核：活跃 agent run 的会话表（取消句柄 + 工具结果桥）。
            // 只活在内存（run 结束即移除），但要 manage 成 Arc —— run 任务
            // 结束时要回头把自己从表里摘掉。
            app.manage(std::sync::Arc::new(modules::ai::agent::hub::AgentHub::new()));
            // 在线更新：下载/安装的进程内状态。它不落库（设置走 app_meta），
            // 但必须 manage 进来 —— 下载线程要用它广播进度、缓存已验签的候选。
            app.manage(modules::update::UpdateHub::new());

            // 知识库：状态 + 后台索引线程。
            // 索引线程要读写与应用同一份数据库，所以先完成 db::init（其中的迁移已建好 kb_* 表）
            // 并把状态 manage 进去，再启动线程。
            // 数据目录与 db::init 同源（认 REIN_DATA_DIR 开关）：测试实例的 rein.db、
            // voice_sessions、同步状态必须整袋搬走，不能一半在生产目录里。
            let data_dir = crate::db::data_dir(app.handle())?;
            // 隔离实例的录音播放：tauri.conf.json 的 asset 协议白名单写死了
            // $APPDATA/voice_sessions/*，隔离目录不在其内，录音会被 403 播不出来。
            // 运行时补上这一条 —— 只在隔离时补，不悄悄放宽生产实例的作用域。
            if crate::db::isolated() {
                app.asset_protocol_scope()
                    .allow_directory(data_dir.join("voice_sessions"), true)?;
            }
            let hub = std::sync::Arc::new(modules::kb::worker::KbHub::new(data_dir.clone()));
            hub.start(app.handle().clone());
            app.manage(hub);

            // 抢课：任务单落 SQLite，后台线程按服务器时钟开火。
            // 与知识库同形 —— 先 manage 好状态（其中已含任务表）再启动线程，
            // 而且它必须在 db::init 之后，因为要读写同一份数据库。
            // 带上数据目录：教务拉不到名单时，它要用同一目录里那份落盘名单兜底。
            let grab = std::sync::Arc::new(modules::campus::grab::GrabHub::with_data_dir(
                data_dir.clone(),
            ));
            grab.start(app.handle().clone());
            app.manage(grab);

            // 多设备同步：变更捕获线程（见上面 install_hook 的注释）。
            // 与知识库/抢课同形 —— 先 manage 好状态再启动线程，线程每轮借那把唯一的连接。
            let sync_hub = modules::sync::engine::SyncHub::new(data_dir.clone(), dirty);
            sync_hub.start(app.handle().clone());
            // 对外服务网关：进程内状态（连接会话表 / 待决授权队列 / 变更广播 hub）。
            // 变更广播必须挂在同步已经装好的那把 update_hook 上 —— 网关**绝不**自装第二个钩子
            // （rusqlite 的钩子单槽，再注册会静默顶掉同步捕获，见 sync/engine.rs）。
            let gateway = std::sync::Arc::new(modules::gateway::auth::GatewayHub::new());
            sync_hub.set_feed(std::sync::Arc::clone(&gateway.feed));
            app.manage(sync_hub);
            // 服务默认不启动：只有设置里开过（app_meta `gateway.enabled=1`）才在启动时监听。
            {
                let st = app.state::<AppState>();
                let (on, bind, port) = {
                    let conn = st.db.lock();
                    (
                        modules::gateway::store::get_enabled(&conn),
                        modules::gateway::store::get_bind_mode(&conn),
                        modules::gateway::store::get_port(&conn),
                    )
                };
                if on {
                    if let Err(e) = modules::gateway::server::start(
                        app.handle().clone(),
                        std::sync::Arc::clone(&gateway),
                        bind,
                        port,
                    ) {
                        eprintln!("对外网关启动失败：{e}");
                    }
                }
            }
            app.manage(gateway);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // diet
            modules::diet::commands::list_foods,
            modules::diet::commands::get_food,
            modules::diet::commands::create_food,
            modules::diet::commands::search_foods_fuzzy,
            modules::diet::commands::list_meals,
            modules::diet::commands::list_meals_range,
            modules::diet::commands::log_meal,
            modules::diet::commands::delete_meal,
            modules::diet::commands::recipe_prefs_list,
            modules::diet::commands::recipe_prefs_set,
            modules::diet::commands::recipe_prefs_delete,
            // nutrition
            modules::nutrition::commands::get_daily_summary,
            modules::nutrition::commands::get_targets,
            modules::nutrition::commands::set_targets,
            modules::nutrition::commands::get_profile,
            modules::nutrition::commands::update_profile,
            modules::nutrition::commands::get_calc_state,
            modules::nutrition::commands::save_calc_state,
            modules::nutrition::commands::list_body_metrics,
            modules::nutrition::commands::record_body_metric,
            modules::nutrition::commands::delete_body_metric,
            // todo
            modules::todo::commands::list_todos,
            modules::todo::commands::list_all_todos,
            modules::todo::commands::query_todos,
            modules::todo::commands::query_todo_feed,
            modules::todo::commands::todo_distribution,
            modules::todo::commands::create_todo,
            modules::todo::commands::update_todo,
            modules::todo::commands::delete_todo,
            modules::todo::commands::sync_recurrences,
            // ledger（记账：流水 + 月度预算）
            modules::ledger::commands::list_ledger_entries,
            modules::ledger::commands::create_ledger_entry,
            modules::ledger::commands::update_ledger_entry,
            modules::ledger::commands::delete_ledger_entry,
            modules::ledger::commands::get_ledger_budget,
            modules::ledger::commands::set_ledger_budget,
            // exercise
            modules::exercise::commands::list_workouts,
            modules::exercise::commands::list_all_workouts,
            modules::exercise::commands::create_workout,
            modules::exercise::commands::delete_workout,
            // healthsync（第三方健康数据：Android Health Connect 双向同步运动记录）
            modules::healthsync::commands::health_sync_status,
            modules::healthsync::commands::health_sync_authorize,
            modules::healthsync::commands::health_sync_set_push,
            modules::healthsync::commands::health_sync_start,
            modules::healthsync::commands::health_sync_step,
            modules::healthsync::commands::health_metrics_all,
            modules::healthsync::commands::health_sync_workouts,
            // pomodoro
            modules::pomodoro::commands::save_pomodoro_session,
            modules::pomodoro::commands::list_pomodoro_sessions,
            // session（训练课会话：落盘 + 中断恢复）
            modules::session::commands::session_start,
            modules::session::commands::session_snapshot,
            modules::session::commands::session_active,
            modules::session::commands::session_finish,
            modules::session::commands::session_abort,
            modules::session::commands::session_for_workout,
            modules::session::commands::strength_history,
            modules::session::commands::strength_exercises,
            modules::session::commands::strength_last_weights,
            modules::session::commands::strength_recent_sets,
            // sports/plans/records 见上；这份清单必须与 modules/*/commands.rs 和
            // 前端 src/services/*Service.ts 三处同步（见 docs/ARCHITECTURE.md §3）。
            // plan（训练课程：CRUD + 最近使用）
            modules::plan::commands::list_workout_plans,
            modules::plan::commands::get_workout_plan,
            modules::plan::commands::upsert_workout_plan,
            modules::plan::commands::delete_workout_plan,
            modules::plan::commands::touch_workout_plan,
            modules::plan::commands::plan_seed_status_cmd,
            modules::plan::commands::apply_plan_seed_migrate,
            modules::plan::commands::apply_plan_seed_override,
            modules::plan::commands::apply_plan_seed_keep,
            // exercise_lib（动作库：全部运动动作的唯一真源，0025）
            modules::exercise_lib::commands::list_exercises,
            modules::exercise_lib::commands::get_exercise,
            modules::exercise_lib::commands::upsert_exercise,
            modules::exercise_lib::commands::delete_exercise,
            modules::exercise_lib::commands::restore_exercise,
            modules::exercise_lib::commands::set_exercise_favorite,
            // exercise_lib · 动作详解覆盖层（0048）：内置文案的 AI / 用户改动
            modules::exercise_lib::guide::list_exercise_guides,
            modules::exercise_lib::guide::upsert_exercise_guide,
            modules::exercise_lib::guide::delete_exercise_guide,
            // program（健康方案：持久化 + 单激活 + 日程重排；计算在前端引擎）
            modules::program::commands::program_list,
            modules::program::commands::program_get_active,
            modules::program::commands::program_create,
            modules::program::commands::program_update_params,
            modules::program::commands::program_archive,
            modules::program::commands::program_delete,
            modules::program::commands::program_schedule_replace,
            modules::program::commands::program_meals_get,
            modules::program::commands::program_meals_range,
            modules::program::commands::program_meals_set,
            modules::program::commands::program_meals_clear,
            modules::program::commands::shopping_checks_list,
            modules::program::commands::shopping_check_set,
            modules::program::commands::shopping_checks_clear,
            // tracking（跑步前台保活：Android 锁屏后维持 GPS 与计时）
            modules::tracking::commands::tracking_keepalive,
            modules::tracking::commands::tracking_status,
            // tracking（原生采集：前台服务=运动真源，前端只消费快照）
            modules::tracking::commands::tracking_run_begin,
            modules::tracking::commands::tracking_run_phase,
            modules::tracking::commands::tracking_run_end,
            modules::tracking::commands::tracking_live,
            modules::tracking::commands::tracking_track_take,
            modules::tracking::commands::tracking_notify,
            modules::tracking::commands::tracking_open_pending,
            // float（全局沉浸浮窗：桌面第二窗口 / Android 原生浮层，契约 docs/GLOBAL-FLOAT.md）
            // 三条同步纪律：
            // 1. **命令清单三处同步**：这里 ↔ src/services/floatService.ts ↔ src/mock/server.ts
            //    （`npm run contract` 机器比对；漏一条 = 不可合并）。
            // 2. **全部同步 fn，不许加 async**：Tauri 的同步命令跑在主线程，建窗 / 改尺寸 /
            //    挪位置才安全；改成 async 会被丢到线程池，Win32 窗口操作在非主线程直接 panic。
            // 3. **载荷是字符串，不是 Rust 结构体**：push 原样转发前端拼好的快照 JSON
            //    （桌面 emit_to 事件 / Android JNI update），Rust 不解析业务字段 ——
            //    加一种沉浸会话时这里零改动。
            modules::float::commands::global_float_status,
            modules::float::commands::global_float_open,
            modules::float::commands::global_float_close,
            modules::float::commands::global_float_push,
            modules::float::commands::global_float_latest,
            modules::float::commands::global_float_set_form,
            modules::float::commands::global_float_request_permission,
            modules::float::commands::global_float_take_action,
            // ai
            modules::ai::commands::ai_parse_food_text,
            modules::ai::commands::ai_parse_target_adjust,
            modules::ai::commands::ai_model_list,
            modules::ai::commands::ai_model_add,
            modules::ai::commands::ai_model_update,
            modules::ai::commands::ai_model_delete,
            modules::ai::commands::ai_model_set_default,
            modules::ai::commands::ai_model_save_probe,
            modules::ai::agent::commands::ai_probe,
            modules::ai::agent::commands::ai_agent_run,
            modules::ai::agent::commands::ai_agent_cancel,
            modules::ai::agent::commands::ai_agent_tool_result,
            modules::ai::agent::commands::ai_agent_update_context,
            modules::ai::commands::ai_chat_ensure,
            modules::ai::commands::ai_chat_messages,
            modules::ai::commands::ai_chat_append,
            modules::ai::commands::ai_chat_clear,
            modules::ai::commands::ai_chat_cut,
            modules::ai::commands::ai_chat_list,
            modules::ai::commands::ai_chat_rename,
            modules::ai::commands::ai_chat_search,
            // ai · 在线服务（服务端下发模型 + 服务密钥 + 成本对账）
            modules::ai::online::online_service_settings_get,
            modules::ai::online::online_service_settings_save,
            modules::ai::online::online_service_catalog,
            modules::ai::online::online_service_cached_catalog,
            modules::ai::online::online_service_usage,
            modules::ai::online::online_service_sync,
            // ai · 提供商（适配器注册表 + 账号 + 模型目录）
            modules::ai::providers::ai_provider_adapters,
            modules::ai::providers::ai_provider_list,
            modules::ai::providers::ai_provider_save,
            modules::ai::providers::ai_provider_delete,
            modules::ai::providers::ai_provider_fetch,
            modules::ai::providers::ai_provider_model_add,
            modules::ai::providers::ai_provider_model_remove,
            modules::ai::providers::ai_model_prefs_get,
            modules::ai::providers::ai_model_prefs_save,
            modules::ai::commands::ai_usage_record,
            modules::ai::commands::ai_usage_summary,
            modules::ai::commands::ai_usage_clear,
            // web（AI 联网：搜索/抓页，默认必应）
            modules::web::commands::web_fetch,
            modules::web::commands::web_search,
            // share（分享收件箱：Android 系统分享/打开的文件）
            modules::share::commands::share_poll,
            modules::share::commands::share_read,
            // media（HEIF/HEIC → JPEG：WebView 解不了 HEVC，借系统解码器）
            modules::media::commands::image_decode_heif,
            // sync（多设备同步：设备身份 / 状态 / 配对 / 传输）
            modules::sync::commands::sync_status,
            modules::sync::commands::sync_set_device_name,
            modules::sync::commands::sync_pair_start,
            modules::sync::commands::sync_pair_poll,
            modules::sync::commands::sync_pair_claim,
            modules::sync::commands::sync_run,
            modules::sync::commands::sync_forget,
            // voice（语音对话：豆包 ASR/TTS + 纪要）
            modules::voice::commands::voice_config_get,
            modules::voice::commands::voice_config_save,
            modules::voice::commands::voice_config_status,
            modules::voice::commands::voice_tts_probe,
            modules::voice::commands::voice_asr_probe,
            modules::voice::commands::voice_tts_credential_save,
            modules::voice::commands::voice_asr_start,
            modules::voice::commands::voice_asr_audio,
            modules::voice::commands::voice_asr_finish,
            modules::voice::commands::voice_asr_cancel,
            modules::voice::commands::voice_tts_speak,
            modules::voice::commands::voice_memo_create,
            modules::voice::commands::voice_memo_get,
            modules::voice::commands::voice_memo_list,
            modules::voice::commands::voice_memo_set_summary,
            modules::voice::commands::voice_memo_rename,
            modules::voice::commands::voice_memo_delete,
            modules::voice::commands::voice_draft_save,
            modules::voice::commands::voice_draft_get,
            modules::voice::commands::voice_draft_clear,
            // kb（知识库与认知层：混合检索 + 长期记忆）
            modules::kb::commands::kb_status,
            modules::kb::commands::kb_search,
            modules::kb::commands::kb_read,
            modules::kb::commands::kb_reindex,
            modules::kb::commands::kb_settings_get,
            modules::kb::commands::kb_settings_set,
            modules::kb::commands::kb_probe_embedder,
            modules::kb::commands::kb_rebuild_vectors,
            modules::kb::commands::kb_memories,
            modules::kb::commands::kb_memory_apply,
            modules::kb::commands::kb_memory_delete,
            modules::kb::commands::kb_memory_archive,
            modules::kb::commands::kb_memory_restore,
            modules::kb::commands::kb_memory_maintain,
            modules::kb::commands::kb_memory_stats,
            modules::kb::commands::kb_memory_consolidated,
            modules::kb::commands::kb_cognition,
            modules::kb::commands::kb_memory_bump,
            modules::kb::commands::kb_memory_duplicates,
            modules::kb::commands::kb_memory_diffs,
            modules::kb::commands::kb_glob,
            modules::kb::commands::kb_file_write,
            modules::kb::commands::kb_file_rename,
            modules::kb::commands::kb_file_delete,
            modules::kb::commands::kb_file_get,
            modules::kb::commands::kb_meta_set,
            modules::kb::commands::kb_import_path,
            modules::kb::commands::kb_export_file,
            // kb（AI 虚拟工作区 v2：模态层 + 目录治理 + 全量注入，见 docs/ai-workspace.md）
            modules::kb::commands::kb_media_write,
            modules::kb::commands::kb_media_get,
            modules::kb::commands::kb_fs_move,
            modules::kb::commands::kb_fs_mkdir,
            modules::kb::commands::kb_fs_pin,
            modules::kb::commands::kb_fs_moves,
            modules::kb::commands::kb_fs_undo,
            modules::kb::commands::kb_injection_get,
            // kb（文件管理器：一层目录列举 + 回收站）
            modules::kb::commands::kb_list_dir,
            modules::kb::commands::kb_trash,
            modules::kb::commands::kb_trash_list,
            modules::kb::commands::kb_trash_restore,
            modules::kb::commands::kb_trash_purge,
            modules::kb::commands::kb_trash_empty,
            // kb（压缩包：打开 / 解压）
            modules::kb::commands::kb_archive_list,
            modules::kb::commands::kb_archive_extract,
            // kb（空间管理：占用总览 + 孤儿清理）
            modules::kb::commands::kb_usage,
            modules::kb::commands::kb_usage_clean,
            // kb（本地嵌入模型：多档可选 + 按需下载 + 自定义测试）
            modules::kb::commands::kb_embed_models,
            modules::kb::commands::kb_embed_model_download,
            modules::kb::commands::kb_embed_model_cancel,
            modules::kb::commands::kb_embed_model_remove,
            modules::kb::commands::kb_embed_test,
            // campus（校园教务：学校系统选择器 + 课表同步 + 培养方案）
            modules::campus::commands::campus_systems,
            modules::campus::commands::campus_account_get,
            modules::campus::commands::campus_captcha,
            modules::campus::commands::campus_login,
            modules::campus::commands::campus_session_probe,
            modules::campus::commands::campus_logout,
            modules::campus::commands::campus_account_delete,
            modules::campus::commands::campus_semesters,
            modules::campus::commands::campus_set_current_semester,
            modules::campus::commands::campus_sync,
            modules::campus::commands::campus_schedule,
            modules::campus::commands::campus_program,
            modules::campus::commands::campus_course_detail,
            // campus（官方调休映射：放假日打「假」标、补班日补被吃掉那天的课）
            modules::campus::commands::campus_holiday_config_get,
            modules::campus::commands::campus_holiday_config_set,
            // campus（选课：令牌走 EAMS 会话换取的 SSO JWT）
            modules::campus::commands::campus_lesson_search_probe,
            modules::campus::commands::campus_lesson_search,
            modules::campus::commands::campus_course_select_status,
            modules::campus::commands::campus_course_select_lessons,
            modules::campus::commands::campus_course_select_simplest_lessons,
            modules::campus::commands::campus_course_select_query_condition,
            modules::campus::commands::campus_course_select_apply,
            modules::campus::commands::campus_course_select_predicate,
            modules::campus::commands::campus_course_select_result,
            modules::campus::commands::campus_course_select_predicate_result,
            modules::campus::commands::campus_course_select_drop,
            // campus（自动抢课：任务单 + 后台引擎）
            modules::campus::commands::campus_grab_state,
            modules::campus::commands::campus_grab_set_enabled,
            modules::campus::commands::campus_grab_enqueue,
            modules::campus::commands::campus_grab_task_action,
            modules::campus::commands::campus_grab_clear_finished,
            modules::campus::commands::campus_grab_pause_all,
            modules::campus::commands::campus_grab_resume_all,
            modules::campus::commands::campus_grab_settings_get,
            modules::campus::commands::campus_grab_settings_set,
            // campus（抢课计划：提前写下「想抢什么」，引擎到点自己解析 + 开抢）
            modules::campus::commands::campus_grab_intent_add,
            modules::campus::commands::campus_grab_intent_action,
            modules::campus::commands::campus_grab_intent_preview,
            modules::campus::commands::campus_grab_preflight,
            // campus（救援面：AI 的最后补救 —— 现场快照 / 带会话的任意请求 / 导出可重放脚本）
            modules::campus::commands::campus_rescue_state,
            modules::campus::commands::campus_http,
            modules::campus::commands::campus_rescue_note,
            modules::campus::commands::campus_curl_export,
            // update（在线更新：多源清单 + 清单/安装包双验签 + 断点续传 + 平台安装）
            modules::update::commands::update_status,
            modules::update::commands::update_settings_set,
            modules::update::commands::update_check,
            modules::update::commands::update_download,
            modules::update::commands::update_cancel,
            modules::update::commands::update_discard,
            modules::update::commands::update_install,
            modules::update::commands::update_progress,
            modules::update::commands::update_prune_cache,
            // maintenance（数据维护：分层清除软件数据）
            modules::maintenance::commands::data_clear_preview,
            modules::maintenance::commands::data_clear,
            modules::maintenance::commands::data_app_restart,
            // online（Rein 在线服务：更新分发之外的在线能力探测；模型网关为预留接口）
            modules::update::online::online_service_status,
            // gateway（对外服务网关的管理面：开关 / 绑定 / 状态 / 授权裁决 / 撤销 /
            // 网页来源白名单 / 最近审计）
            modules::gateway::commands::gateway_status,
            modules::gateway::commands::gateway_set_enabled,
            modules::gateway::commands::gateway_set_bind,
            modules::gateway::commands::gateway_set_enabled_modules,
            modules::gateway::commands::gateway_authorization_pending,
            modules::gateway::commands::gateway_authorization_respond,
            modules::gateway::commands::gateway_revoke_client,
            modules::gateway::commands::gateway_set_allowed_origins,
            modules::gateway::commands::gateway_audit_recent,
            // 运行态上报（前端 → 后端：番茄钟快照写 app_meta；contract §14.1）
            modules::gateway::commands::focus_publish,
            modules::gateway::commands::focus_unpublish,
        ])
        .run(tauri::generate_context!())
        .expect("Rein 启动失败");
}
