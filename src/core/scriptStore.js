// src/core/scriptStore.js
//
// 剧本存储：整表一个文件，settings.json 里只留一个指针。
//
// 为什么要有这个模块
// ------------------
// ST 的 saveSettings() 每次都把「整个」设置对象序列化后整文件覆写
// （public/script.js → src/endpoints/settings.js 的同步 writeFileAtomicSync）。
// 剧本塞在 extension_settings.user_scripts 里，就意味着改任何一个开关都要
// 连带重抄一遍全部剧本。这与收藏搬家（见 favsStore.js）要解决的是同一个问题。
//
// 实测（data/default-user/settings.json，2.70 MB，插件整块 1567.5 KB）：
// user_scripts 当前只有 2 条 / 2.1 KB，但按当前均值外推到 1000 条约 1071 KB，
// 其中 prompt 正文约 805 KB（75%）—— 那时它会是插件内最大的单项。
//
// ── 为什么是「整表一个文件」，而不是照收藏那样一条一个 ──
// 收藏正文单条可达 127 KB 且一次只读一条，一条一文件是对的。剧本正文中位数
// 只有 854 字节，上千条也才 1 MB；一条一文件会带来 1000 个文件、导出要发 N 个
// 请求、外加索引与正文的一致性维护。而整表一文件能把 user_scripts 从 settings
// 里**完全**清零（一条一文件仍要留约 266 KB 元数据索引）。
// 代价是「改一条剧本要重写整个文件」—— 但剧本编辑是低频的用户主动操作，
// 与「每次点开关都重抄一遍」不是一个量级的问题。
//
// 前提是原子覆写：/api/files/upload 是 writeFileSyncAtomic
// （src/endpoints/files.js:44），同名路径原子覆盖、崩溃不留截断文件。
//
// ── 谁是事实来源 ──
// **文件**。指针里的 rev/count 只用于去缓存与界面显示，不作校验基准 ——
// 文件写入是立即的，而 saveExtData() 是 debounced，指针天然可能落后于文件。

import { getExtData, saveExtData } from "../utils/storage.js";
import {
    utf8ByteLength,
    uploadTextFile,
    fetchTextFile,
    deleteUserFile
} from "../utils/userFiles.js";
import { TitaniaLogger } from "./logger.js";

/** 剧本整表文件名。固定单文件，不带 id */
export const SCRIPTS_FILE_NAME = "titania_scripts.json";

/** 试运行专用文件名。刻意与正式文件分开，保证试运行在任何状态下都不会碰真数据 */
const SCRIPTS_DRYRUN_FILE_NAME = "titania_scripts_dryrun.json";

/** 文件的结构版本。读取时不匹配要显式报错，而不是静默当空内容 */
const SCRIPTS_FILE_VERSION = 1;

/** 指针在 extension_settings 里的键名 */
export const SCRIPTS_STORE_KEY = "scripts_store";

/** 指针结构版本 */
const SCRIPTS_STORE_VERSION = 1;

/* ------------------------------------------------------------------ *
 * 模块状态
 *
 * cache 是搬家后剧本的唯一内存副本。hydrationError 一旦置上，
 * 读写全部拒绝 —— 理由见 getScripts() 上方的注释，这是本模块最重要的一条规则。
 * ------------------------------------------------------------------ */

let cache = null;
let hydrated = false;
let hydrationError = null;

/* ------------------------------------------------------------------ *
 * 指针
 * ------------------------------------------------------------------ */

/** 读指针；结构不对或版本不认识都按「未搬家」处理 */
export function getScriptsPointer() {
    const store = getExtData()[SCRIPTS_STORE_KEY];
    if (!store || typeof store !== "object") return null;
    if (Number(store.version) !== SCRIPTS_STORE_VERSION) {
        TitaniaLogger.warn(`剧本存储指针版本不受支持：${store.version}，按未搬家处理`);
        return null;
    }
    return store;
}

/** 是否已经搬过家（剧本是否已在独立文件里） */
export function isScriptsMigrated() {
    return getScriptsPointer() !== null;
}

function writePointer({ rev, count, bytes, migratedAt }) {
    const data = getExtData();
    const previous = data[SCRIPTS_STORE_KEY];
    data[SCRIPTS_STORE_KEY] = {
        version: SCRIPTS_STORE_VERSION,
        migratedAt: Number(migratedAt) || Number(previous?.migratedAt) || Date.now(),
        file: `/user/files/${SCRIPTS_FILE_NAME}`,
        rev: Number(rev) || 1,
        count: Number(count) || 0,
        bytes: Number(bytes) || 0
    };
    saveExtData();
}

/* ------------------------------------------------------------------ *
 * 文件读写
 * ------------------------------------------------------------------ */

/** 组装文件内容 */
function buildScriptsFile(scripts, rev) {
    return {
        version: SCRIPTS_FILE_VERSION,
        rev: Number(rev) || 1,
        savedAt: Date.now(),
        scripts: Array.isArray(scripts) ? scripts : []
    };
}

/**
 * 把整表写进文件。
 * @returns {Promise<{file: string, bytes: number, rev: number, count: number}>}
 */
async function writeScriptsFile(scripts, rev, fileName = SCRIPTS_FILE_NAME) {
    const text = JSON.stringify(buildScriptsFile(scripts, rev));
    const file = await uploadTextFile(fileName, text);
    return { file, bytes: utf8ByteLength(text), rev: Number(rev) || 1, count: scripts.length };
}

/**
 * 读回整表。
 *
 * 任何一种「读不出可信内容」都必须抛错，不能返回空数组 —— 见 hydrateScripts()。
 */
async function readScriptsFile(filePath, rev = 0) {
    const raw = await fetchTextFile(filePath, rev);

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(`剧本文件不是合法 JSON（${filePath}）：${e?.message || e}`);
    }

    if (!parsed || typeof parsed !== "object") {
        throw new Error(`剧本文件结构异常（${filePath}）`);
    }
    if (Number(parsed.version) !== SCRIPTS_FILE_VERSION) {
        throw new Error(`剧本文件版本不受支持：${parsed.version}（${filePath}）`);
    }
    if (!Array.isArray(parsed.scripts)) {
        throw new Error(`剧本文件缺少 scripts 数组（${filePath}）`);
    }
    return parsed;
}

/* ------------------------------------------------------------------ *
 * 落盘调度
 *
 * 不用防抖延时，改用「立刻写 + 至多一个在途 + 尾随补写」：
 *   · 防抖会留下一个数据丢失窗口 —— 编辑完立刻关标签页，改动就没了。
 *     剧本是用户手写的内容，不该有这种窗口。
 *   · 而直接每次都写又会让 scriptManager.js 的批量改分类（一个同步循环，
 *     逐条调 saveUserScript）产生 N 次整表写入。
 * 下面这个 pump 同时解决两头：同步循环里的 N 次调用，第一次进入写入、
 * 其余 N-1 次只置 dirty；第一次写完后 dirty 仍为真，再补写一次最终状态。
 * 于是 N 条批量 = 2 次文件写入，且没有延时窗口。
 * ------------------------------------------------------------------ */

let writing = false;
let dirty = false;
let currentPump = null;
let lastWriteError = null;

/**
 * 触发落盘。
 * @returns {Promise<void>} 已在途时返回**当前那一轮**的 promise ——
 *   由于下面的 do/while 会看到刚置上的 dirty 并补写一次，
 *   await 这个 promise 就等于「等到我这次的改动也落了盘」。
 *   flushScriptsNow() 的正确性依赖这一点，别改成返回 undefined。
 */
function pump() {
    if (writing) {
        dirty = true;
        return currentPump;
    }
    writing = true;
    currentPump = (async () => {
        try {
            do {
                dirty = false;
                const pointer = getScriptsPointer();
                const nextRev = (Number(pointer?.rev) || 0) + 1;
                const written = await writeScriptsFile(cache, nextRev);
                writePointer({ rev: written.rev, count: written.count, bytes: written.bytes });
                lastWriteError = null;
            } while (dirty);
        } catch (e) {
            lastWriteError = e?.message || String(e);
            TitaniaLogger.error("剧本落盘失败", e);
            if (window.toastr) {
                toastr.error(`剧本保存失败：${lastWriteError}`, "Titania Echo", { timeOut: 10000 });
            }
        } finally {
            writing = false;
        }
    })();
    return currentPump;
}

/** 立刻落盘并等待完成。备份导出、导入前、以及任何需要确定性的地方用它 */
export async function flushScriptsNow() {
    if (!isScriptsMigrated()) return true;
    assertUsable();
    await pump();
    // pump 内部吞掉异常以免打断 UI，这里把结果如实返回给调用方
    return lastWriteError === null;
}

/** 最近一次落盘是否失败；设置页的存储卡片用它显示告警 */
export function getLastWriteError() {
    return lastWriteError;
}

/* ------------------------------------------------------------------ *
 * 水合与读写
 * ------------------------------------------------------------------ */

/**
 * 启动时把整表读进内存。由 entry.js 的 loadExtensionSettings() 在
 * initCoreFeatures() **之前** await 一次。
 *
 * 未搬家时是空操作：此时 getScripts() 直接回退读 data.user_scripts。
 *
 * @returns {Promise<{ok: boolean, migrated: boolean, count: number, error: string|null}>}
 */
export async function hydrateScripts() {
    const pointer = getScriptsPointer();
    if (!pointer) {
        hydrated = true;
        hydrationError = null;
        cache = null;
        return { ok: true, migrated: false, count: 0, error: null };
    }

    try {
        const parsed = await readScriptsFile(pointer.file, Number(pointer.rev) || 0);
        cache = parsed.scripts.filter(Boolean);
        hydrated = true;
        hydrationError = null;
        TitaniaLogger.info(`剧本已从文件载入：${cache.length} 条`);
        return { ok: true, migrated: true, count: cache.length, error: null };
    } catch (e) {
        // 关键：**不能**退化成空数组。那样界面看着像剧本全丢，
        // 而随后任何一次写入会用空数组覆盖掉文件，把「看着像」变成「真的丢」。
        // 所以这里置错误标志，让 getScripts/setScripts 全部拒绝执行。
        cache = null;
        hydrated = true;
        hydrationError = e?.message || String(e);
        TitaniaLogger.error("剧本载入失败，已进入只读保护状态", e);
        return { ok: false, migrated: true, count: 0, error: hydrationError };
    }
}

/** 水合失败时挡住一切读写 */
function assertUsable() {
    if (hydrationError) {
        throw new Error(
            `剧本数据未能载入（${hydrationError}）。为避免覆盖磁盘上的文件，` +
            `所有剧本读写已暂停。请刷新重试，或从备份恢复。`
        );
    }
}

/** 本次会话是否已经水合过（entry.js 用它避免重复 await） */
export function isScriptsHydrated() {
    return hydrated;
}

/** 水合失败的原因；null 表示正常 */
export function getHydrationError() {
    return hydrationError;
}

/**
 * 取整表（同步）。
 *
 * 搬家后读内存缓存，未搬家时回退 data.user_scripts —— 于是 scriptData.js 的
 * loadScripts / saveUserScript / saveUserScripts / deleteUserScript
 * 签名一律不用改，6 个调用点也一行都不用动。
 *
 * @returns {object[]}
 */
export function getScripts() {
    assertUsable();
    if (!isScriptsMigrated()) {
        const data = getExtData();
        return Array.isArray(data.user_scripts) ? data.user_scripts : [];
    }
    return Array.isArray(cache) ? cache : [];
}

/**
 * 覆盖整表（同步返回，落盘在后台串行进行）。
 * @param {object[]} list
 */
export function setScripts(list) {
    assertUsable();
    const next = Array.isArray(list) ? list.filter(Boolean) : [];

    if (!isScriptsMigrated()) {
        const data = getExtData();
        data.user_scripts = next;
        saveExtData();
        return;
    }

    cache = next;
    void pump();
}

/* ------------------------------------------------------------------ *
 * 占用统计（设置页的存储卡片用）
 * ------------------------------------------------------------------ */

/** 搬家前：user_scripts 在 settings.json 里占多少 */
export function describeCurrentScriptsFootprint() {
    const scripts = getExtData().user_scripts;
    const list = Array.isArray(scripts) ? scripts : [];
    const promptBytes = list.reduce((sum, s) => sum + utf8ByteLength(String(s?.prompt || "")), 0);
    return {
        count: list.length,
        bytes: utf8ByteLength(JSON.stringify(list)),
        promptBytes
    };
}

/** 搬家后：文件与指针各占多少 */
export function describeScriptsStorageFootprint() {
    const pointer = getScriptsPointer();
    if (!pointer) return null;
    return {
        count: Number(pointer.count) || 0,
        fileBytes: Number(pointer.bytes) || 0,
        pointerBytes: utf8ByteLength(JSON.stringify(pointer)),
        file: String(pointer.file || ""),
        rev: Number(pointer.rev) || 0,
        migratedAt: Number(pointer.migratedAt) || 0
    };
}

/* ------------------------------------------------------------------ *
 * 试运行
 * ------------------------------------------------------------------ */

/**
 * 试运行搬家：把当前 user_scripts 写成一个**独立的试运行文件**、读回、
 * 与源数组做深比对，然后删掉试运行文件。
 *
 * 全程不写指针、不碰 data.user_scripts、不碰正式文件 —— 无论当前处于
 * 搬没搬家的哪种状态，跑它都不会改变任何真实数据。
 *
 * 深比对用 JSON.stringify 逐条对照而不是只比条数：搬家真正的风险不是「少了几条」，
 * 而是某个字段在序列化往返中被悄悄改掉（undefined 丢失、数字精度、键序）。
 * 键序在这里是可比的 —— 两侧都是同一批对象经同一个 JSON 实现产生的。
 *
 * @returns {Promise<object>} 报告
 */
export async function dryRunScriptsMigration() {
    const startedAt = Date.now();
    const source = getExtData().user_scripts;
    const list = Array.isArray(source) ? source : [];
    const footprint = describeCurrentScriptsFootprint();

    if (list.length === 0) {
        return {
            ok: true,
            empty: true,
            reason: "当前没有自定义剧本，无需搬家",
            settings: footprint,
            durationMs: Date.now() - startedAt
        };
    }

    let written = null;
    let readBack = null;
    let cleanupError = null;

    try {
        written = await writeScriptsFile(list, 1, SCRIPTS_DRYRUN_FILE_NAME);
        readBack = await readScriptsFile(written.file, 1);
    } catch (e) {
        return {
            ok: false,
            reason: e?.message || String(e),
            settings: footprint,
            durationMs: Date.now() - startedAt
        };
    } finally {
        if (written) {
            try {
                await deleteUserFile(written.file, { label: "剧本试运行文件" });
            } catch (e) {
                cleanupError = e?.message || String(e);
            }
        }
    }

    // 逐条深比对
    const mismatches = [];
    const back = readBack.scripts;
    if (back.length !== list.length) {
        mismatches.push(`条数不一致：源 ${list.length}，读回 ${back.length}`);
    }
    const limit = Math.min(back.length, list.length);
    for (let i = 0; i < limit; i++) {
        if (JSON.stringify(back[i]) !== JSON.stringify(list[i])) {
            mismatches.push(`第 ${i + 1} 条（id=${list[i]?.id}）内容不一致`);
            if (mismatches.length >= 5) break;
        }
    }

    return {
        ok: mismatches.length === 0,
        identical: mismatches.length === 0,
        mismatches,
        settings: footprint,
        written: { count: written.count, bytes: written.bytes },
        cleanupError,
        durationMs: Date.now() - startedAt
    };
}
