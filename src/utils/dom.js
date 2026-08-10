// src/utils/dom.js
import { extensionFolderPath } from "../config/defaults.js";

/**
 * 确保 overlay 容器存在
 * 用于支持设置窗口等可以独立于主窗口打开的场景
 */
export function ensureOverlay() {
    if ($("#t-overlay").length === 0) {
        const overlayHtml = `<div id="t-overlay" class="t-overlay"></div>`;
        $("body").append(overlayHtml);
    }
    return $("#t-overlay");
}

// 动态加载 CSS 列表
export function loadCssFiles() {
    const cssList = [
        "base.css",
        "floating.css",
        "main-window.css",
        // 必须晚于 main-window.css：经典布局靠后置覆盖少量冲突规则
        "main-window-legacy.css",
        "settings.css",
        "manager.css",
        "favs.css",
        "debug.css",
        "lore-review.css",
        "memory-recall.css",
        "story-outline.css"
    ];

    cssList.forEach(file => {
        const id = `titania-css-${file.replace('.css', '')}`;
        if (document.getElementById(id)) return;

        const link = document.createElement("link");
        link.id = id;
        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = `${extensionFolderPath}/css/${file}`;
        document.head.appendChild(link);
    });
}
