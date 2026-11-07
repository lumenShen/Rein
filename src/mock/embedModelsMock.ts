/**
 * 浏览器 mock 的本地嵌入模型目录 —— 与 Rust `modules/kb/embed_models.rs::MODELS` 逐字段一致。
 *
 * 为什么在 mock 里也维护一份：设置面板要能画出完整的选择列表（档位、体积、说明），
 * 浏览器预览与 e2e 才有得看。**体积是实测值**（2026-10-07 经 hf-mirror 探测），
 * 与真机的下载进度对得上；改真机注册表时这里要一起改。
 * 所有模型都不内置：mock 环境不能下载，所以一律显示「未下载」。
 */

export interface MockEmbedModel {
  id: string
  label: string
  tier: string
  dim: number
  bytes: number
  note: string
}

export const MOCK_EMBED_MODELS: MockEmbedModel[] = [
  {
    id: 'bge-small-zh-v1.5-int8',
    label: '轻量 · 中文',
    tier: 'light',
    dim: 512,
    bytes: 24_010_842 + 439_125,
    note: '中文短句够用、占用最小；下载约 24 MB，适合先试本地语义检索',
  },
  {
    id: 'bge-base-zh-v1.5-int8',
    label: '标准 · 中文',
    tier: 'standard',
    dim: 768,
    bytes: 102_868_746 + 439_124,
    note: '中文语义明显更细（同义改写、长句都能捞到），下载约 98 MB，日常首选',
  },
  {
    id: 'bge-large-zh-v1.5-int8',
    label: '高精度 · 中文',
    tier: 'high',
    dim: 1024,
    bytes: 327_363_707 + 439_124,
    note: '中文检索天花板一档（MTEB-zh 榜首家族），下载约 312 MB，桌面优先',
  },
  {
    id: 'bge-m3-int8',
    label: '多语 · 超大',
    tier: 'multi',
    dim: 1024,
    bytes: 569_694_530 + 17_082_821,
    note: '100+ 语言、长文本友好；下载约 543 MB，手机不建议',
  },
  {
    id: 'paraphrase-multilingual-MiniLM-L12-v2-int8',
    label: '轻量 · 多语',
    tier: 'multi',
    dim: 384,
    bytes: 118_308_126 + 17_082_913,
    note: '多语种（含中文）折中档；384 维更省内存，下载约 113 MB',
  },
]
