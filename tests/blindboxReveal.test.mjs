import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const plan = await import(pathToFileURL(path.join(here, '../src/core/blindboxPlan.js')).href);
const reveal = await import(pathToFileURL(path.join(here, '../src/core/blindboxReveal.js')).href);

const {
    EVENT_STATUS, STRICTNESS, MAX_REVEAL_MARKS,
    createBlindboxDraft, normalizeBlindbox, sealWithNodes, applyDirectorDecision,
    parseDirectorDecision, rollbackJournalFrom, eventMark, stageMark, isEventPassed,
} = plan;
const {
    buildRevealView, resolveUnlocks, applyRevealMarks, backfillRevealMarks,
    pickUnlockCue, getPassedMarks, getClearedStageIndexes,
} = reveal;

/* ---------------- 固定装置 ---------------- */

// 机密子串：这些文字绝不能出现在"不该看"的那部分视图里
const SECRETS = {
    n0title: '节点零标题',
    n0anchor: '节点零硬锚',
    n1title: '节点一标题',
    n1anchor: '节点一硬锚',
    e00: '事件零零内容',
    e01: '事件零一内容',
    e02: '事件零二内容',
    e10: '事件一零内容',
    e11: '事件一一内容',
};
const S0 = '开场当晚';
const S1 = '两周后';

const nodes = [
    {
        title: SECRETS.n0title, anchor: SECRETS.n0anchor, span: '约两周',
        anchor_when: ['硬锚条件零'],
        events: [
            { content: SECRETS.e00, span: S0, done_when: ['条件零零'], beats: 2 },
            { content: SECRETS.e01, span: S1, done_when: ['条件零一'], beats: 2 },
            { content: SECRETS.e02, span: '一个月后', done_when: ['条件零二'], beats: 2 },
        ],
    },
    {
        title: SECRETS.n1title, anchor: SECRETS.n1anchor, span: '约两个月',
        anchor_when: ['硬锚条件一'],
        events: [
            { content: SECRETS.e10, span: '三个月后', done_when: ['条件一零'], beats: 3 },
            { content: SECRETS.e11, span: '半年后', done_when: ['条件一一'], beats: 3 },
        ],
    },
];

const freshBook = () => sealWithNodes(createBlindboxDraft({ timescale: '约半年' }), nodes);

/** 直接摆状态（比走判定快，且能精确造出"指针越过未翻完的节点"这种边缘态）。 */
function withState(bb, { statuses = {}, progress } = {}) {
    const next = normalizeBlindbox(bb);
    Object.entries(statuses).forEach(([key, status]) => {
        const [n, e] = key.split('.').map(Number);
        if (next.nodes[n]?.events?.[e]) next.nodes[n].events[e].status = status;
    });
    if (progress) next.progress = { ...next.progress, ...progress };
    return next;
}

const json = (v) => JSON.stringify(v);

/* ================================================================== *
 * 防剧透铁律（本方案最重要的一组）
 * ================================================================== */

test('视图: 封印阶段与未解锁事件的整个序列化串里不含任何机密子串', () => {
    const bb = freshBook(); // 一个都没翻过：节点零是 current，节点一是 sealed
    const view = buildRevealView(bb);
    const sealed = view.stages.filter((s) => s.state === 'sealed');
    assert.equal(sealed.length, 1);
    assert.equal(view.stages[0].state, 'current');
    // 该扫的是"玩家还看不到的那部分"：封印阶段整体 + 进行中阶段里未解锁的那几行
    const hidden = [...sealed, ...view.stages[0].events.filter((e) => e.locked)];
    const text = json(hidden);
    Object.values(SECRETS).forEach((secret) => {
        assert.ok(!text.includes(secret), `未解锁部分泄露了「${secret}」`);
    });
    // 结构信息（有几件）可以给，内容不可以
    assert.equal(sealed[0].counts.total, 2);
    assert.equal(view.stages[0].counts.total, 3);
    // 连节点标题字段本身都不该存在
    assert.equal(sealed[0].title, undefined);
    assert.equal(sealed[0].anchor, undefined);
});

test('视图: 进行中的阶段不揭晓节点标题/硬锚，但已翻过的事件照常揭晓', () => {
    const bb = withState(freshBook(), {
        statuses: { '0.0': EVENT_STATUS.DONE },
        progress: { nodeIndex: 0, eventIndex: 1 },
    });
    const view = buildRevealView(bb);
    const cur = view.stages[0];
    assert.equal(cur.state, 'current');
    assert.equal(cur.title, undefined, '进行中的阶段不该给标题');
    assert.equal(cur.anchor, undefined, '进行中的阶段不该给硬锚');
    assert.ok(json(cur).includes(SECRETS.e00), '已翻过的事件必须揭晓内容');

    // 未解锁的那两拍：连内容/时间跨度/成立条件都不该出现
    const locked = cur.events.filter((e) => e.locked);
    assert.equal(locked.length, 2);
    const lockedText = json(locked);
    [SECRETS.e01, SECRETS.e02, S1, '条件零一'].forEach((secret) => {
        assert.ok(!lockedText.includes(secret), `未解锁事件泄露了「${secret}」`);
    });
    assert.equal(locked[0].content, undefined);
    assert.equal(locked[0].spanLabel, undefined);
    // 阶段零的标题/硬锚同样不该跟着漏出来（它还没通关）
    assert.ok(!json(cur.events).includes(SECRETS.n0anchor));
});

test('视图: 通关后揭晓标题＋硬锚＋全部事件（揭晓即奖励）', () => {
    const bb = withState(freshBook(), {
        statuses: { '0.0': EVENT_STATUS.DONE, '0.1': EVENT_STATUS.SKIPPED, '0.2': EVENT_STATUS.DONE },
        progress: { nodeIndex: 1, eventIndex: 0 },
    });
    const view = buildRevealView(bb);
    const first = view.stages[0];
    assert.equal(first.state, 'cleared');
    assert.equal(first.revealed, true);
    assert.equal(first.title, SECRETS.n0title);
    assert.equal(first.anchor, SECRETS.n0anchor);
    assert.equal(first.span, '约两周');
    const text = json(first);
    [SECRETS.e00, SECRETS.e01, SECRETS.e02, S0, S1].forEach((secret) => {
        assert.ok(text.includes(secret), `通关阶段该揭晓「${secret}」`);
    });
    // 下一个阶段仍是封印的
    assert.equal(view.stages[1].state, 'current');
    assert.equal(view.stages[1].title, undefined);
});

test('视图: 事件翻完但硬锚未落地 → 还不揭晓标题（正在等的那一拍是最伤的剧透）', () => {
    const bb = withState(freshBook(), {
        statuses: { '0.0': EVENT_STATUS.DONE, '0.1': EVENT_STATUS.DONE, '0.2': EVENT_STATUS.DONE },
        progress: { nodeIndex: 0, eventIndex: 2, awaitingAnchor: true },
    });
    const view = buildRevealView(bb);
    const stage = view.stages[0];
    assert.equal(stage.cleared, true, '事件都翻过了，算 cleared');
    assert.equal(stage.isHolding, true);
    assert.equal(stage.revealed, false, '硬锚没落地就不揭晓');
    assert.equal(stage.title, undefined);
    assert.equal(stage.anchor, undefined);
    assert.equal(view.header.isHolding, true);
    // 事件本身是揭晓的
    assert.ok(json(stage.events).includes(SECRETS.e02));
});

test('视图: 宽松档指针越过没翻完的节点 → 那个节点仍是 sealed，不泄露硬锚', () => {
    // 宽松档下模型可以把 target 跳到节点 1，而节点 0 还有两拍没翻
    const bb = withState(freshBook(), {
        statuses: { '0.0': EVENT_STATUS.DONE },
        progress: { nodeIndex: 1, eventIndex: 0 },
    });
    const view = buildRevealView(bb);
    assert.equal(view.stages[0].state, 'sealed', '没翻完就不算通关，别按下标判');
    assert.equal(view.stages[0].revealed, false);
    assert.equal(view.stages[0].title, undefined);
    assert.equal(view.stages[0].anchor, undefined, '硬锚是最强剧透，绝不能提前给');
    assert.ok(!json(view.stages[0]).includes(SECRETS.n0anchor));
    assert.equal(view.stages[1].state, 'current');
});

test('视图: header 统计（已解锁/跳过/阶段数/停留）', () => {
    const bb = withState(freshBook(), {
        statuses: { '0.0': EVENT_STATUS.DONE, '0.1': EVENT_STATUS.SKIPPED },
        progress: { nodeIndex: 0, eventIndex: 2 },
    });
    const view = buildRevealView(bb);
    assert.equal(view.header.total, 5);
    assert.equal(view.header.passed, 2);
    assert.equal(view.header.skipped, 1);
    assert.equal(view.header.stageCount, 2);
    assert.equal(view.header.stageIndex, 0);
    assert.equal(view.header.clearedStages, 0);
    assert.equal(view.stages[0].counts.passed, 2);
    assert.equal(view.stages[0].counts.total, 3);
});

/* ================================================================== *
 * 解锁播报账本
 * ================================================================== */

test('账本: 新存档（marksReady=true）没有旧账，第一次解锁就是新解锁', () => {
    const bb = freshBook();
    assert.equal(bb.marksReady, true);
    const u = resolveUnlocks(bb);
    assert.equal(u.backfill, false);
    assert.deepEqual(u.freshMarks, []);
    assert.deepEqual(u.freshStages, []);

    const after = withState(bb, { statuses: { '0.0': EVENT_STATUS.DONE }, progress: { nodeIndex: 0, eventIndex: 1 } });
    const u2 = resolveUnlocks(after);
    assert.deepEqual(u2.freshMarks, [eventMark(0, 0)]);
    assert.deepEqual(u2.freshStages, []);
    assert.deepEqual(u2.unviewedMarks, [eventMark(0, 0)]);
});

test('账本: 老存档（marksReady=false）静默回填——不响、不动画、也不漏', () => {
    const legacy = normalizeBlindbox({
        ...withState(freshBook(), {
            statuses: { '0.0': EVENT_STATUS.DONE, '0.1': EVENT_STATUS.DONE, '0.2': EVENT_STATUS.DONE },
            progress: { nodeIndex: 1, eventIndex: 0 },
        }),
        marksReady: false,
        announced: [],
        viewed: [],
    });
    const u = resolveUnlocks(legacy);
    assert.equal(u.backfill, true);
    assert.deepEqual(u.freshMarks, [], '回填时不许有任何"新解锁"');
    assert.deepEqual(u.freshStages, []);

    // 视图也一并静音：老存档第一次打开不该整面历史集体闪一次
    const legacyView = buildRevealView(legacy);
    assert.equal(legacyView.header.hasUnviewed, false, '老存档不该点亮横条角标');
    const anyFresh = legacyView.stages.some((s) => s.isFresh || s.events.some((e) => e.isFresh));
    assert.equal(anyFresh, false, '老存档不该有 isFresh 条目');

    const filled = backfillRevealMarks(legacy);
    assert.equal(filled.marksReady, true);
    assert.equal(filled.announced.length, 4, '3 个事件 + 1 个阶段');
    const after = resolveUnlocks(filled);
    assert.deepEqual(after.freshMarks, []);
    assert.deepEqual(after.freshStages, []);
    assert.deepEqual(after.unviewedMarks, [], '回填也把揭晓动画记掉，别一开面板闪一片');

    // 反复渲染也不能把陈年旧账翻出来当新解锁
    const again = buildRevealView(filled);
    assert.equal(again.header.hasUnviewed, false);
});

test('账本: 落标记后幂等，无关项不被清掉', () => {
    const bb = withState(freshBook(), { statuses: { '0.0': EVENT_STATUS.DONE }, progress: { nodeIndex: 0, eventIndex: 1 } });
    const once = applyRevealMarks(bb, { announced: [eventMark(0, 0)] });
    assert.deepEqual(normalizeBlindbox(once).announced, [eventMark(0, 0)]);
    assert.deepEqual(resolveUnlocks(once).freshMarks, [], '第二次调用不该再报新解锁');

    const twice = applyRevealMarks(once, { announced: [eventMark(0, 0)] });
    assert.equal(normalizeBlindbox(twice).announced.length, 1, '重复标记去重');
});

test('账本: 阶段通关单独成一条（事件全翻完才算），且标记可回灌', () => {
    const bb = withState(freshBook(), {
        statuses: { '0.0': EVENT_STATUS.DONE, '0.1': EVENT_STATUS.DONE, '0.2': EVENT_STATUS.DONE },
        progress: { nodeIndex: 1, eventIndex: 0 },
    });
    const u = resolveUnlocks(bb);
    assert.deepEqual(u.freshStages, [stageMark(0)]);
    assert.equal(u.freshMarks.length, 3);
    const marked = applyRevealMarks(bb, { announced: [...u.freshMarks, ...u.freshStages] });
    assert.deepEqual(resolveUnlocks(marked).freshStages, []);
    assert.deepEqual(normalizeBlindbox(marked).announced.includes(stageMark(0)), true);
});

test('账本: 标记封顶，最旧的被丢', () => {
    const many = Array.from({ length: MAX_REVEAL_MARKS + 40 }, (_, i) => eventMark(0, i));
    const bb = applyRevealMarks(freshBook(), { announced: many });
    const list = normalizeBlindbox(bb).announced;
    assert.equal(list.length, MAX_REVEAL_MARKS);
    assert.equal(list[list.length - 1], eventMark(0, MAX_REVEAL_MARKS + 39));
    assert.ok(!list.includes(eventMark(0, 0)), '最旧的应被丢掉');
});

test('账本: 非法标记被洗掉（存档被手改也不炸）', () => {
    const bb = normalizeBlindbox({ ...freshBook(), announced: ['e:0.1', 'nonsense', 's:2', 'e:x', 'e:0.1', 42] });
    assert.deepEqual(bb.announced, ['e:0.1', 's:2']);
});

/* ================================================================== *
 * 提示音选择
 * ================================================================== */

const onCfg = { enabled: true, volume: 30, cue_event: true };

test('提示音: 一回合多拍只响一声——阶段优先，否则事件音', () => {
    assert.equal(pickUnlockCue({ freshMarks: ['e:0.0'], freshStages: [], config: onCfg }), 'event');
    assert.equal(pickUnlockCue({ freshMarks: ['e:0.0', 'e:0.1', 'e:0.2'], freshStages: [], config: onCfg }), 'event');
    // 阶段那一声盖过事件音
    assert.equal(pickUnlockCue({ freshMarks: ['e:0.2'], freshStages: ['s:0'], config: onCfg }), 'stage');
});

test('提示音: 总开关与事件档', () => {
    assert.equal(pickUnlockCue({ freshMarks: ['e:0.0'], config: { ...onCfg, enabled: false } }), null);
    assert.equal(pickUnlockCue({ freshMarks: ['e:0.0'], config: { ...onCfg, cue_event: false } }), null);
    // 关掉事件档不影响里程碑那一声
    assert.equal(pickUnlockCue({ freshStages: ['s:0'], config: { ...onCfg, cue_event: false } }), 'stage');
    // 什么都没解锁就闭嘴
    assert.equal(pickUnlockCue({ config: onCfg }), null);
});

/* ================================================================== *
 * 与 blindboxPlan 的账本联动（本来想在 blindbox.test.mjs 里写，放一起更好读）
 * ================================================================== */

test('联动: 标记活过 normalize 与 JSON 往返（白名单回归）', () => {
    const bb = applyRevealMarks(freshBook(), { announced: [eventMark(0, 0), stageMark(1)], viewed: ['e:0.0'] });
    const round = normalizeBlindbox(JSON.parse(JSON.stringify(bb)));
    assert.deepEqual(round.announced, [eventMark(0, 0), stageMark(1)]);
    assert.deepEqual(round.viewed, ['e:0.0']);
    assert.equal(round.marksReady, true);
});

test('联动: swipe 回滚剪掉账本 → 同一拍再次达成时会重新响', () => {
    let bb = freshBook();
    // 第一拍拍下 0.0
    bb = applyDirectorDecision(bb, parseDirectorDecision({
        updates: [{ node: 0, event: 0, status: 'done', evidence: '见到了', evidence_floor: 5, criteria_met: [0], confidence: 'high' }],
    }), { floor: 5, swipeId: '0' });
    bb = applyRevealMarks(bb, { announced: getPassedMarks(bb), viewed: getPassedMarks(bb) });
    assert.deepEqual(resolveUnlocks(bb).freshMarks, []);

    // 玩家 swipe 掉那条回复 → 判定整笔撤回 → 账本也要跟着撤
    const rolled = rollbackJournalFrom(bb, 5);
    assert.equal(rolled.nodes[0].events[0].status, EVENT_STATUS.ACTIVE);
    assert.deepEqual(normalizeBlindbox(rolled).announced, []);
    assert.deepEqual(normalizeBlindbox(rolled).viewed, []);

    // 重判同一拍：又是"新解锁"，该响就得响
    const again = applyDirectorDecision(rolled, parseDirectorDecision({
        updates: [{ node: 0, event: 0, status: 'done', evidence: '见到了', evidence_floor: 6, criteria_met: [0], confidence: 'high' }],
    }), { floor: 6, swipeId: '1' });
    assert.deepEqual(resolveUnlocks(again).freshMarks, [eventMark(0, 0)]);
});

test('联动: 阶段标记也会被 swipe 回滚剪掉（否则这个阶段再也不会庆祝一次）', () => {
    let bb = withState(freshBook(), {
        statuses: { '0.0': EVENT_STATUS.DONE, '0.1': EVENT_STATUS.DONE },
        progress: { nodeIndex: 0, eventIndex: 2 },
    });
    // 第三拍达成 → 节点零全部翻过
    bb = applyDirectorDecision(bb, parseDirectorDecision({
        updates: [{ node: 0, event: 2, status: 'done', evidence: '翻完了', evidence_floor: 9, criteria_met: [0], confidence: 'high' }],
    }), { floor: 9, swipeId: '0' });
    assert.deepEqual(getClearedStageIndexes(bb), [0]);
    bb = applyRevealMarks(bb, { announced: [...getPassedMarks(bb), stageMark(0)] });
    assert.deepEqual(resolveUnlocks(bb).freshStages, []);

    const rolled = rollbackJournalFrom(bb, 9);
    assert.deepEqual(getClearedStageIndexes(rolled), [], '节点零不再是通关状态');
    assert.ok(!normalizeBlindbox(rolled).announced.includes(stageMark(0)), '阶段标记应被剪掉');
});

test('联动: 重掷一本会清空账本（新本子沿用同一套下标，不清就永远不响）', () => {
    const bb = applyRevealMarks(withState(freshBook(), { statuses: { '0.0': EVENT_STATUS.DONE } }), {
        announced: [eventMark(0, 0)],
        viewed: [eventMark(0, 0)],
    });
    const rerolled = sealWithNodes(bb, nodes);
    assert.deepEqual(rerolled.announced, []);
    assert.deepEqual(rerolled.viewed, []);
    assert.equal(rerolled.marksReady, true);
});

test('联动: isEventPassed 与视图/账本口径一致（唯一的判定实现）', () => {
    assert.equal(isEventPassed({ status: EVENT_STATUS.DONE }), true);
    assert.equal(isEventPassed({ status: EVENT_STATUS.SKIPPED }), true);
    assert.equal(isEventPassed({ status: EVENT_STATUS.ACTIVE }), false);
    assert.equal(isEventPassed({ status: EVENT_STATUS.PENDING }), false);
    assert.equal(isEventPassed(null), false);
});

test('联动: 宽松档的判定也能被账本正确接住（多拍同回合只报一批）', () => {
    const loose = sealWithNodes(createBlindboxDraft({ timescale: '约半年', strictness: STRICTNESS.LOOSE }), nodes);
    const bb = applyDirectorDecision(loose, parseDirectorDecision({
        updates: [
            { node: 0, event: 0, status: 'done' },
            { node: 0, event: 1, status: 'done' },
            { node: 0, event: 2, status: 'done' },
        ],
    }), { floor: 4 });
    const u = resolveUnlocks(bb);
    assert.equal(u.freshMarks.length, 3);
    assert.deepEqual(u.freshStages, [stageMark(0)]);
    assert.equal(pickUnlockCue({ freshMarks: u.freshMarks, freshStages: u.freshStages, config: onCfg }), 'stage',
        '宽松档一回合翻三个事件，也只能响一声');
});
