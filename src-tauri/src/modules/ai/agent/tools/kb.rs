//! 知识库域工具（对应 TS tools/knowledge.ts + notes.ts + workspace.ts + memory.ts）。
//!
//! 组：knowledge（检索/读取/路径/笔记读写/模态与治理 10 个）+ memory（长期记忆 5 个）。
//! 命令层直接复用 `modules/kb`（State 从 AppHandle 现取），投影与 TS 版逐字段对齐。

use serde_json::{json, Value};
use tauri::Manager;

use crate::error::{ReinError, Result};
use crate::modules::kb::commands as kb;
use crate::modules::kb::models::{
    KbDocDetail, KbFile, KbHit, KbMedia, KbQuery,
};
use crate::modules::kb::shard::commands as shard_cmd;
use crate::modules::kb::shard::model::{MemoryShard, ShardPatch, ShardWriteAction};
use crate::modules::kb::worker::KbHub;
use crate::state::AppState;
use std::sync::Arc;

use super::{str_arg, RegisteredTool};

/* ---------- defs ---------- */

pub fn search_knowledge() -> RegisteredTool {
    RegisteredTool {
        name: "search_knowledge",
        group: "knowledge",
        label: "检索知识库",
        description: "在用户的全部应用数据与长期记忆中做跨来源检索（日程与附件、运动记录、训练课程、饮食与体测、健康方案、语音纪要、历史聊天、长期记忆）。用户问「我之前/上周/有没有……」「我是不是……」「关于膝盖的记录」这类需要跨来源回忆或找规律的问题时用它。返回的是摘要级命中（标题 + 命中片段），要正文再用 read_knowledge。不传 query 表示按日期倒序浏览最近内容。",
        parameters: json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "检索词。建议用 2~6 个字的简短关键词（如「膝盖」「腿部训练」「蛋白质」）；中文两字词也能命中。留空表示按日期倒序浏览最近内容。" },
                "sources": { "type": "array", "items": { "type": "string", "enum": ["todo","workout","plan","meal","body_metric","food","program","program_meal","voice_memo","chat_message","memory"], "description": "限定来源类别：todo=日程/附件、workout=运动、plan=课程、meal=饮食、body_metric=体测、food=自建食物、program=方案、program_meal=方案菜单、voice_memo=语音纪要、chat_message=历史聊天、memory=长期记忆。不传=全部" } },
                "from": { "type": "string", "description": "起始日期 YYYY-MM-DD（含），按内容所属日期过滤" },
                "to": { "type": "string", "description": "结束日期 YYYY-MM-DD（含）" },
                "tags": { "type": "array", "items": { "type": "string" }, "description": "标签精确匹配，如分类名" },
                "limit": { "type": "number", "description": "最多返回条数，默认 8，上限 20" }
            }
        }),
    }
}

pub fn read_knowledge() -> RegisteredTool {
    RegisteredTool {
        name: "read_knowledge",
        group: "knowledge",
        label: "读取知识库条目",
        description: "按 search_knowledge 返回的 id 读取完整内容。默认 level=l1 只给摘要与首段（够判断相关性）；确实需要全部细节时才用 level=l2。",
        parameters: json!({
            "type": "object",
            "properties": {
                "docId": { "type": "number", "description": "search_knowledge 返回的 id" },
                "level": { "type": "string", "enum": ["l1", "l2"], "description": "l1=概览（摘要+首段，默认）；l2=分块正文（可分页）" },
                "offset": { "type": "number", "description": "l2 起始块序（从 0 起），默认 0" },
                "limit": { "type": "number", "description": "l2 最多取几块，默认 8，上限 64" }
            },
            "required": ["docId"]
        }),
    }
}

pub fn glob_knowledge() -> RegisteredTool {
    RegisteredTool {
        name: "glob_knowledge",
        group: "knowledge",
        label: "按路径列文件",
        description: "在知识库的虚拟文件系统里按路径模式列文档（ls）。* 不跨目录、** 跨目录、? 单字符。例：笔记/*.md 列全部笔记、对话/**/*.md 列全部对话内容、日程/2026-09-10/*.md 列某天的日程、附件/** 列全部附件编目。用户问「有哪些笔记」「我的文件」「某天记了什么」或想按文件名找东西时用它——关键词搜正文用 search_knowledge，按名字找文件用这个。",
        parameters: json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "路径模式，如 笔记/*.md、对话/**、附件/**" },
                "limit": { "type": "number", "description": "最多返回条数，默认 50，上限 200" }
            },
            "required": ["pattern"]
        }),
    }
}

const PATH_DESC: &str = "文件路径。不写根目录时自动归到「笔记/」下（写「膝盖」会存为 笔记/膝盖.md，.md 可省略）；可写根目录：笔记 / 文档 / 未分类数据 / 语音 / 视频 / 用户记忆，以及各领域目录里的用户子目录（如「运动/知识/跑步」）。可用子目录分层。带日期目录或 -编号 的派生路径会被自动让位。";

pub fn write_note() -> RegisteredTool {
    RegisteredTool {
        name: "write_note",
        group: "knowledge",
        label: "写笔记",
        description: "在知识库里新建或覆盖一篇 markdown 笔记（按路径幂等：同路径即覆盖）。**仅当用户明确要求「记下来/写个笔记/帮我存一下」时调用**；对话里的偏好由系统在会话结束时自动提炼，不要用笔记代替记忆。内容写 markdown；要记住的是「关于用户的认知」时改用 remember。",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": PATH_DESC },
                "content": { "type": "string", "description": "markdown 正文，不能为空" }
            },
            "required": ["path", "content"]
        }),
    }
}

pub fn rename_note() -> RegisteredTool {
    RegisteredTool {
        name: "rename_note",
        group: "knowledge",
        label: "笔记改名",
        description: "给笔记改名或移动到子目录（先 glob_knowledge 查路径）。**仅当用户明确要求时调用。**",
        parameters: json!({
            "type": "object",
            "properties": {
                "docId": { "type": "number", "description": "glob_knowledge / search_knowledge 返回的 id" },
                "path": { "type": "string", "description": PATH_DESC }
            },
            "required": ["docId", "path"]
        }),
    }
}

pub fn delete_note() -> RegisteredTool {
    RegisteredTool {
        name: "delete_note",
        group: "knowledge",
        label: "删笔记",
        description: "删除一篇笔记。**仅当用户明确要求删除时调用**（先 glob_knowledge 查 id）。",
        parameters: json!({
            "type": "object",
            "properties": { "docId": { "type": "number", "description": "笔记的 id" } },
            "required": ["docId"]
        }),
    }
}

pub fn read_modal() -> RegisteredTool {
    RegisteredTool {
        name: "read_modal",
        group: "knowledge",
        label: "取文件模态",
        description: "读取一个文件节点的模态清单，或指定模态取本体。音频/视频/图片的**字节不会进上下文**：可用时返回元信息（mime、大小、时长）与「已把本体交给界面」的标记，不可用时**降级为文本**并给出原因。先 glob_knowledge / search_knowledge 拿到 id；用户问「这段录音/视频里说了什么」时用它取文本模态，需要完整文本再用 read_knowledge 分页读。",
        parameters: json!({
            "type": "object",
            "properties": {
                "docId": { "type": "number", "description": "glob_knowledge / search_knowledge 返回的 id" },
                "modal": { "type": "string", "description": "text | image | audio | video；不传只返回模态清单" }
            },
            "required": ["docId"]
        }),
    }
}

pub fn classify_move() -> RegisteredTool {
    RegisteredTool {
        name: "classify_move",
        group: "knowledge",
        label: "归类文件",
        description: "把用户文件（笔记 / 上传 / 未分类内容）移进语义合适的目录（如「运动」「饮食」「日程」「用户记忆」）。**这是你的整理职责**：新内容落在「未分类数据/」时，看内容判断归属并调用它，reason 写清依据。约束：派生文档（目录里带日期或 -编号的）不可移动；被用户 pin 的文件会拒绝；一天内自动移动过的同一文件会被防抖挡住。用户手动放好的东西不要动。",
        parameters: json!({
            "type": "object",
            "properties": {
                "docId": { "type": "number", "description": "要移动的文件 id（glob_knowledge 查）" },
                "toDir": { "type": "string", "description": "目标目录，如「运动」「饮食/知识」「笔记/训练」" },
                "reason": { "type": "string", "description": "为什么归到这里（一句话）" }
            },
            "required": ["docId", "toDir", "reason"]
        }),
    }
}

pub fn pin_file() -> RegisteredTool {
    RegisteredTool {
        name: "pin_file",
        group: "knowledge",
        label: "钉住文件",
        description: "把文件钉住（pin）或取消钉住。钉住后 AI 的自动整理不再移动它——用户说「这个别乱动/固定在这里」时调用；用户说「可以整理了」再取消。",
        parameters: json!({
            "type": "object",
            "properties": {
                "docId": { "type": "number", "description": "文件 id" },
                "pinned": { "type": "boolean", "description": "true 钉住，false 取消" }
            },
            "required": ["docId", "pinned"]
        }),
    }
}

pub fn make_folder() -> RegisteredTool {
    RegisteredTool {
        name: "make_folder",
        group: "knowledge",
        label: "建目录",
        description: "在工作区里建一个目录（空目录也会显示在文件树里）。确实需要新的分类层级时才建，别为一次归类建一堆空目录；深度最多 4 层。派生命名空间（日期目录、附件/）不能建。",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "目录路径，如「运动/知识」" },
                "reason": { "type": "string", "description": "为什么需要这个目录" }
            },
            "required": ["path", "reason"]
        }),
    }
}

/* ---------- 压缩包（打开 / 解压） ---------- */

pub fn list_archive() -> RegisteredTool {
    RegisteredTool {
        name: "list_archive",
        group: "knowledge",
        label: "打开压缩包",
        description: "打开一个压缩包（zip / tar / tar.gz / 单个 gz），列出里面有什么文件、多大、压缩比。**先用它再决定解不解压**：用户说「这个包里是什么」「帮我看看压缩包」或需要确认内容时调用。参数 docId 用 glob_knowledge 查（压缩包必须是上传到工作区的文件）。解压用 extract_archive。",
        parameters: json!({
            "type": "object",
            "properties": {
                "docId": { "type": "number", "description": "压缩包文件的 docId（glob_knowledge 查）" }
            },
            "required": ["docId"]
        }),
    }
}

pub fn extract_archive() -> RegisteredTool {
    RegisteredTool {
        name: "extract_archive",
        group: "knowledge",
        label: "解压压缩包",
        description: "把压缩包解压进工作区：文本文件（md/txt/csv/json/代码等）成为可检索的笔记，其它文件（图片/音频/文档/二进制）本体落盘、按需取用。**用户说「解压/展开/把里面文件拿出来」时调用**。默认落到「未分类数据/解压/包名/」下；同名目录自动让位，绝不覆盖既有文件。安全护栏：带 .. / 绝对路径的条目会被跳过，超过 300 个文件或 256 MB 会截断（返回里会说明）。解压完成后可以按内容把文件归类（classify_move）。",
        parameters: json!({
            "type": "object",
            "properties": {
                "docId": { "type": "number", "description": "压缩包文件的 docId（先 list_archive 看过再解）" },
                "toDir": { "type": "string", "description": "落点目录（可选），如「笔记/课程资料」；不传则落「未分类数据/解压/{包名}」" },
                "only": { "type": "array", "items": { "type": "string" }, "description": "只解压路径里包含这些子串的条目，如 [\"复习\", \"docx\"]；不传=全部" }
            },
            "required": ["docId"]
        }),
    }
}

/* ---------- 空间管理 ---------- */

pub fn workspace_usage() -> RegisteredTool {
    RegisteredTool {
        name: "workspace_usage",
        group: "knowledge",
        label: "看工作区占用",
        description: "看工作区（知识库 + 虚拟文件系统）的存储占用总览：总量、文本/本体/索引各占多少、按目录与来源的分布、最大的几个文件、有没有可清理的碎片。用户问「占了多大空间」「什么东西最占地方」「帮我看看存储」时调用。只读；清理要用户点确认，不要自己删。",
        parameters: json!({
            "type": "object",
            "properties": {
                "top": { "type": "number", "description": "大文件榜返回条数，默认 10，上限 50" }
            }
        }),
    }
}

pub fn find_large_files() -> RegisteredTool {
    RegisteredTool {
        name: "find_large_files",
        group: "knowledge",
        label: "找大文件",
        description: "按体积倒序列出工作区里的文件（文本节点 + 本体一起算），可按最小体积过滤。用户问「哪些文件最大」「帮我找占地方的文件」时用它；要整体占用面用 workspace_usage。",
        parameters: json!({
            "type": "object",
            "properties": {
                "limit": { "type": "number", "description": "返回条数，默认 15，上限 50" },
                "minBytes": { "type": "number", "description": "只看大于这个字节数的文件（如 1048576 = 1 MB）" }
            }
        }),
    }
}

pub fn present_file() -> RegisteredTool {
    RegisteredTool {
        name: "present_file",
        group: "knowledge",
        label: "挂出文件",
        description: "把一个工作区文件作为**文件卡片**挂到聊天里给用户（卡片可点开阅读，目录卡片可跳进文件管理器）。用户会想点开看、或需要一份产物的场景才挂：刚写好的笔记、解压 / 导出出来的文件、他一直在找的那份东西 —— 讲完内容顺手挂一张，别只在文字里报个路径。path 用 glob_knowledge / write_note / list_archive 结果里的那个 path（少写 .md 后缀、或省掉「笔记/」根目录也认）。一次回复挂 1~3 张就够，铺满卡片反而没人看；纯内部整理（归类、建目录、钉住）不要挂。",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "文件或目录路径，如 笔记/膝盖养护.md、未分类数据/解压/备份" }
            },
            "required": ["path"]
        }),
    }
}

pub fn list_memories() -> RegisteredTool {
    RegisteredTool {
        name: "list_memories",
        group: "memory",
        label: "查看长期记忆",
        description: "列出已经记住的关于用户的长期记忆（偏好、约束、事件、实体、画像、规律）。用户问「你记得我什么」「你了解我哪些」时调用。系统提示词里已经带了最相关的若干条，所以一般不必先调它。",
        parameters: json!({
            "type": "object",
            "properties": {
                "memType": { "type": "string", "enum": ["preference","constraint","event","entity","profile","pattern"], "description": "记忆类型：preference=偏好（喜欢/讨厌）、constraint=约束（伤病/禁忌/时间限制）、event=事件（做过什么及其原因）、entity=实体（人/地点/器械/课程）、profile=稳定画像（作息/经验水平）、pattern=反复出现的规律。不传则列出全部类型" }
            }
        }),
    }
}

pub fn recall_memory() -> RegisteredTool {
    RegisteredTool {
        name: "recall_memory",
        group: "memory",
        label: "回忆长期记忆",
        description: "主动检索长期记忆（比 list_memories 更广：含休眠记忆与对话中提炼的片段）。用户问「我之前是不是说过…」「我以前提过…」，或你需要找旧对话里的细节/来源时用它。返回 content、relevance，以及 anchorMessageId/chatId 供界面跳回原对话。命中会轻微强化记忆，不要对同一话题高频重复调用。",
        parameters: json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "检索词，用 2~6 个字的简短关键词（如「膝盖」「睡眠」）；越长越依赖语义向量" },
                "topK": { "type": "number", "description": "最多返回几条（默认 8，范围 1~20）" },
                "includeDormant": { "type": "boolean", "description": "是否包含休眠记忆（默认 true）" },
                "includeArchived": { "type": "boolean", "description": "是否挖坟已归档记忆（默认 false；只返回，不自动复活）" }
            },
            "required": ["query"]
        }),
    }
}

pub fn remember() -> RegisteredTool {
    RegisteredTool {
        name: "remember",
        group: "memory",
        label: "记住一件事",
        description: "把一条关于用户的长期信息写进记忆。**仅当用户明确要求记住时调用**（如「记住我不吃香菜」）；日常对话里的偏好由系统在会话结束时自动提炼，不要主动调用本工具刷记忆。",
        parameters: json!({
            "type": "object",
            "properties": {
                "content": { "type": "string", "description": "要记住的内容，写成一句完整、自洽、脱离上下文也能读懂的话，如「膝盖不适，深蹲不宜超过 60kg」" },
                "memType": { "type": "string", "enum": ["preference","constraint","event","entity","profile","pattern"], "description": "同 list_memories；不传默认 preference" },
                "topic": { "type": "string", "description": "主题短标签，如「膝盖」「饮食」，便于分组与去重" }
            },
            "required": ["content"]
        }),
    }
}

pub fn edit_memory() -> RegisteredTool {
    RegisteredTool {
        name: "edit_memory",
        group: "memory",
        label: "修改记忆",
        description: "修改一条已有长期记忆的内容/主题/类型（先 list_memories 拿 id）。用户说「我改主意了/这条不对/更新一下」时用它；只传要改的字段。",
        parameters: json!({
            "type": "object",
            "properties": {
                "memoryId": { "type": "number", "description": "list_memories 返回的 id" },
                "content": { "type": "string", "description": "改后的内容（一句话、自洽）" },
                "topic": { "type": "string", "description": "改后的主题短标签" },
                "memType": { "type": "string", "enum": ["preference","constraint","event","entity","profile","pattern"], "description": "改后的类型" }
            },
            "required": ["memoryId"]
        }),
    }
}

pub fn forget() -> RegisteredTool {
    RegisteredTool {
        name: "forget",
        group: "memory",
        label: "忘掉一条记忆",
        description: "按 id 删除一条长期记忆。**仅当用户明确要求忘掉/删掉某条记忆时调用**，先用 list_memories 拿到 id。",
        parameters: json!({
            "type": "object",
            "properties": { "memoryId": { "type": "number", "description": "list_memories 返回的 id" } },
            "required": ["memoryId"]
        }),
    }
}

/* ---------- 执行 ---------- */

fn i64_arg(args: &Value, key: &str) -> Result<i64> {
    args.get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .ok_or_else(|| ReinError::Message(format!("参数 {key} 缺失或不是数字")))
}

fn opt_day(args: &Value, key: &str) -> Result<Option<String>> {
    let v = match args.get(key).and_then(|x| x.as_str()) {
        Some(s) => s.trim(),
        None => return Ok(None),
    };
    if v.is_empty() {
        return Ok(None);
    }
    let bytes = v.as_bytes();
    let ok = v.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && v[..4].bytes().all(|b| b.is_ascii_digit())
        && v[5..7].bytes().all(|b| b.is_ascii_digit())
        && v[8..].bytes().all(|b| b.is_ascii_digit());
    if !ok {
        return Err(ReinError::Message(format!(
            "{key} 格式应为 YYYY-MM-DD，收到「{v}」"
        )));
    }
    Ok(Some(v.to_string()))
}

/// 本模块负责执行的名字。
///
/// `run` 先用它挡一道；测试用它断言「注册表 ⊆ 各域认领」。名单与下面 `run` 的
/// match 分支必须一致——两处挨着写，漂移一眼可见；万一真漂了，`run_tool` 的
/// 兜底守卫会报「已登记但没有执行器」，而不是静默不执行。
pub fn handles(name: &str) -> bool {
    matches!(
        name,
        "search_knowledge"
            | "read_knowledge"
            | "glob_knowledge"
            | "write_note"
            | "rename_note"
            | "delete_note"
            | "read_modal"
            | "classify_move"
            | "pin_file"
            | "make_folder"
            | "list_archive"
            | "extract_archive"
            | "workspace_usage"
            | "find_large_files"
            | "present_file"
            | "list_memories"
            | "recall_memory"
            | "remember"
            | "edit_memory"
            | "forget"
    )
}

/// 分派执行；返回 None 表示名字不归本模块
pub async fn run(app: &tauri::AppHandle, name: &str, args: &Value) -> Option<Result<Value>> {
    if !handles(name) {
        return None;
    }
    Some(match name {
        "search_knowledge" => run_search(app, args).await,
        "read_knowledge" => run_read(app, args).await,
        "glob_knowledge" => run_glob(app, args).await,
        "write_note" => run_write_note(app, args).await,
        "rename_note" => run_rename_note(app, args).await,
        "delete_note" => run_delete_note(app, args).await,
        "read_modal" => run_read_modal(app, args).await,
        "classify_move" => run_classify_move(app, args).await,
        "pin_file" => run_pin_file(app, args).await,
        "make_folder" => run_make_folder(app, args).await,
        "list_memories" => run_list_memories(app, args).await,
        "recall_memory" => run_recall_memory(app, args).await,
        "remember" => run_remember(app, args).await,
        "edit_memory" => run_edit_memory(app, args).await,
        "forget" => run_forget(app, args).await,
        "list_archive" => run_list_archive(app, args).await,
        "extract_archive" => run_extract_archive(app, args).await,
        "workspace_usage" => run_workspace_usage(app, args).await,
        "find_large_files" => run_find_large_files(app, args).await,
        "present_file" => run_present_file(app, args).await,
        _ => return None,
    })
}

fn kb_query(args: &Value) -> Result<KbQuery> {
    Ok(KbQuery {
        query: args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim().to_string(),
        sources: args
            .get("sources")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        from: opt_day(args, "from")?,
        to: opt_day(args, "to")?,
        tags: args
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        limit: Some(super::num_arg(args, "limit", 8.0).clamp(1.0, 20.0) as i64),
    })
}

fn hit_projection(h: &KbHit) -> Value {
    json!({
        "id": h.id,
        "path": h.path,
        "editable": h.editable,
        "source": h.source_type,
        "title": h.title,
        "snippet": h.snippet,
        "date": h.occurred_on,
        "tags": h.tags,
    })
}

async fn run_search(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let hits = kb::kb_search(
        app.clone(),
        app.state::<AppState>(),
        app.state::<Arc<crate::modules::kb::worker::KbHub>>(),
        kb_query(args)?,
    )?;
    let items: Vec<Value> = hits.iter().map(hit_projection).collect();
    let hint = if hits.is_empty() {
        "没有命中。可以换个更短的关键词，或去掉日期/来源限制再试。"
    } else {
        "要某条的完整内容，用 read_knowledge 传它的 id。"
    };
    Ok(json!({ "total": hits.len(), "items": items, "hint": hint }))
}

fn doc_projection(d: &KbDocDetail, cap: usize) -> Value {
    let next_offset = d.offset + d.chunks.len() as i64;
    json!({
        "id": d.id,
        "path": d.path,
        "source": d.source_type,
        "editable": d.editable,
        "title": d.title,
        "date": d.occurred_on,
        "tags": d.tags,
        "summary": d.summary,
        "content": d.chunks.iter().map(|c| c.text.chars().take(cap).collect::<String>()).collect::<Vec<_>>(),
        "totalChunks": d.total_chunks,
        "offset": d.offset,
        "hasMore": d.has_more,
        "nextOffset": d.has_more.then_some(next_offset),
        "hint": d.has_more.then(|| format!("共 {} 块，当前到第 {} 块；继续读请传 offset: {}。", d.total_chunks, next_offset, next_offset)),
    })
}

async fn run_read(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let doc_id = i64_arg(args, "docId")?;
    let level = if args.get("level").and_then(|v| v.as_str()) == Some("l2") { "l2" } else { "l1" };
    let offset = args.get("offset").and_then(|v| v.as_f64()).map(|f| f as i64);
    let limit = args.get("limit").and_then(|v| v.as_f64()).map(|f| f as i64);
    let d = kb::kb_read(app.clone(), app.state::<AppState>(), doc_id, Some(level.into()), offset, limit)?;
    Ok(doc_projection(&d, if level == "l2" { 1200 } else { 300 }))
}

async fn run_glob(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let pattern = str_arg(args, "pattern")?.to_string();
    let limit = super::num_arg(args, "limit", 50.0).clamp(1.0, 200.0) as i64;
    let items = kb::kb_glob(app.clone(), app.state::<AppState>(), pattern, Some(limit))?;
    let items: Vec<Value> = items
        .iter()
        .map(|f| {
            json!({
                "id": f.id, "path": f.path, "source": f.source_type, "kind": f.kind,
                "editable": f.editable, "date": f.occurred_on, "title": f.title,
            })
        })
        .collect();
    let hint = if items.is_empty() {
        "没有匹配的路径。检查目录名（日程/运动/课程/饮食/体测/食物/方案/菜单/纪要/对话/附件/记忆/笔记/规范）或换 * / ** 试。"
    } else {
        "要某条的正文用 read_knowledge 传 id；要改某条先看 editable 字段。"
    };
    Ok(json!({ "total": items.len(), "items": items, "hint": hint }))
}

async fn run_write_note(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let path = str_arg(args, "path")?.trim().to_string();
    let content = str_arg(args, "content")?.trim().to_string();
    if content.is_empty() {
        return Err(ReinError::Message("笔记内容不能为空".into()));
    }
    let f = kb::kb_file_write(app.state::<AppState>(), app.state::<Arc<crate::modules::kb::worker::KbHub>>(), crate::modules::kb::models::KbFileInput { path, content })?;
    Ok(json!({ "ok": true, "id": f.id, "path": f.path, "message": format!("已保存到 {}", f.path) }))
}

async fn run_rename_note(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let id = i64_arg(args, "docId")?;
    let path = str_arg(args, "path")?.trim().to_string();
    let f = kb::kb_file_rename(app.state::<AppState>(), app.state::<Arc<crate::modules::kb::worker::KbHub>>(), id, path)?;
    Ok(json!({ "ok": true, "path": f.path, "message": format!("已改名为 {}", f.path) }))
}

async fn run_delete_note(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let id = i64_arg(args, "docId")?;
    kb::kb_file_delete(app.clone(), app.state::<AppState>(), app.state::<Arc<crate::modules::kb::worker::KbHub>>(), id)?;
    Ok(json!({ "ok": true, "message": "已删除该笔记" }))
}

/// 文本模态直接回给模型的上限；全文要走 read_knowledge 分页读（对齐 TS TEXT_INLINE_CAP）
const TEXT_INLINE_CAP: usize = 1200;

async fn run_read_modal(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let doc_id = i64_arg(args, "docId")?;
    let modal = args
        .get("modal")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let m: KbMedia = kb::kb_media_get(app.clone(), app.state::<AppState>(), doc_id, modal)?;
    let text = m.text.as_deref().map(|t| {
        if t.chars().count() > TEXT_INLINE_CAP {
            let head: String = t.chars().take(TEXT_INLINE_CAP).collect();
            format!("{head}…（还有更多，用 read_knowledge 分页读）")
        } else {
            t.to_string()
        }
    });
    Ok(json!({
        "ok": true,
        "path": m.path,
        "title": m.title,
        "kind": m.kind,
        "modalities": m.modalities,
        "requested": m.requested,
        "degraded": m.degraded,
        "degradeReason": m.degrade_reason,
        "mime": m.mime,
        "deliveredToUi": m.data_url.is_some(),
        "text": text,
    }))
}

async fn run_classify_move(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let id = i64_arg(args, "docId")?;
    let to_dir = str_arg(args, "toDir")?.trim().to_string();
    let reason = str_arg(args, "reason")?.trim().to_string();
    let r = kb::kb_fs_move(app.state::<AppState>(), app.state::<Arc<crate::modules::kb::worker::KbHub>>(), id, to_dir, Some(reason), Some("ai".into()))?;
    Ok(json!({
        "ok": true, "from": r.from, "path": r.to, "batchId": r.batch_id,
        "message": format!("已从 {} 归类到 {}", r.from, r.to),
    }))
}

async fn run_pin_file(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let id = i64_arg(args, "docId")?;
    let pinned = args.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);
    let f: KbFile = kb::kb_fs_pin(app.state::<AppState>(), app.state::<Arc<crate::modules::kb::worker::KbHub>>(), id, pinned, Some("user".into()))?;
    Ok(json!({ "ok": true, "path": f.path, "pinned": f.pinned }))
}

async fn run_make_folder(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let path = str_arg(args, "path")?.trim().to_string();
    let reason = str_arg(args, "reason")?.trim().to_string();
    let f = kb::kb_fs_mkdir(app.state::<AppState>(), app.state::<Arc<crate::modules::kb::worker::KbHub>>(), path, Some(reason), Some("ai".into()))?;
    Ok(json!({ "ok": true, "path": f.path, "message": format!("已建目录 {}", f.path) }))
}

fn memory_brief(m: &MemoryShard) -> Value {
    json!({
        "id": m.id,
        "type": m.mem_type,
        "topic": if m.topic.is_empty() { Value::Null } else { json!(m.topic) },
        "content": m.content.chars().take(200).collect::<String>(),
        "confidence": (m.confidence * 100.0).round() / 100.0,
        "state": m.state,
    })
}

async fn run_list_memories(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let mem_type = args
        .get("memType")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let items = shard_cmd::memory_shard_list(
        app.state::<AppState>(),
        Some("all".into()),
        Some("curated".into()),
        Some(120),
        Some(0),
    )?;
    let items: Vec<Value> = items
        .iter()
        // 查看长期记忆默认不翻归档区；dormant 仍可见（用户问「你记得什么」时应看到）。
        .filter(|m| m.state != "archived")
        .filter(|m| {
            mem_type
                .as_deref()
                .map(|t| m.mem_type == t)
                .unwrap_or(true)
        })
        .take(50)
        .map(memory_brief)
        .collect();
    Ok(json!({ "total": items.len(), "items": items }))
}

async fn run_recall_memory(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let query = str_arg(args, "query")?.trim().to_string();
    if query.is_empty() {
        return Err(ReinError::Message("检索词不能为空".into()));
    }
    let top_k = super::num_arg(args, "topK", 8.0).clamp(1.0, 20.0) as i64;
    let include_dormant = args
        .get("includeDormant")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let include_archived = args
        .get("includeArchived")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let r = shard_cmd::memory_shard_search(
        app.state::<AppState>(),
        app.state::<Arc<KbHub>>(),
        query,
        Some(top_k),
        Some(include_dormant),
        Some(include_archived),
        None,
    )?;
    let items: Vec<Value> = r
        .hits
        .iter()
        .map(|h| {
            json!({
                "id": h.shard_id,
                "content": h.content,
                "type": h.mem_type,
                "topic": h.topic,
                "category": h.category,
                "origin": h.origin,
                "state": h.state,
                "relevance": h.relevance,
                "effectiveWeight": h.effective_weight,
                "anchorMessageId": h.anchor_message_id,
                "chatId": h.chat_id,
                "createdAt": h.created_at,
            })
        })
        .collect();
    Ok(json!({
        "total": r.hits.len(),
        "mode": r.mode,
        "reinforced": r.reinforced,
        "revived": r.revived,
        "items": items,
        "hint": "命中只是摘要；要展开原对话把 anchorMessageId/chatId 交给界面。",
    }))
}

async fn run_remember(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let content = str_arg(args, "content")?.trim().to_string();
    if content.is_empty() {
        return Err(ReinError::Message("要记住的内容不能为空".into()));
    }
    let mem_type = args
        .get("memType")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let topic = args
        .get("topic")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let r = shard_cmd::memory_shard_apply(
        app.state::<AppState>(),
        app.state::<Arc<KbHub>>(),
        vec![ShardWriteAction {
            op: "add".into(),
            id: None,
            content: Some(content.clone()),
            mem_type,
            topic,
            category: None,
            confidence: None,
            reason: None,
        }],
        None,
        None,
    )?;
    let message = if r.added > 0 {
        format!("已记住：{content}")
    } else if r.restored > 0 {
        format!("已重新记住：{content}")
    } else {
        format!("这条已经记过了：{content}")
    };
    Ok(json!({ "ok": true, "message": message }))
}

async fn run_edit_memory(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let id = i64_arg(args, "memoryId")?;
    let mem_type = args
        .get("memType")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let topic = args
        .get("topic")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if mem_type.is_none() && topic.is_none() && content.is_none() {
        return Err(ReinError::Message(
            "没有要修改的字段：content / topic / memType 至少传一个".into(),
        ));
    }
    // 部分更新：只改传入字段；归档中的条会被复活（restored 不再误报不存在）。
    shard_cmd::memory_shard_update(
        app.state::<AppState>(),
        app.state::<Arc<KbHub>>(),
        id,
        ShardPatch {
            content,
            mem_type,
            topic,
            category: None,
        },
    )?;
    Ok(json!({ "ok": true, "message": "已更新该条记忆" }))
}

async fn run_forget(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let id = i64_arg(args, "memoryId")?;
    let ok = shard_cmd::memory_shard_delete(
        app.state::<AppState>(),
        app.state::<Arc<KbHub>>(),
        id,
    )?;
    if !ok {
        return Err(ReinError::Message(format!(
            "记忆不存在：id={id}（先用 list_memories 查 id）"
        )));
    }
    Ok(json!({ "ok": true, "message": "已删除该条记忆" }))
}

/* ---------- 压缩包 ---------- */

fn human_bytes(n: i64) -> String {
    if n >= 1024 * 1024 * 1024 {
        format!("{:.2} GB", n as f64 / 1073741824.0)
    } else if n >= 1024 * 1024 {
        format!("{:.1} MB", n as f64 / 1048576.0)
    } else if n >= 1024 {
        format!("{} KB", n / 1024)
    } else {
        format!("{n} B")
    }
}

async fn run_list_archive(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let doc_id = i64_arg(args, "docId")?;
    let l = kb::kb_archive_list(app.clone(), app.state::<AppState>(), doc_id)?;
    // 只回前 80 条给模型：压缩包动辄几百条，全塞进上下文是浪费
    let shown: Vec<Value> = l
        .entries
        .iter()
        .take(80)
        .map(|e| {
            json!({
                "path": e.path,
                "size": human_bytes(e.size),
                "dir": e.is_dir,
                "text": e.text,
                "skipped": e.skipped,
            })
        })
        .collect();
    Ok(json!({
        "ok": true,
        "format": l.format,
        "total": l.total,
        "totalBytes": l.total_bytes,
        "packedBytes": l.packed_bytes,
        "entries": shown,
        "truncated": l.total > 80,
        "notes": l.notes,
        "hint": "要解压就用 extract_archive（可传 only 只取部分）；文本文件解压后会进检索。",
    }))
}

async fn run_extract_archive(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let doc_id = i64_arg(args, "docId")?;
    let to_dir = args.get("toDir").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let only: Vec<String> = args
        .get("only")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(str::to_string).collect())
        .unwrap_or_default();
    let r = kb::kb_archive_extract(
        app.clone(),
        app.state::<AppState>(),
        app.state::<Arc<crate::modules::kb::worker::KbHub>>(),
        doc_id,
        to_dir,
        Some(only),
    )?;
    let files: Vec<Value> = r
        .extracted
        .iter()
        .take(60)
        .map(|i| json!({ "id": i.id, "path": i.path, "bytes": i.bytes, "kind": i.kind }))
        .collect();
    Ok(json!({
        "ok": true,
        "target": r.target,
        "count": r.extracted.len(),
        "bytes": r.bytes,
        "files": files,
        "skipped": r.skipped.iter().take(20).collect::<Vec<_>>(),
        "truncated": r.truncated,
        "message": r.message,
        "hint": "文本文件已进检索（可用 search_knowledge 搜到）；需要按内容整理就用 classify_move。",
    }))
}

/* ---------- 空间管理 ---------- */

async fn run_workspace_usage(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let top = super::num_arg(args, "top", 10.0).clamp(0.0, 50.0) as i64;
    let r = kb::kb_usage(app.clone(), app.state::<AppState>(), Some(top), None)?;
    Ok(json!({
        "ok": true,
        "total": r.total_bytes,
        "totalText": human_bytes(r.total_bytes),
        "textBytes": r.text_bytes,
        "assetBytes": r.asset_bytes,
        "indexBytes": r.index_bytes,
        "dbBytes": r.db_bytes,
        "files": r.file_count,
        "docs": r.doc_count,
        "assets": r.asset_count,
        "areas": r.areas.iter().take(10).map(|a| json!({
            "name": a.name, "bytes": a.bytes, "human": human_bytes(a.bytes), "count": a.count
        })).collect::<Vec<_>>(),
        "sources": r.sources.iter().take(10).map(|a| json!({
            "name": a.name, "bytes": a.bytes, "human": human_bytes(a.bytes), "count": a.count
        })).collect::<Vec<_>>(),
        "modals": r.modals.iter().map(|a| json!({
            "name": a.name, "bytes": a.bytes, "human": human_bytes(a.bytes), "count": a.count
        })).collect::<Vec<_>>(),
        "largest": r.largest.iter().map(|f| json!({
            "id": f.id, "path": f.path, "kind": f.kind,
            "bytes": f.bytes, "human": human_bytes(f.bytes), "updatedAt": f.updated_at
        })).collect::<Vec<_>>(),
        "orphans": { "count": r.orphan_count, "bytes": r.orphan_bytes, "human": human_bytes(r.orphan_bytes) },
        "missingAssets": r.missing_count,
        "summary": r.summary,
        "hint": "清理碎片要在文件管理器里由用户确认（本工具只读）。",
    }))
}

async fn run_find_large_files(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let limit = super::num_arg(args, "limit", 15.0).clamp(1.0, 50.0) as i64;
    let min_bytes = super::num_arg(args, "minBytes", 0.0).max(0.0) as i64;
    // 直接走榜单查询：不跑整份占用报告（那份还要全表聚合 + 目录遍历 + 逐本体 stat，
    // 「找大文件」用不上）；体积下限也在 SQL 里过滤。
    let items: Vec<Value> = {
        let state = app.state::<AppState>();
        let conn = state.db.lock();
        crate::modules::kb::usage::largest(&conn, limit, min_bytes)?
            .iter()
            .map(|f| {
                json!({
                    "id": f.id, "path": f.path, "kind": f.kind,
                    "bytes": f.bytes, "human": human_bytes(f.bytes),
                    "textBytes": f.text_bytes, "assetBytes": f.asset_bytes, "updatedAt": f.updated_at
                })
            })
            .collect()
    };
    Ok(json!({
        "total": items.len(),
        "items": items,
        "hint": "要删就先用 glob_knowledge 确认路径，再删除（用户明确要求时才删）。",
    }))
}

/// 把一个工作区文件挂成聊天里的文件卡片。
///
/// 返回的是**单个条目的富元数据**（与文件管理器同一份投影，见 `listing::find_entry`）：
/// 前端只认 `file` 字段，拿它画卡片（图标 / 名字 / 路径 / 体积 / 能否点开）；
/// 找不到就报「工作区里没有这个路径」，让模型自己回头 glob 一次，而不是给个空卡片。
async fn run_present_file(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let path = str_arg(args, "path")?.trim().to_string();
    let entry = {
        let state = app.state::<AppState>();
        let conn = state.db.lock();
        crate::modules::kb::listing::find_entry(&conn, &path)?
    };
    let Some(entry) = entry else {
        return Err(ReinError::Message(format!(
            "工作区里没有这个路径：{path}。先用 glob_knowledge 查（如 笔记/**、未分类数据/**），再按它返回的 path 调用本工具"
        )));
    };
    let name = entry.name.clone();
    Ok(json!({
        "ok": true,
        "file": entry,
        "message": format!("已把「{name}」挂到聊天里，用户可点开"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_tools_are_claimed_by_the_kb_executor() {
        for name in [
            "list_memories",
            "recall_memory",
            "remember",
            "edit_memory",
            "forget",
        ] {
            assert!(handles(name), "{name} 必须由 kb 域认领");
        }
    }

    #[test]
    fn recall_memory_def_matches_the_tool_contract() {
        let def = recall_memory();
        assert_eq!(def.name, "recall_memory");
        assert_eq!(def.group, "memory");
        assert_eq!(
            def.parameters["required"],
            json!(["query"]),
            "query 是唯一必填参数"
        );
    }
}
