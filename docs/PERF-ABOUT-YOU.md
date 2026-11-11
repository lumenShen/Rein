# 「关于你」全链路性能断点（前端 + 后端）

测量日期：2026-11-10 · 版本：0.7.18 之后的工作树 · 数据源：**生产库副本**
（`C:\Users\Administrator\AppData\Roaming\com.gozaoo.rein\rein.db`，1385 篇文档 / 1785 条源记录 /
29 条记忆 / 17 个文件节点 / 2380 个块）

> 本文回答三件事：**慢在哪里**（可复现的测量）、**先修哪些**（Top 100 排序）、
> **改了什么**（代码位置与效果）。所有数字都是本机实测；凡是推算出来的都标了 ≈。

---

## 0. 结论（TL;DR）

**页面渲染不是瓶颈，启动期的索引队列才是。**

无头 Edge 移动视口（390×844）下，`关于你` 页面：

- 导航 → 挂载 **100–103 ms**，记忆卡结算 **136–145 ms**，**0 个长任务**；
- 主线程 trace：Layout 8.3 ms / Style 7.9 ms / Paint 2.6 ms / Commit 5.0 ms；
- CPU profile 里没有任何一个 >2 ms 的业务函数（最大的是测量本身 `CpuProfiler::StartProfiling` 134 ms）；
- 滚动 rAF p50 3.3 ms、p95 3.5–4.3 ms，90 帧里只有 1 帧 >33 ms。

真正让用户感觉「非常慢」的是后端这条链：

1. **每次启动**都把全部源记录重新入队（1785 条，其中 1379 条内容没变），持锁约
   94–124 ms（debug 构建）→ 之后 `kb_dirty` 长时间非零。
2. 索引线程**每处理 32 条就回去等 3 秒**兜底节奏（`IDLE_TICK`），清空 1785 条约
   **168 秒**。
3. 这段时间里，`kb_list_dir` / `kb_read` 进来先等 `drain_before_query`：预算
   **1500 ms**，而且只在进门时 `notify` 一次 → 每次都**空等满 1.5 秒**。
   `kb_read` 还是同步 Tauri 命令（跑在主线程）→ **界面直接冻住**。
   文件夹详情最多并发 3 个摘要 worker × 8 次 `kb_read`，累计可冻 ~4.5 秒。
4. 内容未变的文档每次启动都被 `UPDATE kb_docs SET updated_at = now` 重写 1379 次：
   白写 + 放大 WAL；更糟的是 `listing` 把 `updated_at` 当「最近更新」显示并排序，
   于是关于你 → 文件夹里所有派生文件的时间每次启动都变成「刚刚」，排序失真。
5. `seed_foods` 每次启动都在主线程跑一遍 2722 条 `INSERT OR IGNORE`（34.7–39.5 ms），
   其中 700 KB 的种子 JSON 还要先解析一遍。

修复后（稳态启动）：

| 链路 | 修复前 | 修复后 |
|---|---|---|
| 启动对账 `scan_all` | 每次启动 94–124 ms 持锁 + 1785 入队 | **24h 内跳过**（版本/启用源变化才重扫） |
| 孤儿检查 `derive` | 82.5 ms（随对账） | 0（随对账跳过） |
| 未变文档 `UPDATE` | 1379 次写 / ≈76 ms | **0 次** |
| 脏队列清空 | ≈168 s（3 s/批） | **218–270 ms 一次性连续排空** |
| `kb_list_dir` 等索引 | 1.5 s / 次 | **0（不再等）** |
| `kb_read` 等索引 | 1.5 s / 次，同步命令**冻结 UI** | **0，且改为 async** |
| 首屏记忆数据 | 3 条命令 × 3 次全表读 / 0.61 ms | **1 条聚合 / 0.17–0.20 ms** |
| 首屏目录计数 | `kb_list_dir("")` 全树三扫 / 6.4–8.9 ms | **`kb_root_stats` / 2.9 ms** |
| `seed_foods` | 34.7–39.5 ms / 每次启动 | **4.1 ms**（指纹 + 行数快速路径） |
| 文件夹摘要 | 8 次 `kb_read` 立刻排队 | idle 后排队、并发 2 |
| 长目录渲染（184 行） | 全部行参与布局/绘制 | `content-visibility: auto` 跳过离屏行 |

---

## 1. 测量方法（可复现）

### 1.1 隔离

生产库**先复制**再测量，绝不在真库上跑写操作：

```bash
mkdir -p "$TEMP/rein-perf-about"
cp "$APPDATA/com.gozaoo.rein/rein.db" "$APPDATA/com.gozaoo.rein/rein.db-wal" "$TEMP/rein-perf-about/"
```

### 1.2 后端：SQL 级 + 模块函数级

- `scripts/perf/about-db-probe.mjs`：用 `node:sqlite` 在副本上跑与 Rust 同形的 SQL，
  20 次取中位数 / p95（先做 2 次预热）。
- `src-tauri/src/perf_probe.rs`：在 crate 内部直接调用
  `memory::list/stats/cognition/overview`、`listing::list_dir`、`read_detail`、
  `seed::*`、`index::scan_all/apply_one`，逐项计时。`#[ignore]` + 环境变量双闸：

```bash
cd src-tauri
REIN_PERF_DB="$TEMP/rein-perf-about/rein.db" \
  cargo test --lib about_page_probe -- --ignored --nocapture
```

> Rust 数字是 **debug 构建**（`cargo test` 默认），release 一般快 2–4 倍。
> 本文只用它做**相对排序**，不把绝对值当线上数字。

### 1.3 前端：无头 Edge + 原生 CDP

`scripts/perf/about-page-profile.mjs`：

- `Profiler.start`（100 µs 采样）→ 聚合每个函数/文件的**自耗时**；
- `Tracing`（devtools.timeline / cc / viz / v8）→ Layout / Style / Paint / Commit / Raster；
- `PerformanceObserver('longtask')` + 里程碑（`about-page` / `memory-settled` /
  `folder-settled`）；
- 90 帧滚动 rAF 间隔；
- 自动记录页面 `exceptionThrown` / `console.error`。

```bash
node scripts/e2e-run.mjs scripts/perf/about-page-profile.mjs
# 或复用已起的服：
REIN_E2E_URL=http://127.0.0.1:17420 node scripts/e2e-run.mjs --url http://127.0.0.1:17420 scripts/perf/about-page-profile.mjs
```

> 前端跑在浏览器 mock 上。它不代表 Tauri IPC / SQLite 的真实耗时，但足以回答
> 「渲染、布局、绘制、动效是不是瓶颈」——答案是不是。后端数字由 1.2 补齐。

---

## 2. 实测数据

### 2.1 后端（生产库副本，debug 构建）

| 链路 | 耗时 | 备注 |
|---|---|---|
| `index::scan_all`（入队 1785） | 93.8–124.0 ms | 持锁；其中孤儿 `derive` ×1379 = 82.5 ms |
| 消费全部脏队列（56 批） | 294.9 ms → **218.4–270.1 ms** | 修复前后；差值 ≈76 ms 是 1379 次 UPDATE |
| 单批 32 条（常态） | 2.5–3.5 ms | 修复前 2.6–3.5 ms，最慢 26.97–38.69 ms |
| `seed::seed_foods` | 34.7–39.5 ms → **4.1 ms** | 修复后走指纹快速路径 |
| `seed::seed_builtin_plans` | 1.7–2.1 ms | 保留 |
| `seed::seed_exercises` | 3.1–5.1 ms | 保留 |
| `exercise_lib::backfill_exercise_refs` | 1.6–1.9 ms | 保留 |
| `files::ensure_system_files` | 0.2–0.3 ms | 保留 |
| `memory::maintain` | 0.25–2.5 ms | 保留（归档 0–6 条） |
| `kb_memories(active)` | 0.19–0.21 ms | 23 条 |
| `kb_memory_stats` | 0.29–0.30 ms | 额外拼一次注入文本 |
| `kb_cognition` | 0.11–0.12 ms | |
| `kb_memory_overview` | **0.17–0.20 ms** | 新增；三份视图一次算 |
| `get_profile` | 0.07–0.09 ms | 1 行 |
| `kb_list_dir("")` | 6.4–8.9 ms | 根层 17 项；全树三扫（关于你已不用它） |
| `kb_root_stats` | **2.9 ms** | 新增；SQLite 内 GROUP BY，只回 17 行 |
| `list_dir(对话)` | 5.4 → **4.9–6.3 ms** | 178 项；N+1 移除后（测量有抖动） |
| `list_dir(日程)` | 1.16–1.17 ms | 81 项 |
| `list_dir(运动)` | 0.29–0.30 ms | 27 项 |
| 其余 root | 0.10–0.35 ms | |
| `kb_read`（l1，单篇笔记） | 0.05–0.21 ms | 9 次合计 0.86–0.90 ms |
| `health_metrics_all` | 0.03–0.04 ms | 本机 0 行 |

### 2.2 启动队列时间线（修复前）

```
t0   reconcile: scan_all 入队 1785 条（持锁 ~94–124 ms）
t0+  worker: 处理 32 条（~3 ms）→ 回去等 3 s 兜底
     ...
t0+  ~168 s: 最后一批判处理完
     这 168 s 内：kb_dirty > 0
       → 每次 kb_list_dir 空等 1500 ms（页面骨架多停 1.5 s）
       → 每次 kb_read 空等 1500 ms，且同步命令跑在主线程 → UI 冻结
```

修复后：reconcile 在稳态启动直接跳过；worker 有活就连着干，
1785 条在 **218–270 ms** 内排空；`kb_list_dir` / `kb_read` 根本不等队列。

### 2.3 前端（无头 Edge，390×844，mock）

| 指标 | 数值 |
|---|---|
| 导航 → `about-page` 挂载 | 100–103 ms |
| 挂载 → 记忆卡结算（骨架消失） | 136–145 ms |
| 长任务 | 0 |
| Layout | 8.3 ms |
| UpdateLayoutTree | 7.9 ms |
| Paint | 2.6 ms |
| Commit | 5.0 ms |
| PrePaint | 1.8 ms |
| `CpuProfiler::StartProfiling` | 134 ms（**测量伪影**，不是页面成本） |
| >2 ms 的业务函数 | 0 |
| 滚动 rAF p50 / p95 / >33 ms | 3.3 ms / 3.5–4.3 ms / 1 帧 |
| 滚动期 Commit / Layout / Style | 5.0 ms / 3.7 ms / 3.7 ms（14 帧合计） |

---

## 3. Top 100 最慢链路排序

排序口径：**用户可感知的等待时间**（含旧版可能出现的 1.5 s 空等），
同量级按影响面排序。「实测」= 本次有数字；「≈」= 按代码路径/数据量推算；
「核验」= 已逐段读过并确认不是热点。

### A. 后端 · 启动与索引（1–22）

| # | 链路 | 位置 | 成本 | 状态 |
|---:|---|---|---|---|
| 1 | 启动队列清空窗口：1785 条 × 32/批，批间 3 s | `worker.rs:243` | ≈168 s 窗口 | **已修**（连续排空） |
| 2 | `kb_read` 等索引队列：预算 1.5 s，同步命令冻结 UI | `commands.rs:146` + `worker.rs:435` | 1.5 s/次 × 最多 8 次 | **已修**（移除等待 + async） |
| 3 | `kb_list_dir` 等索引队列 | `commands.rs:1025` | 1.5 s/次 | **已修**（移除等待） |
| 4 | `kb_glob` 等队列 + 同步主线程 | `commands.rs:934` | 1.5 s/次 | **已修**（async） |
| 5 | `kb_search` 等队列 + 同步主线程（还可能嵌入） | `commands.rs:86` | 1.5 s+/次 | **已修**（async） |
| 6 | 启动对账 `scan_all`：每次启动全表入队 | `worker.rs:187` / `index.rs:285` | 实测 93.8–124.0 ms | **已修**（版本/源/24h 节流） |
| 7 | 对账里的孤儿检查：逐条 `derive` 1379 次 | `index.rs:285` | 实测 82.5 ms | **已修**（随节流） |
| 8 | 未变文档重放仍 `UPDATE updated_at` ×1379 | `index.rs:56` | 实测 ≈76 ms + WAL + 时间戳失真 | **已修**（不写） |
| 9 | `seed_foods`：每次启动 2722 条 `INSERT OR IGNORE` | `seed.rs:85` | 实测 34.7–39.5 ms | **已修**（快速路径 4.1 ms） |
| 10 | `seed_builtin_plans` | `seed.rs:382` | 实测 1.7–2.1 ms | 保留 |
| 11 | `seed_exercises` | `seed.rs:468` | 实测 3.1–5.1 ms | 保留 |
| 12 | `backfill_exercise_refs` | `resolve.rs:187` | 实测 1.6–1.9 ms | 保留 |
| 13 | `memory::maintain`（启动 + 每 6h） | `worker.rs` | 实测 0.25–2.5 ms | 保留 |
| 14 | `ensure_system_files` | `files.rs` | 实测 0.2–0.3 ms | 保留 |
| 15 | 对账持锁与首屏读命令抢同一把 DB 锁 | `state.db: Mutex<Connection>` | ≈100–180 ms 窗口 | **已修**（节流 + 读命令 async） |
| 16 | 索引单批持锁（最慢批） | `worker.rs::cycle` | 实测 26.97–38.69 → 2.5–3.5 ms | **已修**（去掉 UPDATE） |
| 17 | 向量补算（启用语义检索时 ≤32 块/批） | `worker.rs::cycle` | 核验：放锁嵌入，按设计 | 保留 |
| 18 | 对账节流键读写 | `worker.rs:197/214` | 核验：1 读 1 写 | 新增 |
| 19 | 24h 节流带来的孤儿最长滞留 | 设计取舍 | ≤24h | 记录（运行期有 38 条触发器兜底） |
| 20 | `scan_all` 仍会把未变源入队（节流内每 24h 一次） | `index.rs:285` | 实测 218–270 ms/24h | P2（按 `updated_at` 预筛） |
| 21 | 同步 backfill 在版本/列变化时全表捕获 | `sync/engine.rs:448` | 核验：一次性 | P2 |
| 22 | `db::migrate` 版本检查 | `db.rs` | 核验：查表即返回 | 保留 |

### B. 后端 · 关于你首屏 IPC（23–40）

| # | 链路 | 位置 | 成本 | 状态 |
|---:|---|---|---|---|
| 23 | `kb_list_dir("")`：全树三扫只为 13 个 root 的计数 | `listing.rs:48` | 实测 6.4–8.9 ms，随库线性 | **已修**（新增 `kb_root_stats`，实测 2.9 ms） |
| 24 | 其中 docs 前缀扫 | `listing.rs:62` | 实测 ≈3.1 ms | 保留（covering index） |
| 25 | 其中 nodes 前缀扫 | `listing.rs:91` | 实测 0.12 ms | **已修**（0052 部分索引 + ANALYZE；无统计信息时优化器不选它） |
| 26 | 其中 assets JOIN | `listing.rs:127` | 实测 0.03 ms | 保留 |
| 27 | `d_bytes` N+1：无文件节点的派生文档逐行查 body 长度 | `listing.rs:359` | 实测 200 行 0.6 ms；2000 行 ≈6 ms | **已修**（随主查询取 `LENGTH`） |
| 28 | `nodes.iter().find` 每篇文档线性找节点 | `listing.rs:258` | 核验 O(docs×nodes) | **已修**（HashMap） |
| 29 | `kb_memories` 全表读 | `commands.rs:769` | 实测 0.19–0.21 ms | 改 async |
| 30 | `kb_memory_stats` 全表读 + 注入拼装 | `commands.rs:874` | 实测 0.29–0.30 ms | 改 async |
| 31 | `kb_cognition` 全表读 | `commands.rs:888` | 实测 0.11–0.12 ms | 改 async |
| 32 | 首屏三条记忆命令 = 3 次全表 + 3 次 salience + 3 次 IPC | `ProfilePage.vue:303` | 实测 0.61 ms + 3 往返 | **已修**（单聚合） |
| 33 | 新增 `kb_memory_overview` | `memory.rs:575` | 实测 0.17–0.20 ms | 新增 |
| 34 | `get_profile` | `nutrition/commands.rs:146` | 实测 0.07–0.09 ms | 改 async |
| 35 | `health_metrics_all` | `healthsync/commands.rs:394` | 实测 0.03–0.04 ms（本机 0 行） | 改 async |
| 36 | 五条同步读命令占主线程 | kb 三个 + profile + metrics | 锁等待不可控 | **已修**（全部 async） |
| 37 | 首屏 IPC 数量 6 → 4 | `ProfilePage.vue` | ≈2–6 ms（估算 1–3 ms/条） | **已修** |
| 38 | 记忆 23 条的 serde 序列化 | `models.rs` | 核验：微 | 保留 |
| 39 | overview 里 `cognition.memories` 与 `memories` 的重复副本（≤24 条） | `models.rs:377` | 核验：微 | 保留（主页只用 text，可再瘦身 P3） |
| 40 | `KbDirListing` 17 项的序列化 | `models.rs` | 核验：微 | 保留 |

### C. 后端 · 文件夹详情（41–58）

| # | 链路 | 位置 | 成本 | 状态 |
|---:|---|---|---|---|
| 41 | 分组根多路 `kb_list_dir`（life/notes/corner 2–3 路） | `AboutFolderPage.vue:243` | 2–3 次 IPC | P3（可批量 `kb_list_dirs`） |
| 42 | health 根 3 路并发 | 同上 | 实测各 0.10–0.30 ms | 保留 |
| 43 | `list_dir(对话)` 178 项 | `listing.rs` | 实测 4.85 ms | 保留 |
| 44 | `list_dir(日程)` 81 项 | 同上 | 实测 1.16–1.17 ms | 保留 |
| 45 | `list_dir(运动)` 27 项 | 同上 | 实测 0.29–0.30 ms | 保留 |
| 46 | 其余 root | 同上 | 实测 0.10–0.35 ms | 保留 |
| 47 | corner 184 行一次性挂载 | `AboutFolderPage.vue` | 估算 30–80 ms（手机更慢） | **已修**（`content-visibility`） |
| 48 | 每行 `rowMeta` 在模板里重新拼字符串 | `AboutFolderPage.vue:340` | O(rows) 字符串 | **已修**（构建时算 `meta`） |
| 49 | 每行 `rowPathHint` 被调用两次 | `AboutFolderPage.vue:349` | 2× O(rows) | **已修**（构建时算 `hint`） |
| 50 | 每行 `rowExcerpt` 两次 Map 查 | 同上 | 核验：微 | 保留 |
| 51 | 前端排序 184 次 `localeCompare('zh')` | `compareRows` | 估算 1–3 ms | P2（缓存 `Intl.Collator`） |
| 52 | `FileIcon` 每行一个组件 + computed + watch | `FileIcon.vue` | 核验：184 个轻组件 | 保留 |
| 53 | 图片行缩略图排队（2 并发解码） | `files/thumbs.ts` | 核验：已限流 | P2（IntersectionObserver 视口队列） |
| 54 | 摘要 8×`kb_read` 在列表落地后立刻发 | `AboutFolderPage.vue:202` | 8 次 IPC | **已修**（idle + 并发 2） |
| 55 | note 的 l1 阅读把整篇文档切块 | `commands.rs:146` | O(全文) 分配 | **已修**（只切首 300 字） |
| 56 | l1 仍要真实总块数 → 只数不切 | `chunk.rs:57` | O(n) 轻量扫描 | 新增（`count_chunks`） |
| 57 | 摘要失败静默、不阻塞 | `AboutFolderPage.vue` | 核验 | 保留 |
| 58 | 一层列表 2000 条上限保护 | `listing.rs:21` | 核验 | 保留 |

### D. 前端 · 页面与列表（59–82）

| # | 链路 | 位置 | 成本 | 状态 |
|---:|---|---|---|---|
| 59 | 导航 → 挂载（dev + mock，含路由 chunk） | `router.ts:97` | 实测 100–103 ms | 保留（生产 chunk 更小） |
| 60 | 挂载 → 记忆卡结算 | `ProfilePage.vue` | 实测 136–145 ms | 保留 |
| 61 | Layout | trace | 实测 8.3 ms | 保留 |
| 62 | UpdateLayoutTree | trace | 实测 7.9 ms | 保留 |
| 63 | Paint | trace | 实测 2.6 ms | 保留 |
| 64 | Commit | trace | 实测 5.0 ms | 保留 |
| 65 | PrePaint | trace | 实测 1.8 ms | 保留 |
| 66 | `CpuProfiler::StartProfiling` | 测量工具 | 134 ms（伪影，不计入页面） | — |
| 67 | >2 ms 的业务函数 | CPU profile | **0 个** | — |
| 68 | 长任务（>50 ms） | LongTask | **0 个** | — |
| 69 | 骨架 shimmer（`background-position` 动画） | `ProfilePage.vue` CSS | 加载期 3 个元素 | 保留（短命） |
| 70 | `ProfilePage` setup | profile | 实测 ≈0.5 ms | 保留 |
| 71 | `AboutFolderPage` setup | profile | 实测 <0.2 ms | 保留 |
| 72 | `memoryLines` 排序 + 取前 5 | `ProfilePage.vue:138` | 23 条≈0.05 ms | 保留 |
| 73 | `latestUpdatedMs` 遍历 | 同上 | 核验 | 保留 |
| 74 | `activeCount` filter | 同上 | 核验 | 保留 |
| 75 | 每张分组卡两次 `groupUpdatedText` | `ProfilePage.vue:230` | 10 次遍历/渲染 | **已修**（computed map） |
| 76 | `tileViews` / `metricsByKey` | `ProfilePage.vue:242` | 核验：4 项 | 保留 |
| 77 | `headerSubtitle` / `subtitle` | 同上 | 核验 | 保留 |
| 78 | `crumbs` | `AboutFolderPage.vue` | 核验 | 保留 |
| 79 | `visibleRows` filter | 同上 | 核验：184 行 | 保留 |
| 80 | `FolderRow` 构建（`toFileItem` + meta + hint） | 同上 | 核验：184 次 | 保留 |
| 81 | `nestedCount` ×3 | 同上 | 核验 | 保留 |
| 82 | `isFresh` 的 `Date.now()` | `ProfilePage.vue:131` | 核验：0 成本 | 保留 |

### E. 前端 · 壳与全局（83–100）

| # | 链路 | 位置 | 成本 | 状态 |
|---:|---|---|---|---|
| 83 | 页头 `ProgressiveBlur` 粗指针 2 层 | `PageHeader.vue` | 既有实测 4.28 ms/帧（软件光栅） | 保留（已按指针收层） |
| 84 | 页头 sticky + 遮罩 | 同上 | 核验 | 保留 |
| 85 | `useScrolled` rAF 合并 | `useScrolled.ts` | 每帧 1 次读 | 保留 |
| 86 | `useScrollCollapsed` | 同上 | 每帧 1 次读 | 保留 |
| 87 | `usePressGlow` 选择器解析 | `usePressGlow.ts` | 挂载一次 | 保留 |
| 88 | `rubberScroll` window 冒泡监听 | `rubberScroll.ts` | 仅 touch 手势 | 保留 |
| 89 | 页面进场 150 ms 淡入 | page transition | 150 ms | 保留（设计） |
| 90 | TabBar 玻璃 thumb 动画 | `TabBar.vue` | 一次 | 保留 |
| 91 | 卡片玻璃底 + 内阴影（**无** backdrop-filter） | `base.css` | 静态合成 | 保留 |
| 92 | 页面背景渐变（非 `fixed`） | `base.css:62` | 静态 | 保留 |
| 93 | 主包 825 KB（启动解析） | `dist` | 实测构建产物 | 保留（后续可拆） |
| 94 | mock chunk 1.1 MB | `dist` | 实测；Tauri 下 `isTauri` 分支不会加载 | 保留 |
| 95 | libheif 1.99 MB（HEIC） | `dist` | 懒加载 | 保留 |
| 96 | 路由懒加载 | `router.ts` | 核验 | 保留 |
| 97 | Tauri IPC 注入/序列化 | `transport.ts` | 估算 1–3 ms/条 | 已减少 2 条 |
| 98 | 页面读命令等 DB 锁 | `state.db` | 估算 3–38 ms（批持有） | **已修**（async + 批更快） |
| 99 | 滚动 rAF p50/p95/>33ms | CDP | 实测 3.3 / 3.5–4.3 / 1 帧 | 保留 |
| 100 | 本报告的复测基线（3 个脚本） | `scripts/perf/*` | — | 新增 |

---

## 4. 修复清单（代码）

### 4.1 后端

| 文件 | 改动 |
|---|---|
| `modules/kb/worker.rs` | ① `worker_loop` 有活连着干（不再每批等 3 s）；② `cycle` 返回「是否满批」；③ `drain_before_query` 每轮 `notify`；④ `reconcile` 加 24h/版本/启用源指纹节流 |
| `modules/kb/commands.rs` | ① `kb_read` / `kb_list_dir` **不再等索引队列**；② `kb_read` / `kb_glob` / `kb_search` / `kb_memories` / `kb_memory_stats` / `kb_cognition` 改 `#[tauri::command(async)]`；③ 新增 `kb_memory_overview` 与 `kb_root_stats`；④ note 的 l1 只切首 300 字 |
| `modules/kb/index.rs` | 未变文档不再 `UPDATE updated_at`；新增回归测试 |
| `modules/kb/listing.rs` | ① 主查询带 `LENGTH(body)`，删掉 `d_bytes` 的 N+1；② 节点按 path 建 HashMap（去掉平方级查找）；③ 新增 `root_stats`：根层计数压进 SQL `GROUP BY`，口径与 `list_dir("")` 逐项对齐（有 parity 测试） |
| `modules/kb/memory.rs` | `overview()`：一次 `active_with_idle` 产出列表 / 概况 / 注入块；`stats_from` 复用 |
| `modules/kb/chunk.rs` | 抽出 `walk_chunks`，新增 `count_chunks`（同断点算法、只数不切） |
| `modules/kb/models.rs` | 新增 `KbMemoryOverview` |
| `modules/seed.rs` | `seed_foods` 指纹 + 内置行数快速路径（连 700 KB JSON 都不解） |
| `modules/nutrition/commands.rs` | `get_profile` 改 async |
| `modules/healthsync/commands.rs` | `health_metrics_all` 改 async |
| `db.rs` | 0052：`kb_files(path) WHERE trashed_at IS NULL` 部分索引 + `ANALYZE`（无统计信息时优化器不会选这条索引，合成 5300 行实测过） |
| `lib.rs` | 注册 `kb_memory_overview` |
| `perf_probe.rs` | 新增后端断点探针（`#[ignore]`，只认 `REIN_PERF_DB` 副本） |

### 4.2 前端

| 文件 | 改动 |
|---|---|
| `pages/ProfilePage.vue` | 记忆三命令 → `kbService.memoryOverview()` 一条；目录计数 → `rootStats()`；分组「最近更新」改成一次性 computed map |
| `types/kb.ts` | 新增 `KbMemoryOverview` / `KbRootStat` |
| `services/kbService.ts` | 新增 `memoryOverview()` / `rootStats()` |
| `pages/AboutFolderPage.vue` | ① 摘要 `requestIdleCallback` 后发、并发 3→2；② `content-visibility: auto` + `contain-intrinsic-size`；③ `meta`/`hint` 在构建行时算一次 |
| `mock/server.ts` | 新增 `kb_memory_overview` / `kb_root_stats`（与 Rust 同口径） |
| `scripts/perf/*` | 两个可复现的测量脚本 |

---

## 5. 回归

| 闸门 | 结果 |
|---|---|
| `cargo test --lib` | **732 通过 / 0 失败 / 14 ignored**（新增 4 条：`unchanged_upsert_does_not_touch_updated_at`、`count_matches_chunk_text_len`、`overview_matches_the_three_separate_views`、`root_stats_match_list_dir_child_counts`；顺手修掉一条既有红灯：`exercise_guides` 未进清数据确认页分组） |
| `npm run typecheck` | 通过 |
| `npm run contract` | Rust 311 / services 311 / mock 311 ✓ |
| `npm run build` | 通过 |
| `scripts/e2e-about-settings-apps.mjs` | **20/20 通过**（热服；冷启动首次会因 Vite 依赖优化整页 reload，脚本的 `readyState` 等待偏紧，属已知测试侧抖动） |
| `scripts/perf/about-page-profile.mjs` | 挂载 103 ms / 结算 144 ms / 0 长任务 |

复测命令：

```bash
# 后端（先复制生产库！）
cd src-tauri
REIN_PERF_DB=".../rein-perf-about/rein.db" cargo test --lib about_page_probe -- --ignored --nocapture

# 前端
node scripts/e2e-run.mjs scripts/perf/about-page-profile.mjs
```

---

## 6. 未做 / 下一步（按性价比）

1. **P2 · `scan_all` 预筛**：24h 一次的全量对账仍会把未变源入队。可按源表的
   `updated_at/created_at` 与 `kb_docs.updated_at` 比对，只入队「可能变了」的行。
2. **P2 · `localeCompare` 缓存**：文件夹页 184 行排序，改用共享 `Intl.Collator('zh')`。
3. **P2 · 缩略图视口队列**：`FileIcon` 在 `onMounted` 就排队；长列表里的图片行
   会排一长串。加 IntersectionObserver（rootMargin 160px）即可。
4. **P3 · 分组根批量列举**：`kb_list_dirs(paths)` 把 2–3 次 IPC 合成 1 次。
5. **P3 · overview 瘦身**：主页只需要 `cognition.text`，不必回 `cognition.memories` 副本。

---

## 7. 已知边界

- 本文的后端数字是 debug 构建；线上 release 的绝对耗时会小 2–4 倍，
  但**排序与量级关系**（1.5 s 空等、168 s 窗口、1379 次写）与构建类型无关。
- 前端 profile 跑在浏览器 mock 上：它证明渲染不是瓶颈，但**不能**替代真机
  （Android WebView + 闪存）的端到端计时。真机复测需要 REIN_DATA_DIR 隔离 +
  应用内计时上报，本轮未做。
- 24h 对账节流牺牲了「启动即清理孤儿」的实时性；运行期增删改由 38 条
  `kb_t_*` 触发器实时入队，因此只影响「升级前遗留 / 外部改库」的孤儿，最长 24h。
