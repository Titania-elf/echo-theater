import {
    chat_metadata,
    getCurrentChatId,
    saveChatConditional
} from "../../../../script.js";
import { GlobalState } from "./state.js";
import { TitaniaLogger } from "./logger.js";

const DB_NAME = "TitaniaContinuationDB";
const DB_VERSION = 2;
const STORE_SESSIONS = "continuationSessions";
const STORE_BRANCHES = "continuationBranches";
const STORE_ROUNDS = "continuationRounds";
const CHAT_METADATA_KEY = "titania_continuation";
let dbPromise = null;
let restoreSequence = 0;
let runtimeRevision = 0;
const pendingWrites = new Map();

/**
 * 分支模型（v2）
 *
 * 借鉴 SillyTavern 的分支实现：建分支只做两件事——写一份全新的副本、把「当前打开哪条」
 * 这个指针挪过去。源分支一个字节都不改。
 *
 *   session.activeBranchId   ← 唯一的活动指针（等价于 ST 的 characters[chid].chat）
 *   branch.parentBranchId    ← 指回父分支（等价于 ST 的 chat_metadata.main_chat）
 *   branch.id                ← 创建后永不重写，就是分支的身份
 *   round.branchId           ← 一条轮次永远只属于一条分支
 *
 * 「归档分支」不再是一种存储状态，而是算出来的：branch.id !== session.activeBranchId。
 * 不存状态，就不会有状态不一致。
 *
 * 为了让上层 UI 与选择契约保持不变，branch.id 直接沿用 branchKey 的值，
 * 并额外保留 branchKey 字段作为别名。
 */

function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onblocked = () => TitaniaLogger.warn("续写历史数据库升级被其他标签页阻塞，请关闭多余的 SillyTavern 页面");
        request.onupgradeneeded = event => {
            const db = request.result;
            const transaction = request.transaction;
            createStores(db);
            if (Number(event.oldVersion) >= 1 && Number(event.oldVersion) < 2) {
                migrateV1ToV2(transaction);
            }
        };
    });
    return dbPromise;
}

function createStores(db) {
    if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const store = db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
        store.createIndex("chatId", "chatId", { unique: false });
    }
    if (!db.objectStoreNames.contains(STORE_BRANCHES)) {
        const store = db.createObjectStore(STORE_BRANCHES, { keyPath: "id" });
        store.createIndex("chatId", "chatId", { unique: false });
        store.createIndex("sessionId", "sessionId", { unique: false });
    }
    if (!db.objectStoreNames.contains(STORE_ROUNDS)) {
        const store = db.createObjectStore(STORE_ROUNDS, { keyPath: "id" });
        store.createIndex("chatId", "chatId", { unique: false });
        store.createIndex("branchId", "branchId", { unique: false });
    }
}

/**
 * v1 → v2 迁移。
 *
 * v1 的 branch.id 是 `${sessionId}:${branchKey}`，父子关系存的是 branchKey；
 * v2 统一改用 branchId 作为身份，并给 session 补上 activeBranchId 指针。
 *
 * 全程使用回调而非 await：versionchange 事务一旦让出宏任务就会自动提交。
 */
function migrateV1ToV2(transaction) {
    const sessionStore = transaction.objectStore(STORE_SESSIONS);
    const branchStore = transaction.objectStore(STORE_BRANCHES);
    const roundStore = transaction.objectStore(STORE_ROUNDS);

    sessionStore.getAll().onsuccess = sessionEvent => {
        branchStore.getAll().onsuccess = branchEvent => {
            roundStore.getAll().onsuccess = roundEvent => {
                const sessions = sessionEvent.target.result || [];
                const branches = branchEvent.target.result || [];
                const rounds = roundEvent.target.result || [];

                // 老 branch.id → 新 branch.id
                const branchIdMap = new Map();
                // `${sessionId}\u0000${branchKey}` → 新 branch.id，用于把 parentBranchKey 解析成 parentBranchId
                const branchIdBySessionKey = new Map();
                const usedIds = new Set();

                for (const branch of branches) {
                    const legacyKey = String(branch?.branchKey || "").trim();
                    let nextId = legacyKey || String(branch?.id || "");
                    if (!nextId) continue;
                    // branchKey 理论上全局唯一，跨 session 撞车时退回带 session 前缀的形式
                    let guard = 2;
                    while (usedIds.has(nextId)) {
                        nextId = `${branch.sessionId}:${legacyKey}:${guard++}`;
                    }
                    usedIds.add(nextId);
                    branchIdMap.set(String(branch.id), nextId);
                    if (legacyKey) branchIdBySessionKey.set(`${branch.sessionId}\u0000${legacyKey}`, nextId);
                }

                const roundTimestampsByBranch = new Map();
                for (const round of rounds) {
                    const nextBranchId = branchIdMap.get(String(round?.branchId || ""));
                    if (!nextBranchId) continue;
                    const timestamp = Number(round?.timestamp) || 0;
                    const known = roundTimestampsByBranch.get(nextBranchId);
                    if (timestamp > 0 && (!known || timestamp < known)) {
                        roundTimestampsByBranch.set(nextBranchId, timestamp);
                    }
                }

                const now = Date.now();
                const branchCountBySession = new Map();

                branchStore.clear().onsuccess = () => {
                    for (const branch of branches) {
                        const nextId = branchIdMap.get(String(branch.id));
                        if (!nextId) continue;
                        const legacyKey = String(branch?.branchKey || "").trim();
                        const parentKey = String(branch?.parentBranchKey || "").trim();
                        const roundCount = rounds.filter(item => branchIdMap.get(String(item?.branchId || "")) === nextId).length;
                        branchCountBySession.set(branch.sessionId, (branchCountBySession.get(branch.sessionId) || 0) + 1);
                        branchStore.put({
                            id: nextId,
                            sessionId: String(branch.sessionId || ""),
                            chatId: String(branch.chatId || ""),
                            branchKey: legacyKey || nextId,
                            legacyBranchKey: legacyKey,
                            parentBranchId: parentKey
                                ? (branchIdBySessionKey.get(`${branch.sessionId}\u0000${parentKey}`) || "")
                                : "",
                            branchedAtSequence: Number(branch?.branchedAtRound) || null,
                            createdAt: Number(branch?.archivedAt) || roundTimestampsByBranch.get(nextId) || now,
                            archivedAt: Number(branch?.archivedAt) || 0,
                            label: "",
                            roundCount
                        });
                    }
                };

                roundStore.clear().onsuccess = () => {
                    for (const round of rounds) {
                        const nextBranchId = branchIdMap.get(String(round?.branchId || ""));
                        // 找不到归属分支的轮次在 v1 里本就不可达，直接丢弃
                        if (!nextBranchId) continue;
                        const roundKey = String(round?.roundKey || "").trim() || createRoundKey();
                        roundStore.put({
                            id: `${nextBranchId}:${roundKey}`,
                            branchId: nextBranchId,
                            sessionId: String(round.sessionId || ""),
                            chatId: String(round.chatId || ""),
                            branchKey: String(round?.branchKey || ""),
                            roundKey,
                            sequence: Number(round?.sequence) || 1,
                            originRoundId: "",
                            type: String(round?.type || "continuation"),
                            instruction: String(round?.instruction || ""),
                            content: String(round?.content || ""),
                            status: String(round?.status || "legacy"),
                            generationId: String(round?.generationId || ""),
                            timestamp: Number(round?.timestamp) || 0
                        });
                    }
                };

                for (const session of sessions) {
                    const activeKey = String(session?.activeBranchKey || "").trim();
                    const activeBranchId = branchIdBySessionKey.get(`${session.id}\u0000${activeKey}`) || "";
                    const sessionBranches = branches
                        .filter(item => String(item?.sessionId || "") === String(session.id))
                        .map(item => branchIdMap.get(String(item.id)))
                        .filter(Boolean);
                    const rootBranchId = sessionBranches.find(id => {
                        const source = branches.find(item => branchIdMap.get(String(item.id)) === id);
                        return !String(source?.parentBranchKey || "").trim();
                    }) || sessionBranches[0] || "";

                    sessionStore.put({
                        ...session,
                        activeBranchId: activeBranchId || rootBranchId,
                        rootBranchId,
                        branchCount: sessionBranches.length
                    });
                }

                TitaniaLogger.info("续写历史已迁移到 v2 分支模型", {
                    sessions: sessions.length,
                    branches: branchIdMap.size,
                    rounds: rounds.length
                });
            };
        };
    };
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    });
}

function createBranchId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `branch_${ts}_${rand}`;
}

function createRoundKey() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `round_${ts}_${rand}`;
}

function getCurrentChatKey() {
    return String(getCurrentChatId?.() || "").trim();
}

function getCurrentSourceMetadata() {
    const context = window.SillyTavern?.getContext?.() || {};
    const characterId = context.characterId;
    const character = characterId !== undefined ? context.characters?.[characterId] : null;
    return {
        characterId: characterId === undefined || characterId === null ? "" : String(characterId),
        characterName: String(character?.name || context.name2 || "未知角色"),
        characterAvatar: String(character?.avatar || ""),
        chatName: String(context.chatId || getCurrentChatKey() || "未知聊天")
    };
}

export function getCurrentContinuationSource() {
    return { chatId: getCurrentChatKey(), ...getCurrentSourceMetadata() };
}

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

function sortBySequence(rounds) {
    return [...rounds].sort((a, b) => (Number(a?.sequence) || 0) - (Number(b?.sequence) || 0));
}

function toPublicRound(round) {
    const content = String(round?.content || "");
    const sequence = Number(round?.sequence) || 1;
    const type = String(round?.type || (sequence === 1 ? "initial" : "continuation"));
    return {
        roundKey: String(round?.roundKey || ""),
        round: sequence,
        type,
        continuationIndex: type === "initial" ? 0 : Math.max(1, sequence - 1),
        instruction: String(round?.instruction || ""),
        content,
        status: String(round?.status || "legacy"),
        generationId: String(round?.generationId || ""),
        contentPreview: content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80),
        contentLength: content.length,
        timestamp: Number(round?.timestamp) || 0
    };
}

/**
 * 列出一个 session 下的全部分支（含轮次），活动分支排在最前。
 * @param {string} sessionId
 */
export async function listBranches(sessionId) {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_SESSIONS, STORE_BRANCHES, STORE_ROUNDS], "readonly");
    const [session, branches, allRounds] = await Promise.all([
        requestResult(transaction.objectStore(STORE_SESSIONS).get(sessionId)),
        requestResult(transaction.objectStore(STORE_BRANCHES).index("sessionId").getAll(sessionId)),
        requestResult(transaction.objectStore(STORE_ROUNDS).getAll())
    ]);
    if (!session) return [];

    const roundsByBranch = new Map();
    for (const round of allRounds) {
        if (String(round?.sessionId || "") !== sessionId) continue;
        const branchId = String(round?.branchId || "");
        if (!roundsByBranch.has(branchId)) roundsByBranch.set(branchId, []);
        roundsByBranch.get(branchId).push(round);
    }

    return branches
        .map(branch => ({
            branchId: branch.id,
            branchKey: String(branch.branchKey || branch.id),
            isActive: branch.id === session.activeBranchId,
            parentBranchId: String(branch.parentBranchId || ""),
            branchedAtRound: Number(branch.branchedAtSequence) || null,
            createdAt: Number(branch.createdAt) || 0,
            archivedAt: Number(branch.archivedAt) || 0,
            label: String(branch.label || ""),
            rounds: sortBySequence(roundsByBranch.get(branch.id) || []).map(toPublicRound)
        }))
        .filter(branch => branch.rounds.length > 0)
        .sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.createdAt - a.createdAt);
}

/** 读取单条分支的轮次（按 sequence 升序）。 */
export async function loadBranchRounds(branchId) {
    if (!branchId) return [];
    const db = await openDatabase();
    const transaction = db.transaction([STORE_ROUNDS], "readonly");
    const rounds = await requestResult(transaction.objectStore(STORE_ROUNDS).index("branchId").getAll(branchId));
    return sortBySequence(rounds);
}

function buildGlobalSessions(sessions, branches, rounds) {
    const roundsByBranch = new Map();
    sortBySequence(rounds).forEach(round => {
        const branchId = String(round?.branchId || "");
        if (!roundsByBranch.has(branchId)) roundsByBranch.set(branchId, []);
        roundsByBranch.get(branchId).push(toPublicRound(round));
    });

    const branchesBySession = new Map();
    for (const branch of branches) {
        const sessionId = String(branch?.sessionId || "");
        if (!branchesBySession.has(sessionId)) branchesBySession.set(sessionId, []);
        branchesBySession.get(sessionId).push(branch);
    }

    return sessions.map(session => {
        const sessionBranches = (branchesBySession.get(String(session.id)) || [])
            .map(branch => ({
                branchId: branch.id,
                branchKey: String(branch.branchKey || branch.id),
                isActive: branch.id === session.activeBranchId,
                parentBranchKey: String(branch.parentBranchId || ""),
                parentBranchId: String(branch.parentBranchId || ""),
                branchedAtRound: Number(branch.branchedAtSequence) || null,
                createdAt: Number(branch.createdAt) || 0,
                archivedAt: Number(branch.archivedAt) || 0,
                rounds: roundsByBranch.get(branch.id) || []
            }))
            .filter(branch => branch.rounds.length > 0)
            .sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.createdAt - a.createdAt);
        return {
            chatId: session.chatId,
            sessionId: session.id,
            scriptId: session.scriptId,
            scriptName: session.scriptName || "未知剧本",
            characterId: String(session.characterId || ""),
            characterName: String(session.characterName || "旧版记录"),
            characterAvatar: String(session.characterAvatar || ""),
            chatName: String(session.chatName || session.chatId || "未知聊天"),
            origin: session.origin || null,
            activeBranchId: String(session.activeBranchId || ""),
            updatedAt: Number(session.updatedAt) || 0,
            branches: sessionBranches,
            roundCount: sessionBranches.reduce((sum, branch) => sum + branch.rounds.length, 0)
        };
    }).filter(session => session.branches.length > 0).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listAllContinuationSessions() {
    await Promise.allSettled([...pendingWrites.values()]);
    const db = await openDatabase();
    const transaction = db.transaction([STORE_SESSIONS, STORE_BRANCHES, STORE_ROUNDS], "readonly");
    const [sessions, branches, rounds] = await Promise.all([
        requestResult(transaction.objectStore(STORE_SESSIONS).getAll()),
        requestResult(transaction.objectStore(STORE_BRANCHES).getAll()),
        requestResult(transaction.objectStore(STORE_ROUNDS).getAll())
    ]);
    return buildGlobalSessions(sessions, branches, rounds);
}

/* ------------------------------------------------------------------ *
 * 写入：分支是不可变的，只有这几个入口能改动它们
 * ------------------------------------------------------------------ */

/**
 * 从 sourceBranchId 的第 uptoSequence 轮（含）切出一条全新分支，并把活动指针挪过去。
 * 源分支不做任何修改——这正是 ST `saveChat({ chatName, mesId })` 的等价物。
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {string} options.sourceBranchId 源分支；留空表示从当前活动分支切
 * @param {number} options.uptoSequence 复制到第几轮（含）
 * @param {string} [options.label]
 * @param {boolean} [options.activate=true] 是否把活动指针挪到新分支
 * @returns {Promise<{branchId: string, rounds: object[]}|null>}
 */
export async function forkBranch({ sessionId, sourceBranchId = "", uptoSequence, label = "", activate = true } = {}) {
    if (!sessionId) return null;
    const db = await openDatabase();
    const transaction = db.transaction([STORE_SESSIONS, STORE_BRANCHES, STORE_ROUNDS], "readwrite");
    const completed = transactionDone(transaction);
    const sessionStore = transaction.objectStore(STORE_SESSIONS);
    const branchStore = transaction.objectStore(STORE_BRANCHES);
    const roundStore = transaction.objectStore(STORE_ROUNDS);

    const session = await requestResult(sessionStore.get(sessionId));
    if (!session) {
        transaction.abort();
        return null;
    }

    const resolvedSourceId = String(sourceBranchId || session.activeBranchId || "");
    const sourceBranch = resolvedSourceId ? await requestResult(branchStore.get(resolvedSourceId)) : null;
    const sourceRounds = resolvedSourceId
        ? sortBySequence(await requestResult(roundStore.index("branchId").getAll(resolvedSourceId)))
        : [];

    const limit = Math.floor(Number(uptoSequence));
    if (!Number.isFinite(limit) || limit < 0 || limit > sourceRounds.length) {
        transaction.abort();
        return null;
    }

    const branchId = createBranchId();
    const now = Date.now();
    const copied = sourceRounds.slice(0, limit).map((round, index) => {
        const roundKey = createRoundKey();
        return {
            id: `${branchId}:${roundKey}`,
            branchId,
            sessionId,
            chatId: String(session.chatId || ""),
            branchKey: branchId,
            roundKey,
            sequence: index + 1,
            originRoundId: String(round.id || ""),
            type: String(round.type || (index === 0 ? "initial" : "continuation")),
            instruction: String(round.instruction || ""),
            content: String(round.content || ""),
            status: String(round.status || "legacy"),
            generationId: String(round.generationId || ""),
            timestamp: Number(round.timestamp) || now
        };
    });

    branchStore.put({
        id: branchId,
        sessionId,
        chatId: String(session.chatId || ""),
        branchKey: branchId,
        legacyBranchKey: "",
        parentBranchId: resolvedSourceId,
        branchedAtSequence: limit || null,
        createdAt: now,
        archivedAt: 0,
        label: String(label || ""),
        roundCount: copied.length
    });
    copied.forEach(round => roundStore.put(round));

    if (activate) {
        sessionStore.put({
            ...session,
            activeBranchId: branchId,
            rootBranchId: String(session.rootBranchId || sourceBranch?.id || branchId),
            updatedAt: now
        });
    }

    await completed;
    return { branchId, rounds: copied };
}

/** 把活动指针挪到另一条分支（等价于 ST 的 openCharacterChat）。 */
export async function switchActiveBranch(sessionId, branchId) {
    if (!sessionId || !branchId) return false;
    const db = await openDatabase();
    const transaction = db.transaction([STORE_SESSIONS, STORE_BRANCHES], "readwrite");
    const completed = transactionDone(transaction);
    const sessionStore = transaction.objectStore(STORE_SESSIONS);
    const [session, branch] = await Promise.all([
        requestResult(sessionStore.get(sessionId)),
        requestResult(transaction.objectStore(STORE_BRANCHES).get(branchId))
    ]);
    if (!session || !branch || branch.sessionId !== sessionId) {
        transaction.abort();
        return false;
    }
    sessionStore.put({ ...session, activeBranchId: branchId, updatedAt: Date.now() });
    await completed;
    return true;
}

/** 往分支尾部追加一轮。分支内已有的轮次不受影响。 */
export async function appendRound(branchId, round = {}) {
    if (!branchId) return null;
    const db = await openDatabase();
    const transaction = db.transaction([STORE_SESSIONS, STORE_BRANCHES, STORE_ROUNDS], "readwrite");
    const completed = transactionDone(transaction);
    const branchStore = transaction.objectStore(STORE_BRANCHES);
    const roundStore = transaction.objectStore(STORE_ROUNDS);
    const sessionStore = transaction.objectStore(STORE_SESSIONS);

    const branch = await requestResult(branchStore.get(branchId));
    if (!branch) {
        transaction.abort();
        return null;
    }
    const existing = await requestResult(roundStore.index("branchId").getAll(branchId));
    const sequence = existing.reduce((max, item) => Math.max(max, Number(item?.sequence) || 0), 0) + 1;
    const roundKey = String(round?.roundKey || "").trim() || createRoundKey();
    const now = Date.now();
    const record = {
        id: `${branchId}:${roundKey}`,
        branchId,
        sessionId: String(branch.sessionId || ""),
        chatId: String(branch.chatId || ""),
        branchKey: String(branch.branchKey || branchId),
        roundKey,
        sequence,
        originRoundId: "",
        type: String(round?.type || (sequence === 1 ? "initial" : "continuation")),
        instruction: String(round?.instruction || ""),
        content: String(round?.content || ""),
        status: String(round?.status || "success"),
        generationId: String(round?.generationId || ""),
        timestamp: Number(round?.timestamp) || now
    };
    roundStore.put(record);
    branchStore.put({ ...branch, roundCount: sequence });

    const session = await requestResult(sessionStore.get(branch.sessionId));
    if (session) sessionStore.put({ ...session, updatedAt: now });

    await completed;
    return record;
}

/**
 * 删除一条分支及其轮次。子分支早已是独立副本，不受影响。
 * 若删的是活动分支，指针回退到父分支，父分支不在则退到最近创建的兄弟分支。
 */
export async function deleteBranch(branchId) {
    if (!branchId) return false;
    const db = await openDatabase();
    const transaction = db.transaction([STORE_SESSIONS, STORE_BRANCHES, STORE_ROUNDS], "readwrite");
    const completed = transactionDone(transaction);
    const sessionStore = transaction.objectStore(STORE_SESSIONS);
    const branchStore = transaction.objectStore(STORE_BRANCHES);
    const roundStore = transaction.objectStore(STORE_ROUNDS);

    const branch = await requestResult(branchStore.get(branchId));
    if (!branch) {
        transaction.abort();
        return false;
    }
    const [session, siblings, rounds] = await Promise.all([
        requestResult(sessionStore.get(branch.sessionId)),
        requestResult(branchStore.index("sessionId").getAll(branch.sessionId)),
        requestResult(roundStore.index("branchId").getAll(branchId))
    ]);

    rounds.forEach(round => roundStore.delete(round.id));
    branchStore.delete(branchId);

    if (session && session.activeBranchId === branchId) {
        const remaining = siblings.filter(item => item.id !== branchId);
        const fallback = remaining.find(item => item.id === branch.parentBranchId)
            || [...remaining].sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))[0];
        if (fallback) {
            sessionStore.put({ ...session, activeBranchId: fallback.id, updatedAt: Date.now() });
        } else {
            sessionStore.delete(session.id);
        }
    }

    await completed;
    return true;
}

/* ------------------------------------------------------------------ *
 * chat_metadata：只放指针，不放统计
 * ------------------------------------------------------------------ */

function buildPointerMetadata(sessions) {
    const active = {};
    for (const session of sessions) {
        const branchId = String(session?.activeBranchId || "").trim();
        if (branchId) active[String(session.scriptId)] = branchId;
    }
    return Object.keys(active).length > 0 ? { version: 2, active } : null;
}

/**
 * 写入指针，返回是否真的发生了变化。
 * 只有变化时才触发 saveChatConditional，避免每次持久化都拖着 ST 存盘。
 */
function updateCurrentChatMetadata(sessions) {
    const next = buildPointerMetadata(sessions);
    const current = chat_metadata?.[CHAT_METADATA_KEY];
    const sameShape = JSON.stringify(current?.active || null) === JSON.stringify(next?.active || null)
        && Number(current?.version || 0) === Number(next?.version || 0);
    if (sameShape) return false;

    if (next) {
        chat_metadata[CHAT_METADATA_KEY] = { ...next, updatedAt: Date.now() };
    } else {
        delete chat_metadata[CHAT_METADATA_KEY];
    }
    return true;
}

export function getContinuationPersistenceStatus() {
    const metadata = chat_metadata?.[CHAT_METADATA_KEY];
    return {
        chatId: getCurrentChatKey(),
        persisted: Number(metadata?.version) === 2,
        activeBranches: metadata?.active && typeof metadata.active === "object" ? { ...metadata.active } : {},
        updatedAt: Number(metadata?.updatedAt) || 0
    };
}

/* ------------------------------------------------------------------ *
 * 运行时桥接
 *
 * api.js 目前仍持有「活动槽 + archivedBranches」形态的内存模型，并按轮数上限裁剪。
 * 这里把它折算成 v2 记录后 **增量合并** 进库：内存里没有的行不会被删掉。
 * 旧实现是先删光该 chatId 的全部记录再整体重写，内存一裁剪，库里就跟着丢数据。
 * ------------------------------------------------------------------ */

function collectRuntimeRecords(chatId) {
    const byScript = GlobalState.continuationRuntime?.byScript || {};
    const sessions = [];
    const branches = [];
    const rounds = [];
    const currentSource = getCurrentSourceMetadata();

    for (const [scriptId, entry] of Object.entries(byScript)) {
        const activeBranchKey = String(entry?.branchKey || "").trim();
        if (!activeBranchKey || !Array.isArray(entry?.rounds) || entry.rounds.length === 0) continue;

        const sessionId = `${chatId}:${scriptId}`;
        const archivedBranches = Array.isArray(entry.archivedBranches) ? entry.archivedBranches : [];
        const updatedAt = Math.max(
            0,
            ...entry.rounds.map(round => Number(round?.timestamp) || 0),
            ...archivedBranches.flatMap(branch => [
                Number(branch?.archivedAt) || 0,
                ...(Array.isArray(branch?.rounds) ? branch.rounds.map(round => Number(round?.timestamp) || 0) : [])
            ])
        );

        sessions.push({
            id: sessionId,
            chatId,
            scriptId,
            scriptName: String(entry.scriptName || "场景"),
            characterId: String(entry.characterId ?? currentSource.characterId),
            characterName: String(entry.characterName || currentSource.characterName),
            characterAvatar: String(entry.characterAvatar || currentSource.characterAvatar),
            chatName: String(entry.chatName || currentSource.chatName),
            origin: entry.origin && typeof entry.origin === "object" ? entry.origin : null,
            activeBranchId: activeBranchKey,
            rootBranchId: "",
            updatedAt: updatedAt || Date.now()
        });

        const allBranches = [{
            branchKey: activeBranchKey,
            parentBranchKey: String(entry.parentBranchKey || ""),
            branchedAtRound: Number(entry.branchedAtRound) || null,
            archivedAt: 0,
            rounds: entry.rounds
        }, ...archivedBranches];

        for (const branch of allBranches) {
            const branchId = String(branch?.branchKey || "").trim();
            if (!branchId || !Array.isArray(branch?.rounds)) continue;
            branches.push({
                id: branchId,
                sessionId,
                chatId,
                branchKey: branchId,
                legacyBranchKey: "",
                parentBranchId: String(branch.parentBranchKey || ""),
                branchedAtSequence: Number(branch.branchedAtRound) || null,
                createdAt: Number(branch.archivedAt) || 0,
                archivedAt: Number(branch.archivedAt) || 0,
                label: "",
                roundCount: branch.rounds.length
            });
            branch.rounds.forEach((round, index) => {
                const roundKey = String(round?.roundKey || `legacy_${index + 1}`);
                rounds.push({
                    id: `${branchId}:${roundKey}`,
                    branchId,
                    sessionId,
                    chatId,
                    branchKey: branchId,
                    roundKey,
                    sequence: index + 1,
                    originRoundId: "",
                    type: String(round?.type || (index === 0 ? "initial" : "continuation")),
                    instruction: String(round?.instruction || ""),
                    content: String(round?.content || ""),
                    status: String(round?.status || "legacy"),
                    generationId: String(round?.generationId || ""),
                    timestamp: Number(round?.timestamp) || 0
                });
            });
        }
    }
    return { sessions, branches, rounds };
}

/**
 * 增量合并：内存中存在的记录覆盖库里的同 id 记录，库里多出来的行原样保留。
 * 轮次序号按「库中已有顺序 + 内存新增顺序」重排，避免内存裁掉最老一轮后
 * 后面的轮次挤占前面的序号、把已有内容覆盖掉。
 */
async function reconcileRuntimeRecords(chatId, payload) {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_SESSIONS, STORE_BRANCHES, STORE_ROUNDS], "readwrite");
    const completed = transactionDone(transaction);
    const sessionStore = transaction.objectStore(STORE_SESSIONS);
    const branchStore = transaction.objectStore(STORE_BRANCHES);
    const roundStore = transaction.objectStore(STORE_ROUNDS);

    const existingRounds = await requestResult(roundStore.index("chatId").getAll(chatId));
    const existingByBranch = new Map();
    for (const round of existingRounds) {
        const branchId = String(round?.branchId || "");
        if (!existingByBranch.has(branchId)) existingByBranch.set(branchId, []);
        existingByBranch.get(branchId).push(round);
    }

    const incomingByBranch = new Map();
    for (const round of payload.rounds) {
        if (!incomingByBranch.has(round.branchId)) incomingByBranch.set(round.branchId, []);
        incomingByBranch.get(round.branchId).push(round);
    }

    for (const [branchId, incoming] of incomingByBranch) {
        const existing = sortBySequence(existingByBranch.get(branchId) || []);
        const incomingByKey = new Map(incoming.map(round => [round.roundKey, round]));
        const merged = [];
        const seen = new Set();

        // 库中已有的轮次保持原顺序，内容以内存为准（用户改写过正文时需要落盘）
        for (const round of existing) {
            const update = incomingByKey.get(round.roundKey);
            merged.push(update ? { ...round, ...update, id: round.id } : round);
            seen.add(round.roundKey);
        }
        // 内存里新出现的轮次追加到末尾
        for (const round of incoming) {
            if (seen.has(round.roundKey)) continue;
            merged.push(round);
            seen.add(round.roundKey);
        }

        merged.forEach((round, index) => roundStore.put({ ...round, sequence: index + 1 }));

        const branch = payload.branches.find(item => item.id === branchId);
        if (branch) branch.roundCount = merged.length;
    }

    for (const branch of payload.branches) {
        const existing = await requestResult(branchStore.get(branch.id));
        branchStore.put(existing
            // createdAt / label 是分支创建时定下的，运行时快照不该把它们覆盖掉
            ? { ...existing, ...branch, createdAt: Number(existing.createdAt) || branch.createdAt || Date.now(), label: existing.label || branch.label }
            : { ...branch, createdAt: branch.createdAt || Date.now() });
    }

    for (const session of payload.sessions) {
        const existing = await requestResult(sessionStore.get(session.id));
        sessionStore.put(existing
            ? { ...existing, ...session, rootBranchId: existing.rootBranchId || session.rootBranchId }
            : session);
    }

    await completed;
}

async function writeCurrentRuntime(chatId, payload) {
    await reconcileRuntimeRecords(chatId, payload);
    if (chatId !== getCurrentChatKey()) return;
    if (updateCurrentChatMetadata(payload.sessions)) await saveChatConditional();
}

function queueRuntimeWrite(chatId, payload) {
    const previous = pendingWrites.get(chatId) || Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(() => writeCurrentRuntime(chatId, payload));
    pendingWrites.set(chatId, next);
    void next.then(() => {
        if (pendingWrites.get(chatId) === next) pendingWrites.delete(chatId);
    }, () => {
        if (pendingWrites.get(chatId) === next) pendingWrites.delete(chatId);
    });
    return next;
}

export function scheduleContinuationPersistence() {
    const chatId = getCurrentChatKey();
    if (!chatId) return;
    GlobalState.continuationRuntime.chatId = chatId;
    runtimeRevision++;
    const payload = collectRuntimeRecords(chatId);
    updateCurrentChatMetadata(payload.sessions);
    void queueRuntimeWrite(chatId, payload).catch(error => {
        TitaniaLogger.error("主动续写历史持久化失败", error);
        if (window.toastr) toastr.warning("主动续写历史保存失败，当前内容仍保留在内存中", "Titania");
    });
}

export async function flushContinuationPersistence() {
    const chatId = getCurrentChatKey();
    if (!chatId) return false;
    await queueRuntimeWrite(chatId, collectRuntimeRecords(chatId));
    return true;
}

export async function restoreContinuationForCurrentChat() {
    const sequence = ++restoreSequence;
    const chatId = getCurrentChatKey();
    if (!chatId) return false;
    const runtimeChatId = String(GlobalState.continuationRuntime?.chatId || "");
    if (runtimeChatId && runtimeChatId !== chatId) {
        GlobalState.continuationRuntime = { chatId, byScript: {} };
    }
    const revision = runtimeRevision;

    const db = await openDatabase();
    const transaction = db.transaction([STORE_SESSIONS, STORE_BRANCHES, STORE_ROUNDS], "readonly");
    const [sessions, branches, rounds] = await Promise.all([
        requestResult(transaction.objectStore(STORE_SESSIONS).index("chatId").getAll(chatId)),
        requestResult(transaction.objectStore(STORE_BRANCHES).index("chatId").getAll(chatId)),
        requestResult(transaction.objectStore(STORE_ROUNDS).index("chatId").getAll(chatId))
    ]);
    if (sequence !== restoreSequence || chatId !== getCurrentChatKey() || revision !== runtimeRevision) return false;

    const roundsByBranch = new Map();
    sortBySequence(rounds).forEach(round => {
        const branchId = String(round?.branchId || "");
        if (!roundsByBranch.has(branchId)) roundsByBranch.set(branchId, []);
        roundsByBranch.get(branchId).push({
            roundKey: String(round.roundKey || ""),
            round: Number(round.sequence) || 1,
            type: String(round.type || "continuation"),
            instruction: String(round.instruction || ""),
            content: String(round.content || ""),
            status: String(round.status || "legacy"),
            generationId: String(round.generationId || ""),
            timestamp: Number(round.timestamp) || 0
        });
    });

    const nextByScript = {};
    for (const session of sessions) {
        const sessionBranches = branches.filter(branch => String(branch.sessionId) === String(session.id));
        const active = sessionBranches.find(branch => branch.id === session.activeBranchId);
        if (!active) continue;
        nextByScript[session.scriptId] = {
            scriptId: session.scriptId,
            scriptName: session.scriptName,
            characterId: session.characterId,
            characterName: session.characterName,
            characterAvatar: session.characterAvatar,
            chatName: session.chatName,
            origin: session.origin || null,
            updatedAt: Number(session.updatedAt) || 0,
            branchKey: String(active.branchKey || active.id),
            parentBranchKey: String(active.parentBranchId || ""),
            branchedAtRound: Number(active.branchedAtSequence) || null,
            rounds: roundsByBranch.get(active.id) || [],
            archivedBranches: sessionBranches
                .filter(branch => branch.id !== active.id)
                .map(branch => ({
                    branchKey: String(branch.branchKey || branch.id),
                    parentBranchKey: String(branch.parentBranchId || ""),
                    branchedAtRound: Number(branch.branchedAtSequence) || null,
                    archivedAt: Number(branch.archivedAt) || 0,
                    rounds: roundsByBranch.get(branch.id) || []
                }))
        };
    }
    GlobalState.continuationRuntime = { chatId, byScript: nextByScript };

    if (updateCurrentChatMetadata(sessions)) void saveChatConditional();

    if (typeof window.updateSceneHistoryNav === "function") window.updateSceneHistoryNav();
    return sessions.length > 0;
}

export async function clearContinuationForCurrentChat() {
    const chatId = getCurrentChatKey();
    GlobalState.continuationRuntime = { chatId, byScript: {} };
    runtimeRevision++;
    if (chatId) {
        const db = await openDatabase();
        const transaction = db.transaction([STORE_SESSIONS, STORE_BRANCHES, STORE_ROUNDS], "readwrite");
        const completed = transactionDone(transaction);
        for (const name of [STORE_SESSIONS, STORE_BRANCHES, STORE_ROUNDS]) {
            const store = transaction.objectStore(name);
            const keys = await requestResult(store.index("chatId").getAllKeys(chatId));
            keys.forEach(key => store.delete(key));
        }
        await completed;
        if (updateCurrentChatMetadata([])) await saveChatConditional();
    }
    if (typeof window.updateSceneHistoryNav === "function") window.updateSceneHistoryNav();
}

/* ------------------------------------------------------------------ *
 * 批量删除
 * ------------------------------------------------------------------ */

export async function deleteGlobalContinuationSelections(selections = []) {
    const items = Array.isArray(selections) ? selections : [];
    if (items.length === 0) return { deletedSessions: 0, deletedBranches: 0, deletedRounds: 0 };

    const db = await openDatabase();
    const readTransaction = db.transaction([STORE_SESSIONS, STORE_BRANCHES, STORE_ROUNDS], "readonly");
    const [sessions, branches, rounds] = await Promise.all([
        requestResult(readTransaction.objectStore(STORE_SESSIONS).getAll()),
        requestResult(readTransaction.objectStore(STORE_BRANCHES).getAll()),
        requestResult(readTransaction.objectStore(STORE_ROUNDS).getAll())
    ]);

    const sessionKeys = new Set(items.filter(item => !item.branchKey).map(item => `${item.chatId}\u0000${item.scriptId}`));
    const branchKeys = new Set(items.filter(item => item.branchKey && !item.roundKey).map(item => `${item.chatId}\u0000${item.scriptId}\u0000${item.branchKey}`));
    const roundKeys = new Set(items.filter(item => item.roundKey).map(item => `${item.chatId}\u0000${item.scriptId}\u0000${item.branchKey}\u0000${item.roundKey}`));

    const sessionById = new Map(sessions.map(session => [session.id, session]));
    const deletedSessionIds = new Set();
    const deletedBranchIds = new Set();
    const deletedRoundIds = new Set();

    for (const session of sessions) {
        if (sessionKeys.has(`${session.chatId}\u0000${session.scriptId}`)) deletedSessionIds.add(session.id);
    }
    for (const branch of branches) {
        const session = sessionById.get(branch.sessionId);
        if (!session) continue;
        const branchKey = String(branch.branchKey || branch.id);
        if (deletedSessionIds.has(session.id) || branchKeys.has(`${session.chatId}\u0000${session.scriptId}\u0000${branchKey}`)) {
            deletedBranchIds.add(branch.id);
        }
    }
    for (const round of rounds) {
        const session = sessionById.get(round.sessionId);
        if (!session) continue;
        const branchKey = String(round.branchKey || round.branchId);
        if (deletedSessionIds.has(session.id) || deletedBranchIds.has(round.branchId)
            || roundKeys.has(`${session.chatId}\u0000${session.scriptId}\u0000${branchKey}\u0000${round.roundKey}`)) {
            deletedRoundIds.add(round.id);
        }
    }
    // 轮次被删空的分支随之消失
    for (const branch of branches) {
        if (deletedBranchIds.has(branch.id)) continue;
        const hasRemaining = rounds.some(round => round.branchId === branch.id && !deletedRoundIds.has(round.id));
        if (!hasRemaining) deletedBranchIds.add(branch.id);
    }

    const writeTransaction = db.transaction([STORE_SESSIONS, STORE_BRANCHES, STORE_ROUNDS], "readwrite");
    const completed = transactionDone(writeTransaction);
    const sessionStore = writeTransaction.objectStore(STORE_SESSIONS);
    const branchStore = writeTransaction.objectStore(STORE_BRANCHES);
    const roundStore = writeTransaction.objectStore(STORE_ROUNDS);

    for (const session of sessions) {
        if (deletedSessionIds.has(session.id)) continue;
        const remaining = branches.filter(branch => branch.sessionId === session.id && !deletedBranchIds.has(branch.id));
        if (remaining.length === 0) {
            deletedSessionIds.add(session.id);
            continue;
        }
        if (deletedBranchIds.has(String(session.activeBranchId || ""))) {
            const fallback = remaining.find(branch => branch.id === branches.find(item => item.id === session.activeBranchId)?.parentBranchId)
                || [...remaining].sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))[0];
            session.activeBranchId = fallback.id;
        }
    }

    sessions.forEach(session => deletedSessionIds.has(session.id) ? sessionStore.delete(session.id) : sessionStore.put(session));
    branches.forEach(branch => {
        if (deletedSessionIds.has(branch.sessionId) || deletedBranchIds.has(branch.id)) branchStore.delete(branch.id);
    });

    const nextSequenceByBranch = new Map();
    sortBySequence(rounds).forEach(round => {
        if (deletedSessionIds.has(round.sessionId) || deletedBranchIds.has(round.branchId) || deletedRoundIds.has(round.id)) {
            roundStore.delete(round.id);
            return;
        }
        const sequence = (nextSequenceByBranch.get(round.branchId) || 0) + 1;
        nextSequenceByBranch.set(round.branchId, sequence);
        roundStore.put({ ...round, sequence });
    });

    await completed;
    if (items.some(item => item.chatId === getCurrentChatKey())) await restoreContinuationForCurrentChat();
    return { deletedSessions: deletedSessionIds.size, deletedBranches: deletedBranchIds.size, deletedRounds: deletedRoundIds.size };
}
