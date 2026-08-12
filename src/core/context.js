// src/core/context.js

import { getExtData } from "../utils/storage.js";

// 从 SillyTavern 世界书模块导入必要变量
// 使用相对路径导入（从 src/core/ 到 scripts/world-info.js）
import { world_info, selected_world_info, world_names, updateWorldInfoList } from "../../../world-info.js";
// 从 SillyTavern power-user 模块导入用户设置
import { power_user } from "../../../power-user.js";

// 辅助函数：安全获取世界书变量（每次调用时返回模块导入的值）
function getWorldInfoVars() {
    try {
        return {
            selected_world_info: selected_world_info || [],
            world_info: world_info || null
        };
    } catch (e) {
        console.warn("Titania: 获取世界书变量失败", e);
        return { selected_world_info: [], world_info: null };
    }
}

/**
 * 带超时的 Promise 包装器
 * @param {Promise} promise - 原始 Promise
 * @param {number} timeout - 超时时间（毫秒）
 * @param {string} errorMsg - 超时错误信息
 * @returns {Promise}
 */
function withTimeout(promise, timeout = 5000, errorMsg = 'Operation timed out') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(errorMsg)), timeout)
        )
    ]);
}

/**
 * 安全地加载世界书数据
 * @param {object} ctx - SillyTavern context
 * @param {string} bookName - 世界书名称
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<object|null>} 世界书数据或 null
 */
async function safeLoadWorldInfo(ctx, bookName, timeout = 5000) {
    try {
        if (!ctx.loadWorldInfo || typeof ctx.loadWorldInfo !== 'function') {
            console.warn(`Titania: loadWorldInfo 函数不可用`);
            return null;
        }
        const result = await withTimeout(
            ctx.loadWorldInfo(bookName),
            timeout,
            `加载世界书 [${bookName}] 超时`
        );
        return result;
    } catch (err) {
        console.warn(`Titania: 无法加载世界书 [${bookName}]`, err.message);
        return null;
    }
}

/**
 * 获取当前激活的世界书列表及其所有启用条目（用于 UI 显示）
 * 改进：不再限制只读取蓝灯条目，而是读取所有启用的条目
 * @returns {Promise<Array>} 世界书及条目数组
 */
export async function getActiveWorldInfoEntries() {
    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) return [];

    let ctx;
    try {
        ctx = SillyTavern.getContext();
        if (!ctx) return [];
    } catch (e) {
        console.warn("Titania: 无法获取 SillyTavern context", e);
        return [];
    }

    const wiVars = getWorldInfoVars();
    const charName = getCurrentCharNameFromContext(ctx);
    const activeBooks = collectSessionActiveBooks(ctx, wiVars, charName, true);

    const result = [];

    for (const bookName of activeBooks) {
        const bookData = await safeLoadWorldInfo(ctx, bookName);
        if (!bookData || !bookData.entries) continue;

        // 获取所有条目（包含已禁用的，便于用户在UI中手动勾选）
        const allEntries = Object.values(bookData.entries);

        if (allEntries.length > 0) {
            result.push({
                bookName: bookName,
                entries: allEntries.map(e => ({
                    uid: e.uid,
                    comment: e.comment || `条目 ${e.uid}`,
                    content: e.content || "",
                    preview: (e.content || "").substring(0, 80).replace(/\n/g, " "),
                    isConstant: e.constant === true,
                    isDisabled: e.disable === true && e.enabled !== true
                }))
            });
        }
    }

    return result;
}

/**
 * 获取当前对话的上下文数据 (角色名、Persona、世界书等)
 * 添加错误边界，确保即使部分数据获取失败也能返回基础数据
 */
export async function getContextData() {
    let data = {
        charName: "Char", persona: "", userName: "User", userDesc: "", worldInfo: "",
        worldInfoBefore: "", worldInfoAfter: "", scenario: "", dialogueExamples: ""
    };

    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) return data;

    let ctx;
    try {
        ctx = SillyTavern.getContext();
        if (!ctx) return data;
    } catch (e) {
        console.warn("Titania: 无法获取 SillyTavern context", e);
        return data;
    }

    try {
        data.userName = ctx.substituteParams("{{user}}") || "User";
        data.charName = ctx.substituteParams("{{char}}") || "Char";
        data.userDesc = ctx.substituteParams("{{persona}}") || "";
        data.persona = ctx.substituteParams("{{description}}") || "";
        const character = ctx.characterId !== undefined ? ctx.characters?.[ctx.characterId] : null;
        const rawScenario = String(character?.data?.scenario || character?.scenario || "");
        const rawDialogueExamples = String(character?.data?.mes_example || character?.mes_example || "");
        data.scenario = ctx.substituteParams(rawScenario);
        data.dialogueExamples = ctx.substituteParams(rawDialogueExamples);
    } catch (e) { console.error("Titania: 宏解析失败", e); }

    const wiVars = getWorldInfoVars();
    const activeBooks = collectSessionActiveBooks(ctx, wiVars, data.charName, true);

    // --- 2. 加载并筛选世界书条目 ---
    const contentParts = [];

    // 获取世界书筛选配置（按角色卡隔离，同名卡不再互相串味）
    const extData = getExtData();
    const charSelections = readWorldInfoSelections(extData, ctx, data.charName);

    for (const bookName of activeBooks) {
        const bookData = await safeLoadWorldInfo(ctx, bookName);
        if (!bookData || !bookData.entries) continue;

        let enabledEntries;

        // 如果有针对当前角色的选择配置，按用户选择筛选（包含已禁用条目）
        if (charSelections && charSelections[bookName]) {
            const selectedUids = charSelections[bookName];
            enabledEntries = Object.values(bookData.entries).filter(e => selectedUids.includes(e.uid));
        } else if (charSelections === null) {
            // 首次使用时（没有保存过选择），默认不选择任何条目
            enabledEntries = [];
        } else if (!charSelections[bookName]) {
            // 该世界书未被选择过
            enabledEntries = [];
        } else {
            // 回退：只包含已启用的条目
            enabledEntries = Object.values(bookData.entries).filter(entry =>
                entry.disable === false || entry.enabled === true
            );
        }

        enabledEntries.forEach(e => {
            if (e.content && e.content.trim()) {
                // 解析内容中的宏并存入数组
                try {
                    contentParts.push(ctx.substituteParams(e.content.trim()));
                } catch (subErr) {
                    // 如果宏解析失败，使用原始内容
                    contentParts.push(e.content.trim());
                }
            }
        });
    }

    if (contentParts.length > 0) {
        data.worldInfo = "[World Info / Lore]\n" + contentParts.join("\n\n") + "\n\n";
    }
    data.worldInfoBefore = data.worldInfo;

    // 添加角色 ID
    data.charId = ctx.characterId;

    return data;
}

/**
 * 获取当前聊天历史
 * @returns {Array} 聊天历史数组
 */
export function getChatHistory() {
    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
        return [];
    }

    try {
        const ctx = SillyTavern.getContext();
        if (!ctx || !ctx.chat) {
            return [];
        }
        return ctx.chat;
    } catch (e) {
        console.warn("Titania: 获取聊天历史失败", e);
        return [];
    }
}

/**
 * 获取聊天历史的总楼层数
 * @returns {number} 总楼层数
 */
export function getTotalFloors() {
    const chat = getChatHistory();
    return chat?.length || 0;
}

function getCurrentCharNameFromContext(ctx) {
    try {
        return ctx?.substituteParams?.("{{char}}") || "Char";
    } catch {
        return "Char";
    }
}

/* ------------------------------------------------------------------ *
 * 角色卡身份
 *
 * 世界书筛选配置过去以「角色显示名」为键（char_selections["小明"]），导致同名角色卡
 * 共用同一份配置：A 卡在书A 里勾了条目，B 卡（同名、实际挂书B）会连带把书A 判为已激活
 * 并注入其条目。ST 自己是靠 avatar 文件名区分卡片的——collectSessionActiveBooks 里
 * 匹配 charLore 时就已经在用 avatar 了，只是没用在这份配置上。
 *
 * 所以改用 avatar 作为键。群聊里 characterId 为 undefined，退回名字键但加前缀命名空间，
 * 避免与 avatar 键混淆。
 * ------------------------------------------------------------------ */

const CARD_KEY_PREFIX = "card:";
const NAME_KEY_PREFIX = "name:";

/**
 * 当前角色卡的稳定标识。
 * @param {object} [stCtx] SillyTavern.getContext() 的结果，缺省时自行获取
 * @returns {string}
 */
export function getCharacterCardKey(stCtx = null) {
    let ctx = stCtx;
    try {
        if (!ctx && typeof SillyTavern !== "undefined") ctx = SillyTavern.getContext?.();
    } catch {
        ctx = null;
    }
    if (!ctx) return `${NAME_KEY_PREFIX}Char`;

    const charId = ctx.characterId;
    if (charId !== undefined && charId !== null) {
        const avatar = String(ctx.characters?.[charId]?.avatar || "").trim();
        // 去掉扩展名，与 charLore 的匹配口径一致（见 collectSessionActiveBooks）
        if (avatar) return CARD_KEY_PREFIX + avatar.replace(/\.[^/.]+$/, "");
    }

    return NAME_KEY_PREFIX + getCurrentCharNameFromContext(ctx);
}

/**
 * 这个名字是否被多张卡共用。用于判断旧配置能否安全地认领给当前卡。
 * @param {object} ctx
 * @param {string} charName
 * @returns {boolean}
 */
function isNameSharedByMultipleCards(ctx, charName) {
    const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];
    const target = String(charName || "").trim();
    if (!target) return false;
    let seen = 0;
    for (const item of characters) {
        if (String(item?.name || "").trim() === target && ++seen > 1) return true;
    }
    return false;
}

function getWorldInfoConfig(extData) {
    const wiConfig = extData.worldinfo && typeof extData.worldinfo === "object" ? extData.worldinfo : {};
    return {
        cardSelections: wiConfig.card_selections && typeof wiConfig.card_selections === "object" ? wiConfig.card_selections : null,
        cardAutoActiveBooks: wiConfig.card_auto_active_books && typeof wiConfig.card_auto_active_books === "object" ? wiConfig.card_auto_active_books : null,
        legacySelections: wiConfig.char_selections && typeof wiConfig.char_selections === "object" ? wiConfig.char_selections : null,
        legacyAutoActiveBooks: wiConfig.char_auto_active_books && typeof wiConfig.char_auto_active_books === "object" ? wiConfig.char_auto_active_books : null
    };
}

let legacyAmbiguityNotified = false;

function notifyLegacyAmbiguityOnce(charName) {
    if (legacyAmbiguityNotified) return;
    legacyAmbiguityNotified = true;
    console.warn(`Titania: 检测到多张角色卡共用名称「${charName}」，旧的世界书筛选配置已按卡片隔离，需要重新选择一次条目。`);
    if (typeof window !== "undefined" && window.toastr) {
        window.toastr.info(
            `检测到多张角色卡共用名称「${charName}」。世界书筛选已改为按卡片独立保存，这张卡需要重新选择一次条目。`,
            "Titania Echo",
            { timeOut: 9000 }
        );
    }
}

/**
 * 旧的名字键配置是否可以被当前卡继承。
 * 名字唯一时可以（对绝大多数用户零影响）；被多张卡共用时不行——那正是串味的来源，
 * 无法判断这份配置原本属于哪张卡，只能让每张卡从干净状态开始。
 *
 * @param {boolean} hasLegacyData 该名字下确实存在旧配置。只有「有东西却拒绝继承」时才提示用户，
 *   否则没有旧数据的用户也会收到「需要重新选择」的误报。
 */
function canInheritLegacy(ctx, charName, hasLegacyData) {
    if (!isNameSharedByMultipleCards(ctx, charName)) return true;
    if (hasLegacyData) notifyLegacyAmbiguityOnce(charName);
    return false;
}

/**
 * 读取当前卡的世界书条目筛选。
 * @returns {object|null} null 表示从未保存过（沿用「默认不选任何条目」的既有语义）
 */
export function readWorldInfoSelections(extData, ctx, charName) {
    const cfg = getWorldInfoConfig(extData);
    const cardKey = getCharacterCardKey(ctx);

    const byCard = cfg.cardSelections?.[cardKey];
    if (byCard && typeof byCard === "object") return byCard;

    const legacy = cfg.legacySelections?.[charName];
    const hasLegacy = Boolean(legacy && typeof legacy === "object");
    if (hasLegacy && canInheritLegacy(ctx, charName, true)) return legacy;

    return null;
}

/**
 * 读取当前卡需要额外激活的世界书名单。
 * @returns {string[]}
 */
export function readAutoActiveBooks(extData, ctx, charName) {
    const cfg = getWorldInfoConfig(extData);
    const cardKey = getCharacterCardKey(ctx);

    const deriveFromSelections = selections => Object.keys(selections).filter(bookName => {
        const selected = selections[bookName];
        return Array.isArray(selected) && selected.length > 0;
    });

    const byCard = cfg.cardAutoActiveBooks?.[cardKey];
    if (Array.isArray(byCard)) return byCard;

    const cardSelections = cfg.cardSelections?.[cardKey];
    if (cardSelections && typeof cardSelections === "object") return deriveFromSelections(cardSelections);

    const legacyExplicit = cfg.legacyAutoActiveBooks?.[charName];
    const legacySelections = cfg.legacySelections?.[charName];
    const hasLegacy = Array.isArray(legacyExplicit) || Boolean(legacySelections && typeof legacySelections === "object");
    if (!canInheritLegacy(ctx, charName, hasLegacy)) return [];

    if (Array.isArray(legacyExplicit)) return legacyExplicit;
    if (legacySelections && typeof legacySelections === "object") return deriveFromSelections(legacySelections);

    return [];
}

/**
 * 写入当前卡的世界书配置。只写卡片键，旧的名字键原样保留（不删，便于回退）。
 * @returns {string} 实际写入的卡片键
 */
export function writeWorldInfoSelections(extData, ctx, selections, autoActiveBooks) {
    if (!extData.worldinfo || typeof extData.worldinfo !== "object") extData.worldinfo = {};
    const wiConfig = extData.worldinfo;
    if (!wiConfig.card_selections || typeof wiConfig.card_selections !== "object") wiConfig.card_selections = {};
    if (!wiConfig.card_auto_active_books || typeof wiConfig.card_auto_active_books !== "object") wiConfig.card_auto_active_books = {};

    const cardKey = getCharacterCardKey(ctx);
    wiConfig.card_selections[cardKey] = selections;
    wiConfig.card_auto_active_books[cardKey] = Array.isArray(autoActiveBooks) ? autoActiveBooks : [];
    return cardKey;
}

function getLocalAutoActiveBooks(charName, ctx = null) {
    return readAutoActiveBooks(getExtData(), ctx, charName);
}

function collectSessionActiveBooks(ctx, wiVars, charName = "Char", includeLocalAuto = false) {
    const activeBooks = new Set();
    const charId = ctx.characterId;

    if (wiVars.selected_world_info && Array.isArray(wiVars.selected_world_info)) {
        wiVars.selected_world_info.forEach(name => activeBooks.add(name));
    }

    if (charId !== undefined && ctx.characters && ctx.characters[charId]) {
        const charObj = ctx.characters[charId];
        const primary = charObj.data?.extensions?.world;
        if (primary) activeBooks.add(primary);

        const fileName = (charObj.avatar || "").replace(/\.[^/.]+$/, "");
        if (wiVars.world_info && wiVars.world_info.charLore) {
            const loreEntry = wiVars.world_info.charLore.find(e => e.name === fileName);
            if (loreEntry && Array.isArray(loreEntry.extraBooks)) {
                loreEntry.extraBooks.forEach(name => activeBooks.add(name));
            }
        }
    }

    if (ctx.chatMetadata && ctx.chatMetadata.world_info) {
        activeBooks.add(ctx.chatMetadata.world_info);
    }

    try {
        const personaWorld = power_user?.persona_description_lorebook;
        if (personaWorld) activeBooks.add(personaWorld);
    } catch (e) {
        console.warn("Titania: 获取 Persona 世界书失败", e);
    }

    if (includeLocalAuto) {
        const localAutoBooks = getLocalAutoActiveBooks(charName, ctx);
        localAutoBooks.forEach(name => activeBooks.add(name));
    }

    return activeBooks;
}

/**
 * 获取当前会话“已激活”的世界书名称（不关心条目是否启用）
 * @returns {string[]}
 */
export function getActiveWorldBookNames() {
    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) return [];

    let ctx;
    try {
        ctx = SillyTavern.getContext();
        if (!ctx) return [];
    } catch (e) {
        console.warn("Titania: 无法获取 SillyTavern context", e);
        return [];
    }

    const wiVars = getWorldInfoVars();
    const charName = getCurrentCharNameFromContext(ctx);
    return Array.from(collectSessionActiveBooks(ctx, wiVars, charName, true));
}

/**
 * 获取酒馆中所有世界书名称（无论是否激活）
 * @returns {Promise<string[]>}
 */
export async function getAllWorldBookNames() {
    try {
        if (Array.isArray(world_names) && world_names.length > 0) {
            return [...world_names];
        }

        if (Array.isArray(selected_world_info) && selected_world_info.length > 0) {
            return [...new Set(selected_world_info)];
        }

        return [];
    } catch (e) {
        console.warn("Titania: 获取全部世界书名称失败", e);
        return [];
    }
}

/**
 * 按世界书名称加载条目（用于管理页面按书查看）
 * @param {string} bookName
 * @returns {Promise<Array>}
 */
export async function getWorldInfoEntriesByBookName(bookName) {
    if (!bookName || typeof SillyTavern === "undefined" || !SillyTavern.getContext) {
        return [];
    }

    let ctx;
    try {
        ctx = SillyTavern.getContext();
        if (!ctx) return [];
    } catch (e) {
        console.warn("Titania: 无法获取 SillyTavern context", e);
        return [];
    }

    const bookData = await safeLoadWorldInfo(ctx, bookName, 10000);
    if (!bookData || !bookData.entries) return [];

    return Object.values(bookData.entries)
        .sort((a, b) => (a.order || 100) - (b.order || 100))
        .map(e => ({
            uid: e.uid,
            comment: e.comment || `条目 ${e.uid}`,
            content: e.content || "",
            preview: (e.content || "").substring(0, 80).replace(/\n/g, " "),
            isConstant: e.constant === true,
            isDisabled: e.disable === true && e.enabled !== true
        }));
}
