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

import { GlobalState } from "../../core/state.js";

/**
 * 产出 `.t-top-bar` 的完整 DOM 骨架（含最外层 `<div class="t-top-bar">`）。
 *
 * ⚠ 下面模板里的缩进**刻意与本文件的缩进层级不符**：16/20/24/28 空格是这段
 *   HTML 在 layout 模板里的绝对缩进。调用点写成 `            ${renderTopBarHtml()}`，
 *   首行的 12 个空格由 layout 提供，其余各行的缩进必须由本字符串自带 ——
 *   这样产出的 HTML 与抽出前逐字节相同。
 *   **不要「顺手」把它对齐到本函数的缩进**：那会改掉产出字符串（虽然 HTML
 *   语义不变，但也就此失去了「这次重构外观零变化」的机械自证能力）。
 *
 * @returns {string}
 */
export function renderTopBarHtml() {
    return `<div class="t-top-bar">
                <div class="t-history-group">
                    <div class="t-history-toggle" id="t-history-toggle">
                        <label class="t-toggle-label">
                            <input type="checkbox" id="t-use-history" class="t-choice-input t-choice-input--accent t-choice-input--responsive-lg" ${GlobalState.useHistoryAnalysis ? 'checked' : ''}>
                            <span class="t-toggle-text">📜 读取聊天历史</span>
                        </label>
                    </div>
                    <div class="t-history-toggle t-subtoggle" id="t-ai-only-toggle" title="只把角色的发言注入剧本生成，跳过你自己的楼层。总结和设定提取不受影响">
                        <label class="t-toggle-label">
                            <input type="checkbox" id="t-history-ai-only" class="t-choice-input t-choice-input--accent t-choice-input--responsive-lg" ${GlobalState.historyAiOnly ? 'checked' : ''}>
                            <span class="t-toggle-text">🎭 只要角色发言</span>
                        </label>
                    </div>
                </div>
                <div class="t-mode-toggle" id="t-mode-toggle">
                    <div class="t-mode-btn ${GlobalState.generationMode === 'narrative' ? 'active' : ''}" data-mode="narrative">
                        <span>📖 内容优先</span>
                    </div>
                    <div class="t-mode-btn ${GlobalState.generationMode === 'visual' ? 'active' : ''}" data-mode="visual">
                        <span>🎨 氛围美化</span>
                    </div>
                    <div class="t-mode-btn ${GlobalState.generationMode === 'preset' ? 'active' : ''}" data-mode="preset" title="使用设置页中选定的用户预设">
                        <span>📋 选用预设</span>
                    </div>
                </div>
                <div class="t-mobile-row">
                    <div class="t-trigger-card" id="t-trigger-btn" title="点击切换剧本">
                        <div class="t-trigger-main">
                            <span id="t-lbl-name" style="overflow:hidden; text-overflow:ellipsis;">加载中...</span>
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
                        <div class="t-dice-btn" id="t-btn-dice" title="随机剧本">🎲</div>
                    </div>
                </div>
            </div>`;
}
