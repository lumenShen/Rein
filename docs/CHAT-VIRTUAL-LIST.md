# 聊天虚拟列表（AI 会话）

> 本文按**当前工作树的最终代码**整理（`src/pages/AIPage.vue`、`src/components/ai/chat/*`、
> `src/stores/chatPaging.ts`、`src/ai/chatSegments.ts`、`src-tauri/src/modules/ai/chat_page.rs`）。
> 方案原文见 `.zcode/plans/memory-system/plan.md` §9；与代码不一致处已标明。
> 本次没有运行 e2e、没有在真机（Tauri/WebView2/Android）验证，§11 逐项列出未验证内容。

## 0. 一页结论

- **段（segment）是唯一行**：一个 user 回合 = 一条 user + 其后连续 assistant，直到下一条 user；
  段 id 固定为 `seg:<段内首条可见消息 id>`（`src/ai/chatSegments.ts:27-37,56-100`）。
- **只窗口化渲染，不裁剪 store**：`ai.messages` 永远是「已加载后缀」单一真源；
  DOM 里只有视口段 + overscan + pinned（`src/components/ai/chat/useVirtualChat.ts:1-21,161-194`）。
- **布局是 spacer 流**，不是方案里的绝对定位 transform：`.virtual-body` 内「上 spacer + 连续可见段 +
  下 spacer」，高度由前缀和算出（`useVirtualChat.ts:9-16,126-137,190-194`、`AIPage.vue:1174-1208`）。
- **高度缓存用 localStorage**，key 含 `chatId + 宽度桶 + 字体档`；LRU 3 个会话、每会话最多 2000 段、
  500ms 节流（`heightCache.ts:1-19,44-59,156-194`）。
- **前插锚定**：`captureAnchor` 取「首个与视口相交的段 + rect.top」，`restoreAnchor` 在
  nextTick/rAF 后按同一元素修正 `scrollTop`（`useVirtualChat.ts:422-473`、`AIPage.vue:368-381`）。
- **流式只更新末段**：`showMsg` 对 text 流式气泡刻意不读 `text` 值，避免每个 token 重算
  `visibleMessages → segments`；`streamSeq` 只负责吸底（`AIPage.vue:103-131,710-718`）。
- **折叠回写**：`ProcessSection` 受控 `expanded`，页面按消息 id 持有 `processExpanded`；
  高度由 `.virtual-seg` 的 ResizeObserver 实测回写（`AIPage.vue:201-207,439-442`、
  `ProcessSection.vue:40-80`、`useVirtualChat.ts:229-248`）。
- **跳转高亮**：路由 `?anchor=<messageId>&chat=<chatId>` → `paging.jumpToAnchor` →
  `scrollToMessage` → 页面给 `#msg-<id>` 加 `.flash` 2 秒（`AIPage.vue:663-673,343-366`、
  `ChatMessage.vue:129-132,327-333`）。
- **顶部记忆卡不参与段高度**：`MemoryCards` 是 `.rubber-layer` 内、虚拟体之前的普通 block；
  卡片出现/内容变化用 ResizeObserver 调 `measure()` 重算 `bodyOffset`（`AIPage.vue:275-336,1132-1143`）。

## 1. 组件拓扑

```
AIPage.vue
├─ .msgs（滚动容器，ref=listEl）
│  ├─ PageHeader（sticky，在 .rubber-layer 外）
│  └─ .rubber-layer
│     ├─ .memory-cards-host → MemoryCards（普通 block，最多 3 张）
│     ├─ AiBoard / 加载骨架 / 错误重试（空会话）
│     ├─ .load-sentinel（v-if hasMoreBefore，键盘/Tab 可达，点击加载更早）
│     ├─ .virtual-body（ref=virtualBodyEl）
│     │  ├─ .v-spacer（topSpacer）
│     │  ├─ .virtual-seg × visibleSegments → ChatSegmentView → ChatMessage × 段内消息
│     │  └─ .v-spacer（bottomSpacer）
│     └─ .load-sentinel（v-if hasMoreAfter，加载更新）
└─ .composer（移动端 Teleport 进底栏 Dock）
```

相关文件：

| 文件 | 职责 |
|---|---|
| `src/ai/chatSegments.ts` | 纯函数：可见消息 → 段；估算高度；`extractMemoryAnchors` |
| `src/components/ai/chat/useVirtualChat.ts` | 前缀和、窗口、pinned、RO 实测、锚定、滚动 API |
| `src/components/ai/chat/heightCache.ts` | localStorage 高度缓存、LRU、配额降级 |
| `src/components/ai/chat/ChatSegmentView.vue` | 一个段的渲染壳，`data-seg-id` |
| `src/components/ai/chat/ChatMessage.vue` | 单条消息；`#msg-<id>` 与 `.flash` |
| `src/stores/chatPaging.ts` | 尾页/上滑/下滑/around 分页状态机 |
| `src-tauri/src/modules/ai/chat_page.rs` | Rust 端整回合分页 SQL |
| `src/services/aiService.ts` | `aiChatPage` / `aiChatPageAround` |

## 2. 段定义

`buildChatSegments(messages)` 的输入必须是**已按 `showMsg` 过滤**的可见消息（`AIPage.vue:196-199`）。
`showMsg` 挡掉：被 `absorbed` 的过程空壳、没有 segments 的 `kind='tools'`、空 text 的非流式气泡、
没有图的 photo、没有 doc 的 doc、没有 items 的 food-parse（`AIPage.vue:103-131`）。

规则（`chatSegments.ts:56-100`）：

- 遍历消息；遇到 `role==='user'` 且当前段非空 → flush 开新段；assistant 永远跟随当前段。
- 首条就是 assistant（legacy 会话）→ 自然形成一个以 assistant 开头的段。
- 段 id = `seg:${current[0].id}`。它只依赖段首可见消息，**不随 anchor 移动而变**，所以高度缓存
  和 `pinnedIds` 在 anchor 改变后仍然有效。
- `anchorId`：取段内**第一条非空** `m.anchorId`；都没有则取段内最后一条 `role==='assistant'` 的 id；
  再没有就是 `null`。与 `MemoryShard.anchorMessageId` 同值（来自 `ai_chat_messages.anchor_id`）。
- `startSeq = first.seq ?? 0`、`endSeq = last.seq ?? 0`；`dayKey = first.at.slice(0,10)`。
  v1 不渲染日期分隔条，`dayKey` 只是元数据。

为什么按 user 切：`restoreBubbleMetaFromHistory` 也按 user 重置过程容器（`stores/ai.ts:775-828`），
所以跨页加载不会把同一条 assistant 回复拆到两段。被吸收的过程消息在分段前已被 `showMsg` 过滤，
不会占一段高度。

## 3. 分页与 around

### 3.1 Rust 端 `ai_chat_page`

命令：`ai_chat_page(chat_id, before_seq?, after_seq?, limit_turns?)`
（`src-tauri/src/modules/ai/commands.rs:672-686`，实现在 `chat_page.rs:100-205`）。

- `before_seq` 与 `after_seq` 互斥，同时传报错；`limit_turns` 默认 16、clamp 1..50
  （`chat_page.rs:23-28,49-53,107-112`）。
- 游标是 **exclusive 数值 seq 边界**，不是 offset；不要求对应消息仍存在。撤回留下的 seq 空洞是稳定边界，
  因为 `ai_chat_seq` 只增不减（`db.rs:1967-1973`、`ai/commands.rs:714-735`）。
- 页按**完整回合**切：以 user 消息 seq 为回合起点；取 `limit_turns` 个回合，返回整段消息。
  `limit_turns+1` 只用于判断 `has_more_*`。
- 尾部/向前：没有更多时 `start=0`，把第一条 user 之前的 legacy assistant 一并带回。
- 无 user 消息的 legacy 会话：整段视为一个回合，返回最后最多 `LEGACY_PAGE_MAX_MESSAGES=1000` 条；
  超过时 `has_more_before=true`（`chat_page.rs:207-268`）。
- 返回 `messages/total/has_more_before/has_more_after/next_before_seq/next_after_seq`
  （`models.rs` 的 `AiChatPage`）。

`ai_chat_page_around(chat_id, message_id, limit_turns?)`（`chat_page.rs:270-304`）：

1. 按 id 取目标 seq；不存在报「消息不存在」。
2. `next_turn = MIN(seq) WHERE role='user' AND seq > target_seq`，没有则 `i64::MAX`。
3. 以 `before_seq=next_turn` 调 `chat_page_conn`：目标回合落在页尾，`has_more_after` 由后续消息决定。
4. 前端再用 `scrollToMessage` 定位并高亮。

两个分页命令进入时都会先 `backfill_chat_anchors(conn, chat_id)`：只补当前会话 `anchor_id IS NULL`
的行，规则与 0054 一致（terminal 优先，否则最后一条 assistant），是「列已加、数据未回填」旧库的懒兜底
（`chat_page.rs:306-350`）。

### 3.2 前端 `chatPaging` 状态机

`src/stores/chatPaging.ts`：

- `PAGE_TURNS = 16`（`chatPaging.ts:30-31`）。
- `loadTail(chatId)`：`aiChatPage(chatId, null, null, 16)` → `replaceMessages` → 设置游标 → `ready=true`；
  同一会话并发共享 `tailPromise`；`generation` 令牌丢弃晚到响应（`:192-225`）。
- `loadOlder()`：`busy` / `loadingBefore` / 无更多时拒绝；若当前窗口不属于 `ai.chatId`，先 `loadTail`
  并返回 false；否则用 `nextBeforeSeq` 拉上一页，`prependMessages`（`:227-259`）。
- `loadNewer()`：对称，`appendMessages`（`:261-289`）。
- `jumpToAnchor(messageId)`：消息已在当前窗口 → 直接返回 id；`busy` 拒绝；否则
  `aiChatPageAround` → `replaceMessages`（`:291-315`）。
- `init()`：`await ai.init()`（建/取会话）；若 `ai.messages` 已有内容，**直接 `ready=true` 并沿用旧全量消息，
  不拉尾页**；只有空会话才 `loadTail`（`:317-335`）。`ensureReady()` 同理（`:337-361`）。
- `syncChat()`：会话 id 与 `requestedChatId` 不同才 `loadTail`（`:363-372`），供 AIPage 的 `ai.chatId`
  watcher 兜底。
- `reset()`：`generation++`、清游标/loading/ready（`:374-389`）。

**当前接线现状（必须知道）**：

- `stores/ai.ts::init()` 仍然调用 `aiService.aiChatMessages(chatId)` **全量加载**
  （`stores/ai.ts:402-426`）。AIPage 挂载时 `paging.init()` 看到 `messages.length > 0` 就只把 `ready` 置 true，
  **不会拉 16 回合尾页**（`AIPage.vue:631-637`、`chatPaging.ts:317-335`）。因此**冷启动首屏仍是全量
  store + 窗口化渲染**，`hasMoreBefore` 为 false，上滑分页不会触发。
- `ai.selectChat()` 也是全量 `aiChatMessages`（`stores/ai.ts:548-564`），但 AIPage 的 `ai.chatId` watcher
  会调 `paging.syncChat()`；此时 `requestedChatId` 还是旧会话，于是 `loadTail(newChatId)` 用 16 回合页替换
  全量消息（`AIPage.vue:730-741`、`chatPaging.ts:363-372`）。**切换会话后分页才真正接管**。
- 想在不切会话的情况下进入分页窗口，只能显式 `paging.reset(); await paging.loadTail(chatId)`
  （e2e 脚本正是这样做的）或走 `jumpToAnchor` 的 around 路径。这是 E 域接线未完成的遗留，不是分页状态机
  本身的缺陷。

`store` 暴露的最小映射：`chatPaging` 优先用 `ai.mapStored / replaceMessages / prependMessages /
appendMessages`，不存在时用本文件的 `fallbackFromStored` 直接赋值（`chatPaging.ts:33-43,49-179`）。
当前 `stores/ai.ts` **没有**导出这些方法（grep 不到 `mapStored`），所以实际走 fallback；`fallbackFromStored`
会把 Rust 返回的 `seq` / `anchorId` 带上（`chatPaging.ts:67-133`）。`ai.fromStored` 也写 `seq/anchorId`
（`stores/ai.ts:340-399`），全量加载与分页两条路径的段 `anchorId` 都与后端 anchor 对齐。

另一个接线缺口：`paging` 的 `replaceMessages / prependMessages / appendMessages` 都不调用
`restoreBubbleMetaFromHistory`。`showMsg` 对 `kind='tools'` 的过程消息依赖 `ai.getMeta(id)?.segments`
（`AIPage.vue:103-131`），`ChatMessage` 的 ProcessSection 也读 `ai.getMeta`（`ChatMessage.vue:48-55,144`）。
因此**如果窗口第一次加载就是 16 回合尾页**（没有先走一遍全量 `ai.init` 建立 meta），过程消息会被
`showMsg` 隐藏；`loadOlder` 前插进来的旧过程消息同样可能没有 meta。当前 e2e 脚本先让 `ai.init` 全量加载
建立 meta，再 `reset + loadTail` 切尾页，规避了这个缺口；真实冷启动若改成只拉尾页，必须先补这一步。

## 4. 高度缓存

`src/components/ai/chat/heightCache.ts`：

- 介质：**localStorage**。仓库没有 IndexedDB 使用；高度缓存是纯缓存，丢失无害；同步读让首屏直接拿到高度，
  不会先按估算渲染再跳（`heightCache.ts:1-12`）。
- Key：`rein.chat.heights.v1.<widthBucket>x<fontScale>.<chatId>`
  （`PREFIX` + `keyOf`，`:15,56-59`）。
  - `widthBucket = max(320, round((visualViewport.width ?? innerWidth) / 80) * 80)`（`:44-48`）；
  - `fontScale = round(root font-size * 100) / 100`（`:50-54`）。
- Value：`{ v: 1, at: ISO, heights: { [segmentId]: number } }`（`:21-25`）。
- 写入：`setHeight` 先更新内存，`dirty` + 500ms 节流落盘；每会话最多 `MAX_PER_CHAT=2000` 条，超出按
  `Object.keys` 插入顺序删最旧（`:17-19,167-183`）。
- 读取：`loadHeights(chatId)` 返回 `Map<segmentId,height>`；`readRecord` 会过滤非有限/≤0 的值（`:103-123,156-165`）。
- LRU：`rein.chat.heights.v1.index` 存 `{ order: string[] }`，最近使用在前；超过 `LRU_CHATS=3` 就
  `clearChat(order[3])`（`:16-18,61-101`）。`clearChat` 按 `.chatId` 后缀扫描所有宽度桶/字体档的 key
  （`:196-220`）。
- 配额：`persist` 捕获 `QuotaExceededError`，删掉非当前 chat 的所有高度 key 后重试一次；仍失败则本会话
  继续用内存值（`:125-146`）。
- localStorage 不可用（隐私模式/被策略禁用）：`storage()` 返回 null，`loadHeights` 空 Map、`setHeight`
  只更新内存，功能降级为纯内存（`:34-42,156-183`）。

`useVirtualChat` 在 `chatId` 变化时 `reloadHeights(id)`（先 `flushHeights()`、清空内存 Map、读新 key）；
窗口宽度跨 80px 桶时也重读当前桶（`useVirtualChat.ts:265-302,369-376`）。

## 5. 滚动锚定

### 5.1 前缀和与窗口

`useVirtualChat`：

- `height(seg) = heights.get(seg.id) ?? estimateSegmentHeight(seg, contentWidth, expandedIds)`
  （`:110-124`）。
- `offsets[i] = Σ heights[0..i)`；`totalHeight = offsets[n]`（`:126-137`）。
- `firstIndex`：二分找第一个 `offsets[i+1] > scrollTop - bodyOffset` 的段（`:145-159`）。
- `windowStart = max(0, first - overscan)`；`end` 从 start 累加，直到段顶部超过
  `scrollTop - bodyOffset + viewportH + overscan*48`（`:161-184`）。默认 overscan=3。
- `pinnedIds` 对应段强制并入窗口；若距离窗口超过 `MAX_PIN_DISTANCE=40` 段则放弃（避免一次渲染上千段）
  （`:76-79,172-183`）。
- 渲染：上 spacer = `offsets[windowStart]`，下 spacer = `totalHeight - offsets[windowEnd]`；
  `.virtual-seg` 是普通流元素（`display: flow-root`），没有 transform/contain:paint
  （`:190-194`、`AIPage.vue:2233-2247`）。

`bodyOffset` 用 `virtualBody.getBoundingClientRect().top - scroller.getBoundingClientRect().top +
scroller.scrollTop` 计算，**不用 `offsetTop`**：`.rubber-layer` 的 transform/负外边距会让 offsetParent
不可靠（`useVirtualChat.ts:279-302`）。`topInset` 取 `.page-header` 的 `offsetHeight`，用于跳转定位。

### 5.2 上滑前插

`AIPage.loadOlder()`（`AIPage.vue:368-381`）：

1. 守卫 `paging.loadingBefore / hasMoreBefore / ai.busy`；
2. `captureAnchor()` 取前插前的锚；
3. `suspendScroll()` 抑制滚动事件期间再次触发加载；
4. `await paging.loadOlder()`；
5. `nextTick` + `measureVirtual()` + `restoreAnchor(anchor)`；
6. `finally resumeScroll()`。

`captureAnchor`（`useVirtualChat.ts:422-439`）只从当前 `windowRange` 里找「第一个 `rect.bottom >
scrollerTop + 1`」的段，返回 `{id, top, index, scrollTop, scrollHeight}`。它**不取 `visible[0]`**：
`visible` 可能含被 pin 到窗口头部的视口外段，取错元素会让前插偏移。

`restoreAnchor`（`:441-473`）：

- `nextTick → rAF → measure()`；
- 若同一 `seg.id` 元素还在：`scrollTop += el.rect.top - anchor.top`；
- 否则按 `indexById + offsets` 算目标 scrollTop；
- 再否则按 `scrollHeight` 差值退化；
- `apply` 执行两次（两次 rAF），最后 `measure()`，吸收新前插行晚到的实测高度。

滚动加载由 `maybeTriggerLoad` 触发（`:304-326`）：`hasMoreBefore && windowStart===0 && localTop∈(-40,200)`
且距上次 >350ms → `onLoadOlder`；底部对称 `remain < 240` → `onLoadNewer`。`onScroll` 用 rAF 节流，
`suspendCount > 0` 时跳过（`:328-336`）。AIPage 还有键盘可达的 `.load-sentinel`（`:1162-1172,1210-1220`）。

## 6. 流式局部更新

- `AIPage.segments = buildChatSegments(visibleMessages)`，`visibleMessages = ai.messages.filter(showMsg)`
  （`AIPage.vue:196-199`）。
- `showMsg` 对 `kind='text'` 的分支先判断 `m.streaming === true`，**刻意不读 `m.text`**：
  `// 不要在这里读 text 的值 —— 每个 token 都会让 visibleMessages → buildChatSegments 整体重算`
  （`AIPage.vue:113-118`）。因此流式 token 只改消息对象文本，不会让段数组重算。
- `ai.streamSeq` watcher 只调 `scrollToBottom(1)`（逐 token 补 1 帧）（`AIPage.vue:710-718`）；
  `ai.busy` 变 false 时调 `scrollToBottom()` 默认 3 帧，补卡片/图片定稿后的长高（`:720-728`）。
- `lastMessageId` watcher 只监听「最后一条消息 id」；前插不改它，所以上滑不会吸底（`:702-708`）。
- `scrollToBottom(passes)`：`passes` clamp 1..5，循环 `scrollTop = scrollHeight` + 一帧 + `measure()`；
  期间 `suspendScroll()`，结束后 `resumeScroll()`（`useVirtualChat.ts:533-551`）。
- 最后一个段通常就在视口内（用户在底部），其高度由 `.virtual-seg` 的 ResizeObserver 实测回写；
  没有「强制把末段 pin 在窗口内」的代码，末段靠视口位置自然保留。若用户主动上滚离开底部，流式内容会
  随末段移出窗口而卸载，这是窗口化的正常行为。

## 7. 折叠/展开回写

- `ProcessSection` 新增受控 `expanded?: boolean | null`：`null/undefined` 保持组件原有自动开合；
  boolean 时点击标题只 `emit('update:expanded')`（`ProcessSection.vue:40-90,262-282`）。
  非受控时的自动/手动开合也会把结果上报，页面由此接管；否则组件被虚拟列表回收重挂载后状态会丢。
- AIPage 用 `processExpanded: Record<messageId, boolean>` 按消息 id 持有状态；`expandedOf(id)` 传给
  `ChatSegmentView → ChatMessage → ProcessSection`（`AIPage.vue:201-207,256-258,1184-1205`）。
- `onUpdateProcess(messageId, expanded)`：写 map + `invalidateMessage(messageId)`
  （`AIPage.vue:439-442`）。
- `useVirtualChat.invalidate`：
  - 段已渲染 → 直接 `onSegmentResize` 按当前 DOM 重量一次（不删缓存，避免「尺寸没变 RO 不再回调」导致
    spacer 与真实高度永久不符）；
  - 未渲染 → `heights.delete` + `deleteHeight` + `heightVersion++`（`:402-415`）。
- `onSegmentResize`：`old = heights.get(id)`；`previous = old ?? estimate`；若 `old` 存在且差值 ≤0.5 直接返回；
  否则写 `heights`、`heightVersion++`、`persistHeight`。若该段在 `firstIndex` 之前且高度变化 >0.5，
  `scrollTop += h - previous`，把视口上方的长高/缩短补偿掉（`:229-248`）。
- 工具详情抽屉：`ToolCallGroup` 打开时 `detail-open` → AIPage 把段加入 `detailPinned`；关闭移除
  （`AIPage.vue:444-451`、`pinnedIds` `:209-213`）。
- 焦点：`onFocusIn` 把所在段加入 `focusPinned`，`onFocusOut` 移出（`:411-426`）。
- 长按/右键：`onPressStart` / `onCtxMenu` 把段加入 `transientPinned`，菜单关闭时清空
  （`AIPage.vue:1026-1037`、`pinnedIds`）。长按 450ms 的 timer 与菜单锚点在原 AIPage 逻辑中保留，
  本文不重复。

## 8. 跳转与高亮

两条入口：

1. MemoryCards「查看原文」→ `emit('jump', {anchorMessageId, chatId})` → AIPage `onMemoryJump`
   → `jumpToMemoryAnchor(anchorId, chatId)`（`MemoryCards.vue:45-52`、`AIPage.vue:304-307`）。
2. KnowledgePage 记忆项「查看原文」→ `router.push({ name:'ai', query:{ anchor, chat } })`
   → AIPage `onMounted` 的 `jumpFromRouteAnchor()`（`AIPage.vue:663-673`）。

`jumpToMemoryAnchor`（`AIPage.vue:343-366`）：

1. `anchorId` 为空或 `ai.busy` → 返回；
2. 置 `suppressAutoScroll=true`，`suspendScroll()`；
3. 若 `chat` 与当前 `ai.chatId` 不同：`await ai.selectChat(chat)`，`await paging.syncChat()`；
4. `await paging.jumpToAnchor(anchorId)`：消息已在窗口直接返回；否则 `ai_chat_page_around` 替换消息；
5. `nextTick + measureVirtual`；
6. `const found = await scrollToMessage(target, { highlight:true })`，`flashMessage(found)`；
7. `finally` 等一帧、`measureVirtual`、`resumeScroll`、`nextTick`、`suppressAutoScroll=false`。

`scrollToMessage`（`useVirtualChat.ts:505-531`）：

- 先按 `messages.some(m.id===messageId)` 找段；找不到再按 `segment.anchorId===messageId` 找段；
- 目标消息被 `absorbed` 时（anchor 只存在于段上、DOM 里没有 `#msg-`），高亮目标退化为段内首条可见消息；
- `scrollToSegment(seg.id)` 把段顶滚到页头下方（`bodyOffset + offsets[idx] - topInset - 8`），
  再量 `#msg-<target>` 的 rect，把消息本身调进视口（长回合里段顶不等于 anchor）；
- 返回实际高亮的消息 id；返回 null 表示段不存在。
- **它自己不添加 `.flash`**：`opts` 参数当前是 `_opts`（未使用）；高亮由 AIPage 的 `flashId` 驱动
  `ChatMessage` 的 `.flash` class（`ChatMessage.vue:61,129-132,327-333`），2 秒后 `flashMessage(null)`。

跳转期间抑制吸底：`suppressAutoScroll` 为真时 `lastMessageId` / `streamSeq` / `busy` 三个 watcher 都
不吸底（`AIPage.vue:705-728`），避免 `replaceMessages` 被误判为「尾部追加」先滚到底再被跳转覆盖
（`AIPage.vue:338-341`）。

## 9. 记忆卡

`src/components/ai/MemoryCards.vue`：

- Props：`cards: MemoryInjectShard[]`、`dreaming?: boolean`；只渲染前 3 张（`shown = cards.slice(0,3)`）。
- 徽标：`marked_important → 重要`；`reason==='digest' || origin==='dream_summary' → 梦境摘要`；
  `manual_write → 长期记忆`；`conversation → 对话记忆`；`reason==='relevant' → 相关`；否则「记忆」。
- 内容 `line-clamp: 3`；关闭按钮只 emit `dismiss(shardId)`，由 `memory.dismissCard` 本地隐藏，不写库
  （`MemoryCards.vue:40-52`、`stores/memory.ts:231-237`）。
- 「查看原文」只在 `anchorMessageId && chatId` 都存在时显示；否则显示「查看记忆」→ emit `open` →
  跳 `/ai/knowledge?shard=<id>`（`AIPage.vue:309-315`）。
- 位置：`.memory-cards-host` 在 `.rubber-layer` 内、`.virtual-body` 之前；**不进入 segments、不参与
  offsets**。卡片条数或 `dreaming` 变化时 AIPage `nextTick` 后 `measureVirtual()` 并重新挂 ResizeObserver；
  内容变化但条数不变时由 RO 兜住 `bodyOffset`（`AIPage.vue:317-336,1135-1143`）。

## 10. 性能红线

| 红线 | 期望 | 代码依据 |
|---|---|---|
| DOM 段数与总消息数无关 | 通常 8–12 段；最坏 = 视口段 + 2×overscan + pin 扩展（每侧最多 40 段） | `useVirtualChat.ts:76-79,161-194` |
| 一万条消息首屏不卡 | 段数组 O(n) 构建；窗口只 slice 可见段；前缀和 O(段数) 在高度版本变化时重算 | `chatSegments.ts:56-100`、`useVirtualChat.ts:126-137` |
| 上滑加载不跳动 | 首可见段 `rect.top` 变化 ≤1px；`scrollTop` 增加前插内容高度 | `useVirtualChat.ts:422-473`、`AIPage.vue:368-381` |
| 流式不重建整表 | 旧段 DOM 元素身份不变；只末段高度变化；段数组不因 token 重算 | `AIPage.vue:113-118,710-718` |
| 高度缓存写盘不抖 | 500ms 节流；只在 `|new-old|>0.5` 时写 | `heightCache.ts:148-154`、`useVirtualChat.ts:229-248` |
| 折叠/展开不跳 | 视口上方段高度变化时 `scrollTop += delta` | `useVirtualChat.ts:237-247` |
| 记忆卡不参与虚拟高度 | 卡片变化只 `measure()`，不触发 offsets | `AIPage.vue:317-336` |
| 滚动条隐藏、页头 sticky、rubber-layer 超范围平移不变 | 未新增可见滚动条；`.virtual-body` 在 `.rubber-layer` 内 | `AIPage.vue:1132-1220,2233-2247` |
| 分页在 `ai.busy` 时拒绝 | `loadOlder/loadNewer/jumpToAnchor` 都检查 `busy` | `chatPaging.ts:227-315` |

注意：`overscan=3` 是默认值；代码没有按 `perfDegraded` 动态降到 2（方案提到过，当前未实现）。
`MAX_PIN_DISTANCE=40` 是「pin 距离窗口超过 40 段就放弃」的保护，避免一次渲染上千段。

## 11. 未在真机验证 / 已知边界

以下都没有在本次改动中跑过 e2e 或真机（Tauri/WebView2、Android WebView、iOS）；e2e 脚本已写但未运行：

1. **冷启动分页未接管**：如 §3.2 所述，`paging.init()` 在全量消息存在时不拉尾页；真实长会话首屏仍是
   全量 `aiChatMessages`。因此「首屏只发 `ai_chat_page`」「上滑加载」在正常冷启动路径上**没有实际发生**，
   只有在切会话、`jumpToAnchor` around 或手动 `reset+loadTail` 后才会走分页。真机上的首屏耗时与内存
   仍需实测。
2. **尾页首次加载缺 meta**：`paging` 不调用 `restoreBubbleMetaFromHistory`，只拉尾页时 `kind='tools'`
   的过程消息会被 `showMsg` 隐藏；需要 E 域把 `mapStored`/`replaceMessages` 接上并在替换后重建 meta。
   当前 e2e 用「先全量、再尾页」规避，属于脚本假设，不是产品行为。
2. **`scrollToMessage` 高亮时序**：`flashMessage` 在 `scrollToMessage` 返回后立即设置，2 秒后清除；
   `scrollToMessage` 内部有两次 rAF + measure。慢设备上可能出现「先看到高亮、后看到滚动」的闪动，
   未实测。`scrollToMessage` 找段失败返回 null 时页面不会高亮，也没有 toast 提示（静默失败）。
3. **`ProcessSection` 的 `useId()` 与重挂载**：段被回收后组件会重挂载，`aria-controls` 的 id 会变；
   受控 `expanded` 能保住开合状态，但 `aria-controls` 的读屏连续性未验证。
4. **`ResizeObserver` 循环**：`onSegmentResize` 只在差值 >0.5 时写回，理论上不会自激；但展开动画
   （CSS max-height/opacity）期间 RO 逐帧回调、`heightVersion++`、offsets 重算，低端机是否掉帧未实测。
5. **宽度桶/字体档**：`visualViewport.width` 在 Android WebView 软键盘弹出、横竖屏切换时的取值未验证；
   跨桶后未渲染段用估算、已渲染段由 RO 修正，可能出现轻微滚动条跳动（方案已接受）。
6. **localStorage 配额**：2000 段/会话 × LRU 3 ≈ 180KB 是估算；实际 `heights` JSON 键名是 `seg:<id>`，
   长会话可能更大。配额满时删除其它 chat 的 key 再重试的逻辑未在真实 5MB 限制下验证。
7. **图片/卡片长高**：`@load` 只对图片触发 `height-dirty` → `invalidateMessage`；文档卡、食物卡、文件卡
   的异步内容变化没有统一钩子，靠 RO。极端情况下 RO 晚到一帧，吸底可能差一截（`scrollToBottom(3)` 只是
   经验值）。
8. **长按/右键/键盘/抽屉**：`pinnedIds` 的三类来源（focus/transient/detail）已接；`pointerup` 后菜单未关时
   是否仍 pin、键盘 Tab 跨越未加载消息时的焦点顺序、`AppMenu` 锚点在滚动中的定位，均未真机验证。
9. **`.rubber-layer` 超范围平移**：虚拟体在层内，但 spacer 高度很大时超范围平移的边界、回弹与
   `scrollTop` 修正的交互未验证。
10. **内存卡与虚拟体之间的 `bodyOffset`**：`MemoryCards` 内容变高由 RO 调 `measure()`；若 RO 在
    `scrollToBottom` 之后才回调，可能短暂停在高度的旧位置，未实测。
11. **无 user 消息的 legacy 会话**：Rust 返回最多 1000 条，`buildChatSegments` 会把整段作为 1 个段
    （首条 assistant 开段），段高可能远超视口；窗口化仍只渲染该段，但该段内部所有消息都会挂载，
    「DOM 与总消息数无关」在这类会话上不成立。
12. **`ai_chat_page` 与 mock 的差异**：mock `mockChatPage` 的 `total`/`hasMore_*` 逻辑与 Rust 近似但不完全
    相同（mock 没有 `LEGACY_PAGE_MAX_MESSAGES` 之外的边界细节）；e2e 在浏览器 mock 下通过不代表 Rust SQL
    在真实库上同样通过。
13. **`chatPaging` 的 `generation` 竞态**：快速切会话时 AIPage 的 watcher 与 `paging.init` 都可能触发
    `loadTail`；代码有 `tailPromise`/`generation`/`requestedChatId` 三层保护，但没有真机快速切换的压测。
14. **未运行任何验证**：本次未跑 `node scripts/e2e-chat-virtual-list.mjs`、未跑 `npm run typecheck` /
    `npm run build`，也没有在 Tauri/Android/iOS 真机上打开长会话。

## 12. 调试入口

- 段信息：`document.querySelectorAll('.chat-segment')` 的 `data-seg-id`；
- 可见段：`.virtual-seg` 的数量与顺序；
- 高度缓存：`import { heightCacheKey, loadHeights } from '/src/components/ai/chat/heightCache.ts'`；
- 分页状态：`useChatPagingStore()` 的 `hasMoreBefore/nextBeforeSeq/loadingBefore/ready`；
- 滚动容器：`.msgs`；虚拟体：`.virtual-body`；加载哨兵：`.load-sentinel`；
- 高亮：`document.querySelector('#msg-<id>.flash')`；
- 记忆卡：`[data-testid="memory-cards"]`、`[data-testid="memory-card"]`。

验证脚本：`scripts/e2e-chat-virtual-list.mjs`（长会话只渲染视口段 / 上滑不跳 / 展开后高度缓存 /
流式只更新末段 / 深链跳转高亮）。

## 13. 2026-11-11 复验与修复（覆盖第 11 节的旧口径）

- **e2e 已跑通**：`node scripts/e2e-chat-virtual-list.mjs` 在浏览器 mock 下 **23/23 通过**。
  首屏按新分页契约加载 16 回合尾页（33 条，不是旧的 81 条全量）；脚本不再依赖手动
  `paging.reset()+loadTail` 来规避冷启动。
- **上滑不再跳**：`captureAnchor` 改为遍历 DOM 里真实挂载且与视口相交的段，并在
  `syncScroll` 之后推迟一帧再判定加载——原来同一帧里「新窗口 + 旧 DOM」会让锚点落空，
  前插后 scrollTop 不补偿，视口停在顶部又触发下一页，最后一口气加载完整部历史。
- **顶部记忆卡出现/消失不再顶飞消息**：`measure()` 检测 `bodyOffset` 变化并同步补偿
  scrollTop（实测 38px 跳动消失）。
- **段高实测补偿改用 DOM 矩形**：`onSegmentResize` 不再用可能过期的 `firstIndex` 判断
  「是否在视口上方」，前插页里未测段换成实测高度时可见内容不再位移。
- **键盘可达**：顶部「加载更早」哨兵触发后会把焦点送到新装上的最老一条（`loadOlderAndFocus`），
  新段被 focusin pin 在窗口里，Tab 不再卡在窗口边界。
- **切会话/清空的分页状态**：`newChat` / `clearContext` 调 `paging.reset()`（清空后再
  `loadTail`），旧 `hasMoreAfter/nextAfterSeq` 不会把新消息重复 append。
- **高度缓存不串会话**：晚到的 ResizeObserver 回调若 id 已不在当前 segments，直接丢弃。
- **记忆卡不串会话**：注入结果按发起时的 chatId 校验，切会话后的晚到响应不写卡片；
  注入失败/空结果清空旧卡。
- **e2e 断言修正**：3.1 改看 store 消息数（虚拟列表只挂视口段，不能拿某个段是否在 DOM 判断）；
  6.x 先回到尾页再测 around。
- 闸门：`cargo test --lib`、`vue-tsc --noEmit`、IPC 契约、`vite build` 均通过。

仍未覆盖：Tauri/Android/iOS 真机的滚动手感与长列表内存；无 user 的 legacy 会话（1000 条一段）
的段内挂载量；`heightCache` 的宽度桶在布局宽度变化而窗口宽度不变时的旧桶复用。

