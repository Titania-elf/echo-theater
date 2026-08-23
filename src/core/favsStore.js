// src/core/favsStore.js
//
// 收藏存储：正文一条一个文件，settings.json 里只留索引。
//
// 为什么要有这个模块
// ------------------
// ST 的 saveSettings() 每次都把「整个」设置对象序列化后整文件覆写
// （public/script.js:7505 → src/endpoints/settings.js:205 是同步的 writeFileAtomicSync）。
// 收藏正文塞在 extension_settings 里，就意味着改任何一个开关都要连带重抄一遍全部收藏：
// 实测 176 条收藏时 settings.json 达 11.2 MB，其中 7.36 MB 是收藏正文，
// 客户端每次保存同步阻塞 15.8 ms，服务端同步写盘阻塞 35–60 ms。
// 把正文移到独立文件后，新增一条收藏的写入量与「已有多少条收藏」无关。
//
// 文件落点：<user>/user/files/titania_fav_<id>.json
//   - 该目录是 ST 的 USER_DIRECTORY_TEMPLATE 成员（src/constants.js:43），
//     每次启动由 ensurePublicDirectoriesExist() 保证存在（src/users.js:109）。
//   - 写盘由 ST 服务端进程完成，浏览器不直接碰文件系统，
//     因此与移动端的存储授权无关（详见 CONTRIBUTING 之外的方案讨论记录）。
//   - 读取路径 /user/files/* 由 src/users.js:1081 映射到该目录。
//
// 本文件当前只被「试运行搬家」按钮调用，尚未接入收藏夹的读写路径。

import { getSnippet, parseMeta } from "../utils/helpers.js";
import { getExtData, saveExtData } from "../utils/storage.js";
import {
    utf8ByteLength,
    uploadTextFile,
    fetchTextFile,
    deleteUserFile,
    verifyUserFiles
} from "../utils/userFiles.js";
import { TitaniaLogger } from "./logger.js";

/** 正文文件名前缀。与 8 月遗留的同名文件保持一致，便于对照校验 */
const FAV_FILE_PREFIX = "titania_fav_";

/** 正文文件的结构版本。读取时不匹配要显式报错，而不是静默当空内容 */
const FAV_BODY_VERSION = 1;

/** 索引在 extension_settings 里的键名。
 *  刻意不复用 8 月遗留的 favs_meta —— 那份索引停留在迁移当天的快照
 *  （171 条，缺后来新增的 6 条、含 1 条已删除的残留），
 *  复用它会让过期数据被误判为有效索引。favs_meta 的清理留到后续提交，
 *  在那之前它还是定位残留文件的唯一线索。*/
export const FAVS_INDEX_KEY = "favs_index";

/**
 * 生成正文文件名。
 * ST 的 validateAssetFileName 只放行 /^[a-zA-Z0-9_\-.]+$/，
 * 所以 id 里任何其它字符都要先剔掉；剔空则视为非法 id。
 * @param {string|number} id
 * @returns {string}
 */
export function favFileName(id) {
    const safeId = String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeId) throw new Error(`收藏 ID 非法，无法生成文件名：${JSON.stringify(id)}`);
    return `${FAV_FILE_PREFIX}${safeId}.json`;
}

/* ------------------------------------------------------------------ *
 * 服务端文件读写
 *
 * 原语已抽到 src/utils/userFiles.js（剧本存储要用同一套，不能有第二份实现）。
 * 这里只留收藏侧的两个薄封装：它们是本模块的对外 API，且要给失败信息带上
 * 「收藏文件」这个措辞，好让日志能分辨是哪个 store 出的问题。
 * ------------------------------------------------------------------ */

/**
 * 删除一个正文文件。
 * @param {string} filePath
 * @returns {Promise<boolean>} 文件已不存在也算成功
 */
export function deleteFavFile(filePath) {
    return deleteUserFile(filePath, { label: "收藏文件" });
}

/**
 * 批量确认文件是否真的存在于磁盘上。
 * 这是「写完回头检查」的唯一手段：上传接口返回 200 只说明请求被接受了。
 * @param {string[]} filePaths
 * @returns {Promise<Record<string, boolean>>}
 */
export function verifyFavFiles(filePaths) {
    return verifyUserFiles(filePaths, { label: "收藏文件" });
}

/* ------------------------------------------------------------------ *
 * 正文与索引的结构
 * ------------------------------------------------------------------ */

/**
 * 组装正文文件的内容。
 *
 * 分组（chain）收藏：只存 items，不存合并后的 html。
 * 依据是 favsWindow.js 的 getChainDisplayHtml() 一律优先按 items 重建，
 * 已存的 html 只在 items 缺失时才会被读到 —— 实测 22 条 chain 收藏
 * 的 items 全部完整，那 1.298 MB 的 html 当前没有任何代码路径会读。
 * 但 items 不完整时必须把 html 一起留下，否则正文就真没了。
 *
 * @param {object} fav
 * @returns {object}
 */
export function buildFavBody(fav) {
    const type = fav?.type === "chain" ? "chain" : "plain";
    const body = { v: FAV_BODY_VERSION, id: fav?.id, type };

    if (type === "chain") {
        const items = Array.isArray(fav?.items) ? fav.items : [];
        const rebuildable = items.length > 0 && items.every(seg => String(seg?.html || "").trim());
        body.items = items;
        if (!rebuildable) body.html = String(fav?.html || "");
    } else {
        body.html = String(fav?.html || "");
    }

    return body;
}

/** 与 favsWindow.js 建 charIndex 时的口径保持一致：优先独立字段，退回从标题解析 */
function resolveFavMeta(fav) {
    if (fav?.charName) {
        const title = String(fav?.title || "");
        return {
            char: String(fav.charName),
            script: String(fav.scriptName || title.split(" - ")[0] || title)
        };
    }
    return parseMeta(String(fav?.title || ""));
}

/**
 * 剥掉会触发资源加载的**空元素**，再交给 getSnippet。
 *
 * 为什么必须剥：getSnippet 内部是 `div.innerHTML = html`，浏览器即使对游离节点
 * 也会真的去拉 <img src>。实测收藏正文里有 126 个外链 <img>，
 * 一次全量迁移会凭空向第三方发出 126 个请求。
 *
 * 为什么摘要文本不会因此改变：这里只剥 HTML 规范定义的空元素 —— 解析器不给它们
 * 任何子节点，所以它们对 textContent 的贡献恒为空，剥掉前后 textContent 完全相同
 * （替换成空串而非空格，否则 `a<img>b` 会从 "ab" 变成 "a b"）。
 *
 * 为什么刻意不剥 <script>：script 的内容**算进** textContent，剥掉会真的改变摘要，
 * 进而改变搜索命中结果。innerHTML 本身不执行 script，所以留着没有安全问题。
 *
 * 属性值里可能出现 `>`，所以正则要跳过引号包裹的片段。
 */
const VOID_RESOURCE_TAG_RE = /<(?:img|link|input|source|track|embed|base)\b(?:"[^"]*"|'[^']*'|[^>])*>/gi;

function stripVoidResourceTags(html) {
    return String(html || "").replace(VOID_RESOURCE_TAG_RE, "");
}

/** 卡片摘要只取正文，不混入生成指令 —— 与 favsWindow.js 的 getCachedSnippet 同口径 */
function computeSnippetText(fav) {
    const isChain = fav?.type === "chain";
    const items = Array.isArray(fav?.items) ? fav.items : [];
    const chainSource = isChain
        ? items.map(seg => String(seg?.html || "").trim()).filter(Boolean).join("\n")
        : "";
    const source = isChain ? (chainSource || String(fav?.html || "")) : String(fav?.html || "");
    return getSnippet(stripVoidResourceTags(source));
}

/** 指令文本不进摘要，但要能被搜索命中 —— 与 favsWindow.js 的 getChainInstructionText 同口径 */
function computeInstructionText(fav) {
    if (fav?.type !== "chain" || !Array.isArray(fav?.items)) return "";
    return fav.items
        .map(seg => String(seg?.instruction || "").trim())
        .filter(Boolean)
        .join(" ");
}

/**
 * 组装索引条目。
 * 必须自带收藏夹「列表 / 搜索 / 筛选 / 去重 / 删除」所需的全部字段，
 * 否则那些操作就得回头去读正文文件，等于白搬。
 * 对应 favsWindow.js 的 getCachedSearchText（title / script / char / snippet / instruction）
 * 与 charIndex、chainSignature 去重。
 *
 * @param {object} fav
 * @param {{file?: string, rev?: number, bytes?: number}} [pointer]
 * @returns {object}
 */
export function buildFavIndexEntry(fav, pointer = {}) {
    const meta = resolveFavMeta(fav);
    return {
        id: fav?.id,
        type: fav?.type === "chain" ? "chain" : "plain",
        title: String(fav?.title || ""),
        charName: meta.char,
        scriptName: meta.script,
        scriptId: String(fav?.scriptId || ""),
        date: String(fav?.date || ""),
        avatar: String(fav?.avatar || ""),
        branchKey: String(fav?.branchKey || ""),
        chainSignature: String(fav?.chainSignature || ""),
        itemCount: Array.isArray(fav?.items) ? fav.items.length : 0,
        snippetText: computeSnippetText(fav),
        instructionText: computeInstructionText(fav),
        file: String(pointer.file || ""),
        rev: Number(pointer.rev) || 1,
        bytes: Number(pointer.bytes) || 0
    };
}

/**
 * 把一条收藏的正文写成文件。
 * @param {object} fav
 * @param {number} [rev] 版本号，用于读取时破缓存
 * @returns {Promise<{file: string, bytes: number, rev: number, text: string}>}
 */
export async function writeFavBody(fav, rev = 1) {
    const body = buildFavBody(fav);
    const text = JSON.stringify(body);
    const file = await uploadTextFile(favFileName(fav?.id), text);
    return { file, bytes: utf8ByteLength(text), rev: Number(rev) || 1, text };
}

/**
 * 按索引条目读回正文。
 * 会核对文件里的 id / 版本，读到张冠李戴的内容要立刻报错而不是照样渲染。
 * @param {object} indexEntry
 * @returns {Promise<object>}
 */
export async function readFavBody(indexEntry) {
    const filePath = String(indexEntry?.file || "").trim();
    if (!filePath) throw new Error(`收藏 ${indexEntry?.id} 的索引里没有文件路径`);

    const raw = await fetchTextFile(filePath, Number(indexEntry?.rev) || 0);

    let body;
    try {
        body = JSON.parse(raw);
    } catch (e) {
        throw new Error(`收藏 ${indexEntry?.id} 的正文文件不是合法 JSON：${filePath}`);
    }

    if (Number(body?.v) !== FAV_BODY_VERSION) {
        throw new Error(`收藏 ${indexEntry?.id} 的正文版本不受支持：${body?.v}`);
    }
    if (String(body?.id) !== String(indexEntry?.id)) {
        throw new Error(`收藏 ${indexEntry?.id} 的正文文件 id 不匹配（文件里是 ${body?.id}）`);
    }

    return body;
}

/* ------------------------------------------------------------------ *
 * 试运行搬家
 * ------------------------------------------------------------------ */

/** 报告当前收藏在 settings.json 里的占用，用于试运行前后对比 */
export function describeCurrentFavsFootprint() {
    const data = getExtData();
    const favs = Array.isArray(data.favs) ? data.favs : [];
    const bytes = utf8ByteLength(JSON.stringify(favs));
    const chainCount = favs.filter(f => f?.type === "chain").length;
    return {
        count: favs.length,
        chainCount,
        plainCount: favs.length - chainCount,
        bytes
    };
}

/**
 * 已搬家后的存储占用，**只读索引、零 HTTP 请求**。
 *
 * bodyBytes 由索引里每条的 bytes 累加得出（写入时记的真实字节数，
 * upsertFav 每次改正文都会刷新它），所以不必去挨个 HEAD 那 N 个文件。
 * 与 describeCurrentFavsFootprint() 的区别：那个算的是「settings.json 里旧数据还占多少」，
 * 这个算的是「搬完之后正文和索引各占多少」。
 *
 * @returns {{count:number, bodyBytes:number, indexBytes:number}|null} 未搬家返回 null
 */
export function describeFavsStorageFootprint() {
    const store = getFavsIndex();
    if (!store) return null;
    return {
        count: store.entries.length,
        bodyBytes: store.entries.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0),
        indexBytes: utf8ByteLength(JSON.stringify(store.entries))
    };
}

/* ------------------------------------------------------------------ *
 * 索引：住在 settings.json 里，是列表 / 搜索 / 筛选的唯一数据源
 *
 * 结构刻意用对象而非裸数组：键存在与否要能区分「还没搬家」和
 * 「搬完了但一条收藏都没有」。裸数组做不到这个区分。
 * ------------------------------------------------------------------ */

const FAVS_INDEX_VERSION = 1;

/** @returns {{version:number, migratedAt:number, entries:object[]}|null} 未搬家返回 null */
export function getFavsIndex() {
    const store = getExtData()[FAVS_INDEX_KEY];
    if (!store || typeof store !== "object" || !Array.isArray(store.entries)) return null;
    if (Number(store.version) !== FAVS_INDEX_VERSION) {
        TitaniaLogger.warn(`收藏索引版本不受支持：${store.version}，按未搬家处理`);
        return null;
    }
    return store;
}

/** 是否已经搬过家（收藏正文是否已在独立文件里） */
export function isFavsMigrated() {
    return getFavsIndex() !== null;
}

function writeFavsIndex(entries, migratedAt) {
    const data = getExtData();
    const previous = data[FAVS_INDEX_KEY];
    data[FAVS_INDEX_KEY] = {
        version: FAVS_INDEX_VERSION,
        migratedAt: Number(migratedAt) || Number(previous?.migratedAt) || Date.now(),
        entries
    };
    saveExtData();
}

/**
 * 全新安装（或收藏为零）时直接建一个空索引，让它天生就在文件存储上。
 *
 * 为什么需要：src/ui/favsWindow.js 的 putFav 在未搬家时走 legacy 分支，
 * 把收藏写进 settings.json。也就是说新装用户会从零开始重新积累同一个卡顿，
 * 直到自己注意到设置页那张卡片并点一次搬家。而 0 条收藏时建索引
 * 没有任何要校验或要删的东西，不存在不可逆动作，代价只是一次 saveExtData()。
 *
 * data.favs 刻意**不删**：defaultSettings.favs = []（src/config/defaults.js）
 * 会把它加回来，删了是白折腾。getLegacyFavs() 已经把「空数组 + 已搬家」
 * 判定成伪空、返回 null，写入路径因此自动走文件分支。
 *
 * @returns {boolean} 是否真的建了索引
 */
export function bootstrapEmptyFavsIndex() {
    if (isFavsMigrated()) return false;

    const favs = getExtData().favs;
    // 有收藏就不能走这条路：那属于真正的搬家，必须过备份 + 校验 + 人工确认
    if (Array.isArray(favs) && favs.length > 0) return false;

    writeFavsIndex([], Date.now());
    TitaniaLogger.info("收藏为零，已直接建立空索引（新增收藏将直接落文件存储）");
    return true;
}

/* ------------------------------------------------------------------ *
 * 供收藏夹使用的条目
 *
 * 关键设计：返回的对象**形状与旧的 fav 对象一致**，只是 html / items 先不填。
 * 这样收藏夹里所有同步读取 item.html 的既有代码在「补齐正文」之后
 * 一行都不用改，需要改的只有那几个消费正文的入口 —— 在读之前先 await 一下。
 *
 * _snippetText / _instructionText 直接用索引里的值预填：
 * favsWindow 的 getCachedSnippet / getChainInstructionText 一见到这两个字段
 * 是字符串就直接返回，于是列表和搜索全程不会碰正文。
 * ------------------------------------------------------------------ */

/**
 * 把索引条目摊成收藏夹能直接用的对象。
 * @param {object} entry
 * @returns {object}
 */
function toUiEntry(entry) {
    return {
        id: entry.id,
        type: entry.type === "chain" ? "chain" : "plain",
        title: String(entry.title || ""),
        charName: String(entry.charName || ""),
        scriptName: String(entry.scriptName || ""),
        scriptId: String(entry.scriptId || ""),
        date: String(entry.date || ""),
        avatar: String(entry.avatar || ""),
        branchKey: String(entry.branchKey || ""),
        chainSignature: String(entry.chainSignature || ""),
        itemCount: Number(entry.itemCount) || 0,
        // 预填这两个 memo 字段，列表与搜索就不必读正文
        _snippetText: String(entry.snippetText || ""),
        _instructionText: String(entry.instructionText || ""),
        // 正文指针；html / items 由 ensureFavBody 按需补齐
        _file: String(entry.file || ""),
        _rev: Number(entry.rev) || 1,
        _bytes: Number(entry.bytes) || 0,
        _bodyLoaded: false
    };
}

/**
 * 列出收藏夹要展示的条目。
 * @returns {object[]|null} 未搬家时返回 null，调用方应退回读 data.favs
 */
export function listFavsForUi() {
    const store = getFavsIndex();
    if (!store) return null;
    return store.entries.map(toUiEntry);
}

/**
 * 按需把正文补进条目。已补过或本来就带正文的直接返回。
 *
 * 读失败要抛错，不能静默当空内容 —— 否则用户会看到一个空白的收藏
 * 却以为内容真的丢了，进而去删掉它。
 *
 * @param {object} uiEntry
 * @returns {Promise<object>} 同一个对象（已就地补齐）
 */
export async function ensureFavBody(uiEntry) {
    if (!uiEntry) return uiEntry;
    if (uiEntry._bodyLoaded) return uiEntry;
    // 没有文件指针说明这是搬家前的旧对象，正文本来就在它自己身上（哪怕是空的）。
    // 这里不能抛错：历史上有过 html/items 都缺失的坏数据，以前是渲染成空白，
    // 突然改成报错会让本来还能打开的收藏打不开。
    if (!uiEntry._file) return uiEntry;

    const body = await readFavBody({ id: uiEntry.id, file: uiEntry._file, rev: uiEntry._rev });
    if (body.type === "chain") {
        uiEntry.items = Array.isArray(body.items) ? body.items : [];
        // 正文文件里通常不存合并后的 html（getChainDisplayHtml 会按 items 重建），
        // 只有 items 不完整的历史数据才带 html 兜底
        if (typeof body.html === "string") uiEntry.html = body.html;
    } else {
        uiEntry.html = String(body.html || "");
    }
    uiEntry._bodyLoaded = true;
    return uiEntry;
}

/**
 * 写入 / 更新一条收藏：正文落文件，元数据进索引。
 * rev 每次自增，读取时用它破缓存。
 *
 * @param {object} fav 完整的收藏对象（含 html / items）
 * @returns {Promise<object>} 新的索引条目
 */
export async function upsertFav(fav) {
    const store = getFavsIndex();
    if (!store) throw new Error("尚未搬家，upsertFav 不可用");

    const existingAt = store.entries.findIndex(entry => String(entry.id) === String(fav?.id));
    const nextRev = existingAt >= 0 ? (Number(store.entries[existingAt].rev) || 1) + 1 : 1;

    const written = await writeFavBody(fav, nextRev);
    const entry = buildFavIndexEntry(fav, { file: written.file, rev: written.rev, bytes: written.bytes });

    const entries = [...store.entries];
    if (existingAt >= 0) entries[existingAt] = entry;
    else entries.unshift(entry);   // 与 data.favs.unshift 一致：最新的在最前

    writeFavsIndex(entries, store.migratedAt);
    return entry;
}

/**
 * 只改索引里的元数据字段，不动正文文件（例如重命名标题）。
 * @param {string|number} id
 * @param {object} patch
 * @returns {object|null} 更新后的索引条目
 */
export function patchFavIndexEntry(id, patch = {}) {
    const store = getFavsIndex();
    if (!store) return null;

    const at = store.entries.findIndex(entry => String(entry.id) === String(id));
    if (at < 0) return null;

    // file / rev / bytes 是正文指针，只能由 upsertFav 改
    const { file, rev, bytes, id: _ignoredId, ...safePatch } = patch;
    const entries = [...store.entries];
    entries[at] = { ...entries[at], ...safePatch };
    writeFavsIndex(entries, store.migratedAt);
    return entries[at];
}

/**
 * 删除若干条收藏：先从索引摘掉再删文件。
 *
 * 顺序是刻意的 —— 索引先落盘，即使随后删文件失败，最坏结果是磁盘上留几个
 * 没人引用的孤儿文件（占点空间，不影响使用）。反过来先删文件的话，
 * 一旦索引没保存成功，索引就会指向已经不存在的文件，收藏夹直接报错。
 *
 * @param {Array<string|number>} ids
 * @returns {Promise<{removed:number, fileDeleteFailed:number}>}
 */
export async function removeFavsByIds(ids) {
    const store = getFavsIndex();
    if (!store) throw new Error("尚未搬家，removeFavsByIds 不可用");

    const targets = new Set((Array.isArray(ids) ? ids : []).map(id => String(id)));
    if (targets.size === 0) return { removed: 0, fileDeleteFailed: 0 };

    const removedEntries = store.entries.filter(entry => targets.has(String(entry.id)));
    const keptEntries = store.entries.filter(entry => !targets.has(String(entry.id)));

    writeFavsIndex(keptEntries, store.migratedAt);

    let fileDeleteFailed = 0;
    for (const entry of removedEntries) {
        const ok = await deleteFavFile(entry.file);
        if (!ok) fileDeleteFailed++;
    }

    return { removed: removedEntries.length, fileDeleteFailed };
}

/* ------------------------------------------------------------------ *
 * 正式搬家
 * ------------------------------------------------------------------ */

/**
 * 正式搬家：写正文文件 → 逐个校验落盘 → 写索引。
 *
 * **刻意不删 data.favs。** 这一步做完，磁盘和 settings.json 里各有一份完整数据，
 * 退回上个插件版本就能原样回到搬家前的状态。删除留到下一个提交，
 * 由用户确认收藏夹一切正常之后再做。
 *
 * 任何一条正文写失败、或校验发现缺文件，就整体放弃写索引 —— 宁可什么都没变，
 * 也不要留下一个指向缺失文件的半截索引。
 *
 * @param {{onProgress?: (done:number, total:number) => void}} [options]
 * @returns {Promise<object>} 搬家报告
 */
export async function migrateFavsToFiles(options = {}) {
    const startedAt = Date.now();
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

    if (isFavsMigrated()) {
        return { ok: false, alreadyMigrated: true, reason: "收藏已经搬过家了" };
    }

    const data = getExtData();
    const favs = Array.isArray(data.favs) ? data.favs : [];
    const footprint = describeCurrentFavsFootprint();

    const records = [];
    const failures = [];

    for (let i = 0; i < favs.length; i++) {
        const fav = favs[i];
        try {
            records.push({ fav, written: await writeFavBody(fav, 1) });
        } catch (e) {
            failures.push({ id: fav?.id, title: String(fav?.title || ""), error: e?.message || String(e) });
            TitaniaLogger.error(`搬家：收藏 ${fav?.id} 写入失败`, e);
        }
        if (onProgress) onProgress(i + 1, favs.length);
    }

    const entries = records.map(({ fav, written }) => buildFavIndexEntry(fav, {
        file: written.file,
        rev: written.rev,
        bytes: written.bytes
    }));

    let missing = [];
    let verifyError = null;
    try {
        const verifyResult = await verifyFavFiles(entries.map(entry => entry.file));
        missing = Object.entries(verifyResult).filter(([, exists]) => !exists).map(([path]) => path);
    } catch (e) {
        verifyError = e?.message || String(e);
        TitaniaLogger.error("搬家：文件校验请求失败", e);
    }

    const blockers = [];
    if (failures.length) blockers.push(`${failures.length} 条正文写入失败`);
    if (missing.length) blockers.push(`${missing.length} 个文件校验时不存在`);
    if (verifyError) blockers.push(`校验请求出错（${verifyError}）`);

    if (blockers.length) {
        TitaniaLogger.error("搬家中止，未写入索引", { failures, missing, verifyError });
        return {
            ok: false,
            aborted: true,
            reason: blockers.join("；"),
            settings: footprint,
            failures,
            missing,
            verifyError,
            durationMs: Date.now() - startedAt
        };
    }

    writeFavsIndex(entries, Date.now());

    const bytesList = records.map(r => r.written.bytes);
    const report = {
        ok: true,
        settings: footprint,
        written: {
            count: entries.length,
            bytesTotal: bytesList.reduce((sum, n) => sum + n, 0),
            bytesMax: bytesList.length ? Math.max(...bytesList) : 0
        },
        indexBytes: utf8ByteLength(JSON.stringify(entries)),
        pendingRemovalBytes: footprint.bytes,
        durationMs: Date.now() - startedAt
    };
    TitaniaLogger.info("收藏搬家完成（旧数据仍保留）", report);
    return report;
}

/* ------------------------------------------------------------------ *
 * 完整对象读取：写入路径与备份导出需要「索引条目 + 正文」拼回来的完整 fav
 * ------------------------------------------------------------------ */

/** 索引条目 + 正文 → 与搬家前形状一致的完整 fav 对象 */
function assembleFav(entry, body) {
    const fav = {
        id: entry.id,
        type: entry.type,
        title: String(entry.title || ""),
        charName: String(entry.charName || ""),
        scriptName: String(entry.scriptName || ""),
        scriptId: String(entry.scriptId || ""),
        date: String(entry.date || ""),
        avatar: String(entry.avatar || "")
    };
    if (entry.type === "chain") {
        fav.branchKey = String(entry.branchKey || "");
        fav.chainSignature = String(entry.chainSignature || "");
        fav.items = Array.isArray(body?.items) ? body.items : [];
        // 搬家前 chain 也存一份合并 html。只有 items 不完整的历史数据才留了它；
        // items 完整时由 favsWindow 的 getChainDisplayHtml 实时重建，不必回填。
        if (typeof body?.html === "string") fav.html = body.html;
    } else {
        fav.html = String(body?.html || "");
    }
    return fav;
}

/**
 * 按 id 取完整收藏（含正文）。写入路径要先拿到完整对象才能改。
 * @param {string|number} id
 * @returns {Promise<object|null>}
 */
export async function getFullFavById(id) {
    const store = getFavsIndex();
    if (!store) return null;
    const entry = store.entries.find(item => String(item.id) === String(id));
    if (!entry) return null;
    return assembleFav(entry, await readFavBody(entry));
}

/**
 * 把全部收藏拼回搬家前的数组形状，供备份导出使用。
 *
 * 任何一条正文读不出来就整体抛错 —— 备份宁可失败，也绝不能悄悄导出一份缺内容的。
 * @param {{onProgress?: (done:number, total:number) => void}} [options]
 * @returns {Promise<object[]>}
 */
export async function exportFavsAsLegacyArray(options = {}) {
    const store = getFavsIndex();
    if (!store) throw new Error("尚未搬家，无需从文件重建收藏数组");

    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const total = store.entries.length;
    const result = [];

    for (let i = 0; i < total; i++) {
        const entry = store.entries[i];
        try {
            result.push(assembleFav(entry, await readFavBody(entry)));
        } catch (e) {
            throw new Error(`收藏「${entry.title || entry.id}」的正文读取失败，备份已中止：${e?.message || String(e)}`);
        }
        if (onProgress) onProgress(i + 1, total);
    }
    return result;
}

/* ------------------------------------------------------------------ *
 * 收尾：删掉 settings.json 里的旧收藏数据
 * ------------------------------------------------------------------ */

/**
 * 全量核对：文件是否都在、正文能不能读回来、读回来的内容与 data.favs 是否逐字一致。
 *
 * 这里刻意做**全量**而非抽样。删除是不可逆的，抽样只能证明「抽到的那几条没问题」。
 * 代价是 N 次请求，但这是一次性操作。
 *
 * @param {{onProgress?: (done:number, total:number) => void}} [options]
 * @returns {Promise<{ok:boolean, checked:number, problems:string[]}>}
 */
async function verifyMigrationAgainstLegacy(options = {}) {
    const store = getFavsIndex();
    if (!store) return { ok: false, checked: 0, problems: ["尚未搬家，没有可核对的索引"] };

    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const legacy = Array.isArray(getExtData().favs) ? getExtData().favs : [];
    const problems = [];

    if (legacy.length === 0) {
        return { ok: false, checked: 0, problems: ["settings.json 里已经没有旧收藏数据了"] };
    }
    if (legacy.length !== store.entries.length) {
        problems.push(`条数不一致：索引 ${store.entries.length} 条，settings.json 里 ${legacy.length} 条`);
    }

    // 先一次性确认文件都在，省掉逐条试读的往返
    try {
        const verifyResult = await verifyFavFiles(store.entries.map(entry => entry.file));
        const missing = Object.entries(verifyResult).filter(([, exists]) => !exists).map(([path]) => path);
        if (missing.length) problems.push(`${missing.length} 个正文文件不存在：${missing.slice(0, 3).join("、")}${missing.length > 3 ? " …" : ""}`);
    } catch (e) {
        problems.push(`文件校验请求失败：${e?.message || String(e)}`);
    }

    // 文件层面就有问题时不必再逐条读，直接判失败
    if (problems.length) return { ok: false, checked: 0, problems };

    const legacyById = new Map(legacy.map(fav => [String(fav?.id), fav]));
    let checked = 0;

    for (const entry of store.entries) {
        const original = legacyById.get(String(entry.id));
        if (!original) {
            problems.push(`索引里的 ${entry.id} 在 settings.json 里找不到对应收藏`);
            continue;
        }
        try {
            const body = await readFavBody(entry);
            // 与写入时同一套推导，所以这里比对的是「重新写一遍会得到什么」
            const expected = JSON.stringify(buildFavBody(original));
            if (JSON.stringify(body) !== expected) {
                problems.push(`收藏「${entry.title || entry.id}」的正文与 settings.json 里的不一致`);
            }
        } catch (e) {
            problems.push(`收藏「${entry.title || entry.id}」正文读取失败：${e?.message || String(e)}`);
        }
        checked++;
        if (onProgress) onProgress(checked, store.entries.length);
        // 问题太多就不必继续刷了，足以判定失败
        if (problems.length >= 10) break;
    }

    return { ok: problems.length === 0, checked, problems };
}

/**
 * 删掉 settings.json 里的旧收藏数据。**必须先通过全量核对。**
 * 这是整个搬家里唯一不可逆的一步，也是 settings.json 真正瘦下来的那一步。
 *
 * options.confirmBeforeDelete 是给 UI 层插人工闸门用的：核对通过之后、真删之前
 * await 它一次，返回假就一个字都不删。刻意做成回调而不是「让 UI 先自己核对一遍再调本函数」——
 * 后者会让 N 条各发两轮请求，而且「删除前必须全量核对通过」这条不变量就跑到 UI 层去了，
 * 从此谁都能绕过它。回调参数在本文件是既有模式（onProgress 同理）。
 *
 * @param {{onProgress?: (done:number, total:number) => void,
 *          confirmBeforeDelete?: (verification: {checked:number}) => boolean|Promise<boolean>}} [options]
 * @returns {Promise<{ok:boolean, removedBytes:number, cancelled?:boolean, problems?:string[]}>}
 */
export async function dropLegacyFavs(options = {}) {
    const verification = await verifyMigrationAgainstLegacy(options);
    if (!verification.ok) {
        return { ok: false, removedBytes: 0, problems: verification.problems };
    }

    if (typeof options.confirmBeforeDelete === "function") {
        const proceed = await options.confirmBeforeDelete(verification);
        if (!proceed) {
            TitaniaLogger.info("核对已通过，但用户在删除前取消，旧数据保留");
            return { ok: false, removedBytes: 0, cancelled: true, checked: verification.checked };
        }
    }

    const data = getExtData();
    const removedBytes = utf8ByteLength(JSON.stringify(data.favs || []));
    delete data.favs;
    saveExtData();

    TitaniaLogger.info(`旧收藏数据已删除，settings.json 减少约 ${removedBytes} 字节`);
    return { ok: true, removedBytes, checked: verification.checked };
}

/* ------------------------------------------------------------------ *
 * 清理历史遗留：零引用的旧键 + 无人引用的正文文件
 * ------------------------------------------------------------------ */

/**
 * settings.json 里零引用的旧键。
 * 每一个都用 `grep -rl <key> src/` 逐个确认过：当前代码里没有任何地方读写它们
 * （favs_meta 仅出现在本文件的说明注释里，不是代码引用）。
 *
 * favs_meta / favs_migrated_at 是 2026-08-08 那次**未完成**的迁移留下的：
 * 当时正文文件写出去了、索引也建了，但读写它们的代码从未进入仓库，
 * 且 data.favs 一直没删，于是同一份数据存了两份。它们已被 favs_index 取代。
 */
const ORPHAN_SETTINGS_KEYS = [
    "favs_meta",
    "favs_migrated_at",
    "lore_extractor_config",
    "float_style",
    "custom_style",
    "story_outline_st_api_key",
    "story_outline_profile_mode",
    "last_seen_version",
    "ignored_version",
    "welcomed",
    "theater_model_override",
    // `scripts` 是极早期版本存内置预设的地方（旧 schema：mode / isPreset /
    // 驼峰 createdAt / updatedAt），与后来的 user_scripts 无关、id 也无交集。
    // 实测这份残留 20 条、9.7 KB，逐条核对结论：
    //   · 20 条 id 全部命中当前 src/config/presets.js 的 DEFAULT_PRESETS（20 条）
    //   · 其中 isPreset=false（即被用户改过）的有 0 条
    // 所以它是内置预设的陈旧副本，没有任何独有内容，删掉不会失去用户数据。
    //
    // ⚠ 本键的零引用**不能**用上面那句 `grep -rl scripts src/` 验证 —— 名字太泛，
    //   会命中 user_scripts / runtimeScripts / scriptStore / parsed.scripts 一大片。
    //   实际用的是精确形态：`data\.scripts\b`、`getExtData()\.scripts\b`、
    //   `["scripts"]`、`['scripts']`，四种全库均为 0 命中。
    // ⚠ 精确匹配，不会碰到新的 scripts_store 指针键（那个仍在使用中）。
    "scripts"
];

/** 从旧索引 favs_meta 里找出「已不被 favs_index 引用」的正文文件 */
function findOrphanFavFiles() {
    const data = getExtData();
    const legacyMeta = Array.isArray(data.favs_meta) ? data.favs_meta : [];
    const store = getFavsIndex();
    const live = new Set((store?.entries || []).map(entry => String(entry.file || "")));

    const orphans = [];
    for (const entry of legacyMeta) {
        const file = String(entry?.file || "").trim();
        if (!file) continue;
        // favs_meta 里存的是裸文件名，favs_index 里是 /user/files/xxx 形式，统一成后者比对
        const path = file.startsWith("/") ? file : `/user/files/${file}`;
        if (!live.has(path) && !orphans.includes(path)) orphans.push(path);
    }
    return orphans;
}

/** 预演：报告将要清理什么，不做任何改动 */
export function describeLegacyArtifacts() {
    const data = getExtData();
    const keys = ORPHAN_SETTINGS_KEYS
        .filter(key => Object.prototype.hasOwnProperty.call(data, key))
        .map(key => ({ key, bytes: utf8ByteLength(JSON.stringify(data[key])) }));
    return {
        keys,
        keyBytes: keys.reduce((sum, item) => sum + item.bytes, 0),
        orphanFiles: findOrphanFavFiles()
    };
}

/**
 * 清理遗留数据。
 *
 * 顺序是刻意的：先删孤儿文件，再删键。
 * 因为 favs_meta 是定位那些孤儿文件的**唯一线索**（客户端没有列目录的接口），
 * 一旦先把它删了，删不掉的孤儿就再也找不回来了。所以文件没删成功就保留 favs_meta。
 *
 * @returns {Promise<object>}
 */
export async function cleanupLegacyArtifacts() {
    const plan = describeLegacyArtifacts();
    const deletedFiles = [];
    const failedFiles = [];

    for (const path of plan.orphanFiles) {
        if (await deleteFavFile(path)) deletedFiles.push(path);
        else failedFiles.push(path);
    }

    const data = getExtData();
    const removedKeys = [];
    let removedBytes = 0;

    for (const item of plan.keys) {
        // 有孤儿文件没删掉时保住 favs_meta，否则就永久失去定位它们的线索
        if (item.key === "favs_meta" && failedFiles.length > 0) continue;
        delete data[item.key];
        removedKeys.push(item.key);
        removedBytes += item.bytes;
    }

    if (removedKeys.length > 0) saveExtData();

    const report = { removedKeys, removedBytes, deletedFiles, failedFiles };
    TitaniaLogger.info("遗留数据清理完成", report);
    return report;
}
