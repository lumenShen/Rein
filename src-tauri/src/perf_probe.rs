//! 关于你页面的后端断点探针（仅测试构建，`#[ignore]` + 环境变量双闸）。
//!
//! 跑法：
//!   REIN_PERF_DB=<生产库**副本**> cargo test --release --lib about_page_probe -- --ignored --nocapture
//!
//! 只认副本：`scan_all` / `apply_one` / `maintain` 都会写库。绝不传生产库。

use std::path::PathBuf;
use std::time::Instant;

use crate::modules::kb::{files, index, listing, memory, settings, source};

fn db_path() -> Option<PathBuf> {
    std::env::var("REIN_PERF_DB").ok().map(PathBuf::from)
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn report(label: &str, values: &mut Vec<(String, f64)>, t: Instant) {
    let v = ms(t);
    println!("{:<52} {:>9.2} ms", label, v);
    values.push((label.to_string(), v));
}

#[test]
#[ignore]
fn about_page_probe() {
    let Some(path) = db_path() else {
        println!("未设 REIN_PERF_DB，跳过");
        return;
    };
    let conn = rusqlite::Connection::open(&path).expect("打开副本库");
    crate::db::tune(&conn).expect("tune");
    let mut values: Vec<(String, f64)> = Vec::new();

    println!("\n=== 0. 规模 ===");
    let count = |t: &str| -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
            .unwrap_or(-1)
    };
    for t in [
        "kb_docs",
        "kb_files",
        "kb_assets",
        "kb_chunks",
        "kb_memories",
        "health_metrics",
        "kb_dirty",
        "profile",
        "todos",
        "workouts",
    ] {
        println!("{t:<16} {}", count(t));
    }

    println!("\n=== 1. 启动对账 reconcile（持锁，UI 全部排队） ===");
    let t = Instant::now();
    crate::modules::seed::seed_foods(&conn).expect("seed_foods");
    report("seed::seed_foods（启动，幂等）", &mut values, t);
    let t = Instant::now();
    crate::modules::seed::seed_builtin_plans(&conn).expect("seed_builtin_plans");
    report("seed::seed_builtin_plans", &mut values, t);
    let t = Instant::now();
    crate::modules::seed::seed_exercises(&conn).expect("seed_exercises");
    report("seed::seed_exercises", &mut values, t);
    let t = Instant::now();
    crate::modules::exercise_lib::resolve::backfill_exercise_refs(&conn).expect("backfill_refs");
    report("exercise_lib::backfill_exercise_refs", &mut values, t);

    let t = Instant::now();
    files::ensure_system_files(&conn).expect("ensure_system_files");
    report("files::ensure_system_files", &mut values, t);

    let enabled = settings::enabled_sources(&conn).expect("enabled_sources");
    println!("enabled_sources {:?}", enabled);

    let t = Instant::now();
    let queued = index::scan_all(&conn, &enabled).expect("scan_all");
    report(&format!("index::scan_all（入队 {queued} 条）"), &mut values, t);

    let t = Instant::now();
    let maintained = memory::maintain(&conn).expect("maintain");
    report(
        &format!("memory::maintain（归档 {}）", maintained.archived),
        &mut values,
        t,
    );

    println!("\n=== 2. 索引消费：每批 32 条（drain 的等待窗口） ===");
    let mut batches = 0;
    let mut applied = 0usize;
    let mut unchanged = 0usize;
    let mut worst_batch = 0f64;
    let t_all = Instant::now();
    loop {
        let t = Instant::now();
        let dirty = index::take_dirty(&conn, 32).expect("take_dirty");
        if dirty.is_empty() {
            break;
        }
        for (st, sid, _op) in &dirty {
            match index::apply_one(&conn, st, sid) {
                Ok(out) => {
                    applied += 1;
                    if out.unchanged {
                        unchanged += 1;
                    }
                }
                Err(e) => println!("  apply 失败 {st}/{sid}: {e}"),
            }
        }
        let b = ms(t);
        worst_batch = worst_batch.max(b);
        batches += 1;
        if batches <= 5 || batches % 10 == 0 {
            println!("  batch {batches:>3}: {} 条 {b:.2} ms", dirty.len());
        }
    }
    report(
        &format!("消费全部脏队列（{batches} 批 / {applied} 条）"),
        &mut values,
        t_all,
    );
    println!("  其中内容未变（hash 命中，纯浪费）：{unchanged}");
    println!("  最慢一批：{worst_batch:.2} ms");

    println!("\n=== 3. 页面首页的每条 IPC（Rust 侧） ===");
    let t = Instant::now();
    let mems = memory::list(&conn, None, memory::MemoryScope::Active).expect("memories");
    report(&format!("kb_memories（{} 条）", mems.len()), &mut values, t);

    let t = Instant::now();
    let _ = memory::stats(&conn).expect("stats");
    report("kb_memory_stats", &mut values, t);

    let t = Instant::now();
    let _ = memory::cognition(&conn, None).expect("cognition");
    report("kb_cognition", &mut values, t);

    let t = Instant::now();
    let overview = memory::overview(&conn).expect("overview");
    report(
        &format!(
            "kb_memory_overview（{} 条 / 注入 {}）",
            overview.memories.len(),
            overview.cognition.memories.len()
        ),
        &mut values,
        t,
    );

    let t = Instant::now();
    let profile = crate::modules::nutrition::load_profile(&conn).expect("profile");
    report(
        &format!("get_profile（weight {:?}）", profile.weight_kg),
        &mut values,
        t,
    );

    let t = Instant::now();
    let listing = listing::list_dir(&conn, "").expect("list root");
    report(
        &format!("kb_list_dir(\"\")（{} 项）", listing.entries.len()),
        &mut values,
        t,
    );

    let t = Instant::now();
    let roots = listing::root_stats(&conn).expect("root stats");
    report(
        &format!("kb_root_stats（{} 个 root）", roots.len()),
        &mut values,
        t,
    );

    let t = Instant::now();
    let metrics: i64 = conn
        .query_row("SELECT COUNT(*) FROM health_metrics", [], |r| r.get(0))
        .unwrap_or(0);
    report(
        &format!("health_metrics_all（{metrics} 行）"),
        &mut values,
        t,
    );

    println!("\n=== 4. 文件夹详情：每个分组的 list_dir ===");
    let roots = [
        "用户记忆", "体测", "运动", "方案", "日程", "饮食", "语音", "笔记", "文档", "未分类数据",
        "记忆", "对话", "附件",
    ];
    let mut root_total = 0f64;
    for root in roots {
        let t = Instant::now();
        match listing::list_dir(&conn, root) {
            Ok(l) => {
                let v = ms(t);
                root_total += v;
                println!(
                    "{:<10} {:>9.2} ms  entries={:<5} truncated={}",
                    root,
                    v,
                    l.entries.len(),
                    l.truncated
                );
                values.push((format!("list_dir({root})"), v));
            }
            Err(e) => println!("{root:<10} ERR {e}"),
        }
    }
    println!("roots 合计 {root_total:.2} ms");

    println!("\n=== 5. 摘要 kb_read（文件夹详情最多 8 个） ===");
    let mut read_total = 0f64;
    let mut read_n = 0usize;
    for root in ["用户记忆", "体测", "运动", "方案", "笔记"] {
        let Ok(l) = listing::list_dir(&conn, root) else { continue };
        for e in l.entries.iter().filter(|e| e.kind != "folder").take(3) {
            if e.id <= 0 {
                continue;
            }
            let t = Instant::now();
            match crate::modules::kb::commands::read_detail(&conn, e.id, "l1", None, None) {
                Ok(d) => {
                    let v = ms(t);
                    read_total += v;
                    read_n += 1;
                    println!(
                        "{:<28} {:>9.2} ms  chunks={}",
                        e.path,
                        v,
                        d.chunks.len()
                    );
                    values.push((format!("kb_read({})", e.path), v));
                }
                Err(err) => println!("{:<28} ERR {err}", e.path),
            }
        }
    }
    println!("kb_read 合计 {read_n} 次 / {read_total:.2} ms");

    println!("\n=== 6. 对账里的孤儿检查：逐条 source::derive ===");
    let t = Instant::now();
    let docs: Vec<(i64, String, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, source_type, source_id FROM kb_docs")
            .expect("prepare docs");
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .expect("query docs")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect docs")
    };
    let mut derived_none = 0usize;
    for (_id, st, sid) in &docs {
        if !enabled.iter().any(|e| e == st) {
            continue;
        }
        match source::derive(&conn, st, sid) {
            Ok(None) => derived_none += 1,
            Ok(Some(_)) => {}
            Err(_) => derived_none += 1,
        }
    }
    report(
        &format!("逐条 derive（{} docs, {} 孤儿）", docs.len(), derived_none),
        &mut values,
        t,
    );

    println!("\n=== 排序（后端链路 Top） ===");
    values.sort_by(|a, b| b.1.total_cmp(&a.1));
    for (i, (label, v)) in values.iter().enumerate() {
        println!("{:>3}. {:>9.2} ms  {}", i + 1, v, label);
    }
}
