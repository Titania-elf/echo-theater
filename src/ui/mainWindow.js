// src/ui/mainWindow.js

import { getExtData, saveExtData } from "../utils/storage.js";
import { ensureMainApiProfiles } from "../core/apiProfileRegistry.js";
import {
    GlobalState,
    getHistoryNavState,
    navigateToPrevHistory,
    navigateToNextHistory,
    markCurrentAsRead,
    getUnreadCount,
    setHistoryMaxItems,
    lockDisplayToHistory,
    lockDisplayToContent,
    unlockDisplay,
    shouldRenderStreamToUI,
    getEnhancedHistoryNavState,
    getCurrentDisplayContent,
    getCurrentGenerationResult,
    isFavoriteEligible,
    setCurrentGenerationResult
} from "../core/state.js";
import { getContextData, getActiveWorldInfoEntries, getAllWorldBookNames, getWorldInfoEntriesByBookName, getActiveWorldBookNames, readWorldInfoSelections, writeWorldInfoSelections } from "../core/context.js";
import { handleGenerate, handleUserContinuation, renderGeneratedContent, executeQueueGeneration, cancelQueueGeneration, cancelGeneration, getContinuationSessionStats, getContinuationBranches, copyContinuationBranchToCurrentChat, findContinuationRoundByContent, syncEditedContentToContinuationSession } from "../core/api.js";
import { openFavsWindow, saveFavorite, unsaveFavorite } from "./favsWindow.js";
import { showDebugInfo, showDiagnosticsWindow } from "./debugWindow.js";
import { openScriptManager, openEditor } from "./scriptManager.js";
import { showLoreReviewWindow } from "./loreReviewWindow.js";
import { openSettingsWindow } from "./settingsWindow.js";
import { countContentStats } from "../utils/helpers.js";
import { WORKSHOP_ORIGIN } from "../core/workshopApi.js";
import { clearContinuationForCurrentChat, listAllContinuationSessions, deleteGlobalContinuationSelections, getCurrentContinuationSource } from "../core/continuationStore.js";
import {
    getScriptSortMode,
    setScriptSortMode,
    sortScripts,
    createScriptStatsReader,
    recordScriptSelected
} from "../core/scriptData.js";
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
} from "./mainWindow/viewState.js";
import * as modernLayout from "./mainWindow/layouts/modern.js";
import * as legacyLayout from "./mainWindow/layouts/legacy.js";
import {
    HEADER_ACTION_MAX,
    getHeaderActions,
    saveHeaderActions,
    getOverflowActions,
    renderHeaderActionsHtml
} from "./mainWindow/headerActions.js";

const SORT_MODE_LABELS = {
    default: "默认顺序",
    smart: "智能排序",
    recent_added: "最近添加",
    recent_generated: "最近使用",
    most_used: "最常使用",
    name_asc: "名称 A-Z",
    name_desc: "名称 Z-A"
};

function formatRelativeTime(ts) {
    const time = Number(ts) || 0;
    if (!time) return "未使用";
    const diff = Date.now() - time;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 86400000 * 30) return `${Math.floor(diff / 86400000)} 天前`;
    return new Date(time).toLocaleDateString("zh-CN");
}

const CONTINUATION_RECENT_MAX = 10;
let continuationHistoryView = null;
let continuationHistoryManaging = false;
let continuationHistorySelection = new Set();
let continuationGlobalSessions = [];
let continuationHistoryScope = "all";

export function getContinuationHistoryView() {
    return continuationHistoryView;
}

export function setContinuationHistoryView(view) {
    continuationHistoryView = view;
}

// 当前布局注册的清理回调，closeWindow 时依次执行
let layoutTeardownHooks = [];

// 当前激活的布局模块，供 updateRunButtonsState 等分派到对应实现
let activeLayout = null;

export function registerTeardown(fn) {
    if (typeof fn === "function") layoutTeardownHooks.push(fn);
}

/** 更新过滤按钮的 UI 状态 */
export function updateFilterUI() {
    const btn = $("#t-btn-filter");
    const dice = $("#t-btn-dice");

    if (GlobalState.currentCategoryFilter === "ALL") {
        btn.removeClass("active-filter");
        dice.removeClass("active-filter");
        btn.attr("title", "当前：全部分类");
    } else {
        btn.addClass("active-filter");
        dice.addClass("active-filter");
        btn.attr("title", `当前锁定：${GlobalState.currentCategoryFilter}`);
    }
}

/** 更新历史开关 UI */
export function updateHistoryToggleUI() {
    const $toggle = $("#t-history-toggle");
    const $checkbox = $("#t-use-history");

    if (GlobalState.useHistoryAnalysis) {
        $toggle.addClass("active");
    } else {
        $toggle.removeClass("active");
    }
    $checkbox.prop("checked", GlobalState.useHistoryAnalysis);

    // 「只要角色发言」是历史开关的子项：不读历史时它没有意义，置灰并禁用。
    // 这里只改可用状态，不动 GlobalState.historyAiOnly —— 重新开启历史后要恢复用户原来的选择
    const $aiOnly = $("#t-ai-only-toggle");
    const $aiOnlyBox = $("#t-history-ai-only");
    $aiOnly.toggleClass("disabled", !GlobalState.useHistoryAnalysis);
    $aiOnly.toggleClass("active", GlobalState.useHistoryAnalysis && GlobalState.historyAiOnly);
    $aiOnlyBox.prop("disabled", !GlobalState.useHistoryAnalysis);
    $aiOnlyBox.prop("checked", GlobalState.historyAiOnly);
}

/** 更新生成模式 UI */
export function updateModeToggleUI() {
    $(".t-mode-btn").removeClass("active");
    $(`.t-mode-btn[data-mode="${GlobalState.generationMode}"]`).addClass("active");
}

/** 随机抽取逻辑（不再按模式过滤） */
export function handleRandom() {
    const allScripts = GlobalState.runtimeScripts;

    // 如果没有任何剧本，直接返回
    if (allScripts.length === 0) {
        if (window.toastr) toastr.warning("暂无可用剧本。", "Titania");
        $("#t-lbl-name").text("暂无剧本");
        $("#t-lbl-cat").text("无分类");
        $("#t-lbl-desc-mini").text("请创建或导入剧本");
        return;
    }

    let pool = allScripts;

    if (GlobalState.currentCategoryFilter !== "ALL") {
        pool = pool.filter(s => (s.category || (s._type === 'preset' ? '官方预设' : '未分类')) === GlobalState.currentCategoryFilter);
    }

    // 如果当前分类下没有剧本，则重置为全部
    if (pool.length === 0) {
        if (window.toastr) toastr.warning(`没找到 [${GlobalState.currentCategoryFilter}] 分类的剧本，已切换到全部。`, "Titania");
        GlobalState.currentCategoryFilter = "ALL";
        updateFilterUI();
        pool = allScripts;
    }

    const rnd = Math.floor(Math.random() * pool.length);
    const s = pool[rnd];
    applyScriptSelection(s.id, { trackSelection: false, pendingGeneration: true });

    const dice = $("#t-btn-dice");
    dice.css("transform", `rotate(${Math.random() * 360}deg) scale(1.1)`);
    setTimeout(() => dice.css("transform", "rotate(0deg) scale(1)"), 300);
}

/** 关闭主窗口，并执行当前布局注册的清理逻辑 */
export function closeWindow() {
    layoutTeardownHooks.forEach(fn => {
        try {
            fn();
        } catch (e) {
            console.warn("Titania: 布局清理失败", e);
        }
    });
    layoutTeardownHooks = [];
    activeLayout = null;
    $("#t-overlay").remove();
    $(document).off("keydown.zenmode");
    $(document).off("click.tinlinebranch");
}

function escapeHtmlText(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function getContinuationRecentInstructions() {
    const data = getExtData();
    const list = data.continuation_ui?.recent_instructions;
    if (!Array.isArray(list)) return [];

    return list
        .map(item => String(item || "").trim())
        .filter(item => item.length > 0)
        .slice(0, CONTINUATION_RECENT_MAX);
}

function saveContinuationRecentInstruction(instruction) {
    const text = String(instruction || "").trim();
    if (!text) return;

    const data = getExtData();
    if (!data.continuation_ui) data.continuation_ui = {};

    const prev = Array.isArray(data.continuation_ui.recent_instructions)
        ? data.continuation_ui.recent_instructions
        : [];

    const normalizedPrev = prev
        .map(item => String(item || "").trim())
        .filter(item => item.length > 0);

    const deduped = normalizedPrev.filter(item => item !== text);
    data.continuation_ui.recent_instructions = [text, ...deduped].slice(0, CONTINUATION_RECENT_MAX);
    saveExtData();
}

function openContinuationComposer(initialText = "", regenerationTarget = null, baseContentOverride = null) {
    return new Promise((resolve) => {
        const recent = getContinuationRecentInstructions();
        const display = baseContentOverride || getCurrentDisplayContent();
        const activeScriptId = display?.scriptId || GlobalState.lastGeneratedScriptId || GlobalState.lastUsedScriptId || $("#t-sel-script").val();
        let selectedInjectRounds = getContinuationDefaultInjectCount();

        // 清理旧弹窗（避免重复打开导致事件残留）
        $("#t-continuation-dialog").remove();
        $("#t-continuation-editor").remove();
        $(document).off("keydown.tcontinuecomposer");

        const recentHtml = recent.length > 0
            ? recent.map(item => {
                const encoded = encodeURIComponent(item);
                const display = item.length > 24 ? `${item.slice(0, 24)}…` : item;
                return `<button class="t-cont-recent-item" data-text="${encoded}" style="
                            border:1px solid #3d3d3d;
                            background:#262626;
                            color:#ddd;
                            border-radius:999px;
                            padding:6px 12px;
                            font-size:12px;
                            cursor:pointer;
                            max-width:100%;
                            overflow:hidden;
                            text-overflow:ellipsis;
                            white-space:nowrap;
                        " title="${escapeHtmlText(item)}">${escapeHtmlText(display)}</button>`;
            }).join("")
            : `<div style="color:#777; font-size:12px;">暂无最近续写指令</div>`;

        const html = `
        <div id="t-continuation-editor" class="t-content-editor">
            <div class="t-ce-header">
                <div style="display:flex; align-items:center; gap:10px;">
                    <i class="fa-solid fa-wand-magic-sparkles" style="color:#bfa15f;"></i>
                    <span style="font-weight:bold;">续写操作台</span>
                    <span style="font-size:0.8em; color:#666;">支持 Ctrl+Enter 快速发送</span>
                </div>
                <div class="t-close" id="t-cont-close">&times;</div>
            </div>

            <div class="t-ce-body" style="display:flex; flex-direction:column; gap:10px; overflow:auto;">
                <div style="color:#888; font-size:12px;">可留空表示“自然续写”；会基于当前剧场上下文继续生成。</div>

                <textarea id="t-cont-input" class="t-ce-textarea" placeholder="例如：让两人矛盾升级，但保持克制，不要立刻和解。" spellcheck="false" style="height:auto; min-height:160px; flex:1;"></textarea>

                <div style="display:flex; align-items:center; justify-content:flex-end;">
                    <div id="t-cont-char-count" style="color:#777; font-size:12px;">0 字</div>
                </div>

                <div style="display:flex; flex-direction:column; gap:8px;">
                    <div style="color:#aaa; font-size:12px;">最近使用（最多 ${CONTINUATION_RECENT_MAX} 条，点击复用）</div>
                    <div id="t-cont-recent-list" style="display:flex; gap:8px; flex-wrap:wrap; max-height:88px; overflow:auto;">${recentHtml}</div>
                </div>

                <div style="display:flex; flex-direction:column; gap:8px; border:1px solid #333; border-radius:8px; padding:10px; background:#1e1e1e;">
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
                        <div style="color:#ddd; font-size:12px;">${regenerationTarget ? "分支上下文" : "注入最近续写条数（正文+指令）"}</div>
                        <div id="t-cont-rounds-total" style="color:#9aa; font-size:12px;">已生成轮次：0</div>
                    </div>
                    <div style="display:${regenerationTarget ? "none" : "flex"}; align-items:center; gap:8px; flex-wrap:wrap;">
                        <input type="number" id="t-cont-inject-count" class="t-input" min="3" max="20" step="1" value="${selectedInjectRounds}" placeholder="请输入 3-20" style="width:100px; padding:4px 8px; font-size:12px;">
                        <span style="color:#888; font-size:12px;">条（3-20 条）</span>
                    </div>
                    <div id="t-cont-context-estimate" style="color:#9aa; font-size:12px;">${regenerationTarget ? `将完整注入目标轮之前的 ${Math.max(0, regenerationTarget.round - 1)} 轮内容` : "预估上下文长度：0 字符 (~0 tokens)"}</div>
                </div>

                ${regenerationTarget ? `<div class="t-cont-regeneration-note"><i class="fa-solid fa-code-branch"></i> 将从${escapeHtmlText(regenerationTarget.label)}创建分支并重新生成。目标轮之前的全部内容会被注入，原分支会保留。</div>` : ""}

            </div>

            <div class="t-ce-footer">
                <div class="t-ce-stats"><span id="t-cont-char-count-footer">0 字</span></div>
                <div class="t-ce-actions">
                    <button class="t-btn" id="t-cont-cancel">取消</button>
                    <button class="t-btn primary" id="t-cont-submit">${regenerationTarget ? '<i class="fa-solid fa-code-branch"></i> 创建分支并重生成' : "发送续写"}</button>
                </div>
            </div>
        </div>`;

        const $host = $("#t-main-view");
        if ($host.length) {
            $host.append(html);
        } else {
            $("body").append(html);
        }

        const $dialog = $("#t-continuation-editor");
        const $input = $("#t-cont-input");
        const $charCount = $("#t-cont-char-count");
        const $charCountFooter = $("#t-cont-char-count-footer");
        const $injectCountInput = $("#t-cont-inject-count");
        const $roundsTotal = $("#t-cont-rounds-total");
        const $contextEstimate = $("#t-cont-context-estimate");
        let resolved = false;

        const finalize = (value) => {
            if (resolved) return;
            resolved = true;
            $(document).off("keydown.tcontinuecomposer");
            $dialog.remove();
            resolve(value);
        };

        const updateCharCount = () => {
            const count = `${$input.val().length} 字`;
            $charCount.text(count);
            $charCountFooter.text(count);
        };

        const ensureHasBaseContent = () => {
            const displayContent = baseContentOverride || getCurrentDisplayContent();
            const hasContent = Boolean(displayContent?.content && displayContent.content.trim().length > 0);
            if (!hasContent) {
                if (window.toastr) toastr.warning("没有可续写的内容，请先生成场景", "Titania");
                return false;
            }
            return true;
        };

        const trySubmit = () => {
            if (!ensureHasBaseContent()) return;
            selectedInjectRounds = clampInjectRoundsCount($injectCountInput.val());
            saveContinuationDefaultInjectCount(selectedInjectRounds);
            syncInjectCountInput();
            finalize({
                instruction: $input.val(),
                injectRoundsCount: selectedInjectRounds,
                sourceBranchKey: regenerationTarget?.branchKey || "",
                regenerateRound: regenerationTarget?.round ?? null,
                regenerateRoundKey: regenerationTarget?.roundKey || ""
            });
        };

        const syncInjectCountInput = () => {
            $injectCountInput.val(selectedInjectRounds);
        };

        const updateContextEstimate = () => {
            if (regenerationTarget) {
                $roundsTotal.text(`目标：${regenerationTarget.label}`);
                return;
            }
            const stats = getContinuationSessionStats(activeScriptId, selectedInjectRounds);
            $roundsTotal.text(`已生成轮次：${stats.totalRounds}`);
            $contextEstimate.text(`预估上下文长度：${stats.estimatedChars} 字符 (~${stats.estimatedTokens} tokens)`);

            if (stats.estimatedTokens > CONTINUATION_TOKEN_WARN_THRESHOLD) {
                $contextEstimate.css({ color: "#ff7675", fontWeight: "bold" });
            } else {
                $contextEstimate.css({ color: "#9aa", fontWeight: "" });
            }
        };

        $input.val(initialText || "");
        updateCharCount();
        syncInjectCountInput();
        updateContextEstimate();
        setTimeout(() => $input.trigger("focus"), 0);

        $input.on("input", updateCharCount);

        $input.on("keydown", function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                trySubmit();
            }
        });

        $(document).on("keydown.tcontinuecomposer", function (e) {
            if (e.key === "Escape") {
                e.preventDefault();
                finalize(null);
            }
        });

        $("#t-cont-close, #t-cont-cancel").on("click", () => finalize(null));
        $("#t-cont-submit").on("click", () => trySubmit());

        $injectCountInput.on("input", function () {
            const rawValue = String($(this).val() ?? "").trim();
            if (rawValue === "") return;

            const value = Number(rawValue);
            if (!Number.isInteger(value)
                || value < CONTINUATION_MIN_INJECT_ROUNDS
                || value > CONTINUATION_MAX_INJECT_ROUNDS) {
                return;
            }

            selectedInjectRounds = value;
            saveContinuationDefaultInjectCount(selectedInjectRounds);
            updateContextEstimate();
        });

        $injectCountInput.on("change blur", function () {
            selectedInjectRounds = clampInjectRoundsCount($(this).val());
            saveContinuationDefaultInjectCount(selectedInjectRounds);
            syncInjectCountInput();
            updateContextEstimate();
        });

        $("#t-cont-recent-list").on("click", ".t-cont-recent-item", function () {
            const text = decodeURIComponent($(this).attr("data-text") || "");
            $input.val(text);
            updateCharCount();
            $input.trigger("focus");
        });
    });
}

function getContinuationRoundLabel(round) {
    return round?.type === "initial" ? "初始内容" : `续写第${round?.continuationIndex || 0}次`;
}

function getContinuationInstructionPreview(instruction, maxLength = 100) {
    const normalized = String(instruction || "（自然续写）").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}…`;
}

/**
 * 分支创建时间，格式对齐 ST 消息楼层的绝对时间（moment 的 'LL LT'，跟随 ST 语言设置）。
 * moment 由 ST 挂在 window 上；拿不到时退回 toLocaleString，不因为格式化失败就丢掉时间。
 */
function formatContinuationTimestamp(timestamp) {
    const value = Number(timestamp) || 0;
    if (!value) return "";
    if (typeof window.moment === "function") {
        const parsed = window.moment(value);
        if (parsed.isValid()) return parsed.format("LL LT");
    }
    return new Date(value).toLocaleString();
}

/**
 * 分支标题用的时间：优先分支自己的 fork 时刻，
 * 早期迁移记录可能没有 createdAt，退回该分支首轮的时间。
 */
function getContinuationBranchTime(branch) {
    return Number(branch?.createdAt) || Number(branch?.rounds?.[0]?.timestamp) || 0;
}

function findContinuationRound(scriptId, branchKey, roundKey) {
    const branch = getContinuationBranches(scriptId).find(item => item.branchKey === branchKey);
    const round = branch?.rounds.find(item => item.roundKey === roundKey);
    return branch && round ? { branch, round } : null;
}

function findGlobalContinuationRound(chatId, scriptId, branchKey, roundKey) {
    const session = continuationGlobalSessions.find(item => item.chatId === chatId && item.scriptId === scriptId);
    const branch = session?.branches.find(item => item.branchKey === branchKey);
    const round = branch?.rounds.find(item => item.roundKey === roundKey);
    return session && branch && round ? { session, branch, round } : null;
}

async function regenerateContinuationRound(scriptId, branchKey, roundKey, editInstruction = false) {
    const target = findContinuationRound(scriptId, branchKey, roundKey);
    if (!target || target.round.type === "initial") {
        if (window.toastr) toastr.warning("该续写轮次已不存在", "Titania");
        return false;
    }

    const regenerationTarget = {
        scriptId,
        branchKey,
        roundKey,
        round: target.round.round,
        label: getContinuationRoundLabel(target.round),
        content: target.round.content
    };
    let instruction = target.round.instruction || "";

    if (editInstruction) {
        const composeResult = await openContinuationComposer(instruction, regenerationTarget);
        if (!composeResult) return false;
        if (composeResult.openHistory) {
            openContinuationHistory(scriptId);
            return false;
        }
        instruction = String(composeResult.instruction || "").trim();
        if (instruction) saveContinuationRecentInstruction(instruction);
    }

    continuationHistoryView = null;
    return handleUserContinuation({
        instruction,
        sourceBranchKey: branchKey,
        regenerateRound: target.round.round,
        regenerateRoundKey: roundKey,
        scriptIdOverride: scriptId,
        baseContentOverride: target.round.content,
        fromCurrentView: false
    });
}

function showContinuationRoundInMain(chatId, scriptId, branchKey, roundKey) {
    const target = findGlobalContinuationRound(chatId, scriptId, branchKey, roundKey);
    if (!target) return false;

    continuationHistoryView = { chatId, scriptId, branchKey, roundKey };
    setPendingGenerationScriptId("");
    const scriptName = target.session.scriptName || GlobalState.runtimeScripts.find(s => s.id === scriptId)?.name || "场景";
    lockDisplayToContent(target.round.content, scriptId, scriptName, target.round.generationId);
    renderGeneratedContent(target.round.content, scriptName);
    updateSceneHistoryNav();
    if (typeof window.updateRunButtonsState === "function") window.updateRunButtonsState();
    $(document).off("keydown.tcontinuationhistory");
    $("#t-continuation-history").remove();
    return true;
}

async function openContinuationHistory(preferredScriptId = "") {
    const allSessions = await listAllContinuationSessions();
    continuationGlobalSessions = allSessions;
    const currentSource = getCurrentContinuationSource();
    const sessions = allSessions.filter(session => {
        if (continuationHistoryScope === "chat") return session.chatId === currentSource.chatId;
        if (continuationHistoryScope === "character") {
            if (session.characterAvatar && currentSource.characterAvatar) return session.characterAvatar === currentSource.characterAvatar;
            return session.characterName === currentSource.characterName;
        }
        return true;
    });
    $("#t-continuation-history").remove();
    if (allSessions.length === 0) {
        if (window.toastr) toastr.info("还没有主动续写历史", "Titania");
        return;
    }

    const preferredIndex = sessions.findIndex(session => session.scriptId === preferredScriptId);
    if (preferredIndex > 0) sessions.unshift(sessions.splice(preferredIndex, 1)[0]);

    const selectionCheckbox = (level, chatId, scriptId, branchKey = "", roundKey = "", disabled = false) => continuationHistoryManaging
        ? `<input class="t-cont-select" type="checkbox" data-selection-level="${level}" data-chat-id="${escapeHtmlText(chatId)}" data-script-id="${escapeHtmlText(scriptId)}" data-branch-key="${escapeHtmlText(branchKey)}" data-round-key="${escapeHtmlText(roundKey)}" ${disabled ? "disabled" : ""} aria-label="选择${level === "session" ? "剧本" : level === "branch" ? "分支" : "轮次"}">`
        : "";
    const sessionsHtml = sessions.map((session, sessionIndex) => {
        const isOpen = sessionIndex === 0;
        const hasActiveBranch = session.branches.some(item => item.isActive);
        // 编号按创建先后固定，不跟着显示顺序（当前分支置顶）走，
        // 否则同一条分支在不同筛选/激活状态下会换号。最早的主干不加编号。
        const branchNumbers = new Map(
            [...session.branches]
                .sort((a, b) => getContinuationBranchTime(a) - getContinuationBranchTime(b))
                .map((item, index) => [item.branchKey, index + 1])
        );
        const branchHtml = session.branches.map((branch, branchIndex) => {
            // 分支多了以后全展开很容易看串行，默认只留当前分支展开，历史分支收起
            const isBranchOpen = hasActiveBranch ? branch.isActive : branchIndex === 0;
            const branchNumber = branchNumbers.get(branch.branchKey) || 1;
            const branchTime = formatContinuationTimestamp(getContinuationBranchTime(branch));
            const branchTitle = branchTime || "时间未知";
            const sourceContinuationIndex = Math.max(0, Number(branch.branchedAtRound) - 1);
            const branchSource = sourceContinuationIndex > 0 ? ` · 从续写第 ${sourceContinuationIndex} 次创建` : "";
            const branchStatus = `${branch.isActive ? "当前分支" : "历史分支"}${branchSource}`;
            const roundHtml = branch.rounds.map(round => {
                const label = getContinuationRoundLabel(round);
                const instruction = round.instruction || "（自然续写）";
                const instructionPreview = getContinuationInstructionPreview(instruction);
                const canRegenerate = round.type !== "initial";
                const isCurrentChat = session.chatId === currentSource.chatId;
                const crossRoleHint = !isCurrentChat ? `<div class="t-cont-history-cross-hint">来自「${escapeHtmlText(session.characterName)}」的剧情 · 接演会复制到当前聊天的新分支，原分支不变</div>` : "";
                return `<article class="t-cont-history-round" data-chat-id="${escapeHtmlText(session.chatId)}" data-script-id="${escapeHtmlText(session.scriptId)}" data-branch-key="${escapeHtmlText(branch.branchKey)}" data-round-key="${escapeHtmlText(round.roundKey)}">
                    <div class="t-cont-history-round-head">
                         <span class="t-cont-select-wrap">${selectionCheckbox("round", session.chatId, session.scriptId, branch.branchKey, round.roundKey, false)}</span>
                        <div class="t-cont-history-round-title"><strong>${escapeHtmlText(label)}</strong><span>${round.contentLength} 字符</span></div>
                        <button class="t-cont-history-toggle" title="展开内容"><i class="fa-solid fa-chevron-down"></i></button>
                    </div>
                    <div class="t-cont-history-instruction" title="${escapeHtmlText(instructionPreview)}">${escapeHtmlText(instructionPreview)}</div>
                    <div class="t-cont-history-preview">${escapeHtmlText(round.contentPreview || "无文本摘要")}</div>
                    <div class="t-cont-history-full" hidden><iframe sandbox="" title="${escapeHtmlText(label)}内容预览"></iframe></div>
                    ${crossRoleHint}
                    <div class="t-cont-history-actions">
                        <button class="t-btn t-cont-history-show"><i class="fa-solid fa-arrow-up-right-from-square"></i> 跳转到此内容</button>
                        ${isCurrentChat && canRegenerate ? '<button class="t-btn t-btn-soft t-cont-history-regenerate"><i class="fa-solid fa-rotate"></i> 直接重生成</button><button class="t-btn t-cont-history-edit-regenerate"><i class="fa-solid fa-code-branch"></i> 修改指令并重生成</button>' : ""}
                        ${!isCurrentChat ? '<button class="t-btn t-btn-soft t-cont-history-visit"><i class="fa-solid fa-theater-masks"></i> 让当前角色接演</button><button class="t-btn t-cont-history-visit-edit"><i class="fa-solid fa-pen"></i> 修改指令并接演</button>' : ""}
                    </div>
                </article>`;
            }).join("");
            return `<section class="t-cont-history-branch ${branch.isActive ? "is-active" : ""} ${isBranchOpen ? "is-open" : ""}" data-chat-id="${escapeHtmlText(session.chatId)}" data-script-id="${escapeHtmlText(session.scriptId)}" data-branch-key="${escapeHtmlText(branch.branchKey)}">
                <button class="t-cont-history-branch-title" type="button" aria-expanded="${isBranchOpen}">
                    <span class="t-cont-select-wrap">${selectionCheckbox("branch", session.chatId, session.scriptId, branch.branchKey)}</span>
                    <i class="fa-solid fa-chevron-right t-cont-history-branch-chevron"></i>
                    <i class="fa-solid fa-code-branch"></i>
                    <div class="t-cont-history-branch-heading">
                        <strong>${escapeHtmlText(branchTitle)}${branchNumber > 1 ? `<em class="t-cont-history-branch-no">分支 ${branchNumber}</em>` : ""}</strong>
                        <span>${escapeHtmlText(branchStatus)}</span>
                    </div>
                    <small>${branch.rounds.length - 1} 次续写</small>
                </button>
                <div class="t-cont-history-branch-body" ${isBranchOpen ? "" : "hidden"}>${roundHtml}</div>
            </section>`;
        }).join("");
        return `<section class="t-cont-history-session ${isOpen ? "is-open" : ""}" data-chat-id="${escapeHtmlText(session.chatId)}" data-script-id="${escapeHtmlText(session.scriptId)}">
            <button class="t-cont-history-session-toggle" type="button" aria-expanded="${isOpen}">
                <span class="t-cont-select-wrap">${selectionCheckbox("session", session.chatId, session.scriptId)}</span>
                <i class="fa-solid fa-chevron-right"></i>
                <span>${escapeHtmlText(session.characterName)} · 《${escapeHtmlText(session.scriptName)}》</span>
                <small>${session.branches.length} 个分支 · ${session.roundCount} 轮</small>
            </button>
            <div class="t-cont-history-session-body" ${isOpen ? "" : "hidden"}>${branchHtml}</div>
        </section>`;
    }).join("");

    $("#t-main-view").append(`<div id="t-continuation-history" class="t-cont-history-panel ${continuationHistoryManaging ? "is-managing" : ""}">
        <div class="t-cont-history-header"><div class="t-cont-history-heading"><i class="fa-solid fa-clock-rotate-left"></i><strong>${continuationHistoryManaging ? "批量管理" : "主动续写聊天历史"}</strong><span>${continuationHistoryManaging ? "勾选要删除的剧本、分支或轮次" : `${sessions.length} 个剧本 · ${sessions.reduce((sum, item) => sum + item.roundCount, 0)} 轮`}</span></div><div class="t-cont-history-header-actions">${continuationHistoryManaging ? '<button class="t-btn" id="t-cont-history-select-all"><i class="fa-solid fa-check-double"></i> 全选</button><button class="t-btn" id="t-cont-history-manage-cancel">退出</button>' : `<select id="t-cont-history-scope" class="t-cont-history-scope" title="历史范围"><option value="all" ${continuationHistoryScope === "all" ? "selected" : ""}>全部角色</option><option value="character" ${continuationHistoryScope === "character" ? "selected" : ""}>当前角色</option><option value="chat" ${continuationHistoryScope === "chat" ? "selected" : ""}>当前聊天</option></select><button class="t-btn" id="t-cont-history-manage" title="批量管理历史"><i class="fa-solid fa-list-check"></i> 管理</button>`}<button class="t-close" id="t-cont-history-close">&times;</button></div></div>
        <div class="t-cont-history-body">${sessionsHtml || '<div class="t-cont-history-empty">当前筛选范围内没有记录</div>'}</div>
        ${continuationHistoryManaging ? '<div class="t-cont-history-bulk-bar"><span id="t-cont-history-selection-count">已选择 0 项</span><button class="t-btn danger" id="t-cont-history-delete-selected" disabled><i class="fa-solid fa-trash-can"></i> 删除所选</button></div>' : ""}
    </div>`);

    const $panel = $("#t-continuation-history");
    const closePanel = () => {
        $(document).off("keydown.tcontinuationhistory");
        continuationHistoryManaging = false;
        continuationHistorySelection.clear();
        $panel.remove();
    };
    $("#t-cont-history-close").on("click", closePanel);
    $("#t-cont-history-scope").on("change", function () {
        continuationHistoryScope = String($(this).val() || "all");
        openContinuationHistory(preferredScriptId);
    });
    $("#t-cont-history-manage").on("click", () => {
        continuationHistoryManaging = true;
        continuationHistorySelection.clear();
        openContinuationHistory(preferredScriptId);
    });
    $("#t-cont-history-manage-cancel").on("click", () => {
        continuationHistoryManaging = false;
        continuationHistorySelection.clear();
        openContinuationHistory(preferredScriptId);
    });
    const updateBulkSelection = () => {
        const $checks = $panel.find(".t-cont-select:not(:disabled)");
        $panel.find('.t-cont-select[data-selection-level="branch"]').each(function () {
            const $branch = $(this).closest(".t-cont-history-branch");
            const children = $branch.find('.t-cont-select[data-selection-level="round"]:not(:disabled)').get();
            const checkedCount = children.filter(item => item.checked).length;
            this.indeterminate = checkedCount > 0 && checkedCount < children.length;
            if (children.length > 0 && checkedCount === children.length) this.checked = true;
            if (checkedCount === 0) this.checked = false;
        });
        $panel.find('.t-cont-select[data-selection-level="session"]').each(function () {
            const $session = $(this).closest(".t-cont-history-session");
            const children = $session.find('.t-cont-select[data-selection-level="branch"]:not(:disabled)').get();
            const checkedCount = children.filter(item => item.checked).length;
            const indeterminateCount = children.filter(item => item.indeterminate).length;
            this.indeterminate = indeterminateCount > 0 || (checkedCount > 0 && checkedCount < children.length);
            if (children.length > 0 && checkedCount === children.length && indeterminateCount === 0) this.checked = true;
            if (checkedCount === 0 && indeterminateCount === 0) this.checked = false;
        });
        continuationHistorySelection.clear();
        $checks.filter(":checked").each(function () {
            continuationHistorySelection.add(`${$(this).data("chat-id")}\u0000${$(this).data("script-id")}\u0000${$(this).data("branch-key") || ""}\u0000${$(this).data("round-key") || ""}`);
        });
        const count = continuationHistorySelection.size;
        $("#t-cont-history-selection-count").text(`已选择 ${count} 项`);
        $("#t-cont-history-delete-selected").prop("disabled", count === 0);
    };
    $panel.on("click", ".t-cont-select", event => event.stopPropagation());
    $panel.on("change", ".t-cont-select", function () {
        const $check = $(this);
        const chatId = String($check.data("chat-id") || "");
        const scriptId = String($check.data("script-id") || "");
        const branchKey = String($check.data("branch-key") || "");
        const level = String($check.data("selection-level") || "");
        const selector = level === "session"
            ? `.t-cont-select[data-chat-id="${CSS.escape(chatId)}"][data-script-id="${CSS.escape(scriptId)}"]`
            : level === "branch"
                ? `.t-cont-select[data-chat-id="${CSS.escape(chatId)}"][data-script-id="${CSS.escape(scriptId)}"][data-branch-key="${CSS.escape(branchKey)}"]`
                : "";
        if (selector) $panel.find(selector).prop("checked", $check.prop("checked"));
        updateBulkSelection();
    });
    $("#t-cont-history-select-all").on("click", function () {
        const $checks = $panel.find(".t-cont-select:not(:disabled)");
        const allChecked = $checks.length > 0 && $checks.filter(":checked").length === $checks.length;
        $checks.prop("checked", !allChecked);
        $(this).html(allChecked ? '<i class="fa-solid fa-check-double"></i> 全选' : '<i class="fa-solid fa-circle-xmark"></i> 取消全选');
        updateBulkSelection();
    });
    $("#t-cont-history-delete-selected").on("click", async function () {
        const selections = [...continuationHistorySelection].map(key => {
            const [chatId, scriptId, branchKey, roundKey] = key.split("\u0000");
            return { chatId, scriptId, branchKey, roundKey };
        });
        if (selections.length === 0) return;
        const roundCount = selections.filter(item => item.roundKey).length;
        if (!window.confirm(`确定删除已选择的 ${selections.length} 项吗？\n\n其中包含 ${roundCount} 个续写轮次。删除后无法恢复。`)) return;
        $(this).prop("disabled", true);
        try {
            const currentViewDeleted = continuationHistoryView && selections.some(item => (
                item.chatId === continuationHistoryView.chatId
                && item.scriptId === continuationHistoryView.scriptId
                && (!item.branchKey || item.branchKey === continuationHistoryView.branchKey)
                && (!item.roundKey || item.roundKey === continuationHistoryView.roundKey)
            ));
            const result = await deleteGlobalContinuationSelections(selections);
            continuationHistorySelection.clear();
            continuationHistoryManaging = false;
            if (currentViewDeleted) {
                continuationHistoryView = null;
                unlockDisplay();
                if (GlobalState.lastGeneratedContent) {
                    const scriptName = GlobalState.runtimeScripts.find(s => s.id === GlobalState.lastGeneratedScriptId)?.name || "场景";
                    renderGeneratedContent(GlobalState.lastGeneratedContent, scriptName);
                }
            }
            updateSceneHistoryNav();
            openContinuationHistory(preferredScriptId);
            if (window.toastr) toastr.success(`已删除 ${result.deletedRounds} 个轮次、${result.deletedBranches} 个分支`, "Titania");
        } catch (error) {
            console.error("Titania: 批量删除主动续写历史失败", error);
            $(this).prop("disabled", false);
            if (window.toastr) toastr.error("批量删除失败", "Titania");
        }
    });
    $(document).off("keydown.tcontinuationhistory").on("keydown.tcontinuationhistory", function (event) {
        if (event.key === "Escape") closePanel();
    });
    $panel.on("click", ".t-cont-history-session-toggle", function () {
        const $session = $(this).closest(".t-cont-history-session");
        const shouldOpen = !$session.hasClass("is-open");
        $session.toggleClass("is-open", shouldOpen);
        $(this).attr("aria-expanded", String(shouldOpen));
        $session.find(".t-cont-history-session-body").first().prop("hidden", !shouldOpen);
    });
    $panel.on("click", ".t-cont-history-branch-title", function () {
        const $branch = $(this).closest(".t-cont-history-branch");
        const shouldOpen = !$branch.hasClass("is-open");
        $branch.toggleClass("is-open", shouldOpen);
        $(this).attr("aria-expanded", String(shouldOpen));
        $branch.find(".t-cont-history-branch-body").first().prop("hidden", !shouldOpen);
    });
    $panel.on("click", ".t-cont-history-toggle", function () {
        const $round = $(this).closest(".t-cont-history-round");
        const $full = $round.find(".t-cont-history-full");
        const shouldOpen = $full.prop("hidden");
        $full.prop("hidden", !shouldOpen);
        $(this).find("i").toggleClass("fa-chevron-down", !shouldOpen).toggleClass("fa-chevron-up", shouldOpen);
        if (shouldOpen) {
            const chatId = String($round.data("chat-id") || "");
            const roundScriptId = String($round.data("script-id") || "");
            const branchKey = String($round.data("branch-key") || "");
            const roundKey = String($round.data("round-key") || "");
            const content = findGlobalContinuationRound(chatId, roundScriptId, branchKey, roundKey)?.round.content || "";
            $full.find("iframe").attr("srcdoc", content);
        }
    });
    $panel.on("click", ".t-cont-history-show", function () {
        const $round = $(this).closest(".t-cont-history-round");
        showContinuationRoundInMain(String($round.data("chat-id") || ""), String($round.data("script-id") || ""), String($round.data("branch-key") || ""), String($round.data("round-key") || ""));
    });
    $panel.on("click", ".t-cont-history-regenerate, .t-cont-history-edit-regenerate", async function () {
        if (GlobalState.isGenerating || GlobalState.queueState.isRunning) return;
        const $round = $(this).closest(".t-cont-history-round");
        const editInstruction = $(this).hasClass("t-cont-history-edit-regenerate");
        closePanel();
        await regenerateContinuationRound(String($round.data("script-id") || ""), String($round.data("branch-key") || ""), String($round.data("round-key") || ""), editInstruction);
    });
    $panel.on("click", ".t-cont-history-visit, .t-cont-history-visit-edit", async function () {
        if (GlobalState.isGenerating || GlobalState.queueState.isRunning) return;
        const $round = $(this).closest(".t-cont-history-round");
        const target = findGlobalContinuationRound(
            String($round.data("chat-id") || ""),
            String($round.data("script-id") || ""),
            String($round.data("branch-key") || ""),
            String($round.data("round-key") || "")
        );
        if (!target) return;
        let instruction = "";
        const editInstruction = $(this).hasClass("t-cont-history-visit-edit");
        let historyPanelClosed = false;
        if (editInstruction) {
            closePanel();
            historyPanelClosed = true;
            const composeResult = await openContinuationComposer("", null, {
                content: target.round.content,
                scriptId: target.session.scriptId,
                scriptName: target.session.scriptName
            });
            if (!composeResult || composeResult.openHistory) {
                await openContinuationHistory(target.session.scriptId);
                return;
            }
            instruction = String(composeResult.instruction || "").trim();
        }
        const confirmed = window.confirm(`让当前角色接演「${target.session.characterName}」的这段剧情？\n\n将在当前聊天创建新分支，原分支不会被修改。`);
        if (!confirmed) {
            if (historyPanelClosed) await openContinuationHistory(target.session.scriptId);
            return;
        }
        const copied = copyContinuationBranchToCurrentChat({
            ...target.session,
            branchKey: target.branch.branchKey,
            rounds: target.branch.rounds,
            roundKey: target.round.roundKey
        });
        if (!copied) return;
        if (!historyPanelClosed) closePanel();
        continuationHistoryView = null;
        return handleUserContinuation({
            instruction,
            scriptIdOverride: copied.scriptId,
            baseContentOverride: copied.content,
            fromCurrentView: false,
            crossRoleSource: target.session.characterName
        });
    });
}

/**
 * 刷新剧本列表下拉框 (辅助函数)
 */
export function refreshScriptList() {
    const $sel = $("#t-sel-script");
    $sel.empty();

    // 显示所有剧本（不再按模式过滤）
    const validScripts = sortScripts(GlobalState.runtimeScripts, getScriptSortMode());

    validScripts.forEach(s => {
        $sel.append(`<option value="${s.id}">${s.name}</option>`);
    });

    if (GlobalState.lastUsedScriptId && validScripts.find(s => s.id === GlobalState.lastUsedScriptId)) {
        $sel.val(GlobalState.lastUsedScriptId);
    }
    updateDesc();
}

function updateDesc() {
    const s = GlobalState.runtimeScripts.find(x => x.id === $("#t-sel-script").val());
    if (s) $("#t-txt-desc").val(s.desc);
}

/**
 * 应用选中的剧本到触发器卡片 (供 api.js 和 内部 调用)
 * @param {string} id - 剧本ID
 */
export function applyScriptSelection(id, options = {}) {
    const s = GlobalState.runtimeScripts.find(x => x.id === id);
    if (!s) return;

    const shouldTrackSelection = options.trackSelection === true;

    if (shouldTrackSelection) {
        recordScriptSelected(s.id);
    }

    GlobalState.lastUsedScriptId = s.id;
    if (options.pendingGeneration === true) {
        setPendingGenerationScriptId(s.id);
        setContinuationQuickDraft("");
        $("#t-continuation-quick-input").val("");
        if (typeof window.updateRunButtonsState === "function") window.updateRunButtonsState();
    }

    // 1. 更新标题
    $("#t-lbl-name").text(s.name);

    // 2. 分类标签 (不再区分模式)
    const $catTag = $("#t-lbl-cat");
    const category = s.category || (s._type === 'preset' ? "官方预设" : "未分类");
    $catTag.text(category);
    $catTag.css({
        "color": "#bfa15f",
        "background": "rgba(191, 161, 95, 0.15)",
        "border": "1px solid rgba(191, 161, 95, 0.33)"
    });

    // 3. 更新描述
    $("#t-lbl-desc-mini").text(s.desc || "无简介");

    // 兼容性：更新隐藏的文本框
    $("#t-txt-desc").val(s.desc);
}

/**
 * 主窗口逻辑
 * 非阻塞式设计：先渲染 UI 骨架，再异步加载数据
 */
export async function openMainWindow() {
    if ($("#t-overlay").length) return;
    setPendingGenerationScriptId("");

    // 不再阻塞等待上下文数据，使用占位符立即渲染
    const defaultCtx = { charName: "加载中...", userName: "用户" };

    let data;
    try {
        data = getExtData();
    } catch (e) {
        console.error("Titania: 获取扩展数据失败", e);
        data = { ui_mode_echo: true };
    }

    // 1. 获取持久化的历史开关偏好 (默认为关闭)
    GlobalState.useHistoryAnalysis = (data.use_history_analysis === true);

    // 1.1 只要角色发言（历史开关的子项，默认关闭）。
    // 老用户的 history_extraction 里没有这个键 —— getExtData 不做深合并，undefined 即关闭，正是想要的
    GlobalState.historyAiOnly = (data.history_extraction?.ai_only === true);

    // 1.5 获取持久化的生成模式偏好 (默认为内容优先)
    GlobalState.generationMode = ["narrative", "visual", "preset"].includes(data.config?.generation_mode)
        ? data.config.generation_mode
        : "narrative";

    // 2. 准备初始展示内容（占位符，实际内容在 DOM 创建后用 Shadow DOM 渲染）
    const placeholderContent = '<div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:#555;"><i class="fa-solid fa-clapperboard" style="font-size:3em; margin-bottom:15px; opacity:0.5;"></i><div style="font-size:1.1em;">请选择剧本，开始演绎...</div></div>';

    // 依据用户偏好选择布局，产出 DOM 骨架
    const layout = data.ui_prefs?.main_window_mode === "legacy" ? legacyLayout : modernLayout;
    activeLayout = layout;
    $("body").append(layout.renderHtml({ defaultCtx }));
    $("#t-main-view").addClass(`t-layout-${layout.id}`);

    // --- 初始内容渲染（使用 Shadow DOM） ---
    const outputContainer = document.getElementById("t-output-content");
    if (GlobalState.lastGeneratedContent) {
        // 有已生成的内容，使用 Shadow DOM 渲染
        // 获取当前剧本名称用于互动检测
        const currentScript = GlobalState.runtimeScripts.find(s => s.id === GlobalState.lastGeneratedScriptId);
        const scriptName = currentScript ? currentScript.name : "场景";
        renderGeneratedContent(GlobalState.lastGeneratedContent, scriptName);

        // 更新统计显示（使用已保存的统计数据或重新计算）
        updateContentStatsDisplay(GlobalState.contentStats);
    } else {
        // 无内容时显示占位符（直接 innerHTML，不需要 Shadow DOM）
        outputContainer.innerHTML = placeholderContent;
    }

    // --- 事件监听绑定 ---

    // 历史开关事件
    $("#t-use-history").on("change", function () {
        GlobalState.useHistoryAnalysis = $(this).is(":checked");
        updateHistoryToggleUI();

        // 保存偏好
        const d = getExtData();
        d.use_history_analysis = GlobalState.useHistoryAnalysis;
        saveExtData();

        // 视觉反馈
        if (window.toastr) {
            if (GlobalState.useHistoryAnalysis) {
                toastr.info("📜 已开启：将分析聊天历史", "Titania");
            } else {
                toastr.info("📜 已关闭：不读取聊天历史", "Titania");
            }
        }
    });

    // 「只要角色发言」子开关
    $("#t-history-ai-only").on("change", function () {
        GlobalState.historyAiOnly = $(this).is(":checked");
        updateHistoryToggleUI();

        const d = getExtData();
        if (!d.history_extraction || typeof d.history_extraction !== "object") d.history_extraction = {};
        d.history_extraction.ai_only = GlobalState.historyAiOnly;
        saveExtData();

        if (window.toastr) {
            if (GlobalState.historyAiOnly) {
                toastr.info("🎭 已开启：历史只注入角色发言", "Titania");
            } else {
                toastr.info("🎭 已关闭：历史包含双方发言", "Titania");
            }
        }
    });

    // 生成模式切换事件
    $(".t-mode-btn").on("click", function () {
        const newMode = $(this).data("mode");
        if (newMode === GlobalState.generationMode) return;

        GlobalState.generationMode = newMode;
        updateModeToggleUI();

        // 保存偏好
        const d = getExtData();
        if (!d.config) d.config = {};
        if (newMode === "preset") {
            const manager = d.prompt_manager || {};
            const activePreset = manager.presets?.find(p => p.id === manager.active_preset_id);
            if (!activePreset) {
                GlobalState.generationMode = "narrative";
                updateModeToggleUI();
                if (window.toastr) toastr.warning("请先在设置的提示词管理中导入并选择预设", "Titania");
                return;
            }
        }
        d.config.generation_mode = newMode;
        saveExtData();

        // 视觉反馈
        if (window.toastr) {
            if (newMode === "narrative") {
                toastr.info("📖 已切换至内容优先模式", "Titania");
            } else if (newMode === "visual") {
                toastr.info("🎨 已切换至氛围美化模式", "Titania");
            } else {
                const preset = d.prompt_manager?.presets?.find(p => p.id === d.prompt_manager?.active_preset_id);
                toastr.info(`📋 已切换至预设：${preset?.name || "用户预设"}`, "Titania");
            }
        }
    });

    $("#t-trigger-btn").on("click", () => showScriptSelector(GlobalState.currentCategoryFilter));

    $("#t-btn-filter").on("click", function (e) {
        renderFilterMenu(GlobalState.currentCategoryFilter, $(this), (newCat) => {
            GlobalState.currentCategoryFilter = newCat;
            updateFilterUI();
            const currentS = GlobalState.runtimeScripts.find(s => s.id === GlobalState.lastUsedScriptId);
            const sCat = currentS ? (currentS.category || (currentS._type === 'preset' ? '官方预设' : '未分类')) : '';
            if (newCat !== 'ALL' && sCat !== newCat) {
                handleRandom();
            }
        });
        e.stopPropagation();
    });

    $("#t-btn-dice").on("click", handleRandom);

    // 沉浸阅读模式
    $("#t-tool-zen").on("click", function () {
        const view = $("#t-main-view");
        view.toggleClass("t-zen-mode");
        const isZen = view.hasClass("t-zen-mode");
        $(this).toggleClass("active", isZen);
    });

    // 编辑内容功能
    $("#t-tool-edit-content").on("click", function () {
        if (!GlobalState.lastGeneratedContent) {
            if (window.toastr) toastr.warning("没有可编辑的内容，请先生成场景");
            return;
        }
        openContentEditor();
    });

    const runContinuation = async (composeResult) => {
        if (GlobalState.isGenerating || GlobalState.queueState.isRunning) {
            if (window.toastr) toastr.info("正在生成中，请稍候...", "Titania");
            return false;
        }

        if (composeResult === null) return false;
        if (composeResult?.openHistory) {
            openContinuationHistory(composeResult.scriptId);
            return false;
        }

        const normalizedInstruction = String(composeResult?.instruction || "").trim();
        const injectRoundsCount = clampInjectRoundsCount(composeResult?.injectRoundsCount ?? getContinuationDefaultInjectCount());
        if (normalizedInstruction) {
            saveContinuationRecentInstruction(normalizedInstruction);
        }

        const historyTarget = continuationHistoryView
            ? findGlobalContinuationRound(
                continuationHistoryView.chatId,
                continuationHistoryView.scriptId,
                continuationHistoryView.branchKey,
                continuationHistoryView.roundKey
            )
            : null;
        const historyView = historyTarget ? { ...continuationHistoryView } : null;
        if (historyView) continuationHistoryView = null;
        const currentSource = getCurrentContinuationSource();
        const isCrossChatHistory = Boolean(historyView && historyView.chatId !== currentSource.chatId);
        const copied = isCrossChatHistory ? copyContinuationBranchToCurrentChat({
            ...historyTarget.session,
            branchKey: historyTarget.branch.branchKey,
            rounds: historyTarget.branch.rounds,
            roundKey: historyTarget.round.roundKey
        }) : null;

        await handleUserContinuation({
            instruction: normalizedInstruction,
            injectRoundsCount,
            branchFromCurrentView: composeResult?.branchFromCurrentView === true,
            sourceBranchKey: isCrossChatHistory ? "" : historyView?.branchKey || composeResult?.sourceBranchKey || "",
            regenerateRound: composeResult?.regenerateRound ?? null,
            continueAfterRound: isCrossChatHistory ? null : historyTarget?.round.round ?? null,
            continueAfterRoundKey: isCrossChatHistory ? "" : historyView?.roundKey || "",
            scriptIdOverride: copied?.scriptId || historyView?.scriptId || "",
            baseContentOverride: copied?.content || historyTarget?.round.content || "",
            crossRoleSource: isCrossChatHistory ? historyTarget.session.characterName : "",
            fromCurrentView: true
        });
        return true;
    };

    // --- 续写分支内联操作（两套布局的 markup 都含 t-cont-inline-* ，故属共享层）---

    const closeInlineBranchMenu = () => {
        $("#t-cont-inline-actions").removeClass("is-menu-open");
        $("#t-cont-inline-branch").attr({ "aria-expanded": "false", "aria-label": "展开分支操作" });
    };

    const runInlineBranchAction = async (editInstruction) => {
        const $button = $("#t-cont-inline-branch");
        const scriptId = String($button.attr("data-script-id") || "");
        const branchKey = String($button.attr("data-branch-key") || "");
        const roundKey = String($button.attr("data-round-key") || "");
        closeInlineBranchMenu();
        if (!scriptId || !branchKey || !roundKey || GlobalState.isGenerating || GlobalState.queueState.isRunning) return;
        await regenerateContinuationRound(scriptId, branchKey, roundKey, editInstruction);
    };

    $("#t-cont-inline-branch").on("click", function (event) {
        event.stopPropagation();
        if (GlobalState.isGenerating || GlobalState.queueState.isRunning) return;
        const $actions = $("#t-cont-inline-actions");
        const isOpen = !$actions.hasClass("is-menu-open");
        $actions.toggleClass("is-menu-open", isOpen);
        $(this).attr({
            "aria-expanded": String(isOpen),
            "aria-label": isOpen ? "收起分支操作" : "展开分支操作"
        });
    });

    $("#t-cont-inline-regenerate").on("click", () => runInlineBranchAction(false));
    $("#t-cont-inline-edit-regenerate").on("click", () => runInlineBranchAction(true));

    $(document).off("click.tinlinebranch").on("click.tinlinebranch", function (event) {
        if (!$(event.target).closest("#t-cont-inline-actions").length) closeInlineBranchMenu();
    });

    $(document).on("keydown.zenmode", function (e) {
        if (e.key === "Escape" && $("#t-main-view").hasClass("t-zen-mode")) {
            $("#t-tool-zen").click();
        }
    });

    // 布局专属绑定：共享能力通过 ctx 注入，布局侧不直接 import 本模块
    layout.bindEvents({
        closeWindow,
        registerTeardown,
        runContinuation,
        openContinuationHistory,
        openContinuationComposer,
        getCurrentContinuationSource
    });

    $("#t-btn-close").on("click", closeWindow);
    $("#t-overlay").on("click", (e) => { if (e.target === e.currentTarget) closeWindow(); });
    // 新建剧本 (点击后打开空编辑器)
    $("#t-btn-new").on("click", () => {
        // 传入 null 表示新建，第二个参数 'main' 表示从主窗口打开
        openEditor(null, 'main');
    });

    // 编辑当前剧本
    $("#t-btn-edit").on("click", () => {
        if (!GlobalState.lastUsedScriptId) {
            if (window.toastr) toastr.warning("当前没有选中的剧本");
            return;
        }
        // 传入当前 ID，'main' 表示从主窗口打开
        openEditor(GlobalState.lastUsedScriptId, 'main');
    });

    // 复制 HTML 源码（从 Shadow DOM 或 GlobalState 获取）
    $("#t-btn-copy").on("click", async () => {
        const container = document.getElementById("t-output-content");
        const btn = $("#t-btn-copy");
        const originalHtml = btn.html();

        try {
            let htmlCode = "";

            // 优先从 GlobalState 获取原始内容（因为 Shadow DOM 内容不易直接访问）
            if (GlobalState.lastGeneratedContent) {
                htmlCode = GlobalState.lastGeneratedContent;
            } else {
                // 尝试从 Shadow DOM 获取
                const shadowHost = container.querySelector('.t-shadow-host');
                if (shadowHost && shadowHost.shadowRoot) {
                    const shadowContent = shadowHost.shadowRoot.querySelector('.t-shadow-content');
                    if (shadowContent) {
                        htmlCode = shadowContent.innerHTML;
                    }
                }

                // 如果还是没有，尝试直接获取 innerHTML
                if (!htmlCode) {
                    htmlCode = container.innerHTML;
                }
            }

            if (!htmlCode || htmlCode.trim().length === 0) {
                throw new Error("没有可复制的内容");
            }

            // 优先使用 Clipboard API
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(htmlCode);
            } else {
                // Fallback: 使用传统的 execCommand 方法
                const textArea = document.createElement("textarea");
                textArea.value = htmlCode;
                textArea.style.position = "fixed";
                textArea.style.left = "-9999px";
                textArea.style.top = "-9999px";
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();

                const successful = document.execCommand('copy');
                document.body.removeChild(textArea);

                if (!successful) {
                    throw new Error("复制命令执行失败");
                }
            }

            // 图标变绿色表示成功
            btn.html('<i class="fa-solid fa-check" style="color:#55efc4;"></i>');
            setTimeout(() => btn.html(originalHtml), 1000);
        } catch (err) {
            console.error("Titania: 复制失败", err);
            // 图标变红色表示失败
            btn.html('<i class="fa-solid fa-xmark" style="color:#ff6b6b;"></i>');
            setTimeout(() => btn.html(originalHtml), 1500);

            if (window.toastr) {
                toastr.error("复制失败：" + (err.message || "请检查浏览器权限"), "Titania");
            }
        }
    });

    // 队列生成按钮
    $("#t-btn-run-queue").on("click", () => {
        if (GlobalState.isGenerating || GlobalState.queueState.isRunning) {
            if (window.toastr) toastr.info("正在生成中，请稍候...", "Titania");
            return;
        }

        // 检查队列是否已激活
        if (!GlobalState.queueState.enabled) {
            if (window.toastr) toastr.warning("请先在队列设置中激活队列生成", "Titania");
            // 打开队列设置窗口
            openQueueSettingsWindow();
            return;
        }

        // 获取队列剧本列表
        const scripts = getQueueScripts();
        if (scripts.length > 0) {
            // 关闭主窗口
            closeWindow();
            // 开始队列生成
            executeQueueGeneration(scripts);
        } else {
            if (window.toastr) toastr.warning("队列为空，请先配置队列", "Titania");
            openQueueSettingsWindow();
        }
    });
    // 收藏按钮：根据状态切换保存/取消收藏
    $("#t-btn-like").on("click", () => {
        if (!isFavoriteEligible(getCurrentGenerationResult())) {
            if (window.toastr) toastr.warning("当前没有可收藏的剧场内容");
            updateFavButtonUI();
            return;
        }
        if (GlobalState.lastFavId) {
            // 已收藏，执行取消
            unsaveFavorite();
        } else {
            // 未收藏，执行保存
            saveFavorite();
        }
    });
    $("#t-tool-workshop-feedback").on("click", () => {
        const result = getCurrentGenerationResult();
        const script = GlobalState.runtimeScripts.find(s => s.id === result?.scriptId);
        const sourceId = script?.workshop_source_id;
        if (!sourceId) {
            if (window.toastr) toastr.info("当前剧本不是从回声工坊下载的");
            return;
        }
        window.open(`${WORKSHOP_ORIGIN}/#/comment/${encodeURIComponent(sourceId)}`, "_blank");
    });
    // 标题栏图标由用户自选，重绘后 id 会变，所以委托到窗口根节点而不是逐个绑定
    $("#t-main-view").on("click", "[data-header-action]", function (e) {
        e.stopPropagation();
        runHeaderAction(String($(this).data("header-action") || ""), $(this));
    });
    $("#t-btn-debug").on("click", async () => await showDebugInfo());

    // 队列设置按钮
    $("#t-btn-queue-settings").on("click", openQueueSettingsWindow);

    // 中止生成按钮
    $("#t-btn-stop").on("click", () => {
        if (GlobalState.isGenerating) {
            cancelGeneration();
        } else if (GlobalState.queueState.isRunning) {
            cancelQueueGeneration();
        } else {
            if (window.toastr) toastr.info("当前没有正在进行的生成任务", "Titania");
        }
    });

    // 诊断日志按钮
    $("#t-btn-diagnostics").on("click", () => {
        showDiagnosticsWindow();
    });

    // --- 历史导航事件 (增强版：支持显示层分离) ---
    $("#t-nav-prev").on("click", function () {
        if ($(this).prop("disabled")) return;

        const history = GlobalState.sceneHistory;
        const display = GlobalState.displayState;
        const streaming = GlobalState.streamingCache;

        // 计算当前有效索引
        let effectiveIndex = display.isViewingHistory ? display.currentViewIndex : history.currentIndex;

        // 特殊情况：正在生成且当前看的是实时内容，此时“上一条”应进入最新历史记录（index 0）
        const canJumpFromLiveToHistory = streaming.isActive && !display.isViewingHistory && history.items.length > 0;

        // 尝试导航到更旧的记录
        if (canJumpFromLiveToHistory || effectiveIndex < history.items.length - 1) {
            continuationHistoryView = null;
            setPendingGenerationScriptId("");
            const newIndex = canJumpFromLiveToHistory ? 0 : (effectiveIndex + 1);

            // 锁定显示层到历史记录
            lockDisplayToHistory(newIndex);

            // 获取并渲染历史内容
            const item = history.items[newIndex];
            if (item) {
                renderGeneratedContent(item.content, item.scriptName || "场景");

                // 更新全局状态（用于收藏等功能）
                setCurrentGenerationResult({ ...item, status: item.status || "legacy" });
                // 从历史记录中恢复收藏状态
                GlobalState.lastFavId = item.favId || null;
            }

            updateSceneHistoryNav();
            updateRunButtonsState();
            updateFavButtonUI();
            updateScriptTitleDisplay();
        }
    });

    $("#t-nav-next").on("click", function () {
        if ($(this).prop("disabled")) return;

        const history = GlobalState.sceneHistory;
        const display = GlobalState.displayState;
        const streaming = GlobalState.streamingCache;

        // 计算当前有效索引
        let effectiveIndex = display.isViewingHistory ? display.currentViewIndex : history.currentIndex;

        // 尝试导航到更新的记录
        if (effectiveIndex > 0) {
            continuationHistoryView = null;
            setPendingGenerationScriptId("");
            const newIndex = effectiveIndex - 1;

            if (newIndex === 0 && !streaming.isActive) {
                // 返回到最新记录，解锁显示层
                unlockDisplay();
                history.currentIndex = 0;
            } else {
                // 锁定到指定历史记录
                lockDisplayToHistory(newIndex);
            }

            // 获取并渲染内容
            const item = history.items[newIndex];
            if (item) {
                renderGeneratedContent(item.content, item.scriptName || "场景");
                setCurrentGenerationResult({ ...item, status: item.status || "legacy" });
                // 从历史记录中恢复收藏状态
                GlobalState.lastFavId = item.favId || null;
            }

            updateSceneHistoryNav();
            updateRunButtonsState();
            updateFavButtonUI();
            updateScriptTitleDisplay();
        } else if (effectiveIndex === 0 && streaming.isActive && display.isViewingHistory) {
            continuationHistoryView = null;
            setPendingGenerationScriptId("");
            // 特殊情况：正在生成中，用户想查看实时内容
            unlockDisplay();

            // 渲染当前流式内容
            if (streaming.content) {
                renderGeneratedContent(streaming.content, streaming.scriptName || "场景", true);
            }

            // 移除新内容指示器
            $("#t-new-content-indicator").remove();

            updateSceneHistoryNav();
            updateRunButtonsState();
        }
    });

    // 暴露更新函数到全局，供 api.js 调用
    window.updateSceneHistoryNav = updateSceneHistoryNav;
    window.updateRunButtonsState = updateRunButtonsState;
    window.updateFavButtonUI = updateFavButtonUI;
    window.updateScriptTitleDisplay = updateScriptTitleDisplay;
    // 供设置窗口在改动顶栏图标后即时重绘（主窗口没开时函数不存在，调用方需守卫）
    window.refreshHeaderActions = refreshHeaderActions;

    // --- [初始化阶段] ---
    // 1. 确定要显示的剧本：优先使用 lastGeneratedScriptId（如果有内容的话）
    let initialScriptId = GlobalState.lastUsedScriptId;

    if (GlobalState.lastGeneratedContent && GlobalState.lastGeneratedScriptId) {
        // 有生成内容时，使用生成内容对应的剧本来显示
        initialScriptId = GlobalState.lastGeneratedScriptId;
    }

    // 2. 初始化 UI 状态
    updateHistoryToggleUI();
    updateModeToggleUI();
    updateFilterUI();

    // 3. 检查是否有可用剧本
    if (GlobalState.runtimeScripts.length === 0) {
        // 没有加载到任何剧本，显示错误提示
        $("#t-lbl-name").text("无可用剧本");
        $("#t-lbl-cat").text("⚠️ 错误");
        $("#t-lbl-desc-mini").text("剧本数据未加载，请检查插件安装");
        console.error("Titania: runtimeScripts 为空，剧本未加载");
    } else if (initialScriptId) {
        const initialScript = GlobalState.runtimeScripts.find(s => s.id === initialScriptId);
        if (initialScript) {
            // 应用剧本显示（不影响模式Tab，因为上面已经处理了）
            applyScriptSelection(initialScriptId, { trackSelection: false });
        } else {
            // 剧本不存在，从当前模式中随机选一个
            handleRandom();
        }
    } else {
        // 没有任何剧本ID，随机选一个
        handleRandom();
    }

    // 异步加载上下文数据并更新 UI（不阻塞主流程）
    loadContextDataAsync();

    // 初始化历史导航 UI
    updateSceneHistoryNav();

    // 初始化运行按钮状态
    updateRunButtonsState();
    updateQueueButtonUI();
}

/**
 * 更新运行按钮的启用/禁用状态
 * 根据生成状态禁用另一个按钮
 */
export function updateRunButtonsState() {
    if (!activeLayout) return;
    activeLayout.syncRunButtons({
        isGenerating: GlobalState.isGenerating,
        isQueueRunning: GlobalState.queueState.isRunning
    });
}

/**
 * 更新队列按钮的 UI 状态
 * 根据队列是否激活显示不同样式
 */
export function updateQueueButtonUI() {
    const $queueBtn = $("#t-btn-run-queue");
    const $settingsBtn = $("#t-btn-queue-settings");

    if (!$queueBtn.length) return;

    if (GlobalState.queueState.enabled) {
        // 队列已激活：显示蓝色主题
        $queueBtn.removeClass("inactive").addClass("active");
        $settingsBtn.addClass("active");
    } else {
        // 队列未激活：显示灰色
        $queueBtn.removeClass("active").addClass("inactive");
        $settingsBtn.removeClass("active");
    }
}

/**
 * 更新内容统计显示（紧凑水平条）
 * @param {{ totalChars: number, chineseChars: number, generationTime?: number, modelName?: string }} stats
 */
export function updateContentStatsDisplay(stats) {
    const $hud = $("#t-stats-hud");
    if (!$hud.length) return;

    if (!stats || stats.totalChars === 0) {
        $hud.hide();
        return;
    }

    // 格式化数字（添加千位分隔符）
    const formatNumber = (num) => num.toLocaleString();

    // 更新模型名称（截取显示，避免过长）
    const modelName = stats.modelName || GlobalState.lastUsedModelName || "-";
    const displayModelName = modelName.length > 20 ? modelName.substring(0, 18) + "…" : modelName;
    $("#t-stat-model").text(displayModelName).attr("title", modelName);

    // 更新各项统计值
    $("#t-stat-total").text(formatNumber(stats.totalChars));
    $("#t-stat-chinese").text(formatNumber(stats.chineseChars));

    // 更新生成时间
    const genTime = stats.generationTime || GlobalState.lastGenerationTime || 0;
    if (genTime > 0) {
        const seconds = (genTime / 1000).toFixed(1);
        $("#t-stat-time").text(`${seconds}s`);
    } else {
        $("#t-stat-time").text("-");
    }

    // 显示统计面板
    $hud.show();
}

/**
 * 更新收藏按钮的 UI 状态
 * 根据 GlobalState.lastFavId 切换红心图标显示
 */
export function updateFavButtonUI() {
    updateWorkshopFeedbackButton();
    const btn = $("#t-btn-like");
    if (!btn.length) return;
    const icon = btn.find("i");
    const eligible = isFavoriteEligible(getCurrentGenerationResult());
    btn.prop("disabled", !eligible);

    if (!eligible) {
        icon.attr("class", "fa-regular fa-heart").css("color", "#777");
        btn.attr({ title: "当前内容不可收藏", "aria-label": "当前内容不可收藏" }).removeClass("is-faved");
        return;
    }

    if (GlobalState.lastFavId) {
        // 已收藏：显示实心红心
        icon.attr("class", "fa-solid fa-heart").css("color", "#ff6b6b");
        btn.attr({ title: "取消收藏", "aria-label": "取消收藏" }).addClass("is-faved");
    } else {
        // 未收藏：显示空心红心
        icon.attr("class", "fa-regular fa-heart").css("color", "");
        btn.attr({ title: "收藏结果", "aria-label": "收藏结果" }).removeClass("is-faved");
    }
}

export function updateWorkshopFeedbackButton() {
    const btn = $("#t-tool-workshop-feedback");
    if (!btn.length) return;
    const result = getCurrentGenerationResult();
    const script = GlobalState.runtimeScripts.find(s => s.id === result?.scriptId);
    btn.toggle(Boolean(result?.content && script?.workshop_source_id));
}

/**
 * 更新剧本标题显示（用于历史导航时）
 * 根据 GlobalState.lastGeneratedScriptId 更新顶部的剧本信息卡片
 * 注意：这不会修改 lastUsedScriptId（用户主动选择的剧本）
 */
export function updateScriptTitleDisplay() {
    const scriptId = GlobalState.lastGeneratedScriptId;
    if (!scriptId) return;

    const script = GlobalState.runtimeScripts.find(s => s.id === scriptId);
    if (!script) {
        // 剧本不存在（可能已被删除），显示占位信息
        $("#t-lbl-name").text("未知剧本");
        $("#t-lbl-cat").text("已删除").css({
            "color": "#888",
            "background": "rgba(136, 136, 136, 0.15)",
            "border": "1px solid rgba(136, 136, 136, 0.33)"
        });
        $("#t-lbl-desc-mini").text("该剧本可能已被删除");
        return;
    }

    // 更新标题
    $("#t-lbl-name").text(script.name);

    // 更新分类标签
    const category = script.category || (script._type === 'preset' ? "官方预设" : "未分类");
    $("#t-lbl-cat").text(category).css({
        "color": "#bfa15f",
        "background": "rgba(191, 161, 95, 0.15)",
        "border": "1px solid rgba(191, 161, 95, 0.33)"
    });

    // 更新描述
    $("#t-lbl-desc-mini").text(script.desc || "无简介");
}

/**
 * 更新历史导航栏的显示状态 (增强版：支持显示层分离)
 */
function updateSceneHistoryNav() {
    const $prevBtn = $("#t-nav-prev");
    const $nextBtn = $("#t-nav-next");
    const $indicator = $("#t-page-indicator");

    const history = GlobalState.sceneHistory;
    const display = GlobalState.displayState;
    const streaming = GlobalState.streamingCache;

    // 计算有效的导航状态
    const effectiveIndex = display.isViewingHistory ? display.currentViewIndex : history.currentIndex;

    // 历史数组按最新到最旧保存，页码则按最旧到最新显示。
    const displayPage = history.items.length - effectiveIndex;

    // 判断是否可以向前/向后导航
    const canJumpFromLiveToHistory = streaming.isActive && !display.isViewingHistory && history.items.length > 0;
    const hasPrev = canJumpFromLiveToHistory || effectiveIndex < history.items.length - 1;
    const hasNext = effectiveIndex > 0 || (display.isViewingHistory && streaming.isActive);

    // 只有当有多个历史记录时才显示导航按钮
    const showPageNav = history.items.length > 1 || (history.items.length >= 1 && streaming.isActive);

    if (showPageNav) {
        // 显示按钮
        $prevBtn.show();
        $nextBtn.show();
        $indicator.show();

        // 更新按钮状态
        $prevBtn.prop("disabled", !hasPrev);
        $nextBtn.prop("disabled", !hasNext);

        // 更新指示器
        if (streaming.isActive && !display.isViewingHistory) {
            // 正在生成且用户在看实时内容
            $indicator.text(`⏳/${history.items.length}`);
            $indicator.css("color", "#90cdf4");
        } else if (display.isViewingHistory && streaming.isActive) {
            // 正在生成但用户在看历史
            $indicator.text(`${displayPage}/${history.items.length} ⚡`);
            $indicator.css("color", "#ffeaa7");
        } else {
            // 正常状态
            $indicator.text(`${displayPage}/${history.items.length}`);
            $indicator.css("color", "rgba(255, 255, 255, 0.3)");
        }

        // 标记当前查看的记录为已读
        markCurrentAsRead();
    } else {
        // 隐藏按钮
        $prevBtn.hide();
        $nextBtn.hide();
        $indicator.hide();
    }

    updateContinuationInlineActions();
}

function updateContinuationInlineActions() {
    const $actions = $("#t-cont-inline-actions");
    const $button = $("#t-cont-inline-branch");
    if (!$actions.length) return;

    $actions.removeClass("is-menu-open");
    $button.attr({ "aria-expanded": "false", "aria-label": "展开分支操作" });

    let target = null;
    if (continuationHistoryView) {
        const currentSource = getCurrentContinuationSource();
        const located = continuationHistoryView.chatId === currentSource.chatId ? findContinuationRound(
            continuationHistoryView.scriptId,
            continuationHistoryView.branchKey,
            continuationHistoryView.roundKey
        ) : null;
        if (located) {
            target = {
                scriptId: continuationHistoryView.scriptId,
                branchKey: located.branch.branchKey,
                isActive: located.branch.isActive,
                ...located.round
            };
        }
    } else if (!GlobalState.streamingCache.isActive) {
        const display = getCurrentDisplayContent();
        target = findContinuationRoundByContent(display?.scriptId, display?.content);
        if (target) target.scriptId = display.scriptId;
    }

    if (!target || target.type === "initial") {
        $actions.hide();
        return;
    }

    const branchLabel = target.isActive ? "当前分支" : "历史分支";
    $("#t-cont-inline-label").text(`${branchLabel} · 续写第${target.continuationIndex}次`);
    $button
        .attr("data-script-id", target.scriptId)
        .attr("data-branch-key", target.branchKey)
        .attr("data-round-key", target.roundKey);
    $actions.show();
}

/**
 * 异步加载上下文数据并更新相关 UI
 * 此函数不会阻塞主界面渲染
 */
function loadContextDataAsync() {
    // 异步获取角色名并更新标题
    getContextData()
        .then(ctx => {
            // 更新主演名称
            const $charName = $("#t-char-name");
            if ($charName.length) {
                $charName.text(ctx.charName || "未知角色");
            }
        })
        .catch(e => {
            console.warn("Titania: 异步加载上下文失败", e);
            $("#t-char-name").text("未知角色");
        });

    // 异步更新世界书徽章
    updateWorldInfoBadge().catch(e => {
        console.warn("Titania: 更新世界书徽章失败", e);
    });
}

/**
 * 更新世界书图标颜色（有选中条目时变蓝色）
 * 添加超时保护，避免长时间阻塞
 */
async function updateWorldInfoBadge() {
    const BADGE_TIMEOUT = 8000; // 8秒超时

    try {
        // 使用 Promise.race 添加超时保护
        const entriesPromise = getActiveWorldInfoEntries();
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('世界书加载超时')), BADGE_TIMEOUT)
        );

        const entries = await Promise.race([entriesPromise, timeoutPromise]);

        let ctx;
        try {
            ctx = await getContextData();
        } catch (e) {
            ctx = { charName: "Char" };
        }

        const data = getExtData();

        let totalCount = 0;
        let selectedCount = 0;

        // 与生成路径同一套解析：按角色卡隔离，避免同名卡的统计互相污染
        let stCtx = null;
        try {
            if (typeof SillyTavern !== "undefined") stCtx = SillyTavern.getContext?.() || null;
        } catch { stCtx = null; }
        const charSelections = readWorldInfoSelections(data, stCtx, ctx.charName);

        entries.forEach(book => {
            book.entries.forEach(entry => {
                totalCount++;
                // 如果没有保存过选择，默认全选；否则按保存的选择计算
                if (charSelections === null) {
                    selectedCount++;
                } else {
                    const bookSel = charSelections[book.bookName] || [];
                    if (bookSel.includes(entry.uid)) {
                        selectedCount++;
                    }
                }
            });
        });

        // 状态色跟着世界书这个功能项走：它在顶栏就染自己的图标，
        // 被收进「更多」时才降级染「更多」，否则用户看不到「有条目未选」这类提示
        const onBar = $("#t-btn-worldinfo").length > 0;
        const $icon = onBar ? $("#t-btn-worldinfo") : $("#t-btn-more");
        // 世界书没上栏就必然是溢出项、「更多」必然存在；这里只是防御
        if (!$icon.length) return;
        const prefix = onBar ? "世界书筛选" : "更多 · 世界书";
        if (selectedCount > 0) {
            // 有选中条目时：图标变蓝色
            $icon.css("color", "#90cdf4");
            $icon.attr("title", `${prefix}已选 ${selectedCount}/${totalCount}`);
        } else if (totalCount > 0) {
            // 有条目但未选中：图标变橙色提醒
            $icon.css("color", "#bfa15f");
            $icon.attr("title", `${prefix}未选择任何条目`);
        } else {
            // 无条目时：恢复默认灰色
            $icon.css("color", "");
            $icon.attr("title", onBar ? "世界书筛选" : "更多");
        }
    } catch (e) {
        console.warn("Titania: 更新世界书图标状态失败", e);
        $("#t-btn-worldinfo, #t-btn-more").css("color", "");
    }
}

/**
 * 打开世界书管理窗口
 * 新版：支持下拉查看所有世界书（无论是否激活）
 */
async function openWorldInfoSelector() {
    if ($("#t-wi-selector").length) return;

    const withTimeout = (promise, timeoutMs, errorMsg) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), timeoutMs))
    ]);

    const getSelectorContext = () => {
        try {
            if (typeof SillyTavern !== "undefined" && SillyTavern.getContext) {
                const stCtx = SillyTavern.getContext();
                const charName = stCtx?.substituteParams?.("{{char}}") || "Char";
                // stCtx 要一路带下去：世界书配置按角色卡（avatar）隔离，
                // 光有 charName 无法区分同名卡
                return { charName, stCtx };
            }
        } catch (e) {
            console.warn("Titania: 获取世界书窗口上下文失败", e);
        }
        return { charName: "Char", stCtx: null };
    };

    const loadingHtml = `
    <div id="t-wi-selector" class="t-wi-selector">
        <div class="t-wi-header">
            <div style="display:flex; align-items:center; gap:10px;">
                <i class="fa-solid fa-book-atlas" style="color:#90cdf4;"></i>
                <span style="font-weight:bold;">世界书管理</span>
            </div>
            <div class="t-close" id="t-wi-close">&times;</div>
        </div>
        <div class="t-wi-body" style="display:flex; align-items:center; justify-content:center; min-height:200px;">
            <div style="text-align:center; color:#888;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size:2em; margin-bottom:10px;"></i>
                <div>正在加载世界书数据...</div>
            </div>
        </div>
    </div>`;

    const $loadingPanel = $(loadingHtml);
    let loadingCancelled = false;
    $("#t-main-view").append($loadingPanel);
    $loadingPanel.find("#t-wi-close").on("click", () => {
        loadingCancelled = true;
        $loadingPanel.remove();
    });

    let ctx;
    let allBookNames;
    let activeBookNames;
    const loadWarnings = [];
    try {
        // 只加载窗口首屏所需的轻量数据，避免 getContextData() 的重度世界书扫描阻塞入口
        ctx = getSelectorContext();

        try {
            allBookNames = await withTimeout(
                Promise.resolve(getAllWorldBookNames()),
                10000,
                "获取世界书列表超时"
            );
        } catch (e) {
            allBookNames = [];
            loadWarnings.push(e?.message || "获取世界书列表失败");
        }

        try {
            activeBookNames = await withTimeout(
                Promise.resolve(getActiveWorldBookNames()),
                4000,
                "获取激活世界书超时"
            );
        } catch (e) {
            activeBookNames = [];
            loadWarnings.push(e?.message || "获取激活世界书失败");
        }
    } catch (e) {
        console.error("Titania: 加载世界书数据失败", e);
        if (loadingCancelled || !$loadingPanel[0]?.isConnected) return;
        $loadingPanel.find(".t-wi-body").html(`
            <div style="text-align:center; color:#e74c3c; padding:20px;">
                <i class="fa-solid fa-exclamation-triangle" style="font-size:2em; margin-bottom:10px;"></i>
                <div style="margin-bottom:10px;">加载世界书数据失败</div>
                <div style="font-size:0.9em; color:#888;">${e.message}</div>
                <button class="t-btn t-wi-load-error-close" style="margin-top:15px;">关闭</button>
            </div>
        `);
        $loadingPanel.find(".t-wi-load-error-close").on("click", () => $loadingPanel.remove());
        return;
    }

    // 加载期间允许关闭面板；旧调用完成后不能再覆盖后来打开的实例。
    if (loadingCancelled || !$loadingPanel[0]?.isConnected) return;

    const data = getExtData();
    if (!data.worldinfo) data.worldinfo = {};

    const charName = ctx.charName;
    // 按角色卡（avatar）隔离读取；名字唯一时仍可继承旧的名字键配置
    const savedSelections = readWorldInfoSelections(data, ctx.stCtx, charName);
    const workingSelections = savedSelections ? structuredClone(savedSelections) : {};
    const allBooks = Array.isArray(allBookNames) ? allBookNames.slice() : [];
    const baseActiveBooks = Array.isArray(activeBookNames)
        ? activeBookNames.filter(name => allBooks.includes(name))
        : [];

    if (loadWarnings.length > 0 && window.toastr) {
        toastr.warning(`世界书数据部分加载失败：${loadWarnings.join("；")}`, "Titania Echo");
    }

    let currentViewMode = "all";
    // 「隐藏已禁用」是持久化的视图偏好。纯过滤：不动 workingSelections，
    // 所以已经勾选的禁用条目虽然从列表消失，注入时照旧生效（见 context.js 的选择集过滤）
    let hideDisabled = data.ui_prefs?.wi_hide_disabled === true;
    const getVisibleBooks = () => currentViewMode === "active" ? baseActiveBooks : allBooks;
    let visibleBooks = getVisibleBooks();

    $loadingPanel.remove();

    const renderBookListHtml = (books, activeSet, selectedName) => {
        if (!books.length) {
            const emptyText = currentViewMode === "active" ? "当前没有已激活世界书" : "未找到任何世界书";
            return `<div class="t-wi-booklist-empty">${emptyText}</div>`;
        }

        return books.map(name => {
            const isActive = activeSet.has(name);
            const selected = name === selectedName;
            return `
                <div class="t-wi-book-item ${selected ? "selected" : ""}" data-book-name="${encodeURIComponent(name)}" title="${escapeHtmlText(name)}">
                    <span class="t-wi-book-item-dot ${isActive ? "active" : ""}"></span>
                    <span class="t-wi-book-item-name">${escapeHtmlText(name)}</span>
                </div>
            `;
        }).join("");
    };

    // 移动端用的原生下拉。卡片列表在窄屏被 CSS 隐藏，改由系统选择器承担选书，
    // 既省掉一大块竖向空间，也不依赖任何自定义滚动
    const renderBookSelectHtml = (books, activeSet, selectedName) => {
        if (!books.length) {
            const emptyText = currentViewMode === "active" ? "当前没有已激活世界书" : "未找到任何世界书";
            return `<option value="">${escapeHtmlText(emptyText)}</option>`;
        }

        return books.map(name => {
            const isActive = activeSet.has(name);
            const selected = name === selectedName;
            // ●/○ 对应卡片上的激活状态圆点，原生 option 里没法放 DOM，只能用字符
            const label = `${isActive ? "●" : "○"} ${name}`;
            return `<option value="${encodeURIComponent(name)}" ${selected ? "selected" : ""}>${escapeHtmlText(label)}</option>`;
        }).join("");
    };

    const html = `
    <div id="t-wi-selector" class="t-wi-selector">
        <div class="t-wi-header">
            <div style="display:flex; align-items:center; gap:10px;">
                <i class="fa-solid fa-book-atlas" style="color:#90cdf4;"></i>
                <span style="font-weight:bold;">世界书管理</span>
                <span style="font-size:0.8em; color:#666;">${ctx.charName}</span>
            </div>
            <div class="t-close" id="t-wi-close">&times;</div>
        </div>

        <div class="t-wi-tabs" role="tablist" aria-label="世界书范围">
            <button type="button" class="t-wi-tab-btn active" role="tab" aria-selected="true" data-mode="all">
                <span>全部世界书</span><span class="t-wi-tab-count" id="t-wi-all-count">${allBooks.length}</span>
            </button>
            <button type="button" class="t-wi-tab-btn" role="tab" aria-selected="false" data-mode="active">
                <span>已激活世界书</span><span class="t-wi-tab-count" id="t-wi-active-count">${baseActiveBooks.length}</span>
            </button>
        </div>

        <div class="t-wi-body t-wi-layout" id="t-wi-layout">
            <div class="t-wi-books-pane">
                <div class="t-wi-books-header">世界书列表</div>
                <select class="t-wi-book-select" id="t-wi-book-select" aria-label="选择世界书"></select>
                <div class="t-wi-books-list" id="t-wi-books-list"></div>
            </div>
            <div class="t-wi-entry-pane">
                <div class="t-wi-entry-pane-header" id="t-wi-entry-pane-header">
                    <div class="t-wi-entry-pane-heading">
                        <div class="t-wi-entry-pane-title" id="t-wi-entry-pane-title">未选择世界书</div>
                        <span class="t-wi-entry-pane-badge inactive" id="t-wi-entry-pane-badge">未激活</span>
                    </div>
                    <div class="t-wi-entry-pane-tools">
                        <div class="t-wi-entry-search" id="t-wi-entry-search">
                            <i class="fa-solid fa-magnifying-glass t-wi-search-icon"></i>
                            <input type="text" id="t-wi-entry-search-input" placeholder="搜索条目标题..." autocomplete="off">
                            <i class="fa-solid fa-xmark t-wi-search-clear" id="t-wi-entry-search-clear" title="清空搜索"></i>
                        </div>
                        <button type="button" class="t-btn t-btn-xs" id="t-wi-current-select-all">全选</button>
                        <button type="button" class="t-btn t-btn-xs" id="t-wi-current-select-none">取消全选</button>
                        <label class="t-wi-hide-disabled" id="t-wi-hide-disabled-label" title="仅从列表里隐藏，不改动已保存的勾选。已勾选的禁用条目仍会注入">
                            <input type="checkbox" id="t-wi-hide-disabled" class="t-choice-input t-choice-input--warning-muted t-choice-input--sm" ${hideDisabled ? "checked" : ""}>
                            <span>隐藏已禁用</span>
                        </label>
                    </div>
                </div>
                <div class="t-wi-entry-list" id="t-wi-entry-list">
                    ${visibleBooks.length === 0 ? '<div class="t-wi-empty">未找到任何世界书</div>' : ''}
                </div>
            </div>
        </div>

        <div class="t-wi-footer">
            <span id="t-wi-stat">已选: 0/0</span>
            <button class="t-btn primary" id="t-wi-save" ${allBooks.length === 0 ? "disabled" : ""}>保存</button>
        </div>
    </div>`;

    const $panel = $(html);
    const $q = (selector) => $panel.find(selector);
    $("#t-main-view").append($panel);

    let currentBookName = visibleBooks[0] || "";
    let currentEntries = [];
    let entrySearchQuery = "";
    let entrySearchTimer = null;
    let bookLoadRequestId = 0;
    const activeSet = new Set(baseActiveBooks);

    const closePanel = () => {
        bookLoadRequestId++;
        clearTimeout(entrySearchTimer);
        $panel.remove();
    };

    const getAutoActiveBooksFromSelections = () => {
        return Object.keys(workingSelections).filter(bookName => {
            const selected = workingSelections[bookName];
            return Array.isArray(selected) && selected.length > 0;
        });
    };

    const refreshActiveState = () => {
        const autoActive = getAutoActiveBooksFromSelections();
        activeSet.clear();
        baseActiveBooks.forEach(name => activeSet.add(name));
        autoActive.forEach(name => activeSet.add(name));
        const activeCount = allBooks.filter(name => activeSet.has(name)).length;
        $q("#t-wi-active-count").text(activeCount);
    };

    const showEntryPreview = (title, content) => {
        $q(".t-wi-preview-modal").remove();
        const $modal = $(`
            <div class="t-wi-preview-modal t-root">
                <div class="t-wi-preview-box">
                    <div class="t-wi-preview-header">
                        <span class="t-wi-preview-title">${title}</span>
                        <span class="t-wi-preview-close">&times;</span>
                    </div>
                    <div class="t-wi-preview-content">${content.replace(/\n/g, "<br>")}</div>
                </div>
            </div>
        `);

        $modal.on("click", function (e) {
            if (e.target === this) $modal.remove();
        });
        $modal.find(".t-wi-preview-close").on("click", function () {
            $modal.remove();
        });
        $panel.append($modal);
    };

    const getBookSelectedSet = (bookName) => {
        const selectedUids = Array.isArray(workingSelections[bookName]) ? workingSelections[bookName] : [];
        return new Set(selectedUids.map(uid => Number(uid)));
    };

    const setBookSelections = (bookName, selectedSet) => {
        workingSelections[bookName] = Array.from(selectedSet);
        refreshActiveState();
    };

    const getVisibleEntries = () => {
        let list = currentEntries;
        if (hideDisabled) list = list.filter(entry => !entry.isDisabled);
        if (!entrySearchQuery) return list;
        const needle = entrySearchQuery.toLowerCase();
        return list.filter(entry => String(entry.comment || "").toLowerCase().includes(needle));
    };

    /** 被「隐藏已禁用」挡掉、但仍处于勾选状态的条目数。这些条目看不见却照旧注入 */
    const countHiddenSelected = () => {
        if (!hideDisabled || !currentBookName) return 0;
        const selectedSet = getBookSelectedSet(currentBookName);
        return currentEntries.filter(entry => entry.isDisabled && selectedSet.has(Number(entry.uid))).length;
    };

    const renderEntryTitle = (title) => {
        const text = String(title || "");
        if (!entrySearchQuery) return escapeHtmlText(text);

        const idx = text.toLowerCase().indexOf(entrySearchQuery.toLowerCase());
        if (idx === -1) return escapeHtmlText(text);

        const before = text.slice(0, idx);
        const hit = text.slice(idx, idx + entrySearchQuery.length);
        const after = text.slice(idx + entrySearchQuery.length);
        return `${escapeHtmlText(before)}<span class="t-wi-title-hit">${escapeHtmlText(hit)}</span>${escapeHtmlText(after)}`;
    };

    const syncSelectAllLabels = () => {
        const visibleCount = getVisibleEntries().length;
        // 任一过滤生效时都要标出范围 —— 全选只作用于可见条目
        const suffix = (entrySearchQuery || hideDisabled) ? ` (${visibleCount})` : "";
        $q("#t-wi-current-select-all").text(`全选${suffix}`);
        $q("#t-wi-current-select-none").text(`取消全选${suffix}`);
    };

    const updateStat = () => {
        const selectedSet = getBookSelectedSet(currentBookName);
        const selectedCount = currentEntries.filter(entry => selectedSet.has(Number(entry.uid))).length;
        const filterNote = (entrySearchQuery || hideDisabled) ? `　筛选出 ${getVisibleEntries().length} 条` : "";
        // 这是纯视图过滤，「已选」里可能包含被隐藏的条目。不写出来会让人
        // 以为隐藏等于不注入，而注入侧只看勾选、不看禁用状态
        const hiddenSelected = countHiddenSelected();
        const hiddenNote = hiddenSelected ? `　含 ${hiddenSelected} 条已隐藏但仍会注入` : "";
        $q("#t-wi-stat").text(`已选: ${selectedCount}/${currentEntries.length}${filterNote}${hiddenNote}`);
        syncSelectAllLabels();
    };

    const renderEntries = () => {
        const $body = $q("#t-wi-entry-list");
        $body.empty();

        if (!currentBookName) {
            $body.append('<div class="t-wi-empty">未选择世界书</div>');
            updateStat();
            return;
        }

        if (!currentEntries.length) {
            $body.append('<div class="t-wi-empty">该世界书暂无条目</div>');
            updateStat();
            return;
        }

        const visibleEntries = getVisibleEntries();

        if (!visibleEntries.length) {
            // 退路要对得上是谁挡的：搜索挡的就清搜索，「隐藏已禁用」挡的就取消隐藏
            const blockedByHide = hideDisabled && !entrySearchQuery;
            $body.append(`
                <div class="t-wi-empty">
                    <div>${blockedByHide ? "该世界书的条目在酒馆中都被禁用了" : "无匹配条目"}</div>
                    <button type="button" class="t-btn t-btn-xs" id="t-wi-empty-reset" style="margin-top:12px;">${blockedByHide ? "显示已禁用条目" : "清空搜索"}</button>
                </div>
            `);
            $body.find("#t-wi-empty-reset").on("click", () => {
                if (blockedByHide) $q("#t-wi-hide-disabled").prop("checked", false).trigger("change");
                else $q("#t-wi-entry-search-input").val("").trigger("input");
            });
            updateStat();
            return;
        }

        const selectedSet = getBookSelectedSet(currentBookName);

        visibleEntries.forEach(entry => {
            const checked = selectedSet.has(Number(entry.uid));
            const constantBadge = entry.isConstant
                ? '<span style="background:#4a9eff33; color:#4a9eff; padding:1px 4px; border-radius:3px; font-size:0.7em; margin-left:5px;">蓝灯</span>'
                : "";
            const disabledBadge = entry.isDisabled
                ? '<span style="background:#ff9f4333; color:#ffb968; padding:1px 4px; border-radius:3px; font-size:0.7em; margin-left:5px;">酒馆中已禁用</span>'
                : "";

            const $entry = $(`
                <div class="t-wi-entry ${checked ? "selected" : ""}" data-uid="${entry.uid}">
                    <div class="t-wi-entry-check">
                        <input type="checkbox" ${checked ? "checked" : ""}>
                    </div>
                    <div class="t-wi-entry-content">
                        <div class="t-wi-entry-title">
                            <span class="t-wi-uid">[${entry.uid}]</span>
                            ${renderEntryTitle(entry.comment)}
                            ${constantBadge}
                            ${disabledBadge}
                        </div>
                        <div class="t-wi-entry-preview">${entry.preview}${entry.content.length > 80 ? "..." : ""}</div>
                    </div>
                    <div class="t-wi-entry-actions">
                        <i class="fa-solid fa-eye t-wi-preview-btn" title="预览完整内容"></i>
                    </div>
                </div>
            `);

            $entry.find("input").on("change", function (e) {
                e.stopPropagation();
                const nextSet = getBookSelectedSet(currentBookName);
                const uid = Number(entry.uid);
                const isChecked = $(this).is(":checked");

                if (isChecked) nextSet.add(uid);
                else nextSet.delete(uid);

                setBookSelections(currentBookName, nextSet);
                $entry.toggleClass("selected", isChecked);
                if (currentViewMode === "active") {
                    const previousBookName = currentBookName;
                    syncVisibleBooksByMode();
                    ensureCurrentBookInView();
                    renderBookList();
                    if (currentBookName !== previousBookName) {
                        if (currentBookName) loadBookEntries(currentBookName);
                        else {
                            currentEntries = [];
                            renderEntries();
                            syncEntryPaneHeader();
                        }
                        return;
                    }
                }
                syncEntryPaneHeader();
                updateStat();
            });

            $entry.on("click", function (e) {
                if ($(e.target).closest("input, .t-wi-preview-btn").length) return;
                const $checkbox = $entry.find("input");
                $checkbox.prop("checked", !$checkbox.is(":checked")).trigger("change");
            });

            $entry.find(".t-wi-preview-btn").on("click", function (e) {
                e.stopPropagation();
                showEntryPreview(entry.comment, entry.content);
            });

            $body.append($entry);
        });

        updateStat();
    };

    const syncEntryPaneHeader = () => {
        const isActive = activeSet.has(currentBookName);
        const title = currentBookName || "未选择世界书";
        $q("#t-wi-entry-pane-title").text(title);
        $q("#t-wi-entry-pane-badge")
            .text(isActive ? "已激活" : "未激活")
            .removeClass("active inactive")
            .addClass(isActive ? "active" : "inactive");
    };

    const bulkSelectCurrentBook = (checked) => {
        if (!currentBookName) return;

        // 只作用于当前可见（过滤后）条目，避免搜索状态下误改全量选择
        const nextSet = getBookSelectedSet(currentBookName);
        getVisibleEntries().forEach(entry => {
            const uid = Number(entry.uid);
            if (checked) nextSet.add(uid);
            else nextSet.delete(uid);
        });

        setBookSelections(currentBookName, nextSet);
        if (currentViewMode === "active") {
            const previousBookName = currentBookName;
            syncVisibleBooksByMode();
            ensureCurrentBookInView();
            renderBookList();
            if (currentBookName !== previousBookName) {
                if (currentBookName) loadBookEntries(currentBookName);
                else {
                    currentEntries = [];
                    renderEntries();
                    syncEntryPaneHeader();
                }
                return;
            }
        }
        syncEntryPaneHeader();
        renderEntries();
    };

    const renderBookList = () => {
        $q("#t-wi-books-list").html(renderBookListHtml(visibleBooks, activeSet, currentBookName));

        $q("#t-wi-books-list .t-wi-book-item").on("click", function () {
            const next = decodeURIComponent(String($(this).data("bookName") || ""));
            if (!next || next === currentBookName) return;
            loadBookEntries(next);
        });

        // 下拉和卡片列表是同一份数据的两种呈现，各自在桌面/移动端可见。
        // 重绘时一并刷新，避免切换标签后两者不一致
        const $select = $q("#t-wi-book-select");
        $select.html(renderBookSelectHtml(visibleBooks, activeSet, currentBookName));
        $select.prop("disabled", visibleBooks.length === 0);
        $select.off("change").on("change", function () {
            const next = decodeURIComponent(String($(this).val() || ""));
            if (!next || next === currentBookName) return;
            loadBookEntries(next);
        });
    };

    const ensureCurrentBookInView = () => {
        if (visibleBooks.includes(currentBookName)) return;
        currentBookName = visibleBooks[0] || "";
    };

    const syncVisibleBooksByMode = () => {
        if (currentViewMode === "active") {
            visibleBooks = allBooks.filter(name => activeSet.has(name));
        } else {
            visibleBooks = allBooks;
        }
    };

    const loadBookEntries = async (bookName) => {
        currentBookName = bookName || "";
        const requestedBookName = currentBookName;
        const requestId = ++bookLoadRequestId;
        clearTimeout(entrySearchTimer);
        entrySearchQuery = "";
        $q("#t-wi-entry-search-input").val("");
        $q("#t-wi-entry-search").removeClass("has-query");
        syncEntryPaneHeader();
        renderBookList();

        const $body = $q("#t-wi-entry-list");
        $body.html(`
            <div style="text-align:center; color:#888; padding:30px 10px;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size:1.6em; margin-bottom:10px;"></i>
                <div>正在加载「${escapeHtmlText(requestedBookName)}」...</div>
            </div>
        `);

        let nextEntries = [];
        try {
            nextEntries = await getWorldInfoEntriesByBookName(requestedBookName);
        } catch (e) {
            console.error("Titania: 加载指定世界书失败", e);
        }

        if (!$panel[0]?.isConnected || requestId !== bookLoadRequestId || currentBookName !== requestedBookName) return;
        currentEntries = nextEntries;
        renderEntries();
        syncEntryPaneHeader();
        renderBookList();
    };

    $panel.on("click", ".t-wi-tab-btn", function () {
        const nextMode = String($(this).data("mode") || "all");
        if (nextMode === currentViewMode) return;

        currentViewMode = nextMode === "active" ? "active" : "all";
        syncVisibleBooksByMode();
        ensureCurrentBookInView();

        $q(".t-wi-tab-btn")
            .removeClass("active")
            .attr("aria-selected", "false");
        $(this)
            .addClass("active")
            .attr("aria-selected", "true");

        if (!currentBookName) {
            currentEntries = [];
            renderBookList();
            renderEntries();
            syncEntryPaneHeader();
            return;
        }

        loadBookEntries(currentBookName);
    });

    $q("#t-wi-current-select-all").on("click", () => bulkSelectCurrentBook(true));
    $q("#t-wi-current-select-none").on("click", () => bulkSelectCurrentBook(false));

    // 条目标题搜索：输入防抖，避免逐字符重渲染
    $q("#t-wi-entry-search-input").on("input", function () {
        const raw = String($(this).val() || "");
        $q("#t-wi-entry-search").toggleClass("has-query", raw.length > 0);
        clearTimeout(entrySearchTimer);
        entrySearchTimer = setTimeout(() => {
            entrySearchQuery = raw.trim();
            renderEntries();
        }, 120);
    });

    $q("#t-wi-entry-search-clear").on("click", () => {
        $q("#t-wi-entry-search-input").val("").trigger("input").trigger("focus");
    });

    $q("#t-wi-hide-disabled").on("change", function () {
        hideDisabled = $(this).is(":checked");

        // 立刻落盘：这是视图偏好，跟「保存」按钮管的世界书勾选是两回事，
        // 不该被用户关掉面板的动作连带丢弃
        if (!data.ui_prefs || typeof data.ui_prefs !== "object") data.ui_prefs = {};
        data.ui_prefs.wi_hide_disabled = hideDisabled;
        saveExtData();

        renderEntries();
    });

    $q("#t-wi-save").on("click", () => {
        if (!currentBookName && !Object.keys(workingSelections).length) return;

        writeWorldInfoSelections(data, ctx.stCtx, workingSelections, getAutoActiveBooksFromSelections());
        saveExtData();
        updateWorldInfoBadge();
        if (window.toastr) toastr.success("世界书设置已保存");
    });

    $q("#t-wi-close").on("click", closePanel);

    refreshActiveState();
    syncVisibleBooksByMode();
    ensureCurrentBookInView();
    renderBookList();
    syncEntryPaneHeader();

    if (currentBookName) {
        await loadBookEntries(currentBookName);
    } else {
        updateStat();
    }
}

/**
 * 渲染分类筛选菜单（不再按模式过滤）
 */
function renderFilterMenu(currentFilter, $targetBtn, onSelect) {
    if ($("#t-filter-popover").length) { $("#t-filter-popover").remove(); return; }

    const baseList = GlobalState.runtimeScripts;
    let currentSortMode = getScriptSortMode();
    const getSortedList = () => sortScripts(baseList, currentSortMode);
    let list = getSortedList();

    // 提取分类
    const cats = [...new Set(list.map(s => s.category || (s._type === 'preset' ? '官方预设' : '未分类')))].sort();

    // 样式见 css/main-window.css
    const html = `
    <div id="t-filter-popover" class="t-filter-popover">
        <div class="t-filter-item ${currentFilter === 'ALL' ? 'active' : ''}" data-val="ALL">
            <span>🔄 全部</span>
            <i class="fa-solid fa-check t-filter-check"></i>
        </div>
        <div style="height:1px; background:#333; margin:2px 0;"></div>
        ${cats.map(c => `
            <div class="t-filter-item ${currentFilter === c ? 'active' : ''}" data-val="${c}">
                <span>${c}</span>
                <i class="fa-solid fa-check t-filter-check"></i>
            </div>
        `).join('')}
    </div>`;

    $("body").append(html);
    const pop = $("#t-filter-popover");

    // 定位逻辑 (相对于按钮)
    const rect = $targetBtn[0].getBoundingClientRect();
    const left = (rect.left + 150 > window.innerWidth) ? (rect.right - 150) : rect.left;
    pop.css({ top: rect.bottom + 5, left: left });

    // 点击事件
    $(".t-filter-item").on("click", function () {
        const val = $(this).data("val");
        onSelect(val);
        pop.remove();
        $(document).off("click.closefilter");
    });

    // 点击外部关闭
    setTimeout(() => {
        $(document).on("click.closefilter", (e) => {
            if (!$(e.target).closest("#t-filter-popover, .t-filter-btn").length) {
                pop.remove();
                $(document).off("click.closefilter");
            }
        });
    }, 10);
}

/**
 * 显示剧本选择器（不再按模式过滤）
 */
function showScriptSelector(initialFilter = "ALL") {
    if ($("#t-selector-panel").length) return;

    let currentSortMode = getScriptSortMode();
    const getSortedList = () => sortScripts(GlobalState.runtimeScripts, currentSortMode);
    let list = getSortedList();
    let categories = ["全部"];
    const scriptCats = [...new Set(list.map(s => s.category || (s._type === 'preset' ? '官方预设' : '未分类')))];
    categories = categories.concat(scriptCats.sort());

    // 内部搜索状态
    let currentSearch = "";

    // 样式见 css/manager.css
    const html = `
    <div id="t-selector-panel" class="t-selector-panel">
        <div class="t-sel-header">
            <div style="font-weight:bold; color:#ccc;">📚 选择剧本 <span style="font-size:0.8em; color:#666; font-weight:normal; margin-left:10px;">(共 ${list.length} 个)</span></div>
            <div style="display:flex; align-items:center; gap:10px;">
                <select id="t-sel-sort" class="t-sel-sort-select" title="排序方式">
                    <option value="smart">智能排序</option>
                    <option value="recent_added">最近添加</option>
                    <option value="recent_generated">最近使用</option>
                    <option value="most_used">最常使用</option>
                    <option value="name_asc">名称 A-Z</option>
                    <option value="name_desc">名称 Z-A</option>
                    <option value="default">默认顺序</option>
                </select>
                <input type="text" id="t-sel-search" class="t-sel-search-input" placeholder="🔍 搜索剧本...">
                <div style="cursor:pointer; padding:5px 10px;" id="t-sel-close"><i class="fa-solid fa-xmark"></i></div>
            </div>
        </div>
        <div class="t-sel-body">
            <div class="t-sel-sidebar" id="t-sel-sidebar"></div>
            <div class="t-sel-grid" id="t-sel-grid"></div>
        </div>
        <div class="t-sel-footer" id="t-sel-footer-tip"></div>
    </div>`;

    $("#t-main-view").append(html);

    // 获取当前选中的分类
    let currentCat = initialFilter === "ALL" ? "全部" : initialFilter;

    const renderGrid = () => {
        list = getSortedList();
        const $grid = $("#t-sel-grid");
        $grid.empty();

        // 根据分类和搜索词过滤
        let filtered = list;

        // 分类筛选
        if (currentCat !== "全部") {
            filtered = filtered.filter(s => (s.category || (s._type === 'preset' ? '官方预设' : '未分类')) === currentCat);
        }

        // 搜索筛选
        if (currentSearch.trim()) {
            const term = currentSearch.toLowerCase();
            filtered = filtered.filter(s =>
                s.name.toLowerCase().includes(term) ||
                (s.desc && s.desc.toLowerCase().includes(term))
            );
        }

        if (filtered.length === 0) {
            const msg = currentSearch.trim()
                ? `未找到包含 "${currentSearch}" 的剧本`
                : "此分类下暂无剧本";
            $grid.append(`<div style="grid-column:1/-1; text-align:center; color:#555; margin-top:50px;">${msg}</div>`);
            return;
        }

        const readStats = createScriptStatsReader();
        filtered.forEach(s => {
            const stats = readStats(s.id);
            const card = $(`
                <div class="t-script-card">
                    <div class="t-card-title">${s.name}</div>
                    <div class="t-card-desc">${s.desc || "..."}</div>
                    <div class="t-card-stats">使用 ${stats.generated_count || 0} 次 · ${formatRelativeTime(stats.last_generated_at)}</div>
                </div>
            `);
            card.on("click", () => {
                applyScriptSelection(s.id, { trackSelection: true, pendingGeneration: true });
                $("#t-selector-panel").remove();
            });
            $grid.append(card);
        });

        const tip = `当前排序：${SORT_MODE_LABELS[currentSortMode] || currentSortMode}`;
        $("#t-sel-footer-tip").text(tip);
    };

    const $sidebar = $("#t-sel-sidebar");
    categories.forEach(cat => {
        const btn = $(`<div class="t-sel-cat-btn">${cat}</div>`);
        if (cat === currentCat) btn.addClass("active");
        btn.on("click", function () {
            $(".t-sel-cat-btn").removeClass("active");
            $(this).addClass("active");
            currentCat = cat;
            renderGrid();
        });
        $sidebar.append(btn);
    });

    // 搜索框事件
    $("#t-sel-search").on("input", function () {
        currentSearch = $(this).val();
        renderGrid();
    });

    $("#t-sel-sort").val(currentSortMode).on("change", function () {
        currentSortMode = setScriptSortMode($(this).val());
        renderGrid();
    });

    renderGrid();
    $("#t-sel-close").on("click", () => $("#t-selector-panel").remove());
}

/**
 * 执行一个标题栏动作。
 * 顶栏图标和「更多」菜单共用这里，保证同一功能在两处行为一致。
 * @param {string} id 注册表里的动作 id，"__more__" 表示打开溢出菜单
 * @param {JQuery} $anchor 触发元素，供需要定位弹层的动作当锚点
 */
async function runHeaderAction(id, $anchor) {
    if (id === "__more__") {
        renderMoreMenu($anchor);
        return;
    }
    if (id === "favs") {
        openFavsWindow();
    } else if (id === "workshop") {
        const { openWorkshopWindow } = await import("./workshopWindow.js");
        openWorkshopWindow('main');
    } else if (id === "worldinfo") {
        openWorldInfoSelector();
    } else if (id === "profiles") {
        renderProfileMenu($anchor);
    } else if (id === "settings") {
        openSettingsWindow();
    }
}

/**
 * 重绘标题栏图标区。
 * 点击靠委托，所以这里只换 HTML 不用重新绑定；世界书状态色的宿主可能变了，顺带刷新。
 * 主窗口没开时静默跳过，设置窗口可以无条件调用。
 */
export function refreshHeaderActions() {
    const $host = $("#t-main-view .t-header-actions");
    if (!$host.length) return;
    $host.html(renderHeaderActionsHtml());
    updateWorldInfoBadge().catch(e => console.warn("Titania: 刷新世界书状态失败", e));
}

/**
 * 渲染标题栏「更多」菜单
 * 收纳没被固定到顶栏的功能项；每行带一个图钉，可直接提升到顶栏。
 * @param {JQuery} $targetBtn 锚点按钮，弹层定位到它下方
 */
function renderMoreMenu($targetBtn) {
    if ($("#t-more-popover").length) { $("#t-more-popover").remove(); return; }

    const items = getOverflowActions();
    if (!items.length) return;

    const isFull = getHeaderActions().length >= HEADER_ACTION_MAX;
    const pinTitle = isFull ? `最多 ${HEADER_ACTION_MAX} 个，取消一个再选` : "固定到栏上";

    // 复用 t-filter-popover 的样式类，保持视觉一致
    const html = `
    <div id="t-more-popover" class="t-filter-popover" style="width: 190px; z-index: 21000;">
        ${items.map(it => `
            <div class="t-filter-item t-more-item" data-action="${it.id}">
                <span><i class="fa-solid ${it.icon}" style="width:1.1em; margin-right:8px;"></i>${it.label}</span>
                <button type="button" class="t-more-pin" data-pin="${it.id}" title="${pinTitle}" aria-label="${pinTitle}" ${isFull ? "disabled" : ""}><i class="fa-solid fa-thumbtack"></i></button>
            </div>
        `).join('')}
    </div>`;

    $("body").append(html);
    const pop = $("#t-more-popover");

    // 定位逻辑：贴着锚点下方，右侧超出视口时改为右对齐
    const rect = $targetBtn[0].getBoundingClientRect();
    const left = (rect.left + 190 > window.innerWidth) ? (rect.right - 190) : rect.left;
    pop.css({ top: rect.bottom + 10, left: left });

    const closeMenu = () => {
        pop.remove();
        $(document).off("click.closemore");
    };

    // 图钉：把该项提升到顶栏。必须挡住冒泡，否则会连带触发整行的主动作。
    $(".t-more-pin", pop).on("click", function (e) {
        e.stopPropagation();
        if ($(this).prop("disabled")) return;
        const id = String($(this).data("pin") || "");
        const meta = getOverflowActions().find(item => item.id === id);
        const next = [...getHeaderActions(), id];
        if (next.length > HEADER_ACTION_MAX) return;
        saveHeaderActions(next);
        // 锚点「更多」可能因为溢出项清空而消失，所以关掉弹层而不是重新定位
        closeMenu();
        refreshHeaderActions();
        if (window.toastr && meta) toastr.success(`已把「${meta.label}」固定到标题栏`, "Titania");
    });

    $(".t-filter-item", pop).on("click", function () {
        const action = String($(this).data("action") || "");

        // 先收起本菜单再执行，避免 API 方案的弹层跟这层叠在一起
        closeMenu();
        runHeaderAction(action, $targetBtn);
    });

    // 点击外部关闭
    setTimeout(() => {
        $(document).on("click.closemore", (e) => {
            if (!$(e.target).closest("#t-more-popover, #t-btn-more").length) closeMenu();
        });
    }, 10);
}

function renderProfileMenu($targetBtn) {
    if ($("#t-profile-popover").length) { $("#t-profile-popover").remove(); return; }

    const data = getExtData();
    if (!data.config || typeof data.config !== "object") data.config = {};
    const normalized = ensureMainApiProfiles(data.config);
    data.config.profiles = normalized.profiles;
    data.config.active_profile_id = normalized.active_profile_id;
    const profiles = normalized.profiles;
    const activeId = normalized.active_profile_id;

    // 复用 t-filter-popover 的样式类，保持视觉一致
    const html = `
    <div id="t-profile-popover" class="t-filter-popover" style="width: 200px; z-index: 21000;">
        ${profiles.map(p => `
            <div class="t-filter-item ${p.id === activeId ? 'active' : ''}" data-id="${p.id}" data-name="${p.name}">
                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${p.name}</span>
                <i class="fa-solid fa-check t-filter-check"></i>
            </div>
        `).join('')}
    </div>`;

    $("body").append(html);
    const pop = $("#t-profile-popover");

    // 定位逻辑
    const rect = $targetBtn[0].getBoundingClientRect();
    const left = (rect.left + 200 > window.innerWidth) ? (rect.right - 200) : rect.left;
    pop.css({ top: rect.bottom + 10, left: left });

    // 点击事件
    $(".t-filter-item", pop).on("click", function () {
        const newId = $(this).data("id");
        const newName = $(this).data("name");

        // 1. 保存设置
        if (!data.config) data.config = {};
        data.config.active_profile_id = newId;
        saveExtData();

        // 2. 视觉反馈
        pop.remove();
        $(document).off("click.closeprofile");

        // 图标闪烁反馈
        $targetBtn.css({ "color": "#55efc4", "transform": "scale(1.2)" });
        setTimeout(() => {
            $targetBtn.css({ "color": "", "transform": "" });
            // 锚点现在是「更多」按钮，它还兼职显示世界书状态色，清完得补回来
            updateWorldInfoBadge();
        }, 500);

        if (window.toastr) toastr.success(`已切换至方案：${newName}`, "API Profile");
    });

    // 点击外部关闭
    setTimeout(() => {
        $(document).on("click.closeprofile", (e) => {
            if (!$(e.target).closest("#t-profile-popover, #t-btn-profile").length) {
                pop.remove();
                $(document).off("click.closeprofile");
            }
        });
    }, 10);
}

/**
 * 打开内容编辑器
 * 允许用户直接编辑已生成的 HTML 内容
 */
function openContentEditor() {
    if ($("#t-content-editor").length) return;

    const currentContent = GlobalState.lastGeneratedContent || "";

    const html = `
    <div id="t-content-editor" class="t-content-editor">
        <div class="t-ce-header">
            <div style="display:flex; align-items:center; gap:10px;">
                <i class="fa-solid fa-pen-nib" style="color:#bfa15f;"></i>
                <span style="font-weight:bold;">编辑内容</span>
                <span style="font-size:0.8em; color:#666;">直接编辑 HTML 源码</span>
            </div>
            <div class="t-close" id="t-ce-close">&times;</div>
        </div>
        <div class="t-ce-body">
            <textarea id="t-ce-textarea" class="t-ce-textarea" spellcheck="false"></textarea>
        </div>
        <div class="t-ce-footer">
            <div class="t-ce-stats">
                <span id="t-ce-char-count">字符: ${currentContent.length}</span>
            </div>
            <div class="t-ce-actions">
                <button class="t-btn" id="t-ce-cancel">取消</button>
                <button class="t-btn" id="t-ce-preview">预览</button>
                <button class="t-btn primary" id="t-ce-save">保存</button>
            </div>
        </div>
    </div>`;

    $("#t-main-view").append(html);

    const $textarea = $("#t-ce-textarea");

    // 使用 .val() 设置内容，避免 HTML 被解析
    $textarea.val(currentContent);

    // 更新字符统计
    $textarea.on("input", function () {
        const len = $(this).val().length;
        $("#t-ce-char-count").text(`字符: ${len}`);
    });

    // 取消
    $("#t-ce-cancel, #t-ce-close").on("click", () => {
        $("#t-content-editor").remove();
    });

    // 预览
    $("#t-ce-preview").on("click", () => {
        const newContent = $textarea.val();

        // 临时渲染预览（不保存到状态）
        const currentScript = GlobalState.runtimeScripts.find(s => s.id === GlobalState.lastGeneratedScriptId);
        const scriptName = currentScript ? currentScript.name : "场景";
        renderGeneratedContent(newContent, scriptName);

        if (window.toastr) toastr.info("预览已更新，点击保存确认修改");
    });

    // 保存
    $("#t-ce-save").on("click", () => {
        const previousContent = String(GlobalState.lastGeneratedContent || "");
        const newContent = $textarea.val();
        const scriptId = GlobalState.lastGeneratedScriptId;

        // 更新全局状态
        const currentResult = getCurrentGenerationResult();
        setCurrentGenerationResult({
            ...currentResult,
            content: newContent,
            scriptId,
            status: currentResult?.status || "legacy"
        });

        // 同步当前历史项，避免后续收藏/历史回看仍使用编辑前内容
        const display = GlobalState.displayState;
        const history = GlobalState.sceneHistory;
        const effectiveIndex = display.isViewingHistory ? display.currentViewIndex : history.currentIndex;
        if (effectiveIndex >= 0 && effectiveIndex < history.items.length) {
            history.items[effectiveIndex].content = newContent;
            history.items[effectiveIndex].timestamp = Date.now();
        }
        if (display.isViewingHistory) {
            display.lockedContent = newContent;
        }

        // 重新渲染内容
        const currentScript = GlobalState.runtimeScripts.find(s => s.id === scriptId);
        const scriptName = currentScript ? currentScript.name : "场景";
        renderGeneratedContent(newContent, scriptName);

        // 同步续写会话缓存，确保收藏时优先读取到编辑后的版本
        syncEditedContentToContinuationSession(scriptId, previousContent, newContent, scriptName);

        // 关闭编辑器
        $("#t-content-editor").remove();

        if (window.toastr) toastr.success("内容已更新");
    });

    // 聚焦到编辑区
    setTimeout(() => $textarea.focus(), 100);
}

/**
 * 打开队列生成设置窗口
 */
function openQueueSettingsWindow() {
    if ($("#t-queue-settings").length) return;

    const data = getExtData();
    const queueCfg = data.queue_config || {};

    // 获取当前队列状态
    const qState = GlobalState.queueState;

    // 获取分类列表
    const categories = ["全部", ...new Set(
        GlobalState.runtimeScripts.map(s => s.category || (s._type === 'preset' ? '官方预设' : '未分类'))
    )].sort((a, b) => a === "全部" ? -1 : b === "全部" ? 1 : a.localeCompare(b));

    const html = `
    <div id="t-queue-settings" class="t-queue-settings">
        <div class="t-queue-header">
            <div style="display:flex; align-items:center; gap:10px;">
                <i class="fa-solid fa-layer-group" style="color:#90cdf4;"></i>
                <span style="font-weight:bold;">队列生成设置</span>
            </div>
            <div class="t-close" id="t-queue-close">&times;</div>
        </div>
        
        <div class="t-queue-body">
            <!-- 模式切换 -->
            <div class="t-queue-section">
                <div class="t-queue-label">生成模式</div>
                <div class="t-queue-mode-toggle">
                    <div class="t-queue-mode-btn ${qState.mode === 'random' ? 'active' : ''}" data-mode="random">
                        <i class="fa-solid fa-dice"></i>
                        <span>随机抽取</span>
                    </div>
                    <div class="t-queue-mode-btn ${qState.mode === 'manual' ? 'active' : ''}" data-mode="manual">
                        <i class="fa-solid fa-hand-pointer"></i>
                        <span>手动选择</span>
                    </div>
                </div>
            </div>
            
            <!-- 随机模式设置 -->
            <div class="t-queue-random-panel" id="t-queue-random-panel" style="${qState.mode === 'random' ? '' : 'display:none;'}">
                <div class="t-queue-row">
                    <div class="t-queue-label">生成数量</div>
                    <div class="t-queue-control">
                        <button class="t-queue-num-btn" id="t-queue-count-dec">-</button>
                        <span class="t-queue-num-value" id="t-queue-count-value">${qState.count}</span>
                        <button class="t-queue-num-btn" id="t-queue-count-inc">+</button>
                    </div>
                </div>
                <div class="t-queue-row">
                    <div class="t-queue-label">分类范围</div>
                    <select class="t-queue-select" id="t-queue-category">
                        ${categories.map(c => `<option value="${c === '全部' ? 'ALL' : c}" ${(qState.categoryFilter === 'ALL' && c === '全部') || qState.categoryFilter === c ? 'selected' : ''}>${c}</option>`).join('')}
                    </select>
                </div>
            </div>
            
            <!-- 手动模式设置 -->
            <div class="t-queue-manual-panel" id="t-queue-manual-panel" style="${qState.mode === 'manual' ? '' : 'display:none;'}">
                <div class="t-queue-label">选择剧本 <span style="color:#666; font-size:0.85em;">(已选 <span id="t-queue-selected-count">${qState.manualItems.length}</span> 个)</span></div>
                <div class="t-queue-script-list" id="t-queue-script-list">
                    ${GlobalState.runtimeScripts.map(s => `
                        <div class="t-queue-script-item ${qState.manualItems.includes(s.id) ? 'selected' : ''}" data-id="${s.id}">
                            <input type="checkbox" class="t-choice-input t-choice-input--accent" ${qState.manualItems.includes(s.id) ? 'checked' : ''}>
                            <div class="t-queue-script-info">
                                <div class="t-queue-script-name">${s.name}</div>
                                <div class="t-queue-script-cat">${s.category || (s._type === 'preset' ? '官方预设' : '未分类')}</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <div class="t-queue-script-actions">
                    <button class="t-btn t-btn--sm" id="t-queue-select-all">全选</button>
                    <button class="t-btn t-btn--sm" id="t-queue-select-none">清空</button>
                </div>
            </div>
            
            <!-- 通用设置 -->
            <div class="t-queue-section" style="border-top:1px solid #333; padding-top:12px; margin-top:5px;">
                <div class="t-queue-row">
                    <div class="t-queue-label">生成间隔 <span style="color:#666; font-size:0.85em;">(秒)</span></div>
                    <div class="t-queue-control">
                        <button class="t-queue-num-btn" id="t-queue-interval-dec">-</button>
                        <span class="t-queue-num-value" id="t-queue-interval-value">${qState.interval}</span>
                        <button class="t-queue-num-btn" id="t-queue-interval-inc">+</button>
                    </div>
                </div>
                <div class="t-queue-row">
                    <div class="t-queue-label">历史容量</div>
                    <div class="t-queue-control">
                        <button class="t-queue-num-btn" id="t-queue-history-dec">-</button>
                        <span class="t-queue-num-value" id="t-queue-history-value">${GlobalState.sceneHistory.maxItems}</span>
                        <button class="t-queue-num-btn" id="t-queue-history-inc">+</button>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="t-queue-footer">
            <div class="t-queue-status" id="t-queue-status">
                ${qState.enabled ? '<i class="fa-solid fa-check-circle" style="color:#55efc4;"></i> 队列已激活' : '<i class="fa-solid fa-circle" style="color:#666;"></i> 队列未激活'}
            </div>
            <div class="t-queue-actions">
                <button class="t-btn" id="t-queue-cancel">取消</button>
                <button class="t-btn primary" id="t-queue-save">${qState.enabled ? '更新设置' : '激活队列'}</button>
            </div>
        </div>
    </div>`;

    $("#t-main-view").append(html);

    // --- 事件绑定 ---

    // 模式切换
    $(".t-queue-mode-btn").on("click", function () {
        const mode = $(this).data("mode");
        $(".t-queue-mode-btn").removeClass("active");
        $(this).addClass("active");

        if (mode === "random") {
            $("#t-queue-random-panel").show();
            $("#t-queue-manual-panel").hide();
        } else {
            $("#t-queue-random-panel").hide();
            $("#t-queue-manual-panel").show();
        }
    });

    // 数量控制
    $("#t-queue-count-dec").on("click", function () {
        const $val = $("#t-queue-count-value");
        let v = parseInt($val.text()) || 3;
        if (v > 1) $val.text(v - 1);
    });
    $("#t-queue-count-inc").on("click", function () {
        const $val = $("#t-queue-count-value");
        let v = parseInt($val.text()) || 3;
        if (v < 20) $val.text(v + 1);
    });

    // 间隔控制
    $("#t-queue-interval-dec").on("click", function () {
        const $val = $("#t-queue-interval-value");
        let v = parseInt($val.text()) || 2;
        if (v > 0) $val.text(v - 1);
    });
    $("#t-queue-interval-inc").on("click", function () {
        const $val = $("#t-queue-interval-value");
        let v = parseInt($val.text()) || 2;
        if (v < 30) $val.text(v + 1);
    });

    // 历史容量控制
    $("#t-queue-history-dec").on("click", function () {
        const $val = $("#t-queue-history-value");
        let v = parseInt($val.text()) || 5;
        if (v > 5) $val.text(v - 5);
    });
    $("#t-queue-history-inc").on("click", function () {
        const $val = $("#t-queue-history-value");
        let v = parseInt($val.text()) || 5;
        if (v < 50) $val.text(v + 5);
    });

    // 剧本选择
    $(".t-queue-script-item").on("click", function (e) {
        if ($(e.target).is("input")) return; // 让 checkbox 自己处理
        const $checkbox = $(this).find("input");
        $checkbox.prop("checked", !$checkbox.prop("checked"));
        $(this).toggleClass("selected", $checkbox.prop("checked"));
        updateSelectedCount();
    });

    $(".t-queue-script-item input").on("change", function () {
        $(this).closest(".t-queue-script-item").toggleClass("selected", $(this).prop("checked"));
        updateSelectedCount();
    });

    function updateSelectedCount() {
        const count = $(".t-queue-script-item.selected").length;
        $("#t-queue-selected-count").text(count);
    }

    // 全选/清空
    $("#t-queue-select-all").on("click", function () {
        $(".t-queue-script-item").addClass("selected").find("input").prop("checked", true);
        updateSelectedCount();
    });
    $("#t-queue-select-none").on("click", function () {
        $(".t-queue-script-item").removeClass("selected").find("input").prop("checked", false);
        updateSelectedCount();
    });

    // 保存/激活
    $("#t-queue-save").on("click", function () {
        const mode = $(".t-queue-mode-btn.active").data("mode");
        const count = parseInt($("#t-queue-count-value").text()) || 3;
        const category = $("#t-queue-category").val();
        const interval = parseInt($("#t-queue-interval-value").text()) || 2;
        const historyMax = parseInt($("#t-queue-history-value").text()) || 5;

        // 收集手动选择的剧本
        const manualItems = [];
        $(".t-queue-script-item.selected").each(function () {
            manualItems.push($(this).data("id"));
        });

        // 验证
        if (mode === "manual" && manualItems.length === 0) {
            if (window.toastr) toastr.warning("请至少选择一个剧本", "Titania");
            return;
        }

        // 更新状态
        GlobalState.queueState.enabled = true;
        GlobalState.queueState.mode = mode;
        GlobalState.queueState.count = count;
        GlobalState.queueState.categoryFilter = category;
        GlobalState.queueState.manualItems = manualItems;
        GlobalState.queueState.interval = interval;

        // 更新历史容量
        setHistoryMaxItems(historyMax);

        // 保存到持久化存储
        const d = getExtData();
        d.queue_config = {
            enabled: true,
            mode,
            count,
            categoryFilter: category,
            manualItems,
            interval,
            historyMax
        };
        saveExtData();

        // 更新队列按钮状态
        updateQueueButtonUI();

        // 关闭窗口
        $("#t-queue-settings").remove();

        if (window.toastr) toastr.success(`✨ 队列已激活：${mode === 'random' ? `随机 ${count} 个` : `${manualItems.length} 个剧本`}`, "Titania");
    });

    // 取消
    $("#t-queue-cancel").on("click", function () {
        $("#t-queue-settings").remove();
    });

    // 关闭
    $("#t-queue-close").on("click", function () {
        $("#t-queue-settings").remove();
    });
}

/**
 * 获取队列生成的剧本列表
 * @returns {Array<{id: string, name: string}>} 剧本列表
 */
export function getQueueScripts() {
    const qState = GlobalState.queueState;

    if (!qState.enabled) {
        return [];
    }

    if (qState.mode === "manual") {
        // 手动模式：返回选中的剧本
        return qState.manualItems
            .map(id => GlobalState.runtimeScripts.find(s => s.id === id))
            .filter(s => s)
            .map(s => ({ id: s.id, name: s.name }));
    } else {
        // 随机模式：根据分类筛选后随机抽取
        let pool = GlobalState.runtimeScripts;

        if (qState.categoryFilter !== "ALL") {
            pool = pool.filter(s =>
                (s.category || (s._type === 'preset' ? '官方预设' : '未分类')) === qState.categoryFilter
            );
        }

        // 随机抽取指定数量
        const shuffled = [...pool].sort(() => Math.random() - 0.5);
        const selected = shuffled.slice(0, Math.min(qState.count, shuffled.length));

        return selected.map(s => ({ id: s.id, name: s.name }));
    }
}

/**
 * 禁用队列模式
 */
export function disableQueueMode() {
    GlobalState.queueState.enabled = false;
    updateQueueButtonUI();
}
