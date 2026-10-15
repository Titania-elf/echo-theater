import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const read = rel => readFileSync(path.join(project, rel), 'utf8');

const mod = await import(pathToFileURL(path.join(project, 'src/core/transitionPlan.js')).href);
const {
    EVENT_COUNT_DEFAULT, EVENT_COUNT_MIN, EVENT_COUNT_MAX,
    clampEventCount, normalizeTransition, normalizeTransitions,
    getTransitionFor, getActiveTransition, upsertTransition, dropTransition,
    isTransitionDone, getCurrentStep, clampCursor, buildTransitionContextText,
} = mod;

/* ------------------------------------------------------------------ *
 * 数据层（transitionPlan）—— 纯逻辑，直接 import
 * ------------------------------------------------------------------ */

test('clampEventCount: 默认 4，夹在 1~10，坏值回默认', () => {
    assert.equal(clampEventCount(undefined), EVENT_COUNT_DEFAULT);
    assert.equal(clampEventCount('abc'), EVENT_COUNT_DEFAULT);
    assert.equal(clampEventCount(0), EVENT_COUNT_MIN);
    assert.equal(clampEventCount(-3), EVENT_COUNT_MIN);
    assert.equal(clampEventCount(999), EVENT_COUNT_MAX);
    assert.equal(clampEventCount('5'), 5);
    assert.equal(clampEventCount(4.7), 4);
});

test('normalizeTransition: 白名单完整性——字段 round-trip 后一个都不能少', () => {
    // 这条专门守住 blindbox 那个坑（docs/盲盒剧本-导演模式-方案.md §9.4）：
    // normalize 是白名单式字面量，没写进去的字段会在落盘时蒸发。新增字段必须补进去。
    const raw = {
        fromIndex: 2,
        brief: '  两人从对峙走到和解  ',
        events: [
            { title: '冷战', span: '次日', brief: '谁也没先开口。' },
            { title: '摊牌', span: '三天后', brief: '矛盾摆上台面。' },
        ],
        cursor: 1,
        generatedAt: 1699999999999,
    };
    const t = normalizeTransition(raw);
    assert.deepEqual(Object.keys(t).sort(), ['brief', 'cursor', 'events', 'fromIndex', 'generatedAt']);
    assert.equal(t.fromIndex, 2);
    assert.equal(t.brief, '两人从对峙走到和解', 'brief 去头尾空白');
    assert.equal(t.cursor, 1);
    assert.equal(t.generatedAt, 1699999999999);
    assert.equal(t.events.length, 2);
    assert.deepEqual(Object.keys(t.events[0]).sort(), ['brief', 'span', 'title']);
    assert.equal(t.events[1].span, '三天后');
});

test('normalizeTransition: 坏类型被洗掉、不抛错', () => {
    assert.deepEqual(normalizeTransition(null).events, []);
    assert.equal(normalizeTransition('nonsense').cursor, 0);
    assert.equal(normalizeTransition({ fromIndex: -5 }).fromIndex, 0, '负下标夹到 0');
    assert.equal(normalizeTransition({ fromIndex: 'x' }).fromIndex, 0);
    assert.deepEqual(normalizeTransition({ events: 'not-an-array' }).events, []);
});

test('normalizeTransition: 没 brief 的空壳事件被洗掉，cursor 随之重新夹紧', () => {
    // 用户删掉几步之后，旧 cursor 不能悬空——这是手改路径最容易出的 bug。
    const t = normalizeTransition({
        events: [{ brief: 'a' }, { title: '只有标题没内容' }, { brief: 'b' }],
        cursor: 3,
    });
    assert.equal(t.events.length, 2, '没 brief 的条目是空壳，丢掉');
    assert.equal(t.cursor, 2, 'cursor 夹到 events.length');
});

test('normalizeTransition: content 是 brief 的别名兜底', () => {
    const t = normalizeTransition({ events: [{ content: '模型用了 content 字段' }] });
    assert.equal(t.events[0].brief, '模型用了 content 字段');
});

test('normalizeTransitions: 非数组 → 空表；同 fromIndex 只留最后一条', () => {
    assert.deepEqual(normalizeTransitions(null), []);
    assert.deepEqual(normalizeTransitions({}), []);
    const list = normalizeTransitions([
        { fromIndex: 1, brief: '旧的' },
        { fromIndex: 1, brief: '新的' },
        { fromIndex: 0, brief: '零号' },
    ]);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map(t => t.fromIndex), [0, 1], '按 fromIndex 排序');
    assert.equal(list[1].brief, '新的', '重掷是覆盖语义，留最后一条');
});

test('getActiveTransition: 激活 / 走到下一条即失活 / 回退即复活', () => {
    const plan = {
        transitions: [{ fromIndex: 1, brief: 'g', events: [{ brief: 'a' }, { brief: 'b' }], cursor: 1 }],
    };
    assert.ok(getActiveTransition(plan, 1), 'itemIndex === fromIndex → 激活');
    assert.equal(getActiveTransition(plan, 2), null, '走到 fromIndex+1 → 自动失活');
    assert.equal(getActiveTransition(plan, 0), null);
    assert.ok(getActiveTransition(plan, 1), '回退到 fromIndex → 自动复活');
    assert.equal(getActiveTransition(plan, 1).cursor, 1, '复活时 cursor 原样保留');
    assert.equal(getActiveTransition(null, 1), null);
    assert.equal(getActiveTransition({}, 1), null);
    assert.equal(getTransitionFor(plan.transitions, 9), null);
});

test('upsert / drop: 覆盖写与删除都是纯函数，不改入参', () => {
    const before = [{ fromIndex: 0, brief: 'a', events: [{ brief: 'x' }] }];
    const frozen = JSON.parse(JSON.stringify(before));
    const after = upsertTransition(before, { fromIndex: 0, brief: 'b', events: [{ brief: 'y' }] });
    assert.deepEqual(before, frozen, '入参不能被改');
    assert.equal(after.length, 1);
    assert.equal(after[0].brief, 'b');
    const added = upsertTransition(after, { fromIndex: 3, brief: 'c' });
    assert.deepEqual(added.map(t => t.fromIndex), [0, 3]);
    assert.deepEqual(dropTransition(added, 0).map(t => t.fromIndex), [3]);
    assert.deepEqual(dropTransition(added, 99).map(t => t.fromIndex), [0, 3], '删不存在的段是 no-op');
});

test('isTransitionDone / getCurrentStep: 空行程单视为走完（没有台阶就不该拦路）', () => {
    assert.equal(isTransitionDone({ events: [] }), true);
    assert.equal(isTransitionDone({ events: [{ brief: 'a' }], cursor: 0 }), false);
    assert.equal(isTransitionDone({ events: [{ brief: 'a' }], cursor: 1 }), true);
    assert.equal(getCurrentStep({ events: [], cursor: 0 }), null);
    assert.deepEqual(getCurrentStep({ events: [{ brief: 'a' }, { brief: 'b' }], cursor: 1 }).index, 1);
    assert.equal(getCurrentStep({ events: [{ brief: 'a' }], cursor: 1 }), null);
});

test('clampCursor: 段内可进可退、直接赋值，越界夹紧', () => {
    const t = { events: [{ brief: 'a' }, { brief: 'b' }, { brief: 'c' }], cursor: 1 };
    assert.equal(clampCursor(t, 2), 2, '往前');
    assert.equal(clampCursor(t, 0), 0, '往后也允许（与 applyProgressFromModel 的"可进可退"一致）');
    assert.equal(clampCursor(t, 99), 3);
    assert.equal(clampCursor(t, -1), 0);
    assert.equal(clampCursor(t, 'x'), 1, '坏值保持原 cursor');
});

/* ------------------------------------------------------------------ *
 * 上下文文本（buildTransitionContextText）
 * ------------------------------------------------------------------ */

const ITEMS = [
    { index: 1, time: '开场当晚', title: '初遇', plot: '……' },
    { index: 2, time: '一周后', title: '重逢', plot: '……' },
    { index: 3, time: '一个月后', title: '决裂', plot: '……' },
];

test('context: 无行程单 / 空行程单 → 空串（模板占位会接手）', () => {
    assert.equal(buildTransitionContextText(null, ITEMS), '');
    assert.equal(buildTransitionContextText({ events: [] }, ITEMS), '');
    assert.equal(buildTransitionContextText({ fromIndex: 0, events: [{ brief: '' }] }, ITEMS), '');
});

test('context: 段首——两个条目都在，标出当前该演第一步，并锁死 item_index', () => {
    const text = buildTransitionContextText({
        fromIndex: 0,
        brief: '两人从初遇走到重逢',
        events: [
            { title: '试探', span: '次日', brief: '互相打听对方的底细。' },
            { title: '并肩', span: '三天后', brief: '一次意外让两人不得不合作。' },
            { title: '约定', span: '周末', brief: '约好一周后再见。' },
        ],
        cursor: 0,
    }, ITEMS);
    assert.ok(text.includes('第 1 条「初遇」（开场当晚）'), '起点条目');
    assert.ok(text.includes('第 2 条「重逢」（一周后）'), '终点条目');
    assert.ok(text.includes('两人从初遇走到重逢'), '用户填的过渡梗概');
    assert.ok(text.includes('[当前这一步]1. 试探（次日）'), '第一步标为当前');
    assert.ok(text.includes('已走完 0 / 3 步'));
    assert.ok(text.includes('→ 填 1'), '本回合把这一步演完的出口');
    assert.ok(text.includes('→ 填 0'), '这一步之内再演一拍的出口');
    assert.ok(text.includes('item_index 一律填 1'), '锁死 item_index，不得越过过渡');
    assert.ok(!text.includes('[已走完]'), '还没走过任何一步');
    // v1.8：这一步是"去向"不是复述对象，且它的开头可能已经在最新正文里演过了。
    // 旧措辞「候选至多把这一步演完」正是"只扩写这一步"的源头，必须消失。
    assert.ok(text.includes('这一步是**去向**'), '点明这一步是去向');
    assert.ok(text.includes('往下续演'), '要求从最新正文的末态续演');
    assert.ok(!text.includes('至多把这一步演完'), '旧措辞不许回流');
});

test('context: 走完了这一步的出口与"还在这一步之内"分开写，一次至多前进 1 步', () => {
    const text = buildTransitionContextText({
        fromIndex: 0,
        events: [{ brief: 'A' }, { brief: 'B' }, { brief: 'C' }],
        cursor: 1,
    }, ITEMS);
    assert.ok(text.includes('→ 填 1；'), '还在这一步之内 → 停在已走完的步数');
    assert.ok(text.includes('→ 填 2；'), '本回合演完这一步 / 正文显示它已演完 → 前进 1 步');
    assert.ok(text.includes('一次至多前进 1 步'), '不许一跳到底');
    assert.ok(!text.includes('→ 填 3'), '没有"直接跳到第三步"这个出口');
});

test('context: 中途——已走完的标出来，当前步顺延', () => {
    const text = buildTransitionContextText({
        fromIndex: 1,
        events: [{ brief: 'A' }, { brief: 'B' }, { brief: 'C' }],
        cursor: 2,
    }, ITEMS);
    assert.ok(text.includes('[已走完]1. A'));
    assert.ok(text.includes('[已走完]2. B'));
    assert.ok(text.includes('[当前这一步]3. C'));
    assert.ok(text.includes('已走完 2 / 3 步'));
    assert.ok(text.includes('→ 填 3'), '演完第三步 / 正文显示它已演完');
    assert.ok(text.includes('item_index 一律填 2'), 'fromIndex=1 → item_index 填 2');
});

test('context: 走完——转为放行跨段，并给出下一段的 step_index', () => {
    const text = buildTransitionContextText({
        fromIndex: 0,
        events: [{ brief: 'A' }, { brief: 'B' }],
        cursor: 2,
    }, ITEMS);
    assert.ok(text.includes('已全部走完'));
    assert.ok(text.includes('推进到 第 2 条「重逢」（一周后）'));
    assert.ok(text.includes('item_index 填 2'));
    assert.ok(text.includes('step_index 填 2'));
    assert.ok(!text.includes('不得越过'), '走完了就不该再锁 item_index');
});

test('context: 条目缺失时不抛错，退化成"未知条目"', () => {
    const text = buildTransitionContextText({ fromIndex: 7, events: [{ brief: 'A' }] }, ITEMS);
    assert.ok(text.includes('未知条目'));
    assert.ok(text.includes('item_index 一律填 8'));
});

/* ------------------------------------------------------------------ *
 * 提示词构造链（vm + stub 夹具，照 pacing.test.mjs 的 loadStoryOutline）
 * ------------------------------------------------------------------ */

/** 极简 jQuery 桩：只满足 resolveInsertMode 那种"取不到就回退"的读取。 */
function jqStub() {
    const self = {
        length: 0,
        val: () => "",
        text: () => "",
        html: () => "",
        attr: () => "",
        data: () => undefined,
        prop: () => self,
        find: () => jqStub(),
        closest: () => jqStub(),
        each: () => self,
        on: () => self,
        off: () => self,
    };
    return self;
}

async function loadStoryOutline(opts = {}) {
    const context = vm.createContext({
        console, String, Number, Boolean, Math, JSON, Array, Object,
        $: jqStub,
        __extData: opts.extData || {},
        SillyTavern: opts.chat ? { getContext: () => ({ chat: opts.chat }) } : undefined,
    });
    const uiPath = path.join(project, 'src/ui');
    const stubs = new Map([
        [path.join(project, 'src/core/context.js'), 'export const getContextData = async () => ({});'],
        [path.join(project, 'src/core/connection.js'), 'export const sendChatRequestWithConnection = async () => ""; export const getConnectionByProfileId = () => null; export const getActiveConnection = () => null;'],
        [path.join(project, 'src/core/apiProfileRegistry.js'), 'export const normalizeApiBaseUrl = u => u; export const normalizeRewriteCustomProfiles = p => p;'],
        [path.join(project, 'src/utils/dom.js'), 'export const ensureFeatureCss = () => {};'],
        [path.join(project, 'src/utils/storage.js'), 'export const getExtData = () => __extData; export const saveExtData = () => {};'],
        [path.join(project, 'src/utils/chatTagWhitelist.js'), 'export const parseTagWhitelistInput = () => []; export const extractTextByWhitelist = t => t;'],
        [path.join(uiPath, 'shared/apiConnectionEditor.js'), 'export const createApiConnectionEditor = () => ({}); export const mapConnectionProfilesToCustomProfiles = p => p; export const mapCustomProfilesToConnectionProfiles = p => p; export const renderApiConnectionEditorHTML = () => "";'],
        [path.join(project, 'src/core/directorInjection.js'), 'export const armDirectorDirective = () => {}; export const clearDirectorDirective = () => {}; export const getDirectorInjectConfig = () => ({ depth: 0, role: "system" }); export const getDirectorTrigger = () => ({ eligible: false, floor: -1, swipeId: "", sig: "" });'],
    ]);
    const modules = new Map();
    const moduleFor = id => {
        if (!modules.has(id)) modules.set(id, new vm.SourceTextModule(stubs.get(id) ?? readFileSync(id, 'utf8'), { context, identifier: id }));
        return modules.get(id);
    };
    const entry = moduleFor(path.join(uiPath, 'storyOutlineWindow.js'));
    if (entry.status === 'unlinked') await entry.link((specifier, ref) => moduleFor(path.resolve(path.dirname(ref.identifier), specifier)));
    if (entry.status === 'linked') await entry.evaluate();
    return entry.namespace;
}

test('parseTransitionResponse: 正常返回（含 from_index 夹紧）', async () => {
    const ns = await loadStoryOutline();
    const parsed = ns.parseTransitionResponse(JSON.stringify({
        version: '1.0',
        from_index: 3,
        to_index: 4,
        events: [
            { title: '试探', span: '次日', brief: '互相打听底细。' },
            { title: '并肩', span: '三天后', brief: '一次意外逼两人合作。' },
        ],
    }), { fromIndex: 2, eventCount: 4 });
    assert.equal(parsed.fromIndex, 2, 'from_index 由调用方给定，不信模型自报');
    assert.equal(parsed.events.length, 2);
    assert.equal(parsed.events[0].title, '试探');
    assert.equal(parsed.events[1].span, '三天后');
    assert.equal(parsed.cursor, 0, '新生成的行程单从 0 起步');
});

test('parseTransitionResponse: 空返回 / 零有效条目 → 抛错（让修复弹窗接住）', async () => {
    const ns = await loadStoryOutline();
    assert.throws(() => ns.parseTransitionResponse('', { fromIndex: 0 }), /为空/);
    assert.throws(() => ns.parseTransitionResponse(null, { fromIndex: 0 }), /为空/);
    assert.throws(
        () => ns.parseTransitionResponse(JSON.stringify({ events: [] }), { fromIndex: 0 }),
        /缺少有效 events/);
    assert.throws(
        () => ns.parseTransitionResponse(JSON.stringify({ events: [{ title: '只有标题' }] }), { fromIndex: 0 }),
        /缺少有效 events/,
        '没 brief 的空壳等于没有');
});

test('parseTransitionResponse: 坏类型洗掉、条数按 eventCount 截断、span 缺失容忍', async () => {
    const ns = await loadStoryOutline();
    const events = Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, brief: `b${i}` }));
    const parsed = ns.parseTransitionResponse(JSON.stringify({ events }), { fromIndex: 1, eventCount: 3 });
    assert.equal(parsed.events.length, 3, '多于下单数就截断');
    assert.equal(parsed.events[0].span, '', 'span 缺失容忍成空串');
    const loose = ns.parseTransitionResponse('```json\n{"events":[{"brief":"坏了逗号"},]}\n```', { fromIndex: 0, eventCount: 5 });
    assert.equal(loose.events.length, 1, '围栏 + 尾逗号都能救回来');
});

test('parseTransitionResponse: eventCount 也给个兜底（调用方没传时用默认 4）', async () => {
    const ns = await loadStoryOutline();
    const events = Array.from({ length: 9 }, (_, i) => ({ brief: `b${i}` }));
    const parsed = ns.parseTransitionResponse(JSON.stringify({ events }), { fromIndex: 0 });
    assert.equal(parsed.events.length, EVENT_COUNT_DEFAULT);
});

/* ------------------------------------------------------------------ *
 * Number(null) === 0 陷阱：null 与 0 在这套数据里语义完全不同
 *   null ＝ 本段没有行程单；0 ＝ 有行程单但候选就地深化、不推进。
 *   把 null 读成 0 会让点候选时去 setSceneStep(0)，把 cursor 打回原点。
 * ------------------------------------------------------------------ */

const PLAN_WITH_CANDIDATES = (candidates) => ({
    story_outline_scene_source_plan_id: 'p1',
    story_outline_active_plan_id: 'p1',
    story_outline_plans: [{
        id: 'p1',
        name: '测试方案',
        instruction: '测试',
        items: [
            { index: 1, time: '开场当晚', title: '初遇', plot: 'a' },
            { index: 2, time: '一周后', title: '重逢', plot: 'b' },
        ],
        progress: { itemIndex: 0, reachedEnding: false },
        candidates: { items: candidates, generatedAt: 1 },
    }],
});

test('状态快照：候选的 stepIndex=null 必须原样保留，不能被读成 0', async () => {
    const ns = await loadStoryOutline({
        extData: PLAN_WITH_CANDIDATES([
            { title: '无行程单', text: 't1', itemIndex: 1, stepIndex: null },
            { title: '第 0 步', text: 't2', itemIndex: 1, stepIndex: 0 },
            { title: '第 2 步', text: 't3', itemIndex: 1, stepIndex: 2 },
        ]),
    });
    const state = ns.getSceneAdvanceState();
    assert.equal(state.planId, 'p1');
    assert.equal(state.candidates.length, 3);
    assert.equal(state.candidates[0].stepIndex, null, 'null 不能被 Number(null) 洗成 0');
    assert.equal(state.candidates[1].stepIndex, 0, '0 是"就地深化"，不能与 null 混同');
    assert.equal(state.candidates[2].stepIndex, 2);
});

test('状态快照：承接点 from 与模型对表的 stepState 都要原样带出来', async () => {
    const extData = PLAN_WITH_CANDIDATES([
        { title: 'A', text: 't1', from: '深夜那通被挂断的电话', itemIndex: 1, stepIndex: 0 },
        { title: 'B', text: 't2', from: 'x'.repeat(70), itemIndex: 1, stepIndex: 0 },
    ]);
    extData.story_outline_plans[0].candidates.stepState = '进行中';
    const ns = await loadStoryOutline({ extData });
    const state = ns.getSceneAdvanceState();
    // ⚠ 候选字段白名单只写一份：from 漏了它就会被静默洗掉，卡片上的「承接」行永远不出现。
    assert.equal(state.candidates[0].from, '深夜那通被挂断的电话');
    assert.equal(state.candidates[1].from.length, 60, '抄了一整段正文的要截断（卡片放不下）');
    assert.equal(state.stepState, '进行中', '模型对表的读数要带出来给面板显示');
});

test('状态快照：点候选标「已写入」不能把 stepState 抹掉', async () => {
    // markSceneCandidateUsed 只回传 items（keepTimestamp 那条路径）。setPlanCandidates 若不继承
    // 批次里已有的 stepState，点一次卡片「本步 进行中」那枚读数就凭空消失了。
    const extData = PLAN_WITH_CANDIDATES([
        { title: 'A', text: 't1', from: '挂断电话', itemIndex: 1, stepIndex: 0 },
        { title: 'B', text: 't2', from: '挂断电话', itemIndex: 1, stepIndex: 0 },
    ]);
    extData.story_outline_plans[0].candidates.stepState = '进行中';
    const ns = await loadStoryOutline({ extData });
    ns.markSceneCandidateUsed('p1', 0);
    const after = ns.getSceneAdvanceState();
    assert.equal(after.candidates[0].used, true);
    assert.equal(after.candidates[0].from, '挂断电话', 'from 也要跟着留下');
    assert.equal(after.stepState, '进行中');
});

test('状态快照：stepState 只认三值，坏值/缺失一律 null', async () => {
    const bad = PLAN_WITH_CANDIDATES([{ title: 'A', text: 't1', itemIndex: 1, stepIndex: 0 }]);
    bad.story_outline_plans[0].candidates.stepState = '大概是中间吧';
    const nsBad = await loadStoryOutline({ extData: bad });
    assert.equal(nsBad.getSceneAdvanceState().stepState, null, '别的词当作"没判断出来"，不猜');

    const none = await loadStoryOutline({ extData: PLAN_WITH_CANDIDATES([]) });
    assert.equal(none.getSceneAdvanceState().stepState, null);
});

test('状态快照：老方案（无 transitions 字段）不报错，canTransition 按条目数算', async () => {
    const ns = await loadStoryOutline({ extData: PLAN_WITH_CANDIDATES([]) });
    const state = ns.getSceneAdvanceState();
    assert.equal(state.transition, null, '老方案没有行程单 → null');
    assert.equal(state.transitionDone, false);
    assert.equal(state.canTransition, true, '1/2 条，后面还有 gap 可补');
    assert.equal(state.transitionGap.fromIndex, 0);
    assert.equal(state.transitionGap.toIndex, 1);
    assert.equal(state.transitionGap.toTitle, '重逢');
});

test('状态快照：已在最后一条大纲 → canTransition=false（整块隐藏）', async () => {
    const extData = PLAN_WITH_CANDIDATES([]);
    extData.story_outline_plans[0].progress = { itemIndex: 1, reachedEnding: true };
    const ns = await loadStoryOutline({ extData });
    const state = ns.getSceneAdvanceState();
    assert.equal(state.canTransition, false);
});

test('状态快照：带行程单时给出进度与"是否走完"，并按 fromIndex 匹配当前段', async () => {
    const extData = PLAN_WITH_CANDIDATES([]);
    extData.story_outline_plans[0].transitions = [{
        fromIndex: 0,
        brief: '两人从初遇走到重逢',
        events: [{ brief: 'A' }, { brief: 'B' }, { brief: 'C' }],
        cursor: 2,
        generatedAt: 1,
    }];
    const ns = await loadStoryOutline({ extData });
    let state = ns.getSceneAdvanceState();
    assert.equal(state.transition.events.length, 3);
    assert.equal(state.transition.cursor, 2);
    assert.equal(state.transitionDone, false, '还差一步');

    // 走到下一步所在条目 → 该段自动失活（不显示、也不再拦跨段）
    extData.story_outline_plans[0].progress = { itemIndex: 1, reachedEnding: true };
    state = ns.getSceneAdvanceState();
    assert.equal(state.transition, null, 'itemIndex 越过 fromIndex 后按 fromIndex 匹配不到');
});

test('parseRecommendationResponse: 没有行程单时 stepIndex 一律 null', async () => {
    const ns = await loadStoryOutline();
    const parsed = ns.parseRecommendationResponse(JSON.stringify({
        candidates: [{ title: 't', text: '正文', item_index: 1, step_index: 2 }],
    }), 0, 3);
    assert.equal(parsed.candidates[0].stepIndex, null, '没有行程单就不认 step_index');
});

test('parseRecommendationResponse: 有行程单时 step_index 夹紧，null/缺失保持 null', async () => {
    const ns = await loadStoryOutline();
    const transition = { fromIndex: 0, events: [{ brief: 'a' }, { brief: 'b' }, { brief: 'c' }], cursor: 0 };
    const parsed = ns.parseRecommendationResponse(JSON.stringify({
        candidates: [
            { title: 'A', text: 'x1', item_index: 1, step_index: 2 },
            { title: 'B', text: 'x2', item_index: 1, step_index: 99 },
            { title: 'C', text: 'x3', item_index: 1, step_index: null },
            { title: 'D', text: 'x4', item_index: 1 },
        ],
    }), 0, 3, transition);
    assert.equal(parsed.candidates[0].stepIndex, 2);
    assert.equal(parsed.candidates[1].stepIndex, 3, '越过行程单总步数就夹到总步数');
    assert.equal(parsed.candidates[2].stepIndex, null, '模型显式填 null 不能被读成 0');
    assert.equal(parsed.candidates[3].stepIndex, null, '整个字段缺失同样是 null');
});

test('parseRecommendationResponse: from（承接点）容缺成空串，超长截断', async () => {
    const ns = await loadStoryOutline();
    const parsed = ns.parseRecommendationResponse(JSON.stringify({
        candidates: [
            { title: 'A', text: 'x1', from: '  她挂断电话的那三秒  ', item_index: 1 },
            { title: 'B', text: 'x2', from: 'y'.repeat(90), item_index: 1 },
            { title: 'C', text: 'x3', item_index: 1 },
        ],
    }), 0, 3);
    assert.equal(parsed.candidates[0].from, '她挂断电话的那三秒');
    assert.equal(parsed.candidates[1].from.length, 60);
    // 缺 from 不该让整批候选作废：它只用于展示与自查，不是推进量。
    assert.equal(parsed.candidates[2].from, '');
});

test('parseRecommendationResponse: step_state 只认三值，且没有行程单时一律 null', async () => {
    const ns = await loadStoryOutline();
    const transition = { fromIndex: 0, events: [{ brief: 'a' }, { brief: 'b' }], cursor: 0 };
    const candidates = [{ title: 'A', text: 'x1' }];
    const withT = (state) => ns.parseRecommendationResponse(
        JSON.stringify({ step_state: state, candidates }), 0, 3, transition);

    assert.equal(withT('进行中').stepState, '进行中');
    assert.equal(withT('已完成').stepState, '已完成');
    assert.equal(withT('未开始').stepState, '未开始');
    assert.equal(withT('差不多演完了').stepState, null, '别的词当作没判断出来');
    assert.equal(withT(null).stepState, null, '模板要求无行程单时填 null');
    assert.equal(withT(undefined).stepState, null);

    const noT = ns.parseRecommendationResponse(
        JSON.stringify({ step_state: '进行中', candidates }), 0, 3);
    assert.equal(noT.stepState, null, '没有行程单时模型就算填了也不认——那一步不存在');
});

/* ------------------------------------------------------------------ *
 * 跨段闸门（applyProgressFromModel 的行为，不是源码文本）
 * ------------------------------------------------------------------ */

test('闸门：行程单没走完时，模型判出的跨段被夹回本段起点', async () => {
    const extData = PLAN_WITH_CANDIDATES([]);
    extData.story_outline_plans[0].transitions = [{
        fromIndex: 0,
        events: [{ brief: 'A' }, { brief: 'B' }],
        cursor: 1,
        generatedAt: 1,
    }];
    const ns = await loadStoryOutline({ extData });
    ns.applySceneProgress('p1', 1);   // 模型说"已经跨到第 2 条了"
    const plan = extData.story_outline_plans[0];
    assert.equal(plan.progress.itemIndex, 0, '行程单没走完 ⇒ 不许跨段');
    assert.equal(plan.progress.reachedEnding, false);
});

test('闸门：行程单走完后放行跨段；没有行程单时照旧自由推进', async () => {
    const extData = PLAN_WITH_CANDIDATES([]);
    extData.story_outline_plans[0].transitions = [{
        fromIndex: 0,
        events: [{ brief: 'A' }, { brief: 'B' }],
        cursor: 2,   // 已走完
        generatedAt: 1,
    }];
    const ns = await loadStoryOutline({ extData });
    ns.applySceneProgress('p1', 1);
    assert.equal(extData.story_outline_plans[0].progress.itemIndex, 1, '走完就该放行');

    const extData2 = PLAN_WITH_CANDIDATES([]);
    const ns2 = await loadStoryOutline({ extData: extData2 });
    ns2.applySceneProgress('p1', 1);
    assert.equal(extData2.story_outline_plans[0].progress.itemIndex, 1, '没有行程单不拦路');
});

test('闸门：段内推进不受影响（该夹的是跨段，不是推进本身）', async () => {
    const extData = PLAN_WITH_CANDIDATES([]);
    extData.story_outline_plans[0].transitions = [{
        fromIndex: 0,
        events: [{ brief: 'A' }, { brief: 'B' }],
        cursor: 1,
        generatedAt: 1,
    }];
    const ns = await loadStoryOutline({ extData });
    ns.applySceneProgress('p1', 0);
    assert.equal(extData.story_outline_plans[0].progress.itemIndex, 0);
});

/* ------------------------------------------------------------------ *
 * 无头 API：定位 / 跨段 / 手改 / 删除
 * ------------------------------------------------------------------ */

function extDataWithTransition(cursor = 0) {
    const extData = PLAN_WITH_CANDIDATES([]);
    extData.story_outline_plans[0].transitions = [{
        fromIndex: 0,
        brief: '用意',
        events: [{ title: 'A', span: '次日', brief: 'a1' }, { title: 'B', span: '三天后', brief: 'b1' }],
        cursor,
        generatedAt: 1,
    }];
    return extData;
}

test('setSceneStep：定位（可进可退），不碰输入框也不碰 item 指针', async () => {
    const extData = extDataWithTransition(0);
    const ns = await loadStoryOutline({ extData });
    const after = ns.setSceneStep('p1', 1);
    assert.equal(after.transition.cursor, 1);
    assert.equal(after.progress.itemIndex, 0, '定位不是跨段，item 指针不动');
    const back = ns.setSceneStep('p1', 0);
    assert.equal(back.transition.cursor, 0, '可退（与 applyProgressFromModel 的"可进可退"一致）');
    assert.equal(ns.setSceneStep('p1', 99).transition.cursor, 2, '越界夹到总步数');
});

test('crossSceneGap：走完最后一步后跨段，行程单随即失活', async () => {
    const extData = extDataWithTransition(2);
    const ns = await loadStoryOutline({ extData });
    const after = ns.crossSceneGap('p1');
    assert.equal(after.progress.itemIndex, 1);
    assert.equal(after.transition, null, '跨过去之后按 fromIndex 匹配不到');
    assert.equal(after.canTransition, false, '已在最后一条');
});

test('crossSceneGap：没走完也能跨（用户显式操作＝跳过剩下几步），闸门不拦玩家', async () => {
    const extData = extDataWithTransition(0);
    const ns = await loadStoryOutline({ extData });
    const after = ns.crossSceneGap('p1');
    assert.equal(after.progress.itemIndex, 1, '闸门是拦模型自作主张的，不该拦显式操作');
    assert.equal(extData.story_outline_plans[0].transitions[0].cursor, 2, '跨段时把行程单标成走完');
});

test('saveSceneTransitionEvents：手改落盘，cursor 被重新夹紧到新长度', async () => {
    const extData = extDataWithTransition(2);
    const ns = await loadStoryOutline({ extData });
    // 只留一条：cursor 原来指着 2，必须夹到 1
    const after = ns.saveSceneTransitionEvents('p1', [{ title: '只剩一条', brief: '唯一' }]);
    assert.equal(after.transition.events.length, 1);
    assert.equal(after.transition.cursor, 1, '删掉几步后 cursor 不能悬空');
    // 没 brief 的空壳在落盘时被清掉（编辑期靠草稿兜着，见 transitionEditDraft）
    const emptied = ns.saveSceneTransitionEvents('p1', [{ title: '空壳' }]);
    assert.equal(emptied.transition, null, '全被清空 → 整段消失');
});

test('clearSceneTransition：删掉本段行程单，跨段闸门随之失效', async () => {
    const extData = extDataWithTransition(0);
    const ns = await loadStoryOutline({ extData });
    const after = ns.clearSceneTransition('p1');
    assert.equal(after.transition, null);
    ns.applySceneProgress('p1', 1);
    assert.equal(extData.story_outline_plans[0].progress.itemIndex, 1, '没有台阶就不该拦路');
});

test('clearSceneCandidates：换一步之后旧候选整批清掉', async () => {
    const extData = extDataWithTransition(0);
    extData.story_outline_plans[0].candidates = {
        items: [{ title: '旧', text: 't', itemIndex: 1, stepIndex: 1 }],
        generatedAt: 1,
    };
    const ns = await loadStoryOutline({ extData });
    assert.equal(ns.getSceneAdvanceState().candidates.length, 1);
    const after = ns.clearSceneCandidates('p1');
    assert.equal(after.candidates.length, 0);
});

test('行程单的 brief 与 span 一路带到 {{transitionContext}}（端到端串起来）', async () => {
    const extData = extDataWithTransition(1);
    const ns = await loadStoryOutline({ extData });
    const state = ns.getSceneAdvanceState();
    const items = state.items;
    const text = buildTransitionContextText(state.transition, items);
    assert.ok(text.includes('本段的用意：用意'));
    assert.ok(text.includes('[已走完]1. A（次日） —— a1'));
    assert.ok(text.includes('[当前这一步]2. B（三天后） —— b1'));
    assert.ok(text.includes('已走完 1 / 2 步'));
});

/* ------------------------------------------------------------------ *
 * 模板链的源码断言（本仓既有边界：sceneAdvanceBubble/api 无法被夹具加载）
 * ------------------------------------------------------------------ */

test('源码：rolling 默认模板已升到 1.8，带 step_index/from/step_state 契约', () => {
    const src = read('src/ui/storyOutlineWindow.js');
    const start = src.indexOf('rolling: {');
    const block = src.slice(start, src.indexOf('pacing: {', start));
    assert.ok(block.includes('"1.8"'), 'version 提到 1.8');
    assert.ok(block.includes('step_index'), '候选契约带 step_index');
    assert.ok(block.includes('{{transitionContext}}'), 'user 段引用行程单上下文');
    assert.ok(block.includes('"from"'), '候选契约带 from（承接点）');
    assert.ok(block.includes('"step_state"'), '顶层带 step_state（当前这一步演到哪了）');
});

test('源码：rolling 模板把最新一层回复当起点，并禁掉"复述这一步"', () => {
    const src = read('src/ui/storyOutlineWindow.js');
    const start = src.indexOf('rolling: {');
    const block = src.slice(start, src.indexOf('pacing: {', start));
    assert.ok(block.includes('{{latestReply}}'), 'user 段必须引用最新一层回复');
    assert.ok(block.includes('[起点与落点'), '起点/落点自成一节');
    assert.ok(block.includes('不是让你复述或扩写的稿子'), '点明 brief 不是要复写的稿子');
    assert.ok(!block.includes('针对行程单里当前那一步**来写'),
        '旧指令「针对行程单当前这一步来写（写出这一步具体怎么发生）」正是一切扩写的源头，不许回流');
});

test('源码：getPromptTemplates 有 step_index 与 latestReply 两档 legacy 重置', () => {
    const src = read('src/ui/storyOutlineWindow.js');
    assert.ok(src.includes('!sys.includes("step_index")'),
        '用户存着的 1.6 模板必须被探测并重置，否则按旧契约要求模型');
    assert.ok(src.includes('!usr.includes("{{latestReply}}")'),
        '1.7 模板不会填 from/step_state，不重置就等于续演约束没下');
});

test('源码：大纲重生成时清空行程单', () => {
    const src = read('src/ui/storyOutlineWindow.js');
    const start = src.indexOf('function applyParsedOutline');
    const block = src.slice(start, src.indexOf('\n}', start));
    assert.ok(block.includes('clearPlanTransitions(editingPlanId)'),
        '路标重画 ⇒ gap 全部失效，行程单必须一并清空');
});

test('源码：推荐提示词下发 transitionContext', () => {
    const src = read('src/ui/storyOutlineWindow.js');
    const start = src.indexOf('function buildRecommendationPrompt');
    const block = src.slice(start, src.indexOf('\n}', start));
    assert.ok(block.includes('transitionContext'));
});

test('源码：跨段闸门夹在 applyProgressFromModel 里', () => {
    const src = read('src/ui/storyOutlineWindow.js');
    const start = src.indexOf('function applyProgressFromModel');
    const block = src.slice(start, src.indexOf('\n}', start));
    assert.ok(block.includes('isTransitionDone') || block.includes('cursor'),
        '行程单没走完时不许把指针推过 fromIndex');
});

test('源码：气泡面板接上了新增的无头 API', () => {
    const src = read('src/ui/sceneAdvanceBubble.js');
    for (const name of ['generateSceneTransition', 'setSceneStep', 'crossSceneGap', 'saveSceneTransitionEvents', 'clearSceneTransition']) {
        assert.ok(src.includes(name), `sceneAdvanceBubble 应引用 ${name}`);
    }
});

test('源码：编辑框输入即写草稿（否则"改完字直接点完成编辑"会丢字）', () => {
    // 面板侧无法被夹具模块化加载，这条不变量只能用源码断言锁住。
    // 教训：早先的写法是"等结构操作时再从 DOM 捞一遍"，用户改完字直接点
    // 「完成编辑」或终点行就没有下一次读取，刚打的字静默消失。
    const src = read('src/ui/sceneAdvanceBubble.js');
    assert.ok(src.includes('"input", ".tsa-transition-edit-title, .tsa-transition-edit-span, .tsa-transition-edit-brief"'),
        '编辑框必须有 input 处理器实时回写 transitionEditDraft');
    assert.ok(!src.includes('flushTransitionEditDraft'),
        '不该再有"失焦后捞 DOM"的补丁路径——两条路并存必然漏一条');
});

test('源码：新模板类型 transition 在模板链各环节都登记了', () => {
    const src = read('src/ui/storyOutlineWindow.js');
    assert.ok(src.includes('transition: {'), 'getDefaultPromptTemplates 里有默认模板');
    assert.ok(src.includes('if (type === "transition")'), 'getPromptTemplateSection 有分支');
    assert.ok(src.includes('"gapPair"'), 'known vars 里有 gapPair');
    assert.ok(src.includes('value="transition"'), '设置面板 <option> 里有它');
});

test('sceneAdvanceBubble 能整个加载（缺 import / 顶层引用错会在这里炸）', async () => {
    // node --check 只验语法，验不出"少 import 一个符号、却在模块顶层用到了它"。
    // 本模块顶层就有 `let transitionCount = EVENT_COUNT_DEFAULT;`——正是这种形状，
    // 所以这条冒烟测试对新增的 transitionPlan 导入是有实质意义的。
    // 带宿主依赖的兄弟模块（blindboxReveal / unlockChime / pacingInjection 等）换成桩；
    // transitionPlan 是纯模块，让它真加载。
    const context = vm.createContext({ console, String, Number, Boolean, Math, JSON, Array, Object, Set, Symbol });
    const stubs = new Map([
        // 键必须与 link 时解析出的 specifier 完全一致：从 src/ui 起算四层（不是从 src）。
        [path.resolve(project, 'src/ui', '../../../../script.js'),
            'export const eventSource = { on() {} }; export const event_types = { GENERATION_ENDED: "g", CHAT_CHANGED: "c" };'],
        [path.join(project, 'src/utils/storage.js'), 'export const getExtData = () => ({}); export const saveExtData = () => {};'],
        [path.join(project, 'src/core/logger.js'), 'export const TitaniaLogger = { info(){}, warn(){}, error(){} };'],
        [path.join(project, 'src/core/pacingInjection.js'),
            'export const armPacingDirective = () => false; export const clearPacingDirective = () => {}; export const getArmedPacing = () => ({ armed: false });'],
        [path.join(project, 'src/core/blindboxPlan.js'),
            'export const isBlindboxPlan = () => false; export const normalizeBlindbox = b => b; export const getProgressStats = () => ({}); export const DIRECTOR_TURN = {}; export const describeDirectorTurn = () => "";'],
        [path.join(project, 'src/core/blindboxReveal.js'),
            'export const buildRevealView = () => []; export const resolveUnlocks = () => []; export const applyRevealMarks = b => b; export const backfillRevealMarks = b => b; export const pickUnlockCue = () => ""; export const getPassedMarks = () => []; export const getClearedStageIndexes = () => [];'],
        [path.join(project, 'src/core/unlockChime.js'),
            'export const getUnlockSoundConfig = () => ({}); export const cycleUnlockVolume = () => ({}); export const describeUnlockVolume = () => ""; export const playUnlockCue = () => {};'],
    ]);
    const modules = new Map();
    const moduleFor = id => {
        if (!modules.has(id)) modules.set(id, new vm.SourceTextModule(stubs.get(id) ?? readFileSync(id, 'utf8'), { context, identifier: id }));
        return modules.get(id);
    };
    const entry = moduleFor(path.join(project, 'src/ui/sceneAdvanceBubble.js'));
    if (entry.status === 'unlinked') await entry.link((specifier, ref) => moduleFor(path.resolve(path.dirname(ref.identifier), specifier)));
    if (entry.status === 'linked') await entry.evaluate();
    assert.equal(typeof entry.namespace.initSceneAdvanceBubble, 'function');
});
