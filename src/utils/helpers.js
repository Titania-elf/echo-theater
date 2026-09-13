// src/utils/helpers.js

import { getExtData } from "./storage.js";
import { parseChatHistoryBlacklistInput, removeChatHistoryBlacklist } from "./chatHistoryBlacklist.js";

/**
 * 检测 HTML 内容是否包含互动代码
 * @param {string} html - HTML 内容
 * @returns {{ isInteractive: boolean, reasons: string[] }}
 */
export function detectInteractiveContent(html) {
    if (!html) return { isInteractive: false, reasons: [] };

    const reasons = [];

    // 1. 检测 <script> 标签
    if (/<script[\s>]/i.test(html)) {
        reasons.push("包含 <script> 标签");
    }

    // 2. 检测内联事件处理器
    const eventHandlers = [
        'onclick', 'ondblclick', 'onmousedown', 'onmouseup', 'onmouseover',
        'onmouseout', 'onmousemove', 'onmouseenter', 'onmouseleave',
        'onkeydown', 'onkeyup', 'onkeypress',
        'onchange', 'oninput', 'onsubmit', 'onreset', 'onfocus', 'onblur',
        'onload', 'onerror', 'onscroll', 'onresize',
        'ontouchstart', 'ontouchmove', 'ontouchend', 'ontouchcancel'
    ];
    const eventPattern = new RegExp(`\\s(${eventHandlers.join('|')})\\s*=`, 'i');
    if (eventPattern.test(html)) {
        reasons.push("包含事件处理器属性");
    }

    // 3. 检测表单交互元素（button 和 input 可能需要 JS 才能正常工作）
    // 注意：纯展示的按钮不算互动，但 type="submit" 或有 onclick 的才算
    if (/<button[^>]*onclick/i.test(html) || /<input[^>]*type\s*=\s*["']?(button|submit)/i.test(html)) {
        reasons.push("包含交互式按钮");
    }

    // 4. 检测 JavaScript 伪协议
    if (/javascript:/i.test(html)) {
        reasons.push("包含 javascript: 协议");
    }

    // 5. 检测 <form> 标签（表单通常需要 JS 处理）
    if (/<form[\s>]/i.test(html) && /<input[\s>]/i.test(html)) {
        reasons.push("包含表单元素");
    }

    return {
        isInteractive: reasons.length > 0,
        reasons
    };
}

/**
 * 构建完整的 HTML 文档（用于新窗口/导出）
 * @param {string} content - HTML 内容片段
 * @param {string} title - 文档标题
 * @returns {string} 完整的 HTML 文档
 */
export function buildFullHtmlDocument(content, title = "Titania Echo - 互动场景") {
    // 提取内容中的 <style> 标签
    const styleMatch = content.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    const styles = styleMatch ? styleMatch.join('\n') : '';
    const bodyContent = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').trim();

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>
        /* 基础样式 */
        * { box-sizing: border-box; }
        html, body {
            margin: 0;
            padding: 0;
            background: #0a0a0a;
            color: #e0e0e0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            font-size: 16px;
            line-height: 1.6;
            min-height: 100vh;
        }
        body {
            padding: 20px;
        }
        a { color: #90cdf4; }
        img, video { max-width: 100%; height: auto; }
        
        /* 用户自定义样式 */
    </style>
    ${styles}
</head>
<body>
${bodyContent}
</body>
</html>`;
}

/**
 * HTML 转义（用于安全插入标题等）
 *
 * 已导出：src/ui/shared/logView.js 与 src/entry.js 要往界面上打服务端返回的报错
 * 和用户数据（收藏标题等），必须转义。别再复制新的私有实现 ——
 * debugWindow.js / favsWindow.js / chatInjectButton.js / extensionUpdate.js
 * 里各有一份早于本次改动的同名副本，新代码统一用这个。
 *
 * 入参刻意不限定字符串：调用方常直接把 err.message、数字或 undefined 递进来。
 * @param {*} str - 原始值
 * @returns {string} 转义后的字符串
 */
export function escapeHtml(str) {
    if (str === null || str === undefined || str === '') return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * 在新窗口中打开 HTML 内容
 * @param {string} html - HTML 内容
 * @param {string} scriptName - 剧本名称（用于窗口标题）
 * @returns {Window|null} 新窗口引用
 */
export function openInNewWindow(html, scriptName = "互动场景") {
    console.log('[Titania] openInNewWindow 被调用，原始HTML长度:', html?.length || 0);
    const fullHtml = buildFullHtmlDocument(html, `${scriptName} - Titania Echo`);
    console.log('[Titania] 构建后完整HTML长度:', fullHtml?.length || 0);
    console.log('[Titania] 完整HTML前500字符:', fullHtml?.substring(0, 500));
    const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const newWindow = window.open(
        url,
        '_blank',
        'width=900,height=700,menubar=no,toolbar=no,location=no,status=no,scrollbars=yes,resizable=yes'
    );

    // 窗口打开后释放 URL（延迟执行，确保内容已加载）
    if (newWindow) {
        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 1000);
    } else {
        // 弹窗被拦截，尝试使用新标签页
        console.warn('Titania: 弹窗被拦截，尝试新标签页');
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    return newWindow;
}

/**
 * 导出 HTML 内容为文件
 * @param {string} html - HTML 内容
 * @param {string} scriptName - 剧本名称（用于文件名）
 */
export function exportAsHtmlFile(html, scriptName = "场景") {
    console.log('[Titania] exportAsHtmlFile 被调用，原始HTML长度:', html?.length || 0);
    const fullHtml = buildFullHtmlDocument(html, `${scriptName} - Titania Echo`);
    console.log('[Titania] 构建后完整HTML长度:', fullHtml?.length || 0);
    const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    // 清理文件名（移除非法字符）
    const safeFileName = scriptName
        .replace(/[<>:"/\\|?*]/g, '_')  // Windows 非法字符
        .replace(/\s+/g, '_')            // 空格替换为下划线
        .substring(0, 50);               // 限制长度

    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeFileName}_互动场景.html`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(() => URL.revokeObjectURL(url), 100);
}

/**
 * 构建 Shadow DOM 内部的字体样式
 * @returns {{ fontImport: string, forceOverride: boolean, fontFamily: string }} - 字体样式信息
 */
function buildFontStylesForShadowDOM() {
    try {
        const extData = getExtData();
        const fontSettings = extData.font_settings;

        if (!fontSettings || fontSettings.source === 'default' || !fontSettings.source) {
            return { fontImport: '', forceOverride: false, fontFamily: '' };
        }

        const forceOverride = fontSettings.force_override === true;

        if (fontSettings.source === 'online' && fontSettings.import_url && fontSettings.font_name) {
            // 在线字体：注入 @import
            return {
                fontImport: `@import url('${fontSettings.import_url}');`,
                forceOverride,
                fontFamily: `'${fontSettings.font_name}'`
            };
        }

        if (fontSettings.source === 'upload' && fontSettings.font_data) {
            // 上传字体：注入 @font-face
            const fontName = fontSettings.font_name || 'TitaniaCustomFont';
            return {
                fontImport: `
                    @font-face {
                        font-family: '${fontName}';
                        src: url('${fontSettings.font_data}') format('woff2');
                        font-weight: normal;
                        font-style: normal;
                        font-display: swap;
                    }
                `,
                forceOverride,
                fontFamily: `'${fontName}'`
            };
        }

        return { fontImport: '', forceOverride: false, fontFamily: '' };
    } catch (e) {
        console.warn('Titania: 构建 Shadow DOM 字体样式失败', e);
        return { fontImport: '', forceOverride: false, fontFamily: '' };
    }
}

/**
 * 将 HTML 内容渲染到 Shadow DOM 中，实现 CSS 隔离
 * @param {HTMLElement} container - 目标容器元素
 * @param {string} html - 要渲染的 HTML 内容
 * @returns {ShadowRoot} - 返回 Shadow Root 引用
 */
export function renderToShadowDOMReal(container, html) {
    // 清空容器
    container.innerHTML = '';

    // 创建宿主元素
    const host = document.createElement('div');
    host.className = 't-shadow-host';
    host.style.cssText = 'width:100%; min-height:100%;';

    // 创建 Shadow DOM
    const shadow = host.attachShadow({ mode: 'open' });

    const isEditableNode = (node) => {
        if (!(node instanceof HTMLElement)) return false;

        const tag = node.tagName.toLowerCase();
        if (tag === 'textarea') {
            return !node.hasAttribute('readonly') && !node.hasAttribute('disabled');
        }

        if (tag === 'input') {
            const type = String(node.getAttribute('type') || 'text').toLowerCase();
            const editableTypes = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);
            return editableTypes.has(type) && !node.hasAttribute('readonly') && !node.hasAttribute('disabled');
        }

        return node.isContentEditable === true;
    };

    const stopEditableKeyboardBubble = (evt) => {
        const path = typeof evt.composedPath === 'function' ? evt.composedPath() : [evt.target];
        const hasEditableTarget = path.some(node => isEditableNode(node));
        if (!hasEditableTarget) return;

        // 阻止编辑区按键冒泡到外层全局快捷键，避免输入法上屏被拦截
        evt.stopPropagation();
    };

    [
        'keydown',
        'keypress',
        'keyup',
        'beforeinput',
        'input',
        'paste',
        'compositionstart',
        'compositionupdate',
        'compositionend'
    ].forEach((type) => {
        shadow.addEventListener(type, stopEditableKeyboardBubble, true);
    });

    // 构建字体样式（在 Shadow DOM 内部注入，确保字体定义可用）
    const fontInfo = buildFontStylesForShadowDOM();

    // 构建强制覆盖样式（如果启用）
    // 使用 * 选择器 + !important 覆盖所有内联 font-family
    const forceOverrideStyles = fontInfo.forceOverride && fontInfo.fontFamily
        ? `
            /* 强制覆盖内联字体样式 */
            .t-shadow-content * {
                font-family: ${fontInfo.fontFamily}, var(--t-font-global, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif) !important;
            }
            /* 保留等宽字体元素 */
            .t-shadow-content code,
            .t-shadow-content pre,
            .t-shadow-content kbd,
            .t-shadow-content samp {
                font-family: 'Consolas', 'Monaco', 'Courier New', monospace !important;
            }
        `
        : '';

    // 基础样式（在 Shadow DOM 内部）
    // 使用 CSS 变量穿透，继承外部设置的字体
    const baseStyles = `
        <style>
            ${fontInfo.fontImport}
            :host {
                display: block;
                width: 100%;
                min-height: 100%;
            }
            * { box-sizing: border-box; }
            :host, .t-shadow-content {
                background: transparent;
                color: #e0e0e0;
                font-family: var(--t-font-global, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
                font-size: 14px;
                line-height: 1.6;
            }
            /* 内容区保持固定字号，不受 UI 缩放变量影响 */
            .t-shadow-content,
            .t-shadow-content * {
                font-size: 14px;
            }
            .t-shadow-content {
                padding: 0;
                min-height: 100%;
            }
            img, video { max-width: 100%; height: auto; }
            a { color: #90cdf4; }
            ${forceOverrideStyles}
        </style>
    `;

    // 包装内容
    shadow.innerHTML = baseStyles + `<div class="t-shadow-content">${html}</div>`;

    container.appendChild(host);

    return shadow;
}

/**
 * 解析白名单输入字符串
 * 支持逗号、中文逗号、换行分隔，自动清理 < > 符号
 * @param {string} input - 用户输入的白名单字符串
 * @returns {string[]} - 解析后的标签名数组
 */
export function parseWhitelistInput(input) {
    if (!input || !input.trim()) return [];

    return input
        .split(/[,，\n]/)                    // 支持英文逗号、中文逗号、换行
        .map(tag => tag.trim())
        .map(tag => tag.replace(/^<|>$/g, ''))  // 自动移除 < >
        .filter(tag => tag.length > 0 && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(tag));  // 验证合法标签名
}

/**
 * 从消息文本中提取正文内容（支持白名单模式）
 * 如果有白名单设置，只提取白名单标签内的内容
 * 如果没有白名单或白名单匹配不到内容，则全文提取（移除 HTML 标签）
 * @param {string} text - 原始消息文本
 * @param {string[]} whitelist - 白名单标签数组（可选）
 * @returns {string} - 清洗后的正文内容
 */
function extractContent(text, whitelist = []) {
    if (!text) return "";

    // 如果有白名单设置，尝试只提取这些标签内的内容
    if (whitelist && whitelist.length > 0) {
        const extracted = [];

        for (const tag of whitelist) {
            // 匹配 <tag>...</tag> 和 <tag attr>...</tag>
            const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
            let match;
            while ((match = regex.exec(text)) !== null) {
                // 提取标签内容，并递归处理可能的嵌套标签
                const innerContent = match[1].trim();
                if (innerContent) {
                    extracted.push(innerContent);
                }
            }
        }

        // 如果白名单提取到内容，合并并返回
        if (extracted.length > 0) {
            let result = extracted.join('\n');
            // 移除 HTML 标签，保留纯文本
            result = result.replace(/<[^>]*>?/gm, '');
            // 清理多余空白
            result = result.replace(/\n{3,}/g, '\n\n').trim();
            return result;
        }

        // 白名单匹配不到内容，回退到全文提取
        // （不再返回空，而是继续处理整个文本）
    }

    // 全文提取模式：移除所有 HTML 标签，返回纯文本
    let cleaned = text;

    // 移除 HTML 标签（保留纯文本）
    cleaned = cleaned.replace(/<[^>]*>?/gm, '');

    // 清理多余空白
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    return cleaned;
}

/**
 * 获取聊天历史，过滤掉隐藏的并提取正文内容
 * @param {number} limit - 获取的行数限制
 * @param {string[]} whitelist - 白名单标签数组（可选）
 * @param {object[]} [blacklist] - 黑名单规则；缺省时自行从配置读取
 * @param {boolean} [aiOnly=false] - 只保留角色发言，跳过用户楼层。
 *   刻意不像 blacklist 那样缺省时回退读配置：默认调用方需要完整对话，
 *   用户的动作也是情节。只有剧本生成那两处显式传 true。
 */
export function getChatHistory(limit, whitelist = [], blacklist = undefined, aiOnly = false) {
    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) return "";
    const ctx = SillyTavern.getContext();
    const history = ctx.chat || [];
    const safeLimit = parseInt(limit) || 10;
    const effectiveBlacklist = blacklist === undefined
        ? parseChatHistoryBlacklistInput(getExtData().history_extraction?.blacklist || "")
        : blacklist;

    // 【高级过滤逻辑】
    // 由于 ST 的 context.chat 可能不包含实时的隐藏状态，我们需要结合 DOM 状态来判断
    // 逻辑：获取所有聊天消息 DOM 元素，检查是否有 'hidden' 属性或类名

    // 获取所有消息 DOM 元素 (通常是 .mes)
    const domMessages = document.querySelectorAll('#chat .mes');
    const useDomCheck = domMessages.length === history.length;

    if (!useDomCheck) {
        console.warn(`Titania: DOM messages count (${domMessages.length}) != History count (${history.length}). Fallback to property check.`);
    }

    const visibleHistory = history.filter((msg, index) => {
        // 1. 基础属性检查 - 包括 ST 使用的 is_system 属性
        let isHidden = !!(
            msg.is_hidden ||
            msg.isHidden ||
            msg.is_system ||  // ST 使用 is_system 来标记隐藏的消息
            (msg.extra && msg.extra.is_hidden)
        );

        // 2. DOM 状态检查 (如果数量匹配)
        if (!isHidden && useDomCheck) {
            const el = domMessages[index];
            if (el) {
                // 检查 DOM 元素是否被标记为隐藏
                // ST 通常会给隐藏的消息添加 is_system 属性或者特定的类名
                if (el.hasAttribute('hidden') ||
                    el.style.display === 'none' ||
                    el.classList.contains('hidden') ||
                    el.getAttribute('is_system') === 'true') {
                    isHidden = true;
                }
            }
        }

        const isDisabled = !!msg.disabled;

        if (isHidden) {
            return false;
        }

        if (isDisabled) {
            return false;
        }

        return true;
    });

    console.log(`Titania: History Analysis - Total: ${history.length}, Visible: ${visibleHistory.length}, Filtered: ${history.length - visibleHistory.length}`);

    // 只要角色发言：is_user 为真才是用户楼层，其余都算角色（群聊里的多个角色都保留）。
    // 必须在 slice 之前过滤 —— 与上面的隐藏楼层过滤同一口径，
    // 这样 limit 表示「N 条角色发言」而不是「最近 N 楼里剩下的那几条」。
    const scoped = aiOnly ? visibleHistory.filter(msg => !msg.is_user) : visibleHistory;
    if (aiOnly) {
        console.log(`Titania: History Analysis - AI only: ${scoped.length} / ${visibleHistory.length}`);
    }

    // 从过滤后的列表中截取最后 N 条
    const recent = scoped.slice(-safeLimit);

    return recent.map(msg => {
        let name = msg.name;
        if (msg.is_user) name = ctx.name1 || "User";
        if (name === "{{user}}") name = ctx.name1 || "User";
        if (name === "{{char}}") name = ctx.characters[ctx.characterId]?.name || "Char";

        let rawContent = msg.message || msg.mes || "";
        rawContent = removeChatHistoryBlacklist(rawContent, effectiveBlacklist);
        // 【优化】使用白名单模式提取内容
        let cleanContent = extractContent(rawContent, whitelist);

        // 如果提取后为空，回退到原始内容的简单清洗
        if (!cleanContent.trim()) {
            cleanContent = rawContent.replace(/<[^>]*>?/gm, '').trim();
        }

        return `${name}: ${cleanContent}`;
    }).join("\n");
}

/**
 * 文件转 Base64 (用于设置页图片上传)
 */
export const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result);
    reader.onerror = error => reject(error);
});

/**
 * 解析收藏标题元数据 (用于收藏夹)
 */
export const parseMeta = (title) => {
    const parts = title.split(' - ');
    if (parts.length >= 2) {
        const char = parts.pop();
        const script = parts.join(' - ');
        return { script, char: char.trim() };
    }
    return { script: title, char: "未知" };
};

/**
 * 获取 HTML 片段的纯文本摘要 (用于收藏夹)
 */
export const getSnippet = (html) => {
    const tmp = document.createElement("DIV");
    tmp.innerHTML = html;
    let text = tmp.textContent || tmp.innerText || "";
    text = text.replace(/\s+/g, " ").trim();
    return text.length > 60 ? text.substring(0, 60) + "..." : text;
};

/**
 * 轻量清洗 AI 输出内容（流式阶段用）
 * 仅移除明显噪声，避免每个 chunk 执行重度正则清洗
 * @param {string} rawContent
 * @returns {string}
 */
export function sanitizeAIOutputLite(rawContent) {
    if (!rawContent || typeof rawContent !== 'string') return '';

    let content = rawContent;

    // 轻量移除 markdown 代码块包裹
    content = content.replace(/```html\s*/gi, '');
    content = content.replace(/```\s*/g, '');

    // 移除最常见的思考标签（保留重度清洗在完成阶段执行）
    content = content.replace(/<thinking[^>]*>[\s\S]*?<\/thinking>/gi, '');
    content = content.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '');

    return content.trim();
}

/**
 * 激进清洗 AI 输出内容
 * 移除 AI 前言/后记、思考标签、Markdown 残留等非 HTML 内容
 * @param {string} rawContent - AI 返回的原始内容
 * @returns {string} - 清洗后的 HTML 内容
 */
export function sanitizeAIOutput(rawContent) {
    if (!rawContent || typeof rawContent !== 'string') return '';

    let content = rawContent;
    const originalContent = rawContent; // 保存原始内容用于回退

    // === 第一阶段：移除 AI 思考/元信息标签 ===
    const tagsToRemove = [
        'thinking', 'think',           // 思考过程
        'system', 'note', 'notes',     // 系统/笔记
        'ooc', 'OOC',                  // Out of Character
        'debug', 'meta',               // 调试/元信息
        'comment', 'aside',            // 注释/旁白
        'reflection', 'planning',      // 反思/规划
        'internal', 'analysis'         // 内部思考/分析
    ];

    tagsToRemove.forEach(tag => {
        // 匹配开闭标签形式: <tag>...</tag> 和 <tag attr>...</tag>
        const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
        content = content.replace(regex, '');
    });

    // === 第二阶段：移除 Markdown 代码块标记 ===
    content = content.replace(/```html\s*/gi, '');
    content = content.replace(/```\s*/g, '');

    // === 第三阶段：激进清洗 - 提取纯 HTML 部分 ===
    // 策略：找到第一个有效的 HTML 开始标签，删除之前的所有内容
    //       找到最后一个有效的 HTML 闭合标签，删除之后的所有内容

    // 常见的 HTML 开始标记（按优先级排序）
    const htmlStartPatterns = [
        /<!DOCTYPE\s+html/i,           // DOCTYPE 声明
        /<html[\s>]/i,                 // <html> 标签
        /<head[\s>]/i,                 // <head> 标签
        /<body[\s>]/i,                 // <body> 标签
        /<style[\s>]/i,                // <style> 标签（很多 AI 会以此开头）
        /<div[\s>]/i,                  // <div> 标签
        /<section[\s>]/i,              // <section> 标签
        /<article[\s>]/i,              // <article> 标签
        /<main[\s>]/i,                 // <main> 标签
        /<header[\s>]/i,               // <header> 标签
        /<p[\s>]/i,                    // <p> 标签
        /<span[\s>]/i,                 // <span> 标签
        /<h[1-6][\s>]/i                // 标题标签
    ];

    // 查找第一个 HTML 开始位置
    let firstHtmlIndex = -1;
    for (const pattern of htmlStartPatterns) {
        const match = content.search(pattern);
        if (match !== -1) {
            if (firstHtmlIndex === -1 || match < firstHtmlIndex) {
                firstHtmlIndex = match;
            }
        }
    }

    // 如果找到了 HTML 开始位置，删除之前的内容
    if (firstHtmlIndex > 0) {
        content = content.substring(firstHtmlIndex);
    }

    // 查找最后一个 HTML 闭合标签的位置
    // 常见的结束标记
    const htmlEndPatterns = [
        /<\/html>\s*$/i,
        /<\/body>\s*$/i,
        /<\/div>\s*$/i,
        /<\/section>\s*$/i,
        /<\/article>\s*$/i,
        /<\/main>\s*$/i,
        /<\/style>\s*$/i,
        /<\/p>\s*$/i,
        /<\/span>\s*$/i,
        /<\/h[1-6]>\s*$/i
    ];

    // 查找最后一个闭合标签
    let lastHtmlEndIndex = -1;
    for (const pattern of htmlEndPatterns) {
        const match = content.match(pattern);
        if (match) {
            const endIndex = content.lastIndexOf(match[0]) + match[0].length;
            if (endIndex > lastHtmlEndIndex) {
                lastHtmlEndIndex = endIndex;
            }
        }
    }

    // 如果没有找到标准结尾，尝试找最后一个闭合标签
    if (lastHtmlEndIndex === -1) {
        // 匹配任意闭合标签
        const allClosingTags = content.match(/<\/[a-zA-Z][a-zA-Z0-9]*>\s*$/);
        if (allClosingTags) {
            lastHtmlEndIndex = content.lastIndexOf(allClosingTags[0]) + allClosingTags[0].length;
        }
    }

    // 如果找到了有效的结束位置，删除之后的内容
    if (lastHtmlEndIndex > 0 && lastHtmlEndIndex < content.length) {
        content = content.substring(0, lastHtmlEndIndex);
    }

    // === 第四阶段：清理 Markdown 残留（针对可能残留在 HTML 中的） ===
    // 只处理明显在文本节点中的 Markdown，避免破坏 HTML 结构

    // 移除 Markdown 粗体（**text** 或 __text__）
    // 仅在非 HTML 标签属性中替换
    content = content.replace(/(\s|>)\*\*([^*<>]+)\*\*(\s|<)/g, '$1$2$3');
    content = content.replace(/(\s|>)__([^_<>]+)__(\s|<)/g, '$1$2$3');

    // 移除 Markdown 斜体（*text* 或 _text_）- 更保守的匹配
    content = content.replace(/(\s|>)\*([^*<>\n]+)\*(\s|<)/g, '$1$2$3');

    // 移除 Markdown 标题标记（# ## ### 等，仅在行首）
    content = content.replace(/^\s*#{1,6}\s+/gm, '');

    // 移除 Markdown 无序列表标记（- 或 * 在行首）
    content = content.replace(/^\s*[-*+]\s+(?=[^\s<])/gm, '');

    // 移除 Markdown 有序列表标记（1. 2. 等在行首）
    content = content.replace(/^\s*\d+\.\s+(?=[^\s<])/gm, '');

    // === 第五阶段：清理多余空白 ===
    content = content.replace(/\n{3,}/g, '\n\n');  // 多个连续换行压缩为两个
    content = content.trim();

    // === 安全回退 ===
    // 如果清洗后内容为空或过短，回退到原始内容
    if (!content || content.length < 10) {
        console.warn('Titania: 清洗后内容为空，回退到原始内容');
        // 对原始内容只做最基础的清理（移除代码块标记）
        return originalContent.replace(/```html\s*/gi, '').replace(/```\s*/g, '').trim();
    }

    return content;
}

/**
 * CSS 作用域净化与注入 (Safeguard B)
 * @param {string} rawHtml - AI 返回的原始 HTML (可能包含 style 标签)
 * @param {string} scopeId - 当前生成的唯一 ID (例如 "t-scene-123")
 * @returns {string} - 处理后的安全 HTML
 */
export function scopeAndSanitizeHTML(rawHtml, scopeId) {
    // 1. 提取 <style> 内容
    const styleMatch = rawHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
    let cssContent = styleMatch ? styleMatch[1] : "";
    let bodyContent = rawHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/i, "").trim();

    // 2. 如果 AI 忘记了外层容器的 ID，手动加一层保险
    // 检查开头是否包含该 ID，如果没有，强行包裹
    if (!bodyContent.includes(`id="${scopeId}"`) && !bodyContent.includes(`id='${scopeId}'`)) {
        bodyContent = `<div id="${scopeId}">${bodyContent}</div>`;
    }

    // 3. CSS 净化与作用域强制 (正则魔法)
    if (cssContent) {
        // A. 移除注释，避免干扰正则
        cssContent = cssContent.replace(/\/\*[\s\S]*?\*\//g, "");

        // B. 保护全局标签：将 body/html 选择器强制替换为宿主 ID
        // 例如: body { background: black } -> #t-scene-123 { background: black }
        cssContent = cssContent.replace(/(^|\})[\s]*\b(body|html)\b/gi, "$1 #" + scopeId);

        // C. 简单粗暴的作用域检查 (可选增强)
        // 如果选择器不包含 @ (媒体查询/关键帧) 且不包含 ID，尝试前缀 (这步比较激进，先只做上面的全局保护)

        // D. 确保关键帧动画名不冲突 (给动画名加后缀)
        // 这一步比较复杂，暂且信任 AI 会使用 scoped ID 内部的动画，
        // 或者我们假设 AI 足够聪明。为了保险，我们只做基础清洗。
    }

    // 4. 重新组装
    // 注意：将 Style 放在 Div 内部在 HTML5 是合法的 (scoped)，但在 ST 里我们通常只要拼在一起就行
    return `<style>\n/* Scoped CSS for ${scopeId} */\n${cssContent}\n</style>\n${bodyContent}`;
}

/**
 * 生成唯一 ID
 */
export function generateScopeId() {
    return "t-scene-" + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString();
}

/**
 * 将 HTML 内容渲染到 iframe 沙箱中，实现 CSS 隔离并支持 JavaScript 交互
 * @param {HTMLElement} container - 目标容器元素
 * @param {string} html - 要渲染的 HTML 内容
 * @param {object} options - 配置选项
 * @returns {HTMLIFrameElement} - 返回 iframe 元素引用
 */
export function renderToShadowDOM(container, html, options = {}) {
    // 清空容器
    container.innerHTML = '';

    // 创建 iframe
    const iframe = document.createElement('iframe');
    iframe.className = 't-content-iframe';
    iframe.sandbox = 'allow-scripts'; // 允许脚本执行，但禁止访问父页面

    // 基础样式 - 移除固定高度限制，让 iframe 自适应
    iframe.style.cssText = `
        width: 100%;
        border: none;
        background: transparent;
        display: block;
        height: 100%;
    `;

    // 构建完整的 HTML 文档
    const fullHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        /* 基础重置样式 */
        * { box-sizing: border-box; }
        html, body {
            margin: 0;
            padding: 0;
            background: transparent;
            color: #e0e0e0;
            font-family: var(--t-font-global, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
            font-size: 14px;
            line-height: 1.6;
            /* 禁用 iframe 内部滚动，由外层容器控制 */
            overflow: hidden;
            height: auto;
            min-height: 100%;
        }
        body {
            padding: 15px 20px;
            min-height: 100%;
        }
        img, video {
            max-width: 100%;
            height: auto;
        }
        a { color: #90cdf4; }
        /* 隐藏滚动条 */
        ::-webkit-scrollbar { display: none; }
        * { scrollbar-width: none; }
    </style>
</head>
<body>
${html}
<script>
    // 自动高度调整 - 更精确的计算
    function updateHeight() {
        // 获取内容实际高度
        const bodyHeight = document.body.scrollHeight;
        const docHeight = document.documentElement.scrollHeight;
        
        // 取最大值确保内容完全显示
        const contentHeight = Math.max(bodyHeight, docHeight);
        
        // 添加少量边距
        const finalHeight = contentHeight + 10;
        
        window.parent.postMessage({
            type: 'titania-iframe-height',
            height: finalHeight
        }, '*');
    }
    
    // 初始化时延迟更新（等待渲染完成）
    setTimeout(updateHeight, 50);
    setTimeout(updateHeight, 200);
    setTimeout(updateHeight, 500);
    
    // 监听 DOM 变化
    const observer = new MutationObserver(() => {
        setTimeout(updateHeight, 50);
    });
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
    });
    
    // 监听所有图片加载
    function observeImages() {
        document.querySelectorAll('img').forEach(img => {
            if (!img.complete) {
                img.addEventListener('load', updateHeight);
                img.addEventListener('error', updateHeight);
            }
        });
    }
    observeImages();
    
    // 监听动态添加的图片
    const imgObserver = new MutationObserver(observeImages);
    imgObserver.observe(document.body, { childList: true, subtree: true });
    
    // 窗口调整时更新
    window.addEventListener('resize', updateHeight);
    
    // 字体加载完成后更新
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(updateHeight);
    }
</script>
</body>
</html>`;

    iframe.srcdoc = fullHtml;

    // 添加到容器
    container.appendChild(iframe);

    // 监听高度变化消息
    const heightHandler = (event) => {
        if (event.data && event.data.type === 'titania-iframe-height') {
            // 不再限制最大高度，让内容自然扩展
            const newHeight = Math.max(event.data.height, 100);
            iframe.style.height = newHeight + 'px';
        }
    };
    window.addEventListener('message', heightHandler);

    // 存储清理函数供后续使用
    iframe._cleanupHandler = () => {
        window.removeEventListener('message', heightHandler);
    };

    return iframe;
}

/**
 * 从 Shadow DOM 或 iframe 中提取 HTML 内容（用于复制/收藏）
 * @param {HTMLElement} container - 包含 Shadow DOM 宿主或 iframe 的容器
 * @returns {string} - 提取的 HTML（不包含基础样式和脚本）
 */
export function extractFromShadowDOM(container) {
    // 优先尝试从真正的 Shadow DOM 提取
    const shadowHost = container.querySelector('.t-shadow-host');
    if (shadowHost && shadowHost.shadowRoot) {
        try {
            const shadow = shadowHost.shadowRoot;
            const contentDiv = shadow.querySelector('.t-shadow-content');

            if (contentDiv) {
                // 提取用户内容的样式（排除我们注入的基础样式）
                let userStyles = '';
                shadow.querySelectorAll('style').forEach(style => {
                    const text = style.textContent || '';
                    // 跳过我们注入的基础样式（通过 :host 选择器识别）
                    if (!text.includes(':host')) {
                        userStyles += `<style>${text}</style>\n`;
                    }
                });

                return userStyles + contentDiv.innerHTML;
            }
        } catch (e) {
            console.warn('Titania: 无法从 Shadow DOM 提取内容', e);
        }
    }

    // 兼容旧版：尝试从 iframe 提取
    const iframe = container.querySelector('.t-content-iframe');
    if (iframe) {
        try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            if (doc && doc.body) {
                // 克隆 body 内容
                const bodyClone = doc.body.cloneNode(true);

                // 移除注入的脚本
                bodyClone.querySelectorAll('script').forEach(s => s.remove());

                // 获取用户定义的样式（排除基础样式）
                let userStyles = '';
                doc.querySelectorAll('head style').forEach(style => {
                    const text = style.textContent || '';
                    // 跳过我们注入的基础样式
                    if (!text.includes('box-sizing: border-box') || text.length > 500) {
                        userStyles += `<style>${text}</style>\n`;
                    }
                });

                return userStyles + bodyClone.innerHTML;
            }
        } catch (e) {
            // 跨域限制或其他错误
            console.warn('Titania: 无法从 iframe 提取内容', e);
        }
    }

    // 最终降级：直接返回 innerHTML
    return container.innerHTML;
}

/**
 * 检查浏览器是否支持 iframe srcdoc
 * @returns {boolean}
 */
export function canUseShadowDOM() {
    // 检查 srcdoc 支持（现代浏览器都支持）
    const iframe = document.createElement('iframe');
    return 'srcdoc' in iframe;
}

/**
 * 清理 iframe 资源（在移除容器前调用）
 * @param {HTMLElement} container - 包含 iframe 的容器
 */
export function cleanupIframe(container) {
    const iframe = container?.querySelector('.t-content-iframe');
    if (iframe && iframe._cleanupHandler) {
        iframe._cleanupHandler();
    }
}

/**
 * Token 计数（接入 SillyTavern 真实分词器）
 *
 * 统一入口：优先使用 ST 的 getTokenCountAsync，它会依据当前连接的 API / 模型
 * 选择匹配的分词器（OpenAI 走 tiktoken，其余走对应 vocab），并自带缓存。
 * 仅当分词器不可用时退回粗略估算，此时 exact 为 false，
 * 调用方应在 UI 上标注该数字为估算值。
 *
 * 路径 `../../../tokenizers.js` 是相对打包产物 index.js 写的，
 * 与 build.js 的 external 登记一致（同 script.js / power-user.js 约定）。
 *
 * @param {string} text
 * @returns {Promise<{ count: number, exact: boolean }>}
 */
export async function countTokens(text) {
    const str = String(text || "");
    if (!str) return { count: 0, exact: true };

    try {
        const { getTokenCountAsync } = await import("../../../tokenizers.js");
        const count = await getTokenCountAsync(str);
        if (Number.isFinite(count)) return { count, exact: true };
    } catch (error) {
        console.warn("Titania: ST 分词器不可用，回退到估算", error);
    }

    return { count: estimateTokens(str), exact: false };
}

/**
 * 批量计数。串行执行以复用 ST 内部缓存，避免并发打满后端分词接口。
 * 任一分片降级则整体标记为非精确。
 *
 * @param {string[]} texts
 * @returns {Promise<{ counts: number[], total: number, exact: boolean }>}
 */
export async function countTokensBatch(texts) {
    const list = Array.isArray(texts) ? texts : [];
    const counts = [];
    let exact = true;

    for (const item of list) {
        const result = await countTokens(item);
        counts.push(result.count);
        if (!result.exact) exact = false;
    }

    return { counts, total: counts.reduce((sum, n) => sum + n, 0), exact };
}

/**
 * 粗略 Token 估算（仅作为分词器不可用时的兜底）
 *
 * 按字符分类加权，不依赖空格分词：旧实现把无空格长串（如带内联 CSS 的 HTML）
 * 整体记作 1 个单词，导致严重低估。
 * 权重：CJK 1.35 / ASCII 字母数字 0.28 / 其余可见符号 0.55
 */
export function estimateTokens(text) {
    const clean = String(text || "").trim();
    if (!clean) return 0;

    let cjk = 0;
    let alnum = 0;
    let other = 0;

    for (const ch of clean) {
        if (/[一-龥　-〿＀-￯]/.test(ch)) cjk++;
        else if (/[A-Za-z0-9]/.test(ch)) alnum++;
        else if (!/\s/.test(ch)) other++;
    }

    return Math.max(1, Math.round(cjk * 1.35 + alnum * 0.28 + other * 0.55));
}

/**
 * 检测 HTML 内容是否被截断
 * @param {string} content - 要检测的 HTML 内容
 * @param {string} mode - 检测模式: "html" | "sentence" | "both"
 * @returns {{ isTruncated: boolean, reason: string, details: object }}
 */
export function detectTruncation(content, mode = "html") {
    if (!content || content.trim().length === 0) {
        return { isTruncated: false, reason: "empty", details: {} };
    }

    const result = {
        isTruncated: false,
        reason: "",
        details: {
            htmlCheck: null,
            sentenceCheck: null
        }
    };

    // HTML 标签闭合检测
    if (mode === "html" || mode === "both") {
        const htmlResult = checkHtmlTags(content);
        result.details.htmlCheck = htmlResult;
        if (htmlResult.isTruncated) {
            result.isTruncated = true;
            result.reason = htmlResult.reason;
        }
    }

    // 句子完整性检测
    if (mode === "sentence" || mode === "both") {
        const sentenceResult = checkSentenceCompletion(content);
        result.details.sentenceCheck = sentenceResult;
        if (sentenceResult.isTruncated && !result.isTruncated) {
            result.isTruncated = true;
            result.reason = sentenceResult.reason;
        }
    }

    return result;
}

/**
 * 检测 HTML 标签是否正确闭合
 * @param {string} html - HTML 内容
 * @returns {{ isTruncated: boolean, reason: string, unclosedTags: string[] }}
 */
function checkHtmlTags(html) {
    const result = {
        isTruncated: false,
        reason: "",
        unclosedTags: []
    };

    // 自闭合标签列表
    const selfClosingTags = ['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr'];

    // 提取所有标签
    const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*\/?>/g;
    const stack = [];
    let match;

    while ((match = tagPattern.exec(html)) !== null) {
        const fullTag = match[0];
        const tagName = match[1].toLowerCase();

        // 跳过自闭合标签
        if (selfClosingTags.includes(tagName) || fullTag.endsWith('/>')) {
            continue;
        }

        // 检查是闭合标签还是开放标签
        if (fullTag.startsWith('</')) {
            // 闭合标签
            if (stack.length > 0 && stack[stack.length - 1] === tagName) {
                stack.pop();
            }
            // 如果栈顶不匹配，可能是嵌套问题，暂时忽略
        } else {
            // 开放标签
            stack.push(tagName);
        }
    }

    // 检查是否有未闭合的重要标签
    const importantTags = ['div', 'style', 'span', 'p', 'section', 'article', 'main', 'header', 'footer'];
    const unclosedImportant = stack.filter(tag => importantTags.includes(tag));

    if (unclosedImportant.length > 0) {
        result.isTruncated = true;
        result.reason = `HTML 标签未闭合: <${unclosedImportant.join('>, <')}>`;
        result.unclosedTags = unclosedImportant;
    }

    // 检查 style 标签是否完整
    const styleOpenCount = (html.match(/<style[^>]*>/gi) || []).length;
    const styleCloseCount = (html.match(/<\/style>/gi) || []).length;
    if (styleOpenCount > styleCloseCount) {
        result.isTruncated = true;
        result.reason = "<style> 标签未闭合";
        result.unclosedTags.push('style');
    }

    // 检查 CSS 花括号是否匹配 (在 style 标签内)
    const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    if (styleMatch) {
        for (const styleBlock of styleMatch) {
            const cssContent = styleBlock.replace(/<\/?style[^>]*>/gi, '');
            const openBraces = (cssContent.match(/{/g) || []).length;
            const closeBraces = (cssContent.match(/}/g) || []).length;
            if (openBraces > closeBraces) {
                result.isTruncated = true;
                result.reason = "CSS 花括号不匹配";
                break;
            }
        }
    }

    return result;
}

/**
 * 检测句子是否完整
 * @param {string} content - 内容
 * @returns {{ isTruncated: boolean, reason: string, lastChars: string }}
 */
function checkSentenceCompletion(content) {
    const result = {
        isTruncated: false,
        reason: "",
        lastChars: ""
    };

    // 移除 HTML 标签，获取纯文本
    const textContent = content.replace(/<[^>]*>/g, '').trim();
    if (textContent.length === 0) {
        return result;
    }

    // 获取最后 50 个字符用于分析
    const lastChars = textContent.slice(-50);
    result.lastChars = lastChars;

    // 中文句子结束标点
    const chineseEndPunctuation = ['。', '！', '？', '…', '"', '"', '』', '」'];
    // 英文句子结束标点
    const englishEndPunctuation = ['.', '!', '?', '"', "'"];
    // 所有有效的结束标点
    const allEndPunctuation = [...chineseEndPunctuation, ...englishEndPunctuation];

    // 获取最后一个非空白字符
    const lastChar = textContent.trim().slice(-1);

    // 检查是否以有效标点结束
    const endsWithPunctuation = allEndPunctuation.includes(lastChar);

    // 检查是否在单词中间截断（英文）
    const endsWithLetter = /[a-zA-Z]$/.test(textContent.trim());
    const previousChars = textContent.trim().slice(-10);
    const hasIncompleteWord = endsWithLetter && !/[.!?,;:\s]/.test(previousChars.slice(-2, -1));

    // 检查是否在中文句子中间截断
    const lastCJK = /[\u4e00-\u9fa5]$/.test(textContent.trim());
    const hasCJKContent = /[\u4e00-\u9fa5]/.test(textContent);

    if (hasCJKContent && lastCJK && !chineseEndPunctuation.includes(lastChar)) {
        // 中文内容但不以中文标点结束
        // 进一步检查：如果最后是引号内的内容，可能是正常的
        if (!endsWithPunctuation) {
            result.isTruncated = true;
            result.reason = "中文句子似乎未完成";
        }
    } else if (hasIncompleteWord) {
        result.isTruncated = true;
        result.reason = "英文单词似乎被截断";
    }

    return result;
}

/**
 * 从截断的内容中提取续写上下文（旧版，保留兼容）
 * @param {string} content - 截断的内容
 * @param {number} contextLength - 上下文长度（字符数）
 * @returns {{ lastContent: string, scopeId: string | null }}
 */
export function extractContinuationContext(content, contextLength = 800) {
    // 提取 scopeId
    const scopeMatch = content.match(/id=["']?(t-scene-[a-z0-9]+)["']?/i);
    const scopeId = scopeMatch ? scopeMatch[1] : null;

    // 移除 style 标签获取主体内容
    let bodyContent = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').trim();

    // 获取最后 N 个字符作为上下文
    let lastContent = bodyContent.slice(-contextLength);

    // 优化：确保不在 HTML 标签中间开始
    // 检查开头是否有未闭合的标签（即先遇到 > 再遇到 <）
    const firstTagEnd = lastContent.indexOf('>');
    const firstTagStart = lastContent.indexOf('<');

    if (firstTagEnd !== -1 && (firstTagStart === -1 || firstTagEnd < firstTagStart)) {
        // 开头有未闭合的标签，从第一个完整标签开始
        const nextTagStart = lastContent.indexOf('<', firstTagEnd + 1);
        if (nextTagStart !== -1) {
            lastContent = lastContent.substring(nextTagStart);
        } else {
            // 没有找到下一个标签，从 > 之后开始
            lastContent = lastContent.substring(firstTagEnd + 1);
        }
    }

    return {
        lastContent,
        scopeId
    };
}

/**
 * 构建分层续写上下文（优化版）
 * 提供更丰富的上下文信息，提高续写质量
 * @param {string} accumulatedContent - 已累积的全部内容
 * @param {string} originalPrompt - 原始场景请求
 * @returns {object} 分层上下文对象
 */
export function buildContinuationContext(accumulatedContent, originalPrompt = "") {
    // 1. 提取 style 标签，供续写风格继承
    const styleBlocks = accumulatedContent.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];
    const styleGuide = styleBlocks
        .map(block => block.replace(/<\/?style[^>]*>/gi, '').trim())
        .join('\n')
        .slice(0, 1600);

    // 2. 移除 style 标签获取主体内容
    const bodyContent = accumulatedContent.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').trim();

    // 3. 提取纯文本用于理解叙事
    const plainText = bodyContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    // 4. 提取关键情节点（每段第一句）
    const paragraphs = plainText.split(/\n\n+|。(?=[^。]*$)/);
    const plotPoints = paragraphs
        .map(p => {
            const firstSentence = p.trim().split(/[。！？]/)[0];
            return firstSentence && firstSentence.length > 5 ? firstSentence.trim() : null;
        })
        .filter(Boolean)
        .slice(-5)  // 最后5个情节点
        .join(' → ');

    // 5. 提取最后两个完整段落（保留HTML结构）
    // 按 </p> 或 </div> 分割，取最后几个
    const htmlBlocks = bodyContent.split(/(<\/p>|<\/div>)/i);
    let recentHtml = "";
    let blockCount = 0;
    for (let i = htmlBlocks.length - 1; i >= 0 && blockCount < 4; i--) {
        recentHtml = htmlBlocks[i] + recentHtml;
        if (htmlBlocks[i].match(/<\/p>|<\/div>/i)) {
            blockCount++;
        }
    }
    // 清理并截取合理长度
    recentHtml = recentHtml.trim().slice(-1000);

    // 6. 提取最后一个完整句子作为精确截断位置
    const sentences = plainText.match(/[^。！？]*[。！？]/g) || [];
    const lastCompleteSentence = sentences.length > 0 ? sentences[sentences.length - 1].trim() : "";

    // 7. 检测是否有未完成的句子
    const lastPart = plainText.slice(-100);
    const endsWithPunctuation = /[。！？"」』]$/.test(lastPart.trim());
    const incompleteText = endsWithPunctuation ? "" : lastPart.split(/[。！？]/).pop()?.trim() || "";

    // 8. 检测未闭合的 HTML 标签
    const unclosedTags = detectUnclosedTags(bodyContent);

    // 9. 统计近期结构类名，指导续写复用现有样式
    const classMatches = bodyContent.match(/class=["']([^"']+)["']/gi) || [];
    const classSet = new Set();
    classMatches.forEach(item => {
        const m = item.match(/class=["']([^"']+)["']/i);
        if (m && m[1]) {
            m[1].split(/\s+/).forEach(cls => {
                const c = cls.trim();
                if (c) classSet.add(c);
            });
        }
    });
    const recentClasses = Array.from(classSet).slice(0, 20);

    return {
        plotSummary: plotPoints || "(无情节摘要)",           // 情节进展摘要
        recentHtml: recentHtml,                              // 最后2段完整HTML
        styleGuide: styleGuide,                              // 原有样式片段
        recentClasses: recentClasses,                        // 近期使用类名
        lastCompleteSentence: lastCompleteSentence,          // 最后完整句子
        incompleteText: incompleteText,                      // 未完成的句子片段
        unclosedTags: unclosedTags,                          // 未闭合标签列表
        totalLength: plainText.length,                       // 已生成总字数
        endsWithPunctuation: endsWithPunctuation,            // 是否以标点结束
        originalPrompt: (originalPrompt || "").slice(0, 300) // 原始请求摘要
    };
}

/**
 * 检测 HTML 内容中未闭合的标签
 * @param {string} html - HTML 内容
 * @returns {string[]} 未闭合的标签名列表
 */
function detectUnclosedTags(html) {
    const selfClosingTags = ['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr'];
    const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*\/?>/g;
    const stack = [];
    let match;

    while ((match = tagPattern.exec(html)) !== null) {
        const fullTag = match[0];
        const tagName = match[1].toLowerCase();

        // 跳过自闭合标签
        if (selfClosingTags.includes(tagName) || fullTag.endsWith('/>')) {
            continue;
        }

        if (fullTag.startsWith('</')) {
            // 闭合标签
            if (stack.length > 0 && stack[stack.length - 1] === tagName) {
                stack.pop();
            }
        } else {
            // 开放标签
            stack.push(tagName);
        }
    }

    // 只返回重要的未闭合标签
    const importantTags = ['div', 'p', 'span', 'section', 'article', 'blockquote'];
    return stack.filter(tag => importantTags.includes(tag));
}

/**
 * 智能合并续写内容（带去重）
 * @param {string} originalContent - 原始内容
 * @param {string} continuationContent - 续写内容
 * @param {boolean} showIndicator - 是否显示续写标记
 * @returns {string} - 合并后的内容
 */
export function smartMergeContinuation(originalContent, continuationContent, showIndicator = false) {
    // 提取原始内容的 style
    const originalStyleMatch = originalContent.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
    const originalStyle = originalStyleMatch ? originalStyleMatch[1] : "";

    // 提取续写内容的 style（如果有）
    const contStyleMatch = continuationContent.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
    const contStyle = contStyleMatch ? contStyleMatch[1] : "";

    // 移除续写内容中的 style 标签
    let contBody = continuationContent.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').trim();

    // 移除原始内容的 style 标签
    let originalBody = originalContent.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').trim();

    // 智能去重：检测续写开头与原始结尾的重叠
    contBody = removeOverlap(originalBody, contBody);

    // 添加续写标记（可选，默认关闭以保持无缝）
    let indicator = "";
    if (showIndicator) {
        indicator = `<!-- continuation-point -->`;
    }

    // 合并 CSS
    const mergedStyle = originalStyle + (contStyle ? "\n/* Continuation CSS */\n" + contStyle : "");

    // 合并 HTML
    const mergedBody = originalBody + indicator + contBody;

    // 重新组装
    if (mergedStyle.trim()) {
        return `<style>\n${mergedStyle}\n</style>\n${mergedBody}`;
    }
    return mergedBody;
}

/**
 * 检测并移除续写内容开头与原始内容结尾的重叠部分
 * @param {string} original - 原始内容
 * @param {string} continuation - 续写内容
 * @returns {string} 去重后的续写内容
 */
function removeOverlap(original, continuation) {
    if (!original || !continuation) return continuation;

    // 获取原始内容的最后 100 个字符（纯文本）
    const originalText = original.replace(/<[^>]*>/g, '').trim();
    const contText = continuation.replace(/<[^>]*>/g, '').trim();

    const originalEnd = originalText.slice(-100);

    // 尝试查找重叠
    // 从续写内容开头查找是否有与原始结尾匹配的部分
    let maxOverlap = 0;
    const minOverlapLength = 10; // 至少10个字符才算重叠
    const maxCheckLength = Math.min(80, contText.length, originalEnd.length);

    for (let len = maxCheckLength; len >= minOverlapLength; len--) {
        const originalSuffix = originalEnd.slice(-len);
        const contPrefix = contText.slice(0, len);

        // 模糊匹配：去除标点和空格后比较
        const normalizedSuffix = originalSuffix.replace(/[，。！？、\s]/g, '');
        const normalizedPrefix = contPrefix.replace(/[，。！？、\s]/g, '');

        if (normalizedSuffix === normalizedPrefix) {
            maxOverlap = len;
            break;
        }
    }

    if (maxOverlap >= minOverlapLength) {
        // 在原始 HTML 中找到对应位置并截取
        // 简化处理：在续写内容中找到重叠文本的位置并从那之后开始
        const overlapText = contText.slice(0, maxOverlap);
        const overlapIndex = continuation.indexOf(overlapText.slice(-20));

        if (overlapIndex !== -1) {
            // 找到下一个合适的起点（通常是下一个标签或句子）
            const afterOverlap = continuation.slice(overlapIndex + 20);
            const nextStart = afterOverlap.search(/[。！？]|<[a-z]/i);

            if (nextStart !== -1) {
                return afterOverlap.slice(nextStart).replace(/^[。！？]/, '');
            }
        }
    }

    return continuation;
}

/**
 * 从 HTML 内容中提取纯文本摘要
 * 用于续写时帮助 AI 理解已生成内容的叙事脉络
 * @param {string} htmlContent - HTML 内容
 * @param {number} maxLength - 最大长度（字符数）
 * @returns {string} 纯文本摘要
 */
export function extractTextSummary(htmlContent, maxLength = 500) {
    if (!htmlContent) return "";

    // 1. 移除 style 标签及其内容
    let text = htmlContent.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    // 2. 移除所有 HTML 标签
    text = text.replace(/<[^>]*>/g, ' ');

    // 3. 清理多余空白和换行
    text = text.replace(/\s+/g, ' ').trim();

    // 4. 如果内容过长，智能截取
    if (text.length > maxLength) {
        const truncated = text.substring(0, maxLength);

        // 找到最后一个完整句子的位置（中文或英文标点）
        const lastPunctuationIndex = Math.max(
            truncated.lastIndexOf('。'),
            truncated.lastIndexOf('！'),
            truncated.lastIndexOf('？'),
            truncated.lastIndexOf('…'),
            truncated.lastIndexOf('.'),
            truncated.lastIndexOf('!'),
            truncated.lastIndexOf('?')
        );

        // 如果找到了合适的截断点（在后半部分），使用它
        if (lastPunctuationIndex > maxLength * 0.5) {
            return truncated.substring(0, lastPunctuationIndex + 1);
        }

        // 否则直接截断并添加省略号
        return truncated + '...';
    }

    return text;
}

/**
 * 统计 HTML 内容的字符数据
 * @param {string} htmlContent - HTML 内容
 * @returns {{ totalChars: number, chineseChars: number, estimatedTokens: number }}
 */
export function countContentStats(htmlContent) {
    if (!htmlContent) {
        return { totalChars: 0, chineseChars: 0, estimatedTokens: 0 };
    }

    // 1. 移除 HTML 标签，获取纯文本
    let plainText = htmlContent
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')  // 移除 style 标签及内容
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // 移除 script 标签及内容
        .replace(/<[^>]*>/g, '')  // 移除所有其他 HTML 标签
        .trim();

    // 2. 计算总字符数（不含多余空白）
    const totalChars = plainText.replace(/\s+/g, ' ').length;

    // 3. 计算中文字符数（包括中日韩统一表意文字）
    const chineseMatches = plainText.match(/[\u4e00-\u9fa5]/g);
    const chineseChars = chineseMatches ? chineseMatches.length : 0;

    // 4. 估算 Token 数
    // 中文字符约 1.5 字符/token，英文约 4 字符/token
    const nonChineseText = plainText.replace(/[\u4e00-\u9fa5]/g, '');
    const wordCount = nonChineseText.split(/\s+/).filter(w => w.length > 0).length;
    const estimatedTokens = Math.ceil(chineseChars / 1.5 + wordCount * 1.3);

    return {
        totalChars,
        chineseChars,
        estimatedTokens
    };
}

/**
 * 合并原始内容和续写内容
 * @param {string} originalContent - 原始内容
 * @param {string} continuationContent - 续写内容
 * @param {boolean} showIndicator - 是否显示续写标记
 * @returns {string} - 合并后的内容
 */
export function mergeContinuationContent(originalContent, continuationContent, showIndicator = true) {
    // 提取原始内容的 style
    const originalStyleMatch = originalContent.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
    const originalStyle = originalStyleMatch ? originalStyleMatch[1] : "";

    // 提取续写内容的 style（如果有）
    const contStyleMatch = continuationContent.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
    const contStyle = contStyleMatch ? contStyleMatch[1] : "";

    // 移除续写内容中的 style 标签
    let contBody = continuationContent.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').trim();

    // 移除原始内容末尾可能未闭合的标签
    let originalBody = originalContent.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').trim();

    // 添加续写标记（可选）
    let indicator = "";
    if (showIndicator) {
        indicator = `<div style="text-align:center; color:#bfa15f; font-size:0.8em; margin:15px 0; opacity:0.7;">
            <i class="fa-solid fa-link"></i> ─── 续写连接 ───
        </div>`;
    }

    // 合并 CSS
    const mergedStyle = originalStyle + (contStyle ? "\n/* Continuation CSS */\n" + contStyle : "");

    // 合并 HTML
    const mergedBody = originalBody + indicator + contBody;

    // 重新组装
    if (mergedStyle.trim()) {
        return `<style>\n${mergedStyle}\n</style>\n${mergedBody}`;
    }
    return mergedBody;
}
