//! 文本切块：知识库检索的最小单位。
//!
//! 切块只按**字符**计数，不依赖 embedding 模型的分词器——FTS5 与向量各自在内部处理分词/截断，
//! 这里只需要保证每块足够短以控住 embedding 成本（token 数主导推理耗时），又保留足够上下文。
//! 断点优先落在句读处，避免把一句话劈成两半导致语义碎片。

/// 单块目标长度（字符）。据实测，130 字符约 7 ms / 条，300 字符约 16 ms，是性价比区间。
pub const DEFAULT_MAX_CHARS: usize = 300;
/// 相邻块的重叠字符数：保证跨块的短语仍能被检索到。
pub const DEFAULT_OVERLAP: usize = 50;

/// 句读断点。中文标点与英文标点都要，末尾的换行优先（保留列表/分段结构）。
const BREAKS: [char; 10] = ['\n', '。', '！', '？', '；', '，', '.', '!', '?', ';'];

/// 规范化：把连续空白压成单空格、去掉首尾空白。
/// 源数据里的 notes 常有连续空行，直接入库会让摘要与命中片段显得很脏。
pub fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !last_space && !out.is_empty() {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    out.trim_end().to_string()
}

/// 把长文本切成若干块。空/全空白文本返回空 vec。
///
/// 断点搜索窗口取块尾的 40%：太靠前会让块明显变短（浪费嵌入算力），太靠后则失去断句意义。
pub fn chunk_text(text: &str, max_chars: usize, overlap: usize) -> Vec<String> {
    let normalized = normalize(text);
    if normalized.is_empty() {
        return Vec::new();
    }

    let chars: Vec<char> = normalized.chars().collect();
    let mut chunks: Vec<String> = Vec::new();
    walk_chunks(&chars, max_chars, overlap, |start, end| {
        let piece: String = chars[start..end].iter().collect();
        let piece = piece.trim().to_string();
        if !piece.is_empty() {
            chunks.push(piece);
        }
    });
    chunks
}

/// 只数块数、不拼字符串。用于「总块数」提示（`kb_read` 的 l1 只切首块，
/// 但分页提示仍要真实总数）；同一套断点算法，避免两处口径漂移。
pub fn count_chunks(text: &str, max_chars: usize, overlap: usize) -> usize {
    let normalized = normalize(text);
    if normalized.is_empty() {
        return 0;
    }
    let chars: Vec<char> = normalized.chars().collect();
    let mut count = 0usize;
    walk_chunks(&chars, max_chars, overlap, |start, end| {
        if chars[start..end].iter().any(|c| !c.is_whitespace()) {
            count += 1;
        }
    });
    count
}

/// 逐块回调 `[start, end)`。`chunk_text` 与 `count_chunks` 共用这一份断点逻辑：
/// 断点优先落在句读处，块间保留 overlap，且「必须真前进」防死循环。
fn walk_chunks(chars: &[char], max_chars: usize, overlap: usize, mut emit: impl FnMut(usize, usize)) {
    if chars.is_empty() {
        return;
    }
    let max_chars = max_chars.max(32);
    let overlap = overlap.min(max_chars / 2);
    if chars.len() <= max_chars {
        emit(0, chars.len());
        return;
    }

    let mut start = 0usize;
    while start < chars.len() {
        let hard_end = (start + max_chars).min(chars.len());

        let end = if hard_end == chars.len() {
            hard_end
        } else {
            // 在窗口尾部 40% 内从后往前找第一个句读断点
            let search_from = start + (max_chars * 6 / 10);
            let mut found = None;
            for i in (search_from..hard_end).rev() {
                if BREAKS.contains(&chars[i]) {
                    found = Some(i + 1);
                    break;
                }
            }
            found.unwrap_or(hard_end)
        };

        emit(start, end);

        if end >= chars.len() {
            break;
        }
        // 回退 overlap 起步，但必须真前进，否则死循环
        let next = end.saturating_sub(overlap);
        start = if next > start { next } else { end };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_collapses_whitespace() {
        assert_eq!(normalize("  周三   深蹲\n\n\n五组  "), "周三 深蹲 五组");
        assert_eq!(normalize(""), "");
        assert_eq!(normalize("   "), "");
    }

    #[test]
    fn short_text_is_single_chunk() {
        let c = chunk_text(
            "膝盖不舒服，把深蹲换成腿举",
            DEFAULT_MAX_CHARS,
            DEFAULT_OVERLAP,
        );
        assert_eq!(c, vec!["膝盖不舒服，把深蹲换成腿举"]);
    }

    #[test]
    fn empty_text_yields_no_chunks() {
        assert!(chunk_text("", DEFAULT_MAX_CHARS, DEFAULT_OVERLAP).is_empty());
        assert!(chunk_text("   \n  ", DEFAULT_MAX_CHARS, DEFAULT_OVERLAP).is_empty());
    }

    #[test]
    fn breaks_at_sentence_boundary_not_mid_sentence() {
        // 100 字的句子 + 100 字的句子：应切在「。」后，而不是硬切在 150
        let s1 = "甲".repeat(99) + "。";
        let s2 = "乙".repeat(99) + "。";
        let text = format!("{s1}{s2}");
        let c = chunk_text(&text, 150, 0);
        assert_eq!(c.len(), 2);
        assert!(c[0].ends_with('。'), "首块应以句读结尾，实际: {:?}", c[0]);
        assert!(c[0].chars().count() <= 150);
    }

    #[test]
    fn long_text_is_split_and_covers_all_content() {
        let text: String = "腿部力量训练，深蹲五组。".repeat(60);
        let c = chunk_text(&text, 300, DEFAULT_OVERLAP);
        assert!(c.len() >= 3, "应切成多块，实际 {} 块", c.len());
        for ch in &c {
            assert!(ch.chars().count() <= 300, "块超长: {}", ch.chars().count());
        }
        // 首尾内容都要在（不丢信息）
        assert!(c.first().unwrap().starts_with("腿部力量训练"));
        assert!(c.last().unwrap().ends_with('。'));
    }

    #[test]
    fn overlap_makes_adjacent_chunks_share_text() {
        // 无句读的长串，强制硬切，验证重叠确实生效
        let text: String = "abcdefghij".repeat(40); // 400 字符
        let c = chunk_text(&text, 100, 20);
        assert!(c.len() >= 4);
        let head: String = c[1].chars().take(20).collect();
        let tail: String = c[0]
            .chars()
            .rev()
            .take(20)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        assert_eq!(head, tail, "相邻块应有 20 字符重叠");
    }

    #[test]
    fn tiny_max_chars_does_not_hang() {
        // 防御：overlap 被夹到 max/2，且起点必须前进
        let text: String = "深蹲".repeat(50);
        let c = chunk_text(&text, 32, 999);
        assert!(!c.is_empty());
        for ch in &c {
            assert!(!ch.is_empty());
        }
    }

    /// `count_chunks` 是 l1 阅读的「总块数」来源：必须与 `chunk_text` 的块数**逐例相等**，
    /// 否则 AI 拿到的分页提示（共 N 块 / 从第几块继续）会和 l2 实际切出来的块表打架。
    #[test]
    fn count_matches_chunk_text_len() {
        let cases: [(&str, usize, usize); 6] = [
            ("", DEFAULT_MAX_CHARS, DEFAULT_OVERLAP),
            ("   \n\t  ", DEFAULT_MAX_CHARS, DEFAULT_OVERLAP),
            ("膝盖不舒服，把深蹲换成腿举", DEFAULT_MAX_CHARS, DEFAULT_OVERLAP),
            ("腿部力量训练，深蹲五组。", DEFAULT_MAX_CHARS, DEFAULT_OVERLAP),
            ("abcdefghij", 32, 20),
            ("甲", 32, 999),
        ];
        for (text, max, overlap) in cases {
            assert_eq!(
                count_chunks(text, max, overlap),
                chunk_text(text, max, overlap).len(),
                "text={text:?} max={max} overlap={overlap}"
            );
        }
        let long = "腿部力量训练，深蹲五组。".repeat(200);
        assert_eq!(
            count_chunks(&long, DEFAULT_MAX_CHARS, DEFAULT_OVERLAP),
            chunk_text(&long, DEFAULT_MAX_CHARS, DEFAULT_OVERLAP).len()
        );
    }
}
