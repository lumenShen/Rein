import { createApp } from 'vue'

import FloatApp from './FloatApp.vue'

// 与主窗口完全同源的四份全局样式 / 运行时：
//  · tokens.css —— 颜色 / 圆角 / 字号 / 动效令牌，浮条材质靠它；
//  · base.css  —— reset、.glass-surface、.num / .row / .col 这些浮条内容用到的全局类；
//  · system/perf、system/motion —— 读同一个 localStorage（同一份 origin 存储）写出
//    <html data-perf / data-motion>，首帧就是主窗口那一档；载荷到达后再校正。
// 刻意**不** import App.vue / router / pinia：这一页是独立窗口，不该把整个应用拖进来。
import '@/styles/tokens.css'
import '@/styles/base.css'
import '@/system/perf'
import '@/system/motion'
import './float.css'

createApp(FloatApp).mount('#float-app')
