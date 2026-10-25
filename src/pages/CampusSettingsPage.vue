<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { BookOpen, CalendarClock, ChevronRight, CircleCheck, CircleAlert, FileDown, LogOut, RefreshCw, School, Sparkles, Trash2 } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import { campusService } from '@/services/campusService'
import { isSessionLostMessage, useCampusStore } from '@/stores/campus'
import { useFeaturesStore } from '@/stores/features'
import type { AiAction, HolidayConfigView, SchoolSystemInfo } from '@/types'

const store = useCampusStore()
const router = useRouter()
const toast = useToast()
// 选课/抢课是课表的子模块（默认关闭）：入口显隐问功能开关
const features = useFeaturesStore()

/* ---------------- 学校系统选择器 ---------------- */

const picked = ref<SchoolSystemInfo | null>(null)
const baseUrl = ref('')

const activeSystem = computed(
  () => picked.value ?? store.systems.find((s) => s.kind === store.account?.systemKind) ?? store.systems[0] ?? null,
)

function pickSystem(s: SchoolSystemInfo): void {
  picked.value = s
  baseUrl.value = s.defaultBaseUrl
  captchaSrc.value = ''
  needCaptcha.value = false
}

/* ---------------- 登录表单 ---------------- */

const loginName = ref('')
const password = ref('')
const captcha = ref('')
const savePassword = ref(true)
const needCaptcha = ref(false)
const captchaSrc = ref('')
/**
 * 表单里的错误。登录是一步错就彻底卡住的操作，**不能只靠 toast** ——
 * 它两秒就没了，用户回头想看清楚失败原因时已经找不到，只能反复试。
 */
const loginError = ref('')
/** 必须去网页端处理的（首次登录改密 / 口令过弱），单独透出给一句带链接的引导 */
const loginAction = ref<string | null>(null)
/**
 * 会话过期。此时 `account.loggedIn` 可能仍为 true（Cookie 还在，只是教务不认了），
 * 光看它会连登录表单都显示不出来，所以用这个标志把表单请回来。
 */
const sessionLost = ref(false)

/** 会话过期且存过密码：密码可以留空 —— 后端会用存下的那份重登（见 Rust `relogin`） */
const canUseSavedPassword = computed(() => sessionLost.value && !!store.account?.hasPassword)

/**
 * 当前选的是正方（ZFSoft）那一套吗。
 *
 * 两家的验证码时机不同，UI 要跟着变：树维**随时可能要**（登录响应里直接说 needCaptcha），
 * 正方是**错够几次才要**，而且失败页里看不出这个要求 —— 所以正方要多一个人工入口。
 */
const isZfsoft = computed(() => activeSystem.value?.loginStrategy === 'zfsoft-login-rsa')

const canLogin = computed(
  () =>
    !!activeSystem.value &&
    loginName.value.trim() !== '' &&
    (password.value !== '' || canUseSavedPassword.value) &&
    !store.loggingIn,
)

// 用户一动手改输入，就把上一次的失败提示收起来（否则他会以为改完还是这个错）。
// 刻意不盯验证码框：登录失败后 `refreshCaptcha()` 会清空它，那是程序自己动的，
// 跟着清会把「验证码不正确」这句话一闪就抹掉。
watch([loginName, password], () => {
  loginError.value = ''
  loginAction.value = null
})

function refreshCaptcha(): void {
  const sys = activeSystem.value
  if (!sys) return
  void (async () => {
    try {
      const b64 = await campusService.captcha(sys.kind, baseUrl.value.trim(), loginName.value.trim())
      captchaSrc.value = `data:image/jpeg;base64,${b64}`
      needCaptcha.value = true
      captcha.value = ''
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : '获取验证码失败')
    }
  })()
}

async function onLogin(): Promise<void> {
  const sys = activeSystem.value
  if (!sys) return
  loginError.value = ''
  loginAction.value = null
  try {
    const outcome = await store.login({
      systemKind: sys.kind,
      baseUrl: baseUrl.value.trim(),
      loginName: loginName.value.trim(),
      // 密码不做任何 trim：桂电的密码末尾的点是密码的一部分，去掉就登不上
      password: password.value,
      captcha: captcha.value,
      savePassword: savePassword.value,
    })

    if (outcome.ok) {
      sessionLost.value = false
      toast.toast(`已登录${outcome.account?.studentName ? ` · ${outcome.account.studentName}` : ''}`)
      password.value = ''
      captcha.value = ''
      needCaptcha.value = false
      captchaSrc.value = ''
      // 登录完顺手把课表拉下来 —— 用户登进来就是为了看课表
      await onSync()
      return
    }

    // 失败：把原因**留在表单里**。后端保证这里一定有话可说（见 `guet::login_failure`）
    loginError.value = outcome.message ?? '登录失败，请重试'
    loginAction.value = outcome.actionRequired
    if (outcome.needCaptcha) refreshCaptcha()
  } catch (e) {
    loginError.value = e instanceof Error ? e.message : '登录失败'
  }
}

/* ---------------- 同步 ---------------- */

const syncHint = computed(() => {
  const a = store.account
  if (!a?.lastSyncAt) return '还没有同步过'
  const r = store.lastSync
  const tail = r ? ` · ${r.courses} 门课 / ${r.sessions} 个时段` : ''
  return `上次同步：${new Date(a.lastSyncAt).toLocaleString('zh-CN')}${tail}`
})

async function onSync(): Promise<void> {
  try {
    const r = await store.sync()
    sessionLost.value = false
    toast.toast(`${r.semesterName}：写入 ${r.todosWritten} 条时间线日程`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : '同步失败'
    // 会话过期：把登录表单请出来。存了密码的账号后端已经自动重登过一轮了，
    // 走到这里说明那一轮也没成（多半是没存密码），只能用户亲手上。判据优先看错误码
    if (isSessionLostMessage(e)) sessionLost.value = true
    toast.toast(msg)
  }
}

async function onSemesterChange(id: number): Promise<void> {
  try {
    await store.setCurrentSemester(id)
    toast.toast('已切换学期，时间线已重建')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '切换学期失败')
  }
}

/* ---------------- 二级抽屉：学期 / 调休纠正 / AI 记录 ---------------- */

/**
 * 这一页的列表**不走折叠、也不走原生下拉**：学期、调休纠正、AI 记录
 * 都收进二级抽屉（SheetModal）里摊开列举，页面本体只留入口行。
 * 原生 `<select>` 是一份折叠起来的列表 —— 选项互相看不见、没法比较；
 * 长列表平铺又会把设置页撑成一条望不到底的长卷。抽屉两者都避开。
 */
const semOpen = ref(false)
const holidayOpen = ref(false)
const auditOpen = ref(false)

function pickSemester(id: number): void {
  semOpen.value = false
  void onSemesterChange(id)
}

/* ---------------- 账号管理 ---------------- */

const confirmOpen = ref(false)
// 取消由 ActionSheet 自己那颗「取消」承担，清单里不再重复一条
const dangerActions = [{ label: '删除账号并清除课表日程', value: 'delete', danger: true }]

async function onDanger(value: string): Promise<void> {
  confirmOpen.value = false
  if (value !== 'delete') return
  try {
    await store.removeAccount()
    toast.toast('账号与课表日程已清除')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '删除失败')
  }
}

async function onLogout(): Promise<void> {
  try {
    await store.logout()
    toast.toast('已退出登录，课表保留为只读快照')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '退出失败')
  }
}

/* ---------------- AI 操作记录 ---------------- */

/** AI 操作记录的完整说明：卡面只留一行结论，其余（含「重放」的人话解释）收进标题行 InfoHint */
const auditHint =
  '点抢课页的「交给 AI 排查」后，AI 对教务系统与抢课任务做过的每一步都会记在这里，可以逐条回看。' +
  '\n\n记录包括 AI 发出的请求、重排抢课任务、重新登录、导出脚本这些操作。' +
  '\n\n导出的脚本会把这一路的请求原样整理成命令：不打开本软件，也能在别处把这些请求重新执行一遍，用来核对或排查。'

const audit = ref<AiAction[]>([])
const auditBusy = ref(false)
const exportBusy = ref(false)
/** 记录里的时刻：只给到分钟 —— 一口气看二十条时，秒没有意义 */
function shortAt(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function loadAudit(): Promise<void> {
  auditBusy.value = true
  try {
    // probe=false：这里只看落库的现场，不该因为打开设置页就打一次教务
    const st = await campusService.rescueState(false)
    audit.value = st.recentActions
  } catch {
    /* 读不到就不显示：它只是记录，不该在设置页弹错误 */
  } finally {
    auditBusy.value = false
  }
}

async function onExportScript(): Promise<void> {
  exportBusy.value = true
  try {
    const out = await campusService.curlExport({ hours: 24 })
    toast.toast(`已导出 ${out.count} 条请求 → ${out.path}`)
    await loadAudit()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '导出失败')
  } finally {
    exportBusy.value = false
  }
}

/* ---------------- 官方调休映射 ---------------- */

/** 调休卡面的完整解释：卡面只留一行结论，其余收进标题行右侧的 InfoHint */
const holidayHint =
  '法定放假日会在课表与时间线上标「假」；补班日会把被补那天的课一并显示，并标「调」。' +
  '\n\n数据来自公开的 holiday-cn 校历库；补哪一天由规律推断，逐日纠正收在下面的二级页里。'

/**
 * 开关 + 按日期的手动覆盖。这里**不做前端推断** —— 后端才是映射的唯一真源
 * （课表页与首页时间线都要生效），前端只负责把用户的纠正回写。
 */
const holidayView = ref<HolidayConfigView | null>(null)
const holidayEnabled = ref(true)
const holidayBusy = ref(false)
/** 新增覆盖用的草稿：日期 + 补星期几 */
const holidayDraftDate = ref('')
const holidayDraftWeekday = ref(3)

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 当前生效的补班映射，按日期升序（含被覆盖为「不补课」的行） */
const holidayRows = computed(() =>
  Object.entries(holidayView.value?.makeups ?? {})
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, weekday]) => ({ date, weekday })),
)

async function loadHoliday(): Promise<void> {
  try {
    const v = await campusService.holidayConfigGet()
    holidayView.value = v
    holidayEnabled.value = v.enabled
  } catch {
    // 数据源不可达不该打断设置页：保留上一次的值，用户仍可改开关
  }
}

async function persistHoliday(patch: { enabled?: boolean; overrides?: Record<string, number> }): Promise<void> {
  if (holidayBusy.value) return
  holidayBusy.value = true
  try {
    await campusService.holidayConfigSet({
      enabled: patch.enabled ?? holidayEnabled.value,
      overrides: patch.overrides ?? holidayView.value?.overrides ?? {},
    })
    await loadHoliday()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '保存调休映射失败')
  } finally {
    holidayBusy.value = false
  }
}

function onHolidayToggle(v: boolean): void {
  holidayEnabled.value = v
  void persistHoliday({ enabled: v })
}

/** 改某一天补星期几；`0` = 该日不补课 */
function onHolidayWeekday(date: string, weekday: number): void {
  void persistHoliday({ overrides: { ...(holidayView.value?.overrides ?? {}), [date]: weekday } })
}

function onHolidayAdd(): void {
  const date = holidayDraftDate.value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    toast.toast('请先选择日期')
    return
  }
  void persistHoliday({ overrides: { ...(holidayView.value?.overrides ?? {}), [date]: holidayDraftWeekday.value } })
  holidayDraftDate.value = ''
}

onMounted(async () => {
  await store.init()
  void loadAudit()
  void loadHoliday()
  const a = store.account
  if (a) {
    loginName.value = a.loginName
    baseUrl.value = a.baseUrl
  } else if (activeSystem.value) {
    baseUrl.value = activeSystem.value.defaultBaseUrl
  }
})
</script>

<template>
  <div class="page">
    <PageHeader title="课表配置与设置" subtitle="绑定学校教务系统后自动同步课表" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 桌面栅格：壳层只把 .page 的**直接子项**摊成两栏，而这一页里有两张卡
         需要通栏（见 .desk-main 那段注释），所以自带一层 .d-grid 承接。
         手机端它只是个普通 div，块流与卡片间距都不变 -->
    <div class="d-grid set-grid">
    <!-- ① 学校系统选择器（抽象层的 UI 出口） -->
    <section class="card">
      <div class="sec-head">
        <School :size="17" />
        <h2>学校系统</h2>
      </div>
      <ul class="sys-list">
        <li v-for="s in store.systems" :key="s.kind">
          <button class="sys" :class="{ on: activeSystem?.kind === s.kind }" @click="pickSystem(s)">
            <div class="sys-main">
              <span class="sys-name">{{ s.name }}</span>
              <span class="sys-vendor">{{ s.vendor }}</span>
            </div>
            <CircleCheck v-if="activeSystem?.kind === s.kind" :size="18" class="tick" />
          </button>
        </li>
      </ul>

      <label class="flabel">服务地址</label>
      <input v-model="baseUrl" type="url" class="mono" autocomplete="off" spellcheck="false" />
      <p class="tip">
        {{ activeSystem?.baseUrlHint }}
        <template v-if="activeSystem?.bizTypeId">业务类型：本科生。</template>
      </p>
    </section>

    <!-- ② 登录 / 账号状态 -->
    <section class="card">
      <div class="sec-head">
        <CircleCheck v-if="store.account?.loggedIn" :size="17" class="ok" />
        <CircleAlert v-else :size="17" class="warn" />
        <h2>{{ store.account?.loggedIn ? '已登录' : '登录教务系统' }}</h2>
      </div>

      <div v-if="store.account" class="who">
        <p class="who-name">
          {{ store.account.studentName ?? store.account.loginName }}
          <span class="who-code">{{ store.account.studentCode ?? store.account.loginName }}</span>
        </p>
        <p v-if="store.account.department" class="who-line">
          {{ store.account.department }}<template v-if="store.account.major"> · {{ store.account.major }}</template>
        </p>
        <!-- 拆主次：行政班号是这一行的关键值（等宽数字、加重），年级降级为次要项。
             学分不在这一行重复 —— 它只留在下面「培养方案与选课」入口行 -->
        <p v-if="store.account.adminclass" class="who-line">
          行政班 <b class="num">{{ store.account.adminclass }}</b><template v-if="store.account.grade"><span class="wsep" aria-hidden="true">|</span><span class="wsub">{{ store.account.grade }} 级</span></template>
        </p>
        <p class="who-line dim">
          <template v-if="sessionLost">会话已过期，需要重新登录</template>
          <template v-else-if="store.account.sessionAt">
            会话确认于 {{ new Date(store.account.sessionAt).toLocaleString('zh-CN') }}
          </template>
          <template v-else>会话未确认</template>
          <template v-if="!store.account.hasPassword"> · 未保存密码，过期后需重新登录</template>
        </p>
      </div>

      <template v-if="!store.account?.loggedIn || sessionLost">
        <!-- 会话过期时的引导：存了密码就别让人再输一遍 -->
        <p v-if="sessionLost" class="banner">
          <CircleAlert :size="14" />
          <span>
            教务会话已过期。
            <template v-if="store.account?.hasPassword">密码已保存，直接点「重新登录」就行，不用重新输入。</template>
            <template v-else>请重新输入密码登录一次。</template>
          </span>
        </p>

        <label class="flabel">学号</label>
        <input v-model="loginName" type="text" inputmode="numeric" autocomplete="username" placeholder="学号" />

        <label class="flabel">密码</label>
        <input v-model="password" type="password" autocomplete="current-password" placeholder="教务系统密码" />
        <p class="tip">密码区分大小写，<b>结尾的符号也要原样输入</b>（不会被自动去除）。</p>

        <!-- 正方的验证码是「错够几次才要」，而登录失败页里**看不到**这个要求
             （没有验证码输入框的痕迹，只有一句提示文字）。所以给一个人工出口：
             教务一旦要求验证码，用户在这里就能把输入框请出来，而不是卡死。 -->
        <button v-if="isZfsoft && !needCaptcha" class="cap-link" @click="refreshCaptcha">
          教务提示需要验证码？点这里获取
        </button>

        <template v-if="needCaptcha">
          <label class="flabel">验证码</label>
          <div class="cap-row">
            <input v-model="captcha" type="text" class="cap-input" autocomplete="off" placeholder="图中字符" />
            <button class="cap-img" aria-label="刷新验证码" @click="refreshCaptcha">
              <img v-if="captchaSrc" :src="captchaSrc" alt="验证码" />
              <RefreshCw v-else :size="16" />
            </button>
          </div>
        </template>

        <label class="check">
          <input v-model="savePassword" type="checkbox" />
          <span>保存密码（会话过期后可自动重登）</span>
        </label>

        <button class="primary" :disabled="!canLogin" @click="onLogin">
          {{ store.loggingIn ? '登录中…' : canUseSavedPassword && password === '' ? '重新登录' : '登录' }}
        </button>

        <!-- 失败原因留在表单里：toast 会消失，而它要提醒你去解决的问题不会 -->
        <p v-if="loginError" class="form-err">
          <CircleAlert :size="14" />
          <span>{{ loginError }}</span>
        </p>
        <p v-if="loginAction" class="form-hint">
          这一条只能在教务网页端处理：<a :href="baseUrl" target="_blank" rel="noreferrer">{{ baseUrl }}</a>，
          处理完回来再登录。
        </p>
      </template>

      <div v-else class="acts">
        <button class="ghost" :disabled="store.syncing" @click="onSync">
          {{ store.syncing ? '同步中…' : '重新同步' }}
        </button>
        <button class="ghost" @click="onLogout">
          <LogOut :size="15" /> 退出登录
        </button>
      </div>
    </section>

    <!-- ③ 课表同步 -->
    <section v-if="store.account" class="card">
      <div class="sec-head">
        <RefreshCw :size="17" />
        <h2>课表同步</h2>
      </div>

      <!-- 学期列举在二级抽屉里（不用原生 select）：一屏放得下名字与起止周，
           互相看得见才好比较；下拉框把其余学期全折起来，反而要靠记忆选 -->
      <label class="flabel">当前学期</label>
      <button class="link-row" type="button" :disabled="store.syncing" @click="semOpen = true">
        <span>
          {{ store.semester?.name ?? '选择学期' }}
          <em v-if="store.semester">
            {{ store.semester.startDate }} ~ {{ store.semester.endDate }} · {{ store.semester.totalWeeks }} 周
          </em>
        </span>
        <ChevronRight :size="18" />
      </button>

      <!-- 同步时间戳要能看清（用户点进来就是确认课表新不新）：caption + text-2，数字等宽 -->
      <p class="tip sync-hint">{{ syncHint }}</p>

      <button class="primary" :disabled="store.syncing" @click="onSync">
        {{ store.syncing ? '同步中…' : '立即同步' }}
      </button>
      <p class="tip">
        同步会把课表写进时间线（过去一周 + 未来五周）。已打勾的历史日程不会被覆盖。
      </p>
    </section>

    <!-- ④ 培养方案与选课（入口按教务系统的能力位显隐，两样都没有的整套隐藏） -->
    <section
      v-if="store.account && (store.capabilities.program || store.capabilities.courseSelect)"
      class="card"
    >
      <div class="sec-head">
        <BookOpen :size="17" />
        <h2>培养方案与选课</h2>
      </div>
      <button
        v-if="store.capabilities.program"
        class="link-row"
        @click="router.push({ name: 'campus-program' })"
      >
        <span>
          查看培养方案与学分完成度
          <em v-if="store.account.totalCredits">已修 {{ store.account.totalCredits }} 学分</em>
        </span>
        <ChevronRight :size="18" />
      </button>
      <!-- 选课/抢课是课表的子模块（默认关闭）：入口跟着功能开关走；
           开着但仍不显示，说明这套教务系统没有选课接口（能力位说了算） -->
      <button
        v-if="features.isEnabled('campus-grab') && store.capabilities.courseSelect"
        class="link-row"
        @click="router.push({ name: 'campus-course-select' })"
      >
        <span>
          选课（直连教务）
          <em>选课窗口开放后可在这里一键选课</em>
        </span>
        <ChevronRight :size="18" />
      </button>
      <p v-else-if="features.isEnabled('campus-grab')" class="tip">
        你这所学校的教务系统暂不支持选课直连。
      </p>
      <p v-else class="tip">
        「选课 · 抢课」是课表的子模块，默认关闭。需要时到「设置 › 打开或关闭功能」里打开。
      </p>
    </section>

    <!-- ⑤ 官方调休映射：默认开。关掉即不显示「假 / 调」标记，也不做任何映射 -->
    <section v-if="store.account" class="card">
      <div class="sec-head">
        <CalendarClock :size="17" />
        <h2>官方调休映射</h2>
        <InfoHint title="调休映射怎么来的" :content="holidayHint" />
        <div class="head-switch">
          <ToggleSwitch
            :model-value="holidayEnabled"
            label="根据官方调休数据进行映射"
            :disabled="holidayBusy"
            @update:model-value="onHolidayToggle"
          />
        </div>
      </div>
      <!-- 卡面只留一行结论；「数据从哪来、补哪一天怎么推断」收进标题行的 InfoHint -->
      <StatusChip tone="accent">放假标「假」、补班标「调」</StatusChip>

      <template v-if="holidayEnabled">
        <button class="link-row" type="button" @click="holidayOpen = true">
          <span>
            逐日纠正补班映射
            <em>{{ holidayRows.length ? `已手动纠正 ${holidayRows.length} 天` : '还没有手动纠正过' }}</em>
          </span>
          <ChevronRight :size="18" />
        </button>
      </template>
    </section>

    <!-- ⑥ AI 排障：操作记录 + 救援脚本。写操作不弹确认（抢课窗口里确认就是拖延），
         那份信任必须由「事后能一条条查、且每条都能重放」来兜底。 -->
    <section v-if="store.account" class="card audit-card d-full">
      <div class="sec-head">
        <Sparkles :size="17" />
        <h2>AI 操作记录</h2>
        <InfoHint title="AI 操作记录是什么" :content="auditHint" />
        <button class="mini" :disabled="auditBusy" @click="loadAudit">
          {{ auditBusy ? '读取中…' : '刷新' }}
        </button>
      </div>
      <!-- 卡面只留一行结论；记录范围与「重放」的人话解释都在标题行的 InfoHint 里 -->
      <p class="audit-lead">AI 排查抢课问题时，对教务做过的每一步都记在这里。</p>
      <button class="mini wide" :disabled="exportBusy" @click="onExportScript">
        <FileDown :size="14" />
        {{ exportBusy ? '导出中…' : '导出救援脚本' }}
      </button>
      <!-- 记录摊在二级抽屉里列举，不在卡片里切 20 条：切片是另一种折叠 ——
           看似全列了，其实第 21 条起被悄悄收走。要查就给全量。 -->
      <button class="link-row" type="button" @click="auditOpen = true">
        <span>
          查看操作记录
          <em>{{ audit.length ? `共 ${audit.length} 条` : '还没有记录' }}</em>
        </span>
        <ChevronRight :size="18" />
      </button>
    </section>

    <!-- ⑦ 账号管理 -->
    <section v-if="store.account" class="card danger-card d-full">
      <div class="sec-head">
        <Trash2 :size="17" />
        <h2>账号管理</h2>
      </div>
      <p class="tip">
        退出登录只清除会话，课表与已生成的时间线会保留为只读快照；删除账号则会连同课表与派生日程一起清除。
      </p>
      <button class="danger" @click="confirmOpen = true">删除账号</button>
    </section>
    </div>

    <!-- ═══ 二级抽屉：学期列表 ═══ -->
    <SheetModal :open="semOpen" title="选择学期" @close="semOpen = false">
      <ul class="pick">
        <li v-for="s in store.semesters" :key="s.id">
          <button
            class="pick-row"
            type="button"
            :class="{ on: s.id === store.semester?.id }"
            :disabled="store.syncing"
            @click="pickSemester(s.id)"
          >
            <span class="pick-main">
              {{ s.name }}
              <em>{{ s.startDate }} ~ {{ s.endDate }}，{{ s.totalWeeks }} 周</em>
            </span>
            <CircleCheck v-if="s.id === store.semester?.id" :size="18" class="tick" />
          </button>
        </li>
      </ul>
      <p class="tip">切换学期会按新课表重建时间线日程。</p>
    </SheetModal>

    <!-- ═══ 二级抽屉：逐日纠正调休 ═══ -->
    <SheetModal :open="holidayOpen" title="逐日纠正调休" initial-snap="large" @close="holidayOpen = false">
      <!-- 「补哪一天由规律推断」只在卡面 InfoHint 里讲一次，这里只留抽屉自己的操作说明 -->
      <p class="tip">
        选「不补课」可把某天的映射压掉。
      </p>
      <ul v-if="holidayRows.length" class="holiday-list">
        <li v-for="row in holidayRows" :key="row.date">
          <span class="h-date num">{{ row.date }}</span>
          <select
            class="h-sel"
            :value="row.weekday"
            :disabled="holidayBusy"
            @change="onHolidayWeekday(row.date, Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="(label, i) in WEEKDAY_LABELS" :key="label" :value="i + 1">{{ label }}</option>
            <option :value="0">不补课</option>
          </select>
        </li>
      </ul>
      <p v-else class="tip">当前学期内还没有可映射的调休日（数据可能还没取到）。</p>

      <div class="holiday-add">
        <input v-model="holidayDraftDate" class="h-date-input" type="date" />
        <select v-model.number="holidayDraftWeekday" class="h-sel">
          <option v-for="(label, i) in WEEKDAY_LABELS" :key="label" :value="i + 1">{{ label }}</option>
        </select>
        <button class="mini" :disabled="holidayBusy" @click="onHolidayAdd">添加</button>
      </div>
    </SheetModal>

    <!-- ═══ 二级抽屉：AI 操作记录（全量，不切片） ═══ -->
    <SheetModal :open="auditOpen" title="AI 操作记录" initial-snap="large" @close="auditOpen = false">
      <ul v-if="audit.length" class="audit">
        <li v-for="a in audit" :key="a.id">
          <span class="at num">{{ shortAt(a.at) }}</span>
          <span class="kind">{{ a.kind }}</span>
          <span class="what" :class="{ bad: a.status === 'error' }">{{ a.summary }}</span>
        </li>
      </ul>
      <p v-else class="tip">还没有记录。</p>
    </SheetModal>

    <ActionSheet
      :open="confirmOpen"
      title="删除后教务账号、课表与派生的日程待办一并清除，且无法恢复"
      :actions="dangerActions"
      @close="confirmOpen = false"
      @select="onDanger"
    />
    </div>
  </div>
</template>

<style scoped>
.page {
  /* 顶距走 --page-pad-top（手机 12 / 桌面 40），与全库页面同一处来源 */
  padding: var(--page-pad-top) var(--page-pad-x) var(--page-pad-bottom);
}

.sec-head {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  /* 区块标题与内容是主从关系：8，与卡内其它「标题→内容」间距一致 */
  margin-bottom: var(--gap-sm);
  color: var(--text-2);
}

.sec-head h2 {
  font-size: var(--fs-subhead);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

/* AI 操作记录卡面的一行结论：完整解释（含「重放」的人话版）在标题行 InfoHint 里 */
.audit-lead {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-body);
}

/* 记录区的「刷新」「导出脚本」：次级按钮，不跟页面的主操作抢注意力 */
.mini {
  position: relative;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-tight);
  /* 小号按钮一档：高 28（--control-sm），左右 12 */
  min-height: var(--control-sm);
  padding: var(--sp-4) var(--pad-inline);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  /* 文字压在 accent-soft 上走 strong 档（--accent 只有 4.27:1） */
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-radius: var(--radius-full);
}

/* 视觉 28，命中区撑到 44（纵向各外扩 8，横向不动 —— 旁边就是别的控件） */
.mini::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}

.mini:disabled {
  opacity: var(--disabled-opacity);
}

.mini.wide {
  width: 100%;
  margin-left: 0;
  margin-bottom: var(--gap-sm);
}

.audit {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  margin-top: var(--gap-tight);
}

/* 记录要逐条读、并与摘要对上：正文从 11px 抬到 caption，时刻不再压 --text-3 */
.audit li {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
  font-size: var(--fs-caption);
  line-height: var(--lh-body);
}

.audit .at {
  flex: none;
  color: var(--text-2);
}

.audit .kind {
  flex: none;
  padding: var(--sp-2) var(--sp-8);
  border-radius: var(--radius-full);
  font-weight: var(--fw-bold);
  color: var(--text-2);
  background: var(--surface-2);
}

.audit .what {
  color: var(--text-2);
  word-break: break-all;
}

.audit .what.bad {
  /* 出错摘要是一句话，不是图标：实底档 --warn 压白底只有约 2.2:1 */
  color: var(--warn-strong);
}

.ok {
  color: var(--ok);
}

.warn {
  color: var(--warn);
}

/* ---------- 学校系统 ---------- */
.sys-list {
  display: flex;
  flex-direction: column;
  /* 组内是各自带底的选项行（不是分隔线列表），行间取无边界控件的一档 */
  gap: var(--gap-sm);
  margin-bottom: var(--gap-sm);
}

.sys {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  padding: var(--sp-12) var(--pad-inline);
  /* 卡片内的二级分组面收一档（12），与母卡 16 拉开层级 */
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
  text-align: left;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.sys:active {
  transform: scale(0.985);
}

.sys.on {
  background: var(--accent-soft);
}

.sys-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
}

/* 学校名带「（正式）」这类长后缀，窄卡里折行：balance 掉「式）」这类孤字尾行 */
.sys-name {
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  text-wrap: balance;
}

.sys-vendor {
  font-size: var(--fs-micro);
  color: var(--text-3);
  text-wrap: balance;
}

.tick {
  flex: none;
  color: var(--accent);
}

/* ---------- 表单 ---------- */
.flabel {
  display: block;
  /* 标签与输入框之间 8（原来是 5，框贴着标签，像同一行断开的字） */
  margin: var(--gap-md) 0 var(--gap-sm);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

input[type='text'],
input[type='password'],
input[type='url'] {
  width: 100%;
  min-height: var(--control-md);
  padding: var(--sp-10) var(--pad-inline);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-callout);
  border: 0.5px solid transparent;
  transition: border-color var(--dur-fast) var(--ease-standard);
}

input:focus {
  border-color: var(--accent);
  outline: none;
}

.mono {
  font-family: var(--font-mono);
  font-size: var(--fs-caption);
}

.tip {
  margin-top: var(--gap-sm);
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: var(--lh-caption);
}

/* 同步时间戳：用户点进这张卡就是确认「课表新不新」，三级灰读不出新鲜度 */
.tip.sync-hint {
  font-size: var(--fs-caption);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

/* ---------- 官方调休映射 ---------- */
.head-switch {
  margin-left: auto;
  display: flex;
}

.holiday-list {
  margin-top: var(--gap-md);
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
}

.holiday-list li {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

.h-date {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.h-sel {
  margin-left: auto;
  /* 表单控件至少给到触控下限 44，28 高在拇指下太窄 */
  min-height: var(--hit-min);
  padding: var(--sp-4) var(--sp-12);
  border: none;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
}

.holiday-add {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
}

.h-date-input {
  flex: 1;
  min-width: 0;
  min-height: var(--hit-min);
  padding: var(--sp-4) var(--sp-12);
  border: none;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
}

.holiday-add .h-sel {
  margin-left: 0;
}

.holiday-add .mini {
  margin-left: 0;
  flex: none;
}

.check {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  margin-top: var(--gap-md);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.cap-row {
  display: flex;
  gap: var(--gap-sm);
}

/* 正方的「人工取验证码」入口：做得像一个可点的提示，而不是主操作按钮 */
.cap-link {
  position: relative;
  margin-top: var(--gap-sm);
  min-height: var(--control-sm);
  padding: var(--sp-4) var(--pad-inline);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  /* 交互文字不小于 12px：10px 的入口在手机上读不出是一颗按钮 */
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

/* 小按钮视觉 28，命中区补到 44 */
.cap-link::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}

.cap-link:active {
  transform: scale(0.985);
}

.cap-input {
  flex: 1;
  min-width: 0;
}

.cap-img {
  flex: none;
  width: 96px;
  /* 验证码图是按钮：高给到 44 的触控下限（宽高由图片自然铺满） */
  height: var(--hit-min);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: var(--text-3);
}

.cap-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* ---------- 按钮 ---------- */
.primary {
  width: 100%;
  margin-top: var(--gap-lg);
  /* 表单主按钮：高 40、圆角 20（按钮档），与 .ghost / .danger 同一档 */
  min-height: var(--control-md);
  padding: var(--sp-10) var(--pad-card);
  border-radius: var(--radius-l);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.primary:active {
  transform: scale(0.985);
}

.primary:disabled {
  opacity: var(--disabled-opacity);
}

/* ---------- 失败反馈 ---------- */
/* 「教务会话已过期」是整页最要紧的提示：soft 底 + strong 字（--warn 实底档当文字只有 2:1） */
.banner {
  display: flex;
  align-items: flex-start;
  gap: var(--gap-sm);
  margin-bottom: var(--gap-sm);
  padding: var(--sp-8) var(--pad-inline);
  border-radius: var(--radius-m);
  background: var(--warn-soft);
  color: var(--warn-strong);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

.form-err {
  display: flex;
  align-items: flex-start;
  gap: var(--gap-sm);
  margin-top: var(--gap-sm);
  /* 正文级错误提示：--danger 压白底不够 4.5:1，走 strong 档 */
  color: var(--danger-strong);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
}

.form-hint {
  margin-top: var(--gap-sm);
  color: var(--text-3);
  font-size: var(--fs-micro);
  line-height: var(--lh-caption);
}

.form-hint a {
  color: var(--accent);
  word-break: break-all;
}

.banner svg,
.form-err svg {
  flex: none;
  /* 图标对首行基线：主次文本上下 2 */
  margin-top: var(--gap-text);
}

.acts {
  display: flex;
  gap: var(--gap-sm);
  margin-top: var(--gap-lg);
}

.ghost {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-sm);
  min-height: var(--control-md);
  padding: var(--sp-10) var(--pad-card);
  border-radius: var(--radius-l);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.ghost:active {
  transform: scale(0.985);
}

.ghost:disabled {
  opacity: var(--disabled-opacity);
}

.danger {
  width: 100%;
  margin-top: var(--gap-md);
  min-height: var(--control-md);
  padding: var(--sp-10) var(--pad-card);
  border-radius: var(--radius-l);
  background: var(--danger-soft);
  /* danger-soft 上的文字走 strong 档 */
  color: var(--danger-strong);
  font-size: var(--fs-caption);
  font-weight: var(--fw-bold);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.danger:active {
  transform: scale(0.985);
}

/* ============================================================
   桌面（由 .desk-main 的存在判定 —— 壳层只在 ≥ DESKTOP_MIN 渲染它）
   前四张是两两成对的短卡（学校系统 | 登录、课表同步 | 培养方案），壳层那套
   半栏栅格正合适；两张不成对的要单独说：
   ============================================================ */

/* AI 操作记录：它是一份会随记录条数长高的日志，行内是「时刻 / 种类 / 摘要」三列 ——
   半栏里每行的摘要都要折行，通栏才读成一张表。导出键也跟着从满宽收回自适应宽 */
.desk-main .audit-card .mini.wide {
  width: auto;
  margin-bottom: 0;
}

/* 账号管理：跟着通栏，横排成「说明在左、危险动作在右」——
   它若留在半栏，行尾会空出半个屏幕，而它本来只有一句话加一个按钮 */
.desk-main .danger-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0 var(--desk-gap);
  align-items: center;
}

.desk-main .danger-card > .sec-head {
  grid-column: 1 / -1;
}

/* 通栏之后满宽的红色按钮会顶成一条 1000px 的长条：只留它自己那份宽度 */
.desk-main .danger-card > .danger {
  width: auto;
  margin-top: 0;
  padding: var(--sp-10) var(--sp-24);
}

/* ---------- 账号信息 ---------- */
.who {
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
  padding: var(--sp-12) var(--pad-inline);
  /* 卡内的二级面：12 圆角，比母卡收一档 */
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
  margin-bottom: var(--gap-sm);
}

.who-name {
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  color: var(--text-1);
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
}

.who-code {
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.who-line {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: var(--lh-caption);
}

/* 账号身分行的主次：行政班号是关键值（加重 + 等宽），年级降一档、竖线分隔 ——
   不再三项同字号用「·」并排。学分已不在这一行（见「培养方案与选课」入口行） */
.who-line b.num {
  font-size: var(--fs-callout);
  font-weight: var(--fw-bold);
  color: var(--text-1);
}

.wsep {
  margin: 0 var(--gap-sm);
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.wsub {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.who-line.dim {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* ---------- 链接行 ---------- */
.link-row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  /* 双行入口行：纵 12 / 横 12，高度收到双行 64 附近 */
  padding: var(--sp-12) var(--pad-inline);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-callout);
  text-align: left;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.link-row:active {
  transform: scale(0.985);
}

.link-row:disabled {
  opacity: var(--disabled-opacity);
}

.link-row em {
  display: block;
  margin-top: var(--gap-text);
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* ---------- 二级抽屉里的单选列表 ---------- */

/* 与「学校系统」选择器同一套语言：surface-2 行 + 选中 accent-soft。
   抽屉内容自带页边距（SheetModal 内容区已有 padding），这里不再加横向负边距。 */
.pick {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  margin: 0 0 var(--gap-sm);
  padding: 0;
  list-style: none;
}

.pick-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--gap-md);
  padding: var(--sp-12) var(--pad-inline);
  border-radius: var(--radius-m-nest);
  background: var(--surface-2);
  text-align: left;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.pick-row:active {
  transform: scale(0.985);
}

.pick-row:disabled {
  opacity: var(--disabled-opacity);
}

.pick-row.on {
  background: var(--accent-soft);
}

.pick-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-text);
  font-size: var(--fs-callout);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

/* 起止日期是辅助信息，随选中态换 --accent-strong：浅底上的主色文字
   不用 --accent（压 surface-2 只有 4.27:1，够不着 4.5） */
.pick-main em {
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: var(--fw-regular);
  color: var(--text-3);
}

.pick-row.on .pick-main em {
  color: var(--accent-strong);
}
</style>
