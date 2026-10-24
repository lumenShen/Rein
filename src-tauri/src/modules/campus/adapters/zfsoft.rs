//! 广西科技大学（正方 ZFSoft zftal-ui-v5）适配器。
//!
//! 每个函数都对应一次**实测验证过**的真实请求（2026-09，`jwxt.gxust.edu.cn`，
//! 学校代码 10594），注释里的字段名与字节数都来自线上响应 —— 改接口前先对照注释，
//! 别凭直觉猜。测验口径：14 个教学班 / 23 条上课时段 / 第 1 周 = 2026-09-07。
//!
//! 与树维（`guet.rs`）的关系：**只共用 [`super::dates`] 的学期换算**，抓取逻辑一行不复用 ——
//! 两套系统的登录握手、数据形状、字段命名没有一处相同。硬套一套抽象只会得到
//! 一堆「树维是 JSON、正方是表单」的分支判断，不如各自写清楚。

use std::collections::HashMap;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::NaiveDate;
use serde_json::Value;

use crate::error::{ReinError, Result};

use super::dates::parse_ymd;
use super::http::{guard, rsa_encrypt_password_with_key, HttpResponse, Session};
use super::models::{
    lenient_f64, lenient_i64, LoginOutcome, PageVars, RemoteNamed, RemotePeriodSlot,
    RemoteSemester, TimetableActivity, TimetableSnapshot, ZfsoftKbResponse, ZfsoftKbRow,
    ZfsoftSlotRow, ZfsoftWeekRow,
};
use super::provider::{SchoolSystemSpec, ZfsoftEndpoints};

/// 登录表单里的固定项。逐字对齐登录页的 `<input type="hidden">` 与表单控件名。
const LOGIN_LANGUAGE: &str = "zh_CN";
const CSRF_FIELD: &str = "csrftoken";

/* ─────────────────────────── 纯函数（可单测） ─────────────────────────── */

/// 正方学期 id 的编码：`xnm * 100 + xqm`（2026 学年第一学期 → `202603`）。
///
/// 教务的学期是「学年 + 学期代码」**两个**值（`xnm=2026`、`xqm=3`），而全项目的学期契约
/// 是一个 i64（`campus_semesters.remote_id`）。这里做一次可逆编码，
/// 课表链路的下游就完全不必知道正方的这套编码方式。
pub fn encode_semester(xnm: i64, xqm: i64) -> i64 {
    xnm * 100 + xqm
}

/// [`encode_semester`] 的逆运算。
pub fn decode_semester(id: i64) -> (i64, i64) {
    (id / 100, id % 100)
}

/// 学年文本：`2026` → `"2026-2027"`（正方的学年就是起始年）。
pub fn school_year_of(xnm: i64) -> String {
    format!("{xnm}-{}", xnm + 1)
}

/// `xqm` → 树维口径的 season。
///
/// 借它复用 [`super::dates::season_cn`] 的中文名（`3` → 第一学期），于是两个厂商的
/// 学期显示名是同一句话，而不是各拼一套。实测这个学校只用 3 / 12 两个值。
pub fn season_of(xqm: i64) -> Option<&'static str> {
    match xqm {
        3 => Some("AUTUMN"),
        12 => Some("SPRING"),
        16 => Some("SUMMER"),
        _ => None,
    }
}

/// 学期代码（落库在 `campus_semesters.code`，也方便人工核对）：`2026-2027_1`。
///
/// 与树维的 `code` 形状对齐（那边的实测值是 `2026-2027_1`）——
/// 两家学校的代码在库里看起来该像同一类东西，而不是各写各的。
pub fn semester_code(xnm: i64, xqm: i64) -> String {
    let term = match xqm {
        3 => "1".to_string(),
        12 => "2".to_string(),
        other => other.to_string(),
    };
    format!("{}_{}", school_year_of(xnm), term)
}

/// 周次文本 → 教学周序号（升序、去重）。
///
/// 实测三种写法：`"6-18周"`、`"13周"`、`"6-12周,14-16周"`。
/// 单双周后缀（`(单)` / `（双）`）必须处理：它在文本里是**取模条件**，
/// 漏掉就会把课显示在不上课的那几周里 —— 那是实打实的错课表。
pub fn parse_week_indexes(zcd: &str) -> Vec<i64> {
    let mut out: Vec<i64> = Vec::new();
    for raw in zcd.split([',', '，', ';', '；']) {
        let part = raw.trim();
        if part.is_empty() {
            continue;
        }
        // 单周 = 奇数周，双周 = 偶数周（正方的写法）
        let parity = if part.contains('单') {
            Some(1)
        } else if part.contains('双') {
            Some(0)
        } else {
            None
        };
        let body: String = part
            .chars()
            .filter(|c| !matches!(c, '(' | '（' | ')' | '）' | '单' | '双' | '周' | ' ' | '\t'))
            .collect();
        if body.is_empty() {
            continue;
        }
        let (from, to) = match body.split_once('-') {
            Some((a, b)) => match (a.trim().parse::<i64>(), b.trim().parse::<i64>()) {
                (Ok(a), Ok(b)) => (a, b),
                _ => continue,
            },
            None => match body.trim().parse::<i64>() {
                Ok(n) => (n, n),
                Err(_) => continue,
            },
        };
        for w in from..=to {
            if w < 1 {
                continue;
            }
            if parity.is_some_and(|p| w % 2 != p) {
                continue;
            }
            out.push(w);
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// 周次位掩码 → 周序号（第 n 周 = 第 n-1 位）。
///
/// 实测与 `zcd` 逐位一致（`"6-18周"` ↔ `262112`）。它是 `zcd` 解析失败时的兜底，
/// 不是主来源：教务网格显示的是 `zcd`，两者若有分歧以文本为准。
pub fn week_mask_to_indexes(mask: &Value) -> Option<Vec<i64>> {
    let m = lenient_i64(mask)?;
    if m <= 0 {
        return None;
    }
    let out: Vec<i64> = (0..63)
        .filter(|i| (m >> i) & 1 == 1)
        .map(|i| i + 1)
        .collect();
    (!out.is_empty()).then_some(out)
}

/// 节次文本 `"1-2"` → `(1, 2)`；单节 `"5"` → `(5, 5)`。
pub fn parse_unit_range(jcs: &str) -> Option<(i64, i64)> {
    let t = jcs.trim();
    if t.is_empty() {
        return None;
    }
    match t.split_once('-') {
        Some((a, b)) => Some((a.trim().parse().ok()?, b.trim().parse().ok()?)),
        None => {
            let n = t.parse().ok()?;
            Some((n, n))
        }
    }
}

/// 教学班 id → 稳定的 i64 课程标识。
///
/// 正方的教学班 id 是 **32 位 hex UUID**（`55AB309EAA31780DE0637EA0FE0A2A3B`），放不进 i64，
/// 而全项目的课程标识就是 i64（`campus_courses.remote_lesson_id`，冲突键的一半）。
/// 这里用 FNV-1a 64 位做一次**确定性**哈希：同一个教学班每次同步得到同一个值
/// （同步幂等，不会重复建课），一个学生一学期十几门课，撞车概率可忽略。
pub fn stable_lesson_id(jxb_id: &str) -> i64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in jxb_id.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (hash & 0x7fff_ffff_ffff_ffff) as i64
}

/// 正方的教师是**逗号分隔的一个字符串**（「张庆金,纪芳芳」），拆成数组。
fn split_teachers(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("")
        .split([',', '，', '、'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// 取标签内的属性值（`value="2026"`）。
fn attr(tag: &str, name: &str) -> Option<String> {
    let key = format!("{name}=\"");
    let at = tag.find(&key)? + key.len();
    let rest = &tag[at..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// 去标签：只处理教务页面那种简单结构（`<span class="x"></span>文字`）。
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut depth = 0usize;
    for ch in html.chars() {
        match ch {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}

/// 下拉里的一个选项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectOption {
    pub value: i64,
    pub label: String,
    pub selected: bool,
}

/// 刮某个 `<select id="…">` 里的选项（只保留值能解析成整数的项）。
fn options_of(html: &str, id: &str) -> Vec<SelectOption> {
    let Some(at) = html.find(&format!("id=\"{id}\"")) else {
        return Vec::new();
    };
    let Some(close) = html[at..].find("</select>") else {
        return Vec::new();
    };
    let mut rest = &html[at..at + close];
    let mut out = Vec::new();
    while let Some(i) = rest.find("<option") {
        rest = &rest[i..];
        let Some(gt) = rest.find('>') else { break };
        let tag = &rest[..gt];
        let body = &rest[gt + 1..];
        let Some(end) = body.find("</option>") else {
            break;
        };
        if let Some(value) = attr(tag, "value").and_then(|v| v.trim().parse::<i64>().ok()) {
            out.push(SelectOption {
                value,
                label: strip_tags(&body[..end]).trim().to_string(),
                selected: tag.contains("selected"),
            });
        }
        rest = &body[end + "</option>".len()..];
    }
    out
}

/// 从登录页里取 `csrftoken` 隐藏域的值。
///
/// 值是**两段式**（`uuid,去掉横线的uuid`，Spring 的 `CsrfToken` 写法）。
/// 必须整串原样提交 —— 只取逗号前那一段会被判成无效令牌，而失败表现是
/// 「登录页重新渲染」，看起来跟密码错了一模一样。
fn extract_csrf(html: &str) -> Option<String> {
    let at = html.find("id=\"csrftoken\"")?;
    let tag_end = html[at..].find('>').map(|i| at + i)?;
    let value = attr(&html[at..tag_end], "value")?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// 刮 `#tips` 里的提示文字（登录被拒时教务把原因写在这里）。
fn extract_tip(html: &str) -> Option<String> {
    let at = html.find("id=\"tips\"")?;
    let tag_end = html[at..].find('>').map(|i| at + i)?;
    let body = &html[tag_end + 1..];
    let end = body.find("</p>")?;
    let text = strip_tags(&body[..end])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!text.is_empty()).then_some(text)
}

/// 登录被拒时的结论：给人看的文案、要不要去网页端处理、是不是缺验证码。
///
/// 教务的原话（实测「用户名或密码不正确，请重新输入！」）一律原样透传 ——
/// 用户据此就能分清是密码打错了还是账号被锁了。只有它什么都没说时才兜底，
/// 因为**沉默的失败等于没有引导**（这条以前吃过亏）。
fn login_failure(page: &str) -> (String, Option<String>, bool) {
    let text = extract_tip(page).unwrap_or_default();
    if text.is_empty() {
        return (
            "登录被拒绝：请核对学号与密码（教务系统没有返回具体原因）".to_string(),
            None,
            false,
        );
    }
    let need_captcha = text.contains("验证码");
    (text, None, need_captcha)
}

/// 表单体。百分号编码按字节做：密文里的 `+` `/` `=` 都必须转义，否则会被当成空格/分隔符。
fn form_body(fields: &[(&str, &str)]) -> String {
    fn enc(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for b in s.as_bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    out.push(*b as char)
                }
                b' ' => out.push('+'),
                _ => out.push_str(&format!("%{b:02X}")),
            }
        }
        out
    }
    fields
        .iter()
        .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// 一个学期的周历（第 1 周的周一 ~ 最后一周的周日）。
///
/// **这是课表能落到日历上的唯一依据**：教务只给「第 N 教学周 + 星期几」，
/// 没有这个锚点，整学期的课都算不出日期。
struct WeekMap {
    start: NaiveDate,
    end: NaiveDate,
}

/* ─────────────────────────── 适配器 ─────────────────────────── */

pub struct ZfsoftAdapter<'a> {
    pub spec: &'static SchoolSystemSpec,
    pub session: &'a mut Session,
}

impl<'a> ZfsoftAdapter<'a> {
    pub fn new(spec: &'static SchoolSystemSpec, session: &'a mut Session) -> Self {
        Self { spec, session }
    }

    fn endpoints(&self) -> Result<ZfsoftEndpoints> {
        self.spec.endpoints.zfsoft.ok_or_else(|| {
            ReinError::Message(format!("{} 的接口表里没有正方那一套", self.spec.kind))
        })
    }

    /// 会话探针：`GET /xtgl/index_cxYhxxIndex.html`。200 = 仍有效，302 = 被踢回登录页。
    pub fn probe_session(&mut self) -> Result<bool> {
        let resp = self.session.get(self.spec.login.probe_path())?;
        Ok(resp.is_ok())
    }

    /// 取验证码前的会话预热。**正方不需要预热**：`/kaptcha` 本身就会 Set-Cookie，
    /// 而 `csrftoken` 是在真正提交时才现取（见 [`Self::login`]）。
    /// 留这个空实现是为了让命令层不必按学校分叉。
    pub fn warm_login_session(&mut self) -> Result<()> {
        Ok(())
    }

    /// 拉取图形验证码（原始 JPEG 字节的 base64，前端自行拼 `data:` URL）。
    ///
    /// 正方的验证码是 `/kaptcha?time=…`，本身不绑会话（实测匿名也能取到）；
    /// 但提交时必须与取图在同一个会话里，所以这里仍走当前会话。
    pub fn fetch_captcha(&mut self) -> Result<String> {
        let path = format!(
            "{}?time={}",
            self.spec.login.captcha_path(),
            chrono::Utc::now().timestamp_millis()
        );
        let resp = self.session.get(&path)?;
        guard(&resp, "获取验证码")?;
        Ok(STANDARD.encode(&resp.body))
    }

    /// 完整登录握手。
    ///
    /// 与登录页 `login.js` 的 `#dl` 点击处理逐段对应：
    /// 取 `csrftoken` → 取公钥 → `RSA_PKCS1_v1_5(裸口令)` → 表单 POST。
    ///
    /// 页面在提交前还会打一次 `login_logoutAccount.html`（清掉浏览器里遗留的旧会话），
    /// **这里不跟**：我们的会话 jar 每次登录都是新建的（见 `commands::relogin` / `campus_login`），
    /// 它对我们永远是空操作，只会多一次往返。
    pub fn login(&mut self, login_name: &str, password: &str, captcha: &str) -> Result<LoginOutcome> {
        let login_path = self.spec.login.login_path();

        // ① 登录页：csrftoken + 初始会话 Cookie（这两样必须来自同一次响应）
        let form = self.session.get(login_path)?;
        guard(&form, "获取登录页")?;
        let csrf = extract_csrf(&form.text()).ok_or_else(|| {
            ReinError::Message("登录页结构变化：找不到 csrftoken 隐藏域".into())
        })?;

        // ② 公钥：**每次登录现取**（正方会轮换，写死会突然全部登录失败）
        let pk_path = self.spec.login.public_key_path().ok_or_else(|| {
            ReinError::Message("该校系统的登录策略里没有公钥地址（声明错了？）".into())
        })?;
        let pk_resp = self
            .session
            .get(&format!("{pk_path}?time={}", chrono::Utc::now().timestamp_millis()))?;
        guard(&pk_resp, "获取登录公钥")?;
        let pk = pk_resp.json()?;
        let modulus = pk.get("modulus").and_then(Value::as_str).unwrap_or("");
        let exponent = pk.get("exponent").and_then(Value::as_str).unwrap_or("");
        if modulus.trim().is_empty() || exponent.trim().is_empty() {
            return Err(ReinError::Message(
                "登录公钥为空，教务系统可能已改版".into(),
            ));
        }

        // ③ PKCS#1 v1.5 加密**裸口令**（与树维不同：那边要先拼 salt）
        let encrypted = rsa_encrypt_password_with_key(modulus, exponent, password)?;

        // ④ 提交。字段与顺序逐字对齐登录页表单：`mm` 出现两次是页面本来的样子
        //    （一个隐藏的 password 框 + 一个可见的 text 框，提交前都会被写成同一串密文）。
        let mut fields = vec![
            (CSRF_FIELD, csrf.as_str()),
            ("language", LOGIN_LANGUAGE),
            ("ydType", ""),
            ("yhm", login_name),
            ("mm", encrypted.as_str()),
            ("mm", encrypted.as_str()),
        ];
        let captcha = captcha.trim();
        if !captcha.is_empty() {
            fields.push(("yzm", captcha));
        }
        let body = form_body(&fields);
        let resp = self.session.request(
            "POST",
            &format!("{login_path}?time={}", chrono::Utc::now().timestamp_millis()),
            Some(login_path),
            &[],
            Some((
                "application/x-www-form-urlencoded; charset=UTF-8",
                body.into_bytes(),
            )),
        )?;

        // ⑤ 判定 —— 正方的成功判定与直觉相反，实测两次确认：
        //    **302 = 登录成功**（重定向回登录页**本身**；该页对已登录会话会再跳到菜单页），
        //    **200 = 被拒**（登录页就地重渲染，原因写在 `#tips` 里）。
        //    所以「看到 302 回登录页就当失败」会**把成功判成失败**。
        if resp.is_redirect() {
            return Ok(LoginOutcome {
                ok: true,
                message: None,
                need_captcha: false,
                action_required: None,
                account: None,
            });
        }
        if !resp.is_ok() {
            return Err(ReinError::Message(format!("登录失败：HTTP {}", resp.status)));
        }
        let (message, action_required, need_captcha) = login_failure(&resp.text());
        Ok(LoginOutcome {
            ok: false,
            message: Some(message),
            need_captcha,
            action_required,
            account: None,
        })
    }

    /// 刮课表页面上的变量：学年/学期下拉 —— **学期列表的唯一来源**
    /// （正方也没有独立的 semester-list 接口）。
    ///
    /// 下拉里列着建校以来的全部学年（实测 2002–2026），但对一个学生有意义的只有
    /// 当前学年附近那几个；而且**每个学期都要额外打一次周次表**才能拿到起止日期
    /// （没有日期，落库那一步会把它直接丢掉，界面上看就是「学期没了」）。
    /// 所以只取**所选学年 ±1**，再加调用方指定的那个学期（用户可能翻回很老的学期，
    /// 少了它，选择会静默落到别的学期上 —— 那比报错更糟）。
    pub fn fetch_page_vars(&mut self, wanted: Option<i64>) -> Result<PageVars> {
        let ep = self.endpoints()?;
        let resp = self.session.get(&ep.course_table_page_here())?;
        guard(&resp, "获取课表页面")?;
        let html = resp.text();

        let years = options_of(&html, "xnm");
        let terms = options_of(&html, "xqm");
        if years.is_empty() || terms.is_empty() {
            return Err(ReinError::Message(
                "课表页面结构变化：找不到学年/学期下拉".into(),
            ));
        }
        // 页面自己选中的那个学年就是教务认的「当前学年」；没有 selected 时退到最大值
        let focus = years
            .iter()
            .find(|y| y.selected)
            .map(|y| y.value)
            .unwrap_or_else(|| years.iter().map(|y| y.value).max().unwrap_or(0));
        let mut min_year = focus - 1;
        let mut max_year = focus + 1;
        if let Some(w) = wanted {
            let (wy, _) = decode_semester(w);
            min_year = min_year.min(wy);
            max_year = max_year.max(wy);
        }

        let mut semesters = Vec::new();
        let mut last_err: Option<ReinError> = None;
        for year in years
            .iter()
            .map(|y| y.value)
            .filter(|y| *y >= min_year && *y <= max_year)
        {
            for term in terms.iter().map(|t| t.value) {
                match self.fetch_week_map(year, term) {
                    Ok(Some(map)) => semesters.push(RemoteSemester {
                        id: encode_semester(year, term),
                        code: Some(semester_code(year, term)),
                        name_en: None,
                        school_year: Some(school_year_of(year)),
                        start_date: Some(map.start.format("%Y-%m-%d").to_string()),
                        end_date: Some(map.end.format("%Y-%m-%d").to_string()),
                        week_start_on_sunday: Some(self.spec.term.week_start_on_sunday),
                        season: season_of(term).map(str::to_string),
                    }),
                    // 该学期没有周历（学校还没排/已归档）—— 没有锚点就无法使用，跳过
                    Ok(None) => {}
                    Err(e) => last_err = Some(e),
                }
            }
        }
        if semesters.is_empty() {
            return Err(last_err.unwrap_or_else(|| {
                ReinError::Message("教务没有返回任何可用学期（周历为空）".into())
            }));
        }
        Ok(PageVars { semesters })
    }

    /// 课表数据（主数据源）。
    ///
    /// 三个请求拼出一次完整课表：`kbList`（课程与节次号）+ 节次时间表（节次 → 时刻）
    /// + `xsxx`（学生档案，就在同一个响应里）。
    pub fn fetch_timetable(&mut self, semester_id: i64) -> Result<TimetableSnapshot> {
        let ep = self.endpoints()?;
        let (xnm, xqm) = decode_semester(semester_id);
        let referer = ep.course_table_page_here();

        let body = form_body(&[
            ("xnm", &xnm.to_string()),
            ("xqm", &xqm.to_string()),
            ("doType", "app"),
            // 课表类型 1 = 学生个人课表（与页面上的默认选项一致）
            ("kblx", "1"),
        ]);
        let resp = self.post_form(&ep.timetable_data_here(), &referer, body)?;
        guard(&resp, "获取课表数据")?;
        let parsed: ZfsoftKbResponse = serde_json::from_value(resp.json()?)
            .map_err(|e| ReinError::Message(format!("课表数据解析失败：{e}")))?;

        // 节次 → 真实时刻。**课表响应里没有时间**，只有节次号；缺了这张表，
        // 下面每条时段都会因为「缺时间」被落库逻辑跳过，同步结果是 0 个时段 ——
        // 所以它拿不到就直接报错，而不是安静地同步出一张空课表。
        let slots = self.fetch_slot_times(xnm, xqm)?;
        if slots.is_empty() {
            return Err(ReinError::Message(
                "教务没有返回节次时间表，无法把节次换算成上课时间".into(),
            ));
        }
        // 同一份表既用来算每条课的封套，也随快照落库：前端的左侧时间轴要画到逐节
        // （第1节 08:00-08:40），光有封套画不出来。所以两张形状都得从它派生，别抓第二遍。
        let period_slots = to_period_slots(&slots);

        let mut activities: Vec<TimetableActivity> = parsed
            .kb_list
            .iter()
            .map(|row| to_activity(row, &slots))
            .collect();

        // 实践课只有起止周次，没有星期与节次 —— 上不了课表网格。**仍然交给落库方**：
        // 它会被算进 `skipped_activities`，界面上就能说清「有几条没能落到日历上」，
        // 而不是无声地消失。
        for row in &parsed.sjk_list {
            activities.push(TimetableActivity {
                lesson_id: row.kcmc.as_deref().map(stable_lesson_id),
                course_name: row.kcmc.clone(),
                teachers: split_teachers(row.jsxm.as_deref()),
                weeks_str: row.qsjsz.clone(),
                week_indexes: row
                    .qsjsz
                    .as_deref()
                    .map(parse_week_indexes)
                    .unwrap_or_default(),
                ..Default::default()
            });
        }

        let xsxx = parsed.xsxx.unwrap_or_default();
        Ok(TimetableSnapshot {
            student_id: xsxx.id.clone().or_else(|| xsxx.code.clone()),
            student_code: xsxx.code,
            student_name: xsxx.name,
            // 正方的课表响应里没有学院字段（`zyxx` 那一套在别的页面），留空不猜
            department: None,
            major: xsxx.major,
            adminclass: xsxx.adminclass,
            grade: xsxx.grade,
            // 已修学分同理：正方要另开页面算，这里不拿课表几门课的学分去冒充
            total_credits: None,
            activities,
            period_slots,
        })
    }

    /// 培养方案：**正方这边没有对应接口**（树维的 `program-info-json` 是它家专有）。
    /// 明确报错而不是返回空，免得界面显示一张空白页让人以为「教务没数据」。
    pub fn fetch_program_info(&mut self, _student_id: &str) -> Result<Value> {
        Err(ReinError::Message(
            "广西科技大学的正方教务系统没有培养方案接口，本应用暂不支持查看培养方案".into(),
        ))
    }

    /* ---------------- 内部：三个数据接口 ---------------- */

    /// 表单 POST：正方的数据接口全是 `application/x-www-form-urlencoded`，
    /// 且**必须带对 Referer**（教务按它判断「你是从哪个菜单点进来的」）。
    fn post_form(&mut self, path: &str, referer: &str, body: String) -> Result<HttpResponse> {
        self.session.request(
            "POST",
            path,
            Some(referer),
            &[],
            Some((
                "application/x-www-form-urlencoded; charset=UTF-8",
                body.into_bytes(),
            )),
        )
    }

    /// 周次表：该学期每一周的起止日期。`None` = 教务对这个学期没有周历。
    fn fetch_week_map(&mut self, xnm: i64, xqm: i64) -> Result<Option<WeekMap>> {
        let ep = self.endpoints()?;
        let referer = ep.course_table_page_here();
        let body = form_body(&[("xnm", &xnm.to_string()), ("xqm", &xqm.to_string())]);
        let resp = self.post_form(&ep.weeks_here(), &referer, body)?;
        guard(&resp, "获取周次表")?;
        let text = resp.text();
        // 正方的「无可查数据」是字面量 null（HTTP 200）
        if text.trim() == "null" {
            return Ok(None);
        }
        let rows: Vec<ZfsoftWeekRow> = serde_json::from_value(resp.json()?)
            .map_err(|e| ReinError::Message(format!("周次表解析失败：{e}")))?;
        let mut weeks: Vec<(i64, NaiveDate, NaiveDate)> = rows
            .iter()
            .filter_map(|r| {
                let zs = r.zs.as_deref()?.trim().parse::<i64>().ok()?;
                let (a, b) = r.rq.as_deref()?.split_once('/')?;
                Some((zs, parse_ymd(a)?, parse_ymd(b)?))
            })
            .collect();
        if weeks.is_empty() {
            return Ok(None);
        }
        weeks.sort_by_key(|(zs, _, _)| *zs);
        Ok(Some(WeekMap {
            start: weeks[0].1,
            end: weeks[weeks.len() - 1].2,
        }))
    }

    /// 节次时间表：`{jcmc:"1", qssj:"08:20", jssj:"09:00"}` → `节次 → (起, 止)`。
    fn fetch_slot_times(&mut self, xnm: i64, xqm: i64) -> Result<HashMap<i64, (String, String)>> {
        let ep = self.endpoints()?;
        let referer = ep.course_table_page_here();
        let body = form_body(&[("xnm", &xnm.to_string()), ("xqm", &xqm.to_string())]);
        let resp = self.post_form(&ep.slot_times_here(), &referer, body)?;
        guard(&resp, "获取节次时间表")?;
        let rows: Vec<ZfsoftSlotRow> = serde_json::from_value(resp.json()?)
            .map_err(|e| ReinError::Message(format!("节次时间表解析失败：{e}")))?;
        let mut map = HashMap::new();
        for r in &rows {
            let unit = r
                .jcmc
                .as_deref()
                .map(str::trim)
                .and_then(|s| s.parse::<i64>().ok());
            let from = r.qssj.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let to = r.jssj.as_deref().map(str::trim).filter(|s| !s.is_empty());
            if let (Some(unit), Some(from), Some(to)) = (unit, from, to) {
                map.insert(unit, (from.to_string(), to.to_string()));
            }
        }
        Ok(map)
    }
}

/// 节次表（`节次 → (起, 止)`）→ 归一化形状，**按节次升序**。
///
/// 排序放在这里而不是落库方：这张表是前端的行轴来源，顺序错了左列的时刻就会跳来跳去；
/// `HashMap` 的迭代顺序不定，依赖它等于让每次同步画出来的课表都不一样。
fn to_period_slots(slots: &HashMap<i64, (String, String)>) -> Vec<RemotePeriodSlot> {
    let mut out: Vec<RemotePeriodSlot> = slots
        .iter()
        .map(|(unit, (start_time, end_time))| RemotePeriodSlot {
            unit: *unit,
            start_time: start_time.clone(),
            end_time: end_time.clone(),
        })
        .collect();
    out.sort_by_key(|s| s.unit);
    out
}

/// 一行课表 → 归一化的上课时段。
fn to_activity(row: &ZfsoftKbRow, slots: &HashMap<i64, (String, String)>) -> TimetableActivity {
    // 节次：**只用 `jcs`**。实测同一行的 `jcor` 会更大（`jcs="6-7"` / `jcor="6-10"`），
    // 而 `oldjc` 位掩码证明 `jcs` 才是网格上那一段。
    let units = row.jcs.as_deref().and_then(parse_unit_range);
    let (start_time, end_time) = match units {
        // 一次课跨的节次是连续的，所以起时刻取首节、止时刻取末节
        Some((a, b)) => (
            slots.get(&a).map(|(s, _)| s.clone()),
            slots.get(&b).map(|(_, e)| e.clone()),
        ),
        None => (None, None),
    };
    TimetableActivity {
        lesson_id: row.jxb_id.as_deref().map(stable_lesson_id),
        lesson_code: None,
        lesson_name: row.jxbmc.clone(),
        course_code: row.kch.clone(),
        course_name: row.kcmc.clone(),
        weeks_str: row.zcd.clone(),
        // 周次：文本优先（教务网格显示的就是它），文本解析不出才退到位掩码
        week_indexes: {
            let from_text = row.zcd.as_deref().map(parse_week_indexes).unwrap_or_default();
            if from_text.is_empty() {
                row.oldzc
                    .as_ref()
                    .and_then(week_mask_to_indexes)
                    .unwrap_or_default()
            } else {
                from_text
            }
        },
        room: row.cdmc.clone(),
        building: row.lh.clone(),
        campus: row.xqmc.clone(),
        weekday: row.xqj.as_deref().and_then(|s| s.trim().parse().ok()),
        start_unit: units.map(|(a, _)| a),
        end_unit: units.map(|(_, b)| b),
        start_time,
        end_time,
        teachers: split_teachers(row.xm.as_deref()),
        course_type: row.kclbmc.clone().map(|name| RemoteNamed {
            name_zh: Some(name),
            code: None,
        }),
        credits: row.xf.as_ref().and_then(lenient_f64),
        // 正方不给每门课的配色（树维给 `bgc`），由前端按课程类别取默认色
        bgc: None,
        // 详情字段（备注/容量/已选/分组/大节/学时构成）正方课表里没有，
        // 且正方本就不支持课程详情，一律留空
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semester_id_roundtrip() {
        // 2026-2027 第一学期（实测 xnm=2026 / xqm=3）
        assert_eq!(encode_semester(2026, 3), 202603);
        assert_eq!(decode_semester(202603), (2026, 3));
        assert_eq!(encode_semester(2026, 12), 202612);
        assert_eq!(decode_semester(202612), (2026, 12));
        // 小学期 16 也要能往返
        assert_eq!(decode_semester(encode_semester(2025, 16)), (2025, 16));
        assert_eq!(semester_code(2026, 3), "2026-2027_1");
        assert_eq!(semester_code(2026, 12), "2026-2027_2");
        assert_eq!(school_year_of(2026), "2026-2027");
        assert_eq!(season_of(3), Some("AUTUMN"));
        assert_eq!(season_of(12), Some("SPRING"));
        assert_eq!(season_of(99), None);
    }

    /// 周次解析：**用线上真实出现过的每一个字符串**钉住。
    /// 这些值同时也在 `oldzc` 位掩码里被独立验证过（见下一条断言）。
    #[test]
    fn parses_real_week_texts() {
        assert_eq!(parse_week_indexes("6-18周"), (6..=18).collect::<Vec<_>>());
        assert_eq!(parse_week_indexes("13周"), vec![13]);
        assert_eq!(parse_week_indexes("6-7周"), vec![6, 7]);
        assert_eq!(
            parse_week_indexes("6-12周,14-16周"),
            vec![6, 7, 8, 9, 10, 11, 12, 14, 15, 16]
        );
        assert_eq!(parse_week_indexes("1-16周(单)"), vec![1, 3, 5, 7, 9, 11, 13, 15]);
        assert_eq!(parse_week_indexes("1-16周（双）"), vec![2, 4, 6, 8, 10, 12, 14, 16]);
        // 认不出来的写法给空数组，不猜（宁可少几周，也不要编出错的周次）
        assert!(parse_week_indexes("").is_empty());
        assert!(parse_week_indexes("待定").is_empty());
    }

    /// 位掩码与文本**互为独立来源**，实测 23 行全部一致 —— 任何一方解析错，
    /// 这条断言都会立刻红。掩码写法：第 n 周 = 第 n-1 位。
    #[test]
    fn week_mask_agrees_with_week_text() {
        let cases: [(&str, i64); 6] = [
            ("6-18周", 262112),
            ("6-13周", 8160),
            ("16-17周", 98304),
            ("13周", 4096),
            ("6-12周,14-16周", 61408),
            ("6-8周,10-17周", 130784),
        ];
        for (text, mask) in cases {
            let from_mask = week_mask_to_indexes(&serde_json::json!(mask)).unwrap();
            assert_eq!(from_mask, parse_week_indexes(text), "{text} / {mask}");
        }
        assert!(week_mask_to_indexes(&serde_json::json!(0)).is_none());
    }

    #[test]
    fn parses_unit_ranges() {
        assert_eq!(parse_unit_range("1-2"), Some((1, 2)));
        assert_eq!(parse_unit_range("11-13"), Some((11, 13)));
        assert_eq!(parse_unit_range("5"), Some((5, 5)));
        assert_eq!(parse_unit_range(" 6-9 "), Some((6, 9)));
        assert_eq!(parse_unit_range(""), None);
        assert_eq!(parse_unit_range("上午"), None);
    }

    /// 教学班 id 的哈希必须**稳定**：它落库在 `remote_lesson_id`，是课程的唯一键。
    /// 一旦这个值随版本变化，用户每次同步都会重建一整套课程与时段。
    #[test]
    fn lesson_id_hash_is_stable() {
        let a = stable_lesson_id("55AB309EAA31780DE0637EA0FE0A2A3B");
        assert_eq!(a, stable_lesson_id("55AB309EAA31780DE0637EA0FE0A2A3B"));
        assert!(a > 0, "取正数：负数 id 在界面上读起来像错误");
        // 不同教学班必须落到不同值
        assert_ne!(a, stable_lesson_id("55AB309EA91A780DE0637EA0FE0A2A3B"));
        assert_ne!(
            stable_lesson_id("569C61867D95368AE0637EA0FE0AE6A5"),
            stable_lesson_id("55AD209861C839F6E0637EA0FE0AE23D")
        );
    }

    /// 学号密码那类凭据绝不进源码 —— 这里只用合成值验证解析器本身。
    #[test]
    fn extracts_csrf_and_tip_from_real_shapes() {
        // 真实登录页的形状：`id` 与 `value` 之间有 `name`，且值含逗号
        let html = r#"<input type="hidden" id="csrftoken" name="csrftoken" value="e8c85baf-8469-4070-9396-612369b5a9f3,e8c85baf846940709396612369b5a9f3"/>"#;
        assert_eq!(
            extract_csrf(html).unwrap(),
            "e8c85baf-8469-4070-9396-612369b5a9f3,e8c85baf846940709396612369b5a9f3"
        );
        assert!(extract_csrf("<html>no token</html>").is_none());
        // 空值不算拿到（否则会拿一个空串去 POST，然后被含糊地拒掉）
        assert!(extract_csrf(r#"<input id="csrftoken" value=""/>"#).is_none());

        // 登录失败页的形状：错误文案在 #tips 里，带一个图标 span
        let page = r#"<p id="tips" class="bg_danger sl_danger"><span class="glyphicon glyphicon-minus-sign"></span>用户名或密码不正确，请重新输入！</p>"#;
        assert_eq!(
            login_failure(page).0,
            "用户名或密码不正确，请重新输入！"
        );
        assert!(!login_failure(page).2);
        // 教务说验证码 → 要把验证码输入框请出来
        let cap = r#"<p id="tips" class="bg_danger sl_danger">请输入验证码！</p>"#;
        assert!(login_failure(cap).2);
        // 什么都没说也必须有话可说（沉默的失败 = 没有引导）
        assert!(login_failure("<html></html>").0.contains("学号与密码"));
    }

    #[test]
    fn form_body_escapes_base64_ciphertext() {
        let body = form_body(&[("yhm", "202600000000"), ("mm", "a+b/c=d")]);
        assert_eq!(body, "yhm=202600000000&mm=a%2Bb%2Fc%3Dd");
        // 两次同样的字段照发（登录页的 mm 就是两份）
        assert_eq!(form_body(&[("mm", "x"), ("mm", "x")]), "mm=x&mm=x");
    }

    #[test]
    fn parses_select_options_with_selected_marker() {
        // 课表页真实片段（学年下拉）：选项自带 selected 标记与「起止年」文案
        let html = r#"<select name="xnm" id="xnm"><option value="" ></option>
            <option value="2026" selected="selected">2026-2027</option>
            <option value="2025">2025-2026</option></select>"#;
        let opts = options_of(html, "xnm");
        assert_eq!(opts.len(), 2, "空 value 的占位项要被丢掉");
        assert_eq!(opts[0].value, 2026);
        assert!(opts[0].selected);
        assert_eq!(opts[0].label, "2026-2027");
        assert!(!opts[1].selected);
        assert!(options_of(html, "nope").is_empty());
    }

    #[test]
    fn splits_teacher_string() {
        assert_eq!(split_teachers(Some("张庆金,纪芳芳")), vec!["张庆金", "纪芳芳"]);
        assert_eq!(split_teachers(Some(" 王梓 ")), vec!["王梓"]);
        assert!(split_teachers(None).is_empty());
        assert!(split_teachers(Some(" , ")).is_empty());
    }

    /// 真机联调（默认忽略）。带上凭据手动跑一次，确认「登录握手 → 学期列表（含起止日）
    /// → 课表归一化」这三段在真实教务上仍然成立 —— 正方改版通常就是这三处先坏。
    ///
    /// ```text
    /// $env:REIN_GXUST_USER='2026xxxxxxxx'; $env:REIN_GXUST_PASS='...'
    /// cargo test --lib campus::zfsoft::tests::live -- --ignored --nocapture
    /// ```
    ///
    /// 凭据只从环境变量读，不进仓库（与 `guet.rs` 的真机用例同规矩）。
    #[test]
    #[ignore = "打真实教务系统，需要 REIN_GXUST_USER / REIN_GXUST_PASS"]
    fn live_gxust_roundtrip() {
        let (Ok(user), Ok(pass)) = (
            std::env::var("REIN_GXUST_USER"),
            std::env::var("REIN_GXUST_PASS"),
        ) else {
            println!("缺少 REIN_GXUST_USER / REIN_GXUST_PASS，跳过");
            return;
        };
        let spec = super::super::provider::spec("gxust-zfsoft-zftal").expect("广科大 spec");
        let mut session = Session::new(spec.default_base_url, Default::default());
        let mut adapter = ZfsoftAdapter::new(spec, &mut session);

        assert!(
            !adapter.probe_session().expect("探针请求要能发出"),
            "登录前探针必须是「未登录」"
        );
        println!("✓ 登录前探针：未登录");

        let login = adapter.login(&user, &pass, "").expect("登录请求本身要能发出");
        assert!(login.ok, "登录被拒绝：{:?}", login.message);
        println!("✓ 登录通过");

        assert!(adapter.probe_session().expect("会话探针"), "会话探针未通过");
        println!("✓ 会话有效");

        let vars = adapter.fetch_page_vars(None).expect("课表页面解析");
        println!("✓ 解析到 {} 个学期", vars.semesters.len());
        for s in vars.semesters.iter().take(4) {
            println!(
                "  {} {:?} ~ {:?}",
                s.code.as_deref().unwrap_or("?"),
                s.start_date,
                s.end_date
            );
        }
        let with_dates = vars
            .semesters
            .iter()
            .filter(|s| s.start_date.is_some() && s.end_date.is_some())
            .count();
        assert_eq!(with_dates, vars.semesters.len(), "每个学期都必须带起止日期");

        // 取「覆盖今天」的那个学期；没有就取第一个
        let today = chrono::Local::now().date_naive();
        let target = vars
            .semesters
            .iter()
            .find(|s| {
                match (
                    parse_ymd(s.start_date.as_deref().unwrap_or("")),
                    parse_ymd(s.end_date.as_deref().unwrap_or("")),
                ) {
                    (Some(a), Some(b)) => a <= today && today <= b,
                    _ => false,
                }
            })
            .unwrap_or(&vars.semesters[0]);

        let snap = adapter
            .fetch_timetable(target.id)
            .expect("课表数据解析（空学期也应当能解析）");
        let courses: std::collections::HashSet<_> =
            snap.activities.iter().filter_map(|a| a.lesson_id).collect();
        println!(
            "✓ 课表：{} 门课 / {} 条时段（学生 {}）",
            courses.len(),
            snap.activities.len(),
            snap.student_name.as_deref().unwrap_or("?")
        );
        let with_time = snap
            .activities
            .iter()
            .filter(|a| a.start_time.is_some() && a.end_time.is_some())
            .count();
        let with_weeks = snap
            .activities
            .iter()
            .filter(|a| !a.week_indexes.is_empty())
            .count();
        println!("  其中 {with_time} 条带时刻 / {with_weeks} 条带周次");
        assert!(with_time > 0, "没有任何一条带 startTime/endTime");
        assert!(with_weeks > 0, "没有任何一条带 weekIndexes");

        // 培养方案：正方没有这个接口，必须是「明确报错」而不是空数据
        assert!(
            adapter.fetch_program_info("x").is_err(),
            "正方没有培养方案接口，应当明确报错"
        );
        println!("✓ 联调通过");
    }
}
