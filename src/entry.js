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
import { GlobalState } from "./core/state.js";
import { loadScripts } from "./core/scriptData.js";
import { handleGenerate } from "./core/api.js";
import { restoreContinuationForCurrentChat } from "./core/continuationStore.js";
import {
    dryRunFavsMigration,
    migrateFavsToFiles,
    isFavsMigrated,
    describeCurrentFavsFootprint,
    exportFavsAsLegacyArray,
    dropLegacyFavs,
    FAVS_INDEX_KEY
} from "./core/favsStore.js";
import { initExtensionUpdate } from "./core/extensionUpdate.js";
import { initSyncListener } from "./core/worldInfoManager.js";
import { createFloatingButton, destroyFloatingButton, refreshFloatingTuck } from "./ui/floatingBtn.js";
import { applyCustomCSS, applyFontSettings, applyUIFontScale, applyUITheme } from "./ui/settingsWindow.js";
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
            if (oldScripts) { extData.user_scripts = oldScripts; migrated = true; }
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
    URL.revokeObjectURL(url);
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

    bindFavsMigrationDryRun();
    bindFavsMigrationRun();
    bindFavsMigrationCleanup();
}

/** 把字节数说成人话 */
function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (Math.abs(n) >= 1048576) return `${(n / 1048576).toFixed(2)} MB`;
    if (Math.abs(n) >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
}

/** 迁移卡片下方的结果栏。两个按钮共用一块，后一次结果覆盖前一次 */
function showFavsMigrationReport(html, tone) {
    const reportId = "titania-favs-migrate-report";
    let $report = $(`#${reportId}`);
    if ($report.length === 0) {
        const $card = $("#titania-favs-migrate-dryrun").closest(".titania-panel-card");
        if ($card.length === 0) return;
        $report = $(`<div class="titania-backup-desc" id="${reportId}"></div>`);
        $card.append($report);
    }
    $report.html(`<span style="color:${tone};">${html}</span>`);
}

/**
 * 「试运行搬家」按钮。
 * 只写文件 + 校验，不动 settings.json 里的任何数据（见 src/core/favsStore.js 的说明）。
 */
function bindFavsMigrationDryRun() {
    const $btn = $("#titania-favs-migrate-dryrun");
    if ($btn.length === 0) return;

    const showReport = showFavsMigrationReport;

    $btn.off("click").on("click", async function () {
        const $self = $(this);
        const oldHtml = $self.html();
        $self.prop("disabled", true);

        try {
            const report = await dryRunFavsMigration({
                onProgress: (done, total) => {
                    $self.html(`<i class="fa-solid fa-spinner fa-spin"></i> 写入中 ${done}/${total}`);
                }
            });

            const lines = [
                `收藏 ${report.settings.count} 条（分组 ${report.settings.chainCount} / 普通 ${report.settings.plainCount}），`
                + `当前在 settings.json 里占 ${formatBytes(report.settings.bytes)}`,
                `已写出 ${report.written.count} 个正文文件，共 ${formatBytes(report.written.bytesTotal)}，`
                + `最大单个 ${formatBytes(report.written.bytesMax)}`,
                `索引大小 ${formatBytes(report.indexBytes)} —— 正式搬家后 settings.json 可减少约 `
                + `<b>${formatBytes(report.projectedSavingBytes)}</b>`,
                `落盘校验：${report.verify.checked} 个已确认`
                + (report.verify.missing.length ? `，<b>缺失 ${report.verify.missing.length} 个</b>` : "，无缺失")
                + (report.verify.error ? `，校验请求出错：${report.verify.error}` : ""),
                `抽样回读比对：${report.readback.sampled} 条`
                + (report.readback.mismatched.length ? `，<b>不一致 ${report.readback.mismatched.length} 条</b>` : "，全部一致"),
                `耗时 ${(report.durationMs / 1000).toFixed(1)} 秒`
            ];
            if (report.failures.length) {
                lines.push(`<b>写入失败 ${report.failures.length} 条</b>：`
                    + report.failures.slice(0, 3).map(f => `${f.id}（${f.error}）`).join("；")
                    + (report.failures.length > 3 ? " …" : ""));
            }

            const tone = report.ok ? "#55efc4" : "#ff7675";
            const head = report.ok
                ? "✅ 试运行通过，未改动任何现有数据"
                : "⚠️ 试运行发现问题，未改动任何现有数据";
            showReport(`${head}<br>· ${lines.join("<br>· ")}`, tone);

            console.log("[Titania] 收藏搬家试运行报告", report);
            if (window.toastr) {
                if (report.ok) {
                    toastr.success(`已写出 ${report.written.count} 个文件并全部校验通过，可减少约 ${formatBytes(report.projectedSavingBytes)}`, "Titania Echo");
                } else {
                    toastr.warning("试运行发现问题，详情见设置页与控制台", "Titania Echo");
                }
            }
        } catch (e) {
            console.error("Titania: 收藏搬家试运行失败", e);
            showReport(`❌ 试运行失败：${e?.message || String(e)}（未改动任何现有数据）`, "#ff7675");
            if (window.toastr) toastr.error(e?.message || "试运行失败", "Titania Echo");
        } finally {
            $self.prop("disabled", false).html(oldHtml);
        }
    });
}

/* 三个迁移按钮的可用状态互相依赖：搬完家收尾才可点，收尾完两个都该锁死。
 * 原先各自在绑定时算一次，而绑定只发生在页面加载 —— 于是搬家成功后
 * 收尾按钮仍停留在「请先完成正式搬家」的置灰状态，必须刷新页面才解锁。
 * 现在统一由这一个函数整体刷新，每步操作结束都调它一次。
 * 文案也在这里统一给出，避免与 settings.html 里的初始文案漂移。 */
const FAVS_MIGRATE_RUN_LABEL = '<i class="fa-solid fa-box-archive"></i> 正式搬家（保留原数据）';
const FAVS_MIGRATE_CLEANUP_LABEL = '<i class="fa-solid fa-broom"></i> 收尾：删除旧数据（不可逆）';

function refreshFavsMigrationButtons() {
    const migrated = isFavsMigrated();
    // 刻意不用 describeCurrentFavsFootprint()：它会把 7 MB 的 favs 整体序列化算字节数，
    // 而这里只需要知道还剩没剩
    const legacyFavs = getExtData().favs;
    const legacyLeft = Array.isArray(legacyFavs) && legacyFavs.length > 0;

    const $run = $("#titania-favs-migrate-run");
    if ($run.length) {
        if (migrated) {
            $run.prop("disabled", true).attr("title", "").html('<i class="fa-solid fa-check"></i> 已搬家（原数据仍保留）');
        } else {
            $run.prop("disabled", false).attr("title", "").html(FAVS_MIGRATE_RUN_LABEL);
        }
    }

    const $cleanup = $("#titania-favs-migrate-cleanup");
    if ($cleanup.length) {
        if (!migrated) {
            $cleanup.prop("disabled", true).attr("title", "请先完成正式搬家").html(FAVS_MIGRATE_CLEANUP_LABEL);
        } else if (!legacyLeft) {
            $cleanup.prop("disabled", true).attr("title", "").html('<i class="fa-solid fa-check"></i> 旧数据已清理');
        } else {
            $cleanup.prop("disabled", false).attr("title", "").html(FAVS_MIGRATE_CLEANUP_LABEL);
        }
    }
}

/**
 * 「正式搬家」按钮。
 *
 * 顺序：强制下载完整备份 → 写正文文件 → 逐个校验落盘 → 写索引。
 * **不删 data.favs** —— 搬完之后磁盘与 settings.json 里各有一份完整数据，
 * 退回上个插件版本就能原样回到搬家前。删除留到下一个提交。
 */
function bindFavsMigrationRun() {
    const $btn = $("#titania-favs-migrate-run");
    if ($btn.length === 0) return;

    refreshFavsMigrationButtons();

    $btn.off("click").on("click", async function () {
        const $self = $(this);

        if (isFavsMigrated()) {
            showFavsMigrationReport("收藏已经搬过家了，无需重复操作。", "#feca57");
            return;
        }

        const footprint = describeCurrentFavsFootprint();
        if (footprint.count === 0) {
            showFavsMigrationReport("当前没有收藏，无需搬家。", "#feca57");
            return;
        }

        const confirmed = confirm(
            `即将把 ${footprint.count} 条收藏的正文改由独立文件承载。\n\n`
            + `· 会先下载一份完整备份，请务必保存好\n`
            + `· settings.json 里的原数据【仍然保留】，随时可退回上个插件版本\n`
            + `· 收藏夹会改成「列表读索引、点开才取正文」\n\n`
            + `确定继续吗？`
        );
        if (!confirmed) return;

        $self.prop("disabled", true);

        try {
            // 1. 强制备份。备份失败就不许往下走 —— 这是唯一的人工退路
            $self.html('<i class="fa-solid fa-spinner fa-spin"></i> 正在备份...');
            try {
                const snapshot = await createFullBackupPayload({ includeVectors: true, autoBackup: true });
                const filename = `titania_backup_before_favs_migration_${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_")}.json`;
                downloadBackupPayload(snapshot, filename);
            } catch (backupErr) {
                console.error("Titania: 搬家前备份失败", backupErr);
                showFavsMigrationReport(
                    `❌ 搬家前的备份失败，已中止，未改动任何数据：${backupErr?.message || String(backupErr)}`,
                    "#ff7675"
                );
                if (window.toastr) toastr.error("备份失败，搬家已中止", "Titania Echo");
                return;
            }

            // 2. 搬家
            const report = await migrateFavsToFiles({
                onProgress: (done, total) => {
                    $self.html(`<i class="fa-solid fa-spinner fa-spin"></i> 搬家中 ${done}/${total}`);
                }
            });

            if (!report.ok) {
                const reason = report.reason || "未知原因";
                showFavsMigrationReport(
                    `❌ 搬家已中止，索引未写入，settings.json 未改动：${reason}`
                    + `<br>· 备份文件已下载，可放心重试<br>· 详情见控制台`,
                    "#ff7675"
                );
                console.error("[Titania] 收藏搬家中止", report);
                if (window.toastr) toastr.error("搬家已中止，未改动原数据", "Titania Echo");
                return;
            }

            showFavsMigrationReport(
                `✅ 搬家完成，settings.json 里的原数据仍保留（可随时退回）`
                + `<br>· ${report.written.count} 条正文已落文件，共 ${formatBytes(report.written.bytesTotal)}，`
                + `最大单个 ${formatBytes(report.written.bytesMax)}`
                + `<br>· 索引 ${formatBytes(report.indexBytes)}，全部文件校验通过`
                + `<br>· 耗时 ${(report.durationMs / 1000).toFixed(1)} 秒`
                + `<br>· <b>下一步请打开收藏夹逐项检查</b>：列表、搜索、筛选、点开看、导出、删除。`
                + `确认无误后再删掉 settings.json 里那 ${formatBytes(report.pendingRemovalBytes)} 旧数据，`
                + `<b>卡顿到那一步才会真正改善。</b>`,
                "#55efc4"
            );
            console.log("[Titania] 收藏搬家报告", report);
            refreshFavsMigrationButtons();
            if (window.toastr) {
                toastr.success(`${report.written.count} 条收藏已搬家，原数据仍保留`, "Titania Echo");
            }
        } catch (e) {
            console.error("Titania: 收藏搬家失败", e);
            showFavsMigrationReport(`❌ 搬家失败：${e?.message || String(e)}`, "#ff7675");
            if (window.toastr) toastr.error(e?.message || "搬家失败", "Titania Echo");
        } finally {
            // 文案与可用状态一律交给 refreshFavsMigrationButtons 统一给出，
            // 不在这里按 isFavsMigrated() 各判一次（那正是收尾按钮解锁不了的成因）
            refreshFavsMigrationButtons();
        }
    });
}

/**
 * 「收尾：删除旧数据」按钮。
 *
 * 这是整个搬家里唯一不可逆的一步，也是 settings.json 真正瘦下来、
 * 保存速度真正变快的那一步。所以门槛设得很高：
 *   1. 强制下载一份完整备份（此时备份已改为从文件重建正文，自成一体）
 *   2. 全量核对——不是抽样：每个文件都要在，每条正文都要能读回来，
 *      且与 settings.json 里的旧数据逐字一致
 *   3. 只有全部通过才删
 */
function bindFavsMigrationCleanup() {
    const $btn = $("#titania-favs-migrate-cleanup");
    if ($btn.length === 0) return;

    refreshFavsMigrationButtons();

    $btn.off("click").on("click", async function () {
        const $self = $(this);

        if (!isFavsMigrated()) {
            showFavsMigrationReport("请先完成「正式搬家」，再执行收尾。", "#feca57");
            return;
        }
        const footprint = describeCurrentFavsFootprint();
        if (footprint.count === 0) {
            showFavsMigrationReport("settings.json 里已经没有旧收藏数据了。", "#feca57");
            refreshFavsMigrationButtons();
            return;
        }

        const confirmed = confirm(
            `即将从 settings.json 删除 ${footprint.count} 条收藏的旧数据（约 ${formatBytes(footprint.bytes)}）。

`
            + `· 删除前会全量核对每一条正文，任何一条不一致就中止
`
            + `· 会先下载一份完整备份，请务必保存好
`
            + `· 【此操作不可逆】删除后正文只存在于 user/files/ 里

`
            + `确定继续吗？`
        );
        if (!confirmed) return;

        $self.prop("disabled", true);

        try {
            // 1. 强制备份。备份此刻已会把正文从文件读回来重建，能独立还原
            $self.html('<i class="fa-solid fa-spinner fa-spin"></i> 正在备份...');
            try {
                const snapshot = await createFullBackupPayload({ includeVectors: true, autoBackup: true });
                const filename = `titania_backup_before_favs_cleanup_${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_")}.json`;
                downloadBackupPayload(snapshot, filename);
            } catch (backupErr) {
                console.error("Titania: 收尾前备份失败", backupErr);
                showFavsMigrationReport(
                    `❌ 收尾前的备份失败，已中止，未删除任何数据：${backupErr?.message || String(backupErr)}`,
                    "#ff7675"
                );
                if (window.toastr) toastr.error("备份失败，收尾已中止", "Titania Echo");
                return;
            }

            // 2. 全量核对 + 删除
            const result = await dropLegacyFavs({
                onProgress: (done, total) => {
                    $self.html(`<i class="fa-solid fa-spinner fa-spin"></i> 核对中 ${done}/${total}`);
                }
            });

            if (!result.ok) {
                showFavsMigrationReport(
                    `❌ 核对未通过，<b>旧数据一个字都没删</b>：`
                    + `<br>· ${(result.problems || []).join("<br>· ")}`
                    + `<br>备份文件已下载，可放心排查后重试。`,
                    "#ff7675"
                );
                console.error("[Titania] 收尾核对未通过", result);
                if (window.toastr) toastr.error("核对未通过，未删除任何数据", "Titania Echo");
                return;
            }

            showFavsMigrationReport(
                `✅ 收尾完成，settings.json 减少 <b>${formatBytes(result.removedBytes)}</b>`
                + `<br>· 收藏正文现在只存在于 user/files/ 里，新增一条收藏只写它自己那一个文件`
                + `<br>· 保存设置不再重写收藏，卡顿到这一步才真正改善`
                + `<br>· 导出备份会自动把正文读回来打包，仍然自成一体`
                + `<br>· <b>建议刷新页面</b>，确认收藏夹一切正常`,
                "#55efc4"
            );
            console.log("[Titania] 收尾完成", result);
            refreshFavsMigrationButtons();
            if (window.toastr) {
                toastr.success(`旧数据已清理，settings.json 减少 ${formatBytes(result.removedBytes)}`, "Titania Echo");
            }
        } catch (e) {
            console.error("Titania: 收尾失败", e);
            showFavsMigrationReport(`❌ 收尾失败：${e?.message || String(e)}`, "#ff7675");
            if (window.toastr) toastr.error(e?.message || "收尾失败", "Titania Echo");
        } finally {
            // 同上：文案与可用状态统一由 refreshFavsMigrationButtons 给出，
            // 否则核对失败时按钮会一直卡在「核对中 176/176」
            refreshFavsMigrationButtons();
        }
    });
}

async function loadExtensionSettings() {
    // 确保配置对象存在
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
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
