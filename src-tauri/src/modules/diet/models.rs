//! 饮食域数据模型 · 与前端 `src/types/diet.ts` 一一对应（serde camelCase）。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoodUnit {
    pub name: String,
    pub grams: f64,
}

/// 食物（营养值均为每 100g）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Food {
    pub id: i64,
    pub name: String,
    pub category: Option<String>,
    pub kcal: f64,
    pub protein: f64,
    pub carb: f64,
    pub fat: f64,
    pub fiber: f64,
    pub sugar: f64,
    pub sodium_mg: f64,
    pub potassium_mg: f64,
    pub calcium_mg: f64,
    pub iron_mg: f64,
    pub zinc_mg: f64,
    pub magnesium_mg: f64,
    pub vit_a_ug: f64,
    pub vit_c_mg: f64,
    pub vit_d_ug: f64,
    pub vit_e_mg: f64,
    pub vit_b12_ug: f64,
    pub folate_ug: f64,
    pub default_unit: Option<String>,
    #[serde(default)]
    pub units: Vec<FoodUnit>,
}

/// 新建自定义食品入参（营养为每 100g；微量营养素缺省 0，暂不开放给 AI 填写）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoodCreateInput {
    pub name: String,
    pub category: Option<String>,
    pub kcal: f64,
    pub protein: f64,
    pub carb: f64,
    pub fat: f64,
    #[serde(default)]
    pub fiber: f64,
    #[serde(default)]
    pub sugar: f64,
    #[serde(default)]
    pub sodium_mg: f64,
    pub default_unit: Option<String>,
    #[serde(default)]
    pub units: Vec<FoodUnit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoodCreateResult {
    /// 新建的食品；或同名既有记录
    pub food: Food,
    /// false = 库里已有同名，food 是既有记录
    pub created: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MealLog {
    pub id: i64,
    pub food_id: i64,
    /// YYYY-MM-DD（本地时区）
    pub date: String,
    pub meal_type: String,
    pub quantity_mode: String,
    /// 不变量：恒为换算后的克重；units/unit_name 仅用于展示
    pub grams: f64,
    pub units: Option<f64>,
    pub unit_name: Option<String>,
    pub source: String,
    pub note: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub food: Option<Food>,
}

/// 食谱偏好（食谱库 / AI 生成 / 方案引擎选菜共用）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MealLogUpdateInput {
    pub food_id: i64,
    pub date: String,
    pub meal_type: String,
    pub quantity_mode: String,
    pub grams: f64,
    pub units: Option<f64>,
    pub unit_name: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipePref {
    pub recipe_id: String,
    /// 1 = 喜欢，-1 = 不喜欢
    pub rating: i64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipePrefInput {
    pub recipe_id: String,
    /// 1 = 喜欢，-1 = 不喜欢
    pub rating: i64,
}
