// src/core/memoryRecall.js
// 记忆召回核心模块

import { TitaniaLogger } from "./logger.js";
import { semanticSearch } from "./semanticSearch.js";
import { getIndexStatus } from "./vectorStore.js";
import { getContextData, getChatHistory } from "./context.js";

/**
 * 待注入的记忆列表
 * 结构: { messageIndex: number, text: string, score: number }[]
 */
let pendingMemories = [];

/**
 * 获取当前角色 ID
 * @returns {string|null}
 */
export function getCurrentCharacterId() {
    try {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            const ctx = SillyTavern.getContext();
            return ctx?.characterId?.toString() || null;
        }
    } catch (e) {
        TitaniaLogger.warn("获取角色 ID 失败", e);
    }
    return null;
}

/**
 * 检索相关记忆
 * @param {string} query - 检索查询文本
 * @param {object} options - 选项
 * @param {number} [options.maxResults=10] - 最大结果数
 * @param {number} [options.minScore=0.5] - 最小相似度阈值 (0-1)
 * @returns {Promise<Array<{messageIndex: number, text: string, score: number}>>}
 */
export async function recallMemories(query, options = {}) {
    const characterId = getCurrentCharacterId();

    if (!characterId) {
        throw new Error("无法获取当前角色 ID，请确保已打开角色对话");
    }

    // 检查是否有向量索引
    const indexStatus = await getIndexStatus(characterId);
    if (!indexStatus || indexStatus.actualVectorCount === 0) {
        throw new Error("当前角色没有向量索引，请先在「智能总结」面板中建立向量索引");
    }

    const maxResults = options.maxResults || 10;
    const minScore = options.minScore || 0.5;

    TitaniaLogger.info("开始记忆检索", { query: query.substring(0, 50), maxResults, minScore });

    try {
        const results = await semanticSearch(query, characterId, {
            topK: maxResults,
            minScore: minScore
        });

        TitaniaLogger.info(`检索到 ${results.length} 条相关记忆`);

        return results.map(r => ({
            messageIndex: r.messageIndex,
            text: r.text,
            score: r.score
        }));
    } catch (e) {
        TitaniaLogger.error("记忆检索失败", e);
        throw new Error("检索失败: " + e.message);
    }
}

/**
 * 设置待注入的记忆
 * @param {Array<{messageIndex: number, text: string, score: number}>} memories
 */
export function setPendingMemories(memories) {
    pendingMemories = memories || [];
    TitaniaLogger.info(`设置 ${pendingMemories.length} 条待注入记忆`);
}

/**
 * 获取待注入的记忆
 * @returns {Array}
 */
export function getPendingMemories() {
    return [...pendingMemories];
}

/**
 * 清空待注入的记忆
 */
export function clearPendingMemories() {
    pendingMemories = [];
    TitaniaLogger.info("已清空待注入记忆");
}

/**
 * 格式化记忆为注入文本块
 * @param {Array<{messageIndex: number, text: string, score: number}>} memories
 * @returns {string}
 */
export function formatMemoryBlock(memories) {
    if (!memories || memories.length === 0) return '';

    const lines = memories.map(m =>
        `[相关记忆 #${m.messageIndex}] ${m.text}`
    );

    return `<titania-memory>\n${lines.join('\n')}\n</titania-memory>\n\n`;
}

/**
 * 将选中的记忆附加到输入框
 * @param {Array<{messageIndex: number, text: string, score: number}>} memories
 * @returns {boolean} 是否成功
 */
export function appendMemoriesToInput(memories) {
    const input = document.querySelector('#send_textarea');

    if (!input) {
        TitaniaLogger.error("未找到 SillyTavern 输入框");
        if (window.toastr) {
            toastr.error("未找到输入框", "Titania");
        }
        return false;
    }

    if (!memories || memories.length === 0) {
        TitaniaLogger.warn("没有选中的记忆");
        return false;
    }

    const memoryBlock = formatMemoryBlock(memories);
    const currentValue = input.value || '';

    // 插入到开头
    input.value = memoryBlock + currentValue;

    // 触发 input 事件让 ST 知道内容变化
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // 聚焦到输入框
    input.focus();

    TitaniaLogger.info(`已将 ${memories.length} 条记忆附加到输入框`);

    if (window.toastr) {
        toastr.success(`已附加 ${memories.length} 条记忆`, "Titania");
    }

    return true;
}

/**
 * 获取最近一条用户消息作为默认查询
 * @returns {string}
 */
export function getDefaultQuery() {
    try {
        const chat = getChatHistory();
        if (!chat || chat.length === 0) return '';

        // 从最后往前找最近的用户消息
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (msg.is_user && msg.mes) {
                // 取前500字符
                return msg.mes.substring(0, 500);
            }
        }

        // 如果没有用户消息，取最后一条消息
        const lastMsg = chat[chat.length - 1];
        if (lastMsg && lastMsg.mes) {
            return lastMsg.mes.substring(0, 500);
        }
    } catch (e) {
        TitaniaLogger.warn("获取默认查询失败", e);
    }
    return '';
}

/**
 * 获取记忆召回功能的状态信息
 * @returns {Promise<{available: boolean, vectorCount: number, message: string}>}
 */
export async function getRecallStatus() {
    const characterId = getCurrentCharacterId();

    if (!characterId) {
        return {
            available: false,
            vectorCount: 0,
            message: "请先打开角色对话"
        };
    }

    try {
        const indexStatus = await getIndexStatus(characterId);

        if (!indexStatus || indexStatus.actualVectorCount === 0) {
            return {
                available: false,
                vectorCount: 0,
                message: "未建立向量索引"
            };
        }

        return {
            available: true,
            vectorCount: indexStatus.actualVectorCount,
            message: `已索引 ${indexStatus.actualVectorCount} 条记录`
        };
    } catch (e) {
        return {
            available: false,
            vectorCount: 0,
            message: "检查状态失败"
        };
    }
}