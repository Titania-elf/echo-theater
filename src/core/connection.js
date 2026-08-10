// src/core/connection.js
// API 连接管理模块 - 统一管理 API 配置、模型获取和请求发送

import { getExtData } from "../utils/storage.js";
import { TitaniaLogger } from "./logger.js";
import { ChatCompletionService } from "../../../custom-request.js";
import { oai_settings, getChatCompletionModel, tryParseStreamingError } from "../../../openai.js";
import EventSourceStream from "../../../sse-stream.js";
import { ensureMainApiProfiles, normalizeApiBaseUrl, normalizeRewriteCustomProfiles, getStPresetProfiles } from "./apiProfileRegistry.js";

/**
 * 获取当前激活的 API 连接配置
 * @returns {object} 连接配置对象
 * {
 *   useSTConnection: boolean,    // 是否使用 ST 主连接
 *   profileName: string,         // 方案名称
 *   url: string,                 // API URL (自定义模式)
 *   key: string,                 // API Key (自定义模式)
 *   model: string,               // 模型名称
 *   stream: boolean,             // 是否启用流式传输
 *   rawProfile: object           // 原始方案对象
 * }
 */
export function getActiveConnection() {
    const data = getExtData();
    const normalized = ensureMainApiProfiles(data.config || {});
    const activeProfileId = normalized.active_profile_id;
    const profiles = normalized.profiles;
    const currentProfile = profiles.find(p => p.id === activeProfileId) || profiles[0];

    const useSTConnection = currentProfile.type === 'internal';
    const stream = (data.config || {}).stream !== false; // 默认开启

    let url = "";
    let key = "";
    let model = "";

    if (useSTConnection) {
        // 使用 ST 的配置
        try {
            model = getChatCompletionModel() || "gpt-3.5-turbo";
            url = oai_settings.custom_url || oai_settings.reverse_proxy || `[${oai_settings.chat_completion_source}]`;
            key = "[由 ST 后端管理]";
        } catch (e) {
            TitaniaLogger.warn("无法读取 ST API 配置", e);
            model = "gpt-3.5-turbo";
        }
    } else {
        // 使用自定义配置
        url = currentProfile.url || "";
        key = currentProfile.key || "";
        model = currentProfile.model || "gpt-3.5-turbo";
    }

    return {
        useSTConnection,
        profileName: currentProfile.name,
        url,
        key,
        model,
        stream,
        rawProfile: currentProfile
    };
}

/**
 * 获取当前配置的默认模型名称
 * @returns {string} 模型名称
 */
export function getCurrentModel() {
    const conn = getActiveConnection();
    return conn.model;
}

/**
 * 获取可用模型列表
 * @returns {Promise<string[]>} 模型 ID 列表
 */
export async function getAvailableModels() {
    const conn = getActiveConnection();

    if (conn.useSTConnection) {
        // 对于 ST 内部连接，尝试从 DOM 中获取模型列表
        try {
            const selectors = [
                "#model_openai_select",
                "#model_claude_select",
                "#model_openrouter_select",
                "#model_mistral_select",
                "#api_button_text_generation_webui_model",
                ".model_select",
                "select[id*='model']",
            ];

            let models = [];

            for (const sel of selectors) {
                const $sel = $(sel);
                if ($sel.length > 0 && $sel.is("select")) {
                    $sel.find("option").each(function () {
                        const val = $(this).val();
                        if (val && val !== "null" && typeof val === 'string' && val.trim() !== "") {
                            models.push(val);
                        }
                    });
                }
            }

            if (models.length > 0) {
                const uniqueModels = [...new Set(models)].sort();
                // 确保当前选中的模型也在列表中
                const current = getChatCompletionModel();
                if (current && !uniqueModels.includes(current)) {
                    uniqueModels.unshift(current);
                }
                return uniqueModels;
            }
        } catch (e) {
            TitaniaLogger.warn("从 ST DOM 获取模型列表失败", e);
        }

        // 如果都失败了，回退到只返回当前模型
        const current = getChatCompletionModel();
        return current ? [current] : ["gpt-3.5-turbo"];

    } else {
        // 自定义连接：尝试调用 /v1/models
        if (!conn.url) return [conn.model || "gpt-3.5-turbo"];

        try {
            let endpoint = conn.url.trim().replace(/\/+$/, "");
            if (!endpoint.endsWith("/models")) {
                if (endpoint.endsWith("/v1")) endpoint += "/models";
                else endpoint += "/v1/models";
            }

            const res = await fetch(endpoint, {
                method: "GET",
                headers: { "Authorization": `Bearer ${conn.key}` }
            });

            if (!res.ok) return [conn.model || "gpt-3.5-turbo"];

            const json = await res.json();
            if (Array.isArray(json.data)) {
                return json.data.map(m => m.id).sort();
            } else if (Array.isArray(json)) {
                return json.map(m => m.id || m).sort();
            }

            return [conn.model || "gpt-3.5-turbo"];
        } catch (e) {
            TitaniaLogger.warn("获取模型列表失败", e);
            return [conn.model || "gpt-3.5-turbo"];
        }
    }
}

/**
 * 规范化 API endpoint URL
 * @param {string} url - 原始 URL
 * @param {string} suffix - 需要的后缀 (如 "/chat/completions" 或 "/models")
 * @returns {string} 规范化后的 URL
 */
export function normalizeEndpoint(url, suffix = "/chat/completions") {
    if (!url) return "";
    let endpoint = url.trim().replace(/\/+$/, "");

    if (!endpoint.endsWith(suffix)) {
        if (endpoint.endsWith("/v1")) {
            endpoint += suffix;
        } else {
            endpoint += "/v1" + suffix;
        }
    }

    return endpoint;
}

/**
 * 发送聊天完成请求
 * @param {Array<{role: string, content: string}>} messages - 消息数组
 * @param {object} options - 请求选项
 * @param {string} [options.model] - 覆盖使用的模型
 * @param {boolean} [options.stream] - 是否使用流式传输
 * @param {number} [options.maxTokens] - 最大 token 数
 * @param {number} [options.temperature] - 温度参数
 * @param {AbortSignal} [options.signal] - 中断信号
 * @param {(partial: string) => void} [options.onProgress] - 流式增量回调
 * @returns {Promise<string>} 返回生成的内容
 */
export async function sendChatRequest(messages, options = {}) {
    const conn = options.profileId
        ? (getConnectionByProfileId(String(options.profileId), options.model || null) || getActiveConnection())
        : getActiveConnection();
    const data = getExtData();

    const model = options.model || conn.model;
    const useStream = options.stream !== undefined ? options.stream : conn.stream;
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature || 0.7;
    const signal = options.signal;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

    let rawContent = "";

    if (conn.useSTConnection) {
        // 使用 ST 的 ChatCompletionService 发送请求
        const requestData = ChatCompletionService.createRequestData({
            stream: useStream,
            messages: messages,
            chat_completion_source: oai_settings.chat_completion_source,
            model: model,
            max_tokens: oai_settings.openai_max_tokens || maxTokens,
            temperature: oai_settings.temp_openai || temperature,
            custom_url: oai_settings.custom_url,
            reverse_proxy: oai_settings.reverse_proxy,
            proxy_password: oai_settings.proxy_password,
            custom_prompt_post_processing: oai_settings.custom_prompt_post_processing,
        });

        if (useStream) {
            const streamGenerator = await ChatCompletionService.sendRequest(requestData, false, null);

            if (typeof streamGenerator === 'function') {
                for await (const chunk of streamGenerator()) {
                    rawContent = chunk.text || "";
                    if (onProgress) onProgress(rawContent);
                }
            } else {
                rawContent = streamGenerator?.content || "";
                if (onProgress) onProgress(rawContent);
            }
        } else {
            const result = await ChatCompletionService.sendRequest(requestData, true, null);
            rawContent = result?.content || "";
            if (onProgress) onProgress(rawContent);
        }

    } else {
        // 使用自定义配置直接发送请求
        if (!conn.key) {
            throw new Error("配置缺失：请先去设置填 API Key！");
        }

        const endpoint = normalizeEndpoint(conn.url, "/chat/completions");
        if (!endpoint) {
            throw new Error("ERR_CONFIG: API URL 未设置");
        }

        const requestBody = {
            model: model,
            messages: messages,
            stream: useStream,
            max_tokens: maxTokens,
            temperature: temperature
        };

        if (useStream) {
            const fetchOptions = {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${conn.key}`
                },
                body: JSON.stringify(requestBody)
            };

            if (signal) {
                fetchOptions.signal = signal;
            }

            const res = await fetch(endpoint, fetchOptions);

            if (!res.ok) {
                const errText = await res.text().catch(() => "");
                throw new Error(`HTTP Error ${res.status}: ${res.statusText} - ${errText.substring(0, 100)}`);
            }

            if (!res.body) {
                throw new Error("Stream Empty Body: 响应体为空");
            }

            // 使用 ST 的 SSE 解析器，避免手动按换行切分导致粘包/拆包问题
            const eventStream = new EventSourceStream();
            res.body.pipeThrough(eventStream);
            const reader = eventStream.readable.getReader();
            let chunkCount = 0;
            let parseFailCount = 0;

            while (true) {
                if (signal?.aborted) {
                    await reader.cancel();
                    throw new DOMException('Request aborted', 'AbortError');
                }

                const { done, value } = await reader.read();
                if (done) break;

                // EventSourceStream 返回 MessageEvent
                const data = value.data;
                if (data === "[DONE]") break;

                // 尝试解析流式错误（兼容 ST 错误格式）
                try {
                    tryParseStreamingError(res, data, { quiet: true });
                } catch (streamParseErr) {
                    throw streamParseErr;
                }

                chunkCount++;

                try {
                    const json = JSON.parse(data);
                    const chunk = json.choices?.[0]?.delta?.content || "";
                    if (chunk) {
                        rawContent += chunk;
                        if (onProgress) onProgress(rawContent);
                    }
                } catch (e) {
                    parseFailCount++;
                    if (parseFailCount <= 3) {
                        TitaniaLogger.warn(`流式 chunk 解析失败 (#${parseFailCount})`, {
                            data: data.substring(0, 100),
                            error: e.message
                        });
                    }
                }
            }

            if (chunkCount === 0) {
                throw new Error("Stream Empty: 未接收到任何数据");
            }

            if (parseFailCount > 0 && rawContent.length === 0) {
                throw new Error(`Stream Parse Failed: 接收到 ${chunkCount} 个数据块，但全部解析失败`);
            }

        } else {
            // 非流式请求
            const fetchOptions = {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${conn.key}`
                },
                body: JSON.stringify(requestBody)
            };

            if (signal) {
                fetchOptions.signal = signal;
            }

            const res = await fetch(endpoint, fetchOptions);

            if (!res.ok) {
                const errText = await res.text().catch(() => "");
                throw new Error(`HTTP Error ${res.status}: ${res.statusText} - ${errText.substring(0, 100)}`);
            }

            const jsonText = await res.text();
            try {
                const json = JSON.parse(jsonText);
                rawContent = json.choices?.[0]?.message?.content || "";
                if (onProgress) onProgress(rawContent);
            } catch (jsonErr) {
                throw new Error("Invalid JSON response");
            }
        }
    }

    return rawContent;
}

/**
 * 验证当前连接配置是否有效
 * @returns {{valid: boolean, error?: string}} 验证结果
 */
export function validateConnection() {
    const conn = getActiveConnection();

    if (conn.useSTConnection) {
        // ST 连接由 ST 后端管理，假设有效
        return { valid: true };
    }

    if (!conn.url) {
        return { valid: false, error: "API URL 未设置" };
    }

    if (!conn.key) {
        return { valid: false, error: "API Key 未设置" };
    }

    return { valid: true };
}

/**
 * 获取所有可用的 API 配置方案
 * @returns {Array<object>} 方案列表
 */
export function getAllProfiles() {
    const data = getExtData();
    const normalized = ensureMainApiProfiles(data.config || {});
    return normalized.profiles;
}

/**
 * 根据 Profile ID 获取连接配置
 * @param {string} profileId - 方案 ID
 * @param {string} [modelOverride] - 覆盖模型（可选）
 * @returns {object|null} 连接配置对象，或 null（未找到）
 */
export function getConnectionByProfileId(profileId, modelOverride = null) {
    const data = getExtData();
    const normalized = ensureMainApiProfiles(data.config || {});
    const profiles = normalized.profiles;

    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return null;

    const useSTConnection = profile.type === 'internal';
    const stream = (data.config || {}).stream !== false;

    let url = "";
    let key = "";
    let model = "";

    if (useSTConnection) {
        try {
            model = modelOverride || getChatCompletionModel() || "gpt-3.5-turbo";
            url = oai_settings.custom_url || oai_settings.reverse_proxy || `[${oai_settings.chat_completion_source}]`;
            key = "[由 ST 后端管理]";
        } catch (e) {
            TitaniaLogger.warn("无法读取 ST API 配置", e);
            model = modelOverride || "gpt-3.5-turbo";
        }
    } else {
        url = profile.url || "";
        key = profile.key || "";
        model = modelOverride || profile.model || "gpt-3.5-turbo";
    }

    return {
        useSTConnection,
        profileName: profile.name,
        profileId: profile.id,
        url,
        key,
        model,
        stream,
        rawProfile: profile
    };
}

function resolveFeatureModeConnection(featureConfig, data) {
    const mode = String(featureConfig?.profile_mode || "").trim();
    if (mode !== "custom" && mode !== "st") return null;

    const fallback = {
        api_url: normalizeApiBaseUrl(String(data?.config?.url || "")),
        api_key: String(data?.config?.key || ""),
        model: String(data?.config?.model || "")
    };

    const profiles = mode === "st"
        ? getStPresetProfiles().map((p) => ({
            id: String(p.id || "").trim(),
            name: String(p.name || "酒馆方案").trim() || "酒馆方案",
            api_url: normalizeApiBaseUrl(String(p.api_url || "")),
            api_key: "",
            model: String(p.model || "").trim()
        })).filter((p) => p.id)
        : normalizeRewriteCustomProfiles(featureConfig?.custom_profiles, fallback);

    if (!profiles.length) return null;

    const preferredId = String(featureConfig?.profile_id || featureConfig?.selected_profile_id || "").trim();
    const selected = profiles.find((p) => p.id === preferredId) || profiles[0];
    if (!selected) return null;

    const modelOverride = String(featureConfig?.model_override || "").trim();
    const model = modelOverride || String(selected.model || "").trim() || "gpt-3.5-turbo";
    const key = mode === "st"
        ? String(featureConfig?.st_api_key || "").trim()
        : String(selected.api_key || "").trim();

    return {
        useSTConnection: false,
        profileName: selected.name,
        profileId: selected.id,
        url: normalizeApiBaseUrl(String(selected.api_url || "").trim()),
        key,
        model,
        stream: (data.config || {}).stream !== false,
        rawProfile: {
            ...selected,
            type: mode === "st" ? "st_preset" : "custom"
        }
    };
}

/**
 * 获取特定功能的专用连接配置
 * @param {string} featureKey - 功能标识（如 "lore_extractor"）
 * @returns {object|null} 连接配置对象，或 null（未配置）
 */
export function getFeatureConnection(featureKey) {
    const data = getExtData();
    const featureConfig = data[`${featureKey}_config`];

    if (!featureConfig) return null;

    const modeConn = resolveFeatureModeConnection(featureConfig, data);
    if (modeConn) return modeConn;

    if (!featureConfig.selected_profile_id) return null;

    const conn = getConnectionByProfileId(
        featureConfig.selected_profile_id,
        featureConfig.model_override || null
    );

    if (!conn) {
        TitaniaLogger.warn(`功能 ${featureKey} 配置的方案 ${featureConfig.selected_profile_id} 不存在`);
        return null;
    }

    return conn;
}

/**
 * 验证特定功能的连接配置
 * @param {string} featureKey - 功能标识
 * @returns {{configured: boolean, valid: boolean, error?: string}}
 */
export function validateFeatureConnection(featureKey) {
    const conn = getFeatureConnection(featureKey);

    if (!conn) {
        return { configured: false, valid: false, error: "未配置 API 方案" };
    }

    if (conn.useSTConnection) {
        return { configured: true, valid: true };
    }

    if (!conn.url) {
        return { configured: true, valid: false, error: "API URL 未设置" };
    }

    if (!conn.key) {
        return { configured: true, valid: false, error: "API Key 未设置" };
    }

    return { configured: true, valid: true };
}

/**
 * 根据 Profile ID 获取可用模型列表
 * @param {string} profileId - 方案 ID
 * @returns {Promise<string[]>} 模型 ID 列表
 */
export async function getAvailableModelsForProfile(profileId) {
    const data = getExtData();
    const normalized = ensureMainApiProfiles(data.config || {});
    const profiles = normalized.profiles;

    const profile = profiles.find(p => p.id === profileId);
    if (!profile) {
        return ["gpt-3.5-turbo"];
    }

    if (profile.type === 'internal') {
        // 对于 ST 内部连接，尝试从 DOM 中获取模型列表
        try {
            const selectors = [
                "#model_openai_select",
                "#model_claude_select",
                "#model_openrouter_select",
                "#model_mistral_select",
                "#api_button_text_generation_webui_model",
                ".model_select",
                "select[id*='model']",
            ];

            let models = [];

            for (const sel of selectors) {
                const $sel = $(sel);
                if ($sel.length > 0 && $sel.is("select")) {
                    $sel.find("option").each(function () {
                        const val = $(this).val();
                        if (val && val !== "null" && typeof val === 'string' && val.trim() !== "") {
                            models.push(val);
                        }
                    });
                }
            }

            if (models.length > 0) {
                const uniqueModels = [...new Set(models)].sort();
                // 确保当前选中的模型也在列表中
                const current = getChatCompletionModel();
                if (current && !uniqueModels.includes(current)) {
                    uniqueModels.unshift(current);
                }
                return uniqueModels;
            }
        } catch (e) {
            TitaniaLogger.warn("从 ST DOM 获取模型列表失败", e);
        }

        // 如果都失败了，回退到只返回当前模型
        const current = getChatCompletionModel();
        return current ? [current] : ["gpt-3.5-turbo"];

    } else {
        // 自定义连接：尝试调用 /v1/models
        if (!profile.url) return [profile.model || "gpt-3.5-turbo"];

        try {
            let endpoint = profile.url.trim().replace(/\/+$/, "");
            if (!endpoint.endsWith("/models")) {
                if (endpoint.endsWith("/v1")) endpoint += "/models";
                else endpoint += "/v1/models";
            }

            const res = await fetch(endpoint, {
                method: "GET",
                headers: { "Authorization": `Bearer ${profile.key || ""}` }
            });

            if (!res.ok) return [profile.model || "gpt-3.5-turbo"];

            const json = await res.json();
            if (Array.isArray(json.data)) {
                return json.data.map(m => m.id).sort();
            } else if (Array.isArray(json)) {
                return json.map(m => m.id || m).sort();
            }

            return [profile.model || "gpt-3.5-turbo"];
        } catch (e) {
            TitaniaLogger.warn("获取模型列表失败", e);
            return [profile.model || "gpt-3.5-turbo"];
        }
    }
}
