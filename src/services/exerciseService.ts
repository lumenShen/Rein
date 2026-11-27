/** 运动域 IPC 封装 · 对应 modules/exercise/commands.rs */

import type { Workout, WorkoutInput, WorkoutUpdateInput } from '@/types'
import { invoke } from './transport'

export const exerciseService = {
  listWorkouts: (startDate: string, endDate: string) =>
    invoke<Workout[]>('list_workouts', { startDate, endDate }),

  listAllWorkouts: () => invoke<Workout[]>('list_all_workouts'),

  createWorkout: (input: WorkoutInput) =>
    invoke<Workout>('create_workout', {
      name: input.name,
      // IPC 参数用 workoutType（避免与 JS 保留字 / Rust r#type 的转换问题）
      workoutType: input.type,
      date: input.date,
      startMin: input.startMin ?? null,
      durationMin: input.durationMin,
      intensity: input.intensity ?? null,
      effort: input.effort ?? null,
      kcal: input.kcal,
      note: input.note ?? null,
    }),

  updateWorkout: (id: number, input: WorkoutUpdateInput) =>
    invoke<Workout>('update_workout', { id, input }),

  deleteWorkout: (id: number) => invoke<void>('delete_workout', { id }),
}
