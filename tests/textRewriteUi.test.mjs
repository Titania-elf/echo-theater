import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Only the jQuery calls used by these entry points; application code remains unchanged.
function jqueryFor(window) {
    const document = window.document;
    function $(input) {
        let elements = [];
        if (typeof input === 'string' && input.trimStart().startsWith('<')) {
            const template = document.createElement('template'); template.innerHTML = input;
            elements = Array.from(template.content.children);
        } else if (typeof input === 'string') elements = Array.from(document.querySelectorAll(input));
        else if (Array.isArray(input)) elements = input;
        else if (input?.nodes) elements = input.nodes;
        else if (input) elements = [input];
        const wrapper = {
            length: elements.length,
            get: i => elements[i], first: () => $(elements.slice(0, 1)), last: () => $(elements.slice(-1)),
            find: selector => $(elements.flatMap(element => Array.from(element.querySelectorAll(selector)))),
            each: fn => { elements.forEach((element, i) => fn(i, element)); return wrapper; },
            prop: (key, value) => value === undefined ? elements[0]?.[key] : wrapper.each((_, el) => el[key] = value),
            attr: (key, value) => value === undefined ? elements[0]?.getAttribute(key) : wrapper.each((_, el) => el.setAttribute(key, value)),
            val: () => elements[0]?.value,
            text: value => value === undefined ? elements[0]?.textContent : wrapper.each((_, el) => el.textContent = value),
            html: value => value === undefined ? elements[0]?.innerHTML : wrapper.each((_, el) => el.innerHTML = value),
            remove: () => wrapper.each((_, el) => el.remove()),
            before: value => wrapper.each((_, el) => el.before(...$(value).nodes)),
            prepend: value => wrapper.each((_, el) => el.prepend(...$(value).nodes)),
            append: value => wrapper.each((_, el) => el.append(...$(value).nodes)),
            hide: () => wrapper.each((_, el) => el.style.display = 'none'),
            show: () => wrapper.each((_, el) => el.style.display = ''),
            removeClass: value => wrapper.each((_, el) => el.classList.remove(...value.split(' '))),
            addClass: value => wrapper.each((_, el) => el.classList.add(...value.split(' '))),
            nodes: elements,
        };
        return wrapper;
    }
    return $;
}

async function runtime({ raw = '<正文>他很愤怒。</正文><状态栏>信任：10</状态栏>', html = '<p>他很愤怒。</p><div class="status-card">信任：10</div><iframe></iframe>', request } = {}) {
    const dom = new JSDOM(`<body><div id="chat"><div class="mes" mesid="0"><div class="mes_text">${html}</div></div></div><div id="t-rewrite-status"></div><div id="t-rewrite-diff-body"></div><div id="t-delete-match-body"></div><button id="t-rewrite-trigger"></button></body>`);
    const msg = { mes: raw };
    const ctx = { chat: [msg], chatMetadata: {}, chatId: 'chatA', groupId: null, characterId: 0, characters: [{ name: '角色', avatar: 'a.png' }] };
    const data = { rewrite_entry: { enabled: true, tag_whitelist: '正文', stream_live: false,
        api_url: 'https://example.invalid', api_key: '', model: 'test',
        rewrite: { enabled: true, selected_sentence_enabled: true, schemes: [] },
        deletion: { enabled: true, rules: [{ anchor: '他', extras: '愤怒', mode: 'sentence', enabled: true }] },
    } };
    let disk;
    const events = [];
    const timers = [];
    const context = vm.createContext({
        console, window: dom.window, document: dom.window.document, $: jqueryFor(dom.window),
        SillyTavern: { getContext: () => ctx }, AbortController, DOMException,
        setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
        __data: data, __events: events,
        __save: async () => { disk = [{ chat_metadata: {} }, JSON.parse(JSON.stringify(msg))]; },
        __request: async options => request ? request(options, ctx) : JSON.stringify({ task_id: 'test', results: [{ segment_id: 's_1', rewritten_text: '他攥紧了拳头。' }] }),
        fetch: async () => ({ ok: true, json: async () => disk }),
    });
    const entryPath = path.join(project, 'src/ui/rewriteEntryButton.js');
    const stubs = new Map([
        [path.resolve(path.dirname(entryPath), '../../../../script.js'), `
            export const saveChatConditional = __save; export const getRequestHeaders = () => ({});
            export const isGenerating = () => false;
            export const event_types = {MESSAGE_RECEIVED:'MESSAGE_RECEIVED',GENERATION_ENDED:'GENERATION_ENDED'};
            export const eventSource = { on(){}, async emit(name){__events.push(name);} };`],
        [path.join(project, 'src/utils/storage.js'), 'export const getExtData = () => __data; export const saveExtData = () => {};'],
        [path.join(project, 'src/core/apiProfileRegistry.js'), 'export const normalizeRewriteCustomProfiles = input => input || [];'],
        [path.join(project, 'src/core/relayClient.js'), 'export const sendChatCompletion = __request;'],
        [path.join(project, 'src/ui/shared/apiConnectionEditor.js'), 'export const createApiConnectionEditor = () => ({}); export const mapConnectionProfilesToCustomProfiles = () => []; export const mapCustomProfilesToConnectionProfiles = () => []; export const renderApiConnectionEditorHTML = () => "";'],
    ]);
    const modules = new Map();
    function moduleFor(id) {
        if (!modules.has(id)) {
            let source = stubs.get(id) ?? readFileSync(id, 'utf8');
            if (id === entryPath) source += '\nexport const testHooks = { getLatestAssistantMessageFromChat, executeRewriteRequest, runDelete, enterInlineSentenceSelection, clearInlineSentenceSelection, applyAllRewriteMarksFromChat };';
            modules.set(id, new vm.SourceTextModule(source, { context, identifier: id }));
        }
        return modules.get(id);
    }
    const entry = moduleFor(entryPath);
    await entry.link((specifier, reference) => moduleFor(path.resolve(path.dirname(reference.identifier), specifier)));
    await entry.evaluate();
    const hooks = entry.namespace.testHooks;
    return {
        dom, msg, ctx, data, events, timers, hooks,
        rewrite: async () => {
            const latest = hooks.getLatestAssistantMessageFromChat();
            const unit = { unitIndex: 1, text: latest.content, hit: true, matchedCategories: [] };
            return hooks.executeRewriteRequest({ data: data.rewrite_entry, latest, evaluated: { unitResults: [unit] },
                request: { task_id: 'test', targets: [{ segment_id: 's_1', original_text: unit.text }] }, rewriteCount: 1 });
        },
    };
}

test('实际改写入口写回完整消息，Diff 显示已写回，不触发通用编辑事件', async () => {
    const host = await runtime();
    const iframe = host.dom.window.document.querySelector('iframe');
    const frame = iframe.contentWindow;
    assert.equal(await host.rewrite(), true);
    assert.equal(host.msg.mes, '<正文>他攥紧了拳头。</正文><状态栏>信任：10</状态栏>');
    assert.match(host.dom.window.document.querySelector('#t-rewrite-diff-body').textContent, /已写回/);
    assert.deepEqual(host.events, ['titania_text_patched']);
    assert.equal(iframe.contentWindow, frame);
});

test('实际入口找不到正文显示时保留模型结果，并显示预览原因', async () => {
    const host = await runtime({ html: '<iframe></iframe>' });
    const before = host.msg.mes;
    assert.equal(await host.rewrite(), false);
    const diff = host.dom.window.document.querySelector('#t-rewrite-diff-body').textContent;
    assert.match(diff, /仅预览/); assert.match(diff, /攥紧了拳头/); assert.match(diff, /iframe/);
    assert.equal(host.msg.mes, before); assert.deepEqual(host.events, []);
});

test('删除入口保留正文包装及状态数据，并显示实际应用状态', async () => {
    const host = await runtime();
    assert.equal(await host.hooks.runDelete({ source: 'auto' }), true);
    assert.equal(host.msg.mes, '<正文></正文><状态栏>信任：10</状态栏>');
    assert.match(host.dom.window.document.querySelector('#t-delete-match-body').textContent, /已写回/);
    assert.deepEqual(host.events, ['titania_text_patched']);
});

test('不支持 Custom Highlight 的浏览器仍有可选句列表，正文节点与 iframe 保持原实例', async () => {
    const host = await runtime();
    const document = host.dom.window.document;
    const node = document.querySelector('p').firstChild;
    const iframe = document.querySelector('iframe'); const frame = iframe.contentWindow;
    host.hooks.enterInlineSentenceSelection();
    const list = document.querySelector('#t-rewrite-sentence-list');
    assert.equal(list.hidden, false); assert.equal(list.querySelectorAll('.t-rewrite-sentence-row').length, 1);
    assert.equal(document.querySelector('p').firstChild, node);
    assert.equal(document.querySelectorAll('.t-rewrite-select-sentence').length, 0);
    host.hooks.clearInlineSentenceSelection();
    assert.equal(document.querySelector('p').firstChild, node); assert.equal(iframe.contentWindow, frame);
});

test('重新应用改写标记不会替换已有正文节点或前端元素', async () => {
    const host = await runtime();
    const document = host.dom.window.document;
    const node = document.querySelector('p').firstChild;
    const iframe = document.querySelector('iframe');
    host.msg.extra = { titania_rewrite_marks: [{ before: '旧句。', after: '他很愤怒。' }] };
    host.hooks.applyAllRewriteMarksFromChat();
    assert.equal(document.querySelector('p').firstChild, node);
    assert.equal(document.querySelector('iframe'), iframe);
    assert.equal(document.querySelectorAll('.t-rewrite-mark').length, 0);
});

test('最新回复未命中白名单时不选择更早的楼层', async () => {
    const host = await runtime();
    host.ctx.chat.push({ mes: '<其他>新回复。</其他>' });
    const latest = host.hooks.getLatestAssistantMessageFromChat();
    assert.equal(latest.index, 1); assert.equal(latest.content, ''); assert.match(latest.projection.reason, /未回退/);
});

test('模型请求期间原文改变，保留新编辑和旧请求的 Diff 预览', async () => {
    const host = await runtime({ request: async (_options, ctx) => {
        ctx.chat[0].mes = '用户改过的新原文。';
        return JSON.stringify({ task_id: 'test', results: [{ segment_id: 's_1', rewritten_text: '他攥紧了拳头。' }] });
    } });
    assert.equal(await host.rewrite(), false);
    assert.equal(host.msg.mes, '用户改过的新原文。');
    assert.match(host.dom.window.document.querySelector('#t-rewrite-diff-body').textContent, /仅预览/);
    assert.deepEqual(host.events, []);
});
