// src/ui/mainWindow/viewState.js
//
// 主窗口布局间共享的可变状态与续写上下文常量。
// 单独成模块是为了让 mainWindow.js 与各 layout 都能读写同一份状态，
// 而不需要互相 import（避免循环依赖）。

import { getExtData, saveExtData } from "../../utils/storage.js";

export const CONTINUATION_RECENT_MAX = 10;
export const CONTINUATION_MIN_INJECT_ROUNDS = 3;
export const CONTINUATION_MAX_INJECT_ROUNDS = 20;
export const CONTINUATION_TOKEN_WARN_THRESHOLD = 60000;

// 已选中但尚未演绎的剧本 ID：非空表示底部主按钮应执行“演绎”而非“续写”
let pendingGenerationScriptId = "";

// 续写输入框的草稿，用于窗口重开后恢复
let continuationQuickDraft = "";

export function getPendingGenerationScriptId() {
    return pendingGenerationScriptId;
}

export function setPendingGenerationScriptId(scriptId) {
    pendingGenerationScriptId = String(scriptId || "");
}

export function getContinuationQuickDraft() {
    return continuationQuickDraft;
}

export function setContinuationQuickDraft(text) {
    continuationQuickDraft = String(text || "");
}

export function clampInjectRoundsCount(value) {
    if (String(value ?? "").trim() === "") return 3;
    const num = Number(value);
    if (!Number.isFinite(num)) return 3;
    return Math.max(CONTINUATION_MIN_INJECT_ROUNDS, Math.min(CONTINUATION_MAX_INJECT_ROUNDS, Math.floor(num)));
}

export function getContinuationDefaultInjectCount() {
    const data = getExtData();
    const saved = data.continuation_ui?.inject_rounds_count;
    return clampInjectRoundsCount(saved ?? 3);
}

export function saveContinuationDefaultInjectCount(count) {
    const data = getExtData();
    if (!data.continuation_ui) data.continuation_ui = {};
    data.continuation_ui.inject_rounds_count = clampInjectRoundsCount(count);
    saveExtData();
}
