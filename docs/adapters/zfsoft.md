# 正方（ZFSoft zftal-ui-v5）· 实战记录

在册学校：广西科技大学（`jwxt.gxust.edu.cn`，学校代码 10594，2026-09 实测）。
适配器：`src-tauri/src/modules/campus/adapters/zfsoft.rs`。
与树维的关系：**只共用 `dates.rs` 的学期换算，抓取逻辑一行不复用**——两套系统的登录握手、
数据形状、字段命名没有一处相同。老版正方在大量高校部署，本记录对这些学校是路径 A 的参考。

## 登录握手（`LoginStrategy::ZfsoftLoginRsa`）

```text
GET  /xtgl/login_slogin.html          → 拿 csrftoken（隐藏域，值形如 "uuid,去横线的uuid"），同时建会话
GET  /xtgl/login_getPublicKey.html    → modulus/exponent（base64），每次登录现取
RSA_PKCS1_v1_5(裸口令)                 → 不拼盐！与树维的关键差异
POST /xtgl/login_slogin.html          → 表单 yhm / mm / csrftoken / dl（同一地址）
```

实测要点：

- **判定与直觉相反**（实测两次确认）：**200 = 被拒**（登录页就地重渲染，原因在 `#tips` 里），
  **302 = 通过**（该页对已登录会话会再跳菜单页）。
- 公钥**运行时现取**，不写死在源码里（与树维相反）；modulus 是 Java BigInteger 的
  base64，可能带 129 字节符号位，解码要容忍。
- 提交必须带**该会话的** `csrftoken`，所以「取表单」这一步不能省。
- 验证码 `/kaptcha?time=…`：**错够几次才要**，失败页里看不出这个要求——所以配置页给了
  一个人工取图入口（按 `loginStrategy` 渲染，不是能力位）。
- 密码同样不 trim、区分大小写。

## 会话探针

`GET /xtgl/index_cxYhxxIndex.html`（用户信息页，未登录 302 回登录页）。

## 课表是「一个页面 + 三个数据接口」

全部要带 `?gnmkdm=N2151`（菜单编号，正方按它鉴权；少了它接口**静默回 null**）：

| 接口 | 给什么 |
| --- | --- |
| `GET /kbcx/xskbcx_cxXskbcxIndex.html` | 课表页：学年/学期下拉（`xnm`/`xqm`）+ 学生档案。**学期列表唯一来源** |
| `POST /kbcx/xskbcx_cxXsgrkb.html` | 课表正文 `{kbList, sjkList, xsxx}`；`POST xnm/xqm` 表单 |
| `POST /kbcx/xskbcx_cxRjc.html` | 节次时间表 `[{jcmc:"1", qssj:"08:20", jssj:"09:00"}]`——正方不给每条课的真实时刻，只有节次号 |
| `POST /kbcx/xskbcxZccx_cxZcByXnxq.html` | 周次表 `[{zs:"1", rq:"2026-09-07/2026-09-13"}]`——第 1 周的起止日是周次→公历换算的**学期锚点** |

实测口径（广科大）：14 个教学班 / 23 条上课时段 / 第 1 周 = 2026-09-07（周一起算）。

## 学期与周次的换算

- 学期编码：`encode_semester(xnm, xqm) = xnm*100 + xqm`（解码与显示名见 `zfsoft.rs`
  的 `decode_semester` / `school_year_of` / `season_of`）。
- 周次字段 `zcd` 是**文本**：`6-18周`、单双周（`单`/`双`按周号取模）、`{}` 位掩码
  两种形态都见过——`parse_week_indexes` / `week_mask_to_indexes` 各自处理，二者结论应一致
  （有单测互证）。
- 节次字段 `jcs`：`"1-2"` 之类的区间文本（`parse_unit_range`）。
- 学期列表要**逐个补周历**才有起止日期（没日期的学期落库那步会被直接丢掉），
  所以只取当前学年 ±1，再加调用方 `wanted` 指定的那个学期——用户翻回老学期时
  少了它，选择会**静默落到别的学期上**，比报错更糟。

## 能力位

老版正方（zftal 学生端）目前只打通课表主线：课程详情 / 培养方案 / 全校开课查询 / 选课
四个可选能力都没有对应接口，spec 里声明为全 `false`（`ZFSOFT_CAPS`），入口自动隐藏；
「课程详情」由本机同步下来的档案兜底（`stores/campus.ts::offlineCourseDetail`）。

## 表单细节

- 数据接口全是 `application/x-www-form-urlencoded`，且**必须带对 Referer**
  （教务按它判断「你是从哪个菜单点进来的」）。
- 登录表单固定项：`zh_CN` 语言、`csrftoken` 隐藏域（字段名逐字对齐登录页源码）。
- 教学班稳定 id：`jxb_id` 经 `stable_lesson_id` 哈希落库（源 id 非数字）。

## 真机联调

```powershell
$env:REIN_GXUST_USER='学号'; $env:REIN_GXUST_PASS='...'
cargo test --lib campus::adapters::zfsoft::tests::live -- --ignored --nocapture
```

默认 `#[ignore]`：真机用例只在有凭据时手动跑，CI 永远不碰教务。
