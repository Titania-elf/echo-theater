// src/core/embeddings.js
// Embedding API 调用模块 - 用于向量化文本
//
// 已知限制：此处保持浏览器直连（本模块 fetch 与 loreReviewWindow 的
// fetchEmbeddingModelListDraft/testEmbeddingConnectionDraft 均是）——ST 后端没有
// 通用的 /v1/embeddings 代理路由可借（聊天走 /api/backends/chat-completions/*，
// 但 embeddings 无对应端点）。若中转站未开 CORS，本功能会失败；请使用开放
// 跨域的 embedding 服务或本地端点。

import { getExtData } from "../utils/storage.js";
import { TitaniaLogger } from "./logger.js";

/**
 * 获取 Embedding 配置
 * @returns {object} Embedding 配置对象
 */
export function getEmbeddingConfig() {
    const data = getExtData();
    return data.embedding_config || {
        url: "",
        key: "",
        model: "text-embedding-3-small",
        dimensions: null
    };
}

/**
 * 验证 Embedding 配置是否有效
 * @returns {{valid: boolean, error?: string}}
 */
export function validateEmbeddingConfig() {
    const cfg = getEmbeddingConfig();

    if (!cfg.url || cfg.url.trim() === "") {
        return { valid: false, error: "Embedding API URL 未设置" };
    }

    if (!cfg.key || cfg.key.trim() === "") {
        return { valid: false, error: "Embedding API Key 未设置" };
    }

    if (!cfg.model || cfg.model.trim() === "") {
        return { valid: false, error: "Embedding 模型未设置" };
    }

    return { valid: true };
}

/**
 * 规范化 Embedding API 端点 URL
 * @param {string} url - 原始 URL
 * @returns {string} 规范化后的 URL
 */
function normalizeEmbeddingEndpoint(url) {
    if (!url) return "";
    let endpoint = url.trim().replace(/\/+$/, "");

    // 如果已经是 /embeddings 结尾，直接返回
    if (endpoint.endsWith("/embeddings")) {
        return endpoint;
    }

    // 如果是 /v1 结尾，添加 /embeddings
    if (endpoint.endsWith("/v1")) {
        return endpoint + "/embeddings";
    }

    // 否则添加 /v1/embeddings
    return endpoint + "/v1/embeddings";
}

/**
 * 获取单个文本的 Embedding 向量
 * @param {string} text - 要向量化的文本
 * @returns {Promise<number[]>} 向量数组
 */
export async function getEmbedding(text) {
    const cfg = getEmbeddingConfig();
    const validation = validateEmbeddingConfig();

    if (!validation.valid) {
        throw new Error(validation.error);
    }

    const endpoint = normalizeEmbeddingEndpoint(cfg.url);

    const requestBody = {
        model: cfg.model,
        input: text
    };

    // 如果指定了维度，添加到请求中（部分模型支持）
    if (cfg.dimensions && typeof cfg.dimensions === 'number') {
        requestBody.dimensions = cfg.dimensions;
    }

    try {
        const res = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${cfg.key}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Embedding API Error ${res.status}: ${errText.substring(0, 200)}`);
        }

        const json = await res.json();

        // OpenAI 格式: { data: [{ embedding: [...] }] }
        if (json.data && Array.isArray(json.data) && json.data[0]?.embedding) {
            return json.data[0].embedding;
        }

        // 某些 API 可能直接返回 { embedding: [...] }
        if (json.embedding && Array.isArray(json.embedding)) {
            return json.embedding;
        }

        // 某些 API 可能返回 { embeddings: [[...]] }
        if (json.embeddings && Array.isArray(json.embeddings) && json.embeddings[0]) {
            return json.embeddings[0];
        }

        throw new Error("无法解析 Embedding API 响应格式");

    } catch (e) {
        TitaniaLogger.error("获取 Embedding 失败", e);
        throw e;
    }
}

/**
 * 批量获取多个文本的 Embedding 向量
 * @param {string[]} texts - 要向量化的文本数组
 * @param {object} options - 选项
 * @param {function} [options.onProgress] - 进度回调 (current, total)
 * @param {number} [options.batchSize] - 每批处理数量 (默认 20)
 * @returns {Promise<number[][]>} 向量数组的数组
 */
export async function getBatchEmbeddings(texts, options = {}) {
    const cfg = getEmbeddingConfig();
    const validation = validateEmbeddingConfig();

    if (!validation.valid) {
        throw new Error(validation.error);
    }

    if (!texts || texts.length === 0) {
        return [];
    }

    const endpoint = normalizeEmbeddingEndpoint(cfg.url);
    const batchSize = options.batchSize || 20;
    const onProgress = options.onProgress;

    const results = [];
    let processed = 0;

    // 分批处理
    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);

        const requestBody = {
            model: cfg.model,
            input: batch
        };

        if (cfg.dimensions && typeof cfg.dimensions === 'number') {
            requestBody.dimensions = cfg.dimensions;
        }

        try {
            const res = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${cfg.key}`
                },
                body: JSON.stringify(requestBody)
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Embedding API Error ${res.status}: ${errText.substring(0, 200)}`);
            }

            const json = await res.json();

            // OpenAI 格式: { data: [{ index: 0, embedding: [...] }, ...] }
            if (json.data && Array.isArray(json.data)) {
                // 按 index 排序以确保顺序正确
                const sorted = json.data.sort((a, b) => a.index - b.index);
                for (const item of sorted) {
                    results.push(item.embedding);
                }
            } else if (json.embeddings && Array.isArray(json.embeddings)) {
                // 某些 API 直接返回 embeddings 数组
                results.push(...json.embeddings);
            } else {
                throw new Error("无法解析批量 Embedding 响应格式");
            }

            processed += batch.length;

            if (onProgress) {
                onProgress(processed, texts.length);
            }

        } catch (e) {
            TitaniaLogger.error(`批量 Embedding 失败 (batch ${i}-${i + batch.length})`, e);
            throw e;
        }

        // 添加小延迟避免触发 rate limit
        if (i + batchSize < texts.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    return results;
}

/**
 * 测试 Embedding API 连接
 * @returns {Promise<{success: boolean, message: string, dimensions?: number}>}
 */
export async function testEmbeddingConnection() {
    const validation = validateEmbeddingConfig();

    if (!validation.valid) {
        return { success: false, message: validation.error };
    }

    try {
        const testText = "This is a test for embedding API connection.";
        const embedding = await getEmbedding(testText);

        if (!Array.isArray(embedding) || embedding.length === 0) {
            return { success: false, message: "API 返回的向量格式无效" };
        }

        return {
            success: true,
            message: `连接成功！向量维度: ${embedding.length}`,
            dimensions: embedding.length
        };

    } catch (e) {
        return {
            success: false,
            message: `连接失败: ${e.message}`
        };
    }
}