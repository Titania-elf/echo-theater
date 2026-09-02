// src/core/vectorStore.js
// IndexedDB 向量存储管理模块

import { TitaniaLogger } from "./logger.js";
import { getEmbeddingConfig } from "./embeddings.js";

const DB_NAME = "TitaniaVectorDB";
const DB_VERSION = 1;
const STORE_EMBEDDINGS = "embeddings";
const STORE_METADATA = "metadata";
const UNSAVED_CACHE_KEY = "titania_has_unsaved_vectors";

let dbInstance = null;
let hasUnsavedVectorsCache = readUnsavedCacheFromStorage();
let unsavedCacheInitialized = true;

function readUnsavedCacheFromStorage() {
    try {
        return localStorage.getItem(UNSAVED_CACHE_KEY) === "1";
    } catch (_e) {
        return false;
    }
}

function writeUnsavedCacheToStorage(value) {
    try {
        localStorage.setItem(UNSAVED_CACHE_KEY, value ? "1" : "0");
    } catch (_e) {
        // 忽略 localStorage 不可用场景
    }
}

function setUnsavedCache(value) {
    hasUnsavedVectorsCache = Boolean(value);
    unsavedCacheInitialized = true;
    writeUnsavedCacheToStorage(hasUnsavedVectorsCache);
}

function resetUnsavedCacheFromMetadataChange() {
    // 元数据变化可能影响整体未导出状态（例如清空某角色）
    void refreshUnsavedVectorsCache();
}

/**
 * 连接被浏览器单方面关闭后再开事务会同步抛 InvalidStateError
 * （"The database connection is closing"）。iOS Safari 在页面切后台/
 * 锁屏/冻结恢复后就会出现这种死连接，而 onclose 在 BFCache 恢复时
 * 不保证触发，所以每次取缓存连接前都先用探测事务确认可用。
 */
function isConnectionUsable(db) {
    try {
        db.transaction([STORE_EMBEDDINGS], "readonly");
        return true;
    } catch (_error) {
        return false;
    }
}

/**
 * 初始化/获取 IndexedDB 数据库实例
 * @returns {Promise<IDBDatabase>}
 */
export async function initVectorDB() {
    if (dbInstance && isConnectionUsable(dbInstance)) {
        return dbInstance;
    }
    dbInstance = null;

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            // 打开失败时清掉缓存，让下一次调用还能重试
            dbInstance = null;
            TitaniaLogger.error("打开向量数据库失败", request.error);
            reject(request.error);
        };

        request.onsuccess = () => {
            const db = request.result;
            // onclose 能触发时立即清缓存；触发不了的场景由上面的探测兜底
            db.onclose = () => {
                dbInstance = null;
            };
            // 其他标签页要升级库版本时主动让位，避免对方被 blocked
            db.onversionchange = () => db.close();
            dbInstance = db;
            TitaniaLogger.info("向量数据库已连接");
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            // 创建 embeddings 表
            if (!db.objectStoreNames.contains(STORE_EMBEDDINGS)) {
                const embeddingsStore = db.createObjectStore(STORE_EMBEDDINGS, { keyPath: "id" });
                embeddingsStore.createIndex("characterId", "characterId", { unique: false });
                embeddingsStore.createIndex("messageIndex", "messageIndex", { unique: false });
                embeddingsStore.createIndex("charMessage", ["characterId", "messageIndex"], { unique: true });
            }

            // 创建 metadata 表
            if (!db.objectStoreNames.contains(STORE_METADATA)) {
                db.createObjectStore(STORE_METADATA, { keyPath: "characterId" });
            }

            TitaniaLogger.info("向量数据库结构已创建/更新");
        };
    });
}

/**
 * 保存单个 Embedding
 * @param {string} characterId - 角色 ID
 * @param {number} messageIndex - 消息索引
 * @param {string} text - 原始文本
 * @param {number[]} vector - 向量数组
 * @returns {Promise<void>}
 */
export async function saveEmbedding(characterId, messageIndex, text, vector) {
    const db = await initVectorDB();
    const cfg = getEmbeddingConfig();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_EMBEDDINGS], "readwrite");
        const store = transaction.objectStore(STORE_EMBEDDINGS);

        const entry = {
            id: `${characterId}_${messageIndex}`,
            characterId,
            messageIndex,
            text: text.substring(0, 500), // 只保存前500字符用于预览
            vector,
            timestamp: Date.now(),
            modelUsed: cfg.model
        };

        const request = store.put(entry);

        request.onsuccess = () => {
            setUnsavedCache(true);
            resolve();
        };
        request.onerror = () => {
            TitaniaLogger.error("保存 Embedding 失败", request.error);
            reject(request.error);
        };
    });
}

/**
 * 批量保存 Embeddings
 * @param {string} characterId - 角色 ID
 * @param {Array<{messageIndex: number, text: string, vector: number[]}>} entries - 条目数组
 * @returns {Promise<number>} 成功保存的数量
 */
export async function saveBatchEmbeddings(characterId, entries) {
    const db = await initVectorDB();
    const cfg = getEmbeddingConfig();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_EMBEDDINGS], "readwrite");
        const store = transaction.objectStore(STORE_EMBEDDINGS);

        let successCount = 0;

        for (const entry of entries) {
            const data = {
                id: `${characterId}_${entry.messageIndex}`,
                characterId,
                messageIndex: entry.messageIndex,
                text: entry.text.substring(0, 500),
                vector: entry.vector,
                timestamp: Date.now(),
                modelUsed: cfg.model
            };

            const request = store.put(data);
            request.onsuccess = () => successCount++;
        }

        transaction.oncomplete = () => {
            if (successCount > 0) {
                setUnsavedCache(true);
            }
            resolve(successCount);
        };
        transaction.onerror = () => {
            TitaniaLogger.error("批量保存 Embeddings 失败", transaction.error);
            reject(transaction.error);
        };
    });
}

/**
 * 获取角色的所有向量条目
 * @param {string} characterId - 角色 ID
 * @returns {Promise<Array>} 向量条目数组
 */
export async function getCharacterVectors(characterId) {
    const db = await initVectorDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_EMBEDDINGS], "readonly");
        const store = transaction.objectStore(STORE_EMBEDDINGS);
        const index = store.index("characterId");

        const request = index.getAll(characterId);

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => {
            TitaniaLogger.error("获取角色向量失败", request.error);
            reject(request.error);
        };
    });
}

/**
 * 获取角色特定消息的向量
 * @param {string} characterId - 角色 ID
 * @param {number} messageIndex - 消息索引
 * @returns {Promise<object|null>}
 */
export async function getMessageVector(characterId, messageIndex) {
    const db = await initVectorDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_EMBEDDINGS], "readonly");
        const store = transaction.objectStore(STORE_EMBEDDINGS);

        const request = store.get(`${characterId}_${messageIndex}`);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => {
            TitaniaLogger.error("获取消息向量失败", request.error);
            reject(request.error);
        };
    });
}

/**
 * 清除角色的所有向量索引
 * @param {string} characterId - 角色 ID
 * @returns {Promise<number>} 删除的条目数量
 */
export async function clearCharacterVectors(characterId) {
    const db = await initVectorDB();
    const vectors = await getCharacterVectors(characterId);

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_EMBEDDINGS, STORE_METADATA], "readwrite");
        const embeddingsStore = transaction.objectStore(STORE_EMBEDDINGS);
        const metadataStore = transaction.objectStore(STORE_METADATA);

        let deleteCount = 0;

        for (const vector of vectors) {
            const request = embeddingsStore.delete(vector.id);
            request.onsuccess = () => deleteCount++;
        }

        // 同时清除元数据
        metadataStore.delete(characterId);

        transaction.oncomplete = () => {
            TitaniaLogger.info(`已清除角色 ${characterId} 的 ${deleteCount} 条向量索引`);
            resetUnsavedCacheFromMetadataChange();
            resolve(deleteCount);
        };
        transaction.onerror = () => {
            TitaniaLogger.error("清除向量索引失败", transaction.error);
            reject(transaction.error);
        };
    });
}

/**
 * 更新索引元数据
 * @param {string} characterId - 角色 ID
 * @param {object} metadata - 元数据对象
 * @returns {Promise<void>}
 */
export async function updateIndexMetadata(characterId, metadata) {
    const db = await initVectorDB();
    const cfg = getEmbeddingConfig();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_METADATA], "readwrite");
        const store = transaction.objectStore(STORE_METADATA);

        const data = {
            characterId,
            ...metadata,
            embeddingModel: cfg.model,
            lastUpdatedAt: Date.now()
        };

        const request = store.put(data);

        request.onsuccess = () => resolve();
        request.onerror = () => {
            TitaniaLogger.error("更新索引元数据失败", request.error);
            reject(request.error);
        };
    });
}

/**
 * 获取角色向量数量（不加载完整向量数据，高效）
 * @param {string} characterId - 角色 ID
 * @returns {Promise<number>}
 */
export async function getCharacterVectorCount(characterId) {
    const db = await initVectorDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_EMBEDDINGS], "readonly");
        const store = transaction.objectStore(STORE_EMBEDDINGS);
        const index = store.index("characterId");

        // 使用 count() 而不是 getAll()，避免加载完整数据
        const request = index.count(characterId);

        request.onsuccess = () => resolve(request.result || 0);
        request.onerror = () => {
            TitaniaLogger.error("获取角色向量数量失败", request.error);
            reject(request.error);
        };
    });
}

/**
 * 获取索引状态/元数据（优化版：不加载完整向量数据）
 * @param {string} characterId - 角色 ID
 * @returns {Promise<object|null>}
 */
export async function getIndexStatus(characterId) {
    try {
        const db = await initVectorDB();

        return new Promise((resolve, reject) => {
            // 同时读取 metadata 和 count，使用同一个事务
            const transaction = db.transaction([STORE_METADATA, STORE_EMBEDDINGS], "readonly");
            const metadataStore = transaction.objectStore(STORE_METADATA);
            const embeddingsStore = transaction.objectStore(STORE_EMBEDDINGS);
            const embeddingsIndex = embeddingsStore.index("characterId");

            let metadata = null;
            let vectorCount = 0;

            // 获取元数据
            const metadataRequest = metadataStore.get(characterId);
            metadataRequest.onsuccess = () => {
                metadata = metadataRequest.result;
            };

            // 获取向量数量（使用 count 而不是 getAll）
            const countRequest = embeddingsIndex.count(characterId);
            countRequest.onsuccess = () => {
                vectorCount = countRequest.result || 0;
            };

            transaction.oncomplete = () => {
                if (!metadata) {
                    resolve(null);
                    return;
                }

                resolve({
                    ...metadata,
                    actualVectorCount: vectorCount
                });
            };

            transaction.onerror = () => {
                TitaniaLogger.error("获取索引状态失败", transaction.error);
                reject(transaction.error);
            };
        });
    } catch (e) {
        // 捕获 initVectorDB 可能的错误，返回 null 而不是抛出异常
        TitaniaLogger.warn("获取索引状态时发生错误", e);
        return null;
    }
}

/**
 * 导出角色的向量索引为 JSON
 * @param {string} characterId - 角色 ID
 * @returns {Promise<object>} 导出数据对象
 */
export async function exportVectors(characterId) {
    const vectors = await getCharacterVectors(characterId);
    const metadata = await getIndexStatus(characterId);

    const exportData = {
        version: 1,
        exportedAt: Date.now(),
        characterId,
        metadata: metadata || {},
        vectors: vectors.map(v => ({
            messageIndex: v.messageIndex,
            text: v.text,
            vector: v.vector,
            timestamp: v.timestamp,
            modelUsed: v.modelUsed
        }))
    };

    // 更新最后导出时间
    await updateIndexMetadata(characterId, {
        ...(metadata || {}),
        lastExportedAt: Date.now()
    });

    resetUnsavedCacheFromMetadataChange();

    return exportData;
}

/**
 * 从 JSON 导入向量索引
 * @param {string} characterId - 角色 ID
 * @param {object} data - 导入数据
 * @param {boolean} [clearExisting=true] - 是否清除现有数据
 * @returns {Promise<{imported: number, skipped: number}>}
 */
export async function importVectors(characterId, data, clearExisting = true) {
    if (!data || !data.vectors || !Array.isArray(data.vectors)) {
        throw new Error("无效的导入数据格式");
    }

    // 验证版本
    if (data.version !== 1) {
        TitaniaLogger.warn(`导入数据版本不匹配: ${data.version}`);
    }

    // 清除现有数据（可选）
    if (clearExisting) {
        await clearCharacterVectors(characterId);
    }

    const db = await initVectorDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_EMBEDDINGS, STORE_METADATA], "readwrite");
        const embeddingsStore = transaction.objectStore(STORE_EMBEDDINGS);
        const metadataStore = transaction.objectStore(STORE_METADATA);

        let imported = 0;
        let skipped = 0;

        for (const item of data.vectors) {
            if (!item.vector || !Array.isArray(item.vector)) {
                skipped++;
                continue;
            }

            const entry = {
                id: `${characterId}_${item.messageIndex}`,
                characterId,
                messageIndex: item.messageIndex,
                text: item.text || "",
                vector: item.vector,
                timestamp: item.timestamp || Date.now(),
                modelUsed: item.modelUsed || "unknown"
            };

            const request = embeddingsStore.put(entry);
            request.onsuccess = () => imported++;
        }

        // 更新元数据
        const metadataEntry = {
            characterId,
            importedAt: Date.now(),
            importedFrom: data.exportedAt || null,
            totalVectors: data.vectors.length,
            embeddingModel: data.metadata?.embeddingModel || "unknown"
        };
        metadataStore.put(metadataEntry);

        transaction.oncomplete = () => {
            TitaniaLogger.info(`导入完成: ${imported} 条成功, ${skipped} 条跳过`);
            if (imported > 0) {
                setUnsavedCache(true);
            } else {
                resetUnsavedCacheFromMetadataChange();
            }
            resolve({ imported, skipped });
        };

        transaction.onerror = () => {
            TitaniaLogger.error("导入向量索引失败", transaction.error);
            reject(transaction.error);
        };
    });
}

/**
 * 触发文件下载（用于导出）
 * @param {string} characterId - 角色 ID
 * @param {string} [filename] - 文件名（可选）
 */
export async function downloadVectorExport(characterId, filename) {
    const data = await exportVectors(characterId);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = filename || `titania-vectors-${characterId}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    TitaniaLogger.info(`向量索引已导出: ${a.download}`);
}

/**
 * 检查指定角色是否有未导出的新向量
 * @param {string} characterId - 角色 ID
 * @returns {Promise<{hasNew: boolean, count: number}>}
 */
export async function checkCharacterUnsavedVectors(characterId) {
    const metadata = await getIndexStatus(characterId);

    if (!metadata) {
        return { hasNew: false, count: 0 };
    }

    const vectors = await getCharacterVectors(characterId);
    const lastExported = metadata.lastExportedAt || 0;

    // 统计导出后新增的向量
    const newVectors = vectors.filter(v => v.timestamp > lastExported);

    return {
        hasNew: newVectors.length > 0,
        count: newVectors.length
    };
}

/**
 * 检查是否有任何未导出的向量索引
 * 用于页面关闭前的提醒
 * @returns {Promise<boolean>} 是否有未保存的向量
 */
export async function checkUnsavedVectors() {
    try {
        const characters = await getAllIndexedCharacters();

        if (characters.length === 0) {
            setUnsavedCache(false);
            return false;
        }

        for (const charId of characters) {
            const result = await checkCharacterUnsavedVectors(charId);
            if (result.hasNew) {
                TitaniaLogger.info(`检测到角色 ${charId} 有 ${result.count} 条未导出的向量`);
                setUnsavedCache(true);
                return true;
            }
        }

        setUnsavedCache(false);
        return false;
    } catch (e) {
        TitaniaLogger.warn("检查未保存向量失败", e);
        unsavedCacheInitialized = true;
        return false;
    }
}

/**
 * 同步读取当前未导出状态缓存（供 beforeunload 使用）
 * @returns {boolean}
 */
export function hasUnsavedVectorsSync() {
    return hasUnsavedVectorsCache;
}

/**
 * 刷新未导出状态缓存（异步）
 * @returns {Promise<boolean>}
 */
export async function refreshUnsavedVectorsCache() {
    return checkUnsavedVectors();
}

/**
 * 缓存是否已初始化
 * @returns {boolean}
 */
export function isUnsavedCacheInitialized() {
    return unsavedCacheInitialized;
}

/**
 * 获取所有有向量索引的角色列表
 * @returns {Promise<string[]>} 角色 ID 数组
 */
export async function getAllIndexedCharacters() {
    const db = await initVectorDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_METADATA], "readonly");
        const store = transaction.objectStore(STORE_METADATA);

        const request = store.getAllKeys();

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => {
            TitaniaLogger.error("获取索引角色列表失败", request.error);
            reject(request.error);
        };
    });
}
