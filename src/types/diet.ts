/** 饮食域类型 · 与 Rust `modules/diet` 的模型一一对应 */

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack'
export type QuantityMode = 'grams' | 'unit'
export type LogSource = 'photo_ai' | 'text_ai' | 'search' | 'manual'

export interface FoodUnit {
  /** 份名：碗 / 个 / 根 / 杯 … */
  name: string
  /** 该一份对应的克重 */
  grams: number
}

/** 食物（营养值均为每 100g） */
export interface Food {
  id: number
  name: string
  category: string | null
  kcal: number
  protein: number
  carb: number
  fat: number
  fiber: number
  sugar: number
  sodiumMg: number
  potassiumMg: number
  calciumMg: number
  ironMg: number
  zincMg: number
  magnesiumMg: number
  vitAUg: number
  vitCMg: number
  vitDUg: number
  vitEMg: number
  vitB12Ug: number
  folateUg: number
  defaultUnit: string | null
  units: FoodUnit[]
}

/** 饮食库筛选条件（均为每 100g 口径；null = 不限） */
export interface FoodFilter {
  kcalMin: number | null
  kcalMax: number | null
  /** 蛋白质至少 N g */
  proteinMin: number | null
  /** 碳水化合物至多 N g */
  carbMax: number | null
  /** 脂肪至多 N g */
  fatMax: number | null
  /** 钠至多 N mg */
  sodiumMax: number | null
}

export interface MealLog {
  id: number
  foodId: number
  /** YYYY-MM-DD（本地时区） */
  date: string
  mealType: MealType
  quantityMode: QuantityMode
  /**
   * 不变量：grams 恒为换算后的克重（unit 模式 = 份数 × 份克重），
   * 后端聚合只依赖该字段；units / unitName 仅用于展示。
   */
  grams: number
  units: number | null
  unitName: string | null
  source: LogSource
  note: string | null
  createdAt: string
  /** 列表查询时由后端 join 返回 */
  food?: Food
}

export interface MealLogInput {
  foodId: number
  date: string
  mealType: MealType
  quantityMode: QuantityMode
  grams: number
  units?: number | null
  unitName?: string | null
  source: LogSource
  note?: string | null
}

export interface MealLogUpdateInput {
  foodId: number
  date: string
  mealType: MealType
  quantityMode: QuantityMode
  grams: number
  units?: number | null
  unitName?: string | null
  note?: string | null
}

/** 新建自定义食品入参（营养为每 100g；AI create_food 工具与后续 UI 共用） */
export interface FoodCreateInput {
  name: string
  category: string | null
  kcal: number
  protein: number
  carb: number
  fat: number
  fiber?: number
  sugar?: number
  sodiumMg?: number
  defaultUnit: string | null
  units: FoodUnit[]
}

export interface FoodCreateResult {
  /** 库内食品（新建的，或同名既有记录） */
  food: Food
  /** false = 库里已有同名，food 是既有记录 */
  created: boolean
}

/** 食谱偏好（食谱库 / AI 生成 / 方案引擎选菜共用）：1=喜欢 -1=不喜欢 */
export interface RecipePref {
  recipeId: string
  rating: 1 | -1
  updatedAt: string
}
