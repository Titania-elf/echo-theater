// src/ui/mainWindow/topBar.js
//
// 主界面第二栏（`.t-top-bar`）的单一事实来源。
//
// 这一栏管三件事：读不读聊天历史、用哪种生成模式、当前是哪个剧本。
//
// ── 为什么这里有两套布局 ──
// 两套布局的这一栏原本**完全一样**（是两份逐字节相同的 48 行内联 HTML，
// 由 95c5aaa 抽到本文件）。「第二栏 4/5」(1f6c74b) 把它重做成单行胶囊条之后，
// 经典版跟着一起变了 —— 但经典版的定位就是「保留 5.1.2 的观感」，
// 这一栏被顺带现代化并不是它想要的。现在按布局分叉：
//   modern —— 单行胶囊条（4/5 之后的样子）
//   legacy —— 三簇布局（4/5 之前的样子，图标换成 FontAwesome）
//
// ⚠ 分叉的是**外观**，不是逻辑。两个变体的控件 id 全部相同
//   （#t-use-history / #t-history-ai-only / #t-trigger-btn / #t-btn-filter /
//   #t-btn-dice / #t-lbl-name / #t-lbl-cat / #t-lbl-desc-mini），
//   所以 mainWindow.js 里按 id 绑定的那些一律不用动。
//   唯一的例外是 #t-mode-toggle：它在两版里是不同元素、不同角色，见下方注释。
//
// 本模块刻意不 import mainWindow.js：动作实现（开关的 change、模式菜单、
// 剧本选择器、筛选、骰子）全部留在 mainWindow.js 统一绑定，
// 这里只负责「有哪些控件、怎么排、渲染成什么」，避免布局 → 主窗口的循环依赖。
// 这与同目录 headerActions.js 的分工一致。
//
// ── 为什么新版是「单行胶囊条」──
// 按 950px 窗口实测，改版前这一栏的空间分配是反的：两个几乎不动的布尔开关
// 写死 min-width 160px / 150px 拿走 36%，而界面唯一的主角（当前是哪个剧本）
// 只剩 188px —— 减掉内边距与分类标签，简介实际只能显示约 10 个字，
// 等于渲染了但没传达信息。新版剧本卡拿到约 620px。
// 经典版保留原样是刻意的取舍：它换取的是与 5.1.2 一致的观感。

import { GlobalState } from "../../core/state.js";

/**
 * 生成模式注册表 —— 模式的单一事实来源。
 *
 * ⚠ id 同时用于 DOM（data-mode）与持久化（data.config.generation_mode），
 *   改 id 等于破坏用户已存配置。
 *
 * icon 是 FontAwesome 类名（不含 fa-solid 前缀），与同排的筛选/chevron
 * 同一套字形。改版前这里是 emoji，与 FA 图标在一行里基线和字重都不齐。
 *
 * hint 只有 preset 有：那是改版前挂在「选用预设」上的原文，
 * 另两个模式改版前也没有说明文字，这里不替它们编造。
 */
export const GENERATION_MODES = [
    { id: "narrative", icon: "fa-book-open", label: "内容优先", hint: "" },
    { id: "visual", icon: "fa-palette", label: "氛围美化", hint: "" },
    { id: "preset", icon: "fa-clipboard-list", label: "选用预设", hint: "使用设置页中选定的用户预设" }
];

/** 取模式元信息；id 不认识时退回第一个（narrative），与改版前默认值一致 */
export function getGenerationModeMeta(id) {
    return GENERATION_MODES.find(item => item.id === String(id || "")) || GENERATION_MODES[0];
}

/** 「只要角色发言」的说明。图标化之后 title 是唯一的解释渠道，不能丢 */
export const HISTORY_AI_ONLY_HINT =
    "只把角色的发言注入剧本生成，跳过你自己的楼层。总结和设定提取不受影响";

/**
 * 产出 `.t-top-bar` 的完整 DOM 骨架（含最外层 `<div class="t-top-bar">`）。
 *
 * 两套布局的这一栏**不再相同**：`modern` 用改版后的单行胶囊条，
 * `legacy` 用改版前（第二栏 4/5 之前）的三簇布局。分叉理由见文件头。
 *
 * ⚠ 下面两个模板里的缩进**刻意与本文件的缩进层级不符**：16/20/24/28 空格是
 *   这段 HTML 在 layout 模板里的绝对缩进。调用点写成
 *   `            ${renderTopBarHtml(id)}`，首行的 12 个空格由 layout 提供，
 *   其余各行的缩进必须由本字符串自带。
 *
 * @param {string} [variant] 布局 id（`"legacy"` | `"modern"`）。默认新版。
 * @returns {string}
 */
export function renderTopBarHtml(variant = "modern") {
    return variant === "legacy" ? renderLegacyTopBar() : renderModernTopBar();
}

/** 新版：单行胶囊条 */
function renderModernTopBar() {
    const mode = getGenerationModeMeta(GlobalState.generationMode);

    return `<div class="t-top-bar">
                <button type="button" class="t-mode-chip" id="t-mode-toggle" title="生成模式：${mode.label}" aria-haspopup="menu" aria-expanded="false">
                    <i class="fa-solid ${mode.icon} t-mode-chip-icon" id="t-mode-icon"></i>
                    <span class="t-mode-chip-label" id="t-mode-label">${mode.label}</span>
                    <i class="fa-solid fa-chevron-down t-mode-chip-caret"></i>
                </button>

                <div class="t-trigger-card" id="t-trigger-btn" title="点击切换剧本">
                    <span class="t-trigger-name" id="t-lbl-name">加载中...</span>
                    <span class="t-cat-tag" id="t-lbl-cat">分类</span>
                    <span class="t-trigger-desc" id="t-lbl-desc-mini">...</span>
                    <i class="fa-solid fa-chevron-down t-chevron"></i>
                </div>

                <div class="t-history-group">
                    <label class="t-topbar-toggle" id="t-history-toggle" title="读取聊天历史">
                        <input type="checkbox" id="t-use-history" ${GlobalState.useHistoryAnalysis ? 'checked' : ''}>
                        <i class="fa-solid fa-scroll t-topbar-toggle-icon"></i>
                        <span class="t-topbar-toggle-text">读取聊天历史</span>
                    </label>
                    <label class="t-topbar-toggle t-subtoggle" id="t-ai-only-toggle" title="${HISTORY_AI_ONLY_HINT}">
                        <input type="checkbox" id="t-history-ai-only" ${GlobalState.historyAiOnly ? 'checked' : ''}>
                        <i class="fa-solid fa-masks-theater t-topbar-toggle-icon"></i>
                        <span class="t-topbar-toggle-text">只要角色发言</span>
                    </label>
                </div>

                <div class="t-trigger-actions">
                    <div class="t-filter-btn" id="t-btn-filter" title="筛选随机范围">
                        <i class="fa-solid fa-filter"></i>
                    </div>
                    <div class="t-dice-btn" id="t-btn-dice" title="随机剧本">
                        <i class="fa-solid fa-dice"></i>
                    </div>
                </div>
            </div>`;
}

/**
 * 经典版：改版前的三簇布局（历史开关组 / 三连模式按钮 / `.t-mobile-row`）。
 *
 * 与 3151a84（第二栏 3/5）的产出有三处**刻意的**差异，除此之外逐项对应：
 *
 *   1. 图标从 emoji 换成 FontAwesome（沿用 5/5 的映射表，即 GENERATION_MODES
 *      的 icon 字段）。emoji 是彩色字形，CSS `color` 对它无效 —— 那一版开关的
 *      开/关态只能靠底色有无 + 描边 + 不透明度区分。换成字形后 color 生效，
 *      于是经典版也拿到「关态 text-faint / 开态 accent」这个明度通道。
 *   2. 剧本名的 `style="overflow:hidden; text-overflow:ellipsis;"` 内联样式
 *      移进 CSS（main-window-legacy.css 的 `.t-trigger-main > span`）。
 *      产出的外观相同，但不再给审计 A16/A17 增加 inline style 计数。
 *   3. 三个模式按钮改为从 GENERATION_MODES 渲染，而不是写死三段 HTML ——
 *      模式注册表是 id / 图标 / 文案的唯一事实来源，写死等于开第二份。
 *
 * ⚠ 容器 `#t-mode-toggle` 在两套布局里是**不同元素、不同角色**：新版是胶囊
 *   按钮本体（点开下拉菜单），经典版是三连按钮的外壳（点子项切换）。
 *   mainWindow.js 的点击绑定因此必须按 layout 分叉，不能共用一条。
 */
function renderLegacyTopBar() {
    const modeButtons = GENERATION_MODES.map(item => `
                    <div class="t-mode-btn ${GlobalState.generationMode === item.id ? 'active' : ''}" data-mode="${item.id}"${item.hint ? ` title="${item.hint}"` : ''}>
                        <i class="fa-solid ${item.icon} t-mode-btn-icon"></i>
                        <span>${item.label}</span>
                    </div>`).join('');

    return `<div class="t-top-bar">
                <div class="t-history-group">
                    <div class="t-history-toggle" id="t-history-toggle" title="读取聊天历史">
                        <label class="t-toggle-label">
                            <input type="checkbox" id="t-use-history" class="t-choice-input t-choice-input--accent t-choice-input--responsive-lg" ${GlobalState.useHistoryAnalysis ? 'checked' : ''}>
                            <i class="fa-solid fa-scroll t-toggle-icon"></i>
                            <span class="t-toggle-text">读取聊天历史</span>
                        </label>
                    </div>
                    <div class="t-history-toggle t-subtoggle" id="t-ai-only-toggle" title="${HISTORY_AI_ONLY_HINT}">
                        <label class="t-toggle-label">
                            <input type="checkbox" id="t-history-ai-only" class="t-choice-input t-choice-input--accent t-choice-input--responsive-lg" ${GlobalState.historyAiOnly ? 'checked' : ''}>
                            <i class="fa-solid fa-masks-theater t-toggle-icon"></i>
                            <span class="t-toggle-text">只要角色发言</span>
                        </label>
                    </div>
                </div>
                <div class="t-mode-toggle" id="t-mode-toggle">${modeButtons}
                </div>
                <div class="t-mobile-row">
                    <div class="t-trigger-card" id="t-trigger-btn" title="点击切换剧本">
                        <div class="t-trigger-main">
                            <span id="t-lbl-name">加载中...</span>
                        </div>
                        <div class="t-trigger-sub">
                            <span class="t-cat-tag" id="t-lbl-cat">分类</span>
                            <span id="t-lbl-desc-mini">...</span>
                        </div>
                        <i class="fa-solid fa-chevron-down t-chevron"></i>
                    </div>

                    <div class="t-trigger-actions">
                        <div class="t-filter-btn" id="t-btn-filter" title="筛选随机范围">
                            <i class="fa-solid fa-filter"></i>
                        </div>
                        <div class="t-dice-btn" id="t-btn-dice" title="随机剧本">
                            <i class="fa-solid fa-dice"></i>
                        </div>
                    </div>
                </div>
            </div>`;
}
