import { ListTodo, Sparkles } from 'lucide-vue-next'

import { definePlugin } from '../registry'

/**
 * 内核插件：功能固定开启（不进「打开或关闭功能」），但同样走插件层声明自己的
 * 导航条目与工具卡——这样导航栏、主页工具格只有一条数据来源，没有第二份硬编码清单。
 *
 * 留在内核的是**应用主轴**：待办（画布 / 时间线 / 主页信息流的宿主，AI 的 todo 组
 * 也是常驻组）与 AI（对话页是右独立圆钮的落点，知识库是统一检索面）。其余内容域
 * 都已拆成可开关的模块，各自一个文件：营养 / 记账 / 专注 / 语音 / 录音 / 同步，
 * 加上先前的 运动 / 课表 / 抢课 / 健康方案。
 */

export const aiPlugin = definePlugin({
  id: 'ai',
  name: 'AI',
  desc: '对话、拍照识别与知识库',
  icon: Sparkles,
  accent: '--mod-ai',
  routes: [
    'ai',
    'ai-models',
    'ai-knowledge',
    'ai-knowledge-files',
    'ai-files',
    'ai-files-usage',
    'ai-files-usage-large',
  ],
  // 移动端 Dock 的 AI 是**右独立圆钮**（内核落点，由 TabBar 自己声明）；插件层只管导航轨
  nav: [{ route: 'ai', label: 'AI', icon: Sparkles, surfaces: ['rail'], order: 170 }],
  tools: [
    {
      id: 'ai.chat',
      title: 'AI 助手',
      sub: '提问 · 拍照识别',
      icon: Sparkles,
      ic: {
        background: 'var(--mod-ai-soft)',
        color: 'var(--mod-ai-strong)',
      },
      order: 50,
      to: { name: 'ai' },
    },
  ],
})

export const todoPlugin = definePlugin({
  id: 'todos',
  name: '待办',
  desc: '今日画布、周时间线与清单',
  icon: ListTodo,
  accent: '--mod-todo',
  routes: ['todos'],
  nav: [{ route: 'todos', label: '待办', icon: ListTodo, surfaces: ['rail'], order: 150 }],
})
