//! 校园教务域数据模型。
//!
//! 分两类：
//! - **远端类型**（`Remote*` / `Timetable*`）—— 教务系统 JSON 的逐字段映射，只做反序列化。
//!   刻意全部加 `#[serde(default)]`：教务系统会随版本增删字段，缺字段不该让整次同步失败。
//! - **本地类型**（`Campus*`）—— 落库后的形状，同时是前后端 IPC 的契约，与 `src/types/campus.ts` 一一对应。

use serde::{Deserialize, Serialize};

// ─────────────────────────── 远端：学期 ───────────────────────────

/// 课表页面里 `var semesters = JSON.parse("...")` 的元素。
///
/// 带 `Serialize` 是因为开课查询的回执要把它原样交给前端（学期选择器）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSemester {
    pub id: i64,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub name_en: Option<String>,
    #[serde(default)]
    pub school_year: Option<String>,
    /// `"2026-09-14"` —— 周次 → 公历日期的唯一锚点
    #[serde(default)]
    pub start_date: Option<String>,
    /// `"2027-01-24"`
    #[serde(default)]
    pub end_date: Option<String>,
    #[serde(default)]
    pub week_start_on_sunday: Option<bool>,
    #[serde(default)]
    pub season: Option<String>,
}

// ─────────────────────────── 远端：课表 ───────────────────────────

/// `courseType` / `examMode` 这类「带名字的引用对象」只需要中文名与代码。
///
/// `code` 是给「课程类型」用的（如 `BG` = 通识必修）—— 课表活动里它落在
/// `courseType.code`，正是教务网页上「课程类型」那一栏显示的值。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteNamed {
    #[serde(default)]
    pub name_zh: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
}

/// 课表活动里的 `periodInfo`：这门课一学期的**学时构成**。
///
/// 教务会给理论/实践/测试/实验/上机/设计/其它各项学时，用 `null` 表示「没有这项」。
/// 取 `Option<f64>` 而不是 `i64`：实测 `weeks` 会给 `16.0` 这种小数形态。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodInfo {
    #[serde(default)]
    pub total: Option<f64>,
    #[serde(default)]
    pub weeks: Option<f64>,
    #[serde(default)]
    pub theory: Option<f64>,
    #[serde(default)]
    pub practice: Option<f64>,
    #[serde(default)]
    pub test: Option<f64>,
    #[serde(default)]
    pub experiment: Option<f64>,
    #[serde(default)]
    pub machine: Option<f64>,
    #[serde(default)]
    pub design: Option<f64>,
    #[serde(default)]
    pub extra: Option<f64>,
}

/// `print-data` → `studentTableVms[0].activities[]`，一个元素 = **一门课的一个上课时段**。
///
/// 关键字段说明：
/// - `weekday` 1=周一 … 7=周日（教务口径）
/// - `week_indexes` 教学周序号（如 `[9,10,11,12]`），**不是公历周**
/// - `start_time` / `end_time` `"16:30"` / `"18:05"` —— 教务已经算好了本节次的真实时间，
///   我们不需要自己维护「第几节→几点」的表，这也是需求里「左侧列显示实际上课时间」的数据来源
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimetableActivity {
    #[serde(default)]
    pub lesson_id: Option<i64>,
    #[serde(default)]
    pub lesson_code: Option<String>,
    #[serde(default)]
    pub lesson_name: Option<String>,
    #[serde(default)]
    pub course_code: Option<String>,
    #[serde(default)]
    pub course_name: Option<String>,
    #[serde(default)]
    pub weeks_str: Option<String>,
    #[serde(default)]
    pub week_indexes: Vec<i64>,
    #[serde(default)]
    pub room: Option<String>,
    #[serde(default)]
    pub building: Option<String>,
    #[serde(default)]
    pub campus: Option<String>,
    #[serde(default)]
    pub weekday: Option<i64>,
    #[serde(default)]
    pub start_unit: Option<i64>,
    #[serde(default)]
    pub end_unit: Option<i64>,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub teachers: Vec<String>,
    #[serde(default)]
    pub course_type: Option<RemoteNamed>,
    #[serde(default)]
    pub credits: Option<f64>,
    /// 教务自带的课程配色（如 `#3B73B6`）。用它能让 App 里的课表和学生网页上看到的一致。
    #[serde(default)]
    pub bgc: Option<String>,

    // ── 以下仅课程详情使用（课表渲染不读） ─────────────────────────────
    /// 课程备注，教务对多数课给 `null`（界面上显示成「无备注」）
    #[serde(default)]
    pub lesson_remark: Option<String>,
    /// 课程容量（教学班上限）
    #[serde(default)]
    pub limit_count: Option<i64>,
    /// 已选人数
    #[serde(default)]
    pub std_count: Option<i64>,
    /// 分组号（合班 / 分组教学时才有）
    #[serde(default)]
    pub group_num: Option<i64>,
    /// 一门课的学时构成
    #[serde(default)]
    pub period_info: Option<PeriodInfo>,
}

/// `studentTableVms[0]`：一次课表拉取的完整结果。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentTableVm {
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub name: Option<String>,
    /// 学号
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub grade: Option<String>,
    #[serde(default)]
    pub department: Option<String>,
    #[serde(default)]
    pub major: Option<String>,
    #[serde(default)]
    pub adminclass: Option<String>,
    #[serde(default)]
    pub credits: Option<f64>,
    #[serde(default)]
    pub activities: Vec<TimetableActivity>,
    /// **已排课**的教学班详情。与 `activities` 是两份数据：
    /// `activities` 是「上课时段」（时间/地点/学时构成），这里才是「教学班」的教务档案
    /// （考试类别、课程属性、开课院系、实验/上机学时、容量、备注……）。课程详情的主要来源。
    ///
    /// 只建模详情页真正会读的字段 —— 教务这个对象有 80+ 个键，serde 会忽略未知键，
    /// 多映射一份没人读的字段只是维护负担。
    #[serde(default)]
    pub arranged_lesson_search_vms: Vec<ArrangedLessonSearchVm>,
}

/// `arrangedLessonSearchVms[]` —— 已排课教学班的**教务档案**（只映射详情页要用的键）。
///
/// 字段名逐字对齐教务：`id` = 教学班 id（与 `activity.lessonId` 同源），
/// `code` = 课号（与 `activity.lessonCode` 同源）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrangedLessonSearchVm {
    /// 教学班 id。教务给数字，但不能假设（`lesson_search` 就见过字符串形态）
    #[serde(default)]
    pub id: serde_json::Value,
    #[serde(default)]
    pub code: Option<String>,
    /// 教学班备注（多数课为空）
    #[serde(default)]
    pub remark: Option<String>,
    #[serde(default)]
    pub std_count: Option<i64>,
    #[serde(default)]
    pub limit_count: Option<i64>,
    /// 考试方式（`EXAM_MODE_UNIFICATION` → 「统一考试」）
    #[serde(default)]
    pub arrange_exam_type_zh: Option<String>,
    /// 考试类别（「考试」/「考查」）。**详情页「考试类别」那一栏就是它。**
    #[serde(default)]
    pub exam_mode: Option<RemoteNamed>,
    /// 课程类别（与 activity 上那份同源，这里信息更全）
    #[serde(default)]
    pub course_type: Option<RemoteNamed>,
    /// 课程属性（必修/选修…）
    #[serde(default)]
    pub course_property: Option<RemoteNamed>,
    /// 开课院系
    #[serde(default)]
    pub open_department: Option<RemoteNamed>,
    /// 实际实验 / 上机学时 —— 判断「是不是实验课」就看这两个
    #[serde(default)]
    pub actual_experiment_period: Option<f64>,
    #[serde(default)]
    pub actual_machine_period: Option<f64>,
}

impl ArrangedLessonSearchVm {
    /// 教学班 id 的数字形态（教务给数字；给不出当没有）。
    pub fn numeric_id(&self) -> Option<i64> {
        match &self.id {
            serde_json::Value::Number(n) => n.as_i64(),
            serde_json::Value::String(s) => s.trim().parse().ok(),
            _ => None,
        }
    }

    /// 是不是「实验课」：实验或上机学时大于 0。
    ///
    /// 判据用**实际学时**而不是课程名里有没有「实验」二字 —— 桂电有一类
    /// 「独立设置的实验课程」，看名字认不出来，看学时一认一个准。
    pub fn has_experiment(&self) -> bool {
        self.actual_experiment_period.unwrap_or(0.0) > 0.0
            || self.actual_machine_period.unwrap_or(0.0) > 0.0
    }
}

// ─────────────────────── 本地：课程详情（IPC 契约） ───────────────────────

/// 课程详情。**字段与教务网页「课程详情」页一一对应**，供前端整页展示。
///
/// 数据来自 `print-data` 的两处：`activities[]`（时段：时间/地点/周次）与
/// `arrangedLessonSearchVms[]`（教学班：容量/考试类别/学时…），外加学生的
/// `major` / `grade` 与学期名。组装逻辑集中在 `super::detail`，便于单测。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseDetail {
    /// 课程名称
    pub course_name: String,
    /// 课程代码（培养方案口径，如 `000011`）
    pub course_code: Option<String>,
    /// 课号（教学班代码，如 `2612316`）。教务网页「课号」一栏用的是它。
    pub lesson_code: Option<String>,
    /// 教学班名（合班时是一长串班级列表）
    pub lesson_name: Option<String>,
    /// 课程说明。教务当前部署不返回，字段留在这里以免前端缺列。
    pub description: Option<String>,
    /// 教室（如 `17204新`）
    pub room: Option<String>,
    /// 教室别名 / 楼名（如 `花江校区第十七教学楼`）
    pub room_alias: Option<String>,
    pub campus: Option<String>,
    /// 1=周一 … 7=周日
    pub weekday: i64,
    pub start_unit: i64,
    pub end_unit: i64,
    pub start_time: String,
    pub end_time: String,
    /// 大节节次（2 小节 = 1 大节，由起始小节推导）
    pub big_section: i64,
    pub weeks_str: Option<String>,
    pub start_week: Option<i64>,
    pub end_week: Option<i64>,
    pub teachers: Vec<String>,
    pub credits: Option<f64>,
    /// 课程类型代码（如 `BG`）
    pub course_type_code: Option<String>,
    /// 类型名称（如 `通识必修`）
    pub course_type_name: Option<String>,
    /// 考试类别（如 `考试` / `考查`）
    pub exam_category: Option<String>,
    /// 考试方式（如 `统一考试`）
    pub exam_type: Option<String>,
    /// 课程属性（如 `必修`）
    pub course_property: Option<String>,
    /// 开课院系
    pub open_department: Option<String>,
    pub major: Option<String>,
    pub grade: Option<String>,
    pub semester_name: String,
    /// 课程容量
    pub capacity: Option<i64>,
    /// 已选人数
    pub enrolled: Option<i64>,
    /// 是否实验课
    pub has_experiment: bool,
    /// 实验批次（教务的「实验实际排课时数」，没有就是 0）
    pub experiment_batch: Option<i64>,
    /// 实验批次号（当前部署不返回）
    pub experiment_batch_no: Option<String>,
    /// 实验名称（当前部署不返回）
    pub experiment_name: Option<String>,
    /// 课程备注
    pub remark: Option<String>,
    /// 学时构成
    pub period: Option<CoursePeriod>,
}

/// 课程详情里的学时构成（各栏缺失即 `null`，前端按「—」显示）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoursePeriod {
    pub total: Option<f64>,
    pub weeks: Option<f64>,
    pub theory: Option<f64>,
    pub practice: Option<f64>,
    pub test: Option<f64>,
    pub experiment: Option<f64>,
    pub machine: Option<f64>,
    pub design: Option<f64>,
    pub extra: Option<f64>,
}

impl CoursePeriod {
    /// 从远端 `PeriodInfo` 搬运；全空时返回 `None`，前端就不渲染这一块。
    pub fn from_remote(p: &PeriodInfo) -> Option<Self> {
        let out = Self {
            total: p.total,
            weeks: p.weeks,
            theory: p.theory,
            practice: p.practice,
            test: p.test,
            experiment: p.experiment,
            machine: p.machine,
            design: p.design,
            extra: p.extra,
        };
        let any = [
            out.total,
            out.theory,
            out.practice,
            out.test,
            out.experiment,
            out.machine,
            out.design,
            out.extra,
        ]
        .iter()
        .any(|v| v.is_some());
        any.then_some(out)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimetableResponse {
    #[serde(default)]
    pub student_table_vms: Vec<StudentTableVm>,
}

/// 课表页面上刮下来的变量（`SupwisdomAdapter::fetch_page_vars` 的产物）。
#[derive(Debug, Clone, Default)]
pub struct PageVars {
    pub semesters: Vec<RemoteSemester>,
}

/// 学校公布的**节次时间表**的一行：第 `unit` 节的起止时刻（归一化后的形状）。
///
/// 「动态时间轴」的第一来源。正方把「第 N 节 → 几点到几点」单独开一个接口给
/// （`ZfsoftSlotRow` 的 `jcmc/qssj/jssj`），而课表正文只给节次号 —— 有了这张表，
/// 左侧时间轴才能画到**逐节**（第 1 节 08:00-08:40），课块再按自己占的节次跨行。
/// 树维不提供这张表，那边留空，轴就退化为按实际排课区间切出的互斥片段
/// （见 `commands::build_time_axis`）。
#[derive(Debug, Clone, Default)]
pub struct RemotePeriodSlot {
    pub unit: i64,
    pub start_time: String,
    pub end_time: String,
}

/// 归一化后的课表快照（落库前的中间形态）。**两个厂商的适配器都产出这个形状** ——
/// 落库与周次展开只认它，不认教务的原话。
pub struct TimetableSnapshot {
    pub student_id: Option<String>,
    pub student_code: Option<String>,
    pub student_name: Option<String>,
    pub department: Option<String>,
    pub major: Option<String>,
    pub adminclass: Option<String>,
    pub grade: Option<String>,
    pub total_credits: Option<f64>,
    pub activities: Vec<TimetableActivity>,
    /// 该校该学期的节次时间表；没有这张表时为空（不影响课表本身）
    pub period_slots: Vec<RemotePeriodSlot>,
}

// ─────────────────────── 远端：正方（ZFSoft） ───────────────────────
//
// 正方的字段命名与树维完全两套：键名多为下划线小写（`kbList[].kcmc`），学生档案则是
// **全大写**（`xsxx.XM`）。数字字段（学分 `xf`、周次位掩码 `oldzc`）实测是字符串，
// 但别处见过数字形态，所以走 `lenient_*` 取值而不是直接钉死类型。

/// 教务的数字字段有时给数字、有时给字符串（正方的 `xf` / `oldzc` 两种都见过）。
/// **只在这两种形态里取值**，收到别的就当没有 —— 不猜，也不让整次解析因此失败。
pub fn lenient_i64(v: &serde_json::Value) -> Option<i64> {
    match v {
        serde_json::Value::Number(n) => n.as_i64(),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// 同 [`lenient_i64`]，用于学分这类小数。
pub fn lenient_f64(v: &serde_json::Value) -> Option<f64> {
    match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// 正方课表接口（`/kbcx/xskbcx_cxXsgrkb.html`）的顶层形状。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZfsoftKbResponse {
    #[serde(default)]
    pub xsxx: Option<ZfsoftStudent>,
    /// 课程表行：**一行 = 一门课的一个上课时段**（同一教学班多行 = 一周多次）
    #[serde(default)]
    pub kb_list: Vec<ZfsoftKbRow>,
    /// 实践课：只有起止周次，**没有星期与节次**，所以上不了课表网格
    #[serde(default)]
    pub sjk_list: Vec<ZfsoftPracticeRow>,
}

/// `xsxx` —— 学生档案。键名是全大写，逐字对齐教务。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ZfsoftStudent {
    #[serde(default, rename = "XH")]
    pub code: Option<String>,
    #[serde(default, rename = "XH_ID")]
    pub id: Option<String>,
    #[serde(default, rename = "XM")]
    pub name: Option<String>,
    /// 行政班（如「临床261」）
    #[serde(default, rename = "BJMC")]
    pub adminclass: Option<String>,
    #[serde(default, rename = "ZYMC")]
    pub major: Option<String>,
    /// 年级（如「2026」）
    #[serde(default, rename = "NJDM_ID")]
    pub grade: Option<String>,
}

/// `kbList` 的一行。字段名就是正方的原话（`kcmc` / `cdmc` / `xqj` / `jcs` / `zcd`…）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ZfsoftKbRow {
    #[serde(default)]
    pub kcmc: Option<String>,
    #[serde(default)]
    pub kch: Option<String>,
    /// 教学班 id：32 位 hex UUID（**不是数字**），落库前哈希成 i64
    #[serde(default)]
    pub jxb_id: Option<String>,
    /// 教学班名（「系统解剖学-0001」）
    #[serde(default)]
    pub jxbmc: Option<String>,
    /// 教师，逗号分隔（「张庆金,纪芳芳」）
    #[serde(default)]
    pub xm: Option<String>,
    /// 场地名（「4C501」「文昌田径场」；未排地点时是「未排地点」）
    #[serde(default)]
    pub cdmc: Option<String>,
    /// 楼名（「第四教学楼」）
    #[serde(default)]
    pub lh: Option<String>,
    #[serde(default)]
    pub xqmc: Option<String>,
    /// 星期，1=周一 … 7=周日（与全项目口径一致）
    #[serde(default)]
    pub xqj: Option<String>,
    /// 节次（`"1-2"` / `"11-13"`）。
    ///
    /// **只用 `jcs`，不要用 `jcor`**：实测两列会不一致（`jcs="6-7"` 而 `jcor="6-10"`），
    /// 而 `jcs` 才是网格上真正显示的那一段 —— 同一行的 `oldjc` 位掩码与它逐位吻合。
    #[serde(default)]
    pub jcs: Option<String>,
    /// 周次文本（`"6-18周"` / `"6-12周,14-16周"`）
    #[serde(default)]
    pub zcd: Option<String>,
    /// 周次位掩码（第 n 周 = 第 n-1 位）。`zcd` 的交叉校验，实测两者完全一致。
    #[serde(default)]
    pub oldzc: Option<serde_json::Value>,
    /// 课程类别（「专业课」「通识课」）
    #[serde(default)]
    pub kclbmc: Option<String>,
    /// 学分。实测是字符串（`"5"` / `"0.5"`）。
    #[serde(default)]
    pub xf: Option<serde_json::Value>,
}

/// `sjkList` 的一行（实践课）。没有星期与节次，无法定位到课表网格。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ZfsoftPracticeRow {
    #[serde(default)]
    pub kcmc: Option<String>,
    #[serde(default)]
    pub jsxm: Option<String>,
    /// 起止周次（`"6-14周"`）
    #[serde(default)]
    pub qsjsz: Option<String>,
}

/// 节次时间表（`/kbcx/xskbcx_cxRjc.html`）的一行：
/// `{jcmc:"1", qssj:"08:20", jssj:"09:00"}`。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ZfsoftSlotRow {
    #[serde(default)]
    pub jcmc: Option<String>,
    #[serde(default)]
    pub qssj: Option<String>,
    #[serde(default)]
    pub jssj: Option<String>,
}

/// 周次表（`/kbcx/xskbcxZccx_cxZcByXnxq.html`）的一行：
/// `{zs:"1", rq:"2026-09-07/2026-09-13"}`。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ZfsoftWeekRow {
    #[serde(default)]
    pub zs: Option<String>,
    /// 该周的**起止日期**（`起/止`）。第 1 周那行就是学期锚点。
    #[serde(default)]
    pub rq: Option<String>,
}

// ─────────────────────────── 本地：落库形状 ───────────────────────────

/// 账号。**`password` / `cookies` 不在这个形状里** —— 它们只活在 Rust 内部
/// （`AccountRow`），读路径统一走这里，前端只能看到 `has_password` / `logged_in` 两个布尔。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CampusAccount {
    pub id: i64,
    pub system_kind: String,
    pub base_url: String,
    pub login_name: String,
    /// 是否已保存密码（前端只认这个，认不到密码本身）
    pub has_password: bool,
    /// Cookie jar 里已有主票据
    pub logged_in: bool,
    pub session_at: Option<String>,
    pub student_id: Option<String>,
    pub student_code: Option<String>,
    pub student_name: Option<String>,
    pub department: Option<String>,
    pub major: Option<String>,
    pub adminclass: Option<String>,
    pub grade: Option<String>,
    pub total_credits: Option<f64>,
    pub save_password: bool,
    pub active: bool,
    pub last_sync_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CampusSemester {
    pub id: i64,
    pub account_id: i64,
    pub remote_id: i64,
    pub code: Option<String>,
    /// 展示名，如「2026-2027 第一学期」
    pub name: String,
    pub school_year: Option<String>,
    pub season: Option<String>,
    pub start_date: String,
    pub end_date: String,
    pub week_start_on_sunday: bool,
    pub total_weeks: i64,
    pub current_week: Option<i64>,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CampusCourse {
    pub id: i64,
    pub semester_id: i64,
    pub remote_lesson_id: i64,
    pub course_code: Option<String>,
    pub course_name: String,
    pub lesson_code: Option<String>,
    pub lesson_name: Option<String>,
    pub teachers: Vec<String>,
    pub credits: Option<f64>,
    pub course_type: Option<String>,
    pub color: Option<String>,
}

/// 上课时段 —— 课表渲染的基本单位（`campus_sessions` + 所属课程的展平）。
///
/// **一个时段 = 课 + 星期几 + 节次 + 哪几周**。周次是身份的一部分：同一门课会在同一个
/// 星期几、同一个节次上按周次段拆成多条，教师与教室跟着段走（见迁移 0049）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CampusSession {
    pub id: i64,
    pub course_id: i64,
    pub weekday: i64,
    pub start_unit: i64,
    pub end_unit: i64,
    pub start_time: String,
    pub end_time: String,
    /// 教学周序号数组
    pub weeks: Vec<i64>,
    pub weeks_str: Option<String>,
    pub room: Option<String>,
    pub building: Option<String>,
    pub campus: Option<String>,
    // 展平的课程字段（避免前端二次 join）
    pub course_name: String,
    pub course_code: Option<String>,
    /// **这一节**由谁上。按周轮换教师的课（如健康教育）每位教师只在自己那几周出现，
    /// 所以它优先于课程级那份并集。
    pub teachers: Vec<String>,
    pub credits: Option<f64>,
    pub course_type: Option<String>,
    pub color: Option<String>,
}

/// 一个发生日的**官方调休性质**（见 `holiday.rs`）。
///
/// `off` = 法定放假日（那天仍上原本的课，只是打「假」标）；
/// `makeup` = 调休补班日额外挂上的课（打「调」标）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HolidayKind {
    Off,
    Makeup,
}

/// 一节课在**某个公历日期**上的一次发生。
///
/// 课表要按日/周/月浏览，而教务只给「第 N 教学周 + 星期几」，所以展开这一步放在
/// Rust（**唯一一处**做周次换算的地方，时间线物化也复用它），前端拿到的是直接的日期。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEntry {
    /// `YYYY-MM-DD`
    pub date: String,
    pub week: i64,
    pub session: CampusSession,
    /// 该日在官方调休口径下的性质；普通日为 `null`。总开关关闭时恒为 `null`。
    pub holiday: Option<HolidayKind>,
}

/// 左侧时间轴的一行 —— 一个**互斥片段**（`commands::build_time_axis`）。
///
/// 可能是单独一节（学校给了节次表 → 逐节轴：第 1 节 08:00-08:40），也可能是若干节的合并
/// （没有节次表时按实际排课的节次区间切）。片段之间首尾相接、互不重叠 ——
/// **同一节次在轴上只会出现一次**，这是它比「按 `(startUnit,endUnit)` 去重」强的地方。
///
/// 这正是需求里「第几节那一列要改成实际上课时间」的数据来源：
/// 教务的 `startTime`/`endTime` 已经是该节次的真实时刻，不需要我们维护节次表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeSlot {
    pub start_unit: i64,
    pub end_unit: i64,
    pub start_time: String,
    pub end_time: String,
    /// 距 00:00 的分钟数（与 `todos.start_min` 同口径，方便直接画时间轴）
    pub start_min: i64,
    pub duration_min: i64,
}

/// 课表视图（`campus_schedule` 返回）。一次请求把渲染需要的都带上，省掉二次往返。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleView {
    pub account: Option<CampusAccount>,
    pub semester: Option<CampusSemester>,
    pub entries: Vec<ScheduleEntry>,
    /// 左侧时间轴的行（互斥片段，按节次升序）。口径见 [`TimeSlot`]。
    /// 前端用它当周视图的行轴，并把每门课按占的节次跨行绘制。
    pub time_slots: Vec<TimeSlot>,
    /// 该学期的全部课程（用于「课程清单」与配置页统计）
    pub courses: Vec<CampusCourse>,
    /// 库里的时段是**旧规则**写下的（迁移 0049 之前，同一门课同一时段的多个周次段被并掉了），
    /// 需要一次真同步才能补回来。页面看到它就跑一次同步 —— 用户不必知道发生了什么。
    pub needs_resync: bool,
}

// ─────────────────────────── 选课（course-selection-api） ───────────────────────────

/// 一个选课批次（`open-turns` 的元素）。
///
/// 字段名对齐教务，且**全部带 `default`**：不同轮次的字段会缺，缺字段不该让整个批次列表失败。
/// 唯一没有类型假设的是 `id`（实测是数字 `1921`，而路由参数里又是字符串），所以原样透传，
/// 前端当不透明标识用。
///
/// 2026-09-21 窗口开放后拿到非空样本：批次 `1921`「2026-2027学年第一学期新生选课」，
/// `selectDateTimeRange` = `2026-09-21 10:00:00 ~ 2026-09-30 23:00:00`，`allowEnter: true`、
/// `disallowReasons: []`。字段名与本结构逐字对齐；另有 `turnMode` / `limitCount` /
/// `capPercentage` 等本结构不建模的键（serde 忽略未知键，不影响解析）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseSelectTurn {
    #[serde(default)]
    pub id: serde_json::Value,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub bulletin: Option<String>,
    /// 当前是否允许进入选课
    #[serde(default)]
    pub allow_enter: bool,
    /// 不允许进入的原因（逐条展示给学生）
    #[serde(default)]
    pub disallow_reasons: Vec<String>,
    #[serde(default)]
    pub open_date_time_text: Option<String>,
    #[serde(default)]
    pub select_date_time_text: Option<String>,
    #[serde(default)]
    pub drop_date_time_text: Option<String>,
    #[serde(default)]
    pub add_rules_text: Vec<String>,
    #[serde(default)]
    pub drop_rules_text: Vec<String>,
    /// 开窗/选课/退课的精确区间。**抢课的起跑线就在这里** —— 文本字段是给人看的，
    /// 区间里的 `startDateTime` 才是能拿去对时的机器可读值。
    #[serde(default)]
    pub open_date_time_range: Option<DateTimeRange>,
    #[serde(default)]
    pub select_date_time_range: Option<DateTimeRange>,
    #[serde(default)]
    pub drop_date_time_range: Option<DateTimeRange>,
}

/// 教务给的 `{startDateTime, endDateTime}`，形如 `2026-09-17 08:00:00`。
/// 命名与取值都对齐教务，不去猜别的键名。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DateTimeRange {
    #[serde(default)]
    pub start_date_time: Option<String>,
    #[serde(default)]
    pub end_date_time: Option<String>,
}

impl CourseSelectTurn {
    /// 开抢时刻：优先取结构化区间的起点，退化才去 `selectDateTimeText` 里抠第一个时刻。
    ///
    /// 返回**原样文本**（教务服务器墙上时间），由 `grab` 模块按时钟偏差换算成本机时刻 ——
    /// 这里绝不能直接 `parse` 成本机时间，服务器与学生电脑经常不在一个时区/时区设置上。
    pub fn opens_at_text(&self) -> Option<String> {
        for range in [
            self.select_date_time_range.as_ref(),
            self.open_date_time_range.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if let Some(start) = range.start_date_time.as_deref().map(str::trim) {
                if !start.is_empty() {
                    return Some(start.to_string());
                }
            }
        }
        // `2026-09-17 08:00 ~ 23:59` —— 取波浪线前那一段
        let text = self.select_date_time_text.as_deref()?.trim();
        let head = text.split(['~', '至', '—']).next()?.trim();
        (!head.is_empty()).then(|| head.to_string())
    }

    /// 窗口关闭时刻。与 [`Self::opens_at_text`] 对称：先看结构化区间的终点，
    /// 退化才去 `selectDateTimeText` 里抠波浪线后面那一段。
    pub fn closes_at_text(&self) -> Option<String> {
        for range in [
            self.select_date_time_range.as_ref(),
            self.open_date_time_range.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if let Some(end) = range.end_date_time.as_deref().map(str::trim) {
                if !end.is_empty() {
                    return Some(end.to_string());
                }
            }
        }
        let text = self.select_date_time_text.as_deref()?.trim();
        let tail = text.split(['~', '至', '—']).nth(1)?.trim();
        (!tail.is_empty()).then(|| tail.to_string())
    }
}

/// `query-lesson` 的查询条件对象。
///
/// 字段来自教务处 SPA 渲染出的表单（`query-condition/{turnId}` 定义），实测出现的就这几个。
/// 全部可选且**跳过 None**：教务对多余键容忍度未知，少发比多发安全。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub course_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub course_name: Option<String>,
    /// 课程名或代码。**与 `lesson_name_or_code` 是两个独立字段** ——
    /// 课程（course）与教学班（lesson）在教务那边是两层概念，
    /// SPA 的搜索表单里就是两个输入框（`catchSearch.courseNameOrCode` / `.lessonNameOrCode`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub course_name_or_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lesson_name_or_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teacher_name_or_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub campus_id: Option<i64>,
    /// 勾选后每个教学班带回已选人数；不勾则 `stdCount` 可能缺省。
    /// 抢课要有它才能判断「满没满」，所以引擎默认带上。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_count: Option<bool>,
    /// 指定教学班 id 集合时按 id 精确查（引擎用它核对单门课是否还有余量）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<serde_json::Value>>,
    /// **服务端的资格过滤**：只要「这个学生现在选得了」的那些教学班。
    ///
    /// 引擎**故意不设它** —— 抢课恰恰要盯「此刻满员、等别人退课」的班，
    /// 滤掉就永远发不出去。它留给「先看清能选什么」的场景（真机联调、
    /// 以及将来做「可选课程预览」时）。2026-09-22 实测：某批次 448 个班里，
    /// 这个学生真正可选的只有 12 个 —— 不筛的话，绝大多数提交都会被
    /// 「不符合选课条件组要求」拒掉。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_select: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_type: Option<String>,
}

/* ─────────────────────────── 自动抢课（grab） ─────────────────────────── */
/// `std-count` 里一个教学班的人数：教务回的是 `"已选数-重修数"` 这种字符串
/// （如 `"118-3"`），见 [`StdCount::parse`]。
///
/// 为什么需要它单独一个接口：`query-lesson` 在这套部署上**根本不回 `stdCount`**
/// （2026-09-22 实测：某批次 448 条教学班全缺），于是「满没满」这件事在名单里
/// 无从判断 —— `matcher` 里那套「有空位的先出手」也就等于没有。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StdCount {
    /// 已选人数（字符串的第一段）
    pub taken: i64,
    /// 其中重修人数（第二段，可能没有）
    pub retake: i64,
}

impl StdCount {
    /// 解析 `"118-3"` / `"118"` / `"118-3-2"`（多余段忽略）这类写法。
    ///
    /// 教务的格式没有文档，所以**能解析就解析、解析不了返回 None** ——
    /// 宁可不显示名额，也不要显示一个错的数（错的空位数会让人做出错误的取舍）。
    pub fn parse(raw: &str) -> Option<Self> {
        let text = raw.trim();
        if text.is_empty() {
            return None;
        }
        let mut parts = text.split('-');
        let taken = parts.next()?.trim().parse::<i64>().ok()?;
        let retake = parts
            .next()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(0);
        Some(StdCount { taken, retake })
    }

    /// 用这个人数补上「还剩多少」：`上限 - 已选`。
    pub fn seat_left(self, limit: Option<i64>) -> Option<i64> {
        limit.map(|lim| lim - self.taken)
    }
}

/// 一条抢课任务的终态集合。非终态的任务会被引擎不断推进。
pub const GRAB_WAITING: &str = "waiting";
pub const GRAB_RUNNING: &str = "running";
pub const GRAB_SUCCESS: &str = "success";
pub const GRAB_FAILED: &str = "failed";
pub const GRAB_CONFLICT: &str = "conflict";
pub const GRAB_PAUSED: &str = "paused";
pub const GRAB_CANCELLED: &str = "cancelled";
/// **请求被教务拒了（参数错误）**：重试不会改变结果，引擎停下来把现场交给 AI 排查。
/// 它与 `failed` 的区别是「还有没有救」：`failed` 是这条任务完了，
/// `needs_ai` 是**这条请求的写法**不对 —— 改对了还能继续抢，所以界面要给出下一步。
pub const GRAB_NEEDS_AI: &str = "needs_ai";

/// 是否存在「引擎不该再碰」的终态，供 SQL 与前端共用一套判断。
pub fn grab_is_terminal(status: &str) -> bool {
    matches!(
        status,
        GRAB_SUCCESS | GRAB_FAILED | GRAB_CONFLICT | GRAB_CANCELLED | GRAB_NEEDS_AI
    )
}

/// 抢课任务的**过程**状态。`status` 说「结果如何」，`phase` 说「现在在干嘛」——
/// 抢课过程中用户最想知道的是后者（「已占位，正在确认」和「正在提交」是两种心情）。
pub const PHASE_IDLE: &str = "idle";
pub const PHASE_SUBMIT: &str = "submit";
pub const PHASE_POLL: &str = "poll";

/// `GrabTask::request_domain` 的取值：这张受理单在**镜像域**上。
/// 其余值（含 `None`）都按主域处理 —— 老数据没有这一列，而老数据里的受理号
/// 只能是主域的（镜像受理号是后加的，且当时从没被正确轮询过）。
pub const REQUEST_DOMAIN_MIRROR: &str = "mirror";

/// 一条抢课任务（落库 + IPC 同一形状）。
///
/// `lesson_name` / `course_name` 是**入队时的快照**：抢课期间用户可能已经退出批次、
/// 教务可能已经把课撤下，但任务单上总得有个名字给人看。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabTask {
    pub id: i64,
    /// 列表/路径用的批次 id（`open-turns` 里那个）
    pub turn_id: String,
    /// **提交体**用的批次 id（`courseSelectTurnAssoc`）。
    ///
    /// 来自「进批次」接口返回的 `options.turn.id`，与 `turn_id` **未必相同** ——
    /// 这一点没有真机样本可验，所以两个都留着，由 [`GrabTask::turn_assoc`] 决定用哪个。
    #[serde(default)]
    pub turn_assoc: Option<String>,
    #[serde(default)]
    pub turn_name: Option<String>,
    /// 教学班 id（不透明值）
    pub lesson_id: serde_json::Value,
    #[serde(default)]
    pub lesson_name: Option<String>,
    #[serde(default)]
    pub course_name: Option<String>,
    #[serde(default)]
    pub course_code: Option<String>,
    #[serde(default)]
    pub teacher: Option<String>,
    #[serde(default)]
    pub credits: Option<f64>,
    /// `predicate`（占位优先，推荐）/ `direct`（直接提交）
    pub mode: String,
    #[serde(default)]
    pub virtual_cost: Option<i64>,
    #[serde(default)]
    pub schedule_group_id: Option<serde_json::Value>,
    /// 教务墙钟时间文本（如 `2026-09-17 08:00:00`），到点由引擎换算成本机时刻开火
    #[serde(default)]
    pub window_wall: Option<String>,
    /// 窗口关闭时刻。越过它就收手 —— 依赖「教务会回一句选课已结束」来停手太脆了。
    #[serde(default)]
    pub window_end_wall: Option<String>,
    /// 入队时还不知道窗口什么时候开（比如提前一晚预设、教务还没公布批次）。
    ///
    /// 这种任务**不会盲撞** —— 撞出来的「不在选课时间」会被判成终态，
    /// 等于预设白费。引擎改为每隔一阵去问一次 `open-turns`，拿到窗口就转成精确开火。
    #[serde(default)]
    pub await_window: bool,
    /// 占位是否**已经交过**。
    ///
    /// 必须有这个显式标记，不能靠「`attempts == 0` 就说明还没占位」去推断 ——
    /// 占位落定与正式提交之间 `attempts` 还是 0，推断的结果就是每次回到提交那一步
    /// 又去占一次位，任务永远在占位和轮询之间打转，正式提交一辈子发不出去。
    #[serde(default)]
    pub predicate_done: bool,
    pub status: String,
    pub phase: String,
    /// 真正提交过几次（占位与正式提交都算）
    pub attempts: i64,
    /// 轮询了几次
    pub polls: i64,
    /// 连败次数：任何一步成功即清零，用于指数退避
    pub strikes: i64,
    /// 连败的**种类**（`full` / `retry` / …）。种类一变就重新计数 ——
    /// 「一直满员」和「一直未知错误」该有完全不同的耐心。
    #[serde(default)]
    pub strike_kind: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    /// **第二个域上的受理号**（「抢课时两个域都发」）。
    ///
    /// 两个域是两套系统，各自有自己的受理号 —— 两条单子都要能查结果。
    /// 只留一条的话，另一条就成了「发出去了但没人管」的悬空请求，
    /// 而它可能恰恰是抢到课的那一条。
    #[serde(default)]
    pub mirror_request_id: Option<String>,
    /// `request_id` 这张受理单**属于哪个域**：`"mirror"` = 镜像域，其余（含 NULL）= 主域。
    ///
    /// 必须有这一列：两个域是两套系统，受理号**不能跨域查询**。主域提交失败、镜像域
    /// 受理成功时，若把镜像的受理号当成主域的号去轮询，结果永远查不到 —— 一路空转到
    /// 轮询上限，然后被当成「结果不明」重投，而真正的结果就在镜像域上没人看。
    #[serde(default)]
    pub request_domain: Option<String>,
    #[serde(default)]
    pub last_message: Option<String>,
    /// 下一次该动它的时刻（本机 unix **毫秒**）。引擎用它做「谁最急先管谁」的排序，
    /// 用毫秒是因为开窗瞬间那几百毫秒决定了抢不抢得到。
    pub next_at: i64,
    /// **开火时刻**（本机 unix 毫秒，已按服务器偏差与提前量校正）。
    ///
    /// 只读派生值，不落库：它随时钟偏差变，而偏差是运行时量。界面的倒计时直接用它，
    /// 免得前端自己再实现一遍墙上时间换算 —— 那条换算只该有一份（`grab::fire_at_ms`）。
    #[serde(default)]
    pub fire_at: Option<i64>,
    #[serde(default)]
    pub queued_at: Option<i64>,
    #[serde(default)]
    pub finished_at: Option<i64>,
    /// 志愿组 id。同组是**互斥备选**（时间冲突 / 只能选一门），只会中一个：
    /// 任一中选，同组其余立刻取消。
    ///
    /// `None` / 空字符串 = 独立任务，行为与加这几列之前**完全一致**。
    #[serde(default)]
    pub group_key: Option<String>,
    /// 组名。入队那一刻抄一份，纯给人看（与课名/教师同样冗余存）。
    #[serde(default)]
    pub group_name: Option<String>,
    /// 志愿序：1 = 第一志愿，**小的优先**。0 = 不在任何组里。
    #[serde(default)]
    pub priority: i64,
    /// 连续满员的起点（本机 ms）。只在「让贤期限」> 0 时被读 —— 见 [`GrabSettings::cede_after_ms`]。
    #[serde(default)]
    pub stuck_since: Option<i64>,
    /// **派生值，不落库**：把它压在待命状态的那个更高优先级的任务 id（同 `fire_at` 的先例）。
    /// 界面据此显示「等第 N 志愿」，而不是让前端自己再算一遍互斥关系。
    #[serde(default)]
    pub held_by: Option<i64>,
}

/// 测试用的空白任务：字段三十多个，逐个写一遍的测试没人愿意维护。
/// 只对「判读会读到的字段」负责，其余给中性值 —— 放在结构体旁边，加字段时才不会漏。
#[cfg(test)]
impl GrabTask {
    pub fn blank() -> Self {
        Self {
            id: 0,
            turn_id: "77".into(),
            turn_name: None,
            turn_assoc: None,
            lesson_id: serde_json::Value::Null,
            lesson_name: None,
            course_name: None,
            course_code: None,
            teacher: None,
            credits: None,
            mode: "predicate".into(),
            virtual_cost: None,
            schedule_group_id: None,
            window_wall: None,
            window_end_wall: None,
            await_window: false,
            predicate_done: false,
            status: GRAB_WAITING.into(),
            phase: PHASE_IDLE.into(),
            attempts: 0,
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
}

/// 加入抢课任务单时，一门课要带的信息。
///
/// 课程名/教师/学分都由前端在**入队那一刻**从刚查回来的教学班里抄一份 ——
/// 引擎之后不再回头去教务查「这门课叫什么」，它只负责抢。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabTargetInput {
    pub lesson_id: serde_json::Value,
    #[serde(default)]
    pub lesson_name: Option<String>,
    #[serde(default)]
    pub course_name: Option<String>,
    #[serde(default)]
    pub course_code: Option<String>,
    #[serde(default)]
    pub teacher: Option<String>,
    #[serde(default)]
    pub credits: Option<f64>,
    #[serde(default)]
    pub virtual_cost: Option<i64>,
    #[serde(default)]
    pub schedule_group_id: Option<serde_json::Value>,
    /// 志愿组 id / 组名 / 志愿序。三者一起给才成组；不给就是独立任务。
    #[serde(default)]
    pub group_key: Option<String>,
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub priority: i64,
}

impl GrabTask {
    /// 提交类接口该用的批次 id。
    ///
    /// 优先用「进批次」拿到的那个（SPA 就是用它）；拿不到时退回列表 id ——
    /// 那是我们唯一有把握的值，且在两者其实相等时完全正确。
    pub fn turn_assoc(&self) -> &str {
        self.turn_assoc
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.turn_id)
    }

    /// `request_id` 这张受理单在镜像域上吗？轮询必须照着它选客户端 ——
    /// 受理号不能跨域查询（见 [`GrabTask::request_domain`]）。
    pub fn request_on_mirror(&self) -> bool {
        self.request_domain.as_deref() == Some(REQUEST_DOMAIN_MIRROR)
    }
}

/// 引擎快照（`campus_grab_state` 返回 / `campus://grab` 事件负载）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabState {
    /// 引擎线程是否活着（恒为 true；false 只在启动失败时出现）
    pub alive: bool,
    /// **模块开关**：抢课是课表的子模块，默认关闭。
    /// 关闭时引擎不发任何请求，这里如实为 false —— 界面与 AI 据此说真话，
    /// 而不是显示一堆「静止的任务」让人以为它还在盯着。
    pub enabled: bool,
    /// 是否有任务处在非终态
    pub active: bool,
    /// 教务服务器时间文本（最近一次采样）
    pub server_time: Option<String>,
    /// 服务器墙钟 − 本机墙钟（秒）。倒计时与开火时刻全按它校正。
    pub skew_sec: Option<i64>,
    /// 当前最早的下一次动作时刻（本机 unix 秒），没有任务时为 None
    pub next_at: Option<i64>,
    /// 最近一次开火时刻（本机 unix 毫秒）。界面靠它做倒计时。
    pub next_fire_at: Option<i64>,
    /// 引擎级故障（如教务会话失效）：一旦出现，所有任务都会停下等用户处理
    pub last_error: Option<String>,
    /// 窗口监听的最近结果：教务当前有哪些批次。
    ///
    /// 引擎**不再只在「有任务在等窗口」时才探测**（那会让还没排课的人完全不知道窗口开了）。
    /// 只要账号在、开关开着，就每分钟安静地问一次，把结果放这儿给界面显示。
    #[serde(default)]
    pub turns: Vec<GrabTurnBrief>,
    /// 最近一次窗口探测的时刻（本机 unix 秒）
    #[serde(default)]
    pub probed_at: Option<i64>,
    /// 抢课计划（意向）。与任务单一起推给界面：计划说的「我想抢什么」，
    /// 任务单说的「正在抢什么」，两者在同一屏里对照着看才讲得清。
    #[serde(default)]
    pub intents: Vec<GrabIntent>,
    pub tasks: Vec<GrabTask>,
}

/// 批次的轻量摘要 —— 窗口监听的结果，只给界面看。
///
/// 不直接复用 `CourseSelectTurn`：那个结构体字段多、还带公告与规则正文，
/// 每秒都可能推给前端的事件流里没必要背着它们。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabTurnBrief {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    /// 当前是否允许进入（`allowEnter`）—— 「窗口真的开了」的判据
    #[serde(default)]
    pub allow_enter: bool,
    #[serde(default)]
    pub select_text: Option<String>,
    #[serde(default)]
    pub window_start: Option<String>,
    #[serde(default)]
    pub window_end: Option<String>,
}

/* ─────────────────────── 抢课计划（意向） ───────────────────────
 *
 * 计划 = 一句**模糊查询** + 抢法。它回答的是「我想抢什么」，而不是「抢哪个教学班」——
 * 后者由引擎在能看见教学班的时候解析出来（见 `grab.rs` 的 `resolve_intent`）。
 *
 * 为什么要多这一层，而不是让人直接挑教学班：
 *
 * 1. **提前输入**。窗口开放前教学班列表往往还拉不到（批次未开、教务不给查），
 *    而人的意图（「高数 张」「体育」）现在就能写下来 —— 计划落库，等能查了再解析。
 * 2. **教学班会变**。真到开窗那一刻，哪个班还有空位是新的信息；拿一周前抄下来的
 *    `lessonAssoc` 去抢，赌的是「名单没变过」。计划每次解析都看**当时的**名单。
 * 3. 解析结果照样是给人确认的：命中了哪几个班、排成第几志愿，都在任务单上摆着。
 */

/// 还没解析（等批次 / 等教学班 / 等下次重试）
pub const INTENT_PENDING: &str = "pending";
/// 解析过了，但一个教学班都没匹配上（查询写错、或教务还没公布）
pub const INTENT_EMPTY: &str = "empty";
/// 已解析：志愿任务已经排进任务单
pub const INTENT_READY: &str = "ready";
/// **跨了多门课，等用户补课程代码**（见 `matcher::ambiguous_courses`）。
///
/// 它和 `pending` 必须分开：pending 是「引擎在等教务」，这个状态是「引擎在等你」——
/// 混成一句话，用户就会一直等一个永远不动的计划。
pub const INTENT_AMBIGUOUS: &str = "ambiguous";

/// 一门课的身份（代码 + 课名）—— 「这句查询命中了哪几门课」用它表达。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabCourseRef {
    pub code: String,
    pub name: String,
}

/// 计划命中的一个教学班 —— 给界面「提前确认会抢哪些班」用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabMatch {
    /// 教学班 id（提交时的 `lessonAssoc`）
    pub lesson_id: serde_json::Value,
    #[serde(default)]
    pub course_name: Option<String>,
    #[serde(default)]
    pub course_code: Option<String>,
    #[serde(default)]
    pub teacher: Option<String>,
    #[serde(default)]
    pub std_count: Option<i64>,
    #[serde(default)]
    pub limit_count: Option<i64>,
    /// 这门课已经在你名下了（解析时会跳过它）
    #[serde(default)]
    pub picked: bool,
    /// 命中的字段（`course` / `code` / `teacher` / `place`，见 `matcher`）：界面据此解释「为什么是它」
    #[serde(default)]
    pub fields: Vec<String>,
    /// 教学班名称（院系 / 校区 / 年级在这里）
    #[serde(default)]
    pub lesson_name: Option<String>,
    /// 项目名（体育课的「羽毛球」这类）
    #[serde(default)]
    pub minor_name: Option<String>,
}

/// 一条抢课计划。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabIntent {
    pub id: i64,
    /// 目标批次。**空 = 用教务当前开放的那个** —— 提前一晚写下计划时批次可能还没出现。
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub turn_name: Option<String>,
    /// 模糊查询（课名 / 代码 / 教师，空格分词，全部词都要命中）
    pub query: String,
    /// `predicate`（占位优先）/ `direct`
    pub mode: String,
    /// 命中多门课程时：`true` = 每门课各排一组（同名课程只中一个班）；
    /// `false`（默认）= 全部命中合成一组，只中一个。
    #[serde(default)]
    pub spread: bool,
    pub status: String,
    /// 解析出来的志愿组 id（`spread` 时可能不止一个），任务行靠它归到这条计划下
    #[serde(default)]
    pub group_keys: Vec<String>,
    /// 命中的教学班，**已按志愿序**（前面的先出手）
    #[serde(default)]
    pub candidates: Vec<GrabMatch>,
    #[serde(default)]
    pub last_message: Option<String>,
    /// 解析尝试了几次（含「什么都没匹配到」的那些）
    pub attempts: i64,
    /// 下一次该重试解析的时刻（本机 unix 毫秒）
    pub next_at: i64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub resolved_at: Option<i64>,
}

/// 「输入预览」的结果：一句模糊查询照**当前**名单跑一遍。
///
/// 带 `total` 与 `matched` 是为了把几种「少」分开说：教务还没公布教学班（`total = 0`）/
/// 查询没匹配上（`matched = 0`）/ 匹配上了但被「指定教师」筛掉（`matched > matches.len()`）。
/// 它们要用户做的事完全不同，糊成一句「没找到」只会让人反复改查询词。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabPreview {
    pub turn_id: String,
    pub turn_name: Option<String>,
    /// 这个批次教务给了多少教学班
    pub total: usize,
    /// 模糊匹配命中多少个（**筛选前**）
    pub matched: usize,
    /// 真会抢的那些班，已按志愿序（前面的先出手）
    pub matches: Vec<GrabMatch>,
    /// **跨课程的命中**：非空 = 这句查询命中的是好几门课（大一/大二双开的体育课最典型）。
    /// 「中一个就够」时引擎**不会排队**，会等你补上课程代码 —— 判定与解析共用同一条规则，
    /// 所以预览里看到的就是解析时会发生的事。
    #[serde(default)]
    pub ambiguous: Vec<GrabCourseRef>,
    /// **放宽匹配的提示**：严格档一个都没命中、靠丢掉某个词才凑出结果时，这里是那句话。
    /// 空 = 严格命中（没放宽）。
    ///
    /// 为什么必须显示出来：用户写「羽毛球 星期四」，真抢到的可能是**星期一**的班 ——
    /// 放宽是为了「零结果」时不至于白等一整个窗口，但它改动了用户写的条件，
    /// 这一点必须让人看见（`dropped_words` 里就是被丢掉的那些词）。
    #[serde(default)]
    pub relax_note: Option<String>,
    /// 为了命中而丢掉的词（原样，未归一化）。空 = 没丢。
    #[serde(default)]
    pub dropped_words: Vec<String>,
    /// 「这份名单是旧的」——教务拉不到时，引擎会用上一次落盘的那份接着干。
    /// 非空 = 名单和名额都可能已经变了，界面上要说清楚。
    #[serde(default)]
    pub lessons_note: Option<String>,
}

/// 「起飞前自检」的一项。
///
/// 每一项都是**能明确回答「行 / 不行」**的检查，`detail` 是给人看的证据
/// （教务原话、数字、时间）。含糊的话（「似乎正常」）没有价值 ——
/// 体检的意义就是在窗口开之前把「不行」找出来。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabPreflightItem {
    /// 稳定的键（界面按它归类/折叠）
    pub key: String,
    /// 给人看的名字
    pub label: String,
    /// 这一项过没过
    pub ok: bool,
    /// 证据或原因（总是要写）
    pub detail: String,
}

/// 一次体检的结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabPreflight {
    /// 全部通过才为 true
    pub ok: bool,
    /// 逐项结果（顺序即体检顺序）
    pub items: Vec<GrabPreflightItem>,
    /// 一句话总结（给人看的那句）
    pub summary: String,
}

/// 引擎节奏参数。默认值按「一个学生抢 1–4 门课」标定：
/// 够快（开窗瞬间就出手），又不至于把教务网关打成风控对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabSettings {
    /// 两次**提交**之间的全局最小间隔（毫秒）。这是防封的主要旋钮。
    pub min_interval_ms: i64,
    /// 轮询受理结果的间隔（毫秒）。SPA 用 2000，这里不更激进。
    pub poll_interval_ms: i64,
    /// 满员后重试的间隔（毫秒）。比普通重试慢 —— 名额释放是稀疏事件，快没意义。
    pub full_retry_ms: i64,
    /// 出错后的退避基数（毫秒），按 `strikes` 指数增长
    pub backoff_ms: i64,
    /// 退避上限（毫秒）
    pub max_backoff_ms: i64,
    /// 提前量（毫秒）：在开窗时刻**之前**多久出手，用来抵消我们的网络往返。
    pub lead_ms: i64,
    /// 单个任务的最大提交次数；0 = 不限（抢课常态）
    pub max_attempts: i64,
    /// 轮询同一受理单的最大次数，超过就当作结果不明并重投
    pub max_polls: i64,
    /// **让贤期限**（毫秒）：当前志愿连续满员超过这么久，就把出手机会让给下一志愿。
    ///
    /// **0 = 死守（默认）**：只有当前志愿进终态（冲突/超出次数/连败）或窗口关闭，
    /// 才轮到下一志愿。设成 `180000` 就是「满员 3 分钟后让贤」。
    ///
    /// 让出的那个任务**仍是非终态**：后面志愿要是也没成，它会自动回到「当前志愿」。
    #[serde(default)]
    pub cede_after_ms: i64,
    /// **窗口监听**：App 开着就每隔一阵去问一次「窗口公布了没有」，**即使任务单是空的**。
    ///
    /// 默认开。关掉它的唯一理由是「不想让这台机器每分钟碰一次教务」。
    #[serde(default = "default_true")]
    pub watch_window: bool,
}

/// `serde` 的 `default` 只认函数名，所以单独写一个（不能用 `bool::default` —— 那是 false）。
fn default_true() -> bool {
    true
}

impl Default for GrabSettings {
    fn default() -> Self {
        Self {
            min_interval_ms: 700,
            poll_interval_ms: 2000,
            full_retry_ms: 5000,
            backoff_ms: 1500,
            max_backoff_ms: 30_000,
            lead_ms: 800,
            max_attempts: 0,
            max_polls: 15,
            cede_after_ms: 0,
            watch_window: true,
        }
    }
}

impl GrabSettings {
    /// 落库前收口。
    ///
    /// **下限特意压得很低**（最小间隔 10ms ≈ 100 次/秒）：2026-09 拿真账号对教务做过压测，
    /// 80 次/秒无异常，所以「快」这件事该由用户决定，而不是被一个保守的钳位挡住。
    ///
    /// 但**默认值仍然保守**（`Default` 里是最小间隔 700ms）—— 钳位放开的只是「能调到多少」，
    /// 不是「默认就有多快」。而且压测打的是 `bkjwtest`（测试域），生产域的风控策略未必一样；
    /// 抢课的胜负手其实是**对时**（`lead_ms` 打得准）与**占位优先**，不是把请求数堆上去。
    ///
    /// 唯一还留着「不许调」的东西是那几条**语义上的边界**：退避上限不得低于基数
    /// （否则退避会越退越快）、`0` 在 `max_attempts` / `cede_after_ms` 上是「不限/死守」这些有意义的取值。
    pub fn sanitized(mut self) -> Self {
        self.min_interval_ms = self.min_interval_ms.clamp(10, 10_000);
        self.poll_interval_ms = self.poll_interval_ms.clamp(50, 30_000);
        self.full_retry_ms = self.full_retry_ms.clamp(100, 120_000);
        self.backoff_ms = self.backoff_ms.clamp(50, 60_000);
        self.max_backoff_ms = self.max_backoff_ms.clamp(self.backoff_ms, 300_000);
        self.lead_ms = self.lead_ms.clamp(0, 5_000);
        self.max_attempts = self.max_attempts.clamp(0, 100_000);
        self.max_polls = self.max_polls.clamp(1, 200);
        // 0 是「死守」这个有意义的值，别把它钳到别的数上；上限一小时
        self.cede_after_ms = self.cede_after_ms.clamp(0, 3_600_000);
        self
    }
}

/// 选课子系统的整体状态（`campus_course_select_status` 返回）。
///
/// 一次请求把「能不能用」讲清楚：令牌拿没拿到、服务器几点了、我是谁、有哪些批次。
/// 抢课对时全靠 `server_time`，不要用本机时钟 —— 学生电脑的时间经常偏。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseSelectStatus {
    /// 令牌是否就绪（false 时后面的字段都可能是空的）
    pub ready: bool,
    /// 不可用的原因，直接给用户看
    pub reason: Option<String>,
    pub server_time: Option<String>,
    pub student_id: Option<i64>,
    pub student_code: Option<String>,
    pub student_name: Option<String>,
    /// 开放中的批次；**空数组表示当前没有选课窗口**，属正常状态
    pub turns: Vec<CourseSelectTurn>,
    /// 运行时暴露给界面的「选课页」地址（含令牌），便于用户去官方页面核对
    pub entry_url: Option<String>,
    /// 当前账号连的是**正式**教务（bkjw）而不是测试域（bkjwtest）。
    ///
    /// 界面据此说一句实话：测试域的风控比正式域松，压出来的速率不能当作正式域的结论
    /// （见 `adapters::provider::is_production_base`）。
    #[serde(default)]
    pub production: bool,
}

/// 教学班里的课程信息（`lesson.course`）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonCourse {
    #[serde(default)]
    pub id: serde_json::Value,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub name_zh: Option<String>,
    #[serde(default)]
    pub name_en: Option<String>,
    #[serde(default)]
    pub credits: Option<f64>,
}

/// 学生在这门教学班上的选课状态（`lesson.selectedLesson`，未选时为 null）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonSelection {
    /// 待筛选 | 已选中 | …
    #[serde(default)]
    pub status: Option<String>,
    /// 已在课表里钉住
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub need_attend: bool,
}

/// 一个上课小组（同一门课可能有多个可选组，`lesson.scheduleGroups`）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleGroup {
    #[serde(default)]
    pub id: serde_json::Value,
    #[serde(default)]
    pub no: Option<i64>,
    #[serde(default)]
    pub default: bool,
    #[serde(default)]
    pub limit_count: Option<i64>,
    /// 上课时间地点（渲染用）
    #[serde(default)]
    pub date_time_place: serde_json::Value,
}

/// 一个教学班（`query-lesson` 的元素）。
///
/// 字段名与 2026-09-21 的实测样本（批次 1921，395 个教学班）逐字对齐，
/// 仍全部带 `default`：能缺就缺，缺了也别让列表整个挂掉。真正提交选课时只用得上 `id`。
///
/// 两个实测要点：
/// 1. **批次关掉人数显示时（`turnMode.showCount: false`）`stdCount` 根本不返回** ——
///    此时「满没满」判不出来，只能靠提交结果说话；`canSelect` / `selectedLesson` 也不是每行都有。
/// 2. `limitCount` 每行都有（教学班上限），`scheduleGroups[].schedules[]` 带 weekday/unit/时间 ——
///    这些是给人看的，字段比这里建模的更多（`courseType` / `campus` / `weekDays` 等）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseSelectLesson {
    /// 教学班 id —— 提交选课时的 `lessonAssoc`
    #[serde(default)]
    pub id: serde_json::Value,
    #[serde(default)]
    pub course: Option<LessonCourse>,
    #[serde(default)]
    pub selected_lesson: Option<LessonSelection>,
    #[serde(default)]
    pub std_count: Option<i64>,
    #[serde(default)]
    pub limit_count: Option<i64>,
    #[serde(default)]
    pub teachers: Vec<serde_json::Value>,
    /// **教学班名称**（如「大学体育1-花江校区-26级（3院、7院、建交院）」）。
    ///
    /// 院系、校区、年级这些限定条件**只写在这里**：课程名是「大学体育1」，
    /// 而「3院」这个信息在别处一个字段都没有。丢掉它，用户就没法表达
    /// 「我只抢本院系那个班」—— 而选不了外院系的班，打过去也是白费发射次数。
    #[serde(default)]
    pub lesson_name: Option<String>,
    /// **副课程 / 项目名**（如体育课的「羽毛球」「中华射艺」）。
    ///
    /// 教务的选课表格正是拿它当上标渲染的：学生嘴里的「我抢羽毛球」，
    /// 在字段层面既不是课程名（那是「大学体育1」）也不是教师 —— 只有这里有。
    #[serde(default)]
    pub minor_course: Option<LessonCourse>,
    #[serde(default)]
    pub schedule_groups: Vec<ScheduleGroup>,
    #[serde(default)]
    pub can_select: Option<bool>,
}

/// 选课请求单元（教务叫 `requestMiddleDto`）。字段名逐字对齐 SPA 的构造代码：
/// `{ lessonAssoc, virtualCost, scheduleGroupAssoc }`，免听时追加 `needAttend`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddItem {
    /// 教学班 id
    pub lesson_assoc: serde_json::Value,
    /// 意愿值（虚拟钱包）。SPA 里该字段**总是存在**（未启用时为 null），所以这里不跳过。
    pub virtual_cost: Option<i64>,
    /// 上课小组 id；未选择时 SPA 里是 undefined，JSON 会整个丢掉该键，这里照做。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_group_assoc: Option<serde_json::Value>,
    /// 时间冲突时的免听标记
    #[serde(skip_serializing_if = "Option::is_none")]
    pub need_attend: Option<bool>,
}

/// 选课/退课结果（`add-drop-response` / `predicate-response` 的 data）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseSelectResult {
    #[serde(default)]
    pub success: bool,
    /// 失败原因
    #[serde(default)]
    pub error_message: Option<SelectErrorMessage>,
    /// 与已选课程时间冲突，需要办理免听
    #[serde(default)]
    pub resend: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectErrorMessage {
    #[serde(default)]
    pub text: Option<String>,
}

/// 一次选课/退课提交的受理回执。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseSelectTicket {
    pub request_id: String,
}

/// 轮询结果（`campus_course_select_result` 返回）。
///
/// `pending = true` 表示服务端还在处理，前端应隔 2 秒再问一次（SPA 最多问 10 次）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseSelectPoll {
    pub pending: bool,
    pub success: bool,
    pub message: Option<String>,
    /// 需要免听：前端应提示用户，确认后带 `needAttend` 重新提交
    pub need_attend: bool,
}

// ─────────────────────────── IPC：动作结果 ───────────────────────────
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginOutcome {
    pub ok: bool,
    /// 服务端原样返回的提示（如「用户名或密码错误」），失败时给用户看
    pub message: Option<String>,
    /// 需要图形验证码；前端据此显示验证码输入框
    pub need_captcha: bool,
    /// `login_first` / `weak_password` —— 需要去网页端处理，本地重试无意义
    pub action_required: Option<String>,
    pub account: Option<CampusAccount>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub courses: i64,
    pub sessions: i64,
    /// 写进时间线的派生日程条数
    pub todos_written: i64,
    pub semester_id: i64,
    pub semester_name: String,
    pub synced_at: String,
    /// 远端有、但本次未产生时段的活动数（如纯考试安排），用于诊断
    pub skipped_activities: i64,
}

/* ─────────────────────── 救援面（AI 的最后补救） ───────────────────────
 *
 * 与抢课引擎的分工：引擎负责「一切照常」时把课抢到；这一片负责「不照常」的时候
 * 还能把现场摸清、把状态摆回去、把一条能脱离 App 重放的命令交到人手里。
 * 逻辑在 `rescue.rs`，命令在 `commands.rs`。
 */

/// AI 对教务/抢课引擎做过的一件事。审计表 `campus_ai_actions` 的一行。
///
/// 存在的理由有两个，且都不是「留个日志好看」：
/// 1. **给模型自己看**（`RescueState.recent_actions`）—— 没有它，模型会在同一个错误上原地转圈；
/// 2. **给人看** —— 写操作不弹确认（抢课要快），那份信任必须由「事后能一条条查」来兜底。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAction {
    pub id: i64,
    pub at: String,
    /// `http` / `session` / `grab` / `select` / `script`
    pub kind: String,
    /// 一行中文摘要（模型和人都先看这一行）
    pub summary: String,
    #[serde(default)]
    pub detail: Option<serde_json::Value>,
    /// 这条动作对应的可重放 curl（没有请求的动作是 `None`）
    #[serde(default)]
    pub curl: Option<String>,
    /// `ok` / `error`
    pub status: String,
    #[serde(default)]
    pub account_id: Option<i64>,
}

/// 现场快照：一次调用把模型判读要用到的东西全给它，省得它连着问五轮。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RescueState {
    pub account: Option<CampusAccount>,
    /// 会话探针结果。`None` = 没探（`probe=false`，或根本没有账号）
    pub session_alive: Option<bool>,
    /// 探针本身报错时的原文（区别于「探通了但说会话无效」）
    pub session_error: Option<String>,
    /// 抢课引擎的一整份快照：任务、计划、节奏、批次、偏差、引擎级故障
    pub grab: GrabState,
    /// 卡住的任务 id（非终态、没被暂停，但连败或逾期未动）—— 只是提示，不是结论
    pub stuck_task_ids: Vec<i64>,
    /// 最近 AI 动作（新的在前）
    pub recent_actions: Vec<AiAction>,
}

/// 一条原始请求。字段都是「模型友好」的：路径可以只写 `/student/home`，
/// 方法可以小写，正文直接给字符串。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RescueRequest {
    /// 绝对地址或相对路径（相对 = 拼在教务 base 后面）
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
    /// 正文的 Content-Type，默认 `application/json`
    #[serde(default)]
    pub content_type: Option<String>,
    /// 带教务 Cookie。**只在同源生效**：跨域给了也不带（见 `rescue.rs` 的不变量 1）
    #[serde(default)]
    pub with_session: Option<bool>,
    /// 带选课 SSO 令牌（`Authorization: <JWT>`，裸 token 无 Bearer 前缀）
    #[serde(default)]
    pub with_select_token: Option<bool>,
    #[serde(default)]
    pub max_bytes: Option<usize>,
    /// 人话理由：写进审计与脚本注释。必填 —— 「为什么打这条请求」是事后复盘时最缺的一栏
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RescueResponse {
    /// 实际打到的地址（相对路径已补全）
    pub url: String,
    pub method: String,
    pub status: u16,
    pub ok: bool,
    /// 目标是不是教务同源（决定这条请求带没带凭据）
    pub same_origin: bool,
    pub with_session: bool,
    pub with_select_token: bool,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub truncated: bool,
    /// 响应正文字节数（截断前）
    pub bytes: usize,
    pub elapsed_ms: i64,
    /// 等价 curl（凭据用 `$COOKIE` / `$SELECT_TOKEN` 变量引用）
    pub curl: String,
    /// 会话失效后已自动重登并重试过一次
    pub healed: bool,
    /// 需要人/模型额外知道的一句话（如「已自动重登，请核对结果」）
    #[serde(default)]
    pub note: Option<String>,
}

/// 导出的救援脚本。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurlExport {
    /// 落盘的 `.sh` 绝对路径
    pub path: String,
    pub script: String,
    pub count: usize,
    pub generated_at: String,
}

/* ─────────────────────────── 全校开课查询 ─────────────────────────── */

/// 开课查询的入参。
///
/// 只保留「教务真的认」的几个字段：教务的数据接口靠 queryPage__ 翻页、
/// 其余筛选一律由**查询表单**在服务端会话里带过去，所以这里不做一整套筛选器 ——
/// 需要复杂筛选时应该去教务页面自己筛，本应用不假装能替代它。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonSearchQuery {
    /// 学期 id（来自课表页 / 开课查询页的学期列表）
    pub semester_id: i64,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub page_size: Option<i64>,
}

/// 开课名单里的一行。
///
/// 全部字段带 default：这套接口在选课批次未开时也会返回行，但**字段随教务版本漂移过**
/// （实测 2026-09 的列名见 adapters::provider::LESSON_SEARCH_ASSEMBLE_FIELDS）。
/// 宁可缺字段，也不能让整个列表解析失败 —— 一个解析失败会把
/// 「教务改了一个列名」升级成「这个功能完全不能用」。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonSearchHit {
    /// 开课行 id（用于「加入抢课计划」时定位）
    #[serde(default)]
    pub id: serde_json::Value,
    #[serde(default)]
    pub course: Option<LessonCourse>,
    /// 教学班名（如「教学班A」「01班」）
    #[serde(default)]
    pub name_zh: Option<String>,
    /// 开课院系
    #[serde(default)]
    pub open_department: serde_json::Value,
    /// 教师列表（形状随教务而变，原样带着）
    #[serde(default)]
    pub teacher_assignment_list: serde_json::Value,
    /// 上课时间地点（结构化）
    #[serde(default)]
    pub time_table_layout: serde_json::Value,
    /// 时间地点的**可读文本**。教务有时直接给一行文本，有时只给结构化数据，
    /// 所以两个都留着，由前端决定显示哪个。
    #[serde(default)]
    pub schedule_text: Option<String>,
    #[serde(default)]
    pub campus: serde_json::Value,
    #[serde(default)]
    pub course_type: serde_json::Value,
    #[serde(default)]
    pub exam_mode: serde_json::Value,
    #[serde(default)]
    pub teach_lang: serde_json::Value,
    #[serde(default)]
    pub room_type: serde_json::Value,
    /// 一行原始 JSON。
    ///
    /// 有意保留：教务的列名会漂移，而**用户能看到的原始响应**是排障时唯一可靠的东西。
    /// 有了它，字段名变了也不用等新版本 —— 在界面上就能看出真实列名。
    #[serde(default)]
    pub raw: serde_json::Value,
}

impl LessonSearchHit {
    /// 从一行原始 JSON 构造。**永不失败**：解不出来就退化成「只有 raw 的一行」。
    pub fn from_value(v: &serde_json::Value) -> Self {
        match serde_json::from_value::<Self>(v.clone()) {
            Ok(mut hit) => {
                hit.raw = v.clone();
                hit
            }
            Err(_) => Self {
                raw: v.clone(),
                ..Default::default()
            },
        }
    }
}

/// 一页开课名单。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonSearchPage {
    #[serde(default)]
    pub hits: Vec<LessonSearchHit>,
    #[serde(default)]
    pub page: i64,
    #[serde(default)]
    pub page_size: i64,
    /// 教务给的总条数（可能缺省）
    #[serde(default)]
    pub total: Option<i64>,
    /// 响应顶层键名。空列表时靠它区分「教务改了信封」与「确实没开课」。
    #[serde(default)]
    pub raw_keys: Vec<String>,
}

/// 一个候选域名的探测结论。
///
/// **按域名分别汇报，不合并**：两个域不是同一套系统（见 provider），
/// 合并会把「这个域压根没有 EAMS5」伪装成「两个域都没有这门课」。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchoolDomainProbe {
    pub base_url: String,
    /// 连得上（拿到了 HTTP 状态码，哪怕是 404）
    #[serde(default)]
    pub reachable: bool,
    /// 开课查询入口在这个域上存在（200 / 302）
    #[serde(default)]
    pub lesson_search_route: bool,
    /// EAMS5 静态资源在这个域上存在 —— **判断「这套系统在不在」最硬的证据**
    #[serde(default)]
    pub eams_assets: bool,
    /// 静态提示（这个域名预期是什么）
    #[serde(default)]
    pub hint: String,
    #[serde(default)]
    pub page_status: Option<u16>,
    #[serde(default)]
    pub asset_status: Option<u16>,
    /// 一句话结论，直接可显示
    #[serde(default)]
    pub detail: String,
}

/// 全校开课查询的完整回执：**两个域都探测** + 在能用的那个域上查到的名单。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonSearchOutcome {
    /// 两个候选域名的探测结果（顺序即 adapters::provider::GUET_DOMAINS）
    #[serde(default)]
    pub domains: Vec<SchoolDomainProbe>,
    /// 真正用来查询的域名（None = 两个域都用不了）
    #[serde(default)]
    pub used_base_url: Option<String>,
    #[serde(default)]
    pub page: LessonSearchPage,
    /// 学期列表（来自能用的那个域；两个域都用不了时为空）
    #[serde(default)]
    pub semesters: Vec<RemoteSemester>,
}
