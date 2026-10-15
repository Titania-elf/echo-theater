import { eventSource, event_types, isGenerating, saveChatConditional, getRequestHeaders } from '../../../../script.js';
import { getExtData, saveExtData } from '../utils/storage.js';
import { estimateTokens } from '../utils/helpers.js';
import { getActiveConnection, getConnectionByProfileId, getAllProfiles, sendChatRequestWithConnection } from './connection.js';
import { TITANIA_TEXT_PATCHED } from './contentChangeEvents.js';
import {
    READER_STORY_KEY, newReaderStory, buildReaderStorySources, validReaderStory, readerStateAt,
    readerSceneDirectory, readerStoryMessages, parseReaderStoryResponse, separatorReaderCheckpoint,
} from './readerStoryData.js';

const subscribers = new Set();
let job = null;
let saving = null;
let initialized = false;
let status = 'idle';
let error = '';
let statusKey = '';

function context() {
    const ctx = globalThis.SillyTavern?.getContext?.();
    if (!ctx?.chatId || !Array.isArray(ctx.chat) || !ctx.chatMetadata) return null;
    const group = ctx.groupId != null && ctx.groupId !== '';
    const character = ctx.characters?.[ctx.characterId];
    if (!group && !character?.avatar) return null;
    return { ...ctx, group, character, key: JSON.stringify([group ? ctx.groupId : character.avatar, ctx.chatId]) };
}

function sameChat(ctx) {
    const current = context();
    return current?.key === ctx.key && current.chat === ctx.chat && current.chatMetadata === ctx.chatMetadata;
}

function notify() {
    for (const callback of subscribers) {
        try { callback(); } catch (cause) { console.warn('Titania reader view:', cause); }
    }
}

export function getReaderStoryConfig() {
    const reader = getExtData().appearance?.reader || {};
    const budget = Number(reader.index_context_tokens);
    return { profile_id: String(reader.index_profile_id || ''), model: String(reader.index_model || '').trim(),
        tag_whitelist: String(reader.index_tag_whitelist || '').trim(),
        context_tokens: Number.isFinite(budget) ? Math.max(1000, Math.min(64000, Math.floor(budget))) : 16000 };
}

export function saveReaderStoryConfig(patch) {
    if (job) throw new Error('请先停止当前整理，再修改索引设置。');
    const data = getExtData();
    data.appearance ||= {};
    data.appearance.reader ||= {};
    const config = { ...getReaderStoryConfig(), ...patch };
    Object.assign(data.appearance.reader, { index_profile_id: config.profile_id, index_model: config.model,
        index_tag_whitelist: config.tag_whitelist, index_context_tokens: config.context_tokens });
    saveExtData();
    notify();
}

export function readerStoryProfiles() {
    return getAllProfiles().map(profile => ({ id: profile.id, name: profile.name }));
}

function acceptedStory(ctx) {
    // The host swallows save errors. Pending checkpoints become visible only after readback.
    return saving?.ctx.chatMetadata === ctx.chatMetadata && ctx.chatMetadata[READER_STORY_KEY] === saving.next
        ? saving.previous : ctx.chatMetadata[READER_STORY_KEY];
}

export function getReaderStoryView(floor = -1) {
    const ctx = context();
    const config = getReaderStoryConfig();
    const sources = ctx ? buildReaderStorySources(ctx.chat, config.tag_whitelist) : [];
    const { story, invalidated } = validReaderStory(ctx ? acceptedStory(ctx) : null, sources, config.tag_whitelist);
    const state = readerStateAt(story, floor);
    return {
        available: !!ctx, key: ctx?.key || '', config, ...state, floor,
        scenes: readerSceneDirectory(story, sources, floor), invalidated,
        processed: story.checkpoints.length, total: sources.length, indexedThrough: story.checkpoints.at(-1)?.index ?? -1,
        busy: !!job && sameChat(job.ctx), status: statusKey === ctx?.key ? status : 'idle',
        error: statusKey === ctx?.key ? error : '', generating: isGenerating(),
        nextFloor: sources[story.checkpoints.length]?.index ?? null,
    };
}

export function getReaderStoryEvidence(reference, floor) {
    if (!reference || !Number.isInteger(reference.floor) || reference.floor > floor || !String(reference.quote || '').trim()) throw new Error('这段来源尚未读到。');
    const ctx = context();
    const source = ctx && buildReaderStorySources(ctx.chat, getReaderStoryConfig().tag_whitelist).find(item => item.index === reference.floor);
    if (!source || !source.text.replace(/\s/g, '').includes(String(reference.quote || '').replace(/\s/g, ''))) throw new Error('来源已变化，请重新整理索引。');
    return { index: source.index, name: source.name, text: source.text, quote: reference.quote };
}

function prefixStillMatches(ctx, sources, through, config) {
    if (!sameChat(ctx)) return false;
    const current = buildReaderStorySources(ctx.chat, config.tag_whitelist);
    return sources.slice(0, through + 1).every((source, i) => current[i]?.index === source.index && current[i]?.fingerprint === source.fingerprint);
}

async function persistCheckpoint(ctx, previous, next, stillMatches) {
    if (!stillMatches()) throw new Error('聊天或索引来源已变化。');
    next.commitId = globalThis.crypto?.randomUUID?.() || `reader-${Date.now()}-${Math.random()}`;
    const transaction = { ctx, previous, next };
    saving = transaction;
    ctx.chatMetadata[READER_STORY_KEY] = next;
    try {
        await saveChatConditional();
        if (!stillMatches()) throw new Error('保存期间聊天或索引来源已变化。');
        const response = await fetch(ctx.group ? '/api/chats/group/get' : '/api/chats/get', {
            method: 'POST', headers: getRequestHeaders(), cache: 'no-store',
            body: JSON.stringify(ctx.group ? { id: ctx.chatId } : { ch_name: ctx.character.name, avatar_url: ctx.character.avatar, file_name: ctx.chatId }),
        });
        if (!response.ok) throw new Error('阅读索引保存结果无法回读。');
        const saved = await response.json();
        if (!Array.isArray(saved) || saved[0]?.chat_metadata?.[READER_STORY_KEY]?.commitId !== next.commitId) throw new Error('阅读索引未成功保存。');
        if (!stillMatches()) throw new Error('回读期间聊天或索引来源已变化。');
    } catch (cause) {
        if (ctx.chatMetadata[READER_STORY_KEY] === next) {
            if (previous) ctx.chatMetadata[READER_STORY_KEY] = previous;
            else delete ctx.chatMetadata[READER_STORY_KEY];
        }
        throw cause;
    } finally { if (saving === transaction) saving = null; }
}

export function stopReaderStoryIndex() {
    if (!job) return;
    job.controller.abort();
    status = 'paused'; error = ''; statusKey = job.ctx.key;
    notify();
}

function initEvents() {
    if (initialized) return;
    initialized = true;
    for (const event of [event_types.CHAT_CHANGED, event_types.GENERATION_STARTED, TITANIA_TEXT_PATCHED,
        ...['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED'].map(name => event_types[name])]) {
        if (event) eventSource.on(event, () => { stopReaderStoryIndex(); notify(); });
    }
    for (const event of [event_types.MESSAGE_RECEIVED, event_types.GENERATION_ENDED]) {
        if (event) eventSource.on(event, notify);
    }
}

export function subscribeReaderStory(callback) {
    initEvents(); subscribers.add(callback);
    return () => subscribers.delete(callback);
}

/** Analyze one floor per request, in source order. Later text never enters an earlier checkpoint prompt. */
export async function startReaderStoryIndex({ rebuild = false } = {}) {
    initEvents();
    const ctx = context();
    if (!ctx) throw new Error('请先打开角色聊天。');
    if (job) throw new Error('阅读索引仍在整理或保存，请稍后重试。');
    if (isGenerating()) throw new Error('酒馆生成结束后即可整理阅读索引。');
    const config = getReaderStoryConfig();
    const sources = buildReaderStorySources(ctx.chat, config.tag_whitelist);
    if (!sources.length) throw new Error('未找到可分析的正文，请检查正文标签与提取设置。');
    const conn = config.profile_id ? getConnectionByProfileId(config.profile_id, config.model || null) : getActiveConnection();
    if (!conn) throw new Error('索引 API 方案已不存在，请重新选择。');
    if (!conn.useSTConnection && !conn.url?.trim()) throw new Error('请配置工具箱 API，或选择跟随酒馆的连接方案。');
    let story = rebuild ? newReaderStory(config.tag_whitelist) : validReaderStory(ctx.chatMetadata[READER_STORY_KEY], sources, config.tag_whitelist).story;
    const controller = new AbortController();
    const task = { ctx, controller };
    job = task;
    statusKey = ctx.key; status = 'indexing'; error = '';
    notify();
    try {
        for (let i = story.checkpoints.length; i < sources.length; i++) {
            if (controller.signal.aborted || isGenerating()) return false;
            if (!prefixStillMatches(ctx, sources, i, config)) throw new Error('正文、swipe 或聊天已变化；受影响资料已停止展示。');
            const source = sources[i];
            const previous = readerStateAt(story, source.index - 1);
            let checkpoint;
            if (source.separator) checkpoint = separatorReaderCheckpoint(source);
            else {
                const messages = readerStoryMessages(previous, source);
                const tokens = estimateTokens(messages.map(message => message.content).join('\n'));
                if (tokens > config.context_tokens) throw new Error(`第 ${source.index} 楼及历史资料约 ${tokens} token，超过索引上下文上限；可在设置中提高上限。`);
                let timedOut = false;
                const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 180000);
                let raw;
                try {
                    raw = await sendChatRequestWithConnection(conn, messages, { model: config.model || undefined,
                        stream: false, maxTokens: 4096, temperature: 0.2, allowEmptyKey: true,
                        respectRequestLimits: true, signal: controller.signal });
                } catch (cause) {
                    if (timedOut) throw new Error('本楼索引请求超时，已保留先前整理结果。');
                    throw cause;
                } finally { clearTimeout(timeout); }
                if (timedOut) throw new Error('本楼索引请求超时，已保留先前整理结果。');
                if (controller.signal.aborted || isGenerating()) return false;
                if (!prefixStillMatches(ctx, sources, i, config)) throw new Error('请求期间索引来源已变化。');
                checkpoint = parseReaderStoryResponse(raw, previous, source);
            }
            const next = { ...story, checkpoints: [...story.checkpoints, checkpoint] };
            const prior = ctx.chatMetadata[READER_STORY_KEY];
            await persistCheckpoint(ctx, prior, next, () => prefixStillMatches(ctx, sources, i, config));
            story = next;
            notify();
        }
        status = 'complete';
        return true;
    } catch (cause) {
        if (!controller.signal.aborted || String(cause.message).includes('超时')) {
            status = 'error'; error = String(cause.message || cause);
        }
        return false;
    } finally {
        if (job === task) job = null;
        if (status === 'indexing') status = 'paused';
        notify();
    }
}
