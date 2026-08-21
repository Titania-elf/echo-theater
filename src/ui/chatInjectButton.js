// src/ui/chatInjectButton.js
//
// 在 ST 每条消息气泡的「…」操作菜单里挂一个入口，点开后选一段小剧场插到该楼层下方。
//
// 按钮挂在 .extraMesButtons（index.html:7058），和内置的翻译/配图/朗读同一层。

import { eventSource, event_types } from "../../../../script.js";
import { GlobalState } from "../core/state.js";
import { injectTheaterToChat, getChatInjectConfig } from "../core/chatInjector.js";
import { TitaniaLogger } from "../core/logger.js";

const BTN_CLASS = "titania-inject-btn";
const OVERLAY_ID = "t-chat-inject-overlay";

let listenersBound = false;
let refreshQueued = false;
/** 弹窗里「AI 可见」的选择在同一次会话内记住，省得每条都重新勾。 */
let lastVisibleChoice = null;

function escapeHtmlText(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function isEnabled() {
    return getChatInjectConfig().enabled;
}

/* ------------------------------------------------------------------ *
 * 按钮挂载
 * ------------------------------------------------------------------ */

function removeAllButtons() {
    document.querySelectorAll(`#chat .${BTN_CLASS}`).forEach(node => node.remove());
}

/**
 * 幂等地给每条消息挂上按钮。
 * ST 的聊天是懒加载的（往上翻会补渲染更多楼层），所以这个函数要能被反复调用。
 */
function refreshButtons() {
    if (!isEnabled()) {
        removeAllButtons();
        return;
    }

    const messages = document.querySelectorAll("#chat .mes");
    for (const message of messages) {
        const buttonArea = message.querySelector(".extraMesButtons");
        if (!buttonArea) continue;
        if (buttonArea.querySelector(`.${BTN_CLASS}`)) continue;

        const btn = document.createElement("div");
        btn.className = `mes_button ${BTN_CLASS} fa-solid fa-masks-theater`;
        btn.title = "注入小剧场到此楼下方";
        btn.setAttribute("tabindex", "0");
        buttonArea.appendChild(btn);
    }
}

function scheduleRefreshButtons(delay = 0) {
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(() => {
        refreshQueued = false;
        try {
            refreshButtons();
        } catch (e) {
            TitaniaLogger.warn("注入按钮挂载失败", e?.message || String(e));
        }
    }, delay);
}

export function refreshChatInjectButton() {
    scheduleRefreshButtons(0);
}

/* ------------------------------------------------------------------ *
 * 内容选择弹窗
 * ------------------------------------------------------------------ */

/**
 * 可注入的小剧场条目。
 * 目前只取本次会话的剧场历史（GlobalState.sceneHistory，内存态、默认 5 条）。
 * 将来接收藏夹或续写世系时，只需在这里多返回几组数据 —— injectTheaterToChat 一侧不用改。
 */
function collectInjectableItems() {
    const items = Array.isArray(GlobalState.sceneHistory?.items) ? GlobalState.sceneHistory.items : [];
    return items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => {
            const status = String(item?.status || "legacy");
            // 与收藏资格保持一致（state.js:351）：只放行生成完整的内容
            if (status !== "success" && status !== "legacy") return false;
            return String(item?.content || "").trim().length > 0;
        })
        .map(({ item, index }) => ({
            index,
            content: String(item.content || ""),
            scriptId: String(item.scriptId || ""),
            scriptName: String(item.scriptName || "场景"),
            generationId: String(item.generationId || ""),
            timestamp: Number(item.timestamp) || 0,
            preview: buildPreview(item.content)
        }));
}

/** 纯文本预览，写法沿用 continuationStore.js:277。 */
function buildPreview(content) {
    return String(content || "")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 90);
}

function formatTimestamp(ts) {
    if (!ts) return "";
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return "";
    }
}

function getOverlay() {
    return $(`#${OVERLAY_ID}`);
}

function closePicker() {
    getOverlay().remove();
    $(document).off("keydown.tchatinject");
}

function renderItemsHtml(items) {
    if (items.length === 0) {
        return `
            <div class="t-chat-inject-empty">
                <i class="fa-solid fa-masks-theater"></i>
                <div class="t-chat-inject-empty-title">本次会话还没有生成小剧场</div>
                <div class="t-chat-inject-empty-hint">
                    剧场历史只保留在内存中，刷新页面就会清空。先用悬浮球生成一段小剧场，再回来注入。
                </div>
            </div>`;
    }

    return items.map(item => `
        <div class="t-chat-inject-item" data-index="${item.index}">
            <div class="t-chat-inject-item-head">
                <span class="t-chat-inject-item-name">${escapeHtmlText(item.scriptName)}</span>
                <span class="t-chat-inject-item-time">${escapeHtmlText(formatTimestamp(item.timestamp))}</span>
            </div>
            <div class="t-chat-inject-item-preview">${escapeHtmlText(item.preview) || "（无文本内容）"}</div>
        </div>
    `).join("");
}

/**
 * 打开选择弹窗。
 * @param {number} mesid 被点击的楼层索引；内容会插到它的下方
 */
export function openInjectPickerWindow(mesid) {
    closePicker();

    const cfg = getChatInjectConfig();
    const items = collectInjectableItems();
    const visibleDefault = lastVisibleChoice === null ? cfg.visibleToAI : lastVisibleChoice;
    const floorLabel = Number.isFinite(mesid) ? `第 ${mesid} 楼` : "当前楼层";

    const html = `
    <div id="${OVERLAY_ID}" class="t-overlay t-root" aria-modal="true" role="dialog">
        <div class="t-window t-chat-inject-window">
            <div class="t-window-header">
                <div class="t-window-title">
                    <i class="fa-solid fa-masks-theater"></i> 注入小剧场
                </div>
                <div class="t-window-controls">
                    <div class="t-window-close" id="t-chat-inject-close"><i class="fa-solid fa-times"></i></div>
                </div>
            </div>

            <div class="t-chat-inject-body">
                <div class="t-chat-inject-target">
                    将插入到 <b>${escapeHtmlText(floorLabel)}</b> 的下方
                </div>

                <label class="t-chat-inject-visible">
                    <input type="checkbox" id="t-chat-inject-visible" ${visibleDefault ? "checked" : ""} />
                    <span>
                        <span class="t-chat-inject-visible-main">让 AI 看到这段内容</span>
                        <small>勾选后小剧场成为剧情正史，会进入后续提示词。注入后仍可用气泡上的眼睛图标随时切换。</small>
                    </span>
                </label>

                <div class="t-chat-inject-list">
                    ${renderItemsHtml(items)}
                </div>
            </div>
        </div>
    </div>`;

    $("body").append(html);

    const $overlay = getOverlay();

    $overlay.on("click", "#t-chat-inject-close", closePicker);
    // 点遮罩空白处关闭，但点窗口内部不关
    $overlay.on("click", event => {
        if (event.target === $overlay[0]) closePicker();
    });
    $(document).on("keydown.tchatinject", event => {
        if (event.key === "Escape") closePicker();
    });

    $overlay.on("click", "#t-chat-inject-visible", event => {
        lastVisibleChoice = $(event.currentTarget).prop("checked") === true;
    });

    $overlay.on("click", ".t-chat-inject-item", async function () {
        const index = Number($(this).data("index"));
        const target = items.find(item => item.index === index);
        if (!target) return;

        const visibleToAI = $overlay.find("#t-chat-inject-visible").prop("checked") === true;
        lastVisibleChoice = visibleToAI;

        // 先关弹窗：中间插入会走 reloadCurrentChat，留着遮罩会盖住滚动定位的结果
        closePicker();

        const result = await injectTheaterToChat({
            content: target.content,
            scriptId: target.scriptId,
            scriptName: target.scriptName,
            generationId: target.generationId,
            insertAfterIndex: mesid,
            visibleToAI
        });

        if (result && window.toastr) {
            const visibilityNote = visibleToAI ? "AI 可见" : "AI 不可见";
            toastr.success(`已注入「${target.scriptName}」（${visibilityNote}）`, "Titania Echo");
        }
    });
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */

export function initChatInjectButton() {
    if (listenersBound) {
        scheduleRefreshButtons(0);
        return;
    }
    listenersBound = true;

    // 点击用委托，绑一次就够，按钮节点怎么重建都不用重新绑（照 ST 自己的写法 chats.js:2115）
    $(document).on("click", `.${BTN_CLASS}`, function (event) {
        event.stopPropagation();
        const mesid = Number($(this).closest(".mes").attr("mesid"));
        if (!Number.isFinite(mesid)) {
            if (window.toastr) toastr.warning("无法识别当前楼层", "Titania Echo");
            return;
        }
        openInjectPickerWindow(mesid);
    });

    // 挂载时机：任何会新增/重排消息节点的事件都要补挂。
    // MORE_MESSAGES_LOADED 尤其重要 —— ST 往上翻页是懒加载的。
    const rerenderEvents = [
        event_types.CHAT_CHANGED,
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_DELETED,
        event_types.MORE_MESSAGES_LOADED
    ];
    for (const eventName of rerenderEvents) {
        if (!eventName) continue;
        eventSource.on(eventName, () => scheduleRefreshButtons(0));
    }

    // 首屏：此时聊天可能还没渲染完，稍等一下
    scheduleRefreshButtons(300);

    TitaniaLogger.info("小剧场注入入口已初始化");
}
