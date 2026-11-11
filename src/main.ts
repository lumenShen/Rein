import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { router } from './router'
import { usePomodoroStore } from './stores/pomodoro'
import { useHeartRateStore } from './stores/heartRate'
import { externalAccessRuntime } from './system/externalAccessRuntime'
import { globalFloat } from './system/globalFloat'
import { initRubberScroll } from './system/rubberScroll'
import { shareInbox } from './system/shareInbox'
import { workoutRuntime } from './system/workoutRuntime'

import './styles/tokens.css'
import './styles/base.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
// 番茄钟状态核：恢复今日轮次 / 关联待办，并接管上次未走完的运行态（幂等，只在这里调一次）
usePomodoroStore().init()

// DEV 专用：e2e 直接驱动 store 的**单轮**路径。界面现在默认先排计划再开始
// （计划里的末颗压缩 / 休息下限 5 分钟不适合用小数分钟做快速回归），旧套件的
// 时序语义需要一条不经过计划的最小起跑入口。生产构建里这段会被 tree-shake 掉。
if (import.meta.env.DEV) {
  ;(
    window as unknown as {
      __reinTestStartPomodoro?: (opts?: { focusMin?: number; breakMin?: number }) => void
    }
  ).__reinTestStartPomodoro = (opts) => {
    const p = usePomodoroStore()
    if (p.active) p.reset()
    p.setMode('down')
    p.start(opts)
  }
}
// 运动系统运行时：启动即接管未完成的运动（计时/GPS/落盘独立于组件，
// 悬浮运动条与沉浸页共用这一份数据源）
workoutRuntime.init()
// 心率：订阅 Rust 侧的连接状态与节流样本（桌面 BLE）；mock 模式下走 1s 轮询
void useHeartRateStore().init()
// 分享收件箱运行时：接收系统分享/打开的文件，路由到 AI 页预填
shareInbox.init()
// 外部访问授权弹窗运行时：订阅授权请求/状态事件并兜底拉取待决列表
externalAccessRuntime.init()
// 全局沉浸浮窗：主窗口是唯一真源，离开应用时把正在跑的专注 / 训练推给系统浮窗
globalFloat.init()
// 超范围回弹：到边拖动改为自绘平移（Android 原生 stretch 已在 MainActivity 关闭）
initRubberScroll()
app.mount('#app')
