/**
 * 灵动气泡 · 时序与 spring 参数（唯一一份）。
 *
 * 三段交错（与 `scratch/spring-bubble` 实验室完全同一套数字，改这里两端一起变）：
 *   0.00s  旧内容 blur + 缩小 + 淡出    300ms
 *   0.30s  spring 把 width / height 送到新尺寸   ~400ms
 *   0.50s  新内容 blur + 缩小 + 淡入     200ms
 *
 * spring 选 duration + bounce 而不是物理三件套：`duration` 直接就是「感知多久停下」，
 * `bounce` 是过冲幅度，这两个量与「灵动但不轻浮」的判断一一对应；
 * 物理参数（stiffness / damping / mass）要三个一起调才行，product 侧没有这个必要。
 */
export const BUBBLE_SPRING = { duration: 400, bounce: 0.22 } as const

/** 旧内容淡出（ms） */
export const BUBBLE_OUT_MS = 300
/** spring 开始后多久新内容进场（ms） */
export const BUBBLE_IN_DELAY_MS = 200
/** 新内容淡入（ms） */
export const BUBBLE_IN_MS = 200

/** 准备姿势时长（秒）：给用户摆好位、握好杠的时间 */
export const PREPARE_SEC = 5
