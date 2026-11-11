# 长期记忆系统（memory shards）

> 本文按**当前工作树的最终代码**整理，不是施工方案复述。方案原文在
> `.zcode/plans/memory-system/plan.md`；两者不一致的地方以代码为准，并在 §9 标出。
> 本次没有运行 `cargo test`、`npm run typecheck`、`npm run build` 或任何 e2e；
> 文末「未验证」只代表静态阅读结论。

## 0. 一页结论

- **真相源是事件流**：`memory_shard_history` 记录每个 shard 的 `birth / search_hit / manual_* /
  dream_*`；`memory_shards.stability / state / last_event_at` 是可由 history 重算的缓存
  （`src-tauri/src/modules/kb/shard/history.rs:1-14`、`decay.rs:1-18`）。
- **写入分三条路**：
  1. 会话回合 → `origin='conversation'` 的确定性切块（Rust 不调模型，`store.rs:704-855`）；
  2. 会话结束抽取 / 显式 remember → `origin='manual_write'`（`src/ai/memoryExtract.ts`、
     `memory_shard_apply`）；
  3. Dream → `origin='dream_summary'` 的四类事务动作（`dream.rs:724-921`）。
- **读取分两条路**：
  - 自动注入 `memory_shard_inject` **严格只读**：不 sweep、不 drain、不写 history/stability/state
    （`shard/inject.rs:1-12,60-263`）；
  - 主动检索 `memory_shard_search` 命中才写 `search_hit`，并受 top 3 / 阈值 / 冷却 / 30 天 10 次
    / history 512 行五道门控（`shard/retrieve.rs:321-444`）。
- **衰减**：`W = base_weight × (floor + (1-floor) × exp(-dt_days / max(stability, 0.1)))`；
  `W ≥ 0.25` active、`0.08 ≤ W < 0.25` dormant、其余 archived（`decay.rs:29-77`）。
- **没有 HNSW、没有应用层 WAL/MemTable**：SQLite 本身是 WAL，shard 直接事务写入；
  embedding 是异步可空列，缺失时检索走 FTS/LIKE/权重降级（`store.rs:1-30`、`retrieve.rs:1-9`）。
- **不跨端同步**：`memory_shards / memory_shard_history / memory_jobs / memory_dream_runs`
  都不在同步白名单里；权重与 Dream 结果按设备各自演进。

## 1. 数据模型

### 1.1 `memory_shards`（`src-tauri/src/db.rs:1833-1885`）

一行 = 一个可检索、可衰减、可溯源的认知单元。

| 列 | 含义 |
|---|---|
| `id INTEGER PK AUTOINCREMENT` | 对前端仍是数值 `memoryId`；`kb_docs.source_id` 继续用十进制字符串映射 |
| `idempotency_key TEXT UNIQUE` | 创建幂等键：`conv:<anchorId>:<chunkIndex>:<anchorHash>` / `manual:<hash>` / `dream:<runId>:<action>:<hash>` / `legacy:<id>` |
| `origin` | `conversation` / `dream_summary` / `manual_write` / `marked_important`（CHECK） |
| `mem_type` | `preference / constraint / event / entity / profile / pattern`；未知值由 `store::normalize_type` 收敛成 `preference`（`store.rs:127-138`） |
| `topic / category` | 展示与注入行格式用；category 复用两段路径净化 |
| `content` | 正文；创建时截到 `SHARD_MAX_CHARS=1800` |
| `content_hash` | 手动写入去重键（FNV-1a 64 hex，复用 `index::content_hash`）；conversation 也写，用于审计 |
| `confidence` | 只作展示/查重，不参与遗忘公式 |
| `base_weight / floor / stability / last_event_at` | 衰减参数与最后一次强化时间；`stability` 单位天 |
| `state` | `active / dormant / archived`，派生缓存 |
| `anchor_message_id / anchor_hash / chat_id / user_message_id` | conversation shard 的溯源；curated shard 也可带 anchor 供「查看原文」 |
| `provenance_json` | conversation 的 `reasoningDigest / toolCalls / userText / anchorSeq / messageIds / anchorHash`；legacy 行带 `{legacy:1, legacyActiveCount:N}` |
| `embedding / embedding_model / embedding_dim / embedding_at` | f32 LE BLOB 与模型标识；模型不匹配视为无向量 |
| `supersedes / consolidated_into / dream_action` | Dream 溯源：被推翻 / 已合并进哪条 / `supersede_new｜consolidate_merged｜digest` |
| `source_chat_id / source_message_ids` | 来源会话与消息 id JSON |
| `legacy_memory_id UNIQUE / legacy_active_count / legacy_last_used_at` | 旧 `kb_memories` 映射与只读展示 |
| `created_at / updated_at / archived_at / archived_reason` | 时间与归档原因（`decay` / `manual` / `superseded`…） |

关键索引与约束：

- `uq_memory_shards_manual_hash (origin, content_hash) WHERE origin IN ('manual_write','marked_important')
  AND content_hash IS NOT NULL AND consolidated_into IS NULL`：手动写入按内容幂等；已合并的旧行不占名额
  （`db.rs:1882-1885`）。
- `idx_memory_shards_state / origin_state / anchor / chat / last_event / consolidated`（`db.rs:1875-1881`）。
- `memory_shard_fts` 是 external-content FTS5（`tokenize='trigram'`），由 `memory_shards_fts_ai/ad/au`
  三个触发器维护（`db.rs:1887-1904`）。

### 1.2 `memory_shard_history`（`db.rs:1906-1933`）

- 主键 `(shard_id, seq)`；`seq` 由 `MAX(seq)+1` 追加（`history.rs:30-57`）。
- `event` 九类：`birth / search_hit / manual_mark / manual_edit / manual_archive / manual_restore /
  dream_consolidate / dream_revive / dream_supersede`。
- 每行记录**事件后的** `stability / base_weight / floor`，以及本次 `factor`、`rank`、`hits_30d`、
  事件时的 `origin`、`run_id`、`note`。`search_hit` 的 alpha 可由 `rank/hits_30d` 重放；
  `birth.stability` 是 s0 快照（legacy=10、manual=20、marked=90），所以调 s0 只影响新 shard
  （`history.rs:88-123`）。
- `uq_memory_shard_history_run_event (shard_id, run_id, event) WHERE run_id <> ''`：Dream 同一 run
  对同一 shard 的同一种事件最多一次（`db.rs:1931-1933`）。
- `HISTORY_MAX_ROWS=512` 是软上限：达到后 `search_hit` 只返回结果、不再写强化行，**不删历史**
  （`history.rs:23-24`、`retrieve.rs:381-384`）。

### 1.3 其余表

| 表 | 用途 | 位置 |
|---|---|---|
| `memory_jobs` | `extract`（`ref_id=anchor_message_id`）与 `embed`（`ref_id=shard id`）异步任务；`UNIQUE(kind, ref_id)`、`not_before`、`attempts`、`last_error` | `db.rs:1935-1948` |
| `memory_dream_runs` | 每次 Dream 的 `running/done/failed/cancelled`、素材计数、`actions_json/result_json` | `db.rs:1950-1961` |
| `ai_chat_messages.anchor_id` | 回合锚点，nullable；0054 全表回填，之后 `ai_chat_append` 维护 | `db.rs:1963-1965` |
| `ai_chat_seq` | 每会话单调 `next_seq`；撤回删后缀后也不复用旧 seq | `db.rs:1967-1973` |

### 1.4 不变量

1. `consolidated_into IS NOT NULL` 的 shard 不参与默认注入/检索/列表/统计/sweep；只可通过
   `memory_shard_get` / `memory_shard_events` 溯源（`store.rs:205-242`、`decay.rs:116-123`、
   `inject.rs:78-84`、`retrieve.rs:120-126`）。
2. 删除「合并目标」时先删 `consolidated_into = id` 的旧行，再删目标；否则 FK `SET NULL` 会让旧行
   重新出现在列表里（`shard/commands.rs:635-660`、`store.rs:300-332`）。
3. 归档/删除/合并必须同时删 `memory_jobs(kind='embed', ref_id=CAST(id AS TEXT))` 并 `index::delete_doc`；
   恢复/新建要 `index::mark_dirty`（`shard/commands.rs:147-159,492-538,672-758`）。
4. conversation shard 的 `anchor_hash` 必须对应当前 anchor 文本；文本变化时先删旧再重建，空文本/
   food-parse-only 不建 shard（`store.rs:720-790`）。
5. 时间列混有 RFC3339 与 SQLite `YYYY-MM-DD HH:MM:SS`；读用 `model::parse_ts`，SQL 排序/窗口用
   `julianday(...)`（`model.rs:50-77`、`store.rs:115-126`）。

## 2. 写入路径

### 2.1 会话回合 → anchor → conversation shard

**`ai_chat_append`（`src-tauri/src/modules/ai/commands.rs:904-921`）** 在一个事务里完成：

1. `allocate_chat_seq` 分配单调 seq：`max(counter, MAX(ai_chat_messages.seq)) + 1`
   （`commands.rs:714-735`）。流式 upsert 已存在的 id 时，这次分配的 seq 成为空洞，但计数器继续前进。
2. 按 id upsert 消息；INSERT 时 `anchor_id` 先为 NULL，`ON CONFLICT` 不覆盖 `anchor_id`
   （`commands.rs:755-781`）。
3. 取实际 seq，算出本回合 `[turn_start, turn_end)`：`turn_start` 是之前最近一条 user 的 seq（没有则 0），
   `turn_end` 是之后第一条 user 的 seq（没有则 `i64::MAX`）。
4. terminal 判定（`commands.rs:701-712`）：
   - `role='assistant' AND kind IN ('text','analysis')` 且 `TRIM(text)` 非空 → terminal；
   - `kind='food-parse'` 无论 text 是否为空 → terminal；
   - `voice` 是 **user** 消息，不在 terminal 集合里；assistant 对语音的回复是普通 text。
5. 在回合内按 **seq**（不是到达顺序）选 anchor：最新 terminal 优先；没有 terminal 时退化为最后一条
   assistant；晚到的旧 terminal upsert 不会把锚点往回搬（`commands.rs:814-838`）。若本条成为 anchor，
   把整回合消息的 `anchor_id` 回填成本条 id；若已有 terminal 且本条是过程消息，则继承当前 anchor。
6. 若 anchor 从旧消息移走，`apply_append_side_effects` 在同一事务里删旧 anchor 的 conversation shard
   （history/doc/embed job 一起），并对 terminal `enqueue_extract(chat_id, message_id, now)`
   （按 anchor 去重，不按 chat；`commands.rs:876-897`）。

**`store::process_extract(conn, anchor_id)`（`store.rs:708-855`）** 设计上由 worker / 检索 drain 调用
（当前只有 `memory_shard_search` 真正调用，见下文）：

1. 按 anchor id 取 `ai_chat_messages WHERE id=? AND anchor_id=id AND role='assistant'`；消息被撤回或锚点
   已移动 → 删该 anchor 的 conversation shard 与 extract job，返回 0。
2. 可读文本：`kind IN ('text','analysis','food-parse')` 且 `TRIM(text)` 非空才建 shard；
   `tools`（过程 fallback anchor）/ 空文本 food-parse → 删旧 shard、删 job、返回 0。
3. `anchor_hash = content_hash([text, kind])`；该 anchor 已有 shard 且 hash 全相同 → 幂等，删 job 返回 0；
   hash 不同 → 标记为替换。
4. 取回合消息（`WHERE chat_id=? AND anchor_id=anchor.id ORDER BY seq`），生成 `provenance_json`：
   `reasoningDigest`（`payload.thinking` + `segments.kind='reasoning'`，截 500 字）、
   `toolCalls`（`segments.kind='tool'` 的 `{name, ok, brief}`，最多 8 条）、`userText`（回合第一条 user，
   截 500 字）、`anchorSeq/messageIds/anchorHash`。
5. `chunk_text(text, 1800, 100)` 切块（`anchor.rs:157-160`）；先算 `new_total = total - old_count + chunks.len()`，
   超过 `TOTAL_SHARD_SOFT_CAP=50000` 时**保留旧 shard 不删**、删 job、返回 0（`store.rs:766-785`）。
6. 只有判断通过才删旧、逐块插入：`origin='conversation'`、`mem_type='event'`、base 1.0 / floor 0.05 /
   s0 3、`anchor_message_id/anchor_hash/chat_id/user_message_id`、`confidence=0.7`、
   `idempotency_key='conv:<anchorId>:<i>:<anchorHash>'`；同时写 `birth` history、`enqueue_embed`、
   `index::mark_dirty("memory", id)`（`store.rs:787-855`）。

**当前实际触发点（重要）**：

- `memory_shard_search` 在锁内 `sweep_if_due` 后调 `store::drain_extract(&conn, 50)`，最多 50ms
  （`shard/commands.rs:1040-1050`），作为检索前的机会性追赶。
- `memory_shard_inject` **不 drain**（`shard/commands.rs:1100-1141`）。
- `worker.rs` 的主循环每轮都会消费记忆队列：先 `drain_extract(50ms)`，再
  `take_embed_batch(16)` 并在放锁嵌入后 `store_embeddings` 写回（失败走 `fail_embed_jobs` 退避）。
  启动对账额外做 `backfill_legacy`，并在全量索引的 24h 节流点跑
  `reconcile_conversation_shards(30)`；`enqueue_missing_embeddings(500)` 在启动与之后每 60s 补投。
  因此 terminal 消息落库约 3s（`not_before`）后后台就会生成 conversation shard，不再依赖主动检索。

**撤回 / 清空（`ai/commands.rs:924-996`）**：

- `ai_chat_cut`：先按「cut_seq 之后消息范围内出现过的 `anchor_message_id`」删 conversation shard，
  再把 curated shard 里指向被删消息的 `anchor_message_id/user_message_id` 置 NULL，最后删除消息；
  全部在同一事务。
- `ai_chat_clear`：删该 chat 所有 conversation shard，curated shard 的锚点置 NULL，再删消息。

**跨设备对账（代码已写，当前无调用方）**：`store::reconcile_conversation_shards(conn, 30)`
（`store.rs:861-949`）先 `anchor::backfill_missing(30)`，再删 anchor 不存在/已移动的 conversation shard、
把 curated 悬空锚点置 NULL、对最近 30 天可读 anchor 补投 extract job。`store::backfill_legacy`
（`store.rs:982-1050`）补 legacy `content_hash` 与 anchor，并用 `app_meta` 键
`memory.legacy_backfill_v1` 保证只跑一次。两者当前都没有被启动路径调用。

### 2.2 显式写入（manual_write / marked_important）

**`memory_shard_apply(actions, chatId?, messageIds?)`**（`shard/commands.rs:923-938`）：

- `add`：content trim；空跳过；超过 1800 截断加 `…`。按 `(origin IN manual/marked) AND content_hash=? AND
  consolidated_into IS NULL` 查重：
  - 命中 archived → 复活为 active，`stability=max(当前, birth)`，写 `manual_restore`；
  - 命中 active/dormant → `skipped++`；
  - 未命中 → 新建 manual_write，base 2.5 / floor 0.15 / s0 20，写 `birth`、`enqueue_embed`、`mark_dirty`。
- `update`：只改传入且非空的字段；content 变化时重算 hash 并检查与另一条未合并 manual/marked 的冲突
  （冲突报「内容与已有记忆重复」）；content 变化会清空 `embedding*` 并重投 embed job；写 `manual_edit`；
  已归档行被 update 会复活（`updated/restored` 计数区分）。
- `delete`：已合并的旧行跳过；删除合并目标时先删其子行。
- `archive`：`state='archived'`、`archived_reason`、写 `manual_archive`、`delete_doc`、删 embed job；
  已归档返回 false（`skipped`）。
- 每次非空 apply 追加一条旧 `kb_memory_diffs` 审计（`shard/commands.rs:473-487`）。

**`memory_shard_update(id, patch)`**（`shard/commands.rs:940-954`，实现在 `:540-633`）：与 apply 的 update 同语义，但缺行/已合并
直接报错；返回更新后的读模型。

**`memory_shard_mark_important(id, note?)`**（`shard/commands.rs:1002-1016,712-758`）：

- origin 改为 `marked_important`，base 4.0 / floor 0.35，`stability=min(max(S*2,90), S_MAX)`；
- 无论之前是否归档都置 active、清 archived 字段、写 `manual_mark`、`mark_dirty`；
- 已合并 shard 报「该记忆已合并，请标记合并后的记忆」。

**归档 / 恢复 / 删除**：`memory_shard_archive` / `memory_shard_restore` / `memory_shard_delete`
（`shard/commands.rs:956-1016,635-710`）。恢复时 stability 取 `max(当前, birth history 的 stability)`，
所以 legacy 行恢复不会被抬到 manual_write 的 20；已 active 或已合并返回 false。

**前端抽取**：`memoryExtract.ts` 只允许改 `origin IN ('manual_write','marked_important')`，最多 8 个 op，
content 硬上限 1800；`add` 新写 manual_write，`conversation` 只作为背景（`memoryExtract.ts:22-40,138-220`）。
工具 `remember` 走同一条 apply；`edit_memory` / `forget` 走 update/delete；`list_memories` 走兼容列表；
主动回忆工具实际名是 **`recall_memory`**（不是 `search_memories`），且固定
`reviveArchived=false`（`agent/tools/kb.rs:284-380`、`src/ai/tools/memory.ts:60-126`）。
**没有 `mark_memory_important` 工具**：标记重要只能由用户操作或前端按钮触发。

### 2.3 异步 embedding（worker 调度）

- 新建/内容变化的 shard `enqueue_embed`（`store.rs:432-444`）；worker 用
  `take_embed_batch(conn, 16)` 取 `{shard_id, content}`（JOIN 过滤已删 shard，`store.rs:499-521`），
  **放掉 DB 锁**调 `Embedder::embed`，再持锁写 `embedding/embedding_model/embedding_dim/embedding_at`
  并删 job（`store.rs:523-552`）。
- 失败：`attempts++`、`last_error`、`not_before = now + min(3600, 30 * 2^attempts)` 秒；job 保留供重试。
  `memory_shard_stats.embedding_failed` 统计 `attempts >= 3 OR last_error IS NOT NULL`，检索继续走
  FTS（`store.rs:550-574`、`shard/commands.rs:826-833`）。
- 模型切换：`embedding_model != 当前 model_id` 视为无向量；worker 启动时与运行期每 60s 调
  `enqueue_missing_embeddings(conn, model_id, 500)` 补任务（`store.rs:579-606`）。
- 消费方是 `worker.rs::cycle`，因此检索 `mode` 会在向量补齐后自然从 `keyword`/`weight` 升级到 `vector`，
  `memory_shard_duplicates` 也会随当前模型向量出现。

### 2.4 Dream 写入

见 §5；Dream 的模型调用只在前端 `src/ai/memoryDream.ts`，Rust 的 `memory_dream_apply` 只做校验与事务 apply
（`dream.rs:1-12,586-638`）。

## 3. 衰减与状态机

### 3.1 公式

```text
dt_days = max(0, (now - last_event_at) / 86400)
R       = exp(-dt_days / max(stability, 0.1))
W       = base_weight * (floor + (1 - floor) * R)

state = active   if W >= 0.25
        dormant  if W >= 0.08
        archived otherwise
```

实现：`decay.rs:41-77`。`last_event_at` 解析失败按「刚发生」（dt=0）处理，避免坏格式把记忆误归档。
`floor` 是**乘数**：`base × floor` 是渐近下界，不是最终权重；例如 manual_write 2.5×0.15=0.375 永远
active，conversation 1.0×0.05=0.05 最终一定 archived（`decay.rs:12-15`）。

### 3.2 参数表（逐字对应代码）

| origin | base_weight | floor | s0 (天) | 代码 |
|---|---:|---:|---:|---|
| `conversation` | 1.0 | 0.05 | 3.0 | `store.rs:103-107` |
| `dream_summary` | 2.0 | 0.10 | 10.0 | `store.rs:108-112` |
| `manual_write`（含未知 origin 兜底） | 2.5 | 0.15 | 20.0 | `store.rs:113-124` |
| `marked_important` | 4.0 | 0.35 | 90.0 | `store.rs:113-117` |
| legacy `kb_memories` 回填行 | 2.0 | 0.10 | 10.0 | `db.rs:2056-2079`（origin 仍记 `manual_write`） |

阈值：

| 常量 | 值 | 位置 |
|---|---:|---|
| `THETA_ACTIVE` | 0.25 | `decay.rs:30` |
| `THETA_DORMANT` | 0.08 | `decay.rs:32` |
| `SWEEP_INTERVAL_SECS` | 600 | `decay.rs:34` |
| `SWEEP_MAX_ROWS` | 20000 | `decay.rs:36` |
| `S_MAX` | 3650 | `model.rs:44` |
| `HISTORY_MAX_ROWS` | 512 | `history.rs:24` |
| `SHARD_MAX_TOKENS` | 1024 | `model.rs:40` |
| `SHARD_MAX_CHARS` | 1800 | `model.rs:42` |

### 3.3 状态可见性

| state | 自动注入 | `memory_shard_search` | `kb_search`（镜像） | 列表/页面 |
|---|---|---|---|---|
| `active` | ✅ | ✅ | ✅ | 活跃 |
| `dormant` | ❌ | ✅（默认 `includeDormant=true`） | ✅ | 休眠 |
| `archived` | ❌ | 仅 `includeArchived=true`；`reviveArchived=true` 且 relevance ≥0.75 才复活 | ❌（`memory_doc` 返回 None） | 归档 |

`dormant` 不进自动注入是硬门控；`archived` 不物理搬冷层，只退出热层排序与注入，仍可按 id 查、
可手动恢复、可显式挖坟（`inject.rs:78-99`、`retrieve.rs:114-126,376-380`）。

### 3.4 懒巡检与 sweep

- `app_meta['memory.shard.last_sweep_at']` 存 RFC3339；`SWEEP_INTERVAL_SECS=600` 节流
  （`decay.rs:79-109,185-198`）。
- 触发点：`memory_shard_search` 开始前、`memory_shard_list/stats/overview` 开始前、6h worker 的
  `memory::maintain`（内部 `sweep(force=true)`）、`memory_shard_sweep`、`kb_memory_maintain`。
- 扫描 `state != 'archived' AND consolidated_into IS NULL` 的最近 20000 行；
  `active→dormant` 只改 state；`active/dormant→archived` 写 `archived_at`、`archived_reason='decay'` 并
  `index::delete_doc`；`dormant→active` 清归档字段并 `index::mark_dirty`。
  **sweep 不写 history**，state 是派生缓存（`decay.rs:111-183`）。
- 超过 20000 行只扫最近 20000，`memory_shard_stats.sweep_truncated` 为 true（`decay.rs:36`、
  `shard/commands.rs:870-871`）。

## 4. 检索与注入

### 4.1 自动注入：严格只读

命令：`memory_shard_inject(query?, budgetTokens?, maxShards?, includeConversation?)`
（`shard/commands.rs:1104-1141`）。默认 `budgetTokens=2000`（clamp 200..8000）、`maxShards=8`（clamp 1..20）、
`includeConversation=false`。

流程（`shard/inject.rs:60-263`）：

1. 候选 SQL：`consolidated_into IS NULL AND state='active'`；默认 `AND origin != 'conversation'`；
   `ORDER BY julianday(last_event_at) DESC, id DESC LIMIT 5000`。
2. 读时按 `effective_weight` 再过滤一次 `W >= THETA_ACTIVE`，兜住 state 缓存最多 10 分钟的滞后。
3. 排序三层：`marked_important` 最多 3 条（按 weight、updated_at）→ `dream_action='digest'` 最多 2 条 →
   其余 `relevance × effective_weight`。query 为空或只有 1 个字符时 relevance 统一 1.0（按权重）；
   2 个字符及以上才做向量/关键词相关性（`inject.rs:70-72,100-129`）。
4. 预算：`estimate_tokens(line)=ceil(chars/1.6)+6`；总 tokens ≤ budget、总字符 ≤3200、条数 ≤maxShards；
   某条放不下就 `continue` 尝试后面的小条目，不直接 break。内容按 trim 后文本去重（锚点层先入）。
5. `includeConversation=true` 时 conversation 条目最多 2 条、总字符 ≤600，单独门控。
6. 渲染统一为 `- [类型·分类] 内容`，category 为空时 `- [类型] 内容`；`mode` 为
   `vector`（有向量参与）/ `keyword`（有 query 但无向量）/ `weight`（无 query 或 1 字浏览）。
7. **本函数没有任何 INSERT/UPDATE**，也不调 sweep/drain（`inject.rs:1-12,58-59`）。

### 4.2 主动检索：命中才续命

命令：`memory_shard_search(query, topK?, includeDormant?, includeArchived?, reviveArchived?)`
（`shard/commands.rs:1018-1098`）。默认 `topK=8`（clamp 1..20）、`includeDormant=true`、
`includeArchived=false`、`reviveArchived=false`；`reviveArchived=true` 会隐含把 archived 放进结果集。

流程：

1. 锁内 `sweep_if_due` + `drain_extract(50ms)` + 读 embedding 配置；放锁嵌入 query；再锁检索/强化。
2. 候选：默认 `state IN ('active','dormant') AND consolidated_into IS NULL`；`includeArchived` 加 archived；
   `includeDormant=false` 只 active；按 `julianday(last_event_at)` 取最近 5000（`retrieve.rs:108-137`）。
3. 排序：
   - 有 query embedding 且 shard 同模型：`cosine`；
   - **总是**并集 FTS trigram（relevance 0.70）与 LIKE（0.55），同一 shard 取 max；
   - `score = relevance × effective_weight`；有 query（≥2 字）但 relevance=0 的候选丢弃；
   - query 为空/1 字 = 浏览，relevance=1.0，按权重排序（`retrieve.rs:231-319`）。
4. `mode`：有向量参与为 `vector`，有 query 为 `keyword`，否则 `weight`。
5. 强化（单事务，失败不影响结果）——**五道硬门控**：
   - 只处理 `rank < 3` 且 `relevance >= 0.60`（`RELEVANCE_THRESHOLD`）；
   - 同一 shard 距上次 `search_hit` < 600s → 不写；
   - 30 天内 `search_hit` ≥ 10 → 不写；
   - history 行数 ≥512 → 不写（结果照常返回）；
   - archived 只有 `reviveArchived=true` 且 `relevance >= 0.75` 才复活；否则只返回、不改状态。
   - `hits_30d >= 5` 时 `alpha=0.4`，否则 0.8；`factor=1+alpha/(1+rank)`；
     `stability=min(S*factor, S_MAX)`；写 `search_hit`、`touch_shard`；dormant 命中通过门控后置 active 并
     `mark_dirty`（`retrieve.rs:321-444`）。
6. 关键词模式的前置门控在命令层：`mode==='keyword'` 时必须 `query` 字符数 ≥3 才可能强化；LIKE 的 0.55
   低于阈值，永远不会写 `search_hit`。`reinforce` 的 `keyword_mode` 参数目前未参与判断
   （`retrieve.rs:339-345`、`shard/commands.rs:1071-1089`）。

返回 `hits / mode / reinforced / revived / tookMs`（`model.rs:311-338`）。

### 4.3 相关性降级阶梯

| 条件 | 召回 | relevance | 是否写 `search_hit` |
|---|---|---|---|
| 有 query 向量 + shard 同模型向量 | 暴力余弦最近 5000，并集 FTS/LIKE | cosine；关键词 0.70/0.55 取 max | cosine ≥0.60 且通过门控 |
| 无向量，query ≥3 字且 FTS 可用 | `memory_shard_fts MATCH match_expr(?)` | 0.70 | 仅 FTS 命中且 query ≥3 字、通过门控 |
| FTS 无果 / query 2 字 | `content LIKE '%' || ? || '%' ESCAPE '\'` | 0.55 | 永不（<0.60） |
| query 为空 / 1 字 | 无关键词召回，按 `effective_weight` | 1.0 | 永不（浏览，不是确认） |
| FTS 构建/执行错误 | 捕获后降级 LIKE | 0.55 | 永不 |
| 模型加载失败 | 不构建 embedder，走关键词/权重 | 同上 | 同上 |

FTS 查询必须复用 `search::match_expr` / `too_short_for_trigram`：按空白切词、每个词双引号包成短语、
内部引号翻倍、词间 AND；任何 FTS 错误都降级 LIKE（`retrieve.rs:166-224`）。空/1 字查询不扫全表。

### 4.4 注入与 `kb_cognition` 的关系

`kb_cognition` 是兼容命令：内部 `inject::select(None, ..., include_conversation=false)`，把
`MemoryInjectShard` 投影成旧 `KbMemory`，文本仍是 `- [类型·分类] 内容`；**不再 bump**
（`memory.rs:313-358`）。`chat.ts` 只接收 `cognition?: string` 并拼「【用户认知】」，不改格式。

## 5. Dream（离线维护者）

### 5.1 定位与权限

- 模型调用只在前端：`src/ai/memoryDream.ts` 用 `RustAgent`（`tools: []`、`thinkingLevel:'off'`）读 context、
  调模型、解析 JSON；Rust 的 `memory_dream_begin/apply/cancel` 只做门控、上下文、事务 apply
  （`dream.rs:1-12`、`memoryDream.ts:280-294`）。
- 四类动作：`supersede / consolidate / digest / revive`。**没有 `mark_important`**：
  `DreamAction` 枚举没有该变体；JSON 入口显式以 `dream_action_forbidden` 拒绝
  （`dream.rs:121-136`）。
- `memory_dream_apply` 入参是 `Vec<serde_json::Value>`，先 `decode_actions` 再开事务；线上形状与
  `Vec<DreamAction>` 一致（`dream.rs:80-100`）。

### 5.2 触发门控 `memory_dream_begin(force?)`（`dream.rs:174-290`）

1. 清理超过 `DREAM_LEASE_MINUTES=10` 的 `running` lease（置 failed/timeout）。
2. 仍有未过期 `running` → `reason='running'`。
3. 读 `kb_settings.auto_consolidate`；`force=false` 且为 0 → `disabled`。
4. `last_finished = MAX(finished_at) WHERE status='done'`；
   `sessions_since / messages_since` 统计 `created_at` 严格晚于它的会话数/消息数（无 last 则全量）。
5. `force=false` 且距上次完成 <3h → `cooldown`。
6. `sessions_since < 1 OR messages_since < 5` → `no_material`（0 条消息）或 `insufficient_material`；
   **force 也不跳过**。
7. 通过后生成 `run_id="dream-<timestamp_ms>-<pid>"`（同毫秒重复加 `-n`），插入
   `memory_dream_runs(status='running', session_count, message_count)`，同一事务组装 context。

### 5.3 Context（`dream.rs:337-482`）

- 最多 8 个会话、200 条消息、40 条 shard 摘要、20 对疑似重复；
- 消息只收 `kind IN ('text','food-parse','analysis','voice')` 且有正文的；`voice` 只收 user；
  不读 `image_base64` / `payload`；
- shard 摘要只取未合并 active/dormant，curated 优先，content 截 300；
- 重复对只用同一 `embedding_model` 的已落库向量，本地余弦 ≥0.86；无向量返回空表，prompt 明说
  「没有向量提示」。

### 5.4 四类动作的事务语义（`dream.rs:586-921`）

| 动作 | 新 shard | 旧 shard | 幂等键 | 计数 |
|---|---|---|---|---|
| `supersede` | `dream_summary` + `dream_action='supersede_new'` + `supersedes=old`，base 2/floor 0.1/s0 10 | archived，`archived_reason='superseded'`，写 `dream_supersede` | `dream:<run>:supersede:<old>:<hash(content)>` | `created`、`superseded` |
| `consolidate`（≥2 个不同 id） | `dream_summary` + `consolidate_merged` | `consolidated_into=merged`，`base_weight *= 0.5`，写 `dream_consolidate`；不删除、不归档 | `dream:<run>:consolidate:<hash(sorted ids)>:<hash(content)>` | `created`、`consolidated` |
| `digest` | `dream_summary` + `dream_action='digest'` | 无 | `dream:<run>:digest:<hash(content)>` | `created` |
| `revive` | 无 | 仅 `state='dormant'` 且 `R∈[0.10,0.30]`：`S=min(S*1.25,S_MAX)`、active、写 `dream_revive` | history `(shard,run,event)` 唯一 | `revived` |

- 校验：动作数 ≤12；所有 content 非空且 ≤1800 字；consolidate 的 id 去重后 ≥2；所有 id 必须存在；
  未知 type / `mark_important` 报错（`dream.rs:668-722`）。
- **整批一个 `unchecked_transaction`**：任一动作失败整体回滚，run 仍保持 running；前端随后
  `memory_dream_cancel`（`dream.rs:611-637`、`memoryDream.ts:351-372`）。
- 镜像同步：新 shard `mark_dirty`；supersede/consolidate 的旧 shard `delete_doc` + 删 embed job；
  revive `mark_dirty`（`dream.rs:1035-1048`、`apply_one` 各分支）。
- 完成后 run 置 done、写 `actions_json/result_json`；同一 run 再次 apply 返回首次结果并带
  `alreadyApplied=true`（`dream.rs:600-603,1050-1063`）。`cancel` 只对 running 生效，error 非空 → failed，
  否则 cancelled；已 done/failed/cancelled 直接返回（`dream.rs:641-666`）。

### 5.5 前端编排与降级（`memoryDream.ts:310-373`）

- 无默认模型：直接 `{skipped:'no_model'}`，不调 begin、不产生 run 行。
- 客户端 3h 冷却（localStorage `rein.memory.dream.lastAt`）只做兜底；权威冷却在 Rust。
- `toDreamActions` 只接受四类、最多 12 条、content 截 1800、id 必须在 context 的 shard 集合里；
  `mark_important`/未知 type 丢弃。
- 模型返回非法 JSON 或空：仍 `memoryDreamApply(runId, [])` 结束 run，避免冷却前反复触发。
- 失败：`memoryDreamCancel(runId, message)`，绝不把异常抛给聊天 UI。
- `stores/memory.ts` 的 `dreamNow` 有 `dreaming` 互斥；`maybeDreamOnIdle` 还有 5 分钟内存节流与
  `ai.busy` 门禁（`src/stores/memory.ts:193-229`）。

## 6. 检索/注入参数总表

| 常量 | 值 | 位置 |
|---|---:|---|
| `RELEVANCE_THRESHOLD` | 0.60 | `retrieve.rs:24` |
| `SEARCH_TOP_K` | 8（clamp 1..20） | `retrieve.rs:26`、`shard/commands.rs:1033` |
| `SEARCH_CANDIDATES`（FTS/LIKE 候选） | 50 | `retrieve.rs:28` |
| `CANDIDATE_LIMIT` | 5000 | `retrieve.rs:30` |
| `ALPHA_BASE` / `ALPHA_REDUCED` | 0.8 / 0.4 | `retrieve.rs:32-34` |
| `REDUCED_AFTER_HITS` | 5 | `retrieve.rs:36` |
| `HIT_WINDOW_DAYS` | 30 | `retrieve.rs:38` |
| `MAX_HITS_30D` | 10 | `retrieve.rs:40` |
| `REINFORCE_MAX_HITS` | 3 | `retrieve.rs:42` |
| `SEARCH_HIT_COOLDOWN_SECONDS` | 600 | `retrieve.rs:44` |
| `REINFORCE_MIN_QUERY_CHARS` | 3 | `retrieve.rs:46` |
| `ARCHIVED_REVIVE_RELEVANCE` | 0.75 | `retrieve.rs:48` |
| `DUP_SCAN_LIMIT` | 400 | `retrieve.rs:50` |
| `INJECT_BUDGET_TOKENS` | 2000（clamp 200..8000） | `inject.rs:29`、`shard/commands.rs:1113` |
| `INJECT_MAX_CHARS` | 3200 | `inject.rs:31` |
| `INJECT_MAX_SHARDS` | 8（clamp 1..20） | `inject.rs:33` |
| `INJECT_ANCHOR_MAX` | 3 | `inject.rs:35` |
| `INJECT_DIGEST_MAX` | 2 | `inject.rs:37` |
| `INJECT_CONVERSATION_MAX / CHARS` | 2 条 / 600 字符 | `inject.rs:39-40` |
| `TOTAL_SHARD_SOFT_CAP` | 50000（只卡 conversation 新建/替换） | `store.rs:31` |
| `DREAM_COOLDOWN_HOURS` | 3 | `dream.rs:34` |
| `DREAM_MIN_SESSIONS / MESSAGES` | 1 / 5 | `dream.rs:36-38` |
| `DREAM_MAX_ACTIONS` | 12 | `dream.rs:40` |
| `DREAM_REVIVE_MIN_R / MAX_R` | 0.10 / 0.30 | `dream.rs:42-44` |
| `DREAM_LEASE_MINUTES` | 10 | `dream.rs:46` |

列表/统计的默认值：`memory_shard_list` limit 200（clamp 1..500）、offset 0、scope 未知收敛 active；
`memory_shard_events` limit 50（clamp 1..200）；`memory_shard_duplicates` threshold 0.86（clamp 0.5..0.99）、
limit 30（`shard/commands.rs:879-894,1194-1236`）。

## 7. 迁移与兼容

### 7.1 迁移边界

- 0053 只做 schema：shards / FTS + 触发器 / history / jobs / dream_runs / `ai_chat_messages.anchor_id`
  / `ai_chat_seq`（`db.rs:1832-1974`）。
- 0054 做数据回填：anchor 全表回填、seq 计数器、旧 `kb_memories` 映射、birth/archive history、ANALYZE
  （`db.rs:1976-2107`）。
- 两条迁移都是加法式；旧二进制忽略新表/新列，`kb_memories` 原样保留。
- 0054 在 anchor UPDATE 前后 `DROP`/原样重建 `kb_t_msgs_au`，避免给每条消息写 `kb_dirty('chat_message')`
  （`db.rs:2030-2044`）；anchor 回填用临时表 + 唯一索引，UPDATE 是 O(n log n)，不是相关子查询 O(n²)
  （`db.rs:2022-2039`）。

### 7.2 旧 `kb_memories` → `memory_shards` 对照

| 旧列 | 新落点 | 说明 |
|---|---|---|
| `id` | `legacy_memory_id` + 新 `id` | 不复用旧整数；`legacy_memory_id UNIQUE` 保证幂等 |
| `mem_type/topic/category/content/confidence` | 同名列 | 原样 |
| `active_count` | `legacy_active_count` + provenance | **不写成 `search_hit`**；兼容投影 `active_count` 固定 0 |
| `last_used_at` | `legacy_last_used_at` + `last_event_at` | `last_event_at=COALESCE(last_used_at, updated_at, created_at)` |
| `created_at` | `created_at` + birth history | birth stability=10 |
| `updated_at` | `updated_at` | 原样 |
| `archived_at/archived_reason` | 同名 + `state` | 有 archived_at → `state='archived'`，补 `manual_archive` history |
| `source_chat_id` | `source_chat_id` + `chat_id` | 原样 |
| `source_message_ids` | 同名 | Rust `backfill_legacy` 可从中倒序找最后一条 assistant 填 anchor |
| `kb_memory_diffs` | 保留原表 | 兼容层继续写旧审计；Dream 事件走 `memory_shard_history` |

迁移专用先验：`origin='manual_write'`，但 base 2.0 / floor 0.10 / s0 10，provenance 带
`{legacy:1, legacyActiveCount:N}`（`db.rs:2056-2079`）。`content_hash` 迁移时留 NULL，应由
`store::backfill_legacy` 补；该函数当前无启动调用方，所以 **legacy 行在新手动 add 的内容去重上会漏配**
（新 add 的 hash 不为 NULL，旧行 hash 为 NULL，查重条件 `content_hash = ?` 不会命中旧行）。
`anchor_message_id` 同理，未跑 backfill 时为 NULL，「查看原文」不可用。

### 7.3 兼容适配层（`memory.rs`）

- `kb_memories` / `kb_memory_overview` / `kb_memory_stats` / `kb_memory_duplicates` / `kb_cognition`
  只投影 curated（排除 `conversation`）（`memory.rs:1-18,120-358`）。
- `salience` = 读时 `effective_weight`；`active_count` 固定 0；`last_used_at` 用 `last_event_at` 近似。
  `kb_memories` 的 `scope=active` 包含 dormant（`in_scope` 只排除 archived）；但
  `kb_memory_stats.active` 仍只数 `state='active'`，`stale` = dormant 数（`memory.rs:96-118,268-300`）。
- `kb_memory_apply` 复用 `apply_actions_conn`，写旧 `kb_memory_diffs`；`kb_memory_delete/archive/restore`
  复用 shard 实现；`kb_memory_maintain` → `sweep(force=true)` 并写 `last_maintain_at`。
- `kb_memory_bump` 与 `kb_memory_consolidated` 是 **no-op**（`memory.rs:360-367`）；自动注入不再「续命」。
- `kb_memory_diffs` 继续读旧审计表；Dream 事件不在其中。
- 旧 `kb_docs / kb_chunks / kb_vectors` 不迁移：它们是派生缓存；worker 对账后按新 shard 重新派生/清理。
- **回滚**：旧版本二进制不读新表，`kb_memories` 原样保留；回退后旧记忆仍可用。迁移后写入的新 shard
  只在新表，旧版本看不到；需要完整回滚用发布前备份的 `rein.db`（含 `-wal`/`-shm`）。
- **同步**：`memory_*` 表与 `ai_chat_seq` 都不进同步白名单；当前 `sync/tables.rs:231-243` 的
  `ai_chat_messages` spec **没有** `skip: ["anchor_id"]`，`sync/apply.rs` 也**没有** seq 冲突重编号特判。
  这与方案要求不一致（见 §9），跨设备同步前必须补齐，否则 0054 回填会改变对象指纹、同 seq 冲突会让
  整批 apply 失败。

## 8. 降级路径

| 条件 | 行为 |
|---|---|
| 无模型（抽取/Dream） | 抽取静默跳过；Dream `skipped='no_model'`，不产生 run；聊天与注入正常 |
| 无 embedding / 模型加载失败 | 检索走 FTS(0.70) → LIKE(0.55) → 权重三级；`mode` 明示 |
| FTS 特殊字符/语法错误 | `match_expr` 转义；执行错误捕获后降级 LIKE，不让 `memory_shard_search` 整体失败 |
| query <2 字 | 不扫全表；注入/检索按权重浏览，不写 `search_hit` |
| embedding 模型切换 | `embedding_model` 不匹配视为无向量；设计上 `enqueue_missing_embeddings` 补任务 |
| conversation 总量 >50000 | `process_extract` 保留旧 shard、不新建/不替换、删 job；manual/dream/marked 仍可写；stats `atCap` |
| active >5000 | 候选按 `last_event_at` 截前 5000；其余仍可被 FTS 命中 |
| history ≥512 行 | 停止写 `search_hit`，结果照常返回 |
| 单条放不进注入预算 | 跳过并继续尝试后面的小条目；总字符硬上限 3200 |
| `localStorage` 不可用 | 只影响虚拟列表高度缓存，不影响记忆系统 |

## 9. 已知局限与未验证（按当前代码）

1. **异步链路时延**：worker 已消费 `drain_extract` / `take_embed_batch`，并接线
   `enqueue_missing_embeddings` / `reconcile_conversation_shards` / `backfill_legacy`，但都有节拍：
   - conversation shard 在 terminal 落库后约 3s（`not_before`）由后台抽取，启动瞬间仍有短暂延迟；
   - 缺失向量补投每 60s 一次，换模型后最多一分钟内检索仍走 `keyword`/`weight`；
   - 跨设备 reconcile 跟随全量索引的 24h 节流，不是实时。
2. **启动首屏/同步**：`ai_chat_messages` 的 sync spec 未 skip `anchor_id`；`sync/apply.rs` 未对
   `(chat_id, seq)` 冲突重编号、按 id UPDATE 也未排除 `seq`。跨设备同步会有重传与整批失败风险。
3. **维护页清空**：清理组直接 `DELETE FROM memory_shards/...`（`maintenance/commands.rs:215-230,567-601`），
   没有调 `store::clear_all`；若只清「AI 聊天、长期记忆」组，`kb_docs(source_type='memory')` /
   `kb_dirty('memory')` 要等另一组「AI 工作区文件与知识库索引」清空或 worker 对账，期间可能残留旧记忆文档。
4. **`memory_shard_overview` 的排序**：先 `list_shards("all")` 再按 `updated_at` **字符串**降序
   （`shard/commands.rs:1148-1154`），没有用 `julianday`；legacy 的 SQLite 空格时间与 RFC3339 混排时顺序
   可能不符合直觉。`memory_shard_list` 用的是 `julianday(updated_at)`，两者口径不完全一致。
5. **`memory_shard_list` 的 scope**：`active` 只返回 `state='active'`，不含 dormant；兼容 `kb_memories`
   列表的 Active scope 才包含 dormant。`kb_memory_stats.active` 也只数 active，dormant 单独在 `stale`。
   页面切「活跃/休眠/归档」必须走服务端 scope，否则会选错。
6. **`memory_shard_apply` / `memory_shard_update` 不校验 origin**：Rust 层允许按 id 改 conversation shard；
   前端抽取层（`memoryExtract.ts`）才限制只改 manual/marked。工具/外部调用直接走命令时没有这层保护。
7. **`memory_shard_apply` 的 `add` 去重键是内容 hash**，不是旧 `UNIQUE(mem_type,topic,content)`；同内容
   不同类型会被视为同一条。这是有意收敛，但迁移前的旧行 `content_hash` 为 NULL 时不参与。
8. **`active_count` 兼容投影固定 0**：旧字段的历史计数保留在 `legacy_active_count` / provenance，但
   `kb_memories.active_count` 不再展示旧值。依赖该字段排序的旧 UI 会看到全 0。
9. **Dream 的质量未验证**：`memoryDream.ts` 只保证结构、权限、事务与幂等；提示词质量、模型是否真的
   `supersede/consolidate/digest/revive` 得当，需要在有真实模型凭据的真机上评估。本仓库不写任何凭据。
10. **`RELEVANCE_THRESHOLD=0.60` 未在真实记忆库校准**：它只是经验值；调低会提高噪音强化，调高会漏召回。
    `ARCHIVED_REVIVE_RELEVANCE=0.75` 在关键词模式（最高 0.70）下实际上无法触发 archived 复活，只有向量
    命中才可能；显式「挖坟」在无 embedding 的库里等于只读。
11. **`memory_shard_search` 的 `mode='keyword'` 不代表一定写了强化**：LIKE 0.55 < 0.60，且 query <3 字
    不会强化；调用方应看 `reinforced` 而不是 mode。
12. **`memory_shard_inject` 的 query 门槛是 2 字**，方案文字写的是 1 字不扫全表；实际 1 字也按权重浏览
    （`inject.rs:70-72`）。这不算错误，但文档/前端不要把 1 字 query 当成关键词检索。
13. **`memory_shard_stats.signal_ratio`** 的分母是 `active`（不含 dormant），并 `min(1.0)`；
    `noise_ratio` 的分母是 `active+dormant`。方案里的公式与此不同，页面文案不要按方案解释。
14. **旧 `kb_memories` 不删、不回写**：本波没有迁移 `kb_docs` 的旧记忆文档；worker 完成前
    `kb_search(sources=['memory'])` 可能短暂看到旧内容。
15. **浏览器 mock 与 Rust 的已知分叉**：`src/mock/server.ts` 的 `kb_memory_bump` 仍会递增旧
    `kb_memories.activeCount`（`mock/server.ts:11170-11182`），而 Rust 的 `memory::bump_active` 是 no-op
    （`memory.rs:360-367`）。e2e/页面不要用 mock 的 bump 行为证明「注入即续命」；真实语义以 Rust 为准。
16. **未运行任何验证**：本次未跑 `cargo test --lib`、typecheck、build、contract 或 e2e；
    所有结论来自静态代码阅读。

## 10. 命令与工具速查

新增 20 条命令（注册在 `src-tauri/src/lib.rs:278-279,366-384`）：

- 列表/详情：`memory_shard_list`、`memory_shard_get`
- 写入：`memory_shard_apply`、`memory_shard_update`、`memory_shard_delete`、`memory_shard_archive`、
  `memory_shard_restore`、`memory_shard_mark_important`
- 检索/注入：`memory_shard_search`、`memory_shard_inject`
- 统计/维护：`memory_shard_overview`、`memory_shard_stats`、`memory_shard_sweep`、
  `memory_shard_duplicates`、`memory_shard_events`
- Dream：`memory_dream_begin`、`memory_dream_apply`、`memory_dream_cancel`
- 会话分页：`ai_chat_page`、`ai_chat_page_around`

AI 工具（Rust 注册表与 TS 前端同名）：`list_memories`、`recall_memory`、`remember`、`edit_memory`、
`forget`（`agent/tools/mod.rs:78-83`、`src/ai/tools/memory.ts`）。

前端入口：`src/stores/memory.ts`（注入缓存、卡片、search、mark/archive/restore/remove、sweep、
`dreamNow`、`maybeDreamOnIdle`）、`src/components/ai/MemoryCards.vue`（顶部最多 3 张卡）、
`src/pages/KnowledgePage.vue`（三态/来源筛选）、`src/pages/ProfilePage.vue`（只读兼容卡）。

验证脚本：`scripts/e2e-memory-shards.mjs`（注入只读 / top3 强化递减 / mark 地板 / 归档恢复 /
Dream apply 幂等 / alpha 降档）。

## 11. 2026-11-11 复验与修复（覆盖第 9 节的旧口径）

第 9 节写于施工当刻，以下为随后复验的最终状态：

- **e2e 已跑通**：`node scripts/e2e-memory-shards.mjs` 在浏览器 mock 下 **32/32 通过**
  （注入只读 A1–A5、top3 强化递减 B1–B6、归档/标记 C/D、Dream E1–E7、时间旅行 F1–F3）。
  脚本里的 `kbService.memoryShardGet` 拼写已修正为 `memoryShard`。
- **异步链路已接线**：worker 每轮 `drain_extract` → `take_embed_batch` → 锁外 embed →
  `store_embeddings`（`kb/worker.rs:398/407/503`）；启动对账调 `backfill_legacy` /
  `reconcile_conversation_shards`（`:233/:239`）；embed 失败退避。第 9 节第 1/2 条的
  「无调度方」已不成立。
- **手动写入/抽取的原文锚点已补**：`apply_actions_conn` 从 `message_ids` 快照倒序解析
  `anchor_message_id` 与 `user_message_id`（`shard/commands.rs` 的 `source_anchor_and_user`），
  `memory_shard_apply` / 旧 `kb_memory_apply` 产生的记忆现在有「查看原文」。
- **food-parse 不再吃掉同回合文字记忆**：空正文 food-parse 卡抢到 anchor 时，只有新锚点
  本身可读才删除上一锚点的 conversation shard（`ai/commands.rs::apply_append_side_effects`）；
  「先文字回答、后出食物卡」的回合不会再把文字结论的 shard 删成 0 条。
- **mock `kb_memory_bump` 改为 no-op**，与 Rust `memory::bump_active` 一致，不再制造
  「注入即续命」的 mock 分叉。
- **迁移失败显式 ROLLBACK**：`db::migrate` 在每条迁移 `execute_batch` 失败时先回滚再返回，
  避免保留连接时留下未结束事务 + `foreign_keys=OFF`。
- 闸门：`cargo test --lib`、`vue-tsc --noEmit`、`node scripts/check-ipc-contract.mjs`
  （335/335/335）、`vite build` 均通过。

仍保留的**刻意偏差**（不是漏做）：自动注入默认排除 `origin='conversation'`（原始对话已在本轮
上下文里，广播只会重复；对话要进注入须先经 Dream/标重要）；history 512 行软上限（不截断，
到顶后只停止强化）；懒巡检节流 600s（不是 30min）；高度缓存用 localStorage（不是 IndexedDB）；
会话记录层复用 `ai_chat_messages`（不另建 SessionRecord 表）。

仍未修：Dream revive 没有「被其他分片引用」校验；`history::replay` 仍无生产调用方；
`recall_memory` 的命中没有消息级「回忆来源」按钮；跨设备 `ai_chat_seq` 冲突未处理；
无 user 的 legacy 会话仍可能一次返回 1000 条。

