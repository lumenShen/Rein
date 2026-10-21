<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ChevronRight, Plus } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

import { useTodoStore } from '@/stores/todo'
import { cmpUrgency } from '@/utils/todo'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import PillChip from '@/components/common/PillChip.vue'
import TodoItem from './TodoItem.vue'

/** 主页「待办」卡：按紧急程度排序仅展示前 limit 条；「查看全部」进 /todos 二级页。
 *  limit 由宿主决定：桌面便当的格子越高能盛下的条越多；缺省 3 ——
 *  手机端与历史调用都不传，行为与改动前逐像素一致。 */
const props = defineProps<{ date: string; limit?: number }>()

const router = useRouter()
const store = useTodoStore()
const addOpen = ref(false)

/** 实际展示条数（props.limit ?? 3）；模板里的「另有 N 条未展示」也按它算 */
const limit = computed(() => props.limit ?? 3)

const urgent = computed(() => [...store.allTodos].sort(cmpUrgency).slice(0, limit.value))
const openCount = computed(() => store.allTodos.filter((t) => t.status !== 'done').length)

onMounted(() => {
  void store.loadAll()
})
</script>

<template>
  <section class="card">
    <header class="row between head">
      <h2>待办</h2>
      <div class="row center">
        <button class="add row center" aria-label="添加待办" @click="addOpen = true">
          <Plus :size="17" :stroke-width="2.4" />
        </button>
        <!-- 两个 /todos 入口合并成卡头这一枚（位置更靠上、信息更全：总数 + 未展示数），
             卡尾「查看全部」链接删掉 -->
        <PillChip as="button" tone="action" class="all-link" @click="router.push('/todos')">
          全部 <span class="num">{{ store.allTodos.length }}</span>
          <span v-if="store.allTodos.length > limit">· {{ store.allTodos.length - limit }} 条未展示</span>
          <ChevronRight :size="13" :stroke-width="2.6" />
        </PillChip>
      </div>
    </header>

    <ul v-if="urgent.length" class="list">
      <TodoItem v-for="t in urgent" :key="t.id" :todo="t" />
    </ul>
    <p v-else class="empty t-3">还没有待办，点右上角「+」添加一条吧</p>

    <p v-if="urgent.length" class="foot t-3">
      <span class="num">{{ openCount }}</span> 条未完成
    </p>

    <SmartAddSheet :open="addOpen" :date="props.date" @close="addOpen = false" />
  </section>
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}

.add {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-1);
}

/* 卡头「+」：30px 圆钮是排版规格，命中区撑到 44×44（PageHeader .back 同款惯用法） */
.add::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 44px;
  height: 44px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
}

/* 卡头去处胶囊：PillChip tone=action（规格在 PillChip.vue），这里只补命中区 ——
   纵向撑到 44（原 .all-link 同款惯用法：胶囊自身约 26px 高，低于拇指下限） */
.all-link {
  position: relative;
}

.all-link::after {
  content: '';
  position: absolute;
  inset: -9px -4px;
  border-radius: var(--radius-full);
}

.list {
  /* 卡头与列表之间 8（标题与内容一档），6 会让首行贴着标题 */
  margin-top: var(--gap-sm);
}

.empty {
  padding: var(--sp-24) 0 var(--sp-16);
  text-align: center;
}

.foot {
  padding-bottom: var(--sp-4);
}
</style>
