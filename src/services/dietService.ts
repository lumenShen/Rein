/** 饮食域 IPC 封装 · 命令名与 src-tauri/src/modules/diet/commands.rs 一一对应 */

import type { Food, FoodCreateInput, FoodCreateResult, MealLog, MealLogInput, MealLogUpdateInput, RecipePref } from '@/types'
import { invoke } from './transport'

export const dietService = {
  listFoods: (query?: string, category?: string | null, limit = 60) =>
    invoke<Food[]>('list_foods', { query: query ?? null, category: category ?? null, limit }),

  /** 模糊搜索：按名称相似度（字包含 + 顺序）排序，算法在 Rust 层 */
  searchFoodsFuzzy: (query: string, limit = 20) =>
    invoke<Food[]>('search_foods_fuzzy', { query: query || null, limit }),

  getFood: (id: number) => invoke<Food | null>('get_food', { id }),

  /** 新建自定义食品；库里已有同名时返回既有记录（created=false） */
  createFood: (food: FoodCreateInput) => invoke<FoodCreateResult>('create_food', { food }),

  listMeals: (date: string) => invoke<MealLog[]>('list_meals', { date }),

  /** 历史区间查询：闭区间 [startDate, endDate]，日期降序 */
  listMealsRange: (startDate: string, endDate: string) =>
    invoke<MealLog[]>('list_meals_range', { startDate, endDate }),

  logMeal: (input: MealLogInput) => invoke<MealLog>('log_meal', { ...input }),

  updateMeal: (id: number, input: MealLogUpdateInput) =>
    invoke<MealLog>('update_meal', { id, input }),

  deleteMeal: (id: number) => invoke<void>('delete_meal', { id }),

  /* ---- 食谱偏好 ---- */

  recipePrefsList: () => invoke<RecipePref[]>('recipe_prefs_list'),

  setRecipePref: (recipeId: string, rating: 1 | -1) =>
    invoke<RecipePref>('recipe_prefs_set', { input: { recipeId, rating } }),

  recipePrefsClear: (recipeId: string) => invoke<void>('recipe_prefs_delete', { recipeId }),
}
