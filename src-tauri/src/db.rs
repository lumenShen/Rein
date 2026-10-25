//! 数据库初始化与迁移。
//!
//! 迁移规则：`MIGRATIONS` 数组按下标即版本号（0001 起），只追加、永不修改历史条目；
//! 新迁移 = 在数组末尾追加一条 SQL。应用启动时在事务内补齐缺失版本。

use rusqlite::Connection;
use tauri::Manager;

use crate::error::{ReinError, Result};

use std::path::PathBuf;

/// 数据目录整体搬家的环境变量。桌面端有效；未设置时行为与从前一字不差。
pub const DATA_DIR_ENV: &str = "REIN_DATA_DIR";

/// 应用数据目录解析——**全应用只认这一处**，各域不许再各自 `app_data_dir()`。
///
/// 为什么需要它：真机探针（`scripts/voice-real-release-probe.mjs` 等）会直接拉起
/// release exe，用的却是与用户真身账号完全相同的数据目录——测试录音、冒烟训练
/// 全落进 rein.db，用户在自己库里翻到一堆测试数据（2026-10-10 事故）。有了这个开关，
/// 探针 / CI / 手动冒烟可以把**整个**数据目录（rein.db、voice_sessions、sync_*、
/// updates、rescue 脚本）指到一处临时目录，与生产库物理隔离。
///
/// 契约：
/// - 未设置（或空串 / 纯空白）= 走 Tauri 的 `app_data_dir()`，用户真身路径；
/// - 设置了 = **只认它**，且目录建不出来就直接报错——绝不静默回退到生产目录。
///   一个拼错的环境变量若是悄悄写进用户真库，比启动失败危险得多；
/// - 相对路径按当前工作目录拼成绝对路径（exe 的 CWD 随启动方式变，不能赌）。
pub fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    match env_override(std::env::var(DATA_DIR_ENV).ok()).as_deref() {
        Some(raw) => resolve_override_dir(raw),
        None => app
            .path()
            .app_data_dir()
            .map_err(|e| ReinError::Message(format!("无法定位应用数据目录：{e}"))),
    }
}

/// 本次运行是否跑在隔离数据目录里。供按需放宽**运行时**作用域用
/// （如 asset 协议：tauri.conf.json 里的白名单写死了 `$APPDATA/voice_sessions/*`，
/// 隔离目录不在其内；见 lib.rs 的补作用域逻辑）。
pub fn isolated() -> bool {
    env_override(std::env::var(DATA_DIR_ENV).ok()).is_some()
}

/// 环境值清洗：空串 / 纯空白视为没设 —— shell 里 `set REIN_DATA_DIR=` 是常事，
/// 它必须被当作「用真身目录」而不是「根目录」。
fn env_override(raw: Option<String>) -> Option<String> {
    raw.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// 「设了开关」这一边：只认环境变量，建不出目录就报错——绝不回退生产目录。
fn resolve_override_dir(raw: &str) -> Result<PathBuf> {
    let mut dir = PathBuf::from(raw.trim());
    if !dir.is_absolute() {
        let cwd = std::env::current_dir().map_err(|e| {
            ReinError::Message(format!("REIN_DATA_DIR 是相对路径且读不到工作目录：{e}"))
        })?;
        dir = cwd.join(dir);
    }
    std::fs::create_dir_all(&dir).map_err(|e| {
        ReinError::Message(format!(
            "REIN_DATA_DIR 指向的目录创建失败（{e}）：{}\n（不回退到生产数据目录——请修正路径后重试）",
            dir.display()
        ))
    })?;
    Ok(dir)
}

/// 打开（必要时创建）应用数据目录下的 SQLite 库，并完成迁移与种子。
pub fn init(app: &tauri::AppHandle) -> Result<Connection> {
    let dir = data_dir(app)?;
    std::fs::create_dir_all(&dir)?;

    let conn = Connection::open(dir.join("rein.db"))?;
    tune(&conn)?;

    migrate(&conn)?;
    crate::modules::seed::seed_foods(&conn)?;
    crate::modules::seed::seed_builtin_plans(&conn)?;
    crate::modules::seed::seed_exercises(&conn)?;
    // 动作库必须在课程种子之后：存量课程条目与做组记录在此挂上库 id（幂等）
    crate::modules::exercise_lib::resolve::backfill_exercise_refs(&conn)?;
    Ok(conn)
}

/// 连接级 pragma —— **全应用只在这里设一次**，各域不许再各自 `pragma_update`。
///
/// `synchronous = NORMAL`（2026-09-30 加）是这里唯一一条与性能有关的设置，也是本仓库
/// 写路径上最贵的一处：WAL 模式下默认的 `FULL` 意味着**每一次提交都 fsync 一次 WAL**，
/// 而 Rein 的写是大量「单语句自动提交」（会话快照、抢课任务推进、待办勾选、同步游标），
/// 一条命令一次 fsync。同一台机器上 2000 次这类写：`FULL` 2342.8 ms / `NORMAL` 95.5 ms，
/// **相差 24.5 倍**（每次 1.171 ms → 0.048 ms）；真机（尤其 Android 闪存）只会更悬殊。
///
/// 为什么可以降：WAL 模式下的 NORMAL **不会损坏数据库**（SQLite 官方文档的口径），
/// 代价仅限于「断电 / 内核崩溃时可能回滚最近若干次已提交事务」。Rein 的数据是本地个人数据，
/// 丢最后几秒与每次写都等一次盘相比，后者才是用户天天能感觉到的那个。若哪天要上「写到就必须在」，
/// 正确的做法是给那**一条**链路开 `PRAGMA synchronous=FULL` 事务，而不是把全局拖回 FULL。
///
/// 早先没有显式设它 = 用 SQLite 默认的 FULL（2）。`foreign_keys` 必须显式开：默认关，
/// 关了之后 `ON DELETE CASCADE` 全部失效（级联删除是好几处表关系的依靠）。
pub(crate) fn tune(conn: &Connection) -> Result<()> {
    // 顺序有讲究：journal_mode 必须先设 —— synchronous 的语义由日志模式决定，
    // 先设 synchronous 再切 WAL 会保留「按回滚日志算」的那一档。
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

/// 0001 · 初始表结构：食物库 / 记录 / 资料 / 待办 / 运动 / 番茄钟
const MIGRATION_0001: &str = r#"
CREATE TABLE foods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category TEXT,
  kcal REAL NOT NULL DEFAULT 0,
  protein REAL NOT NULL DEFAULT 0,
  carb REAL NOT NULL DEFAULT 0,
  fat REAL NOT NULL DEFAULT 0,
  fiber REAL NOT NULL DEFAULT 0,
  sugar REAL NOT NULL DEFAULT 0,
  sodium_mg REAL NOT NULL DEFAULT 0,
  potassium_mg REAL NOT NULL DEFAULT 0,
  calcium_mg REAL NOT NULL DEFAULT 0,
  iron_mg REAL NOT NULL DEFAULT 0,
  zinc_mg REAL NOT NULL DEFAULT 0,
  magnesium_mg REAL NOT NULL DEFAULT 0,
  vit_a_ug REAL NOT NULL DEFAULT 0,
  vit_c_mg REAL NOT NULL DEFAULT 0,
  vit_d_ug REAL NOT NULL DEFAULT 0,
  vit_e_mg REAL NOT NULL DEFAULT 0,
  vit_b12_ug REAL NOT NULL DEFAULT 0,
  folate_ug REAL NOT NULL DEFAULT 0,
  default_unit TEXT,
  is_custom INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE food_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  grams REAL NOT NULL,
  UNIQUE(food_id, name)
);

CREATE TABLE meal_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  food_id INTEGER NOT NULL REFERENCES foods(id),
  date TEXT NOT NULL,
  meal_type TEXT NOT NULL,
  quantity_mode TEXT NOT NULL,
  -- 不变量：grams 恒为换算后的克重；units/unit_name 仅用于展示
  grams REAL NOT NULL,
  units REAL,
  unit_name TEXT,
  source TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_meal_logs_date ON meal_logs(date);

CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nickname TEXT NOT NULL DEFAULT 'Rein 用户',
  sex TEXT,
  birthday TEXT,
  height_cm REAL,
  weight_kg REAL,
  target_weight_kg REAL,
  activity_level TEXT NOT NULL DEFAULT 'light',
  goal TEXT NOT NULL DEFAULT 'keep',
  target_kcal REAL NOT NULL DEFAULT 2000,
  target_protein REAL NOT NULL DEFAULT 80,
  target_carb REAL NOT NULL DEFAULT 250,
  target_fat REAL NOT NULL DEFAULT 65,
  target_sodium_mg REAL NOT NULL DEFAULT 1500,
  target_water_ml REAL NOT NULL DEFAULT 1700
);
INSERT INTO profile (id) VALUES (1);

CREATE TABLE todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT,
  date TEXT,
  start_min INTEGER,
  duration_min INTEGER,
  category TEXT NOT NULL DEFAULT 'general',
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'todo',
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_todos_date ON todos(date);

CREATE TABLE workouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  start_min INTEGER,
  duration_min REAL NOT NULL,
  kcal REAL NOT NULL,
  intensity TEXT NOT NULL DEFAULT 'moderate',
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_workouts_date ON workouts(date);

CREATE TABLE pomodoro_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  focus_min REAL NOT NULL,
  break_min REAL NOT NULL,
  completed INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_pomodoro_started ON pomodoro_sessions(started_at);
"#;

/// 0002 · 训练课会话表：支持全程快照落盘与异常中断恢复
const MIGRATION_0002: &str = r#"
CREATE TABLE workout_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  -- active | finished | aborted；只有用户经「结束键 + 二级确认」才会离开 active
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  ex_index INTEGER NOT NULL DEFAULT 0,
  set_index INTEGER NOT NULL DEFAULT 1,
  weight_kg REAL NOT NULL DEFAULT 0,
  elapsed_sec REAL NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_sessions_status ON workout_sessions(status);
"#;

/// 0003 · 训练课程表：用户可编辑课程 + 最近使用时间（种子来自 resources/workout_plans.json）
const MIGRATION_0003: &str = r#"
CREATE TABLE workout_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  workout_type TEXT NOT NULL DEFAULT 'strength',
  -- 动作数组 JSON，结构由前端 PlanExercise 约束
  exercises_json TEXT NOT NULL DEFAULT '[]',
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"#;

/// 0004 · 记账：流水表 + 单行设置表（月度总预算；金额一律存整数分）
const MIGRATION_0004: &str = r#"
CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- expense | income
  kind TEXT NOT NULL DEFAULT 'expense',
  -- 分类 key（前端 src/config/ledger.ts）
  category TEXT NOT NULL,
  -- 金额（分），恒为正；正负号由 kind 表达
  amount_cents INTEGER NOT NULL,
  note TEXT,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ledger_entries_date ON ledger_entries(date);

CREATE TABLE ledger_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- 0 = 未设置月度总预算
  monthly_budget_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
INSERT INTO ledger_settings (id) VALUES (1);
"#;

/// 0005 · 方案计算器参数快照 + 体重身高追踪。
/// calc_params 单行快照：保存计算器上次使用的身体参数（含手输年龄），未保存过时各列为 NULL；
/// body_metrics 按天一条，同日补录时 COALESCE 合并（只更新提供的项）。
const MIGRATION_0005: &str = r#"
CREATE TABLE calc_params (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sex TEXT,
  age INTEGER,
  height_cm REAL,
  weight_kg REAL,
  activity_level TEXT NOT NULL DEFAULT 'light',
  goal TEXT NOT NULL DEFAULT 'keep',
  saved_at TEXT
);
INSERT INTO calc_params (id) VALUES (1);

CREATE TABLE body_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  weight_kg REAL,
  height_cm REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_body_metrics_date ON body_metrics(date);
"#;

/// 0006 · AI：用户添加的模型配置（含探测结果）+ 聊天会话与消息历史。
/// ai_models 仅作配置存储，真正的模型请求在前端 WebView 内由 pi-ai 直连 provider；
/// 探测结果（视觉/思考/努力档）由前端写入后展示在管理页。
const MIGRATION_0006: &str = r#"
CREATE TABLE ai_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  -- UI 预设标识（deepseek | openai-compatible），请求参数格式按 base_url 自动探测
  provider TEXT NOT NULL DEFAULT 'openai-compatible',
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  model_id TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  -- 能力探测：NULL=未知 1=支持 0=不支持
  vision INTEGER,
  thinking INTEGER,
  effort INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_ai_models_one_default ON ai_models(is_default) WHERE is_default = 1;

CREATE TABLE ai_chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'AI 对话',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ai_chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT,
  image_base64 TEXT,
  mime TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(chat_id, seq)
);
CREATE INDEX idx_ai_chat_messages_chat ON ai_chat_messages(chat_id, seq);
"#;

/// 0007 · 训练记录关联来源会话：详情抽屉按此反查最后一帧快照（轨迹 / 做组明细）。
/// 手动添加的记录为 NULL；历史数据一律 NULL，抽屉回退到概要视图。
const MIGRATION_0007: &str = r#"
ALTER TABLE workouts ADD COLUMN session_id INTEGER REFERENCES workout_sessions(id);
"#;

/// 0008 · 健康方案：
/// - profile 补充个性化约束（训练频率/时段/器械条件/忌口/经验），供方案引擎过滤生成
/// - workout_plans 补充课程 meta（器械要求 / 预估时长），供周计划组合与日程排布
/// - programs：程序计算的周期方案（内容快照存 params_json，AI 调整历史存 adjustments_json）
/// - todos.program_id：方案生成的日程待办来源标记，重排/清理按它事务化处理
const MIGRATION_0008: &str = r#"
ALTER TABLE profile ADD COLUMN training_days_per_week INTEGER;
ALTER TABLE profile ADD COLUMN preferred_time_slots TEXT;
ALTER TABLE profile ADD COLUMN equipment TEXT;
ALTER TABLE profile ADD COLUMN diet_restrictions TEXT;
ALTER TABLE profile ADD COLUMN experience TEXT;

ALTER TABLE workout_plans ADD COLUMN equipment TEXT;
ALTER TABLE workout_plans ADD COLUMN est_duration_min INTEGER;

CREATE TABLE programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal TEXT NOT NULL,
  -- conservative | balanced | aggressive（保守 / 均衡 / 进取档）
  tier TEXT NOT NULL,
  -- active | archived；同一时刻至多一个 active（创建新方案时自动归档旧方案）
  status TEXT NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1,
  weeks INTEGER NOT NULL DEFAULT 4,
  -- 方案内容快照 JSON：{ params, days }，结构由前端 types/program.ts 约束
  params_json TEXT NOT NULL,
  -- AI / 手动调整历史 JSON 数组，每项含版本号与变更明细
  adjustments_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE todos ADD COLUMN program_id INTEGER REFERENCES programs(id);
"#;

/// 0009 · 食谱偏好：方案引擎选菜与食谱库「喜欢/不喜欢」共用，rating 1=喜欢 -1=不喜欢。
const MIGRATION_0009: &str = r#"
CREATE TABLE recipe_prefs (
  recipe_id TEXT PRIMARY KEY,
  rating INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
"#;

/// 0010 · 方案每日菜单缓存：AI 按天生成的菜单落库（未生成的日期回落模板菜单）。
const MIGRATION_0010: &str = r#"
CREATE TABLE program_meals (
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  meals_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (program_id, date)
);
"#;

/// 0011 · 今日画布：待办重复规则 / 实例键 / 子任务清单。
/// rec_rule 模板行持有规则；实例行 rec_key = "模板id:日期"（部分唯一索引保证物化幂等）。
const MIGRATION_0011: &str = r#"
ALTER TABLE todos ADD COLUMN rec_rule TEXT;
ALTER TABLE todos ADD COLUMN rec_key TEXT;
ALTER TABLE todos ADD COLUMN subtasks TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_rec_key ON todos(rec_key) WHERE rec_key IS NOT NULL;
"#;

/// 0012 · 采购清单勾选状态：清单本身由菜单实时聚合（不落库），这里只存「已买」标记。
/// item_key = 聚合行键（AI 行 `f:<foodId>` / 模板行 `n:<名称>[|u:<单位>]`），跨方案稳定复用。
const MIGRATION_0012: &str = r#"
CREATE TABLE shopping_checks (
  item_key TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL
);
"#;

/// 0013 · 逐组重量记录：session_finish 事务内把最终快照的做组明细展开落行，
/// 是「动作重量变化曲线」的查询数据源（exercise_name 跨课程/跨编辑稳定）。
/// app_meta 为通用键值元数据（当前用于内置课程种子内容版本号）。
const MIGRATION_0013: &str = r#"
CREATE TABLE workout_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  plan_id TEXT,
  exercise_key TEXT NOT NULL,
  exercise_name TEXT NOT NULL,
  set_no INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'strength',
  weight_kg REAL,
  reps INTEGER,
  sec INTEGER,
  warmup INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sets_name ON workout_sets(exercise_name, workout_id);
CREATE INDEX idx_sets_workout ON workout_sets(workout_id);
CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

/// 0014 · 待办附件/标记：文字正文内联，文件/图片/音频存 data URL（JSON 数组）。
/// 重复实例物化时不继承附件（按次记录）。
const MIGRATION_0014: &str = r#"
ALTER TABLE todos ADD COLUMN attachments TEXT;
"#;

/// 0015 · ai_models 增加图片发送分辨率上限（最长边像素）：NULL 时前端用默认值。
/// 发图/放大镜输出都按它压缩，尽量贴近各视觉模型的输入分辨率上限。
const MIGRATION_0015: &str = r#"
ALTER TABLE ai_models ADD COLUMN image_max_edge INTEGER;
"#;

/// 0016 · 语音会话纪要（modules/voice）：一段转写一条，
/// 句子与总结存 JSON 文本列（结构由前端约定，Rust 不解释）；
/// 音频为追加落盘的 wav 文件，audio_path 存应用数据目录内相对路径。
const MIGRATION_0016: &str = r#"
CREATE TABLE voice_memos (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  audio_path TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  words INTEGER NOT NULL DEFAULT 0,
  sentences TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_voice_memos_chat ON voice_memos(chat_id);
CREATE INDEX idx_voice_memos_created ON voice_memos(created_at);
"#;

/// 0017 · 个人知识库主体（modules/kb）。
///
/// 一张库装下多种来源：日程/附件、运动、饮食体测、方案/语音/聊天，AI 生成的长记忆也是其中一类
/// （source_type='memory'，见 0018）。三个设计取舍：
///
/// 1. `kb_docs.body` 存规范化的可检索正文快照。源表仍是唯一真源——每次脏标记重放都从源表重新
///    派生 body，所以它是缓存不是副本；换来的是检索不必 join 十一张源表、read 能直接取 L2 正文。
/// 2. `kb_fts` 用 external content 指回 kb_chunks，索引里不重复存正文（正文已在 kb_chunks.text），
///    代价是增删改必须走配套的三个维护触发器，不能手工双写。
/// 3. `tokenize='trigram'` 是为中文选的：FTS5 的 unicode61 会把整段中文当成一个 token，做不了子串
///    匹配；trigram 按三字滑动窗口切，不需要分词器即可子串检索。代价是**查询词少于 3 个字符命中
///    为空**，所以检索层对短词必须回落到 LIKE。
///
/// `kb_dirty` 是源表触发器（0019）与索引线程之间的队列，主键即去重——同一实体反复变更只会留一行。
/// `vec_model` 记录当前向量是哪个模型算的，换模型后据此只重算该模型的向量。
const MIGRATION_0017: &str = r#"
CREATE TABLE kb_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  occurred_on TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  meta_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  byte_len INTEGER NOT NULL DEFAULT 0,
  vec_model TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(source_type, source_id)
);
CREATE INDEX idx_kb_docs_src ON kb_docs(source_type, occurred_on);
CREATE INDEX idx_kb_docs_date ON kb_docs(occurred_on);

CREATE TABLE kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  UNIQUE(doc_id, ord)
);
CREATE INDEX idx_kb_chunks_doc ON kb_chunks(doc_id);

CREATE VIRTUAL TABLE kb_fts USING fts5(
  text,
  content='kb_chunks',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
  INSERT INTO kb_fts(kb_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
  INSERT INTO kb_fts(kb_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO kb_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE kb_vectors (
  chunk_id INTEGER PRIMARY KEY REFERENCES kb_chunks(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_kb_vectors_model ON kb_vectors(model_id);

CREATE TABLE kb_dirty (
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  op TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (source_type, source_id)
);

CREATE TABLE kb_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  embedding_mode TEXT NOT NULL DEFAULT 'keyword',
  cloud_base_url TEXT,
  cloud_api_key TEXT,
  cloud_model TEXT,
  cloud_dim INTEGER,
  sources_enabled TEXT NOT NULL DEFAULT '{}',
  auto_memory INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO kb_settings (id, updated_at) VALUES (1, datetime('now'));
"#;

/// 0018 · 知识库里的「认知」层：AI 从对话中提炼并持续合并的长期记忆。
///
/// 记忆不是独立系统，而是 kb_docs 的一类来源（source_type='memory'），这样它天然进入同一套检索与
/// 召回。这里额外保留一张变更审计表，对齐 OpenViking 的 memory_diff 思路：每次会话结束抽取出的
/// 增/改/删都留一份快照，记忆改错了可以回溯是被哪轮对话改的。
/// `UNIQUE(mem_type, topic, content)` 让重复抽取天然幂等。
const MIGRATION_0018: &str = r#"
CREATE TABLE kb_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mem_type TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  active_count INTEGER NOT NULL DEFAULT 0,
  source_chat_id TEXT,
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(mem_type, topic, content)
);
CREATE INDEX idx_kb_memories_type ON kb_memories(mem_type);

CREATE TABLE kb_memory_diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  at TEXT NOT NULL,
  ops_json TEXT NOT NULL
);
CREATE INDEX idx_kb_memory_diffs_at ON kb_memory_diffs(at);
"#;

/// 0019 · 源表变更捕获：让知识库「自动跟上」所有写入路径，包括未来新增的写法。
///
/// 用触发器而不是在各 command 里手写通知，是因为写入路径不止一处——program_schedule_replace 这类
/// 批量直写 todos、seed_foods 的 INSERT OR IGNORE、级联删除，走 command 层挂点必然会漏。
/// 触发器只写一行 kb_dirty（主键去重），开销极小；真正的分块与嵌入由索引线程异步消费。
///
/// foods 只在 is_custom=1 时登记：内置 2722 条种子每次启动都会 INSERT OR IGNORE，
/// 无条件登记会让首启入队整个食物库，而种子数据本就有 LCS 精确检索覆盖。
/// workout_sets 不单独成档，而是把父 workout 标脏——逐组明细是训练记录的组成部分。
const MIGRATION_0019: &str = r#"
CREATE TRIGGER kb_t_todos_ai AFTER INSERT ON todos BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('todo',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_todos_au AFTER UPDATE ON todos BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('todo',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_todos_ad AFTER DELETE ON todos BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('todo',CAST(OLD.id AS TEXT),'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_workouts_ai AFTER INSERT ON workouts BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('workout',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_workouts_au AFTER UPDATE ON workouts BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('workout',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_workouts_ad AFTER DELETE ON workouts BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('workout',CAST(OLD.id AS TEXT),'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_wsets_ai AFTER INSERT ON workout_sets BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('workout',CAST(NEW.workout_id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_wsets_au AFTER UPDATE ON workout_sets BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('workout',CAST(NEW.workout_id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_wsets_ad AFTER DELETE ON workout_sets BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('workout',CAST(OLD.workout_id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;

CREATE TRIGGER kb_t_plans_ai AFTER INSERT ON workout_plans BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('plan',NEW.id,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_plans_au AFTER UPDATE ON workout_plans BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('plan',NEW.id,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_plans_ad AFTER DELETE ON workout_plans BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('plan',OLD.id,'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_meals_ai AFTER INSERT ON meal_logs BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('meal',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_meals_au AFTER UPDATE ON meal_logs BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('meal',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_meals_ad AFTER DELETE ON meal_logs BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('meal',CAST(OLD.id AS TEXT),'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_metrics_ai AFTER INSERT ON body_metrics BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('body_metric',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_metrics_au AFTER UPDATE ON body_metrics BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('body_metric',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_metrics_ad AFTER DELETE ON body_metrics BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('body_metric',CAST(OLD.id AS TEXT),'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_foods_ai AFTER INSERT ON foods WHEN NEW.is_custom = 1 BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('food',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_foods_au AFTER UPDATE ON foods WHEN NEW.is_custom = 1 BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('food',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_foods_ad AFTER DELETE ON foods WHEN OLD.is_custom = 1 BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('food',CAST(OLD.id AS TEXT),'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_programs_ai AFTER INSERT ON programs BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('program',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_programs_au AFTER UPDATE ON programs BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('program',CAST(NEW.id AS TEXT),'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_programs_ad AFTER DELETE ON programs BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('program',CAST(OLD.id AS TEXT),'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_pmeals_ai AFTER INSERT ON program_meals BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('program_meal',CAST(NEW.program_id AS TEXT)||':'||NEW.date,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_pmeals_au AFTER UPDATE ON program_meals BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('program_meal',CAST(NEW.program_id AS TEXT)||':'||NEW.date,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_pmeals_ad AFTER DELETE ON program_meals BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('program_meal',CAST(OLD.program_id AS TEXT)||':'||OLD.date,'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_memos_ai AFTER INSERT ON voice_memos BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('voice_memo',NEW.id,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_memos_au AFTER UPDATE ON voice_memos BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('voice_memo',NEW.id,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_memos_ad AFTER DELETE ON voice_memos BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('voice_memo',OLD.id,'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;

CREATE TRIGGER kb_t_msgs_ai AFTER INSERT ON ai_chat_messages BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('chat_message',NEW.id,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_msgs_au AFTER UPDATE ON ai_chat_messages BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('chat_message',NEW.id,'upsert',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='upsert', at=excluded.at;
END;
CREATE TRIGGER kb_t_msgs_ad AFTER DELETE ON ai_chat_messages BEGIN
  INSERT INTO kb_dirty(source_type,source_id,op,at) VALUES('chat_message',OLD.id,'delete',datetime('now'))
  ON CONFLICT(source_type,source_id) DO UPDATE SET op='delete', at=excluded.at;
END;
"#;

/// 0020 · 虚拟文件系统（docs/kb-vfs.md）：给每篇文档一个稳定路径，并区分「可写/只读」。
///
/// 两条新增能力各需要一个存储位：
/// 1. `kb_docs.path` 把 11 类派生文档挂进同一棵路径树（`日程/…`、`对话/{chatId}/…`），
///    glob 检索与「按目录浏览」都建立在它上面。路径是**派生的**：源数据变了路径可能变，
///    文档身份始终是 (source_type, source_id)，所以改名/改标题不会丢编目。
/// 2. `kb_files` 是知识库里唯一的「真实文件」表——用户笔记与系统规范文件的正文真源。
///    它经 source_type='note' 派生进 kb_docs（body 是缓存），编辑走 kb_files 再标脏，
///    这样「kb_docs 一律是派生缓存」这条不变量对全库成立，重放永远能重建一切。
///
/// `editable` / `system` / `kind` 做成列而不是查询时推导：UI 与 AI 工具单次读取就能拿到，
/// 不必在每个调用点重复「哪些来源可写」的规则。
const MIGRATION_0020: &str = r#"
ALTER TABLE kb_docs ADD COLUMN path TEXT;
ALTER TABLE kb_docs ADD COLUMN editable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kb_docs ADD COLUMN system INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kb_docs ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
CREATE INDEX idx_kb_docs_path ON kb_docs(path);

CREATE TABLE kb_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL DEFAULT '',
  system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"#;

/// 0021 · 校园教务域（modules/campus）：把「学校教务系统的课表」落成可查询的本地快照，
/// 再把每个上课时段投影成 `todos` 行进入时间线。
///
/// 四张表是一条来源链：账号 → 学期 → 课程 → 上课时段。
/// - `campus_accounts`：一个（学校系统 × 服务地址 × 学号）三元组 = 一个账号。多账号并存，
///   靠 `active` 决定谁投影到时间线；`cookies` 是登录态真源（树维用 Cookie 会话而非 token）。
/// - `campus_semesters`：**`start_date` 是整条链路的锚点**——教务系统只给「第 N 教学周 + 星期几」，
///   必须靠学期起始日才能换算成公历日期，进而写进 `todos.date`。
/// - `campus_courses` / `campus_sessions`：课程与上课时段。一门课一周可能有多个时段
///   （不同星期/节次/教室），所以拆成两层。
///
/// `todos.course_session_id` 与既有的 `todos.program_id` 同构，都是「来源溯源列」：
/// 非空即表示这行是**派生只读投影**，用户不能在时间线上直接改删，只能通过重新同步更新。
/// 注意本库未对 `todos` 开外键级联，删账号时由命令显式清理派生行（见 campus/commands.rs）。
///
/// 刻意不给 campus_* 挂 kb_dirty 触发器：课表已通过 `todos` 间接进知识库，
/// 再挂一层只会让「18 门课 × 19 周」的噪音翻倍。
const MIGRATION_0021: &str = r#"
CREATE TABLE campus_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_kind TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  login_name  TEXT NOT NULL,
  password    TEXT,
  cookies     TEXT,
  session_at  TEXT,
  student_id  TEXT,
  student_code TEXT,
  student_name TEXT,
  department  TEXT,
  major       TEXT,
  adminclass  TEXT,
  grade       TEXT,
  total_credits REAL,
  save_password INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(base_url, login_name)
);

CREATE TABLE campus_semesters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES campus_accounts(id) ON DELETE CASCADE,
  remote_id   INTEGER NOT NULL,
  code TEXT,
  name TEXT,
  school_year TEXT,
  season TEXT,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  week_start_on_sunday INTEGER NOT NULL DEFAULT 0,
  total_weeks INTEGER NOT NULL DEFAULT 0,
  current_week INTEGER,
  is_current  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id, remote_id)
);
CREATE INDEX idx_campus_semesters_account ON campus_semesters(account_id);

CREATE TABLE campus_courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES campus_accounts(id) ON DELETE CASCADE,
  semester_id INTEGER NOT NULL REFERENCES campus_semesters(id) ON DELETE CASCADE,
  remote_lesson_id INTEGER NOT NULL,
  course_code TEXT,
  course_name TEXT NOT NULL,
  lesson_code TEXT,
  lesson_name TEXT,
  teachers TEXT,
  credits REAL,
  course_type TEXT,
  color TEXT,
  UNIQUE(account_id, semester_id, remote_lesson_id)
);
CREATE INDEX idx_campus_courses_semester ON campus_courses(semester_id);

CREATE TABLE campus_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES campus_accounts(id) ON DELETE CASCADE,
  semester_id INTEGER NOT NULL REFERENCES campus_semesters(id) ON DELETE CASCADE,
  course_id   INTEGER NOT NULL REFERENCES campus_courses(id) ON DELETE CASCADE,
  weekday     INTEGER NOT NULL,
  start_unit  INTEGER NOT NULL,
  end_unit    INTEGER NOT NULL,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  weeks       TEXT NOT NULL,
  weeks_str   TEXT,
  room TEXT,
  building TEXT,
  campus TEXT,
  UNIQUE(account_id, semester_id, course_id, weekday, start_unit, start_time)
);
CREATE INDEX idx_campus_sessions_semester ON campus_sessions(account_id, semester_id);
CREATE INDEX idx_campus_sessions_course ON campus_sessions(course_id);

ALTER TABLE todos ADD COLUMN course_session_id INTEGER REFERENCES campus_sessions(id);
CREATE INDEX idx_todos_course_session ON todos(course_session_id) WHERE course_session_id IS NOT NULL;
"#;

/// 0022 · 自动抢课的任务队列（`modules/campus/grab.rs`）。
///
/// 抢课是**跟时间赛跑**：窗口由教务处定时开放，开的瞬间几百人同时点。
/// 这类活儿必须落在进程内跑（页面切走、手机锁屏、WebView 被节流都不该影响它），
/// 所以任务队列要能扛住重启 —— 用户设好任务关掉 App，第二天开机它还得接着抢。
///
/// 这里**刻意冗余存了课名/课程号/教师/学分**（远端 `query-lesson` 也有）：
/// 抢课期间用户可能已经退出批次、教务可能已把课撤下，而任务单上总得有个名字给人看，
/// 不能因为源头查不到就变成一行 `lessonAssoc=317844`。
///
/// `window_wall` 存的是**教务墙钟时间文本**而不是换算后的本机时间戳：
/// 时钟偏差是运行时才测得准的量，落库时固定下来会在长时间等待（比如提前一晚设好）里跑偏。
const MIGRATION_0022: &str = r#"
CREATE TABLE campus_grab_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES campus_accounts(id) ON DELETE CASCADE,
  turn_id     TEXT NOT NULL,
  turn_name   TEXT,
  lesson_id   TEXT NOT NULL,
  lesson_name TEXT,
  course_name TEXT,
  course_code TEXT,
  teacher     TEXT,
  credits     REAL,
  mode        TEXT NOT NULL DEFAULT 'predicate',
  virtual_cost INTEGER,
  schedule_group_id TEXT,
  window_wall TEXT,
  window_end_wall TEXT,
  await_window INTEGER NOT NULL DEFAULT 0,
  predicate_done INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'waiting',
  phase       TEXT NOT NULL DEFAULT 'idle',
  attempts    INTEGER NOT NULL DEFAULT 0,
  polls       INTEGER NOT NULL DEFAULT 0,
  strikes     INTEGER NOT NULL DEFAULT 0,
  strike_kind TEXT,
  request_id  TEXT,
  last_message TEXT,
  next_at     INTEGER NOT NULL DEFAULT 0,
  queued_at   INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER
);
CREATE INDEX idx_campus_grab_account ON campus_grab_tasks(account_id, status);
CREATE INDEX idx_campus_grab_due ON campus_grab_tasks(status, next_at);
"#;

/// 0023 · 抢课任务补一列「进批次拿到的批次 id」。
///
/// SPA 提交时用的 `courseSelectTurnAssoc` 取的是
/// `{studentId}/turn/{turnId}/select` 返回的批次 id —— **实测（2026-09-21 窗口开放）
/// 它在顶层 `turn.id`**（`options.turn.id` 不存在），而这次它与列表里的 `turnId` 相等
/// （1921 = 1921）。相等与否**没有保证**，所以两者都留着：路径参数继续用列表 id，
/// 提交体用这一列，拿不到时退回列表 id。
const MIGRATION_0023: &str = r#"
ALTER TABLE campus_grab_tasks ADD COLUMN turn_assoc TEXT;
"#;

/// 0024 · AI 虚拟工作区 v2（规范见 docs/ai-workspace.md）。
///
/// 三块：
/// 1. `kb_files` 扩展成「文件节点」：`kind` 区分 文本 / 多模态 / 目录；`pinned` 让用户把手动
///    归类钉住（钉住后 AI 不再自动移动）；`classify_state` 记录归类状态（inbox/filed/manual）。
/// 2. `kb_assets` 模态表示层：一个逻辑文件可有多种模态（文本/音频/视频/图片/二进制），
///    本体一律**引用**（fs 落盘相对路径或 inline 文本），绝不把 base64 灌进索引正文。
/// 3. `kb_fs_moves`：AI/用户的一切目录整理都留审计，可按 batch 整批撤销。
const MIGRATION_0024: &str = r#"
ALTER TABLE kb_files ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE kb_files ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kb_files ADD COLUMN classify_state TEXT NOT NULL DEFAULT 'manual';

CREATE TABLE kb_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES kb_files(id) ON DELETE CASCADE,
  modal TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  storage TEXT NOT NULL DEFAULT 'inline',
  ref TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  transcript_state TEXT NOT NULL DEFAULT 'none',
  derived_from TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(file_id, modal, ref)
);
CREATE INDEX idx_kb_assets_file ON kb_assets(file_id);

CREATE TABLE kb_fs_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ai',
  op TEXT NOT NULL,
  path_from TEXT NOT NULL DEFAULT '',
  path_to TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now')),
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_kb_fs_moves_batch ON kb_fs_moves(batch_id);
CREATE INDEX idx_kb_fs_moves_at ON kb_fs_moves(at);
"#;

/// 0025 · 动作库（规范见 docs/ARCHITECTURE.md §4）。
///
/// 全部运动动作的唯一真源：内置动作来自种子 `resources/exercises.json`
/// （`is_custom=0`，只读、每次启动覆盖式刷新内容、用户只能隐藏）；
/// 用户自建动作 `is_custom=1`，可改可删。课程条目以 `exerciseId` 引用本表，
/// 重量曲线以 `workout_sets.exercise_id` 聚合。
///
/// `workout_sets.exercise_id` **刻意不加外键**：自建动作删除后历史做组记录必须
/// 保留（曲线仍可回看），展示回落 `exercise_name` 快照。
const MIGRATION_0025: &str = r#"
CREATE TABLE exercises (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'strength',
  category TEXT NOT NULL DEFAULT 'other',
  equipment TEXT,
  muscles TEXT NOT NULL DEFAULT '{}',
  tips TEXT NOT NULL DEFAULT '',
  default_sets INTEGER NOT NULL DEFAULT 3,
  default_reps INTEGER,
  default_weight_kg REAL,
  default_target_sec INTEGER,
  default_duration_min INTEGER,
  default_rest_sec INTEGER NOT NULL DEFAULT 90,
  weight_step REAL NOT NULL DEFAULT 2.5,
  is_custom INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_exercises_browse ON exercises(kind, category);

ALTER TABLE workout_sets ADD COLUMN exercise_id TEXT;
CREATE INDEX idx_sets_exercise ON workout_sets(exercise_id, workout_id);
"#;

/// 0026 · Rein 在线服务：模型来源标记 + 本机成本账本。
///
/// 两件事：
/// 1. `ai_models` 增加来源与计价列。`source='online'` 表示这条模型是从 Rein 在线服务
///    **由服务端下发**导入的：模型清单、单价、流量单价都以服务端为准，重新同步时按
///    (service_base, model_id) 覆盖，用户不必也不该手填模型 ID。手动添加的模型
///    （BYOK）保留旧的自由填写，单价可空 —— 空即成本为 0。
/// 2. `ai_usage` 是本机口径的成本账本：每轮对话一行，模型费 + 流量费分开记。
///    金额一律**纳元（1e-9 元）整数**：单次请求的出方向流量费常在 1e-7 元量级，
///    用分/微元记账会在逐笔取整时被抹成 0，「服务器流量 0.8 元/GB」就永远不显示。
///
/// `model_pk` 刻意不加外键：模型删了账不能丢（否则用户删掉一条模型，历史花费凭空消失）。
const MIGRATION_0026: &str = r#"
ALTER TABLE ai_models ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE ai_models ADD COLUMN service_base TEXT;
ALTER TABLE ai_models ADD COLUMN price_in REAL;
ALTER TABLE ai_models ADD COLUMN price_out REAL;
ALTER TABLE ai_models ADD COLUMN price_currency TEXT;
ALTER TABLE ai_models ADD COLUMN traffic_per_gb REAL;
CREATE UNIQUE INDEX idx_ai_models_online ON ai_models(service_base, model_id) WHERE source = 'online';

CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  chat_id TEXT,
  model_pk INTEGER,
  model_name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'openai-compatible',
  source TEXT NOT NULL DEFAULT 'manual',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  request_bytes INTEGER NOT NULL DEFAULT 0,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  -- 纳元（1e-9 元）
  cost_model_nano INTEGER NOT NULL DEFAULT 0,
  cost_traffic_nano INTEGER NOT NULL DEFAULT 0,
  cost_total_nano INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  note TEXT
);
CREATE INDEX idx_ai_usage_ts ON ai_usage(ts);
CREATE INDEX idx_ai_usage_model ON ai_usage(model_pk);
"#;

/// 0027 · 抢课任务加「志愿组」。
///
/// 互斥志愿组：同组课程是**备选**（时间冲突 / 只能选一门），只会中一个。
/// `priority` 0 = 独立任务（不参与任何组，行为与加这几列之前完全一致）。
///
/// 组名冗余存在任务行上，与「刻意冗余存课名/教师」同一规矩：省掉一张组表与一组组命令，
/// 而组名本来也只是给人看的。`group_key` 由前端 `crypto.randomUUID()` 生成。
///
/// `stuck_since` 只服务于「让贤期限」：记下**从什么时候起一直在满员**。
/// 让贤期限设成 0（死守，默认）时它永远不被读；设成 >0 时用它决定何时轮到下一志愿。
const MIGRATION_0027: &str = r#"
ALTER TABLE campus_grab_tasks ADD COLUMN group_key TEXT;
ALTER TABLE campus_grab_tasks ADD COLUMN group_name TEXT;
ALTER TABLE campus_grab_tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campus_grab_tasks ADD COLUMN stuck_since INTEGER;
"#;

/// 0028 · 记忆的生命周期：衰减排序、自动归档、分类层级与「做梦」整理。
///
/// 0018 的记忆表只有「抽取 + 合并」，没有生命周期——只增不减，噪音迟早淹没注入窗口。这里补上：
///
/// - `last_used_at`：最近一次被注入（用到）的时间。显著性 = 置信度 × 时间衰减 × 使用强化，
///   排序据此从「三列硬拼」升级为连续分数（memory.rs::salience_of）。
/// - `archived_at` / `archived_reason`：归档是**软删除**——长期闲置且低显著性的记忆退出
///   注入与检索两条链路，但仍在库里可恢复；再次被提及（update / 重复 add）会自动复活。
/// - `category`：分层分类路径（如 `健康/训练`），路径变成 `记忆/{类型}/{分类}/{主题}-{id}.md`。
/// - `auto_consolidate` / `last_consolidate_at`：周期性的 LLM 整理任务（合并重叠、统一分类、
///   校准置信度、归档噪声）的开关与节流时间。`last_maintain_at` 记录本地无模型维护的上次时间。
const MIGRATION_0028: &str = r#"
ALTER TABLE kb_memories ADD COLUMN category TEXT NOT NULL DEFAULT '';
ALTER TABLE kb_memories ADD COLUMN last_used_at TEXT;
ALTER TABLE kb_memories ADD COLUMN archived_at TEXT;
ALTER TABLE kb_memories ADD COLUMN archived_reason TEXT;
CREATE INDEX idx_kb_memories_archived ON kb_memories(archived_at);
ALTER TABLE kb_settings ADD COLUMN auto_consolidate INTEGER NOT NULL DEFAULT 1;
ALTER TABLE kb_settings ADD COLUMN last_consolidate_at TEXT;
ALTER TABLE kb_settings ADD COLUMN last_maintain_at TEXT;
"#;

/// 0029 · 抢课计划（意向）：把「我想抢什么」提前写下来，由引擎在能看见教学班时解析成具体任务。
///
/// 与 `campus_grab_tasks` 分开建表而不是往任务表里塞一行 `lesson_id = NULL`：
/// 任务表的每一行都必须是**可提交的**（有教学班、有批次、有窗口），而计划恰恰在
/// 「还不知道要抢哪个班」的时候存在 —— 两者的生命周期与不变量都不一样。
/// 计划解析成功后生成的仍是普通任务行（`group_key` 把一组任务归到计划名下）。
const MIGRATION_0029: &str = r#"
CREATE TABLE campus_grab_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES campus_accounts(id) ON DELETE CASCADE,
  turn_id TEXT,
  turn_name TEXT,
  query       TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'predicate',
  spread      INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending',
  group_keys  TEXT NOT NULL DEFAULT '[]',
  candidates  TEXT NOT NULL DEFAULT '[]',
  last_message TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX idx_campus_grab_intents ON campus_grab_intents(account_id, status, next_at);
"#;

/// 0030 · AI 救援审计：AI 对教务/抢课引擎做过的每一件事。
///
/// 为什么要单独一张表，而不是复用 `app_meta` 或干脆不记：
/// 写操作是不弹确认的（抢课窗口里每一次确认都是拖延），那份信任必须由「事后能一条条查、
/// 且每条都能重放」来兜底。`curl` 一列同时喂三个消费方 —— 界面上的操作记录、
/// 导出给人手动跑的救援脚本、以及熔断（`fp` 上的计数）。
///
/// `fp` 是请求指纹（方法+地址+正文的哈希）：**不含凭据**。同一个请求换个 Cookie
/// 还是同一条请求，熔断判据不能被「会话刷新」这件事绕过去。
/// `account_id` 刻意不设外键：删号不该带走「AI 当时做了什么」这段历史。
const MIGRATION_0030: &str = r#"
CREATE TABLE campus_ai_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  curl TEXT,
  fp TEXT,
  status TEXT NOT NULL,
  account_id INTEGER
);
CREATE INDEX idx_campus_ai_actions_at ON campus_ai_actions(at DESC);
CREATE INDEX idx_campus_ai_actions_fp ON campus_ai_actions(fp, at);
"#;

/// 「抢课时两个域都发」在任务上的落点：**第二条受理号**。
///
/// 为什么单开一列而不是复用 request_id：两个域是**两套系统**，各自有自己的受理号，
/// 两条单子都要能查结果 —— 只留一条的话，另一条就成了「发出去了但没人管」的悬空请求，
/// 而它可能恰恰是抢到课的那一条。
const MIGRATION_0031: &str = r#"
ALTER TABLE campus_grab_tasks ADD COLUMN mirror_request_id TEXT;
"#;

/// 0032 · 受理单**属于哪个域**（`mirror` = 镜像域；NULL/其余 = 主域）。
///
/// 为什么必须记下来：两个域是两套系统，受理号**不能跨域查询**。主域被拒、
/// 镜像域受理成功时（`submit_both` 的 `(true, false)` 分支），受理号被当成主域的号
/// 去轮询 —— 查不到、空转到上限、被当成「结果不明」重投，而真正的结果就在镜像域上
/// 没人看。这一列把「拿谁的号去问谁」这件事落成数据。
const MIGRATION_0032: &str = r#"
ALTER TABLE campus_grab_tasks ADD COLUMN request_domain TEXT;
"#;

/// 0033 · 动作库两件用户态/内容列：
///
/// 1. `favorite`：用户收藏（动作库置顶与筛选）。它是**用户态**，与 `hidden` 一样
///    不能被启动时的种子刷新覆盖 —— 见 `seed::seed_exercises` 的 ON CONFLICT 列表。
/// 2. `steps`：动作要领（分步说明，JSON 字符串数组）。它是**内容列**，随种子刷新。
const MIGRATION_0033: &str = r#"
ALTER TABLE exercises ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE exercises ADD COLUMN steps TEXT NOT NULL DEFAULT '[]';
"#;

/// 0034 · 多设备同步的地基（见 `modules/sync`）。
///
/// 同步要解决的两件事都在这里落成数据：
/// 1. **对象身份**：业务表的自增主键只在本地有效，两台设备各自 `INSERT` 必然撞号，
///    所以每行在 `sync_map` 里挂一个 uuid —— uuid 才是跨设备的身份，本地 id 只是别名。
/// 2. **删除**：业务表是硬删（没有 `deleted` 列），删掉的行没有任何痕迹可传播，
///    所以删除要留**墓碑**（`sync_objects.deleted = 1`）。
///
/// `sync_log` 是复制日志：本机改动与「应用来的远端改动」都追加一行，对端游标 = 已确认
/// 的 seq。多设备（A→B→C）靠它转传，也让「传到一半断了」能续。
const MIGRATION_0034: &str = r#"
CREATE TABLE sync_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE sync_objects (
  uuid    TEXT PRIMARY KEY,
  kind    TEXT NOT NULL,
  hlc     INTEGER NOT NULL,
  device  TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  blob    TEXT NOT NULL
);
CREATE INDEX sync_objects_hlc ON sync_objects(hlc, device);
CREATE INDEX sync_objects_kind ON sync_objects(kind);

CREATE TABLE sync_map (
  kind     TEXT NOT NULL,
  local_id TEXT NOT NULL,
  uuid     TEXT NOT NULL,
  PRIMARY KEY (kind, local_id)
);
CREATE INDEX sync_map_uuid ON sync_map(uuid);

CREATE TABLE sync_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL,
  hlc  INTEGER NOT NULL
);

CREATE TABLE sync_peers (
  device        TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  x25519_pub    TEXT NOT NULL,
  group_id      TEXT NOT NULL,
  last_seq_sent INTEGER NOT NULL DEFAULT 0,
  last_seq_ack  INTEGER NOT NULL DEFAULT 0,
  last_seen     INTEGER,
  path          TEXT
);

CREATE TABLE sync_conflicts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  kept_hlc  INTEGER NOT NULL,
  lost_hlc  INTEGER NOT NULL,
  lost_blob TEXT NOT NULL,
  at        INTEGER NOT NULL
);

CREATE TABLE sync_blobs (
  hash       TEXT PRIMARY KEY,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
"#;

/// 0035 · 手动补录的「体感强度」列。
///
/// 背景：手动补录这条路拿不到任何客观强度信号（没有配速、没有逐组重量），
/// 过去靠让用户自选「低/中/高强度」来喂 MET —— 但那要求用户先知道自己的 MET 档，
/// 于是绝大多数人一律选中间那档，估算值看起来有数字、实际没有信息。
/// 改问「这次累不累」（1–5，存本列），由前端折算 MET 档（`effort_to_intensity`）。
///
/// 为什么不改 `intensity` 列本身：它是 `TEXT NOT NULL DEFAULT 'moderate'`，
/// 且 `workout_sets` 与同步表都按现有形状依赖它。**加列**才是无破坏的那条路 ——
/// `intensity` 继续由前端从 effort 派生写入（课程/跑步路径则是客观反推的真档位），
/// 于是老代码与知识库派生照旧能读，读到的值对新记录而言已是派生结果。
const MIGRATION_0035: &str = r#"
ALTER TABLE workouts ADD COLUMN effort INTEGER;
"#;

/// 第三方健康数据接入（Health Connect）· 见 modules/healthsync。
///
/// 为什么加在 `workouts` 上而不是另立一张导入表：运动记录在 Rein 里已经有
/// 唯一的读取路径（课表/主页/统计都查 `workouts`），导入的记录必须和本地补录
/// 的一样出现在这些地方 —— 另立表就意味着每一处读取都要 UNION 一次。
/// 区别只在于「谁说了算」，而那恰好就是 `source` 这一个字段的语义。
///
/// - `source`：`local` = Rein 自建（含本机补录、课程、跑步），**唯一权威在本机**；
///   `health_connect` = 从系统 Health Connect 导入的**镜像**，权威在 HC 侧 ——
///   每次同步按 HC 的记录覆盖更新，HC 里没了就跟着删。
/// - `external_id`：HC 记录的 `metadata.id`（UUID）。导入记录必填；本地记录
///   被导出到 HC 后回填（于是删除本地记录时能顺手收掉 HC 侧那份）。
///   唯一索引让「同一台设备重复导入」天然幂等；跨设备靠 sync 表登记的业务键合并
///   （见 modules/sync/tables.rs 的 workouts.natural）。
/// - `external_updated_at`：HC 侧 `metadata.lastModifiedTime`。变化判定用它 ——
///   比逐个字段比对更准（用户可能在小米运动健康里只改了备注），也避免每次同步
///   都把整表重写一遍。
/// - `external_fingerprint`：**导出方向**的变化判定。导入方向有 `lastModifiedTime`
///   可依，回写方向没有 —— 本机 `workouts` 表压根不记「最后修改时间」。
///   所以导出时把「写进 HC 的那几个字段」拼成一个可读字符串存下来，
///   下次同步比对它就知道本地改没改过（选字符串而不是哈希：跨版本稳定，
///   且出问题时肉眼能看出差异在哪一段）。
///
/// 导出开关与上次同步时间放 `app_meta`（键 `health_sync.*`），不另立状态表 ——
/// 那是设备级的东西（授权本来就跟设备走），而 `app_meta` 恰好不参与多设备同步，
/// 且已有 `meta_get`/`meta_set` 这一份唯一的读写实现，没必要为两个键再抄一遍。
///
/// 墓碑表**也不参与多设备同步**（未登记进 sync/tables.rs 白名单）：
/// 它是「本机删掉的导入记录别被下次同步拉回来」的本地账。
/// 也就是说：跨设备删除传播到 Health Connect 这件事，本期不做。
const MIGRATION_0036: &str = r#"
ALTER TABLE workouts ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
ALTER TABLE workouts ADD COLUMN external_id TEXT;
ALTER TABLE workouts ADD COLUMN external_updated_at TEXT;
ALTER TABLE workouts ADD COLUMN external_fingerprint TEXT;
CREATE UNIQUE INDEX idx_workouts_external_id ON workouts(external_id) WHERE external_id IS NOT NULL;
CREATE TABLE health_sync_tombstones (
  external_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);
"#;

/// 0037 · 第三方体征指标镜像：Health Connect 按天聚合值的本地落点
/// （步数 / 睡眠 / 体重 / 体脂 / 静息心率 / HRV / 血氧 / 血压 …，
/// 指标 id 由 Kotlin 桥产出、前端 `src/config/healthMetrics.ts` 解读，三方同名）。
///
/// 每次**同步整表替换**而不是增量合并：Kotlin 每轮都全窗口（90 天）重读，
/// 收到的集合本身就是 HC 侧「现在该有什么」的完整答案 —— 直接替换，
/// 撤销授权的那组、用户在 HC 里删掉的某天数据，下一次同步自然消失。
///
/// 这张表是**设备本地镜像**（与 0036 的墓碑同理，不进 sync/tables.rs 白名单）：
/// 只服务预览与将来的健康状态计算，刻意不碰用户手填的 body_metrics/profile
/// —— 自动覆写用户自己记的体重，等于替用户改了账。
const MIGRATION_0037: &str = r#"
CREATE TABLE health_metrics (
  metric TEXT NOT NULL,
  day TEXT NOT NULL,
  value REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (metric, day)
);
CREATE INDEX idx_health_metrics_day ON health_metrics(day);
"#;

/// 0038 · 本地嵌入模型可选化（modules/kb/embed_models.rs）。
///
/// `local_model` 存注册表里的模型 id（默认即内置那颗）。老库升级后落在内置模型上，
/// 与升级前的行为一致（升级前也只可能有内置模型），所以这条不需要清向量。
const MIGRATION_0038: &str = r#"
ALTER TABLE kb_settings ADD COLUMN local_model TEXT NOT NULL DEFAULT 'bge-small-zh-v1.5-int8';
"#;

/// 0039 · 工作区回收站（modules/kb/files.rs）。
///
/// 删除默认不再是物理删除：`trashed_at` 非空即进了回收站，`trash_from` 记住原路径供恢复。
/// 行本身被移到 `回收站/{span id}/{原相对路径}` 命名空间下——`kb_files.path` 是 UNIQUE，
/// 不腾走原路径就没法在同一个位置新建同名文件。
///
/// 「看不见」由查询层保证：派生（source.rs）、索引对账（index.rs）、注入区与目录列举
/// 一律过滤 `trashed_at IS NULL`，AI 与检索都看不到回收站里的东西。
const MIGRATION_0039: &str = r#"
ALTER TABLE kb_files ADD COLUMN trashed_at TEXT;
ALTER TABLE kb_files ADD COLUMN trash_from TEXT;
CREATE INDEX idx_kb_files_trash ON kb_files(trashed_at);
"#;

/// 0040 · 提供商（供应商）账号与其模型目录（modules/ai/providers.rs）。
///
/// 一个「提供商」= 适配器 + 凭据 + 接入方式；`ai_provider_models` 存拉到的模型目录
/// （origin 记来源：api = /models 接口拉到，preset = 适配器内置参考，manual = 手填）。
/// 目录本身不重复存密钥——密钥在 `ai_providers.api_key`，启用模型时再落到
/// `ai_models`（LLM）/ 语音配置（ASR）/ 知识库设置（向量）。
const MIGRATION_0040: &str = r#"
CREATE TABLE ai_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 适配器 id（deepseek | volc-ark | dashscope | siliconflow | openai-compatible）
  adapter TEXT NOT NULL,
  -- 昵称：模型名前缀与折叠分组都用它
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  -- 接入方式（适配器内的 style id，如方舟的 ark / agent-plan）
  api_style TEXT NOT NULL DEFAULT '',
  -- 适配器专属字段的 JSON（如豆包语音的 appId / accessToken）
  extra TEXT,
  last_error TEXT,
  last_sync_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_ai_providers_adapter_base ON ai_providers(adapter, base_url);

CREATE TABLE ai_provider_models (
  provider_id INTEGER NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  -- llm | vision | asr | embedding | tts
  kind TEXT NOT NULL,
  -- api | preset | manual
  origin TEXT NOT NULL DEFAULT 'api',
  -- 附加元信息 JSON（维度、单价、说明…）
  meta TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);
CREATE INDEX idx_ai_provider_models_kind ON ai_provider_models(provider_id, kind);
"#;

/// 0041 · 文件元数据：评分 / 标签 / 注释（modules/kb/files.rs）。
///
/// 三样都存在 `kb_files` 行上（不进 `kb_docs`）：它们是**用户给文件加的话**，
/// 不是内容的一部分 —— 不喂给索引，避免「标签里的词把语义带偏」。
/// 评分 0 = 未评（0..5）；标签是 JSON 数组字符串；注释是自由文本。
const MIGRATION_0041: &str = r#"
ALTER TABLE kb_files ADD COLUMN rating INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kb_files ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE kb_files ADD COLUMN note TEXT NOT NULL DEFAULT '';
"#;

/// 0042 · 对外服务网关的凭据与审计（contract `docs/EXTERNAL-API.md` §6.5，见 modules/gateway）。
///
/// `ext_clients` 是「外部客户端 × 本机授权」的唯一真源。几处刻意设计：
///
/// - `token_hash` 只存 `sha256(token)` 的 hex，**明文令牌永不落库**（与 `ai_models.api_key`、
///   同步 `identity` 私钥同一条纪律：库里只有派生值）。NULL 表示还没「始终允许」过。
/// - `decision` 是这台客户端当前的授权结论。`allow` = 始终允许（带 `scopes`、带 `token_hash`）；
///   `deny` = 用户拒绝过（设置页删掉这行即回到无记录）；`ignore` = 只留限频痕迹、**无任何授权**
///   （用户点了「忽略」）—— 读授权时一律只认 `allow`，`ignore` 与 `deny` 一样不可放行。
///   之所以给「忽略」留一行而不是只放内存：30s 静默窗口与「连续 3 次后静默挂起」要跨重连生效，
///   而这些计数天然属于这台客户端的持久记录（`last_prompt_at` / `prompt_count`）。
/// - `revoked_at` 用置位而不是删行：撤销后审计仍能对上 client_id，设置页也能显示「已撤销」。
/// - `scopes` 是 JSON 字符串数组（如 `["schedule.read"]`），精确匹配、无通配。
///
/// `ext_audit` 刻意**不设外键**：删客户端不带走「它当时做了什么」的历史
/// （先例见 0030 `campus_ai_actions`、0026 `ai_usage`）。
///
/// 两张表都**不进** `sync/tables.rs` 白名单：把凭据复制到第二台设备是一个安全决定，
/// 不该由同步默认替用户做（先例：`campus_accounts`、`ai_models.api_key`）。
/// `enabled` / `bindMode` / `port` / `gateway.pairToken` 走 `app_meta`，不另立状态表
/// （先例见 0036 注释；`app_meta` 不参与多设备同步）。
const MIGRATION_0042: &str = r#"
CREATE TABLE ext_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  token_hash TEXT,                          -- sha256(token) hex；NULL 直到「始终允许」签发
  scopes TEXT NOT NULL DEFAULT '[]',        -- JSON 数组，如 ["schedule.read","workout.read"]
  decision TEXT NOT NULL,                   -- allow | deny | ignore（ignore = 只留限频记录，无授权）
  last_ip TEXT, last_seen_at TEXT,
  created_at TEXT NOT NULL, decided_at TEXT, updated_at TEXT NOT NULL, revoked_at TEXT,
  last_prompt_at TEXT, prompt_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE ext_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, client_id TEXT,         -- 无外键：删客户端不带走历史
  method TEXT NOT NULL, scope TEXT NOT NULL,
  decision TEXT NOT NULL,
  detail TEXT, ip TEXT, duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ext_audit_at ON ext_audit(at DESC);
"#;

/// 0043 · 审计表按客户端查询的索引（contract `docs/EXTERNAL-API.md` §6.5 / §17.4）。
///
/// `gateway_audit_recent(clientId)` 的 `list_audit_for_client` 按 `client_id` 取该客户端的
/// 历史，没有这条复合索引时退化为全表扫描 + 排序，而这查询跑在唯一那把 DB 锁内 ——
/// 审计增长后会顶到 §6.4 的 2000ms 查询预算。历史条目 0042 不改（永不改历史迁移）。
const MIGRATION_0043: &str = r#"
CREATE INDEX idx_ext_audit_client ON ext_audit(client_id, at DESC);
"#;

/// 0044 · 重复待办的**除外日期**：挂在模板行上的 JSON 数组（"YYYY-MM-DD"），
/// 记「用户删掉了这一次」。
///
/// 没有它，删一条重复实例会被下一次 `sync_recurrences` 按规则原样补回来 ——
/// 用户看到的就是「待办删不掉」（实例存在性只看 rec_key，删除不改变规则）。
/// 不是对外暴露列（不在 `todo::commands::COLS` 里）：实例物化时读它，
/// 前端的全量更新不写它，于是删过的日子不会因为一次编辑又被翻回来。
const MIGRATION_0044: &str = r#"
ALTER TABLE todos ADD COLUMN rec_exdates TEXT;
"#;

/// 0045 · 学校公布的**节次时间表**（第 N 节 → 起止时刻），按「账号 × 学期」存。
///
/// 为什么要落库：正方教务把这张表单独开了一个接口（`/kbcx/xskbcx_cxRjc.html`），
/// 而课表正文只给节次号 —— 少了它，左侧时间轴只能按「每次课的封套」画
/// （第1-2节 08:00-09:25），画不出图里那种逐节真读数（第1节 08:00-08:40）。
/// 抓取落在同步里（联网），读课表那条路上不许再发请求，所以必须持久化。
///
/// 学期级配置而非逐条业务记录：同步时**整学期替换**（作息改了旧行留一半会出现
/// 「第3节有两个时刻」）。树维那套系统没有这张表，那张表就是空的 —— 轴自动退化为
/// 按实际排课区间切出的互斥片段，两者共用同一条渲染路径。
const MIGRATION_0045: &str = r#"
CREATE TABLE campus_period_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES campus_accounts(id) ON DELETE CASCADE,
  semester_id INTEGER NOT NULL REFERENCES campus_semesters(id) ON DELETE CASCADE,
  unit       INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL,
  UNIQUE(account_id, semester_id, unit)
);
CREATE INDEX idx_campus_period_slots_semester ON campus_period_slots(account_id, semester_id);
"#;

/// 0046 · 旧重复待办清理（一次性数据修复）。
///
/// 背景：智能添加抽屉的「编辑细节」曾恒以新建模式打开编辑器（`:todo="null"`），
/// 一条 AI 草稿「添加」后再点铅笔调整并保存就会按同样字段再落一条；连点「保存」/「添加」
/// 也会重复落库。前端那两处已修（重入锁 + 落库后走更新），这里把**已经落下的**重复行清掉。
///
/// 判重口径 = 列表里看起来一模一样的那几列：标题 / 日期 / 开始时间 / 时长 / 分类 /
/// 优先级 / 备注（`IS` 比较，NULL 当相等）。只动**用户自建行**，三类来源行一律不碰：
/// - 课表派生行（`course_session_id` 非空）归 `materialize_todos` 的先删后建管；
/// - 方案行（`program_id` 非空）归 `program_schedule_replace` 管；
/// - 重复实例（`rec_key` 非空）本就有唯一索引（0011）。
///
/// 保留策略：同一组里**优先保留已完成的那条**（不丢用户打过的卡），否则保留最早一条（最小 id）。
///
/// 已知边界：迁移早于同步钩子安装（`sync/engine.rs::install_hook`），这里的 DELETE 不进复制日志、
/// 不留墓碑 —— 单机场景没有影响；开了多设备同步的，需要对端也升到本版本，各自清一遍。
const MIGRATION_0046: &str = r#"
DELETE FROM todos
WHERE course_session_id IS NULL
  AND program_id IS NULL
  AND rec_key IS NULL
  AND id NOT IN (
    SELECT (
      SELECT k.id FROM todos k
      WHERE k.course_session_id IS NULL
        AND k.program_id IS NULL
        AND k.rec_key IS NULL
        AND k.title        IS g.title
        AND k.date         IS g.date
        AND k.start_min    IS g.start_min
        AND k.duration_min IS g.duration_min
        AND k.category     IS g.category
        AND k.priority     IS g.priority
        AND k.notes        IS g.notes
      ORDER BY (k.status = 'done') DESC, k.id ASC
      LIMIT 1
    )
    FROM todos g
    WHERE g.course_session_id IS NULL
      AND g.program_id IS NULL
      AND g.rec_key IS NULL
    GROUP BY g.title, g.date, g.start_min, g.duration_min, g.category, g.priority, g.notes
  );
"#;

/// 0047 · 重复实例的 `rec_key` 改成**身份列**（结构性护栏，治一类反复出现的缺陷）。
///
/// 事故形状（2026-10，已出现多次、每次都以「勾一下多出一条」收场）：
/// 勾选一条重复待办的实例 → 前端把**整个对象**回写 → `update_todo_on` 当时按
/// 「这一行有没有 rec_rule」决定 rec_key，而实例没有规则 ⇒ 写成 NULL ⇒ 下一次
/// `sync_recurrences` 再也认不出它 ⇒ 按模板补建一条 ⇒ 屏幕上多出一条一模一样的待办。
///
/// 为什么不在 `update_todo_on` 里加个 if 了事：那是治这一次。写 `todos` 的原生 SQL
/// 有三十多处（方案、课表派生、同步引擎、网关、KB 索引、测试夹具），任何一个模块
/// 只要「整对象覆盖」就会再踩一遍。把**身份**立成数据库不变量，是唯一能覆盖全部写入方的位置。
///
/// 两条动作：
/// 1. **一次性修复**历史脏数据：按「内容 + 日期」分组，组内只有一个真实身份（rec_key）
///    却有多行时，只留一行（优先留已完成的 —— 那是用户真的点过的那条），并把身份认回去。
///    组里出现两个不同身份说明那是两条合法实例，一律不动。
/// 2. **立触发器**：`rec_key` 一旦非空就不许改、不许清空。唯一例外是模板行随自己的
///    日期一起移动（「模板 = 首日实例」这条不变量要跟着日期走）。
const MIGRATION_0047: &str = r#"
-- ── 1) 历史修复：合并「身份被写成 NULL 的实例」与它的孪生行 ─────────────────────
-- 分组键 = 列表里看起来一模一样的那几列（同 0046 的口径，NULL 当相等）。
CREATE TEMP TABLE _rec_twin AS
SELECT g.title AS title, g.date AS date, g.start_min AS start_min,
       g.category AS category, g.priority AS priority, g.notes AS notes,
       MIN(g.rec_key) AS rk
FROM todos g
WHERE g.course_session_id IS NULL
  AND g.program_id IS NULL
  AND g.date IS NOT NULL
GROUP BY g.title, g.date, g.start_min, g.category, g.priority, g.notes
HAVING COUNT(DISTINCT g.rec_key) = 1 AND COUNT(*) > 1;

-- 保留策略与 0046 一致：优先留已完成（用户打过卡的那条），否则留最早一条。
CREATE TEMP TABLE _rec_drop AS
SELECT id FROM (
  SELECT t.id,
         ROW_NUMBER() OVER (
           PARTITION BY w.title, w.date, w.start_min, w.category, w.priority, w.notes
           ORDER BY (t.status = 'done') DESC, t.id ASC
         ) AS rn
  FROM todos t
  JOIN _rec_twin w
    ON w.title      IS t.title
   AND w.date       IS t.date
   AND w.start_min  IS t.start_min
   AND w.category   IS t.category
   AND w.priority   IS t.priority
   AND w.notes      IS t.notes
) WHERE rn > 1;

DELETE FROM todos WHERE id IN (SELECT id FROM _rec_drop);

-- 幸存行的身份认回来（此刻孪生行已删，不会撞 0011 的唯一索引）
UPDATE todos
SET rec_key = (
  SELECT w.rk FROM _rec_twin w
  WHERE w.title     IS todos.title
    AND w.date      IS todos.date
    AND w.start_min IS todos.start_min
    AND w.category  IS todos.category
    AND w.priority  IS todos.priority
    AND w.notes     IS todos.notes
)
WHERE rec_key IS NULL
  AND EXISTS (
    SELECT 1 FROM _rec_twin w
    WHERE w.title     IS todos.title
      AND w.date      IS todos.date
      AND w.start_min IS todos.start_min
      AND w.category  IS todos.category
      AND w.priority  IS todos.priority
      AND w.notes     IS todos.notes
  );

DROP TABLE _rec_drop;
DROP TABLE _rec_twin;

-- 1b) 历史模板补首日身份：老版本里「模板 = 首日实例」只在 `create_todo_on` 里补，
--     经其它入口写进来的模板会缺这一行身份。缺身份的模板在物化眼里永远「缺失」，
--     正是「每次加载都多一条」的另一半来源。这里一次性补齐（实测真实库有 1 条）。
UPDATE todos
SET rec_key = id || ':' || date
WHERE rec_rule IS NOT NULL
  AND date IS NOT NULL
  AND (rec_key IS NULL OR rec_key = '');

-- ── 2) 结构护栏：身份不可变 ────────────────────────────────────────────────────
-- 这是本次缺陷的真正根因：实例没有 rec_rule，旧的全量更新于是把 rec_key 写成 NULL，
-- 物化逻辑随即把它当成「这一天还没生成」再补一条。触发器让这件事在数据库层就不可能发生，
-- 无论调用方是 Tauri 命令、同步引擎、网关还是裸 SQL。
--
-- 例外分支必须显式写上 `NEW.rec_key IS NOT NULL`：SQL 里 `NULL = '…'` 求值仍是 NULL，
-- `NOT (NULL)` 也是 NULL（按假处理），于是「把模板身份清空」会从这条例外里溜过去 ——
-- 实测在真实库上确实漏掉了一行。少了这个判空，护栏等于开了个后门。
CREATE TRIGGER IF NOT EXISTS todos_rec_key_immutable
BEFORE UPDATE OF rec_key ON todos
FOR EACH ROW
WHEN OLD.rec_key IS NOT NULL
  AND NEW.rec_key IS NOT OLD.rec_key
  -- 唯一例外：模板行随自己的日期移动（「模板 = 首日实例」必须跟着日期走）
  AND NOT (NEW.rec_key IS NOT NULL
           AND NEW.rec_rule IS NOT NULL
           AND NEW.date IS NOT NULL
           AND NEW.rec_key = NEW.id || ':' || NEW.date)
BEGIN
  SELECT RAISE(ABORT, 'rec_key 是重复实例的身份，不可修改或清空（要换身份请先删后建）');
END;

-- ── 3) 模板必须有首日身份：让「模板 = 首日实例」不再依赖某个调用方记得补 ──────────
-- 从前这条不变量只写在 `create_todo_on` 里的一句 UPDATE 上：任何别的入口（测试夹具、
-- 同步引擎、导入、裸 SQL）插一条带 rec_rule 的行就会留下**没有身份**的模板 ——
-- 它在物化眼里永远「缺失」，于是每次同步都补一条，重演同一类缺陷。
-- 挂成 AFTER INSERT 触发器后，这条不变量由数据库保证。
CREATE TRIGGER IF NOT EXISTS todos_template_first_instance
AFTER INSERT ON todos
FOR EACH ROW
WHEN NEW.rec_rule IS NOT NULL
  AND NEW.date IS NOT NULL
  AND (NEW.rec_key IS NULL OR NEW.rec_key = '')
BEGIN
  UPDATE todos SET rec_key = NEW.id || ':' || NEW.date WHERE id = NEW.id;
END;
"#;

/// 0048 · 动作详解的**覆盖层**（让 AI / 用户能改内置动作的教学文案）。
///
/// `config/exerciseGuide.ts` 是内置 81 个动作教学内容的基线（准备 3 条 / 开始 / 结束 /
/// 注意 2 条 / 每次循环秒数），编译进前端包。AI 需要能改它：同一个深蹲，膝盖有旧伤的
/// 人该看到的「注意」不是通用那两条。因此基线与改动必须分开存：
///
/// 1. **基线不入库**：81 × 5 段文案存进 SQLite 只是把同一份内容放两处，且内置动作的
///    内容列每次启动都被 `seed_exercises` 覆盖式刷新 —— 改动没有落脚点。
/// 2. **只存差异**：表里只有「被改过的动作」一行，删行 = 恢复基线，回滚天然成立。
/// 3. **不挂 exercises 表列**：`seed_exercises` 的 `ON CONFLICT DO UPDATE` 会刷内容列，
///    `favorite` / `hidden` 能作为列活下来是因为它们被显式排除在覆盖列表外；guide 是
///    五段文案，塞列里就是给表加 5 列 JSON，还会让「恢复基线」变成「写回默认值」。
///
/// 外键指向 `exercises`：自建动作真删时覆盖层跟着走；内置动作只隐藏、不触发级联，
/// 所以「隐藏再恢复」不会丢用户的改动。
const MIGRATION_0048: &str = r#"
CREATE TABLE exercise_guides (
  exercise_id TEXT PRIMARY KEY REFERENCES exercises(id) ON DELETE CASCADE,
  setup       TEXT NOT NULL DEFAULT '[]',
  start_text  TEXT NOT NULL DEFAULT '',
  end_text    TEXT NOT NULL DEFAULT '',
  cautions    TEXT NOT NULL DEFAULT '[]',
  rep_sec     INTEGER NOT NULL DEFAULT 0,
  updated_by  TEXT NOT NULL DEFAULT 'ai',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
"#;

/// 0049 · 课表时段的身份里补上「哪几周」。
///
/// 0021 的唯一键是 `(account, semester, course, weekday, start_unit, start_time)` ——
/// 它假设「同一门课、同一个星期几、同一个节次」只可能有一条记录。实测桂电教务并非如此：
/// 一门课在同一个位置会按**周次段**拆成多条（教师 / 教室也跟着段变）。真实样本：
///
/// ```text
/// 健康教育 17311*  周二 6-7 节 14:30  5~7 周 黄观凤 / 8~9 韦雪军 / 10~11 杨雁 / 12 马瑞杰
/// 大学生心理健康  周五 8-9 节 16:30  3~5 周 信科421308 / 6~12 周 02109Y
/// ```
///
/// 旧键把这几条并成一条：后到的那条覆盖前一条的 `weeks` / `room` / `teachers`，
/// 于是课表上只剩一个周次段（常常正好不含本周）、教师张冠李戴 —— 用户看到的
/// 「课表与实际不符」就是这条唯一键造成的。所以身份必须带上周次集合。
///
/// SQLite 不能在原地改表级 UNIQUE，只能重建表（`migrate` 为此在迁移窗口里关掉外键，
/// 否则 `DROP TABLE` 的隐式 DELETE 会撞上 `todos.course_session_id`）。
/// 顺手补上 `teachers` 列：**同一个周次段换了教师，课表上也该换** —— 教师原先只存在
/// 课程级（`campus_courses.teachers`），一门课多个周次段就只剩最后一个写入者，
/// 于是「这周明明是黄观凤，App 显示马瑞杰」。
///
/// 老行的 `weeks_key` 直接落成 JSON 原文：它不是规范形，下一次同步就会把整学期的时段
/// 按新键重写一遍（`delete_stale_sessions` 顺手清掉这些老行），不需要在这里猜。
///
/// 同时写下 [`SESSIONS_NEED_RESYNC`] 标记：老库里被并掉的那些周次段**只能靠一次真同步
/// 补回来**，前端看到标记会替用户跑那一次（见 `pages/SchedulePage.vue`）。
const MIGRATION_0049: &str = r#"
CREATE TABLE campus_sessions_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES campus_accounts(id) ON DELETE CASCADE,
  semester_id INTEGER NOT NULL REFERENCES campus_semesters(id) ON DELETE CASCADE,
  course_id   INTEGER NOT NULL REFERENCES campus_courses(id) ON DELETE CASCADE,
  weekday     INTEGER NOT NULL,
  start_unit  INTEGER NOT NULL,
  end_unit    INTEGER NOT NULL,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  weeks       TEXT NOT NULL,
  weeks_key   TEXT NOT NULL DEFAULT '',
  weeks_str   TEXT,
  room TEXT,
  building TEXT,
  campus TEXT,
  teachers TEXT,
  UNIQUE(account_id, semester_id, course_id, weekday, start_unit, start_time, weeks_key)
);

INSERT INTO campus_sessions_v2
  (id, account_id, semester_id, course_id, weekday, start_unit, end_unit, start_time, end_time,
   weeks, weeks_key, weeks_str, room, building, campus, teachers)
SELECT s.id, s.account_id, s.semester_id, s.course_id, s.weekday, s.start_unit, s.end_unit,
       s.start_time, s.end_time, s.weeks, COALESCE(s.weeks, ''), s.weeks_str, s.room, s.building,
       s.campus,
       -- 老库只有课程级教师（同一门课的最后一次写入者），先按它兜底；
       -- 下一次同步会用「这一节实际上是谁上」覆盖掉
       (SELECT c.teachers FROM campus_courses c WHERE c.id = s.course_id)
FROM campus_sessions s;

DROP TABLE campus_sessions;
ALTER TABLE campus_sessions_v2 RENAME TO campus_sessions;

CREATE INDEX idx_campus_sessions_semester ON campus_sessions(account_id, semester_id);
CREATE INDEX idx_campus_sessions_course ON campus_sessions(course_id);

INSERT INTO app_meta (key, value) VALUES ('campus.sessions_need_resync', '1')
  ON CONFLICT(key) DO UPDATE SET value = '1';
"#;

const MIGRATIONS: &[&str] = &[
    MIGRATION_0001,
    MIGRATION_0002,
    MIGRATION_0003,
    MIGRATION_0004,
    MIGRATION_0005,
    MIGRATION_0006,
    MIGRATION_0007,
    MIGRATION_0008,
    MIGRATION_0009,
    MIGRATION_0010,
    MIGRATION_0011,
    MIGRATION_0012,
    MIGRATION_0013,
    MIGRATION_0014,
    MIGRATION_0015,
    MIGRATION_0016,
    MIGRATION_0017,
    MIGRATION_0018,
    MIGRATION_0019,
    MIGRATION_0020,
    MIGRATION_0021,
    MIGRATION_0022,
    MIGRATION_0023,
    MIGRATION_0024,
    MIGRATION_0025,
    MIGRATION_0026,
    MIGRATION_0027,
    MIGRATION_0028,
    MIGRATION_0029,
    MIGRATION_0030,
    MIGRATION_0031,
    MIGRATION_0032,
    MIGRATION_0033,
    MIGRATION_0034,
    MIGRATION_0035,
    MIGRATION_0036,
    MIGRATION_0037,
    MIGRATION_0038,
    MIGRATION_0039,
    MIGRATION_0040,
    MIGRATION_0041,
    MIGRATION_0042,
    MIGRATION_0043,
    MIGRATION_0044,
    MIGRATION_0045,
    MIGRATION_0046,
    MIGRATION_0047,
    MIGRATION_0048,
    MIGRATION_0049,
];

/// 通用键值元数据（`app_meta`）读写 —— 全应用**唯一一份**这条 SQL。
/// 各域只给键名与值，不再各自抄一遍 upsert（语义差异 `excluded.value` / `?2` 在这里统一）。
pub(crate) fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM app_meta WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
}

pub(crate) fn meta_set(conn: &Connection, key: &str, value: &str) -> crate::error::Result<()> {
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

pub(crate) fn meta_del(conn: &Connection, key: &str) -> crate::error::Result<()> {
    conn.execute("DELETE FROM app_meta WHERE key = ?1", [key])?;
    Ok(())
}

/// 测试用：对给定连接跑完整迁移（含知识库的 FTS 表与全部触发器）。
/// 生产路径是 `init()`，它会额外做种子导入；测试不需要种子。
#[cfg(test)]
pub fn migrate_for_test(conn: &Connection) -> Result<()> {
    migrate(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 只应用到 0016，模拟知识库上线之前的老库。
    fn legacy_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        apply_through(&conn, 16);
        conn
    }

    /// 逐条应用迁移到第 `upto` 号（含），并如实登记 `schema_migrations` ——
    /// 这样随后的 `migrate_for_test` 会从 `upto + 1` 接着补，模拟「老库升级」。
    fn apply_through(conn: &Connection, upto: usize) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations(
               version INTEGER PRIMARY KEY,
               applied_at TEXT NOT NULL DEFAULT (datetime('now'))
             );",
        )
        .unwrap();
        for (i, sql) in MIGRATIONS.iter().enumerate() {
            let v = i + 1;
            if v > upto {
                break;
            }
            conn.execute_batch(&format!(
                "BEGIN; {sql}; INSERT INTO schema_migrations(version) VALUES ({v}); COMMIT;"
            ))
            .unwrap();
        }
    }

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            > 0
    }

    /// 锁住 `tune()` 的三条连接级 pragma。
    ///
    /// 为什么值得一条测试：`synchronous` 只影响性能、不影响正确性 —— 谁把它删掉，
    /// 没有任何功能测试会红，只有写路径悄悄慢 24 倍（实测口径见 `tune` 的注释）。
    /// `foreign_keys` 反过来：默认是关的，漏了它级联删除会静默失效。
    #[test]
    fn tune_locks_connection_pragmas() {
        let dir = std::env::temp_dir().join(format!("rein-pragma-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tune.db");
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }

        let conn = Connection::open(&path).unwrap();
        tune(&conn).unwrap();

        let int_pragma = |p: &str| -> i64 {
            conn.query_row(&format!("PRAGMA {p}"), [], |r| r.get::<_, i64>(0))
                .unwrap()
        };
        assert_eq!(
            int_pragma("synchronous"),
            1,
            "WAL 下应为 NORMAL(1)：FULL(2) 让每次写入都 fsync（实测慢 24 倍）"
        );
        assert_eq!(int_pragma("foreign_keys"), 1, "外键必须显式打开");
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");

        drop(conn);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn upgrade_from_0016_adds_knowledge_base() {
        let conn = legacy_db();
        assert!(
            !table_exists(&conn, "kb_docs"),
            "前置条件：老库还没有知识库表"
        );

        migrate_for_test(&conn).unwrap();

        for t in [
            "kb_docs",
            "kb_chunks",
            "kb_fts",
            "kb_vectors",
            "kb_dirty",
            "kb_settings",
            "kb_memories",
            "kb_memory_diffs",
        ] {
            assert!(table_exists(&conn, t), "升级后应存在 {t}");
        }
        let ver: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(ver, MIGRATIONS.len() as i64);
    }

    /// 触发器是升级后新建的，只对**之后**的写入生效。这条验证它们确实生效了——
    /// 老数据的补齐靠 scan_all 对账，但新写入必须立刻被登记。
    #[test]
    fn triggers_are_live_after_upgrade() {
        let conn = legacy_db();
        // 升级前就存在的待办：不该有脏标记（触发器还不存在）
        conn.execute(
            "INSERT INTO todos(title, category, priority, status, created_at)
             VALUES('老数据','general',0,'todo','x')",
            [],
        )
        .unwrap();

        migrate_for_test(&conn).unwrap();
        let dirty: i64 = conn
            .query_row("SELECT COUNT(*) FROM kb_dirty", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dirty, 0, "升级前的老数据不会被触发器追溯登记");

        // 升级后的新写入必须被登记
        conn.execute(
            "INSERT INTO todos(title, category, priority, status, created_at)
             VALUES('新数据','general',0,'todo','x')",
            [],
        )
        .unwrap();
        let dirty: i64 = conn
            .query_row("SELECT COUNT(*) FROM kb_dirty", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dirty, 1, "升级后的写入必须被登记");
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = legacy_db();
        migrate_for_test(&conn).unwrap();
        let before: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        // 再跑一次不该重复应用，也不该因表/触发器已存在而报错
        migrate_for_test(&conn).unwrap();
        let after: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(after, MIGRATIONS.len() as i64);
    }

    /// 0035 加的体感列必须真的在，且课程路径（不传 effort）写入时为 NULL。
    /// 列存在性靠 `migrate_is_idempotent` 兜不住 —— 它只看 schema_migrations 的行数，
    /// 一条写错列名的 ALTER 也能「成功」并记下版本号。
    #[test]
    fn workouts_effort_column_is_nullable_and_defaults_to_null() {
        let conn = legacy_db();
        migrate_for_test(&conn).unwrap();
        conn.execute(
            "INSERT INTO workouts (name, type, date, duration_min, kcal, intensity, created_at) \
             VALUES ('课程训练', 'strength', '2026-09-10', 45, 300, 'moderate', '2026-09-10T10:00:00Z')",
            [],
        )
        .unwrap();
        let effort: Option<i64> = conn
            .query_row(
                "SELECT effort FROM workouts WHERE name = '课程训练'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(effort, None, "课程/跑步路径不写体感，读出来应是 NULL");

        // 手动补录写 1..5
        conn.execute(
            "INSERT INTO workouts (name, type, date, duration_min, kcal, intensity, effort, created_at) \
             VALUES ('羽毛球', 'badminton', '2026-09-10', 50, 520, 'high', 4, '2026-09-10T20:00:00Z')",
            [],
        )
        .unwrap();
        let effort: Option<i64> = conn
            .query_row("SELECT effort FROM workouts WHERE name = '羽毛球'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(effort, Some(4));
    }

    /// 触发器不能破坏既有写入路径：插一条待办仍然成功，且只多出一行脏标记。
    #[test]
    fn triggers_do_not_break_existing_writes() {
        let conn = legacy_db();
        migrate_for_test(&conn).unwrap();
        conn.execute(
            "INSERT INTO todos(title, notes, category, priority, status, created_at, date, subtasks, attachments)
             VALUES('测试','备注','general',1,'todo','x','2026-09-10','[]','[]')",
            [],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        assert!(id > 0);
        conn.execute("UPDATE todos SET notes = '改过' WHERE id = ?1", [id])
            .unwrap();
        conn.execute("DELETE FROM todos WHERE id = ?1", [id])
            .unwrap();
        // 插入+更新+删除都作用于同一主键，脏队列里只应留最后一条 delete
        let (op, n): (String, i64) = conn
            .query_row(
                "SELECT op, (SELECT COUNT(*) FROM kb_dirty) FROM kb_dirty LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((op.as_str(), n), ("delete", 1));
    }

    /// kb_settings 是单行表，迁移里已经种了 id=1，否则后续 SQL 全部落空。
    #[test]
    fn kb_settings_has_the_singleton_row() {
        let conn = legacy_db();
        migrate_for_test(&conn).unwrap();
        let mode: String = conn
            .query_row(
                "SELECT embedding_mode FROM kb_settings WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(mode, "keyword", "默认应为零依赖的关键词模式");
    }

    /// 0046：智能添加抽屉重复落库留下的历史重复行要被清掉；保留口径是
    /// 「同组优先已完成，否则最早」，且课表派生 / 方案 / 重复实例三类来源行一律不碰。
    /// 0049 要重建 `campus_sessions`（改表级 UNIQUE），这是本库唯一一次「带外键的重建」：
    /// `DROP TABLE` 的隐式 DELETE 会撞上 `todos.course_session_id`，所以 `migrate` 在迁移
    /// 窗口里关外键。这条测试盯三件事：行不丢、派生行的引用仍有效、新的唯一键真的生效。
    #[test]
    fn migration_0049_rebuilds_sessions_and_keeps_derived_rows() {
        let conn = Connection::open_in_memory().unwrap();
        // 跟生产同一条顺序：连接先开外键（`tune`），再跑迁移。
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        apply_through(&conn, 48); // 停在 0049 之前，模拟升级前的库
        conn.execute_batch(
            "INSERT INTO campus_accounts (id, system_kind, base_url, login_name, created_at, updated_at) \
               VALUES (1, 'guet-supwisdom-eams5', 'https://x', '2600', 't', 't');
             INSERT INTO campus_semesters (id, account_id, remote_id, name, start_date, end_date, \
               week_start_on_sunday, total_weeks, is_current) \
               VALUES (1, 1, 321, '2026-2027 第一学期', '2026-09-14', '2027-01-24', 0, 19, 1);
             INSERT INTO campus_courses (id, account_id, semester_id, remote_lesson_id, course_name, teachers) \
               VALUES (1, 1, 1, 322367, '健康教育', '[\"马瑞杰\"]');
             INSERT INTO campus_sessions (id, account_id, semester_id, course_id, weekday, start_unit, \
               end_unit, start_time, end_time, weeks, weeks_str) \
               VALUES (1, 1, 1, 1, 4, 6, 7, '14:30', '16:05', '[5,6]', '5~6');
             INSERT INTO todos (id, title, date, start_min, duration_min, category, priority, status, \
               created_at, course_session_id) \
               VALUES (1, '健康教育', '2026-10-22', 870, 95, 'class', 0, 'done', 't', 1);",
        )
        .unwrap();

        migrate_for_test(&conn).unwrap();

        let (weeks, key, teachers): (String, String, Option<String>) = conn
            .query_row(
                "SELECT weeks, weeks_key, teachers FROM campus_sessions WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(weeks, "[5,6]", "行必须原样搬过来");
        assert!(!key.is_empty(), "老行也要有一个 weeks_key，否则新唯一键形同虚设");
        assert_eq!(
            teachers.as_deref(),
            Some("[\"马瑞杰\"]"),
            "教师先从课程级兜底，等下一次同步再换成时段级"
        );

        // 派生行引用的还是同一个会话 id —— 重建没有把用户打过卡的记录甩掉
        let linked: i64 = conn
            .query_row("SELECT course_session_id FROM todos WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(linked, 1);

        // 外键必须被还原（否则后面所有级联删除会静默失效）
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1, "迁移窗口结束后要打开外键");

        // 新唯一键：同一格子、不同周次段可以并存；同周次段重复插入必须被拒
        conn.execute(
            "INSERT INTO campus_sessions (account_id, semester_id, course_id, weekday, start_unit, \
             end_unit, start_time, end_time, weeks, weeks_key) \
             VALUES (1, 1, 1, 4, 6, 7, '14:30', '16:05', '[7,8]', '7,8')",
            [],
        )
        .expect("不同周次段应能并存");
        assert!(
            conn.execute(
                "INSERT INTO campus_sessions (account_id, semester_id, course_id, weekday, start_unit, \
                 end_unit, start_time, end_time, weeks, weeks_key) \
                 VALUES (1, 1, 1, 4, 6, 7, '14:30', '16:05', '[7,8]', '7,8')",
                [],
            )
            .is_err(),
            "同周次段重复应被唯一键挡住"
        );

        // 顺手把「需要重同步」的标记留下：被并掉的那些周次只能靠一次真同步补回来
        let flag = meta_get(&conn, "campus.sessions_need_resync");
        assert_eq!(flag.as_deref(), Some("1"));
    }

    #[test]
    fn migration_0046_dedupes_history_and_keeps_completions() {        let conn = Connection::open_in_memory().unwrap();
        // 本测试只验证去重谓词，不关心外键：派生行 / 方案行仅作为「不该被碰」的样本，
        // 不必真去建出校园课次与方案那一整条链。
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        apply_through(&conn, 45); // 停在 0046 之前，模拟升级前的库

        // (id, title, notes, status, course_session_id, program_id, rec_key)
        let ins = |id: i64,
                   title: &str,
                   notes: Option<&str>,
                   status: &str,
                   course: Option<i64>,
                   program: Option<i64>,
                   rec_key: Option<&str>| {
            conn.execute(
                "INSERT INTO todos (id, title, notes, date, start_min, duration_min, category, \
                 priority, status, created_at, course_session_id, program_id, rec_key) \
                 VALUES (?1, ?2, ?3, '2026-10-19', 450, 45, 'general', 0, ?4, \
                 '2026-10-19T07:00:00Z', ?5, ?6, ?7)",
                rusqlite::params![id, title, notes, status, course, program, rec_key],
            )
            .unwrap();
        };

        // A：Bug 造出的三条重复 —— 保留已完成的 2 号，删掉 1、3
        ins(1, "早自习（5教206）", None, "todo", None, None, None);
        ins(2, "早自习（5教206）", None, "done", None, None, None);
        ins(3, "早自习（5教206）", None, "todo", None, None, None);
        // B：不重复，原样保留
        ins(4, "程序设计基础", None, "todo", None, None, None);
        // C：课表派生行即便同标题同时刻也不该被动（归 materialize_todos 的先删后建）
        ins(5, "晚自习（5教206）", None, "todo", Some(7), None, None);
        ins(6, "晚自习（5教206）", None, "todo", Some(7), None, None);
        // D：方案行不碰（归 program_schedule_replace）
        ins(7, "方案热身", None, "todo", None, Some(3), None);
        ins(8, "方案热身", None, "todo", None, Some(3), None);
        // E：重复实例字段相同也不碰 —— 存在性由 rec_key 管
        ins(9, "每天喝水", None, "todo", None, None, Some("11:2026-10-19"));
        ins(10, "每天喝水", None, "todo", None, None, Some("12:2026-10-19"));

        migrate_for_test(&conn).unwrap();

        let remaining: Vec<i64> = {
            let mut stmt = conn.prepare("SELECT id FROM todos ORDER BY id").unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, i64>(0)).unwrap();
            rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        assert_eq!(
            remaining,
            vec![2, 4, 5, 6, 7, 8, 9, 10],
            "只清用户自建重复（A 组保留已完成的 2 号），其余来源行原样保留"
        );
    }
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations(
           version INTEGER PRIMARY KEY,
           applied_at TEXT NOT NULL DEFAULT (datetime('now'))
         );",
    )?;
    let current: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |r| r.get(0),
    )?;

    // 迁移窗口里关掉外键：**改表级约束只能重建表**（0049 就是这么干的），而 SQLite 的
    // `DROP TABLE` 会先做一次隐式 `DELETE FROM`，`todos.course_session_id` 这种没有级联
    // 的子行会让它直接报 FOREIGN KEY constraint failed。这是 SQLite 官方推荐的改表姿势。
    // 位置有讲究：pragma 在事务内是**空操作**，而每条迁移都被包在 BEGIN…COMMIT 里，
    // 所以必须在循环外、进 BEGIN 之前设；跑完（无论成败）都要还原，否则这个连接后面的
    // 级联删除会静默失效（`tune` 那条注释里的坑）。
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    let outcome = (|| -> Result<()> {
        for (i, sql) in MIGRATIONS.iter().enumerate() {
            let version = (i + 1) as i64;
            if version <= current {
                continue;
            }
            conn.execute_batch(&format!(
                "BEGIN; {sql}; INSERT INTO schema_migrations(version) VALUES ({version}); COMMIT;"
            ))?;
        }
        Ok(())
    })();
    conn.pragma_update(None, "foreign_keys", "ON")?;
    outcome
}

#[cfg(test)]
mod data_dir_tests {
    use super::*;

    /// 空串 / 纯空白 = 没设开关。shell 里 `set REIN_DATA_DIR=` 是常事，
    /// 它必须被当作「用真身目录」而不是「根目录」。
    #[test]
    fn blank_env_counts_as_unset() {
        for raw in [None, Some("".to_string()), Some("   ".to_string()), Some("\t\n".to_string())] {
            assert_eq!(env_override(raw), None, "空值应视为未设置");
        }
        assert_eq!(
            env_override(Some("  C:\\scratch  ".to_string())),
            Some("C:\\scratch".to_string()),
            "有值时应去掉两端空白"
        );
    }

    /// 绝对路径原样采用（Windows 下反斜杠、盘符都不过滤），且目录要真被建出来——
    /// 生产路径不预建就开不了库。
    #[test]
    fn absolute_override_used_verbatim_and_created() {
        let base = std::env::temp_dir().join(format!("rein-datadir-{}", std::process::id()));
        let target = base.join("nested").join("scratch");
        let _ = std::fs::remove_dir_all(&base);

        let dir = resolve_override_dir(target.to_str().unwrap()).unwrap();
        assert_eq!(dir, target, "隔离目录必须原样生效，不能悄悄改写");
        assert!(target.is_dir());

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 相对路径按 CWD 拼绝对 —— exe 的工作目录随启动方式变，不能赌。
    #[test]
    fn relative_override_becomes_absolute() {
        let dir = resolve_override_dir("rein-scratch").unwrap();
        assert!(dir.is_absolute(), "相对路径必须先拼成绝对路径");
        assert_eq!(dir.file_name().unwrap(), "rein-scratch");
    }

    /// 建不出来的目录必须报错（且错误里带上路径）——静默回退到生产目录
    /// 正是 2026-10-10 事故的成因，这条契约不能破。
    #[test]
    fn uncreatable_dir_errors_instead_of_falling_back() {
        // 用一个**文件**当目录：create_dir_all 必失败
        let file = std::env::temp_dir().join(format!("rein-notadir-{}", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        let err = resolve_override_dir(file.to_str().unwrap()).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("REIN_DATA_DIR"), "错误应点名环境变量：{msg}");
        assert!(
            msg.contains(&file.display().to_string()),
            "错误应带上坏路径：{msg}"
        );
        let _ = std::fs::remove_file(&file);
    }
}
