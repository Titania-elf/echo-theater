// src/ui/mainWindow/topBar.js
//
// 主界面第二栏（`.t-top-bar`）的单一事实来源。
//
// 这一栏管三件事：读不读聊天历史、用哪种生成模式、当前是哪个剧本。
// 两套布局（modern / legacy）的这一栏**完全一样**，此前是两份逐字节相同的
// 48 行内联 HTML —— 抽到这里之前它们已经具备了漂移的全部条件。
// CLAUDE.md 记着同一类事故：CSS 文件清单写过两份并已漂移，导致开发模式下整窗无样式。
//
// 本模块刻意不 import mainWindow.js：动作实现（开关的 change、模式菜单、
// 剧本选择器、筛选、骰子）全部留在 mainWindow.js 统一绑定，
// 这里只负责「有哪些控件、怎么排、渲染成什么」，避免布局 → 主窗口的循环依赖。
// 这与同目录 headerActions.js 的分工一致。
//
// ── 为什么是「单行胶囊条」──
// 按 950px 窗口实测，改版前这一栏的空间分配是反的：两个几乎不动的布尔开关
// 写死 min-width 160px / 150px 拿走 36%，而界面唯一的主角（当前是哪个剧本）
// 只剩 188px —— 减掉内边距与分类标签，简介实际只能显示约 10 个字，
// 等于渲染了但没传达信息。现在剧本卡拿到约 620px。

import { GlobalState } from "../../core/state.js";

/**
 * 生成模式注册表 —— 模式的单一事实来源。
 *
 * ⚠ id 同时用于 DOM（data-mode）与持久化（data.config.generation_mode），
 *   改 id 等于破坏用户已存配置。
 *
 * hint 只有 preset 有：那是改版前挂在「📋 选用预设」上的原文，
 * 另两个模式改版前也没有说明文字，这里不替它们编造。
 */
export const GENERATION_MODES = [
    { id: "narrative", icon: "📖", label: "内容优先", hint: "" },
    { id: "visual", icon: "🎨", label: "氛围美化", hint: "" },
    { id: "preset", icon: "📋", label: "选用预设", hint: "使用设置页中选定的用户预设" }
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
 * 桌面端四个直接子项从左到右：模式胶囊 → 剧本卡（吃掉全部余量）→
 * 历史开关组 → 筛选/骰子。窄屏靠 order + flex-wrap 把剧本卡换到第二行，
 * 三个控件簇共占第一行（改版前是三行）。
 *
 * ⚠ 下面模板里的缩进**刻意与本文件的缩进层级不符**：16/20/24 空格是这段
 *   HTML 在 layout 模板里的绝对缩进。调用点写成 `            ${renderTopBarHtml()}`，
 *   首行的 12 个空格由 layout 提供，其余各行的缩进必须由本字符串自带。
 *
 * @returns {string}
 */
export function renderTopBarHtml() {
    const mode = getGenerationModeMeta(GlobalState.generationMode);

    return `<div class="t-top-bar">
                <button type="button" class="t-mode-chip" id="t-mode-toggle" title="生成模式：${mode.label}" aria-haspopup="menu" aria-expanded="false">
                    <span class="t-mode-chip-icon" id="t-mode-icon">${mode.icon}</span>
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
                        <span class="t-topbar-toggle-icon">📜</span>
                        <span class="t-topbar-toggle-text">读取聊天历史</span>
                    </label>
                    <label class="t-topbar-toggle t-subtoggle" id="t-ai-only-toggle" title="${HISTORY_AI_ONLY_HINT}">
                        <input type="checkbox" id="t-history-ai-only" ${GlobalState.historyAiOnly ? 'checked' : ''}>
                        <span class="t-topbar-toggle-icon">🎭</span>
                        <span class="t-topbar-toggle-text">只要角色发言</span>
                    </label>
                </div>

                <div class="t-trigger-actions">
                    <div class="t-filter-btn" id="t-btn-filter" title="筛选随机范围">
                        <i class="fa-solid fa-filter"></i>
                    </div>
                    <div class="t-dice-btn" id="t-btn-dice" title="随机剧本">🎲</div>
                </div>
            </div>`;
}
