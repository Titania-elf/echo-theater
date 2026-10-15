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
import { isBlindboxPlan, normalizeBlindbox, getProgressStats, DIRECTOR_TURN, describeDirectorTurn } from "../core/blindboxPlan.js";
import { EVENT_COUNT_DEFAULT, clampEventCount } from "../core/transitionPlan.js";
import {
    buildRevealView,
    resolveUnlocks,
    applyRevealMarks,
    backfillRevealMarks,
    pickUnlockCue,
    getPassedMarks,
    getClearedStageIndexes,
} from "../core/blindboxReveal.js";
import {
    getUnlockSoundConfig,
    cycleUnlockVolume,
    describeUnlockVolume,
    playUnlockCue,
} from "../core/unlockChime.js";

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
/** 盲盒解锁界面展开了哪个已通关阶段：-1=默认（最近通关的那个）、-2=全部收起、>=0=指定下标。收起时重置。 */
let bbStageOpenIdx = -1;

// 判定流水是否展开全部（默认只露最近 3 拍）。面板被 ST 重渲染冲掉时不重置——
// 和 bbStageOpenIdx 一样属于"玩家的查看偏好"，下次打开该保持。
let bbFlowOpen = false;
/** 面板当前模式：recommend（推荐剧情）| pacing（节奏把控）。收起时重置回 recommend。 */
let panelMode = "recommend";
/** 最近一次节奏诊断（{pacingState, assessment, directive, focus, intensity}），重绘不丢。 */
let pacingResult = null;
/** 节奏指令编辑草稿：和输入框同步，避免重绘丢失用户正在打的字（同 tempInstruction 的做法）。 */
let pacingDraft = "";
/** 节奏分析进行中：防连点，也让重绘保留 loading 态。 */
let pacingAnalyzing = false;
/** 过渡行程单：折叠表单是否展开（只在"本段还没排"时有意义）。收起面板时重置。 */
let transitionOpen = false;
/** 过渡梗概草稿：同 pacingDraft——重绘不丢用户正在打的字。 */
let transitionDraft = "";
/** 事件数量输入框的值。 */
let transitionCount = EVENT_COUNT_DEFAULT;
/** 行程单编辑态（改文字 / 增 / 删 / 调序）。收起面板时重置。 */
let transitionEditing = false;
/**
 * 编辑中的事件草稿（进编辑态时拷贝一份，退出时才落盘）。
 *
 * 为什么不每改一下就落盘：落盘要过 normalizeTransition，而它会**丢掉 brief 为空的条目**
 * （那是给模型看的数据，空壳没意义）。编辑过程中把某条 brief 清空再点"上移"，那条就会
 * 当场蒸发——这是最恼人的一种"手滑"。所以编辑期一律改草稿，只在退出编辑/收起面板时
 * 一次性提交，空壳到那时才被清掉（此时语义正确且可预期）。
 * 草稿刻意放在模块级：ST 重渲染冲掉面板后 rebuild 仍从它读，编辑不丢。
 */
let transitionEditDraft = null;
/** 行程单生成中：防连点，也让重绘保留 loading 态。 */
let transitionGenerating = false;

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
    // 过渡步数也从 extData 现读：折叠态横条必须能看出"还卡在某段过渡里"，
    // 但不能为此加载整个大纲模块（那是这条路径一开始就守着的规矩）。逻辑与
    // transitionPlan.getActiveTransition + isTransitionDone 同义，只是不引它。
    const tr = Array.isArray(plan.transitions)
        ? plan.transitions.find(t => Number(t?.fromIndex) === index)
        : null;
    const transitionTotal = Array.isArray(tr?.events) ? tr.events.length : 0;
    const transitionStep = transitionTotal > 0
        ? Math.max(0, Math.min(Math.floor(Number(tr?.cursor)) || 0, transitionTotal))
        : -1;
    return { index, total, transitionStep, transitionTotal };
}

function formatProgressLabel(progress) {
    if (!progress) return "";
    const base = `第 ${progress.index + 1} / ${progress.total} 条`;
    return progress.transitionStep >= 0
        ? `${base} · 过渡 ${progress.transitionStep}/${progress.transitionTotal}`
        : base;
}

/* ------------------------------------------------------------------ *
 * 盲盒导演：激活方案是已封印盲盒时，横条退化成"引导中"状态灯，面板不给剧透
 * ------------------------------------------------------------------ */

/** 当前激活方案若是「已封印、未解封」的盲盒，返回其进度信息；否则 null。只读 extData，不加载大模块。 */
function getActiveBlindboxInfo() {
    try {
        const data = getExtData();
        const plans = Array.isArray(data?.[PLANS_KEY]) ? data[PLANS_KEY] : [];
        if (plans.length === 0) return null;
        const activeId = String(data?.[ACTIVE_PLAN_KEY] || "");
        const plan = plans.find(p => p?.id === activeId) || plans[0];
        if (!plan || !isBlindboxPlan(plan)) return null;
        const bb = plan.blindbox;
        if (!bb || bb.sealed !== true || bb.unsealed === true) return null;
        const nbb = normalizeBlindbox(bb);
        return {
            planId: plan.id,
            stats: getProgressStats(nbb),
            paused: bb.directorPaused === true,
            // 阶段化视图：纯数据，防剧透（未解锁项在数据层就没有内容）由 blindboxReveal 保证
            view: buildRevealView(nbb),
            // 判定流水：同样是纯数据、同样零剧透——条目里只有状态与下标，没有内容
            // （保证在 blindboxPlan.normalizeDirectorLogEntry，那里连 evidence 都不收）。
            directorLog: nbb.directorLog,
            sound: getUnlockSoundConfig(),
        };
    } catch {
        return null;
    }
}

/** 翻转激活盲盒的导演暂停标记，落盘。 */
function toggleBlindboxDirectorPaused(planId) {
    const data = getExtData();
    const plans = Array.isArray(data?.[PLANS_KEY]) ? data[PLANS_KEY] : [];
    const plan = plans.find(p => p?.id === planId);
    if (!plan || !plan.blindbox) return;
    plan.blindbox.directorPaused = plan.blindbox.directorPaused !== true;
    plan.updatedAt = Date.now();
    saveExtData();
}

/**
 * 把无头 API 的状态快照转成横条要的进度，没有方案/方案为空时返回 null。
 * total 为 0 时必须回 null：否则会渲染出「第 1 / 0 条」。
 */
function progressFromState(state) {
    const total = Number(state?.total) || 0;
    if (total <= 0) return null;
    const index = Math.max(0, Math.min(Number(state.progress?.itemIndex) || 0, total - 1));
    const t = state?.transition;
    const transitionTotal = t && Array.isArray(t.events) ? t.events.length : 0;
    return {
        index,
        total,
        transitionStep: transitionTotal > 0 ? Math.max(0, Math.min(Number(t.cursor) || 0, transitionTotal)) : -1,
        transitionTotal
    };
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

/**
 * 横条上那一小截心跳：只说「导演刚才干了什么」，不碰任何内容。
 *
 * 存在的理由：判定跑在后台，没出手的那一拍与"根本没在跑"在界面上一模一样。
 * 有一截心跳，玩家才分得清「它在克制」和「它坏了」。
 */
function directorHeartbeat(entry) {
    if (!entry) return "";
    if (entry.turn === DIRECTOR_TURN.FAILED) return "本拍判定异常";
    const floor = Number(entry.floor) >= 0 ? `#${entry.floor}` : "";
    const tail = Array.isArray(entry.advanced) && entry.advanced.length > 0
        ? "翻过一幕"
        : (entry.spoke === "firm" ? "收束" : (entry.spoke === "gentle" ? "轻推" : ""));
    const parts = [floor ? `刚看过 ${floor}` : "刚看过", tail].filter(Boolean);
    return parts.join(" · ");
}

/** 就地更新某条横条上的进度文字与展开态外观。 */
function updateStrip(strip, { progress, expanded } = {}) {
    if (!strip) return;
    const bbInfo = getActiveBlindboxInfo();
    if (bbInfo) {
        // 盲盒激活：横条退化成"引导中"状态灯，不显示任何剧透文字。
        $(strip).find(".tsa-strip-title").text(bbInfo.paused ? "盲盒导演 · 已暂停" : "盲盒导演");
        const log = Array.isArray(bbInfo.directorLog) ? bbInfo.directorLog : [];
        const last = log[log.length - 1];
        const beat = bbInfo.paused ? "" : directorHeartbeat(last);
        $(strip).find(".tsa-strip-progress")
            .text(`· 已解锁 ${bbInfo.stats.passed}/${bbInfo.stats.total}${beat ? ` · ${beat}` : ""}`);
        // 判定失败时把心跳染红——这是"导演坏了"唯一不用翻日志就看得见的地方。
        $(strip).toggleClass("is-failed", !bbInfo.paused && last?.turn === DIRECTOR_TURN.FAILED);
        // 后台刚解锁、玩家还没打开面板看过 → 角标提示（打开面板做完揭晓动画后自动消失）。
        // 每次都按持久化的账本重算，所以切楼层/重渲染都不会误留或误清。
        const pending = bbInfo.view.header.hasUnviewed && !bbInfo.paused;
        $(strip).toggleClass("has-unlock", pending);
        if (pending) {
            if (!strip.querySelector(".tsa-strip-unlock-dot")) {
                $(strip).find(".tsa-strip-arrow").before('<span class="tsa-strip-unlock-dot" aria-hidden="true"></span>');
            }
        } else {
            $(strip).find(".tsa-strip-unlock-dot").remove();
        }
    } else {
        $(strip).find(".tsa-strip-title").text("剧情推进");
        const target = progress === undefined ? readProgressFromSettings() : progress;
        const label = formatProgressLabel(target);
        // 用 text() 而非 html()：进度文案没有富文本需求，也免得把外部数据当 HTML 解析
        $(strip).find(".tsa-strip-progress").text(label ? `· ${label}` : "");
        $(strip).removeClass("has-unlock");
        $(strip).removeClass("is-failed");
        $(strip).find(".tsa-strip-unlock-dot").remove();
    }
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

/**
 * 判定跑完后由 directorInjection 调用：让界面追上这一拍的判定结果。
 *
 * 和 notifyBlindboxUnlocks 的分工：
 *   · 那个只管"新解锁"的结账（音效 / 角标），**没有新解锁就提前 return**；
 *   · 这个不管有没有解锁都要跑——判定没出手、甚至判定失败的那一拍，横条心跳与面板
 *     流水同样得更新。少了这一下，"导演很克制"和"判定根本没在跑"又长得一样了。
 * 必须在 notifyBlindboxUnlocks **之后**调用：先结账（写 announced 账本）再渲染，
 * 否则刚解锁的那一幕会被当成旧账，不播揭晓动画。
 */
export function refreshDirectorPanel() {
    if (document.getElementById(PANEL_ID)) refreshPanel();
    scheduleRefreshStrips(0);
}

/**
 * 导演判定跑完之后由 directorInjection 调用：把这一拍新解锁的账结掉。
 *
 * 为什么需要它：ST 的渲染事件都在判定**之前**就发完了（判定要等一次 API 往返），横条上的
 * 进度与角标都会是旧的；而"刚解锁"的实时反馈只有这里能给——音效在这一刻响，角标在这一刻
 * 亮。面板若还开着（swipe 重判这种不新增楼层的情况）就顺手就地刷新。
 *
 * @param {string} planId 判定前捕获的方案 id。**必须由调用方传入**：判定期间用户可能切换
 *                        激活方案，事后重新去读 extData 会拿错本子，给错的书报解锁。
 */
export async function notifyBlindboxUnlocks(planId) {
    try {
        const plans = Array.isArray(getExtData()?.[PLANS_KEY]) ? getExtData()[PLANS_KEY] : [];
        const plan = plans.find((p) => p?.id === planId);
        if (!plan || !isBlindboxPlan(plan) || !plan.blindbox) return;
        if (plan.blindbox.sealed !== true || plan.blindbox.unsealed === true) return;

        // 横条/面板没开时：账照记，但不响。响一声却没有任何地方能看，只会让人找不到北；
        // 等玩家把横条打开，那段没看过的历史会补做一次揭晓动画（viewed 标记只认渲染那一刻）。
        const visible = isEnabled();
        const bb = normalizeBlindbox(plan.blindbox);
        const u = resolveUnlocks(bb);

        // 本功能上线前的老存档：静默补记（不响、不动画），否则第一次玩会噼里啪啦响一串旧账。
        if (u.backfill) {
            plan.blindbox = backfillRevealMarks(bb);
            plan.updatedAt = Date.now();
            saveExtData();
            return;
        }
        if (u.freshMarks.length === 0 && u.freshStages.length === 0) return;

        // 静音也照记账：只压播放。否则静音期间攒下的解锁会在重新打开音效时一起炸出来。
        const cue = visible
            ? pickUnlockCue({
                freshMarks: u.freshMarks,
                freshStages: u.freshStages,
                config: getUnlockSoundConfig(),
            })
            : null;
        plan.blindbox = applyRevealMarks(bb, { announced: [...u.freshMarks, ...u.freshStages] });
        plan.updatedAt = Date.now();
        saveExtData();
        if (cue) playUnlockCue(cue);

        if (!visible) return;
        // 面板还开着就就地刷新（swipe 重判走这条），否则至少让横条的进度与角标追上。
        if (document.getElementById(PANEL_ID)) await refreshPanel();
        else scheduleRefreshStrips(0);
    } catch (e) {
        TitaniaLogger.warn("盲盒解锁提示失败（已忽略，不影响游玩）", e);
    }
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
    // 有行程单时挂一条子进度：大纲进度点是粗粒度的，玩家真正在走的是"过渡段的第几步"。
    const t = state.transition;
    const stepText = t && t.events.length > 0
        ? `<div class="tsa-progress-step"><i class="fa-solid fa-diagram-project"></i> 本段过渡 ${t.cursor} / ${t.events.length} 步</div>`
        : "";
    return `
        <div class="tsa-progress">
            <div class="tsa-progress-text">第 ${idx + 1} / ${state.total} 条</div>
            <div class="tsa-bar"><div class="tsa-bar-fill" style="width:${percent}%"></div></div>
            ${stepText}
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
            <div class="tsa-item-meta">${candidateMetaLine(c, state)}</div>
            ${c.from ? `<div class="tsa-item-from"><i class="fa-solid fa-turn-up"></i> 承接：${escapeHtmlText(c.from)}</div>` : ""}
            <div class="tsa-item-text">${escapeHtmlText(c.text)}</div>
        </div>
    `).join("");
}

/** 候选卡片那行小字：有行程单时点明它走的是第几步，否则只说推进到第几条。 */
function candidateMetaLine(c, state) {
    const itemNo = Number(c.itemIndex) || 0;
    if (c.stepIndex === null || c.stepIndex === undefined) return `推进至大纲第 ${itemNo} 条`;
    const total = state?.transition?.events?.length || 0;
    return `停留在第 ${itemNo} 条 · 走完过渡第 ${c.stepIndex} / ${total} 步`;
}

/**
 * 过渡行程单块：把相邻两条大纲之间那段空白补成一条有序的事件清单。
 *
 * ── 为什么点某一步不是"发送" ──
 * 行程单的 brief 是**面向作者的梗概体**（"两人从对峙走到和解"），而候选才是"可直接发送的
 * 玩家输入"（见 rolling 模板对 text 的定义）。所以点一步的语义是**定位**——把这一步设为
 * "当前要演的"，并清掉上一步遗留的候选（它们已经过期）；真正可发的文本由随后的「推荐剧情」
 * 产出，它会把当前这一步写进 {{transitionContext}}。
 * 一句话：行程单定"走到哪"，候选定"怎么走"。
 */
function buildTransitionHtml(state) {
    if (!state.hasPlan || !state.canTransition) return "";
    const gap = state.transitionGap;
    const gapLabel = `第 ${gap.fromIndex + 1} → ${gap.toIndex + 1} 条`;
    const t = state.transition;

    if (!t) {
        const form = transitionOpen ? `
            <div class="tsa-transition-form">
                <textarea class="tsa-transition-brief" id="tsa-transition-brief" rows="2"
                    placeholder="这一段大概怎么走？（例：两人从冷战到重新搭话，中间隔着一次意外）">${escapeHtmlText(transitionDraft)}</textarea>
                <div class="tsa-transition-form-row">
                    <label class="tsa-transition-count-label">事件数
                        <input type="number" class="tsa-transition-count" id="tsa-transition-count" min="1" max="10" step="1" value="${transitionCount}">
                    </label>
                    <button type="button" class="tsa-generate tsa-transition-gen" id="tsa-transition-gen" ${transitionGenerating ? "disabled" : ""}>
                        <i class="fa-solid ${transitionGenerating ? "fa-spinner fa-spin" : "fa-diagram-project"}"></i> ${transitionGenerating ? "生成中..." : "生成行程单"}
                    </button>
                </div>
                <div class="tsa-transition-hint">把「${escapeHtmlText(gap.fromTitle || "当前条")}」到「${escapeHtmlText(gap.toTitle || "下一条")}」之间的空档排成几步，剧情推进就会沿着它们走，而不是一步跨过去。</div>
            </div>` : "";
        return `
            <div class="tsa-transition ${transitionOpen ? "is-open" : ""}">
                <div class="tsa-transition-head tsa-transition-toggle ${transitionOpen ? "is-open" : ""}" role="button" tabindex="0" aria-expanded="${transitionOpen}" title="展开/收起过渡行程单">
                    <i class="fa-solid fa-diagram-project"></i> 过渡行程单
                    <span class="tsa-transition-gap">${escapeHtmlText(gapLabel)}</span>
                    <i class="fa-solid fa-chevron-down tsa-transition-arrow"></i>
                </div>
                ${form}
            </div>`;
    }

    // 编辑期一律画草稿（见 transitionEditDraft 的注释）；平时画落盘的那份。
    const shown = transitionEditing && Array.isArray(transitionEditDraft) ? transitionEditDraft : t.events;
    const total = shown.length;
    const doneCount = Math.min(t.cursor, total);
    const rows = shown.map((e, i) => {
        const cls = i < t.cursor ? "done" : i === t.cursor ? "current" : "todo";
        const marker = cls === "done" ? '<i class="fa-solid fa-check"></i>'
            : cls === "current" ? '<i class="fa-solid fa-location-dot"></i>'
                : '<i class="fa-regular fa-circle"></i>';

        if (transitionEditing) {
            return `
            <li class="tsa-transition-step ${cls} is-editing">
                <span class="tsa-transition-marker">${marker}</span>
                <div class="tsa-transition-edit">
                    <input class="tsa-transition-edit-title" data-step-idx="${i}" data-field="title" value="${escapeHtmlText(e.title)}" placeholder="标题" maxlength="40">
                    <input class="tsa-transition-edit-span" data-step-idx="${i}" data-field="span" value="${escapeHtmlText(e.span)}" placeholder="时间（如 三天后）" maxlength="60">
                    <textarea class="tsa-transition-edit-brief" data-step-idx="${i}" data-field="brief" rows="2" placeholder="这一步发生了什么、导致了什么">${escapeHtmlText(e.brief)}</textarea>
                    <div class="tsa-transition-edit-ops">
                        <button type="button" class="tsa-icon-btn tsa-transition-up" data-step-idx="${i}" title="上移" ${i === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-up"></i></button>
                        <button type="button" class="tsa-icon-btn tsa-transition-down" data-step-idx="${i}" title="下移" ${i === total - 1 ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i></button>
                        <button type="button" class="tsa-icon-btn tsa-transition-del" data-step-idx="${i}" title="删除这一步"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </li>`;
        }
        return `
            <li class="tsa-transition-step ${cls}" data-step-idx="${i}" title="把这一步设为当前（不会写入输入框）">
                <span class="tsa-transition-marker">${marker}</span>
                <div class="tsa-transition-main">
                    <div class="tsa-transition-title">${escapeHtmlText(e.title || `第 ${i + 1} 步`)}${e.span ? `<span class="tsa-transition-span">${escapeHtmlText(e.span)}</span>` : ""}</div>
                    <div class="tsa-transition-brief-text">${escapeHtmlText(e.brief)}</div>
                </div>
            </li>`;
    }).join("");

    const left = total - doneCount;
    const finalRow = `
        <li class="tsa-transition-final ${state.transitionDone ? "is-ready" : ""}" data-action="cross-gap"
            title="${state.transitionDone ? "跨到下一个阶段" : `还有 ${left} 步没走；点它会跳过剩下几步直接跨段`}">
            <i class="fa-solid fa-flag-checkered"></i> 进入「${escapeHtmlText(gap.toTitle || `第 ${gap.toIndex + 1} 条`)}」
        </li>`;

    const ops = transitionEditing
        ? `<button type="button" class="tsa-chip tsa-transition-add" id="tsa-transition-add"><i class="fa-solid fa-plus"></i> 添加一条</button>
           <button type="button" class="tsa-chip tsa-transition-edit-toggle is-active" id="tsa-transition-edit-toggle"><i class="fa-solid fa-check"></i> 完成编辑</button>`
        : `<button type="button" class="tsa-chip tsa-transition-edit-toggle" id="tsa-transition-edit-toggle"><i class="fa-solid fa-pen"></i> 编辑</button>
           <button type="button" class="tsa-chip tsa-transition-regen" id="tsa-transition-regen" ${transitionGenerating ? "disabled" : ""}><i class="fa-solid fa-rotate"></i> 重新生成</button>
           <button type="button" class="tsa-chip tsa-transition-drop" id="tsa-transition-drop"><i class="fa-solid fa-trash"></i> 删除</button>`;

    return `
        <div class="tsa-transition is-open has-list">
            <div class="tsa-transition-head">
                <i class="fa-solid fa-diagram-project"></i> 过渡行程单
                <span class="tsa-transition-gap">${escapeHtmlText(gapLabel)}</span>
                <span class="tsa-transition-badge">${doneCount} / ${total} 步</span>
                ${state.stepState ? `<span class="tsa-transition-state" title="模型读最新一层回复得出的「当前这一步演到哪了」，代表它这一批候选是从哪儿往下接的">本步 ${escapeHtmlText(state.stepState)}</span>` : ""}
            </div>
            ${t.brief ? `<div class="tsa-transition-purpose">用意：${escapeHtmlText(t.brief)}</div>` : ""}
            <ol class="tsa-transition-list">${rows}${finalRow}</ol>
            <div class="tsa-transition-ops">${ops}</div>
        </div>`;
}

/**
 * 面板 HTML：顶部模式切换（推荐剧情 / 节奏把控），下面按模式分叉。
 * 推荐剧情沿用原排布；节奏把控是本次新增、与前者机制不同（见 pacingInjection.js）。
 */
function buildPanelHtml(state) {
    const bbInfo = getActiveBlindboxInfo();
    if (bbInfo) {
        // 盲盒激活：面板只给"引导中"状态 + 暂停开关，推荐剧情（会剧透）与节奏把控（已被导演覆盖）都隐身。
        return `<div id="${PANEL_ID}" class="tsa-panel">${buildBlindboxBody(bbInfo)}</div>`;
    }
    const tabs = `
        <div class="tsa-mode-tabs">
            <button type="button" class="tsa-mode-tab ${panelMode === "recommend" ? "is-active" : ""}" data-mode="recommend"><i class="fa-solid fa-forward-step"></i> 推荐剧情</button>
            <button type="button" class="tsa-mode-tab ${panelMode === "pacing" ? "is-active" : ""}" data-mode="pacing"><i class="fa-solid fa-gauge-high"></i> 节奏把控</button>
        </div>`;
    const body = panelMode === "pacing" ? buildPacingBody() : buildRecommendBody(state);
    return `<div id="${PANEL_ID}" class="tsa-panel">${tabs}${body}</div>`;
}

/* ------------------------------------------------------------------ *
 * 盲盒解锁界面（阶段化揭晓）
 *
 * 阶段＝盲盒节点。已通关的阶段揭晓标题＋硬锚（揭晓本身就是奖励）、进行中的阶段只给
 * 进度点与"未解锁"占位、后面的阶段只留一行封印。所有"不给看"的内容在数据层就不存在
 * （见 blindboxReveal.buildRevealView），这里只负责画。
 *
 * ── 揭晓动画为什么在渲染路径里消费 ──
 * 面板是插在"最后一条 AI 楼层"的横条里的，新回复一渲染就连带面板被收掉。所以"刚解锁"
 * 的实时反馈只能是音效＋横条角标，动画要等玩家下次打开面板时才播。既然如此，"这条已经
 * 动画过了"就必须在**渲染那一刻**记账，否则动画会为一个没打开的面板空播掉。
 * ------------------------------------------------------------------ */

/** 阶段编号（一到十，再往后退回阿拉伯数字）。 */
const BB_STAGE_LABELS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const bbStageLabel = (i) => `阶段${BB_STAGE_LABELS[i] || ` ${i + 1}`}`;

/** 一条已揭晓的事件。recap 是导演记下的「实际怎么发生的」，比计划内容更贴玩家的故事。 */
function bbEventRow(ev) {
    const cls = ["tsa-bb-ev", `is-${ev.status}`];
    if (ev.isFresh) cls.push("is-fresh");
    const tag = ev.status === "skipped" ? `<span class="tsa-bb-ev-tag">跳过</span>` : "";
    const recap = ev.recap
        ? `<div class="tsa-bb-ev-recap">↳ ${escapeHtmlText(ev.recap)}</div>`
        : "";
    const span = ev.spanLabel ? `<span class="tsa-bb-ev-span">${escapeHtmlText(ev.spanLabel)}</span>` : "";
    return `<li class="${cls.join(" ")}">
        <span class="tsa-bb-ev-no">${ev.no}</span>
        <div class="tsa-bb-ev-main">
            <div class="tsa-bb-ev-text">${escapeHtmlText(ev.content)}${tag}</div>
            ${recap}
        </div>
        ${span}
    </li>`;
}

/** 一条还没解锁的事件：只给"这里有一拍"＋玩家自己的停留拍数，绝不带内容。 */
function bbLockedRow(ev) {
    const cls = ["tsa-bb-ev", "is-locked"];
    if (ev.isTarget) cls.push("is-target");
    const dwell = ev.dwell && ev.dwell.turns > 0
        ? (ev.dwell.beats > 0 ? `已走 ${ev.dwell.turns} / ${ev.dwell.beats} 拍` : `已走 ${ev.dwell.turns} 拍`)
        : "未解锁";
    const icon = ev.isTarget ? "fa-hourglass-half" : "fa-lock";
    return `<li class="${cls.join(" ")}">
        <span class="tsa-bb-ev-no">${ev.no}</span>
        <div class="tsa-bb-ev-main">
            <div class="tsa-bb-ev-lock"><i class="fa-solid ${icon}"></i> ${dwell}</div>
            <span class="tsa-bb-shimmer" aria-hidden="true"></span>
        </div>
    </li>`;
}

/** 一个阶段。sealed 只给一行（连事件行都不画），其余给表头 + 事件列表。 */
function bbStageBlock(stage, openIdx) {
    const counts = `${stage.counts.passed}/${stage.counts.total}`;
    const fresh = stage.isFresh ? " is-fresh" : "";

    if (stage.state === "sealed") {
        return `<li class="tsa-bb-stage is-sealed">
            <div class="tsa-bb-stage-head">
                <span class="tsa-bb-stage-mark"><i class="fa-solid fa-lock"></i></span>
                <span class="tsa-bb-stage-label">${bbStageLabel(stage.nodeIndex)}</span>
                <span class="tsa-bb-stage-count">${stage.counts.total} 件</span>
            </div>
        </li>`;
    }

    const rows = stage.events
        .map((ev) => (ev.unlocked ? bbEventRow(ev) : bbLockedRow(ev)))
        .join("");
    const events = `<ul class="tsa-bb-events">${rows}</ul>`;

    if (stage.state === "current") {
        const holding = stage.isHolding
            ? `<div class="tsa-bb-holding">这一阶段的关键事件都翻过去了，正在等一个转折真正落地——导演这几拍会收紧。</div>`
            : "";
        return `<li class="tsa-bb-stage is-current">
            <div class="tsa-bb-stage-head">
                <span class="tsa-bb-stage-mark">◇</span>
                <span class="tsa-bb-stage-label">${bbStageLabel(stage.nodeIndex)}</span>
                <span class="tsa-bb-stage-count">进行中 ${counts}</span>
            </div>
            <div class="tsa-bb-stage-body">${holding}${events}</div>
        </li>`;
    }

    // 已通关：可折叠。hold 状态（事件翻完但硬锚未落地）不揭晓标题与硬锚。
    const open = openIdx === stage.nodeIndex;
    const titleText = stage.revealed ? escapeHtmlText(stage.title || "") : "";
    const anchor = stage.revealed && stage.anchor
        ? `<div class="tsa-bb-anchor"><span class="tsa-bb-anchor-tag">硬锚</span>${escapeHtmlText(stage.anchor)}</div>`
        : "";
    return `<li class="tsa-bb-stage is-cleared${stage.isHolding ? " is-holding" : ""}${fresh}" data-stage-idx="${stage.nodeIndex}">
        <div class="tsa-bb-stage-head" role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}">
            <span class="tsa-bb-stage-mark">◆</span>
            <span class="tsa-bb-stage-label">${bbStageLabel(stage.nodeIndex)}</span>
            <span class="tsa-bb-stage-title">${titleText}</span>
            <span class="tsa-bb-stage-count">${counts}</span>
            <i class="fa-solid fa-chevron-down tsa-bb-stage-arrow"></i>
        </div>
        <div class="tsa-bb-stage-body">${anchor}${events}</div>
    </li>`;
}

/**
 * 渲染即消费：把这一屏画出来的"新解锁"记进账本的 viewed，下次打开就是静态的历史。
 * 顺带清掉横条角标（角标看的就是 viewed）。
 */
function consumeUnlockMarks(info) {
    if (!info?.planId || info.view?.header?.hasUnviewed !== true) return;
    const plans = Array.isArray(getExtData()?.[PLANS_KEY]) ? getExtData()[PLANS_KEY] : [];
    const plan = plans.find((x) => x?.id === info.planId);
    if (!plan || !isBlindboxPlan(plan) || !plan.blindbox) return;
    const bb = normalizeBlindbox(plan.blindbox);
    // 老存档（marksReady=false）走静默回填：两张表一起补上。只补 viewed 的话，
    // 下一次判定会把这条陈年旧账当成"刚解锁"响一声。
    plan.blindbox = bb.marksReady === true
        ? applyRevealMarks(bb, {
            viewed: [...getPassedMarks(bb), ...getClearedStageIndexes(bb).map((i) => `s:${i}`)],
            marksReady: true,
        })
        : backfillRevealMarks(bb);
    plan.updatedAt = Date.now();
    saveExtData();
    const strip = getStrip();
    if (strip) updateStrip(strip);
}

/** 盲盒导演面板体：阶段化解锁界面 + 音量循环 + 暂停开关。全程不出现未解锁内容的文字。 */
function buildBlindboxBody(info) {
    const view = info.view || { header: {}, stages: [] };
    const h = view.header || {};
    const percent = h.total > 0 ? Math.round((h.passed / h.total) * 100) : 0;

    // 展开哪个已通关阶段：-1=默认（最近通关的那个）、-2=全部收起、>=0=指定下标。
    const revealedIdx = view.stages.filter((st) => st.revealed).map((st) => st.nodeIndex);
    const defaultOpen = revealedIdx.length ? revealedIdx[revealedIdx.length - 1] : -1;
    const openIdx = bbStageOpenIdx === -1 ? defaultOpen : bbStageOpenIdx;

    const dwell = h.isHolding
        ? "本阶段事件都翻过去了，在等一个转折落地"
        : (h.dwell?.beats > 0
            ? `当前这一拍已走 ${h.dwell.turns} / ${h.dwell.beats} 拍`
            : `当前这一拍已走 ${h.dwell?.turns ?? 0} 拍`);
    const stages = view.stages.map((st) => bbStageBlock(st, openIdx)).join("");
    const emptyHint = h.passed === 0
        ? `<div class="tsa-bb-empty">还没有已揭晓的片段——照常玩就好，踩中关键情节时这里会一段段亮起来。</div>`
        : "";

    const sound = info.sound || {};
    const soundOn = sound.enabled !== false && Number(sound.volume) > 0;
    const soundIcon = soundOn ? (Number(sound.volume) > 70 ? "fa-volume-high" : "fa-volume-low") : "fa-volume-xmark";
    const soundLabel = describeUnlockVolume(sound);

    // 渲染即消费本屏的"新解锁"（见函数注释）。放在拼 HTML 之后、返回之前。
    consumeUnlockMarks(info);

    return `
        <div class="tsa-scroll">
            <div class="tsa-bb">
                <div class="tsa-bb-top">
                    <span class="tsa-bb-title"><i class="fa-solid fa-clapperboard"></i> 盲盒导演</span>
                    <span class="tsa-bb-state">${info.paused ? "已暂停" : "引导中"}</span>
                    <span class="tsa-bb-stages-count">阶段 ${Math.min(h.stageIndex + 1, h.stageCount)}/${h.stageCount}</span>
                </div>
                <div class="tsa-progress tsa-bb-progress">
                    <div class="tsa-progress-text">已解锁 ${h.passed} / ${h.total} 个关键事件${h.skipped > 0 ? ` · 跳过 ${h.skipped}` : ""}</div>
                    <div class="tsa-bar"><div class="tsa-bar-fill" style="width:${percent}%"></div></div>
                </div>
                <div class="tsa-bb-dwell">${dwell}</div>
                ${emptyHint}
                ${buildDirectorFlow(info)}
                <ol class="tsa-bb-stages">${stages}</ol>
            </div>
        </div>
        <div class="tsa-footer">
            <button type="button" class="tsa-icon-btn" id="tsa-bb-sound" title="解锁提示音：${soundLabel}（点击切换 关/轻/中/响）" aria-label="切换解锁提示音音量">
                <i class="fa-solid ${soundIcon}"></i>
            </button>
            <button type="button" class="tsa-generate" id="tsa-bb-pause">
                <i class="fa-solid ${info.paused ? "fa-play" : "fa-pause"}"></i> ${info.paused ? "恢复导演" : "暂停导演"}
            </button>
        </div>`;
}

/**
 * 判定流水：每拍一行「导演刚才干了什么」。
 *
 * 默认只露最近 3 拍（一打开就糊一屏反而没人看），要细究再展开——完整的原因明细在
 * 大纲窗的「导演诊断」里，这里只给一个"被拦 N 条"的汇总，免得游玩时被诊断信息淹掉。
 * 内容全走 describeDirectorTurn，与横条心跳同一个来源，两边永远不会说两套话。
 */
function buildDirectorFlow(info) {
    const log = Array.isArray(info.directorLog) ? info.directorLog : [];
    if (log.length === 0) return "";
    const rows = log.slice().reverse();
    const shown = bbFlowOpen ? rows : rows.slice(0, 3);
    const items = shown.map((e) => {
        const failed = e.turn === DIRECTOR_TURN.FAILED;
        const time = e.at ? new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
        const refused = Array.isArray(e.refused) ? e.refused.length : 0;
        return `<li class="tsa-bb-flow-row${failed ? " is-failed" : ""}">
            <span class="tsa-bb-flow-floor">${e.floor >= 0 ? `#${e.floor}` : "—"}</span>
            <span class="tsa-bb-flow-time">${escapeHtmlText(time)}</span>
            <span class="tsa-bb-flow-what">${escapeHtmlText(describeDirectorTurn(e))}</span>
            ${refused > 0 ? `<span class="tsa-bb-flow-refused">被拦 ${refused} 条</span>` : ""}
        </li>`;
    }).join("");
    const toggle = rows.length > 3
        ? `<button type="button" class="tsa-bb-flow-toggle" data-action="bb-flow-toggle">${bbFlowOpen ? "收起" : `展开全部 ${rows.length} 拍`}</button>`
        : "";
    return `<div class="tsa-bb-flow">
        <div class="tsa-bb-flow-head">导演流水<span class="tsa-bb-flow-sub">（判过了什么，不是剧情内容）</span></div>
        <ol class="tsa-bb-flow-list">${items}</ol>
        ${toggle}
    </div>`;
}

/** 推荐剧情体：预览 / 方案 / 进度 / 候选（可滚动）+ 底部操作条。原「剧情推进」排布。 */
function buildRecommendBody(state) {
    // 有行程单时按钮改口：这一批候选是"演当前这一步"的，不是"跳到下一条"的。
    const inTransition = !!(state.transition && state.transition.events.length > 0);
    const idleLabel = inTransition ? "推荐这一步的剧情" : "推荐剧情";
    const generateLabel = state.candidates.length > 0 ? "换一批" : idleLabel;
    return `
        <div class="tsa-scroll">
            ${buildPreviewHtml(state)}
            <div class="tsa-plan-row">
                <label class="tsa-plan-label">方案
                    <select class="tsa-plan-select" id="tsa-plan-select">${buildPlanOptions(state)}</select>
                </label>
            </div>
            ${buildProgressHtml(state)}
            ${buildTransitionHtml(state)}
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
    // 编辑中的行程单要先落盘（草稿在内存里，与 DOM 无关；但退出编辑的语义要一致）。
    // commitTransitionEditDraft 在第一个 await 之前就把 editing/draft 清掉了，
    // 所以这里不 await 也不会留下不一致的模块态。
    if (transitionEditing) void commitTransitionEditDraft();
    transitionOpen = false;      // 下次打开回到折叠态（和 previewOpen 一样）
    transitionEditing = false;
    // transitionDraft / transitionCount 刻意**不重置**：那是用户手打的过渡梗概，
    // 误关一次面板就清空太狠了（同 pacingDraft 的取舍）。行程单本身在 plan 上，更不受影响。

    $(`#${PANEL_ID}`).remove();
    expandedForMesid = null;
    previewItemIdx = -1;
    previewOpen = false;   // 下次打开回到折叠态
    panelMode = "recommend";   // 下次打开回到推荐剧情页（节奏诊断缓存保留，重开仍可见）
    bbStageOpenIdx = -1;   // 解锁界面回到"默认展开最近通关的那个阶段"
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

/** 点候选卡片：写入酒馆输入框 + 按模型给的位置回写进度 + 标记已写入。 */
async function onPickCandidate(index) {
    const api = await loadApi();
    const state = api.getSceneAdvanceState();
    const candidate = state.candidates[index];
    if (!candidate || !String(candidate.text || "").trim()) return;

    api.writeSceneToInput(candidate.text, api.getSceneInsertMode());
    if (state.planId) {
        if (candidate.stepIndex !== null && candidate.stepIndex !== undefined) {
            // 有行程单时，stepIndex 才是权威的推进量：候选的 item_index 一律停在当前条目，
            // 拿它去推指针只会原地打转（还会被跨段闸门夹住）。
            api.setSceneStep(state.planId, candidate.stepIndex);
        } else {
            // itemIndex 是 1-based 大纲序号，进度指针是 0-based
            api.applySceneProgress(state.planId, candidate.itemIndex - 1);
        }
        api.markSceneCandidateUsed(state.planId, index);
    }
    await refreshPanel();
}

/* ---- 过渡行程单 ---- */

/** 把草稿一次性落盘（brief 为空的空壳到这时才被清掉）并退出编辑态。 */
async function commitTransitionEditDraft() {
    const draft = transitionEditDraft;
    transitionEditing = false;
    transitionEditDraft = null;
    if (!Array.isArray(draft)) return;
    try {
        const api = await loadApi();
        const state = api.getSceneAdvanceState();
        if (state.planId) api.saveSceneTransitionEvents(state.planId, draft);
    } catch (e) {
        TitaniaLogger.warn("过渡行程单落盘失败", e?.message || String(e));
    }
}

/** 生成（或重掷）当前 gap 的过渡行程单。 */
async function onGenerateTransition(regen = false) {
    if (transitionGenerating) return;
    const api = await loadApi();
    const state = api.getSceneAdvanceState();

    // 重掷沿用上一版的梗概与条数——按"重新生成"是想换个排法，不是想重填表单。
    let brief;
    let count;
    if (regen && state.transition) {
        brief = state.transition.brief;
        count = state.transition.events.length || EVENT_COUNT_DEFAULT;
    } else {
        brief = String($("#tsa-transition-brief").val() ?? transitionDraft).trim();
        count = clampEventCount($("#tsa-transition-count").val() ?? transitionCount);
    }
    transitionDraft = brief;
    transitionCount = count;
    transitionGenerating = true;
    await refreshPanel();
    try {
        await api.generateSceneTransition({ brief, count });
    } catch (e) {
        TitaniaLogger.error("过渡行程单生成失败", e);
    } finally {
        transitionGenerating = false;
        // 只有真的排出来了才收起表单；失败（或用户在修复弹窗里取消）时保持展开，
        // 别把用户刚填的梗概一起收走。
        const after = api.getSceneAdvanceState();
        if (after.transition && after.transition.events.length > 0) transitionOpen = false;
        await refreshPanel();
    }
}

/**
 * 点某一步：**定位**，不是发送。
 * brief 是面向作者的梗概体，不是可直接发送的玩家输入；这里只把这一步设为"当前要演的"，
 * 并清掉上一步遗留的候选（它们已经过期，留着点了会推进到错误的步）。
 */
async function onPickStep(stepIndex) {
    await commitTransitionEditDraft();
    const api = await loadApi();
    const state = api.getSceneAdvanceState();
    if (!state.planId || !state.transition) return;
    if (state.transition.cursor === stepIndex) return;
    api.clearSceneCandidates(state.planId);
    api.setSceneStep(state.planId, stepIndex);
    await refreshPanel();
}

/** 跨到下一个大纲条目。行程单没走完时＝跳过剩下几步，所以要问一句。 */
async function onCrossGap() {
    await commitTransitionEditDraft();
    const api = await loadApi();
    const state = api.getSceneAdvanceState();
    if (!state.planId) return;
    const left = state.transition && !state.transitionDone
        ? state.transition.events.length - state.transition.cursor
        : 0;
    if (left > 0 && !window.confirm(`还有 ${left} 步过渡没走，确定跳过它们、直接进入下一条大纲？`)) return;
    api.clearSceneCandidates(state.planId);
    api.crossSceneGap(state.planId);
    await refreshPanel();
}

/** 进出编辑态。进入时拷贝一份草稿，退出时一次性落盘。 */
async function onToggleTransitionEdit() {
    if (transitionEditing) {
        await commitTransitionEditDraft();
    } else {
        const api = await loadApi();
        const state = api.getSceneAdvanceState();
        if (!state.transition) return;
        transitionEditing = true;
        transitionEditDraft = state.transition.events.map(e => ({ ...e }));
    }
    await refreshPanel();
}

/**
 * 编辑操作：改草稿 → 重绘。**刻意不落盘**——落盘在退出编辑时（见 transitionEditDraft）。
 * 文字输入由下面那个 input 处理器实时写进草稿，所以这里不必再去 DOM 里捞一遍，
 * 也就不会出现"改完字直接点完成编辑、刚打的字没了"这种丢字。
 */
async function mutateTransitionDraft(mutator) {
    if (!Array.isArray(transitionEditDraft)) return;
    transitionEditDraft = mutator(transitionEditDraft.map(e => ({ ...e })));
    await refreshPanel();
}

/** 交换数组两项（上移/下移用）。纯函数，不改入参。 */
function swapAt(list, a, b) {
    const next = list.slice();
    const tmp = next[a];
    next[a] = next[b];
    next[b] = tmp;
    return next;
}

async function onDropTransition() {
    const api = await loadApi();
    const state = api.getSceneAdvanceState();
    if (!state.planId) return;
    if (!window.confirm("删除这一段的过渡行程单？剧情推进将退回按大纲条目直接推进。")) return;
    transitionEditing = false;
    transitionEditDraft = null;
    api.clearSceneTransition(state.planId);
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

    /* ---- 过渡行程单 ---- */
    // 注：面板内所有点击已由本函数末尾那个裸 click 处理器统一 stopPropagation，
    //     这里不必再逐个拦 ST 的 .mes 处理器。

    $panel.on("click", ".tsa-transition-toggle", async function () {
        transitionOpen = !transitionOpen;
        await refreshPanel();
    });
    // 表单草稿：只同步变量、**不重绘**——重绘会把焦点和光标位置一起冲掉（同 #tsa-pacing-directive）。
    $panel.on("input", "#tsa-transition-brief", function () {
        transitionDraft = String($(this).val() || "");
    });
    $panel.on("change", "#tsa-transition-count", function () {
        transitionCount = clampEventCount($(this).val());
    });
    $panel.on("click", "#tsa-transition-gen", () => onGenerateTransition(false));
    $panel.on("click", "#tsa-transition-regen", () => onGenerateTransition(true));
    $panel.on("click", "#tsa-transition-drop", () => onDropTransition());
    // 点某一步 = 定位（不写输入框）。见 buildTransitionHtml 的注释。
    $panel.on("click", ".tsa-transition-step:not(.is-editing)", function () {
        return onPickStep(Number($(this).data("step-idx")));
    });
    $panel.on("click", ".tsa-transition-final", () => onCrossGap());
    $panel.on("click", "#tsa-transition-edit-toggle", () => onToggleTransitionEdit());

    $panel.on("click", ".tsa-transition-up", function () {
        const i = Number($(this).data("step-idx"));
        return mutateTransitionDraft(list => (i > 0 ? swapAt(list, i, i - 1) : list));
    });
    $panel.on("click", ".tsa-transition-down", function () {
        const i = Number($(this).data("step-idx"));
        return mutateTransitionDraft(list => (i >= 0 && i < list.length - 1 ? swapAt(list, i, i + 1) : list));
    });
    $panel.on("click", ".tsa-transition-del", function () {
        const i = Number($(this).data("step-idx"));
        return mutateTransitionDraft(list => list.filter((_, idx) => idx !== i));
    });
    $panel.on("click", "#tsa-transition-add", () => mutateTransitionDraft(list => [...list, { title: "", span: "", brief: "" }]));

    // 编辑框：**输入即写草稿**，只同步变量、不重绘（重绘会丢焦点与光标位置）。
    // 之所以不能等到"失焦再捞 DOM"：用户改完字直接点「完成编辑」或终点行时不会再触发
    // 一次读取，刚打的字就没了——这是这套交互最容易踩的一个坑。
    $panel.on("input", ".tsa-transition-edit-title, .tsa-transition-edit-span, .tsa-transition-edit-brief", function () {
        if (!Array.isArray(transitionEditDraft)) return;
        const i = Number($(this).data("step-idx"));
        const field = String($(this).data("field") || "");
        if (!transitionEditDraft[i] || !field) return;
        transitionEditDraft[i] = { ...transitionEditDraft[i], [field]: String($(this).val() || "") };
    });

    // 盲盒导演：暂停 / 恢复
    $panel.on("click", "#tsa-bb-pause", async function () {
        const info = getActiveBlindboxInfo();
        if (!info) return;
        toggleBlindboxDirectorPaused(info.planId);
        const strip = getStrip();
        if (strip) updateStrip(strip);
        await refreshPanel();
    });

    // 音量循环：关 → 轻 → 中 → 响 → 关。每切一档当场试听一下（等于把"试听"并进这个按钮）。
    $panel.on("click", "#tsa-bb-sound", async function () {
        const next = cycleUnlockVolume();
        if (next.enabled !== false && next.volume > 0) playUnlockCue("event", { config: next });
        await refreshPanel();
    });

    // 已通关阶段：点表头折叠/展开（-2 表示全部收起，见 buildBlindboxBody 的 openIdx 约定）
    const toggleStage = async function () {
        const $stage = $(this).closest(".tsa-bb-stage");
        const idx = Number($stage.data("stage-idx"));
        if (!Number.isFinite(idx)) return;
        const isOpen = $stage.find(".tsa-bb-stage-head").attr("aria-expanded") === "true";
        bbStageOpenIdx = isOpen ? -2 : idx;
        await refreshPanel();
    };
    $panel.on("click", ".tsa-bb-stage.is-cleared > .tsa-bb-stage-head", toggleStage);
    $panel.on("keydown", ".tsa-bb-stage.is-cleared > .tsa-bb-stage-head", function (event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggleStage.call(this);
    });

    $panel.on("click", ".tsa-item", function () {
        onPickCandidate(Number($(this).data("candidate-index")));
    });

    // 判定流水展开/收起（只改这一处显示偏好，不重跑判定）
    $panel.on("click", "[data-action='bb-flow-toggle']", async () => {
        bbFlowOpen = !bbFlowOpen;
        await refreshPanel();
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
