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

    // 获取世界书筛选配置
    const extData = getExtData();
    const wiConfig = extData.worldinfo || { char_selections: {} };
    const charSelections = wiConfig.char_selections[data.charName] || null;

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

function getLocalAutoActiveBooks(charName) {
    const extData = getExtData();
    const wiConfig = extData.worldinfo || {};

    const explicit = wiConfig.char_auto_active_books?.[charName];
    if (Array.isArray(explicit)) return explicit;

    const legacySelections = wiConfig.char_selections?.[charName];
    if (legacySelections && typeof legacySelections === "object") {
        return Object.keys(legacySelections).filter(bookName => {
            const selected = legacySelections[bookName];
            return Array.isArray(selected) && selected.length > 0;
        });
    }

    return [];
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
        const localAutoBooks = getLocalAutoActiveBooks(charName);
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
