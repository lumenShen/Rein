//! 适配器统一接口与分派：命令层只认「登录 / 学期 / 课表」这些动作，谁来干由这里决定。
//!
//! 两层各管一件事：
//! - [`CampusAdapter`] —— **统一接口**，新厂商实现它即可接入；可选能力
//!   （课程详情 / 培养方案）不实现就吃默认的「不支持」回执。
//! - [`AnyAdapter`] —— **分派层**，按 [`provider::LoginStrategy`] 把调用转给对应厂商，
//!   并穷尽 match 全部变体 —— 新厂商忘了接线，编译期就报错，
//!   而不是在用户点登录时才发现。
//!
//! 为什么分派是 enum 而不是 `Box<dyn CampusAdapter>`：这里要的是**穷尽**而不是开放扩展，
//! 与 `modules/voice` 的 `AnyAsrAdapter` 同思路。
//!
//! 为什么要有这一层：在第二家厂商进来之前，`commands.rs` 里有 8 处直接
//! `SupwisdomAdapter::new(spec, session)`。再多一家，那些地方每一处都要按学校分叉 ——
//! 那等于把「哪所学校用哪套协议」这个知识从 [`provider`] 抄到了命令层，
//! 而它正是 provider 存在的理由。这里收口成一处。

use crate::error::{ReinError, Result};

use super::super::http::Session;
use super::super::models::{CourseDetail, LoginOutcome, PageVars, TimetableSnapshot};
use super::provider::{LoginStrategy, SchoolSystemSpec};
use super::supwisdom::SupwisdomAdapter;
use super::zfsoft::ZfsoftAdapter;

/// 一家教务系统适配器的统一接口：登录 → 会话 → 学期 → 课表，外加两个可选能力。
///
/// 新厂商要做的全部事情就是实现它。可选能力不实现就走默认的「不支持」回执 ——
/// 明确报错而不是返回空数据，空数据会被读成「教务没数据」。
pub trait CampusAdapter {
    /// 本适配器服务的学校系统声明（学校名、厂商、接口表都在里面）。
    fn spec(&self) -> &'static SchoolSystemSpec;

    /// 取验证码前的会话预热。有的厂商（树维）要先把 Cookie 会话建起来，
    /// 验证码答案才绑得上；不需要预热的厂商给空实现。
    fn warm_login_session(&mut self) -> Result<()>;

    /// 会话探针：200 = 仍有效，302 = 被踢回登录页。
    fn probe_session(&mut self) -> Result<bool>;

    /// 取图形验证码（裸 base64，前端自行拼 `data:` URL）。
    fn fetch_captcha(&mut self) -> Result<String>;

    /// 登录握手。各家厂商的「取材料 → 混淆口令 → 提交」流程完全不同，各自实现。
    fn login(&mut self, login_name: &str, password: &str, captcha: &str) -> Result<LoginOutcome>;

    /// 课表页面变量（学期列表）。
    ///
    /// `wanted` 是调用方**明确要的那个远端学期**。学期列表整个藏在页面里的厂商
    /// （树维）用不上它；学期列表要逐个补周历的厂商（正方）靠它保证
    /// 「用户翻回三年前那个学期」也能被包含进来。
    fn fetch_page_vars(&mut self, wanted: Option<i64>) -> Result<PageVars>;

    /// 课表数据（主数据源）→ 归一化快照。
    fn fetch_timetable(&mut self, semester_id: i64) -> Result<TimetableSnapshot>;

    /// 课程详情（**可选能力**）：教学班档案（考试类别 / 学时构成 / 容量…）。
    fn fetch_course_detail(
        &mut self,
        _semester_id: i64,
        _semester_name: &str,
        _lesson_id: i64,
        _weekday: Option<i64>,
        _start_unit: Option<i64>,
        _week: Option<i64>,
    ) -> Result<CourseDetail> {
        Err(unsupported(self.spec(), "查看课程详情"))
    }

    /// 培养方案（**可选能力**）。
    fn fetch_program_info(&mut self, _student_id: &str) -> Result<serde_json::Value> {
        Err(unsupported(self.spec(), "查看培养方案"))
    }
}

/// 可选能力的默认回执：说清是哪所学校、哪套系统、缺哪个能力。
fn unsupported(spec: &SchoolSystemSpec, what: &str) -> ReinError {
    ReinError::Message(format!(
        "{}的教务系统暂不支持{}（{}）",
        spec.short_name, what, spec.vendor
    ))
}

pub enum AnyAdapter<'a> {
    Supwisdom(SupwisdomAdapter<'a>),
    Zfsoft(ZfsoftAdapter<'a>),
}

impl<'a> AnyAdapter<'a> {
    /// 按 spec 声明的登录策略挑适配器。
    ///
    /// **认不出来就编译期报错**（match 覆盖了 [`LoginStrategy`] 的全部变体）——
    /// 这正是把策略做成 enum 而不是字符串的原因：新增一家厂商时，
    /// 忘记接上分派会在编译时被抓住，而不是在用户点登录时才发现。
    pub fn new(spec: &'static SchoolSystemSpec, session: &'a mut Session) -> Self {
        match spec.login {
            LoginStrategy::SupwisdomPortalRsa { .. } => {
                Self::Supwisdom(SupwisdomAdapter::new(spec, session))
            }
            LoginStrategy::ZfsoftLoginRsa { .. } => {
                Self::Zfsoft(ZfsoftAdapter::new(spec, session))
            }
        }
    }
}

/// 命令层拿到的是 `AnyAdapter`，也通过本 trait 调用 —— 命令层同样不认识厂商。
impl<'a> CampusAdapter for AnyAdapter<'a> {
    fn spec(&self) -> &'static SchoolSystemSpec {
        match self {
            Self::Supwisdom(a) => a.spec(),
            Self::Zfsoft(a) => a.spec(),
        }
    }

    fn warm_login_session(&mut self) -> Result<()> {
        match self {
            Self::Supwisdom(a) => a.warm_login_session(),
            Self::Zfsoft(a) => a.warm_login_session(),
        }
    }

    fn probe_session(&mut self) -> Result<bool> {
        match self {
            Self::Supwisdom(a) => a.probe_session(),
            Self::Zfsoft(a) => a.probe_session(),
        }
    }

    fn fetch_captcha(&mut self) -> Result<String> {
        match self {
            Self::Supwisdom(a) => a.fetch_captcha(),
            Self::Zfsoft(a) => a.fetch_captcha(),
        }
    }

    fn login(&mut self, login_name: &str, password: &str, captcha: &str) -> Result<LoginOutcome> {
        match self {
            Self::Supwisdom(a) => a.login(login_name, password, captcha),
            Self::Zfsoft(a) => a.login(login_name, password, captcha),
        }
    }

    fn fetch_page_vars(&mut self, wanted: Option<i64>) -> Result<PageVars> {
        match self {
            Self::Supwisdom(a) => a.fetch_page_vars(wanted),
            Self::Zfsoft(a) => a.fetch_page_vars(wanted),
        }
    }

    fn fetch_timetable(&mut self, semester_id: i64) -> Result<TimetableSnapshot> {
        match self {
            Self::Supwisdom(a) => a.fetch_timetable(semester_id),
            Self::Zfsoft(a) => a.fetch_timetable(semester_id),
        }
    }

    fn fetch_course_detail(
        &mut self,
        semester_id: i64,
        semester_name: &str,
        lesson_id: i64,
        weekday: Option<i64>,
        start_unit: Option<i64>,
        week: Option<i64>,
    ) -> Result<CourseDetail> {
        // 两家统一委托给 trait 方法；没实现这个可选能力的厂商吃到默认「不支持」回执。
        match self {
            Self::Supwisdom(a) => a.fetch_course_detail(
                semester_id,
                semester_name,
                lesson_id,
                weekday,
                start_unit,
                week,
            ),
            Self::Zfsoft(a) => a.fetch_course_detail(
                semester_id,
                semester_name,
                lesson_id,
                weekday,
                start_unit,
                week,
            ),
        }
    }

    fn fetch_program_info(&mut self, student_id: &str) -> Result<serde_json::Value> {
        match self {
            Self::Supwisdom(a) => a.fetch_program_info(student_id),
            Self::Zfsoft(a) => a.fetch_program_info(student_id),
        }
    }
}
