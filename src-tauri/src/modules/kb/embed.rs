//! Embedding 接口：进程内本地推理 / 云端 OpenAI 兼容端点 / 纯关键词（不嵌入）。
//!
//! **为什么是 ONNX Runtime + load-dynamic**：编译期不链接 ORT，运行时由我们显式加载，
//! 因此三条构建链路（Windows x64 / Windows ARM64 / Android aarch64）都不需要平台专属的
//! 链接配置。配合 `tokenizers` 的 `fancy-regex`（而非默认的 `onig`），整棵依赖树零 C 代码——
//! 实测三端交叉编译只需指定 NDK 链接器。详见 docs/kb-embed-benchmark.md。
//!
//! **本地模型完全可选**（见 `embed_models.rs`）：安装包不内置任何向量模型，
//! 默认走纯关键词检索；需要语义检索时再按需下载到 `{app_data}/models/{id}/`，
//! 由本模块从磁盘加载。**换模型必须换 `model_id`**（写进 kb_vectors.model_id），
//! 否则旧向量会被当成新模型的向量复用，检索结果会静默错乱。
//!
//! **运行库**（onnxruntime.dll / .so）：Windows 内嵌并落盘到 `{app_data}/ort` 后 `/init_from`；
//! Android 例外——系统禁止从可写目录 dlopen，所以运行库必须走 jniLibs 由系统加载器按名字找。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use tokenizers::Tokenizer;
use tokenizers::TruncationParams;

use crate::error::{ReinError, Result};

use super::embed_models::{self, LocalModel, Pooling};
use super::settings;

/// 后台索引的 ORT 线程数。实测 2 线程已拿到约 1.8 倍收益，再往上边际很小，
/// 而核心应留给 UI——索引是后台任务，不该抢前台 CPU。
const INTRA_THREADS: usize = 2;

/* ---------- 运行库供给 ---------- */

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const ORT_LIB_BYTES: &[u8] = include_bytes!("../../../resources/ort/win-x64/onnxruntime.dll");
#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
const ORT_LIB_BYTES: &[u8] = include_bytes!("../../../resources/ort/win-arm64/onnxruntime.dll");

/// Android / 非 Windows 平台不用内嵌运行库：Android 从 jniLibs 按名字加载，
/// Linux 从系统路径加载。此时 `ORT_LIB_BYTES` 为空，`ensure_ort` 走按名加载分支。
#[cfg(not(any(
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "windows", target_arch = "aarch64")
)))]
const ORT_LIB_BYTES: &[u8] = &[];

/// ORT 环境是进程全局的，只能初始化一次，且必须在任何其他 ort API 之前。
static ORT_INIT: OnceLock<std::result::Result<(), String>> = OnceLock::new();

fn ensure_ort(data_dir: &Path) -> Result<()> {
    let r = ORT_INIT.get_or_init(|| {
        let path = if ORT_LIB_BYTES.is_empty() {
            PathBuf::from(if cfg!(target_os = "android") {
                // 由 APK 的 native lib 目录提供，加载器按名字查找
                "libonnxruntime.so"
            } else {
                "libonnxruntime.so"
            })
        } else {
            match extract_ort_lib(data_dir) {
                Ok(p) => p,
                Err(e) => return Err(e),
            }
        };
        ort::init_from(&path)
            .map_err(|e| format!("加载 ONNX Runtime 失败（{}）：{e}", path.display()))?
            .commit();
        Ok(())
    });

    match r {
        Ok(()) => Ok(()),
        Err(e) => Err(ReinError::Message(e.clone())),
    }
}

/// 把内嵌的运行库落到应用数据目录再加载。落盘前比对体积，避免了每次启动都写 15 MB。
fn extract_ort_lib(data_dir: &Path) -> std::result::Result<PathBuf, String> {
    let name = if cfg!(target_os = "windows") {
        "onnxruntime.dll"
    } else {
        "libonnxruntime.so"
    };
    let dir = data_dir.join("ort");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 {} 失败：{e}", dir.display()))?;
    let target = dir.join(name);

    let up_to_date = std::fs::metadata(&target)
        .map(|m| m.len() == ORT_LIB_BYTES.len() as u64)
        .unwrap_or(false);
    if !up_to_date {
        // 先写临时文件再改名：中断不会留下半截文件被误判为完整
        let tmp = dir.join(format!("{name}.part"));
        std::fs::write(&tmp, ORT_LIB_BYTES).map_err(|e| format!("写入运行库失败：{e}"))?;
        std::fs::rename(&tmp, &target).map_err(|e| format!("就位运行库失败：{e}"))?;
    }
    Ok(target)
}

/* ---------- 接口 ---------- */

pub trait Embedder: Send + Sync {
    /// 向量模型标识，落库到 kb_vectors.model_id。
    fn model_id(&self) -> &str;
    fn dim(&self) -> usize;
    /// 批量嵌入，返回顺序与入参一致、且已做 L2 归一化的向量。
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;

    /// 连通性/可用性自检：嵌一句话并校验维度。
    fn probe(&self) -> Result<usize> {
        let v = self.embed(&["膝盖".to_string()])?;
        let first = v
            .first()
            .ok_or_else(|| ReinError::Message("嵌入返回空结果".into()))?;
        if first.len() != self.dim() {
            return Err(ReinError::Message(format!(
                "嵌入维度不符：期望 {}，实际 {}",
                self.dim(),
                first.len()
            )));
        }
        Ok(first.len())
    }
}

/// L2 归一化。归一化后余弦相似度退化成点积，检索时省一半计算。
pub fn normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-12 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

/* ---------- 本地 ORT ---------- */

pub struct LocalEmbedder {
    /// `Session::run` 需要 `&mut`，而 trait 方法只有 `&self`，所以用 Mutex 包一层。
    /// 索引线程是单线程消费，实际不会有争用。
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    input_names: Vec<String>,
    /// 注册表里的模型（维度 / 池化 / 标识都从它读）
    model: &'static LocalModel,
}

impl LocalEmbedder {
    /// 按注册表加载一个本地模型。未下载的模型在这里报「先下载」的可操作错误。
    pub fn new(data_dir: &Path, model: &'static LocalModel) -> Result<Self> {
        ensure_ort(data_dir)?;

        let tokenizer_path = embed_models::tokenizer_path(data_dir, model.id);
        if !tokenizer_path.is_file() {
            return Err(ReinError::Message(format!(
                "本地模型「{}」尚未下载（缺 {}），先到知识库设置里下载",
                model.label,
                tokenizer_path.display()
            )));
        }
        let mut tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| ReinError::Message(format!("加载分词器失败（{}）：{e}", tokenizer_path.display())))?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: model.max_len,
                ..Default::default()
            }))
            .map_err(|e| ReinError::Message(format!("配置分词截断失败：{e}")))?;

        let mut session = Session::builder()
            .map_err(|e| ReinError::Message(format!("创建嵌入会话失败：{e}")))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| ReinError::Message(format!("配置图优化失败：{e}")))?
            .with_intra_threads(INTRA_THREADS)
            .map_err(|e| ReinError::Message(format!("配置线程数失败：{e}")))?;
        let model_path = embed_models::onnx_path(data_dir, model.id);
        if !model_path.is_file() {
            return Err(ReinError::Message(format!(
                "本地模型「{}」尚未下载（缺 {}），先到知识库设置里下载",
                model.label,
                model_path.display()
            )));
        }
        let session = session
            .commit_from_file(&model_path)
            .map_err(|e| ReinError::Message(format!("加载嵌入模型失败（{}）：{e}", model_path.display())))?;

        let input_names = session
            .inputs()
            .iter()
            .map(|i| i.name().to_string())
            .collect();
        let me = Self {
            session: Mutex::new(session),
            tokenizer,
            input_names,
            model,
        };
        // 装好就自检一次：维度/池化/分词器任何一处配错，都在这里而不是在检索时炸
        let dim = me.probe()?;
        if dim != model.dim {
            return Err(ReinError::Message(format!(
                "模型自检失败：注册表声明 {} 维，实际输出 {dim} 维（模型文件与注册表不匹配）",
                model.dim
            )));
        }
        Ok(me)
    }

    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let mut out = Vec::with_capacity(texts.len());
        for text in texts {
            out.push(self.embed_one(text)?);
        }
        Ok(out)
    }

    fn embed_one(&self, text: &str) -> Result<Vec<f32>> {
        let enc = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| ReinError::Message(format!("分词失败：{e}")))?;
        let seq = enc.get_ids().len();
        if seq == 0 {
            return Ok(vec![0.0; self.model.dim]);
        }
        let shape = vec![1i64, seq as i64];
        let ids: Vec<i64> = enc.get_ids().iter().map(|&x| x as i64).collect();
        let mask: Vec<i64> = enc.get_attention_mask().iter().map(|&x| x as i64).collect();
        let tti: Vec<i64> = enc.get_type_ids().iter().map(|&x| x as i64).collect();

        // 按模型声明的输入名逐个喂，避免硬编码 BERT 三件套踩到导出差异
        let mut named: Vec<(String, Tensor<i64>)> = Vec::with_capacity(self.input_names.len());
        for name in &self.input_names {
            let data = match name.as_str() {
                "input_ids" => ids.clone(),
                "attention_mask" => mask.clone(),
                "token_type_ids" => tti.clone(),
                other => {
                    return Err(ReinError::Message(format!(
                        "嵌入模型有未预期的输入：{other}"
                    )))
                }
            };
            named.push((
                name.clone(),
                Tensor::from_array((shape.clone(), data))
                    .map_err(|e| ReinError::Message(format!("构造输入张量失败：{e}")))?,
            ));
        }

        let mut session = self
            .session
            .lock()
            .map_err(|_| ReinError::Message("嵌入会话已损坏".into()))?;
        let outputs = session
            .run(named)
            .map_err(|e| ReinError::Message(format!("嵌入推理失败：{e}")))?;

        let tensor = outputs
            .get("last_hidden_state")
            .or_else(|| outputs.get("sentence_embedding"))
            .ok_or_else(|| ReinError::Message("嵌入模型输出里没有 last_hidden_state".into()))?;
        let (shape, data) = tensor
            .try_extract_tensor::<f32>()
            .map_err(|e| ReinError::Message(format!("读取嵌入输出失败：{e}")))?;

        let dim = *shape.last().unwrap_or(&0) as usize;
        let dim = dim.max(1);
        let mut v = match self.model.pooling {
            // BGE 系列：取 last_hidden_state 的首 token（CLS）
            Pooling::Cls => data[0..dim.min(data.len())].to_vec(),
            // 多语 MiniLM/E5 系：按 attention mask 做均值池化
            Pooling::Mean => {
                let rows = data.len() / dim;
                let mut acc = vec![0f32; dim];
                let mut n = 0f32;
                for t in 0..rows.min(mask.len()) {
                    if mask[t] == 0 {
                        continue;
                    }
                    for d in 0..dim {
                        acc[d] += data[t * dim + d];
                    }
                    n += 1.0;
                }
                if n > 0.0 {
                    for x in acc.iter_mut() {
                        *x /= n;
                    }
                }
                acc
            }
        };
        v.resize(self.model.dim, 0.0);
        normalize(&mut v);
        Ok(v)
    }
}

impl Embedder for LocalEmbedder {
    fn model_id(&self) -> &str {
        self.model.id
    }
    fn dim(&self) -> usize {
        self.model.dim
    }
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        self.embed_batch(texts)
    }
}

/* ---------- 云端 ---------- */

pub struct CloudEmbedder {
    endpoint: String,
    api_key: String,
    model: String,
    dim: usize,
}

impl CloudEmbedder {
    /// `base_url` 形如 `https://api.example.com/v1`（与 ai_models 的约定一致），
    /// 这里补上 `/embeddings`。
    pub fn new(base_url: &str, api_key: &str, model: &str, dim: Option<i64>) -> Self {
        let base = base_url.trim_end_matches('/');
        Self {
            endpoint: format!("{base}/embeddings"),
            api_key: api_key.to_string(),
            model: model.to_string(),
            // 维度未知时先按 1024 占位，首次嵌入会用实际长度纠正
            dim: dim.filter(|d| *d > 0).map(|d| d as usize).unwrap_or(1024),
        }
    }

    fn call(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let body = serde_json::json!({ "model": self.model, "input": texts });
        let resp = ureq::post(&self.endpoint)
            .set("Authorization", &format!("Bearer {}", self.api_key))
            .set("Content-Type", "application/json")
            .timeout(std::time::Duration::from_secs(30))
            .send_string(&body.to_string())
            .map_err(|e| ReinError::Message(format!("云端嵌入请求失败：{e}")))?;

        let text = resp
            .into_string()
            .map_err(|e| ReinError::Message(format!("云端嵌入响应读取失败：{e}")))?;
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| ReinError::Message(format!("云端嵌入响应不是 JSON：{e}")))?;

        let arr = json
            .get("data")
            .and_then(|v| v.as_array())
            .ok_or_else(|| ReinError::Message("云端嵌入响应缺少 data 字段".into()))?;

        // 有些实现不保证顺序，按 index 归位
        let mut items: Vec<(usize, Vec<f32>)> = Vec::with_capacity(arr.len());
        for (i, item) in arr.iter().enumerate() {
            let idx = item
                .get("index")
                .and_then(|v| v.as_u64())
                .unwrap_or(i as u64) as usize;
            let vec = item
                .get("embedding")
                .and_then(|v| v.as_array())
                .ok_or_else(|| ReinError::Message("云端嵌入条目缺少 embedding".into()))?
                .iter()
                .map(|x| x.as_f64().unwrap_or(0.0) as f32)
                .collect::<Vec<f32>>();
            items.push((idx, vec));
        }
        items.sort_by_key(|(i, _)| *i);

        let mut out: Vec<Vec<f32>> = items.into_iter().map(|(_, v)| v).collect();
        if out.len() != texts.len() {
            return Err(ReinError::Message(format!(
                "云端嵌入返回条数不符：期望 {}，实际 {}",
                texts.len(),
                out.len()
            )));
        }
        for v in out.iter_mut() {
            normalize(v);
        }
        Ok(out)
    }
}

impl Embedder for CloudEmbedder {
    fn model_id(&self) -> &str {
        &self.model
    }
    fn dim(&self) -> usize {
        self.dim
    }
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        // 云端按批发送：一次 32 条，兼顾延迟与请求体大小
        let mut out = Vec::with_capacity(texts.len());
        for chunk in texts.chunks(32) {
            out.extend(self.call(chunk)?);
        }
        Ok(out)
    }
}

/* ---------- 装配 ---------- */

/// 解析后的嵌入配置。刻意与数据库连接解耦：构建 embedder 会加载模型（实测 130 ms），
/// 必须能在**不持数据库锁**的情况下进行，否则首次检索会把界面卡住。
#[derive(Debug, Clone, PartialEq)]
pub struct EmbedConfig {
    pub mode: String,
    /// 本地模型（mode=local 时生效；注册表里找不到会回落到缺省那颗）
    pub local: &'static LocalModel,
    /// (base_url, api_key, model, dim)
    pub cloud: Option<(String, String, String, Option<i64>)>,
}

/// 读一次配置。调用方在持锁期间只做这一步，随后放锁再调 `build`。
pub fn resolve_config(conn: &rusqlite::Connection) -> Result<EmbedConfig> {
    let s = settings::get(conn)?;
    let local = embed_models::find(&s.local_model).unwrap_or_else(embed_models::default_model);
    let cloud = if s.embedding_mode == crate::modules::kb::models::MODE_CLOUD {
        settings::cloud_config(conn)?
    } else {
        None
    };
    Ok(EmbedConfig {
        mode: s.embedding_mode,
        local,
        cloud,
    })
}

/// 从配置直接推出向量模型标识，**不需要真的构建 embedder**。
/// 索引线程靠它在持锁阶段就知道该给哪些块算向量，而把真正耗时的构建放到放锁之后。
pub fn model_id_of(cfg: &EmbedConfig) -> Option<String> {
    match cfg.mode.as_str() {
        crate::modules::kb::models::MODE_LOCAL => Some(cfg.local.id.to_string()),
        crate::modules::kb::models::MODE_CLOUD => cfg.cloud.as_ref().map(|(_, _, m, _)| m.clone()),
        _ => None,
    }
}

/// 嵌入身份的指纹：**当前模式真正生效的那部分**（本地模式看本地模型，云端模式看云端模型）。
///
/// `kb_settings_set` 用它判断要不要作废旧向量，它也是 embedder 缓存的键。
/// 只取生效部分是有意的：云端模式下改一下本地模型的选择，不该把云端向量全清掉
/// （那是按量计费的重算）。
pub fn identity(cfg: &EmbedConfig) -> String {
    match cfg.mode.as_str() {
        crate::modules::kb::models::MODE_LOCAL => format!("local|{}", cfg.local.id),
        crate::modules::kb::models::MODE_CLOUD => {
            let cloud = cfg
                .cloud
                .as_ref()
                .map(|(_, _, m, d)| format!("{m}:{}", d.unwrap_or(0)))
                .unwrap_or_default();
            format!("cloud|{cloud}")
        }
        other => other.to_string(),
    }
}

/// 按配置构造 embedder。`keyword` 模式返回 None——调用方据此跳过向量召回。
pub fn build(cfg: &EmbedConfig, data_dir: &Path) -> Result<Option<Box<dyn Embedder>>> {
    match cfg.mode.as_str() {
        crate::modules::kb::models::MODE_LOCAL => Ok(Some(Box::new(LocalEmbedder::new(
            data_dir, cfg.local,
        )?))),
        crate::modules::kb::models::MODE_CLOUD => match &cfg.cloud {
            Some((url, key, model, dim)) => {
                Ok(Some(Box::new(CloudEmbedder::new(url, key, model, *dim))))
            }
            None => Err(ReinError::Message(
                "云端嵌入尚未配置完整（需要 base URL、API Key、模型名）".into(),
            )),
        },
        _ => Ok(None),
    }
}

/* ---------- 自定义测试 ---------- */

/// 一次「自定义嵌入测试」的输入。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedTestInput {
    /// 要对比的文本（第一段是查询，其余是候选；只有一段时只回向量摘要）
    pub texts: Vec<String>,
    /// 临时覆盖本地模型 id（不落库，用于「对比两个模型」）
    pub local_model: Option<String>,
    /// 临时覆盖云端配置（先测再存）
    pub cloud: Option<EmbedTestCloud>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedTestCloud {
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub dim: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedTestVector {
    pub text: String,
    pub dim: i64,
    /// 向量前 8 维（够看「是不是在动」；也避免把整条向量塞进 IPC）
    pub preview: Vec<f32>,
    pub norm: f32,
    pub ms: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedTestRank {
    pub text: String,
    /// 与第一段（查询）的余弦
    pub score: f32,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedTestResult {
    /// 实际使用的后端标识（本地=模型 id，云端=模型名）
    pub model_id: String,
    pub dim: i64,
    pub vectors: Vec<EmbedTestVector>,
    /// 以第一段为查询的相似度排序（不含查询自己；文本少于 2 段时为空）
    pub ranking: Vec<EmbedTestRank>,
    /// 首次构建耗时（毫秒，含模型加载）
    pub build_ms: f64,
    pub total_ms: f64,
    pub note: String,
}

/// 用**指定后端**跑一次自定义文本嵌入测试。不落库、不改设置。
///
/// 用途有三：换云端配置前先验证连通与维度；换本地模型前拿自己的中文文本对比效果；
/// 排查「检索捞不到」时确认向量本身是否在动。
pub fn test(
    cfg: &EmbedConfig,
    data_dir: &Path,
    input: &EmbedTestInput,
) -> Result<EmbedTestResult> {
    let texts: Vec<String> = input
        .texts
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if texts.is_empty() {
        return Err(ReinError::Message("请至少输入一段文本".into()));
    }
    if texts.len() > 16 {
        return Err(ReinError::Message(
            "一次最多对比 16 段文本（省得等太久）".into(),
        ));
    }

    // 覆盖配置：临时换成本地模型 / 云端端点，不影响已保存的设置
    let mut use_cfg = cfg.clone();
    if let Some(id) = input.local_model.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let m = embed_models::find(id)
            .ok_or_else(|| ReinError::Message(format!("未知的本地模型：{id}")))?;
        use_cfg.local = m;
        use_cfg.mode = crate::modules::kb::models::MODE_LOCAL.to_string();
    }
    if let Some(c) = &input.cloud {
        let key = c
            .api_key
            .clone()
            .filter(|k| !k.trim().is_empty())
            .or_else(|| use_cfg.cloud.as_ref().map(|(_, k, _, _)| k.clone()))
            .unwrap_or_default();
        use_cfg.cloud = Some((c.base_url.clone(), key, c.model.clone(), c.dim));
        use_cfg.mode = crate::modules::kb::models::MODE_CLOUD.to_string();
    }

    let t0 = std::time::Instant::now();
    let embedder = build(&use_cfg, data_dir)?
        .ok_or_else(|| ReinError::Message("当前是纯关键词模式，没有可直接测试的嵌入后端".into()))?;
    let build_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let mut vectors = Vec::with_capacity(texts.len());
    let mut vecs: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
    for t in &texts {
        let t0 = std::time::Instant::now();
        let v = embedder
            .embed(std::slice::from_ref(t))?
            .into_iter()
            .next()
            .unwrap_or_default();
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        vectors.push(EmbedTestVector {
            text: t.chars().take(40).collect(),
            dim: v.len() as i64,
            preview: v.iter().take(8).map(|x| (x * 10000.0).round() / 10000.0).collect(),
            norm: (norm * 10000.0).round() / 10000.0,
            ms: (ms * 100.0).round() / 100.0,
        });
        vecs.push(v);
    }

    let mut ranking: Vec<EmbedTestRank> = Vec::new();
    if vecs.len() >= 2 {
        let q = &vecs[0];
        for (i, v) in vecs.iter().enumerate().skip(1) {
            if v.len() != q.len() {
                continue;
            }
            let score: f32 = q.iter().zip(v).map(|(a, b)| a * b).sum();
            ranking.push(EmbedTestRank {
                text: texts[i].chars().take(60).collect(),
                score: (score * 10000.0).round() / 10000.0,
            });
        }
        ranking.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    }

    let note = if vectors.iter().any(|v| v.norm < 0.5) {
        "注意：有向量的模长接近 0（可能全是未知词/空文本），检索时会被跳过".to_string()
    } else if ranking.first().map(|r| r.score < 0.3).unwrap_or(false) {
        "最高相似度偏低：这几段文本在语义上确实离得远（或模型与语种不匹配）".to_string()
    } else {
        "向量已 L2 归一化；相似度即余弦（越接近 1 越像）".to_string()
    };

    Ok(EmbedTestResult {
        model_id: embedder.model_id().to_string(),
        dim: embedder.dim() as i64,
        vectors,
        ranking,
        build_ms: (build_ms * 10.0).round() / 10.0,
        total_ms: (t0.elapsed().as_secs_f64() * 1000.0 * 10.0).round() / 10.0,
        note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_makes_unit_vector() {
        let mut v = vec![3.0f32, 4.0];
        normalize(&mut v);
        assert!((v[0] - 0.6).abs() < 1e-6);
        assert!((v[1] - 0.8).abs() < 1e-6);
        assert!((v.iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn normalize_survives_zero_vector() {
        let mut v = vec![0.0f32, 0.0];
        normalize(&mut v);
        assert_eq!(v, vec![0.0, 0.0], "零向量不能除出 NaN");
    }

    #[test]
    fn cloud_endpoint_is_composed_from_base_url() {
        let e = CloudEmbedder::new("https://api.example.com/v1/", "k", "m", Some(512));
        assert_eq!(e.endpoint, "https://api.example.com/v1/embeddings");
        assert_eq!(e.dim(), 512);
    }

    /// 验证运行库按平台选对了供给方式。
    #[test]
    fn ort_lib_supply_matches_platform() {
        if cfg!(target_os = "windows")
            && (cfg!(target_arch = "x86_64") || cfg!(target_arch = "aarch64"))
        {
            assert!(!ORT_LIB_BYTES.is_empty(), "Windows 应内嵌运行库");
        } else {
            assert!(ORT_LIB_BYTES.is_empty(), "非 Windows 平台不应内嵌运行库");
        }
    }

    /// 未下载的模型要给出可操作的错误，而不是让检索崩掉。
    #[test]
    fn missing_downloaded_model_reports_actionably() {
        let dir = std::env::temp_dir().join("rein-kb-embed-missing");
        let _ = std::fs::remove_dir_all(&dir);
        let m = embed_models::find("bge-base-zh-v1.5-int8").unwrap();
        let err = match LocalEmbedder::new(&dir, m) {
            Ok(_) => panic!("模型文件不在，构造不该成功"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("尚未下载"), "{err}");
    }

    /// 云端覆盖：给了临时端点就走云端分支，不需要已保存的配置。
    #[test]
    fn embed_test_accepts_cloud_override_without_saved_config() {
        let dir = std::env::temp_dir().join("rein-kb-embed-test-cloud");
        let cfg = EmbedConfig {
            mode: "keyword".into(),
            local: embed_models::default_model(),
            cloud: None,
        };
        // 不真发请求：只验证配置被接受、请求失败时是「请求失败」而不是「没配置」
        let err = test(
            &cfg,
            &dir,
            &EmbedTestInput {
                texts: vec!["a".into(), "b".into()],
                local_model: None,
                cloud: Some(EmbedTestCloud {
                    base_url: "http://127.0.0.1:1/v1".into(),
                    api_key: Some("k".into()),
                    model: "m".into(),
                    dim: None,
                }),
            },
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("云端嵌入请求失败"), "{err}");
    }
}
