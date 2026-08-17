// src/ui/loreReviewWindow.js

import { extractLoreFromHistory, previewExtractPrompt } from "../core/loreExtractor.js";
import { getAvailableWorldBooks, getCharacterWorldBook, saveLoreEntry } from "../core/worldInfoManager.js";
import { TitaniaLogger } from "../core/logger.js";
import { ensureFeatureCss } from "../utils/dom.js";

/**
 * 带超时的 Promise 包装器（与 context.js 保持一致）
 * @param {Promise} promise - 原始 Promise
 * @param {number} timeout - 超时时间（毫秒）
 * @param {string} errorMsg - 超时错误信息
 * @returns {Promise}
 */
function withTimeout(promise, timeout = 5000, errorMsg = 'Operation timed out') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(errorMsg)), timeout)
        )
    ]);
}

/**
 * 安全执行异步操作（带超时和错误捕获）
 * @param {Function} asyncFn - 异步函数
 * @param {number} timeout - 超时时间（毫秒）
 * @param {*} fallbackValue - 失败时的回退值
 * @param {string} operationName - 操作名称（用于日志）
 * @returns {Promise<*>} 操作结果或回退值
 */
async function safeAsyncOperation(asyncFn, timeout, fallbackValue, operationName) {
    try {
        return await withTimeout(
            asyncFn(),
            timeout,
            `${operationName} 超时`
        );
    } catch (e) {
        TitaniaLogger.warn(`${operationName} 失败`, e.message);
        return fallbackValue;
    }
}
import {
    getFeatureConnection,
} from "../core/connection.js";
import { normalizeApiBaseUrl, normalizeRewriteCustomProfiles } from "../core/apiProfileRegistry.js";
import {
    createApiConnectionEditor,
    mapConnectionProfilesToCustomProfiles,
    mapCustomProfilesToConnectionProfiles,
    renderApiConnectionEditorHTML,
} from "./shared/apiConnectionEditor.js";
import { getExtData, saveExtData } from "../utils/storage.js";
import { getContextData, getChatHistory } from "../core/context.js";

// 向量化和总结相关导入
import { generateSummary, buildVectorIndex, summaryToLoreEntry, previewSummaryPrompt, getVectorIndexStatus } from "../core/summarizer.js";
import { cleanTextForEmbedding, getCleaningStats, getTextCleaningConfig, batchCleanTexts } from "../core/textCleaner.js";
import { validateEmbeddingConfig, testEmbeddingConnection } from "../core/embeddings.js";
import {
    getIndexStatus,
    exportVectors,
    importVectors,
    downloadVectorExport,
    clearCharacterVectors,
    checkUnsavedVectors
} from "../core/vectorStore.js";

const FEATURE_KEY = "lore_extractor";

// 动态获取 SillyTavern 的 hideChatMessageRange 函数
let _hideChatMessageRange = null;
async function getHideChatMessageRange() {
    if (!_hideChatMessageRange) {
        try {
            // 尝试从 SillyTavern 的全局模块获取
            const chatsModule = await import("../../../chats.js");
            _hideChatMessageRange = chatsModule.hideChatMessageRange;
        } catch (e) {
            console.warn("Failed to import hideChatMessageRange:", e);
            _hideChatMessageRange = null;
        }
    }
    return _hideChatMessageRange;
}

let currentEntries = [];
let lastRawResponse = ""; // 保存最后一次 AI 原始响应
let lastSummary = ""; // 保存最后一次生成的总结
let lastSummaryMessages = null; // 保存最后一次发送的 messages
let currentCharacterId = ""; // 当前角色 ID（用于向量操作）
let currentCharacterName = ""; // 当前角色名称（用于显示）
let currentMode = "extract"; // 当前模式: "extract" | "summary"
let currentTotalFloors = 0; // 当前总楼层数
let lastAnalyzedRange = { start: 0, end: 0 }; // 上次分析的范围

/**
 * 确保 CSS 已加载
 * 路径由 css/manifest.js 统一解析，不再硬编码扁平路径（B1）
 */
function ensureCssLoaded() {
    ensureFeatureCss("lore-review.css");
}

/**
 * 获取当前功能配置
 */
function getFeatureConfig() {
    const data = getExtData();
    return data[`${FEATURE_KEY}_config`] || null;
}

/**
 * 获取已保存的分析范围设置
 */
function getSavedAnalysisSettings() {
    const data = getExtData();
    return data.analysis_settings || {};
}

/**
 * 保存分析范围设置
 */
function saveAnalysisSettings(settings) {
    const data = getExtData();
    data.analysis_settings = {
        ...(data.analysis_settings || {}),
        ...settings
    };
    saveExtData();
}

/**
 * 保存功能配置
 */
function saveFeatureConfig(config) {
    const data = getExtData();
    data[`${FEATURE_KEY}_config`] = config;
    saveExtData();
}

function getLoreSelectedProfileId() {
    const cfg = getFeatureConfig();
    return String(cfg?.profile_id || cfg?.selected_profile_id || "").trim();
}

function getLoreCustomProfiles() {
    const data = getExtData();
    const cfg = getFeatureConfig() || {};
    const fallback = {
        api_url: normalizeApiBaseUrl(String(data?.config?.url || "")),
        api_key: String(data?.config?.key || ""),
        model: String(data?.config?.model || "")
    };
    return normalizeRewriteCustomProfiles(cfg?.custom_profiles, fallback);
}

function getLoreProfilesByMode() {
    return getLoreCustomProfiles();
}

function resolveLoreProfileSelection(profileId = null) {
    const profiles = getLoreProfilesByMode();
    if (profiles.length === 0) return { profileId: "", profiles };
    const preferred = String(profileId || getLoreSelectedProfileId() || "").trim();
    const selected = profiles.some((p) => p.id === preferred) ? preferred : (profiles[0]?.id || "");
    return { profileId: selected, profiles };
}

/**
 * 显示设定集维护与聊天总结设置窗口
 * @param {Function} onSave - 保存后的回调
 */
async function showProfileConfigDialog(onSave) {
    // 移除旧弹窗
    $("#t-lore-settings-dialog").remove();

    const settingsDraft = {
        selectedProfileId: getLoreSelectedProfileId(),
        customProfiles: getLoreCustomProfiles(),
        embedding: {
            url: String(getExtData()?.embedding_config?.url || "").trim(),
            key: String(getExtData()?.embedding_config?.key || "").trim(),
            model: String(getExtData()?.embedding_config?.model || "text-embedding-3-small").trim(),
            dimensions: Number(getExtData()?.embedding_config?.dimensions) || null,
            text_cleaning: {
                remove_html_tags: getExtData()?.embedding_config?.text_cleaning?.remove_html_tags !== false,
                remove_style_tags: getExtData()?.embedding_config?.text_cleaning?.remove_style_tags !== false,
                remove_thinking_tags: getExtData()?.embedding_config?.text_cleaning?.remove_thinking_tags !== false,
                remove_ooc_tags: getExtData()?.embedding_config?.text_cleaning?.remove_ooc_tags !== false,
                remove_system_tags: getExtData()?.embedding_config?.text_cleaning?.remove_system_tags !== false,
                remove_markdown: getExtData()?.embedding_config?.text_cleaning?.remove_markdown === true,
                remove_macro_residue: getExtData()?.embedding_config?.text_cleaning?.remove_macro_residue !== false,
                remove_bracket_markers: getExtData()?.embedding_config?.text_cleaning?.remove_bracket_markers !== false,
                remove_bracket_content: getExtData()?.embedding_config?.text_cleaning?.remove_bracket_content !== false,
                custom_tags_to_remove: String(getExtData()?.embedding_config?.text_cleaning?.custom_tags_to_remove || "").trim(),
                min_text_length: Number(getExtData()?.embedding_config?.text_cleaning?.min_text_length) || 20
            },
            auto_vectorize: {
                enabled: getExtData()?.embedding_config?.auto_vectorize?.enabled === true,
                batch_threshold: Number(getExtData()?.embedding_config?.auto_vectorize?.batch_threshold) || 5,
                notify_user: getExtData()?.embedding_config?.auto_vectorize?.notify_user !== false
            }
        },
        summarizer: {
            template: String(getExtData()?.summarizer_config?.template || "structured"),
            use_vector_search: getExtData()?.summarizer_config?.use_vector_search !== false
        }
    };

    const html = `
    <div id="t-lore-settings-dialog" class="t-dialog-overlay t-root">
        <div class="t-dialog-box t-lore-settings-window">
            <div class="t-dialog-header t-lore-settings-header">
                <span><i class="fa-solid fa-gear"></i> 设置</span>
                <div class="t-dialog-close" id="t-profile-dialog-close"><i class="fa-solid fa-times"></i></div>
            </div>
            <div class="t-set-shell-body t-set-glass-body t-set-body">
                <div class="t-set-shell-nav t-set-glass-nav t-set-nav">
                    <div class="t-set-shell-tab t-set-glass-tab t-set-tab-btn active" data-tab="api"><i class="fa-solid fa-link"></i> API 连接</div>
                    <div class="t-set-shell-tab t-set-glass-tab t-set-tab-btn" data-tab="embedding"><i class="fa-solid fa-brain"></i> Embedding</div>
                </div>
                <div class="t-set-shell-content t-set-glass-content t-set-content">
                    <div class="t-set-page active" data-page="api">
                        ${renderApiConnectionEditorHTML({
                            ids: {
                                profileSelectId: "t-lore-settings-profile-select",
                                profileAddId: "t-lore-settings-new-profile",
                                profileDeleteId: "t-lore-settings-delete-profile",
                                profileNameId: "t-lore-settings-profile-name",
                                profileMetaId: "t-lore-settings-profile-meta",
                                profileTipId: "t-lore-settings-profile-tip",
                                fieldsWrapId: "t-lore-settings-conn-fields",
                                apiUrlId: "t-lore-settings-api-url",
                                apiKeyId: "t-lore-settings-api-key",
                                modelId: "t-lore-settings-model",
                                fetchModelsId: "t-lore-settings-fetch-models",
                                statusId: "t-lore-settings-status",
                                urlHintId: "t-lore-settings-url-hint",
                                stUrlDisplayId: "t-lore-settings-st-url",
                            },
                            classes: {
                                input: "t-input t-input--glass",
                                select: "t-input t-input--glass",
                                profileSelect: "t-input t-input--glass",
                                button: "t-btn t-btn-xs",
                            },
                            labels: {
                                profile: "API 方案",
                                apiUrl: "API 地址",
                                model: "模型",
                            },
                            flags: {
                                showProfileName: true,
                                showDeleteProfile: true,
                                showStream: false,
                                showMaxTokens: false,
                            },
                            values: {
                                statusText: "填写 API 后可刷新模型列表",
                            },
                        })}
                    </div>

                    <div class="t-set-page" data-page="embedding">
                        <div class="t-form-group">
                            <label class="t-form-label">Embedding API 地址</label>
                            <input id="t-lore-embed-url" class="t-input t-input--glass" type="text" placeholder="例如: https://api.openai.com/v1">

                            <label class="t-form-label" style="margin-top:8px;">Embedding API Key</label>
                            <input id="t-lore-embed-key" class="t-input t-input--glass" type="password" placeholder="sk-...">

                            <label class="t-form-label" style="margin-top:8px;">Embedding 模型</label>
                            <div class="t-lore-settings-model-row">
                                <select id="t-lore-embed-model" class="t-input t-input--glass" style="flex:1;"></select>
                                <button id="t-lore-embed-fetch-models" class="t-btn t-btn-xs" type="button" title="获取模型列表"><i class="fa-solid fa-rotate"></i></button>
                            </div>

                            <label class="t-form-label" style="margin-top:8px;">向量维度（可选）</label>
                            <input id="t-lore-embed-dimensions" class="t-input t-input--glass" type="number" min="256" max="3072" step="256" placeholder="留空使用模型默认值">

                            <div style="margin-top:10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                                <button id="t-lore-embed-test" class="t-btn t-btn-xs" type="button"><i class="fa-solid fa-vial"></i> 测试连接</button>
                                <span id="t-lore-embed-test-result" style="font-size:0.82em; color:#8da5b8;"></span>
                            </div>
                        </div>

                        <div class="t-form-group">
                            <label class="t-form-label">文本清洗设置</label>
                            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:0.84em;">
                                <label><input id="t-lore-clean-html" type="checkbox"> 移除 HTML 标签</label>
                                <label><input id="t-lore-clean-style" type="checkbox"> 移除 style 标签</label>
                                <label><input id="t-lore-clean-thinking" type="checkbox"> 移除 thinking 标签</label>
                                <label><input id="t-lore-clean-ooc" type="checkbox"> 移除 ooc 标签</label>
                                <label><input id="t-lore-clean-system" type="checkbox"> 移除系统标签</label>
                                <label><input id="t-lore-clean-markdown" type="checkbox"> 移除 Markdown</label>
                                <label><input id="t-lore-clean-macro" type="checkbox"> 移除宏残留 {{}}</label>
                                <label><input id="t-lore-clean-bracket" type="checkbox"> 移除 [System] 等标记</label>
                                <label><input id="t-lore-clean-bracket-all" type="checkbox"> 移除所有 [...] 内容</label>
                            </div>
                            <label class="t-form-label" style="margin-top:8px;">自定义移除标签（逗号分隔）</label>
                            <input id="t-lore-clean-custom-tags" class="t-input t-input--glass" type="text" placeholder="例如: internal, debug, author_note">
                            <label class="t-form-label" style="margin-top:8px;">最小文本长度</label>
                            <input id="t-lore-clean-min-length" class="t-input t-input--glass" type="number" min="10" max="200">
                        </div>

                        <div class="t-form-group">
                            <label class="t-form-label">自动向量化</label>
                            <label><input id="t-lore-auto-vectorize" type="checkbox"> 启用自动向量化</label>
                            <div id="t-lore-auto-vectorize-panel" style="margin-top:8px;">
                                <label class="t-form-label">累积消息阈值</label>
                                <input id="t-lore-auto-vectorize-threshold" class="t-input t-input--glass" type="number" min="3" max="50">
                                <label style="margin-top:8px; display:block;"><input id="t-lore-auto-vectorize-notify" type="checkbox"> 显示向量化完成通知</label>
                            </div>
                        </div>

                        <div class="t-form-group">
                            <label class="t-form-label">聊天总结设置</label>
                            <label class="t-form-label">默认总结模板</label>
                            <select id="t-lore-summary-template" class="t-input t-input--glass">
                                <option value="structured">结构化 (分章节)</option>
                                <option value="narrative">叙事性 (故事风格)</option>
                            </select>
                            <label style="margin-top:8px; display:block;"><input id="t-lore-use-vector" type="checkbox"> 使用向量语义检索增强</label>
                        </div>
                    </div>
                </div>
            </div>
            <div class="t-dialog-footer t-lore-settings-footer">
                <button id="t-btn-cancel-profile" class="t-btn">取消</button>
                <button id="t-btn-save-profile" class="t-btn t-btn-primary" disabled>
                    <i class="fa-solid fa-check"></i> 保存设置
                </button>
            </div>
        </div>
    </div>
    `;

    $("body").append(html);

    const loreConnectionEditor = createApiConnectionEditor({
        root: $("#t-lore-settings-dialog"),
        ids: {
            profileSelectId: "t-lore-settings-profile-select",
            profileAddId: "t-lore-settings-new-profile",
            profileDeleteId: "t-lore-settings-delete-profile",
            profileNameId: "t-lore-settings-profile-name",
            profileTipId: "t-lore-settings-profile-tip",
            apiUrlId: "t-lore-settings-api-url",
            apiKeyId: "t-lore-settings-api-key",
            modelId: "t-lore-settings-model",
            fetchModelsId: "t-lore-settings-fetch-models",
            statusId: "t-lore-settings-status",
        },
        profiles: mapCustomProfilesToConnectionProfiles(settingsDraft.customProfiles, "gpt-3.5-turbo"),
        activeProfileId: settingsDraft.selectedProfileId,
        profileIdPrefix: "lore_custom",
        autoFetchOnInput: false,
        autoFetchOnProfileSwitch: false,
        onChange: (nextState) => {
            settingsDraft.customProfiles = mapConnectionProfilesToCustomProfiles(nextState.profiles, "gpt-3.5-turbo");
            settingsDraft.selectedProfileId = nextState.activeProfileId;
            $("#t-btn-save-profile").prop("disabled", !settingsDraft.selectedProfileId);
        },
    });
    loreConnectionEditor.bind();
    loreConnectionEditor.render();
    $("#t-btn-save-profile").prop("disabled", !settingsDraft.selectedProfileId);

    const initEmbeddingFields = () => {
        const emb = settingsDraft.embedding;
        $("#t-lore-embed-url").val(emb.url || "");
        $("#t-lore-embed-key").val(emb.key || "");
        const $model = $("#t-lore-embed-model");
        $model.empty();
        const commonModels = ["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"];
        const currentModel = emb.model || "text-embedding-3-small";
        commonModels.forEach((m) => {
            $model.append(`<option value="${escapeHtml(m)}" ${m === currentModel ? "selected" : ""}>${escapeHtml(m)}</option>`);
        });
        if (!commonModels.includes(currentModel)) {
            $model.prepend(`<option value="${escapeHtml(currentModel)}" selected>${escapeHtml(currentModel)} (当前)</option>`);
        }
        $("#t-lore-embed-dimensions").val(emb.dimensions || "");

        $("#t-lore-clean-html").prop("checked", emb.text_cleaning.remove_html_tags !== false);
        $("#t-lore-clean-style").prop("checked", emb.text_cleaning.remove_style_tags !== false);
        $("#t-lore-clean-thinking").prop("checked", emb.text_cleaning.remove_thinking_tags !== false);
        $("#t-lore-clean-ooc").prop("checked", emb.text_cleaning.remove_ooc_tags !== false);
        $("#t-lore-clean-system").prop("checked", emb.text_cleaning.remove_system_tags !== false);
        $("#t-lore-clean-markdown").prop("checked", emb.text_cleaning.remove_markdown === true);
        $("#t-lore-clean-macro").prop("checked", emb.text_cleaning.remove_macro_residue !== false);
        $("#t-lore-clean-bracket").prop("checked", emb.text_cleaning.remove_bracket_markers !== false);
        $("#t-lore-clean-bracket-all").prop("checked", emb.text_cleaning.remove_bracket_content !== false);
        $("#t-lore-clean-custom-tags").val(emb.text_cleaning.custom_tags_to_remove || "");
        $("#t-lore-clean-min-length").val(emb.text_cleaning.min_text_length || 20);

        $("#t-lore-auto-vectorize").prop("checked", emb.auto_vectorize.enabled === true);
        $("#t-lore-auto-vectorize-threshold").val(emb.auto_vectorize.batch_threshold || 5);
        $("#t-lore-auto-vectorize-notify").prop("checked", emb.auto_vectorize.notify_user !== false);
        $("#t-lore-auto-vectorize-panel").toggle(emb.auto_vectorize.enabled === true);

        $("#t-lore-summary-template").val(settingsDraft.summarizer.template === "narrative" ? "narrative" : "structured");
        $("#t-lore-use-vector").prop("checked", settingsDraft.summarizer.use_vector_search !== false);
    };

    const fetchEmbeddingModelListDraft = async (showToast = true) => {
        const $btn = $("#t-lore-embed-fetch-models");
        const $sel = $("#t-lore-embed-model");
        const urlInput = String($("#t-lore-embed-url").val() || "").trim().replace(/\/+$/, "");
        const key = String($("#t-lore-embed-key").val() || "").trim();
        if (!urlInput) {
            if (showToast && window.toastr) toastr.warning("请先填写 Embedding API 地址");
            return;
        }
        try {
            $btn.prop("disabled", true);
            const res = await fetch(`${urlInput}/models`, {
                method: "GET",
                headers: key ? { Authorization: `Bearer ${key}` } : {}
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const models = Array.isArray(json?.data) ? json.data : (Array.isArray(json?.models) ? json.models : []);
            const current = String($sel.val() || "").trim();
            $sel.empty();
            models.forEach((m) => {
                const id = String(m?.id || m || "").trim();
                if (!id) return;
                $sel.append(`<option value="${escapeHtml(id)}" ${id === current ? "selected" : ""}>${escapeHtml(id)}</option>`);
            });
            if (showToast && window.toastr) toastr.success(`已获取 ${models.length} 个 Embedding 模型`);
        } catch (e) {
            if (showToast && window.toastr) toastr.error(`获取 Embedding 模型失败: ${e.message || "未知错误"}`);
        } finally {
            $btn.prop("disabled", false);
        }
    };

    const testEmbeddingConnectionDraft = async () => {
        const $btn = $("#t-lore-embed-test");
        const $result = $("#t-lore-embed-test-result");
        const url = String($("#t-lore-embed-url").val() || "").trim().replace(/\/+$/, "");
        const key = String($("#t-lore-embed-key").val() || "").trim();
        const model = String($("#t-lore-embed-model").val() || "").trim();
        const dimensions = parseInt($("#t-lore-embed-dimensions").val(), 10) || null;
        if (!url) {
            $result.text("请填写 API 地址");
            return;
        }
        try {
            $btn.prop("disabled", true);
            $result.text("测试中...");
            const body = {
                model: model || "text-embedding-3-small",
                input: "Hello, this is a test message for embedding."
            };
            if (dimensions) body.dimensions = dimensions;
            const res = await fetch(`${url}/embeddings`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(key ? { Authorization: `Bearer ${key}` } : {})
                },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const dims = json?.data?.[0]?.embedding?.length;
            if (!dims) throw new Error("响应格式异常");
            $result.text(`连接成功，向量维度: ${dims}`);
        } catch (e) {
            $result.text(`连接失败: ${e.message || "未知错误"}`);
        } finally {
            $btn.prop("disabled", false);
        }
    };

    initEmbeddingFields();
    // 绑定事件
    $("#t-profile-dialog-close, #t-btn-cancel-profile").on("click", () => {
        $("#t-lore-settings-dialog").remove();
    });

    $("#t-lore-settings-dialog .t-set-tab-btn").on("click", function () {
        const tab = String($(this).data("tab") || "api");
        $("#t-lore-settings-dialog .t-set-tab-btn").removeClass("active");
        $(this).addClass("active");
        $("#t-lore-settings-dialog .t-set-page").removeClass("active");
        $(`#t-lore-settings-dialog .t-set-page[data-page='${tab}']`).addClass("active");
    });

    $("#t-lore-embed-fetch-models").on("click", async function (e) {
        e.preventDefault();
        await fetchEmbeddingModelListDraft(true);
    });

    $("#t-lore-embed-test").on("click", async function (e) {
        e.preventDefault();
        await testEmbeddingConnectionDraft();
    });

    $("#t-lore-auto-vectorize").on("change", function () {
        $("#t-lore-auto-vectorize-panel").toggle($(this).is(":checked"));
    });

    $("#t-btn-save-profile").on("click", function () {
        const nextState = loreConnectionEditor.getState();
        settingsDraft.customProfiles = mapConnectionProfilesToCustomProfiles(nextState.profiles, "gpt-3.5-turbo");
        settingsDraft.selectedProfileId = nextState.activeProfileId;
        if (!settingsDraft.selectedProfileId) {
            if (window.toastr) toastr.warning("请选择一个 API 方案");
            return;
        }

        const data = getExtData();
        data[`${FEATURE_KEY}_config`] = {
            profile_mode: "custom",
            profile_id: settingsDraft.selectedProfileId,
            custom_profiles: settingsDraft.customProfiles,
            selected_profile_id: settingsDraft.selectedProfileId,
            model_override: null
        };
        data.embedding_config = {
            url: String($("#t-lore-embed-url").val() || "").trim(),
            key: String($("#t-lore-embed-key").val() || "").trim(),
            model: String($("#t-lore-embed-model").val() || "text-embedding-3-small").trim() || "text-embedding-3-small",
            dimensions: parseInt($("#t-lore-embed-dimensions").val(), 10) || null,
            text_cleaning: {
                remove_html_tags: $("#t-lore-clean-html").is(":checked"),
                remove_style_tags: $("#t-lore-clean-style").is(":checked"),
                remove_thinking_tags: $("#t-lore-clean-thinking").is(":checked"),
                remove_ooc_tags: $("#t-lore-clean-ooc").is(":checked"),
                remove_system_tags: $("#t-lore-clean-system").is(":checked"),
                remove_markdown: $("#t-lore-clean-markdown").is(":checked"),
                remove_macro_residue: $("#t-lore-clean-macro").is(":checked"),
                remove_bracket_markers: $("#t-lore-clean-bracket").is(":checked"),
                remove_bracket_content: $("#t-lore-clean-bracket-all").is(":checked"),
                custom_tags_to_remove: String($("#t-lore-clean-custom-tags").val() || "").trim(),
                min_text_length: parseInt($("#t-lore-clean-min-length").val(), 10) || 20
            },
            auto_vectorize: {
                enabled: $("#t-lore-auto-vectorize").is(":checked"),
                batch_threshold: parseInt($("#t-lore-auto-vectorize-threshold").val(), 10) || 5,
                notify_user: $("#t-lore-auto-vectorize-notify").is(":checked")
            }
        };
        data.summarizer_config = {
            ...(data.summarizer_config || {}),
            selected_profile_id: settingsDraft.selectedProfileId || null,
            model_override: null,
            template: String($("#t-lore-summary-template").val() || "structured"),
            use_vector_search: $("#t-lore-use-vector").is(":checked")
        };
        saveExtData();

        $("#t-lore-settings-dialog").remove();

        if (window.toastr) {
            toastr.success("已更新设置");
        }

        if (onSave) onSave();
    });
}

/**
 * 获取当前配置的模型名称
 */
function getCurrentConfiguredModel() {
    const conn = getFeatureConnection(FEATURE_KEY);
    return conn?.model || "未配置";
}

/**
 * 显示原始响应弹窗
 * @param {string} rawContent - 原始响应内容
 * @param {boolean} isError - 是否是错误状态（解析失败）
 */
function showRawResponseDialog(rawContent, isError = false) {
    // 移除旧弹窗
    $("#t-raw-response-dialog").remove();

    const title = isError ? "解析失败 - 原始响应" : "AI 原始响应";
    const headerClass = isError ? "t-dialog-header-error" : "";

    const html = `
    <div id="t-raw-response-dialog" class="t-dialog-overlay t-root">
        <div class="t-dialog-box" style="max-width: 800px; max-height: 80vh;">
            <div class="t-dialog-header ${headerClass}">
                <span><i class="fa-solid fa-code"></i> ${title}</span>
                <div class="t-dialog-close" id="t-raw-response-close"><i class="fa-solid fa-times"></i></div>
            </div>
            <div class="t-dialog-body" style="padding: 0;">
                ${isError ? `
                <div style="padding: 15px; background: rgba(231, 76, 60, 0.1); border-bottom: 1px solid rgba(231, 76, 60, 0.3);">
                    <i class="fa-solid fa-exclamation-triangle" style="color: #e74c3c;"></i>
                    <span style="color: #e74c3c;">JSON 解析失败，请检查下方原始内容是否符合预期格式</span>
                </div>
                ` : ''}
                <div style="padding: 15px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <span style="color: #888; font-size: 0.9em;">
                            <i class="fa-solid fa-file-lines"></i> 响应长度: ${rawContent?.length || 0} 字符
                        </span>
                        <button id="t-btn-copy-raw" class="t-btn t-btn-xs">
                            <i class="fa-solid fa-copy"></i> 复制内容
                        </button>
                    </div>
                    <pre id="t-raw-response-content" style="
                        background: #1a1a2e;
                        border: 1px solid #333;
                        border-radius: 6px;
                        padding: 15px;
                        max-height: 50vh;
                        overflow: auto;
                        white-space: pre-wrap;
                        word-break: break-word;
                        font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                        font-size: 0.9em;
                        color: #ddd;
                        line-height: 1.5;
                    ">${escapeHtml(rawContent || "(空)")}</pre>
                </div>
            </div>
            <div class="t-dialog-footer">
                <button id="t-btn-close-raw" class="t-btn">关闭</button>
            </div>
        </div>
    </div>
    `;

    $("body").append(html);

    // 绑定事件
    $("#t-raw-response-close, #t-btn-close-raw").on("click", () => {
        $("#t-raw-response-dialog").remove();
    });

    $("#t-btn-copy-raw").on("click", function () {
        const content = rawContent || "";
        navigator.clipboard.writeText(content).then(() => {
            $(this).html('<i class="fa-solid fa-check"></i> 已复制');
            setTimeout(() => {
                $(this).html('<i class="fa-solid fa-copy"></i> 复制内容');
            }, 2000);
        }).catch(() => {
            if (window.toastr) toastr.error("复制失败");
        });
    });
}

/**
 * HTML 转义
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 显示设定提取审查窗口（优化版：先显示框架，再异步加载数据）
 */
export async function showLoreReviewWindow() {
    ensureCssLoaded();

    // 移除旧窗口
    $("#t-lore-review-overlay").remove();

    // === 第一阶段：同步获取基本信息，立即显示窗口 ===
    const featureConn = getFeatureConnection(FEATURE_KEY);
    const currentModel = featureConn?.model || "未知";
    const currentProfileName = featureConn?.profileName || "未知";

    // 同步获取聊天历史（快速）
    try {
        const chatHistory = getChatHistory();
        currentTotalFloors = chatHistory?.length || 0;
    } catch (e) {
        TitaniaLogger.warn("获取聊天历史失败", e);
        currentTotalFloors = 0;
    }

    // 读取用户保存的分析范围设置（同步，从 localStorage）
    const savedSettings = getSavedAnalysisSettings();
    const extractLimit = savedSettings.extractLimit || 2;
    const summaryLimit = savedSettings.summaryLimit || 20;

    // 使用占位符，稍后异步更新
    const indexStatusHtml = `<span class="t-index-status t-index-loading"><i class="fa-solid fa-spinner fa-spin"></i> 检查中...</span>`;
    const lastExportTime = "加载中...";

    // 临时设置角色信息（稍后异步更新）
    currentCharacterId = "loading...";
    currentCharacterName = "加载中...";

    // 构建基础 HTML
    const html = `
    <div id="t-lore-review-overlay" class="t-overlay t-root">
        <div class="t-window t-lore-review-window" style="max-width: 1000px;">
            <div class="t-window-header">
                <div class="t-window-title">
                    <i class="fa-solid fa-brain"></i> 设定集维护与聊天总结
                </div>
                <div class="t-window-controls">
                    <div class="t-window-icon" id="t-config-btn" title="设置">
                        <i class="fa-solid fa-gear"></i>
                    </div>
                    <div class="t-window-close" id="t-lore-review-close"><i class="fa-solid fa-times"></i></div>
                </div>
            </div>
            
            <!-- 当前配置信息栏 -->
            <div class="t-config-info-bar">
                <span class="t-config-label"><i class="fa-solid fa-link"></i> 配置:</span>
                <span class="t-config-value" id="t-current-profile">${currentProfileName}</span>
                <span class="t-config-separator">|</span>
                <span class="t-config-label"><i class="fa-solid fa-microchip"></i> 模型:</span>
                <span class="t-config-value" id="t-current-model">${currentModel}</span>
                <span class="t-config-separator">|</span>
                <span class="t-config-label"><i class="fa-solid fa-database"></i> 向量索引:</span>
                <span id="t-index-status-display">${indexStatusHtml}</span>
            </div>

            <div class="t-window-body">
                <!-- 功能切换栏 -->
                <div class="t-mode-tabs">
                    <button class="t-mode-tab active" data-mode="extract">
                        <i class="fa-solid fa-search"></i> 设定提取
                    </button>
                    <button class="t-mode-tab" data-mode="summary">
                        <i class="fa-solid fa-file-alt"></i> 智能总结
                    </button>
                    <button class="t-mode-tab" data-mode="vector">
                        <i class="fa-solid fa-database"></i> 向量索引
                    </button>
                </div>

                <!-- 设定提取面板 -->
                <div id="t-panel-extract" class="t-mode-panel active">
                    <!-- 顶部控制栏 -->
                    <div class="t-lore-controls">
                        <div class="t-control-group">
                            <label>分析范围:</label>
                            <input type="number" id="t-lore-history-limit" value="${extractLimit}" min="1" max="${currentTotalFloors || 100}" style="width: 60px;">
                            <span class="t-floor-info">/ ${currentTotalFloors} 楼</span>
                            <div class="t-quick-btns">
                                <button class="t-quick-btn" data-target="extract" data-value="10" title="最近10楼">10</button>
                                <button class="t-quick-btn" data-target="extract" data-value="50" title="最近50楼">50</button>
                                <button class="t-quick-btn" data-target="extract" data-value="100" title="最近100楼">100</button>
                                <button class="t-quick-btn t-quick-btn-all" data-target="extract" data-value="all" title="全部楼层">全部</button>
                            </div>
                        </div>
                        <div class="t-control-buttons">
                            <button id="t-btn-preview-extract-prompt" class="t-btn" title="预览将要发送给 AI 的完整提示词（不会发送请求）">
                                <i class="fa-solid fa-eye"></i> 预览提示词
                            </button>
                            <button id="t-btn-start-extract" class="t-btn t-btn-primary">
                                <i class="fa-solid fa-search"></i> 开始分析
                            </button>
                            <button id="t-btn-view-raw" class="t-btn" style="display: none;" title="查看 AI 返回的原始内容">
                                <i class="fa-solid fa-code"></i> 查看原始响应
                            </button>
                        </div>
                    </div>

                <!-- 主内容区 -->
                <div class="t-lore-content">
                    <!-- 左侧：条目列表 -->
                    <div class="t-lore-list-container">
                        <div class="t-list-header">
                            <span>提取结果</span>
                            <div class="t-list-actions">
                                <button id="t-btn-select-all" class="t-btn t-btn--quiet t-btn--xs">全选</button>
                                <button id="t-btn-deselect-all" class="t-btn t-btn--quiet t-btn--xs">全不选</button>
                            </div>
                        </div>
                        <div id="t-lore-entries-list" class="t-lore-list">
                            <div class="t-empty-state">
                                <i class="fa-solid fa-robot"></i>
                                <p>点击“开始分析”以提取设定</p>
                            </div>
                        </div>
                    </div>

                    <!-- 右侧：详情编辑 -->
                    <div class="t-lore-editor-container">
                        <!-- 移动端返回按钮栏 -->
                        <div class="t-mobile-editor-header">
                            <button class="t-mobile-back-btn" id="t-mobile-back-to-list">
                                <i class="fa-solid fa-arrow-left"></i> 返回列表
                            </button>
                            <span class="t-mobile-editor-title" id="t-mobile-edit-title">编辑条目</span>
                            <div class="t-mobile-nav-btns">
                                <button class="t-mobile-nav-btn" id="t-mobile-prev-entry" title="上一条">
                                    <i class="fa-solid fa-chevron-left"></i>
                                </button>
                                <button class="t-mobile-nav-btn" id="t-mobile-next-entry" title="下一条">
                                    <i class="fa-solid fa-chevron-right"></i>
                                </button>
                            </div>
                        </div>
                        <div class="t-editor-header">
                            <span>条目详情</span>
                        </div>
                        <div id="t-lore-editor" class="t-lore-editor" style="display:none;">
                            <div class="t-form-group">
                                <label>关键词 (Keys)</label>
                                <input type="text" id="t-edit-keys" placeholder="Key1, Key2, ...">
                                <small>用逗号分隔多个关键词</small>
                            </div>
                            <div class="t-form-group">
                                <label>分类 (Category)</label>
                                <select id="t-edit-category">
                                    <option value="Location">地点 (Location)</option>
                                    <option value="Character">人物 (Character)</option>
                                    <option value="Item">物品 (Item)</option>
                                    <option value="Event">事件 (Event)</option>
                                    <option value="Other">其他 (Other)</option>
                                </select>
                            </div>
                            <div class="t-form-group">
                                <label>内容 (Content)</label>
                                <textarea id="t-edit-content" rows="8"></textarea>
                            </div>
                            <div class="t-form-group">
                                <label>提取理由 (Reason)</label>
                                <div id="t-edit-reason" class="t-static-text"></div>
                            </div>
                            <div class="t-form-group" id="t-update-info-group" style="display:none;">
                                <label>关联更新 (Matched Entry)</label>
                                <div class="t-update-info-box">
                                    <div id="t-matched-entry-info"></div>
                                    <button id="t-btn-change-match" class="t-btn t-btn-xs">更改关联</button>
                                </div>
                                
                                <!-- 原有内容对比区域 -->
                                <div class="t-original-content-section">
                                    <div class="t-original-header">
                                        <span><i class="fa-solid fa-history"></i> 原有内容</span>
                                        <button id="t-btn-toggle-original" class="t-btn t-btn-xs" title="展开/收起">
                                            <i class="fa-solid fa-chevron-down"></i>
                                        </button>
                                    </div>
                                    <div id="t-original-content-box" class="t-original-content-box">
                                        <div id="t-original-content-text" class="t-original-content-text"></div>
                                    </div>
                                </div>
                                
                                <!-- 保存模式选择 -->
                                <div class="t-save-mode-section">
                                    <label>保存模式:</label>
                                    <div class="t-save-mode-options">
                                        <label class="t-radio-label t-radio-card t-radio-card--warning">
                                            <input type="radio" class="t-choice-input t-choice-input--lg" name="t-save-mode" value="replace" checked>
                                            <span class="t-radio-card__title"><i class="fa-solid fa-exchange-alt"></i> 替换</span>
                                            <small class="t-radio-card__description">用新内容替换原有内容</small>
                                        </label>
                                        <label class="t-radio-label t-radio-card t-radio-card--success">
                                            <input type="radio" class="t-choice-input t-choice-input--lg" name="t-save-mode" value="append">
                                            <span class="t-radio-card__title"><i class="fa-solid fa-plus"></i> 追加</span>
                                            <small class="t-radio-card__description">在原有内容后追加新内容</small>
                                        </label>
                                        <label class="t-radio-label t-radio-card">
                                            <input type="radio" class="t-choice-input t-choice-input--lg" name="t-save-mode" value="prepend">
                                            <span class="t-radio-card__title"><i class="fa-solid fa-arrow-up"></i> 前置</span>
                                            <small class="t-radio-card__description">在原有内容前插入新内容</small>
                                        </label>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div id="t-editor-placeholder" class="t-empty-state">
                            <p>请在左侧选择一个条目进行编辑</p>
                        </div>
                    </div>
                </div>

                    <!-- 底部操作栏 -->
                    <div class="t-window-footer">
                        <div class="t-target-select">
                            <label>保存到:</label>
                            <select id="t-target-book">
                                <option value="" disabled selected>加载中...</option>
                            </select>
                        </div>
                        <div class="t-footer-actions">
                            <button id="t-btn-save-selected" class="t-btn t-btn-success" disabled>
                                <i class="fa-solid fa-save"></i> 保存选中条目
                            </button>
                        </div>
                    </div>
                </div>

                <!-- 智能总结面板 -->
                <div id="t-panel-summary" class="t-mode-panel" style="display: none;">
                    <div class="t-lore-controls">
                        <div class="t-control-group">
                            <label>分析范围:</label>
                            <input type="number" id="t-summary-history-limit" value="${summaryLimit}" min="1" max="${currentTotalFloors || 200}" style="width: 60px;">
                            <span class="t-floor-info">/ ${currentTotalFloors} 楼</span>
                            <div class="t-quick-btns">
                                <button class="t-quick-btn" data-target="summary" data-value="20" title="最近20楼">20</button>
                                <button class="t-quick-btn" data-target="summary" data-value="50" title="最近50楼">50</button>
                                <button class="t-quick-btn" data-target="summary" data-value="100" title="最近100楼">100</button>
                                <button class="t-quick-btn t-quick-btn-all" data-target="summary" data-value="all" title="全部楼层">全部</button>
                            </div>
                        </div>
                        <div class="t-control-group">
                            <label>总结模板:</label>
                            <select id="t-summary-template" style="width: 120px;">
                                <option value="structured">结构化摘要</option>
                                <option value="narrative">叙事性总结</option>
                                <option value="custom">自定义提示词</option>
                            </select>
                        </div>
                        <div class="t-control-group">
                            <label>
                                <input type="checkbox" id="t-use-vector-search" class="t-choice-input t-choice-input--inline-gap t-choice-input--muted-disabled" disabled>
                                使用语义检索增强
                            </label>
                        </div>
                        <div class="t-control-buttons">
                            <button id="t-btn-preview-prompt" class="t-btn" title="预览将要发送给 AI 的完整提示词（不会发送请求）">
                                <i class="fa-solid fa-eye"></i> 预览提示词
                            </button>
                            <button id="t-btn-generate-summary" class="t-btn t-btn-primary">
                                <i class="fa-solid fa-magic"></i> 生成总结
                            </button>
                        </div>
                    </div>

                    <!-- 自定义提示词区域（可折叠） -->
                    <div id="t-custom-prompt-section" class="t-custom-prompt-section" style="display: none;">
                        <div class="t-custom-prompt-header" id="t-toggle-custom-prompt">
                            <i class="fa-solid fa-chevron-down"></i>
                            <span>自定义系统提示词</span>
                            <button id="t-btn-reset-prompt" class="t-btn t-btn-xs" title="恢复默认提示词">
                                <i class="fa-solid fa-undo"></i> 恢复默认
                            </button>
                        </div>
                        <div class="t-custom-prompt-body">
                            <textarea id="t-custom-prompt-input" rows="8" placeholder="在此输入自定义系统提示词...&#10;&#10;可用变量：&#10;- 聊天历史会自动附加在 user 消息中&#10;- 相关历史（如启用语义检索）也会附加"></textarea>
                            <div class="t-prompt-hint">
                                <i class="fa-solid fa-info-circle"></i>
                                提示：系统提示词定义 AI 的角色和任务。聊天历史会作为 user 消息发送。
                            </div>
                        </div>
                    </div>

                    <div class="t-summary-content">
                        <div class="t-summary-header">
                            <span>总结结果</span>
                            <div class="t-summary-actions">
                                <button id="t-btn-copy-summary" class="t-btn t-btn-xs" style="display: none;">
                                    <i class="fa-solid fa-copy"></i> 复制
                                </button>
                                <button id="t-btn-save-summary" class="t-btn t-btn-xs t-btn-success" style="display: none;">
                                    <i class="fa-solid fa-save"></i> 保存为条目
                                </button>
                            </div>
                        </div>
                        <div id="t-summary-result" class="t-summary-result">
                            <div class="t-empty-state">
                                <i class="fa-solid fa-file-alt"></i>
                                <p>点击「生成总结」开始分析聊天历史</p>
                                <small style="color: #666;">启用「语义检索增强」可以召回相关的历史事件</small>
                            </div>
                        </div>
                    </div>

                    <!-- 隐藏/取消隐藏楼层操作区 -->
                    <div id="t-hide-floors-section" class="t-hide-floors-section">
                        <div class="t-hide-floors-header">
                            <i class="fa-solid fa-eye-slash"></i>
                            <span>隐藏/取消隐藏楼层</span>
                            <span id="t-hidden-status" class="t-hidden-status"></span>
                        </div>
                        <div class="t-hide-floors-body">
                            <div class="t-hide-range-inputs">
                                <label>从第</label>
                                <input type="number" id="t-hide-start" min="1" value="1" style="width: 70px;">
                                <label>楼 到第</label>
                                <input type="number" id="t-hide-end" min="1" value="1" style="width: 70px;">
                                <label>楼</label>
                                <span class="t-hide-count">(共 <span id="t-hide-count-num">0</span> 楼)</span>
                            </div>
                            <div class="t-hide-quick-btns">
                                <button class="t-quick-btn t-hide-quick" data-value="50" title="最近50楼">最近50楼</button>
                                <button class="t-quick-btn t-hide-quick" data-value="100" title="最近100楼">最近100楼</button>
                                <button class="t-quick-btn t-hide-quick" data-value="analyzed" title="恢复为分析的范围">分析范围</button>
                                <button class="t-quick-btn t-quick-btn-all t-hide-quick" data-value="all" title="全部楼层">全部</button>
                            </div>
                            <div class="t-hide-actions">
                                <button id="t-btn-hide-floors" class="t-btn t-btn-primary">
                                    <i class="fa-solid fa-eye-slash"></i> 一键隐藏
                                </button>
                                <button id="t-btn-unhide-floors" class="t-btn">
                                    <i class="fa-solid fa-eye"></i> 取消隐藏
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="t-window-footer">
                        <div class="t-target-select">
                            <label>保存到:</label>
                            <select id="t-summary-target-book">
                                <option value="" disabled selected>加载中...</option>
                            </select>
                        </div>
                    </div>
                </div>

                <!-- 向量索引管理面板 -->
                <div id="t-panel-vector" class="t-mode-panel" style="display: none;">
                    <div class="t-vector-status-card">
                        <h3><i class="fa-solid fa-database"></i> 向量索引状态</h3>
                        <div class="t-vector-info">
                            <div class="t-info-row">
                                <span class="t-info-label">当前角色:</span>
                                <span class="t-info-value" id="t-vector-char-name">${currentCharacterName}</span>
                            </div>
                            <div class="t-info-row">
                                <span class="t-info-label">索引状态:</span>
                                <span class="t-info-value" id="t-vector-status">加载中...</span>
                            </div>
                            <div class="t-info-row">
                                <span class="t-info-label">Embedding 模型:</span>
                                <span class="t-info-value" id="t-vector-model">加载中...</span>
                            </div>
                            <div class="t-info-row">
                                <span class="t-info-label">上次导出:</span>
                                <span class="t-info-value" id="t-vector-last-export">${lastExportTime}</span>
                            </div>
                        </div>
                    </div>

                    <div class="t-vector-actions-card">
                        <h3><i class="fa-solid fa-tools"></i> 操作</h3>
                        
                        <!-- 增量状态提示 -->
                        <div id="t-incremental-status" class="t-incremental-status" style="display: none;">
                            <div class="t-incremental-info">
                                <i class="fa-solid fa-info-circle"></i>
                                <span id="t-incremental-message">检测到新消息</span>
                            </div>
                        </div>
                        
                        <div class="t-action-group">
                            <div class="t-action-item">
                                <div class="t-build-index-buttons">
                                    <button id="t-btn-build-index" class="t-btn t-btn-primary" style="flex: 1;">
                                        <i class="fa-solid fa-plus"></i> 增量更新
                                    </button>
                                    <button id="t-btn-rebuild-index" class="t-btn" title="清除现有索引并完整重建">
                                        <i class="fa-solid fa-redo"></i> 重建
                                    </button>
                                </div>
                                <small>增量更新只处理新消息，重建会清除现有索引</small>
                            </div>
                            
                            <div id="t-index-progress" style="display: none; margin-top: 10px;">
                                <div class="t-progress-bar">
                                    <div class="t-progress-fill" style="width: 0%;"></div>
                                </div>
                                <div class="t-progress-text">准备中...</div>
                            </div>
                        </div>

                        <div class="t-action-group" style="margin-top: 20px;">
                            <div class="t-action-row">
                                <button id="t-btn-export-vectors" class="t-btn" disabled>
                                    <i class="fa-solid fa-download"></i> 导出索引
                                </button>
                                <button id="t-btn-import-vectors" class="t-btn">
                                    <i class="fa-solid fa-upload"></i> 导入索引
                                </button>
                                <button id="t-btn-clear-vectors" class="t-btn t-btn-danger" disabled>
                                    <i class="fa-solid fa-trash"></i> 清除索引
                                </button>
                            </div>
                            <small>导出的索引文件可用于备份或迁移</small>
                        </div>

                        <div class="t-action-group" style="margin-top: 20px;">
                            <h4><i class="fa-solid fa-broom"></i> 文本清洗预览</h4>
                            <p style="color: #888; font-size: 0.85em; margin-bottom: 10px;">
                                预览向量化前的文本清洗效果，查看哪些内容会被移除。
                            </p>
                            <button id="t-btn-preview-cleaning" class="t-btn">
                                <i class="fa-solid fa-eye"></i> 预览清洗效果
                            </button>
                        </div>

                        <div class="t-action-group" style="margin-top: 20px;">
                            <h4><i class="fa-solid fa-plug"></i> Embedding API 配置</h4>
                            <p style="color: #888; font-size: 0.85em; margin-bottom: 10px;">
                                向量化需要专用的 Embedding API，请在「设置」中配置。
                            </p>
                            <button id="t-btn-test-embedding" class="t-btn">
                                <i class="fa-solid fa-vial"></i> 测试 Embedding 连接
                            </button>
                        </div>
                    </div>

                    <input type="file" id="t-import-vector-file" accept=".json" style="display: none;">
                </div>
            </div>
        </div>
    </div>
    `;

    $("body").append(html);

    // 绑定事件（不需要等待异步数据）
    bindEvents();

    // === 第二阶段：异步加载数据，更新 UI ===
    // 使用 setTimeout(0) 确保 UI 先渲染，避免阻塞
    // 所有异步操作都使用超时保护，避免单个操作卡住影响整体
    const LOAD_TIMEOUT = 8000; // 8 秒超时

    setTimeout(async () => {
        try {
            // 1. 获取上下文（带超时保护）
            const ctx = await safeAsyncOperation(
                () => getContextData(),
                LOAD_TIMEOUT,
                { charId: "unknown", charName: "未知角色" },
                "获取上下文"
            );

            // 角色 ID 用于向量操作（优先使用 charId，回退到 charName）
            currentCharacterId = ctx.charId || ctx.charName || "unknown";
            // 角色名称用于显示（优先使用 charName）
            currentCharacterName = ctx.charName || ctx.charId || "未知角色";
            $("#t-vector-char-name").text(currentCharacterName);

            // 2. 并行执行多个异步操作，每个都有独立超时保护
            // 使用 Promise.allSettled 确保一个失败不影响其他
            const results = await Promise.allSettled([
                // 2a. 获取索引状态
                safeAsyncOperation(
                    () => getIndexStatus(currentCharacterId),
                    LOAD_TIMEOUT,
                    null,
                    "获取向量索引状态"
                ),
                // 2b. 初始化世界书列表
                safeAsyncOperation(
                    () => initWorldBookSelect(),
                    LOAD_TIMEOUT,
                    null,
                    "初始化世界书列表"
                ),
                // 2c. 更新增量向量化状态
                safeAsyncOperation(
                    () => updateIncrementalStatus(),
                    LOAD_TIMEOUT,
                    null,
                    "更新增量状态"
                )
            ]);

            // 处理索引状态结果
            const indexStatus = results[0].status === 'fulfilled' ? results[0].value : null;
            if (indexStatus) {
                const statusHtml = `<span class="t-index-status t-index-ready">✅ ${indexStatus.actualVectorCount} 条</span>`;
                $("#t-index-status-display").html(statusHtml);
                $("#t-vector-status").text(`已建立 (${indexStatus.actualVectorCount} 条)`);
                $("#t-vector-model").text(indexStatus.embeddingModel || "未知");
                $("#t-vector-last-export").text(
                    indexStatus.lastExportedAt
                        ? new Date(indexStatus.lastExportedAt).toLocaleString()
                        : "从未导出"
                );
                $("#t-btn-export-vectors, #t-btn-clear-vectors").prop("disabled", false);
                $("#t-use-vector-search").prop("disabled", false);
            } else {
                const statusHtml = `<span class="t-index-status t-index-empty">❌ 未建立</span>`;
                $("#t-index-status-display").html(statusHtml);
                $("#t-vector-status").text("未建立");
                $("#t-vector-model").text("未知");
                $("#t-vector-last-export").text("从未导出");
                $("#t-btn-export-vectors, #t-btn-clear-vectors").prop("disabled", true);
                $("#t-use-vector-search").prop("disabled", true).prop("checked", false);
            }

            TitaniaLogger.info("智能提取页面加载完成");

        } catch (e) {
            TitaniaLogger.error("加载页面数据失败", e);
            // 即使出错也更新 UI 状态，避免一直显示"加载中"
            $("#t-index-status-display").html(`<span class="t-index-status t-index-empty">⚠️ 加载超时</span>`);
        }
    }, 0);
}


/**
 * 初始化世界书选择下拉框
 */
async function initWorldBookSelect() {
    const books = getAvailableWorldBooks();
    const charBook = await getCharacterWorldBook();

    const $select = $("#t-target-book");
    $select.empty();

    if (charBook) {
        $select.append(`<option value="${charBook}">[当前角色] ${charBook}</option>`);
    }

    books.forEach(book => {
        if (book !== charBook) {
            $select.append(`<option value="${book}">${book}</option>`);
        }
    });

    if (books.length === 0 && !charBook) {
        $select.append(`<option value="" disabled>未找到世界书</option>`);
    }
}

/**
 * 绑定事件监听
 */
function bindEvents() {
    // 关闭窗口
    $("#t-lore-review-close").on("click", () => {
        $("#t-lore-review-overlay").remove();
    });

    // 配置按钮点击
    $("#t-config-btn").on("click", function () {
        showProfileConfigDialog(() => {
            // 配置更新后刷新显示
            const conn = getFeatureConnection(FEATURE_KEY);
            if (conn) {
                $("#t-current-profile").text(conn.profileName);
                $("#t-current-model").text(conn.model);
            }
        });
    });

    // 设定提取分析范围变化时保存
    $("#t-lore-history-limit").on("change", function () {
        const val = parseInt($(this).val());
        if (!isNaN(val) && val > 0) {
            saveAnalysisSettings({ extractLimit: val });
        }
    });

    // 智能总结分析范围变化时保存
    $("#t-summary-history-limit").on("change", function () {
        const val = parseInt($(this).val());
        if (!isNaN(val) && val > 0) {
            saveAnalysisSettings({ summaryLimit: val });
        }
    });

    // 快捷按钮点击事件
    $(document).on("click", ".t-quick-btn", function () {
        const target = $(this).data("target");
        const value = $(this).data("value");

        let inputSelector;
        if (target === "extract") {
            inputSelector = "#t-lore-history-limit";
        } else if (target === "summary") {
            inputSelector = "#t-summary-history-limit";
        }

        if (inputSelector) {
            let newValue;
            if (value === "all") {
                newValue = currentTotalFloors;
            } else {
                // 取快捷值和总楼层数的较小值
                newValue = Math.min(parseInt(value), currentTotalFloors);
            }

            $(inputSelector).val(newValue).trigger("change");

            // 高亮当前选中的按钮
            $(this).siblings(".t-quick-btn").removeClass("active");
            $(this).addClass("active");
        }
    });

    // 预览设定提取提示词
    $("#t-btn-preview-extract-prompt").on("click", async function () {
        let limit = parseInt($("#t-lore-history-limit").val());
        if (isNaN(limit) || limit < 1) limit = 2;

        const $btn = $(this);
        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 加载中...');

        try {
            const result = await previewExtractPrompt(limit);

            // 显示预览弹窗，包含额外的统计信息
            showPromptPreviewDialog(result.messages, {
                historyCount: result.historyCount,
                existingEntriesCount: result.existingEntriesCount,
                requestedLimit: limit,
                isExtractMode: true
            });

        } catch (e) {
            TitaniaLogger.error("预览提示词失败", e);
            if (window.toastr) toastr.error(e.message, "预览失败");
        } finally {
            $btn.prop("disabled", false).html('<i class="fa-solid fa-eye"></i> 预览提示词');
        }
    });

    // 开始分析
    $("#t-btn-start-extract").on("click", async function () {
        let limit = parseInt($("#t-lore-history-limit").val());
        if (isNaN(limit) || limit < 1) limit = 2; // 默认值

        const $btn = $(this);

        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 分析中...');
        $("#t-lore-entries-list").html('<div class="t-loading-state"><i class="fa-solid fa-spinner fa-spin"></i> 正在读取记忆并提取设定...</div>');
        $("#t-btn-view-raw").hide(); // 隐藏查看原始响应按钮

        try {
            // 使用功能专用配置
            const result = await extractLoreFromHistory(limit);
            currentEntries = result.entries || [];
            lastRawResponse = result.rawResponse || ""; // 保存原始响应
            renderEntriesList();

            // 显示查看原始响应按钮
            if (lastRawResponse) {
                $("#t-btn-view-raw").show();
            }

            if (currentEntries.length > 0) {
                $("#t-btn-save-selected").prop("disabled", false);
                if (window.toastr) toastr.success(`成功提取 ${currentEntries.length} 个条目`, "Titania");
            } else {
                $("#t-lore-entries-list").html('<div class="t-empty-state"><p>未提取到新的设定信息</p></div>');
            }
        } catch (e) {
            TitaniaLogger.error("提取失败", e);

            // 保存错误时的原始响应
            if (e.rawResponse) {
                lastRawResponse = e.rawResponse;
                $("#t-btn-view-raw").show();

                // 解析失败时自动弹出原始响应查看窗口
                showRawResponseDialog(lastRawResponse, true);
            }

            $("#t-lore-entries-list").html(`<div class="t-error-state"><i class="fa-solid fa-exclamation-triangle"></i> 提取失败: ${e.message}</div>`);
            if (window.toastr) toastr.error(e.message, "提取失败");
        } finally {
            $btn.prop("disabled", false).html('<i class="fa-solid fa-search"></i> 开始分析');
        }
    });

    // 查看原始响应
    $("#t-btn-view-raw").on("click", function () {
        if (lastRawResponse) {
            showRawResponseDialog(lastRawResponse, false);
        } else {
            if (window.toastr) toastr.info("暂无原始响应数据");
        }
    });

    // 全选/全不选
    $("#t-btn-select-all").on("click", () => {
        $(".t-lore-entry-checkbox").prop("checked", true);
    });
    $("#t-btn-deselect-all").on("click", () => {
        $(".t-lore-entry-checkbox").prop("checked", false);
    });

    // 保存选中
    $("#t-btn-save-selected").on("click", async function () {
        const targetBook = $("#t-target-book").val();
        if (!targetBook) {
            alert("请选择目标世界书");
            return;
        }

        const selectedIndices = [];
        $(".t-lore-entry-checkbox:checked").each(function () {
            selectedIndices.push($(this).data("index"));
        });

        if (selectedIndices.length === 0) {
            alert("请至少选择一个条目");
            return;
        }

        const $btn = $(this);
        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 保存中...');

        let successCount = 0;
        for (const index of selectedIndices) {
            const entry = currentEntries[index];
            if (entry) {
                // 如果是更新操作，且有匹配的 UID，则使用该 UID
                const entryToSave = { ...entry };
                if (entry.action === 'update' && entry.matched_uid) {
                    entryToSave.uid = entry.matched_uid;

                    // 根据保存模式处理内容
                    const saveMode = entry.saveMode || 'replace';
                    if (entry.originalContent && saveMode !== 'replace') {
                        if (saveMode === 'append') {
                            // 追加模式：原有内容 + 分隔符 + 新内容
                            entryToSave.content = entry.originalContent + "\n\n---\n\n" + entry.content;
                        } else if (saveMode === 'prepend') {
                            // 前置模式：新内容 + 分隔符 + 原有内容
                            entryToSave.content = entry.content + "\n\n---\n\n" + entry.originalContent;
                        }
                    }
                    // replace 模式：直接使用新内容（默认行为）
                }

                const success = await saveLoreEntry(targetBook, entryToSave);
                if (success) successCount++;
            }
        }

        $btn.prop("disabled", false).html('<i class="fa-solid fa-save"></i> 保存选中条目');

        if (window.toastr) toastr.success(`成功保存 ${successCount} 个条目到 [${targetBook}]`, "Titania");

        // 可选：保存后关闭窗口或移除已保存条目
        // 这里选择移除已保存的条目
        // currentEntries = currentEntries.filter((_, idx) => !selectedIndices.includes(idx));
        // renderEntriesList();
    });

    // 列表项点击（显示详情）
    $(document).on("click", ".t-lore-entry-item", function (e) {
        // 如果点击的是复选框，不切换详情
        if ($(e.target).is("input[type='checkbox']")) return;

        $(".t-lore-entry-item").removeClass("active");
        $(this).addClass("active");

        const index = $(this).data("index");
        showEntryDetail(index);

        // 移动端：切换到编辑视图
        if (window.innerWidth <= 768) {
            $(".t-lore-content").addClass("t-mobile-edit-mode");
            updateMobileNavButtons(index);
        }
    });

    // 移动端：返回列表按钮
    $(document).on("click", "#t-mobile-back-to-list", function () {
        $(".t-lore-content").removeClass("t-mobile-edit-mode");
    });

    // 移动端：上一条按钮
    $(document).on("click", "#t-mobile-prev-entry", function () {
        const currentIndex = $(".t-lore-entry-item.active").data("index");
        if (currentIndex > 0) {
            const newIndex = currentIndex - 1;
            $(".t-lore-entry-item").removeClass("active");
            $(`.t-lore-entry-item[data-index="${newIndex}"]`).addClass("active");
            showEntryDetail(newIndex);
            updateMobileNavButtons(newIndex);
        }
    });

    // 移动端：下一条按钮
    $(document).on("click", "#t-mobile-next-entry", function () {
        const currentIndex = $(".t-lore-entry-item.active").data("index");
        if (currentIndex < currentEntries.length - 1) {
            const newIndex = currentIndex + 1;
            $(".t-lore-entry-item").removeClass("active");
            $(`.t-lore-entry-item[data-index="${newIndex}"]`).addClass("active");
            showEntryDetail(newIndex);
            updateMobileNavButtons(newIndex);
        }
    });

    // 编辑器输入同步
    $("#t-edit-keys").on("input", function () {
        const index = $(".t-lore-entry-item.active").data("index");
        if (index !== undefined && currentEntries[index]) {
            const val = $(this).val();
            currentEntries[index].keys = val.split(/,|，/).map(s => s.trim()).filter(s => s);
            // 更新列表显示
            $(`.t-lore-entry-item[data-index="${index}"] .t-entry-keys`).text(currentEntries[index].keys.join(", "));
        }
    });

    $("#t-edit-content").on("input", function () {
        const index = $(".t-lore-entry-item.active").data("index");
        if (index !== undefined && currentEntries[index]) {
            currentEntries[index].content = $(this).val();
            // 更新列表预览
            $(`.t-lore-entry-item[data-index="${index}"] .t-entry-preview`).text(currentEntries[index].content);
        }
    });

    $("#t-edit-category").on("change", function () {
        const index = $(".t-lore-entry-item.active").data("index");
        if (index !== undefined && currentEntries[index]) {
            const newCat = $(this).val();
            currentEntries[index].category = newCat;
            // 更新列表图标/标签和颜色指示
            const $item = $(`.t-lore-entry-item[data-index="${index}"]`);
            $item.find(".t-entry-tag").text(newCat);
            $item.attr("data-cat", newCat);
        }
    });

    // 切换原有内容展开/收起
    $(document).on("click", "#t-btn-toggle-original", function () {
        const $box = $("#t-original-content-box");
        const $icon = $(this).find("i");

        if ($box.is(":visible")) {
            $box.slideUp(200);
            $icon.removeClass("fa-chevron-up").addClass("fa-chevron-down");
        } else {
            $box.slideDown(200);
            $icon.removeClass("fa-chevron-down").addClass("fa-chevron-up");
        }
    });

    // 保存模式变化时更新条目的保存模式
    $(document).on("change", "input[name='t-save-mode']", function () {
        const index = $(".t-lore-entry-item.active").data("index");
        if (index !== undefined && currentEntries[index]) {
            currentEntries[index].saveMode = $(this).val();
        }
    });

    // ========== Tab 切换事件 ==========
    $(".t-mode-tab").on("click", function () {
        const mode = $(this).data("mode");
        if (mode === currentMode) return;

        currentMode = mode;

        // 更新 Tab 样式
        $(".t-mode-tab").removeClass("active");
        $(this).addClass("active");

        // 切换面板显示
        $(".t-mode-panel").hide();
        $(`#t-panel-${mode}`).show();

        // 如果切换到总结面板，初始化总结目标世界书和隐藏楼层功能区
        if (mode === "summary") {
            initSummaryWorldBookSelect();
            initHideFloorsSection();
        }
    });

    // ========== 智能总结功能事件 ==========

    // 模板切换时显示/隐藏自定义提示词区域
    $("#t-summary-template").on("change", function () {
        const template = $(this).val();
        if (template === "custom") {
            $("#t-custom-prompt-section").show();
            // 加载已保存的自定义提示词
            const data = getExtData();
            const savedPrompt = data.summarizer_config?.custom_prompt || "";
            $("#t-custom-prompt-input").val(savedPrompt);
        } else {
            $("#t-custom-prompt-section").hide();
        }
    });

    // 折叠/展开自定义提示词区域
    $("#t-toggle-custom-prompt").on("click", function (e) {
        if ($(e.target).closest("#t-btn-reset-prompt").length) return; // 忽略恢复按钮点击
        $(this).find("i:first").toggleClass("fa-chevron-down fa-chevron-up");
        $(this).siblings(".t-custom-prompt-body").slideToggle(200);
    });

    // 恢复默认提示词
    $("#t-btn-reset-prompt").on("click", function (e) {
        e.stopPropagation();
        const defaultPrompt = getDefaultSummaryPrompt();
        $("#t-custom-prompt-input").val(defaultPrompt);
        if (window.toastr) toastr.info("已恢复默认提示词");
    });

    // 保存自定义提示词
    $("#t-custom-prompt-input").on("change", function () {
        const data = getExtData();
        if (!data.summarizer_config) data.summarizer_config = {};
        data.summarizer_config.custom_prompt = $(this).val();
        saveExtData();
    });

    // 预览提示词（生成前）
    $("#t-btn-preview-prompt").on("click", async function () {
        const limit = parseInt($("#t-summary-history-limit").val()) || 20;
        const template = $("#t-summary-template").val();
        const useVectorSearch = $("#t-use-vector-search").is(":checked");
        const customPrompt = template === "custom" ? $("#t-custom-prompt-input").val() : "";

        const $btn = $(this);
        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 加载中...');

        try {
            const result = await previewSummaryPrompt(currentCharacterId, {
                historyLimit: limit,
                template: template,
                useVectorSearch: useVectorSearch,
                customPrompt: customPrompt
            });

            // 显示预览弹窗，包含额外的统计信息
            showPromptPreviewDialog(result.messages, {
                historyCount: result.historyCount,
                relevantHistoryFound: result.relevantHistoryFound,
                requestedLimit: limit
            });

        } catch (e) {
            TitaniaLogger.error("预览提示词失败", e);
            if (window.toastr) toastr.error(e.message, "预览失败");
        } finally {
            $btn.prop("disabled", false).html('<i class="fa-solid fa-eye"></i> 预览提示词');
        }
    });

    $("#t-btn-generate-summary").on("click", async function () {
        const limit = parseInt($("#t-summary-history-limit").val()) || 20;
        const template = $("#t-summary-template").val();
        const useVectorSearch = $("#t-use-vector-search").is(":checked");
        const customPrompt = template === "custom" ? $("#t-custom-prompt-input").val() : "";

        const $btn = $(this);
        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 生成中...');
        $("#t-summary-result").html('<div class="t-loading-state"><i class="fa-solid fa-spinner fa-spin"></i> 正在分析聊天历史并生成总结...</div>');
        $("#t-btn-copy-summary, #t-btn-save-summary").hide();
        $("#t-hide-floors-section").hide(); // 隐藏功能区先隐藏

        try {
            const result = await generateSummary(currentCharacterId, {
                historyLimit: limit,
                template: template,
                useVectorSearch: useVectorSearch,
                customPrompt: customPrompt
            });

            lastSummary = result.summary;
            lastSummaryMessages = result.messages; // 保存发送的 messages

            // 记录分析范围（从最后往前数 limit 条）
            // 聊天消息 ID 从 0 开始，所以范围是 (totalFloors - limit) 到 (totalFloors - 1)
            const actualLimit = Math.min(limit, currentTotalFloors);
            lastAnalyzedRange = {
                start: Math.max(0, currentTotalFloors - actualLimit),
                end: currentTotalFloors - 1
            };

            // 渲染总结结果（支持 Markdown）
            $("#t-summary-result").html(`
                <div class="t-summary-text">${formatSummaryAsHtml(lastSummary)}</div>
            `);

            // 显示操作按钮
            $("#t-btn-copy-summary, #t-btn-save-summary").show();

            // 显示隐藏楼层功能区并设置默认范围
            showHideFloorsSection(lastAnalyzedRange.start, lastAnalyzedRange.end);

            if (window.toastr) toastr.success("总结生成成功", "Titania");

        } catch (e) {
            TitaniaLogger.error("总结生成失败", e);
            // 即使失败也保存 messages 供调试
            if (e.messages) {
                lastSummaryMessages = e.messages;
            }
            $("#t-summary-result").html(`<div class="t-error-state"><i class="fa-solid fa-exclamation-triangle"></i> 生成失败: ${e.message}</div>`);
            if (window.toastr) toastr.error(e.message, "生成失败");
        } finally {
            $btn.prop("disabled", false).html('<i class="fa-solid fa-magic"></i> 生成总结');
        }
    });

    // 复制总结
    $("#t-btn-copy-summary").on("click", function () {
        if (!lastSummary) {
            if (window.toastr) toastr.info("暂无总结内容");
            return;
        }

        navigator.clipboard.writeText(lastSummary).then(() => {
            $(this).html('<i class="fa-solid fa-check"></i> 已复制');
            setTimeout(() => {
                $(this).html('<i class="fa-solid fa-copy"></i> 复制');
            }, 2000);
        }).catch(() => {
            if (window.toastr) toastr.error("复制失败");
        });
    });

    // 保存总结为世界书条目
    $("#t-btn-save-summary").on("click", async function () {
        if (!lastSummary) {
            if (window.toastr) toastr.info("暂无总结内容");
            return;
        }

        const targetBook = $("#t-summary-target-book").val();
        if (!targetBook) {
            if (window.toastr) toastr.warning("请选择目标世界书");
            return;
        }

        const $btn = $(this);
        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 保存中...');

        try {
            const entry = summaryToLoreEntry(lastSummary);
            const success = await saveLoreEntry(targetBook, entry);

            if (success) {
                if (window.toastr) toastr.success(`总结已保存到 [${targetBook}]`, "Titania");
            } else {
                throw new Error("保存失败");
            }
        } catch (e) {
            TitaniaLogger.error("保存总结失败", e);
            if (window.toastr) toastr.error(e.message, "保存失败");
        } finally {
            $btn.prop("disabled", false).html('<i class="fa-solid fa-save"></i> 保存为条目');
        }
    });

    // ========== 向量索引管理事件 ==========

    // 增量更新索引
    $("#t-btn-build-index").on("click", async function () {
        await doBuildIndex(false); // incremental = true (default), rebuild = false
    });

    // 重建索引
    $("#t-btn-rebuild-index").on("click", async function () {
        if (!confirm("确定要清除现有索引并完整重建吗？这将处理所有消息，可能需要较长时间。")) {
            return;
        }
        await doBuildIndex(true); // rebuild = true
    });

    /**
     * 执行向量索引构建
     * @param {boolean} rebuild - 是否重建（清除现有索引）
     */
    async function doBuildIndex(rebuild = false) {
        // 检查 Embedding 配置
        const embeddingValidation = validateEmbeddingConfig();
        if (!embeddingValidation.valid) {
            if (window.toastr) toastr.error(embeddingValidation.error, "Embedding 配置错误");
            return;
        }

        const $btnIncremental = $("#t-btn-build-index");
        const $btnRebuild = $("#t-btn-rebuild-index");

        $btnIncremental.prop("disabled", true);
        $btnRebuild.prop("disabled", true);

        if (rebuild) {
            $btnRebuild.html('<i class="fa-solid fa-spinner fa-spin"></i>');
        } else {
            $btnIncremental.html('<i class="fa-solid fa-spinner fa-spin"></i> 处理中...');
        }

        $("#t-index-progress").show();
        $("#t-incremental-status").hide();

        try {
            const result = await buildVectorIndex(currentCharacterId, {
                rebuild: rebuild,
                incremental: !rebuild,
                onProgress: (current, total, status) => {
                    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
                    $(".t-progress-fill").css("width", `${percent}%`);
                    $(".t-progress-text").text(status || `${current}/${total}`);
                }
            });

            // 更新状态显示
            await refreshVectorStatus();
            await updateIncrementalStatus();

            // 显示结果
            const message = result.message || `已索引 ${result.indexed} 条`;
            if (window.toastr) {
                if (result.indexed > 0) {
                    toastr.success(message, rebuild ? "重建完成" : "增量更新完成");
                } else {
                    toastr.info(message, "无需更新");
                }
            }

        } catch (e) {
            TitaniaLogger.error("建立索引失败", e);
            if (window.toastr) toastr.error(e.message, "索引失败");
        } finally {
            $btnIncremental.prop("disabled", false).html('<i class="fa-solid fa-plus"></i> 增量更新');
            $btnRebuild.prop("disabled", false).html('<i class="fa-solid fa-redo"></i> 重建');
            $("#t-index-progress").hide();
        }
    }

    // 导出索引
    $("#t-btn-export-vectors").on("click", async function () {
        const $btn = $(this);
        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 导出中...');

        try {
            await downloadVectorExport(currentCharacterId);
            await refreshVectorStatus();
            if (window.toastr) toastr.success("向量索引已导出", "Titania");
        } catch (e) {
            TitaniaLogger.error("导出失败", e);
            if (window.toastr) toastr.error(e.message, "导出失败");
        } finally {
            $btn.prop("disabled", false).html('<i class="fa-solid fa-download"></i> 导出索引');
        }
    });

    // 导入索引
    $("#t-btn-import-vectors").on("click", function () {
        $("#t-import-vector-file").click();
    });

    $("#t-import-vector-file").on("change", async function () {
        const file = this.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const data = JSON.parse(text);

            const result = await importVectors(currentCharacterId, data, true);
            await refreshVectorStatus();

            if (window.toastr) toastr.success(`导入完成: ${result.imported} 条`, "Titania");

        } catch (e) {
            TitaniaLogger.error("导入失败", e);
            if (window.toastr) toastr.error(e.message, "导入失败");
        }

        // 清空 input 以便重复选择同一文件
        $(this).val("");
    });

    // 清除索引
    $("#t-btn-clear-vectors").on("click", async function () {
        if (!confirm("确定要清除当前角色的所有向量索引吗？此操作不可恢复！")) {
            return;
        }

        const $btn = $(this);
        $btn.prop("disabled", true);

        try {
            const count = await clearCharacterVectors(currentCharacterId);
            await refreshVectorStatus();

            if (window.toastr) toastr.success(`已清除 ${count} 条向量索引`, "Titania");
        } catch (e) {
            TitaniaLogger.error("清除失败", e);
            if (window.toastr) toastr.error(e.message, "清除失败");
        } finally {
            $btn.prop("disabled", false);
        }
    });

    // 预览清洗效果
    $("#t-btn-preview-cleaning").on("click", async function () {
        const $btn = $(this);
        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 加载中...');

        try {
            // 从聊天历史获取样本消息
            const chatHistory = getChatHistory();
            if (!chatHistory || chatHistory.length === 0) {
                if (window.toastr) toastr.warning("没有可预览的聊天历史", "无数据");
                return;
            }

            // 取最近 5 条消息作为样本
            const sampleCount = Math.min(5, chatHistory.length);
            const samples = chatHistory.slice(-sampleCount);

            // 显示预览弹窗
            showCleaningPreviewDialog(samples);

        } catch (e) {
            TitaniaLogger.error("预览清洗效果失败", e);
            if (window.toastr) toastr.error(e.message, "预览失败");
        } finally {
            $btn.prop("disabled", false).html('<i class="fa-solid fa-eye"></i> 预览清洗效果');
        }
    });

    // 测试 Embedding 连接
    $("#t-btn-test-embedding").on("click", async function () {
        const $btn = $(this);
        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 测试中...');

        try {
            const result = await testEmbeddingConnection();

            if (result.success) {
                if (window.toastr) toastr.success(result.message, "连接成功");
            } else {
                if (window.toastr) toastr.error(result.message, "连接失败");
            }
        } catch (e) {
            if (window.toastr) toastr.error(e.message, "测试失败");
        } finally {
            $btn.prop("disabled", false).html('<i class="fa-solid fa-vial"></i> 测试 Embedding 连接');
        }
    });

    // ========== 隐藏楼层功能相关事件 ==========

    // 隐藏范围输入变化时更新计数
    $("#t-hide-start, #t-hide-end").on("input change", function () {
        updateHideFloorCount();
    });

    // 隐藏范围快捷按钮
    $(document).on("click", ".t-hide-quick", function () {
        const value = $(this).data("value");

        if (value === "analyzed") {
            // 恢复为分析范围
            if (lastAnalyzedRange.end > 0) {
                $("#t-hide-start").val(lastAnalyzedRange.start + 1); // 转为 1-based
                $("#t-hide-end").val(lastAnalyzedRange.end + 1);
            }
        } else if (value === "all") {
            // 全部楼层
            $("#t-hide-start").val(1);
            $("#t-hide-end").val(currentTotalFloors);
        } else {
            // 最近 N 楼
            const count = parseInt(value);
            const start = Math.max(1, currentTotalFloors - count + 1);
            $("#t-hide-start").val(start);
            $("#t-hide-end").val(currentTotalFloors);
        }

        updateHideFloorCount();
    });

    // 一键隐藏
    $("#t-btn-hide-floors").on("click", async function () {
        const start = parseInt($("#t-hide-start").val());
        const end = parseInt($("#t-hide-end").val());

        if (isNaN(start) || isNaN(end) || start < 1 || end < start) {
            if (window.toastr) toastr.error("请输入有效的楼层范围", "参数错误");
            return;
        }

        const $btn = $(this);
        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 处理中...');

        try {
            // 动态获取隐藏函数
            const hideChatMessageRange = await getHideChatMessageRange();
            if (!hideChatMessageRange) {
                throw new Error("无法获取隐藏消息功能，可能是 SillyTavern 版本不兼容");
            }

            // 转换为 0-based 索引
            await hideChatMessageRange(start - 1, end - 1, false);

            const count = end - start + 1;
            if (window.toastr) toastr.success(`已隐藏 ${count} 条消息（${start} ~ ${end} 楼）`, "操作成功");

            // 更新状态显示
            updateHiddenStatus();

        } catch (e) {
            TitaniaLogger.error("隐藏消息失败", e);
            if (window.toastr) toastr.error(e.message, "隐藏失败");
        } finally {
            $btn.prop("disabled", false).html('<i class="fa-solid fa-eye-slash"></i> 一键隐藏');
        }
    });

    // 取消隐藏
    $("#t-btn-unhide-floors").on("click", async function () {
        const start = parseInt($("#t-hide-start").val());
        const end = parseInt($("#t-hide-end").val());

        if (isNaN(start) || isNaN(end) || start < 1 || end < start) {
            if (window.toastr) toastr.error("请输入有效的楼层范围", "参数错误");
            return;
        }

        const $btn = $(this);
        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 处理中...');

        try {
            // 动态获取隐藏函数
            const hideChatMessageRange = await getHideChatMessageRange();
            if (!hideChatMessageRange) {
                throw new Error("无法获取隐藏消息功能，可能是 SillyTavern 版本不兼容");
            }

            // 转换为 0-based 索引，unhide = true
            await hideChatMessageRange(start - 1, end - 1, true);

            const count = end - start + 1;
            if (window.toastr) toastr.success(`已取消隐藏 ${count} 条消息（${start} ~ ${end} 楼）`, "操作成功");

            // 更新状态显示
            updateHiddenStatus();

        } catch (e) {
            TitaniaLogger.error("取消隐藏失败", e);
            if (window.toastr) toastr.error(e.message, "取消隐藏失败");
        } finally {
            $btn.prop("disabled", false).html('<i class="fa-solid fa-eye"></i> 取消隐藏');
        }
    });
}

/**
 * 显示隐藏楼层操作区并设置默认范围
 * @param {number} startIndex - 起始消息索引（0-based）
 * @param {number} endIndex - 结束消息索引（0-based）
 */
function showHideFloorsSection(startIndex, endIndex) {
    // 转换为 1-based 显示
    const start = startIndex + 1;
    const end = endIndex + 1;

    $("#t-hide-start").val(start).attr("max", currentTotalFloors);
    $("#t-hide-end").val(end).attr("max", currentTotalFloors);

    updateHideFloorCount();
    updateHiddenStatus();

    $("#t-hide-floors-section").slideDown(200);
}

/**
 * 更新隐藏楼层计数显示
 */
function updateHideFloorCount() {
    const start = parseInt($("#t-hide-start").val()) || 0;
    const end = parseInt($("#t-hide-end").val()) || 0;

    const count = Math.max(0, end - start + 1);
    $("#t-hide-count-num").text(count);
}

/**
 * 更新已隐藏状态显示
 */
function updateHiddenStatus() {
    try {
        const chat = window.SillyTavern?.getContext?.()?.chat;
        if (!chat || !Array.isArray(chat)) {
            $("#t-hidden-status").text("");
            return;
        }

        let hiddenCount = 0;
        chat.forEach(msg => {
            if (msg.is_system === true) {
                hiddenCount++;
            }
        });

        if (hiddenCount > 0) {
            $("#t-hidden-status").html(`<span class="t-status-warn">（当前已隐藏 ${hiddenCount} 条）</span>`);
        } else {
            $("#t-hidden-status").html(`<span class="t-status-ok">（无隐藏消息）</span>`);
        }
    } catch (e) {
        TitaniaLogger.warn("获取隐藏状态失败", e);
        $("#t-hidden-status").text("");
    }
}

/**
 * 初始化隐藏楼层功能区（切换到总结面板时调用）
 */
function initHideFloorsSection() {
    // 设置默认范围：1 到总楼层数
    const totalFloors = currentTotalFloors || 1;
    $("#t-hide-start").val(1).attr("max", totalFloors);
    $("#t-hide-end").val(totalFloors).attr("max", totalFloors);

    updateHideFloorCount();
    updateHiddenStatus();
}

/**
 * 初始化总结页面的世界书选择下拉框
 */
async function initSummaryWorldBookSelect() {
    const books = getAvailableWorldBooks();
    const charBook = await getCharacterWorldBook();

    const $select = $("#t-summary-target-book");
    $select.empty();

    if (charBook) {
        $select.append(`<option value="${charBook}">[当前角色] ${charBook}</option>`);
    }

    books.forEach(book => {
        if (book !== charBook) {
            $select.append(`<option value="${book}">${book}</option>`);
        }
    });

    if (books.length === 0 && !charBook) {
        $select.append(`<option value="" disabled>未找到世界书</option>`);
    }
}

/**
 * 刷新向量索引状态显示
 */
async function refreshVectorStatus() {
    try {
        const status = await getIndexStatus(currentCharacterId);

        if (status) {
            $("#t-vector-status").text(`已建立 (${status.actualVectorCount} 条)`);
            $("#t-vector-model").text(status.embeddingModel || "未知");
            $("#t-vector-last-export").text(
                status.lastExportedAt
                    ? new Date(status.lastExportedAt).toLocaleString()
                    : "从未导出"
            );
            $("#t-index-status-display").html(`<span class="t-index-status t-index-ready">✅ ${status.actualVectorCount} 条</span>`);

            // 启用相关按钮
            $("#t-btn-export-vectors, #t-btn-clear-vectors").prop("disabled", false);
            $("#t-use-vector-search").prop("disabled", false).prop("checked", true);
        } else {
            $("#t-vector-status").text("未建立");
            $("#t-vector-model").text("未知");
            $("#t-vector-last-export").text("从未导出");
            $("#t-index-status-display").html(`<span class="t-index-status t-index-empty">❌ 未建立</span>`);

            // 禁用相关按钮
            $("#t-btn-export-vectors, #t-btn-clear-vectors").prop("disabled", true);
            $("#t-use-vector-search").prop("disabled", true).prop("checked", false);
        }
    } catch (e) {
        TitaniaLogger.warn("刷新向量状态失败", e);
    }
}

/**
 * 更新增量状态提示
 */
async function updateIncrementalStatus() {
    try {
        const status = await getVectorIndexStatus(currentCharacterId);

        if (status.hasIndex && status.newMessagesCount > 0) {
            // 有索引且有新消息
            $("#t-incremental-message").html(
                `<strong>${status.newMessagesCount}</strong> 条新消息未向量化 ` +
                `<small>(已索引 ${status.totalIndexed} 条，上次到第 ${status.lastMessageIndex + 1} 楼)</small>`
            );
            $("#t-incremental-status").show().removeClass("t-status-ok").addClass("t-status-new");
        } else if (status.hasIndex && status.newMessagesCount === 0) {
            // 有索引且没有新消息
            $("#t-incremental-message").html(
                `所有消息已向量化 <small>(共 ${status.totalIndexed} 条)</small>`
            );
            $("#t-incremental-status").show().removeClass("t-status-new").addClass("t-status-ok");
        } else {
            // 没有索引
            $("#t-incremental-status").hide();
        }
    } catch (e) {
        TitaniaLogger.warn("更新增量状态失败", e);
        $("#t-incremental-status").hide();
    }
}

/**
 * 将总结文本格式化为 HTML（简单的 Markdown 转换）
 */
function formatSummaryAsHtml(text) {
    if (!text) return "";

    // 转义 HTML
    let html = escapeHtml(text);

    // 转换 Markdown 标题
    html = html.replace(/^## (.+)$/gm, '<h3 class="t-summary-h3">$1</h3>');
    html = html.replace(/^### (.+)$/gm, '<h4 class="t-summary-h4">$1</h4>');

    // 转换粗体
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // 转换列表项
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>');

    // 转换换行
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');

    return `<p>${html}</p>`;
}

/**
 * 渲染条目列表
 */
function renderEntriesList() {
    const $list = $("#t-lore-entries-list");
    $list.empty();

    currentEntries.forEach((entry, index) => {
        const keysStr = Array.isArray(entry.keys) ? entry.keys.join(", ") : entry.keys;
        const category = entry.category || 'Other';
        const isUpdate = entry.action === 'update';

        const html = `
        <div class="t-lore-entry-item ${isUpdate ? 't-is-update' : ''}" data-index="${index}" data-cat="${category}">
            <div class="t-entry-header">
                <input type="checkbox" class="t-lore-entry-checkbox" data-index="${index}" checked>
                <span class="t-entry-keys" title="${keysStr}">
                    ${isUpdate ? '<i class="fa-solid fa-rotate" title="更新现有条目"></i> ' : ''}${keysStr}
                </span>
                <span class="t-entry-tag">${category}</span>
            </div>
            <div class="t-entry-preview">${entry.content || ''}</div>
        </div>
        `;
        $list.append(html);
    });

    // 默认选中第一个
    if (currentEntries.length > 0) {
        showEntryDetail(0);
        $(".t-lore-entry-item").first().addClass("active");
    } else {
        $("#t-lore-editor").hide();
        $("#t-editor-placeholder").show();
    }
}

/**
 * 显示条目详情
 * @param {number} index
 */
function showEntryDetail(index) {
    const entry = currentEntries[index];
    if (!entry) return;

    $("#t-editor-placeholder").hide();
    $("#t-lore-editor").show();

    $("#t-edit-keys").val(Array.isArray(entry.keys) ? entry.keys.join(", ") : entry.keys);
    $("#t-edit-category").val(entry.category || "Other");
    $("#t-edit-content").val(entry.content || "");
    $("#t-edit-reason").text(entry.reason || "无");

    // 更新关联信息显示
    if (entry.action === 'update' && entry.matched_uid) {
        $("#t-update-info-group").show();
        $("#t-matched-entry-info").html(`
            <i class="fa-solid fa-link"></i>
            UID: ${entry.matched_uid}
            ${entry.matched_book ? `(${entry.matched_book})` : ''}
        `);

        // 显示原有内容（如果有）
        if (entry.originalContent) {
            $("#t-original-content-text").text(entry.originalContent);
            $(".t-original-content-section").show();
            // 默认收起原有内容
            $("#t-original-content-box").hide();
            $("#t-btn-toggle-original i").removeClass("fa-chevron-up").addClass("fa-chevron-down");
        } else {
            $(".t-original-content-section").hide();
        }

        // 显示保存模式选择
        $(".t-save-mode-section").show();
        // 重置为默认的替换模式
        $("input[name='t-save-mode'][value='replace']").prop("checked", true);
    } else {
        $("#t-update-info-group").hide();
        $(".t-original-content-section").hide();
        $(".t-save-mode-section").hide();
    }

    // 更新移动端标题
    const keysStr = Array.isArray(entry.keys) ? entry.keys.join(", ") : entry.keys;
    $("#t-mobile-edit-title").text(keysStr || `条目 ${index + 1}`);
}

/**
 * 更新移动端导航按钮状态
 * @param {number} currentIndex
 */
function updateMobileNavButtons(currentIndex) {
    const total = currentEntries.length;

    // 上一条按钮
    if (currentIndex <= 0) {
        $("#t-mobile-prev-entry").prop("disabled", true);
    } else {
        $("#t-mobile-prev-entry").prop("disabled", false);
    }

    // 下一条按钮
    if (currentIndex >= total - 1) {
        $("#t-mobile-next-entry").prop("disabled", true);
    } else {
        $("#t-mobile-next-entry").prop("disabled", false);
    }
}

/**
 * 获取默认的总结系统提示词
 */
function getDefaultSummaryPrompt() {
    return `你是一位专业的故事分析师和会话记录员。你的任务是分析提供的角色扮演聊天历史，并生成一份结构化的总结。

[你的目标]
1. 准确捕捉故事的当前状态
2. 记录可能需要后续参考的重要细节
3. 追踪角色发展和人物关系
4. 标注任何未解决的情节线或伏笔

[输出格式]
请使用以下格式生成总结：

## 📍 当前场景
[描述当前所在位置、时间、环境氛围]

## 👥 角色状态
[列出主要角色的当前状态、位置、情绪、装备等]
- **角色名**: 状态描述

## 📜 情节回顾
[按时间顺序列出本段对话中发生的重要事件]
1. 事件描述
2. 事件描述

## 💬 重要对话/信息
[记录任何重要的对话内容、揭示的信息、约定等]

## 🔮 悬念/待办
[列出任何未解决的问题、伏笔、待处理事项]

[规则]
1. 简洁但全面 - 不要遗漏重要细节
2. 专注于文本中的事实，不要添加推测
3. 如果信息不明确，使用 [?] 标记不确定性
4. 保持总结的可操作性，便于将来参考`;
}

/**
 * 显示提示词预览弹窗（生成前预览）
 * @param {Array} messages - 将要发送的 messages 数组
 * @param {object} stats - 统计信息
 * @param {number} stats.historyCount - 实际读取的历史条数
 * @param {boolean} stats.relevantHistoryFound - 是否找到相关历史（仅总结模式）
 * @param {number} stats.existingEntriesCount - 现有世界书条目数（仅提取模式）
 * @param {number} stats.requestedLimit - 用户请求的条数
 * @param {boolean} stats.isExtractMode - 是否是设定提取模式
 */
function showPromptPreviewDialog(messages, stats = {}) {
    // 移除旧弹窗
    $("#t-prompt-view-dialog").remove();

    const systemMsg = messages.find(m => m.role === "system");
    const userMsg = messages.find(m => m.role === "user");

    // 计算 User Prompt 中的字符数
    const userContentLength = userMsg?.content?.length || 0;

    // 根据模式生成不同的统计信息
    let statsHtml;
    if (stats.isExtractMode) {
        // 设定提取模式
        statsHtml = `
            <div class="t-stat-item">
                <i class="fa-solid fa-comments"></i>
                <span>请求条数: <strong>${stats.requestedLimit || '?'}</strong></span>
            </div>
            <div class="t-stat-item">
                <i class="fa-solid fa-check-circle" style="color: ${stats.historyCount > 0 ? '#2ecc71' : '#e74c3c'};"></i>
                <span>实际读取: <strong>${stats.historyCount || 0}</strong> 条</span>
            </div>
            <div class="t-stat-item">
                <i class="fa-solid fa-book" style="color: ${stats.existingEntriesCount > 0 ? '#2ecc71' : '#888'};"></i>
                <span>现有条目: <strong>${stats.existingEntriesCount || 0}</strong> 条</span>
            </div>
            <div class="t-stat-item">
                <i class="fa-solid fa-text-width"></i>
                <span>User 内容: <strong>${userContentLength.toLocaleString()}</strong> 字符</span>
            </div>
        `;
    } else {
        // 智能总结模式
        statsHtml = `
            <div class="t-stat-item">
                <i class="fa-solid fa-comments"></i>
                <span>请求条数: <strong>${stats.requestedLimit || '?'}</strong></span>
            </div>
            <div class="t-stat-item">
                <i class="fa-solid fa-check-circle" style="color: ${stats.historyCount > 0 ? '#2ecc71' : '#e74c3c'};"></i>
                <span>实际读取: <strong>${stats.historyCount || 0}</strong> 条</span>
            </div>
            <div class="t-stat-item">
                <i class="fa-solid fa-database" style="color: ${stats.relevantHistoryFound ? '#2ecc71' : '#888'};"></i>
                <span>相关历史: <strong>${stats.relevantHistoryFound ? '已召回' : '无'}</strong></span>
            </div>
            <div class="t-stat-item">
                <i class="fa-solid fa-text-width"></i>
                <span>User 内容: <strong>${userContentLength.toLocaleString()}</strong> 字符</span>
            </div>
        `;
    }

    const html = `
    <div id="t-prompt-view-dialog" class="t-dialog-overlay t-root">
        <div class="t-dialog-box" style="max-width: 900px; max-height: 85vh;">
            <div class="t-dialog-header">
                <span><i class="fa-solid fa-eye"></i> 提示词预览${stats.isExtractMode ? ' (设定提取)' : ' (智能总结)'}</span>
                <div class="t-dialog-close" id="t-prompt-view-close"><i class="fa-solid fa-times"></i></div>
            </div>
            <div class="t-dialog-body" style="padding: 0; overflow: hidden;">
                <!-- 统计信息栏 -->
                <div class="t-prompt-stats">
                    ${statsHtml}
                </div>

                <div class="t-prompt-tabs">
                    <button class="t-prompt-tab active" data-role="system">
                        <i class="fa-solid fa-robot"></i> System Prompt
                    </button>
                    <button class="t-prompt-tab" data-role="user">
                        <i class="fa-solid fa-user"></i> User Prompt
                    </button>
                    <button class="t-prompt-tab" data-role="raw">
                        <i class="fa-solid fa-file-code"></i> 原始 JSON
                    </button>
                </div>
                <div class="t-prompt-content-container">
                    <div id="t-prompt-content-system" class="t-prompt-content active"></div>
                    <div id="t-prompt-content-user" class="t-prompt-content" style="display: none;"></div>
                    <div id="t-prompt-content-raw" class="t-prompt-content" style="display: none;"></div>
                </div>
            </div>
            <div class="t-dialog-footer">
                <div style="display: flex; gap: 8px;">
                    <button id="t-btn-copy-system-prompt" class="t-btn t-btn-xs">
                        <i class="fa-solid fa-copy"></i> 复制 System
                    </button>
                    <button id="t-btn-copy-user-prompt" class="t-btn t-btn-xs">
                        <i class="fa-solid fa-copy"></i> 复制 User
                    </button>
                    <button id="t-btn-copy-all-prompt" class="t-btn t-btn-xs">
                        <i class="fa-solid fa-copy"></i> 复制全部 JSON
                    </button>
                </div>
                <button id="t-btn-close-prompt-view" class="t-btn">关闭</button>
            </div>
        </div>
    </div>
    `;

    $("body").append(html);

    // 解析并显示内容
    $("#t-prompt-content-system").html(`<pre class="t-prompt-pre">${escapeHtml(systemMsg?.content || "(无)")}</pre>`);
    $("#t-prompt-content-user").html(`<pre class="t-prompt-pre">${escapeHtml(userMsg?.content || "(无)")}</pre>`);
    $("#t-prompt-content-raw").html(`<pre class="t-prompt-pre">${escapeHtml(JSON.stringify(messages, null, 2))}</pre>`);

    // 绑定 Tab 切换
    $("#t-prompt-view-dialog .t-prompt-tab").on("click", function () {
        const role = $(this).data("role");
        $("#t-prompt-view-dialog .t-prompt-tab").removeClass("active");
        $(this).addClass("active");
        $("#t-prompt-view-dialog .t-prompt-content").hide();
        $(`#t-prompt-content-${role}`).show();
    });

    // 绑定关闭
    $("#t-prompt-view-close, #t-btn-close-prompt-view").on("click", () => {
        $("#t-prompt-view-dialog").remove();
    });

    // 绑定复制
    $("#t-btn-copy-system-prompt").on("click", function () {
        navigator.clipboard.writeText(systemMsg?.content || "").then(() => {
            $(this).html('<i class="fa-solid fa-check"></i> 已复制');
            setTimeout(() => $(this).html('<i class="fa-solid fa-copy"></i> 复制 System'), 2000);
        });
    });

    $("#t-btn-copy-user-prompt").on("click", function () {
        navigator.clipboard.writeText(userMsg?.content || "").then(() => {
            $(this).html('<i class="fa-solid fa-check"></i> 已复制');
            setTimeout(() => $(this).html('<i class="fa-solid fa-copy"></i> 复制 User'), 2000);
        });
    });

    $("#t-btn-copy-all-prompt").on("click", function () {
        navigator.clipboard.writeText(JSON.stringify(messages, null, 2)).then(() => {
            $(this).html('<i class="fa-solid fa-check"></i> 已复制');
            setTimeout(() => $(this).html('<i class="fa-solid fa-copy"></i> 复制全部 JSON'), 2000);
        });
    });
}

/**
 * 显示文本清洗预览弹窗
 * @param {Array} samples - 聊天历史样本消息数组
 */
function showCleaningPreviewDialog(samples) {
    // 移除旧弹窗
    $("#t-cleaning-preview-dialog").remove();

    // 获取当前清洗配置
    const config = getTextCleaningConfig();

    // 处理每条消息的清洗
    const cleanedSamples = samples.map((msg, index) => {
        const originalText = msg.mes || msg.message || "";
        const role = msg.is_user ? "user" : "char";
        const cleaned = cleanTextForEmbedding(originalText);
        const stats = getCleaningStats(originalText, cleaned);

        return {
            index: samples.length - index, // 倒序编号，最新的消息编号最大
            role,
            roleName: msg.is_user ? "用户" : (msg.name || "角色"),
            original: originalText,
            cleaned,
            stats,
            isValid: cleaned.trim().length >= (config.min_text_length || 20)
        };
    });

    // 计算总体统计
    const totalOriginalLength = cleanedSamples.reduce((sum, s) => sum + s.stats.originalLength, 0);
    const totalCleanedLength = cleanedSamples.reduce((sum, s) => sum + s.stats.cleanedLength, 0);
    const totalReduction = totalOriginalLength > 0
        ? Math.round(((totalOriginalLength - totalCleanedLength) / totalOriginalLength) * 100)
        : 0;
    const validCount = cleanedSamples.filter(s => s.isValid).length;

    // 生成配置状态显示
    const configItems = [
        { name: "HTML标签", enabled: config.remove_html_tags },
        { name: "Style标签", enabled: config.remove_style_tags },
        { name: "思考标签", enabled: config.remove_thinking_tags },
        { name: "OOC标签", enabled: config.remove_ooc_tags },
        { name: "系统标签", enabled: config.remove_system_tags },
        { name: "Markdown", enabled: config.remove_markdown },
        { name: "宏残留", enabled: config.remove_macro_residue },
        { name: "方括号标记", enabled: config.remove_bracket_markers }
    ];

    const configHtml = configItems.map(item =>
        `<span class="t-config-tag ${item.enabled ? 't-config-enabled' : 't-config-disabled'}">
            <i class="fa-solid ${item.enabled ? 'fa-check' : 'fa-times'}"></i> ${item.name}
        </span>`
    ).join('');

    // 生成消息列表 HTML
    const messagesHtml = cleanedSamples.map(sample => `
        <div class="t-cleaning-sample ${sample.isValid ? '' : 't-sample-invalid'}">
            <div class="t-sample-header">
                <span class="t-sample-role ${sample.role === 'user' ? 't-role-user' : 't-role-char'}">
                    <i class="fa-solid ${sample.role === 'user' ? 'fa-user' : 'fa-robot'}"></i>
                    ${sample.roleName}
                </span>
                <span class="t-sample-stats">
                    ${sample.stats.originalLength} → ${sample.stats.cleanedLength} 字符
                    <span class="t-reduction ${sample.stats.reductionPercent > 0 ? 't-has-reduction' : ''}">
                        (-${sample.stats.reductionPercent}%)
                    </span>
                    ${!sample.isValid ? '<span class="t-invalid-badge"><i class="fa-solid fa-exclamation-triangle"></i> 过短</span>' : ''}
                </span>
            </div>
            <div class="t-sample-content">
                <div class="t-sample-pane t-pane-original">
                    <div class="t-pane-header"><i class="fa-solid fa-file-alt"></i> 原始文本</div>
                    <div class="t-pane-body">${escapeHtml(sample.original || "(空)")}</div>
                </div>
                <div class="t-sample-pane t-pane-cleaned">
                    <div class="t-pane-header"><i class="fa-solid fa-broom"></i> 清洗后</div>
                    <div class="t-pane-body">${escapeHtml(sample.cleaned || "(空)")}</div>
                </div>
            </div>
        </div>
    `).join('');

    const html = `
    <div id="t-cleaning-preview-dialog" class="t-dialog-overlay t-root">
        <div class="t-dialog-box t-cleaning-preview-box" style="max-width: 1000px; max-height: 85vh;">
            <div class="t-dialog-header">
                <span><i class="fa-solid fa-broom"></i> 文本清洗预览</span>
                <div class="t-dialog-close" id="t-cleaning-preview-close"><i class="fa-solid fa-times"></i></div>
            </div>
            <div class="t-dialog-body" style="padding: 0; overflow: hidden; display: flex; flex-direction: column;">
                <!-- 统计信息栏 -->
                <div class="t-cleaning-stats-bar">
                    <div class="t-cleaning-stat">
                        <i class="fa-solid fa-comments"></i>
                        <span>样本消息: <strong>${cleanedSamples.length}</strong> 条</span>
                    </div>
                    <div class="t-cleaning-stat">
                        <i class="fa-solid fa-compress-arrows-alt"></i>
                        <span>总压缩率: <strong>${totalReduction}%</strong></span>
                    </div>
                    <div class="t-cleaning-stat">
                        <i class="fa-solid fa-check-circle" style="color: ${validCount === cleanedSamples.length ? '#2ecc71' : '#f39c12'};"></i>
                        <span>有效消息: <strong>${validCount}/${cleanedSamples.length}</strong></span>
                    </div>
                    <div class="t-cleaning-stat">
                        <i class="fa-solid fa-ruler"></i>
                        <span>最小长度: <strong>${config.min_text_length || 20}</strong> 字符</span>
                    </div>
                </div>

                <!-- 当前配置展示 -->
                <div class="t-cleaning-config-bar">
                    <span class="t-config-label"><i class="fa-solid fa-cog"></i> 当前清洗规则:</span>
                    <div class="t-config-tags">${configHtml}</div>
                    ${config.custom_tags_to_remove ? `<span class="t-custom-tags">自定义: ${escapeHtml(config.custom_tags_to_remove)}</span>` : ''}
                </div>

                <!-- 消息预览列表 -->
                <div class="t-cleaning-samples-container">
                    ${messagesHtml}
                </div>
            </div>
            <div class="t-dialog-footer">
                <div class="t-footer-hint">
                    <i class="fa-solid fa-info-circle"></i>
                    <span>预览显示最近 ${cleanedSamples.length} 条消息的清洗效果。可在「设置 → Embedding」中调整清洗规则。</span>
                </div>
                <button id="t-btn-close-cleaning-preview" class="t-btn">关闭</button>
            </div>
        </div>
    </div>
    `;

    $("body").append(html);

    // 样式已迁至 css/04-features/cleaning-preview.css，随插件 CSS 一同加载，
    // 不再需要运行时注入到 document.head。

    // 绑定关闭事件
    $("#t-cleaning-preview-close, #t-btn-close-cleaning-preview").on("click", () => {
        $("#t-cleaning-preview-dialog").remove();
    });
}
