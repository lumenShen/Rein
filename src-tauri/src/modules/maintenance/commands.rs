//! 清除软件数据：四档深度 + preview（先看清单）/ clear（真删）/ restart（清完重启）。
//!
//! 为什么 preview 和 clear 必须共用同一份分组定义：这层的每个按钮都不可撤销，
//! 「确认页上看到的清单」与「真正被删的东西」若由两段独立代码拼出，迟早各说各话。
//! 所以分组（[`ClearGroup`]）是唯一的静态真源：预览按它数行数、量字节，执行按它删。
//!
//! 清空后为什么能「重启即恢复内置内容」：种子（`seed_foods` / `seed_builtin_plans` /
//! `seed_exercises`）是按 name/id 的 `INSERT OR IGNORE`，每次启动都跑一遍——
//! 表被清空只会让它们重新补齐内置行，用户自建内容则真的没了。

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::{ReinError, Result};
use crate::state::AppState;

/// 清除档位，由浅入深。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClearScope {
    /// 缓存文件：更新安装包 + 嵌入模型（都可重新获得），纯磁盘操作，清完无感。
    Cache,
    /// AI 数据：聊天、长期记忆、用量统计、语音纪要（含录音文件）。
    Ai,
    /// 业务数据：饮食/训练/待办/记账/身体/方案/校园。AI 配置与密钥保留。
    Business,
    /// 恢复出厂：整库清空 + 数据目录里除数据库本件外全部清掉，然后重启。
    Factory,
}

impl ClearScope {
    fn parse(raw: &str) -> Result<Self> {
        match raw {
            "cache" => Ok(Self::Cache),
            "ai" => Ok(Self::Ai),
            "business" => Ok(Self::Business),
            "factory" => Ok(Self::Factory),
            other => Err(ReinError::coded(
                "bad_scope",
                format!("未知的清除档位：{other}"),
            )),
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::Cache => "cache",
            Self::Ai => "ai",
            Self::Business => "business",
            Self::Factory => "factory",
        }
    }

    /// 这档清完是否建议重启：缓存档无感不必重启；其余档重启以甩掉前端 store、
    /// KB 线程内存态、抢课名单缓存等所有「还记着旧数据的人」。
    fn restarts_app(self) -> bool {
        !matches!(self, Self::Cache)
    }
}

/// 一组同类的清除目标：几张表 + 几个数据目录，一起数行数、算字节、一起删。
struct ClearGroup {
    label: &'static str,
    tables: &'static [&'static str],
    dirs: &'static [&'static str],
}

/// 缓存文件：只动磁盘。不动 `kb_docs/kb_vectors` 这类索引表——它们**不是**无中生有
/// 的缓存：清空后要等下一次业务变更的 dirty 事件或手动「重建索引」才会长回来，
/// 中间 AI 检索会静默变空。索引的回收交给空间总览页的碎片回收，不归这层管。
const CACHE_GROUPS: &[ClearGroup] = &[
    ClearGroup {
        label: "更新安装包缓存",
        tables: &[],
        dirs: &["updates"],
    },
    ClearGroup {
        label: "嵌入模型文件（需要时重新下载）",
        tables: &[],
        dirs: &["models"],
    },
];

const AI_GROUPS: &[ClearGroup] = &[
    ClearGroup {
        label: "AI 聊天会话",
        tables: &["ai_chats", "ai_chat_messages"],
        dirs: &[],
    },
    ClearGroup {
        label: "AI 长期记忆",
        tables: &["kb_memories", "kb_memory_diffs"],
        dirs: &[],
    },
    ClearGroup {
        label: "AI 用量统计",
        tables: &["ai_usage"],
        dirs: &[],
    },
    ClearGroup {
        label: "语音纪要与录音",
        tables: &["voice_memos"],
        dirs: &["voice_sessions"],
    },
];

const BUSINESS_GROUPS: &[ClearGroup] = &[
    ClearGroup {
        label: "饮食记录与食物库",
        tables: &["meal_logs", "foods", "food_units"],
        dirs: &[],
    },
    ClearGroup {
        label: "训练记录与逐组数据",
        tables: &["workouts", "workout_sets", "workout_sessions"],
        dirs: &[],
    },
    ClearGroup {
        label: "训练课程（内置课重启后自动补回）",
        tables: &["workout_plans"],
        dirs: &[],
    },
    ClearGroup {
        label: "动作库（内置动作重启后自动补回）",
        tables: &["exercises"],
        dirs: &[],
    },
    ClearGroup {
        label: "待办",
        tables: &["todos"],
        dirs: &[],
    },
    ClearGroup {
        label: "记账流水与预算",
        tables: &["ledger_entries", "ledger_settings"],
        dirs: &[],
    },
    ClearGroup {
        label: "身体指标与目标参数",
        tables: &["body_metrics", "profile", "calc_params"],
        dirs: &[],
    },
    ClearGroup {
        label: "第三方健康数据镜像",
        tables: &["health_metrics", "health_sync_tombstones"],
        dirs: &[],
    },
    ClearGroup {
        label: "健康方案、菜单与采购勾选",
        tables: &["programs", "program_meals", "recipe_prefs", "shopping_checks"],
        dirs: &[],
    },
    ClearGroup {
        label: "番茄钟记录",
        tables: &["pomodoro_sessions"],
        dirs: &[],
    },
    ClearGroup {
        label: "校园课表、抢课任务与选课记录",
        tables: &[
            "campus_accounts",
            "campus_semesters",
            "campus_courses",
            "campus_sessions",
            "campus_period_slots",
            "campus_grab_tasks",
            "campus_grab_intents",
            "campus_ai_actions",
        ],
        dirs: &[],
    },
];

/// 恢复出厂的**展示分组**。执行时不按这份清单删表，而是动态枚举全库用户表
/// （见 `clear_impl`）——迁移往后加表时执行自动跟上；展示清单忘了更新顶多少报
/// 一类，不会「说没删的删了」。数据目录同理：除数据库本件外全清。
const FACTORY_GROUPS: &[ClearGroup] = &[
    ClearGroup {
        label: "全部业务数据（同「业务与健康数据」档）",
        tables: &[
            "meal_logs",
            "foods",
            "food_units",
            "workouts",
            "workout_sets",
            "workout_sessions",
            "workout_plans",
            "exercises",
            "todos",
            "ledger_entries",
            "ledger_settings",
            "body_metrics",
            "profile",
            "calc_params",
            "health_metrics",
            "health_sync_tombstones",
            "programs",
            "program_meals",
            "recipe_prefs",
            "shopping_checks",
            "pomodoro_sessions",
            "campus_accounts",
            "campus_semesters",
            "campus_courses",
            "campus_sessions",
            "campus_period_slots",
            "campus_grab_tasks",
            "campus_grab_intents",
            "campus_ai_actions",
        ],
        dirs: &[],
    },
    ClearGroup {
        label: "AI 聊天、长期记忆与语音纪要（含录音）",
        tables: &[
            "ai_chats",
            "ai_chat_messages",
            "kb_memories",
            "kb_memory_diffs",
            "ai_usage",
            "voice_memos",
        ],
        dirs: &["voice_sessions"],
    },
    ClearGroup {
        label: "AI 配置：模型、提供商与密钥",
        tables: &["ai_models", "ai_providers", "ai_provider_models"],
        dirs: &[],
    },
    ClearGroup {
        label: "外部访问：已授权客户端与调用审计",
        tables: &["ext_clients", "ext_audit"],
        dirs: &[],
    },
    ClearGroup {
        label: "AI 工作区文件与知识库索引",
        tables: &[
            "kb_files",
            "kb_assets",
            "kb_fs_moves",
            "kb_docs",
            "kb_chunks",
            "kb_vectors",
            "kb_dirty",
            "kb_settings",
        ],
        dirs: &["workspace"],
    },
    ClearGroup {
        label: "多设备同步：配对、设备身份与对账数据",
        tables: &[
            "sync_meta",
            "sync_objects",
            "sync_map",
            "sync_log",
            "sync_peers",
            "sync_conflicts",
            "sync_blobs",
        ],
        dirs: &[],
    },
    ClearGroup {
        label: "应用设置与凭据（语音凭据、更新设置等）",
        tables: &["app_meta"],
        dirs: &[],
    },
    ClearGroup {
        label: "更新安装包与嵌入模型缓存",
        tables: &[],
        dirs: &["updates", "models"],
    },
    ClearGroup {
        label: "教务救援导出脚本",
        tables: &[],
        dirs: &["rescue"],
    },
];

fn groups(scope: ClearScope) -> &'static [ClearGroup] {
    match scope {
        ClearScope::Cache => CACHE_GROUPS,
        ClearScope::Ai => AI_GROUPS,
        ClearScope::Business => BUSINESS_GROUPS,
        ClearScope::Factory => FACTORY_GROUPS,
    }
}

// ---------- IPC 形态 ----------
// 字段名是前端 service 的契约（camelCase），与 update::InstallResult 同一条纪律，
// 末尾的契约测试守着：改字段名必先改前端 types/maintenance.ts。

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearPreviewItem {
    /// 档位内稳定键（前端 testid 用）：`<档位>-<组序号>`
    pub key: String,
    pub label: &'static str,
    /// 组内全部表的行数和；纯磁盘组为 null
    pub count: Option<u64>,
    /// 组内全部目录的字节和；纯表组为 null
    pub bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataClearPreview {
    pub scope: ClearScope,
    pub items: Vec<ClearPreviewItem>,
    pub total_bytes: u64,
    pub restarts_app: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataClearReport {
    pub scope: ClearScope,
    pub freed_bytes: u64,
    pub removed_tables: Vec<String>,
    pub removed_dirs: Vec<String>,
    /// 没删掉的（文件正被占用等）：数据完整性不受影响，但要把话说明白
    pub failures: Vec<String>,
}

// ---------- 命令 ----------

/// 清除预览：每组的行数与字节。只读，给确认页当「你将要失去什么」的清单。
#[tauri::command]
pub fn data_clear_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    scope: String,
) -> Result<DataClearPreview> {
    let scope = ClearScope::parse(&scope)?;
    let dir = crate::db::data_dir(&app)?;
    let conn = state.db.lock();
    let items = preview_items(&conn, scope, &dir)?;
    let total_bytes = items.iter().filter_map(|i| i.bytes).sum();
    Ok(DataClearPreview {
        scope,
        items,
        total_bytes,
        restarts_app: scope.restarts_app(),
    })
}

/// 执行清除。表清空走一个事务（中途失败整体回滚）；目录删除尽力而为、
/// 失败逐条报告；最后 checkpoint + VACUUM 把文件缩回去。
#[tauri::command]
pub fn data_clear(
    app: AppHandle,
    state: State<'_, AppState>,
    scope: String,
) -> Result<DataClearReport> {
    let scope = ClearScope::parse(&scope)?;
    // 缓存档会删掉整个 updates/：有安装包正在下载时删了等于拆人家一半
    if matches!(scope, ClearScope::Cache) {
        let hub = app.state::<crate::modules::update::UpdateHub>();
        if hub.is_busy() {
            return Err(ReinError::Message(
                "正在下载更新，等下载完成（或取消）后再清缓存".into(),
            ));
        }
    }

    let conn = state.db.lock();
    clear_impl(&app, &conn, scope)
}

/// 清除完成后的重启（恢复出厂/深层清除的收尾）。前端等报告 toast 完再调。
/// 与 update_install 同一条时序纪律：先让 IPC 回包，再退进程。
#[tauri::command]
pub fn data_app_restart(app: AppHandle) {
    app.restart();
}

// ---------- 实现 ----------

fn preview_items(
    conn: &Connection,
    scope: ClearScope,
    data_dir: &std::path::Path,
) -> Result<Vec<ClearPreviewItem>> {
    let mut items = Vec::new();
    for (idx, group) in groups(scope).iter().enumerate() {
        let count = if group.tables.is_empty() {
            None
        } else {
            let mut rows = 0u64;
            for t in group.tables {
                let n: i64 =
                    conn.query_row(&format!("SELECT COUNT(*) FROM \"{t}\""), [], |r| r.get(0))?;
                rows += n.max(0) as u64;
            }
            Some(rows)
        };
        let bytes = if group.dirs.is_empty() {
            None
        } else {
            Some(
                group
                    .dirs
                    .iter()
                    .map(|d| path_bytes(&data_dir.join(d)))
                    .sum(),
            )
        };
        items.push(ClearPreviewItem {
            key: format!("{}-{idx}", scope.key()),
            label: group.label,
            count,
            bytes,
        });
    }
    Ok(items)
}

fn clear_impl(app: &AppHandle, conn: &Connection, scope: ClearScope) -> Result<DataClearReport> {
    let dir = crate::db::data_dir(app)?;
    let db_bytes_before = db_files_bytes(&dir);

    // 1) 表清空：一个事务，任何一张表失败整体回滚——「清一半」比「没清」糟得多。
    //    factory 档不按静态清单，动态枚举全库用户表（迁移往后加表自动跟上）。
    let removed_tables = match scope {
        ClearScope::Factory => {
            let plan = collect_clear_plan(conn)?;
            clear_tables(conn, &plan)?
        }
        _ => {
            let plan: Vec<ClearTarget> = groups(scope)
                .iter()
                .flat_map(|g| g.tables.iter().copied())
                .map(ClearTarget::table)
                .collect();
            clear_tables(conn, &plan)?
        }
    };

    // 2) 磁盘：分档各自的目标；factory 是「除数据库本件外全清」，
    //    比静态清单更彻底（根目录里的名单缓存、救援脚本等散件也跑不掉）
    let mut removed_dirs = Vec::new();
    let mut failures = Vec::new();
    let mut dirs_bytes = 0u64;
    match scope {
        ClearScope::Factory => {
            for entry in std::fs::read_dir(&dir)?.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if is_db_file(&name) {
                    continue;
                }
                let bytes = path_bytes(&entry.path());
                match remove_path(&entry.path()) {
                    Ok(()) => {
                        dirs_bytes += bytes;
                        removed_dirs.push(name);
                    }
                    Err(e) => failures.push(format!("{name}：{e}")),
                }
            }
        }
        _ => {
            for group in groups(scope) {
                for d in group.dirs {
                    let path = dir.join(d);
                    if !path.exists() {
                        continue;
                    }
                    let bytes = path_bytes(&path);
                    match remove_path(&path) {
                        Ok(()) => {
                            dirs_bytes += bytes;
                            removed_dirs.push((*d).to_string());
                        }
                        Err(e) => failures.push(format!("{d}：{e}")),
                    }
                }
            }
        }
    }

    // 3) 回收空间：checkpoint 把 WAL 收进主库，VACUUM 把空洞还给出卷。
    //    失败不致命（数据已经删了，只是文件没缩），不值得为它报错。
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
    let db_bytes_after = db_files_bytes(&dir);
    let freed_bytes = dirs_bytes + db_bytes_before.saturating_sub(db_bytes_after);

    Ok(DataClearReport {
        scope,
        freed_bytes,
        removed_tables,
        removed_dirs,
        failures,
    })
}

/// 一张待清空的目标：普通表走 `DELETE FROM`，虚拟表（FTS5）走专用清空命令。
#[derive(Debug)]
enum ClearTarget {
    Table(String),
    /// `INSERT INTO <fts>(<fts>) VALUES('delete-all')`：external-content FTS5
    /// 不能逐行 DELETE（内容真身在宿主表里），官方清空命令一次抹掉整个索引。
    Fts(String),
}

impl ClearTarget {
    fn table(name: &str) -> Self {
        Self::Table(name.to_string())
    }
}

/// factory 档的全库清空计划：普通表 + 虚拟表（shadow 表随宿主一起清，不单列）。
fn collect_clear_plan(conn: &Connection) -> Result<Vec<ClearTarget>> {
    let mut stmt = conn.prepare(
        "SELECT name, sql FROM sqlite_master \
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let virtuals: Vec<&str> = rows
        .iter()
        .filter(|(_, sql)| sql.starts_with("CREATE VIRTUAL"))
        .map(|(name, _)| name.as_str())
        .collect();

    let mut plan = Vec::new();
    for (name, sql) in &rows {
        if sql.starts_with("CREATE VIRTUAL") {
            // 目前全库只有 FTS5 一族；万一将来出现别的虚拟表，先按 FTS5 试，
            // 不行再退化成普通 DELETE（报错留给事务回滚兜底）
            let target = if name.ends_with("_fts") {
                ClearTarget::Fts(name.clone())
            } else {
                ClearTarget::Table(name.clone())
            };
            plan.push(target);
        } else if virtuals
            .iter()
            .any(|v| name.starts_with(&format!("{v}_")))
        {
            continue; // shadow 表（kb_fts_data 等）随宿主虚拟表一起清
        } else {
            plan.push(ClearTarget::Table(name.clone()));
        }
    }
    Ok(plan)
}

/// 把给定目标逐一清空。一个事务包到底：任何一张表失败，整次清除回滚。
///
/// 清空期间关掉外键（结束即恢复）：全表清空时父子表的删除顺序没法保证先子后父
/// （foods 先于引用它的 meal_logs 被 DELETE 就会撞约束），而这份动作本来就是
/// 「整库皆空」，约束在半途没有意义。sqlite_master 的建表顺序恰好是父表在前，
/// 按它删必炸——这是生产路径会真撞的坑，不是测试假象。
fn clear_tables(conn: &Connection, plan: &[ClearTarget]) -> Result<Vec<String>> {
    // PRAGMA foreign_keys 在事务内是 no-op，必须设在 BEGIN 之前
    conn.execute_batch("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;")?;
    let mut done = Vec::with_capacity(plan.len());
    let failure = plan.iter().find_map(|t| {
        match t {
            ClearTarget::Table(name) => conn
                .execute(&format!("DELETE FROM \"{name}\""), [])
                .map(|_| ())
                .err()
                .map(|e| (name.clone(), e)),
            ClearTarget::Fts(name) => conn
                .execute(
                    &format!("INSERT INTO \"{name}\"(\"{name}\") VALUES('delete-all')"),
                    [],
                )
                .map(|_| ())
                .err()
                .map(|e| (name.clone(), e)),
        }
    });
    // 两条出口都要把外键开关还原（连接是全局共享的，不能留下脏开关）
    match failure {
        Some((name, e)) => {
            let _ = conn.execute_batch("ROLLBACK; PRAGMA foreign_keys=ON;");
            Err(ReinError::Message(format!("清除表 {name} 失败：{e}")))
        }
        None => {
            conn.execute_batch("COMMIT; PRAGMA foreign_keys=ON;")?;
            done.extend(plan.iter().map(|t| match t {
                ClearTarget::Table(name) | ClearTarget::Fts(name) => name.clone(),
            }));
            Ok(done)
        }
    }
}

/// 数据库本件（主库 + WAL + SHM）：factory 清目录时唯一要留的东西。
fn is_db_file(name: &str) -> bool {
    name == "rein.db" || name == "rein.db-wal" || name == "rein.db-shm"
}

fn db_files_bytes(dir: &std::path::Path) -> u64 {
    ["rein.db", "rein.db-wal", "rein.db-shm"]
        .iter()
        .map(|n| dir.join(n))
        .filter_map(|p| std::fs::metadata(p).ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

fn path_bytes(path: &std::path::Path) -> u64 {
    if path.is_file() {
        return std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            total += path_bytes(&entry.path());
        }
    }
    total
}

fn remove_path(path: &std::path::Path) -> std::result::Result<(), String> {
    let result = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    result.map_err(|e| {
        // 正被占用的文件（嵌入模型 mmap、下载中的包）在 Windows 上删不动——如实报告
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            "文件正被占用，未能删除".to_string()
        } else {
            format!("{e}")
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn todo_row(conn: &Connection) {
        conn.execute("INSERT INTO todos (title, created_at) VALUES ('x','2026-01-01')", [])
            .unwrap();
    }

    fn model_row(conn: &Connection) {
        conn.execute(
            "INSERT INTO ai_models (name, base_url, api_key, model_id, created_at, updated_at) \
             VALUES ('k','http://x','sk','gpt','2026-01-01','2026-01-01')",
            [],
        )
        .unwrap();
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |r| r.get(0))
            .unwrap()
    }

    /// 迁移全跑完后，四档清单里出现的每一张表都必须真实存在——
    /// 这条测试抓的是「清单里手滑写错表名」：运行时 DELETE 会炸，但炸在用户点了清除之后。
    #[test]
    fn every_listed_table_exists() {
        let conn = db();
        for (scope, gs) in [
            (ClearScope::Cache, CACHE_GROUPS),
            (ClearScope::Ai, AI_GROUPS),
            (ClearScope::Business, BUSINESS_GROUPS),
            (ClearScope::Factory, FACTORY_GROUPS),
        ] {
            for g in gs {
                for t in g.tables {
                    let exists: i64 = conn
                        .query_row(
                            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                            [t],
                            |r| r.get(0),
                        )
                        .unwrap();
                    assert_eq!(exists, 1, "{scope:?} 档的「{}」列出了不存在的表 {t}", g.label);
                }
            }
        }
    }

    /// factory 展示分组必须覆盖全部用户表（shadow 表除外）——
    /// 执行端靠动态枚举保证「删干净」，这条测试保证**确认页**没漏报任何一类数据。
    #[test]
    fn factory_groups_cover_all_user_tables() {
        let conn = db();
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master \
                 WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'",
            )
            .unwrap();
        let all: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        let mut listed: Vec<&str> = FACTORY_GROUPS
            .iter()
            .flat_map(|g| g.tables.iter().copied())
            .collect();
        listed.sort_unstable();
        for t in all {
            // kb_fts 是 external-content 虚拟表（内容真身在 kb_chunks），shadow 表随宿主走，
            // 都不必在展示清单里单列——kb_docs/kb_chunks 那一组代表它们
            if t == "kb_fts" || t.starts_with("kb_fts_") {
                continue;
            }
            assert!(
                listed.binary_search(&t.as_str()).is_ok(),
                "确认页没把表 {t} 归进任何一类——用户看不到它会被删"
            );
        }
    }

    #[test]
    fn business_scope_spares_ai_and_config() {
        let conn = db();
        todo_row(&conn);
        model_row(&conn);
        conn.execute(
            "INSERT INTO ai_chats (id, title, created_at, updated_at) VALUES ('c1','chat','2026-01-01','2026-01-01')",
            [],
        )
        .unwrap();

        let plan: Vec<ClearTarget> = BUSINESS_GROUPS
            .iter()
            .flat_map(|g| g.tables.iter().copied())
            .map(ClearTarget::table)
            .collect();
        clear_tables(&conn, &plan).unwrap();

        assert_eq!(count(&conn, "todos"), 0, "业务表应清空");
        assert_eq!(count(&conn, "ai_chats"), 1, "业务档不该动 AI 聊天");
        assert_eq!(count(&conn, "ai_models"), 1, "业务档不该动模型配置与密钥");
    }

    #[test]
    fn factory_scope_empties_everything_but_keeps_schema() {
        let conn = db();
        todo_row(&conn);
        model_row(&conn);
        conn.execute("INSERT INTO app_meta (key, value) VALUES ('k','v')", []).unwrap();
        conn.execute(
            "INSERT INTO kb_files (path, content, created_at, updated_at) VALUES ('a.md','x','2026-01-01','2026-01-01')",
            [],
        )
        .unwrap();
        // kb_docs + kb_chunks 行会经触发器点亮 FTS 索引——顺带验证 delete-all 真把索引抹了
        conn.execute(
            "INSERT INTO kb_docs (source_type, source_id, title, content_hash, updated_at) \
             VALUES ('todo','t1','t','h','2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO kb_chunks (doc_id, ord, text) VALUES (1, 0, 'hello world')",
            [],
        )
        .unwrap();
        let fts_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM kb_fts_data", [], |r| r.get(0))
            .unwrap();
        assert!(fts_rows > 0, "前置条件：FTS 索引确实有内容");

        let plan = collect_clear_plan(&conn).unwrap();
        clear_tables(&conn, &plan).unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master \
                 WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'",
            )
            .unwrap();
        let all: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for t in all {
            // FTS5 shadow 表不按行数断言：delete-all 之后 %_data 里仍会留索引结构
            // 记录（空索引的内务，不是数据）——索引是否真被清空用 docsize（每条
            // 被索引文档一行）判，在下面的专项断言里
            if t.starts_with("kb_fts_") {
                continue;
            }
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM \"{t}\""), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "恢复出厂后 {t} 应为空");
        }
        // FTS 索引真的空了：docsize 一行 = 一条被索引文档
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM kb_fts_docsize", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "FTS 索引应被 delete-all 清空");
        // 迁移账本必须活着：重启后补种子、不重跑迁移
        assert!(count(&conn, "schema_migrations") > 0, "schema_migrations 不能被清");
    }

    #[test]
    fn partial_failure_rolls_back_all_tables() {
        let conn = db();
        todo_row(&conn);
        let plan = vec![
            ClearTarget::table("todos"),
            ClearTarget::table("不存在的表"), // 中途必炸
        ];
        assert!(clear_tables(&conn, &plan).is_err(), "坏表名应让整次清除失败");
        assert_eq!(count(&conn, "todos"), 1, "失败必须整体回滚：todos 原样保留");
    }

    /// 磁盘清理：目录整个移走、数据库本件保留。
    #[test]
    fn factory_disk_wipe_keeps_only_db_files() {
        let dir = std::env::temp_dir().join(format!("rein-maint-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("workspace/media")).unwrap();
        std::fs::write(dir.join("workspace/media/a.bin"), vec![0u8; 10]).unwrap();
        std::fs::write(dir.join("campus_lessons.json"), b"{}").unwrap();
        std::fs::write(dir.join("rein.db"), vec![0u8; 100]).unwrap();

        let mut removed = Vec::new();
        let mut freed = 0u64;
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_db_file(&name) {
                continue;
            }
            let bytes = path_bytes(&entry.path());
            remove_path(&entry.path()).unwrap();
            freed += bytes;
            removed.push(name);
        }
        assert_eq!(removed.len(), 2, "workspace/ 与 campus_lessons.json 都应清掉");
        assert_eq!(freed, 12, "释放字节 = 目录内容(10) + 根文件(2)，数据库本件不算");
        assert!(dir.join("rein.db").exists(), "数据库本件必须保留");
        assert!(!dir.join("workspace").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 前端契约：字段名 camelCase（与 update::InstallResult 同一条测试纪律）。
    #[test]
    fn report_and_preview_serialize_camel_case() {
        let report = serde_json::to_string(&DataClearReport {
            scope: ClearScope::Cache,
            freed_bytes: 1,
            removed_tables: vec![],
            removed_dirs: vec![],
            failures: vec![],
        })
        .unwrap();
        assert!(report.contains("\"freedBytes\""), "{report}");
        assert!(report.contains("\"removedTables\""), "{report}");
        assert!(report.contains("\"removedDirs\""), "{report}");
        assert!(report.contains("\"scope\":\"cache\""), "{report}");

        let preview = serde_json::to_string(&DataClearPreview {
            scope: ClearScope::Business,
            items: vec![ClearPreviewItem {
                key: "business-0".into(),
                label: "待办",
                count: Some(3),
                bytes: None,
            }],
            total_bytes: 0,
            restarts_app: true,
        })
        .unwrap();
        assert!(preview.contains("\"totalBytes\""), "{preview}");
        assert!(preview.contains("\"restartsApp\""), "{preview}");
    }

    #[test]
    fn scope_parse_rejects_unknown() {
        assert!(ClearScope::parse("nope").is_err());
        assert_eq!(ClearScope::parse("cache").unwrap(), ClearScope::Cache);
        assert_eq!(ClearScope::parse("factory").unwrap(), ClearScope::Factory);
    }
}
