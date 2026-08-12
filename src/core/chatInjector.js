// src/core/chatInjector.js
//
// 把插件生成的小剧场内容作为一条真实消息写进 ST 的聊天。
//
// 这里刻意只依赖 { content, scriptName, ... } 这种朴素形状，不依赖 sceneHistory、
// 收藏夹或续写世系的任何内部结构，将来接新的数据源时这一侧不用改。

import {
    chat,
    chat_metadata,
    addOneMessage,
    saveChatConditional,
    reloadCurrentChat,
    eventSource,
    event_types,
    system_avatar
} from "../../../../script.js";
import { system_message_types } from "../../../system-messages.js";
import { getMessageTimeStamp } from "../../../RossAscends-mods.js";
import { extractTextByWhitelist } from "../utils/chatTagWhitelist.js";
import { getExtData } from "../utils/storage.js";
import { TitaniaLogger } from "./logger.js";

/** 标记键：用于识别「这条消息是插件注入的小剧场」。 */
export const INJECT_MARKER_KEY = "titania_theater";

export function getChatInjectConfig() {
    const data = getExtData();
    const cfg = data?.chat_inject && typeof data.chat_inject === "object" ? data.chat_inject : {};
    return {
        enabled: cfg.enabled !== false,
        visibleToAI: cfg.visible_to_ai !== false,
        speakerName: String(cfg.speaker_name || "").trim() || "回声小剧场"
    };
}

/** 这条消息是不是插件注入的小剧场。 */
export function isInjectedTheaterMessage(message) {
    return Boolean(message?.extra?.[INJECT_MARKER_KEY]);
}

/**
 * 把小剧场 HTML 规范化成 ST 消息能安全承载的形式。
 *
 * ST 的样式保护流程是 encodeStyleTags → DOMPurify → decodeStyleTags（script.js:1772），
 * decodeStyleTags 会把选择器加上 `.mes_text ` 作用域前缀、并把 `.foo` 改写成 `.custom-foo`，
 * 与 DOMPurify 对 class 属性的改写一致，所以基于 class 的 CSS 能正常生效。
 *
 * 但 encodeStyleTags 的正则是 /<style>(.+?)<\/style>/gims —— 只认不带属性的 style 标签。
 * `<style type="text/css">` 不会被保护，最终会被丢弃或逃出作用域，所以必须先抹掉属性。
 *
 * @param {string} html
 * @returns {string}
 */
export function normalizeTheaterHtmlForChat(html) {
    let out = String(html || "");
    if (!out.trim()) return "";

    // 丢弃脚本：DOMPurify 也会清，但提前去掉可以避免它们混进后面的补闭合判断
    out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    out = out.replace(/<script\b[^>]*\/?>/gi, "");

    // 丢弃整份文档外壳。输出契约（promptManager.js:20）已要求不输出外壳，但模型会违约。
    // 顺序要紧：成对的 <title>…</title> 必须先整块删掉，否则下面那条会先吃掉开标签，
    // 留下裸标题文字和一个孤立的 </title>。
    out = out.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "");
    out = out.replace(/<\/?(?:html|head|body)\b[^>]*>/gi, "");
    // link/meta/base 是真正的空标签；title 在这里只可能是未闭合的残留
    out = out.replace(/<(?:link|meta|base|title)\b[^>]*>/gi, "");
    out = out.replace(/<\/title\s*>/gi, "");

    // 关键一步：<style type="text/css"> → <style>
    out = out.replace(/<style\b[^>]*>/gi, "<style>");

    // 补齐未闭合的 style 块。少了 </style> 的话 encodeStyleTags 匹配不到，
    // 整段 CSS 会作为裸文本显示在气泡里。
    const openCount = (out.match(/<style>/gi) || []).length;
    const closeCount = (out.match(/<\/style>/gi) || []).length;
    if (openCount > closeCount) {
        out += "</style>".repeat(openCount - closeCount);
    }

    return out.trim();
}

/** 常见 HTML 实体 → 字面字符。提示词里留着 `&amp;` / `&nbsp;` 只会干扰模型。 */
const HTML_ENTITIES = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&hellip;": "…",
    "&mdash;": "—",
    "&ndash;": "–",
    "&ldquo;": "“",
    "&rdquo;": "”",
    "&lsquo;": "‘",
    "&rsquo;": "’"
};

function decodeHtmlEntities(text) {
    let out = String(text || "");
    for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
        out = out.replace(new RegExp(entity, "gi"), char);
    }
    // 数字实体
    out = out.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
    out = out.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
    return out;
}

/**
 * 提取发给模型的纯文本。
 *
 * 直接剥标签会把段落黏成一坨（`<p>甲</p><p>乙</p>` → `甲乙`），所以先把块级边界
 * 换成换行，再交给 outline / rewrite 两个功能已在用的提取器（utils/chatTagWhitelist.js）
 * 做最终的标签清除，最后解实体。
 *
 * @param {string} html
 * @returns {string}
 */
export function buildPromptTextFromTheater(html) {
    let text = String(html || "");
    if (!text.trim()) return "";

    // style / script 的标签会被剥掉，但里面的 CSS/JS 正文会留下来，必须整块删。
    // <title> 同理：它的文字不属于剧场正文，不该进提示词。
    text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n");
    text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n");
    text = text.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "\n");

    // 块级边界换成换行，保住段落结构
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/(?:p|div|section|article|header|footer|blockquote|li|tr|h[1-6]|figcaption|pre)\s*>/gi, "\n");
    text = text.replace(/<hr\s*\/?>/gi, "\n");
    // 表格单元格之间用空格隔开，否则数字会连在一起
    text = text.replace(/<\/(?:td|th)\s*>/gi, " ");

    // 复用既有提取器完成剩余标签清除（传空白名单 = 剥掉全部标签）
    text = extractTextByWhitelist(text, []);
    text = decodeHtmlEntities(text);

    return text
        .split("\n")
        .map(line => line.replace(/[ \t ]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * 注入一段小剧场内容到当前聊天。
 *
 * @param {object} options
 * @param {string} options.content 小剧场原始 HTML
 * @param {number} options.insertAfterIndex 插到这条消息的下方；传 chat.length - 1 即追加到末尾
 * @param {string} [options.scriptId]
 * @param {string} [options.scriptName]
 * @param {string} [options.generationId]
 * @param {boolean} [options.visibleToAI] 是否让模型看见；缺省读配置
 * @returns {Promise<{messageId: number, appended: boolean}|null>}
 */
export async function injectTheaterToChat(options = {}) {
    const cfg = getChatInjectConfig();
    const rawContent = String(options.content || "");
    const displayHtml = normalizeTheaterHtmlForChat(rawContent);
    const promptText = buildPromptTextFromTheater(rawContent);

    if (!displayHtml && !promptText) {
        if (window.toastr) toastr.warning("小剧场内容为空，无法注入", "Titania Echo");
        return null;
    }

    if (!Array.isArray(chat)) {
        TitaniaLogger.error("注入失败：ST 聊天数组不可用");
        if (window.toastr) toastr.error("当前没有打开的聊天，无法注入", "Titania Echo");
        return null;
    }

    const visibleToAI = options.visibleToAI === undefined ? cfg.visibleToAI : options.visibleToAI === true;
    const scriptName = String(options.scriptName || "").trim() || "场景";

    const message = {
        name: cfg.speakerName,
        is_user: false,
        // is_system 为 true 时不进提示词。ST 气泡上的眼睛图标（chats.js:2115）之后可随时翻转。
        is_system: !visibleToAI,
        send_date: getMessageTimeStamp(),
        // mes 是发给模型的内容，display_text 才是界面显示的内容（script.js:2377）
        mes: promptText,
        force_avatar: system_avatar,
        extra: {
            // narrator 类型：对 Chat Completion 映射成 role:'system'（openai.js:528），
            // 文本补全时不加名字前缀（script.js:5444）
            type: system_message_types.NARRATOR,
            display_text: displayHtml,
            api: "manual",
            model: "titania-theater",
            [INJECT_MARKER_KEY]: {
                generationId: String(options.generationId || ""),
                scriptId: String(options.scriptId || ""),
                scriptName,
                injectedAt: Date.now()
            }
        }
    };

    const baseIndex = Number(options.insertAfterIndex);
    const insertAt = Number.isFinite(baseIndex) ? baseIndex + 1 : chat.length;
    const clamped = Math.max(0, Math.min(insertAt, chat.length));
    const appended = clamped >= chat.length;

    // 所有核心写入路径都会设这个标记（slash-commands.js:4584），它会抑制自动问候替换、
    // persona 自动锁定等「聊天还很干净」时才做的行为。
    chat_metadata["tainted"] = true;

    try {
        if (appended) {
            // 追加到末尾：轻量路径，不需要重渲染整个聊天
            chat.push(message);
            const messageId = chat.length - 1;
            await eventSource.emit(event_types.MESSAGE_SENT, messageId);
            addOneMessage(message);
            await eventSource.emit(event_types.USER_MESSAGE_RENDERED, messageId);
            await saveChatConditional();
            TitaniaLogger.info("小剧场已追加到聊天末尾", { messageId, scriptName, visibleToAI });
            return { messageId, appended: true };
        }

        // 插到中间：下方所有楼层的 mesid 都要重编号，只能整表重渲染。
        // 顺序照 /sys 的 at= 分支（slash-commands.js:4638-4643）：先存盘再 reload。
        chat.splice(clamped, 0, message);
        await saveChatConditional();
        await eventSource.emit(event_types.MESSAGE_SENT, clamped);
        await reloadCurrentChat();
        await eventSource.emit(event_types.USER_MESSAGE_RENDERED, clamped);
        scrollToMessage(clamped);
        TitaniaLogger.info("小剧场已插入聊天", { messageId: clamped, scriptName, visibleToAI });
        return { messageId: clamped, appended: false };
    } catch (e) {
        TitaniaLogger.error("小剧场注入聊天失败", e, { insertAt: clamped, scriptName });
        if (window.toastr) toastr.error("注入失败：" + (e?.message || String(e)), "Titania Echo");
        return null;
    }
}

/**
 * reloadCurrentChat 会把视图重置到底部，插到中间时要主动滚回插入点。
 * @param {number} messageId
 */
function scrollToMessage(messageId) {
    // reload 是异步渲染的，等一帧再找节点
    requestAnimationFrame(() => {
        const el = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
}
