// 旧事召回：不依赖 embedding 的本地 BM25。
//
// 为什么放在纯函数层：检索只做「文本 → 词 → 打分」，不碰宿主与网络，
// 可以直接用 node:test 验证。手机端没有安装步骤，索引只在内存里按记忆
// revision 重建；不把倒排表写进聊天存档，也不复制全部聊天原文。
//
// 中文不引分词器：按连续汉字的二元组切词（「旧宅钥匙」→ 旧宅/宅钥/钥匙），
// 英文与数字按连续字母数字切词。二元组对人物名、地名、物品名的召回足够稳，
// 且不需要任何原生模块或词典文件。

const CJK = /[㐀-䶿一-鿿豈-﫿]/;
const K1 = 1.2;
const B = 0.75;

/** 把一段文本切成可索引的词。 */
export function tokenize(text) {
    const source = String(text || '').toLowerCase();
    const tokens = [];
    let ascii = '';
    let cjk = '';
    const flushAscii = () => { if (ascii) { tokens.push(ascii); ascii = ''; } };
    const flushCjk = () => {
        if (!cjk) return;
        if (cjk.length === 1) tokens.push(cjk);
        else for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk.slice(i, i + 2));
        cjk = '';
    };
    for (const char of source) {
        if (/[a-z0-9]/.test(char)) {
            flushCjk();
            ascii += char;
        } else if (CJK.test(char)) {
            flushAscii();
            cjk += char;
        } else {
            flushAscii();
            flushCjk();
        }
    }
    flushAscii();
    flushCjk();
    return tokens;
}

/**
 * 用已整理的分段摘要建立倒排索引。
 *
 * 条目的 evidence 是整理时逐字摘录的原文，挂回对应分段一起索引：
 * 摘要换了说法导致某个细节搜不到时，原句仍能命中。
 * @param {object} memory 故事记忆
 * @returns {{docs: Array, postings: Map, lengths: number[], avgLength: number}}
 */
export function buildMemoryIndex(memory) {
    const evidenceBySegment = new Map();
    for (const kind of ['relationships', 'threads']) {
        for (const item of memory?.[kind] || []) {
            for (const source of item.sources || []) {
                if (!source?.segmentId || !String(source.evidence || '').trim()) continue;
                const list = evidenceBySegment.get(source.segmentId) || [];
                list.push(String(source.evidence));
                evidenceBySegment.set(source.segmentId, list);
            }
        }
    }

    const docs = [];
    for (const segment of memory?.segments || []) {
        const evidence = evidenceBySegment.get(segment.id) || [];
        const summary = String(segment.summary || '').trim();
        const text = [summary, ...evidence].filter(Boolean).join('\n');
        if (!text) continue;
        docs.push({
            id: segment.id,
            title: `第 ${segment.start}～${segment.end} 楼`,
            text,
            summary,
            evidence,
        });
    }

    const postings = new Map();
    const lengths = [];
    let totalLength = 0;
    docs.forEach((doc, index) => {
        const tokens = tokenize(doc.text);
        lengths[index] = tokens.length;
        totalLength += tokens.length;
        const termFreq = new Map();
        for (const token of tokens) termFreq.set(token, (termFreq.get(token) || 0) + 1);
        // 每个词一条扁平数组 [docIndex, tf, docIndex, tf, ...]。
        // 不用「每个词一个小 Map」：手机上几百段正文会产生十几万个词，
        // 每个词单独开 Map 的固定开销比正文本身还大。
        for (const [term, count] of termFreq) {
            const posting = postings.get(term);
            if (posting) posting.push(index, count);
            else postings.set(term, [index, count]);
        }
    });

    return { docs, postings, lengths, avgLength: docs.length ? totalLength / docs.length : 0 };
}

/**
 * 查询索引，返回得分最高的旧段落。
 * @param {object} index buildMemoryIndex 的结果
 * @param {string} queryText 最近对话
 * @param {{limit?: number, minScore?: number}} [options]
 * @returns {Array<{id: string, title: string, text: string, summary: string, evidence: string[], score: number, matched: number}>}
 */
export function queryMemoryIndex(index, queryText, options = {}) {
    const limit = options.limit == null ? 4 : Math.max(0, Math.floor(Number(options.limit) || 0));
    if (!index?.docs?.length || limit <= 0) return [];
    const queryTerms = [...new Set(tokenize(queryText))];
    if (!queryTerms.length) return [];

    const total = index.docs.length;
    const minScore = Number(options.minScore) || 0;
    const scores = new Map();
    for (const term of queryTerms) {
        const posting = index.postings.get(term);
        if (!posting) continue;
        const df = posting.length / 2;
        // BM25 的 idf：常见词（df 接近 total）自然降权。
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
        for (let i = 0; i < posting.length; i += 2) {
            const docIndex = posting[i];
            const tf = posting[i + 1];
            const length = index.lengths[docIndex] || 0;
            const norm = 1 - B + B * (index.avgLength ? length / index.avgLength : 0);
            const score = idf * (tf * (K1 + 1)) / (tf + K1 * norm);
            const entry = scores.get(docIndex) || { score: 0, matched: 0 };
            entry.score += score;
            entry.matched += 1;
            scores.set(docIndex, entry);
        }
    }

    return [...scores.entries()]
        .filter(([, entry]) => entry.score > minScore)
        .sort((a, b) => b[1].score - a[1].score || a[0] - b[0])
        .slice(0, limit)
        .map(([docIndex, entry]) => ({
            ...index.docs[docIndex],
            score: Math.round(entry.score * 10000) / 10000,
            matched: entry.matched,
        }));
}
