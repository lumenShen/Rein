import { BookOpen, Camera, ChefHat, History, Utensils } from 'lucide-vue-next'

import { definePlugin } from '../registry'

/**
 * 营养模块：记饮食、食物库、食谱库与营养全览（可开关，见「打开或关闭功能」）。
 *
 * 关闭的语义 = 营养界面整片收起：四张工具卡、导航轨条目与四条营养路由一起消失，
 * 主页页脚的「吃」卡随成员清空而整块不渲染，桌面便当收掉对应的三块，数据原样保留。
 *
 * **AI 侧的饮食卡协议刻意不挂本插件**（`ai/tools/registry.ts` 的 diet / nutrition 两组
 * 仍是常驻组）：食物卡是 AI 域的核心链路 —— 提示词里的【食物记录的分寸】【food 卡约定】
 * 【输出】三段是**无条件**下发的，把工具摘掉只会让模型读得到用法却调不到工具（空转）。
 * 换言之，本插件管的是「营养的界面与入口」，不是「AI 能不能记饮食」。
 */
export const nutritionPlugin = definePlugin({
  id: 'nutrition',
  name: '营养',
  desc: '记饮食、食物库与营养全览',
  icon: Utensils,
  accent: '--mod-nutrition',
  toggleable: true,
  defaultEnabled: true,
  routes: ['nutrition', 'nutrition-adjust', 'nutrition-foods', 'nutrition-recipes'],
  nav: [{ route: 'nutrition', label: '营养', icon: Utensils, surfaces: ['rail'], order: 110 }],
  tools: [
    {
      id: 'nutrition.smart-add',
      title: '记饮食',
      sub: '拍照 / 文字 · AI 帮你记',
      icon: Camera,
      ic: {
        background: 'var(--mod-nutrition-soft)',
        color: 'var(--mod-nutrition-strong)',
      },
      order: 10,
      action: 'smart-add',
    },
    // 查阅三件套：主页页脚的「吃」卡把它们与记饮食并列成同权成员（此前是页脚边上的
    // 三颗小 chip，低到近乎看不见）。声明在插件层，关掉营养模块时四件一起消失。
    {
      id: 'nutrition.foods',
      title: '饮食库',
      sub: '按食物查营养',
      icon: BookOpen,
      ic: {
        background: 'var(--mod-nutrition-soft)',
        color: 'var(--mod-nutrition-strong)',
      },
      order: 11,
      to: { name: 'nutrition-foods' },
    },
    {
      id: 'nutrition.recipes',
      title: '食谱库',
      sub: '按菜谱做一顿',
      icon: ChefHat,
      ic: {
        background: 'var(--mod-nutrition-soft)',
        color: 'var(--mod-nutrition-strong)',
      },
      order: 12,
      to: { name: 'nutrition-recipes' },
    },
    {
      id: 'nutrition.history',
      title: '饮食历史',
      sub: '往日吃了什么',
      icon: History,
      ic: {
        background: 'var(--mod-nutrition-soft)',
        color: 'var(--mod-nutrition-strong)',
      },
      order: 13,
      action: 'diet-history',
    },
  ],
})
