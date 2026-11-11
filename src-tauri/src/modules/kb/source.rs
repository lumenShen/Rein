//! 源数据 → 可检索文档的派生。
//!
//! 每个 `source_type` 一个分支，从源表读出行并派生出「标题 / 正文 / 日期 / 标签 / 元信息」。
//! 源表始终是唯一真源：本文件只读不写，派生结果作为缓存存进 kb_docs.body，
//! 每次脏标记重放都会重新派生。所以知识库陈旧或不一致时，删掉重放即可恢复。
//!
//! 返回 `None` 表示源行已不存在（或不该被索引），调用方据此删除对应 kb_doc。

use rusqlite::{Connection, OptionalExtension, Row};
use serde_json::{json, Value};

use crate::error::Result;

/// 单条文本类附件的正文上限：防止一条超长笔记把整篇文档的向量语义带偏。
const MAX_ATTACHMENT_TEXT: usize = 4000;
/// 单篇正文总长上限：超出部分截断（避免异常数据把一次嵌入拖到 512 token 以上）。
const MAX_BODY: usize = 8000;
/// 会话转录的上限放宽：对话靠 L2 分页逐页读，不必压到普通文档的体量。
const MAX_BODY_CHAT: usize = 24000;

/// 派生结果。`parent_id` 用于把子项（如附件）归到父文档，检索时可折叠。
#[derive(Debug, Clone)]
pub struct Derived {
    pub title: String,
    pub summary: String,
    pub body: String,
    /// 虚拟路径（docs/kb-vfs.md 的命名空间）。派生路径随源数据变化，身份仍由 source_id 保证。
    pub path: Option<String>,
    pub occurred_on: Option<String>,
    pub tags: Vec<String>,
    pub parent_id: Option<String>,
    pub meta: Value,
    /// 0 = 只读派生文档；1 = 笔记 / 记忆
    pub editable: bool,
    /// 系统文件（规范）不可改不可删
    pub system: bool,
    /// 内容类型：text / image / file / audio
    pub kind: String,
}

impl Derived {
    fn new(title: String, body: String) -> Self {
        Self::new_cap(title, body, MAX_BODY)
    }
    /// 会话转录等「天然很长」的内容放宽上限，靠 L2 分页阅读而不是硬截断。
    fn new_cap(title: String, body: String, cap: usize) -> Self {
        let body = truncate(body.trim(), cap);
        let summary = make_summary(&body);
        Self {
            title,
            summary,
            body,
            path: None,
            occurred_on: None,
            tags: Vec::new(),
            parent_id: None,
            meta: json!({}),
            editable: false,
            system: false,
            kind: crate::modules::kb::models::KIND_TEXT.to_string(),
        }
    }
    /// 挂到父文档（附件 → 所属待办/消息）。
    fn under(mut self, parent: impl Into<String>) -> Self {
        self.parent_id = Some(parent.into());
        self
    }
    fn at(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }
    fn writable(mut self) -> Self {
        self.editable = true;
        self
    }
    fn with_kind(mut self, kind: &str) -> Self {
        self.kind = kind.to_string();
        self
    }
    fn on(mut self, date: Option<String>) -> Self {
        self.occurred_on = date.filter(|d| !d.trim().is_empty());
        self
    }
    fn tagged(mut self, tags: Vec<String>) -> Self {
        self.tags = tags.into_iter().filter(|t| !t.trim().is_empty()).collect();
        self
    }
    fn with(mut self, meta: Value) -> Self {
        self.meta = meta;
        self
    }
}

/// L0 摘要：正文首句（到第一个句读为止），最长 120 字符。列表里判断相关性用这个。
fn make_summary(body: &str) -> String {
    if body.is_empty() {
        return String::new();
    }
    let mut end = body.len();
    for (i, ch) in body.char_indices() {
        if matches!(ch, '。' | '！' | '？' | '\n') {
            end = i + ch.len_utf8();
            break;
        }
    }
    let first = body[..end].trim();
    let limited: String = first.chars().take(120).collect();
    if limited.chars().count() < first.chars().count() {
        format!("{limited}…")
    } else {
        limited
    }
}

/// 按字符数截断（不能按字节切，会把 UTF-8 切断）。
pub fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let cut: String = s.chars().take(max_chars).collect();
    format!("{cut}…")
}

fn opt(row: &Row, idx: usize) -> Option<String> {
    row.get::<_, Option<String>>(idx).ok().flatten()
}

fn opt_f64(row: &Row, idx: usize) -> Option<f64> {
    row.get::<_, Option<f64>>(idx).ok().flatten()
}

fn fmt_size(bytes: i64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / 1048576.0)
    } else if bytes >= 1024 {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{bytes} B")
    }
}

fn join_lines(parts: Vec<String>) -> String {
    parts
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/* ---------- 附件 ---------- */

/// 附件的可索引内容。
///
/// **关键约束**：image/file/audio 三种附件的 `content` 是前端 `readAsDataURL` 塞进来的
/// base64 data URL（图片还经过 1600px 压缩，见 TodoEditorSheet.vue），单条可达数百 KB。
/// 把它们放进正文会让知识库体积爆炸且检索价值为零，所以这里**只取 `kind='text'` 的正文**，
/// 其余仅保留「类型 + 文件名 + 体积」这样的描述行。
///
/// 返回 (文本正文列表, 描述行列表)。
fn attachments_digest(raw: Option<&str>) -> (Vec<String>, Vec<String>) {
    let Some(raw) = raw else {
        return (Vec::new(), Vec::new());
    };
    let Ok(items) = serde_json::from_str::<Vec<Value>>(raw) else {
        return (Vec::new(), Vec::new());
    };

    let mut texts = Vec::new();
    let mut lines = Vec::new();
    for it in items {
        let kind = it.get("kind").and_then(|v| v.as_str()).unwrap_or("file");
        let name = it.get("name").and_then(|v| v.as_str()).unwrap_or("未命名");
        match kind {
            "text" => {
                if let Some(c) = it.get("content").and_then(|v| v.as_str()) {
                    let c = c.trim();
                    if !c.is_empty() {
                        texts.push(truncate(c, MAX_ATTACHMENT_TEXT));
                    }
                }
            }
            other => {
                let size = it.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
                let label = match other {
                    "image" => "图片",
                    "audio" => "音频",
                    "video" => "视频",
                    _ => "文件",
                };
                if size > 0 {
                    lines.push(format!("{label}「{name}」({} KB)", size / 1024));
                } else {
                    lines.push(format!("{label}「{name}」"));
                }
            }
        }
    }
    (texts, lines)
}

/* ---------- 派生入口 ---------- */

/// 路径净化：路径段里的分隔符与非法字符替换为 `-`，控制字符丢弃，超长截断。
/// 规范见 docs/kb-vfs.md §2。
pub fn sanitize(raw: &str, max_chars: usize) -> String {
    const BAD: [char; 12] = [
        '/', '\\', ':', '*', '?', '"', '<', '>', '|', '\n', '\r', '\t',
    ];
    let mut out = String::new();
    for ch in raw.trim().chars() {
        if out.chars().count() >= max_chars {
            break;
        }
        if BAD.contains(&ch) {
            out.push('-');
        } else if !ch.is_control() {
            out.push(ch);
        }
    }
    let t = out.trim().trim_matches('-').to_string();
    if t.is_empty() {
        "未命名".to_string()
    } else {
        t
    }
}

/// 统一的路径规则。**所有**派生文档的路径都从这里出——命名空间想调整只改这一处，
/// 才能和 docs/kb-vfs.md 的规范表保持一致。
pub fn build_path(source_type: &str, source_id: &str, d: &Derived) -> Option<String> {
    let title = sanitize(&d.title, 60);
    let date = d
        .occurred_on
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "收件箱".to_string());

    Some(match source_type {
        "todo" => format!("日程/{date}/{title}-{source_id}.md"),
        "workout" => format!("运动/{date}/{title}-{source_id}.md"),
        "meal" => {
            let meal = d
                .meta
                .get("mealLabel")
                .and_then(|v| v.as_str())
                .unwrap_or("餐");
            let food = d
                .meta
                .get("food")
                .and_then(|v| v.as_str())
                .unwrap_or("食物");
            format!(
                "饮食/{date}/{}-{}-{source_id}.md",
                sanitize(meal, 20),
                sanitize(food, 30)
            )
        }
        "body_metric" => format!("体测/{date}-{source_id}.md"),
        "plan" => format!("课程/{title}-{source_id}.md"),
        "food" => format!("食物/{title}-{source_id}.md"),
        "program" => format!("方案/{title}-{source_id}.md"),
        "program_meal" => {
            let (pid, date) = source_id.split_once(':')?;
            format!("菜单/{date}-{pid}.md")
        }
        // 语音纪要：本体（wav）+ 转写文本是同一个多模态节点的两种模态（docs/ai-workspace.md §2），
        // 文本模态落 `语音/{日期}/`，本体经 voice_memos.audio_path 由模态层按需取。
        "voice_memo" => format!("语音/{date}/{title}-{source_id}.md"),
        "chat" => format!("对话/{title}-{source_id}.md"),
        "chat_message" => {
            let chat = sanitize(d.meta.get("chatId")?.as_str()?, 40);
            let seq = d.meta.get("seq")?.as_i64()?;
            format!("对话/{chat}/{seq}-{title}.md")
        }
        "todo_attachment" => {
            let parent = d.parent_id.as_deref()?;
            let name = d.meta.get("attName")?.as_str()?;
            format!("附件/日程/{parent}/{name}")
        }
        "chat_attachment" => {
            let parent = d.parent_id.as_deref()?;
            let name = d.meta.get("attName")?.as_str()?;
            format!("附件/对话/{parent}/{name}")
        }
        "memory" => {
            let mt = d
                .tags
                .first()
                .cloned()
                .unwrap_or_else(|| "preference".into());
            // 有分类时插一层：`记忆/{类型}/{分类}/{主题}-{id}.md`（docs/kb-vfs.md §2）
            let category = d
                .meta
                .get("category")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let sub = if category.is_empty() {
                String::new()
            } else {
                format!("{category}/")
            };
            format!("记忆/{mt}/{sub}{title}-{source_id}.md")
        }
        // 笔记/规范的 path 由 kb_files 直接给定，就是最终路径
        "note" => d.path.clone()?,
        _ => return None,
    })
}

pub fn derive(conn: &Connection, source_type: &str, source_id: &str) -> Result<Option<Derived>> {
    match source_type {
        "todo" => todo_doc(conn, source_id),
        "workout" => workout_doc(conn, source_id),
        "plan" => plan_doc(conn, source_id),
        "meal" => meal_doc(conn, source_id),
        "body_metric" => body_metric_doc(conn, source_id),
        "food" => custom_food_doc(conn, source_id),
        "program" => program_doc(conn, source_id),
        "program_meal" => program_meal_doc(conn, source_id),
        "voice_memo" => voice_memo_doc(conn, source_id),
        "chat_message" => chat_message_doc(conn, source_id),
        "chat" => chat_doc(conn, source_id),
        "chat_attachment" => chat_attachment_doc(conn, source_id),
        "todo_attachment" => todo_attachment_doc(conn, source_id),
        "memory" => memory_doc(conn, source_id),
        "note" => note_doc(conn, source_id),
        _ => Ok(None),
    }
    .map(|opt| {
        // 路径统一在这里落：分支只管内容，命名空间只在这一处定义
        opt.map(|mut d| {
            if d.path.is_none() {
                d.path = build_path(source_type, source_id, &d);
            }
            d
        })
    })
}

fn todo_doc(conn: &Connection, id: &str) -> Result<Option<Derived>> {
    let row = conn
        .query_row(
            "SELECT title, notes, date, start_min, duration_min, category, priority, status, subtasks, attachments, rec_key
             FROM todos WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    opt(r, 1),
                    opt(r, 2),
                    opt(r, 3),
                    opt(r, 4),
                    r.get::<_, String>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, String>(7)?,
                    opt(r, 8),
                    opt(r, 9),
                    opt(r, 10),
                ))
            },
        )
        .optional()?;
    let Some((
        title,
        notes,
        date,
        start_min,
        duration_min,
        category,
        priority,
        status,
        subtasks,
        attachments,
        rec_key,
    )) = row
    else {
        return Ok(None);
    };

    let mut parts = vec![title.clone()];
    if let Some(n) = &notes {
        parts.push(n.clone());
    }
    // 子任务：只取标题与完成态，作为清单正文
    if let Some(raw) = &subtasks {
        if let Ok(items) = serde_json::from_str::<Vec<Value>>(raw) {
            let lines: Vec<String> = items
                .iter()
                .filter_map(|it| {
                    let t = it.get("title").and_then(|v| v.as_str())?;
                    let done = it.get("done").and_then(|v| v.as_bool()).unwrap_or(false);
                    Some(format!("{} {t}", if done { "✓" } else { "○" }))
                })
                .collect();
            if !lines.is_empty() {
                parts.push(format!("子任务：{}", lines.join("、")));
            }
        }
    }
    let (attach_texts, attach_lines) = attachments_digest(attachments.as_deref());
    let has_attachments = !attach_texts.is_empty() || !attach_lines.is_empty();
    parts.extend(attach_lines);
    parts.extend(attach_texts);

    let mut tags = vec![category];
    if priority > 0 {
        tags.push(format!("priority:{priority}"));
    }
    // 重复实例是模板的近似副本，检索时按 rec_key 折叠；模板自身 rec_rule 非空但 rec_key 为空。
    if let Some(k) = &rec_key {
        tags.push("recurring".to_string());
        let _ = k;
    }

    Ok(Some(
        Derived::new(title, join_lines(parts))
            .on(date)
            .tagged(tags)
            .with(json!({
                "startMin": start_min,
                "durationMin": duration_min,
                "status": status,
                "recKey": rec_key,
                "hasAttachments": has_attachments,
            })),
    ))
}

fn workout_doc(conn: &Connection, id: &str) -> Result<Option<Derived>> {
    let row = conn
        .query_row(
            "SELECT name, type, date, duration_min, kcal, intensity, note FROM workouts WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, f64>(3)?,
                    r.get::<_, f64>(4)?,
                    r.get::<_, String>(5)?,
                    opt(r, 6),
                ))
            },
        )
        .optional()?;
    let Some((name, wtype, date, duration_min, kcal, intensity, note)) = row else {
        return Ok(None);
    };

    // 逐组明细是训练记录的核心内容，按动作聚合后写进正文：
    // 「深蹲 5 组 × 8 次 60kg（含热身 2 组）」比逐行堆 20 条 set 更利于检索与嵌入。
    let mut sets = conn.prepare(
        "SELECT exercise_name, weight_kg, reps, sec, warmup FROM workout_sets WHERE workout_id = ?1 ORDER BY id",
    )?;
    let rows = sets.query_map([id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<f64>>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, Option<i64>>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })?;

    // (动作名, 正式组数, 拉起的重量, 次数/秒, 热身组数)
    type SetAgg = (i64, f64, Option<i64>, Option<i64>, i64);
    let mut order: Vec<String> = Vec::new();
    let mut agg: std::collections::HashMap<String, SetAgg> = std::collections::HashMap::new();
    for r in rows {
        let (ex, w, reps, sec, warmup) = r?;
        let e = agg.entry(ex.clone()).or_insert_with(|| {
            order.push(ex.clone());
            (0, 0.0, reps, sec, 0)
        });
        if warmup == 1 {
            e.4 += 1;
        } else {
            e.0 += 1;
            if let Some(w) = w {
                if w > e.1 {
                    e.1 = w;
                }
            }
        }
        if reps.is_some() {
            e.2 = reps;
        }
        if sec.is_some() {
            e.3 = sec;
        }
    }

    let mut parts = vec![name.clone()];
    if let Some(n) = &note {
        parts.push(n.clone());
    }
    let set_lines: Vec<String> = order
        .iter()
        .map(|ex| {
            let (sets_n, top_w, reps, sec, warmups) = agg[ex];
            let mut s = format!("{ex} {sets_n} 组");
            if let Some(r) = reps {
                s.push_str(&format!(" × {r} 次"));
            }
            if let Some(sc) = sec {
                s.push_str(&format!(" {sc} 秒"));
            }
            if top_w > 0.0 {
                s.push_str(&format!(" {:.1}kg", top_w));
            }
            if warmups > 0 {
                s.push_str(&format!("（含热身 {warmups} 组）"));
            }
            s
        })
        .collect();
    if !set_lines.is_empty() {
        parts.push(set_lines.join("；"));
    }

    Ok(Some(
        Derived::new(name, join_lines(parts))
            .on(Some(date))
            .tagged(vec![wtype, intensity])
            .with(json!({
                "durationMin": duration_min,
                "kcal": kcal,
                "exerciseCount": order.len(),
            })),
    ))
}

fn plan_doc(conn: &Connection, id: &str) -> Result<Option<Derived>> {
    let row = conn
        .query_row(
            "SELECT name, subtitle, workout_type, exercises_json, equipment, est_duration_min
             FROM workout_plans WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    opt(r, 4),
                    opt(r, 5),
                ))
            },
        )
        .optional()?;
    let Some((name, subtitle, wtype, exercises_json, equipment, est)) = row else {
        return Ok(None);
    };

    // 动作要领（tips）是课程里唯一有「知识」价值的部分，必须进正文。
    let mut parts = vec![name.clone()];
    if !subtitle.is_empty() {
        parts.push(subtitle.clone());
    }
    let mut muscles: Vec<String> = Vec::new();
    if let Ok(items) = serde_json::from_str::<Vec<Value>>(&exercises_json) {
        let lines: Vec<String> = items
            .iter()
            .filter_map(|it| {
                let en = it.get("name").and_then(|v| v.as_str())?;
                let sets = it.get("sets").and_then(|v| v.as_i64()).unwrap_or(0);
                let reps = it.get("reps").and_then(|v| v.as_i64());
                let kind = it
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("strength");
                let tips = it.get("tips").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(group) = it.get("group").and_then(|v| v.as_str()) {
                    if !group.is_empty() {
                        muscles.push(group.to_string());
                    }
                }
                let mut s = match kind {
                    "strength" => match reps {
                        Some(r) => format!("{en} {sets} 组 × {r} 次"),
                        None => format!("{en} {sets} 组"),
                    },
                    _ => format!("{en} {sets} 组"),
                };
                if !tips.is_empty() {
                    s.push_str(&format!("：{tips}"));
                }
                Some(s)
            })
            .collect();
        if !lines.is_empty() {
            parts.push(lines.join("\n"));
        }
    }

    Ok(Some(
        Derived::new(name, join_lines(parts))
            .tagged(
                std::iter::once(wtype)
                    .chain(equipment)
                    .chain(muscles)
                    .collect(),
            )
            .with(json!({ "estDurationMin": est })),
    ))
}

fn meal_doc(conn: &Connection, id: &str) -> Result<Option<Derived>> {
    let row = conn
        .query_row(
            "SELECT m.date, m.meal_type, m.grams, m.units, m.unit_name, m.quantity_mode, m.note, m.source,
                    f.name, f.kcal, f.protein, f.carb, f.fat
             FROM meal_logs m JOIN foods f ON f.id = m.food_id WHERE m.id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, f64>(2)?,
                    opt_f64(r, 3),
                    opt(r, 4),
                    r.get::<_, String>(5)?,
                    opt(r, 6),
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, f64>(9)?,
                    r.get::<_, f64>(10)?,
                    r.get::<_, f64>(11)?,
                    r.get::<_, f64>(12)?,
                ))
            },
        )
        .optional()?;
    let Some((
        date,
        meal_type,
        grams,
        units,
        unit_name,
        _qmode,
        note,
        source,
        food,
        kcal,
        protein,
        carb,
        fat,
    )) = row
    else {
        return Ok(None);
    };

    let meal_label = meal_label(&meal_type).to_string();
    // 份量换算已在 log_meal 完成（grams 恒为换算后克重），这里直接按 grams 折算营养，
    // 与 get_daily_summary 的口径保持一致。
    let ratio = grams / 100.0;
    let portion = match (units, unit_name.as_deref()) {
        (Some(u), Some(u_name)) if u > 0.0 => format!("{u:.0} {u_name}（{grams:.0}g）"),
        _ => format!("{grams:.0}g"),
    };
    let title = format!("{date} {meal_label} · {food}");
    let body = join_lines(vec![
        format!("{food} {portion}"),
        format!(
            "热量 {:.0} kcal，蛋白 {:.1}g，碳水 {:.1}g，脂肪 {:.1}g",
            kcal * ratio,
            protein * ratio,
            carb * ratio,
            fat * ratio
        ),
        note.unwrap_or_default(),
    ]);

    Ok(Some(
        Derived::new(title, body)
            .on(Some(date))
            .tagged(vec![meal_type, source])
            .with(json!({
                "grams": grams, "kcal100g": kcal,
                "mealLabel": meal_label, "food": food,
            })),
    ))
}

fn meal_label(meal_type: &str) -> &str {
    match meal_type {
        "breakfast" => "早餐",
        "lunch" => "午餐",
        "dinner" => "晚餐",
        "snack" => "加餐",
        other => other,
    }
}

fn body_metric_doc(conn: &Connection, id: &str) -> Result<Option<Derived>> {
    let row = conn
        .query_row(
            "SELECT date, weight_kg, height_cm FROM body_metrics WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<f64>>(1)?,
                    r.get::<_, Option<f64>>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((date, weight, height)) = row else {
        return Ok(None);
    };

    let mut parts = Vec::new();
    if let Some(w) = weight {
        parts.push(format!("体重 {w:.1} kg"));
    }
    if let Some(h) = height {
        parts.push(format!("身高 {h:.0} cm"));
    }
    Ok(Some(
        Derived::new(format!("{date} 体测"), join_lines(parts))
            .on(Some(date.clone()))
            .tagged(vec!["body_metric".into()])
            .with(json!({ "weightKg": weight, "heightCm": height })),
    ))
}

fn custom_food_doc(conn: &Connection, id: &str) -> Result<Option<Derived>> {
    // 只索引用户自建食物：内置 2722 条种子已有 LCS 精确检索，重复索引只会淹没检索结果。
    let row = conn
        .query_row(
            "SELECT name, category, kcal, protein, carb, fat, default_unit
             FROM foods WHERE id = ?1 AND is_custom = 1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    opt(r, 1),
                    r.get::<_, f64>(2)?,
                    r.get::<_, f64>(3)?,
                    r.get::<_, f64>(4)?,
                    r.get::<_, f64>(5)?,
                    opt(r, 6),
                ))
            },
        )
        .optional()?;
    let Some((name, category, kcal, protein, carb, fat, unit)) = row else {
        return Ok(None);
    };

    let body = format!(
        "{name}（每 100g：热量 {kcal:.0} kcal，蛋白 {protein:.1}g，碳水 {carb:.1}g，脂肪 {fat:.1}g{}）",
        unit.map(|u| format!("，常用单位 {u}")).unwrap_or_default()
    );
    Ok(Some(
        Derived::new(name, body)
            .tagged(vec![category.unwrap_or_else(|| "自定义食物".into())])
            .with(json!({ "isCustom": true })),
    ))
}

fn program_doc(conn: &Connection, id: &str) -> Result<Option<Derived>> {
    let row = conn
        .query_row(
            "SELECT goal, tier, status, weeks, params_json, adjustments_json, activated_at
             FROM programs WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    opt(r, 6),
                ))
            },
        )
        .optional()?;
    let Some((goal, tier, status, weeks, params_json, adjustments_json, activated_at)) = row else {
        return Ok(None);
    };

    let tier_label = match tier.as_str() {
        "conservative" => "稳健",
        "aggressive" => "激进",
        _ => "均衡",
    };
    let goal_label = match goal.as_str() {
        "lose" => "减脂",
        "gain" => "增肌",
        _ => "保持",
    };
    let mut parts = vec![format!(
        "{weeks} 周{tier_label}方案，目标{goal_label}（{status}）"
    )];

    if let Ok(p) = serde_json::from_str::<Value>(&params_json) {
        let params = p.get("params").cloned().unwrap_or(Value::Null);
        if !params.is_null() {
            let mut bits = Vec::new();
            if let Some(v) = params.get("trainingDays").and_then(|v| v.as_i64()) {
                bits.push(format!("每周训练 {v} 天"));
            }
            if let Some(v) = params.get("mealsCount").and_then(|v| v.as_i64()) {
                bits.push(format!("每日 {v} 餐"));
            }
            for (key, label) in [("tdee", "TDEE"), ("bmr", "BMR")] {
                if let Some(v) = params.get(key).and_then(|v| v.as_f64()) {
                    bits.push(format!("{label} {v:.0} kcal"));
                }
            }
            for (key, label) in [("proteinPerKg", "蛋白 g/kg"), ("kcalDelta", "热量偏移")] {
                if let Some(v) = params.get(key).and_then(|v| v.as_f64()) {
                    bits.push(format!("{label} {v:.1}"));
                }
            }
            if !bits.is_empty() {
                parts.push(bits.join("，"));
            }
        }
        // 方案内容里的每日菜单只取菜品名，不塞整份营养明细
        if let Some(days) = p.get("days").and_then(|v| v.as_array()) {
            let dishes: Vec<String> = days
                .iter()
                .filter_map(|d| d.get("meals").and_then(|m| m.as_array()))
                .flatten()
                .filter_map(|m| m.get("name").and_then(|v| v.as_str()))
                .take(24)
                .map(|s| s.to_string())
                .collect();
            if !dishes.is_empty() {
                parts.push(format!("菜单：{}", dishes.join("、")));
            }
        }
    }

    // 调整历史是「为什么方案长这样」的唯一记录，价值很高，必须进正文。
    if let Ok(adj) = serde_json::from_str::<Vec<Value>>(&adjustments_json) {
        let lines: Vec<String> = adj
            .iter()
            .rev()
            .take(8)
            .filter_map(|a| {
                let at = a.get("at").and_then(|v| v.as_str()).unwrap_or("");
                let summary = a.get("summary").and_then(|v| v.as_str()).unwrap_or("");
                let src = a.get("source").and_then(|v| v.as_str()).unwrap_or("ai");
                let changes = a
                    .get("changes")
                    .and_then(|v| v.as_array())
                    .map(|cs| {
                        cs.iter()
                            .filter_map(|c| {
                                let label = c.get("label").and_then(|v| v.as_str())?;
                                let before =
                                    c.get("before").and_then(|v| v.as_str()).unwrap_or("?");
                                let after = c.get("after").and_then(|v| v.as_str()).unwrap_or("?");
                                Some(format!("{label} {before}→{after}"))
                            })
                            .collect::<Vec<_>>()
                            .join("，")
                    })
                    .unwrap_or_default();
                if summary.is_empty() && changes.is_empty() {
                    return None;
                }
                Some(format!(
                    "{at}（{src}）{summary}{}",
                    if changes.is_empty() {
                        String::new()
                    } else {
                        format!("：{changes}")
                    }
                ))
            })
            .collect();
        if !lines.is_empty() {
            parts.push(format!("调整历史：\n{}", lines.join("\n")));
        }
    }

    Ok(Some(
        Derived::new(
            format!("健康方案 · {goal_label}{tier_label}"),
            join_lines(parts),
        )
        .on(activated_at)
        .tagged(vec![goal, tier, status])
        .with(json!({ "weeks": weeks })),
    ))
}

fn program_meal_doc(conn: &Connection, source_id: &str) -> Result<Option<Derived>> {
    // source_id 形如 "{program_id}:{date}"
    let Some((pid, date)) = source_id.split_once(':') else {
        return Ok(None);
    };
    let row = conn
        .query_row(
            "SELECT meals_json FROM program_meals WHERE program_id = ?1 AND date = ?2",
            [pid, date],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    let Some(meals_json) = row else {
        return Ok(None);
    };

    let mut parts = Vec::new();
    if let Ok(items) = serde_json::from_str::<Vec<Value>>(&meals_json) {
        for m in items {
            let name = m.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let mt = m.get("mealType").and_then(|v| v.as_str()).unwrap_or("");
            let items_txt = m
                .get("items")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|i| {
                            let n = i.get("name").and_then(|v| v.as_str())?;
                            let g = i.get("grams").and_then(|v| v.as_f64());
                            Some(match g {
                                Some(g) => format!("{n} {g:.0}g"),
                                None => n.to_string(),
                            })
                        })
                        .collect::<Vec<_>>()
                        .join("、")
                })
                .unwrap_or_default();
            let kcal = m.get("kcal").and_then(|v| v.as_f64());
            let line = format!(
                "{} {name}：{items_txt}{}",
                meal_label(mt),
                kcal.map(|k| format!("（约 {k:.0} kcal）"))
                    .unwrap_or_default()
            );
            if !items_txt.is_empty() || !name.is_empty() {
                parts.push(line);
            }
        }
    }
    if parts.is_empty() {
        return Ok(None);
    }

    Ok(Some(
        Derived::new(format!("{date} 方案菜单"), join_lines(parts))
            .on(Some(date.to_string()))
            .tagged(vec!["program_meal".into()])
            .with(json!({ "programId": pid })),
    ))
}

fn voice_memo_doc(conn: &Connection, id: &str) -> Result<Option<Derived>> {
    let row = conn
        .query_row(
            "SELECT title, sentences, summary, duration_ms, created_at FROM voice_memos WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((title, sentences, summary, duration_ms, created_at)) = row else {
        return Ok(None);
    };

    let mut parts = Vec::new();
    if let Ok(items) = serde_json::from_str::<Vec<Value>>(&sentences) {
        let text: String = items
            .iter()
            .filter_map(|s| s.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join("");
        if !text.trim().is_empty() {
            parts.push(text);
        }
    }
    if let Ok(items) = serde_json::from_str::<Vec<Value>>(&summary) {
        let lines: Vec<String> = items
            .iter()
            .filter_map(|s| s.get("text").and_then(|v| v.as_str()))
            .map(|t| t.to_string())
            .collect();
        if !lines.is_empty() {
            parts.push(format!("要点：{}", lines.join("；")));
        }
    }
    if parts.is_empty() {
        return Ok(None);
    }

    let fallback = format!("语音纪要 {}", truncate(&created_at, 16));
    Ok(Some(
        Derived::new(
            if title.trim().is_empty() {
                fallback
            } else {
                title
            },
            join_lines(parts),
        )
        .on(Some(created_at.chars().take(10).collect()))
        .tagged(vec!["voice_memo".into()])
        .with(json!({ "durationMs": duration_ms })),
    ))
}

fn chat_message_doc(conn: &Connection, id: &str) -> Result<Option<Derived>> {
    let row = conn
        .query_row(
            "SELECT chat_id, role, kind, text, created_at, seq FROM ai_chat_messages WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    opt(r, 3),
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((chat_id, role, kind, text, created_at, seq)) = row else {
        return Ok(None);
    };

    // 助手回复按输出协议存的是 JSON（{"kind":"chat","text":"…"}），
    // 直接索引整段 JSON 会把协议噪声带进检索，所以先拆出 text 字段。
    let body = text
        .as_deref()
        .map(unwrap_protocol_json)
        .unwrap_or_default();
    if body.trim().is_empty() {
        return Ok(None);
    }

    let role_label = if role == "user" { "我说" } else { "AI 说" };
    Ok(Some(
        Derived::new(format!("{role_label}：{}", truncate(&body, 40)), body)
            .on(Some(created_at.chars().take(10).collect()))
            .tagged(vec!["chat".into(), kind, role])
            .with(json!({ "chatId": chat_id, "seq": seq })),
    ))
}

/// 会话文档：`对话/{标题}-{chatId}.md`。正文是全文转录，靠 L2 分页逐页读。
///
/// 把「会话」也编目进来是需求：AI 与用户都要能按对话回看历史，而不是只在单条消息粒度上命中。
/// 转录跳过工具过程卡与空消息，AI 的 JSON 输出先拆出正文。
fn chat_doc(conn: &Connection, chat_id: &str) -> Result<Option<Derived>> {
    let row = conn
        .query_row(
            "SELECT title, created_at, updated_at FROM ai_chats WHERE id = ?1",
            [chat_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((title, created_at, _updated_at)) = row else {
        return Ok(None);
    };

    let mut stmt = conn.prepare(
        "SELECT seq, role, kind, text FROM ai_chat_messages WHERE chat_id = ?1 ORDER BY seq",
    )?;
    let rows: Vec<(i64, String, String, Option<String>)> = stmt
        .query_map([chat_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let total = rows.len();
    let mut lines: Vec<String> = Vec::with_capacity(total);
    for (seq, role, kind, text) in rows {
        if kind == "tools" {
            continue;
        }
        let Some(t) = text else { continue };
        let body = unwrap_protocol_json(&t);
        if body.trim().is_empty() {
            continue;
        }
        let who = if role == "user" { "用户" } else { "AI" };
        lines.push(format!("[{seq}] {who}：{body}"));
    }
    if lines.is_empty() {
        return Ok(None);
    }

    let label = sanitize(&title, 40);
    let transcript = lines.join("\n");
    let count = lines.len();
    Ok(Some(
        Derived::new_cap(
            format!("对话 · {label}"),
            format!("与用户共 {count} 条消息的完整转录：\n{transcript}"),
            MAX_BODY_CHAT,
        )
        .on(Some(created_at.chars().take(10).collect()))
        .tagged(vec!["chat".into()])
        .with(json!({
            "chatId": chat_id,
            "messageCount": total,
            "indexedMessages": count,
        })),
    ))
}

/// 待办附件编目：`附件/日程/{todoId}/{序号}-{文件名}`。
///
/// 身份用「todoId:序号」——附件存在 JSON 数组里，重排会变序，但派生是整体的：
/// 越界即返回 None，孤儿文档由对账自动清掉，所以序号身份是自愈的。
/// 二进制内容绝不进正文（与 attachments_digest 同一条铁律）。
fn todo_attachment_doc(conn: &Connection, source_id: &str) -> Result<Option<Derived>> {
    let Some((todo_id, idx_raw)) = source_id.split_once(':') else {
        return Ok(None);
    };
    let Ok(idx) = idx_raw.parse::<usize>() else {
        return Ok(None);
    };
    let row = conn
        .query_row(
            "SELECT title, date, attachments FROM todos WHERE id = ?1",
            [todo_id],
            |r| Ok((r.get::<_, String>(0)?, opt(r, 1), opt(r, 2))),
        )
        .optional()?;
    let Some((todo_title, date, raw)) = row else {
        return Ok(None);
    };
    let Some(raw) = raw else {
        return Ok(None);
    };
    let Ok(items) = serde_json::from_str::<Vec<Value>>(&raw) else {
        return Ok(None);
    };
    let Some(item) = items.get(idx) else {
        return Ok(None);
    };

    let kind = item
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("file")
        .to_string();
    let name = item
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("未命名")
        .to_string();
    let size = item.get("size").and_then(|v| v.as_i64()).unwrap_or(0);

    let (body, k) = match kind.as_str() {
        "text" => (
            item.get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            crate::modules::kb::models::KIND_TEXT,
        ),
        "image" => (
            format!(
                "图片「{name}」（{}），随待办《{todo_title}》保存；图片本体在待办的 attachments 里",
                fmt_size(size)
            ),
            crate::modules::kb::models::KIND_IMAGE,
        ),
        "audio" => (
            format!(
                "录音「{name}」（{}），随待办《{todo_title}》保存；音频本体可用 read_modal 取",
                fmt_size(size)
            ),
            crate::modules::kb::models::KIND_AUDIO,
        ),
        "video" => (
            format!(
                "视频「{name}」（{}），随待办《{todo_title}》保存；视频本体可用 read_modal 取",
                fmt_size(size)
            ),
            crate::modules::kb::models::KIND_VIDEO,
        ),
        other => (
            format!(
                "文件「{name}」（{}，类型 {other}），随待办《{todo_title}》保存",
                fmt_size(size)
            ),
            crate::modules::kb::models::KIND_FILE,
        ),
    };
    if body.trim().is_empty() {
        return Ok(None);
    }

    Ok(Some(
        Derived::new(name.clone(), body)
            .under(todo_id.to_string())
            .on(date)
            .tagged(vec!["附件".into(), kind.clone()])
            .with_kind(k)
            .with(json!({
                "todoId": todo_id,
                "attIdx": idx,
                "attName": format!("{}-{}", idx, sanitize(&name, 40)),
                "attKind": kind,
                "size": size,
            })),
    ))
}

/// 对话附件编目：`附件/对话/{messageId}/图片-…` 与 `…/文档名`。
/// 图片本体在消息的 image_base64；文档全文在消息正文里（含《名称》标记），这里只做编目。
fn chat_attachment_doc(conn: &Connection, source_id: &str) -> Result<Option<Derived>> {
    let Some((msg_id, what)) = source_id.rsplit_once(':') else {
        return Ok(None);
    };
    let row = conn
        .query_row(
            "SELECT chat_id, kind, text, image_base64, created_at FROM ai_chat_messages WHERE id = ?1",
            [msg_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    opt(r, 2),
                    opt(r, 3),
                    r.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((chat_id, kind, text, image, created_at)) = row else {
        return Ok(None);
    };
    let date: String = created_at.chars().take(10).collect();

    let (name, body, k, size) = match what {
        "img" => {
            let Some(img) = image else { return Ok(None) };
            // base64 长度 ×3/4 ≈ 原始字节数，编目精度足够
            let sz = (img.len() as i64) * 3 / 4;
            let ext = if img.starts_with("data:image/png") {
                "png"
            } else if img.starts_with("data:image/webp") {
                "webp"
            } else {
                "jpg"
            };
            (
                format!("图片-{date}.{ext}"),
                format!("随对话消息保存的图片（{sz}）；图片本体在消息的 image_base64 里"),
                crate::modules::kb::models::KIND_IMAGE,
                sz,
            )
        }
        "doc" => {
            if kind != "doc" {
                return Ok(None);
            }
            // 文档名在消息正文的《》标记里（composeOutgoingText 的固定格式）
            let t = text.unwrap_or_default();
            let Some(name_end) = t.find("》，已解析全文如下") else {
                return Ok(None);
            };
            let Some(name_start) = t[..name_end].rfind("附带文档《") else {
                return Ok(None);
            };
            let name = t[name_start + "附带文档《".len()..name_end].to_string();
            if name.trim().is_empty() {
                return Ok(None);
            }
            (
                name.clone(),
                format!("随对话消息保存的文档《{name}》；已解析全文在同会话的消息正文里"),
                crate::modules::kb::models::KIND_FILE,
                0,
            )
        }
        _ => return Ok(None),
    };

    Ok(Some(
        Derived::new(name.clone(), body)
            .under(msg_id.to_string())
            .on(Some(date.clone()))
            .tagged(vec!["附件".into(), k.to_string()])
            .with_kind(k)
            .with(json!({
                "chatId": chat_id,
                "messageId": msg_id,
                "attName": sanitize(&name, 40),
                "size": size,
            })),
    ))
}

/// 用户真实文件：`笔记/{名称}.md`、系统文件（`规范/`、`系统提示词/`）与多模态节点。
/// 内容真源在 kb_files，这里只是把它派生进检索编目。
fn note_doc(conn: &Connection, id: &str) -> Result<Option<Derived>> {
    let row = conn
        .query_row(
            // 回收站里的文件视同不存在：返回 None 会让派生文档在重放时被删掉
            "SELECT path, content, system, created_at, kind FROM kb_files
             WHERE id = ?1 AND trashed_at IS NULL",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((path, content, system, created_at, node_kind)) = row else {
        return Ok(None);
    };
    if content.trim().is_empty() {
        return Ok(None);
    }

    // 标题 = 路径末段去扩展名
    let base = path.rsplit('/').next().unwrap_or(&path);
    let title = base
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(base)
        .to_string();
    let is_system = system != 0;

    // 编目 kind：目录 / 多模态节点（按主模态）/ 默认文本
    let doc_kind = match node_kind.as_str() {
        crate::modules::kb::models::FILE_KIND_FOLDER => crate::modules::kb::models::KIND_FOLDER,
        crate::modules::kb::models::FILE_KIND_MULTIMODAL => primary_modal_kind(conn, id),
        _ => crate::modules::kb::models::KIND_TEXT,
    };

    let mut d = Derived::new(title, content)
        .at(path.clone())
        .on(Some(created_at.chars().take(10).collect()))
        .tagged(vec![if is_system {
            "规范".into()
        } else {
            "笔记".into()
        }])
        .with_kind(doc_kind)
        .with(json!({ "fileId": id, "filePath": path }));
    d.system = is_system;
    d.editable = !is_system;
    Ok(Some(d))
}

/// 多模态节点的主模态：视频优先，其次音频、图片，否则按普通文件。
fn primary_modal_kind(conn: &Connection, file_id: &str) -> &'static str {
    use crate::modules::kb::models::*;
    let modals: Vec<String> = conn
        .prepare("SELECT modal FROM kb_assets WHERE file_id = ?1")
        .and_then(|mut stmt| {
            let rows = stmt.query_map([file_id], |r| r.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
        })
        .unwrap_or_default();
    for (modal, kind) in [
        (MODAL_VIDEO, KIND_VIDEO),
        (MODAL_AUDIO, KIND_AUDIO),
        (MODAL_IMAGE, KIND_IMAGE),
    ] {
        if modals.iter().any(|m| m == modal) {
            return kind;
        }
    }
    KIND_FILE
}

/// 从 AI 输出协议里取出人类可读文本。不是该协议就原样返回。
fn unwrap_protocol_json(raw: &str) -> String {
    let t = raw.trim();
    // 工具过程卡存的是纯 JSON，正文无检索价值
    if t.starts_with("{\"kind\":\"tools\"") || t.starts_with("{\"kind\": \"tools\"") {
        return String::new();
    }
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        if let Some(kind) = v.get("kind").and_then(|k| k.as_str()) {
            if kind == "chat" {
                return v
                    .get("text")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
            }
            if kind == "food" {
                let items = v
                    .get("items")
                    .and_then(|x| x.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|i| i.get("foodName").and_then(|v| v.as_str()))
                            .collect::<Vec<_>>()
                            .join("、")
                    })
                    .unwrap_or_default();
                return if items.is_empty() {
                    String::new()
                } else {
                    format!("记录饮食：{items}")
                };
            }
        }
    }
    t.to_string()
}

fn memory_doc(conn: &Connection, id: &str) -> Result<Option<Derived>> {
    // 记忆分片层（memory_shards）：active/dormant 有镜像，archived 与已合并的没有。
    // id 是 memory_shards.id 的十进制字符串（index::id_query("memory") 现在读新表）。
    let row = conn
        .query_row(
            "SELECT mem_type, topic, category, content, confidence, created_at, state,
                    consolidated_into
             FROM memory_shards WHERE id = CAST(?1 AS INTEGER)",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, f64>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                ))
            },
        )
        .optional()?;
    let Some((mem_type, topic, category, content, confidence, created_at, state, consolidated_into)) =
        row
    else {
        return Ok(None);
    };
    // 归档记忆退出检索；已合并的 shard 只保留溯源，不再出现在 kb_docs/ kb_search。
    if state == "archived" || consolidated_into.is_some() {
        return Ok(None);
    }

    let title = if topic.trim().is_empty() {
        format!("记忆 · {}", mem_type_label(&mem_type))
    } else {
        format!("记忆 · {topic}")
    };
    let mut tags = vec![mem_type.clone()];
    if !category.trim().is_empty() {
        tags.push(category.clone());
    }
    Ok(Some(
        Derived::new(title, content)
            .on(Some(created_at.chars().take(10).collect()))
            .tagged(tags)
            // 记忆是知识库里唯一「AI 与用户都能改」的派生文档（docs/kb-vfs.md §6）
            .writable()
            .with(json!({
                "confidence": confidence,
                "memType": mem_type,
                "category": category,
            })),
    ))
}

pub fn mem_type_label(t: &str) -> &str {
    match t {
        "preference" => "偏好",
        "constraint" => "约束",
        "event" => "事件",
        "entity" => "实体",
        "profile" => "画像",
        "pattern" => "规律",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_takes_first_sentence() {
        assert_eq!(make_summary("膝盖不舒服。所以换了动作。"), "膝盖不舒服。");
        assert_eq!(make_summary("没有句读的一整段"), "没有句读的一整段");
    }

    #[test]
    fn summary_is_length_capped() {
        let long = "甲".repeat(300);
        let s = make_summary(&long);
        assert_eq!(s.chars().count(), 121); // 120 + 省略号
        assert!(s.ends_with('…'));
    }

    #[test]
    fn truncate_is_char_safe() {
        // 按字节切会 panic 或产生乱码，这里必须按字符
        let s = "深蹲五组每组八次注意膝盖不要内扣";
        assert_eq!(truncate(s, 100), s);
        assert_eq!(truncate(s, 3), "深蹲五…");
    }

    /// 这是本模块最重要的一条约束：附件里的 base64 data URL 绝不能进正文。
    #[test]
    fn attachments_never_leak_base64() {
        let payload = format!(
            r#"[{{"kind":"image","name":"膝盖.jpg","content":"data:image/jpeg;base64,{}","size":307200}},
                {{"kind":"text","name":"医嘱.txt","content":"避免深蹲超过 60kg"}},
                {{"kind":"audio","name":"语音.m4a","content":"data:audio/mp4;base64,AAAA","size":20480}}]"#,
            "A".repeat(5000)
        );
        let (texts, lines) = attachments_digest(Some(&payload));

        assert_eq!(texts.len(), 1);
        assert_eq!(texts[0], "避免深蹲超过 60kg");
        for t in &texts {
            assert!(!t.contains("base64"), "base64 泄漏进正文");
            assert!(!t.contains("data:"), "data URL 泄漏进正文");
        }
        assert!(lines
            .iter()
            .any(|l| l.contains("图片「膝盖.jpg」") && l.contains("300 KB")));
        assert!(lines.iter().any(|l| l.contains("音频「语音.m4a」")));
        // 图片的 5000 个 A 一个都不能出现在任何输出里
        assert!(!lines.iter().any(|l| l.contains("AAAA")));
    }

    #[test]
    fn attachments_handles_garbage() {
        assert_eq!(attachments_digest(None).0.len(), 0);
        assert_eq!(attachments_digest(Some("not json")).0.len(), 0);
        assert_eq!(attachments_digest(Some("[]")).0.len(), 0);
    }

    #[test]
    fn attachment_text_is_capped() {
        let huge = "字".repeat(MAX_ATTACHMENT_TEXT + 500);
        let payload = format!(r#"[{{"kind":"text","name":"长文.txt","content":"{huge}"}}]"#);
        let (texts, _) = attachments_digest(Some(&payload));
        assert_eq!(texts[0].chars().count(), MAX_ATTACHMENT_TEXT + 1); // + 省略号
    }

    /// 记忆路径带分类层级；归档记忆不再派生（对账时会自动摘掉检索文档）。
    #[test]
    fn memory_path_uses_category_and_hides_archived() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn.execute(
            "INSERT INTO memory_shards
               (idempotency_key, origin, mem_type, topic, category, content, confidence,
                base_weight, floor, stability, last_event_at, state, created_at, updated_at)
             VALUES ('manual:test', 'manual_write', 'constraint', '膝盖', '健康/训练',
                     '深蹲不宜超过 60kg', 0.9, 2.5, 0.15, 20.0,
                     datetime('now'), 'active', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        let id = conn.last_insert_rowid();

        let d = derive(&conn, "memory", &id.to_string()).unwrap().unwrap();
        assert_eq!(
            d.path.as_deref(),
            Some(format!("记忆/constraint/健康/训练/记忆 · 膝盖-{id}.md").as_str())
        );

        conn.execute(
            "UPDATE memory_shards SET state='archived', archived_at=datetime('now'),
                                      archived_reason='outdated'
             WHERE id = ?1",
            [id],
        )
        .unwrap();
        assert!(
            derive(&conn, "memory", &id.to_string()).unwrap().is_none(),
            "归档记忆应不再派生"
        );
    }

    #[test]
    fn protocol_json_is_unwrapped() {
        assert_eq!(
            unwrap_protocol_json(r#"{"kind":"chat","text":"好的，已记录。"}"#),
            "好的，已记录。"
        );
        assert_eq!(
            unwrap_protocol_json(
                r#"{"kind":"food","items":[{"foodName":"米饭"},{"foodName":"鸡蛋"}]}"#
            ),
            "记录饮食：米饭、鸡蛋"
        );
        // 工具过程卡无检索价值
        assert_eq!(unwrap_protocol_json(r#"{"kind":"tools","calls":[]}"#), "");
        // 普通文本原样保留
        assert_eq!(unwrap_protocol_json("就是一句普通话"), "就是一句普通话");
    }
}
