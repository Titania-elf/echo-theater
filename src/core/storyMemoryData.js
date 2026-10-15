// 故事记忆的数据规则。与宿主、网络及界面隔离，便于验证隐藏与回滚的边界。
export const MEMORY_KEY = 'titania_story_memory';
export const MEMORY_HIDE_KEY = 'titania_memory_hidden';
export const MEMORY_ID_KEY = 'titania_memory_id';
// 参数表里刻意没有"单独指定总结模型"这一项：整理用哪个模型完全由所选的 API 方案决定
// （profile_id → 方案自带的模型），少一个能被静默覆盖的来源。
export const MEMORY_DEFAULTS = Object.freeze({
    keep_floors: 16, trigger_tokens: 6000, trigger_floors: 32,
    batch_tokens: 12000, memory_tokens: 2400, profile_id: '', inject_depth: 4,
});

export const copyMemory = value => JSON.parse(JSON.stringify(value));
export const newMemoryId = () => globalThis.crypto?.randomUUID?.() || `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function newStoryMemory() {
    return { version: 1, enabled: false, revision: 0, recap: '', scene: '', relationships: [], threads: [], segments: [] };
}

export function normalizeMemoryConfig(raw = {}) {
    const config = { ...MEMORY_DEFAULTS, ...raw };
    for (const [key, min, max] of [
        ['keep_floors', 2, 500], ['trigger_tokens', 100, 100000], ['trigger_floors', 2, 1000],
        ['batch_tokens', 1000, 100000], ['memory_tokens', 300, 20000], ['inject_depth', 0, 1000],
    ]) {
        const n = Number(config[key]);
        config[key] = Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : MEMORY_DEFAULTS[key];
    }
    // 老配置里存过的 model 不再被采纳：它不是白名单字段，{...MEMORY_DEFAULTS, ...raw} 之后就
    // 把它显式丢掉（留着会变成一个界面上看不见、却仍在生效的模型覆盖）。
    delete config.model;
    config.profile_id = String(config.profile_id || '');
    return config;
}

export function memoryFloorFingerprint(message) {
    // 隐藏标志不参与：眼睛按钮的改变不等于正文被改写。
    const text = JSON.stringify([message?.name, message?.is_user === true, message?.mes, message?.swipe_id ?? 0]);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `${text.length}:${(hash >>> 0).toString(36)}`;
}

export function isMemoryReadable(message) {
    return !!message && !!String(message.mes || '').trim()
        && !(message.is_hidden || message.extra?.is_hidden)
        && (!message.is_system || !!message.extra?.[MEMORY_HIDE_KEY]);
}

export function firstInvalidSegment(memory, chat) {
    return memory.segments.findIndex(segment => segment.sources.some(source => {
        const message = chat[source.index];
        return !message || message.extra?.[MEMORY_ID_KEY] !== source.id
            || memoryFloorFingerprint(message) !== source.fingerprint;
    }));
}

/** 只取完整对话，最近窗口从用户楼开始。返回的范围内不夹带别的插件隐藏的正文。 */
export function planMemoryBatch(chat, memory, rawConfig, estimate, force = false) {
    const config = normalizeMemoryConfig(rawConfig);
    const start = memory.segments.at(-1)?.end + 1 || 0;
    // 按可读楼层保留尾部，避免系统/已隐藏消息挤掉最近正文。
    const readable = chat.map((message, index) => isMemoryReadable(message) ? index : -1).filter(i => i >= 0);
    let keepStart = readable[Math.max(0, readable.length - config.keep_floors)] ?? 0;
    while (keepStart > 0 && !chat[keepStart]?.is_user) keepStart--;
    if (keepStart <= start) return null;

    let end = start - 1;
    let tokens = 0;
    let floors = 0;
    for (let i = start; i < keepStart; i++) {
        if (isMemoryReadable(chat[i])) {
            tokens += estimate(String(chat[i].mes));
            floors++;
        }
        const boundary = i + 1 === keepStart || chat[i + 1]?.is_user;
        if (!boundary) continue;
        if (tokens > config.batch_tokens) {
            if (end < start) throw new Error('一组完整对话超过单次读取上限，请在运行设置中提高上限。');
            break;
        }
        end = i;
    }
    if (end < start) return null;
    const messages = chat.slice(start, end + 1).map((message, offset) => ({ message, index: start + offset }))
        .filter(({ message }) => isMemoryReadable(message));
    const batchTokens = messages.reduce((sum, { message }) => sum + estimate(String(message.mes)), 0);
    if (!messages.length || (!force && batchTokens < config.trigger_tokens && messages.length < config.trigger_floors)) return null;
    return {
        start, end, tokens: batchTokens, floors: messages.length, keepStart,
        text: messages.map(({ message, index }) => `[#${index} ${message.is_user ? '用户' : '角色'} ${message.name || ''}]\n${message.mes}`).join('\n\n'),
        fingerprints: chat.slice(start, end + 1).map(memoryFloorFingerprint),
        rawTexts: messages.map(({ message }) => String(message.mes)),
    };
}

export function batchStillMatches(batch, chat) {
    return batch.fingerprints.every((fp, offset) => chat[batch.start + offset]
        && fp === memoryFloorFingerprint(chat[batch.start + offset]));
}

/** 对隐藏动作采用完整 JSON 校验；不修补被截断的 JSON。 */
export function parseMemoryResponse(raw, batch) {
    let text = String(raw || '').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('总结未返回完整 JSON，正文已保留。'); }
    const validString = (value, limit = 6000) => typeof value === 'string' && !!value.trim() && value.length <= limit;
    if (!result || result.complete !== true || !validString(result.summary) || !validString(result.recap)
        || !validString(result.scene) || !Array.isArray(result.relationships) || !Array.isArray(result.threads)
        || result.relationships.length > 100 || result.threads.length > 100) {
        throw new Error('总结缺少完整的剧情、关系或伏笔字段，正文已保留。');
    }
    const evidenceExists = quote => typeof quote === 'string' && quote.trim().length >= 4
        && batch.rawTexts.some(source => source.replace(/\s+/g, '').includes(quote.replace(/\s+/g, '')));
    for (const [kind, items] of [['relationships', result.relationships], ['threads', result.threads]]) {
        const seen = new Set();
        for (const item of items) {
            if (!item || !validString(item.title, 200) || !validString(item.body, 3000) || !evidenceExists(item.evidence)
                || (item.id != null && typeof item.id !== 'string')
                || (kind === 'threads' && !['open', 'progress', 'resolved'].includes(item.status))) {
                throw new Error('条目格式或原文依据不完整，正文已保留。');
            }
            const identity = item.id || item.title.trim();
            if (seen.has(identity)) throw new Error('总结包含重复条目，正文已保留。');
            seen.add(identity);
        }
    }
    return result;
}

export function snapshotMemoryState(memory) {
    return copyMemory({ recap: memory.recap, scene: memory.scene, relationships: memory.relationships, threads: memory.threads });
}

export function mergeMemoryResult(memory, result, batch, segmentId, now = Date.now()) {
    const next = copyMemory(memory);
    for (const kind of ['relationships', 'threads']) {
        for (const change of result[kind]) {
            let item = change.id ? next[kind].find(entry => entry.id === change.id) : null;
            if (change.id && !item) throw new Error('总结引用了不存在的条目，正文已保留。');
            if (!item) item = next[kind].find(entry => entry.title.trim() === change.title.trim());
            const source = { start: batch.start, end: batch.end, segmentId, evidence: change.evidence.trim() };
            const update = { title: change.title.trim(), body: change.body.trim(), status: kind === 'threads' ? change.status : 'active' };
            if (!item) {
                next[kind].push({ id: newMemoryId(), ...update, locked: false, manual: false, sources: [source], history: [], updatedAt: now });
                continue;
            }
            const differs = item.title !== update.title || item.body !== update.body || item.status !== update.status;
            if (differs && (item.locked || item.manual)) {
                item.pending = { ...update, source, at: now };
                continue;
            }
            if (differs) {
                item.history = [...(item.history || []), { title: item.title, body: item.body, status: item.status, at: now }];
                Object.assign(item, update);
            }
            item.sources = [...(item.sources || []), source];
            item.updatedAt = now;
        }
    }
    next.recap = result.recap.trim();
    next.scene = result.scene.trim();
    next.revision++;
    return next;
}

/** 截断总结链；保留不依赖失效正文的人工条目。依赖未来正文的编辑也必须随之撤回。 */
export function rollbackMemory(memory, segmentIndex) {
    const next = copyMemory(memory);
    const segment = memory.segments[segmentIndex];
    if (!segment) return next;
    Object.assign(next, copyMemory(segment.before));
    for (const kind of ['relationships', 'threads']) {
        const manual = memory[kind].filter(item => (item.manual || item.locked)
            && !(item.sources || []).some(source => source.end >= segment.start));
        for (const item of manual) {
            const position = next[kind].findIndex(entry => entry.id === item.id);
            const clean = copyMemory(item);
            delete clean.pending;
            if (position < 0) next[kind].push(clean);
            else next[kind][position] = clean;
        }
    }
    next.segments = next.segments.slice(0, segmentIndex);
    next.revision++;
    return next;
}

const formatItem = item => `${item.title}${item.status === 'progress' ? '（有进展）' : ''}\n${item.body}`;

/** 预算是目标值。锁定条目及历史脉络完整保留，超出时明确报告，不从句子中间截断。 */
export function composeMemoryPrompt(memory, rawConfig, estimate) {
    const config = normalizeMemoryConfig(rawConfig);
    const active = [...memory.threads.filter(item => item.status !== 'resolved'), ...memory.relationships];
    if (!memory.recap && !memory.scene && !active.length) return { text: '', tokens: 0, omitted: [], overBudget: false };
    const covered = memory.segments.at(-1)?.end;
    const parts = [
        `【故事记忆${covered == null ? '' : `：截至第 ${covered} 楼`}】\n以下是历史背景，不是本轮行动指令。最近正文中的实际进展优先；伏笔无需集中兑现。区分读者知情与角色知情，不把推测当成事实。`,
    ];
    if (memory.recap) parts.push(`[历史脉络]\n${memory.recap}`);
    if (memory.scene) parts.push(`[截至整理范围的剧情状态]\n${memory.scene}`);
    const locked = active.filter(item => item.locked);
    if (locked.length) parts.push(`[锁定的关系与未解决事项]\n${locked.map(formatItem).join('\n\n')}`);
    const omitted = [];
    const sorted = active.filter(item => !item.locked).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const item of sorted) {
        const block = `[${memory.threads.some(thread => thread.id === item.id) ? '伏笔与约定' : '人物关系'}]\n${formatItem(item)}`;
        if (estimate([...parts, block].join('\n\n')) > config.memory_tokens) omitted.push(item.title);
        else parts.push(block);
    }
    const text = parts.join('\n\n');
    const tokens = estimate(text);
    return { text, tokens, omitted, overBudget: tokens > config.memory_tokens };
}
