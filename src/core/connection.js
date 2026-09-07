// src/core/connection.js
// API 连接管理模块 - 统一管理 API 配置、模型获取和请求发送

import { getExtData } from "../utils/storage.js";
import { TitaniaLogger } from "./logger.js";
import { ChatCompletionService } from "../../../custom-request.js";
import { oai_settings, getChatCompletionModel } from "../../../openai.js";
import { ensureMainApiProfiles, normalizeApiBaseUrl, normalizeRewriteCustomProfiles, getStPresetProfiles } from "./apiProfileRegistry.js";
import { sendChatCompletion } from "./relayClient.js";

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
 * 验证当前连接配置是否有效
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

    return sendChatRequestWithConnection(conn, messages, options);
}

/**
 * 用一个已解析的连接对象发送聊天完成请求。
 *
 * 与 sendChatRequest 的区别：调用方自己提供 conn（可以来自主 profile 体系，
 * 也可以是功能模块自建的裸连接），本函数只负责发请求。让不走主 profile 体系的
 * 功能（如故事大纲的独立方案）也能复用 ST 的 SSE 解析、流式错误处理与中断。
 *
 * @param {object} conn - 连接对象，至少包含 { useSTConnection, url, key, model, stream }
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} options - 同 sendChatRequest（model/stream/maxTokens/temperature/signal/onProgress）
 * @returns {Promise<string>} 生成内容
 */
export async function sendChatRequestWithConnection(conn, messages, options = {}) {
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
        // 使用自定义配置：经 ST 后端代理发送（见 src/core/relayClient.js）。
        // 部分本地/自建端点无需 key，调用方可传 allowEmptyKey 放行（故事大纲即如此）。
        if (!conn.key && options.allowEmptyKey !== true) {
            throw new Error("配置缺失：请先去设置填 API Key！");
        }

        if (!conn.url || !conn.url.trim()) {
            throw new Error("ERR_CONFIG: API URL 未设置");
        }

        rawContent = await sendChatCompletion({
            url: conn.url,
            key: conn.key,
            model,
            messages,
            stream: useStream,
            maxTokens,
            temperature,
            signal,
            onProgress,
        });
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

