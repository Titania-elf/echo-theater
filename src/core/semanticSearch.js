// src/core/semanticSearch.js
// 语义检索与相似度计算模块

import { getEmbedding } from "./embeddings.js";
import { getCharacterVectors } from "./vectorStore.js";
import { TitaniaLogger } from "./logger.js";

/**
 * 计算两个向量的余弦相似度
 * @param {number[]} vecA - 向量 A
 * @param {number[]} vecB - 向量 B
 * @returns {number} 相似度 (-1 到 1)
 */
export function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) {
        return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
        return 0;
    }

    return dotProduct / (normA * normB);
}

/**
 * 计算两个向量的欧几里得距离
 * @param {number[]} vecA - 向量 A
 * @param {number[]} vecB - 向量 B
 * @returns {number} 距离（越小越相似）
 */
export function euclideanDistance(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) {
        return Infinity;
    }

    let sum = 0;
    for (let i = 0; i < vecA.length; i++) {
        const diff = vecA[i] - vecB[i];
        sum += diff * diff;
    }

    return Math.sqrt(sum);
}

/**
 * 语义搜索 - 根据查询文本找到最相关的历史记录
 * @param {string} query - 查询文本
 * @param {string} characterId - 角色 ID
 * @param {object} options - 选项
 * @param {number} [options.topK=10] - 返回前 K 个结果
 * @param {number} [options.minScore=0.5] - 最小相似度阈值
 * @param {string} [options.metric="cosine"] - 相似度度量: "cosine" | "euclidean"
 * @returns {Promise<Array<{messageIndex: number, text: string, score: number}>>}
 */
export async function semanticSearch(query, characterId, options = {}) {
    const topK = options.topK || 10;
    const minScore = options.minScore || 0.3;
    const metric = options.metric || "cosine";

    // 获取查询文本的向量
    let queryVector;
    try {
        queryVector = await getEmbedding(query);
    } catch (e) {
        TitaniaLogger.error("获取查询向量失败", e);
        throw new Error(`语义搜索失败: ${e.message}`);
    }

    // 获取角色的所有向量
    const vectors = await getCharacterVectors(characterId);

    if (vectors.length === 0) {
        TitaniaLogger.info("角色没有向量索引，无法进行语义搜索");
        return [];
    }

    // 计算相似度
    const results = vectors.map(v => {
        let score;
        if (metric === "euclidean") {
            // 欧几里得距离转换为相似度分数（距离越小，分数越高）
            const distance = euclideanDistance(queryVector, v.vector);
            score = 1 / (1 + distance);
        } else {
            score = cosineSimilarity(queryVector, v.vector);
        }

        return {
            messageIndex: v.messageIndex,
            text: v.text,
            score,
            timestamp: v.timestamp
        };
    });

    // 过滤低于阈值的结果
    const filtered = results.filter(r => r.score >= minScore);

    // 按相似度排序
    filtered.sort((a, b) => b.score - a.score);

    // 返回前 K 个
    return filtered.slice(0, topK);
}

/**
 * 获取与当前上下文相关的历史记录
 * @param {string} currentContext - 当前上下文文本
 * @param {string} characterId - 角色 ID
 * @param {object} options - 选项
 * @param {number} [options.maxTokens=2000] - 最大返回 token 数（近似）
 * @param {number} [options.topK=20] - 最大返回条目数
 * @param {number} [options.minScore=0.4] - 最小相似度阈值
 * @returns {Promise<string>} 相关历史记录的拼接文本
 */
export async function getRelevantContext(currentContext, characterId, options = {}) {
    const maxTokens = options.maxTokens || 2000;
    const topK = options.topK || 20;
    const minScore = options.minScore || 0.4;

    // 搜索相关内容
    const results = await semanticSearch(currentContext, characterId, {
        topK,
        minScore
    });

    if (results.length === 0) {
        return "";
    }

    // 按消息索引排序（保持时间顺序）
    results.sort((a, b) => a.messageIndex - b.messageIndex);

    // 拼接文本，同时估算 token 数
    const segments = [];
    let estimatedTokens = 0;
    const avgTokensPerChar = 0.3; // 中文约每字符 0.3-0.5 token

    for (const result of results) {
        const text = result.text;
        const tokenEstimate = Math.ceil(text.length * avgTokensPerChar);

        if (estimatedTokens + tokenEstimate > maxTokens) {
            break;
        }

        segments.push({
            index: result.messageIndex,
            text,
            score: result.score
        });
        estimatedTokens += tokenEstimate;
    }

    // 格式化输出
    return segments.map(s => `[#${s.index} 相关度:${(s.score * 100).toFixed(0)}%] ${s.text}`).join("\n\n");
}

/**
 * 多查询语义搜索（用于更全面的检索）
 * @param {string[]} queries - 多个查询文本
 * @param {string} characterId - 角色 ID
 * @param {object} options - 选项
 * @returns {Promise<Array>} 合并去重后的结果
 */
export async function multiQuerySearch(queries, characterId, options = {}) {
    const topK = options.topK || 10;
    const minScore = options.minScore || 0.4;

    const allResults = [];
    const seenIndices = new Set();

    for (const query of queries) {
        try {
            const results = await semanticSearch(query, characterId, {
                topK: Math.ceil(topK / queries.length) + 2, // 每个查询多取一些
                minScore
            });

            for (const result of results) {
                if (!seenIndices.has(result.messageIndex)) {
                    seenIndices.add(result.messageIndex);
                    allResults.push(result);
                }
            }
        } catch (e) {
            TitaniaLogger.warn(`多查询搜索中的一个查询失败: ${query}`, e);
        }
    }

    // 按相似度排序
    allResults.sort((a, b) => b.score - a.score);

    return allResults.slice(0, topK);
}

/**
 * 分析向量库的质量和覆盖度
 * @param {string} characterId - 角色 ID
 * @returns {Promise<object>} 分析结果
 */
export async function analyzeVectorQuality(characterId) {
    const vectors = await getCharacterVectors(characterId);

    if (vectors.length === 0) {
        return {
            totalVectors: 0,
            averageLength: 0,
            modelConsistency: true,
            models: []
        };
    }

    // 统计各项指标
    const models = new Set();
    let totalLength = 0;
    let totalDimensions = 0;

    for (const v of vectors) {
        models.add(v.modelUsed);
        totalLength += v.text.length;
        totalDimensions += v.vector.length;
    }

    const avgDimensions = Math.round(totalDimensions / vectors.length);
    const modelList = Array.from(models);

    return {
        totalVectors: vectors.length,
        averageLength: Math.round(totalLength / vectors.length),
        averageDimensions: avgDimensions,
        modelConsistency: modelList.length === 1,
        models: modelList,
        oldestTimestamp: Math.min(...vectors.map(v => v.timestamp)),
        newestTimestamp: Math.max(...vectors.map(v => v.timestamp))
    };
}