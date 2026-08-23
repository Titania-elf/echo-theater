// src/core/scriptData.js
//
// ⚠ 剧本数组不再直接读写 data.user_scripts —— 一律经 scriptStore 的
//   getScripts() / setScripts()。搬家后前者读文件缓存、后者落文件；
//   未搬家时两者自动回退到 data.user_scripts，所以本文件的函数签名不变。
//   直接碰 data.user_scripts 会绕开文件存储，搬家后就是「改了但没保存」。

import { getExtData, saveExtData } from "../utils/storage.js";
import { getScripts, setScripts } from "./scriptStore.js";
import { GlobalState } from "./state.js";
import { DEFAULT_PRESETS } from "../config/presets.js";

const SCRIPT_SORT_MODES = new Set([
    "default",
    "name_asc",
    "name_desc",
    "recent_added",
    "recent_generated",
    "most_used",
    "smart"
]);

function ensureStatsStore(data) {
    if (!data.script_stats || typeof data.script_stats !== "object") {
        data.script_stats = {};
    }
    if (!data.script_stats_meta || typeof data.script_stats_meta !== "object") {
        data.script_stats_meta = { version: 1, last_cleanup_at: 0 };
    }
    if (!data.ui_prefs || typeof data.ui_prefs !== "object") {
        data.ui_prefs = {};
    }
}

function getEmptyStats() {
    return {
        selected_count: 0,
        generated_count: 0,
        queue_generated_count: 0,
        last_selected_at: 0,
        last_generated_at: 0,
        first_used_at: 0,
        last_mode: "",
        category_snapshot: ""
    };
}

function normalizeStats(raw) {
    const base = getEmptyStats();
    if (!raw || typeof raw !== "object") return base;
    return {
        selected_count: Number(raw.selected_count) || 0,
        generated_count: Number(raw.generated_count) || 0,
        queue_generated_count: Number(raw.queue_generated_count) || 0,
        last_selected_at: Number(raw.last_selected_at) || 0,
        last_generated_at: Number(raw.last_generated_at) || 0,
        first_used_at: Number(raw.first_used_at) || 0,
        last_mode: typeof raw.last_mode === "string" ? raw.last_mode : "",
        category_snapshot: typeof raw.category_snapshot === "string" ? raw.category_snapshot : ""
    };
}

function upsertStatsUnsafe(data, scriptId) {
    ensureStatsStore(data);
    const normalized = normalizeStats(data.script_stats[scriptId]);
    data.script_stats[scriptId] = normalized;
    return normalized;
}

function getScriptCategory(script) {
    if (!script) return "";
    return script.category || (script._type === "preset" ? "官方预设" : "未分类");
}

function getSmartScore(stats, nowTs) {
    const generated = Math.max(0, Number(stats.generated_count) || 0);
    const lastTs = Math.max(0, Number(stats.last_generated_at) || 0);
    const usageScore = Math.log(1 + generated);
    if (!lastTs) {
        return usageScore * 0.65;
    }
    const days = Math.max(0, (nowTs - lastTs) / 86400000);
    const recencyDecay = Math.exp(-days / 7);
    return usageScore * 0.65 + recencyDecay * 0.35;
}

function compareByMode(a, b, mode, nowTs) {
    const aName = (a.name || "").toString();
    const bName = (b.name || "").toString();
    const aStats = a._stats || getEmptyStats();
    const bStats = b._stats || getEmptyStats();

    if (mode === "name_asc") {
        const n = aName.localeCompare(bName, "zh-CN");
        return n !== 0 ? n : (a.id || "").localeCompare(b.id || "");
    }
    if (mode === "name_desc") {
        const n = bName.localeCompare(aName, "zh-CN");
        return n !== 0 ? n : (a.id || "").localeCompare(b.id || "");
    }
    if (mode === "recent_added") {
        const t = (Number(b.created_at) || 0) - (Number(a.created_at) || 0);
        if (t !== 0) return t;
        return 0;
    }
    if (mode === "recent_generated") {
        const t = (bStats.last_generated_at || 0) - (aStats.last_generated_at || 0);
        if (t !== 0) return t;
        return aName.localeCompare(bName, "zh-CN");
    }
    if (mode === "most_used") {
        const c = (bStats.generated_count || 0) - (aStats.generated_count || 0);
        if (c !== 0) return c;
        const t = (bStats.last_generated_at || 0) - (aStats.last_generated_at || 0);
        if (t !== 0) return t;
        return aName.localeCompare(bName, "zh-CN");
    }
    if (mode === "smart") {
        const bScore = getSmartScore(bStats, nowTs);
        const aScore = getSmartScore(aStats, nowTs);
        const diff = bScore - aScore;
        if (Math.abs(diff) > 1e-6) return diff;
        const c = (bStats.generated_count || 0) - (aStats.generated_count || 0);
        if (c !== 0) return c;
        const t = (bStats.last_generated_at || 0) - (aStats.last_generated_at || 0);
        if (t !== 0) return t;
        return aName.localeCompare(bName, "zh-CN");
    }

    return 0;
}

export function getScriptStats(scriptId) {
    const data = getExtData();
    ensureStatsStore(data);
    return normalizeStats(data.script_stats[scriptId]);
}

/**
 * 批量渲染场景专用：只取一次 getExtData()，返回按 id 查询统计的读取器。
 * 避免在列表循环里逐项触发 getExtData() 的规范化开销。
 * @returns {(scriptId: string) => object}
 */
export function createScriptStatsReader() {
    const data = getExtData();
    ensureStatsStore(data);
    return scriptId => normalizeStats(data.script_stats[scriptId]);
}

export function getScriptSortMode() {
    const data = getExtData();
    ensureStatsStore(data);
    const mode = data.ui_prefs.script_sort_mode;
    return SCRIPT_SORT_MODES.has(mode) ? mode : "smart";
}

export function setScriptSortMode(mode) {
    const validMode = SCRIPT_SORT_MODES.has(mode) ? mode : "smart";
    const data = getExtData();
    ensureStatsStore(data);
    data.ui_prefs.script_sort_mode = validMode;
    saveExtData();
    return validMode;
}

export function recordScriptSelected(scriptId) {
    if (!scriptId) return;
    const data = getExtData();
    const stats = upsertStatsUnsafe(data, scriptId);
    stats.selected_count += 1;
    stats.last_selected_at = Date.now();
    saveExtData();
}

export function recordScriptGenerated(scriptId, options = {}) {
    if (!scriptId) return;

    const {
        isQueue = false,
        mode = "",
        category = ""
    } = options;

    const data = getExtData();
    const stats = upsertStatsUnsafe(data, scriptId);
    const nowTs = Date.now();

    stats.generated_count += 1;
    stats.last_generated_at = nowTs;
    if (!stats.first_used_at) {
        stats.first_used_at = nowTs;
    }
    if (isQueue) {
        stats.queue_generated_count += 1;
    }
    if (typeof mode === "string" && mode) {
        stats.last_mode = mode;
    }
    if (typeof category === "string" && category) {
        stats.category_snapshot = category;
    }

    saveExtData();
}

export function removeScriptStats(scriptId) {
    if (!scriptId) return;
    const data = getExtData();
    ensureStatsStore(data);
    if (Object.prototype.hasOwnProperty.call(data.script_stats, scriptId)) {
        delete data.script_stats[scriptId];
        saveExtData();
    }
}

export function cleanupOrphanScriptStats() {
    const data = getExtData();
    ensureStatsStore(data);

    const activeIds = new Set();
    DEFAULT_PRESETS.forEach(p => activeIds.add(p.id));
    (getScripts()).forEach(s => activeIds.add(s.id));

    let removed = 0;
    Object.keys(data.script_stats).forEach(scriptId => {
        if (!activeIds.has(scriptId)) {
            delete data.script_stats[scriptId];
            removed++;
        }
    });

    data.script_stats_meta.last_cleanup_at = Date.now();
    if (removed > 0) {
        saveExtData();
    }

    return removed;
}

export function sortScripts(list, mode = "smart") {
    const validMode = SCRIPT_SORT_MODES.has(mode) ? mode : "smart";
    if (!Array.isArray(list) || list.length <= 1) return Array.isArray(list) ? [...list] : [];

    if (validMode === "default") {
        return [...list];
    }

    const data = getExtData();
    ensureStatsStore(data);
    const nowTs = Date.now();

    return [...list]
        .map((script, index) => ({
            ...script,
            _sortIndex: index,
            _stats: normalizeStats(data.script_stats[script.id])
        }))
        .sort((a, b) => {
            const primary = compareByMode(a, b, validMode, nowTs);
            if (primary !== 0) return primary;
            return a._sortIndex - b._sortIndex;
        })
        .map(script => {
            const { _sortIndex, _stats, ...rest } = script;
            return rest;
        });
}

export function buildScriptStatsOverview(runtimeScripts, options = {}) {
    const days = Number(options.days) > 0 ? Number(options.days) : 7;
    const nowTs = Date.now();
    const rangeStart = nowTs - (days * 86400000);

    const data = getExtData();
    ensureStatsStore(data);
    const allStats = data.script_stats || {};
    const scriptMap = new Map((runtimeScripts || []).map(s => [s.id, s]));

    const entries = Object.entries(allStats).map(([scriptId, raw]) => {
        const stats = normalizeStats(raw);
        const script = scriptMap.get(scriptId);
        const name = script?.name || `已删除剧本(${scriptId})`;
        const category = script ? getScriptCategory(script) : (stats.category_snapshot || "未知");
        return {
            scriptId,
            name,
            category,
            stats
        };
    });

    const topUsed = entries
        .filter(e => e.stats.generated_count > 0)
        .sort((a, b) => {
            const countDiff = b.stats.generated_count - a.stats.generated_count;
            if (countDiff !== 0) return countDiff;
            return b.stats.last_generated_at - a.stats.last_generated_at;
        })
        .slice(0, 5)
        .map(e => ({
            scriptId: e.scriptId,
            name: e.name,
            category: e.category,
            generated_count: e.stats.generated_count,
            last_generated_at: e.stats.last_generated_at
        }));

    const recentActiveSet = new Set(
        entries
            .filter(e => e.stats.last_generated_at >= rangeStart)
            .map(e => e.scriptId)
    );

    const categoryMap = new Map();
    entries.forEach(e => {
        const key = e.category || "未知";
        const prev = categoryMap.get(key) || 0;
        categoryMap.set(key, prev + (e.stats.generated_count || 0));
    });

    const categoryRanking = [...categoryMap.entries()]
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([category, generated_count]) => ({ category, generated_count }));

    return {
        total_tracked_scripts: entries.length,
        active_last_days: recentActiveSet.size,
        days,
        top_used: topUsed,
        category_ranking: categoryRanking
    };
}

/**
 * 加载脚本 (合并官方预设和用户自定义)
 */
export function loadScripts() {
    const data = getExtData();
    ensureStatsStore(data);
    const userScripts = getScripts();
    const disabledIDs = data.disabled_presets || [];

    // 加载预设 (过滤掉在黑名单里的)
    GlobalState.runtimeScripts = DEFAULT_PRESETS
        .filter(p => !disabledIDs.includes(p.id))
        .map(p => ({ ...p, _type: 'preset' }));

    // 合并自定义剧本
    userScripts.forEach(s => {
        // 避免 ID 冲突，如果预设里有同名 ID，优先保留预设
        if (!GlobalState.runtimeScripts.find(r => r.id === s.id)) {
            GlobalState.runtimeScripts.push({
                ...s,
                _type: 'user'
            });
        }
    });
}

/**
 * 把一条剧本并入 user_scripts 数组并返回新数组（纯函数，不落盘）。
 *
 * 单条保存与批量保存共用同一份合并语义 —— 写两份必然漂移。
 * created_at 的规则：已存在就继承旧值（改内容不算重新创建），
 * 传入带了就用传入的（导入/备份恢复要保留原始时间），都没有才用当下时间。
 */
function mergeUserScript(list, s) {
    const existing = list.find(x => x.id === s.id);
    const createdAt = Number(existing?.created_at) || Number(s.created_at) || (existing ? 0 : Date.now());
    const script = { ...s };
    if (createdAt) script.created_at = createdAt;
    return [...list.filter(x => x.id !== s.id), script];
}

/**
 * 保存/更新用户剧本
 */
export function saveUserScript(s) {
    const data = getExtData();
    ensureStatsStore(data);
    setScripts(mergeUserScript(getScripts(), s));
    // ⚠ 这一句是为 ensureStatsStore 落盘的，不是为剧本 —— 剧本由 setScripts 自己
    //   负责（搬家后写文件）。ensureStatsStore 可能刚创建了 script_stats /
    //   script_stats_meta / ui_prefs，那些仍住在 settings 里。
    //   收尾关掉双写后 setScripts 不再碰 settings，少了这句就没人保存它们了。
    saveExtData();
    loadScripts(); // 重新加载到运行时
}

/**
 * 批量保存/更新用户剧本。
 *
 * 与逐条调用 saveUserScript 的差别只在收尾：落盘与 loadScripts 各只做一次。
 * loadScripts 会整表重建 GlobalState.runtimeScripts，一批 20 条逐条调就是重建 20 次。
 *
 * ⚠ 搬家后落盘也被合并：scriptStore 的 pump 保证「至多一个在途 + 尾随补写」，
 *   所以逐条调也只会产生 2 次文件写入 —— 但 loadScripts 是同步的，仍然省不掉。
 *
 * @param {object[]} scripts 待写入的剧本；空数组直接返回，不触发任何落盘
 * @returns {number} 实际写入条数
 */
export function saveUserScripts(scripts) {
    const list = Array.isArray(scripts) ? scripts.filter(Boolean) : [];
    if (list.length === 0) return 0;

    const data = getExtData();
    ensureStatsStore(data);
    let u = getScripts();
    for (const s of list) u = mergeUserScript(u, s);
    setScripts(u);
    saveExtData(); // 同 saveUserScript：为 ensureStatsStore 落盘，不是为剧本
    loadScripts();
    return list.length;
}

/**
 * 删除用户剧本
 */
export function deleteUserScript(id) {
    const data = getExtData();
    ensureStatsStore(data);
    setScripts(getScripts().filter(x => x.id !== id));
    delete data.script_stats[id];
    saveExtData();
    loadScripts(); // 重新加载到运行时
}
