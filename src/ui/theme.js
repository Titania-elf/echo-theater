// src/ui/theme.js
//
// 插件 UI 深/浅主题的单一事实来源：读、写、应用，以及标题栏那个切换图标的渲染。
//
// ── 为什么单独成一个模块 ──
// applyUITheme 原先住在 settingsWindow.js 里（主题开关当时是「外观设置」分页里的
// 一对单选框）。现在切换入口改成标题栏图标，图标的 HTML 要由
// mainWindow/headerActions.js 产出 —— 而 settingsWindow.js 已经 import 了
// headerActions.js（取 HEADER_ACTION_REGISTRY / HEADER_ACTION_MAX）。
// 若把切换逻辑留在 settingsWindow.js，就成了
// headerActions → settingsWindow → headerActions 的循环依赖。
//
// 本模块只依赖 utils/storage.js，任何 UI 模块都能安全 import。
// 这与同层 mainWindow/topBar.js、mainWindow/headerActions.js 的分工思路一致：
// 一件事的「有哪些状态、怎么渲染」集中在一处，改一处两套布局同时生效。

import { getExtData, saveExtData } from "../utils/storage.js";

/** 图标的 DOM id。点击走 headerActions 那套 data-header-action 委托，不在这里绑事件 */
export const THEME_TOGGLE_ID = "t-btn-theme";

/** 委托用的动作 id。不进 HEADER_ACTION_REGISTRY —— 这是固定槽位，不参与用户自定义 */
export const THEME_TOGGLE_ACTION = "__theme__";

/**
 * 当前主题。
 * 只有 dark / light 两种，非 "light" 一律归 dark —— 与 applyUITheme 的判断保持同一口径，
 * 也与 defaults.js 的 `ui_theme: "dark"` 一致。
 * @returns {"dark"|"light"}
 */
export function getUITheme() {
    return getExtData()?.appearance?.ui_theme === "light" ? "light" : "dark";
}

/**
 * 应用插件 UI 的深/浅主题。
 *
 * 写在 documentElement 上而非 .t-root 上：token 定义在 `:root`，而 .t-root 有
 * 49 个挂载点（各窗口/弹窗/悬浮球各自一个），挨个加属性既漏又难维护。
 * 浅色覆盖用 `:root[data-t-theme="light"]`，一处属性就能覆盖全部挂载点。
 *
 * ⚠ 'dark' 走的是**移除属性**而不是设成 "dark"：深色是 theme-dark.css 里
 *   `:root` 的无条件声明，属性存在与否只决定 theme-light.css 那层是否命中。
 *   设成 data-t-theme="dark" 也能工作，但会让人以为存在第三种状态。
 */
export function applyUITheme(theme = 'dark') {
    const root = document.documentElement;
    if (theme === 'light') root.dataset.tTheme = 'light';
    else delete root.dataset.tTheme;
}

/**
 * 图标的字形与文案。
 *
 * 字形表示**当前**处于哪个主题（深色显月亮、浅色显太阳），点下去会发生什么则写在
 * title / aria-label 里 —— 图标本身没有文字，这两个属性是唯一的解释渠道。
 * 两态用不同字形而不是只改颜色：形状差异不依赖色相，天然满足 WCAG 1.4.1
 * （main-window.css 给 .t-topbar-toggle.is-on 写的也是同一条约束）。
 *
 * ⚠ 只能用 fa-solid：ST 1.14.0 没有 regular.min.css，fa-regular 会静默回落成
 *   solid 字形，靠 solid/regular 区分两态是看不出来的。
 */
function themeToggleMeta(theme) {
    return theme === "light"
        ? { glyph: "fa-sun", label: "当前浅色主题，点击切换深色" }
        : { glyph: "fa-moon", label: "当前深色主题，点击切换浅色" };
}

/**
 * 产出标题栏切换图标的 HTML。
 * 结构与 headerActions.js 里那批自选图标同构（同样是 .t-icon-btn 的 `<i>`），
 * 这样它们的尺寸、hover、focus 表现完全一致，不需要额外 CSS。
 * @returns {string}
 */
export function renderThemeToggleHtml() {
    const meta = themeToggleMeta(getUITheme());
    return `<i class="fa-solid ${meta.glyph} t-icon-btn" id="${THEME_TOGGLE_ID}"`
        + ` data-header-action="${THEME_TOGGLE_ACTION}" title="${meta.label}"`
        + ` role="button" tabindex="0" aria-label="${meta.label}"></i>`;
}

/**
 * 就地把已渲染的图标刷成当前状态（不重绘整条标题栏，避免动到兄弟图标的焦点）。
 *
 * ⚠ 图标是 FontAwesome 字形，换字形要**整条 class 重写**而不是 .text()
 *   （沿用 mainWindow.js 更新模式胶囊图标的写法）。重写时必须把 t-icon-btn 带上，
 *   否则热区、hover、focus 全部丢失 —— 样式挂在这个类上。
 */
export function updateThemeToggleUI() {
    const $icon = $(`#${THEME_TOGGLE_ID}`);
    if ($icon.length === 0) return;
    const meta = themeToggleMeta(getUITheme());
    $icon
        .attr("class", `fa-solid ${meta.glyph} t-icon-btn`)
        .attr({ title: meta.label, "aria-label": meta.label });
}

/**
 * 切换主题：写盘 + 应用 + 刷图标，一次点击全部完成。
 *
 * 立即落盘，不依赖设置窗口的「保存所有配置」—— 这是本功能的全部意义。
 * 与 headerActions.js 的 saveHeaderActions() 同一模式（勾选即存，绕过保存按钮）。
 *
 * ⚠ 逐字段写 data.appearance.ui_theme，不整体替换 appearance ——
 *   那个对象里还有悬浮球尺寸、颜色、字体缩放等兄弟字段，整体替换会把它们打掉。
 *   settingsWindow.js 的保存块正是整体替换，那里的注释记着漏字段的事故。
 *
 * @returns {"dark"|"light"} 切换后的主题
 */
export function toggleUITheme() {
    const next = getUITheme() === "light" ? "dark" : "light";
    const data = getExtData();
    if (!data.appearance) data.appearance = {};
    data.appearance.ui_theme = next;
    saveExtData();
    applyUITheme(next);
    updateThemeToggleUI();
    return next;
}
