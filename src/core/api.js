// src/core/api.js

import { getExtData } from "../utils/storage.js";
import {
    GlobalState,
    resetContinuationState,
    pushSceneToHistory,
    initQueueTasks,
    recordQueueResult,
    resetQueueState,
    getQueueProgress,
    shouldRenderStreamToUI,
    startStreamingCache,
    updateStreamingCache,
    endStreamingCache,
    clearStreamingCache,
    setCurrentGenerationResult,
    unlockDisplay,
    getCurrentDisplayContent,
    shouldSuspendStreamUiRendering,
    createPromptTrace,
    appendPromptTraceStage,
    setPromptTraceFinalMessages,
    finishPromptTrace
} from "./state.js";
import { TitaniaLogger } from "./logger.js";
import { getContextData } from "./context.js";
import {
    getChatHistory,
    detectTruncation,
    extractContinuationContext,
    mergeContinuationContent,
    extractTextSummary,
    buildContinuationContext,
    smartMergeContinuation,
    detectInteractiveContent,
    renderToShadowDOMReal,
    openInNewWindow,
    exportAsHtmlFile,
    sanitizeAIOutput,
    sanitizeAIOutputLite,
    parseWhitelistInput,
    countContentStats,
    estimateTokens
} from "../utils/helpers.js";
import { parseChatHistoryBlacklistInput } from "../utils/chatHistoryBlacklist.js";
import { startTimer, stopTimer, showCancelButton, hideCancelButton } from "../ui/floatingBtn.js";
import { applyScriptSelection, updateContentStatsDisplay, updateFavButtonUI, updateScriptTitleDisplay } from "../ui/mainWindow.js";
import {
    getPendingGenerationScriptId,
    getContinuationQuickDraft,
    getContinuationDefaultInjectCount
} from "../ui/mainWindow/viewState.js";
import {
    getActiveConnection,
    sendChatRequest,
    validateConnection
} from "./connection.js";
import { recordScriptGenerated } from "./scriptData.js";
import { getPromptScheme, buildPromptMessageDetails, DEFAULT_CONTENT_PROMPT, DEFAULT_VISUAL_PROMPT } from "./promptManager.js";
import { scheduleContinuationPersistence } from "./continuationStore.js";

// 导入 ST 的 ChatCompletionService 和配置（仅用于特殊场景）
import { ChatCompletionService } from "../../../custom-request.js";
import { oai_settings, getChatCompletionModel, tryParseStreamingError } from "../../../openai.js";

// 导入 ST 的 SSE 流处理器（用于正确处理长响应）
import EventSourceStream from "../../../sse-stream.js";

// 导入 ST 的宏处理器
import { evaluateMacros } from "../../../macros.js";

const CONTINUATION_SESSION_MAX_ROUNDS = 30;
const CONTINUATION_INJECT_MAX = 20;
const CONTINUATION_INJECT_MIN = 3;
const CONTINUATION_ARCHIVED_BRANCH_MAX = 20;
const DEFAULT_CONTINUATION_INSTRUCTION = "请基于上轮内容自然续写下一段剧情，保持风格一致并推进情节。";

function clampContinuationInjectRounds(value) {
    if (String(value ?? "").trim() === "") return 3;
    const num = Number(value);
    if (!Number.isFinite(num)) return 3;
    return Math.max(CONTINUATION_INJECT_MIN, Math.min(CONTINUATION_INJECT_MAX, Math.floor(num)));
}

/**
 * 组装 [聊天历史] 提示词块。两条生成路径共用，避免同一段说明文案分散两处。
 *
 * 只要角色发言时要换个口径：那时注入的不是一问一答的对话，而是抽掉用户输入后的
 * 发言序列，因果链本来就是断的。不说明的话模型会把它当完整对话，自己去补缺失的起因。
 */
function buildChatHistoryBlock(history, aiOnly) {
    if (!history || history.trim().length === 0) return `[聊天历史]\n（无历史记录）\n\n`;
    const note = aiOnly
        ? "以下仅为角色的近期发言，已跳过用户输入，仅供参考上下文"
        : "以下是近期对话记录，仅供参考上下文";
    return `[聊天历史]\n（${note}。请勿续写或重复此内容，专注于下方的剧本指令）\n${history}\n\n`;
}

// Token 估算统一走 helpers.js 的 estimateTokens；
// 查看器等 UI 场景由 countTokens 用 ST 真实分词器覆盖为精确值。

function createContinuationBranchKey() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `branch_${ts}_${rand}`;
}

function getContinuationRuntimeStore() {
    if (!GlobalState.continuationRuntime || typeof GlobalState.continuationRuntime !== "object") {
        GlobalState.continuationRuntime = { chatId: "", byScript: {} };
    }
    if (!GlobalState.continuationRuntime.byScript || typeof GlobalState.continuationRuntime.byScript !== "object") {
        GlobalState.continuationRuntime.byScript = {};
    }
    return GlobalState.continuationRuntime.byScript;
}

function getContinuationSessionRounds(scriptId) {
    const byScript = getContinuationRuntimeStore();
    const rounds = byScript[scriptId]?.rounds;
    if (!Array.isArray(rounds)) return [];

    return rounds
        .map((item, idx) => ({
            round: Number(item?.round) || (idx + 1),
            type: String(item?.type || "continuation"),
            instruction: String(item?.instruction || "").trim(),
            content: String(item?.content || "").trim(),
            status: String(item?.status || "legacy"),
            generationId: String(item?.generationId || ""),
            timestamp: Number(item?.timestamp) || 0
        }))
        .filter(item => item.content.length > 0);
}

function createContinuationRoundKey() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `round_${ts}_${rand}`;
}

function normalizeContinuationRounds(rounds, options = {}) {
    if (!Array.isArray(rounds)) return [];
    const persistRoundKeys = options.persistRoundKeys !== false;
    return rounds
        .map((item, index) => {
            const roundKey = String(item?.roundKey || "").trim() || createContinuationRoundKey();
            if (persistRoundKeys && item && typeof item === "object" && !item.roundKey) item.roundKey = roundKey;
            return {
                roundKey,
                round: index + 1,
                type: String(item?.type || (index === 0 ? "initial" : "continuation")),
                instruction: String(item?.instruction || "").trim(),
                content: String(item?.content || "").trim(),
                status: String(item?.status || "legacy"),
                generationId: String(item?.generationId || ""),
                timestamp: Number(item?.timestamp) || 0
            };
        })
        .filter(item => item.content.length > 0)
        .slice(0, CONTINUATION_SESSION_MAX_ROUNDS);
}

function archiveContinuationBranch(entry) {
    const branchKey = String(entry?.branchKey || "").trim();
    const rounds = normalizeContinuationRounds(entry?.rounds);
    if (!branchKey || rounds.length === 0) return;

    if (!Array.isArray(entry.archivedBranches)) entry.archivedBranches = [];
    entry.archivedBranches = [{
        branchKey,
        parentBranchKey: String(entry.parentBranchKey || "").trim(),
        branchedAtRound: Number(entry.branchedAtRound) || null,
        rounds,
        archivedAt: Date.now()
    }, ...entry.archivedBranches.filter(item => String(item?.branchKey || "") !== branchKey)]
        .slice(0, CONTINUATION_ARCHIVED_BRANCH_MAX);
}

/**
 * 定位一段正文属于哪条世系的哪一轮。
 * 场景历史项与续写轮次共享同一个 generationId，优先按它精确匹配；
 * 拿不到（如从收藏/持久化恢复的旧内容）时退化为正文比对。
 * @param {string} scriptId
 * @param {{ generationId?: string, content?: string }} probe
 * @returns {{ branchKey: string, roundKey: string, round: number, isActive: boolean, isActiveTail: boolean }|null}
 */
function findContinuationRoundAnchor(scriptId, probe = {}) {
    const entry = getContinuationRuntimeStore()[scriptId];
    if (!entry) return null;

    const wantedId = String(probe.generationId || "").trim();
    const wantedContent = String(probe.content || "").trim();
    if (!wantedId && !wantedContent) return null;

    const activeBranchKey = String(entry.branchKey || "").trim();
    const candidates = [
        { branchKey: activeBranchKey, rounds: entry.rounds, isActive: true },
        ...(Array.isArray(entry.archivedBranches) ? entry.archivedBranches : [])
            .map(branch => ({ branchKey: String(branch?.branchKey || "").trim(), rounds: branch?.rounds, isActive: false }))
    ];

    // 两轮扫描：generationId 命中优先于正文命中，避免正文重复时锚到错误的分支
    for (const matchById of [true, false]) {
        if (matchById && !wantedId) continue;
        if (!matchById && !wantedContent) continue;

        for (const candidate of candidates) {
            if (!candidate.branchKey) continue;
            const rounds = normalizeContinuationRounds(candidate.rounds, { persistRoundKeys: false });
            const index = rounds.findIndex(item => matchById
                ? String(item.generationId || "").trim() === wantedId
                : item.content === wantedContent);
            if (index < 0) continue;

            return {
                branchKey: candidate.branchKey,
                roundKey: rounds[index].roundKey,
                round: index + 1,
                isActive: candidate.isActive,
                isActiveTail: candidate.isActive && index === rounds.length - 1
            };
        }
    }
    return null;
}

/**
 * 以给定正文为根另起一条续写分支。
 * 必须先 resetContinuationSessionRounds：setContinuationSessionBaseRound 会把旧 rounds 里
 * 所有非 initial 的轮次原样接到新 initial 后面，不先清就会把上一条世系的续写混进来。
 * @param {object} script
 * @param {string} baseContent
 */
async function startFreshContinuationBranch(script, baseContent, generationId = "") {
    resetContinuationSessionRounds(script.id, script.name);
    const branchContext = await getContextData();
    let branchInstruction = String(script.prompt || "");
    try {
        branchInstruction = evaluateMacros(branchInstruction, {
            char: branchContext.charName,
            user: branchContext.userName
        });
    } catch (e) {
        branchInstruction = branchInstruction
            .replace(/{{char}}/gi, branchContext.charName)
            .replace(/{{user}}/gi, branchContext.userName);
    }
    setContinuationSessionBaseRound(script.id, script.name, baseContent, {
        forceNewBranch: true,
        instruction: branchInstruction,
        generationId: String(generationId || "")
    });
}

function branchContinuationSessionAtRound(scriptId, sourceBranchKey, targetRound, targetRoundKey = "", includeTarget = false) {
    const entry = getContinuationRuntimeStore()[scriptId];
    if (!entry) return null;

    const activeBranchKey = String(entry.branchKey || "").trim();
    const requestedBranchKey = String(sourceBranchKey || activeBranchKey).trim();
    const source = requestedBranchKey === activeBranchKey
        ? { branchKey: activeBranchKey, rounds: entry.rounds }
        : (Array.isArray(entry.archivedBranches)
            ? entry.archivedBranches.find(item => String(item?.branchKey || "") === requestedBranchKey)
            : null);
    const sourceRounds = normalizeContinuationRounds(source?.rounds);
    const requestedRoundKey = String(targetRoundKey || "").trim();
    let roundNumber = requestedRoundKey
        ? sourceRounds.findIndex(item => item.roundKey === requestedRoundKey) + 1
        : Math.floor(Number(targetRound));
    // 旧数据没有持久化 roundKey 时，调用方拿到的临时 key无法跨规范化复用，按稳定轮次号回退。
    if (requestedRoundKey && roundNumber === 0) roundNumber = Math.floor(Number(targetRound));
    if (!source || !Number.isFinite(roundNumber) || roundNumber < 1 || roundNumber > sourceRounds.length) return null;

    const previousActiveBranch = {
        branchKey: activeBranchKey,
        parentBranchKey: String(entry.parentBranchKey || "").trim(),
        branchedAtRound: Number(entry.branchedAtRound) || null,
        rounds: normalizeContinuationRounds(entry.rounds)
    };
    archiveContinuationBranch(entry);
    entry.branchKey = createContinuationBranchKey();
    entry.parentBranchKey = requestedBranchKey;
    entry.branchedAtRound = roundNumber;
    entry.rounds = sourceRounds.slice(0, includeTarget ? roundNumber : roundNumber - 1);

    return {
        sourceBranchKey: requestedBranchKey,
        branchKey: entry.branchKey,
        targetRound: roundNumber,
        targetInstruction: sourceRounds[roundNumber - 1]?.instruction || "",
        contextRounds: normalizeContinuationRounds(entry.rounds),
        previousActiveBranch
    };
}

function restoreContinuationBranchAfterFailedGeneration(scriptId, branchResult) {
    const entry = getContinuationRuntimeStore()[scriptId];
    const previous = branchResult?.previousActiveBranch;
    if (!entry || !previous || String(entry.branchKey || "") !== String(branchResult.branchKey || "")) return;
    if (normalizeContinuationRounds(entry.rounds).length !== branchResult.contextRounds.length) return;

    entry.branchKey = previous.branchKey;
    entry.parentBranchKey = previous.parentBranchKey;
    entry.branchedAtRound = previous.branchedAtRound;
    entry.rounds = previous.rounds;
    if (Array.isArray(entry.archivedBranches)) {
        entry.archivedBranches = entry.archivedBranches.filter(item => String(item?.branchKey || "") !== previous.branchKey);
    }
}

function setContinuationSessionBaseRound(scriptId, scriptName, content, options = {}) {
    if (!scriptId) return;

    const textContent = String(content || "").trim();
    if (!textContent) return;

    const forceNewBranch = options?.forceNewBranch === true;
    const providedBranchKey = typeof options?.branchKey === "string" ? options.branchKey.trim() : "";
    const instruction = typeof options?.instruction === "string" ? options.instruction.trim() : "";

    const byScript = getContinuationRuntimeStore();
    const current = byScript[scriptId];
    const oldRounds = Array.isArray(current?.rounds) ? current.rounds : [];
    const continuationRounds = oldRounds.filter(item => String(item?.type || "continuation") !== "initial");
    const nextBranchKey = providedBranchKey
        || (forceNewBranch ? createContinuationBranchKey() : String(current?.branchKey || "").trim())
        || createContinuationBranchKey();

    byScript[scriptId] = {
        scriptId,
        scriptName: scriptName || current?.scriptName || "场景",
        branchKey: nextBranchKey,
        archivedBranches: Array.isArray(current?.archivedBranches) ? current.archivedBranches : [],
        rounds: [
            {
                round: 1,
                roundKey: createContinuationRoundKey(),
                type: "initial",
                instruction: instruction || "（首次生成）",
                content: textContent,
                status: String(options?.status || "success"),
                generationId: String(options?.generationId || ""),
                timestamp: Date.now()
            },
            ...continuationRounds
        ]
    };

    byScript[scriptId].rounds = byScript[scriptId].rounds
        .slice(0, CONTINUATION_SESSION_MAX_ROUNDS)
        .map((item, index) => ({
            ...item,
            round: index + 1,
            type: String(item?.type || (index === 0 ? "initial" : "continuation"))
        }));
    scheduleContinuationPersistence();
}

function appendContinuationSessionRound(scriptId, scriptName, instruction, content, options = {}) {
    if (!scriptId) return;

    const textContent = String(content || "").trim();
    if (!textContent) return;

    const byScript = getContinuationRuntimeStore();

    if (!byScript[scriptId] || typeof byScript[scriptId] !== "object") {
        byScript[scriptId] = {
            scriptId,
            scriptName: scriptName || "场景",
            branchKey: createContinuationBranchKey(),
            rounds: []
        };
    }

    if (!Array.isArray(byScript[scriptId].rounds)) {
        byScript[scriptId].rounds = [];
    }

    const rounds = byScript[scriptId].rounds;
    rounds.push({
        round: rounds.length + 1,
        roundKey: createContinuationRoundKey(),
        type: "continuation",
        instruction: String(instruction || "").trim(),
        content: textContent,
        status: String(options?.status || "success"),
        generationId: String(options?.generationId || ""),
        timestamp: Date.now()
    });

    while (rounds.length > CONTINUATION_SESSION_MAX_ROUNDS) {
        rounds.splice(rounds[0]?.type === "initial" ? 1 : 0, 1);
    }

    rounds.forEach((item, index) => {
        item.round = index + 1;
    });

    byScript[scriptId].scriptName = scriptName || byScript[scriptId].scriptName || "场景";
    if (!String(byScript[scriptId].branchKey || "").trim()) {
        byScript[scriptId].branchKey = createContinuationBranchKey();
    }
    scheduleContinuationPersistence();
}

/**
 * 同步用户编辑后的内容到续写会话轮次缓存
 * @param {string} scriptId
 * @param {string} previousContent
 * @param {string} editedContent
 * @param {string} scriptName
 * @returns {boolean}
 */
export function syncEditedContentToContinuationSession(scriptId, previousContent, editedContent, scriptName = "场景") {
    if (!scriptId) return false;

    const newText = String(editedContent || "").trim();
    if (!newText) return false;

    const oldText = String(previousContent || "").trim();
    const byScript = getContinuationRuntimeStore();
    const entry = byScript[scriptId];
    const rounds = Array.isArray(entry?.rounds) ? entry.rounds : null;

    if (!rounds || rounds.length === 0) return false;

    let targetIndex = -1;

    if (oldText) {
        for (let i = rounds.length - 1; i >= 0; i--) {
            const roundContent = String(rounds[i]?.content || "").trim();
            if (roundContent === oldText) {
                targetIndex = i;
                break;
            }
        }
    }

    if (targetIndex === -1) {
        // 找不到精确匹配时，默认覆盖最近一轮，避免收藏继续使用过期正文
        targetIndex = rounds.length - 1;
    }

    rounds[targetIndex].content = newText;
    rounds[targetIndex].timestamp = Date.now();
    entry.scriptName = scriptName || entry.scriptName || "场景";

    rounds.forEach((item, index) => {
        item.round = index + 1;
    });

    scheduleContinuationPersistence();

    return true;
}

function resetContinuationSessionRounds(scriptId, scriptName = "场景") {
    if (!scriptId) return;
    const byScript = getContinuationRuntimeStore();
    const current = byScript[scriptId];
    if (current) archiveContinuationBranch(current);
    byScript[scriptId] = {
        scriptId,
        scriptName: scriptName || "场景",
        branchKey: null,
        archivedBranches: Array.isArray(current?.archivedBranches) ? current.archivedBranches : [],
        rounds: [],
        resetAt: Date.now()
    };
}

function buildContinuationSessionInjection(scriptId, injectRoundsCount) {
    const rounds = getContinuationSessionRounds(scriptId);
    const takeCount = clampContinuationInjectRounds(injectRoundsCount);
    const selectedRounds = rounds.slice(-takeCount);

    if (selectedRounds.length === 0) {
        return {
            totalRounds: 0,
            selectedRounds: [],
            text: "（无历史续写轮次，这是首轮主动续写）",
            estimatedChars: 0,
            estimatedTokens: 0
        };
    }

    const block = selectedRounds.map(item => {
        const roundLabel = `第${item.round}轮`;
        const instructionText = item.instruction || "（自然续写）";
        return `[${roundLabel} 指令]\n${instructionText}\n\n[${roundLabel} 结果]\n${item.content}`;
    }).join("\n\n");

    const estimatedChars = block.length;
    return {
        totalRounds: rounds.length,
        selectedRounds,
        text: block,
        estimatedChars,
        estimatedTokens: estimateTokens(block)
    };
}

/**
 * 只读取得当前显示轮次所在世系的祖先链，不改变活动分支。
 * @param {string} scriptId
 * @param {{ branchKey: string, roundKey: string, round: number }} anchor
 * @returns {Array}
 */
function getContinuationRoundsThroughAnchor(scriptId, anchor) {
    const entry = getContinuationRuntimeStore()[scriptId];
    if (!entry || !anchor) return [];

    const activeBranchKey = String(entry.branchKey || "").trim();
    const requestedBranchKey = String(anchor.branchKey || "").trim();
    const source = requestedBranchKey === activeBranchKey
        ? entry
        : (Array.isArray(entry.archivedBranches)
            ? entry.archivedBranches.find(branch => String(branch?.branchKey || "").trim() === requestedBranchKey)
            : null);
    const rounds = normalizeContinuationRounds(source?.rounds, { persistRoundKeys: false });
    const requestedRoundKey = String(anchor.roundKey || "").trim();
    let anchorIndex = requestedRoundKey
        ? rounds.findIndex(round => round.roundKey === requestedRoundKey)
        : -1;
    // 旧数据没有持久化 roundKey，纯读取规范化每次会产生临时 key；此时按稳定轮次号回退。
    if (anchorIndex < 0) anchorIndex = Math.floor(Number(anchor.round)) - 1;

    if (anchorIndex < 0 || anchorIndex >= rounds.length) return [];
    return rounds.slice(0, anchorIndex + 1);
}

function buildContinuationBranchInjection(rounds) {
    const selectedRounds = normalizeContinuationRounds(rounds);
    if (selectedRounds.length === 0) {
        return {
            totalRounds: 0,
            selectedRounds: [],
            text: "（无历史轮次，将重新生成第1轮）",
            estimatedChars: 0,
            estimatedTokens: 0
        };
    }

    const text = selectedRounds.map(item => {
        const instructionText = item.instruction || "（自然续写）";
        return `[第${item.round}轮 指令]\n${instructionText}\n\n[第${item.round}轮 结果]\n${item.content}`;
    }).join("\n\n");
    return {
        totalRounds: selectedRounds.length,
        selectedRounds,
        text,
        estimatedChars: text.length,
        estimatedTokens: estimateTokens(text)
    };
}

/**
 * 拼装主动续写的 promptOverride。
 * 实际发起续写与“当前预览”共用这一份模板，避免两边文案漂移导致预览 token 与真实请求对不上。
 * 返回的 lengths 用于把 [剧本指令] 块在提示词查看器里拆成三段独立计数。
 * @param {{ injectionText: string, userInstruction: string, crossRoleSource?: string }} params
 * @returns {{ text: string, lengths: { continuationPreamble: number, continuationContext: number, continuationInstruction: number } }}
 */
function composeContinuationPromptOverride({ injectionText, userInstruction, crossRoleSource = "" }) {
    const crossRoleBlock = crossRoleSource
        ? `\n[跨角色续写]\n以下历史内容来自角色“${crossRoleSource}”参与的既有剧情。保留历史中已经出现的人物、身份和事件，不要把原角色替换或改名。当前角色是新进入剧情的参与者，应依据当前角色设定自然加入。\n`
        : "";
    const preamble = `[续写模式]\n你将基于已有剧情进行多轮续写生成。${crossRoleBlock}\n请保持人物、语气、设定与视觉风格一致，在不重复已有文本的前提下推进剧情。\n输出要求与普通生成一致：输出可直接渲染的原始 HTML，不要 Markdown 代码块。`;
    const contextBlock = `\n\n[续写会话上下文]\n（以下为历史续写轮次，包含“指令+结果”，用于保持多轮连续性）\n${injectionText}`;
    const instructionBlock = `\n\n[本轮续写指令]\n${userInstruction}`;

    return {
        text: `${preamble}${contextBlock}${instructionBlock}`,
        lengths: {
            continuationPreamble: preamble.length,
            continuationContext: contextBlock.length,
            continuationInstruction: instructionBlock.length
        }
    };
}

/**
 * 写入 [剧本指令] 块的分段长度。
 * 续写口径下把该块拆成「表头 / 续写模式说明 / 续写会话上下文 / 本轮续写指令」四段，
 * 让提示词查看器能单独看到续写历史吃掉多少 token。
 * 查看器按键顺序连续切片，故四段长度之和必须等于整块长度；对不上时退回单段计数。
 * @param {object} sectionLengths 就地修改
 * @param {string} scriptBlock 完整的 [剧本指令] 块
 * @param {string} promptBody 块内的提示词正文（表头之后的部分）
 * @param {{continuationPreamble:number,continuationContext:number,continuationInstruction:number}|null} continuationLengths
 */
function applyScriptInstructionSectionLengths(sectionLengths, scriptBlock, promptBody, continuationLengths) {
    const parts = continuationLengths
        ? [continuationLengths.continuationPreamble, continuationLengths.continuationContext, continuationLengths.continuationInstruction]
        : null;

    if (!parts || parts.some(length => !Number.isFinite(length)) || parts.reduce((sum, length) => sum + length, 0) !== promptBody.length) {
        sectionLengths.scriptInstruction = scriptBlock.length;
        return;
    }

    sectionLengths.scriptInstruction = scriptBlock.length - promptBody.length;
    sectionLengths.continuationPreamble = parts[0];
    sectionLengths.continuationContext = parts[1];
    sectionLengths.continuationInstruction = parts[2];
}

/**
 * 判定“当前预览”是否应该按主动续写口径构造，并给出对应的提示词覆盖。
 * 判定条件与 modern.js 的 getQuickAction()/getQuickScriptId() 保持一致，
 * 使预览始终等于“下一次点发送真正会发出去的提示词”。
 * @returns {{ scriptId: string, injection: object, injectRoundsCount: number, userInstruction: string, override: object }|null}
 */
function resolveContinuationPreviewPlan() {
    // 选中了新剧本但还没演绎时，下一步动作是“演绎”而非“续写”
    if (getPendingGenerationScriptId()) return null;

    const display = getCurrentDisplayContent();
    const displayContent = String(display?.content || "").trim();
    if (!displayContent) return null;

    const scriptId = display?.scriptId || GlobalState.lastGeneratedScriptId || GlobalState.lastUsedScriptId || "";
    if (!scriptId) return null;

    const injectRoundsCount = getContinuationDefaultInjectCount();
    const anchor = findContinuationRoundAnchor(scriptId, {
        generationId: display?.generationId,
        content: displayContent
    });

    let injection;
    if (anchor?.isActiveTail) {
        injection = buildContinuationSessionInjection(scriptId, injectRoundsCount);
    } else if (anchor) {
        const ancestorRounds = getContinuationRoundsThroughAnchor(scriptId, anchor);
        injection = buildContinuationBranchInjection(ancestorRounds.slice(-clampContinuationInjectRounds(injectRoundsCount)));
        injection.totalRounds = ancestorRounds.length;
    } else {
        // 收藏、编辑或旧数据可能不在续写世系中。真实续写会以当前显示内容另起根轮；
        // 预览阶段只构造等价的临时单轮上下文，不写入或切换活动分支。
        injection = buildContinuationBranchInjection([{
            round: 1,
            type: "initial",
            instruction: "（首次生成）",
            content: displayContent,
            status: "legacy",
            generationId: String(display?.generationId || "")
        }]);
    }

    if (injection.totalRounds === 0) return null;

    const userInstruction = getContinuationQuickDraft().trim() || DEFAULT_CONTINUATION_INSTRUCTION;

    return {
        scriptId,
        injection,
        injectRoundsCount,
        userInstruction,
        override: composeContinuationPromptOverride({
            injectionText: injection.text,
            userInstruction
        })
    };
}

/**
 * 获取主动续写会话统计信息（用于续写窗口显示）
 * @param {string} scriptId
 * @param {number} injectRoundsCount
 * @returns {{ totalRounds: number, selectedRounds: number, estimatedChars: number, estimatedTokens: number }}
 */
export function getContinuationSessionStats(scriptId, injectRoundsCount = 3) {
    if (!scriptId) {
        return {
            totalRounds: 0,
            selectedRounds: 0,
            estimatedChars: 0,
            estimatedTokens: 0
        };
    }

    const injection = buildContinuationSessionInjection(scriptId, injectRoundsCount);
    return {
        totalRounds: injection.totalRounds,
        selectedRounds: injection.selectedRounds.length,
        estimatedChars: injection.estimatedChars,
        estimatedTokens: injection.estimatedTokens
    };
}

export function getContinuationBranches(scriptId) {
    if (!scriptId) return [];
    const entry = getContinuationRuntimeStore()[scriptId];
    if (!entry) return [];

    const toPublicBranch = (branch, isActive) => ({
        branchKey: String(branch?.branchKey || "").trim(),
        scriptName: String(entry.scriptName || "").trim(),
        isActive,
        branchedAtRound: Number(branch?.branchedAtRound) || null,
        archivedAt: Number(branch?.archivedAt) || 0,
        rounds: normalizeContinuationRounds(branch?.rounds).map((item, index) => ({
            roundKey: item.roundKey,
            round: item.round,
            type: item.type,
            continuationIndex: item.type === "initial" ? 0 : index,
            instruction: item.instruction,
            content: item.content,
            contentPreview: item.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80),
            contentLength: item.content.length,
            timestamp: item.timestamp
        }))
    });

    const branches = [];
    if (String(entry.branchKey || "").trim() && normalizeContinuationRounds(entry.rounds).length > 0) {
        branches.push(toPublicBranch(entry, true));
    }
    if (Array.isArray(entry.archivedBranches)) {
        branches.push(...entry.archivedBranches.map(branch => toPublicBranch(branch, false)));
    }
    return branches.filter(branch => branch.branchKey && branch.rounds.length > 0);
}

export function getContinuationSessions() {
    return Object.entries(getContinuationRuntimeStore())
        .map(([scriptId, entry]) => {
            const branches = getContinuationBranches(scriptId);
            const roundTimestamps = branches.flatMap(branch => branch.rounds.map(round => Number(round.timestamp) || 0));
            return {
                scriptId,
                scriptName: String(entry?.scriptName || "").trim() || "未知剧本",
                updatedAt: Math.max(...roundTimestamps, Number(entry?.updatedAt) || 0),
                branches,
                roundCount: branches.reduce((sum, branch) => sum + branch.rounds.length, 0)
            };
        })
        .filter(session => session.branches.length > 0)
        .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function copyContinuationBranchToCurrentChat(source = {}) {
    const scriptId = String(source.scriptId || "").trim();
    const sourceRounds = normalizeContinuationRounds(source.rounds);
    const targetRoundKey = String(source.roundKey || "").trim();
    const targetIndex = targetRoundKey ? sourceRounds.findIndex(round => round.roundKey === targetRoundKey) : sourceRounds.length - 1;
    if (!scriptId || targetIndex < 0) return null;
    const byScript = getContinuationRuntimeStore();
    const current = byScript[scriptId];
    if (current) archiveContinuationBranch(current);
    const copiedRounds = sourceRounds.slice(0, targetIndex + 1).map((round, index) => ({
        ...round,
        round: index + 1,
        roundKey: createContinuationRoundKey(),
        timestamp: Date.now() + index
    }));
    byScript[scriptId] = {
        scriptId,
        scriptName: String(source.scriptName || current?.scriptName || "场景"),
        branchKey: createContinuationBranchKey(),
        parentBranchKey: "",
        branchedAtRound: copiedRounds.length,
        rounds: copiedRounds,
        archivedBranches: Array.isArray(current?.archivedBranches) ? current.archivedBranches : [],
        origin: {
            chatId: String(source.chatId || ""),
            characterId: String(source.characterId || ""),
            characterName: String(source.characterName || "未知角色"),
            scriptId,
            branchKey: String(source.branchKey || ""),
            roundKey: targetRoundKey
        }
    };
    scheduleContinuationPersistence();
    return {
        scriptId,
        branchKey: byScript[scriptId].branchKey,
        roundKey: copiedRounds[copiedRounds.length - 1].roundKey,
        content: copiedRounds[copiedRounds.length - 1].content
    };
}

/** Remove selected continuation sessions, branches, or rounds. */
export function deleteContinuationHistorySelections(selections = []) {
    const selected = new Set((Array.isArray(selections) ? selections : []).map(item =>
        `${String(item?.scriptId || "")}\u0000${String(item?.branchKey || "")}\u0000${String(item?.roundKey || "")}`
    ));
    const byScript = getContinuationRuntimeStore();
    let deletedSessions = 0;
    let deletedBranches = 0;
    let deletedRounds = 0;

    for (const [scriptId, entry] of Object.entries(byScript)) {
        const sessionKey = `${scriptId}\u0000\u0000`;
        const allBranches = [
            { ...entry, isActive: true },
            ...(Array.isArray(entry.archivedBranches) ? entry.archivedBranches.map(branch => ({ ...branch, isActive: false })) : [])
        ];
        if (selected.has(sessionKey)) {
            delete byScript[scriptId];
            deletedSessions++;
            deletedBranches += allBranches.length;
            deletedRounds += allBranches.reduce((sum, branch) => sum + (Array.isArray(branch.rounds) ? branch.rounds.length : 0), 0);
            continue;
        }

        const keptBranches = [];
        for (const branch of allBranches) {
            const branchKey = String(branch.branchKey || "");
            const branchSelectionKey = `${scriptId}\u0000${branchKey}\u0000`;
            if (selected.has(branchSelectionKey)) {
                deletedBranches++;
                deletedRounds += Array.isArray(branch.rounds) ? branch.rounds.length : 0;
                continue;
            }
            const rounds = Array.isArray(branch.rounds) ? branch.rounds : [];
            const roundSelections = new Set([...selected]
                .filter(key => key.startsWith(`${scriptId}\u0000${branchKey}\u0000`))
                .map(key => key.split("\u0000")[2]));
            if (roundSelections.size > 0) {
                const initialSelected = rounds.some(round => round.type === "initial" && roundSelections.has(String(round.roundKey || "")));
                if (initialSelected) {
                    deletedBranches++;
                    deletedRounds += rounds.length;
                    continue;
                }
                branch.rounds = rounds.filter(round => {
                    const shouldDelete = roundSelections.has(String(round.roundKey || ""));
                    if (shouldDelete) deletedRounds++;
                    return !shouldDelete;
                });
            }
            if (branch.rounds.length > 0) keptBranches.push(branch);
            else deletedBranches++;
        }

        if (keptBranches.length === 0) {
            delete byScript[scriptId];
            deletedSessions++;
            continue;
        }
        const active = keptBranches.find(branch => branch.isActive) || keptBranches
            .slice()
            .sort((a, b) => Math.max(...(b.rounds || []).map(round => Number(round.timestamp) || 0)) - Math.max(...(a.rounds || []).map(round => Number(round.timestamp) || 0)))[0];
        const activeBranch = keptBranches.find(branch => branch.branchKey === active.branchKey);
        entry.branchKey = activeBranch.branchKey;
        entry.parentBranchKey = activeBranch.parentBranchKey || "";
        entry.branchedAtRound = activeBranch.branchedAtRound || null;
        entry.rounds = activeBranch.rounds;
        entry.archivedBranches = keptBranches
            .filter(branch => branch.branchKey !== activeBranch.branchKey)
            .map(branch => ({
                branchKey: branch.branchKey,
                parentBranchKey: branch.parentBranchKey || "",
                branchedAtRound: branch.branchedAtRound || null,
                archivedAt: branch.archivedAt || 0,
                rounds: branch.rounds
            }));
    }
    if (deletedSessions || deletedBranches || deletedRounds) scheduleContinuationPersistence();
    return { deletedSessions, deletedBranches, deletedRounds };
}

export function findContinuationRoundByContent(scriptId, content) {
    const targetContent = String(content || "").trim();
    if (!scriptId || !targetContent) return null;

    for (const branch of getContinuationBranches(scriptId)) {
        const round = branch.rounds.find(item => String(item.content || "").trim() === targetContent);
        if (round) {
            return {
                branchKey: branch.branchKey,
                isActive: branch.isActive,
                roundKey: round.roundKey,
                round: round.round,
                type: round.type,
                continuationIndex: round.continuationIndex,
                instruction: round.instruction,
                content: round.content
            };
        }
    }
    return null;
}

/**
 * 获取用于收藏的续写轮次数据（运行时快照）
 * @param {string} scriptId
 * @returns {{ scriptId: string | null, scriptName: string, branchKey: string, rounds: Array<{round:number,instruction:string,content:string,timestamp:number}> }}
 */
export function getContinuationRoundsForFav(scriptId) {
    if (!scriptId) {
        return {
            scriptId: null,
            scriptName: "",
            branchKey: "",
            rounds: []
        };
    }

    const byScript = getContinuationRuntimeStore();
    const entry = byScript[scriptId];

    return {
        scriptId,
        scriptName: String(entry?.scriptName || "场景"),
        branchKey: String(entry?.branchKey || "").trim(),
        // 收藏入口会先校验当前结果已成功；这里必须保留该分支中已有内容的中断轮次，
        // 否则“首段中断后主动续写成功”的收藏会只剩续写段。
        rounds: getContinuationSessionRounds(scriptId).filter(item =>
            ["success", "partial", "aborted", "legacy"].includes(String(item?.status || "legacy"))
            && String(item?.content || "").trim().length > 0
        )
    };
}

/**
 * 将生成的内容渲染到主窗口（Shadow DOM 方式 + 互动检测）
 * @param {string} content - 要渲染的 HTML 内容
 * @param {string} scriptName - 剧本名称（用于导出/新窗口标题）
 * @param {boolean} isStreaming - 是否为流式渲染中（不进行互动检测）
 */
export function renderGeneratedContent(content, scriptName = "场景", isStreaming = false) {
    const container = document.getElementById("t-output-content");
    if (!container) {
        TitaniaLogger.warn("renderGeneratedContent: 容器不存在");
        return;
    }

    // 流式渲染时保留滚动位置，避免每次重绘把滚动条弹回顶部
    const scrollContainer = document.querySelector(".t-content-area");
    const streamScrollState = isStreaming && scrollContainer
        ? {
            top: scrollContainer.scrollTop,
            height: scrollContainer.scrollHeight,
            // 当用户已经接近底部时，维持自动跟随
            stickToBottom: (scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop) <= 24
        }
        : null;

    // 流式渲染时不打印日志（太频繁）
    if (!isStreaming) {
        TitaniaLogger.info("renderGeneratedContent 开始", {
            contentLength: content?.length || 0,
            scriptName
        });
    }

    // 清除之前的浮动按钮（仅在非流式时）
    if (!isStreaming) {
        $("#t-interactive-fab").remove();
    }

    try {
        // 使用 Shadow DOM 渲染内容（流式阶段优先增量更新，避免整块重绘）
        const shadowContentEl = ensureShadowContentElement(container, content);
        if (shadowContentEl) {
            if (isStreaming) {
                applyStreamingShadowUpdate(shadowContentEl, content);
            } else {
                shadowContentEl.innerHTML = String(content || "");
                lastStreamRenderedContent = String(content || "");
            }
        } else {
            // 极端情况下回退到完整重建
            renderToShadowDOMReal(container, content);
            lastStreamRenderedContent = String(content || "");
        }
        if (!isStreaming) {
            TitaniaLogger.info("Shadow DOM 渲染完成");
        }
    } catch (e) {
        TitaniaLogger.error("Shadow DOM 渲染失败", e);
        // 降级到直接 innerHTML
        container.innerHTML = content;
    }

    if (streamScrollState && scrollContainer) {
        requestAnimationFrame(() => {
            if (streamScrollState.stickToBottom) {
                scrollContainer.scrollTop = scrollContainer.scrollHeight;
            } else {
                const maxTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
                scrollContainer.scrollTop = Math.min(streamScrollState.top, maxTop);
            }
        });
    }

    // 流式渲染时不进行互动检测（等完成后再检测）
    if (!isStreaming) {
        // 非流式阶段改为闲时检测，优先保证首屏响应
        scheduleInteractiveDetection(content, scriptName);
    }
}

let interactiveDetectionIdleHandle = null;
let interactiveDetectionTimer = null;
let interactiveDetectionToken = 0;
let lastStreamRenderedContent = "";

function ensureShadowContentElement(container, initialContent = "") {
    const host = container.querySelector(".t-shadow-host");
    const existingShadow = host && host.shadowRoot ? host.shadowRoot : null;
    const existingContentEl = existingShadow ? existingShadow.querySelector(".t-shadow-content") : null;
    if (existingContentEl) return existingContentEl;

    const shadow = renderToShadowDOMReal(container, initialContent || "");
    return shadow ? shadow.querySelector(".t-shadow-content") : null;
}

function applyStreamingShadowUpdate(contentEl, nextContent) {
    const normalizedNext = String(nextContent || "");
    if (!contentEl) return;
    if (normalizedNext === lastStreamRenderedContent) return;

    // 注意：流式 chunk 可能在 HTML 标签中间断开，直接 append delta 会破坏 DOM。
    // 这里保留 Shadow DOM 容器复用，仅更新内容节点的完整 innerHTML，保证结构正确。
    contentEl.innerHTML = normalizedNext;

    lastStreamRenderedContent = normalizedNext;
}

function clearPendingInteractiveDetection() {
    if (interactiveDetectionIdleHandle !== null && typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(interactiveDetectionIdleHandle);
    }
    interactiveDetectionIdleHandle = null;

    if (interactiveDetectionTimer !== null) {
        clearTimeout(interactiveDetectionTimer);
    }
    interactiveDetectionTimer = null;
}

function scheduleInteractiveDetection(content, scriptName) {
    clearPendingInteractiveDetection();
    const token = ++interactiveDetectionToken;
    const normalizedContent = String(content || "");

    const run = () => {
        if (token !== interactiveDetectionToken) return;
        const interactiveResult = detectInteractiveContent(normalizedContent);
        TitaniaLogger.info("互动检测结果", interactiveResult);

        if (interactiveResult.isInteractive) {
            showInteractiveFAB(scriptName, normalizedContent, interactiveResult.reasons);
        }
    };

    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
        interactiveDetectionIdleHandle = window.requestIdleCallback(() => {
            interactiveDetectionIdleHandle = null;
            run();
        }, { timeout: 320 });
        return;
    }

    interactiveDetectionTimer = setTimeout(() => {
        interactiveDetectionTimer = null;
        run();
    }, 60);
}

/**
 * 流式渲染更新（节流版本，避免过于频繁的 DOM 更新）
 * 增强版：支持显示层分离，用户查看历史时不干扰
 */
let streamRenderTimer = null;
let pendingStreamContent = "";
let lastRenderTime = 0;
const STREAM_RENDER_INTERVAL = 100; // 每 100ms 最多渲染一次

function scheduleStreamRender(content, scriptName) {
    pendingStreamContent = content;

    // 始终更新流式缓存（后台记录）
    updateStreamingCache(content);

    // 收藏管理器打开时，暂停流式 DOM 渲染，避免主线程争用
    if (shouldSuspendStreamUiRendering()) {
        return;
    }

    // 检查是否应该渲染到UI（用户可能在查看历史）
    if (!shouldRenderStreamToUI()) {
        // 用户正在查看历史，不渲染到UI，但更新"有新内容"指示器
        updateNewContentIndicator();
        return;
    }

    const now = Date.now();
    const timeSinceLastRender = now - lastRenderTime;

    // 如果距离上次渲染超过间隔，立即渲染
    if (timeSinceLastRender >= STREAM_RENDER_INTERVAL) {
        lastRenderTime = now;
        renderGeneratedContent(pendingStreamContent, scriptName, true);
        return;
    }

    // 否则设置定时器
    if (!streamRenderTimer) {
        streamRenderTimer = setTimeout(() => {
            streamRenderTimer = null;
            lastRenderTime = Date.now();
            // 再次检查，因为用户可能在这段时间内切换了
            if (shouldRenderStreamToUI()) {
                renderGeneratedContent(pendingStreamContent, scriptName, true);
            }
        }, STREAM_RENDER_INTERVAL - timeSinceLastRender);
    }
}

/**
 * 更新"有新内容正在生成"的指示器
 * 当用户在查看历史时，显示一个提示让用户知道有新内容
 */
function updateNewContentIndicator() {
    const $indicator = $("#t-new-content-indicator");
    if ($indicator.length === 0 && $("#t-main-view").length > 0) {
        // 创建指示器
        const indicatorHtml = `
            <div id="t-new-content-indicator" class="t-new-content-indicator">
                <i class="fa-solid fa-spinner fa-spin"></i>
                <span>新内容生成中...</span>
                <button id="t-goto-live" class="t-goto-live-btn">查看</button>
            </div>
        `;
        $(".t-content-wrapper").append(indicatorHtml);

        // 绑定点击事件：跳转到实时内容
        $("#t-goto-live").on("click", function () {
            // 解锁显示层，返回实时状态
            unlockDisplay();
            // 重置历史索引到最新
            GlobalState.sceneHistory.currentIndex = 0;
            // 渲染当前流式内容
            if (GlobalState.streamingCache.content) {
                renderGeneratedContent(
                    GlobalState.streamingCache.content,
                    GlobalState.streamingCache.scriptName || "场景",
                    true
                );
            }
            // 更新导航UI
            if (typeof window.updateSceneHistoryNav === 'function') {
                window.updateSceneHistoryNav();
            }
            // 移除指示器
            $("#t-new-content-indicator").remove();
        });
    }
}

/**
 * 移除新内容指示器
 */
function removeNewContentIndicator() {
    $("#t-new-content-indicator").fadeOut(200, function () {
        $(this).remove();
    });
}

/**
 * 显示生成完成通知
 * 当用户正在查看历史记录时，新内容生成完成后显示通知
 * @param {string} scriptName - 剧本名称
 */
function showGenerationCompleteNotification(scriptName) {
    // 移除正在生成的指示器
    removeNewContentIndicator();

    // 创建完成通知
    const $notification = $(`
        <div id="t-generation-complete-notification" class="t-generation-complete-notification">
            <div class="t-gcn-content">
                <i class="fa-solid fa-check-circle"></i>
                <span>《${scriptName}》生成完成</span>
            </div>
            <button id="t-gcn-view" class="t-gcn-view-btn">立即查看</button>
            <button id="t-gcn-close" class="t-gcn-close-btn">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
    `);

    // 移除已存在的通知
    $("#t-generation-complete-notification").remove();

    // 添加到内容区域
    $(".t-content-wrapper").append($notification);

    // 绑定事件
    $("#t-gcn-view").on("click", function () {
        // 解锁显示层
        unlockDisplay();
        // 重置历史索引到最新（0 是最新的）
        GlobalState.sceneHistory.currentIndex = 0;
        // 渲染最新内容
        const latestItem = GlobalState.sceneHistory.items[0];
        if (latestItem) {
            renderGeneratedContent(latestItem.content, latestItem.scriptName || "场景", false);
            // 更新全局状态
            setCurrentGenerationResult({ ...latestItem, status: latestItem.status || "legacy" });
            // 从历史记录中恢复收藏状态
            GlobalState.lastFavId = latestItem.favId || null;
        }
        // 更新导航UI
        if (typeof window.updateSceneHistoryNav === 'function') {
            window.updateSceneHistoryNav();
        }
        // 更新剧本标题显示
        updateScriptTitleDisplay();
        // 更新收藏按钮状态
        updateFavButtonUI();
        // 移除通知
        $notification.fadeOut(200, function () {
            $(this).remove();
        });
    });

    $("#t-gcn-close").on("click", function () {
        $notification.fadeOut(200, function () {
            $(this).remove();
        });
    });

    // 5秒后自动隐藏
    setTimeout(() => {
        if ($("#t-generation-complete-notification").length > 0) {
            $("#t-generation-complete-notification").fadeOut(300, function () {
                $(this).remove();
            });
        }
    }, 5000);
}

/**
 * 完成流式渲染（清理定时器并进行最终渲染）
 */
function finalizeStreamRender(content, scriptName) {
    if (streamRenderTimer) {
        clearTimeout(streamRenderTimer);
        streamRenderTimer = null;
    }
    pendingStreamContent = "";
    lastRenderTime = 0;
    clearPendingInteractiveDetection();
    // 最终渲染，包含互动检测
    renderGeneratedContent(content, scriptName, false);
}

/**
 * 显示互动内容浮动操作按钮（FAB - Floating Action Button）
 * @param {string} scriptName - 剧本名称
 * @param {string} html - 原始 HTML 内容
 * @param {string[]} reasons - 检测到的互动原因
 */
function showInteractiveFAB(scriptName, html, reasons) {
    // 移除可能存在的旧按钮
    $("#t-interactive-fab").remove();

    const reasonText = reasons.slice(0, 2).join('、');

    // 创建浮动按钮组（内联样式，避免CSS问题）
    const fabHtml = `
    <div id="t-interactive-fab" style="
        position: absolute;
        bottom: 20px;
        right: 20px;
        z-index: 200;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
    ">
        <div id="t-fab-menu" style="
            display: none;
            flex-direction: column;
            gap: 6px;
            margin-bottom: 8px;
        ">
            <div id="t-fab-open" style="
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 10px 14px;
                background: linear-gradient(90deg, #4a9eff, #6ab0ff);
                border-radius: 20px;
                color: var(--t-color-text-strong);
                font-size: 0.9em;
                font-weight: bold;
                cursor: pointer;
                box-shadow: 0 3px 12px rgba(74, 158, 255, 0.4);
                white-space: nowrap;
                transition: transform 0.2s, box-shadow 0.2s;
            " title="在新窗口中体验完整交互">
                <i class="fa-solid fa-up-right-from-square"></i>
                <span>新窗口体验</span>
            </div>
            <div id="t-fab-export" style="
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 10px 14px;
                background: var(--t-color-surface-raised);
                border: 1px solid var(--t-color-border-strong);
                border-radius: 20px;
                color: var(--t-color-text-label);
                font-size: 0.9em;
                cursor: pointer;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
                white-space: nowrap;
                transition: transform 0.2s, background 0.2s;
            " title="导出为HTML文件">
                <i class="fa-solid fa-download"></i>
                <span>导出HTML</span>
            </div>
        </div>
        <div id="t-fab-main" style="
            width: 56px;
            height: 56px;
            border-radius: 50%;
            background: linear-gradient(135deg, #4a9eff, #2d7fd3);
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            box-shadow: 0 4px 15px rgba(74, 158, 255, 0.5);
            transition: transform 0.3s, box-shadow 0.3s;
            font-size: 1.5em;
        " title="检测到互动内容（${reasonText}）">
            <span>🎮</span>
        </div>
    </div>`;

    // 添加到内容区域
    const contentWrapper = document.querySelector('.t-content-wrapper');
    if (contentWrapper) {
        $(contentWrapper).append(fabHtml);
    } else {
        // 备选：添加到主窗口
        $("#t-main-view").append(fabHtml);
    }

    // 菜单展开/收起状态
    let isExpanded = false;

    // 点击主按钮切换菜单
    $("#t-fab-main").on("click", function (e) {
        e.stopPropagation();
        isExpanded = !isExpanded;

        if (isExpanded) {
            $("#t-fab-menu").css("display", "flex");
            $(this).css({ "transform": "rotate(45deg)", "background": "#ff6b6b" });
        } else {
            $("#t-fab-menu").css("display", "none");
            $(this).css({ "transform": "rotate(0deg)", "background": "linear-gradient(135deg, #4a9eff, #2d7fd3)" });
        }
    });

    // 主按钮悬停效果
    $("#t-fab-main").hover(
        function () {
            if (!isExpanded) $(this).css({ "transform": "scale(1.1)", "box-shadow": "0 6px 20px rgba(74, 158, 255, 0.6)" });
        },
        function () {
            if (!isExpanded) $(this).css({ "transform": "scale(1)", "box-shadow": "0 4px 15px rgba(74, 158, 255, 0.5)" });
        }
    );

    // 新窗口按钮
    $("#t-fab-open").on("click", function (e) {
        e.stopPropagation();
        openInNewWindow(html, scriptName);
        if (window.toastr) toastr.info('已在新窗口中打开', 'Titania');
    }).hover(
        function () { $(this).css({ "transform": "scale(1.05)" }); },
        function () { $(this).css({ "transform": "scale(1)" }); }
    );

    // 导出按钮
    $("#t-fab-export").on("click", function (e) {
        e.stopPropagation();
        exportAsHtmlFile(html, scriptName);
        if (window.toastr) toastr.success('HTML 已下载', 'Titania');
    }).hover(
        function () { $(this).css({ "background": "#383838" }); },
        function () { $(this).css({ "background": "#2a2a2a" }); }
    );

    // 点击其他区域收起菜单
    $(document).on("click.fabclose", function (e) {
        if (!$(e.target).closest("#t-interactive-fab").length && isExpanded) {
            isExpanded = false;
            $("#t-fab-menu").css("display", "none");
            $("#t-fab-main").css({ "transform": "rotate(0deg)", "background": "linear-gradient(135deg, #4a9eff, #2d7fd3)" });
        }
    });

    TitaniaLogger.info("互动内容FAB已显示", { reasons });
}

/**
 * 取消正在进行的生成
 */
export function cancelGeneration() {
    if (GlobalState.abortController) {
        GlobalState.abortController.abort();
        GlobalState.abortController = null;
    }

    GlobalState.isGenerating = false;
    stopTimer();
    resetContinuationState();
    hideCancelButton();

    const $floatBtn = $("#titania-float-btn");
    $floatBtn.removeClass("t-loading t-anim-ripple t-anim-arc");

    TitaniaLogger.info("用户取消了生成");
    if (window.toastr) toastr.info("⏹️ 演绎已中断", "Titania");
}

/**
 * 构建“生成前”提示词组成（不发送请求）
 * @param {{ forceScriptId?: string|null, generationOverrides?: object|null }} options
 * @returns {Promise<{ok:boolean,error?:string,script?:object,messages?:Array,meta?:object,mode?:string,source?:string,connection?:object,timestamp?:number}>}
 */
export async function buildPromptCompositionPreview(options = {}) {
    try {
        const data = getExtData();
        const cfg = data.config || {};
        const dirDefaults = data.director || { instruction: "" };
        const conn = getActiveConnection();
        const generationOverrides = options.generationOverrides || null;

        const promptOverride = generationOverrides?.promptOverride;
        const hasExplicitOverride = typeof promptOverride === "string" && promptOverride.trim().length > 0;
        // 显式传入的 override 优先；否则若下一步动作是续写，就复现续写口径的提示词
        let continuationPlan = hasExplicitOverride ? null : resolveContinuationPreviewPlan();
        if (continuationPlan && options.forceScriptId && options.forceScriptId !== continuationPlan.scriptId) {
            continuationPlan = null;
        }

        const scriptId = options.forceScriptId || continuationPlan?.scriptId || GlobalState.lastUsedScriptId || $("#t-sel-script").val();
        const script = GlobalState.runtimeScripts.find(s => s.id === scriptId);
        if (!script) {
            return { ok: false, error: "未选择剧本" };
        }

        const scriptPromptSource = hasExplicitOverride
            ? promptOverride
            : (continuationPlan?.override.text ?? script.prompt);

        const generationSource = generationOverrides?.source || "preview";
        const ctx = await getContextData();

        // 根据生成模式选择系统提示词
        let sys;
        let promptScheme = getPromptScheme(data, GlobalState.generationMode);
        if (!promptScheme) {
            promptScheme = getPromptScheme(data, "narrative");
            if (window.toastr) toastr.warning("未找到活动预设，已回退到内容优先模式", "Titania");
        }
        const systemEntry = promptScheme.entries.find(entry => entry.role === "system");
        sys = systemEntry?.content || (GlobalState.generationMode === "visual" ? DEFAULT_VISUAL_PROMPT : DEFAULT_CONTENT_PROMPT);

        let user = "";
        let runtimeChatHistory = "";
        const sectionLengths = {
            director: 0,
            persona: 0,
            userDesc: 0,
            worldInfo: 0,
            history: 0,
            scriptInstruction: 0,
            // 仅续写口径下非零：把 [剧本指令] 块再拆三段（顺序即查看器的切片顺序）
            continuationPreamble: 0,
            continuationContext: 0,
            continuationInstruction: 0
        };

        // 构建导演指令区块
        const dirInstruction = dirDefaults.instruction || "";
        const styleProfiles = data.style_profiles || [{ id: "default", name: "默认 (无)", content: "" }];
        const activeStyleId = data.active_style_id || "default";
        const activeStyleProfile = styleProfiles.find(p => p.id === activeStyleId) || styleProfiles[0];
        const dStyle = activeStyleProfile ? activeStyleProfile.content : "";

        let directorSection = "";
        if (dirInstruction.trim()) {
            directorSection += dirInstruction.trim() + "\n";
        }
        if (dStyle) {
            directorSection += `文笔参考：模仿以下文风（不要复制原文）:\n<style_ref>\n${dStyle.substring(0, 1000)}\n</style_ref>\n`;
        }
        if (directorSection) {
            const block = `[导演指令]\n（以下是写作风格和格式要求，请按此风格生成内容）\n${directorSection}\n`;
            sectionLengths.director = block.length;
            user += block;
        }

        if (ctx.persona) {
            const block = `[角色人设]\n（以下是角色的性格设定，仅作为创作参考，不要在输出中重复这些内容）\n${ctx.persona}\n\n`;
            sectionLengths.persona = block.length;
            user += block;
        }
        if (ctx.userDesc) {
            const block = `[用户设定]\n（以下是用户的描述信息，仅作为创作背景参考）\n${ctx.userDesc}\n\n`;
            sectionLengths.userDesc = block.length;
            user += block;
        }
        if (ctx.worldInfo) {
            const block = `[世界观设定]\n（以下是背景设定和世界观信息，仅作为创作参考，不要在输出中直接复制）\n${ctx.worldInfo}\n\n`;
            sectionLengths.worldInfo = block.length;
            user += block;
        }

        if (GlobalState.useHistoryAnalysis) {
            const limit = cfg.history_limit || 10;
            const historyWhitelistStr = data.history_extraction?.whitelist || "";
            const historyWhitelist = parseWhitelistInput(historyWhitelistStr);
            const historyBlacklist = parseChatHistoryBlacklistInput(data.history_extraction?.blacklist || "");
            const history = getChatHistory(limit, historyWhitelist, historyBlacklist, GlobalState.historyAiOnly);
            const historyBlock = buildChatHistoryBlock(history, GlobalState.historyAiOnly);
            sectionLengths.history = historyBlock.length;
            runtimeChatHistory = historyBlock;
            user += historyBlock;
        }

        // 处理宏
        // 续写口径的正文里含历史生成结果，二次求值会误伤其中的 {{...}} 字面量，故与真实续写请求一样跳过
        const skipMacroEvaluation = generationOverrides?.skipMacroEvaluation === true || Boolean(continuationPlan);
        let processedPrompt = scriptPromptSource;
        if (!skipMacroEvaluation) {
            try {
                const macroEnv = {
                    char: ctx.charName,
                    user: ctx.userName,
                };
                processedPrompt = evaluateMacros(scriptPromptSource, macroEnv);
            } catch (e) {
                processedPrompt = scriptPromptSource
                    .replace(/{{char}}/gi, ctx.charName)
                    .replace(/{{user}}/gi, ctx.userName);
            }
        }

        const scriptBlock = `[剧本指令]\n（这是你的主要任务！请根据以下指令生成创意内容，忽略上方的聊天历史，专注于完成此创作请求）\n${processedPrompt}`;
        applyScriptInstructionSectionLengths(sectionLengths, scriptBlock, processedPrompt, continuationPlan?.override.lengths || null);
        user += scriptBlock;

        const meta = {
            source: generationSource,
            hasPromptOverride: hasExplicitOverride,
            promptOverrideLength: promptOverride ? String(promptOverride).length : 0,
            skipMacroEvaluation,
            sectionLengths,
            estimatedTokens: {
                system: estimateTokens(sys),
                user: estimateTokens(user)
            }
        };

        if (continuationPlan) {
            meta.continuation = {
                isContinuation: true,
                totalRounds: continuationPlan.injection.totalRounds,
                injectedRounds: continuationPlan.injection.selectedRounds.length,
                injectRoundsCount: continuationPlan.injectRoundsCount
            };
        }

        const runtimePromptContext = {
            ...ctx,
            worldInfoBefore: ctx.worldInfo,
            worldInfoAfter: "",
            chatHistory: runtimeChatHistory,
            titaniaScript: processedPrompt
        };

        const messageDetails = buildPromptMessageDetails(promptScheme, {
            [`${GlobalState.generationMode}_system`]: sys,
            [`${GlobalState.generationMode}_user`]: user
        }, runtimePromptContext);
        const messages = messageDetails.map(({ role, content }) => ({ role, content }));

        return {
            ok: true,
            script: {
                id: script.id,
                name: script.name
            },
            mode: GlobalState.generationMode,
            source: generationSource,
            connection: {
                profile: conn.profileName || "",
                model: conn.model || "",
                useSTConnection: !!conn.useSTConnection
            },
            promptScheme: {
                id: promptScheme.id || GlobalState.generationMode,
                name: promptScheme.name || "未命名方案",
                type: promptScheme.type || "builtin"
            },
            messages,
            messageDetails,
            meta,
            timestamp: Date.now()
        };
    } catch (e) {
        return {
            ok: false,
            error: e?.message || "preview_build_failed"
        };
    }
}

// 处理生成请求 (集成 增强版诊断系统 + 氛围驱动设计)
export async function handleGenerate(forceScriptId = null, silent = false, generationOverrides = null) {
    const data = getExtData();
    const cfg = data.config || {};
    const dirDefaults = data.director || { instruction: "" };

    // --- 0. 诊断数据初始化 ---
    const startTime = Date.now();
    const generationId = `generation_${startTime}_${Math.random().toString(36).slice(2, 8)}`;
    let diagnostics = {
        phase: 'init',
        profile: '',
        model: '',
        endpoint: '',
        input_stats: { sys_len: 0, user_len: 0 },
        network: { status: 0, statusText: '', contentType: '', latency: 0 },
        stream_stats: { chunks: 0, ttft: 0 },
        raw_response_snippet: ''
    };

    // --- 使用 connection.js 获取连接配置 ---
    const conn = getActiveConnection();

    const effectiveModel = conn.model;

    diagnostics.profile = conn.profileName;
    diagnostics.model = effectiveModel;
    diagnostics.endpoint = conn.url;

    // 验证连接配置
    const validation = validateConnection();
    if (!validation.valid) {
        const errText = `配置缺失：${validation.error}`;
        if (!silent) alert(errText);
        TitaniaLogger.error("配置错误", errText, diagnostics);
        return false;
    }

    TitaniaLogger.info("使用连接配置", {
        profile: conn.profileName,
        model: conn.model,
        useSTConnection: conn.useSTConnection
    });

    // 保持兼容性的变量（供后续流程使用）
    const useSTConnection = conn.useSTConnection;
    const finalUrl = conn.url;
    const finalKey = conn.key;
    const finalModel = effectiveModel; // 使用可能被覆盖的模型

    const scriptId = forceScriptId || GlobalState.lastUsedScriptId || $("#t-sel-script").val();
    const script = GlobalState.runtimeScripts.find(s => s.id === scriptId);
    if (!script) {
        if (!silent) alert("请选择剧本");
        return false;
    }

    const promptOverride = generationOverrides?.promptOverride;
    const scriptPromptSource = (typeof promptOverride === "string" && promptOverride.trim().length > 0)
        ? promptOverride
        : script.prompt;
    const generationSource = generationOverrides?.source || (silent ? "queue" : "manual");

    // 主动续写会话是“临时会话态”：
    // 仅 user_continuation 会延续轮次；任何新剧场生成都会重置该剧本的续写轮次。
    if (generationSource !== "user_continuation") {
        resetContinuationSessionRounds(script.id, script.name);
    }

    let promptTraceId = createPromptTrace({
        source: generationSource,
        mode: GlobalState.generationMode,
        scriptId: script.id,
        scriptName: script.name,
        profile: conn.profileName,
        model: finalModel,
        extraMeta: {
            silent,
            useSTConnection,
            hasPromptOverride: typeof promptOverride === "string" && promptOverride.trim().length > 0,
            keepOverlayOpen: generationOverrides?.keepOverlayOpen === true,
            skipMacroEvaluation: generationOverrides?.skipMacroEvaluation === true
        }
    });

    appendPromptTraceStage(promptTraceId, "init", {
        connection: {
            profile: conn.profileName,
            endpoint: conn.url,
            useSTConnection
        },
        script: {
            id: script.id,
            name: script.name
        }
    });

    // [修复] 只有非静默模式（用户手动触发）才更新 lastUsedScriptId
    // 后台自动生成不应影响用户的剧本选择状态
    if (!silent) {
        GlobalState.lastUsedScriptId = script.id;
        if ($("#t-main-view").length > 0) applyScriptSelection(script.id);
    }

    const ctx = await getContextData();
    const $floatBtn = $("#titania-float-btn");
    const useStream = cfg.stream !== false;

    // --- 检查世界书条目是否为空 ---
    // 如果用户已勾选"不再提示"，则跳过检查
    if (!GlobalState.skipWorldBookCheck) {
        if (!ctx.worldInfo || ctx.worldInfo.trim() === "" || ctx.worldInfo.trim() === "[World Info / Lore]\n\n") {
            const confirmMsg = "世界书已选中的条目为 0，是否继续生成？";
            const userConfirmed = await new Promise((resolve) => {
                // 使用自定义确认框（完全居中）
                const confirmHtml = `
                <div id="t-confirm-overlay">
                    <div class="t-confirm-box">
                        <div class="t-confirm-icon">📚</div>
                        <div class="t-confirm-msg">${confirmMsg}</div>
                        <label class="t-confirm-skip-row">
                            <input type="checkbox" id="t-confirm-skip">
                            <span>本次会话内不再提示</span>
                        </label>
                        <div class="t-confirm-actions">
                            <button id="t-confirm-yes">是</button>
                            <button id="t-confirm-no">否</button>
                        </div>
                    </div>
                </div>`;
                $("body").append(confirmHtml);

                $("#t-confirm-yes").on("click", () => {
                    // 检查是否勾选了"不再提示"
                    if ($("#t-confirm-skip").is(":checked")) {
                        GlobalState.skipWorldBookCheck = true;
                    }
                    $("#t-confirm-overlay").remove();
                    resolve(true);
                });
                $("#t-confirm-no").on("click", () => {
                    $("#t-confirm-overlay").remove();
                    resolve(false);
                });
                // 点击背景也取消
                $("#t-confirm-overlay").on("click", (e) => {
                    if (e.target === e.currentTarget) {
                        $("#t-confirm-overlay").remove();
                        resolve(false);
                    }
                });
            });

            if (!userConfirmed) {
                TitaniaLogger.info("用户取消生成（世界书条目为空）");
                finishPromptTrace(promptTraceId, "aborted", {
                    reason: "worldinfo_empty_user_cancel"
                });
                return false;
            }
        }
    }

    const keepOverlayOpen = generationOverrides?.keepOverlayOpen === true;
    if (!silent && !keepOverlayOpen) $("#t-overlay").remove();

    // 创建新的中断控制器
    GlobalState.abortController = new AbortController();
    const signal = GlobalState.abortController.signal;

    GlobalState.isGenerating = true;
    $floatBtn.addClass("t-loading");

    // 初始化流式缓存
    startStreamingCache(script.id, script.name);
    lastStreamRenderedContent = "";

    // 更新按钮状态
    if (typeof window.updateRunButtonsState === 'function') {
        window.updateRunButtonsState();
    }
    // 重置收藏状态：新生成的内容默认未收藏
    GlobalState.lastFavId = null;
    $("#t-btn-like").prop("disabled", false);
    updateFavButtonUI();

    // 显示中止按钮并启动计时器
    showCancelButton();
    startTimer();

    if (!silent && window.toastr) toastr.info(`🚀 [${conn.profileName}] 正在连接模型演绎...`, "Titania Echo");

    let rawContent = "";
    let effectiveScriptInstruction = scriptPromptSource;

    try {
        // --- 1. 准备 Prompt (双模式系统) ---
        diagnostics.phase = 'prepare_prompt';

        // 读取导演指令 (自由编辑)
        const dirInstruction = dirDefaults.instruction || "";

        // 读取活跃的文笔参考方案
        const styleProfiles = data.style_profiles || [{ id: "default", name: "默认 (无)", content: "" }];
        const activeStyleId = data.active_style_id || "default";
        const activeStyleProfile = styleProfiles.find(p => p.id === activeStyleId) || styleProfiles[0];
        const dStyle = activeStyleProfile ? activeStyleProfile.content : "";

        // 根据生成模式选择不同的系统提示词
        let sys;

        // 读取当前提示词方案
        let promptScheme = getPromptScheme(data, GlobalState.generationMode);
        if (!promptScheme) {
            promptScheme = getPromptScheme(data, "narrative");
            if (window.toastr) toastr.warning("未找到活动预设，已回退到内容优先模式", "Titania");
        }
        const systemEntry = promptScheme.entries.find(entry => entry.role === "system");
        sys = systemEntry?.content || (GlobalState.generationMode === "visual" ? DEFAULT_VISUAL_PROMPT : DEFAULT_CONTENT_PROMPT);

        appendPromptTraceStage(promptTraceId, "system_selected", {
            mode: GlobalState.generationMode,
            schemeId: promptScheme.id || GlobalState.generationMode,
            schemeType: promptScheme.type || "builtin",
            length: sys.length,
            estimatedTokens: estimateTokens(sys),
            preview: sys.substring(0, 240)
        });

        let user = "";
        let runtimeChatHistory = "";
        const sectionLengths = {
            director: 0,
            persona: 0,
            userDesc: 0,
            worldInfo: 0,
            history: 0,
            scriptInstruction: 0,
            // 仅续写口径下非零：把 [剧本指令] 块再拆三段（顺序即查看器的切片顺序）
            continuationPreamble: 0,
            continuationContext: 0,
            continuationInstruction: 0
        };

        // 构建导演指令部分
        let directorSection = "";
        if (dirInstruction.trim()) {
            directorSection += dirInstruction.trim() + "\n";
        }
        if (dStyle) {
            directorSection += `文笔参考：模仿以下文风（不要复制原文）:\n<style_ref>\n${dStyle.substring(0, 1000)}\n</style_ref>\n`;
        }
        if (directorSection) {
            const block = `[导演指令]\n（以下是写作风格和格式要求，请按此风格生成内容）\n${directorSection}\n`;
            sectionLengths.director = block.length;
            user += block;
        }

        if (ctx.persona) {
            const block = `[角色人设]\n（以下是角色的性格设定，仅作为创作参考，不要在输出中重复这些内容）\n${ctx.persona}\n\n`;
            sectionLengths.persona = block.length;
            user += block;
        }
        if (ctx.userDesc) {
            const block = `[用户设定]\n（以下是用户的描述信息，仅作为创作背景参考）\n${ctx.userDesc}\n\n`;
            sectionLengths.userDesc = block.length;
            user += block;
        }
        if (ctx.worldInfo) {
            const block = `[世界观设定]\n（以下是背景设定和世界观信息，仅作为创作参考，不要在输出中直接复制）\n${ctx.worldInfo}\n\n`;
            sectionLengths.worldInfo = block.length;
            user += block;
        }

        // 根据用户开关决定是否读取聊天历史
        if (GlobalState.useHistoryAnalysis) {
            const limit = cfg.history_limit || 10;
            // 读取聊天历史白名单配置
            const historyWhitelistStr = data.history_extraction?.whitelist || "";
            const historyWhitelist = parseWhitelistInput(historyWhitelistStr);
            const historyBlacklist = parseChatHistoryBlacklistInput(data.history_extraction?.blacklist || "");
            const history = getChatHistory(limit, historyWhitelist, historyBlacklist, GlobalState.historyAiOnly);
            const historyBlock = buildChatHistoryBlock(history, GlobalState.historyAiOnly);
            sectionLengths.history = historyBlock.length;
            runtimeChatHistory = historyBlock;
            user += historyBlock;
        }
        // 用户关闭历史开关时，不添加任何历史相关内容

        // 处理剧本 prompt 中的宏（包括 {{random::...}}、{{char}}、{{user}} 等）
        // 注：主动续写重构模式会传入完整历史内容，为避免误替换可选择跳过宏处理
        const skipMacroEvaluation = generationOverrides?.skipMacroEvaluation === true;
        let processedPrompt = scriptPromptSource;
        if (!skipMacroEvaluation) {
            try {
                // 使用 ST 的宏处理器处理所有宏
                const macroEnv = {
                    char: ctx.charName,
                    user: ctx.userName,
                    // 可以根据需要添加更多环境变量
                };
                processedPrompt = evaluateMacros(scriptPromptSource, macroEnv);
                TitaniaLogger.info("宏处理完成", {
                    original: scriptPromptSource.substring(0, 100),
                    processed: processedPrompt.substring(0, 100)
                });

                appendPromptTraceStage(promptTraceId, "macro_processed", {
                    skipped: false,
                    fallback: false,
                    beforeLength: scriptPromptSource.length,
                    afterLength: processedPrompt.length,
                    beforePreview: scriptPromptSource.substring(0, 240),
                    afterPreview: processedPrompt.substring(0, 240)
                });
            } catch (e) {
                // 如果宏处理失败，回退到简单替换
                TitaniaLogger.warn("ST 宏处理失败，使用简单替换", e);
                processedPrompt = scriptPromptSource
                    .replace(/{{char}}/gi, ctx.charName)
                    .replace(/{{user}}/gi, ctx.userName);

                appendPromptTraceStage(promptTraceId, "macro_processed", {
                    skipped: false,
                    fallback: true,
                    error: e?.message || "macro_failed",
                    beforeLength: scriptPromptSource.length,
                    afterLength: processedPrompt.length,
                    beforePreview: scriptPromptSource.substring(0, 240),
                    afterPreview: processedPrompt.substring(0, 240)
                });
            }
        } else {
            TitaniaLogger.info("已跳过宏处理（使用重构后的主动续写消息构包）");
            appendPromptTraceStage(promptTraceId, "macro_processed", {
                skipped: true,
                fallback: false,
                beforeLength: scriptPromptSource.length,
                afterLength: scriptPromptSource.length,
                beforePreview: scriptPromptSource.substring(0, 240),
                afterPreview: scriptPromptSource.substring(0, 240)
            });
        }
        effectiveScriptInstruction = processedPrompt;

        const scriptBlock = `[剧本指令]\n（这是你的主要任务！请根据以下指令生成创意内容，忽略上方的聊天历史，专注于完成此创作请求）\n${processedPrompt}`;
        applyScriptInstructionSectionLengths(
            sectionLengths,
            scriptBlock,
            processedPrompt,
            generationOverrides?.continuationSectionLengths || null
        );
        user += scriptBlock;

        diagnostics.input_stats.sys_len = sys.length;
        diagnostics.input_stats.user_len = user.length;

        const traceMeta = {
            source: generationSource,
            hasPromptOverride: typeof promptOverride === "string" && promptOverride.trim().length > 0,
            promptOverrideLength: promptOverride ? String(promptOverride).length : 0,
            skipMacroEvaluation,
            sectionLengths,
            estimatedTokens: {
                system: estimateTokens(sys),
                user: estimateTokens(user)
            }
        };

        if (generationSource === "user_continuation") {
            traceMeta.continuation = {
                injectRoundsCount: generationOverrides?.injectRoundsCount || null,
                injectedRoundItems: generationOverrides?.injectedRoundItems || null,
                injectedChars: generationOverrides?.injectedChars || null,
                injectedTokensEstimated: generationOverrides?.injectedTokensEstimated || null
            };
        }

        appendPromptTraceStage(promptTraceId, "user_composed", traceMeta);
        const runtimePromptContext = {
            ...ctx,
            worldInfoBefore: ctx.worldInfo,
            worldInfoAfter: "",
            chatHistory: runtimeChatHistory,
            titaniaScript: processedPrompt
        };
        const messageDetails = buildPromptMessageDetails(promptScheme, {
            [`${GlobalState.generationMode}_system`]: sys,
            [`${GlobalState.generationMode}_user`]: user
        }, runtimePromptContext);
        const messages = messageDetails.map(({ role, content }) => ({ role, content }));
        traceMeta.promptScheme = {
            id: promptScheme.id || GlobalState.generationMode,
            name: promptScheme.name || "未命名方案",
            type: promptScheme.type || "builtin"
        };
        traceMeta.messageDetails = messageDetails;
        setPromptTraceFinalMessages(promptTraceId, messages, traceMeta);
        appendPromptTraceStage(promptTraceId, "request_ready", {
            useStream,
            useSTConnection,
            endpoint: diagnostics.endpoint
        });

        TitaniaLogger.info(`开始生成: ${script.name}`, { profile: conn.profileName });

        // --- 2. 发起请求 ---
        diagnostics.phase = 'fetch_start';

        if (useSTConnection) {
            // 使用 ST 的 ChatCompletionService 发送请求
            diagnostics.endpoint = `[ST Backend: ${oai_settings.chat_completion_source}]`;

            const requestData = ChatCompletionService.createRequestData({
                stream: useStream,
                messages,
                chat_completion_source: oai_settings.chat_completion_source,
                model: finalModel,
                max_tokens: oai_settings.openai_max_tokens || 2048,
                temperature: oai_settings.temp_openai || 0.7,
                // 传递反代/自定义配置
                custom_url: oai_settings.custom_url,
                reverse_proxy: oai_settings.reverse_proxy,
                proxy_password: oai_settings.proxy_password,
                custom_prompt_post_processing: oai_settings.custom_prompt_post_processing,
            });

            diagnostics.phase = useStream ? 'streaming' : 'parsing_json';

            if (useStream) {
                // 流式响应处理 - 参考 ST 的 custom-request.js 实现
                let streamGenerator;
                try {
                    streamGenerator = await ChatCompletionService.sendRequest(requestData, false, signal);
                } catch (streamErr) {
                    // 流式请求失败时，用非流式重试以获取 API 返回的完整错误信息
                    try {
                        await ChatCompletionService.sendRequest(requestData, true, null);
                    } catch (detailErr) {
                        if (detailErr && typeof detailErr === 'object') {
                            diagnostics.raw_response_snippet = JSON.stringify(
                                detailErr.error || detailErr.message || detailErr
                            ).substring(0, 500);
                        } else if (typeof detailErr === 'string') {
                            diagnostics.raw_response_snippet = detailErr.substring(0, 500);
                        }
                    }
                    throw streamErr;
                }

                if (typeof streamGenerator === 'function') {
                    let chunkCount = 0;

                    try {
                        for await (const chunk of streamGenerator()) {
                            // 检查是否被中断
                            if (signal.aborted) {
                                throw new DOMException('Generation aborted', 'AbortError');
                            }

                            if (chunkCount === 0) diagnostics.stream_stats.ttft = Date.now() - startTime;
                            chunkCount++;
                            diagnostics.stream_stats.chunks = chunkCount;

                            // ST 的 streamGenerator 返回的 chunk.text 是累积内容
                            // 所以这里使用赋值而非累加是正确的
                            rawContent = chunk.text || "";

                            // 实时流式渲染到 UI（如果主窗口存在）
                            // scheduleStreamRender 内部会检查是否应该渲染
                            if (($("#t-output-content").length > 0 || $("#t-main-view").length > 0) && rawContent.length > 0) {
                                // 对流式内容进行基础清洗后渲染
                                const streamCleanContent = sanitizeAIOutputLite(rawContent);
                                scheduleStreamRender(streamCleanContent, script.name);
                            }
                        }
                    } catch (streamErr) {
                        // 如果流式传输中断但已有部分内容，记录但不立即抛出
                        if (streamErr.name === 'AbortError') {
                            throw streamErr;
                        }

                        TitaniaLogger.warn("ST 流式传输异常", {
                            error: streamErr.message,
                            contentSoFar: rawContent.length,
                            chunks: chunkCount
                        });

                        // 如果没有获取到任何内容，则抛出错误
                        if (rawContent.length === 0) {
                            throw new Error(`ERR_ST_STREAM: ${streamErr.message}`);
                        }
                        // 否则继续使用已获取的内容
                    }

                    // 改进的空流检测：区分不同情况
                    if (chunkCount === 0) {
                        throw new Error("ERR_STREAM_NO_CHUNKS: 未从 ST 后端接收到任何数据块");
                    }
                } else if (streamGenerator && typeof streamGenerator === 'object') {
                    // 非流式响应（fallback）- ST 可能返回对象而非生成器
                    rawContent = streamGenerator?.content || "";
                    if (!rawContent) {
                        TitaniaLogger.warn("ST 返回非生成器响应但内容为空", { response: typeof streamGenerator });
                    }
                } else {
                    // 未知响应类型
                    throw new Error("ERR_INVALID_ST_RESPONSE: ST 后端返回了意外的响应格式");
                }
            } else {
                // 非流式响应
                const result = await ChatCompletionService.sendRequest(requestData, true, null);
                rawContent = result?.content || "";
            }

            diagnostics.network.latency = Date.now() - startTime;
            diagnostics.network.status = 200; // ST 后端已处理错误

        } else {
            // 使用自定义配置直接发送请求
            let endpoint = finalUrl.trim().replace(/\/+$/, "");
            if (!endpoint) throw new Error("ERR_CONFIG: API URL 未设置");
            if (!endpoint.endsWith("/chat/completions")) {
                if (endpoint.endsWith("/v1")) endpoint += "/chat/completions";
                else endpoint += "/v1/chat/completions";
            }
            diagnostics.endpoint = endpoint;

            const requestBody = {
                model: finalModel,
                messages,
                stream: useStream,
                max_tokens: cfg.max_tokens || 4096
            };

            if (useStream) {
                const attemptStartTime = Date.now();
                const res = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${finalKey}` },
                    body: JSON.stringify(requestBody),
                    signal: signal
                });

                diagnostics.network.status = res.status;
                diagnostics.network.latency = Date.now() - startTime;

                if (!res.ok) {
                    const errText = await res.text().catch(() => "");
                    diagnostics.raw_response_snippet = errText.substring(0, 500);

                    // 参考 ST：尝试解析错误响应中的结构化错误
                    try {
                        tryParseStreamingError(res, errText, { quiet: true });
                    } catch (parsedErr) {
                        // tryParseStreamingError 可能会抛出更详细的错误
                        throw parsedErr;
                    }

                    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
                }

                // 流式读取 - 使用 ST 的 EventSourceStream 正确处理 SSE
                diagnostics.phase = 'streaming';
                const eventStream = new EventSourceStream();
                res.body.pipeThrough(eventStream);
                const reader = eventStream.readable.getReader();
                let chunkCount = 0;
                let parseFailCount = 0; // 新增：记录解析失败次数

                while (true) {
                    // 检查是否被中断
                    if (signal.aborted) {
                        await reader.cancel();
                        throw new DOMException('Generation aborted', 'AbortError');
                    }

                    const { done, value } = await reader.read();
                    if (done) break;

                    // value 是 MessageEvent，data 属性包含实际数据
                    const data = value.data;
                    if (data === "[DONE]") break;

                    // 参考 ST：尝试解析流式错误（如配额错误、审核错误等）
                    try {
                        tryParseStreamingError(res, data, { quiet: true });
                    } catch (streamParseErr) {
                        // 如果是结构化错误响应，抛出
                        throw streamParseErr;
                    }

                    if (chunkCount === 0) {
                        diagnostics.stream_stats.ttft = Date.now() - attemptStartTime;
                        TitaniaLogger.info(`流式响应开始 (TTFT: ${diagnostics.stream_stats.ttft}ms)`);
                    }
                    chunkCount++;
                    diagnostics.stream_stats.chunks = chunkCount;

                    try {
                        const json = JSON.parse(data);
                        const chunk = json.choices?.[0]?.delta?.content || "";
                        if (chunk) {
                            rawContent += chunk;

                            // 实时流式渲染到 UI（如果主窗口存在）
                            // scheduleStreamRender 内部会检查是否应该渲染
                            if ($("#t-output-content").length > 0 || $("#t-main-view").length > 0) {
                                // 对流式内容进行基础清洗后渲染
                                const streamCleanContent = sanitizeAIOutputLite(rawContent);
                                scheduleStreamRender(streamCleanContent, script.name);
                            }
                        }
                    } catch (parseErr) {
                        // 记录解析失败，而不是完全静默
                        parseFailCount++;
                        if (parseFailCount <= 3) {
                            TitaniaLogger.warn(`流式 chunk 解析失败 (#${parseFailCount})`, {
                                data: data.substring(0, 100),
                                error: parseErr.message
                            });
                        }
                    }
                }

                // 改进的空流检测：区分不同情况
                if (chunkCount === 0) {
                    throw new Error("ERR_STREAM_NO_CHUNKS: 服务器未返回任何数据块");
                }

                // 新增：检查是否所有 chunk 都解析失败
                if (parseFailCount > 0 && rawContent.length === 0) {
                    throw new Error(`ERR_STREAM_PARSE_FAILED: 接收到 ${chunkCount} 个数据块，但全部解析失败`);
                }

                TitaniaLogger.info(`流式传输完成`, {
                    chunks: chunkCount,
                    contentLength: rawContent.length,
                    parseFailures: parseFailCount
                });

            } else {
                // 非流式请求
                const res = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${finalKey}` },
                    body: JSON.stringify(requestBody),
                    signal: signal
                });

                diagnostics.network.status = res.status;
                diagnostics.network.latency = Date.now() - startTime;
                diagnostics.phase = 'parsing_json';

                if (!res.ok) {
                    const errText = await res.text().catch(() => "");
                    diagnostics.raw_response_snippet = errText.substring(0, 500);
                    throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
                }

                const jsonText = await res.text();
                try {
                    const json = JSON.parse(jsonText);
                    if (json?.error) {
                        throw new Error(json.error?.message || json.error || "ERR_API_RESPONSE");
                    }
                    if (!Array.isArray(json?.choices)) {
                        throw new Error("ERR_INVALID_API_RESPONSE");
                    }
                    rawContent = json.choices?.[0]?.message?.content || "";
                } catch (jsonErr) {
                    if (["ERR_API_RESPONSE", "ERR_INVALID_API_RESPONSE"].some(code => String(jsonErr?.message || "").includes(code))) throw jsonErr;
                    throw new Error("Invalid JSON");
                }
            }
        }

        // --- 4. 内容验证与清洗 ---
        diagnostics.phase = 'validation';

        // 改进的空内容检测：先检查原始内容
        if (!rawContent) {
            throw new Error("ERR_EMPTY_RESPONSE: API 未返回任何内容");
        }

        const trimmedRaw = rawContent.trim();
        if (trimmedRaw.length === 0) {
            throw new Error("ERR_EMPTY_RESPONSE: API 返回了空白内容");
        }

        // 使用激进清洗模式：移除 AI 前言/后记、思考标签、Markdown 残留
        let cleanContent = sanitizeAIOutput(rawContent);

        // 新增：检查清洗后是否为空（区分原始空和清洗后空）
        if (!cleanContent || cleanContent.trim().length === 0) {
            // 原始内容非空但清洗后为空，说明 AI 只返回了元内容（如思考标签）
            TitaniaLogger.warn("内容清洗后为空", {
                rawLength: rawContent.length,
                rawPreview: rawContent.substring(0, 200)
            });
            throw new Error("ERR_CONTENT_FILTERED: AI 返回的内容经过清洗后为空（可能只包含思考标签或元信息）");
        }

        // Shadow DOM 会处理 CSS 隔离，不再需要 scopeAndSanitizeHTML
        let finalOutput = cleanContent;

        // --- 5. 自动续写检测与处理 ---
        const autoContinueCfg = data.auto_continue || {};
        if (autoContinueCfg.enabled) {
            const truncationResult = detectTruncation(finalOutput, autoContinueCfg.detection_mode || "html");

            if (truncationResult.isTruncated) {
                const maxRetries = autoContinueCfg.max_retries || 2;
                const currentRetry = GlobalState.continuation.retryCount;

                if (currentRetry < maxRetries) {
                    // 记录截断信息
                    TitaniaLogger.warn("检测到内容截断，准备自动续写", {
                        reason: truncationResult.reason,
                        retryCount: currentRetry + 1,
                        maxRetries: maxRetries
                    });

                    // 更新续写状态
                    if (!GlobalState.continuation.isActive) {
                        // 首次截断，保存原始内容和上下文信息
                        GlobalState.continuation.isActive = true;
                        GlobalState.continuation.originalContent = finalOutput;
                        GlobalState.continuation.accumulatedContent = finalOutput;
                        // 保存原始请求上下文，用于续写时保持连贯性
                        GlobalState.continuation.originalPrompt = effectiveScriptInstruction;
                        GlobalState.continuation.characterName = ctx.charName;
                        GlobalState.continuation.userName = ctx.userName;
                    } else {
                        // 续写过程中再次截断，合并内容
                        GlobalState.continuation.accumulatedContent = mergeContinuationContent(
                            GlobalState.continuation.accumulatedContent,
                            finalOutput,
                            autoContinueCfg.show_indicator !== false
                        );
                    }
                    GlobalState.continuation.retryCount++;

                    // 显示续写提示
                    if (!silent && window.toastr) {
                        toastr.info(`🔄 检测到截断，正在自动续写 (${currentRetry + 1}/${maxRetries})...`, "Titania Echo");
                    }

                    // 发起续写请求
                    const continuationSuccess = await performContinuation(
                        script,
                        ctx,
                        cfg,
                        finalUrl,
                        finalKey,
                        finalModel,
                        autoContinueCfg,
                        silent,
                        useSTConnection,
                        "",
                        "auto",
                        false,
                        effectiveScriptInstruction
                    );
                    finishPromptTrace(promptTraceId, continuationSuccess ? "success" : "failed", {
                        reason: "auto_continuation",
                        continuationRetryCount: GlobalState.continuation.retryCount
                    });
                    return continuationSuccess; // 续写逻辑会处理后续流程
                } else {
                    // 已达到最大重试次数
                    TitaniaLogger.warn("已达到最大续写次数", { maxRetries });
                    if (!silent && window.toastr) {
                        toastr.warning(`⚠️ 已尝试续写 ${maxRetries} 次，内容可能仍不完整`, "Titania Echo");
                    }
                    // 使用累积的内容
                    if (GlobalState.continuation.accumulatedContent) {
                        finalOutput = GlobalState.continuation.accumulatedContent;
                    }
                }
            } else if (GlobalState.continuation.isActive) {
                // 续写成功，合并最终内容
                finalOutput = mergeContinuationContent(
                    GlobalState.continuation.accumulatedContent,
                    finalOutput,
                    autoContinueCfg.show_indicator !== false
                );
                TitaniaLogger.info("自动续写完成", { totalRetries: GlobalState.continuation.retryCount });
            }
        }

        // 重置续写状态
        resetContinuationState();

        // 结束流式缓存
        endStreamingCache();

        // 将生成的内容推送到历史队列（同时会更新 lastGeneratedContent 和 lastGeneratedScriptId）
        pushSceneToHistory(finalOutput, script.id, script.name, { status: "success", generationId });
        if (generationSource !== "user_continuation") {
            setContinuationSessionBaseRound(script.id, script.name, finalOutput, {
                instruction: effectiveScriptInstruction,
                status: "success",
                generationId
            });
        }
        recordScriptGenerated(script.id, {
            isQueue: silent === true && GlobalState.queueState.isRunning,
            mode: GlobalState.generationMode,
            category: script.category || (script._type === "preset" ? "官方预设" : "未分类")
        });
        diagnostics.phase = 'complete';

        // 移除新内容指示器（如果存在）
        removeNewContentIndicator();

        // 保存使用的模型名称
        GlobalState.lastUsedModelName = finalModel;

        // 计算并更新内容统计
        const stats = countContentStats(finalOutput);
        GlobalState.contentStats = {
            totalChars: stats.totalChars,
            chineseChars: stats.chineseChars,
            generationTime: GlobalState.lastGenerationTime,  // 记录生成耗时
            modelName: finalModel  // 添加模型名称
        };

        // 更新统计显示（如果主窗口存在）
        if ($("#t-stats-hud").length > 0) {
            updateContentStatsDisplay(GlobalState.contentStats);
        }

        // 渲染内容到主窗口（如果存在）
        if ($("#t-output-content").length > 0) {
            // 检查用户是否在查看历史
            if (shouldRenderStreamToUI()) {
                // 用户在看最新内容，直接渲染
                finalizeStreamRender(finalOutput, script.name);
            } else {
                // 用户在看历史，显示完成通知而不是直接替换内容
                showGenerationCompleteNotification(script.name);
            }
            // 更新历史导航 UI（如果存在）
            if (typeof window.updateSceneHistoryNav === 'function') {
                window.updateSceneHistoryNav();
            }
        }

        // 停止计时器
        stopTimer();

        const elapsed = GlobalState.lastGenerationTime / 1000;
        if (!silent && window.toastr) toastr.success(`✨ 《${script.name}》演绎完成！(${elapsed.toFixed(1)}s)`, "Titania Echo");
        $floatBtn.addClass("t-notify");

        finishPromptTrace(promptTraceId, "success", {
            outputLength: finalOutput.length,
            elapsedMs: Date.now() - startTime
        });
        return true;

    } catch (e) {
        const isAbortError = e.name === 'AbortError';
        if (!isAbortError) {
            console.error("Titania Generate Error:", e);
        }

        let partialSaved = false;
        let partialOutput = "";

        if (typeof rawContent === "string" && rawContent.trim().length > 0) {
            try {
                const sanitizedPartial = sanitizeAIOutput(rawContent);
                partialOutput = sanitizedPartial && sanitizedPartial.trim().length > 0
                    ? sanitizedPartial
                    : rawContent.trim();
            } catch (partialSanitizeErr) {
                TitaniaLogger.warn("部分内容清洗失败，使用原始内容兜底", {
                    error: partialSanitizeErr?.message || "sanitize_failed"
                });
                partialOutput = rawContent.trim();
            }

            try {
                endStreamingCache();
                const partialStatus = isAbortError ? "aborted" : "partial";
                pushSceneToHistory(partialOutput, script.id, script.name, { status: partialStatus, generationId, error: e?.message });
                partialSaved = true;

                // 保存部分内容到续写会话，确保下一次续写能读取用户当前看到的内容
                if (generationSource === "user_continuation") {
                    appendContinuationSessionRound(
                        script.id,
                        script.name,
                        generationOverrides?.continuationInstruction || "（中断后保留的续写）",
                        partialOutput,
                        { status: partialStatus, generationId }
                    );
                } else {
                    setContinuationSessionBaseRound(script.id, script.name, partialOutput, {
                        instruction: effectiveScriptInstruction,
                        status: partialStatus,
                        generationId
                    });
                }

                if (shouldRenderStreamToUI() && $("#t-output-content").length > 0) {
                    finalizeStreamRender(partialOutput, script.name);
                }

                if (typeof window.updateSceneHistoryNav === 'function') {
                    window.updateSceneHistoryNav();
                }
            } catch (savePartialErr) {
                TitaniaLogger.error("保存异常中断的部分内容失败", savePartialErr);
                partialSaved = false;
            }
        }

        // 出错时也停止计时器
        stopTimer();
        hideCancelButton();

        // 重置续写状态
        resetContinuationState();

        // 清空流式缓存
        clearStreamingCache();

        // 移除新内容指示器
        removeNewContentIndicator();

        diagnostics.network.latency = Date.now() - startTime;
        diagnostics.phase += "_failed";
        if (isAbortError) {
            TitaniaLogger.info("生成已中断", {
                partialSaved,
                partialLength: partialSaved ? partialOutput.length : 0
            });
            if (!silent && partialSaved && window.toastr) {
                toastr.warning("生成已中断，已保存当前返回内容，可继续续写", "Titania Warning");
            }
            finishPromptTrace(promptTraceId, "aborted", {
                error: e.message || "aborted",
                partialSaved,
                partialLength: partialSaved ? partialOutput.length : 0
            });
            return false;
        }

        TitaniaLogger.error("生成过程发生异常", e, diagnostics);

        // 根据错误类型提供更具体的诊断提示
        let diagnosisHint = "API调用失败或内容解析错误。请检查 Key 余额或网络连接。";
        const errMsg = e.message || "未知错误";

        if (errMsg.includes("ERR_STREAM_NO_CHUNKS")) {
            diagnosisHint = "服务器未返回任何数据。可能原因：API 配额用尽、模型过载、网络问题。";
        } else if (errMsg.includes("ERR_STREAM_PARSE_FAILED")) {
            diagnosisHint = "数据解析失败。可能原因：API 返回格式异常，尝试切换模型或检查 API 兼容性。";
        } else if (errMsg.includes("ERR_STREAM_FAILED")) {
            diagnosisHint = "流式传输失败。可能原因：网络不稳定，尝试关闭流式传输或重试。";
        } else if (errMsg.includes("ERR_EMPTY_RESPONSE")) {
            diagnosisHint = "API 返回空内容。可能原因：请求被拒绝、内容审核触发、模型无响应。";
        } else if (errMsg.includes("ERR_CONTENT_FILTERED")) {
            diagnosisHint = "AI 输出被过滤。AI 可能只返回了思考过程而无实际内容，尝试调整提示词。";
        } else if (errMsg.includes("ERR_INVALID_ST_RESPONSE")) {
            diagnosisHint = "ST 后端响应异常。尝试刷新页面或检查 SillyTavern 日志。";
        } else if (errMsg.includes("ERR_ST_STREAM")) {
            diagnosisHint = "ST 流式传输错误。请检查 SillyTavern 的 API 配置是否正确。";
        } else if (errMsg.includes("HTTP")) {
            diagnosisHint = "HTTP 请求失败。请检查 API 地址和密钥是否正确。";
        } else if (errMsg.includes("quota") || errMsg.includes("limit") || errMsg.includes("429")) {
            diagnosisHint = "API 配额不足或请求过于频繁。请稍后重试或检查账户余额。";
        }

        const errHtml = `<div data-titania-result-status="failed" style="color:#ff6b6b; text-align:center; padding:20px; border:1px dashed #ff6b6b; background: rgba(255,107,107,0.1); border-radius:8px;">
            <div style="font-size:3em; margin-bottom:10px;"><i class="fa-solid fa-triangle-exclamation"></i></div>
            <div style="font-weight:bold; margin-bottom:5px;">演绎出错了</div>
            <div style="font-size:0.9em; margin-bottom:15px; color:#faa;">${errMsg}</div>
            <div style="font-size:0.8em; color:#ccc; background:#222; padding:10px; border-radius:4px; text-align:left;">
                诊断提示：${diagnosisHint}
            </div>
        </div>`;

        if (!partialSaved) {
            setCurrentGenerationResult({
                generationId,
                content: errHtml,
                scriptId: script.id,
                scriptName: script.name,
                status: "failed",
                error: e?.message || "unknown_error"
            });
        }
        $floatBtn.addClass("t-notify");
        if (!silent && window.toastr) {
            if (partialSaved) {
                toastr.warning("生成中断，已自动保存已返回的内容", "Titania Warning");
            } else {
                toastr.error("生成失败", "Titania Error");
            }
        }

        finishPromptTrace(promptTraceId, "failed", {
            error: e.message || "unknown_error",
            phase: diagnostics.phase,
            partialSaved,
            partialLength: partialSaved ? partialOutput.length : 0
        });
        return false;
    } finally {
        GlobalState.isGenerating = false;
        GlobalState.abortController = null;
        $floatBtn.removeClass("t-loading");
        hideCancelButton();

        // 更新按钮状态
        if (typeof window.updateRunButtonsState === 'function') {
            window.updateRunButtonsState();
        }
        updateFavButtonUI();
    }
}

/**
 * 执行队列生成
 * 根据队列设置，按顺序生成多个剧本内容
 * @param {Array<{id: string, name: string}>} scripts - 要生成的剧本列表
 */
export async function executeQueueGeneration(scripts) {
    if (!scripts || scripts.length === 0) {
        if (window.toastr) toastr.warning("队列为空，没有要生成的剧本", "Titania");
        return;
    }

    const qState = GlobalState.queueState;
    const interval = (qState.interval || 2) * 1000; // 转换为毫秒

    // 初始化队列任务
    initQueueTasks(scripts.map(s => s.id));

    TitaniaLogger.info("开始队列生成", {
        total: scripts.length,
        interval: qState.interval,
        mode: qState.mode
    });

    // 显示队列进度指示器
    showQueueProgressIndicator(scripts.length);

    if (window.toastr) {
        toastr.info(`🚀 开始队列生成：${scripts.length} 个剧本`, "Titania Queue");
    }

    // 逐个生成
    for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i];
        const progress = getQueueProgress();

        // 检查是否被中断
        if (!qState.isRunning) {
            TitaniaLogger.info("队列生成被中断", { completed: progress.completed });
            break;
        }

        // 更新进度显示
        updateQueueProgressIndicator(i + 1, scripts.length, script.name);

        TitaniaLogger.info(`队列生成 (${i + 1}/${scripts.length}): ${script.name}`);

        try {
            // 调用 handleGenerate，使用静默模式避免重复的 toastr
            const ok = await handleGenerate(script.id, true);

            if (ok) {
                // 记录成功
                recordQueueResult(script.id, script.name, true);

                // 短暂提示
                if (window.toastr) {
                    toastr.success(`✅ (${i + 1}/${scripts.length}) ${script.name}`, "Titania Queue", { timeOut: 2000 });
                }
            } else {
                // handleGenerate 内部失败时不会抛错，这里按失败记录
                recordQueueResult(script.id, script.name, false, "生成失败");
                if (window.toastr) {
                    toastr.warning(`⚠️ (${i + 1}/${scripts.length}) ${script.name} 失败`, "Titania Queue", { timeOut: 2000 });
                }
            }

        } catch (e) {
            // 记录失败，继续下一个
            recordQueueResult(script.id, script.name, false, e.message);

            TitaniaLogger.warn(`队列生成失败: ${script.name}`, { error: e.message });

            if (window.toastr) {
                toastr.warning(`⚠️ (${i + 1}/${scripts.length}) ${script.name} 失败`, "Titania Queue", { timeOut: 2000 });
            }
        }

        // 如果不是最后一个，等待间隔
        if (i < scripts.length - 1 && qState.isRunning) {
            await new Promise(resolve => setTimeout(resolve, interval));
        }
    }

    // 完成队列
    const finalProgress = getQueueProgress();
    resetQueueState();

    // 移除进度指示器
    hideQueueProgressIndicator();

    // 显示完成提示
    if (window.toastr) {
        const msg = `队列完成：${finalProgress.completed} 成功，${finalProgress.failed} 失败`;
        if (finalProgress.failed === 0) {
            toastr.success(`🎉 ${msg}`, "Titania Queue");
        } else {
            toastr.warning(`⚠️ ${msg}`, "Titania Queue");
        }
    }

    TitaniaLogger.info("队列生成完成", {
        completed: finalProgress.completed,
        failed: finalProgress.failed,
        total: finalProgress.total
    });

    // 禁用队列模式（一次性使用）
    GlobalState.queueState.enabled = false;

    // 更新按钮状态
    if (typeof window.updateRunButtonsState === 'function') {
        window.updateRunButtonsState();
    }
    if (typeof window.updateQueueButtonUI === 'function') {
        window.updateQueueButtonUI();
    }
}

/**
 * 显示队列进度指示器
 * @param {number} total - 总任务数
 */
function showQueueProgressIndicator(total) {
    // 移除已存在的指示器
    $(".t-queue-progress").remove();
    $(".t-queue-running-indicator").remove();

    // 添加进度条到主窗口顶部
    const progressHtml = `
        <div class="t-queue-progress">
            <div class="t-queue-progress-bar animated" style="width: 0%;"></div>
        </div>
    `;

    // 添加运行状态指示器
    const indicatorHtml = `
        <div class="t-queue-running-indicator">
            <i class="fa-solid fa-spinner"></i>
            <span>队列: <span id="t-queue-current">0</span>/<span id="t-queue-total">${total}</span></span>
        </div>
    `;

    $("#t-main-view").prepend(progressHtml);
    $(".t-content-wrapper").append(indicatorHtml);
}

/**
 * 更新队列进度指示器
 * @param {number} current - 当前进度
 * @param {number} total - 总数
 * @param {string} scriptName - 当前剧本名称
 */
function updateQueueProgressIndicator(current, total, scriptName) {
    const percent = (current / total) * 100;
    $(".t-queue-progress-bar").css("width", `${percent}%`);
    $("#t-queue-current").text(current);

    // 更新指示器 title
    $(".t-queue-running-indicator").attr("title", `正在生成: ${scriptName}`);
}

/**
 * 隐藏队列进度指示器
 */
function hideQueueProgressIndicator() {
    $(".t-queue-progress").fadeOut(300, function () {
        $(this).remove();
    });
    $(".t-queue-running-indicator").fadeOut(300, function () {
        $(this).remove();
    });
}

/**
 * 取消队列生成
 */
export function cancelQueueGeneration() {
    if (GlobalState.queueState.isRunning) {
        GlobalState.queueState.isRunning = false;

        // 同时取消当前正在进行的生成
        cancelGeneration();

        // 隐藏进度指示器
        hideQueueProgressIndicator();

        if (window.toastr) {
            toastr.info("⏹️ 队列已停止", "Titania Queue");
        }

        TitaniaLogger.info("队列生成已取消");
    }
}

/**
 * 执行续写请求
 * @param {object} script - 当前剧本
 * @param {object} ctx - 上下文数据
 * @param {object} cfg - 配置
 * @param {string} finalUrl - API URL
 * @param {string} finalKey - API Key
 * @param {string} finalModel - 模型名称
 * @param {object} autoContinueCfg - 自动续写配置
 * @param {boolean} silent - 是否静默模式
 * @param {boolean} useSTConnection - 是否使用 ST 主连接
 */
async function performContinuation(script, ctx, cfg, finalUrl, finalKey, finalModel, autoContinueCfg, silent, useSTConnection = false, userInstruction = "", continuationType = "auto", autoLocate = false, initialInstruction = "") {
    const $floatBtn = $("#titania-float-btn");
    const generationId = `generation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const useStream = cfg.stream !== false;
    const signal = GlobalState.abortController?.signal;
    const continuationSource = continuationType === "user" ? "user_continuation" : "auto_continuation";
    const promptTraceId = createPromptTrace({
        source: continuationSource,
        mode: GlobalState.generationMode,
        scriptId: script?.id,
        scriptName: script?.name,
        profile: getActiveConnection()?.profileName || "",
        model: finalModel,
        extraMeta: {
            continuationType,
            autoLocate,
            silent,
            useSTConnection,
            useStream
        }
    });

    try {
        // 使用分层上下文构建（优化版）
        const context = buildContinuationContext(
            GlobalState.continuation.accumulatedContent,
            GlobalState.continuation.originalPrompt
        );

        appendPromptTraceStage(promptTraceId, "context_built", {
            continuationType,
            totalLength: context.totalLength,
            unclosedTags: Array.isArray(context.unclosedTags) ? context.unclosedTags.length : 0,
            hasStyleGuide: !!(context.styleGuide && String(context.styleGuide).trim()),
            recentClassesCount: Array.isArray(context.recentClasses) ? context.recentClasses.length : 0
        });

        // 构建优化后的续写 Prompt（包含分层上下文）
        const continuationSys = `You are seamlessly continuing an interrupted HTML scene.

[Story Context]
Character: ${GlobalState.continuation.characterName}
User: ${GlobalState.continuation.userName}
Original Request: ${context.originalPrompt}
${userInstruction ? `User continuation intent: ${userInstruction}` : ""}

[Story Progress]
Plot so far: ${context.plotSummary}
Total written: ~${context.totalLength} characters

[Visual Style Continuity]
Existing CSS excerpt (follow this style language, do not replace it):
${context.styleGuide ? context.styleGuide : '(No explicit style block found)'}
Existing class names you should prefer reusing:
${context.recentClasses && context.recentClasses.length > 0 ? context.recentClasses.join(', ') : '(No class names found)'}

[Technical State]
Unclosed HTML tags: ${context.unclosedTags.length > 0 ? context.unclosedTags.join(', ') : 'None'}
Ends with punctuation: ${context.endsWithPunctuation ? 'Yes' : 'No'}
${context.incompleteText ? `Incomplete sentence fragment: "${context.incompleteText}"` : ''}

[Critical Rules]
1. **SEAMLESS JOIN**: Your output will be DIRECTLY APPENDED. Do NOT repeat any existing content.
2. **COMPLETE FIRST**: ${context.unclosedTags.length > 0 ? `Close these tags first: </${context.unclosedTags.join('>, </')}>` : context.incompleteText ? 'Complete the unfinished sentence first.' : 'Start with new content.'}
3. **CONTINUE NATURALLY**: ${userInstruction ? "Strictly follow the user's continuation intent while keeping tone and continuity." : "Write 300-500 more characters to reach a natural conclusion."}
4. **STYLE INHERITANCE**: Reuse existing HTML structure/classes. Do NOT introduce a brand-new visual system.
5. **STYLE TAG RULE**: Do NOT output a new <style> block unless absolutely necessary; if needed, only add minimal incremental rules compatible with existing CSS.
6. **FORMAT**: Output raw HTML only. No markdown code blocks. Language: Chinese.

[IMPORTANT - DO NOT REPEAT]
The last complete sentence was: "${context.lastCompleteSentence}"
Do NOT write this sentence again. Start from what comes AFTER it.`;

        const continuationUser = `[Recent HTML - For Style Matching]
${context.recentHtml}

[Continue from here]
${context.incompleteText ? `Complete this first: "...${context.incompleteText}"` : `Start after: "${context.lastCompleteSentence.slice(-30)}"`}

Generate ONLY the continuation (no repetition):`;

        const continuationTraceMeta = {
            source: continuationSource,
            continuationType,
            autoLocate,
            useSTConnection,
            useStream,
            estimatedTokens: {
                system: estimateTokens(continuationSys),
                user: estimateTokens(continuationUser)
            },
            contextStats: {
                totalLength: context.totalLength,
                unclosedTags: Array.isArray(context.unclosedTags) ? context.unclosedTags.length : 0,
                recentClassesCount: Array.isArray(context.recentClasses) ? context.recentClasses.length : 0,
                styleGuideLength: String(context.styleGuide || "").length,
                recentHtmlLength: String(context.recentHtml || "").length
            }
        };

        setPromptTraceFinalMessages(promptTraceId, [
            { role: "system", content: continuationSys },
            { role: "user", content: continuationUser }
        ], continuationTraceMeta);

        appendPromptTraceStage(promptTraceId, "request_ready", {
            continuationType,
            useSTConnection,
            useStream
        });

        // 发起续写请求
        let rawContent = "";

        if (useSTConnection) {
            // 使用 ST 的 ChatCompletionService 发送续写请求
            const requestData = ChatCompletionService.createRequestData({
                stream: useStream,
                messages: [
                    { role: "system", content: continuationSys },
                    { role: "user", content: continuationUser }
                ],
                chat_completion_source: oai_settings.chat_completion_source,
                model: finalModel,
                max_tokens: oai_settings.openai_max_tokens || 2048,
                temperature: oai_settings.temp_openai || 0.7,
                custom_url: oai_settings.custom_url,
                reverse_proxy: oai_settings.reverse_proxy,
                proxy_password: oai_settings.proxy_password,
                custom_prompt_post_processing: oai_settings.custom_prompt_post_processing,
            });

            if (useStream) {
                const streamGenerator = await ChatCompletionService.sendRequest(requestData, false, null);

                if (typeof streamGenerator === 'function') {
                    for await (const chunk of streamGenerator()) {
                        rawContent = chunk.text || "";
                    }
                } else {
                    rawContent = streamGenerator?.content || "";
                }
            } else {
                const result = await ChatCompletionService.sendRequest(requestData, true, null);
                rawContent = result?.content || "";
            }
        } else {
            // 使用自定义配置直接发送请求
            let endpoint = finalUrl.trim().replace(/\/+$/, "");
            if (!endpoint.endsWith("/chat/completions")) {
                if (endpoint.endsWith("/v1")) endpoint += "/chat/completions";
                else endpoint += "/v1/chat/completions";
            }

            const requestBody = {
                model: finalModel,
                messages: [
                    { role: "system", content: continuationSys },
                    { role: "user", content: continuationUser }
                ],
                stream: useStream,
                max_tokens: cfg.max_tokens || 4096
            };

            if (useStream) {
                // 流式请求：支持自动重试
                const maxRetries = 2;
                const retryDelayBase = 1200;
                let lastError = null;
                let streamSuccess = false;
                let shouldFallbackToNonStream = false;

                for (let attempt = 0; attempt <= maxRetries && !streamSuccess; attempt++) {
                    try {
                        if (attempt > 0) {
                            TitaniaLogger.info(`续写流式请求重试 (${attempt}/${maxRetries})`);
                            if (!silent && window.toastr) {
                                toastr.info(`🔄 续写重试中 (${attempt}/${maxRetries})...`, "Titania");
                            }
                        }

                        const res = await fetch(endpoint, {
                            method: "POST",
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${finalKey}` },
                            body: JSON.stringify(requestBody),
                            signal: signal
                        });

                        if (!res.ok) {
                            let errorDetail = "";
                            try {
                                const errorText = (await res.text() || "").trim();
                                if (errorText) {
                                    errorDetail = ` | ${errorText.slice(0, 180)}`;
                                }
                            } catch (e) {
                                // 忽略错误体解析失败
                            }

                            if (res.status >= 500) {
                                shouldFallbackToNonStream = true;
                            }

                            const statusPart = res.statusText ? `${res.status}: ${res.statusText}` : `${res.status}`;
                            throw new Error(`Continuation HTTP Error ${statusPart}${errorDetail}`);
                        }

                        // 使用 ST 的 EventSourceStream 正确处理 SSE
                        const eventStream = new EventSourceStream();
                        res.body.pipeThrough(eventStream);
                        const reader = eventStream.readable.getReader();
                        let chunkCount = 0;

                        while (true) {
                            if (signal?.aborted) {
                                await reader.cancel();
                                throw new DOMException('Continuation aborted', 'AbortError');
                            }

                            const { done, value } = await reader.read();
                            if (done) break;

                            // value 是 MessageEvent，data 属性包含实际数据
                            const data = value.data;
                            if (data === "[DONE]") break;

                            chunkCount++;

                            try {
                                const json = JSON.parse(data);
                                const chunk = json.choices?.[0]?.delta?.content || "";
                                if (chunk) rawContent += chunk;
                            } catch (e) { /* 忽略单个事件解析错误 */ }
                        }

                        if (chunkCount === 0) {
                            throw new Error("Continuation Stream Empty");
                        }

                        streamSuccess = true;

                    } catch (streamErr) {
                        lastError = streamErr;

                        if (streamErr.name === 'AbortError') {
                            throw streamErr;
                        }

                        TitaniaLogger.warn(`续写流式请求失败 (尝试 ${attempt + 1}/${maxRetries + 1})`, {
                            error: streamErr.message,
                            attempt: attempt + 1
                        });

                        if (attempt < maxRetries) {
                            rawContent = "";
                            const retryDelay = retryDelayBase * (attempt + 1);
                            await new Promise(r => setTimeout(r, retryDelay));
                        }
                    }
                }

                // 降级：流式在服务繁忙时可能失败，尝试非流式一次
                if (!streamSuccess && shouldFallbackToNonStream) {
                    TitaniaLogger.warn("续写流式失败，尝试非流式降级", {
                        reason: lastError?.message || "unknown"
                    });

                    if (!silent && window.toastr) {
                        toastr.info("🔁 续写服务繁忙，尝试非流式模式...", "Titania Echo");
                    }

                    const fallbackBody = { ...requestBody, stream: false };
                    const fallbackRes = await fetch(endpoint, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${finalKey}` },
                        body: JSON.stringify(fallbackBody),
                        signal: signal
                    });

                    if (!fallbackRes.ok) {
                        let fallbackDetail = "";
                        try {
                            const fallbackText = (await fallbackRes.text() || "").trim();
                            if (fallbackText) {
                                fallbackDetail = ` | ${fallbackText.slice(0, 180)}`;
                            }
                        } catch (e) {
                            // 忽略错误体解析失败
                        }

                        const fallbackStatus = fallbackRes.statusText
                            ? `${fallbackRes.status}: ${fallbackRes.statusText}`
                            : `${fallbackRes.status}`;
                        throw new Error(`Continuation Fallback HTTP Error ${fallbackStatus}${fallbackDetail}`);
                    }

                    const fallbackJsonText = await fallbackRes.text();
                    try {
                        const fallbackJson = JSON.parse(fallbackJsonText);
                        rawContent = fallbackJson.choices?.[0]?.message?.content || "";
                        streamSuccess = rawContent.trim().length > 0;
                    } catch (jsonErr) {
                        throw new Error("Continuation Fallback Invalid JSON");
                    }
                }

                if (!streamSuccess) {
                    throw new Error(`Continuation Stream Interrupted (已重试 ${maxRetries} 次): ${lastError?.message || '未知错误'}`);
                }

            } else {
                const res = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${finalKey}` },
                    body: JSON.stringify(requestBody),
                    signal: signal
                });

                if (!res.ok) {
                    throw new Error(`Continuation HTTP Error ${res.status}: ${res.statusText}`);
                }

                const jsonText = await res.text();
                try {
                    const json = JSON.parse(jsonText);
                    rawContent = json.choices?.[0]?.message?.content || "";
                } catch (jsonErr) {
                    throw new Error("Continuation Invalid JSON");
                }
            }
        }

        if (!rawContent || rawContent.trim().length === 0) {
            throw new Error("ERR_EMPTY_CONTINUATION");
        }

        // 清洗续写内容（使用激进清洗模式）
        let cleanContent = sanitizeAIOutput(rawContent);

        // 注意：续写内容不需要完整的 scopeAndSanitizeHTML 处理，因为它应该复用原有的 scopeId
        // 但我们需要确保 CSS 选择器正确
        let continuationOutput = cleanContent;

        // 检测续写内容是否也被截断
        const truncationResult = detectTruncation(continuationOutput, autoContinueCfg.detection_mode || "html");
        const maxRetries = autoContinueCfg.max_retries || 2;

        if (truncationResult.isTruncated && GlobalState.continuation.retryCount < maxRetries) {
            // 续写内容也被截断，使用智能合并再次尝试
            GlobalState.continuation.accumulatedContent = smartMergeContinuation(
                GlobalState.continuation.accumulatedContent,
                continuationOutput,
                false // 内部合并不显示标记
            );
            GlobalState.continuation.retryCount++;

            if (!silent && window.toastr) {
                toastr.info(`🔄 续写内容仍被截断，继续尝试 (${GlobalState.continuation.retryCount}/${maxRetries})...`, "Titania Echo");
            }

            // 递归续写
            finishPromptTrace(promptTraceId, "success", {
                reason: "continuation_retry",
                outputLength: continuationOutput.length,
                retryCount: GlobalState.continuation.retryCount,
                maxRetries
            });
            return await performContinuation(script, ctx, cfg, finalUrl, finalKey, finalModel, autoContinueCfg, silent, useSTConnection, userInstruction, continuationType, autoLocate, initialInstruction);
        } else {
            // 续写完成，使用智能合并最终内容
            const finalOutput = smartMergeContinuation(
                GlobalState.continuation.accumulatedContent,
                continuationOutput,
                autoContinueCfg.show_indicator === true // 只有明确开启时才显示标记
            );

            const rewrittenOutput = finalOutput;

            // 重置续写状态
            const totalRetries = GlobalState.continuation.retryCount;
            resetContinuationState();

            // 将生成的内容推送到历史队列
            pushSceneToHistory(rewrittenOutput, script.id, script.name, { status: "success", generationId });
            if (continuationType === "auto") {
                setContinuationSessionBaseRound(script.id, script.name, rewrittenOutput, {
                    instruction: initialInstruction,
                    status: "success",
                    generationId
                });
            }
            recordScriptGenerated(script.id, {
                isQueue: silent === true && GlobalState.queueState.isRunning,
                mode: GlobalState.generationMode,
                category: script.category || (script._type === "preset" ? "官方预设" : "未分类")
            });

            // 计算并更新内容统计
            const stats = countContentStats(rewrittenOutput);
            GlobalState.contentStats = {
                totalChars: stats.totalChars,
                chineseChars: stats.chineseChars,
                generationTime: GlobalState.lastGenerationTime,  // 记录生成耗时
                modelName: finalModel  // 添加模型名称
            };

            // 主动续写后自动定位到最新结果（解除历史锁定）
            if (continuationType === "user" && autoLocate) {
                unlockDisplay();
            }

            // 渲染内容到主窗口（如果存在）
            if ($("#t-output-content").length > 0) {
                renderGeneratedContent(rewrittenOutput, script.name);

                if (continuationType === "user" && autoLocate) {
                    requestAnimationFrame(() => {
                        const scrollContainer = document.querySelector(".t-content-area");
                        if (scrollContainer) {
                            scrollContainer.scrollTop = scrollContainer.scrollHeight;
                        }
                    });
                }

                // 更新历史导航 UI（如果存在）
                if (typeof window.updateSceneHistoryNav === 'function') {
                    window.updateSceneHistoryNav();
                }
                // 更新统计显示
                if ($("#t-stats-hud").length > 0) {
                    updateContentStatsDisplay(GlobalState.contentStats);
                }
            }

            // 停止计时器
            stopTimer();

            const elapsed = GlobalState.lastGenerationTime / 1000;
            if (!silent && window.toastr) {
                const successMsg = continuationType === "user"
                    ? `✨ 主动续写完成！(${totalRetries}次补续写, ${elapsed.toFixed(1)}s)`
                    : `✨ 《${script.name}》演绎完成！(含${totalRetries}次续写, ${elapsed.toFixed(1)}s)`;
                toastr.success(successMsg, "Titania Echo");
            }
            $floatBtn.addClass("t-notify");

            TitaniaLogger.info("续写完成", {
                scriptName: script.name,
                continuationType,
                totalRetries,
                elapsed: elapsed.toFixed(1) + 's'
            });

            finishPromptTrace(promptTraceId, "success", {
                continuationType,
                totalRetries,
                outputLength: rewrittenOutput.length,
                elapsedMs: GlobalState.lastGenerationTime || 0
            });

            return true;
        }

    } catch (e) {
        // 用户主动中断
        if (e.name === 'AbortError') {
            if (GlobalState.continuation.accumulatedContent) {
                setCurrentGenerationResult({
                    generationId,
                    content: GlobalState.continuation.accumulatedContent,
                    scriptId: script.id,
                    scriptName: script.name,
                    status: "aborted",
                    error: e.message || "aborted"
                });
            }
            clearStreamingCache();
            finishPromptTrace(promptTraceId, "aborted", {
                continuationType,
                error: e.message || "aborted"
            });
            return false;
        }

        console.error("Titania Continuation Error:", e);
        TitaniaLogger.error("续写过程发生异常", e);

        // 即使续写失败，也保留已有的内容
        if (GlobalState.continuation.accumulatedContent) {
            setCurrentGenerationResult({
                generationId,
                content: GlobalState.continuation.accumulatedContent,
                scriptId: script.id,
                scriptName: script.name,
                status: "partial",
                error: e?.message || "unknown_error"
            });
            if (!silent && window.toastr) {
                const errorHint = String(e?.message || "");
                const isServerBusy = errorHint.includes("503") || errorHint.includes("429");
                const tip = isServerBusy
                    ? "⚠️ 续写失败（服务繁忙），已保留当前内容，请稍后重试"
                    : "⚠️ 续写失败，显示已获取的内容";
                toastr.warning(tip, "Titania Echo");
            }
        }

        // 重置续写状态
        resetContinuationState();
        clearStreamingCache();

        // 停止计时器
        stopTimer();

        $floatBtn.addClass("t-notify");

        finishPromptTrace(promptTraceId, "failed", {
            continuationType,
            error: e?.message || "unknown_error"
        });

        return false;
    } finally {
        GlobalState.isGenerating = false;
        GlobalState.abortController = null;
        $floatBtn.removeClass("t-loading");
        hideCancelButton();

        // 更新按钮状态
        if (typeof window.updateRunButtonsState === 'function') {
            window.updateRunButtonsState();
        }
        updateFavButtonUI();
    }
}

/**
 * 用户主动续写当前显示的剧场内容（重构版）
 * 新逻辑：把“当前已生成剧场内容 + 用户续写指令”注入既有消息结构，发起新一轮完整生成。
 * @param {{ instruction?: string, fromCurrentView?: boolean, autoLocate?: boolean, injectRoundsCount?: number, branchFromCurrentView?: boolean, regenerateRound?: number, regenerateRoundKey?: string, continueAfterRound?: number, continueAfterRoundKey?: string, sourceBranchKey?: string, scriptIdOverride?: string, baseContentOverride?: string, crossRoleSource?: string }} options
 * @returns {Promise<boolean>}
 */
export async function handleUserContinuation(options = {}) {
    const { instruction = "", fromCurrentView = true, autoLocate = true, injectRoundsCount = 3, branchFromCurrentView = false, regenerateRound = null, regenerateRoundKey = "", continueAfterRound = null, continueAfterRoundKey = "", sourceBranchKey = "", scriptIdOverride = "", baseContentOverride = "", crossRoleSource = "" } = options;

    if (GlobalState.isGenerating || GlobalState.queueState.isRunning) {
        if (window.toastr) toastr.info("正在生成中，请稍候...", "Titania");
        return false;
    }

    const isRegeneration = (regenerateRound !== null && regenerateRound !== undefined) || Boolean(regenerateRoundKey);
    const isHistoryContinuation = (continueAfterRound !== null && continueAfterRound !== undefined) || Boolean(continueAfterRoundKey);
    const display = scriptIdOverride && baseContentOverride ? {
        content: baseContentOverride,
        scriptId: scriptIdOverride,
        scriptName: GlobalState.runtimeScripts.find(s => s.id === scriptIdOverride)?.name || "场景"
    } : (fromCurrentView ? getCurrentDisplayContent() : {
        content: GlobalState.lastGeneratedContent,
        scriptId: GlobalState.lastGeneratedScriptId,
        scriptName: "场景",
        generationId: String(GlobalState.currentGenerationResult?.generationId || "")
    });

    const baseContent = (display?.content || "").trim();
    if (!baseContent) {
        if (window.toastr) toastr.warning("没有可续写的内容，请先生成场景", "Titania");
        return false;
    }

    const validation = validateConnection();
    if (!validation.valid) {
        const errText = `配置缺失：${validation.error}`;
        alert(errText);
        TitaniaLogger.error("主动续写配置错误", errText);
        return false;
    }

    const scriptId = display?.scriptId || GlobalState.lastGeneratedScriptId || GlobalState.lastUsedScriptId || $("#t-sel-script").val();
    const script = GlobalState.runtimeScripts.find(s => s.id === scriptId);

    if (!script) {
        if (window.toastr) toastr.warning("未找到当前内容对应的剧本，无法续写", "Titania");
        return false;
    }

    let continuationEntry = getContinuationRuntimeStore()[script.id];

    // 世系对齐：把活动分支校正成“当前显示内容的祖先链”，再在其后追加新一轮。
    // 不做这一步的话，翻页回旧内容再续写会把活动分支里那条不相干的世系一起带进
    // 续写上下文和分组收藏（收藏画廊里出现无关的首轮生成即由此而来）。
    // 重生成 / 从历史某轮继续 / 显式开分支各有自己的分支逻辑，这里不介入。
    let lineageBranchResult = null;
    if (!isRegeneration && !isHistoryContinuation && !branchFromCurrentView) {
        const anchor = findContinuationRoundAnchor(script.id, {
            generationId: display?.generationId,
            content: baseContent
        });

        if (!anchor) {
            // 不属于任何已知世系（首次续写、编辑过的旧场景等）：以它为根另起一条
            await startFreshContinuationBranch(script, baseContent, display?.generationId);
        } else if (!anchor.isActiveTail) {
            // 命中归档分支、或命中活动分支的中间某轮：从该轮切出祖先链作为新活动分支
            lineageBranchResult = branchContinuationSessionAtRound(
                script.id, anchor.branchKey, anchor.round, anchor.roundKey, true
            );
            if (lineageBranchResult) {
                TitaniaLogger.info("主动续写已对齐到当前显示内容所属世系", {
                    scriptId: script.id,
                    sourceBranchKey: anchor.branchKey,
                    fromArchivedBranch: !anchor.isActive,
                    anchorRound: anchor.round,
                    branchKey: lineageBranchResult.branchKey,
                    contextRounds: lineageBranchResult.contextRounds.length
                });
            }
        }
        // anchor.isActiveTail 为真时活动分支已经就是正确的祖先链，无需改动

        continuationEntry = getContinuationRuntimeStore()[script.id];
    }

    const initialRound = Array.isArray(continuationEntry?.rounds)
        ? continuationEntry.rounds.find(item => item.type === "initial")
        : null;
    if (initialRound && (!initialRound.instruction || initialRound.instruction === "（首次生成）")) {
        const continuationContext = await getContextData();
        try {
            initialRound.instruction = evaluateMacros(String(script.prompt || ""), {
                char: continuationContext.charName,
                user: continuationContext.userName
            });
        } catch (e) {
            initialRound.instruction = String(script.prompt || "")
                .replace(/{{char}}/gi, continuationContext.charName)
                .replace(/{{user}}/gi, continuationContext.userName);
        }
    }

    if (branchFromCurrentView) {
        await startFreshContinuationBranch(script, baseContent, display?.generationId);
        TitaniaLogger.info("主动续写已创建分支", {
            scriptId: script.id,
            scriptName: script.name,
            baseContentLength: baseContent.length
        });
    }

    // 接入既有变量后，上下文注入（buildContinuationBranchInjection）与失败回滚
    //（restoreContinuationBranchAfterFailedGeneration）对世系对齐自动生效
    let branchResult = lineageBranchResult;
    if (isRegeneration) {
        branchResult = branchContinuationSessionAtRound(script.id, sourceBranchKey, regenerateRound, regenerateRoundKey);
        if (!branchResult) {
            if (window.toastr) toastr.warning("所选续写轮次已不存在，请重新选择", "Titania");
            return false;
        }
    } else if (isHistoryContinuation) {
        branchResult = branchContinuationSessionAtRound(script.id, sourceBranchKey, continueAfterRound, continueAfterRoundKey, true);
        if (!branchResult) {
            if (window.toastr) toastr.warning("所选续写轮次已不存在，请重新选择", "Titania");
            return false;
        }
    }

    const userInstruction = (instruction || "").trim()
        || (isRegeneration ? branchResult?.targetInstruction : "")
        || DEFAULT_CONTINUATION_INSTRUCTION;
    const effectiveInjectCount = clampContinuationInjectRounds(injectRoundsCount);
    const sessionInjection = branchResult
        ? buildContinuationBranchInjection(branchResult.contextRounds.slice(-effectiveInjectCount))
        : buildContinuationSessionInjection(script.id, effectiveInjectCount);

    const composedOverride = composeContinuationPromptOverride({
        injectionText: sessionInjection.text,
        userInstruction,
        crossRoleSource
    });
    const promptOverride = composedOverride.text;

    TitaniaLogger.info("主动续写已切换到新回合生成模式", {
        scriptId: script.id,
        scriptName: script.name,
        baseContentLength: baseContent.length,
        instructionLength: userInstruction.length,
        injectRoundsCount: effectiveInjectCount,
        injectedRoundItems: sessionInjection.selectedRounds.length,
        injectedChars: sessionInjection.estimatedChars,
        injectedTokensEstimated: sessionInjection.estimatedTokens,
        regenerateRound: branchResult?.targetRound || null,
        branchKey: branchResult?.branchKey || continuationEntry?.branchKey || ""
    });

    // 主动续写默认自动回到实时内容视图
    if (autoLocate === true) {
        unlockDisplay();
    }

    if (window.toastr) toastr.info("🔄 正在基于当前剧场与续写指令生成新回合...", "Titania Echo");

    const success = await handleGenerate(script.id, false, {
        promptOverride,
        skipMacroEvaluation: true,
        keepOverlayOpen: true,
        source: "user_continuation",
        continuationInstruction: userInstruction,
        continuationSectionLengths: composedOverride.lengths,
        injectRoundsCount: effectiveInjectCount,
        injectedRoundItems: sessionInjection.selectedRounds.length,
        injectedChars: sessionInjection.estimatedChars,
        injectedTokensEstimated: sessionInjection.estimatedTokens,
        regenerateRound: branchResult?.targetRound || null,
        branchKey: branchResult?.branchKey || ""
    });

    if (success) {
        appendContinuationSessionRound(script.id, script.name, userInstruction, GlobalState.lastGeneratedContent, {
            status: "success",
            generationId: GlobalState.currentGenerationResult?.generationId
        });
        if (typeof window.updateSceneHistoryNav === "function") window.updateSceneHistoryNav();
    } else if (branchResult) {
        restoreContinuationBranchAfterFailedGeneration(script.id, branchResult);
        scheduleContinuationPersistence();
    }

    return success;
}

