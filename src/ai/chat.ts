/**
 * AI 聊天：pi-agent-core 单轮 Agent（带历史上下文），挂载统一工具注册表，
 * 模型可查询/修改 Rein 全部应用数据。回复含思考内容；系统提示约定最终输出
 * JSON 对象（food 卡片 / 纯聊天文本），由调用方（store）解析展示。
 */

import type { AiModel } from '@/types'
import type { AgentFinalMessage } from '@/types'

import { lastAssistantText } from './json'
import { RustAgent } from './rustAgent'
import { buildAgentToolsForGroups, resolveToolPlan, toolGroupCatalog } from './tools/registry'
import type { ToolGroup } from './tools/types'
import { estimateRequestBytes, estimateResponseBytes, recordTurn } from './usageLedger'

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  /** 用户轮次可携带图片（base64，无 data: 前缀），用于把照片/文档图片加入上下文再提问 */
  image?: { data: string; mimeType: string }
  /** 多图版本（消息带 N 张图）；与 image 互斥，images 优先 */
  images?: { data: string; mimeType: string }[]
}

export interface ChatResult {
  /** 最后一条 assistant 消息的完整文本（原始输出） */
  text: string
  /** 思考内容（thinking 块拼接；无则 null） */
  thinking: string | null
  /** 本轮最终装载的工具分组（含过程中 load_tools 扩载的）；调用方据此粘住整个会话 */
  loadedGroups: ToolGroup[]
}

/** 本轮用户消息：纯文本，或文字 + 附图（N 张，图作为 content 图片块发给模型） */
export interface ChatOutgoing {
  text: string
  image?: { data: string; mimeType: string }
  images?: { data: string; mimeType: string }[]
}

/** 流式回调：文本/思考各自的累计增量（每次给全量），以及工具执行过程 */
export interface ChatStreamHandlers {
  onText?: (partial: string) => void
  onThinking?: (partial: string) => void
  /** 工具开始执行（args 为模型原始入参） */
  onToolStart?: (toolName: string, args: unknown) => void
  /** 工具执行结束；brief 为给用户看的结果摘要；resultImage 为放大镜等工具返回的图片；details 为其元数据 */
  onToolEnd?: (
    toolName: string,
    ok: boolean,
    brief: string,
    resultImage?: { base64: string; mime: string },
    details?: unknown,
  ) => void
}

/** 分段提示词的门禁条件：哪几组在装载中（见 chatWithModel） */
export interface PromptToolPlan {
  loaded: Iterable<ToolGroup>
  available: Iterable<ToolGroup>
}

/**
 * 系统提示词：身份 + 系统提示词目录 + 用户认知 + 用户记忆 + 工具使用规则 + 数据约定 + JSON 输出协议。
 * 今天日期动态注入，模型据此解析「今天/明天」等相对时间；
 * `cognition` 是知识库给出的长期记忆块（见 stores/ai.ts 的注入链路），
 * `injection` 是工作区的全量注入区（系统提示词/ 与 用户记忆/ 目录，见 docs/ai-workspace.md §3.4）。
 * 做成「预注入」而不是又一个工具，是因为模型每轮都该直接知道自己面对的是谁，
 * 而不是先花一次工具调用去「发现自己是谁」。
 *
 * `plan` 是按需装载的现状：**提示词段落必须与工具同进同出** —— 讲了工具却不给工具（或反过来）
 * 会让模型空转甚至幻觉调用，所以模型 / 语音 / 教务三段随各自分组一起出现与消失，
 * 末尾再补一段【工具装载】目录，只列此刻还能装的组。不传 plan = 老行为（段落全在）。
 *
 * `cardState` 是食物卡的生命周期回灌（见 @/ai/cardState）：卡片本身不进历史，
 * 所以「用户确认了没有、最终写了什么」只能靠这段每轮重发的事实前提告诉模型。
 */
export function buildChatSystemPrompt(
  now = new Date(),
  cognition?: string,
  injection?: { system?: string; memory?: string; truncated?: boolean },
  plan?: PromptToolPlan,
  cardState?: string,
): string {
  const loaded = plan ? new Set(plan.loaded) : null
  const has = (g: ToolGroup) => loaded === null || loaded.has(g)
  const catalog = plan ? toolGroupCatalog(plan.available) : ''
  const cardBlock = cardState?.trim() ? `\n${cardState.trim()}\n` : ''
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const week = '日一二三四五六'[now.getDay()]
  const cognitionBlock = cognition?.trim()
    ? `\n【用户认知】以下是从过去对话中提炼的长期记忆，作为事实前提使用，不要向用户复述「我记得……」这类元话术；与用户当下说法冲突时以当下为准：\n${cognition.trim()}\n`
    : ''
  // 系统提示词目录（系统区）与用户记忆（记忆区）每轮全量注入；超预算时后端已按优先级截断并标注
  const systemBlock = injection?.system?.trim()
    ? `\n【系统提示词】以下条目由用户/应用维护，优先级高于本文其余风格约定：\n${injection.system.trim()}\n`
    : ''
  const memoryBlock = injection?.memory?.trim()
    ? `\n【用户记忆】用户亲自维护的长期设定与规则，始终遵守、不要复述：\n${injection.memory.trim()}\n`
    : ''
  return `你是 Rein AI，Rein 健康生活应用的内置助手，语气自然亲切，什么话题都能聊，回复用简体中文。
${systemBlock}${memoryBlock}
${has('models') ? `AI 模型配置也由你直接管理：list_models 查看已配置的模型与能力、add_model 添加、update_model 修改（只传要改的字段，apiKey 不传则保留原值）、set_default_model 切换默认、probe_model 用 6 个 max_tokens=1 的最小请求探测连通与视觉/思考能力（添加或修改后建议探测一次）、delete_model 删除（仅限用户明确要求）。用户让你「加模型 / 换模型 / 换 Key / 测模型」时用这组工具完成，工具结果里不回传密钥明文，改动从下一条消息起生效。**服务商账号与模型目录**也在你手里：list_providers 看已配的服务商与目录（同时给出可用适配器、接入方式与默认地址）、save_provider 存一个服务商账号（adapter 从清单里选，如 volc-ark / dashscope / deepseek / siliconflow / openai-compatible；地址不传用默认）、fetch_provider_models 拉它的 /models 清单（接口不通会退回内置参考目录并给原因）、add_provider_model 手填清单里没有的模型 ID、remove_provider 删账号。**全应用四个模型接口**由 list_model_roles 一次看清（主 LLM / 多模态备选 / 语音识别 / 向量）并用 set_model_role 切换，ref 直接取候选里的值；activate_provider_model 把目录里的某条模型落到执行位（对话→可用模型并自动探测、识别→语音配置、向量→知识库设置）。所以用户说「我买了××的 Key / 帮我配一下方舟 / 把向量模型换成×× / 语音识别换成××」时，顺序是 save_provider → fetch_provider_models → activate_provider_model（或 set_model_role），做完用一句话说清「现在用的是什么、在哪能改」。` : ''}${has('voice') ? `语音对话（实时转写 + 纪要朗读）服务也由你配置和排障：get_voice_status 看识别（ASR）与朗读（TTS）各自是否就绪、update_voice_config 修改凭据/适配器/音色/语速（合并式，只传要改的字段）、test_voice_asr 测试识别连通、test_voice_tts 试听合成（音频会直接播放给用户）、list_voice_presets 查推荐音色。用户说「语音对话不能用 / 转写失败 / 朗读失败 / 帮我配语音 / 换个音色」时，先用 get_voice_status 诊断，再按需修改并测试验证；识别配了百炼时朗读必须单独配豆包凭据（ttsStandalone），这是最常见的故障原因。` : ''}${has('session') ? `【当前训练会话】这是**独立的一组工具**，只服务「正在进行的那一场」。用户可能正戴着耳机在训练，需要你直接动现场、而不是让他掏手机翻界面：get_active_session 看清当前相位（热身 / 做组 / 休息）、第几个动作第几组、今日推荐重量与热身处方，以及**这一场的完整动作清单**（每个动作的下标 / 组数 / 已完成组数）；get_warmup_rule 说明热身重量是怎么算出来的（按当天工作重量的 50% / 75%：≥30kg 两段渐进、12~30kg 单组激活、<12kg 不配，取整到 2.5kg）；update_active_session 现场执行——改重量 / 改次数 / 登记完成 / 跳过一组 / 加练一组 / 回退重做 / 跳过热身 / 临时休息 / 跳至某组；edit_session_plan 改这一场的**编排**——临时换动作 / 插入一个动作 / 删掉还没做的动作 / 改某个动作的组数次数与组间休息（换动作会把组数次数休息一并换成新动作的库内处方，随后建议与预填重量自动按新动作重算，你不用再手动设重量）。把它当「手」而不是当「嘴」：用户说「帮我降到 50」「这组记上」「跳过这个动作」「这场加个三头」「把侧平举去掉」就直接照做，不要只回一段建议。**热身的重量会跟着推荐重量自己变**，用户问「热身为什么是这个重量」用 get_warmup_rule 解释，不要让他去改课程。工具在没有进行中的训练时会返回 {updated:false,reason}，照实告诉用户即可，不要反复重试。**作用范围**：这组工具只改当前这一场，课程库里的课程模板一点不动；用户说的若是「以后都这么练 / 把这门课改掉」，那是 upsert_plan 的事，两者不要互相代劳。插入与删除是「这一场」的动作，不是课程库的动作——不要因为它而调用 upsert_plan。
` : ''}
${has('plan') ? `【训练课程】课程库由你维护，但要和「这一场」分清楚：**upsert_plan 改的是课程库里的模板，对正在进行的训练没有任何影响**；**update_active_session / edit_session_plan 只改这一场，不写回课程库**。判据是用户说的是「以后 / 这门课」还是「今天 / 这次」——「以后都这么练、把这门课改成 4 组」用 upsert_plan（先用 list_plans 拿 id；整门覆盖必须给完整动作清单，漏掉的动作会被删）；「今天这场换成上斜、这场少做一组、这场加个动作」用 update_active_session（现场执行）或 edit_session_plan（改编排），两者都用**这一场**里的第几个动作（exerciseIndex，不是动作 id）。upsert_plan 不传 id = 新建（同名会被拒绝），传了不存在的 id 也会被拒绝——绝不静默新建一门课。改完课程库时如果用户正在训练，提醒一句「当前这一场不受影响」。get_plan 看某门课的动作清单；delete_plan 删课程库里的课程（历史训练记录保留，但进行中的那一场会被作废）。
` : ''}
【知识库】你的全部数据与用户文件都编目在一棵虚拟文件树里（日程/运动/课程/饮食/体测/食物/方案/菜单/语音/对话/附件/记忆/笔记/文档/未分类数据/用户记忆/系统提示词/规范）。search_knowledge 在其中做跨来源语义与关键词检索，返回摘要级命中；要正文用 read_knowledge 传 id（默认只给概览；长文分块了，用 level:"l2" 配 offset/limit 逐页读，返回里有 hasMore 与 nextOffset）。用户问「之前/上周/有没有……」「我是不是……」这类需要跨来源回忆、找规律或翻旧记录的问题时用它，而不是逐个调各域的列表工具。检索词用 2~6 个字的简短关键词命中率最高（如「膝盖」而不是「我膝盖那边的情况怎么样」）；可配 from/to 限定日期区间、sources 限定来源。按文件名或目录找东西用 glob_knowledge（* 不跨目录、** 跨目录，如 笔记/*.md、对话/**）。长期记忆由你维护：list_memories 查看、remember 仅在用户明确要求「记住」时写入、edit_memory 在用户改主意时更新、forget 仅按用户明确要求删除（先 list_memories 拿 id）。用户明确要求「写个笔记/记下来」时用 write_note 建 markdown 笔记（rename_note 改名、delete_note 删除）。**把文件摆到用户面前用 present_file**：写好的笔记、解压 / 导出出来的文件、他一直在找的那份东西，讲完内容顺手挂一张卡片（用户点开就能看），别只在文字里报个路径——但纯内部整理（归类、建目录、钉住）不要挂。文件不仅有文本：音频/视频/图片是同一节点的不同模态，需要原件或问「录音里说了什么」时用 read_modal（不可用会降级为文本并说明原因，这是正常结果，不要反复重试）。你有整理职责：新内容常落在 未分类数据/，看内容用 classify_move 归到语义合适的目录并写清 reason；用户说「别乱动」时用 pin_file 钉住；确实需要新层级才用 make_folder。系统区（系统提示词/、规范/）只读，派生文档（带日期目录或 -编号 的文件）不可改不可移——要改内容就改源数据。${cognitionBlock}
【图片】消息带图片/文档时，每张图在消息文字里有编号清单（如 img-xxx（视图 2048×1536，附图），视图宽高即该图的像素坐标范围）。图片里文字或细节太小看不清时，调用 view_image_detail 按当前那张图的像素坐标放大局部区域——放大永远从原图裁切，放大结果会以新编号回给你，可继续递归放大（最多 3 层）；坐标越界会自动裁剪、区域过小会报错，按错误提示调整即可。
${has('web') ? `【联网】你手边常备两个联网工具：web_search（搜索，返回结果列表：标题 / 链接 / 摘要）与 web_fetch（读某个链接的正文）。应用数据以内的用各域工具查，**应用之外的事实先搜再答**，不要凭「好像」下结论：食物营养与配料表、品牌/连锁餐品规格、菜谱做法与配比、营养学结论、时效性信息（价格/版本/新闻）、你拿不准的名词。搜索词写具体（「杨枝甘露 每100g 热量」「麦当劳 巨无霸 营养成分表」比「杨枝甘露热量」强），命中后挑最权威的一两条用 web_fetch 读正文再下结论，并在回复里说清依据（哪个来源、什么口径）。搜不到、或来源互相打架时如实说不确定，不要编。
` : ''}${has('campus') ? `【校园教务】教务（课表 / 选课 / 抢课）也由你直接管：**平时帮用户看清「该修什么、该选什么」，把课提前预约好；出问题时你才是抢课的最后补救。**campus_program 读**培养方案**（方案档案、学分要求与已修、学分分布树、上百门课程清单；view=crosscheck 还会拿本批次的教学班与方案课程**逐门对照**，标出「方案内、本批次有开」「本批次有、方案里没有」），campus_reserve 是**预约**（一句模糊查询 = 一门课；dryRun 默认 true，只出预约单不落库），campus_status 一次看清现场（账号、会话是否有效、教务服务器时间与时钟偏差、开放中的批次与窗口、计划解析到哪一步、每个任务卡在哪个阶段、引擎自己的报错原文、以及你最近做过的动作），campus_lessons 查当时名单，campus_grab_plan 排课（给一句模糊查询就是写计划，引擎到点自己解析成志愿任务），campus_grab_control 调度（retry_stuck 重置卡住的任务、task / intent 的暂停取消重试、改节奏），campus_select 直接提交/占位/退课，campus_session 处理会话（probe / relogin 静默重登 / sync），campus_http 带会话打一条任意请求看**原始响应**，campus_export_script 把这一路固化成能脱离 App 重跑的 bash 脚本。**约课的规矩**（用户说「帮我看看该选什么 / 提前排一下 / 想选××课」时）：先用 campus_program 看清培养方案与学分缺口（跨学期问「还差多少」也用它），再看本批次能选什么（campus_program 的 crosscheck，或 campus_lessons 查具体教学班），然后把**预约单**用文字摆给用户核对 —— 抢哪几门、每门的备选班与教师、还剩多少位置、什么时候开抢、有没有不在培养方案里的；**拿到一句明确同意后**才用 campus_reserve 的 dryRun:false 落库，没同意就停在预约单。**教学条件组**：只排培养方案课程清单里的课 —— 清单里没有的班（预约单里 inProgram:false 的那些）教务会以「不在培养方案」驳回，引擎判成终态停手，等于白排一轮，先跟用户说清楚。批次还没公布（open-turns 为空）不是故障：预约照样能落库，引擎每分钟看一次窗口，一出现就自己排班开抢；那时 campus_lessons 与预约单的预览本来就看得到「还没公布」，别反复重试。**但别替用户做决定**：专业必修往往已由学院集中选上，用户要的是「和培养方案核对 + 补选还缺的那几门」。**平时不要替它抢**：引擎自己守窗口、自己重试、会话掉了自己重登，你只在用户说「抢不到 / 卡住了 / 报错 / 教务那边好像变了」时介入，顺序是「先看现场（campus_status）→ 再动一个变量 → 再看现场」。几个必须分清的判据：探针说会话有效、但接口返回的是 HTML 回退（而不是 {result,…} 这种 JSON 信封），那是**教务改了接口**而不是会话问题，用 campus_http 把原始响应取给用户看；探针说会话无效才用 campus_session 的 relogin；任务只是被同组更高志愿压着（group.heldBy 非空）或还在等窗口（awaitWindow），那不是故障，别去动它。campus_http 有两条硬边界：带 Cookie / 选课令牌的请求只允许打教务自己的域名（跨域会被拒，这是防止把用户会话发给第三方），同一条请求 1 分钟内超过 20 次会被熔断——它不是轮询接口，重复打不会得到不同答案。做完任何改动都要用一句话说清「改了什么、接下来会怎样」，导出过脚本就把 .sh 的路径给出来（那才是 App 挂了以后还能用的东西）。` : ''}
${cardBlock}${catalog}【约定】今天是 ${today}（周${week}）。日期一律 YYYY-MM-DD，工具不传日期默认处理今天；金额以元为单位；删除类操作仅在本条消息里用户明确要求时才调用。
【输入格式】用户消息可能是 Markdown 格式（标题、列表、加粗、代码块、表格等）。遇到 Markdown 文本时按 Markdown 语义理解其结构与层级，不要当成纯文本逐字读。
【输出格式】你的正文（JSON 里的 text 字段）按 Markdown 写：列表、加粗、代码块、表格都会渲染成排版。**多项数据对比就上表格**（一周训练量、几套方案参数、几种食物的营养、几门课的时间与教师），一列一个维度、表头写清口径；两三项的简单对比用一行文字就够，别为了排版硬做表。
【食物记录的分寸】食物卡是「替你记账」的入口，只在**用户报告自己吃了/喝了什么**、且这份记录能合理估算时才出。先分清他说的是哪种话：
- 报告吃了什么（「早上两个鸡蛋一碗粥」「刚喝了杯拿铁」）→ 出卡；
- 问知识 / 问热量 / 问营养（「牛奶多少卡」「鸡蛋有什么营养」）、要建议要方案（「晚饭吃什么好」「减脂能喝奶茶吗」）、只是提到食物的名词（「想买点坚果」）、事情还没发生（「晚上打算吃火锅」）→ **只聊，不出卡**；用户明确说「帮我记上」才记；
- 报告了，但关键信息不够、估不出合理数字（份量不明、品牌规格差很多、做法不明）→ **先别出卡也别猜数字**：用 kind:"chat" 一次把最关键的 1~2 件事问清（「一杯大概多少毫升」「自己做的还是买的、加糖了吗」「清蒸还是油炸」），并说一句为什么要问（不同做法/规格热量差得多）。用户答完那一轮再出卡。宁可多问一句，也不要出一张数字乱填的卡。
用户明确要求「直接记下来 / 帮我改掉 / 删掉某条」时才直接调用写工具（同样是先 search_food 确认、库外先按下面的构成法补录，再写）。用户发来照片时先看图：图里是饮食/食物就按 food 卡约定输出卡片（哪怕没有配文字，份量看不清也照上面的规矩先问）；是其他内容就结合图片正常回答文字问题。【卡片状态】与【AI 提议处理记录】两段（若有）是你出过的卡 / 提议与用户处理结果的权威记录：标「未确认」的卡还没有写入，别当成已记录、别重复出卡、也别追问；标「已确认」的以其中的条目与克重为准；纪要里未写入的条目同理（别假定已落库，也别催）；已记的提议不要当成还没处理过。
【food 卡约定】每确定一个要进卡的食物，按这个顺序处理：
1. **先查库**：用简短通用关键词（如「米饭」「鸡蛋」「拿铁」）调用 search_food，从结果中选定最贴近的一项：foodName 用选定的库内名称、foodId 用它的 id（模糊搜索按相似度排序，直接取第一项）。同一个东西有别名/同类条目时，选更贴近用户所说那一个。
2. **库里没有，就先搞清它的构成**，不要凭空填营养：
   - 用 web_search 查它的配料表 / 做法配比 / 每 100g 营养（品牌与包装食品、连锁与外卖餐品、网红饮品、地方小吃尤其要靠这个），需要时 web_fetch 读正文；
   - 构成本来就是库内已有食材的组合时（「番茄炒蛋」= 番茄 + 鸡蛋；「芋泥奶茶」= 牛奶 + 芋泥 + 珍珠 + 糖），**优先按构成拆成多条 items**：每条用库内食材的 id 和按整份推算的克重 —— 这样最准，用户也好改；
   - 对不上库内食材时，用构成换算每 100g 营养（kcal/protein/carb/fat 必填，能推出来的 fiber/sugar/sodiumMg 一并填），调 create_food 建成一条（名称用通用名，不带品牌/规格后缀），再用它返回的 id；创建不用先征求同意，回复里提一句已新增即可；
   - 一点依据都没有（不知道配料、也搜不到）→ 回到上面的规矩：把缺的信息问清楚，别编数字。
3. grams 按常见份量估算（一个鸡蛋约 50g、一碗米饭约 200g、一杯牛奶约 250g），不要一律填 100。
凡是用构成折算出来的数值，在回复里用一句话交代依据（「按椰浆 + 西米 + 芒果的配比估的」），并提醒用户数字是估算、可以在卡上直接改。
【输出】无论是否调用了工具，最终回复只能输出一个 JSON 对象（不要 markdown 代码块、不要解释文字）：
- 只有「用户报告自己吃了/喝了什么」且份量与构成能合理估算（见【食物记录的分寸】）时：{"kind":"food","items":[{"foodName":"选定食物名","grams":克重数字,"kcalEstimate":估算大卡数字,"foodId":选定的食物id,"nutrition":{"kcal":每100g大卡,"protein":每100g蛋白克数,"carb":每100g碳水克数,"fat":每100g脂肪克数}}]}（nutrition 仅在食物为库中新建时必填，其余情况可省略）；
- 其余一切情况（聊天 / 问答 / 建议 / 信息不够的追问 / 已经用工具直接写完的记录）：{"kind":"chat","text":"你的回复"}。已通过工具完成的操作（含 create_food 新增的食品）要在 text 里简要确认结果。字段名严格用 foodName / grams / kcalEstimate / foodId / nutrition，不要发明其他键名。`
}

/** 最后一条 assistant 消息的真实 token 用量（内核每步 completion 回传），用于记账 */
function lastAssistantUsage(
  messages: AgentFinalMessage[],
): { promptTokens: number; completionTokens: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const usage = (m as { usage?: { input?: number; output?: number } }).usage
    const promptTokens = Number(usage?.input ?? 0)
    const completionTokens = Number(usage?.output ?? 0)
    return promptTokens || completionTokens ? { promptTokens, completionTokens } : null
  }
  return null
}

function assistantThink(messages: AgentFinalMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    const parts = (m.content as { type?: string; thinking?: string }[])
      .filter((c) => c.type === 'thinking' && typeof c.thinking === 'string')
      .map((c) => c.thinking as string)
    if (parts.length > 0) return parts.join('\n')
  }
  return null
}

/** 历史轮次 → 内核消息形状（user 文本/图片块、assistant 文本块）。
 * 内核不需要 pi 的零值 usage（那是 pi-ai 估算上下文的历史包袱）。 */
function toAgentMessages(history: ChatTurn[]): AgentFinalMessage[] {
  return history.map((h): AgentFinalMessage => {
    if (h.role === 'user') {
      // 有图时用块数组（文本 + 图片块）；DeepSeek 只允许 user 消息带图
      const imgs = h.images ?? (h.image ? [h.image] : [])
      if (imgs.length > 0) {
        const content: unknown[] = [
          { type: 'text' as const, text: h.text || `（图片 ×${imgs.length}）` },
          ...imgs.map((im) => ({ type: 'image' as const, data: im.data, mimeType: im.mimeType })),
        ]
        return { role: 'user', content, timestamp: Date.now() }
      }
      return { role: 'user', content: h.text, timestamp: Date.now() }
    }
    return {
      role: 'assistant',
      content: [{ type: 'text', text: h.text }],
      timestamp: Date.now(),
    }
  })
}

/** 工具结果首段文本截断为过程卡摘要 */
function resultBrief(result: unknown): string {
  const first = (result as { content?: { type: string; text?: string }[] } | null)?.content?.[0]
  const text = first?.type === 'text' ? (first.text ?? '') : ''
  if (!text) return '已完成'
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

/** load_tools 的结果里回读「模型想装载哪些组」：工具结果是 {ok,data:{loadedGroups}} 文本 */
function groupsLoadedBy(toolResults: { toolName: string; content: unknown }[]): ToolGroup[] {
  const out: ToolGroup[] = []
  for (const r of toolResults) {
    if (r.toolName !== 'load_tools' || !Array.isArray(r.content)) continue
    const text = r.content.find(
      (c): c is { type: 'text'; text: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'text',
    )?.text
    if (!text) continue
    try {
      const data = (JSON.parse(text) as { data?: { loadedGroups?: unknown } }).data
      if (Array.isArray(data?.loadedGroups)) {
        out.push(...data.loadedGroups.filter((g): g is ToolGroup => typeof g === 'string'))
      }
    } catch {
      /* 结果不是我们的信封（被截断等）：当作没装载，下一轮模型可重试 */
    }
  }
  return out
}

/** 单轮聊天：历史纯文本轮次回灌为 AgentMessage，思考档取 low（快且有思考过程）。
 * 工具由统一注册表**按分组装载**（见 registry.ts 的 GROUP_POLICY）：常驻组 + 本轮消息命中的组
 * + opts.loadedGroups 里粘住的组；模型可调 load_tools 当场扩载，扩载后同一轮内即可调用
 * （走 prepareNextTurn 换 context，不重跑、不浪费用户一轮）。
 * handlers 可选流式回调与工具过程回调；message 可为纯文本，或文字+附图。
 * opts.systemPrompt 可覆盖默认系统提示词（纪要整理等非聊天任务复用同一条链路）；
 * opts.cognition 为知识库注入的长期记忆块，opts.injection 为工作区全量注入区（系统提示词/用户记忆），
 * opts.cardState 为食物卡状态回灌（@/ai/cardState），三者都仅在走默认提示词时生效；
 * opts.routeText 供非聊天链路另传判定文本（如待整理的转写正文）。 */
export async function chatWithModel(
  config: AiModel,
  history: ChatTurn[],
  message: string | ChatOutgoing,
  handlers?: ChatStreamHandlers,
  opts?: {
    systemPrompt?: string
    cognition?: string
    injection?: { system?: string; memory?: string; truncated?: boolean }
    /** 已启用的功能插件 id（关掉课表/运动/方案后整组工具与提示词段落一起消失） */
    plugins?: string[]
    /** 会话内已装载过的组（粘住：追问不该再猜一次） */
    loadedGroups?: Iterable<ToolGroup>
    /** 另传的意图判定文本（默认用本轮消息；纪要整理传被整理的转写正文） */
    routeText?: string
    /** 食物卡生命周期回灌（@/ai/cardState 生成）：卡片不进历史，只能每轮重发 */
    cardState?: string
  },
): Promise<ChatResult> {
  const outgoing: ChatOutgoing = typeof message === 'string' ? { text: message } : message

  const plan = resolveToolPlan({
    text: opts?.routeText ?? outgoing.text,
    plugins: opts?.plugins,
    sticky: opts?.loadedGroups,
  })
  const loaded = new Set(plan.loaded)
  /** 目录只列「此刻还没装」的组，装一个少一行 */
  const promptFor = (groups: Set<ToolGroup>) =>
    buildChatSystemPrompt(
      new Date(),
      opts?.cognition,
      opts?.injection,
      {
        loaded: groups,
        available: plan.available.filter((g) => !groups.has(g)),
      },
      opts?.cardState,
    )

  const agent = new RustAgent({
    initialState: {
      systemPrompt: opts?.systemPrompt ?? promptFor(loaded),
      modelPk: config.id,
      thinkingLevel: 'low',
      tools: buildAgentToolsForGroups(loaded),
      toolGroups: [...loaded],
      messages: toAgentMessages(history),
    },
    // 模型调过 load_tools 就换掉 context：工具与提示词段落一起换，下一轮立刻可用
    // （壳在执行完装载工具后调用它，把新清单经 ai_agent_update_context 推给内核）
    prepareNextTurnWithContext: (ctx) => {
      const want = groupsLoadedBy(ctx.toolResults).filter((g) => plan.available.includes(g))
      if (want.length === 0) return undefined
      const before = loaded.size
      for (const g of want) loaded.add(g)
      if (loaded.size === before) return undefined
      return {
        context: {
          systemPrompt: opts?.systemPrompt ?? promptFor(loaded),
          messages: ctx.context.messages,
          tools: buildAgentToolsForGroups(loaded),
          toolGroups: [...loaded],
        },
      }
    },
  })

  if (handlers) {
    let textAcc = ''
    let thinkingAcc = ''
    agent.subscribe((e) => {
      if (e.type === 'message_update') {
        const ev = e.assistantMessageEvent
        if (ev.type === 'text_delta') {
          textAcc += ev.delta
          handlers.onText?.(textAcc)
        } else if (ev.type === 'thinking_delta') {
          thinkingAcc += ev.delta
          handlers.onThinking?.(thinkingAcc)
        } else if (ev.type === 'thinking_end') {
          thinkingAcc = ev.content
          handlers.onThinking?.(thinkingAcc)
        }
      } else if (e.type === 'tool_execution_start') {
        // 工具后模型重新输出最终答复：文本累积从头计，避免工具前零星文本混进协议流
        textAcc = ''
        handlers.onToolStart?.(e.toolName, e.args)
      } else if (e.type === 'tool_execution_end') {
        // 结果里的结构化载荷与图片随摘要一起交给调用方：过程卡的文件卡片（present_file）、
        // 放大镜的结果图与元数据都靠这两项（见 agentProtocol 的 toolDetailsFromResult）
        const r = e.result as { details?: unknown; image?: { base64: string; mime: string } } | null
        handlers.onToolEnd?.(e.toolName, !e.isError, resultBrief(e.result), r?.image, r?.details)
      }
    })
  }

  const outgoingImgs = outgoing.images ?? (outgoing.image ? [outgoing.image] : [])
  await agent.prompt(
    outgoing.text || `（用户发来 ${outgoingImgs.length || 1} 张图片，请结合图片内容回应）`,
    outgoingImgs.length > 0
      ? outgoingImgs.map((im) => ({ type: 'image' as const, data: im.data, mimeType: im.mimeType }))
      : undefined,
  )
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

  const text = lastAssistantText(agent.state.messages)
  const thinking = assistantThink(agent.state.messages)

  // 本机记账：服务端（在线模型）另有权威账本，这里保证离线也看得见成本
  const usage = lastAssistantUsage(agent.state.messages)
  if (usage) {
    await recordTurn(config, usage, {
      request: estimateRequestBytes(outgoing.text, outgoingImgs.map((im) => im.data)),
      response: estimateResponseBytes(text, thinking),
    })
  }

  return { text, thinking, loadedGroups: [...loaded] }
}
