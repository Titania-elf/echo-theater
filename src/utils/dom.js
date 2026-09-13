// src/utils/dom.js
import { extensionFolderPath } from "../config/defaults.js";
import { cssFileList } from "../../css/manifest.js";

/**
 * 确保 overlay 容器存在
 * 用于支持设置窗口等可以独立于主窗口打开的场景
 */
export function ensureOverlay() {
    if ($("#t-overlay").length === 0) {
        const overlayHtml = `<div id="t-overlay" class="t-overlay t-root"></div>`;
        $("body").append(overlayHtml);
    }
    return $("#t-overlay");
}

// 动态加载 CSS（开发模式；打包时本函数被 build.js 的 injectCSSPlugin 整体替换为内联注入）
// 清单来自 css/manifest.js，与 build.js 共用同一数据源。
// 此前这里手写了第二份清单并漏掉 workshop.css，导致开发模式下工坊窗口无样式（B1）。
export function loadCssFiles() {
    cssFileList().forEach(file => {
        const id = cssLinkId(file);
        if (document.getElementById(id)) return;

        const link = document.createElement("link");
        link.id = id;
        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = `${extensionFolderPath}/css/${file}`;
        document.head.appendChild(link);
    });
}

/** 由清单路径（如 '04-features/favs.css'）生成 <link> 的 id */
export function cssLinkId(file) {
    return `titania-css-${file.replace(/\.css$/, '').replace(/\//g, '-')}`;
}

/**
 * 按需确保某个功能 CSS 已加载（storyOutlineWindow 使用）。
 *
 * 这是除 build.js 与 loadCssFiles 之外的又一处 CSS 加载点，原先硬编码
 * `css/story-outline.css` 扁平路径，目录分层后会 404。
 * 现统一从 manifest 解析路径，且 id 与 loadCssFiles 一致 —— 于是开发模式下它
 * 天然成为空操作（文件已由 loadCssFiles 加载），打包模式下补一个 <link>。
 *
 * 打包模式下的后置 <link> 会改变 feature CSS 的加载顺序，因此 feature 规则必须
 * 自带作用域。story-outline 的 dialog 尺寸已由 `.t-dialog-overlay--outline`
 * 限定，不再随窗口的打开顺序变化。
 */
export function ensureFeatureCss(fileName) {
    const file = cssFileList().find(p => p.endsWith(`/${fileName}`));
    if (!file) {
        console.warn(`[Titania] ensureFeatureCss: ${fileName} 不在 css/manifest.js 清单中`);
        return;
    }
    const id = cssLinkId(file);
    if (document.getElementById(id)) return;

    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = `${extensionFolderPath}/css/${file}`;
    document.head.appendChild(link);
}
