import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, '../src/core/blindboxPlan.js')).href);
const {
    BLINDBOX_KIND, EVENT_STATUS, EVENTS_PER_GAP_MIN, EVENTS_PER_GAP_MAX,
    getPlanKind, isBlindboxPlan, isSealed,
    clampNodeCount, clampEventsPerGap,
    normalizeBlindbox, createBlindboxDraft, sealWithNodes, unseal,
    getCurrentTarget, flattenEvents, getProgressStats, toVisibleItems, extractBlindboxNodes,
    DIRECTOR_INTENSITY, parseDirectorDecision, applyDirectorDecision,
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
});

test('normalizeBlindbox: 坏输入被洗成安全默认，不抛错', () => {
    const bb = normalizeBlindbox({ nodes: 'nope', progress: 42, eventsPerGap: 7, sealed: 'yes' });
    assert.deepEqual(bb.nodes, []);
    assert.equal(bb.eventsPerGap, 7);
    assert.equal(bb.sealed, false); // 'yes' !== true
    assert.deepEqual(bb.progress, { nodeIndex: 0, eventIndex: 0, revealed: [] });
});

test('createBlindboxDraft: 只有参数、未封印、无节点', () => {
    const d = createBlindboxDraft({ tone: '黑暗童话', redlines: '不要血腥', nodeCount: 3, eventsPerGap: 4 });
    assert.equal(d.tone, '黑暗童话');
    assert.equal(d.redlines, '不要血腥');
    assert.equal(d.nodeCount, 3);
    assert.equal(d.eventsPerGap, 4);
    assert.equal(d.sealed, false);
    assert.deepEqual(d.nodes, []);
});

const sampleNodes = [
    { title: '节点一', anchor: '抵达小镇', events: [{ content: '遇见向导' }, { content: '发现线索' }] },
    { title: '节点二', anchor: '真相揭开', events: [{ content: '对峙反派' }] },
];

test('sealWithNodes: 封印 + 生成时间 + 进度归零 + 首事件进行中', () => {
    const bb = sealWithNodes(createBlindboxDraft({ nodeCount: 2, eventsPerGap: 3 }), sampleNodes);
    assert.equal(bb.sealed, true);
    assert.equal(bb.unsealed, false);
    assert.ok(bb.generatedAt > 0);
    assert.equal(bb.nodes.length, 2);
    assert.ok(bb.nodes[0].events[0].id); // 自动补 id
    assert.deepEqual(bb.progress, { nodeIndex: 0, eventIndex: 0, revealed: [] });
    assert.equal(bb.nodes[0].events[0].status, EVENT_STATUS.ACTIVE);
    assert.equal(bb.nodes[0].events[1].status, EVENT_STATUS.PENDING);
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

test('toVisibleItems: 解封后摊平成普通方案条目形状', () => {
    const bb = sealWithNodes(createBlindboxDraft({}), sampleNodes);
    const items = toVisibleItems(bb);
    // 2 个节点行 + 3 个事件行
    assert.equal(items.length, 5);
    assert.equal(items[0].time, '节点 1');
    assert.equal(items[0].title, '节点一');
    assert.equal(items[0].plot, '抵达小镇');
    assert.equal(items[1].time, '1.1');
    assert.equal(items[1].plot, '遇见向导');
});

test('extractBlindboxNodes: 认顶层 nodes[]，缺失/空则抛错', () => {
    const nodes = extractBlindboxNodes({
        version: '1.0',
        nodes: [{ title: 'A', anchor: 'a', events: [{ content: 'e1' }] }],
    });
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].events[0].content, 'e1');
    assert.equal(nodes[0].events[0].status, EVENT_STATUS.PENDING);
    assert.throws(() => extractBlindboxNodes({ items: [] }), /缺少 nodes/);
    assert.throws(() => extractBlindboxNodes({ nodes: [{ events: [] }] }), /为空/);
});

test('parseDirectorDecision: 洗坏字段、给安全默认', () => {
    const d = parseDirectorDecision({
        updates: [
            { node: 0, event: 0, status: 'done' },
            { node: 0, event: 1, status: 'skipped' },
            { node: 0, event: 2, status: 'bogus' }, // 非法 status 被丢
            { node: 'x', event: 1, status: 'done' }, // 非法 node 被丢
        ],
        target: { node: 1, event: 0 },
        directive: '  朝对峙推进  ',
        intensity: 'firm',
    });
    assert.equal(d.updates.length, 2);
    assert.deepEqual(d.target, { node: 1, event: 0 });
    assert.equal(d.directive, '朝对峙推进');
    assert.equal(d.intensity, 'firm');

    const fallback = parseDirectorDecision(null);
    assert.deepEqual(fallback.updates, []);
    assert.deepEqual(fallback.target, { node: 0, event: 0 });
    assert.equal(fallback.intensity, DIRECTOR_INTENSITY.GENTLE);
});

test('applyDirectorDecision: 应用状态更新 + 推进目标为进行中', () => {
    const bb = sealWithNodes(createBlindboxDraft({}), sampleNodes);
    // 开局：0.0 active, 其余 pending
    const next = applyDirectorDecision(bb, {
        updates: [{ node: 0, event: 0, status: 'done' }, { node: 0, event: 1, status: 'skipped' }],
        target: { node: 1, event: 0 },
    });
    assert.equal(next.nodes[0].events[0].status, EVENT_STATUS.DONE);
    assert.equal(next.nodes[0].events[1].status, EVENT_STATUS.SKIPPED);
    assert.equal(next.progress.nodeIndex, 1);
    assert.equal(next.progress.eventIndex, 0);
    assert.equal(next.nodes[1].events[0].status, EVENT_STATUS.ACTIVE); // 新目标置为进行中
    // 回顾墙由状态推导：done+skipped 共 2 条
    const stats = getProgressStats(next);
    assert.equal(stats.passed, 2);
});

test('applyDirectorDecision: target 越界被夹回合法范围', () => {
    const bb = sealWithNodes(createBlindboxDraft({}), sampleNodes);
    const next = applyDirectorDecision(bb, { updates: [], target: { node: 99, event: 99 } });
    assert.equal(next.progress.nodeIndex, 1); // 只有 2 个节点
    assert.equal(next.progress.eventIndex, 0); // 节点二只有 1 个事件
});

test('recap: 达成/跳过时随事件落盘，不随楼层隐藏丢失，缺省不覆盖旧记忆', () => {
    const bb = sealWithNodes(createBlindboxDraft({}), sampleNodes);
    // 第一拍：把 0.0 判成 done 并记一句回顾
    const d1 = parseDirectorDecision({
        updates: [{ node: 0, event: 0, status: 'done', recap: '  向导在雨里拦下了主角  ' }],
        target: { node: 0, event: 1 },
    });
    assert.equal(d1.updates[0].recap, '向导在雨里拦下了主角'); // 解析时 trim
    const s1 = applyDirectorDecision(bb, d1);
    assert.equal(s1.nodes[0].events[0].recap, '向导在雨里拦下了主角');

    // recap 跟着 normalize 存活（模拟存盘→读回）
    const roundtrip = normalizeBlindbox(JSON.parse(JSON.stringify(s1)));
    assert.equal(roundtrip.nodes[0].events[0].recap, '向导在雨里拦下了主角');

    // 第二拍：对同一事件再给 update 但不带 recap——旧记忆不能被空串抹掉
    const s2 = applyDirectorDecision(roundtrip, {
        updates: [{ node: 0, event: 0, status: 'done' }],
        target: { node: 1, event: 0 },
    });
    assert.equal(s2.nodes[0].events[0].recap, '向导在雨里拦下了主角');
});
