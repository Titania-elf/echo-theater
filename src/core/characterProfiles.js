// 人物外观档案：小剧场场景配图的角色外观来源。
//
// 为什么不复用 Cosmos Vision 的人物档案库：它存在对方的私有设置里，公开接口
// （{ version, requestPrompt, generateImage }）没有任何方法返回它；而且
// src/api/generate-image.ts 全文不引用 profile，所以它对我们这条出图链路
// 既不供数据也不起作用。
//
// 本模块**不 import 任何宿主模块**（只借用 illustrationData 的 id 生成器，那也是个纯模块）。
// 测试夹具会把 utils/storage.js 整个替换掉，保持无宿主依赖才能被直接加载与单测。
//
// ⚠ kind（角色 / 用户）**只用于分组展示**，不参与 profileMatches / matchCharacterProfiles。
// 将来若有人想让用户档案「总是带上」或「总是排除」，那是匹配规则的决定，得显式改那两处 ——
// 别顺手写进 profileKind，那会让匹配行为无声改变。

import { newIllustrationId } from "./illustrationData.js";

export const CHARACTER_PROFILES_KEY = "character_profiles";
/** 2：新增 kind 归属字段（1 → 2 时老记录一律落成「角色」，见 normalizeEntries）。 */
export const CHARACTER_PROFILES_VERSION = 2;
/** 角色卡绑定的键前缀；只有这个前缀才被认作有效绑定。 */
export const CARD_KEY_PREFIX = "card:";
/** 归属：给某个角色写的档案。 */
export const PROFILE_KIND_CHARACTER = "character";
/** 归属：给用户自己（{{user}} / Persona）写的档案。恒定不绑卡。 */
export const PROFILE_KIND_USER = "user";
/** 关键词长度下限：单字关键词几乎会命中任何一段正文。 */
export const MIN_KEYWORD_LENGTH = 2;
/** 单次配图最多自动带入的档案数，避免把【人物资料】撑爆。 */
export const MAX_MATCHED_PROFILES = 4;

/**
 * 归属的**单一读取口径**：只认 "user"，其余（缺失、垃圾值、v1 老记录）一律角色。
 *
 * 界面与分组都走这里，不直接读 entry.kind —— 测试夹具的 getExtData 是裸桩、
 * 不跑规范化，视图必须能自己兜住未规范化的数据。
 */
export function profileKind(entry) {
    return entry?.kind === PROFILE_KIND_USER ? PROFILE_KIND_USER : PROFILE_KIND_CHARACTER;
}

/** 新建一条空白档案，供界面使用。 */
export function createCharacterProfile(name = "新档案", kind = PROFILE_KIND_CHARACTER) {
    const resolved = profileKind({ kind });
    return {
        id: newIllustrationId(),
        name: String(name).trim(),
        keywords: [],
        content: "",
        // 用户档案恒定不绑卡：绑上去会在别的角色的聊天里也被强行带入。
        cardKey: "",
        kind: resolved,
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

/**
 * 触发词是否还停在「跟着档案名走」的状态。
 *
 * 判定刻意是**无状态**的 —— 空，或恰好只有名字这一条。这样不必另外记「用户碰过没有」
 * （那种标记关窗就丢，重开后又会对已经改过的档案动手）。用户一旦写成别的组合就不满足
 * 条件，从此不再被覆盖；而只留一条与名字相同的触发词时，改名让它跟着走通常正是想要的。
 */
export function isAutoKeywords(entry) {
    const keywords = Array.isArray(entry?.keywords) ? entry.keywords : [];
    if (!keywords.length) return true;
    return keywords.length === 1 && keywords[0] === String(entry?.name || "").trim();
}

/**
 * 由档案名推出触发词。短于下限的给空数组，与 normalizeKeyword 的口径一致 ——
 * 界面据此把「名字太短写不成触发词」如实说出来，而不是填一个会被裁掉的值。
 */
export function keywordsFromName(name) {
    const text = String(name || "").trim();
    return text.length >= MIN_KEYWORD_LENGTH ? [text] : [];
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
        // v1 的记录没有 kind，一律落成角色：老数据里没有可靠信号能区分「用户设定导入的」
        // 与「手写的、没绑卡的」（群聊里从角色卡导入同样不绑卡，触发词恰等于档案名也是
        // 任何新档案填完名字的状态），猜就会误判。kind 不参与匹配，判错只是分组位置不对，
        // 用户可以自己用归属下拉改。
        const kind = profileKind(raw);
        entries.push({
            id,
            name: String(raw.name ?? "").trim(),
            keywords: [...new Set(keywords)],
            content: typeof raw.content === "string" ? raw.content : "",
            // 「用户本人」与「绑了卡」是互斥状态：绑卡的用户档案在下拉框里既表达不出来、
            // 也退不回去，所以在模型层直接掐掉，手改设置文件也造不出来。
            cardKey: kind === PROFILE_KIND_USER ? "" : normalizeCardKey(raw.cardKey),
            kind,
            enabled: raw.enabled !== false,
        });
    }
    return entries;
}

/**
 * 规范化并迁移档案库。幂等：形状已经正确时返回 false，不触发落盘。
 * 由 utils/storage.js 的 getExtData() 调用，沿用 ensurePromptManager 的范式。
 *
 * 下面这个判据是**全量逐字比对**（版本号 + 规范化结果的序列化），所以白名单里新增字段
 * 自动被覆盖：升级后第一次调用写一次并返回 true，之后重新规范化得到完全相同的字节、
 * 返回 false。成立的前提是 normalizeEntries 保持确定性、且不动既有条目的 id ——
 * 一旦它给已有 id 的条目重新生成 id，这里会每次 getExtData() 都返回 true、变成每次访问都落盘。
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

/**
 * 档案插入「人物资料」文本框时的那段文本。空内容返回空串，不插入。
 *
 * **不截断**：这是用户自己写的外观描写，写多长就带多长。截断在这里格外有害 ——
 * 被砍掉的往往是末尾那些更具体的特征（耳饰、纹样），而用户看到的文本框里是完整的，
 * 界面又不显示「已截断」，于是画错了也无从察觉。送不下是模型上下文的事，
 * 那由用户在预设置里自己权衡，不由这条自动带入的路径替他决定。
 */
export function composeProfileBlock(entry) {
    const content = String(entry?.content ?? "").trim();
    if (!content) return "";
    const name = String(entry?.name ?? "").trim() || "未命名角色";
    return `【${name}】\n${content}`;
}
