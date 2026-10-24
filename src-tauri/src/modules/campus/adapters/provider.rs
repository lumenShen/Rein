//! 学校系统选择器（抽象层）。
//!
//! 把「哪一所学校的教务系统、用哪套登录握手、打哪些接口」声明成**数据**而不是散落的 if/else。
//! 新增一所学校 = 在 [`REGISTRY`] 末尾加一条 [`SchoolSystemSpec`]：
//! 前端的选择器自动多出一个选项，登录表单按 [`LoginStrategy`] 自动渲染出对应字段，
//! 抓取流程按 [`EndpointSpec`] 自动走——三处都不用改。
//!
//! 与 `modules/voice` 的 ASR 适配器同思路（`AnyAsrAdapter` + `AsrAdapterKind::detect`），
//! 区别是那边的差异在**协议**（WS 帧格式、鉴权头），这边的差异在**站点与登录握手**。

use serde::Serialize;

/// 登录握手策略：一套固定的「取材料 → 混淆口令 → 提交 → 建会话」流程。
#[derive(Debug, Clone, Copy)]
pub enum LoginStrategy {
    /// 树维（Supwisdom）EAMS 门户：`/student/ldap/login`。
    ///
    /// `GET salt` → `RSA_PKCS1_v1_5(salt + "-" + password)` → `POST JSON` → **Cookie 会话**
    /// （不是 token；后续请求靠 `__pstsid__` / `SESSION` 两个 Cookie 认人）。
    SupwisdomPortalRsa {
        /// PKCS#8 SPKI DER 的 base64。这是登录页静态 JS 里公开硬编码的值，不是机密。
        public_key: &'static str,
        salt_path: &'static str,
        login_path: &'static str,
        captcha_path: &'static str,
        /// 会话探针：200 = 仍有效，302 = 已过期
        probe_path: &'static str,
    },
    /// 正方（ZFSoft）zftal：`/xtgl/login_slogin.html`。
    ///
    /// `GET 登录页`（拿 `csrftoken`，同时建会话）→ `GET login_getPublicKey.html`（modulus/exponent）
    /// → `RSA_PKCS1_v1_5(password)` → `POST 登录页`（`yhm` / `mm` / `csrftoken`）→ **Cookie 会话**。
    ///
    /// 与树维的三处关键差异都是实测结论，不是口味问题：
    /// 1. 公钥**每次登录现取**（`login_getPublicKey.html`），不写死在源码里；
    /// 2. 加密的是**裸口令**（树维要先拼 `salt-` 再加密）；
    /// 3. 提交必须带**该会话的** `csrftoken`，所以「取表单」这一步不能省。
    ZfsoftLoginRsa {
        /// 登录页：`GET` 取 `csrftoken`，`POST` 提交（同一个地址）
        login_path: &'static str,
        public_key_path: &'static str,
        captcha_path: &'static str,
        /// 会话探针：200 = 仍有效，302 = 已过期（正方用 302 回登录页表达「没登录」）
        probe_path: &'static str,
    },
}

impl LoginStrategy {
    /// 稳定标识，仅用于日志与诊断。
    pub fn id(&self) -> &'static str {
        match self {
            LoginStrategy::SupwisdomPortalRsa { .. } => "supwisdom-portal-rsa",
            LoginStrategy::ZfsoftLoginRsa { .. } => "zfsoft-login-rsa",
        }
    }

    pub fn login_path(&self) -> &'static str {
        match self {
            LoginStrategy::SupwisdomPortalRsa { login_path, .. } => login_path,
            LoginStrategy::ZfsoftLoginRsa { login_path, .. } => login_path,
        }
    }

    pub fn captcha_path(&self) -> &'static str {
        match self {
            LoginStrategy::SupwisdomPortalRsa { captcha_path, .. } => captcha_path,
            LoginStrategy::ZfsoftLoginRsa { captcha_path, .. } => captcha_path,
        }
    }

    pub fn probe_path(&self) -> &'static str {
        match self {
            LoginStrategy::SupwisdomPortalRsa { probe_path, .. } => probe_path,
            LoginStrategy::ZfsoftLoginRsa { probe_path, .. } => probe_path,
        }
    }

    /// 取 salt 的路径。**仅树维有这一步**：正方加密的是裸口令，没有盐。
    pub fn salt_path(&self) -> Option<&'static str> {
        match self {
            LoginStrategy::SupwisdomPortalRsa { salt_path, .. } => Some(salt_path),
            LoginStrategy::ZfsoftLoginRsa { .. } => None,
        }
    }

    /// 写死在登录页 JS 里的静态公钥。**仅树维有**：正方的公钥是运行时取回的。
    pub fn public_key(&self) -> Option<&'static str> {
        match self {
            LoginStrategy::SupwisdomPortalRsa { public_key, .. } => Some(public_key),
            LoginStrategy::ZfsoftLoginRsa { .. } => None,
        }
    }

    /// 取公钥的路径。**仅正方有**。
    pub fn public_key_path(&self) -> Option<&'static str> {
        match self {
            LoginStrategy::ZfsoftLoginRsa {
                public_key_path, ..
            } => Some(public_key_path),
            LoginStrategy::SupwisdomPortalRsa { .. } => None,
        }
    }
}

/// 树维 Supwisdom EAMS5 的接口表。`{sem}` / `{std}` 是占位符，由下面的方法展开。
#[derive(Debug, Clone, Copy)]
pub struct Eams5Endpoints {
    /// 课表页面：**学期列表的唯一来源**（树维没有独立的 semester-list API）
    pub course_table_page: &'static str,
    /// 课表数据（主数据源，路径里只有 semesterId，最稳）
    pub course_table_print: &'static str,
    /// 培养方案（响应体很大，按需拉取 + 落缓存）
    pub program_info: &'static str,
    /// **全校开课查询**入口页。它是独立的菜单项（`for-std-lesson-search:menu`），
    /// 与选课批次无关 —— 批次没开的时候照样能查全校开了哪些课。
    pub lesson_search_page: &'static str,
    /// 开课查询页面（带学生标识，路径里的数字就是 `studentId`）
    pub lesson_search_index: &'static str,
    /// 开课查询的数据接口：`/semester/{sem}/search/{std}`，返回分页的开课列表
    pub lesson_search_data: &'static str,
}

/// 正方 ZFSoft zftal 的接口表。它的课表是**一个页面 + 三个数据接口**，
/// 与树维那种「一个 semesterId 打天下」的形状完全不同，所以单独一张表。
#[derive(Debug, Clone, Copy)]
pub struct ZfsoftEndpoints {
    /// 学生课表页：**学年/学期下拉 + 学生档案**的来源
    pub course_table_page: &'static str,
    /// 课表数据：`POST xnm/xqm` → `{kbList, sjkList, xsxx, …}`
    pub timetable_data: &'static str,
    /// 节次时间表：`POST` → `[{jcmc:"1", qssj:"08:20", jssj:"09:00"}]`。
    /// 正方**不给**每条课的真实时刻，只给节次号 —— 时间要拿这张表查出来。
    pub slot_times: &'static str,
    /// 周次表：`POST xnm/xqm` → `[{zs:"1", rq:"2026-09-07/2026-09-13"}]`。
    /// 第 1 周的起止日就是整条链路的**学期锚点**（周次 → 公历日期的唯一依据）。
    pub weeks: &'static str,
    /// 菜单编号。写进课表接口的 `?gnmkdm=`：正方按它鉴权「这个角色能不能看这个菜单」。
    /// 少了它接口会静默回 `null`。N2151 = 学生课表查询。
    pub gnmkdm: &'static str,
}

/// 该校系统实际提供哪些接口。
///
/// 用 `Option` 而不是空串占位：**不支持的接口要能一眼看出来**，且取用时必须显式处理。
/// 空串会被当成有效路径打出去，拿到一个登录页 HTML，最后表现成「解析失败」那种误导性错误。
#[derive(Debug, Clone, Copy)]
pub struct EndpointSpec {
    /// 树维 EAMS5 那一套（`None` = 这个厂商不是树维）
    pub eams5: Option<Eams5Endpoints>,
    /// 正方 zftal 那一套（`None` = 这个厂商不是正方）
    pub zfsoft: Option<ZfsoftEndpoints>,
}

/// 开课查询数据接口里那些**逐字对齐教务**的固定参数。
///
/// `bizTypeAssoc=2` = 本科；`assembleFields` 要哪些附加列（少了它行里就没有
/// 开课院系 / 教师 / 时间地点这些列）。这两个值来自实测抓包，不要凭直觉改。
const LESSON_SEARCH_ASSEMBLE_FIELDS: &str = "course.code,minorCourse.nameZh,courseType,openDepartment,teacherAssignmentList,examMode,campus,teachLang,roomType,timeTableLayout,crossBizTypes,courseProperty";

impl ZfsoftEndpoints {
    /// `/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default`
    pub fn course_table_page_here(&self) -> String {
        format!(
            "{}?gnmkdm={}&layout=default",
            self.course_table_page, self.gnmkdm
        )
    }

    /// `/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151&doType=app`
    pub fn timetable_data_here(&self) -> String {
        format!("{}?gnmkdm={}&doType=app", self.timetable_data, self.gnmkdm)
    }

    /// `/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151`
    pub fn slot_times_here(&self) -> String {
        format!("{}?gnmkdm={}", self.slot_times, self.gnmkdm)
    }

    /// `/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2151`
    pub fn weeks_here(&self) -> String {
        format!("{}?gnmkdm={}", self.weeks, self.gnmkdm)
    }
}

impl Eams5Endpoints {
    /// `/student/for-std/course-table?bizTypeId=2`
    pub fn course_table_page_for(&self, biz_type_id: i64) -> String {
        format!("{}?bizTypeId={biz_type_id}", self.course_table_page)
    }

    /// `/student/for-std/course-table/semester/321/print-data?semesterId=321&hasExperiment=true`
    pub fn course_table_print_for(&self, semester_id: i64) -> String {
        let path = self
            .course_table_print
            .replace("{sem}", &semester_id.to_string());
        format!("{path}?semesterId={semester_id}&hasExperiment=true")
    }

    /// `/student/for-std/program/program-info-json?studentId=241250`
    pub fn program_info_for(&self, student_id: &str) -> String {
        format!("{}?studentId={student_id}", self.program_info)
    }

    /// `/student/for-std/lesson-search?bizTypeId=2`
    pub fn lesson_search_page_for(&self, biz_type_id: i64) -> String {
        format!("{}?bizTypeId={biz_type_id}", self.lesson_search_page)
    }

    /// `/student/for-std/lesson-search/index/241250`
    pub fn lesson_search_index_for(&self, student_id: &str) -> String {
        self.lesson_search_index.replace("{std}", student_id)
    }

    /// `/student/for-std/lesson-search/semester/321/search/241250?bizTypeAssoc=2&queryPage__=1,20&assembleFields=…`
    ///
    /// `queryPage__` 的写法是教务自己的约定（两个下划线，逗号分隔 `页码,每页条数`），
    /// 不是标准的 `page`/`size` —— 写错会被当成无参请求，静默返回第一页。
    pub fn lesson_search_data_for(
        &self,
        semester_id: i64,
        student_id: &str,
        biz_type_id: i64,
        page: i64,
        page_size: i64,
    ) -> String {
        let path = self
            .lesson_search_data
            .replace("{sem}", &semester_id.to_string())
            .replace("{std}", student_id);
        format!(
            "{path}?bizTypeAssoc={biz_type_id}&queryPage__={page},{page_size}&assembleFields={LESSON_SEARCH_ASSEMBLE_FIELDS}"
        )
    }
}

/// 学期口径。
#[derive(Debug, Clone, Copy)]
pub struct TermSpec {
    /// 培养层次：1=研究生 2=本科生。**树维的课表页与开课查询页都要这个参数**；
    /// 正方没有这个概念（它的学期就是「学年 + 学期代码」两个值），所以是 `Option`。
    pub biz_type_id: Option<i64>,
    /// 教务的「一周」从周日还是周一算起。决定周次 → 公历日期的偏移公式。
    pub week_start_on_sunday: bool,
}

/// 一所学校系统的完整声明。
#[derive(Debug, Clone, Copy)]
pub struct SchoolSystemSpec {
    /// 稳定键，落库在 `campus_accounts.system_kind`
    pub kind: &'static str,
    /// 选择器里显示的名字
    pub name: &'static str,
    /// 摘要入口用的一行短名（`name` 带产品线后缀，太长）
    pub short_name: &'static str,
    /// 显示用的厂商/产品线，帮用户确认自己学校是不是这一套
    pub vendor: &'static str,
    pub default_base_url: &'static str,
    /// 服务地址输入框下面那句话。**每所学校的说法不一样**（桂电默认指测试域，
    /// 广科大只有正式域），所以由 spec 声明，前端不写死。
    pub base_url_hint: &'static str,
    pub login: LoginStrategy,
    pub endpoints: EndpointSpec,
    pub term: TermSpec,
}

/// 前端选择器用的投影（`campus_systems` 命令的返回项）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchoolSystemInfo {
    pub kind: &'static str,
    pub name: &'static str,
    pub short_name: &'static str,
    pub vendor: &'static str,
    pub default_base_url: &'static str,
    pub base_url_hint: &'static str,
    /// 登录握手标识（"supwisdom-portal-rsa" / "zfsoft-login-rsa"），前端据此决定表单文案与字段
    pub login_strategy: &'static str,
    /// 培养层次（仅树维有；正方为 `null`）
    pub biz_type_id: Option<i64>,
    /// 登录过程中可能出现图形验证码，需要 UI 预留验证码输入位
    pub may_require_captcha: bool,
}

/// 桂林电子科技大学 · 本科生教学信息平台学生端。
///
/// 实测（2026-09，bkjwtest / bkjw 同一套系统）：
/// - 门户入口链路是 `v.guet.edu.cn` → `pcportal.guet.edu.cn/sopplus`，**但直连
///   `/student/ldap/login` 用同一套学号密码即可登录**，无需走门户——这正是免浏览器自动化的前提。
/// - 密码区分大小写且**不做任何 trim**：实测用户口令结尾的句点也是密码的一部分。
///   （口令本身不写进源码 —— 联调需要时用 `REIN_GUET_USER` / `REIN_GUET_PASS` 环境变量，
///   见 `guet.rs` 与 `course_select.rs` 里的 `#[ignore]` 实测用例。）
///
/// **本科教务有两个域名，但它们不是同一套系统**（2026-09 实测，逐路径比对）：
///
/// - `bkjwtest.guet.edu.cn` —— **树维 Supwisdom EAMS5**，也就是本文件声明并打通的那一套。
///   `/student/home` 302 到登录页、`/student/static/eams-ui/js/eams-ui.js` 200、
///   `/student/ldap/login-salt` 200 —— 握手与接口表全部对得上。
/// - `bkjw.guet.edu.cn` —— **另一套系统**：ASP.NET MVC + ExtJS 桌面（`Edu.view.*`、
///   `/?ticket=srv`），登录走统一身份认证 CAS（`cas.guet.edu.cn/cas/login?service=…`）。
///   它的 `/student/**` **全部 404**（连静态资源 `eams-ui.js` 也是 404，说明 EAMS5
///   根本没部署在这个域名上）。
///
/// 所以**不能**把 bkjw 声明成同一套 EAMS5 再设成默认：那样用户一登录就撞 404。
/// 这里只声明确实存在的那一套，默认域用能跑通的这个；bkjw 作为**候选域名**参与
/// [`GUET_DOMAINS`] 的探测（见 [`probe_hint`]），而不是被当成同构的第二个实例。
macro_rules! guet_spec {
    ($kind:literal, $name:literal, $vendor:literal, $base:literal) => {
        SchoolSystemSpec {
            kind: $kind,
            name: $name,
            short_name: "桂林电子科技大学",
            vendor: $vendor,
            default_base_url: $base,
            base_url_hint: "默认指向学校测试环境；切换到正式环境时改这里。",
            login: LoginStrategy::SupwisdomPortalRsa {
                public_key: "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCFY5N+9UX+0BF+xz1svFguI4CIDvmQTfINkOZ1HOO3ltBNHGQTUirUPQTyEph/+q/l8b16YYw3I2fyTH6y15s3tHf5jMei+R/20jFRGo5udwVJUwq/RozKQIRzCtPYkXG4YWBnHKhXalZ5K2fhd5i/QtB016nVugH/7eiBDWbKVwIDAQAB",
                salt_path: "/student/ldap/login-salt",
                login_path: "/student/ldap/login",
                captcha_path: "/student/ldap/login-captcha",
                probe_path: "/student/home",
            },
            endpoints: EndpointSpec {
                eams5: Some(Eams5Endpoints {
                    course_table_page: "/student/for-std/course-table",
                    course_table_print: "/student/for-std/course-table/semester/{sem}/print-data",
                    program_info: "/student/for-std/program/program-info-json",
                    lesson_search_page: "/student/for-std/lesson-search",
                    lesson_search_index: "/student/for-std/lesson-search/index/{std}",
                    lesson_search_data: "/student/for-std/lesson-search/semester/{sem}/search/{std}",
                }),
                zfsoft: None,
            },
            term: TermSpec {
                biz_type_id: Some(2),
                week_start_on_sunday: false,
            },
        }
    };
}

const GUET: SchoolSystemSpec = guet_spec!(
    "guet-supwisdom-eams5",
    "桂林电子科技大学 · 本科生教学信息平台",
    "树维 Supwisdom EAMS5 · 学生端 · bkjwtest.guet.edu.cn",
    "https://bkjwtest.guet.edu.cn"
);

/// 广西科技大学 · 教学管理信息平台（正方 ZFSoft zftal-ui-v5 学生端）。
///
/// 实测（2026-09，jwxt.gxust.edu.cn，全校代码 10594）：
/// - 登录页 `/xtgl/login_slogin.html` 的表单是 `yhm` + `mm`，且页面里 `mmsfjm=1`
///   —— 口令必须 RSA 加密（公钥来自 `/xtgl/login_getPublicKey.html`），
///   并带上**同一会话**的 `csrftoken`（隐藏域，值是 `uuid,去掉横线的 uuid`）。
/// - 课表是「页面 + 三个数据接口」：课表页给学年/学期下拉与学生档案，
///   `/kbcx/xskbcx_cxXsgrkb.html` 给 `kbList`，节次真实时刻在 `/kbcx/xskbcx_cxRjc.html`，
///   第 1 周的起止日在 `/kbcx/xskbcxZccx_cxZcByXnxq.html`。四个请求全部要 `?gnmkdm=N2151`。
/// - 密码不做任何 trim：同桂电，结尾的符号是口令的一部分。
///   （口令本身不写进源码 —— 联调需要时用 `REIN_GXUST_USER` / `REIN_GXUST_PASS`，
///   见 `zfsoft.rs` 里的 `#[ignore]` 实测用例。）
const GXUST: SchoolSystemSpec = SchoolSystemSpec {
    kind: "gxust-zfsoft-zftal",
    name: "广西科技大学 · 教学管理信息平台",
    short_name: "广西科技大学",
    vendor: "正方 ZFSoft zftal-ui-v5 · jwxt.gxust.edu.cn",
    default_base_url: "https://jwxt.gxust.edu.cn",
    base_url_hint: "学校正式教务地址；除非学校另行通知，不要改。",
    login: LoginStrategy::ZfsoftLoginRsa {
        login_path: "/xtgl/login_slogin.html",
        public_key_path: "/xtgl/login_getPublicKey.html",
        captcha_path: "/kaptcha",
        // 用户信息页：未登录时 302 回登录页，登录后 200（4KB，当探针足够轻）
        probe_path: "/xtgl/index_cxYhxxIndex.html",
    },
    endpoints: EndpointSpec {
        eams5: None,
        zfsoft: Some(ZfsoftEndpoints {
            course_table_page: "/kbcx/xskbcx_cxXskbcxIndex.html",
            timetable_data: "/kbcx/xskbcx_cxXsgrkb.html",
            slot_times: "/kbcx/xskbcx_cxRjc.html",
            weeks: "/kbcx/xskbcxZccx_cxZcByXnxq.html",
            gnmkdm: "N2151",
        }),
    },
    term: TermSpec {
        // 正方没有「培养层次」参数：它的学期就是学年 + 学期代码
        biz_type_id: None,
        // 实测 2026-09-07 ~ 2026-09-13 是第 1 周 —— 周一起算
        week_start_on_sunday: false,
    },
};

const REGISTRY: &[SchoolSystemSpec] = &[GUET, GXUST];

/// 本科教务的**候选域名**，供「两个域都检测」用。
///
/// 顺序即探测顺序：正式域在前（真在用的那套），EAMS5 部署在后。
/// 注意二者**不是同一套系统**（见文件头），所以探测结果要按域名分别汇报，
/// 不能互相兜底：一个域没有的接口，去另一个域也找不到。
pub const GUET_DOMAINS: [&str; 2] = ["https://bkjw.guet.edu.cn", "https://bkjwtest.guet.edu.cn"];

/// 规范化域名：去空白、去尾斜杠、转小写。
pub fn normalize_base(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_lowercase()
}

/// 抢课速率是在哪个域上标定的：`bkjwtest` 的风控比正式域松，
/// 拿它压出来的数字去正式域打，结论不成立 —— 设置页据此给出告警。
///
/// 判定的是「**不是**测试域」而不是「等于某个常量」：用户完全可能填一个
/// 反向代理域名，那种情况同样不该被当成测试域。
pub fn is_production_base(base_url: &str) -> bool {
    let b = normalize_base(base_url);
    !b.contains("bkjwtest")
}

/// 候选域名的**静态**提示：这条路是 EAMS5，那条路不是。
///
/// 只用于界面说明与探测排序 —— 真伪仍以运行时探测为准（[`super::lesson_search`]）。
pub fn probe_hint(base_url: &str) -> &'static str {
    if normalize_base(base_url).contains("bkjwtest") {
        "树维 EAMS5（本应用打通的那一套）"
    } else {
        "另一套系统（ASP.NET + ExtJS 桌面，登录走 CAS）"
    }
}

pub fn spec(kind: &str) -> Option<&'static SchoolSystemSpec> {
    REGISTRY.iter().find(|s| s.kind == kind)
}

pub fn list_info() -> Vec<SchoolSystemInfo> {
    REGISTRY
        .iter()
        .map(|s| SchoolSystemInfo {
            kind: s.kind,
            name: s.name,
            short_name: s.short_name,
            vendor: s.vendor,
            default_base_url: s.default_base_url,
            base_url_hint: s.base_url_hint,
            login_strategy: s.login.id(),
            biz_type_id: s.term.biz_type_id,
            may_require_captcha: true,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lookup_roundtrip() {
        // 在册的是**真跑得通的那两套系统**：桂电（树维 EAMS5）与广科大（正方 zftal）。
        // 桂电的 bkjw 是另一套系统，不能当同构实例混进来 —— 它由 GUET_DOMAINS
        // 参与探测，不在 REGISTRY 里。
        assert_eq!(list_info().len(), 2, "桂电 EAMS5 + 广科大正方都在册");
        let guet = spec("guet-supwisdom-eams5").expect("桂电必须在册");
        assert!(spec("nope").is_none());
        assert_eq!(guet.term.biz_type_id, Some(2));
        assert_eq!(list_info()[0].login_strategy, "supwisdom-portal-rsa");
        // 摘要入口只显示短名；短名必须是不带产品线后缀的可读校名
        assert_eq!(guet.short_name, "桂林电子科技大学");
        assert_eq!(list_info()[0].short_name, guet.short_name);
    }

    /// 广科大（正方）必须**声明成正方那一套**，而不是被硬塞进树维的形状里。
    ///
    /// 两套系统的登录握手与接口表完全不同：认错了的话，登录会在「取 salt」这一步
    /// 就 404（正方没有 `/student/ldap/*`），或者更糟 —— 拿到一个 200 的登录页 HTML
    /// 再当成 JSON 解析，最后表现成一句看不懂的「课表数据解析失败」。
    #[test]
    fn gxust_is_declared_as_zfsoft_not_as_eams5() {
        let gxust = spec("gxust-zfsoft-zftal").expect("广科大必须在册");
        assert_eq!(gxust.login.id(), "zfsoft-login-rsa");
        // 正方的公钥是运行时取的（页面上没有写死的公钥），盐步骤也不存在
        assert!(gxust.login.public_key().is_none());
        assert!(gxust.login.salt_path().is_none());
        assert_eq!(
            gxust.login.public_key_path(),
            Some("/xtgl/login_getPublicKey.html")
        );
        // 接口表必须只声明正方那一套：混着声明会让「这个接口不存在」变成运行时才发现
        assert!(gxust.endpoints.eams5.is_none(), "正方不该声明 EAMS5 接口");
        let z = gxust.endpoints.zfsoft.expect("正方接口表");
        assert_eq!(z.gnmkdm, "N2151", "课表接口的菜单编号，少了它回 null");
        // 正方没有培养层次参数 —— 学期是「学年 + 学期代码」
        assert!(gxust.term.biz_type_id.is_none());
        // 实测 2026-09-07（周一）是第 1 周起点
        assert!(!gxust.term.week_start_on_sunday);
        assert_eq!(gxust.short_name, "广西科技大学");
        assert_eq!(gxust.default_base_url, "https://jwxt.gxust.edu.cn");
    }

    /// 两个厂商的接口表模板各自展开正确（互不污染）。
    #[test]
    fn gxust_endpoint_templates_expand() {
        let z = spec("gxust-zfsoft-zftal").unwrap().endpoints.zfsoft.unwrap();
        assert_eq!(
            z.timetable_data_here(),
            "/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151&doType=app"
        );
        assert_eq!(z.slot_times_here(), "/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151");
        assert_eq!(z.weeks_here(), "/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2151");
        assert_eq!(
            z.course_table_page_here(),
            "/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default"
        );
    }

    /// **默认域必须是真跑得通的那一个**。
    ///
    /// 这条断言防的是一类很贵的错：把「本科教务的正式域名」按名字想当然地当成
    /// EAMS5 的部署地址。实测 `bkjw.guet.edu.cn` 是另一套系统（ASP.NET + ExtJS 桌面，
    /// 登录走 CAS），它的 `/student/**` 全部 404 —— 一旦把它设成默认，
    /// 新装用户填完学号密码就直接撞 404。
    #[test]
    fn the_default_domain_is_the_one_that_actually_serves_eams5() {
        let guet = spec("guet-supwisdom-eams5").unwrap();
        assert_eq!(
            guet.default_base_url, "https://bkjwtest.guet.edu.cn",
            "默认域必须是实测能跑通 EAMS5 握手的那一个"
        );
        assert_eq!(list_info()[0].kind, "guet-supwisdom-eams5");
        assert_eq!(list_info()[0].default_base_url, guet.default_base_url);
    }

    /// 两个候选域名都要能被探测，且顺序稳定（正式域在前）。
    #[test]
    fn both_candidate_domains_are_probeable() {
        assert_eq!(GUET_DOMAINS.len(), 2);
        assert_eq!(GUET_DOMAINS[0], "https://bkjw.guet.edu.cn");
        assert_eq!(GUET_DOMAINS[1], "https://bkjwtest.guet.edu.cn");
        assert!(probe_hint(GUET_DOMAINS[0]).contains("另一套系统"));
        assert!(probe_hint(GUET_DOMAINS[1]).contains("EAMS5"));
    }

    /// 域名规范化：带尾斜杠 / 大小写 / 空白都必须归一到同一个判定。
    #[test]
    fn base_normalisation_is_forgiving() {
        assert_eq!(
            normalize_base("  HTTPS://BkjwTest.GUET.edu.cn/  "),
            "https://bkjwtest.guet.edu.cn"
        );
        assert_eq!(
            normalize_base("https://bkjwtest.guet.edu.cn"),
            "https://bkjwtest.guet.edu.cn"
        );
    }

    /// 抢课速率告警的判定：**测试域不算生产**，其余（含自建反代）都按生产对待。
    #[test]
    fn production_flag_only_excludes_the_test_domain() {
        assert!(!is_production_base("https://bkjwtest.guet.edu.cn"));
        assert!(!is_production_base("https://bkjwtest.guet.edu.cn/"));
        assert!(is_production_base("https://bkjw.guet.edu.cn"));
        assert!(is_production_base("https://example.edu.cn"));
    }

    #[test]
    fn endpoint_templates_expand() {
        let e = GUET.endpoints.eams5.expect("桂电是树维那一套");
        assert_eq!(
            e.course_table_page_for(2),
            "/student/for-std/course-table?bizTypeId=2"
        );
        assert_eq!(
            e.course_table_print_for(321),
            "/student/for-std/course-table/semester/321/print-data?semesterId=321&hasExperiment=true"
        );
        assert_eq!(
            e.program_info_for("241250"),
            "/student/for-std/program/program-info-json?studentId=241250"
        );
    }
}
