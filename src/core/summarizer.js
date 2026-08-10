// src/core/summarizer.js
// 智能总结生成核心模块

import { getChatHistory } from "../utils/helpers.js";
import { getContextData } from "./context.js";
import { TitaniaLogger } from "./logger.js";
import { getFeatureConnection } from "./connection.js";
import { getExtData, saveExtData } from "../utils/storage.js";
import { oai_settings } from "../../../openai.js";
import { ChatCompletionService } from "../../../custom-request.js";
import { getRelevantContext, semanticSearch } from "./semanticSearch.js";
import { getCharacterVectors, getIndexStatus, clearCharacterVectors } from "./vectorStore.js";
import { getBatchEmbeddings, getEmbeddingConfig } from "./embeddings.js";
import { saveBatchEmbeddings, updateIndexMetadata } from "./vectorStore.js";
import { cleanTextForEmbedding, isValidCleanedText, getCleaningStats } from "./textCleaner.js";

const FEATURE_KEY = "summarizer";

// 自动向量化状态
let autoVectorizeState = {
    pendingCount: 0,
    lastCharacterId: null,
    isProcessing: false
};

/**
 * 获取总结功能配置
 * @returns {object}
 */
export function getSummarizerConfig() {
    const data = getExtData();
    return data.summarizer_config || {
        selected_profile_id: null,
        model_override: null,
        template: "structured",
        use_vector_search: true
    };
}

/**
 * 发送总结请求
 * @param {Array} messages - 消息数组
 * @param {object} options - 选项
 * @returns {Promise<string>} 返回内容
 */
async function sendSummaryRequest(messages, options = {}) {
    const summarizerCfg = getSummarizerConfig();

    // 尝试获取总结功能专用配置，如果没有则使用 lore_extractor 的配置
    let conn = getFeatureConnection(FEATURE_KEY);
    if (!conn) {
        conn = getFeatureConnection("lore_extractor");
    }

    if (!conn) {
        throw new Error("未配置 API 连接，请先在设置中配置");
    }

    // 读取全局配置的 max_tokens
    const data = getExtData();
    const cfg = data.config || {};
    const configMaxTokens = cfg.max_tokens || 4096;

    const model = options.model || summarizerCfg.model_override || conn.model;
    const maxTokens = options.maxTokens || configMaxTokens;
    const temperature = options.temperature || 0.5;

    if (conn.useSTConnection) {
        const requestData = ChatCompletionService.createRequestData({
            stream: false,
            messages: messages,
            chat_completion_source: oai_settings.chat_completion_source,
            model: model,
            max_tokens: oai_settings.openai_max_tokens || maxTokens,
            temperature: temperature,
            custom_url: oai_settings.custom_url,
            reverse_proxy: oai_settings.reverse_proxy,
            proxy_password: oai_settings.proxy_password,
            custom_prompt_post_processing: oai_settings.custom_prompt_post_processing,
        });

        const result = await ChatCompletionService.sendRequest(requestData, true, null);
        return result?.content || "";
    } else {
        if (!conn.key) {
            throw new Error("API Key 未设置");
        }

        let endpoint = conn.url.trim().replace(/\/+$/, "");
        if (!endpoint.endsWith("/chat/completions")) {
            if (endpoint.endsWith("/v1")) endpoint += "/chat/completions";
            else endpoint += "/v1/chat/completions";
        }

        const res = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${conn.key}`
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                stream: false,
                max_tokens: maxTokens,
                temperature: temperature
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`HTTP Error ${res.status}: ${res.statusText} - ${errText.substring(0, 100)}`);
        }

        const json = await res.json();
        return json.choices?.[0]?.message?.content || "";
    }
}

/**
 * 构建结构化总结的 Prompt
 */
function buildStructuredPrompt(context, history, relevantHistory = "") {
    const sysPrompt = `You are an expert Story Analyst and Session Recorder. Your task is to analyze the provided roleplay chat history and generate a comprehensive, structured summary.

[Your Goals]
1. Capture the current state of the story accurately
2. Record important details that may be referenced later
3. Track character development and relationships
4. Note any unresolved plot threads or foreshadowing

[Output Structure]
Generate a summary in the following format (use the same language as the chat history):

## 📍 当前场景
[描述当前所在位置、时间、环境氛围]

## 👥 角色状态
[列出主要角色的当前状态、位置、情绪、装备等]
- **角色名**: 状态描述

## 📜 情节回顾
[按时间顺序列出本段对话中发生的重要事件]
1. 事件描述
2. 事件描述
...

## 💬 重要对话/信息
[记录任何重要的对话内容、揭示的信息、约定等]

## 🔮 悬念/待办
[列出任何未解决的问题、伏笔、待处理事项]

[Rules]
1. Be concise but thorough - don't omit important details
2. Use the SAME LANGUAGE as the chat history (likely Chinese)
3. Focus on facts from the text, don't add assumptions
4. If information is unclear, use [?] to mark uncertainty
5. Keep the summary actionable and useful for future reference`;

    let userPrompt = `[Context]
Character: ${context.charName}
User: ${context.userName}

[Chat History to Summarize]
${history}`;

    if (relevantHistory) {
        userPrompt += `

[Semantically Related Past Events]
The following are past events that may be relevant to the current context:
${relevantHistory}`;
    }

    userPrompt += `

[Task]
Please generate a structured summary based on the above content.`;

    return [
        { role: "system", content: sysPrompt },
        { role: "user", content: userPrompt }
    ];
}

/**
 * 构建叙事式总结的 Prompt
 */
function buildNarrativePrompt(context, history, relevantHistory = "") {
    const sysPrompt = `You are a skilled Narrator and Story Chronicler. Your task is to write a narrative summary of the roleplay session, as if writing a story recap.

[Style Guidelines]
- Write in a flowing, narrative prose style
- Maintain the tone and atmosphere of the original story
- Use past tense for recounting events
- Include sensory details and emotional beats
- Keep it concise but evocative

[Rules]
1. Use the SAME LANGUAGE as the chat history
2. Stay faithful to the events as they occurred
3. Don't add events that didn't happen
4. Highlight character moments and plot developments`;

    let userPrompt = `[Context]
Story featuring: ${context.charName} and ${context.userName}

[Session Log]
${history}`;

    if (relevantHistory) {
        userPrompt += `

[Related Background]
${relevantHistory}`;
    }

    userPrompt += `

Please write a narrative summary of this session (2-3 paragraphs).`;

    return [
        { role: "system", content: sysPrompt },
        { role: "user", content: userPrompt }
    ];
}

/**
 * 预览总结提示词（不发送请求）
 * 用于在生成总结前检查将要发送的内容
 * @param {string} characterId - 角色 ID
 * @param {object} options - 选项
 * @param {number} [options.historyLimit] - 分析的历史记录条数
 * @param {string} [options.template] - 模板类型: "structured" | "narrative" | "custom"
 * @param {boolean} [options.useVectorSearch] - 是否使用向量化语义检索
 * @param {string} [options.customPrompt] - 自定义系统提示词
 * @returns {Promise<{messages: Array, historyCount: number, relevantHistoryFound: boolean}>}
 */
export async function previewSummaryPrompt(characterId, options = {}) {
    const summarizerCfg = getSummarizerConfig();
    const historyLimit = options.historyLimit || 20;
    const template = options.template || summarizerCfg.template || "structured";
    const useVectorSearch = options.useVectorSearch !== undefined
        ? options.useVectorSearch
        : summarizerCfg.use_vector_search;
    const customPrompt = options.customPrompt || summarizerCfg.custom_prompt || "";

    TitaniaLogger.info("预览提示词...", {
        characterId,
        historyLimit,
        template,
        useVectorSearch,
        hasCustomPrompt: !!customPrompt
    });

    // 1. 获取上下文和历史记录
    const ctx = await getContextData();
    const history = getChatHistory(historyLimit);

    if (!history || history.trim().length === 0) {
        throw new Error("聊天记录为空");
    }

    // 统计实际读取的消息条数（粗略计算：按换行和角色标记分割）
    const messagePattern = /(?:^|\n)(?:\*\*[^*]+\*\*:|[^:\n]+:)/g;
    const matches = history.match(messagePattern);
    const actualHistoryCount = matches ? matches.length : historyLimit;

    // 2. 如果启用向量搜索，获取相关历史
    let relevantHistory = "";
    let relevantHistoryFound = false;
    if (useVectorSearch && characterId) {
        try {
            const indexStatus = await getIndexStatus(characterId);
            if (indexStatus && indexStatus.actualVectorCount > 0) {
                // 使用当前历史作为查询，找到相关的过去事件
                const queryText = history.substring(0, 1000); // 取前1000字符作为查询
                relevantHistory = await getRelevantContext(queryText, characterId, {
                    maxTokens: 1500,
                    topK: 10,
                    minScore: 0.5
                });

                if (relevantHistory) {
                    relevantHistoryFound = true;
                    TitaniaLogger.info("已获取相关历史记录");
                }
            }
        } catch (e) {
            TitaniaLogger.warn("获取相关历史失败", e);
        }
    }

    // 3. 构建 Prompt
    let messages;
    if (customPrompt) {
        messages = buildCustomPrompt(ctx, history, relevantHistory, customPrompt);
    } else if (template === "narrative") {
        messages = buildNarrativePrompt(ctx, history, relevantHistory);
    } else {
        messages = buildStructuredPrompt(ctx, history, relevantHistory);
    }

    return {
        messages,
        historyCount: actualHistoryCount,
        relevantHistoryFound
    };
}

/**
 * 生成智能总结
 * @param {string} characterId - 角色 ID
 * @param {object} options - 选项
 * @param {number} [options.historyLimit] - 分析的历史记录条数
 * @param {string} [options.template] - 模板类型: "structured" | "narrative" | "custom"
 * @param {boolean} [options.useVectorSearch] - 是否使用向量化语义检索
 * @param {string} [options.customPrompt] - 自定义系统提示词
 * @returns {Promise<{summary: string, rawResponse: string, messages: Array}>}
 */
export async function generateSummary(characterId, options = {}) {
    const summarizerCfg = getSummarizerConfig();
    const historyLimit = options.historyLimit || 20;
    const template = options.template || summarizerCfg.template || "structured";
    const useVectorSearch = options.useVectorSearch !== undefined
        ? options.useVectorSearch
        : summarizerCfg.use_vector_search;
    const customPrompt = options.customPrompt || summarizerCfg.custom_prompt || "";

    TitaniaLogger.info("开始生成总结...", {
        characterId,
        historyLimit,
        template,
        useVectorSearch,
        hasCustomPrompt: !!customPrompt
    });

    // 1. 获取上下文和历史记录
    const ctx = await getContextData();
    const history = getChatHistory(historyLimit);

    if (!history || history.trim().length === 0) {
        throw new Error("聊天记录为空，无法生成总结");
    }

    // 2. 如果启用向量搜索，获取相关历史
    let relevantHistory = "";
    if (useVectorSearch && characterId) {
        try {
            const indexStatus = await getIndexStatus(characterId);
            if (indexStatus && indexStatus.actualVectorCount > 0) {
                // 使用当前历史作为查询，找到相关的过去事件
                const queryText = history.substring(0, 1000); // 取前1000字符作为查询
                relevantHistory = await getRelevantContext(queryText, characterId, {
                    maxTokens: 1500,
                    topK: 10,
                    minScore: 0.5
                });

                if (relevantHistory) {
                    TitaniaLogger.info("已获取相关历史记录用于增强总结");
                }
            }
        } catch (e) {
            TitaniaLogger.warn("获取相关历史失败，将继续生成普通总结", e);
        }
    }

    // 3. 构建 Prompt
    let messages;
    if (customPrompt) {
        // 使用自定义提示词
        messages = buildCustomPrompt(ctx, history, relevantHistory, customPrompt);
    } else if (template === "narrative") {
        messages = buildNarrativePrompt(ctx, history, relevantHistory);
    } else {
        messages = buildStructuredPrompt(ctx, history, relevantHistory);
    }

    // 4. 发送请求
    let rawContent = "";
    try {
        rawContent = await sendSummaryRequest(messages, {
            temperature: template === "narrative" ? 0.7 : 0.4
        });
    } catch (e) {
        TitaniaLogger.error("总结请求失败", e);
        // 返回发送的 messages 便于调试
        const error = new Error("总结生成失败: " + (e.message || "未知错误"));
        error.messages = messages;
        throw error;
    }

    if (!rawContent) {
        const error = new Error("API 返回内容为空");
        error.messages = messages;
        throw error;
    }

    TitaniaLogger.info("总结生成完成");

    return {
        summary: rawContent,
        rawResponse: rawContent,
        messages: messages  // 返回发送的 messages 供查看
    };
}

/**
 * 构建自定义 Prompt
 */
function buildCustomPrompt(context, history, relevantHistory, customSystemPrompt) {
    let userPrompt = `[Context]
Character: ${context.charName}
User: ${context.userName}

[Chat History to Summarize]
${history}`;

    if (relevantHistory) {
        userPrompt += `

[Semantically Related Past Events]
${relevantHistory}`;
    }

    userPrompt += `

[Task]
Please generate a summary based on the above content.`;

    return [
        { role: "system", content: customSystemPrompt },
        { role: "user", content: userPrompt }
    ];
}

/**
 * 获取向量化状态（用于 UI 显示）
 * @param {string} characterId - 角色 ID
 * @returns {Promise<{hasIndex: boolean, totalIndexed: number, lastMessageIndex: number, newMessagesCount: number}>}
 */
export async function getVectorIndexStatus(characterId) {
    const metadata = await getIndexStatus(characterId);

    // 获取当前聊天历史的总消息数
    let currentTotalMessages = 0;
    try {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            const ctx = SillyTavern.getContext();
            currentTotalMessages = ctx.chat?.length || 0;
        }
    } catch (e) {
        TitaniaLogger.warn("获取当前消息总数失败", e);
    }

    if (!metadata) {
        return {
            hasIndex: false,
            totalIndexed: 0,
            lastMessageIndex: -1,
            newMessagesCount: currentTotalMessages
        };
    }

    const lastMessageIndex = metadata.lastMessageIndex || -1;
    const newMessagesCount = Math.max(0, currentTotalMessages - lastMessageIndex - 1);

    return {
        hasIndex: true,
        totalIndexed: metadata.actualVectorCount || 0,
        lastMessageIndex: lastMessageIndex,
        newMessagesCount: newMessagesCount
    };
}

/**
 * 为角色建立向量索引（支持增量更新）
 * @param {string} characterId - 角色 ID
 * @param {object} options - 选项
 * @param {number} [options.limit] - 处理的消息数量限制
 * @param {boolean} [options.incremental] - 是否增量更新（只处理新消息），默认 true
 * @param {boolean} [options.rebuild] - 是否强制重建（清除现有索引），默认 false
 * @param {function} [options.onProgress] - 进度回调 (current, total, status)
 * @returns {Promise<{indexed: number, skipped: number, mode: string}>}
 */
export async function buildVectorIndex(characterId, options = {}) {
    const limit = options.limit || 1000;
    const incremental = options.incremental !== false; // 默认为增量模式
    const rebuild = options.rebuild === true; // 默认不重建
    const onProgress = options.onProgress;

    TitaniaLogger.info(`开始为角色 ${characterId} 建立向量索引...`, { incremental, rebuild });

    if (onProgress) onProgress(0, 0, "正在获取聊天历史...");

    // 获取 SillyTavern 上下文和聊天历史
    let chatMessages = [];
    try {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            const ctx = SillyTavern.getContext();
            chatMessages = ctx.chat || [];
        }
    } catch (e) {
        TitaniaLogger.warn("获取聊天历史失败", e);
    }

    if (chatMessages.length === 0) {
        throw new Error("聊天记录为空，无法建立索引");
    }

    // 获取现有索引状态
    let startIndex = 0;
    let mode = "full"; // "full" | "incremental"

    if (rebuild) {
        // 强制重建：清除现有索引
        if (onProgress) onProgress(0, 0, "清除现有索引...");
        await clearCharacterVectors(characterId);
        mode = "rebuild";
        TitaniaLogger.info("已清除现有索引，开始完整重建");
    } else if (incremental) {
        // 增量模式：检查上次索引到哪条消息
        const metadata = await getIndexStatus(characterId);
        if (metadata && typeof metadata.lastMessageIndex === 'number') {
            startIndex = metadata.lastMessageIndex + 1;
            mode = "incremental";
            TitaniaLogger.info(`增量模式：从消息 ${startIndex} 开始`);
        }
    }

    // 过滤需要处理的消息
    const messagesToProcess = chatMessages
        .map((msg, index) => ({ msg, originalIndex: index }))
        .filter(({ msg, originalIndex }) => {
            // 跳过已处理的消息
            if (originalIndex < startIndex) return false;
            // 跳过系统消息
            if (msg.is_system) return false;
            // 跳过空消息
            if (!msg.mes || msg.mes.trim().length < 20) return false;
            return true;
        })
        .slice(0, limit); // 限制处理数量

    if (messagesToProcess.length === 0) {
        TitaniaLogger.info("没有新消息需要处理");
        return {
            indexed: 0,
            skipped: 0,
            mode: mode,
            message: "没有新消息需要向量化"
        };
    }

    TitaniaLogger.info(`找到 ${messagesToProcess.length} 条消息需要处理 (从索引 ${startIndex} 开始)`);

    if (onProgress) onProgress(0, messagesToProcess.length, `准备处理 ${messagesToProcess.length} 条消息...`);

    // 提取消息文本并进行清洗
    const segments = [];
    const cleaningStats = { total: 0, cleaned: 0, skipped: 0, totalRemoved: 0 };

    for (const { msg } of messagesToProcess) {
        const sender = msg.is_user ? "User" : (msg.name || "Character");
        const rawText = `${sender}: ${msg.mes}`;

        // 使用文本清洗模块处理
        const cleanedText = cleanTextForEmbedding(rawText);

        cleaningStats.total++;

        if (isValidCleanedText(cleanedText)) {
            segments.push(cleanedText);
            cleaningStats.cleaned++;

            // 统计清洗效果
            const stats = getCleaningStats(rawText, cleanedText);
            cleaningStats.totalRemoved += stats.removedChars;
        } else {
            cleaningStats.skipped++;
            // 跳过无效文本，但仍需要保持索引对应
            segments.push(null);
        }
    }

    TitaniaLogger.info(`文本清洗完成: ${cleaningStats.cleaned} 条有效, ${cleaningStats.skipped} 条跳过, 共移除 ${cleaningStats.totalRemoved} 字符`);

    // 过滤掉 null（跳过的消息），同时更新 messagesToProcess
    const validIndices = segments.map((s, i) => s !== null ? i : -1).filter(i => i !== -1);
    const validSegments = segments.filter(s => s !== null);
    const validMessagesToProcess = validIndices.map(i => messagesToProcess[i]);

    if (validSegments.length === 0) {
        TitaniaLogger.info("清洗后没有有效消息需要处理");
        return {
            indexed: 0,
            skipped: cleaningStats.skipped,
            mode: mode,
            message: "清洗后没有有效消息需要向量化"
        };
    }

    // 批量获取向量
    let vectors;
    try {
        vectors = await getBatchEmbeddings(validSegments, {
            onProgress: (current, total) => {
                if (onProgress) onProgress(current, total, `向量化中... ${current}/${total}`);
            },
            batchSize: 10
        });
    } catch (e) {
        TitaniaLogger.error("批量向量化失败", e);
        throw new Error("向量化失败: " + e.message);
    }

    if (onProgress) onProgress(validMessagesToProcess.length, validMessagesToProcess.length, "正在保存到数据库...");

    // 准备保存数据（使用真实的消息索引）
    const entries = validMessagesToProcess.map(({ msg, originalIndex }, i) => ({
        messageIndex: originalIndex,  // 使用聊天历史中的真实索引
        text: validSegments[i],
        vector: vectors[i]
    }));

    // 批量保存
    const savedCount = await saveBatchEmbeddings(characterId, entries);

    // 计算最后处理的消息索引（使用原始 messagesToProcess，确保记录正确的最后索引）
    const lastProcessedIndex = messagesToProcess.length > 0
        ? messagesToProcess[messagesToProcess.length - 1].originalIndex
        : startIndex - 1;

    // 记录当前使用的 embedding 模型（用于模型切换检测）
    const currentEmbeddingModel = getEmbeddingConfig().model;

    // 更新元数据
    const existingMetadata = await getIndexStatus(characterId);
    const previousIndexedCount = existingMetadata?.actualVectorCount || 0;

    await updateIndexMetadata(characterId, {
        totalMessages: chatMessages.length,
        lastMessageIndex: lastProcessedIndex,  // 记录最后处理的消息索引
        lastIndexedAt: Date.now(),
        indexMode: mode,
        embeddingModel: currentEmbeddingModel  // 记录使用的模型
    });

    TitaniaLogger.info(`向量索引${mode === 'incremental' ? '增量更新' : '建立'}完成: ${savedCount} 条已索引`);

    return {
        indexed: savedCount,
        skipped: cleaningStats.skipped + (validMessagesToProcess.length - savedCount),
        mode: mode,
        totalInDatabase: previousIndexedCount + savedCount,
        cleaningStats: cleaningStats,
        message: mode === 'incremental'
            ? `增量添加 ${savedCount} 条向量（总计 ${previousIndexedCount + savedCount} 条）`
            : `已索引 ${savedCount} 条消息`
    };
}

/**
 * 获取自动向量化配置
 * @returns {object}
 */
export function getAutoVectorizeConfig() {
    const data = getExtData();
    const embeddingConfig = data.embedding_config || {};
    return embeddingConfig.auto_vectorize || {
        enabled: false,
        batch_threshold: 5,
        notify_user: true
    };
}

/**
 * 检查是否需要自动向量化
 * @param {string} characterId - 角色 ID
 * @returns {Promise<{needsVectorize: boolean, pendingCount: number}>}
 */
export async function checkAutoVectorizeNeeded(characterId) {
    const config = getAutoVectorizeConfig();

    if (!config.enabled) {
        return { needsVectorize: false, pendingCount: 0 };
    }

    // 获取当前聊天历史的总消息数
    let currentTotalMessages = 0;
    try {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            const ctx = SillyTavern.getContext();
            currentTotalMessages = ctx.chat?.length || 0;
        }
    } catch (e) {
        TitaniaLogger.warn("获取当前消息总数失败", e);
        return { needsVectorize: false, pendingCount: 0 };
    }

    // 获取已索引的最后消息索引
    const indexStatus = await getIndexStatus(characterId);
    const lastIndexedMessage = indexStatus?.lastMessageIndex ?? -1;

    // 计算未索引的消息数
    const pendingCount = currentTotalMessages - lastIndexedMessage - 1;

    // 检查是否达到阈值
    const needsVectorize = pendingCount >= config.batch_threshold;

    return { needsVectorize, pendingCount };
}

/**
 * 自动向量化（由消息事件触发）
 * @param {string} characterId - 角色 ID
 * @returns {Promise<object|null>} 向量化结果或 null
 */
export async function autoVectorizeIfNeeded(characterId) {
    const config = getAutoVectorizeConfig();

    if (!config.enabled) {
        return null;
    }

    // 防止重复处理
    if (autoVectorizeState.isProcessing) {
        TitaniaLogger.info("自动向量化正在进行中，跳过");
        return null;
    }

    // 检查是否需要向量化
    const { needsVectorize, pendingCount } = await checkAutoVectorizeNeeded(characterId);

    if (!needsVectorize) {
        TitaniaLogger.info(`未达到自动向量化阈值 (${pendingCount}/${config.batch_threshold})`);
        return null;
    }

    autoVectorizeState.isProcessing = true;
    autoVectorizeState.lastCharacterId = characterId;

    try {
        TitaniaLogger.info(`触发自动向量化: ${pendingCount} 条待处理消息`);

        // 执行增量向量化
        const result = await buildVectorIndex(characterId, {
            incremental: true,
            onProgress: (current, total, status) => {
                // 可以在这里添加进度通知
            }
        });

        // 显示通知
        if (config.notify_user && result.indexed > 0 && window.toastr) {
            toastr.success(
                `自动索引了 ${result.indexed} 条消息`,
                "Titania 向量化",
                { timeOut: 3000 }
            );
        }

        return result;
    } catch (e) {
        TitaniaLogger.error("自动向量化失败", e);
        if (config.notify_user && window.toastr) {
            toastr.warning("自动向量化失败: " + e.message, "Titania");
        }
        return null;
    } finally {
        autoVectorizeState.isProcessing = false;
    }
}

/**
 * 重置自动向量化计数器
 */
export function resetAutoVectorizeCounter() {
    autoVectorizeState.pendingCount = 0;
}

/**
 * 增加自动向量化计数器并检查是否需要触发
 * @param {string} characterId - 角色 ID
 */
export async function incrementAutoVectorizeCounter(characterId) {
    const config = getAutoVectorizeConfig();

    if (!config.enabled) return;

    // 如果切换了角色，重置计数器
    if (autoVectorizeState.lastCharacterId !== characterId) {
        autoVectorizeState.pendingCount = 0;
        autoVectorizeState.lastCharacterId = characterId;
    }

    autoVectorizeState.pendingCount++;

    // 检查是否达到阈值
    if (autoVectorizeState.pendingCount >= config.batch_threshold) {
        autoVectorizeState.pendingCount = 0;
        await autoVectorizeIfNeeded(characterId);
    }
}

/**
 * 检查 Embedding 模型是否已更改（与现有索引不一致）
 * @param {string} characterId - 角色 ID
 * @returns {Promise<{changed: boolean, oldModel: string, newModel: string}>}
 */
export async function checkEmbeddingModelChanged(characterId) {
    const currentModel = getEmbeddingConfig().model;
    const indexStatus = await getIndexStatus(characterId);

    if (!indexStatus || !indexStatus.embeddingModel) {
        // 没有现有索引或没有记录模型信息
        return { changed: false, oldModel: null, newModel: currentModel };
    }

    const oldModel = indexStatus.embeddingModel;
    const changed = oldModel !== currentModel;

    if (changed) {
        TitaniaLogger.warn(`检测到 Embedding 模型已更改: ${oldModel} -> ${currentModel}`);
    }

    return { changed, oldModel, newModel: currentModel };
}

/**
 * 将总结转换为世界书条目格式
 * @param {string} summary - 总结内容
 * @param {object} options - 选项
 * @returns {object} 世界书条目
 */
export function summaryToLoreEntry(summary, options = {}) {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD

    return {
        keys: [
            `总结_${dateStr}`,
            `Summary_${dateStr}`,
            options.customKey || `session_${now.getTime()}`
        ],
        category: "Event",
        content: summary,
        reason: "由智能总结功能自动生成",
        confidence: "High",
        action: "new"
    };
}