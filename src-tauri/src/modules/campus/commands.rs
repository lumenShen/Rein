//! 校园教务域命令 · 命令名与前端 `campusService.ts` 对应。
//!
//! **一条铁律：慢网络与 DB 锁不许同时持有。**
//! `AppState.db`（`state::Db`：内裹一把全局 `Mutex<Connection>`）所有域共用；而教务系统是慢站点，
//! 单个大响应实测可达数十秒。若把抓取和写库塞进同一个临界区，整个 App 的命令都会被卡住。
//! 所以每个联网命令都是「短锁读 → 无锁联网 → 短锁写」三段式，
//! 与 `modules/kb` 的「embeddings 绝不持锁」是同一条规矩。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{Datelike, Duration, Local, NaiveDate, Timelike, Utc};
use rusqlite::Connection;
use tauri::{AppHandle, State};

use crate::error::{ReinError, Result};
use crate::state::{AppState, CampusHub, CourseSelectToken, Db, PendingLogin};

use super::adapters::base::{AnyAdapter, CampusAdapter};
use super::course_select::CourseSelectClient;
use super::dates;
use super::grab::{self, GrabHub};
use super::holiday::{self, HolidayConfig, HolidayConfigView, HolidayPlan};
use super::http::{CookieJar, HttpResponse, Session};
use super::lesson_search::{self, LessonSearchClient};
use super::matcher;
use super::models::*;
use super::adapters::provider::{self, SchoolSystemInfo, SchoolSystemSpec};
use super::rescue;

const ACCOUNT_COLS: &str = "id, system_kind, base_url, login_name, password, cookies, session_at, \
     student_id, student_code, student_name, department, major, adminclass, grade, total_credits, \
     save_password, active, last_sync_at, created_at, updated_at";

/// 时间线物化窗口。刻意不做整学期：一门课带 `weekIndexes` 展开后一学期轻松上百条，
/// 会明显拖重 `list_all_todos` 与知识库索引。过去一周（留回看余地）+ 未来五周，
/// 足够覆盖日/周/月三种视图的实际浏览范围；超出部分在课表页照常可见——
/// 课表读的是 `campus_sessions`，不依赖派生行。
const MATERIALIZE_BACK_DAYS: i64 = 7;
const MATERIALIZE_FORWARD_DAYS: i64 = 35;

/// 课表派生行在时间线上的分类，对应前端 `CATEGORY_META['class']`
const COURSE_CATEGORY: &str = "class";

/// 派生行的时长兜底：教务偶尔缺 `endTime`，给一个常见两节课的长度，
/// 免得时间轴上出现零高块。
const DEFAULT_CLASS_MIN: i64 = 95;

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

/// `app_meta` 读写走 `db` 的唯一实现（本模块只留短别名，便于阅读）。
fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    crate::db::meta_get(conn, key)
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    crate::db::meta_set(conn, key, value)
}

/// 「库里的课表时段是旧规则写下的，需要一次真同步」的标记键。
///
/// 写它的是迁移 0049（`db.rs`，字面量必须与这里一致）：旧唯一键把同一门课同一时段的
/// 多个周次段并成了一条，被并掉的那些周次**只能从教务重新拉一遍才补得回来**。
/// 读它的是 `schedule_view_on`（透出 `needsResync`，前端据此替用户跑一次同步），
/// 清它的是 `campus_sync` 落库成功之后 —— 同步本身会把整学期的时段按新键重写。
pub(crate) const SESSIONS_NEED_RESYNC: &str = "campus.sessions_need_resync";

/* ─────────────────────────── 账号读写 ─────────────────────────── */

/// Rust 内部的账号形状（**含明文密码与 Cookie**）。只在本模块内流转，绝不 Serialize。
struct AccountRow {
    id: i64,
    system_kind: String,
    base_url: String,
    login_name: String,
    password: Option<String>,
    cookies: Option<String>,
    session_at: Option<String>,
    student_id: Option<String>,
    student_code: Option<String>,
    student_name: Option<String>,
    department: Option<String>,
    major: Option<String>,
    adminclass: Option<String>,
    grade: Option<String>,
    total_credits: Option<f64>,
    save_password: bool,
    active: bool,
    last_sync_at: Option<String>,
    created_at: String,
    updated_at: String,
}

impl AccountRow {
    fn spec(&self) -> Result<&'static SchoolSystemSpec> {
        provider::spec(&self.system_kind)
            .ok_or_else(|| ReinError::Message(format!("未知的学校系统：{}", self.system_kind)))
    }

    fn session(&self) -> Session {
        Session::new(&self.base_url, CookieJar::from_json(self.cookies.as_deref()))
    }

    fn saved_password(&self) -> Option<&str> {
        self.password.as_deref().filter(|p| !p.is_empty())
    }
}

fn account_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AccountRow> {
    Ok(AccountRow {
        id: r.get(0)?,
        system_kind: r.get(1)?,
        base_url: r.get(2)?,
        login_name: r.get(3)?,
        password: r.get(4)?,
        cookies: r.get(5)?,
        session_at: r.get(6)?,
        student_id: r.get(7)?,
        student_code: r.get(8)?,
        student_name: r.get(9)?,
        department: r.get(10)?,
        major: r.get(11)?,
        adminclass: r.get(12)?,
        grade: r.get(13)?,
        total_credits: r.get(14)?,
        save_password: r.get::<_, i64>(15)? != 0,
        active: r.get::<_, i64>(16)? != 0,
        last_sync_at: r.get(17)?,
        created_at: r.get(18)?,
        updated_at: r.get(19)?,
    })
}

/// 对外投影：丢掉密码与 Cookie，只留两个布尔。
fn to_account(a: AccountRow) -> CampusAccount {
    // 两个派生布尔必须在搬字段之前算完：结构体字面量按书写顺序求值，
    // 一旦先移走了 a 的某个字段，再对 a 调用方法就会撞上「部分移动后仍被借用」。
    let has_password = a.saved_password().is_some();
    let logged_in = CookieJar::from_json(a.cookies.as_deref()).has_session_ticket();
    CampusAccount {
        id: a.id,
        system_kind: a.system_kind,
        base_url: a.base_url,
        login_name: a.login_name,
        has_password,
        logged_in,
        session_at: a.session_at,
        student_id: a.student_id,
        student_code: a.student_code,
        student_name: a.student_name,
        department: a.department,
        major: a.major,
        adminclass: a.adminclass,
        grade: a.grade,
        total_credits: a.total_credits,
        save_password: a.save_password,
        active: a.active,
        last_sync_at: a.last_sync_at,
        created_at: a.created_at,
        updated_at: a.updated_at,
    }
}

fn load_active_account(conn: &Connection) -> Result<Option<AccountRow>> {
    let sql = format!(
        "SELECT {ACCOUNT_COLS} FROM campus_accounts WHERE active = 1 ORDER BY updated_at DESC LIMIT 1"
    );
    match conn.query_row(&sql, [], account_row) {
        Ok(a) => Ok(Some(a)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(ReinError::from(e)),
    }
}

/// 需要账号的联网命令统一从这里起步；没登录时给出可操作的中文提示。
fn require_account(conn: &Connection) -> Result<AccountRow> {
    load_active_account(conn)?
        .ok_or_else(|| ReinError::Message("还没有绑定教务系统账号，请先在「课表配置」里登录".into()))
}

/* ─────────────────────────── 会话自愈 ───────────────────────────
 *
 * 教务会话的寿命不归我们管：可能是服务端 TTL 到了，也可能是用户在别处登了一次。
 * 表现永远只有一种 —— **302 回登录页**，HTTP 层把它翻成了固定文案
 * （`guet.rs::ok_resp` / `course_select.rs::acquire`）。
 *
 * 自愈要做三件事，且必须**三件一起做**：
 *   1. 用存下的密码静默重登，拿到新 Cookie；
 *   2. **立刻落库** —— 不能等整个流程跑完。否则后半程一失败，新会话就白换了，
 *      用户下次看到的还是「请重新登录」，只能手动再同步一次（这正是这组函数存在的理由）；
 *   3. 作废选课令牌缓存 —— 那张 SSO JWT 是拿旧会话换的，会话一换它就跟着失效。
 */

/// 错误是不是「会话失效」。
///
/// 判据以 `ReinError::code() == "session_lost"` 为准（文案产出的源头在
/// `guet.rs::ok_resp` / `course_select.rs::acquire` / `lesson_search.rs::guard` 已打码）；
/// 关键词只作兜底 —— 错误被 `format!` 二次包装后码会丢，而这里判错就意味着
/// 「不会自动重登」，是这条链路上代价最大的误判。
pub(crate) fn is_session_lost(err: &ReinError) -> bool {
    if err.code() == "session_lost" {
        return true;
    }
    let msg = err.to_string();
    msg.contains("会话已过期") || msg.contains("重新登录") || msg.contains("登录已过期")
}

/// 用账号里存下的密码静默重登（无验证码），返回**新会话**的 Cookie。
///
/// 从一个空 jar 起步：旧 jar 里那套已死的票据没有任何价值，留着只会在握手时
/// 先发一次死 Cookie。树维的登录流程本身要先 GET salt 把新会话建起来，空 jar 是安全的。
fn relogin(account: &AccountRow) -> Result<CookieJar> {
    let Some(password) = account.saved_password() else {
        return Err(ReinError::coded(
            "session_lost",
            "登录状态已过期，且该账号没有保存密码 —— 请到「课表配置」重新登录一次，\
             勾上「保存密码」以后过期就能自动恢复",
        ));
    };
    let spec = account.spec()?;
    let mut session = Session::new(&account.base_url, CookieJar::default());
    let outcome = {
        let mut adapter = AnyAdapter::new(spec, &mut session);
        adapter.login(&account.login_name, password, "")?
    };
    if !outcome.ok {
        let why = outcome
            .message
            .unwrap_or_else(|| "教务系统拒绝了这次登录".into());
        return Err(ReinError::coded(
            "session_lost",
            format!("登录状态已过期，自动重新登录失败：{why}"),
        ));
    }
    Ok(session.jar().clone())
}

/// 把刷新后的会话立刻写回账号（`session_at` 一并更新，配置页据此显示会话确认时间）。
fn persist_session(conn: &Connection, account_id: i64, jar: &CookieJar) -> Result<()> {
    conn.execute(
        "UPDATE campus_accounts SET cookies = ?1, session_at = ?2, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![jar.to_json(), now_iso(), account_id],
    )?;
    Ok(())
}

/// 会话换过了，拿旧会话换来的选课 SSO 令牌也就没用了。
fn forget_select_token(hub: &CampusHub) {
    *hub.select_token.lock().unwrap() = None;
}

/// 自愈的完整动作：静默重登（网络，**不持锁**）→ 落库 → 作废选课令牌。
///
/// 重登是两三次往返的慢网络，绝不能和 DB 锁叠在一起（见文件头那条铁律）；
/// 这个签名收 `&Db`（而不是 `&Connection`），就是为了它自己决定锁的边界。
fn recover_session(db: &Db, hub: &CampusHub, account: &AccountRow) -> Result<()> {
    let jar = relogin(account)?;
    {
        let conn = db.lock();
        persist_session(&conn, account.id, &jar)?;
    }
    forget_select_token(hub);
    Ok(())
}

/* ─────────────────────────── 周次 → 公历日期 ─────────────────────────── */

/// 学期第一教学周第一天的公历日期。
/// `start_date` 理论上就是它，但仍做一次吸附：万一教务给了个周中日期，吸附后依然自洽。
fn semester_anchor(sem: &CampusSemester) -> Option<NaiveDate> {
    Some(dates::week_anchor(
        dates::parse_ymd(&sem.start_date)?,
        sem.week_start_on_sunday,
    ))
}

/// 「第 week 教学周的星期 weekday」→ 公历日期。weekday 用教务口径：1=周一 … 7=周日。
///
/// `week_start_on_sunday` 决定偏移：周一制下 周一→+0、周日→+6；周日制下 周日→+0、周一→+1。
/// 教务只给周序号，这一步是整套课表能落到日历上的唯一依据。
fn occurrence_date(
    anchor: NaiveDate,
    week: i64,
    weekday: i64,
    week_start_on_sunday: bool,
) -> Option<NaiveDate> {
    if week < 1 || !(1..=7).contains(&weekday) {
        return None;
    }
    let offset = if week_start_on_sunday {
        weekday % 7
    } else {
        weekday - 1
    };
    anchor.checked_add_signed(Duration::days((week - 1) * 7 + offset))
}

/* ─────────────────────────── 课表读取 ─────────────────────────── */

const SESSION_SELECT: &str = "SELECT s.id, s.course_id, s.weekday, s.start_unit, s.end_unit, \
     s.start_time, s.end_time, s.weeks, s.weeks_str, s.room, s.building, s.campus, \
     c.course_name, c.course_code, c.credits, COALESCE(s.teachers, c.teachers), c.course_type, \
     c.color \
     FROM campus_sessions s JOIN campus_courses c ON c.id = s.course_id";

fn session_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CampusSession> {
    let weeks_raw: String = r.get(7)?;
    let teachers_raw: Option<String> = r.get(15)?;
    Ok(CampusSession {
        id: r.get(0)?,
        course_id: r.get(1)?,
        weekday: r.get(2)?,
        start_unit: r.get(3)?,
        end_unit: r.get(4)?,
        start_time: r.get(5)?,
        end_time: r.get(6)?,
        weeks: serde_json::from_str(&weeks_raw).unwrap_or_default(),
        weeks_str: r.get(8)?,
        room: r.get(9)?,
        building: r.get(10)?,
        campus: r.get(11)?,
        course_name: r.get(12)?,
        course_code: r.get(13)?,
        credits: r.get(14)?,
        teachers: teachers_raw
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
        course_type: r.get(16)?,
        color: r.get(17)?,
    })
}

fn load_sessions(conn: &Connection, account_id: i64, semester_id: i64) -> Result<Vec<CampusSession>> {
    let sql = format!(
        "{SESSION_SELECT} WHERE s.account_id = ?1 AND s.semester_id = ?2 \
         ORDER BY s.weekday, s.start_time, c.course_name"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([account_id, semester_id], session_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn semester_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CampusSemester> {
    Ok(CampusSemester {
        id: r.get(0)?,
        account_id: r.get(1)?,
        remote_id: r.get(2)?,
        code: r.get(3)?,
        name: r.get(4)?,
        school_year: r.get(5)?,
        season: r.get(6)?,
        start_date: r.get(7)?,
        end_date: r.get(8)?,
        week_start_on_sunday: r.get::<_, i64>(9)? != 0,
        total_weeks: r.get(10)?,
        current_week: r.get(11)?,
        is_current: r.get::<_, i64>(12)? != 0,
    })
}

const SEMESTER_SELECT: &str = "SELECT id, account_id, remote_id, code, name, school_year, season, \
     start_date, end_date, week_start_on_sunday, total_weeks, current_week, is_current";

fn load_semester(conn: &Connection, account_id: i64, semester_id: i64) -> Result<CampusSemester> {
    let sql = format!("{SEMESTER_SELECT} FROM campus_semesters WHERE account_id = ?1 AND id = ?2");
    conn.query_row(&sql, rusqlite::params![account_id, semester_id], semester_from_row)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                ReinError::Message("学期不存在，请先同步课表".into())
            }
            other => ReinError::from(other),
        })
}

fn load_all_semesters(conn: &Connection, account_id: i64) -> Result<Vec<CampusSemester>> {
    let sql = format!(
        "{SEMESTER_SELECT} FROM campus_semesters WHERE account_id = ?1 ORDER BY start_date DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([account_id], semester_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 当前学期（`is_current = 1`），没有则退化为最近的一个。
fn current_semester_id(conn: &Connection, account_id: i64) -> Result<Option<i64>> {
    let cur: Option<i64> = conn
        .query_row(
            "SELECT id FROM campus_semesters WHERE account_id = ?1 AND is_current = 1 LIMIT 1",
            [account_id],
            |r| r.get(0),
        )
        .ok();
    if cur.is_some() {
        return Ok(cur);
    }
    Ok(conn
        .query_row(
            "SELECT id FROM campus_semesters WHERE account_id = ?1 ORDER BY start_date DESC LIMIT 1",
            [account_id],
            |r| r.get(0),
        )
        .ok())
}

fn load_courses(conn: &Connection, account_id: i64, semester_id: i64) -> Result<Vec<CampusCourse>> {
    let mut stmt = conn.prepare(
        "SELECT id, semester_id, remote_lesson_id, course_code, course_name, lesson_code, \
         teachers, credits, course_type, color, lesson_name FROM campus_courses \
         WHERE account_id = ?1 AND semester_id = ?2 ORDER BY course_name",
    )?;
    let rows = stmt.query_map([account_id, semester_id], |r| {
        let teachers: Option<String> = r.get(6)?;
        Ok(CampusCourse {
            id: r.get(0)?,
            semester_id: r.get(1)?,
            remote_lesson_id: r.get(2)?,
            course_code: r.get(3)?,
            course_name: r.get(4)?,
            lesson_code: r.get(5)?,
            teachers: teachers
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default(),
            credits: r.get(7)?,
            course_type: r.get(8)?,
            color: r.get(9)?,
            lesson_name: r.get(10)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 该学期的节次时间表（第 N 节 → 起止时刻）。树维那套系统没有这张表 → 空 vec。
///
/// 读路径（打开课表）只查库、不联网：抓取发生在同步里，见 [`persist_period_slots`]。
fn load_period_slots(
    conn: &Connection,
    account_id: i64,
    semester_id: i64,
) -> Result<Vec<RemotePeriodSlot>> {
    let mut stmt = conn.prepare(
        "SELECT unit, start_time, end_time FROM campus_period_slots \
         WHERE account_id = ?1 AND semester_id = ?2 ORDER BY unit",
    )?;
    let rows = stmt.query_map([account_id, semester_id], |r| {
        Ok(RemotePeriodSlot {
            unit: r.get(0)?,
            start_time: r.get(1)?,
            end_time: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 落库节次时间表。**整表替换**：它是学期级配置而不是逐条记录，作息时间改了以后
/// 旧行留一半会出现「第3节有两个时刻」，两半都得清干净。
///
/// 空表也照删（树维每次都传空）：语义是「这个学期没有节次表」，而不是「这次没抓到」。
fn persist_period_slots(
    conn: &Connection,
    account_id: i64,
    semester_id: i64,
    slots: &[RemotePeriodSlot],
) -> Result<()> {
    conn.execute(
        "DELETE FROM campus_period_slots WHERE account_id = ?1 AND semester_id = ?2",
        rusqlite::params![account_id, semester_id],
    )?;
    for s in slots {
        conn.execute(
            "INSERT INTO campus_period_slots (account_id, semester_id, unit, start_time, end_time) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(account_id, semester_id, unit) DO UPDATE SET \
               start_time = excluded.start_time, end_time = excluded.end_time",
            rusqlite::params![account_id, semester_id, s.unit, s.start_time, s.end_time],
        )?;
    }
    Ok(())
}

/// `occurrence_date` 的逆运算：一个公历日期落在第几教学周（1 起）。
/// 早于学期锚点就没有值。`week_start_on_sunday` 两种口径下都成立 —— 锚点本身就是该周第一天。
fn week_of(anchor: NaiveDate, d: NaiveDate) -> Option<i64> {
    let days = (d - anchor).num_days();
    if days < 0 {
        return None;
    }
    Some(days / 7 + 1)
}

/// 把课表展开成「日期 → 当天发生的课」。Rust 侧唯一一处做周次换算的地方，视图与
/// 时间线物化共用它，避免两边公式漂移。
///
/// `plan` 是官方调休计划（开关关闭或数据未就绪时为空，等价于旧行为）：
/// - 放假日：当天原本的课照常展开，只加一枚「假」标；
/// - 补班日：**额外**挂上「被补那天的星期几」在本教学周的课，并标「调」。
///   补班日自己原本的课（如周六本就排的课）不打标 —— 标只说明「这节是被挪过来的」。
fn expand_entries(
    sem: &CampusSemester,
    sessions: &[CampusSession],
    plan: &HolidayPlan,
) -> Vec<ScheduleEntry> {
    let Some(anchor) = semester_anchor(sem) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for s in sessions {
        for &w in &s.weeks {
            let Some(d) = occurrence_date(anchor, w, s.weekday, sem.week_start_on_sunday) else {
                continue;
            };
            let date = d.format("%Y-%m-%d").to_string();
            // 只有放假日给标；补班日的标留给下面额外挂上的那些
            let holiday = if plan.kind(&date) == Some(HolidayKind::Off) {
                Some(HolidayKind::Off)
            } else {
                None
            };
            out.push(ScheduleEntry {
                date,
                week: w,
                session: s.clone(),
                holiday,
            });
        }
    }

    // 调休补课：补班日额外挂上「被补星期几」的课
    for (date, weekday) in plan.makeups() {
        let Some(d) = dates::parse_ymd(date) else {
            continue;
        };
        let Some(w) = week_of(anchor, d) else {
            continue;
        };
        if w < 1 || w > sem.total_weeks {
            continue;
        }
        for s in sessions {
            if s.weekday != *weekday || !s.weeks.contains(&w) {
                continue;
            }
            out.push(ScheduleEntry {
                date: date.clone(),
                week: w,
                session: s.clone(),
                holiday: Some(HolidayKind::Makeup),
            });
        }
    }

    out.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then(a.session.start_time.cmp(&b.session.start_time))
    });
    out
}

/// 左侧时间轴：把「学校公布的节次表」与「实际排课的节次区间」归一化成一组**互斥片段**。
///
/// **为什么不能直接拿 `(start_unit, end_unit)` 去重当行**（旧实现）：节次区间之间会重叠 ——
/// 第1-2节 与 第2-3节 并存时，旧实现画出 `1-2`、`2-3` 两行，于是第2节被画两遍、
/// 一周的视觉长度也不再等于真实时间；3 节连排的课（第8-10节）只占一行，看不出时长。
/// 现在先取断点（每个区间的 `start` 与 `end + 1`），相邻断点之间的片段天然互斥、首尾相接，
/// **同一节次只可能出现一次**；课块再按自己占的节次跨行绘制（前端 `campusTimeAxis.ts`），
/// 行高按真实时长成比例。
///
/// 时刻口径（**只读教务给的数，不插值**）：
/// - 片段内每一节在节次表里都有 → 用表里的逐节真读数（第1节 08:00-08:40 这种）；
/// - 否则取覆盖它的**最紧封套**（覆盖者里最晚的开始 / 最早的结束）。片段内部的课间休息
///   是猜不出来的 —— 猜出来的 08:42 比老实给封套更糟；
/// - 时刻解析不出来的片段直接跳过（沿用旧的容错）。
///
/// 没课的片段不画（第5节没课就没有第5节那一行）：行数与「那天上了几节」对齐。
fn build_time_axis(
    sessions: &[CampusSession],
    period_slots: &[RemotePeriodSlot],
) -> Vec<TimeSlot> {
    use std::collections::{BTreeMap, BTreeSet};

    // 节次表：只收时刻可解析的行。半张表会给出一半真读数一半缺 —— 那比整段退回封套更容易
    // 被读成「教务写错了」，所以要么这一段全用表，要么这一段全不用。
    let table: BTreeMap<i64, (&str, &str)> = period_slots
        .iter()
        .filter(|p| {
            p.unit > 0
                && dates::hhmm_to_min(&p.start_time).is_some()
                && dates::hhmm_to_min(&p.end_time).is_some()
        })
        .map(|p| (p.unit, (p.start_time.as_str(), p.end_time.as_str())))
        .collect();

    // 断点 = 每个区间的 start 与 end+1
    let mut bounds: BTreeSet<i64> = BTreeSet::new();
    for u in table.keys() {
        bounds.insert(*u);
        bounds.insert(u + 1);
    }
    for s in sessions {
        if s.start_unit > 0 && s.end_unit >= s.start_unit {
            bounds.insert(s.start_unit);
            bounds.insert(s.end_unit + 1);
        }
    }
    let bounds: Vec<i64> = bounds.into_iter().collect();

    let mut out: Vec<TimeSlot> = Vec::new();
    for w in bounds.windows(2) {
        let (p, q) = (w[0], w[1] - 1);
        // 没人上的片段不占行（`start_unit = 0` 是实践课，本来就进不了网格）
        let covering: Vec<&CampusSession> = sessions
            .iter()
            .filter(|s| s.start_unit > 0 && s.start_unit <= p && s.end_unit >= q)
            .collect();
        if covering.is_empty() {
            continue;
        }

        // 逐节真读数优先：片段内每一节都要在表里
        let window = (p..=q).map(|u| table.get(&u)).collect::<Option<Vec<_>>>();
        let (start_time, end_time) = match window {
            Some(ws) => (
                ws[0].0.to_string(),
                ws[ws.len() - 1].1.to_string(),
            ),
            // 没有表（或这一段不在表里）→ 最紧封套
            None => {
                let start = covering
                    .iter()
                    .max_by_key(|s| dates::hhmm_to_min(&s.start_time).unwrap_or(-1))
                    .map(|s| s.start_time.clone());
                let end = covering
                    .iter()
                    .min_by_key(|s| dates::hhmm_to_min(&s.end_time).unwrap_or(i64::MAX))
                    .map(|s| s.end_time.clone());
                match (start, end) {
                    (Some(a), Some(b)) => (a, b),
                    _ => continue,
                }
            }
        };

        let (Some(sm), Some(em)) = (
            dates::hhmm_to_min(&start_time),
            dates::hhmm_to_min(&end_time),
        ) else {
            continue;
        };
        out.push(TimeSlot {
            start_unit: p,
            end_unit: q,
            start_time,
            end_time,
            start_min: sm,
            duration_min: (em - sm).max(0),
        });
    }
    // 节次才是行的身份，时刻只是它的展示 —— 所以按节次排，不按 start_min
    out.sort_by_key(|s| (s.start_unit, s.end_unit));
    out
}

/* ─────────────────────────── 时间线物化 ─────────────────────────── */

/// 派生行的备注：把「第几节 · 教室 · 教师」压成一行，时间轴上不开详情就能看清。
fn class_notes(s: &CampusSession) -> Option<String> {
    let mut bits: Vec<String> = Vec::new();
    if s.start_unit > 0 && s.end_unit >= s.start_unit {
        bits.push(if s.start_unit == s.end_unit {
            format!("第{}节", s.start_unit)
        } else {
            format!("第{}-{}节", s.start_unit, s.end_unit)
        });
    }
    let place = match (s.building.as_deref(), s.room.as_deref()) {
        (Some(b), Some(r)) => Some(format!("{b} {r}")),
        (Some(b), None) => Some(b.to_string()),
        (None, Some(r)) => Some(r.to_string()),
        (None, None) => None,
    };
    if let Some(p) = place {
        bits.push(p);
    }
    if !s.teachers.is_empty() {
        bits.push(s.teachers.join("、"));
    }
    if bits.is_empty() {
        None
    } else {
        Some(bits.join(" · "))
    }
}

/// 重建课表在时间线上的派生行，返回写入条数。
///
/// 语义与 `program_schedule_replace` 同款：**先删后建**（幂等）。但多一条不变量——
/// `status = 'done'` 的历史行永不删除，且重建时跳过「已存在完成行」的发生，
/// 否则用户打过卡的课会被重新创建成未完成态，出现同日重复两行。
fn materialize_todos(
    conn: &Connection,
    account_id: i64,
    sem: &CampusSemester,
    sessions: &[CampusSession],
    plan: &HolidayPlan,
) -> Result<i64> {
    conn.execute(
        "DELETE FROM todos WHERE status != 'done' AND course_session_id IN \
         (SELECT id FROM campus_sessions WHERE account_id = ?1)",
        [account_id],
    )?;

    let mut done: HashSet<(i64, String)> = HashSet::new();
    {
        let mut stmt = conn.prepare(
            "SELECT t.course_session_id, t.date FROM todos t \
             WHERE t.status = 'done' AND t.course_session_id IN \
             (SELECT id FROM campus_sessions WHERE account_id = ?1)",
        )?;
        let rows = stmt.query_map([account_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            done.insert(row?);
        }
    }

    let today = Local::now().date_naive();
    let from = today - Duration::days(MATERIALIZE_BACK_DAYS);
    let to = today + Duration::days(MATERIALIZE_FORWARD_DAYS);
    let now = now_iso();
    let mut written = 0i64;

    for entry in expand_entries(sem, sessions, plan) {
        let Some(d) = dates::parse_ymd(&entry.date) else {
            continue;
        };
        if d < from || d > to || done.contains(&(entry.session.id, entry.date.clone())) {
            continue;
        }
        let Some(start_min) = dates::hhmm_to_min(&entry.session.start_time) else {
            continue;
        };
        let duration = dates::hhmm_to_min(&entry.session.end_time)
            .map(|e| e - start_min)
            .filter(|d| *d > 0)
            .unwrap_or(DEFAULT_CLASS_MIN);

        conn.execute(
            "INSERT INTO todos (title, notes, date, start_min, duration_min, category, priority, \
             status, created_at, course_session_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'todo', ?7, ?8)",
            rusqlite::params![
                entry.session.course_name,
                class_notes(&entry.session),
                entry.date,
                start_min,
                duration,
                COURSE_CATEGORY,
                now,
                entry.session.id,
            ],
        )?;
        written += 1;
    }
    Ok(written)
}

/// 给**已经上完**的课表派生行自动打卡（`status='done'`），返回本次翻转的条数。
///
/// 派生行是只读投影，用户在时间线上没法像普通待办那样勾选；这条函数把「上完即打卡」
/// 落成规则：以 `date + start_min + duration_min`（缺 duration 用 [`DEFAULT_CLASS_MIN`]）
/// 为下课时刻，早于「现在」即标完成。只翻未完成的行 —— 已打卡的历史行原样保留，
/// 因此与 [`materialize_todos`] 的「done 行永不删除」不变量相容，幂等可重复调用。
pub(crate) fn auto_complete_past_courses(conn: &Connection) -> Result<usize> {
    let now = Local::now().naive_local();
    let today = now.date().format("%Y-%m-%d").to_string();
    let now_min = now.hour() as i64 * 60 + now.minute() as i64;

    // 只捞可能已经下课的派生行：日期在今之前，或今天且下课时刻已到。
    // 比较口径与前端 `minToHHmm(startMin + durationMin)` 一致（都是距 00:00 的分钟数）。
    let stale: Vec<i64> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM todos \
             WHERE course_session_id IS NOT NULL AND status != 'done' AND date IS NOT NULL \
               AND (date < ?1 \
                    OR (date = ?1 AND start_min IS NOT NULL \
                        AND start_min + COALESCE(duration_min, ?3) <= ?2))",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![today, now_min, DEFAULT_CLASS_MIN],
            |r| r.get::<_, i64>(0),
        )?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if stale.is_empty() {
        return Ok(0);
    }

    let now_s = now_iso();
    let mut completed = 0usize;
    for id in stale {
        completed += conn.execute(
            "UPDATE todos SET status = 'done', completed_at = ?1 \
             WHERE id = ?2 AND status != 'done'",
            rusqlite::params![now_s, id],
        )?;
    }
    Ok(completed)
}

/// 清理远端已消失的时段（换课 / 退课），返回被删掉的时段数。
///
/// **三步的顺序有讲究**，`todos.course_session_id` 是硬外键（本库未对 todos 开级联），
/// 所以删时段之前先把引用它的行安顿好：
/// 1. 未完成的派生行**直接删**——这些课已经不在课表上了，时间线上不该留；
/// 2. 已打卡的历史行**摘掉链接但保留行**——「done 行永不删」是本方案的核心不变量，
///    它与外键冲突时只能让历史行失去来源，绝不能连行一起删。摘链后 title/notes/date
///    仍在，只是不再被识别为课表派生行；
/// 3. 最后才删时段本身。
fn delete_stale_sessions(
    conn: &Connection,
    account_id: i64,
    semester_id: i64,
    kept: &[i64],
) -> Result<i64> {
    let stale_pred = if kept.is_empty() {
        "SELECT id FROM campus_sessions WHERE account_id = ? AND semester_id = ?".to_string()
    } else {
        let placeholders = vec!["?"; kept.len()].join(",");
        format!(
            "SELECT id FROM campus_sessions WHERE account_id = ? AND semester_id = ? \
             AND id NOT IN ({placeholders})"
        )
    };
    let mut params: Vec<&dyn rusqlite::ToSql> = vec![&account_id, &semester_id];
    for id in kept {
        params.push(id);
    }

    let stale_count: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM ({stale_pred})"),
        rusqlite::params_from_iter(params.iter()),
        |r| r.get(0),
    )?;
    if stale_count == 0 {
        return Ok(0);
    }

    conn.execute(
        &format!(
            "DELETE FROM todos WHERE status != 'done' AND course_session_id IN ({stale_pred})"
        ),
        rusqlite::params_from_iter(params.iter()),
    )?;
    conn.execute(
        &format!(
            "UPDATE todos SET course_session_id = NULL \
             WHERE status = 'done' AND course_session_id IN ({stale_pred})"
        ),
        rusqlite::params_from_iter(params.iter()),
    )?;
    conn.execute(
        &format!("DELETE FROM campus_sessions WHERE id IN ({stale_pred})"),
        rusqlite::params_from_iter(params.iter()),
    )?;
    Ok(stale_count)
}

/* ─────────────────────────── 学校系统 / 账号 ─────────────────────────── */

/// 学校系统选择器的数据源。
#[tauri::command]
pub fn campus_systems() -> Vec<SchoolSystemInfo> {
    provider::list_info()
}

/// 当前激活账号（密码与 Cookie 不出 Rust）。
#[tauri::command]
pub fn campus_account_get(state: State<AppState>) -> Result<Option<CampusAccount>> {
    let conn = state.db.lock();
    Ok(load_active_account(&conn)?.map(to_account))
}

/// 取图形验证码，返回**裸 base64**（不带 `data:` 前缀），前端自行拼 data URL。
///
/// 顺带把 salt 与本次会话的 Cookie 存进 [`CampusHub`]：树维把验证码答案绑在会话上，
/// 提交登录必须复用同一个会话，否则必然对不上。用户重新取图时覆盖旧值。
#[tauri::command]
pub async fn campus_captcha(
    hub: State<'_, CampusHub>,
    system_kind: String,
    base_url: String,
    login_name: String,
) -> Result<String> {
    let spec = provider::spec(&system_kind)
        .ok_or_else(|| ReinError::Message(format!("未知的学校系统：{system_kind}")))?;
    let base = base_url.trim().to_string();
    if base.is_empty() {
        return Err(ReinError::Message("服务地址不能为空".into()));
    }
    let key = format!("{base}|{login_name}");

    let (image, pending) =
        tauri::async_runtime::spawn_blocking(move || -> Result<(String, PendingLogin)> {
            let mut session = Session::new(&base, CookieJar::default());

            // 先把会话建起来（树维要取 salt，正方不用）—— 之后的验证码 GET
            // 与随后的登录提交必须挂在这个会话上。
            let mut adapter = AnyAdapter::new(spec, &mut session);
            adapter.warm_login_session()?;
            let image = adapter.fetch_captcha()?;

            Ok((
                image,
                PendingLogin {
                    key,
                    cookies: session.jar().clone(),
                },
            ))
        })
        .await
        .map_err(|e| ReinError::Message(format!("验证码任务失败：{e}")))??;

    *hub.pending.lock().unwrap() = Some(pending);
    Ok(image)
}

/// 登录。`password` 为空时回落到账号里已保存的密码（用于会话过期后的静默重登）。
// Tauri 命令参数必须拍平（前端按名传参），两个 State 注入项占掉了额度，无法靠参数结构体收敛。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn campus_login(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    system_kind: String,
    base_url: String,
    login_name: String,
    password: Option<String>,
    captcha: Option<String>,
    save_password: Option<bool>,
) -> Result<LoginOutcome> {
    let spec = provider::spec(&system_kind)
        .ok_or_else(|| ReinError::Message(format!("未知的学校系统：{system_kind}")))?;
    let base = base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err(ReinError::Message("服务地址不能为空".into()));
    }
    let login_name = login_name.trim().to_string();
    if login_name.is_empty() {
        return Err(ReinError::Message("学号不能为空".into()));
    }
    let key = format!("{base}|{login_name}");
    let want_save = save_password.unwrap_or(true);
    let captcha = captcha.unwrap_or_default();

    // 口令解析：优先用本次输入；没输入就回落到库里存的（重登场景）
    let plain = {
        let conn = state.db.lock();
        let existing: Option<String> = conn
            .query_row(
                "SELECT password FROM campus_accounts WHERE base_url = ?1 AND login_name = ?2",
                rusqlite::params![base, login_name],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
            .filter(|p| !p.is_empty());
        match password.filter(|p| !p.is_empty()) {
            Some(p) => p,
            None => existing.ok_or_else(|| {
                ReinError::Message("请输入密码（该账号没有保存密码，无法自动重登）".into())
            })?,
        }
    };

    // 复用取验证码时建立的会话；没有（用户没走验证码流程，或换过学号）就是一个空 jar。
    // 适配器的 login() 会在这个会话上现取 salt 再加密提交，所以这里只需带对 Cookie。
    let pending = {
        let mut slot = hub.pending.lock().unwrap();
        match slot.as_ref() {
            Some(p) if p.key == key => slot.take(),
            _ => None,
        }
    };

    // 闭包要拿走这几个值，但下面写库还要用，所以先克隆一份进去。
    let base_for_io = base.clone();
    let name_for_io = login_name.clone();
    let plain_for_io = plain.clone();
    let (outcome, cookies) =
        tauri::async_runtime::spawn_blocking(move || -> Result<(LoginOutcome, CookieJar)> {
            let jar = pending.map(|p| p.cookies).unwrap_or_default();
            let mut session = Session::new(&base, jar);
            let outcome = {
                let mut adapter = AnyAdapter::new(spec, &mut session);
                adapter.login(&login_name, &plain, &captcha)?
            };
            Ok((outcome, session.jar().clone()))
        })
        .await
        .map_err(|e| ReinError::Message(format!("登录任务失败：{e}")))??;
    let (base, login_name, plain) = (base_for_io, name_for_io, plain_for_io);

    if !outcome.ok {
        return Ok(outcome);
    }

    // 登录成功：落库。该账号置为激活，其余降级 —— 时间线只投影激活账号的课表，
    // 多账号可以并存但同一时刻只有一个在生效。
    let conn = state.db.lock();
    let now = now_iso();
    // 「不保存密码」要真的把旧密码清掉，不能只写个标记位
    let stored_password: Option<&str> = if want_save { Some(&plain) } else { None };
    conn.execute(
        "INSERT INTO campus_accounts \
         (system_kind, base_url, login_name, password, cookies, session_at, save_password, active, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?6, ?6) \
         ON CONFLICT(base_url, login_name) DO UPDATE SET \
           system_kind = excluded.system_kind, \
           password = excluded.password, \
           cookies = excluded.cookies, \
           session_at = excluded.session_at, \
           save_password = excluded.save_password, \
           active = 1, updated_at = excluded.updated_at",
        rusqlite::params![
            spec.kind,
            base,
            login_name,
            stored_password,
            cookies.to_json(),
            now,
            want_save as i64,
        ],
    )?;
    // 用 (base_url, login_name) 回查真实 id：走 ON CONFLICT 分支时 last_insert_rowid
    // 不指向该账号，不能拿它当依据。
    let active_id: i64 = conn.query_row(
        "SELECT id FROM campus_accounts WHERE base_url = ?1 AND login_name = ?2",
        rusqlite::params![base, login_name],
        |r| r.get(0),
    )?;
    conn.execute(
        "UPDATE campus_accounts SET active = 0 WHERE id != ?1",
        [active_id],
    )?;
    let account = load_active_account(&conn)?.map(to_account);

    // 换了一次登录（Cookie 票据全新），拿旧会话换来的选课令牌也就作废了
    forget_select_token(&hub);

    Ok(LoginOutcome {
        ok: true,
        message: None,
        need_captcha: false,
        action_required: None,
        account,
    })
}

/// 抢课模块开关（课表的子模块，**默认关闭**）。
///
/// 前端的功能开关是权威（`stores/features.ts`），这里负责把它同步给引擎：
/// 关闭时引擎一个请求都不发（连窗口探测都停）。只关界面不关引擎，
/// 等于「用户以为关了，但它还在每分钟问教务」。
///
/// 落库 `app_meta`：重启后仍按上次的开关来 —— 否则关掉再开机会自己又跑起来。
#[tauri::command]
pub fn campus_grab_set_enabled(state: State<AppState>, hub: State<GrabHub>, enabled: bool) -> Result<()> {
    {
        let conn = state.db.lock();
        meta_set(&conn, grab::ENABLED_KEY, if enabled { "1" } else { "0" })?;
    }
    hub.set_enabled_flag(enabled);
    Ok(())
}

/// 会话是否仍然有效。
#[tauri::command]
pub async fn campus_session_probe(state: State<'_, AppState>) -> Result<bool> {
    let account = {
        let conn = state.db.lock();
        require_account(&conn)?
    };
    let spec = account.spec()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<bool> {
        let mut session = account.session();
        AnyAdapter::new(spec, &mut session).probe_session()
    })
    .await
    .map_err(|e| ReinError::Message(format!("会话探测失败：{e}")))?
}

/* ───────────────── 账号生命周期（刻意抽成纯函数：这三段的语义是声明过的，
   而命令层拿不到 State，抽出来才测得了） ───────────────── */

/// 退出登录：只清会话，**保留课表快照与已生成的时间线**（转为只读快照）。
/// 想彻底清数据走 [`delete_account_data`]。
fn clear_session(conn: &Connection, account_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE campus_accounts SET cookies = NULL, session_at = NULL, updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now_iso(), account_id],
    )?;
    Ok(())
}

/// 删除账号：连同课表快照与全部派生日程一起清掉。
///
/// 本库没有对 `todos` 开外键级联，所以派生行必须显式删除
/// （`campus_sessions` / `campus_courses` / `campus_semesters` 由 FK 级联处理）。
fn delete_account_data(conn: &Connection, account_id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM todos WHERE course_session_id IN \
         (SELECT id FROM campus_sessions WHERE account_id = ?1)",
        [account_id],
    )?;
    conn.execute("DELETE FROM campus_accounts WHERE id = ?1", [account_id])?;
    meta_set(conn, &program_cache_key(account_id), "")?;
    Ok(())
}

/// 切换当前学期：改标记 + 把「非当前学期」的未完成派生行清掉，
/// 否则两学期的课会叠在同一条时间线上。已完成的（done）保留为历史。
fn switch_semester(conn: &Connection, account_id: i64, semester_id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM todos WHERE status != 'done' AND course_session_id IN \
         (SELECT id FROM campus_sessions WHERE account_id = ?1 AND semester_id != ?2)",
        rusqlite::params![account_id, semester_id],
    )?;
    conn.execute(
        "UPDATE campus_semesters SET is_current = 0 WHERE account_id = ?1",
        [account_id],
    )?;
    conn.execute(
        "UPDATE campus_semesters SET is_current = 1 WHERE id = ?1",
        [semester_id],
    )?;
    Ok(())
}

/// 退出登录：只清会话，**保留课表快照与已生成的时间线**（转为只读快照）。
/// 想彻底清数据走 `campus_account_delete`。
#[tauri::command]
pub fn campus_logout(state: State<AppState>, hub: State<CampusHub>) -> Result<()> {
    let conn = state.db.lock();
    let account = require_account(&conn)?;
    clear_session(&conn, account.id)?;
    // 选课令牌是用会话换来的，会话没了它也就没有意义
    *hub.select_token.lock().unwrap() = None;
    Ok(())
}

/// 删除账号：连同课表快照与全部派生日程一起清掉。
#[tauri::command]
pub fn campus_account_delete(state: State<AppState>) -> Result<()> {
    let conn = state.db.lock();
    let Some(account) = load_active_account(&conn)? else {
        return Ok(());
    };
    delete_account_data(&conn, account.id)
}

/* ─────────────────────────── 学期 ─────────────────────────── */

#[tauri::command]
pub fn campus_semesters(state: State<AppState>) -> Result<Vec<CampusSemester>> {
    let conn = state.db.lock();
    let Some(account) = load_active_account(&conn)? else {
        return Ok(Vec::new());
    };
    load_all_semesters(&conn, account.id)
}

/// 切换当前学期 —— 只改标记，时间线由 `campus_sync` / `campus_schedule` 重新对齐。
#[tauri::command]
pub fn campus_set_current_semester(state: State<AppState>, semester_id: i64) -> Result<()> {
    let conn = state.db.lock();
    let account = require_account(&conn)?;
    // 只做存在性校验，值本身用不上
    load_semester(&conn, account.id, semester_id)?;
    switch_semester(&conn, account.id, semester_id)
}

/* ─────────────────────────── 同步 ─────────────────────────── */

/// 同步阶段在无锁区间里攒下的全部产物。
struct Fetched {
    cookies: CookieJar,
    semesters: Vec<RemoteSemester>,
    snapshot: TimetableSnapshot,
    target_remote_id: i64,
}

/// 一次抓取尝试：结果 + 「中途换过会话」的痕迹。
///
/// 换过会话就必须落库，**哪怕这次抓取最后还是失败了** ——
/// 否则下次又从零重登一遍，用户看到的还是那句「会话过期，请重新登录」。
struct SyncAttempt {
    fetched: Result<Fetched>,
    refreshed: Option<CookieJar>,
    /// 同一次无锁窗口里顺带抓到的官方调休原始 JSON（年 → 原始文本）。
    /// 失败的年份直接缺席，不影响课表本身。
    holidays: Vec<(i64, String)>,
}

/// 一次完整的课表抓取：课表页面变量 → 选定学期 → 课表数据。
///
/// 单独抽出来是因为它可能被跑两遍 —— 302 会出现在这三步里的任何一步，
/// 只在开头探一次针是拦不住「半程才过期」的。
fn fetch_snapshot(
    spec: &'static SchoolSystemSpec,
    session: &mut Session,
    wanted_remote: Option<i64>,
) -> Result<(Vec<RemoteSemester>, TimetableSnapshot, i64)> {
    let mut adapter = AnyAdapter::new(spec, session);
    // 把「要哪个学期」透给适配器：正方那边学期列表要逐个补周历（起止日期），
    // 默认只取当前学年 ±1 —— 用户翻回很老的学期时，少了这个提示就会静默同步到别的学期。
    let vars = adapter.fetch_page_vars(wanted_remote)?;
    let today = Local::now().date_naive();

    // 选目标学期：显式指定 > 覆盖今天的 > 起始日最晚的
    let target = vars
        .semesters
        .iter()
        .find(|s| wanted_remote == Some(s.id))
        .or_else(|| {
            vars.semesters.iter().find(|s| {
                match (
                    dates::parse_ymd(s.start_date.as_deref().unwrap_or("")),
                    dates::parse_ymd(s.end_date.as_deref().unwrap_or("")),
                ) {
                    (Some(a), Some(b)) => a <= today && today <= b,
                    _ => false,
                }
            })
        })
        .or_else(|| {
            vars.semesters.iter().max_by_key(|s| {
                dates::parse_ymd(s.start_date.as_deref().unwrap_or("")).unwrap_or(today)
            })
        })
        .ok_or_else(|| ReinError::Message("教务系统没有返回可用学期".into()))?;
    let target_remote_id = target.id;

    let snapshot = adapter.fetch_timetable(target_remote_id)?;
    Ok((vars.semesters, snapshot, target_remote_id))
}

/// 远端学期换算成本地记录所需的字段。
struct LocalSemester {
    name: String,
    end_date: String,
    week_start_on_sunday: bool,
    total_weeks: i64,
    current_week: Option<i64>,
}

/// 缺起止日期的学期直接跳过 —— 没有锚点就无法把课落到日历上，存下来也是个死记录。
fn remote_to_local(
    remote: &RemoteSemester,
    spec: &'static SchoolSystemSpec,
    today: NaiveDate,
) -> Option<LocalSemester> {
    let start = dates::parse_ymd(remote.start_date.as_deref()?)?;
    let end = dates::parse_ymd(remote.end_date.as_deref()?)?;
    if end < start {
        return None;
    }
    Some(LocalSemester {
        name: dates::semester_display_name(
            remote.school_year.as_deref(),
            remote.season.as_deref(),
            // 拼不出中文名时退到教务的英文名，再退到学期代码
            remote
                .name_en
                .as_deref()
                .or(remote.code.as_deref())
                .unwrap_or("未命名学期"),
        ),
        end_date: remote.end_date.clone().unwrap_or_default(),
        week_start_on_sunday: remote
            .week_start_on_sunday
            .unwrap_or(spec.term.week_start_on_sunday),
        total_weeks: dates::total_weeks(start, end),
        current_week: dates::current_week(start, end, today),
    })
}

/// 周次集合的**规范形**：排序去重后逗号连接（`5,6,7`）。
///
/// 它有两个用处，都得是规范形才成立：
/// 1. 当 `campus_sessions.weeks_key`（时段身份的一部分，见迁移 0049）；
/// 2. 当 `weeks` 列（JSON）的序列化口径。
///
/// 教务给的 `weekIndexes` 顺序不保证稳定，直接拿原文当键，同一条时段会在两次同步之间
/// 变成两条（旧行被 `delete_stale_sessions` 删掉之前，课表上会短暂重复）。
fn weeks_key(weeks: &[i64]) -> String {
    let mut v: Vec<i64> = weeks.iter().copied().filter(|w| *w > 0).collect();
    v.sort_unstable();
    v.dedup();
    v.iter().map(|w| w.to_string()).collect::<Vec<_>>().join(",")
}

/// 一门课的**一个上课时段**落库，返回 `(教学班 id, 本地课程 id, 本地时段 id)`。
///
/// `None` = 这条活动进不了日历（缺周次 / 星期 / 时刻，例如纯考试安排），调用方计入「已跳过」。
///
/// **周次必须进唯一键**（`weeks_key`）：桂电同一门课会在同一个星期几、同一个节次上按
/// 周次段拆成多条，教师与教室跟着段走 —— 实测样本：
///
/// ```text
/// 健康教育 17311*  周二 6-7 节  5~7 周 黄观凤 / 8~9 韦雪军 / 10~11 杨雁 / 12 马瑞杰
/// 大学生心理健康  周五 8-9 节  3~5 周 信科421308 / 6~12 周 02109Y
/// ```
///
/// 少了这一个维度，后写的那条会把先写的 `weeks` / `room` / `teachers` 覆盖掉，
/// 课表上只剩一个周次段（常常正好不含本周），教师还张冠李戴 —— 用户报的
/// 「课表与实际不符」就是它。
fn persist_activity(
    conn: &Connection,
    account_id: i64,
    semester_id: i64,
    act: &TimetableActivity,
) -> Result<Option<(i64, i64, i64)>> {
    let Some(lesson_id) = act.lesson_id else {
        return Ok(None);
    };
    let (Some(weekday), Some(start_time), Some(end_time)) =
        (act.weekday, act.start_time.as_deref(), act.end_time.as_deref())
    else {
        return Ok(None);
    };
    let key = weeks_key(&act.week_indexes);
    if key.is_empty() {
        return Ok(None);
    }
    let course_name = act
        .course_name
        .clone()
        .or_else(|| act.lesson_name.clone())
        .unwrap_or_else(|| "未命名课程".into());

    conn.execute(
        "INSERT INTO campus_courses \
         (account_id, semester_id, remote_lesson_id, course_code, course_name, lesson_code, \
          lesson_name, teachers, credits, course_type, color) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) \
         ON CONFLICT(account_id, semester_id, remote_lesson_id) DO UPDATE SET \
           course_code = excluded.course_code, course_name = excluded.course_name, \
           lesson_code = excluded.lesson_code, lesson_name = excluded.lesson_name, \
           teachers = excluded.teachers, credits = excluded.credits, \
           course_type = excluded.course_type, color = excluded.color",
        rusqlite::params![
            account_id,
            semester_id,
            lesson_id,
            act.course_code,
            course_name,
            act.lesson_code,
            act.lesson_name,
            serde_json::to_string(&act.teachers)?,
            act.credits,
            act.course_type.as_ref().and_then(|t| t.name_zh.clone()),
            act.bgc,
        ],
    )?;

    let course_id: i64 = conn.query_row(
        "SELECT id FROM campus_courses WHERE account_id = ?1 AND semester_id = ?2 AND remote_lesson_id = ?3",
        rusqlite::params![account_id, semester_id, lesson_id],
        |r| r.get(0),
    )?;

    let start_unit = act.start_unit.unwrap_or(0);
    let weeks: Vec<i64> = key.split(',').filter_map(|w| w.parse().ok()).collect();

    conn.execute(
        "INSERT INTO campus_sessions \
         (account_id, semester_id, course_id, weekday, start_unit, end_unit, start_time, \
          end_time, weeks, weeks_key, weeks_str, room, building, campus, teachers) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15) \
         ON CONFLICT(account_id, semester_id, course_id, weekday, start_unit, start_time, weeks_key) \
         DO UPDATE SET end_unit = excluded.end_unit, end_time = excluded.end_time, \
           weeks = excluded.weeks, weeks_str = excluded.weeks_str, room = excluded.room, \
           building = excluded.building, campus = excluded.campus, teachers = excluded.teachers",
        rusqlite::params![
            account_id,
            semester_id,
            course_id,
            weekday,
            start_unit,
            act.end_unit.unwrap_or(0),
            start_time,
            end_time,
            serde_json::to_string(&weeks)?,
            key,
            act.weeks_str,
            act.room,
            act.building,
            act.campus,
            serde_json::to_string(&act.teachers)?,
        ],
    )?;
    let sid: i64 = conn.query_row(
        "SELECT id FROM campus_sessions WHERE account_id = ?1 AND semester_id = ?2 \
         AND course_id = ?3 AND weekday = ?4 AND start_unit = ?5 AND start_time = ?6 \
         AND weeks_key = ?7",
        rusqlite::params![account_id, semester_id, course_id, weekday, start_unit, start_time, key],
        |r| r.get(0),
    )?;
    Ok(Some((lesson_id, course_id, sid)))
}

/// 课程级的「这门课有哪些老师」= 各时段教师的**去重并集**（按首次出现顺序）。
///
/// 为什么不让 `campus_courses.teachers` 停在「最后一次写入者」：一门课一周多个时段、
/// 按周换教师是常态（桂电的健康教育就是四位老师轮着上）。只留最后一位，
/// 课程清单与详情页会写死成「一直都是他上的」。课表格子读的是**时段级**教师，
/// 这份并集只服务「课程全貌」那一栏。
fn merge_course_teachers(conn: &Connection, account_id: i64, semester_id: i64) -> Result<()> {
    let pairs: Vec<(i64, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT s.course_id, s.teachers FROM campus_sessions s \
             WHERE s.account_id = ?1 AND s.semester_id = ?2 ORDER BY s.weekday, s.start_time",
        )?;
        let rows = stmt.query_map([account_id, semester_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut merged: HashMap<i64, Vec<String>> = HashMap::new();
    for (course_id, raw) in pairs {
        let slot = merged.entry(course_id).or_default();
        let list: Vec<String> = raw
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        for t in list {
            let t = t.trim().to_string();
            if !t.is_empty() && !slot.contains(&t) {
                slot.push(t);
            }
        }
    }

    for (course_id, teachers) in merged {
        if teachers.is_empty() {
            continue;
        }
        conn.execute(
            "UPDATE campus_courses SET teachers = ?1 \
             WHERE id = ?2 AND account_id = ?3 AND semester_id = ?4",
            rusqlite::params![
                serde_json::to_string(&teachers)?,
                course_id,
                account_id,
                semester_id
            ],
        )?;
    }
    Ok(())
}

/// 同步课表：拉课表（会话过期就自愈重试一次）→ 落库 → 重建时间线派生行。
#[tauri::command]
pub async fn campus_sync(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    semester_id: Option<i64>,
) -> Result<SyncOutcome> {
    // ── 短锁：取出账号，并把「本地学期 id」翻译成本次抓取要用的远端 id；
    //    顺带算清「官方调休数据缺哪几年」—— 这次的网络窗口一并把它抓回来
    let (account, wanted_remote, missing_holiday_years) = {
        let conn = state.db.lock();
        let account = require_account(&conn)?;
        let target = match semester_id {
            Some(local_id) => Some(load_semester(&conn, account.id, local_id)?),
            None => current_semester(&conn)?,
        };
        let wanted = target.as_ref().map(|s| s.remote_id);
        let missing: Vec<i64> = target
            .as_ref()
            .map(|s| holiday::years_of(&s.start_date, &s.end_date))
            .unwrap_or_default()
            .into_iter()
            .filter(|y| holiday::cached_raw(&conn, *y).is_none())
            .collect();
        (account, wanted, missing)
    };
    let spec = account.spec()?;
    // account 马上要被搬进闭包，写库阶段还要用 id，所以先取出来
    let account_id = account.id;

    // ── 无锁：网络抓取（撞上会话过期就原地自愈一次）
    let attempt = tauri::async_runtime::spawn_blocking(move || -> SyncAttempt {
        let mut session = account.session();
        let mut refreshed: Option<CookieJar> = None;

        let mut fetched = fetch_snapshot(spec, &mut session, wanted_remote);
        if matches!(&fetched, Err(e) if is_session_lost(e)) {
            match relogin(&account) {
                Ok(jar) => {
                    // 换上新会话把整段重跑。新 Cookie 由命令层落库，这里不碰 DB
                    // （慢网络与 DB 锁不许同时持有，见文件头）。
                    session = Session::new(&account.base_url, jar.clone());
                    refreshed = Some(jar);
                    fetched = fetch_snapshot(spec, &mut session, wanted_remote);
                }
                Err(e) => fetched = Err(e),
            }
        }

        SyncAttempt {
            fetched: fetched.map(|(semesters, snapshot, target_remote_id)| Fetched {
                cookies: session.jar().clone(),
                semesters,
                snapshot,
                target_remote_id,
            }),
            refreshed,
            // 同一个无锁窗口把缺的调休数据也抓回来：公开 CDN，失败静默
            holidays: missing_holiday_years
                .into_iter()
                .filter_map(|y| holiday::fetch_raw(y).ok().map(|raw| (y, raw)))
                .collect(),
        }
    })
    .await
    .map_err(|e| ReinError::Message(format!("同步任务失败：{e}")))?;

    // ── 短锁：落库 + 重建时间线
    let conn = state.db.lock();

    // 中途换过会话就先把它写死：这一步之后再出闪失，也不至于白换一次
    // （下一次调用——包括培养方案、选课、抢课引擎——直接就能用上新会话）。
    if let Some(jar) = &attempt.refreshed {
        persist_session(&conn, account_id, jar)?;
        forget_select_token(&hub);
    }
    // 顺带抓到的官方调休数据在这一并落缓存。放在 `fetched?` 之前读，避免 `attempt` 被部分移动。
    for (year, raw) in &attempt.holidays {
        let _ = holiday::cache_raw(&conn, *year, raw);
    }
    let fetched = attempt.fetched?;

    let today = Local::now().date_naive();
    let now = now_iso();

    for remote in &fetched.semesters {
        let Some(local) = remote_to_local(remote, spec, today) else {
            continue;
        };
        let is_current = (remote.id == fetched.target_remote_id) as i64;
        conn.execute(
            "INSERT INTO campus_semesters \
             (account_id, remote_id, code, name, school_year, season, start_date, end_date, \
              week_start_on_sunday, total_weeks, current_week, is_current) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
             ON CONFLICT(account_id, remote_id) DO UPDATE SET \
               code = excluded.code, name = excluded.name, school_year = excluded.school_year, \
               season = excluded.season, start_date = excluded.start_date, \
               end_date = excluded.end_date, week_start_on_sunday = excluded.week_start_on_sunday, \
               total_weeks = excluded.total_weeks, current_week = excluded.current_week, \
               is_current = excluded.is_current",
            rusqlite::params![
                account_id,
                remote.id,
                remote.code,
                local.name,
                remote.school_year,
                remote.season,
                remote.start_date,
                local.end_date,
                local.week_start_on_sunday as i64,
                local.total_weeks,
                local.current_week,
                is_current,
            ],
        )?;
    }
    // 目标学期以外的都取消当前标记，保证 is_current 唯一
    conn.execute(
        "UPDATE campus_semesters SET is_current = 0 WHERE account_id = ?1 AND remote_id != ?2",
        rusqlite::params![account_id, fetched.target_remote_id],
    )?;
    let semester_local_id: i64 = conn.query_row(
        "SELECT id FROM campus_semesters WHERE account_id = ?1 AND remote_id = ?2",
        rusqlite::params![account_id, fetched.target_remote_id],
        |r| r.get(0),
    )?;

    // 课程 + 上课时段
    let mut skipped = 0i64;
    let mut course_ids: HashMap<i64, i64> = HashMap::new();
    let mut kept_session_ids: Vec<i64> = Vec::new();

    for act in &fetched.snapshot.activities {
        match persist_activity(&conn, account_id, semester_local_id, act)? {
            Some((lesson_id, course_id, sid)) => {
                course_ids.insert(lesson_id, course_id);
                kept_session_ids.push(sid);
            }
            None => skipped += 1,
        }
    }

    // 远端已消失的时段（换课/退课）
    delete_stale_sessions(&conn, account_id, semester_local_id, &kept_session_ids)?;
    // 课程级教师回收成「各时段教师的并集」：一门课按周换人时，单看最后一次写入会误导
    merge_course_teachers(&conn, account_id, semester_local_id)?;

    // 节次时间表（正方有、树维没有）：左侧时间轴的逐节真读数。**只在同步里抓、只在同步里写**，
    // 打开课表那条路只读库 —— 否则每次进课表页都要多打一次教务（见文件头那条铁律）。
    persist_period_slots(
        &conn,
        account_id,
        semester_local_id,
        &fetched.snapshot.period_slots,
    )?;

    // 账号档案 + 会话
    conn.execute(
        "UPDATE campus_accounts SET cookies = ?1, session_at = ?2, student_id = ?3, \
         student_code = ?4, student_name = ?5, department = ?6, major = ?7, adminclass = ?8, \
         grade = ?9, total_credits = ?10, last_sync_at = ?2, updated_at = ?2 WHERE id = ?11",
        rusqlite::params![
            fetched.cookies.to_json(),
            now,
            fetched.snapshot.student_id,
            fetched.snapshot.student_code,
            fetched.snapshot.student_name,
            fetched.snapshot.department,
            fetched.snapshot.major,
            fetched.snapshot.adminclass,
            fetched.snapshot.grade,
            fetched.snapshot.total_credits,
            account_id,
        ],
    )?;

    let semester = load_semester(&conn, account_id, semester_local_id)?;
    let sessions = load_sessions(&conn, account_id, semester_local_id)?;
    // 调休数据刚在上面并入缓存，这里就地组装计划（纯本地、无网络），全程持锁同步完成 ——
    // 锁绝不跨 await（三段式铁律）。
    let years = holiday::years_of(&semester.start_date, &semester.end_date);
    let plan = holiday::plan_from_cache(&conn, &years, &HolidayConfig::load(&conn));
    let todos_written = materialize_todos(&conn, account_id, &semester, &sessions, &plan)?;

    // 整学期的时段已按新键重写完毕：迁移留下的「待重同步」标记到此失效。
    // 放在这里而不是入口处 —— 只有真正跑完整条落库链路才算补上了被并掉的周次段。
    crate::db::meta_del(&conn, SESSIONS_NEED_RESYNC)?;

    Ok(SyncOutcome {
        courses: course_ids.len() as i64,
        sessions: sessions.len() as i64,
        todos_written,
        semester_id: semester_local_id,
        semester_name: semester.name,
        synced_at: now,
        skipped_activities: skipped,
    })
}

/* ─────────────────────────── 课表视图 ─────────────────────────── */

/// 读课表。返回指定日期区间内的每一节课，以及左侧时间轴用的节次表。
///
/// 顺带把时间线窗口重新对齐到今天：物化窗口是「过去一周 + 未来五周」的滚动区间，
/// App 放几天再打开时窗口会漂移。这里重建一次（纯本地、幂等、百来行），
/// 让「打开课表 = 时间线也最新」这个不变量成立，代价远低于一次网络同步。
#[tauri::command]
pub fn campus_schedule(
    state: State<AppState>,
    semester_id: Option<i64>,
    from: Option<String>,
    to: Option<String>,
) -> Result<ScheduleView> {
    let conn = state.db.lock();
    campus_schedule_on(&conn, semester_id, from, to)
}

/// `campus_schedule` 的本体：收 `&Connection` 而不是 `State`，供 tauri 命令与对外网关共用
/// （网关拿的是同一把 `state.db.lock()`，见 contract §6.1 单连接铁律）。
///
/// **副作用（契约 §13.2 认账）**：内部调用 `materialize_todos` 把课表派生行写进 `todos`，
/// 并调用 `auto_complete_past_courses` 给已下课的派生行自动打卡 —— 都是幂等的本地写，
/// 会被同步钩子捕获。对外语义仍是「读课表」，否则「今天日程」会缺课表行。
pub(crate) fn campus_schedule_on(
    conn: &Connection,
    semester_id: Option<i64>,
    from: Option<String>,
    to: Option<String>,
) -> Result<ScheduleView> {
    schedule_view_on(conn, semester_id, from, to, true)
}

/// 对外网关读路径专用：**只做投影、绝不写库**的课表视图。
///
/// 与 [`campus_schedule_on`] 的唯一差别是跳过 `materialize_todos` / `auto_complete_past_courses`。
/// 理由在权限模型上：网关的 `schedule.read` 只授了「读」，而 `materialize_todos` 开头就是
/// `DELETE FROM todos WHERE status != 'done' AND course_session_id IN (本账号会话)` ——
/// 拿读权限能删掉用户没打完卡的派生待办，是不能有的写副作用。
/// 课表视图本身读 `campus_sessions`（不依赖派生行），跳过物化不影响返回内容。
pub(crate) fn campus_schedule_readonly_on(
    conn: &Connection,
    semester_id: Option<i64>,
    from: Option<String>,
    to: Option<String>,
) -> Result<ScheduleView> {
    schedule_view_on(conn, semester_id, from, to, false)
}

/// [`campus_schedule_on`] / [`campus_schedule_readonly_on`] 的共用本体。
///
/// `rebuild` = 是否重建时间线派生行（`materialize_todos` + 自动打卡）：
/// tauri 命令（= 前端语义）要那一步，否则「今天日程」会缺课表行；网关读路径不要。
fn schedule_view_on(
    conn: &Connection,
    semester_id: Option<i64>,
    from: Option<String>,
    to: Option<String>,
    rebuild: bool,
) -> Result<ScheduleView> {
    let account = load_active_account(conn)?;
    let Some(account) = account else {
        return Ok(ScheduleView {
            account: None,
            semester: None,
            entries: Vec::new(),
            time_slots: Vec::new(),
            courses: Vec::new(),
            needs_resync: false,
        });
    };

    let Some(sem_id) = (match semester_id {
        Some(id) => Some(id),
        None => current_semester_id(conn, account.id)?,
    }) else {
        return Ok(ScheduleView {
            account: Some(to_account(account)),
            semester: None,
            entries: Vec::new(),
            time_slots: Vec::new(),
            courses: Vec::new(),
            needs_resync: false,
        });
    };

    let sem = load_semester(conn, account.id, sem_id)?;
    let sessions = load_sessions(conn, account.id, sem_id)?;
    // 调休计划**只从缓存组装**：打开课表这条路上不该出现网络请求（联网补缓存见 `campus_sync`）
    let years = holiday::years_of(&sem.start_date, &sem.end_date);
    let plan = holiday::plan_from_cache(conn, &years, &HolidayConfig::load(conn));
    if rebuild {
        materialize_todos(conn, account.id, &sem, &sessions, &plan)?;
        // 重建后立刻补一遍自动打卡：物化会把过去的课重新插成未完成，这一步让「上完=已打卡」
        // 在打开课表/时间线的当下就成立。
        auto_complete_past_courses(conn)?;
    }

    let today = Local::now().date_naive();
    let lo = from
        .as_deref()
        .and_then(dates::parse_ymd)
        .unwrap_or_else(|| today - Duration::days(MATERIALIZE_BACK_DAYS));
    let hi = to
        .as_deref()
        .and_then(dates::parse_ymd)
        .unwrap_or_else(|| today + Duration::days(MATERIALIZE_FORWARD_DAYS));
    let (lo_s, hi_s) = (
        lo.format("%Y-%m-%d").to_string(),
        hi.format("%Y-%m-%d").to_string(),
    );

    let entries = expand_entries(&sem, &sessions, &plan)
        .into_iter()
        .filter(|e| e.date >= lo_s && e.date <= hi_s)
        .collect();
    let time_slots = build_time_axis(&sessions, &load_period_slots(conn, account.id, sem_id)?);
    let courses = load_courses(conn, account.id, sem_id)?;

    Ok(ScheduleView {
        account: Some(to_account(account)),
        semester: Some(sem),
        entries,
        time_slots,
        courses,
        // 老库（0049 之前）里被唯一键并掉的周次段只能靠一次真同步补回来：
        // 把标记透给页面，由它替用户跑那一次（见 `pages/SchedulePage.vue`）。
        needs_resync: meta_get(conn, SESSIONS_NEED_RESYNC).is_some(),
    })
}

/* ─────────────────────────── 官方调休映射 ─────────────────────────── */

/// 当前激活账号的当前学期。
fn current_semester(conn: &Connection) -> Result<Option<CampusSemester>> {
    let Some(account) = load_active_account(conn)? else {
        return Ok(None);
    };
    let Some(sem_id) = current_semester_id(conn, account.id)? else {
        return Ok(None);
    };
    Ok(Some(load_semester(conn, account.id, sem_id)?))
}

/// 重建时间线所需的全部输入；没绑账号 / 没选学期时为 None。
fn timeline_inputs(conn: &Connection) -> Result<Option<(i64, CampusSemester, Vec<CampusSession>)>> {
    let Some(account) = load_active_account(conn)? else {
        return Ok(None);
    };
    let Some(sem_id) = current_semester_id(conn, account.id)? else {
        return Ok(None);
    };
    let sem = load_semester(conn, account.id, sem_id)?;
    let sessions = load_sessions(conn, account.id, sem_id)?;
    Ok(Some((account.id, sem, sessions)))
}

/// 该关心的年份：当前学期覆盖到的那些；没有学期时退到今年（设置页总得能看到点什么）。
fn holiday_years(conn: &Connection) -> Vec<i64> {
    if let Ok(Some(sem)) = current_semester(conn) {
        let ys = holiday::years_of(&sem.start_date, &sem.end_date);
        if !ys.is_empty() {
            return ys;
        }
    }
    vec![Local::now().year() as i64]
}

/// 补齐官方调休数据缓存。**三段式**：短锁读缺哪些年 → 无锁联网 → 短锁写回。
///
/// 全程失败静默：调休只是锦上添花，数据源不可达时课表照常，不该连累同步。
async fn holiday_ensure_cached(db: &Db, years: &[i64]) {
    let missing: Vec<i64> = {
        let conn = db.lock();
        years
            .iter()
            .copied()
            .filter(|y| holiday::cached_raw(&conn, *y).is_none())
            .collect()
    };
    if missing.is_empty() {
        return;
    }

    let fetched = tauri::async_runtime::spawn_blocking(move || {
        missing
            .into_iter()
            .filter_map(|y| holiday::fetch_raw(y).ok().map(|raw| (y, raw)))
            .collect::<Vec<(i64, String)>>()
    })
    .await
    .unwrap_or_default();
    if fetched.is_empty() {
        return;
    }

    let conn = db.lock();
    for (year, raw) in fetched {
        let _ = holiday::cache_raw(&conn, year, &raw);
    }
}

/// 带上调休映射地重建时间线派生行（`campus_sync` 与配置页改开关后都走它）。
async fn materialize_with_holiday(
    db: &Db,
    account_id: i64,
    sem: &CampusSemester,
    sessions: &[CampusSession],
) -> Result<i64> {
    let years = holiday::years_of(&sem.start_date, &sem.end_date);
    let cfg = {
        let conn = db.lock();
        HolidayConfig::load(&conn)
    };
    if cfg.enabled {
        holiday_ensure_cached(db, &years).await;
    }
    let conn = db.lock();
    let plan = holiday::plan_from_cache(&conn, &years, &cfg);
    let written = materialize_todos(&conn, account_id, sem, sessions, &plan)?;
    auto_complete_past_courses(&conn)?;
    Ok(written)
}

/// 调休映射配置：开关 + 按日期的手动覆盖 + 当前生效的映射（供设置页展示/纠正）。
///
/// 顺带把缺失的年份补进缓存（联网），这样「进设置页」就等于「数据已就绪」，
/// 之后打开课表只读缓存、不发请求。
#[tauri::command]
pub async fn campus_holiday_config_get(state: State<'_, AppState>) -> Result<HolidayConfigView> {
    let (cfg, years) = {
        let conn = state.db.lock();
        (HolidayConfig::load(&conn), holiday_years(&conn))
    };
    if cfg.enabled {
        holiday_ensure_cached(&state.db, &years).await;
    }

    let conn = state.db.lock();
    let tables: Vec<holiday::HolidayYear> = years
        .iter()
        .filter_map(|y| holiday::cached_raw(&conn, *y))
        .filter_map(|raw| holiday::parse(&raw).ok())
        .collect();
    // 生效映射 = 推断 ∪ 覆盖；覆盖值原样带出（含 `0` = 不补），好让那一行留在列表里可再改回
    let mut makeups = holiday::infer_makeups(&tables);
    for (date, wd) in &cfg.overrides {
        makeups.insert(date.clone(), *wd);
    }

    Ok(HolidayConfigView {
        enabled: cfg.enabled,
        overrides: cfg.overrides,
        makeups,
        years,
    })
}

/// 写调休映射配置。开关或覆盖一变，时间线里的派生行要立刻跟着变。
#[tauri::command]
pub async fn campus_holiday_config_set(
    state: State<'_, AppState>,
    config: HolidayConfig,
) -> Result<()> {
    {
        let conn = state.db.lock();
        config.save(&conn)?;
    }
    let inputs = {
        let conn = state.db.lock();
        timeline_inputs(&conn)?
    };
    let Some((account_id, sem, sessions)) = inputs else {
        return Ok(());
    };
    materialize_with_holiday(&state.db, account_id, &sem, &sessions).await?;
    Ok(())
}

/* ─────────────────────────── 培养方案 ─────────────────────────── */

fn program_cache_key(account_id: i64) -> String {
    format!("campus_program:{account_id}")
}

/// 培养方案一次拉取的结果 + 「中途换过会话」的痕迹（与 [`SyncAttempt`] 同理）。
struct ProgramAttempt {
    raw: Result<serde_json::Value>,
    refreshed: Option<CookieJar>,
}

/// 培养方案原始 JSON（响应可达 900KB+，拉一次落 `app_meta` 缓存，之后离线可读）。
/// `refresh = true` 时强制重拉。
#[tauri::command]
pub async fn campus_program(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    refresh: Option<bool>,
) -> Result<serde_json::Value> {
    let (account, cache_key, cached) = {
        let conn = state.db.lock();
        let account = require_account(&conn)?;
        let key = program_cache_key(account.id);
        let cached = meta_get(&conn, &key).filter(|s| !s.is_empty());
        (account, key, cached)
    };

    if !refresh.unwrap_or(false) {
        if let Some(raw) = cached {
            if let Ok(v) = serde_json::from_str(&raw) {
                return Ok(v);
            }
        }
    }

    let account_id = account.id;
    let student_id = account
        .student_id
        .clone()
        .ok_or_else(|| ReinError::Message("缺少学生标识，请先同步一次课表".into()))?;
    let spec = account.spec()?;

    // ── 无锁：拉取（会话过期就自愈一次）
    let attempt = tauri::async_runtime::spawn_blocking(move || -> ProgramAttempt {
        let mut session = account.session();
        let mut refreshed: Option<CookieJar> = None;

        let mut raw = {
            let mut adapter = AnyAdapter::new(spec, &mut session);
            adapter.fetch_program_info(&student_id)
        };
        if matches!(&raw, Err(e) if is_session_lost(e)) {
            match relogin(&account) {
                Ok(jar) => {
                    session = Session::new(&account.base_url, jar.clone());
                    refreshed = Some(jar);
                    raw = AnyAdapter::new(spec, &mut session).fetch_program_info(&student_id);
                }
                Err(e) => raw = Err(e),
            }
        }
        ProgramAttempt { raw, refreshed }
    })
    .await
    .map_err(|e| ReinError::Message(format!("培养方案任务失败：{e}")))?;

    if let Some(jar) = &attempt.refreshed {
        let conn = state.db.lock();
        persist_session(&conn, account_id, jar)?;
        forget_select_token(&hub);
    }
    let raw = attempt.raw?;

    {
        let conn = state.db.lock();
        meta_set(&conn, &cache_key, &serde_json::to_string(&raw)?)?;
    }
    Ok(raw)
}

/* ─────────────────────────── 课程详情 ─────────────────────────── */

/// 课程详情一次拉取的结果 + 「中途换过会话」的痕迹（与 [`SyncAttempt`] 同理）。
struct DetailAttempt {
    out: Result<CourseDetail>,
    refreshed: Option<CookieJar>,
}

/// 课程详情：实时拉一次课表，把一门课拼成完整档案（容量 / 考试类别 / 学时构成 / 周次…）。
///
/// **每次实时拉而不读库**：容量与已选人数会随选课进程变化，库里缓存的「已选 51/52」
/// 下一秒就可能变成「52/52」—— 而那正是用户点开详情最想知道的一件事。
///
/// `weekday` / `start_unit` / `week` 用于同一门课一周上多次、或按周次段换教师换教室时
/// 定位到用户点的那一格；都传 `None` 时给该课的第一个时段。
#[tauri::command]
pub async fn campus_course_detail(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    semester_id: i64,
    lesson_id: i64,
    weekday: Option<i64>,
    start_unit: Option<i64>,
    week: Option<i64>,
) -> Result<CourseDetail> {
    // ── 短锁：取账号 + 本地学期 id → 远端 id + 学期显示名
    let (account, remote_id, semester_name) = {
        let conn = state.db.lock();
        let account = require_account(&conn)?;
        let semester = load_semester(&conn, account.id, semester_id)?;
        (account, semester.remote_id, semester.name)
    };
    let spec = account.spec()?;
    let account_id = account.id;

    // ── 无锁：网络拉取（会话过期就自愈一次，与 `campus_program` 同款）
    let attempt = tauri::async_runtime::spawn_blocking(move || -> DetailAttempt {
        let mut session = account.session();
        let mut refreshed: Option<CookieJar> = None;

        let fetch = |session: &mut Session| -> Result<CourseDetail> {
            AnyAdapter::new(spec, session).fetch_course_detail(
                remote_id,
                &semester_name,
                lesson_id,
                weekday,
                start_unit,
                week,
            )
        };

        let mut out = fetch(&mut session);
        if matches!(&out, Err(e) if is_session_lost(e)) {
            match relogin(&account) {
                Ok(jar) => {
                    session = Session::new(&account.base_url, jar.clone());
                    refreshed = Some(jar);
                    out = fetch(&mut session);
                }
                Err(e) => out = Err(e),
            }
        }
        DetailAttempt { out, refreshed }
    })
    .await
    .map_err(|e| ReinError::Message(format!("课程详情任务失败：{e}")))?;

    if let Some(jar) = &attempt.refreshed {
        let conn = state.db.lock();
        persist_session(&conn, account_id, jar)?;
        forget_select_token(&hub);
    }
    attempt.out
}

/* ─────────────────────────── 选课（course-selection-api） ─────────────────────────── */

/// 一次选课调用的全套上下文：客户端 + 学生 id + 账号 id。
///
/// 抽出来是因为**抢课引擎也要用它**（见 `grab.rs`），而账号密码 / Cookie 这些
/// 只在 `AccountRow` 里流转的内部形状不该泄出本模块 —— 引擎只需要「能发请求」和「我是谁」。
pub(crate) struct SelectContext {
    pub client: CourseSelectClient,
    pub student_id: i64,
    pub account_id: i64,
    /// **第二个域上的客户端**（「抢课时两个域都发」用）。
    ///
    /// `None` = 只有账号自己那个域可用，原因见 `mirror_note`。
    /// 这不是降级 —— 本科教务的两个域名**不是同一套系统**：
    /// 实测 bkjw 的 `/student/**` 全部 404（连静态资源都没有），
    /// 对它盲发选课请求只会拿到 404，既浪费一次出手机会，
    /// 又会在结果面上留一条把人引向错误方向的「失败」。
    pub mirror: Option<CourseSelectClient>,
    /// 没有第二个域可发时的原因（可直接显示）。
    pub mirror_note: String,
}

/// 取选课上下文。缓存命中则零网络；未命中才去门户换一张令牌。
///
/// 收 `&Db` 而不是 `&Connection`：这条路上有网络（换令牌、必要时重登），
/// 而网络期间绝不能攥着 DB 锁 —— 锁的进出由本函数自己安排。
pub(crate) fn select_context(db: &Db, hub: &CampusHub) -> Result<SelectContext> {
    let account = {
        let conn = db.lock();
        require_account(&conn)?
    };
    match build_select_context(hub, &account) {
        Ok(ctx) => Ok(ctx),
        // 令牌换不出来，十有八九是 EAMS 会话死了（`acquire` 见 302 就报这个）。
        // 先自愈再换一次 —— 抢课引擎走的也是这条路，所以它不会因为会话过期停摆。
        Err(e) if is_session_lost(&e) => {
            recover_session(db, hub, &account)?;
            // 重新读一次账号：新会话刚写进库里，手上这份还是旧的（旧 Cookie 换不出新令牌）
            let account = {
                let conn = db.lock();
                require_account(&conn)?
            };
            build_select_context(hub, &account)
        }
        Err(e) => Err(e),
    }
}

/// 取上下文本身。抽出来是为了让上面那段「失败 → 自愈 → 重来一次」读起来像一句话。
fn build_select_context(hub: &CampusHub, account: &AccountRow) -> Result<SelectContext> {
    let client = select_client(hub, account)?;
    let (mirror, mirror_note) = mirror_client(hub, account, &client);
    Ok(SelectContext {
        client,
        student_id: select_student_id(account)?,
        account_id: account.id,
        mirror,
        mirror_note,
    })
}

/// 「抢课时两个域都发」里的**第二个域**。
///
/// 关键是**先探测再发**：两个域名不是同一套系统，对没有 EAMS5 的那个盲发只会 404。
/// 探测结果缓存在 `CampusHub::dual_fire`（十分钟），因为引擎每 2 秒走一步，
/// 而「这个域提不提供 EAMS5」是很少变的事实。
///
/// 只有探测到第二个域**确实提供 EAMS5** 时才建客户端：那说明它可能是同一套系统的
/// 另一个部署，两边都发才是有意义的冗余。
fn mirror_client(
    hub: &CampusHub,
    account: &AccountRow,
    primary: &CourseSelectClient,
) -> (Option<CourseSelectClient>, String) {
    let plan = dual_fire_plan(hub, account);
    let primary_base = provider::normalize_base(primary.host());

    let Some(base) = plan
        .targets
        .iter()
        .find(|b| **b != primary_base)
        .cloned()
    else {
        return (None, plan.note);
    };

    // 换域换令牌：第二个域上的选课令牌要单独去它自己的门户换一张。
    // 换不出来只说明这个域这条路不通 —— 不能因此挡住主域的抢课。
    match CourseSelectClient::acquire(&base, CookieJar::from_json(account.cookies.as_deref())) {
        Ok(c) => (Some(c), plan.note),
        Err(e) => (
            None,
            format!("{base} 上的选课令牌没换出来（{e}），本次只在主域发送"),
        ),
    }
}

/// 取「两个域都发」的计划，命中缓存则零网络。
fn dual_fire_plan(hub: &CampusHub, account: &AccountRow) -> lesson_search::DualFirePlan {
    let now = Utc::now().timestamp_millis();
    if let Ok(slot) = hub.dual_fire.lock() {
        if let Some(c) = slot.as_ref() {
            if c.account_id == account.id && now - c.at_ms < crate::state::DUAL_FIRE_TTL_MS {
                return c.plan.clone();
            }
        }
    }

    // 缓存未命中：探测两个域（各两次网络请求）。**不持锁**。
    let probes: Vec<SchoolDomainProbe> = provider::GUET_DOMAINS
        .iter()
        .map(|b| lesson_search::probe_domain(b))
        .collect();
    let plan = lesson_search::plan_dual_fire(&account.base_url, &probes);

    if let Ok(mut slot) = hub.dual_fire.lock() {
        *slot = Some(crate::state::DualFireCache {
            account_id: account.id,
            at_ms: now,
            plan: plan.clone(),
        });
    }
    plan
}

/// 取选课客户端。缓存命中则零网络；未命中才去门户换一张令牌。
fn select_client(hub: &CampusHub, account: &AccountRow) -> Result<CourseSelectClient> {
    if let Some(token) = hub.cached_select_token(account.id) {
        return Ok(CourseSelectClient::with_token(&account.base_url, token));
    }
    let client = CourseSelectClient::acquire(
        &account.base_url,
        CookieJar::from_json(account.cookies.as_deref()),
    )?;
    *hub.select_token.lock().unwrap() = Some(CourseSelectToken {
        account_id: account.id,
        token: client.token().to_string(),
        expires_at: client.expires_at(),
    });
    Ok(client)
}

/// 选课子系统里的学生 id（`241250`）。取自课表同步时落下的 `student_id`，
/// 与 `print-data` 里的 `studentTableVms[0].id` 是同一个值。
fn select_student_id(account: &AccountRow) -> Result<i64> {
    account
        .student_id
        .as_deref()
        .and_then(|s| s.parse::<i64>().ok())
        .ok_or_else(|| ReinError::Message("缺少学生标识，请先同步一次课表".into()))
}


/* ───────────────────── 全校开课查询 · 两个域都检测 ───────────────────── */

/// **两个域都检测**：分别探明每个域名上到底有什么。
///
/// 有意只打不需要登录的探测点（入口页 + EAMS5 静态资源）：
/// 「另一个域是什么」这个问题不该要求用户先登录一遍才能问。
/// 结果**按域名分别汇报**，不合并 —— 两个域不是同一套系统，
/// 合并会把「这个域压根没有 EAMS5」伪装成「两个域都没这门课」。
#[tauri::command]
pub async fn campus_lesson_search_probe() -> Result<Vec<SchoolDomainProbe>> {
    tauri::async_runtime::spawn_blocking(|| {
        provider::GUET_DOMAINS
            .iter()
            .map(|base| lesson_search::probe_domain(base))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| ReinError::Message(format!("域名探测失败：{e}")))
}

/// **全校开课查询**：先在两个域上找「开课查询」这条路，再用找得到的那个域查名单。
///
/// 与选课的关键区别：**不依赖选课批次**。批次没开的时候照样能查全校开了哪些课，
/// 这正是「提前规划抢什么」的依据（先看清开课名单与时间地点，再去排志愿）。
///
/// 两个域都用不了时**不静默降级**：把两个域的探测结论一起返回，
/// 让界面能说清「是哪个域 404、哪个域连不上」，而不是笼统报一句失败。
#[tauri::command]
pub async fn campus_lesson_search(
    state: State<'_, AppState>,
    semester_id: i64,
    page: Option<i64>,
    page_size: Option<i64>,
) -> Result<LessonSearchOutcome> {
    // 不收 `hub`：这条路上没有需要缓存的东西。探测结论随回执一起交回前端
    // （每个域两条请求，一次查询多打四条），而开课查询不是每 2 秒跑一次的东西 ——
    // 它是用户点一下才跑一次，实打实去探反而保证「看到的就是此刻的实情」。
    // （抢课引擎不一样，它每 2 秒走一步，所以那里必须缓存，见 `dual_fire_plan`。）
    // 短锁读账号：探测与查询都是网络，绝不能持锁（见文件头那条铁律）。
    let account = {
        let conn = state.db.lock();
        require_account(&conn)?
    };
    let jar = CookieJar::from_json(account.cookies.as_deref());
    let student_id = select_student_id(&account)?;
    let spec = provider::spec(&account.system_kind)
        .ok_or_else(|| ReinError::Message(format!("未知的学校系统：{}", account.system_kind)))?;

    tauri::async_runtime::spawn_blocking(move || -> Result<LessonSearchOutcome> {
        // ① 两个域都探测（不依赖会话）
        let domains: Vec<SchoolDomainProbe> = provider::GUET_DOMAINS
            .iter()
            .map(|base| lesson_search::probe_domain(base))
            .collect();

        // ② 优先用「账号当前登录的那个域」，其次用探测到有 EAMS5 的那个。
        //    顺序有意义：账号的 Cookie 只在自己那个域上有效，
        //    换域去查只会拿到 302（会话在别的域不存在）。
        let account_base = provider::normalize_base(&account.base_url);
        let mut candidates: Vec<String> = vec![account_base.clone()];
        for d in &domains {
            if d.eams_assets && d.base_url != account_base {
                candidates.push(d.base_url.clone());
            }
        }

        let q = LessonSearchQuery {
            semester_id,
            page,
            page_size,
        };
        let mut last_err: Option<String> = None;
        for base in candidates {
            let mut session = Session::new(&base, jar.clone());
            let mut client = LessonSearchClient::new(spec, &mut session);
            // 页面能打开才继续；打不开（404/302）就换下一个候选域
            if let Err(e) = client.open(&student_id.to_string()) {
                last_err = Some(format!("{base}：{e}"));
                continue;
            }
            let semesters = client.semesters().unwrap_or_default();
            match client.search(&student_id.to_string(), &q) {
                Ok(page) => {
                    return Ok(LessonSearchOutcome {
                        domains,
                        used_base_url: Some(base),
                        page,
                        semesters,
                    })
                }
                Err(e) => last_err = Some(format!("{base}：{e}")),
            }
        }

        // 两个域都没成：把探测结论一并交回，让界面能说清是哪个域不行
        Err(ReinError::Message(format!(
            "两个域名都没有可用的开课查询：{}",
            last_err.unwrap_or_else(|| "未探测到任何候选域名".into())
        )))
    })
    .await
    .map_err(|e| ReinError::Message(format!("开课查询任务失败：{e}")))?
}
/// 选课子系统状态：令牌就绪情况 + 服务器时间 + 学生档案 + 开放中的批次。
///
/// **批次列表为空是正常状态**（大一新生还没轮到选课窗口时就是空的），不是错误 ——
/// 界面要把它讲成「当前没有开放的选课批次」，而不是「出错了」。
#[tauri::command]
pub async fn campus_course_select_status(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
) -> Result<CourseSelectStatus> {
    let client = select_context(&state.db, &hub)?.client;
    let entry_url = client.entry_url();
    // 正式域 / 测试域：界面要说清「你练拳的地方是不是真擂台」
    let production = provider::is_production_base(client.host());

    // 无锁：拉状态
    let (server_time, student, turns) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(String, Option<serde_json::Value>, Vec<CourseSelectTurn>)> {
            let server_time = client.server_time()?;
            let students = client.students()?;
            let student = students.into_iter().next();
            let sid = student
                .as_ref()
                .and_then(|s| s.get("id"))
                .and_then(|v| v.as_i64());
            let turns = match sid {
                Some(id) => client.open_turns(id)?,
                None => Vec::new(),
            };
            Ok((server_time, student, turns))
        },
    )
    .await
    .map_err(|e| ReinError::Message(format!("选课状态任务失败：{e}")))??;

    Ok(CourseSelectStatus {
        ready: true,
        reason: None,
        server_time: Some(server_time),
        student_id: student.as_ref().and_then(|s| s.get("id")).and_then(|v| v.as_i64()),
        student_code: student
            .as_ref()
            .and_then(|s| s.get("code"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        student_name: student
            .as_ref()
            .and_then(|s| s.get("person"))
            .and_then(|p| p.get("nameZh"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        turns,
        entry_url: Some(entry_url),
        production,
    })
}

/// 查询教学班（查课/筛课）。
#[tauri::command]
pub async fn campus_course_select_lessons(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    turn_id: String,
    query: Option<LessonQuery>,
) -> Result<Vec<CourseSelectLesson>> {
    let ctx = select_context(&state.db, &hub)?;
    let query = query.unwrap_or_default();

    tauri::async_runtime::spawn_blocking(move || {
        ctx.client.query_lesson(ctx.student_id, &turn_id, &query)
    })
    .await
    .map_err(|e| ReinError::Message(format!("查询教学班失败：{e}")))?
}

/// 快速抢课的轻量课程列表。比 `query-lesson` 少一堆渲染字段，用来做「还有余量吗」的高频核对。
#[tauri::command]
pub async fn campus_course_select_simplest_lessons(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    turn_id: String,
) -> Result<Vec<CourseSelectLesson>> {
    let ctx = select_context(&state.db, &hub)?;
    tauri::async_runtime::spawn_blocking(move || ctx.client.simplest_lessons(&turn_id))
        .await
        .map_err(|e| ReinError::Message(format!("查询课程列表失败：{e}")))?
}

/// 该批次的查询表单定义（有哪些可筛选字段、默认怎么排序）。
///
/// 纯展示用：拿不到就当没有，**绝不因为它失败而挡住查课**。
#[tauri::command]
pub async fn campus_course_select_query_condition(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    turn_id: String,
) -> Result<serde_json::Value> {
    let ctx = select_context(&state.db, &hub)?;
    tauri::async_runtime::spawn_blocking(move || ctx.client.query_condition(&turn_id))
        .await
        .map_err(|e| ReinError::Message(format!("获取查询条件失败：{e}")))?
}

/// 提交选课。返回受理回执，**结果要轮询** [`campus_course_select_result`]。
#[tauri::command]
pub async fn campus_course_select_apply(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    turn_id: String,
    lesson_id: serde_json::Value,
    virtual_cost: Option<i64>,
    schedule_group_id: Option<serde_json::Value>,
) -> Result<CourseSelectTicket> {
    let ctx = select_context(&state.db, &hub)?;

    tauri::async_runtime::spawn_blocking(move || {
        let request_id = ctx.client.add_request(
            ctx.student_id,
            &turn_id,
            vec![AddItem {
                lesson_assoc: lesson_id,
                virtual_cost,
                schedule_group_assoc: schedule_group_id,
                need_attend: None,
            }],
            None,
        )?;
        if request_id.is_empty() {
            return Err(ReinError::Message("教务未返回受理编号，请稍后重试".into()));
        }
        Ok(CourseSelectTicket { request_id })
    })
    .await
    .map_err(|e| ReinError::Message(format!("提交选课失败：{e}")))?
}

/// 提交占位（`add-predicate`）。开窗瞬间先占住队列位次，不花意愿值。
///
/// 结果同样走 [`campus_course_select_result`]（服务端用同一套受理单）。
#[tauri::command]
pub async fn campus_course_select_predicate(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    turn_id: String,
    lesson_id: serde_json::Value,
    schedule_group_id: Option<serde_json::Value>,
) -> Result<CourseSelectTicket> {
    let ctx = select_context(&state.db, &hub)?;

    tauri::async_runtime::spawn_blocking(move || {
        let request_id = ctx.client.add_predicate(
            ctx.student_id,
            &turn_id,
            vec![AddItem {
                lesson_assoc: lesson_id,
                virtual_cost: None,
                schedule_group_assoc: schedule_group_id,
                need_attend: None,
            }],
            None,
        )?;
        if request_id.is_empty() {
            return Err(ReinError::Message("教务未返回受理编号，请稍后重试".into()));
        }
        Ok(CourseSelectTicket { request_id })
    })
    .await
    .map_err(|e| ReinError::Message(format!("提交占位失败：{e}")))?
}

/// 轮询选课/退课结果。`pending = true` 时前端隔 2 秒再问（SPA 最多 10 次）。
#[tauri::command]
pub async fn campus_course_select_result(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    request_id: String,
) -> Result<CourseSelectPoll> {
    let ctx = select_context(&state.db, &hub)?;

    tauri::async_runtime::spawn_blocking(move || {
        let raw = ctx.client.add_drop_response(ctx.student_id, &request_id)?;
        Ok(poll_of(raw))
    })
    .await
    .map_err(|e| ReinError::Message(format!("查询选课结果失败：{e}")))?
}

/// 轮询占位结果（`predicate-response`）。
#[tauri::command]
pub async fn campus_course_select_predicate_result(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    request_id: String,
) -> Result<CourseSelectPoll> {
    let ctx = select_context(&state.db, &hub)?;

    tauri::async_runtime::spawn_blocking(move || {
        let raw = ctx.client.predicate_response(ctx.student_id, &request_id)?;
        Ok(poll_of(raw))
    })
    .await
    .map_err(|e| ReinError::Message(format!("查询占位结果失败：{e}")))?
}

/// 原始响应 → [`CourseSelectPoll`]。`data` 为空即「服务端还在处理」。
fn poll_of(raw: serde_json::Value) -> CourseSelectPoll {
    if raw.is_null() {
        return CourseSelectPoll {
            pending: true,
            success: false,
            message: None,
            need_attend: false,
        };
    }
    let r: CourseSelectResult = serde_json::from_value(raw).unwrap_or(CourseSelectResult {
        success: false,
        error_message: None,
        resend: false,
    });
    CourseSelectPoll {
        pending: false,
        success: r.success,
        message: r.error_message.and_then(|m| m.text),
        need_attend: r.resend,
    }
}

/// 每轮退课轮询的等待、以及最多问几次。与选课同节奏（SPA 用 2 秒 × 10）。
const DROP_POLL_WAIT: std::time::Duration = std::time::Duration::from_millis(2000);
const DROP_POLL_MAX: usize = 10;

/// 退课：`drop-predicate`（意向）→ 轮询 `predicate-response` → `drop-request`（正式）→ 轮询结果。
///
/// **两条腿一次性走完**，而不是像选课那样把受理号抛给前端：退课是用户明确按下的一个按钮，
/// 中间那个「意向已登记、还没正式退」的中间态对用户没有任何意义，暴露出来只会让人误以为退掉了。
/// 选课可以异步（要抢时间），退课不行（退错了比选不上严重得多）。
#[tauri::command]
pub async fn campus_course_select_drop(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    turn_id: String,
    lesson_ids: Vec<serde_json::Value>,
    confirm_midterm_retake: Option<bool>,
) -> Result<CourseSelectPoll> {
    if lesson_ids.is_empty() {
        return Err(ReinError::Message("没有指定要退的教学班".into()));
    }
    let ctx = select_context(&state.db, &hub)?;
    let midterm = confirm_midterm_retake.unwrap_or(false);

    tauri::async_runtime::spawn_blocking(move || -> Result<CourseSelectPoll> {
        // ① 登记退课意向
        let intend = ctx
            .client
            .drop_predicate(ctx.student_id, &turn_id, &lesson_ids)?;
        if intend.is_empty() {
            return Err(ReinError::Message("教务未受理退课意向，请稍后重试".into()));
        }
        wait_settled(&ctx, &intend, true)?;

        // ② 正式退课
        let request_id =
            ctx.client
                .drop_request(ctx.student_id, &turn_id, &lesson_ids, None, midterm)?;
        if request_id.is_empty() {
            return Err(ReinError::Message("教务未返回退课受理编号，请稍后重试".into()));
        }

        // ③ 等结果
        for _ in 0..DROP_POLL_MAX {
            let raw = ctx.client.add_drop_response(ctx.student_id, &request_id)?;
            let poll = poll_of(raw);
            if !poll.pending {
                return Ok(CourseSelectPoll {
                    message: poll.message.or_else(|| {
                        poll.success.then(|| "已退课".to_string())
                    }),
                    ..poll
                });
            }
            std::thread::sleep(DROP_POLL_WAIT);
        }
        Err(ReinError::Message(
            "教务迟迟没有返回退课结果，请到官方选课页确认后再试".into(),
        ))
    })
    .await
    .map_err(|e| ReinError::Message(format!("退课失败：{e}")))?
}

/// 等一张受理单落定。`pending` 直到超时，超时不报错 —— 由调用方按业务决定要不要继续。
fn wait_settled(
    ctx: &SelectContext,
    request_id: &str,
    predicate: bool,
) -> Result<()> {
    for _ in 0..DROP_POLL_MAX {
        let raw = if predicate {
            ctx.client.predicate_response(ctx.student_id, request_id)?
        } else {
            ctx.client.add_drop_response(ctx.student_id, request_id)?
        };
        if !raw.is_null() {
            return Ok(());
        }
        std::thread::sleep(DROP_POLL_WAIT);
    }
    Err(ReinError::Message(
        "教务迟迟没有受理，请到官方选课页确认状态后再试".into(),
    ))
}

/* ─────────────────────────── 自动抢课（任务单 + 后台引擎） ───────────────────────────
 *
 * 引擎本身在 `grab.rs`（后台线程，见那里的模块文档）。这里只提供「改任务单」的命令：
 * 所有写操作都以**改库 + 叫醒引擎**收尾，界面因此永远是「按下就生效」的手感。
 */

/// 任务单快照。与引擎推来的事件同形（`grab::snapshot`），
/// 所以前端可以用同一段渲染逻辑处理「主动拉」与「被动推」。
#[tauri::command]
pub fn campus_grab_state(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
) -> Result<GrabState> {
    let conn = state.db.lock();
    grab::snapshot(&conn, &grab)
}

/// 把一批课程加入抢课任务单。
///
/// `window_wall` 传 `null` 表示「还不知道窗口什么时候开」—— 引擎不会盲撞，
/// 而是每分钟去问一次 `open-turns`，拿到时间再精确开火（见 `grab::fire_at_ms`）。
// 同 campus_login：Tauri 命令参数拍平，三个 State 注入项占掉额度。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn campus_grab_enqueue(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    grab: State<'_, Arc<GrabHub>>,
    turn_id: String,
    turn_name: Option<String>,
    targets: Vec<GrabTargetInput>,
    mode: Option<String>,
    window_wall: Option<String>,
    window_end_wall: Option<String>,
) -> Result<Vec<i64>> {
    if targets.is_empty() {
        return Err(ReinError::Message("没有要抢的课程".into()));
    }
    let mode = match mode.as_deref() {
        // 默认占位优先：开窗瞬间先占住位次，再用正式请求确认 —— 抢的是位次
        None | Some("predicate") => "predicate",
        Some("direct") => "direct",
        Some(other) => {
            return Err(ReinError::Message(format!("未知的抢课模式：{other}")));
        }
    };
    let window = window_wall.as_deref().filter(|s| !s.trim().is_empty());
    let window_end = window_end_wall.as_deref().filter(|s| !s.trim().is_empty());

    let ids = {
        let conn = state.db.lock();
        let account = require_account(&conn)?;
        let mut ids = Vec::with_capacity(targets.len());
        for t in &targets {
            ids.push(grab::insert_task(
                &conn,
                account.id,
                &turn_id,
                turn_name.as_deref(),
                t,
                mode,
                window,
                window_end,
            )?);
        }
        ids
    };

    // 「进批次」是拿到提交体所需批次 id（`options.turn.id`）的唯一途径。
    // 放在入队时做、每门课共用一次结果：窗口开放后引擎不必再多一次往返，
    // 而那一次往返正好发生在最不该浪费时间的时刻。
    //
    // **失败不算错**：拿不到就留空，提交时退回列表 id（见 `GrabTask::turn_assoc`）。
    // 入队不该因为教务抖一下而失败 —— 用户排的任务单照样该进队列。
    let ctx = select_context(&state.db, &hub).ok();
    if let Some(ctx) = ctx {
        let tid = turn_id.clone();
        // 无锁联网，且不占 IPC 线程：这一步正常 200ms，超时上限 12s
        if let Ok(assoc) = tauri::async_runtime::spawn_blocking(move || {
            ctx.client.turn_assoc(ctx.student_id, &tid)
        })
        .await
        {
            let conn = state.db.lock();
            for id in &ids {
                let _ = grab::set_turn_assoc(&conn, *id, &assoc);
            }
        }
    }

    grab.notify();
    Ok(ids)
}

/// 暂停 / 取消 / 重试 / 移除。四个动作都是「改个状态」，所以合成一条命令，
/// 前端只需记住动作名，不必为每个按钮各配一条 IPC。
#[tauri::command]
pub fn campus_grab_task_action(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
    task_id: i64,
    action: String,
) -> Result<()> {
    {
        let conn = state.db.lock();
        // 引擎可能正在跑这个任务，先确认它存在，免得改了个空气
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM campus_grab_tasks WHERE id = ?1",
                [task_id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !exists {
            return Err(ReinError::Message("任务不存在（可能已被清理）".into()));
        }
        match action.as_str() {
            "pause" => grab::set_status(&conn, task_id, GRAB_PAUSED)?,
            "cancel" => grab::set_status(&conn, task_id, GRAB_CANCELLED)?,
            // 重试 = 把计数与退避清零，回到队列尾重新排队。
            // 用户按它通常是「我知道刚才是怎么回事了」，所以连 strikes 一起清掉；
            // `predicate_done` 也一并复位 —— 重新排队是一轮全新的抢课，占位该重新交。
            "retry" => {
                conn.execute(
                    "UPDATE campus_grab_tasks SET status = ?2, phase = 'idle', attempts = 0, \
                     polls = 0, strikes = 0, strike_kind = NULL, request_id = NULL, \
                     mirror_request_id = NULL, request_domain = NULL, \
                     predicate_done = 0, finished_at = NULL, last_message = '已重新排队', \
                     next_at = ?3 WHERE id = ?1",
                    rusqlite::params![task_id, GRAB_WAITING, Utc::now().timestamp_millis()],
                )?;
            }
            "remove" => grab::delete_task(&conn, task_id)?,
            other => {
                return Err(ReinError::Message(format!("未知的操作：{other}")));
            }
        }
    }
    grab.notify();
    Ok(())
}

/// 清掉已结束的任务（成功/失败/冲突/已取消）。
#[tauri::command]
pub fn campus_grab_clear_finished(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
) -> Result<usize> {
    let n = {
        let conn = state.db.lock();
        let account = require_account(&conn)?;
        grab::clear_finished(&conn, account.id)?
    };
    grab.notify();
    Ok(n)
}

/* ─────────────────── 抢课计划（意向） ───────────────────
 *
 * 计划是「提前输入」的落点：窗口开放前教学班列表常常还查不到，但人的意图现在就能写下。
 * 写完之后**不需要用户再做任何事** —— 引擎每分钟试一次，名单能拉到的那一刻自己解析成任务，
 * 到点自己开抢（见 `grab.rs` 的 `resolve_intent`）。
 */

/// 记下一条计划。`turn_id` 可为空（= 用教务当前开放的那个批次）——
/// 提前一晚写计划时，批次往往还没在列表里出现。
#[tauri::command]
pub fn campus_grab_intent_add(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
    turn_id: Option<String>,
    turn_name: Option<String>,
    query: String,
    mode: Option<String>,
    spread: Option<bool>,
) -> Result<GrabIntent> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err(ReinError::Message("要先写清楚想抢什么（课名 / 代码 / 教师）".into()));
    }
    // 上限是给误触和粘贴事故兜底的：一句正常的查询不会超过几十个字
    if query.chars().count() > 80 {
        return Err(ReinError::Message("这句话太长了，只写课名或教师就行".into()));
    }
    let mode = match mode.as_deref() {
        None | Some("predicate") => "predicate",
        Some("direct") => "direct",
        Some(other) => return Err(ReinError::Message(format!("未知的抢课模式：{other}"))),
    };
    let id = {
        let conn = state.db.lock();
        let account = require_account(&conn)?;
        grab::insert_intent(
            &conn,
            account.id,
            turn_id.as_deref().map(str::trim).filter(|s| !s.is_empty()),
            turn_name.as_deref().filter(|s| !s.trim().is_empty()),
            &query,
            mode,
            spread.unwrap_or(false),
        )?
    };
    // 叫醒引擎：能解析的话立刻就解析（窗口已经开着时，用户按下就该看到志愿排好）
    grab.notify();

    let conn = state.db.lock();
    grab::load_intent(&conn, id)?
        .ok_or_else(|| ReinError::Message("计划写入后读不回来，请重试".into()))
}

/// 计划的动作：`remove`（移除，连它派出去的任务一起收） / `now`（立刻重新解析）。
#[tauri::command]
pub fn campus_grab_intent_action(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
    intent_id: i64,
    action: String,
) -> Result<()> {
    {
        let conn = state.db.lock();
        match action.as_str() {
            "remove" => grab::delete_intent(&conn, intent_id)?,
            "now" => grab::reset_intent(&conn, intent_id)?,
            other => return Err(ReinError::Message(format!("未知的操作：{other}"))),
        }
    }
    grab.notify();
    Ok(())
}

/// 输入预览：把一句模糊查询照**教务现在的名单**跑一遍，让人在按下「加入计划」之前
/// 就看清会抢哪些班。
///
/// 与解析共用同一个匹配器和同一份名单缓存（见 `grab::resolve_turn` /
/// `GrabHub::lessons_cached`）—— 预览里看到的顺序，就是解析后排出来的志愿序。
#[tauri::command]
pub async fn campus_grab_intent_preview(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    grab: State<'_, Arc<GrabHub>>,
    query: String,
    turn_id: Option<String>,
) -> Result<GrabPreview> {
    let query = query.trim().to_string();
    let ctx = select_context(&state.db, &hub)?;
    let brief = grab::resolve_turn(&state, &ctx, turn_id.as_deref())?.ok_or_else(|| {
        ReinError::Message("教务还没公布选课批次，等它出现后预览会自动可用".into())
    })?;

    // 名单走引擎那份缓存：几分钟内重复预览不该反复打教务
    let (lessons, _) = grab.lessons_cached(&ctx, &brief.id)?;
    // 与引擎解析走**同一个**放宽阶梯：预览里看到的就是真抢时会用的那批班
    let relaxed = matcher::match_lessons_relaxed(&query, &lessons);
    let dropped_words = relaxed.dropped.clone();
    let relax_note = relaxed.level.note().map(str::to_string);
    let mut hits = relaxed.hits;
    // 名额要单独补（名单接口不回 stdCount）——与引擎解析走**同一个函数**，
    // 所以界面上看到的余量就是引擎排序时用的那一份，两边不会各说各话。
    grab::fill_seats(&grab, &ctx, &mut hits);
    // **预览必须和解析看到同一批班**：指定了老师时只列那位老师的班，
    // 否则「预览里有它、计划里没有」会让人以为哪里漏了。
    let pool = matcher::preferred(&hits);
    let matches: Vec<GrabMatch> = pool
        .iter()
        .take(PREVIEW_CAP)
        .map(matcher::to_match)
        .collect();
    // 「这句查询跨了哪几门课」和解析共用同一条规则（`matcher::ambiguous_courses`），
    // 这样不会出现「预览吓唬人、引擎照抢」或者反过来的情况。
    let ambiguous = matcher::ambiguous_courses(&query, &pool)
        .into_iter()
        .map(|(code, name)| GrabCourseRef { code, name })
        .collect();
    Ok(GrabPreview {
        turn_id: brief.id,
        turn_name: brief.name,
        total: lessons.len(),
        matched: hits.len(),
        matches,
        ambiguous,
        relax_note,
        dropped_words,
        lessons_note: grab.lessons_fallback_note(),
    })
}

/// 预览一次最多回多少行。只是给人看一眼「会抢哪些班」，再多也没人读。
const PREVIEW_CAP: usize = 30;

/// **起飞前自检**：把「抢课这件事现在到底行不行」一次问清楚。
///
/// 为什么值得单独做一遍（而不是让用户从任务列表里猜）：抢课失败最贵的一种
/// 是「**以为在抢，其实早就放弃了**」—— 名单没拉到、计划一个字都没匹配上、
/// 时钟偏差没测出来、窗口已经过去了……这些在界面上都长得像「在等待」。
/// 所以体检的每一项都要给**证据**（教务原话、数字、时刻），
/// 而只要有一项不过，`ok` 就是 false。
///
/// 会打几次网络（换令牌 / 学生 / 批次 / 名单），和预览一个量级；
/// 但它不该拖慢引擎的节奏 —— 时钟那一项用的是「过期才重采」的既有逻辑。
#[tauri::command]
pub fn campus_grab_preflight(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    grab: State<'_, Arc<grab::GrabHub>>,
) -> Result<GrabPreflight> {
    let mut items: Vec<GrabPreflightItem> = Vec::new();
    let mut push = |key: &str, label: &str, ok: bool, detail: String| {
        items.push(GrabPreflightItem {
            key: key.into(),
            label: label.into(),
            ok,
            detail,
        });
    };

    // ① 登录态 + 选课令牌 + 我是谁 —— 这三件在同一次调用里就有答案
    let ctx = match select_context(&state.db, &hub) {
        Ok(ctx) => {
            let mut detail = format!("会话有效，选课令牌可用（学生 id={}）", ctx.student_id);
            if !ctx.mirror_note.trim().is_empty() {
                detail.push_str(&format!("；{}", ctx.mirror_note.trim()));
            }
            push("account", "教务登录与选课令牌", true, detail);
            Some(ctx)
        }
        Err(e) => {
            push("account", "教务登录与选课令牌", false, e.to_string());
            None
        }
    };

    // ② 批次可见 + 窗口
    let mut brief: Option<GrabTurnBrief> = None;
    if let Some(ctx) = &ctx {
        match grab::resolve_turn(&state, ctx, None) {
            Ok(Some(b)) => {
                let when = format!(
                    "{} ~ {}",
                    b.window_start.clone().unwrap_or_else(|| "未公布".into()),
                    b.window_end.clone().unwrap_or_else(|| "未公布".into())
                );
                // 关门判断不校时钟偏差（差几秒对「今天还抢不抢」没有影响），与引擎一致
                let closed = b
                    .window_end
                    .as_deref()
                    .and_then(grab::wall_to_ms)
                    .map(|end| chrono::Utc::now().timestamp_millis() >= end)
                    .unwrap_or(false);
                let ok = b.allow_enter && !closed;
                let why = if closed {
                    "（窗口已经结束）"
                } else if !b.allow_enter {
                    "（教务还没放行这个批次）"
                } else {
                    ""
                };
                push(
                    "turn",
                    "选课批次",
                    ok,
                    format!(
                        "{}「{}」窗口 {when}{why}",
                        if ok { "可进入：" } else { "不可进入：" },
                        b.name.clone().unwrap_or_else(|| b.id.clone())
                    ),
                );
                brief = Some(b);
            }
            Ok(None) => push(
                "turn",
                "选课批次",
                false,
                "教务还没公布选课批次（公布后引擎每分钟会自动看到）".into(),
            ),
            Err(e) => push("turn", "选课批次", false, e.to_string()),
        }
    }

    // ③ 时钟偏差：这个决定「什么时候出手」，偏了就是白等或误杀
    let (at, est) = grab::refresh_clock_if_stale(&state, &hub);
    match est {
        Some(est) => {
            let ok = est.uncertainty_ms <= CLOCK_OK_MS;
            push(
                "clock",
                "时钟校准",
                ok,
                format!(
                    "教务与本机相差 {}ms（不确定度 ±{}ms，{} 次采样{}）{}",
                    est.skew_ms,
                    est.uncertainty_ms,
                    est.samples,
                    if est.samples > 1 { "、取交集" } else { "" },
                    if ok {
                        ""
                    } else {
                        "（测不准，出手时刻会偏；稍后再测一次）"
                    }
                ),
            );
        }
        None => push(
            "clock",
            "时钟校准",
            false,
            format!("测不出偏差（本机时钟 {}，教务时钟没答上来）", at),
        ),
    }

    // ④ 名单 + ⑤ 每条计划的匹配结果
    if let (Some(ctx), Some(brief)) = (&ctx, &brief) {
        match grab.lessons_cached(ctx, &brief.id) {
            Ok((lessons, _)) => {
                let stale = grab.lessons_fallback_note();
                push(
                    "lessons",
                    "教学班名单",
                    !lessons.is_empty() && stale.is_none(),
                    match (&stale, lessons.is_empty()) {
                        (Some(note), _) => format!("{} 个教学班，但**这份名单是旧的**：{note}", lessons.len()),
                        (None, true) => "教务回了空名单 —— 引擎现在没有可抢的目标".into(),
                        (None, false) => format!("{} 个教学班（批次 {}）", lessons.len(), brief.id),
                    },
                );

                let conn = state.db.lock();
                let intents = grab::load_intents(&conn, ctx.account_id).unwrap_or_default();
                drop(conn);
                if intents.is_empty() {
                    push(
                        "plans",
                        "抢课计划",
                        false,
                        "还没有任何计划 —— 没有计划就不会有人出手".into(),
                    );
                }
                for it in intents.iter() {
                    let relaxed = matcher::match_lessons_relaxed(&it.query, &lessons);
                    let mut hits = relaxed.hits.clone();
                    grab::fill_seats(&grab, ctx, &mut hits);
                    let pool = matcher::preferred(&hits);
                    let groups = grab::plan_groups(&pool, it.spread);
                    let seats = groups
                        .first()
                        .and_then(|g| g.first())
                        .and_then(|h| {
                            h.lesson
                                .std_count
                                .zip(h.lesson.limit_count)
                                .map(|(taken, lim)| lim - taken)
                        });
                    let amb = matcher::ambiguous_courses(&it.query, &pool);
                    let ok = !groups.is_empty() && amb.is_empty();
                    let detail = if groups.is_empty() {
                        format!(
                            "「{}」一个教学班都没匹配到（名单 {} 个班）{}",
                            it.query,
                            lessons.len(),
                            if relaxed.dropped.is_empty() {
                                String::new()
                            } else {
                                format!("；放宽后也不行（丢掉的词：{}）", relaxed.dropped.join("、"))
                            }
                        )
                    } else if !amb.is_empty() {
                        format!(
                            "「{}」跨了 {} 门课（{}）—— 引擎不会排队，请补课程代码",
                            it.query,
                            amb.len(),
                            amb.iter().map(|(c, _)| c.clone()).collect::<Vec<_>>().join(" / ")
                        )
                    } else {
                        format!(
                            "「{}」→ {} 个候选、{} 个志愿组{}",
                            it.query,
                            pool.len(),
                            groups.len(),
                            match seats {
                                Some(n) if n > 0 => format!("，首选还剩 {n} 个名额"),
                                Some(_) => "，**首选已满**（会守着等退课）".into(),
                                None => "，名额未知（教务没给）".into(),
                            }
                        )
                    };
                    push("plan", &format!("计划「{}」", it.query), ok, detail);
                }
            }
            Err(e) => push("lessons", "教学班名单", false, e.to_string()),
        }
    }

    let ok = items.iter().all(|i| i.ok);
    let bad: Vec<&GrabPreflightItem> = items.iter().filter(|i| !i.ok).collect();
    let summary = if ok {
        format!("全部 {} 项通过 —— 到点就会出手", items.len())
    } else {
        format!(
            "{} 项没过：{}",
            bad.len(),
            bad.iter()
                .map(|i| i.label.clone())
                .collect::<Vec<_>>()
                .join("、")
        )
    };
    Ok(GrabPreflight { ok, items, summary })
}

/// 时钟「测得准」的阈值（毫秒）。超过它就别指望踩准开窗那一秒。
const CLOCK_OK_MS: i64 = 1_000;

/// 暂停全部 / 恢复全部。抢课途中学生常要临时收手（比如换了网络），
/// 逐个点太慢，所以给一对批量动作。
#[tauri::command]
pub fn campus_grab_pause_all(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
) -> Result<()> {
    {
        let conn = state.db.lock();
        let account = require_account(&conn)?;
        conn.execute(
            "UPDATE campus_grab_tasks SET status = ?2, phase = 'idle' \
             WHERE account_id = ?1 AND status IN ('waiting','running')",
            rusqlite::params![account.id, GRAB_PAUSED],
        )?;
    }
    grab.notify();
    Ok(())
}

#[tauri::command]
pub fn campus_grab_resume_all(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
) -> Result<()> {
    {
        let conn = state.db.lock();
        let account = require_account(&conn)?;
        conn.execute(
            "UPDATE campus_grab_tasks SET status = ?2, phase = 'idle', next_at = ?3 \
             WHERE account_id = ?1 AND status = ?4",
            rusqlite::params![
                account.id,
                GRAB_WAITING,
                Utc::now().timestamp_millis(),
                GRAB_PAUSED
            ],
        )?;
    }
    grab.notify();
    Ok(())
}

/// 读引擎节奏参数。
#[tauri::command]
pub fn campus_grab_settings_get(state: State<'_, AppState>) -> Result<GrabSettings> {
    let conn = state.db.lock();
    grab::load_settings(&conn)
}

/// 改节奏参数。**落库前一律收口**（见 `GrabSettings::sanitized`）——
/// 界面允许用户调快，但不能调出「每 50ms 打一次教务」这种东西。
#[tauri::command]
pub fn campus_grab_settings_set(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
    settings: GrabSettings,
) -> Result<GrabSettings> {
    let saved = {
        let conn = state.db.lock();
        let s = settings.sanitized();
        grab::save_settings(&conn, &s)?;
        s
    };
    grab.notify();
    Ok(saved)
}

/* ─────────────────────────── 救援面（AI 的最后补救） ───────────────────────────
 *
 * 与抢课引擎的分工：引擎管「一切照常」——窗口到了就开火、满员就守着、会话掉了自己重登；
 * 这一片管「不照常」——教务改了接口、换了返回信封、多了个没见过的报错、批次规则变了。
 * 那种时刻唯一能救回来的动作是：**带会话打一条任意请求，然后看清它到底回了什么**。
 *
 * 三条不可让步的规矩（都能说清为什么）：
 * 1. **凭据只去同源**（`rescue::check_target`）：上游是模型的输出，而模型的输入里混着远程响应 ——
 *    「把 Cookie 发到这个地址」这种注入必须从一开始就不可能成立。
 * 2. **任意公网可打，但不带任何凭据**：教务改接口时要去读它自己的 SPA 包、去核公开文档，
 *    这条路连门户的 Origin/Referer 都不带 —— 来源信息也是信息。
 * 3. **每一步留痕**：写操作不弹确认（抢课窗口里每一次确认都是拖延），
 *    那份信任由 `campus_ai_actions` 兜底：可查、可重放、有理由。
 */

/// 快照里带多少条「AI 自己干过的事」。够看清上一轮做了什么，又不至于把上下文撑爆。
const RESCUE_RECENT: usize = 20;

/// 熔断窗口（分钟）：同一条请求在这个窗口里超过 `rescue::CIRCUIT_LIMIT` 次就拒绝。
const RESCUE_WINDOW_MIN: i64 = 1;

/// 救援请求的最终形态。渲染 curl、发请求、写审计三处都从这一份出发 ——
/// 三处各拼一遍的话，重放时对不上号只是时间问题。
#[derive(Clone)]
struct Prepared {
    spec: rescue::RequestSpec,
    same_origin: bool,
}

/// 真发一次请求。同源走 [`Session`]（Cookie + 可选选课令牌，屏蔽 302 跟随）；
/// 公网走裸 ureq agent（无凭据、无门户头，过 SSRF 白名单）。
///
/// 返回「响应 + 这一趟之后的 Cookie + 耗时」：`Set-Cookie` 可能把会话换掉了，
/// 换了就得落库 —— 否则下一次又拿旧会话去撞，白换一次。
fn send_request(
    p: &Prepared,
    base: &str,
    jar: CookieJar,
    token: Option<String>,
) -> Result<(HttpResponse, CookieJar, i64)> {
    let started = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(rescue::RESCUE_TIMEOUT_SECS);
    if p.same_origin {
        let mut session = Session::with_timeout(base, jar, timeout);
        let mut extra: Vec<(&str, &str)> = p
            .spec
            .headers
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        // 树维选课接口要的是**裸 JWT**（没有 Bearer 前缀），见 `course_select.rs` 的模块注释
        if let Some(t) = token.as_deref() {
            extra.push(("Authorization", t));
        }
        let content_type = content_type_of(&p.spec);
        let bytes = p.spec.body.as_ref().map(|b| b.as_bytes().to_vec());
        let resp = session.request(
            &p.spec.method,
            &p.spec.url,
            None,
            &extra,
            bytes.as_ref().map(|b| (content_type.as_str(), b.clone())),
        )?;
        let jar = session.jar().clone();
        return Ok((resp, jar, started.elapsed().as_millis() as i64));
    }

    let url = crate::modules::web::commands::validate_url(&p.spec.url)?;
    // 不跟随重定向：① 这条命令是探针，3xx 本身就是要看到的结论（原样交给模型，
    // 与同源分支「靠 302 判会话过期」的口径一致）；② 自动跟随会带着白名单外的
    // 内网地址回来 —— 那是 SSRF 的口子（`validate_url` 只挡得住第一跳）。
    let agent = ureq::AgentBuilder::new()
        .timeout(timeout)
        .user_agent(super::http::USER_AGENT)
        .redirects(0)
        .build();
    let mut req = agent.request(&p.spec.method, &url);
    for (k, v) in &p.spec.headers {
        req = req.set(k, v);
    }
    let outcome = match &p.spec.body {
        Some(b) => req.send_bytes(b.as_bytes()),
        None => req.call(),
    };
    // 非 2xx 也是「拿到了响应」，要原样交给模型看 —— 救援时那条错误正文常常就是答案
    let resp = match outcome {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(ReinError::Message(format!("网络请求失败：{e}"))),
    };
    let out = super::http::read_response(resp)?;
    Ok((out, CookieJar::default(), started.elapsed().as_millis() as i64))
}

/// 正文的 Content-Type。**以请求头里的那一份为准**（模型手写的内容类型要生效），
/// 没写才回落 `application/json` —— 门口那些教务接口全是 JSON。
fn content_type_of(spec: &rescue::RequestSpec) -> String {
    spec.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| "application/json".into())
}

/// 现场快照：账号 + 会话探针 + 抢课引擎整份状态 + 卡住的任务 + AI 最近干过的事。
///
/// 做成**一次调用**而不是让模型连着问五个命令：排障时它最需要的是「同时看到全部」，
/// 而分开问的代价不只是慢 —— 五次调用之间现场会变，拼出来的因果可能根本不存在。
#[tauri::command]
pub async fn campus_rescue_state(
    state: State<'_, AppState>,
    grab: State<'_, Arc<GrabHub>>,
    probe: Option<bool>,
) -> Result<RescueState> {
    let (account, snapshot, recent_actions) = {
        let conn = state.db.lock();
        (
            load_active_account(&conn)?,
            grab::snapshot(&conn, &grab)?,
            rescue::recent(&conn, RESCUE_RECENT)?,
        )
    };

    // 探针要发网络请求：手上的东西先取全，再进闭包（DB 锁绝不能跨过网络，见文件头铁律）
    let (session_alive, session_error) = match (probe.unwrap_or(true), account.as_ref()) {
        (true, Some(acc)) => {
            let spec = acc.spec()?;
            let base = acc.base_url.clone();
            let jar = CookieJar::from_json(acc.cookies.as_deref());
            let probed = tauri::async_runtime::spawn_blocking(move || {
                let mut session = Session::new(&base, jar);
                AnyAdapter::new(spec, &mut session).probe_session()
            })
            .await;
            match probed {
                Ok(Ok(alive)) => (Some(alive), None),
                Ok(Err(e)) => (None, Some(e.to_string())),
                Err(e) => (None, Some(format!("会话探针任务失败：{e}"))),
            }
        }
        _ => (None, None),
    };

    let stuck_task_ids = rescue::stuck_tasks(&snapshot.tasks, Utc::now().timestamp_millis());
    Ok(RescueState {
        account: account.map(to_account),
        session_alive,
        session_error,
        grab: snapshot,
        stuck_task_ids,
        recent_actions,
    })
}

/// 带会话打一条任意请求 —— AI 的 curl。
///
/// `url` 可以是相对路径（拼在教务 base 后面），也可以是绝对地址。
/// 相对路径 / 同源地址默认带上教务会话；外部地址一律不带凭据（给了也拒，
/// 见本节的规矩 1：安静的降级比报错更危险，模型会以为自己拿到的是「带会话的结果」）。
#[tauri::command]
pub async fn campus_http(
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    req: RescueRequest,
) -> Result<RescueResponse> {
    let reason = req.reason.trim().to_string();
    if reason.is_empty() {
        return Err(ReinError::Message(
            "reason 不能为空：这条请求想搞清楚什么？事后只有它能解释审计里那一行".into(),
        ));
    }
    let method = rescue::normalize_method(req.method.as_deref())?;

    let account = {
        let conn = state.db.lock();
        load_active_account(&conn)?
    };
    let base = account.as_ref().map(|a| a.base_url.clone()).unwrap_or_default();
    let relative = !(req.url.trim().starts_with("http://") || req.url.trim().starts_with("https://"));
    if relative && account.is_none() {
        return Err(ReinError::Message(
            "还没有绑定教务系统账号，相对路径没有可拼的域名 —— 请先在「课表配置」里登录".into(),
        ));
    }
    let url = rescue::resolve_url(&req.url, &base)?;

    let same_origin = rescue::check_target(&url, account.as_ref().map(|a| a.base_url.as_str()))?
        == rescue::Target::SameOrigin;
    let with_token = req.with_select_token.unwrap_or(false);
    // 不写 withSession 时的默认：同源就带（「看一眼教务现在怎么说」是这个工具的主用例）
    let with_session = req.with_session.unwrap_or(same_origin);
    if !same_origin && (with_session || with_token) {
        return Err(ReinError::Message(format!(
            "带凭据的请求只能打教务自己的域名（{}），{url} 是外部地址。\
             要带会话请用相对路径（如 /student/home）；要读外部页面就别带凭据 —— \
             这条请求没有发出去，避免你以为它带着会话说的是同一件事。",
            if base.is_empty() { "未登录" } else { &base }
        )));
    }

    for (k, _) in &req.headers {
        let lower = k.trim().to_ascii_lowercase();
        if matches!(lower.as_str(), "cookie" | "authorization" | "host" | "content-length") {
            return Err(ReinError::Message(format!(
                "请求头「{k}」不允许手写：会话与令牌走 withSession / withSelectToken，\
                 长度与主机由底层决定 —— 手写会让审计与导出脚本里那条命令跟实际发出的请求对不上"
            )));
        }
    }

    let mut headers: Vec<(String, String)> = req
        .headers
        .iter()
        .map(|(k, v)| (k.trim().to_string(), v.clone()))
        .collect();
    // 带正文就必须有一条 Content-Type：否则教务网关多半回 415，而模型看到的只是一句
    // 「失败」——把默认值在这里补上，渲染出的 curl 里也才是完整可重放的一条命令。
    if req.body.is_some()
        && !headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("content-type"))
    {
        headers.push((
            "Content-Type".into(),
            req.content_type
                .clone()
                .unwrap_or_else(|| "application/json".into()),
        ));
    }

    let prepared = Prepared {
        spec: rescue::RequestSpec {
            method,
            url: url.clone(),
            headers,
            body: req.body.clone(),
            with_cookie: with_session,
            with_token,
        },
        same_origin,
    };
    let fp = prepared.spec.fingerprint();
    let curl = rescue::render_curl(&prepared.spec);

    // 熔断：救援工具自己不能变成新的故障（模型在一个错误上原地转圈是它最典型的失败模式）
    {
        let conn = state.db.lock();
        let since = (Utc::now() - Duration::minutes(RESCUE_WINDOW_MIN)).to_rfc3339();
        if rescue::circuit_broken(&conn, &fp, &since)? {
            return Err(ReinError::Message(format!(
                "熔断：同一条请求（{} {}）在 {RESCUE_WINDOW_MIN} 分钟内已经打过 {} 次。\
                 停手 —— 重复同一条请求不会得到不同的答案，换个判断依据（先 campus_status 看现场）。",
                prepared.spec.method,
                url,
                rescue::CIRCUIT_LIMIT
            )));
        }
    }

    let mut token = if with_token {
        Some(select_context(&state.db, &hub)?.client.token().to_string())
    } else {
        None
    };
    let jar = account
        .as_ref()
        .map(|a| CookieJar::from_json(a.cookies.as_deref()))
        .unwrap_or_default();

    let first = {
        let p = prepared.clone();
        let base = base.clone();
        let t = token.clone();
        tauri::async_runtime::spawn_blocking(move || send_request(&p, &base, jar, t))
            .await
            .map_err(|e| ReinError::Message(format!("救援请求任务失败：{e}")))??
    };
    let (mut resp, mut jar_after, mut elapsed_ms) = first;

    // 会话失效（门户 302 回登录页 / 选课接口 401）：自愈一次再打。
    // 这正是救援面最常遇到的现场 —— 用户之所以来找 AI，十有八九就是会话怎么都救不回来。
    let lost = resp.status == 302 || (with_token && resp.status == 401);
    let mut healed = false;
    if same_origin && lost {
        if let Some(acc) = account.as_ref() {
            recover_session(&state.db, &hub, acc)?;
            let fresh = {
                let conn = state.db.lock();
                require_account(&conn)?
            };
            if with_token {
                token = Some(select_context(&state.db, &hub)?.client.token().to_string());
            }
            let retried = {
                let p = prepared.clone();
                let b = fresh.base_url.clone();
                let j = CookieJar::from_json(fresh.cookies.as_deref());
                let t = token.clone();
                tauri::async_runtime::spawn_blocking(move || send_request(&p, &b, j, t))
                    .await
                    .map_err(|e| ReinError::Message(format!("救援请求任务失败：{e}")))??
            };
            resp = retried.0;
            jar_after = retried.1;
            elapsed_ms = retried.2;
            healed = true;
        }
    }

    // 会话可能在响应里被换掉了（`Set-Cookie`）：立刻落库，否则下一次又拿旧的去撞
    if same_origin {
        if let Some(acc) = account.as_ref() {
            let stored = CookieJar::from_json(acc.cookies.as_deref());
            if jar_after.to_json() != stored.to_json() {
                let conn = state.db.lock();
                persist_session(&conn, acc.id, &jar_after)?;
            }
        }
    }

    let (body, truncated, bytes) = rescue::truncate(&resp.body, rescue::clamp_max_bytes(req.max_bytes));
    let ok = resp.is_ok();
    let note = if healed {
        Some("会话已失效，已自动重新登录并重试了一次 —— 上面是重试后的响应".to_string())
    } else if !same_origin {
        Some("外部地址：这条请求没有携带任何教务凭据".to_string())
    } else {
        None
    };
    let summary = format!(
        "{} {} → HTTP {}{}",
        prepared.spec.method,
        prepared.spec.url,
        resp.status,
        if healed { "（会话已自动重登）" } else { "" }
    );

    {
        let conn = state.db.lock();
        rescue::record(
            &conn,
            &now_iso(),
            rescue::Audit {
                kind: rescue::KIND_HTTP,
                summary: &summary,
                detail: Some(&serde_json::json!({
                    "reason": reason,
                    "url": prepared.spec.url,
                    "method": prepared.spec.method,
                    "status": resp.status,
                    "bytes": bytes,
                    "truncated": truncated,
                    "sameOrigin": same_origin,
                    "healed": healed,
                })),
                curl: Some(&curl),
                fp: Some(&fp),
                status: if ok { rescue::STATUS_OK } else { rescue::STATUS_ERROR },
                account_id: account.as_ref().map(|a| a.id),
            },
        )?;
        let _ = rescue::prune(&conn);
    }

    Ok(RescueResponse {
        url: prepared.spec.url,
        method: prepared.spec.method,
        status: resp.status,
        ok,
        same_origin,
        with_session: prepared.spec.with_cookie,
        with_select_token: prepared.spec.with_token,
        headers: resp.headers,
        body,
        truncated,
        bytes,
        elapsed_ms,
        curl,
        healed,
        note,
    })
}

/// 把一次**不带请求**的动作写进审计（加任务、重试、改节奏、退课……）。
///
/// 为什么这些也要记：出事以后人问的第一个问题永远是「AI 都干了什么」。
/// 只有请求记录的话，答案会是「它打过 12 条请求」——那是过程，不是结果。
#[tauri::command]
pub fn campus_rescue_note(
    state: State<'_, AppState>,
    kind: String,
    summary: String,
    detail: Option<serde_json::Value>,
) -> Result<i64> {
    let summary = summary.trim().to_string();
    if summary.is_empty() {
        return Err(ReinError::Message("summary 不能为空".into()));
    }
    let kind = rescue::normalize_kind(&kind)?;
    let conn = state.db.lock();
    let account_id = load_active_account(&conn)?.map(|a| a.id);
    let id = rescue::record(
        &conn,
        &now_iso(),
        rescue::Audit {
            kind,
            summary: &summary,
            detail: detail.as_ref(),
            curl: None,
            fp: None,
            status: rescue::STATUS_OK,
            account_id,
        },
    )?;
    let _ = rescue::prune(&conn);
    Ok(id)
}

/// 导出救援脚本：把这段时间里打过的请求渲染成一份能脱离 App 运行的 `.sh`。
///
/// 为什么要落盘而不是把文本回给模型：**会话是会过期的**。这份脚本的用法是
/// 「AI 现在把路趟通 → 人过一会儿/换个网络/在另一台机器上照着再走一遍」，
/// 那时 App 可能已经不在了，而脚本里带着当时那份凭据快照。
#[tauri::command]
pub fn campus_curl_export(
    app: AppHandle,
    state: State<'_, AppState>,
    hub: State<'_, CampusHub>,
    hours: Option<i64>,
    limit: Option<usize>,
) -> Result<CurlExport> {
    let hours = hours.unwrap_or(6).clamp(1, 24 * 7);
    let limit = limit.unwrap_or(200).clamp(1, 500);
    let since = (Utc::now() - Duration::hours(hours)).to_rfc3339();

    let (entries, account, token) = {
        let conn = state.db.lock();
        let entries = rescue::scriptable_since(&conn, &since, limit)?;
        let account = load_active_account(&conn)?;
        // 令牌缓存在进程内（见 state.rs）：换过进程就没了，脚本里那只说明「现在拿不到」
        let token = account.as_ref().and_then(|a| hub.cached_select_token(a.id));
        (entries, account, token)
    };
    if entries.is_empty() {
        return Err(ReinError::Message(format!(
            "最近 {hours} 小时里没有可导出的请求（{since} 之后）。先在 App 里打几条真实请求再导出。"
        )));
    }

    let base = account.as_ref().map(|a| a.base_url.clone()).unwrap_or_default();
    let cookie = account
        .as_ref()
        .and_then(|a| CookieJar::from_json(a.cookies.as_deref()).header());
    let generated_at = now_iso();
    let script = rescue::render_script(
        &entries,
        &rescue::ScriptEnv {
            base: &base,
            cookie: cookie.as_deref(),
            select_token: token.as_deref(),
            generated_at: &generated_at,
        },
    );

    let dir = crate::db::data_dir(&app)?.join("rescue");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("rescue-{}.sh", Local::now().format("%Y%m%d-%H%M%S")));
    std::fs::write(&path, script.as_bytes())?;

    {
        let conn = state.db.lock();
        rescue::record(
            &conn,
            &generated_at,
            rescue::Audit {
                kind: rescue::KIND_SCRIPT,
                summary: &format!(
                    "导出救援脚本：{} 条请求 → {}",
                    entries.len(),
                    path.display()
                ),
                detail: None,
                curl: None,
                fp: None,
                status: rescue::STATUS_OK,
                account_id: account.as_ref().map(|a| a.id),
            },
        )?;
        let _ = rescue::prune(&conn);
    }

    Ok(CurlExport {
        path: path.to_string_lossy().to_string(),
        script,
        count: entries.len(),
        generated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Datelike;

    fn sem(start: &str, week_start_on_sunday: bool) -> CampusSemester {
        CampusSemester {
            id: 1,
            account_id: 1,
            remote_id: 321,
            code: Some("2026-2027_1".into()),
            name: "2026-2027 第一学期".into(),
            school_year: Some("2026-2027".into()),
            season: Some("AUTUMN".into()),
            start_date: start.into(),
            end_date: "2027-01-24".into(),
            week_start_on_sunday,
            total_weeks: 19,
            current_week: Some(1),
            is_current: true,
        }
    }

    /// 会话过期的判据必须与教务实际吐出的文案对齐 —— 判错一次，
    /// 用户看到的就是「明明存了密码，还要手动重新登录」。
    #[test]
    fn session_loss_is_recognised_by_the_strings_the_system_actually_emits() {
        for msg in [
            "获取课表页面 需要登录：会话已过期，请重新登录教务系统",
            "教务会话已过期，无法获取选课令牌，请先在「课表配置」重新登录",
            "登录状态已过期，且该账号没有保存密码 —— 请到「课表配置」重新登录一次",
            "登录已过期",
        ] {
            assert!(is_session_lost(&ReinError::Message(msg.into())), "{msg}");
        }
        // 普通失败不能被误判成会话过期，否则每次失败都要白重登一遍
        for msg in [
            "获取课表数据失败：HTTP 503",
            "课表数据为空：该学期可能没有排课",
            "网络请求失败：timed out",
        ] {
            assert!(!is_session_lost(&ReinError::Message(msg.into())), "{msg}");
        }
    }

    /// 没存密码时自愈必须**明确拒绝**并说清怎么补救（勾上保存密码以后就不用再管了），
    /// 而不是拿一句「登录失败」把用户堵在那里。
    #[test]
    fn relogin_without_a_saved_password_says_what_to_do() {
        let account = AccountRow {
            id: 1,
            system_kind: "guet-supwisdom-eams5".into(),
            base_url: "https://bkjwtest.guet.edu.cn".into(),
            login_name: "2600350118".into(),
            password: None,
            cookies: None,
            session_at: None,
            student_id: None,
            student_code: None,
            student_name: None,
            department: None,
            major: None,
            adminclass: None,
            grade: None,
            total_credits: None,
            save_password: false,
            active: true,
            last_sync_at: None,
            created_at: "t".into(),
            updated_at: "t".into(),
        };
        // 没有密码就不该发任何请求：直接给出可照做的提示
        let err = relogin(&account).unwrap_err();
        assert!(err.to_string().contains("保存密码"), "{err}");
        assert!(is_session_lost(&err), "这类失败仍属于「会话过期」家族：{err}");
    }

    #[test]
    fn occurrence_dates_match_calendar() {
        let anchor = dates::parse_ymd("2026-09-14").unwrap();
        // 第 1 教学周周一 = 学期起始日
        assert_eq!(
            occurrence_date(anchor, 1, 1, false).unwrap().to_string(),
            "2026-09-14"
        );
        // 第 1 教学周周日 = 09-20
        assert_eq!(
            occurrence_date(anchor, 1, 7, false).unwrap().to_string(),
            "2026-09-20"
        );
        // 实测样本：大学生心理健康教育，第 3~12 周、星期五 8-9 节 → 第 3 周周五 = 10-02
        assert_eq!(
            occurrence_date(anchor, 3, 5, false).unwrap().to_string(),
            "2026-10-02"
        );
        // 越界一律 None，不 panic
        assert!(occurrence_date(anchor, 0, 1, false).is_none());
        assert!(occurrence_date(anchor, 1, 8, false).is_none());
    }

    #[test]
    fn occurrence_dates_sunday_first_week() {
        let anchor = dates::parse_ymd("2026-09-13").unwrap(); // 周日
        assert_eq!(
            occurrence_date(anchor, 1, 7, true).unwrap().to_string(),
            "2026-09-13"
        );
        assert_eq!(
            occurrence_date(anchor, 1, 1, true).unwrap().to_string(),
            "2026-09-14"
        );
    }

    #[test]
    fn expands_session_into_one_entry_per_week() {
        let sessions = vec![CampusSession {
            id: 7,
            course_id: 1,
            weekday: 5,
            start_unit: 8,
            end_unit: 9,
            start_time: "16:30".into(),
            end_time: "18:05".into(),
            weeks: vec![3, 4, 5],
            weeks_str: Some("3~5".into()),
            room: Some("16407*".into()),
            building: Some("花江校区第十六教学楼".into()),
            campus: Some("花江校区".into()),
            course_name: "大学生心理健康教育".into(),
            course_code: Some("000003".into()),
            teachers: vec!["范志燕".into()],
            credits: Some(2.0),
            course_type: Some("通识必修".into()),
            color: None,
        }];
        let entries = expand_entries(&sem("2026-09-14", false), &sessions, &HolidayPlan::default());
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].date, "2026-10-02");
        assert_eq!(entries[0].week, 3);
        assert_eq!(entries[2].date, "2026-10-16");
    }

    /// 调休映射的端到端语义：放假日打「假」、补班日额外挂「调」，补班日自己的课不打标。
    #[test]
    fn holiday_plan_marks_off_days_and_adds_makeup_classes() {
        // 2026 国庆：10/07（第 4 周周三）放假、10/10（第 4 周周六）补被吃掉那天的课
        let tables = vec![holiday::HolidayYear {
            year: 2026,
            days: vec![
                holiday::HolidayDay {
                    name: "国庆节".into(),
                    date: "2026-10-07".into(),
                    is_off_day: true,
                },
                holiday::HolidayDay {
                    name: "国庆节".into(),
                    date: "2026-10-10".into(),
                    is_off_day: false,
                },
            ],
        }];
        let plan = holiday::build_plan(&tables, &std::collections::BTreeMap::new());
        assert_eq!(plan.makeups().get("2026-10-10").copied(), Some(3), "10/10 补周三");

        let mk = |id: i64, weekday: i64| CampusSession {
            id,
            course_id: 1,
            weekday,
            start_unit: 1,
            end_unit: 2,
            start_time: "08:00".into(),
            end_time: "09:35".into(),
            weeks: vec![4],
            weeks_str: None,
            room: None,
            building: None,
            campus: None,
            course_name: format!("课{id}"),
            course_code: None,
            teachers: vec![],
            credits: None,
            course_type: None,
            color: None,
        };
        // 1 = 周三、2 = 周六，都只排在第 4 教学周
        let sessions = vec![mk(1, 3), mk(2, 6)];
        let entries = expand_entries(&sem("2026-09-14", false), &sessions, &plan);

        let off = entries.iter().find(|e| e.date == "2026-10-07").unwrap();
        assert_eq!(off.session.id, 1);
        assert_eq!(off.holiday, Some(HolidayKind::Off), "放假当天仍上课，打「假」标");

        let own = entries
            .iter()
            .find(|e| e.date == "2026-10-10" && e.session.id == 2)
            .unwrap();
        assert_eq!(own.holiday, None, "补班日自己的课不打标");

        let added = entries
            .iter()
            .find(|e| e.date == "2026-10-10" && e.session.id == 1)
            .unwrap();
        assert_eq!(added.holiday, Some(HolidayKind::Makeup), "额外挂上的课打「调」标");
        assert_eq!(added.week, 4);

        // 关掉映射（空计划）就该退回旧行为：不补课、不打标
        let plain = expand_entries(&sem("2026-09-14", false), &sessions, &HolidayPlan::default());
        assert_eq!(plain.len(), 2);
        assert!(plain.iter().all(|e| e.holiday.is_none()));
    }

    /// 一段课：轴只关心节次区间与时刻，其余字段随便填
    fn sess(start_unit: i64, end_unit: i64, start_time: &str, end_time: &str) -> CampusSession {
        CampusSession {
            id: start_unit,
            course_id: 1,
            weekday: 1,
            start_unit,
            end_unit,
            start_time: start_time.into(),
            end_time: end_time.into(),
            weeks: vec![1],
            weeks_str: None,
            room: None,
            building: None,
            campus: None,
            course_name: "c".into(),
            course_code: None,
            teachers: vec![],
            credits: None,
            course_type: None,
            color: None,
        }
    }

    /// 节次表的一行
    fn slot(unit: i64, start_time: &str, end_time: &str) -> RemotePeriodSlot {
        RemotePeriodSlot {
            unit,
            start_time: start_time.into(),
            end_time: end_time.into(),
        }
    }

    /// 轴压成 `(起节, 止节, 起时刻, 止时刻)`，断言读起来才像课表
    fn axis(sessions: &[CampusSession], table: &[RemotePeriodSlot]) -> Vec<(i64, i64, String, String)> {
        build_time_axis(sessions, table)
            .into_iter()
            .map(|s| (s.start_unit, s.end_unit, s.start_time, s.end_time))
            .collect()
    }

    /// 图里那所学校的作息：40 分钟一节、节间 5 分钟，第2/3节之间 25 分钟、午休 12:00→14:30。
    /// 「不对称」就是从这张表来的 —— 它不该被行轴抹平。
    fn reference_school_table() -> Vec<RemotePeriodSlot> {
        [
            (1, "08:00", "08:40"),
            (2, "08:45", "09:25"),
            (3, "09:50", "10:30"),
            (4, "10:35", "11:15"),
            (5, "11:20", "12:00"),
            (6, "14:30", "15:10"),
            (7, "15:15", "15:55"),
            (8, "16:10", "16:50"),
            (9, "16:55", "17:35"),
            (10, "17:40", "18:20"),
            (11, "19:30", "20:10"),
            (12, "20:15", "20:55"),
        ]
        .into_iter()
        .map(|(u, a, b)| slot(u, a, b))
        .collect()
    }

    /// 无节次表（树维那条路）+ 整块排课：行轴与旧实现完全一致，零回归
    #[test]
    fn axis_without_a_period_table_keeps_the_block_shape() {
        let rows = axis(
            &[
                sess(3, 4, "09:55", "11:30"),
                sess(1, 2, "08:00", "09:35"),
                sess(3, 4, "09:55", "11:30"), // 重复：同一区间只能出一行
            ],
            &[],
        );
        assert_eq!(
            rows,
            vec![
                (1, 2, "08:00".into(), "09:35".into()),
                (3, 4, "09:55".into(), "11:30".into()),
            ]
        );
    }

    /// 重叠的节次区间必须被切成互斥片段 —— 旧实现会画出 `1-2`、`2-3` 两行，
    /// 那样第2节被画两遍，一周的视觉长度也不再等于真实时间。
    #[test]
    fn axis_splits_overlapping_ranges_into_disjoint_units() {
        let rows = axis(
            &[sess(1, 2, "08:00", "09:25"), sess(2, 3, "08:45", "10:15")],
            &[],
        );
        assert_eq!(
            rows,
            vec![
                // 第1节只被 1-2 覆盖 → 那道课的封套
                (1, 1, "08:00".into(), "09:25".into()),
                // 第2节被两门课同时覆盖 → 最紧封套（最晚的开始 08:45、最早的结束 09:25）
                (2, 2, "08:45".into(), "09:25".into()),
                (3, 3, "08:45".into(), "10:15".into()),
            ]
        );
    }

    /// 有节次表就画到逐节：第1节是表里的 08:00-08:40，而不是 1-2 那道课的封套 08:00-09:25。
    /// 没课的节（第5、11、12节）不占行。
    #[test]
    fn axis_uses_the_period_table_for_per_unit_times() {
        let rows = axis(
            &[
                sess(1, 2, "08:00", "09:25"),
                sess(3, 4, "09:50", "11:15"),
                sess(6, 7, "14:30", "15:55"),
                sess(8, 10, "16:10", "18:20"),
            ],
            &reference_school_table(),
        );
        let units: Vec<(i64, i64)> = rows.iter().map(|r| (r.0, r.1)).collect();
        assert_eq!(
            units,
            vec![(1, 1), (2, 2), (3, 3), (4, 4), (6, 6), (7, 7), (8, 8), (9, 9), (10, 10)],
            "逐节轴；第5、11、12节没课，不出行"
        );
        assert_eq!(rows[0].2, "08:00");
        assert_eq!(rows[0].3, "08:40");
        // 逐节真读数：第2节止于 09:25 而第3节 09:50 才开始（中间那 25 分钟的课间休息是表给的）
        assert_eq!(rows[1], (2, 2, "08:45".into(), "09:25".into()));
        assert_eq!(rows[2], (3, 3, "09:50".into(), "10:30".into()));
        // 3 节连排的那门课，在轴上就是连续三行（前端按 span 跨行绘制）
        assert_eq!(rows[6], (8, 8, "16:10".into(), "16:50".into()));
        assert_eq!(rows[8], (10, 10, "17:40".into(), "18:20".into()));
    }

    /// 表里没有的节次（学校的晚课表只公布到第10节）→ 那一段退回封套，绝不按比例编时刻
    #[test]
    fn axis_falls_back_to_the_envelope_for_units_absent_from_the_table() {
        let table = vec![slot(1, "08:00", "08:40"), slot(2, "08:45", "09:25")];
        let rows = axis(&[sess(3, 5, "09:50", "11:15")], &table);
        assert_eq!(
            rows,
            vec![(3, 5, "09:50".into(), "11:15".into())],
            "第1、2节没课不出行；第3-5节没有表 → 用那道课的封套"
        );
    }

    /// 同一门课、同一个星期几、同一个节次，按**周次段**拆成多条（教师与教室跟着段变）。
    ///
    /// 旧唯一键 `(course, weekday, start_unit, start_time)` 会把它们并成一条：后写的那条
    /// 覆盖先写的 `weeks` / `room` / `teachers`，于是课表上只剩一个周次段（往往正好不含
    /// 本周）、教师张冠李戴 —— 用户报的「课表与实际不符」就是这个。真实样本见迁移 0049。
    #[test]
    fn same_slot_different_week_segments_are_kept_apart() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        seed_account(&conn);

        let act = |weeks: Vec<i64>, weeks_str: &str, teacher: &str| TimetableActivity {
            lesson_id: Some(322367),
            lesson_code: Some("2615286".into()),
            course_name: Some("健康教育".into()),
            weekday: Some(2),
            start_unit: Some(6),
            end_unit: Some(7),
            start_time: Some("14:30".into()),
            end_time: Some("16:05".into()),
            week_indexes: weeks,
            weeks_str: Some(weeks_str.into()),
            room: Some("17311*".into()),
            teachers: vec![teacher.into()],
            ..Default::default()
        };

        for a in [
            act(vec![5, 6, 7], "5~7", "黄观凤"),
            act(vec![8, 9], "8~9", "韦雪军"),
            act(vec![10, 11], "10~11", "杨雁"),
            act(vec![12], "12", "马瑞杰"),
        ] {
            persist_activity(&conn, 1, 1, &a)
                .unwrap()
                .expect("这条活动应当入账");
        }

        let sessions = load_sessions(&conn, 1, 1).unwrap();
        let mut health: Vec<_> = sessions
            .iter()
            .filter(|s| s.course_name == "健康教育")
            .collect();
        health.sort_by_key(|s| s.weeks.first().copied().unwrap_or(0));
        assert_eq!(health.len(), 4, "四个周次段必须各存一条");
        assert_eq!(health[0].weeks, vec![5, 6, 7]);
        assert_eq!(health[0].teachers, vec!["黄观凤".to_string()]);
        assert_eq!(health[3].weeks, vec![12]);
        assert_eq!(health[3].teachers, vec!["马瑞杰".to_string()]);

        // 课程级教师 = 各时段教师的并集：课程清单要看得全，而不是只显示最后一个写入者
        merge_course_teachers(&conn, 1, 1).unwrap();
        let merged: String = conn
            .query_row(
                "SELECT teachers FROM campus_courses WHERE remote_lesson_id = 322367",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&merged).unwrap(),
            vec![
                "黄观凤".to_string(),
                "韦雪军".to_string(),
                "杨雁".to_string(),
                "马瑞杰".to_string()
            ]
        );
    }

    /// 同一条活动重复同步不得变成两条：`weeks_key` 必须是**规范形**，与教务给的顺序无关。
    #[test]
    fn resyncing_the_same_segment_updates_in_place() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        seed_account(&conn);

        let act = |weeks: Vec<i64>| TimetableActivity {
            lesson_id: Some(317746),
            course_name: Some("大学生心理健康教育".into()),
            weekday: Some(5),
            start_unit: Some(8),
            end_unit: Some(9),
            start_time: Some("16:30".into()),
            end_time: Some("18:05".into()),
            week_indexes: weeks,
            room: Some("02109Y".into()),
            teachers: vec!["范志燕".into()],
            ..Default::default()
        };

        persist_activity(&conn, 1, 1, &act(vec![6, 7, 8])).unwrap();
        // 第二次顺序不同 —— 规范形之后仍然落在同一行
        persist_activity(&conn, 1, 1, &act(vec![8, 6, 7])).unwrap();

        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM campus_sessions WHERE course_id = \
                 (SELECT id FROM campus_courses WHERE remote_lesson_id = 317746)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "同一条时段不该因为周次顺序不同而变成两条");
    }

    #[test]
    fn axis_reports_duration_for_row_heights() {        let rows = build_time_axis(&[sess(8, 10, "16:10", "18:20")], &[]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].start_min, 970);
        assert_eq!(rows[0].duration_min, 130, "3 节连排 = 130 分钟，前端的行高按它成比例");
    }

    #[test]
    fn class_notes_compose_readable_line() {
        let s = CampusSession {
            id: 1,
            course_id: 1,
            weekday: 1,
            start_unit: 8,
            end_unit: 9,
            start_time: "16:30".into(),
            end_time: "18:05".into(),
            weeks: vec![1],
            weeks_str: None,
            room: Some("16407*".into()),
            building: Some("十六教学楼".into()),
            campus: None,
            course_name: "c".into(),
            course_code: None,
            teachers: vec!["范志燕".into(), "张三".into()],
            credits: None,
            course_type: None,
            color: None,
        };
        assert_eq!(
            class_notes(&s).unwrap(),
            "第8-9节 · 十六教学楼 16407* · 范志燕、张三"
        );
        assert_eq!(class_notes(&s).unwrap().is_empty(), false);
    }

    #[test]
    fn semester_anchor_snaps_midweek_start() {
        // 就算教务给了个周三，锚点也会吸附到那一周的周一
        let s = sem("2026-09-16", false);
        assert_eq!(semester_anchor(&s).unwrap().to_string(), "2026-09-14");
    }

    /// 物化是全链路里最容易错的 SQL（先删后建 + 跳过已打卡 + 窗口裁剪），
    /// 用一个真迁移出来的内存库把它钉住。
    fn seed_account(conn: &Connection) -> CampusSemester {
        let today = Local::now().date_naive();
        let guet_weekday = today.weekday().num_days_from_monday() as i64 + 1;
        let now = now_iso();
        conn.execute(
            "INSERT INTO campus_accounts (id, system_kind, base_url, login_name, created_at, updated_at) \
             VALUES (1, 'guet-supwisdom-eams5', 'https://x', '2600', ?1, ?1)",
            [&now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO campus_semesters (id, account_id, remote_id, name, start_date, end_date, \
             week_start_on_sunday, total_weeks, is_current) VALUES (1, 1, 321, '2026-2027 第一学期', ?1, ?2, 0, 19, 1)",
            rusqlite::params![
                today.format("%Y-%m-%d").to_string(),
                (today + Duration::days(140)).format("%Y-%m-%d").to_string(),
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO campus_courses (id, account_id, semester_id, remote_lesson_id, course_name) \
             VALUES (1, 1, 1, 900, '高等数学')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO campus_sessions (id, account_id, semester_id, course_id, weekday, start_unit, \
             end_unit, start_time, end_time, weeks, weeks_str) VALUES (1, 1, 1, 1, ?1, 1, 2, '08:00', '09:35', ?2, '1~6')",
            rusqlite::params![
                guet_weekday,
                serde_json::to_string(&vec![1, 2, 3, 4, 5, 6, 20]).unwrap(),
            ],
        )
        .unwrap();
        load_semester(conn, 1, 1).unwrap()
    }

    #[test]
    fn materialize_is_idempotent_and_preserves_done_rows() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        let sem = seed_account(&conn);
        let sessions = load_sessions(&conn, 1, 1).unwrap();

        let count_todos = |c: &Connection| -> i64 {
            c.query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0))
                .unwrap()
        };

        // 学期起始日 = 今天，星期取今天 → 第 1 周就是今天；第 20 周落在窗口外
        let first = materialize_todos(&conn, 1, &sem, &sessions, &HolidayPlan::default()).unwrap();
        assert_eq!(first, 6, "只物化窗口内的 6 周，第 20 周必须被裁掉");
        assert_eq!(count_todos(&conn), 6);

        // 幂等：重复执行不累积
        let second = materialize_todos(&conn, 1, &sem, &sessions, &HolidayPlan::default()).unwrap();
        assert_eq!(second, 6);
        assert_eq!(count_todos(&conn), 6, "先删后建，不该越跑越多");

        // 打卡一次 → 重建后它原样保留，且不会被重新创建成未完成态
        let done_id: i64 = conn
            .query_row("SELECT id FROM todos ORDER BY date LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute("UPDATE todos SET status = 'done' WHERE id = ?1", [done_id])
            .unwrap();

        let third = materialize_todos(&conn, 1, &sem, &sessions, &HolidayPlan::default()).unwrap();
        assert_eq!(third, 5, "已打卡的那一次不再重建");
        assert_eq!(count_todos(&conn), 6, "历史行 + 5 条未完成");
        let kept: String = conn
            .query_row("SELECT status FROM todos WHERE id = ?1", [done_id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kept, "done", "done 行带着原 id 保留下来");

        // 派生行的形状：分类、来源、时间口径
        let (cat, sid, sm, dur, title): (String, Option<i64>, Option<i64>, Option<i64>, String) =
            conn.query_row(
                "SELECT category, course_session_id, start_min, duration_min, title FROM todos \
                 WHERE status != 'done' LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(cat, "class");
        assert_eq!(sid, Some(1));
        assert_eq!(sm, Some(480)); // 08:00
        assert_eq!(dur, Some(95)); // 08:00→09:35
        assert_eq!(title, "高等数学");
    }

    /// 上完的课表派生行自动打卡：过去日期、今天已下课 → 翻转；今天未下课、未来、
    /// 以及已手动打卡的行一律不动。课表派生行是只读投影，这是它唯一的完成入口。
    #[test]
    fn auto_complete_flips_only_finished_classes() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        seed_account(&conn); // 建出 campus_sessions id=1，供外键引用

        let today = Local::now().date_naive();
        let ymd = |d: NaiveDate| d.format("%Y-%m-%d").to_string();
        let ins = |date: &str, start_min: i64, duration: i64, status: &str| -> i64 {
            conn.execute(
                "INSERT INTO todos (title, date, start_min, duration_min, category, status, created_at, course_session_id) \
                 VALUES ('高数', ?1, ?2, ?3, 'class', ?4, '2026-01-01T00:00:00Z', 1)",
                rusqlite::params![date, start_min, duration, status],
            )
            .unwrap();
            conn.last_insert_rowid()
        };
        let past = ins(&ymd(today - Duration::days(1)), 480, 95, "todo"); // 昨天 08:00–09:35
        let ended_today = ins(&ymd(today), 0, 0, "todo"); // 今天 00:00 起、零时长 → 必已下课
        let later_today = ins(&ymd(today), 23 * 60, 95, "todo"); // 今天 23:00 → 未下课
        let tomorrow = ins(&ymd(today + Duration::days(1)), 480, 95, "todo"); // 未来
        let manual = ins(&ymd(today - Duration::days(2)), 480, 95, "done"); // 已手动打卡

        let flipped = auto_complete_past_courses(&conn).unwrap();
        assert_eq!(flipped, 2, "只有昨天与今天已下课的两行翻转");

        let status_of = |id: i64| -> String {
            conn.query_row("SELECT status FROM todos WHERE id = ?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(status_of(past), "done");
        assert_eq!(status_of(ended_today), "done");
        assert_eq!(status_of(later_today), "todo", "今天还没上完的课不能提前打卡");
        assert_eq!(status_of(tomorrow), "todo");
        assert_eq!(status_of(manual), "done", "已打卡的行原样保留");

        // 幂等：再跑一次不再翻转
        assert_eq!(auto_complete_past_courses(&conn).unwrap(), 0);
        // 自动打卡写下的 completed_at 非空（时间线据此展示）
        let at: Option<String> = conn
            .query_row("SELECT completed_at FROM todos WHERE id = ?1", [past], |r| r.get(0))
            .unwrap();
        assert!(at.is_some(), "自动打卡必须落下 completed_at");
    }

    /// 退课/换课后：远端消失的时段被清掉，但已经打过卡的历史行**不能被牵连删除**。
    /// 这正是外键 + 「done 行永不删」两条约束的交叉点，之前就是在这里炸的。
    #[test]
    fn stale_sessions_are_removed_without_losing_history() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        let sem = seed_account(&conn);
        let sessions = load_sessions(&conn, 1, 1).unwrap();
        materialize_todos(&conn, 1, &sem, &sessions, &HolidayPlan::default()).unwrap();

        let done_id: i64 = conn
            .query_row("SELECT id FROM todos ORDER BY date LIMIT 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        conn.execute("UPDATE todos SET status = 'done' WHERE id = ?1", [done_id])
            .unwrap();

        // 该时段从远端消失；本次同步没有任何存活时段
        let removed = delete_stale_sessions(&conn, 1, 1, &[]).unwrap();
        assert_eq!(removed, 1);

        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1, "历史打卡行必须活下来");
        let (status, link): (String, Option<i64>) = conn
            .query_row(
                "SELECT status, course_session_id FROM todos",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "done");
        assert_eq!(link, None, "来源链接被摘掉，但行本身保留");

        let sessions_left: i64 = conn
            .query_row("SELECT COUNT(*) FROM campus_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sessions_left, 0);

        // 未完成的派生行随后由物化清空
        let written = materialize_todos(&conn, 1, &sem, &[], &HolidayPlan::default()).unwrap();
        assert_eq!(written, 0);
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1);
    }

    /// 注销 ≠ 删数据：会话清掉，但课表快照与整条时间线原样保留（转为只读快照）。
    #[test]
    fn logout_keeps_schedule_and_timeline() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        let sem = seed_account(&conn);
        conn.execute(
            "UPDATE campus_accounts SET cookies = '[]', session_at = '2026-01-01T00:00:00' WHERE id = 1",
            [],
        )
        .unwrap();
        materialize_todos(&conn, 1, &sem, &load_sessions(&conn, 1, 1).unwrap(), &HolidayPlan::default()).unwrap();

        clear_session(&conn, 1).unwrap();

        let (cookies, at): (Option<String>, Option<String>) = conn
            .query_row("SELECT cookies, session_at FROM campus_accounts WHERE id = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert!(cookies.is_none(), "会话必须清掉");
        assert!(at.is_none(), "会话时间必须清掉");

        let account_left: i64 = conn
            .query_row("SELECT COUNT(*) FROM campus_accounts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(account_left, 1, "账号本身保留 —— 注销不是删账号");

        let (sessions, todos_left): (i64, i64) = (
            conn.query_row("SELECT COUNT(*) FROM campus_sessions", [], |r| r.get(0))
                .unwrap(),
            conn.query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0))
                .unwrap(),
        );
        assert_eq!(sessions, 1, "课表快照保留");
        assert_eq!(todos_left, 6, "时间线保留为只读快照");
    }

    /// 删账号 = 彻底移除：派生行必须显式删（todos 未开外键级联），课表由 FK 级联带走。
    #[test]
    fn deleting_account_removes_timeline_and_schedule() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        let sem = seed_account(&conn);
        materialize_todos(&conn, 1, &sem, &load_sessions(&conn, 1, 1).unwrap(), &HolidayPlan::default()).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM todos", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            6
        );

        delete_account_data(&conn, 1).unwrap();

        for (table, label) in [
            ("campus_accounts", "账号"),
            ("campus_semesters", "学期"),
            ("campus_courses", "课程"),
            ("campus_sessions", "时段"),
            ("todos", "派生日程"),
        ] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{label} 表应当被清空");
        }
        // 非课表来源的待办不能被牵连——这条靠 SQL 的作用域保证，钉住它
        conn.execute(
            "INSERT INTO todos (title, category, priority, status, created_at) \
             VALUES ('自己的事情', 'general', 0, 'todo', '2026-01-01T00:00:00')",
            [],
        )
        .unwrap();
        delete_account_data(&conn, 1).unwrap();
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1, "与课表无关的待办不许被删");
    }

    /// 切学期：只清「非当前学期」的**未完成**派生行，已打卡的历史与新学期的行都不许动。
    #[test]
    fn switching_semester_clears_only_other_semesters_open_rows() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        let sem = seed_account(&conn);
        // 第一学期（旧）：物化出一批未完成派生行
        materialize_todos(&conn, 1, &sem, &load_sessions(&conn, 1, 1).unwrap(), &HolidayPlan::default()).unwrap();

        // 第二学期（新）+ 一条属于它的时段与派生行（模拟刚同步完的当前学期）
        conn.execute(
            "INSERT INTO campus_semesters (id, account_id, remote_id, name, start_date, end_date, \
             week_start_on_sunday, total_weeks, is_current) \
             VALUES (2, 1, 322, '2026-2027 第二学期', '2027-02-22', '2027-07-04', 0, 19, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO campus_sessions (id, account_id, semester_id, course_id, weekday, start_unit, \
             end_unit, start_time, end_time, weeks, weeks_str) \
             VALUES (2, 1, 2, 1, 1, 1, 2, '08:00', '09:35', '[1]', '1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO todos (title, category, priority, status, created_at, course_session_id, date) \
             VALUES ('新学期的课', 'class', 0, 'todo', '2026-01-01T00:00:00', 2, ?1)",
            [Local::now().date_naive().format("%Y-%m-%d").to_string()],
        )
        .unwrap();

        // 旧学期里挑一条打成 done，验证历史不被牵连
        let done_id: i64 = conn
            .query_row(
                "SELECT id FROM todos WHERE course_session_id = 1 ORDER BY date LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute("UPDATE todos SET status = 'done' WHERE id = ?1", [done_id])
            .unwrap();

        switch_semester(&conn, 1, 2).unwrap();

        let old_open: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM todos WHERE course_session_id = 1 AND status != 'done'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old_open, 0, "旧学期没打勾的派生行要清掉，否则与新学期的课叠在一起");

        let done_kept: String = conn
            .query_row("SELECT status FROM todos WHERE id = ?1", [done_id], |r| r.get(0))
            .unwrap();
        assert_eq!(done_kept, "done", "打过的卡是历史，切学期不许动它");

        let new_kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM todos WHERE course_session_id = 2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(new_kept, 1, "新学期的行不属于「非当前学期」，不能被误删");

        let current: i64 = conn
            .query_row("SELECT id FROM campus_semesters WHERE is_current = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(current, 2, "当前学期标记要跟着切");
        let flags: i64 = conn
            .query_row("SELECT COUNT(*) FROM campus_semesters WHERE is_current = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(flags, 1, "同一时刻只能有一个当前学期");
    }

    /// 没有可删的时段时直接返回，不做无谓的写
    #[test]
    fn delete_stale_is_noop_when_nothing_disappeared() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        seed_account(&conn);
        assert_eq!(delete_stale_sessions(&conn, 1, 1, &[1]).unwrap(), 0);
        assert_eq!(delete_stale_sessions(&conn, 1, 99, &[]).unwrap(), 0);
    }

    /// 网关读路径（`campus_schedule_readonly_on`）**只投影、不写库**：
    /// 一堆未完成的派生待办（含重建窗口之外的那些）调完之后必须一条不少。
    ///
    /// 这条守的是权限模型：`schedule.read` 只授了读，而 `campus_schedule_on` 里的
    /// `materialize_todos` 开头就是 `DELETE FROM todos WHERE status != 'done'
    /// AND course_session_id IN (本账号)` —— 走错版本，外部客户端拿读权限就能删掉
    /// 用户没打完卡的待办（窗口外的那些删了就再也不回来）。
    #[test]
    fn readonly_schedule_view_never_deletes_derived_todos() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        seed_account(&conn); // 学期第 1 周 = 今天，课在第 1~6 与第 20 周（session id = 1）

        let today = Local::now().date_naive();
        let ymd = |d: NaiveDate| d.format("%Y-%m-%d").to_string();
        let inside = ymd(today + Duration::days(35)); // 第 6 周：物化窗口（today+35）的最后一格
        let outside = ymd(today + Duration::days(133)); // 第 20 周：远在窗口之外
        let ins = |date: &str, status: &str| -> i64 {
            conn.execute(
                "INSERT INTO todos (title, date, start_min, duration_min, category, status, created_at, course_session_id) \
                 VALUES ('高等数学', ?1, 480, 95, 'class', ?2, '2026-01-01T00:00:00Z', 1)",
                rusqlite::params![date, status],
            )
            .unwrap();
            conn.last_insert_rowid()
        };
        let inside_id = ins(&inside, "todo");
        let outside_id = ins(&outside, "todo");

        let view = campus_schedule_readonly_on(
            &conn,
            Some(1),
            Some(ymd(today - Duration::days(1))),
            Some(ymd(today + Duration::days(140))),
        )
        .unwrap();

        // 投影本身正确：第 1~6 周 + 第 20 周都在查询区间里，形状照旧
        let dates: Vec<&str> = view.entries.iter().map(|e| e.date.as_str()).collect();
        assert_eq!(dates.len(), 7, "7 次课（6 次窗口内 + 1 次窗口外）");
        assert!(dates.contains(&inside.as_str()) && dates.contains(&outside.as_str()));
        assert!(view.entries.iter().all(|e| e.session.course_name == "高等数学"));
        assert_eq!(view.entries[0].session.start_time, "08:00");
        assert_eq!(view.semester.as_ref().map(|s| s.id), Some(1));

        // 关键断言：两条未完成的派生行原样还在（id / date / status 逐字段对上）
        let kept: Vec<(i64, String, String)> = {
            let mut stmt = conn
                .prepare("SELECT id, date, status FROM todos ORDER BY id")
                .unwrap();
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
                })
                .unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        assert_eq!(
            kept,
            vec![
                (inside_id, inside.clone(), "todo".to_string()),
                (outside_id, outside.clone(), "todo".to_string()),
            ],
            "只读变体一条派生待办都不许删、不许改"
        );

        // 对照（非期望行为）：前端那条路会物化，窗口外的未完成派生行先删之后不再重建。
        campus_schedule_on(&conn, Some(1), None, None).unwrap();
        let left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM todos WHERE id IN (?1, ?2)",
                rusqlite::params![inside_id, outside_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0, "对照：物化版把这两行都删了（这正是网关不能走它的原因）");
    }
}
