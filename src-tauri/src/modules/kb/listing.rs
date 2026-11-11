//! 目录列举：文件管理器的 `ls`（`kb_glob` 的「一层」版本）。
//!
//! 与 `glob` 的分工：**列举走这里，模式匹配走 glob**。
//! 列举只扫一层子树（`path` 前缀范围，吃 `idx_kb_docs_path` 与 `kb_files.path` 的 UNIQUE 索引），
//! 版本上一次性把文件管理器要显示的字段全带回来——大小、时间、模态、钉住、归类状态、
//! 子项数——前端因此不必再对每个条目发一次查询，也不必像旧实现那样拉整棵子树再自己切。
//!
//! 条目来源有两个，同一路径以 `kb_files`（真实文件）为准合并：
//! - `kb_docs`：派生投影（日程/运动/饮食…的只读内容），以及笔记的检索镜像；
//! - `kb_files`：真实文件节点（笔记正文 / 多模态本体 / 目录占位）。
//!
//! `kb_files` 里刚写入、还没被后台索引过的文件也在（否则「新建完看不到自己刚建的文件」）。

use rusqlite::Connection;

use crate::error::Result;

use super::models::*;

/// 一次列举最多返回的条目数（大目录保护）。
pub const MAX_ENTRIES: i64 = 2000;
/// 一层列举最多扫描的行数上限（子目录计数要往下多看一层，这里是它的护栏）。
pub const MAX_SCAN: i64 = 20000;

/// 前缀范围：`path = dir` 或 `path` 以 `dir/` 开头。
/// 不用 `LIKE`——路径里可能出现的 `%` / `_` 会污染模式，而范围比较正好走向索引。
fn bounds(dir: &str) -> (String, String) {
    let lo = if dir.is_empty() {
        String::new()
    } else {
        format!("{dir}/")
    };
    let hi = format!("{lo}\u{10FFFF}");
    (lo, hi)
}

/// 回收站里的东西永远不出现在浏览视图里（双重保险：trashed 行本身已被过滤）。
fn is_trash_path(path: &str) -> bool {
    path == TRASH_ROOT || path.starts_with(&format!("{TRASH_ROOT}/"))
}

/// 做什么都别让标题带着一堆空格/换行进列表
fn tidy(s: String) -> String {
    s.replace(['\n', '\r', '\t'], " ").trim().to_string()
}

/// 列出 `path` 目录的直接内容。`path` 为空 = 根目录。
pub fn list_dir(conn: &Connection, path: &str) -> Result<KbDirListing> {
    let dir = path.trim().trim_matches('/').to_string();
    if dir.split('/').any(|seg| seg == "..") {
        return Err(crate::error::ReinError::Message(format!(
            "路径不允许包含 ..：{path}"
        )));
    }
    let (lo, hi) = bounds(&dir);
    let mut truncated = false;

    // 1) 派生文档（只读投影 + 笔记镜像）
    let mut docs: Vec<DocRow> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, path, source_type, title, kind, editable, system, occurred_on, updated_at,
                    LENGTH(CAST(body AS BLOB))
             FROM kb_docs WHERE path >= ?1 AND path < ?2 ORDER BY path LIMIT ?3",
        )?;
        let rows = stmt.query_map(rusqlite::params![lo, hi, MAX_SCAN + 1], |r| {
            Ok(DocRow {
                id: r.get(0)?,
                path: r.get(1)?,
                source_type: r.get(2)?,
                title: r.get(3)?,
                kind: r.get(4)?,
                editable: r.get::<_, i64>(5)? != 0,
                system: r.get::<_, i64>(6)? != 0,
                occurred_on: r.get(7)?,
                updated_at: r.get(8)?,
                body_bytes: r.get(9)?,
            })
        })?;
        for row in rows {
            docs.push(row?);
        }
    }
    if docs.len() as i64 > MAX_SCAN {
        docs.truncate(MAX_SCAN as usize);
        truncated = true;
    }

    // 2) 真实文件节点（不含回收站）
    let mut nodes: Vec<NodeRow> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, path, kind, system, pinned, classify_state, updated_at,
                    LENGTH(CAST(content AS BLOB)), rating, tags, (note <> '')
             FROM kb_files WHERE path >= ?1 AND path < ?2 AND trashed_at IS NULL
             ORDER BY path LIMIT ?3",
        )?;
        let rows = stmt.query_map(rusqlite::params![lo, hi, MAX_SCAN + 1], |r| {
            Ok(NodeRow {
                id: r.get(0)?,
                path: r.get(1)?,
                kind: r.get(2)?,
                system: r.get::<_, i64>(3)? != 0,
                pinned: r.get::<_, i64>(4)? != 0,
                classify_state: r.get(5)?,
                updated_at: r.get(6)?,
                bytes: r.get::<_, i64>(7)?,
                rating: r.get::<_, i64>(8)?,
                tags: r.get::<_, String>(9)?,
                has_note: r.get::<_, i64>(10)? != 0,
            })
        })?;
        for row in rows {
            nodes.push(row?);
        }
    }
    if nodes.len() as i64 > MAX_SCAN {
        nodes.truncate(MAX_SCAN as usize);
        truncated = true;
    }

    // 3) 本体模态（体积与模态清单一次取回）
    let mut assets: Vec<(i64, String, i64)> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT a.file_id, a.modal, a.bytes FROM kb_assets a
             JOIN kb_files f ON f.id = a.file_id
             WHERE f.path >= ?1 AND f.path < ?2 AND f.trashed_at IS NULL
             ORDER BY a.file_id, a.modal LIMIT ?3",
        )?;
        let rows = stmt.query_map(rusqlite::params![lo, hi, MAX_SCAN + 1], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
        })?;
        for row in rows {
            assets.push(row?);
        }
    }
    if assets.len() as i64 > MAX_SCAN {
        assets.truncate(MAX_SCAN as usize);
        truncated = true;
    }
    let mut asset_bytes: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    let mut asset_modals: std::collections::HashMap<i64, Vec<String>> =
        std::collections::HashMap::new();
    for (fid, modal, bytes) in assets {
        if modal != MODAL_TEXT {
            *asset_bytes.entry(fid).or_insert(0) += bytes;
        }
        let list = asset_modals.entry(fid).or_default();
        if !list.contains(&modal) {
            list.push(modal);
        }
    }

    /* ---------- 归并 ---------- */

    // 直接子目录 → 其直接子项集合（算「N 项」用）；显式目录节点另记
    let mut child_names: std::collections::HashMap<String, std::collections::HashSet<String>> =
        std::collections::HashMap::new();
    let mut folder_nodes: std::collections::HashMap<String, &NodeRow> =
        std::collections::HashMap::new();
    let mut entries: Vec<KbEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let direct = |p: &str| -> Option<String> {
        let rel = p.strip_prefix(&lo).unwrap_or(p);
        if rel.is_empty() || rel.contains('/') || is_trash_path(p) {
            None
        } else {
            Some(rel.to_string())
        }
    };

    for n in &nodes {
        if is_trash_path(&n.path) {
            continue;
        }
        match direct(&n.path) {
            Some(name) => {
                if n.kind == FILE_KIND_FOLDER {
                    folder_nodes.insert(name, n);
                }
            }
            None => {
                // 后代：记到第一段子目录名下（用于「N 项」）
                let rel = n.path.strip_prefix(&lo).unwrap_or(&n.path);
                let segs: Vec<&str> = rel.split('/').collect();
                if segs.len() >= 2 {
                    child_names
                        .entry(segs[0].to_string())
                        .or_default()
                        .insert(segs[1].to_string());
                }
            }
        }
    }

    // 派生文档：直接子项进列表；后代贡献计数（与文件节点同规则）
    for d in &docs {
        if is_trash_path(&d.path) {
            continue;
        }
        match direct(&d.path) {
            Some(_) => {}
            None => {
                let rel = d.path.strip_prefix(&lo).unwrap_or(&d.path);
                let segs: Vec<&str> = rel.split('/').collect();
                if segs.len() >= 2 {
                    child_names
                        .entry(segs[0].to_string())
                        .or_default()
                        .insert(segs[1].to_string());
                }
            }
        }
    }

    // 目录条目：显式目录节点 ∪ 由后代推出的隐式目录
    let mut dir_names: std::collections::BTreeSet<String> = child_names.keys().cloned().collect();
    for name in folder_nodes.keys() {
        dir_names.insert(name.clone());
    }
    for name in &dir_names {
        let path = if dir.is_empty() {
            name.clone()
        } else {
            format!("{dir}/{name}")
        };
        let node = folder_nodes.get(name).copied();
        let count = child_names.get(name).map(|s| s.len() as i64).unwrap_or(0);
        entries.push(KbEntry {
            id: 0,
            file_id: node.map(|n| n.id),
            path: path.clone(),
            name: name.clone(),
            kind: KIND_FOLDER.into(),
            source_type: String::new(),
            title: name.clone(),
            system: node.map(|n| n.system).unwrap_or(false),
            editable: false,
            // 目录的 size 是它自身占用的字节（子树体积由空间总览负责，别在这里做重活）
            size: node.map(|n| n.bytes).unwrap_or(0),
            child_count: count,
            occurred_on: None,
            updated_at: node.map(|n| n.updated_at.clone()).unwrap_or_default(),
            pinned: node.map(|n| n.pinned).unwrap_or(false),
            classify_state: node.map(|n| n.classify_state.clone()).unwrap_or_default(),
            modalities: Vec::new(),
            rating: node.map(|n| n.rating).unwrap_or(0),
            tags: node.map(|n| parse_tags(&n.tags)).unwrap_or_default(),
            has_note: node.map(|n| n.has_note).unwrap_or(false),
        });
        seen.insert(path);
    }

    // 按路径索引一次：下面每个派生文档都要找它的文件节点。从前是
    // `nodes.iter().find(...)` —— 文档数 × 节点数，大目录（2000 条）时是平方级。
    let nodes_by_path: std::collections::HashMap<&str, &NodeRow> =
        nodes.iter().map(|n| (n.path.as_str(), n)).collect();

    // 文件条目：派生文档优先（它带来源类别与标题），其后是纯文件节点
    for d in &docs {
        let Some(name) = direct(&d.path) else { continue };
        if d.kind == KIND_FOLDER {
            continue;
        }
        if !seen.insert(d.path.clone()) {
            continue;
        }
        let node = nodes_by_path.get(d.path.as_str()).copied();
        let bytes = d_bytes(node, d.body_bytes, &asset_bytes);
        entries.push(KbEntry {
            id: d.id,
            file_id: node.map(|n| n.id),
            path: d.path.clone(),
            name: name.clone(),
            kind: d.kind.clone(),
            source_type: d.source_type.clone(),
            title: tidy(d.title.clone()),
            system: d.system || node.map(|n| n.system).unwrap_or(false),
            editable: d.editable,
            size: bytes,
            child_count: 0,
            occurred_on: d.occurred_on.clone(),
            updated_at: node
                .map(|n| n.updated_at.clone())
                .unwrap_or_else(|| d.updated_at.clone()),
            pinned: node.map(|n| n.pinned).unwrap_or(false),
            classify_state: node.map(|n| n.classify_state.clone()).unwrap_or_default(),
            modalities: node
                .and_then(|n| asset_modals.get(&n.id).cloned())
                .unwrap_or_else(|| vec![MODAL_TEXT.to_string()]),
            rating: node.map(|n| n.rating).unwrap_or(0),
            tags: node.map(|n| parse_tags(&n.tags)).unwrap_or_default(),
            has_note: node.map(|n| n.has_note).unwrap_or(false),
        });
    }

    for n in &nodes {
        let Some(name) = direct(&n.path) else { continue };
        if n.kind == FILE_KIND_FOLDER || is_trash_path(&n.path) {
            continue;
        }
        if !seen.insert(n.path.clone()) {
            continue;
        }
        let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(&name);
        let kind = match n.kind.as_str() {
            FILE_KIND_MULTIMODAL => modal_kind(&asset_modals.get(&n.id)),
            _ => KIND_TEXT,
        };
        entries.push(KbEntry {
            id: 0,
            file_id: Some(n.id),
            path: n.path.clone(),
            name: name.clone(),
            kind: kind.to_string(),
            source_type: "note".into(),
            title: tidy(stem.to_string()),
            system: n.system,
            editable: !n.system,
            size: n.bytes + asset_bytes.get(&n.id).copied().unwrap_or(0),
            child_count: 0,
            occurred_on: None,
            updated_at: n.updated_at.clone(),
            pinned: n.pinned,
            classify_state: n.classify_state.clone(),
            modalities: asset_modals
                .get(&n.id)
                .cloned()
                .unwrap_or_else(|| vec![MODAL_TEXT.to_string()]),
            rating: n.rating,
            tags: parse_tags(&n.tags),
            has_note: n.has_note,
        });
    }

    if entries.len() as i64 > MAX_ENTRIES {
        entries.truncate(MAX_ENTRIES as usize);
        truncated = true;
    }
    let total = entries.len() as i64;
    // 目录在前、其后按路径（右上角排序由前端接管，这里只保证顺序稳定）
    entries.sort_by(|a, b| {
        let ad = a.kind == KIND_FOLDER;
        let bd = b.kind == KIND_FOLDER;
        bd.cmp(&ad).then_with(|| a.path.cmp(&b.path))
    });

    Ok(KbDirListing {
        path: dir,
        entries,
        total,
        truncated,
    })
}

/// 根层统计：每个顶层目录的「直接子项数」与目录节点更新时间。
///
/// 为什么单开一条：关于你首屏只需要 13 个 root 的数字，而 [`list_dir`] 为了给出
/// 这 13 个数字会把整棵树（docs / files / assets 三张表）扫进 Rust 再归并。
/// 这里把计数压进 SQLite 的 `GROUP BY`：只回几十行，不实例化任何 `KbEntry`，
/// 也不碰 assets 表。口径与 `list_dir("")` 的 `child_count` 严格一致：
/// **只数后代**（第 2 段起的路径），直接子文件的 `child_count` 本就是 0。
pub fn root_stats(conn: &Connection) -> Result<Vec<KbRootStat>> {
    // 每个 root 的子项名集合：取路径第 2 段。
    // 与 list_dir("") 的 child_names 严格同口径。注意根层列举的特殊之处：目录节点
    // 自己的路径也带斜杠（`未分类数据/空目录`），因此**直接子目录节点也算一个子项**
    // （与 `list_dir("笔记")` 里的同名目录显示 0 项不同 —— 那是既有行为，此处不改，
    // 因为关于你用的正是根层口径）。回收站与 list_dir 一样整棵排除。
    let mut stmt = conn.prepare(
        "SELECT root, COUNT(DISTINCT seg) AS n
         FROM (
           SELECT substr(path, 1, instr(path, '/') - 1) AS root,
                  CASE WHEN instr(substr(path, instr(path, '/') + 1), '/') > 0
                       THEN substr(path, instr(path, '/') + 1,
                                   instr(substr(path, instr(path, '/') + 1), '/') - 1)
                       ELSE substr(path, instr(path, '/') + 1)
                  END AS seg
           FROM kb_docs WHERE instr(path, '/') > 0
           UNION ALL
           SELECT substr(path, 1, instr(path, '/') - 1),
                  CASE WHEN instr(substr(path, instr(path, '/') + 1), '/') > 0
                       THEN substr(path, instr(path, '/') + 1,
                                   instr(substr(path, instr(path, '/') + 1), '/') - 1)
                       ELSE substr(path, instr(path, '/') + 1)
                  END
           FROM kb_files WHERE trashed_at IS NULL AND instr(path, '/') > 0
         )
         WHERE seg <> '' AND root <> '' AND root <> ?1
         GROUP BY root",
    )?;
    let mut stats: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    for row in stmt.query_map([TRASH_ROOT], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })? {
        let (root, n) = row?;
        stats.insert(root, n);
    }
    drop(stmt);

    // 根目录节点自己的更新时间（隐式目录没有节点 → 空串，前端不显示"更新于"）
    let mut updated: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT path, updated_at FROM kb_files
         WHERE kind = ?1 AND trashed_at IS NULL AND path <> '' AND instr(path, '/') = 0",
    )?;
    for row in stmt.query_map([FILE_KIND_FOLDER], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (path, at) = row?;
        updated.insert(path, at);
    }
    drop(stmt);

    // 并集：有后代的目录 ∪ 有空目录节点的目录（后者 count=0，与 list_dir 同）
    let mut out: Vec<KbRootStat> = Vec::new();
    let names: std::collections::BTreeSet<&String> = stats.keys().chain(updated.keys()).collect();
    for name in names {
        out.push(KbRootStat {
            name: name.clone(),
            child_count: stats.get(name).copied().unwrap_or(0),
            updated_at: updated.get(name).cloned().unwrap_or_default(),
        });
    }
    Ok(out)
}

/// 文件条目的体积：本体字节优先（多模态），其次真实文件正文，最后派生正文。
fn d_bytes(
    node: Option<&NodeRow>,
    doc_body_bytes: i64,
    asset_bytes: &std::collections::HashMap<i64, i64>,
) -> i64 {
    if let Some(n) = node {
        let a = asset_bytes.get(&n.id).copied().unwrap_or(0);
        return n.bytes + a;
    }
    doc_body_bytes
}

/// 按虚拟路径取**一个**条目的富元数据（AI 的 `present_file`：把工作区里的一个文件
/// 摆到聊天里当文件卡片）。找不到返回 `None`，由调用方给「先 glob 查路径」的人话。
///
/// 走 `list_dir(父目录)` 再挑出同路径那一条，而不是另写一套查询：富元数据
/// （体积 / 模态 / 钉住 / 归类 / 子项数）的算法只有一份，聊天卡片与文件管理器不会漂移。
///
/// 路径写法认三种（模型很少一字不差地抄路径）：
/// 1. 原样（`笔记/膝盖.md`）；
/// 2. 省 `.md` 后缀（`笔记/膝盖` = 笔记的规范后缀，与 `files::normalize_path` 同约定）；
/// 3. 省根目录（`膝盖` = `笔记/膝盖.md`，与 `write_note` 的归位规则同约定）。
///
/// 顺序是「越精确越先」，所以同名的目录不会被 `.md` 变体抢走。
pub fn find_entry(conn: &Connection, path: &str) -> Result<Option<KbEntry>> {
    let want = path.trim().trim_matches('/');
    if want.is_empty() || want.split('/').any(|s| s == "..") {
        return Ok(None);
    }
    let (parent, leaf) = match want.rsplit_once('/') {
        Some((d, l)) => (d, l),
        None => ("", want),
    };

    let mut cands: Vec<String> = vec![want.to_string()];
    if !leaf.to_ascii_lowercase().ends_with(".md") {
        cands.push(format!("{want}.md"));
    }
    if parent.is_empty() {
        let stem = leaf.strip_suffix(".md").unwrap_or(leaf);
        cands.push(format!("笔记/{stem}.md"));
    }

    // 每个目录只列一次（最多两个：目标父目录 + 「笔记/」兜底），命中最精确的候选即返回
    let mut listings: Vec<(String, Vec<KbEntry>)> = Vec::new();
    for cand in cands {
        let dir = match cand.rsplit_once('/') {
            Some((d, _)) => d.to_string(),
            None => String::new(),
        };
        if !listings.iter().any(|(d, _)| d == &dir) {
            let entries = list_dir(conn, &dir)?.entries;
            listings.push((dir.clone(), entries));
        }
        let hit = match listings.iter().find(|(d, _)| d == &dir) {
            Some((_, entries)) => entries.iter().find(|e| e.path == cand).cloned(),
            None => None,
        };
        if let Some(hit) = hit {
            return Ok(Some(hit));
        }
    }
    Ok(None)
}

/// 多模态节点的主模态 → 编目 kind（与 source.rs::primary_modal_kind 同一顺序）。
fn modal_kind(modals: &Option<&Vec<String>>) -> &'static str {
    let empty = Vec::new();
    let list = modals.unwrap_or(&empty);
    for (modal, kind) in [
        (MODAL_VIDEO, KIND_VIDEO),
        (MODAL_AUDIO, KIND_AUDIO),
        (MODAL_IMAGE, KIND_IMAGE),
    ] {
        if list.iter().any(|m| m == modal) {
            return kind;
        }
    }
    KIND_FILE
}

struct DocRow {
    id: i64,
    path: String,
    source_type: String,
    title: String,
    kind: String,
    editable: bool,
    system: bool,
    occurred_on: Option<String>,
    updated_at: String,
    /// 正文占用字节数（列存储长度）。**随主查询一起取回**：从前派生文档若没有对应的
    /// 文件节点，每行都要再发一次 `SELECT LENGTH(body) FROM kb_docs WHERE id=?` ——
    /// 一层目录 2000 条就是 2000 次额外查询（典型的 N+1）。SQLite 的 LENGTH 只按
    /// 存储格式算长度、不解析正文，放进主查询几乎不增加成本。
    body_bytes: i64,
}

struct NodeRow {
    id: i64,
    path: String,
    kind: String,
    system: bool,
    pinned: bool,
    classify_state: String,
    updated_at: String,
    bytes: i64,
    rating: i64,
    /// 原始 JSON 字符串（用 parse_tags 解）
    tags: String,
    has_note: bool,
}

/// 标签列是 JSON 数组字符串；坏数据当空表
fn parse_tags(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::kb::{files, governance, index};

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        files::ensure_system_files(&conn).unwrap();
        conn
    }

    #[test]
    fn root_lists_namespaces_with_immediate_child_counts() {
        let conn = db();
        let id = files::write(&conn, "运动/知识/跑步计划.md", "每周三次").unwrap();
        index::apply_one(&conn, "note", &id.to_string()).unwrap();
        files::write(&conn, "笔记/膝盖.md", "避免深蹲").unwrap();

        let l = list_dir(&conn, "").unwrap();
        let by_name = |n: &str| l.entries.iter().find(|e| e.name == n).cloned();
        assert!(l.entries.iter().all(|e| e.kind == KIND_FOLDER));
        // 「运动」是隐式目录（只有一条后代），子项数 = 直接子项 1（知识）
        assert_eq!(by_name("运动").unwrap().child_count, 1);
        assert_eq!(by_name("笔记").unwrap().child_count, 1);
        assert!(l.entries.iter().all(|e| !is_trash_path(&e.path)));
    }

    #[test]
    fn root_stats_match_list_dir_child_counts() {
        let conn = db();
        let id = files::write(&conn, "运动/知识/跑步计划.md", "每周三次").unwrap();
        index::apply_one(&conn, "note", &id.to_string()).unwrap();
        files::write(&conn, "笔记/膝盖.md", "避免深蹲").unwrap();
        // 显式空目录：只有节点、没有后代 → child_count 与 list_dir 一样是 0
        governance::mkdir(&conn, "用户记忆/空目录", "测试", "user").unwrap();
        // 再放一个后代进去 → 变成 1
        files::write(&conn, "用户记忆/空目录/a.md", "备注").unwrap();
        // 一个只有空目录节点的 root：必须被并进统计（count=0），不能整行消失
        governance::mkdir(&conn, "未分类数据/孤立空目录", "测试", "user").unwrap();
        // 回收站里的东西两边都不该出现（写接口拒绝直写回收站，走正常删除路径）
        let tid = files::write(&conn, "笔记/待删.md", "x").unwrap();
        files::trash(&conn, tid).unwrap();

        let l = list_dir(&conn, "").unwrap();
        let stats = root_stats(&conn).unwrap();
        assert!(stats.iter().all(|s| s.name != TRASH_ROOT), "回收站不该进统计");

        // 口径必须与 list_dir("") 的每个 folder 条目逐项相等
        for e in l.entries.iter().filter(|e| e.kind == KIND_FOLDER) {
            let s = stats.iter().find(|s| s.name == e.name);
            assert_eq!(
                s.map(|s| s.child_count),
                Some(e.child_count),
                "root {} 的 child_count 与 list_dir 不一致",
                e.name
            );
        }
        // list_dir 里没有条目但统计里有的（隐式目录），只可能是 0 后代 —— 允许
        for s in &stats {
            if !l.entries.iter().any(|e| e.name == s.name) {
                assert_eq!(s.child_count, 0, "{} 只应来自空目录节点", s.name);
            }
        }
        assert_eq!(
            stats
                .iter()
                .find(|s| s.name == "未分类数据")
                .map(|s| s.child_count),
            Some(1),
            "根层口径里直接子目录节点也算一个子项（与 list_dir(\"\") 一致）"
        );
    }

    #[test]
    fn listing_one_level_returns_rich_metadata() {
        let conn = db();
        let id = files::write(&conn, "笔记/训练/深蹲.md", "深蹲 5x5").unwrap();
        index::apply_one(&conn, "note", &id.to_string()).unwrap();

        let l = list_dir(&conn, "笔记").unwrap();
        assert_eq!(l.entries.len(), 1);
        let e = &l.entries[0];
        assert_eq!(e.name, "训练");
        assert_eq!(e.kind, KIND_FOLDER);
        assert_eq!(e.child_count, 1);

        let sub = list_dir(&conn, "笔记/训练").unwrap();
        let f = &sub.entries[0];
        assert_eq!(f.name, "深蹲.md");
        assert_eq!(f.kind, KIND_TEXT);
        assert_eq!(f.source_type, "note");
        assert!(f.editable && !f.system);
        assert!(f.size > 0, "文件条目必须带体积");
        assert!(f.file_id.is_some() && f.id > 0, "既要文件 id 也要文档 id");
        assert_eq!(f.modalities, vec![MODAL_TEXT.to_string()]);
    }

    #[test]
    fn folders_are_first_and_directories_include_explicit_nodes() {
        let conn = db();
        files::write(&conn, "未分类数据/b.md", "乙").unwrap();
        files::write(&conn, "未分类数据/a.md", "甲").unwrap();
        governance::mkdir(&conn, "未分类数据/子目录", "测试", "user").unwrap();

        let l = list_dir(&conn, "未分类数据").unwrap();
        assert_eq!(l.entries[0].kind, KIND_FOLDER);
        assert_eq!(l.entries[0].name, "子目录");
        assert_eq!(l.entries[0].child_count, 0);
        assert_eq!(l.entries.iter().filter(|e| e.kind != KIND_FOLDER).count(), 2);
    }

    #[test]
    fn trashed_files_disappear_from_listing() {
        let conn = db();
        let id = files::write(&conn, "笔记/待删.md", "内容").unwrap();
        index::apply_one(&conn, "note", &id.to_string()).unwrap();
        assert_eq!(list_dir(&conn, "笔记").unwrap().entries.len(), 1);

        files::trash(&conn, id).unwrap();
        let l = list_dir(&conn, "笔记").unwrap();
        assert!(l.entries.is_empty(), "回收站里的文件不该出现在浏览视图");
        // 根目录也不该冒出「回收站」这个命名空间
        let root = list_dir(&conn, "").unwrap();
        assert!(root.entries.iter().all(|e| e.name != "回收站"));
    }

    #[test]
    fn unindexed_files_still_show_up() {
        let conn = db();
        // 写完不重放：派生文档还不存在，但文件管理器必须看得到
        files::write(&conn, "笔记/刚写的.md", "内容").unwrap();
        let l = list_dir(&conn, "笔记").unwrap();
        assert_eq!(l.entries.len(), 1);
        assert_eq!(l.entries[0].name, "刚写的.md");
        assert_eq!(l.entries[0].source_type, "note");
    }

    /* ---------- find_entry（present_file 的单条查找） ---------- */

    #[test]
    fn find_entry_accepts_exact_md_less_and_rootless_paths() {
        let conn = db();
        let id = files::write(&conn, "笔记/膝盖养护.md", "避免深蹲").unwrap();
        index::apply_one(&conn, "note", &id.to_string()).unwrap();

        let exact = find_entry(&conn, "笔记/膝盖养护.md").unwrap().expect("原样路径");
        assert_eq!(exact.path, "笔记/膝盖养护.md");
        assert_eq!(exact.kind, KIND_TEXT);
        assert_eq!(exact.source_type, "note");
        assert!(exact.size > 0, "卡片要显示体积");
        assert!(exact.editable && !exact.system);
        assert!(exact.file_id.is_some() && exact.id > 0, "既要文件 id 也要文档 id");

        // 省 .md 后缀
        let no_ext = find_entry(&conn, "笔记/膝盖养护").unwrap().expect("省后缀");
        assert_eq!(no_ext.path, "笔记/膝盖养护.md");
        // 省根目录（与 write_note 的归位规则一致）
        let bare = find_entry(&conn, "膝盖养护").unwrap().expect("省根目录");
        assert_eq!(bare.path, "笔记/膝盖养护.md");
        // 首尾的斜杠与空白不算路径
        let padded = find_entry(&conn, "  /笔记/膝盖养护.md/  ").unwrap().expect("首尾斜杠");
        assert_eq!(padded.path, "笔记/膝盖养护.md");
    }

    #[test]
    fn find_entry_returns_folders_and_misses_without_errors() {
        let conn = db();
        files::write(&conn, "未分类数据/解压/备份/a.txt", "甲").unwrap();

        let dir = find_entry(&conn, "未分类数据/解压/备份").unwrap().expect("目录也要能挂");
        assert_eq!(dir.kind, KIND_FOLDER);
        assert_eq!(dir.child_count, 1);

        assert!(find_entry(&conn, "笔记/不存在.md").unwrap().is_none());
        assert!(find_entry(&conn, "根本没有这个根/文件.md").unwrap().is_none());
        assert!(find_entry(&conn, "").unwrap().is_none(), "空路径不是条目");
        assert!(find_entry(&conn, "笔记/../系统提示词/规范.md").unwrap().is_none(), ".. 不进查找");
    }

    #[test]
    fn find_entry_never_returns_trashed_files() {
        let conn = db();
        let id = files::write(&conn, "笔记/已删.md", "内容").unwrap();
        index::apply_one(&conn, "note", &id.to_string()).unwrap();
        files::trash(&conn, id).unwrap();
        assert!(find_entry(&conn, "笔记/已删.md").unwrap().is_none());
    }
}
