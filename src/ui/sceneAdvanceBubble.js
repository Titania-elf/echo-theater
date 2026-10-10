// src/ui/sceneAdvanceBubble.js
//
// 把「剧情推进」操作界面注入最新一条 AI 回复的正文末端。
//
// 形态：正文下方一条横条，折叠时显示「剧情推进 · 第 N/M 条」，点开后**就地展开**
// 一块内联面板（大纲情节预览 / 方案 / 进度 / 候选卡片 / 写入方式 / 推荐剧情）。
// 全部内容都在消息流里，不用浮层 —— 位置固定不会随滚动跑偏，也没有定位与
// 遮挡的麻烦；代价是展开时把后面的消息往下推。
//
// ── 挂载点为什么是 .mes_text 的兄弟节点 ──
// 横条与面板注入 ST 的消息结构，但**不塞进 .mes_text 内部**：ST 重渲染正文、改写
// 功能替换正文（rewriteEntryButton 就整块重写 .mes_text）都会把子节点冲掉；而且
// 塞进去有污染「取正文」逻辑的风险。作为 .mes_text 之后的兄弟节点，它既在正文
// 末端，又不受正文重写影响。
//
// ── 为什么折叠态不加载 storyOutlineWindow ──
// 那是 3400 行的大模块，动态 import（与 outlineEntryButton.js 同一手法）。横条每次
// 随消息重渲染都要更新进度文字，若为此加载整模块，懒加载就没意义了 —— 故折叠态的
// 进度直接读 extData 里的方案数据（story_outline_plans），只有真正展开时才拉取完整
// 模块取权威状态。
//
// ── 与 storyOutlineWindow.js 的关系 ──
// 生成与写入全部走该模块导出的无头 API，面板与「故事大纲」共享同一份事实来源
// （plan.candidates / plan.progress / plan.items），两边看到的永远一致。
//
// 属「注入 ST DOM」一类（依 ADR-02），样式集中在 css/04-features/st-embedded.css。

import { eventSource, event_types } from "../../../../script.js";
import { getExtData, saveExtData } from "../utils/storage.js";
import { TitaniaLogger } from "../core/logger.js";
import * as pacingInjection from "../core/pacingInjection.js";

const STRIP_CLASS = "titania-scene-advance-strip";
const PANEL_ID = "t-scene-advance-panel";

/** extData 里的方案存储键（与 storyOutlineWindow.js 保持一致，勿各自另写一份）。 */
const PLANS_KEY = "story_outline_plans";
const ACTIVE_PLAN_KEY = "story_outline_active_plan_id";
const SCENE_SOURCE_PLAN_KEY = "story_outline_scene_source_plan_id";

let listenersBound = false;
let refreshQueued = false;
/** 懒加载的 storyOutlineWindow API。首次展开时才拉取整个大纲模块。 */
let apiPromise = null;
/** 面板当前展开所在楼层；null = 收起。重渲染导致最后一条 AI 楼层变化时据此收起。 */
let expandedForMesid = null;
/** 「推荐剧情」进行中：防止连点，也让重渲染时不丢 loading 态。 */
let generating = false;
/** 展开动作进行中（loadApi 是异步的）：防止连点期间重复插入面板。 */
let opening = false;
/** 补回面板进行中：防止连续事件并发插入两个同 id 面板。 */
let restoring = false;
/** 大纲情节预览里展开了哪一条的完整情节；-1 = 全部收起。 */
let previewItemIdx = -1;
/** 大纲情节预览整块是否展开。默认折叠 —— 面板收起时会重置，每次打开都从折叠态开始。 */
let previewOpen = false;
/** 面板当前模式：recommend（推荐剧情）| pacing（节奏把控）。收起时重置回 recommend。 */
let panelMode = "recommend";
/** 最近一次节奏诊断（{pacingState, assessment, directive, focus, intensity}），重绘不丢。 */
let pacingResult = null;
/** 节奏指令编辑草稿：和输入框同步，避免重绘丢失用户正在打的字（同 tempInstruction 的做法）。 */
let pacingDraft = "";
/** 节奏分析进行中：防连点，也让重绘保留 loading 态。 */
let pacingAnalyzing = false;

/** 手动节奏预设：一键把现成 directive 填进编辑框，不调 API。措辞与 judge 产出同格式。 */
const PACING_PRESETS = [
    { label: "放慢", text: "本次回复放慢节奏，停留在当前场景，深化人物情绪与感官细节，不要推进到新事件。" },
    { label: "加快", text: "本次回复加快节奏，略去过场与寒暄，直接推进到下一个关键事件或场景。" },
    { label: "起张力", text: "本次回复提升张力，制造冲突或悬念让局势升级，避免平淡交代。" },
    { label: "收束", text: "本次回复收束当前这条线索，给已有伏笔或冲突一个阶段性结果，不要再抛新线。" },
    { label: "留白", text: "本次回复克制笔墨，以未尽之语和留白收尾，给回味空间。" },
    { label: "转场", text: "本次回复完成一次场景或时间转换，自然过渡到下一个场景。" },
];

/** 读注入参数（depth/role），缺省 depth=0 / role=system（老用户没这个键也不报错）。 */
function getPacingConfig() {
    const p = getExtData()?.pacing || {};
    const role = ["system", "user", "assistant"].includes(p.inject_role) ? p.inject_role : "system";
    const depthRaw = Number(p.inject_depth);
    const depth = Number.isFinite(depthRaw) && depthRaw >= 0 ? Math.floor(depthRaw) : 0;
    return { depth, role };
}

function savePacingConfig(patch) {
    const data = getExtData();
    const prev = data.pacing && typeof data.pacing === "object" ? data.pacing : {};
    data.pacing = { ...prev, ...patch };
    saveExtData();
}

function loadApi() {
    if (!apiPromise) apiPromise = import("./storyOutlineWindow.js");
    return apiPromise;
}

/** 复用现有的「启用大纲生成入口」勾选框（outline_entry.show_outline_actions）。 */
function isEnabled() {
    return getExtData()?.outline_entry?.show_outline_actions === true;
}

function escapeHtmlText(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** 纯文本摘要，写法沿用 storyOutlineWindow 的 getBriefText。 */
function briefText(text, maxLen = 48) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    if (!s) return "(空)";
    return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}

/* ------------------------------------------------------------------ *
 * 折叠态进度：只读 extData，不加载大纲模块
 * ------------------------------------------------------------------ */

/**
 * 从设置里算出横条要显示的进度。方案解析顺序对齐 storyOutlineWindow 的
 * getRollingPlan()：剧情推进来源方案 → 当前活动方案。
 * 没有方案或方案为空时返回 null（横条只显示标题）。
 */
function readProgressFromSettings() {
    const data = getExtData();
    const plans = Array.isArray(data?.[PLANS_KEY]) ? data[PLANS_KEY] : [];
    const sourceId = String(data?.[SCENE_SOURCE_PLAN_KEY] || "");
    const activeId = String(data?.[ACTIVE_PLAN_KEY] || "");
    const plan = plans.find(p => p.id === sourceId) || plans.find(p => p.id === activeId) || null;
    if (!plan) return null;

    const total = Array.isArray(plan.items) ? plan.items.length : 0;
    if (total <= 0) return null;

    const raw = Number(plan.progress?.itemIndex);
    const index = Number.isFinite(raw) ? Math.max(0, Math.min(raw, total - 1)) : 0;
    return { index, total };
}

function formatProgressLabel(progress) {
    if (!progress) return "";
    return `第 ${progress.index + 1} / ${progress.total} 条`;
}

/**
 * 把无头 API 的状态快照转成横条要的进度，没有方案/方案为空时返回 null。
 * total 为 0 时必须回 null：否则会渲染出「第 1 / 0 条」。
 */
function progressFromState(state) {
    const total = Number(state?.total) || 0;
    if (total <= 0) return null;
    const index = Math.max(0, Math.min(Number(state.progress?.itemIndex) || 0, total - 1));
    return { index, total };
}

/* ------------------------------------------------------------------ *
 * 横条与面板的挂载
 * ------------------------------------------------------------------ */

function getStrip() {
    return document.querySelector(`#chat .${STRIP_CLASS}`);
}

function removeAllStrips() {
    document.querySelectorAll(`#chat .${STRIP_CLASS}`).forEach(node => node.remove());
}

/** 最后一条非系统的 AI 楼层；没有则返回 null。 */
function getLastAiMessage() {
    const all = document.querySelectorAll('#chat .mes[is_user="false"]');
    for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].getAttribute("is_system") !== "true") return all[i];
    }
    return null;
}

function buildStrip() {
    const strip = document.createElement("div");
    strip.className = `${STRIP_CLASS} tsa-strip`;
    strip.setAttribute("role", "button");
    strip.setAttribute("tabindex", "0");
    strip.setAttribute("aria-expanded", "false");
    strip.innerHTML = `
        <i class="fa-solid fa-clapperboard tsa-strip-icon"></i>
        <span class="tsa-strip-title">剧情推进</span>
        <span class="tsa-strip-progress"></span>
        <i class="fa-solid fa-chevron-down tsa-strip-arrow"></i>`;

    // ⚠ 直绑在节点上，而不是委托到 document。
    //   ST 的 $(document).on('click', '.mes') 同样是 document 级委托 —— 两者在
    //   同一元素上都会执行，委托版的 stopPropagation 拦不住它。平时它因
    //   is_delete_mode 提前 return 无事，但删除模式下点横条会把这条消息勾选上。
    //   绑在节点自身，才能在其冒泡到 .mes / document 之前拦住。
    strip.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const mesid = Number(strip.closest(".mes")?.getAttribute("mesid"));
        if (!Number.isFinite(mesid)) return;
        togglePanel(strip, mesid);
    });
    strip.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        const mesid = Number(strip.closest(".mes")?.getAttribute("mesid"));
        if (!Number.isFinite(mesid)) return;
        togglePanel(strip, mesid);
    });
    return strip;
}

/** 就地更新某条横条上的进度文字与展开态外观。 */
function updateStrip(strip, { progress, expanded } = {}) {
    if (!strip) return;
    const target = progress === undefined ? readProgressFromSettings() : progress;
    const label = formatProgressLabel(target);
    // 用 text() 而非 html()：进度文案没有富文本需求，也免得把外部数据当 HTML 解析
    $(strip).find(".tsa-strip-progress").text(label ? `· ${label}` : "");
    if (expanded !== undefined) {
        $(strip).attr("aria-expanded", String(expanded)).toggleClass("is-open", expanded);
    }
}

/**
 * 幂等地把横条挂到最后一条 AI 楼层的正文末端，并摘掉其余楼层的横条。
 * ST 的聊天是懒加载的（往上翻会补渲染更多楼层），所以这个函数要能被反复调用。
 */
function refreshStrips() {
    if (!isEnabled()) {
        removeAllStrips();
        destroyPanel();
        return;
    }

    const last = getLastAiMessage();
    if (!last) {
        removeAllStrips();
        destroyPanel();
        return;
    }

    const lastMesid = Number(last.getAttribute("mesid"));
    // 最后一条 AI 楼层变了（新消息/切分支）：展开中的面板已失去对象，收起来
    if (expandedForMesid !== null && expandedForMesid !== lastMesid) destroyPanel();

    // 先摘掉别的楼层上的横条（包含「上一任最后一条」）
    for (const node of document.querySelectorAll(`#chat .${STRIP_CLASS}`)) {
        if (node.closest(".mes") !== last) node.remove();
    }

    const mesText = last.querySelector(".mes_text");
    if (!mesText) return;

    let strip = last.querySelector(`.${STRIP_CLASS}`);
    if (!strip) {
        strip = buildStrip();
        // 插在正文之后：正文末端，且是兄弟节点，不受正文重写影响
        mesText.after(strip);
    }
    updateStrip(strip, { progress: readProgressFromSettings(), expanded: expandedForMesid === lastMesid });

    // 面板被 ST 的重渲染冲掉时按当前展开态补回来
    if (expandedForMesid === lastMesid && !document.getElementById(PANEL_ID)) {
        restorePanel(strip);
    }
}

function scheduleRefreshStrips(delay = 0) {
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(() => {
        refreshQueued = false;
        try {
            refreshStrips();
        } catch (e) {
            TitaniaLogger.warn("剧情推进横条挂载失败", e?.message || String(e));
        }
    }, delay);
}

export function refreshSceneAdvanceBubble() {
    scheduleRefreshStrips(0);
}

/** 刷新当前横条上的进度文字（点候选/推进进度后调用）。 */
function syncStripProgress(progress) {
    const strip = getStrip();
    if (strip) updateStrip(strip, { progress });
}

/* ------------------------------------------------------------------ *
 * 面板内容
 * ------------------------------------------------------------------ */

function buildProgressHtml(state) {
    if (!state.hasPlan || state.total <= 0) return "";
    const idx = state.progress.itemIndex;
    const percent = Math.round(((idx + 1) / state.total) * 100);
    return `
        <div class="tsa-progress">
            <div class="tsa-progress-text">第 ${idx + 1} / ${state.total} 条</div>
            <div class="tsa-bar"><div class="tsa-bar-fill" style="width:${percent}%"></div></div>
        </div>`;
}

/**
 * 大纲情节预览：全部条目一屏纵列，按进度区分状态——已推进过的淡化+打勾，
 * 当前条目高亮，后续条目常显。点条目主体 = 展开/收起该条完整情节（含伏笔）。
 *
 * 刻意**没有**原「剧情推进」窗口那个「拨进度指针」的右箭头按钮：进度已改由模型
 * 判断，手动指定已废弃。
 */
function buildPreviewHtml(state) {
    const items = Array.isArray(state.items) ? state.items : [];
    if (items.length === 0) return "";
    // 换方案后条目数可能变少，展开下标越界就当作收起
    if (previewItemIdx >= items.length) previewItemIdx = -1;

    const head = `
            <div class="tsa-preview-head tsa-preview-toggle ${previewOpen ? "is-open" : ""}" role="button" tabindex="0" aria-expanded="${previewOpen}" title="展开/收起大纲情节预览">
                <i class="fa-solid fa-map"></i> 大纲情节预览
                <span class="tsa-preview-count">${items.length} 条</span>
                <i class="fa-solid fa-chevron-down tsa-preview-arrow"></i>
            </div>`;

    // 折叠态只留标题行：面板里那几行空间留给候选卡片
    if (!previewOpen) {
        return `<div class="tsa-preview tsa-preview--collapsed">${head}</div>`;
    }

    const current = state.progress.itemIndex;
    const rows = items.map((item, idx) => {
        const cls = idx < current ? "done"
            : idx === current ? (state.reachedEnding ? "done" : "current")
            : "todo";
        const marker = cls === "done"
            ? '<i class="fa-solid fa-check"></i>'
            : cls === "current"
                ? '<i class="fa-solid fa-location-dot"></i>'
                : '<i class="fa-regular fa-circle"></i>';
        const expanded = previewItemIdx === idx;
        const plotHtml = expanded
            ? `<div class="tsa-preview-plot tsa-preview-plot--full">${escapeHtmlText(item.plot || "(空)")}</div>`
            : `<div class="tsa-preview-plot">${escapeHtmlText(briefText(item.plot))}</div>`;
        const foreshadowing = String(item.foreshadowing || "").trim();
        const foreshadowHtml = expanded && foreshadowing
            ? `<div class="tsa-preview-foreshadow"><i class="fa-solid fa-seedling"></i> 伏笔：${escapeHtmlText(foreshadowing)}</div>`
            : "";
        return `
            <div class="tsa-preview-item ${cls} ${expanded ? "expanded" : ""}" data-preview-idx="${idx}" title="${escapeHtmlText(item.plot || "(空)")}">
                <span class="tsa-preview-marker">${marker}</span>
                <div class="tsa-preview-main">
                    <div class="tsa-preview-title">${escapeHtmlText(item.time || "未设时间")} · ${escapeHtmlText(item.title || "未命名")}</div>
                    ${plotHtml}
                    ${foreshadowHtml}
                </div>
            </div>`;
    }).join("");

    return `<div class="tsa-preview">${head}${rows}</div>`;
}

function buildCandidatesHtml(state) {
    if (!state.hasPlan) {
        return `<div class="tsa-empty">请先在「故事大纲」里新建并选择一个方案，再回来推进剧情。</div>`;
    }
    // 不再按 reachedEnding 拦截：进度只是展示，该不该收尾由模型据此判断
    // （见 generateRecommendations 顶部说明），这里不该把候选藏起来。
    if (state.candidates.length === 0) {
        return `<div class="tsa-empty">点击下方「推荐剧情」，生成 2~3 个候选走向。</div>`;
    }

    return state.candidates.map((c, idx) => `
        <div class="tsa-item ${c.used ? "used" : ""}" data-candidate-index="${idx}" title="点击写入输入框（不会自动发送）">
            <div class="tsa-item-head">
                <span class="tsa-item-no">#${idx + 1}</span>
                <span class="tsa-item-title">${escapeHtmlText(c.title || `候选 ${idx + 1}`)}</span>
                ${c.used ? '<span class="tsa-item-used">已写入</span>' : ""}
            </div>
            <div class="tsa-item-meta">推进至大纲第 ${Number(c.itemIndex) || 0} 条</div>
            <div class="tsa-item-text">${escapeHtmlText(c.text)}</div>
        </div>
    `).join("");
}

/**
 * 面板 HTML：顶部模式切换（推荐剧情 / 节奏把控），下面按模式分叉。
 * 推荐剧情沿用原排布；节奏把控是本次新增、与前者机制不同（见 pacingInjection.js）。
 */
function buildPanelHtml(state) {
    const tabs = `
        <div class="tsa-mode-tabs">
            <button type="button" class="tsa-mode-tab ${panelMode === "recommend" ? "is-active" : ""}" data-mode="recommend"><i class="fa-solid fa-forward-step"></i> 推荐剧情</button>
            <button type="button" class="tsa-mode-tab ${panelMode === "pacing" ? "is-active" : ""}" data-mode="pacing"><i class="fa-solid fa-gauge-high"></i> 节奏把控</button>
        </div>`;
    const body = panelMode === "pacing" ? buildPacingBody() : buildRecommendBody(state);
    return `<div id="${PANEL_ID}" class="tsa-panel">${tabs}${body}</div>`;
}

/** 推荐剧情体：预览 / 方案 / 进度 / 候选（可滚动）+ 底部操作条。原「剧情推进」排布。 */
function buildRecommendBody(state) {
    const generateLabel = state.candidates.length > 0 ? "换一批" : "推荐剧情";
    return `
        <div class="tsa-scroll">
            ${buildPreviewHtml(state)}
            <div class="tsa-plan-row">
                <label class="tsa-plan-label">方案
                    <select class="tsa-plan-select" id="tsa-plan-select">${buildPlanOptions(state)}</select>
                </label>
            </div>
            ${buildProgressHtml(state)}
            <div class="tsa-list" id="tsa-list">${buildCandidatesHtml(state)}</div>
        </div>
        <div class="tsa-footer">
            <button type="button" class="tsa-chip" id="tsa-insert-chip" data-mode="${state.insertMode}" title="切换写入方式：覆盖/追加">
                <i class="fa-solid fa-arrows-left-right"></i>
                <span class="tsa-chip-label">${state.insertMode === "append" ? "追加" : "覆盖"}</span>
            </button>
            <button type="button" class="tsa-generate" id="tsa-generate" ${generating || !state.hasPlan ? "disabled" : ""}>
                <i class="fa-solid ${generating ? "fa-spinner fa-spin" : "fa-forward-step"}"></i> ${generating ? "推荐中..." : generateLabel}
            </button>
        </div>`;
}

function buildPlanOptions(state) {
    return state.plans.length
        ? state.plans.map(p => `<option value="${escapeHtmlText(p.id)}" ${p.id === state.planId ? "selected" : ""}>${escapeHtmlText(p.name)}</option>`).join("")
        : `<option value="">（暂无方案）</option>`;
}

/**
 * 节奏把控体：诊断区 / 可编辑指令 / 预设按钮 / 注入高级设置 / 武装条 + 底部操作条。
 * ⚠ 不被 hasPlan 拦——没有大纲也能凭正文判断，大纲只作可选上下文。
 */
function buildPacingBody() {
    const cfg = getPacingConfig();
    const r = pacingResult;
    const diag = r
        ? `<div class="tsa-pacing-diag">
                <span class="tsa-pacing-state">${escapeHtmlText(r.pacingState)}</span>
                ${r.focus ? `<span class="tsa-pacing-focus">${escapeHtmlText(r.focus)}</span>` : ""}
                <span class="tsa-pacing-intensity">强度 ${r.intensity}/5</span>
                ${r.assessment ? `<div class="tsa-pacing-assessment">${escapeHtmlText(r.assessment)}</div>` : ""}
            </div>`
        : `<div class="tsa-empty">点下方「分析节奏」，让外部模型读最近正文与大纲进度，给一条只影响下一条回复的节奏指令。无大纲也能用。</div>`;

    const presets = PACING_PRESETS.map(p =>
        `<button type="button" class="tsa-pacing-preset" data-preset="${escapeHtmlText(p.text)}">${escapeHtmlText(p.label)}</button>`
    ).join("");

    const armed = pacingInjection.getArmedPacing();
    const armedHtml = armed.armed
        ? `<div class="tsa-pacing-armed"><i class="fa-solid fa-circle-check"></i> 已武装：${escapeHtmlText(armed.summary)} · 下条回复生效</div>`
        : "";

    return `
        <div class="tsa-scroll">
            ${diag}
            <textarea class="tsa-pacing-input" id="tsa-pacing-directive" rows="3" placeholder="本次回复的节奏指令，可直接编辑，或点下方预设填入">${escapeHtmlText(pacingDraft)}</textarea>
            <div class="tsa-pacing-presets">${presets}</div>
            <details class="tsa-pacing-adv">
                <summary>注入高级设置</summary>
                <div class="tsa-pacing-adv-fields">
                    <label>深度<input type="number" id="tsa-pacing-depth" min="0" max="10000" step="1" value="${cfg.depth}"></label>
                    <label>角色
                        <select id="tsa-pacing-role">
                            <option value="system" ${cfg.role === "system" ? "selected" : ""}>system</option>
                            <option value="user" ${cfg.role === "user" ? "selected" : ""}>user</option>
                            <option value="assistant" ${cfg.role === "assistant" ? "selected" : ""}>assistant</option>
                        </select>
                    </label>
                </div>
            </details>
            ${armedHtml}
        </div>
        <div class="tsa-footer">
            <button type="button" class="tsa-chip" id="tsa-pacing-clear" title="清除已武装的节奏指令"><i class="fa-solid fa-eraser"></i> 清除</button>
            <button type="button" class="tsa-generate" id="tsa-pacing-analyze" ${pacingAnalyzing ? "disabled" : ""}>
                <i class="fa-solid ${pacingAnalyzing ? "fa-spinner fa-spin" : "fa-gauge-high"}"></i> ${pacingAnalyzing ? "分析中..." : "分析节奏"}
            </button>
            <button type="button" class="tsa-generate tsa-pacing-apply" id="tsa-pacing-apply"><i class="fa-solid fa-syringe"></i> 应用到下次回复</button>
        </div>`;
}

/** 重新拉取状态并整体重绘面板内容。 */
async function refreshPanel() {
    const $panel = $(`#${PANEL_ID}`);
    if ($panel.length === 0) return;

    let state;
    try {
        const api = await loadApi();
        state = api.getSceneAdvanceState();
    } catch (e) {
        TitaniaLogger.warn("剧情推进状态读取失败", e?.message || String(e));
        return;
    }

    // 只换内容，不动外层节点：避免重绘把面板的滚动位置重置到顶
    const scrollTop = $panel.find(".tsa-scroll").scrollTop() || 0;
    $panel.html($(buildPanelHtml(state)).html());
    $panel.find(".tsa-scroll").scrollTop(scrollTop);
    // 折叠态横条的进度也跟着权威状态走
    syncStripProgress(progressFromState(state));
}

/** 收起：摘掉面板。 */
function destroyPanel() {
    $(`#${PANEL_ID}`).remove();
    expandedForMesid = null;
    previewItemIdx = -1;
    previewOpen = false;   // 下次打开回到折叠态
    panelMode = "recommend";   // 下次打开回到推荐剧情页（节奏诊断缓存保留，重开仍可见）
    const strip = getStrip();
    if (strip) updateStrip(strip, { expanded: false });
}

/** 按已知展开态重建面板（ST 重渲染冲掉面板后补回）。 */
async function restorePanel(strip) {
    // 并发保护：refreshStrips 可能被连续事件触发多次，两个 restorePanel 同时越过
    // 外层的「面板不存在」判断就会插出两个同 id 面板。
    if (restoring) return;
    restoring = true;
    try {
        let state;
        try {
            const api = await loadApi();
            state = api.getSceneAdvanceState();
        } catch (e) {
            expandedForMesid = null;
            updateStrip(strip, { expanded: false });
            return;
        }
        if (document.getElementById(PANEL_ID)) return;
        insertPanel(strip, buildPanelHtml(state));
    } finally {
        restoring = false;
    }
}

/** 展开：把面板插到横条之后。 */
async function expandPanel(strip, mesid) {
    if (opening) return;
    opening = true;
    try {
        let state;
        try {
            const api = await loadApi();
            state = api.getSceneAdvanceState();
        } catch (e) {
            TitaniaLogger.error("剧情推进模块加载失败", e);
            if (window.toastr) toastr.error("剧情推进模块加载失败", "剧情推进");
            return;
        }
        // 异步期间用户可能又点了一次收起 —— 那就别再插了
        if (expandedForMesid !== mesid) return;
        if (document.getElementById(PANEL_ID)) return;
        insertPanel(strip, buildPanelHtml(state));
        updateStrip(strip, { progress: progressFromState(state), expanded: true });
    } finally {
        opening = false;
    }
}

/* ------------------------------------------------------------------ *
 * 交互
 * ------------------------------------------------------------------ */

/** 点候选卡片：写入酒馆输入框 + 用模型给的 item_index 回写进度 + 标记已写入。 */
async function onPickCandidate(index) {
    const api = await loadApi();
    const state = api.getSceneAdvanceState();
    const candidate = state.candidates[index];
    if (!candidate || !String(candidate.text || "").trim()) return;

    api.writeSceneToInput(candidate.text, api.getSceneInsertMode());
    if (state.planId) {
        // itemIndex 是 1-based 大纲序号，进度指针是 0-based
        api.applySceneProgress(state.planId, candidate.itemIndex - 1);
        api.markSceneCandidateUsed(state.planId, index);
    }
    await refreshPanel();
}

async function onGenerate() {
    if (generating) return;
    const api = await loadApi();

    if (!api.ensureSceneSourceLoaded()) {
        if (window.toastr) toastr.warning("请先在「故事大纲」里新建并选择一个方案", "剧情推进");
        return;
    }

    generating = true;
    await refreshPanel();
    try {
        await api.generateSceneRecommendations();
    } catch (e) {
        TitaniaLogger.error("剧情推荐失败", e);
    } finally {
        generating = false;
        await refreshPanel();
    }
}

/** 调外部模型分析节奏，把诊断与建议指令填进面板。 */
async function onAnalyzePacing() {
    if (pacingAnalyzing) return;
    pacingAnalyzing = true;
    await refreshPanel();
    try {
        const api = await loadApi();
        const result = await api.generatePacingAssessment();   // 失败时返回 null（内部已 toast）
        if (result) {
            pacingResult = result;
            pacingDraft = result.directive;
        }
    } catch (e) {
        TitaniaLogger.warn("节奏分析失败", e?.message || String(e));
    } finally {
        pacingAnalyzing = false;
        await refreshPanel();
    }
}

/** 把编辑框里的指令武装成一次性注入（影响下一条 ST 原生回复）。 */
function onApplyPacing() {
    const text = String($("#tsa-pacing-directive").val() || "").trim();
    if (!text) {
        if (window.toastr) toastr.warning("请先填写或分析出一条节奏指令", "叙事节奏");
        return;
    }
    pacingDraft = text;
    const ok = pacingInjection.armPacingDirective(text, getPacingConfig());
    if (ok && window.toastr) toastr.success("已应用，将影响下一条回复", "叙事节奏");
    void refreshPanel();   // 刷新武装条
}

async function togglePanel(strip, mesid) {
    if (document.getElementById(PANEL_ID)) {
        destroyPanel();
        return;
    }
    // 先挡住连点，再落状态：若在 opening 期间就置上 expandedForMesid，
    // expandPanel 会直接 return，留下「标记已展开但没有面板」的不一致状态。
    if (opening) return;
    expandedForMesid = mesid;
    await expandPanel(strip, mesid);
}

/** 插入面板并绑定其内部事件。面板节点只在插入时创建一次，innerHTML 重绘不影响绑定。 */
function insertPanel(strip, html) {
    strip.insertAdjacentHTML("afterend", html);
    const panel = document.getElementById(PANEL_ID);
    if (panel) bindPanelNode(panel);
    return panel;
}

/**
 * 面板内的事件一律直绑在面板节点上（理由同 buildStrip：委托到 document 拦不住
 * ST 的 .mes 处理器）。
 */
function bindPanelNode(panel) {
    const $panel = $(panel);

    $panel.on("click", ".tsa-preview-toggle", async function () {
        previewOpen = !previewOpen;
        if (!previewOpen) previewItemIdx = -1;
        await refreshPanel();
    });

    $panel.on("click", ".tsa-preview-item", async function () {
        const idx = Number($(this).data("preview-idx"));
        if (!Number.isFinite(idx)) return;
        previewItemIdx = previewItemIdx === idx ? -1 : idx;
        await refreshPanel();
    });

    $panel.on("change", "#tsa-plan-select", async function () {
        const api = await loadApi();
        api.switchSceneSourcePlan(String($(this).val() || ""));
        previewItemIdx = -1;
        await refreshPanel();
    });

    $panel.on("click", "#tsa-insert-chip", async function () {
        const api = await loadApi();
        const next = api.toggleSceneInsertMode();
        $(this).attr("data-mode", next).find(".tsa-chip-label").text(next === "append" ? "追加" : "覆盖");
    });

    $panel.on("click", "#tsa-generate", () => onGenerate());

    $panel.on("click", ".tsa-item", function () {
        onPickCandidate(Number($(this).data("candidate-index")));
    });

    // ── 节奏把控 ──
    $panel.on("click", ".tsa-mode-tab", async function () {
        const next = String($(this).data("mode") || "recommend") === "pacing" ? "pacing" : "recommend";
        if (next === panelMode) return;
        panelMode = next;
        await refreshPanel();
    });

    // 直接改 DOM 不重绘：重绘会丢掉输入框焦点与光标
    $panel.on("input", "#tsa-pacing-directive", function () {
        pacingDraft = String($(this).val() || "");
    });

    $panel.on("click", ".tsa-pacing-preset", function () {
        pacingDraft = String($(this).data("preset") || "");
        $panel.find("#tsa-pacing-directive").val(pacingDraft);
    });

    $panel.on("change", "#tsa-pacing-depth", function () {
        const n = Math.max(0, Math.floor(Number($(this).val()) || 0));
        savePacingConfig({ inject_depth: n });
    });
    $panel.on("change", "#tsa-pacing-role", function () {
        const role = String($(this).val() || "system");
        savePacingConfig({ inject_role: ["system", "user", "assistant"].includes(role) ? role : "system" });
    });

    $panel.on("click", "#tsa-pacing-analyze", () => onAnalyzePacing());
    $panel.on("click", "#tsa-pacing-apply", () => onApplyPacing());
    $panel.on("click", "#tsa-pacing-clear", async () => {
        pacingInjection.clearPacingDirective();
        await refreshPanel();
    });

    // ⚠ 必须最后注册：同一元素上的处理器按注册顺序执行，先让上面那些跑完，
    //   再拦住冒泡，别让它触到 ST 的 .mes 处理器（删除模式下会把消息勾上）。
    $panel.on("click mousedown", event => event.stopPropagation());
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */

export function initSceneAdvanceBubble() {
    if (listenersBound) {
        scheduleRefreshStrips(0);
        return;
    }
    listenersBound = true;

    // Escape 收起面板。这条留在 document 上无妨 —— 键盘事件不经过 .mes 的点击处理。
    $(document).on("keydown.tsceneadvance", event => {
        if (event.key === "Escape" && document.getElementById(PANEL_ID)) destroyPanel();
    });

    // 挂载时机：任何会新增/重排消息节点的事件都要补挂。
    // MORE_MESSAGES_LOADED 尤其重要 —— ST 往上翻页是懒加载的。
    const rerenderEvents = [
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_DELETED,
        event_types.MESSAGE_EDITED,
        event_types.MORE_MESSAGES_LOADED
    ];
    for (const eventName of rerenderEvents) {
        if (!eventName) continue;
        eventSource.on(eventName, () => scheduleRefreshStrips(0));
    }

    // 换聊天时楼层号可能恰好重排成同一个 mesid，refreshStrips 的「锚点变了」判断
    // 就抓不到，面板会停在旧聊天的内容上。切换聊天一律收起并重挂。
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            destroyPanel();
            scheduleRefreshStrips(0);
        });
    }

    // 首屏：此时聊天可能还没渲染完，稍等一下
    scheduleRefreshStrips(300);

    TitaniaLogger.info("剧情推进横条已初始化");
}
