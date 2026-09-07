// src/ui/storyOutlineWindow.js

import { getContextData } from "../core/context.js";
import { sendChatRequestWithConnection, getConnectionByProfileId, getActiveConnection } from "../core/connection.js";
import { normalizeApiBaseUrl, normalizeRewriteCustomProfiles } from "../core/apiProfileRegistry.js";
import { ensureFeatureCss } from "../utils/dom.js";
import { getExtData, saveExtData } from "../utils/storage.js";
import { parseTagWhitelistInput, extractTextByWhitelist } from "../utils/chatTagWhitelist.js";
import {
    createApiConnectionEditor,
    mapConnectionProfilesToCustomProfiles,
    mapCustomProfilesToConnectionProfiles,
    renderApiConnectionEditorHTML,
} from "./shared/apiConnectionEditor.js";

let outlineItems = [];
let lastRawResponse = "";
let rawResponseHistory = [];
let sceneExpandedMap = {};
let selectedRowIndex = -1;
let desktopEditorIndex = -1;
let isRawDialogOpen = false;
let editorSubView = "outline";
let sceneEditorItemIndex = -1;
let mobileEditorSubView = "outline";
let responseTimerStartAt = 0;
let responseElapsedMs = 0;
let responseTimerId = null;
let responseTimerRunning = false;
let activeOutlineAbortController = null;

const DRAFT_KEY = "story_outline_draft";
const PLANS_KEY = "story_outline_plans";
const ACTIVE_PLAN_KEY = "story_outline_active_plan_id";
const SCENE_SOURCE_PLAN_KEY = "story_outline_scene_source_plan_id";
const PROMPT_TEMPLATES_KEY = "story_outline_prompt_templates";
const OPENING_SOURCE_MODE_KEY = "story_outline_opening_source_mode";
const OPENING_SOURCE_REF_KEY = "story_outline_opening_source_ref";
const OUTLINE_CHAT_TAG_WHITELIST_KEY = "story_outline_chat_tag_whitelist";
const RAW_HISTORY_KEY = "story_outline_raw_history";
const OUTLINE_SELECTED_PROFILE_KEY = "story_outline_selected_profile_id";
const OUTLINE_CUSTOM_PROFILES_KEY = "story_outline_custom_profiles";
const GEN_PARAMS_KEY = "story_outline_gen_params";

// 生成参数默认值（沿用改成可配置前写死的数值）。timeoutSec=0 表示不限制。
function getGenParamDefaults() {
    return {
        outline: { temperature: 0.4, maxTokens: 20000, timeoutSec: 0 },
        scenes: { temperature: 0.8, maxTokens: 60000, timeoutSec: 0 }
    };
}

// 把单组参数规范化到安全范围，缺失/非法回退到默认。
function normalizeGenParamGroup(raw, fallback) {
    const src = raw && typeof raw === "object" ? raw : {};
    const temp = Number(src.temperature);
    const maxTok = Number(src.maxTokens);
    const timeout = Number(src.timeoutSec);
    return {
        temperature: Number.isFinite(temp) ? Math.min(2, Math.max(0, temp)) : fallback.temperature,
        maxTokens: Number.isFinite(maxTok) && maxTok >= 256 ? Math.min(200000, Math.floor(maxTok)) : fallback.maxTokens,
        timeoutSec: Number.isFinite(timeout) && timeout > 0 ? Math.min(3600, Math.floor(timeout)) : 0
    };
}

function getOutlineGenParams() {
    const data = getExtData();
    const defaults = getGenParamDefaults();
    const raw = data?.[GEN_PARAMS_KEY] && typeof data[GEN_PARAMS_KEY] === "object" ? data[GEN_PARAMS_KEY] : {};
    return {
        outline: normalizeGenParamGroup(raw.outline, defaults.outline),
        scenes: normalizeGenParamGroup(raw.scenes, defaults.scenes)
    };
}

function saveOutlineGenParams(params) {
    const data = getExtData();
    const defaults = getGenParamDefaults();
    data[GEN_PARAMS_KEY] = {
        outline: normalizeGenParamGroup(params?.outline, defaults.outline),
        scenes: normalizeGenParamGroup(params?.scenes, defaults.scenes)
    };
    saveExtData();
}

// 渐进续写读取的酒馆正文楼层数（0=不读，仅用大纲与已生成细纲推进）。
const ROLLING_CHAT_FLOORS_KEY = "story_outline_rolling_chat_floors";
const ROLLING_CHAT_FLOORS_DEFAULT = 6;

function getRollingChatFloors() {
    const data = getExtData();
    const raw = Number(data?.[ROLLING_CHAT_FLOORS_KEY]);
    if (!Number.isFinite(raw) || raw < 0) return ROLLING_CHAT_FLOORS_DEFAULT;
    return Math.min(50, Math.floor(raw));
}

function saveRollingChatFloors(n) {
    const data = getExtData();
    const raw = Number(n);
    data[ROLLING_CHAT_FLOORS_KEY] = Number.isFinite(raw) && raw >= 0 ? Math.min(50, Math.floor(raw)) : ROLLING_CHAT_FLOORS_DEFAULT;
    saveExtData();
}

let currentView = "hub";
let activePlanId = "";
let editingPlanId = "";
let editingPlanBaseline = "";
let planItemCursorMap = {};
let sceneHubSelectedKey = "";
let autoSavePlanTimer = null;
let planRenameMode = false;
let planRenameSnapshot = "";
const MAX_RAW_HISTORY = 24;

function pushRawResponseHistory(content, typeLabel = "模型响应") {
    const text = String(content || "").trim();
    if (!text) return;
    const charName = getCurrentCharCardName() || "未命名角色";
    if (rawResponseHistory[0]?.content === text) {
        lastRawResponse = text;
        return;
    }
    rawResponseHistory.unshift({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        typeLabel,
        charName,
        createdAt: Date.now(),
        content: text
    });
    if (rawResponseHistory.length > MAX_RAW_HISTORY) {
        rawResponseHistory = rawResponseHistory.slice(0, MAX_RAW_HISTORY);
    }
    lastRawResponse = text;
    persistRawResponseHistory();
}

function loadRawResponseHistory() {
    const data = getExtData();
    const list = Array.isArray(data?.[RAW_HISTORY_KEY]) ? data[RAW_HISTORY_KEY] : [];
    return list
        .map((entry) => ({
            id: String(entry?.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
            typeLabel: String(entry?.typeLabel || "模型响应"),
            charName: String(entry?.charName || "未命名角色"),
            createdAt: Number(entry?.createdAt) || Date.now(),
            content: String(entry?.content || "")
        }))
        .filter(entry => entry.content.trim())
        .slice(0, MAX_RAW_HISTORY);
}

function persistRawResponseHistory() {
    const data = getExtData();
    data[RAW_HISTORY_KEY] = Array.isArray(rawResponseHistory)
        ? rawResponseHistory.slice(0, MAX_RAW_HISTORY)
        : [];
    saveExtData();
}

function formatRawHistoryTime(ts) {
    const d = new Date(ts || Date.now());
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function formatElapsedDuration(ms) {
    const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hour = Math.floor(totalSec / 3600);
    const minute = Math.floor((totalSec % 3600) / 60);
    const second = totalSec % 60;
    if (hour > 0) {
        return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
    }
    return `${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function sanitizeFileNamePart(name) {
    const raw = String(name || "").trim();
    const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
    return safe || "未命名角色";
}

function formatFileTimestamp(ts = Date.now()) {
    const d = new Date(ts);
    const yyyy = d.getFullYear();
    const MM = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${yyyy}${MM}${dd}_${hh}${mm}${ss}`;
}

function exportRawResponseHistory() {
    const history = Array.isArray(rawResponseHistory) ? rawResponseHistory : [];
    if (history.length === 0) {
        if (window.toastr) toastr.warning("暂无可导出的生成历史", "故事大纲");
        return;
    }
    const charName = sanitizeFileNamePart(history[0]?.charName || getCurrentCharCardName());
    const timestamp = formatFileTimestamp();
    const payload = {
        version: "1.0",
        exportedAt: new Date().toISOString(),
        charName,
        count: history.length,
        items: history.map((entry) => ({
            id: entry.id,
            typeLabel: entry.typeLabel,
            charName: entry.charName || charName,
            createdAt: new Date(entry.createdAt || Date.now()).toISOString(),
            content: entry.content || ""
        }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `titania_outline_history_${charName}_${timestamp}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
    }, 0);
    if (window.toastr) toastr.success(`已导出生成历史：${a.download}`, "故事大纲");
}

function getCurrentElapsedMs() {
    if (!responseTimerRunning) return responseElapsedMs;
    return Math.max(0, Date.now() - responseTimerStartAt);
}

function updateResponseTimerUI() {
    if ($("#t-outline-raw-elapsed").length === 0) return;
    $("#t-outline-raw-elapsed").text(`耗时: ${formatElapsedDuration(getCurrentElapsedMs())}`);
}

function getOutlineSelectedProfileId() {
    const data = getExtData();
    return String(data?.[OUTLINE_SELECTED_PROFILE_KEY] || "").trim();
}

function saveOutlineSelectedProfileId(profileId) {
    const data = getExtData();
    data[OUTLINE_SELECTED_PROFILE_KEY] = String(profileId || "").trim();
    saveExtData();
}

function getOutlineCustomProfiles() {
    const data = getExtData();
    const fallback = {
        api_url: normalizeApiBaseUrl(String(data?.config?.url || "")),
        api_key: String(data?.config?.key || ""),
        model: String(data?.config?.model || "")
    };
    return normalizeRewriteCustomProfiles(data?.[OUTLINE_CUSTOM_PROFILES_KEY], fallback);
}

function saveOutlineCustomProfiles(profiles) {
    const data = getExtData();
    data[OUTLINE_CUSTOM_PROFILES_KEY] = normalizeRewriteCustomProfiles(profiles, null);
    saveExtData();
}

// 大纲的"跟随 SillyTavern 主连接"方案 id。选中它时不走独立的自定义方案，
// 而是复用主连接体系（ST 后端托管，无需自己填 url/key）。与 connection.js 的 st_sync 对齐。
const OUTLINE_ST_FOLLOW_ID = "st_sync";

function isOutlineStFollowSelected(profileId = null) {
    const preferred = String(profileId || getOutlineSelectedProfileId() || "").trim();
    return preferred === OUTLINE_ST_FOLLOW_ID;
}

// 给设置页的方案下拉最前面加上"跟随 SillyTavern 主连接"（internal 类型，编辑器会自动
// 禁用 url/key 输入并显示"由 ST 托管"）。自定义方案原样跟在后面。
function buildOutlineEditorProfiles(customProfiles) {
    const followProfile = {
        id: OUTLINE_ST_FOLLOW_ID,
        name: "🔗 跟随 SillyTavern (主连接)",
        type: "internal",
        readonly: true,
        url: "",
        key: "",
        model: "gpt-3.5-turbo"
    };
    return [followProfile, ...mapCustomProfilesToConnectionProfiles(customProfiles, "gpt-3.5-turbo")];
}

// 设置页里 internal 方案要展示的 ST 连接地址（只读提示用）。
function getOutlineInternalUrlLabel() {
    try {
        const conn = getConnectionByProfileId(OUTLINE_ST_FOLLOW_ID) || getActiveConnection();
        return String(conn?.url || "由 ST 托管");
    } catch {
        return "由 ST 托管";
    }
}

function resolveOutlineProfileSelection(profileId = null) {
    const profiles = getOutlineCustomProfiles();
    if (profiles.length === 0) return { profileId: "", profiles };

    const preferred = String(profileId || getOutlineSelectedProfileId() || "").trim();
    const selected = profiles.some((p) => p.id === preferred) ? preferred : (profiles[0]?.id || "");
    return { profileId: selected, profiles };
}

function getOutlineActiveProfile() {
    const resolved = resolveOutlineProfileSelection();
    const selected = resolved.profiles.find((p) => p.id === resolved.profileId) || null;
    if (!selected) return null;
    return selected;
}

// 把选中的方案解析成一个可直接发送的连接对象。ST-follow 走主连接（useSTConnection:true），
// 否则用大纲自己的独立方案自建裸连接。返回 null 表示无有效方案。
function resolveOutlineConnection(model) {
    if (isOutlineStFollowSelected()) {
        // 复用主连接体系里的 st_sync（内部连接），拿不到就退回当前激活连接。
        const conn = getConnectionByProfileId(OUTLINE_ST_FOLLOW_ID, model || null) || getActiveConnection();
        return { ...conn, stream: conn.stream };
    }

    const profile = getOutlineActiveProfile();
    if (!profile) return null;

    const apiUrl = normalizeApiBaseUrl(String(profile.api_url || "").trim());
    if (!apiUrl) throw new Error("请先填写 API 地址");

    return {
        useSTConnection: false,
        profileName: "故事大纲",
        url: apiUrl,
        key: String(profile.api_key || "").trim(),
        model: model || String(profile.model || "").trim()
    };
}

async function sendOutlineRequest(messages, options = {}) {
    const requestModel = String(options.model || "").trim();
    const conn = resolveOutlineConnection(requestModel);
    if (!conn) throw new Error("请先在设置中选择 API 方案");

    const model = requestModel || String(conn.model || "").trim();
    // 走 ST 主连接时模型由 ST 托管，不强制要求；自定义方案则必须先选模型。
    if (!conn.useSTConnection && !model) throw new Error("请先选择模型");

    return sendChatRequestWithConnection({ ...conn, stream: options.stream === true }, messages, {
        model,
        stream: options.stream === true,
        maxTokens: Number(options.maxTokens) || 2048,
        temperature: Number.isFinite(options.temperature) ? options.temperature : 0.7,
        signal: options.signal,
        allowEmptyKey: true,
        onProgress: typeof options.onProgress === "function" ? options.onProgress : undefined
    });
}

function setRawWaitingAnimation(active) {
    const $anim = $("#t-outline-raw-mood");
    if ($anim.length === 0) return;
    $anim.toggleClass("is-active", !!active);
}

function syncAbortButtonUI() {
    const $btn = $("#t-outline-raw-abort");
    if ($btn.length === 0) return;
    const active = !!activeOutlineAbortController;
    $btn.prop("disabled", !active).toggle(active);
}

// 用中断信号包裹一次大纲生成：期间挂上 AbortController、露出「终止」按钮，
// 结束后无论成败都清理，避免中断状态泄漏到下一次生成。
// timeoutSec>0 时到点自动中断，并把错误标记为超时，便于上层区分「用户终止」与「超时」。
async function runOutlineGeneration(task, { timeoutSec = 0 } = {}) {
    const controller = new AbortController();
    activeOutlineAbortController = controller;
    let timedOut = false;
    let timeoutTimer = null;
    if (timeoutSec > 0) {
        timeoutTimer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutSec * 1000);
    }
    syncAbortButtonUI();
    try {
        return await task(controller.signal);
    } catch (e) {
        if (timedOut && isAbortError(e)) {
            const err = new Error(`响应超时（超过 ${timeoutSec} 秒）`);
            err.name = "AbortError";
            err.__timeout = true;
            throw err;
        }
        throw e;
    } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        activeOutlineAbortController = null;
        syncAbortButtonUI();
    }
}

function isAbortError(e) {
    return e && (e.name === "AbortError" || /aborted/i.test(String(e.message || "")));
}

// 生成流程收尾时的统一错误上报：区分超时、用户终止、真实错误，写好流式预览状态与 toast。
function reportGenerationError(e, label, failMessage) {
    if (e?.__timeout) {
        if (isStreamingEnabled()) updateRawPreview("已超时中断");
        if (window.toastr) toastr.warning(e.message || "响应超时，已中断生成", label);
        return;
    }
    if (isAbortError(e)) {
        if (isStreamingEnabled()) updateRawPreview("已终止生成");
        if (window.toastr) toastr.info(`已终止${label === "故事细纲" ? "细纲" : "大纲"}生成`, label);
        return;
    }
    console.error(`Titania: ${label}生成失败`, e);
    if (isStreamingEnabled()) updateRawPreview("生成失败");
    if (window.toastr) toastr.error(e?.message || failMessage, label);
}

function startResponseTimer(reset = true) {
    if (reset) responseElapsedMs = 0;
    responseTimerStartAt = Date.now() - (reset ? 0 : responseElapsedMs);
    responseTimerRunning = true;
    if (responseTimerId) clearInterval(responseTimerId);
    responseTimerId = setInterval(updateResponseTimerUI, 250);
    updateResponseTimerUI();
    setRawWaitingAnimation(true);
}

function stopResponseTimer() {
    if (responseTimerRunning) {
        responseElapsedMs = getCurrentElapsedMs();
    }
    responseTimerRunning = false;
    if (responseTimerId) {
        clearInterval(responseTimerId);
        responseTimerId = null;
    }
    updateResponseTimerUI();
    setRawWaitingAnimation(false);
}

// 路径由 css/manifest.js 统一解析，不再硬编码扁平路径（B1）
function ensureCssLoaded() {
    ensureFeatureCss("story-outline.css");
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
}

function getOpeningFromContext() {
    try {
        if (typeof SillyTavern === "undefined" || !SillyTavern.getContext) return "";
        const stCtx = SillyTavern.getContext();
        const charObj = stCtx?.characters?.[stCtx?.characterId] || null;
        const data = charObj?.data || {};

        const candidates = [
            data.first_mes,
            data.first_message,
            charObj?.first_mes,
            charObj?.first_message,
            data.scenario,
            charObj?.scenario
        ];

        for (const item of candidates) {
            if (typeof item === "string" && item.trim()) return item.trim();
        }

        const firstChat = Array.isArray(stCtx?.chat) ? stCtx.chat[0] : null;
        if (firstChat?.mes && typeof firstChat.mes === "string") return firstChat.mes.trim();
    } catch (e) {
        console.warn("Titania: 获取开场白失败", e);
    }
    return "";
}

function getOpeningSourceMode() {
    const data = getExtData();
    return data?.[OPENING_SOURCE_MODE_KEY] === "chat_selected" ? "chat_selected" : "auto_first";
}

function setOpeningSourceMode(mode) {
    const data = getExtData();
    data[OPENING_SOURCE_MODE_KEY] = mode === "chat_selected" ? "chat_selected" : "auto_first";
    saveExtData();
}

function getOpeningSourceRef() {
    const data = getExtData();
    const raw = data?.[OPENING_SOURCE_REF_KEY];
    if (!raw || typeof raw !== "object") return null;
    if (raw.type === "card_opening") {
        const openingIndex = Number(raw.openingIndex);
        if (Number.isNaN(openingIndex) || openingIndex < 0) return null;
        return {
            type: "card_opening",
            openingIndex,
            preview: String(raw.preview || "")
        };
    }
    if (raw.type === "chat" || typeof raw.chatIndex !== "undefined") {
        const chatIndex = Number(raw.chatIndex);
        if (Number.isNaN(chatIndex) || chatIndex < 0) return null;
        return {
            type: "chat",
            chatIndex,
            preview: String(raw.preview || "")
        };
    }
    return null;
}

function getOutlineChatTagWhitelistRaw() {
    const data = getExtData();
    return String(data?.[OUTLINE_CHAT_TAG_WHITELIST_KEY] || "").trim();
}

function setOutlineChatTagWhitelistRaw(rawInput) {
    const data = getExtData();
    data[OUTLINE_CHAT_TAG_WHITELIST_KEY] = String(rawInput || "").trim();
    saveExtData();
}

function setOpeningSourceRef(ref) {
    const data = getExtData();
    if (!ref || typeof ref !== "object") {
        data[OPENING_SOURCE_REF_KEY] = null;
    } else if (ref.type === "card_opening" && !Number.isNaN(Number(ref.openingIndex))) {
        data[OPENING_SOURCE_REF_KEY] = {
            type: "card_opening",
            openingIndex: Number(ref.openingIndex),
            preview: String(ref.preview || "")
        };
    } else if (!Number.isNaN(Number(ref.chatIndex))) {
        data[OPENING_SOURCE_REF_KEY] = {
            type: "chat",
            chatIndex: Number(ref.chatIndex),
            preview: String(ref.preview || "")
        };
    } else {
        data[OPENING_SOURCE_REF_KEY] = null;
    }
    saveExtData();
}

function getCardOpeningEntries() {
    try {
        if (typeof SillyTavern === "undefined" || !SillyTavern.getContext) return [];
        const stCtx = SillyTavern.getContext();
        const charObj = stCtx?.characters?.[stCtx?.characterId] || null;
        const data = charObj?.data || {};

        const list = [];
        const pushText = (text) => {
            const value = String(text || "").trim();
            if (!value) return;
            if (list.includes(value)) return;
            list.push(value);
        };

        pushText(data.first_mes);
        pushText(data.first_message);
        pushText(charObj?.first_mes);
        pushText(charObj?.first_message);

        const arrays = [
            data.alternate_greetings,
            data.alternateGreetings,
            data.greetings,
            charObj?.alternate_greetings,
            charObj?.alternateGreetings,
            charObj?.greetings
        ];

        arrays.forEach((arr) => {
            if (!Array.isArray(arr)) return;
            arr.forEach((item) => {
                if (typeof item === "string") {
                    pushText(item);
                    return;
                }
                if (item && typeof item === "object") {
                    pushText(item.mes);
                    pushText(item.message);
                    pushText(item.text);
                    pushText(item.content);
                }
            });
        });

        return list.map((text, idx) => ({
            openingIndex: idx,
            text
        }));
    } catch {
        return [];
    }
}

function getChatHistoryEntries() {
    try {
        if (typeof SillyTavern === "undefined" || !SillyTavern.getContext) return [];
        const stCtx = SillyTavern.getContext();
        const chat = Array.isArray(stCtx?.chat) ? stCtx.chat : [];
        const whitelist = parseTagWhitelistInput(getOutlineChatTagWhitelistRaw());
        return chat
            .map((msg, idx) => {
                const raw = typeof msg?.mes === "string" ? msg.mes : "";
                const text = extractTextByWhitelist(raw, whitelist);
                if (!text) return null;
                if (msg?.is_system || msg?.is_hidden) return null;
                return {
                    chatIndex: idx,
                    role: msg?.is_user ? "用户" : "角色",
                    text
                };
            })
            .filter(Boolean);
    } catch {
        return [];
    }
}

function getOpeningFromSelectedRef(sourceRef, entries) {
    if (!sourceRef) return "";
    if (sourceRef.type !== "chat") return "";
    const chatIndex = Number(sourceRef.chatIndex);
    if (Number.isNaN(chatIndex)) return "";
    const target = (entries || []).find(entry => entry.chatIndex === chatIndex);
    return target?.text || "";
}

function getOpeningFromCardRef(sourceRef, entries) {
    if (!sourceRef || sourceRef.type !== "card_opening") return "";
    const openingIndex = Number(sourceRef.openingIndex);
    if (Number.isNaN(openingIndex)) return "";
    const target = (entries || []).find(entry => entry.openingIndex === openingIndex);
    return target?.text || "";
}

function getOpeningTextForPreview(mode, sourceRef) {
    if (mode === "chat_selected") {
        const chatEntries = getChatHistoryEntries();
        return getOpeningFromSelectedRef(sourceRef, chatEntries) || getOpeningFromContext();
    }
    const cardEntries = getCardOpeningEntries();
    return getOpeningFromCardRef(sourceRef, cardEntries) || cardEntries[0]?.text || getOpeningFromContext();
}

function openOpeningSourcePickerDialog(initialChatIndex = -1) {
    const entries = getChatHistoryEntries();
    return new Promise((resolve) => {
        $("#t-outline-opening-picker").remove();
        const html = `
        <div id="t-outline-opening-picker" class="t-dialog-overlay t-dialog-overlay--outline t-root">
            <div class="t-dialog-box">
                <div class="t-dialog-header">
                    <span><i class="fa-solid fa-comment-dots"></i> 选择聊天记录参考来源</span>
                    <div class="t-dialog-close" id="t-opening-picker-close"><i class="fa-solid fa-times"></i></div>
                </div>
                <div class="t-dialog-body t-dialog-body--tight">
                    <div id="t-opening-picker-list" class="t-opening-picker-list"></div>
                </div>
                <div class="t-dialog-footer">
                    <button id="t-opening-picker-cancel" class="t-btn">取消</button>
                    <button id="t-opening-picker-confirm" class="t-btn t-btn-primary" disabled>确认使用</button>
                </div>
            </div>
        </div>`;
        $("body").append(html);

        const $dialog = $("#t-outline-opening-picker");
        const $list = $("#t-opening-picker-list");
        const $confirm = $("#t-opening-picker-confirm");
        let selectedIndex = Number(initialChatIndex);

        if (!Array.isArray(entries) || entries.length === 0) {
            $list.html('<div class="t-plan-empty">当前聊天历史为空，无法选择来源</div>');
        } else {
            const rows = entries.map((entry) => {
                const selected = entry.chatIndex === selectedIndex;
                return `
                    <div class="t-opening-picker-item ${selected ? "active" : ""}" data-chat-index="${entry.chatIndex}">
                        <div class="t-opening-picker-head">#${entry.chatIndex + 1} · ${entry.role}</div>
                        <div class="t-opening-picker-text">${escapeHtml(entry.text)}</div>
                    </div>
                `;
            }).join("");
            $list.html(rows);
            $confirm.prop("disabled", Number.isNaN(selectedIndex) || selectedIndex < 0);
        }

        const close = (result = null) => {
            $dialog.remove();
            resolve(result);
        };

        $dialog.on("click", "#t-opening-picker-close, #t-opening-picker-cancel", () => close(null));
        $dialog.on("click", ".t-opening-picker-item", function () {
            selectedIndex = Number($(this).data("chat-index"));
            $dialog.find(".t-opening-picker-item").removeClass("active");
            $(this).addClass("active");
            $confirm.prop("disabled", Number.isNaN(selectedIndex) || selectedIndex < 0);
        });

        $dialog.on("click", "#t-opening-picker-confirm", () => {
            if (Number.isNaN(selectedIndex) || selectedIndex < 0) return;
            const picked = entries.find(entry => entry.chatIndex === selectedIndex);
            if (!picked) return;
            close({
                chatIndex: picked.chatIndex,
                preview: picked.text.slice(0, 60)
            });
        });
    });
}

function openCardOpeningPickerDialog(initialOpeningIndex = -1) {
    const entries = getCardOpeningEntries();
    return new Promise((resolve) => {
        $("#t-outline-opening-picker").remove();
        $("#t-opening-detail-dialog").remove();
        const html = `
        <div id="t-outline-opening-picker" class="t-dialog-overlay t-dialog-overlay--outline t-root">
            <div class="t-dialog-box">
                <div class="t-dialog-header">
                    <span><i class="fa-solid fa-book-open"></i> 选择参考开场白</span>
                    <div class="t-dialog-close" id="t-opening-picker-close"><i class="fa-solid fa-times"></i></div>
                </div>
                <div class="t-dialog-body t-dialog-body--tight">
                    <div id="t-opening-picker-list" class="t-opening-card-grid"></div>
                </div>
                <div class="t-dialog-footer">
                    <button id="t-opening-picker-cancel" class="t-btn">取消</button>
                    <button id="t-opening-picker-confirm" class="t-btn t-btn-primary" disabled>确认使用</button>
                </div>
            </div>
        </div>`;
        $("body").append(html);

        const $dialog = $("#t-outline-opening-picker");
        const $list = $("#t-opening-picker-list");
        const $confirm = $("#t-opening-picker-confirm");
        let selectedIndex = Number(initialOpeningIndex);

        const openDetail = (entry) => {
            if (!entry) return;
            $("#t-opening-detail-dialog").remove();
            const detailHtml = `
            <div id="t-opening-detail-dialog" class="t-dialog-overlay t-dialog-overlay--outline t-root">
                <div class="t-dialog-box">
                    <div class="t-dialog-header">
                        <span><i class="fa-solid fa-file-lines"></i> 开场白 ${entry.openingIndex + 1} 详情</span>
                        <div class="t-dialog-close" id="t-opening-detail-close"><i class="fa-solid fa-times"></i></div>
                    </div>
                    <div class="t-dialog-body t-dialog-body--tight">
                        <pre class="t-outline-raw-pre">${escapeHtml(entry.text || "")}</pre>
                    </div>
                    <div class="t-dialog-footer">
                        <button id="t-opening-detail-close-btn" class="t-btn">关闭</button>
                    </div>
                </div>
            </div>`;
            $("body").append(detailHtml);
            $("#t-opening-detail-close, #t-opening-detail-close-btn").on("click", () => {
                $("#t-opening-detail-dialog").remove();
            });
        };

        if (!Array.isArray(entries) || entries.length === 0) {
            $list.html('<div class="t-plan-empty">当前角色卡没有可选开场白</div>');
        } else {
            const rows = entries.map((entry) => {
                const selected = entry.openingIndex === selectedIndex;
                const brief = String(entry.text || "").replace(/\s+/g, " ").trim();
                return `
                    <div class="t-opening-card ${selected ? "active" : ""}" data-opening-index="${entry.openingIndex}">
                        <div class="t-opening-card-head">
                            <span class="t-opening-card-title">开场白 ${entry.openingIndex + 1}</span>
                            <button class="t-btn t-btn-xs t-opening-card-detail" data-action="opening-card-detail" data-opening-index="${entry.openingIndex}"><i class="fa-solid fa-eye"></i> 查看详情</button>
                        </div>
                        <div class="t-opening-card-text">${escapeHtml(brief)}</div>
                    </div>
                `;
            }).join("");
            $list.html(rows);
            $confirm.prop("disabled", Number.isNaN(selectedIndex) || selectedIndex < 0);
        }

        const close = (result = null) => {
            $dialog.remove();
            $("#t-opening-detail-dialog").remove();
            resolve(result);
        };

        $dialog.on("click", "#t-opening-picker-close, #t-opening-picker-cancel", () => close(null));
        $dialog.on("click", ".t-opening-card", function () {
            selectedIndex = Number($(this).data("opening-index"));
            $dialog.find(".t-opening-card").removeClass("active");
            $(this).addClass("active");
            $confirm.prop("disabled", Number.isNaN(selectedIndex) || selectedIndex < 0);
        });

        $dialog.on("click", "[data-action='opening-card-detail']", function (e) {
            e.stopPropagation();
            const openingIndex = Number($(this).data("opening-index"));
            const entry = entries.find(item => item.openingIndex === openingIndex);
            openDetail(entry || null);
        });

        $dialog.on("click", "#t-opening-picker-confirm", () => {
            if (Number.isNaN(selectedIndex) || selectedIndex < 0) return;
            const picked = entries.find(entry => entry.openingIndex === selectedIndex);
            if (!picked) return;
            close({
                type: "card_opening",
                openingIndex: picked.openingIndex,
                preview: picked.text.slice(0, 60)
            });
        });
    });
}

async function ensureOpeningTextForGeneration() {
    const mode = getOpeningSourceMode();
    if (mode === "chat_selected") {
        const entries = getChatHistoryEntries();
        let sourceRef = getOpeningSourceRef();
        let openingText = getOpeningFromSelectedRef(sourceRef, entries);
        if (openingText) return openingText;

        const picked = await openOpeningSourcePickerDialog(sourceRef?.chatIndex ?? -1);
        if (!picked) throw new Error("未选择参考来源，已取消生成");
        setOpeningSourceRef({ type: "chat", ...picked });
        sourceRef = getOpeningSourceRef();
        openingText = getOpeningFromSelectedRef(sourceRef, entries);
        return openingText || "";
    }

    const cardEntries = getCardOpeningEntries();
    if (cardEntries.length === 0) return getOpeningFromContext();
    let sourceRef = getOpeningSourceRef();
    let openingText = getOpeningFromCardRef(sourceRef, cardEntries);
    if (openingText) return openingText;

    const picked = await openCardOpeningPickerDialog(sourceRef?.openingIndex ?? 0);
    if (!picked) throw new Error("未选择参考来源，已取消生成");
    setOpeningSourceRef(picked);
    sourceRef = getOpeningSourceRef();
    openingText = getOpeningFromCardRef(sourceRef, cardEntries);
    return openingText || cardEntries[0]?.text || getOpeningFromContext();
}

function getDefaultPromptTemplates() {
    return {
        outline: {
            system: `你是资深叙事策划。请基于给定信息设计剧情大纲。

[硬性要求]
1) 只能返回 JSON，不要 markdown，不要解释，不要多余文本。
2) 返回格式必须是：
{
  "version": "1.0",
  "story_summary": "一句话概括",
  "items": [
    {
      "index": 1,
      "time": "时间点",
      "title": "标题",
      "plot": "具体情节",
      "foreshadowing": "伏笔，可为空字符串"
    }
  ]
}
3) items 数量建议 6-12 条。
4) foreshadowing 字段必须存在，可为空字符串。
5) 情节需要连贯，允许阶段性转折。
6) 输出语言使用中文。`,
            user: `[角色设定]
{{persona}}

[用户设定]
{{userDesc}}

[世界书/设定]
{{worldInfo}}

[剧情设定]
{{scenario}}

[开场白]
{{openingText}}

[这张卡的故事需求]
{{storyInput}}

[任务]
请设计故事大纲，并严格按约定 JSON 返回。`
        },
        scenes: {
            system: `你是剧情分镜策划。基于输入“总纲 items”，为每个条目补全 scenes。

[硬性要求]
1) 只能返回 JSON，不要 markdown，不要解释，不要多余文本。
2) 只允许返回以下结构：
{
  "version": "1.2",
  "items": [
    {
      "index": 1,
      "scenes": [
        {
          "scene_index": 1,
          "scene_time": "时间点",
          "scene_location": "地点",
          "scene_goal": "本场目标",
          "conflict": "冲突",
          "key_beats": ["关键节点1", "关键节点2"],
          "sendable_prompt": "可供扩写的场景摘要段落",
          "notes": ""
        }
      ]
    }
  ]
}
3) items 数量必须与输入总纲一致；index 必须一一对应；不得缺失、不得新增、不得重排。
4) 仅补全 scenes，禁止改写总纲主线含义。
5) 每个 item 生成 3-5 个 scenes（默认 4 个，除非内容不足）。
6) 每个 scene 必须包含 scene_goal、conflict、key_beats、sendable_prompt。
7) key_beats 至少 2 条，单条不超过 24 字。
8) sendable_prompt 必须融合 conflict 与 key_beats，120-220 字，中文，具体可延展，不写“请你/你需要”。
9) 若信息不足，notes 填空字符串，不要编造额外字段。
10) 输出语言使用中文。`,
            user: `[角色设定]
{{persona}}

[用户设定]
{{userDesc}}

[世界书/设定]
{{worldInfo}}

[开场白]
{{openingText}}

[故事需求]
{{storyInput}}

[当前总纲 items]
{{outlineItemsJson}}

[任务]
请对每个 item 一次性生成 scenes。
保持总纲主线与顺序不变，只补全细纲内容。
严格使用 version 1.2 的精简结构，仅返回 index 和 scenes，不要返回 time/title/plot/foreshadowing/story_summary。
sendable_prompt 必须写成可供模型扩写/转述/润色的具体摘要段落，并融合 conflict 与 key_beats。
只返回 JSON。`
        },
        rolling: {
            system: `你是渐进式剧情推进策划。完整故事大纲已给定（最后一条即结局），你的职责是：结合"已经发生的剧情"，只生成"接下来 1~2 个场景"的细纲，让故事在大纲的暗中引导下自然、稳步地朝结局推进。

[核心原则]
1) 大纲是路标与终点约束：始终朝大纲结局收束，可提前埋伏笔、控制节奏，但绝不跳步、不一次写到结局。
2) 承接已发生的剧情：新场景必须自然衔接"已发生的剧情"的最后状态，不重复已经写过的情节。
3) 一次只推进一小步：只产出 1~2 个场景。仅当进度已到大纲最后一条、且剧情确实该收尾时，才允许写结局场景。

[硬性要求]
1) 只能返回 JSON，不要 markdown，不要解释，不要多余文本。
2) 只允许返回以下结构：
{
  "version": "1.3",
  "items": [
    {
      "index": 1,
      "scenes": [
        {
          "scene_index": 1,
          "scene_time": "时间点",
          "scene_location": "地点",
          "scene_goal": "本场目标",
          "conflict": "冲突",
          "key_beats": ["关键节点1", "关键节点2"],
          "sendable_prompt": "可供扩写的场景摘要段落",
          "notes": ""
        }
      ]
    }
  ],
  "progress": {
    "current_item_index": 1,
    "reached_ending": false,
    "note": "一句话说明推进到哪、为什么"
  }
}
3) index 必须是这些场景所归属的大纲条目序号（对应输入大纲里的 index），与大纲一一对应，不得新增大纲没有的 index。
4) 本次总共只产出 1~2 个场景（可以都挂在同一个 index 下，或跨相邻两个 index）。
5) 每个 scene 必须包含 scene_goal、conflict、key_beats、sendable_prompt；key_beats 至少 2 条，单条不超过 24 字。
6) sendable_prompt 融合 conflict 与 key_beats，120-220 字，中文，具体可延展，写成可直接发给模型续写的场景摘要，不写"请你/你需要"。
7) progress.current_item_index 填这批场景推进到的大纲条目序号；reached_ending 仅在确实抵达结局时为 true。
8) 输出语言使用中文。`,
            user: `[角色设定]
{{persona}}

[用户设定]
{{userDesc}}

[世界书/设定]
{{worldInfo}}

[故事需求]
{{storyInput}}

[完整故事大纲（路标，最后一条=结局）]
{{outlineItemsJson}}

[已经发生的剧情（最近正文，越靠后越新）]
{{recentChat}}

[已生成的细纲摘要]
{{scenesSoFar}}

[当前进度]
{{progressHint}}

[任务]
只生成"接下来 1~2 个场景"的细纲，承接上面已发生的剧情，朝大纲结局稳步推进，不要一次写到结局。
严格按 version 1.3 结构返回，并在 progress 里回报推进到的大纲条目与是否抵达结局。
只返回 JSON。`
        }
    };
}

function getPromptTemplates() {
    const data = getExtData();
    const defaults = getDefaultPromptTemplates();
    const raw = data?.[PROMPT_TEMPLATES_KEY] || {};
    return {
        outline: {
            system: String(raw?.outline?.system || defaults.outline.system),
            user: String(raw?.outline?.user || defaults.outline.user)
        },
        scenes: {
            system: String(raw?.scenes?.system || defaults.scenes.system),
            user: String(raw?.scenes?.user || defaults.scenes.user)
        },
        rolling: {
            system: String(raw?.rolling?.system || defaults.rolling.system),
            user: String(raw?.rolling?.user || defaults.rolling.user)
        }
    };
}

function savePromptTemplates(templates) {
    const data = getExtData();
    data[PROMPT_TEMPLATES_KEY] = templates;
    saveExtData();
}

function renderPromptTemplate(template, vars) {
    const source = String(template || "");
    return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => String(vars?.[key] ?? ""));
}

function getPromptTemplateSection(templates, type) {
    if (type === "scenes") return templates.scenes;
    if (type === "rolling") return templates.rolling;
    return templates.outline;
}

function getUnknownPromptVars(text) {
    const known = new Set([
        "persona", "userDesc", "openingText", "storyInput", "outlineItemsJson",
        "worldInfo", "scenario", "dialogueExamples",
        // 渐进续写专用变量
        "recentChat", "scenesSoFar", "progressHint"
    ]);
    const unknown = new Set();
    String(text || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
        if (!known.has(key)) unknown.add(key);
        return _;
    });
    return Array.from(unknown);
}

function buildPromptTemplateVars(ctx, userStoryInput, openingText, outlinePayload = [], extras = {}) {
    // worldInfo 里 getContextData 已经加了 "[World Info / Lore]\n" 前缀，去掉它避免和模板里的标签重复。
    const rawWorldInfo = String(ctx?.worldInfo || "").replace(/^\[World Info \/ Lore\]\n/, "").trim();
    return {
        persona: String(ctx?.persona || "(空)"),
        userDesc: String(ctx?.userDesc || "(空)"),
        openingText: String(openingText || "(空)"),
        storyInput: String(userStoryInput || "未填写故事方向，请结合上方设定生成"),
        outlineItemsJson: JSON.stringify(outlinePayload, null, 2),
        worldInfo: rawWorldInfo || "(无)",
        scenario: String(ctx?.scenario || "").trim() || "(无)",
        dialogueExamples: String(ctx?.dialogueExamples || "").trim() || "(无)",
        // 渐进续写专用；非续写场景为 "(无)"，模板里没引用就不影响。
        recentChat: String(extras?.recentChat || "").trim() || "(无)",
        scenesSoFar: String(extras?.scenesSoFar || "").trim() || "(无)",
        progressHint: String(extras?.progressHint || "").trim() || "(无)"
    };
}

function renderGenParamRow(moduleKey, moduleLabel, group) {
    return `
        <div class="t-outline-genparam-row" data-genparam-module="${moduleKey}">
            <div class="t-outline-genparam-title">${escapeHtml(moduleLabel)}</div>
            <div class="t-outline-genparam-fields">
                <label>温度
                    <input type="number" class="t-outline-select" data-genparam-field="temperature" value="${escapeHtml(group.temperature)}" min="0" max="2" step="0.1">
                </label>
                <label>max_tokens
                    <input type="number" class="t-outline-select" data-genparam-field="maxTokens" value="${escapeHtml(group.maxTokens)}" min="256" max="200000" step="256">
                </label>
                <label>超时(秒·0不限)
                    <input type="number" class="t-outline-select" data-genparam-field="timeoutSec" value="${escapeHtml(group.timeoutSec)}" min="0" max="3600" step="10">
                </label>
            </div>
        </div>`;
}

export async function openPromptTemplateManager() {
    ensureCssLoaded();
    $("#t-outline-prompt-manager").remove();

    const defaults = getDefaultPromptTemplates();
    const settingsDraft = {
        selectedProfileId: getOutlineSelectedProfileId(),
        customProfiles: getOutlineCustomProfiles(),
        openingSourceMode: getOpeningSourceMode(),
        openingSourceRef: getOpeningSourceRef(),
        chatTagWhitelist: getOutlineChatTagWhitelistRaw(),
        streamEnabled: loadDraft().streamEnabled === true,
        genParams: getOutlineGenParams(),
        rollingChatFloors: getRollingChatFloors(),
        promptTemplates: JSON.parse(JSON.stringify(getPromptTemplates()))
    };
    const working = settingsDraft.promptTemplates;
    let ctx = { persona: "(空)", userDesc: "(空)" };
    try {
        ctx = await getContextData();
    } catch {
        // ignore
    }

    const outlinePayload = normalizeItems(outlineItems).map((item) => ({
        index: item.index,
        time: item.time || "",
        title: item.title || "",
        plot: item.plot || "",
        foreshadowing: item.foreshadowing || ""
    }));

    const html = `
    <div id="t-outline-prompt-manager" class="t-dialog-overlay t-dialog-overlay--outline t-root">
        <div class="t-dialog-box t-outline-settings-dialog">
            <div class="t-dialog-header">
                <span><i class="fa-solid fa-sliders"></i> 设置</span>
                <div class="t-dialog-close" id="t-prompt-manager-close"><i class="fa-solid fa-times"></i></div>
            </div>

            <div class="t-set-shell-body t-set-body">
                <div class="t-set-shell-nav t-set-nav">
                    <div class="t-set-shell-tab t-set-tab-btn active" data-tab="runtime">⚙️ 运行设置</div>
                    <div class="t-set-shell-tab t-set-tab-btn" data-tab="prompt">📜 提示词模板</div>
                </div>

                <div class="t-set-shell-content t-set-content">
                    <div id="t-outline-page-runtime" class="t-set-page active">
                        ${renderApiConnectionEditorHTML({
                            ids: {
                                profileSelectId: "t-outline-settings-profile-select",
                                profileAddId: "t-outline-settings-new-profile",
                                profileDeleteId: "t-outline-settings-delete-profile",
                                profileNameId: "t-outline-settings-profile-name",
                                profileMetaId: "t-outline-settings-profile-meta",
                                profileTipId: "t-outline-settings-profile-tip",
                                fieldsWrapId: "t-outline-settings-conn-fields",
                                apiUrlId: "t-outline-settings-api-url",
                                apiKeyId: "t-outline-settings-api-key",
                                modelId: "t-outline-settings-model",
                                fetchModelsId: "t-outline-settings-fetch-models",
                                statusId: "t-outline-settings-status",
                                urlHintId: "t-outline-settings-url-hint",
                                stUrlDisplayId: "t-outline-settings-st-url",
                            },
                            classes: {
                                input: "t-outline-select",
                                select: "t-outline-select",
                                profileSelect: "t-outline-select",
                                button: "t-btn t-btn-xs",
                            },
                            labels: {
                                profile: "API 方案",
                                profileName: "方案名称",
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

                        <div class="t-form-group">
                            <label class="t-form-label">请求行为</label>
                            <label class="t-outline-mode t-outline-mode-source" style="margin-left:0;">
                                <input id="t-outline-settings-stream-enabled" type="checkbox">
                                启用流式
                            </label>
                        </div>

                        <div class="t-form-group">
                            <label class="t-form-label">生成参数</label>
                            <div class="t-outline-genparam-hint">分别控制大纲/细纲生成的采样与上限（渐进续写沿用细纲参数）。细纲过长被中途掐断时多为网关超时，建议调低 max_tokens 或用渐进续写分段生成。超时为客户端安全上限（0=不限制）。</div>
                            ${renderGenParamRow("outline", "大纲", settingsDraft.genParams.outline)}
                            ${renderGenParamRow("scenes", "细纲/续写", settingsDraft.genParams.scenes)}
                        </div>

                        <div class="t-form-group">
                            <label class="t-form-label">渐进续写</label>
                            <label class="t-outline-mode t-outline-mode-source" style="margin-left:0;">
                                读取最近正文楼层数
                                <input id="t-outline-settings-rolling-floors" type="number" class="t-outline-select" value="${escapeHtml(settingsDraft.rollingChatFloors)}" min="0" max="50" step="1" style="width:80px;">
                            </label>
                            <div class="t-outline-genparam-hint">渐进续写时读取酒馆最近 N 楼正文作为"已发生的剧情"（走下方聊天提取白名单过滤）。0=不读正文，仅靠大纲与已生成细纲推进。</div>
                        </div>

                        <div class="t-form-group">
                            <label class="t-form-label">参考来源</label>
                            <label class="t-outline-mode t-outline-mode-source" style="margin-left:0; margin-bottom:8px;">
                                来源模式
                                <select id="t-outline-settings-opening-source-mode" class="t-outline-select">
                                    <option value="auto_first">开场白</option>
                                    <option value="chat_selected">聊天记录</option>
                                </select>
                            </label>
                            <button id="t-outline-settings-opening-source-pick" class="t-btn t-btn-xs"><i class="fa-solid fa-list"></i> 选择来源</button>
                        </div>

                        <div class="t-form-group">
                            <label class="t-form-label">聊天提取白名单</label>
                            <input id="t-outline-settings-chat-tag-whitelist" class="t-outline-select" type="text" placeholder="content, dialogue">
                        </div>

                        <div class="t-form-group">
                            <label class="t-form-label">调试与历史</label>
                            <button id="t-outline-settings-view-raw" class="t-btn t-btn-xs"><i class="fa-solid fa-code"></i> 查看生成＆历史响应</button>
                        </div>
                    </div>

                    <div id="t-outline-page-prompt" class="t-set-page">
                        <div class="t-form-group">
                            <label class="t-form-label">目标模块</label>
                            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                                <select id="t-prompt-target" class="t-outline-select">
                                    <option value="outline">故事大纲</option>
                                    <option value="scenes">细纲生成</option>
                                    <option value="rolling">渐进续写</option>
                                </select>
                                <button id="t-prompt-reset-current" class="t-btn t-btn-xs"><i class="fa-solid fa-rotate-left"></i> 恢复当前默认</button>
                            </div>
                            <div class="t-plan-tip" style="margin-top:8px;">通用变量：{{persona}} {{userDesc}} {{worldInfo}} {{scenario}} {{dialogueExamples}} {{openingText}} {{storyInput}} {{outlineItemsJson}}<br>渐进续写额外变量：{{recentChat}} {{scenesSoFar}} {{progressHint}}</div>
                        </div>

                        <div class="t-form-group">
                            <label class="t-form-label">System 模板</label>
                            <textarea id="t-prompt-system" class="t-outline-textarea" rows="9"></textarea>
                        </div>

                        <div class="t-form-group">
                            <label class="t-form-label">User 模板</label>
                            <textarea id="t-prompt-user" class="t-outline-textarea" rows="11"></textarea>
                        </div>

                        <div class="t-form-group">
                            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px;">
                                <button id="t-prompt-preview" class="t-btn t-btn-xs"><i class="fa-solid fa-eye"></i> 预览渲染结果</button>
                                <span id="t-prompt-var-warning" class="t-plan-tip"></span>
                            </div>
                            <div class="t-outline-prompt-preview-grid">
                                <div>
                                    <div class="t-plan-meta">System 预览</div>
                                    <pre id="t-prompt-preview-system" class="t-outline-raw-pre"></pre>
                                </div>
                                <div>
                                    <div class="t-plan-meta">User 预览</div>
                                    <pre id="t-prompt-preview-user" class="t-outline-raw-pre"></pre>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="t-dialog-footer">
                <button id="t-prompt-manager-save-btn" class="t-btn t-btn-primary"><i class="fa-solid fa-floppy-disk"></i> 保存</button>
            </div>
        </div>
    </div>`;

    $("body").append(html);

    const close = () => $("#t-outline-prompt-manager").remove();
    const $settingsRoot = $("#t-outline-prompt-manager");
    const outlineSettingsConnectionEditor = createApiConnectionEditor({
        root: $settingsRoot,
        ids: {
            profileSelectId: "t-outline-settings-profile-select",
            profileAddId: "t-outline-settings-new-profile",
            profileDeleteId: "t-outline-settings-delete-profile",
            profileNameId: "t-outline-settings-profile-name",
            profileTipId: "t-outline-settings-profile-tip",
            apiUrlId: "t-outline-settings-api-url",
            apiKeyId: "t-outline-settings-api-key",
            modelId: "t-outline-settings-model",
            fetchModelsId: "t-outline-settings-fetch-models",
            statusId: "t-outline-settings-status",
            urlHintId: "t-outline-settings-url-hint",
            stUrlDisplayId: "t-outline-settings-st-url",
        },
        profiles: buildOutlineEditorProfiles(settingsDraft.customProfiles),
        activeProfileId: settingsDraft.selectedProfileId,
        profileIdPrefix: "outline_custom",
        autoFetchOnInput: false,
        autoFetchOnProfileSwitch: false,
        getInternalUrl: getOutlineInternalUrlLabel,
        onChange: (nextState) => {
            // internal（跟随主连接）方案不写进独立的自定义方案存储，只保留 selectedProfileId 记住选择。
            settingsDraft.customProfiles = mapConnectionProfilesToCustomProfiles(nextState.profiles, "gpt-3.5-turbo");
            settingsDraft.selectedProfileId = nextState.activeProfileId;
        },
    });
    outlineSettingsConnectionEditor.bind();
    outlineSettingsConnectionEditor.render();
    const refreshOpeningSourceControlsDraft = () => {
        const mode = settingsDraft.openingSourceMode === "chat_selected" ? "chat_selected" : "auto_first";
        const whitelist = settingsDraft.chatTagWhitelist || "";
        $("#t-outline-settings-opening-source-mode").val(mode);
        $("#t-outline-settings-opening-source-pick").prop("disabled", false);
        $("#t-outline-settings-chat-tag-whitelist").val(whitelist);
    };
    const switchTab = (tab) => {
        const next = tab === "prompt" ? "prompt" : "runtime";
        const $root = $("#t-outline-prompt-manager");
        $root.find(".t-set-tab-btn").removeClass("active");
        $root.find(`.t-set-tab-btn[data-tab='${next}']`).addClass("active");
        $root.find(".t-set-page").removeClass("active");
        $root.find(`#t-outline-page-${next}`).addClass("active");
    };
    const syncToEditor = () => {
        const type = String($("#t-prompt-target").val() || "outline");
        const section = getPromptTemplateSection(working, type);
        $("#t-prompt-system").val(section.system || "");
        $("#t-prompt-user").val(section.user || "");
        $("#t-prompt-var-warning").text("");
    };
    const syncFromEditor = () => {
        const type = String($("#t-prompt-target").val() || "outline");
        const section = getPromptTemplateSection(working, type);
        section.system = String($("#t-prompt-system").val() || "");
        section.user = String($("#t-prompt-user").val() || "");
    };
    const preview = () => {
        syncFromEditor();
        const type = String($("#t-prompt-target").val() || "outline");
        const section = getPromptTemplateSection(working, type);
        const currentStoryInput = String($("#t-outline-story-input").val() || "").trim();
        const openingMode = settingsDraft.openingSourceMode;
        const openingSourceRef = settingsDraft.openingSourceRef;
        const opening = getOpeningTextForPreview(openingMode, openingSourceRef);
        const varsLocal = buildPromptTemplateVars(ctx, currentStoryInput, opening, outlinePayload);
        const renderedSys = renderPromptTemplate(section.system, varsLocal);
        const renderedUser = renderPromptTemplate(section.user, varsLocal);
        $("#t-prompt-preview-system").text(renderedSys);
        $("#t-prompt-preview-user").text(renderedUser);

        const unknown = [...getUnknownPromptVars(section.system), ...getUnknownPromptVars(section.user)];
        const unique = Array.from(new Set(unknown));
        $("#t-prompt-var-warning").text(unique.length > 0 ? `未知变量：${unique.join(", ")}` : "");
    };

    const syncRuntimeSettings = () => {
        outlineSettingsConnectionEditor.render();
        refreshOpeningSourceControlsDraft();
        $("#t-outline-settings-stream-enabled").prop("checked", settingsDraft.streamEnabled === true);
    };

    switchTab("runtime");
    syncRuntimeSettings();
    syncToEditor();
    preview();

    $("#t-outline-prompt-manager .t-set-tab-btn").on("click", function () {
        switchTab(String($(this).data("tab") || "runtime"));
    });

    // 生成参数：输入即写入 draft（保存时再落盘 + 规范化）。
    $("#t-outline-prompt-manager").on("input", "[data-genparam-field]", function () {
        const $input = $(this);
        const moduleKey = String($input.closest("[data-genparam-module]").data("genparam-module") || "").trim();
        const field = String($input.data("genparam-field") || "").trim();
        if (!settingsDraft.genParams[moduleKey] || !field) return;
        settingsDraft.genParams[moduleKey][field] = Number($input.val());
    });

    $("#t-outline-settings-rolling-floors").on("input change", function () {
        settingsDraft.rollingChatFloors = Number($(this).val());
    });

    $("#t-prompt-target").on("change", () => {
        syncToEditor();
        preview();
    });
    $("#t-prompt-system, #t-prompt-user").on("input", () => {
        syncFromEditor();
    });
    $("#t-prompt-preview").on("click", preview);
    $("#t-prompt-reset-current").on("click", () => {
        const type = String($("#t-prompt-target").val() || "outline");
        working[type] = JSON.parse(JSON.stringify(defaults[type]));
        syncToEditor();
        preview();
        if (window.toastr) toastr.success("已恢复当前模板默认值", "故事大纲设置");
    });
    $("#t-outline-settings-opening-source-mode").on("change", function () {
        const mode = String($(this).val() || "auto_first") === "chat_selected" ? "chat_selected" : "auto_first";
        settingsDraft.openingSourceMode = mode;
        refreshOpeningSourceControlsDraft();
        preview();
    });

    $("#t-outline-settings-opening-source-pick").on("click", async () => {
        const mode = settingsDraft.openingSourceMode;
        const sourceRef = settingsDraft.openingSourceRef;
        const picked = mode === "chat_selected"
            ? await openOpeningSourcePickerDialog(sourceRef?.chatIndex ?? -1)
            : await openCardOpeningPickerDialog(sourceRef?.openingIndex ?? 0);
        if (!picked) return;
        settingsDraft.openingSourceRef = picked;
        refreshOpeningSourceControlsDraft();
        preview();
        if (window.toastr) toastr.success("已设置参考来源", "故事大纲");
    });

    $("#t-outline-settings-chat-tag-whitelist").on("input change", function () {
        settingsDraft.chatTagWhitelist = String($(this).val() || "").trim();
    });

    $("#t-outline-settings-stream-enabled").on("change", function () {
        settingsDraft.streamEnabled = $(this).is(":checked");
    });

    $("#t-outline-settings-view-raw").on("click", () => {
        showRawResponseDialog(lastRawResponse);
    });

    $("#t-prompt-manager-close").on("click", close);
    $("#t-prompt-manager-save-btn").on("click", () => {
        syncFromEditor();
        outlineSettingsConnectionEditor.persistCurrentProfileInputs();
        const nextState = outlineSettingsConnectionEditor.getState();
        settingsDraft.customProfiles = mapConnectionProfilesToCustomProfiles(nextState.profiles, "gpt-3.5-turbo");
        settingsDraft.selectedProfileId = nextState.activeProfileId;
        saveOutlineSelectedProfileId(settingsDraft.selectedProfileId);
        saveOutlineCustomProfiles(settingsDraft.customProfiles);
        setOpeningSourceMode(settingsDraft.openingSourceMode);
        setOpeningSourceRef(settingsDraft.openingSourceRef);
        setOutlineChatTagWhitelistRaw(settingsDraft.chatTagWhitelist);
        saveOutlineGenParams(settingsDraft.genParams);
        saveRollingChatFloors(settingsDraft.rollingChatFloors);
        savePromptTemplates(settingsDraft.promptTemplates);
        $("#t-outline-stream-enabled").prop("checked", settingsDraft.streamEnabled === true);
        saveDraftStreamEnabledOnly(settingsDraft.streamEnabled === true);
        refreshOutlineOpeningSourceControls();
        if (window.toastr) toastr.success("故事大纲设置已保存", "故事大纲设置");
        close();
    });
}

function refreshOutlineOpeningSourceControls() {
    const mode = getOpeningSourceMode();
    const whitelist = getOutlineChatTagWhitelistRaw();
    $("#t-outline-opening-source-mode, #t-outline-settings-opening-source-mode").val(mode);
    $("#t-outline-opening-source-pick, #t-outline-settings-opening-source-pick").prop("disabled", false);
    $("#t-outline-chat-tag-whitelist, #t-outline-settings-chat-tag-whitelist").val(whitelist);
}

function buildPrompt(ctx, userStoryInput, openingText) {
    const templates = getPromptTemplates();
    const vars = buildPromptTemplateVars(ctx, userStoryInput, openingText);
    const sys = renderPromptTemplate(templates.outline.system, vars);
    const user = renderPromptTemplate(templates.outline.user, vars);

    return [
        { role: "system", content: sys },
        { role: "user", content: user }
    ];
}

// 大纲与细纲返回的 JSON 结构解析逻辑相同（都要求顶层 data.items 为数组）：
// 三段尝试（原文 → ```代码块 → 第一个 {...}）+ 尾逗号修复。仅错误文案不同。
function parseJsonItemsResponse(raw, failMessage = "返回格式无法解析为 JSON") {
    if (!raw || typeof raw !== "string") {
        throw new Error("模型返回为空");
    }

    const attempts = [raw.trim()];

    const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (codeBlockMatch?.[1]) attempts.push(codeBlockMatch[1].trim());

    const objMatch = raw.match(/\{[\s\S]*\}/);
    if (objMatch?.[0]) attempts.push(objMatch[0].trim());

    for (const content of attempts) {
        try {
            const fixed = content.replace(/,\s*([}\]])/g, "$1");
            const data = JSON.parse(fixed);
            if (data && Array.isArray(data.items)) return data;
        } catch {
            // try next
        }
    }

    throw new Error(failMessage);
}

function parseOutlineResponse(raw) {
    return parseJsonItemsResponse(raw, "返回格式无法解析为 JSON");
}

function getDraft() {
    const data = getExtData();
    return data[DRAFT_KEY] || null;
}

function saveDraft(storyInput, insertMode) {
    const data = getExtData();
    data[DRAFT_KEY] = {
        storyInput: storyInput || "",
        insertMode: insertMode || "overwrite",
        streamEnabled: isStreamingEnabled(),
        items: outlineItems,
        updatedAt: Date.now()
    };
    saveExtData();
    scheduleAutoSaveCurrentPlan();
}

function saveDraftStreamEnabledOnly(streamEnabled) {
    const data = getExtData();
    const prev = data[DRAFT_KEY] && typeof data[DRAFT_KEY] === "object" ? data[DRAFT_KEY] : {};
    data[DRAFT_KEY] = {
        storyInput: typeof prev.storyInput === "string" ? prev.storyInput : "",
        insertMode: prev.insertMode === "append" ? "append" : "overwrite",
        streamEnabled: streamEnabled === true,
        items: normalizeItems(prev.items),
        updatedAt: Date.now()
    };
    saveExtData();
}

function loadDraft() {
    const draft = getDraft();
    if (!draft) {
        return { storyInput: "", insertMode: "overwrite", items: [] };
    }

    return {
        storyInput: typeof draft.storyInput === "string" ? draft.storyInput : "",
        insertMode: draft.insertMode === "append" ? "append" : "overwrite",
        streamEnabled: draft.streamEnabled === true,
        items: normalizeItems(draft.items)
    };
}

function isStreamingEnabled() {
    const $main = $("#t-outline-stream-enabled");
    if ($main.length > 0) return $main.is(":checked");

    const $settings = $("#t-outline-settings-stream-enabled");
    if ($settings.length > 0) return $settings.is(":checked");

    const draft = getDraft();
    return draft?.streamEnabled === true;
}

function getPlans() {
    const data = getExtData();
    if (!Array.isArray(data[PLANS_KEY])) data[PLANS_KEY] = [];
    return data[PLANS_KEY];
}

function getActivePlanId() {
    const data = getExtData();
    return typeof data[ACTIVE_PLAN_KEY] === "string" ? data[ACTIVE_PLAN_KEY] : "";
}

function getSceneSourcePlanId() {
    const data = getExtData();
    return typeof data[SCENE_SOURCE_PLAN_KEY] === "string" ? data[SCENE_SOURCE_PLAN_KEY] : "";
}

function setSceneSourcePlanId(planId) {
    const data = getExtData();
    data[SCENE_SOURCE_PLAN_KEY] = planId || "";
    saveExtData();
}

function setActivePlanId(planId) {
    const data = getExtData();
    data[ACTIVE_PLAN_KEY] = planId || "";
    saveExtData();
}

function getCurrentCharCardName() {
    try {
        if (typeof SillyTavern === "undefined" || !SillyTavern.getContext) return "角色卡";
        const stCtx = SillyTavern.getContext();
        const charObj = stCtx?.characters?.[stCtx?.characterId] || null;
        const rawName = charObj?.name || stCtx?.name2 || "角色卡";
        const safeName = String(rawName).trim().replace(/[\\/:*?"<>|]/g, "_");
        return safeName || "角色卡";
    } catch {
        return "角色卡";
    }
}

function createPlanName(baseName = "") {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const prefix = (baseName || getCurrentCharCardName() || "角色卡").trim();
    return `${prefix}-${datePart}`;
}

function getPlanInstruction(plan) {
    if (!plan) return "";
    const raw = typeof plan.instruction === "string"
        ? plan.instruction
        : (typeof plan.storyInput === "string" ? plan.storyInput : "");
    return String(raw).trim();
}

function createPlanPayloadFromEditor() {
    const currentInstruction = String($("#t-outline-story-input").val() || "").trim();
    return {
        storyInput: currentInstruction,
        instruction: currentInstruction,
        items: normalizeItems(outlineItems)
    };
}

function buildPlanBaseline(payload) {
    const safePayload = payload || {};
    return JSON.stringify({
        storyInput: String(safePayload.storyInput || ""),
        instruction: String(safePayload.instruction || ""),
        items: normalizeItems(safePayload.items || [])
    });
}

function setEditingPlan(plan) {
    if (!plan || !plan.id) {
        editingPlanId = "";
        editingPlanBaseline = "";
        return;
    }
    editingPlanId = String(plan.id);
    editingPlanBaseline = buildPlanBaseline({
        storyInput: String(plan.storyInput || ""),
        instruction: getPlanInstruction(plan),
        items: plan.items || []
    });
}

function hasEditingPlanChanges() {
    if (!editingPlanId) return false;
    if (!editingPlanBaseline) return true;
    const current = buildPlanBaseline(createPlanPayloadFromEditor());
    return current !== editingPlanBaseline;
}

function createDistinctPlanName(baseName = "") {
    const plans = getPlans();
    const source = String(baseName || "").trim() || createPlanName(getCurrentCharCardName());
    let suffix = 1;
    let candidate = `${source}（副本）`;
    while (plans.some(p => String(p?.name || "").trim() === candidate)) {
        suffix += 1;
        candidate = `${source}（副本${suffix}）`;
    }
    return candidate;
}

// 三种"新建方案"（沿用编辑器内容 / 空白 / 从来源分支）共用的落盘骨架：
// 构造 plan → unshift → 设为 active，首个方案兼作细纲来源 → 存 → 标记为编辑态。
function insertPlan({ name, storyInput, instruction, items }) {
    const plans = getPlans();
    const now = Date.now();
    const plan = {
        id: `plan_${now}_${Math.random().toString(36).slice(2, 8)}`,
        name: String(name || "").trim() || createPlanName(getCurrentCharCardName()),
        storyInput: storyInput || "",
        instruction: instruction || "",
        items: Array.isArray(items) ? items : [],
        used_scene_keys: [],
        createdAt: now,
        updatedAt: now
    };
    plans.unshift(plan);
    activePlanId = plan.id;
    setActivePlanId(plan.id);
    if (!getSceneSourcePlanId()) {
        setSceneSourcePlanId(plan.id);
    }
    saveExtData();
    setEditingPlan(plan);
    return plan;
}

// 保存当前编辑器内容（含已生成的大纲条目）为新方案。
function createNewPlan(nameInput = "", defaultName = "") {
    const payload = createPlanPayloadFromEditor();
    return insertPlan({
        name: (nameInput || "").trim() || defaultName,
        storyInput: payload.storyInput,
        instruction: payload.instruction,
        items: payload.items
    });
}

// 新建空白方案，仅带上输入框里的故事指令。
function createEmptyPlan(nameInput = "", defaultName = "") {
    const instruction = String($("#t-outline-story-input").val() || "").trim();
    return insertPlan({
        name: (nameInput || "").trim() || defaultName,
        storyInput: instruction,
        instruction,
        items: []
    });
}

// 从来源方案分支出一个空白方案，沿用其故事指令，名字追加"（分支）"并去重。
function createBranchPlanFromSource(sourcePlan) {
    if (!sourcePlan?.id) return null;
    const plans = getPlans();
    const baseName = String(sourcePlan.name || createPlanName(getCurrentCharCardName())).trim() || "未命名方案";
    let candidateName = `${baseName}（分支）`;
    let suffix = 2;
    while (plans.some(p => String(p?.name || "").trim() === candidateName)) {
        candidateName = `${baseName}（分支${suffix}）`;
        suffix += 1;
    }

    const instruction = getPlanInstruction(sourcePlan);
    return insertPlan({
        name: candidateName,
        storyInput: instruction,
        instruction,
        items: []
    });
}

function persistCurrentEditingPlan() {
    if (!editingPlanId) return;
    const plans = getPlans();
    const target = plans.find(p => p.id === editingPlanId);
    if (!target) return;
    const payload = createPlanPayloadFromEditor();
    target.storyInput = payload.storyInput;
    target.instruction = payload.instruction;
    target.items = payload.items;
    target.updatedAt = Date.now();
    saveExtData();
    setEditingPlan(target);
}

function scheduleAutoSaveCurrentPlan() {
    if (!editingPlanId) return;
    if (autoSavePlanTimer) clearTimeout(autoSavePlanTimer);
    autoSavePlanTimer = setTimeout(() => {
        autoSavePlanTimer = null;
        persistCurrentEditingPlan();
    }, 260);
}

function flushAutoSaveCurrentPlan() {
    if (autoSavePlanTimer) {
        clearTimeout(autoSavePlanTimer);
        autoSavePlanTimer = null;
    }
    persistCurrentEditingPlan();
}

function ensureEditingPlanContext() {
    if (editingPlanId) return true;
    const active = getActivePlan();
    if (active) {
        loadPlanToEditor(active);
        return true;
    }
    if (window.toastr) toastr.warning("请先新建或选择一个方案", "故事大纲");
    return false;
}

function updatePlanWorkflowUI() {
    const hasPlans = getPlans().length > 0;
    const inEditor = currentView === "editor";
    $("#t-outline-plan-name-wrap").toggle(hasPlans && inEditor);
    $("#t-outline-save-plan").toggle(hasPlans && inEditor);
    $("#t-outline-top").toggle(inEditor);
    $("#t-outline-hub-view").toggle(currentView === "hub");
    refreshPlanNameDisplay();
    refreshRollingProgressUI();
}

function updatePlanHubActionState() {
    const plans = getPlans();
    const selected = plans.find(p => p.id === activePlanId) || null;
    const hasSelected = !!selected;
    $("#t-hub-edit-plan, #t-hub-create-branch, #t-hub-view-detail, #t-hub-view-instruction").prop("disabled", !hasSelected);
}

function openPlanCreationDialog() {
    ensureCssLoaded();
    $("#t-outline-create-plan-dialog").remove();
    const defaultPlanName = createPlanName(getCurrentCharCardName());
    const draftStoryInput = String($("#t-outline-story-input").val() || "").trim();

    const html = `
    <div id="t-outline-create-plan-dialog" class="t-dialog-overlay t-dialog-overlay--outline t-root">
        <div class="t-dialog-box">
            <div class="t-dialog-header">
                <span><i class="fa-solid fa-folder-plus"></i> 新建方案</span>
                <div class="t-dialog-close" id="t-create-plan-close"><i class="fa-solid fa-times"></i></div>
            </div>
            <div class="t-dialog-body t-dialog-body--tight">
                <div class="t-plan-tip" style="font-size:13px; margin-bottom:10px;">创建后会直接进入「大纲生成」编辑页。</div>
                <label class="t-outline-label">方案名称</label>
                <input id="t-create-plan-name" class="t-outline-input" value="${escapeHtml(defaultPlanName)}" />
                <label class="t-outline-label" style="margin-top:10px;">初始故事指令（可选）</label>
                <textarea id="t-create-plan-story" class="t-outline-story-input" rows="4" placeholder="可先写一个方向，后续仍可随时修改">${escapeHtml(draftStoryInput)}</textarea>
                <div class="t-plan-tip" style="margin-top:8px;">提示：如果留空，会创建一个空白方案。</div>
                <div style="margin-top:12px; display:flex; justify-content:flex-end; gap:8px;">
                    <button id="t-create-plan-cancel" class="t-btn">取消</button>
                    <button id="t-create-plan-confirm" class="t-btn t-btn-primary"><i class="fa-solid fa-check"></i> 创建并进入编辑</button>
                </div>
            </div>
        </div>
    </div>`;

    $("body").append(html);

    const close = () => $("#t-outline-create-plan-dialog").remove();
    $("#t-create-plan-close, #t-create-plan-cancel").on("click", close);
    $("#t-create-plan-confirm").on("click", () => {
        const planName = String($("#t-create-plan-name").val() || "").trim();
        const planStory = String($("#t-create-plan-story").val() || "").trim();
        $("#t-outline-story-input").val(planStory);
        const created = createEmptyPlan(planName);
        close();
        if (window.toastr) toastr.success(`已新建方案：${created.name}`, "故事大纲");
        loadPlanToEditor(created);
        renderPlanHub();
        showOutlineView("editor");
        setEditorSubView("outline");
        updatePlanWorkflowUI();
    });
}

function overwritePlan(planId, nameInput = "") {
    const plans = getPlans();
    const target = plans.find(p => p.id === planId);
    if (!target) return null;

    const payload = createPlanPayloadFromEditor();
    target.name = (nameInput || "").trim() || target.name || createPlanName(getCurrentCharCardName());
    target.storyInput = payload.storyInput;
    target.instruction = payload.instruction;
    target.items = payload.items;
    target.updatedAt = Date.now();
    activePlanId = target.id;
    setActivePlanId(target.id);
    saveExtData();
    setEditingPlan(target);
    return target;
}

function upsertCurrentAsPlan(nameInput = "") {
    const planNameInput = String(nameInput || "").trim();
    const plans = getPlans();
    const editingTarget = editingPlanId
        ? plans.find(p => p.id === editingPlanId)
        : null;

    if (!editingTarget) {
        return createNewPlan(planNameInput);
    }

    const hasChanges = hasEditingPlanChanges();
    if (!hasChanges) {
        const overwritten = overwritePlan(editingTarget.id, planNameInput);
        return overwritten || createNewPlan(planNameInput);
    }

    const shouldOverwrite = window.confirm(`当前正在编辑方案「${editingTarget.name || "未命名方案"}」。\n确定：覆盖当前方案\n取消：另存为新方案`);
    if (shouldOverwrite) {
        const overwritten = overwritePlan(editingTarget.id, planNameInput);
        return overwritten || createNewPlan(planNameInput);
    }

    const fallbackCopyName = createDistinctPlanName(editingTarget.name || createPlanName(getCurrentCharCardName()));
    return createNewPlan(planNameInput, fallbackCopyName);
}

function getActivePlan() {
    const plans = getPlans();
    if (!activePlanId) {
        activePlanId = getActivePlanId();
    }
    return plans.find(p => p.id === activePlanId) || plans[0] || null;
}

function getCurrentPlanForEditor() {
    const plans = getPlans();
    if (editingPlanId) {
        const editing = plans.find(p => p.id === editingPlanId);
        if (editing) return editing;
    }
    if (activePlanId) {
        const active = plans.find(p => p.id === activePlanId);
        if (active) return active;
    }
    return plans[0] || null;
}

function refreshPlanNameDisplay() {
    const $wrap = $("#t-outline-plan-name-wrap");
    const $input = $("#t-outline-plan-name");
    const $rename = $("#t-outline-plan-rename-trigger");
    const $ok = $("#t-outline-plan-rename-confirm");
    const $cancel = $("#t-outline-plan-rename-cancel");
    if ($input.length === 0) return;

    const plan = getCurrentPlanForEditor();
    const hasPlan = !!plan;

    $wrap.toggle(hasPlan);
    $rename.prop("disabled", !hasPlan).toggle(!planRenameMode);
    $ok.toggle(planRenameMode);
    $cancel.toggle(planRenameMode);
    $input.prop("readonly", !planRenameMode);
    $input.toggleClass("is-readonly", !planRenameMode);

    if (!planRenameMode) {
        $input.val(hasPlan ? (plan.name || "未命名方案") : "");
    }
}

function setPlanRenameMode(enabled) {
    const on = !!enabled;
    if (on) {
        const plan = getCurrentPlanForEditor();
        if (!plan) return;
        planRenameSnapshot = String(plan.name || "");
    }
    planRenameMode = on;
    refreshPlanNameDisplay();
    if (on) {
        const input = document.querySelector("#t-outline-plan-name");
        if (input) {
            input.focus();
            if (typeof input.select === "function") input.select();
        }
    }
}

function confirmPlanRename() {
    const plan = getCurrentPlanForEditor();
    if (!plan) return;
    const nextName = String($("#t-outline-plan-name").val() || "").trim() || createPlanName(getCurrentCharCardName());
    plan.name = nextName;
    plan.updatedAt = Date.now();
    saveExtData();
    setPlanRenameMode(false);
    renderPlanHub();
    if (window.toastr) toastr.success(`已重命名方案：${nextName}`, "故事大纲");
}

function cancelPlanRename() {
    $("#t-outline-plan-name").val(planRenameSnapshot || "");
    setPlanRenameMode(false);
}

function getCurrentInsertMode() {
    return $("#t-scene-hub-insert-mode").val() || $("#t-outline-insert-mode").val() || loadDraft().insertMode || "overwrite";
}

function getSceneUsageKey(itemIndex, sceneIndex) {
    return `${itemIndex}:${sceneIndex}`;
}

// 渐进续写的进度指针（持久化在 plan 上）。itemIndex 指向当前推进到的大纲条目（0-based），
// reachedEnding 标记是否已抵达结局。缺失时归零。
function getPlanProgress(plan) {
    const raw = plan && typeof plan.progress === "object" ? plan.progress : null;
    const totalItems = Array.isArray(plan?.items) ? plan.items.length : 0;
    let itemIndex = Number(raw?.itemIndex);
    if (!Number.isFinite(itemIndex) || itemIndex < 0) itemIndex = 0;
    if (totalItems > 0) itemIndex = Math.min(itemIndex, totalItems - 1);
    return { itemIndex, reachedEnding: raw?.reachedEnding === true };
}

function setPlanProgress(planId, progress) {
    const plans = getPlans();
    const plan = plans.find(p => p.id === planId);
    if (!plan) return;
    const totalItems = Array.isArray(plan.items) ? plan.items.length : 0;
    let itemIndex = Number(progress?.itemIndex);
    if (!Number.isFinite(itemIndex) || itemIndex < 0) itemIndex = 0;
    if (totalItems > 0) itemIndex = Math.min(itemIndex, totalItems - 1);
    plan.progress = { itemIndex, reachedEnding: progress?.reachedEnding === true };
    plan.updatedAt = Date.now();
    saveExtData();
}

function isSceneUsed(plan, itemIndex, sceneIndex) {
    if (!plan || !Array.isArray(plan.used_scene_keys)) return false;
    return plan.used_scene_keys.includes(getSceneUsageKey(itemIndex, sceneIndex));
}

// 发送某场景即推进进度：指针只前进不后退；发送到最后一条大纲时标记已抵达结局。
// 优先对当前正在编辑的方案生效；细纲窗口独立打开（无编辑态）时，对细纲来源方案生效，
// 保证渐进续写面板跟着「发送场景」动。
function advanceProgressOnSend(planId, itemIndex) {
    if (!planId) return;
    if (planId !== editingPlanId && planId !== getSceneSourcePlanId()) return;
    const plan = getPlans().find(p => p.id === planId);
    if (!plan) return;
    const total = Array.isArray(plan.items) ? plan.items.length : 0;
    if (total <= 0) return;
    const prev = getPlanProgress(plan);
    const nextIdx = Math.max(prev.itemIndex, Math.min(Number(itemIndex) || 0, total - 1));
    const reachedEnding = prev.reachedEnding || nextIdx >= total - 1;
    setPlanProgress(planId, { itemIndex: nextIdx, reachedEnding });
    if (editingPlanId === planId) setEditingPlan(getPlans().find(p => p.id === planId));
    refreshRollingProgressUI();
}

function markSceneUsed(planId, itemIndex, sceneIndex) {
    const plans = getPlans();
    const plan = plans.find(p => p.id === planId);
    if (!plan) return;
    if (!Array.isArray(plan.used_scene_keys)) plan.used_scene_keys = [];
    const key = getSceneUsageKey(itemIndex, sceneIndex);
    if (!plan.used_scene_keys.includes(key)) {
        plan.used_scene_keys.push(key);
        plan.updatedAt = Date.now();
        saveExtData();
    }
}

function showOutlineView(view) {
    currentView = view === "editor" ? "editor" : "hub";
    $("#t-outline-hub-view").toggle(currentView === "hub");
    $("#t-outline-editor-view").toggle(currentView === "editor");
    const isMobile = window.matchMedia("(max-width: 768px)").matches;
    $("#t-story-outline-overlay").toggleClass("t-outline-mobile-hub-compact", isMobile && currentView === "hub");
    if (currentView === "hub") {
        closeMobileEditor();
    }
    syncAddFabVisibility();
}

function loadPlanToEditor(plan) {
    if (!plan) return false;
    outlineItems = normalizeItems(plan.items || []);
    sceneExpandedMap = {};
    selectedRowIndex = -1;
    sceneEditorItemIndex = outlineItems.length > 0 ? 0 : -1;
    closeDesktopEditor();
    closeMobileEditor();
    const planInstruction = getPlanInstruction(plan);
    $("#t-outline-story-input").val(planInstruction);
    setEditingPlan(plan);
    planRenameMode = false;
    saveDraft(planInstruction, $("#t-outline-insert-mode").val() || "overwrite");
    renderRows();
    refreshPlanNameDisplay();
    refreshRollingProgressUI();
    return true;
}

function getPlanItemCursor(planId, totalItems) {
    const total = Number(totalItems) || 0;
    if (!planId || total <= 0) return 0;
    const raw = Number(planItemCursorMap[planId]);
    if (Number.isNaN(raw)) return 0;
    return Math.min(Math.max(raw, 0), total - 1);
}

function setPlanItemCursor(planId, index, totalItems) {
    if (!planId) return;
    const total = Number(totalItems) || 0;
    if (total <= 0) {
        planItemCursorMap[planId] = 0;
        return;
    }
    const next = Math.min(Math.max(Number(index) || 0, 0), total - 1);
    planItemCursorMap[planId] = next;
}

function movePlanItemCursor(planId, delta, totalItems) {
    const total = Number(totalItems) || 0;
    if (!planId || total <= 0) return;
    const current = getPlanItemCursor(planId, total);
    setPlanItemCursor(planId, current + (Number(delta) || 0), total);
}

function collectAllPlanScenes() {
    const plans = getPlans();
    const sourcePlanId = getSceneSourcePlanId();
    const sourcePlan = plans.find(p => p.id === sourcePlanId) || null;
    const rows = [];
    if (!sourcePlan) return rows;

    [sourcePlan].forEach((plan) => {
        const items = normalizeItems(plan?.items || []);
        items.forEach((item, itemIndex) => {
            const scenes = Array.isArray(item.scenes) ? item.scenes : [];
            scenes.forEach((scene, sceneIndex) => {
                rows.push({
                    key: `${plan.id}:${itemIndex}:${sceneIndex}`,
                    planId: plan.id,
                    planName: plan.name || "未命名方案",
                    itemIndex,
                    sceneIndex,
                    itemTitle: item.title || `条目${item.index}`,
                    itemTime: item.time || "",
                    scene,
                    used: isSceneUsed(plan, itemIndex, sceneIndex)
                });
            });
        });
    });

    rows.sort((a, b) => {
        if (a.used !== b.used) return a.used ? 1 : -1;
        if (a.planName !== b.planName) return String(a.planName).localeCompare(String(b.planName), "zh-CN");
        if (a.itemIndex !== b.itemIndex) return a.itemIndex - b.itemIndex;
        return a.sceneIndex - b.sceneIndex;
    });

    return rows.map((row, idx) => ({ ...row, number: idx + 1 }));
}

function renderSceneHubWindow() {
    const rows = collectAllPlanScenes();
    const $list = $("#t-scene-hub-list");
    const $sendBtn = $("#t-scene-hub-send");
    if ($list.length === 0 || $sendBtn.length === 0) return;

    if (rows.length === 0) {
        sceneHubSelectedKey = "";
        const sourcePlanId = getSceneSourcePlanId();
        if (!sourcePlanId) {
            $list.html('<div class="t-plan-empty">请先在方案页选择一个用于细纲情节的方案</div>');
        } else {
            $list.html('<div class="t-plan-empty">当前选中方案暂无可用细纲场景，请先生成细纲</div>');
        }
        $sendBtn.prop("disabled", true);
        return;
    }

    if (!rows.some(r => r.key === sceneHubSelectedKey)) {
        sceneHubSelectedKey = "";
    }

    const html = rows.map((row) => `
        <div class="t-scene-hub-item ${row.used ? "used" : ""} ${sceneHubSelectedKey === row.key ? "active" : ""}" data-scene-key="${row.key}">
            <div class="t-scene-hub-head">
                <span class="t-scene-hub-no">#${row.number}</span>
                <span class="t-scene-hub-plan">${escapeHtml(row.planName)} / ${escapeHtml(row.itemTitle)}</span>
                ${row.used ? '<span class="t-plan-used-tag">已使用</span>' : ""}
            </div>
            <div class="t-scene-hub-meta">${escapeHtml(row.scene.scene_time || "未设时间")} · ${escapeHtml(row.scene.scene_location || "未设地点")}</div>
            <div class="t-scene-hub-text">${escapeHtml(row.scene.sendable_prompt || row.scene.key_beats || "(空)")}</div>
        </div>
    `).join("");

    $list.html(html);
    $sendBtn.prop("disabled", !sceneHubSelectedKey);
}

export function openSceneHubWindow() {
    ensureCssLoaded();
    $("#t-scene-hub-overlay").remove();
    sceneHubSelectedKey = "";

    const html = `
    <div id="t-scene-hub-overlay" class="t-overlay t-root">
        <div class="t-window t-story-outline-window">
            <div class="t-window-header">
                <div class="t-window-title"><i class="fa-solid fa-clapperboard"></i> 细纲情节</div>
                <div class="t-window-controls">
                    <div class="t-window-close" id="t-scene-hub-close"><i class="fa-solid fa-times"></i></div>
                </div>
            </div>
            <div class="t-window-body t-outline-body">
                <div id="t-scene-hub-list" class="t-scene-hub-list"></div>
                <div id="t-outline-rolling" class="t-outline-rolling t-outline-rolling--scene-hub" style="display:none;">
                    <div class="t-outline-rolling-head">
                        <span class="t-outline-rolling-title"><i class="fa-solid fa-forward-step"></i> 渐进续写</span>
                        <div class="t-outline-rolling-head-right">
                            <span id="t-outline-rolling-status" class="t-outline-rolling-status"></span>
                            <button id="t-outline-rolling-outline-toggle" class="t-btn t-btn-xs" title="展开/收起大纲情节预览"><i class="fa-solid fa-map"></i></button>
                        </div>
                    </div>
                    <div class="t-outline-rolling-bar"><div id="t-outline-rolling-bar-fill" class="t-outline-rolling-bar-fill"></div></div>
                    <div id="t-outline-rolling-outline-preview" class="t-outline-rolling-outline-preview" style="display:none;"></div>
                    <div class="t-outline-rolling-controls">
                        <button id="t-outline-generate-next" class="t-btn t-btn-primary t-btn-xs"><i class="fa-solid fa-forward-step"></i> 生成下一段</button>
                        <label class="t-outline-rolling-cursor">推进到
                            <select id="t-outline-rolling-cursor-select" class="t-outline-select"></select>
                        </label>
                        <button id="t-outline-rolling-reset" class="t-btn t-btn-xs" title="回到开头重新推进"><i class="fa-solid fa-rotate-left"></i></button>
                    </div>
                    <div class="t-outline-rolling-hint">大纲当路标，结合最近正文一步步写到结局。发送场景会自动推进，也可手动指定当前进度。</div>
                </div>
                <div class="t-scene-hub-footer">
                    <label class="t-outline-mode" style="margin-right:auto;">
                        写入方式
                        <select id="t-scene-hub-insert-mode" class="t-outline-select">
                            <option value="overwrite" ${getCurrentInsertMode() === "overwrite" ? "selected" : ""}>覆盖输入框</option>
                            <option value="append" ${getCurrentInsertMode() === "append" ? "selected" : ""}>追加到输入框</option>
                        </select>
                    </label>
                    <button id="t-scene-hub-send" class="t-btn t-btn-primary" disabled><i class="fa-solid fa-paper-plane"></i> 发送场景</button>
                </div>
            </div>
        </div>
    </div>`;

    $("body").append(html);
    renderSceneHubWindow();
    refreshRollingProgressUI();

    const $overlay = $("#t-scene-hub-overlay");
    $overlay.on("click", "#t-scene-hub-close", () => {
        $overlay.remove();
    });

    $overlay.on("click", ".t-scene-hub-item", function () {
        const key = String($(this).data("scene-key") || "").trim();
        if (!key) return;
        sceneHubSelectedKey = key;
        renderSceneHubWindow();
    });

    $overlay.on("change", "#t-scene-hub-insert-mode", function () {
        const mode = String($(this).val() || "overwrite") === "append" ? "append" : "overwrite";
        $("#t-outline-insert-mode").val(mode);
        saveDraft($("#t-outline-story-input").val() || "", mode);
    });

    $overlay.on("click", "#t-scene-hub-send", () => {
        const rows = collectAllPlanScenes();
        const selected = rows.find(r => r.key === sceneHubSelectedKey);
        if (!selected) return;
        writePlotToInput(selected.scene?.sendable_prompt || "", getCurrentInsertMode());
        markSceneUsed(selected.planId, selected.itemIndex, selected.sceneIndex);
        advanceProgressOnSend(selected.planId, selected.itemIndex);
        sceneHubSelectedKey = "";
        $overlay.remove();
        if (window.toastr) toastr.success("已发送场景到输入框", "故事大纲");
    });

    // 渐进续写面板已随动线迁到本窗口（原在大纲生成主窗口）。
    // 渐进续写依赖编辑态的大纲条目（outlineItems）；细纲窗口可能独立于主窗口打开，
    // 这里先把来源方案加载进编辑器，进度条/指针下拉才有数据。
    $overlay.on("click", "#t-outline-generate-next", async () => {
        if (!editingPlanId) {
            const sourceId = getSceneSourcePlanId();
            const plan = sourceId ? getPlans().find(p => p.id === sourceId) : null;
            if (!plan || !loadPlanToEditor(plan)) {
                if (window.toastr) toastr.warning("请先生成或填写总纲，再渐进续写", "渐进续写");
                return;
            }
            refreshSceneHubListIfOpen();
        }
        await generateNextRolling();
        refreshSceneHubListIfOpen();
    });

    // 手动指定当前推进到的大纲条目（发送即推进之外的兜底纠偏）。
    $overlay.on("change", "#t-outline-rolling-cursor-select", function () {
        if (!editingPlanId) return;
        const idx = Number($(this).val());
        if (!Number.isFinite(idx)) return;
        const plan = getPlans().find(p => p.id === editingPlanId);
        const prev = getPlanProgress(plan);
        // 手动往回拨时清掉"已抵达结局"，允许继续续写。
        const reachedEnding = prev.reachedEnding && idx >= outlineItems.length - 1;
        setPlanProgress(editingPlanId, { itemIndex: idx, reachedEnding });
        if (editingPlanId) setEditingPlan(getPlans().find(p => p.id === editingPlanId));
        refreshRollingProgressUI();
    });

    $overlay.on("click", "#t-outline-rolling-reset", () => {
        if (!editingPlanId) return;
        setPlanProgress(editingPlanId, { itemIndex: 0, reachedEnding: false });
        setEditingPlan(getPlans().find(p => p.id === editingPlanId));
        refreshRollingProgressUI();
        refreshSceneHubListIfOpen();
        if (window.toastr) toastr.info("已回到开头，可重新渐进续写", "渐进续写");
    });

    // 大纲情节预览：展开/收起 + 点击某条直接推进指针（与下拉等效的快捷纠偏）。
    $overlay.on("click", "#t-outline-rolling-outline-toggle", () => {
        toggleRollingOutlinePreview();
    });

    // 点条目主体 = 展开/收起该条完整情节（方案 A）。
    $overlay.on("click", "#t-outline-rolling-outline-preview .t-rolling-outline-item", function (e) {
        if ($(e.target).closest(".t-rolling-outline-jump").length > 0) return;
        const idx = Number($(this).data("rolling-outline-idx"));
        if (!Number.isFinite(idx)) return;
        rollingPreviewExpandedIdx = rollingPreviewExpandedIdx === idx ? -1 : idx;
        refreshRollingProgressUI();
        // 展开后把该条滚进可视区
        if (rollingPreviewExpandedIdx === idx) {
            const $item = $("#t-outline-rolling-outline-preview .t-rolling-outline-item").filter((_, el) => Number($(el).data("rolling-outline-idx")) === idx);
            $item[0]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
    });

    // 右侧箭头按钮 = 拨进度指针到该条（与指针下拉同一套逻辑：往回拨清掉"已抵达结局"）。
    $overlay.on("click", "#t-outline-rolling-outline-preview .t-rolling-outline-jump", function (e) {
        e.stopPropagation();
        const idx = Number($(this).data("rolling-outline-jump"));
        if (!Number.isFinite(idx)) return;

        let plan = editingPlanId ? getPlans().find(p => p.id === editingPlanId) : null;
        if (!plan) {
            const sourceId = getSceneSourcePlanId();
            plan = sourceId ? getPlans().find(p => p.id === sourceId) : null;
        }
        if (!plan) return;
        const total = Array.isArray(plan.items) ? plan.items.length : 0;
        if (total <= 0 || idx < 0 || idx >= total) return;

        const prev = getPlanProgress(plan);
        const reachedEnding = prev.reachedEnding && idx >= total - 1;
        setPlanProgress(plan.id, { itemIndex: idx, reachedEnding });
        if (editingPlanId === plan.id) setEditingPlan(getPlans().find(p => p.id === plan.id));
        refreshRollingProgressUI();
    });
}

export function openOutlineEntryDialog() {
    ensureCssLoaded();
    $("#t-outline-entry-dialog").remove();
    const hasPlans = getPlans().length > 0;

    const html = `
    <div id="t-outline-entry-dialog" class="t-dialog-overlay t-dialog-overlay--outline t-root">
        <div class="t-dialog-box">
            <div class="t-dialog-header">
                <span><i class="fa-solid fa-list-check"></i> 选择入口</span>
                <div class="t-dialog-close" id="t-outline-entry-close"><i class="fa-solid fa-times"></i></div>
            </div>
            <div class="t-dialog-body t-dialog-body--tight t-outline-entry-form">
                <button id="t-outline-entry-open-outline" class="t-btn t-btn-primary"><i class="fa-solid fa-list-check"></i> 故事大纲</button>
                <button id="t-outline-entry-open-scenes" class="t-btn" ${hasPlans ? "" : "disabled"}><i class="fa-solid fa-clapperboard"></i> 细纲情节</button>
                ${hasPlans ? "" : '<div class="t-plan-tip">请先至少保存一个方案后再使用细纲情节</div>'}
            </div>
        </div>
    </div>`;

    $("body").append(html);

    const close = () => $("#t-outline-entry-dialog").remove();
    $("#t-outline-entry-close").on("click", close);
    $("#t-outline-entry-open-outline").on("click", () => {
        close();
        openStoryOutlineWindow();
    });
    $("#t-outline-entry-open-scenes").on("click", () => {
        if (!hasPlans) return;
        close();
        openSceneHubWindow();
    });
}

function renderPlanDetailCarousel(plan) {
    const items = normalizeItems(plan?.items || []);
    const itemCursor = getPlanItemCursor(plan?.id, items.length);
    const item = items[itemCursor] || null;
    const scenes = Array.isArray(item?.scenes) ? item.scenes : [];
    const sortedScenes = scenes
        .map((scene, sceneIndex) => ({
            scene,
            sceneIndex,
            used: isSceneUsed(plan, itemCursor, sceneIndex)
        }))
        .sort((a, b) => {
            if (a.used === b.used) return a.scene.scene_index - b.scene.scene_index;
            return a.used ? 1 : -1;
        });

    const sceneBlocks = sortedScenes.map(({ scene, sceneIndex, used }) => `
        <div class="t-plan-scene ${used ? "used" : ""}">
            <div class="t-plan-scene-head ${used ? "used" : ""}">场景 ${scene.scene_index} · ${escapeHtml(scene.scene_time || "未设时间")} · ${escapeHtml(scene.scene_location || "未设地点")} ${used ? '<span class="t-plan-used-tag">已使用</span>' : ""}</div>
            <div class="t-plan-scene-text ${used ? "used" : ""}"><b>目标</b> ${escapeHtml(scene.scene_goal || "(空)")}</div>
            <div class="t-plan-scene-text ${used ? "used" : ""}"><b>冲突</b> ${escapeHtml(scene.conflict || "(空)")}</div>
            <div class="t-plan-scene-text ${used ? "used" : ""}"><b>关键节点</b><br>${escapeHtml(scene.key_beats || "(空)").replace(/\n/g, "<br>")}</div>
        </div>
    `).join("");

    if (!item) return '<div class="t-plan-empty">该方案为空</div>';

    return `
        <div class="t-plan-item-carousel" data-plan-id="${plan.id}" data-item-total="${items.length}">
            <button class="t-plan-item-nav-btn" data-action="plan-item-prev" data-plan-id="${plan.id}" ${itemCursor <= 0 ? "disabled" : ""}>&lt;</button>
            <div class="t-plan-item-view" data-plan-id="${plan.id}">
                <div class="t-plan-item-pager">${itemCursor + 1} / ${items.length}</div>
                <div class="t-plan-item-block">
                    <div class="t-plan-item-head">#${item.index} [${escapeHtml(item.time || "未设时间")}] ${escapeHtml(item.title || "未命名")}</div>
                    <div class="t-plan-item-text">${escapeHtml(item.plot || "(空)")}</div>
                    ${item.foreshadowing ? `<div class="t-plan-item-foreshadow">伏笔：${escapeHtml(item.foreshadowing)}</div>` : ""}
                    <div class="t-plan-scenes-wrap">${sceneBlocks || '<div class="t-plan-scene-empty">暂无场景细纲</div>'}</div>
                </div>
            </div>
            <button class="t-plan-item-nav-btn" data-action="plan-item-next" data-plan-id="${plan.id}" ${itemCursor >= items.length - 1 ? "disabled" : ""}>&gt;</button>
        </div>
    `;
}

function updatePlanDetailDialog(planId) {
    const dialog = $("#t-outline-plan-detail-dialog");
    if (dialog.length === 0) return;
    const plan = getPlans().find(p => p.id === planId);
    if (!plan) {
        dialog.remove();
        return;
    }
    const updated = new Date(plan.updatedAt || Date.now());
    const timeText = `${updated.getMonth() + 1}/${updated.getDate()} ${String(updated.getHours()).padStart(2, "0")}:${String(updated.getMinutes()).padStart(2, "0")}`;
    const items = normalizeItems(plan.items || []);
    dialog.attr("data-plan-id", plan.id);
    dialog.find("#t-plan-detail-dialog-title").text(plan.name || "未命名方案");
    dialog.find("#t-plan-detail-dialog-meta").text(`${timeText} · ${items.length} 条`);
    dialog.find("#t-plan-detail-dialog-content").html(renderPlanDetailCarousel(plan));
}

function showPlanDetailDialog(planId) {
    const plan = getPlans().find(p => p.id === planId);
    if (!plan) return;
    $("#t-outline-plan-detail-dialog").remove();
    const html = `
    <div id="t-outline-plan-detail-dialog" class="t-dialog-overlay t-dialog-overlay--outline t-root" data-plan-id="${plan.id}">
        <div class="t-dialog-box">
            <div class="t-dialog-header">
                <span><i class="fa-solid fa-folder-open"></i> <span id="t-plan-detail-dialog-title"></span></span>
                <div class="t-dialog-close" id="t-plan-detail-close"><i class="fa-solid fa-times"></i></div>
            </div>
            <div class="t-dialog-body t-dialog-body--tight">
                <div id="t-plan-detail-dialog-meta" class="t-plan-detail-meta"></div>
                <div id="t-plan-detail-dialog-content" class="t-plan-preview-body"></div>
            </div>
            <div class="t-dialog-footer">
                <button id="t-plan-detail-close-btn" class="t-btn">关闭</button>
            </div>
        </div>
    </div>`;
    $("#t-story-outline-overlay").append(html);
    updatePlanDetailDialog(plan.id);
    $("#t-plan-detail-close, #t-plan-detail-close-btn").on("click", () => {
        $("#t-outline-plan-detail-dialog").remove();
    });
}

function renderPlanHub() {
    const plans = getPlans();
    if (!activePlanId) activePlanId = getActivePlanId();
    let sceneSourcePlanId = getSceneSourcePlanId();

    const $list = $("#t-outline-plan-list");
    if ($list.length === 0) return;

    if (plans.length === 0) {
        if (sceneSourcePlanId) setSceneSourcePlanId("");
        $list.html('<div class="t-plan-empty">暂无方案，请先点击“新建方案”</div>');
        updatePlanWorkflowUI();
        updatePlanHubActionState();
        return;
    }

    if (!sceneSourcePlanId || !plans.some(p => p.id === sceneSourcePlanId)) {
        sceneSourcePlanId = plans[0]?.id || "";
        setSceneSourcePlanId(sceneSourcePlanId);
    }

    if (activePlanId && !plans.some(p => p.id === activePlanId)) {
        activePlanId = plans[0]?.id || "";
        setActivePlanId(activePlanId);
    }

    $list.html(plans.map((plan) => {
        const active = plan.id === activePlanId;
        const updated = new Date(plan.updatedAt || Date.now());
        const timeText = `${updated.getMonth() + 1}/${updated.getDate()} ${String(updated.getHours()).padStart(2, "0")}:${String(updated.getMinutes()).padStart(2, "0")}`;
        const items = normalizeItems(plan.items || []);
        const isSource = sceneSourcePlanId === plan.id;

        return `
            <div class="t-plan-accordion-item ${active ? "expanded" : ""}" data-plan-id="${plan.id}">
                <div class="t-plan-accordion-head" data-action="select-plan" data-plan-id="${plan.id}">
                    <div class="t-plan-accordion-main">
                        <div class="t-plan-name">${escapeHtml(plan.name || "未命名方案")}</div>
                        <div class="t-plan-meta">${timeText} · ${items.length} 条</div>
                        <div class="t-plan-tip">${isSource ? "当前细纲来源方案" : "单击选中方案"}</div>
                    </div>
                </div>
                <div class="t-plan-card-actions">
                    <label class="t-plan-source-radio" title="选择后，细纲情节页将从该方案读取并使用场景内容">
                        <input type="radio" class="t-choice-input t-choice-input--cyan-muted" name="t-plan-scene-source" data-action="set-scene-source" data-plan-id="${plan.id}" ${isSource ? "checked" : ""}>
                        <span>作为细纲来源</span>
                    </label>
                    <div class="t-plan-source-note">说明：勾选后，细纲情节页会优先使用该方案中的场景。</div>
                    <button class="t-btn t-btn-xs t-plan-delete-btn" data-action="delete-plan" data-plan-id="${plan.id}"><i class="fa-solid fa-trash"></i> 删除方案</button>
                </div>
            </div>
        `;
    }).join(""));
    updatePlanWorkflowUI();
    updatePlanHubActionState();
}

function showPlanInstructionDialog(plan) {
    if (!plan) return;
    const instructionText = getPlanInstruction(plan);
    const planName = plan.name || "未命名方案";
    $("#t-outline-plan-instruction-dialog").remove();

    const html = `
    <div id="t-outline-plan-instruction-dialog" class="t-dialog-overlay t-dialog-overlay--outline t-root">
        <div class="t-dialog-box">
            <div class="t-dialog-header">
                <span><i class="fa-solid fa-file-lines"></i> 故事指令 · ${escapeHtml(planName)}</span>
                <div class="t-dialog-close" id="t-plan-instruction-close"><i class="fa-solid fa-times"></i></div>
            </div>
            <div class="t-dialog-body t-dialog-body--tight">
                <pre class="t-outline-raw-pre">${escapeHtml(instructionText || "（无）")}</pre>
            </div>
            <div class="t-dialog-footer">
                <button id="t-plan-instruction-close-btn" class="t-btn">关闭</button>
            </div>
        </div>
    </div>`;

    $("body").append(html);
    $("#t-plan-instruction-close, #t-plan-instruction-close-btn").on("click", () => {
        $("#t-outline-plan-instruction-dialog").remove();
    });
}

function normalizeItems(items) {
    if (!Array.isArray(items)) return [];
    return items.map((item, idx) => ({
        index: idx + 1,
        time: typeof item?.time === "string" ? item.time : "",
        title: typeof item?.title === "string" ? item.title : "",
        plot: typeof item?.plot === "string" ? item.plot : "",
        foreshadowing: typeof item?.foreshadowing === "string" ? item.foreshadowing : "",
        scenes: normalizeScenes(item?.scenes)
    }));
}

function normalizeScenes(scenes) {
    if (!Array.isArray(scenes)) return [];
    return scenes.map((scene, idx) => ({
        scene_index: idx + 1,
        scene_time: typeof scene?.scene_time === "string" ? scene.scene_time : "",
        scene_location: typeof scene?.scene_location === "string" ? scene.scene_location : "",
        scene_goal: typeof scene?.scene_goal === "string" ? scene.scene_goal : "",
        conflict: typeof scene?.conflict === "string" ? scene.conflict : "",
        key_beats: Array.isArray(scene?.key_beats)
            ? scene.key_beats.filter(Boolean).join("\n")
            : (typeof scene?.key_beats === "string" ? scene.key_beats : ""),
        sendable_prompt: typeof scene?.sendable_prompt === "string" ? scene.sendable_prompt : "",
        notes: typeof scene?.notes === "string" ? scene.notes : ""
    }));
}

function reindexItems() {
    outlineItems = outlineItems.map((item, idx) => ({ ...item, index: idx + 1 }));
}

function createEmptyOutlineItem(index = 1) {
    return {
        index: Number(index) || 1,
        time: "",
        title: "",
        plot: "",
        foreshadowing: "",
        scenes: []
    };
}

function createEmptySceneItem(index = 1) {
    return {
        scene_index: Number(index) || 1,
        scene_time: "",
        scene_location: "",
        scene_goal: "",
        conflict: "",
        key_beats: "",
        sendable_prompt: "",
        notes: ""
    };
}

function closeAddItemSheet() {
    $("#t-outline-add-sheet").removeClass("show");
    $("#t-outline-add-sheet-backdrop").removeClass("show");
    $("#t-outline-add-fab").attr("aria-expanded", "false");
}

function openAddItemSheet() {
    $("#t-outline-add-sheet").addClass("show");
    $("#t-outline-add-sheet-backdrop").addClass("show");
    $("#t-outline-add-fab").attr("aria-expanded", "true");
}

function syncAddFabVisibility() {
    const inEditor = currentView === "editor";
    const hasPlanContext = !!editingPlanId;
    const drawerOpen = $("#t-outline-mobile-drawer").hasClass("show");
    $("#t-outline-fab-wrap").toggle(inEditor && hasPlanContext && !drawerOpen);
    if (!inEditor || drawerOpen) closeAddItemSheet();
}

function appendOutlineItem() {
    if (!ensureEditingPlanContext()) return;

    const nextIndex = outlineItems.length;
    outlineItems.push(createEmptyOutlineItem(nextIndex + 1));
    reindexItems();

    sceneExpandedMap[nextIndex] = false;
    selectedRowIndex = nextIndex;
    sceneEditorItemIndex = nextIndex;

    renderRows();
    renderDesktopEditor(nextIndex, "title");
    saveDraft($("#t-outline-story-input").val(), $("#t-outline-insert-mode").val());

    if (window.toastr) toastr.success("已新增大纲条目", "故事大纲");
}

function appendSceneItem() {
    if (!ensureEditingPlanContext()) return;

    const targetIndex = outlineItems.length;
    const nextItem = createEmptyOutlineItem(targetIndex + 1);
    nextItem.scenes = [createEmptySceneItem(1)];
    outlineItems.push(nextItem);
    reindexItems();
    const targetItem = outlineItems[targetIndex];
    if (!targetItem) return;
    reindexScenes(targetItem);

    sceneExpandedMap[targetIndex] = true;
    selectedRowIndex = targetIndex;
    sceneEditorItemIndex = targetIndex;

    renderRows();
    setEditorSubView("scene");
    renderSceneEditorPage();

    if (window.matchMedia("(max-width: 768px)").matches) {
        openMobileEditor(targetIndex);
        setMobileEditorSubView("scene");
        renderMobileDrawerScenes(targetIndex);
    } else {
        setTimeout(() => {
            const card = document.querySelector('#t-outline-scene-editor-page .t-scene-page-card[data-scene-index="0"]');
            const input = card?.querySelector('[data-scene-page-field="scene_time"]');
            if (input) {
                input.focus();
                if (typeof input.select === "function") input.select();
            }
        }, 0);
    }

    saveDraft($("#t-outline-story-input").val(), $("#t-outline-insert-mode").val());
    if (window.toastr) toastr.success("已新增细纲条目", "故事大纲");
}

function reindexScenes(item) {
    if (!item || !Array.isArray(item.scenes)) return;
    item.scenes = item.scenes.map((scene, idx) => ({ ...scene, scene_index: idx + 1 }));
}

function deleteOutlineItemAt(index, options = {}) {
    const resolvedIndex = Number(index);
    if (Number.isNaN(resolvedIndex) || !outlineItems[resolvedIndex]) return false;

    outlineItems.splice(resolvedIndex, 1);
    const nextMap = {};
    outlineItems.forEach((_, idx) => {
        nextMap[idx] = sceneExpandedMap[idx] || sceneExpandedMap[idx + 1] || false;
    });
    sceneExpandedMap = nextMap;

    if (selectedRowIndex === resolvedIndex) {
        selectedRowIndex = -1;
    } else if (selectedRowIndex > resolvedIndex) {
        selectedRowIndex -= 1;
    }

    if (desktopEditorIndex === resolvedIndex) {
        closeDesktopEditor();
    } else if (desktopEditorIndex > resolvedIndex) {
        desktopEditorIndex -= 1;
    }

    if (outlineItems.length === 0) {
        sceneEditorItemIndex = -1;
    } else if (sceneEditorItemIndex > resolvedIndex) {
        sceneEditorItemIndex -= 1;
    } else if (sceneEditorItemIndex === resolvedIndex) {
        sceneEditorItemIndex = Math.min(resolvedIndex, outlineItems.length - 1);
    }

    reindexItems();

    if (options.closeMobile) {
        closeMobileEditor();
    }

    renderRows();
    saveDraft($("#t-outline-story-input").val(), $("#t-outline-insert-mode").val());
    return true;
}

function clearEditorDraft() {
    const insertMode = $("#t-outline-insert-mode").val() || "overwrite";
    outlineItems = [];
    sceneExpandedMap = {};
    selectedRowIndex = -1;
    sceneEditorItemIndex = -1;
    closeDesktopEditor();
    closeMobileEditor();
    $("#t-outline-story-input").val("");
    $("#t-outline-plan-name").val("");
    planRenameMode = false;
    setEditingPlan(null);
    renderRows();
    saveDraft("", insertMode);
    refreshPlanNameDisplay();
}

function writePlotToInput(text, mode = "overwrite") {
    const input = document.querySelector("#send_textarea");
    if (!input) {
        if (window.toastr) toastr.error("未找到酒馆输入框");
        return;
    }

    const payload = text || "";
    const current = input.value || "";
    if (mode === "append" && current.trim()) {
        input.value = `${current}\n${payload}`;
    } else {
        input.value = payload;
    }

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    if (window.toastr) toastr.success(`已${mode === "append" ? "追加" : "填入"}发送输入框（未自动发送）`, "故事大纲");
}

function showRawResponseDialog(rawContent, options = {}) {
    const {
        title = "生成＆历史响应",
        editable = false,
        parseAction = null,
        parseButtonLabel = "重新解析并应用",
        parseHint = ""
    } = options || {};

    const historyOptions = rawResponseHistory.map((entry, idx) => {
        const label = `${idx + 1}. ${entry.typeLabel} · ${entry.charName || "未命名角色"} · ${formatRawHistoryTime(entry.createdAt)}`;
        return `<option value="${escapeHtml(entry.id)}">${escapeHtml(label)}</option>`;
    }).join("");
    const defaultContent = String(rawContent || lastRawResponse || rawResponseHistory[0]?.content || "");

    $("#t-outline-raw-dialog").remove();
    const html = `
    <div id="t-outline-raw-dialog" class="t-dialog-overlay t-dialog-overlay--outline t-root">
        <div class="t-dialog-box">
            <div class="t-dialog-header">
                <span><i class="fa-solid fa-code"></i> ${escapeHtml(title)}</span>
                <div class="t-dialog-close" id="t-outline-raw-close"><i class="fa-solid fa-times"></i></div>
            </div>
            <div class="t-dialog-body t-dialog-body--tight">
                ${historyOptions ? `<div class="t-outline-raw-history-row"><span class="t-outline-raw-history-label">历史记录</span><select id="t-outline-raw-history" class="t-outline-select t-flex-1">${historyOptions}</select></div>` : ""}
                <div class="t-outline-raw-bar">
                    <div class="t-outline-raw-meta">
                        <span id="t-outline-raw-length" class="t-outline-raw-stat">长度: ${defaultContent.length} 字符</span>
                        <span id="t-outline-raw-elapsed" class="t-outline-raw-stat">耗时: ${formatElapsedDuration(getCurrentElapsedMs())}</span>
                        <span id="t-outline-raw-mood" class="t-raw-wait-anim" aria-live="polite" aria-label="模型生成中动画">
                            <span></span><span></span><span></span>
                        </span>
                    </div>
                    <div class="t-outline-raw-actions">
                        <button id="t-outline-export-raw-history" class="t-btn t-btn-xs"><i class="fa-solid fa-file-export"></i> 导出历史</button>
                    </div>
                </div>
                ${editable ? `<textarea id="t-outline-raw-editor" class="t-outline-raw-editor">${escapeHtml(defaultContent)}</textarea>` : `<pre class="t-outline-raw-pre">${escapeHtml(defaultContent || "(空)")}</pre>`}
                ${parseHint ? `<div class="t-outline-raw-hint">${escapeHtml(parseHint)}</div>` : ""}
            </div>
            <div class="t-dialog-footer">
                ${editable ? `<button id="t-outline-raw-reparse" class="t-btn t-btn-primary">${escapeHtml(parseButtonLabel)}</button>` : ""}
                <button id="t-outline-raw-abort" class="t-btn t-btn--glass" ${activeOutlineAbortController ? "" : "disabled"} ${activeOutlineAbortController ? "" : "style=\"display:none;\""}><i class="fa-solid fa-stop"></i> 终止</button>
                <button id="t-outline-raw-close-btn" class="t-btn">关闭</button>
            </div>
        </div>
    </div>`;

    $("body").append(html);
    isRawDialogOpen = true;
    updateResponseTimerUI();
    setRawWaitingAnimation(responseTimerRunning);

    if (historyOptions) {
        const firstId = rawResponseHistory[0]?.id || "";
        if (firstId) $("#t-outline-raw-history").val(firstId);
    }

    function setDialogRawContent(content) {
        const value = String(content || "");
        const $pre = $("#t-outline-raw-dialog .t-outline-raw-pre");
        const $editor = $("#t-outline-raw-editor");
        if ($pre.length > 0) $pre.text(value || "(空)");
        if ($editor.length > 0) $editor.val(value);
        $("#t-outline-raw-length").text(`长度: ${value.length} 字符`);
    }

    function getDialogRawContent() {
        const $editor = $("#t-outline-raw-editor");
        if ($editor.length > 0) return String($editor.val() || "");
        const $pre = $("#t-outline-raw-dialog .t-outline-raw-pre");
        return String($pre.text() || "");
    }

    $("#t-outline-raw-close, #t-outline-raw-close-btn").on("click", () => {
        $("#t-outline-raw-dialog").remove();
        isRawDialogOpen = false;
    });

    $("#t-outline-raw-abort").on("click", () => {
        if (activeOutlineAbortController) activeOutlineAbortController.abort();
    });

    $("#t-outline-raw-history").on("change", function () {
        const id = String($(this).val() || "");
        const picked = rawResponseHistory.find(entry => entry.id === id);
        if (!picked) return;
        setDialogRawContent(picked.content || "");
    });

    $("#t-outline-export-raw-history").on("click", () => {
        exportRawResponseHistory();
    });

    if (editable && typeof parseAction === "function") {
        $("#t-outline-raw-reparse").on("click", async function () {
            const $btn = $(this);
            const originalHtml = $btn.html();
            const editedText = String($("#t-outline-raw-editor").val() || "").trim();
            pushRawResponseHistory(editedText, "手动修复");
            if (!editedText) {
                if (window.toastr) toastr.error("内容为空，无法解析", "故事大纲");
                return;
            }
            $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 解析中...');
            try {
                await parseAction(editedText);
                $("#t-outline-raw-dialog").remove();
                isRawDialogOpen = false;
            } catch (e) {
                if (window.toastr) toastr.error(e.message || "重新解析失败", "故事大纲");
            } finally {
                $btn.prop("disabled", false).html(originalHtml);
            }
        });
    }
}

function updateRawPreview(statusText = "") {
    if (!isRawDialogOpen || $("#t-outline-raw-dialog").length === 0) return;
    if (statusText) {
        $("#t-outline-raw-dialog .t-dialog-header span").html(`<i class=\"fa-solid fa-code\"></i> ${statusText}`);
    }
    const $pre = $("#t-outline-raw-dialog .t-outline-raw-pre");
    if ($pre.length > 0) {
        $pre.text(lastRawResponse || "(空)");
    }
    const $editor = $("#t-outline-raw-editor");
    if ($editor.length > 0) {
        $editor.val(lastRawResponse || "");
    }
    $("#t-outline-raw-length").text(`长度: ${(lastRawResponse || "").length} 字符`);
    updateResponseTimerUI();
    const status = String(statusText || "");
    const waiting = responseTimerRunning && (!status || /生成中|流式生成/.test(status));
    setRawWaitingAnimation(waiting);
}

function ensureRawDialogForStreaming(title = "流式生成中...") {
    if (!isRawDialogOpen || $("#t-outline-raw-dialog").length === 0) {
        showRawResponseDialog(lastRawResponse || "");
    }
    syncAbortButtonUI();
    updateRawPreview(title);
}

function applyParsedScenes(parsed) {
    const incomingItems = Array.isArray(parsed?.items) ? parsed.items : [];
    for (let i = 0; i < outlineItems.length; i++) {
        const source = incomingItems.find(x => Number(x?.index) === outlineItems[i].index) || incomingItems[i];
        outlineItems[i].scenes = normalizeScenes(source?.scenes || []);
        reindexScenes(outlineItems[i]);
        sceneExpandedMap[i] = true;
    }

    renderRows();
    const mobileIdx = getMobileDrawerIndex();
    if (!Number.isNaN(mobileIdx) && mobileIdx >= 0 && outlineItems[mobileIdx]) {
        renderMobileDrawerScenes(mobileIdx);
    }
    persistCurrentEditingPlan();
    saveDraft($("#t-outline-story-input").val(), $("#t-outline-insert-mode").val());
}

function applyParsedOutline(parsed, storyInput, insertMode) {
    outlineItems = normalizeItems(parsed.items);
    sceneExpandedMap = {};
    renderRows();
    persistCurrentEditingPlan();
    // 重新生成大纲=路标重画，渐进续写进度归零。
    if (editingPlanId) {
        setPlanProgress(editingPlanId, { itemIndex: 0, reachedEnding: false });
        setEditingPlan(getPlans().find(p => p.id === editingPlanId));
    }
    refreshRollingProgressUI();
    saveDraft(storyInput, insertMode);
}

function parseAllScenesResponse(raw) {
    return parseJsonItemsResponse(raw, "细纲返回格式无法解析为 JSON（缺少 items）");
}

function buildOutlinePayloadForPrompt() {
    return outlineItems.map((item) => ({
        index: item.index,
        time: item.time || "",
        title: item.title || "",
        plot: item.plot || "",
        foreshadowing: item.foreshadowing || ""
    }));
}

function buildAllScenesPrompt(ctx, userStoryInput, openingText) {
    const outlinePayload = buildOutlinePayloadForPrompt();
    const templates = getPromptTemplates();
    const vars = buildPromptTemplateVars(ctx, userStoryInput || "(空)", openingText, outlinePayload);
    const sys = renderPromptTemplate(templates.scenes.system, vars);
    const user = renderPromptTemplate(templates.scenes.user, vars);

    return [
        { role: "system", content: sys },
        { role: "user", content: user }
    ];
}

// 取最近 N 楼酒馆正文（走标签白名单过滤），越靠后越新，拼成给模型的"已发生的剧情"。
function collectRecentChatText(floors) {
    const n = Number(floors) || 0;
    if (n <= 0) return "";
    const entries = getChatHistoryEntries();
    if (!entries.length) return "";
    return entries
        .slice(-n)
        .map((e) => `【${e.role}】${e.text}`)
        .join("\n\n");
}

// 汇总当前方案已生成的细纲场景，作为"已生成的细纲摘要"喂回模型，避免重复推进。
function summarizeScenesSoFar() {
    const lines = [];
    outlineItems.forEach((item) => {
        const scenes = Array.isArray(item.scenes) ? item.scenes : [];
        scenes.forEach((scene) => {
            const summary = String(scene.sendable_prompt || scene.scene_goal || scene.key_beats || "").trim();
            if (summary) {
                lines.push(`#${item.index}-${scene.scene_index} ${summary.slice(0, 120)}`);
            }
        });
    });
    return lines.join("\n");
}

// 组装渐进续写 prompt：完整大纲 + 最近正文 + 已生成细纲摘要 + 当前进度。
function buildRollingPrompt(ctx, userStoryInput, openingText, progressHint) {
    const outlinePayload = buildOutlinePayloadForPrompt();
    const templates = getPromptTemplates();
    const vars = buildPromptTemplateVars(ctx, userStoryInput || "(空)", openingText, outlinePayload, {
        recentChat: collectRecentChatText(getRollingChatFloors()),
        scenesSoFar: summarizeScenesSoFar(),
        progressHint
    });
    const sys = renderPromptTemplate(templates.rolling.system, vars);
    const user = renderPromptTemplate(templates.rolling.user, vars);

    return [
        { role: "system", content: sys },
        { role: "user", content: user }
    ];
}

// 解析渐进续写返回：复用 items 解析，progress 字段单独容错（缺失返回 null，由上层退回指针推进）。
function parseRollingResponse(raw) {
    const data = parseJsonItemsResponse(raw, "渐进续写返回格式无法解析为 JSON（缺少 items）");
    let progress = null;
    const rawProgress = data?.progress;
    if (rawProgress && typeof rawProgress === "object") {
        const idx = Number(rawProgress.current_item_index);
        progress = {
            currentItemIndex: Number.isFinite(idx) ? idx : null,
            reachedEnding: rawProgress.reached_ending === true,
            note: String(rawProgress.note || "").trim()
        };
    }
    return { items: Array.isArray(data.items) ? data.items : [], progress };
}

// 把新生成的场景"追加"到对应大纲条目（区别于 applyParsedScenes 的整体替换）。
// index 按大纲条目序号匹配（1-based），匹配不到就落到当前进度指针那一条。
function appendRollingScenes(parsed, fallbackItemIndex) {
    const incomingItems = Array.isArray(parsed?.items) ? parsed.items : [];
    let appended = 0;
    let lastTouchedIdx = -1;

    incomingItems.forEach((incoming) => {
        const declaredIndex = Number(incoming?.index);
        let targetIdx = outlineItems.findIndex((it) => it.index === declaredIndex);
        if (targetIdx === -1) {
            targetIdx = Math.min(Math.max(Number(fallbackItemIndex) || 0, 0), outlineItems.length - 1);
        }
        const target = outlineItems[targetIdx];
        if (!target) return;
        if (!Array.isArray(target.scenes)) target.scenes = [];
        const newScenes = normalizeScenes(incoming?.scenes || []);
        if (newScenes.length === 0) return;
        target.scenes = target.scenes.concat(newScenes);
        reindexScenes(target);
        sceneExpandedMap[targetIdx] = true;
        appended += newScenes.length;
        lastTouchedIdx = targetIdx;
    });

    renderRows();
    const mobileIdx = getMobileDrawerIndex();
    if (!Number.isNaN(mobileIdx) && mobileIdx >= 0 && outlineItems[mobileIdx]) {
        renderMobileDrawerScenes(mobileIdx);
    }
    persistCurrentEditingPlan();
    saveDraft($("#t-outline-story-input").val(), $("#t-outline-insert-mode").val());

    return { appended, lastTouchedIdx };
}

function renderRows() {
    const $tbody = $("#t-outline-tbody");
    if ($tbody.length === 0) return;

    updateGenerateAllScenesButtonState();

    if (outlineItems.length === 0) {
        selectedRowIndex = -1;
        sceneEditorItemIndex = -1;
        closeDesktopEditor();
        $tbody.html(`
            <tr>
                <td colspan="6" class="t-outline-empty">
                    <div>暂无大纲，可先生成，或手动创建第一条</div>
                    <button id="t-outline-empty-create-first" class="t-btn t-btn-xs" style="margin-top:8px;"><i class="fa-solid fa-plus"></i> 创建第一条大纲</button>
                </td>
            </tr>
        `);
        renderMobileCards();
        renderSceneEditorPage();
        return;
    }

    const rows = outlineItems.map((item, idx) => {
        const scenes = Array.isArray(item.scenes) ? item.scenes : [];
        const sceneRows = scenes.length > 0
            ? scenes.map((scene, sceneIdx) => `
                <tr data-plot-index="${idx}" data-scene-index="${sceneIdx}">
                    <td class="t-scene-col-index">${scene.scene_index}</td>
                    <td>${escapeHtml(scene.scene_time || "(空)")}</td>
                    <td>${escapeHtml(scene.scene_location || "(空)")}</td>
                    <td>${escapeHtml(scene.scene_goal || "(空)")}</td>
                    <td>${escapeHtml(scene.conflict || "(空)")}</td>
                    <td>${escapeHtml(scene.key_beats || "(空)").replace(/\n/g, "<br>")}</td>
                    <td>${escapeHtml(scene.sendable_prompt || "(空)")}</td>
                    <td>${escapeHtml(scene.notes || "(空)")}</td>
                </tr>
            `).join("")
            : `<tr><td colspan="8" class="t-outline-empty">暂无细纲，点击“细纲生成”</td></tr>`;

        return `
            <tr data-index="${idx}">
                <td class="t-outline-col-index">${item.index}</td>
                <td data-label="时间" data-edit-field="time"><div class="t-cell-text">${escapeHtml(item.time || "(空)")}</div></td>
                <td data-label="标题" data-edit-field="title"><div class="t-cell-text">${escapeHtml(item.title || "(空)")}</div></td>
                <td data-label="情节" data-edit-field="plot"><div class="t-cell-text t-cell-long">${escapeHtml(getBriefText(item.plot, 70))}</div></td>
                <td data-label="伏笔" data-edit-field="foreshadowing"><div class="t-cell-text t-cell-long">${escapeHtml(getBriefText(item.foreshadowing, 52))}</div></td>
                <td data-label="操作" class="t-outline-op-indicator" title="点击行展开操作">
                    <i class="fa-solid ${selectedRowIndex === idx ? "fa-chevron-up" : "fa-chevron-down"}"></i>
                </td>
            </tr>
            <tr class="t-outline-op-row ${selectedRowIndex === idx ? "show" : ""}" data-op-parent="${idx}">
                <td colspan="6">
                    <div class="t-outline-op-panel">
                        <button class="t-btn t-btn-xs" data-action="toggle-scenes" title="展开/收起该行情节细纲">
                            <i class="fa-solid fa-layer-group"></i> 展开细纲
                        </button>
                        <button class="t-btn t-btn-xs t-plan-delete-btn" data-action="delete" title="删除本行">
                            <i class="fa-solid fa-trash"></i> 删除
                        </button>
                    </div>
                </td>
            </tr>
            <tr class="t-outline-scene-row ${sceneExpandedMap[idx] ? "show" : ""}" data-scene-parent="${idx}">
                <td colspan="6">
                    <div class="t-outline-scene-wrap">
                        <div class="t-outline-scene-header">
                            <span><i class="fa-solid fa-clapperboard"></i> 情节 ${item.index} 细纲（场景）</span>
                        </div>
                        <div class="t-outline-scene-table-wrap">
                            <table class="t-outline-scene-table">
                                <thead>
                                    <tr>
                                        <th>序号</th>
                                        <th>时间</th>
                                        <th>地点</th>
                                        <th>目标</th>
                                        <th>冲突</th>
                                        <th>关键节点</th>
                                        <th>发送指令</th>
                                        <th>备注</th>
                                    </tr>
                                </thead>
                                <tbody>${sceneRows}</tbody>
                            </table>
                        </div>
                    </div>
                </td>
            </tr>
        `;
    }).join("");

    $tbody.html(rows);
    renderMobileCards();

    if (desktopEditorIndex >= 0 && outlineItems[desktopEditorIndex]) {
        renderDesktopEditor(desktopEditorIndex);
    }

    renderSceneEditorPage();
}

function getSceneEditorTargetIndex() {
    if (sceneEditorItemIndex >= 0 && outlineItems[sceneEditorItemIndex]) return sceneEditorItemIndex;
    if (outlineItems.length > 0) return 0;
    return -1;
}

function renderSceneEditorPage() {
    const $container = $("#t-outline-scene-editor-page");
    if ($container.length === 0) return;

    const idx = getSceneEditorTargetIndex();
    if (idx < 0 || !outlineItems[idx]) {
        $container.html('<div class="t-outline-empty">暂无可编辑的大纲条目</div>');
        return;
    }

    sceneEditorItemIndex = idx;
    const item = outlineItems[idx];
    const scenes = Array.isArray(item.scenes) ? item.scenes : [];
    const sceneBlocks = scenes.map((scene, sceneIdx) => `
        <div class="t-scene-page-card" data-scene-index="${sceneIdx}">
            <div class="t-scene-page-title">场景 ${scene.scene_index}</div>
            <label>时间</label>
            <input class="t-outline-input" data-scene-page-field="scene_time" value="${escapeHtml(scene.scene_time)}">
            <label>地点</label>
            <input class="t-outline-input" data-scene-page-field="scene_location" value="${escapeHtml(scene.scene_location)}">
            <label>目标</label>
            <textarea class="t-outline-textarea" rows="2" data-scene-page-field="scene_goal">${escapeHtml(scene.scene_goal)}</textarea>
            <label>冲突</label>
            <textarea class="t-outline-textarea" rows="2" data-scene-page-field="conflict">${escapeHtml(scene.conflict)}</textarea>
            <label>关键节点</label>
            <textarea class="t-outline-textarea" rows="3" data-scene-page-field="key_beats">${escapeHtml(scene.key_beats)}</textarea>
            <label>发送摘要</label>
            <textarea class="t-outline-textarea" rows="3" data-scene-page-field="sendable_prompt">${escapeHtml(scene.sendable_prompt)}</textarea>
            <label>备注</label>
            <textarea class="t-outline-textarea" rows="2" data-scene-page-field="notes">${escapeHtml(scene.notes)}</textarea>
            <button class="t-btn t-btn-xs t-plan-delete-btn" data-action="scene-page-delete" data-scene-index="${sceneIdx}"><i class="fa-solid fa-trash"></i> 删除场景</button>
        </div>
    `).join("") || '<div class="t-outline-empty">暂无细纲场景，点击新增场景</div>';

    $container.html(`
        <div class="t-scene-page-head">
            <div class="t-scene-page-main">#${item.index} [${escapeHtml(item.time || "未设时间")}] ${escapeHtml(item.title || "未命名")}</div>
            <div class="t-scene-page-nav">
                <button class="t-btn t-btn-xs" data-action="scene-page-prev"><i class="fa-solid fa-chevron-left"></i> 上一条</button>
                <button class="t-btn t-btn-xs" data-action="scene-page-next">下一条 <i class="fa-solid fa-chevron-right"></i></button>
            </div>
        </div>
        <div class="t-scene-page-actions">
            <button class="t-btn t-btn-xs" data-action="scene-page-add"><i class="fa-solid fa-plus"></i> 新增场景</button>
            <button class="t-btn t-btn-xs t-plan-delete-btn" data-action="scene-page-delete-item"><i class="fa-solid fa-trash"></i> 删除细纲条目</button>
        </div>
        <div class="t-scene-page-list">${sceneBlocks}</div>
    `);
}

function setEditorSubView(view) {
    editorSubView = view === "scene" ? "scene" : "outline";
    $("#t-outline-subview-outline").toggle(editorSubView === "outline");
    $("#t-outline-subview-scene").toggle(editorSubView === "scene");
    $("#t-editor-tab-outline").toggleClass("active", editorSubView === "outline");
    $("#t-editor-tab-scene").toggleClass("active", editorSubView === "scene");

    const isMobile = window.matchMedia("(max-width: 768px)").matches;
    if (isMobile) {
        $("#t-outline-mobile-list").toggle(editorSubView === "outline");
    }
    syncAddFabVisibility();
}

function getBriefText(text, maxLen = 38) {
    const s = (text || "").replace(/\s+/g, " ").trim();
    if (!s) return "(空)";
    return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}

function renderMobileCards() {
    const $list = $("#t-outline-mobile-list");
    if ($list.length === 0) return;

    if (outlineItems.length === 0) {
        $list.html('<div class="t-outline-mobile-empty">暂无大纲，可先生成，或手动创建。<div style="margin-top:8px;"><button id="t-outline-mobile-create-first" class="t-btn t-btn-xs"><i class="fa-solid fa-plus"></i> 创建第一条大纲</button></div></div>');
        return;
    }

    const cards = outlineItems.map((item, idx) => {
        const sceneCount = Array.isArray(item.scenes) ? item.scenes.length : 0;
        return `
            <div class="t-outline-mobile-card" data-index="${idx}">
                <div class="t-outline-mobile-head">
                    <span class="idx">#${item.index}</span>
                    <span class="time">${escapeHtml(item.time || "未设时间")}</span>
                    <span class="scene-count">细纲 ${sceneCount}</span>
                </div>
                <div class="t-outline-mobile-title">${escapeHtml(item.title || "未命名标题")}</div>
                <div class="t-outline-mobile-plot">${escapeHtml(getBriefText(item.plot))}</div>
            </div>
        `;
    }).join("");

    $list.html(cards);
}

function openMobileEditor(index) {
    const item = outlineItems[index];
    if (!item) return;
    const $drawer = $("#t-outline-mobile-drawer");
    $drawer.attr("data-index", index);
    $drawer.find("#t-mobile-field-time").val(item.time || "");
    $drawer.find("#t-mobile-field-title").val(item.title || "");
    $drawer.find("#t-mobile-field-plot").val(item.plot || "");
    $drawer.find("#t-mobile-field-foreshadowing").val(item.foreshadowing || "");
    renderMobileDrawerScenes(index);
    setMobileEditorSubView("outline");
    $drawer.addClass("show");
    syncAddFabVisibility();
}

function closeMobileEditor() {
    $("#t-outline-mobile-drawer").removeClass("show").attr("data-index", "");
    syncAddFabVisibility();
}

function setMobileEditorSubView(view) {
    mobileEditorSubView = view === "scene" ? "scene" : "outline";
    $("#t-mobile-outline-view").toggle(mobileEditorSubView === "outline");
    $("#t-mobile-scene-view").toggle(mobileEditorSubView === "scene");
    $("#t-mobile-tab-outline").toggleClass("active", mobileEditorSubView === "outline");
    $("#t-mobile-tab-scene").toggleClass("active", mobileEditorSubView === "scene");
}

function saveMobileEditor() {
    const $drawer = $("#t-outline-mobile-drawer");
    const index = Number($drawer.attr("data-index"));
    const item = outlineItems[index];
    if (!item) return;

    item.time = $drawer.find("#t-mobile-field-time").val() || "";
    item.title = $drawer.find("#t-mobile-field-title").val() || "";
    item.plot = $drawer.find("#t-mobile-field-plot").val() || "";
    item.foreshadowing = $drawer.find("#t-mobile-field-foreshadowing").val() || "";

    renderRows();
    saveDraft($("#t-outline-story-input").val(), $("#t-outline-insert-mode").val());
    if (window.toastr) toastr.success("已保存当前情节", "故事大纲");
}

function renderDesktopEditor(index, focusField = "") {
    const item = outlineItems[index];
    const $panel = $("#t-outline-desktop-editor");
    if (!item || $panel.length === 0) return;
    desktopEditorIndex = index;

    $panel.html(`
        <div class="t-desk-editor-head">
            <div class="title">编辑情节 #${item.index}</div>
            <button class="t-btn t-btn-xs" id="t-desk-editor-close"><i class="fa-solid fa-times"></i></button>
        </div>
        <div class="t-desk-editor-body">
            <label>时间</label>
            <input id="t-desk-field-time" class="t-outline-input" value="${escapeHtml(item.time)}">
            <label>标题</label>
            <input id="t-desk-field-title" class="t-outline-input" value="${escapeHtml(item.title)}">
            <label>情节</label>
            <textarea id="t-desk-field-plot" class="t-outline-textarea" rows="4">${escapeHtml(item.plot)}</textarea>
            <label>伏笔</label>
            <textarea id="t-desk-field-foreshadowing" class="t-outline-textarea" rows="3">${escapeHtml(item.foreshadowing)}</textarea>
            <div class="t-outline-empty" style="margin-top:6px;">细纲编辑请切换到上方“细纲编辑”页</div>
        </div>
        <div class="t-desk-editor-actions">
            <button class="t-btn t-btn-primary" id="t-desk-editor-save"><i class="fa-solid fa-check"></i> 保存</button>
        </div>
    `);

    $panel.addClass("show");

    if (focusField) {
        const targetMap = {
            time: "#t-desk-field-time",
            title: "#t-desk-field-title",
            plot: "#t-desk-field-plot",
            foreshadowing: "#t-desk-field-foreshadowing"
        };
        const selector = targetMap[focusField] || "";
        if (selector) {
            setTimeout(() => {
                const el = document.querySelector(selector);
                if (el) {
                    el.focus();
                    if (typeof el.select === "function") el.select();
                }
            }, 0);
        }
    }
}

function closeDesktopEditor() {
    desktopEditorIndex = -1;
    $("#t-outline-desktop-editor").removeClass("show").empty();
}

function saveDesktopEditor() {
    if (desktopEditorIndex < 0 || !outlineItems[desktopEditorIndex]) return;
    const item = outlineItems[desktopEditorIndex];
    item.time = $("#t-desk-field-time").val() || "";
    item.title = $("#t-desk-field-title").val() || "";
    item.plot = $("#t-desk-field-plot").val() || "";
    item.foreshadowing = $("#t-desk-field-foreshadowing").val() || "";
    renderRows();
    saveDraft($("#t-outline-story-input").val(), $("#t-outline-insert-mode").val());
}

function updateGenerateAllScenesButtonState() {
    const hasOutline = Array.isArray(outlineItems) && outlineItems.length > 0;
    $("#t-outline-generate-all-scenes").prop("disabled", !hasOutline);
    refreshRollingProgressUI();
}

// 刷新渐进续写面板：进度条、状态文案、条目下拉。
// 面板已迁到「细纲情节」窗口：优先显示细纲来源方案的进度；主窗口（大纲编辑）里
// 该面板已不存在，$panel.length===0 时直接跳过。
function refreshRollingProgressUI() {
    const $panel = $("#t-outline-rolling");
    if ($panel.length === 0) return;

    // 细纲窗口独立打开时编辑态可能为空：用细纲来源方案兜底。
    let plan = editingPlanId ? getPlans().find(p => p.id === editingPlanId) : null;
    if (!plan) {
        const sourceId = getSceneSourcePlanId();
        plan = sourceId ? getPlans().find(p => p.id === sourceId) : null;
    }

    const outlineForPanel = (Array.isArray(outlineItems) && outlineItems.length > 0 && plan && plan.id === editingPlanId)
        ? outlineItems
        : (plan ? normalizeItems(plan.items || []) : []);
    if (outlineForPanel.length === 0 || !plan) {
        $panel.hide();
        return;
    }
    $panel.show();

    const total = outlineForPanel.length;
    const progress = getPlanProgress(plan);
    const stepNo = progress.itemIndex + 1;
    const pct = total > 0 ? Math.round((stepNo / total) * 100) : 0;

    $("#t-outline-rolling-bar-fill").css("width", `${progress.reachedEnding ? 100 : pct}%`);
    const currentTitle = outlineForPanel[progress.itemIndex]?.title || "未命名";
    $("#t-outline-rolling-status").text(
        progress.reachedEnding
            ? `已抵达结局（${total}/${total}）`
            : `第 ${stepNo}/${total} 条 · ${currentTitle}`
    );
    $("#t-outline-generate-next").prop("disabled", progress.reachedEnding);

    const $select = $("#t-outline-rolling-cursor-select");
    if ($select.length) {
        const options = outlineForPanel.map((it, idx) =>
            `<option value="${idx}" ${idx === progress.itemIndex ? "selected" : ""}>${idx + 1}. ${escapeHtml((it.title || "未命名").slice(0, 16))}</option>`
        ).join("");
        $select.html(options).val(String(progress.itemIndex));
    }

    renderRollingOutlinePreview(outlineForPanel, progress.itemIndex, progress.reachedEnding);
}

// 渐进续写面板里的大纲情节预览：全部条目一屏纵列，按进度区分状态——
// 已推进过的条目淡化+打勾，当前条目高亮，后续条目常显。
// 交互划分（方案 A）：点条目主体 = 展开/收起该条完整情节（含伏笔），
// 右侧箭头按钮 = 把进度指针拨到该条。展开状态存 rollingPreviewExpandedIdx，
// 进度刷新重渲染时保留。title 属性兜底悬停预览。
let rollingPreviewExpandedIdx = -1;

function renderRollingOutlinePreview(outlineForPanel, currentItemIndex, reachedEnding) {
    const $preview = $("#t-outline-rolling-outline-preview");
    if ($preview.length === 0) return;
    if ($preview.css("display") === "none") return;
    if (rollingPreviewExpandedIdx >= outlineForPanel.length) rollingPreviewExpandedIdx = -1;

    const rows = outlineForPanel.map((item, idx) => {
        const state = idx < currentItemIndex ? "done"
            : idx === currentItemIndex ? (reachedEnding ? "done" : "current")
            : "todo";
        const marker = state === "done"
            ? '<i class="fa-solid fa-check"></i>'
            : state === "current"
                ? '<i class="fa-solid fa-location-dot"></i>'
                : '<i class="fa-regular fa-circle"></i>';
        const expanded = rollingPreviewExpandedIdx === idx;
        // 展开态显示完整 plot 与伏笔；收起态 60 字摘要（title 兜底全文）。
        const plotHtml = expanded
            ? `<div class="t-rolling-outline-plot t-rolling-outline-plot--full">${escapeHtml(item.plot || "(空)")}</div>`
            : `<div class="t-rolling-outline-plot">${escapeHtml(getBriefText(item.plot, 60))}</div>`;
        const foreshadowing = String(item.foreshadowing || "").trim();
        const foreshadowHtml = expanded && foreshadowing
            ? `<div class="t-rolling-outline-foreshadow"><i class="fa-solid fa-seedling"></i> 伏笔：${escapeHtml(foreshadowing)}</div>`
            : "";
        return `
            <div class="t-rolling-outline-item ${state} ${expanded ? "expanded" : ""}" data-rolling-outline-idx="${idx}" title="${escapeHtml(item.plot || "(空)")}">
                <span class="t-rolling-outline-marker">${marker}</span>
                <div class="t-rolling-outline-main">
                    <div class="t-rolling-outline-title">${escapeHtml(item.time || "未设时间")} · ${escapeHtml(item.title || "未命名")}</div>
                    ${plotHtml}
                    ${foreshadowHtml}
                </div>
                <button class="t-rolling-outline-jump" data-rolling-outline-jump="${idx}" title="推进到第 ${idx + 1} 条"><i class="fa-solid fa-forward-step"></i></button>
            </div>`;
    }).join("");

    $preview.html(rows);
}

// 渐进续写大纲预览的展开/收起（open 时随进度刷新重渲染）。收起时清掉单条展开态。
function toggleRollingOutlinePreview(forceOpen) {
    const $preview = $("#t-outline-rolling-outline-preview");
    const $toggle = $("#t-outline-rolling-outline-toggle");
    if ($preview.length === 0) return;
    const willOpen = forceOpen === true ? true : $preview.css("display") === "none";
    $preview.toggle(willOpen);
    $toggle.toggleClass("active", willOpen);
    if (willOpen) {
        refreshRollingProgressUI();
    } else {
        rollingPreviewExpandedIdx = -1;
    }
}

// 细纲窗口开着时刷新场景列表（渐进续写追加场景后同步展示）。
function refreshSceneHubListIfOpen() {
    if ($("#t-scene-hub-overlay").length > 0) {
        renderSceneHubWindow();
        refreshRollingProgressUI();
    }
}

function getMobileDrawerIndex() {
    return Number($("#t-outline-mobile-drawer").attr("data-index"));
}

function renderMobileDrawerScenes(index) {
    const item = outlineItems[index];
    const $list = $("#t-mobile-scenes-list");
    if (!item || $list.length === 0) return;

    const scenes = Array.isArray(item.scenes) ? item.scenes : [];
    $("#t-mobile-scene-count").text(String(scenes.length));

    if (scenes.length === 0) {
        $list.html('<div class="t-mobile-scene-empty">暂无细纲场景，可点击“生成细纲”或“新增场景”</div>');
        return;
    }

    const html = scenes.map((scene, sceneIndex) => `
        <div class="t-mobile-scene-card" data-scene-index="${sceneIndex}">
            <div class="t-mobile-scene-title">场景 ${scene.scene_index}</div>
            <label>时间</label>
            <input class="t-outline-input" data-mobile-scene-field="scene_time" value="${escapeHtml(scene.scene_time)}">
            <label>地点</label>
            <input class="t-outline-input" data-mobile-scene-field="scene_location" value="${escapeHtml(scene.scene_location)}">
            <label>目标</label>
            <textarea class="t-outline-textarea" rows="2" data-mobile-scene-field="scene_goal">${escapeHtml(scene.scene_goal)}</textarea>
            <label>冲突</label>
            <textarea class="t-outline-textarea" rows="2" data-mobile-scene-field="conflict">${escapeHtml(scene.conflict)}</textarea>
            <label>关键节点</label>
            <textarea class="t-outline-textarea" rows="3" data-mobile-scene-field="key_beats">${escapeHtml(scene.key_beats)}</textarea>
            <label>发送指令</label>
            <textarea class="t-outline-textarea" rows="3" data-mobile-scene-field="sendable_prompt">${escapeHtml(scene.sendable_prompt)}</textarea>
            <label>备注</label>
            <textarea class="t-outline-textarea" rows="2" data-mobile-scene-field="notes">${escapeHtml(scene.notes)}</textarea>
            <div class="t-mobile-scene-actions">
                <button class="t-btn t-btn-xs t-plan-delete-btn" data-action="mobile-delete-scene" data-scene-index="${sceneIndex}"><i class="fa-solid fa-trash"></i> 删除场景</button>
            </div>
        </div>
    `).join("");

    $list.html(html);
}

/**
 * 大纲/细纲两个生成流程的公共骨架：计时器、流式预览、pushHistory、解析、
 * 失败回退可编辑对话框、中断包裹、按钮态恢复。差异点由 cfg 提供。
 *
 * @param {object} cfg
 * @param {string} cfg.label           toast 标题（"故事大纲"/"故事细纲"）
 * @param {string} cfg.historyLabel    写入历史的类型标签
 * @param {string} cfg.streamingTitle  流式对话框标题
 * @param {string} cfg.doneTitle       完成时对话框标题
 * @param {string} cfg.failTitle       失败时对话框标题
 * @param {number} cfg.temperature
 * @param {number} cfg.maxTokens
 * @param {() => Array} cfg.buildMessages          组装 messages（同步，返回前 ctx/opening 已就绪）
 * @param {(ctx, opening) => Array} 见下方调用
 * @param {(raw: string) => object} cfg.parse      解析函数
 * @param {(parsed: object) => void} cfg.apply     应用解析结果
 * @param {string} cfg.reparseLabel   回退对话框的重解析按钮文案
 * @param {(count: number) => string} cfg.successMessage
 * @param {() => void} [cfg.beforeButtonRestore]   收尾前的钩子
 */
async function runGenerationFlow(cfg) {
    const useStream = isStreamingEnabled();
    return runOutlineGeneration(async (signal) => {
        const ctx = await getContextData();
        const opening = await ensureOpeningTextForGeneration();
        const messages = cfg.buildMessages(ctx, opening);

        startResponseTimer(true);
        if (useStream) {
            lastRawResponse = "";
            ensureRawDialogForStreaming(cfg.streamingTitle);
        }

        const raw = await sendOutlineRequest(messages, {
            stream: useStream,
            temperature: cfg.temperature,
            maxTokens: cfg.maxTokens,
            signal,
            onProgress: useStream ? (partial) => {
                lastRawResponse = partial || "";
                updateRawPreview(cfg.streamingTitle);
            } : undefined
        });

        lastRawResponse = raw || lastRawResponse || "";
        pushRawResponseHistory(lastRawResponse, cfg.historyLabel);
        if (useStream) updateRawPreview(cfg.doneTitle);

        try {
            cfg.apply(cfg.parse(raw));
        } catch (parseError) {
            showRawResponseDialog(lastRawResponse || raw || "", {
                title: cfg.failTitle,
                editable: true,
                parseButtonLabel: cfg.reparseLabel,
                parseHint: "你可以直接修正 JSON 后点击按钮重新解析，无需重新请求模型。",
                parseAction: async (editedText) => {
                    cfg.apply(cfg.parse(editedText));
                    if (window.toastr) toastr.success(cfg.successMessage(outlineItems.length, true), cfg.label);
                }
            });
            throw parseError;
        }

        if (window.toastr) toastr.success(cfg.successMessage(outlineItems.length, false), cfg.label);
    }, { timeoutSec: cfg.timeoutSec });
}

async function generateAllScenes() {
    if (!ensureEditingPlanContext()) return;
    if (!Array.isArray(outlineItems) || outlineItems.length === 0) {
        if (window.toastr) toastr.warning("请先生成或填写总纲", "故事细纲");
        return;
    }

    const $buttons = $("#t-outline-generate-all-scenes");
    const originTexts = [];
    $buttons.each(function () {
        originTexts.push($(this).html());
        $(this).prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
    });

    try {
        const storyInput = ($("#t-outline-story-input").val() || "").trim();
        const params = getOutlineGenParams().scenes;
        await runGenerationFlow({
            label: "故事细纲",
            historyLabel: "细纲生成",
            streamingTitle: "流式生成细纲中...",
            doneTitle: "细纲生成完成",
            failTitle: "细纲解析失败 - 可手动修复",
            temperature: params.temperature,
            maxTokens: params.maxTokens,
            timeoutSec: params.timeoutSec,
            buildMessages: (ctx, opening) => buildAllScenesPrompt(ctx, storyInput, opening),
            parse: parseAllScenesResponse,
            apply: applyParsedScenes,
            reparseLabel: "重新解析细纲并应用",
            successMessage: (count, fixed) => fixed
                ? `修复成功，已应用 ${count} 条情节细纲`
                : `已一次性生成 ${count} 条情节的细纲`
        });
    } catch (e) {
        reportGenerationError(e, "故事细纲", "批量细纲生成失败");
    } finally {
        stopResponseTimer();
        $buttons.each(function (idx) {
            $(this).prop("disabled", false).html(originTexts[idx] || '<i class="fa-solid fa-wand-magic-sparkles"></i>');
        });
    }
}

// 渐进续写：结合大纲(终点)+最近正文，生成"接下来 1~2 个场景"，并推进进度指针。
async function generateNextRolling() {
    if (!ensureEditingPlanContext()) return;
    if (!Array.isArray(outlineItems) || outlineItems.length === 0) {
        if (window.toastr) toastr.warning("请先生成或填写总纲，再渐进续写", "渐进续写");
        return;
    }

    const plan = getPlans().find(p => p.id === editingPlanId);
    const progress = getPlanProgress(plan);
    if (progress.reachedEnding) {
        if (window.toastr) toastr.info("已抵达结局。如需重写，可在进度条手动回退。", "渐进续写");
        return;
    }

    const $btn = $("#t-outline-generate-next");
    const originHtml = $btn.html();
    $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 续写中...');

    const total = outlineItems.length;
    const currentItem = outlineItems[progress.itemIndex];
    const progressHint = `当前推进到第 ${progress.itemIndex + 1}/${total} 条大纲（${currentItem?.title || "未命名"}）。距结局还有 ${total - 1 - progress.itemIndex} 条。请只推进一小步。`;

    let outcome = { appended: 0, reachedEnding: false, note: "" };

    try {
        // 面板迁到细纲窗口后可能独立于主窗口打开：故事指令优先取输入框，主窗口不在时退回方案 instruction。
        const $storyInput = $("#t-outline-story-input");
        const storyInput = ($storyInput.length > 0
            ? $storyInput.val() || ""
            : getPlanInstruction(getPlans().find(p => p.id === editingPlanId))).trim();
        const params = getOutlineGenParams().scenes;
        await runGenerationFlow({
            label: "渐进续写",
            historyLabel: "渐进续写",
            streamingTitle: "流式渐进续写中...",
            doneTitle: "渐进续写完成",
            failTitle: "渐进续写解析失败 - 可手动修复",
            temperature: params.temperature,
            maxTokens: params.maxTokens,
            timeoutSec: params.timeoutSec,
            buildMessages: (ctx, opening) => buildRollingPrompt(ctx, storyInput, opening, progressHint),
            parse: parseRollingResponse,
            apply: (parsed) => {
                const res = appendRollingScenes(parsed, progress.itemIndex);
                // 进度推进：优先用模型回报的 current_item_index（1-based → 0-based），
                // 缺失则退回"追加落到的最后一条"，再退回原指针。
                let nextIdx = progress.itemIndex;
                const reported = parsed?.progress?.currentItemIndex;
                if (Number.isFinite(reported)) {
                    nextIdx = Math.min(Math.max(reported - 1, 0), total - 1);
                } else if (res.lastTouchedIdx >= 0) {
                    nextIdx = res.lastTouchedIdx;
                }
                const reachedEnding = parsed?.progress?.reachedEnding === true
                    || (nextIdx >= total - 1 && parsed?.progress?.reachedEnding === true);
                setPlanProgress(editingPlanId, { itemIndex: nextIdx, reachedEnding });
                if (editingPlanId) setEditingPlan(getPlans().find(p => p.id === editingPlanId));
                outcome = { appended: res.appended, reachedEnding, note: parsed?.progress?.note || "" };
                refreshRollingProgressUI();
                refreshSceneHubListIfOpen();
            },
            reparseLabel: "重新解析并追加",
            successMessage: () => {
                const tail = outcome.reachedEnding ? "，已抵达结局" : "";
                const note = outcome.note ? `（${outcome.note}）` : "";
                return `已续写 ${outcome.appended} 个场景${tail}${note}`;
            }
        });
    } catch (e) {
        reportGenerationError(e, "渐进续写", "渐进续写失败");
    } finally {
        stopResponseTimer();
        $btn.prop("disabled", false).html(originHtml || '<i class="fa-solid fa-forward-step"></i> 生成下一段');
        refreshRollingProgressUI();
        refreshSceneHubListIfOpen();
    }
}

async function generateOutline() {
    if (!ensureEditingPlanContext()) return;
    const $btn = $("#t-outline-generate");
    const storyInput = ($("#t-outline-story-input").val() || "").trim();
    const insertMode = $("#t-outline-insert-mode").val() || "overwrite";

    $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 生成中...');

    try {
        const params = getOutlineGenParams().outline;
        await runGenerationFlow({
            label: "故事大纲",
            historyLabel: "大纲生成",
            streamingTitle: "流式生成大纲中...",
            doneTitle: "大纲生成完成",
            failTitle: "大纲解析失败 - 可手动修复",
            temperature: params.temperature,
            maxTokens: params.maxTokens,
            timeoutSec: params.timeoutSec,
            buildMessages: (ctx, opening) => buildPrompt(ctx, storyInput, opening),
            parse: parseOutlineResponse,
            apply: (parsed) => applyParsedOutline(parsed, storyInput, insertMode),
            reparseLabel: "重新解析大纲并应用",
            successMessage: (count, fixed) => fixed
                ? `修复成功，已生成 ${count} 条大纲`
                : `已生成 ${count} 条大纲`
        });
    } catch (e) {
        reportGenerationError(e, "故事大纲", "生成失败");
    } finally {
        stopResponseTimer();
        $btn.prop("disabled", false).html('<i class="fa-solid fa-wand-magic-sparkles"></i> 大纲生成');
    }
}

function bindEvents() {
    const $overlay = $("#t-story-outline-overlay");

    $overlay.on("click", "#t-outline-save-plan", () => {
        const plan = upsertCurrentAsPlan("");
        if (plan) {
            const copyName = createDistinctPlanName(plan.name || createPlanName(getCurrentCharCardName()));
            planRenameSnapshot = copyName;
            refreshPlanNameDisplay();
        }
        renderPlanHub();
        showOutlineView("hub");
        updatePlanWorkflowUI();
        if (window.toastr) toastr.success(`已保存方案：${plan.name}`, "故事大纲");
    });

    $overlay.on("click", "#t-outline-back-hub", () => {
        if (planRenameMode) {
            cancelPlanRename();
        }
        closeDesktopEditor();
        closeMobileEditor();
        renderPlanHub();
        showOutlineView("hub");
        updatePlanWorkflowUI();
    });

    $overlay.on("click", "#t-outline-plan-rename-trigger", () => {
        setPlanRenameMode(true);
    });

    $overlay.on("click", "#t-outline-plan-rename-confirm", () => {
        confirmPlanRename();
    });

    $overlay.on("click", "#t-outline-plan-rename-cancel", () => {
        cancelPlanRename();
    });

    $overlay.on("keydown", "#t-outline-plan-name", function (e) {
        if (!planRenameMode) return;
        if (e.key === "Enter") {
            e.preventDefault();
            confirmPlanRename();
        } else if (e.key === "Escape") {
            e.preventDefault();
            cancelPlanRename();
        }
    });

    $overlay.on("click", "[data-action='select-plan']", function () {
        const planId = String($(this).data("plan-id") || "").trim();
        if (!planId) return;
        activePlanId = planId;
        setActivePlanId(activePlanId);
        renderPlanHub();
    });

    $overlay.on("click", "#t-hub-edit-plan", function () {
        const plan = getPlans().find(p => p.id === activePlanId) || getActivePlan();
        if (!plan) {
            if (window.toastr) toastr.warning("请先选择一个方案", "故事大纲");
            return;
        }
        loadPlanToEditor(plan);
        showOutlineView("editor");
        setEditorSubView("outline");
        updatePlanWorkflowUI();
    });

    $overlay.on("click", "#t-hub-create-plan", function () {
        openPlanCreationDialog();
    });

    $overlay.on("click", "#t-hub-create-branch", function () {
        const source = getPlans().find(p => p.id === activePlanId) || null;
        if (!source) {
            if (window.toastr) toastr.warning("请先选择一个方案", "故事大纲");
            return;
        }
        const created = createBranchPlanFromSource(source);
        if (!created) return;
        loadPlanToEditor(created);
        renderPlanHub();
        showOutlineView("editor");
        setEditorSubView("outline");
        updatePlanWorkflowUI();
        if (window.toastr) toastr.success(`已创建分支方案：${created.name}`, "故事大纲");
    });

    $overlay.on("click", "#t-hub-view-detail", function () {
        const plan = getPlans().find(p => p.id === activePlanId) || null;
        if (!plan) return;
        showPlanDetailDialog(plan.id);
    });

    $overlay.on("click", "#t-hub-view-instruction", function () {
        const plan = getPlans().find(p => p.id === activePlanId) || null;
        if (!plan) return;
        showPlanInstructionDialog(plan);
    });

    $overlay.on("click", "[data-action='delete-plan']", function (e) {
        e.stopPropagation();
        const planId = String($(this).data("plan-id") || "").trim();
        if (!planId) return;
        const plans = getPlans();
        const index = plans.findIndex(p => p.id === planId);
        if (index < 0) return;
        const planName = plans[index]?.name || "未命名方案";
        if (!window.confirm(`确认删除方案「${planName}」？`)) return;
        const deletingActive = activePlanId === planId;
        plans.splice(index, 1);
        delete planItemCursorMap[planId];
        if (getSceneSourcePlanId() === planId) setSceneSourcePlanId("");
        if (deletingActive || !plans.some(p => p.id === activePlanId)) {
            activePlanId = plans[0]?.id || "";
        }
        setActivePlanId(activePlanId);
        if (!activePlanId) clearEditorDraft();
        renderPlanHub();
        if (window.toastr) toastr.success(`已删除方案：${planName}`, "故事大纲");
    });

    $overlay.on("change", "[data-action='set-scene-source']", function (e) {
        e.stopPropagation();
        const planId = String($(this).data("plan-id") || "").trim();
        if (!planId) return;
        setSceneSourcePlanId(planId);
        activePlanId = planId;
        setActivePlanId(activePlanId);
        renderPlanHub();
        if (window.toastr) toastr.success("已切换细纲情节来源方案", "故事大纲");
    });

    $overlay.on("click", "[data-action='plan-item-prev']", function () {
        const dialogPlanId = String($("#t-outline-plan-detail-dialog").attr("data-plan-id") || "").trim();
        const planId = dialogPlanId || String($(this).data("plan-id") || "").trim();
        if (!planId) return;
        const total = Number($(this).closest(".t-plan-item-carousel").data("item-total")) || 0;
        movePlanItemCursor(planId, -1, total);
        updatePlanDetailDialog(planId);
        renderPlanHub();
    });

    $overlay.on("click", "[data-action='plan-item-next']", function () {
        const dialogPlanId = String($("#t-outline-plan-detail-dialog").attr("data-plan-id") || "").trim();
        const planId = dialogPlanId || String($(this).data("plan-id") || "").trim();
        if (!planId) return;
        const total = Number($(this).closest(".t-plan-item-carousel").data("item-total")) || 0;
        movePlanItemCursor(planId, 1, total);
        updatePlanDetailDialog(planId);
        renderPlanHub();
    });

    $overlay.on("touchstart", ".t-plan-item-view", function (e) {
        const touch = e.originalEvent?.touches?.[0];
        if (!touch) return;
        this.dataset.swipeStartX = String(touch.clientX);
        this.dataset.swipeStartY = String(touch.clientY);
    });

    $overlay.on("touchend", ".t-plan-item-view", function (e) {
        const touch = e.originalEvent?.changedTouches?.[0];
        const startX = Number(this.dataset.swipeStartX || NaN);
        const startY = Number(this.dataset.swipeStartY || NaN);
        delete this.dataset.swipeStartX;
        delete this.dataset.swipeStartY;
        if (!touch || Number.isNaN(startX) || Number.isNaN(startY)) return;

        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (Math.abs(dx) < 56 || Math.abs(dx) <= Math.abs(dy)) return;

        const planId = String($(this).data("plan-id") || "").trim();
        const total = Number($(this).closest(".t-plan-item-carousel").data("item-total")) || 0;
        if (!planId || total <= 0) return;
        movePlanItemCursor(planId, dx < 0 ? 1 : -1, total);
        updatePlanDetailDialog(planId);
        renderPlanHub();
    });

    $overlay.on("click", "#t-story-outline-close", () => {
        closeDesktopEditor();
        flushAutoSaveCurrentPlan();
        $("#t-story-outline-overlay").remove();
    });

    $overlay.on("click", "#t-story-outline-open-prompts", () => {
        openPromptTemplateManager();
    });

    $overlay.on("click", "#t-outline-generate", async () => {
        await generateOutline();
    });

    $overlay.on("click", "#t-outline-generate-all-scenes", async () => {
        await generateAllScenes();
    });

    $overlay.on("click", "#t-outline-add-fab", () => {
        const isOpen = $("#t-outline-add-sheet").hasClass("show");
        if (isOpen) closeAddItemSheet();
        else openAddItemSheet();
    });

    $overlay.on("click", "#t-outline-add-sheet-backdrop", () => {
        closeAddItemSheet();
    });

    $overlay.on("click", "#t-outline-add-outline-item", () => {
        appendOutlineItem();
        closeAddItemSheet();
    });

    $overlay.on("click", "#t-outline-add-scene-item", () => {
        appendSceneItem();
        closeAddItemSheet();
    });

    $overlay.on("click", "#t-outline-empty-create-first, #t-outline-mobile-create-first", () => {
        appendOutlineItem();
    });

    $overlay.on("change", "#t-outline-insert-mode", function () {
        saveDraft($("#t-outline-story-input").val(), $(this).val());
    });

    $overlay.on("input", "#t-outline-story-input", function () {
        saveDraft($(this).val(), $("#t-outline-insert-mode").val());
    });

    $overlay.on("click", "#t-outline-tbody [data-action='delete']", function () {
        const rowIndex = Number($(this).closest("tr").data("index"));
        const fallbackIndex = Number($(this).closest("tr").data("op-parent"));
        const resolvedIndex = Number.isNaN(rowIndex) ? fallbackIndex : rowIndex;
        deleteOutlineItemAt(resolvedIndex);
    });

    $overlay.on("click", "#t-outline-tbody tr[data-index]", function (e) {
        if ($(e.target).closest("button,.t-outline-input,.t-outline-textarea").length > 0) return;
        const $cell = $(e.target).closest("td[data-edit-field]");
        if ($cell.length > 0) {
            const idx = Number($(this).data("index"));
            if (Number.isNaN(idx) || !outlineItems[idx]) return;
            renderDesktopEditor(idx, String($cell.data("edit-field") || ""));
            return;
        }
        const idx = Number($(this).data("index"));
        if (Number.isNaN(idx)) return;
        selectedRowIndex = selectedRowIndex === idx ? -1 : idx;
        renderRows();
    });

    $overlay.on("click", "#t-outline-tbody [data-action='toggle-scenes']", function () {
        const rowIndex = Number($(this).closest("tr").data("index"));
        const fallbackIndex = Number($(this).closest("tr").data("op-parent"));
        const resolvedIndex = Number.isNaN(rowIndex) ? fallbackIndex : rowIndex;
        if (Number.isNaN(resolvedIndex)) return;
        sceneExpandedMap[resolvedIndex] = !sceneExpandedMap[resolvedIndex];
        renderRows();
    });

    $overlay.on("click", "#t-editor-tab-outline", () => {
        setEditorSubView("outline");
    });

    $overlay.on("click", "#t-editor-tab-scene", () => {
        setEditorSubView("scene");
        renderSceneEditorPage();
    });

    $overlay.on("click", "#t-desk-editor-close", () => {
        closeDesktopEditor();
    });

    $overlay.on("click", "#t-desk-editor-save", () => {
        saveDesktopEditor();
        if (window.toastr) toastr.success("已保存编辑", "故事大纲");
    });

    $overlay.on("input", "#t-outline-scene-editor-page [data-scene-page-field]", function () {
        const idx = getSceneEditorTargetIndex();
        if (idx < 0 || !outlineItems[idx]) return;
        const item = outlineItems[idx];
        const sceneIndex = Number($(this).closest(".t-scene-page-card").data("scene-index"));
        const field = $(this).data("scene-page-field");
        if (Number.isNaN(sceneIndex) || !item.scenes?.[sceneIndex]) return;
        item.scenes[sceneIndex][field] = $(this).val();
        saveDraft($("#t-outline-story-input").val(), $("#t-outline-insert-mode").val());
    });

    $overlay.on("click", "#t-outline-scene-editor-page [data-action='scene-page-add']", () => {
        const idx = getSceneEditorTargetIndex();
        if (idx < 0 || !outlineItems[idx]) return;
        const item = outlineItems[idx];
        if (!Array.isArray(item.scenes)) item.scenes = [];
        item.scenes.push(createEmptySceneItem(item.scenes.length + 1));
        reindexScenes(item);
        renderSceneEditorPage();
        renderRows();
        saveDraft($("#t-outline-story-input").val(), $("#t-outline-insert-mode").val());
    });

    $overlay.on("click", "#t-outline-scene-editor-page [data-action='scene-page-delete']", function () {
        const idx = getSceneEditorTargetIndex();
        if (idx < 0 || !outlineItems[idx]) return;
        const item = outlineItems[idx];
        const sceneIndex = Number($(this).data("scene-index"));
        if (Number.isNaN(sceneIndex) || !item.scenes?.[sceneIndex]) return;
        item.scenes.splice(sceneIndex, 1);
        reindexScenes(item);
        renderSceneEditorPage();
        renderRows();
        saveDraft($("#t-outline-story-input").val(), $("#t-outline-insert-mode").val());
    });

    $overlay.on("click", "#t-outline-scene-editor-page [data-action='scene-page-delete-item']", () => {
        const idx = getSceneEditorTargetIndex();
        if (idx < 0 || !outlineItems[idx]) return;
        const itemTitle = String(outlineItems[idx]?.title || "").trim() || `#${idx + 1}`;
        if (!window.confirm(`确认删除细纲条目「${itemTitle}」？`)) return;
        const deleted = deleteOutlineItemAt(idx);
        if (deleted && window.toastr) toastr.success("已删除细纲条目", "故事大纲");
    });

    $overlay.on("click", "#t-outline-scene-editor-page [data-action='scene-page-prev']", () => {
        if (sceneEditorItemIndex > 0) {
            sceneEditorItemIndex -= 1;
            renderSceneEditorPage();
        }
    });

    $overlay.on("click", "#t-outline-scene-editor-page [data-action='scene-page-next']", () => {
        if (sceneEditorItemIndex < outlineItems.length - 1) {
            sceneEditorItemIndex += 1;
            renderSceneEditorPage();
        }
    });



    $overlay.on("click", "#t-mobile-tab-outline", () => {
        setMobileEditorSubView("outline");
    });

    $overlay.on("click", "#t-mobile-tab-scene", () => {
        const index = getMobileDrawerIndex();
        setMobileEditorSubView("scene");
        if (!Number.isNaN(index)) renderMobileDrawerScenes(index);
    });

    $overlay.on("click", "#t-outline-mobile-list .t-outline-mobile-card", function () {
        const index = Number($(this).data("index"));
        if (Number.isNaN(index) || !outlineItems[index]) return;
        openMobileEditor(index);
    });



    $overlay.on("click", "#t-mobile-drawer-close", () => {
        closeMobileEditor();
    });

    $overlay.on("click", "#t-mobile-drawer-save", () => {
        saveMobileEditor();
        closeMobileEditor();
    });



    $overlay.on("click", "#t-mobile-drawer-delete", function () {
        const index = Number($("#t-outline-mobile-drawer").attr("data-index"));
        const deleted = deleteOutlineItemAt(index, { closeMobile: true });
        if (deleted && window.toastr) toastr.success("已删除细纲条目", "故事大纲");
    });

    $overlay.on("click", "#t-mobile-add-scene", function () {
        const plotIndex = getMobileDrawerIndex();
        const item = outlineItems[plotIndex];
        if (!item) return;
        if (!Array.isArray(item.scenes)) item.scenes = [];
        item.scenes.push(createEmptySceneItem(item.scenes.length + 1));
        reindexScenes(item);
        renderRows();
        renderMobileDrawerScenes(plotIndex);
        setMobileEditorSubView("scene");
        saveDraft($("#t-outline-story-input").val(), $("#t-outline-insert-mode").val());
    });

    $overlay.on("input", "#t-mobile-scenes-list [data-mobile-scene-field]", function () {
        const plotIndex = getMobileDrawerIndex();
        const item = outlineItems[plotIndex];
        if (!item || !Array.isArray(item.scenes)) return;
        const sceneIndex = Number($(this).closest(".t-mobile-scene-card").data("scene-index"));
        const field = $(this).data("mobile-scene-field");
        if (Number.isNaN(sceneIndex) || !item.scenes[sceneIndex]) return;
        item.scenes[sceneIndex][field] = $(this).val();
        saveDraft($("#t-outline-story-input").val(), $("#t-outline-insert-mode").val());
    });



    $overlay.on("click", "#t-mobile-scenes-list [data-action='mobile-delete-scene']", function () {
        const plotIndex = getMobileDrawerIndex();
        const item = outlineItems[plotIndex];
        if (!item || !Array.isArray(item.scenes)) return;
        const sceneIndex = Number($(this).data("scene-index"));
        if (Number.isNaN(sceneIndex)) return;
        item.scenes.splice(sceneIndex, 1);
        reindexScenes(item);
        renderRows();
        renderMobileDrawerScenes(plotIndex);
        saveDraft($("#t-outline-story-input").val(), $("#t-outline-insert-mode").val());
    });

}

export function openStoryOutlineWindow() {
    const plans = getPlans();

    ensureCssLoaded();
    $("#t-story-outline-overlay").remove();

    const draft = loadDraft();
    outlineItems = [];
    lastRawResponse = "";
    rawResponseHistory = loadRawResponseHistory();
    if (!lastRawResponse && rawResponseHistory[0]?.content) {
        lastRawResponse = String(rawResponseHistory[0].content || "");
    }
    responseElapsedMs = 0;
    stopResponseTimer();
    sceneExpandedMap = {};
    selectedRowIndex = -1;
    activePlanId = "";
    planItemCursorMap = {};
    setEditingPlan(null);
    editorSubView = "outline";
    sceneEditorItemIndex = -1;
    const defaultPlanName = createPlanName(getCurrentCharCardName());

    const html = `
    <div id="t-story-outline-overlay" class="t-overlay t-root">
        <div class="t-window t-story-outline-window">
            <div class="t-window-header">
                <div class="t-window-title"><i class="fa-solid fa-list-check"></i> 大纲生成</div>
                <div class="t-window-controls">
                    <div class="t-window-close" id="t-story-outline-open-prompts" title="设置" aria-label="设置"><i class="fa-solid fa-sliders"></i></div>
                    <div class="t-window-close" id="t-story-outline-close"><i class="fa-solid fa-times"></i></div>
                </div>
            </div>
            <div class="t-window-body t-outline-body">
                <div id="t-outline-top" class="t-outline-top">
                    <label class="t-outline-label">这张卡想讲什么故事（当前角色卡：${escapeHtml(getCurrentCharCardName() || "未命名角色")})</label>
                    <textarea id="t-outline-story-input" class="t-outline-story-input" rows="4" placeholder="输入故事方向、主题、冲突、想要的节奏等">${escapeHtml(draft.storyInput)}</textarea>
                    <div class="t-outline-actions">
                        <div class="t-outline-primary-actions">
                            <button id="t-outline-generate" class="t-btn t-btn-primary">
                                <i class="fa-solid fa-wand-magic-sparkles"></i> 大纲生成
                            </button>
                            <button id="t-outline-generate-all-scenes" class="t-btn" disabled>
                                <i class="fa-solid fa-clapperboard"></i> 细纲生成
                            </button>
                        </div>
                    </div>
                    <select id="t-outline-insert-mode" class="t-outline-select" style="display:none;">
                        <option value="overwrite" ${draft.insertMode === "overwrite" ? "selected" : ""}>覆盖输入框</option>
                        <option value="append" ${draft.insertMode === "append" ? "selected" : ""}>追加到输入框</option>
                    </select>
                </div>

                <div class="t-outline-nav">
                    <div class="t-outline-nav-right">
                        <div id="t-outline-plan-name-wrap" class="t-plan-name-wrap">
                            <input id="t-outline-plan-name" class="t-outline-plan-name is-readonly" placeholder="${escapeHtml(defaultPlanName)}" readonly>
                            <button id="t-outline-plan-rename-trigger" class="t-btn t-btn-xs" title="重命名"><i class="fa-solid fa-pen"></i></button>
                            <button id="t-outline-plan-rename-cancel" class="t-btn t-btn-xs" title="取消" style="display:none;"><i class="fa-solid fa-xmark"></i></button>
                            <button id="t-outline-plan-rename-confirm" class="t-btn t-btn-xs t-btn-primary" title="确认" style="display:none;"><i class="fa-solid fa-check"></i></button>
                        </div>
                        <button id="t-outline-save-plan" class="t-btn t-btn-primary"><i class="fa-solid fa-floppy-disk"></i> 保存</button>
                    </div>
                </div>

                <div id="t-outline-hub-view" class="t-outline-hub-view">
                    <div class="t-hub-toolbar">
                        <button id="t-hub-create-plan" class="t-btn t-btn-xs"><i class="fa-solid fa-plus"></i> 新建方案</button>
                        <button id="t-hub-create-branch" class="t-btn t-btn-xs"><i class="fa-solid fa-code-branch"></i> 新建分支</button>
                        <button id="t-hub-edit-plan" class="t-btn t-btn-xs t-hub-primary-action"><i class="fa-solid fa-wand-magic-sparkles"></i> 编辑&生成大纲</button>
                        <button id="t-hub-view-detail" class="t-btn t-btn-xs"><i class="fa-solid fa-list"></i> 查看情节&细纲</button>
                        <button id="t-hub-view-instruction" class="t-btn t-btn-xs"><i class="fa-solid fa-file-lines"></i> 故事指令</button>
                    </div>
                    <div id="t-outline-plan-list" class="t-outline-plan-list"></div>
                </div>

                <div id="t-outline-editor-view" class="t-outline-editor-view">
                    <div class="t-editor-tabs">
                        <button id="t-outline-back-hub" class="t-btn t-btn-xs"><i class="fa-solid fa-arrow-left"></i> 返回方案页</button>
                        <button id="t-editor-tab-outline" class="t-btn t-btn-xs active"><i class="fa-solid fa-table"></i> 大纲编辑</button>
                        <button id="t-editor-tab-scene" class="t-btn t-btn-xs"><i class="fa-solid fa-clapperboard"></i> 细纲编辑</button>
                    </div>

                    <div id="t-outline-subview-outline" class="t-outline-subview">
                        <div class="t-outline-table-wrap">
                            <table class="t-outline-table">
                                <thead>
                                    <tr>
                                        <th>序号</th>
                                        <th>时间</th>
                                        <th>标题</th>
                                        <th>情节</th>
                                        <th>伏笔</th>
                                        <th>操作</th>
                                    </tr>
                                </thead>
                                <tbody id="t-outline-tbody"></tbody>
                            </table>
                        </div>
                        <div id="t-outline-desktop-editor" class="t-outline-desktop-editor"></div>
                    </div>

                    <div id="t-outline-subview-scene" class="t-outline-subview" style="display:none;">
                        <div id="t-outline-scene-editor-page" class="t-outline-scene-editor-page"></div>
                    </div>

                    <div id="t-outline-mobile-list" class="t-outline-mobile-list"></div>
                    <div id="t-outline-mobile-drawer" class="t-outline-mobile-drawer" data-index="">
                        <div class="t-outline-mobile-drawer-head">
                            <span><i class="fa-solid fa-pen-to-square"></i> 编辑情节</span>
                            <button id="t-mobile-drawer-close" class="t-btn t-btn-xs"><i class="fa-solid fa-times"></i></button>
                        </div>
                        <div class="t-mobile-editor-tabs">
                            <button id="t-mobile-tab-outline" class="t-btn t-btn-xs active"><i class="fa-solid fa-table"></i> 大纲</button>
                            <button id="t-mobile-tab-scene" class="t-btn t-btn-xs"><i class="fa-solid fa-clapperboard"></i> 细纲</button>
                        </div>
                        <div class="t-outline-mobile-drawer-body">
                            <div id="t-mobile-outline-view">
                                <label>时间</label>
                                <input id="t-mobile-field-time" class="t-outline-input" placeholder="例如：第1天夜晚">
                                <label>标题</label>
                                <input id="t-mobile-field-title" class="t-outline-input" placeholder="例如：不速之客">
                                <label>情节</label>
                                <textarea id="t-mobile-field-plot" class="t-outline-textarea" rows="5"></textarea>
                                <label>伏笔</label>
                                <textarea id="t-mobile-field-foreshadowing" class="t-outline-textarea" rows="3"></textarea>
                            </div>
                            <div id="t-mobile-scene-view" style="display:none;">
                                <div class="t-mobile-scene-head">
                                    <span><i class="fa-solid fa-clapperboard"></i> 场景细纲（<span id="t-mobile-scene-count">0</span>）</span>
                                    <button id="t-mobile-add-scene" class="t-btn t-btn-xs"><i class="fa-solid fa-plus"></i> 新增场景</button>
                                </div>
                                <div id="t-mobile-scenes-list" class="t-mobile-scenes-list"></div>
                            </div>
                        </div>
                        <div class="t-outline-mobile-drawer-actions">
                            <button id="t-mobile-drawer-save" class="t-btn t-btn-primary"><i class="fa-solid fa-check"></i> 保存</button>
                            <button id="t-mobile-drawer-delete" class="t-btn t-plan-delete-btn"><i class="fa-solid fa-trash"></i> 删除本条</button>
                        </div>
                    </div>
                    <div id="t-outline-add-sheet-backdrop" class="t-outline-add-sheet-backdrop"></div>
                    <div id="t-outline-fab-wrap" class="t-outline-fab-wrap" aria-live="polite">
                        <button id="t-outline-add-fab" class="t-outline-add-fab" aria-expanded="false" aria-controls="t-outline-add-sheet" title="新增条目">
                            <i class="fa-solid fa-plus"></i>
                        </button>
                        <div id="t-outline-add-sheet" class="t-outline-add-sheet t-root" role="menu" aria-label="新增条目类型">
                            <button id="t-outline-add-outline-item" class="t-btn" role="menuitem"><i class="fa-solid fa-table"></i> 新增大纲条目</button>
                            <button id="t-outline-add-scene-item" class="t-btn" role="menuitem"><i class="fa-solid fa-clapperboard"></i> 新增细纲条目</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    $("body").append(html);
    const preferred = plans.find(p => p.id === getActivePlanId()) || plans[0] || null;
    if (preferred) {
        loadPlanToEditor(preferred);
    } else {
        $("#t-outline-story-input").val(draft.storyInput || "");
        renderRows();
    }
    bindEvents();
    renderPlanHub();
    showOutlineView(plans.length > 0 ? "hub" : "editor");
    syncAddFabVisibility();
    refreshOutlineOpeningSourceControls();
}
