import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
    READER_STORY_KEY, newReaderStory, buildReaderStorySources, validReaderStory, readerStateAt,
    readerSceneDirectory, readerStoryMessages, parseReaderStoryResponse, isReaderSeparator,
} from '../src/core/readerStoryData.js';
import { MEMORY_HIDE_KEY } from '../src/core/storyMemoryData.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clone = value => JSON.parse(JSON.stringify(value));
const chatFixture = () => [
    { name: '顾舟', mes: '<正文>顾舟提起钥匙的来历，却没有解释。</正文><状态栏>信任：10</状态栏>' },
    { name: '顾舟', mes: '顾舟带林岚来到旧宅门口，她仍不信任他。' },
    { name: '顾舟', mes: '顾舟解释钥匙是父亲留下的遗物，兑现了先前的承诺。' },
];
const emptyState = () => readerStateAt(newReaderStory(), -1);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async predicate => {
    for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
    assert.fail('Condition did not settle');
};

function response(previous, source) {
    const known = previous.characters.find(item => item.name === '顾舟');
    const thread = previous.threads.find(item => item.title === '钥匙来历');
    const answer = source.text.includes('父亲');
    const arrival = source.text.includes('旧宅门口');
    return {
        summary: source.text,
        scene: { newScene: !previous.scene || arrival, title: arrival ? '旧宅门口' : '雨夜来访',
            place: arrival ? '旧宅门口' : '', time: '', focus: '谈论钥匙', evidence: source.text },
        characters: [{ id: known?.id || '', name: '顾舟', aliases: [], facts: [{ key: answer ? '钥匙知识' : arrival ? 'location' : '钥匙知识',
            kind: arrival ? 'location' : 'knowledge', text: answer ? '已说明钥匙是父亲遗物' : arrival ? '来到旧宅门口' : '知道来历，尚未向林岚解释', evidence: source.text }] }],
        threads: !thread || answer ? [{ id: thread?.id || '', title: '钥匙来历', question: answer ? '钥匙来历已解释' : '来历尚未解释', status: answer ? 'resolved' : 'open',
            evidence: source.text, echo: answer ? { certainty: 'explicit', explanation: '本楼解释了最早提及的钥匙来历。', evidence: source.text } : null }] : [],
        complete: true,
    };
}

function builtStory() {
    const sources = buildReaderStorySources(chatFixture());
    const story = newReaderStory();
    for (const source of sources) {
        const previous = readerStateAt(story, source.index - 1);
        story.checkpoints.push(parseReaderStoryResponse(JSON.stringify(response(previous, source)), previous, source));
    }
    return { story, sources };
}

async function runtime(options = {}) {
    let current = { chat: options.chat || chatFixture(), chatMetadata: options.metadata || {}, chatId: 'chatA', groupId: options.group ? 'groupA' : null,
        characterId: 0, characters: [{ name: '顾舟', avatar: 'a.png' }] };
    const data = { appearance: { reader: { fontSize: 19 } } };
    const requests = [];
    const saves = [];
    const disk = new Map();
    const events = new Map();
    const timers = new Map();
    const dom = new JSDOM('<body><div id="host"></div></body>');
    let serial = 0;
    let generating = false;
    const context = vm.createContext({
        console, AbortController, DOMException, window: dom.window, document: dom.window.document,
        SillyTavern: { getContext: () => current },
        crypto: { randomUUID: () => `reader-${++serial}` },
        setTimeout: (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
        __data: data, __events: events, __generating: () => generating,
        __save: async () => {
            const owner = current;
            saves.push({ key: owner.chatId, metadata: clone(owner.chatMetadata), chat: clone(owner.chat) });
            if (options.onSave) await options.onSave(saves.length);
            if (saves.length === options.failSaveAt) return;
            disk.set(owner.chatId, [{ chat_metadata: clone(owner.chatMetadata) }, ...clone(owner.chat)]);
        },
        __request: async (conn, messages, requestOptions) => {
            const input = JSON.parse(messages[1].content);
            requests.push({ conn, messages, options: requestOptions, input });
            if (options.request) return options.request(input, requestOptions, requests.length);
            return JSON.stringify(response(input.previous, { ...input.floor, name: input.floor.speaker }));
        },
        fetch: async (url, request) => {
            const body = JSON.parse(request.body);
            if (options.onRead) options.onRead(url, body);
            return { ok: !options.readFailure, json: async () => disk.get(body.file_name || body.id) || [] };
        },
    });
    const core = path.join(project, 'src/core');
    const stubs = new Map([
        [path.resolve(core, '../../../../script.js'), `
            export const isGenerating = __generating; export const saveChatConditional = __save; export const getRequestHeaders = () => ({});
            export const event_types = Object.fromEntries(['CHAT_CHANGED','GENERATION_STARTED','GENERATION_ENDED','MESSAGE_RECEIVED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPED','MESSAGE_SWIPE_DELETED'].map(name => [name,name]));
            export const eventSource = {on(name, fn){ const items=__events.get(name)||[]; items.push(fn); __events.set(name,items); }};`],
        [path.join(project, 'src/utils/storage.js'), 'export const getExtData = () => __data; export const saveExtData = () => {};'],
        [path.join(project, 'src/utils/helpers.js'), 'export const estimateTokens = text => Math.ceil(String(text).length / 2);'],
        [path.join(core, 'connection.js'), `export const getActiveConnection = () => ({useSTConnection:true,model:'test'});
            export const getConnectionByProfileId = id => id === 'missing' ? null : ({useSTConnection:true,model:id});
            export const getAllProfiles = () => [{id:'st_sync',name:'跟随酒馆'}]; export const sendChatRequestWithConnection = __request;`],
        [path.join(project, 'src/utils/dom.js'), 'export const ensureFeatureCss = () => {};'],
    ]);
    const modules = new Map();
    function moduleFor(id) {
        if (!modules.has(id)) modules.set(id, new vm.SourceTextModule(stubs.get(id) ?? readFileSync(id, 'utf8'), { context, identifier: id }));
        return modules.get(id);
    }
    const entry = moduleFor(path.join(core, 'readerStory.js'));
    await entry.link((specifier, reference) => moduleFor(path.resolve(path.dirname(reference.identifier), specifier)));
    await entry.evaluate();
    return {
        ns: entry.namespace, context, data, requests, saves, events, timers, disk, dom,
        get current() { return current; }, setCurrent: value => { current = value; },
        setGenerating: value => { generating = value; },
        emit: async name => { for (const fn of events.get(name) || []) await fn(); },
        ui: async () => {
            const module = moduleFor(path.join(project, 'src/ui/readerStoryPanel.js'));
            await module.link((specifier, reference) => moduleFor(path.resolve(path.dirname(reference.identifier), specifier)));
            await module.evaluate(); return module.namespace;
        },
        reader: async () => {
            const module = moduleFor(path.join(project, 'src/ui/readerWindow.js'));
            await module.link((specifier, reference) => moduleFor(path.resolve(path.dirname(reference.identifier), specifier)));
            await module.evaluate(); return module.namespace;
        },
    };
}

function readerJquery(window) {
    const listeners = new Map();
    function $(input) {
        const elements = typeof input === 'string' ? Array.from(window.document.querySelectorAll(input)) : input ? [input] : [];
        const wrapper = {
            length: elements.length, get: i => elements[i],
            css: (key, value) => { elements.forEach(element => element.style.setProperty(key, value)); return wrapper; },
            append: html => { elements.forEach(element => element.insertAdjacentHTML('beforeend', html)); return wrapper; },
            html: html => { elements.forEach(element => element.innerHTML = html); return wrapper; },
            remove: () => { elements.forEach(element => element.remove()); return wrapper; },
            prop: (key, value) => value === undefined ? elements[0]?.[key] : (elements.forEach(element => element[key] = value), wrapper),
            scrollTop: value => value === undefined ? elements[0]?.scrollTop : (elements.forEach(element => element.scrollTop = value), wrapper),
            hasClass: name => !!elements[0]?.classList.contains(name),
            addClass: name => { elements.forEach(element => element.classList.add(name)); return wrapper; },
            removeClass: name => { elements.forEach(element => element.classList.remove(name)); return wrapper; },
            toggleClass: (name, on) => { elements.forEach(element => element.classList.toggle(name, on)); return wrapper; },
            text: value => { elements.forEach(element => element.textContent = value); return wrapper; },
            on: (name, selector, handler) => {
                if (typeof selector === 'function') { handler = selector; selector = null; }
                elements.forEach(element => {
                    const fn = event => {
                        const target = selector ? event.target.closest?.(selector) : element;
                        if (target) handler.call(target, event);
                    };
                    const type = name.split('.')[0]; element.addEventListener(type, fn);
                    const items = listeners.get(element) || []; items.push({ name, type, fn }); listeners.set(element, items);
                });
                return wrapper;
            },
            off: name => {
                elements.forEach(element => {
                    const items = listeners.get(element) || [];
                    for (const item of items.filter(item => item.name === name)) element.removeEventListener(item.type, item.fn);
                    listeners.set(element, items.filter(item => item.name !== name));
                }); return wrapper;
            },
        };
        return wrapper;
    }
    return $;
}

test('阅读源包括故事记忆隐藏的原文，排除真正系统消息、手动隐藏及前端代码', () => {
    const chat = [
        { mes: '保留的故事正文。', is_system: true, extra: { [MEMORY_HIDE_KEY]: 'owned' } },
        { mes: '系统指令。', is_system: true }, { mes: '手动隐藏。', is_hidden: true },
        { mes: '<正文>实际正文。</正文><状态栏>状态数据。</状态栏><script>代码内容。</script>' },
        { mes: '```html\n<div>代码。</div>\n```' },
    ];
    const sources = buildReaderStorySources(chat);
    assert.deepEqual(sources.map(source => source.index), [0, 3]);
    assert.equal(sources[1].text, '实际正文。');
    assert.ok(chat[0].is_system);
});

test('分隔检测不吞掉分隔线后同楼正文', () => {
    assert.equal(isReaderSeparator('---'), true);
    assert.equal(isReaderSeparator('---\n后面还有故事。'), false);
});

test('每个时间点的人物资料只来自已读前缀，后文不会改写过去', () => {
    const { story } = builtStory();
    assert.equal(readerStateAt(story, -1).characters.length, 0);
    const early = readerStateAt(story, 0);
    assert.match(early.characters[0].facts[0].text, /尚未/);
    assert.ok(!JSON.stringify(early).includes('父亲遗物'));
    const later = readerStateAt(story, 2);
    assert.match(later.characters[0].facts.find(fact => fact.key === '钥匙知识').text, /父亲遗物/);
    assert.match(readerStateAt(story, 0).characters[0].facts[0].text, /尚未/);
});

test('人物的未变事实保留，改变的事实保留各自原文楼层', () => {
    const { story } = builtStory();
    const person = readerStateAt(story, 1).characters[0];
    assert.equal(person.facts.length, 2);
    assert.equal(person.facts.find(fact => fact.key === '钥匙知识').evidence.floor, 0);
    assert.equal(person.facts.find(fact => fact.key === 'location').evidence.floor, 1);
});

test('伏笔回声只能在回应楼层及之后出现，并保留最早线索', () => {
    const { story } = builtStory();
    assert.equal(readerStateAt(story, 1).echoes.length, 0);
    assert.equal(readerStateAt(story, 1).threads[0].status, 'open');
    const echo = readerStateAt(story, 2).echoes[0];
    assert.equal(echo.clue.floor, 0); assert.equal(echo.reply.floor, 2);
    assert.equal(readerStateAt(story, 2).threads[0].status, 'resolved');
});

test('未读场景标题和地点不进入目录，回到早期会重新隐藏', () => {
    const { story, sources } = builtStory();
    const early = readerSceneDirectory(story, sources, 0);
    assert.equal(early[0].title, '雨夜来访'); assert.equal(early[1].title, '未读场景 2');
    assert.equal(early[1].place, '');
    assert.equal(readerSceneDirectory(story, sources, 1)[1].title, '旧宅门口');
    assert.equal(readerSceneDirectory(story, sources, 0)[1].title, '未读场景 2');
});

test('无模型索引时仍提供开篇及原文分隔的目录', () => {
    const sources = buildReaderStorySources([{ mes: '开场正文。' }, { mes: '***' }, { mes: '第二段正文。' }]);
    const scenes = readerSceneDirectory(newReaderStory(), sources, -1);
    assert.deepEqual(scenes.map(scene => scene.start), [0, 1]);
    assert.ok(scenes.every(scene => scene.pending && !scene.known));
});

test('旧楼编辑、swipe、删除、提取设置变化会丢弃受影响的全部后继', () => {
    const { story } = builtStory();
    const chat = chatFixture(); chat[1].mes += '新的事件。';
    let checked = validReaderStory(story, buildReaderStorySources(chat));
    assert.equal(checked.story.checkpoints.length, 1); assert.equal(checked.invalidated, 2);
    const swiped = chatFixture(); swiped[0].swipe_id = 1;
    assert.equal(validReaderStory(story, buildReaderStorySources(swiped)).story.checkpoints.length, 0);
    assert.equal(validReaderStory(story, buildReaderStorySources(chatFixture().slice(0, 1))).story.checkpoints.length, 1);
    assert.equal(validReaderStory(story, buildReaderStorySources(chatFixture(), '正文'), '正文').story.checkpoints.length, 0);
});

test('只追加后文保留全部既有索引，故事记忆隐藏标记不使正文失效', () => {
    const { story } = builtStory();
    const chat = chatFixture(); chat.push({ mes: '后来新发生的剧情。' });
    chat[0].is_system = true; chat[0].extra = { [MEMORY_HIDE_KEY]: 'owned' };
    assert.equal(validReaderStory(story, buildReaderStorySources(chat)).invalidated, 0);
});

test('模型输出截断、缺少 complete、伪造原文或引用未来人物都会拒绝', () => {
    const source = buildReaderStorySources(chatFixture())[0];
    const previous = emptyState();
    const good = response(previous, source);
    assert.throws(() => parseReaderStoryResponse(JSON.stringify(good).slice(0, -1), previous, source), /完整 JSON/);
    assert.throws(() => parseReaderStoryResponse(JSON.stringify({ ...good, complete: false }), previous, source), /完整输出/);
    const badQuote = clone(good); badQuote.characters[0].facts[0].evidence = '钥匙是父亲留下的遗物';
    assert.throws(() => parseReaderStoryResponse(JSON.stringify(badQuote), previous, source), /原文依据/);
    const futurePerson = clone(good); futurePerson.characters[0].id = 'person-未来';
    assert.throws(() => parseReaderStoryResponse(JSON.stringify(futurePerson), previous, source), /尚未出现/);
});

test('新增人物、别称和每项知情事实都需要本楼依据', () => {
    const source = buildReaderStorySources(chatFixture())[0]; const previous = emptyState();
    const unknown = response(previous, source); unknown.characters[0].name = '未来角色';
    assert.throws(() => parseReaderStoryResponse(JSON.stringify(unknown), previous, source), /未出现在/);
    const alias = response(previous, source); alias.characters[0].aliases = ['隐藏身份'];
    assert.throws(() => parseReaderStoryResponse(JSON.stringify(alias), previous, source), /别称/);
    const duplicate = response(previous, source); duplicate.characters.push(clone(duplicate.characters[0]));
    assert.throws(() => parseReaderStoryResponse(JSON.stringify(duplicate), previous, source), /重复/);
});

test('模糊对应保留为可能关联，不允许据此把伏笔标为已解答', () => {
    const { story, sources } = builtStory();
    const prior = readerStateAt(story, 1);
    const result = response(prior, sources[2]); result.threads[0].status = 'open'; result.threads[0].echo.certainty = 'possible';
    const checkpoint = parseReaderStoryResponse(JSON.stringify(result), prior, sources[2]);
    assert.equal(checkpoint.echoes[0].certainty, 'possible'); assert.equal(checkpoint.threads[0].status, 'open');
    result.threads[0].status = 'resolved';
    assert.throws(() => parseReaderStoryResponse(JSON.stringify(result), prior, sources[2]), /明确回应/);
});

test('回声不能指向不存在或本楼才新增的线索', () => {
    const source = buildReaderStorySources(chatFixture())[0]; const previous = emptyState();
    const result = response(previous, source); result.threads[0].echo = { certainty: 'explicit', evidence: source.text, explanation: '猜测关联。' };
    assert.throws(() => parseReaderStoryResponse(JSON.stringify(result), previous, source), /较早楼层/);
    result.threads[0].id = '未来线索';
    assert.throws(() => parseReaderStoryResponse(JSON.stringify(result), previous, source), /尚未出现/);
});

test('请求只含当前楼层与历史状态，不含后文、最新故事记忆或世界书', () => {
    const { story, sources } = builtStory();
    const messages = readerStoryMessages(readerStateAt(story, 0), sources[1]);
    const input = JSON.parse(messages[1].content);
    assert.equal(input.floor.index, 1);
    assert.ok(!messages[1].content.includes('父亲留下的遗物'));
    assert.equal(input.previous.asOf, 0); assert.equal(input.previous.echoes, undefined);
});

test('完整索引逐楼保存，原文、隐藏标志及其他插件数据保持原状', async () => {
    const host = await runtime({ metadata: { custom: { value: 12 } } });
    const before = clone(host.current.chat);
    assert.equal(await host.ns.startReaderStoryIndex(), true);
    assert.equal(host.requests.length, 3); assert.equal(host.saves.length, 3);
    assert.deepEqual(host.current.chat, before); assert.equal(host.current.chatMetadata.custom.value, 12);
    assert.equal(host.ns.getReaderStoryView(0).echoes.length, 0);
    assert.equal(host.ns.getReaderStoryView(2).echoes.length, 1);
    assert.equal(host.requests[0].input.floor.index, 0);
    assert.ok(!host.requests[0].messages[1].content.includes('父亲留下的遗物'));
    assert.equal(host.requests[0].options.respectRequestLimits, true);
    assert.equal(host.requests[0].options.maxTokens, 4096); assert.ok(host.requests[0].options.signal);
});

test('已完成缓存不重复调用模型，追加剧情后只增量整理新楼', async () => {
    const host = await runtime(); await host.ns.startReaderStoryIndex();
    await host.ns.startReaderStoryIndex(); assert.equal(host.requests.length, 3);
    host.current.chat.push({ name: '顾舟', mes: '顾舟继续解释钥匙是父亲留给他的遗物。' });
    assert.equal(await host.ns.startReaderStoryIndex(), true);
    assert.equal(host.requests.length, 4); assert.equal(host.requests.at(-1).input.floor.index, 3);
});

test('关闭/停止取消未完成请求，保留已提交的部分供下次增量整理', async () => {
    const gate = deferred();
    const host = await runtime({ request: (input, _opts, count) => count === 2 ? gate.promise : JSON.stringify(response(input.previous, { ...input.floor, name: input.floor.speaker })) });
    const work = host.ns.startReaderStoryIndex();
    await settle(() => host.requests.length === 2);
    host.ns.stopReaderStoryIndex();
    assert.equal(host.requests[1].options.signal.aborted, true);
    gate.resolve(JSON.stringify(response(host.requests[1].input.previous, { ...host.requests[1].input.floor, name: '顾舟' })));
    assert.equal(await work, false); assert.equal(host.ns.getReaderStoryView(2).processed, 1);
    assert.equal(await host.ns.startReaderStoryIndex(), true); assert.equal(host.requests.length, 4);
});

test('宿主吞掉保存错误时不发布未确认的索引', async () => {
    const host = await runtime({ failSaveAt: 1 });
    assert.equal(await host.ns.startReaderStoryIndex(), false);
    assert.equal(host.ns.getReaderStoryView(2).processed, 0);
    assert.match(host.ns.getReaderStoryView().error, /未成功保存/);
    assert.equal(host.current.chatMetadata[READER_STORY_KEY], undefined);
});

test('索引正在保存时界面仍只能看到先前已确认的检查点', async () => {
    const gate = deferred(); const host = await runtime({ onSave: number => number === 2 ? gate.promise : undefined });
    const work = host.ns.startReaderStoryIndex();
    await settle(() => host.saves.length === 2);
    assert.equal(host.ns.getReaderStoryView(2).processed, 1);
    assert.equal(host.ns.getReaderStoryView(2).asOf, 0);
    gate.resolve(); await work;
    assert.equal(host.ns.getReaderStoryView(2).processed, 3);
});

test('保存失败不会抹掉较早已确认的结果', async () => {
    const host = await runtime({ failSaveAt: 2 }); await host.ns.startReaderStoryIndex();
    assert.equal(host.ns.getReaderStoryView(2).processed, 1); assert.equal(host.ns.getReaderStoryView(2).echoes.length, 0);
});

test('编辑旧楼后立即屏蔽受影响资料，重新整理从失效点开始', async () => {
    const host = await runtime(); await host.ns.startReaderStoryIndex();
    host.current.chat[1].mes = '顾舟带林岚来到旧宅门口，两人暂时决定合作。';
    await host.emit('titania_text_patched');
    assert.equal(host.ns.getReaderStoryView(2).processed, 1); assert.equal(host.ns.getReaderStoryView(2).echoes.length, 0);
    assert.equal(await host.ns.startReaderStoryIndex(), true);
    assert.equal(host.requests.length, 5); assert.equal(host.requests[3].input.floor.index, 1);
});

test('请求中切换聊天不会向新聊天写入结果', async () => {
    const gate = deferred(); const host = await runtime({ request: () => gate.promise });
    const parent = host.current; const work = host.ns.startReaderStoryIndex();
    await settle(() => host.requests.length === 1);
    host.setCurrent({ ...parent, chatId: 'chatB', chat: chatFixture(), chatMetadata: {} });
    await host.emit('CHAT_CHANGED'); gate.resolve('{}'); await work;
    assert.equal(host.saves.length, 0); assert.equal(host.current.chatMetadata[READER_STORY_KEY], undefined);
});

test('保存中切换聊天只恢复捕获对象，不保存或修改新聊天', async () => {
    const gate = deferred(); const host = await runtime({ onSave: () => gate.promise });
    const parent = host.current; const work = host.ns.startReaderStoryIndex();
    await settle(() => host.saves.length === 1);
    host.setCurrent({ ...parent, chatId: 'chatB', chat: chatFixture(), chatMetadata: {} });
    await host.emit('CHAT_CHANGED'); gate.resolve(); await work;
    assert.equal(host.current.chatMetadata[READER_STORY_KEY], undefined); assert.equal(parent.chatMetadata[READER_STORY_KEY], undefined);
    assert.equal(host.saves.length, 1); assert.equal(host.saves[0].key, 'chatA');
});

test('酒馆生成期间不能启动索引；生成开始会取消正在整理的请求', async () => {
    const host = await runtime(); host.setGenerating(true);
    await assert.rejects(host.ns.startReaderStoryIndex(), /生成结束/); assert.equal(host.requests.length, 0);
    const gate = deferred(); const running = await runtime({ request: () => gate.promise });
    const work = running.ns.startReaderStoryIndex(); await settle(() => running.requests.length === 1);
    running.setGenerating(true); await running.emit('GENERATION_STARTED');
    assert.equal(running.requests[0].options.signal.aborted, true); gate.resolve('{}'); await work;
    assert.equal(running.saves.length, 0);
});

test('群聊通过群聊接口确认索引保存', async () => {
    const urls = []; const host = await runtime({ group: true, onRead: (url, body) => { urls.push(url); assert.equal(body.id, 'chatA'); } });
    assert.equal(await host.ns.startReaderStoryIndex(), true);
    assert.ok(urls.every(url => url === '/api/chats/group/get'));
});

test('不存在的索引方案不静默回退，超大上下文不截断后分析', async () => {
    const host = await runtime(); host.ns.saveReaderStoryConfig({ profile_id: 'missing' });
    await assert.rejects(host.ns.startReaderStoryIndex(), /已不存在/); assert.equal(host.requests.length, 0);
    const huge = await runtime({ chat: [{ name: '顾舟', mes: '顾舟' + '正文'.repeat(4000) }] });
    huge.ns.saveReaderStoryConfig({ context_tokens: 1000 });
    assert.equal(await huge.ns.startReaderStoryIndex(), false); assert.equal(huge.requests.length, 0);
    assert.match(huge.ns.getReaderStoryView().error, /上下文上限/);
});

test('原文来源只能查看已读楼层，且校验实际引用', async () => {
    const host = await runtime(); await host.ns.startReaderStoryIndex();
    const echo = host.ns.getReaderStoryView(2).echoes[0];
    assert.throws(() => host.ns.getReaderStoryEvidence(echo.reply, 1), /尚未读到/);
    assert.match(host.ns.getReaderStoryEvidence(echo.clue, 0).text, /钥匙的来历/);
    assert.throws(() => host.ns.getReaderStoryEvidence({ floor: 0, quote: '伪造的摘录' }, 0), /来源已变化/);
});

test('索引提取设置独立保存，不丢失字号、不写入续读位置', async () => {
    const host = await runtime(); host.ns.saveReaderStoryConfig({ profile_id: 'st_sync', model: 'override', tag_whitelist: '正文' });
    assert.equal(host.data.appearance.reader.fontSize, 19);
    assert.equal(host.ns.getReaderStoryConfig().model, 'override');
    assert.equal(host.current.chatMetadata[READER_STORY_KEY], undefined);
    assert.ok(!Object.keys(host.data.appearance.reader).some(key => /position|scroll|bookmark/.test(key)));
});

async function panelFor(host) {
    const document = host.dom.window.document;
    const root = document.createElement('div'); root.id = 't-reader-overlay';
    root.innerHTML = '<button data-reader-action="toggle"></button><div id="t-reader-scroll"><article id="t-reader-page"></article></div><aside data-reader-sidebar></aside>';
    document.body.appendChild(root);
    const renderBody = () => {
        const page = root.querySelector('#t-reader-page'); page.replaceChildren();
        host.current.chat.forEach((message, index) => {
            const section = document.createElement('section'); section.dataset.readerFloor = index;
            const prose = document.createElement('p'); prose.dataset.readerProse = ''; prose.textContent = message.mes;
            const at = document.createElement('button'); at.dataset.readerAction = 'at'; at.dataset.readerIndex = index; at.textContent = '查看这一刻';
            const markers = document.createElement('span'); markers.dataset.readerEchoMarkers = '';
            section.append(prose, at, markers); page.appendChild(section);
        });
    };
    renderBody();
    const ui = await host.ui(); let closed = false;
    const panel = ui.createReaderStoryPanel(root, { refreshBody: renderBody, close: () => { closed = true; panel.dispose(); root.remove(); } });
    const click = selector => { const node = root.querySelector(selector); assert.ok(node, selector); node.click(); };
    return { root, panel, click, get closed() { return closed; } };
}

test('阅读面板初始不泄露未来标题、人物状态或回声，查看一楼只解锁该时间点', async () => {
    const host = await runtime(); await host.ns.startReaderStoryIndex();
    const ui = await panelFor(host);
    const content = () => ui.root.querySelector('[data-reader-content]').textContent;
    assert.ok(!content().includes('旧宅门口')); assert.ok(content().includes('未读场景'));
    ui.click('[data-reader-action="at"][data-reader-index="0"]');
    ui.click('[data-reader-action="person"]');
    assert.match(content(), /尚未向林岚解释/); assert.ok(!content().includes('父亲遗物'));
    ui.click('[data-reader-tab="echoes"]');
    assert.match(content(), /还没有/); assert.ok(!content().includes('父亲遗物'));
    ui.panel.dispose();
});

test('回声在回应之后显示两处引用，退回早期时连已打开的回声也隐藏', async () => {
    const host = await runtime(); await host.ns.startReaderStoryIndex();
    const ui = await panelFor(host);
    ui.click('[data-reader-action="at"][data-reader-index="2"]');
    ui.click('[data-reader-tab="echoes"]'); ui.click('[data-reader-content] [data-reader-action="echo"]');
    assert.match(ui.root.querySelector('[data-reader-content]').textContent, /较早线索 · 第 0 楼/);
    assert.match(ui.root.querySelector('[data-reader-content]').textContent, /父亲留下/);
    ui.click('[data-reader-action="at"][data-reader-index="0"]'); ui.click('[data-reader-tab="echoes"]');
    assert.ok(!ui.root.querySelector('[data-reader-content]').textContent.includes('父亲留下'));
    assert.equal(ui.root.querySelectorAll('[data-reader-echo-markers] button').length, 0);
    ui.panel.dispose();
});

test('场景定位将资料退到目标楼之前，且不会重写正文节点', async () => {
    const host = await runtime(); await host.ns.startReaderStoryIndex();
    const ui = await panelFor(host);
    const node = ui.root.querySelector('[data-reader-prose]').firstChild;
    ui.root.querySelector('#t-reader-scroll').scrollTo = () => {};
    ui.click('[data-reader-action="at"][data-reader-index="2"]'); ui.click('[data-reader-tab="scenes"]');
    ui.click('[data-reader-action="goto"][data-reader-index="0"]');
    assert.match(ui.root.querySelector('[data-reader-position]').textContent, /尚未读完/);
    assert.ok(!ui.root.querySelector('[data-reader-content]').textContent.includes('旧宅门口'));
    assert.equal(ui.root.querySelector('[data-reader-prose]').firstChild, node);
    ui.panel.dispose();
});

test('模型文字与源文引用以文本呈现，不能生成脚本元素', async () => {
    const host = await runtime(); await host.ns.startReaderStoryIndex();
    const story = host.current.chatMetadata[READER_STORY_KEY];
    story.checkpoints[0].characters[0].facts[0].text = '<img src=x onerror=alert(1)>';
    const ui = await panelFor(host);
    ui.click('[data-reader-action="at"][data-reader-index="0"]'); ui.click('[data-reader-action="person"]');
    assert.equal(ui.root.querySelector('[data-reader-content] img'), null);
    assert.match(ui.root.querySelector('[data-reader-content]').textContent, /<img/);
    ui.click('[data-reader-action="source"]');
    assert.equal(ui.root.querySelector('[data-reader-content] script'), null);
    ui.panel.dispose();
});

test('切换聊天会关闭旧阅读面板，并清理订阅', async () => {
    const host = await runtime(); const ui = await panelFor(host);
    host.setCurrent({ ...host.current, chatId: 'chatB', chat: chatFixture(), chatMetadata: {} });
    await host.emit('CHAT_CHANGED'); assert.equal(ui.closed, true); assert.equal(ui.root.isConnected, false);
});

test('阅读开关区分故事记忆隐藏与其他隐藏楼层，分隔后正文照常保留', async () => {
    const host = await runtime(); const reader = await host.reader();
    const config = { showUser: true, showHidden: false };
    assert.equal(reader.isFloorVisible({ mes: '原文。', is_system: true, extra: { [MEMORY_HIDE_KEY]: 'owned' } }, config), true);
    assert.equal(reader.isFloorVisible({ mes: '其他隐藏。', is_system: true }, config), false);
    assert.equal(reader.isFloorVisible({ mes: '原文。', is_hidden: true }, config), false);
    assert.equal(reader.isFloorVisible({ mes: '用户。', is_user: true }, { ...config, showUser: false }), false);
    assert.equal(reader.isSeparatorFloor('---\n这里还有正文。'), false);
});

test('资料更新与索引整理不替换阅读正文节点、事件监听器或 iframe 实例', async () => {
    const host = await runtime(); const ui = await panelFor(host);
    const prose = ui.root.querySelector('[data-reader-prose]');
    const node = prose.firstChild;
    const iframe = host.dom.window.document.createElement('iframe');
    prose.appendChild(iframe); const frame = iframe.contentWindow; frame.progress = 17;
    let clicks = 0; prose.addEventListener('reader-check', () => clicks++);
    assert.equal(await host.ns.startReaderStoryIndex(), true);
    ui.click('[data-reader-action="at"][data-reader-index="2"]');
    ui.click('[data-reader-tab="echoes"]'); ui.click('[data-reader-content] [data-reader-action="echo"]');
    assert.equal(prose.firstChild, node); assert.equal(iframe.contentWindow, frame); assert.equal(frame.progress, 17);
    prose.dispatchEvent(new host.dom.window.Event('reader-check')); assert.equal(clicks, 1);
    assert.equal(ui.root.querySelectorAll('[data-reader-prose] .t-reader-person').length, 0);
    ui.panel.dispose();
});

test('请求期间修改当前原文，不接受旧模型结果', async () => {
    const gate = deferred(); const host = await runtime({ request: () => gate.promise });
    const work = host.ns.startReaderStoryIndex(); await settle(() => host.requests.length === 1);
    host.current.chat[0].mes = '用户编辑后完全不同的开篇。';
    gate.resolve(JSON.stringify(response(emptyState(), buildReaderStorySources(chatFixture())[0])));
    assert.equal(await work, false); assert.equal(host.saves.length, 0); assert.equal(host.ns.getReaderStoryView(0).characters.length, 0);
});

test('索引请求超时可停止并显示原因，不发布空或截断结果', async () => {
    const gate = deferred(); const host = await runtime({ request: () => gate.promise });
    const work = host.ns.startReaderStoryIndex(); await settle(() => host.requests.length === 1);
    const timeout = [...host.timers.values()].find(timer => timer.delay === 180000);
    assert.ok(timeout); timeout.fn(); gate.resolve('{}');
    assert.equal(await work, false); assert.match(host.ns.getReaderStoryView().error, /超时/); assert.equal(host.saves.length, 0);
});

test('发生分支变化时保留分叉前的资料，避免继承父聊天之后的解答', async () => {
    const host = await runtime(); await host.ns.startReaderStoryIndex();
    const branch = { ...host.current, chatId: 'branch', chat: chatFixture(), chatMetadata: clone(host.current.chatMetadata) };
    branch.chat[1].mes = '顾舟决定暂时不去旧宅，两人在街边等待。';
    host.setCurrent(branch); await host.emit('CHAT_CHANGED');
    const view = host.ns.getReaderStoryView(2);
    assert.equal(view.processed, 1); assert.equal(view.echoes.length, 0); assert.equal(view.threads[0].status, 'open');
    assert.equal(view.characters[0].facts[0].evidence.floor, 0);
});

test('实际小说窗口接入目录、楼层查看入口与资料页，调字号保持独立索引设置', async () => {
    const host = await runtime(); host.context.$ = readerJquery(host.dom.window);
    host.ns.saveReaderStoryConfig({ model: 'chosen-model' });
    await host.ns.startReaderStoryIndex();
    const reader = await host.reader(); reader.openReaderWindow();
    const document = host.dom.window.document;
    const root = document.querySelector('#t-reader-overlay'); assert.ok(root);
    assert.equal(root.querySelectorAll('[data-reader-floor]').length, 3);
    assert.equal(root.querySelectorAll('[data-reader-tab]').length, 3);
    root.querySelector('[data-reader-action="at"][data-reader-index="2"]').click();
    root.querySelector('[data-reader-tab="echoes"]').click();
    assert.match(root.querySelector('[data-reader-content]').textContent, /钥匙来历/);
    root.querySelector('#t-reader-font-inc').click();
    assert.equal(host.data.appearance.reader.fontSize, 20); assert.equal(host.data.appearance.reader.index_model, 'chosen-model');
    root.querySelector('#t-reader-close').click(); assert.equal(root.isConnected, false);
});

test('关闭实际阅读窗口会中止其整理请求，重新打开从顶部且不留旧侧栏', async () => {
    const gate = deferred(); const host = await runtime({ request: () => gate.promise });
    host.context.$ = readerJquery(host.dom.window);
    const reader = await host.reader(); reader.openReaderWindow();
    const document = host.dom.window.document;
    document.querySelector('[data-reader-action="index"]').click(); await settle(() => host.requests.length === 1);
    document.querySelector('#t-reader-close').click();
    assert.equal(host.requests[0].options.signal.aborted, true);
    gate.resolve('{}'); await settle(() => !host.ns.getReaderStoryView().busy);
    reader.openReaderWindow();
    assert.equal(document.querySelectorAll('#t-reader-overlay').length, 1);
    assert.equal(document.querySelector('#t-reader-scroll').scrollTop, 0);
    assert.match(document.querySelector('[data-reader-position]').textContent, /尚未读完/);
    document.querySelector('#t-reader-close').click();
});
