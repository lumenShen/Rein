//! AI 域命令 · 命令名与前端 `aiService.ts` 对应。

use tauri::State;

use crate::error::Result;
use crate::state::AppState;

use super::models::ParsedFoodItem;

const QUANT_WORDS: [char; 12] = [
    '个', '碗', '杯', '根', '片', '块', '勺', '份', '颗', '把', '盒', '支',
];

fn cn_num(c: char) -> Option<f64> {
    match c {
        '半' => Some(0.5),
        '一' => Some(1.0),
        '二' | '两' => Some(2.0),
        '三' => Some(3.0),
        '四' => Some(4.0),
        '五' => Some(5.0),
        '六' => Some(6.0),
        '七' => Some(7.0),
        '八' => Some(8.0),
        '九' => Some(9.0),
        '十' => Some(10.0),
        _ => None,
    }
}

/// 关键词解析：食物库逐个匹配名称（去掉括号后缀），
/// 就近向前看 8 个字符，识别「200克」或「一个/一碗」等数量词。
#[tauri::command]
pub fn ai_parse_food_text(state: State<AppState>, text: String) -> Result<Vec<ParsedFoodItem>> {
    let conn = state.db.lock();

    let mut stmt =
        conn.prepare("SELECT id, name, default_unit FROM foods ORDER BY LENGTH(name) DESC")?;
    let foods: Vec<(i64, String, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;

    let chars: Vec<char> = text.chars().collect();
    let mut items: Vec<ParsedFoodItem> = Vec::new();

    for (id, name, default_unit) in foods {
        if items.len() >= 6 {
            break;
        }
        let base: String = name.split('(').next().unwrap_or(&name).to_string();
        let base_chars: Vec<char> = base.chars().collect();
        if base_chars.is_empty() {
            continue;
        }

        // 名称命中位置
        let mut pos: Option<usize> = None;
        for i in 0..=chars.len().saturating_sub(base_chars.len()) {
            if chars[i..i + base_chars.len()] == base_chars[..] {
                pos = Some(i);
                break;
            }
        }
        let pos = match pos {
            Some(p) => p,
            None => continue,
        };
        if items.iter().any(|it| it.food_id == Some(id)) {
            continue;
        }

        // 就近数量词
        let lookback = 8.min(pos);
        let before: Vec<char> = chars[pos - lookback..pos].to_vec();
        let mut grams = default_grams(&conn, id, default_unit.as_deref())?;

        // ① 数字 + 克/g（紧邻名称）
        let mut digits_end = before.len();
        while digits_end > 0 && before[digits_end - 1].is_ascii_digit() {
            digits_end -= 1;
        }
        if digits_end < before.len() {
            let num: f64 = before[digits_end..]
                .iter()
                .collect::<String>()
                .parse()
                .unwrap_or(0.0);
            let has_unit_char =
                digits_end > 0 && matches!(before[digits_end - 1], '克' | 'g' | 'G');
            if has_unit_char || (num > 0.0 && num <= 2000.0) {
                grams = num;
            }
        } else if let Some(last) = before.last().copied() {
            // ② 中文数字 + 量词
            if QUANT_WORDS.contains(&last) && before.len() >= 2 {
                if let Some(count) = cn_num(before[before.len() - 2]) {
                    grams = unit_grams(&conn, id, &last.to_string())?.unwrap_or(grams) * count;
                }
            }
        }

        items.push(ParsedFoodItem {
            food_id: Some(id),
            food_name: base,
            grams,
            kcal_estimate: (kcal_per_100g(&conn, id)? * grams / 100.0).round(),
            confidence: 0.6,
            note: None,
        });
    }

    Ok(items)
}

/* ---------- 辅助查询 ---------- */
// 拍照解析由前端 pi-ai 直连视觉模型完成（src/ai/foodPhoto.ts），不经过 Rust。

fn kcal_per_100g(conn: &rusqlite::Connection, food_id: i64) -> Result<f64> {
    Ok(
        conn.query_row("SELECT kcal FROM foods WHERE id = ?1", [food_id], |r| {
            r.get(0)
        })?,
    )
}

fn unit_grams(conn: &rusqlite::Connection, food_id: i64, name: &str) -> Result<Option<f64>> {
    let res = conn.query_row(
        "SELECT grams FROM food_units WHERE food_id = ?1 AND name = ?2",
        rusqlite::params![food_id, name],
        |r| r.get(0),
    );
    match res {
        Ok(grams) => Ok(Some(grams)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn default_grams(
    conn: &rusqlite::Connection,
    food_id: i64,
    default_unit: Option<&str>,
) -> Result<f64> {
    if let Some(u) = default_unit {
        if let Some(g) = unit_grams(conn, food_id, u)? {
            return Ok(g);
        }
    }
    Ok(100.0)
}

/* ---------- 目标调整解析 ---------- */

use super::models::{TargetAdjustProposal, TargetChange};
use crate::modules::nutrition::models::DailyTargets;

/// 字段规格：关键词 → 目标字段（界限与取整粒度与前端 NumberStepper 一致）
struct FieldSpec {
    field: &'static str,
    label: &'static str,
    unit: &'static str,
    keywords: &'static [&'static str],
    min: f64,
    max: f64,
    round_step: f64,
}

const FIELD_SPECS: [FieldSpec; 6] = [
    FieldSpec {
        field: "kcal",
        label: "能量",
        unit: "大卡",
        keywords: &["热量", "大卡", "千卡", "卡路里", "kcal"],
        min: 800.0,
        max: 5000.0,
        round_step: 10.0,
    },
    FieldSpec {
        field: "protein",
        label: "蛋白质",
        unit: "g",
        keywords: &["蛋白"],
        min: 20.0,
        max: 300.0,
        round_step: 1.0,
    },
    FieldSpec {
        field: "carb",
        label: "碳水",
        unit: "g",
        keywords: &["碳水"],
        min: 50.0,
        max: 600.0,
        round_step: 1.0,
    },
    FieldSpec {
        field: "fat",
        label: "脂肪",
        unit: "g",
        keywords: &["脂肪"],
        min: 20.0,
        max: 200.0,
        round_step: 1.0,
    },
    FieldSpec {
        field: "sodiumMg",
        label: "钠",
        unit: "mg",
        keywords: &["钠", "盐"],
        min: 500.0,
        max: 5000.0,
        round_step: 50.0,
    },
    FieldSpec {
        field: "waterMl",
        label: "饮水",
        unit: "ml",
        keywords: &["饮水", "喝水", "水"],
        min: 500.0,
        max: 5000.0,
        round_step: 100.0,
    },
];

const UP_WORDS: [&str; 5] = ["提高", "提升", "增加", "上调", "多"];
const DOWN_WORDS: [&str; 6] = ["降低", "降到", "减少", "下调", "少", "控制"];

/// 方向词后紧跟「到/为/成/至」视为绝对值（"降到1700"），否则为增量（"减少300"）。
const ABSOLUTE_PARTICLES: [char; 5] = ['到', '为', '成', '至', '在'];

fn read_number(chars: &[char], start: usize) -> Option<(f64, usize)> {
    let mut i = start;
    let mut seen_dot = false;
    while i < chars.len() && (chars[i].is_ascii_digit() || (chars[i] == '.' && !seen_dot)) {
        if chars[i] == '.' {
            seen_dot = true;
        }
        i += 1;
    }
    if i == start {
        return None;
    }
    let s: String = chars[start..i].iter().collect();
    s.parse().ok().map(|v| (v, i))
}

/// 从 `from` 起向后跳过至多 `skip_limit` 个非数字字符找数
fn number_forward(chars: &[char], from: usize, skip_limit: usize) -> Option<(f64, usize, usize)> {
    let end = chars.len().min(from + skip_limit);
    let mut i = from;
    while i < end {
        if chars[i].is_ascii_digit() {
            let (v, num_end) = read_number(chars, i)?;
            return Some((v, i, num_end));
        }
        i += 1;
    }
    None
}

/// 从 `before` 往前至多 `window` 个字符里找数字串的末尾并读出该数（如"1800大卡"）
fn number_backward(chars: &[char], before: usize, window: usize) -> Option<(f64, usize, usize)> {
    let lo = before.saturating_sub(window);
    let mut i = before;
    while i > lo {
        i -= 1;
        if chars[i].is_ascii_digit() || chars[i] == '.' {
            // 回退到数字串起点（含小数点）
            let mut start = i;
            while start > 0 && (chars[start - 1].is_ascii_digit() || chars[start - 1] == '.') {
                start -= 1;
            }
            let (v, _) = read_number(chars, start)?;
            return Some((v, start, i + 1));
        }
    }
    None
}

/// 数字前的上下文窗口：判定调整方向。
/// 返回 +1/-1 表示「提高/降低 N」的增量；0 表示绝对值语义（"降到1700"、"蛋白质130克"）。
fn direction_before(chars: &[char], num_start: usize) -> i32 {
    let ws = num_start.saturating_sub(8);
    let ctx: String = chars[ws..num_start].iter().collect();
    // 方向词后紧跟「到/为/成/至/在」（允许中间空白）时按绝对目标理解
    let trimmed = ctx.trim_end();
    let particle = trimmed
        .chars()
        .next_back()
        .is_some_and(|c| ABSOLUTE_PARTICLES.contains(&c));
    if particle {
        return 0;
    }
    if UP_WORDS.iter().any(|w| ctx.contains(w)) {
        1
    } else if DOWN_WORDS.iter().any(|w| ctx.contains(w)) {
        -1
    } else {
        0
    }
}

fn clamp_round(v: f64, spec: &FieldSpec) -> f64 {
    let clamped = v.clamp(spec.min, spec.max);
    (clamped / spec.round_step).round() * spec.round_step
}

fn current_of(t: &DailyTargets, field: &str) -> f64 {
    match field {
        "kcal" => t.kcal,
        "protein" => t.protein,
        "carb" => t.carb,
        "fat" => t.fat,
        "sodiumMg" => t.sodium_mg,
        _ => t.water_ml,
    }
}

fn assign(targets: &mut DailyTargets, field: &str, value: f64) {
    match field {
        "kcal" => targets.kcal = value,
        "protein" => targets.protein = value,
        "carb" => targets.carb = value,
        "fat" => targets.fat = value,
        "sodiumMg" => targets.sodium_mg = value,
        _ => targets.water_ml = value,
    }
}

/// 自然语言 → 每日目标调整建议。关键词占位实现：
/// 「把热量降到1800」「蛋白质提高到130克」「每天1800大卡」；接入 LLM 后替换内部实现。
#[tauri::command]
pub fn ai_parse_target_adjust(text: String, current: DailyTargets) -> Result<TargetAdjustProposal> {
    let lower = text.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let mut proposal = current.clone();
    let mut changes: Vec<TargetChange> = Vec::new();
    let mut done_fields: Vec<&'static str> = Vec::new();

    for spec in &FIELD_SPECS {
        if done_fields.contains(&spec.field) {
            continue;
        }
        for kw in spec.keywords {
            // 关键词在原文中的位置（lowercase 与原文同字符长度，仅 ASCII 受影响）
            let kw_chars: Vec<char> = kw.to_lowercase().chars().collect();
            let len = kw_chars.len();
            let mut pos: Option<usize> = None;
            for i in 0..=chars.len().saturating_sub(len) {
                if chars[i..i + len] == kw_chars[..] {
                    pos = Some(i);
                    break;
                }
            }
            let pos = match pos {
                Some(p) => p,
                None => continue,
            };
            // 裸「水」排除「水果」等复合词
            if *kw == "水" && chars.get(pos + 1).is_some_and(|&c| c == '果') {
                continue;
            }

            // 数值优先在关键词之后（"热量降到1800"），其次之前（"1800大卡"）
            let found =
                number_forward(&chars, pos + len, 6).or_else(|| number_backward(&chars, pos, 6));
            let (value, num_start) = match found {
                Some((v, ns, _)) => (v, ns),
                None => continue,
            };

            let sign = direction_before(&chars, num_start);
            let from = current_of(&current, spec.field);
            let to = if sign != 0 {
                from + sign as f64 * value
            } else {
                // 绝对语义或无方向词：就近数值按新目标理解
                value
            };
            let to = clamp_round(to, spec);
            if (to - from).abs() < f64::EPSILON {
                continue;
            }
            assign(&mut proposal, spec.field, to);
            changes.push(TargetChange {
                field: spec.field.to_string(),
                label: spec.label.to_string(),
                unit: spec.unit.to_string(),
                from,
                to,
            });
            done_fields.push(spec.field);
            break;
        }
    }

    let reply = if changes.is_empty() {
        "没有从这句话里识别出要调整的目标。可以这样说：「把热量降到 1800 大卡」「蛋白质提高到 130 克」。".to_string()
    } else {
        format!(
            "已根据你的描述整理出 {} 项目标调整，确认后立即生效。",
            changes.len()
        )
    };

    Ok(TargetAdjustProposal {
        targets: proposal,
        changes,
        reply,
    })
}

/* ---------- 模型配置（存储层；请求由前端 pi-ai 直连 provider） ---------- */

use chrono::Utc;
use rusqlite::{params, OptionalExtension};

use crate::error::ReinError;
use crate::modules::kb::shard;

use super::chat_page::{backfill_chat_anchors, chat_page_around_conn, chat_page_conn};
use super::models::{
    AiChat, AiChatMessage, AiChatMessageInput, AiChatPage, AiModel, AiModelInput, AiProbeResult,
    AiUsageByModel, AiUsageDay, AiUsageInput, AiUsageSummary, AiUsageTotals, ChatSearchHit,
};

pub(super) const AI_MODEL_COLS: &str =
    "id, name, provider, base_url, api_key, model_id, is_default, vision, thinking, effort, image_max_edge, last_error, \
     source, service_base, price_in, price_out, price_currency, traffic_per_gb, created_at, updated_at";

pub(super) fn ai_model_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiModel> {
    Ok(AiModel {
        id: row.get(0)?,
        name: row.get(1)?,
        provider: row.get(2)?,
        base_url: row.get(3)?,
        api_key: row.get(4)?,
        model_id: row.get(5)?,
        is_default: row.get::<_, i64>(6)? != 0,
        vision: row.get(7)?,
        thinking: row.get(8)?,
        effort: row.get(9)?,
        image_max_edge: row.get(10)?,
        last_error: row.get(11)?,
        source: row.get(12)?,
        service_base: row.get(13)?,
        price_in: row.get(14)?,
        price_out: row.get(15)?,
        price_currency: row.get(16)?,
        traffic_per_gb: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
    })
}

fn validate_ai_model(input: &AiModelInput) -> Result<()> {
    for (label, v) in [
        ("名称", &input.name),
        ("接口地址", &input.base_url),
        ("API Key", &input.api_key),
        ("模型 ID", &input.model_id),
    ] {
        if v.trim().is_empty() {
            return Err(ReinError::Message(format!("{label}不能为空")));
        }
    }
    Ok(())
}

/// 模型列表：默认模型置顶，其余按 id **降序**（新加的在上）。
/// 方向为降序是产品决定：模型清单只会越加越长，最新配上的那个最可能正是要用的，
/// 放顶部比「最早那条永远排第一」更符合实际。
#[tauri::command]
pub fn ai_model_list(state: State<AppState>) -> Result<Vec<AiModel>> {
    let conn = state.db.lock();
    let sql = format!("SELECT {AI_MODEL_COLS} FROM ai_models ORDER BY is_default DESC, id DESC");
    let mut stmt = conn.prepare(&sql)?;
    let models = stmt
        .query_map([], ai_model_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(models)
}

/// 添加模型：库为空时强制设为默认；设为默认则清空其他默认。
#[tauri::command]
pub fn ai_model_add(state: State<AppState>, input: AiModelInput) -> Result<AiModel> {
    validate_ai_model(&input)?;
    let now = Utc::now().to_rfc3339();
    let mut conn = state.db.lock();
    let tx = conn.transaction()?;
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM ai_models", [], |r| r.get(0))?;
    let make_default = input.is_default || count == 0;
    if make_default {
        tx.execute("UPDATE ai_models SET is_default = 0", [])?;
    }
    tx.execute(
        "INSERT INTO ai_models (name, provider, base_url, api_key, model_id, is_default, image_max_edge, price_in, price_out, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        rusqlite::params![
            input.name,
            input.provider,
            input.base_url,
            input.api_key,
            input.model_id,
            make_default as i64,
            input.image_max_edge,
            input.price_in,
            input.price_out,
            now
        ],
    )?;
    let id = tx.last_insert_rowid();
    let sql = format!("SELECT {AI_MODEL_COLS} FROM ai_models WHERE id = ?1");
    let model = tx.query_row(&sql, [id], ai_model_from_row)?;
    tx.commit()?;
    Ok(model)
}

/// 全量更新；探测结果失效清空（模型/地址变化后由前端重新探测）。
#[tauri::command]
pub fn ai_model_update(state: State<AppState>, id: i64, input: AiModelInput) -> Result<()> {
    validate_ai_model(&input)?;
    let mut conn = state.db.lock();
    let tx = conn.transaction()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_models WHERE id = ?1)",
        [id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(ReinError::Message("模型不存在".into()));
    }
    if input.is_default {
        tx.execute("UPDATE ai_models SET is_default = 0", [])?;
    }
    let now = Utc::now().to_rfc3339();
    // online 模型的单价以服务端为准（同步时写入），这里不覆盖；手动模型的单价可随手填改
    tx.execute(
        "UPDATE ai_models SET name = ?1, provider = ?2, base_url = ?3, api_key = ?4, \
         model_id = ?5, is_default = ?6, vision = NULL, thinking = NULL, effort = NULL, \
         image_max_edge = ?7, last_error = NULL, \
         price_in = CASE WHEN source = 'online' THEN price_in ELSE ?9 END, \
         price_out = CASE WHEN source = 'online' THEN price_out ELSE ?10 END, \
         updated_at = ?8 WHERE id = ?11",
        rusqlite::params![
            input.name,
            input.provider,
            input.base_url,
            input.api_key,
            input.model_id,
            input.is_default as i64,
            input.image_max_edge,
            now,
            input.price_in,
            input.price_out,
            id
        ],
    )?;
    tx.commit()?;
    Ok(())
}

/// 删除模型：若删的是默认且仍有剩余，自动把最早一条提升为默认。
#[tauri::command]
pub fn ai_model_delete(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM ai_models WHERE id = ?1", [id])?;
    let has_default: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_models WHERE is_default = 1)",
        [],
        |r| r.get(0),
    )?;
    if !has_default {
        conn.execute(
            "UPDATE ai_models SET is_default = 1 WHERE id = (SELECT MIN(id) FROM ai_models)",
            [],
        )?;
    }
    Ok(())
}

#[tauri::command]
pub fn ai_model_set_default(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.db.lock();
    conn.execute("UPDATE ai_models SET is_default = 0", [])?;
    let n = conn.execute("UPDATE ai_models SET is_default = 1 WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(ReinError::Message("模型不存在".into()));
    }
    Ok(())
}

/// 写回探测结果（max_tokens=1 探测包，由前端执行）。
#[tauri::command]
pub fn ai_model_save_probe(state: State<AppState>, id: i64, result: AiProbeResult) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let conn = state.db.lock();
    let n = conn.execute(
        "UPDATE ai_models SET vision = ?1, thinking = ?2, effort = ?3, last_error = ?4, \
         updated_at = ?5 WHERE id = ?6",
        rusqlite::params![
            result.vision,
            result.thinking,
            result.effort,
            result.error,
            now,
            id
        ],
    )?;
    if n == 0 {
        return Err(ReinError::Message("模型不存在".into()));
    }
    Ok(())
}

/* ---------- 聊天历史 ---------- */

fn ai_chat_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiChat> {
    Ok(AiChat {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

/// 打开（不存在则创建）会话；前端固定使用 'main'。
#[tauri::command]
pub fn ai_chat_ensure(state: State<AppState>, id: String, title: Option<String>) -> Result<AiChat> {
    let now = Utc::now().to_rfc3339();
    let conn = state.db.lock();
    conn.execute(
        "INSERT INTO ai_chats (id, title, created_at, updated_at) \
         VALUES (?1, COALESCE(?2, 'AI 对话'), ?3, ?3) ON CONFLICT(id) DO NOTHING",
        rusqlite::params![id, title, now],
    )?;
    Ok(conn.query_row(
        "SELECT id, title, created_at, updated_at FROM ai_chats WHERE id = ?1",
        [id],
        ai_chat_from_row,
    )?)
}

/// 会话消息（按 seq 升序；保留给旧调用与测试，新前端走 `ai_chat_page`）。
#[tauri::command]
pub fn ai_chat_messages(state: State<AppState>, chat_id: String) -> Result<Vec<AiChatMessage>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, chat_id, seq, role, kind, text, image_base64, mime, payload, created_at, anchor_id \
         FROM ai_chat_messages WHERE chat_id = ?1 ORDER BY seq ASC",
    )?;
    let msgs = stmt
        .query_map([&chat_id], |r| {
            Ok(AiChatMessage {
                id: r.get(0)?,
                chat_id: r.get(1)?,
                seq: r.get(2)?,
                role: r.get(3)?,
                kind: r.get(4)?,
                text: r.get(5)?,
                image_base64: r.get(6)?,
                mime: r.get(7)?,
                payload: r.get(8)?,
                created_at: r.get(9)?,
                anchor_id: r.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(msgs)
}

/// 一页会话消息（整回合切页）。`before_seq` / `after_seq` 是 exclusive 数值边界，
/// 都不传 = 最新一页；`limit_turns` 默认 16、clamp 1..50。
#[tauri::command(async)]
pub fn ai_chat_page(
    state: State<AppState>,
    chat_id: String,
    before_seq: Option<i64>,
    after_seq: Option<i64>,
    limit_turns: Option<i64>,
) -> Result<AiChatPage> {
    let conn = state.db.lock();
    // 0054 是主回填路径；这里兜底「列已加、数据未回填」的旧库（幂等，只补 NULL）。
    backfill_chat_anchors(&conn, &chat_id)?;
    chat_page_conn(&conn, &chat_id, before_seq, after_seq, limit_turns)
}

/// 「查看原文」定位：目标消息所属回合落在页尾。
#[tauri::command(async)]
pub fn ai_chat_page_around(
    state: State<AppState>,
    chat_id: String,
    message_id: String,
    limit_turns: Option<i64>,
) -> Result<AiChatPage> {
    let conn = state.db.lock();
    backfill_chat_anchors(&conn, &chat_id)?;
    chat_page_around_conn(&conn, &chat_id, &message_id, limit_turns)
}

/// terminal assistant：text/analysis 要有正文，food-parse 无论 text 是否为空；
/// `voice` 是 user 消息，不在 terminal 集合里。
fn is_terminal_message(role: &str, kind: &str, text: Option<&str>) -> bool {
    if role != "assistant" {
        return false;
    }
    match kind {
        "text" | "analysis" => text.is_some_and(|t| !t.trim().is_empty()),
        "food-parse" => true,
        _ => false,
    }
}

/// 单调分配会话内 seq：`ai_chat_seq` 只增不减，撤回删后缀后不会复用旧 seq。
///
/// `max(counter, MAX(ai_chat_messages.seq)) + 1` 同时覆盖同步进来的更高 seq。
/// sync apply 的冲突重编号也复用本函数（wiring wave）。
pub(crate) fn allocate_chat_seq(conn: &rusqlite::Connection, chat_id: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO ai_chat_seq (chat_id, next_seq) VALUES (?1, 0) \
         ON CONFLICT(chat_id) DO NOTHING",
        [chat_id],
    )?;
    conn.execute(
        "UPDATE ai_chat_seq SET next_seq = MAX(next_seq, COALESCE((
             SELECT MAX(seq) FROM ai_chat_messages WHERE chat_id = ?1
         ), 0)) + 1 WHERE chat_id = ?1",
        [chat_id],
    )?;
    Ok(conn.query_row(
        "SELECT next_seq FROM ai_chat_seq WHERE chat_id = ?1",
        [chat_id],
        |r| r.get(0),
    )?)
}

/// `ai_chat_append` 的纯消息部分（seq + upsert + 回合 anchor）。
///
/// 不碰 shard 表：conversation shard 的删除/抽取任务由命令层在**同一事务**里补做。
/// 拆开是为了让锚点/seq 单测不依赖 A 域 `shard::store` 的实现进度。
pub(crate) struct AppendOutcome {
    pub seq: i64,
    /// 本条是否是 terminal assistant（抽取决定于它，而不是它是否成为 anchor）。
    pub is_terminal: bool,
    /// anchor 从哪条旧消息移走（需要删它的 conversation shard）。
    pub replaced_anchor: Option<String>,
}

pub(crate) fn append_message_in_tx(
    tx: &rusqlite::Transaction<'_>,
    chat_id: &str,
    input: &AiChatMessageInput,
    now: &str,
) -> Result<AppendOutcome> {
    tx.execute(
        "INSERT INTO ai_chats (id, created_at, updated_at) VALUES (?1, ?2, ?2) \
         ON CONFLICT(id) DO NOTHING",
        params![chat_id, now],
    )?;
    // 先分配再 upsert：id 已存在（流式 upsert）时这个 seq 成为空洞，但计数器继续前进。
    let seq = allocate_chat_seq(tx, chat_id)?;
    tx.execute(
        "INSERT INTO ai_chat_messages \
         (id, chat_id, seq, role, kind, text, image_base64, mime, payload, created_at, anchor_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL) \
         ON CONFLICT(id) DO UPDATE SET \
           role = excluded.role, kind = excluded.kind, text = excluded.text, \
           image_base64 = excluded.image_base64, mime = excluded.mime, payload = excluded.payload",
        params![
            input.id,
            chat_id,
            seq,
            input.role,
            input.kind,
            input.text,
            input.image_base64,
            input.mime,
            input.payload,
            now
        ],
    )?;

    let seq: i64 = tx.query_row(
        "SELECT seq FROM ai_chat_messages WHERE id = ?1",
        [&input.id],
        |r| r.get(0),
    )?;
    let is_terminal = is_terminal_message(&input.role, &input.kind, input.text.as_deref());
    if input.role != "assistant" {
        // user 消息先留 NULL，等本回合 terminal assistant 出现后整回合回填。
        return Ok(AppendOutcome {
            seq,
            is_terminal,
            replaced_anchor: None,
        });
    }

    // 本回合范围 `[turn_start, turn_end)`：turn_start = 之前最近一条 user（没有则 0）；
    // turn_end = 之后第一条 user（没有则 i64::MAX）。
    let turn_start: i64 = tx.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM ai_chat_messages \
         WHERE chat_id = ?1 AND role = 'user' AND seq < ?2",
        params![chat_id, seq],
        |r| r.get(0),
    )?;
    let turn_end: Option<i64> = tx.query_row(
        "SELECT MIN(seq) FROM ai_chat_messages \
         WHERE chat_id = ?1 AND role = 'user' AND seq > ?2",
        params![chat_id, turn_start],
        |r| r.get(0),
    )?;
    let turn_end = turn_end.unwrap_or(i64::MAX);

    // 按 seq（而不是到达顺序）决定 anchor：晚到的旧 terminal upsert 不能把锚点往回搬。
    let newest_terminal_seq: Option<i64> = tx.query_row(
        "SELECT MAX(seq) FROM ai_chat_messages \
         WHERE chat_id = ?1 AND seq >= ?2 AND seq < ?3 AND role = 'assistant' \
           AND ((kind IN ('text','analysis') AND TRIM(COALESCE(text,'')) <> '') \
                OR kind = 'food-parse')",
        params![chat_id, turn_start, turn_end],
        |r| r.get(0),
    )?;
    let newest_assistant_seq: Option<i64> = tx.query_row(
        "SELECT MAX(seq) FROM ai_chat_messages \
         WHERE chat_id = ?1 AND seq >= ?2 AND seq < ?3 AND role = 'assistant'",
        params![chat_id, turn_start, turn_end],
        |r| r.get(0),
    )?;

    let becomes_anchor = if is_terminal {
        newest_terminal_seq == Some(seq)
    } else if newest_terminal_seq.is_some() {
        // terminal 已存在：过程消息继承当前 anchor，不抢锚点。
        false
    } else {
        // 没有 terminal 时退化为回合最后一条 assistant（与 0054 回填一致）。
        newest_assistant_seq == Some(seq)
    };

    let replaced_anchor = if becomes_anchor {
        let old_anchor: Option<String> = tx
            .query_row(
                "SELECT id FROM ai_chat_messages \
                 WHERE chat_id = ?1 AND seq >= ?2 AND seq < ?3 AND anchor_id = id \
                 ORDER BY seq DESC LIMIT 1",
                params![chat_id, turn_start, turn_end],
                |r| r.get(0),
            )
            .optional()?;
        tx.execute(
            "UPDATE ai_chat_messages SET anchor_id = ?1 \
             WHERE chat_id = ?2 AND seq >= ?3 AND seq < ?4",
            params![input.id, chat_id, turn_start, turn_end],
        )?;
        old_anchor.filter(|old| old != &input.id)
    } else {
        // 继承当前 anchor（只在为空时写，不覆盖既有的派生值）。
        tx.execute(
            "UPDATE ai_chat_messages SET anchor_id = ( \
                 SELECT anchor_id FROM ai_chat_messages \
                 WHERE chat_id = ?1 AND seq >= ?2 AND seq < ?3 AND anchor_id IS NOT NULL \
                 ORDER BY seq DESC LIMIT 1 \
             ) WHERE id = ?4 AND anchor_id IS NULL",
            params![chat_id, turn_start, turn_end, input.id],
        )?;
        None
    };

    Ok(AppendOutcome {
        seq,
        is_terminal,
        replaced_anchor,
    })
}

/// append 的 shard 侧效应（与消息写入同一事务）：旧 anchor 的 conversation shard 清理 +
/// terminal 的 extract 任务投递。单独抽出，命令与单测走同一条路径。
fn apply_append_side_effects(
    tx: &rusqlite::Transaction<'_>,
    chat_id: &str,
    message_id: &str,
    outcome: &AppendOutcome,
    now: &str,
) -> Result<()> {
    if let Some(old_anchor) = outcome.replaced_anchor.as_deref() {
        // 空正文的 food-parse 卡只是最终呈现（applyLlmReply 会把正文气泡 morph 成
        // kind='food-parse' 且 text=undefined）。它抢到 anchor 后如果照旧删掉上一锚点的
        // conversation shard，而自己又抽不出文本，整个回合的记忆就归零了。只有新锚点
        // 本身有可读正文时才替换旧 shard；morph 同一消息 id 时 anchor 未变，不需要删。
        let new_readable: bool = tx
            .query_row(
                "SELECT CASE
                     WHEN kind IN ('text','analysis','food-parse')
                      AND TRIM(COALESCE(text,'')) <> '' THEN 1
                     ELSE 0 END
                 FROM ai_chat_messages WHERE id = ?1",
                [message_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0)
            == 1;
        if new_readable {
            shard::store::delete_conversation_shards_for_anchors(
                tx,
                chat_id,
                &[old_anchor.to_string()],
            )?;
        }
    }
    if outcome.is_terminal {
        // 按 anchor 去重（ref_id=本条 id）；不能按 chat，否则连续 terminal 互相覆盖。
        shard::store::enqueue_extract(tx, chat_id, message_id, now)?;
    }
    Ok(())
}

/// 追加消息：按 id 幂等 upsert（重复调用或 commit 状态更新只刷新内容，
/// 保留原 seq 与 created_at），并刷新会话时间。
///
/// 同一事务内完成：单调 seq 分配、upsert、回合 anchor 回填、旧 anchor 的 conversation
/// shard 清理、terminal 的 extract 任务投递。
#[tauri::command]
pub fn ai_chat_append(
    state: State<AppState>,
    chat_id: String,
    input: AiChatMessageInput,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let conn = state.db.lock();
    let tx = conn.unchecked_transaction()?;
    let outcome = append_message_in_tx(&tx, &chat_id, &input, &now)?;
    apply_append_side_effects(&tx, &chat_id, &input.id, &outcome, &now)?;
    tx.execute(
        "UPDATE ai_chats SET updated_at = ?1 WHERE id = ?2",
        params![now, chat_id],
    )?;
    tx.commit()?;
    Ok(())
}

/// 清空会话消息（会话保留），同一事务清理该会话的 conversation shard 与 curated 悬空锚点。
#[tauri::command]
pub fn ai_chat_clear(state: State<AppState>, chat_id: String) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let conn = state.db.lock();
    let tx = conn.unchecked_transaction()?;

    let anchor_ids = conversation_anchor_ids(&tx, &chat_id)?;
    if !anchor_ids.is_empty() {
        shard::store::delete_conversation_shards_for_anchors(&tx, &chat_id, &anchor_ids)?;
    }
    // curated shard 保留，但不能留下指向已删消息的「查看原文」。
    tx.execute(
        "UPDATE memory_shards SET anchor_message_id = NULL, user_message_id = NULL \
         WHERE chat_id = ?1 AND origin != 'conversation'",
        [&chat_id],
    )?;
    tx.execute("DELETE FROM ai_chat_messages WHERE chat_id = ?1", [&chat_id])?;
    tx.execute(
        "UPDATE ai_chats SET updated_at = ?1 WHERE id = ?2",
        params![now, chat_id],
    )?;
    tx.commit()?;
    Ok(())
}

/// 撤回：删除该消息及其后（按 seq 递增顺序）的所有消息，并刷新会话时间。
///
/// conversation shard 按「消息范围内出现过的 anchor_message_id」清理（不能只看
/// `anchor_id=id`：anchor 可能已经移走/被删）；消息删除与 shard 清理同一事务。
#[tauri::command]
pub fn ai_chat_cut(state: State<AppState>, chat_id: String, message_id: String) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let conn = state.db.lock();
    let tx = conn.unchecked_transaction()?;

    let cut_seq: Option<i64> = tx
        .query_row(
            "SELECT seq FROM ai_chat_messages WHERE chat_id = ?1 AND id = ?2",
            params![chat_id, message_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(cut_seq) = cut_seq else {
        // 与旧语义一致：消息不存在 = 没有可撤回的内容，不报错。
        tx.commit()?;
        return Ok(());
    };

    let anchor_ids = conversation_anchor_ids_from_seq(&tx, &chat_id, cut_seq)?;
    if !anchor_ids.is_empty() {
        shard::store::delete_conversation_shards_for_anchors(&tx, &chat_id, &anchor_ids)?;
    }
    // curated shard 保留，但清掉指向被删消息的锚点（否则「查看原文」跳转报消息不存在）。
    tx.execute(
        "UPDATE memory_shards SET anchor_message_id = NULL, user_message_id = NULL \
         WHERE origin != 'conversation' AND anchor_message_id IN ( \
             SELECT id FROM ai_chat_messages WHERE chat_id = ?1 AND seq >= ?2 \
         )",
        params![chat_id, cut_seq],
    )?;
    let n = tx.execute(
        "DELETE FROM ai_chat_messages WHERE chat_id = ?1 AND seq >= ?2",
        params![chat_id, cut_seq],
    )?;
    if n > 0 {
        tx.execute(
            "UPDATE ai_chats SET updated_at = ?1 WHERE id = ?2",
            params![now, chat_id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 该会话所有 conversation shard 的锚点消息 id。
fn conversation_anchor_ids(
    conn: &rusqlite::Connection,
    chat_id: &str,
) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT anchor_message_id FROM memory_shards \
         WHERE origin = 'conversation' AND chat_id = ?1 AND anchor_message_id IS NOT NULL",
    )?;
    let ids = stmt
        .query_map([chat_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// `seq >= cut_seq` 的消息所涉及过的 conversation 锚点消息 id（含已不在消息表中的）。
fn conversation_anchor_ids_from_seq(
    conn: &rusqlite::Connection,
    chat_id: &str,
    cut_seq: i64,
) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT anchor_message_id FROM memory_shards \
         WHERE origin = 'conversation' AND anchor_message_id IS NOT NULL \
           AND anchor_message_id IN ( \
             SELECT id FROM ai_chat_messages WHERE chat_id = ?1 AND seq >= ?2 \
           )",
    )?;
    let ids = stmt
        .query_map(params![chat_id, cut_seq], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// 会话列表：按最近活动倒序（历史抽屉顶部 = 最新聊天）。
#[tauri::command]
pub fn ai_chat_list(state: State<AppState>) -> Result<Vec<AiChat>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at FROM ai_chats ORDER BY updated_at DESC, created_at DESC",
    )?;
    let chats = stmt
        .query_map([], ai_chat_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(chats)
}

/// 重命名会话（首个用户消息后由标题"AI 对话"改为前 16 字）。
#[tauri::command]
pub fn ai_chat_rename(state: State<AppState>, id: String, title: String) -> Result<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(ReinError::Message("会话标题不能为空".into()));
    }
    let now = Utc::now().to_rfc3339();
    let conn = state.db.lock();
    conn.execute(
        "UPDATE ai_chats SET title = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![title, now, id],
    )?;
    Ok(())
}

/// 跨会话全文搜索历史消息（AI 工具「搜索全部上下文」的后端）；最新命中优先。
#[tauri::command]
pub fn ai_chat_search(
    state: State<AppState>,
    keyword: String,
    limit: Option<i64>,
) -> Result<Vec<ChatSearchHit>> {
    let conn = state.db.lock();
    chat_search_conn(&conn, &keyword, limit)
}

/// 连接级实现（AI 内核的工具 `search_history` 直接调用；测试用 migrate_for_test 覆盖）
pub(crate) fn chat_search_conn(
    conn: &rusqlite::Connection,
    keyword: &str,
    limit: Option<i64>,
) -> Result<Vec<ChatSearchHit>> {
    let keyword = keyword.trim();
    if keyword.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(8).clamp(1, 50);
    let like = format!("%{keyword}%");
    let mut stmt = conn.prepare(
        "SELECT m.id, m.chat_id, c.title, m.seq, m.role, m.kind, m.text, m.created_at \
         FROM ai_chat_messages m JOIN ai_chats c ON c.id = m.chat_id \
         WHERE (m.text LIKE ?1 OR m.payload LIKE ?1) \
         ORDER BY m.created_at DESC LIMIT ?2",
    )?;
    let hits = stmt
        .query_map(rusqlite::params![like, limit], |r| {
            Ok(ChatSearchHit {
                message_id: r.get(0)?,
                chat_id: r.get(1)?,
                chat_title: r.get(2)?,
                seq: r.get(3)?,
                role: r.get(4)?,
                kind: r.get(5)?,
                text: r.get(6)?,
                created_at: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(hits)
}

/* ---------- 本机成本账本（服务端另有权威账本，两边可对账） ---------- */

const AI_USAGE_SUM: &str = "COUNT(*) AS calls, \
     COALESCE(SUM(prompt_tokens),0) AS pt, COALESCE(SUM(completion_tokens),0) AS ct, \
     COALESCE(SUM(request_bytes),0) AS rb, COALESCE(SUM(response_bytes),0) AS ob, \
     COALESCE(SUM(cost_model_nano),0) AS cm, COALESCE(SUM(cost_traffic_nano),0) AS ctr, \
     COALESCE(SUM(cost_total_nano),0) AS ctot";

fn usage_totals_from_row(row: &rusqlite::Row<'_>, base: usize) -> rusqlite::Result<AiUsageTotals> {
    Ok(AiUsageTotals {
        calls: row.get(base)?,
        prompt_tokens: row.get(base + 1)?,
        completion_tokens: row.get(base + 2)?,
        request_bytes: row.get(base + 3)?,
        response_bytes: row.get(base + 4)?,
        cost_model_nano: row.get(base + 5)?,
        cost_traffic_nano: row.get(base + 6)?,
        cost_total_nano: row.get(base + 7)?,
    })
}

/// 记一笔用量：一轮对话一行。金额由前端按单价算好（服务端为权威口径，这里只记账）。
#[tauri::command]
pub fn ai_usage_record(state: State<AppState>, input: AiUsageInput) -> Result<()> {
    let conn = state.db.lock();
    usage_record_on(&conn, &input)
}

pub(super) fn usage_record_on(conn: &rusqlite::Connection, input: &AiUsageInput) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO ai_usage (ts, chat_id, model_pk, model_name, model_id, provider, source, \
         prompt_tokens, completion_tokens, request_bytes, response_bytes, \
         cost_model_nano, cost_traffic_nano, cost_total_nano, currency, note) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'CNY', ?15)",
        rusqlite::params![
            now,
            input.chat_id,
            input.model_pk,
            input.model_name,
            input.model_id,
            if input.provider.is_empty() { "openai-compatible".to_string() } else { input.provider.clone() },
            if input.source.is_empty() { "manual".to_string() } else { input.source.clone() },
            input.prompt_tokens,
            input.completion_tokens,
            input.request_bytes,
            input.response_bytes,
            input.cost_model_nano,
            input.cost_traffic_nano,
            input.cost_model_nano + input.cost_traffic_nano,
            input.note,
        ],
    )?;
    Ok(())
}

/// 本机成本汇总：累计 + 今日 + 按天 + 按模型（最近 N 天，默认 30）。
#[tauri::command]
pub fn ai_usage_summary(state: State<AppState>, days: Option<i64>) -> Result<AiUsageSummary> {
    let conn = state.db.lock();
    usage_summary_on(&conn, days.unwrap_or(30).clamp(1, 365))
}

pub(super) fn usage_summary_on(conn: &rusqlite::Connection, days: i64) -> Result<AiUsageSummary> {
    let since = (Utc::now() - chrono::Duration::days(days)).to_rfc3339();
    let today = Utc::now().format("%Y-%m-%d").to_string();

    let sql = format!("SELECT {AI_USAGE_SUM} FROM ai_usage WHERE ts >= ?1");
    let total = conn.query_row(&sql, [since.as_str()], |r| usage_totals_from_row(r, 0))?;

    let today_sql = format!("SELECT {AI_USAGE_SUM} FROM ai_usage WHERE ts >= ?1");
    let today_totals = conn.query_row(&today_sql, [today.as_str()], |r| usage_totals_from_row(r, 0))?;

    let day_sql = format!(
        "SELECT substr(ts, 1, 10) AS d, {AI_USAGE_SUM} FROM ai_usage WHERE ts >= ?1 GROUP BY d ORDER BY d DESC"
    );
    let mut stmt = conn.prepare(&day_sql)?;
    let by_day = stmt
        .query_map([since.as_str()], |r| {
            Ok(AiUsageDay {
                date: r.get(0)?,
                totals: usage_totals_from_row(r, 1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    // model_pk 可能指向已删除的模型：名称仍按记账时的快照聚合
    let model_sql = format!(
        "SELECT model_pk, model_name, model_id, source, {AI_USAGE_SUM} FROM ai_usage WHERE ts >= ?1 \
         GROUP BY model_name, model_id, source ORDER BY ctot DESC"
    );
    let mut stmt = conn.prepare(&model_sql)?;
    let by_model = stmt
        .query_map([since.as_str()], |r| {
            Ok(AiUsageByModel {
                model_pk: r.get(0)?,
                model_name: r.get(1)?,
                model_id: r.get(2)?,
                source: r.get(3)?,
                totals: usage_totals_from_row(r, 4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(AiUsageSummary {
        days,
        since,
        today: today_totals,
        total,
        by_day,
        by_model,
    })
}

/// 清空本机账本（换机 / 重新对账时用；服务端的账不受影响）。
#[tauri::command]
pub fn ai_usage_clear(state: State<AppState>) -> Result<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM ai_usage", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::db::migrate_for_test;

    use super::*;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_for_test(&conn).unwrap();
        // A 域 0053/0054 尚未合入时给会话分页/锚点测试自建 schema；已存在则为空操作。
        super::super::chat_page::ensure_anchor_schema_for_tests(&conn);
        conn
    }

    fn input(id: &str, role: &str, kind: &str, text: Option<&str>) -> AiChatMessageInput {
        AiChatMessageInput {
            id: id.into(),
            role: role.into(),
            kind: kind.into(),
            text: text.map(str::to_string),
            image_base64: None,
            mime: None,
            payload: None,
        }
    }

    /// 走 `append_message_in_tx`（不触发 shard 侧效应）：seq + anchor 逻辑与生产命令一致。
    fn append(conn: &Connection, chat_id: &str, msg: AiChatMessageInput) {
        let tx = conn.unchecked_transaction().unwrap();
        append_message_in_tx(&tx, chat_id, &msg, "2026-11-10T00:00:00+00:00").unwrap();
        tx.commit().unwrap();
    }

    /// 与 `ai_chat_append` 相同的完整事务路径（含 shard 侧效应），供任务投递单测用。
    fn append_full(conn: &Connection, chat_id: &str, msg: AiChatMessageInput) {
        let now = "2026-11-10T00:00:00+00:00";
        let tx = conn.unchecked_transaction().unwrap();
        let outcome = append_message_in_tx(&tx, chat_id, &msg, now).unwrap();
        apply_append_side_effects(&tx, chat_id, &msg.id, &outcome, now).unwrap();
        tx.commit().unwrap();
    }

    fn seq_of(conn: &Connection, id: &str) -> i64 {
        conn.query_row(
            "SELECT seq FROM ai_chat_messages WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn anchor_of(conn: &Connection, id: &str) -> Option<String> {
        conn.query_row(
            "SELECT anchor_id FROM ai_chat_messages WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// user + terminal assistant：整回合 anchor 指向 assistant。
    #[test]
    fn append_sets_anchor_on_terminal_assistant() {
        let conn = fresh();
        append(&conn, "c", input("u1", "user", "text", Some("你好")));
        append(&conn, "c", input("a1", "assistant", "text", Some("你好呀")));

        assert_eq!(anchor_of(&conn, "u1").as_deref(), Some("a1"));
        assert_eq!(anchor_of(&conn, "a1").as_deref(), Some("a1"));
    }

    /// food-parse 即使 text=NULL 也是 terminal。
    #[test]
    fn append_food_parse_without_text_is_terminal() {
        let conn = fresh();
        append(&conn, "c", input("u1", "user", "text", Some("记一下")));
        append(&conn, "c", input("p1", "assistant", "tools", None));
        append(&conn, "c", input("f1", "assistant", "food-parse", None));

        assert_eq!(anchor_of(&conn, "u1").as_deref(), Some("f1"));
        assert_eq!(anchor_of(&conn, "p1").as_deref(), Some("f1"));
    }

    /// 后一条 terminal 到达：整回合 anchor 前移，旧 terminal 也被改写。
    #[test]
    fn append_moves_anchor_when_later_terminal_arrives() {
        let conn = fresh();
        append(&conn, "c", input("u1", "user", "text", Some("一")));
        append(&conn, "c", input("a1", "assistant", "text", Some("一答")));
        append(&conn, "c", input("a2", "assistant", "text", Some("补充")));

        assert_eq!(anchor_of(&conn, "u1").as_deref(), Some("a2"));
        assert_eq!(anchor_of(&conn, "a1").as_deref(), Some("a2"), "旧 terminal 归入新 anchor");
        assert_eq!(anchor_of(&conn, "a2").as_deref(), Some("a2"));
    }

    /// 晚到的旧 terminal upsert 不能把锚点往回搬（按 seq 而非到达顺序）。
    #[test]
    fn append_reupsert_of_earlier_terminal_keeps_newest_anchor() {
        let conn = fresh();
        append(&conn, "c", input("u1", "user", "text", Some("一")));
        append(&conn, "c", input("a1", "assistant", "text", Some("一答")));
        append(&conn, "c", input("a2", "assistant", "text", Some("二答")));
        // 食物卡「加入记录」等操作会再次 upsert 较早的 terminal。
        append(&conn, "c", input("a1", "assistant", "text", Some("一答（已确认）")));

        assert_eq!(anchor_of(&conn, "u1").as_deref(), Some("a2"));
        assert_eq!(anchor_of(&conn, "a1").as_deref(), Some("a2"));
    }

    /// 没有 terminal 时退化为回合最后一条 assistant（process 也会成为落点）。
    #[test]
    fn append_falls_back_to_last_assistant_without_terminal() {
        let conn = fresh();
        append(&conn, "c", input("u1", "user", "text", Some("查一下")));
        append(&conn, "c", input("p1", "assistant", "tools", None));

        assert_eq!(anchor_of(&conn, "u1").as_deref(), Some("p1"));
        assert_eq!(anchor_of(&conn, "p1").as_deref(), Some("p1"));
    }

    /// terminal 之后的过程消息继承 anchor，不抢锚点。
    #[test]
    fn append_does_not_anchor_process_messages() {
        let conn = fresh();
        append(&conn, "c", input("u1", "user", "text", Some("一")));
        append(&conn, "c", input("a1", "assistant", "text", Some("一答")));
        append(&conn, "c", input("p1", "assistant", "tools", None));

        assert_eq!(anchor_of(&conn, "p1").as_deref(), Some("a1"));
        assert_eq!(anchor_of(&conn, "a1").as_deref(), Some("a1"));
    }

    /// 过程消息晚于 terminal 的 seq 到达时仍继承 anchor（同名行为，独立断言 upsert 路径）。
    #[test]
    fn append_process_after_terminal_inherits_anchor() {
        let conn = fresh();
        append(&conn, "c", input("u1", "user", "text", Some("一")));
        append(&conn, "c", input("p1", "assistant", "tools", None));
        append(&conn, "c", input("a1", "assistant", "text", Some("一答")));
        // terminal 之后，工具循环把过程消息重新 upsert 成非空 payload。
        let mut p1 = input("p1", "assistant", "tools", None);
        p1.payload = Some(r#"{"segments":[]}"#.into());
        append(&conn, "c", p1);

        assert_eq!(anchor_of(&conn, "p1").as_deref(), Some("a1"));
    }

    /// 撤回删后缀后，新 append 不复用被删的 seq。
    #[test]
    fn append_after_cut_does_not_reuse_seq() {
        let conn = fresh();
        append(&conn, "c", input("u1", "user", "text", Some("一")));
        append(&conn, "c", input("a1", "assistant", "text", Some("一答")));
        let before = seq_of(&conn, "a1");
        conn.execute(
            "DELETE FROM ai_chat_messages WHERE chat_id = 'c' AND seq >= ?1",
            [before],
        )
        .unwrap();

        append(&conn, "c", input("u2", "user", "text", Some("二")));
        assert!(
            seq_of(&conn, "u2") > before,
            "seq 必须单调，分页游标才不会指向新消息"
        );
    }

    /// 用户消息本身不设 anchor（等 terminal 出现后整回合回填）。
    #[test]
    fn append_leaves_user_without_anchor_until_reply() {
        let conn = fresh();
        append(&conn, "c", input("u1", "user", "text", Some("一")));
        assert_eq!(anchor_of(&conn, "u1"), None);
    }

    /// 跨会话搜索命中带 message_id，供「查看原文」跳转。
    #[test]
    fn chat_search_hit_includes_message_id() {
        let conn = fresh();
        append(&conn, "c", input("u1", "user", "text", Some("膝盖疼")));
        let hits = chat_search_conn(&conn, "膝盖", Some(5)).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, "u1");
        assert_eq!(hits[0].chat_id, "c");
    }

    /// 每个 terminal 各投一个 extract job（ref_id=anchor 消息 id），连续 terminal 不能互相覆盖；
    /// user/过程消息不投。
    #[test]
    fn append_queues_extract_job_per_anchor() {
        let conn = fresh();
        append_full(&conn, "c", input("u1", "user", "text", Some("一")));
        append_full(&conn, "c", input("a1", "assistant", "text", Some("一答")));
        append_full(&conn, "c", input("p1", "assistant", "tools", None));
        append_full(&conn, "c", input("a2", "assistant", "text", Some("补充")));

        let mut stmt = conn
            .prepare(
                "SELECT ref_id FROM memory_jobs WHERE kind = 'extract' ORDER BY ref_id",
            )
            .unwrap();
        let refs = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(refs, vec!["a1", "a2"], "按 anchor 去重，user/过程消息不投");
    }

    /// 一条在线模型调用：100 万输入 token 的模型费 + 128MB 出方向流量费，金额由前端算好传进来
    fn usage(model_id: &str, model_name: &str, model_nano: i64, traffic_nano: i64) -> AiUsageInput {
        AiUsageInput {
            chat_id: Some("main".into()),
            model_pk: Some(1),
            model_name: model_name.into(),
            model_id: model_id.into(),
            provider: "rein-online".into(),
            source: "online".into(),
            prompt_tokens: 1_000_000,
            completion_tokens: 500,
            request_bytes: 1024,
            response_bytes: 128 * 1024 * 1024,
            cost_model_nano: model_nano,
            cost_traffic_nano: traffic_nano,
            note: None,
        }
    }

    /// 模型费与流量费要分开累计、合计到一起：这是「服务器流量 0.8 元/GB」能被看见的前提。
    #[test]
    fn model_and_traffic_cost_add_up_in_the_summary() {
        let conn = fresh();
        usage_record_on(
            &conn,
            &usage("deepseek-flash", "DeepSeek · deepseek-flash", 2_000_000_000, 102_400_000),
        )
        .unwrap();
        let mut second = usage("deepseek-v4-pro", "DeepSeek · deepseek-v4-pro", 1_000_000_000, 0);
        second.prompt_tokens = 100;
        usage_record_on(&conn, &second).unwrap();

        let s = usage_summary_on(&conn, 30).unwrap();
        assert_eq!(s.total.calls, 2);
        assert_eq!(s.total.cost_model_nano, 3_000_000_000, "模型费应累加两笔");
        assert_eq!(s.total.cost_traffic_nano, 102_400_000, "流量费单独累计");
        assert_eq!(s.total.cost_total_nano, 3_102_400_000, "合计 = 模型费 + 流量费");
        assert_eq!(s.total.prompt_tokens, 1_000_100);
        assert_eq!(s.today.calls, 2, "刚写入的两笔应算在今天");
        assert_eq!(s.by_day.len(), 1);
        assert_eq!(s.by_model.len(), 2, "两个模型各自一行");
        assert_eq!(s.by_model[0].model_id, "deepseek-flash", "按花费降序");
        assert_eq!(s.by_model[0].totals.cost_total_nano, 2_102_400_000);
    }

    /// 模型删了账不能丢：否则用户删掉一条模型，历史花费会凭空消失。
    #[test]
    fn usage_rows_outlive_the_model_they_referenced() {
        let conn = fresh();
        usage_record_on(&conn, &usage("gone", "已删除的模型", 1_000_000_000, 0)).unwrap();
        conn.execute("DELETE FROM ai_models", []).unwrap();
        let s = usage_summary_on(&conn, 30).unwrap();
        assert_eq!(s.total.calls, 1);
        assert_eq!(s.by_model[0].model_name, "已删除的模型");
    }

    /// 窗口外的记录不计入（默认 30 天）。
    #[test]
    fn window_excludes_older_rows() {
        let conn = fresh();
        usage_record_on(&conn, &usage("m", "M", 1_000_000_000, 0)).unwrap();
        conn.execute("UPDATE ai_usage SET ts = '2020-01-01T00:00:00+00:00'", [])
            .unwrap();
        let s = usage_summary_on(&conn, 30).unwrap();
        assert_eq!(s.total.calls, 0);
        assert_eq!(s.today.calls, 0);
        assert_eq!(usage_summary_on(&conn, 3650).unwrap().total.calls, 1);
    }
}

