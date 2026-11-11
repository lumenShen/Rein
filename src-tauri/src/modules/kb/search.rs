//! 检索：结构化过滤 → FTS5(trigram) 召回 / 向量召回 → RRF 融合 → L0 摘要投影。
//!
//! 两个必须处理的现实约束：
//!
//! 1. **FTS5 trigram 不支持少于 3 个字符的查询**（SQLite 官方限制）。中文里「膝盖」「深蹲」这类
//!    两字词极其常见，所以短查询必须回落到 `LIKE '%…%'`，长查询也在 FTS 无果时用 LIKE 兜底。
//! 2. **向量召回是暴力扫描**。10k 块 × 512 维 × 4B ≈ 20 MB，单次约 5–15 ms，对 Rein 的数据规模
//!    完全够用，因此不引入任何向量索引库。向量写入时已做 L2 归一化，余弦退化成点积。
//!
//! 融合用 RRF（Reciprocal Rank Fusion，k=60）：只依赖排名不依赖分数量纲，
//! 省去了给 bm25 与余弦分数调权的麻烦。

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection};

use crate::error::Result;

use super::models::{KbGlobHit, KbHit, KbQuery};

/// 单路召回的候选数。
const RECALL: usize = 50;
/// RRF 平滑常数。60 是原论文的推荐值，对排名前几位做了适度抑制。
const RRF_K: f64 = 60.0;

/// 结构化过滤：把 sources/日期/tags 编译成 SQL 片段 + 绑定值。
struct Filter {
    sql: String,
    binds: Vec<Value>,
}

fn build_filter(q: &KbQuery, enabled: &[String]) -> Filter {
    let mut sql = String::new();
    let mut binds: Vec<Value> = Vec::new();

    // 未显式指定 sources 时，只搜用户启用的来源类别
    let sources: Vec<String> = if q.sources.is_empty() {
        enabled.to_vec()
    } else {
        q.sources
            .iter()
            .filter(|s| enabled.iter().any(|e| e == *s))
            .cloned()
            .collect()
    };
    if !sources.is_empty() {
        let ph = vec!["?"; sources.len()].join(",");
        sql.push_str(&format!(" AND d.source_type IN ({ph})"));
        binds.extend(sources.into_iter().map(Value::Text));
    }
    if let Some(from) = q.from.as_ref().filter(|s| !s.is_empty()) {
        sql.push_str(" AND d.occurred_on IS NOT NULL AND d.occurred_on >= ?");
        binds.push(Value::Text(from.clone()));
    }
    if let Some(to) = q.to.as_ref().filter(|s| !s.is_empty()) {
        sql.push_str(" AND d.occurred_on IS NOT NULL AND d.occurred_on <= ?");
        binds.push(Value::Text(to.clone()));
    }
    for tag in q.tags.iter().filter(|t| !t.trim().is_empty()) {
        // tags 是 JSON 数组文本，按带引号的精确词匹配，避免 "腿" 命中 "腿部"
        sql.push_str(" AND d.tags LIKE ?");
        binds.push(Value::Text(format!("%\"{tag}\"%")));
    }

    Filter { sql, binds }
}

/// 构造 FTS5 MATCH 表达式。
///
/// 用户查询里可能含 FTS5 语法字符（`"` `*` `(` `:` `-` 等），直接拼进 MATCH 会语法报错。
/// 做法是把查询按空白切成若干词，每个词用双引号包成短语（内部 `"` 翻倍转义），词间用 AND。
pub(crate) fn match_expr(query: &str) -> String {
    let terms: Vec<String> = query
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    terms.join(" AND ")
}

/// 查询是否短于 trigram 的下限（按 unicode 字符数，不是字节）。
pub(crate) fn too_short_for_trigram(query: &str) -> bool {
    query.trim().chars().count() < 3
}

/// 单路召回结果：doc 级（同一 doc 的多个块只留最好的一个）。
struct Recall {
    doc_id: i64,
    raw_score: f64,
    chunk_text: String,
}

fn fts_recall(conn: &Connection, q: &KbQuery, f: &Filter) -> Result<Vec<Recall>> {
    if too_short_for_trigram(&q.query) {
        return Ok(Vec::new());
    }
    let expr = match_expr(&q.query);
    if expr.is_empty() {
        return Ok(Vec::new());
    }

    let sql = format!(
        "SELECT d.id, bm25(kb_fts) AS r, c.text
         FROM kb_fts
         JOIN kb_chunks c ON c.id = kb_fts.rowid
         JOIN kb_docs d ON d.id = c.doc_id
         WHERE kb_fts MATCH ?{}
         ORDER BY r
         LIMIT ?",
        f.sql
    );
    let mut binds: Vec<Value> = vec![Value::Text(expr)];
    binds.extend(f.binds.clone());
    binds.push(Value::Integer(RECALL as i64));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(binds), |r| {
        Ok(Recall {
            doc_id: r.get(0)?,
            raw_score: r.get::<_, f64>(1)?,
            chunk_text: r.get::<_, String>(2)?,
        })
    })?;

    // 每个 doc 只保留 bm25 最优的块
    let mut out: Vec<Recall> = Vec::new();
    for r in rows {
        let r = r?;
        if let Some(prev) = out.iter_mut().find(|x| x.doc_id == r.doc_id) {
            if r.raw_score < prev.raw_score {
                *prev = r;
            }
        } else {
            out.push(r);
        }
    }
    Ok(out)
}

/// LIKE 兜底：短查询、FTS 无果、或查询含 FTS 无法表达的形式时使用。
fn like_recall(conn: &Connection, q: &KbQuery, f: &Filter) -> Result<Vec<Recall>> {
    let needle = q.query.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT d.id, c.text
         FROM kb_chunks c
         JOIN kb_docs d ON d.id = c.doc_id
         WHERE c.text LIKE ?{}
         LIMIT ?",
        f.sql
    );
    let mut binds: Vec<Value> = vec![Value::Text(format!("%{needle}%"))];
    binds.extend(f.binds.clone());
    binds.push(Value::Integer(RECALL as i64));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(binds), |r| {
        Ok(Recall {
            doc_id: r.get(0)?,
            // LIKE 没有相关性分数，用「查询词出现次数」当粗排依据
            raw_score: 0.0,
            chunk_text: r.get::<_, String>(1)?,
        })
    })?;

    let mut out: Vec<Recall> = Vec::new();
    for r in rows {
        let r = r?;
        if !out.iter().any(|x| x.doc_id == r.doc_id) {
            out.push(r);
        }
    }
    Ok(out)
}

/// 中文无分词器时的模糊兜底。
///
/// trigram 只能匹配**连续子串**，所以「膝盖内扣」搜不到「膝盖不要内扣」——两者没有共同的
/// 3 字窗口。这里把查询切成 2 字窗口，用 OR 命中数达到阈值来判定相关：
/// 「膝盖内扣」→ [膝盖, 盖内, 内扣]，目标文本命中 膝盖✓ 内扣✓ = 2 分，达到阈值 2 即入选。
///
/// 阈值取 60%（下限 2）是精度与召回的折中：低于此会把「训练」这类高频词带进来。
/// 这是全表 LIKE 扫描，但在 Rein 的数据规模（万级块）下是毫秒量级。
fn bigram_recall(conn: &Connection, q: &KbQuery, f: &Filter) -> Result<Vec<Recall>> {
    let chars: Vec<char> = q
        .query
        .trim()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    // 少于 4 字时 2 字窗口太少，交给整串 LIKE 更精确
    if chars.len() < 4 {
        return Ok(Vec::new());
    }
    let grams: Vec<String> = chars.windows(2).map(|w| w.iter().collect()).collect();
    let need = ((grams.len() as f64 * 0.6).ceil() as i64).max(2);
    if need > grams.len() as i64 {
        return Ok(Vec::new());
    }

    // 计分表达式在 SELECT 与 WHERE 各出现一次，绑定值也要跟着复制一份
    let score_expr = grams
        .iter()
        .map(|_| "(c.text LIKE ?)")
        .collect::<Vec<_>>()
        .join(" + ");
    let sql = format!(
        "SELECT d.id, ({score_expr}) AS s, c.text
         FROM kb_chunks c
         JOIN kb_docs d ON d.id = c.doc_id
         WHERE ({score_expr}) >= ?{}
         ORDER BY s DESC
         LIMIT ?",
        f.sql
    );

    let mut binds: Vec<Value> = Vec::new();
    binds.extend(grams.iter().map(|g| Value::Text(format!("%{g}%"))));
    binds.extend(grams.iter().map(|g| Value::Text(format!("%{g}%"))));
    binds.push(Value::Integer(need));
    binds.extend(f.binds.clone());
    binds.push(Value::Integer(RECALL as i64));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(binds), |r| {
        Ok(Recall {
            doc_id: r.get(0)?,
            raw_score: r.get::<_, i64>(1)? as f64,
            chunk_text: r.get::<_, String>(2)?,
        })
    })?;

    let mut out: Vec<Recall> = Vec::new();
    for r in rows {
        let r = r?;
        if !out.iter().any(|x| x.doc_id == r.doc_id) {
            out.push(r);
        }
    }
    Ok(out)
}

/// 向量召回：暴力扫描 + 点积（向量已归一化）。
fn vector_recall(
    conn: &Connection,
    query_vec: &[f32],
    model_id: &str,
    f: &Filter,
) -> Result<Vec<Recall>> {
    let sql = format!(
        "SELECT d.id, v.vec, c.text
         FROM kb_vectors v
         JOIN kb_chunks c ON c.id = v.chunk_id
         JOIN kb_docs d ON d.id = c.doc_id
         WHERE v.model_id = ?{}",
        f.sql
    );
    let mut binds: Vec<Value> = vec![Value::Text(model_id.to_string())];
    binds.extend(f.binds.clone());

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(binds), |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, Vec<u8>>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;

    let mut scored: Vec<Recall> = Vec::new();
    for r in rows {
        let (doc_id, blob, text) = r?;
        let Some(vec) = blob_to_vec(&blob) else {
            continue;
        };
        if vec.len() != query_vec.len() {
            continue;
        }
        let dot: f32 = vec.iter().zip(query_vec).map(|(a, b)| a * b).sum();
        // 维度不符/未归一化的脏数据会让点积异常，直接丢掉
        if !dot.is_finite() {
            continue;
        }
        scored.push(Recall {
            doc_id,
            raw_score: dot as f64,
            chunk_text: text,
        });
    }

    // 每个 doc 留最优块，再取全局 top RECALL
    scored.sort_by(|a, b| b.raw_score.partial_cmp(&a.raw_score).unwrap());
    let mut out: Vec<Recall> = Vec::new();
    for r in scored {
        if out.iter().any(|x| x.doc_id == r.doc_id) {
            continue;
        }
        out.push(r);
        if out.len() >= RECALL {
            break;
        }
    }
    Ok(out)
}

pub fn blob_to_vec(blob: &[u8]) -> Option<Vec<f32>> {
    if blob.len() % 4 != 0 {
        return None;
    }
    Some(
        blob.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

pub fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// 围绕查询词截取片段。向量命中的块里可能没有字面查询词，那就取块首。
fn make_snippet(text: &str, needle: &str, width: usize) -> String {
    let flat = super::chunk::normalize(text);
    let needle = needle.trim();
    if needle.is_empty() {
        return super::source::truncate(&flat, width);
    }
    // 中文大小写无意义，这里只做简单的原样查找
    if let Some(pos) = flat.find(needle) {
        let chars: Vec<char> = flat.chars().collect();
        let byte_to_char = flat[..pos].chars().count();
        let half = width / 2;
        let start = byte_to_char.saturating_sub(half);
        let end = (byte_to_char + needle.chars().count() + half).min(chars.len());
        let mut s: String = chars[start..end].iter().collect();
        if start > 0 {
            s = format!("…{s}");
        }
        if end < chars.len() {
            s = format!("{s}…");
        }
        return s;
    }
    super::source::truncate(&flat, width)
}

fn parse_tags(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

/// 主检索入口。
///
/// `query_vec` 为 None 时退化为纯关键词检索（keyword 模式，或本地模型尚未就绪）。
pub fn search(
    conn: &Connection,
    q: &KbQuery,
    enabled: &[String],
    query_vec: Option<&[f32]>,
    active_model: Option<&str>,
) -> Result<Vec<KbHit>> {
    let limit = q.limit.unwrap_or(8).clamp(1, 30) as usize;
    let filter = build_filter(q, enabled);

    let fts = fts_recall(conn, q, &filter)?;
    // FTS 无果就补一次 LIKE：可能是查询里含 FTS 语法字符，或触发词太生僻
    // 召回阶梯：上一级有结果就不往下降，尽量保住精度。
    //   FTS5(trigram) 精确子串、按 bm25 排序
    //   → 整串 LIKE（含 3 字以下的短词，trigram 用不了）
    //   → 二字窗口模糊（中文无分词器时唯一能兜住「膝盖内扣」→「膝盖不要内扣」的手段）
    let mut like = Vec::new();
    let mut fuzzy = Vec::new();
    if fts.is_empty() {
        like = like_recall(conn, q, &filter)?;
        if like.is_empty() {
            fuzzy = bigram_recall(conn, q, &filter)?;
        }
    }
    let vecs = match (query_vec, active_model) {
        (Some(v), Some(m)) => vector_recall(conn, v, m, &filter)?,
        _ => Vec::new(),
    };

    // RRF：sum(1/(k + rank))，rank 从 1 起
    let mut fused: Vec<(i64, f64, String)> = Vec::new();
    let bump = |doc_id: i64, rank: usize, text: &str, fused: &mut Vec<(i64, f64, String)>| {
        let add = 1.0 / (RRF_K + rank as f64);
        if let Some(e) = fused.iter_mut().find(|e| e.0 == doc_id) {
            e.1 += add;
        } else {
            fused.push((doc_id, add, text.to_string()));
        }
    };

    let mut matched = std::collections::HashMap::new();
    for (rank, r) in fts.iter().enumerate() {
        matched.insert(r.doc_id, "fts");
        bump(r.doc_id, rank + 1, &r.chunk_text, &mut fused);
    }
    for (rank, r) in like.iter().enumerate() {
        matched.insert(r.doc_id, "like");
        bump(r.doc_id, rank + 1, &r.chunk_text, &mut fused);
    }
    for (rank, r) in fuzzy.iter().enumerate() {
        matched.insert(r.doc_id, "fuzzy");
        bump(r.doc_id, rank + 1, &r.chunk_text, &mut fused);
    }
    for (rank, r) in vecs.iter().enumerate() {
        let entry = matched.entry(r.doc_id).or_insert("vector");
        if *entry != "vector" {
            *entry = "hybrid";
        }
        bump(r.doc_id, rank + 1, &r.chunk_text, &mut fused);
    }

    fused.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    fused.truncate(limit);

    // 水合文档字段
    let mut hits = Vec::with_capacity(fused.len());
    for (doc_id, score, chunk_text) in fused {
        let row = conn.query_row(
            "SELECT source_type, source_id, title, occurred_on, tags, meta_json,
                    path, editable, system, kind
             FROM kb_docs WHERE id = ?1",
            [doc_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, i64>(8)?,
                    r.get::<_, String>(9)?,
                ))
            },
        );
        let Ok((
            source_type,
            source_id,
            title,
            occurred_on,
            tags,
            meta_raw,
            path,
            editable,
            system,
            kind,
        )) = row
        else {
            continue;
        };

        // 重复待办的实例是模板的近似副本，按 recKey 折叠只留一条，避免占满结果位。
        let meta: serde_json::Value =
            serde_json::from_str(&meta_raw).unwrap_or(serde_json::Value::Null);
        if let Some(rec_key) = meta.get("recKey").and_then(|v| v.as_str()) {
            let already = hits.iter().any(|h: &KbHit| {
                h.source_type == source_type && h.snippet.contains(rec_key) && h.title == title
            });
            if already {
                continue;
            }
        }

        hits.push(KbHit {
            id: doc_id,
            source_type,
            source_id,
            path,
            editable: editable != 0,
            system: system != 0,
            kind,
            title,
            snippet: make_snippet(&chunk_text, &q.query, 120),
            occurred_on,
            tags: parse_tags(&tags),
            score,
            matched: matched.get(&doc_id).copied().unwrap_or("fts").to_string(),
        });
    }

    Ok(hits)
}

/// 无查询词的「浏览」模式：按日期倒序列出某类内容。AI 问「最近有什么」时用。
pub fn browse(conn: &Connection, q: &KbQuery, enabled: &[String]) -> Result<Vec<KbHit>> {
    let limit = q.limit.unwrap_or(8).clamp(1, 30);
    let filter = build_filter(q, enabled);
    let sql = format!(
        "SELECT id, source_type, source_id, title, summary, occurred_on, tags,
                path, editable, system, kind
         FROM kb_docs d
         WHERE 1=1{}
         ORDER BY COALESCE(d.occurred_on, '') DESC, d.id DESC
         LIMIT ?",
        filter.sql
    );
    let mut binds = filter.binds.clone();
    binds.push(Value::Integer(limit));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(binds), |r| {
        Ok(KbHit {
            id: r.get(0)?,
            source_type: r.get(1)?,
            source_id: r.get(2)?,
            path: r.get(7)?,
            editable: r.get::<_, i64>(8)? != 0,
            system: r.get::<_, i64>(9)? != 0,
            kind: r.get(10)?,
            title: r.get(3)?,
            snippet: r.get(4)?,
            occurred_on: r.get(5)?,
            tags: parse_tags(&r.get::<_, String>(6)?),
            score: 0.0,
            matched: "browse".to_string(),
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/* ---------- glob ---------- */

#[derive(Clone, Copy, PartialEq)]
enum GlobTok {
    /// `*`：任意长（含空），但不跨 `/`
    Star,
    /// `**`：任意长（含空），跨 `/`
    StarStar,
    /// `?`：恰好一个字符，但不跨 `/`
    Q,
    Lit(char),
}

fn tokenize_glob(pattern: &str) -> Vec<GlobTok> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '*' {
            if chars.get(i + 1) == Some(&'*') {
                toks.push(GlobTok::StarStar);
                i += 2;
                while i < chars.len() && chars[i] == '*' {
                    i += 1;
                }
            } else {
                toks.push(GlobTok::Star);
                i += 1;
            }
        } else if chars[i] == '?' {
            toks.push(GlobTok::Q);
            i += 1;
        } else {
            toks.push(GlobTok::Lit(chars[i]));
            i += 1;
        }
    }
    toks
}

/// glob 匹配：`*` 不跨目录、`**` 跨目录、`?` 单字符（docs/kb-vfs.md §4）。
/// DP 实现（O(模式×路径)），没有回溯爆炸的风险。
fn glob_match_inner(pattern: &str, path: &str) -> bool {
    let toks = tokenize_glob(pattern);
    let t: Vec<char> = path.chars().collect();
    let m = toks.len();
    let n = t.len();
    let mut dp = vec![vec![false; n + 1]; m + 1];
    dp[0][0] = true;
    for i in 1..=m {
        // 星号类 token 可以匹配空串
        dp[i][0] = matches!(toks[i - 1], GlobTok::Star | GlobTok::StarStar) && dp[i - 1][0];
    }
    for i in 1..=m {
        for j in 1..=n {
            dp[i][j] = match toks[i - 1] {
                GlobTok::StarStar => dp[i - 1][j] || dp[i][j - 1],
                GlobTok::Star => dp[i - 1][j] || (t[j - 1] != '/' && dp[i][j - 1]),
                GlobTok::Q => t[j - 1] != '/' && dp[i - 1][j - 1],
                GlobTok::Lit(c) => t[j - 1] == c && dp[i - 1][j - 1],
            };
        }
    }
    dp[m][n]
}

/// glob 匹配入口。额外采用 git globstar 语义：`a/**/b` 也匹配 `a/b`（零层目录）。
pub fn glob_match(pattern: &str, path: &str) -> bool {
    if glob_match_inner(pattern, path) {
        return true;
    }
    if let Some((head, tail)) = pattern.split_once("/**/") {
        return glob_match_inner(&format!("{head}/{tail}"), path);
    }
    false
}

/// 按路径模式列文档（`ls` 的等价物）。按路径排序，天然形成目录视图。
/// 上限放宽到 500：文件库浏览页要整目录拉取（AI 工具层另有自己的 200 上限）。
pub fn glob(conn: &Connection, pattern: &str, limit: i64) -> Result<Vec<KbGlobHit>> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 500);
    let mut stmt = conn.prepare(
        "SELECT id, path, source_type, title, kind, editable, system, occurred_on
         FROM kb_docs WHERE path IS NOT NULL ORDER BY path",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, Option<String>>(7)?,
        ))
    })?;

    let mut out = Vec::new();
    for r in rows {
        let (id, path, source_type, title, kind, editable, system, occurred_on) = r?;
        if glob_match(pattern, &path) {
            out.push(KbGlobHit {
                id,
                path,
                source_type,
                title,
                kind,
                editable: editable != 0,
                system: system != 0,
                occurred_on,
            });
            if out.len() >= limit as usize {
                break;
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::kb::models::{KbQuery, SOURCE_TYPES};

    fn all_sources() -> Vec<String> {
        SOURCE_TYPES.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn short_query_falls_back_because_trigram_needs_three() {
        assert!(too_short_for_trigram("深蹲"));
        assert!(too_short_for_trigram("ab"));
        assert!(!too_short_for_trigram("深蹲伤膝"));
        assert!(!too_short_for_trigram("abc"));
    }

    #[test]
    fn match_expr_quotes_and_ands_terms() {
        assert_eq!(match_expr("腿部 训练"), "\"腿部\" AND \"训练\"");
        assert_eq!(match_expr("  "), "");
    }

    /// FTS5 语法字符必须被吃掉，否则 MATCH 会直接报错
    #[test]
    fn match_expr_escapes_fts_syntax() {
        assert_eq!(match_expr(r#"深蹲"OR"x"#), r#""深蹲""OR""x""#);
        assert_eq!(match_expr("a*b"), "\"a*b\"");
        assert_eq!(match_expr("(深蹲)"), "\"(深蹲)\"");
        assert_eq!(match_expr("NOT AND OR"), "\"NOT\" AND \"AND\" AND \"OR\"");
    }

    #[test]
    fn filter_covers_sources_dates_and_tags() {
        let q = KbQuery {
            query: "x".into(),
            sources: vec!["todo".into(), "workout".into()],
            from: Some("2026-09-01".into()),
            to: Some("2026-09-30".into()),
            tags: vec!["腿部".into()],
            limit: None,
        };
        let f = build_filter(&q, &all_sources());
        assert!(f.sql.contains("d.source_type IN (?,?)"));
        assert!(f.sql.contains("d.occurred_on >= ?"));
        assert!(f.sql.contains("d.occurred_on <= ?"));
        assert!(f.sql.contains("d.tags LIKE ?"));
        // 绑定顺序：sources 两个占位 → from → to → tag
        assert_eq!(f.binds.len(), 5);
        assert_eq!(f.binds[0], Value::Text("todo".into()));
        assert_eq!(f.binds[2], Value::Text("2026-09-01".into()));
        assert_eq!(f.binds[4], Value::Text("%\"腿部\"%".into()));
    }

    #[test]
    fn filter_intersects_requested_with_enabled() {
        // 用户关掉了 chat_message，即使显式请求也不该搜
        let q = KbQuery {
            query: "x".into(),
            sources: vec!["todo".into(), "chat_message".into()],
            ..Default::default()
        };
        let enabled = vec!["todo".to_string(), "workout".to_string()];
        let f = build_filter(&q, &enabled);
        assert!(f.sql.contains("IN (?)"));
        assert_eq!(f.binds.len(), 1);
        assert_eq!(f.binds[0], Value::Text("todo".into()));
    }

    #[test]
    fn filter_uses_enabled_when_sources_empty() {
        let q = KbQuery {
            query: "x".into(),
            ..Default::default()
        };
        let f = build_filter(&q, &all_sources());
        assert!(f.sql.contains("IN (?"));
        assert_eq!(f.binds.len(), SOURCE_TYPES.len());
    }

    #[test]
    fn blob_roundtrip_is_lossless() {
        let v: Vec<f32> = vec![0.0, 1.0, -0.5, 3.25, 1e-8];
        let b = vec_to_blob(&v);
        assert_eq!(b.len(), v.len() * 4);
        assert_eq!(blob_to_vec(&b).unwrap(), v);
        // 长度不是 4 的倍数说明数据损坏，必须安全拒绝而不是 panic
        assert!(blob_to_vec(&[1, 2, 3]).is_none());
    }

    #[test]
    fn snippet_centers_on_needle() {
        let text = format!("{}深蹲{}", "前".repeat(200), "后".repeat(200));
        let s = make_snippet(&text, "深蹲", 20);
        assert!(s.contains("深蹲"));
        assert!(s.starts_with('…') && s.ends_with('…'));
        assert!(
            s.chars().count() < 40,
            "片段应被截短: {}",
            s.chars().count()
        );
    }

    #[test]
    fn glob_semantics_match_shell_expectations() {
        // `*` 不跨目录
        assert!(glob_match("笔记/*.md", "笔记/膝盖.md"));
        assert!(!glob_match("笔记/*.md", "笔记/训练/深蹲.md"));
        assert!(!glob_match("/*.md", "笔记/膝盖.md"));
        // `**` 跨目录
        assert!(glob_match("**/*.md", "笔记/训练/深蹲.md"));
        assert!(glob_match("对话/**/*.md", "对话/c1/3-用户.md"));
        assert!(glob_match("对话/**/*.md", "对话/c1.md"));
        // `?` 单字符
        assert!(glob_match("体测/2026-09-?0-1.md", "体测/2026-09-10-1.md"));
        assert!(!glob_match("体测/2026-09-?0-1.md", "体测/2026-09-100-1.md"));
        // 连续星号折叠；空模式不匹配
        assert!(glob_match("****/*.md", "a/b.md"));
        assert!(!glob_match("", "a.md"));
    }

    #[test]
    fn snippet_falls_back_when_needle_absent() {
        // 向量命中常见：块里没有字面查询词
        let s = make_snippet("腿部力量训练安排", "膝盖", 100);
        assert_eq!(s, "腿部力量训练安排");
    }
}
