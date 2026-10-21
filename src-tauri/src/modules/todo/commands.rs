//! 待办域命令 · 命令名与前端 `todoService.ts` 对应。

use tauri::State;

use crate::error::Result;
use crate::state::AppState;
use chrono::{Datelike, Duration, Local, NaiveDate, Utc};
use rusqlite::OptionalExtension;

use super::models::{
    RecRule, Todo, TodoAttachment, TodoDayCount, TodoDistribution, TodoPage, TodoSubtask,
};

const COLS: &str = "id, title, notes, date, start_min, duration_min, category, priority, status, completed_at, created_at, program_id, rec_rule, rec_key, subtasks, attachments, course_session_id";

fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// 周一 = 0 … 周日 = 6（与前端 weekDates/WEEKDAY_LABELS 对齐）
fn dow_of(d: NaiveDate) -> i64 {
    d.weekday().num_days_from_monday() as i64
}

/// JSON 列序列化。用 `?` 而不是 `expect`：这些类型序列化失败的概率趋近于零，
/// 但真失败时也该是一条可解释的错误（`ReinError::Json`），而不是 panic 毒化全局 DB 锁。
fn json_str<T: serde::Serialize>(v: &Option<T>) -> Result<Option<String>> {
    match v.as_ref() {
        Some(x) => Ok(Some(serde_json::to_string(x)?)),
        None => Ok(None),
    }
}

fn rule_matches(rule: &RecRule, template_date: &str, date: &str) -> bool {
    if let (Some(end), Some(d)) = (&rule.end_date, parse_date(date)) {
        if let Some(e) = parse_date(end) {
            if d > e {
                return false;
            }
        }
    }
    let (Some(t), Some(d)) = (parse_date(template_date), parse_date(date)) else {
        return false;
    };
    if d < t {
        return false;
    }
    match rule.freq.as_str() {
        "daily" => true,
        "weekly" => rule.weekdays.contains(&dow_of(d)),
        "interval" => rule.interval_days > 0 && (d - t).num_days() % rule.interval_days == 0,
        _ => false,
    }
}

/// `rec_key = "模板id:日期"` → `(模板 id, 日期)`；不成形状的历史脏数据返回 `None`。
/// 清理、物化、删除三处都要认这个键，形状只在这里定义一次。
fn parse_rec_key(key: &str) -> Option<(i64, &str)> {
    let (tid, date) = key.rsplit_once(':')?;
    Some((tid.parse::<i64>().ok()?, date))
}

/// 子任务实例化：结构照抄、勾选状态清零（新的一天从零开始）
/// 重复待办模板行：物化实例所需的字段快照
struct RecTemplate {
    id: i64,
    title: String,
    notes: Option<String>,
    start_min: Option<i64>,
    duration_min: Option<i64>,
    category: String,
    priority: i64,
    subtasks: Option<String>,
    rec_rule: Option<String>,
    date: Option<String>,
    /// 除外日期 JSON 数组（"YYYY-MM-DD"）：用户删掉的那几次，物化时跳过（见 [`add_rec_exdate`]）
    rec_exdates: Option<String>,
}

fn reset_subtasks(raw: &Option<String>) -> Result<Option<String>> {
    let subs: Vec<TodoSubtask> =
        serde_json::from_str(raw.as_deref().unwrap_or("[]")).unwrap_or_default();
    if subs.is_empty() {
        return Ok(None);
    }
    let reset: Vec<TodoSubtask> = subs
        .into_iter()
        .map(|s| TodoSubtask {
            title: s.title,
            done: false,
        })
        .collect();
    Ok(Some(serde_json::to_string(&reset)?))
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Todo> {
    let rec_rule: Option<RecRule> = row
        .get::<_, Option<String>>(12)?
        .and_then(|s| serde_json::from_str(&s).ok());
    let rec_key: Option<String> = row.get(13)?;
    let subtasks: Option<Vec<TodoSubtask>> = row
        .get::<_, Option<String>>(14)?
        .and_then(|s| serde_json::from_str(&s).ok());
    let attachments: Option<Vec<TodoAttachment>> = row
        .get::<_, Option<String>>(15)?
        .and_then(|s| serde_json::from_str(&s).ok());
    Ok(Todo {
        id: row.get(0)?,
        title: row.get(1)?,
        notes: row.get(2)?,
        date: row.get(3)?,
        start_min: row.get(4)?,
        duration_min: row.get(5)?,
        category: row.get(6)?,
        priority: row.get(7)?,
        status: row.get(8)?,
        completed_at: row.get(9)?,
        created_at: row.get(10)?,
        program_id: row.get(11)?,
        rec_rule,
        rec_key,
        subtasks,
        attachments,
        course_session_id: row.get(16)?,
    })
}

#[tauri::command]
pub fn list_todos(
    state: State<AppState>,
    start_date: String,
    end_date: String,
) -> Result<Vec<Todo>> {
    let conn = state.db.lock();
    list_todos_on(&conn, &start_date, &end_date)
}

/// `list_todos` 的本体：收 `&Connection` 而不是 `State`，供 tauri 命令与对外网关共用。
/// 网关拿的必须是同一把 `state.db.lock()`（contract §6.1 单连接铁律，钩子按连接注册）。
pub(crate) fn list_todos_on(
    conn: &rusqlite::Connection,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<Todo>> {
    let sql = format!(
        "SELECT {COLS} FROM todos \
         WHERE date IS NOT NULL AND date BETWEEN ?1 AND ?2 \
         ORDER BY date, (start_min IS NULL), start_min, priority DESC, id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let todos = stmt
        .query_map([start_date, end_date], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(todos)
}

#[tauri::command]
/// 全部待办（含收件箱 date IS NULL），按 未完成→日期→时间→优先级 排序。
/// 供「全部待办」页与虚拟时间线使用。
pub fn list_all_todos(state: State<AppState>) -> Result<Vec<Todo>> {
    let conn = state.db.lock();
    list_all_todos_on(&conn)
}

/// `list_all_todos` 的本体（见 [`list_todos_on`]）。
pub(crate) fn list_all_todos_on(conn: &rusqlite::Connection) -> Result<Vec<Todo>> {
    let sql = format!(
        "SELECT {COLS} FROM todos \
         ORDER BY (status = 'done'), (date IS NULL), date, (start_min IS NULL), start_min, priority DESC, id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let todos = stmt
        .query_map([], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(todos)
}

/// 对外网关专用：带 SQL 侧 `LIMIT` 的 `list_todos`（contract §6.4「每页 LIMIT，禁止无界全表」）。
/// 前端命令仍用无 LIMIT 的 [`list_todos_on`]（时间线要全量），网关这条只服务外部调用。
pub(crate) fn list_todos_on_limited(
    conn: &rusqlite::Connection,
    start_date: &str,
    end_date: &str,
    limit: i64,
) -> Result<Vec<Todo>> {
    let sql = format!(
        "SELECT {COLS} FROM todos \
         WHERE date IS NOT NULL AND date BETWEEN ?1 AND ?2 \
         ORDER BY date, (start_min IS NULL), start_min, priority DESC, id \
         LIMIT ?3"
    );
    let mut stmt = conn.prepare(&sql)?;
    let todos = stmt
        .query_map((start_date, end_date, limit), from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(todos)
}

/// 对外网关专用：带 SQL 侧 `LIMIT` 的 `list_all_todos`（见 [`list_todos_on_limited`]）。
pub(crate) fn list_all_todos_on_limited(
    conn: &rusqlite::Connection,
    limit: i64,
) -> Result<Vec<Todo>> {
    let sql = format!(
        "SELECT {COLS} FROM todos \
         ORDER BY (status = 'done'), (date IS NULL), date, (start_min IS NULL), start_min, priority DESC, id \
         LIMIT ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let todos = stmt
        .query_map((limit,), from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(todos)
}

#[tauri::command]
/// AI 渐进式分页查询（对应工具 list_todos），避免全量倾倒：
/// scope="focus" 默认聚焦视图 = 逾期未完成 + [今天, 今天+7] + 收件箱（排最后）；
/// scope="range" 按 [start, end] 日期区间过滤（不含收件箱）。
/// 排序与 list_all_todos 一致：done 沉底 → 日期 → 时间 → 优先级。
pub fn query_todos(
    state: State<AppState>,
    today: String,
    scope: Option<String>,
    start: Option<String>,
    end: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<TodoPage> {
    let conn = state.db.lock();
    let limit = limit.unwrap_or(20).clamp(1, 50);
    let offset = offset.unwrap_or(0).max(0);

    // 两个分支的参数形状固定，分别构造 WHERE 与绑定值
    let (where_sql, vals): (String, Vec<String>) = if scope.as_deref() == Some("range") {
        let (Some(s), Some(e)) = (start, end) else {
            return Err(crate::error::ReinError::Message(
                "scope=range 需要 start/end（YYYY-MM-DD）".into(),
            ));
        };
        ("date BETWEEN ?1 AND ?2".to_string(), vec![s, e])
    } else {
        let Some(today_d) = parse_date(&today) else {
            return Err(crate::error::ReinError::Message(
                "日期格式应为 YYYY-MM-DD".into(),
            ));
        };
        let win_end = (today_d + Duration::days(7)).format("%Y-%m-%d").to_string();
        (
            "(date IS NULL OR (status != 'done' AND (date < ?1 OR date BETWEEN ?1 AND ?2)))"
                .to_string(),
            vec![today.clone(), win_end],
        )
    };
    let order =
        "(status = 'done'), (date IS NULL), date, (start_min IS NULL), start_min, priority DESC, id";
    let sql = format!(
        "SELECT {COLS} FROM todos WHERE {where_sql} ORDER BY {order} LIMIT {limit} OFFSET {offset}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt
        .query_map(rusqlite::params_from_iter(vals.iter()), from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM todos WHERE {where_sql}"),
        rusqlite::params_from_iter(vals.iter()),
        |r| r.get(0),
    )?;
    Ok(TodoPage {
        items,
        total,
        limit,
        offset,
    })
}

#[tauri::command]
/// 主页「全部待办」信息流：未完成整体在前、已完成沉底，分页取数避免全量倾倒。
/// 排序与分页口径见 [`query_todo_feed_on`]。
pub fn query_todo_feed(
    state: State<AppState>,
    today: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<TodoPage> {
    let conn = state.db.lock();
    query_todo_feed_on(&conn, &today, limit, offset)
}

/// 信息流的 ORDER BY 全序（逐键语义见 [`query_todo_feed_on`] 的文档）。
///
/// 单拎成常量只为让单测能直接钉住第 6 键 `id`：`id` 是 rowid 别名（建表
/// `INTEGER PRIMARY KEY AUTOINCREMENT`），全表扫描的输入序天然就是 id 升序，
/// 稳定排序器下「删掉 `, id`」在行为上不可观察（实测 SQLite 3.46.0：删掉后返回序与现状
/// 逐位相同），只能由 `feed_order_by_ends_with_id_tiebreaker` 直接查文本。
const FEED_ORDER_BY: &str = "ORDER BY (status = 'done'), \
     CASE WHEN date IS NULL THEN 0 WHEN date < ?1 THEN 1 WHEN date = ?1 THEN 2 ELSE 3 END, \
     date, (start_min IS NULL), start_min, priority DESC, id";

/// `query_todo_feed` 的本体：收 `&Connection` 而不是 `State`（见 [`list_todos_on`]），
/// 单测才能在内存库上直接跑。
///
/// 排序全序（前端信息流与 mock 侧逐字对齐同一套，改这里就得同步改 `src/mock/server.ts`）：
/// 1) `(status = 'done')` —— 未完成（todo/doing）整体在前，**只有** 'done' 沉底；
/// 2) 日期桶 `date IS NULL(未安排) → 逾期 → 今天 → 未来`——这一键不看 status，
///    已完成组内自动沿用同一桶序，无需第二个表达式；
/// 3) `date` 升序：逾期桶里最早欠的排最前，未来桶按日期升序（桶 0 全 NULL，不参与）；
/// 4) `(start_min IS NULL), start_min`：有时间的在前、时间早的在前（沿用既有排序串的取舍）；
/// 5) `priority DESC`；6) `id` 兜底 —— 前五键都是列值、第六键唯一 ⇒ 任何一页的边界都落在确定的行上。
///
/// `total` 是**全表条数**（不过滤：含已完成、收件箱与课表派生行），与 `list_all_todos` 同口径；
/// `today` 只参与 ORDER BY 的分桶，不参与过滤。
/// `limit` 默认 30、`clamp(1, 100)`；`offset` 默认 0、`max(0)`，越界返回空 items 且 total 照给。
pub(crate) fn query_todo_feed_on(
    conn: &rusqlite::Connection,
    today: &str,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<TodoPage> {
    if parse_date(today).is_none() {
        return Err(crate::error::ReinError::Message(
            "日期格式应为 YYYY-MM-DD".into(),
        ));
    }
    let limit = limit.unwrap_or(30).clamp(1, 100);
    let offset = offset.unwrap_or(0).max(0);
    let sql = format!("SELECT {COLS} FROM todos {FEED_ORDER_BY} LIMIT ?2 OFFSET ?3");
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt
        .query_map(rusqlite::params![today, limit, offset], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0))?;
    Ok(TodoPage {
        items,
        total,
        limit,
        offset,
    })
}

#[tauri::command]
/// 全部日程按日分布总览（对应工具 todo_distribution）：按日计数 + 收件箱/逾期摘要。
/// AI 先看分布再分页下钻，避免拉全量明细。
pub fn todo_distribution(state: State<AppState>, today: String) -> Result<TodoDistribution> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT date, COUNT(*) FROM todos WHERE date IS NOT NULL GROUP BY date ORDER BY date",
    )?;
    let days = stmt
        .query_map([], |r| {
            Ok(TodoDayCount {
                date: r.get(0)?,
                count: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let inbox: i64 = conn.query_row("SELECT COUNT(*) FROM todos WHERE date IS NULL", [], |r| {
        r.get(0)
    })?;
    let overdue: i64 = conn.query_row(
        "SELECT COUNT(*) FROM todos WHERE date IS NOT NULL AND status != 'done' AND date < ?1",
        [&today],
        |r| r.get(0),
    )?;
    Ok(TodoDistribution {
        days,
        inbox,
        overdue,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_todo(
    state: State<AppState>,
    title: String,
    notes: Option<String>,
    date: Option<String>,
    start_min: Option<i64>,
    duration_min: Option<i64>,
    category: Option<String>,
    priority: Option<i64>,
    rec_rule: Option<RecRule>,
    subtasks: Option<Vec<TodoSubtask>>,
    attachments: Option<Vec<TodoAttachment>>,
) -> Result<Todo> {
    let conn = state.db.lock();
    create_todo_on(
        &conn,
        title,
        notes,
        date,
        start_min,
        duration_min,
        category,
        priority,
        rec_rule,
        subtasks,
        attachments,
    )
}

/// `create_todo` 的本体（见 [`list_todos_on`]）。对外网关的 `schedule.create` 走它，
/// 只带契约 §4.4 允许的字段，`rec_rule`/`subtasks`/`attachments` 一律传 `None`。
#[allow(clippy::too_many_arguments)]
pub(crate) fn create_todo_on(
    conn: &rusqlite::Connection,
    title: String,
    notes: Option<String>,
    date: Option<String>,
    start_min: Option<i64>,
    duration_min: Option<i64>,
    category: Option<String>,
    priority: Option<i64>,
    rec_rule: Option<RecRule>,
    subtasks: Option<Vec<TodoSubtask>>,
    attachments: Option<Vec<TodoAttachment>>,
) -> Result<Todo> {
    let now = Utc::now().to_rfc3339();
    let category = category.unwrap_or_else(|| "general".into());
    conn.execute(
        "INSERT INTO todos (title, notes, date, start_min, duration_min, category, priority, created_at, rec_rule, subtasks, attachments) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            title,
            notes,
            date,
            start_min,
            duration_min,
            category,
            priority.unwrap_or(0),
            now,
            json_str(&rec_rule)?,
            json_str(&subtasks)?,
            json_str(&attachments)?,
        ],
    )?;
    let id = conn.last_insert_rowid();
    // 重复模板：自身即首日实例，rec_key = "id:日期"
    if rec_rule.is_some() {
        if let Some(d) = &date {
            conn.execute(
                "UPDATE todos SET rec_key = ?1 WHERE id = ?2",
                rusqlite::params![format!("{id}:{d}"), id],
            )?;
        }
    }
    let sql = format!("SELECT {COLS} FROM todos WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], from_row)?)
}

/// 全量更新（前端持有完整对象；避免设计 patch 合并逻辑）。
#[tauri::command]
pub fn update_todo(state: State<AppState>, todo: Todo) -> Result<Todo> {
    let conn = state.db.lock();
    update_todo_on(&conn, &todo)
}

/// `update_todo` 的本体（见 [`list_todos_on`]）。仍是**全量覆盖**语义：
/// 调用方给的 `Todo` 缺哪些非暴露列，就把那些列写成空 —— 需要保值的调用方自己先补齐
/// （对外网关照 contract §10 在 handler 层拒绝带附件的待办并保留原 rec_rule/subtasks）。
///
/// **`rec_key` 不在这里推导**。它是重复实例的**身份**，不是可写字段：
/// 从前这里按「这一行有没有 rec_rule」决定 rec_key，而实例本来就没有规则 ⇒ 任何一次
/// 整对象回写（勾选、改标题、改日期）都会把身份写成 NULL ⇒ `sync_recurrences` 认不出它、
/// 当场再补一条 ⇒ 用户看到「勾一下多出一条」。那条链路已出现过多次。
///
/// 现在的口径（三层护栏，缺一不可）：
/// 1. 这里**永远不写 `rec_key`**（SQL 里根本没有这一列）；
/// 2. 模板行改日期时，身份要跟着走 —— 那一句由迁移 0047 的触发器**显式放行**的
///    唯一情形（`rec_key = id || ':' || date`）覆盖，所以这里补一次独立的 UPDATE；
/// 3. 其它任何想改 / 清空身份的写法都会被触发器挡下，不管来自哪个模块。
pub(crate) fn update_todo_on(conn: &rusqlite::Connection, todo: &Todo) -> Result<Todo> {
    conn.execute(
        "UPDATE todos SET title = ?1, notes = ?2, date = ?3, start_min = ?4, duration_min = ?5, \
         category = ?6, priority = ?7, status = ?8, completed_at = ?9, rec_rule = ?10, subtasks = ?11, attachments = ?12 \
         WHERE id = ?13",
        rusqlite::params![
            todo.title,
            todo.notes,
            todo.date,
            todo.start_min,
            todo.duration_min,
            todo.category,
            todo.priority,
            todo.status,
            todo.completed_at,
            json_str(&todo.rec_rule)?,
            json_str(&todo.subtasks)?,
            json_str(&todo.attachments)?,
            todo.id
        ],
    )?;

    // 模板行改日期 → 首日身份跟着走（「模板 = 首日实例」）。只在**确实是模板**时才动，
    // 且必须与触发器放行的形状逐字一致，否则会被护栏拦下 —— 那说明调用方在试图改实例的身份。
    if todo.rec_rule.is_some() {
        if let Some(d) = &todo.date {
            conn.execute(
                "UPDATE todos SET rec_key = ?1 WHERE id = ?2 AND (rec_key IS NULL OR rec_key <> ?1)",
                rusqlite::params![format!("{}:{}", todo.id, d), todo.id],
            )?;
        }
    }

    let sql = format!("SELECT {COLS} FROM todos WHERE id = ?1");
    Ok(conn.query_row(&sql, [todo.id], from_row)?)
}

#[tauri::command]
pub fn delete_todo(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.db.lock();
    delete_todo_on(&conn, id)
}

/// `delete_todo` 的本体（见 [`list_todos_on`]）。
pub(crate) fn delete_todo_on(conn: &rusqlite::Connection, id: i64) -> Result<()> {
    let today = Local::now().date_naive().format("%Y-%m-%d").to_string();
    delete_todo_on_as_of(conn, id, &today)
}

/// `delete_todo` 的实际语义（`today` 显式传入，单测才能在固定日期上跑，套路同 [`sync_recurrences_on`]）：
///
/// - **删实例** = 跳过这一次：把日期记进模板的 `rec_exdates`（[`add_rec_exdate`]）。不记的话
///   下一次 `sync_recurrences` 会按规则把这条原样补回来 —— 用户看到的就是「待办删不掉」。
/// - **删模板** = 整条重复待办下线：连它今天及以后仍未完成的实例一并收走。未来实例本也会随
///   规则失配被清理，提前到删除当场是为了那一天：清理只认 `date > today`，而「今天那条」若留下
///   就是永久孤儿 —— 明天它变成过去，再没有谁会碰它。已完成的实例不追溯（done 行永不删）。
pub(crate) fn delete_todo_on_as_of(
    conn: &rusqlite::Connection,
    id: i64,
    today: &str,
) -> Result<()> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row("SELECT rec_key, rec_rule FROM todos WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    conn.execute("DELETE FROM todos WHERE id = ?1", [id])?;
    let Some((rec_key, rec_rule)) = row else {
        return Ok(()); // 本来就没有这一行：保持幂等
    };

    // 删的是实例 → 记下这一天不再物化。模板自身的 rec_key 也长这样（"id:自己的日期"），
    // 但它随模板一起没了，不必记。
    if let Some((tid, date)) = rec_key.as_deref().and_then(parse_rec_key) {
        if tid != id {
            add_rec_exdate(conn, tid, date)?;
        }
    }

    if rec_rule.is_some() {
        let open: Vec<(i64, String)> = {
            let mut stmt = conn.prepare(
                "SELECT id, rec_key FROM todos \
                 WHERE rec_key IS NOT NULL AND status != 'done' AND date IS NOT NULL AND date >= ?1",
            )?;
            let rows = stmt
                .query_map([today], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for (iid, key) in open {
            if parse_rec_key(&key).is_some_and(|(tid, _)| tid == id) {
                conn.execute("DELETE FROM todos WHERE id = ?1", [iid])?;
            }
        }
    }
    Ok(())
}

/// 把某一天记进模板的除外日期（去重、幂等）。模板已不在（连删、历史脏数据）就静默跳过 ——
/// 删一条孤儿实例没理由失败。
fn add_rec_exdate(conn: &rusqlite::Connection, template_id: i64, date: &str) -> Result<()> {
    let existing: Option<Option<String>> = conn
        .query_row("SELECT rec_exdates FROM todos WHERE id = ?1", [template_id], |r| {
            r.get(0)
        })
        .optional()?;
    let Some(existing) = existing else {
        return Ok(());
    };
    let mut dates: Vec<String> = existing
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    if dates.iter().any(|d| d == date) {
        return Ok(());
    }
    dates.push(date.to_string());
    conn.execute(
        "UPDATE todos SET rec_exdates = ?1 WHERE id = ?2",
        rusqlite::params![serde_json::to_string(&dates)?, template_id],
    )?;
    Ok(())
}

/// 按 id 取一行（不存在返回 `None`）。供对外网关的 `schedule.update` 读取**非暴露列**
/// （`rec_rule`/`subtasks`/`attachments`/`course_session_id`）用 —— 外部 DTO 不带这些字段，
/// 直接全量覆盖会把它们清空（contract §10）。tauri 命令侧没有这个入口的需求，故只对
/// 网关开放（`pub(crate)`）。
pub(crate) fn get_todo_on(conn: &rusqlite::Connection, id: i64) -> Result<Option<Todo>> {
    let sql = format!("SELECT {COLS} FROM todos WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], from_row).optional()?)
}

#[tauri::command]
/// 重复实例物化（幂等，前端每次全量加载前调用）：
/// 1) 规则已不匹配/越界的未来未完成实例 → 删除（改规则、改结束日期后自动收敛）；
/// 2) 窗口 [今天-1, 今天+7] 内缺失的实例 → 按模板补建（rec_key = "模板id:日期"），
///    但**用户删过的日子**（模板 `rec_exdates`）除外 —— 少了这一条，删除会被这一步当场撤销。
/// 返回本次新增实例数。
///
/// 顺带把**已经上完的课表派生行**自动打卡（见 [`crate::modules::campus::commands::auto_complete_past_courses`]）：
/// 课表派生行是只读投影、用户勾不了，而前端每条加载路径都会走这条命令，
/// 「上完自动打勾」于是不依赖用户专门打开课表页。
pub fn sync_recurrences(state: State<AppState>, today: String) -> Result<usize> {
    let conn = state.db.lock();
    let inserted = sync_recurrences_on(&conn, &today)?;
    crate::modules::campus::commands::auto_complete_past_courses(&conn)?;
    Ok(inserted)
}

/// `sync_recurrences` 的本体：收 `&Connection` 而不是 `State`，测试才能在内存库上直接跑
/// （与 `ai::commands::usage_summary_on` 同一套路）。
fn sync_recurrences_on(conn: &rusqlite::Connection, today: &str) -> Result<usize> {
    let Some(today_d) = parse_date(today) else {
        return Err(crate::error::ReinError::Message(
            "日期格式应为 YYYY-MM-DD".into(),
        ));
    };
    let win_start = (today_d - Duration::days(1)).format("%Y-%m-%d").to_string();
    // 窗口末端直接用日期对象：省掉一次字符串解析，也不给 `parse_date(..).unwrap()` 留位置
    let win_end_d = today_d + Duration::days(7);

    // 1) 清理失效的未来未完成实例
    let stale: Vec<(i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, rec_key FROM todos \
             WHERE rec_key IS NOT NULL AND status != 'done' AND date IS NOT NULL AND date > ?1",
        )?;
        let rows = stmt
            .query_map([today], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut deleted = 0usize;
    for (id, key) in stale {
        let Some((tid, ds)) = parse_rec_key(&key) else {
            continue;
        };
        let keep = conn
            .query_row(
                "SELECT rec_rule, date FROM todos WHERE id = ?1",
                [tid],
                |r| {
                    let raw: Option<String> = r.get(0)?;
                    let tdate: Option<String> = r.get(1)?;
                    Ok((raw, tdate))
                },
            )
            .ok()
            .and_then(|(raw, tdate)| {
                let rule: Option<RecRule> = raw.and_then(|s| serde_json::from_str(&s).ok());
                let td = tdate?;
                Some(matches!(rule, Some(r) if rule_matches(&r, &td, ds)))
            })
            .unwrap_or(false);
        if !keep {
            deleted += conn.execute("DELETE FROM todos WHERE id = ?1", [id])?;
        }
    }

    // 2) 物化窗口内缺失实例（除模板自己的那一天与 rec_exdates 记下的「删过的日子」）
    let mut inserted = 0usize;
    let templates = {
        let mut stmt = conn.prepare(
            "SELECT id, title, notes, start_min, duration_min, category, priority, subtasks, rec_rule, date, rec_exdates \
             FROM todos WHERE rec_rule IS NOT NULL AND date IS NOT NULL",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(RecTemplate {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    notes: r.get(2)?,
                    start_min: r.get(3)?,
                    duration_min: r.get(4)?,
                    category: r.get(5)?,
                    priority: r.get(6)?,
                    subtasks: r.get(7)?,
                    rec_rule: r.get(8)?,
                    date: r.get(9)?,
                    rec_exdates: r.get(10)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for t in templates {
        let (Some(raw), Some(tdate)) = (t.rec_rule, t.date) else {
            continue;
        };
        let Some(rule) = serde_json::from_str::<RecRule>(&raw).ok() else {
            continue;
        };
        // 用户删掉的每一次（见 `delete_todo_on_as_of`）在这里生效：规则仍匹配也不再重建。
        let exdates: Vec<String> = t
            .rec_exdates
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        let mut d = parse_date(&win_start);
        while let Some(day) = d {
            if day > win_end_d {
                break;
            }
            let ds = day.format("%Y-%m-%d").to_string();
            d = Some(day + Duration::days(1));
            if ds == tdate || exdates.iter().any(|x| x == &ds) || !rule_matches(&rule, &tdate, &ds) {
                continue;
            }
            let key = format!("{}:{}", t.id, ds);
            let exists: bool = conn
                .query_row("SELECT 1 FROM todos WHERE rec_key = ?1", [&key], |_| {
                    Ok(true)
                })
                .unwrap_or(false);
            if exists {
                continue;
            }
            conn.execute(
                "INSERT INTO todos (title, notes, date, start_min, duration_min, category, priority, status, created_at, rec_key, subtasks) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'todo', ?8, ?9, ?10)",
                rusqlite::params![
                    t.title.as_str(),
                    t.notes.as_deref(),
                    ds,
                    t.start_min,
                    t.duration_min,
                    t.category.as_str(),
                    t.priority,
                    Utc::now().to_rfc3339(),
                    key,
                    reset_subtasks(&t.subtasks)?,
                ],
            )?;
            inserted += 1;
        }
    }
    let _ = deleted; // 清理数仅用于调试观察，不进返回值
    Ok(inserted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// 内存库 + 完整迁移（不跑种子）：todos 的 JSON 列、rec_key 部分唯一索引都在。
    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    /// 对外网关专用的 LIMIT 变体：SQL 侧就限行，别让外部拉全表（contract §6.4）。
    #[test]
    fn limited_list_variants_cap_rows_in_sql() {
        let conn = fresh();
        for i in 0..10 {
            conn.execute(
                "INSERT INTO todos (title, category, priority, status, created_at) \
                 VALUES (?1, 'general', 0, 'todo', 'now')",
                [format!("t{i}")],
            )
            .unwrap();
        }
        assert_eq!(list_all_todos_on(&conn).unwrap().len(), 10, "前端用的本体仍返回全量");
        assert_eq!(list_all_todos_on_limited(&conn, 3).unwrap().len(), 3, "LIMIT 生效");
        assert_eq!(list_all_todos_on_limited(&conn, 100).unwrap().len(), 10, "未超限则全给");

        conn.execute("UPDATE todos SET date = '2026-09-23'", []).unwrap();
        assert_eq!(
            list_todos_on_limited(&conn, "2026-09-01", "2026-09-30", 4)
                .unwrap()
                .len(),
            4,
            "日期窗变体同样带 LIMIT"
        );
        assert_eq!(
            list_todos_on(&conn, "2026-09-01", "2026-09-30").unwrap().len(),
            10,
            "前端用的本体不受影响"
        );
    }

    fn rule(freq: &str, weekdays: Vec<i64>, interval_days: i64, end_date: Option<&str>) -> RecRule {
        RecRule {
            freq: freq.into(),
            weekdays,
            interval_days,
            end_date: end_date.map(|s| s.into()),
        }
    }

    #[test]
    fn rule_matches_covers_freq_end_date_and_boundaries() {
        let daily = rule("daily", vec![], 1, None);
        assert!(
            !rule_matches(&daily, "2026-09-23", "2026-09-22"),
            "模板日期之前永不物化"
        );
        assert!(rule_matches(&daily, "2026-09-23", "2026-09-30"));

        // weekly：周一=0，2026-09-23 是周三
        let weekly = rule("weekly", vec![2], 1, None);
        assert!(rule_matches(&weekly, "2026-09-21", "2026-09-23"));
        assert!(!rule_matches(&weekly, "2026-09-21", "2026-09-24"));

        // interval：距模板日每 3 天
        let interval = rule("interval", vec![], 3, None);
        assert!(rule_matches(&interval, "2026-09-21", "2026-09-24"));
        assert!(!rule_matches(&interval, "2026-09-21", "2026-09-25"));

        // end_date 含当天，之后不再物化
        let ended = rule("daily", vec![], 1, Some("2026-09-22"));
        assert!(rule_matches(&ended, "2026-09-21", "2026-09-22"));
        assert!(!rule_matches(&ended, "2026-09-21", "2026-09-23"));
    }

    fn insert_template(conn: &Connection, rule_json: &str) -> i64 {
        conn.execute(
            "INSERT INTO todos (title, category, priority, status, created_at, date, rec_rule) \
             VALUES ('晨跑', 'general', 0, 'todo', '2026-09-21T00:00:00Z', '2026-09-21', ?1)",
            [rule_json],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        // 「模板 = 首日实例」：走与生产同一条路径（create_todo_on 在这里补 rec_key）。
        // 夹具若只裸插而不补，模板在物化眼里就没有身份 —— 那是夹具失真，不是被测行为。
        conn.execute(
            "UPDATE todos SET rec_key = ?1 WHERE id = ?2 AND rec_key IS NULL",
            rusqlite::params![format!("{id}:2026-09-21"), id],
        )
        .unwrap();
        id
    }

    /// 现存的重复实例（日期, 是否完成），按日期升序。
    ///
    /// **只算模板的子行**（rec_key 里的父 id ≠ 这一行自己的 id）：模板自身也带
    /// `rec_key = "id:自己的日期"`（「模板 = 首日实例」），把它算进「实例数」会让
    /// 每个断言都多一条 —— 那个歧义正是这些断言以前容易误报的原因。
    fn instances(conn: &Connection) -> Vec<(String, bool)> {
        let mut stmt = conn
            .prepare(
                "SELECT date, status FROM todos \
                 WHERE rec_key IS NOT NULL \
                   AND substr(rec_key, 1, instr(rec_key, ':') - 1) <> CAST(id AS TEXT) \
                 ORDER BY date",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)? == "done",
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        rows
    }

    #[test]
    fn sync_materializes_window_is_idempotent_and_converges_after_rule_change() {
        let conn = fresh();
        let tid = insert_template(&conn, r#"{"freq":"daily","weekdays":[],"intervalDays":1}"#);

        // 窗口 = [今天-1, 今天+7] = 09-22 … 09-30（9 天）；模板日 09-21 不在窗口内
        assert_eq!(sync_recurrences_on(&conn, "2026-09-23").unwrap(), 9);
        // 幂等：再跑一遍什么都不补
        assert_eq!(sync_recurrences_on(&conn, "2026-09-23").unwrap(), 0);

        let mut stmt = conn
            .prepare(
                "SELECT rec_key FROM todos \
                 WHERE rec_key IS NOT NULL \
                   AND substr(rec_key, 1, instr(rec_key, ':') - 1) <> CAST(id AS TEXT)",
            )
            .unwrap();
        let keys = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(keys.len(), 9);
        assert!(
            keys.iter().all(|k| k.starts_with(&format!("{tid}:"))),
            "实例键必须是「模板id:日期」：{keys:?}"
        );

        // 模板自身也有首日身份（「模板 = 首日实例」）—— 那是身份，不是「多出来的实例」
        let template_key: String = conn
            .query_row("SELECT rec_key FROM todos WHERE id = ?1", [tid], |r| r.get(0))
            .unwrap();
        assert_eq!(template_key, format!("{tid}:2026-09-21"));

        // 把 09-25 标成完成，再把规则改成「每周三」——
        // 未来不再匹配的未完成实例应被删除，已完成的照旧留住（历史行永不追溯）
        conn.execute(
            "UPDATE todos SET status = 'done' WHERE rec_key = ?1",
            [format!("{tid}:2026-09-25")],
        )
        .unwrap();
        conn.execute(
            "UPDATE todos SET rec_rule = ?1 WHERE id = ?2",
            rusqlite::params![
                r#"{"freq":"weekly","weekdays":[2],"intervalDays":1}"#,
                tid
            ],
        )
        .unwrap();
        assert_eq!(sync_recurrences_on(&conn, "2026-09-23").unwrap(), 0);

        assert_eq!(
            instances(&conn),
            vec![
                ("2026-09-22".to_string(), false), // 昨天：不在清理范围
                ("2026-09-23".to_string(), false), // 周三
                ("2026-09-25".to_string(), true),  // 已完成：留着
                ("2026-09-30".to_string(), false), // 周三
            ]
        );
    }

    /// 删掉重复待办的**一次实例**必须活过下一次物化 —— 修复前的症状就是「待办删不掉」：
    /// 删除命令确实删了行，但前端删除后紧接着刷新走 `sync_recurrences`（每次全量加载都跑），
    /// 按规则把这一天原样补建，用户看到的还是同一条。
    #[test]
    fn deleting_an_instance_sticks_and_records_exdate() {
        let conn = fresh();
        let tid = insert_template(&conn, r#"{"freq":"daily","weekdays":[],"intervalDays":1}"#);
        // 窗口 09-22…09-30（模板日 09-21 不在窗口内）
        assert_eq!(sync_recurrences_on(&conn, "2026-09-23").unwrap(), 9);

        let iid: i64 = conn
            .query_row(
                "SELECT id FROM todos WHERE rec_key = ?1",
                [format!("{tid}:2026-09-25")],
                |r| r.get(0),
            )
            .unwrap();
        delete_todo_on_as_of(&conn, iid, "2026-09-23").unwrap();

        // 行没了，且这一天被记进模板的除外日期
        assert!(instances(&conn).iter().all(|(d, _)| d != "2026-09-25"));
        let raw: Option<String> = conn
            .query_row("SELECT rec_exdates FROM todos WHERE id = ?1", [tid], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(raw.as_deref(), Some(r#"["2026-09-25"]"#));

        // 下一次加载（= 再跑一次物化）不再补回；其它日子一条不少
        assert_eq!(sync_recurrences_on(&conn, "2026-09-23").unwrap(), 0);
        let days: Vec<String> = instances(&conn).into_iter().map(|(d, _)| d).collect();
        assert_eq!(days.len(), 8);
        assert!(!days.contains(&"2026-09-25".to_string()));
    }

    /// 删**模板** = 整条重复待办下线：今天与以后的未完成实例一并收走（否则「今天那条」
    /// 会以孤儿身份留下 —— 明天它就变成过去，再没有哪条清理规则会碰它）；历史不动：
    /// 更早的实例行、已完成的实例行照旧留着（done 行永不追溯）。
    #[test]
    fn deleting_a_template_takes_today_and_future_instances_with_it() {
        let conn = fresh();
        let tid = insert_template(&conn, r#"{"freq":"daily","weekdays":[],"intervalDays":1}"#);
        assert_eq!(sync_recurrences_on(&conn, "2026-09-23").unwrap(), 9);
        conn.execute(
            "UPDATE todos SET status = 'done' WHERE rec_key = ?1",
            [format!("{tid}:2026-09-30")],
        )
        .unwrap();

        delete_todo_on_as_of(&conn, tid, "2026-09-23").unwrap();

        assert_eq!(
            instances(&conn),
            vec![
                ("2026-09-22".to_string(), false), // 昨天：历史，留着
                ("2026-09-30".to_string(), true),  // 已完成：留着
            ]
        );
        // 模板已不在，再物化不会凭空重建
        assert_eq!(sync_recurrences_on(&conn, "2026-09-23").unwrap(), 0);
        assert_eq!(instances(&conn).len(), 2);

        // 删一条孤儿实例（模板已删）不报错、也不再往不存在的模板上记除外日期
        let orphan: i64 = conn
            .query_row(
                "SELECT id FROM todos WHERE rec_key = ?1",
                [format!("{tid}:2026-09-22")],
                |r| r.get(0),
            )
            .unwrap();
        delete_todo_on_as_of(&conn, orphan, "2026-09-23").unwrap();
        assert_eq!(instances(&conn).len(), 1);
    }

    // ---- 回归：勾选实例不得多出一条（迁移 0047 的结构护栏）----
    //
    // 这个缺陷在真实使用里出现过多次，每次都是同一形状：勾一条重复待办的实例 →
    // 前端整对象回写 → 身份被写成 NULL → 物化把它当成缺失、再补一条。
    // 下面三条把「身份是身份、不是可写字段」钉死；全量回写那条是原样复现事故路径。

    /// 勾选一条实例（走前端真实路径：取整对象 → 改状态 → `update_todo_on` 回写）
    /// 之后，物化**不得**再补出第二条，且身份原封不动。
    #[test]
    fn toggling_instance_does_not_duplicate_it() {
        let conn = fresh();
        let tid = insert_template(&conn, r#"{"freq":"daily","weekdays":[],"intervalDays":1}"#);
        sync_recurrences_on(&conn, "2026-09-23").unwrap();
        let before = instances(&conn);
        assert!(!before.is_empty(), "先得有实例");

        let iid: i64 = conn
            .query_row(
                "SELECT id FROM todos WHERE rec_key = ?1",
                [format!("{tid}:2026-09-24")],
                |r| r.get(0),
            )
            .unwrap();
        let key_before: String = conn
            .query_row("SELECT rec_key FROM todos WHERE id = ?1", [iid], |r| r.get(0))
            .unwrap();

        // 前端勾选的等价动作：整对象回写（status 变更）
        let mut inst = get_todo_on(&conn, iid).unwrap().unwrap();
        inst.status = "done".into();
        inst.completed_at = Some("2026-09-24T10:00:00Z".into());
        update_todo_on(&conn, &inst).unwrap();

        // 身份必须原样保留 —— 这是本缺陷的根因所在
        let key_after: String = conn
            .query_row("SELECT rec_key FROM todos WHERE id = ?1", [iid], |r| r.get(0))
            .unwrap();
        assert_eq!(key_after, key_before, "整对象回写不得改写重复实例的身份");

        // 物化仍幂等：一条都不补
        assert_eq!(
            sync_recurrences_on(&conn, "2026-09-23").unwrap(),
            0,
            "勾选之后物化不得补出任何实例"
        );
        assert_eq!(instances(&conn).len(), before.len(), "总条数保持不变");
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM todos WHERE title = '晨跑' AND date = '2026-09-24'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1,
            "同一天同一条待办只能有一行"
        );
    }

    /// 身份**不可变**：任何试图清空 / 改写 `rec_key` 的写法都要被数据库拒绝，
    /// 不管它来自哪个模块（这是防「下一个模块再踩一遍」的唯一位置）。
    #[test]
    fn instance_identity_is_immutable_at_the_database() {
        let conn = fresh();
        let tid = insert_template(&conn, r#"{"freq":"daily","weekdays":[],"intervalDays":1}"#);
        sync_recurrences_on(&conn, "2026-09-23").unwrap();
        let iid: i64 = conn
            .query_row(
                "SELECT id FROM todos WHERE rec_key = ?1",
                [format!("{tid}:2026-09-24")],
                |r| r.get(0),
            )
            .unwrap();

        let cleared = conn.execute("UPDATE todos SET rec_key = NULL WHERE id = ?1", [iid]);
        assert!(cleared.is_err(), "清空实例身份必须被拒绝");

        let rewritten =
            conn.execute("UPDATE todos SET rec_key = '999:2026-09-24' WHERE id = ?1", [iid]);
        assert!(rewritten.is_err(), "改写实例身份必须被拒绝");

        // 身份仍在，未被半途改坏
        let key: String = conn
            .query_row("SELECT rec_key FROM todos WHERE id = ?1", [iid], |r| r.get(0))
            .unwrap();
        assert_eq!(key, format!("{tid}:2026-09-24"));
    }

    /// 模板改日期时，首日身份**跟着走**（「模板 = 首日实例」）——
    /// 这是身份不可变的唯一例外，漏了它模板就永远停在旧日期上。
    #[test]
    fn template_identity_follows_its_own_date() {
        let conn = fresh();
        let tid = insert_template(&conn, r#"{"freq":"daily","weekdays":[],"intervalDays":1}"#);
        let mut tpl = get_todo_on(&conn, tid).unwrap().unwrap();
        assert_eq!(tpl.rec_key.as_deref(), Some(format!("{tid}:2026-09-21").as_str()));

        tpl.date = Some("2026-09-22".into());
        update_todo_on(&conn, &tpl).unwrap();

        let key: String = conn
            .query_row("SELECT rec_key FROM todos WHERE id = ?1", [tid], |r| r.get(0))
            .unwrap();
        assert_eq!(key, format!("{tid}:2026-09-22"), "模板身份必须跟随自己的日期");
    }

    /// `rec_exdates` 是**内部列**：前端的全量更新（`update_todo_on` 只写它认识的列）
    /// 不碰它，于是改个标题不会把已经删掉的那一天翻回来。
    #[test]
    fn exdate_survives_template_update() {
        let conn = fresh();
        let tid = insert_template(&conn, r#"{"freq":"daily","weekdays":[],"intervalDays":1}"#);
        sync_recurrences_on(&conn, "2026-09-23").unwrap();
        let iid: i64 = conn
            .query_row(
                "SELECT id FROM todos WHERE rec_key = ?1",
                [format!("{tid}:2026-09-25")],
                |r| r.get(0),
            )
            .unwrap();
        delete_todo_on_as_of(&conn, iid, "2026-09-23").unwrap();

        // 模拟编辑器保存：整对象回写模板
        let mut tpl = get_todo_on(&conn, tid).unwrap().unwrap();
        tpl.title = "晨跑（改过）".into();
        update_todo_on(&conn, &tpl).unwrap();

        assert_eq!(sync_recurrences_on(&conn, "2026-09-23").unwrap(), 0);
        assert!(instances(&conn).iter().all(|(d, _)| d != "2026-09-25"));
    }

    // ---- query_todo_feed（主页「全部待办」信息流）----

    /// 插一条待办（只带排序用得上的列），返回 id。
    fn insert_todo(
        conn: &Connection,
        title: &str,
        date: Option<&str>,
        start_min: Option<i64>,
        priority: i64,
        status: &str,
    ) -> i64 {
        conn.execute(
            "INSERT INTO todos (title, date, start_min, category, priority, status, created_at) \
             VALUES (?1, ?2, ?3, 'general', ?4, ?5, '2026-09-23T00:00:00Z')",
            rusqlite::params![title, date, start_min, priority, status],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    /// 信息流的标题序列（断言顺序用；全序兜底键是 id，见 [`feed_ids`]）。
    fn feed_titles(conn: &Connection, today: &str, limit: Option<i64>) -> Vec<String> {
        query_todo_feed_on(conn, today, limit, None)
            .unwrap()
            .items
            .iter()
            .map(|t| t.title.clone())
            .collect()
    }

    /// 一页的 id 序列（翻页拼接用）。
    fn feed_ids(conn: &Connection, today: &str, limit: Option<i64>, offset: Option<i64>) -> Vec<i64> {
        query_todo_feed_on(conn, today, limit, offset)
            .unwrap()
            .items
            .iter()
            .map(|t| t.id)
            .collect()
    }

    /// 造一条校园课表时段链（account → semester → course → session），返回 session id。
    /// `todos.course_session_id` 是真外键且 `migrate` 开着 `foreign_keys`，
    /// 所以「课表派生行」必须挂一条真 session，不能编个 id。
    fn insert_campus_session(conn: &Connection) -> i64 {
        conn.execute(
            "INSERT INTO campus_accounts (system_kind, base_url, login_name, created_at, updated_at) \
             VALUES ('jwgl', 'https://example.edu', 'student', 'now', 'now')",
            [],
        )
        .unwrap();
        let account = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO campus_semesters (account_id, remote_id, name, start_date, end_date) \
             VALUES (?1, 1, '2026 秋', '2026-09-01', '2027-01-15')",
            [account],
        )
        .unwrap();
        let semester = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO campus_courses (account_id, semester_id, remote_lesson_id, course_name) \
             VALUES (?1, ?2, 1, '高等数学')",
            rusqlite::params![account, semester],
        )
        .unwrap();
        let course = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO campus_sessions (account_id, semester_id, course_id, weekday, start_unit, \
             end_unit, start_time, end_time, weeks) \
             VALUES (?1, ?2, ?3, 2, 1, 2, '08:00', '09:40', '1-16')",
            rusqlite::params![account, semester, course],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    /// 排序键 1-3：未完成五桶 = 未安排 → 逾期（日期升序，最早欠的在前）→ 今天 → 未来（日期升序）。
    #[test]
    fn feed_buckets_undone_inbox_overdue_today_future() {
        let conn = fresh();
        let today = "2026-09-23";
        // 故意乱序插入：结果只由 ORDER BY 决定，与插入顺序无关
        insert_todo(&conn, "未来2", Some("2026-09-25"), None, 0, "todo");
        insert_todo(&conn, "逾期2", Some("2026-09-21"), None, 0, "todo");
        insert_todo(&conn, "今天1", Some(today), None, 0, "todo");
        insert_todo(&conn, "未安排", None, None, 0, "todo");
        insert_todo(&conn, "逾期1", Some("2026-09-20"), None, 0, "todo");
        insert_todo(&conn, "未来1", Some("2026-09-24"), None, 0, "todo");
        assert_eq!(
            feed_titles(&conn, today, None),
            vec!["未安排", "逾期1", "逾期2", "今天1", "未来1", "未来2"]
        );
    }

    /// 排序键 1 的另一面：已完成整体沉底，且组内沿用同一日期桶序（'doing' 与 'todo' 同档）。
    #[test]
    fn feed_sinks_done_rows_after_all_undone() {
        let conn = fresh();
        let today = "2026-09-23";
        // 未完成 / 已完成各桶交替插入：只有「done 沉底 + 桶序」能给出下面的顺序
        insert_todo(&conn, "done未安排", None, None, 0, "done");
        insert_todo(&conn, "未安排", None, None, 0, "todo");
        insert_todo(&conn, "done逾期", Some("2026-09-20"), None, 0, "done");
        insert_todo(&conn, "逾期", Some("2026-09-20"), None, 0, "todo");
        insert_todo(&conn, "done今天", Some(today), None, 0, "done");
        insert_todo(&conn, "今天", Some(today), None, 0, "doing");
        insert_todo(&conn, "done未来", Some("2026-09-25"), None, 0, "done");
        insert_todo(&conn, "未来", Some("2026-09-25"), None, 0, "todo");
        assert_eq!(
            feed_titles(&conn, today, None),
            vec![
                "未安排",
                "逾期",
                "今天",
                "未来",
                "done未安排",
                "done逾期",
                "done今天",
                "done未来",
            ]
        );
    }

    /// 排序键 4-6：同桶内 (start_min IS NULL) → start_min → priority DESC → id。
    #[test]
    fn feed_group_order_within_bucket_follows_time_priority_id() {
        let conn = fresh();
        let today = "2026-09-23";
        // 插入顺序故意与目标顺序不同：max(id) 的 A 反而排最后（无时间靠后），
        // 小 id 的 B 被 C/E 挤到后面（priority DESC 压过 id ASC）
        insert_todo(&conn, "A 无时间·高优先", Some(today), None, 9, "todo");
        insert_todo(&conn, "B 10:00·低优先", Some(today), Some(600), 0, "todo");
        insert_todo(&conn, "C 10:00·高优先", Some(today), Some(600), 5, "todo");
        insert_todo(&conn, "D 09:00·低优先", Some(today), Some(540), 0, "todo");
        insert_todo(&conn, "E 10:00·高优先·大id", Some(today), Some(600), 5, "todo");
        assert_eq!(
            feed_titles(&conn, today, None),
            vec![
                "D 09:00·低优先",
                "C 10:00·高优先",
                "E 10:00·高优先·大id",
                "B 10:00·低优先",
                "A 无时间·高优先",
            ]
        );
    }

    /// 翻页不重不漏：每页与**硬编码期望序**的切片逐位相同。
    /// 只比「4 页拼起来 == 一次取回」钉不住排序键 —— 两边是同一条 SQL 的两次运行，
    /// 实测删掉 `, id` 甚至把它写成 `id DESC`，那个比较都照样通过（自洽 ≠ 正确）。
    #[test]
    fn feed_paging_is_stable_across_pages() {
        let conn = fresh();
        let today = "2026-09-23";
        for i in 0..20i64 {
            let date = match i % 4 {
                0 => None,
                1 => Some("2026-09-20"),
                2 => Some(today),
                _ => Some("2026-09-25"),
            };
            let status = if i % 3 == 0 { "done" } else { "todo" };
            let start_min = if i % 2 == 0 { None } else { Some(600 + i) };
            insert_todo(&conn, &format!("t{i:02}"), date, start_min, i % 3, status);
        }
        // 期望序（id = 插入序 + 1）：未完成 8,4,16 | 1,5,13,17 | 2,14,10 | 7,11,19 → 已完成 0,12 | 9 | 6,18 | 3,15。
        // 前五键并列的四组（下标 0/12、2/14、4/16、6/18）在这里都按 id 升序解开 ⇒ 第 6 键写反会红。
        let expected: Vec<i64> = vec![
            9, 5, 17, 2, 6, 14, 18, 3, 15, 11, 8, 12, 20, 1, 13, 10, 7, 19, 4, 16,
        ];
        let all = feed_ids(&conn, today, Some(100), None);
        assert_eq!(all, expected, "一次取回应与期望序逐位相同");
        let mut paged = Vec::new();
        for page in 0..4usize {
            let slice = feed_ids(&conn, today, Some(5), Some((page * 5) as i64));
            assert_eq!(
                slice,
                expected[page * 5..page * 5 + 5],
                "第 {page} 页应与期望切片相同"
            );
            paged.extend(slice);
        }
        assert_eq!(paged, expected, "4 页 × 5 条应与一次取回逐位相同");
    }

    /// 第 6 键（`id` 兜底）的**存在性**只能查 SQL 文本：`id` 是 rowid 别名，全表扫描的
    /// 输入序天然就是 id 升序，稳定排序器下删掉它行为不可观察（实测 SQLite 3.46.0 逐位相同）。
    /// 行为侧由 [`feed_paging_is_stable_across_pages`] 钉方向/位置，这里钉「它在」。
    #[test]
    fn feed_order_by_ends_with_id_tiebreaker() {
        assert!(
            FEED_ORDER_BY.ends_with(", id"),
            "ORDER BY 必须落在 `, id` 上，否则分页边界没有唯一的第 6 键兜底：{FEED_ORDER_BY}"
        );
    }

    /// total 是全表条数（不过滤）；offset 越界不报错、返回空页并把入参原样回传。
    #[test]
    fn feed_total_counts_all_rows_and_offset_beyond_returns_empty() {
        let conn = fresh();
        let today = "2026-09-23";
        insert_todo(&conn, "已完成", Some(today), None, 0, "done");
        insert_todo(&conn, "收件箱", None, None, 0, "todo");
        insert_todo(&conn, "普通", Some(today), None, 0, "todo");

        let page = query_todo_feed_on(&conn, today, None, None).unwrap();
        assert_eq!(page.total, 3, "total 含已完成与收件箱");
        assert_eq!(page.limit, 30, "默认页大小 30");
        assert_eq!(page.offset, 0, "默认 offset 0");
        assert_eq!(page.items.len(), 3);

        let beyond = query_todo_feed_on(&conn, today, Some(10), Some(99)).unwrap();
        assert!(beyond.items.is_empty(), "offset 越界返回空页而不是报错");
        assert_eq!(beyond.total, 3, "越界也照给 total：前端据此判到底");
        assert_eq!(beyond.limit, 10, "limit 原样回传");
        assert_eq!(beyond.offset, 99, "offset 原样回传");
    }

    /// 两端口径：total == 逐页取回并集的长度（含课表派生行与重复实例行，都不过滤）。
    #[test]
    fn feed_total_matches_full_scan() {
        let conn = fresh();
        let today = "2026-09-23";

        // 课表派生行（course_session_id 非空）
        let sid = insert_campus_session(&conn);
        let derived = insert_todo(&conn, "课程·高数", Some(today), Some(480), 0, "todo");
        conn.execute(
            "UPDATE todos SET course_session_id = ?1 WHERE id = ?2",
            rusqlite::params![sid, derived],
        )
        .unwrap();

        // 重复模板 + 实例（rec_key = "模板id:日期"）
        let template = insert_todo(&conn, "晨跑·模板", Some(today), Some(420), 0, "todo");
        conn.execute(
            "UPDATE todos SET rec_rule = ?1, rec_key = ?2 WHERE id = ?3",
            rusqlite::params![
                r#"{"freq":"daily","weekdays":[],"intervalDays":1}"#,
                format!("{template}:{today}"),
                template
            ],
        )
        .unwrap();
        let instance = insert_todo(&conn, "晨跑·实例", Some("2026-09-24"), Some(420), 0, "todo");
        conn.execute(
            "UPDATE todos SET rec_key = ?1 WHERE id = ?2",
            rusqlite::params![format!("{template}:2026-09-24"), instance],
        )
        .unwrap();

        insert_todo(&conn, "已完成", Some("2026-09-20"), None, 0, "done");
        insert_todo(&conn, "收件箱", None, None, 0, "todo");

        let first = query_todo_feed_on(&conn, today, Some(2), None).unwrap();
        assert_eq!(
            first.total,
            list_all_todos_on(&conn).unwrap().len() as i64,
            "total 与无 WHERE 的全表扫描同口径"
        );

        let mut union = Vec::new();
        for page in 0..8 {
            let p = query_todo_feed_on(&conn, today, Some(2), Some(page * 2)).unwrap();
            if p.items.is_empty() {
                break;
            }
            union.extend(p.items);
        }
        assert_eq!(union.len() as i64, first.total, "逐页取回的并集长度 == total");
        assert!(
            union.iter().any(|t| t.course_session_id == Some(sid)),
            "课表派生行在结果里（feed 不筛它）"
        );
        assert!(
            union.iter().any(|t| t.rec_key.is_some()),
            "重复实例行在结果里"
        );
    }

    /// limit 默认 30、clamp(1,100)；offset 默认 0、负数归 0。
    #[test]
    fn feed_clamps_limit_and_offset() {
        let conn = fresh();
        let today = "2026-09-23";
        for i in 0..3 {
            insert_todo(&conn, &format!("t{i}"), Some(today), None, 0, "todo");
        }

        let default = query_todo_feed_on(&conn, today, None, None).unwrap();
        assert_eq!((default.limit, default.offset), (30, 0), "缺省 = 30/0");
        assert_eq!(default.items.len(), 3, "未超限则全给");

        let clamped_low = query_todo_feed_on(&conn, today, Some(0), Some(-5)).unwrap();
        assert_eq!(
            (clamped_low.limit, clamped_low.offset),
            (1, 0),
            "limit 0 → 1、offset 负数 → 0"
        );
        assert_eq!(clamped_low.items.len(), 1, "clamp 后确实只给一行");

        let clamped_high = query_todo_feed_on(&conn, today, Some(999), None).unwrap();
        assert_eq!(clamped_high.limit, 100, "limit 上限 100");
        assert_eq!(clamped_high.items.len(), 3);
    }

    /// today 只参与分桶；格式非法必须报错，不许静默分错桶。
    #[test]
    fn feed_rejects_malformed_today() {
        let conn = fresh();
        insert_todo(&conn, "任意", Some("2026-09-23"), None, 0, "todo");
        for bad in ["2026/09/23", ""] {
            let err = query_todo_feed_on(&conn, bad, None, None).unwrap_err();
            assert!(
                err.to_string().contains("YYYY-MM-DD"),
                "{bad:?} 的错误文案应提示日期格式：{err}"
            );
        }
    }

    /// 同一日期上未完成 / 已完成并存时两条不跨桶交错：
    /// 今天的未完成 → 未来未完成 → 今天已完成（已完成那条 id 最小也照样沉底）。
    #[test]
    fn feed_keeps_bucket_boundaries_on_duplicate_dates() {
        let conn = fresh();
        let today = "2026-09-23";
        insert_todo(&conn, "今天·已完成", Some(today), None, 0, "done");
        insert_todo(&conn, "今天·未完成", Some(today), None, 0, "todo");
        insert_todo(&conn, "明天·未完成", Some("2026-09-24"), None, 0, "todo");
        assert_eq!(
            feed_titles(&conn, today, None),
            vec!["今天·未完成", "明天·未完成", "今天·已完成"]
        );
    }
}
