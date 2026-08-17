// src/ui/storyOutlineWindow.js

import { getContextData } from "../core/context.js";
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

function getOutlineProfilesByMode() {
    return getOutlineCustomProfiles();
}

function resolveOutlineProfileSelection(profileId = null) {
    const profiles = getOutlineProfilesByMode();
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

async function sendOutlineRequest(messages, options = {}) {
    const profile = getOutlineActiveProfile();
    if (!profile) throw new Error("请先在设置中选择 API 方案");

    const apiUrl = normalizeApiBaseUrl(String(profile.api_url || "").trim());
    const apiKey = String(profile.api_key || "").trim();
    const model = String(options.model || profile.model || "").trim();
    const useStream = options.stream === true;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const maxTokens = Number(options.maxTokens) || 2048;
    const temperature = Number.isFinite(options.temperature) ? options.temperature : 0.7;

    if (!apiUrl) throw new Error("请先填写 API 地址");
    if (!model) throw new Error("请先选择模型");

    const endpoint = `${apiUrl}/chat/completions`;
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const requestBody = {
        model,
        messages,
        stream: useStream,
        max_tokens: maxTokens,
        temperature
    };

    const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody)
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    if (useStream) {
        if (!res.body) throw new Error("Stream Empty Body: 响应体为空");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let aggregated = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            while (true) {
                const idx = buffer.indexOf("\n");
                if (idx < 0) break;
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (!line || !line.startsWith("data:")) continue;

                const data = line.slice(5).trim();
                if (!data || data === "[DONE]") continue;

                try {
                    const json = JSON.parse(data);
                    const chunk = json?.choices?.[0]?.delta?.content || json?.choices?.[0]?.message?.content || "";
                    if (!chunk) continue;
                    aggregated += chunk;
                    if (onProgress) onProgress(aggregated);
                } catch {
                    // ignore malformed stream chunk
                }
            }
        }

        if (!aggregated.trim()) throw new Error("流式返回为空");
        return aggregated;
    }

    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content || "";
    return String(content || "");
}

function setRawWaitingAnimation(active) {
    const $anim = $("#t-outline-raw-mood");
    if ($anim.length === 0) return;
    $anim.toggleClass("is-active", !!active);
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

function formatOpeningSourceLabel(mode, sourceRef, entries) {
    if (mode === "chat_selected") {
        const selected = getOpeningFromSelectedRef(sourceRef, entries.chatEntries || []);
        if (!selected) return "未选择聊天记录";
        return `${String(sourceRef?.preview || selected).slice(0, 48)}${selected.length > 48 ? "..." : ""}`;
    }

    const cardEntries = entries.cardEntries || [];
    if (cardEntries.length === 0) return "当前角色卡无可用开场白";
    const selected = getOpeningFromCardRef(sourceRef, cardEntries);
    const fallback = selected || cardEntries[0]?.text || "";
    const prefix = selected ? "已选开场白" : "默认开场白";
    return `${prefix}：${String(sourceRef?.preview || fallback).slice(0, 48)}${fallback.length > 48 ? "..." : ""}`;
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
            <div class="t-dialog-box" style="max-width: 760px; max-height: 86vh;">
                <div class="t-dialog-header">
                    <span><i class="fa-solid fa-comment-dots"></i> 选择聊天记录参考来源</span>
                    <div class="t-dialog-close" id="t-opening-picker-close"><i class="fa-solid fa-times"></i></div>
                </div>
                <div class="t-dialog-body" style="padding: 12px;">
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
            <div class="t-dialog-box" style="max-width: 760px; max-height: 86vh;">
                <div class="t-dialog-header">
                    <span><i class="fa-solid fa-book-open"></i> 选择参考开场白</span>
                    <div class="t-dialog-close" id="t-opening-picker-close"><i class="fa-solid fa-times"></i></div>
                </div>
                <div class="t-dialog-body" style="padding: 12px;">
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
                <div class="t-dialog-box" style="max-width: 780px; max-height: 84vh;">
                    <div class="t-dialog-header">
                        <span><i class="fa-solid fa-file-lines"></i> 开场白 ${entry.openingIndex + 1} 详情</span>
                        <div class="t-dialog-close" id="t-opening-detail-close"><i class="fa-solid fa-times"></i></div>
                    </div>
                    <div class="t-dialog-body" style="padding: 12px;">
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
    return type === "scenes" ? templates.scenes : templates.outline;
}

function getUnknownPromptVars(text) {
    const known = new Set(["persona", "userDesc", "openingText", "storyInput", "outlineItemsJson"]);
    const unknown = new Set();
    String(text || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
        if (!known.has(key)) unknown.add(key);
        return _;
    });
    return Array.from(unknown);
}

function buildPromptTemplateVars(ctx, userStoryInput, openingText, outlinePayload = []) {
    return {
        persona: String(ctx?.persona || "(空)"),
        userDesc: String(ctx?.userDesc || "(空)"),
        openingText: String(openingText || "(空)"),
        storyInput: String(userStoryInput || "未填写故事方向，请结合上方设定生成"),
        outlineItemsJson: JSON.stringify(outlinePayload, null, 2)
    };
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
                                </select>
                                <button id="t-prompt-reset-current" class="t-btn t-btn-xs"><i class="fa-solid fa-rotate-left"></i> 恢复当前默认</button>
                            </div>
                            <div class="t-plan-tip" style="margin-top:8px;">可用变量：{{persona}} {{userDesc}} {{openingText}} {{storyInput}} {{outlineItemsJson}}</div>
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
        },
        profiles: mapCustomProfilesToConnectionProfiles(settingsDraft.customProfiles, "gpt-3.5-turbo"),
        activeProfileId: settingsDraft.selectedProfileId,
        profileIdPrefix: "outline_custom",
        autoFetchOnInput: false,
        autoFetchOnProfileSwitch: false,
        onChange: (nextState) => {
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

function parseOutlineResponse(raw) {
    if (!raw || typeof raw !== "string") {
        throw new Error("模型返回为空");
    }

    const attempts = [];
    attempts.push(raw.trim());

    const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (codeBlockMatch?.[1]) attempts.push(codeBlockMatch[1].trim());

    const objMatch = raw.match(/\{[\s\S]*\}/);
    if (objMatch?.[0]) attempts.push(objMatch[0].trim());

    for (const content of attempts) {
        try {
            const fixed = content.replace(/,\s*([}\]])/g, "$1");
            const data = JSON.parse(fixed);
            if (!data || !Array.isArray(data.items)) continue;
            return data;
        } catch {
            // try next
        }
    }

    throw new Error("返回格式无法解析为 JSON");
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

function createNewPlan(nameInput = "", defaultName = "") {
    const plans = getPlans();
    const planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const payload = createPlanPayloadFromEditor();
    const plan = {
        id: planId,
        name: (nameInput || "").trim() || defaultName || createPlanName(getCurrentCharCardName()),
        storyInput: payload.storyInput,
        instruction: payload.instruction,
        items: payload.items,
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

function createEmptyPlan(nameInput = "", defaultName = "") {
    const plans = getPlans();
    const planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const instruction = String($("#t-outline-story-input").val() || "").trim();
    const plan = {
        id: planId,
        name: (nameInput || "").trim() || defaultName || createPlanName(getCurrentCharCardName()),
        storyInput: instruction,
        instruction,
        items: [],
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

function createBranchPlanFromSource(sourcePlan) {
    if (!sourcePlan?.id) return null;
    const plans = getPlans();
    const now = Date.now();
    const baseName = String(sourcePlan.name || createPlanName(getCurrentCharCardName())).trim() || "未命名方案";
    let candidateName = `${baseName}（分支）`;
    let suffix = 2;
    while (plans.some(p => String(p?.name || "").trim() === candidateName)) {
        candidateName = `${baseName}（分支${suffix}）`;
        suffix += 1;
    }

    const instruction = getPlanInstruction(sourcePlan);
    const plan = {
        id: `plan_${now}_${Math.random().toString(36).slice(2, 8)}`,
        name: candidateName,
        storyInput: instruction,
        instruction,
        items: [],
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
        <div class="t-dialog-box" style="max-width: 620px; max-height: 84vh;">
            <div class="t-dialog-header">
                <span><i class="fa-solid fa-folder-plus"></i> 新建方案</span>
                <div class="t-dialog-close" id="t-create-plan-close"><i class="fa-solid fa-times"></i></div>
            </div>
            <div class="t-dialog-body" style="padding: 12px;">
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

function isSceneUsed(plan, itemIndex, sceneIndex) {
    if (!plan || !Array.isArray(plan.used_scene_keys)) return false;
    return plan.used_scene_keys.includes(getSceneUsageKey(itemIndex, sceneIndex));
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
        sceneHubSelectedKey = "";
        $overlay.remove();
        if (window.toastr) toastr.success("已发送场景到输入框", "故事大纲");
    });
}

export function openOutlineEntryDialog() {
    ensureCssLoaded();
    $("#t-outline-entry-dialog").remove();
    const hasPlans = getPlans().length > 0;

    const html = `
    <div id="t-outline-entry-dialog" class="t-dialog-overlay t-dialog-overlay--outline t-root">
        <div class="t-dialog-box" style="max-width: 420px;">
            <div class="t-dialog-header">
                <span><i class="fa-solid fa-list-check"></i> 选择入口</span>
                <div class="t-dialog-close" id="t-outline-entry-close"><i class="fa-solid fa-times"></i></div>
            </div>
            <div class="t-dialog-body" style="padding: 12px; display:grid; gap:8px;">
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
        <div class="t-dialog-box" style="max-width: 900px; max-height: 88vh;">
            <div class="t-dialog-header">
                <span><i class="fa-solid fa-folder-open"></i> <span id="t-plan-detail-dialog-title"></span></span>
                <div class="t-dialog-close" id="t-plan-detail-close"><i class="fa-solid fa-times"></i></div>
            </div>
            <div class="t-dialog-body" style="padding: 12px;">
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
        <div class="t-dialog-box" style="max-width: 780px; max-height: 82vh;">
            <div class="t-dialog-header">
                <span><i class="fa-solid fa-file-lines"></i> 故事指令 · ${escapeHtml(planName)}</span>
                <div class="t-dialog-close" id="t-plan-instruction-close"><i class="fa-solid fa-times"></i></div>
            </div>
            <div class="t-dialog-body" style="padding: 12px;">
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
        <div class="t-dialog-box" style="max-width: 820px; max-height: 82vh;">
            <div class="t-dialog-header">
                <span><i class="fa-solid fa-code"></i> ${escapeHtml(title)}</span>
                <div class="t-dialog-close" id="t-outline-raw-close"><i class="fa-solid fa-times"></i></div>
            </div>
            <div class="t-dialog-body" style="padding: 12px;">
                ${historyOptions ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;"><span style="color:#9eb4c8;white-space:nowrap;">历史记录</span><select id="t-outline-raw-history" class="t-outline-select" style="flex:1;">${historyOptions}</select></div>` : ""}
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span id="t-outline-raw-length" style="color:#8ea0b3;">长度: ${defaultContent.length} 字符</span>
                        <span id="t-outline-raw-elapsed" style="color:#8ea0b3;">耗时: ${formatElapsedDuration(getCurrentElapsedMs())}</span>
                        <span id="t-outline-raw-mood" class="t-raw-wait-anim" aria-live="polite" aria-label="模型生成中动画">
                            <span></span><span></span><span></span>
                        </span>
                    </div>
                    <div style="display:flex;gap:6px;">
                        <button id="t-outline-export-raw-history" class="t-btn t-btn-xs"><i class="fa-solid fa-file-export"></i> 导出历史</button>
                    </div>
                </div>
                ${editable ? `<textarea id="t-outline-raw-editor" class="t-outline-raw-editor">${escapeHtml(defaultContent)}</textarea>` : `<pre class="t-outline-raw-pre">${escapeHtml(defaultContent || "(空)")}</pre>`}
                ${parseHint ? `<div class="t-outline-raw-hint">${escapeHtml(parseHint)}</div>` : ""}
            </div>
            <div class="t-dialog-footer">
                ${editable ? `<button id="t-outline-raw-reparse" class="t-btn t-btn-primary">${escapeHtml(parseButtonLabel)}</button>` : ""}
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
    saveDraft(storyInput, insertMode);
}

function parseAllScenesResponse(raw) {
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
            if (data && Array.isArray(data.items)) {
                return data;
            }
        } catch {
            // continue
        }
    }

    throw new Error("细纲返回格式无法解析为 JSON（缺少 items）");
}

function buildAllScenesPrompt(ctx, userStoryInput, openingText) {
    const outlinePayload = outlineItems.map((item) => ({
        index: item.index,
        time: item.time || "",
        title: item.title || "",
        plot: item.plot || "",
        foreshadowing: item.foreshadowing || ""
    }));
    const templates = getPromptTemplates();
    const vars = buildPromptTemplateVars(ctx, userStoryInput || "(空)", openingText, outlinePayload);
    const sys = renderPromptTemplate(templates.scenes.system, vars);
    const user = renderPromptTemplate(templates.scenes.user, vars);

    return [
        { role: "system", content: sys },
        { role: "user", content: user }
    ];
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
                        <button class="t-btn t-btn-xs" data-action="delete" title="删除本行" style="color:#ff9d9d;">
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
            <button class="t-btn t-btn-xs" data-action="scene-page-delete" data-scene-index="${sceneIdx}" style="color:#ff9d9d;"><i class="fa-solid fa-trash"></i> 删除场景</button>
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
            <button class="t-btn t-btn-xs" data-action="scene-page-delete-item" style="color:#ff9d9d;"><i class="fa-solid fa-trash"></i> 删除细纲条目</button>
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
                <button class="t-btn t-btn-xs" data-action="mobile-delete-scene" data-scene-index="${sceneIndex}" style="color:#ff9d9d;"><i class="fa-solid fa-trash"></i> 删除场景</button>
            </div>
        </div>
    `).join("");

    $list.html(html);
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
        const ctx = await getContextData();
        const opening = await ensureOpeningTextForGeneration();
        const storyInput = ($("#t-outline-story-input").val() || "").trim();
        const useStream = isStreamingEnabled();
        startResponseTimer(true);
        if (useStream) {
            lastRawResponse = "";
            ensureRawDialogForStreaming("流式生成细纲中...");
        }
        const messages = buildAllScenesPrompt(ctx, storyInput, opening);
        const raw = await sendOutlineRequest(messages, {
            stream: useStream,
            temperature: 0.8,
            maxTokens: 60000,
            onProgress: useStream ? (partial) => {
                lastRawResponse = partial || "";
                updateRawPreview("流式生成细纲中...");
            } : undefined
        });

        lastRawResponse = raw || lastRawResponse || "";
        pushRawResponseHistory(lastRawResponse, "细纲生成");
        if (useStream) updateRawPreview("细纲生成完成");

        try {
            const parsed = parseAllScenesResponse(raw);
            applyParsedScenes(parsed);
        } catch (parseError) {
            showRawResponseDialog(lastRawResponse || raw || "", {
                title: "细纲解析失败 - 可手动修复",
                editable: true,
                parseButtonLabel: "重新解析细纲并应用",
                parseHint: "你可以直接修正 JSON 后点击按钮重新解析，无需重新请求模型。",
                parseAction: async (editedText) => {
                    const reparsed = parseAllScenesResponse(editedText);
                    applyParsedScenes(reparsed);
                    if (window.toastr) toastr.success(`修复成功，已应用 ${outlineItems.length} 条情节细纲`, "故事细纲");
                }
            });
            throw parseError;
        }

        if (window.toastr) toastr.success(`已一次性生成 ${outlineItems.length} 条情节的细纲`, "故事细纲");
    } catch (e) {
        console.error("Titania: 批量生成细纲失败", e);
        if (isStreamingEnabled()) updateRawPreview("细纲生成失败");
        if (window.toastr) toastr.error(e.message || "批量细纲生成失败", "故事细纲");
    } finally {
        stopResponseTimer();
        $buttons.each(function (idx) {
            $(this).prop("disabled", false).html(originTexts[idx] || '<i class="fa-solid fa-wand-magic-sparkles"></i>');
        });
    }
}

async function generateOutline() {
    if (!ensureEditingPlanContext()) return;
    const $btn = $("#t-outline-generate");
    const storyInput = ($("#t-outline-story-input").val() || "").trim();
    const insertMode = $("#t-outline-insert-mode").val() || "overwrite";

    $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 生成中...');

    try {
        const ctx = await getContextData();
        const opening = await ensureOpeningTextForGeneration();
        const useStream = isStreamingEnabled();
        startResponseTimer(true);
        if (useStream) {
            lastRawResponse = "";
            ensureRawDialogForStreaming("流式生成大纲中...");
        }
        const messages = buildPrompt(ctx, storyInput, opening);
        const raw = await sendOutlineRequest(messages, {
            stream: useStream,
            temperature: 0.4,
            maxTokens: 20000,
            onProgress: useStream ? (partial) => {
                lastRawResponse = partial || "";
                updateRawPreview("流式生成大纲中...");
            } : undefined
        });
        lastRawResponse = raw || lastRawResponse || "";
        pushRawResponseHistory(lastRawResponse, "大纲生成");
        if (useStream) updateRawPreview("大纲生成完成");

        try {
            const parsed = parseOutlineResponse(raw);
            applyParsedOutline(parsed, storyInput, insertMode);
        } catch (parseError) {
            showRawResponseDialog(lastRawResponse || raw || "", {
                title: "大纲解析失败 - 可手动修复",
                editable: true,
                parseButtonLabel: "重新解析大纲并应用",
                parseHint: "你可以直接修正 JSON 后点击按钮重新解析，无需重新请求模型。",
                parseAction: async (editedText) => {
                    const reparsed = parseOutlineResponse(editedText);
                    applyParsedOutline(reparsed, storyInput, insertMode);
                    if (window.toastr) toastr.success(`修复成功，已生成 ${outlineItems.length} 条大纲`, "故事大纲");
                }
            });
            throw parseError;
        }

        if (window.toastr) toastr.success(`已生成 ${outlineItems.length} 条大纲`, "故事大纲");
    } catch (e) {
        console.error("Titania: 设计大纲失败", e);
        if (isStreamingEnabled()) updateRawPreview("大纲生成失败");
        if (window.toastr) toastr.error(e.message || "生成失败", "故事大纲");
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
                            <button id="t-mobile-drawer-delete" class="t-btn" style="color:#ff9d9d;"><i class="fa-solid fa-trash"></i> 删除本条</button>
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
