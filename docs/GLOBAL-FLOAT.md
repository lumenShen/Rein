# 全局沉浸浮窗（Global Immersive Float）

> 目标：把「程序内已有的沉浸会话浮条」（专注 / 训练课）搬到**系统级浮窗**上 ——
> 离开应用去干别的事时，正在跑的专注与训练依然看得见、控得动；表现与程序内的浮条逐像素同源。
> 桌面端同时把系统标题栏换成自绘标题栏（主窗口与浮窗都用这一份）。
>
> 本文是**实现契约**。任何改动先改这里，再改代码（STANDARDS §8）。

---

## 1. 名词与范围

| 词 | 指什么 |
| --- | --- |
| 沉浸会话 | 有「进行中」语义、程序内以浮条常驻的两条：**专注（番茄钟）**、**训练课 / 跑步** |
| 程序内浮条 | `components/common/FloatDock.vue` 外壳 + `FocusFloatBar` / `ActiveWorkoutBar` 内容（现有实现，唯一真源） |
| 全局浮窗 | 系统级浮窗：桌面 = 独立置顶 Tauri 窗口（`float.html`）；Android = `TYPE_APPLICATION_OVERLAY` 原生浮窗 |
| 主窗口 | 应用主窗口（label `main`），跑完整 Vue 应用 |

**范围**：专注（倒计时 / 正计时）与训练（课程 / 跑步）。
**不在本轮**：录音浮条、语音转写浮条、抢课浮条（它们不是「沉浸会话」，麦克风 / 转写跨窗口另有权限与生命周期问题）。扩展路径见 §8。

## 2. 平台矩阵与降级

| 平台 | 实现 | 不可用时 |
| --- | --- | --- |
| Windows 桌面 | 第二种 Tauri 窗口（透明 / 无边框 / 置顶 / 不进任务栏 / 不可缩放），内容 = 同一套浮条材质与排版 + 自绘标题栏 | 建窗失败 → `supported: false`，静默回退到程序内浮条（**现有实现一字不改**） |
| Android | `SYSTEM_ALERT_WINDOW`（「在其他应用上显示」）权限 + 前台服务 + `WindowManager` 原生浮层，样式对齐浮条（圆角 / 半透明底 / 状态点 / 同文案同按钮） | 未授权 / 服务起不来 / API < 23 → `permitted` 或 `supported` 为 false，**仅程序内浮窗**（现有行为），「设置 › 全局浮窗」页如实说明 |
| 浏览器（`npm run dev`） | 无系统浮窗能力：`supported: false`，全部命令走 mock 返回降级态 | 程序内浮条照旧（现有 e2e 不因此变化） |

**降级铁律**：全局浮窗是**叠加能力**。任何一步失败都不得影响程序内浮条、计时、落库。
判断只看 `global_float_status()`，不在前端各处散落平台判断。

## 3. 行为规格

### 3.1 显示时机（两端同一条）

```
show = 开关开 && supported && 有沉浸会话 && 应用不在前台 && 用户没有手动关掉本次
```

- **应用不在前台**：桌面 = 主窗口失焦或最小化；Android = Activity 不在 resumed。
- 回到前台 → 立即隐藏全局浮窗（程序内浮条接管），二者**永不并存**（不做重复 UI）。
- 用户点浮窗「关闭」→ 本次不在当前失焦期再弹；主窗口重新获得焦点后清除该状态
  （下次离开应用照常出现）。
- 无会话（专注结束 / 训练结束）→ 立即隐藏。

### 3.2 内容（与浮条同源）

| 会话 | 状态点 | 首行 | 次行 / 读数 | 主动作 | 次级 | 其他 |
| --- | --- | --- | --- | --- | --- | --- |
| 专注 | work 呼吸 / break 灰 / paused 警示 | 相位文案（专注中 / 休息中 / 已暂停 / 正计时中 / 正计时 · 已暂停） | `mm:ss`（浮窗本地按 `clock` 走秒） | 暂停 / 继续 | 结束（文案随相位：结束 / 跳过） | 打开专注页、进入沉浸 |
| 训练 | live 呼吸 / pause 警示 / done | 标题（动作名 / 跑步） | 统计（当前组 / 配速里程等） | 暂停 / 继续 / 完成本组（按视图） | 结束 | 恢复沉浸 |

文案、按钮集合、按钮顺序、色点语义**必须**与程序内浮条一致 —— 由 `components/float/*`
的同一份内容组件 + 同一份快照构造器产出（见 §5.2）。

### 3.3 结束确认

程序内浮条用 `ActionSheet` 二次确认；全局浮窗没有抽屉容器，改为**同窗内联确认**：
点「结束」后窗口临时长高到 `confirm` 形状（430×172），上半是 ActionSheet 的
标题原文（说明后果那句话），下半是两条动作 + 取消，**文案逐字取自同一份 `end.actions`**。
取消 / 完成即回到 `bar`；`confirm` 是临时形状，不进持久化偏好。

桌面长高由**浮窗前端自己完成**：直接调 `global_float_set_form('confirm')` 改尺寸，
再把窗口上移 80（底边锚定，钳制到工作区上界之内），并记住原 y 以便取消时还原；
确认全程不发 `form` 动作回主窗口（主窗口对 confirm 无事可做）。取消 / 完成 / 失焦 /
隐藏都会收回确认态并还原高度与位置。

### 3.4 两态与停靠：bar / blob（桌面与程序内浮条同款手势）

- bar：默认形态，宽 = 430（内容 406，与 430 宽应用窗口里的浮条逐像素同宽），高 = 92（标题栏 32 + 浮条 56 + 余量）。
- blob：64×64 泊车形态（状态点 + 读数，读数取快照 `blob` 字段，与程序内 `#blob` 插槽同源），轻点展开回 bar。
- confirm：430×172 的临时形状，只在结束确认期间出现（见 §3.3）；取消/完成回到 bar。
- 三种形状都由 Rust 的 `global_float_set_form` **只改尺寸、不动位置**；窗口位置由浮窗前端全权持有。

桌面手势与 `composables/useDragDock`（程序内浮条）逐条同源，手感参数同一份：

- 整条 bar / 整块 blob 任意位置按下即可拖（**不再用原生 drag region** —— 它在 mousedown
  就把指针让给系统移动循环，测不到速度也收不到点击）。按下缩放 0.97、拖起缩放 1.03 +
  浮起阴影；位移越过 8px 才算抓住，此前松手是点按（按钮照常触发）；拖拽后短暂窗口内的
  那次幽灵点击被吞咽，防止松手误触按钮。
- 拖拽中窗口跟随指针（`setPosition`，rAF 节流），越界走橡皮筋阻尼（以当前显示器工作区为界）。
- 松手解算：|v| ≥ 0.35px/ms 为轻弹 —— 横向→左/右吸附为 **blob** 并记住松手高度，
  纵向→顶/底停靠为 **bar**；慢速释放用投影 p+v·180 取最近槽位。
- 落位用可打断弹簧（stiffness 160 / damping 22，与程序内同一组常量）；飞行途中再次按下
  以当前位置接管为新拖拽。动效档 off / 系统减弱动效时直接落位。
- 四个槽位：顶/底 = bar 水平居中、距工作区边 12；左/右 = blob 贴工作区边、纵向按 sideY 比例。
- 标题栏「泊车为方块」= 吸附到最近一侧；blob 轻点 = 展开回上一次的全宽条槽位（顶/底）。
- 持久化：形态 bar/blob 记 `rein.float.form.v1`（主窗口持有）；停靠槽位 slot/barSlot/sideY 记
  `rein.float.dock.v1`（浮窗持有，与程序内浮条的持久化同构）。槽位相对工作区表达，
  **跨重启按当前显示器工作区重算**（多屏/DPI 变化也落在屏内）；hide/show 不丢位。
  首次建窗落在默认槽（工作区底边居中，边距 12）。
- 手势只在「桌面 Tauri + 有会话 + 非确认态」生效；浏览器预览空转。
- **Android 与桌面/程序内同一套四槽位模型**（2026-11-10 起）：整条 / 整块任意位置起手拖，
  8dp slop、轻弹阈值 0.35dp/ms、慢放投影 180ms、橡皮筋 0.55、弹簧 160/22，参数与本文件
  上面逐条同源（实现见 `GlobalFloatService` 的 `dockTo / solveRelease / springFrame`）。
  长按信息区泊车是 Android 额外的快捷手势（桌面由标题栏「泊车为方块」承担）。
- 浮窗被限制在**当前显示器工作区**内（与程序内浮条限制在视口内同义）；拖拽不跨屏。
  Android 用 `WindowInsets.systemBars() + displayCutout()` 当安全区（等价于 `--safe-*`），
  窗口必须带 `FLAG_LAYOUT_IN_SCREEN` —— 否则 `params.y` 以状态栏下沿为原点，槽位会整体
  下移一个状态栏高度，底部槽位直接被裁出屏幕。
  安全区**不能只在建窗时算一次**：导航模式切换（手势 63px ↔ 三键 126px）只改 inset、
  不改配置，`onConfigurationChanged` 不会来。根视图挂 `OnApplyWindowInsetsListener`
  当信号，任何 inset 变化都作废缓存并按当前槽位重落位（拖拽/弹簧中不抢，松手后自然取新值）。
  隐藏（GONE）期间的变化同样收不到回调，所以「从藏到显」也强制重算一次。

### 3.5 桌面标题栏（自绘，两窗口同一份实现）

主窗口 `decorations: false`，标题栏由程序自绘：

- 高 `--titlebar-h: 40px`；左侧品牌区（色点 + Rein），右侧窗口控制：最小化 / 最大化还原 / 关闭；
  中间整段可拖拽（`data-tauri-drag-region`），双击切换最大化。
- 颜色只用令牌（透明底 + 环境光可见，与 base.css「环境光」段同源），按钮 hover/active 有反馈，
  图标按钮必带 `aria-label`。
- 四边 + 四角各一条 6px 隐形拖拽缩放热区 → `startResizeDragging(direction)`（`decorations: false`
  之后原生边框消失，不补这一层窗口就再也改不了大小）。
- **只在桌面平台的 Tauri 环境渲染**（`isTauri` 且非 Android）：浏览器预览与 Android 不出现，
  现有 e2e 的布局断言不受影响。

浮窗标题栏：同一套语言的高 32 紧凑版 —— 左侧会话标题 + 状态点，右侧「泊车为方块」与「关闭」。
**浮窗里不挂原生 drag region**（TitleBarBase 以 `native-drag=false` 复用）：整壳拖拽由
浮窗自己的指针手势接管（§3.4），原生拖拽区会吞掉指针事件、让轻弹测速失效。
blob 态隐藏标题栏（64×64 放不下，且泊车就是「最小化到只剩读数」）。

## 4. 前端结构

```
src/float/main.ts          # 浮窗独立入口（不含 Pinia / router / 全局运行时）
src/float/FloatApp.vue     # 浮窗应用：标题栏 + 浮条内容 + 内联确认；负责窗口形态与拖拽
src/float/float.css        # 浮窗私有：透明底、窗口布局、无滚动
float.html                 # 第二入口（vite build.rollupOptions.input）
src/components/float/      # 与程序内浮条共用的内容组件与快照构造器
  FocusFloatContent.vue    #   props: snapshot；emits: primary / end / open / immerse
  WorkoutFloatContent.vue  #   同上（两行版）
  snapshot.ts              #   buildFocusSnapshot(pomo) / buildWorkoutSnapshot(rt) / endSheet 文案
src/system/globalFloat.ts  # 主窗口侧运行时：状态机（显示时机 / 形态 / 关闭抑制）、快照推送、动作执行
src/composables/useFloatDock.ts # 浮窗窗口级停靠手势：拖窗 / 轻弹 / 弹簧 / 橡皮筋 / 槽位持久化（useDragDock 的窗口版）
src/services/floatService.ts # IPC 封装（§5.1 命令表）
src/pages/GlobalFloatPage.vue        # 三级设置页（开关 / 授权状态 / 权限开关教程 / 出现与收起）
src/components/layout/AppTitleBar.vue          # 主窗口自绘标题栏
src/components/layout/FloatTitleBar.vue        # 浮窗自绘标题栏（紧凑版，复用同一套视觉）
src/components/layout/WindowResizeHandles.vue  # 无边框窗口的八向缩放热区
src/system/windowChrome.ts                     # 平台判定（isDesktopWindow）+ 窗口控制封装
```

主窗口挂载顺序（`main.ts`）：既有初始化之后 `globalFloat.init()`。

## 5. 契约

### 5.1 类型（`src/types/float.ts`，从 `@/types` barrel 导出）

```ts
export interface GlobalFloatClock {
  direction: 'down' | 'up'
  /** 快照时刻的读数（秒） */
  baseSec: number
  /** 该读数对应的本地时刻（epoch ms）；null = 不走动（暂停 / 静止） */
  atEpochMs: number | null
}

export interface GlobalFloatEndAction { id: string; label: string; danger?: boolean }

export interface GlobalFloatEndSheet {
  /** 标题：说明「结束会拿走什么」（与 ActionSheet title 逐字一致） */
  title: string
  actions: GlobalFloatEndAction[]
}

export interface GlobalFloatPrimary { id: 'pause' | 'resume' | 'complete'; label: string }

export interface GlobalFloatSnapshot {
  kind: 'focus' | 'workout'
  tone: 'work' | 'break' | 'paused' | 'done'
  title: string
  stat: string
  clock: GlobalFloatClock | null
  /** blob 态一行短读数（训练课 = view.blob；专注可省，浮窗按 clock 自算） */
  blob?: string
  primary: GlobalFloatPrimary | null
  end: { label: string; sheet: GlobalFloatEndSheet } | null
  /** 「打开」落地路由名（focus / workout 等） */
  route: string
  /** 是否提供「进入沉浸」 */
  canImmersive: boolean
}

export type GlobalFloatWindowShape = GlobalFloatForm | 'confirm'

export interface GlobalFloatStatePayload {
  snapshot: GlobalFloatSnapshot
  form: 'bar' | 'blob'
  /** 主窗口当前画质 / 动效档（浮窗首帧就按同一档渲染，避免闪一帧默认档） */
  perf: string
  motion: string
}

export interface GlobalFloatStatus {
  supported: boolean
  permitted: boolean
  visible: boolean
}

/** 浮窗所在显示器的工作区（逻辑像素，虚拟屏幕坐标，与 LogicalPosition 同口径）。
 *  读不到显示器时回零矩形；非 Windows 平台恒零（原生浮层不用它）。 */
export interface GlobalFloatWorkArea {
  x: number
  y: number
  width: number
  height: number
}

export type GlobalFloatActionName = 'pause' | 'resume' | 'complete' | 'end' | 'open' | 'immerse' | 'close' | 'form'
export interface GlobalFloatAction {
  action: GlobalFloatActionName
  option?: string
  /** 目标窗口形状（confirm 只用于结束确认的临时长高） */
  form?: GlobalFloatWindowShape
}
```

### 5.2 命令（Rust ↔ services ↔ mock 三处同步，`npm run contract` 把关）

| 命令 | 入参 | 返回 | 桌面 | Android |
| --- | --- | --- | --- | --- |
| `global_float_status` | — | `GlobalFloatStatus` | supported/permitted 恒 true，visible = 窗口可见 | 布隆快照：`Settings.canDrawOverlays` + 服务在跑 |
| `global_float_open` | — | `GlobalFloatStatus` | 建窗（已存在则 show） | 有权限则起前台服务，否则只返回状态 |
| `global_float_close` | — | `()` | hide 窗口 | stop 服务 |
| `global_float_push` | `payload: GlobalFloatStatePayload` (JSON) | `()` | 缓存 + `emit_to("float", "rein://float/state")`（载荷字符串） | 缓存 + JNI `update` |
| `global_float_latest` | — | `string` | 最近一次 payload（无则空串） | 同 |
| `global_float_set_form` | `form: 'bar' \| 'blob' \| 'confirm'` | `()` | **只改窗口尺寸，不动位置**（位置由浮窗前端持有；confirm = 结束确认的临时长高 430×172） | JNI `setForm` |
| `global_float_work_area` | — | `GlobalFloatWorkArea` | 浮窗所在显示器工作区（逻辑像素；current_monitor 优先，回退 primary；读不到回零矩形） | 零矩形（原生浮层自己量屏幕） |
| `global_float_request_permission` | — | `GlobalFloatStatus` | 空操作 | 跳「在其他应用上显示」设置页 |
| `global_float_take_action` | — | `string` | 恒空串 | 读走即清：浮层按钮产生的动作 JSON（冷启动兜底） |

### 5.3 事件

| 事件 | 方向 | 载荷 |
| --- | --- | --- |
| `rein://float/state` | Rust → 浮窗 | `GlobalFloatStatePayload`（JSON 字符串透传） |
| `rein://float/action` | 浮窗 → 主窗口 | `GlobalFloatAction` |

浮窗启动时先 `invoke('global_float_latest')` 渲染首帧，再 `listen('rein://float/state')`。
形态偏好仍由主窗口持久化（`rein.float.form.v1`）并随 payload 下发，但**切换由浮窗发起**：
手势 / 按钮先直接调 `global_float_set_form` 改尺寸（跟手，不等主窗口往返），再发
`{ action: 'form', form }` 给主窗口落偏好 + 推新载荷；浮窗对本地发起的形态做乐观渲染，
回声到达前不被旧 payload 回滚。confirm 完全在浮窗本地（§3.3），不回发动作。

Android 原生浮层 → 前端：JNI 侧 `evaluateJavascript` 派发
`window.dispatchEvent(new CustomEvent('rein-float-action', { detail: <GlobalFloatAction JSON> }))`；
同时写入 bridge 缓存，前端在 `visibilitychange` 与启动时 `global_float_take_action()` 兜底取回。

### 5.4 Android JNI 方法表（Rust ↔ Kotlin 逐字对齐，签名写错运行期崩进程）

Kotlin `object GlobalFloatBridge`（`com.gozaoo.rein`），全部 `@JvmStatic`：

| Kotlin 方法 | JNI 签名（Rust 侧调用串） |
| --- | --- |
| `enable(Context)` | `(Landroid/content/Context;)V` |
| `disable(Context)` | `(Landroid/content/Context;)V` |
| `requestPermission(Context)` | `(Landroid/content/Context;)V` |
| `update(Context, String)` | `(Landroid/content/Context;Ljava/lang/String;)V` |
| `setForm(Context, String)` | `(Landroid/content/Context;Ljava/lang/String;)V` |
| `onAppForeground(Context, boolean)` | `(Landroid/content/Context;Z)V` |
| `snapshot(Context): BooleanArray` | `(Landroid/content/Context;)[Z` |
| `takeAction(Context): String` | `(Landroid/content/Context;)Ljava/lang/String;` |

返回值语义：`snapshot` = `[permitted, running]`（API < 23 时 permitted=false、running=false）。
`exec` 无返回值通道 → Rust 侧静态缓存 + 命令返回上次缓存（与 `modules/tracking` 同一套做法）。

## 6. 桌面窗口规格

### 6.1 主窗口（变更）

`tauri.conf.json` → `app.windows[0]`：`decorations: false`（其余不动）。标题栏、缩放热区、拖拽由前端补。

### 6.2 浮窗（新建，Rust 建）

| 属性 | 值 |
| --- | --- |
| label | `float` |
| url | `float.html`（dev = `http://localhost:1420/float.html`） |
| 尺寸 | bar 430×92 / blob 64×64 / confirm 430×172（逻辑像素，由 `global_float_set_form` 切换，右/下边锚定） |
| decorations | false（自绘标题栏） |
| transparent | true（圆角外透明） |
| alwaysOnTop | true |
| skipTaskbar | true（tao 用 ITaskbarList.DeleteTab：**不进任务栏**；Alt+Tab 仍可能出现，系统级取消需 WS_EX_TOOLWINDOW，见 §11） |
| resizable / maximizable / minimizable | false / false / false |
| focusable | true（要能点按钮；点它不顺带抢走主窗口的「失焦」判定） |
| 初始位置 | 主屏工作区**底边居中**（默认槽，边距 12）；页面载入后按持久化槽位落位（§3.4）。hide/show 不丢位；跨重启按槽位重算 |

浮窗隐藏（不销毁）→ 再开时先 `global_float_push` 最新 payload 再 show，避免闪旧帧。

## 7. 权限（`src-tauri/capabilities/default.json`）

`windows: ["main", "float"]`；在 `core:default` 之上补：

- 主窗口：`core:window:allow-minimize` / `allow-toggle-maximize` / `allow-maximize` / `allow-unmaximize` /
  `allow-is-maximized` / `allow-close` / `allow-show` / `allow-set-focus` / `allow-start-dragging` /
  `allow-start-resize-dragging`
- 浮窗：`core:event:allow-listen` / `allow-emit` / `allow-unlisten` / `allow-start-dragging` /
  `core:window:allow-set-position`（自定义拖窗；读取类 outer-position / inner-size / current-monitor /
  scale-factor 已在 `core:window:default` 里）

## 8. 扩展路径（不在本轮）

再挂第三个会话（录音 / 语音转写）时：加一条 `kind`、一个内容组件、一个快照构造器；
显示时机、窗口形态、降级、设置页都不用动。

## 9. 验收

1. 程序内浮条行为、文案、动画**零变化**（既有 e2e 全绿）。
2. 桌面：主窗口无系统标题栏；自绘标题栏可拖 / 双击最大化 / 三颗控制钮可用 / 八向可缩放；浅色暗色都正常。
3. 桌面：专注或训练进行中，主窗口失焦 → 浮窗出现在默认槽（工作区底边居中）、置顶、无系统边框、内容与浮条一致；
   主窗口回焦 → 浮窗消失；点击浮窗暂停 / 继续 / 结束（内联确认）/ 打开 / 沉浸都生效。
   手势与程序内浮条同款：整壳可拖、轻弹左右泊车为 blob、轻弹上下停靠为 bar、慢放最近槽位、
   弹簧落位、blob 轻点展开回 bar、泊车键吸附最近侧；槽位跨重启按工作区重算。
4. Android：未授权时「设置 › 全局浮窗」页如实提示且只有程序内浮条；授权后离开应用出现原生浮层，
   按钮可暂停 / 继续 / 结束；关掉应用内开关 / 会话结束 → 浮层消失。
5. `npm run contract` / `lint` / `typecheck` / `build` / `cargo clippy -- -D warnings` 全绿。
6. 浅色 + 暗色截图各一张（STANDARDS §7）。

## 10. 验证工装

- `scripts/e2e-global-float.mjs`：
  - mock（浏览器）：设置入口 → 三级页开关与授权说明在场、开关持久化、`supported:false` 降级、无 console 错误、标题栏不出现。
  - 真机（Tauri + WebView2 远程调试）：标题栏 DOM 与窗口 ex-style（无 `WS_CAPTION`、有 `WS_EX_TOPMOST`）、
    专注开始后失焦 → `float` 窗口出现、DOM 断言（标题栏 / 色点 / 相位 / 读数 / 按钮）、动作回灌、
    回焦隐藏、截图。
- `scripts/shot-global-float.mjs`：浅色 / 暗色截图（桌面标题栏、浮窗 bar、浮窗 blob）。

**真机 CDP 的一个坑（2026-10-20 实测）**：wry 0.57 在创建 WebView2 环境时**总是**显式设置
`AdditionalBrowserArguments`（默认 `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`），
而 WebView2 的 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量只在「调用方没设置该属性」时生效 ——
所以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 对当前依赖版本**不生效**
（`scripts/e2e-app-campus.mjs` 文件头那句话已过期）。要开调试端口必须走配置：
把 `tauri.conf.json` 读出来、给 `app.windows[0]` 补 `additionalBrowserArgs: "--remote-debugging-port=<port> ..."`，
写到临时文件，再用 `npx tauri dev --config <临时配置>` 启动。**不要**把调试端口写进仓库里的生产配置。

三个实测补充（同一台机器，2026-10-20）：
- 配置确实会被 `tauri-runtime` 的 `WebviewAttributes::from(&WindowConfig)` 读进
  `AdditionalBrowserArguments` —— 启动后看 `msedgewebview2.exe` 的命令行能直接看到调试端口参数；
  端口没起来时先看那行，比猜快。
- **但这台机器上端口最终没监听**：WebView2 runtime 只有 Edge Beta 通道版
  （156.0.4314.36 / 156.0.4314.23），命令行里带着 `--remote-debugging-port=9232`、进程正常、
  页面正常，却始终没有 LISTENING、也没有 `EBWebView\DevToolsActivePort` 文件；补
  `--remote-allow-origins=*` 与 `--enable-features=msWebView2EnableDevTools` 均无效。
  结论：**CDP 是否可用取决于本机 WebView2 安装的通道/版本**，不能当作通用验收前提。
  真机验收因此走 `UI Automation + Win32 + 系统截图`（UIA 能读到 DOM 文本与按钮名，足以断言
  标题栏、浮窗内容逐字一致、confirm 长高与按钮文案、置顶/不抢焦点/回焦收起）；暗色截图用
  浏览器 mock 的 CDP `Emulation.setEmulatedMedia` 出，不动系统主题。
- `--config` 的合并值只通过 `TAURI_CONFIG` 环境变量参与增量编译判定：临时配置内容没变时 cargo 可能
  直接复用旧二进制（内嵌配置也还是旧的）。驱动脚本要么每次用**带时间戳的新文件名**，要么启动前
  `touch src-tauri/src/main.rs` 强制重算。另外：同一台机器**不要同时跑两个 rein.exe** ——
  WebView2 的 user data dir 是共享的，先起的那个会占住，后起的白屏/端口不开。

**2026-10-21 复跑实测（工装加固后的四条结论）**：

1. **CDP 端口今天通了**（`netstat` 看到 127.0.0.1:9232 LISTENING，`/json/list` 能连上），
   所以「本机永远拿不到 CDP」不是定论 —— 端口起不起得来跟 WebView2 通道 / 版本有关，
   脚本必须两条路都能跑（现状：默认 CDP，失败自动切 UIA）。
2. **从 CDP 里 `invoke` 不可靠**：同一台机器同一个进程里，`plugin:window|is_focused`
   有时立刻返回、有时与所有自定义命令（`todo_distribution` / `global_float_status` …）一起
   等到超时。所以**任何依赖 IPC 返回值的断言都不能只靠 CDP**；窗口是否出现、浮窗内容是什么，
   一律用 Win32 + UIA 断言（这两条不受页面 IPC 状态影响）。
3. **本会话没有前台窗口概念**：`GetForegroundWindow` 恒 0、`SetForegroundWindow` 不生效，
   Tauri 的 `isFocused()` 一开始就回 `false`，最小化后也不产生 `Focused(false)` 事件。
   于是「失焦 → 浮窗出现」这条链路在这里**根本触发不到**：两条脚本都加了最小化兜底，
   拿不到前台切换时如实标注「本条不可判」而不是失败（更不能挂住）。
   要在有交互式桌面的机器上验这一条。
4. **工装本身必须自带超时**：`spawnSync(powershell)` 没有超时就可能几分钟到几十分钟不返回
   （2026-10-21 实测挂过 27 分钟，日志停在「记事本 hwnd=…」）；CDP 的
   `Runtime.evaluate{awaitPromise}` 在页面被节流时也一样。
   现在：`win()` / `cap()` / `runPs()` 全部带 `-Timeout`（默认 20s，`REIN_WIN_TIMEOUT_MS` 可调），
   `guardPage()` 给每次求值加 15s 上限（`REIN_CDP_EVAL_TIMEOUT_MS`），`waitUntil` 单次尝试也有上限。

另外两处判据修正（同一天）：

- **主窗口「无系统标题栏」不能拿 `WS_CAPTION` 样式位判**：tao 的 undecorated 是
  「保留样式位 + `WM_NCCALCSIZE` 把非客户区归零」（实测 `style=0x14cf0000`，含 `0x00C00000`）。
  判据改为**客户区顶部 inset**（`nccheck` 的 `captionPx`，实测 2px，原生标题栏会是 ~46px）。
- **UIA 里相位与读数是同一个节点**（名字形如 `专注中 24:57`），旧助手用「第一个 mm:ss」
  取读数会抓到番茄钟卡片上的 `00:00`。现在 `phaseOf` 剥掉读数、`statOf` 优先取带相位的那个名字。

**2026-11-07 手势改造复跑实测（三条）**：

1. **本类自动化会话里 Rust 命令通道可能整体挂起**：从应用自己的 webview（CDP 9233 通了）
   `invoke('global_float_status')` 8s 不返回，`global_float_push/open` 同样超时 —— 与上面
   2026-10-21 第 2 条同症状且更重。于是 `trackFocus` 卡在第一个 `await isFocused()`、
   `appFocused` 恒 true，浮窗显示闸与一切手势真机断言都驱动不到（临时配置 `focus: false`
   也救不了：初读那条 IPC 本身就挂）。**浮窗真机验收必须在 IPC 健康的交互式桌面会话跑**；
   自动化会话里如实标「不可判」，不要把环境挂起当成代码回归。
   专项工装：`scratch/verify-float-gestures.mjs`（Win32/UIA 断言默认槽 / 泊车吸边 / 展开回槽 /
   confirm 底边锚定 / 合成拖拽轻弹；CDP 探针先判 IPC 死活）。
2. **Vue Boolean prop 缺省会被 cast 成 false**：TitleBarBase 的 `nativeDrag?: boolean` 若不
   withDefaults 显式给 true，主窗口（不传该 prop）会命中 `=== false` 分支被卸掉 drag region
   （真机 A2.1a 实测抓到）。浮窗传 false 不受影响，故只坏主窗口 —— 隐蔽，改这类开关 prop 必给默认值。
3. **共享 WebView2 profile 会带着上一轮会话残局**：`REIN_DATA_DIR` 只重定向 Rust 侧数据目录，
   localStorage（番茄钟 live / 浮窗偏好）在 `%LOCALAPPDATA%/<identifier>/EBWebView` 全进程共享。
   真机工装起跑前先认「继续 / 开始专注」两种按钮，别假设空闲态。

**2026-11-10 Android 全局浮窗「拖不动」修复与实测（模拟器 rein_test / API 36）**：

1. **根因是 Kotlin 作用域 shadowing，不是手势参数**：`ensureView()` 里
   `LinearLayout(this).apply { setOnTouchListener { _, ev -> onTouchEvent(ev) } }` 的未限定
   `onTouchEvent` 解析到 **`View.onTouchEvent`（视图自身）**，服务里的拖拽 / 长按逻辑从未执行；
   按钮因为自己是 clickable 所以照常工作，观感就是「能点不能拖」。修法：根视图改成
   `DockRoot : LinearLayout`，在 `onInterceptTouchEvent` / `onTouchEvent` 里接管手势。
2. **窗口必须 `FLAG_LAYOUT_IN_SCREEN`**：只有 `FLAG_LAYOUT_NO_LIMITS` 时 `params.y` 以状态栏
   下沿为原点，按屏幕尺寸算的槽位整体下移一个状态栏高度 —— 底部槽位被裁出屏外、顶部槽位
   压进状态栏。加上该 flag 后 `frame=[31,2168][1048,2305]`（屏高 2400、导航 inset 63、
   边距 12dp）与渲染位置逐像素对齐。
3. **弹簧落位必须用浮点积分**：`params.x/y` 是整数，若弹簧每帧从 `p.x` 回读再积分，
   收敛判定 `< 0.5px` 永远不成立 → `persistDock()` 不执行 → 重启回到旧槽位。改为
   `springX/springY` 浮点状态 + 写位置时取整，并在 `dockTo` 里**先落盘再飞**。
4. 实测回路（adb 注入触摸即可，覆盖到所有分支）：
   `input swipe` 竖向 → 顶/底停靠；横向 120ms → blob 吸边；blob 轻点 → 回上次 bar 槽；
   长按信息区 500ms → 泊车；慢速拖 blob（3.2s/1050px，< 0.35dp/ms）→ 保持侧边并记住 sideY；
   从「打开」按钮起手拖 → 窗口跟手且**不触发**该按钮（拦截后子视图收到 CANCEL）；
   `am force-stop` 再启动 → 槽位 / barSlot / sideY 全部还原；`结束 → 取消 / ✕` 按钮链路照旧。
5. **安全区矩阵实测（1080×2400 / 420dpi 模拟器，frame 数值为证）**：
   | 场景 | 期望 | 实测 `mAttrs` |
   | --- | --- | --- |
   | 竖屏 · 手势导航（status 136 / nav 63） | 底 slot 贴导航栏上方 12dp | `(31,2168) 1017×137`（下缘 2305，导航栏顶 2337） |
   | 竖屏 · 三键导航（nav 126，运行中切换） | 自动上移 63px | `(31,2105) 1017×137`（下缘 2242，导航栏顶 2274） |
   | 竖屏 · 顶 slot | 状态栏下 12dp | `(31,168)` |
   | 竖屏 · 左右 blob | 贴安全区侧边 | 左 `x=0`、右 `x=912`（1080-168） |
   | 横屏 · 手势导航（status 74 / nav 63） | 底 slot / 顶 slot | `(601,848)`、`(601,106)` |
   | 横屏 · 刘海（ROTATION_90 转到左侧，inset 136） | 左 blob 让开刘海 | `x=136`（不是 0） |
   | 横屏 · 三键导航（导航栏在右侧 126） | 右 blob 让开 | `x=2106`（2400-126-168） |
   | 逻辑屏幕 720×1280（`wm size`） | 宽度收口 / 槽位重算 | bar `657×137 @ (31,985)`、右 blob `x=552` |
   | 拖拽越过屏幕边缘后松手 | 橡皮筋回弹回安全区 | 拖到 y=1400 松手 → 回 `(601,848)` |

## 11. 已知限制（有意取舍）

1. **训练课读数靠主窗口心跳**：训练的统计行含计时读数，由主窗口每秒推一次；主窗口被系统节流
   （最小化久了）时可能停在最后一秒。专注不走这条路 —— 它的 clock 由浮窗本地推算，断流也准。
   真机若复现，给训练也加 clock 即可（快照字段已预留位置，改构造器一处）。
2. **桌面拖拽不跨屏**：浮窗限制在当前显示器工作区内（与程序内浮条限制在视口内同义），
   越界走橡皮筋。位置以**槽位**持久化（相对工作区），跨重启按当前工作区重算，多屏/DPI
   变化也落在屏内；首次建窗到页面载入之间可能先在默认槽闪一帧再落到持久化槽位。
   Android 原生浮层已搬同一套四槽位手势（2026-11-10），仍有的差别只有「拖拽不跨屏」这一条
   （系统浮层只能活在一块屏幕上）。
3. **Android 玻璃是近似的**：原生浮层用 GradientDrawable 半透明底 + 圆角 + 描边重建浮条观感，
   不跑 backdrop-filter 折射（系统浮层里没有可采样的背后内容）。文案 / 按钮 / 色点语义与程序内一致。
4. **Android 前台服务常驻通知**：浮窗服务在整个会话期间是一条 LOW 重要度通知（系统要求），
   会话结束 / 关掉开关即消失。这是系统浮层的硬成本，不是实现偷懒。
5. **录音 / 语音转写 / 抢课三条浮条不搬**：它们不是「沉浸会话」，且跨窗口的麦克风与转写
   生命周期另有权限问题。扩展路径见 §8。
6. **浮窗不进任务栏但仍在 Alt+Tab 里**：`skip_taskbar(true)` 在 tao/Windows 上的实现是
   `ITaskbarList.DeleteTab`（只摘任务栏按钮），不等于 `WS_EX_TOOLWINDOW`。要做到 Alt+Tab 也消失
   得自己设 ex-style（需要 Win32 调用）—— 本轮不做，工具窗语义够用。
7. **全屏路由会盖住标题栏**：跑步页与两层沉浸层是全屏 fixed 层，窗口按钮在那几页不可见
   （SS 语义上它们本来就是「整页接管」），退出后回来。