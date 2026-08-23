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
    deleteUserFile,
    verifyUserFiles
} from "../utils/userFiles.js";
import { TitaniaLogger } from "./logger.js";

/**
 * 是否还要同步维护旧的 data.user_scripts。
 *
 * 搬家后的过渡期里，写入同时落**文件**与旧数组：文件是读取来源，旧数组是安全网 ——
 * 万一文件侧出问题，settings.json 里那份仍然是最新的，把指针删掉就能原地退回
 * 搬家前的状态，不需要翻备份。代价是这期间 settings.json 并没有变小。
 *
 * ⚠ 判据刻意是「旧数组还在不在」而**不是**一个常量开关。
 *   写成常量的话，收尾这个版本一发布，用户更新后先编辑几条剧本、再点收尾，
 *   就会撞上「文件与旧数组不一致」的校验失败 —— 而那个不一致完全是合法的，
 *   正是常量关掉双写造成的。改成状态推导后：旧数组在 → 一直同步（校验必然过），
 *   收尾删掉它 → 本函数自然返回 false，不需要任何手动翻转。
 *   全新安装走 bootstrapEmptyScriptsStore()，旧数组天生是空的，因此从不双写。
 */
function shouldDualWrite() {
    const legacy = getExtData().user_scripts;
    return Array.isArray(legacy) && legacy.length > 0;
}

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
let hydrationError = null;

/* ------------------------------------------------------------------ *
 * 指针
 * ------------------------------------------------------------------ */

/** 读指针；结构不对或版本不认识都按「未搬家」处理。模块内部用，未对外导出 */
function getScriptsPointer() {
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
        hydrationError = null;
        cache = null;
        return { ok: true, migrated: false, count: 0, error: null };
    }

    try {
        const parsed = await readScriptsFile(pointer.file, Number(pointer.rev) || 0);
        cache = parsed.scripts.filter(Boolean);
        hydrationError = null;
        TitaniaLogger.info(`剧本已从文件载入：${cache.length} 条`);
        return { ok: true, migrated: true, count: cache.length, error: null };
    } catch (e) {
        // 关键：**不能**退化成空数组。那样界面看着像剧本全丢，
        // 而随后任何一次写入会用空数组覆盖掉文件，把「看着像」变成「真的丢」。
        // 所以这里置错误标志，让 getScripts/setScripts 全部拒绝执行。
        cache = null;
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

    // 安全网：旧数组还在时同步维护它，见 shouldDualWrite() 的注释。
    // ⚠ 顺序很重要 —— 先改 cache 再写旧数组。反过来的话，若 saveExtData
    //   触发的序列化中途抛错，cache 与旧数组会停在不同的版本上。
    if (shouldDualWrite()) {
        const data = getExtData();
        data.user_scripts = next;
        saveExtData();
    }
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

/* ------------------------------------------------------------------ *
 * 搬家
 * ------------------------------------------------------------------ */

/**
 * 全新安装（或一条自定义剧本都没有）时直接建空存储，让它天生就在文件上。
 *
 * 为什么需要：未搬家时 setScripts 走 legacy 分支，把剧本写进 settings.json。
 * 也就是说新装用户会从零开始重新积累同一个卡顿，直到自己注意到设置页那张卡片
 * 并点一次搬家。而 0 条剧本时建存储没有任何要校验或要删的东西，
 * 不存在不可逆动作，代价只是一次上传 + 一次 saveExtData()。
 * 理由与 favsStore.js 的 bootstrapEmptyFavsIndex() 完全相同。
 *
 * 这里刻意不动 data.user_scripts：0 条时它要么不存在（defaults 已不再声明它），
 * 要么是个空数组，两种情况 shouldDualWrite() 都返回 false，写入直接走文件。
 *
 * @returns {Promise<boolean>} 是否真的建了
 */
export async function bootstrapEmptyScriptsStore() {
    if (isScriptsMigrated()) return false;

    const scripts = getExtData().user_scripts;
    // 有剧本就不能走这条路：那属于真正的搬家，必须过备份 + 校验 + 人工确认
    if (Array.isArray(scripts) && scripts.length > 0) return false;

    try {
        const written = await writeScriptsFile([], 1);
        writePointer({ rev: written.rev, count: 0, bytes: written.bytes, migratedAt: Date.now() });
        cache = [];
        hydrationError = null;
        TitaniaLogger.info("剧本为零，已直接建立文件存储（新增剧本将直接落文件）");
        return true;
    } catch (e) {
        // 建不上就安静退回未搬家状态：此时一条剧本都没有，什么都没丢，
        // 用户下次刷新会再试一次。刻意不弹 toast —— 全新安装第一次进来就
        // 看见一条存储错误，只会造成困惑。
        TitaniaLogger.warn("建立空剧本存储失败，本次仍走设置存储", e);
        return false;
    }
}

/**
 * 正式搬家：把 data.user_scripts 写成文件，校验文件确实落盘，然后写指针。
 *
 * 顺序是刻意的 —— 指针**最后**写。指针一写上，读取路径就改从文件走了；
 * 在校验通过之前写指针，等于在还不确定文件存在时就把读取切过去。
 * 任何一步失败都不写指针，于是失败即「什么都没发生」，可以直接重试。
 *
 * 旧的 data.user_scripts 本次**不删** —— 删除是独立的一步（见 DUAL_WRITE）。
 *
 * @returns {Promise<object>} 报告
 */
export async function migrateScriptsToFiles() {
    const startedAt = Date.now();

    if (isScriptsMigrated()) {
        return { ok: false, alreadyMigrated: true, reason: "剧本已经搬过家了" };
    }

    const data = getExtData();
    const list = Array.isArray(data.user_scripts) ? data.user_scripts.filter(Boolean) : [];
    const footprint = describeCurrentScriptsFootprint();

    let written;
    try {
        written = await writeScriptsFile(list, 1);
    } catch (e) {
        TitaniaLogger.error("搬家：剧本写入失败，未写指针", e);
        return {
            ok: false,
            aborted: true,
            reason: `写入失败：${e?.message || String(e)}`,
            settings: footprint,
            durationMs: Date.now() - startedAt
        };
    }

    // 上传接口返回 200 只说明请求被接受了，这里回头确认文件真的在磁盘上
    try {
        const verifyResult = await verifyUserFiles([written.file], { label: "剧本文件" });
        if (verifyResult[written.file] === false) {
            TitaniaLogger.error("搬家：剧本文件校验时不存在，未写指针", { file: written.file });
            return {
                ok: false,
                aborted: true,
                reason: "文件写入后校验时不存在，已中止（未改动任何数据）",
                settings: footprint,
                durationMs: Date.now() - startedAt
            };
        }
    } catch (e) {
        TitaniaLogger.error("搬家：剧本文件校验请求失败，未写指针", e);
        return {
            ok: false,
            aborted: true,
            reason: `校验请求出错（${e?.message || String(e)}），已中止（未改动任何数据）`,
            settings: footprint,
            durationMs: Date.now() - startedAt
        };
    }

    // 再读回来逐条比对一次 —— 与试运行同样的口径。搬家只做一次，多花一个请求换
    // 「切换读取路径之前确认内容无误」是值得的。
    try {
        const parsed = await readScriptsFile(written.file, 1);
        if (parsed.scripts.length !== list.length) {
            return {
                ok: false,
                aborted: true,
                reason: `读回条数不一致（源 ${list.length}，读回 ${parsed.scripts.length}），已中止`,
                settings: footprint,
                durationMs: Date.now() - startedAt
            };
        }
        cache = parsed.scripts.filter(Boolean);
    } catch (e) {
        return {
            ok: false,
            aborted: true,
            reason: `读回校验失败（${e?.message || String(e)}），已中止（未改动任何数据）`,
            settings: footprint,
            durationMs: Date.now() - startedAt
        };
    }

    writePointer({ rev: written.rev, count: written.count, bytes: written.bytes, migratedAt: Date.now() });
    hydrationError = null;

    const report = {
        ok: true,
        settings: footprint,
        written: { count: written.count, bytes: written.bytes },
        pointerBytes: utf8ByteLength(JSON.stringify(getScriptsPointer())),
        pendingRemovalBytes: footprint.bytes,
        durationMs: Date.now() - startedAt
    };
    TitaniaLogger.info("剧本搬家完成（旧数据仍保留）", report);
    return report;
}

/**
 * 供备份导出用：把整表还成搬家前的 user_scripts 数组形状。
 *
 * 与 favsStore 的 exportFavsAsLegacyArray() 同样的取向 ——
 * 备份要自成一体、不依赖 user/files 目录（ST 的自动备份不管那个目录），
 * 并且与旧版插件的备份格式互通，导入后落在「未搬家」状态、再搬一次即可。
 * 读不出来就抛错，宁可导不出备份，也不能悄悄给出一份没有剧本的空壳。
 *
 * @returns {object[]}
 */
export function exportScriptsAsLegacyArray() {
    assertUsable();
    if (!isScriptsMigrated()) {
        const scripts = getExtData().user_scripts;
        return Array.isArray(scripts) ? scripts : [];
    }
    if (!Array.isArray(cache)) {
        throw new Error("剧本尚未载入，无法导出备份。请刷新页面后重试。");
    }
    return cache;
}

/* ------------------------------------------------------------------ *
 * 收尾：删除旧数据（唯一不可逆的一步）
 * ------------------------------------------------------------------ */

/**
 * 删除之前的核对：磁盘上那份必须与 settings.json 里的旧数组逐条一致。
 *
 * ⚠ 刻意**重新从磁盘读**，不用内存里的 cache。要确认的正是「磁盘上到底是什么」——
 *   拿 cache 比对只能证明内存自己跟自己一致，万一某次写入静默失败就查不出来。
 *
 * @returns {Promise<{ok: boolean, checked: number, problems: string[]}>}
 */
async function verifyScriptsAgainstLegacy() {
    const pointer = getScriptsPointer();
    if (!pointer) return { ok: false, checked: 0, problems: ["尚未搬家，没有可核对的文件存储"] };
    if (hydrationError) return { ok: false, checked: 0, problems: [`剧本未能载入：${hydrationError}`] };

    const legacy = getExtData().user_scripts;
    const legacyList = Array.isArray(legacy) ? legacy.filter(Boolean) : [];
    const problems = [];

    if (legacyList.length === 0) {
        return { ok: false, checked: 0, problems: ["settings.json 里已经没有旧剧本数据了"] };
    }

    // 先确认文件在磁盘上 —— 上传接口返回 200 只说明请求被接受了
    try {
        const verifyResult = await verifyUserFiles([pointer.file], { label: "剧本文件" });
        if (verifyResult[pointer.file] === false) {
            return { ok: false, checked: 0, problems: [`剧本文件不存在：${pointer.file}`] };
        }
    } catch (e) {
        return { ok: false, checked: 0, problems: [`文件校验请求失败：${e?.message || String(e)}`] };
    }

    let parsed;
    try {
        parsed = await readScriptsFile(pointer.file, Number(pointer.rev) || 0);
    } catch (e) {
        return { ok: false, checked: 0, problems: [`剧本文件读取失败：${e?.message || String(e)}`] };
    }

    const onDisk = parsed.scripts.filter(Boolean);
    if (onDisk.length !== legacyList.length) {
        problems.push(`条数不一致：文件里 ${onDisk.length} 条，settings.json 里 ${legacyList.length} 条`);
        return { ok: false, checked: 0, problems };
    }

    // 按 id 配对比对，不依赖顺序 —— 顺序理论上一致（两侧写的是同一个数组），
    // 但「顺序不同」不该算数据问题，真正要拦的是内容不一致或缺条目。
    const diskById = new Map(onDisk.map(s => [String(s?.id), s]));
    let checked = 0;

    for (const original of legacyList) {
        const mirror = diskById.get(String(original?.id));
        if (!mirror) {
            problems.push(`settings.json 里的「${original?.name || original?.id}」在文件里找不到`);
        } else if (JSON.stringify(mirror) !== JSON.stringify(original)) {
            problems.push(`剧本「${original?.name || original?.id}」的内容与 settings.json 里的不一致`);
        }
        checked++;
        if (problems.length >= 5) break;
    }

    return { ok: problems.length === 0, checked, problems };
}

/**
 * 删除 settings.json 里的旧剧本数组。**这是整个搬家里唯一不可逆的一步。**
 *
 * 删掉之后 shouldDualWrite() 自然返回 false，写入不再碰 settings，
 * 于是「改任何一个开关都要重抄一遍全部剧本」这件事才真正结束。
 *
 * @param {{confirmBeforeDelete?: (v: object) => Promise<boolean>|boolean}} [options]
 * @returns {Promise<object>}
 */
export async function dropLegacyScripts(options = {}) {
    const verification = await verifyScriptsAgainstLegacy();
    if (!verification.ok) {
        return { ok: false, removedBytes: 0, problems: verification.problems };
    }

    if (typeof options.confirmBeforeDelete === "function") {
        const proceed = await options.confirmBeforeDelete(verification);
        if (!proceed) {
            TitaniaLogger.info("核对已通过，但用户在删除前取消，旧剧本数据保留");
            return { ok: false, removedBytes: 0, cancelled: true, checked: verification.checked };
        }
    }

    const data = getExtData();
    const removedBytes = utf8ByteLength(JSON.stringify(data.user_scripts || []));
    // 用 delete 而不是赋空数组：defaults 已不再声明 user_scripts，所以删掉之后
    // 它不会再被任何路径加回来，settings.json 里真的少掉这个键。
    delete data.user_scripts;
    saveExtData();

    TitaniaLogger.info(`旧剧本数据已删除，settings.json 减少约 ${removedBytes} 字节`);
    return { ok: true, removedBytes, checked: verification.checked };
}
