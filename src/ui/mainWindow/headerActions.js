// src/ui/mainWindow/headerActions.js
//
// 标题栏图标的单一事实来源：注册表 + 归一化 + 渲染。
//
// 顶栏图标由用户自选（最多 5 个），没上栏的自动收进「更多」弹层。
// 两套布局共用本模块产出的 HTML，改一处即可两处生效。
//
// 本模块刻意不 import mainWindow.js：动作实现留在 mainWindow.js，
// 这里只负责“有哪些项、怎么排、渲染成什么”，避免布局 → 主窗口的循环依赖。

import { getExtData, saveExtData } from "../../utils/storage.js";

/**
 * 可上栏的功能项。新增功能时只改这里，顶栏和「更多」菜单会自动同步。
 * id 同时用于 DOM（#t-btn-{id}）与持久化，改动 id 等于破坏用户已存配置。
 */
export const HEADER_ACTION_REGISTRY = [
    { id: "workshop", icon: "fa-store", label: "回声工坊" },
    { id: "favs", icon: "fa-book-bookmark", label: "回声收藏夹" },
    { id: "worldinfo", icon: "fa-book-atlas", label: "世界书筛选" },
    { id: "profiles", icon: "fa-network-wired", label: "API 方案" },
    { id: "settings", icon: "fa-gear", label: "设置" }
];

/** 顶栏最多放几个：再多手机上会跟标题抢宽度 */
export const HEADER_ACTION_MAX = 5;

/** 老用户升级后保持原样：工坊 + 收藏，其余进「更多」 */
export const HEADER_ACTION_DEFAULT = ["workshop", "favs"];

export function getHeaderActionMeta(id) {
    return HEADER_ACTION_REGISTRY.find(item => item.id === String(id || "")) || null;
}

/**
 * 丢弃未知 id、去重、截断到上限。
 * 空数组是合法结果（用户把所有项都收进了「更多」），不在这里回填默认值——
 * 默认值只在配置字段整个缺失时由 getHeaderActions 给出。
 */
export function normalizeHeaderActions(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const result = [];
    for (const raw of list) {
        const id = String(raw || "");
        if (seen.has(id) || !getHeaderActionMeta(id)) continue;
        seen.add(id);
        result.push(id);
        if (result.length >= HEADER_ACTION_MAX) break;
    }
    return result;
}

/** 当前上栏的 id 列表（按用户排定的顺序） */
export function getHeaderActions() {
    const data = getExtData();
    const saved = data.ui_prefs?.header_actions;
    // 字段缺失 = 老用户首次升级，给默认；已存在（哪怕是空数组）则尊重用户选择
    if (!Array.isArray(saved)) return [...HEADER_ACTION_DEFAULT];
    return normalizeHeaderActions(saved);
}

export function saveHeaderActions(list) {
    const data = getExtData();
    // 逐字段写入，避免覆盖 script_sort_mode / main_window_mode 等兄弟偏好
    if (!data.ui_prefs) data.ui_prefs = {};
    data.ui_prefs.header_actions = normalizeHeaderActions(list);
    saveExtData();
    return data.ui_prefs.header_actions;
}

/** 没上栏的项，按注册表顺序返回，供「更多」菜单渲染 */
export function getOverflowActions() {
    const active = new Set(getHeaderActions());
    return HEADER_ACTION_REGISTRY.filter(item => !active.has(item.id));
}

/**
 * 产出 .t-header-actions 的内部 HTML。
 * 顺序：用户选中的图标 → 「更多」（仅在有溢出项时）→ 关闭（永远最右，不可自定义）。
 */
export function renderHeaderActionsHtml() {
    const iconsHtml = getHeaderActions().map(id => {
        const meta = getHeaderActionMeta(id);
        if (!meta) return "";
        return `<i class="fa-solid ${meta.icon} t-icon-btn" id="t-btn-${meta.id}" data-header-action="${meta.id}" title="${meta.label}" role="button" tabindex="0" aria-label="${meta.label}"></i>`;
    }).join("");

    const moreHtml = getOverflowActions().length
        ? `<i class="fa-solid fa-ellipsis t-icon-btn" id="t-btn-more" data-header-action="__more__" title="更多" role="button" tabindex="0" aria-label="更多"></i>`
        : "";

    return `${iconsHtml}${moreHtml}<span class="t-close" id="t-btn-close">&times;</span>`;
}
