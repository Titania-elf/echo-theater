// src/core/blindboxPlan.js
//
// 「盲盒剧本」的数据模型 ＋ 导演状态机——纯逻辑，不碰 ST 宿主、不碰 extData，方便单元测试。
//
// 普通方案（kind 缺省 / 'normal'）用平铺的 plan.items（{time,title,plot,foreshadowing}）；
// 盲盒方案（kind='blindbox'）另存一份 plan.blindbox，结构是两层：
//
//   节点[]（硬锚 / 必达里程碑） → 每个节点下挂若干关键事件（软垫脚石）
//
// 封印是「对用户」封印：这些内容照常落在 extData 里（后台判定模型要读），
// 但前端一切展示都要先问 isSealed() —— 封着就只给骨架/进度点，不给明文。
// 详见 docs/盲盒剧本-导演模式-方案.md。
//
// ── v2：判定严格度与时间尺度（方案第 9 节）──
// 事件从「一句 content」升级为「content ＋ done_when 成立条件 ＋ span 时间跨度 ＋ beats 拍数预算」：
// 靶子可验证了，判定才可能不随便。导演回报也从 done/skipped 二选一扩成三档
// （progress＝这一拍在推进但没达成），并要求 evidence ＋ evidence_floor ＋ criteria_met。
// **提示词管不住的部分一律由 applyDirectorDecision 的代码闸门兜**（每回合 done 配额、
// 目标指针单调、跨节点双钥匙、停留预算、旧正文不算新证据），见下方 STRICTNESS。

export const BLINDBOX_KIND = "blindbox";

/** 每段（两节点之间）关键事件数的上下限，下单输入框据此夹紧。 */
export const EVENTS_PER_GAP_MIN = 3;
export const EVENTS_PER_GAP_MAX = 10;
/** 节点数的合法范围与默认值。 */
export const NODE_COUNT_MIN = 2;
export const NODE_COUNT_MAX = 20;
export const NODE_COUNT_DEFAULT = 4;

/** 单个事件的停留拍数预算上限（0＝骨架没给预算，退化成不设下限）。 */
export const BEATS_MAX = 20;
/** 每个事件最多留几条「推进中」笔记，滚动丢最旧的。 */
export const MAX_EVENT_NOTES = 3;
/** 解锁播报账本的标记上限，滚动丢最旧的（20 节点 × 10 事件也才 200 条 + 20 个阶段）。 */
export const MAX_REVEAL_MARKS = 300;

/**
 * 解锁标记。事件与阶段共用一套前缀命名，于是「已播报（音效用）」与「已揭晓（面板动画用）」
 * 各占一张表就够，而不是四张：
 *   "e:2.1" = 节点 2 的第 1 个事件；"s:2" = 节点 2 这个阶段。
 * 用索引串而非事件 id：短、存档里一眼能读、且封印后的盲盒事件不会重排。
 */
export const eventMark = (nodeIndex, eventIndex) => `e:${nodeIndex}.${eventIndex}`;
export const stageMark = (nodeIndex) => `s:${nodeIndex}`;
const REVEAL_MARK_RE = /^[es]:\d+(\.\d+)?$/;

/** 事件是否"翻过去了"。导出给 blindboxReveal 用——两处各写一份迟早会分岔，而分岔就是泄题。 */
export function isEventPassed(ev) {
    return ev?.status === EVENT_STATUS.DONE || ev?.status === EVENT_STATUS.SKIPPED;
}

function normalizeRevealMarks(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    raw.forEach((v) => {
        const mark = trimmed(v);
        if (!REVEAL_MARK_RE.test(mark) || seen.has(mark)) return;
        seen.add(mark);
        out.push(mark);
    });
    return out.slice(-MAX_REVEAL_MARKS);
}

/** 把新标记并进已有列表：去重、丢掉不合规的、封顶。返回新数组（不改原数组）。 */
export function addRevealMarks(list, marks) {
    const seen = new Set(Array.isArray(list) ? list : []);
    const out = [...seen];
    (Array.isArray(marks) ? marks : []).forEach((v) => {
        const mark = trimmed(v);
        if (!REVEAL_MARK_RE.test(mark) || seen.has(mark)) return;
        seen.add(mark);
        out.push(mark);
    });
    return out.slice(-MAX_REVEAL_MARKS);
}
/** 判定流水最多留几条——够覆盖一轮反复 swipe 的回滚即可。 */
export const MAX_JOURNAL = 40;

/**
 * 「导演日志」最多留几条。这是**给人看**的判定流水（横条心跳 + 面板里那张表）。
 *
 * ⚠ 它和 journal 是两本账，**别合并**：
 *   · journal 是**回滚账本**——swipe 撤回时要按它还原事件状态，只记"真改了状态"的那几拍；
 *   · directorLog 每拍都记一条，包括"判过了但没出手"和"判定压根失败"。
 *     失败那拍根本不调 applyDirectorDecision，若把失败条目混进 journal，
 *     rollbackJournalFrom 结尾那句「lastJudged 取 journal 末条」会把 lastJudged
 *     推到一段其实没判过的正文上，next 拍的 sinceFloor 就错了（新证据被判成旧证据）。
 */
export const MAX_DIRECTOR_LOG = 40;

/** 本拍判定的结果档。这是**给人看的分类**，不是事件状态机的一部分。 */
export const DIRECTOR_TURN = Object.freeze({
    NOOP: "noop",          // 判完了，模型选择不动（当前目标照样涨一拍停留）
    ADVANCED: "advanced",  // 放行了 done / skipped，往前走了一步
    FAILED: "failed",      // 判定没跑成：API 报错，或返回无法解析
});

/** 关键事件状态：未到 / 进行中 / 已达成 / 已跳过。 */
export const EVENT_STATUS = Object.freeze({
    PENDING: "pending",
    ACTIVE: "active",
    DONE: "done",
    SKIPPED: "skipped",
});
const VALID_STATUS = new Set(Object.values(EVENT_STATUS));
const isPassed = (ev) => ev?.status === EVENT_STATUS.DONE || ev?.status === EVENT_STATUS.SKIPPED;

/**
 * 导演回报的事件进展。done/skipped 消耗事件，progress 只记一笔笔记、不消耗——
 * 这是 v2 最关键的一档：老版本只有 done/skipped，模型想说「在推进但没达成」时
 * 唯一的出口就是 done，判定自然松。
 */
export const UPDATE_KIND = Object.freeze({ DONE: "done", SKIPPED: "skipped", PROGRESS: "progress" });

/** 跳过理由枚举。标准/严格档下没给理由的 skipped 会被降级成 progress，防止拿 skipped 当快速通道。 */
export const SKIP_REASONS = Object.freeze({ MOOT: "moot", SUPERSEDED: "superseded", REFUSED: "refused" });
const VALID_SKIP_REASON = new Set(Object.values(SKIP_REASONS));

/** 判定严格度。loose＝v1 老行为（模型说啥就是啥），standard＝默认，strict＝宁可慢一拍。 */
export const STRICTNESS = Object.freeze({ LOOSE: "loose", STANDARD: "standard", STRICT: "strict" });
const VALID_STRICTNESS = new Set(Object.values(STRICTNESS));

/** 方案类型。缺省或非 blindbox 一律当普通方案——老方案没有 kind 字段，天然归为 normal。 */
export function getPlanKind(plan) {
    return plan && plan.kind === BLINDBOX_KIND ? BLINDBOX_KIND : "normal";
}

export function isBlindboxPlan(plan) {
    return getPlanKind(plan) === BLINDBOX_KIND;
}

/** 对用户是否仍封印：盲盒 + 已封印 + 未走剧透逃生。 */
export function isSealed(plan) {
    if (!isBlindboxPlan(plan)) return false;
    const bb = plan.blindbox;
    return !!bb && bb.sealed === true && bb.unsealed !== true;
}

const clampInt = (v, lo, hi, dflt) => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
};

export function clampNodeCount(v) {
    return clampInt(v, NODE_COUNT_MIN, NODE_COUNT_MAX, NODE_COUNT_DEFAULT);
}

export function clampEventsPerGap(v) {
    return clampInt(v, EVENTS_PER_GAP_MIN, EVENTS_PER_GAP_MAX, EVENTS_PER_GAP_MIN);
}

export function normalizeStrictness(v) {
    return VALID_STRICTNESS.has(v) ? v : STRICTNESS.STANDARD;
}

const str = (v) => (typeof v === "string" ? v : "");
const trimmed = (v) => str(v).trim();
let seq = 0;
const genId = (prefix) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** 字符串数组：洗掉空值、去头尾空白、限长限条数。done_when / anchor_when / notes 都走它。 */
function normalizeStrList(raw, maxItems = 5, maxLen = 200) {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((s) => trimmed(s).slice(0, maxLen))
        .filter(Boolean)
        .slice(0, maxItems);
}

function normalizeEvent(raw) {
    const status = VALID_STATUS.has(raw?.status) ? raw.status : EVENT_STATUS.PENDING;
    return {
        id: str(raw?.id) || genId("ev"),
        content: str(raw?.content),
        // ── v2 骨架字段（模型回的是 snake_case；老存档两者都没有 → 空值退化成 v1 行为）──
        // doneWhen：1~3 条可在正文里被指认的成立条件。靶子软，判定就必然松，这是治本的一条。
        doneWhen: normalizeStrList(raw?.doneWhen ?? raw?.done_when, 5, 200),
        // span：本事件相对上一拍的时间跨度标记（"三天后"/"两周后"），导演据此要求正文做时间推移。
        span: trimmed(raw?.span).slice(0, 60),
        // beats：这个事件至少该占几条回复。停留预算不足时 done 会被降级（见 applyDirectorDecision）。
        beats: clampInt(raw?.beats, 0, BEATS_MAX, 0),
        status,
        // turns：这个事件作为「当前目标」已经被判定过几拍。由代码累加，不信模型自报。
        turns: clampInt(raw?.turns, 0, 9999, 0),
        // notes：导演回报 progress（或 done 被闸门降级）时留下的推进笔记，滚动保留最近几条。
        notes: normalizeStrList(raw?.notes, MAX_EVENT_NOTES, 200),
        // 导演把事件判成 done/skipped 时留下的一句「实际怎么发生的」回顾。
        // 这是导演私有的 durable 记忆：不随聊天楼层被总结/隐藏而消失，判定时随骨架一起回灌，
        // 让导演即便读不到最近正文也知道这拍已经翻过去了（见方案第 5 节 A+B）。
        recap: str(raw?.recap),
        skipReason: VALID_SKIP_REASON.has(raw?.skipReason) ? raw.skipReason : "",
    };
}

function normalizeNode(raw) {
    const events = Array.isArray(raw?.events) ? raw.events.map(normalizeEvent) : [];
    return {
        id: str(raw?.id) || genId("nd"),
        title: str(raw?.title),
        anchor: str(raw?.anchor),
        // anchorWhen：节点硬锚的成立条件。跨节点要双钥匙（见 applyDirectorDecision 第 ④ 步）。
        anchorWhen: normalizeStrList(raw?.anchorWhen ?? raw?.anchor_when, 5, 200),
        // span：本节点覆盖多长时间（"约两个月"）。生成侧据此拉开节点之间的时间跨度。
        span: trimmed(raw?.span).slice(0, 60),
        events,
    };
}

function normalizeProgress(raw, nodes) {
    const nodeCount = nodes.length;
    const nodeIndex = clampInt(raw?.nodeIndex, 0, Math.max(0, nodeCount - 1), 0);
    const evCount = nodes[nodeIndex] ? nodes[nodeIndex].events.length : 0;
    const eventIndex = clampInt(raw?.eventIndex, 0, Math.max(0, evCount - 1), 0);
    // awaitingAnchor：本节点事件都翻过了，但硬锚还没兑现 —— 指针卡在节点末尾等 anchor_met。
    return { nodeIndex, eventIndex, awaitingAnchor: raw?.awaitingAnchor === true };
}

function normalizeLastJudged(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const floor = Math.floor(Number(r.floor));
    return {
        floor: Number.isFinite(floor) && floor >= 0 ? floor : -1,
        swipeId: str(r.swipeId),
        sig: str(r.sig),
        at: Number(r.at) || 0,
    };
}

function normalizeJournalEntry(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const floor = Math.floor(Number(r.floor));
    const changes = (Array.isArray(r.changes) ? r.changes : [])
        .map((c) => ({
            node: Math.floor(Number(c?.node)),
            event: Math.floor(Number(c?.event)),
            prevStatus: VALID_STATUS.has(c?.prevStatus) ? c.prevStatus : EVENT_STATUS.PENDING,
            prevRecap: str(c?.prevRecap),
            prevTurns: clampInt(c?.prevTurns, 0, 9999, 0),
            prevSkipReason: VALID_SKIP_REASON.has(c?.prevSkipReason) ? c.prevSkipReason : "",
        }))
        .filter((c) => Number.isFinite(c.node) && Number.isFinite(c.event));
    const d = r.dwell && typeof r.dwell === "object"
        ? {
            node: Math.floor(Number(r.dwell.node)),
            event: Math.floor(Number(r.dwell.event)),
            prevTurns: clampInt(r.dwell.prevTurns, 0, 9999, 0),
        }
        : null;
    return {
        floor: Number.isFinite(floor) ? floor : -1,
        swipeId: str(r.swipeId),
        at: Number(r.at) || 0,
        changes,
        dwell: d && Number.isFinite(d.node) && Number.isFinite(d.event) ? d : null,
        prevProgress: r.prevProgress && typeof r.prevProgress === "object"
            ? {
                nodeIndex: clampInt(r.prevProgress.nodeIndex, 0, 9999, 0),
                eventIndex: clampInt(r.prevProgress.eventIndex, 0, 9999, 0),
                awaitingAnchor: r.prevProgress.awaitingAnchor === true,
            }
            : null,
    };
}

/** 事件下标引用（节点.事件）。非法的一律返回 null，由调用方 filter 掉。 */
function normalizeRef(raw) {
    const node = Math.floor(Number(raw?.node));
    const event = Math.floor(Number(raw?.event));
    if (!Number.isFinite(node) || node < 0) return null;
    if (!Number.isFinite(event) || event < 0) return null;
    return { node, event };
}

/**
 * 一条导演日志。
 *
 * ⚠ **只有状态与下标，永远不含内容**：它要显示在横条与面板上，而界面上"未解锁"的东西
 * 必须零剧透（见 blindboxReveal.js 那道铁律）。所以这里连 evidence / recap / 事件正文
 * 都不收；被拦原因也只收抽象码（why），不收模型原文——原文里可能带着骨架内容。
 */
function normalizeDirectorLogEntry(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const floor = Math.floor(Number(r.floor));
    const advanced = (Array.isArray(r.advanced) ? r.advanced : [])
        .map((a) => {
            const ref = normalizeRef(a);
            if (!ref) return null;
            return { ...ref, status: VALID_STATUS.has(a?.status) ? a.status : EVENT_STATUS.DONE };
        })
        .filter(Boolean)
        .slice(0, 8);
    const refused = (Array.isArray(r.refused) ? r.refused : [])
        .map((a) => {
            const ref = normalizeRef(a);
            const why = trimmed(a?.why);
            if (!ref || !why) return null;
            return { ...ref, why };
        })
        .filter(Boolean)
        .slice(0, 8);
    const turns = Math.floor(Number(r.dwell?.turns));
    const beats = Math.floor(Number(r.dwell?.beats));
    return {
        floor: Number.isFinite(floor) && floor >= 0 ? floor : -1,
        swipeId: str(r.swipeId),
        at: Number(r.at) || 0,
        turn: Object.values(DIRECTOR_TURN).includes(r.turn) ? r.turn : DIRECTOR_TURN.NOOP,
        // 实际出手的力度（含代码兜底补的时间推移那一句）。
        spoke: VALID_INTENSITY.has(r.spoke) ? r.spoke : DIRECTOR_INTENSITY.NONE,
        advanced,
        refused,
        failure: r.failure === "parse" || r.failure === "api" ? r.failure : "",
        dwell: {
            turns: Number.isFinite(turns) && turns > 0 ? turns : 0,
            beats: Number.isFinite(beats) && beats > 0 ? beats : 0,
        },
    };
}

/** 往导演日志尾部追加一条（封顶 MAX_DIRECTOR_LOG）。返回新对象，不改原对象。 */
export function appendDirectorLog(blindbox, entry) {
    const bb = normalizeBlindbox(blindbox);
    bb.directorLog = [...bb.directorLog, normalizeDirectorLogEntry(entry)].slice(-MAX_DIRECTOR_LOG);
    return bb;
}

/**
 * 规范化整个 blindbox 对象。缺字段给安全默认，坏类型被洗掉，不抛错。
 * ⚠ 这是个**白名单式**对象字面量：没写进这里的字段会在落盘时被悄悄洗掉
 *   （v1 的 directorPaused 就栽在这儿）。新增任何运行态字段都必须同步补进来。
 */
export function normalizeBlindbox(raw) {
    const bb = raw && typeof raw === "object" ? raw : {};
    const nodes = Array.isArray(bb.nodes) ? bb.nodes.map(normalizeNode) : [];
    const journal = (Array.isArray(bb.journal) ? bb.journal : []).map(normalizeJournalEntry).slice(-MAX_JOURNAL);
    const directorLog = (Array.isArray(bb.directorLog) ? bb.directorLog : [])
        .map(normalizeDirectorLogEntry)
        .slice(-MAX_DIRECTOR_LOG);
    return {
        tone: str(bb.tone),
        redlines: str(bb.redlines),
        nodeCount: clampNodeCount(bb.nodeCount),
        eventsPerGap: clampEventsPerGap(bb.eventsPerGap),
        // timescale：故事总时长（"约三年"/"跨越半生"）。生成侧据此分配 span，是时间跨度的总闸门。
        timescale: trimmed(bb.timescale).slice(0, 120),
        strictness: normalizeStrictness(bb.strictness),
        sealed: bb.sealed === true,
        unsealed: bb.unsealed === true,
        // 手动暂停导演。v1 没写进 normalize，判定落盘时会被洗掉（暂停只靠 undefined !== true 侥幸成立）。
        directorPaused: bb.directorPaused === true,
        generatedAt: Number(bb.generatedAt) || 0,
        nodes,
        progress: normalizeProgress(bb.progress, nodes),
        lastJudged: normalizeLastJudged(bb.lastJudged),
        journal,
        // 判定流水（给人看的那本账，与 journal 分工见 MAX_DIRECTOR_LOG 的注释）。
        directorLog,
        // 解锁播报账本（判定侧只写 announced，揭晓侧只写 viewed，见 blindboxReveal.js）。
        // marksReady=false ＝ 本功能上线前就存在的存档：首次接触时静默补记，否则一开面板
        // 会把陈年旧账一次性响一遍。
        announced: normalizeRevealMarks(bb.announced),
        viewed: normalizeRevealMarks(bb.viewed),
        marksReady: bb.marksReady === true,
    };
}

/** 下单时构造的「未生成」盲盒草稿：只有参数、还没有节点、尚未封印。 */
export function createBlindboxDraft({ tone, redlines, nodeCount, eventsPerGap, timescale, strictness } = {}) {
    return normalizeBlindbox({
        tone,
        redlines,
        nodeCount,
        eventsPerGap,
        timescale,
        strictness,
        sealed: false,
        unsealed: false,
        nodes: [],
    });
}

/** 生成完成：写入节点、封印、落生成时间、进度归零到第一个节点第一个事件。 */
export function sealWithNodes(blindbox, nodes) {
    const bb = normalizeBlindbox(blindbox);
    bb.nodes = Array.isArray(nodes) ? nodes.map(normalizeNode) : [];
    bb.sealed = true;
    bb.unsealed = false;
    bb.generatedAt = Date.now();
    bb.progress = normalizeProgress({ nodeIndex: 0, eventIndex: 0 }, bb.nodes);
    // 重掷一本等于重开：判定流水与「上次判到哪一楼」都要清，否则新本子一上来就被旧楼层挡住证据。
    bb.lastJudged = normalizeLastJudged(null);
    bb.journal = [];
    // 播报账本同理归零，并置 ready：全新的一本没有"陈年旧账"要静默补记。
    // ⚠ 不清的话，新本子沿用同一套下标，旧标记会把每一次解锁都吞掉——静默失效，最难查。
    bb.announced = [];
    bb.viewed = [];
    bb.marksReady = true;
    // 开局把第一个事件标为进行中。
    const first = bb.nodes[0]?.events?.[0];
    if (first && first.status === EVENT_STATUS.PENDING) first.status = EVENT_STATUS.ACTIVE;
    return bb;
}

/** 剧透逃生：单向解封，封回去没有意义（看过就看过了）。 */
export function unseal(blindbox) {
    const bb = normalizeBlindbox(blindbox);
    bb.unsealed = true;
    return bb;
}

/** 当前导演要往那里推的目标：{ nodeIndex, eventIndex, node, event }，没有则 null。 */
export function getCurrentTarget(blindbox) {
    const bb = normalizeBlindbox(blindbox);
    const node = bb.nodes[bb.progress.nodeIndex] || null;
    if (!node) return null;
    const event = node.events[bb.progress.eventIndex] || null;
    return { nodeIndex: bb.progress.nodeIndex, eventIndex: bb.progress.eventIndex, node, event };
}

/** 把两层结构摊平成一维序列，带回节点/事件下标，供进度点、回顾墙、判定遍历。 */
export function flattenEvents(blindbox) {
    const bb = normalizeBlindbox(blindbox);
    const out = [];
    bb.nodes.forEach((node, nodeIndex) => {
        node.events.forEach((event, eventIndex) => {
            out.push({ nodeIndex, eventIndex, node, event });
        });
    });
    return out;
}

/** 进度统计，供进度条/状态灯。done/skipped 都算「翻过去了」。 */
export function getProgressStats(blindbox) {
    const bb = normalizeBlindbox(blindbox);
    const flat = flattenEvents(bb);
    const total = flat.length;
    let done = 0;
    let skipped = 0;
    flat.forEach(({ event }) => {
        if (event.status === EVENT_STATUS.DONE) done += 1;
        else if (event.status === EVENT_STATUS.SKIPPED) skipped += 1;
    });
    const cur = getCurrentTarget(bb);
    return {
        total,
        done,
        skipped,
        passed: done + skipped,
        nodeCount: bb.nodes.length,
        // 停留信息不是剧情内容（它讲的是玩家自己打了几拍），封印态也能安全显示。
        dwellTurns: cur?.event?.turns || 0,
        dwellBeats: cur?.event?.beats || 0,
        awaitingAnchor: bb.progress.awaitingAnchor === true,
    };
}

/** 解封后复用普通方案表格展示：把两层摊平成 {time,title,plot,foreshadowing} 形状。 */
export function toVisibleItems(blindbox) {
    const bb = normalizeBlindbox(blindbox);
    const items = [];
    const label = (base, span) => (span ? `${base} · ${span}` : base);
    bb.nodes.forEach((node, i) => {
        items.push({
            time: label(`节点 ${i + 1}`, node.span),
            title: node.title,
            plot: node.anchor,
            foreshadowing: node.anchorWhen.join("；"),
        });
        node.events.forEach((ev, j) => {
            items.push({
                time: label(`${i + 1}.${j + 1}`, ev.span),
                title: "",
                plot: ev.content,
                foreshadowing: ev.doneWhen.join("；"),
            });
        });
    });
    return items;
}

/**
 * 从模型返回（已解析成对象）里抽出节点数组并规范化。
 * 只认顶层 nodes[]；缺了就抛错，交给上层走失败提示（绝不把原始明文弹给用户）。
 */
export function extractBlindboxNodes(data) {
    if (!data || !Array.isArray(data.nodes)) throw new Error("返回格式缺少 nodes 数组");
    const nodes = data.nodes.map(normalizeNode).filter((n) => n.events.length > 0 || n.title || n.anchor);
    if (nodes.length === 0) throw new Error("返回的 nodes 为空");
    return nodes;
}

/* ================================================================== *
 * 导演引擎的纯逻辑：判定响应解析 + 进度状态机（见方案第 5、9 节）
 * 注入/事件生命周期不在这里（那部分带宿主依赖，另立模块）。
 * ================================================================== */

/** 引导强度：none=本回合不出手（在线上就闭嘴），gentle=轻推，firm=临近节点收紧往回拉。 */
export const DIRECTOR_INTENSITY = Object.freeze({ NONE: "none", GENTLE: "gentle", FIRM: "firm" });
const VALID_INTENSITY = new Set(Object.values(DIRECTOR_INTENSITY));

/** 把模型回的 status 归一到三档。认别名，认不出的一律当 progress（最保守的一档）。 */
function normalizeUpdateKind(v) {
    const s = trimmed(v).toLowerCase();
    if (s === UPDATE_KIND.DONE) return UPDATE_KIND.DONE;
    if (s === UPDATE_KIND.SKIPPED || s === "skip") return UPDATE_KIND.SKIPPED;
    return UPDATE_KIND.PROGRESS;
}

function normalizeSkipReason(v) {
    const s = trimmed(v).toLowerCase();
    return VALID_SKIP_REASON.has(s) ? s : "";
}

/**
 * 解析导演判定模型的返回（已是对象）。宽松：坏字段洗掉、给安全默认，不轻易抛错——
 * 判定失败不该打断用户的 RP，顶多这回合不注入。
 * 期望结构（v2）：
 * {
 *   updates:[{ node, event, status:"done|skipped|progress", evidence, evidence_floor,
 *              criteria_met:[0,1], confidence:"high|low", reason:"moot|superseded|refused", recap }],
 *   target:{node,event}, anchor_met:bool, directive, intensity
 * }
 *   - status：done=达成 / skipped=失去意义 / progress=这一拍在推进但没达成（不消耗事件）。
 *   - evidence/evidence_floor：正文里的指认与楼层号，代码据此挡掉「拿旧正文反复判达成」。
 *   - target 只是模型的建议：标准/严格档由 applyDirectorDecision 自行推导，不采信。
 */
export function parseDirectorDecision(data) {
    const obj = data && typeof data === "object" ? data : {};
    const updates = (Array.isArray(obj.updates) ? obj.updates : [])
        .map((u) => {
            const floorRaw = Math.floor(Number(u?.evidenceFloor ?? u?.evidence_floor));
            const metRaw = u?.criteriaMet ?? u?.criteria_met;
            return {
                node: Math.floor(Number(u?.node)),
                event: Math.floor(Number(u?.event)),
                status: normalizeUpdateKind(u?.status),
                // 正文指认：标准/严格档下 done/skipped 没有它就降级成 progress。
                evidence: trimmed(u?.evidence).slice(0, 200),
                // 证据楼层：≤ 上次判定楼层的，说明在拿已经判过的旧正文充新进展。
                evidenceFloor: Number.isFinite(floorRaw) && floorRaw >= 0 ? floorRaw : null,
                criteriaMet: (Array.isArray(metRaw) ? metRaw : [])
                    .map((n) => Math.floor(Number(n)))
                    .filter((n) => Number.isFinite(n) && n >= 0),
                confidence: trimmed(u?.confidence).toLowerCase() === "high" ? "high" : "low",
                reason: normalizeSkipReason(u?.reason ?? u?.skip_reason),
                // 一句话回顾，达成/跳过时写进事件；缺省空串，由 applyDirectorDecision 决定是否覆盖。
                recap: trimmed(u?.recap),
            };
        })
        .filter((u) => Number.isFinite(u.node) && Number.isFinite(u.event));
    const t = obj.target && typeof obj.target === "object" ? obj.target : {};
    const targetNode = Number.isFinite(Math.floor(Number(t.node))) ? Math.max(0, Math.floor(Number(t.node))) : 0;
    const targetEvent = Number.isFinite(Math.floor(Number(t.event))) ? Math.max(0, Math.floor(Number(t.event))) : 0;
    return {
        updates,
        target: { node: targetNode, event: targetEvent },
        // 跨节点的第二把钥匙：模型必须显式确认本节点硬锚已兑现。
        anchorMet: (obj.anchorMet ?? obj.anchor_met) === true,
        directive: typeof obj.directive === "string" ? obj.directive.trim() : "",
        intensity: VALID_INTENSITY.has(obj.intensity) ? obj.intensity : DIRECTOR_INTENSITY.GENTLE,
    };
}

/** done 闸门。返回空串＝放行，否则返回拒绝原因（调用方据此降级成 progress）。 */
function checkDoneGate(ev, u, level, quota, isPointer) {
    if (quota <= 0) return "done-quota"; // 每回合只往前走一步（含跳过），这是「一拍一步」的硬保证
    if (level === STRICTNESS.LOOSE) return "";
    if (!u.evidence) return "no-evidence";
    const need = ev.doneWhen.length;
    if (need > 0) {
        const hit = new Set(u.criteriaMet.filter((n) => n < need)).size;
        if (level === STRICTNESS.STRICT && hit < need) return "criteria-incomplete";
        if (hit < 1) return "criteria-none";
    }
    // 停留预算只对「当前目标」生效：玩家顺手完成的非目标事件没有 turns 可积累，不该被它卡死。
    if (isPointer && ev.beats > 0 && ev.turns < ev.beats) {
        if (level === STRICTNESS.STRICT) return "too-early";
        if (u.confidence !== "high") return "too-early-low-confidence";
    }
    return "";
}

/** skipped 闸门：要理由与证据，且不许一口气把未来的事件全跳掉。 */
function checkSkipGate(ev, u, level, quota, isPointer) {
    if (quota <= 0) return "skip-quota";
    if (level === STRICTNESS.LOOSE) return "";
    if (!u.reason) return "no-skip-reason";
    if (!u.evidence) return "no-evidence";
    if (!isPointer && ev.turns < 1) return "skip-ahead";
    return "";
}

function pushNote(ev, note) {
    const text = trimmed(note).slice(0, 200);
    if (!text) return;
    ev.notes = [...ev.notes.filter((n) => n !== text), text].slice(-MAX_EVENT_NOTES);
}

/**
 * 把判定应用到 blindbox：按 updates 改事件状态，再推导目标指针。
 * 返回新的（规范化后的）blindbox 对象；回顾墙直接由 done/skipped 状态推导。
 *
 * options：
 *   strictness  判定严格度（缺省取 bb.strictness）
 *   floor       本次判定所依据的末楼层号（写进流水，供 swipe 回滚）
 *   swipeId     末楼层的 swipe 下标（同一楼层换了 swipe 要先回滚）
 *   sig         本次触发签名（去重用，原样存着）
 *   sinceFloor  上次判定到的楼层（缺省取 bb.lastJudged.floor）
 *   report      传进来就把本次的放行/拒绝明细写回去（调试用，不落盘）
 */
export function applyDirectorDecision(blindbox, decision, options = {}) {
    const bb = normalizeBlindbox(blindbox);
    const dec = decision && typeof decision === "object" ? decision : {};
    const level = normalizeStrictness(options.strictness ?? bb.strictness);
    const report = options.report && typeof options.report === "object" ? options.report : {};
    report.strictness = level;
    report.applied = [];
    report.refused = [];

    const sinceRaw = Math.floor(Number(options.sinceFloor));
    const sinceFloor = Number.isFinite(sinceRaw) ? sinceRaw : bb.lastJudged.floor;
    const floorRaw = Math.floor(Number(options.floor));
    const floor = Number.isFinite(floorRaw) && floorRaw >= 0 ? floorRaw : -1;

    const prevProgress = { ...bb.progress };
    const changes = [];

    // ① 先给「当前目标事件」记一拍停留。停留预算的唯一来源是这里，不信模型自报。
    const cur = bb.nodes[prevProgress.nodeIndex]?.events?.[prevProgress.eventIndex];
    let dwell = null;
    if (cur && !isPassed(cur)) {
        dwell = { node: prevProgress.nodeIndex, event: prevProgress.eventIndex, prevTurns: cur.turns };
        cur.turns = Math.min(9999, cur.turns + 1);
    }

    // ② 逐条过闸门。先按下标排序：配额只有 1 步时，让**最早**的那个事件拿到，而不是模型先说的那个。
    let stepQuota = level === STRICTNESS.LOOSE ? Infinity : 1;
    const sorted = (Array.isArray(dec.updates) ? dec.updates : [])
        .slice()
        .sort((a, b) => (a.node - b.node) || (a.event - b.event));
    sorted.forEach((u) => {
        const where = `${u?.node}.${u?.event}`;
        const ref = { node: u?.node, event: u?.event };
        const ev = bb.nodes[u?.node]?.events?.[u?.event];
        if (!ev) {
            report.refused.push({ ...ref, where, want: u?.status, why: "no-such-event" });
            return;
        }
        // 已经翻过去的事件是既成事实：代码层面也不许翻回（v1 只在提示词里嘱咐过）。
        if (isPassed(ev)) {
            report.refused.push({ ...ref, where, want: u?.status, why: "already-passed" });
            return;
        }
        const isPointer = u.node === prevProgress.nodeIndex && u.event === prevProgress.eventIndex;
        let want = u.status;
        let why = "";
        // 只许动「当前节点以内」的事件：因果上后面的节点以本节点为前提，越过它去判后面的
        // 事件达成，多半是模型在猜。确实 moot 了也请等指针走到那儿再标。
        if (want !== UPDATE_KIND.PROGRESS && level !== STRICTNESS.LOOSE && u.node > prevProgress.nodeIndex) {
            why = "future-node";
            want = UPDATE_KIND.PROGRESS;
        }
        // 旧正文不算新证据：挡掉「每回合重读同一段、每回合又找出一个达成」的漂移。
        if (want !== UPDATE_KIND.PROGRESS && level !== STRICTNESS.LOOSE
            && sinceFloor >= 0 && u.evidenceFloor !== null && u.evidenceFloor <= sinceFloor) {
            why = "stale-evidence";
            want = UPDATE_KIND.PROGRESS;
        }
        if (want === UPDATE_KIND.DONE) {
            const gate = checkDoneGate(ev, u, level, stepQuota, isPointer);
            if (gate) { why = gate; want = UPDATE_KIND.PROGRESS; }
        } else if (want === UPDATE_KIND.SKIPPED) {
            const gate = checkSkipGate(ev, u, level, stepQuota, isPointer);
            if (gate) { why = gate; want = UPDATE_KIND.PROGRESS; }
        }
        if (want === UPDATE_KIND.DONE || want === UPDATE_KIND.SKIPPED) {
            changes.push({
                node: u.node, event: u.event,
                prevStatus: ev.status, prevRecap: ev.recap, prevTurns: ev.turns, prevSkipReason: ev.skipReason,
            });
            ev.status = want;
            if (u.recap) ev.recap = u.recap;
            if (want === UPDATE_KIND.SKIPPED) ev.skipReason = u.reason || SKIP_REASONS.MOOT;
            stepQuota -= 1;
            report.applied.push({ ...ref, where, status: want });
        } else {
            // 没放行的也别白判：把证据/回顾留成一条推进笔记，下回合随骨架回灌。
            pushNote(ev, u.evidence || u.recap);
            if (u.status !== UPDATE_KIND.PROGRESS) report.refused.push({ ...ref, where, want: u.status, why: why || "downgraded" });
        }
    });

    // ③ 目标指针：标准/严格档由代码推导成「第一个还没翻过去的事件」，不采信模型的 target——
    //    想跨过中间事件必须显式报 skipped 并过闸门，不能靠把 target 往前挪偷渡。
    const flat = flattenEvents(bb);
    let nodeIdx = 0;
    let evIdx = 0;
    if (level === STRICTNESS.LOOSE) {
        nodeIdx = clampInt(dec.target?.node, 0, Math.max(0, bb.nodes.length - 1), 0);
        const evCount = bb.nodes[nodeIdx] ? bb.nodes[nodeIdx].events.length : 0;
        evIdx = clampInt(dec.target?.event, 0, Math.max(0, evCount - 1), 0);
    } else {
        const first = flat.find(({ event }) => !isPassed(event)) || flat[flat.length - 1] || null;
        nodeIdx = first ? first.nodeIndex : 0;
        evIdx = first ? first.eventIndex : 0;
    }

    // ④ 跨节点双钥匙：节点是硬锚，光把事件翻完不算抵达——要模型显式回报 anchor_met=true。
    //    没回报就把指针按在本节点末尾，并立起 awaitingAnchor，让下一拍去兑现 anchor。
    let awaitingAnchor = false;
    if (level !== STRICTNESS.LOOSE && nodeIdx > prevProgress.nodeIndex) {
        const prevNode = bb.nodes[prevProgress.nodeIndex];
        const allPassed = !!prevNode && prevNode.events.length > 0 && prevNode.events.every(isPassed);
        if (allPassed && dec.anchorMet !== true) {
            awaitingAnchor = true;
            nodeIdx = prevProgress.nodeIndex;
            evIdx = Math.max(0, prevNode.events.length - 1);
        }
    }

    bb.progress = { nodeIndex: nodeIdx, eventIndex: evIdx, awaitingAnchor };
    const targetEv = bb.nodes[nodeIdx]?.events?.[evIdx];
    if (targetEv && targetEv.status === EVENT_STATUS.PENDING) targetEv.status = EVENT_STATUS.ACTIVE;

    // ⑤ 判定流水：记下这一拍改了什么，供同一楼层换 swipe 时整笔撤回（见 rollbackJournalFrom）。
    if (floor >= 0) {
        bb.journal = [...bb.journal, {
            floor,
            swipeId: str(options.swipeId),
            at: Date.now(),
            changes,
            dwell,
            prevProgress,
        }].slice(-MAX_JOURNAL);
    }
    bb.lastJudged = normalizeLastJudged({
        floor: floor >= 0 ? floor : bb.lastJudged.floor,
        swipeId: str(options.swipeId),
        sig: str(options.sig),
        at: Date.now(),
    });
    report.progress = { ...bb.progress };
    return bb;
}

/**
 * swipe 重判：把 floor ≥ 给定楼层的判定整笔撤回。
 * 被玩家 swipe 掉的那条回复不该永久消耗事件——v1 没有这层，判过就再也翻不回来。
 */
export function rollbackJournalFrom(blindbox, floor) {
    const bb = normalizeBlindbox(blindbox);
    const from = Math.floor(Number(floor));
    if (!Number.isFinite(from) || from < 0) return bb;
    // 导演日志跟着一起撤回：这一楼被 swipe 掉要重判，作废的那几拍不该继续挂在流水上。
    // （它不参与任何状态还原，纯粹是"别让人看见已经作废的判定"。）
    bb.directorLog = bb.directorLog.filter((e) => !(e.floor >= 0 && e.floor >= from));
    let rolled = 0;
    let earliestProgress = null;
    while (bb.journal.length > 0) {
        const last = bb.journal[bb.journal.length - 1];
        if (!(last.floor >= 0 && last.floor >= from)) break;
        bb.journal.pop();
        rolled += 1;
        last.changes.forEach((c) => {
            const ev = bb.nodes[c.node]?.events?.[c.event];
            if (!ev) return;
            ev.status = c.prevStatus;
            ev.recap = c.prevRecap;
            ev.turns = c.prevTurns;
            ev.skipReason = c.prevSkipReason;
            // 从播报账本里剪掉：这条被 swipe 撤回了，等它再次达成时应当重新响、重新揭晓。
            const mark = eventMark(c.node, c.event);
            bb.announced = bb.announced.filter((m) => m !== mark);
            bb.viewed = bb.viewed.filter((m) => m !== mark);
            // 节点因此掉出"全部翻过"时，它的阶段标记也要剪——否则这个阶段再也不会庆祝一次。
            const node = bb.nodes[c.node];
            const stillCleared = !!node && node.events.length > 0 && node.events.every(isPassed);
            if (!stillCleared) {
                const sm = stageMark(c.node);
                bb.announced = bb.announced.filter((m) => m !== sm);
                bb.viewed = bb.viewed.filter((m) => m !== sm);
            }
        });
        if (last.dwell) {
            const ev = bb.nodes[last.dwell.node]?.events?.[last.dwell.event];
            if (ev) ev.turns = last.dwell.prevTurns;
        }
        if (last.prevProgress) earliestProgress = last.prevProgress;
    }
    if (rolled === 0) return bb;
    if (earliestProgress) bb.progress = normalizeProgress(earliestProgress, bb.nodes);
    const tail = bb.journal[bb.journal.length - 1];
    bb.lastJudged = normalizeLastJudged(tail ? { floor: tail.floor, swipeId: tail.swipeId, at: tail.at } : null);
    return bb;
}

/* ---- 判定提示词要用的派生文本（放这里便于单测，storyOutlineWindow 只负责塞进模板） ---- */

/** 给判定模型看的完整骨架（带下标、状态、成立条件、时间跨度、停留预算）。这是封印内容，只进后台提示词。 */
export function buildDirectorSkeleton(blindbox) {
    const bb = normalizeBlindbox(blindbox);
    return bb.nodes.map((node, i) => {
        const n = { node: i, title: node.title, anchor: node.anchor, is_final: i === bb.nodes.length - 1 };
        if (node.span) n.span = node.span;
        if (node.anchorWhen.length) n.anchor_when = node.anchorWhen;
        n.events = node.events.map((ev, j) => {
            const e = { event: j, content: ev.content, status: ev.status };
            if (ev.span) e.span = ev.span;
            if (ev.doneWhen.length) e.done_when = ev.doneWhen;
            if (ev.beats > 0) e.beats = ev.beats;
            if (ev.status === EVENT_STATUS.ACTIVE) e.turns_spent = ev.turns;
            if (ev.notes.length) e.notes = ev.notes;
            if (isPassed(ev) && ev.recap) e.recap = ev.recap;
            if (ev.status === EVENT_STATUS.SKIPPED && ev.skipReason) e.skip_reason = ev.skipReason;
            return e;
        });
        return n;
    });
}

/** 当前目标指针的自然语言描述：停留了几拍、预算几拍、上次判到哪一楼、硬锚是否待兑现。 */
export function describeDirectorProgress(blindbox) {
    const bb = normalizeBlindbox(blindbox);
    const t = getCurrentTarget(bb);
    if (!t || !t.event) return "（骨架为空，无目标）";
    const lines = [`当前目标：节点 ${t.nodeIndex} · 事件 ${t.eventIndex}`];
    lines.push(t.event.beats > 0
        ? `该事件已停留 ${t.event.turns} 拍 / 拍数预算 ${t.event.beats} 拍`
        : `该事件已停留 ${t.event.turns} 拍（骨架未给拍数预算）`);
    if (t.event.span) lines.push(`该事件相对上一拍应有的时间跨度：${t.event.span}`);
    if (t.node.span) lines.push(`本节点覆盖的时间：${t.node.span}`);
    lines.push(bb.lastJudged.floor >= 0
        ? `上次判定依据到正文 #${bb.lastJudged.floor} 楼：只有 #${bb.lastJudged.floor} 之后的楼层算新证据`
        : "这是第一次判定：全部正文都算新证据");
    if (bb.progress.awaitingAnchor) {
        lines.push(`⚠ 本节点的关键事件都已翻过，但硬锚尚未兑现：这一拍要把节点「${t.node.title}」的 anchor 真正落地，并在回报里给 anchor_met=true，才能进入下一节点`);
    }
    return lines.join("\n");
}

/** 严格度说明文本。改闸门时必须同步改这里——它是喂给判定模型的契约。 */
export function describeStrictness(strictness) {
    const level = normalizeStrictness(strictness);
    if (level === STRICTNESS.LOOSE) {
        return "宽松（兼容旧行为）：同一回合可判多个事件达成，证据字段可省。不推荐——判定会越判越飘。";
    }
    if (level === STRICTNESS.STRICT) {
        return [
            "严格：每回合最多往前走一步（done 与 skipped 共用 1 个配额，多报的按下标取最早一个，其余自动降级为 progress）；",
            "只许动当前节点以内的事件，越过当前节点去判后面的事件一律降级；",
            "done 必须给 evidence ＋ evidence_floor，且 criteria_met 覆盖该事件 done_when 的**全部**条目；",
            "当前目标事件停留拍数未达 beats 预算时，done 一律降级为 progress；",
            "skipped 必须给 reason（moot/superseded/refused）＋ evidence，且不得越过当前目标造成跨步。",
        ].join("\n");
    }
    return [
        "标准：每回合最多往前走一步（done 与 skipped 共用 1 个配额，多报的按下标取最早一个，其余自动降级为 progress）；",
        "只许动当前节点以内的事件，越过当前节点去判后面的事件一律降级；",
        "done 必须给 evidence ＋ evidence_floor，且 criteria_met 至少命中一条 done_when；",
        "当前目标事件停留拍数未达 beats 预算时，只有 confidence=high 才放行，否则降级为 progress；",
        "skipped 必须给 reason（moot/superseded/refused）＋ evidence，且不得越过当前目标造成跨步。",
    ].join("\n");
}

/* ---- 判定流水的「人话」层（给人看的，与提示词契约无关） ---- */

/**
 * 闸门拒绝原因（checkDoneGate / checkSkipGate 与两处前置过滤抛的那些码）翻成人话。
 *
 * 这一层能放在界面上，是因为**原因码是抽象的**——它说的是"为什么没放行"，
 * 从头到尾不碰事件内容，所以不构成剧透。玩家看到"模型想放行但停留拍数不够"，
 * 就知道该调松严格度，而不是疑心导演没在跑。
 */
const REFUSAL_TEXT = {
    "done-quota": "这一拍已经往前走过一步了（一拍一步），多报的留到下一拍",
    "skip-quota": "这一拍已经往前走过一步了（一拍一步），多报的留到下一拍",
    "no-evidence": "没给正文里的指认（evidence），无据可依",
    "criteria-incomplete": "成立条件没有全部命中（严格档要求逐条命中）",
    "criteria-none": "成立条件一条都没命中",
    "too-early": "当前这拍停留拍数没到预算，严格档一律不放行",
    "too-early-low-confidence": "当前这拍停留拍数没到预算，且模型没给高置信度",
    "no-skip-reason": "没给跳过理由（moot / superseded / refused）",
    "skip-ahead": "想跳过还没走到的事件，不许跨步",
    "no-such-event": "报了一个骨架上不存在的事件（模型记错了）",
    "already-passed": "那个事件早就翻过去了，不许翻回",
    "future-node": "想判后面节点的事件——越级判定一律降级",
    "stale-evidence": "拿的是更早楼层的正文，旧正文不算新证据",
    "downgraded": "没通过闸门，降级为「推进中」",
};

export function describeRefusal(why) {
    const key = trimmed(why);
    if (!key) return "没通过闸门";
    return REFUSAL_TEXT[key] || `没通过闸门（${key}）`;
}

/** 一行说清这一拍导演干了什么。零剧透：只有动作与数量，没有内容。 */
export function describeDirectorTurn(entry) {
    const e = entry && typeof entry === "object" ? entry : {};
    if (e.turn === DIRECTOR_TURN.FAILED) {
        return e.failure === "api" ? "判定失败（API 报错）" : "判定失败（返回无法解析）";
    }
    const parts = [];
    const advanced = Array.isArray(e.advanced) ? e.advanced.length : 0;
    if (advanced > 0) parts.push(`翻过 ${advanced} 个`);
    if (e.spoke === DIRECTOR_INTENSITY.FIRM) parts.push("出手 · 收束");
    else if (e.spoke === DIRECTOR_INTENSITY.GENTLE) parts.push("出手 · 轻推");
    return parts.length ? parts.join(" · ") : "没出手";
}
