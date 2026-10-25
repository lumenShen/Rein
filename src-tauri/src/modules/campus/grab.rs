//! 自动抢课引擎：**预设任务单 → 到点自动出手 → 没抢到按策略接着抢**。
//!
//! # 为什么这段逻辑必须在 Rust 里
//!
//! 抢课不是「点一下等结果」，是**跟时间赛跑**：窗口由教务处定时开放，开的那一刻几百人同时点。
//! 赢的条件只有两条 —— 出手够准（贴着开窗那一秒）、够有耐心（满员了就守着，等别人退）。
//! 这两件事都不能交给页面：
//!
//! - 页面会被切走、被系统回收、被 WebView 节流（后台标签页的定时器普遍降到 1 次/分钟），
//!   而**抢课恰恰发生在用户放下手机去干别的时候**；
//! - 用户可能提前一晚就把任务排好，第二天早上开机它得接着抢 —— 状态必须落库。
//!
//! 所以形状与 `modules/kb/worker.rs` 一致：一个进程内的后台线程 + 一张 SQLite 任务表 +
//! 一条推给前端的事件流。页面只是**显示器**，关掉页面不影响任何事。
//!
//! # 单线程 + 全局节流
//!
//! 引擎一轮只发一个请求（见 [`step`]），且所有请求共用一个最小间隔闸门
//! （[`GrabHub::pace`]）。并发提交在这里是负收益：对面是同一台教务服务器，
//! 并发既抢不到更多，又最容易触发风控，还会让「为什么被拒」变得无法解释。
//! 单线程 + 全局节流 = 请求速率完全可预测，这是能长期守着一个名额的前提。
//!
//! # 一个任务要过的关
//!
//! ```text
//! 等窗口（本机时钟 + 服务器偏差校正）
//!   └─ 开窗前 lead_ms 出手
//!        ├─ [占位模式] add-predicate（不花意愿值）→ 轮询 predicate-response
//!        └─ [直接模式] 跳过
//!        └─ add-request → 轮询 add-drop-response
//!             ├─ success    → 到手，收工
//!             ├─ needAttend → 时间冲突，需要人去网页端办免听
//!             └─ 失败       → 分级处理：满员就守着 / 未知就退避 / 明确了就停
//! ```
//!
//! # 几条不肯让步的鲁棒性规矩
//!
//! 1. **永不信任本机时钟。** 开火时刻一律用「教务墙上时间 − 实测偏差」换算（[`fire_at_ms`]）。
//!    学生电脑的时间经常偏几分钟，而窗口只开几小时 —— 偏了就是白等。
//! 2. **结果不明时先核对，再决定重投。** 轮询超了上限不等于失败：请求可能早就成功了，
//!    只是回执没回来。重投之前一定先用 `simplest-lessons` 看一眼这门课是不是已经在自己名下
//!    （[`reconcile_lost_request`]）—— 不然会把到手的名额当失败再抢一次。
//! 3. **换令牌不算失败。** 令牌过期是最常见的中途故障，换一张就能接着干，
//!    绝不能让它吃掉任务的重试次数。
//! 4. **窗口一关就收手。** 不靠「教务回一句选课已结束」来停手 —— 那句话的具体措辞
//!    我们没样本，赌不起。窗口闭区间是教务自己给的，用它。
//! 5. **崩溃重启能接着干。** 任务落在 `campus_grab_tasks`，启动时把 `running` 归位成
//!    「等一会再动」，并且**优先去核对上一次那张受理单**，而不是重新投一次。

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{Local, NaiveDate, NaiveDateTime, TimeZone};
use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{ReinError, Result};
use crate::state::{AppState, CampusHub};

use super::course_select::{CourseSelectClient, TOKEN_EXPIRED};
use super::matcher::{self, LessonHit};
use super::models::*;

/// 事件名：与前端 `campusService.onGrab` 的监听对应。
pub const GRAB_EVENT: &str = "campus://grab";

/// 没有任何任务时的轮询间隔。够慢，不浪费电。
const IDLE_WAIT_MS: i64 = 2000;
/// 模块关闭时的心跳间隔。**不是「什么都不做」的循环**：`step` 在开头就返回，
/// 什么请求都不发；这个睡眠只是保证开关被打开后（notify 会立刻打断它）
/// 或者有别的唤醒源时，引擎还能定期醒来看一眼开关有没有变。
const DISABLED_WAIT_MS: i64 = 3000;
/// 有任务但不着急时的最大睡眠。太长了会让「刚入队一个任务」响应变钝。
const MAX_WAIT_MS: i64 = 5000;
/// 临近开火时的睡眠上限（进入 [`APPROACH_MS`] 之后用）
const APPROACH_WAIT_MS: i64 = 25;
/// 距开火多久算「临近」：这段时间内的睡眠要细，一秒里要能醒好几回。
const APPROACH_MS: i64 = 3000;
/// 探测完窗口之后的小憩。**只用于窗口探测那条路径** ——
/// 提交/轮询之后不再睡固定值，而是按节流闸门睡（见 `step` 末尾），
/// 否则「最小间隔」调得再小也会被这个固定值压住。
const BUSY_WAIT_MS: i64 = 30;
/// 服务器时间重采样间隔（毫秒）。偏差是缓变量，不必每轮都问。
const TIME_RESAMPLE_MS: i64 = 30_000;
/// 会话失效后的重试间隔：不硬停，而是隔一会再试一次 ——
/// 用户可能去「课表配置」重登了一下，引擎应当自己活过来。
const SESSION_RETRY_MS: i64 = 60_000;
/// 拿不到选课客户端（非会话问题）时的重试间隔
const CLIENT_RETRY_MS: i64 = 10_000;
/// 未知错误的最大连败次数。满员/繁忙这类**已知可重试**的不受此限，未知的不能无限撞。
const UNKNOWN_STRIKE_LIMIT: i64 = 8;
/// 「教务在限速」与「教务服务器出错」时的**下一次动作**延迟。
///
/// 这两类都是**对方的**问题，不是这条请求的问题：教务限速说明我们打得太快（它还能收），
/// 5xx 说明它自己崩了（等它缓过来就行）。所以这里的策略是**不降速、不放弃**——
/// 把任务立刻放回队首，真正的节奏交给引擎那唯一的节流闸门（`min_interval_ms`）去管。
/// 反过来做（连败退避）在抢课里最贵：窗口只有几分钟，退避一次就少几十次机会。
const BACKPRESSURE_RETRY_MS: i64 = 0;
/// 被教务拒了一次（满员）之后，这个候选**先退开多久**。
///
/// 取 1 秒是搬的抢课项目那份调参（他们对被拒的候选做 1 秒冷却再重匹配）：
/// 冷却期间出手机会交给组里下一个候选 —— 退课可能发生在任何一个班，
/// 而死守第一个班时，别的班空出来我们是看不见的。
///
/// **必须长于节流间隔**（默认 700ms），否则下一次心跳它就又到点了，等于没退开；
/// 所以实际用的是 `max(1s, 节流间隔 × 2)`，见 [`absorb_error`]。
const REJECT_COOLDOWN_MS: i64 = 1_000;
/// 去 `open-turns` 问「窗口公布了没有」的间隔。分钟级足够 ——
/// 窗口是教务处按分钟公布的，不是按毫秒。
const TURN_PROBE_MS: i64 = 60_000;
/// [`fire_at_ms`] 的「闸门未知」返回值：不是没有闸门，而是我们还不知道开窗时刻。
/// 用它把任务挡在门外，交给 [`probe_windows`] 去把时刻问出来。
const GATE_UNKNOWN: i64 = i64::MAX;
/// 教学班名单的缓存时长。解析计划与输入预览共用；名单是分钟级才变的东西。
const LESSON_CACHE_MS: i64 = 60_000;
/// 计划解析失败（批次没出现 / 名单拉不到 / 一个班都没匹配上）之后的重试间隔。
/// 比满员重试慢得多：这几件事都是分钟级才可能变。
const INTENT_RETRY_MS: i64 = 60_000;
/// 一条计划最多往界面带多少个候选教学班。查询写得很宽时（比如只敲了一个「学」）
/// 可能匹配上百个班，而快照是每秒都可能推一次的 —— 不能让一屏垃圾拖着事件流走。
const INTENT_CANDIDATE_CAP: usize = 12;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/* ─────────────────────────── 错误分级 ─────────────────────────── */

/// 一次失败该怎么对待。抢课引擎的全部「耐心」都集中在这个判断上。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// 换张令牌接着干，**不计入尝试次数**
    TokenRefresh,
    /// 教务会话失效：引擎降速，并把它暴露到界面上等用户处理
    SessionLost,
    /// **教务在限速**（请求过于频繁 / 429）：对方还有反应，只是让我们慢点。
    /// 应对是**保持节奏继续打**，而不是退避 —— 见 [`BACKPRESSURE_RETRY_MS`]。
    Throttled,
    /// **教务服务器出错**（5xx / 服务异常 / 连接被重置）：对方自己崩了。
    /// 同样不退避：它缓过来的那一刻正是我们要抢的那一秒。
    ServerDown,
    /// **请求本身被拒**（参数错误 / 400 / 422）：重试一万次也是同一个结果，
    /// 而且每次都在用错误的参数骚扰教务。停下来，立刻交给 AI 去查现场、改参数。
    BadRequest,
    /// 时间冲突：必须人去教务网页端办免听，本地重试一万次也没用
    Conflict,
    /// 名额满了。名额释放是稀疏事件，值得一直守着，但节奏要慢。
    Full,
    /// 明确不会再成功（已选过 / 不在时段 / 无权限）。停止，别浪费对方带宽。
    Fatal,
    /// 一般性可重试：繁忙、超时、网络抖动、以及**认不出来的错误**。
    Retry,
}

impl Verdict {
    /// 落库用的短标识，同时是「同类连败」的比较键。
    fn kind(self) -> &'static str {
        match self {
            Verdict::TokenRefresh => "token",
            Verdict::SessionLost => "session",
            Verdict::Throttled => "throttled",
            Verdict::ServerDown => "server",
            Verdict::BadRequest => "badreq",
            Verdict::Conflict => "conflict",
            Verdict::Full => "full",
            Verdict::Fatal => "fatal",
            Verdict::Retry => "retry",
        }
    }

    /// 这一类失败该不该重置「连败」计数。换令牌是引擎内务，与任务本身无关。
    fn resets_strikes(self) -> bool {
        match self {
            // 限流与 5xx 是**对方的状态**：把连败记在这条任务账上毫无意义，
            // 记下去只会让退避越来越大 —— 而那正是抢课里最不该做的事。
            Verdict::TokenRefresh | Verdict::Throttled | Verdict::ServerDown => true,
            _ => false,
        }
    }

    /// 这一类的失败**不该消耗**用户的提交上限：请求根本没被受理。
    fn spares_attempt_budget(self) -> bool {
        matches!(self, Verdict::Throttled | Verdict::ServerDown)
    }
}

/// 教务的错误文案 → 应对方式。
///
/// **关键词顺序是有讲究的**：先判「满员」再判「已选过」，因为满员的文案里常常带「已选」
/// （「已选人数已达上限」）。反过来判的话，满员会被当成「已选过」直接停手 ——
/// 那是抢课里最贵的 bug：你以为在守着，其实早就放弃了。
///
/// 认不出来的一律按 [`Verdict::Retry`]（可重试）处理：抢课里误停的代价远大于多试几次，
/// 而「无限撞同一个未知错误」由 [`UNKNOWN_STRIKE_LIMIT`] 兜底。
pub fn verdict_of(message: &str) -> Verdict {
    let m = message.trim();
    if m.is_empty() {
        return Verdict::Retry;
    }
    if m.contains(TOKEN_EXPIRED) || m.contains("选课令牌") {
        return Verdict::TokenRefresh;
    }
    if m.contains("会话已过期") || m.contains("重新登录") || m.contains("登录已过期")
    {
        return Verdict::SessionLost;
    }

    // ⓪ **服务端说「你的 JSON 我读不懂」**：那是**我们的**写法问题（字段类型/名字不对），
    //    不是教务崩了。它长得像 5xx（响应码常常就是 500，正文里还带 `Internal Server Error`），
    //    但重试一万次也是同一个结果 —— 所以必须判在下面那两类「继续打」之前。
    //
    //    真出过（2026-09-22 联调）：`courseSelectTurnAssoc` 发成了字符串，Jackson 直接 500，
    //    引擎把它记成「教务服务器出错（继续重试）」，于是**每一枪都注定失败却永远不停手**，
    //    而且把责任安在了教务头上。原文：
    //    `JSON parse error: Can not construct instance of …CourseSelectTurnAssoc:
    //     no String-argument constructor/factory method to deserialize from String value ('1921')`
    for kw in [
        "json parse error",
        "httpmessagenotreadable",
        "cannot construct instance",
        "no string-argument constructor",
        "cannot deserialize",
        "notreadable",
    ] {
        if m.contains(kw) || m.to_ascii_lowercase().contains(kw) {
            return Verdict::BadRequest;
        }
    }

    // ⓪ 先认「对方的毛病」：限流与 5xx 都要**继续打**，而它们的文案里常常带别的词
    //    （「请求过于频繁，请稍后再试」里有「请稍后」；「服务器繁忙」里有「繁忙」），
    //    所以这两类必须判在满员/可重试之前，否则会被兜底吞掉、走上退避那条路。
    for kw in [
        "请求过于频繁",
        "操作过于频繁",
        "请求频繁",
        "访问频繁",
        "请求过多",
        "请求太多",
        "请求太快",
        "频率超限",
        "超出频率",
        "频率限制",
        "限流",
        "too many requests",
        "rate limit",
        "429",
    ] {
        if m.contains(kw) || m.to_ascii_lowercase().contains(kw) {
            return Verdict::Throttled;
        }
    }
    for kw in [
        "服务器内部错误",
        "服务异常",
        "服务器异常",
        "系统异常",
        "服务器繁忙",
        "系统繁忙",
        "服务不可用",
        "服务器维护",
        "连接被重置",
        "连接重置",
        "502",
        "503",
        "504",
        "500",
        "bad gateway",
        "service unavailable",
        "internal server error",
        "connection reset",
    ] {
        if m.contains(kw) || m.to_ascii_lowercase().contains(kw) {
            return Verdict::ServerDown;
        }
    }

    // ① 满员（必须在「已选过」之前判）
    for kw in [
        "人数已满",
        "已满",
        "满员",
        "名额",
        "已达上限",
        "达到上限",
        "超出容量",
        "余量不足",
        "限选人数",
        "容量已",
    ] {
        if m.contains(kw) {
            return Verdict::Full;
        }
    }

    // ② 时间冲突（教务常在文案里直接说「免听」）
    for kw in ["免听", "时间冲突", "上课时间冲突", "冲突"] {
        if m.contains(kw) {
            return Verdict::Conflict;
        }
    }

    // ③ 明确不会再成功
    for kw in [
        "已经选过",
        "已选过",
        "已经选中",
        "已选中",
        "重复提交",
        "请不要重复",
        // 「相同教学班只能选一次」是占位回执里的判词（真机实测）：这门课已经在名下，
        // 再投多少次都是同一句话，必须停 —— 而它在 2026-09-22 之前一直落在「可重试」里，
        // 白白烧掉 8 次出手机会才判死（那是窗口里最贵的东西）。
        "只能选一次",
        // 「不符合选课条件组要求」（真机实测）＝这门课不为本年级/院系/专业开放。
        // 它是**硬条件**，不会因为多试几次而变，和「无权限」是同一族。
        "不符合选课条件",
        "条件组",
        "不在选课时间",
        "选课时间已",
        "选课已结束",
        "未开放",
        "已结束",
        "没有权限",
        "无权限",
        "无权选",
        "禁止选",
        "不允许选",
        "学籍",
        "欠费",
        "未缴费",
        "已停开",
        "已撤销",
        "教学班不存在",
        "课程不存在",
        "培养方案",
    ] {
        if m.contains(kw) {
            return Verdict::Fatal;
        }
    }

    // ④ **请求本身被拒**：判在终态之后 —— 「参数错误：教学班不存在」这种要按「不存在」处理，
    //    而不是把一条本来就该收手的请求推给 AI。纯参数问题的典型文案：
    //    「请求参数错误」「缺少必填参数」「参数校验失败」「HTTP 400/422」。
    //    这一类**重试不解决问题**，而且每次都在用错的参数骚扰教务 —— 停下来交给 AI。
    for kw in [
        "参数错误",
        "参数有误",
        "参数不合法",
        "参数无效",
        "参数不正确",
        "参数校验",
        "缺少参数",
        "缺少必填",
        "非法参数",
        "请求参数",
        "格式错误",
        "格式不正确",
        "反序列化",
        "bad request",
        "unprocessable",
        "400",
        "422",
    ] {
        if m.contains(kw) || m.to_ascii_lowercase().contains(kw) {
            return Verdict::BadRequest;
        }
    }

    Verdict::Retry
}

/* ─────────────────────────── 墙上时间 ─────────────────────────── */

/// 教务墙钟文本 → 本机时区下的 unix 毫秒。
///
/// 只在**同一个参照系**里做差（服务器时间 vs 开窗时间），所以这里的时区选择无害：
/// 本机时区对这两个值的影响完全一致，做差时抵消。真正重要的是别把
/// 「教务墙上时间」直接当成「本机时间」去比 —— 那才会偏出时区差。
///
/// 教务的写法五花八门（秒可有可无、分隔符有 `-` `/` `年` 之分），所以先归一化再逐个格式试。
pub fn wall_to_ms(text: &str) -> Option<i64> {
    let cleaned = text
        .trim()
        .replace(['年', '月'], "-")
        .replace(['日', '号'], " ")
        .replace('：', ":")
        .replace('／', "/")
        .replace('T', " ");
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return None;
    }

    const DATETIME: &[&str] = &[
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S %z",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
    ];
    for fmt in DATETIME {
        if let Ok(dt) = NaiveDateTime::parse_from_str(&cleaned, fmt) {
            return Local
                .from_local_datetime(&dt)
                .single()
                .map(|d| d.timestamp_millis());
        }
    }
    // 只给了日期（如 `2026-09-17`）：按当天 00:00 处理
    const DATE: &[&str] = &["%Y-%m-%d", "%Y/%m/%d"];
    for fmt in DATE {
        if let Ok(d) = NaiveDate::parse_from_str(&cleaned, fmt) {
            return d
                .and_hms_opt(0, 0, 0)
                .and_then(|dt| Local.from_local_datetime(&dt).single())
                .map(|d| d.timestamp_millis());
        }
    }
    None
}

/// 任务的开火时刻（本机 unix 毫秒）。
///
/// `skew_ms = 教务墙钟 − 本机时钟`（采样时测得），于是
/// `本机开火时刻 = 教务开窗时刻 − skew − lead`。
/// `lead` 是提前量：请求要在路上走一会，早一点出手才能让**请求本身**
/// 落在开窗那一瞬间，而不是排在开窗之后。
///
/// 返回 `None` = **没有窗口闸门**，任务完全由重试节奏支配。两种情况都算「已经出过手」：
/// 正式提交过（`attempts > 0`），或占位已经交过（`predicate_done`）——
/// 窗口闸门只管**第一枪**，打出去之后就不该再拿它挡路。
pub fn fire_at_ms(task: &GrabTask, skew_ms: i64, lead_ms: i64) -> Option<i64> {
    if task.attempts > 0 || task.predicate_done {
        return None;
    }
    match task.window_wall.as_deref() {
        Some(wall) => Some(wall_to_ms(wall)? - skew_ms - lead_ms),
        // 窗口还没公布：**不是「没有闸门」，是「闸门未知」**。
        // 这里若返回 None（= 立刻开火），任务会一头撞上「不在选课时间」被判终态，
        // 提前一晚的预设就白做了。挡住它，让 [`probe_windows`] 去把时刻问出来。
        None if task.await_window => Some(GATE_UNKNOWN),
        None => None,
    }
}

/// 窗口是否已经关闭。关闭之后无论多想要都不该再打教务 —— 那是纯粹的无用功。
pub fn window_closed(task: &GrabTask, skew_ms: i64) -> bool {
    match task.window_end_wall.as_deref().and_then(wall_to_ms) {
        Some(end) => now_ms() >= end - skew_ms,
        None => false,
    }
}

/// 窗口**正在开放中**吗（开了、且还没关）？
///
/// 抢课只在「窗口开着」这段时间里是短兵相接：名额随时可能被人退出来，
/// 而谁在盯着、盯得多密，决定了那一秒是谁的。窗口外（还没开、已经关）则相反 ——
/// 打得再快也没有东西可抢，慢一点没有任何代价。
///
/// 起点未知（`window_wall` 为空）算**没开**：那正是「还不知道什么时候开」，
/// 按慢节奏守着的代价最小（`probe_windows` 会去把时刻问出来）。
pub fn window_open(task: &GrabTask, skew_ms: i64) -> bool {
    match task.window_wall.as_deref().and_then(wall_to_ms) {
        Some(start) => now_ms() >= start - skew_ms && !window_closed(task, skew_ms),
        None => false,
    }
}

/* ─────────────────────────── 引擎 ─────────────────────────── */

/// 抢课引擎的把手：挂在 Tauri state 上，命令层通过它叫醒线程 / 读上次的故障。
#[derive(Default)]
pub struct GrabHub {
    wake: Mutex<Option<Sender<()>>>,
    /// 上一次推给前端的快照。内容没变就不重复推 —— 引擎每秒醒若干次，
    /// 不加这个闸门会把事件总线刷满。
    last_emit: Mutex<String>,
    last_error: Mutex<Option<String>>,
    /// 上一次真正发出请求的时刻（本机 ms）。**全局节流闸门**：
    /// 不管任务单上有几门课，打向教务的请求速率都由它唯一决定。
    last_request: AtomicI64,
    /// 教学班名单缓存（解析计划用）。见 [`GrabHub::lessons_cached`]。
    lessons: Mutex<Option<LessonCache>>,
    /// 「已选人数」的小缓存：`教学班id -> (取样时刻, 人数)`。见 [`fill_seats`]。
    ///
    /// 为什么连这个都要缓存：界面的**预览是逐键触发的**，而名额要单独打一次
    /// `std-count` —— 不缓存的话，敲一个「高」字就是一次教务请求。
    seats: Mutex<HashMap<String, (i64, StdCount)>>,
    /// 名单落盘的位置（`None` = 只缓存在内存里，见 [`GrabHub::with_data_dir`]）。
    dump_path: Option<std::path::PathBuf>,
    /// 「现在用的名单是旧的」——只在教务拉不到、改用落盘名单时非空。
    lessons_stale: Mutex<Option<String>>,
    /// **模块开关**：抢课是课表的子模块，默认关闭（见 `plugins/builtin/campusGrab.ts`）。
    ///
    /// 这是真门闩，不是界面开关：关闭时 `step` 一进来就返回，**一个请求都不发**
    /// （连窗口探测都不做）。持久化在 `app_meta`，开机时读回来 ——
    /// 否则「关掉之后重启」会自己又跑起来，而用户看不到任何解释。
    enabled: AtomicBool,
}

/// 名单落盘的文件名。
///
/// 一个文件就够：里面记着**是哪个批次**的（`turn_id`），换批次时整体覆盖 ——
/// 抢课只看当前批次，旧批次的名单没有留着的价值。
fn lessons_dump_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("campus_lessons.json")
}

/// 落盘的那份名单（`saved_at` 用来告诉人「这是多久以前的」）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonsDump {
    /// 哪个批次
    pub turn_id: String,
    /// 什么时候拉的（本机 ms）
    pub saved_at: i64,
    /// 提交体要用的批次 id（兜底时 `turn_assoc` 也多半打不通，所以一并存下来）
    #[serde(default)]
    pub assoc: Option<String>,
    /// 教学班（原样存教务给的形状，读回来就是 `CourseSelectLesson`）
    pub lessons: Vec<CourseSelectLesson>,
}

/// 一份缓存下来的教学班名单。
struct LessonCache {
    turn_id: String,
    at: i64,
    lessons: Vec<CourseSelectLesson>,
    /// 「进批次」拿到的批次 id（提交体要用的那个），拿不到时为 None
    assoc: Option<String>,
}

impl GrabHub {
    /// 名单缓存的落盘目录（应用数据目录）。
    ///
    /// 引擎在 `setup` 里拿到它再 manage 进来；不设就是「只缓存在内存里」——
    /// 行为与落盘版一致，只是重启后不认旧名单。
    pub fn with_data_dir(dir: std::path::PathBuf) -> Self {
        Self {
            dump_path: Some(lessons_dump_path(&dir)),
            ..Self::default()
        }
    }

    /// 叫醒引擎立刻重算（入队/取消/改设置后调它，界面因此是「即时」的）。
    pub fn notify(&self) {
        if let Ok(guard) = self.wake.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(());
            }
        }
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|e| e.clone())
    }

    fn set_error(&self, msg: Option<String>) {
        if let Ok(mut e) = self.last_error.lock() {
            *e = msg;
        }
    }

    /// 距下一次可发请求还有多久。0 = 现在就能发。
    fn pace_gap_ms(&self, min_interval_ms: i64) -> i64 {
        let last = self.last_request.load(Ordering::Relaxed);
        (min_interval_ms - (now_ms() - last)).max(0)
    }

    fn mark_request(&self) {
        self.last_request.store(now_ms(), Ordering::Relaxed);
    }

    /// 拿一个批次的教学班名单（60 秒缓存）。
    ///
    /// 「计划解析」与界面上的「输入预览」都要看**教务现在有哪些班**，所以两边共用这一份缓存：
    /// 名单是分钟级才变的东西，而人敲一次预览不该变成一次全量查询。
    ///
    /// 顺带把 `assoc`（提交体要用的批次 id）也带回来 —— 它同样是「进批次」才拿得到的，
    /// 而解析出来的任务马上要用，不想在开窗前那一秒再多一次往返。
    pub(crate) fn lessons_cached(
        &self,
        ctx: &super::commands::SelectContext,
        turn_id: &str,
    ) -> Result<(Vec<CourseSelectLesson>, Option<String>)> {
        if let Ok(guard) = self.lessons.lock() {
            if let Some(c) = guard.as_ref() {
                if c.turn_id == turn_id && now_ms() - c.at < LESSON_CACHE_MS {
                    return Ok((c.lessons.clone(), c.assoc.clone()));
                }
            }
        }

        let query = LessonQuery {
            has_count: Some(true),
            ..Default::default()
        };
        let fresh = ctx
            .client
            .query_lesson(ctx.student_id, turn_id, &query)
            .or_else(|e| {
                // 教务若在这个轮次的表单里没有 `hasCount`，整条查询可能被拒。
                // 名额只是排序的加分项 —— **宁可没有名额，也不能拿不到名单**。
                if matches!(
                    verdict_of(&e.to_string()),
                    Verdict::TokenRefresh | Verdict::SessionLost
                ) {
                    Err(e)
                } else {
                    ctx.client
                        .query_lesson(ctx.student_id, turn_id, &LessonQuery::default())
                }
            });

        let lessons = match fresh {
            Ok(l) => l,
            Err(e) => {
                // **兜底**：教务答不上来时，用上一次落盘的名单接着干。
                // 这不是「优先读缓存」—— 新鲜名单永远优先；只有拉不到时才用它，
                // 而且要在界面上说清这是旧的（名额一定变了，见 `lessons_fallback_note`）。
                let Some(dump) = self.load_lessons_dump(turn_id) else {
                    return Err(e);
                };
                let age_min = (now_ms() - dump.saved_at).max(0) / 60_000;
                let note = format!(
                    "教务拉不到名单（{e}），正在用 {age_min} 分钟前落盘的那份（名额可能已变）"
                );
                println!("[名单] {note}");
                if let Ok(mut slot) = self.lessons_stale.lock() {
                    *slot = Some(note);
                }
                // 用旧名单里的批次 id：这条路上 `turn_assoc` 多半也打不通，
                // 而它正是提交体要用的那个值（拿不到就退化成 turn_id）。
                let assoc = dump
                    .assoc
                    .clone()
                    .unwrap_or_else(|| ctx.client.turn_assoc(ctx.student_id, turn_id));
                return Ok((dump.lessons, Some(assoc)));
            }
        };
        if let Ok(mut slot) = self.lessons_stale.lock() {
            *slot = None;
        }
        let assoc = ctx.client.turn_assoc(ctx.student_id, turn_id);

        if let Ok(mut guard) = self.lessons.lock() {
            *guard = Some(LessonCache {
                turn_id: turn_id.to_string(),
                at: now_ms(),
                lessons: lessons.clone(),
                assoc: Some(assoc.clone()),
            });
        }
        self.save_lessons_dump(turn_id, &lessons, Some(&assoc));
        Ok((lessons, Some(assoc)))
    }

    /// 「现在用的名单是不是旧的」——给界面与体检用。`None` = 用的是新鲜名单。
    pub fn lessons_fallback_note(&self) -> Option<String> {
        self.lessons_stale.lock().ok().and_then(|n| n.clone())
    }

    /// 把这份名单**落盘**（原子写：先写临时文件再改名）。
    ///
    /// 为什么要落盘：教务的名单接口在开窗前后最忙，502/超时都见过；
    /// 而「上一次拉到的名单」能让引擎在那一刻**照样解析出该抢哪些班**，
    /// 只是名额数字要当作过期的（见 [`Self::load_lessons_dump`] 的说明）。
    ///
    /// 写失败**只记不报**：落盘是加固措施，不能因为它没写成而挡住解析。
    fn save_lessons_dump(&self, turn_id: &str, lessons: &[CourseSelectLesson], assoc: Option<&str>) {
        let Some(path) = self.dump_path.as_ref() else {
            return;
        };
        let dump = LessonsDump {
            turn_id: turn_id.to_string(),
            saved_at: now_ms(),
            assoc: assoc.map(str::to_string),
            lessons: lessons.to_vec(),
        };
        let Ok(text) = serde_json::to_string(&dump) else {
            return;
        };
        let tmp = path.with_extension("json.tmp");
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if std::fs::write(&tmp, text).is_ok() {
            // 改名是原子的：不会留下一个「写了一半的名单」
            if let Err(e) = std::fs::rename(&tmp, path) {
                println!("[名单] 落盘失败（不影响抢课）：{e}");
            }
        }
    }

    /// 读回上一次落盘的名单（**只认同一个批次**）。
    ///
    /// 什么时候用它：**只是拉不到新名单时的兜底**，绝不优先于新鲜名单 ——
    /// 预先抄下来的 `lessonAssoc` 赌的是「名单没变过」，而抢课偏偏就是
    /// 拿这个去赌，所以这里只在教务答不上来时用，并且调用方要把
    /// 「这是几分钟前的名单」说出来（名额尤其会变）。
    pub fn load_lessons_dump(&self, turn_id: &str) -> Option<LessonsDump> {
        let path = self.dump_path.as_ref()?;
        let text = std::fs::read_to_string(path).ok()?;
        let dump: LessonsDump = serde_json::from_str(&text).ok()?;
        (dump.turn_id == turn_id && !dump.lessons.is_empty()).then_some(dump)
    }

    /// 启动后台线程。与 `KbHub::start` 同形：先 manage 好状态再调它。
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        // **先把开关读回来**（落在 `app_meta`，默认关）：关闭状态下，
        // 对账与外投口都要跳过 —— 用户关了抢课，开机就不该有任何动作。
        {
            let state = app.state::<AppState>();
            let conn = state.db.lock();
            let on = read_meta(&conn, ENABLED_KEY).as_deref() == Some("1");
            self.set_enabled_flag(on);
        }

        let (tx, rx) = mpsc::channel::<()>();
        if let Ok(mut guard) = self.wake.lock() {
            *guard = Some(tx);
        }
        // 启动对账：上一次进程若在请求途中被杀，任务会停在 running。
        // 把它们归位成「稍后重试」，并按「先核对受理单」的顺序继续 —— 见模块头第 5 条。
        // 关闭时也照做：它是**纯本地**的归位（不发请求），且不做的话，
        // 用户之后一打开开关就会有一批卡在 running 的死任务。
        reconcile_on_start(&app);

        let hub = Arc::clone(self);
        std::thread::Builder::new()
            .name("rein-grab-engine".into())
            .spawn(move || worker_loop(app, hub, rx))
            .expect("启动抢课引擎线程失败");
    }

    /// 模块开关的当前值。
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// 打开/关闭引擎。命令层与启动路径共用；`notify` 会立刻中断当前那次睡眠，
    /// 所以「打开」是立即生效的，不必等下一轮心跳。
    pub fn set_enabled_flag(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
        self.notify();
    }
}

/// `app_meta` 里的开关键。值 `"1"` = 开，其余（含缺省）= 关 ——
/// **默认关**是产品要求（抢课是课表的子模块），所以缺省必须是关而不是开。
pub const ENABLED_KEY: &str = "campus_grab_enabled";

/// 启动对账：把中断的 running 任务放回队列。
///
/// **不重置 `request_id` / `polls`** —— 中断很可能发生在「刚刚提交成功、还没轮询到结果」
/// 之间，那张受理单可能已经把事情办了。留着它，下一步会先去核对。
fn reconcile_on_start(app: &AppHandle) {
    {
        let state = app.state::<AppState>();
        let conn = state.db.lock();
        let _ = conn.execute(
            "UPDATE campus_grab_tasks SET status = 'waiting', phase = 'idle', next_at = ?1 \
             WHERE status = 'running'",
            [now_ms()],
        );
    }

    // 关机期间投进来的预定点也要落库 —— 开机就该接着抢，而不是等下一次心跳。
    // 锁要分开拿：`drain_intake` 自己会去锁库。
    let account_id = {
        let state = app.state::<AppState>();
        let conn = state.db.lock();
        active_account_id(&conn).ok().flatten()
    };
    if let Some(id) = account_id {
        let _ = drain_intake(app, id);
    }
}

fn worker_loop(app: AppHandle, hub: Arc<GrabHub>, rx: mpsc::Receiver<()>) {
    loop {
        let wait = match step(&app, &hub) {
            Ok(w) => {
                if hub.last_error().is_some() {
                    hub.set_error(None);
                }
                w
            }
            Err(e) => {
                hub.set_error(Some(e.to_string()));
                // 引擎级故障也要让界面看到（例如任务表读不出来）
                emit(&app, &hub);
                Duration::from_millis(2000)
            }
        };
        // 有信号立刻醒；否则睡到下次该动的时候
        match rx.recv_timeout(wait) {
            Ok(()) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// 引擎的一次心跳：算出「现在最该动哪个任务的哪一步」，做掉它，然后返回该睡多久。
///
/// **一轮只发一个请求**，且受 [`GrabHub::pace_gap_ms`] 的全局闸门约束。
fn step(app: &AppHandle, hub: &GrabHub) -> Result<Duration> {
    // ── 模块开关（默认关）。**这是最先判的一件事**：关着的时候连窗口探测都不做 ——
    //    「关了还在每分钟问一次教务」和没关没有区别。睡眠给得比较短，
    //    因为 `set_enabled_flag` 的 notify 能立刻打断它，「打开」是即时生效的。
    if !hub.enabled() {
        return Ok(Duration::from_millis(DISABLED_WAIT_MS as u64));
    }

    let state = app.state::<AppState>();

    // ── 短锁：读设置 + 账号。出了这个块就没有锁了。
    let (settings, account_id, probed_at) = {
        let conn = state.db.lock();
        let settings = load_settings(&conn)?;
        let Some(account_id) = active_account_id(&conn)? else {
            // 没登录：静默待命，什么都不做（界面会提示去配置）
            return Ok(Duration::from_millis(IDLE_WAIT_MS as u64));
        };
        let probed = read_meta(&conn, PROBED_KEY).and_then(|s| s.parse::<i64>().ok());
        (settings, account_id, probed)
    };
    let probe_due = probed_at
        .map(|at| now_ms() - at >= TURN_PROBE_MS)
        .unwrap_or(true);

    // ── 投递口：外部（开机监控脚本 / 人）投进来的抢课意图先落库，
    //    **落完再读任务** —— 这样这一轮就能把它当普通任务处理，不必等下一次心跳。
    if let Some(e) = drain_intake(app, account_id) {
        hub.set_error(Some(e));
    }
    let tasks = {
        let conn = state.db.lock();
        load_active_tasks(&conn, account_id)?
    };

    let campus = app.state::<CampusHub>();

    // ── 窗口监听。**不再只在「有人排队等窗口」时才探测。**
    //    窗口开放前连该排什么课都不知道，而「窗口开了」这件事恰恰必须让
    //    没停在选课页面上的人也马上知道。所以只要账号在、开关开着，
    //    就每分钟安静地问一次 `open-turns`（照旧走全局节流，不额外加压）。
    let watching = settings.watch_window
        && (tasks.is_empty()
            || tasks
                .iter()
                .any(|t| t.await_window && t.window_wall.is_none()));
    if watching && probe_due {
        hub.mark_request();
        let ctx = super::commands::select_context(&state.db, &campus);
        match ctx {
            Ok(ctx) => {
                if let Err(e) = probe_windows(&state, &ctx, &tasks) {
                    hub.set_error(Some(e.to_string()));
                }
            }
            Err(e) => return park_everything(app, hub, &state, &tasks, e.to_string()),
        }
        emit(app, hub);
        return Ok(Duration::from_millis(BUSY_WAIT_MS as u64));
    }

    // ── 计划解析：把「我想抢 高数 张」落成具体的教学班任务。
    //    **排在任务之前**：一条没解析的计划在任务单上一个字都没有，用户看到的是「没反应」；
    //    而解析只花一次名单查询（60 秒缓存），不该等任务都忙完才轮到它。
    //    与任务共用同一个节流闸门 —— 「一轮一个请求」这条规矩对解析同样成立。
    let due_intent = {
        let conn = state.db.lock();
        load_due_intent(&conn, account_id, now_ms())?
    };
    if let Some(mut intent) = due_intent {
        let gap = hub.pace_gap_ms(settings.min_interval_ms);
        if gap > 0 {
            return Ok(Duration::from_millis(gap as u64));
        }
        hub.mark_request();
        match super::commands::select_context(&state.db, &campus) {
            // 账号对不上（用户切了账号）：计划留着给人看，但不动手
            Ok(ctx) if ctx.account_id != account_id => {}
            Ok(ctx) => {
                if let Err(e) = resolve_intent(&state, hub, &ctx, &mut intent) {
                    // 解析失败不判死计划：写一句能看懂的话，等下一次重试
                    let msg = e.to_string();
                    let status = if intent.status == INTENT_EMPTY {
                        INTENT_EMPTY
                    } else {
                        INTENT_PENDING
                    };
                    let _ = park_intent(&state, &mut intent, status, msg, INTENT_RETRY_MS);
                }
            }
            Err(e) => {
                let _ = park_intent(
                    &state,
                    &mut intent,
                    INTENT_PENDING,
                    e.to_string(),
                    INTENT_RETRY_MS,
                );
            }
        }
        emit(app, hub);
        return Ok(Duration::from_millis(
            hub.pace_gap_ms(settings.min_interval_ms).max(1) as u64,
        ));
    }

    if tasks.is_empty() {
        emit(app, hub);
        return Ok(Duration::from_millis(IDLE_WAIT_MS as u64));
    }

    // ── 挑一个「已经到点」的任务：谁最急先管谁
    let now = now_ms();
    let mut best: Option<(i64, usize)> = None;
    let mut soonest = i64::MAX;
    // 判断「到点」要用偏差，所以这里先读缓存里那份（不采样）—— 采样的位置见下面那条分支
    let (skew_ms, _) = cached_clock(&state);
    for (i, t) in tasks.iter().enumerate() {
        // 志愿组里还没轮到它：不出手，**也不参与「谁最急」** ——
        // 否则它会把自己算成 soonest，让引擎一直为它空醒。
        if !armed(t, &tasks, &settings, now) {
            continue;
        }
        let when = if window_closed(t, skew_ms) {
            // 窗口关了：立刻让它进入收尾，界面不该继续显示「在抢」
            now
        } else {
            fire_at_ms(t, skew_ms, settings.lead_ms)
                .unwrap_or(i64::MIN)
                .max(t.next_at)
        };
        if when <= now && best.map(|(k, _)| when < k).unwrap_or(true) {
            best = Some((when, i));
        }
        soonest = soonest.min(when.max(now));
    }

    let Some((_, idx)) = best else {
        // ── 没有任务等着出手：**这才是采样时钟的时机**。
        //    有任务等着出手时（上面那条分支）一次采样要白占半秒，而那半秒正是
        //    开窗那一瞬间的出手时机 —— 所以偏差只在等待期更新，出手时读缓存。
        refresh_clock_if_stale(&state, &campus);
        // 都还没到点：睡到最近的那个时刻，但别超过 MAX_WAIT_MS
        let delta = (soonest - now).max(0);
        let wait = if delta <= APPROACH_MS {
            delta.clamp(APPROACH_WAIT_MS, 200)
        } else {
            delta.clamp(50, MAX_WAIT_MS)
        };
        emit(app, hub);
        return Ok(Duration::from_millis(wait as u64));
    };

    // ── 全局节流：最近发得太密就先歇一下，这是防封的主要旋钮
    let gap = hub.pace_gap_ms(settings.min_interval_ms);
    if gap > 0 {
        return Ok(Duration::from_millis(gap as u64));
    }

    // ── 无锁：拿选课客户端（缓存命中则零网络；未命中要去门户换令牌，约一秒）
    // 会话过期时 `select_context` 会自己静默重登一次 —— 抢课最怕的就是
    // 「人到齐了、窗口开了，结果会话掉了要等用户手动重登」。
    let ctx = match super::commands::select_context(&state.db, &campus) {
        Ok(c) => c,
        Err(e) => return park_everything(app, hub, &state, &tasks, e.to_string()),
    };

    // 账号对不上（例如用户切了账号）：旧任务留着给人看，但不动手
    if ctx.account_id != account_id {
        return Ok(Duration::from_millis(IDLE_WAIT_MS as u64));
    }

    // ── 无锁：执行一步
    let mut task = tasks[idx].clone();
    hub.mark_request();
    act(&ctx, &settings, &mut task, skew_ms);

    // 令牌被服务端拒了：**立刻清掉进程内的缓存**，否则下一轮还会拿着这张死令牌撞上去，
    // 而 `CampusHub::cached_select_token` 只看 JWT 的 exp —— 它不知道服务端已经不认了。
    if task.strike_kind.as_deref() == Some("token") {
        if let Ok(mut slot) = campus.select_token.lock() {
            *slot = None;
        }
    }

    // ── 短锁：写回。**写回前重新读一次状态** —— 用户在这一次网络往返里
    //    可能已经取消或暂停了这个任务，不能把结果盖回去让它复活。
    {
        let conn = state.db.lock();
        let keep = match load_task(&conn, task.id)? {
            Some(c) => c.status != GRAB_PAUSED && c.status != GRAB_CANCELLED,
            None => false,
        };
        if keep {
            save_task(&conn, &task)?;
            // 中了就顺手收组。同组的备选与它是**互斥**的，继续抢下去只会
            // 多抢到一门时间冲突的课 —— 那正是志愿组要防的事。
            if task.status == GRAB_SUCCESS {
                let _ = close_group(&conn, &task)?;
            }
        }
    }

    emit(app, hub);
    // 干完活之后按**节流闸门**睡，而不是睡一个固定值。
    //
    // 这里原来是固定的 `BUSY_WAIT_MS`（30ms），等于把速率硬压在 ~33 次/秒 ——
    // 于是「最小间隔调成 10ms」在界面上看着生效、实际完全不起作用（最阴的那种谎）。
    // 闸门开着就只睡 1ms（把 CPU 让出去），闸门关着就睡够剩下的时间。
    Ok(Duration::from_millis(
        hub.pace_gap_ms(settings.min_interval_ms).max(1) as u64,
    ))
}

/// 哪些任务该因为「批次被撤下」收手。
///
/// 判据是**两次探测之间的差**，而不是一次结果：
///
/// - 上一轮列表里有这个批次，这一轮没有了 → 真的撤下了；
/// - 上一轮也没有 → 那是「还没公布」，继续等（提前一晚排的课就是这样）；
/// - 这一轮列表是空的 → 只是「没见过的批次都不算撤下」，避免教务偶发空列表
///   把用户所有的任务一次性判死。
///
/// 另外**只收手上没有受理单的**：已经投出去的那些要先把结果核对完
/// （见模块头第 2 条）—— 把一张可能已经中了的单子当失败丢掉，是最亏的一种错。
fn withdrawn_tasks<'a>(
    tasks: &'a [GrabTask],
    previous: &[GrabTurnBrief],
    briefs: &[GrabTurnBrief],
) -> Vec<&'a GrabTask> {
    tasks
        .iter()
        .filter(|t| {
            !grab_is_terminal(&t.status)
                && t.status != GRAB_PAUSED
                && t.request_id.is_none()
                && previous.iter().any(|b| b.id == t.turn_id)
                && !briefs.iter().any(|b| b.id == t.turn_id)
        })
        .collect()
}

/// 去 `open-turns` 把「窗口什么时候开」问出来，填进那些还在等的任务。
///
/// 这一步是「提前预设」能成立的关键：教务处很少一次就把窗口时间给全，
/// 用户往往提前一晚就把课排好了。与其让任务去盲撞（撞出「不在选课时间」会被判终态），
/// 不如每分钟安静地问一次，拿到就转成精确开火。
fn probe_windows(
    state: &tauri::State<'_, AppState>,
    ctx: &super::commands::SelectContext,
    tasks: &[GrabTask],
) -> Result<()> {
    // 上一轮探测到的批次列表：**用来分辨「还没公布」与「被撤下了」**。
    // 只靠一次「列表里没有它」判死太险 —— 教务偶尔会回一份空列表，
    // 那不该被读成「你的课被撤了」。上架过、现在不在，才是真的撤下。
    let previous = {
        let conn = state.db.lock();
        read_turns(&conn)
    };
    // 强制拉一次：这个调用点本来就是「到点了，去问一次」。
    // 计划解析走的是 [`turn_briefs`]，同一个一分钟内不会再打一遍教务。
    let briefs = fetch_turn_briefs(state, ctx)?;
    let conn = state.db.lock();

    // **收手条件**：批次上架过、现在从 `open-turns` 里消失了 —— 教务处把它撤下 / 提前关了。
    // 这时窗口的墙上时间已经不能作数（它是撤下前的说法），继续守着只会白等。
    for t in withdrawn_tasks(tasks, &previous, &briefs) {
        let who = t
            .turn_name
            .clone()
            .unwrap_or_else(|| t.turn_id.clone());
        let mut row = t.clone();
        finish(
            &mut row,
            GRAB_FAILED,
            &format!("批次「{who}」已从教务的选课列表里消失（多半被提前关闭或撤下），已停止"),
        );
        save_task(&conn, &row)?;
    }

    for t in tasks
        .iter()
        .filter(|t| t.await_window && t.window_wall.is_none())
    {
        let Some(brief) = briefs.iter().find(|b| b.id == t.turn_id) else {
            continue; // 批次还没出现在列表里，继续等
        };
        match (brief.window_start.as_deref(), brief.window_end.as_deref()) {
            // 窗口时间有了 → 转成精确开火
            (Some(open), end) => {
                conn.execute(
                    "UPDATE campus_grab_tasks SET window_wall = ?2, window_end_wall = ?3, \
                     await_window = 0, next_at = ?4, last_message = ?5 WHERE id = ?1",
                    rusqlite::params![
                        t.id,
                        open,
                        end,
                        now_ms(),
                        format!("已获知选课窗口：{open} 开放")
                    ],
                )?;
            }
            // 没有时间但允许进入 → 窗口就是现在开着的，立刻出手
            (None, _) if brief.allow_enter => {
                conn.execute(
                    "UPDATE campus_grab_tasks SET await_window = 0, next_at = ?2, \
                     last_message = ?3 WHERE id = ?1",
                    rusqlite::params![t.id, now_ms(), "选课窗口已开放，立即开抢"],
                )?;
            }
            // 批次在列表里但还没公布时间：继续等，把状态讲给用户听
            _ => {
                conn.execute(
                    "UPDATE campus_grab_tasks SET last_message = ?2 WHERE id = ?1",
                    rusqlite::params![t.id, "等待教务公布选课窗口"],
                )?;
            }
        }
    }
    Ok(())
}

/// 教务当前有哪些批次，**一分钟内复用上回的结果**。
///
/// 窗口监听与计划解析都要它，而「有哪些批次、窗口开没开」是分钟级才变的东西；
/// 两边各打一次只会让开窗那一分钟多出无谓的请求。
fn turn_briefs(
    state: &tauri::State<'_, AppState>,
    ctx: &super::commands::SelectContext,
) -> Result<Vec<GrabTurnBrief>> {
    let cached = {
        let conn = state.db.lock();
        read_meta(&conn, PROBED_KEY)
            .and_then(|s| s.parse::<i64>().ok())
            .map(|at| (read_turns(&conn), at))
    };
    if let Some((briefs, at)) = cached {
        if now_ms() - at < TURN_PROBE_MS {
            return Ok(briefs);
        }
    }
    fetch_turn_briefs(state, ctx)
}

/// 真的去 `open-turns` 问一次，并把结果落库 —— 界面要显示「窗口开没开」，
/// 而这件事不该只活在某一轮心跳的内存里（关掉 App 再打开，它得还在）。
fn fetch_turn_briefs(
    state: &tauri::State<'_, AppState>,
    ctx: &super::commands::SelectContext,
) -> Result<Vec<GrabTurnBrief>> {
    let turns = ctx.client.open_turns(ctx.student_id)?;
    let briefs: Vec<GrabTurnBrief> = turns.iter().map(turn_brief).collect();
    {
        let conn = state.db.lock();
        let _ = write_meta(
            &conn,
            TURNS_KEY,
            &serde_json::to_string(&briefs).unwrap_or_default(),
        );
        let _ = write_meta(&conn, PROBED_KEY, &now_ms().to_string());
    }
    Ok(briefs)
}

/// 拿不到选课客户端时：**不判死任何任务**，只把整批降速重排。
///
/// 会话失效是最好修的一种故障 —— 用户去「课表配置」重登一下就好，
/// 所以引擎该做的是隔一分钟再试，而不是把用户排了一晚上的任务单清空。
fn park_everything(
    app: &AppHandle,
    hub: &GrabHub,
    state: &tauri::State<'_, AppState>,
    tasks: &[GrabTask],
    message: String,
) -> Result<Duration> {
    let kind = verdict_of(&message);
    let delay = if kind == Verdict::SessionLost {
        SESSION_RETRY_MS
    } else {
        CLIENT_RETRY_MS
    };
    let until = now_ms() + delay;
    {
        let conn = state.db.lock();
        for t in tasks {
            park(&conn, t, until, &message, kind)?;
        }
    }
    hub.set_error(Some(message));
    emit(app, hub);
    Ok(Duration::from_millis(delay.min(2000) as u64))
}

/// 执行一个任务的一步。就地修改 `task`（调用方负责落库）。
///
/// 一次调用 = 一个网络请求，要么轮询、要么提交。
fn act(
    ctx: &super::commands::SelectContext,
    settings: &GrabSettings,
    task: &mut GrabTask,
    skew_ms: i64,
) {
    // 窗口已关：收手，并说清为什么
    if window_closed(task, skew_ms) {
        finish(task, GRAB_FAILED, "选课窗口已关闭，未能抢到");
        return;
    }

    task.status = GRAB_RUNNING.into();
    task.queued_at.get_or_insert_with(now_ms);

    if task.phase == PHASE_POLL && task.request_id.is_some() {
        poll(ctx, settings, task, skew_ms);
    } else {
        submit(ctx, settings, task, skew_ms);
    }
}

/// 这一步该交占位，还是该交正式请求？
///
/// 抽成一个函数是因为它是**最容易写错的一处判断**：显式用 `predicate_done`，
/// 绝不可以用 `attempts == 0` 反推 —— 占位落定到正式提交之间 `attempts` 仍然是 0，
/// 那样的推断会让任务在「占位 → 轮询 → 占位」里打转，正式请求一辈子发不出去。
/// （真出过这个 bug，是 `scripts/e2e-auto-grab.mjs` 逮到的。）
fn needs_predicate(task: &GrabTask) -> bool {
    task.mode == "predicate" && !task.predicate_done
}

/// 手上这张受理单是**占位单**（该问 `predicate-response`）还是正式单（`add-drop-response`）？
///
/// 两个条件缺一不可：占位交过（`predicate_done`）**且**正式提交还没发生（`attempts == 0`）。
///
/// 这里和 [`needs_predicate`] 是**互补判断**，曾经写反成「`needs_predicate` 为真时才是占位单」——
/// 而占位交完 `predicate_done` 就为真了，于是占位单被拿去问 `add-drop-response`：
/// 那个接口不认识占位号，永远回空，任务一路空转到轮询上限才重投。
/// 后果不是少一次请求，而是**占位优先模式整整慢半分钟**（`max_polls` 次 × 轮询间隔），
/// 中间那句「占位成功，正在正式确认」成了永远走不到的死分支。
fn polls_predicate(task: &GrabTask) -> bool {
    task.mode == "predicate" && task.predicate_done && task.attempts == 0
}

/// 受理单落在哪个域上。见 [`GrabTask::request_domain`]：**受理号不能跨域查询**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RidDomain {
    Primary,
    Mirror,
}

/// 一次提交的收成：跟踪哪张受理号、它在哪个域、另一条单子（如果有）。
#[derive(Debug, Clone)]
struct SubmitReceipt {
    rid: String,
    domain: RidDomain,
    /// 另一条单子的受理号，必定在**对面**那个域上（镜像域或主域）。
    other: Option<String>,
}

/// 两张受理号里**该跟踪哪一张**。
///
/// 主域优先：那是账号自己的域，Cookie 与令牌都是为它准备的。主域没有受理号时
/// 才轮到镜像域 —— 但那时必须把「它在镜像域」一起交出去（[`RidDomain::Mirror`]），
/// 否则轮询会拿镜像的号去问主域，而那个号在主域上不存在。
///
/// 抽成纯函数是因为这是「受理号不能跨域查询」的唯一裁决点：挑错域的代价是
/// **一路空转到轮询上限、把已经到手的名额当失败重投**，而那个场景（主域被拒、
/// 镜像域受理成功）恰恰只在真机上才出现，不抽出来就没有能钉住它的测试。
fn pick_receipt(primary: &str, mirror: &str) -> Option<SubmitReceipt> {
    match (primary.is_empty(), mirror.is_empty()) {
        (false, _) => Some(SubmitReceipt {
            rid: primary.to_string(),
            domain: RidDomain::Primary,
            other: (!mirror.is_empty()).then(|| mirror.to_string()),
        }),
        (true, false) => Some(SubmitReceipt {
            rid: mirror.to_string(),
            domain: RidDomain::Mirror,
            other: None,
        }),
        (true, true) => None,
    }
}

/// 把一张受理单记到任务上（两个调用点：占位与正式提交）。
fn record_receipt(task: &mut GrabTask, receipt: &SubmitReceipt) {
    task.request_id = Some(receipt.rid.clone());
    task.mirror_request_id = receipt.other.clone();
    task.request_domain = match receipt.domain {
        RidDomain::Mirror => Some(REQUEST_DOMAIN_MIRROR.to_string()),
        RidDomain::Primary => None,
    };
}

/// **两个域都发**：把同一份提交同时打向主域与镜像域，取先成功的那个。
///
/// 语义要精确，否则会变成「重复选课」这种事故：
/// - 两个域**不是同一套系统**（见 `lesson_search::plan_dual_fire`），所以这里发的是
///   「各自系统里的一次正常提交」，不是同一笔请求发两遍；
/// - 谁先返回受理号就用谁的受理号去轮询（`request_id` + `mirror_pending` 记录另一条）；
/// - 两边都失败时，把**两边的原话**都留下 —— 只说一边会让人以为另一边没问题。
///
/// 镜像域是 `Option`：探测到它没有 EAMS5 时为 `None`，此时**只发主域**，
/// 并把原因写在 `mirror_note` 里（界面据此说明「另一个域为什么没发」）。
fn submit_both(
    ctx: &super::commands::SelectContext,
    items: &[AddItem],
    turn: &str,
    predicate: bool,
) -> Result<SubmitReceipt> {
    let call = |client: &CourseSelectClient| -> Result<String> {
        if predicate {
            client.add_predicate(ctx.student_id, turn, items.to_vec(), None)
        } else {
            client.add_request(ctx.student_id, turn, items.to_vec(), None)
        }
    };

    let primary = call(&ctx.client);
    let mirror = ctx.mirror.as_ref().map(call);

    let rid = primary.as_ref().ok().cloned().unwrap_or_default();
    let rid2 = mirror
        .as_ref()
        .and_then(|r| r.as_ref().ok().cloned())
        .unwrap_or_default();

    match pick_receipt(&rid, &rid2) {
        Some(receipt) => Ok(receipt),
        None => {
            // 两边都没成：把两边的原话合起来，别只报一边
            let mut msgs = Vec::new();
            if let Err(e) = &primary {
                msgs.push(format!("主域：{e}"));
            }
            if let Some(Err(e)) = &mirror {
                msgs.push(format!("镜像域：{e}"));
            }
            if msgs.is_empty() {
                msgs.push("两边都没有返回受理号".into());
            }
            Err(ReinError::Message(msgs.join("；")))
        }
    }
}

/// 「另一个域」这一句：两边都发了就说两边，没发就说清**为什么没发**。
///
/// 抽成纯函数是为了能被测 —— 它是三种状态的一句话总结，塞进 `submit` 里就只能
/// 靠真抢一次课去看文案。三种状态都要有话说：
///
/// - 两边都受理 → 报「两个域都已提交」；否则用户看到一条受理号会以为只有一个域在打；
/// - 有第二个域但这次没受理 → 明说「只跟踪主域」，别让人以为镜像那条也在跑；
/// - 压根没有第二个域 → 用 `mirror_note`（里面写着是哪个域、为什么不发）。
///
/// 最后一种正是「静默跳过比发错更糟」的落点：探测到对方没有 EAMS5 时我们**故意不发**，
/// 那就必须说出来，否则用户会以为两边都在打（见 `lesson_search::plan_dual_fire`）。
fn dual_suffix(has_mirror: bool, sent_both: bool, mirror_note: &str) -> String {
    if sent_both {
        return "（两个域都已提交）".to_string();
    }
    if has_mirror {
        return "（镜像域未受理，只跟踪主域）".to_string();
    }
    if mirror_note.is_empty() {
        return String::new();
    }
    format!("（{mirror_note}）")
}

/// 提交一步：按模式决定先占位还是直接投。
fn submit(
    ctx: &super::commands::SelectContext,
    settings: &GrabSettings,
    task: &mut GrabTask,
    skew_ms: i64,
) {
    let items = vec![AddItem {
        lesson_assoc: task.lesson_id.clone(),
        virtual_cost: task.virtual_cost,
        schedule_group_assoc: task.schedule_group_id.clone(),
        need_attend: None,
    }];
    // 提交类接口的批次 id 只在**请求体**里（路径上没有），且用的是「进批次」那个
    // （见 `GrabTask::turn_assoc`）。先拷出来，免得与后面的可变借用打架。
    let turn = task.turn_assoc().to_string();

    // ① 占位优先：开窗瞬间先占住队列位次（不花意愿值），落定后再正式确认。
    //    只交一次 —— 交过之后每次重试都直接投正式请求，
    //    否则每轮重试都要多打一个请求，白白拉长出手间隔。
    if needs_predicate(task) {
        // **两个域都发**：占位也一样两边都占 —— 谁先给受理号就用谁的去轮询。
        match submit_both(ctx, &items, &turn, true) {
            Ok(receipt) => {
                record_receipt(task, &receipt);
                task.predicate_done = true;
                task.phase = PHASE_POLL.into();
                task.polls = 0;
                task.status = GRAB_RUNNING.into();
                let dual = dual_suffix(
                    ctx.mirror.is_some(),
                    task.mirror_request_id.is_some(),
                    &ctx.mirror_note,
                );
                task.last_message = Some(format!("已占位，等待教务受理{dual}"));
                task.next_at = now_ms() + settings.poll_interval_ms;
                task.strikes = 0;
                task.strike_kind = None;
                return;
            }
            Err(e) => return absorb_error(task, settings, e.to_string(), skew_ms),
        }
    }

    // ② 正式提交 —— 同样**两个域都发**
    task.attempts += 1;
    match submit_both(ctx, &items, &turn, false) {
        Ok(receipt) => {
            record_receipt(task, &receipt);
            task.phase = PHASE_POLL.into();
            task.polls = 0;
            task.status = GRAB_RUNNING.into();
            // 两边都发时说清「另一条也发了」：否则用户看到一条受理号会以为只有一个域在打
            let dual = dual_suffix(
                ctx.mirror.is_some(),
                task.mirror_request_id.is_some(),
                &ctx.mirror_note,
            );
            task.last_message = Some(if task.attempts == 1 {
                format!("已提交，等待教务处理{dual}")
            } else {
                format!("第 {} 次提交，等待教务处理{dual}", task.attempts)
            });
            task.next_at = now_ms() + settings.poll_interval_ms;
            task.strikes = 0;
            task.strike_kind = None;
        }
        Err(e) => absorb_error(task, settings, e.to_string(), skew_ms),
    }
}

/// 轮询一步。占位阶段盯 `predicate-response`，正式提交盯 `add-drop-response`。
///
/// **问哪个域由受理号决定**：两个域是两套系统，受理号不能跨域查询
/// （见 [`GrabTask::request_domain`]）。
fn poll(
    ctx: &super::commands::SelectContext,
    settings: &GrabSettings,
    task: &mut GrabTask,
    skew_ms: i64,
) {
    let rid = task.request_id.clone().unwrap_or_default();
    if rid.is_empty() {
        // 受理号丢了：回到提交那一步
        task.phase = PHASE_IDLE.into();
        task.next_at = now_ms();
        return;
    }
    // 手上这张是占位单还是正式单，取决于**正式提交发生过没有** —— 不是「占位交没交过」，
    // 占位交完那一刻手里正握着占位单（见 [`polls_predicate`]）。
    let is_predicate = polls_predicate(task);

    let ask = |client: &CourseSelectClient, rid: &str| -> Result<serde_json::Value> {
        if is_predicate {
            client.predicate_response(ctx.student_id, rid)
        } else {
            client.add_drop_response(ctx.student_id, rid)
        }
    };

    // 受理号属于哪个域，就问哪个域。镜像域已经不可用时（探测结论变了 / 账号换域）
    // 直接走「先核对再重投」—— 拿镜像的号去问主域只会得到永远的空。
    let owner = if task.request_on_mirror() {
        match ctx.mirror.as_ref() {
            Some(m) => m,
            None => return reconcile_lost_request(ctx, task),
        }
    } else {
        &ctx.client
    };

    let raw = match ask(owner, &rid) {
        Ok(v) => v,
        Err(e) => return absorb_error(task, settings, e.to_string(), skew_ms),
    };

    // **另一条单子也要看**：两个域是两套系统，各自有自己的受理号。
    // 主域这条还在处理时，镜像域那条可能已经出结果了 —— 只盯主域的话，
    // 抢到课的那一条会被当成「还在处理」一直轮询到超时，然后被当成失败重投。
    // （`mirror_request_id` 恒属镜像域；镜像域自己那条被跟踪时不走这里，见 `pick_receipt`。）
    if raw.is_null() {
        if let (Some(mirror), Some(rid2)) = (ctx.mirror.as_ref(), task.mirror_request_id.clone()) {
            if !rid2.is_empty() {
                if let Ok(v2) = ask(mirror, &rid2) {
                    if !v2.is_null() {
                        // 镜像域先出结果：把它当作本轮的结果来判（下面的逻辑完全一致）
                        task.mirror_request_id = None;
                        task.last_message = Some("另一条提交先返回了结果".into());
                        return judge(settings, task, v2, is_predicate, skew_ms);
                    }
                }
            }
        }
    }

    // `data` 为空 = 服务端还在处理
    if raw.is_null() {
        task.polls += 1;
        if task.polls >= settings.max_polls {
            return reconcile_lost_request(ctx, task);
        }
        task.next_at = now_ms() + settings.poll_interval_ms;
        task.last_message = Some("教务处理中".into());
        return;
    }

    judge(settings, task, raw, is_predicate, skew_ms);
}

/// 占位回执里这一门课的判词；**通过**（`ATTEND` / 无判词）返回 `None`。
///
/// 占位（`add-predicate`）的 `data` 长这样（2026-09-22 真机实测）：
///
/// ```json
/// {"success": true, "result": {"319505": {"textZh": "相同教学班只能选一次", "textEn": "…"}}}
/// ```
///
/// `success` 只说明「这条占位单处理完了」，**每个教学班各有一条判词** —— 只有
/// `ATTEND`（或干脆没有判词）才算真的通过。判死的那些若还去发正式请求，
/// 就是拿一次注定失败的出手去换一句一定会来的拒绝，而出手机会是窗口里最贵的东西。
/// （同一套判据写在前端 `funRredicateResult` 里，见 `选课系统接口分析.md`。）
fn predicate_reject_note(raw: &serde_json::Value, lesson_id: &serde_json::Value) -> Option<String> {
    let want = matcher::id_text(lesson_id);
    let map = raw.get("result")?.as_object()?;
    let entry = map
        .get(&want)
        .or_else(|| map.iter().find(|(k, _)| k.trim() == want).map(|(_, v)| v))?;
    let text = entry
        .get("textZh")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() || text.eq_ignore_ascii_case("ATTEND") {
        return None;
    }
    Some(text)
}

/// 判定一条**已经拿到结果**的受理单。
///
/// 抽成函数是因为它现在有**两个调用点**：主域那条，以及「两个域都发」时
/// 镜像域那条先出结果的情况。两处必须走同一套判定 —— 抄一份的话，
/// 迟早出现「主域认成功、镜像域认失败」这种自相矛盾的行为。
fn judge(
    settings: &GrabSettings,
    task: &mut GrabTask,
    raw: serde_json::Value,
    is_predicate: bool,
    skew_ms: i64,
) {
    // 占位先看**逐条判词**：判死了就当场收手，别再发正式请求（见 [`predicate_reject_note`]）。
    if is_predicate {
        if let Some(note) = predicate_reject_note(&raw, &task.lesson_id) {
            println!("[抢课] 占位被拒（lessonId={}）：{note}", matcher::id_text(&task.lesson_id));
            return absorb_error(task, settings, note, skew_ms);
        }
    }

    let r: CourseSelectResult = serde_json::from_value(raw).unwrap_or(CourseSelectResult {
        success: false,
        error_message: None,
        resend: false,
    });

    // 占位落定 → 立刻转正式确认。这是抢课里最要紧的一次衔接，不留间隔。
    if is_predicate && r.success {
        task.phase = PHASE_SUBMIT.into();
        task.request_id = None;
        // 占位这条已经用完了，镜像域那条同样是占位单，一并清掉：
        // 正式确认会重新两边都发一遍（见 submit_both）。
        task.mirror_request_id = None;
        task.request_domain = None;
        task.polls = 0;
        task.next_at = now_ms();
        task.last_message = Some("占位成功，正在正式确认".into());
        task.strikes = 0;
        task.strike_kind = None;
        return;
    }

    if r.success {
        finish(task, GRAB_SUCCESS, "已抢到");
        task.request_id = None;
        task.mirror_request_id = None;
        task.request_domain = None;
        return;
    }

    if r.resend {
        finish(
            task,
            GRAB_CONFLICT,
            "与已选课程时间冲突，需到教务网页端办理免听",
        );
        task.mirror_request_id = None;
        return;
    }

    let msg = r
        .error_message
        .and_then(|m| m.text)
        .unwrap_or_else(|| "教务未说明原因".into());
    absorb_error(task, settings, msg, skew_ms);
}

/// 「结果不明」的兜底：**先核对，再重投**。
///
/// 这是整个引擎里最要紧的一处保守：轮询超了上限只说明「我们没拿到回执」，
/// 不说明没选上。如果这时直接重投，可能把已经到手的名额当成失败再来一次，
/// 而教务对重复提交的反应（报错？还是又占一个？）我们没有样本。
///
/// 所以顺序永远是：先问一句「这门课现在在我名下吗」，是就收工，不是才重投。
fn reconcile_lost_request(ctx: &super::commands::SelectContext, task: &mut GrabTask) {
    if verify_picked(ctx, task).unwrap_or(false) {
        finish(task, GRAB_SUCCESS, "已抢到（受理结果未回，核对课表确认）");
        task.request_id = None;
        return;
    }
    // 确实没选上：清掉这张作废的受理单，重新投
    task.request_id = None;
    task.phase = PHASE_IDLE.into();
    task.polls = 0;
    task.next_at = now_ms();
    task.last_message = Some("受理结果长时间未返回，正在重新提交".into());
}

/// 这门课现在是不是已经在自己名下？用最轻的接口问，出错就当「不知道」。
///
/// 两个来源、**两个域都要问**，且只在拿到正面证据时返回 true：这个函数的结果决定
/// 「要不要重投」，把「不确定」说成「没选上」只是回到老路（重投一次），说成「选上了」
/// 却会漏掉一门课。所以宁可返回 false（= 不知道）也不要猜。
///
/// 为什么必须问两个域：受理号可能落在镜像域上（见 [`GrabTask::request_domain`]），
/// 只问主域会把「镜像域已经选中」当成没选中 —— 于是引擎一边重复提交，一边把已经
/// 到手的课报成失败。
fn verify_picked(ctx: &super::commands::SelectContext, task: &GrabTask) -> Result<bool> {
    let want = task.lesson_id.to_string();
    let hits = |v: &serde_json::Value| {
        ["lessonId", "id", "lessonAssoc", "lesson_id"]
            .iter()
            .filter_map(|k| v.get(*k))
            .any(|x| x.to_string().trim_matches('"') == want)
    };
    // 主域在前，镜像域（如果有）在后。
    let clients: Vec<&CourseSelectClient> = std::iter::once(&ctx.client)
        .chain(ctx.mirror.as_ref())
        .collect();

    // ① 首选 `selected-lessons` —— 它就是「我已选上的课」这份名单本身，最准也最便宜
    for client in &clients {
        if let Ok(list) = client.selected_lessons(&task.turn_id, ctx.student_id) {
            if list.iter().any(hits) {
                return Ok(true);
            }
        }
    }

    // ② 退一步：拉一遍教学班，看见 `selectedLesson` 非空也算数
    for client in &clients {
        if let Ok(lessons) = client.simplest_lessons(&task.turn_id) {
            if lessons
                .iter()
                .any(|l| l.id == want && l.selected_lesson.is_some())
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// 收尾：写终态、定时间戳。
fn finish(task: &mut GrabTask, status: &str, message: &str) {
    task.status = status.into();
    task.phase = PHASE_IDLE.into();
    task.finished_at = Some(now_ms());
    task.last_message = Some(message.into());
    // 进终态了，「连续满员了多久」这件事不再有读的人
    task.stuck_since = None;
}

/* ─────────────────────── 志愿组（互斥备选） ───────────────────────
 *
 * 同一个组里的课程是**备选**：时间冲突、或一轮只能选一门，所以只会中一个。
 *
 * 两条规矩：
 * 1. **一次只主攻一个** —— 组内 `(priority, id)` 最小的那个非终态成员。
 *    分散出手在这里是负收益：全局节流本来一轮只发一个请求，铺开只会让
 *    「最想要的那门」出手变慢，还可能先中了第二志愿、白丢第一志愿。
 * 2. **中选即收组** —— 有人中了，同组其余立刻取消。这是「不会同时抢到两门
 *    冲突课」的唯一保证，也是志愿组存在的理由。
 *
 * 「当前志愿」**不是状态机**，而是每轮从任务表现算出来的派生量：第一志愿一进终态，
 * 第二志愿下一轮自动成为当前志愿。少一处要同步的中间状态，就少一处能跑偏的地方。
 */

/// 任务所属的志愿组（空串/空白按「不在组里」处理）。
fn group_of(t: &GrabTask) -> Option<&str> {
    t.group_key
        .as_deref()
        .map(str::trim)
        .filter(|g| !g.is_empty())
}

/// 是否已经「让贤」：连续满员超过了期限。
///
/// `cede_after_ms == 0`（默认）时**恒为 false** —— 那正是「死守当前志愿」：
/// 只有它进终态或窗口关闭才轮到下一个。设成 >0 才会因满员而让位。
fn has_ceded(t: &GrabTask, settings: &GrabSettings, now: i64) -> bool {
    if settings.cede_after_ms <= 0 {
        return false;
    }
    t.stuck_since
        .is_some_and(|since| now - since >= settings.cede_after_ms)
}

/// 组里的**当前志愿**：还没结束、且**现在轮得到**的成员里 `(priority, id)` 最小的那个。
///
/// 「轮得到」= `next_at <= now`。被教务拒过一次的成员会退到 `next_at` 之后
/// （见 [`absorb_error`] 的满员分支），于是组里**其余候选立刻顶上** ——
/// 这就是「被拒了就换人」：一次拒绝不该变成整组的空等。
///
/// 为什么值得换人（而不是死守第一志愿）：开窗那几分钟里名额是**流动**的 ——
/// 我们排在第一的那个班可能刚被手快的人占满，而排第四的班刚好有人退课。
/// 死守一个班，第四个人退了课我们也看不见；而全局节流本来就限制成
/// 「一轮只发一个请求」，轮着打**不会**多花请求，只是把这一份火力铺到更多候选上。
///
/// 一个成员都没到点时（全组都在冷却里），退回最早到点的那个：调用方
/// （`step` 的「谁最急」）需要算出正确的醒来时刻，而不是僵在那里不动。
///
/// 让贤（`cede_after_ms`）仍然照旧：它是「**长期**满员就别再等了」，
/// 与这里的「这一秒让别人试试」是两件事，互不替代。
fn group_lead<'a>(
    group: &str,
    tasks: &'a [GrabTask],
    settings: &GrabSettings,
    now: i64,
) -> Option<&'a GrabTask> {
    let alive: Vec<&GrabTask> = tasks
        .iter()
        .filter(|t| group_of(t) == Some(group))
        .filter(|t| !grab_is_terminal(&t.status) && t.status != GRAB_PAUSED)
        .collect();
    if alive.is_empty() {
        return None;
    }
    // 冷却中的成员让位；**全组都在冷却**时才退回全体（否则整组会僵住，谁都不出手）
    let cooling = !alive.iter().any(|t| t.next_at <= now);
    let pool: Vec<&GrabTask> = if cooling {
        alive
    } else {
        alive.iter().copied().filter(|t| t.next_at <= now).collect()
    };

    // 先挑没让贤的；整组都让贤了（罕见）就退回纯志愿序
    let mut pick: Vec<&GrabTask> = pool
        .iter()
        .copied()
        .filter(|t| !has_ceded(t, settings, now))
        .collect();
    if pick.is_empty() {
        pick = pool;
    }
    if cooling {
        // 全组都在冷却：按「谁先到点」排 —— 调用方按当前志愿的 `next_at` 决定睡多久，
        // 挑最早的那个才能让引擎在「第一个候选重新可用」的时刻准时醒来。
        pick.sort_by_key(|t| (t.next_at, t.priority, t.id));
    } else {
        pick.sort_by_key(|t| (t.priority, t.id));
    }
    pick.first().copied()
}

/// 这个任务现在轮得到出手吗？不在组里的一律轮得到。
fn armed(t: &GrabTask, tasks: &[GrabTask], settings: &GrabSettings, now: i64) -> bool {
    let Some(g) = group_of(t) else { return true };
    group_lead(g, tasks, settings, now).is_some_and(|lead| lead.id == t.id)
}

/// 同组有人中了：把其余还没结束的成员收摊。返回收掉的行数。
fn close_group(conn: &Connection, winner: &GrabTask) -> Result<usize> {
    let Some(g) = group_of(winner) else {
        return Ok(0);
    };
    let who = winner
        .course_name
        .clone()
        .or_else(|| winner.lesson_name.clone())
        .unwrap_or_else(|| "同组课程".into());
    let msg = format!("已被第 {} 志愿「{}」抢先", winner.priority, who);
    let n = conn.execute(
        "UPDATE campus_grab_tasks SET status = ?3, phase = ?4, finished_at = ?5, last_message = ?6 \
         WHERE group_key = ?1 AND id <> ?2 \
           AND status NOT IN ('success','failed','conflict','cancelled')",
        rusqlite::params![g, winner.id, GRAB_CANCELLED, PHASE_IDLE, now_ms(), msg],
    )?;
    Ok(n)
}

/* ─────────────────────── 计划（意向） ───────────────────────
 *
 * 计划回答「我想抢什么」，任务回答「正在抢哪个教学班」。中间那次翻译就是
 * [`resolve_intent`]：拿**当时**的教学班名单做模糊匹配 → 命中的班按抢课语义排序 →
 * 排成志愿组任务。
 *
 * 三条不肯让步的性质：
 *
 * 1. **可以还没有批次**。提前一晚写下「高数 张」时，教务可能连批次都没公布。
 *    计划照样落库，等名单拉得到的那一刻自己解析（每分钟试一次）。
 * 2. **解析看的是当时的名单**。哪个班还有空位是开窗那一刻才知道的事；
 *    预先抄下来的 `lessonAssoc` 赌的是「名单没变过」，那是拿抢课去赌。
 * 3. **生成的仍是普通任务**。解析不是另一条提交链路，它只写 `campus_grab_tasks`——
 *    后面怎么抢、怎么退避、怎么换令牌，全归已有的任务引擎管。
 */

/// 把命中按「志愿组」分堆。
///
/// - `spread = false`（默认）：所有命中合成一堆，只中一个。「任意一个班都行」就该是这个
///   语义 —— 多抢到一门时间冲突的课，比没抢到更麻烦。
/// - `spread = true`：按课程分堆 —— 每门课各抢一个班（同一门课的多个班仍互斥），
///   课程之间互不影响。适合「查询写得很宽、但我确实每门都要」。
///
/// 已选过的班一律排除：引擎不该再对已经在名下的课动手。
pub fn plan_groups(hits: &[LessonHit], spread: bool) -> Vec<Vec<LessonHit>> {
    let grabbable: Vec<LessonHit> = hits
        .iter()
        .filter(|h| h.lesson.selected_lesson.is_none())
        .cloned()
        .collect();
    if !spread {
        return if grabbable.is_empty() {
            Vec::new()
        } else {
            vec![grabbable]
        };
    }
    let mut order: Vec<String> = Vec::new();
    let mut buckets: HashMap<String, Vec<LessonHit>> = HashMap::new();
    for h in grabbable {
        let key = course_key(&h.lesson);
        if !buckets.contains_key(&key) {
            order.push(key.clone());
        }
        buckets.entry(key).or_default().push(h);
    }
    order
        .into_iter()
        .filter_map(|k| buckets.remove(&k))
        .collect()
}

/// 分堆用的课程身份：课程代码优先，退化到课程名，再退化到教学班 id。
///
/// **不能拿教学班 id 当第一选择** —— 那是「班」的身份，用它分堆等于每班一堆，
/// 而 spread 的全部意义正是「同一门课的多个班只中一个」。
fn course_key(l: &CourseSelectLesson) -> String {
    let course = l.course.as_ref();
    course
        .and_then(|c| c.code.clone())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            course
                .and_then(|c| c.name_zh.clone())
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_else(|| matcher::id_text(&l.id))
}

/// 上课小组：教务只给**一个**可选组时直接指定它（与抢课抽屉里的默认一致），
/// 多组时交给教务的默认值 —— 「抢哪个组」这件事我们没有比它更靠谱的判据。
fn schedule_group_of(l: &CourseSelectLesson) -> Option<Value> {
    match l.schedule_groups.as_slice() {
        [only] => Some(only.id.clone()).filter(|v| !v.is_null()),
        _ => None,
    }
}

/// 计划的目标批次：计划指定的优先；没指定就用教务当前开放的那个。
///
/// 指定的那个不在列表里就返回 None，**绝不自动换一个批次** ——
/// 「我排的是 A 轮，引擎跑去 B 轮抢」比抢不到更难查。
fn pick_turn(want: Option<&str>, briefs: &[GrabTurnBrief]) -> Option<GrabTurnBrief> {
    match want.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => briefs.iter().find(|b| b.id == id).cloned(),
        None => briefs
            .iter()
            .find(|b| b.allow_enter)
            .or_else(|| briefs.first())
            .cloned(),
    }
}

/// 名额缓存时长（毫秒）。名额是分钟级才变的东西，而预览是逐键触发的。
const SEAT_CACHE_MS: i64 = 30_000;

/// 给一批命中**补上「已选人数」**，返回补成功的条数。
///
/// 名单接口（`query-lesson`）在这套部署上不回 `stdCount`（2026-09-22 实测 448/448 缺失），
/// 所以「满没满」只能事后用 `std-count` 单独问一次 —— 少了这一步，
/// `matcher` 里「有空位的先出手」等于没有，用户界面上那个名额也是空的。
///
/// 只问传进来的那些（命中的、通常十几条），且命中 [`SEAT_CACHE_MS`] 内缓存的直接复用 ——
/// 引擎的解析与界面的预览走的是同一个函数，两边的名额必须同源。
/// 问不到就原样返回 0：名额是**排序的加分项**，拿不到不该拖垮整条解析链。
pub(crate) fn fill_seats(
    hub: &GrabHub,
    ctx: &super::commands::SelectContext,
    hits: &mut [matcher::LessonHit],
) -> usize {
    if hits.is_empty() {
        return 0;
    }
    let now = now_ms();
    let mut known: HashMap<String, StdCount> = HashMap::new();
    let mut missing: Vec<serde_json::Value> = Vec::new();
    if let Ok(cache) = hub.seats.lock() {
        for h in hits.iter() {
            let key = matcher::id_text(&h.lesson.id);
            match cache.get(&key) {
                Some((at, c)) if now - at < SEAT_CACHE_MS => {
                    known.insert(key, *c);
                }
                _ => missing.push(h.lesson.id.clone()),
            }
        }
    } else {
        missing = hits.iter().map(|h| h.lesson.id.clone()).collect();
    }

    if !missing.is_empty() {
        if let Ok(fresh) = ctx.client.std_count(&missing) {
            if let Ok(mut cache) = hub.seats.lock() {
                for (id, c) in &fresh {
                    cache.insert(id.clone(), (now, *c));
                }
            }
            known.extend(fresh);
        }
    }

    let mut filled = 0usize;
    for h in hits.iter_mut() {
        let key = matcher::id_text(&h.lesson.id);
        if let Some(c) = known.get(&key) {
            h.lesson.std_count = Some(c.taken);
            filled += 1;
        }
    }
    if filled > 0 {
        matcher::rerank(hits);
        // 名额是这一轮的排序依据，值得留痕：首选还剩多少，一眼就能看出值不值得抢
        if let Some(h) = hits.first() {
            let left = known
                .get(&matcher::id_text(&h.lesson.id))
                .and_then(|c| c.seat_left(h.lesson.limit_count));
            println!(
                "[名额] 已补 {filled} 个教学班（首选{}）",
                left.map(|n| format!("余 {n}"))
                    .unwrap_or_else(|| "余量未知".into())
            );
        }
    }
    filled
}

/// 目标批次（缓存优先）。计划解析与界面上的「预览」都从这一步起步 ——
/// 两边必须挑到同一个批次，否则预览里看到的班和真抢的班不是一回事。
pub(crate) fn resolve_turn(
    state: &tauri::State<'_, AppState>,
    ctx: &super::commands::SelectContext,
    want: Option<&str>,
) -> Result<Option<GrabTurnBrief>> {
    Ok(pick_turn(want, &turn_briefs(state, ctx)?))
}

/// 解析一条计划。引擎每轮心跳最多做一条（见 [`step`]），所以这里可以放心是一次完整流程。
///
/// 任何「现在做不了」都走 [`park_intent`]：记一句能看懂的话 + 定个重试时刻，**绝不删计划**。
fn resolve_intent(
    state: &tauri::State<'_, AppState>,
    hub: &GrabHub,
    ctx: &super::commands::SelectContext,
    intent: &mut GrabIntent,
) -> Result<()> {
    intent.attempts += 1;

    let briefs = turn_briefs(state, ctx)?;
    let Some(brief) = pick_turn(intent.turn_id.as_deref(), &briefs) else {
        return park_intent(
            state,
            intent,
            INTENT_PENDING,
            "还没看到这个选课批次，教务公布后会自动继续".into(),
            INTENT_RETRY_MS,
        );
    };
    intent.turn_id = Some(brief.id.clone());
    intent.turn_name = brief.name.clone();

    // 窗口已经过去的批次不再解析：解析出来也只会立刻落进「窗口已关闭」的终态。
    // 关门判断不校时钟偏差 —— 差几秒对「今天还抢不抢」没有影响。
    if let Some(end) = brief.window_end.as_deref().and_then(wall_to_ms) {
        if now_ms() >= end {
            let who = brief.name.clone().unwrap_or_else(|| brief.id.clone());
            return park_intent(
                state,
                intent,
                INTENT_PENDING,
                format!("批次「{who}」的选课窗口已经结束"),
                INTENT_RETRY_MS * 10,
            );
        }
    }

    let (lessons, assoc) = hub.lessons_cached(ctx, &brief.id)?;
    // **放宽阶梯**：严格档零命中时，才允许丢掉「办不到的条件」（见 `matcher::match_lessons_relaxed`）。
    // 放宽了什么必须说出来 —— 用户写的是「羽毛球 星期四」，真抢的可能是星期一的班。
    let relaxed = matcher::match_lessons_relaxed(&intent.query, &lessons);
    let mut hits = relaxed.hits;
    if let Some(note) = relaxed.level.note() {
        if !relaxed.dropped.is_empty() {
            println!("[计划] {note}：{}", relaxed.dropped.join("、"));
        }
    }

    // **补名额**：名单接口不回 `stdCount`（见 `models::StdCount`），所以
    // 「有空位的先出手」这件事得靠 `std-count` 单独问一次。
    // 只问命中的那些（通常十几条，一次请求就够），补完立刻重排；
    // 补不上也不影响解析 —— 排序里那一项退化成「一视同仁」，其余照旧。
    fill_seats(hub, ctx, &mut hits);

    // 打全了老师名字 → 那是指定，只抢他的班；只打姓 / 打错字 → 模糊匹配照旧（见 `preferred`）
    let pool = matcher::preferred(&hits);
    let picked_off = hits.len().saturating_sub(pool.len());

    // **跨课程**：命中的是两个不同的课程代码 —— 十有八九是年级双开那门课
    // （只写「羽毛球」，而大一 000004 / 大二 000006 各有一门）。
    // 这时**不排队**：放着不管，引擎会把两个年级的班一起排进来，可能把大二那门抢回。
    // 「每门课都要」（spread）是例外 —— 那本来就是「这几门我都要」的意思。
    if !intent.spread {
        let amb = matcher::ambiguous_courses(&intent.query, &pool);
        if !amb.is_empty() {
            let list = amb
                .iter()
                .map(|(c, n)| {
                    if n.is_empty() {
                        c.clone()
                    } else {
                        format!("{c} {n}")
                    }
                })
                .collect::<Vec<_>>()
                .join(" / ");
            let sample = amb
                .iter()
                .map(|(c, n)| {
                    if n.is_empty() {
                        c.clone()
                    } else {
                        format!("{n} {c}")
                    }
                })
                .next()
                .unwrap_or_default();
            return park_intent(
                state,
                intent,
                INTENT_AMBIGUOUS,
                format!(
                    "「{}」同时命中 {} 门课：{} —— 补上课程代码就只抢那一门（例如「{}」）",
                    intent.query,
                    amb.len(),
                    list,
                    sample
                ),
                INTENT_RETRY_MS,
            );
        }
    }
    let groups = plan_groups(&pool, intent.spread);
    if groups.is_empty() {
        let why = if hits.is_empty() {
            format!(
                "没匹配到「{}」—— 课名 / 课程代码 / 教师名都可以，空格分词",
                intent.query
            )
        } else {
            "匹配到的教学班都已经在你名下了".to_string()
        };
        return park_intent(state, intent, INTENT_EMPTY, why, INTENT_RETRY_MS);
    }

    // 窗口与开火判据与 `probe_windows` 保持一致：有精确区间就用区间；
    // 没有区间但「允许进入」就是窗口正开着（立刻出手）；都没有就等窗口公布。
    let (window, window_end, await_window) = match brief.window_start.as_deref() {
        Some(start) if !start.trim().is_empty() => (
            Some(start.trim().to_string()),
            brief.window_end.clone(),
            false,
        ),
        _ if brief.allow_enter => (None, None, false),
        _ => (None, None, true),
    };

    // 建任务。**短锁里只做写**：名单与匹配都在锁外算完了。
    let (created, keys) = {
        let conn = state.db.lock();
        let mut created = 0usize;
        let mut keys: Vec<String> = Vec::new();
        for (gi, group) in groups.iter().enumerate() {
            // 一条计划生成的组用 `intent-{id}` 起头：界面靠它把任务归到计划名下
            let key = if groups.len() == 1 {
                format!("intent-{}", intent.id)
            } else {
                format!("intent-{}-{}", intent.id, gi + 1)
            };
            let name = if intent.spread {
                group
                    .first()
                    .and_then(|h| matcher::course_name_of(&h.lesson))
            } else {
                None
            }
            .unwrap_or_else(|| intent.query.clone());

            let mut made = false;
            for (i, h) in group.iter().enumerate() {
                // 同一门课已经在抢了就别再来一条 —— 与投递口用的是同一套幂等判据
                let lid = json_to_col(&h.lesson.id);
                if active_task_exists(&conn, ctx.account_id, &brief.id, &lid) {
                    continue;
                }
                let input = GrabTargetInput {
                    lesson_id: h.lesson.id.clone(),
                    // 任务行上那一小段能分辨它的文字：项目名优先（体育课 8 个班
                    // 的课程名一模一样，只写课程名认不出哪个是羽毛球）
                    lesson_name: matcher::distinct_label(&h.lesson),
                    course_name: matcher::course_name_of(&h.lesson),
                    course_code: h.lesson.course.as_ref().and_then(|c| c.code.clone()),
                    teacher: matcher::teacher_text(&h.lesson),
                    credits: h.lesson.course.as_ref().and_then(|c| c.credits),
                    virtual_cost: None,
                    schedule_group_id: schedule_group_of(&h.lesson),
                    group_key: Some(key.clone()),
                    group_name: Some(name.clone()),
                    priority: (i + 1) as i64,
                };
                let id = insert_task(
                    &conn,
                    ctx.account_id,
                    &brief.id,
                    brief.name.as_deref(),
                    &input,
                    &intent.mode,
                    window.as_deref(),
                    window_end.as_deref(),
                )?;
                if let Some(a) = assoc.as_deref() {
                    let _ = set_turn_assoc(&conn, id, a);
                }
                if await_window {
                    let _ = conn.execute(
                        "UPDATE campus_grab_tasks SET await_window = 1, last_message = ?2 WHERE id = ?1",
                        rusqlite::params![id, "等待教务公布选课窗口"],
                    );
                }
                made = true;
                created += 1;
            }
            if made {
                keys.push(key);
            }
        }
        (created, keys)
    };

    intent.status = INTENT_READY.into();
    intent.group_keys = keys;
    // 候选清单只列**真会抢的**那些班：被「指定老师」筛掉的不列出来，
    // 否则用户会问「为什么预览里有它、任务单里没有」。
    intent.candidates = pool
        .iter()
        .take(INTENT_CANDIDATE_CAP)
        .map(matcher::to_match)
        .collect();
    intent.resolved_at = Some(now_ms());
    intent.next_at = now_ms();
    let hidden = pool.len().saturating_sub(INTENT_CANDIDATE_CAP);
    let tail = if hidden > 0 {
        format!("（另有 {hidden} 个匹配未列出）")
    } else {
        String::new()
    };
    // 指定了老师就明说一句 —— 用户下次看到这条计划时，「只抢张伟的班」是解释而不是意外
    let by_teacher = if picked_off > 0 {
        format!("，只抢指定教师的班（另有 {picked_off} 个匹配被滤掉）")
    } else {
        String::new()
    };
    intent.last_message = Some(if created == 0 {
        "这些教学班都已经在抢了".to_string()
    } else if groups.len() > 1 {
        format!(
            "已为 {} 门课各排一组，共 {created} 个志愿{by_teacher}{tail}",
            groups.len()
        )
    } else {
        format!("已排入 {created} 个志愿，按序出手{by_teacher}{tail}")
    });

    let conn = state.db.lock();
    save_intent(&conn, intent)
}

/// 把一条计划挂起：说清为什么、定好下次什么时候再试。**不删计划** ——
/// 用户排的是明天早上的事，「现在看不到批次」根本不算失败。
fn park_intent(
    state: &tauri::State<'_, AppState>,
    intent: &mut GrabIntent,
    status: &str,
    message: String,
    delay_ms: i64,
) -> Result<()> {
    intent.status = status.to_string();
    intent.last_message = Some(message);
    intent.next_at = now_ms() + delay_ms;
    let conn = state.db.lock();
    save_intent(&conn, intent)
}

/// 把一次错误吸收进任务状态：分级 → 定下一次动作 → 必要时判死。
fn absorb_error(task: &mut GrabTask, settings: &GrabSettings, message: String, skew_ms: i64) {
    let verdict = verdict_of(&message);
    // 原始文案要留着：下面几档都会把它包进一句「怎么应对」里，光留下包裹后的那句话
    // 会让事后排查看不到教务的原话。
    let raw = message.clone();
    task.last_message = Some(message);
    task.request_id = None;
    task.phase = PHASE_IDLE.into();

    if verdict.resets_strikes() {
        task.strikes = 0;
        task.strike_kind = None;
    } else if task.strike_kind.as_deref() == Some(verdict.kind()) {
        // 同类连败才累加；换了种类说明局面变了，重新给耐心
        task.strikes += 1;
    } else {
        task.strikes = 1;
        task.strike_kind = Some(verdict.kind().into());
    }

    // 「连续满员了多久」——只有让贤期限读它。满员是**持续**状态（要等别人退课），
    // 所以记下起点；换成别的失败种类就清零：一直满员和一直未知错误是两种耐心。
    if verdict == Verdict::Full {
        task.stuck_since.get_or_insert_with(now_ms);
    } else {
        task.stuck_since = None;
    }

    match verdict {
        // 换令牌是一次**引擎内务**，不是这个任务的失败 —— 下一轮令牌就换好了
        Verdict::TokenRefresh | Verdict::SessionLost => {
            task.status = GRAB_WAITING.into();
            task.next_at = now_ms() + 1500;
        }
        // **教务在限速 / 教务崩了**：继续打，不退避。
        //
        // 这两类是抢课里唯一「越挫越要快」的失败：对方还活着（限速说明它正在收，
        // 5xx 说明它在重启），而窗口往往只有几分钟。退避只会把机会让给手快的人，
        // 所以这里只把原因写清楚、把任务立刻放回队首，节奏交给全局节流闸门。
        Verdict::Throttled | Verdict::ServerDown => {
            let note = if verdict == Verdict::Throttled {
                "教务在限速（继续按节奏重试）"
            } else {
                "教务服务器出错（继续重试）"
            };
            task.status = GRAB_WAITING.into();
            task.next_at = now_ms() + BACKPRESSURE_RETRY_MS;
            task.last_message = Some(format!("{note}：{raw}"));
        }
        // **请求被拒（参数错误）**：停下来交给 AI。硬撞下去既不会成功，又在持续骚扰教务。
        Verdict::BadRequest => {
            finish(
                task,
                GRAB_NEEDS_AI,
                &format!("请求被教务拒绝（参数错误），已停下等 AI 排查：{raw}"),
            );
            return;
        }
        Verdict::Full => {
            // **窗口开着**的满员是短兵相接：有人退课，名额就在那一秒回到池子里，
            // 而能不能接住取决于我们盯得多密。所以这里不按 `full_retry_ms`（5000）等，
            // 而是按下面这个冷却走 —— 它同时管着两件事：
            //
            // 1. **自己被拒之后先退开**：把 `next_at` 推到冷却之后，让 [`group_lead`]
            //    把出手机会交给组里下一个候选（有人退课的可能不止一个班）。
            // 2. **冷却必须长于节流间隔**：否则下一次心跳时它又「已经到点」，
            //    于是永远轮不到别人 —— 这条是这段代码唯一的坑，别把冷却调成
            //    `<= min_interval_ms`（默认 700ms 的节奏配 1400ms 冷却，
            //    效果是「第一志愿隔一轮回来一次，其余每次换一个新候选」）。
            //
            // 窗口外（还没开 / 已经关）维持 `full_retry_ms`：没有东西可抢时，
            // 慢一点没有任何代价，却省下大量无谓请求。
            let hot = window_open(task, skew_ms);
            let cooldown = if hot {
                REJECT_COOLDOWN_MS.max(settings.min_interval_ms.saturating_mul(2))
            } else {
                settings.full_retry_ms
            };
            if hot {
                task.last_message = Some(format!("{raw}（窗口开放中，冷却后继续）"));
            }
            task.status = GRAB_WAITING.into();
            task.next_at = now_ms() + cooldown;
        }
        Verdict::Conflict => finish(
            task,
            GRAB_CONFLICT,
            &task.last_message.clone().unwrap_or_default(),
        ),
        Verdict::Fatal => finish(
            task,
            GRAB_FAILED,
            &task.last_message.clone().unwrap_or_default(),
        ),
        Verdict::Retry => {
            // 未知错误不能无限撞：连败到上限就交给用户看原始文案
            if task.strikes >= UNKNOWN_STRIKE_LIMIT {
                let m = task.last_message.clone().unwrap_or_default();
                finish(
                    task,
                    GRAB_FAILED,
                    &format!("连续 {UNKNOWN_STRIKE_LIMIT} 次未成功：{m}"),
                );
                return;
            }
            let backoff = settings
                .backoff_ms
                .saturating_mul(1i64 << task.strikes.min(6))
                .min(settings.max_backoff_ms);
            task.status = GRAB_WAITING.into();
            task.next_at = now_ms() + backoff;
        }
    }

    // 提交上限是给「我们自己反复撞墙」设的闸门。对方限速/崩溃不算我们撞墙 ——
    // 被这两类耗掉额度的话，窗口一开就正好没额度可用了。
    if verdict.spares_attempt_budget() {
        return;
    }
    if settings.max_attempts > 0 && task.attempts >= settings.max_attempts {
        let m = task.last_message.clone().unwrap_or_default();
        finish(
            task,
            GRAB_FAILED,
            &format!("已达提交上限 {} 次：{m}", settings.max_attempts),
        );
    }
}

/* ─────────────────────── 时钟偏差（多采样区间交集） ───────────────────────
 *
 * 开火时刻 = 教务开窗时刻 − 偏差 − 提前量（[`fire_at_ms`]），所以**偏差的精度
 * 直接就是出手的精度**。而 `getCurrentDateTime` 只精确到秒（`10:00:04` 实际是
 * 那一秒里的某一刻），单次采样只能把偏差限定在约 1 秒宽的区间内 —— 更糟的是
 * 这个误差是**单向**的：把整秒起点当成本刻，算出来的偏差系统性偏小 0~1 秒，
 * 于是开火也系统性偏晚同样多，`lead_ms` 那 800 毫秒提前量等于白设。
 *
 * 多次采样取区间交集能把误差收到**往返时延**的量级（实测 ±0.03~0.08s）。
 * 采样是廉价的只读请求，五次共约半秒，只在偏差过期（30 秒）时才做一次。
 */

/// 一次采样：`(请求发出时刻, 响应到达时刻, 服务器时间原文)`，都是本机毫秒。
type ClockSample = (i64, i64, String);

/// 偏差估计的目标精度（毫秒）。够用即停，不必把固定次数采满。
const SKEW_TARGET_UNCERTAINTY_MS: i64 = 60;
/// 一次估计最多采样几次、样本间隔、总预算。
const SKEW_SAMPLES: usize = 5;
const SKEW_SAMPLE_GAP_MS: i64 = 120;
const SKEW_BUDGET_MS: i64 = 1500;

/// 「教务墙钟 − 本机钟」的一次估计。
#[derive(Debug, Clone, PartialEq)]
pub struct SkewEstimate {
    /// 偏差（毫秒）。取区间中点 —— 宁可靠中点误差对称，也不要单向偏。
    pub skew_ms: i64,
    /// 不确定度（毫秒，半宽）。`intersection` 模式下是区间半宽。
    pub uncertainty_ms: i64,
    /// 有效样本数
    pub samples: usize,
    /// 估计方式：`intersection`（区间交集）/ `min-rtt`（交集为空时的退化）/ `legacy`（旧缓存）
    pub mode: &'static str,
    /// 最后一次采样的服务器时间原文（界面要显示「教务时间」）
    pub text: String,
}

/// 从若干次采样估计偏差（纯函数，全部边界都能被单测钉住）。
///
/// 设采样 i 在 `t0` 发出、`t1` 收到，服务器报的整秒起点为 `s`。服务器处理这条
/// 请求的真实时刻 τ 必在 `[t0, t1]` 内，而它报出的秒是**向下取整**的，于是：
///
/// ```text
/// s ≤ τ + skew < s + 1000
/// ⇒  s - t1 ≤ skew < s + 1000 - t0          （用 τ ≤ t1 与 τ ≥ t0 夹逼）
/// ```
///
/// 每条样本给出一个区间，取**交集**即得偏差的可用范围。交集为空（网络抖动大，
/// 或采样期间本机时钟被 NTP 校正过）时退化为「最低 RTT 那条的中点估计」——
/// 精度回到单次采样水平，但方向仍然无偏。
pub fn skew_from_samples(samples: &[ClockSample]) -> Option<SkewEstimate> {
    let mut lo = i64::MIN;
    let mut hi = i64::MAX;
    let mut best: Option<(i64, i64)> = None; // (rtt, 中点估计)
    let mut text = String::new();
    let mut n = 0usize;

    for (t0, t1, raw) in samples {
        let Some(server_ms) = wall_to_ms(raw) else { continue };
        // 响应早于请求（本机钟在采样期间被校正过）：这条样本本身不可信
        if t1 < t0 {
            continue;
        }
        n += 1;
        text = raw.clone();
        lo = lo.max(server_ms - t1);
        hi = hi.min(server_ms + 1000 - t0);
        let rtt = t1 - t0;
        // 整秒起点 + 半秒 = 该秒中点；再减去往返中点，即「本机钟此刻」的对应值
        let mid = server_ms + 500 - (t0 + t1) / 2;
        if best.map(|(b, _)| rtt < b).unwrap_or(true) {
            best = Some((rtt, mid));
        }
    }
    if n == 0 {
        return None;
    }

    if lo <= hi {
        Some(SkewEstimate {
            skew_ms: (lo + hi) / 2,
            uncertainty_ms: (hi - lo) / 2,
            samples: n,
            mode: "intersection",
            text,
        })
    } else {
        let (rtt, mid) = best?;
        Some(SkewEstimate {
            skew_ms: mid,
            uncertainty_ms: rtt / 2 + 500,
            samples: n,
            mode: "min-rtt",
            text,
        })
    }
}

/// 采样若干次并估计偏差。`get` 每次取回服务器时间原文（网络动作由调用方安排，
/// 这样同一条算法既能被引擎用，也能被真机联调用）。
///
/// 够准就提前收工：交集宽度随样本数迅速收窄，通常两三次就到位。
pub fn sample_skew<F>(mut get: F) -> Option<SkewEstimate>
where
    F: FnMut() -> Result<String>,
{
    let started = now_ms();
    let mut out: Vec<ClockSample> = Vec::new();
    for i in 0..SKEW_SAMPLES {
        if i > 0 {
            if now_ms() - started >= SKEW_BUDGET_MS {
                break;
            }
            std::thread::sleep(Duration::from_millis(SKEW_SAMPLE_GAP_MS.max(0) as u64));
        }
        let t0 = now_ms();
        let got = get();
        let t1 = now_ms();
        if let Ok(text) = got {
            out.push((t0, t1, text));
        }
        if out.len() >= 2 {
            if let Some(est) = skew_from_samples(&out) {
                if est.uncertainty_ms <= SKEW_TARGET_UNCERTAINTY_MS {
                    return Some(est);
                }
            }
        }
    }
    skew_from_samples(&out)
}

/// 读缓存里那份偏差，**不采样**（供「马上要出手」的路径用）。
fn cached_clock(state: &tauri::State<'_, AppState>) -> (i64, Option<SkewEstimate>) {
    let conn = state.db.lock();
    match read_meta(&conn, CLOCK_KEY).and_then(|s| read_clock(&s)) {
        Some((at, est)) => (at, Some(est)),
        None => (0, None),
    }
}

/// 偏差过期就重采一次，否则直接用缓存。
///
/// **只在「没有任务等着出手」的那条路径上调用**：采样要打几次网络（约半秒），
/// 而半秒正是开窗那一瞬间的出手时机。偏差是缓变量（本机钟漂移是 ppm 级，
/// 几分钟不到 1 毫秒），窗口内一直用等待期采好的那份完全够用。
///
/// 体检（`campus_grab_preflight`）也走它：那里正是「没有任务在等着出手」的时刻，
/// 而且用户问的就是「现在测出来的偏差是多少」。
pub(crate) fn refresh_clock_if_stale(
    state: &tauri::State<'_, AppState>,
    campus: &tauri::State<'_, CampusHub>,
) -> (i64, Option<SkewEstimate>) {
    let (at, cached) = cached_clock(state);
    if cached.is_some() && now_ms() - at < TIME_RESAMPLE_MS {
        return (at, cached);
    }
    // 采样失败也还能用这个旧值兜底（首次没有旧值时返回 (0, None)，
    // 退化成「按本机时钟开火」——不理想，但比不开火强）
    match resample(state, campus) {
        Some((at, est)) => (at, Some(est)),
        None => (at, cached),
    }
}

/// 读时钟缓存：新形状（对象）与旧形状（`[at, text]`）都要认。
///
/// 旧形状没有交集信息，只能按「单次采样」的精度对待：不确定度给足一秒 ——
/// 宁可让界面显示得更保守，也不要把一次粗略估计说成精确值。
fn read_clock(raw: &str) -> Option<(i64, SkewEstimate)> {
    if let Ok(v) = serde_json::from_str::<Value>(raw) {
        if let Some(obj) = v.as_object() {
            let at = obj.get("at_ms").and_then(|x| x.as_i64())?;
            let skew_ms = obj.get("skew_ms").and_then(|x| x.as_i64())?;
            return Some((
                at,
                SkewEstimate {
                    skew_ms,
                    uncertainty_ms: obj
                        .get("uncertainty_ms")
                        .and_then(|x| x.as_i64())
                        .unwrap_or(1000),
                    samples: obj
                        .get("samples")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(1) as usize,
                    mode: "intersection",
                    text: obj
                        .get("text")
                        .and_then(|x| x.as_str())
                        .unwrap_or_default()
                        .to_string(),
                },
            ));
        }
        // 旧形状：`[at, text]`
        if let Some(arr) = v.as_array() {
            let at = arr.first()?.as_i64()?;
            let text = arr.get(1)?.as_str()?.to_string();
            let skew = compute_skew(&text, at)?;
            return Some((
                at,
                SkewEstimate {
                    skew_ms: skew,
                    uncertainty_ms: 1000,
                    samples: 1,
                    mode: "legacy",
                    text,
                },
            ));
        }
    }
    None
}

/// 偏差 = 把服务器时间文本当成**本机墙上时间**，与本机此刻的差。
/// 这样两边在同一个参照系里做差，时区差被自动吸收。
///
/// 只留给旧缓存解析用；新的估计走 [`skew_from_samples`]（它额外利用「响应到达时刻」，
/// 把整秒截断带来的那一秒误差也收掉了）。
fn compute_skew(server_text: &str, sampled_at_ms: i64) -> Option<i64> {
    wall_to_ms(server_text).map(|wall| wall - sampled_at_ms)
}

fn resample(
    state: &tauri::State<'_, AppState>,
    campus: &tauri::State<'_, CampusHub>,
) -> Option<(i64, SkewEstimate)> {
    // `select_context` 自己安排锁的边界：换令牌 / 必要时重登的网络全在锁外
    let ctx = super::commands::select_context(&state.db, campus).ok()?;
    let est = sample_skew(|| ctx.client.server_time())?;
    let at = now_ms();
    {
        // `Db::lock` 自带中毒恢复，这里拿到的永远是可用连接 —— 采样成功就该把时钟记下来
        let conn = state.db.lock();
        let payload = serde_json::json!({
            "at_ms": at,
            "skew_ms": est.skew_ms,
            "uncertainty_ms": est.uncertainty_ms,
            "samples": est.samples,
            "mode": est.mode,
            "text": est.text,
        });
        let _ = write_meta(&conn, CLOCK_KEY, &payload.to_string());
    }
    Some((at, est))
}

/* ─────────────────────────── 持久化 ─────────────────────────── */

const CLOCK_KEY: &str = "campus_grab_clock";
const SETTINGS_KEY: &str = "campus_grab_settings";
/// 窗口监听的最近结果（批次摘要），供界面显示「窗口开没开」。
const TURNS_KEY: &str = "campus_grab_turns";
/// 最近一次窗口探测的时刻（本机 ms）
const PROBED_KEY: &str = "campus_grab_probed_at";

const TASK_COLS: &str = "id, turn_id, turn_name, lesson_id, lesson_name, course_name, course_code, \
     teacher, credits, mode, virtual_cost, schedule_group_id, window_wall, window_end_wall, \
     await_window, predicate_done, status, phase, attempts, polls, strikes, strike_kind, request_id, \
     last_message, next_at, queued_at, finished_at, turn_assoc, \
     group_key, group_name, priority, stuck_since, mirror_request_id, request_domain";

fn json_to_col(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

/// 库里存的是 JSON 文本，但**教学班 id 是数字时要还原成数字**：
/// 教务回 `317844` 而我们发 `"317844"` 是两种东西，`lessonAssoc` 类型不对会被拒。
fn col_to_json(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or_else(|_| serde_json::json!(s))
}

fn task_row(r: &Row<'_>) -> rusqlite::Result<GrabTask> {
    let lesson_raw: String = r.get(3)?;
    let group_raw: Option<String> = r.get(11)?;
    Ok(GrabTask {
        id: r.get(0)?,
        turn_id: r.get(1)?,
        turn_name: r.get(2)?,
        lesson_id: col_to_json(&lesson_raw),
        lesson_name: r.get(4)?,
        course_name: r.get(5)?,
        course_code: r.get(6)?,
        teacher: r.get(7)?,
        credits: r.get(8)?,
        mode: r.get(9)?,
        virtual_cost: r.get(10)?,
        schedule_group_id: group_raw.map(|s| col_to_json(&s)),
        window_wall: r.get(12)?,
        window_end_wall: r.get(13)?,
        await_window: r.get::<_, i64>(14)? != 0,
        predicate_done: r.get::<_, i64>(15)? != 0,
        status: r.get(16)?,
        phase: r.get(17)?,
        attempts: r.get(18)?,
        polls: r.get(19)?,
        strikes: r.get(20)?,
        strike_kind: r.get(21)?,
        request_id: r.get(22)?,
        last_message: r.get(23)?,
        next_at: r.get(24)?,
        // 派生值，不落库 —— 由 `snapshot` 按时钟偏差算好后填上
        fire_at: None,
        queued_at: r.get(25)?,
        finished_at: r.get(26)?,
        turn_assoc: r.get(27)?,
        group_key: r.get(28)?,
        group_name: r.get(29)?,
        priority: r.get(30)?,
        stuck_since: r.get(31)?,
        // 抢课「两个域都发」的第二条受理号（第 32 列）
        mirror_request_id: r.get(32)?,
        // 第 33 列：受理单属于哪个域（NULL/其余 = 主域）
        request_domain: r.get(33)?,
        // 派生值，不落库 —— 由 `snapshot` 按同组的志愿序算出来后填上
        held_by: None,
    })
}

fn load_task(conn: &Connection, id: i64) -> Result<Option<GrabTask>> {
    let sql = format!("SELECT {TASK_COLS} FROM campus_grab_tasks WHERE id = ?1");
    match conn.query_row(&sql, [id], task_row) {
        Ok(t) => Ok(Some(t)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(ReinError::from(e)),
    }
}

/// 全部任务：未结束的排在前面，再按入队时间倒序（界面上「正在抢的」永远在最上面）。
pub fn load_tasks(conn: &Connection, account_id: i64) -> Result<Vec<GrabTask>> {
    let sql = format!(
        "SELECT {TASK_COLS} FROM campus_grab_tasks WHERE account_id = ?1 \
         ORDER BY CASE WHEN status IN ('success','failed','conflict','cancelled') THEN 1 ELSE 0 END, \
         id DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([account_id], task_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 引擎关心的任务：非终态、非暂停。
fn load_active_tasks(conn: &Connection, account_id: i64) -> Result<Vec<GrabTask>> {
    let sql = format!(
        "SELECT {TASK_COLS} FROM campus_grab_tasks \
         WHERE account_id = ?1 AND status IN ('waiting','running') ORDER BY next_at ASC, id ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([account_id], task_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn active_account_id(conn: &Connection) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT id FROM campus_accounts WHERE active = 1 ORDER BY updated_at DESC LIMIT 1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .ok())
}

pub fn save_task(conn: &Connection, t: &GrabTask) -> Result<()> {
    conn.execute(
        "UPDATE campus_grab_tasks SET turn_name = ?2, lesson_name = ?3, course_name = ?4, \
         course_code = ?5, teacher = ?6, credits = ?7, mode = ?8, virtual_cost = ?9, \
         schedule_group_id = ?10, window_wall = ?11, window_end_wall = ?12, await_window = ?13, \
         predicate_done = ?14, status = ?15, phase = ?16, attempts = ?17, polls = ?18, \
         strikes = ?19, strike_kind = ?20, request_id = ?21, last_message = ?22, next_at = ?23, \
         queued_at = ?24, finished_at = ?25, turn_assoc = ?26, group_key = ?27, group_name = ?28, \
         priority = ?29, stuck_since = ?30, mirror_request_id = ?31, request_domain = ?32 \
         WHERE id = ?1",
        rusqlite::params![
            t.id,
            t.turn_name,
            t.lesson_name,
            t.course_name,
            t.course_code,
            t.teacher,
            t.credits,
            t.mode,
            t.virtual_cost,
            t.schedule_group_id.as_ref().map(json_to_col),
            t.window_wall,
            t.window_end_wall,
            t.await_window as i64,
            t.predicate_done as i64,
            t.status,
            t.phase,
            t.attempts,
            t.polls,
            t.strikes,
            t.strike_kind,
            t.request_id,
            t.last_message,
            t.next_at,
            t.queued_at,
            t.finished_at,
            t.turn_assoc,
            t.group_key,
            t.group_name,
            t.priority,
            t.stuck_since,
            t.mirror_request_id,
            t.request_domain,
        ],
    )?;
    Ok(())
}

/// 「稍后再试」：定下次时刻、记原因，并顺手维护连败计数（同类才累加）。
fn park(
    conn: &Connection,
    task: &GrabTask,
    next_at: i64,
    message: &str,
    kind: Verdict,
) -> Result<()> {
    let same = task.strike_kind.as_deref() == Some(kind.kind());
    let strikes = if kind.resets_strikes() {
        0
    } else if same {
        task.strikes + 1
    } else {
        1
    };
    conn.execute(
        "UPDATE campus_grab_tasks SET status = ?2, phase = ?3, next_at = ?4, last_message = ?5, \
         strike_kind = ?6, strikes = ?7 WHERE id = ?1",
        rusqlite::params![
            task.id,
            GRAB_WAITING,
            PHASE_IDLE,
            next_at,
            message,
            kind.kind(),
            strikes
        ],
    )?;
    Ok(())
}

/// 入队。
///
/// `window_wall` 为 `None` 即「还不知道窗口什么时候开」—— 这种任务会被标成
/// `await_window`，由引擎每分钟去问一次，**而不是立刻开火**（理由见 [`fire_at_ms`]）。
#[allow(clippy::too_many_arguments)]
pub fn insert_task(
    conn: &Connection,
    account_id: i64,
    turn_id: &str,
    turn_name: Option<&str>,
    input: &GrabTargetInput,
    mode: &str,
    window_wall: Option<&str>,
    window_end_wall: Option<&str>,
) -> Result<i64> {
    let now = now_ms();
    let await_window = i64::from(window_wall.is_none());
    conn.execute(
        "INSERT INTO campus_grab_tasks (account_id, turn_id, turn_name, lesson_id, lesson_name, \
         course_name, course_code, teacher, credits, mode, virtual_cost, schedule_group_id, \
         window_wall, window_end_wall, await_window, predicate_done, status, phase, next_at, queued_at, \
         group_key, group_name, priority) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0, ?16, ?17, ?18, ?18, \
         ?19, ?20, ?21)",
        rusqlite::params![
            account_id,
            turn_id,
            turn_name,
            json_to_col(&input.lesson_id),
            input.lesson_name,
            input.course_name,
            input.course_code,
            input.teacher,
            input.credits,
            mode,
            input.virtual_cost,
            input.schedule_group_id.as_ref().map(json_to_col),
            window_wall,
            window_end_wall,
            await_window,
            GRAB_WAITING,
            PHASE_IDLE,
            now,
            input.group_key,
            input.group_name,
            input.priority,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/* ─────────────────────────── 投递口 ───────────────────────────
 *
 * 外部（开机监控脚本、或人）把「想抢什么」写成 JSON 放在 App 数据目录下的
 * `campus_intake.json`，引擎每轮心跳开头把它落库。
 *
 * 为什么要一个文件，而不是让脚本直接写 SQLite：任务表的列会继续长
 * （0022 → 0023 → 0027…），在 JS 里抄一份列名就是等着腐烂。**App 是唯一写者**，
 * 脚本只投递意图 —— 它也就不必知道 `next_at` / `phase` / `await_window` 这些内务。
 */

const INTAKE_FILE: &str = "campus_intake.json";
const INTAKE_DONE: &str = "campus_intake.done.json";

/// 投递的一批：一门课的若干教学班（互为志愿）。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntakeBatch {
    turn_id: String,
    #[serde(default)]
    turn_name: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    window_wall: Option<String>,
    #[serde(default)]
    window_end_wall: Option<String>,
    #[serde(default)]
    targets: Vec<GrabTargetInput>,
}

/// 同一 (批次, 教学班) 是否已经有一条还没结束的任务。
///
/// 投递口是个文件，同一份内容被投两次太容易了（脚本重跑、人手动再投一遍），
/// 而重复任务的代价是真实的：同一门课被抢两次。
fn active_task_exists(conn: &Connection, account_id: i64, turn_id: &str, lesson_id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM campus_grab_tasks WHERE account_id = ?1 AND turn_id = ?2 AND lesson_id = ?3 \
         AND status NOT IN ('success','failed','conflict','cancelled') LIMIT 1",
        rusqlite::params![account_id, turn_id, lesson_id],
        |_| Ok(()),
    )
    .is_ok()
}

/// 落库投递口里排队的意图，然后把它改名成 `.done`（幂等 + 可追溯）。
///
/// 返回 `Some(错误)` 时调用方把它挂到 `hub.last_error` 让人看见 ——
/// 「投递了半天没反应」是最难查的一种故障，不能让它在静默里发生。
/// 解析不了的文件会被挪成 `.bad.json`：不重试、不瘫痪引擎，原件还在，能查。
fn drain_intake(app: &AppHandle, account_id: i64) -> Option<String> {
    let dir = crate::db::data_dir(app).ok()?;
    let path = dir.join(INTAKE_FILE);
    if !path.exists() {
        return None;
    }

    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => return Some(format!("投递口读取失败：{e}")),
    };
    // 记事本存出来的 JSON 常带 BOM，serde 不认
    let text = text.trim_start_matches('\u{feff}').trim().to_string();

    let batches: Vec<IntakeBatch> = match serde_json::from_str(&text) {
        Ok(b) => b,
        Err(e) => {
            let bad = dir.join("campus_intake.bad.json");
            let _ = std::fs::remove_file(&bad);
            let _ = std::fs::rename(&path, &bad);
            return Some(format!(
                "投递口不是合法 JSON，已挪到 campus_intake.bad.json：{e}"
            ));
        }
    };

    let mut added = 0usize;
    let outcome = {
        let state = app.state::<AppState>();
        let conn = state.db.lock();
        let mut r = Ok(());
        for b in batches.iter() {
            for t in b.targets.iter() {
                let lid = json_to_col(&t.lesson_id);
                if active_task_exists(&conn, account_id, &b.turn_id, &lid) {
                    continue; // 已经在抢了，投递口不该造出第二条
                }
                // 只认两种模式，其余一律当占位优先（拼错一个词不该变成「直接提交」）
                let mode = match b.mode.as_deref() {
                    Some("direct") => "direct",
                    _ => "predicate",
                };
                match insert_task(
                    &conn,
                    account_id,
                    &b.turn_id,
                    b.turn_name.as_deref(),
                    t,
                    mode,
                    b.window_wall.as_deref(),
                    b.window_end_wall.as_deref(),
                ) {
                    Ok(_) => added += 1,
                    Err(e) => {
                        r = Err(e);
                        break;
                    }
                }
            }
        }
        r
    };

    match outcome {
        Ok(()) => {
            let done = dir.join(INTAKE_DONE);
            let _ = std::fs::remove_file(&done);
            let _ = std::fs::rename(&path, &done);
            None
        }
        Err(e) => Some(format!("投递口落库失败（已落 {added} 条）：{e}")),
    }
}

/// 记下「进批次」拿到的批次 id（`courseSelectTurnAssoc`）。
///
/// 单独一个函数而不是塞进 [`insert_task`] 的参数里：入队时它是网络调用的结果，
/// 拿不到是常态（窗口没开、接口失败），此时留空即可 —— 提交时会退回列表 id。
pub fn set_turn_assoc(conn: &Connection, id: i64, turn_assoc: &str) -> Result<()> {
    if turn_assoc.trim().is_empty() {
        return Ok(());
    }
    conn.execute(
        "UPDATE campus_grab_tasks SET turn_assoc = ?2 WHERE id = ?1",
        rusqlite::params![id, turn_assoc],
    )?;
    Ok(())
}

pub fn delete_task(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM campus_grab_tasks WHERE id = ?1", [id])?;
    Ok(())
}

/// 清掉已结束的任务（成功/失败/冲突/已取消）。
pub fn clear_finished(conn: &Connection, account_id: i64) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM campus_grab_tasks WHERE account_id = ?1 \
         AND status IN ('success','failed','conflict','cancelled')",
        [account_id],
    )?)
}

pub fn set_status(conn: &Connection, id: i64, status: &str) -> Result<()> {
    let finished = grab_is_terminal(status).then(now_ms);
    conn.execute(
        "UPDATE campus_grab_tasks SET status = ?2, phase = 'idle', next_at = ?3, finished_at = ?4 \
         WHERE id = ?1",
        rusqlite::params![id, status, now_ms(), finished],
    )?;
    Ok(())
}

/* ─────────────────────── 计划（意向）：读写 ─────────────────────── */

const INTENT_COLS: &str = "id, turn_id, turn_name, query, mode, spread, status, group_keys, \
     candidates, last_message, attempts, next_at, created_at, resolved_at";

fn intent_row(r: &Row<'_>) -> rusqlite::Result<GrabIntent> {
    let keys: String = r.get(7)?;
    let candidates: String = r.get(8)?;
    Ok(GrabIntent {
        id: r.get(0)?,
        turn_id: r.get(1)?,
        turn_name: r.get(2)?,
        query: r.get(3)?,
        mode: r.get(4)?,
        spread: r.get::<_, i64>(5)? != 0,
        status: r.get(6)?,
        // 坏 JSON 按空数组处理：一条计划的候选清单不该拖垮整份快照
        group_keys: serde_json::from_str(&keys).unwrap_or_default(),
        candidates: serde_json::from_str(&candidates).unwrap_or_default(),
        last_message: r.get(9)?,
        attempts: r.get(10)?,
        next_at: r.get(11)?,
        created_at: r.get(12)?,
        resolved_at: r.get(13)?,
    })
}

/// 全部计划（界面用），按写下顺序。
pub fn load_intents(conn: &Connection, account_id: i64) -> Result<Vec<GrabIntent>> {
    let sql = format!(
        "SELECT {INTENT_COLS} FROM campus_grab_intents WHERE account_id = ?1 ORDER BY id ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([account_id], intent_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn load_intent(conn: &Connection, id: i64) -> Result<Option<GrabIntent>> {
    let sql = format!("SELECT {INTENT_COLS} FROM campus_grab_intents WHERE id = ?1");
    match conn.query_row(&sql, [id], intent_row) {
        Ok(i) => Ok(Some(i)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(ReinError::from(e)),
    }
}

/// 到点该解析的那条计划。
///
/// **只有 `pending` / `empty` / `ambiguous` 会被选中** —— `ready` 的计划不自动重解析：
/// 它已经排出了任务，再解析一遍只会对着同一批班重排（用户真要重来会按「重新解析」）。
/// `ambiguous` 也要重试：名单是会变的（后来只剩一个年级的班，它就自己解析成功了）。
fn load_due_intent(conn: &Connection, account_id: i64, now: i64) -> Result<Option<GrabIntent>> {
    let sql = format!(
        "SELECT {INTENT_COLS} FROM campus_grab_intents \
         WHERE account_id = ?1 AND status IN ('{INTENT_PENDING}','{INTENT_EMPTY}','{INTENT_AMBIGUOUS}') \
         AND next_at <= ?2 \
         ORDER BY next_at ASC, id ASC LIMIT 1"
    );
    match conn.query_row(&sql, rusqlite::params![account_id, now], intent_row) {
        Ok(i) => Ok(Some(i)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(ReinError::from(e)),
    }
}

/// 记下一条计划。`next_at = 0` 意味着「马上解析」。
pub fn insert_intent(
    conn: &Connection,
    account_id: i64,
    turn_id: Option<&str>,
    turn_name: Option<&str>,
    query: &str,
    mode: &str,
    spread: bool,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO campus_grab_intents \
         (account_id, turn_id, turn_name, query, mode, spread, status, next_at, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)",
        rusqlite::params![
            account_id,
            turn_id,
            turn_name,
            query,
            mode,
            spread as i64,
            INTENT_PENDING,
            now_ms(),
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 写回一条计划的可变部分（解析结果与重试安排）。
pub fn save_intent(conn: &Connection, i: &GrabIntent) -> Result<()> {
    conn.execute(
        "UPDATE campus_grab_intents SET turn_id = ?2, turn_name = ?3, query = ?4, mode = ?5, \
         spread = ?6, status = ?7, group_keys = ?8, candidates = ?9, last_message = ?10, \
         attempts = ?11, next_at = ?12, resolved_at = ?13 WHERE id = ?1",
        rusqlite::params![
            i.id,
            i.turn_id,
            i.turn_name,
            i.query,
            i.mode,
            i.spread as i64,
            i.status,
            serde_json::to_string(&i.group_keys)?,
            serde_json::to_string(&i.candidates)?,
            i.last_message,
            i.attempts,
            i.next_at,
            i.resolved_at,
        ],
    )?;
    Ok(())
}

/// 删一条计划，同时**收掉它派出去的任务**。
///
/// 只删计划不收任务会留下一个说不通的局面：界面上的计划没了，抢课却还在跑。
/// 终态任务留着（那是历史记录），非终态的取消 —— 与「取消」这个动作的语义一致。
pub fn delete_intent(conn: &Connection, id: i64) -> Result<()> {
    if let Some(i) = load_intent(conn, id)? {
        for key in &i.group_keys {
            conn.execute(
                "UPDATE campus_grab_tasks SET status = ?2, phase = 'idle', next_at = ?3, \
                 finished_at = ?3, last_message = '计划已移除' \
                 WHERE group_key = ?1 AND status NOT IN ('success','failed','conflict','cancelled')",
                rusqlite::params![key, GRAB_CANCELLED, now_ms()],
            )?;
        }
    }
    conn.execute("DELETE FROM campus_grab_intents WHERE id = ?1", [id])?;
    Ok(())
}

/// 让一条计划立刻重新解析（用户按「重新解析」）。
///
/// **不清候选**：解析要等一次名单查询，界面在这期间仍显示上一次的结果比显示空白强。
pub fn reset_intent(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE campus_grab_intents SET status = ?2, next_at = 0, \
         last_message = '正在重新解析教学班…' WHERE id = ?1",
        rusqlite::params![id, INTENT_PENDING],
    )?;
    Ok(())
}

/// `app_meta` 读写走 `db` 的唯一实现（本模块只留短别名，便于阅读）。
fn read_meta(conn: &Connection, key: &str) -> Option<String> {
    crate::db::meta_get(conn, key)
}

fn write_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    crate::db::meta_set(conn, key, value)
}

/// 读节奏参数。库里存的是 JSON；解析不出来就用默认值
/// （**绝不因为设置坏了而停下引擎** —— 抢课期间「因为配置有问题所以不抢了」不可接受）。
pub fn load_settings(conn: &Connection) -> Result<GrabSettings> {
    Ok(read_meta(conn, SETTINGS_KEY)
        .and_then(|s| serde_json::from_str::<GrabSettings>(&s).ok())
        .unwrap_or_default()
        .sanitized())
}

pub fn save_settings(conn: &Connection, s: &GrabSettings) -> Result<()> {
    write_meta(
        conn,
        SETTINGS_KEY,
        &serde_json::to_string(&s.clone().sanitized())?,
    )?;
    Ok(())
}

/* ─────────────────────────── 快照 ─────────────────────────── */

/// 批次 → 界面用的轻量摘要。
///
/// 窗口时刻走 `opens_at_text` / `closes_at_text` 那一套优先级（结构化区间优先，
/// 退化才抠 `selectDateTimeText`）—— **界面显示的开窗时间与引擎实际开火的时刻必须同源**，
/// 否则用户看到的倒计时和它真正出手的那一刻对不上。
fn turn_brief(t: &CourseSelectTurn) -> GrabTurnBrief {
    GrabTurnBrief {
        id: matcher::id_text(&t.id),
        name: t.name.clone(),
        allow_enter: t.allow_enter,
        select_text: t.select_date_time_text.clone(),
        window_start: t.opens_at_text(),
        window_end: t.closes_at_text(),
    }
}

/// 读回窗口监听的批次摘要。
///
/// 坏数据按「还没探测过」处理：界面宁可显示「等待探测」，
/// 也不该因为一段坏 JSON 让整份快照失败（那会让整个抢课面板空掉）。
fn read_turns(conn: &Connection) -> Vec<GrabTurnBrief> {
    read_meta(conn, TURNS_KEY)
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 组装给界面看的快照。命令与事件共用它，保证「拉一次」与「推一次」永远同形。
pub fn snapshot(conn: &Connection, hub: &GrabHub) -> Result<GrabState> {
    let account_id = active_account_id(conn)?;
    let mut tasks = match account_id {
        Some(id) => load_tasks(conn, id)?,
        None => Vec::new(),
    };
    let intents = match account_id {
        Some(id) => load_intents(conn, id)?,
        None => Vec::new(),
    };
    let settings = load_settings(conn)?;
    let clock: Option<(i64, SkewEstimate)> =
        read_meta(conn, CLOCK_KEY).and_then(|s| read_clock(&s));
    let skew_ms = clock.as_ref().map(|(_, est)| est.skew_ms);

    // 开火时刻是**派生值**，只有这里算得对（它要用实测偏差与提前量），
    // 所以在这一层填给界面，而不是让前端自己再实现一遍墙上时间换算。
    for t in tasks.iter_mut() {
        t.fire_at = fire_at_ms(t, skew_ms.unwrap_or(0), settings.lead_ms);
    }

    // 志愿组同理：谁在压着谁，只有 `group_lead` 说了算。在这里把结论喂给界面，
    // 前端就不必（也不该）自己再实现一遍「组内按志愿序取最小」的规则。
    let now = now_ms();
    let groups: BTreeSet<String> = tasks
        .iter()
        .filter_map(|t| group_of(t).map(str::to_string))
        .collect();
    let leads: HashMap<String, i64> = groups
        .iter()
        .filter_map(|g| group_lead(g, &tasks, &settings, now).map(|l| (g.clone(), l.id)))
        .collect();
    for t in tasks.iter_mut() {
        // 只有**还在场上**的才谈得上被谁压着。终态/暂停的任务不在等任何人 ——
        // 给它们也标上「等第 N 志愿」，界面就会说着「它还在排队」而实际上它已经出局了。
        let in_play = !grab_is_terminal(&t.status) && t.status != GRAB_PAUSED;
        let held = if in_play {
            group_of(t)
                .and_then(|g| leads.get(g).copied())
                .filter(|id| *id != t.id)
        } else {
            None
        };
        t.held_by = held;
    }

    let active = tasks
        .iter()
        .any(|t| !grab_is_terminal(&t.status) && t.status != GRAB_PAUSED);
    let next_at = tasks
        .iter()
        .filter(|t| t.status == GRAB_WAITING || t.status == GRAB_RUNNING)
        .map(|t| t.next_at)
        .min();
    // 还没到点的任务里，最早的那次开火就是用户要等的那个时刻
    let next_fire_at = tasks
        .iter()
        .filter(|t| t.status == GRAB_WAITING || t.status == GRAB_RUNNING)
        .filter_map(|t| t.fire_at)
        .filter(|at| *at != GATE_UNKNOWN)
        .min();

    Ok(GrabState {
        alive: true,
        enabled: hub.enabled(),
        active,
        // 界面上的「教务时间」此刻该显示什么：把最近一次采样按偏差推到现在
        server_time: skew_ms
            .map(|skew| format_now(now_ms() + skew))
            .or_else(|| clock.as_ref().map(|(_, est)| est.text.clone())),
        skew_sec: skew_ms.map(skew_secs),
        next_at,
        next_fire_at,
        last_error: hub.last_error(),
        turns: read_turns(conn),
        probed_at: read_meta(conn, PROBED_KEY).and_then(|s| s.parse::<i64>().ok()),
        intents,
        tasks,
    })
}

/// 本机 unix 毫秒 → `2026-09-17 07:07:57`
pub fn format_now(ms: i64) -> String {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_default()
}

/// 偏差毫秒 → 展示用的秒数。**四舍五入，不是截断**：采样与读取之间总会过去几毫秒，
/// 截断会让 11.999 秒显示成 11 秒 —— 一个用来对时的数字不该系统性偏小。
pub fn skew_secs(skew_ms: i64) -> i64 {
    (skew_ms + 500).div_euclid(1000)
}

fn emit(app: &AppHandle, hub: &GrabHub) {
    let payload = {
        let state = app.state::<AppState>();
        let conn = state.db.lock();
        match snapshot(&conn, hub) {
            Ok(s) => serde_json::to_string(&s).unwrap_or_default(),
            Err(_) => return,
        }
    };
    // 内容没变就不推。引擎每秒醒若干次，没有这道闸门事件总线会被刷爆。
    {
        let Ok(mut last) = hub.last_emit.lock() else {
            return;
        };
        if *last == payload {
            return;
        }
        *last = payload.clone();
    }
    let _ = app.emit(GRAB_EVENT, payload);
}

/* ─────────────────────────── 测试 ─────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn account(conn: &Connection) -> i64 {
        conn.execute(
            "INSERT INTO campus_accounts (system_kind, base_url, login_name, created_at, updated_at) \
             VALUES ('k', 'https://x', 'n', 't', 't')",
            [],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn turn_brief_fixture(id: &str) -> GrabTurnBrief {
        GrabTurnBrief {
            id: id.into(),
            name: Some(format!("批次 {id}")),
            window_start: Some("2026-09-21 10:00:00".into()),
            window_end: Some("2026-09-30 23:00:00".into()),
            allow_enter: true,
            select_text: None,
        }
    }

    /// **批次被撤下就收手**：上架过、现在不在列表里 = 教务处提前关了。
    /// 光看墙上时间会一直等到原定结束时刻，白守一整天。
    #[test]
    fn a_withdrawn_turn_makes_the_engine_stop() {
        let conn = db();
        let acct = account(&conn);
        let mut t = grouped(&conn, acct, "g1", 1); // turn_id 固定是 "77"
        let mut other = grouped(&conn, acct, "g2", 1);
        other.turn_id = "88".into(); // 另一门课排在另一个批次上
        let all = vec![t.clone(), other.clone()];

        let prev = vec![turn_brief_fixture("77"), turn_brief_fixture("88")];

        // 都还在列表里 → 谁都不收手
        let briefs = vec![turn_brief_fixture("77"), turn_brief_fixture("88")];
        assert!(withdrawn_tasks(&all, &prev, &briefs).is_empty());

        // 77 从列表里消失（88 还在）→ 只收 77 的那个任务
        let briefs = vec![turn_brief_fixture("88")];
        let hit = withdrawn_tasks(&all, &prev, &briefs);
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].turn_id, "77");

        // **上一轮也没有它** = 还没公布，不许判死（提前一晚排的课就是这样）
        assert!(withdrawn_tasks(
            &all,
            &[turn_brief_fixture("88")],
            &[turn_brief_fixture("88")]
        )
        .is_empty());

        // 教务回了一份空列表：上架过的两个都按「撤下」处理
        assert_eq!(withdrawn_tasks(&all, &prev, &[]).len(), 2);

        // **手上有受理单的不收**：那张单子可能已经中了，要先核对结果
        t.request_id = Some("req-1".into());
        let with_receipt = vec![t, other.clone()];
        assert_eq!(
            withdrawn_tasks(&with_receipt, &prev, &[]).len(),
            1,
            "只有手上没单子的那个才收"
        );

        // 已终态的不再动它
        let mut done = other;
        done.status = GRAB_SUCCESS.into();
        assert!(withdrawn_tasks(&[done], &prev, &[]).is_empty());
    }

    /// 造一个教学班（落盘/匹配类测试用）。
    fn lesson_fixture(
        id: i64,
        code: &str,
        name: &str,
        teacher: Option<&str>,
        std: i64,
        limit: i64,
    ) -> CourseSelectLesson {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "course": { "id": id * 10, "code": code, "nameZh": name, "credits": 2 },
            "stdCount": std,
            "limitCount": limit,
            "teachers": teacher.map(|t| serde_json::json!({ "nameZh": t })).into_iter().collect::<Vec<_>>(),
        }))
        .unwrap()
    }

    /// 名单落盘：写进去、读回来，形状要对得上 —— 它是「教务拉不到名单」时的唯一退路，
    /// 存错一个字段就等于没有。
    #[test]
    fn lessons_dump_round_trips_and_is_per_turn() {
        let dir = std::env::temp_dir().join(format!("rein-dump-test-{}", now_ms()));
        let hub = GrabHub::with_data_dir(dir.clone());
        let ls = vec![
            lesson_fixture(317844, "000109", "新生入学教育", Some("张伟"), 10, 60),
            lesson_fixture(319847, "000198", "中华民族共同体概论", Some("杨帆"), 40, 60),
        ];

        // 还没写过 → 读不到
        assert!(hub.load_lessons_dump("1921").is_none());

        hub.save_lessons_dump("1921", &ls, Some("1921-turn"));
        let dump = hub.load_lessons_dump("1921").expect("同批次的名单要能读回来");
        assert_eq!(dump.lessons.len(), 2);
        assert_eq!(dump.assoc.as_deref(), Some("1921-turn"));
        assert_eq!(
            dump.lessons[1].course.as_ref().unwrap().name_zh.as_deref(),
            Some("中华民族共同体概论")
        );
        assert_eq!(dump.lessons[0].std_count, Some(10));

        // **换批次就读不到**：名单是按批次算的，拿 A 轮的班去 B 轮抢是纯粹的错
        assert!(
            hub.load_lessons_dump("9999").is_none(),
            "别的批次不该认这份名单"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 落盘是加固措施：**没配目录时不许影响正常拉名单**（引擎照旧走网络）。
    #[test]
    fn lessons_dump_is_optional() {
        let hub = GrabHub::default();
        hub.save_lessons_dump("1921", &[lesson_fixture(1, "000001", "课", None, 1, 2)], None);
        assert!(hub.load_lessons_dump("1921").is_none(), "没配目录就不落盘");
        assert!(hub.lessons_fallback_note().is_none(), "没兜底过就不该有提示");
    }

    fn input(id: Value) -> GrabTargetInput {
        GrabTargetInput {
            lesson_id: id,
            lesson_name: None,
            course_name: Some("高等数学（上）".into()),
            course_code: Some("000001".into()),
            teacher: None,
            credits: Some(5.0),
            virtual_cost: Some(30),
            schedule_group_id: Some(serde_json::json!(9)),
            group_key: None,
            group_name: None,
            priority: 0,
        }
    }

    /// 造一条「志愿组里的任务」并**真落库** —— `close_group` 是 SQL，不落库就测不到。
    fn grouped(conn: &Connection, account_id: i64, group: &str, priority: i64) -> GrabTask {
        let mut inp = input(serde_json::json!(priority));
        inp.group_key = Some(group.into());
        inp.group_name = Some("体育组".into());
        inp.priority = priority;
        let id = insert_task(conn, account_id, "77", None, &inp, "predicate", None, None).unwrap();
        load_task(conn, id).unwrap().unwrap()
    }

    /// **被拒了就换人**：满员冷却期间，出手机会交给组里下一个候选。
    ///
    /// 这条是搬的抢课行为：他们对被拒的候选做 1 秒冷却、立刻重匹配下一个。
    /// 死守第一志愿的问题是「别的班有人退课我们看不见」—— 而全局节流本来就
    /// 一轮只发一个请求，轮着打不多花请求，只是把火力铺到更多候选上。
    #[test]
    fn a_cooling_candidate_steps_aside_for_the_next_one() {
        let conn = db();
        let acct = account(&conn);
        let settings = GrabSettings::default();
        let mut a = grouped(&conn, acct, "g1", 1);
        let b = grouped(&conn, acct, "g1", 2);
        let c = grouped(&conn, acct, "g1", 3);
        let now = now_ms();

        // 都到点：第一志愿说了算
        a.next_at = 0;
        let tasks = vec![a.clone(), b.clone(), c.clone()];
        assert_eq!(group_lead("g1", &tasks, &settings, now).unwrap().id, a.id);
        assert!(armed(&a, &tasks, &settings, now));

        // 第一志愿刚被拒（冷却中）→ 第二志愿顶上，第一志愿这一轮不许出手
        let mut a_cool = a.clone();
        a_cool.next_at = now + REJECT_COOLDOWN_MS;
        let tasks = vec![a_cool.clone(), b.clone(), c.clone()];
        assert_eq!(
            group_lead("g1", &tasks, &settings, now).unwrap().id,
            b.id,
            "冷却中的第一志愿该把机会让给第二志愿"
        );
        assert!(!armed(&a_cool, &tasks, &settings, now), "冷却期间不再出手");
        assert!(armed(&b, &tasks, &settings, now));

        // 前两个都在冷却 → 第三志愿顶上
        let mut b_cool = b.clone();
        b_cool.next_at = now + REJECT_COOLDOWN_MS;
        let tasks = vec![a_cool.clone(), b_cool.clone(), c.clone()];
        assert_eq!(
            group_lead("g1", &tasks, &settings, now).unwrap().id,
            c.id,
            "第一个能出手的候选才是当前志愿"
        );

        // **全组都在冷却** → 退回「谁先到点谁上」（引擎要按它算醒来时刻），
        // 而且谁都不许出手（都还没到点）
        let mut c_cool = c.clone();
        c_cool.next_at = now + REJECT_COOLDOWN_MS * 2;
        let mut a_earlier = a_cool.clone();
        a_earlier.next_at = now + REJECT_COOLDOWN_MS / 2;
        let tasks = vec![a_earlier.clone(), b_cool.clone(), c_cool.clone()];
        let lead = group_lead("g1", &tasks, &settings, now).unwrap();
        assert_eq!(lead.id, a_earlier.id, "全组冷却时按最早到点选，好让引擎准时醒");
        assert!(armed(&a_earlier, &tasks, &settings, now), "轮到它了");
        assert!(
            !armed(&b_cool, &tasks, &settings, now),
            "还没轮到的候选不出手"
        );
    }

    /// 只有一个候选时，冷却照旧**只影响它自己** —— 它仍然每轮都在抢，
    /// 只是比节流间隔慢一点（见 `REJECT_COOLDOWN_MS` 的注释）。
    #[test]
    fn a_solo_candidate_cools_down_but_keeps_trying() {
        let conn = db();
        let acct = account(&conn);
        let settings = GrabSettings::default();
        let mut solo = grouped(&conn, acct, "solo", 1);
        let now = now_ms();
        solo.next_at = now + REJECT_COOLDOWN_MS;
        let tasks = vec![solo.clone()];
        assert_eq!(
            group_lead("solo", &tasks, &settings, now).unwrap().id,
            solo.id,
            "就它一个候选，退开到哪儿都还是它"
        );
        assert!(armed(&solo, &tasks, &settings, now), "被选中就仍然由它出手");
    }

    /// 冷却必须**长于节流间隔**，否则下一次心跳它就又到点了、组里永远轮不到别人。
    #[test]
    fn the_reject_cooldown_outlasts_the_pace_gate() {
        let settings = GrabSettings::default();
        let cooldown = REJECT_COOLDOWN_MS.max(settings.min_interval_ms.saturating_mul(2));
        assert!(
            cooldown > settings.min_interval_ms,
            "冷却 {cooldown}ms 必须长于节流间隔 {}ms，否则轮换是假的",
            settings.min_interval_ms
        );
    }

    /// 满员的文案里带「已选」二字 —— 先判「已选过」会把满员误判成终态，
    /// 那是抢课里最贵的 bug：你以为在守着，其实早就放弃了。
    #[test]
    fn full_is_not_mistaken_for_already_picked() {
        assert_eq!(verdict_of("已选人数已达上限"), Verdict::Full);
        assert_eq!(verdict_of("教学班人数已满"), Verdict::Full);
        assert_eq!(verdict_of("剩余名额不足"), Verdict::Full);
        assert_eq!(verdict_of("该教学班已满员"), Verdict::Full);
        // 真的已经选过，才判终态
        assert_eq!(verdict_of("你已经选过这门课"), Verdict::Fatal);
        assert_eq!(verdict_of("请不要重复提交"), Verdict::Fatal);
    }

    #[test]
    fn verdict_covers_the_real_failure_families() {
        assert_eq!(
            verdict_of("选课令牌已失效，请重新打开选课页重试"),
            Verdict::TokenRefresh
        );
        assert_eq!(
            verdict_of("教务会话已过期，请先重新登录"),
            Verdict::SessionLost
        );
        assert_eq!(
            verdict_of("与已选课程时间冲突，请办理免听"),
            Verdict::Conflict
        );
        assert_eq!(verdict_of("不在选课时间内"), Verdict::Fatal);
        assert_eq!(verdict_of("网络请求失败：timed out"), Verdict::Retry);
        // 认不出来的一律可重试，由连败上限兜底
        assert_eq!(verdict_of("教务返回了一段没人见过的话"), Verdict::Retry);
        assert_eq!(verdict_of(""), Verdict::Retry);
    }

    /// 三类应急：**限流与 5xx 继续打，参数错误立刻停手交给 AI**。
    ///
    /// 这个分档是抢课的成败线：窗口只有几分钟，退避一次就少几十次机会；
    /// 而用错误的参数继续撞，既不会成功，又在持续骚扰教务。
    #[test]
    fn verdict_splits_the_three_emergencies() {
        // 限流：文案五花八门，还得认得出英文与状态码
        assert_eq!(verdict_of("请求过于频繁，请稍后再试"), Verdict::Throttled);
        assert_eq!(verdict_of("操作过于频繁"), Verdict::Throttled);
        assert_eq!(verdict_of("HTTP 429 Too Many Requests"), Verdict::Throttled);
        assert_eq!(verdict_of("rate limit exceeded"), Verdict::Throttled);

        // 服务器出错：5xx / 服务异常 / 连接被重置
        assert_eq!(verdict_of("选课接口失败：HTTP 503"), Verdict::ServerDown);
        assert_eq!(verdict_of("服务器内部错误"), Verdict::ServerDown);
        assert_eq!(verdict_of("502 Bad Gateway"), Verdict::ServerDown);
        assert_eq!(verdict_of("连接被重置"), Verdict::ServerDown);

        // 参数错误：请求的写法不对，重试无用
        assert_eq!(verdict_of("请求参数错误：缺少 assoc"), Verdict::BadRequest);
        assert_eq!(verdict_of("参数校验失败"), Verdict::BadRequest);
        assert_eq!(
            verdict_of("HTTP 422 Unprocessable Entity"),
            Verdict::BadRequest
        );

        // **顺序保证**：能判出「这门课不存在」的按终态处理，别把它推给 AI；
        // 「已选人数已达上限」也不能因为带了别的词就变成限流
        assert_eq!(verdict_of("参数错误：教学班不存在"), Verdict::Fatal);
        assert_eq!(verdict_of("已选人数已达上限"), Verdict::Full);
        assert_eq!(verdict_of("服务器繁忙，请稍后再试"), Verdict::ServerDown);
    }

    /// 「服务端读不懂我们的 JSON」必须判成**我们的**问题（参数错误 → 停下来），
    /// 而不是「教务崩了继续打」。
    ///
    /// 真出过（2026-09-22 联调）：`courseSelectTurnAssoc` 发成了字符串，教务回 500
    /// 并附一段 Jackson 的 JSON 解析错误。判定表当时先命中 5xx 分支，于是引擎把
    /// 「每一枪都注定失败」记成了「教务服务器出错（继续重试）」——
    /// 不但永远打不中，还把责任安在了教务头上，现场也因此被藏了整整一轮联调。
    #[test]
    fn unserializable_payload_is_our_fault_not_the_server_being_down() {
        let real = "选课接口失败：HTTP 500：{\"timestamp\":\"2026-09-22 12:24:47\",\
                    \"status\":500,\"error\":\"Internal Server Error\",\
                    \"exception\":\"org.springframework.http.converter.HttpMessageNotReadableException\",\
                    \"message\":\"JSON parse error: Can not construct instance of \
                    com.supwisdom.eams.course.selection.turn.domain.model.CourseSelectTurnAssoc: \
                    no String-argument constructor/factory method to deserialize from String value ('1921')\"}";
        assert_eq!(verdict_of(real), Verdict::BadRequest);

        // 教务**自己**崩了的文案仍要按「继续重试」处理 —— 这条不能被我这次改动带偏
        assert_eq!(
            verdict_of("选课接口失败：HTTP 500：{\"error\":\"Internal Server Error\"}"),
            Verdict::ServerDown
        );
        assert_eq!(verdict_of("HTTP 503 Service Unavailable"), Verdict::ServerDown);
        // 参数错误与这条新规则落在同一档，语义一致
        assert_eq!(verdict_of("Cannot deserialize value of type `int`"), Verdict::BadRequest);
    }

    /// 「不符合选课条件组要求」与「相同教学班只能选一次」都是**硬条件**（真机实测原话）：
    /// 试多少次都是同一句话，必须判终态 —— 否则会白烧掉八次出手机会才放弃。
    #[test]
    fn hard_eligibility_rejections_are_fatal_not_retryable() {
        assert_eq!(verdict_of("不符合选课条件组要求"), Verdict::Fatal);
        assert_eq!(verdict_of("相同教学班只能选一次"), Verdict::Fatal);
        // 「不符合」这个词本身不该把别的失败也判死
        assert_ne!(verdict_of("不符合预期"), Verdict::Fatal);
    }

    /// 占位回执的**逐条判词**：`success` 只说明「这条单子处理完了」，
    /// 每个教学班各有一条判词，只有 `ATTEND`（或没有判词）才算真的通过。
    ///
    /// 样本是 2026-09-22 的真机回执（对一门已在名下的课发占位）。
    #[test]
    fn a_predicate_verdict_is_read_per_lesson() {
        let raw = serde_json::json!({
            "success": true,
            "result": {"319505": {"textZh": "相同教学班只能选一次", "textEn": "Duplicate lessons are not allowed"}}
        });
        assert_eq!(
            predicate_reject_note(&raw, &serde_json::json!(319505)).as_deref(),
            Some("相同教学班只能选一次")
        );
        // 同一个 id 在别的接口里是字符串形态，也要认得出来
        assert!(predicate_reject_note(&raw, &serde_json::json!("319505")).is_some());
        // 别的教学班不受影响
        assert!(predicate_reject_note(&raw, &serde_json::json!(999)).is_none());

        // 通过：ATTEND 与「没有判词」都算过
        let pass = serde_json::json!({"success": true, "result": {"319505": {"textZh": "ATTEND"}}});
        assert!(predicate_reject_note(&pass, &serde_json::json!(319505)).is_none());
        let silent = serde_json::json!({"success": true});
        assert!(predicate_reject_note(&silent, &serde_json::json!(319505)).is_none());
        // 形状变了（result 不是对象、正文不是 JSON）不许崩，也不许误判成拒绝
        assert!(predicate_reject_note(&serde_json::json!({"result": [1, 2]}), &serde_json::json!(1)).is_none());
        assert!(predicate_reject_note(&serde_json::json!(""), &serde_json::json!(1)).is_none());
    }

    /// 占位被判死时**不再发正式请求**：这一枪已经被否了，正式请求只是白费一次出手机会。
    #[test]
    fn a_rejected_predicate_stops_before_the_formal_request() {
        let s = GrabSettings::default();
        let mut t = task(None, 0);
        t.mode = "predicate".into();
        t.predicate_done = true; // 占位已交 → 这一步本该去轮询占位单
        t.phase = PHASE_POLL.into();
        t.request_id = Some("gp1".into());
        assert!(polls_predicate(&t));

        judge(
            &s,
            &mut t,
            serde_json::json!({"success": true, "result": {"1": {"textZh": "相同教学班只能选一次"}}}),
            true,
            0,
        );
        assert_ne!(t.phase, PHASE_SUBMIT, "被拒的占位不该转正式确认");
        assert_eq!(t.status, GRAB_FAILED, "「只能选一次」是终态");
        assert_eq!(t.attempts, 0, "一次正式请求都不该发出去");
        assert!(t
            .last_message
            .clone()
            .unwrap_or_default()
            .contains("只能选一次"));

        // 占位**通过**时仍要走原来那条路：转正式确认
        let mut ok = task(None, 0);
        ok.mode = "predicate".into();
        ok.predicate_done = true;
        ok.phase = PHASE_POLL.into();
        ok.request_id = Some("gp2".into());
        judge(
            &s,
            &mut ok,
            serde_json::json!({"success": true, "result": {"1": {"textZh": "ATTEND"}}}),
            true,
            0,
        );
        assert_eq!(ok.phase, PHASE_SUBMIT, "ATTEND 才该转正式确认");
        assert!(ok.request_id.is_none(), "占位单用完了要清掉");
    }

    #[test]
    fn throttled_and_server_errors_keep_hammering_without_backoff() {
        // 提交上限设成 1：被限流/5xx 消耗掉的话，窗口一开就正好没额度了
        let s = GrabSettings {
            max_attempts: 1,
            ..Default::default()
        };

        for (msg, note) in [
            ("请求过于频繁，请稍后再试", "限速"),
            ("选课接口失败：HTTP 503", "服务器出错"),
        ] {
            let mut t = task(None, 1);
            let before = now_ms();
            absorb_error(&mut t, &s, msg.into(), 0);
            assert_eq!(t.status, GRAB_WAITING, "{msg}");
            assert_eq!(t.strikes, 0, "对方的状态不该记在这条任务账上：{msg}");
            assert!(t.next_at <= now_ms() + 5, "不许退避：{msg}");
            assert!(t.next_at >= before, "也不许回到过去：{msg}");
            assert!(
                t.last_message.as_deref().unwrap_or_default().contains(note),
                "要把应对方式写给用户看：{msg}"
            );
            assert!(
                t.last_message.as_deref().unwrap_or_default().contains(msg),
                "教务的原话也要留着：{msg}"
            );
        }
    }

    #[test]
    fn bad_request_stops_the_task_and_hands_it_to_ai() {
        let s = GrabSettings {
            max_attempts: 1,
            ..Default::default()
        };
        let mut t = task(None, 1);
        absorb_error(&mut t, &s, "请求参数错误：缺少 assoc".into(), 0);

        assert_eq!(t.status, GRAB_NEEDS_AI);
        assert!(grab_is_terminal(&t.status), "引擎不许再碰它");
        let msg = t.last_message.clone().unwrap_or_default();
        assert!(msg.contains("参数错误"), "{msg}");
        assert!(msg.contains("AI"), "要指出下一步是交给 AI：{msg}");
    }

    #[test]
    fn wall_time_parses_the_shapes_the_school_actually_emits() {
        let base = wall_to_ms("2026-09-17 08:00:00").unwrap();
        assert_eq!(wall_to_ms("2026-09-17 08:00").unwrap(), base);
        assert_eq!(wall_to_ms("2026-09-17T08:00:00").unwrap(), base);
        assert_eq!(wall_to_ms("2026/09/17 08:00:00").unwrap(), base);
        assert_eq!(wall_to_ms(" 2026-09-17 08:00:00 ").unwrap(), base);
        assert_eq!(wall_to_ms("2026年9月17日 08:00:00").unwrap(), base);
        // 只给日期 → 当天零点
        assert_eq!(
            wall_to_ms("2026-09-17").unwrap(),
            wall_to_ms("2026-09-17 00:00:00").unwrap()
        );
        assert_eq!(wall_to_ms("待定"), None);
        assert_eq!(wall_to_ms(""), None);
    }

    fn task(window: Option<&str>, attempts: i64) -> GrabTask {
        GrabTask {
            id: 1,
            turn_id: "77".into(),
            turn_name: None,
            turn_assoc: None,
            lesson_id: serde_json::json!(1),
            lesson_name: None,
            course_name: None,
            course_code: None,
            teacher: None,
            credits: None,
            mode: "predicate".into(),
            virtual_cost: None,
            schedule_group_id: None,
            window_wall: window.map(str::to_string),
            window_end_wall: None,
            await_window: false,
            predicate_done: false,
            status: GRAB_WAITING.into(),
            phase: PHASE_IDLE.into(),
            attempts,
            polls: 0,
            strikes: 0,
            strike_kind: None,
            request_id: None,
            mirror_request_id: None,
            request_domain: None,
            last_message: None,
            next_at: 0,
            fire_at: None,
            queued_at: None,
            finished_at: None,
            group_key: None,
            group_name: None,
            priority: 0,
            stuck_since: None,
            held_by: None,
        }
    }

    /// 占位只交一次。**这是真出过的 bug**：原先用 `attempts == 0` 反推「还没占位」，
    /// 而占位落定到正式提交之间 `attempts` 恰好是 0，于是任务在
    /// 「占位 → 轮询 → 占位」里转圈，正式请求永远发不出去。
    /// 逮到它的是 `scripts/e2e-auto-grab.mjs` —— 单测看不见这种跨状态序列的问题。
    #[test]
    fn predicate_is_placed_exactly_once() {
        let mut t = task(Some("2026-09-17 08:00:00"), 0);
        assert!(needs_predicate(&t), "第一次出手应当先占位");

        // 占位已交、正式提交尚未发生 —— 这正是那个 bug 的窗口期
        t.predicate_done = true;
        assert!(!needs_predicate(&t), "占位交过之后必须直接投正式请求");
        assert_eq!(t.attempts, 0, "此时 attempts 仍是 0，所以它不能拿来当判据");

        // 交过占位之后，即使重试了很多次也不再补占位
        t.attempts = 5;
        t.phase = PHASE_IDLE.into();
        assert!(!needs_predicate(&t));

        // 直接模式从不占位
        let mut d = task(None, 0);
        d.mode = "direct".into();
        assert!(!needs_predicate(&d));
    }

    /// 「重新排队」是一轮全新的抢课：占位标记必须跟着复位，否则重试的任务会直接跳过占位。
    #[test]
    fn predicate_flag_round_trips_and_resets() {
        let conn = db();
        let acct = account(&conn);
        let id = insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(1)),
            "predicate",
            Some("2026-09-17 08:00:00"),
            None,
        )
        .unwrap();
        let mut t = load_task(&conn, id).unwrap().unwrap();
        assert!(!t.predicate_done, "入队时还没占位");

        t.predicate_done = true;
        t.phase = PHASE_POLL.into();
        save_task(&conn, &t).unwrap();
        let back = load_task(&conn, id).unwrap().unwrap();
        assert!(back.predicate_done, "占位标记必须落库");

        // 用户点「重试」走的是 commands 里的 SQL，语义必须一致
        conn.execute(
            "UPDATE campus_grab_tasks SET predicate_done = 0, attempts = 0 WHERE id = ?1",
            [id],
        )
        .unwrap();
        assert!(!load_task(&conn, id).unwrap().unwrap().predicate_done);
    }

    /// 「提交体该用哪个批次 id」是这套代码里最容易悄悄错的地方。
    ///
    /// SPA 提交时发的是「进批次」返回的 `options.turn.id`，不是列表里的 turnId。
    /// 我们拿不到真机样本确认两者是否相等，所以策略是：**有就用，没有就退回列表 id**。
    /// 这条测试钉的就是这个退回行为 —— 少了它，一次「顺手把 unwrap_or 去掉」的改动
    /// 就会让所有提交带着空 id 发出去，而且只在窗口开放时才暴露。
    #[test]
    fn turn_assoc_prefers_the_entered_turn_and_falls_back() {
        let mut t = task(None, 0);
        t.turn_id = "77".into();
        // 没进过批次 → 用列表 id（这是当前唯一有把握的行为）
        assert_eq!(t.turn_assoc(), "77");

        // 进过批次且拿到了别的 id → 用它
        t.turn_assoc = Some("991".into());
        assert_eq!(t.turn_assoc(), "991");

        // 空白值不算数（接口回了个空串时不能把提交搞坏）
        for blank in ["", "   "] {
            t.turn_assoc = Some(blank.into());
            assert_eq!(t.turn_assoc(), "77", "空白 assoc 必须退回 turn_id");
        }
        t.turn_assoc = None;
        assert_eq!(t.turn_assoc(), "77");
    }

    /// assoc 要真的落库：引擎重启后还得知道该用哪个 id。
    #[test]
    fn turn_assoc_round_trips_through_sqlite() {
        let conn = db();
        let acct = account(&conn);
        let id = insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(1)),
            "direct",
            None,
            None,
        )
        .unwrap();
        assert_eq!(load_task(&conn, id).unwrap().unwrap().turn_assoc(), "77");

        set_turn_assoc(&conn, id, "991").unwrap();
        assert_eq!(load_task(&conn, id).unwrap().unwrap().turn_assoc(), "991");

        // 空串不该覆盖掉已有值，也不该写进去
        set_turn_assoc(&conn, id, "  ").unwrap();
        assert_eq!(load_task(&conn, id).unwrap().unwrap().turn_assoc(), "991");
    }

    /// 开火时刻必须走「教务墙上时间 − 实测偏差」这条换算，
    /// 而不是把教务的文本直接当本机时间 —— 学生电脑的时间经常偏。
    #[test]
    fn fire_time_is_skew_corrected_and_leads_the_gate() {
        let t = task(Some("2026-09-17 08:00:00"), 0);
        let wall = wall_to_ms("2026-09-17 08:00:00").unwrap();

        // 偏差 0：提前量 800ms 意味着 07:59:59.200 就该出手
        assert_eq!(fire_at_ms(&t, 0, 800), Some(wall - 800));
        // 服务器比本机快 5 秒：本机要更早出手
        assert_eq!(fire_at_ms(&t, 5_000, 800), Some(wall - 5_800));
        // 服务器比本机慢 3 秒：本机可以晚一点
        assert_eq!(fire_at_ms(&t, -3_000, 800), Some(wall + 2_200));

        // 已经开过火的任务不再受窗口约束，全由重试节奏支配 ——
        // 交过占位也算「出过手」：闸门只管第一枪，打出去之后不该再拿它挡路
        assert_eq!(
            fire_at_ms(&task(Some("2026-09-17 08:00:00"), 3), 0, 800),
            None
        );
        let mut placed = task(Some("2026-09-17 08:00:00"), 0);
        placed.predicate_done = true;
        assert_eq!(fire_at_ms(&placed, 0, 800), None);
        // 没有窗口信息 → 不设闸门
        assert_eq!(fire_at_ms(&task(None, 0), 0, 800), None);
    }

    /// 「提前一晚预设、但教务还没公布窗口」是**核心场景**：
    /// 这种任务绝不能立刻开火 —— 撞出来的「不在选课时间」会被判终态，预设就白费了。
    #[test]
    fn unknown_window_holds_the_task_instead_of_firing_blind() {
        let mut t = task(None, 0);
        // 没有 await 标记（调用方明确说「就是现在抢」）→ 不设闸门
        assert_eq!(fire_at_ms(&t, 0, 800), None);

        // 有 await 标记 → 挡住
        t.await_window = true;
        assert_eq!(fire_at_ms(&t, 0, 800), Some(GATE_UNKNOWN));
        assert!(
            GATE_UNKNOWN > now_ms(),
            "闸门未知必须落在遥远的未来，不能立刻到点"
        );

        // 拿到窗口之后闸门就正常了
        t.window_wall = Some("2026-09-17 08:00:00".into());
        assert_eq!(
            fire_at_ms(&t, 0, 800),
            Some(wall_to_ms("2026-09-17 08:00:00").unwrap() - 800)
        );
    }

    /// 入队时给不出窗口 → 自动进入「等窗口」状态，而不是当成「立刻开抢」。
    #[test]
    fn enqueue_without_a_window_marks_it_as_awaiting() {
        let conn = db();
        let acct = account(&conn);
        let known = insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(1)),
            "direct",
            Some("2026-09-17 08:00:00"),
            Some("2026-09-17 23:59:59"),
        )
        .unwrap();
        let unknown = insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(2)),
            "direct",
            None,
            None,
        )
        .unwrap();

        assert!(!load_task(&conn, known).unwrap().unwrap().await_window);
        let waiting = load_task(&conn, unknown).unwrap().unwrap();
        assert!(waiting.await_window);
        assert_eq!(fire_at_ms(&waiting, 0, 800), Some(GATE_UNKNOWN));
    }

    #[test]
    fn window_close_stops_the_chase() {
        let past = Local::now() - chrono::Duration::minutes(5);
        let future = Local::now() + chrono::Duration::minutes(5);
        let mut t = task(None, 0);
        t.window_end_wall = Some(past.format("%Y-%m-%d %H:%M:%S").to_string());
        assert!(window_closed(&t, 0));
        t.window_end_wall = Some(future.format("%Y-%m-%d %H:%M:%S").to_string());
        assert!(!window_closed(&t, 0));
        // 没有结束时刻就不设这道闸门（由错误分级去兜）
        t.window_end_wall = None;
        assert!(!window_closed(&t, 0));
    }

    #[test]
    fn error_absorption_backs_off_and_gives_up_on_unknowns() {
        let s = GrabSettings::default();

        // 满员：一直守着，但节奏放慢
        let mut t = task(None, 1);
        absorb_error(&mut t, &s, "教学班人数已满".into(), 0);
        assert_eq!(t.status, GRAB_WAITING);
        assert_eq!(t.strike_kind.as_deref(), Some("full"));
        assert!(t.next_at > now_ms());

        // 未知错误：退避重试，连败到上限才停
        let mut t = task(None, 1);
        for _ in 0..UNKNOWN_STRIKE_LIMIT - 1 {
            absorb_error(&mut t, &s, "没人见过的话".into(), 0);
            assert_eq!(t.status, GRAB_WAITING);
        }
        absorb_error(&mut t, &s, "没人见过的话".into(), 0);
        assert_eq!(t.status, GRAB_FAILED);
        assert!(t.last_message.unwrap().contains("连续"));

        // 换令牌不算这个任务的失败：连败清零、重新排队
        let mut t = task(None, 1);
        absorb_error(&mut t, &s, format!("{TOKEN_EXPIRED}，请重新打开选课页重试"), 0);
        assert_eq!(t.status, GRAB_WAITING);
        assert_eq!(t.strikes, 0);

        // 终态错误 / 冲突：立即停，不再浪费对方带宽
        let mut t = task(None, 1);
        absorb_error(&mut t, &s, "不在选课时间内".into(), 0);
        assert_eq!(t.status, GRAB_FAILED);
        let mut t = task(None, 1);
        absorb_error(&mut t, &s, "请办理免听".into(), 0);
        assert_eq!(t.status, GRAB_CONFLICT);
    }

    #[test]
    fn strikes_reset_when_the_failure_changes_family() {
        let s = GrabSettings::default();
        let mut t = task(None, 1);
        for _ in 0..5 {
            absorb_error(&mut t, &s, "没人见过的话".into(), 0);
        }
        assert_eq!(t.strikes, 5);
        // 局面变了：重新给耐心，否则「先未知几次、再满员」会被误判成耗尽
        absorb_error(&mut t, &s, "教学班人数已满".into(), 0);
        assert_eq!(t.strikes, 1);
        assert_eq!(t.strike_kind.as_deref(), Some("full"));
    }

    #[test]
    fn max_attempts_is_a_ceiling_when_set() {
        let s = GrabSettings {
            max_attempts: 3,
            ..Default::default()
        };
        let mut t = task(None, 3);
        absorb_error(&mut t, &s, "教学班人数已满".into(), 0);
        assert_eq!(t.status, GRAB_FAILED);
        assert!(t.last_message.unwrap().contains("已达提交上限"));
    }

    #[test]
    fn settings_are_clamped_to_sane_limits() {
        let s = GrabSettings {
            min_interval_ms: 0,
            poll_interval_ms: 0,
            full_retry_ms: 0,
            backoff_ms: 0,
            lead_ms: 999_999,
            max_polls: 0,
            ..Default::default()
        }
        .sanitized();
        // 下限压得很低（压测过 80 次/秒无异常），但**不能是 0 或负数** ——
        // 那会让闸门失效，变成不留间隙地连打
        assert_eq!(s.min_interval_ms, 10);
        assert_eq!(s.poll_interval_ms, 50);
        assert_eq!(s.full_retry_ms, 100);
        assert_eq!(s.backoff_ms, 50);
        assert_eq!(s.lead_ms, 5_000);
        assert_eq!(s.max_polls, 1);
        // 退避上限不得低于基数，否则退避会越退越快
        let s = GrabSettings {
            backoff_ms: 9000,
            max_backoff_ms: 100,
            ..Default::default()
        }
        .sanitized();
        assert!(s.max_backoff_ms >= s.backoff_ms);
    }

    /// 「快」是用户能调的，但**默认值不许偷偷变快** ——
    /// 放开钳位只回答「能调到多少」，不回答「默认多快」。
    #[test]
    fn loosening_the_floor_does_not_speed_up_the_default() {
        let d = GrabSettings::default();
        let s = d.clone().sanitized();
        assert_eq!(
            s.min_interval_ms, d.min_interval_ms,
            "默认值本身就落在钳位区间内"
        );
        assert_eq!(s.poll_interval_ms, d.poll_interval_ms);
        assert_eq!(s.full_retry_ms, d.full_retry_ms);
        // 默认仍然是「一个学生抢几门课」的节奏，不是压测出来的那档
        assert_eq!(d.min_interval_ms, 700);
        assert_eq!(d.poll_interval_ms, 2000);
        assert_eq!(d.full_retry_ms, 5000);
    }

    /// 教学班 id 的类型必须原样往返：教务回 `317844` 而我们发 `"317844"` 是两种东西。
    #[test]
    fn lesson_id_json_roundtrip_keeps_the_scalar_type() {
        let conn = db();
        let acct = account(&conn);
        for id in [serde_json::json!(317844), serde_json::json!("65535")] {
            let tid = insert_task(
                &conn,
                acct,
                "77",
                Some("正选"),
                &input(id.clone()),
                "predicate",
                Some("2026-09-17 08:00:00"),
                Some("2026-09-17 23:59:59"),
            )
            .unwrap();
            let t = load_task(&conn, tid).unwrap().unwrap();
            assert_eq!(t.lesson_id, id, "教学班 id 的类型必须原样保留");
            assert_eq!(t.schedule_group_id, Some(serde_json::json!(9)));
            assert_eq!(t.virtual_cost, Some(30));
            assert_eq!(t.course_name.as_deref(), Some("高等数学（上）"));
            assert_eq!(t.status, GRAB_WAITING);
            assert_eq!(t.window_wall.as_deref(), Some("2026-09-17 08:00:00"));
            assert_eq!(t.window_end_wall.as_deref(), Some("2026-09-17 23:59:59"));
            // 入队即「已到点」：窗口闸门由 window_wall 单独把守，next_at 不该也跟着往后推
            assert!(t.next_at > 0);
        }
    }

    #[test]
    fn active_tasks_exclude_paused_and_finished() {
        let conn = db();
        let acct = account(&conn);
        let a = insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(1)),
            "direct",
            None,
            None,
        )
        .unwrap();
        let b = insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(2)),
            "direct",
            None,
            None,
        )
        .unwrap();
        set_status(&conn, b, GRAB_SUCCESS).unwrap();
        let paused = insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(3)),
            "direct",
            None,
            None,
        )
        .unwrap();
        set_status(&conn, paused, GRAB_PAUSED).unwrap();

        let active = load_active_tasks(&conn, acct).unwrap();
        assert_eq!(active.len(), 1, "只有真正在抢的任务才该被引擎推进");
        assert_eq!(active[0].id, a);
        // 但界面上三行都要看得到，且未结束的排在前面
        let all = load_tasks(&conn, acct).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].id, paused);
    }

    #[test]
    fn clear_finished_keeps_the_running_ones() {
        let conn = db();
        let acct = account(&conn);
        insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(1)),
            "direct",
            None,
            None,
        )
        .unwrap();
        let done = insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(2)),
            "direct",
            None,
            None,
        )
        .unwrap();
        set_status(&conn, done, GRAB_FAILED).unwrap();

        assert_eq!(clear_finished(&conn, acct).unwrap(), 1);
        assert_eq!(load_tasks(&conn, acct).unwrap().len(), 1);
    }

    /// 暂停/取消必须真的让引擎停手 —— 用户在抢课途中反悔是常事。
    #[test]
    fn park_keeps_a_paused_family_intact() {
        let conn = db();
        let acct = account(&conn);
        let id = insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(1)),
            "direct",
            None,
            None,
        )
        .unwrap();
        let mut t = load_task(&conn, id).unwrap().unwrap();
        t.status = GRAB_RUNNING.into();
        save_task(&conn, &t).unwrap();

        park(
            &conn,
            &t,
            now_ms() + 5000,
            "教务会话已过期",
            Verdict::SessionLost,
        )
        .unwrap();
        let parked = load_task(&conn, id).unwrap().unwrap();
        assert_eq!(parked.status, GRAB_WAITING);
        assert_eq!(parked.strike_kind.as_deref(), Some("session"));
        assert_eq!(parked.strikes, 1);
        // 同类再停一次 → 累加
        park(
            &conn,
            &parked,
            now_ms() + 5000,
            "教务会话已过期",
            Verdict::SessionLost,
        )
        .unwrap();
        assert_eq!(load_task(&conn, id).unwrap().unwrap().strikes, 2);
        // 换种类 → 重新计数
        park(&conn, &parked, now_ms(), "人数已满", Verdict::Full).unwrap();
        let after = load_task(&conn, id).unwrap().unwrap();
        assert_eq!(after.strikes, 1);
        assert_eq!(after.strike_kind.as_deref(), Some("full"));
    }

    /// 设置坏掉不该让引擎停下 —— 抢课期间任何「因为配置有问题所以不抢了」都是不可接受的。
    #[test]
    fn broken_settings_fall_back_to_defaults() {
        let conn = db();
        write_meta(&conn, SETTINGS_KEY, "{ 这不是 json").unwrap();
        let s = load_settings(&conn).unwrap();
        assert_eq!(s.poll_interval_ms, GrabSettings::default().poll_interval_ms);

        // 存进去的必须是收口后的值（下限 10ms —— 见 `GrabSettings::sanitized`）
        save_settings(
            &conn,
            &GrabSettings {
                min_interval_ms: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(load_settings(&conn).unwrap().min_interval_ms, 10);
        // 0 或负数会让节流闸门失效（不留间隙地连打），必须被夹上来
        save_settings(
            &conn,
            &GrabSettings {
                min_interval_ms: -5,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(load_settings(&conn).unwrap().min_interval_ms, 10);
    }

    #[test]
    fn skew_is_computed_in_one_reference_frame() {
        // 服务器说 08:00:00，而我本机此刻也正好是 08:00:00 → 偏差 0
        let at = wall_to_ms("2026-09-17 08:00:00").unwrap();
        assert_eq!(compute_skew("2026-09-17 08:00:00", at), Some(0));
        // 服务器说 08:00:05，我本机是 08:00:00 → 服务器快 5 秒
        assert_eq!(compute_skew("2026-09-17 08:00:05", at), Some(5_000));
        assert_eq!(compute_skew("待定", at), None);
    }

    /// 偏差要**四舍五入**到秒：采样与读取之间总会过去几毫秒，
    /// 截断会让 11.999 秒显示成 11 秒 —— 对时用的数字不该系统性偏小。
    #[test]
    fn skew_seconds_round_instead_of_truncating() {
        assert_eq!(skew_secs(11_999), 12);
        assert_eq!(skew_secs(11_400), 11);
        assert_eq!(skew_secs(0), 0);
        assert_eq!(skew_secs(-11_999), -12);
        assert_eq!(skew_secs(-11_400), -11);
    }

    /// 全局节流闸门：两次请求之间必须真的隔开，这是防封的主要旋钮。
    #[test]
    fn pacer_enforces_a_global_minimum_interval() {
        let hub = GrabHub::default();
        // 从未发过请求 → 立刻可发
        assert_eq!(hub.pace_gap_ms(700), 0);
        hub.mark_request();
        let gap = hub.pace_gap_ms(700);
        assert!(gap > 0 && gap <= 700, "刚发完必须等一会，实际 {gap}");
        assert_eq!(hub.pace_gap_ms(0), 0);
    }

    /// 空任务表时引擎必须安静待命，不该报错也不该空转。
    #[test]
    fn snapshot_is_empty_and_calm_without_tasks() {
        let conn = db();
        let hub = GrabHub::default();
        let s = snapshot(&conn, &hub).unwrap();
        assert!(!s.active);
        assert!(s.tasks.is_empty());
        assert!(s.last_error.is_none());
        assert!(s.server_time.is_none());
    }

    #[test]
    fn snapshot_reports_activity_and_skew() {
        let conn = db();
        let acct = account(&conn);
        let hub = GrabHub::default();
        // 采样发生在 10 秒前（对齐到整秒，让偏差是精确的 12 秒），服务器比本机快 12 秒
        let at = (now_ms() / 1000) * 1000 - 10_000;
        let server_text = format_now(at + 12_000);
        write_meta(
            &conn,
            CLOCK_KEY,
            &serde_json::to_string(&(at, &server_text)).unwrap(),
        )
        .unwrap();
        insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(1)),
            "direct",
            None,
            None,
        )
        .unwrap();

        let s = snapshot(&conn, &hub).unwrap();
        assert!(s.active);
        assert_eq!(s.skew_sec, Some(12));
        assert_eq!(s.tasks.len(), 1);
        assert!(s.next_at.is_some());
        // 采样已过去 10 秒，推出来的「教务时间」必须跟着往前走 ——
        // 否则界面上的教务时钟会在两次采样之间停住不动
        assert!(
            s.server_time.as_deref().unwrap() > server_text.as_str(),
            "教务时间应当随真实时间推进，而不是停在采样那一刻"
        );
    }

    /* ─────────────────── 志愿组（互斥备选） ─────────────────── */

    /// 组内只有「当前志愿」能出手。分散出手在这里是负收益：全局节流本来一轮
    /// 只发一个请求，铺开只会让最想要的那门出手变慢。
    #[test]
    fn only_the_top_choice_of_a_group_fires() {
        let conn = db();
        let acc = account(&conn);
        // 故意乱序插入：判定必须靠 priority，而不是入库顺序
        let third = grouped(&conn, acc, "g1", 3);
        let first = grouped(&conn, acc, "g1", 1);
        let second = grouped(&conn, acc, "g1", 2);

        let mut lone = task(None, 0);
        lone.id = 9999;

        let s = GrabSettings::default();
        let now = now_ms();
        let all = vec![first.clone(), second.clone(), third.clone(), lone.clone()];

        assert!(armed(&first, &all, &s, now), "第 1 志愿该出手");
        assert!(!armed(&second, &all, &s, now), "第 2 志愿必须等");
        assert!(!armed(&third, &all, &s, now), "第 3 志愿必须等");
        assert!(armed(&lone, &all, &s, now), "不在组里的不受任何影响");
    }

    /// 中选即收组 —— 这是「不会同时抢到两门冲突课」的唯一保证。
    #[test]
    fn winning_a_group_cancels_its_siblings() {
        let conn = db();
        let acc = account(&conn);
        let first = grouped(&conn, acc, "g1", 1);
        let second = grouped(&conn, acc, "g1", 2);
        let other = grouped(&conn, acc, "g2", 1);

        let mut winner = second.clone();
        winner.status = GRAB_SUCCESS.into();
        save_task(&conn, &winner).unwrap();

        let n = close_group(&conn, &winner).unwrap();
        assert_eq!(n, 1, "只该收掉同组那一条，别的组不受牵连");

        let after = load_tasks(&conn, acc).unwrap();
        let by = |id: i64| after.iter().find(|t| t.id == id).unwrap().clone();
        assert_eq!(by(second.id).status, GRAB_SUCCESS, "中的那条不动");
        assert_eq!(by(first.id).status, GRAB_CANCELLED, "同组备选要被收掉");
        let msg = by(first.id).last_message.unwrap_or_default();
        assert!(msg.contains("第 2 志愿"), "要讲清是被谁抢先的：{msg}");
        assert_eq!(by(other.id).status, GRAB_WAITING, "别的组不该被牵连");
    }

    /// 第 1 志愿进终态后，第 2 志愿**下一轮自动**成为当前志愿 ——
    /// 这是算出来的，不是迁出来的，所以没有需要同步的中间状态。
    #[test]
    fn a_finished_choice_promotes_the_next() {
        let conn = db();
        let acc = account(&conn);
        let mut first = grouped(&conn, acc, "g1", 1);
        let second = grouped(&conn, acc, "g1", 2);
        let s = GrabSettings::default();
        let now = now_ms();

        assert!(!armed(&second, &[first.clone(), second.clone()], &s, now));

        // 冲突是终态（要去教务办免听，本地重试一万次也没用）→ 该轮到第 2 志愿
        finish(&mut first, GRAB_CONFLICT, "与已选课程时间冲突，请办理免听");
        let all = vec![first.clone(), second.clone()];
        assert!(!armed(&first, &all, &s, now), "终态的不再出手");
        assert!(
            armed(&second, &all, &s, now),
            "第 1 志愿没了，第 2 志愿该接手"
        );
    }

    /// 默认**死守**：满员再久也不让位。「让贤期限」是唯一能改变这件事的数，
    /// 而且让位是**可逆**的 —— 后面志愿也没戏时，前面的要能回来。
    #[test]
    fn cede_deadline_is_off_by_default() {
        let conn = db();
        let acc = account(&conn);
        let mut first = grouped(&conn, acc, "g1", 1);
        let second = grouped(&conn, acc, "g1", 2);
        // 已经在满员上卡了一整天
        first.stuck_since = Some(now_ms() - 86_400_000);

        let s = GrabSettings::default();
        assert_eq!(s.cede_after_ms, 0, "默认必须是死守");
        let all = vec![first.clone(), second.clone()];
        assert!(armed(&first, &all, &s, now_ms()), "死守：不许因为满员让位");
        assert!(!armed(&second, &all, &s, now_ms()));

        // 把期限调出来才让位
        let ceded = GrabSettings {
            cede_after_ms: 180_000,
            ..s
        };
        assert!(!armed(&first, &all, &ceded, now_ms()), "过了期限该让位");
        assert!(
            armed(&second, &all, &ceded, now_ms()),
            "让位后第 2 志愿接手"
        );

        // 后面也没成 → 前面那位回到出手位（它一直是非终态，没被写死）
        let mut second_done = second.clone();
        second_done.status = GRAB_FAILED.into();
        let all = vec![first.clone(), second_done];
        assert!(
            armed(&first, &all, &ceded, now_ms()),
            "后面没戏了，前面的该回来"
        );
    }

    /// 没有 group_key（或空串）= 独立任务，行为与加志愿组之前**完全一致**。
    #[test]
    fn independent_tasks_are_unaffected() {
        let conn = db();
        let acc = account(&conn);
        let a = grouped(&conn, acc, "", 0);
        let b = grouped(&conn, acc, "", 0);
        assert!(group_of(&a).is_none(), "空组名按「不在组里」处理");

        let s = GrabSettings::default();
        let now = now_ms();
        let all = vec![a.clone(), b.clone()];
        assert!(armed(&a, &all, &s, now));
        assert!(armed(&b, &all, &s, now), "两个独立任务互不压制");

        // 中选也不该去收谁
        let mut winner = a.clone();
        winner.status = GRAB_SUCCESS.into();
        save_task(&conn, &winner).unwrap();
        assert_eq!(close_group(&conn, &winner).unwrap(), 0);
        let after = load_tasks(&conn, acc).unwrap();
        assert_eq!(
            after.iter().find(|t| t.id == b.id).unwrap().status,
            GRAB_WAITING
        );
    }

    /// 志愿组字段是**落库**的（不像 fire_at / held_by 那样是派生值）。
    #[test]
    fn group_fields_round_trip_through_sqlite() {
        let conn = db();
        let acc = account(&conn);
        let t = grouped(&conn, acc, "g1", 2);
        let back = load_task(&conn, t.id).unwrap().unwrap();
        assert_eq!(back.group_key.as_deref(), Some("g1"));
        assert_eq!(back.group_name.as_deref(), Some("体育组"));
        assert_eq!(back.priority, 2);
        assert!(back.held_by.is_none(), "held_by 是派生值，不落库");
    }

    /// 快照里的 `held_by` 只标给**还在场上**的成员。
    ///
    /// 这条是真在浏览器里看出来的：终态的第 1 志愿也挂着「等第 2 志愿」，
    /// 于是界面上一条已经出局的任务看起来还在排队。派生的意思是「现在谁压着你」，
    /// 出局的人没有被谁压着。
    #[test]
    fn held_by_skips_tasks_that_are_out_of_play() {
        let conn = db();
        let acc = account(&conn);
        let hub = GrabHub::default();
        let mut loser = grouped(&conn, acc, "g1", 1);
        let winner = grouped(&conn, acc, "g1", 2);
        // 第 1 志愿已经出局（时间冲突），第 2 志愿接手
        finish(&mut loser, GRAB_CONFLICT, "与已选课程时间冲突");
        save_task(&conn, &loser).unwrap();

        let s = snapshot(&conn, &hub).unwrap();
        let by = |id: i64| s.tasks.iter().find(|t| t.id == id).unwrap().clone();
        assert!(by(loser.id).held_by.is_none(), "出局的不该被标成在等谁");
        assert!(
            by(winner.id).held_by.is_none(),
            "接手的那个是当前志愿，也不被谁压着"
        );
    }

    /// 「连续满员了多久」只由满员维护：同一状态要保住起点，换了失败种类就清零。
    /// 让贤期限读的就是它 —— 起点被反复重置的话，期限永远不会到。
    #[test]
    fn stuck_since_tracks_continuous_fullness() {
        let s = GrabSettings::default();
        let mut t = task(None, 0);
        assert!(t.stuck_since.is_none());

        absorb_error(&mut t, &s, "教学班人数已满".into(), 0);
        let started = t.stuck_since.expect("满员要记下起点");

        absorb_error(&mut t, &s, "剩余名额不足".into(), 0);
        assert_eq!(t.stuck_since, Some(started), "持续满员不许把起点往后挪");

        absorb_error(&mut t, &s, "选课接口失败：HTTP 503".into(), 0);
        assert!(t.stuck_since.is_none(), "换了失败种类就不再是「一直满员」");
    }

    /// 字符串型的 id 不许被加上 JSON 引号 —— 前端 `idOf()` 用的是 `String(v)`，
    /// 两边必须在同一个表示上，否则 `probe_windows` 永远匹配不到自己的批次。
    #[test]
    fn opaque_ids_lose_their_json_quotes() {
        assert_eq!(matcher::id_text(&serde_json::json!(317844)), "317844");
        assert_eq!(matcher::id_text(&serde_json::json!("317844")), "317844");
        assert_eq!(matcher::id_text(&serde_json::json!(null)), "null");
    }

    /* ─────────────────── 计划（意向） ─────────────────── */

    fn lesson(id: i64, code: &str, name: &str) -> CourseSelectLesson {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "course": { "id": id * 10, "code": code, "nameZh": name },
            "stdCount": 10,
            "limitCount": 20,
        }))
        .unwrap()
    }

    fn intent(query: &str) -> GrabIntent {
        GrabIntent {
            id: 1,
            turn_id: None,
            turn_name: None,
            query: query.into(),
            mode: "predicate".into(),
            spread: false,
            status: INTENT_PENDING.into(),
            group_keys: Vec::new(),
            candidates: Vec::new(),
            last_message: None,
            attempts: 0,
            next_at: 0,
            created_at: 0,
            resolved_at: None,
        }
    }

    fn brief(id: &str, allow_enter: bool) -> GrabTurnBrief {
        GrabTurnBrief {
            id: id.into(),
            name: Some(format!("批次{id}")),
            allow_enter,
            select_text: None,
            window_start: None,
            window_end: None,
        }
    }

    /// 分堆是这套解析的语义核心：
    /// 默认「任意一个班都行」（全合成一组，只中一个），`spread` 才是「每门课各来一个」。
    /// 已选过的班必须排除 —— 引擎不该再对已经在名下的课动手。
    #[test]
    fn plan_groups_splits_by_course_only_when_asked() {
        let ls = vec![
            lesson(1, "000001", "高等数学（上）"),
            lesson(2, "000001", "高等数学（上）"),
            lesson(3, "000002", "大学英语（一）"),
        ];
        let hits = matcher::match_lessons_relaxed("学", &ls).hits;
        assert_eq!(hits.len(), 3, "三个班都该被这句查询命中");

        // 默认：合成一组，它们互为备选
        let g = plan_groups(&hits, false);
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].len(), 3);

        // spread：按课程分堆；同一门课的两个班仍在一堆里（只中一个）
        let g = plan_groups(&hits, true);
        assert_eq!(g.len(), 2, "命中的是两门课，就该两堆");
        let math = g
            .iter()
            .find(|grp| grp.iter().any(|h| h.lesson.id == serde_json::json!(1)))
            .expect("高数那一堆要在");
        assert_eq!(math.len(), 2, "同一门课的多个班必须留在同一组里");
        assert!(
            math[0].score >= math[1].score,
            "组内按「谁先值得出手」排好序"
        );

        // 已经选上的班不再排进任务
        let mut picked = ls.clone();
        picked[0].selected_lesson =
            Some(serde_json::from_value(serde_json::json!({ "status": "已选中" })).unwrap());
        let hits = matcher::match_lessons_relaxed("学", &picked).hits;
        let g = plan_groups(&hits, false);
        assert_eq!(g[0].len(), 2, "已选过的教学班必须排除");
    }

    /// 计划的批次选择：指定的优先，**指定了但没出现就什么都别做**。
    /// 「我排的是 A 轮，引擎跑去 B 轮抢」比抢不到更难查，所以绝不自动换批次。
    #[test]
    fn intent_picks_its_turn_and_never_switches_silently() {
        let briefs = vec![brief("9", false), brief("77", true)];

        let mut i = intent("高数");
        assert_eq!(
            pick_turn(i.turn_id.as_deref(), &briefs).unwrap().id,
            "77",
            "没指定就用当前可进入的那个"
        );

        i.turn_id = Some("77".into());
        assert_eq!(pick_turn(i.turn_id.as_deref(), &briefs).unwrap().id, "77");
        i.turn_id = Some("404".into());
        assert!(
            pick_turn(i.turn_id.as_deref(), &briefs).is_none(),
            "指定的批次没出现就只能等"
        );

        // 都不允许进入时退到第一个：至少能把名字与窗口显示出来
        let none_enter = vec![brief("9", false), brief("77", false)];
        let j = intent("高数");
        assert_eq!(
            pick_turn(j.turn_id.as_deref(), &none_enter).unwrap().id,
            "9"
        );
    }

    /// 计划是**落库**的：进程重启后它还认得自己排了什么，而「还没解析」的计划
    /// 必须每分钟被引擎捞起来重试 —— 用户排的是明天早上十点的事。
    #[test]
    fn intents_round_trip_and_only_pending_ones_are_due() {
        let conn = db();
        let acc = account(&conn);
        let id = insert_intent(
            &conn,
            acc,
            Some("77"),
            Some("正选"),
            "高数 张",
            "predicate",
            false,
        )
        .unwrap();
        let mut i = load_intent(&conn, id).unwrap().unwrap();
        assert_eq!(i.query, "高数 张");
        assert_eq!(i.status, INTENT_PENDING);
        assert_eq!(i.next_at, 0, "新计划必须立刻可解析");
        assert!(load_due_intent(&conn, acc, now_ms()).unwrap().is_some());

        // 解析完成 → 不再自动重解析（要重来是用户按「重新解析」）
        i.status = INTENT_READY.into();
        i.group_keys = vec!["intent-1".into()];
        i.candidates = vec![GrabMatch {
            lesson_id: serde_json::json!(7),
            course_name: Some("高等数学（上）".into()),
            course_code: Some("000001".into()),
            teacher: Some("张伟".into()),
            std_count: Some(10),
            limit_count: Some(20),
            picked: false,
            fields: vec!["course".into()],
            lesson_name: None,
            minor_name: None,
        }];
        i.resolved_at = Some(now_ms());
        save_intent(&conn, &i).unwrap();
        assert!(load_due_intent(&conn, acc, now_ms()).unwrap().is_none());

        let back = load_intent(&conn, id).unwrap().unwrap();
        assert_eq!(back.group_keys, vec!["intent-1".to_string()]);
        assert_eq!(
            back.candidates[0].course_name.as_deref(),
            Some("高等数学（上）")
        );
        assert!(back.candidates[0].teacher.is_some());

        reset_intent(&conn, id).unwrap();
        assert!(load_due_intent(&conn, acc, now_ms()).unwrap().is_some());

        // 移除计划要**连它派出去的任务一起收**：只删计划会留下「计划没了、课还在抢」
        let t = grouped(&conn, acc, "intent-1", 1);
        delete_intent(&conn, id).unwrap();
        assert!(load_intent(&conn, id).unwrap().is_none());
        assert_eq!(
            load_task(&conn, t.id).unwrap().unwrap().status,
            GRAB_CANCELLED
        );
    }

    /// 坏 JSON 不该让整份快照失败：一条计划的候选清单烂掉，界面宁可少显示，
    /// 也不能整个抢课面板空掉。
    #[test]
    fn broken_intent_json_degrades_to_empty_lists() {
        let conn = db();
        let acc = account(&conn);
        let id = insert_intent(&conn, acc, None, None, "体育", "direct", true).unwrap();
        conn.execute(
            "UPDATE campus_grab_intents SET candidates = '不是 JSON', group_keys = '{' WHERE id = ?1",
            [id],
        )
        .unwrap();
        let hub = GrabHub::default();
        let s = snapshot(&conn, &hub).unwrap();
        assert_eq!(s.intents.len(), 1);
        assert!(s.intents[0].candidates.is_empty());
        assert!(s.intents[0].group_keys.is_empty());
    }

    /// 两边都受理时要说「两个域都已提交」—— 否则用户看到一条受理号，
    /// 会以为只有一个域在打，另一条单子就成了他不知道存在的悬空请求。
    #[test]
    fn both_domains_accepted_is_said_out_loud() {
        let s = dual_suffix(true, true, "将向 2 个域同时发送");
        assert!(s.contains("两个域都已提交"), "实际：{s}");
    }

    /// 有第二个域、但这次没拿到它的受理号 —— 必须明说「只跟踪主域」，
    /// 不能因为「反正主域成了」就闭嘴：另一条到底发没发、跟不跟，用户有权知道。
    #[test]
    fn mirror_without_receipt_says_only_primary_is_tracked() {
        let s = dual_suffix(true, false, "将向 2 个域同时发送");
        assert!(s.contains("只跟踪主域"), "实际：{s}");
    }

    /// **最关键的一条**：探测到另一个域没有 EAMS5 时我们**故意不发**。
    /// 那就必须把原因说出来 —— 静默跳过比发错更糟，用户会以为两边都在打。
    /// （`mirror_note` 曾经是个只写不读的死字段，这个断言就是防它再变回去。）
    #[test]
    fn a_skipped_domain_always_carries_its_reason() {
        let note = "https://bkjw.guet.edu.cn 未发送：该域没有 EAMS5，发过去只会 404，已跳过";
        let s = dual_suffix(false, false, note);
        assert!(s.contains("bkjw.guet.edu.cn"), "必须点名是哪个域：{s}");
        assert!(s.contains("404"), "必须说清为什么不发：{s}");
    }

    /// 只有一个域可用、且没有第二个候选时，不要凭空添一句废话。
    #[test]
    fn a_single_domain_without_a_note_stays_quiet() {
        assert!(dual_suffix(false, false, "").is_empty());
    }

    /* ───── 受理单：占位单问 predicate-response，跨域单问对侧的域 ───── */

    /// 占位单必须问 `predicate-response`。
    ///
    /// 这是**真出过的 bug**：判据写成了「`needs_predicate` 为真时才是占位单」，
    /// 而占位一交 `predicate_done` 就为真、`needs_predicate` 随即变假 —— 于是手里
    /// 握着占位单却去问 `add-drop-response`。那个接口不认识占位号，永远回空，
    /// 任务空转到轮询上限才重投（默认 15 次 × 2 秒 = 半分钟），
    /// 而 `judge` 里那句「占位成功，正在正式确认」成了永远走不到的死分支。
    #[test]
    fn the_predicate_receipt_is_polled_on_the_predicate_endpoint() {
        let mut t = task(None, 0);
        // 入队：还没占位 → 这一步该去**交**占位，手里没有受理单
        assert!(needs_predicate(&t));
        assert!(!polls_predicate(&t), "还没交占位时手里没有单子");

        // 占位刚交上：**这就是那个 bug 的窗口期** —— attempts 仍是 0
        t.predicate_done = true;
        t.phase = PHASE_POLL.into();
        t.request_id = Some("gp1".into());
        assert!(!needs_predicate(&t), "占位交过之后不再补占位");
        assert!(
            polls_predicate(&t),
            "手里握着的是占位单，该问 predicate-response"
        );

        // 占位落定 → 正式提交：此后手里换成正式单
        t.attempts = 1;
        t.request_id = Some("gr1".into());
        assert!(!polls_predicate(&t), "正式提交过就该问 add-drop-response");

        // 直接模式从不占位，也就永远没有占位单
        let mut d = task(None, 0);
        d.mode = "direct".into();
        d.predicate_done = true;
        assert!(!polls_predicate(&d));

        // 用户点「重新排队」后占位标记归零：下一轮又该先交占位
        let mut again = task(None, 0);
        again.predicate_done = false;
        again.attempts = 0;
        assert!(needs_predicate(&again) && !polls_predicate(&again));
    }

    /// 主域被拒、镜像域受理成功时，必须跟踪**镜像域那条**，并且记住它在镜像域上。
    #[test]
    fn a_mirror_receipt_remembers_which_domain_it_belongs_to() {
        // 主域有号 → 跟踪主域；镜像那条记在 other 上
        let r = pick_receipt("p1", "m1").unwrap();
        assert_eq!(r.rid, "p1");
        assert_eq!(r.domain, RidDomain::Primary);
        assert_eq!(r.other.as_deref(), Some("m1"));

        // 主域没有号（被拒）→ 跟踪镜像域的，且**必须标记成镜像域**
        let r = pick_receipt("", "m1").unwrap();
        assert_eq!(r.rid, "m1");
        assert_eq!(r.domain, RidDomain::Mirror, "拿镜像的号去问主域永远问不到");
        assert!(r.other.is_none());

        // 两边都没号 → 没有可跟踪的受理单
        assert!(pick_receipt("", "").is_none());
    }

    /// 记到任务上的三件事：受理号、另一条单子、**它属于哪个域**。
    #[test]
    fn recording_a_receipt_writes_the_domain_down() {
        let mut t = task(None, 0);
        let r = pick_receipt("", "m1").unwrap();
        record_receipt(&mut t, &r);
        assert_eq!(t.request_id.as_deref(), Some("m1"));
        assert!(t.request_on_mirror(), "镜像域的受理单必须被标出来");

        // 换成主域的受理单：标记要跟着清掉，否则下一次轮询还去问镜像域
        let r = pick_receipt("p1", "").unwrap();
        record_receipt(&mut t, &r);
        assert!(!t.request_on_mirror());
        assert!(t.mirror_request_id.is_none());
    }

    /// 这一列要真的落库：引擎重启后仍得知道该拿哪张号去问哪个域。
    #[test]
    fn request_domain_round_trips_through_sqlite() {
        let conn = db();
        let acct = account(&conn);
        let id = insert_task(
            &conn,
            acct,
            "77",
            None,
            &input(serde_json::json!(1)),
            "predicate",
            None,
            None,
        )
        .unwrap();
        let mut t = load_task(&conn, id).unwrap().unwrap();
        assert!(!t.request_on_mirror(), "老数据没有这一列，一律按主域处理");

        t.request_id = Some("m9".into());
        t.request_domain = Some(REQUEST_DOMAIN_MIRROR.into());
        save_task(&conn, &t).unwrap();
        assert!(load_task(&conn, id).unwrap().unwrap().request_on_mirror());
    }

    /* ───── 时钟偏差：区间交集把「整秒截断」那一秒收掉 ───── */

    /// 一次采样在测试里的参照系：`skew` 为真实偏差，`p` 为服务器处理点（往返中的位置）。
    fn clock_sample(t0: i64, skew: i64, p: i64, rtt: i64) -> (i64, i64, String) {
        let server_true = t0 + p + skew;
        let text_ms = server_true.div_euclid(1000) * 1000; // 教务只报到整秒
        (t0, t0 + rtt, format_now(text_ms))
    }

    /// 多次采样取交集：偏差必须被夹在区间里，且比单次采样宽达一秒的区间明显更窄。
    #[test]
    fn skew_intersection_beats_the_one_second_truncation() {
        const BASE: i64 = 1_800_000_000_000;
        const TRUE_SKEW: i64 = 250;
        // 五次采样：步长与往返都有抖动（真机如此），相位因此散开
        let samples: Vec<_> = (0..5i64)
            .map(|i| clock_sample(BASE + i * 137, TRUE_SKEW, 20 + i * 11, 60 + i * 23))
            .collect();

        let est = skew_from_samples(&samples).unwrap();
        assert_eq!(est.mode, "intersection");
        assert_eq!(est.samples, 5);
        assert!(
            TRUE_SKEW >= est.skew_ms - est.uncertainty_ms
                && TRUE_SKEW <= est.skew_ms + est.uncertainty_ms,
            "真值必须落在区间里：估计 {}±{}，真值 {TRUE_SKEW}",
            est.skew_ms,
            est.uncertainty_ms
        );
        assert!(
            est.uncertainty_ms < 500,
            "交集应当明显窄于单次采样的「一秒截断」：±{}ms",
            est.uncertainty_ms
        );

        // 单次采样的区间宽度≈1000+往返；样本越多只会更窄，不会更宽
        let one = skew_from_samples(&samples[..1]).unwrap();
        assert!(
            est.uncertainty_ms <= one.uncertainty_ms,
            "多采样不该比单采样更差：{} vs {}",
            est.uncertainty_ms,
            one.uncertainty_ms
        );
    }

    /// 单次采样（旧口径）**系统性偏小** —— 这才是必须换算法的理由：
    /// 偏差偏小 ⇒ `fire_at` 偏大 ⇒ 开火偏晚 ⇒ `lead_ms` 的提前量被吃掉一段。
    #[test]
    fn the_old_single_sample_clock_was_biased_late() {
        const BASE: i64 = 1_800_000_000_000;
        let (t0, _t1, text) = clock_sample(BASE, 900, 30, 60);
        let legacy = compute_skew(&text, t0).unwrap();
        assert!(legacy <= 900, "旧口径只会低估偏差：{legacy} ≤ 900");
        assert!(
            legacy < 900,
            "而且通常严格小 —— 低估多少完全取决于采样落在秒里的哪一刻"
        );
    }

    /// 交集为空（网络抖动太大 / 本机钟在采样期间被校正）时退化为最低 RTT 的中点估计，
    /// 但**不许返回 None**：抢课只求一个方向无偏的近似值，好过没有。
    #[test]
    fn a_broken_intersection_degrades_to_the_best_sample() {
        // 两条样本互相矛盾：服务器时间「往回走了」，交集必空
        let a = clock_sample(1_800_000_000_000, 5_000, 10, 40);
        let b = clock_sample(1_800_000_001_000, -5_000, 10, 40);
        let est = skew_from_samples(&[a, b]).unwrap();
        assert_eq!(est.mode, "min-rtt");
        assert!(est.uncertainty_ms >= 500, "退化后的精度不该被说成精确");
    }

    #[test]
    fn clock_estimates_never_panic_on_garbage() {
        assert!(skew_from_samples(&[]).is_none());
        assert!(skew_from_samples(&[(0, 0, "待定".into())]).is_none());
        // 响应早于请求（本机钟被校正过）：这条样本作废
        assert!(skew_from_samples(&[(10_000, 9_000, format_now(20_000))]).is_none());
    }

    /// 旧缓存（`[at, text]` 形状）必须还能读出来 —— 升级不该把已有的偏差丢掉。
    #[test]
    fn the_legacy_clock_cache_still_reads() {
        let at = 1_800_000_000_000i64;
        let legacy = serde_json::to_string(&(at, format_now(at + 5000))).unwrap();
        let (got_at, est) = read_clock(&legacy).expect("旧形状要认");
        assert_eq!(got_at, at);
        assert_eq!(est.skew_ms, 5000);
        assert_eq!(est.mode, "legacy");
        assert_eq!(est.uncertainty_ms, 1000, "旧估计只有单次采样的精度");

        // 新形状（引擎现在写的）
        let fresh = serde_json::json!({
            "at_ms": at, "skew_ms": -320, "uncertainty_ms": 25, "samples": 4,
            "mode": "intersection", "text": format_now(at)
        });
        let (got_at, est) = read_clock(&fresh.to_string()).unwrap();
        assert_eq!(got_at, at);
        assert_eq!(est.skew_ms, -320);
        assert_eq!(est.uncertainty_ms, 25);
        assert_eq!(est.samples, 4);

        assert!(read_clock("不是 JSON").is_none());
        assert!(read_clock("{}").is_none());
    }

    /* ───── 满员重投：窗口内按节流节奏，窗口外维持慢节奏 ───── */

    /// 窗开着 / 没开 / 已关的三种任务。
    fn window_task(open_offset_min: i64, close_offset_min: i64) -> GrabTask {
        let wall = |min: i64| {
            (Local::now() + chrono::Duration::minutes(min))
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        };
        let mut t = task(None, 1);
        t.window_wall = Some(wall(open_offset_min));
        t.window_end_wall = Some(wall(close_offset_min));
        t
    }

    /// 窗口**开着**时满员：冷却按「节流间隔的两倍」走（默认 1400ms），而不是 5 秒一次 ——
    /// 后者等于每 5 秒才看一眼名额池，退课后最容易被别人先接走。
    ///
    /// **冷却必须长于节流间隔**：一样长的话，下一次心跳它又到点了，
    /// 组里永远轮不到别的候选（见 `REJECT_COOLDOWN_MS`）。
    #[test]
    fn full_retry_is_hot_while_the_window_is_open() {
        let s = GrabSettings::default();
        let mut t = window_task(-1, 120);
        assert!(window_open(&t, 0));
        absorb_error(&mut t, &s, "教学班人数已满".into(), 0);
        assert_eq!(t.status, GRAB_WAITING);
        let gap = t.next_at - now_ms();
        assert!(
            gap > s.min_interval_ms,
            "冷却（{gap}ms）必须长于节流间隔（{}ms），否则留不出换人的空档",
            s.min_interval_ms
        );
        assert!(
            gap <= REJECT_COOLDOWN_MS.max(s.min_interval_ms * 2) + 50,
            "窗口内的冷却该是「节流间隔的两倍」这一档，实际 {gap}ms"
        );
        let msg = t.last_message.clone().unwrap_or_default();
        assert!(msg.contains("已满"), "教务原话要留着：{msg}");
        assert!(msg.contains("窗口开放中"), "应对方式要说给用户听：{msg}");
    }

    /// 窗口还没开：维持 `full_retry_ms`。没有东西可抢时快打只是白费请求。
    #[test]
    fn full_retry_stays_slow_before_the_window_opens() {
        let s = GrabSettings::default();
        let mut t = window_task(10, 120);
        assert!(!window_open(&t, 0));
        absorb_error(&mut t, &s, "教学班人数已满".into(), 0);
        let gap = t.next_at - now_ms();
        assert!(
            gap >= s.full_retry_ms - 50,
            "窗口外不该提速，实际 {gap}ms"
        );
        assert!(!t
            .last_message
            .clone()
            .unwrap_or_default()
            .contains("窗口开放中"));
    }

    /// 窗口已经关了 / 压根不知道窗口：都不算「开着」，按慢节奏。
    #[test]
    fn a_closed_or_unknown_window_is_not_open() {
        let closed = window_task(-120, -5);
        assert!(!window_open(&closed, 0), "已关闭的窗口不算开放");

        let unknown = task(None, 1);
        assert!(!window_open(&unknown, 0), "不知道窗口时按没开处理");
        assert!(
            !window_open(&unknown, 60_000),
            "时钟偏差再大也不该把「未知」变成「开放」"
        );
    }

    /* ───── 真机联调（默认忽略） ───── */

    /// 用真实教务核对**区间交集偏差估计**到底能收到多准。
    ///
    /// 这是唯一必须打真服务器才能验证的东西：单测只能验算法，验不了
    /// 「教务的秒到底怎么截断、往返抖成什么样」—— 而那两件事决定了开火时刻的精度。
    ///
    /// ```text
    /// $env:REIN_GUET_USER='2600xxxxxx'; $env:REIN_GUET_PASS='...'
    /// cargo test --lib campus::grab::tests::live -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "打真实教务系统，需要 REIN_GUET_USER / REIN_GUET_PASS"]
    fn live_clock_skew_estimate() {
        use crate::modules::campus::adapters::base::CampusAdapter;
        use crate::modules::campus::adapters::supwisdom::SupwisdomAdapter;
        use crate::modules::campus::http::{CookieJar, Session};

        let (Ok(user), Ok(pass)) = (
            std::env::var("REIN_GUET_USER"),
            std::env::var("REIN_GUET_PASS"),
        ) else {
            println!("缺少 REIN_GUET_USER / REIN_GUET_PASS，跳过");
            return;
        };
        let spec = crate::modules::campus::adapters::provider::spec("guet-supwisdom-eams5").unwrap();
        let host = spec.default_base_url;
        let mut session = Session::new(host, CookieJar::default());
        {
            let mut adapter = SupwisdomAdapter::new(spec, &mut session);
            let outcome = adapter.login(&user, &pass, "").expect("登录请求要能发出");
            assert!(outcome.ok, "EAMS 登录被拒：{:?}", outcome.message);
        }
        let client = CourseSelectClient::acquire(host, session.jar().clone()).expect("换取选课令牌");
        println!("✓ 选课令牌就绪");

        // 旧口径（单次采样、把整秒起点当本刻）作对照
        let one_at = now_ms();
        let one_text = client.server_time().expect("服务器时间");
        let one = compute_skew(&one_text, one_at).expect("解析服务器时间");

        let est = sample_skew(|| client.server_time()).expect("区间交集采样");
        println!("✓ 教务时间原文：{}", est.text);
        println!("  旧口径（单次采样）：{one}ms —— 系统性偏小，开火会偏晚");
        println!(
            "  区间交集：{}ms ±{}ms（{} 个样本，{}）",
            est.skew_ms, est.uncertainty_ms, est.samples, est.mode
        );

        assert!(est.samples >= 2, "至少要取到两个样本");
        assert_eq!(est.mode, "intersection", "真机上不该退化成最低 RTT 估计");
        assert!(
            est.uncertainty_ms <= 600,
            "交集精度应当明显优于「一秒截断」：±{}ms",
            est.uncertainty_ms
        );
        // 两种口径不该互相矛盾（差得离谱说明采样或解析哪里错了）
        assert!(
            (est.skew_ms - one).abs() <= 1500,
            "两种口径相差 {}ms，超出合理范围",
            (est.skew_ms - one).abs()
        );
    }

    /// 真机联调（默认忽略）：拿**当前真实开放批次**把「批次 → 教学班 → 模糊匹配 →
    /// 志愿组 → 开火时刻」这条解析链整条走一遍。
    ///
    /// 全是只读请求，**不发任何提交**。为什么值得单独一条：单测用的是合成名单，
    /// 验不了「教务此刻返回的字段我们认不认得、模糊匹配在**真实课名**上会挑出什么」——
    /// 真机上最容易坏的就是这一层（字段改名、课名写法变化）。
    ///
    /// ```text
    /// $env:REIN_GUET_USER='2600xxxxxx'; $env:REIN_GUET_PASS='...'
    /// cargo test --lib campus::grab::tests::live_grab -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "打真实教务系统，需要 REIN_GUET_USER / REIN_GUET_PASS"]
    fn live_grab_pipeline_resolves_real_lessons() {
        use crate::modules::campus::adapters::base::CampusAdapter;
        use crate::modules::campus::adapters::supwisdom::SupwisdomAdapter;
        use crate::modules::campus::http::{CookieJar, Session};

        let (Ok(user), Ok(pass)) = (
            std::env::var("REIN_GUET_USER"),
            std::env::var("REIN_GUET_PASS"),
        ) else {
            println!("缺少 REIN_GUET_USER / REIN_GUET_PASS，跳过");
            return;
        };
        let spec = crate::modules::campus::adapters::provider::spec("guet-supwisdom-eams5").unwrap();
        let host = spec.default_base_url;
        let mut session = Session::new(host, CookieJar::default());
        {
            let mut adapter = SupwisdomAdapter::new(spec, &mut session);
            let outcome = adapter.login(&user, &pass, "").expect("登录请求要能发出");
            assert!(outcome.ok, "EAMS 登录被拒：{:?}", outcome.message);
        }
        let client = CourseSelectClient::acquire(host, session.jar().clone()).expect("换取选课令牌");
        let students = client.students().expect("学生档案");
        let sid = students
            .first()
            .and_then(|s| s.get("id"))
            .and_then(|v| v.as_i64())
            .expect("学生 id");
        println!("✓ 选课令牌 + 学生 id={sid}");

        let turns = client.open_turns(sid).expect("开放批次");
        let briefs: Vec<GrabTurnBrief> = turns.iter().map(turn_brief).collect();
        println!("✓ 开放批次 {} 个", briefs.len());
        let Some(brief) = pick_turn(None, &briefs) else {
            println!("（当前没有可进入的批次 —— 窗口未开是常态，解析链跳过）");
            return;
        };
        println!(
            "  目标批次 {}「{}」窗口 {:?} ~ {:?}，allowEnter={}",
            brief.id,
            brief.name.clone().unwrap_or_default(),
            brief.window_start,
            brief.window_end,
            brief.allow_enter
        );

        // 教学班名单：与 `GrabHub::lessons_cached` 同一条查询（带 hasCount 才拿得到名额）
        let query = LessonQuery {
            has_count: Some(true),
            ..Default::default()
        };
        let lessons = client
            .query_lesson(sid, &brief.id, &query)
            .expect("教学班名单");
        println!("✓ 教学班 {} 个", lessons.len());
        assert!(!lessons.is_empty(), "可进入的批次里应当有教学班");

        // 用名单里第一门课的课程名走一遍模糊匹配与志愿组
        let first = lessons.first().unwrap();
        let name = matcher::course_name_of(first).expect("课程名");
        let hits = matcher::match_lessons_relaxed(&name, &lessons).hits;
        println!("  以「{name}」查询：命中 {} 个教学班", hits.len());
        assert!(!hits.is_empty(), "教务自己给的课名必须能命中它自己");

        // 名额：名单接口不回 `stdCount`，得单独问 `std-count`（补名额那条路）
        let ids: Vec<serde_json::Value> = hits.iter().map(|h| h.lesson.id.clone()).collect();
        let counts = client.std_count(&ids).expect("std-count 批量查人数");
        println!("  std-count 回执 {} 条（请求 {} 个 id）", counts.len(), ids.len());
        assert!(!counts.is_empty(), "std-count 应当能查到至少一个班的人数");
        for h in hits.iter().take(3) {
            let key = matcher::id_text(&h.lesson.id);
            let seat = counts
                .get(&key)
                .and_then(|c| c.seat_left(h.lesson.limit_count))
                .map(|n| format!("余 {n}"))
                .unwrap_or_else(|| "名额未知".into());
            println!(
                "    · {} / {} / id={key} —— {seat}",
                matcher::course_name_of(&h.lesson).unwrap_or_default(),
                matcher::teacher_text(&h.lesson).unwrap_or_default()
            );
        }

        // **放宽阶梯**（真机）：教务名单里查不到的词该被丢掉，而不是让整句查询白等一个窗口。
        // 用「无此条件」这种必然不存在的四字词 —— 两三个字会被人名形状保护起来（见 matcher 的红线）。
        let relaxed = matcher::match_lessons_relaxed(&format!("{name} 无此条件"), &lessons);
        println!(
            "  放宽阶梯：「{name} 无此条件」→ {:?}，丢掉 {:?}，命中 {}",
            relaxed.level,
            relaxed.dropped,
            relaxed.hits.len()
        );
        assert_eq!(
            relaxed.level,
            matcher::Relax::DropNoise,
            "查不到的词该被丢掉才对"
        );
        assert_eq!(relaxed.dropped, vec!["无此条件".to_string()]);
        assert!(!relaxed.hits.is_empty(), "丢掉噪声后应当仍然命中原课程");

        let groups = plan_groups(&matcher::preferred(&hits), false);
        let head = groups
            .first()
            .and_then(|g| g.first())
            .map(|h| {
                format!(
                    "{} / {} / id={}",
                    matcher::course_name_of(&h.lesson).unwrap_or_default(),
                    matcher::teacher_text(&h.lesson).unwrap_or_default(),
                    matcher::id_text(&h.lesson.id)
                )
            })
            .unwrap_or_default();
        println!("  志愿组 {} 组；首选：{head}", groups.len());
        assert_eq!(groups.len(), 1, "「中一个就够」的语义下只该有一组");

        // 开火时刻：窗口已公布时，闸门必须算得出来并落在窗口内
        if let Some(start) = brief.window_start.as_deref().filter(|s| !s.trim().is_empty()) {
            let skew = sample_skew(|| client.server_time())
                .map(|e| e.skew_ms)
                .unwrap_or(0);
            let mut t = GrabTask::blank();
            t.turn_id = brief.id.clone();
            t.window_wall = Some(start.to_string());
            t.window_end_wall = brief.window_end.clone();
            let at = fire_at_ms(&t, skew, GrabSettings::default().lead_ms).expect("有窗口就该有闸门");
            println!(
                "  开火时刻 {}（教务墙钟 {start}，偏差 {}ms，误差 ±{}ms）",
                format_now(at),
                skew,
                sample_skew(|| client.server_time())
                    .map(|e| e.uncertainty_ms)
                    .unwrap_or(0)
            );
            assert_ne!(at, GATE_UNKNOWN, "窗口已公布，闸门不该未知");
            if !window_closed(&t, skew) {
                assert!(
                    at <= now_ms() + 60_000,
                    "窗口已开放时开火时刻不该还在遥远未来：{}",
                    format_now(at)
                );
            }
        }
        println!("✓ 解析链联调通过（全程只读，未发送任何提交）");
    }

    /* ───── 真机写链路（默认忽略，**会真的选上一门课再退掉**） ───── */

    /// 一条教学班身上的 id（教务给 `id`，别处也见过 `lessonId` 等写法）。
    fn id_of(v: &serde_json::Value) -> Option<String> {
        ["id", "lessonId", "lessonAssoc", "lesson_id"]
            .iter()
            .filter_map(|k| v.get(*k))
            .map(matcher::id_text)
            .next()
    }

    /// 把引擎的一步一步推完（测试内部用）：`submit` 与 `poll` 交替，直到终态、
    /// 或已经正式提交过两次（满员的课没必要在这里守着）。
    ///
    /// 用的是**引擎自己的函数**（`submit`/`poll`/`judge`/`absorb_error`），
    /// 所以这条测试验的是真引擎的状态机，不是另写一遍的近似品。
    fn drive_to_rest(
        ctx: &super::super::commands::SelectContext,
        settings: &GrabSettings,
        task: &mut GrabTask,
        skew_ms: i64,
        max_steps: usize,
    ) {
        for _ in 0..max_steps {
            if grab_is_terminal(&task.status) {
                return;
            }
            if task.status == GRAB_WAITING && task.attempts >= 2 {
                return;
            }
            let now = now_ms();
            if task.next_at > now {
                std::thread::sleep(Duration::from_millis((task.next_at - now).min(1500) as u64));
            }
            if task.phase == PHASE_POLL && task.request_id.is_some() {
                poll(ctx, settings, task, skew_ms);
            } else {
                submit(ctx, settings, task, skew_ms);
            }
        }
    }

    /// 把这门课退掉，返回一句人话结果。**以 `selected-lessons` 为准**。
    ///
    /// 退课三步与选课对称：`drop-predicate` → 轮询 `predicate-response` →
    /// `drop-request` → 轮询 `add-drop-response`。
    ///
    /// **只退传进来的这一个教学班**（调用方只会传自己刚选上的那个）：
    /// 两个 body 里都只有这一个 id，绝不会有第二条 —— 用户原有的课一门都不许动。
    fn drop_now(
        ctx: &super::super::commands::SelectContext,
        turn: &str,
        lesson: &serde_json::Value,
    ) -> String {
        let ids = vec![lesson.clone()];
        let Some(want) = id_of(lesson) else {
            return "拿不到教学班 id，未退课".into();
        };
        let still_there = |note: String| -> String {
            let left = ctx
                .client
                .selected_lessons(turn, ctx.student_id)
                .map(|list| list.iter().filter_map(id_of).any(|id| id == want))
                .unwrap_or(true);
            if left {
                format!("{note}；这门课**仍在已选名单**里")
            } else {
                format!("{note}；已不在名单（退课成功）")
            }
        };

        let rid = match ctx.client.drop_predicate(ctx.student_id, turn, &ids) {
            Ok(r) => r,
            Err(e) => return still_there(format!("drop-predicate 失败：{e}")),
        };
        for _ in 0..5 {
            match ctx.client.predicate_response(ctx.student_id, &rid) {
                Ok(v) if !v.is_null() => break,
                Ok(_) => std::thread::sleep(Duration::from_millis(400)),
                Err(e) => {
                    println!("  （退课占位轮询失败：{e}）");
                    break;
                }
            }
        }
        let rid2 = match ctx
            .client
            .drop_request(ctx.student_id, turn, &ids, None, true)
        {
            Ok(r) => r,
            Err(e) => return still_there(format!("drop-request 失败：{e}")),
        };
        let mut last = serde_json::Value::Null;
        for _ in 0..8 {
            match ctx.client.add_drop_response(ctx.student_id, &rid2) {
                Ok(v) => {
                    last = v.clone();
                    if !v.is_null() {
                        break;
                    }
                }
                Err(e) => {
                    println!("  （退课结果轮询失败：{e}）");
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        let brief: String = last.to_string().chars().take(160).collect();
        still_there(format!("drop 受理结果 {brief}"))
    }

    /// 「免听重发」：对应前端免听弹窗里的**「免听」按钮**。
    ///
    /// **`needAttend` 是反的**（2026-09-22 从前端 i18n 逐字核对，别再凭直觉猜）：
    /// 弹窗两个按钮是 `resend:"免听"` → `resendOpeation(false)`、
    /// `noResend:"不免听"` → `resendOpeation(true)`，而 `resendOpeation(t)` 里做的是
    /// `e.needAttend = t` —— 也就是说：
    ///
    /// - 办免听（不需要出席）→ **`needAttend: false`**
    /// - 不免听（照常出席）  → `needAttend: true`
    ///
    /// 抢课项目里那份 `--auto-resend 带 needAttend=true` 正好写反了（它以为 true 是免听）。
    /// 真机上也能看出来：发 `true` 被回「时间冲突」—— 那正是「你要出席，可你冲堂」的意思。
    ///
    /// 引擎自己**不做**这一步（免听是「明知冲堂仍然要上」，该由人决定），
    /// 这条测试显式走一遍：课表排满的账号只有这一条路能选上课，
    /// 而「免听能不能被受理」本身也是写链路上值得验证的真实分支。
    fn resend_with_attend(
        ctx: &super::super::commands::SelectContext,
        task: &mut GrabTask,
        skew_ms: i64,
    ) -> bool {
        let items = vec![AddItem {
            lesson_assoc: task.lesson_id.clone(),
            virtual_cost: task.virtual_cost,
            schedule_group_assoc: task.schedule_group_id.clone(),
            need_attend: Some(false), // ← 「免听」（见上面那段：false 才是免听）
        }];
        let rid = match ctx
            .client
            .add_request(ctx.student_id, task.turn_assoc(), items, None)
        {
            Ok(r) => r,
            Err(e) => {
                println!("  （免听重发失败：{e}）");
                return false;
            }
        };
        for _ in 0..10 {
            match ctx.client.add_drop_response(ctx.student_id, &rid) {
                Ok(v) if !v.is_null() => {
                    let ok = v.get("success").and_then(|b| b.as_bool()).unwrap_or(false);
                    let msg = v
                        .get("errorMessage")
                        .and_then(|m| m.get("text"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    println!("  免听回执：success={ok} {msg}");
                    if ok {
                        task.status = GRAB_SUCCESS.into();
                        task.last_message = Some("免听选上".into());
                    }
                    return ok;
                }
                Ok(_) => std::thread::sleep(Duration::from_millis(600)),
                Err(e) => {
                    println!("  （免听结果轮询失败：{e}）");
                    return false;
                }
            }
        }
        println!("  （免听受理结果超时未回）");
        let _ = skew_ms;
        false
    }

    /// 真机联调（默认忽略）：**完整走一次真实提交**，确认选上后立刻退课。
    ///
    /// 这是唯一会写真实数据的测试：它会把这门课真的选上，再退掉。因此顺序刻意写成
    /// 「**先把课退掉，再做断言**」—— 中途 panic 不该把课留在名下。
    ///
    /// 目标课从教务自己的名单里挑：有余额、不在已选名单里、课程代码与已选不重复
    /// （同代码会直接被判「已选过」）。挑到的候选若被服务端按规则拒了（满员/冲突/额度），
    /// 就换下一个并如实打印教务的原话 —— 那是正常拒绝，不算失败；
    /// 但**参数错误**（`needs_ai`）说明请求写法有问题，那种必须报错。
    ///
    /// ```text
    /// $env:REIN_GUET_USER='2600xxxxxx'; $env:REIN_GUET_PASS='...'
    /// cargo test --lib campus::grab::tests::live_grab_submit -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "会真的选上一门课再退掉，只在明确要求时跑"]
    fn live_grab_submit_then_drop() {
        use crate::modules::campus::commands::SelectContext;
        use crate::modules::campus::adapters::base::CampusAdapter;
        use crate::modules::campus::adapters::supwisdom::SupwisdomAdapter;
        use crate::modules::campus::http::{CookieJar, Session};

        let (Ok(user), Ok(pass)) = (
            std::env::var("REIN_GUET_USER"),
            std::env::var("REIN_GUET_PASS"),
        ) else {
            println!("缺少 REIN_GUET_USER / REIN_GUET_PASS，跳过");
            return;
        };
        let spec = crate::modules::campus::adapters::provider::spec("guet-supwisdom-eams5").unwrap();
        let host = spec.default_base_url;
        let mut session = Session::new(host, CookieJar::default());
        {
            let mut adapter = SupwisdomAdapter::new(spec, &mut session);
            let outcome = adapter.login(&user, &pass, "").expect("登录请求要能发出");
            assert!(outcome.ok, "EAMS 登录被拒：{:?}", outcome.message);
        }
        let client = CourseSelectClient::acquire(host, session.jar().clone()).expect("换取选课令牌");
        let sid = client
            .students()
            .expect("学生档案")
            .first()
            .and_then(|s| s.get("id"))
            .and_then(|v| v.as_i64())
            .expect("学生 id");

        let turns = client.open_turns(sid).expect("开放批次");
        let briefs: Vec<GrabTurnBrief> = turns.iter().map(turn_brief).collect();
        let Some(brief) = pick_turn(None, &briefs) else {
            println!("（当前没有可进入的批次 —— 窗口未开时不该跑这条测试，跳过）");
            return;
        };
        println!("✓ 目标批次 {}「{}」", brief.id, brief.name.clone().unwrap_or_default());

        // 已选名单：挑候选时要避开（同代码会被判「已选过」，那是白跑）
        let selected = client
            .selected_lessons(&brief.id, sid)
            .unwrap_or_default();
        let selected_ids: Vec<String> = selected.iter().filter_map(id_of).collect();
        let selected_codes: Vec<String> = selected
            .iter()
            .filter_map(|v| {
                v.get("course")
                    .and_then(|c| c.get("code"))
                    .and_then(|c| c.as_str())
                    .map(str::to_string)
            })
            .collect();
        println!("✓ 已选 {} 门（候选要避开这些课程代码）", selected.len());

        // 候选：先用服务端的资格过滤（`canSelect`）取出「这个学生现在选得了」的班，
        // 再排掉已经选上的。引擎自己**不**用这个过滤（它要盯满员等退课），
        // 但这条测试要的是「一次能成功的提交」—— 不筛的话 448 个班里只有 12 个
        // 对本学生开放，绝大多数提交都会撞上「不符合选课条件组要求」。
        let eligible = client
            .query_lesson(
                sid,
                &brief.id,
                &LessonQuery {
                    has_count: Some(true),
                    can_select: Some(true),
                    ..Default::default()
                },
            )
            .expect("可选教学班名单");
        println!("✓ 教务说「这个学生现在选得了」的班：{} 个", eligible.len());
        let mut candidates: Vec<CourseSelectLesson> = eligible
            .iter()
            .filter(|l| !selected_ids.contains(&matcher::id_text(&l.id)))
            .filter(|l| {
                let code = l
                    .course
                    .as_ref()
                    .and_then(|c| c.code.clone())
                    .unwrap_or_default();
                !selected_codes.contains(&code)
            })
            .cloned()
            .collect();
        candidates.sort_by_key(|l| match (l.std_count, l.limit_count) {
            (Some(s), Some(lim)) => (0i64, -(lim - s)),
            _ => (1, 0),
        });
        let candidates: Vec<CourseSelectLesson> = candidates.into_iter().take(6).collect();
        println!(
            "✓ 候选 {} 个（可选、不在已选里、课程代码不重复）",
            candidates.len()
        );
        assert!(!candidates.is_empty(), "应至少挑得出一门可尝试的课");

        let ctx = SelectContext {
            client,
            student_id: sid,
            account_id: 0,
            mirror: None,
            mirror_note: String::new(),
        };
        // 轮询间隔按测试压缩（真机节奏不是这条测试要验的东西）
        let settings = GrabSettings {
            poll_interval_ms: 400,
            ..Default::default()
        };
        let skew = sample_skew(|| ctx.client.server_time())
            .map(|e| e.skew_ms)
            .unwrap_or(0);

        let mut rejected: Vec<String> = Vec::new();
        for cand in &candidates {
            let label = format!(
                "{} / {} / id={}",
                matcher::course_name_of(cand).unwrap_or_default(),
                matcher::teacher_text(cand).unwrap_or_default(),
                matcher::id_text(&cand.id)
            );
            let mut task = GrabTask::blank();
            task.turn_id = brief.id.clone();
            task.lesson_id = cand.id.clone();
            task.course_name = matcher::course_name_of(cand);
            task.teacher = matcher::teacher_text(cand);

            // **安全闸**：绝不碰用户原有的课。候选在挑选阶段已经排掉已选的，
            // 这里再钉一道 —— 这条测试会真选真退，搞错对象是不可接受的。
            assert!(
                !selected_ids.contains(&matcher::id_text(&cand.id)),
                "候选里混进了用户已经选上的课，拒绝继续：{label}"
            );

            drive_to_rest(&ctx, &settings, &mut task, skew, 24);
            let msg = task.last_message.clone().unwrap_or_default();
            println!(
                "  · {label} → {}（提交 {} 次）：{msg}",
                task.status, task.attempts
            );

            if task.status == GRAB_NEEDS_AI {
                panic!("提交被教务按**参数错误**拒绝，这是引擎（或请求体）的问题：{msg}");
            }
            // 时间冲突 = 免听分支（前端会弹「免听 / 不免听」）。课表排满的账号只有
            // 这一条路能选上课，所以这里显式走一遍「免听」，随后立刻退掉。
            if task.status == GRAB_CONFLICT {
                println!("  · 时间冲突 → 走免听重发（对应前端免听弹窗的「免听」）");
                if !resend_with_attend(&ctx, &mut task, skew) {
                    rejected.push(format!("{label}：免听未被受理（{msg}）"));
                    continue;
                }
            }
            if task.status != GRAB_SUCCESS {
                rejected.push(format!("{label}：{msg}"));
                continue;
            }

            // —— 抢到了。**先把课退掉，再做断言** ——
            let picked = verify_picked(&ctx, &task).unwrap_or(false);
            println!(
                "  ✓ 引擎判成功，复核 selected-lessons：{}",
                if picked { "在名单里" } else { "不在名单里" }
            );
            let drop_log = drop_now(&ctx, &brief.id, &task.lesson_id);
            println!("  · 退课：{drop_log}");

            // 收尾对账：**这门课必须回到原样，原有课程一门都不许少**。
            // 退课请求里从头到尾只有「刚选上那一个教学班」的 id（见 `drop_now`），
            // 这条断言就是把那个不变量钉在真机上。
            let after: Vec<String> = ctx
                .client
                .selected_lessons(&brief.id, sid)
                .unwrap_or_default()
                .iter()
                .filter_map(id_of)
                .collect();
            let missing: Vec<&String> = selected_ids
                .iter()
                .filter(|id| !after.contains(id))
                .collect();

            assert!(picked, "引擎判成功但 selected-lessons 里没有它（复核这一层要查）");
            assert!(
                drop_log.contains("退课成功"),
                "这门课可能还留在名下，请手动退课：{drop_log}"
            );
            assert!(
                missing.is_empty(),
                "原有课程不该被动过，但这些不见了：{missing:?}"
            );
            println!(
                "✓ 真机写链路联调通过：占位 → 逐条判词 → 正式提交 → 免听 → 复核 → 退课；\
                 原有 {} 门课完好",
                selected_ids.len()
            );
            return;
        }

        println!("（所有候选都被服务端按规则拒了，教务原话如下）");
        for line in &rejected {
            println!("  - {line}");
        }
        println!("这属于满员/冲突/额度一类的正常拒绝，不是引擎故障。");
        if rejected.is_empty() {
            panic!("一个候选都没试到 —— 候选筛选逻辑有问题");
        }
    }
}
