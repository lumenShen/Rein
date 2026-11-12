//! 双库收敛测试：同一进程里起两台「设备」（各自一个内存库 + 一个 blob 目录），
//! 直接交换对象，验证合并规则。网络那一层（帧、加密、链路）不在这里测。

use std::path::PathBuf;

use rusqlite::Connection;

use super::*;
use crate::db::migrate_for_test;
use crate::modules::sync::blobs::BlobStore;
use crate::modules::sync::engine::{capture, Raw};

struct Dev {
    conn: Connection,
    store: BlobStore,
    dir: PathBuf,
    id: String,
}

impl Dev {
    fn new() -> Self {
        let conn = Connection::open_in_memory().unwrap();
        migrate_for_test(&conn).unwrap();
        let dir = std::env::temp_dir().join(format!("rein-sync-apply-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = BlobStore::new(&dir);
        let id = crate::modules::sync::identity::ensure(&conn).unwrap().device_id;
        Self {
            conn,
            store,
            dir,
            id,
        }
    }

    /// 模拟变更钩子：捕获一行（返回受影响的 uuid，未产生新版本时为 None）
    fn touch(&self, table: &str, rowid: i64, op: char) -> Option<String> {
        capture(
            &self.conn,
            &self.store,
            &self.id,
            &Raw {
                table: table.to_string(),
                rowid,
                op,
            },
        )
        .unwrap()
        .uuid()
        .map(str::to_string)
    }

    /// 把本机复制日志里的对象发给对方
    fn send_to(&self, peer: &Dev) -> ApplyStats {
        let (objects, _) = outbox(&self.conn, 0, 500).unwrap();
        let stats = apply_batch(&peer.conn, &peer.store, &objects).unwrap();
        set_cursor(&self.conn, &peer.id, 500, 500).unwrap();
        stats
    }

    fn objects(&self) -> i64 {
        self.conn
            .query_row("SELECT COUNT(*) FROM sync_objects", [], |r| r.get(0))
            .unwrap()
    }

    fn logs(&self) -> i64 {
        self.conn
            .query_row("SELECT COUNT(*) FROM sync_log", [], |r| r.get(0))
            .unwrap()
    }

    fn text(&self, sql: &str) -> String {
        self.conn
            .query_row(sql, [], |r| r.get::<_, Option<String>>(0))
            .unwrap()
            .unwrap_or_default()
    }

    fn int(&self, sql: &str) -> i64 {
        self.conn
            .query_row(sql, [], |r| r.get::<_, Option<i64>>(0))
            .unwrap()
            .unwrap_or(-1)
    }
}

impl Drop for Dev {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// 两台设备各改一处、互发一轮，两边内容一致（本地 id 可以不同）。
#[test]
fn two_devices_converge() {
    let a = Dev::new();
    let b = Dev::new();

    a.conn
        .execute(
            "INSERT INTO todos (id, title, created_at) VALUES (1, '买菜', '2026-09-28T10:00')",
            [],
        )
        .unwrap();
    a.touch("todos", 1, 'i');

    let stats = a.send_to(&b);
    assert_eq!(stats.applied, 1);
    assert_eq!(b.text("SELECT title FROM todos"), "买菜");
    assert_eq!(b.int("SELECT COUNT(*) FROM todos"), 1);
    // 本地 id 不同没关系，uuid 一致才重要
    let b_uuid = b.text("SELECT uuid FROM sync_map WHERE kind = 'todos'");
    let a_uuid = a.text("SELECT uuid FROM sync_map WHERE kind = 'todos'");
    assert_eq!(a_uuid, b_uuid);
    assert!(!b_uuid.is_empty());

    // B 改标题再发回 A
    let b_rowid = b.int("SELECT rowid FROM todos");
    b.conn
        .execute("UPDATE todos SET title = '买菜（已买）' WHERE rowid = ?1", [b_rowid])
        .unwrap();
    b.touch("todos", b_rowid, 'u');
    let stats = b.send_to(&a);
    assert_eq!(stats.applied, 1);
    assert_eq!(a.text("SELECT title FROM todos"), "买菜（已买）");
    assert_eq!(a.int("SELECT COUNT(*) FROM todos"), 1, "不该多出一行");
}

/// 内置食物与它的单位都是种子数据：两端各自播种，不进同步。
/// 自建食物与它的单位照常同步；对端按食物的自然键并到同一条后，单位插到那条食物下。
#[test]
fn builtin_food_units_are_not_synced_but_custom_ones_are() {
    let a = Dev::new();
    let b = Dev::new();
    for d in [&a, &b] {
        d.conn
            .execute(
                "INSERT INTO foods (id, name, is_custom, created_at) VALUES (1, '米饭', 0, 'now')",
                [],
            )
            .unwrap();
        d.conn
            .execute(
                "INSERT INTO food_units (id, food_id, name, grams) VALUES (1, 1, '碗', 150)",
                [],
            )
            .unwrap();
    }
    assert!(a.touch("foods", 1, 'i').is_none(), "内置食物不该进同步");
    assert!(
        a.touch("food_units", 1, 'i').is_none(),
        "内置食物的单位不该进同步（否则对端 UNIQUE(food_id,name) 必炸）"
    );

    a.conn
        .execute(
            "INSERT INTO foods (id, name, is_custom, created_at) VALUES (2, '自制酱', 1, 'now')",
            [],
        )
        .unwrap();
    assert!(a.touch("foods", 2, 'i').is_some());
    a.conn
        .execute(
            "INSERT INTO food_units (id, food_id, name, grams) VALUES (2, 2, '勺', 10)",
            [],
        )
        .unwrap();
    assert!(a.touch("food_units", 2, 'i').is_some());

    let stats = a.send_to(&b);
    assert_eq!(stats.applied, 2, "自建食物 + 它的单位");
    // B 本来就有米饭，合并后仍是两条食物；单位是米饭 1 + 自制酱 1
    assert_eq!(b.int("SELECT COUNT(*) FROM foods"), 2);
    assert_eq!(b.int("SELECT COUNT(*) FROM food_units"), 2);
    assert_eq!(
        b.text("SELECT f.name FROM food_units u JOIN foods f ON f.id = u.food_id WHERE u.name = '勺'"),
        "自制酱"
    );
}

/// 应用过的对象不会被自己再捕获一遍（不回声）。
#[test]
fn apply_does_not_echo() {
    let a = Dev::new();
    let b = Dev::new();
    a.conn
        .execute("INSERT INTO todos (id, title, created_at) VALUES (1, 'x', 'now')", [])
        .unwrap();
    a.touch("todos", 1, 'i');
    a.send_to(&b);

    let objects_before = b.objects();
    let logs_before = b.logs();
    let rowid = b.int("SELECT rowid FROM todos");
    // 模拟「应用写库触发的钩子」被同步线程捞起来：内容与已存对象一致，
    // 既不该产生新版本，也不该发出变更事件（`None`）——否则外部订阅者会被
    // 一条没变化的通知叫醒，远端 apply 的幂等写入还会自激成事件风暴。
    let uuid = b.touch("todos", rowid, 'u');
    assert!(uuid.is_none(), "内容没变就不该产生变更事件");
    assert_eq!(b.objects(), objects_before, "内容没变就不该新增版本");
    assert_eq!(b.logs(), logs_before, "内容没变就不该写复制日志");
}

/// 删除传播成墓碑，并真的删掉对端那一行。
#[test]
fn delete_propagates() {
    let a = Dev::new();
    let b = Dev::new();
    a.conn
        .execute("INSERT INTO todos (id, title, created_at) VALUES (1, 'x', 'now')", [])
        .unwrap();
    a.touch("todos", 1, 'i');
    a.send_to(&b);
    assert_eq!(b.int("SELECT COUNT(*) FROM todos"), 1);

    a.conn.execute("DELETE FROM todos WHERE id = 1", []).unwrap();
    let tomb = a.touch("todos", 1, 'd').unwrap();
    assert!(!tomb.is_empty());
    a.send_to(&b);
    assert_eq!(b.int("SELECT COUNT(*) FROM todos"), 0, "对端该删掉");
    assert_eq!(b.int("SELECT deleted FROM sync_objects"), 1, "墓碑要留下");
}

/// 两边都改过同一条：新的赢，旧的进冲突留档（不静默丢）。
#[test]
fn conflict_is_archived() {
    let a = Dev::new();
    let b = Dev::new();
    a.conn
        .execute("INSERT INTO todos (id, title, created_at) VALUES (1, '原始', 'now')", [])
        .unwrap();
    a.touch("todos", 1, 'i');
    a.send_to(&b);

    // A 先改（hlc 小），B 后改（hlc 大）
    a.conn.execute("UPDATE todos SET title = 'A 的版本' WHERE id = 1", []).unwrap();
    a.touch("todos", 1, 'u');
    let b_rowid = b.int("SELECT rowid FROM todos");
    b.conn
        .execute("UPDATE todos SET title = 'B 的版本' WHERE rowid = ?1", [b_rowid])
        .unwrap();
    b.touch("todos", b_rowid, 'u');

    // A 的版本发到 B：B 更新，A 那版留档
    let stats = a.send_to(&b);
    assert_eq!(stats.conflicts, 1);
    assert_eq!(b.text("SELECT title FROM todos"), "B 的版本", "新的赢");
    assert_eq!(b.int("SELECT COUNT(*) FROM sync_conflicts"), 1);
    let lost = b.text("SELECT lost_blob FROM sync_conflicts");
    assert!(lost.contains("A 的版本"), "输的那版要留档：{lost}");

    // 反向：B 的新版本发到 A，A 直接接受（无冲突）
    let stats = b.send_to(&a);
    assert_eq!(stats.conflicts, 0);
    assert_eq!(a.text("SELECT title FROM todos"), "B 的版本");
}

/// 依赖顺序：外键指向的行先落地，哪怕对方把对象顺序打乱发过来。
#[test]
fn dependency_order_resolves_refs() {
    let a = Dev::new();
    let b = Dev::new();
    a.conn
        .execute(
            "INSERT INTO foods (id, name, is_custom, created_at) VALUES (1, '自制酸奶', 1, 'now')",
            [],
        )
        .unwrap();
    a.touch("foods", 1, 'i');
    a.conn
        .execute(
            "INSERT INTO meal_logs (id, food_id, date, meal_type, quantity_mode, grams, source, created_at) \
             VALUES (1, 1, '2026-09-28', 'lunch', 'grams', 120, 'manual', 'now')",
            [],
        )
        .unwrap();
    a.touch("meal_logs", 1, 'i');

    let (mut objects, _) = outbox(&a.conn, 0, 500).unwrap();
    objects.reverse(); // 故意把引用方排在前面
    let stats = apply_batch(&b.conn, &b.store, &objects).unwrap();
    assert_eq!(stats.applied, 2);
    assert_eq!(stats.unresolved, 0);
    assert_eq!(b.text("SELECT name FROM foods"), "自制酸奶");
    let food_rowid = b.int("SELECT rowid FROM foods");
    assert_eq!(b.int("SELECT food_id FROM meal_logs"), food_rowid, "外键该指向本机那行");
}

/// 内置食物不参与同步：引用退化成按名字找，对端用自己那行接上。
#[test]
fn natural_key_links_builtin_food() {
    let a = Dev::new();
    let b = Dev::new();
    // 两端各自播种的内置食物（同一名字、不同 id）
    a.conn
        .execute(
            "INSERT INTO foods (id, name, is_custom, created_at) VALUES (5, '鸡蛋', 0, 'now')",
            [],
        )
        .unwrap();
    b.conn
        .execute(
            "INSERT INTO foods (id, name, is_custom, created_at) VALUES (9, '鸡蛋', 0, 'now')",
            [],
        )
        .unwrap();
    a.conn
        .execute(
            "INSERT INTO meal_logs (id, food_id, date, meal_type, quantity_mode, grams, source, created_at) \
             VALUES (1, 5, '2026-09-28', 'breakfast', 'grams', 60, 'manual', 'now')",
            [],
        )
        .unwrap();
    a.touch("meal_logs", 1, 'i');

    let (objects, _) = outbox(&a.conn, 0, 500).unwrap();
    let stats = apply_batch(&b.conn, &b.store, &objects).unwrap();
    assert_eq!(stats.applied, 1, "{:?}", stats.pending);
    assert_eq!(b.int("SELECT food_id FROM meal_logs"), 9, "接到 B 自己那行鸡蛋");
}

/// 同一天的身体指标：两端各自新建时靠业务键并成一条，而不是插两条撞 UNIQUE。
#[test]
fn natural_key_merges_local_row() {
    let a = Dev::new();
    let b = Dev::new();
    a.conn
        .execute(
            "INSERT INTO body_metrics (id, date, weight_kg, created_at, updated_at) \
             VALUES (1, '2026-09-28', 70.5, 'now', 'now')",
            [],
        )
        .unwrap();
    b.conn
        .execute(
            "INSERT INTO body_metrics (id, date, weight_kg, created_at, updated_at) \
             VALUES (3, '2026-09-28', 71.0, 'now', 'now')",
            [],
        )
        .unwrap();
    b.touch("body_metrics", 3, 'i'); // B 也同步过它

    a.touch("body_metrics", 1, 'i');
    let (objects, _) = outbox(&a.conn, 0, 500).unwrap();
    let stats = apply_batch(&b.conn, &b.store, &objects).unwrap();
    assert_eq!(stats.applied, 1);
    assert_eq!(b.int("SELECT COUNT(*) FROM body_metrics"), 1, "不该多出一行");
    assert!((b.conn.query_row("SELECT weight_kg FROM body_metrics", [], |r| r.get::<_, f64>(0)).unwrap() - 70.5).abs() < 0.001);
}

/// 单行表（profile 这类 `id = 1`）首次同步：映射表里还没有它的落点，必须找到本机
/// 那一行做 UPDATE，而不是 INSERT 一条 rowid=2 撞 `CHECK (id = 1)` 卡死整个会话。
#[test]
fn singleton_converges_without_prior_map() {
    let a = Dev::new();
    let b = Dev::new();
    a.conn
        .execute("UPDATE profile SET nickname = '小陈' WHERE id = 1", [])
        .unwrap();
    a.touch("profile", 1, 'u');

    let stats = a.send_to(&b);
    assert_eq!(stats.applied, 1, "对端第一次收到 singleton 必须能落地");
    assert_eq!(b.text("SELECT nickname FROM profile"), "小陈");
    assert_eq!(b.int("SELECT COUNT(*) FROM profile"), 1, "不能多出一行");
    assert_eq!(b.int("SELECT rowid FROM profile"), 1, "落在种子的那一行上");

    // 反向也通：B 改完发回 A，之后就是普通的 LWW 收敛
    b.conn
        .execute("UPDATE profile SET nickname = '小陈二号' WHERE id = 1", [])
        .unwrap();
    b.touch("profile", 1, 'u');
    let stats = b.send_to(&a);
    assert_eq!(stats.applied, 1);
    assert_eq!(a.text("SELECT nickname FROM profile"), "小陈二号");
}

/// 版本错开：对端的对象里有本机这张表还没有的列 —— 跳过那一列，其余照常落地。
/// 整条失败是不行的：一次升级不该把同步卡死。
#[test]
fn unknown_columns_are_skipped() {
    let a = Dev::new();
    let b = Dev::new();
    a.conn
        .execute("ALTER TABLE todos ADD COLUMN future_col TEXT", [])
        .unwrap();
    a.conn
        .execute(
            "INSERT INTO todos (id, title, created_at, future_col) VALUES (1, '新版本写的', 'now', '只有 A 有')",
            [],
        )
        .unwrap();
    a.touch("todos", 1, 'i');

    let (objects, _) = outbox(&a.conn, 0, 500).unwrap();
    let stats = apply_batch(&b.conn, &b.store, &objects).unwrap();
    assert_eq!(stats.applied, 1);
    assert_eq!(stats.skipped_columns, 1, "那一列要如实计数");
    assert_eq!(b.text("SELECT title FROM todos"), "新版本写的");
}
