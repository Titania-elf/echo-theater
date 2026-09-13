// src/ui/floorNav.js
//
// 楼层快捷操作：跳转 + 批量隐藏旧楼。
//
// - 跳转：入口菜单里的「回到顶楼 / 跳到最新AI回复」。顶楼在懒加载截断下往往
//   没有 DOM，靠宿主导出的 showMoreMessages() 往上补渲染到顶再 scrollIntoView。
// - 批量隐藏：每条气泡「…」操作区挂一个「隐藏到此为止」按钮，一键把该楼
//   之前（0..N-1）的旧楼全部标记 is_system（原生 /hide 同款语义：变灰、
//   不进提示词、随聊天存档落盘），再点一次恢复。
//
// 挂载模式照抄 chatInjectButton.js（事件委托 + rerenderEvents 补挂），
// 气泡按钮复用原生 mes_button 类，零新增 CSS。

import { eventSource, event_types, showMoreMessages } from "../../../../../../script.js";
import { hideChatMessageRange } from "../../../../../chats.js";
import { getExtData } from "../utils/storage.js";
import { TitaniaLogger } from "../core/logger.js";

const BTN_CLASS = "titania-floorhide-btn";

let listenersBound = false;
let refreshQueued = false;

function isEnabled() {
    return getExtData()?.floor_nav?.enabled !== false;
}

/* ------------------------------------------------------------------ *
 * 跳转
 * ------------------------------------------------------------------ */

/** 当前聊天楼层数组（无上下文时空数组兜底）。 */
function getChat() {
    try {
        const chat = SillyTavern.getContext().chat;
        return Array.isArray(chat) ? chat : [];
    } catch {
        return [];
    }
}

/**
 * 回到顶楼（第 0 楼）。
 * 楼层是懒加载的：先循环 showMoreMessages() 把顶楼渲出来，再滚动定位。
 * 安全阀：连续两批"最靠前已渲染 mesid"不下降就放弃（防异常状态下死循环）。
 */
export async function jumpToTopFloor() {
    const chat = getChat();
    if (chat.length === 0) {
        if (window.toastr) toastr.warning("当前没有聊天楼层", "Titania Echo");
        return;
    }

    let prevFirstMesId = Number($("#chat .mes").first().attr("mesid"));
    while (!document.querySelector('.mes[mesid="0"]')) {
        try {
            await showMoreMessages();
        } catch (e) {
            TitaniaLogger.warn("补渲染历史楼层失败", e?.message || String(e));
            break;
        }
        if (document.querySelector('.mes[mesid="0"]')) break;
        const nextFirstMesId = Number($("#chat .mes").first().attr("mesid"));
        // 没有更靠前的楼层可渲了仍找不到第 0 楼 —— 数据异常，止损退出
        if (!Number.isFinite(nextFirstMesId) || nextFirstMesId >= prevFirstMesId) break;
        prevFirstMesId = nextFirstMesId;
    }

    const top = document.querySelector('.mes[mesid="0"]');
    if (top) {
        top.scrollIntoView({ block: "start", behavior: "auto" });
    } else {
        if (window.toastr) toastr.warning("未能定位到顶楼", "Titania Echo");
    }
}

/** 跳到最新一条 AI 回复（底部往前第一条 !is_user 楼层）。 */
export function jumpToLatestAiFloor() {
    const chat = getChat();
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && !chat[i].is_user) {
            const el = document.querySelector(`.mes[mesid="${i}"]`);
            if (el) {
                el.scrollIntoView({ block: "start", behavior: "auto" });
                return;
            }
            // 理论上底部楼层始终已渲染；兜底滚底
            break;
        }
    }
    try {
        SillyTavern.getContext().scrollChatToBottom();
    } catch {
        $("#chat").scrollTop($("#chat")[0]?.scrollHeight || 0);
    }
}

/* ------------------------------------------------------------------ *
 * 批量隐藏：按钮挂载（模式同 chatInjectButton.js）
 * ------------------------------------------------------------------ */

function removeAllButtons() {
    document.querySelectorAll(`#chat .${BTN_CLASS}`).forEach(node => node.remove());
}

/**
 * 幂等地给每条消息挂上「隐藏到此为止」按钮。
 * ST 的聊天是懒加载的（往上翻会补渲染更多楼层），所以这个函数要能被反复调用。
 */
function refreshButtons() {
    if (!isEnabled()) {
        removeAllButtons();
        return;
    }

    const messages = document.querySelectorAll("#chat .mes");
    for (const message of messages) {
        const mesid = Number(message.getAttribute("mesid"));
        if (!Number.isFinite(mesid) || mesid <= 0) continue; // 第 0 楼没有可隐藏的前文
        const buttonArea = message.querySelector(".extraMesButtons");
        if (!buttonArea) continue;
        if (buttonArea.querySelector(`.${BTN_CLASS}`)) continue;

        const btn = document.createElement("div");
        btn.className = `mes_button ${BTN_CLASS} fa-solid fa-angles-up`;
        btn.title = "隐藏此楼以上全部旧楼（再点恢复）";
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
            TitaniaLogger.warn("楼层隐藏按钮挂载失败", e?.message || String(e));
        }
    }, delay);
}

export function refreshFloorNavButton() {
    scheduleRefreshButtons(0);
}

async function onFloorHideClick(mesid) {
    const chat = getChat();
    const range = chat.slice(0, mesid); // 0 .. mesid-1
    if (range.length === 0) return;

    const allHidden = range.every(m => m?.is_system === true);
    if (!allHidden) {
        const ok = window.confirm(
            `将隐藏第 0 ~ ${mesid - 1} 楼（共 ${mesid} 楼）。\n\n`
            + `隐藏的楼层变灰、不再进入提示词（可用原生眼睛图标单独恢复，或再点本按钮全部恢复）。\n\n确认隐藏？`
        );
        if (!ok) return;
    }

    try {
        await hideChatMessageRange(0, mesid - 1, allHidden);
        if (window.toastr) {
            toastr.success(
                allHidden ? `已恢复第 0 ~ ${mesid - 1} 楼` : `已隐藏第 0 ~ ${mesid - 1} 楼（本楼及以下不受影响）`,
                "Titania Echo"
            );
        }
    } catch (e) {
        TitaniaLogger.warn("批量隐藏失败", e?.message || String(e));
        if (window.toastr) toastr.error(`批量隐藏失败：${e?.message || String(e)}`, "Titania Echo");
    }
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */

export function initFloorNav() {
    if (listenersBound) {
        scheduleRefreshButtons(0);
        return;
    }
    listenersBound = true;

    // 点击用委托，绑一次就够，按钮节点怎么重建都不用重新绑（照 ST 自己的写法）
    $(document).on("click", `.${BTN_CLASS}`, function (event) {
        event.stopPropagation();
        const mesid = Number($(this).closest(".mes").attr("mesid"));
        if (!Number.isFinite(mesid)) return;
        void onFloorHideClick(mesid);
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

    scheduleRefreshButtons(300);
    TitaniaLogger.info("楼层快捷操作已初始化");
}
