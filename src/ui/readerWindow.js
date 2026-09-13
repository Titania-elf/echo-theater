// src/ui/readerWindow.js
//
// 小说模式：把当前聊天渲染成小说式连续正文的全屏沉浸阅读界面。
// 无头像、无人名、纯正文流；用户楼层用左侧竖线+浅色区分；
// 消息内的分隔线渲染为居中装饰符（卷分隔）。支持沉浸模式（顶栏隐藏）。
//
// 数据走 ctx.chat（全量，不受楼层懒加载影响）；正文渲染复用宿主的
// messageFormatting（markdown/代码块管线，内部已过 DOMPurify）。

import { getExtData, saveExtData } from "../utils/storage.js";
import { ensureFeatureCss } from "../utils/dom.js";

const OVERLAY_ID = "t-reader-overlay";
const ZEN_BODY_CLASS = "t-reader-zen";
const FONT_MIN = 14;
const FONT_MAX = 26;

/* ------------------------------------------------------------------ *
 * 配置读写（extData.appearance.reader，旧数据无键走默认）
 * ------------------------------------------------------------------ */

function getReaderConfig() {
    const reader = getExtData()?.appearance?.reader;
    return {
        fontSize: Number.isFinite(Number(reader?.fontSize)) ? Math.min(FONT_MAX, Math.max(FONT_MIN, Number(reader.fontSize))) : 18,
        showUser: reader?.showUser !== false,
        showHidden: reader?.showHidden === true
    };
}

function saveReaderConfig(patch) {
    const data = getExtData();
    if (!data.appearance || typeof data.appearance !== "object") data.appearance = {};
    data.appearance.reader = { ...getReaderConfig(), ...patch };
    saveExtData();
}

/* ------------------------------------------------------------------ *
 * 正文提取（纯函数，便于离线验证）
 * ------------------------------------------------------------------ */

/**
 * 楼层可见性过滤。
 * @returns {boolean} 该楼是否进入阅读流
 */
export function isFloorVisible(msg, { showUser, showHidden }) {
    if (!msg) return false;
    if (msg.is_user && !showUser) return false;
    if (msg.is_system && !showHidden) return false;
    return true;
}

/**
 * 楼层正文文本（显示优先，与 ST 的渲染规则一致 script.js:1977）。
 */
export function getFloorText(msg) {
    if (!msg) return "";
    const display = msg?.extra?.display_text;
    return String(typeof display === "string" && display ? display : (msg.mes || ""));
}

/**
 * 卷分隔检测：消息首个非空行为纯分隔线（*** / --- / —— / ___ 等
 * 三个以上重复符号）时，该楼渲染为居中装饰符而不是正文段落。
 */
export function isSeparatorFloor(text) {
    const firstLine = String(text || "").split(/\r?\n/).find(l => l.trim()) || "";
    return /^(\*{3,}|-{3,}|—{3,}|＿{3,}|_{3,}|·{3,}|={3,})$/.test(firstLine.trim());
}

/** 楼层文案的非空行计数（空消息楼不渲染）。 */
function hasContent(text) {
    return String(text || "").trim().length > 0;
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function escapeHtml(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function renderFloorHtml(msg, index) {
    const ctx = SillyTavern.getContext();
    try {
        return ctx.messageFormatting(getFloorText(msg), msg.name, msg.is_system, msg.is_user, index, {}, false);
    } catch {
        return `<p>${escapeHtml(getFloorText(msg))}</p>`;
    }
}

function buildFloors(config) {
    let chat = [];
    let charName = "";
    try {
        const ctx = SillyTavern.getContext();
        chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        charName = String(ctx?.name || "");
    } catch {
        chat = [];
    }

    const floors = [];
    chat.forEach((msg, index) => {
        if (!isFloorVisible(msg, config)) return;
        const text = getFloorText(msg);
        if (!hasContent(text)) return;
        if (isSeparatorFloor(text)) {
            floors.push({ kind: "sep" });
            return;
        }
        floors.push({ kind: "flow", isUser: msg.is_user === true, index, html: renderFloorHtml(msg, index) });
    });
    return { floors, total: chat.length, charName };
}

function renderPage(floors) {
    return floors.map((floor) => {
        if (floor.kind === "sep") return '<div class="t-reader-sep" aria-hidden="true">❖</div>';
        return `<section class="t-reader-flow${floor.isUser ? " t-reader-flow--user" : ""}">${floor.html}</section>`;
    }).join("");
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

function closeReader() {
    $(`#${OVERLAY_ID}`).remove();
    $(document).off("keydown.treader");
    $(document).off("mousemove.treader");
    $("body").removeClass(ZEN_BODY_CLASS);
}

export function openReaderWindow() {
    ensureFeatureCss("reader.css");
    closeReader();

    let config = getReaderConfig();
    let zen = false;
    let built = buildFloors(config);

    if (built.floors.length === 0) {
        if (window.toastr) toastr.warning("当前聊天没有可阅读的内容", "小说模式");
        return;
    }

    const title = `${built.charName ? escapeHtml(built.charName) + " · " : ""}${built.total} 楼`;

    const html = `
    <div id="${OVERLAY_ID}" class="t-overlay t-root t-reader-overlay" role="dialog" aria-modal="true">
        <div class="t-reader-shell">
            <div class="t-reader-topbar">
                <div class="t-reader-topbar-title"><i class="fa-solid fa-book-open"></i> ${title}</div>
                <div class="t-reader-topbar-controls">
                    <label class="t-reader-toggle" title="你扮演的角色发言（左侧竖线样式）">
                        <input type="checkbox" id="t-reader-show-user" ${config.showUser ? "checked" : ""}>
                        <span>用户楼层</span>
                    </label>
                    <label class="t-reader-toggle" title="被隐藏（不进提示词）的楼层">
                        <input type="checkbox" id="t-reader-show-hidden" ${config.showHidden ? "checked" : ""}>
                        <span>隐藏楼层</span>
                    </label>
                    <div class="t-reader-fontctl">
                        <button class="t-btn t-btn-xs" id="t-reader-font-dec" title="缩小字号"><i class="fa-solid fa-minus"></i></button>
                        <span class="t-reader-font-val" id="t-reader-font-val">${config.fontSize}px</span>
                        <button class="t-btn t-btn-xs" id="t-reader-font-inc" title="放大字号"><i class="fa-solid fa-plus"></i></button>
                    </div>
                    <button class="t-btn t-btn-xs" id="t-reader-zen" title="沉浸模式：隐藏顶栏，鼠标移到屏幕顶部唤出"><i class="fa-solid fa-book-open-reader"></i></button>
                    <button class="t-btn t-btn-xs" id="t-reader-close" title="关闭（Esc）"><i class="fa-solid fa-times"></i></button>
                </div>
            </div>
            <div class="t-reader-scroll" id="t-reader-scroll">
                <article class="t-reader-page" id="t-reader-page">
                    ${renderPage(built.floors)}
                </article>
            </div>
        </div>
    </div>`;

    $("body").append(html);
    const $overlay = $(`#${OVERLAY_ID}`);
    $overlay.css("--t-reader-font-size", `${config.fontSize}px`);

    const rerender = () => {
        built = buildFloors(config);
        $("#t-reader-page").html(renderPage(built.floors));
    };

    // —— 顶栏控件 ——
    $overlay.on("change", "#t-reader-show-user", function () {
        config = { ...config, showUser: $(this).prop("checked") === true };
        saveReaderConfig({ showUser: config.showUser });
        rerender();
    });

    $overlay.on("change", "#t-reader-show-hidden", function () {
        config = { ...config, showHidden: $(this).prop("checked") === true };
        saveReaderConfig({ showHidden: config.showHidden });
        rerender();
    });

    const applyFontSize = () => {
        $overlay.css("--t-reader-font-size", `${config.fontSize}px`);
        $("#t-reader-font-val").text(`${config.fontSize}px`);
        saveReaderConfig({ fontSize: config.fontSize });
    };
    $overlay.on("click", "#t-reader-font-dec", () => {
        if (config.fontSize <= FONT_MIN) return;
        config = { ...config, fontSize: config.fontSize - 1 };
        applyFontSize();
    });
    $overlay.on("click", "#t-reader-font-inc", () => {
        if (config.fontSize >= FONT_MAX) return;
        config = { ...config, fontSize: config.fontSize + 1 };
        applyFontSize();
    });

    // —— 沉浸模式 ——
    const setZen = (on) => {
        zen = on;
        $("body").toggleClass(ZEN_BODY_CLASS, on);
    };
    $overlay.on("click", "#t-reader-zen", () => setZen(true));
    $overlay.on("click", "#t-reader-scroll", (e) => {
        // 点正文空白处进沉浸；点链接/选择文本不触发
        if (e.target !== e.currentTarget && !$(e.target).hasClass("t-reader-page")) return;
        setZen(true);
    });

    // 顶栏唤出：沉浸态下鼠标贴近屏幕顶部显示，离开顶部区域再收起
    $(document).on("mousemove.treader", (e) => {
        if (!zen) return;
        $("body").toggleClass(ZEN_BODY_CLASS, e.clientY > 48);
    });

    // —— 关闭 ——
    $overlay.on("click", "#t-reader-close", closeReader);
    $(document).on("keydown.treader", (e) => {
        if (e.key !== "Escape") return;
        if (zen) {
            setZen(false);
            return;
        }
        closeReader();
    });

    // 打开即从顶部开始阅读
    $("#t-reader-scroll").scrollTop(0);
}
