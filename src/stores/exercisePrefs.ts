import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

/**
 * 训练偏好（界面级偏好，localStorage `rein.exercisePrefs.v1`，不进 SQLite ——
 * 与功能开关 / Dock 落点同一档：换设备重配也无所谓的那种）。
 *
 * 现在只有「准备时长」：每组开始前「准备姿势」的倒计时秒数。训练气泡
 * （SessionStageBubble）与设置页的训练卡共用这一份，改完下一组立即生效。
 */

export const PREP_SEC_DEFAULT = 5
export const PREP_SEC_MIN = 1
export const PREP_SEC_MAX = 30

const STORE_KEY = 'rein.exercisePrefs.v1'

function clamp(v: number): number {
  if (!Number.isFinite(v)) return PREP_SEC_DEFAULT
  return Math.min(PREP_SEC_MAX, Math.max(PREP_SEC_MIN, Math.round(v)))
}

function load(): number {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { prepSec?: unknown }
      if (typeof parsed.prepSec === 'number') return clamp(parsed.prepSec)
    }
  } catch {
    /* 损坏 / 不可用即回落默认，不让一条坏 JSON 挡住训练 */
  }
  return PREP_SEC_DEFAULT
}

export const useExercisePrefs = defineStore('exercisePrefs', () => {
  const prepSec = ref(load())

  watch(prepSec, (v) => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ prepSec: clamp(v) }))
    } catch {
      /* localStorage 不可用时退化为内存态 */
    }
  })

  return { prepSec }
})
