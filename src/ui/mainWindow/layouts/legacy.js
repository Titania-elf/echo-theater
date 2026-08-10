// src/ui/mainWindow/layouts/legacy.js
//
// 5.1.2 版主界面布局（经典版）：底部 2x2 工具网格 + 双演绎按钮 + 弹出式内容工具面板。
//
// 说明：本模块只还原 5.1.2 的「外观与布局」，所有业务逻辑一律走 5.1.5 的共享实现。
// 5.1.5 修复的问题（收藏资格校验、生成状态下操作目标不明确等）在经典版同样生效。
//
// 布局模块契约与 modern.js 一致：id / renderHtml / bindEvents / syncRunButtons。

import { GlobalState } from "../../../core/state.js";
import { handleGenerate } from "../../../core/api.js";

export const id = "legacy";

/**
 * 产出主界面骨架（5.1.2 结构）
 * @param {{ defaultCtx: { charName: string } }} viewData
 */
export function renderHtml(viewData) {
    const { defaultCtx } = viewData;

    return `
    <div id="t-overlay" class="t-overlay">
        <div class="t-box" id="t-main-view">

            <div class="t-header" style="flex-shrink:0;">
                <div class="t-title-container" style="display:flex; flex-direction:column; overflow:hidden;">
                    <div class="t-title-main" style="white-space:nowrap;">回声小剧场</div>
                    <div class="t-title-sub" id="t-title-sub">
                        ✨ 主演: <span id="t-char-name">${defaultCtx.charName}</span>
                    </div>
                </div>
                <div class="t-header-actions">
                    <i class="fa-solid fa-store t-icon-btn" id="t-btn-workshop" title="回声工坊"></i>
                    <i class="fa-solid fa-book-bookmark t-icon-btn" id="t-btn-favs" title="回声收藏夹"></i>
                    <i class="fa-solid fa-ellipsis t-icon-btn" id="t-btn-more" title="更多"></i>
                    <span class="t-close" id="t-btn-close">&times;</span>
                </div>
            </div>

            <div class="t-top-bar">
                <div class="t-history-toggle" id="t-history-toggle">
                    <label class="t-toggle-label">
                        <input type="checkbox" id="t-use-history" ${GlobalState.useHistoryAnalysis ? 'checked' : ''}>
                        <span class="t-toggle-text">📜 读取聊天历史</span>
                    </label>
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

                    <div class="t-action-group">
                        <div class="t-filter-btn" id="t-btn-filter" title="筛选随机范围">
                            <i class="fa-solid fa-filter"></i>
                        </div>
                        <div class="t-dice-btn" id="t-btn-dice" title="随机剧本">🎲</div>
                    </div>
                </div>
            </div>

            <div class="t-content-wrapper">
                <div class="t-stats-hud" id="t-stats-hud" style="display:none;">
                    <span class="t-stats-item"><span class="t-stats-label">模型</span><span class="t-stats-value" id="t-stat-model">-</span></span>
                    <span class="t-stats-sep">|</span>
                    <span class="t-stats-item"><span class="t-stats-label">字符</span><span class="t-stats-value" id="t-stat-total">0</span></span>
                    <span class="t-stats-sep">|</span>
                    <span class="t-stats-item"><span class="t-stats-label">中文</span><span class="t-stats-value" id="t-stat-chinese">0</span></span>
                    <span class="t-stats-sep">|</span>
                    <span class="t-stats-item"><span class="t-stats-label">耗时</span><span class="t-stats-value" id="t-stat-time">-</span></span>
                </div>
                <div class="t-tools-btn" id="t-btn-tools" title="内容工具"><i class="fa-solid fa-ellipsis-vertical"></i></div>
                <div class="t-tools-panel" id="t-tools-panel" style="display:none;">
                    <div class="t-tools-item" id="t-tool-zen">
                        <i class="fa-solid fa-expand"></i>
                        <span>沉浸阅读</span>
                    </div>
                    <div class="t-tools-item" id="t-tool-continue">
                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                        <span>主动续写</span>
                    </div>
                    <div class="t-tools-item" id="t-tool-continuation-history">
                        <i class="fa-solid fa-clock-rotate-left"></i>
                        <span>续写历史</span>
                    </div>
                    <div class="t-tools-item" id="t-tool-edit-content">
                        <i class="fa-solid fa-pen-nib"></i>
                        <span>编辑内容</span>
                    </div>
                </div>
                <div class="t-content-area">
                    <!-- 翻页按钮移到内容区两侧 -->
                    <button class="t-page-nav t-page-prev" id="t-nav-prev" title="上一个剧场" style="display:none;" disabled>&lt;</button>
                    <button class="t-page-nav t-page-next" id="t-nav-next" title="下一个剧场" style="display:none;" disabled>&gt;</button>
                    <div class="t-page-indicator" id="t-page-indicator" style="display:none;">1/1</div>
                    <div class="t-cont-inline-actions" id="t-cont-inline-actions" style="display:none;">
                        <span id="t-cont-inline-label"></span>
                        <div class="t-cont-inline-branch-menu" id="t-cont-inline-branch-menu">
                            <div class="t-cont-inline-branch-option">
                                <span>修改指令</span>
                                <button id="t-cont-inline-edit-regenerate" type="button" title="修改指令并创建分支" aria-label="修改指令并创建分支"><i class="fa-solid fa-pen"></i></button>
                            </div>
                            <div class="t-cont-inline-branch-option">
                                <span>直接重生成</span>
                                <button id="t-cont-inline-regenerate" type="button" title="使用原指令创建分支" aria-label="使用原指令创建分支"><i class="fa-solid fa-rotate"></i></button>
                            </div>
                        </div>
                        <button id="t-cont-inline-branch" type="button" title="分支操作" aria-label="展开分支操作" aria-expanded="false"><i class="fa-solid fa-code-branch"></i></button>
                    </div>
                    <div id="t-output-content"></div>
                </div>
            </div>

            <div class="t-bottom-bar">
            <!-- 左侧：2x2 工具网格 -->
            <div class="t-bot-left">
                <button class="t-btn-grid" id="t-btn-debug" title="审查 Prompt"><i class="fa-solid fa-eye"></i></button>
                <button class="t-btn-grid" id="t-btn-copy" title="复制源码"><i class="fa-regular fa-copy"></i></button>
                <button class="t-btn-grid" id="t-btn-like" title="收藏结果"><i class="fa-regular fa-heart"></i></button>
                <button class="t-btn-grid" id="t-btn-new" title="新建剧本"><i class="fa-solid fa-plus"></i></button>
            </div>

            <!-- 中间：双按钮演绎区 -->
            <div class="t-bot-center">
                <div class="t-run-group">
                    <button class="t-run-btn t-run-single" id="t-btn-run-single" title="单次演绎当前剧本">
                        <i class="fa-solid fa-clapperboard"></i>
                        <span>单次演绎</span>
                    </button>
                    <button class="t-run-btn t-run-queue" id="t-btn-run-queue" title="批量队列生成">
                        <i class="fa-solid fa-layer-group"></i>
                        <span>队列生成</span>
                    </button>
                </div>
            </div>

            <!-- 右侧：辅助操作区 -->
            <div class="t-bot-right">
                <button class="t-btn-aux" id="t-btn-queue-settings" title="队列设置">
                    <i class="fa-solid fa-sliders"></i>
                </button>
                <button class="t-btn-aux" id="t-btn-edit" title="编辑当前剧本">
                    <i class="fa-solid fa-pen-to-square"></i>
                </button>
                <button class="t-btn-aux t-btn-stop" id="t-btn-stop" title="中止生成">
                    <i class="fa-solid fa-stop"></i>
                </button>
                <button class="t-btn-aux t-btn-diag" id="t-btn-diagnostics" title="诊断日志">
                    <i class="fa-solid fa-stethoscope"></i>
                </button>
            </div>
        </div>
    </div>`;
}

/**
 * 绑定本布局独有的交互
 * @param {object} ctx mainWindow.js 提供的共享能力
 */
export function bindEvents(ctx) {
    const {
        closeWindow,
        registerTeardown,
        runContinuation,
        openContinuationHistory,
        openContinuationComposer
    } = ctx;

    const $toolsPanel = $("#t-tools-panel");
    const $toolsBtn = $("#t-btn-tools");

    const hideToolsPanel = () => {
        $toolsPanel.hide();
        $toolsBtn.removeClass("active");
    };

    // --- 弹出式内容工具面板 ---

    $toolsBtn.on("click", function (e) {
        e.stopPropagation();
        const isVisible = $toolsPanel.is(":visible");
        $toolsPanel.toggle(!isVisible);
        $(this).toggleClass("active", !isVisible);
    });

    $(document).on("click.toolspanel", function (e) {
        if (!$(e.target).closest("#t-tools-panel, #t-btn-tools").length) {
            hideToolsPanel();
        }
    });

    // 经典版所有工具入口都在面板内，点任一项都要收起面板。
    // 委托到面板容器，避免与共享层已有的 #t-tool-zen / #t-tool-edit-content 绑定重复；
    // 委托晚于直接绑定触发，故此时 t-zen-mode 已是切换后的状态，可直接读取。
    $toolsPanel.on("click", ".t-tools-item", function () {
        hideToolsPanel();
        $toolsBtn.toggleClass("zen-active", $("#t-main-view").hasClass("t-zen-mode"));
    });

    // --- 主动续写（经典版走完整编辑器） ---

    // runContinuation 已内含生成中拦截、取消与转历史的处理，这里直接透传结果。
    $("#t-tool-continue").on("click", async function () {
        const composeResult = await openContinuationComposer("");
        await runContinuation(composeResult);
    });

    // 5.1.5 新增的续写历史在经典版没有原生入口，补进工具面板以免丢失能力
    $("#t-tool-continuation-history").on("click", function () {
        openContinuationHistory("");
    });

    // --- 单次演绎 ---

    $("#t-btn-run-single").on("click", () => {
        if (GlobalState.isGenerating || GlobalState.queueState.isRunning) {
            if (window.toastr) toastr.info("正在生成中，请稍候...", "Titania");
            return;
        }
        closeWindow();
        handleGenerate(null, false);
    });

    // 关闭窗口时解绑本布局挂在 document 上的监听
    registerTeardown(() => {
        $(document).off("click.toolspanel");
    });
}

/**
 * 生成状态变化时刷新本布局的按钮
 * 由 mainWindow.js 的 updateRunButtonsState 调用
 */
export function syncRunButtons({ isGenerating, isQueueRunning }) {
    const $singleBtn = $("#t-btn-run-single");
    const $queueBtn = $("#t-btn-run-queue");

    if (!$singleBtn.length || !$queueBtn.length) return;

    const busy = isGenerating || isQueueRunning;
    $singleBtn.prop("disabled", busy);
    $queueBtn.prop("disabled", busy);
}
