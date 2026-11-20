# 负重口径（Load Basis）· 方案

> 设计稿：[主稿 `weight-load-basis.html`](../ui-designs/weight-load-basis.html) ·
> [扩面稿 `weight-load-basis-surfaces.html`](../ui-designs/weight-load-basis-surfaces.html)（动作选择器 / 训练历史 / AI 教练 / 首次引导）
> 状态：**P0 已落**（口径推断 + 读数组件，接入重量建议 / 动作库 / 动作详情三处，见 §3.1）；
> P1–P4（配置表与确认卡、片盘、统计口径、AI 表述）待做

## 1. 问题：一个标量表达七种不同的物理量

现在全链路只有 `weightKg: number` 一个标量（会话/组的标量在 `src/types/session.ts:110`，
落库 `workout_sets.weight_kg`；动作库的默认值 `defaultWeightKg` 在 `src/types/exercise.ts:111`），
UI 到处写 `` `${fmtKg(kg)} kg` `` —— 全库 27 处这样的插值，散在 8 个文件里
（`SessionOverlay.vue` 独占 10 处，另有 1 处模板插值 `:1313`）。但「重量」在不同器械上是**不同口径的量**：

| 场景 | 记录的数 | 用户实际要做的 | 现在显示 |
| --- | --- | --- | --- |
| 坐姿器械推胸（**挂片式**） | 每侧挂片量 | 每侧挂 10+10 | `40 KG` ❓每侧 20 还是各 40 |
| 坐姿器械推胸（**插片式**） | 插销读数 | 插到 40 的孔 | `40 KG`（与上者同名同数） |
| 杠铃卧推 | 杠 + 片总重 | 杆 20 + 每侧 20 | `60 KG` ❓含杠吗 |
| 哑铃卧推 | **每只** | 拿 22 的一对 | `44 KG` ❓一只还一对 |
| 单臂哑铃划船 | 单只（只有一只） | 拿 20 的那只 | `20 KG` ❓另一侧呢 |
| 辅助引体机 | **减重** | 销插 25（越大越轻） | `25 KG` ❓越重越轻？ |
| 弹力带 / 壶铃 | 等级 / 单只 | 挂 3 号带 | `3 KG` ❓ |

这不是文案问题，是**模型缺一个维度**。三个可测量的后果：

1. **用户站在器械前无法执行**：程序给了 `40KG`，用户还要自己推断「每侧挂多少、挂什么片」。
   而挂片机上「20/侧」与「40/侧」是完全不同的负荷。
2. **同名动作歧义**：`resources/exercises.json` 里 `lever-chest-press`（器械推胸）只有一条，
   而真实健身房有插片式和挂片式两台机器 —— 同一个动作、同一个数字、不同的物理量。
3. **统计口径已经混了**：`SessionSummaryPane.vue:211` 的 `kgVolume = Σ 重量×次数`
   （累加在 `sessionSummary.ts:54-61`）、`trainingAdvice.ts:116` 的 `estimateOneRepMax(weightKg, reps)`，都把「每只哑铃 22」与
   「杠铃总重 60」当同一口径相加 / 相比 —— 哑铃容量被系统性低估一半，
   e1RM 在哑铃与杠铃之间不可比。**这个偏差现在就在库里。**

另外 `weightStep`（`exercise.ts:116`）在 81 条种子数据里只取了 0 / 1 / 2 / 2.5 四个值
（分布 33 / 4 / 14 / 30），DB 列是 REAL、自建动作固定写 2.5 或 0 —— 四档是**种子数据现状**，不是模型约束。
而挂片机的步进其实是「杠铃片的组合可解性」，插片机是「配重块的档距」，两者都不是一个常数。

## 2. 口径模型

### 2.1 七种读数（正交于动作本身）

```ts
/** 负重口径：一个重量数字的物理含义 */
export type LoadBasis =
  | 'stack'   // 插片配重：数字 = 插销读数（整机刻度），无需换算
  | 'side'    // 单侧挂片：数字 = 每侧，合计 = ×2（不含器械自重）
  | 'total'   // 杠铃/固定杆：数字 = 含杆总重，每侧片重 = (总 − 杆) / 2
  | 'hand'    // 哑铃/壶铃：数字 = 每只，一对 = ×2
  | 'assist'  // 助力/减重：数字 = 减去多少，越大越轻；不计入容量
  | 'band'    // 弹力带：数字 = 等级，阻力随拉伸变化；不计入容量
  | 'bw'      // 自重：数字 = 附加负重（0 = 纯自重）
```

**关键约定：内部一律用「等效负荷 workload」计算，UI 按口径拆解呈现。**

- `stack` → workload = kg
- `side` → workload = kg × 2（单边记录时 = 左 + 右）
- `total` → workload = kg
- `hand` → workload = kg × 2（单手动作 ×1）
- `assist` / `band` → 不计入容量（现在是无条件 `weightKg × (reps ?? 计划次数 ?? 1)`，
  只有重量缺席才不计，所以「减重 25」会被当成 25 kg 负荷加进去 —— 见 `src/utils/sessionSummary.ts:54-61`）
- `bw` → workload = 附加重量（0 时只报次数，沿用现有 `bwReps` 逻辑）

这样改完，容量、e1RM、PR 才第一次在跨动作时可比；而**历史数据不重算**（见 §4）。

### 2.2 器械配置（口径的来源）

口径不是动作的固有属性（同一个人可能在不同健身房练同一个动作），所以做成三层，优先级从高到低：

1. **本次会话**（训练中临时改）→ 可选写回第 2 层
2. **我的器械**（`exercise_load_profiles`，一个动作可有多台：宿舍/学校）
3. **动作库推断**（`equipment` + 名称/kind 规则，`inferred = true`；默认不打扰界面，
   只有双形态名单里的那 2 个动作标问号徽标）

```ts
export interface LoadProfile {
  exerciseId: string
  basis: LoadBasis
  /** 杠重（total 用）：标准杆 20 / 女杆 15 / EZ 10 / 短杆 7 / 挂片机臂 0 */
  barKg: number
  /** 单侧可独立记录（单臂/单腿动作）；开启后左/右分别入组 */
  unilateral: boolean
  /** 可用片库存（单侧一片的量），默认 [20,15,10,5,2.5,1.25] */
  plateStock: number[]
  /** 步进：插片 5、哑铃 2、杠铃由片决定（不使用） */
  step: number
  /** 这一套配置叫什么（"宿舍健身房"）；为空 = 动作库推断 */
  label: string | null
  inferred: boolean
}
```

推断规则（`inferBasis`）：

| equipment | 名称/条件 | basis |
| --- | --- | --- |
| 任意 | `kind ∈ {timed, cardio}`（平板支撑、跳绳、泡沫轴、拉伸…） | **无负重** —— 不显示重量，也不给口径 |
| `barbell` | — | `total`，`barKg = 20` |
| `dumbbell` | — | `hand`，`step = 2` |
| `machine` | 命中**双形态名单**：推胸 / 站姿提踵（库外的腿举、哈克、臀推同理） | `side`（**待用户确认**，见 §3.5） |
| `machine` | 其余：蝴蝶机夹胸、腿屈伸、腿弯举、坐姿提踵、髋外展（几乎只有插片式） | `stack`，`step` 沿用该动作的 `weightStep`（现为 2.5） |
| `cable` | 名称含「单臂/单侧」 | `side`，`unilateral = true` |
| `cable` | 其余 | `stack`，`step` 沿用 `weightStep`（现为 2.5） |
| `other` | 壶铃 | `hand` |
| `other`/`bodyweight` | 其余 | `bw` |

两条不动推断的补充：

- **`assist` / `band` 不参与推断**：81 条种子数据里没有任何助力机或弹力带动作（`band` 只在类型里存在）。
  这两种只能由用户显式指定 —— 推断只处理「能看见器械」的情况。
- **步进只能落在 `exercise_load_profiles`**：内置动作不可编辑（`exercise_lib/commands.rs:101-105`），
  而 `roundToStep` 直接读 `lib.weightStep`（`trainingAdvice.ts:368,553`）。所以「插片 5 kg 一档」
  这类改动必须写在 profiles 表上，且**换步进会改变建议值**，首次建配置时要沿用该动作原有 `weightStep`。

> 双形态名单要**窄**：只有「既见过插片、也见过挂片」的机器才值得问用户 —— 按现有 81 个动作
> 数下来只有 **2 个**（器械推胸、站姿提踵）。蝴蝶机夹胸、腿屈伸、腿弯举、坐姿提踵、髋外展
> 在真实健身房几乎清一色插片，把它们也标成「待确认」只会多问五次没用的问题。
> 名单本身**不必穷尽，但也不该外溢**：名单外的机器**不给确认卡** —— 那张卡只有插片/挂片两个选项，
> 对绳索（单侧还是双侧）、助力机（减重）根本不对题。用户遇到名单外的机器，在「我的器械」里
> 自建一台即可（§3.1）。
> 名单内的动作**推断只是"暂定值"**，在第一次进入该动作训练时用一张确认卡（§3.5）转成确认值，
> 避免又造一个新的静默错误。

### 2.3 三个数（呈现模型）

任何一处重量都拆成三个数（设计稿 §1 有图）：

| 层 | 含义 | 出现位置 | 主次 |
| --- | --- | --- | --- |
| 处方数 | 教练/程序写的那个数，带口径 | 计划、建议 | 中 |
| **操作数** | **用户在器械前要做的那个动作** | 训练中、动作库 | **最大** |
| 负荷数 | 等价负荷，用于容量 / e1RM / PR | 记录、统计 | 小字 |

规则：**操作数永远最大，因为那是唯一可执行的信息**；负荷数永远不以「kg」大字出现，
只在灰色副标与统计里出现，避免两个 kg 打架。

## 3. 界面改动

### 3.1 统一组件

新增三个（`src/components/exercise/`）：

| 组件 | 职责 | 状态 |
| --- | --- | --- |
| `LoadReadout.vue` | 口径读数：主数字 + 带口径的单位（`kg/侧` · `kg/只`）+ 灰字副标（合计 / 含杠 / 档位），`showChip` 出一枚读法徽标 | **已落**（原计划的 `LoadChip`） |
| `LoadSheet.vue` | 满屏换算卡：口径徽标 + 操作数大字 + 合计 + 片盘 + 我的器械切换 | 待做（P1/P2） |
| `PlateStack.vue` | 片盘：点片加减，实时算每侧/合计/组合；键盘可切 | 待做（P2） |

`src/utils/loadBasis.ts`（纯函数，可单测）—— 落地签名：

```ts
inferLoadSetup(kind, equipment, name, weightStep): LoadSetup
workloadOf(kg: number | null, setup: LoadSetup): number      // 统计口径（原 toWorkload）
readLoad(kg: number | null, setup: LoadSetup): LoadReadout   // 主数字 + 单位 + 副标 + 徽标（原 fmtOperate）
platesFor(perSideKg, stock): { plates: number[]; rest: number }  // 贪心分解
perSideOf(totalKg, barKg): number                            // 每侧片重（原 splitSides）
```

`kind` 先于 `equipment` 判断：计时 / 有氧 / 拉伸一律 `basis = null`（不显示重量），
而不是被 `other` 兜底成自重。

`fmtKg`（`src/utils/format.ts:39`）保持不变 —— 它是纯格式化，不该承载口径。

### 3.2 逐面改造清单

| 文件 | 现状 | 改为 |
| --- | --- | --- |
| `ExerciseLibrarySheet.vue:126` | `默认重量 40 kg` | `LoadReadout`（主数字带 `kg/侧`、副标出合计），点击进 `LoadSheet` | ✅ 已落（`LoadSheet` 仍待做） |
| `ExerciseDetailDrawer.vue:111` | `建议重量 40 kg` | 同上（抽屉版） | ✅ 已落 |
| `SessionOverlay.vue:196–209` | 快捷胶囊 `${kg} kg` | 按口径生成：`建议 20/侧`、`上次 12/只` |
| `SessionOverlay.vue:1410–1434` | `NumberStepper label="重量" unit="kg"` | 挂片/杠铃 → `PlateStack`；插片/哑铃 → 步进 + 口径词 |
| `WeightAdviceSheet.vue:86–88` | hero 是「数字 + kg + ×N 次 ×M 组」，**没有任何口径词** | `22 kg/侧` + `合计 44`；计算链节点标「合计口径」 | ✅ 已落 |
| `SessionSummaryPane.vue:210` | `Σ 重量×次数` | `Σ workloadOf(...)×次数`；副标注明「合计口径」 |
| `WorkoutDetailDrawer.vue` / `ExerciseHistoryPanel.vue` | 逐组 `40 kg` | `40·侧` 紧凑后缀 + 行末图例 |
| `ExerciseTrendCard.vue` / `WeightCurve.vue` | 趋势点 `${v} kg` | 纵轴标口径（或统一折算合计后在脚注说明） |
| `SessionCourseDrawer.vue` | 下一个动作的处方摘要 `${kg} kg` | 按口径生成，同训练中快捷胶囊 |
| `ExerciseFormSheet.vue:192` | `默认重量`、`step=2.5` 写死 | 默认口径 + 步进跟着口径走 |
| `ai/tools/exercise.ts:303`、`plan.ts:272` | 建议重量纯数字 | 输出带 `basis`，prompt 要求「每侧/每只/总重」表述 |
| `trainingAdvice.ts:116–120` | 直接对 `weightKg` 算 e1RM | 先 `workloadOf` 再算；`ExerciseAdvice` 增加口径字段 | 口径字段 ✅ 已落（`advice.load`）；e1RM 折算待做 |

改造后 `` `${fmtKg(kg)} kg` `` 这种拼接应当被 ESLint 自定义规则或 review 拦住：
全库 27 处、8 个文件；带「 kg」拼接的重量展示组件共 10 个
（SessionOverlay / SessionSummaryPane / WeightAdviceSheet / ExerciseDetailDrawer / ExerciseHistoryPanel /
ExerciseLibrarySheet / ExerciseTrendCard / WeightCurve / SessionCourseDrawer / WorkoutDetailDrawer）。

### 3.3 训练中的换口径

训练中改口径只影响**本组之后**的记录，已完成的组不改写。界面上给出
「已完成的 2 组按插片记录」的提示 —— 同一节课混两种口径是允许的（换机器），
统计时按各自快照换算，不需要禁止。

### 3.4 展示文案（口径 → 中文）

| basis | 主数字样例 | 副标样例 | 读法徽标 | 器械徽标（另一枚） |
| --- | --- | --- | --- | --- |
| stack | `40 kg` | `插片档位` | 读数 | 插片式 |
| side | `20 kg` | `每侧 · 合计 40 kg` | 每侧 | 挂片式 |
| total | `60 kg` | `含杠 20 · 每侧 20` | 含杠 | 杠铃 |
| hand | `22 kg` | `每只 · 一对 44 kg` | 每只 | 哑铃 / 壶铃 |
| assist | `减 25 kg` | `越大越轻 · 不计容量` | 减重 | 助力机 |
| band | `3 号带` | `约 15–25 kg · 不计容量` | 带 | 弹力带 |
| bw | `自重` | `+10 kg 负重` | 自重 | 自重 |

**徽标分两枚**：器械徽标说「这是哪种器械」（挂片式 / 插片式 / 杠铃 / 哑铃 / 壶铃），
读法徽标说「这个数字怎么读」（每侧 / 含杠 / 每只 / 减重）。分开的理由：壶铃摇摆与哑铃卧推都是
`hand`，若徽标只写「哑铃」，壶铃那条就是错的信息。

「每侧」和「每只」不能混用：单侧（左右）用「每侧」，双手各持一个用「每只」。

`assist` 不给「等效自重」（那需要用户体重，`LoadProfile` 里没有这个字段，`toWorkload` 也拿不到；
要显示就单独从 `profile.weight_kg` 取，别塞进口径层）。

### 3.5 首次口径确认（只在歧义时出现）

触发条件（三者同时满足，缺一不弹）：

1. 动作在**双形态名单**里 —— 现有 81 个动作只有 **2 个**：器械推胸、站姿提踵
   （库外的腿举、哈克、臀推同理）。`cable` 一律不进这张卡：绳索的歧义是「单侧还是双侧」，
   由 `unilateral` 开关解决，不是插片/挂片；助力机同理，`assist` 由用户显式指定。
2. 该动作没有用户确认过的配置（`inferred = true`）。
3. 用户**第一次进入该动作的训练**。

一张半屏卡，两个选项（插片配重 / 挂片式）+ 「记住这台器械」开关（默认开）。
不打断计划浏览、不在动作库里弹窗；用户点「稍后」就按推断值走（名单内的推断值都是 `side`），下次还问。
这张卡只问一次，答案写进 `exercise_load_profiles`（`inferred = false`）。
名单外的机器不给卡 —— 用户在动作库「我的器械」里自建一台即可（§3.1）。

## 4. 数据与迁移

### 4.1 新增

- 表 `exercise_load_profiles`（`id, exercise_id, label, basis, bar_kg, unilateral, plate_stock JSON, step, inferred, created_at, updated_at`），
  `(exercise_id, label)` 唯一；`label = ''` 表示「默认器械」。
- `workout_sets` 表（`db.rs` 迁移 0013 建的表，不是 `sets`）加列（快照，避免历史被口径变更改写）：
  - `load_basis TEXT NULL`
  - `load_side TEXT NULL`（`'l' | 'r' | NULL`，单边记录用）
- **进行中的课**：`workout_sessions` 已有 `weight_kg` 与整场快照 `state_json`（`db.rs:261,263`）。
  口径**不加列**，写进 `state_json` 的每组记录里 —— 与训练中改口径「只影响本组之后」天然吻合，
  结束落库时再把快照抄到 `workout_sets.load_basis`。
- 迁移编号写死：`MIGRATIONS` 当前到 **0054**（`db.rs:2134-2189`，最后一条定义在 `:2014`），
  本次新建 **`MIGRATION_0055`**（建表 + 两列一次做完；要分两次提交就是 0055 建表、0056 加列）。

### 4.2 回填

> **已定（2026-11-17）：历史一律回填 `stack`，不猜 `side`。**
> 理由：当年 UI 只有 `重量 [40] kg` 一个数字框、从无「每侧」字样，读数=负荷是当时最贴合现状的读法；
> 且猜错方向决定了失败形态 —— 低估是安静的（趋势偏低但连续），虚高是爆炸的（容量/PR 一夜翻倍，
> 用户只会认为数据被篡改）。影响面也只有双形态名单那 2 个动作。
> 代价：真在挂片机上练过的那几条会低估一半 —— 用「改单场口径」兜底，不批量猜。

- `workout_sets.load_basis` 按所属动作的 `equipment` 推断回填，`machine` 一律落 `stack`。
  这些行在界面上不标「按动作推断」的小字（噪声太大），但如果用户记得当时是挂片机，
  可以在训练详情里改那一场的口径 —— 默认不改，也不批量猜。
- 哑铃历史行：数字按 `hand` 解释 → 容量计算会 ×2。**这会使用户的哑铃容量翻倍**，
  在 `SessionSummaryPane` 加一次性说明（「容量口径已统一，哑铃按每只×2 统计」），
  或者首次打开时给一条可关闭的提示条。建议后者，避免用户以为数据出错。
- 历史记录**不重算、不改写原文**，`workout_sets.weight_kg` 仍是用户当时输入的数字。

### 4.3 兼容

- `weightKg` 字段保留，语义 = 「按该行 `load_basis` 口径的数字」。
- 旧客户端 / 未迁移行：`load_basis = NULL` 视为 `stack`（与旧展示一致）。
- AI 工具返回值增加 `basis` 字段，属**新增非破坏**改动。

## 5. 验收

1. 81 个内置动作的 `inferBasis` 输出逐条过一遍（单测快照）：双形态名单**恰好 2 个**
   （器械推胸、站姿提踵）；其余 `machine`/`cable` 落 `stack`；
   `kind ∈ {timed, cardio}` 的 8 个动作（平板支撑、跳绳、泡沫轴…）必须是**无负重**，不是 `bw`。
2. 一件真实场景：器械推胸挂片 → 训练 → 记录 → 容量 = 40×次数；同一天插片 40 → 容量 = 40×次数；
   两台机器的记录在历史里可对齐比较。
3. 哑铃卧推 22/只 → 容量 44×次数；与杠铃卧推 60 的 e1RM 比较不出现量级错误。
4. 助力引体（需先补种子动作或自建）：记录 `减 25`，容量不计，PR 改报「辅助最少」。
   现状是「只要动作有重量就计容量、就报 PR」（`sessionSummary.ts:54-61`），
   所以一旦有动作走 `assist`，不修就会立刻产出假的 25 kg PR。
5. **回填不跳变**：迁移前后，器械推胸 / 站姿提踵的历史容量与 PR 必须**一分不差**（全为 `stack`）；
   哑铃行按 `hand` ×2 属于**预期翻倍**，要有一次性说明条，且不能与上面这条混在一个 PR 里验证。
6. 浅色 + 暗色各一张截图（STANDARDS §7），`npm run typecheck / lint / build` 全绿，
   `cargo clippy -D warnings` 全绿，mock 与 tauri 两种模式各验一遍。

## 6. 分期建议

| 期 | 内容 | 收益 |
| --- | --- | --- |
| P0（1 天） | `loadBasis.ts` 纯函数 + 单测；`LoadChip` 只做行内徽标，接到动作库/计划/建议三处（口径按推断，无配置表） | 消掉 80% 的「这是每侧还是合计」误解 |
| P1（2–3 天） | `exercise_load_profiles` 表 + 首次确认卡 + 动作库「我的器械」 | 同名动作的插片/挂片歧义消解 |
| P2（2 天） | `PlateStack` 训练中片盘 + 单边左右分记 | 挂片机不再是「数字框」 |
| P3（1–2 天） | 容量/e1RM/PR 全部走 `toWorkload` + 迁移说明条 + 训练详情「改这一场口径」（§4.2 的兜底）。**真实调用点不止一处**：`trainingAdvice.ts:288`、`sessionSummary.ts:261/282/348/384`、`strengthStats.ts:94` —— 只改 `trainingAdvice` 不会让 PR 口径归一 | 统计第一次可比 |
| P4 | AI 侧 `basis` 表述 + prompt | 教练口吻不再含糊 |
