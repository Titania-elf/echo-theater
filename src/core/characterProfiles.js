// 人物外观档案：小剧场场景配图的角色外观来源。
//
// 为什么不复用 Cosmos Vision 的人物档案库：它存在对方的私有设置里，公开接口
// （{ version, requestPrompt, generateImage }）没有任何方法返回它；而且
// src/api/generate-image.ts 全文不引用 profile，所以它对我们这条出图链路
// 既不供数据也不起作用。
//
// 本模块**不 import 任何宿主模块**（只借用 illustrationData 的 id 生成器，那也是个纯模块）。
// 测试夹具会把 utils/storage.js 整个替换掉，保持无宿主依赖才能被直接加载与单测。

import { newIllustrationId } from "./illustrationData.js";

export const CHARACTER_PROFILES_KEY = "character_profiles";
export const CHARACTER_PROFILES_VERSION = 1;
/** 角色卡绑定的键前缀；只有这个前缀才被认作有效绑定。 */
export const CARD_KEY_PREFIX = "card:";
/** 关键词长度下限：单字关键词几乎会命中任何一段正文。 */
export const MIN_KEYWORD_LENGTH = 2;
/** 单次配图最多自动带入的档案数，避免把【人物资料】撑爆。 */
export const MAX_MATCHED_PROFILES = 4;
/** 单条档案插入正文的最大字符数。 */
export const MAX_PROFILE_BLOCK_CHARS = 2000;

const TRUNCATED_SUFFIX = "\n…（档案内容过长已截断）";

/** 新建一条空白档案，供界面使用。 */
export function createCharacterProfile(name = "新档案") {
    return {
        id: newIllustrationId(),
        name: String(name).trim(),
        keywords: [],
        content: "",
        cardKey: "",
        enabled: true,
    };
}

/**
 * 只接受 card: 前缀的绑定键。
 * 群聊里 getCharacterCardKey 会退回 name:<角色名>，而 {{char}} 在群聊中并不指向
 * 具体成员——拿它当绑定键会在同名角色之间串档，所以一律丢弃。
 */
function normalizeCardKey(value) {
    const key = String(value ?? "").trim();
    return key.startsWith(CARD_KEY_PREFIX) ? key : "";
}

function normalizeKeyword(value) {
    const text = String(value ?? "").trim();
    return text.length >= MIN_KEYWORD_LENGTH ? text : "";
}

/** 逐条白名单化：未知字段丢弃，非法值回退。 */
function normalizeEntries(value) {
    const list = Array.isArray(value) ? value : [];
    const seen = new Set();
    const entries = [];
    for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const id = String(raw.id ?? "").trim() || newIllustrationId();
        if (seen.has(id)) continue;
        seen.add(id);
        const keywords = (Array.isArray(raw.keywords) ? raw.keywords : []).map(normalizeKeyword).filter(Boolean);
        entries.push({
            id,
            name: String(raw.name ?? "").trim(),
            keywords: [...new Set(keywords)],
            content: typeof raw.content === "string" ? raw.content : "",
            cardKey: normalizeCardKey(raw.cardKey),
            enabled: raw.enabled !== false,
        });
    }
    return entries;
}

/**
 * 规范化并迁移档案库。幂等：形状已经正确时返回 false，不触发落盘。
 * 由 utils/storage.js 的 getExtData() 调用，沿用 ensurePromptManager 的范式。
 * @param {object} data 扩展设置对象
 * @returns {boolean} 是否发生了改动
 */
export function ensureCharacterProfiles(data) {
    if (!data || typeof data !== "object") return false;
    const current = data[CHARACTER_PROFILES_KEY];
    const entries = normalizeEntries(current?.entries);
    if (current
        && current.version === CHARACTER_PROFILES_VERSION
        && JSON.stringify(current.entries) === JSON.stringify(entries)) return false;
    data[CHARACTER_PROFILES_KEY] = { version: CHARACTER_PROFILES_VERSION, entries };
    return true;
}

/** 读取档案列表（规范化后的副本语义由 ensure 保证）。 */
export function readCharacterProfiles(data) {
    const list = data?.[CHARACTER_PROFILES_KEY]?.entries;
    return Array.isArray(list) ? list : [];
}

/**
 * 单条档案是否命中本次配图。
 *
 * 绑定优先：只有 card: 绑定与目标角色一致才算强命中；
 * 之后仍按关键词兜底——绑在 A 身上的档案也可能因为关键词出现在 B 的正文里
 * 而被正确带入（角色客串的场面）。
 *
 * 注意 text 只应传本轮正文，**不要**把手填的「人物资料」算进去：
 * 档案内容自动填入后自己就变成了匹配依据，匹配会因此不再幂等。
 */
export function profileMatches(entry, { cardKey = "", text = "" } = {}) {
    if (!entry || entry.enabled === false) return false;
    const bound = normalizeCardKey(entry.cardKey);
    if (bound && bound === String(cardKey ?? "")) return true;
    const haystack = String(text ?? "").toLowerCase();
    if (!haystack) return false;
    // 这里再过一次长度下限：生产路径靠 ensureCharacterProfiles 规范化，
    // 但本模块要能独立成立，未规范化的数据也不该让单字关键词命中一切。
    return (entry.keywords || []).some(keyword => {
        const needle = String(keyword ?? "").trim().toLowerCase();
        return needle.length >= MIN_KEYWORD_LENGTH && haystack.includes(needle);
    });
}

/** 命中本次配图的档案，按列表顺序取前若干条。 */
export function matchCharacterProfiles(entries, options = {}) {
    const list = Array.isArray(entries) ? entries : [];
    return list.filter(entry => profileMatches(entry, options)).slice(0, MAX_MATCHED_PROFILES);
}

/** 档案插入「人物资料」文本框时的那段文本。空内容返回空串，不插入。 */
export function composeProfileBlock(entry) {
    const content = String(entry?.content ?? "").trim();
    if (!content) return "";
    const name = String(entry?.name ?? "").trim() || "未命名角色";
    const block = `【${name}】\n${content}`;
    return block.length > MAX_PROFILE_BLOCK_CHARS ? block.slice(0, MAX_PROFILE_BLOCK_CHARS) + TRUNCATED_SUFFIX : block;
}
