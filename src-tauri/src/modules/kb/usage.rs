//! 空间管理：工作区占用总览、大文件排序、孤儿本体回收。
//!
//! 「占用」四个口径，别混在一起看（本模块的输出也按这四条分行）：
//! 1. **文本节点**：`kb_files.content` 的 UTF-8 字节数（真源，能改能删）；
//! 2. **本体（模态）**：`kb_assets.bytes`（图片/音频/视频/二进制/上传文档），
//!    大头在磁盘 `workspace/media/`；
//! 3. **检索索引**：`kb_docs.body` + `kb_chunks.text` + `kb_vectors.vec`，
//!    是派生出来的缓存 —— 删掉源数据会自然缩回，不是「用户文件」；
//! 4. **数据库自身**：page_count × page_size（含自由页，可 VACUUM 回收）。
//!
//! **孤儿**：磁盘上 `workspace/media/` 里没有任何 `kb_assets.ref` 指向的文件
//! （上传中断、节点删除时漏清），以及反过来「有登记、没文件」的缺失本体。
//! 前者可清理（`clean_orphans`），后者只报告（清不了，得让用户重新上传）。

use std::collections::HashSet;
use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;

use crate::error::Result;

/// 大文件榜默认条数。
pub const TOP_DEFAULT: i64 = 20;
/// 大文件榜上限（模型工具用）。
pub const TOP_MAX: i64 = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbUsageSlice {
    /// 分组名（目录名 / 来源类型 / 模态）
    pub name: String,
    pub bytes: i64,
    /// 条目数（文件数 / 文档数 / 本体数）
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbUsageFile {
    pub id: i64,
    pub path: String,
    /// text | multimodal | folder
    pub kind: String,
    pub bytes: i64,
    /// 文本字节 + 本体字节（榜单排序口径）
    pub text_bytes: i64,
    pub asset_bytes: i64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbUsageReport {
    pub total_bytes: i64,
    /// kb_files.content 合计
    pub text_bytes: i64,
    /// kb_assets.bytes 合计
    pub asset_bytes: i64,
    /// 检索索引（正文快照 + 分块 + 向量）合计
    pub index_bytes: i64,
    /// 数据库文件大小（含自由页）
    pub db_bytes: i64,
    pub file_count: i64,
    pub doc_count: i64,
    pub asset_count: i64,
    /// 按工作区一级目录
    pub areas: Vec<KbUsageSlice>,
    /// 按来源类型（索引口径）
    pub sources: Vec<KbUsageSlice>,
    /// 按模态（本体口径）
    pub modals: Vec<KbUsageSlice>,
    /// 大文件榜（降序，含 text + asset 字节）
    pub largest: Vec<KbUsageFile>,
    /// 磁盘上没人引用的本体文件
    pub orphan_count: i64,
    pub orphan_bytes: i64,
    /// 有登记但磁盘上找不到的本体
    pub missing_count: i64,
    /// 人话总结（给模型/界面直接用，免得各自拼）
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbUsageCleanResult {
    pub removed: i64,
    pub bytes: i64,
    pub failed: i64,
    /// 试运行：只统计不删
    pub dry_run: bool,
    pub message: String,
}

fn human_size(bytes: i64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.2} GB", bytes as f64 / 1073741824.0)
    } else if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / 1048576.0)
    } else if bytes >= 1024 {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{bytes} B")
    }
}

/// 本体目录（`workspace/media/`）的绝对路径。
fn media_dir(root: &Path) -> std::path::PathBuf {
    root.join("workspace").join("media")
}

/// 磁盘上没人引用的本体文件清单（相对 root 的路径, 字节数）。
pub fn list_orphans(conn: &Connection, root: &Path) -> Result<Vec<(String, i64)>> {
    let dir = media_dir(root);
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut referenced: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn.prepare("SELECT ref FROM kb_assets WHERE storage = 'fs'")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for r in rows {
            referenced.insert(r?);
        }
    }
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let rel = format!("workspace/media/{}", entry.file_name().to_string_lossy());
        if referenced.contains(&rel) {
            continue;
        }
        let size = entry.metadata().map(|m| m.len() as i64).unwrap_or(0);
        out.push((rel, size));
    }
    out.sort_by_key(|x| std::cmp::Reverse(x.1));
    Ok(out)
}

/// 登记在册但磁盘上找不到的本体数。
fn missing_assets(conn: &Connection, root: &Path) -> Result<i64> {
    let mut stmt = conn.prepare("SELECT ref FROM kb_assets WHERE storage = 'fs'")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut missing = 0i64;
    for r in rows {
        let rel: String = r?;
        if !root.join(&rel).is_file() {
            missing += 1;
        }
    }
    Ok(missing)
}

/// 按体积倒序的文件榜（文本字节 + 本体字节），可给体积下限。
///
/// **只做这一条查询**：「找大文件」这类调用不该顺带跑整份 report
/// （全表聚合 + 目录遍历 + 逐本体 stat）。`report` 也复用它，保证口径只有一份。
pub fn largest(conn: &Connection, limit: i64, min_bytes: i64) -> Result<Vec<KbUsageFile>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, kind, updated_at, tb, ab FROM (
             SELECT f.id, f.path, f.kind, f.updated_at,
                    COALESCE(LENGTH(CAST(f.content AS BLOB)), 0) AS tb,
                    COALESCE((SELECT SUM(a.bytes) FROM kb_assets a WHERE a.file_id = f.id), 0) AS ab
             FROM kb_files f
             WHERE f.kind != 'folder' AND f.trashed_at IS NULL
         )
         WHERE (tb + ab) >= ?2
         ORDER BY (tb + ab) DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![limit.clamp(1, TOP_MAX), min_bytes.max(0)],
        |r| {
            let text_bytes: i64 = r.get(4)?;
            let asset_bytes: i64 = r.get(5)?;
            Ok(KbUsageFile {
                id: r.get(0)?,
                path: r.get(1)?,
                kind: r.get(2)?,
                bytes: text_bytes + asset_bytes,
                text_bytes,
                asset_bytes,
                updated_at: r.get(3)?,
            })
        },
    )?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// 占用总览。`top` = 大文件榜条数（0 表示不要榜）；`min_bytes` = 榜单的体积下限。
///
/// 下限**在 SQL 里生效**：先按体积取前 N 条再过滤的话，阈值一高就会莫名其妙
/// 少一半甚至空榜（后面的达标文件根本没进候选）。
pub fn report(conn: &Connection, root: &Path, top: i64, min_bytes: i64) -> Result<KbUsageReport> {
    let text_bytes: i64 = conn.query_row(
        "SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) FROM kb_files WHERE kind != 'folder'",
        [],
        |r| r.get(0),
    )?;
    let file_count: i64 = conn.query_row("SELECT COUNT(*) FROM kb_files", [], |r| r.get(0))?;
    let asset_bytes: i64 =
        conn.query_row("SELECT COALESCE(SUM(bytes), 0) FROM kb_assets", [], |r| {
            r.get(0)
        })?;
    let asset_count: i64 = conn.query_row("SELECT COUNT(*) FROM kb_assets", [], |r| r.get(0))?;
    let doc_count: i64 = conn.query_row("SELECT COUNT(*) FROM kb_docs", [], |r| r.get(0))?;

    let index_bytes: i64 = {
        let body: i64 = conn.query_row(
            "SELECT COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) FROM kb_docs",
            [],
            |r| r.get(0),
        )?;
        let chunks: i64 = conn.query_row(
            "SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) FROM kb_chunks",
            [],
            |r| r.get(0),
        )?;
        let vecs: i64 = conn.query_row(
            "SELECT COALESCE(SUM(LENGTH(vec)), 0) FROM kb_vectors",
            [],
            |r| r.get(0),
        )?;
        body + chunks + vecs
    };
    let db_bytes: i64 = conn
        .query_row("SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()", [], |r| r.get(0))
        .unwrap_or(0);

    // 按工作区一级目录：**文本 + 本体**。一个目录「占了多少地方」才是这一栏要回答的
    // 问题，只算文本会把 附件/语音/视频 这些放本体的目录显示成近乎空的 —— 而本体恰恰
    // 是体积大头。口径与 largest 的 `bytes` 一致（模型 / mock 也都是文本 + 本体）。
    let mut areas: Vec<KbUsageSlice> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT CASE WHEN instr(f.path, '/') > 0 THEN substr(f.path, 1, instr(f.path, '/') - 1) ELSE f.path END AS area,
                    COUNT(*),
                    COALESCE(SUM(LENGTH(CAST(f.content AS BLOB))), 0) + COALESCE(SUM(a.bytes), 0)
             FROM kb_files f
             LEFT JOIN (SELECT file_id, SUM(bytes) AS bytes FROM kb_assets GROUP BY file_id) a
                    ON a.file_id = f.id
             WHERE f.kind != 'folder'
             GROUP BY area ORDER BY 3 DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(KbUsageSlice {
                name: r.get(0)?,
                count: r.get(1)?,
                bytes: r.get(2)?,
            })
        })?;
        for r in rows {
            areas.push(r?);
        }
    }

    // 按来源类型（索引口径：正文快照 + 分块）
    let mut sources: Vec<KbUsageSlice> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT d.source_type,
                    COUNT(DISTINCT d.id),
                    COALESCE(SUM(LENGTH(CAST(d.body AS BLOB))), 0)
                      + COALESCE((SELECT SUM(LENGTH(CAST(c.text AS BLOB))) FROM kb_chunks c
                                  WHERE c.doc_id IN (SELECT id FROM kb_docs WHERE source_type = d.source_type)), 0)
             FROM kb_docs d GROUP BY d.source_type ORDER BY 3 DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(KbUsageSlice {
                name: r.get(0)?,
                count: r.get(1)?,
                bytes: r.get(2)?,
            })
        })?;
        for r in rows {
            sources.push(r?);
        }
    }

    // 按模态（本体口径）
    let mut modals: Vec<KbUsageSlice> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT modal, COUNT(*), COALESCE(SUM(bytes), 0) FROM kb_assets GROUP BY modal ORDER BY 3 DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(KbUsageSlice {
                name: r.get(0)?,
                count: r.get(1)?,
                bytes: r.get(2)?,
            })
        })?;
        for r in rows {
            modals.push(r?);
        }
    }

    // 大文件榜：文本字节 + 本体字节（体积下限在 SQL 里过滤，见 report 的说明）
    let largest = if top > 0 {
        largest(conn, top, min_bytes)?
    } else {
        Vec::new()
    };

    let orphans = list_orphans(conn, root)?;
    let orphan_bytes: i64 = orphans.iter().map(|(_, b)| b).sum();
    let missing_count = missing_assets(conn, root)?;

    let total_bytes = text_bytes + asset_bytes;
    let summary = format!(
        "工作区共 {}（文本 {} + 本体 {}）：{} 个文件节点、{} 条索引文档、{} 个本体；\
         检索索引另占 {}，数据库文件 {}。磁盘上有 {} 个无人引用的本体碎片（{}）可清理{}。",
        human_size(total_bytes),
        human_size(text_bytes),
        human_size(asset_bytes),
        file_count,
        doc_count,
        asset_count,
        human_size(index_bytes),
        human_size(db_bytes),
        orphans.len(),
        human_size(orphan_bytes),
        if missing_count > 0 {
            format!("；另有 {missing_count} 个本体登记在册但文件丢失")
        } else {
            String::new()
        }
    );

    Ok(KbUsageReport {
        total_bytes,
        text_bytes,
        asset_bytes,
        index_bytes,
        db_bytes,
        file_count,
        doc_count,
        asset_count,
        areas,
        sources,
        modals,
        largest,
        orphan_count: orphans.len() as i64,
        orphan_bytes,
        missing_count,
        summary,
    })
}

/// 清理孤儿本体。`dry_run` 只统计。
pub fn clean_orphans(conn: &Connection, root: &Path, dry_run: bool) -> Result<KbUsageCleanResult> {
    let orphans = list_orphans(conn, root)?;
    let mut removed = 0i64;
    let mut bytes = 0i64;
    let mut failed = 0i64;
    for (rel, size) in &orphans {
        if !dry_run {
            match std::fs::remove_file(root.join(rel)) {
                Ok(()) => {}
                Err(e) => {
                    failed += 1;
                    eprintln!("[kb] 清理孤儿本体失败 {rel}: {e}");
                    continue;
                }
            }
        }
        removed += 1;
        bytes += size;
    }
    let message = if dry_run {
        format!(
            "可清理 {} 个孤儿本体，回收 {}（未执行）",
            removed,
            human_size(bytes)
        )
    } else if failed > 0 {
        format!(
            "已清理 {} 个孤儿本体，回收 {}；{failed} 项删除失败",
            removed,
            human_size(bytes)
        )
    } else {
        format!("已清理 {} 个孤儿本体，回收 {}", removed, human_size(bytes))
    };
    Ok(KbUsageCleanResult {
        removed,
        bytes,
        failed,
        dry_run,
        message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::kb::{assets, files};

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn root() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("rein-kb-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(d.join("workspace/media")).unwrap();
        d
    }

    #[test]
    fn report_splits_text_assets_and_index() {
        let conn = db();
        let root = root();
        files::write_media_row(
            &conn,
            "笔记/大.md",
            &"字".repeat(1000),
            crate::modules::kb::models::FILE_KIND_TEXT,
        )
        .unwrap();
        assets::write_media_bytes(
            &conn,
            &root,
            "未分类数据/图.png",
            "图.png",
            "image/png",
            &vec![7u8; 8192],
            "",
        )
        .unwrap();

        let r = report(&conn, &root, 10, 0).unwrap();
        assert!(r.text_bytes >= 3000, "1000 个汉字是 3000 字节");
        assert_eq!(r.asset_bytes, 8192);
        assert_eq!(r.file_count, 2);
        assert_eq!(r.largest.len(), 2);
        assert_eq!(r.largest[0].path, "未分类数据/图.png", "本体大者在榜首");
        assert!(r.areas.iter().any(|a| a.name == "笔记"));
        assert!(r.modals.iter().any(|m| m.name == "image" && m.bytes == 8192));
        assert!(r.summary.contains("工作区共"));
    }

    /// 体积下限必须在 SQL 里生效（先取前 N 条再过滤会把达标文件漏在候选之外）。
    #[test]
    fn largest_honours_min_bytes() {
        let conn = db();
        let root = root();
        for (name, size) in [("笔记/大.md", 5000usize), ("笔记/中.md", 2000), ("笔记/小.md", 100)] {
            files::write_media_row(
                &conn,
                name,
                &"x".repeat(size),
                crate::modules::kb::models::FILE_KIND_TEXT,
            )
            .unwrap();
        }
        assert_eq!(largest(&conn, 10, 0).unwrap().len(), 3);
        let big = largest(&conn, 10, 1000).unwrap();
        assert_eq!(big.len(), 2, "下限应在 SQL 里过滤：{big:?}");
        assert!(big.iter().all(|f| f.bytes >= 1000));
        assert_eq!(big[0].path, "笔记/大.md");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn orphans_are_files_without_asset_rows() {
        let conn = db();
        let root = root();
        // 被引用的本体
        let fid = assets::write_media_bytes(
            &conn,
            &root,
            "未分类数据/a.bin",
            "a.bin",
            "application/octet-stream",
            &[1u8; 100],
            "",
        )
        .unwrap();
        // 没人引用的碎片
        std::fs::write(root.join("workspace/media/999-碎片.bin"), vec![0u8; 4096]).unwrap();
        let fid2 = assets::write_media_bytes(
            &conn,
            &root,
            "未分类数据/b.bin",
            "b.bin",
            "application/octet-stream",
            &[2u8; 10],
            "",
        )
        .unwrap();
        let refs = assets::fs_refs(&conn, fid).unwrap();
        std::fs::remove_file(root.join(&refs[0])).unwrap();

        let r = report(&conn, &root, 5, 0).unwrap();
        assert_eq!(r.orphan_count, 1);
        assert_eq!(r.orphan_bytes, 4096);
        assert_eq!(r.missing_count, 1, "fid 的本体被删了，应报缺失");

        let dry = clean_orphans(&conn, &root, true).unwrap();
        assert_eq!(dry.removed, 1);
        assert!(root.join("workspace/media/999-碎片.bin").exists(), "试运行不删");
        let done = clean_orphans(&conn, &root, false).unwrap();
        assert_eq!(done.removed, 1);
        assert_eq!(done.bytes, 4096);
        assert!(!root.join("workspace/media/999-碎片.bin").exists());
        // 有引用的本体不该被误删
        let refs2 = assets::fs_refs(&conn, fid2).unwrap();
        assert!(root.join(&refs2[0]).exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
