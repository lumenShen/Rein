# Rein 编码规范

> 原则：可预测 > 简洁。任何让后来者「猜」的写法都是违规。

## 1. 语言与静态检查

- **TypeScript**：`strict` 全开（含 `noUnusedLocals/noUnusedParameters/verbatimModuleSyntax`）。类型错误一律修代码，禁止 `any` / `@ts-ignore` 兜底；确有需要用 `unknown` + 收窄并注释原因。
- **Vue**：`<script setup lang="ts">`；props/emits 必须类型化（`defineProps<{...}>`）；组件内样式一律 `scoped`。
- **Rust**：以 `cargo clippy -- -D warnings` 为门槛（CI 逐字跑这条）。
- **数据库连接一律走 `state::Db::lock()`**，调用点**不 unwrap**：它返回 `MutexGuard`，锁中毒时自愈（取回连接 + 回滚半截事务）。
  这一点是硬的 —— `state.db.lock().unwrap()` 会把「持锁时 panic」升级成**永久故障**（Mutex 中毒后每条命令都继续 panic，
  数据层在重启前不可用）。`unwrap()` 因此只允许用于**小型状态锁**（`CampusHub` / `VoiceHub` 的成员）与测试代码。

## 2. 命名

| 对象 | 规则 | 示例 |
| --- | --- | --- |
| TS 变量/函数 | 小驼峰，动词开头 | `loadSummary`、`calcGrams` |
| TS 类型/接口 | 大驼峰，不加 `I` 前缀 | `DailySummary` |
| Pinia store id | 与文件名一致的小驼峰 | `defineStore('nutrition')` |
| Vue 组件文件 | 大驼峰多词名，按域放目录 | `FoodPickerSheet.vue` |
| CSS 类 | 组件内 kebab-case，不追求全局复用 | `.pitem`、`.grabber` |
| 设计令牌 | `--c-领域` / `--语义` / `--sp-` `--gap-` `--pad-` / `--fs-` / `--radius-` / `--dur-` | `--c-protein`、`--gap-md`、`--ease-sheet` |
| Rust 命令 | snake_case 动词开头 | `list_foods`、`log_meal` |
| Rust 结构体字段 | snake_case + `#[serde(rename_all = "camelCase")]` | `sodium_mg → sodiumMg` |
| IPC 参数例外 | 运动类型用 `workoutType` | 见 ARCHITECTURE §3 |

## 3. 分层纪律

- 页面（pages）只做：装配组件、onMounted 数据加载、弹层开关。业务规则下沉到 store。
- 组件允许直接读 store；**跨域联动必须走 store action**（如记饮食后刷新营养总览在 `dietStore.add` 内完成），不允许页面手动编排两个 store 的刷新顺序。
- 组件 ↔ 后端：只能经 `services/*Service.ts`。新增命令时三处同步（见 ARCHITECTURE §3），漏一处 = 不可合并（`npm run contract` 机器比对，CI 跑）。
- 类型只从 `@/types` barrel 导入：`import type { Food } from '@/types'`。

## 4. 样式规范

- 颜色、圆角、阴影、字号、时长、缓动**只引用 tokens.css 令牌**；review 时看到魔法值直接打回。
- **几何走 4/8 栅格**：`padding` / `gap` / `margin` 一律取 `--sp-*`（数值档，后缀即 px）或
  `--gap-*` / `--pad-*`（语义档，按「层级越高间距越大」选）。禁止 5 / 7 / 9 / 11 / 13 这类裸非栅格值；
  图标尺寸、描边宽度、波形间隙这类**绘图参数**不算布局间距，不受此限。圆角按层级取
  （卡片 16 / 卡内分组面 12 / 按钮输入框 20 / 半模态 32）。逐条依据见 `docs/design/huawei/ALIGNMENT.md`。
- 数字展示加 `.num`（tabular-nums）；正文层级用 `--text-2/--text-3`，不用透明度手调。
- **色彩配额**：数值与正文用中性色；色相只允许出现在「图标 / 色点 / 进度条与图表 / 类型字章」上。
  原因：一屏里几个彩色数字会互相争注意力，读者分不清主次；而颜色一旦从图元泄漏到文字上，就没有任何东西能再当「强调」。
  逐条判据（对一个 `color: var(--c-*)` 逐个判）：
  - 渲染**数值**（金额、次数、时长、热量、百分比、分数、序号）→ `--text-1`
  - 渲染**正文或标签文字** → `--text-1`（次要标签 `--text-2`）
  - **图标**（lucide / SVG glyph / 字首头像这类图标槽位）→ 保留领域色
  - **色点 / 进度条 / 图表（环、柱、曲线）及其图例** → 保留
  - **类型字章**（如运动类型「羽」那枚小方块，意义即「这是哪一类」）→ 保留，但字号 ≤ `--fs-caption` 且只出现一次
  - `background:` 而非 `color:` → 保留（不是文字）
  - soft 底上的文字走 `--*-strong`，不拿实底档（`--ok/--warn/--danger/--accent`）当文字色
- 动效遵守 ARCHITECTURE §5：默认标准曲线；进出同路径；按压反馈在 `:active`。
- 每个可交互元素必须有可见的按压/悬停态与 aria-label（图标按钮必填）。

## 5. 数据契约

- 前后端字段命名以 `src/types/*.ts` 为准；改字段 = 同步改 Rust models + mock + 所有 service，并在 PR 描述里标注 breaking。
- 日期 `YYYY-MM-DD`、时间戳 ISO-8601、时刻为分钟数——不得引入第二种表示。
- 新增营养素字段需同时覆盖：foods 表迁移、Food/NutrientIntake 两结构体、types/diet.ts、MICROS 配置、mock 种子。

## 6. Git 与提交

- 分支：`main` 保持可构建；功能开发用 `feat/<域名>-<摘要>` 短分支。
- 提交信息：`type(scope): 中文摘要`，type ∈ feat/fix/refactor/docs/chore/style/test。
  - 例：`feat(diet): 食物库份量选择器`；`fix(ai): 数量词回看窗口越界`
- 一个提交做一件事；架构性变更（目录调整、令牌改名）单独提交并同步文档。

## 7. 质量门槛（合并前全部通过）

```bash
npm run contract         # IPC 契约三方同步（Rust ↔ services ↔ mock）
npm run lint             # ESLint（src/；scripts/ 是测试工装，暂不在闸门内）
npm run typecheck        # TS
npm run build            # 前端构建
cd src-tauri && cargo clippy -- -D warnings && cargo check
```

Rust 排版：全仓尚未跑过 rustfmt（历史手工风格，`cargo fmt --check` 会红）。
要引入格式化闸门，先单独提交一次全量 `cargo fmt`（纯空白 diff，别和业务改动混在一起），
再往 CI 加 `cargo fmt --check`。

UI 改动需附截图（浅色 + 暗色各一张）；数据流改动需在 mock 与 tauri 两种模式下各验证一遍。

## 8. 文档同步义务

- 改分层/契约/目录结构 → 更新 `ARCHITECTURE.md`
- 改命名/流程/门槛 → 更新本文档
- 文档与代码冲突时，先改文档再改代码（或同 PR 完成）。
