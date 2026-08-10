// src/core/worldInfoManager.js

import { world_info, selected_world_info, saveWorldInfo, world_names } from "../../../world-info.js";
import { eventSource, event_types } from "../../../../script.js";
import { getContextData } from "./context.js";
import { TitaniaLogger } from "./logger.js";

// --- 同步状态管理 ---
const SYNC_STATE = {
    currentBookName: null, // 当前选中的世界书名称
    localEntries: [],      // 插件持有的数据副本（数组格式）
    isSelfSaving: false,   // 【核心锁】标记是否正在执行插件自身的保存操作
    debouncer: null,       // 防抖计时器句柄
    saveDelay: 500         // 自动保存延迟 (ms)
};

/**
 * 获取所有可用的世界书名称列表
 * @returns {string[]} 世界书名称列表
 */
export function getAvailableWorldBooks() {
    return [...(world_names || [])].sort((a, b) => a.localeCompare(b));
}

/**
 * 获取当前角色绑定的主要世界书
 * @returns {Promise<string|null>} 世界书名称
 */
export async function getCharacterWorldBook() {
    const ctx = await getContextData();
    // 这里我们需要更底层的访问，getContextData 返回的是处理后的数据
    // 我们尝试通过 SillyTavern.getContext() 获取
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        const stCtx = SillyTavern.getContext();
        const charId = stCtx.characterId;
        if (charId !== undefined && stCtx.characters && stCtx.characters[charId]) {
            return stCtx.characters[charId].data?.extensions?.world || null;
        }
    }
    return null;
}

/**
 * 加载世界书并建立同步上下文 (替代原有的 getWorldInfoEntries)
 * @param {string} bookName - 世界书名称
 * @returns {Promise<Array>} 条目数组
 */
export async function getWorldInfoEntries(bookName) {
    try {
        if (!bookName) throw new Error("未指定世界书名称");

        // 获取 Context
        if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
            throw new Error("SillyTavern Context 不可用");
        }
        const ctx = SillyTavern.getContext();

        // 加载世界书
        let book = null;
        if (ctx.loadWorldInfo && typeof ctx.loadWorldInfo === 'function') {
            book = await ctx.loadWorldInfo(bookName);
        }

        if (!book && world_info.loadedWorldInfo && world_info.loadedWorldInfo.name === bookName) {
            book = world_info.loadedWorldInfo;
        }

        if (!book) {
            // 如果书不存在，返回空数组，但不更新状态
            return [];
        }

        // --- 同步逻辑开始 ---
        SYNC_STATE.currentBookName = bookName;

        // 深拷贝数据，切断与 ST 核心缓存的引用联系
        const safeEntries = book.entries ? structuredClone(book.entries) : {};

        // 转换为数组并排序
        const entriesArray = Object.values(safeEntries).sort((a, b) => {
            return (a.order || 100) - (b.order || 100);
        });

        // 更新本地状态
        SYNC_STATE.localEntries = entriesArray;
        // --- 同步逻辑结束 ---

        return entriesArray;

    } catch (e) {
        TitaniaLogger.error("获取世界书条目失败", e);
        throw e;
    }
}

/**
 * 触发防抖保存
 * 任何对 SYNC_STATE.localEntries 的修改后都应调用此函数
 */
export function triggerSave() {
    // 清除上一次未执行的保存任务
    if (SYNC_STATE.debouncer) clearTimeout(SYNC_STATE.debouncer);

    SYNC_STATE.debouncer = setTimeout(async () => {
        const name = SYNC_STATE.currentBookName;
        const entries = SYNC_STATE.localEntries;

        if (!name || !entries) return;

        try {
            const ctx = SillyTavern.getContext();

            // 1. 上锁：标记“正在自我保存”
            SYNC_STATE.isSelfSaving = true;

            // 2. 数据转换：数组 -> ST 标准对象结构 (UID 为 Key)
            const entriesObj = {};
            entries.forEach(e => {
                if (e.uid !== undefined) entriesObj[e.uid] = e;
            });

            // 3. 调用 API 保存
            // 第三个参数 false 表示不强制立即刷写磁盘（由 ST 策略决定），但会立即更新内存
            if (ctx.saveWorldInfo) {
                await ctx.saveWorldInfo(name, { entries: entriesObj }, false);
            } else if (typeof saveWorldInfo === 'function') {
                await saveWorldInfo(name, { entries: entriesObj }, false);
            }

            console.log(`[Titania] Auto-saved: ${name}`);
        } catch (e) {
            console.error("[Titania] Save failed:", e);
        } finally {
            // 4. 延迟释放锁
            setTimeout(() => {
                SYNC_STATE.isSelfSaving = false;
            }, 500);
        }

    }, SYNC_STATE.saveDelay);
}

/**
 * 初始化同步监听器
 * 在插件启动时调用
 */
export function initSyncListener() {
    // 监听世界书更新事件
    eventSource.on(event_types.WORLDINFO_UPDATED, (name, data) => {
        // 1. 过滤：只关心当前正在查看的书
        if (SYNC_STATE.currentBookName !== name) return;

        // 2. 阻断：如果是自己触发的保存，忽略之
        if (SYNC_STATE.isSelfSaving) {
            return;
        }

        console.log(`[Titania] External change detected, reloading: ${name}`);

        // 3. 重新加载：外部变动，刷新插件数据
        // 注意：这里我们需要一种机制通知 UI 刷新。
        // 由于 getWorldInfoEntries 是被动调用的，我们可能需要触发一个自定义事件或调用 UI 刷新函数。
        // 假设 UI 会监听某个事件，或者我们直接调用 refreshSillyTavernUI (虽然它主要是刷新 ST 的 UI)

        // 重新加载数据到本地状态
        getWorldInfoEntries(name).then(() => {
            // 尝试刷新本插件的 UI
            // 这里假设有一个全局事件或者回调机制。
            // 如果没有，我们可以触发一个自定义 DOM 事件
            const event = new CustomEvent('titania-worldbook-updated', { detail: { name } });
            document.dispatchEvent(event);
        });
    });

    console.log("[Titania] Sync listener registered.");
}

/**
 * 刷新 ST 的世界书 UI
 * 参考 WorldbookEditor 的实现，使用事件系统和核心 API
 */
function refreshSillyTavernUI(bookName) {
    try {
        const ctx = SillyTavern.getContext();

        // 1. 刷新世界书列表 (updateWorldInfoList)
        // 这通常用于刷新左侧的选择列表
        if (ctx.updateWorldInfoList) {
            ctx.updateWorldInfoList();
        }

        // 2. 如果当前正在编辑这本书，刷新条目列表
        // 检查全局 selected_world_info 是否为当前书
        if (world_info.selected_world_info === bookName) {
            // WorldbookEditor 做法：直接调用 loadWorldInfo(name)
            // 这会重新加载数据并触发 UI 渲染
            if (typeof window.loadWorldInfo === 'function') {
                window.loadWorldInfo(bookName);
            } else if (ctx.loadWorldInfo) {
                // 尝试通过 context 调用，但通常 context.loadWorldInfo 只是返回数据
                // 如果 window.loadWorldInfo 不可用，尝试寻找 printWorldInfo
                if (typeof window.printWorldInfo === 'function') {
                    window.printWorldInfo();
                }
            }
        }
    } catch (e) {
        console.warn("Titania: Failed to refresh ST UI", e);
    }
}


/**
 * 创建或更新世界书条目 (使用本地状态 + 防抖保存)
 * @param {string} bookName - 目标世界书名称
 * @param {object} entryData - 条目数据 { keys, content, comment, ... }
 * @param {boolean} isFullUpdate - 是否为全量更新
 * @returns {Promise<boolean>} 是否成功
 */
export async function saveLoreEntry(bookName, entryData, isFullUpdate = false) {
    try {
        if (!bookName) throw new Error("未指定世界书名称");

        // 确保当前操作的是已加载的书
        if (SYNC_STATE.currentBookName !== bookName) {
            await getWorldInfoEntries(bookName);
        }

        const uid = entryData.uid || Date.now();
        let entry = SYNC_STATE.localEntries.find(e => e.uid == uid);

        if (isFullUpdate && entry) {
            // 全量更新模式
            Object.assign(entry, entryData);
        } else {
            // 默认模式：构造新条目或合并
            const newEntryData = {
                uid: uid,
                key: Array.isArray(entryData.keys) ? entryData.keys : (entryData.keys ? [entryData.keys] : []),
                keysecondary: entryData.keysecondary || [],
                comment: entryData.comment || (entryData.keys && entryData.keys[0]) || "New Entry",
                content: entryData.content || "",
                constant: entryData.constant || false,
                selective: entryData.selective !== undefined ? entryData.selective : true,
                order: entryData.order || 100,
                position: entryData.position !== undefined ? entryData.position : 1,
                disable: entryData.disable || false,
                excludeRecursion: false,
                probability: 100,
                useProbability: true,
                depth: 4,
                group: "",
            };

            if (entry) {
                // 更新现有
                Object.assign(entry, newEntryData);
            } else {
                // 新增
                entry = newEntryData;
                SYNC_STATE.localEntries.push(entry);
            }
        }

        // 触发防抖保存
        triggerSave();

        TitaniaLogger.info(`世界书条目已更新(本地): ${bookName} / UID:${uid}`);

        // 触发 UI 刷新 (本地)
        // refreshSillyTavernUI(bookName);

        return true;

    } catch (e) {
        TitaniaLogger.error("保存世界书条目失败", e);
        return false;
    }
}