# 树维（Supwisdom）EAMS5 · 实战记录

在册学校：桂林电子科技大学（`bkjwtest.guet.edu.cn`，2026-09 实测）。适配器：`src-tauri/src/modules/campus/adapters/supwisdom.rs`。
任何部署树维 EAMS5 的学校按 [README.md](README.md) 路径 A 声明一条 spec 即可复用。
本文记录实测结论——**每个条目都来自线上响应，改接口前先对照这里**。

## 登录握手（`LoginStrategy::SupwisdomPortalRsa`）

```text
GET  /student/ldap/login-salt          → 纯文本 salt，同时 Set-Cookie 建会话
RSA_PKCS1_v1_5(公钥, salt + "-" + 密码)  → 公钥是静态的，写死在登录页 JS 里（PKCS#8 SPKI DER 的 base64）
POST /student/ldap/login               → JSON {username, password, captcha}
                                        成功：{"result": true}
                                        失败：{"result": false, "needCaptcha": …, "message": …}
```

实测要点：

- **Cookie 会话，不是 token**：后续请求靠 `__pstsid__` / `SESSION` 两个 Cookie 认人。
- **验证码答案绑会话**：必须先 GET salt 把会话建起来，再取验证码图，再提交——
  「取图」与「提交」落在两个会话里，验证码必然对不上（这就是 trait 里
  `warm_login_session` 存在的原因）。
- **密码不 trim、区分大小写**：用户口令结尾的句点也是密码的一部分。
- `message` 不总有：教务对「密码不对」可能什么都不说，前端文案按
  `login_failure` 的情形兜底；`login_first` / `weak_password` 必须去网页端改，带
  `actionRequired` 透出。

## 会话探针

`GET /student/home`：**200 = 仍有效，302 = 被踢回登录页**。HTTP 层不跟随重定向，
302 就是过期判据。

## 学期列表：藏在课表页里

树维**没有独立的 semester-list 接口**（实测 404）。学期列表唯一来源是课表页
`/student/for-std/course-table` 里的 JS 字面量：

```text
var semesters = JSON.parse(
    '[{\"nameZh\":\"2026-2027上学年...\",\"id\":321,...}]'
);
```

三个坑（任何一处想当然都会解析失败）：

1. 字面量是**单引号**，里面的 `\"` 是 JS 转义，解码后才是 JSON 引号；
2. `JSON.parse(` 与引号之间有换行和缩进；
3. 中文用 `\uXXXX` 转义。

## 课表与课程详情

- 课表主数据：`GET /student/for-std/course-table/semester/{sem}/print-data`，
  路径里只有 semesterId（最稳），取 `studentTableVms[0]`。
- 每条活动自带真实 `startTime`/`endTime`——**没有节次时间表接口**，`periodSlots` 留空，
  前端时间轴退化为按排课区间切分（行高按真实时长），绝不插值编时刻。
- 课程详情**复用同一份 print-data**（`detail::build_course_detail` 组装）：容量/已选人数
  在选课期是活的，所以每次现拉、不缓存。

## 全校开课查询（`lesson_search.rs`）

- 入口页 `/student/for-std/lesson-search`（学期列表与课表页同形，解析复用），
  数据接口 `/student/for-std/lesson-search/semester/{sem}/search/{std}`。
- 固定参数来自实测：`bizTypeAssoc=2`（本科）；`assembleFields` 缺一列行里就少一块
  （见 `provider.rs::LESSON_SEARCH_ASSEMBLE_FIELDS`，逐字对齐教务，不要凭直觉改）。
- 桂电本科挂着两个域名且**不是同一套系统**：`bkjwtest` 是本文这套 EAMS5；
  `bkjw` 是 ASP.NET + ExtJS + CAS 的另一套。两域分别探测、分别汇报，不互相兜底。

## 选课 / 抢课（`course_select.rs`，仅这套系统有）

- 选课系统自己的 `/login`（SHA1 混淆）对 EAMS 账号**不可用**（实测 `credentials did not match`）。
- 真入口是 **EAMS 门户发的 SSO 令牌**：`GET /student/for-std/course-select` 页面里
  `var url = '.../course-selection/?token=<JWT>'`（HS256，`{iss:"supwisdom", exp, username}`）。
- 令牌**裸用**：`Authorization: <JWT>`（无 Bearer 前缀）。
- 信封 `{result, message, data}`，且——**与其余接口相反**——`result` 为**假**才是成功。
  这个反直觉约定只在 `CourseSelectClient::call` 一处判断。
- 令牌走 EAMS 会话换发，所以**会话一换、令牌作废**（`forget_select_token`）。

## 真机联调

```powershell
$env:REIN_GUET_USER='2600xxxxxx'; $env:REIN_GUET_PASS='...'
cargo test --lib campus::adapters::supwisdom::tests::live -- --ignored --nocapture
```

默认 `#[ignore]`：真机用例只在有凭据时手动跑，CI 永远不碰教务。
