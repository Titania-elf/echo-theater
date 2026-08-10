// src/core/loreExtractor.js

import { getChatHistory } from "../utils/helpers.js";
import { getContextData, getActiveWorldInfoEntries } from "./context.js";
import { TitaniaLogger } from "./logger.js";
import {
    getFeatureConnection,
    sendChatRequest
} from "./connection.js";
import { getExtData } from "../utils/storage.js";
import { oai_settings } from "../../../openai.js";
import { ChatCompletionService } from "../../../custom-request.js";

const FEATURE_KEY = "lore_extractor";

// 缓存世界书条目数据，避免重复加载
let _cachedWorldInfoEntries = null;
let _cacheTimestamp = 0;
const CACHE_TTL = 30000; // 缓存有效期 30 秒

/**
 * 获取缓存的世界书条目（带过期机制）
 * @returns {Promise<Array>} 世界书条目数组
 */
async function getCachedWorldInfoEntries() {
    const now = Date.now();
    if (_cachedWorldInfoEntries && (now - _cacheTimestamp) < CACHE_TTL) {
        return _cachedWorldInfoEntries;
    }
    _cachedWorldInfoEntries = await getActiveWorldInfoEntries();
    _cacheTimestamp = now;
    return _cachedWorldInfoEntries;
}

/**
 * 为更新类型的条目附加原有内容（用于 UI 对比显示）
 * @param {Array} entries - AI 提取的条目数组
 * @returns {Promise<Array>} 附加了原有内容的条目数组
 */
async function enrichEntriesWithOriginalContent(entries) {
    if (!entries || entries.length === 0) return entries;

    // 获取所有现有世界书条目
    const activeEntries = await getCachedWorldInfoEntries();

    // 构建 UID -> 条目内容 的映射
    const uidToContent = new Map();
    const uidToKeys = new Map();
    activeEntries.forEach(book => {
        book.entries.forEach(e => {
            uidToContent.set(e.uid, e.content || "");
            uidToKeys.set(e.uid, Array.isArray(e.keys) ? e.keys : (e.keys ? [e.keys] : []));
        });
    });

    // 为每个条目附加原有内容
    return entries.map(entry => {
        if (entry.action === 'update' && entry.matched_uid) {
            const originalContent = uidToContent.get(entry.matched_uid);
            const originalKeys = uidToKeys.get(entry.matched_uid);
            return {
                ...entry,
                originalContent: originalContent || null,
                originalKeys: originalKeys || null
            };
        }
        return entry;
    });
}

/**
 * 从 AI 输出中提取 JSON 内容
 * 支持多种格式：纯 JSON、Markdown 代码块、带有前后文本的 JSON
 * @param {string} rawContent - AI 返回的原始内容
 * @returns {string} 提取并清洗后的 JSON 字符串
 */
function extractJSONFromAIOutput(rawContent) {
    if (!rawContent || typeof rawContent !== 'string') {
        return '';
    }

    let content = rawContent;

    // 1. 移除 AI 思考标签 (Claude, DeepSeek 等模型可能包含)
    const thinkingTags = [
        /<thinking[\s\S]*?<\/thinking>/gi,
        /<think[\s\S]*?<\/think>/gi,
        /<reasoning[\s\S]*?<\/reasoning>/gi,
        /<reflection[\s\S]*?<\/reflection>/gi,
        /<analysis[\s\S]*?<\/analysis>/gi,
        /<internal[\s\S]*?<\/internal>/gi,
    ];
    for (const pattern of thinkingTags) {
        content = content.replace(pattern, '');
    }

    // 2. 尝试提取 Markdown 代码块中的 JSON
    // 匹配 ```json ... ``` 或 ``` ... ```
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
        content = codeBlockMatch[1];
    }

    // 3. 直接提取 JSON 对象 (从第一个 { 到最后一个 })
    // 这可以处理 AI 在 JSON 前后添加解释文本的情况
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        content = jsonMatch[0];
    }

    // 4. 移除尾随逗号 (JSON 规范不允许，但某些 AI 可能会生成)
    // 匹配 },] 或 },} 等模式
    content = content.replace(/,\s*([}\]])/g, '$1');

    return content.trim();
}

/**
 * 多策略 JSON 解析
 * 依次尝试多种解析策略，提高容错性
 * @param {string} rawContent - AI 返回的原始内容
 * @returns {object} 解析后的 JSON 对象
 * @throws {Error} 如果所有策略都失败
 */
function parseAIJSON(rawContent) {
    const strategies = [
        // 策略 1：使用 extractJSONFromAIOutput 提取后解析
        {
            name: 'extractJSON',
            fn: (c) => {
                const extracted = extractJSONFromAIOutput(c);
                if (!extracted) throw new Error('提取结果为空');
                return JSON.parse(extracted);
            }
        },
        // 策略 2：直接解析（适用于纯 JSON 输出）
        {
            name: 'direct',
            fn: (c) => JSON.parse(c.trim())
        },
        // 策略 3：提取代码块后解析
        {
            name: 'codeBlock',
            fn: (c) => {
                const match = c.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (!match) throw new Error('未找到代码块');
                return JSON.parse(match[1].trim());
            }
        },
        // 策略 4：宽松提取 JSON 对象
        {
            name: 'looseExtract',
            fn: (c) => {
                const match = c.match(/\{[\s\S]*\}/);
                if (!match) throw new Error('未找到 JSON 对象');
                return JSON.parse(match[0]);
            }
        },
        // 策略 5：移除尾随逗号后解析
        {
            name: 'removeTrailingCommas',
            fn: (c) => {
                const cleaned = c.replace(/,\s*([}\]])/g, '$1');
                const match = cleaned.match(/\{[\s\S]*\}/);
                if (!match) throw new Error('未找到 JSON 对象');
                return JSON.parse(match[0]);
            }
        },
        // 策略 6：修复常见 JSON 错误后解析
        {
            name: 'fixCommonErrors',
            fn: (c) => {
                let fixed = c;
                // 移除思考标签
                fixed = fixed.replace(/<thinking[\s\S]*?<\/thinking>/gi, '');
                fixed = fixed.replace(/<think[\s\S]*?<\/think>/gi, '');
                // 移除代码块标记
                fixed = fixed.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
                // 提取 JSON
                const match = fixed.match(/\{[\s\S]*\}/);
                if (!match) throw new Error('未找到 JSON 对象');
                // 移除尾随逗号
                let jsonStr = match[0].replace(/,\s*([}\]])/g, '$1');
                // 尝试修复单引号（非标准但某些 AI 可能生成）
                // 注意：这可能破坏包含单引号的字符串值，所以只在其他方法失败时尝试
                try {
                    return JSON.parse(jsonStr);
                } catch {
                    // 尝试将单引号替换为双引号（仅用于键名）
                    jsonStr = jsonStr.replace(/'([^']+)':/g, '"$1":');
                    return JSON.parse(jsonStr);
                }
            }
        }
    ];

    const errors = [];

    for (const strategy of strategies) {
        try {
            const result = strategy.fn(rawContent);
            console.log(`[Titania] JSON 解析成功，使用策略: ${strategy.name}`);
            return result;
        } catch (e) {
            errors.push({ strategy: strategy.name, error: e.message });
        }
    }

    // 所有策略都失败了，记录详细错误
    TitaniaLogger.error('所有 JSON 解析策略均失败', {
        rawContentPreview: rawContent.substring(0, 500),
        errors
    });

    throw new Error(`无法解析 AI 返回的 JSON 数据。尝试了 ${strategies.length} 种策略均失败。`);
}


/**
 * 发送设定提取请求（使用功能专用配置）
 * @param {Array} messages - 消息数组
 * @param {object} options - 选项
 * @returns {Promise<string>} 返回内容
 */
async function sendFeatureRequest(messages, options = {}) {
    const conn = getFeatureConnection(FEATURE_KEY);

    if (!conn) {
        throw new Error("未配置 API 连接，请先在设定提取窗口中配置");
    }

    // 读取全局配置的 max_tokens
    const data = getExtData();
    const cfg = data.config || {};
    const configMaxTokens = cfg.max_tokens || 4096;

    const model = options.model || conn.model;
    const maxTokens = options.maxTokens || configMaxTokens;
    const temperature = options.temperature || 0.3;

    if (conn.useSTConnection) {
        // 使用 ST 的 ChatCompletionService 发送请求
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
        // 使用自定义配置直接发送请求
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
 * 构建设定提取的 Prompt
 * @param {object} ctx - 上下文数据
 * @param {string} history - 聊天历史
 * @param {string} existingLoreSummary - 现有世界书摘要
 * @returns {Array} messages 数组
 */
function buildExtractPrompt(ctx, history, existingLoreSummary) {
    const sysPrompt = `You are an expert Lorekeeper and World Builder. Your task is to analyze the provided roleplay chat history and extract key information into a structured JSON format for a World Info (Lorebook) database.

[Target Information]
Identify and extract:
1. **Locations**: New places visited or mentioned (Name, Description, Atmosphere).
2. **Characters**: New NPCs or significant character developments (Name, Appearance, Personality, Role).
3. **Items/Artifacts**: Important objects (Name, Function, Origin).
4. **Events/Lore**: Historical events, rules of the world, or plot-critical facts.

[Existing Lorebook Entries]
The following entries already exist in the database. If you extract information that relates to an existing entry, set "action" to "update" and include the "matched_uid". Your updated "content" should MERGE the existing information with any new facts (do not simply overwrite).

${existingLoreSummary || "(None)"}

[Output Format]
Return ONLY a valid JSON object with the following structure:
{
  "entries": [
    {
      "keys": ["Primary Keyword", "Alias 1", "Alias 2"],
      "category": "Location" | "Character" | "Item" | "Event" | "Other",
      "content": "Comprehensive description suitable for a lorebook entry. Write in the same language as the chat history (Chinese).",
      "reason": "Brief explanation of why this was extracted.",
      "confidence": "High" | "Medium" | "Low",
      "action": "new" | "update",
      "matched_uid": 12345 (Only if action is "update", provide the UID from Existing Lorebook Entries),
      "matched_book": "Book Name" (Only if action is "update")
    }
  ]
}

[Rules]
1. **Update vs New**: If the extracted entity matches an existing entry (by Keys or context), set "action" to "update" and provide the "matched_uid". The "content" should be a MERGED version that:
   - Preserves all important information from the existing entry
   - Adds or updates with new facts from the chat history
   - Resolves any contradictions by preferring newer information
   - Maintains coherent organization
2. **Ignore Trivial Details**: Only extract information that is likely to be relevant for future context.
3. **Consolidate**: If an entity is mentioned multiple times, combine the information into a single entry.
4. **Language**: The 'content' field MUST be in Chinese (if the chat is in Chinese).
5. **JSON Only**: Do not output any markdown formatting, explanations, or code blocks outside the JSON.

[CRITICAL OUTPUT REQUIREMENTS]
- Your response MUST start with { and end with }
- Do NOT include \`\`\`json or \`\`\` markers
- Do NOT add any explanation, greeting, or commentary before or after the JSON
- Do NOT include trailing commas in arrays or objects
- If no entries are found, return: {"entries": []}`;

    const userPrompt = `[Context]
Character: ${ctx.charName}
User: ${ctx.userName}

[Chat History to Analyze]
${history}

[Task]
Extract new lore entries from the above history. Return JSON only.`;

    return [
        { role: "system", content: sysPrompt },
        { role: "user", content: userPrompt }
    ];
}

/**
 * 预览设定提取的提示词（不发送请求）
 * @param {number} historyLimit - 分析的聊天记录条数
 * @returns {Promise<object>} { messages: Array, historyCount: number, existingEntriesCount: number }
 */
export async function previewExtractPrompt(historyLimit = 20) {
    TitaniaLogger.info("预览设定提取提示词...", { historyLimit });

    // 1. 获取上下文和历史记录
    const ctx = await getContextData();
    const history = getChatHistory(historyLimit);

    if (!history || history.trim().length === 0) {
        throw new Error("聊天记录为空");
    }

    // 统计实际读取的消息条数
    const messagePattern = /(?:^|\n)(?:\*\*[^*]+\*\*:|[^:\n]+:)/g;
    const matches = history.match(messagePattern);
    const actualHistoryCount = matches ? matches.length : historyLimit;

    // 2. 获取现有世界书条目摘要（包含内容预览）
    let existingLoreSummary = "";
    let existingEntriesCount = 0;
    const CONTENT_PREVIEW_LENGTH = 300; // 每个条目内容预览的最大长度
    try {
        const activeEntries = await getActiveWorldInfoEntries();
        const summaryList = [];
        activeEntries.forEach(book => {
            book.entries.forEach(e => {
                const keys = Array.isArray(e.keys) ? e.keys.join(", ") : e.keys;
                // 提取内容预览（截断到指定长度）
                let contentPreview = e.content || "";
                if (contentPreview.length > CONTENT_PREVIEW_LENGTH) {
                    contentPreview = contentPreview.substring(0, CONTENT_PREVIEW_LENGTH) + "...";
                }
                // 格式化条目信息（包含内容预览）
                summaryList.push(`[UID: ${e.uid}] [Keys: ${keys}] [Book: ${book.bookName}]\nContent: ${contentPreview}`);
            });
        });
        existingEntriesCount = summaryList.length;
        if (summaryList.length > 0) {
            existingLoreSummary = summaryList.join("\n---\n");
        }
    } catch (e) {
        TitaniaLogger.warn("获取现有世界书失败", e);
    }

    // 3. 构建 Prompt
    const messages = buildExtractPrompt(ctx, history, existingLoreSummary);

    return {
        messages,
        historyCount: actualHistoryCount,
        existingEntriesCount
    };
}

/**
 * 提取设定信息
 * @param {number} historyLimit - 分析的聊天记录条数
 * @returns {Promise<object>} 提取结果 { entries: [...], rawResponse: string }
 */
export async function extractLoreFromHistory(historyLimit = 20) {
    // 获取功能专用连接配置
    const conn = getFeatureConnection(FEATURE_KEY);

    if (!conn) {
        throw new Error("未配置 API 连接，请先配置后再使用");
    }

    TitaniaLogger.info("开始提取设定...", {
        historyLimit,
        profile: conn.profileName,
        model: conn.model
    });

    // 1. 获取上下文和历史记录
    const ctx = await getContextData();
    const history = getChatHistory(historyLimit);

    if (!history || history.trim().length === 0) {
        throw new Error("聊天记录为空，无法提取设定");
    }

    // 1.5 获取现有世界书条目摘要（包含内容预览，便于 AI 判断是否需要更新）
    let existingLoreSummary = "";
    const CONTENT_PREVIEW_LENGTH = 300; // 每个条目内容预览的最大长度
    try {
        const activeEntries = await getActiveWorldInfoEntries();
        const summaryList = [];
        activeEntries.forEach(book => {
            book.entries.forEach(e => {
                const keys = Array.isArray(e.keys) ? e.keys.join(", ") : e.keys;
                // 提取内容预览（截断到指定长度）
                let contentPreview = e.content || "";
                if (contentPreview.length > CONTENT_PREVIEW_LENGTH) {
                    contentPreview = contentPreview.substring(0, CONTENT_PREVIEW_LENGTH) + "...";
                }
                // 格式化条目信息（包含内容预览）
                summaryList.push(`[UID: ${e.uid}] [Keys: ${keys}] [Book: ${book.bookName}]\nContent: ${contentPreview}`);
            });
        });
        if (summaryList.length > 0) {
            existingLoreSummary = summaryList.join("\n---\n");
        }
    } catch (e) {
        TitaniaLogger.warn("获取现有世界书失败，将跳过自动匹配", e);
    }

    // 2. 构建 Prompt（使用抽取的函数）
    const messages = buildExtractPrompt(ctx, history, existingLoreSummary);

    // 3. 发送请求（使用功能专用配置）
    let rawContent = "";

    try {
        rawContent = await sendFeatureRequest(messages, {
            temperature: 0.3
        });
    } catch (e) {
        TitaniaLogger.error("API 请求失败", e);
        throw new Error("API 请求失败: " + (e.message || "未知错误"));
    }

    if (!rawContent) {
        throw new Error("API 返回内容为空");
    }

    // 5. 解析 JSON（使用增强的多策略解析）
    try {
        // 详细调试日志
        console.log('[Titania] 原始响应类型:', typeof rawContent);
        console.log('[Titania] 原始响应长度:', rawContent?.length);
        console.log('[Titania] 原始响应前200字符:', rawContent?.substring(0, 200));
        console.log('[Titania] 原始响应后100字符:', rawContent?.substring(rawContent.length - 100));

        console.log('[Titania] 开始解析 AI 返回内容', {
            contentLength: rawContent.length,
            contentPreview: rawContent.substring(0, 200)
        });

        const data = parseAIJSON(rawContent);

        console.log('[Titania] 解析后的数据:', data);
        console.log('[Titania] entries 类型:', typeof data?.entries);
        console.log('[Titania] entries 是否为数组:', Array.isArray(data?.entries));

        if (!data || !Array.isArray(data.entries)) {
            throw new Error("返回的 JSON 格式不正确 (缺少 entries 数组)");
        }

        // 为更新类型的条目附加原有内容（用于 UI 对比显示）
        const entriesWithOriginal = await enrichEntriesWithOriginalContent(data.entries);

        TitaniaLogger.info(`提取完成，共找到 ${entriesWithOriginal.length} 个条目`);

        // 返回结果时包含原始响应，便于调试
        return {
            entries: entriesWithOriginal,
            rawResponse: rawContent
        };

    } catch (e) {
        console.error('[Titania] JSON 解析异常:', e);
        console.error('[Titania] 异常堆栈:', e.stack);

        TitaniaLogger.error("JSON 解析失败", {
            rawContentFull: rawContent,
            rawContentLength: rawContent.length,
            error: e.message
        });

        // 解析失败时也返回原始响应，便于用户查看
        const error = new Error(`无法解析 AI 返回的数据: ${e.message}`);
        error.rawResponse = rawContent;
        throw error;
    }
}