//! **全校开课查询**（树维 EAMS5 的 for-std/lesson-search）+ **两个域都检测**。
//!
//! 为什么单独一个模块：它和「选课」是两条不同的路 ——
//!
//! - 选课（见 super::course_select）走 /course-selection-api，鉴权靠**门户发的 SSO 令牌**，
//!   而且必须先有开放中的批次；
//! - 开课查询走的是 **EAMS 自己的页面接口**（/student/for-std/lesson-search/...），
//!   鉴权就是那份登录态 Cookie，**和批次无关** —— 批次没开的时候照样能查全校开了哪些课。
//!
//! 后者正是「提前规划抢什么」的依据：先看清开课名单与时间地点，再去排志愿。
//!
//! ## 两个域都检测
//!
//! 本科教务挂着两个域名，但**它们不是同一套系统**（见 adapters::provider 的说明）：
//! bkjwtest 是本文打通的树维 EAMS5，bkjw 是另一套 ASP.NET + ExtJS 桌面 + CAS 登录。
//! 所以「两个域都检测」不是冗余重试，而是**分别探明各是什么**：
//! 哪个域真的提供开课查询、哪个域连路径都不存在，都要说清楚。
//! 探测结果**按域名分别汇报**，绝不互相兜底 —— 一个域没有的接口，去另一个域也找不到。

use serde::Serialize;

use crate::error::{ReinError, Result};

use super::http::{CookieJar, Session};
use super::models::{LessonSearchHit, LessonSearchPage, LessonSearchQuery, SchoolDomainProbe};
use super::adapters::provider::{self, SchoolSystemSpec};

/// 单页条数。教务自己也是 20（见 queryPage__=1,20），保持同量级最不容易触发风控。
pub const DEFAULT_PAGE_SIZE: i64 = 20;
/// 一次查询最多翻多少页，防止误传一个巨大的页码把教务打疼。
const MAX_PAGE_SIZE: i64 = 200;

/// 把「页码 / 每页条数」归一到教务能接受的范围。
///
/// 抽成纯函数是为了能被测：夹取规则写在 `search()` 里的话，只有真打教务才能验证，
/// 而这条路恰恰是「不该为了测试去打真教务」的那种。返回 `(页码, 每页条数)`。
pub fn normalize_page(page: Option<i64>, page_size: Option<i64>) -> (i64, i64) {
    let page = page.unwrap_or(1).max(1);
    let size = page_size
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);
    (page, size)
}

/// 开课查询的数据源：**一个域上的 EAMS5 会话**。
pub struct LessonSearchClient<'a> {
    spec: &'static SchoolSystemSpec,
    session: &'a mut Session,
}

impl<'a> LessonSearchClient<'a> {
    pub fn new(spec: &'static SchoolSystemSpec, session: &'a mut Session) -> Self {
        Self { spec, session }
    }

    /// 树维那一套接口表。开课查询**只有树维这条系统有路** ——
    /// 正方（如广西科技大学）的接口表里没有它，这里就明确报错，
    /// 而不是拿空路径打出去换回一个登录页 HTML。
    fn endpoints(&self) -> Result<provider::Eams5Endpoints> {
        self.spec.endpoints.eams5.ok_or_else(|| {
            ReinError::Message(format!(
                "{} 的正方教务系统没有「全校开课查询」接口，本应用暂不支持",
                self.spec.short_name
            ))
        })
    }

    fn biz_type_id(&self) -> Result<i64> {
        self.spec.term.biz_type_id.ok_or_else(|| {
            ReinError::Message(format!("{} 没有声明培养层次（bizTypeId）", self.spec.kind))
        })
    }

    /// 开课查询入口页。**只取学期列表**：页面里的 var semesters = JSON.parse('…')
    /// 与课表页是同一份形状，所以复用 adapters::supwisdom 的解析。
    pub fn semesters(&mut self) -> Result<Vec<super::models::RemoteSemester>> {
        let path = self.endpoints()?.lesson_search_page_for(self.biz_type_id()?);
        let resp = self.session.get(&path)?;
        guard(&resp, "打开全校开课查询")?;
        super::adapters::supwisdom::parse_semesters(&resp.text())
    }

    /// 打开查询页面（带学生标识），确认这条路真的通。
    ///
    /// 单独一步是有意义的：**数据接口对未登录会话也返回 200 空列表**，
    /// 只看数据接口会把「没登录」误判成「这门课没人开」。
    pub fn open(&mut self, student_id: &str) -> Result<()> {
        let path = self.endpoints()?.lesson_search_index_for(student_id);
        let resp = self.session.get(&path)?;
        guard(&resp, "打开开课查询页面")
    }

    /// 查一页开课名单。
    pub fn search(&mut self, student_id: &str, q: &LessonSearchQuery) -> Result<LessonSearchPage> {
        let ep = self.endpoints()?;
        let biz = self.biz_type_id()?;
        let (page, size) = normalize_page(q.page, q.page_size);
        let path = ep.lesson_search_data_for(q.semester_id, student_id, biz, page, size);
        // 数据接口要带 Referer：教务按来源页判上下文，缺了它偶尔会回空。
        let referer = ep.lesson_search_index_for(student_id);
        let resp = self.session.get_with_referer(&path, &referer)?;
        guard(&resp, "查询开课名单")?;

        let raw = resp
            .json()
            .map_err(|e| ReinError::Message(format!("开课名单解析失败：{e}")))?;
        let hits = parse_rows(&raw);
        let total = raw
            .get("total")
            .or_else(|| raw.get("totalRows"))
            .or_else(|| raw.get("totalCount"))
            .and_then(|v| v.as_i64());
        Ok(LessonSearchPage {
            hits,
            page,
            page_size: size,
            total,
            raw_keys: top_keys(&raw),
        })
    }
}

/// 非 2xx / 302 都要说人话：302 基本就是会话过期（见 http::Session 不跟随重定向的理由）。
fn guard(resp: &super::http::HttpResponse, what: &str) -> Result<()> {
    if resp.is_redirect() {
        return Err(ReinError::coded(
            "session_lost",
            format!("{what}时被重定向到登录页：EAMS 会话已过期，请重新登录"),
        ));
    }
    if !resp.is_ok() {
        return Err(ReinError::Message(format!(
            "{what}失败：HTTP {}",
            resp.status
        )));
    }
    Ok(())
}

/// 顶层键名，用于排障时快速看出「教务把行放在哪个字段里」。
fn top_keys(v: &serde_json::Value) -> Vec<String> {
    match v.as_object() {
        Some(map) => map.keys().cloned().collect(),
        None => Vec::new(),
    }
}

/// 从响应里取出开课行。
///
/// 不假设只有一种信封：树维这类接口在「分页表格」与「纯数组」之间来回变过，
/// 所以 rows / data / list / records / content 都试一遍，最后退化成「顶层就是数组」。
/// 一种都不命中时返回空表而不是报错 —— 空表配上 raw_keys 足够定位问题，
/// 而报错会把「教务改了字段名」和「确实没开课」混成同一句话。
fn parse_rows(v: &serde_json::Value) -> Vec<LessonSearchHit> {
    // 逐个候选键取「**数组值**」，而不是「第一个存在的键」。
    // 这个区别是有代价的：`{"data":{"rows":[…]}}` 里 `data` 存在但是对象，
    // 若按「存在即命中」就会拿到对象、`as_array()` 失败、整页静默变空 ——
    // 明明有数据却显示「没有开课」。所以只认数组。
    let arr = ["rows", "data", "list", "records", "content"]
        .iter()
        .filter_map(|k| v.get(*k))
        .find_map(|candidate| match candidate {
            // 嵌套一层：`data.rows` / `data.list` 也认
            serde_json::Value::Array(_) => Some(candidate),
            serde_json::Value::Object(_) => ["rows", "list", "records", "content"]
                .iter()
                .filter_map(|k| candidate.get(*k))
                .find(|inner| inner.is_array()),
            _ => None,
        })
        // 顶层本身就是数组
        .or_else(|| v.is_array().then_some(v));

    let Some(items) = arr.and_then(|a| a.as_array()) else {
        return Vec::new();
    };
    items.iter().map(LessonSearchHit::from_value).collect()
}

/// 探测一个域上「开课查询」这条路通不通。
///
/// 只打**不需要登录**的两个点（入口页与静态资源），所以拿不到会话也能探测 ——
/// 用户想知道「另一个域到底是什么」的时候，不该被要求先登录一遍。
pub fn probe_domain(base_url: &str) -> SchoolDomainProbe {
    let base = provider::normalize_base(base_url);
    let mut session = Session::new(&base, CookieJar::default());

    // ① 开课查询入口页：200/302 都算「这个域上有这套路由」，404 就是没有。
    let page = session.get("/student/for-std/lesson-search?bizTypeId=2");
    // ② EAMS5 的静态资源：**它最能说明问题** —— 静态资源不受鉴权影响，
    //    因此「静态资源 404」= 这套系统根本没部署在这个域名上。
    let asset = session.get("/student/static/eams-ui/js/eams-ui.js");

    let code = |r: &Result<super::http::HttpResponse>| -> Option<u16> {
        r.as_ref().ok().map(|x| x.status)
    };
    let (page_status, asset_status) = (code(&page), code(&asset));

    let eams_present = matches!(asset_status, Some(s) if (200..400).contains(&s));
    let route_present = matches!(page_status, Some(s) if (200..400).contains(&s));

    let detail = match (route_present, eams_present) {
        (true, true) => format!(
            "开课查询入口 {}、EAMS5 静态资源 {} —— 这条路通",
            show(page_status),
            show(asset_status)
        ),
        (false, false) => format!(
            "开课查询入口 {}、EAMS5 静态资源 {} —— 这个域上没有 EAMS5，{}",
            show(page_status),
            show(asset_status),
            provider::probe_hint(&base)
        ),
        (true, false) => format!(
            "开课查询入口 {} 但静态资源 {} —— 路由在、资源不在，值得手工看一眼",
            show(page_status),
            show(asset_status)
        ),
        (false, true) => format!(
            "静态资源 {} 在、开课查询入口 {} 不在 —— 可能这个域没开该菜单",
            show(asset_status),
            show(page_status)
        ),
    };

    SchoolDomainProbe {
        base_url: base,
        reachable: page_status.is_some() || asset_status.is_some(),
        lesson_search_route: route_present,
        eams_assets: eams_present,
        hint: provider::probe_hint(base_url).to_string(),
        page_status,
        asset_status,
        detail,
    }
}

/// 状态码的人话（None = 连都没连上）。
fn show(code: Option<u16>) -> String {
    match code {
        Some(c) => c.to_string(),
        None => "连不上".to_string(),
    }
}

/* ─────────────────── 抢课「两个域都发」的决策（纯逻辑，可测） ─────────────────── */

/// 一次抢课该往哪些域发、以及**为什么没往某些域发**。
///
/// 为什么需要这个结构，而不是简单地「两边都发」：
/// 本科教务的两个域名**不是同一套系统** —— 实测 bkjw 的 `/student/**` 全部 404
/// （连静态资源都没有，说明 EAMS5 没部署在那里），它有自己的另一套接口。
/// 对它盲发选课请求只会拿到 404：既浪费一次出手机会，又会在结果面上
/// 留下一条「失败」把人引向错误的方向。所以发之前先看探测结论，
/// 并且**把不发的原因说出来** —— 静默跳过比发错更糟，用户会以为两边都在打。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DualFirePlan {
    /// 真正会发请求的域名（按顺序）。至少一个是账号自己那个域。
    pub targets: Vec<String>,
    /// 被跳过的域名与原因（可直接显示）
    pub skipped: Vec<(String, String)>,
    /// 结论一句话
    pub note: String,
}

/// 规划「抢课往哪些域发」。
///
/// 规则（按优先级）：
/// 1. **账号自己的域永远在列**：它的 Cookie 只在自己那个域上有效，
///    换域去发只会拿到 302（会话在别的域不存在）—— 这是唯一保证能打的一条路。
/// 2. 另一个域**只有探测到确实提供 EAMS5** 才加入：那说明它可能是同一套系统的
///    另一个部署（真正的冗余），否则发过去只是 404。
/// 3. 连不上的域一律跳过，并写明「连不上」。
pub fn plan_dual_fire(account_base: &str, probes: &[SchoolDomainProbe]) -> DualFirePlan {
    let primary = provider::normalize_base(account_base);
    let mut targets = vec![primary.clone()];
    let mut skipped = Vec::new();

    for p in probes {
        let base = provider::normalize_base(&p.base_url);
        if base == primary {
            continue;
        }
        if !p.reachable {
            skipped.push((base, "连不上，跳过".to_string()));
            continue;
        }
        if p.eams_assets {
            // 同一套系统的另一个部署 —— 这才是真正意义上的「两边都发」
            targets.push(base);
        } else {
            skipped.push((
                base,
                format!("该域没有 EAMS5（{}），发过去只会 404，已跳过", p.detail),
            ));
        }
    }

    let note = if targets.len() > 1 {
        format!("将向 {} 个域同时发送", targets.len())
    } else if let Some((base, why)) = skipped.first() {
        format!("只在账号自己的域上发送；{base} 未发送：{why}")
    } else {
        "只在账号自己的域上发送".to_string()
    };

    DualFirePlan {
        targets,
        skipped,
        note,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> serde_json::Value {
        serde_json::from_str(s).unwrap()
    }

    /// 行放在哪一层都要认得出来 —— 教务的信封变过一次，不该再被同一块石头绊倒。
    #[test]
    fn rows_are_found_in_every_envelope_shape_the_school_uses() {
        let row = r#"{"course":{"nameZh":"高等数学"},"nameZh":"教学班A"}"#;

        for body in [
            format!(r#"{{"rows":[{row}]}}"#),
            format!(r#"{{"data":[{row}]}}"#),
            format!(r#"{{"data":{{"rows":[{row}]}}}}"#),
            format!(r#"{{"records":[{row}]}}"#),
            format!(r#"{{"content":[{row}]}}"#),
            format!(r#"[{row}]"#),
        ] {
            assert_eq!(parse_rows(&v(&body)).len(), 1, "没认出信封：{body}");
        }
    }

    /// 一种信封都不命中时给空表，不报错：报错会把「教务改了字段」和「确实没开课」混为一谈。
    #[test]
    fn an_unknown_envelope_yields_an_empty_list_not_a_panic() {
        assert!(parse_rows(&v(r#"{"foo":1}"#)).is_empty());
        assert!(parse_rows(&v("null")).is_empty());
        assert!(parse_rows(&v(r#""text""#)).is_empty());
    }

    /// 顶层键要能报出来，排障时靠它看出教务把行放哪了。
    #[test]
    fn top_level_keys_are_reported_for_diagnosis() {
        let keys = top_keys(&v(r#"{"rows":[],"total":0}"#));
        assert!(keys.contains(&"rows".to_string()));
        assert!(keys.contains(&"total".to_string()));
        assert!(top_keys(&v("[]")).is_empty());
    }

    /// 页面地址与数据地址要逐字对齐实测抓包 —— 这两条最容易写错。
    #[test]
    fn paths_match_the_captured_requests() {
        let e = provider::spec("guet-supwisdom-eams5")
            .unwrap()
            .endpoints
            .eams5
            .expect("开课查询只有树维那条系统有");
        assert_eq!(
            e.lesson_search_page_for(2),
            "/student/for-std/lesson-search?bizTypeId=2"
        );
        assert_eq!(
            e.lesson_search_index_for("241250"),
            "/student/for-std/lesson-search/index/241250"
        );
        let data = e.lesson_search_data_for(321, "241250", 2, 1, 20);
        assert!(data.starts_with(
            "/student/for-std/lesson-search/semester/321/search/241250?bizTypeAssoc=2&queryPage__=1,20&assembleFields="
        ));
        // 少一个下划线，教务就当无参请求处理，静默给第一页 —— 这条断言就是钉它的
        assert!(data.contains("queryPage__="));
        assert!(data.contains("course.code"));
    }

    /// 探测结论要分得清「另一套系统」与「EAMS5 没开菜单」，别都糊成一句「连不上」。
    #[test]
    fn probe_detail_separates_the_two_systems() {
        assert!(provider::probe_hint("https://bkjw.guet.edu.cn").contains("另一套系统"));
        assert!(provider::probe_hint("https://bkjwtest.guet.edu.cn").contains("EAMS5"));
        // 规范化后带不带尾斜杠不影响判定
        assert_eq!(
            provider::probe_hint("https://bkjwtest.guet.edu.cn/"),
            provider::probe_hint("https://bkjwtest.guet.edu.cn")
        );
    }

    /// 账号自己的域永远在列 —— 那是唯一保证能打的一条路（Cookie 只在自己域有效）。
    #[test]
    fn the_account_domain_is_always_fired_at() {
        let plan = plan_dual_fire("https://bkjwtest.guet.edu.cn", &[]);
        assert_eq!(plan.targets, vec!["https://bkjwtest.guet.edu.cn"]);
        assert!(plan.skipped.is_empty());
    }

    /// 另一个域**没有 EAMS5** 时不能盲发：只会 404，还会在结果面留一条误导性的失败。
    #[test]
    fn a_domain_without_eams5_is_skipped_with_a_reason() {
        let probes = vec![SchoolDomainProbe {
            base_url: "https://bkjw.guet.edu.cn".into(),
            reachable: true,
            lesson_search_route: false,
            eams_assets: false,
            detail: "开课查询入口 404、EAMS5 静态资源 404".into(),
            ..Default::default()
        }];
        let plan = plan_dual_fire("https://bkjwtest.guet.edu.cn", &probes);
        assert_eq!(plan.targets.len(), 1, "不该往没有 EAMS5 的域发");
        assert_eq!(plan.skipped.len(), 1);
        assert!(
            plan.skipped[0].1.contains("404"),
            "原因要写明：{}",
            plan.skipped[0].1
        );
        assert!(
            plan.note.contains("未发送"),
            "结论要说明跳过：{}",
            plan.note
        );
    }

    /// 两个域都提供 EAMS5 时才是真正的「两边都发」。
    #[test]
    fn both_domains_are_fired_at_when_both_serve_eams5() {
        let probes = vec![SchoolDomainProbe {
            base_url: "https://bkjw.guet.edu.cn".into(),
            reachable: true,
            lesson_search_route: true,
            eams_assets: true,
            ..Default::default()
        }];
        let plan = plan_dual_fire("https://bkjwtest.guet.edu.cn", &probes);
        assert_eq!(plan.targets.len(), 2);
        assert!(plan.note.contains("2 个域"));
    }

    /// 连不上的域要跳过并写明 —— 「连不上」与「没部署」是两回事，不能糊成一句。
    #[test]
    fn unreachable_domains_are_skipped_as_unreachable() {
        let probes = vec![SchoolDomainProbe {
            base_url: "https://bkjw.guet.edu.cn".into(),
            reachable: false,
            ..Default::default()
        }];
        let plan = plan_dual_fire("https://bkjwtest.guet.edu.cn", &probes);
        assert_eq!(plan.targets.len(), 1);
        assert!(plan.skipped[0].1.contains("连不上"));
    }

    /// 探测列表里重复出现账号自己的域时不能重复发。
    #[test]
    fn the_account_domain_is_never_duplicated() {
        let probes = vec![SchoolDomainProbe {
            base_url: "https://bkjwtest.guet.edu.cn/".into(),
            reachable: true,
            eams_assets: true,
            ..Default::default()
        }];
        let plan = plan_dual_fire("https://bkjwtest.guet.edu.cn", &probes);
        assert_eq!(plan.targets.len(), 1, "规范化后同一个域不该发两次");
    }

    /// 状态码为 None（连不上）时不能崩，也要给得出人话。
    #[test]
    fn status_rendering_handles_unreachable_hosts() {
        assert_eq!(show(Some(404)), "404");
        assert_eq!(show(None), "连不上");
    }

    /// 每页条数要被夹到合理区间：误传巨大值不该把教务打疼。
    #[test]
    fn page_parameters_are_clamped() {
        assert_eq!(normalize_page(None, None), (1, DEFAULT_PAGE_SIZE));
        assert_eq!(
            normalize_page(Some(0), Some(0)),
            (1, 1),
            "页码与条数都不能是 0"
        );
        assert_eq!(normalize_page(Some(-3), Some(-5)), (1, 1));
        assert_eq!(normalize_page(Some(2), Some(9999)), (2, MAX_PAGE_SIZE));
        assert_eq!(normalize_page(Some(3), Some(50)), (3, 50));
    }

    /// 路径构造器只负责拼串，不负责夹取 —— 这两件事分开才不会互相掩盖。
    #[test]
    fn path_builder_is_a_pure_formatter() {
        let e = provider::spec("guet-supwisdom-eams5")
            .unwrap()
            .endpoints
            .eams5
            .expect("开课查询只有树维那条系统有");
        let data = e.lesson_search_data_for(321, "1", 2, 1, 9999);
        assert!(
            data.contains("queryPage__=1,9999"),
            "格式化不该偷偷改数：{data}"
        );
    }
}
