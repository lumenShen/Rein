import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import type { AiMessage, VoiceMemo } from '@/types'
import type { ParsedDoc } from '@/utils/documentParse'

/**
 * 全局输入条的草稿 —— **跨页唯一真源**。
 *
 * 2026-11-10 用户报的「切页就把输入内容清掉」：AI 页的草稿 / 附图 / 文档 / 引用 /
 * 纪要引用原先都是 AIPage 的局部 ref。底栏那根 ComposerBar 因为 TabBar 常驻，
 * 文字能活下来；可一旦从 AI 页切走（AIPage 卸载），拍好的图、挂上的文档与引用
 * 全部蒸发。输入条既然是**全局唯一**的，草稿也必须只有一份、活在组件树之外。
 *
 * 为什么不落 localStorage：附图里是 File / Blob（放大镜要按需解码原图），
 * 序列化不了；草稿的生命周期本来就是「这次输入还没发出去」，不是跨重启的资产。
 */

/** 待发送附图：`full` 是发模型的视图，`small` 是芯片缩略图，`source` 留给放大镜 */
export interface ComposerImage {
  full: string
  small: string | null
  w: number
  h: number
  source: File
}

/** 待发送文档：解析结果 + 各内嵌图的发送视图 + 勾选集合 */
export interface ComposerDoc {
  file: File
  doc: ParsedDoc
  views: Map<string, { base64: string; w: number; h: number }>
  selected: Set<string>
}

export const useComposerStore = defineStore('composer', () => {
  /** 输入框文字 */
  const text = ref('')

  /** 附图（相机连拍 + 图库多选累积） */
  const attachments = ref<ComposerImage[]>([])

  /** 待发送文档（Office / 文本解析） */
  const docAtt = ref<ComposerDoc | null>(null)

  /** 引用的消息（发送时作为 quoteText 注入） */
  const quote = ref<AiMessage | null>(null)

  /** @纪要引用（发送时注入纪要总结与逐句转写） */
  const memoRefs = ref<VoiceMemo[]>([])

  /**
   * 从其它页面按了发送、但草稿里带着附件 / 文档 / 纪要：这些内容的组装（图片视图、
   * 文档元数据、放大镜注册）只有 AIPage 有，底栏不能代劳。置位后由 AI 页在挂载
   * 完成时取走并走同一套 send()，**不把附件悄悄留在原地**。
   */
  const sendRequested = ref(false)

  /**
   * 有东西可发：文字 / 附图 / 文档任一即可。
   * @纪要引用不算：它只是随消息注入的附加材料，单独一条纪要发不出去
   * （sendText 的门槛同样要求文字 / 图片 / 文档），点亮发送钮会变成空操作。
   */
  const hasContent = computed(
    () => !!text.value.trim() || attachments.value.length > 0 || !!docAtt.value,
  )

  /** 清空一条消息发出后的草稿（文字 / 附图 / 文档 / 引用 / 纪要一起走）。
   *  顺带撤掉未消费的跨页发送请求：草稿都没了，就不该在 AI 页再自动发一次。 */
  function clear(): void {
    text.value = ''
    attachments.value = []
    docAtt.value = null
    quote.value = null
    memoRefs.value = []
    sendRequested.value = false
  }

  function requestSend(): void {
    sendRequested.value = true
  }

  /** AI 页取走一次发送请求（取完即清，避免回到页面时重发） */
  function takeSendRequest(): boolean {
    const v = sendRequested.value
    sendRequested.value = false
    return v
  }

  return {
    text,
    attachments,
    docAtt,
    quote,
    memoRefs,
    sendRequested,
    hasContent,
    clear,
    requestSend,
    takeSendRequest,
  }
})
