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
import { initExtensionUpdate } from "./core/extensionUpdate.js";
import { initSyncListener } from "./core/worldInfoManager.js";
import { createFloatingButton, destroyFloatingButton, refreshFloatingTuck } from "./ui/floatingBtn.js";
import { applyCustomCSS, applyFontSettings, applyUIFontScale } from "./ui/settingsWindow.js";
import { initOutlineEntryButton } from "./ui/outlineEntryButton.js";
import { initRewriteEntryButton, refreshRewriteEntryButton } from "./ui/rewriteEntryButton.js";
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
