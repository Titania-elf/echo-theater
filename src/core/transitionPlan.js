// src/core/transitionPlan.js
//
// 「过渡行程单」的纯数据层：规范化 / 查询 / 给提示词的上下文文本。
//
// 背景：普通大纲的条目是粗粒度的（条目1"开场当晚"、条目2"一周后"），条目之间没有任何结构，
// 于是剧情推进的候选除了写"一周后……"无路可走。本模块给**相邻两条之间的那段 gap** 挂一份
// 有序的过渡事件清单（行程单），推荐剧情的锚点就从"大纲第 N 条"变成"过渡段第 K 步"。
// 这是把盲盒模式那层"垫脚石"（nodes[].events[]）搬到普通大纲模式。
//
// ⚠ 一步不是一句话：它是要用好几拍才演完的一小段。候选的职责是**从最新一层回复的末态
//   往下续演这一步**，不是把这一步的 brief 复述一遍（v1.8 起在提示词里明写，见下）。
//
// 纯模块：不 import 任何宿主（ST）模块，故可被单测直接 import（同 blindboxPlan.js）。

/** 生成时的事件数量：默认 4，夹在 1~10（对齐 blindboxPlan 的 clampEventsPerGap 风格）。 */
export const EVENT_COUNT_DEFAULT = 4;
export const EVENT_COUNT_MIN = 1;
export const EVENT_COUNT_MAX = 10;

/** 手改时的事件条数上限（生成侧另有 clampEventCount，这里只防手抖刷爆）。 */
const MAX_EVENTS = 20;

const TITLE_MAX = 40;
const SPAN_MAX = 60;
const EVENT_BRIEF_MAX = 300;
const GAP_BRIEF_MAX = 600;
/** fromIndex 的夹紧上界。真实大纲条目数远小于它，这里只是防脏数据。 */
const INDEX_MAX = 9999;

const clampInt = (v, lo, hi, dflt) => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
};

const str = (v) => (typeof v === "string" ? v : "");
const trimmed = (v) => str(v).trim();

/** 生成时的事件数量。坏值回默认，不抛错。 */
export function clampEventCount(v) {
    return clampInt(v, EVENT_COUNT_MIN, EVENT_COUNT_MAX, EVENT_COUNT_DEFAULT);
}

function normalizeEvent(raw) {
    // 模型回的是 {title, span, brief}；content 是别名兜底（沿用盲盒事件里 content 的叫法）。
    return {
        title: trimmed(raw?.title).slice(0, TITLE_MAX),
        // span：本步相对上一拍的时间跨度标记（"两天后"/"周末"）。它把"一周"切成可感知的刻度，
        // 正是治"没有过渡"的那味药——所以它是一等字段，不是附注。
        span: trimmed(raw?.span).slice(0, SPAN_MAX),
        brief: trimmed(raw?.brief ?? raw?.content).slice(0, EVENT_BRIEF_MAX),
    };
}

/** 事件数组：洗掉没有 brief 的空壳（brief 是这条事件唯一的实质内容），限条数。 */
function normalizeEvents(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .map(normalizeEvent)
        .filter((e) => e.brief)
        .slice(0, MAX_EVENTS);
}

/**
 * 规范化一段行程单。缺字段给安全默认，坏类型被洗掉，不抛错。
 *
 * ⚠ 这是个**白名单式**对象字面量：没写进这里的字段会在落盘时被悄悄洗掉
 *   （blindboxPlan.normalizeBlindbox 就栽过这个跟头，见 docs/盲盒剧本-导演模式-方案.md §9.4）。
 *   新增任何运行态字段都必须同步补进来，并补一条 round-trip 单测。
 */
export function normalizeTransition(raw) {
    const t = raw && typeof raw === "object" ? raw : {};
    const events = normalizeEvents(t.events);
    return {
        // fromIndex：本段过渡的起点大纲条目下标（0-based）。toIndex 恒为 fromIndex + 1，
        // 故不单独存——存了就有两个真相来源，大纲一改就打架。
        fromIndex: clampInt(t.fromIndex, 0, INDEX_MAX, 0),
        brief: trimmed(t.brief).slice(0, GAP_BRIEF_MAX),
        events,
        // cursor：已走完的事件数，0..events.length。cursor === events.length 即整段走完。
        // 夹紧到 events.length 很关键——用户删掉几步之后，旧 cursor 不能悬空。
        cursor: clampInt(t.cursor, 0, events.length, 0),
        generatedAt: Number(t.generatedAt) || 0,
    };
}

/** 规范化整张表。同一 fromIndex 只留**最后一条**（重掷是覆盖语义），并按 fromIndex 排序。 */
export function normalizeTransitions(raw) {
    if (!Array.isArray(raw)) return [];
    const byIndex = new Map();
    for (const item of raw) {
        const t = normalizeTransition(item);
        byIndex.set(t.fromIndex, t); // 后写覆盖先写
    }
    return [...byIndex.values()].sort((a, b) => a.fromIndex - b.fromIndex);
}

/** 按 fromIndex 取本段的行程单；没有则 null。 */
export function getTransitionFor(transitions, fromIndex) {
    const idx = clampInt(fromIndex, 0, INDEX_MAX, 0);
    return normalizeTransitions(transitions).find((t) => t.fromIndex === idx) || null;
}

/**
 * 当前进度所在 gap 的行程单（激活判定）。
 * itemIndex 一旦走到 fromIndex + 1，本段自动失活——不需要显式归档；
 * 回退到 fromIndex 时又会自动复活，且 cursor 原样保留（这是白送的好处，别改）。
 */
export function getActiveTransition(plan, itemIndex) {
    return getTransitionFor(plan?.transitions, itemIndex);
}

/** 覆盖写入一段（按 fromIndex upsert），返回新的整表。纯函数，不改入参。 */
export function upsertTransition(transitions, transition) {
    const next = normalizeTransition(transition);
    const list = normalizeTransitions(transitions).filter((t) => t.fromIndex !== next.fromIndex);
    list.push(next);
    list.sort((a, b) => a.fromIndex - b.fromIndex);
    return list;
}

/** 删掉某段的行程单，返回新的整表。 */
export function dropTransition(transitions, fromIndex) {
    const idx = clampInt(fromIndex, 0, INDEX_MAX, 0);
    return normalizeTransitions(transitions).filter((t) => t.fromIndex !== idx);
}

/**
 * 行程单是否已走完（可以跨到下一条了）。空行程单视为走完——没有台阶就不该拦路。
 */
export function isTransitionDone(transition) {
    const t = normalizeTransition(transition);
    if (t.events.length === 0) return true;
    return t.cursor >= t.events.length;
}

/** 当前该演的那一步；已走完返回 null。 */
export function getCurrentStep(transition) {
    const t = normalizeTransition(transition);
    if (t.cursor >= t.events.length) return null;
    return { index: t.cursor, event: t.events[t.cursor] };
}

/**
 * 把 cursor 定位到 stepIndex（0..events.length）。
 * 刻意**可进可退**、直接赋值——与 applyProgressFromModel 那句"可进可退、判断权交给模型"的
 * 既定设计一致。该夹的是"跨段"（见 storyOutlineWindow 的闸门），不是段内推进。
 */
export function clampCursor(transition, stepIndex) {
    const t = normalizeTransition(transition);
    return clampInt(stepIndex, 0, t.events.length, t.cursor);
}

/* ------------------------------------------------------------------ *
 * 喂给提示词的上下文文本
 * ------------------------------------------------------------------ */

/** 大纲条目的一行标签：`第 2 条「标题」（一周后）`。 */
function itemLabel(item, fallbackIndex) {
    if (!item) return `第 ${fallbackIndex + 1} 条（未知条目）`;
    const n = Number.isFinite(Number(item.index)) ? Number(item.index) : fallbackIndex + 1;
    const title = trimmed(item.title) || "未命名";
    const time = trimmed(item.time);
    return `第 ${n} 条「${title}」${time ? `（${time}）` : ""}`;
}

/**
 * 组装 `{{transitionContext}}`——喂给 rolling 模板的行程单上下文。
 *
 * 不存在行程单时返回空串（buildPromptTemplateVars 会把它换成占位串）。
 *
 * ⚠ 这里刻意把这一步说成**去向**、并点明"它的开头可能已经演过了"（v1.8）。旧措辞是
 *   "本回合至多把这一步演完"，配上 brief 本身就是一段完整梗概，模型只能把它扩写一遍——
 *   用户看到的候选永远在围绕这一步打转，而不是接着最新一层回复往下演。step_index 那句
 *   也一样写死成祈使句：这个字段最容易填错，让模型从文本照抄比让它自己推更稳。
 *
 * @param {object} transition 已规范化的行程单（未规范化也能吃，内部会过一遍）
 * @param {Array} items 大纲条目（normalizeItems 的形状：{index,time,title,plot,...}）
 */
export function buildTransitionContextText(transition, items = []) {
    const t = normalizeTransition(transition);
    if (t.events.length === 0) return "";

    const list = Array.isArray(items) ? items : [];
    const fromIdx = t.fromIndex;
    const toIdx = fromIdx + 1;
    const fromLabel = itemLabel(list[fromIdx], fromIdx);
    const toLabel = itemLabel(list[toIdx], toIdx);

    const lines = t.events.map((e, i) => {
        const mark = i < t.cursor ? "[已走完]" : i === t.cursor ? "[当前这一步]" : "";
        const span = e.span ? `（${e.span}）` : "";
        return `${mark}${i + 1}. ${e.title ? `${e.title}${span} —— ` : ""}${e.brief}`;
    });

    const head = [
        `本段过渡：${fromLabel} → ${toLabel}`,
        t.brief ? `本段的用意：${t.brief}` : "",
        "",
        `行程单（有序，必须按序推进，共 ${t.events.length} 步）：`,
        ...lines
    ].filter((s) => s !== "").join("\n");

    const tail = isTransitionDone(t)
        ? `\n当前进度：${t.events.length} / ${t.events.length} 步已全部走完——本段过渡已收束，`
            + `本回合的候选可以把故事推进到 ${toLabel}（item_index 填 ${toIdx + 1}，step_index 填 ${t.events.length}）。`
        : `\n当前进度：已走完 ${t.cursor} / ${t.events.length} 步，**当前这一步**是第 ${t.cursor + 1} 步。`
            + `\n这一步是**去向**，不是要你复述的内容——它的开头很可能已经在[最新一层回复]里演过了：`
            + `先看那一步演到哪了，候选就从那里**往下续演**。不要重演开头，也不要把它的梗概换个说法重写一遍。`
            + `\n本回合该填的 step_index，按[最新一层回复]里的实际进度定（一次至多前进 1 步，不许一跳到底）：`
            + `\n  · 还在这一步之内再演一拍（这一步还没演完）→ 填 ${t.cursor}；`
            + `\n  · 本回合把这一步演完 → 填 ${t.cursor + 1}；`
            + `\n  · [最新一层回复]显示这一步其实已经演完、候选因此带向下一步 → 填 ${t.cursor + 1}。`
            + `\n⛔ item_index 一律填 ${fromIdx + 1}（当前所在条目），**不得越过本段过渡**。`;

    return head + tail;
}
