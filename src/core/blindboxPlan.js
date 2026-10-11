// src/core/blindboxPlan.js
//
// 「盲盒剧本」的数据模型——纯逻辑，不碰 ST 宿主、不碰 extData，方便单元测试。
//
// 普通方案（kind 缺省 / 'normal'）用平铺的 plan.items（{time,title,plot,foreshadowing}）；
// 盲盒方案（kind='blindbox'）另存一份 plan.blindbox，结构是两层：
//
//   节点[]（硬锚 / 必达里程碑） → 每个节点下挂若干关键事件（软垫脚石）
//
// 封印是「对用户」封印：这些内容照常落在 extData 里（后台判定模型要读），
// 但前端一切展示都要先问 isSealed() —— 封着就只给骨架/进度点，不给明文。
// 详见 docs/盲盒剧本-导演模式-方案.md。

export const BLINDBOX_KIND = "blindbox";

/** 每段（两节点之间）关键事件数的上下限，下单输入框据此夹紧。 */
export const EVENTS_PER_GAP_MIN = 3;
export const EVENTS_PER_GAP_MAX = 10;
/** 节点数的合法范围与默认值。 */
export const NODE_COUNT_MIN = 2;
export const NODE_COUNT_MAX = 20;
export const NODE_COUNT_DEFAULT = 4;

/** 关键事件状态：未到 / 进行中 / 已达成 / 已跳过。 */
export const EVENT_STATUS = Object.freeze({
    PENDING: "pending",
    ACTIVE: "active",
    DONE: "done",
    SKIPPED: "skipped",
});
const VALID_STATUS = new Set(Object.values(EVENT_STATUS));

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

const str = (v) => (typeof v === "string" ? v : "");
let seq = 0;
const genId = (prefix) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

function normalizeEvent(raw) {
    const status = VALID_STATUS.has(raw?.status) ? raw.status : EVENT_STATUS.PENDING;
    return {
        id: str(raw?.id) || genId("ev"),
        content: str(raw?.content),
        status,
        // 导演把事件判成 done/skipped 时留下的一句「实际怎么发生的」回顾。
        // 这是导演私有的 durable 记忆：不随聊天楼层被总结/隐藏而消失，判定时随骨架一起回灌，
        // 让导演即便读不到最近正文也知道这拍已经翻过去了（见方案第 5 节 A+B）。
        recap: str(raw?.recap),
    };
}

function normalizeNode(raw) {
    const events = Array.isArray(raw?.events) ? raw.events.map(normalizeEvent) : [];
    return {
        id: str(raw?.id) || genId("nd"),
        title: str(raw?.title),
        anchor: str(raw?.anchor),
        events,
    };
}

function normalizeProgress(raw, nodes) {
    const nodeCount = nodes.length;
    let nodeIndex = clampInt(raw?.nodeIndex, 0, Math.max(0, nodeCount - 1), 0);
    const evCount = nodes[nodeIndex] ? nodes[nodeIndex].events.length : 0;
    let eventIndex = clampInt(raw?.eventIndex, 0, Math.max(0, evCount - 1), 0);
    const revealed = Array.isArray(raw?.revealed)
        ? raw.revealed
            .map((r) => ({ nodeIndex: Math.floor(Number(r?.nodeIndex)), eventIndex: Math.floor(Number(r?.eventIndex)) }))
            .filter((r) => Number.isFinite(r.nodeIndex) && Number.isFinite(r.eventIndex))
        : [];
    return { nodeIndex, eventIndex, revealed };
}

/** 规范化整个 blindbox 对象。缺字段给安全默认，坏类型被洗掉，不抛错。 */
export function normalizeBlindbox(raw) {
    const bb = raw && typeof raw === "object" ? raw : {};
    const nodes = Array.isArray(bb.nodes) ? bb.nodes.map(normalizeNode) : [];
    return {
        tone: str(bb.tone),
        redlines: str(bb.redlines),
        nodeCount: clampNodeCount(bb.nodeCount),
        eventsPerGap: clampEventsPerGap(bb.eventsPerGap),
        sealed: bb.sealed === true,
        unsealed: bb.unsealed === true,
        generatedAt: Number(bb.generatedAt) || 0,
        nodes,
        progress: normalizeProgress(bb.progress, nodes),
    };
}

/** 下单时构造的「未生成」盲盒草稿：只有参数、还没有节点、尚未封印。 */
export function createBlindboxDraft({ tone, redlines, nodeCount, eventsPerGap } = {}) {
    return normalizeBlindbox({
        tone,
        redlines,
        nodeCount,
        eventsPerGap,
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
    bb.progress = normalizeProgress({ nodeIndex: 0, eventIndex: 0, revealed: [] }, bb.nodes);
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
    const flat = flattenEvents(blindbox);
    const total = flat.length;
    let done = 0;
    let skipped = 0;
    flat.forEach(({ event }) => {
        if (event.status === EVENT_STATUS.DONE) done += 1;
        else if (event.status === EVENT_STATUS.SKIPPED) skipped += 1;
    });
    const bb = normalizeBlindbox(blindbox);
    return { total, done, skipped, passed: done + skipped, nodeCount: bb.nodes.length };
}

/** 解封后复用普通方案表格展示：把两层摊平成 {time,title,plot,foreshadowing} 形状。 */
export function toVisibleItems(blindbox) {
    const bb = normalizeBlindbox(blindbox);
    const items = [];
    bb.nodes.forEach((node, i) => {
        items.push({ time: `节点 ${i + 1}`, title: node.title, plot: node.anchor, foreshadowing: "" });
        node.events.forEach((ev, j) => {
            items.push({ time: `${i + 1}.${j + 1}`, title: "", plot: ev.content, foreshadowing: "" });
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
 * 导演引擎的纯逻辑：判定响应解析 + 进度状态机（见方案第 5 节）
 * 注入/事件生命周期不在这里（那部分带宿主依赖，另立模块）。
 * ================================================================== */

/** 引导强度：none=本回合不出手（在线上就闭嘴），gentle=轻推，firm=临近节点收紧往回拉。 */
export const DIRECTOR_INTENSITY = Object.freeze({ NONE: "none", GENTLE: "gentle", FIRM: "firm" });
const VALID_INTENSITY = new Set(Object.values(DIRECTOR_INTENSITY));

/**
 * 解析导演判定模型的返回（已是对象）。宽松：坏字段洗掉、给安全默认，不轻易抛错——
 * 判定失败不该打断用户的 RP，顶多这回合不注入。
 * 期望结构：{ updates:[{node,event,status}], target:{node,event}, directive, intensity }
 *   - updates：本回合状态有变化的关键事件（done=达成 / skipped=被支线带过或失去意义）。
 *   - target：下一步要往那里推的关键事件（会被置为"进行中"）。
 *   - directive：对下一条原生回复的一句引导；空串=本回合不出手。
 */
export function parseDirectorDecision(data) {
    const obj = data && typeof data === "object" ? data : {};
    const updates = (Array.isArray(obj.updates) ? obj.updates : [])
        .map((u) => ({
            node: Math.floor(Number(u?.node)),
            event: Math.floor(Number(u?.event)),
            status: u?.status === EVENT_STATUS.DONE || u?.status === EVENT_STATUS.SKIPPED ? u.status : null,
            // 一句话回顾，达成/跳过时写进事件；缺省空串，由 applyDirectorDecision 决定是否覆盖。
            recap: typeof u?.recap === "string" ? u.recap.trim() : "",
        }))
        .filter((u) => Number.isFinite(u.node) && Number.isFinite(u.event) && u.status);
    const t = obj.target && typeof obj.target === "object" ? obj.target : {};
    const targetNode = Number.isFinite(Math.floor(Number(t.node))) ? Math.max(0, Math.floor(Number(t.node))) : 0;
    const targetEvent = Number.isFinite(Math.floor(Number(t.event))) ? Math.max(0, Math.floor(Number(t.event))) : 0;
    return {
        updates,
        target: { node: targetNode, event: targetEvent },
        directive: typeof obj.directive === "string" ? obj.directive.trim() : "",
        intensity: VALID_INTENSITY.has(obj.intensity) ? obj.intensity : DIRECTOR_INTENSITY.GENTLE,
    };
}

/**
 * 把判定应用到 blindbox：按 updates 改事件状态，再把 target 夹到合法范围并置为"进行中"。
 * 返回新的（规范化后的）blindbox 对象；回顾墙直接由 done/skipped 状态推导，不单独维护 revealed。
 */
export function applyDirectorDecision(blindbox, decision) {
    const bb = normalizeBlindbox(blindbox);
    const dec = decision || {};
    (dec.updates || []).forEach((u) => {
        const ev = bb.nodes[u?.node]?.events?.[u?.event];
        if (ev && (u.status === EVENT_STATUS.DONE || u.status === EVENT_STATUS.SKIPPED)) {
            ev.status = u.status;
            // 有新回顾就记下来；没给就保留旧的（别用空串把已有记忆抹掉）。
            if (u.recap) ev.recap = u.recap;
        }
    });
    const nodeIdx = Math.min(Math.max(Math.floor(Number(dec.target?.node)) || 0, 0), Math.max(0, bb.nodes.length - 1));
    const evCount = bb.nodes[nodeIdx] ? bb.nodes[nodeIdx].events.length : 0;
    const evIdx = Math.min(Math.max(Math.floor(Number(dec.target?.event)) || 0, 0), Math.max(0, evCount - 1));
    bb.progress.nodeIndex = nodeIdx;
    bb.progress.eventIndex = evIdx;
    const targetEv = bb.nodes[nodeIdx]?.events?.[evIdx];
    if (targetEv && targetEv.status === EVENT_STATUS.PENDING) targetEv.status = EVENT_STATUS.ACTIVE;
    return bb;
}
