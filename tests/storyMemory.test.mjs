import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
    MEMORY_KEY, MEMORY_HIDE_KEY, MEMORY_ID_KEY, newStoryMemory, planMemoryBatch,
    parseMemoryResponse, mergeMemoryResult, composeMemoryPrompt, snapshotMemoryState,
    rollbackMemory, copyMemory, memoryFloorFingerprint, normalizeMemoryConfig, MEMORY_DEFAULTS,
} from '../src/core/storyMemoryData.js';
import { tokenize, buildMemoryIndex, queryMemoryIndex } from '../src/core/memoryIndex.js';
import { relationNames, buildMemoryGraph, graphFocusNames, renderMemoryGraph } from '../src/ui/storyMemoryGraph.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const estimate = text => String(text).length;
const config = { keep_floors: 2, trigger_tokens: 100, trigger_floors: 2, batch_tokens: 1000, memory_tokens: 800 };
const clone = value => JSON.parse(JSON.stringify(value));
const makeChat = (pairs = 4) => [
    { name: '顾舟', is_user: false, mes: '故事开始，两人准备出发。' },
    ...Array.from({ length: pairs }, (_, i) => [
        { name: '林岚', is_user: true, mes: `第${i + 1}次交谈，我仍然怀疑钥匙的来历。` },
        { name: '顾舟', is_user: false, mes: `他们谈起旧宅钥匙，第${i + 1}次答应到达后解释。` },
    ]).flat(),
];
const response = (overrides = {}) => ({
    summary: '两人准备前往旧宅，顾舟答应解释钥匙的来历。',
    recap: '林岚怀疑顾舟隐瞒线索，两人仍决定同行。', scene: '前往旧宅途中，信任尚未恢复。',
    relationships: [{ id: '', title: '林岚 → 顾舟', body: '愿意合作但仍不信任；顾舟尚未解释钥匙来历。', evidence: '他们谈起旧宅钥匙' }],
    threads: [{ id: '', title: '钥匙的来历', body: '悬念与承诺：顾舟知道来历，林岚尚不知道；到达后解释的承诺未兑现。', status: 'open', evidence: '他们谈起旧宅钥匙' }],
    complete: true, ...overrides,
});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async (condition, label = 'condition') => {
    for (let i = 0; i < 300; i++) { if (condition()) return; await new Promise(resolve => setImmediate(resolve)); }
    assert.fail(`Did not settle: ${label}`);
};

async function loadRuntime(options = {}) {
    const chat = options.chat || makeChat();
    const memory = options.memory || { ...newStoryMemory(), enabled: true };
    let current = {
        chat, chatMetadata: { [MEMORY_KEY]: memory }, chatId: 'chatA', characterId: 0, groupId: null,
        characters: [{ name: '顾舟', avatar: 'character-a.png' }],
    };
    const data = { story_memory: { ...config }, config: { profiles: [] } };
    const events = new Map();
    const saves = [];
    const disk = new Map();
    const requests = [];
    const timers = new Map();
    let serial = 0;
    let saveNumber = 0;
    const dom = options.dom ? new JSDOM('<!doctype html><body><button id="prior">Open</button></body>') : null;
    const context = vm.createContext({
        console, AbortController, Date, Math, JSON, String, Number, Boolean, Array, Object, Set, Map, Promise,
        crypto: { randomUUID: () => `memory-${++serial}` },
        SillyTavern: { getContext: () => current },
        document: dom?.window.document, window: dom?.window,
        setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id; },
        clearTimeout: id => timers.delete(id),
        __data: data,
        __events: events,
        __save: async () => {
            const owner = current;
            const number = ++saveNumber;
            saves.push({ number, owner: owner.chatId, memory: clone(owner.chatMetadata[MEMORY_KEY]), flags: owner.chat.map(message => !!message.is_system) });
            if (options.onSave) await options.onSave(number);
            if (number === options.failSaveAt) return; // 模拟宿主吞掉保存错误。
            disk.set(owner.chatId, [{ chat_metadata: clone(owner.chatMetadata) }, ...clone(owner.chat)]);
        },
        __request: async (conn, messages, requestOptions) => {
            requests.push({ conn, messages, options: requestOptions });
            return options.request ? options.request(messages, requestOptions) : JSON.stringify(options.result || response());
        },
        fetch: async (url, opts) => {
            const body = JSON.parse(opts.body);
            return { ok: options.readFailure !== true, json: async () => disk.get(body.file_name || body.id) || [] };
        },
    });
    const core = path.join(project, 'src/core');
    const stubs = new Map([
        [path.resolve(core, '../../../../script.js'), `
            export const event_types = Object.fromEntries(['GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED','CHAT_CHANGED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPED','MESSAGE_SWIPE_DELETED'].map(k => [k,k]));
            export const eventSource = { on(name,callback){const list = __events.get(name) || []; list.push(callback); __events.set(name,list);} };
            export const extension_prompt_types = {IN_CHAT:1}; export const extension_prompt_roles = {SYSTEM:0};
            export function setExtensionPrompt(key,text,position,depth,scan,role){ globalThis.__injection = {key,text,position,depth,scan,role}; }
            export const saveChatConditional = __save; export const getRequestHeaders = () => ({}); export const refreshSwipeButtons = () => {};`],
        [path.join(project, 'src/utils/storage.js'), 'export const getExtData = () => __data; export const saveExtData = () => {};'],
        [path.join(project, 'src/utils/helpers.js'), 'export const estimateTokens = text => String(text).length;'],
        [path.join(core, 'connection.js'), `export const getActiveConnection = () => ({useSTConnection:true, model:'test'});
            export const getConnectionByProfileId = id => id === 'missing' ? null : ({useSTConnection:true,model:id});
            export const sendChatRequestWithConnection = __request;
            export const getAllProfiles = () => [{id:'st_sync',name:'跟随酒馆'}];`],
        [path.join(project, 'src/utils/dom.js'), 'export const ensureFeatureCss = () => {};'],
    ]);
    const modules = new Map();
    function moduleFor(id) {
        if (!modules.has(id)) modules.set(id, new vm.SourceTextModule(stubs.get(id) ?? readFileSync(id, 'utf8'), { context, identifier: id }));
        return modules.get(id);
    }
    const entry = moduleFor(path.join(core, 'storyMemory.js'));
    await entry.link((specifier, reference) => moduleFor(path.resolve(path.dirname(reference.identifier), specifier)));
    await entry.evaluate();
    const ui = async () => {
        const module = moduleFor(path.join(project, 'src/ui/storyMemoryWindow.js'));
        await module.link((specifier, reference) => moduleFor(path.resolve(path.dirname(reference.identifier), specifier)));
        await module.evaluate();
        return module.namespace;
    };
    return {
        ns: entry.namespace, chat, data, disk, saves, requests, timers, context, dom, ui,
        get current() { return current; },
        setCurrent: value => { current = value; },
        emit: async name => { for (const callback of events.get(name) || []) await callback(); },
        emitArgs: async (name, ...args) => { for (const callback of events.get(name) || []) await callback(...args); },
    };
}

test('配置里没有"单独指定总结模型"这一项，老配置存过的 model 会被丢掉', () => {
    // 界面上的「总结模型覆盖」已移除。字段若还留在配置里，就是一个看不见却仍在生效的
    // 模型覆盖——那比没有这项更难排查。
    assert.equal('model' in MEMORY_DEFAULTS, false, '默认值里不该还有 model');
    const config = normalizeMemoryConfig({ model: 'gpt-4o', keep_floors: 8 });
    assert.equal('model' in config, false, '老配置里存过的 model 也要在规范化时丢掉');
    assert.equal(config.keep_floors, 8, '别的字段照常生效');
});

test('整段对话切分：保留最近完整轮次，不读取其他插件隐藏的正文', () => {
    const chat = makeChat(); chat[2].is_system = true;
    const batch = planMemoryBatch(chat, newStoryMemory(), config, estimate, true);
    assert.equal(batch.start, 0); assert.equal(batch.end, 6); assert.equal(batch.keepStart, 7);
    assert.ok(!batch.text.includes('[#2 ')); assert.ok(!batch.text.includes('[#7 '));
    assert.ok(batch.text.includes('[#6 '));
});

test('单组对话超大时保留全文，不截断后隐藏', () => {
    const chat = makeChat().slice(1); chat[0].mes = '字'.repeat(1500);
    assert.throws(() => planMemoryBatch(chat, newStoryMemory(), config, estimate, true), /完整对话超过/);
    assert.ok(chat.every(message => !message.is_system));
});

test('短聊天与低于触发条件的旧正文不会调用总结', () => {
    assert.equal(planMemoryBatch(makeChat(1), newStoryMemory(), config, estimate), null);
    assert.equal(planMemoryBatch(makeChat(), newStoryMemory(), { ...config, trigger_tokens: 900, trigger_floors: 20 }, estimate), null);
});

test('完整结构与真实原文依据是隐藏的前提，不修补截断JSON', () => {
    const batch = planMemoryBatch(makeChat(), newStoryMemory(), config, estimate, true);
    assert.throws(() => parseMemoryResponse(JSON.stringify(response()).slice(0, -1), batch), /完整 JSON/);
    assert.throws(() => parseMemoryResponse(JSON.stringify(response({ complete: false })), batch), /完整的剧情/);
    assert.throws(() => parseMemoryResponse(JSON.stringify(response({ threads: [{ id: '', title: '钥匙', body: '已经解决', status: 'resolved', evidence: '钥匙是父亲遗物' }] })), batch), /原文依据/);
    assert.equal(parseMemoryResponse('```json\n' + JSON.stringify(response()) + '\n```', batch).complete, true);
});

test('增量更新沿用条目ID，未提及的伏笔保留，锁定变化成为建议', () => {
    const batch = planMemoryBatch(makeChat(), newStoryMemory(), config, estimate, true);
    const first = mergeMemoryResult(newStoryMemory(), response(), batch, 's1');
    const relationship = first.relationships[0]; relationship.locked = true;
    const changed = response({ relationships: [{ ...response().relationships[0], id: relationship.id, body: '已明确和解。' }], threads: [] });
    const next = mergeMemoryResult(first, changed, batch, 's2');
    assert.equal(next.relationships.length, 1); assert.equal(next.threads.length, 1);
    assert.equal(next.relationships[0].body, relationship.body);
    assert.equal(next.relationships[0].pending.body, '已明确和解。');
});

test('拒绝模型引用不存在的条目，防止无效更新后推进隐藏范围', () => {
    const batch = planMemoryBatch(makeChat(), newStoryMemory(), config, estimate, true);
    assert.throws(() => mergeMemoryResult(newStoryMemory(), response({ relationships: [{ ...response().relationships[0], id: 'unknown' }] }), batch, 's'), /不存在的条目/);
});

test('注入保留历史与锁定条目、归档已解决伏笔、明确报告预算遗漏', () => {
    const memory = newStoryMemory(); memory.recap = '已经同行。';
    memory.relationships = [{ id: 'r', title: '重要关系', body: '字'.repeat(500), locked: true }, { id: 'r2', title: '其他关系', body: '字'.repeat(500) }];
    memory.threads = [{ id: 't', title: '已解谜题', body: '已找到答案', status: 'resolved' }];
    const prompt = composeMemoryPrompt(memory, { memory_tokens: 300 }, estimate);
    assert.ok(prompt.text.includes('重要关系')); assert.ok(prompt.text.includes('已经同行'));
    assert.ok(!prompt.text.includes('已解谜题')); assert.ok(prompt.overBudget);
    assert.deepEqual(prompt.omitted, ['其他关系']);
});

test('回滚撤去未来信息，保留不依赖旧正文的人工条目', () => {
    const memory = newStoryMemory();
    const before = snapshotMemoryState(memory);
    memory.recap = '未来事件'; memory.segments = [{ id: 's', start: 0, end: 6, before }];
    memory.threads = [
        { id: 'independent', title: '手工约定', body: '保留', manual: true, sources: [] },
        { id: 'future', title: '未来真相', body: '撤回', locked: true, sources: [{ start: 3, end: 6 }] },
    ];
    const next = rollbackMemory(memory, 0);
    assert.equal(next.recap, ''); assert.deepEqual(next.threads.map(item => item.id), ['independent']);
});

test('中文按字二元组切词，英文与数字按连续片段切词', () => {
    assert.deepEqual(tokenize('旧宅钥匙 key2'), ['旧宅', '宅钥', '钥匙', 'key2']);
    assert.deepEqual(tokenize('顾舟，林岚。'), ['顾舟', '林岚']);
    assert.deepEqual(tokenize('  '), []);
});

test('BM25 召回：最近对话命中哪段旧事就取哪段，原文摘句也参与匹配', () => {
    const memory = newStoryMemory();
    memory.segments = [
        { id: 's1', start: 0, end: 6, summary: '两人在旧宅门口找到一把铜钥匙。', sources: [] },
        { id: 's2', start: 7, end: 12, summary: '林岚与顾舟乘渡船前往海岛。', sources: [] },
    ];
    memory.relationships = [{
        id: 'r1', title: '林岚 → 顾舟', body: '钥匙的来历仍有隐瞒。',
        sources: [{ segmentId: 's1', evidence: '钥匙是父亲留下的遗物' }],
    }];
    const index = buildMemoryIndex(memory);
    const hits = queryMemoryIndex(index, '你还记得父亲留下的那把钥匙吗', { limit: 2 });
    assert.equal(hits[0].id, 's1', '摘要写了「钥匙」、摘句写了「父亲留下的遗物」，应排第一');
    assert.ok(hits[0].evidence.includes('钥匙是父亲留下的遗物'));
    assert.equal(queryMemoryIndex(index, '渡船去海岛', { limit: 2 })[0].id, 's2');
    assert.deepEqual(queryMemoryIndex(index, '完全不相关的句子', { limit: 2 }), []);
    assert.deepEqual(queryMemoryIndex(index, '钥匙', { limit: 0 }), [], 'limit=0 表示关闭召回');
});

test('召回使用独立预算，放不下的整块略过并报告', () => {
    const memory = newStoryMemory(); memory.recap = '历史脉络。';
    const recalled = [
        { id: 's1', title: '第 0～6 楼', summary: '旧宅钥匙的细节。' },
        { id: 's2', title: '第 7～12 楼', summary: '渡船上的约定。' },
    ];
    const roomy = composeMemoryPrompt(memory, { memory_tokens: 1000, recall_tokens: 500 }, estimate, { recalled });
    assert.equal(roomy.recalled.length, 2);
    assert.ok(roomy.text.includes('[旧事回忆：第 0～6 楼]'));
    assert.ok(roomy.recallTokens > 0);
    assert.ok(roomy.tokens >= roomy.memoryTokens + roomy.recallTokens);

    const tight = composeMemoryPrompt(memory, { memory_tokens: 1000, recall_tokens: 1 }, estimate, { recalled });
    assert.equal(tight.recalled.length, 0);
    assert.deepEqual(tight.recallOmitted, ['第 0～6 楼', '第 7～12 楼']);
    assert.ok(!tight.text.includes('旧事回忆'));

    const off = composeMemoryPrompt(memory, { memory_tokens: 1000, recall_tokens: 0 }, estimate, { recalled });
    assert.equal(off.recalled.length, 0);
    assert.deepEqual(off.recallOmitted, [], '预算 0 是主动关闭，不算遗漏');
});

test('召回会把摘要里没有的原文摘句一并带上，重复的不再抄一遍', () => {
    const memory = newStoryMemory(); memory.recap = '历史。';
    const prompt = composeMemoryPrompt(memory, { memory_tokens: 1000, recall_tokens: 500 }, estimate, {
        recalled: [{
            id: 's1', title: '第 0～6 楼', summary: '两人回到旧宅，钥匙仍在顾舟手里。',
            evidence: ['钥匙仍在顾舟手里', '钥匙是父亲留下的遗物'],
        }],
    });
    assert.ok(prompt.text.includes('原文摘句：钥匙是父亲留下的遗物'));
    assert.equal(prompt.text.split('钥匙仍在顾舟手里').length - 1, 1, '摘要里已有的句子不重复注入');
});

test('最近分段摘要直接注入：取最近几段、按时间顺序、使用独立预算', () => {
    const memory = newStoryMemory();
    memory.recap = '完整历史脉络。';
    memory.segments = [
        { id: 's1', start: 0, end: 6, summary: '第一段的细节。' },
        { id: 's2', start: 7, end: 12, summary: '第二段的细节。' },
        { id: 's3', start: 13, end: 18, summary: '第三段的细节。' },
    ];
    const prompt = composeMemoryPrompt(memory, { memory_tokens: 1000, recent_segments: 2, recent_tokens: 500 }, estimate);
    assert.deepEqual(prompt.recent.map(entry => entry.id), ['s2', 's3'], '只取最近两段');
    assert.ok(prompt.text.indexOf('[最近分段：第 7～12 楼]') < prompt.text.indexOf('[最近分段：第 13～18 楼]'), '按时间顺序输出');
    assert.ok(prompt.text.indexOf('第三段的细节') < prompt.text.indexOf('[历史脉络]'), '最近分段排在历史脉络之前');
    assert.ok(prompt.text.includes('两者不一致时，以分段摘要为准'));
    assert.ok(prompt.recentTokens > 0);

    const off = composeMemoryPrompt(memory, { memory_tokens: 1000, recent_segments: 2, recent_tokens: 0 }, estimate);
    assert.equal(off.recent.length, 0);
    assert.ok(!off.text.includes('[最近分段'));
});

test('已被最近分段直接注入的段落不会在召回里重复出现', () => {
    const memory = newStoryMemory(); memory.recap = '历史。';
    memory.segments = [{ id: 's3', start: 13, end: 18, summary: '第三段的细节。' }];
    const prompt = composeMemoryPrompt(
        memory,
        { memory_tokens: 1000, recent_segments: 2, recent_tokens: 500, recall_tokens: 500 },
        estimate,
        { recalled: [{ id: 's3', title: '第 13～18 楼', summary: '第三段的细节。', evidence: [] }] },
    );
    assert.equal(prompt.recent.length, 1);
    assert.equal(prompt.recalled.length, 0);
    assert.equal(prompt.text.split('第三段的细节').length - 1, 1);
});

test('关系图：拆分关系方向、连接人物与伏笔、节点聚焦', () => {
    assert.deepEqual(relationNames('林岚 → 顾舟'), ['林岚', '顾舟']);
    assert.deepEqual(relationNames('没有方向的关系'), ['没有方向的关系', '']);
    const memory = newStoryMemory();
    memory.relationships = [
        { id: 'r1', title: '林岚 → 顾舟', body: '顾舟隐瞒了钥匙的来历。' },
        { id: 'r2', title: '林岚 → 父亲', body: '父亲留下遗物。' },
    ];
    memory.threads = [
        { id: 't1', title: '钥匙的来历', body: '顾舟知道钥匙的来历。', status: 'open' },
        { id: 't2', title: '旧宅的秘密', body: '与人物无关。', status: 'resolved' },
    ];
    const graph = buildMemoryGraph(memory);
    assert.deepEqual(graph.nodes.filter(node => node.kind === 'character').map(node => node.name).sort(), ['林岚', '顾舟', '父亲'].sort());
    assert.equal(graph.edges.length, 2);
    assert.ok(graph.links.some(link => link.a === 't:t1' && link.b === 'c:顾舟'));
    assert.deepEqual(graphFocusNames(memory, 'c:林岚'), ['林岚']);
    assert.deepEqual(graphFocusNames(memory, 't:t1'), ['顾舟']);
    const html = renderMemoryGraph(memory, { selected: 'c:林岚' });
    assert.ok(html.includes('data-node="c:林岚"'));
    assert.ok(html.includes('t-memory-graph-edge'));
});

test('后台成功：先确认摘要保存，再隐藏，最近正文保持完整', async () => {
    const host = await loadRuntime();
    assert.equal(await host.ns.runStoryMemory(true), true);
    assert.equal(host.saves.length, 2);
    assert.ok(host.saves[0].flags.every(flag => !flag));
    assert.ok(host.saves[1].flags.slice(0, 7).every(Boolean));
    assert.ok(host.chat.slice(7).every(message => !message.is_system));
    assert.equal(host.current.chatMetadata[MEMORY_KEY].segments[0].end, 6);
    assert.ok(host.context.__injection.text.includes('故事记忆'));
    assert.equal(host.requests[0].options.respectRequestLimits, true);
});

test('注入时按最近对话召回旧段落，关掉召回则回到纯记忆', async () => {
    const memory = {
        ...newStoryMemory(), enabled: true, recap: '两人仍在旅途中。',
        segments: [{ id: 's1', start: 0, end: 6, sources: [], summary: '旧宅的铜钥匙是父亲留下的遗物。' }],
    };
    const host = await loadRuntime({ memory });
    host.data.story_memory = { ...host.data.story_memory, recent_segments: 0, recall_segments: 3, recall_tokens: 1200 };
    const view = host.ns.getStoryMemoryView();
    assert.equal(view.injection.recalled.length, 1);
    assert.ok(view.injection.text.includes('[旧事回忆：第 0～6 楼]'));
    assert.ok(view.injection.text.includes('父亲留下的遗物'));

    host.data.story_memory = { ...host.data.story_memory, recall_segments: 0 };
    const off = host.ns.getStoryMemoryView();
    assert.equal(off.injection.recalled.length, 0);
    assert.ok(!off.injection.text.includes('旧事回忆'));
});

test('注入时直接带上最近分段摘要，同一段不再重复召回', async () => {
    const memory = {
        ...newStoryMemory(), enabled: true, recap: '两人仍在旅途中。',
        segments: [{ id: 's1', start: 0, end: 6, sources: [], summary: '旧宅的铜钥匙是父亲留下的遗物。' }],
    };
    const host = await loadRuntime({ memory });
    host.data.story_memory = { ...host.data.story_memory, recent_segments: 2, recent_tokens: 1000, recall_segments: 3, recall_tokens: 1200 };
    const view = host.ns.getStoryMemoryView();
    assert.equal(view.injection.recent.length, 1);
    assert.ok(view.injection.text.includes('[最近分段：第 0～6 楼]'));
    assert.ok(view.injection.text.includes('父亲留下的遗物'));
    assert.equal(view.injection.recalled.length, 0, '已直接注入的段落不重复召回');
    assert.ok(view.injection.tokens >= view.injection.memoryTokens + view.injection.recentTokens);
});

test('宿主吞掉第一次保存失败时不隐藏，也不留下内存中的无效摘要', async () => {
    const host = await loadRuntime({ failSaveAt: 1 });
    await assert.rejects(host.ns.runStoryMemory(true), /未成功保存/);
    assert.ok(host.chat.every(message => !message.is_system));
    assert.equal(host.current.chatMetadata[MEMORY_KEY].segments.length, 0);
});

test('隐藏后的保存失败时恢复本次正文及上一版记忆', async () => {
    const host = await loadRuntime({ failSaveAt: 2 });
    await assert.rejects(host.ns.runStoryMemory(true), /未成功保存/);
    assert.ok(host.chat.every(message => !message.is_system));
    assert.equal(host.current.chatMetadata[MEMORY_KEY].segments.length, 0);
    assert.ok(host.chat.every(message => !message.extra?.[MEMORY_HIDE_KEY]));
});

test('格式错误、空字段及原文依据不符时不保存、不隐藏', async () => {
    const host = await loadRuntime({ result: response({ scene: '' }) });
    await assert.rejects(host.ns.runStoryMemory(true), /完整的剧情/);
    assert.equal(host.saves.length, 0); assert.ok(host.chat.every(message => !message.is_system));
});

test('撤销只恢复本功能隐藏的楼层，并暂停自动整理', async () => {
    const chat = makeChat(); chat[2].is_system = true;
    const host = await loadRuntime({ chat });
    await host.ns.runStoryMemory(true);
    assert.equal(chat[2].extra[MEMORY_HIDE_KEY], undefined);
    await host.ns.undoStoryMemory();
    assert.equal(chat[2].is_system, true);
    assert.ok(chat.filter((_, i) => i !== 2).every(message => !message.is_system));
    assert.equal(host.current.chatMetadata[MEMORY_KEY].enabled, false);
    assert.equal(host.context.__injection.text, '');
});

test('修改旧楼时先撤回失效记忆、恢复正文，然后重新整理', async () => {
    const host = await loadRuntime(); await host.ns.runStoryMemory(true); host.ns.initStoryMemory();
    host.chat[2].mes = '他们谈起旧宅钥匙，现在双方产生了不同理解。';
    await host.emit('MESSAGE_EDITED');
    await settle(() => !host.ns.getStoryMemoryView().busy);
    assert.equal(host.current.chatMetadata[MEMORY_KEY].segments.length, 0);
    assert.ok(host.chat.every(message => !message.is_system));
    assert.equal(host.context.__injection.text, '');
    assert.equal(await host.ns.runStoryMemory(true), true);
});

test('安全文本补丁的专用事件也会撤回依赖旧正文的记忆', async () => {
    const host = await loadRuntime(); await host.ns.runStoryMemory(true); host.ns.initStoryMemory();
    host.chat[2].mes = '他们谈起旧宅钥匙，现在双方产生了不同理解。';
    await host.emit('titania_text_patched');
    await settle(() => !host.ns.getStoryMemoryView().busy);
    assert.equal(host.current.chatMetadata[MEMORY_KEY].segments.length, 0);
    assert.ok(host.chat.every(message => !message.is_system));
    assert.equal(host.context.__injection.text, '');
});

test('分支截断会撤回越过分叉点的摘要，不改变父聊天', async () => {
    const host = await loadRuntime(); await host.ns.runStoryMemory(true); host.ns.initStoryMemory();
    const parent = host.current;
    const branch = { ...parent, chatId: 'branch', chat: clone(parent.chat.slice(0, 4)), chatMetadata: clone(parent.chatMetadata) };
    host.setCurrent(branch);
    await host.emit('CHAT_CHANGED');
    await host.emitArgs('GENERATION_STARTED', 'normal', {}, false);
    assert.equal(branch.chatMetadata[MEMORY_KEY].segments.length, 0);
    assert.ok(branch.chat.every(message => !message.is_system));
    assert.equal(parent.chatMetadata[MEMORY_KEY].segments.length, 1);
    assert.ok(parent.chat.slice(0, 7).every(message => message.is_system));
});

test('总结期间继续聊天：本轮保留正文，结果在结束后统一应用', async () => {
    const request = deferred(); const host = await loadRuntime({ request: () => request.promise });
    host.ns.initStoryMemory();
    const work = host.ns.runStoryMemory(true);
    await settle(() => host.requests.length === 1);
    await host.emitArgs('GENERATION_STARTED', 'normal', {}, false);
    request.resolve(JSON.stringify(response()));
    assert.equal(await work, false);
    assert.equal(host.ns.getStoryMemoryView().status, 'waiting');
    assert.ok(host.chat.every(message => !message.is_system));
    await host.emit('GENERATION_ENDED');
    await settle(() => host.current.chatMetadata[MEMORY_KEY].segments.length === 1 && !host.ns.getStoryMemoryView().busy);
    assert.ok(host.chat.slice(0, 7).every(message => message.is_system));
});

test('提示词构造等待已开始的保存完成，避免读取半次提交', async () => {
    const firstSave = deferred();
    const host = await loadRuntime({ onSave: number => number === 1 ? firstSave.promise : undefined });
    host.ns.initStoryMemory(); const work = host.ns.runStoryMemory(true);
    await settle(() => host.saves.length === 1);
    let promptReady = false;
    const generation = host.emitArgs('GENERATION_STARTED', 'normal', {}, false).then(() => { promptReady = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(promptReady, false); assert.ok(host.chat.every(message => !message.is_system));
    firstSave.resolve(); await work; await generation;
    assert.ok(host.chat.slice(0, 7).every(message => message.is_system));
    assert.ok(host.context.__injection.text.includes('历史脉络'));
});

test('请求中切换聊天会丢弃旧结果，清除旧注入，不写入新聊天', async () => {
    const request = deferred(); const host = await loadRuntime({ request: () => request.promise });
    host.ns.initStoryMemory(); const parent = host.current;
    const work = host.ns.runStoryMemory(true); await settle(() => host.requests.length === 1);
    const other = { ...parent, chatId: 'chatB', chat: makeChat(), chatMetadata: {} };
    host.setCurrent(other); await host.emit('CHAT_CHANGED'); request.resolve(JSON.stringify(response())); await work;
    assert.equal(host.saves.length, 0);
    assert.ok(parent.chat.every(message => !message.is_system)); assert.ok(other.chat.every(message => !message.is_system));
    assert.equal(other.chatMetadata[MEMORY_KEY], undefined); assert.equal(host.context.__injection.text, '');
});

test('保存中切换聊天只恢复捕获的旧对象，不操作新聊天DOM或保存新聊天', async () => {
    const save = deferred(); const host = await loadRuntime({ onSave: number => number === 1 ? save.promise : undefined });
    host.ns.initStoryMemory(); const parent = host.current;
    const work = host.ns.runStoryMemory(true); await settle(() => host.saves.length === 1);
    const other = { ...parent, chatId: 'chatB', chat: makeChat(), chatMetadata: {} };
    host.setCurrent(other); await host.emit('CHAT_CHANGED'); save.resolve(); await work;
    assert.equal(host.saves.length, 1); assert.equal(host.saves[0].owner, 'chatA');
    assert.ok(other.chat.every(message => !message.is_system)); assert.equal(other.chatMetadata[MEMORY_KEY], undefined);
});

test('暂停后台保留已有注入；人工编辑及采用建议会保存关系、状态和来源', async () => {
    const host = await loadRuntime(); await host.ns.runStoryMemory(true);
    const id = host.current.chatMetadata[MEMORY_KEY].relationships[0].id;
    await host.ns.editStoryMemoryItem('relationships', id, { title: '林岚 → 顾舟', body: '仍然合作，但不信任。' });
    assert.equal(host.current.chatMetadata[MEMORY_KEY].relationships[0].manual, true);
    await host.ns.setStoryMemoryEnabled(false);
    assert.ok(host.context.__injection.text.includes('仍然合作，但不信任'));
    await host.ns.editStoryMemoryItem('relationships', id, {}, 'lock');
    const item = host.current.chatMetadata[MEMORY_KEY].relationships[0];
    item.pending = { title: item.title, body: '顾舟解释后，信任开始恢复。', status: 'active', source: { start: 2, end: 6, evidence: '他们谈起旧宅钥匙' } };
    await host.ns.editStoryMemoryItem('relationships', id, {}, 'accept');
    assert.equal(host.current.chatMetadata[MEMORY_KEY].relationships[0].pending, undefined);
    assert.ok(host.current.chatMetadata[MEMORY_KEY].relationships[0].body.includes('信任开始恢复'));
});

test('保存残留的第一阶段摘要可在重新加载后完成隐藏', async () => {
    const host = await loadRuntime(); await host.ns.runStoryMemory(true);
    const state = clone(host.current.chatMetadata[MEMORY_KEY]); state.segments[0].applied = false;
    const chat = clone(host.chat);
    for (const message of chat) { message.is_system = false; delete message.extra?.[MEMORY_HIDE_KEY]; }
    const resumed = await loadRuntime({ chat, memory: state });
    resumed.ns.initStoryMemory();
    await resumed.emitArgs('GENERATION_STARTED', 'normal', {}, false);
    assert.equal(resumed.current.chatMetadata[MEMORY_KEY].segments[0].applied, true);
    assert.ok(chat.slice(0, 7).every(message => message.is_system));
    assert.equal(resumed.requests.length, 0);
});

test('群聊使用群聊读取接口确认保存，条目依然按聊天隔离', async () => {
    const host = await loadRuntime();
    host.setCurrent({ ...host.current, groupId: 'group1', chatId: 'groupchat' });
    assert.equal(await host.ns.runStoryMemory(true), true);
    assert.ok(host.disk.get('groupchat')[0].chat_metadata[MEMORY_KEY].segments.length);
});

test('总结方案不存在时不回退到别的模型、不隐藏正文', async () => {
    const host = await loadRuntime(); host.data.story_memory.profile_id = 'missing';
    await assert.rejects(host.ns.runStoryMemory(true), /方案已不存在/);
    assert.equal(host.requests.length, 0); assert.ok(host.chat.every(message => !message.is_system));
});

test('整理时用所选 API 方案自带的模型，不再吃旧配置里的模型覆盖', async () => {
    const host = await loadRuntime();
    host.data.story_memory = { ...host.data.story_memory, profile_id: 'team-a', model: 'gpt-4o' };
    assert.equal(await host.ns.runStoryMemory(true), true);
    assert.equal(host.requests.length, 1);
    assert.equal(host.requests[0].conn.model, 'team-a', '模型由所选方案决定');
    assert.equal(host.requests[0].options.model, undefined, '请求里不再单独塞 model');
});

test('运行设置是独立窗口，从顶栏齿轮进入；模型覆盖已移除，各项标签不再用术语', async () => {
    const host = await loadRuntime({ dom: true, memory: newStoryMemory() });
    const ui = await host.ui(); const close = ui.openStoryMemoryWindow();
    const document = host.dom.window.document;
    assert.equal(document.querySelector('[data-tab="settings"]'), null, '运行设置不再占故事记忆的页签');
    document.querySelector('[data-action="settings"]').click();
    const panel = document.querySelector('.t-memory-settings-window');
    assert.ok(panel, '顶栏齿轮应打开独立的运行设置窗口');
    const grid = panel.querySelector('.t-memory-settings-grid');
    assert.ok(grid, '运行设置页要能渲染');
    assert.equal(panel.querySelector('[data-setting="model"]'), null, '「总结模型覆盖」那一项已经移除');
    for (const key of ['profile_id', 'keep_floors', 'trigger_tokens', 'trigger_floors', 'batch_tokens', 'memory_tokens', 'max_output_tokens', 'recent_segments', 'recent_tokens', 'recall_segments', 'recall_tokens', 'inject_depth']) {
        assert.ok(panel.querySelector(`[data-setting="${key}"]`), `运行设置缺了 ${key}`);
    }
    assert.equal(panel.querySelector('[data-setting="max_output_tokens"]').hasAttribute('max'), false, '输出上限不再写死最大值');
    assert.equal(panel.querySelector('[data-setting="batch_tokens"]').hasAttribute('max'), false, '读取上限不再写死最大值');
    // 标签一律写成"填进去的数是干什么用的"：这些旧术语是用户看不懂的源头，不许回流。
    for (const jargon of ['总结模型覆盖', '旧正文触发', '注入深度', '目标预算', '单次正文读取上限', '至少保留最近楼层']) {
        assert.equal(grid.innerHTML.includes(jargon), false, `仍是术语：${jargon}`);
    }
    const output = panel.querySelector('[data-setting="max_output_tokens"]');
    output.value = '20000';
    output.dispatchEvent(new host.dom.window.Event('input', { bubbles: true }));
    panel.querySelector('[data-action="save"]').click();
    assert.equal(host.data.story_memory.max_output_tokens, 20000, '设置窗口保存后应即时落盘');
    assert.equal(panel.querySelector('[data-role="status"]').textContent, '已保存');
    document.dispatchEvent(new host.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(document.querySelector('.t-memory-settings-window'), null, 'Esc 只关设置窗口');
    assert.ok(document.querySelector('.t-memory-overlay'), '故事记忆应保持打开');
    close();
});

test('输出 token 上限可随意填写，并真正用于整理请求', async () => {
    assert.equal(normalizeMemoryConfig({ max_output_tokens: 128000 }).max_output_tokens, 128000);
    assert.equal(normalizeMemoryConfig({ recent_tokens: 999999 }).recent_tokens, 999999, '最近分段预算也不设上限');
    assert.equal(normalizeMemoryConfig({ recall_tokens: 999999 }).recall_tokens, 999999, '召回预算也不设上限');
    const host = await loadRuntime();
    host.data.story_memory = { ...host.data.story_memory, max_output_tokens: 8192 };
    assert.equal(await host.ns.runStoryMemory(true), true);
    assert.equal(host.requests[0].options.maxTokens, 8192);
});

test('当前剧情仪表盘：进度、四个统计块与页签跳转', async () => {
    const host = await loadRuntime({ dom: true, memory: newStoryMemory() });
    const ui = await host.ui(); const close = ui.openStoryMemoryWindow();
    const document = host.dom.window.document;
    assert.ok(document.querySelector('.t-memory-progress'), '仪表盘要显示整理进度');
    assert.equal(document.querySelectorAll('.t-memory-stat').length, 4);
    document.querySelector('.t-memory-stat[data-jump-tab="relationships"]').click();
    assert.ok(document.querySelector('[data-tab="relationships"]').classList.contains('is-active'), '统计块应跳到人物关系');
    close();
});

test('人物关系：头像关系卡、待确认建议、来源楼层与关系图聚焦', async () => {
    const memory = {
        ...newStoryMemory(), enabled: true,
        relationships: [
            {
                id: 'r1', title: '林岚 → 顾舟', body: '愿意合作，但仍怀疑钥匙的来历。',
                locked: false, manual: false,
                sources: [{ start: 0, end: 6, evidence: '他们谈起旧宅钥匙' }],
                pending: { title: '林岚 → 顾舟', body: '信任开始恢复。', source: { segmentId: 's1', start: 0, end: 6, evidence: '他们谈起旧宅钥匙' } },
            },
            { id: 'r2', title: '林岚 → 父亲', body: '父亲留下遗物。', locked: true, manual: true, sources: [] },
        ],
        threads: [{ id: 't1', title: '钥匙的来历', body: '顾舟知道钥匙的来历。', status: 'open', sources: [] }],
    };
    const host = await loadRuntime({ dom: true, memory });
    const ui = await host.ui(); const close = ui.openStoryMemoryWindow();
    const document = host.dom.window.document;
    document.querySelector('[data-tab="relationships"]').click();
    assert.equal(document.querySelectorAll('.t-memory-rel-card').length, 2);
    assert.equal(document.querySelectorAll('.t-memory-avatar').length, 4, '两段关系各两个人物头像');
    assert.ok(document.querySelector('.t-memory-suggestion'), '待确认建议要直接显示');
    assert.ok(document.querySelector('.t-memory-source-chip'), '来源楼层要显示为 chip');
    assert.equal(document.querySelectorAll('.t-memory-graph-node').length, 4, '3 个人物 + 1 个伏笔');

    document.querySelector('.t-memory-graph-node[data-node="c:顾舟"]').dispatchEvent(new host.dom.window.Event('click', { bubbles: true }));
    assert.equal(document.querySelectorAll('.t-memory-rel-card').length, 1, '聚焦后只显示相关关系');
    assert.ok(document.querySelector('.t-memory-rel-card.is-focus'));
    assert.ok(document.querySelector('.t-memory-graph-focus'));
    close();
});

test('伏笔：按状态分组，筛选与搜索保持输入焦点', async () => {
    const memory = {
        ...newStoryMemory(), enabled: true,
        threads: [
            { id: 't1', title: '钥匙的来历', body: '顾舟知道。', status: 'open', sources: [] },
            { id: 't2', title: '父亲的遗愿', body: '已经找到第一件。', status: 'progress', sources: [] },
            { id: 't3', title: '旧宅的秘密', body: '已经解开。', status: 'resolved', sources: [] },
        ],
    };
    const host = await loadRuntime({ dom: true, memory });
    const ui = await host.ui(); const close = ui.openStoryMemoryWindow();
    const document = host.dom.window.document;
    document.querySelector('[data-tab="threads"]').click();
    assert.equal(document.querySelectorAll('.t-memory-thread-card').length, 3);
    assert.equal(document.querySelectorAll('.t-memory-group-head').length, 2, '未解决/有进展各一组，已解决在折叠区');
    assert.ok(document.querySelector('.t-memory-thread-card.is-open'));
    assert.ok(document.querySelector('.t-memory-thread-card.is-progress'));
    assert.ok(document.querySelector('.t-memory-thread-card.is-resolved'));

    document.querySelector('[data-action="set-filter"][data-filter="progress"]').click();
    assert.equal(document.querySelectorAll('.t-memory-thread-card').length, 1);
    document.querySelector('[data-action="set-filter"][data-filter="all"]').click();

    const search = document.querySelector('[data-role="memory-search"]');
    search.focus();
    search.value = '钥匙';
    search.dispatchEvent(new host.dom.window.Event('input', { bubbles: true }));
    assert.equal(document.querySelectorAll('.t-memory-thread-card').length, 1);
    assert.equal(document.activeElement, document.querySelector('[data-role="memory-search"]'), '搜索时保持焦点');
    close();
});

test('界面可开启后台、手动新增条目、编辑内容，模型文本不会变成HTML', async () => {
    const host = await loadRuntime({ dom: true, memory: newStoryMemory() });
    const ui = await host.ui(); const close = ui.openStoryMemoryWindow(); const document = host.dom.window.document;
    assert.equal(document.querySelectorAll('[data-tab]').length, 5);
    const enabled = document.querySelector('[data-role="enabled"]'); enabled.checked = true;
    enabled.dispatchEvent(new host.dom.window.Event('change', { bubbles: true }));
    await settle(() => host.current.chatMetadata[MEMORY_KEY].enabled && !host.ns.getStoryMemoryView().busy);
    assert.equal(document.querySelector('[data-role="enabled"]').checked, true);
    document.querySelector('[data-tab="relationships"]').click(); document.querySelector('[data-action="add"]').click();
    for (const [field, value] of [['title', '<img src=x onerror=alert(1)>'], ['body', '手动记录：愿意合作但仍不信任。']]) {
        const input = document.querySelector(`[data-field="${field}"]`); input.value = value;
        input.dispatchEvent(new host.dom.window.Event('input', { bubbles: true }));
    }
    document.querySelector('[data-action="save-edit"]').click();
    await settle(() => host.current.chatMetadata[MEMORY_KEY].relationships.length === 1 && !document.querySelector('[data-field="title"]'));
    assert.equal(document.querySelectorAll('.t-memory-card img').length, 0);
    assert.ok(document.querySelector('.t-memory-card').textContent.includes('<img src=x onerror=alert(1)>'));
    close(); assert.equal(document.querySelector('.t-memory-overlay'), null);
});

test('后台定时检查自动整理已有历史，新轮次结束后继续增量处理', async () => {
    const host = await loadRuntime(); host.ns.initStoryMemory();
    function tick() {
        const timer = [...host.timers].find(([, value]) => value.delay === 1000);
        assert.ok(timer, '自动整理应安排后台检查');
        host.timers.delete(timer[0]); timer[1].callback();
    }
    tick(); await settle(() => host.current.chatMetadata[MEMORY_KEY].segments.length === 1 && !host.ns.getStoryMemoryView().busy);
    assert.equal(host.requests.length, 1);
    host.chat.push(...makeChat(1).slice(1));
    await host.emitArgs('GENERATION_STARTED', 'normal', {}, false); await host.emit('GENERATION_ENDED');
    tick(); await settle(() => host.current.chatMetadata[MEMORY_KEY].segments.length === 2 && !host.ns.getStoryMemoryView().busy);
    assert.equal(host.current.chatMetadata[MEMORY_KEY].segments[1].start, 7);
    assert.equal(host.current.chatMetadata[MEMORY_KEY].segments[1].end, 8);
    assert.ok(host.chat.slice(9).every(message => !message.is_system));
    assert.equal(host.current.chatMetadata[MEMORY_KEY].relationships.length, 1, '重复出现的关系应合并');
    assert.equal(host.current.chatMetadata[MEMORY_KEY].threads.length, 1, '重复出现的伏笔应合并');
});

test('失败采用退避重试，quiet生成不会立即重复调用总结', async () => {
    const host = await loadRuntime({ result: response({ complete: false }) }); host.ns.initStoryMemory();
    assert.equal(await host.ns.runStoryMemory(false), false);
    assert.ok([...host.timers.values()].some(timer => timer.delay >= 59000 && timer.delay <= 60000));
    await host.emitArgs('GENERATION_STARTED', 'quiet', {}, false); await host.emit('GENERATION_ENDED');
    assert.equal(await host.ns.runStoryMemory(false), false);
    assert.equal(host.requests.length, 1); assert.ok(host.chat.every(message => !message.is_system));
});

test('保留分叉点之前的有效摘要，仅撤销越过分叉点的后续段', async () => {
    const host = await loadRuntime(); await host.ns.runStoryMemory(true);
    host.chat.push(...makeChat(1).slice(1)); await host.ns.runStoryMemory(true);
    host.ns.initStoryMemory();
    const branch = { ...host.current, chatId: 'branch', chat: clone(host.chat.slice(0, 8)), chatMetadata: clone(host.current.chatMetadata) };
    host.setCurrent(branch); await host.emit('CHAT_CHANGED'); await host.emitArgs('GENERATION_STARTED', 'normal', {}, false);
    assert.equal(branch.chatMetadata[MEMORY_KEY].segments.length, 1);
    assert.ok(branch.chat.slice(0, 7).every(message => message.is_system));
    assert.equal(branch.chat[7].is_system, false);
    assert.ok(host.context.__injection.text.includes('截至第 6 楼'));
});
