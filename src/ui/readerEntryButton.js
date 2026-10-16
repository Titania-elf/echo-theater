// 最新 AI 回复的操作栏入口，直接挂在 .mes_buttons 下。
import { eventSource, event_types } from "../../../../script.js";
import { getExtData } from "../utils/storage.js";
import { isInjectedTheaterMessage } from "../core/chatInjector.js";
import { TitaniaLogger } from "../core/logger.js";

const BTN_CLASS = "titania-reader-btn";
let listenersBound = false;
let refreshQueued = false;

function isEnabled() {
    return getExtData().reader_entry?.enabled === true;
}

function getLatestAiMessage() {
    const chat = globalThis.SillyTavern?.getContext?.()?.chat;
    if (!Array.isArray(chat)) return null;
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (!message || message.is_user || message.is_system || isInjectedTheaterMessage(message)) continue;
        // 以聊天数据确定最新楼层，懒加载时不回退到较旧的已渲染消息。
        return document.querySelector(`#chat > .mes[mesid="${index}"]`);
    }
    return null;
}

function createButton() {
    const button = document.createElement("div");
    button.className = `mes_button ${BTN_CLASS} fa-solid fa-book-open-reader`;
    button.title = "全屏阅读";
    button.setAttribute("aria-label", "全屏阅读");
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");

    const openReader = async (event) => {
        event.preventDefault();
        // 在节点上拦住冒泡，避免触发酒馆的楼层选择或删除操作。
        event.stopPropagation();
        if (!isEnabled()) return;
        try {
            const { openReaderWindow } = await import("./readerWindow.js");
            if (isEnabled() && button.isConnected) openReaderWindow();
        } catch (error) {
            TitaniaLogger.warn("全屏阅读打开失败", error?.message || String(error));
            if (window.toastr) window.toastr.error("全屏阅读打开失败，请重试", "Titania Echo");
        }
    };
    button.addEventListener("click", openReader);
    button.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") void openReader(event);
    });
    return button;
}

/** 开关变化立即生效；重复刷新仍只保留最新 AI 楼层的一个按钮。 */
export function refreshReaderEntryButton() {
    const area = isEnabled() ? getLatestAiMessage()?.querySelector(".mes_buttons") : null;
    let existing = null;
    document.querySelectorAll(`#chat .${BTN_CLASS}`).forEach(button => {
        if (area && button.parentElement === area && !existing) existing = button;
        else button.remove();
    });
    if (area && !existing) area.appendChild(createButton());
}

function scheduleRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(() => {
        refreshQueued = false;
        refreshReaderEntryButton();
    }, 0);
}

export function initReaderEntryButton() {
    if (!listenersBound) {
        listenersBound = true;
        const events = [
            event_types.CHAT_CHANGED,
            event_types.CHARACTER_MESSAGE_RENDERED,
            event_types.USER_MESSAGE_RENDERED,
            event_types.MESSAGE_UPDATED,
            event_types.MESSAGE_SWIPED,
            event_types.MESSAGE_DELETED,
            event_types.MORE_MESSAGES_LOADED,
            event_types.GENERATION_ENDED,
        ];
        for (const eventName of events) {
            if (eventName) eventSource.on(eventName, scheduleRefresh);
        }
    }
    refreshReaderEntryButton();
}
