// src/ui/mainWindow/layouts/modern.js
//
// 5.1.5 版主界面布局：响应式工具箱 + 常驻续写输入条 + 统一生成按钮。
//
// 布局模块只负责两件事：
//   1. renderHtml() —— 产出该布局的 DOM 骨架
//   2. bindEvents() —— 绑定该布局独有的交互
// 两套布局共有的按钮（关闭/收藏/筛选/骰子/历史导航等）由 mainWindow.js
// 统一绑定，不在这里重复。

import { GlobalState, getCurrentDisplayContent } from "../../../core/state.js";
import {
    handleGenerate,
    cancelGeneration,
    cancelQueueGeneration,
    getContinuationSessionStats
} from "../../../core/api.js";
import { listAllContinuationSessions } from "../../../core/continuationStore.js";
import {
    CONTINUATION_MIN_INJECT_ROUNDS,
    CONTINUATION_MAX_INJECT_ROUNDS,
    CONTINUATION_TOKEN_WARN_THRESHOLD,
    clampInjectRoundsCount,
    getContinuationDefaultInjectCount,
    saveContinuationDefaultInjectCount,
    getPendingGenerationScriptId,
    setPendingGenerationScriptId,
    getContinuationQuickDraft,
    setContinuationQuickDraft
} from "../viewState.js";
import { renderHeaderActionsHtml } from "../headerActions.js";

export const id = "modern";

/**
 * 产出主界面骨架
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
                    ${renderHeaderActionsHtml()}
                </div>
            </div>

            <div class="t-top-bar">
                <div class="t-history-toggle" id="t-history-toggle">
                    <label class="t-toggle-label">
                        <input type="checkbox" id="t-use-history" ${GlobalState.useHistoryAnalysis ? 'checked' : ''}>
                        <span class="t-toggle-text">📜 读取聊天历史</span>
                    </label>
                </div>
                <div class="t-history-toggle t-subtoggle" id="t-ai-only-toggle" title="只把角色的发言注入剧本生成，跳过你自己的楼层。总结和设定提取不受影响">
                    <label class="t-toggle-label">
                        <input type="checkbox" id="t-history-ai-only" ${GlobalState.historyAiOnly ? 'checked' : ''}>
                        <span class="t-toggle-text">🎭 只要角色发言</span>
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
                <div class="t-tools-rail" id="t-tools-rail">
                    <button class="t-tools-icon" id="t-tool-zen" type="button" title="沉浸阅读" aria-label="沉浸阅读">
                        <i class="fa-solid fa-expand"></i>
                    </button>
                    <button class="t-tools-icon" id="t-tool-edit-content" type="button" title="编辑内容" aria-label="编辑内容">
                        <i class="fa-solid fa-pen-nib"></i>
                    </button>
                    <button class="t-tools-icon" id="t-btn-like" type="button" title="收藏结果" aria-label="收藏结果">
                        <i class="fa-regular fa-heart"></i>
                    </button>
                    <button class="t-tools-icon" id="t-tool-workshop-feedback" type="button" title="评论工坊投稿" aria-label="评论工坊投稿" style="display:none;">
                        <i class="fa-regular fa-comment-dots"></i>
                    </button>
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
                <div class="t-toolbox-backdrop" id="t-toolbox-backdrop"></div>
                <aside class="t-toolbox-panel" id="t-toolbox-panel" aria-hidden="true">
                    <div class="t-toolbox-header">
                        <div><strong>工具箱</strong><span>创作辅助与批量任务</span></div>
                        <button class="t-toolbox-close" id="t-toolbox-close" type="button" title="收起工具箱" aria-label="收起工具箱"><i class="fa-solid fa-chevron-right"></i></button>
                    </div>
                    <div class="t-toolbox-body">
                        <section class="t-toolbox-section">
                            <div class="t-toolbox-section-title">内容操作</div>
                            <div class="t-toolbox-grid">
                                <button class="t-toolbox-action t-toolbox-action-wide" id="t-btn-copy" type="button"><i class="fa-regular fa-copy"></i><span>复制源码</span></button>
                            </div>
                        </section>
                        <section class="t-toolbox-section">
                            <div class="t-toolbox-section-title">剧本管理</div>
                            <div class="t-toolbox-grid">
                                <button class="t-toolbox-action" id="t-btn-new" type="button"><i class="fa-solid fa-plus"></i><span>新建剧本</span></button>
                                <button class="t-toolbox-action" id="t-btn-edit" type="button"><i class="fa-solid fa-pen-to-square"></i><span>编辑剧本</span></button>
                                <button class="t-toolbox-action t-toolbox-action-wide" id="t-btn-regenerate" type="button"><i class="fa-solid fa-rotate"></i><span>重新演绎当前剧本</span></button>
                            </div>
                        </section>
                        <section class="t-toolbox-section">
                            <div class="t-toolbox-section-title">队列生成</div>
                            <div class="t-toolbox-grid">
                                <button class="t-toolbox-action t-toolbox-queue" id="t-btn-run-queue" type="button"><i class="fa-solid fa-layer-group"></i><span>开始队列</span></button>
                                <button class="t-toolbox-action" id="t-btn-queue-settings" type="button"><i class="fa-solid fa-sliders"></i><span>队列设置</span></button>
                            </div>
                        </section>
                        <section class="t-toolbox-section">
                            <div class="t-toolbox-section-title">检查与诊断</div>
                            <div class="t-toolbox-grid">
                                <button class="t-toolbox-action" id="t-btn-debug" type="button"><i class="fa-solid fa-eye"></i><span>审查 Prompt</span></button>
                                <button class="t-toolbox-action t-btn-diag" id="t-btn-diagnostics" type="button"><i class="fa-solid fa-stethoscope"></i><span>诊断日志</span></button>
                            </div>
                        </section>
                    </div>
                    <button class="t-toolbox-stop" id="t-btn-stop" type="button"><i class="fa-solid fa-stop"></i><span>中止当前生成</span></button>
                </aside>
            </div>

            <div class="t-bottom-bar">
                <div class="t-continuation-stack">
                    <div class="t-continuation-shortcuts-row">
                        <div class="t-continuation-shortcuts" id="t-continuation-shortcuts">
                            <button type="button" class="t-shortcut-btn" data-instruction="">自然续写</button>
                            <button type="button" class="t-shortcut-btn" data-instruction="推进剧情发展，引入新的进展或冲突，不要停滞在当前场景。">推进剧情</button>
                            <button type="button" class="t-shortcut-btn" data-instruction="制造一个意外转折，打破当前的平衡状态。">制造转折</button>
                            <button type="button" class="t-shortcut-btn" data-instruction="深化角色情感，展现内心冲突与细腻的心理变化。">深化情感</button>
                        </div>
                        <div class="t-continuation-shortcuts-fixed">
                            <button type="button" class="t-shortcut-btn t-shortcut-compose" id="t-btn-continuation-compose" title="打开完整编辑器"><i class="fa-solid fa-expand"></i> 完整编辑器</button>
                            <button type="button" class="t-shortcut-btn t-shortcut-toolbox t-toolbox-toggle" title="打开工具箱" aria-label="打开工具箱" aria-expanded="false"><i class="fa-solid fa-toolbox"></i> 工具</button>
                        </div>
                    </div>
                    <div class="t-continuation-quick">
                        <button class="t-continuation-history-btn" id="t-btn-continuation-history" type="button" title="主动续写聊天历史" aria-label="打开主动续写聊天历史">
                            <i class="fa-solid fa-clock-rotate-left"></i><span id="t-continuation-history-count">0</span>
                        </button>
                        <div class="t-continuation-input-wrap">
                            <textarea id="t-continuation-quick-input" rows="1" placeholder="输入续写指令..." aria-label="续写指令"></textarea>
                        </div>
                        <button class="t-continuation-context-btn" id="t-btn-continuation-context" type="button" title="续写上下文" aria-label="设置续写上下文" aria-expanded="false">
                            <i class="fa-solid fa-layer-group"></i><span id="t-continuation-context-count">${getContinuationDefaultInjectCount()}</span>
                        </button>
                        <button class="t-continuation-replay" id="t-btn-continuation-replay" type="button" title="重新演绎当前剧本" aria-label="重新演绎当前剧本">
                            <i class="fa-solid fa-rotate"></i>
                        </button>
                        <button class="t-continuation-send" id="t-btn-continuation-send" type="button" title="发送" aria-label="发送">
                            <i class="fa-solid fa-paper-plane"></i>
                        </button>
                        <div class="t-continuation-context-popover" id="t-continuation-context-popover" hidden>
                            <div class="t-continuation-context-head"><strong>续写上下文</strong><span>注入最近续写记录</span></div>
                            <div class="t-continuation-stepper">
                                <button id="t-continuation-context-minus" type="button" aria-label="减少续写上下文"><i class="fa-solid fa-minus"></i></button>
                                <span><strong id="t-continuation-context-value">${getContinuationDefaultInjectCount()}</strong> 轮</span>
                                <button id="t-continuation-context-plus" type="button" aria-label="增加续写上下文"><i class="fa-solid fa-plus"></i></button>
                            </div>
                            <div class="t-continuation-context-stats" id="t-continuation-context-stats"></div>
                        </div>
                    </div>
                </div>
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

    // --- 底部常驻续写输入条 ---

    const $quickInput = $("#t-continuation-quick-input");
    const $contextPopover = $("#t-continuation-context-popover");
    let quickInjectRounds = getContinuationDefaultInjectCount();

    const getQuickScriptId = () => {
        const display = getCurrentDisplayContent();
        return display?.scriptId || GlobalState.lastGeneratedScriptId || GlobalState.lastUsedScriptId || "";
    };

    const getQuickAction = () => {
        if (GlobalState.isGenerating || GlobalState.queueState.isRunning) return "stop";
        const display = getCurrentDisplayContent();
        if (getPendingGenerationScriptId() || !display?.content?.trim()) return "generate";
        return String($quickInput.val() || "").trim() ? "instruct" : "continue";
    };

    const updateQuickSendState = () => {
        setContinuationQuickDraft(String($quickInput.val() || ""));
        const action = getQuickAction();
        const scriptName = GlobalState.runtimeScripts.find(item => item.id === (getPendingGenerationScriptId() || GlobalState.lastUsedScriptId))?.name || "当前剧本";
        const config = {
            generate: { icon: "fa-solid fa-clapperboard", title: "演绎当前剧本", placeholder: `准备演绎《${scriptName}》` },
            continue: { icon: "fa-solid fa-forward-step", title: "自然续写", placeholder: "输入续写指令，留空自然续写..." },
            instruct: { icon: "fa-solid fa-paper-plane", title: "按指令续写", placeholder: "输入续写指令，留空自然续写..." },
            stop: { icon: "fa-solid fa-stop", title: "中止当前生成", placeholder: "正在生成..." }
        }[action];
        $("#t-btn-continuation-send")
            .attr({ title: config.title, "aria-label": config.title, "data-action": action })
            .toggleClass("is-stop", action === "stop")
            .prop("disabled", false)
            .find("i").attr("class", config.icon);
        $quickInput.attr("placeholder", config.placeholder).prop("disabled", action === "generate" || action === "stop");
        $("#t-btn-continuation-context").prop("disabled", action === "generate" || action === "stop");
        updateReplayState(action);
    };

    /**
     * 重演按钮的可用性。
     * 发送键在有内容后会翻成「续写」，此时没有任何入口能重跑首轮 ——
     * 这个按钮就是补那个缺口，跟续写轮的重生成是两回事。
     */
    const updateReplayState = (action) => {
        const hasContent = !!getCurrentDisplayContent()?.content?.trim();
        const busy = action === "stop";
        // 输入框有字说明用户在写续写指令，这时点重演会把它丢掉
        const drafting = !!String($quickInput.val() || "").trim();
        const disabled = busy || !hasContent || drafting;

        $("#t-btn-continuation-replay")
            .prop("disabled", disabled)
            .attr("title", drafting
                ? "清空输入框后可重新演绎"
                : (hasContent ? "重新演绎当前剧本" : "还没有可重演的内容"));
    };

    const updateContextPopover = () => {
        const stats = getContinuationSessionStats(getQuickScriptId(), quickInjectRounds);
        $("#t-continuation-context-count, #t-continuation-context-value").text(quickInjectRounds);
        $("#t-continuation-context-stats").html(`当前续写链 ${stats.totalRounds} 轮<br>预计注入 ${stats.estimatedChars.toLocaleString()} 字 · 约 ${stats.estimatedTokens.toLocaleString()} tokens`)
            .toggleClass("is-warning", stats.estimatedTokens > CONTINUATION_TOKEN_WARN_THRESHOLD);
        $("#t-continuation-context-minus").prop("disabled", quickInjectRounds <= CONTINUATION_MIN_INJECT_ROUNDS);
        $("#t-continuation-context-plus").prop("disabled", quickInjectRounds >= CONTINUATION_MAX_INJECT_ROUNDS);
    };

    const setContextPopoverOpen = (open) => {
        $contextPopover.prop("hidden", !open);
        $("#t-btn-continuation-context").attr("aria-expanded", String(open)).toggleClass("active", open);
        if (open) {
            updateContextPopover();
        }
    };

    const refreshContinuationHistoryCount = async () => {
        try {
            const source = ctx.getCurrentContinuationSource();
            const sessions = await listAllContinuationSessions();
            const count = sessions
                .filter(session => session.chatId === source.chatId)
                .reduce((total, session) => total + session.branches.reduce((sum, branch) => sum + Math.max(0, branch.rounds.length - 1), 0), 0);
            $("#t-continuation-history-count").text(count > 99 ? "99+" : count);
            $("#t-btn-continuation-history").attr("title", count ? `主动续写聊天历史（${count} 轮）` : "主动续写聊天历史");
        } catch (error) {
            console.warn("Titania: 读取主动续写历史数量失败", error);
        }
    };

    const submitQuickAction = async () => {
        const action = getQuickAction();
        if (action === "stop") {
            if (GlobalState.isGenerating) cancelGeneration();
            else if (GlobalState.queueState.isRunning) cancelQueueGeneration();
            return;
        }

        if (action === "generate") {
            const scriptId = getPendingGenerationScriptId() || GlobalState.lastUsedScriptId;
            if (!scriptId) {
                if (window.toastr) toastr.warning("当前没有选中的剧本", "Titania");
                return;
            }
            setPendingGenerationScriptId("");
            closeWindow();
            handleGenerate(scriptId, false);
            return;
        }

        const instruction = String($quickInput.val() || "").trim();
        setContextPopoverOpen(false);
        setContinuationQuickDraft("");
        $quickInput.val("");
        updateQuickSendState();
        const success = await runContinuation({ instruction, injectRoundsCount: quickInjectRounds });
        if (!success) {
            $quickInput.val(instruction);
            setContinuationQuickDraft(instruction);
            updateQuickSendState();
        }
        refreshContinuationHistoryCount();
    };

    $("#t-btn-continuation-replay").on("click", () => {
        if (GlobalState.isGenerating || GlobalState.queueState.isRunning) return;
        const scriptId = getQuickScriptId();
        if (!scriptId) {
            if (window.toastr) toastr.warning("当前没有可重演的剧本", "Titania");
            return;
        }
        closeWindow();
        // 跟首轮生成走同一条路径，结果会作为新的一页进历史，原来那次仍可翻回去
        handleGenerate(scriptId, false);
    });

    // 主动续写是底部主操作；完整编辑器承载长指令和高级操作。
    $quickInput.val(getContinuationQuickDraft()).on("input", () => {
        updateQuickSendState();
    }).on("focus", () => {
        setContextPopoverOpen(false);
    }).on("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submitQuickAction();
        }
    });

    $("#t-btn-continuation-send").on("click", submitQuickAction);
    $("#t-btn-continuation-history").on("click", () => {
        setContextPopoverOpen(false);
        openContinuationHistory(getQuickScriptId());
    });
    $("#t-btn-continuation-context").on("click", (event) => {
        event.stopPropagation();
        setContextPopoverOpen($contextPopover.prop("hidden"));
    });
    $("#t-continuation-context-minus, #t-continuation-context-plus").on("click", function () {
        quickInjectRounds = clampInjectRoundsCount(quickInjectRounds + ($(this).is("#t-continuation-context-plus") ? 1 : -1));
        saveContinuationDefaultInjectCount(quickInjectRounds);
        updateContextPopover();
    });
    $("#t-continuation-shortcuts").on("click", ".t-shortcut-btn:not(.t-shortcut-compose)", function () {
        if ($quickInput.prop("disabled")) return;
        $quickInput.val(String($(this).attr("data-instruction") || "")).trigger("input").trigger("focus");
    });
    $("#t-btn-continuation-compose").on("click", async () => {
        const result = await openContinuationComposer(String($quickInput.val() || ""));
        if (!result) return;
        if (result.openHistory) {
            openContinuationHistory(result.scriptId);
            return;
        }
        $quickInput.val(String(result.instruction || "")).trigger("input");
        quickInjectRounds = clampInjectRoundsCount(result.injectRoundsCount ?? quickInjectRounds);
        updateContextPopover();
        await submitQuickAction();
    });

    $(document).on("click.tcontinuationquick", (event) => {
        if (!$(event.target).closest("#t-continuation-context-popover, #t-btn-continuation-context").length) setContextPopoverOpen(false);
    });

    updateQuickSendState();
    updateContextPopover();
    refreshContinuationHistoryCount();

    // --- 响应式工具箱 ---

    const setToolboxOpen = (open) => {
        $("#t-main-view").toggleClass("t-toolbox-open", open);
        $("#t-toolbox-panel").attr("aria-hidden", String(!open));
        $(".t-toolbox-toggle").attr("aria-expanded", String(open));
    };

    $(".t-toolbox-toggle").on("click", (event) => {
        event.stopPropagation();
        setToolboxOpen(!$("#t-main-view").hasClass("t-toolbox-open"));
    });
    $("#t-toolbox-close, #t-toolbox-backdrop").on("click", () => setToolboxOpen(false));
    $("#t-toolbox-panel").on("click", ".t-toolbox-action", () => setToolboxOpen(false));
    $(document).on("keydown.ttoolbox", (event) => {
        if (event.key === "Escape" && $("#t-main-view").hasClass("t-toolbox-open")) {
            setToolboxOpen(false);
        }
    });

    // --- 工具箱内的“重新演绎” ---

    // 已有内容时，显式重新演绎当前选中的剧本。
    $("#t-btn-regenerate").on("click", () => {
        if (GlobalState.isGenerating || GlobalState.queueState.isRunning) {
            if (window.toastr) toastr.info("正在生成中，请稍候...", "Titania");
            return;
        }
        const scriptId = GlobalState.lastUsedScriptId || GlobalState.lastGeneratedScriptId;
        if (!scriptId) {
            if (window.toastr) toastr.warning("当前没有选中的剧本", "Titania");
            return;
        }
        closeWindow();
        handleGenerate(scriptId, false);
    });

    // 关闭窗口时解绑本布局挂在 document 上的监听
    registerTeardown(() => {
        $(document).off("keydown.ttoolbox");
        $(document).off("click.tcontinuationquick");
    });
}

/**
 * 生成状态变化时刷新本布局的按钮
 * 由 mainWindow.js 的 updateRunButtonsState 调用
 */
export function syncRunButtons({ isGenerating, isQueueRunning }) {
    const $queueBtn = $("#t-btn-run-queue");
    const $secondaryContinuationBtns = $("#t-btn-continuation-compose, #t-btn-continuation-history");
    const $stopBtn = $("#t-btn-stop");

    if (!$queueBtn.length) return;

    if (isGenerating || isQueueRunning) {
        $queueBtn.prop("disabled", true);
        $secondaryContinuationBtns.prop("disabled", true);
        $stopBtn.addClass("is-active");
    } else {
        $queueBtn.prop("disabled", false);
        $secondaryContinuationBtns.prop("disabled", false);
        $stopBtn.removeClass("is-active");
    }
    $("#t-continuation-quick-input").trigger("input");
}
