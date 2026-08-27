// entry.js - 打包入口点
// 打包后会生成根目录的 index.js

// --- ST 核心模块引用 ---
// 注意：这些路径在打包时会被标记为 external
// 路径相对于打包后的 index.js 位置（根目录）
import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

// --- 内部模块引用 ---
import { extensionName, defaultSettings, extensionFolderPath, LEGACY_KEYS, CURRENT_VERSION } from "./config/defaults.js";
import { getExtData, saveExtData, saveExtDataImmediate } from "./utils/storage.js";
import { loadCssFiles } from "./utils/dom.js";
import { escapeHtml } from "./utils/helpers.js";
import { GlobalState } from "./core/state.js";
import { loadScripts } from "./core/scriptData.js";
import { handleGenerate } from "./core/api.js";
import { restoreContinuationForCurrentChat } from "./core/continuationStore.js";
import {
    migrateFavsToFiles,
    isFavsMigrated,
    bootstrapEmptyFavsIndex,
    getFavsIndex,
    verifyFavFiles,
    describeCurrentFavsFootprint,
    describeFavsStorageFootprint,
    exportFavsAsLegacyArray,
    dropLegacyFavs,
    describeLegacyArtifacts,
    cleanupLegacyArtifacts,
    FAVS_INDEX_KEY
} from "./core/favsStore.js";
import {
    isScriptsMigrated,
    hydrateScripts,
    bootstrapEmptyScriptsStore,
    migrateScriptsToFiles,
    dryRunScriptsMigration,
    dropLegacyScripts,
    exportScriptsAsLegacyArray,
    flushScriptsNow,
    setScripts,
    describeCurrentScriptsFootprint,
    describeScriptsStorageFootprint,
    getHydrationError as getScriptsHydrationError,
    getLastWriteError as getScriptsLastWriteError,
    SCRIPTS_FILE_NAME,
    SCRIPTS_STORE_KEY
} from "./core/scriptStore.js";
import { initExtensionUpdate } from "./core/extensionUpdate.js";
import { initSyncListener } from "./core/worldInfoManager.js";
import { createFloatingButton, destroyFloatingButton, refreshFloatingTuck } from "./ui/floatingBtn.js";
import { applyCustomCSS, applyFontSettings, applyUIFontScale } from "./ui/settingsWindow.js";
import { applyUITheme } from "./ui/theme.js";
import { initOutlineEntryButton } from "./ui/outlineEntryButton.js";
import { initRewriteEntryButton, refreshRewriteEntryButton } from "./ui/rewriteEntryButton.js";
import { initChatInjectButton, refreshChatInjectButton } from "./ui/chatInjectButton.js";
import { isInjectedTheaterMessage } from "./core/chatInjector.js";
import { refreshOutlineEntryButton } from "./ui/outlineEntryButton.js";
import {
    checkUnsavedVectors,
    hasUnsavedVectorsSync,
    refreshUnsavedVectorsCache,
    isUnsavedCacheInitialized,
    getAllIndexedCharacters,
    exportVectors,
    importVectors,
    clearCharacterVectors
} from "./core/vectorStore.js";
import { incrementAutoVectorizeCounter, getAutoVectorizeConfig } from "./core/summarizer.js";

// --- 自动化监听逻辑 ---

/**
 * 监听生成结束事件，根据策略触发自动演绎
 */
async function onGenerationEnded() {
    const extData = getExtData();
    const cfg = extData.config || {};

    // 1. 基础开关检查（只检查 auto_generate 开关，不再检查悬浮球开关）
    if (!cfg.auto_generate) return;

    // 2. 状态检查：如果正在通过本插件生成，则忽略（防止死循环）
    if (GlobalState.isGenerating || $("#t-overlay").length > 0) return;

    // 3. 获取当前聊天上下文的最后一条消息
    if (!SillyTavern || !SillyTavern.getContext) return;
    const context = SillyTavern.getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) return;
    const lastMsg = chat[chat.length - 1];

    // 4. 严格过滤：不是用户发的、不是系统指令、不是隐藏消息
    if (lastMsg.is_user) return;
    if (lastMsg.is_system) return;
    if (lastMsg.is_hidden) return;
    // 插件自己注入的小剧场不该再触发一轮自动演绎
    if (isInjectedTheaterMessage(lastMsg)) return;

    // 5. 概率检查
    const chance = cfg.auto_chance || 50;
    if (Math.random() * 100 > chance) return;

    // --- 核心修改：新的策略池构建逻辑 ---

    // 辅助：获取剧本的统一分类名
    const getCat = (s) => s.category || (s._type === 'preset' ? '官方预设' : '未分类');

    let pool = [];
    const autoMode = cfg.auto_mode || "random"; // 'random' 或 'category'

    if (autoMode === 'category') {
        // 【策略B：指定分类白名单】
        // 获取用户勾选的分类列表 (数组)
        const allowedCats = cfg.auto_categories || [];

        if (allowedCats.length === 0) {
            console.log("Titania Auto: Category mode selected but whitelist is empty.");
            return;
        }

        // 筛选出属于白名单分类的剧本
        pool = GlobalState.runtimeScripts.filter(s => allowedCats.includes(getCat(s)));

    } else {
        // 【策略A：随机抽取全部剧本】
        // 从所有可用剧本中随机选择
        pool = GlobalState.runtimeScripts;
    }

    // 6. 执行抽取
    if (pool.length === 0) return;
    const randomScript = pool[Math.floor(Math.random() * pool.length)];

    console.log(`Titania Auto: Triggered [${autoMode}] -> Use script: ${randomScript.name}`);

    // 延迟执行
    setTimeout(() => {
        handleGenerate(randomScript.id, true);
    }, 500);
}

// --- 初始化与销毁 ---

/**
 * 核心功能初始化（始终执行，不受悬浮球开关影响）
 * - 数据迁移
 * - 加载剧本
 * - 应用自定义样式
 * - 监听自动演绎事件
 */
function initCoreFeatures() {
    console.log(`Titania Echo v${CURRENT_VERSION}: Core initialized.`);

    // 自动迁移逻辑 (从 v3 迁移到 v4)
    const extData = getExtData();
    // 检查是否有配置，如果没有且本地存储有旧版 Key，则尝试迁移
    if ((!extData.config || Object.keys(extData.config).length === 0) && localStorage.getItem(LEGACY_KEYS.CFG)) {
        try {
            console.log("Titania: Migrating legacy data...");
            const oldCfg = JSON.parse(localStorage.getItem(LEGACY_KEYS.CFG));
            const oldScripts = JSON.parse(localStorage.getItem(LEGACY_KEYS.SCRIPTS));
            const oldFavs = JSON.parse(localStorage.getItem(LEGACY_KEYS.FAVS));

            let migrated = false;
            if (oldCfg) { extData.config = oldCfg; migrated = true; }
            // ⚠ 剧本必须走 setScripts()，不能直接写 extData.user_scripts。
            //   顺序上 loadExtensionSettings() 已经先跑过 bootstrapEmptyScriptsStore()：
            //   一个 v3 老安装此刻 user_scripts 是空的，于是空文件存储已经建好、
            //   读取来源已切到文件缓存。这时候直接写 extData.user_scripts，
            //   剧本会被写进 settings 却永远读不出来（缓存是空数组）。
            //   setScripts() 会落到当前真正的存储上，搬没搬家都对。
            if (oldScripts) { setScripts(oldScripts); migrated = true; }
            if (oldFavs) { extData.favs = oldFavs; migrated = true; }

            if (migrated) {
                saveExtData();
                if (window.toastr) toastr.success("数据已迁移至服务端", "Titania Echo");
            }
        } catch (e) { console.error("Titania: Migration failed", e); }
    }

    // 加载剧本数据
    loadScripts();

    // 加载队列配置到运行时状态
    loadQueueConfig();

    // 应用自定义 CSS
    if (extData.custom_css) {
        applyCustomCSS(extData.custom_css);
    }

    // 应用字体设置
    if (extData.font_settings) {
        applyFontSettings(extData.font_settings);
    }

    // 应用 UI 字体缩放（不影响内容区）
    applyUIFontScale(extData.appearance?.ui_font_scale);
    applyUITheme(extData.appearance?.ui_theme);

    // 监听生成结束事件（自动演绎）
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        void restoreContinuationForCurrentChat().catch(error => console.error("Titania: 续写历史恢复失败", error));
    });
    void restoreContinuationForCurrentChat().catch(error => console.error("Titania: 初始续写历史恢复失败", error));

    // 初始化世界书同步监听器
    initSyncListener();

    // 初始化向量索引未保存提醒
    initVectorUnsavedWarning();

    // 初始化自动向量化监听
    initAutoVectorizeListener();

    // 初始化大纲发送区入口按钮
    initOutlineEntryButton();

    // 初始化文本改写快捷栏入口按钮
    initRewriteEntryButton();

    // 初始化消息气泡上的小剧场注入入口
    initChatInjectButton();
}

/**
 * 加载队列配置到运行时状态
 * 在插件启动时执行，恢复用户上次的队列设置
 */
function loadQueueConfig() {
    try {
        const extData = getExtData();
        const queueCfg = extData.queue_config;

        if (queueCfg) {
            // 恢复队列设置到 GlobalState
            GlobalState.queueState.mode = queueCfg.mode || 'random';
            GlobalState.queueState.count = queueCfg.count || 3;
            GlobalState.queueState.categoryFilter = queueCfg.categoryFilter || 'ALL';
            GlobalState.queueState.manualItems = queueCfg.manualItems || [];
            GlobalState.queueState.interval = queueCfg.interval || 2;

            // 注意：enabled 默认为 false，需要用户手动激活
            // 如果用户之前激活过，也恢复激活状态
            GlobalState.queueState.enabled = queueCfg.enabled === true;

            // 恢复历史容量设置
            if (queueCfg.historyMax) {
                GlobalState.sceneHistory.maxItems = queueCfg.historyMax;
            }

            console.log("Titania: 队列配置已加载", GlobalState.queueState);
        }
    } catch (e) {
        console.warn("Titania: 加载队列配置失败", e);
    }
}

/**
 * 初始化自动向量化监听器
 * 监听消息事件，根据配置自动触发向量化
 */
function initAutoVectorizeListener() {
    // 监听消息接收事件（AI 回复）
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageForAutoVectorize);

    // 监听消息发送事件（用户消息）
    eventSource.on(event_types.MESSAGE_SENT, onMessageForAutoVectorize);

    console.log("Titania: 自动向量化监听器已初始化");
}

/**
 * 消息事件处理函数 - 用于自动向量化
 */
async function onMessageForAutoVectorize() {
    const config = getAutoVectorizeConfig();

    // 检查是否启用自动向量化
    if (!config.enabled) return;

    // 获取当前角色 ID
    if (!SillyTavern || !SillyTavern.getContext) return;

    let characterId;
    try {
        const context = SillyTavern.getContext();
        characterId = context?.characterId?.toString();
    } catch (e) {
        console.warn("Titania: 获取角色 ID 失败", e);
        return;
    }

    if (!characterId) return;

    // 延迟执行，避免与其他操作冲突
    setTimeout(async () => {
        try {
            await incrementAutoVectorizeCounter(characterId);
        } catch (e) {
            console.warn("Titania: 自动向量化检查失败", e);
        }
    }, 1000);
}

/**
 * 初始化向量索引未保存提醒
 * 当页面关闭/刷新时，如果有未导出的向量数据，提示用户
 */
function initVectorUnsavedWarning() {
    // 提前异步预热一次缓存，beforeunload 中只做同步判断
    void refreshUnsavedVectorsCache();

    window.addEventListener("focus", () => {
        void refreshUnsavedVectorsCache();
    });

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            void refreshUnsavedVectorsCache();
        }
    });

    window.addEventListener('beforeunload', (e) => {
        // beforeunload 中必须同步判断，不能执行异步逻辑
        const hasUnsaved = hasUnsavedVectorsSync();

        if (!isUnsavedCacheInitialized()) {
            void refreshUnsavedVectorsCache();
        }

        if (hasUnsaved) {
            // 浏览器标准做法：设置 returnValue 触发确认弹窗
            e.preventDefault();
            e.returnValue = '您有未导出的向量索引数据，关闭页面后这些数据可能丢失。是否确定离开？';
            return e.returnValue;
        }
    });

    console.log("Titania: 向量索引未保存提醒已初始化");
}

/**
 * 显示悬浮球
 */
function showFloatingButton() {
    createFloatingButton();
    console.log("Titania: 悬浮球已显示");
}

/**
 * 隐藏悬浮球
 */
function hideFloatingButton() {
    destroyFloatingButton();
    console.log("Titania: 悬浮球已隐藏");
}

async function buildVectorBackupData() {
    const characterIds = await getAllIndexedCharacters();
    const characters = [];
    for (const characterId of characterIds) {
        try {
            const payload = await exportVectors(characterId);
            characters.push(payload);
        } catch (e) {
            console.warn(`Titania: 导出角色 ${characterId} 向量失败`, e);
        }
    }
    return {
        version: 1,
        characters
    };
}

function countVectorItems(vectorData) {
    if (!vectorData || !Array.isArray(vectorData.characters)) return { characters: 0, vectors: 0 };
    const characters = vectorData.characters.length;
    const vectors = vectorData.characters.reduce((sum, item) => sum + (Array.isArray(item?.vectors) ? item.vectors.length : 0), 0);
    return { characters, vectors };
}

async function createFullBackupPayload(options = {}) {
    const includeVectors = options.includeVectors !== false;

    // 剧本搬家后可能有改动还在落盘队列里。快照是从内存对象拷的，
    // 但先把队列清空能保证「备份里的内容 = 磁盘上的内容」，
    // 排查问题时少一个变量。落盘失败会抛错，宁可导不出备份也不给一份来源不明的。
    if (isScriptsMigrated()) {
        const flushed = await flushScriptsNow();
        if (!flushed) throw new Error("剧本尚未成功落盘，已中止备份导出。请先解决保存失败的问题。");
    }

    const extDataSnapshot = JSON.parse(JSON.stringify(getExtData()));

    // 搬家后收藏正文已不在 settings.json 里，快照只剩索引 —— 直接导出会得到
    // 一份没有正文的空壳备份。所以这里把正文从文件读回来，还原成搬家前的
    // favs 数组形状，并去掉索引：
    //   · 备份自成一体，不依赖 user/files 目录（ST 的自动备份不管那个目录）
    //   · 与旧版插件的备份格式互通，导入后落在「未搬家」状态，再搬一次即可
    // 任何一条正文读不出来，exportFavsAsLegacyArray 会抛错，备份整体失败 ——
    // 宁可导不出来，也不能悄悄给出一份缺内容的备份。
    if (isFavsMigrated()) {
        extDataSnapshot.favs = await exportFavsAsLegacyArray();
        delete extDataSnapshot[FAVS_INDEX_KEY];
    }

    // 剧本同理。搬家后 settings 里只剩指针，快照里的 user_scripts 在
    // 「收尾删除旧数据」之后会是空的 —— 必须从文件回填成旧数组形状。
    if (isScriptsMigrated()) {
        extDataSnapshot.user_scripts = exportScriptsAsLegacyArray();
        delete extDataSnapshot[SCRIPTS_STORE_KEY];
    }

    const vectorData = includeVectors ? await buildVectorBackupData() : { version: 1, characters: [] };
    return {
        type: "titania_theater_backup",
        version: "2.0",
        timestamp: new Date().toISOString(),
        auto_backup: options.autoBackup === true,
        data: extDataSnapshot,
        vectors: vectorData
    };
}

function downloadBackupPayload(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // revoke 刻意延后，不在同一 tick 里做：iOS Safari 的下载是异步启动的，
    // 同步撤销 blob URL 会让下载拿不到内容（几 MB 的备份尤其明显）。
    // 代价只是这个 blob 多活一分钟，刷新页面即释放
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * 下载之后必须把主线程交还给浏览器的那一小段等待。原因见 downloadBackupAndConfirm。
 * @returns {Promise<void>}
 */
function settleAfterDownload() {
    return new Promise(resolve => setTimeout(resolve, 1200));
}

/**
 * 下载备份，然后停下来等用户点确定，之后才允许继续做网络写入。
 *
 * 这个「停一下」不是礼貌，是必需的
 * -------------------------------
 * iOS Safari 对 <a download> 的支持是残的：点击 blob 链接会触发一次导航 /
 * 系统下载面板。文档一旦进入 unload 流程，这个文档之后发出的所有 fetch()
 * 都会被立刻拒掉，报错是 `TypeError: Load failed`（Safari 版的 Failed to fetch）。
 *
 * 实测一位 iPhone 用户（iOS 18.7 / Safari 26.6）的收藏搬家：备份下载之后
 * 107 条正文上传在**同一秒内全部瞬间失败**，107/107，服务端一个请求都没收到。
 * 桌面 Chrome / Firefox 的 <a download> 不会导航，所以同一段代码只在手机上炸。
 *
 * confirm() 一次解决三件事：
 *   · 给下载留出完成时间，页面的 unload 状态过去了
 *   · 用户点确定本身是一次新的用户手势，网络请求恢复正常
 *   · 备份是唯一的人工退路，本来就该让用户亲眼确认一次再往下走
 *
 * @param {object} payload 备份内容
 * @param {string} filename
 * @param {string} what 用在文案里的动作名，例如「搬家」「收尾」
 * @returns {Promise<boolean>} 用户是否确认继续
 */
async function downloadBackupAndConfirm(payload, filename, what) {
    downloadBackupPayload(payload, filename);
    await settleAfterDownload();

    return confirm(
        `备份已开始下载：\n${filename}\n\n`
        + `请先确认这个文件存好了（手机上一般在「文件」App 的「下载项」里），`
        + `它是${what}出问题时唯一的退路。\n\n`
        + `确定 = 继续${what}\n`
        + `取消 = 就此停下，什么都不改`
    );
}

function bindDrawerBackupControls() {
    $("#titania-backup-export").off("click").on("click", async function () {
        const $btn = $(this);
        const oldHtml = $btn.html();
        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 导出中...');
        try {
            const exportData = await createFullBackupPayload({ includeVectors: true });
            const filename = `titania_backup_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.json`;
            downloadBackupPayload(exportData, filename);
            const stats = countVectorItems(exportData.vectors);
            if (window.toastr) toastr.success(`备份已导出（向量角色 ${stats.characters}，向量条目 ${stats.vectors}）`, "Titania Echo");
        } catch (e) {
            console.error("Titania: 备份导出失败", e);
            if (window.toastr) toastr.error(e.message || "导出失败", "Titania Echo");
        } finally {
            $btn.prop("disabled", false).html(oldHtml);
        }
    });

    $("#titania-backup-import").off("click").on("click", () => {
        $("#titania-backup-file-input").click();
    });

    $("#titania-backup-file-input").off("change").on("change", async function () {
        const file = this.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const importData = JSON.parse(text);

            if (importData.type !== "titania_theater_backup") throw new Error("无效的备份文件格式");
            if (!importData.data || typeof importData.data !== "object") throw new Error("备份数据无效");

            const extDataPayload = importData.data;
            const importVectorsData = importData.vectors && typeof importData.vectors === "object"
                ? importData.vectors
                : { version: 1, characters: [] };
            const vectorStats = countVectorItems(importVectorsData);

            const confirmMsg = `确定要导入此备份吗？\n\n`
                + `备份时间: ${importData.timestamp || "未知"}\n`
                + `备份版本: ${String(importData.version || "1.0")}\n`
                + `用户脚本: ${(extDataPayload.user_scripts || []).length} 个\n`
                + `收藏内容: ${(extDataPayload.favs || []).length} 个\n`
                + `向量角色: ${vectorStats.characters} 个\n\n`
                + `✅ 导入前将自动下载当前数据备份\n`
                + `⚠️ 导入将覆盖当前所有设置！`;

            if (!confirm(confirmMsg)) return;

            try {
                const currentSnapshot = await createFullBackupPayload({ includeVectors: true, autoBackup: true });
                const filename = `titania_auto_backup_${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_")}.json`;
                downloadBackupPayload(currentSnapshot, filename);
                if (window.toastr) toastr.info("已自动备份当前数据，请保存下载的文件", "Titania Echo");
                // 下面 saveExtDataImmediate() 是真的网络写入，而且那时向量库已经清空了 ——
                // 在 iOS 上被下载导航掀掉的话，会停在「旧向量已删、新设置没存上」的半截状态。
                // 原因见 downloadBackupAndConfirm
                await settleAfterDownload();
            } catch (backupErr) {
                console.warn("Titania: 自动备份失败", backupErr);
                if (!confirm("⚠️ 自动备份失败！是否仍要继续导入？\n\n如果继续，当前数据可能无法恢复。")) {
                    return;
                }
            }

            const currentData = getExtData();
            Object.assign(currentData, extDataPayload);

            // 导入的备份若是搬家之前做的，它没有 favs_index。Object.assign 不会删除
            // 目标上多出来的键，于是旧索引会残留下来，指向的却是上一批收藏的正文文件。
            // 这里显式清掉，干净地退回「未搬家」状态，由用户重新搬一次。
            if (!Object.prototype.hasOwnProperty.call(extDataPayload, FAVS_INDEX_KEY)) {
                delete currentData[FAVS_INDEX_KEY];
            }

            // 剧本同理，而且更要紧：指针残留会让插件继续从**上一批**剧本的文件里读，
            // 而 user_scripts 已经被导入的备份覆盖 —— 用户会看到「导入成功但剧本没变」。
            // 清掉指针后干净退回「未搬家」状态，剧本从 user_scripts 读，再搬一次即可。
            if (!Object.prototype.hasOwnProperty.call(extDataPayload, SCRIPTS_STORE_KEY)) {
                delete currentData[SCRIPTS_STORE_KEY];
            }

            const existingVectorCharacters = await getAllIndexedCharacters();
            for (const charId of existingVectorCharacters) {
                await clearCharacterVectors(charId);
            }

            const backupVectorCharacters = Array.isArray(importVectorsData.characters) ? importVectorsData.characters : [];
            let importedVectorCount = 0;
            for (const item of backupVectorCharacters) {
                const charId = String(item?.characterId || "").trim();
                if (!charId) continue;
                const result = await importVectors(charId, item, false);
                importedVectorCount += Number(result?.imported || 0);
            }

            const saveSuccess = await saveExtDataImmediate();
            if (!saveSuccess) throw new Error("保存数据失败，请重试");

            if (window.toastr) toastr.success(`备份已恢复（向量条目 ${importedVectorCount}）`, "Titania Echo");
            setTimeout(() => {
                if (confirm("备份已恢复成功！是否立即刷新页面？")) {
                    location.reload();
                }
            }, 500);
        } catch (err) {
            console.error("Titania: 备份导入失败", err);
            if (window.toastr) toastr.error("导入失败：" + (err?.message || String(err)), "Titania Echo");
        } finally {
            $(this).val("");
        }
    });

    renderFavsStorageCard();
    bindScriptsStorageCard();
}

/** 把字节数说成人话 */
function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (Math.abs(n) >= 1048576) return `${(n / 1048576).toFixed(2)} MB`;
    if (Math.abs(n) >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
}

/** 备份文件名：titania_backup_<tag>_20260821_143000.json */
function backupFileName(tag) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_");
    return `titania_backup_${tag}_${stamp}.json`;
}

/* ------------------------------------------------------------------ *
 * 收藏存储卡片
 *
 * 一张卡片按状态自适应，稳态下只剩一行状态 + 一个「检查」小按钮。
 *
 * 之所以不能干脆把入口删掉：src/ui/favsWindow.js 的 putFav 在未搬家时走 legacy 分支，
 * 也就是说没搬家的安装（含全新安装）会继续把收藏攒进 settings.json，
 * 迟早重新长回同一个卡顿。入口必须留着，只是收窄。
 * ------------------------------------------------------------------ */

/** 结果栏。整张卡片共用一块，后一次结果覆盖前一次 */
function showFavsMigrationReport(html, tone) {
    const reportId = "titania-favs-storage-report";
    let $report = $(`#${reportId}`);
    if ($report.length === 0) {
        const $card = $("#titania-favs-storage-card");
        if ($card.length === 0) return;
        $report = $(`<div class="titania-backup-desc" id="${reportId}"></div>`);
        $card.append($report);
    }
    $report.html(`<span style="color:${tone};">${html}</span>`);
}

/**
 * 卡片状态。五种：
 *   needs-migration  未搬家、有收藏      → 一键搬家
 *   needs-cleanup    已搬家、旧数据还在  → 完成收尾
 *   has-artifacts    已搬家、只剩遗留    → 清理遗留 + 检查
 *   done             全部完成、有收藏    → 状态行 + 检查
 *   empty            没什么可说的        → 整卡隐藏
 */
function describeFavsStorageState() {
    const migrated = isFavsMigrated();

    // 刻意不用 describeCurrentFavsFootprint()：它会把 7 MB 的 favs 整体序列化算字节数，
    // 而这里只需要知道还剩没剩
    const legacyFavs = getExtData().favs;
    const legacyCount = Array.isArray(legacyFavs) ? legacyFavs.length : 0;

    // 未搬家时不查遗留：findOrphanFavFiles 要拿新索引去比对才知道谁是孤儿
    const artifacts = migrated ? describeLegacyArtifacts() : { keys: [], keyBytes: 0, orphanFiles: [] };
    const artifactCount = artifacts.keys.length + artifacts.orphanFiles.length;
    const footprint = describeFavsStorageFootprint();

    let state;
    if (!migrated) state = legacyCount > 0 ? "needs-migration" : "empty";
    else if (legacyCount > 0) state = "needs-cleanup";
    else if (artifactCount > 0) state = "has-artifacts";
    // 一条收藏都没有的人（多半是刚装上）不需要看见「收藏 0 条 · 内容 0 B」这种噪音。
    // 等他存下第一条，卡片自己会出现
    else state = footprint?.count > 0 ? "done" : "empty";

    return { state, migrated, legacyCount, artifacts, artifactCount, footprint };
}

/** 状态行：搬完家之后正文和索引各在哪、各占多少 */
function favsStorageStatusLine(footprint) {
    if (!footprint) return "";
    return `收藏 <b>${footprint.count}</b> 条 · 内容 <b>${formatBytes(footprint.bodyBytes)}</b> 存在 `
        + `<code>user/files/</code> · 目录 <b>${formatBytes(footprint.indexBytes)}</b> 存在设置里`;
}

/**
 * 按状态重画卡片（文案 + 按钮 + 事件）。
 *
 * 每个操作结束后都要再调一次。历史教训：原先各按钮只在绑定时算一次可用状态，
 * 而绑定只发生在页面加载 —— 于是搬家成功后收尾按钮仍停在置灰状态，必须刷新页面才解锁。
 * 现在按钮一律从真实状态重新推出，没有任何地方保存并恢复旧 html。
 */
function renderFavsStorageCard() {
    const $card = $("#titania-favs-storage-card");
    if ($card.length === 0) return;

    const $desc = $("#titania-favs-storage-desc");
    const $actions = $("#titania-favs-storage-actions");
    const info = describeFavsStorageState();

    if (info.state === "empty") {
        $card.attr("hidden", "hidden");
        return;
    }
    $card.removeAttr("hidden");

    const CHECK_BTN = `<button class="titania-mini-btn" data-act="check">`
        + `<i class="fa-solid fa-stethoscope"></i> 检查存储完整性</button>`;

    if (info.state === "needs-migration") {
        $desc.html(
            `收藏内容现在和设置存在一起，收藏越多，改设置就越慢。`
            + `<br>搬家会把收藏挪出去单独存放，一条都不会少，之后改设置就快了。`
            + `<br><span style="color:#feca57;">⚠️ 搬家前会自动下载一份备份，请保存好这个文件。</span>`
        );
        $actions.html(
            `<button class="titania-mini-btn is-import" data-act="migrate">`
            + `<i class="fa-solid fa-box-archive"></i> 一键搬家（自动备份）</button>`
        );
    } else if (info.state === "needs-cleanup") {
        $desc.html(
            `收藏已经搬好了，但设置里的旧数据还没删，所以速度<b>还没变快</b>。`
            + `<br>点下面的按钮，核对无误并确认后会把旧数据删掉。`
            + `<br><span style="color:#feca57;">⚠️ 这一步删了就找不回来。</span>`
        );
        $actions.html(
            `<button class="titania-mini-btn is-export" data-act="finish">`
            + `<i class="fa-solid fa-broom"></i> 完成收尾（删除旧数据）</button>`
        );
    } else if (info.state === "has-artifacts") {
        const keyText = info.artifacts.keys.length
            ? `${info.artifacts.keys.length} 项没用的旧数据（${formatBytes(info.artifacts.keyBytes)}）`
            : "";
        const fileText = info.artifacts.orphanFiles.length
            ? `${info.artifacts.orphanFiles.length} 个没人用的文件`
            : "";
        $desc.html(
            favsStorageStatusLine(info.footprint)
            + `<br>还剩一点垃圾可以清掉：${[keyText, fileText].filter(Boolean).join("、")}。`
            + `删了不影响任何功能。`
        );
        $actions.html(
            `<button class="titania-mini-btn" data-act="artifacts">`
            + `<i class="fa-solid fa-trash-can"></i> 清理遗留数据</button>${CHECK_BTN}`
        );
    } else {
        $desc.html(
            favsStorageStatusLine(info.footprint)
            + `<br>收藏已经各存各的了，改设置不会再被收藏拖慢。`
            + `导出备份时会自动把收藏内容一起打包，不用另外操作。`
        );
        $actions.html(CHECK_BTN);
    }

    $actions.find("button").off("click").on("click", function () {
        const $self = $(this);
        switch ($self.data("act")) {
            case "migrate": return runOneClickMigration($self);
            case "finish": return runFinishCleanup($self);
            case "artifacts": return runArtifactCleanup($self);
            case "check": return runStorageCheck($self);
        }
    });
}

/**
 * 「一键搬家」。
 *
 * 顺序：强制下载完整备份 → 写正文文件 → 逐个校验落盘 → 写索引 → 转入收尾。
 * 备份失败就不许往下走 —— 那是唯一的人工退路。
 */
async function runOneClickMigration($btn) {
    if (isFavsMigrated()) {
        showFavsMigrationReport("收藏已经搬过家了，无需重复操作。", "#feca57");
        renderFavsStorageCard();
        return;
    }

    const footprint = describeCurrentFavsFootprint();
    if (footprint.count === 0) {
        showFavsMigrationReport("当前没有收藏，无需搬家。", "#feca57");
        renderFavsStorageCard();
        return;
    }

    const confirmed = confirm(
        `即将把 ${footprint.count} 条收藏的正文改由独立文件承载（约 ${formatBytes(footprint.bytes)}）。\n\n`
        + `流程：\n`
        + `  1. 下载一份完整备份（请务必保存好）\n`
        + `  2. 把每条正文写成 user/files/ 下的独立文件并校验\n`
        + `  3. 在 settings.json 里建一份轻量索引\n`
        + `  4. 全量逐字核对每一条正文\n`
        + `  5. 核对通过后删掉 settings.json 里的旧数据（删之前会再问你一次）\n`
        + `  6. 顺带清掉已确认零引用的旧键与无人引用的文件\n\n`
        + `确定继续吗？`
    );
    if (!confirmed) return;

    $btn.prop("disabled", true);

    try {
        // 1. 强制备份。备份失败就不许往下走 —— 这是唯一的人工退路。
        //    下载完必须等用户确认再发上传请求，否则 iOS 上会 107/107 全挂，
        //    原因见 downloadBackupAndConfirm
        $btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 正在备份...');
        try {
            const snapshot = await createFullBackupPayload({ includeVectors: true, autoBackup: true });
            const go = await downloadBackupAndConfirm(snapshot, backupFileName("before_favs_migration"), "搬家");
            if (!go) {
                showFavsMigrationReport("已取消，未改动任何数据。备份文件已下载，可随时回来重试。", "#feca57");
                return;
            }
        } catch (backupErr) {
            console.error("Titania: 搬家前备份失败", backupErr);
            showFavsMigrationReport(
                `❌ 搬家前的备份失败，已中止，未改动任何数据：${backupErr?.message || String(backupErr)}`,
                "#ff7675"
            );
            if (window.toastr) toastr.error("备份失败，搬家已中止", "Titania Echo");
            return;
        }

        // 2. 写文件 + 校验 + 建索引
        const report = await migrateFavsToFiles({
            onProgress: (done, total) => {
                $btn.html(`<i class="fa-solid fa-spinner fa-spin"></i> 搬家中 ${done}/${total}`);
            }
        });

        if (!report.ok) {
            // 真实原因必须出现在界面上。只报「N 条写入失败」的话，用户唯一能转达的
            // 就是一个条数，排查得从零开始 —— 那位 iPhone 用户的 "Load failed"
            // 就是这么被埋了一轮的
            const sample = report.failures?.[0]?.error;
            const allFailed = report.failures?.length === footprint.count && footprint.count > 0;
            showFavsMigrationReport(
                `❌ 搬家已中止，索引未写入，settings.json 未改动：${report.reason || "未知原因"}`
                + (sample ? `<br>· 报错原因：<b>${escapeHtml(sample)}</b>` : "")
                + (allFailed ? `<br>· 一条都没成功，通常是浏览器没能把请求发出去：`
                    + `请确认备份已下载完、SillyTavern 仍连得上，然后重试` : "")
                + `<br>· 备份文件已下载，可放心重试<br>· 详情见控制台与设置页的日志`,
                "#ff7675"
            );
            console.error("[Titania] 收藏搬家中止", report);
            if (window.toastr) toastr.error("搬家已中止，未改动原数据", "Titania Echo");
            return;
        }
        console.log("[Titania] 收藏搬家报告", report);

        // 3. 直接转入收尾。备份已在流程开始时完成
        await runFinishCleanup($btn, {
            migrationSummary: `${report.written.count} 条正文已落文件，共 ${formatBytes(report.written.bytesTotal)}，`
                + `索引 ${formatBytes(report.indexBytes)}`
        });
    } catch (e) {
        console.error("Titania: 收藏搬家失败", e);
        showFavsMigrationReport(`❌ 搬家失败：${e?.message || String(e)}`, "#ff7675");
        if (window.toastr) toastr.error(e?.message || "搬家失败", "Titania Echo");
    } finally {
        renderFavsStorageCard();
    }
}

/**
 * 收尾：全量核对 → 人工闸门 → 删旧数据 → 清理遗留。
 *
 * 这是整个搬家里唯一不可逆的一步，也是 settings.json 真正瘦下来、
 * 保存速度真正变快的那一步。备份只在一键搬家开始时做；这里只负责：
 *   1. 全量核对——不是抽样：每个文件都要在、每条正文都要能读回来，
 *      且与 settings.json 里的旧数据逐字一致（favsStore 的 verifyMigrationAgainstLegacy）
 *   2. 核对通过后再问一次，给用户机会先打开收藏夹看一眼
 */
async function runFinishCleanup($btn, { migrationSummary = "" } = {}) {
    if (!isFavsMigrated()) {
        showFavsMigrationReport("请先完成搬家，再执行收尾。", "#feca57");
        renderFavsStorageCard();
        return;
    }
    const footprint = describeCurrentFavsFootprint();
    if (footprint.count === 0) {
        showFavsMigrationReport("settings.json 里已经没有旧收藏数据了。", "#feca57");
        renderFavsStorageCard();
        return;
    }

    $btn.prop("disabled", true);

    try {
        // 全量核对 → 人工闸门 → 删除。三步都在 dropLegacyFavs 里：核对只跑一遍，
        // 且「没核对通过就绝不删」这条不变量锁在 store 里，UI 绕不过去
        const result = await dropLegacyFavs({
            onProgress: (done, total) => {
                $btn.html(`<i class="fa-solid fa-spinner fa-spin"></i> 核对中 ${done}/${total}`);
            },
            confirmBeforeDelete: verification => confirm(
                `${verification.checked} 条正文已全部逐字核对通过，`
                + `settings.json 里那 ${formatBytes(footprint.bytes)} 旧数据可以删了。\n\n`
                + `建议现在先打开收藏夹看一眼：列表、搜索、筛选、点开看、导出、删除。\n\n`
                + `确定 = 立即删除（不可逆）\n`
                + `取消 = 保留旧数据，稍后可回来点「完成收尾」`
            )
        });

        if (result.cancelled) {
            showFavsMigrationReport(
                `✅ ${result.checked} 条正文已全部核对通过，<b>旧数据仍保留</b>`
                + `<br>· 请打开收藏夹检查：列表、搜索、筛选、点开看、导出、删除`
                + `<br>· 确认无误后回来点「完成收尾」，删掉那 ${formatBytes(footprint.bytes)} 旧数据 ——`
                + `<b>保存速度到那一步才真正改善</b>`,
                "#55efc4"
            );
            return;
        }

        if (!result.ok) {
            showFavsMigrationReport(
                `❌ 核对未通过，<b>旧数据一个字都没删</b>：`
                + `<br>· ${(result.problems || []).join("<br>· ")}`,
                "#ff7675"
            );
            console.error("[Titania] 收尾核对未通过", result);
            if (window.toastr) toastr.error("核对未通过，未删除任何数据", "Titania Echo");
            return;
        }

        // 旧数据删净后顺带清遗留。不再单独确认：都是死数据，且迁移开始前已有备份。
        // 必须排在这里而不是更早 —— findOrphanFavFiles 要拿新索引比对才知道谁是孤儿。
        // 清理本身失败不该让整个收尾报错：旧数据已经删成功了，遗留下次再清就行
        $btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 清理遗留...');
        let artifactReport = null;
        try {
            artifactReport = await cleanupLegacyArtifacts();
        } catch (e) {
            console.error("Titania: 遗留数据清理失败（旧数据已删除成功）", e);
        }

        const lines = [];
        if (migrationSummary) lines.push(migrationSummary);
        lines.push(`settings.json 减少 <b>${formatBytes(result.removedBytes)}</b>（${result.checked} 条全部核对通过）`);
        if (artifactReport) lines.push(...describeArtifactReportLines(artifactReport));
        lines.push("收藏正文现在只存在于 user/files/ 里，新增一条收藏只写它自己那一个文件");
        lines.push("保存设置不再重写收藏 —— 卡顿到这一步才真正改善");
        lines.push("导出备份会自动把正文读回来打包，仍然自成一体");
        lines.push("<b>建议刷新页面</b>，确认收藏夹一切正常");

        showFavsMigrationReport(`✅ 搬家全部完成<br>· ${lines.join("<br>· ")}`, "#55efc4");
        console.log("[Titania] 收尾完成", { result, artifactReport });
        if (window.toastr) {
            toastr.success(`旧数据已清理，settings.json 减少 ${formatBytes(result.removedBytes)}`, "Titania Echo");
        }
    } catch (e) {
        console.error("Titania: 收尾失败", e);
        showFavsMigrationReport(`❌ 收尾失败：${e?.message || String(e)}`, "#ff7675");
        if (window.toastr) toastr.error(e?.message || "收尾失败", "Titania Echo");
    } finally {
        // 状态一律重新推出，否则核对失败时按钮会一直卡在「核对中 176/176」
        renderFavsStorageCard();
    }
}

/** 遗留清理报告 → 结果栏条目。一键流程与独立按钮共用 */
function describeArtifactReportLines(report) {
    const lines = [];
    if (report.removedKeys.length) {
        lines.push(`已删除 ${report.removedKeys.length} 个零引用旧键，`
            + `settings.json 再减少 <b>${formatBytes(report.removedBytes)}</b>`
            + `（${report.removedKeys.join("、")}）`);
    }
    if (report.deletedFiles.length) {
        lines.push(`已删除 ${report.deletedFiles.length} 个无人引用的正文文件`);
    }
    if (report.failedFiles.length) {
        lines.push(`<b>${report.failedFiles.length} 个文件删除失败</b>，已保留 favs_meta 以便下次重试`);
    }
    return lines;
}

/**
 * 「清理遗留数据」。
 *
 * 清的是两类**已确认零引用**的东西：
 *   · settings.json 里 11 个没有任何代码读写的旧键（含 2026-08 那次未完成迁移留下的
 *     favs_meta / favs_migrated_at，已被 favs_index 取代）
 *   · user/files 里不再被 favs_index 引用的正文文件
 *
 * 不强制备份：这些是死数据，删掉不影响任何功能。确认框会逐项列清楚删什么。
 */
async function runArtifactCleanup($btn) {
    const plan = describeLegacyArtifacts();
    if (plan.keys.length === 0 && plan.orphanFiles.length === 0) {
        showFavsMigrationReport("没有可清理的遗留数据。", "#feca57");
        renderFavsStorageCard();
        return;
    }

    const keyList = plan.keys.map(item => `  · ${item.key}（${formatBytes(item.bytes)}）`).join("\n");
    const fileList = plan.orphanFiles.map(path => `  · ${path}`).join("\n");
    const confirmed = confirm(
        `将清理以下已确认零引用的遗留数据：\n\n`
        + (plan.keys.length ? `settings.json 里的 ${plan.keys.length} 个旧键（共 ${formatBytes(plan.keyBytes)}）：\n${keyList}\n\n` : "")
        + (plan.orphanFiles.length ? `${plan.orphanFiles.length} 个不再被引用的正文文件：\n${fileList}\n\n` : "")
        + `这些都是没有任何代码读写的死数据，删除不影响任何功能。\n`
        + `如需保险，可先点上面的「导出备份」。\n\n确定继续吗？`
    );
    if (!confirmed) return;

    $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 清理中...');

    try {
        const report = await cleanupLegacyArtifacts();
        const lines = describeArtifactReportLines(report);
        if (lines.length === 0) lines.push("没有可清理的内容");

        showFavsMigrationReport(
            `${report.failedFiles.length ? "⚠️ 清理部分完成" : "✅ 清理完成"}<br>· ${lines.join("<br>· ")}`,
            report.failedFiles.length ? "#feca57" : "#55efc4"
        );
        console.log("[Titania] 遗留数据清理报告", report);
        if (window.toastr) {
            toastr.success(`遗留数据已清理，settings.json 减少 ${formatBytes(report.removedBytes)}`, "Titania Echo");
        }
    } catch (e) {
        console.error("Titania: 遗留数据清理失败", e);
        showFavsMigrationReport(`❌ 清理失败：${e?.message || String(e)}`, "#ff7675");
        if (window.toastr) toastr.error(e?.message || "清理失败", "Titania Echo");
    } finally {
        renderFavsStorageCard();
    }
}

/**
 * 「检查存储完整性」。一个请求把索引里全部正文路径查一遍。
 *
 * 这是搬完家之后真实存在的故障模式：手动清过 user/files、
 * 或只恢复了 settings.json 却没恢复文件。现在唯一的症状是
 * 「点开某条收藏说读取失败」，没有任何地方能一次看出缺了几个。
 */
async function runStorageCheck($btn) {
    const store = getFavsIndex();
    if (!store) {
        showFavsMigrationReport("尚未搬家，没有可检查的文件存储。", "#feca57");
        renderFavsStorageCard();
        return;
    }

    $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 检查中...');

    try {
        const paths = store.entries.map(entry => entry.file);
        const result = await verifyFavFiles(paths);
        const missing = Object.entries(result).filter(([, exists]) => !exists).map(([path]) => path);

        if (missing.length === 0) {
            const footprint = describeFavsStorageFootprint();
            showFavsMigrationReport(
                `✅ ${paths.length} 个正文文件全部在位，共 ${formatBytes(footprint.bodyBytes)}`,
                "#55efc4"
            );
            if (window.toastr) toastr.success(`${paths.length} 个正文文件全部在位`, "Titania Echo");
        } else {
            const named = missing.slice(0, 5).map(path => {
                const entry = store.entries.find(item => item.file === path);
                return String(entry?.title || path);
            });
            showFavsMigrationReport(
                `❌ <b>${missing.length} / ${paths.length} 个正文文件不存在</b>`
                + `<br>· ${named.join("<br>· ")}${missing.length > 5 ? "<br>· …" : ""}`
                + `<br>这几条收藏点开会报读取失败。请用上面的「导入备份」恢复，`
                + `或删掉它们让索引与磁盘重新一致。完整清单见控制台。`,
                "#ff7675"
            );
            console.error("[Titania] 缺失的正文文件", missing);
            if (window.toastr) toastr.error(`${missing.length} 个正文文件不存在`, "Titania Echo");
        }
    } catch (e) {
        console.error("Titania: 存储检查失败", e);
        showFavsMigrationReport(`❌ 检查失败：${e?.message || String(e)}`, "#ff7675");
        if (window.toastr) toastr.error(e?.message || "检查失败", "Titania Echo");
    } finally {
        renderFavsStorageCard();
    }
}

/* ------------------------------------------------------------------ *
 * 剧本存储卡片
 *
 * 与收藏存储卡片同构（同一套 render / report / 按状态出按钮的写法）。
 * 本提交只做「试运行」这一档 —— 试运行不写指针、不碰 data.user_scripts、
 * 也不碰正式文件，是纯只读的可行性验证。搬家与收尾在后续提交里加。
 * ------------------------------------------------------------------ */

/** 结果栏。整张卡片共用一块，后一次结果覆盖前一次 */
function showScriptsStorageReport(html, tone) {
    const reportId = "titania-scripts-storage-report";
    let $report = $(`#${reportId}`);
    if ($report.length === 0) {
        const $card = $("#titania-scripts-storage-card");
        if ($card.length === 0) return;
        $report = $(`<div class="titania-backup-desc" id="${reportId}"></div>`);
        $card.append($report);
    }
    $report.html(`<span style="color:${tone};">${html}</span>`);
}

/**
 * 按状态重画卡片。
 *
 * ⚠ 与收藏卡片同样的教训：按钮一律从真实状态重新推出，不保存并恢复旧 html ——
 * 否则某个操作成功后按钮会停在置灰态，必须刷新页面才解锁。
 */
function renderScriptsStorageCard() {
    const $card = $("#titania-scripts-storage-card");
    if ($card.length === 0) return;

    const $desc = $("#titania-scripts-storage-desc");
    const $actions = $("#titania-scripts-storage-actions");

    const hydrationError = getScriptsHydrationError();
    const migrated = isScriptsMigrated();
    const footprint = describeCurrentScriptsFootprint();

    // 载入失败是最高优先级：此时读写全部被 scriptStore 拒绝，
    // 必须把原因摆在最显眼处，而不是让用户看见「剧本 0 条」自己去猜。
    if (hydrationError) {
        $card.removeAttr("hidden");
        $desc.html(
            `<span style="color:#ff7675;">❌ <b>剧本数据未能载入</b></span>`
            + `<br><code>${hydrationError}</code>`
            + `<br>为避免覆盖磁盘上的文件，所有剧本读写已暂停。`
            + `<br>请先刷新页面重试；仍然失败就用上面的「导入备份」恢复。`
        );
        $actions.empty();
        return;
    }

    // 未搬家且一条自定义剧本都没有的人（多半是刚装上）不需要看见这张卡片。
    if (!migrated && footprint.count === 0) {
        $card.attr("hidden", "hidden");
        return;
    }
    $card.removeAttr("hidden");

    if (migrated) {
        const store = describeScriptsStorageFootprint();
        const legacy = getExtData().user_scripts;
        const legacyCount = Array.isArray(legacy) ? legacy.length : 0;
        const writeError = getScriptsLastWriteError();

        let html = `剧本 <b>${store.count}</b> 条 · <b>${formatBytes(store.fileBytes)}</b> 存在 `
            + `<code>user/files/${SCRIPTS_FILE_NAME}</code>`
            + ` · 设置里的指针只占 <b>${formatBytes(store.pointerBytes)}</b>`;

        if (writeError) {
            html += `<br><span style="color:#ff7675;">⚠️ 最近一次保存失败：${writeError}`
                + `<br>改动可能没有写进文件。请检查 ST 服务端是否正常，然后重新编辑一次触发保存。</span>`;
        }

        if (legacyCount > 0) {
            html += `<br><span style="color:#feca57;">旧数据还留在设置里`
                + `（${legacyCount} 条，${formatBytes(footprint.bytes)}），所以设置文件<b>还没变小</b>。`
                + `<br>这通常是上次搬家中途被打断了。点下面的按钮补完最后一步。`
                + `<br>⚠️ 会先核对，确认后再删除。</span>`;
            $desc.html(html);
            $actions.html(
                `<button class="titania-mini-btn is-export" data-act="finish">`
                + `<i class="fa-solid fa-broom"></i> 补完收尾</button>`
            );
            return;
        }

        $desc.html(html);
        $actions.empty();
        return;
    }

    // 未搬家。⚠ 只给**一个**按钮。
    // 早先这里是「试运行」+「一键搬家」+ 搬完再点「完成收尾」，三次点击三个按钮 ——
    // 那是开发期自己调试用的粒度，对用户是没必要的负担，而且中间任一步忘了点，
    // 就会停在「已搬家但设置文件没变小」的半途状态（收藏存储在 3067eac
    // 已经踩过并修过同一个问题：4 个测试按钮收窄成 1 个状态感知入口）。
    // 现在一个按钮把 备份 → 试运行 → 搬家 → 核对 → 删旧数据 全串起来，
    // 只在删除前问一次。
    $desc.html(
        `剧本指令现在和设置存在一起。ST 每次保存设置都会把整个设置文件重写一遍，`
        + `所以剧本越多，改任何一个开关就越慢。`
        + `<br>当前 <b>${footprint.count}</b> 条，占 <b>${formatBytes(footprint.bytes)}</b>`
        + `（其中指令正文 <b>${formatBytes(footprint.promptBytes)}</b>）。`
        + `<br>搬家会把剧本挪到独立文件单独存放，一条都不会少，之后改设置就快了。`
        + `<br><span style="color:#feca57;">⚠️ 开始前会自动下载一份备份，请保存好这个文件。</span>`
    );
    $actions.html(
        `<button class="titania-mini-btn is-import" data-act="migrate">`
        + `<i class="fa-solid fa-box-archive"></i> 一键搬家（自动备份）</button>`
    );
}

function bindScriptsStorageCard() {
    const $card = $("#titania-scripts-storage-card");
    if ($card.length === 0) return;

    $card.off("click", "[data-act]").on("click", "[data-act]", async function () {
        const act = $(this).attr("data-act");
        if (act === "migrate") return void runScriptsOneClick($(this));
        if (act === "finish") return void runScriptsFinish($(this));
    });

    renderScriptsStorageCard();
}

/**
 * 一键搬家：备份 → 试运行 → 正式搬家 → 核对 → 删旧数据，全串在一个按钮里。
 *
 * ⚠ 早先这里拆成「试运行」「一键搬家」「完成收尾」三个按钮，那是开发期自己调试
 *   用的粒度。对用户的问题有两个：多按两次是白搭的负担；更糟的是中间任一步忘了点，
 *   就停在「已搬家但设置文件没变小」的半途状态 —— 而那个状态下双写还在跑，
 *   等于两份数据都在维护，一点好处没拿到。收藏存储在 3067eac 踩过同一个坑，
 *   结论是收窄成一个状态感知入口，这里照抄。
 *
 * 试运行没做成独立按钮，而是折进流程当第一步：它写的是**独立的**试运行文件，
 * 所以能在碰到正式文件之前就发现序列化往返有问题。代价只有一次上传+下载+删除。
 */
async function runScriptsOneClick($btn) {
    if (isScriptsMigrated()) {
        showScriptsStorageReport("剧本已经搬过家了，无需重复操作。", "#feca57");
        renderScriptsStorageCard();
        return;
    }

    const footprint = describeCurrentScriptsFootprint();
    if (footprint.count === 0) {
        showScriptsStorageReport("当前没有自定义剧本，无需搬家。", "#feca57");
        renderScriptsStorageCard();
        return;
    }

    const confirmed = confirm(
        `即将把 ${footprint.count} 条剧本指令挪到独立文件（约 ${formatBytes(footprint.bytes)}）。\n\n`
        + `流程：\n`
        + `  1. 下载一份完整备份（请务必保存好）\n`
        + `  2. 试写一个临时文件并读回逐条比对，确认序列化无损\n`
        + `  3. 写入正式文件并校验，然后在设置里只留一个指针\n`
        + `  4. 全量逐条核对文件与设置里的旧数据\n`
        + `  5. 核对通过后删掉设置里的旧数据（删之前会再问你一次）\n\n`
        + `确定继续吗？`
    );
    if (!confirmed) return;

    $btn.prop("disabled", true);

    try {
        // 1. 强制备份。失败就不许往下走 —— 这是唯一的人工退路。
        //    下载完要等用户确认再往下：第 2 步的试写就是 fetch，
        //    会撞上 iOS 的下载导航问题（见 downloadBackupAndConfirm）
        $btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 正在备份...');
        try {
            const snapshot = await createFullBackupPayload({ includeVectors: true, autoBackup: true });
            const go = await downloadBackupAndConfirm(snapshot, backupFileName("before_scripts_migration"), "搬家");
            if (!go) {
                showScriptsStorageReport("已取消，未改动任何数据。备份文件已下载，可随时回来重试。", "#feca57");
                return;
            }
        } catch (backupErr) {
            console.error("Titania: 搬家前备份失败", backupErr);
            showScriptsStorageReport(
                `❌ 备份失败，已中止，未改动任何数据：${backupErr?.message || String(backupErr)}`,
                "#ff7675"
            );
            if (window.toastr) toastr.error("备份失败，搬家已中止", "Titania Echo");
            return;
        }

        // 2. 试运行：独立临时文件的往返比对，不碰正式文件也不写指针
        $btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 校验数据...');
        const dry = await dryRunScriptsMigration();
        if (!dry.ok) {
            const detail = dry.mismatches?.length ? dry.mismatches.join("；") : dry.reason;
            showScriptsStorageReport(
                `❌ <b>数据校验未通过，已中止，未改动任何数据</b><br>${detail}`
                + `<br>请把这条信息发给开发者。`,
                "#ff7675"
            );
            console.error("[Titania] 剧本搬家前校验未通过", dry);
            if (window.toastr) toastr.error("数据校验未通过，搬家已中止", "Titania Echo");
            return;
        }

        // 3. 正式搬家。指针最后写，失败即「什么都没发生」
        $btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 搬家中...');
        const report = await migrateScriptsToFiles();
        if (!report.ok) {
            showScriptsStorageReport(
                `❌ <b>搬家已中止，未改动任何数据</b><br>${report.reason}`
                + `<br>指针没有写入，剧本仍从设置里读取，可以直接重试。`,
                "#ff7675"
            );
            if (window.toastr) toastr.error("搬家已中止，数据未改动", "Titania Echo");
            return;
        }

        // 读取来源已从 user_scripts 切到文件缓存，运行时要重建一次
        loadScripts();

        const migrationSummary = `${report.written.count} 条剧本已写入 `
            + `<code>user/files/${SCRIPTS_FILE_NAME}</code>（${formatBytes(report.written.bytes)}）`;

        // 4-5. 直接续上收尾。备份已在流程开始时做过
        await runScriptsFinish($btn, { migrationSummary });
    } catch (e) {
        console.error("Titania: 剧本搬家失败", e);
        showScriptsStorageReport(`❌ 搬家失败：${e?.message || String(e)}`, "#ff7675");
        if (window.toastr) toastr.error(e?.message || "搬家失败", "Titania Echo");
    } finally {
        renderScriptsStorageCard();
    }
}

/**
 * 收尾：核对 → 确认 → 删除设置里的旧数据。整个搬家里唯一不可逆的一步。
 *
 * 备份只在一键搬家开始时做；无论从搬家流程续上，还是中断后点「补完收尾」，
 * 这里都只负责核对、确认和删除。
 */
async function runScriptsFinish($btn, { migrationSummary = "" } = {}) {
    if (!isScriptsMigrated()) {
        showScriptsStorageReport("请先完成搬家，再执行收尾。", "#feca57");
        return;
    }

    const legacy = getExtData().user_scripts;
    if (!Array.isArray(legacy) || legacy.length === 0) {
        showScriptsStorageReport("设置里已经没有旧剧本数据了。", "#feca57");
        return;
    }

    $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 核对中...');

    try {
        const result = await dropLegacyScripts({
            confirmBeforeDelete: async (verification) => {
                return confirm(
                    `核对通过：${verification.checked} 条剧本在文件里与设置里逐条一致。\n\n`
                    + `现在要删除设置里的旧剧本数据吗？\n`
                    + `⚠️ 这一步不可撤销。删除后剧本只存在于 user/files/${SCRIPTS_FILE_NAME}。`
                );
            }
        });

        if (result.cancelled) {
            showScriptsStorageReport(
                (migrationSummary ? `${migrationSummary}。<br>` : "")
                + `已取消删除，旧数据保留。核对是通过的，随时可以点「补完收尾」。`,
                "#feca57"
            );
            return;
        }
        if (!result.ok) {
            showScriptsStorageReport(
                (migrationSummary ? `${migrationSummary}。<br>` : "")
                + `❌ <b>核对未通过，未删除任何数据</b>`
                + `<br>· ${result.problems.join("<br>· ")}`
                + `<br>旧数据仍在设置里，剧本不会丢。请把上面的信息发给开发者。`,
                "#ff7675"
            );
            console.error("[Titania] 剧本收尾核对未通过", result.problems);
            if (window.toastr) toastr.error("核对未通过，未删除任何数据", "Titania Echo");
            return;
        }

        showScriptsStorageReport(
            (migrationSummary ? `✅ ${migrationSummary}。<br>` : "✅ ")
            + `核对 ${result.checked} 条无误后已删除旧数据，`
            + `设置文件减少约 <b>${formatBytes(result.removedBytes)}</b>。`
            + `<br>从现在起改设置不再牵连剧本。`,
            "#55efc4"
        );
        if (window.toastr) toastr.success(`搬家完成，设置文件减少 ${formatBytes(result.removedBytes)}`, "Titania Echo");

        // 这一步删了东西，不该留在 debounce 队列里等
        await saveExtDataImmediate();
    } catch (e) {
        console.error("Titania: 剧本收尾失败", e);
        showScriptsStorageReport(`❌ 收尾失败：${e?.message || String(e)}`, "#ff7675");
        if (window.toastr) toastr.error(e?.message || "收尾失败", "Titania Echo");
    } finally {
        renderScriptsStorageCard();
    }
}

async function loadExtensionSettings() {
    // 确保配置对象存在
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const settingsWereEmpty = Object.keys(extension_settings[extensionName]).length === 0;
    if (settingsWereEmpty) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }

    // 收藏为零时直接建空索引，让新装用户天生就在文件存储上，
    // 不必先把收藏攒进 settings.json 再自己去点搬家。
    //
    // settingsWereEmpty 时跳过：设置对象是空的，是「ST 还没把 settings.json 读进来」
    // 的特征，往一个随后可能被整体替换的对象里写索引，就是丢数据的路径。
    // 真·新用户因此要晚一次刷新才建上索引，代价可接受。
    if (!settingsWereEmpty) {
        bootstrapEmptyFavsIndex();
        await bootstrapEmptyScriptsStore();
    }

    // 剧本整表从文件读进内存。⚠ 必须在 initCoreFeatures() **之前** await ——
    // 那里的 loadScripts() 是同步的，会立刻整表重建 GlobalState.runtimeScripts。
    // 未搬家时本调用是空操作（getScripts 自动回退读 data.user_scripts）。
    //
    // 失败时刻意**不**抛出：抛出会中断后面整个初始化，插件直接不可用。
    // scriptStore 内部已置只读保护标志（读写全部拒绝、不会用空数组覆盖文件），
    // 这里只负责把原因告诉用户 —— 设置页的存储卡片也会显示同一条原因。
    const hydration = await hydrateScripts();
    if (!hydration.ok) {
        console.error("Titania: 剧本载入失败", hydration.error);
        if (window.toastr) {
            toastr.error(
                `剧本数据未能载入，剧本读写已暂停。请刷新重试或从备份恢复。\n${hydration.error}`,
                "Titania Echo",
                { timeOut: 15000 }
            );
        }
    }

    // 设置版本号显示
    $("#titania-version-badge").text(`v${CURRENT_VERSION}`);

    // 1. 初始化核心功能（始终执行）
    initCoreFeatures();

    // 2. 绑定悬浮球开关（仅控制悬浮球显示/隐藏）
    $("#enable_echo_theater").prop("checked", extension_settings[extensionName].enabled);
    $("#enable_echo_theater").on("input", function () {
        const showFloatBtn = $(this).prop("checked");
        extension_settings[extensionName].enabled = showFloatBtn;
        saveSettingsDebounced();

        if (showFloatBtn) {
            showFloatingButton();
        } else {
            hideFloatingButton();
        }
    });

    // 3. 如果悬浮球开关已启用，则显示悬浮球
    if (extension_settings[extensionName].enabled) {
        showFloatingButton();
    }

    // 3.1 绑定发送区入口开关（故事大纲 / 文本改写）
    const extData = getExtData();
    if (!extData.outline_entry || typeof extData.outline_entry !== "object") {
        extData.outline_entry = { enabled: false, show_theater: true, show_outline_actions: true };
    }
    if (typeof extData.outline_entry.show_theater !== "boolean") {
        extData.outline_entry.show_theater = true;
    }
    if (typeof extData.outline_entry.show_outline_actions !== "boolean") {
        extData.outline_entry.show_outline_actions = true;
    }
    if (!extData.rewrite_entry || typeof extData.rewrite_entry !== "object") extData.rewrite_entry = { enabled: false };
    if (!extData.chat_inject || typeof extData.chat_inject !== "object") {
        extData.chat_inject = { enabled: true, visible_to_ai: true, speaker_name: "回声小剧场" };
    }
    if (typeof extData.chat_inject.enabled !== "boolean") extData.chat_inject.enabled = true;
    if (typeof extData.chat_inject.visible_to_ai !== "boolean") extData.chat_inject.visible_to_ai = true;
    if (!String(extData.chat_inject.speaker_name || "").trim()) extData.chat_inject.speaker_name = "回声小剧场";
    if (!extData.preset_macros || typeof extData.preset_macros !== "object") {
        extData.preset_macros = { persist_variables: false };
    }
    if (typeof extData.preset_macros.persist_variables !== "boolean") {
        extData.preset_macros.persist_variables = false;
    }
    if (!extData.quick_toolbar || typeof extData.quick_toolbar !== "object") extData.quick_toolbar = {};
    if (!extData.quick_toolbar.enabled_items || typeof extData.quick_toolbar.enabled_items !== "object") {
        extData.quick_toolbar.enabled_items = {};
    }
    if (extData.quick_toolbar.enabled_items.outline === true || extData.quick_toolbar.enabled_items.debug === true) {
        extData.quick_toolbar.enabled_items.outline = false;
        extData.quick_toolbar.enabled_items.debug = false;
        saveExtData();
    }

    $("#cfg-outline-entry-enabled").prop("checked", extData.outline_entry.enabled === true);
    $("#cfg-float-edge-tuck").prop("checked", extData.appearance?.edge_tuck !== false);
    $("#cfg-outline-theater-enabled").prop("checked", extData.outline_entry.show_theater === true);
    $("#cfg-outline-actions-enabled").prop("checked", extData.outline_entry.show_outline_actions === true);
    $("#cfg-rewrite-entry-enabled").prop("checked", extData.rewrite_entry.enabled === true);
    $("#cfg-chat-inject-enabled").prop("checked", extData.chat_inject.enabled === true);
    $("#cfg-preset-persist-vars").prop("checked", extData.preset_macros.persist_variables === true);
    $("#cfg-toolbar-lore-enabled").prop("checked", extData.quick_toolbar.enabled_items.lore === true);
    $("#cfg-toolbar-recall-enabled").prop("checked", extData.quick_toolbar.enabled_items.recall === true);

    $("#cfg-float-edge-tuck").on("input", function () {
        const enabled = $(this).prop("checked") === true;
        const data = getExtData();
        if (!data.appearance || typeof data.appearance !== "object") data.appearance = {};
        data.appearance.edge_tuck = enabled;
        saveExtData();
        // 关闭时把露在视口外的球收回可视区；悬浮球未显示时该调用静默返回
        refreshFloatingTuck();
        if (window.toastr) toastr.success(enabled ? "悬浮球半隐藏已启用，可拖到屏幕边缘藏起一半" : "悬浮球半隐藏已关闭，将始终完整显示", "Titania Echo");
    });

    $("#cfg-outline-entry-enabled").on("input", function () {
        const enabled = $(this).prop("checked") === true;
        const data = getExtData();
        if (!data.outline_entry || typeof data.outline_entry !== "object") {
            data.outline_entry = { enabled: false, show_theater: true, show_outline_actions: true };
        }
        data.outline_entry.enabled = enabled;
        saveExtData();
        refreshOutlineEntryButton();
        if (window.toastr) toastr.success(enabled ? "故事大纲入口已启用" : "故事大纲入口已关闭", "Titania Echo");
    });

    $("#cfg-outline-theater-enabled").on("input", function () {
        const enabled = $(this).prop("checked") === true;
        const data = getExtData();
        if (!data.outline_entry || typeof data.outline_entry !== "object") {
            data.outline_entry = { enabled: false, show_theater: true, show_outline_actions: true };
        }
        data.outline_entry.show_theater = enabled;
        saveExtData();
        refreshOutlineEntryButton();
        if (window.toastr) toastr.success(enabled ? "回声小剧场入口已启用" : "回声小剧场入口已关闭", "Titania Echo");
    });

    $("#cfg-outline-actions-enabled").on("input", function () {
        const enabled = $(this).prop("checked") === true;
        const data = getExtData();
        if (!data.outline_entry || typeof data.outline_entry !== "object") {
            data.outline_entry = { enabled: false, show_theater: true, show_outline_actions: true };
        }
        data.outline_entry.show_outline_actions = enabled;
        saveExtData();
        refreshOutlineEntryButton();
        if (window.toastr) toastr.success(enabled ? "大纲生成入口已启用" : "大纲生成入口已关闭", "Titania Echo");
    });

    $("#cfg-rewrite-entry-enabled").on("input", function () {
        const enabled = $(this).prop("checked") === true;
        const data = getExtData();
        if (!data.rewrite_entry || typeof data.rewrite_entry !== "object") data.rewrite_entry = { enabled: false };
        data.rewrite_entry.enabled = enabled;
        saveExtData();
        refreshRewriteEntryButton();
        if (window.toastr) toastr.success(enabled ? "文本改写入口已启用" : "文本改写入口已关闭", "Titania Echo");
    });

    $("#cfg-chat-inject-enabled").on("input", function () {
        const enabled = $(this).prop("checked") === true;
        const data = getExtData();
        if (!data.chat_inject || typeof data.chat_inject !== "object") {
            data.chat_inject = { enabled: true, visible_to_ai: true, speaker_name: "回声小剧场" };
        }
        data.chat_inject.enabled = enabled;
        saveExtData();
        refreshChatInjectButton();
        if (window.toastr) toastr.success(enabled ? "小剧场注入入口已启用" : "小剧场注入入口已关闭", "Titania Echo");
    });

    $("#cfg-preset-persist-vars").on("input", function () {
        const enabled = $(this).prop("checked") === true;
        const data = getExtData();
        if (!data.preset_macros || typeof data.preset_macros !== "object") {
            data.preset_macros = { persist_variables: false };
        }
        data.preset_macros.persist_variables = enabled;
        saveExtData();
        if (window.toastr) {
            toastr.success(
                enabled ? "预设变量将写入聊天存档" : "预设变量只在本次提示词构建内生效",
                "Titania Echo"
            );
        }
    });

    $("#cfg-toolbar-lore-enabled").on("input", function () {
        const enabled = $(this).prop("checked") === true;
        const data = getExtData();
        if (!data.quick_toolbar || typeof data.quick_toolbar !== "object") data.quick_toolbar = {};
        if (!data.quick_toolbar.enabled_items || typeof data.quick_toolbar.enabled_items !== "object") {
            data.quick_toolbar.enabled_items = {};
        }
        data.quick_toolbar.enabled_items.lore = enabled;
        saveExtData();
        if (window.toastr) toastr.success(enabled ? "提取设定快捷入口已启用" : "提取设定快捷入口已关闭", "Titania Echo");
    });

    $("#cfg-toolbar-recall-enabled").on("input", function () {
        const enabled = $(this).prop("checked") === true;
        const data = getExtData();
        if (!data.quick_toolbar || typeof data.quick_toolbar !== "object") data.quick_toolbar = {};
        if (!data.quick_toolbar.enabled_items || typeof data.quick_toolbar.enabled_items !== "object") {
            data.quick_toolbar.enabled_items = {};
        }
        data.quick_toolbar.enabled_items.recall = enabled;
        saveExtData();
        if (window.toastr) toastr.success(enabled ? "记忆召回快捷入口已启用" : "记忆召回快捷入口已关闭", "Titania Echo");
    });

    // 4. 轻量版本更新检测
    void initExtensionUpdate();

    // 5. 抽屉中的数据备份与恢复
    bindDrawerBackupControls();
}

// --- 入口 ---
jQuery(async () => {
    // 1. 加载 CSS
    loadCssFiles();

    // 2. 加载设置面板 HTML
    // 注意：这里我们只加载 settings.html，其他的 UI 都在各自的 JS 中动态生成
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings2").append(settingsHtml);

        // 3. 加载扩展设置并启动（内部会调用 initCoreFeatures）
        loadExtensionSettings();
    } catch (e) {
        console.error("Titania Echo: Failed to load settings.html", e);
    }
});
