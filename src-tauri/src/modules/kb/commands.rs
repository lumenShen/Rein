//! 知识库域命令 · 命令名与前端 `src/services/kbService.ts` 对应。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::OptionalExtension;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{ReinError, Result};
use crate::state::AppState;

use super::models::{
    KbChunk, KbCognition, KbDirListing, KbDocDetail, KbFile, KbFileInput, KbFsMove, KbFsMoveResult,
    KbGlobHit, KbHit, KbInjection, KbMedia, KbMediaInput, KbMemory, KbMemoryOverview, KbMemoryStats,
    KbQuery, KbMetaInput, KbSettings, KbSettingsInput, KbStatus, KbRootStat, KbTrashBatchResult, KbTrashEntry,
    KbTrashResult, MemoryApplyResult, MemoryCandidate, MemoryMaintainResult, MODE_KEYWORD,
    MODE_LOCAL,
};
use super::embed::Embedder;
use super::worker::{self, KbHub};
use super::{
    archive, assets, chunk, embed, embed_models, files, governance, index, injection, listing,
    memory, search, settings, usage,
};

/// 检索前的刷新预算。嵌入是毫秒级，正常一轮就够；超时也不阻塞工具调用。
const REFRESH_BUDGET: Duration = Duration::from_millis(1500);

/// 应用数据目录 = 模态本体的根（workspace/media 与语音 wav 都在它下面）。
/// 与 db::init 同源（认 REIN_DATA_DIR 开关），测试实例整袋隔离。
fn data_root(app: &AppHandle) -> Result<PathBuf> {
    crate::db::data_dir(app)
}

fn parse_tags(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

#[tauri::command]
pub fn kb_status(
    app: AppHandle,
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
) -> Result<KbStatus> {
    let conn = state.db.lock();
    let s = settings::get(&conn)?;
    let enabled = settings::enabled_sources(&conn)?;
    let (docs, chunks, vectors) = index::stats(&conn)?;
    let vec_model = index::active_vec_model(&conn)?;
    drop(conn);

    // keyword 模式天然就绪（不需要任何外部依赖）；本地模式还要求模型已下载；
    // 其余模式看是否已报错降级。
    let last_error = hub.last_error().or(s.last_error.clone());
    let embedder_ready = match s.embedding_mode.as_str() {
        MODE_KEYWORD => true,
        MODE_LOCAL => {
            let model = embed_models::find(&s.local_model)
                .unwrap_or_else(embed_models::default_model);
            embed_models::is_installed(&data_root(&app)?, model) && last_error.is_none()
        }
        _ => last_error.is_none(),
    };

    Ok(KbStatus {
        mode: s.embedding_mode.clone(),
        docs,
        chunks,
        vectors,
        pending: hub.pending(),
        indexing: hub.is_indexing(),
        progress: hub.progress(),
        last_error,
        embedder_ready,
        vec_model,
        enabled_sources: enabled,
    })
}

/// 混合检索：结构化过滤 + FTS5 + 向量召回 → RRF。
///
/// `async`：要等索引追赶、可能还要做一次查询嵌入（云端是网络往返），
/// 同步命令会把这些都压在主线程上。
#[tauri::command(async)]
pub fn kb_search(
    app: AppHandle,
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    query: KbQuery,
) -> Result<Vec<KbHit>> {
    if query.query.trim().is_empty() {
        // 空查询 = 浏览最近内容，而不是报错
        let conn = state.db.lock();
        let enabled = settings::enabled_sources(&conn)?;
        return search::browse(&conn, &query, &enabled);
    }

    // 先把积压的脏标记刷掉，保证 AI 看不到陈旧数据
    worker::drain_before_query(&app, REFRESH_BUDGET)?;

    // 读配置（持锁）
    let (enabled, cfg) = {
        let conn = state.db.lock();
        (
            settings::enabled_sources(&conn)?,
            embed::resolve_config(&conn)?,
        )
    };

    // 构建 embedder + 嵌入查询串（**不持锁**：首次构建要加载模型）
    let model_id = embed::model_id_of(&cfg);
    let query_vec: Option<Vec<f32>> = match (&cfg.mode[..], &model_id) {
        (MODE_KEYWORD, _) | (_, None) => None,
        _ => match hub.embedder(&cfg)? {
            Some(e) => {
                // 直接采用返回的实际维度，不与 e.dim() 比较：
                // 云端模型的维度常常未知（配置里没填 dim），以返回值为准才不会把云端模式
                // 误降级成关键词。维度混库的安全性由 vector_recall 保证（长度不符即跳过）。
                let v = e.embed(std::slice::from_ref(&query.query))?.into_iter().next();
                Some(v).flatten().filter(|x| !x.is_empty())
            }
            None => None,
        },
    };

    // 检索（持锁）
    let conn = state.db.lock();
    search::search(
        &conn,
        &query,
        &enabled,
        query_vec.as_deref(),
        model_id.as_deref(),
    )
}

/// 分层读取。`l1` 只给摘要 + 首块（概览），`l2` 给全部分块正文。
/// 默认 l1——AI 需要细节时应显式要 l2，避免工具结果撑爆上下文。
///
/// `async`（= 派到线程池）：阅读会装配 kb_chunks，note 还要整篇即时切块；同步命令
/// 会占住主线程。**不再等索引队列**：单条 doc 的读取只看它自己那一行，队列里排的是
/// 别的源的派生刷新 —— 等它们全部落地，只会把「打开一篇笔记」拖成 1.5 秒。写路径
/// 自己会 notify，索引线程随即追赶，不需要读路径阻塞等待。
#[tauri::command(async)]
pub fn kb_read(
    _app: AppHandle,
    state: State<AppState>,
    doc_id: i64,
    level: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<KbDocDetail> {
    let conn = state.db.lock();
    read_detail(
        &conn,
        doc_id,
        &level.unwrap_or_else(|| "l1".into()),
        offset,
        limit,
    )
}

/// kb_read 的核心。拆出来是为了能直接对内存库做单元测试。
pub fn read_detail(
    conn: &rusqlite::Connection,
    doc_id: i64,
    level: &str,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<KbDocDetail> {
    if level != "l1" && level != "l2" {
        return Err(ReinError::Message(format!(
            "level 只支持 l1 或 l2，收到：{level}"
        )));
    }

    let row = conn
        .query_row(
            "SELECT source_type, source_id, title, summary, occurred_on, tags, meta_json, updated_at,
                    path, editable, system, kind
             FROM kb_docs WHERE id = ?1",
            [doc_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, i64>(10)?,
                    r.get::<_, String>(11)?,
                ))
            },
        )
        .optional()?;
    let Some((
        source_type,
        source_id,
        title,
        summary,
        occurred_on,
        tags,
        meta_json,
        updated_at,
        path,
        editable,
        system,
        kind,
    )) = row
    else {
        return Err(ReinError::Message(format!(
            "知识库条目不存在：id={doc_id}（先用 search_knowledge 查 id）"
        )));
    };

    // note 源（笔记 / 上传文档全文归档）的真源在 kb_files，kb_docs.body 只是带
    // MAX_BODY 上限的检索缓存。阅读必须给全文：否则超过缓存上限的文档被截断后，
    // AI 按页读到头的也只是残篇，「继续读」无路可走。这里对 note 直读真源、
    // 按同一分块参数即时切块；其他源维持 kb_chunks（派生文档本就以缓存为准）。
    //
    // 返回 `(可见块, 真实总块数)`。l1 只需要首块，**不为一行摘要把整篇文档切一遍**：
    // 只切前 300 字；总块数走 `chunk::count_chunks`（同一套断点算法、只数不切），
    // l2 分页提示要的真实总数因此与 l2 实际块表严格一致。l2 才做完整切块。
    let full_chunks: Option<(Vec<String>, i64)> = if source_type == "note" {
        let content: Option<String> = source_id
            .parse::<i64>()
            .ok()
            .and_then(|fid| {
                conn.query_row("SELECT content FROM kb_files WHERE id = ?1", [fid], |r| {
                    r.get::<_, String>(0)
                })
                .optional()
                .ok()
                .flatten()
            });
        content.map(|content| {
            if level == "l1" {
                let cut = content
                    .char_indices()
                    .nth(chunk::DEFAULT_MAX_CHARS)
                    .map(|(i, _)| i)
                    .unwrap_or(content.len());
                let head = chunk::chunk_text(
                    &content[..cut],
                    chunk::DEFAULT_MAX_CHARS,
                    chunk::DEFAULT_OVERLAP,
                );
                // 总块数走「只数不切」的同一套断点算法：l2 分页提示要真实总数，
                // 但不能为了一个数字把整篇文档的块字符串都造出来。
                let total = chunk::count_chunks(
                    &content,
                    chunk::DEFAULT_MAX_CHARS,
                    chunk::DEFAULT_OVERLAP,
                ) as i64;
                (head, total)
            } else {
                let all = chunk::chunk_text(
                    &content,
                    chunk::DEFAULT_MAX_CHARS,
                    chunk::DEFAULT_OVERLAP,
                );
                let total = all.len() as i64;
                (all, total)
            }
        })
    } else {
        None
    };

    let (total_chunks, chunks) = match &full_chunks {
        Some((all, total)) => {
            let offset = if level == "l1" {
                0
            } else {
                offset.unwrap_or(0).max(0)
            };
            let limit = if level == "l1" {
                1
            } else {
                limit.unwrap_or(8).clamp(1, 64)
            };
            let start = (offset as usize).min(all.len());
            let end = (start + limit as usize).min(all.len());
            let chunks = all[start..end]
                .iter()
                .enumerate()
                .map(|(k, text)| KbChunk {
                    // 即时切块没有行 id，用块序当 id（对调用方只要求响应内唯一）
                    id: (start + k) as i64,
                    ord: (start + k) as i64,
                    text: text.clone(),
                })
                .collect();
            (*total, chunks)
        }
        None => {
            let total: i64 = conn.query_row(
                "SELECT COUNT(*) FROM kb_chunks WHERE doc_id = ?1",
                [doc_id],
                |r| r.get(0),
            )?;
            // l1 固定给首块（概览）；l2 按 offset/limit 分页（docs/kb-vfs.md §3）。
            // l2 默认 8 块 ≈ 2400 字，模型逐页读比一次性倾倒 64 块更可控。
            let offset = if level == "l1" {
                0
            } else {
                offset.unwrap_or(0).max(0)
            };
            let limit = if level == "l1" {
                1
            } else {
                limit.unwrap_or(8).clamp(1, 64)
            };
            let mut stmt = conn.prepare(
                "SELECT id, ord, text FROM kb_chunks WHERE doc_id = ?1 ORDER BY ord LIMIT ?2 OFFSET ?3",
            )?;
            let chunks: Vec<KbChunk> = stmt
                .query_map(rusqlite::params![doc_id, limit, offset], |r| {
                    Ok(KbChunk {
                        id: r.get(0)?,
                        ord: r.get(1)?,
                        text: r.get(2)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            (total, chunks)
        }
    };

    let returned = chunks.len() as i64;
    let offset = if level == "l1" {
        0
    } else {
        offset.unwrap_or(0).max(0)
    };
    // 模态清单：文本恒有（有正文/块）；音频/视频/图片等本体见 assets（§2.2）。
    // l1 的 note 只切了首块，不能拿它算全文长度 —— 有块就算「有文本」。
    let text_chars = if level == "l1" {
        i64::from(total_chunks > 0)
    } else {
        match &full_chunks {
            Some((all, _)) => all.iter().map(|s| s.chars().count()).sum::<usize>() as i64,
            None => i64::from(total_chunks > 0),
        }
    };
    let modalities: Vec<String> =
        assets::modals_for_source(conn, None, &source_type, &source_id, text_chars)?
            .into_iter()
            .map(|m| m.modal)
            .collect();
    Ok(KbDocDetail {
        id: doc_id,
        source_type,
        source_id,
        path,
        editable: editable != 0,
        system: system != 0,
        kind,
        title,
        summary,
        occurred_on,
        tags: parse_tags(&tags),
        meta: serde_json::from_str(&meta_json).unwrap_or(serde_json::Value::Null),
        updated_at,
        level: level.to_string(),
        total_chunks,
        offset,
        has_more: offset + returned < total_chunks,
        chunks,
        modalities,
    })
}

/// 全量对账：把现有源记录重新入队，并清掉孤儿文档。
/// 返回入队条数。老库升级后、或怀疑索引不一致时用。
#[tauri::command]
pub fn kb_reindex(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    sources: Option<Vec<String>>,
) -> Result<i64> {
    let n = {
        let conn = state.db.lock();
        let enabled = match sources.filter(|s| !s.is_empty()) {
            Some(s) => s,
            None => settings::enabled_sources(&conn)?,
        };
        index::scan_all(&conn, &enabled)?
    };
    hub.notify();
    Ok(n)
}

#[tauri::command]
pub fn kb_settings_get(state: State<AppState>) -> Result<KbSettings> {
    let conn = state.db.lock();
    settings::get(&conn)
}

/// 改设置。**嵌入身份（模式 / 本地模型 / 云端模型）变了就清空向量**，
/// 让下一轮索引按新模型重算。
#[tauri::command]
pub fn kb_settings_set(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    input: KbSettingsInput,
) -> Result<KbSettings> {
    let out = {
        let conn = state.db.lock();
        let before = embed::identity(&embed::resolve_config(&conn)?);
        let after_settings = settings::update(&conn, &input)?;
        let after = embed::identity(&embed::resolve_config(&conn)?);
        if before != after {
            // 换模型＝换向量空间：留着会让旧模型的向量被当成新模型的复用，检索结果静默错乱。
            // 清空后 chunks_needing_vectors 自然会把所有块重新入列，无需额外标记。
            index::clear_vectors(&conn, None)?;
        }
        after_settings
    };

    // 身份变了要丢掉缓存的 embedder，让下次用新配置重建
    hub.release_embedder();
    hub.notify();
    Ok(out)
}

/// 嵌入后端自检：嵌一句话并校验维度。UI 的「测试连接」按钮用它。
#[tauri::command]
pub fn kb_probe_embedder(state: State<AppState>, hub: State<'_, Arc<KbHub>>) -> Result<usize> {
    let cfg = {
        let conn = state.db.lock();
        embed::resolve_config(&conn)?
    };
    if cfg.mode == MODE_KEYWORD {
        return Err(ReinError::Message(
            "当前是纯关键词模式，没有可测试的嵌入后端".into(),
        ));
    }
    let e = hub
        .embedder(&cfg)?
        .ok_or_else(|| ReinError::Message("嵌入后端不可用（检查配置或模型是否就绪）".into()))?;
    e.probe()
}

/// 清空全部向量，触发按当前模型重算（切换模型或修复索引用）。
#[tauri::command]
pub fn kb_rebuild_vectors(state: State<AppState>, hub: State<'_, Arc<KbHub>>) -> Result<usize> {
    let cleared = {
        let conn = state.db.lock();
        index::clear_vectors(&conn, None)?
    };
    hub.release_embedder();
    hub.notify();
    Ok(cleared)
}

/* ---------- 本地嵌入模型（可选 / 可下载） ---------- */

/// 可选的本地嵌入模型目录 + 安装状态。
#[tauri::command]
pub fn kb_embed_models(app: AppHandle, state: State<AppState>) -> Result<embed_models::EmbedCatalog> {
    let root = data_root(&app)?;
    let conn = state.db.lock();
    let s = settings::get(&conn)?;
    Ok(embed_models::catalog(&root, &s.local_model, &s.embedding_mode))
}

/// 下载一个本地模型（两个文件；进度走 `kb://model` 事件）。已安装则直接返回。
#[tauri::command]
pub async fn kb_embed_model_download(
    app: AppHandle,
    hub: State<'_, Arc<KbHub>>,
    state: State<'_, AppState>,
    model_id: String,
) -> Result<embed_models::EmbedModelInfo> {
    const MODEL_EVENT: &str = "kb://model";
    let model = embed_models::find(&model_id)
        .ok_or_else(|| ReinError::Message(format!("未知的本地模型：{model_id}")))?;
    let root = data_root(&app)?;

    // 已经装好就直接回状态（重复点按钮不该重新下一遍）
    if embed_models::is_installed(&root, model) {
        let conn = state.db.lock();
        let s = settings::get(&conn)?;
        let cat = embed_models::catalog(&root, &s.local_model, &s.embedding_mode);
        return Ok(cat
            .models
            .into_iter()
            .find(|m| m.id == model_id)
            .expect("注册表里的模型必然在目录里"));
    }

    // 下载是长阻塞 IO：放阻塞线程池，期间照常发进度事件
    let app_ev = app.clone();
    let id_ev = model_id.clone();
    let root_dl = root.clone();
    let out = tokio::task::spawn_blocking(move || {
        let _ = app_ev.emit(
            MODEL_EVENT,
            serde_json::json!({ "id": id_ev, "file": "", "done": 0, "total": 0, "phase": "start" }),
        );
        let res = embed_models::download(&root_dl, model, &mut |file, done, total| {
            // 节流在 embed_models::download_file 里做的（1% 粒度）；这里只负责转发。
            let _ = app_ev.emit(
                MODEL_EVENT,
                serde_json::json!({
                    "id": id_ev, "file": file, "done": done, "total": total, "phase": "downloading"
                }),
            );
        });
        (res, model, root_dl)
    })
    .await
    .map_err(|e| ReinError::Message(format!("下载任务异常终止：{e}")))?;

    let (res, model, root) = out;
    match res {
        Ok(_) => {
            // 装完就自检一次：加载 + 真跑一段中文，跑不通就回滚，
            // 不让一个坏模型留在磁盘上等着在检索时炸。
            let probe = match embed::LocalEmbedder::new(&root, model) {
                Ok(e) => e.probe().map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            };
            match probe {
                Ok(dim) => {
                    let conn = state.db.lock();
                    let s = settings::get(&conn)?;
                    let cat = embed_models::catalog(&root, &s.local_model, &s.embedding_mode);
                    hub.notify();
                    let _ = app.emit(
                        MODEL_EVENT,
                        serde_json::json!({ "id": model_id, "file": "", "done": dim, "total": dim, "phase": "done" }),
                    );
                    Ok(cat
                        .models
                        .into_iter()
                        .find(|m| m.id == model_id)
                        .expect("注册表里的模型必然在目录里"))
                }
                Err(e) => {
                    let _ = embed_models::remove(&root, model);
                    let _ = app.emit(
                        MODEL_EVENT,
                        serde_json::json!({ "id": model_id, "phase": "error", "message": e.to_string() }),
                    );
                    Err(ReinError::Message(format!(
                        "模型装好了但自检失败，已回滚：{e}"
                    )))
                }
            }
        }
        Err(e) => {
            let _ = app.emit(
                MODEL_EVENT,
                serde_json::json!({ "id": model_id, "phase": "error", "message": e.to_string() }),
            );
            Err(e)
        }
    }
}

/// 取消一个进行中的下载（下载循环在分块之间检查）。
#[tauri::command]
pub fn kb_embed_model_cancel(model_id: String) -> Result<()> {
    embed_models::request_cancel(&model_id);
    Ok(())
}

/// 删除一个已下载的本地模型（释放磁盘）。当前正在用的模型拒绝删除。
#[tauri::command]
pub fn kb_embed_model_remove(
    app: AppHandle,
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    model_id: String,
) -> Result<i64> {
    let model = embed_models::find(&model_id)
        .ok_or_else(|| ReinError::Message(format!("未知的本地模型：{model_id}")))?;
    let root = data_root(&app)?;
    let freed = {
        let conn = state.db.lock();
        let s = settings::get(&conn)?;
        if s.embedding_mode == MODE_LOCAL && s.local_model == model_id {
            return Err(ReinError::Message(
                "该模型正在使用中：先把检索模式换成别的模型（或纯关键词），再回来删除".into(),
            ));
        }
        embed_models::remove(&root, model)?
    };
    hub.notify();
    Ok(freed as i64)
}

/// 自定义嵌入测试：拿自己的文本看维度、延迟与相似度排序。
/// 可临时指定本地模型或云端端点（先测后存），不落库。
///
/// `async`（= 派到线程池）：要加载 ONNX 模型并真跑推理，几百毫秒起——
/// 同步命令在主线程执行，会把界面一起冻住。
#[tauri::command(async)]
pub fn kb_embed_test(
    app: AppHandle,
    state: State<AppState>,
    input: embed::EmbedTestInput,
) -> Result<embed::EmbedTestResult> {
    let root = data_root(&app)?;
    let cfg = {
        let conn = state.db.lock();
        embed::resolve_config(&conn)?
    };
    embed::test(&cfg, &root, &input)
}

/* ---------- 压缩包 ---------- */

/// 取一个「压缩包」文件节点的原始字节（上传的文件 / 之前解压出来的包）。
///
/// 只认 note 来源的多模态节点；其它来源（日程附件、语音本体）给可读的理由，
/// 而不是一个含糊的「读不到」。
fn archive_source(conn: &rusqlite::Connection, root: &Path, doc_id: i64) -> Result<(Vec<u8>, String)> {
    let row: Option<(String, String, String, String, String)> = conn
        .query_row(
            "SELECT source_type, source_id, path, title, kind FROM kb_docs WHERE id = ?1",
            [doc_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let Some((source_type, source_id, path, title, _kind)) = row else {
        return Err(ReinError::Message(format!(
            "知识库条目不存在：id={doc_id}（先用 glob_knowledge 查 id）"
        )));
    };
    if source_type != "note" {
        return Err(ReinError::Message(format!(
            "「{title}」来自 {source_type} 源（不是工作区文件），不能当压缩包打开。\
             先把压缩包上传到文件管理器，再用它的 id 调本工具。"
        )));
    }
    let file_id: i64 = source_id
        .parse()
        .map_err(|_| ReinError::Message("该条目的文件 id 不合法".into()))?;
    // 本体：优先 binary（zip 等），其次 image/audio/video（用户可能改了扩展名）
    let asset: Option<(String, String, String)> = conn
        .query_row(
            "SELECT modal, storage, ref FROM kb_assets \
             WHERE file_id = ?1 AND modal != 'text' ORDER BY (modal = 'binary') DESC, id LIMIT 1",
            [file_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((modal, storage, ref_)) = asset else {
        return Err(ReinError::Message(format!(
            "「{path}」没有可读的本体（只有文本模态），不是压缩包"
        )));
    };
    let bytes = if storage == "fs" {
        std::fs::read(root.join(&ref_)).map_err(|e| {
            ReinError::Message(format!("读取本体失败（{modal}）：{e}（文件可能已被移动）"))
        })?
    } else {
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            ref_.trim(),
        )
        .map_err(|e| ReinError::Message(format!("本体不是合法 base64：{e}")))?
    };
    Ok((bytes, path))
}

/// 打开一个压缩包：列出内容（不解压）。
///
/// `async`：要读整个包并解析（tar.gz 还得整包解压一次），不能占主线程。
#[tauri::command(async)]
pub fn kb_archive_list(app: AppHandle, state: State<AppState>, doc_id: i64) -> Result<archive::KbArchiveListing> {
    let root = data_root(&app)?;
    let conn = state.db.lock();
    let (bytes, path) = archive_source(&conn, &root, doc_id)?;
    let name = path.rsplit('/').next().unwrap_or("压缩包").to_string();
    archive::list(&bytes, &name)
}

/// 解压一个压缩包进工作区（文本进检索，二进制落本体）。
///
/// `async`：几百个文件落盘 + 落库，重活；在主线程跑会冻住界面。
#[tauri::command(async)]
pub fn kb_archive_extract(
    app: AppHandle,
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    doc_id: i64,
    to_dir: Option<String>,
    only: Option<Vec<String>>,
) -> Result<archive::KbArchiveReport> {
    let root = data_root(&app)?;
    let report = {
        let conn = state.db.lock();
        let (bytes, path) = archive_source(&conn, &root, doc_id)?;
        let name = path.rsplit('/').next().unwrap_or("压缩包").to_string();
        archive::extract(
            &conn,
            &root,
            &bytes,
            &name,
            &archive::ExtractOptions {
                to_dir,
                only: only.unwrap_or_default(),
            },
        )?
    };
    // 解压出来的文本要尽快可检索
    hub.notify();
    Ok(report)
}

/* ---------- 空间管理 ---------- */

/// 工作区占用总览（含大文件榜与孤儿统计）。`min_bytes` 只影响大文件榜的下限。
///
/// `async`：全表聚合 + 目录遍历 + 逐本体 stat，属于重读；主线程执行会卡界面。
#[tauri::command(async)]
pub fn kb_usage(
    app: AppHandle,
    state: State<AppState>,
    top: Option<i64>,
    min_bytes: Option<i64>,
) -> Result<usage::KbUsageReport> {
    let root = data_root(&app)?;
    let conn = state.db.lock();
    usage::report(
        &conn,
        &root,
        top.unwrap_or(usage::TOP_DEFAULT).clamp(0, usage::TOP_MAX),
        min_bytes.unwrap_or(0).max(0),
    )
}

/// 清理磁盘上无人引用的本体碎片（`dry_run=true` 只统计）。
///
/// `async`：要遍历媒体目录并逐个删文件。
#[tauri::command(async)]
pub fn kb_usage_clean(
    app: AppHandle,
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    dry_run: Option<bool>,
) -> Result<usage::KbUsageCleanResult> {
    let root = data_root(&app)?;
    let out = {
        let conn = state.db.lock();
        usage::clean_orphans(&conn, &root, dry_run.unwrap_or(false))?
    };
    hub.notify();
    Ok(out)
}

/* ---------- 记忆层 ---------- */

/// 记忆列表。`scope`: active（默认，仅活跃）/ archived（仅归档）/ all（两者）。
///
/// `async`：全量行解析 + salience 计算；虽然当前量级很小，但它是「关于你」首屏的
/// 同步路径之一，不能和索引线程抢主线程。
#[tauri::command(async)]
pub fn kb_memories(
    state: State<AppState>,
    mem_type: Option<String>,
    scope: Option<String>,
) -> Result<Vec<KbMemory>> {
    let conn = state.db.lock();
    memory::list(
        &conn,
        mem_type.as_deref(),
        memory::parse_scope(scope.as_deref()),
    )
}

/// 「关于你」首屏的一次性聚合：活跃记忆 + 概况 + 注入块。
///
/// 从前前端并发发 `kb_memories` / `kb_memory_stats` / `kb_cognition` 三条命令，
/// 三条各自把**同一份活跃记忆全表**读一遍、各算一遍 salience（stats 还要再拼一次
/// 注入文本）。小库看不出，记忆一多就是三倍的钱；而且三条同步命令排队抢同一把
/// DB 锁。这里一次取数、一次算完，页面只发一条。
#[tauri::command(async)]
pub fn kb_memory_overview(state: State<AppState>) -> Result<KbMemoryOverview> {
    let conn = state.db.lock();
    memory::overview(&conn)
}

/// 落库一次记忆抽取的结果。前端（pi-ai）负责调模型产出 candidates。
#[tauri::command]
pub fn kb_memory_apply(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    candidates: Vec<MemoryCandidate>,
    chat_id: Option<String>,
    message_ids: Option<Vec<String>>,
) -> Result<MemoryApplyResult> {
    let ids = message_ids.unwrap_or_default();
    let out = {
        let conn = state.db.lock();
        memory::apply(&conn, &candidates, chat_id.as_deref(), &ids)?
    };
    // 新记忆要尽快可检索，也要尽快进入 prompt 注入块
    hub.notify();
    Ok(out)
}

#[tauri::command]
pub fn kb_memory_delete(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
) -> Result<bool> {
    let ok = {
        let conn = state.db.lock();
        memory::delete(&conn, id)?
    };
    hub.notify();
    Ok(ok)
}

/// 归档一条记忆（软删除，可恢复）。UI 的手动整理与后续自动化都用它。
#[tauri::command]
pub fn kb_memory_archive(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
    reason: Option<String>,
) -> Result<bool> {
    let ok = {
        let conn = state.db.lock();
        memory::archive(&conn, id, reason.as_deref().unwrap_or(""))
    };
    hub.notify();
    ok
}

/// 恢复一条已归档记忆。
#[tauri::command]
pub fn kb_memory_restore(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
) -> Result<bool> {
    let ok = {
        let conn = state.db.lock();
        memory::restore(&conn, id)?
    };
    hub.notify();
    Ok(ok)
}

/// 立即跑一次本地维护（衰减 + 自动归档）。后台线程也会定期跑。
#[tauri::command]
pub fn kb_memory_maintain(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
) -> Result<MemoryMaintainResult> {
    let out = {
        let conn = state.db.lock();
        memory::maintain(&conn)?
    };
    hub.notify();
    Ok(out)
}

/// 记忆库信噪比概况（注入覆盖率 / 噪声占比 / 归档数 / 上次整理时间）。
#[tauri::command(async)]
pub fn kb_memory_stats(state: State<AppState>) -> Result<KbMemoryStats> {
    let conn = state.db.lock();
    memory::stats(&conn)
}

/// 上报「刚完成一次 LLM 整理」，用于周期任务的节流（每天最多一次）。
#[tauri::command]
pub fn kb_memory_consolidated(state: State<AppState>) -> Result<()> {
    let conn = state.db.lock();
    memory::mark_consolidated(&conn)
}

/// 喂给系统提示词的紧凑认知块。前端在每轮请求前取一次（带短 TTL 缓存）。
#[tauri::command(async)]
pub fn kb_cognition(state: State<AppState>) -> Result<KbCognition> {
    let conn = state.db.lock();
    memory::cognition(&conn, None)
}

/// 上报「这些记忆被注入了」——注入即用到，用于后续排序。
#[tauri::command]
pub fn kb_memory_bump(state: State<AppState>, ids: Vec<i64>) -> Result<()> {
    let conn = state.db.lock();
    memory::bump_active(&conn, &ids)
}

/// 疑似重复的记忆对（用已落库的向量算余弦，本地零模型成本）。
/// 整理器把它当「重点怀疑对象」喂给模型；keyword 模式（无向量）返回空表。
#[tauri::command]
pub fn kb_memory_duplicates(
    state: State<AppState>,
    threshold: Option<f64>,
    limit: Option<i64>,
) -> Result<Vec<memory::MemoryDuplicate>> {
    let conn = state.db.lock();
    let cfg = embed::resolve_config(&conn)?;
    let model_id = embed::model_id_of(&cfg);
    memory::duplicate_pairs(
        &conn,
        model_id.as_deref(),
        threshold.unwrap_or(memory::DUP_THRESHOLD_DEFAULT).clamp(0.5, 0.99),
        limit.unwrap_or(30),
    )
}

/// 最近的记忆变更记录（抽取 / 整理 / 维护都写在同一张审计表）。
#[tauri::command]
pub fn kb_memory_diffs(state: State<AppState>, limit: Option<i64>) -> Result<Vec<memory::MemoryDiffEntry>> {
    let conn = state.db.lock();
    memory::recent_diffs(&conn, limit.unwrap_or(5))
}

/* ---------- 虚拟文件系统（glob / 真实文件） ---------- */

/// 按路径模式列文档： 不跨目录、 跨目录、 单字符。
///  列笔记、 列全部对话内容、 列全部附件编目。
///
/// `async`：glob 走 FTS/路径扫描，且要等索引队列（AI 检索需要新鲜结果），
/// 最长 1.5 秒的等待绝不能落在主线程上。
#[tauri::command(async)]
pub fn kb_glob(
    app: AppHandle,
    state: State<AppState>,
    pattern: String,
    limit: Option<i64>,
) -> Result<Vec<KbGlobHit>> {
    worker::drain_before_query(&app, REFRESH_BUDGET)?;
    let conn = state.db.lock();
    search::glob(&conn, &pattern, limit.unwrap_or(100))
}

/// 新建或覆盖一个笔记（内容真源在 kb_files，随后自动进检索编目）。
#[tauri::command]
pub fn kb_file_write(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    input: KbFileInput,
) -> Result<KbFile> {
    let id = {
        let conn = state.db.lock();
        files::write(&conn, &input.path, &input.content)?
    };
    hub.notify();
    let conn = state.db.lock();
    files::get(&conn, id)
}

/// 笔记改名 / 移动（系统文件拒绝）。
#[tauri::command]
pub fn kb_file_rename(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
    path: String,
) -> Result<KbFile> {
    {
        let conn = state.db.lock();
        files::rename(&conn, id, &path)?;
    }
    hub.notify();
    let conn = state.db.lock();
    files::get(&conn, id)
}

/// 删除文件节点（系统文件拒绝）。本体文件一并从磁盘清掉。
#[tauri::command]
pub fn kb_file_delete(
    app: AppHandle,
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
) -> Result<()> {
    let refs = {
        let conn = state.db.lock();
        files::delete(&conn, id)?
    };
    if let Ok(root) = data_root(&app) {
        for rel in refs {
            let _ = std::fs::remove_file(root.join(rel));
        }
    }
    hub.notify();
    Ok(())
}

/// 取文件原文（编辑器用）。kb_read 走分块管线会丢原始换行，编辑必须拿原文。
#[tauri::command]
pub fn kb_file_get(state: State<AppState>, id: i64) -> Result<KbFile> {
    let conn = state.db.lock();
    files::get(&conn, id)
}

/// 改用户元数据：评分 / 标签 / 注释（只传要改的字段）。返回更新后的节点。
#[tauri::command]
pub fn kb_meta_set(state: State<AppState>, input: KbMetaInput) -> Result<KbFile> {
    let conn = state.db.lock();
    let fid = files::set_meta(&conn, input.id, input.rating, input.tags, input.note)?;
    files::get(&conn, fid)
}

/* ---------- 目录列举与回收站（文件管理器，见 listing.rs / files.rs） ---------- */

/// 列一层目录：文件管理器的 `ls`。一次带回大小、时间、模态、钉住、归类与子项数。
///
/// `async`（= 派到线程池）：列举要扫前缀范围，大目录可以到上万行，不能占主线程。
///
/// **不等索引队列**：列举直接读 `kb_docs` / `kb_files`，跟脏队列是两回事。从前这里
/// 等 `drain_before_query`（最长 1.5 秒），启动对账一次性入队上千条时，每次进目录都
/// 白卡一轮；而真正要保证的「刚写的文件立即可见」由 `kb_files` 直写 + 写路径 notify
/// 已经保证，不靠阻塞列举。
#[tauri::command(async)]
pub fn kb_list_dir(state: State<AppState>, path: String) -> Result<KbDirListing> {
    let conn = state.db.lock();
    listing::list_dir(&conn, &path)
}

/// 根层统计：顶层目录的直接子项数 + 节点更新时间（关于你首屏用）。
///
/// 与 `kb_list_dir("")` 的区别只在**返回什么**：这里不实例化条目、不查 assets、
/// 不做 Rust 侧归并，数字在 SQLite 里 `GROUP BY` 完直接回几十行。
#[tauri::command(async)]
pub fn kb_root_stats(state: State<AppState>) -> Result<Vec<KbRootStat>> {
    let conn = state.db.lock();
    listing::root_stats(&conn)
}

/// 删除 = 移进回收站（系统文件拒绝；目录连整棵子树一起走）。可撤销：kb_trash_restore。
///
/// `async`（= 派到线程池）：目录删除要逐行 UPDATE + 删派生文档，行数可以上千，
/// 同步命令会在主线程上一直握着 DB 锁（同 kb_list_dir 的理由）。
#[tauri::command(async)]
pub fn kb_trash(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
) -> Result<KbTrashResult> {
    let out = {
        let conn = state.db.lock();
        files::trash(&conn, id)?
    };
    hub.notify();
    Ok(KbTrashResult {
        file_id: out.file_id,
        count: out.count,
        path: out.path,
    })
}

/// 回收站清单（最近删除的在前）。
#[tauri::command]
pub fn kb_trash_list(state: State<AppState>, limit: Option<i64>) -> Result<Vec<KbTrashEntry>> {
    let conn = state.db.lock();
    files::trash_list(&conn, limit.unwrap_or(200))
}

/// 从回收站恢复（批量）。逐条报告失败原因，不整体失败。
///
/// `async`：每行都要让位判断（名字被占时最多几十次占用查询），批量恢复是重活。
#[tauri::command(async)]
pub fn kb_trash_restore(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    ids: Vec<i64>,
) -> Result<KbTrashBatchResult> {
    let out = {
        let conn = state.db.lock();
        batch(&conn, &ids, files::untrash)
    };
    hub.notify();
    Ok(out)
}

/// 彻底删除（批量，回收站里的和还活着的都能删）。本体文件一并从磁盘清掉。
///
/// `async`：删完还要在磁盘上清理本体文件，批量时是主线程杀手。
#[tauri::command(async)]
pub fn kb_trash_purge(
    app: AppHandle,
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    ids: Vec<i64>,
) -> Result<KbTrashBatchResult> {
    let (out, refs) = {
        let conn = state.db.lock();
        let mut refs = Vec::new();
        let mut done = 0;
        let mut freed = 0;
        let mut failed = Vec::new();
        for id in &ids {
            match files::purge(&conn, *id) {
                Ok((n, r, bytes)) => {
                    freed += bytes;
                    refs.extend(r);
                    done += n;
                }
                Err(e) => failed.push(e.to_string()),
            }
        }
        (
            KbTrashBatchResult {
                done,
                freed_bytes: freed,
                failed,
            },
            refs,
        )
    };
    remove_bodies(&app, &refs);
    hub.notify();
    Ok(out)
}

/// 清空回收站。
///
/// `async`：整站清空 = 逐行删 + 磁盘清理，与 kb_trash_purge 同一条重路径。
#[tauri::command(async)]
pub fn kb_trash_empty(
    app: AppHandle,
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
) -> Result<KbTrashBatchResult> {
    let (done, refs, freed, failed) = {
        let conn = state.db.lock();
        files::empty_trash(&conn)?
    };
    remove_bodies(&app, &refs);
    hub.notify();
    Ok(KbTrashBatchResult {
        done,
        freed_bytes: freed,
        failed,
    })
}

/// 逐条执行、逐条报告（批量删除/恢复不该被一条失败拖垮）。
fn batch(
    conn: &rusqlite::Connection,
    ids: &[i64],
    f: impl Fn(&rusqlite::Connection, i64) -> Result<files::TrashOutcome>,
) -> KbTrashBatchResult {
    let mut done = 0;
    let mut failed = Vec::new();
    for id in ids {
        match f(conn, *id) {
            Ok(o) => done += o.count,
            Err(e) => failed.push(e.to_string()),
        }
    }
    KbTrashBatchResult {
        done,
        freed_bytes: 0,
        failed,
    }
}

/// 删掉磁盘上的本体文件（数据库行已清）。
fn remove_bodies(app: &AppHandle, refs: &[String]) {
    if refs.is_empty() {
        return;
    }
    if let Ok(root) = data_root(app) {
        for rel in refs {
            let _ = std::fs::remove_file(root.join(rel));
        }
    }
}

/* ---------- 模态层（docs/ai-workspace.md §2） ---------- */

/// 上传/产出一个多模态节点：本体落盘 + 文本模态入索引。
#[tauri::command]
pub fn kb_media_write(
    app: AppHandle,
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    input: KbMediaInput,
) -> Result<KbFile> {
    let root = data_root(&app)?;
    let id = {
        let conn = state.db.lock();
        assets::write_media(&conn, &root, &input)?
    };
    hub.notify();
    let conn = state.db.lock();
    files::get(&conn, id)
}

/// 读一次模态：给了 `modal` 就取本体（不可用则降级为文本并说明原因），不给只回清单。
#[tauri::command]
pub fn kb_media_get(
    app: AppHandle,
    state: State<AppState>,
    doc_id: i64,
    modal: Option<String>,
) -> Result<KbMedia> {
    let root = data_root(&app)?;
    let conn = state.db.lock();
    assets::read(&conn, &root, doc_id, modal.as_deref())
}

/* ---------- 目录治理（§3.3） ---------- */

/// 把文件移进目标目录（分类）。`source` ∈ ai | user；AI 移动有防抖与 pin 保护。
#[tauri::command]
pub fn kb_fs_move(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
    to_dir: String,
    reason: Option<String>,
    source: Option<String>,
) -> Result<KbFsMoveResult> {
    let src = source.unwrap_or_else(|| "user".into());
    let (out, file) = {
        let conn = state.db.lock();
        let out = governance::move_to(&conn, id, &to_dir, reason.as_deref().unwrap_or(""), &src)?;
        let fid = conn
            .query_row("SELECT id FROM kb_files WHERE path = ?1", [&out.to], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap_or(id);
        let file = files::get(&conn, fid)?;
        (out, file)
    };
    hub.notify();
    Ok(KbFsMoveResult {
        file,
        from: out.from,
        to: out.to,
        batch_id: out.batch_id,
    })
}

/// 建目录（空目录也会在文件树里可见）。
#[tauri::command]
pub fn kb_fs_mkdir(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    path: String,
    reason: Option<String>,
    source: Option<String>,
) -> Result<KbFile> {
    let src = source.unwrap_or_else(|| "user".into());
    let p = {
        let conn = state.db.lock();
        governance::mkdir(&conn, &path, reason.as_deref().unwrap_or(""), &src)?
    };
    hub.notify();
    let conn = state.db.lock();
    files::get(&conn, resolve_path(&conn, &p)?)
}

/// 钉住 / 取消钉住。钉住后 AI 的自动整理不会移动它。
#[tauri::command]
pub fn kb_fs_pin(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    id: i64,
    pinned: bool,
    source: Option<String>,
) -> Result<KbFile> {
    let src = source.unwrap_or_else(|| "user".into());
    let fid = {
        let conn = state.db.lock();
        let path = governance::pin(&conn, id, pinned, &src)?;
        resolve_path(&conn, &path)?
    };
    hub.notify();
    let conn = state.db.lock();
    files::get(&conn, fid)
}

fn resolve_path(conn: &rusqlite::Connection, path: &str) -> Result<i64> {
    conn.query_row("SELECT id FROM kb_files WHERE path = ?1", [path], |r| {
        r.get(0)
    })
    .optional()?
    .ok_or_else(|| ReinError::Message(format!("文件不存在：{path}")))
}

/// 整理审计流水（最近的在前）。
#[tauri::command]
pub fn kb_fs_moves(state: State<AppState>, limit: Option<i64>) -> Result<Vec<KbFsMove>> {
    let conn = state.db.lock();
    governance::moves(&conn, limit.unwrap_or(50))
}

/// 整批撤销一批整理（按审计里的 batchId）。返回撤销条数。
#[tauri::command]
pub fn kb_fs_undo(
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    batch_id: String,
) -> Result<i64> {
    let n = {
        let conn = state.db.lock();
        governance::undo(&conn, &batch_id)?
    };
    hub.notify();
    Ok(n)
}

/* ---------- 与系统文件系统换手：拖入导入 / 导出到本地 ---------- */

/// 导入一个磁盘上的本地文件（从系统文件管理器拖进来的路径）。
///
/// `async`：要读整个文件（上限 64MB，与前端上传同一条线），不能占主线程。
/// 判 mime 只看扩展名（`assets::mime_of_name`）——拖进来的东西没有 mime 头可看。
#[tauri::command(async)]
pub fn kb_import_path(
    app: AppHandle,
    state: State<AppState>,
    hub: State<'_, Arc<KbHub>>,
    path: String,
    dir: Option<String>,
    name: Option<String>,
) -> Result<KbFile> {
    use base64::Engine as _;
    let root = data_root(&app)?;
    let src = PathBuf::from(&path);
    let meta = std::fs::metadata(&src)
        .map_err(|e| ReinError::Message(format!("读不到这个文件：{path}（{e}）")))?;
    if meta.len() > assets::UPLOAD_CAP as u64 {
        return Err(ReinError::Message(format!(
            "文件超过 {}MB，暂不支持导入工作区",
            assets::UPLOAD_CAP / 1024 / 1024
        )));
    }
    let bytes = std::fs::read(&src)
        .map_err(|e| ReinError::Message(format!("读不到这个文件：{path}（{e}）")))?;
    let base = name
        .filter(|n| !n.trim().is_empty())
        .or_else(|| src.file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| "拖入的文件".to_string());
    let mime = assets::mime_of_name(&base);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let target = match dir.map(|d| d.trim().trim_matches('/').to_string()) {
        Some(d) if !d.is_empty() => format!("{d}/{base}"),
        _ => base.clone(),
    };
    let id = {
        let conn = state.db.lock();
        assets::write_media(
            &conn,
            &root,
            &KbMediaInput {
                path: target,
                name: Some(base),
                mime,
                data_base64: format!("data:;base64,{b64}"),
                text: None,
            },
        )?
    };
    hub.notify();
    let conn = state.db.lock();
    files::get(&conn, id)
}

/// 导出到本地：文本写成文件、多模态拷贝本体，落在「下载/Rein」下，返回绝对路径。
///
/// 这是「拖出到系统」在各端都成立的替代动作（WebView 的拖出只在部分平台可用），
/// 也是 binary 预览里那个「导出」按钮的真身。
#[tauri::command(async)]
pub fn kb_export_file(app: AppHandle, state: State<AppState>, id: i64) -> Result<String> {
    let root = data_root(&app)?;
    let out_dir = app
        .path()
        .download_dir()
        .map_err(|e| ReinError::Message(format!("拿不到下载目录：{e}")))?
        .join("Rein");
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| ReinError::Message(format!("建不了导出目录：{e}")))?;

    let (name, content, refs) = {
        let conn = state.db.lock();
        let fid = files::resolve_file_id(&conn, id)?;
        let f = files::get(&conn, fid)?;
        let name = f.path.rsplit('/').next().unwrap_or("导出文件").to_string();
        (name, f.content, assets::fs_refs(&conn, fid)?)
    };

    // 有多模态本体就优先导本体（那才是「原文件」）；否则把正文写成文本文件。
    // 目标重名按 -v2/-v3 让位：第二次导出同一个文件不该覆盖用户已经改过的那一份。
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.clone(), String::new()),
    };
    let mut dest = out_dir.join(&name);
    let mut i = 1;
    while dest.exists() && i < 64 {
        i += 1;
        dest = out_dir.join(format!("{stem}-v{i}{ext}"));
    }
    match refs.first() {
        Some(rel) => {
            let src = root.join(rel);
            std::fs::copy(&src, &dest).map_err(|e| ReinError::Message(format!("写出失败：{e}")))?;
        }
        None => {
            std::fs::write(&dest, content.as_bytes())
                .map_err(|e| ReinError::Message(format!("写出失败：{e}")))?;
        }
    }
    Ok(dest.to_string_lossy().to_string())
}

/* ---------- 全量注入区（§3.4） ---------- */

/// 取「系统提示词 + 用户记忆」注入块。前端每轮对话前取一次（带 mtime 缓存）。
#[tauri::command]
pub fn kb_injection_get(state: State<AppState>) -> Result<KbInjection> {
    let conn = state.db.lock();
    injection::build(&conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn note_doc_id(conn: &rusqlite::Connection, file_id: i64) -> i64 {
        conn.query_row(
            "SELECT id FROM kb_docs WHERE source_type = 'note' AND source_id = ?1",
            [file_id.to_string()],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// 核心回归：超过 MAX_BODY（8000 字）缓存上限的 note 文档，分页阅读必须能读到
    /// 真源结尾，而不是在缓存截断处就 has_more=false。
    #[test]
    fn note_read_pages_through_full_source_beyond_cache_cap() {
        let conn = db();
        // 结尾标记刻意不含句读——切块只落在句读处，整句才会完整出现在同一块里
        let tail = "全文结尾标记段必须能到达这里";
        // ~21000 字，远超 kb_docs.body 的 8000 字缓存上限
        let mut content = "深蹲注意膝盖不要内扣。".repeat(3000);
        content.push_str(tail);
        let fid = files::write(&conn, "笔记/超长笔记.md", &content).unwrap();
        index::apply_one(&conn, "note", &fid.to_string()).unwrap();
        let doc_id = note_doc_id(&conn, fid);

        // 缓存确实被截断了（这正是要绕开的坑）
        let cached: i64 = conn
            .query_row(
                "SELECT LENGTH(body) FROM kb_docs WHERE id = ?1",
                [doc_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(cached < content.chars().count() as i64, "缓存应有截断上限");

        let first = read_detail(&conn, doc_id, "l2", Some(0), Some(8)).unwrap();
        assert!(
            first.total_chunks > cached as i64 / 300,
            "总块数应按真源算，而非缓存"
        );
        assert!(first.has_more);

        // 一路翻到最后一页，必须能读到真源的结尾标记
        let mut offset = 0i64;
        let mut saw_tail = false;
        loop {
            let page = read_detail(&conn, doc_id, "l2", Some(offset), Some(64)).unwrap();
            assert_eq!(page.offset, offset);
            if page.chunks.is_empty() {
                break;
            }
            saw_tail |= page.chunks.iter().any(|c| c.text.contains(tail));
            if !page.has_more {
                break;
            }
            offset = page.offset + page.chunks.len() as i64;
        }
        assert!(saw_tail, "分页阅读必须覆盖真源全文，包括缓存截断后的结尾");
    }

    #[test]
    fn note_l1_returns_first_chunk_and_full_total() {
        let conn = db();
        let content = "甲".repeat(5000);
        let fid = files::write(&conn, "文档/归档全文.md", &content).unwrap();
        index::apply_one(&conn, "note", &fid.to_string()).unwrap();
        let doc_id = note_doc_id(&conn, fid);

        let d = read_detail(&conn, doc_id, "l1", None, None).unwrap();
        assert_eq!(d.level, "l1");
        assert_eq!(d.offset, 0);
        assert_eq!(d.chunks.len(), 1);
        // 总块数按真源即时切块算，与「整篇一次切完」完全一致
        let expected =
            chunk::chunk_text(&content, chunk::DEFAULT_MAX_CHARS, chunk::DEFAULT_OVERLAP).len();
        assert_eq!(d.total_chunks as usize, expected);
        // l1 的 has_more 语义与派生文档一致：首块之外还有正文
        assert!(d.has_more);
    }

    /// 派生文档（memory 为例）保持原行为：块与 has_more 都来自 kb_chunks。
    #[test]
    fn derived_doc_read_unchanged() {
        let conn = db();
        memory::apply(
            &conn,
            &[MemoryCandidate {
                op: "add".into(),
                id: None,
                mem_type: "preference".into(),
                topic: "训练偏好".into(),
                category: String::new(),
                content: "用户偏好晨练，避免深蹲超过 60 公斤。".into(),
                confidence: Some(0.9),
                reason: String::new(),
            }],
            None,
            &[],
        )
        .unwrap();
        let mem_id: i64 = conn
            .query_row("SELECT id FROM memory_shards LIMIT 1", [], |r| r.get(0))
            .unwrap();
        index::apply_one(&conn, "memory", &mem_id.to_string()).unwrap();
        let doc_id: i64 = conn
            .query_row(
                "SELECT id FROM kb_docs WHERE source_type = 'memory' AND source_id = ?1",
                [mem_id.to_string()],
                |r| r.get(0),
            )
            .unwrap();

        let d = read_detail(&conn, doc_id, "l2", Some(0), Some(8)).unwrap();
        assert_eq!(d.chunks.len(), 1, "短记忆应只有一块");
        assert!(d.chunks[0].text.contains("晨练"));
        assert!(!d.has_more);
        assert!(d.editable, "记忆是可编辑的派生文档");
    }
}
