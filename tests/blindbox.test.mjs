import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, '../src/core/blindboxPlan.js')).href);
const {
    BLINDBOX_KIND, EVENT_STATUS, EVENTS_PER_GAP_MIN, EVENTS_PER_GAP_MAX,
    STRICTNESS, SKIP_REASONS, MAX_EVENT_NOTES, MAX_DIRECTOR_LOG, DIRECTOR_TURN,
    getPlanKind, isBlindboxPlan, isSealed,
    clampNodeCount, clampEventsPerGap, normalizeStrictness,
    normalizeBlindbox, createBlindboxDraft, sealWithNodes, unseal,
    getCurrentTarget, flattenEvents, getProgressStats, toVisibleItems, extractBlindboxNodes,
    DIRECTOR_INTENSITY, parseDirectorDecision, applyDirectorDecision, rollbackJournalFrom,
    buildDirectorSkeleton, describeDirectorProgress, describeStrictness,
    appendDirectorLog, describeDirectorTurn, describeRefusal,
} = mod;

test('kind: 缺省/非 blindbox 一律当普通方案', () => {
    assert.equal(getPlanKind(null), 'normal');
    assert.equal(getPlanKind({}), 'normal');
    assert.equal(getPlanKind({ kind: 'weird' }), 'normal');
    assert.equal(getPlanKind({ kind: BLINDBOX_KIND }), BLINDBOX_KIND);
    assert.equal(isBlindboxPlan({ kind: BLINDBOX_KIND }), true);
    assert.equal(isBlindboxPlan({}), false);
});

test('clamp: 节点数与每段事件数夹在合法区间', () => {
    assert.equal(clampEventsPerGap(0), EVENTS_PER_GAP_MIN);
    assert.equal(clampEventsPerGap(999), EVENTS_PER_GAP_MAX);
    assert.equal(clampEventsPerGap(5), 5);
    assert.equal(clampEventsPerGap('abc'), EVENTS_PER_GAP_MIN);
    assert.equal(clampNodeCount(1), 2);
    assert.equal(clampNodeCount(10), 10);
    assert.equal(clampNodeCount(undefined), 4);
    assert.equal(normalizeStrictness('nope'), STRICTNESS.STANDARD);
    assert.equal(normalizeStrictness(STRICTNESS.STRICT), STRICTNESS.STRICT);
});

test('normalizeBlindbox: 坏输入被洗成安全默认，不抛错', () => {
    const bb = normalizeBlindbox({ nodes: 'nope', progress: 42, eventsPerGap: 7, sealed: 'yes' });
    assert.deepEqual(bb.nodes, []);
    assert.equal(bb.eventsPerGap, 7);
    assert.equal(bb.sealed, false); // 'yes' !== true
    assert.deepEqual(bb.progress, { nodeIndex: 0, eventIndex: 0, awaitingAnchor: false });
    assert.deepEqual(bb.lastJudged, { floor: -1, swipeId: '', sig: '', at: 0 });
    assert.deepEqual(bb.journal, []);
});

// v1 的坑：normalizeBlindbox 是白名单式对象字面量，没写进去的字段会在落盘时蒸发。
test('normalizeBlindbox: 运行态字段（含 directorPaused）必须活过 normalize', () => {
    const bb = normalizeBlindbox({
        timescale: '  约三年  ',
        strictness: STRICTNESS.STRICT,
        directorPaused: true,
        lastJudged: { floor: 12, swipeId: '2', sig: 'abc', at: 999 },
        journal: [{ floor: 12, swipeId: '2', changes: [{ node: 0, event: 0, prevStatus: 'active', prevTurns: 3 }] }],
        nodes: [],
    });
    assert.equal(bb.timescale, '约三年');
    assert.equal(bb.strictness, STRICTNESS.STRICT);
    assert.equal(bb.directorPaused, true);
    assert.equal(bb.lastJudged.floor, 12);
    assert.equal(bb.journal.length, 1);
    assert.equal(bb.journal[0].changes[0].prevTurns, 3);
});

test('createBlindboxDraft: 只有参数、未封印、无节点', () => {
    const d = createBlindboxDraft({
        tone: '黑暗童话', redlines: '不要血腥', nodeCount: 3, eventsPerGap: 4,
        timescale: '约两年', strictness: STRICTNESS.STRICT,
    });
    assert.equal(d.tone, '黑暗童话');
    assert.equal(d.redlines, '不要血腥');
    assert.equal(d.nodeCount, 3);
    assert.equal(d.eventsPerGap, 4);
    assert.equal(d.timescale, '约两年');
    assert.equal(d.strictness, STRICTNESS.STRICT);
    assert.equal(d.sealed, false);
    assert.deepEqual(d.nodes, []);
});

const sampleNodes = [
    { title: '节点一', anchor: '抵达小镇', events: [{ content: '遇见向导' }, { content: '发现线索' }] },
    { title: '节点二', anchor: '真相揭开', events: [{ content: '对峙反派' }] },
];

// v2 骨架：带 span（时间跨度）/ done_when（成立条件）/ beats（拍数预算），模型回的是 snake_case。
const v2Nodes = [
    {
        title: '节点一', span: '开场当晚起的两周', anchor: '主角在小镇落脚',
        anchor_when: ['主角在小镇有了住处'],
        events: [
            { content: '遇见向导', span: '开场当晚', done_when: ['主角与向导见面', '向导答应带路'], beats: 2 },
            { content: '发现线索', span: '三天后', done_when: ['主角拿到半张地图'], beats: 3 },
        ],
    },
    {
        title: '节点二', span: '约两个月后', anchor: '真相揭开',
        events: [{ content: '对峙反派', span: '两个月后', done_when: ['反派身份被当众揭穿'], beats: 4 }],
    },
];

const sealV2 = () => sealWithNodes(createBlindboxDraft({ timescale: '约三个月' }), v2Nodes);

test('sealWithNodes: 封印 + 生成时间 + 进度归零 + 首事件进行中 + 清判定流水', () => {
    const bb = sealWithNodes(
        normalizeBlindbox({ ...createBlindboxDraft({ nodeCount: 2, eventsPerGap: 3 }), lastJudged: { floor: 9 }, journal: [{ floor: 9 }] }),
        sampleNodes,
    );
    assert.equal(bb.sealed, true);
    assert.equal(bb.unsealed, false);
    assert.ok(bb.generatedAt > 0);
    assert.equal(bb.nodes.length, 2);
    assert.ok(bb.nodes[0].events[0].id); // 自动补 id
    assert.deepEqual(bb.progress, { nodeIndex: 0, eventIndex: 0, awaitingAnchor: false });
    assert.equal(bb.nodes[0].events[0].status, EVENT_STATUS.ACTIVE);
    assert.equal(bb.nodes[0].events[1].status, EVENT_STATUS.PENDING);
    // 重掷一本等于重开：旧的判定流水/楼层游标不能留着挡新本子的证据
    assert.equal(bb.lastJudged.floor, -1);
    assert.deepEqual(bb.journal, []);
});

test('isSealed: 盲盒+封印+未逃生 → true；解封后 → false', () => {
    const plan = { kind: BLINDBOX_KIND, blindbox: sealWithNodes(createBlindboxDraft({}), sampleNodes) };
    assert.equal(isSealed(plan), true);
    plan.blindbox = unseal(plan.blindbox);
    assert.equal(isSealed(plan), false);
    assert.equal(plan.blindbox.unsealed, true);
    assert.equal(isSealed({ kind: 'normal', blindbox: {} }), false);
});

test('getCurrentTarget / flattenEvents / getProgressStats', () => {
    const bb = sealWithNodes(createBlindboxDraft({}), sampleNodes);
    const t = getCurrentTarget(bb);
    assert.equal(t.nodeIndex, 0);
    assert.equal(t.eventIndex, 0);
    assert.equal(t.event.content, '遇见向导');

    const flat = flattenEvents(bb);
    assert.equal(flat.length, 3);
    assert.equal(flat[2].node.title, '节点二');

    bb.nodes[0].events[0].status = EVENT_STATUS.DONE;
    bb.nodes[0].events[1].status = EVENT_STATUS.SKIPPED;
    const stats = getProgressStats(bb);
    assert.deepEqual(
        { total: stats.total, done: stats.done, skipped: stats.skipped, passed: stats.passed, nodeCount: stats.nodeCount },
        { total: 3, done: 1, skipped: 1, passed: 2, nodeCount: 2 },
    );
});

test('getProgressStats: 带出当前这拍的停留/预算（封印态也能安全显示）', () => {
    const bb = sealV2();
    const after = applyDirectorDecision(bb, { updates: [] }, { floor: 5 });
    const stats = getProgressStats(after);
    assert.equal(stats.dwellTurns, 1); // 判定一拍就累一拍
    assert.equal(stats.dwellBeats, 2); // 来自骨架 beats
    assert.equal(stats.awaitingAnchor, false);
});

test('toVisibleItems: 解封后摊平成普通方案条目形状（span 进 time，成立条件进伏笔列）', () => {
    const plain = toVisibleItems(sealWithNodes(createBlindboxDraft({}), sampleNodes));
    assert.equal(plain.length, 5); // 2 个节点行 + 3 个事件行
    assert.equal(plain[0].time, '节点 1');
    assert.equal(plain[1].time, '1.1');

    const bb = sealV2();
    const items = toVisibleItems(bb);
    assert.equal(items[0].time, '节点 1 · 开场当晚起的两周');
    assert.equal(items[0].foreshadowing, '主角在小镇有了住处');
    assert.equal(items[1].time, '1.1 · 开场当晚');
    assert.equal(items[1].foreshadowing, '主角与向导见面；向导答应带路');
});

test('extractBlindboxNodes: 认顶层 nodes[]，缺失/空则抛错；snake_case 的 v2 字段被收下', () => {
    const nodes = extractBlindboxNodes({
        version: '2.0',
        nodes: [{
            title: 'A', anchor: 'a', span: '约两周', anchor_when: ['条件A'],
            events: [{ content: 'e1', span: '三天后', done_when: ['c1', 'c2'], beats: 3 }],
        }],
    });
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].span, '约两周');
    assert.deepEqual(nodes[0].anchorWhen, ['条件A']);
    assert.equal(nodes[0].events[0].content, 'e1');
    assert.equal(nodes[0].events[0].span, '三天后');
    assert.deepEqual(nodes[0].events[0].doneWhen, ['c1', 'c2']);
    assert.equal(nodes[0].events[0].beats, 3);
    assert.equal(nodes[0].events[0].status, EVENT_STATUS.PENDING);
    assert.throws(() => extractBlindboxNodes({ items: [] }), /缺少 nodes/);
    assert.throws(() => extractBlindboxNodes({ nodes: [{ events: [] }] }), /为空/);
});

test('parseDirectorDecision: v2 字段齐活；认不出的 status 退成 progress 而不是丢掉', () => {
    const d = parseDirectorDecision({
        updates: [
            { node: 0, event: 0, status: 'done', evidence: '  向导拦住了他  ', evidence_floor: 12, criteria_met: [0, 1], confidence: 'HIGH', recap: ' 雨里拦下 ' },
            { node: 0, event: 1, status: 'skipped', reason: 'moot', evidence: '地图已被烧掉' },
            { node: 1, event: 0, status: 'bogus' }, // 认不出 → progress（最保守的一档）
            { node: 'x', event: 1, status: 'done' }, // 非法 node 被丢
        ],
        target: { node: 1, event: 0 },
        anchor_met: true,
        directive: '  朝对峙推进  ',
        intensity: 'firm',
    });
    assert.equal(d.updates.length, 3);
    assert.equal(d.updates[0].evidence, '向导拦住了他');
    assert.equal(d.updates[0].evidenceFloor, 12);
    assert.deepEqual(d.updates[0].criteriaMet, [0, 1]);
    assert.equal(d.updates[0].confidence, 'high');
    assert.equal(d.updates[0].recap, '雨里拦下');
    assert.equal(d.updates[1].reason, SKIP_REASONS.MOOT);
    assert.equal(d.updates[2].status, 'progress');
    assert.equal(d.anchorMet, true);
    assert.deepEqual(d.target, { node: 1, event: 0 });
    assert.equal(d.directive, '朝对峙推进');
    assert.equal(d.intensity, 'firm');

    const fallback = parseDirectorDecision(null);
    assert.deepEqual(fallback.updates, []);
    assert.deepEqual(fallback.target, { node: 0, event: 0 });
    assert.equal(fallback.anchorMet, false);
    assert.equal(fallback.intensity, DIRECTOR_INTENSITY.GENTLE);
});

/* ---------------- 闸门：判定不随便（标准/严格档） ---------------- */

test('闸门: done 不给 evidence → 降级成 progress，证据留成笔记', () => {
    const bb = sealV2();
    const report = {};
    const next = applyDirectorDecision(
        bb,
        parseDirectorDecision({ updates: [{ node: 0, event: 0, status: 'done', recap: '好像见到了' }] }),
        { floor: 5, report },
    );
    assert.equal(next.nodes[0].events[0].status, EVENT_STATUS.ACTIVE); // 没放行
    assert.deepEqual(next.nodes[0].events[0].notes, ['好像见到了']);
    assert.equal(report.refused[0].why, 'no-evidence');
    assert.deepEqual(report.applied, []);
});

test('闸门: 证据齐 + 条件命中 + confidence high → 放行并写 recap', () => {
    const bb = sealV2();
    const next = applyDirectorDecision(
        bb,
        parseDirectorDecision({
            updates: [{
                node: 0, event: 0, status: 'done', evidence: '向导在雨里拦下他并答应带路',
                evidence_floor: 7, criteria_met: [0, 1], confidence: 'high', recap: '向导在雨里拦下了主角',
            }],
        }),
        { floor: 7 },
    );
    assert.equal(next.nodes[0].events[0].status, EVENT_STATUS.DONE);
    assert.equal(next.nodes[0].events[0].recap, '向导在雨里拦下了主角');
    // 指针自动落到下一个未翻事件，并置为进行中
    assert.deepEqual(
        { n: next.progress.nodeIndex, e: next.progress.eventIndex },
        { n: 0, e: 1 },
    );
    assert.equal(next.nodes[0].events[1].status, EVENT_STATUS.ACTIVE);
});

test('闸门: 每回合最多一个 done，多报的按下标取最早一个', () => {
    const bb = sealV2();
    const report = {};
    const next = applyDirectorDecision(
        bb,
        parseDirectorDecision({
            updates: [
                { node: 0, event: 1, status: 'done', evidence: '拿到半张地图', evidence_floor: 7, criteria_met: [0], confidence: 'high' },
                { node: 0, event: 0, status: 'done', evidence: '向导答应带路', evidence_floor: 7, criteria_met: [0, 1], confidence: 'high' },
            ],
        }),
        { floor: 7, report },
    );
    assert.equal(next.nodes[0].events[0].status, EVENT_STATUS.DONE);   // 下标最早的拿到配额
    assert.equal(next.nodes[0].events[1].status, EVENT_STATUS.ACTIVE); // 另一个被降级
    assert.equal(report.refused.find((r) => r.where === '0.1').why, 'done-quota');
});

test('闸门: 停留拍数不够——标准档要 confidence high，严格档一律降级', () => {
    const mk = (evFloor = 7) => parseDirectorDecision({
        updates: [{ node: 0, event: 0, status: 'done', evidence: '见到向导', evidence_floor: evFloor, criteria_met: [0, 1], confidence: 'low' }],
    });
    // 标准 + low：beats=2 而这才第 1 拍 → 降级
    const r1 = {};
    const a = applyDirectorDecision(sealV2(), mk(), { floor: 7, report: r1 });
    assert.equal(a.nodes[0].events[0].status, EVENT_STATUS.ACTIVE);
    assert.equal(r1.refused[0].why, 'too-early-low-confidence');

    // 严格 + high：照样降级（该慢的地方别抢）
    const r2 = {};
    const b = applyDirectorDecision(
        sealV2(),
        parseDirectorDecision({
            updates: [{ node: 0, event: 0, status: 'done', evidence: '见到向导', evidence_floor: 7, criteria_met: [0, 1], confidence: 'high' }],
        }),
        { strictness: STRICTNESS.STRICT, floor: 7, report: r2 },
    );
    assert.equal(b.nodes[0].events[0].status, EVENT_STATUS.ACTIVE);
    assert.equal(r2.refused[0].why, 'too-early');

    // 拍够了就放行：同一本连判两拍（第二拍的证据必须来自第 7 楼之后，否则先被 stale-evidence 挡掉）
    const first = applyDirectorDecision(sealV2(), parseDirectorDecision({ updates: [] }), { floor: 7 });
    const second = applyDirectorDecision(first, mk(8), { floor: 8 });
    assert.equal(second.nodes[0].events[0].turns, 2);
    assert.equal(second.nodes[0].events[0].status, EVENT_STATUS.DONE);
});

test('闸门: 严格档要求 criteria_met 覆盖全部 done_when', () => {
    const dec = parseDirectorDecision({
        updates: [{ node: 0, event: 0, status: 'done', evidence: '只见了面', evidence_floor: 7, criteria_met: [0], confidence: 'high' }],
    });
    const report = {};
    const strict = applyDirectorDecision(sealV2(), dec, { strictness: STRICTNESS.STRICT, floor: 7, report });
    assert.equal(strict.nodes[0].events[0].status, EVENT_STATUS.ACTIVE);
    assert.equal(report.refused[0].why, 'criteria-incomplete');
});

test('闸门: 拿上次判定之前的旧楼层当证据 → 作废', () => {
    const bb = normalizeBlindbox({ ...sealV2(), lastJudged: { floor: 20 } });
    const report = {};
    const next = applyDirectorDecision(
        bb,
        parseDirectorDecision({
            updates: [{ node: 0, event: 0, status: 'done', evidence: '很早就见过了', evidence_floor: 12, criteria_met: [0, 1], confidence: 'high' }],
        }),
        { floor: 21, report },
    );
    assert.equal(next.nodes[0].events[0].status, EVENT_STATUS.ACTIVE);
    assert.equal(report.refused[0].why, 'stale-evidence');
});

test('闸门: 已翻过去的事件不许翻回（代码层拦，不只靠提示词）', () => {
    const bb = sealV2();
    bb.nodes[0].events[0].status = EVENT_STATUS.DONE;
    bb.nodes[0].events[0].recap = '原来的经过';
    const report = {};
    const next = applyDirectorDecision(
        bb,
        parseDirectorDecision({ updates: [{ node: 0, event: 0, status: 'progress', evidence: '又提了一次' }] }),
        { floor: 9, report },
    );
    assert.equal(next.nodes[0].events[0].status, EVENT_STATUS.DONE);
    assert.equal(next.nodes[0].events[0].recap, '原来的经过');
    assert.equal(report.refused[0].why, 'already-passed');
});

test('闸门: 越过当前节点去判后面的事件 → 降级（不许越级判定）', () => {
    const r = {};
    const bb = sealV2();
    // 0.0 先判掉，指针还在节点 0（0.1）；模型直接去判节点 1 的事件
    const mid = applyDirectorDecision(bb, parseDirectorDecision({
        updates: [{ node: 0, event: 0, status: 'done', evidence: '答应带路', evidence_floor: 5, criteria_met: [0, 1], confidence: 'high' }],
    }), { floor: 5 });
    const next = applyDirectorDecision(mid, parseDirectorDecision({
        updates: [{ node: 1, event: 0, status: 'done', evidence: '当众揭穿反派', evidence_floor: 6, criteria_met: [0], confidence: 'high' }],
    }), { floor: 6, report: r });
    assert.equal(next.nodes[1].events[0].status, EVENT_STATUS.PENDING);
    assert.equal(r.refused[0].why, 'future-node');
});

test('闸门: done 与 skipped 共用每回合 1 个配额', () => {
    const r = {};
    const next = applyDirectorDecision(sealV2(), parseDirectorDecision({
        updates: [
            { node: 0, event: 1, status: 'skipped', reason: 'moot', evidence: '地图被烧' },
            { node: 0, event: 0, status: 'done', evidence: '见到向导', evidence_floor: 7, criteria_met: [0, 1], confidence: 'high' },
        ],
    }), { floor: 7, report: r });
    assert.equal(next.nodes[0].events[0].status, EVENT_STATUS.DONE);     // 下标最早的那条拿到配额
    assert.equal(next.nodes[0].events[1].status, EVENT_STATUS.ACTIVE);   // 跳过被配额挡下
    assert.equal(r.refused.find((x) => x.where === '0.1').why, 'skip-quota');
});

test('闸门: skipped 要理由与证据；不许越过当前目标批量跳未来事件', () => {
    // 没给 reason → 降级
    const r1 = {};
    const a = applyDirectorDecision(
        sealV2(),
        parseDirectorDecision({ updates: [{ node: 0, event: 0, status: 'skipped', evidence: '算了' }] }),
        { floor: 7, report: r1 },
    );
    assert.equal(a.nodes[0].events[0].status, EVENT_STATUS.ACTIVE);
    assert.equal(r1.refused[0].why, 'no-skip-reason');

    // 当前目标 + 理由 + 证据 → 放行
    const b = applyDirectorDecision(
        sealV2(),
        parseDirectorDecision({ updates: [{ node: 0, event: 0, status: 'skipped', reason: 'refused', evidence: '玩家明确拒绝找向导', recap: '主角独自上路' }] }),
        { floor: 7 },
    );
    assert.equal(b.nodes[0].events[0].status, EVENT_STATUS.SKIPPED);
    assert.equal(b.nodes[0].events[0].skipReason, SKIP_REASONS.REFUSED);
    assert.equal(b.nodes[0].events[0].recap, '主角独自上路');

    // 同节点内、却不是当前目标、且一拍都没停留过 → 判它 skipped 也是越步
    const r3 = {};
    const c = applyDirectorDecision(
        sealV2(),
        parseDirectorDecision({ updates: [{ node: 0, event: 1, status: 'skipped', reason: 'moot', evidence: '地图提前被烧' }] }),
        { floor: 7, report: r3 },
    );
    assert.equal(c.nodes[0].events[1].status, EVENT_STATUS.PENDING);
    assert.equal(r3.refused[0].why, 'skip-ahead');
});

test('闸门: 目标指针由代码推导为第一个未翻事件，模型想往前跳也无效', () => {
    const bb = sealV2();
    const next = applyDirectorDecision(
        bb,
        parseDirectorDecision({ updates: [], target: { node: 1, event: 0 } }), // 模型想直接跳到节点二
        { floor: 7 },
    );
    assert.equal(next.progress.nodeIndex, 0);
    assert.equal(next.progress.eventIndex, 0);
});

test('闸门: 跨节点要双钥匙——事件全翻完也得 anchor_met 才放行', () => {
    const bb = sealV2();
    bb.nodes[0].events[0].status = EVENT_STATUS.DONE;
    bb.nodes[0].events[1].status = EVENT_STATUS.DONE;
    bb.progress = { nodeIndex: 0, eventIndex: 1, awaitingAnchor: false };

    // 没回报 anchor_met：指针按在本节点末尾，立起 awaitingAnchor
    const held = applyDirectorDecision(bb, parseDirectorDecision({ updates: [] }), { floor: 9 });
    assert.equal(held.progress.nodeIndex, 0);
    assert.equal(held.progress.eventIndex, 1);
    assert.equal(held.progress.awaitingAnchor, true);
    assert.equal(held.nodes[1].events[0].status, EVENT_STATUS.PENDING);

    // 回报 anchor_met=true：放行进节点二
    const crossed = applyDirectorDecision(bb, parseDirectorDecision({ updates: [], anchor_met: true }), { floor: 9 });
    assert.equal(crossed.progress.nodeIndex, 1);
    assert.equal(crossed.progress.awaitingAnchor, false);
    assert.equal(crossed.nodes[1].events[0].status, EVENT_STATUS.ACTIVE);
});

test('宽松档: 退回 v1 老行为（模型说啥就是啥、target 照搬并夹边界）', () => {
    const bb = sealWithNodes(createBlindboxDraft({ strictness: STRICTNESS.LOOSE }), sampleNodes);
    const next = applyDirectorDecision(bb, parseDirectorDecision({
        updates: [{ node: 0, event: 0, status: 'done' }, { node: 0, event: 1, status: 'skipped' }],
        target: { node: 99, event: 99 },
    }), { floor: 3 });
    assert.equal(next.nodes[0].events[0].status, EVENT_STATUS.DONE);
    assert.equal(next.nodes[0].events[1].status, EVENT_STATUS.SKIPPED);
    assert.equal(next.progress.nodeIndex, 1); // 只有 2 个节点
    assert.equal(next.progress.eventIndex, 0); // 节点二只有 1 个事件
    assert.equal(getProgressStats(next).passed, 2);
});

/* ---------------- swipe 回滚 ---------------- */

test('rollbackJournalFrom: 同一楼层换 swipe，上一次判定整笔撤回', () => {
    const bb = sealV2();
    const judged = applyDirectorDecision(
        bb,
        parseDirectorDecision({
            updates: [{ node: 0, event: 0, status: 'done', evidence: '向导答应带路', evidence_floor: 10, criteria_met: [0, 1], confidence: 'high' }],
        }),
        { floor: 10, swipeId: '0' },
    );
    assert.equal(judged.nodes[0].events[0].status, EVENT_STATUS.DONE);
    assert.equal(judged.progress.eventIndex, 1);
    assert.equal(judged.journal.length, 1);

    const rolled = rollbackJournalFrom(judged, 10);
    assert.equal(rolled.nodes[0].events[0].status, EVENT_STATUS.ACTIVE); // 回到判定前
    assert.equal(rolled.nodes[0].events[0].recap, '');
    assert.equal(rolled.nodes[0].events[0].turns, 0); // 停留计数也退回去
    assert.equal(rolled.progress.eventIndex, 0);
    assert.deepEqual(rolled.journal, []);
    assert.equal(rolled.lastJudged.floor, -1);
});

test('rollbackJournalFrom: 只撤回 ≥ 指定楼层的，更早的判定留着', () => {
    let bb = sealV2();
    bb = applyDirectorDecision(bb, parseDirectorDecision({
        updates: [{ node: 0, event: 0, status: 'done', evidence: 'a', evidence_floor: 4, criteria_met: [0, 1], confidence: 'high' }],
    }), { floor: 4, swipeId: '0' });
    bb = applyDirectorDecision(bb, parseDirectorDecision({
        updates: [{ node: 0, event: 1, status: 'done', evidence: 'b', evidence_floor: 6, criteria_met: [0], confidence: 'high' }],
    }), { floor: 6, swipeId: '0' });
    assert.equal(bb.nodes[0].events[1].status, EVENT_STATUS.DONE);

    const rolled = rollbackJournalFrom(bb, 6);
    assert.equal(rolled.nodes[0].events[0].status, EVENT_STATUS.DONE);   // 第 4 楼那次保留
    assert.equal(rolled.nodes[0].events[1].status, EVENT_STATUS.ACTIVE); // 第 6 楼那次撤回
    assert.equal(rolled.lastJudged.floor, 4);
});

test('recap: 达成/跳过时随事件落盘，不随楼层隐藏丢失，缺省不覆盖旧记忆', () => {
    const bb = sealWithNodes(createBlindboxDraft({ strictness: STRICTNESS.LOOSE }), sampleNodes);
    const d1 = parseDirectorDecision({
        updates: [{ node: 0, event: 0, status: 'done', recap: '  向导在雨里拦下了主角  ' }],
        target: { node: 0, event: 1 },
    });
    assert.equal(d1.updates[0].recap, '向导在雨里拦下了主角'); // 解析时 trim
    const s1 = applyDirectorDecision(bb, d1, { floor: 3 });
    assert.equal(s1.nodes[0].events[0].recap, '向导在雨里拦下了主角');

    // recap 跟着 normalize 存活（模拟存盘→读回）
    const roundtrip = normalizeBlindbox(JSON.parse(JSON.stringify(s1)));
    assert.equal(roundtrip.nodes[0].events[0].recap, '向导在雨里拦下了主角');

    // 再给同一事件 update 但不带 recap——旧记忆不能被空串抹掉（宽松档下仍可重复判）
    const s2 = applyDirectorDecision(roundtrip, {
        updates: [{ node: 0, event: 1, status: 'done', recap: '' }],
        target: { node: 1, event: 0 },
    }, { floor: 4 });
    assert.equal(s2.nodes[0].events[0].recap, '向导在雨里拦下了主角');
});

test('推进笔记: progress 只记笔记不消耗事件，最多留 MAX_EVENT_NOTES 条', () => {
    let bb = sealV2();
    for (let i = 1; i <= MAX_EVENT_NOTES + 2; i += 1) {
        bb = applyDirectorDecision(
            bb,
            parseDirectorDecision({ updates: [{ node: 0, event: 0, status: 'progress', evidence: `第${i}拍的推进` }] }),
            { floor: 10 + i },
        );
    }
    const ev = bb.nodes[0].events[0];
    assert.equal(ev.status, EVENT_STATUS.ACTIVE); // 一直没被消耗
    assert.equal(ev.notes.length, MAX_EVENT_NOTES);
    assert.equal(ev.notes[MAX_EVENT_NOTES - 1], `第${MAX_EVENT_NOTES + 2}拍的推进`);
});

/* ---------------- 喂给判定模型的派生文本 ---------------- */

test('buildDirectorSkeleton: snake_case 下发；turns_spent 只给进行中的，recap 只给翻过的', () => {
    let bb = sealV2();
    bb = applyDirectorDecision(bb, parseDirectorDecision({
        updates: [{ node: 0, event: 0, status: 'done', evidence: '答应带路', evidence_floor: 5, criteria_met: [0, 1], confidence: 'high', recap: '雨里拦下' }],
    }), { floor: 5 });
    const sk = buildDirectorSkeleton(bb);
    assert.equal(sk.length, 2);
    assert.equal(sk[0].span, '开场当晚起的两周');
    assert.deepEqual(sk[0].anchor_when, ['主角在小镇有了住处']);
    assert.equal(sk[1].is_final, true);
    assert.equal(sk[0].events[0].recap, '雨里拦下');
    assert.equal(sk[0].events[0].turns_spent, undefined); // 已翻过的不报停留
    assert.deepEqual(sk[0].events[1].done_when, ['主角拿到半张地图']);
    assert.equal(sk[0].events[1].beats, 3);
    assert.equal(sk[0].events[1].turns_spent, 0); // 进行中的报停留
});

test('describeDirectorProgress / describeStrictness: 契约文本带上判定要用的约束', () => {
    const bb = normalizeBlindbox({ ...sealV2(), lastJudged: { floor: 17 } });
    const text = describeDirectorProgress(bb);
    assert.match(text, /当前目标：节点 0 · 事件 0/);
    assert.match(text, /拍数预算 2 拍/);
    assert.match(text, /开场当晚/);
    assert.match(text, /#17 之后的楼层算新证据/);

    const held = normalizeBlindbox({ ...bb, progress: { nodeIndex: 0, eventIndex: 1, awaitingAnchor: true } });
    assert.match(describeDirectorProgress(held), /硬锚尚未兑现/);

    assert.match(describeStrictness(STRICTNESS.STANDARD), /confidence=high/);
    assert.match(describeStrictness(STRICTNESS.STRICT), /全部/);
    assert.match(describeStrictness(STRICTNESS.LOOSE), /不推荐/);
});

/* ---------------- 导演流水（给人看的那本账） ----------------
 * 它和 journal 是两本账：journal 管回滚，directorLog 管显示。下面几条守着这条分界，
 * 以及"流水永远不含内容"那道零剧透底线。
 */

test('导演流水: 每拍都记一条，且活过 normalize 白名单', () => {
    const bb = appendDirectorLog(sealV2(), {
        floor: 7, swipeId: '0', at: 1700000000000,
        turn: DIRECTOR_TURN.ADVANCED, spoke: DIRECTOR_INTENSITY.GENTLE,
        advanced: [{ node: 0, event: 0, status: 'done' }],
        refused: [{ node: 0, event: 1, why: 'stale-evidence' }],
        dwell: { turns: 3, beats: 4 },
    });
    assert.equal(bb.directorLog.length, 1);
    const e = normalizeBlindbox(bb).directorLog[0];   // 白名单没写进去就会在这里蒸发
    assert.equal(e.floor, 7);
    assert.equal(e.turn, DIRECTOR_TURN.ADVANCED);
    assert.equal(e.spoke, DIRECTOR_INTENSITY.GENTLE);
    assert.deepEqual(e.advanced, [{ node: 0, event: 0, status: 'done' }]);
    assert.deepEqual(e.refused, [{ node: 0, event: 1, why: 'stale-evidence' }]);
    assert.deepEqual(e.dwell, { turns: 3, beats: 4 });
});

test('导演流水: 零剧透——内容字段一个都不收，坏档位退回最保守的一档', () => {
    const bb = appendDirectorLog(sealV2(), {
        floor: 3, turn: '什么鬼', spoke: 'railroad',
        evidence: '机密证据', recap: '机密回顾', content: '机密正文', directive: '机密引导',
        advanced: [{ node: 0, event: 0, status: 'done' }],
    });
    const e = bb.directorLog[0];
    assert.equal(e.turn, DIRECTOR_TURN.NOOP);
    assert.equal(e.spoke, DIRECTOR_INTENSITY.NONE);
    // 整条序列化后扫不出任何内容字段——这是"界面上不给看的东西在数据层就不存在"的延续
    const dump = JSON.stringify(e);
    for (const secret of ['机密证据', '机密回顾', '机密正文', '机密引导']) {
        assert.equal(dump.includes(secret), false, `流水里不应出现 ${secret}`);
    }
});

test('导演流水: 失败那拍照样记，且不碰 journal / lastJudged', () => {
    const bb = sealV2();
    const logged = appendDirectorLog(bb, {
        floor: 9, swipeId: '1', turn: DIRECTOR_TURN.FAILED, failure: 'parse',
    });
    assert.equal(logged.directorLog.length, 1);
    assert.equal(logged.directorLog[0].failure, 'parse');
    // 关键：失败条目不进 journal，所以 lastJudged 不会被推到一段其实没判过的正文上
    assert.deepEqual(logged.journal, []);
    assert.equal(logged.lastJudged.floor, -1);

    // 坏 failure 档位洗成空串，不会把模型原文带进来
    const dirty = appendDirectorLog(bb, { floor: 9, turn: DIRECTOR_TURN.FAILED, failure: '截断原文在此' });
    assert.equal(dirty.directorLog[0].failure, '');
});

test('导演流水: 封顶 MAX_DIRECTOR_LOG，只留最近的', () => {
    let bb = sealV2();
    for (let i = 0; i < MAX_DIRECTOR_LOG + 5; i += 1) {
        bb = appendDirectorLog(bb, { floor: i, turn: DIRECTOR_TURN.NOOP, dwell: { turns: i, beats: 0 } });
    }
    assert.equal(bb.directorLog.length, MAX_DIRECTOR_LOG);
    // 留下的必须是尾部那几条（floor 从 5 起）
    assert.equal(bb.directorLog[0].floor, 5);
    assert.equal(bb.directorLog[bb.directorLog.length - 1].floor, MAX_DIRECTOR_LOG + 4);
});

test('rollbackJournalFrom: swipe 撤回时导演流水跟着一起撤', () => {
    let bb = sealV2();
    bb = appendDirectorLog(bb, { floor: 4, turn: DIRECTOR_TURN.NOOP });
    bb = applyDirectorDecision(bb, parseDirectorDecision({
        updates: [{ node: 0, event: 0, status: 'done', evidence: 'a', evidence_floor: 6, criteria_met: [0, 1], confidence: 'high' }],
    }), { floor: 6, swipeId: '0' });
    bb = appendDirectorLog(bb, { floor: 6, turn: DIRECTOR_TURN.ADVANCED, advanced: [{ node: 0, event: 0, status: 'done' }] });
    assert.equal(bb.directorLog.length, 2);

    const rolled = rollbackJournalFrom(bb, 6);
    assert.equal(rolled.directorLog.length, 1);          // 第 6 楼那拍作废
    assert.equal(rolled.directorLog[0].floor, 4);        // 更早的留着
});

test('applyDirectorDecision: 回报带上 node/event，流水才知道拦的是哪一条', () => {
    const report = {};
    applyDirectorDecision(sealV2(), parseDirectorDecision({
        updates: [
            { node: 0, event: 0, status: 'done', evidence: '在', evidence_floor: 10, criteria_met: [0, 1], confidence: 'high' },
            { node: 0, event: 1, status: 'done', evidence: '在', evidence_floor: 9, criteria_met: [0], confidence: 'high' },
        ],
    }), { floor: 10, swipeId: '0', report });

    assert.deepEqual(report.applied[0], { node: 0, event: 0, where: '0.0', status: 'done' });
    // 第二条被"一拍一步"的配额拦下，下标要能照样带出来
    assert.equal(report.refused[0].node, 0);
    assert.equal(report.refused[0].event, 1);
    assert.equal(report.refused[0].why, 'done-quota');
});

test('describeRefusal / describeDirectorTurn: 人话层，未知原因码也不崩', () => {
    assert.match(describeRefusal('too-early-low-confidence'), /置信度/);
    assert.match(describeRefusal('stale-evidence'), /旧正文/);
    assert.match(describeRefusal('future-node'), /越级/);
    assert.match(describeRefusal('brand-new-code'), /brand-new-code/);   // 认不出就原样带出
    assert.equal(describeRefusal(''), '没通过闸门');

    assert.equal(describeDirectorTurn({ turn: DIRECTOR_TURN.NOOP }), '没出手');
    assert.equal(describeDirectorTurn({ turn: DIRECTOR_TURN.NOOP, spoke: DIRECTOR_INTENSITY.FIRM }), '出手 · 收束');
    assert.equal(
        describeDirectorTurn({ turn: DIRECTOR_TURN.ADVANCED, advanced: [{ node: 0, event: 0, status: 'done' }] }),
        '翻过 1 个',
    );
    assert.match(describeDirectorTurn({ turn: DIRECTOR_TURN.FAILED, failure: 'parse' }), /无法解析/);
    assert.match(describeDirectorTurn({ turn: DIRECTOR_TURN.FAILED, failure: 'api' }), /API/);
});
