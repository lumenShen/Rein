/**
 * 训练会话工具集（独立工具集，`ToolGroup = 'session'`）。
 *
 * 只服务「正在进行的那一场」，与课程库（`tools/plan.ts`）、运动记录（`tools/exercise.ts`）
 * 是两个不同的作用域：这里写入的一切只活在内存里的这一场会话 + 中断恢复快照，
 * 课程模板一个字都不动 —— 反过来也一样。
 *
 * 三块按「看不看现场 / 动不动流程 / 动不动结构」拆开：
 *  read    —— 看清现场（相位、动作清单、推荐重量、热身处方）
 *  adjust  —— 动这一组与流程（重量、次数、完成、跳过、加练、回退、休息、跳组）
 *  arrange —— 动这一场的编排（换动作、插入、删除、改组数次数休息）
 */

import type { AppTool } from '../types'
import { sessionAdjustTools } from './adjust'
import { sessionArrangeTools } from './arrange'
import { sessionReadTools } from './read'

export const sessionTools: AppTool[] = [
  ...sessionReadTools,
  ...sessionAdjustTools,
  ...sessionArrangeTools,
]
