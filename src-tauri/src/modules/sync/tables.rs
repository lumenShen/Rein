//! 参与同步的表：**一张表在这里登记了才会被同步**（白名单，不是黑名单 ——
//! 将来新增业务表不会因为「忘了排除」而悄悄把凭证传到别的设备上去）。
//!
//! 每个登记项要说清四件事：
//! - **主键形态**：自增整数（本地 id 只在本地有效，靠 `sync_map` 换 uuid）、
//!   文本 id（本身就是身份，直接当 uuid 用）、单行表（`profile` 这类 `id = 1`）；
//! - **引用**：整数外键要换成对端认得的东西（目标的 uuid）；指向**不同步**的表时
//!   （如 `todos.course_session_id` 指向校园课次）一律丢弃 —— 对端没有那行，
//!   留着就是个悬空 id；
//! - **业务唯一键**：两台设备各自新建了「同一条逻辑记录」（同一天的体重、同名的自建食物、
//!   同路径的知识库文件）时，靠它并成一条，而不是插入两条撞 UNIQUE；
//! - **大字段**：内联 base64 / data URL / 落盘音频，走 blob 通道（见 `media`）。

/// 主键形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pk {
    /// `id INTEGER PRIMARY KEY AUTOINCREMENT`：本地 id 换 uuid
    Local,
    /// 文本主键：id 本身就是跨设备身份
    Text(&'static str),
    /// 单行表（`id INTEGER PRIMARY KEY CHECK (id = 1)`）：整表一条对象
    Singleton,
}

/// 大字段的处理方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Media {
    /// 纯 base64 文本列（聊天图片）
    Base64,
    /// 可能是 data URL 也可能是裸 base64 的列（知识库资源引用）
    DataUrl,
    /// JSON 列，值里散着 base64 / data URL（消息 payload、待办附件）
    Json,
    /// 落盘音频文件的路径列（语音纪要的 wav）
    Wav,
}

/// 一个整数外键列 → 目标表。`target = None` 表示目标不同步，值一律丢弃。
#[derive(Debug, Clone, Copy)]
pub struct Ref {
    pub column: &'static str,
    pub target: Option<&'static str>,
}

/// 表登记项。
#[derive(Debug, Clone, Copy)]
pub struct TableSpec {
    pub name: &'static str,
    pub pk: Pk,
    /// 应用顺序（小的先应用）：外键指向的表必须排在前面
    pub order: u8,
    pub refs: &'static [Ref],
    /// 业务唯一键列：应用时先按它找本地行，找到就当成同一个对象（而不是插入）
    pub natural: Option<&'static str>,
    pub media: &'static [(&'static str, Media)],
    /// 不进对象的列（凭证、派生）
    pub skip: &'static [&'static str],
    /// 只同步满足该条件的行（如 `foods` 只同步自建的）
    pub filter: Option<&'static str>,
}

/// 登记项构造器：参数与 `TableSpec` 字段一一对应，刻意平铺 —— 一张表因此能写成一行。
#[allow(clippy::too_many_arguments)]
const fn t(
    name: &'static str,
    pk: Pk,
    order: u8,
    refs: &'static [Ref],
    natural: Option<&'static str>,
    media: &'static [(&'static str, Media)],
    skip: &'static [&'static str],
    filter: Option<&'static str>,
) -> TableSpec {
    TableSpec {
        name,
        pk,
        order,
        refs,
        natural,
        media,
        skip,
        filter,
    }
}

/// 登记表清单。顺序按 `order` 排（同 order 之间没有依赖）。
pub const TABLES: &[TableSpec] = &[
    // ---- 单行设置类：整表一条对象，两端 LWW 收敛 ----
    t("profile", Pk::Singleton, 0, &[], None, &[], &[], None),
    t("calc_params", Pk::Singleton, 0, &[], None, &[], &[], None),
    t("ledger_settings", Pk::Singleton, 0, &[], None, &[], &[], None),
    // ---- 无依赖的实体 ----
    // 内置 2722 条食物是种子数据（两端各自播种，id 可能不同），只同步自建的那些；
    // 业务键取 name（表上有 UNIQUE）。
    t(
        "foods",
        Pk::Local,
        1,
        &[],
        Some("name"),
        &[],
        &[],
        Some("is_custom = 1"),
    ),
    // 自建动作（`custom-<uuid>`）：内置动作两端都有，不同步（收藏/隐藏是本机态，见 docs/SYNC.md）
    t(
        "exercises",
        Pk::Text("id"),
        1,
        &[],
        None,
        &[],
        &[],
        Some("id LIKE 'custom-%'"),
    ),
    t("workout_plans", Pk::Text("id"), 1, &[], None, &[], &[], None),
    t("ai_chats", Pk::Text("id"), 1, &[], None, &[], &[], None),
    t("programs", Pk::Local, 1, &[], None, &[], &[], None),
    // 知识库文件：content 是正文（文本），不同步派生的 kb_docs/kb_chunks/kb_vectors
    t(
        "kb_files",
        Pk::Local,
        1,
        &[],
        Some("path"),
        &[],
        &[],
        Some("system = 0"),
    ),
    // 模型：非密字段同步，**api_key 不进对象**（对端不覆盖本机已填的密钥）
    t(
        "ai_models",
        Pk::Local,
        1,
        &[],
        None,
        &[],
        &["api_key"],
        None,
    ),
    // 待办：course_session_id 指向不同步的校园课次 → 丢弃
    //
    // `rec_key` 也**不进同步对象**（迁移 0047）：它是 `"模板id:日期"`，而模板 id 是
    // **本机自增 id** —— 跨设备没有意义，写成对端的 id 会让本机的
    // `sync_recurrences` 认不出这条实例，当场再补一条（就是「勾一下多出一条」的另一条来路）。
    // 而且 0047 的触发器禁止改身份，硬写会连整批应用一起失败、永不收敛。
    // 重复实例由两端各自按模板物化（模板的 `rec_rule` 是同步的），身份在本地重建。
    t(
        "todos",
        Pk::Local,
        1,
        &[
            Ref {
                column: "program_id",
                target: Some("programs"),
            },
            Ref {
                column: "course_session_id",
                target: None,
            },
        ],
        None,
        &[("attachments", Media::Json)],
        &["rec_key"],
        None,
    ),
    // ---- 依赖上一层的 ----
    t(
        "food_units",
        Pk::Local,
        2,
        &[Ref {
            column: "food_id",
            target: Some("foods"),
        }],
        None,
        &[],
        &[],
        None,
    ),
    t(
        "meal_logs",
        Pk::Local,
        2,
        &[Ref {
            column: "food_id",
            target: Some("foods"),
        }],
        None,
        &[],
        &[],
        None,
    ),
    // workout_sessions.plan_id 是文本 id，本身就是跨设备身份，不需要换
    t(
        "workout_sessions",
        Pk::Local,
        2,
        &[],
        None,
        &[],
        &[],
        None,
    ),
    t(
        "program_meals",
        Pk::Local,
        2,
        &[Ref {
            column: "program_id",
            target: Some("programs"),
        }],
        None,
        &[],
        &[],
        None,
    ),
    t(
        "kb_assets",
        Pk::Local,
        2,
        &[Ref {
            column: "file_id",
            target: Some("kb_files"),
        }],
        None,
        &[("ref", Media::DataUrl)],
        &[],
        None,
    ),
    t(
        "ai_chat_messages",
        Pk::Text("id"),
        2,
        &[],
        None,
        &[
            ("image_base64", Media::Base64),
            ("payload", Media::Json),
        ],
        &[],
        None,
    ),
    t(
        "voice_memos",
        Pk::Text("id"),
        2,
        &[],
        None,
        &[("audio_path", Media::Wav)],
        &[],
        None,
    ),
    t(
        "pomodoro_sessions",
        Pk::Local,
        2,
        &[Ref {
            column: "todo_id",
            target: Some("todos"),
        }],
        None,
        &[],
        &[],
        None,
    ),
    // 每天一条体重记录：业务键是 date（表上有 UNIQUE），两端各自记了同一天要并成一条
    t(
        "body_metrics",
        Pk::Local,
        2,
        &[],
        Some("date"),
        &[],
        &[],
        None,
    ),
    t("ledger_entries", Pk::Local, 2, &[], None, &[], &[], None),
    t(
        "recipe_prefs",
        Pk::Text("recipe_id"),
        2,
        &[],
        None,
        &[],
        &[],
        None,
    ),
    t(
        "shopping_checks",
        Pk::Text("item_key"),
        2,
        &[],
        None,
        &[],
        &[],
        None,
    ),
    // ---- 再下一层 ----
    t(
        "workout_sets",
        Pk::Local,
        3,
        &[Ref {
            column: "workout_id",
            target: Some("workouts"),
        }],
        None,
        &[],
        &[],
        None,
    ),
    // workouts.session_id 指向 workout_sessions（nullable）
    //
    // 业务键取 `external_id`（迁移 0036）：从 Health Connect 导入的记录带着 HC 的
    // 记录 UUID，两台设备各自导入**同一条** HC 记录时靠它并成一条，而不是插两条
    // 撞唯一索引。本地记录该列为 NULL —— 同步层的业务键只在值是字符串时才参与合并
    // （见 apply.rs），所以这一条不会改变 Rein 自建记录的既有行为。
    t(
        "workouts",
        Pk::Local,
        3,
        &[Ref {
            column: "session_id",
            target: Some("workout_sessions"),
        }],
        Some("external_id"),
        &[],
        &[],
        None,
    ),
    // 用量账单：每行是一次调用，两端合并就是并集（model_pk 指向模型行）
    t(
        "ai_usage",
        Pk::Local,
        4,
        &[Ref {
            column: "model_pk",
            target: Some("ai_models"),
        }],
        None,
        &[],
        &[],
        None,
    ),
];

/// 查一张表的登记项；没登记 = 不参与同步。
pub fn spec(name: &str) -> Option<&'static TableSpec> {
    TABLES.iter().find(|s| s.name == name)
}

/// 表当前的列名（两处用：拼对象、应用时挡掉本机没有的列）。
pub fn column_names(conn: &rusqlite::Connection, table: &str) -> crate::error::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 应用顺序（小的先应用）。同一批到达的对象按它排序，外键因此先有落点。
pub fn apply_order(name: &str) -> u8 {
    spec(name).map(|s| s.order).unwrap_or(u8::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_table_unique() {
        let mut names: Vec<&str> = TABLES.iter().map(|s| s.name).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len(), "表名重复登记");
    }

    /// 依赖闭环自查：refs 指向的表要么已登记、要么显式丢弃（target = None）。
    #[test]
    fn refs_are_known_tables() {
        for s in TABLES {
            for r in s.refs {
                if let Some(target) = r.target {
                    assert!(spec(target).is_some(), "{} 引用了未登记的表 {target}", s.name);
                    assert!(
                        apply_order(target) <= s.order,
                        "{} 的依赖 {target} 排在它后面",
                        s.name
                    );
                }
            }
        }
    }

    /// 凭证列绝不能在对象里（`ai_models.api_key` 是本轮的样板）。
    #[test]
    fn secrets_are_skipped() {
        let models = spec("ai_models").unwrap();
        assert!(models.skip.contains(&"api_key"));
    }
}
