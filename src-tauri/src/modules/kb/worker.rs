//! 后台索引线程：消费脏队列、补算向量、上报进度。
//!
//! 三条硬约束决定了这个线程的形状：
//!
//! 1. **嵌入绝不能在持有数据库锁时执行。** 全应用共用同一个 `Mutex<Connection>`（见 state.rs），
//!    而 UI 的每次查询都要抢它。单条嵌入 2–7 ms、一批 32 条就是上百毫秒的界面卡顿。
//!    所以流程切成「持锁取文本 → 放锁嵌入 → 持锁写回」三段。
//! 2. **不引入定时器依赖。** 现有 tokio 只开了 rt/sync/macros，没有 time feature；
//!    这里用 `std::thread` + `recv_timeout` 做「有活就干、没活就等」的循环，也不新增 feature。
//! 3. **内存要能还回去。** 进程峰值工作集实测 157 MB（docs/kb-embed-benchmark.md），
//!    在 Android 上会被低内存杀手盯上。而 session 重建只要 50–130 ms，
//!    所以空闲一段时间后直接丢掉 embedder 是划算的——下次用到再建。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::error::Result;
use crate::state::AppState;

use super::embed::{self, EmbedConfig, Embedder};
use super::files;
use super::index;
use super::memory;
use super::models::{KbProgress, MODE_KEYWORD};
use super::settings;
use super::shard;

/// 事件名：与前端的 `kb://index` 监听对应。
pub const INDEX_EVENT: &str = "kb://index";

/// 一轮处理的最大条数。开太大单轮耗时变长、进度更新变粗；开太小则吞吐差。
const BATCH: i64 = 32;
/// 空闲轮询间隔。有 notify 时会被立刻唤醒，这个间隔只是兜底（触发器写脏队列不会通知我们）。
const IDLE_TICK: Duration = Duration::from_secs(3);
/// 连续空闲多少轮后释放 embedder。约 60 秒。
const IDLE_ROUNDS_BEFORE_RELEASE: u32 = 20;
/// 记忆自动维护（衰减 + 归档）的间隔。纯本地判定、无模型调用，6 小时一次足够克制。
const MAINTAIN_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// 每轮消费 `memory_jobs(kind='extract')` 的时间预算。纯 SQL 派生、不调模型，
/// 50ms 足够追上几轮对话；有积压时 worker 会连续跑下一轮，不会漏。
const EXTRACT_BUDGET_MS: u64 = 50;
/// 每轮取多少条 shard 待嵌入内容。与文档块同量级，避免单轮持锁过长。
const MEMORY_EMBED_BATCH: i64 = 16;
/// 补投缺失 shard 向量的扫描间隔。没有它，换模型后旧 shard 永远等不到重新入列；
/// 也不能每轮扫全表，60 秒一次足够及时又不抢 DB。
const EMBED_BACKFILL_INTERVAL: Duration = Duration::from_secs(60);
/// 每次补投的条数上限（按 last_event_at 倒序，先补最近的）。
const EMBED_BACKFILL_LIMIT: i64 = 500;

/// 运行时状态。挂在 Tauri state 上，命令层通过它唤醒索引 / 取 embedder。
pub struct KbHub {
    wake: Mutex<Option<Sender<()>>>,
    progress: Arc<Mutex<KbProgress>>,
    indexing: Arc<AtomicBool>,
    /// 供 AI 检索路径同步取用的 embedder。`None` 表示当前无需向量（keyword 模式或未就绪）。
    embedder: Arc<Mutex<Option<Arc<dyn Embedder>>>>,
    /// 构建 embedder 时的身份指纹（模式 + 本地模型 + 云端模型），变了就重建。
    built_key: Arc<Mutex<String>>,
    data_dir: PathBuf,
    /// 待处理的脏标记数，供 status 快速读取（避免每次都查库）。
    pending: Arc<AtomicI64>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl KbHub {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            wake: Mutex::new(None),
            progress: Arc::new(Mutex::new(KbProgress {
                phase: "idle".into(),
                done: 0,
                total: 0,
            })),
            indexing: Arc::new(AtomicBool::new(false)),
            embedder: Arc::new(Mutex::new(None)),
            built_key: Arc::new(Mutex::new(String::new())),
            data_dir,
            pending: Arc::new(AtomicI64::new(0)),
            last_error: Arc::new(Mutex::new(None)),
        }
    }

    /// 唤醒索引线程立即干活。写入路径（记忆落库、设置变更）调它，让 AI 查询能很快看到新数据。
    pub fn notify(&self) {
        if let Ok(guard) = self.wake.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(());
            }
        }
    }

    pub fn progress(&self) -> KbProgress {
        self.progress.lock().map(|p| p.clone()).unwrap_or_default()
    }

    pub fn is_indexing(&self) -> bool {
        self.indexing.load(Ordering::Relaxed)
    }

    pub fn pending(&self) -> i64 {
        self.pending.load(Ordering::Relaxed)
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|e| e.clone())
    }

    fn set_error(&self, msg: Option<String>) {
        if let Ok(mut e) = self.last_error.lock() {
            *e = msg;
        }
    }

    /// 取当前 embedder（按需构建）。keyword 模式返回 None。
    ///
    /// **调用方必须先放掉数据库锁**：首次构建要加载模型（实测约 130 ms），
    /// 持锁构建会让界面的每次查询一起卡住。
    pub fn embedder(&self, cfg: &EmbedConfig) -> Result<Option<Arc<dyn Embedder>>> {
        if cfg.mode == MODE_KEYWORD {
            self.release_embedder();
            return Ok(None);
        }

        let mut built = self.built_key.lock().unwrap();
        let mut slot = self.embedder.lock().unwrap();
        let key = embed::identity(cfg);
        if slot.is_none() || *built != key {
            // 身份变了要重建：换本地模型 / 换云端端点或模型都可能发生，不缓存旧的
            match embed::build(cfg, &self.data_dir) {
                Ok(Some(e)) => {
                    *slot = Some(Arc::from(e));
                    *built = key;
                }
                Ok(None) => {
                    *slot = None;
                    built.clear();
                    return Ok(None);
                }
                Err(e) => {
                    *slot = None;
                    built.clear();
                    // 配置不全/模型加载失败不该让整个检索失败，降级为关键词
                    self.set_error(Some(e.to_string()));
                    return Ok(None);
                }
            }
        }
        Ok(slot.clone())
    }

    /// 丢弃缓存的 embedder，让下次用到时按新配置重建。改设置/清向量后调它。
    pub fn release_embedder(&self) {
        if let Ok(mut slot) = self.embedder.lock() {
            if slot.is_some() {
                *slot = None;
                if let Ok(mut b) = self.built_key.lock() {
                    b.clear();
                }
            }
        }
    }

    /// 启动后台线程。
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let (tx, rx) = mpsc::channel::<()>();
        if let Ok(mut guard) = self.wake.lock() {
            *guard = Some(tx);
        }

        let hub = Arc::clone(self);
        std::thread::Builder::new()
            .name("rein-kb-indexer".into())
            .spawn(move || worker_loop(app, hub, rx))
            .expect("启动知识库索引线程失败");
    }
}

/// 启动对账的节流键与间隔。
///
/// 触发器（kb_t_*，38 条）已经把**运行期**的增删改全部记进脏队列；启动扫全表本来
/// 只是补救手段：①老库升级上来时存量数据没被触发器登记过；②清理孤儿文档。
/// 从前每次启动都扫：生产库实测入队 1785 条（其中 1379 条内容没变），持锁约
/// 100ms（debug 构建；release 约 30ms），随后索引线程还要空转几百毫秒把它们
/// 逐条 derive 一遍。它不阻塞启动，但会占住唯一的 DB 连接，首屏几个读命令排在
/// 它后面。改成「版本变 / 启用源变 / 距上次超过 24h」才全量对账，日常启动零成本；
/// 孤儿最多滞留 24h，且运行期删除有触发器兜底。
const RECONCILE_KEY: &str = "kb_reconcile_v1";
const RECONCILE_INTERVAL_SECS: i64 = 24 * 60 * 60;

/// 启动后的一次性对账：把既有源记录全部入队，并清掉源已消失的孤儿文档。
///
/// 放在后台线程里做，不阻塞启动；节流规则见 [`RECONCILE_KEY`]。
fn reconcile(app: &AppHandle, hub: &KbHub) {
    let state = app.state::<AppState>();
    let outcome = (|| -> Result<i64> {
        let conn = state.db.lock();
        // 系统文件（规范 / 系统提示词 / 用户记忆模板 / 收件箱）随应用版本更新，幂等；
        // 必须在对账前播种，这样它们也会被当成 note 一起编目进路径树
        files::ensure_system_files(&conn)?;
        let enabled = settings::enabled_sources(&conn)?;
        let enabled_key = enabled.join(",");
        let now = chrono::Utc::now().timestamp();
        let need_scan = match crate::db::meta_get(&conn, RECONCILE_KEY) {
            Some(raw) => {
                // 存的是 `版本|启用源|unix秒`：任何一段读不出来都按「该对账」处理
                let mut parts = raw.rsplitn(3, '|');
                let ts = parts.next().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
                let prev_sources = parts.next().unwrap_or("");
                let prev_version = parts.next().unwrap_or("");
                prev_version != env!("CARGO_PKG_VERSION")
                    || prev_sources != enabled_key
                    || now.saturating_sub(ts) > RECONCILE_INTERVAL_SECS
            }
            None => true,
        };
        let n = if need_scan {
            let n = index::scan_all(&conn, &enabled)?;
            crate::db::meta_set(
                &conn,
                RECONCILE_KEY,
                &format!("{}|{}|{}", env!("CARGO_PKG_VERSION"), enabled_key, now),
            )?;
            n
        } else {
            index::pending_count(&conn)?
        };
        // 旧库一次性回填（app_meta 幂等）总是做：成本只有首次，之后是一条查询。
        if let Err(e) = shard::store::backfill_legacy(&conn) {
            eprintln!("[kb] 旧记忆回填失败（忽略）：{e}");
        }
        // 跨设备对账与全量索引共用 24h 节流：补 anchor、清理孤儿 shard、给最近
        // 可读 anchor 补投 extract job。worker 随后会消费这些 job 生成 conversation shard。
        if need_scan {
            match shard::store::reconcile_conversation_shards(&conn, 30) {
                Ok(n) if n > 0 => eprintln!("[kb] 会话记忆对账修正 {n} 条"),
                Ok(_) => {}
                Err(e) => eprintln!("[kb] 会话记忆对账失败（忽略）：{e}"),
            }
        }
        // 缺失 / 模型不匹配的 shard 向量补投：换模型后靠这一段把旧 shard 重新入列。
        match embed::resolve_config(&conn) {
            Ok(cfg) => {
                if let Some(model_id) = embed::model_id_of(&cfg) {
                    if let Err(e) = shard::store::enqueue_missing_embeddings(
                        &conn,
                        &model_id,
                        EMBED_BACKFILL_LIMIT,
                    ) {
                        eprintln!("[kb] 补投记忆向量任务失败（忽略）：{e}");
                    }
                }
            }
            Err(e) => eprintln!("[kb] 读取嵌入配置失败（忽略）：{e}"),
        }
        // 启动顺手做一次记忆维护（衰减 + 自动归档）。失败不拖垮对账：这是机会性任务。
        match memory::maintain(&conn) {
            Ok(r) if r.archived > 0 => {
                eprintln!("[kb] 启动维护归档了 {} 条低信号记忆", r.archived)
            }
            Ok(_) => {}
            Err(e) => eprintln!("[kb] 启动记忆维护失败：{e}"),
        }
        Ok(n)
    })();

    match outcome {
        Ok(n) if n > 0 => {
            hub.pending.store(n, Ordering::Relaxed);
            // 立刻醒一次去消化刚入队的存量数据
            hub.notify();
        }
        Ok(_) => {}
        Err(e) => hub.set_error(Some(format!("启动对账失败：{e}"))),
    }
}

fn worker_loop(app: AppHandle, hub: Arc<KbHub>, rx: mpsc::Receiver<()>) {
    let mut idle_rounds: u32 = 0;

    reconcile(&app, &hub);
    // 启动对账里刚跑过一次维护，下一次从这里计时
    let mut last_maintain = Instant::now();
    let mut last_embed_backfill = Instant::now();

    // 有活就连着干。启动对账会一次性入队**全部**源记录（生产库实测 1.7k 条；
    // 大库可以到上万），如果每 32 条就回去等 3 秒兜底节奏，清空要几分钟 —— 这段
    // 时间里 `drain_before_query` 的 pending 永远非零，每次目录列举 / 阅读都会空等
    // 满预算（关于你 → 文件夹打开一次就卡一轮）。所以只有**确实没活**时才睡：
    // `cycle` 返回「这一轮是否吃满一批」和随后的 pending 共同决定。
    //
    // 3 秒的兜底间隔仍然保留：触发器写脏队列不一定 notify，空闲时靠它保证
    // 「用户改完东西」最迟 3 秒内被索引。通道断开（应用退出）即退出循环。
    let mut hot = hub.pending() > 0;
    loop {
        if !hot {
            match rx.recv_timeout(IDLE_TICK) {
                Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }

        let (worked, more) = match cycle(&app, &hub) {
            Ok(v) => {
                // 恢复正常就清掉持久化的错误标记，让 kb_status 如实反映「当前没问题」
                if hub.last_error().is_some() {
                    hub.set_error(None);
                    let state = app.state::<AppState>();
                    let conn = state.db.lock();
                    let _ = settings::set_last_error(&conn, None);
                }
                v
            }
            Err(e) => {
                hub.set_error(Some(e.to_string()));
                // 错误同时落库：重启后 kb_status 仍能看到上次失败原因
                {
                    let state = app.state::<AppState>();
                    let conn = state.db.lock();
                    let _ = settings::set_last_error(&conn, Some(&e.to_string()));
                }
                (0, false)
            }
        };
        // 还满着一批，或脏队列还有货：下一轮立刻继续，不再等 3 秒。
        hot = more || (worked > 0 && hub.pending() > 0);

        if worked > 0 {
            idle_rounds = 0;
        } else {
            idle_rounds += 1;
            if idle_rounds == IDLE_ROUNDS_BEFORE_RELEASE {
                hub.release_embedder();
            }
        }

        // 周期维护：记忆的衰减与自动归档。站在索引线程里搭车，不新增定时器。
        if last_maintain.elapsed() >= MAINTAIN_INTERVAL {
            last_maintain = Instant::now();
            let state = app.state::<AppState>();
            let conn = state.db.lock();
            match memory::maintain(&conn) {
                Ok(r) if r.archived > 0 => {
                    eprintln!("[kb] 周期维护归档了 {} 条低信号记忆", r.archived)
                }
                Ok(_) => {}
                Err(e) => eprintln!("[kb] 周期记忆维护失败：{e}"),
            }
        }

        // 缺失向量补投：换嵌入模型后旧 shard 需要重新入列。按分钟节流，
        // 避免在索引高峰期每分钟之外反复扫 memory_shards。
        if last_embed_backfill.elapsed() >= EMBED_BACKFILL_INTERVAL {
            last_embed_backfill = Instant::now();
            backfill_memory_embeddings(&app);
        }
    }
}

/// 给缺失 / 模型不匹配的 shard 补投 embed job。纯 SQL、幂等；没有向量模型时直接跳过。
fn backfill_memory_embeddings(app: &AppHandle) {
    let state = app.state::<AppState>();
    let conn = state.db.lock();
    let Ok(cfg) = embed::resolve_config(&conn) else {
        return;
    };
    let Some(model_id) = embed::model_id_of(&cfg) else {
        return;
    };
    if let Err(e) =
        shard::store::enqueue_missing_embeddings(&conn, &model_id, EMBED_BACKFILL_LIMIT)
    {
        eprintln!("[kb] 周期补投记忆向量任务失败（忽略）：{e}");
    }
}

/// 跑一轮：消费记忆 job + 处理脏标记 + 补算向量。返回 `(工作量, 是否可能还有下一批)`。
///
/// 「还有下一批」比「本轮有工作量」更准：每批上限是 [`BATCH`] / [`MEMORY_EMBED_BATCH`]，
/// 本轮吃满一批就意味着大概率还有剩余；收尾那轮通常不满，下一次循环会自然咬到 0 然后回去睡。
fn cycle(app: &AppHandle, hub: &KbHub) -> Result<(usize, bool)> {
    let state = app.state::<AppState>();

    // 第一段：持锁消费记忆队列 + 取脏 + 派生落库 + 收集待嵌入文本。
    // 顺序很重要：先 drain extract（conversation shard 在这里生成并 mark_dirty），
    // 再 take_dirty，新 shard 的检索镜像才能在同一轮建好。
    // 这里只读配置、不构建 embedder。
    let (dirty_count, chunk_count, pending_chunks, model_id, memory_jobs, extracted) = {
        let conn = state.db.lock();
        let cfg = embed::resolve_config(&conn)?;
        let model_id = embed::model_id_of(&cfg);

        // extract 是纯 SQL 派生（不调模型）；单轮有界，积压由后续轮次继续追。
        let extracted = match shard::store::drain_extract(&conn, EXTRACT_BUDGET_MS) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[kb] 记忆抽取失败（忽略，留待重试）：{e}");
                0
            }
        };
        // embed job 只取「shard id + 文本」，向量计算放到放锁之后。
        let memory_jobs = match &model_id {
            Some(_) => shard::store::take_embed_batch(&conn, MEMORY_EMBED_BATCH)?,
            None => Vec::new(),
        };

        let dirty = index::take_dirty(&conn, BATCH)?;
        if dirty.is_empty() && model_id.is_none() {
            hub.pending
                .store(index::pending_count(&conn)?, Ordering::Relaxed);
            // 本轮可能只做了记忆抽取：如实计入工作量；有产出就立刻再跑一轮，
            // 把连续 terminal 产生的积压追干净，而不是等 3 秒兜底间隔。
            return Ok((extracted.max(0) as usize, extracted > 0));
        }

        hub.indexing.store(true, Ordering::Relaxed);
        if let Ok(mut p) = hub.progress.lock() {
            p.phase = "chunking".into();
            p.done = 0;
            p.total = dirty.len() as i64;
        }

        let mut rebuilt = 0i64;
        for (st, sid, _op) in &dirty {
            // 派生失败不能中断整轮：单条脏数据不该卡住整个知识库
            match index::apply_one(&conn, st, sid) {
                Ok(out) => {
                    if !out.unchanged {
                        rebuilt += 1;
                    }
                }
                Err(e) => eprintln!("[kb] 派生失败 {st}/{sid}: {e}"),
            }
        }
        if let Ok(mut p) = hub.progress.lock() {
            p.done = rebuilt;
        }
        let chunks = match &model_id {
            Some(m) => index::chunks_needing_vectors(&conn, m, BATCH)?,
            None => Vec::new(),
        };
        hub.pending
            .store(index::pending_count(&conn)?, Ordering::Relaxed);

        if dirty.is_empty() && chunks.is_empty() && memory_jobs.is_empty() {
            hub.indexing.store(false, Ordering::Relaxed);
            if let Ok(mut p) = hub.progress.lock() {
                p.phase = "idle".into();
            }
            return Ok((extracted.max(0) as usize, extracted > 0));
        }
        (dirty.len(), chunks.len(), chunks, model_id, memory_jobs, extracted)
    };

    // 第二段：放锁构建 + 嵌入。这两步都可能上百毫秒，持锁会直接卡住界面。
    let mut stored = 0usize;
    if !pending_chunks.is_empty() && model_id.is_some() {
        let cfg = {
            let conn = state.db.lock();
            embed::resolve_config(&conn)?
        };
        if let Some(e) = hub.embedder(&cfg)? {
            let texts: Vec<String> = pending_chunks.iter().map(|(_, t)| t.clone()).collect();
            if let Ok(mut p) = hub.progress.lock() {
                p.phase = "embedding".into();
                p.total = texts.len() as i64;
                p.done = 0;
            }
            emit(app, hub);

            let vectors = e.embed(&texts)?;
            let items: Vec<(i64, Vec<f32>)> = pending_chunks
                .iter()
                .map(|(id, _)| *id)
                .zip(vectors)
                .collect();

            // 第三段：持锁写回。模型标识以 embedder 实际返回的为准，
            // 与当初决定「哪些块要算向量」的推算值天然一致。
            let conn = state.db.lock();
            stored = index::store_vectors(&conn, e.model_id(), &items)?;
        }
    }

    // 记忆 shard 向量：同样放锁计算、持锁写回。失败只记退避并留队，
    // 不拖垮本轮文档索引（下一轮还会取到同一批 job）。
    let memory_job_count = memory_jobs.len();
    if !memory_jobs.is_empty() && model_id.is_some() {
        let cfg = {
            let conn = state.db.lock();
            embed::resolve_config(&conn)?
        };
        if let Some(e) = hub.embedder(&cfg)? {
            let ids: Vec<i64> = memory_jobs.iter().map(|j| j.shard_id).collect();
            let texts: Vec<String> = memory_jobs.iter().map(|j| j.content.clone()).collect();
            match e.embed(&texts) {
                Ok(vectors) => {
                    let items: Vec<(i64, Vec<f32>)> = ids.iter().copied().zip(vectors).collect();
                    let conn = state.db.lock();
                    match shard::store::store_embeddings(&conn, e.model_id(), &items) {
                        Ok(()) => stored += items.len(),
                        Err(err) => eprintln!("[kb] 写入记忆向量失败（留待重试）：{err}"),
                    }
                }
                Err(err) => {
                    let now = chrono::Utc::now().to_rfc3339();
                    let conn = state.db.lock();
                    if let Err(e) =
                        shard::store::fail_embed_jobs(&conn, &ids, &err.to_string(), &now)
                    {
                        eprintln!("[kb] 记录记忆嵌入失败状态失败：{e}");
                    }
                    eprintln!("[kb] 记忆嵌入失败（退避重试）：{err}");
                }
            }
        }
    }

    hub.indexing.store(false, Ordering::Relaxed);
    if let Ok(mut p) = hub.progress.lock() {
        p.phase = "done".into();
        p.done = p.total;
    }
    emit(app, hub);
    // 满批 = 大概率还有；任一队列吃满都算。extract 有产出时也立刻再来一轮，
    // 让一场会话连续产生的多个锚点不必等 3 秒兜底间隔。
    let more = dirty_count as i64 == BATCH
        || chunk_count as i64 == BATCH
        || memory_job_count as i64 == MEMORY_EMBED_BATCH
        || extracted > 0;
    Ok((dirty_count + stored + extracted.max(0) as usize, more))
}

fn emit(app: &AppHandle, hub: &KbHub) {
    let p = hub.progress();
    let _ = app.emit(
        INDEX_EVENT,
        serde_json::json!({
            "phase": p.phase,
            "done": p.done,
            "total": p.total,
            "pending": hub.pending(),
            "indexing": hub.is_indexing(),
        }),
    );
}

/// 检索前把积压的脏标记刷掉，保证 AI 不会看到陈旧数据。
///
/// 有界等待：嵌入是毫秒级，正常一轮就够；超时也不再等，宁可返回略微陈旧的结果，
/// 也不能让一次工具调用长时间挂住。
pub fn drain_before_query(app: &AppHandle, budget: Duration) -> Result<()> {
    let hub = app.state::<Arc<KbHub>>();
    let state = app.state::<AppState>();

    let deadline = Instant::now() + budget;
    loop {
        // **每一轮都推一下**。worker 处理完一批会回去等兜底节奏（3s）；只在进门时
        // notify 一次的话，等待方会在剩余预算里纯干等 —— 一次 1.5s 预算就变成 1.5s 空转，
        // 而这正是「关于你 → 文件夹」在启动索引期间每次打开都卡住的原因。20ms 一次
        // 的 notify 只是一次 channel send，成本可以忽略。
        hub.notify();
        let pending = {
            let conn = state.db.lock();
            index::pending_count(&conn)?
        };
        if pending == 0 || Instant::now() >= deadline {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::kb::{models::KbSettingsInput, settings};

    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    #[test]
    fn hub_starts_idle_without_embedder() {
        let hub = KbHub::new(std::env::temp_dir());
        assert!(!hub.is_indexing());
        assert_eq!(hub.pending(), 0);
        assert!(hub.last_error().is_none());
        assert_eq!(hub.progress().phase, "idle");
    }

    /// keyword 模式下不该去构建 embedder——否则纯关键词用户会白付一次模型加载。
    #[test]
    fn keyword_mode_yields_no_embedder() {
        let hub = KbHub::new(std::env::temp_dir());
        let conn = db();
        let cfg = embed::resolve_config(&conn).unwrap();
        assert!(embed::model_id_of(&cfg).is_none());
        assert!(hub.embedder(&cfg).unwrap().is_none());
        assert!(hub.built_key.lock().unwrap().is_empty());
    }

    /// 云端配置不完整时应降级为「无 embedder + 记录错误」，而不是让检索直接失败。
    #[test]
    fn incomplete_cloud_config_degrades_to_error_not_panic() {
        let hub = KbHub::new(std::env::temp_dir());
        let conn = db();
        settings::update(
            &conn,
            &KbSettingsInput {
                embedding_mode: Some(crate::modules::kb::models::MODE_CLOUD.into()),
                ..Default::default()
            },
        )
        .unwrap();
        let cfg = embed::resolve_config(&conn).unwrap();
        assert!(hub.embedder(&cfg).unwrap().is_none());
        assert!(hub.last_error().is_some(), "应记录降级原因");
    }

    /// 本地模式只需读配置就能推出模型标识，不必真的加载模型——
    /// 这是「持锁阶段不构建 embedder」的前提。
    #[test]
    fn local_mode_model_id_needs_no_model_load() {
        let conn = db();
        settings::update(
            &conn,
            &KbSettingsInput {
                embedding_mode: Some(crate::modules::kb::models::MODE_LOCAL.into()),
                ..Default::default()
            },
        )
        .unwrap();
        let cfg = embed::resolve_config(&conn).unwrap();
        assert_eq!(
            embed::model_id_of(&cfg).as_deref(),
            Some(crate::modules::kb::embed_models::default_model().id)
        );
    }

    #[test]
    fn releasing_embedder_is_idempotent() {
        let hub = KbHub::new(std::env::temp_dir());
        hub.release_embedder();
        hub.release_embedder();
        assert!(hub.embedder.lock().unwrap().is_none());
    }

    #[test]
    fn notify_without_worker_is_safe() {
        let hub = KbHub::new(std::env::temp_dir());
        hub.notify(); // 未 start 时不该 panic
    }
}
