//! 校园教务域的 HTTP 会话层。
//!
//! 项目里 `ureq` 已有的三处调用（`web` 抓取、`voice` TTS、`kb` 云端 embedding）都是
//! 「一次性请求 + API Key 头」，**没有会话概念**。教务系统不一样：
//! 它靠 Cookie 认人，且会 302 把你踢回登录页。所以这里补三样东西：
//!
//! 1. [`CookieJar`] — `Set-Cookie` 的解析/合并/序列化，可整包落库（`campus_accounts.cookies`）；
//! 2. **浏览器伪装头** — 教务网关对裸请求很敏感，统一带上 UA / Accept / X-Requested-With；
//! 3. **不跟随重定向** — 靠 302 判定「会话过期」，而不是被静默跳到登录页拿到 200 才后知后觉。

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rsa::pkcs8::DecodePublicKey;
use rsa::{Pkcs1v15Encrypt, RsaPublicKey};
use serde::{Deserialize, Serialize};

use crate::error::{ReinError, Result};

/// 教务系统是慢站点（实测单个大响应可达数十秒），超时给宽一点。
const TIMEOUT: Duration = Duration::from_secs(60);

/// 选课接口的超时。选课是**跟时间赛跑**，这里的响应又都是几百字节的小 JSON，
/// 不该继承课表那条 60 秒的宽限 —— 一次挂起会把整个抢课引擎（单线程）堵住，
/// 而窗口只开几个小时，堵一分钟可能就错过一个名额释放。
///
/// 调小是安全的，因为 `grab::reconcile_lost_request` 那条路兜得住「超时了但请求其实到了」：
/// 重投之前会先用 `simplest-lessons` 核对这门课是不是已经在自己名下。
pub const SELECT_TIMEOUT: Duration = Duration::from_secs(12);

/// 与登录页实际发送的一致，避免被风控当成脚本。
pub(crate) const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// Cookie 名 → 值。只保留 (name, value)，Path/Domain 一律忽略——
/// 我们只跟单一站点打交道，不需要多域隔离。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CookieJar {
    #[serde(default)]
    items: Vec<(String, String)>,
}

impl CookieJar {
    pub fn from_json(raw: Option<&str>) -> Self {
        raw.filter(|s| !s.trim().is_empty())
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("CookieJar 序列化不可失败")
    }

    /// 供 UI 判断「是不是真的登录过」——只看主票据，不看 `rememberMe=deleteMe` 这类噪音。
    pub fn has_session_ticket(&self) -> bool {
        self.items
            .iter()
            .any(|(k, _)| k == "__pstsid__" || k == "SESSION")
    }

    /// `"a=1; b=2"`，空 jar 返回 None（不发送空 Cookie 头）。
    /// `pub(crate)` 是给救援面的脚本导出用的：脚本头部要把这份 Cookie 写成一个变量。
    pub(crate) fn header(&self) -> Option<String> {
        if self.items.is_empty() {
            return None;
        }
        Some(
            self.items
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }

    /// 解析单条 `Set-Cookie`。`Max-Age=0` 或值为 `deleteMe` 视为删除。
    fn absorb(&mut self, raw: &str) {
        let mut parts = raw.split(';');
        let Some(pair) = parts.next() else { return };
        let Some((name, value)) = pair.split_once('=') else {
            return;
        };
        let name = name.trim();
        let value = value.trim();
        if name.is_empty() {
            return;
        }

        let expired = parts.any(|attr| {
            let attr = attr.trim().to_ascii_lowercase();
            attr == "max-age=0"
                || attr.starts_with("expires=thu, 01 jan 1970")
                || attr.starts_with("expires=wed, 31 dec 1969")
        });

        if value.is_empty() || value == "deleteMe" || expired {
            self.items.retain(|(k, _)| k != name);
            return;
        }
        // 同名就地替换，保持原有顺序（与浏览器 Cookie jar 一致）
        match self.items.iter_mut().find(|(k, _)| k == name) {
            Some(slot) => slot.1 = value.to_string(),
            None => self.items.push((name.to_string(), value.to_string())),
        }
    }
}

/// 归一化后的响应：不看 ureq 的错误类型，只看状态码与内容。
pub struct HttpResponse {
    pub status: u16,
    /// 响应头（原样、按到达顺序）。业务代码一向只看状态码与正文，
    /// 这一列是给**救援面**的：教务改接口时，`Location` / `Content-Type` / 自定义头
    /// 往往是「到底发生了什么」的第一手线索，而这些东西只在浏览器 DevTools 里看得到。
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn is_ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// 302 → 登录页。这是教务系统表达「你没登录 / 登录过期」的方式。
    pub fn is_redirect(&self) -> bool {
        (300..400).contains(&self.status)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Result<serde_json::Value> {
        serde_json::from_slice(&self.body).map_err(ReinError::from)
    }
}

/// 一次会话。所有请求共享同一个 [`CookieJar`]，`&mut self` 串行化访问
/// （本项目单窗口，命令本身就在 `state.db` 那把锁下天然串行）。
pub struct Session {
    agent: ureq::Agent,
    jar: CookieJar,
    base: String,
}

impl Session {
    pub fn new(base_url: &str, jar: CookieJar) -> Self {
        Self::with_timeout(base_url, jar, TIMEOUT)
    }

    /// 指定超时的会话。抢课走 [`SELECT_TIMEOUT`]，其余走默认的 [`TIMEOUT`]。
    pub fn with_timeout(base_url: &str, jar: CookieJar, timeout: Duration) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout(timeout)
            // 关键：不跟随重定向。302 本身就是「会话过期」的信号，
            // 跟过去只会拿到登录页的 200，掩盖真实状态。
            .redirects(0)
            .build();
        Self {
            agent,
            jar,
            base: base_url.trim_end_matches('/').to_string(),
        }
    }

    pub fn jar(&self) -> &CookieJar {
        &self.jar
    }

    pub fn url(&self, path: &str) -> String {
        if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", self.base, path)
        }
    }

    /// 发起请求。`headers` 是额外头（会覆盖默认值）；`body` 为 None 时是 GET。
    pub fn request(
        &mut self,
        method: &str,
        path: &str,
        referer: Option<&str>,
        extra: &[(&str, &str)],
        body: Option<(&str, Vec<u8>)>,
    ) -> Result<HttpResponse> {
        let url = self.url(path);
        // 用 `Agent::request` 而不是逐个 match 便捷方法：救援面要能发 PUT / DELETE 这类
        // 任意方法，而「未识别的方法悄悄退化成 GET」会让日志与实际发出的请求对不上号 ——
        // 排障时最怕的就是这种安静的谎。
        let mut req = self.agent.request(method, &url);

        req = req
            .set("User-Agent", USER_AGENT)
            .set("Accept", "application/json, text/plain, */*")
            .set("Accept-Language", "zh-CN,zh;q=0.9")
            .set("X-Requested-With", "XMLHttpRequest")
            .set("Origin", &self.base);
        if let Some(r) = referer {
            req = req.set("Referer", &self.url(r));
        }
        for (k, v) in extra {
            req = req.set(k, v);
        }
        if let Some(h) = self.jar.header() {
            req = req.set("Cookie", &h);
        }

        let outcome = match body {
            Some((ct, bytes)) => req.set("Content-Type", ct).send_bytes(&bytes),
            None => req.call(),
        };

        // ureq 把非 2xx 也当 Err 返回；这里要的是「拿到状态码继续判断」，所以两种情况都收。
        let resp = match outcome {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(e) => return Err(ReinError::Message(format!("网络请求失败：{e}"))),
        };

        for raw in resp.all("set-cookie") {
            self.jar.absorb(raw);
        }

        read_response(resp)
    }

    pub fn get(&mut self, path: &str) -> Result<HttpResponse> {
        self.request("GET", path, None, &[], None)
    }

    pub fn get_with_referer(&mut self, path: &str, referer: &str) -> Result<HttpResponse> {
        self.request("GET", path, Some(referer), &[], None)
    }

    pub fn post_json(&mut self, path: &str, referer: &str, json: &serde_json::Value) -> Result<HttpResponse> {
        let bytes = serde_json::to_vec(json)?;
        self.request(
            "POST",
            path,
            Some(referer),
            &[],
            Some(("application/json", bytes)),
        )
    }
}

/// 把 ureq 的响应读成归一化形状（状态码 + 响应头 + 正文）。
///
/// 抽成自由函数是为了给救援面的**公网路径**复用：那条路刻意不走 [`Session`]
/// （它会把门户的 Origin/Referer 与 Cookie 一起带上），但「响应怎么读」只该有一份实现。
pub(crate) fn read_response(resp: ureq::Response) -> Result<HttpResponse> {
    let status = resp.status();
    let headers: Vec<(String, String)> = resp
        .headers_names()
        .into_iter()
        .flat_map(|k| {
            resp.all(&k)
                .into_iter()
                .map(move |v| (k.clone(), v.to_string()))
        })
        .collect();
    let body = resp
        .into_reader()
        .read_to_end_vec()
        .map_err(|e| ReinError::Message(format!("读取响应失败：{e}")))?;
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

/// `Read::read_to_end` 的小包装，省得在调用处再 `use std::io::Read`。
trait ReadToEndVec: std::io::Read {
    fn read_to_end_vec(&mut self) -> std::io::Result<Vec<u8>> {
        let mut buf = Vec::new();
        self.read_to_end(&mut buf)?;
        Ok(buf)
    }
}
impl<R: std::io::Read + ?Sized> ReadToEndVec for R {}

/// 「这个响应能不能继续用」的统一判定：302 = 会话没了（教务表达「你没登录」的方式），
/// 非 2xx = 这个请求本身没成。
///
/// 抽到 HTTP 层是因为两个厂商适配器都要这两句，而**错误码必须一致**：
/// `session_lost` 是上层自动重登的触发条件（`commands::is_session_lost` 认它），
/// 各写各的迟早会漏掉一边，表现就是「明明能自愈却让用户手动重登」。
pub fn guard(resp: &HttpResponse, what: &str) -> Result<()> {
    if resp.is_redirect() {
        return Err(ReinError::coded(
            "session_lost",
            format!("{what} 需要登录：会话已过期，请重新登录教务系统"),
        ));
    }
    if !resp.is_ok() {
        return Err(ReinError::Message(format!(
            "{what} 失败：HTTP {}",
            resp.status
        )));
    }
    Ok(())
}

/// 树维门户的登录握手：`RSA_PKCS1_v1_5(salt + "-" + password)`。
///
/// 对齐登录页 `JSEncrypt.encrypt()`：它用的是 **PKCS#1 v1.5 填充**（不是 OAEP，也没有 hash）。
/// 公钥是 1024-bit，单块明文上限 117 字节，而 `salt(36) + "-" + password` 远低于此。
pub fn rsa_encrypt_password(public_key_b64: &str, salt: &str, password: &str) -> Result<String> {
    let der = STANDARD
        .decode(public_key_b64)
        .map_err(|e| ReinError::Message(format!("登录公钥解析失败：{e}")))?;
    let key = RsaPublicKey::from_public_key_der(&der)
        .map_err(|e| ReinError::Message(format!("登录公钥无效：{e}")))?;

    let mut rng = rand::thread_rng();
    let plaintext = format!("{salt}-{password}");
    let ciphertext = key
        .encrypt(&mut rng, Pkcs1v15Encrypt, plaintext.as_bytes())
        .map_err(|e| ReinError::Message(format!("口令加密失败：{e}")))?;

    Ok(STANDARD.encode(ciphertext))
}

/// 正方（ZFSoft）的登录握手：`RSA_PKCS1_v1_5(password)`，公钥来自 `login_getPublicKey.html`。
///
/// 对齐登录页的 `rsaKey.setPublic(b64tohex(modulus), b64tohex(exponent))` + `hex2b64(rsaKey.encrypt(mm))`：
/// 同样是 **PKCS#1 v1.5 填充**（jsbn 的 type-2 填充），只是明文是**裸口令**（没有盐），
/// 且公钥是运行时取回的两个 base64 大数。
///
/// 实测的两个细节：
/// 1. 模数解出来是 **129 字节**而不是 128 —— Java 的 `BigInteger.toByteArray()` 给最高位
///    为 1 的数补了一个符号位 `0x00`，正方把这段字节原样 base64 出来。这是**正常的**，
///    `BigUint::from_bytes_be` 不在乎前导零，解密侧看到的数值一样（1024-bit）。
/// 2. 指数不是固定的 65537 字面量，而是同一份 JSON 里的 `AQAB`，必须一起 parse 成大数。
pub fn rsa_encrypt_password_with_key(
    modulus_b64: &str,
    exponent_b64: &str,
    password: &str,
) -> Result<String> {
    let modulus = STANDARD
        .decode(modulus_b64.trim())
        .map_err(|e| ReinError::Message(format!("登录公钥（模数）解析失败：{e}")))?;
    let exponent = STANDARD
        .decode(exponent_b64.trim())
        .map_err(|e| ReinError::Message(format!("登录公钥（指数）解析失败：{e}")))?;

    let key = RsaPublicKey::new(
        rsa::BigUint::from_bytes_be(&modulus),
        rsa::BigUint::from_bytes_be(&exponent),
    )
    .map_err(|e| ReinError::Message(format!("登录公钥无效：{e}")))?;

    let mut rng = rand::thread_rng();
    let ciphertext = key
        .encrypt(&mut rng, Pkcs1v15Encrypt, password.as_bytes())
        .map_err(|e| ReinError::Message(format!("口令加密失败：{e}")))?;

    Ok(STANDARD.encode(ciphertext))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jar_absorbs_and_replaces() {
        let mut jar = CookieJar::default();
        jar.absorb("__pstsid__=abc|def; Path=/; HttpOnly");
        jar.absorb("SESSION=xyz; Path=/");
        jar.absorb("__pstsid__=newer; Path=/");
        assert_eq!(jar.items.len(), 2);
        // 同名 Cookie 被后者覆盖，顺序保持插入序
        assert_eq!(jar.header().unwrap(), "__pstsid__=newer; SESSION=xyz");
        assert!(jar.has_session_ticket());
    }

    #[test]
    fn jar_drops_deleted_cookies() {
        let mut jar = CookieJar::default();
        jar.absorb("SESSION=xyz");
        jar.absorb("rememberMe=deleteMe; Path=/student; Max-Age=0");
        assert_eq!(jar.items.len(), 1);
        jar.absorb("SESSION=; Path=/");
        assert!(jar.items.is_empty());
        assert!(!jar.has_session_ticket());
        assert!(jar.header().is_none());
    }

    #[test]
    fn jar_json_roundtrip() {
        let mut jar = CookieJar::default();
        jar.absorb("__pstsid__=abc|def; Path=/");
        let revived = CookieJar::from_json(Some(&jar.to_json()));
        assert_eq!(revived.header(), jar.header());
        // 空串 / 垃圾输入都退化成空 jar，不炸
        assert!(CookieJar::from_json(Some("")).items.is_empty());
        assert!(CookieJar::from_json(Some("not json")).items.is_empty());
        assert!(CookieJar::from_json(None).items.is_empty());
    }

    #[test]
    fn rsa_matches_jsencrypt_layout() {
        // 用桂电真实公钥加密，产出应为 128 字节密文（1024-bit）的 base64 = 172 字符。
        //
        // 输入刻意用合成值：这两个参数原本是从真实会话里抄下来的（salt 与用户口令），
        // 而「口令不该出现在源码里」这条没有例外 —— 联调走 REIN_GUET_USER/REIN_GUET_PASS。
        // PKCS#1 v1.5 会补齐到 128 字节，所以换任何输入都不影响下面两条断言。
        let key = super::super::adapters::provider::spec("guet-supwisdom-eams5").unwrap();
        let public_key = key.login.public_key().expect("树维的公钥写在 spec 里");
        let out = rsa_encrypt_password(
            public_key,
            "00000000-0000-0000-0000-000000000000",
            "synthetic-passphrase.",
        )
        .unwrap();
        assert_eq!(out.len(), 172);
        assert_eq!(STANDARD.decode(&out).unwrap().len(), 128);
    }

    /// 正方的公钥是**运行时取回**的两个 base64 大数，且模数带着 Java 的符号位
    /// （实测 129 字节）。这条用例钉住两个事实：
    /// 1. 前导零不该让它被拒（`BigUint::from_bytes_be` 不在乎，但改错实现很容易踩）；
    /// 2. 密文长度仍是 128 字节（1024-bit）。
    ///
    /// 用合成模数而不是线上那个：公钥本身不是机密，但**没必要**把别人的站点指纹
    /// 抄进源码 —— 这里要验的是解析与加密，不是那个具体的数。
    #[test]
    fn zfsoft_rsa_tolerates_java_sign_byte() {
        // 129 字节：第一个字节是 Java `BigInteger.toByteArray()` 补的符号位
        let mut modulus = vec![0x00u8];
        modulus.extend(std::iter::repeat(0xAB).take(127));
        modulus.push(0xAD); // 质数模数必须是奇数
        let modulus_b64 = STANDARD.encode(&modulus);
        let exponent_b64 = STANDARD.encode([0x01u8, 0x00, 0x01]);

        let out =
            rsa_encrypt_password_with_key(&modulus_b64, &exponent_b64, "synthetic-passphrase")
                .unwrap();
        assert_eq!(out.len(), 172);
        assert_eq!(STANDARD.decode(&out).unwrap().len(), 128);

        // 解析不出 / 公钥退化的（e=1）都要有话说，而不是 panic
        assert!(rsa_encrypt_password_with_key("!!!", &exponent_b64, "x").is_err());
        assert!(rsa_encrypt_password_with_key(&modulus_b64, "AQ", "x").is_err());
    }
}
