/**
 * e2e 共用的「功能开关预置」。
 *
 * 抢课（`campus-grab`）是课表的**子模块且默认关闭**（见 `src/plugins/builtin/campusGrab.ts`），
 * 而抢课/选课类的 e2e 剧本都直接落在抢课页上 —— 不先点亮开关，路由守卫会把它们
 * 全部拦回主页，断言会以一堆看不懂的方式失败。
 *
 * 注入时机必须是**页面脚本之前**：`features` store 在应用启动时就把 localStorage
 * 读进内存了，导航进页面之后再写它不会生效。所以走 CDP 的
 * `Page.addScriptToEvaluateOnNewDocument`，而不是页面里的 `evalJS`。
 */

/** 只开抢课（课表默认就是开的，不必写） */
export const GRAB_PLUGIN_ON = `localStorage.setItem('rein.features.v1', JSON.stringify({ 'campus-grab': true }))`

/**
 * 在导航之前把开关预置好。调用点：`cdp('Runtime.enable')` 之后、`Page.navigate` 之前。
 *
 * @param {(method: string, params?: object) => Promise<unknown>} cdp 各剧本自己的 CDP 封装
 */
export async function presetFeatureFlags(cdp) {
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: GRAB_PLUGIN_ON })
}

/**
 * 在导航之前把导航布局预置好（`rein.navLayout.v1`，见 `src/stores/navLayout.ts`）。
 * 与 presetFeatureFlags 同一条时机纪律：navLayout store 在应用启动时就读了 localStorage，
 * 进页面之后再写它不会生效，必须走 `Page.addScriptToEvaluateOnNewDocument`。
 *
 * @param {(method: string, params?: object) => Promise<unknown>} cdp 各剧本自己的 CDP 封装
 * @param {{ tabbar?: string[], rail?: string[], topbar?: string[] }} payload
 *   各容器的有序 id（tabbar/rail = 路由名，topbar = 按钮 id）；未给的容器按目录缺省渲染
 */
export async function presetNavLayout(cdp, payload) {
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('rein.navLayout.v1', JSON.stringify(${JSON.stringify({ v: 1, ...payload })}))`,
  })
}
