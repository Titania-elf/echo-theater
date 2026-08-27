// src/ui/shared/logView.js
//
// 诊断日志的条目渲染。设置页（src/ui/settingsWindow.js）和调试窗
// （src/ui/debugWindow.js）各有一块日志面板，这段渲染逻辑原本是两份
// 复制粘贴的代码 —— 正是 CLAUDE.md 记着的那类事故（CSS 文件清单曾写过两份
// 并已漂移，导致开发模式下整窗无样式）。抽成一份，两边都从这里取。
//
// 为什么这个模块的规矩是「error_message 必须出现」
// ------------------------------------------------
// 旧实现用 `if (l.details.diagnostics)` 判断「这是不是一条 API 诊断日志」，
// 而 TitaniaLogger.error 的 contextData 默认值是 {} —— truthy。于是所有
// 非 API 的报错都走进诊断分支，渲染成：
//
//     [Diagnostics]: {
//       "latency": "undefinedms"
//     }
//
// （phase / status / input 三个字段是 undefined，被 JSON.stringify 丢掉，
// 只剩那个被字符串拼接救活的 latency。）error_message 和 stack_trace
// 一个字都不显示。一位 iPhone 用户的收藏搬家因此排查了很久：真正的原因
// "Load failed" 一直躺在数据里，只是没渲染出来。
//
// 所以这里判断的是**内容**而不是键是否存在，且 error_message 无论走哪条
// 分支都排在第一行。logger.js 那侧也不再挂空的 diagnostics，是第二道防线。

import { escapeHtml } from "../../utils/helpers.js";

/** 单条 detail 的显示上限。超了就截断并指向「导出日志」—— 那份是完整的 */
const MAX_DETAIL_CHARS = 1200;

function clip(text) {
    const str = String(text ?? "");
    if (str.length <= MAX_DETAIL_CHARS) return str;
    return `${str.slice(0, MAX_DETAIL_CHARS)}…（已截断，完整内容见「导出日志」）`;
}

function safeStringify(value) {
    try {
        return JSON.stringify(value, null, 2);
    } catch (e) {
        return "[无法序列化的数据]";
    }
}

/** contextData 是不是 api.js 那种网络诊断，而不是随手带的普通上下文 */
function isNetworkDiagnostics(diag) {
    return !!(diag.network || diag.phase || diag.input_stats || diag.raw_response_snippet);
}

function formatNetworkDiagnostics(diag) {
    const net = diag.network || {};
    const parts = [];

    if (diag.phase) parts.push(`阶段=${diag.phase}`);
    if (net.status) parts.push(`HTTP=${net.status}${net.statusText ? ` ${net.statusText}` : ""}`);

    // 这一行是当初那个 "undefinedms" 的出处。缺值就整项不打印，不做字符串拼接
    const latency = Number(net.latency);
    if (Number.isFinite(latency) && latency > 0) parts.push(`耗时=${latency}ms`);

    if (diag.input_stats) parts.push(`输入=${safeStringify(diag.input_stats)}`);

    const lines = [];
    if (parts.length) lines.push(`诊断: ${parts.join("  ")}`);
    if (diag.raw_response_snippet) lines.push(`响应片段: ${clip(diag.raw_response_snippet)}`);
    return lines.join("\n");
}

/**
 * 把一条日志的 details 摊成纯文本。
 * ERROR 走 logger.error()，details 形状固定（error_message / stack_trace / 可选 diagnostics）；
 * INFO 与 WARN 走 logger.add()，details 是调用方随手给的任意对象，只能整体序列化。
 * @param {*} details
 * @returns {string}
 */
function formatDetails(details) {
    if (!details) return "";
    if (typeof details !== "object") return String(details);

    const lines = [];

    if (details.error_message) lines.push(`原因: ${details.error_message}`);

    const diag = details.diagnostics;
    if (diag && typeof diag === "object" && Object.keys(diag).length > 0) {
        lines.push(isNetworkDiagnostics(diag)
            ? formatNetworkDiagnostics(diag)
            : `上下文: ${clip(safeStringify(diag))}`);
    }

    // stack_trace 在 errObj 没有 .stack 时装的是 JSON.stringify(errObj)，
    // 那种情况下它才是真正有用的那一份数据（搬家中止日志的 failures 数组就在这里），
    // 所以不能因为「看起来像堆栈」就省掉。"{}" 是无内容的空壳，才可以丢
    const stack = details.stack_trace;
    if (stack && stack !== "{}" && stack !== "Unknown") {
        lines.push(`${/^[[{]/.test(String(stack).trim()) ? "详情" : "堆栈"}: ${clip(stack)}`);
    }

    // INFO / WARN 的任意对象走这里
    if (lines.length === 0) return clip(safeStringify(details));
    return lines.filter(Boolean).join("\n");
}

function entryClass(type) {
    if (type === "ERROR") return "t-log-entry-error";
    if (type === "WARN") return "t-log-entry-warn";
    return "t-log-entry-info";
}

/**
 * 渲染整个日志列表的 HTML。
 *
 * 全文转义：details 里混着用户数据（收藏标题、剧本名、服务端返回的报错正文），
 * 直接拼进 innerHTML 等于给自己开一个注入口。容器 .t-log-box 是 pre-wrap，
 * 所以换行交给 \n 就行，不用 <br>。
 *
 * @param {Array<{timestamp:string, type:string, message:string, details:*}>} logs
 * @returns {string} HTML，空列表返回空串（空状态文案由各面板自己决定）
 */
export function renderLogEntriesHtml(logs) {
    if (!Array.isArray(logs)) return "";

    return logs.map(entry => {
        const head = `[${entry.timestamp}] [${entry.type}] ${entry.message}`;
        const detail = formatDetails(entry.details);
        const text = detail ? `${head}\n${detail}` : head;
        return `<div class="${entryClass(entry.type)}">${escapeHtml(text)}</div>`;
    }).join("");
}
