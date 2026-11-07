//! 本地嵌入模型注册表 + 按需下载。
//!
//! **安装包不内置任何向量模型**：模型从 24 MB（small）到 543 MB（m3），
//! 编进包等于凭空撑大安装包，而默认的检索模式是纯关键词，绝大多数用户用不到。
//! 所有模型都按需下载到 `{app_data}/models/{id}/`（`model.onnx` + `tokenizer.json`），
//! 可删可换。
//!
//! **下载源**：主用 `hf-mirror.com`（国内可达，实测 200），回退 ModelScope。
//! 直连 huggingface.co 在国内多数网络不可达，不作为候选。
//!
//! **换模型 = 换向量空间**：每个模型有独立的 `model_id`（写进 kb_vectors.model_id），
//! 切换时旧向量会被清掉重算——绝不能把两个模型的向量混在一张表里比余弦。

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use crate::error::{ReinError, Result};

/// 池化方式。BGE 系列用 CLS（首 token）；多语 MiniLM 用 mean（带掩码平均）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pooling {
    Cls,
    Mean,
}

/// 一个可选的本地模型（静态注册表）。`PartialEq` 只为 `EmbedConfig` 的相等比较服务。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalModel {
    /// 稳定标识，也是 kb_vectors.model_id
    pub id: &'static str,
    pub label: &'static str,
    /// 档位：light | standard | high | multi
    pub tier: &'static str,
    pub dim: usize,
    pub pooling: Pooling,
    pub max_len: usize,
    /// model.onnx 的字节数（用于进度与完整性判据）
    pub onnx_bytes: u64,
    pub tokenizer_bytes: u64,
    /// HuggingFace 仓库（hf-mirror.com 与 ModelScope 都按这个路径取）
    pub repo: &'static str,
    /// 一句话卖点（UI 直接用）
    pub note: &'static str,
}

/// 缺省本地模型的 id（历史值，不能改：老库的 local_model 与向量都记着它）。
pub const DEFAULT_MODEL_ID: &str = "bge-small-zh-v1.5-int8";

/// 可选的本地嵌入模型（体积为实测字节数，2026-10-07 校验）。
pub const MODELS: &[LocalModel] = &[
    LocalModel {
        id: DEFAULT_MODEL_ID,
        label: "轻量 · 中文",
        tier: "light",
        dim: 512,
        pooling: Pooling::Cls,
        max_len: 512,
        onnx_bytes: 24_010_842,
        tokenizer_bytes: 439_125,
        repo: "Xenova/bge-small-zh-v1.5",
        note: "中文短句够用、占用最小；下载约 24 MB，适合先试本地语义检索",
    },
    LocalModel {
        id: "bge-base-zh-v1.5-int8",
        label: "标准 · 中文",
        tier: "standard",
        dim: 768,
        pooling: Pooling::Cls,
        max_len: 512,
        onnx_bytes: 102_868_746,
        tokenizer_bytes: 439_124,
        repo: "Xenova/bge-base-zh-v1.5",
        note: "中文语义明显更细（同义改写、长句都能捞到），下载约 98 MB，日常首选",
    },
    LocalModel {
        id: "bge-large-zh-v1.5-int8",
        label: "高精度 · 中文",
        tier: "high",
        dim: 1024,
        pooling: Pooling::Cls,
        max_len: 512,
        onnx_bytes: 327_363_707,
        tokenizer_bytes: 439_124,
        repo: "Xenova/bge-large-zh-v1.5",
        note: "中文检索天花板一档（MTEB-zh 榜首家族），下载约 312 MB，桌面优先",
    },
    LocalModel {
        id: "bge-m3-int8",
        label: "多语 · 超大",
        tier: "multi",
        dim: 1024,
        pooling: Pooling::Cls,
        max_len: 512,
        onnx_bytes: 569_694_530,
        tokenizer_bytes: 17_082_821,
        repo: "Xenova/bge-m3",
        note: "100+ 语言、长文本友好；下载约 543 MB，手机不建议",
    },
    LocalModel {
        id: "paraphrase-multilingual-MiniLM-L12-v2-int8",
        label: "轻量 · 多语",
        tier: "multi",
        dim: 384,
        pooling: Pooling::Mean,
        max_len: 256,
        onnx_bytes: 118_308_126,
        tokenizer_bytes: 17_082_913,
        repo: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
        note: "多语种（含中文）折中档；384 维更省内存，下载约 113 MB",
    },
];

pub fn find(id: &str) -> Option<&'static LocalModel> {
    MODELS.iter().find(|m| m.id == id)
}

/// 缺省本地模型（最轻的一档）。
pub fn default_model() -> &'static LocalModel {
    find(DEFAULT_MODEL_ID).expect("缺省模型必须在注册表里")
}

fn data_root(data_dir: &Path) -> PathBuf {
    data_dir.join("models")
}

pub fn model_dir(data_dir: &Path, id: &str) -> PathBuf {
    data_root(data_dir).join(id)
}

pub fn onnx_path(data_dir: &Path, id: &str) -> PathBuf {
    model_dir(data_dir, id).join("model.onnx")
}

pub fn tokenizer_path(data_dir: &Path, id: &str) -> PathBuf {
    model_dir(data_dir, id).join("tokenizer.json")
}

/// 是否已下载就绪。
pub fn is_installed(data_dir: &Path, m: &LocalModel) -> bool {
    onnx_path(data_dir, m.id).is_file() && tokenizer_path(data_dir, m.id).is_file()
}

/// 磁盘占用（字节；未安装 = 0）。
pub fn disk_bytes(data_dir: &Path, m: &LocalModel) -> u64 {
    let mut total = 0;
    for p in [onnx_path(data_dir, m.id), tokenizer_path(data_dir, m.id)] {
        total += std::fs::metadata(p).map(|md| md.len()).unwrap_or(0);
    }
    total
}

/* ---------- 下载 ---------- */

/// 正在进行的下载（id 集合），以及被请求取消的 id。
static CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn cancelled_set() -> &'static Mutex<Option<HashSet<String>>> {
    &CANCELLED
}

pub fn request_cancel(id: &str) {
    if let Ok(mut g) = cancelled_set().lock() {
        g.get_or_insert_with(HashSet::new).insert(id.to_string());
    }
}

fn take_cancelled(id: &str) -> bool {
    if let Ok(mut g) = cancelled_set().lock() {
        if let Some(set) = g.as_mut() {
            return set.remove(id);
        }
    }
    false
}

/// 候选 URL（先 hf-mirror，再 ModelScope）。
fn urls_for(repo: &str, file: &str) -> Vec<String> {
    vec![
        format!("https://hf-mirror.com/{repo}/resolve/main/{file}"),
        format!(
            "https://modelscope.cn/api/v1/models/{repo}/repo?Revision=master&FilePath={file}"
        ),
    ]
}

/// 下载一个文件到 `dest`（先写 `.part` 再改名，中断不留半截文件）。
fn download_file(
    repo: &str,
    file: &str,
    dest: &Path,
    on_progress: &mut dyn FnMut(u64, u64),
    is_cancelled: &mut dyn FnMut() -> bool,
) -> Result<u64> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| ReinError::Message(format!("创建模型目录失败：{e}")))?;
    }
    let tmp = dest.with_extension("part");
    let mut last_err = String::new();
    for url in urls_for(repo, file) {
        match ureq::get(&url)
            .timeout(std::time::Duration::from_secs(600))
            .call()
        {
            Ok(resp) => {
                let total: u64 = resp
                    .header("Content-Length")
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                let mut reader = resp.into_reader();
                let mut out = std::fs::File::create(&tmp)
                    .map_err(|e| ReinError::Message(format!("写入模型文件失败：{e}")))?;
                let mut buf = vec![0u8; 64 * 1024];
                let mut done: u64 = 0;
                // 进度按 1% 粒度上报：64 KB 一块会把事件刷爆（569 MB 的模型 ≈ 8700 次），
                // 每次事件都会让前端重渲染一遍。总长度未知时退化为每 4 MB 一次。
                let step = if total > 0 {
                    (total / 100).max(64 * 1024)
                } else {
                    4 * 1024 * 1024
                };
                let mut next_emit = step;
                loop {
                    if is_cancelled() {
                        drop(out);
                        let _ = std::fs::remove_file(&tmp);
                        return Err(ReinError::Message("已取消下载".into()));
                    }
                    let n = reader
                        .read(&mut buf)
                        .map_err(|e| ReinError::Message(format!("下载中断：{e}")))?;
                    if n == 0 {
                        break;
                    }
                    use std::io::Write;
                    out.write_all(&buf[..n])
                        .map_err(|e| ReinError::Message(format!("写入模型文件失败：{e}")))?;
                    done += n as u64;
                    if done >= next_emit {
                        on_progress(done, total);
                        next_emit = done + step;
                    }
                }
                drop(out);
                // 收尾一定报一次：UI 靠它拿到 100%（否则最后一步可能永远显示不到满）
                on_progress(done, total);
                if done == 0 {
                    last_err = format!("{url} 返回空文件");
                    let _ = std::fs::remove_file(&tmp);
                    continue;
                }
                std::fs::rename(&tmp, dest)
                    .map_err(|e| ReinError::Message(format!("就位模型文件失败：{e}")))?;
                return Ok(done);
            }
            Err(e) => {
                last_err = format!("{url} 失败：{e}");
            }
        }
    }
    // 全部候选都失败：清掉 `.part` 残片
    let _ = std::fs::remove_file(&tmp);
    Err(ReinError::Message(format!(
        "下载 {file} 失败（hf-mirror 与 ModelScope 都不通）：{last_err}"
    )))
}

/// 下载一个模型（两个文件）。`on_progress(file, done, total)` 用于上报进度（1% 粒度）。
pub fn download(
    data_dir: &Path,
    m: &LocalModel,
    on_progress: &mut dyn FnMut(&str, u64, u64),
) -> Result<u64> {
    // 开始前清掉可能残留的取消标志：上一次下载结束后点过一次取消的话，
    // 留下来的标志会让这一次刚开始就被判为「已取消」。
    let _ = take_cancelled(m.id);
    let mut written = 0u64;
    for (file, rel, expect) in [
        ("model.onnx", "onnx/model_quantized.onnx", m.onnx_bytes),
        ("tokenizer.json", "tokenizer.json", m.tokenizer_bytes),
    ] {
        let dest = if file == "model.onnx" {
            onnx_path(data_dir, m.id)
        } else {
            tokenizer_path(data_dir, m.id)
        };
        let mut is_cancelled = || take_cancelled(m.id);
        let mut on_prog = |done: u64, total: u64| on_progress(file, done, total);
        let n = download_file(m.repo, rel, &dest, &mut on_prog, &mut is_cancelled)?;
        // 完整性下界检查：明显比注册表小 = 被截断/换成了别的东西
        if expect > 0 && n < expect / 10 * 9 {
            let _ = remove(data_dir, m);
            return Err(ReinError::Message(format!(
                "{file} 体积异常（{} < 预期约 {}），已回滚，请重试",
                n, expect
            )));
        }
        written += n;
    }
    Ok(written)
}

/// 删除一个已下载模型。返回释放的字节数。
pub fn remove(data_dir: &Path, m: &LocalModel) -> Result<u64> {
    let dir = model_dir(data_dir, m.id);
    if !dir.exists() {
        return Ok(0);
    }
    let bytes = disk_bytes(data_dir, m);
    std::fs::remove_dir_all(&dir).map_err(|e| ReinError::Message(format!("删除模型失败：{e}")))?;
    Ok(bytes)
}

/* ---------- IPC 投影 ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedModelInfo {
    pub id: String,
    pub label: String,
    pub tier: String,
    pub dim: i64,
    pub bytes: i64,
    pub note: String,
    pub installed: bool,
    /// 磁盘上实际占用（未安装 = 0）
    pub disk_bytes: i64,
    /// 当前是否正在下载
    pub downloading: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedCatalog {
    pub models: Vec<EmbedModelInfo>,
    /// 当前生效的本地模型 id
    pub current: String,
    /// 当前检索模式（keyword | local | cloud）
    pub mode: String,
    /// 模型目录所在路径（排查用）
    pub dir: String,
}

/// 组装 IPC 目录（不含下载态，调用方按需覆盖）。
pub fn catalog(data_dir: &Path, current: &str, mode: &str) -> EmbedCatalog {
    EmbedCatalog {
        models: MODELS
            .iter()
            .map(|m| EmbedModelInfo {
                id: m.id.to_string(),
                label: m.label.to_string(),
                tier: m.tier.to_string(),
                dim: m.dim as i64,
                bytes: (m.onnx_bytes + m.tokenizer_bytes) as i64,
                note: m.note.to_string(),
                installed: is_installed(data_dir, m),
                disk_bytes: disk_bytes(data_dir, m) as i64,
                downloading: false,
            })
            .collect(),
        current: current.to_string(),
        mode: mode.to_string(),
        dir: data_root(data_dir).to_string_lossy().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::kb::embed::Embedder;

    #[test]
    fn registry_ids_are_unique_and_default_exists() {
        let mut ids: Vec<_> = MODELS.iter().map(|m| m.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), MODELS.len(), "模型 id 不得重复");
        assert!(find(DEFAULT_MODEL_ID).is_some());
        for m in MODELS {
            assert!(m.dim > 0 && m.onnx_bytes > 0);
            assert!(!m.note.is_empty());
        }
    }

    #[test]
    fn models_report_not_installed_without_files() {
        let dir = std::env::temp_dir().join("rein-embed-models-empty");
        let _ = std::fs::remove_dir_all(&dir);
        for m in MODELS {
            assert!(!is_installed(&dir, m), "{} 的安装态判错了", m.id);
        }
        let base = find("bge-base-zh-v1.5-int8").unwrap();
        assert_eq!(disk_bytes(&dir, base), 0);
        assert_eq!(remove(&dir, default_model()).unwrap(), 0, "未下载的模型删除应为空操作");
    }

    #[test]
    fn urls_prefer_mirror_and_fall_back_to_modelscope() {
        let urls = urls_for("Xenova/bge-base-zh-v1.5", "onnx/model_quantized.onnx");
        assert_eq!(urls.len(), 2);
        assert!(urls[0].starts_with("https://hf-mirror.com/Xenova/bge-base-zh-v1.5/"));
        assert!(urls[1].starts_with("https://modelscope.cn/"));
    }

    /// 真网络端到端：下载最轻那颗模型 → 落盘 → 真加载 → 真嵌入 → 删除。
    ///
    /// 为什么值得留：下载链路的每一环（URL 有效性、重定向、流式写盘、体积下界判据、
    /// ONNX 能被 ORT 打开）都只有真下才能真正验证；模型源换域名时这条会先红。
    /// 默认 `#[ignore]`：24 MB 下载 + 模型加载，不该拖慢日常 `cargo test`。
    /// 跑法：`cargo test --lib -- --ignored download_small_model_over_network`
    #[test]
    #[ignore]
    fn download_small_model_over_network() {
        let src = default_model();
        let m = LocalModel {
            id: "bge-small-zh-v1.5-int8-dltest",
            label: "下载自检",
            tier: "light",
            dim: src.dim,
            pooling: src.pooling,
            max_len: src.max_len,
            onnx_bytes: src.onnx_bytes,
            tokenizer_bytes: src.tokenizer_bytes,
            repo: src.repo,
            note: "测试用",
        };
        // LocalEmbedder 持有 &'static（生产路径全是注册表常量）；测试里泄漏一份最省事
        let m: &'static LocalModel = Box::leak(Box::new(m));
        let dir = std::env::temp_dir().join("rein-embed-dl-test");
        let _ = std::fs::remove_dir_all(&dir);
        let written = download(&dir, m, &mut |_file, _done, _total| {})
            .expect("下载应成功（hf-mirror 或 ModelScope 至少一个可达）");
        assert!(
            written > 20 * 1024 * 1024,
            "两个文件合计应超过 20 MB，实际 {written}"
        );
        assert!(is_installed(&dir, m));

        // 真加载 + 真嵌入（同时验证下载的字节没坏）
        let e = super::super::embed::LocalEmbedder::new(&dir, m).expect("下载的模型应能加载");
        assert_eq!(e.probe().unwrap(), 512);
        let freed = remove(&dir, m).unwrap();
        assert!(freed > 20 * 1024 * 1024, "删除应回报释放体积");
        assert!(!is_installed(&dir, m), "删掉后应回到未安装态");
    }
}
