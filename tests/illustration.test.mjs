import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
// 直接 import 纯模块（它只依赖同样无宿主的 promptOrder.js），用来给夹具造一份默认预设。
// 注意这与 h.load() 在 vm 里加载的是两份实例，互不影响。
import { ILLUSTRATION_PRESETS_KEY, MANAGED_ENTRIES } from '../src/core/illustrationPresets.js';

/** 夹具默认的选景预设：托管条目的副本。没有它，任何触发选景的用例都会撞上「还没有预设」。 */
const seededPresets = () => ({
    [ILLUSTRATION_PRESETS_KEY]: {
        version: 2,
        active_preset_id: 'test-preset',
        presets: [{
            id: 'test-preset',
            name: '测试预设',
            entries: MANAGED_ENTRIES.map(entry => ({ ...entry, managed: true })),
        }],
    },
});

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9yQAAAAASUVORK5CYII=';
const png = new Blob([Buffer.from(PNG_BASE64, 'base64')], { type: 'image/png' });
// 柏宝绘回的是 data URL 而不是 Blob。同一份字节造两个形状，保证两条路走的是同一套嗅探与校验。
const pngDataUrl = `data:image/png;base64,${PNG_BASE64}`;
const story = '深夜门口，两人隔着半开的门对视。';
const excerpt = '两人隔着半开的门对视';
// v2 草稿：新接口的图源与模型由供应方决定且不可覆盖，草稿只记交给哪个生图后端。
const draft = () => ({
    version: 2, backend: 'cosmos',
    scene: { summary: '深夜门口的重逢。', sourceExcerpt: excerpt },
    prompts: { positivePrompt: 'two people, doorway, night', negativePrompt: '', characterPrompts: [{ positivePrompt: 'black hair', negativePrompt: '', position: { x: 0.3, y: 0.5 } }] },
});
// v1 草稿：升级前落盘的记录形状，用来验证读时迁移与备份往返。
const draftV1 = () => ({
    version: 1, imageSource: 'novelai', model: 'nai-test',
    scene: { summary: '深夜门口的重逢。' },
    prompts: { positivePrompt: 'two people, doorway, night', negativePrompt: '', characterPrompts: [{ positivePrompt: 'black hair', negativePrompt: '', position: { x: 0.3, y: 0.5 } }] },
});
// 选景 LLM 的默认回复：摘录取自 story，保证能通过原文校验。
const sceneReply = (overrides = {}) => JSON.stringify({
    summary: '深夜门口的重逢。', sourceExcerpt: excerpt,
    positivePrompt: 'two people, doorway, night', negativePrompt: '',
    characters: [{ positivePrompt: 'black hair', negativePrompt: '', position: { x: 0.3, y: 0.5 } }],
    ...overrides,
});

async function waitFor(check, label = 'condition') {
    for (let i = 0; i < 150; i++) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out: ${label}`);
}

/** 去掉注释的源码。断言「某个东西不再被引用」时必须用它 —— 注释里提一嘴不算引用。 */
function stripped(file) {
    return readFileSync(path.join(project, file), 'utf8')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * jsdom 既没有布局（getBoundingClientRect 全返回 0），也没有可靠的 DragEvent / DataTransfer，
 * 两个都手搓。凡几何相关的用例必须先给目标卡片桩 rect —— 网格落点算得准不准，
 * 自动化测不了，只能真机看（见 docs 的验证一节）。
 */
function stubRect(element, { top, left, width = 100, height = 40 }) {
    element.getBoundingClientRect = () => ({
        top, left, width, height, right: left + width, bottom: top + height, x: left, y: top,
    });
}

function fireDrag(window, element, type, { x = 0, y = 0, id = '' } = {}) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    event.clientX = x;
    event.clientY = y;
    event.dataTransfer = { effectAllowed: '', dropEffect: '', setData() {}, getData: () => id };
    element.dispatchEvent(event);
    return event;
}

function harness() {
    // 结构与真实主界面一致：#t-overlay > #t-main-view > .t-content-wrapper > #t-output-content。
    // 配图面板开在 body 上、灯箱开在面板自己的 root 里，所以正文那几层仍要照着搭，
    // 才能断言「正文里不出现任何配图元素」。
    const dom = new JSDOM(
        '<!doctype html><body><div id="t-overlay"><div id="t-main-view">'
        + '<div class="t-content-wrapper"><div id="t-output-content"></div></div>'
        + '</div></div></body>',
        { url: 'http://localhost:8000/' },
    );
    const state = {
        settings: seededPresets(), files: new Map(), uploads: 0, saveFails: false,
        generateCalls: [], llmCalls: [],
        // toastr 桩：记录 [kind, message, title]。插件里所有调用点都写了 `if (window.toastr)`，
        // 所以以前没有它也能跑；自动配图的「每条 toastr 说明」是它的产品行为，必须能断言。
        toasts: [],
        // 选景 LLM 的默认实现；单个用例可替换成挂起、报错或返回坏格式。
        llmHandler: () => sceneReply(),
        // 角色身份桩：默认没有角色卡（等同群聊/无卡），用例按需覆盖。
        cardKey: '', cards: [], characterDescription: '',
        // 用户设定（Persona）桩：默认空，用例按需覆盖。
        userPersona: { name: '', description: '' },
        // 确认框：默认放行，用例可改成 false 来测「用户点了取消」。
        confirmResult: true, promptResult: null,
        // STscript 变量存储桩。选景的变量沙箱会经 SillyTavern.getContext() 快照/还原它们，
        // 用例可以预置内容来验证「构建后必须还原」。
        chatMetadata: { variables: {} },
        extensionSettings: { variables: { global: {} } },
        // 柏宝绘桩的可调项：状态、错误、返回的 dataUrl、种子与 charactersApplied。
        baibaiStatus: { backend: 'nai', configured: true, model: 'nai-diffusion-4-5-full', supportsCharacters: true, reason: '' },
        baibaiCalls: [], baibaiError: null, baibaiDataUrl: null, baibaiSeed: 12345, baibaiCharactersApplied: true,
    };
    const { window } = dom;
    window.URL.createObjectURL = URL.createObjectURL;
    window.URL.revokeObjectURL = URL.revokeObjectURL;
    /**
     * 假的事件总线，形状与 ST 的 eventSource 一致（on / removeListener / emit / listenerCount）。
     * 智绘姬适配器靠它下单，用例可以在这里**扮 chatu8**：接单，然后回一条响应。
     */
    const busListeners = new Map();
    const bus = {
        on(name, handler) {
            if (!busListeners.has(name)) busListeners.set(name, []);
            busListeners.get(name).push(handler);
        },
        removeListener(name, handler) {
            const list = busListeners.get(name);
            if (!list) return;
            const index = list.indexOf(handler);
            if (index !== -1) list.splice(index, 1);
        },
        emit(name, payload) {
            for (const handler of [...(busListeners.get(name) || [])]) handler(payload);
        },
        listenerCount(name) { return (busListeners.get(name) || []).length; },
        /** 摘掉某一类事件的**所有**接单者：用来模拟「它没在听」（它在未启用/渠道没选时不注册监听）。 */
        clear(name) { busListeners.delete(name); },
    };
    class TestFileReader {
        readAsDataURL(blob) {
            blob.arrayBuffer().then(bytes => {
                this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;
                this.onload?.();
            }, () => this.onerror?.());
        }
    }
    const environment = {
        getExtData: () => state.settings,
        saveExtData: () => {},
        saveExtDataImmediate: async () => !state.saveFails,
        uploadTextFile: async (name, text) => {
            const file = `/user/files/${name}`;
            state.files.set(file, new Blob([text], { type: 'application/json' }));
            return file;
        },
        fetchTextFile: async file => {
            if (!state.files.has(file)) throw new Error('Missing record');
            return state.files.get(file).text();
        },
        // 真删。原先桩成空操作，于是「文件到底删没删」根本测不了。
        // 返回 true 即使文件本来就不在 —— 与真实现的 404 也算成功一致。
        deleteUserFile: async filePath => { state.files.delete(filePath); return true; },
        buildPromptTextFromTheater: html => {
            const document = new window.DOMParser().parseFromString(html, 'text/html');
            document.querySelectorAll('style,script').forEach(node => node.remove());
            return document.body.textContent.trim();
        },
        getActiveConnection: () => ({ useSTConnection: false, url: 'http://api.test', key: 'k', model: 'test-model' }),
        sendChatRequestWithConnection: (conn, messages, options = {}) => {
            state.llmCalls.push({ conn, messages, options });
            // 真实连接层会把 signal 接到 fetch 上；桩件也必须遵守，否则「取消等待」测不出效果。
            return new Promise((resolve, reject) => {
                const onAbort = () => reject(Object.assign(new Error('已取消'), { name: 'AbortError', code: 'ABORTED' }));
                if (options.signal?.aborted) { onAbort(); return; }
                options.signal?.addEventListener('abort', onAbort, { once: true });
                Promise.resolve().then(() => state.llmHandler(messages, options)).then(resolve, reject);
            });
        },
        // 角色身份：默认没有角色卡（群聊/无卡），用例可以覆盖。
        getCharacterCardKey: () => state.cardKey,
        listCharacterCards: () => state.cards,
        getCurrentCharacterDescription: () => state.characterDescription,
        getCurrentUserPersona: () => state.userPersona,
        // STscript 变量宏桩：正则与 ST variables.js 的 getVariableMacros() 逐条一致，
        // handler 打到 state 的假存储上。用例只需 set/get 两族，其余保留是为了让
        // applyVariableMacros 面对的是真实形状（10 条平铺的 {regex, replace}），
        // 而不是一个为测试定制的简化版。语义细节（数值转换、索引参数）不在这里复刻。
        getVariableMacros: () => {
            const local = state.chatMetadata.variables;
            const global = state.extensionSettings.variables.global;
            const read = store => name => String(store[name.trim()] ?? '');
            const add = (store, name, value) => {
                const key = name.trim();
                const current = Number(store[key]);
                store[key] = Number.isFinite(current) ? String(current + Number(value)) : `${store[key] ?? ''}${value}`;
            };
            const shift = (store, name, delta) => {
                const key = name.trim();
                store[key] = String((Number(store[key]) || 0) + delta);
                return '';
            };
            const put = (store, name, value) => { store[name.trim()] = value; return ''; };
            return [
                { regex: /{{setvar::([^:]+)::([^}]*)}}/gi, replace: (_, name, value) => put(local, name, value) },
                { regex: /{{addvar::([^:]+)::([^}]+)}}/gi, replace: (_, name, value) => { add(local, name, value); return ''; } },
                { regex: /{{incvar::([^}]+)}}/gi, replace: (_, name) => shift(local, name, 1) },
                { regex: /{{decvar::([^}]+)}}/gi, replace: (_, name) => shift(local, name, -1) },
                { regex: /{{getvar::([^}]+)}}/gi, replace: (_, name) => read(local)(name) },
                { regex: /{{setglobalvar::([^:]+)::([^}]*)}}/gi, replace: (_, name, value) => put(global, name, value) },
                { regex: /{{addglobalvar::([^:]+)::([^}]+)}}/gi, replace: (_, name, value) => { add(global, name, value); return ''; } },
                { regex: /{{incglobalvar::([^}]+)}}/gi, replace: (_, name) => shift(global, name, 1) },
                { regex: /{{decglobalvar::([^}]+)}}/gi, replace: (_, name) => shift(global, name, -1) },
                { regex: /{{getglobalvar::([^}]+)}}/gi, replace: (_, name) => read(global)(name) },
            ];
        },
    };
    const context = vm.createContext({
        console, Blob, Buffer, Uint8Array, TextEncoder, AbortController, structuredClone,
        setTimeout, clearTimeout, atob, btoa, crypto: globalThis.crypto,
        window, document: window.document, CustomEvent: window.CustomEvent,
        MutationObserver: window.MutationObserver, Option: window.Option, URL: window.URL,
        FileReader: TestFileReader, __environment: environment,
        // 变量沙箱经 SillyTavern.getContext() 拿 chat_metadata / extension_settings。
        // 缺了它沙箱会退化成空操作，用例就测不出「构建后还原」。
        // eventSource 也在同一个上下文里：智绘姬适配器靠它下单（与 chatu8 听的是同一个对象）。
        SillyTavern: {
            getContext: () => ({
                chatMetadata: state.chatMetadata,
                extensionSettings: state.extensionSettings,
                eventSource: bus,
            }),
        },
        // 界面里的 confirm / prompt 要走 vm 全局，缺失时点击处理器会抛 ReferenceError。
        confirm: () => state.confirmResult !== false,
        prompt: () => state.promptResult,        fetch: async (url, options) => {
            if (url === '/api/files/upload') {
                state.uploads++;
                const body = JSON.parse(options.body);
                const file = `/user/files/${body.name}`;
                const type = body.name.endsWith('.png') ? 'image/png' : body.name.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
                state.files.set(file, new Blob([Buffer.from(body.data, 'base64')], { type }));
                return Response.json({ path: file });
            }
            return state.files.has(url) ? new Response(state.files.get(url)) : new Response('', { status: 404 });
        },
    });
    const sources = new Map([
        [path.join(project, 'src/utils/storage.js'), 'export const { getExtData, saveExtData, saveExtDataImmediate } = __environment;'],
        [path.join(project, 'src/utils/userFiles.js'), 'export const { uploadTextFile, fetchTextFile, deleteUserFile } = __environment; export const utf8ByteLength = x => x.length; export const verifyUserFiles = async () => true;'],
        [path.join(project, 'src/core/chatInjector.js'), 'export const { buildPromptTextFromTheater } = __environment;'],
        [path.join(project, 'src/core/logger.js'), 'export const TitaniaLogger = { warn() {}, error() {}, info() {} };'],
        // 选景走插件自有 LLM：这里只桩掉连接层，不引入 ST 宿主模块。
        [path.join(project, 'src/core/connection.js'), 'export const { getActiveConnection, sendChatRequestWithConnection } = __environment;'],
        // 角色身份来自 ST 上下文；夹具里同样桩掉，避免拉进 world-info.js 等宿主模块。
        [path.join(project, 'src/core/context.js'), 'export const { getCharacterCardKey, listCharacterCards, getCurrentCharacterDescription, getCurrentUserPersona } = __environment;'],
        [path.join(project, 'src/utils/helpers.js'), 'export const getSnippet = x => x; export const parseMeta = () => ({ char: "角色", script: "剧本" }); export const exportAsHtmlFile = async () => {};'],
        ['host:script', 'export const getRequestHeaders = () => ({ "Content-Type": "application/json" });'],
        // 变量宏来自 ST 的 variables.js（真源码里写成 '../../../variables.js'，按打包后的
        // 扩展根解析）。夹具按同一套特例映射到一个桩模块。
        ['host:variables', 'export const { getVariableMacros } = __environment;'],
    ]);
    const modules = new Map();
    function moduleFor(id) {
        if (!modules.has(id)) modules.set(id, new vm.SourceTextModule(sources.get(id) ?? readFileSync(id, 'utf8'), { context, identifier: id }));
        return modules.get(id);
    }
    async function load(relative) {
        const module = moduleFor(path.join(project, relative));
        // 宿主模块的路径是按打包后 index.js 所在的扩展根写的，直接从 src/ 解析会落到项目外。
        // 需要哪个就在这里加一条特例 + 一条 sources 桩。
        const hostStubs = { '../../../../script.js': 'host:script', '../../../variables.js': 'host:variables' };
        if (module.status === 'unlinked') await module.link((specifier, ref) => moduleFor(hostStubs[specifier] ?? path.resolve(path.dirname(ref.identifier), specifier)));
        if (module.status === 'linked') await module.evaluate();
        return module.namespace;
    }
    // toastr 桩。插件里所有调用点都写了 `if (window.toastr)`，补上它只是让那些分支真的执行，
    // 自动配图的「每条 toastr 说明原因」才有东西可断言。
    window.toastr = {
        info: (message, title) => state.toasts.push(['info', message, title]),
        success: (message, title) => state.toasts.push(['success', message, title]),
        warning: (message, title) => state.toasts.push(['warning', message, title]),
        error: (message, title) => state.toasts.push(['error', message, title]),
    };
    // Cosmos dev 分支交付的薄接口：只有 version 与 generateImage，没有能力协商。
    // 返回的是裸 Blob（无类型、无尺寸），由适配层嗅探补齐。
    window.CosmosVision = {
        version: '1.3.0',
        generateImage: async options => {
            state.generateCalls.push(options);
            return { requestId: options.requestId, imageBlobs: [png], prompts: options.prompts };
        },
    };
    // 柏宝绘的公开接口（API v1）。它与 Cosmos 的四处差异都体现在这里：
    // 回 dataUrl 而不是 Blob、一次一张、位置由它固定在居中、NAI 下不吃 negative。
    const baibai = () => ({
        apiVersion: 1,
        pluginVersion: '0.3.0',
        capabilities: { globalApi: true, characterLibrary: true, generate: true, saveToGallery: true, events: true },
        getBackendStatus: () => ({ apiVersion: 1, pluginVersion: '0.3.0', ...state.baibaiStatus }),
        generate: async (request, options = {}) => {
            state.baibaiCalls.push({ request, options });
            if (state.baibaiError) throw Object.assign(new Error(state.baibaiError.message), { code: state.baibaiError.code });
            if (options.signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError', code: 'aborted' });
            return {
                apiVersion: 1, pluginVersion: '0.3.0',
                dataUrl: state.baibaiDataUrl ?? pngDataUrl,
                format: 'png', path: null, seed: state.baibaiSeed,
                backend: state.baibaiStatus.backend,
                charactersApplied: state.baibaiCharactersApplied,
            };
        },
    });
    window.STBaiBaiImage = baibai();
    // 用例删掉全局对象模拟「没装」之后，靠这个把桩装回去。
    const installBaibai = () => { window.STBaiBaiImage = baibai(); return window.STBaiBaiImage; };
    return { ...state, state, load, window, document: window.document, installBaibai, bus, close: () => window.close() };
}

test('stable scene identity survives a reload; regenerated or edited text gets a separate attachment', async t => {
    const h = harness(); t.after(h.close);
    const data = await h.load('src/core/illustrationData.js');
    const source = { content: story, generationId: 'generation-a', scriptId: 'script-a' };
    const first = data.createIllustrationTarget(source);
    assert.equal(first.sceneId, data.createIllustrationTarget(structuredClone(source)).sceneId);
    assert.notEqual(first.sceneId, data.createIllustrationTarget({ ...source, generationId: 'generation-b' }).sceneId);
    assert.notEqual(first.sceneId, data.createIllustrationTarget({ ...source, content: story + '雨停了。' }).sceneId);
    assert.throws(() => data.createIllustrationTarget({ ...source, status: 'running' }), /已完成/);
});

test('backend is detected by method presence rather than version, and unusable payloads are rejected', async t => {
    const h = harness(); t.after(h.close);
    const bridge = await h.load('src/core/cosmosVisionBridge.js');
    const api = h.window.CosmosVision;

    delete h.window.CosmosVision;
    assert.equal(bridge.detectIllustrationBackend().status, 'missing');
    await assert.rejects(bridge.generateTheaterIllustration(draft()), /未检测到 Cosmos Vision/);

    // 旧版（v1 契约）要给一句能照着做的升级提示，而不是笼统的「未连接」。
    h.window.CosmosVision = { apiVersion: '1.0', preparePrompt: () => {}, generate: () => {} };
    assert.equal(bridge.detectIllustrationBackend().status, 'legacy');
    await assert.rejects(bridge.generateTheaterIllustration(draft()), /旧版/);

    // version 是对方插件的版本号，拿它做兼容性判断会随对方发版误判。
    h.window.CosmosVision = { ...api, version: '9.9.9' };
    assert.equal(bridge.detectIllustrationBackend().ready, true);

    h.window.CosmosVision = api;
    const data = await h.load('src/core/illustrationData.js');
    // 画面描述不在这里硬性校验：读路径拿不到正文，也容不下旧记录与自写预设的空摘要。
    // 但它仍要落成字符串（消费端会直接赋给 textContent），而 positivePrompt 依旧是硬要求。
    const noSummary = data.normalizeIllustrationDraft({ ...draft(), scene: {} });
    assert.equal(noSummary.scene.summary, '', '缺 summary 应落成空串而不是 undefined');
    assert.throws(() => data.normalizeIllustrationDraft({ ...draft(), prompts: { ...draft().prompts, positivePrompt: '' } }),
        /正向提示词/, '正向提示词仍然必填 —— 它是这次契约的全部意义');
    await assert.rejects(data.validateIllustrationBlob(new Blob(['<html>Error</html>'], { type: 'image/png' })), /格式不符/);
    const clean = data.normalizeIllustrationDraft({ ...draft(), apiKey: 'must-not-persist' });
    assert.equal('apiKey' in clean, false);
});

test('blobs without a media type are sniffed and measured; every returned image is kept', async t => {
    const h = harness(); t.after(h.close);
    const bridge = await h.load('src/core/cosmosVisionBridge.js');
    // 1x1 PNG 的真实字节，但把 type 抹掉 —— 新接口返回的就是这种裸 Blob。
    const bytes = await png.arrayBuffer();
    const untyped = new Blob([bytes]);
    assert.equal(untyped.type, '');

    h.window.CosmosVision.generateImage = async options => {
        h.state.generateCalls.push(options);
        return { requestId: options.requestId, imageBlobs: [untyped, png], prompts: options.prompts };
    };
    const result = await bridge.generateTheaterIllustration(draft());
    assert.equal(result.images.length, 2);
    assert.equal(result.dropped, 0);
    // 类型靠嗅探补上，否则 validateIllustrationBlob 会因 type 为空直接判成不支持。
    assert.equal(result.images[0].blob.type, 'image/png');
    assert.deepEqual([result.images[0].width, result.images[0].height], [1, 1]);

    // 不是图片就拒绝，不能把 HTML 错误页当配图存下去。
    h.window.CosmosVision.generateImage = async () => ({ requestId: 'r', imageBlobs: [new Blob(['<html>oops</html>'])], prompts: {} });
    await assert.rejects(bridge.generateTheaterIllustration(draft()), /不是可识别的图片/);

    // 空结果
    h.window.CosmosVision.generateImage = async () => ({ requestId: 'r', imageBlobs: [], prompts: {} });
    await assert.rejects(bridge.generateTheaterIllustration(draft()), /没有返回图片/);
});

test('only content prompts are sent to Cosmos; quality and style words stay out', async t => {
    const h = harness(); t.after(h.close);
    const bridge = await h.load('src/core/cosmosVisionBridge.js');
    await bridge.generateTheaterIllustration(draft());
    const sent = h.state.generateCalls[0].prompts;
    // 供应方会把我们给的文本插进用户预设再追加质量词与画师串；
    // 这里再写一遍就是重复叠加，所以适配层只透传草稿里的内容。
    assert.equal(sent.positivePrompt, draft().prompts.positivePrompt);
    assert.equal(sent.characterPrompts[0].positivePrompt, 'black hair');
    assert.equal('imageSource' in h.state.generateCalls[0], false);
    assert.equal('model' in h.state.generateCalls[0], false);
});

test('saving an older displayed scene uses its archived branch, even when the active branch has identical text', async t => {
    const h = harness(); t.after(h.close);
    const data = await h.load('src/core/illustrationData.js');
    const active = { branchKey: 'new', rounds: [{ generationId: 'new-id', content: story }] };
    const archived = { branchKey: 'old', rounds: [{ generationId: 'old-id', content: story }] };
    assert.equal(data.resolveDisplayedFavoriteBranch({ generationId: 'old-id', content: story }, active, [archived]).branchKey, 'old');
    const otherChat = data.resolveDisplayedFavoriteBranch({ generationId: 'other-chat-id', content: story }, active, [archived]);
    assert.equal(otherChat.rounds.length, 0);
    assert.equal(otherChat.branchKey, '');
});

test('cancel detaches from an uncooperative provider and ignores its late image', async t => {
    const h = harness(); t.after(h.close);
    const bridge = await h.load('src/core/cosmosVisionBridge.js');
    let deliver, called = false;
    h.window.CosmosVision.generateImage = async options => {
        called = true;
        h.state.generateCalls.push(options);
        return new Promise(resolve => { deliver = () => resolve({ requestId: options.requestId, imageBlobs: [png], prompts: options.prompts }); });
    };
    const controller = new AbortController();
    const pending = bridge.generateTheaterIllustration(draft(), { signal: controller.signal });
    await waitFor(() => called);
    // 取消信号要透传给供应方，让它有机会真正中断后端计算。
    assert.equal(h.state.generateCalls[0].signal, controller.signal);
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    deliver();
    assert.equal(h.state.uploads, 0);
});

test('a provider that rejects a cancelled request is reported as a cancel, not a failure', async t => {
    const h = harness(); t.after(h.close);
    const bridge = await h.load('src/core/cosmosVisionBridge.js');
    const controller = new AbortController();
    // Cosmos 的错误是普通 Error、没有 code；界面靠 name/code 识别取消，所以适配层要翻译。
    h.window.CosmosVision.generateImage = async () => {
        controller.abort();
        throw new Error('请求已中断');
    };
    await assert.rejects(
        bridge.generateTheaterIllustration(draft(), { signal: controller.signal }),
        error => error.name === 'AbortError' && error.code === 'ABORTED',
    );

    // 真实失败要保留原文，不能被误判成取消。
    const live = new AbortController();
    h.window.CosmosVision.generateImage = async () => { throw new Error('账户额度不足'); };
    await assert.rejects(
        bridge.generateTheaterIllustration(draft(), { signal: live.signal }),
        error => error.code === 'GENERATION_FAILED' && /额度不足/.test(error.message),
    );
});

test('save retry reuses generated bytes, retains old pointer on failure and never regenerates', async t => {
    const h = harness(); t.after(h.close);
    const store = await h.load('src/core/illustrationStore.js');
    const first = { draft: draft(), image: { blob: png, width: 1, height: 1 } };
    const original = await store.saveGeneratedIllustration('scene-test', first);
    const oldPointer = structuredClone(h.state.settings.illustration_index['scene-test']);
    h.state.saveFails = true;
    const second = { draft: draft(), image: { blob: png, width: 1, height: 1 } };
    await assert.rejects(store.saveGeneratedIllustration('scene-test', second), /重试保存/);
    assert.equal(JSON.stringify(h.state.settings.illustration_index['scene-test']), JSON.stringify(oldPointer));
    assert.equal((await store.readSceneIllustrations('scene-test')).selectedId, original.selectedId);
    const uploads = h.state.uploads;
    h.state.saveFails = false;
    const recovered = await store.saveGeneratedIllustration('scene-test', second);
    assert.equal(h.state.uploads, uploads);
    assert.equal(recovered.images.length, 2);
    assert.equal(recovered.selectedId, second.id);
});

test('backup restores assets and favorites on a fresh installation; missing asset aborts before writes', async t => {
    const h = harness(); t.after(h.close);
    const store = await h.load('src/core/illustrationStore.js');
    const portability = await h.load('src/core/illustrationPortability.js');
    const record = await store.saveGeneratedIllustration('scene-backup', { draft: draft(), image: { blob: png, width: 1, height: 1 } });
    const picture = store.selectedIllustration(record);
    const favs = [{ id: 1, items: [{ html: `<p>${story}</p>`, illustration: picture }] }];
    const backup = await portability.exportIllustrationBackup(favs);
    const input = { ...structuredClone(h.state.settings), favs };
    const fresh = harness(); t.after(fresh.close);
    const restore = await fresh.load('src/core/illustrationPortability.js');
    const restored = await restore.restoreIllustrationBackup(backup, input);
    const newPicture = restored.favs[0].items[0].illustration;
    assert.notEqual(newPicture.filePath, picture.filePath);
    assert.ok(fresh.state.files.has(newPicture.filePath));
    Object.assign(fresh.state.settings, restored);
    const freshStore = await fresh.load('src/core/illustrationStore.js');
    assert.equal((await freshStore.readSceneIllustrations('scene-backup')).images[0].filePath, newPicture.filePath);
    const broken = structuredClone(backup); delete broken.assets[picture.filePath];
    const count = fresh.state.files.size;
    await assert.rejects(restore.restoreIllustrationBackup(broken, input), /缺少/);
    assert.equal(fresh.state.files.size, count);
});

test('favorite body roundtrip keeps illustration metadata without injecting it into story HTML', async t => {
    const h = harness(); t.after(h.close);
    const store = await h.load('src/core/illustrationStore.js');
    const favoriteStore = await h.load('src/core/favsStore.js');
    const picture = store.selectedIllustration(await store.saveGeneratedIllustration('scene-fav', { draft: draft(), image: { blob: png, width: 1, height: 1 } }));
    for (const favorite of [
        { id: 1, type: 'plain', html: story, illustration: picture },
        { id: 2, type: 'chain', items: [{ html: story, illustration: picture }] },
    ]) {
        const body = favoriteStore.buildFavBody(favorite);
        const file = `/user/files/fav-${favorite.id}.json`;
        h.state.files.set(file, new Blob([JSON.stringify(body)]));
        const ui = { id: favorite.id, _file: file, _rev: 1 };
        await favoriteStore.ensureFavBody(ui);
        const segment = favorite.type === 'chain' ? ui.items[0] : ui;
        assert.equal(segment.html, story);
        assert.equal(segment.illustration.filePath, picture.filePath);
    }
});

test('panel previews selection, edits character prompts, generates, persists and calls original favorite callback', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    let saved = null;
    const target = data.createIllustrationTarget({ content: `<p>${story}</p>`, scriptId: 'a', generationId: 'g-ui', scriptName: '雨夜' });
    const another = data.createIllustrationTarget({ content: '另一轮', scriptId: 'a', generationId: 'g-ui-other', scriptName: '另一轮' });
    ui.openIllustrationWindow([{ ...target, illustration: null, onSelected: async image => { saved = image; } }, another]);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    await waitFor(() => !action('prepare').disabled, 'API ready');
    action('prepare').click();
    await waitFor(() => !action('generate').disabled, 'draft ready');
    // 选景只带调用方给的素材：正文在 user 消息里，规范作 system 消息。
    const messages = h.state.llmCalls[0].messages;
    assert.equal(messages[0].role, 'system');
    assert.ok(messages.find(m => m.role === 'user').content.includes(story));
    assert.equal(h.state.llmCalls[0].options.stream, false);
    h.document.querySelector('[data-field="positive"]').value = 'edited scene';
    h.document.querySelector('[data-character="0"][data-key="positivePrompt"]').value = 'white hair';
    action('generate').click();
    await waitFor(() => saved, 'saved picture');
    assert.equal(h.state.generateCalls[0].prompts.positivePrompt, 'edited scene');
    assert.equal(h.state.generateCalls[0].prompts.characterPrompts[0].positivePrompt, 'white hair');
    assert.ok(h.state.settings.illustration_index[target.sceneId]);
    assert.ok(h.document.querySelector('.t-illustration-candidate img'));
    const targetPicker = h.document.querySelector('[data-field="target"]');
    targetPicker.value = '1'; targetPicker.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await waitFor(() => !targetPicker.disabled);
    targetPicker.value = '0'; targetPicker.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await waitFor(() => !targetPicker.disabled);
    assert.equal(h.document.querySelector(`[data-image-id="${saved.id}"]`).textContent, '当前配图');
    action('close').click();
});

test('re-running selection carries the scenes already picked into the next request', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const target = data.createIllustrationTarget({ content: `<p>${story}</p>`, generationId: 'g-alternate' });
    ui.openIllustrationWindow(target);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    await waitFor(() => !action('prepare').disabled, 'API ready');

    action('prepare').click();
    await waitFor(() => !action('generate').disabled, 'first draft ready');
    const first = h.state.llmCalls[0].messages.find(m => m.role === 'user').content;
    assert.equal(/已经选过/.test(first), false, '第一次选景不该有排除段');
    // 「必须换一幅」得写在定义任务的 system 条目里。只把它当素材块的标题时，
    // 模型会当上下文读，而 system 那句「选唯一一个最适合的瞬间」压过它 —— 就会原样再选一次。
    const rules = h.state.llmCalls[0].messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    assert.match(rules, /已经选过的画面/, '排除要求必须进选景要求，不能只当素材块的标题');

    action('alternate').click();
    await waitFor(() => h.state.llmCalls.length > 1, 'second selection sent');
    const second = h.state.llmCalls[1].messages.find(m => m.role === 'user').content;
    assert.ok(second.includes('深夜门口的重逢。'), '第二次选景要带上第一次选过的画面摘要');
    action('close').click();
});

test('a reopened panel still excludes the scene the saved record already holds', async t => {
    const h = harness(); t.after(h.close);
    const store = await h.load('src/core/illustrationStore.js');
    const data = await h.load('src/core/illustrationData.js');
    const target = data.createIllustrationTarget({ content: `<p>${story}</p>`, generationId: 'g-reload' });
    // 上一轮已经选过并保存了画面。刷新页面后会话状态没了，只有记录还在。
    await store.saveGeneratedIllustration(target.sceneId, { draft: draft(), image: { blob: png, width: 1, height: 1 } });

    const ui = await h.load('src/ui/illustrationWindow.js');
    ui.openIllustrationWindow(target);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    await waitFor(() => !action('prepare').disabled, 'API ready');
    action('alternate').click();
    await waitFor(() => h.state.llmCalls.length > 0, 'selection sent');
    const sent = h.state.llmCalls[0].messages.find(m => m.role === 'user').content;
    assert.ok(sent.includes('深夜门口的重逢。'), '记录里已有的画面也必须进排除表，否则「换个画面」会原样再选一次');
    action('close').click();
});

test('the panel says so when the model picks the same scene again', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const target = data.createIllustrationTarget({ content: `<p>${story}</p>`, generationId: 'g-repeat' });
    ui.openIllustrationWindow(target);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    const notice = () => h.document.querySelector('[data-role="status"]').textContent;
    await waitFor(() => !action('prepare').disabled, 'API ready');

    action('prepare').click();
    await waitFor(() => !action('generate').disabled, 'first draft ready');
    assert.equal(/又选了同一幅/.test(notice()), false, '第一次选景不该说重复');

    // 选景桩每次都回同一个 summary —— 模型无视排除表正是要如实说出来，而不是静默重复。
    action('alternate').click();
    await waitFor(() => /又选了同一幅/.test(notice()), 'repeat notice');
    assert.match(notice(), /本次额外要求/, '要给一条出路，而不是让用户反复点同一个按钮');
    action('close').click();
});

test('panel can retry saving without paying for another image', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const first = data.createIllustrationTarget({ content: story, generationId: 'first' });
    const second = data.createIllustrationTarget({ content: '另一幕', generationId: 'second' });
    ui.openIllustrationWindow(first);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    await waitFor(() => !action('prepare').disabled);
    action('prepare').click();
    await waitFor(() => !action('generate').disabled);
    h.state.saveFails = true;
    action('generate').click();
    await waitFor(() => !action('save').hidden && !action('save').disabled);
    h.state.saveFails = false;
    action('save').click();
    await waitFor(() => action('save').hidden);
    assert.equal(h.state.generateCalls.length, 1);
    assert.ok(h.state.settings.illustration_index[first.sceneId]);
    // 任务从发起那一刻就绑死在第一轮上，别的轮次不会捡到这次结果。
    assert.equal(h.state.settings.illustration_index[second.sceneId], undefined);
    assert.equal(h.document.querySelector('#t-output-content [data-titania-illustration]'), null);
    action('close').click();
});

test('closing the panel leaves analysis and generation running in the background', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const store = await h.load('src/core/illustrationStore.js');
    const data = await h.load('src/core/illustrationData.js');
    let deliver = null;
    h.window.CosmosVision.generateImage = options => {
        h.state.generateCalls.push(options);
        return new Promise(resolve => { deliver = () => resolve({ requestId: options.requestId, imageBlobs: [png], prompts: options.prompts }); });
    };
    const target = data.createIllustrationTarget({ content: `<p>${story}</p>`, generationId: 'g-background', scriptName: '雨夜' });
    ui.openIllustrationWindow(target);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    await waitFor(() => !action('prepare').disabled, 'API ready');
    action('prepare').click();
    await waitFor(() => !action('generate').disabled, 'draft ready');
    action('generate').click();
    await waitFor(() => deliver, 'generation started');
    action('close').click();
    assert.equal(h.document.querySelector('.t-illustration-window'), null);
    // 关窗不再取消任务：供应方照常返回，图片在后台入库并成为当前配图。
    deliver();
    await waitFor(() => h.state.settings.illustration_index?.[target.sceneId], 'background save');
    const record = await store.readSceneIllustrations(target.sceneId);
    assert.equal(record.images.length, 1);
    assert.equal(record.selectedId, record.images[0].id);
    ui.openIllustrationWindow(target);
    await waitFor(() => h.document.querySelector('.t-illustration-candidate img'), 'gallery after reopen');
    assert.equal(h.document.querySelector(`[data-image-id="${record.images[0].id}"]`).textContent, '当前配图');
    action('close').click();
});

test('reopening the panel reattaches to the running task and can still cancel it', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    let analysisStarted = false;
    // 选景现在跑在插件自己的 LLM 上：让它挂住不返回，模拟还在通读正文。
    h.state.llmHandler = () => { analysisStarted = true; return new Promise(() => {}); };
    const target = data.createIllustrationTarget({ content: story, generationId: 'g-reattach' });
    ui.openIllustrationWindow(target);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    const status = () => h.document.querySelector('[data-role="status"]').textContent;
    await waitFor(() => !action('prepare').disabled, 'API ready');
    action('prepare').click();
    await waitFor(() => analysisStarted, 'analysis started');
    action('close').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    ui.openIllustrationWindow(target);
    await waitFor(() => !action('cancel').hidden, 'cancel visible after reopen');
    assert.match(status(), /正在通读正文/);
    assert.equal(h.document.querySelector('[data-field="text"]').disabled, true, 'task still occupies the panel');
    action('cancel').click();
    await waitFor(() => action('cancel').hidden, 'job cleared');
    assert.match(status(), /已取消等待/);
    assert.equal(h.document.querySelector('[data-field="text"]').disabled, false);
    action('close').click();
});

test('gallery thumbnails open the lightbox inside the panel, and the prose stays clean', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const store = await h.load('src/core/illustrationStore.js');
    const content = `<p>清晨，雨还没停。</p><p>${story}</p><p>她合上门。</p>`;
    const target = data.createIllustrationTarget({ content, generationId: 'g-lightbox', scriptId: 'script-lightbox' });
    const record = await store.saveGeneratedIllustration(target.sceneId, { draft: draft(), image: { blob: png, width: 1, height: 1 } });
    const picture = store.selectedIllustration(record);
    // 正文照旧渲染进 shadow DOM —— 配图元素一个都不该出现在里面。
    const container = h.document.getElementById('t-output-content');
    const host = h.document.createElement('div');
    host.className = 't-shadow-host';
    host.attachShadow({ mode: 'open' }).innerHTML = `<div class="t-shadow-content">${content}</div>`;
    container.append(host);

    ui.openIllustrationWindow(target);
    const thumb = () => h.document.querySelector('.t-illustration-candidate-open');
    const lightbox = () => h.document.querySelector('.t-illustration-lightbox');
    await waitFor(() => thumb(), 'gallery rendered');

    assert.equal(host.shadowRoot.querySelector('.t-shadow-content [data-titania-illustration]'), null);
    assert.equal(container.querySelector('[data-titania-illustration]'), null);
    // 缩略图不再是开新标签页的链接：点它开的是灯箱。
    assert.equal(thumb().tagName, 'BUTTON');
    assert.equal(h.document.querySelector('.t-illustration-candidate a[target="_blank"]'), null);

    thumb().click();
    await waitFor(() => lightbox(), 'lightbox opened');
    assert.equal(lightbox().querySelector('.t-illustration-lightbox-image').getAttribute('src'), picture.filePath);
    assert.equal(lightbox().querySelector('.t-illustration-lightbox-caption').textContent, draft().scene.summary);
    // 灯箱必须长在面板自己的 root 里：挂到外面（#t-overlay 有 isolation）会藏在面板后面。
    assert.equal(lightbox().parentElement.classList.contains('t-illustration-window'), true);

    // 三路关闭各走一遍。灯箱不碰图库，缩略图节点每次都还在。
    h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(lightbox(), null, 'Esc 应关掉灯箱');
    thumb().click();
    await waitFor(() => lightbox(), 'lightbox reopened');
    lightbox().querySelector('.t-illustration-lightbox-backdrop').click();
    assert.equal(lightbox(), null, '点遮罩应关掉灯箱');
    thumb().click();
    await waitFor(() => lightbox(), 'lightbox reopened again');
    lightbox().querySelector('.t-illustration-lightbox-close').click();
    assert.equal(lightbox(), null, '关闭按钮应关掉灯箱');

    // 灯箱的 Esc 监听挂在 document 上，不随面板 root 一起消失 ——
    // 面板关闭必须显式收掉它，否则它会替别人吞掉 Esc（禅模式就是这么丢的）。
    const seen = [];
    h.document.addEventListener('keydown', () => seen.push('escape'));
    const fireEscape = () => h.document.body.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    thumb().click();
    await waitFor(() => lightbox(), 'lightbox opened before closing the panel');
    fireEscape();
    assert.deepEqual(seen, [], '灯箱开着时 Esc 应被它拦下');
    thumb().click();
    await waitFor(() => lightbox(), 'lightbox reopened to outlive the panel');
    h.document.querySelector('.t-illustration-window [data-action="close"]').click();
    assert.equal(h.document.querySelector('.t-illustration-window'), null, '面板已关');
    assert.equal(lightbox(), null, '面板关闭要连带关掉灯箱');
    fireEscape();
    assert.deepEqual(seen, ['escape'], '面板关掉后 Esc 不该再被吞');
});

test('HTML exports embed image bytes and reject missing files instead of silently breaking images', async t => {
    const h = harness(); t.after(h.close);
    const store = await h.load('src/core/illustrationStore.js');
    const data = await h.load('src/core/illustrationData.js');
    const portability = await h.load('src/core/illustrationPortability.js');
    const record = await store.saveGeneratedIllustration('scene-export', { draft: draft(), image: { blob: png, width: 1, height: 1 } });
    const picture = store.selectedIllustration(record);
    const html = data.illustrationFigure(picture);
    assert.match(await portability.embedIllustrationsInHtml(html), /src="data:image\/png;base64,/);
    h.state.files.delete(picture.filePath);
    await assert.rejects(portability.embedIllustrationsInHtml(html), /停止导出/);
    assert.equal(data.illustrationFigure({ ...picture, filePath: 'javascript:alert(1)' }), '');
});

test('v1 drafts migrate on read so existing records and backups keep rendering', async t => {
    const h = harness(); t.after(h.close);
    const data = await h.load('src/core/illustrationData.js');
    const store = await h.load('src/core/illustrationStore.js');

    const migrated = data.normalizeIllustrationDraft(draftV1());
    assert.equal(migrated.version, data.ILLUSTRATION_DRAFT_VERSION);
    assert.equal(migrated.backend, 'cosmos');
    // 图源与模型是「调用方指定」时代的字段，新接口不可覆盖，迁移时直接丢弃。
    assert.equal('imageSource' in migrated, false);
    assert.equal('model' in migrated, false);
    assert.equal(migrated.scene.summary, '深夜门口的重逢。');

    // 旧记录渲染走的是同一条 normalize 路径（存储读取、收藏渲染、备份恢复都靠它）。
    const saved = data.normalizeSavedIllustration({ id: 'i1', filePath: '/user/files/titania-illustration-a1.png', draft: draftV1(), width: 1, height: 1, createdAt: 1 });
    assert.equal(saved.draft.backend, 'cosmos');
    assert.ok(data.illustrationFigure(saved).includes('深夜门口的重逢。'));

    // 走一遍存储：v1 草稿存进去，读出来已经是 v2。
    const record = await store.saveGeneratedIllustrations('scene-v1', { images: [{ blob: png, width: 1, height: 1 }], draft: draftV1() });
    assert.equal(record.images[0].draft.version, data.ILLUSTRATION_DRAFT_VERSION);

    // 版本闸门必须真的拦得住，别让未来的形状被无声接受。
    assert.throws(() => data.normalizeIllustrationDraft({ ...draftV1(), version: 3 }), /版本不受支持/);
    assert.throws(() => data.normalizeIllustrationDraft({ ...draft(), backend: 'other' }), /后端不受支持/);
});

test('an excerpt that does not match the text is dropped rather than failing the selection', async t => {
    const h = harness(); t.after(h.close);
    const data = await h.load('src/core/illustrationData.js');
    const text = '深夜门口，两人隔着半开的门对视。';

    // 对得上：原样留下。
    const kept = { scene: { sourceExcerpt: '两人隔着半开的门对视' }, prompts: { positivePrompt: 'x' } };
    assert.equal(data.sanitizeIllustrationExcerpt(kept, text), kept, '对得上就不该产生新对象');

    // 对不上：只丢掉摘录，草稿其余部分原样留下 —— 模型改写一句引文太容易了，
    // 为它废掉整次已经付过费的选景不划算。
    const dropped = data.sanitizeIllustrationExcerpt(
        { scene: { summary: '重逢', sourceExcerpt: '两人在雨中拥抱' }, prompts: { positivePrompt: 'two people' } }, text);
    assert.equal('sourceExcerpt' in dropped.scene, false, '编造的摘录必须被丢掉');
    assert.equal(dropped.scene.summary, '重逢', '摘要等其余字段不受影响');
    assert.equal(dropped.prompts.positivePrompt, 'two people', '提示词不受影响');
    // 不能就地改掉传进来的草稿：调用方还握着原对象。
    const borrowed = { scene: { sourceExcerpt: '两人在雨中拥抱' } };
    data.sanitizeIllustrationExcerpt(borrowed, text);
    assert.equal(borrowed.scene.sourceExcerpt, '两人在雨中拥抱', 'sanitize 必须是纯函数');

    // 模型没给摘录时同样不拦 —— 它只是给用户核对的对照片段。
    assert.ok(data.sanitizeIllustrationExcerpt({ scene: {} }, text));

    // 关键：读路径拿不到正文，所以校验绝不能进 normalize，否则所有旧记录都会渲染失败。
    assert.ok(data.normalizeIllustrationDraft({ ...draft(), scene: { summary: 'x', sourceExcerpt: '正文里根本没有这句' } }));
    assert.ok(data.normalizeSavedIllustration({ id: 'i', filePath: '/user/files/titania-illustration-a1.png', draft: draftV1(), width: 1, height: 1, createdAt: 0 }));
});

test('the panel says so when an invented excerpt was dropped instead of pretending none was given', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    const status = () => h.document.querySelector('[data-role="status"]').textContent;
    const excerptLine = () => h.document.querySelector('[data-role="excerpt"]');

    ui.openIllustrationWindow(data.createIllustrationTarget({ content: story, generationId: 'g-excerpt-note' }));
    await waitFor(() => !action('prepare').disabled, 'API ready');

    // 模型编了一段正文里没有的摘录：选景照常成功，但要说清是「被丢了」而不是「没给」。
    h.state.llmHandler = () => sceneReply({ sourceExcerpt: '正文里根本没有这句' });
    action('prepare').click();
    await waitFor(() => /画面已选好/.test(status()), 'scene selected');
    assert.match(status(), /原文摘录与正文对不上，已丢弃/);
    assert.equal(excerptLine().hidden, true, '丢弃后不显示摘录行');
    action('close').click();

    // 摘录正常时不加这句废话，并且真的把摘录显示出来。
    h.state.llmHandler = () => sceneReply();
    ui.openIllustrationWindow(data.createIllustrationTarget({ content: story, generationId: 'g-excerpt-ok' }));
    await waitFor(() => !action('prepare').disabled, 'API ready again');
    action('prepare').click();
    await waitFor(() => /画面已选好/.test(status()), 'scene selected again');
    assert.equal(/已丢弃/.test(status()), false, '没丢就不该提');
    assert.equal(excerptLine().hidden, false, '摘录行应显示');
    assert.equal(excerptLine().textContent, `原文摘录：${excerpt}`);
    action('close').click();
});

test('a reply carrying only the positive prompt is a complete, usable draft', async t => {
    const h = harness(); t.after(h.close);
    const data = await h.load('src/core/illustrationData.js');
    const scene = await h.load('src/core/illustrationScene.js');

    // 托管条目的「输出格式」要的是三个字段，但模型完全可能只给正提示词（不听话、
    // 或用户换了自写预设）—— 整条链路必须照常走通，缺的部分各有着落。
    const minimal = scene.draftFromSceneReply('{"positivePrompt":"two people, doorway, night"}', '深夜门口，两人对视。');
    assert.equal(minimal.prompts.positivePrompt, 'two people, doorway, night');
    assert.equal(minimal.scene.summary, '', '摘要落成空串，供渲染端判空');
    assert.equal('sourceExcerpt' in minimal.scene, false);
    assert.equal(minimal.prompts.negativePrompt, '', '缺省负向词落成空串');
    // ⚠ 不写 deepEqual(…, [])：草稿来自 vm 沙箱，数组原型与测试侧不同，严格深比较会挂。
    assert.equal(minimal.prompts.characterPrompts.length, 0, '缺省人物分段落成空数组');
    // 空数组必须能原样发给 Cosmos（契约要求它始终是数组）
    assert.ok(Array.isArray(minimal.prompts.characterPrompts));

    // 空摘要不能在图题里留壳：illustrationFigure 是收藏与导出共用的唯一产出点
    //（主界面从 5.4 起改用底部按钮 + 灯箱，不再走这条标记）
    const saved = { id: 'i1', filePath: '/user/files/titania-illustration-a1.png', draft: minimal, width: 10, height: 10, createdAt: 0 };
    const html = data.illustrationFigure(saved);
    assert.equal(html.includes('<figcaption'), false, '摘要为空时不该输出空的图题块');
    assert.match(html, /alt="配图"/, 'alt 回落到通用文案，而不是留空让读屏跳过');
    // 有摘要时图题照旧
    assert.match(data.illustrationFigure({ ...saved, draft: draft() }), /<figcaption[^>]*>深夜门口的重逢。<\/figcaption>/);

    // 旧草稿（带完整摘要）也要继续能渲染，字段仍是可选的而不是被删掉
    assert.ok(data.illustrationFigure({ ...saved, draft: draftV1() }).includes('深夜门口的重逢。'));
});

test('image bytes are sniffed and measured in pure JS, without DOM decoding APIs', async t => {
    const h = harness(); t.after(h.close);
    const bytes = await h.load('src/core/imageBytes.js');
    const pngBytes = new Uint8Array(await png.arrayBuffer());
    const encode = value => new TextEncoder().encode(value);

    assert.equal(bytes.sniffImageMime(pngBytes), 'image/png');
    assert.equal(bytes.readImageSize(pngBytes).width, 1);
    assert.equal(bytes.readImageSize(pngBytes).height, 1);
    // 非图片一律认不出来，不能把 HTML 错误页当图存下去。
    assert.equal(bytes.sniffImageMime(encode('<html><body>error')), null);
    assert.equal(bytes.readImageSize(encode('<svg xmlns=')), null);
    assert.equal(bytes.sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0])), null);
    // 头部被截断时返回 null，不读越界。
    assert.equal(bytes.readImageSize(pngBytes.slice(0, 10)), null);

    // 无类型 Blob 补上类型后才过得了 validateIllustrationBlob（它第一步就要求 blob.type 合法）。
    const inspected = await bytes.inspectImageBlob(new Blob([pngBytes]));
    assert.equal(inspected.blob.type, 'image/png');
    assert.equal(inspected.width, 1);
    assert.equal(await bytes.inspectImageBlob(new Blob(['<html>oops</html>'])), null);
});

test('tolerant JSON extraction repairs packaging but never silently invents data', async t => {
    const h = harness(); t.after(h.close);
    const json = await h.load('src/core/llmJson.js');
    // 用字符串比较避免跨 realm 的原型差异。
    const shape = raw => JSON.stringify(json.extractJsonObject(raw));

    assert.equal(shape('{"a":1}'), '{"a":1}');
    assert.equal(shape('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(shape('好的：\n{"a":1}\n完毕'), '{"a":1}');
    assert.equal(shape('{"a":1,"b":[1,2,],}'), '{"a":1,"b":[1,2]}');
    assert.equal(shape("{'a': 'v'}"), '{"a":"v"}');
    assert.equal(shape('{“a”: “你好”}'), '{"a":"你好"}');
    // 字符串里的裸换行要转义正确：曾有一版预处理会把 `","b":2` 一起吞进字符串，
    // 产出「能解析但内容错误」的结果——那比解析失败危险得多。
    assert.equal(shape('{"a":"第一行\n第二行","b":2}'), '{"a":"第一行\\n第二行","b":2}');
    assert.equal(shape('{"a":1,"b":"未闭合'), '{"a":1,"b":"未闭合"}');
    assert.equal(shape('抱歉，我无法完成。'), 'null');
    assert.equal(shape(''), 'null');
});

test('scene selection reports NO_SCENE, repairs one bad reply, and drops invented excerpts', async t => {
    const h = harness(); t.after(h.close);
    const scene = await h.load('src/core/illustrationScene.js');
    const text = '深夜门口，两人隔着半开的门对视。雨还在下。';

    h.state.llmHandler = () => JSON.stringify({ error: 'NO_SCENE' });
    await assert.rejects(scene.selectIllustrationScene({ theaterText: text }), error => error.code === 'NO_SCENE');

    // 坏格式补救一次就够；第二次仍坏则报错，不做无限重试。
    let calls = 0;
    h.state.llmHandler = () => (++calls === 1 ? '这不是 JSON' : sceneReply());
    assert.equal((await scene.selectIllustrationScene({ theaterText: text })).backend, 'cosmos');
    assert.equal(calls, 2);

    calls = 0;
    h.state.llmHandler = () => { calls += 1; return '始终不是 JSON'; };
    await assert.rejects(scene.selectIllustrationScene({ theaterText: text }), error => error.code === 'INVALID_RESPONSE');
    assert.equal(calls, 2);

    // 编造的原文摘录只丢掉摘录本身，不废掉整次选景，也不重发 —— 画面本身是好的，
    // 重发同一段提示词修不好一句引文，而这一次调用已经付过费了。
    calls = 0;
    h.state.llmHandler = () => { calls += 1; return sceneReply({ sourceExcerpt: '正文里根本没有这句' }); };
    const invented = await scene.selectIllustrationScene({ theaterText: text });
    assert.equal(calls, 1, '不该为一句引文重发');
    assert.equal('sourceExcerpt' in invented.scene, false, '编造的摘录应被丢掉');
    assert.equal(invented.prompts.positivePrompt, 'two people, doorway, night', '画面本身照常留用');
    assert.equal(invented.scene.summary, '深夜门口的重逢。');
    // 界面据此说一句「摘录对不上，已丢弃」—— 不说的话，用户分不清是模型没给还是被丢了。
    assert.equal(invented.excerptDropped, true, '丢弃摘录时要留下信号供界面说明');

    // 摘录对得上时不带这个信号，否则界面会对每次正常的选景都多嘴一句。
    h.state.llmHandler = () => sceneReply();
    const clean = await scene.selectIllustrationScene({ theaterText: text });
    assert.equal('excerptDropped' in clean, false, '正常选景不该带丢弃信号');
    // 信号是给界面的一次性提示，不属于草稿 DTO：落盘时会被白名单丢掉。
    const data = await h.load('src/core/illustrationData.js');
    assert.equal('excerptDropped' in data.normalizeIllustrationDraft(invented), false, '丢弃信号不得进存档');

    await assert.rejects(scene.selectIllustrationScene({ theaterText: '   ' }), error => error.code === 'NO_CONTENT');
});

test('scene selection sees only caller-supplied material, never the current chat', async t => {
    const h = harness(); t.after(h.close);
    const presets = await h.load('src/core/illustrationPresets.js');
    const messages = presets.buildIllustrationMessages({
        theaterText: 'MARKER-STORY',
        participants: 'MARKER-PARTICIPANTS',
        specialRequest: 'MARKER-REQUEST',
        previousScenes: [{ summary: 'MARKER-PREVIOUS' }],
    }, seededPresets());
    const join = role => messages.filter(message => message.role === role).map(message => message.content).join('\n');
    for (const marker of ['MARKER-STORY', 'MARKER-PARTICIPANTS', 'MARKER-REQUEST', 'MARKER-PREVIOUS']) {
        assert.ok(join('user').includes(marker), `素材 ${marker} 应出现在 user 消息里`);
    }
    // 内置的 system 条目是固定文案，不该夹带任何调用方素材。
    assert.equal(/MARKER-/.test(join('system')), false, 'system 消息不该包含素材');
});

test('illustration modules never reach into global generation state or the live chat', async () => {
    // 配图任务用自己的 AbortController：碰 GlobalState 或 cancelGeneration 会让
    // 取消配图误伤正在跑的主聊天生成，反之亦然。
    for (const file of [
        'src/core/illustrationScene.js', 'src/core/cosmosVisionBridge.js', 'src/ui/illustrationWindow.js',
        'src/core/illustrationBackends/registry.js', 'src/core/illustrationBackends/cosmos.js',
        'src/core/illustrationBackends/baibai.js',
    ]) {
        assert.equal(/cancelGeneration|GlobalState/.test(stripped(file)), false, `${file} 不应引用全局生成状态`);
    }
    // 柏宝绘的角色库按**当前聊天**作用域：在 B 聊天给 A 的收藏配图时它会返回 B 的角色，
    // 正是这条铁律要挡的东西。所以那套接口一律不碰，人物外观只由插件自己的
    // character_profiles 维护（它的 getCharacters 拿到的也是当前聊天的库，帮不上忙）。
    assert.equal(/getCharacters/.test(stripped('src/core/illustrationBackends/baibai.js')), false,
        'baibai.js 不应读柏宝绘的角色库');
    // 配图面板只能读 target.cardKey，绝不能现读当前聊天的角色身份 ——
    // 那会在 B 聊天给 A 的收藏配图时，把 B 的角色档案套到 A 的画面上。
    assert.equal(/getContextData|getCharacterCardKey/.test(stripped('src/ui/illustrationWindow.js')), false,
        'illustrationWindow.js 不应读当前聊天的角色身份');
    // 选景只跑 STscript 变量宏（预设在条目里 setvar、后段 getvar，不求值它们整份预设就是死的），
    // 但绝不走 ST 的全套宏引擎：那会连带展开 {{char}} / {{user}} / {{description}}，
    // 同样是在读当前聊天，会串到别的收藏上。
    for (const file of ['src/core/illustrationPresets.js', 'src/ui/illustrationSettingsWindow.js', 'src/core/illustrationScene.js',
        'src/core/illustrationBackends/registry.js']) {
        assert.equal(/substituteParams|evaluateMacros|resolveMacro/.test(stripped(file)), false,
            `${file} 不应调用 ST 的全套宏引擎`);
        assert.equal(/getContextData|getCharacterCardKey/.test(stripped(file)), false,
            `${file} 不应读当前聊天的角色资料`);
    }
    // 正向：变量宏的唯一入口是 stVariables.js，且它只取变量宏。
    const variableLayer = stripped('src/core/stVariables.js');
    assert.ok(/getVariableMacros/.test(variableLayer), 'stVariables.js 应复用 ST 的变量宏定义，而不是手写正则');
    assert.equal(/substituteParams|evaluateMacros/.test(variableLayer), false, 'stVariables.js 不应调用 ST 的全套宏引擎');
    // 叶子的 illustrationPresets.js 只能收注入的求值函数，不能自己 import 宿主模块。
    assert.equal(/from\s+["'][^"']*variables\.js["']/.test(stripped('src/core/illustrationPresets.js')), false,
        'illustrationPresets.js 必须保持叶子，变量宏由调用方注入');
});

test('the panel header entry opens the illustration settings window and closes the panel', async t => {
    const h = harness(); t.after(h.close);
    h.state.settings.character_profiles = {
        version: 1,
        entries: [
            { id: 'p1', name: '在用的', keywords: [], content: 'x', cardKey: '', enabled: true },
            { id: 'p2', name: '停用的', keywords: [], content: 'y', cardKey: '', enabled: false },
        ],
    };
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    ui.openIllustrationWindow(data.createIllustrationTarget({ content: story, generationId: 'g-settings' }));
    await waitFor(() => h.document.querySelector('[data-action="settings"]'), 'settings entry rendered');

    h.document.querySelector('[data-action="settings"]').click();
    const panel = h.document.querySelector('.t-illustration-settings-window');
    assert.ok(panel, '设置窗应被打开');
    // 浮层互斥：开设置窗必须关掉配图面板，不能叠着。
    assert.equal(h.document.querySelector('.t-illustration-window'), null, '配图面板应被关掉');
    // 预设工具条停在夹具播下的那份预设，条目已经铺出来。
    assert.equal(panel.querySelector('[data-role="preset-select"]').value, 'test-preset');
    assert.match(panel.querySelector('[data-role="preset-select"]').selectedOptions[0].textContent, /测试预设/);
    assert.ok(panel.querySelectorAll('[data-entry-id]').length >= 4, '条目应已渲染');
    // 夹具那份预设是能选景的（素材条目带 {{theater_text}}）。
    assert.match(panel.querySelector('[data-role="validation"]').textContent, /可以选景/);
    // 人物外观档案的入口不在设置窗里，它在配图面板顶栏。
    assert.equal(panel.querySelector('[data-action="manage-profiles"]'), null);

    panel.querySelector('[data-action="close"]').click();
    assert.equal(h.document.querySelector('.t-illustration-settings-window'), null);
});

test('closing the settings or profile window returns to the illustration panel', async t => {
    const h = harness(); t.after(h.close);
    h.state.settings.character_profiles = {
        version: 1,
        entries: [{ id: 'p1', name: '阿离', keywords: ['阿离'], content: '银发红瞳', cardKey: 'card:ali', enabled: true }],
    };
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const target = data.createIllustrationTarget({ content: story, generationId: 'g-return', cardKey: 'card:ali' });
    const panel = () => h.document.querySelector('.t-illustration-window');
    const settingsWindow = () => h.document.querySelector('.t-illustration-settings-window');
    const profileWindow = () => h.document.querySelector('.t-profile-window');

    ui.openIllustrationWindow(target);
    await waitFor(() => panel()?.querySelector('[data-action="settings"]'), 'panel ready');

    // 面板 → 设置 → 关闭 → 回面板
    panel().querySelector('[data-action="settings"]').click();
    assert.ok(settingsWindow(), '设置窗应打开');
    settingsWindow().querySelector('[data-action="close"]').click();
    await waitFor(() => panel(), 'panel restored from settings');
    assert.equal(settingsWindow(), null);

    // 面板 → 档案 → 关闭 → 也回面板（档案入口也在面板顶栏）
    panel().querySelector('[data-action="profiles"]').click();
    assert.ok(profileWindow(), '档案窗应打开');
    assert.equal(panel(), null, '开档案窗应关掉配图面板');
    profileWindow().querySelector('[data-action="close"]').click();
    await waitFor(() => panel(), 'panel restored from profiles');
    assert.equal(profileWindow(), null);
    assert.equal(settingsWindow(), null);

    // 回到的是同一轮：会话按 sceneId 复用，所以「用户特意清空」不会被自动重填。
    const participants = panel().querySelector('[data-field="participants"]');
    assert.match(participants.value, /银发红瞳/, '首次应自动填入');
    participants.value = '';
    participants.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    panel().querySelector('[data-action="settings"]').click();
    settingsWindow().querySelector('[data-action="close"]').click();
    await waitFor(() => panel(), 'panel restored again');
    assert.equal(panel().querySelector('[data-field="participants"]').value, '',
        '重开面板应复用同一会话，不能把用户清空的字段重新填上');
    panel().querySelector('[data-action="close"]').click();
});

test('being displaced by another window does not bounce back to the panel', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const panel = () => h.document.querySelector('.t-illustration-window');
    const settingsWindow = () => h.document.querySelector('.t-illustration-settings-window');
    const allWindows = () => h.document.querySelectorAll('.t-illustration-window, .t-illustration-settings-window, .t-profile-window').length;

    ui.openIllustrationWindow(data.createIllustrationTarget({ content: story, generationId: 'g-bounce-1' }));
    await waitFor(() => panel()?.querySelector('[data-action="settings"]'), 'panel ready');
    panel().querySelector('[data-action="settings"]').click();
    assert.ok(settingsWindow());

    // 设置窗开着时从外面直接开面板：设置窗是被顶掉的，不该反弹出又一个面板。
    ui.openIllustrationWindow(data.createIllustrationTarget({ content: story, generationId: 'g-bounce-2' }));
    await waitFor(() => panel(), 'panel reopened externally');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(settingsWindow(), null);
    assert.equal(allWindows(), 1, '不应有被 onClose 反弹出来的额外窗口');
    panel().querySelector('[data-action="close"]').click();
    assert.equal(allWindows(), 0);
});

test('only one illustration window stays open at a time', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const settings = await h.load('src/ui/illustrationSettingsWindow.js');
    const profiles = await h.load('src/ui/characterProfileWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const panel = () => h.document.querySelector('.t-illustration-window');
    const settingsWindow = () => h.document.querySelector('.t-illustration-settings-window');
    const profileWindow = () => h.document.querySelector('.t-profile-window');
    const oneOpen = () => [panel(), settingsWindow(), profileWindow()].filter(Boolean).length;

    ui.openIllustrationWindow(data.createIllustrationTarget({ content: story, generationId: 'g-exclusive' }));
    await waitFor(() => panel(), 'panel open');
    assert.equal(oneOpen(), 1);

    settings.openIllustrationSettingsWindow();
    assert.equal(oneOpen(), 1, '开设置窗后面板应关掉');
    assert.ok(settingsWindow());

    profiles.openCharacterProfileWindow();
    assert.equal(oneOpen(), 1, '开档案窗后设置窗应关掉');
    assert.ok(profileWindow());

    ui.openIllustrationWindow(data.createIllustrationTarget({ content: story, generationId: 'g-exclusive' }));
    await waitFor(() => panel(), 'panel reopened');
    assert.equal(oneOpen(), 1, '重新打开面板后档案窗应关掉');
    assert.equal(profileWindow(), null);
    panel().querySelector('[data-action="close"]').click();
    assert.equal(oneOpen(), 0);
});

test('illustration presets normalize idempotently and migrate the old single-block spec', async t => {
    const h = harness(); t.after(h.close);
    const P = await h.load('src/core/illustrationPresets.js');
    const KEY = P.ILLUSTRATION_PRESETS_KEY;

    // 全新安装：没有任何预设，界面据此走导入/新建引导
    const fresh = {};
    assert.equal(P.ensureIllustrationPresets(fresh), true);
    assert.equal(P.ensureIllustrationPresets(fresh), false, 'ensure 必须幂等，否则每次 getExtData 都会落盘');
    assert.equal(fresh[KEY].presets.length, 0);
    assert.equal(fresh[KEY].active_preset_id, '', '没预设时 active 留空');
    assert.equal(P.needsSetup(fresh), true);
    assert.equal(P.resolveActivePreset(fresh), null);

    // active 悬空 → 回落到第一份（有预设却没有生效的那份，界面连条目都渲染不出来）
    const dangling = { [KEY]: { version: 2, active_preset_id: '不存在', presets: [{ id: 'a', name: 'A', entries: [] }] } };
    P.ensureIllustrationPresets(dangling);
    assert.equal(dangling[KEY].active_preset_id, 'a');
    assert.equal(P.needsSetup(dangling), false, '有预设就不算未配置');
    assert.ok(P.resolveActivePreset(dangling), '回落之后必须能解析出生效的预设');

    // 旧键迁移：自定义文本 → 转成预设，并补上托管条目
    const migrated = { illustration_prompt_spec: { v: 1, text: '我自己的选景规则，没有占位符。' } };
    P.ensureIllustrationPresets(migrated);
    assert.equal(migrated[KEY].presets.length, 1);
    assert.equal(migrated[KEY].active_preset_id, migrated[KEY].presets[0].id);
    // 关键：旧规范不含 {{theater_text}}，不补素材条目的话新守卫会当场报错
    assert.ok(migrated[KEY].presets[0].entries.some(entry => entry.content.includes('{{theater_text}}')));
    assert.equal('illustration_prompt_spec' in migrated, false, '迁移后应删掉旧键');
    assert.equal(P.ensureIllustrationPresets(migrated), false, '迁移后仍然幂等');

    // 陈旧 v 与旧读取器口径一致：忽略，不复活
    const stale = { illustration_prompt_spec: { v: 99, text: '陈旧的' } };
    P.ensureIllustrationPresets(stale);
    assert.equal(stale[KEY].presets.length, 0);

    // 预设库已存在 → 不迁移、也不动旧键（万一新结构有问题，旧键是唯一副本）
    const both = {
        illustration_prompt_spec: { v: 1, text: '自定义' },
        [KEY]: { version: 2, active_preset_id: '', presets: [] },
    };
    assert.equal(P.ensureIllustrationPresets(both), false);
    assert.equal('illustration_prompt_spec' in both, true, '预设库已存在时不该动旧键');

    // 托管条目标记只认代码里存在的 id：手改设置塞进来的不算数
    const forged = { [KEY]: { version: 2, active_preset_id: 'x', presets: [{ id: 'x', name: 'x', entries: [
        { id: 'fake-managed', name: '假托管', content: 'c', managed: true },
        { id: 'select', name: '真托管', content: 'c', managed: true }] }] } };
    P.ensureIllustrationPresets(forged);
    const entries = forged[KEY].presets[0].entries;
    assert.equal(entries.find(entry => entry.id === 'fake-managed').managed, undefined);
    assert.equal(entries.find(entry => entry.id === 'select').managed, true);
    assert.equal(P.isManagedEntry('select'), true);
    assert.equal(P.isManagedEntry('fake-managed'), false);
});

test('placeholder substitution is single-pass and drops only the lines it emptied', async t => {
    const h = harness(); t.after(h.close);
    const P = await h.load('src/core/illustrationPresets.js');
    const data = seededPresets();
    const userOf = request => P.buildIllustrationMessages(request, data).find(message => message.role === 'user').content;

    // 三项空素材时，它们所在的整行（含标题）都要消失，不留孤立标题
    assert.equal(userOf({ theaterText: '正文内容' }), '【小剧场正文】\n正文内容');
    const full = userOf({ theaterText: '正文', participants: '黑发', specialRequest: '冷色', previousScenes: [{ summary: '上一幕' }] });
    assert.match(full, /【人物资料】\n黑发/);
    assert.match(full, /【本次额外要求】\n冷色/);
    assert.match(full, /1\. 上一幕/);

    // 摘要为空时要回落到正面提示词：输出契约只要求 positivePrompt，模型不再给摘要，
    // 不回落的话「已经选过的画面」整块会连同标题一起消失。
    const promptOnly = userOf({ theaterText: '正文', previousScenes: [{ summary: '', positivePrompt: 'two people, doorway, night' }] });
    assert.match(promptOnly, /已经选过的画面/);
    assert.match(promptOnly, /1\. two people, doorway, night/);
    // 三者全空时仍然整块消失，不留孤立标题
    assert.equal(userOf({ theaterText: '正文', previousScenes: [{ summary: '', positivePrompt: '' }] }), '【小剧场正文】\n正文');

    // 单趟替换：正文里字面出现的占位符与 $ 模式都不能被二次处理
    assert.ok(userOf({ theaterText: '她说 {{char}} 走了' }).includes('{{char}}'));
    assert.equal(P.renderEntryContent('{{theater_text}}', { theater_text: 'a$&b$1c' }), 'a$&b$1c');
    assert.equal(P.renderEntryContent('{{theater_text}}', { theater_text: 'x', participants: 'y' }), 'x');
    assert.equal(P.renderEntryContent('[{{unknown}}]', {}), '[{{unknown}}]');
    assert.equal(P.renderEntryContent('a\n\n\n\nb', {}), 'a\n\nb');

    // 守卫：没有预设 / 缺正文占位符 / 重复出现，都必须在发起调用前拦下
    assert.throws(() => P.buildIllustrationMessages({ theaterText: 't' }, {}), error => error.code === 'NO_PRESET');
    const presetWith = entries => ({ [P.ILLUSTRATION_PRESETS_KEY]: { version: 2, active_preset_id: 'p', presets: [{ id: 'p', name: 'x', entries }] } });
    assert.throws(() => P.buildIllustrationMessages({ theaterText: 't' }, presetWith([{ id: 'e', name: 'e', role: 'system', enabled: true, content: '没有占位符' }])),
        error => error.code === 'MISSING_THEATER_TEXT');
    assert.throws(() => P.buildIllustrationMessages({ theaterText: 't' }, presetWith([
        { id: 'a', name: 'a', role: 'system', enabled: true, content: '{{theater_text}}' },
        { id: 'b', name: 'b', role: 'user', enabled: true, content: '{{theater_text}}' }])),
        error => error.code === 'DUPLICATE_THEATER_TEXT');
    // 停用的重复条目不算数
    assert.equal(P.buildIllustrationMessages({ theaterText: 't' }, presetWith([
        { id: 'a', name: 'a', role: 'system', enabled: true, content: '{{theater_text}}' },
        { id: 'b', name: 'b', role: 'user', enabled: false, content: '{{theater_text}}' }])).length, 1);
});

test('selection presets resolve STscript variable macros across entries', async t => {
    const h = harness(); t.after(h.close);
    const P = await h.load('src/core/illustrationPresets.js');
    const V = await h.load('src/core/stVariables.js');
    const presetWith = entries => ({ [P.ILLUSTRATION_PRESETS_KEY]: { version: 2, active_preset_id: 'p', presets: [{ id: 'p', name: 'x', entries }] } });
    const story = { id: 'story', name: '正文', role: 'user', enabled: true, content: '{{theater_text}}' };
    const tail = { id: 'tail', name: '组装', role: 'system', enabled: true, content: '文风：{{getvar::writingstyle}}' };
    // 镜像生产路径：illustrationScene 用沙箱包住整次构建，这里照做，
    // 否则 setvar 会跨用例残留（那正是沙箱存在的理由）。
    const build = (request, data) => {
        const restore = V.beginVariableSandbox();
        try {
            return P.buildIllustrationMessages(request, data, V.applyVariableMacros)
                .map(message => message.content).join('\n');
        } finally { restore(); }
    };

    // 复刻 Dramatron 的「文风挑选」：两条候选写同一个变量名，启用哪条就取到哪条。
    const variant = (id, text) => ({ id, name: id, role: 'system', enabled: false, content: `{{setvar::writingstyle::${text}}}` });
    const light = variant('light', '轻小说文风');
    const vivid = variant('vivid', '视觉小说文风');
    vivid.enabled = true;
    const chosen = build({ theaterText: 't' }, presetWith([light, vivid, story, tail]));
    assert.ok(chosen.includes('文风：视觉小说文风'), '启用的候选应当被取回');
    assert.equal(chosen.includes('{{getvar::writingstyle}}'), false, '变量宏不该留下字面量');
    vivid.enabled = false; light.enabled = true;
    assert.ok(build({ theaterText: 't' }, presetWith([light, vivid, story, tail])).includes('文风：轻小说文风'));

    // 候选全部停用 → setvar 不执行，变量回落成存储里的既有值
    light.enabled = false;
    h.state.chatMetadata.variables.writingstyle = '来自聊天的值';
    const fallen = build({ theaterText: 't' }, presetWith([light, vivid, story, tail]));
    assert.ok(fallen.includes('文风：来自聊天的值'), '没有候选写入时，getvar 读的是存储里的值');
    assert.equal(fallen.includes('轻小说文风') || fallen.includes('视觉小说文风'), false);

    // 整条只剩 setvar 的副作用条目不该变成消息
    const scratch = { id: 'scratch', name: 'scratch', role: 'system', enabled: true, content: '{{setvar::temp::x}}' };
    const restore = V.beginVariableSandbox();
    try {
        assert.equal(P.buildIllustrationMessages({ theaterText: 't' }, presetWith([story, scratch]), V.applyVariableMacros).length, 1);
    } finally { restore(); }

    // 隔离回归：非变量宏一律原样保留
    const iso = { id: 'iso', name: 'iso', role: 'system', enabled: true, content: '{{char}} {{user}} {{description}} {{random::a,b}}' };
    const untouched = build({ theaterText: 't' }, presetWith([story, iso]));
    for (const token of ['{{char}}', '{{user}}', '{{description}}', '{{random::a,b}}']) {
        assert.ok(untouched.includes(token), `${token} 不该被展开`);
    }

    // 素材惰性：宏先跑、素材后注入，所以正文里字面写着的变量宏不会被求值
    const lazy = build({ theaterText: '正文里写着 {{getvar::writingstyle}}' }, presetWith([story]));
    assert.ok(lazy.includes('{{getvar::writingstyle}}'), '素材里的变量宏不该被求值');
});

test('scene selection leaves the chat variables exactly as it found them', async t => {
    const h = harness(); t.after(h.close);
    const data = seededPresets();
    data[ILLUSTRATION_PRESETS_KEY].presets[0].entries = [
        { id: 'set', name: '写入', role: 'system', enabled: true, content: '{{setvar::scratch::临时}}' },
        { id: 'story', name: '正文', role: 'user', enabled: true, content: '{{theater_text}}' },
    ];
    h.state.settings = data;
    h.state.chatMetadata.variables.existing = '原有值';
    h.state.extensionSettings.variables.global.g = '全局值';

    const scene = await h.load('src/core/illustrationScene.js');
    await scene.selectIllustrationScene({ theaterText: story });
    assert.equal(h.state.llmCalls.length, 1, '选景应当照常发出');

    // 写入宏在构建期间真的执行了（否则上面那条 setvar 就白写了），但构建一结束就还原。
    assert.equal(h.state.chatMetadata.variables.scratch, undefined, '写入宏不该留在聊天变量里');
    assert.deepEqual(Object.keys(h.state.chatMetadata.variables), ['existing']);
    assert.equal(h.state.chatMetadata.variables.existing, '原有值');
    assert.deepEqual(Object.keys(h.state.extensionSettings.variables.global), ['g']);
    assert.equal(h.state.extensionSettings.variables.global.g, '全局值');
});

test('importing a tavern preset appends the managed illustration entries', async t => {
    const h = harness(); t.after(h.close);
    const P = await h.load('src/core/illustrationPresets.js');
    // 刻意复现 ST 预设的典型结构：带 marker 的上下文注入条目、空内容条目、多分组顺序表
    const st = {
        name: '某人的预设',
        prompts: [
            { identifier: 'main', name: '主提示', role: 'system', content: 'MAIN', marker: true },
            { identifier: 'chatHistory', name: '聊天记录', role: 'system', content: '', marker: true },
            { identifier: 'a', name: 'A', role: 'system', content: 'AAA' },
            { identifier: 'b', name: 'B', role: 'user', content: 'BBB' },
            { identifier: 'blank', name: '空条目', role: 'system', content: '' },
        ],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'b', enabled: true }, { identifier: 'a', enabled: false },
            { identifier: 'main', enabled: true }, { identifier: 'blank', enabled: true },
        ] }],
    };
    const read = P.readChatCompletionPreset(st);
    // 酒馆自己的条目按 prompt_order 编排在前
    const imported = read.entries.filter(entry => !entry.managed);
    assert.equal(imported.map(entry => entry.name).join(','), 'B,A,空条目');
    assert.equal(imported[1].enabled, false, 'enabled 应跟随 order');
    assert.equal(read.droppedContextEntries, 1, '上下文注入条目应被丢弃并计数');
    assert.equal(imported.some(entry => entry.content === 'MAIN'), false);
    assert.equal(imported.find(entry => entry.name === '空条目').content, '', '空内容不能被改写成 {{marker}}');
    assert.equal(read.name, '某人的预设');

    // 末尾补上小剧场那一套：选景要求 + 图源无关的提示词规范 + 素材 + 输出格式
    const managed = read.entries.filter(entry => entry.managed);
    assert.equal(managed.map(entry => entry.id).join(','), 'select,prompt,material,format',
        '托管条目：选景要求 → 生图提示词规范 → 素材 → 输出格式（契约压在最末）');
    assert.equal(managed.find(entry => entry.id === 'prompt').enabled, true,
        '只剩一份提示词规范，没有互斥关系，默认就该启用');
    assert.equal(managed.at(-1).id, 'format', '输出格式必须排在最后');
    // 契约必须同时要 summary、sourceExcerpt 与 positivePrompt：后两个都曾被摘掉过 ——
    // 只有提示词时「换个画面」排除旧画面只能拿英文提示词去比，面板上也没有原文可供核对。
    const contract = managed.find(entry => entry.id === 'format').content;
    assert.match(contract, /"summary"/, '输出格式必须要求模型返回画面摘要');
    assert.match(contract, /"sourceExcerpt"/, '输出格式必须要求模型返回原文摘录');
    assert.equal(managed.find(entry => entry.id === 'material').role, 'user');
    // 补完之后这份预设必须真的能用来选景（这正是补条目的目的）
    assert.equal(P.validatePresetForSelection(read).ok, true);
    const seededRead = { [P.ILLUSTRATION_PRESETS_KEY]: { version: 2, active_preset_id: read.id, presets: [read] } };
    assert.ok(P.buildIllustrationMessages({ theaterText: '正文' }, seededRead).length > 0);

    // prompt_order 缺失时回退 prompts 顺序，否则会静默导入一个空预设
    const noOrder = P.readChatCompletionPreset({ prompts: [
        { identifier: 'p1', name: 'P1', role: 'system', content: '1' },
        { identifier: 'p2', name: 'P2', role: 'user', content: '2' }] });
    assert.equal(noOrder.entries.filter(entry => !entry.managed).map(entry => entry.name).join(','), 'P1,P2');
    assert.equal(P.readChatCompletionPreset({ prompts: [{ identifier: 'x', role: 'nonsense', content: 'c' }] }).entries[0].role, 'user');

    // 导出 → 再导入：名称/顺序/角色/启用态/内容都要保住
    const original = { name: '我的预设', entries: [
        { id: 'e1', name: '系统', role: 'system', enabled: true, content: 'sys' },
        { id: 'e2', name: '素材', role: 'user', enabled: false, content: '{{theater_text}}' }] };
    const exported = P.serializeIllustrationPreset(original);
    assert.ok(P.isChatCompletionPreset(exported), '导出的应是标准 ST CC 形状');
    const back = P.readChatCompletionPreset(exported);
    assert.equal(back.name, '我的预设');
    assert.equal(back.entries.filter(entry => !entry.managed).map(entry => entry.name).join(','), '系统,素材');
    assert.equal(back.entries[1].role, 'user');
    assert.equal(back.entries[1].enabled, false);
    assert.equal(back.entries[1].content, '{{theater_text}}');
    assert.equal(P.isChatCompletionPreset({ hello: 1 }), false);
});

test('the preset editor edits entries inline without rebuilding them, and managed entries cannot be deleted', async t => {
    const h = harness(); t.after(h.close);
    const P = await h.load('src/core/illustrationPresets.js');
    const ui = await h.load('src/ui/illustrationSettingsWindow.js');
    const data = () => h.state.settings[P.ILLUSTRATION_PRESETS_KEY];
    const card = id => h.document.querySelector(`[data-entry-id="${id}"]`);

    ui.openIllustrationSettingsWindow();
    assert.ok(h.document.querySelector('.t-illustration-settings-window'));
    // 条目默认折叠：一次能看全，要改哪条再点开
    assert.equal(card('select').querySelector('textarea'), null, '条目应默认折叠');
    card('select').querySelector('[data-expand]').click();

    const contentArea = card('select').querySelector('textarea');
    contentArea.value = '改过的选景要求 {{theater_text}}';
    contentArea.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    assert.equal(data().presets[0].entries.find(e => e.id === 'select').content, '改过的选景要求 {{theater_text}}');
    // 输入时不能重画条目 —— 重画会重建 DOM，把输入框的焦点和光标位置一起弄丢
    assert.equal(card('select').querySelector('textarea'), contentArea, '输入不该重建条目 DOM');

    // 托管条目不给删除按钮，只给恢复默认
    assert.equal(card('select').querySelector('[aria-label="删除这条条目"]'), null, '托管条目不可删');
    assert.ok(card('select').querySelector('[aria-label="恢复默认内容"]'), '托管条目应有恢复默认');

    // 恢复默认只还原内容，不动启用态
    card('format').querySelector('.t-profile-toggle').click();
    assert.equal(data().presets[0].entries.find(e => e.id === 'format').enabled, false);
    card('select').querySelector('[aria-label="恢复默认内容"]').click();
    assert.equal(data().presets[0].entries.find(e => e.id === 'select').content, P.managedEntryDefault('select').content);
    assert.equal(data().presets[0].entries.find(e => e.id === 'format').enabled, false, '恢复默认不该动启用态');

    // 非托管条目可以删
    h.document.querySelector('[data-role="entry-actions"] button').click();
    const added = data().presets[0].entries.at(-1);
    assert.ok(card(added.id).querySelector('[aria-label="删除这条条目"]'), '自建条目可删');
    assert.ok(card(added.id).querySelector('input[type="text"]'), '新增的条目应直接展开');
    card(added.id).querySelector('[aria-label="删除这条条目"]').click();
    assert.equal(data().presets[0].entries.some(e => e.id === added.id), false);

    h.document.querySelector('[data-action="close"]').click();
    assert.equal(h.document.querySelector('.t-illustration-settings-window'), null);
});

test('the settings window guides first-time setup when no preset exists', async t => {
    const h = harness(); t.after(h.close);
    const P = await h.load('src/core/illustrationPresets.js');
    const ui = await h.load('src/ui/illustrationSettingsWindow.js');
    h.state.settings[P.ILLUSTRATION_PRESETS_KEY] = { version: 2, active_preset_id: '', presets: [] };

    ui.openIllustrationSettingsWindow();
    const panel = () => h.document.querySelector('.t-illustration-settings-window');
    assert.match(panel().querySelector('[data-role="entries"]').textContent, /还没有选景预设/);
    assert.match(panel().querySelector('[data-role="validation"]').textContent, /还没有选景预设/);

    // 引导里的「新建预设」应造出一份直接可用的预设
    const newButton = [...panel().querySelectorAll('[data-role="entries"] button')].find(b => b.textContent === '新建预设');
    newButton.click();
    const preset = h.state.settings[P.ILLUSTRATION_PRESETS_KEY].presets[0];
    assert.ok(preset, '应造出预设');
    assert.equal(P.validatePresetForSelection(preset).ok, true, '新建出来的预设应能直接选景');
    assert.equal(h.state.settings[P.ILLUSTRATION_PRESETS_KEY].active_preset_id, preset.id);

    // 选景不再报 NO_PRESET
    const scene = await h.load('src/core/illustrationScene.js');
    await scene.selectIllustrationScene({ theaterText: story });
    assert.equal(h.state.llmCalls.length, 1);
    h.document.querySelector('[data-action="close"]').click();
});

test('scene selection follows the active preset', async t => {
    const h = harness(); t.after(h.close);
    const P = await h.load('src/core/illustrationPresets.js');
    const scene = await h.load('src/core/illustrationScene.js');
    const text = '深夜门口，两人隔着半开的门对视。雨还在下。';

    // 换成一份只有两条的用户预设
    h.state.settings[P.ILLUSTRATION_PRESETS_KEY] = {
        version: 2, active_preset_id: 'p',
        presets: [{ id: 'p', name: '我的预设', entries: [
            { id: 's', name: '系统', role: 'system', enabled: true, content: '只输出 JSON。' },
            { id: 'u', name: '素材', role: 'user', enabled: true, content: '正文：{{theater_text}}' }] }],
    };
    await scene.selectIllustrationScene({ theaterText: text });
    assert.equal(h.state.llmCalls[0].messages.length, 2);
    assert.equal(h.state.llmCalls[0].messages[0].content, '只输出 JSON。');
    assert.equal(h.state.llmCalls[0].messages[1].content, `正文：${text}`);

    // 预设缺 {{theater_text}} → 在发起调用之前就报错，不能拿空正文去出图
    h.state.settings[P.ILLUSTRATION_PRESETS_KEY].presets[0].entries[1].content = '没有占位符';
    const before = h.state.llmCalls.length;
    await assert.rejects(scene.selectIllustrationScene({ theaterText: text }), error => error.code === 'MISSING_THEATER_TEXT');
    assert.equal(h.state.llmCalls.length, before, '守卫必须在调用 LLM 之前拦下');

    // 完全没有预设时给出的是另一个清楚的错误，界面据此指路
    h.state.settings[P.ILLUSTRATION_PRESETS_KEY] = { version: 2, active_preset_id: '', presets: [] };
    await assert.rejects(scene.selectIllustrationScene({ theaterText: text }), error => error.code === 'NO_PRESET');
    assert.equal(h.state.llmCalls.length, before);
});

test('appearance profiles match by card binding or keyword and normalize idempotently', async t => {
    const h = harness(); t.after(h.close);
    const profiles = await h.load('src/core/characterProfiles.js');
    const entries = [
        { id: 'a', name: '阿离', keywords: ['阿离'], content: '黑发红瞳', cardKey: 'card:ali', enabled: true },
        { id: 'b', name: '停用', keywords: ['阿离'], content: 'x', cardKey: '', enabled: false },
        { id: 'c', name: '单字', keywords: ['离'], content: 'y', cardKey: '', enabled: true },
        { id: 'd', name: '群聊键', keywords: [], content: 'z', cardKey: 'name:某角色', enabled: true },
    ];
    const names = options => profiles.matchCharacterProfiles(entries, options).map(entry => entry.name).join(',');

    assert.equal(names({ cardKey: 'card:ali', text: '无关正文' }), '阿离');
    assert.equal(names({ cardKey: '', text: '阿离走进来' }), '阿离');
    assert.equal(names({ cardKey: '', text: 'ALICE' }), '');
    // 单字关键词几乎会命中任何正文，规范化时应剔除。
    assert.equal(names({ cardKey: '', text: '离' }), '');
    // 停用的不参与匹配。
    assert.equal(names({ cardKey: '', text: '阿离' }).includes('停用'), false);
    // name: 键不是有效的角色卡绑定（群聊里会串同名角色），只能靠关键词。
    assert.equal(names({ cardKey: 'name:某角色', text: '正文' }), '');
    assert.equal(names({ cardKey: '', text: '' }), '');

    const data = {};
    assert.equal(profiles.ensureCharacterProfiles(data), true);
    assert.equal(profiles.ensureCharacterProfiles(data), false, 'ensure 必须幂等，否则每次 getExtData 都会落盘');
    data.character_profiles = { version: 1, entries: [{ id: 'x', name: 'x', keywords: ['离'], content: 'c', cardKey: 'name:bad' }, null, 'junk'] };
    assert.equal(profiles.ensureCharacterProfiles(data), true);
    const cleaned = data.character_profiles.entries;
    assert.equal(cleaned.length, 1, '垃圾条目应被丢弃');
    assert.equal(cleaned[0].keywords.length, 0, '单字关键词应被剔除');
    assert.equal(cleaned[0].cardKey, '', 'name: 键应被清空');
    assert.equal(cleaned[0].kind, 'character', 'v1 老记录没有 kind，一律落成角色');
    assert.equal(profiles.ensureCharacterProfiles(data), false);
});

test('profiles upgrade to v2 with a default kind, and only write once', async t => {
    const h = harness(); t.after(h.close);
    const profiles = await h.load('src/core/characterProfiles.js');
    // 升级前落盘的形状：version 1，条目里没有 kind。
    const data = {
        character_profiles: {
            version: 1,
            entries: [
                { id: 'a', name: '阿离', keywords: ['阿离'], content: '银发', cardKey: 'card:ali', enabled: true },
                { id: 'b', name: '我', keywords: ['我'], content: '短发', cardKey: '', enabled: true },
                { id: 'c', name: '坏的', keywords: [], content: '', cardKey: '', enabled: true, kind: '垃圾值' },
            ],
        },
    };
    assert.equal(profiles.ensureCharacterProfiles(data), true, 'v1 数据第一次读要写一次');
    assert.equal(data.character_profiles.version, 2);
    assert.deepEqual(
        Array.from(data.character_profiles.entries, entry => entry.kind),
        ['character', 'character', 'character'],
        '老记录一律落成角色 —— 旧数据里没有可靠信号能区分用户档案与没绑卡的角色档案，猜就会误判',
    );
    assert.equal(profiles.ensureCharacterProfiles(data), false,
        '再读一次必须是固定点；否则每次 getExtData() 都会返回 true，变成每次访问都落盘');
});

test('a user profile never keeps a card binding', async t => {
    const h = harness(); t.after(h.close);
    const profiles = await h.load('src/core/characterProfiles.js');
    const data = {
        character_profiles: {
            version: 2,
            entries: [
                { id: 'u', name: '我', keywords: ['我'], content: '短发', cardKey: 'card:ali', kind: 'user', enabled: true },
                { id: 'k', name: '阿离', keywords: ['阿离'], content: '银发', cardKey: 'card:ali', kind: 'character', enabled: true },
            ],
        },
    };
    profiles.ensureCharacterProfiles(data);
    const [user, character] = data.character_profiles.entries;
    assert.equal(user.kind, 'user', '用户档案的归属要保留');
    assert.equal(user.cardKey, '', '用户档案绑了卡会被清掉 —— 那个状态在下拉里表达不出来，也退不回去');
    assert.equal(character.cardKey, 'card:ali', '角色档案的绑定不受影响');
});

test('the shipped defaults agree with the profile store version', async t => {
    const h = harness(); t.after(h.close);
    const defaults = await h.load('src/config/defaults.js');
    const profiles = await h.load('src/core/characterProfiles.js');
    assert.equal(defaults.defaultSettings.character_profiles.version, profiles.CHARACTER_PROFILES_VERSION,
        '全新安装写下的版本号必须与 store 当前版本一致，否则第一次读就白写一次');
});

test('targets carry the character key without letting it into the scene hash', async t => {
    const h = harness(); t.after(h.close);
    const data = await h.load('src/core/illustrationData.js');
    const base = { content: story, generationId: 'g1', scriptId: 's1' };
    const bare = data.createIllustrationTarget(base);
    const keyed = data.createIllustrationTarget({ ...base, cardKey: 'card:ali' });
    // cardKey 只随对象带上；一旦进了散列，illustration_index 里的旧指针会全部变孤儿。
    assert.equal(keyed.sceneId, bare.sceneId);
    assert.equal(keyed.cardKey, 'card:ali');
    assert.equal(bare.cardKey, '');
});

test('appearance profiles fill the participant field and never clobber manual edits', async t => {
    const h = harness(); t.after(h.close);
    h.state.settings.character_profiles = {
        version: 1,
        entries: [
            { id: 'p1', name: '阿离', keywords: ['阿离'], content: '银发红瞳', cardKey: 'card:ali', enabled: true },
            { id: 'p2', name: '旁人', keywords: ['旁人甲'], content: '灰袍', cardKey: '', enabled: true },
        ],
    };
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const target = data.createIllustrationTarget({ content: story, generationId: 'g-prof', cardKey: 'card:ali' });
    ui.openIllustrationWindow(target);
    const field = name => h.document.querySelector(`[data-field="${name}"]`);
    const chip = id => h.document.querySelector(`[data-profile-id="${id}"]`);
    await waitFor(() => chip('p1') && chip('p2'), 'chips rendered');

    // 绑定命中：自动填入并预勾选；未命中的不填。
    assert.match(field('participants').value, /【阿离】\n银发红瞳/);
    assert.equal(chip('p1').classList.contains('is-on'), true);
    assert.equal(chip('p2').classList.contains('is-on'), false);
    assert.equal(/灰袍/.test(field('participants').value), false);

    // 手打一段自己的补充
    field('participants').value += '\n\n手里拿着一把伞。';
    field('participants').dispatchEvent(new h.window.Event('input', { bubbles: true }));

    // 勾上一个未命中的档案：插入它，但不能动用户手打的内容
    chip('p2').click();
    await waitFor(() => /【旁人】/.test(field('participants').value), 'second profile inserted');
    assert.match(field('participants').value, /手里拿着一把伞。/);

    // 取消勾选：只移除那一块
    chip('p1').click();
    await waitFor(() => !/【阿离】/.test(field('participants').value), 'first profile removed');
    assert.match(field('participants').value, /手里拿着一把伞。/);
    assert.match(field('participants').value, /【旁人】/);

    // 实际发给选景 LLM 的就是这个文本
    h.document.querySelector('[data-action="prepare"]').click();
    await waitFor(() => h.state.llmCalls.length > 0, 'scene selection sent');
    const userContent = h.state.llmCalls[0].messages.find(message => message.role === 'user').content;
    assert.match(userContent, /【旁人】\n灰袍/);
    assert.match(userContent, /手里拿着一把伞。/);
    assert.equal(/【阿离】/.test(userContent), false);
    h.document.querySelector('[data-action="close"]').click();
});

test('a favorite carries its own character key so illustrating it elsewhere picks the right profile', async t => {
    const h = harness(); t.after(h.close);
    h.state.settings.character_profiles = {
        version: 1,
        entries: [{ id: 'p1', name: 'A角色', keywords: [], content: '银发红瞳', cardKey: 'card:charA', enabled: true }],
    };
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const field = name => h.document.querySelector(`[data-field="${name}"]`);
    const chip = () => h.document.querySelector('[data-profile-id="p1"]');

    // 升级前的老收藏没存角色身份：不按卡匹配，只能靠关键词/手动。
    ui.openIllustrationWindow(data.createIllustrationTarget({ content: story, generationId: 'fav-legacy', cardKey: '' }));
    await waitFor(() => chip(), 'chips rendered');
    assert.equal(chip().classList.contains('is-on'), false);
    assert.equal(field('participants').value, '');
    h.document.querySelector('[data-action="close"]').click();

    // 存了角色身份的收藏：命中它自己的角色档案（与当前聊天是谁无关）。
    ui.openIllustrationWindow(data.createIllustrationTarget({ content: story, generationId: 'fav-modern', cardKey: 'card:charA' }));
    await waitFor(() => chip(), 'chips rendered again');
    assert.equal(chip().classList.contains('is-on'), true);
    assert.match(field('participants').value, /银发红瞳/);
    h.document.querySelector('[data-action="close"]').click();
});

test('appearance profiles import the user persona as an unbound, name-keyed entry', async t => {
    const h = harness(); t.after(h.close);
    const profiles = await h.load('src/ui/characterProfileWindow.js');
    const core = await h.load('src/core/characterProfiles.js');

    profiles.openCharacterProfileWindow();
    const root = h.document.querySelector('.t-profile-window');
    const status = () => root.querySelector('[data-role="status"]').textContent;
    const entries = () => h.state.settings.character_profiles.entries;
    const importPersona = () => root.querySelector('[data-action="import-persona"]').click();

    // 角色卡描述常带 HTML，用户设定同样会带（ST 的人设框就是富文本），导入时要剥掉。
    h.state.userPersona = { name: '林晚', description: '<p>黑长直，<b>左眼下有颗小痣</b>。</p>' };
    importPersona();
    assert.equal(entries().length, 1);
    assert.equal(entries()[0].name, '林晚');
    assert.equal(entries()[0].content, '黑长直，左眼下有颗小痣。');
    assert.equal(entries()[0].keywords.join(','), '林晚', '名字要写成触发词，否则这条档案永远不会自己命中');
    assert.equal(entries()[0].cardKey, '', '用户设定不属于任何一张角色卡，不能绑卡');
    assert.equal(entries()[0].kind, 'user', '用户设定导入的档案归入用户档案组');
    assert.match(status(), /林晚/);

    // 没有启用的人设：只给一句说明，不要建出一份空档案。
    h.state.userPersona = { name: '林晚', description: '   ' };
    importPersona();
    assert.equal(entries().length, 1, '空人设不该产生档案');
    assert.match(status(), /没有启用中/);

    // 单字名字：档案照进，但规范化会把触发词裁掉（单字几乎命中任何正文），
    // 界面必须如实说明，否则用户只会看到「导入了却永远不生效」。
    h.state.userPersona = { name: '晚', description: '黑长直。' };
    importPersona();
    assert.equal(entries().length, 2);
    assert.match(status(), /触发词/);
    core.ensureCharacterProfiles(h.state.settings);
    assert.equal(entries()[1].keywords.length, 0, '单字触发词确实会被规范化剔除，所以那句提示是必要的');
});

// 档案窗的页签 / 网格 / 拖动。共用一个夹具：种子、开窗、以及按 id 取卡片。
// 两组**不同时渲染**（页签的意义就在这里），所以取卡片前要先切到它所在的那一页。
function profileWindowHarness(h, entries) {
    h.state.settings.character_profiles = { version: 2, entries };
    const root = () => h.document.querySelector('.t-profile-window');
    const kindOf = id => (h.state.settings.character_profiles.entries.find(entry => entry.id === id)?.kind === 'user' ? 'user' : 'character');
    const showTab = kind => {
        const tab = root().querySelector(`[data-action="switch-tab"][data-tab="${kind}"]`);
        if (!tab.classList.contains('is-active')) tab.click();
    };
    return {
        root,
        showTab,
        ids: () => Array.from(h.state.settings.character_profiles.entries, entry => entry.id),
        kinds: () => Array.from(h.state.settings.character_profiles.entries, entry => entry.kind),
        tile: id => {
            showTab(kindOf(id));
            return root().querySelector(`.t-profile-tile[data-profile-id="${id}"]`);
        },
        activeTab: () => root().querySelector('.t-profile-tab.is-active')?.dataset.tab,
        idsIn: kind => {
            showTab(kind);
            return [...root().querySelectorAll('.t-profile-group .t-profile-tile')].map(tile => tile.dataset.profileId);
        },
        // labeled() 把标签文字作为前置文本节点，取 firstChild 才不会把 select 里的选项文字也读进来。
        fieldInput: (scope, text) => [...scope.querySelectorAll('label.t-illustration-field')]
            .find(label => label.firstChild.textContent.startsWith(text))?.querySelector('input'),
    };
}

const charProfile = (id, name, overrides = {}) => ({
    id, name, keywords: [name], content: '银白长发', cardKey: '', kind: 'character', enabled: true, ...overrides,
});
const userProfile = (id, name, overrides = {}) => ({
    id, name, keywords: [name], content: '黑长直', cardKey: '', kind: 'user', enabled: true, ...overrides,
});

test('the window opens on 角色档案 and the tab bar switches between the two', async t => {
    const h = harness(); t.after(h.close);
    const w = profileWindowHarness(h, [charProfile('c1', '阿离'), userProfile('u1', '我')]);
    const profiles = await h.load('src/ui/characterProfileWindow.js');
    profiles.openCharacterProfileWindow();

    // 进窗默认停在角色档案，且用户档案那一组根本不在 DOM 里 —— 这正是「不再挤在一起」的含义。
    assert.equal(w.activeTab(), 'character');
    assert.equal(w.root().querySelector('.t-profile-tile[data-profile-id="u1"]'), null);
    assert.deepEqual([...w.root().querySelectorAll('.t-profile-tile')].map(tile => tile.dataset.profileId), ['c1']);

    w.showTab('user');
    assert.equal(w.activeTab(), 'user');
    assert.deepEqual([...w.root().querySelectorAll('.t-profile-tile')].map(tile => tile.dataset.profileId), ['u1']);

    // 条数挂在页签上，另一组有没有东西不点进去也看得到。
    assert.equal(w.root().querySelector('[data-role="count-character"]').textContent, '1');
    assert.equal(w.root().querySelector('[data-role="count-user"]').textContent, '1');
    assert.equal(w.root().querySelectorAll('.t-profile-tab').length, 2);
    assert.equal(w.root().querySelector('[data-tab="user"]').getAttribute('aria-selected'), 'true');
    h.document.querySelector('.t-profile-window [data-action="close"]').click();
});

test('profiles are grouped by their own kind, and v1 records land under 角色档案', async t => {
    const h = harness(); t.after(h.close);
    const profiles = await h.load('src/ui/characterProfileWindow.js');

    // 空库：两个页签都在，当前这页给一句怎么开始的话，而不是整片空白。
    const closeEmpty = profiles.openCharacterProfileWindow();
    assert.equal(h.document.querySelectorAll('.t-profile-window .t-profile-tab').length, 2);
    assert.equal(h.document.querySelectorAll('.t-profile-window .t-profile-tile-empty').length, 1);
    closeEmpty();

    // 升级前的真实形状：version 1，条目里没有 kind。没绑卡的那条也必须是角色档案 ——
    // 归属不靠「绑没绑卡」推，旧数据里没有可靠信号能区分用户档案与没绑卡的角色档案。
    const w = profileWindowHarness(h, [
        { id: 'c1', name: '阿离', keywords: ['阿离'], content: '银发', cardKey: 'card:ali', enabled: true },
        { id: 'c2', name: '店主', keywords: ['店主'], content: '络腮胡', cardKey: '', enabled: true },
        userProfile('u1', '我'),
    ]);
    h.state.settings.character_profiles.version = 1;
    profiles.openCharacterProfileWindow();

    assert.deepEqual(w.idsIn('character'), ['c1', 'c2'], '没写 kind 的老记录归角色档案，包括没绑卡的那条');
    assert.deepEqual(w.idsIn('user'), ['u1']);
    assert.equal(w.root().querySelector('[data-role="count-character"]').textContent, '2');
    assert.equal(w.root().querySelector('[data-role="count-user"]').textContent, '1');
    assert.equal(h.state.settings.character_profiles.version, 2, '开窗读一次就该把老数据升上来');
    h.document.querySelector('.t-profile-window [data-action="close"]').click();
});

test('a tile expands in place into the full editor, and new profiles arrive expanded', async t => {
    const h = harness(); t.after(h.close);
    const w = profileWindowHarness(h, [charProfile('a', '阿离')]);
    const profiles = await h.load('src/ui/characterProfileWindow.js');
    profiles.openCharacterProfileWindow();

    // 打开时全折叠 —— 一屏能塞下十几条，这正是这次改版要的。
    assert.equal(w.tile('a').querySelector('.t-profile-tile-body'), null);
    assert.equal(w.root().querySelectorAll('.t-profile-tile.is-expanded').length, 0);

    w.tile('a').querySelector('.t-profile-expand').click();
    assert.ok(w.tile('a').classList.contains('is-expanded'));
    assert.equal(w.tile('a').querySelector('.t-profile-expand').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(
        [...w.tile('a').querySelectorAll('label.t-illustration-field')].map(label => label.firstChild.textContent),
        ['档案名称', '触发词（逗号分隔）', '归属与绑定', '外观描写'],
    );

    w.tile('a').querySelector('.t-profile-expand').click();
    assert.equal(w.tile('a').querySelector('.t-profile-tile-body'), null, '再点收起');

    // 新建的那条自动展开：刚加完还要自己找一遍、再点一次，是多余的。
    w.root().querySelector('[data-action="add"]').click();
    const created = h.state.settings.character_profiles.entries[1];
    assert.ok(w.tile(created.id).classList.contains('is-expanded'));
    assert.equal(created.kind, 'character', '新建的默认是角色档案');
    h.document.querySelector('.t-profile-window [data-action="close"]').click();
});

test('typing updates the collapsed summary without rebuilding the editor', async t => {
    const h = harness(); t.after(h.close);
    const w = profileWindowHarness(h, [charProfile('a', '阿离')]);
    const profiles = await h.load('src/ui/characterProfileWindow.js');
    profiles.openCharacterProfileWindow();
    w.tile('a').querySelector('.t-profile-expand').click();

    const type = (input, value) => {
        input.value = value;
        input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    };

    const nameInput = w.fieldInput(w.tile('a'), '档案名称');
    nameInput.focus();
    assert.equal(h.document.activeElement, nameInput);
    type(nameInput, '阿狸');
    assert.equal(h.document.activeElement, nameInput, '打字时重画列表会让每敲一个字就丢焦点');
    assert.equal(w.fieldInput(w.tile('a'), '触发词').value, '阿狸', '触发词仍跟着名字走');
    // 卡片头在折叠时是唯一看得见的东西，必须同步。
    assert.match(w.tile('a').querySelector('.t-profile-expand').textContent, /阿狸/);
    assert.match(w.tile('a').querySelector('.t-profile-tile-meta').textContent, /银白长发|字符/);

    const content = w.tile('a').querySelector('textarea');
    content.focus();
    type(content, '银白长发红瞳');
    assert.equal(h.document.activeElement, content, '外观描写也不能重画');
    assert.match(w.tile('a').querySelector('.t-illustration-hint').textContent, /6 字符/);
    h.document.querySelector('.t-profile-window [data-action="close"]').click();
});

test('the binding select moves a profile between the two groups', async t => {
    const h = harness(); t.after(h.close);
    h.state.cards = [{ cardKey: 'card:ali', name: '阿离卡' }];
    const w = profileWindowHarness(h, [charProfile('a', '阿离')]);
    const profiles = await h.load('src/ui/characterProfileWindow.js');
    profiles.openCharacterProfileWindow();

    const changeTo = value => {
        // 展开状态跨重画保留（按 id 记），所以只有第一次需要点开。
        if (!w.tile('a').classList.contains('is-expanded')) w.tile('a').querySelector('.t-profile-expand').click();
        const select = w.tile('a').querySelector('select');
        select.value = value;
        select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    };

    changeTo('__user__');
    assert.equal(h.state.settings.character_profiles.entries[0].kind, 'user');
    assert.equal(h.state.settings.character_profiles.entries[0].cardKey, '', '换成用户本人必须解绑');
    assert.deepEqual(w.idsIn('user'), ['a'], '卡片要挪到用户档案组');
    assert.deepEqual(w.idsIn('character'), []);
    // 换组等于从当前页签里消失。不说一句的话，看着就像这条档案被删了。
    assert.match(w.root().querySelector('[data-role="status"]').textContent, /移到用户档案/);

    changeTo('card:ali');
    assert.equal(h.state.settings.character_profiles.entries[0].kind, 'character', '选一张卡就回到角色档案');
    assert.equal(h.state.settings.character_profiles.entries[0].cardKey, 'card:ali');
    assert.deepEqual(w.idsIn('character'), ['a']);

    changeTo('');
    assert.equal(h.state.settings.character_profiles.entries[0].kind, 'character');
    assert.equal(h.state.settings.character_profiles.entries[0].cardKey, '', '不绑定仍是角色档案，不是用户档案');
    h.document.querySelector('.t-profile-window [data-action="close"]').click();
});

test('reordering inside a group leaves the other group exactly where it was', async t => {
    const h = harness(); t.after(h.close);
    // 交错排列：角色与用户在数组里各占 0/2 与 1/3 位。
    const w = profileWindowHarness(h, [
        charProfile('a', '甲'), userProfile('b', '乙'), charProfile('c', '丙'), userProfile('d', '丁'),
    ]);
    const profiles = await h.load('src/ui/characterProfileWindow.js');
    profiles.openCharacterProfileWindow();

    const drag = (fromId, toId, x) => {
        // 每次重排都会重画，rect 得重新桩；甲丙在同一行，所以由 X 定前后。
        stubRect(w.tile('a'), { top: 0, left: 0 });
        stubRect(w.tile('c'), { top: 0, left: 110 });
        fireDrag(h.window, w.tile(fromId), 'dragstart');
        fireDrag(h.window, w.tile(toId), 'drop', { x, y: 20 });
    };

    drag('c', 'a', 10);   // 落在甲的左半 → 插到甲之前
    assert.deepEqual(w.ids(), ['c', 'b', 'a', 'd'], '只有角色档案换了位置，用户档案的绝对下标一个都不能动');

    drag('c', 'a', 90);   // 落在甲的右半 → 插回甲之后
    assert.deepEqual(w.ids(), ['a', 'b', 'c', 'd'], '往回拖一次应当复原');
    assert.deepEqual(w.kinds(), ['character', 'user', 'character', 'user'], '拖动不改变归属');
    h.document.querySelector('.t-profile-window [data-action="close"]').click();
});

test('the other group is never on screen, so nothing can be dragged across it', async t => {
    const h = harness(); t.after(h.close);
    const w = profileWindowHarness(h, [charProfile('a', '甲'), userProfile('b', '乙')]);
    const profiles = await h.load('src/ui/characterProfileWindow.js');
    profiles.openCharacterProfileWindow();

    // 页签把两组隔开了：停在角色档案时，用户档案那张卡压根不在 DOM 里，想拖都没有落点。
    // 这比在事件里拒绝更彻底 —— 拒绝是兜底，这里是结构上就做不到。
    assert.equal(w.root().querySelector('.t-profile-tile[data-profile-id="b"]'), null);
    w.showTab('user');
    assert.equal(w.root().querySelector('.t-profile-tile[data-profile-id="a"]'), null);
    assert.deepEqual(w.ids(), ['a', 'b'], '切页签只改视图，不动数据与顺序');
    assert.deepEqual(w.kinds(), ['character', 'user']);
    h.document.querySelector('.t-profile-window [data-action="close"]').click();
});

test('a drag never starts from inside the editor', async t => {
    const h = harness(); t.after(h.close);
    const w = profileWindowHarness(h, [charProfile('a', '甲')]);
    const profiles = await h.load('src/ui/characterProfileWindow.js');
    profiles.openCharacterProfileWindow();
    w.tile('a').querySelector('.t-profile-expand').click();

    // 展开的编辑区在可拖动的卡片内部：没有守卫的话，在文本框里选词会把整张卡拖走。
    fireDrag(h.window, w.tile('a').querySelector('textarea'), 'dragstart');
    assert.equal(w.tile('a').className.includes('is-dragging'), false);
    fireDrag(h.window, w.fieldInput(w.tile('a'), '档案名称'), 'dragstart');
    assert.equal(w.tile('a').className.includes('is-dragging'), false);
    h.document.querySelector('.t-profile-window [data-action="close"]').click();
});

test('every returned image becomes a candidate, with the first adopted', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const store = await h.load('src/core/illustrationStore.js');
    // Cosmos 的张数由它自己的 imageCount 决定，调用方无法强制 1 张。
    h.window.CosmosVision.generateImage = async options => {
        h.state.generateCalls.push(options);
        return { requestId: options.requestId, imageBlobs: [png, png, png], prompts: options.prompts };
    };
    const target = data.createIllustrationTarget({ content: story, generationId: 'g-multi' });
    ui.openIllustrationWindow(target);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    await waitFor(() => !action('prepare').disabled);
    action('prepare').click();
    await waitFor(() => !action('generate').disabled);
    action('generate').click();
    await waitFor(() => h.state.settings.illustration_index?.[target.sceneId], 'saved');
    const record = await store.readSceneIllustrations(target.sceneId);
    assert.equal(record.images.length, 3);
    assert.equal(record.selectedId, record.images[0].id);
    assert.equal(h.document.querySelectorAll('.t-illustration-candidate').length, 3);
    action('close').click();
});

test('streaming preview frames are shown but are not mistaken for a saved image', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    let emit = null;
    h.window.CosmosVision.generateImage = options => {
        h.state.generateCalls.push(options);
        emit = options.onStreamPreview;
        return new Promise(resolve => { h.state.release = () => resolve({ requestId: options.requestId, imageBlobs: [png], prompts: options.prompts }); });
    };
    const target = data.createIllustrationTarget({ content: story, generationId: 'g-preview' });
    ui.openIllustrationWindow(target);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    const preview = () => h.document.querySelector('[data-role="preview"]');
    await waitFor(() => !action('prepare').disabled);
    action('prepare').click();
    await waitFor(() => !action('generate').disabled);
    action('generate').click();
    await waitFor(() => emit, 'generation started');
    emit({ previewBlob: png, isFinal: false });
    await waitFor(() => !preview().hidden, 'preview shown');
    // 过程图只是预览：不能因此把「重试保存」放出来。
    assert.equal(action('save').hidden, true);
    h.state.release();
    await waitFor(() => h.state.settings.illustration_index?.[target.sceneId], 'saved');
    await waitFor(() => preview().hidden, 'preview cleared');
    action('close').click();
});

/* ---------- 外部生图后端注册表与柏宝绘 ---------- */

/** 同一份内容，只把后端换成柏宝绘 —— 提示词本身是后端无关的。 */
const baibaiDraft = () => ({ ...draft(), backend: 'baibai' });

test('the accepted backend ids and the registry stay in sync', async t => {
    const h = harness(); t.after(h.close);
    const data = await h.load('src/core/illustrationData.js');
    const registry = await h.load('src/core/illustrationBackends/registry.js');
    // illustrationData 的白名单是**读路径**的校验，registry 是分派表。只加一边 =
    // 草稿「选得出、存得下、读不回」，而且整条场景记录会跟着失效，所以两边必须一致。
    assert.deepEqual([...registry.listIllustrationBackendIds()].sort(), [...data.ILLUSTRATION_BACKEND_IDS].sort());
    // 认得出的 id 能过校验，认不出的仍然拦下。
    assert.equal(data.normalizeIllustrationDraft(baibaiDraft()).backend, 'baibai');
    assert.throws(() => data.normalizeIllustrationDraft({ ...draft(), backend: 'nope' }), /生图后端不受支持/);
});

test('baibai readiness follows its api version and backend status, and drives capabilities', async t => {
    const h = harness(); t.after(h.close);
    const bridge = await h.load('src/core/cosmosVisionBridge.js');

    delete h.window.STBaiBaiImage;
    assert.equal(bridge.detectIllustrationBackend('baibai').status, 'missing');

    // apiVersion 是它**公开数据结构**的版本，与插件版本分开；不是 1 就不认。
    h.window.STBaiBaiImage = { apiVersion: 2, getBackendStatus: () => ({}), generate: () => { } };
    const legacy = bridge.detectIllustrationBackend('baibai');
    assert.equal(legacy.status, 'legacy');
    assert.equal(legacy.ready, false);
    assert.match(legacy.reason, /2/);

    // 还没配好后端：reason 是它给的人话，直接拿来展示。
    h.installBaibai();
    h.state.baibaiStatus = { backend: 'nai', configured: false, model: '', supportsCharacters: true, reason: '还没有填写 NovelAI 的密钥' };
    const unconfigured = bridge.detectIllustrationBackend('baibai');
    assert.equal(unconfigured.status, 'not_configured');
    assert.equal(unconfigured.ready, false);
    assert.equal(unconfigured.reason, '还没有填写 NovelAI 的密钥');

    h.state.baibaiStatus = { backend: 'nai', configured: true, model: 'nai-diffusion-4-5-full', supportsCharacters: true, reason: '' };
    const ready = bridge.detectIllustrationBackend('baibai');
    assert.equal(ready.ready, true);
    assert.equal(ready.capabilities.characterPrompts, true);
    // 位置由它自己固定在画面中心，调用方改不了；characters 也没有逐角色负向词。
    assert.equal(ready.capabilities.characterPositions, false);
    assert.equal(ready.capabilities.characterNegative, false);
    // NAI 下 negative 会被忽略 —— 界面据此提示用户「这里填的不会生效」。
    assert.equal(ready.capabilities.negativePrompt, false);
    assert.equal(ready.capabilities.size, true);
    // 一次一张，没有 count 参数。
    assert.equal(ready.capabilities.batch, false);
    assert.match(ready.reason, /NovelAI/);

    // ComfyUI 下 negative 才有效，但人物提示词恒不支持（supportsCharacters 只看模型）。
    h.state.baibaiStatus = { backend: 'comfyui', configured: true, model: '默认工作流', supportsCharacters: false, reason: '' };
    const comfy = bridge.detectIllustrationBackend('baibai');
    assert.equal(comfy.capabilities.negativePrompt, true);
    assert.equal(comfy.capabilities.characterPrompts, false);
});

test('a dataUrl from baibai joins the shared blob pipeline, and its own gallery is never written to', async t => {
    const h = harness(); t.after(h.close);
    const bridge = await h.load('src/core/cosmosVisionBridge.js');
    const controller = new AbortController();
    const result = await bridge.generateTheaterIllustration(baibaiDraft(), { size: 'landscape', signal: controller.signal });

    // 回的是 dataUrl，解码后照样走同一条嗅探 + 校验路径（类型靠嗅探补齐，尺寸靠头部解析）。
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].blob.type, 'image/png');
    assert.deepEqual([result.images[0].width, result.images[0].height], [1, 1]);
    // 它报回来的实际种子要透传出去，才能照原样复现这一张。
    assert.equal(result.seed, 12345);

    const { request, options } = h.state.baibaiCalls[0];
    assert.equal(request.prompt, draft().prompts.positivePrompt);
    // NAI 下它自己会忽略 negative，但仍然照发 —— 切到 ComfyUI 时就有效。
    assert.equal(request.negative, draft().prompts.negativePrompt);
    // ⚠ 它的默认是 true，会把图也存进自己的图库；本插件的收藏、备份与图文导出
    //   都依赖自己的 /user/files 存储，必须显式关掉。
    assert.equal(request.save, false);
    assert.equal(request.size, 'landscape');
    // name 必须非空（它会把空名字的项直接丢掉），但只作标识、不进提示词。
    assert.equal(request.characters[0].name, '角色1');
    assert.equal(request.characters[0].tag, 'black hair');
    assert.equal(options.signal, controller.signal);

    // 没填分人物提示词时压根不发这个字段，别塞一个空数组过去。
    const bare = baibaiDraft();
    bare.prompts.characterPrompts = [{ positivePrompt: '', negativePrompt: '', position: { x: 0.5, y: 0.5 } }];
    await bridge.generateTheaterIllustration(bare);
    assert.equal('characters' in h.state.baibaiCalls[1].request, false);

    // 不是图片的 data URL 要被挡下，别把错误页当配图存下去。
    h.state.baibaiDataUrl = `data:image/png;base64,${Buffer.from('<html>oops</html>').toString('base64')}`;
    await assert.rejects(bridge.generateTheaterIllustration(baibaiDraft()), /不是可识别的图片/);
});

test('baibai errors are mapped by code alone, never by message text', async t => {
    const h = harness(); t.after(h.close);
    const bridge = await h.load('src/core/cosmosVisionBridge.js');
    for (const [code, expected] of [['rate_limited', 'RATE_LIMITED'], ['not_configured', 'NOT_READY'], ['invalid_args', 'INVALID_ARGS'], ['backend_error', 'GENERATION_FAILED']]) {
        h.state.baibaiError = { code, message: `供应方原文 ${code}` };
        await assert.rejects(bridge.generateTheaterIllustration(baibaiDraft()), error => error.code === expected);
    }
    // ⚠ 反向验证：文案写着「额度不足」，但 code 是 backend_error ——
    //   必须按 code 走。它的文档明说文案是中文、会随版本改，匹配文案必然误判。
    h.state.baibaiError = { code: 'backend_error', message: '额度不足' };
    await assert.rejects(
        bridge.generateTheaterIllustration(baibaiDraft()),
        error => error.code === 'GENERATION_FAILED' && /额度不足/.test(error.message),
    );
    // 原文照留，用户才有排查线索。
    h.state.baibaiError = { code: 'invalid_args', message: 'bad size' };
    await assert.rejects(
        bridge.generateTheaterIllustration(baibaiDraft()),
        error => error.code === 'INVALID_ARGS' && /bad size/.test(error.message),
    );
});

test('dispatch follows the draft own backend, not the current setting', async t => {
    const h = harness(); t.after(h.close);
    const bridge = await h.load('src/core/cosmosVisionBridge.js');

    // 设置里选的是柏宝绘，但草稿记的是 cosmos —— 必须走 cosmos（草稿说了算）。
    h.state.settings.illustration_backend = { version: 1, active_id: 'baibai' };
    await bridge.generateTheaterIllustration(draft());
    assert.equal(h.state.generateCalls.length, 1);
    assert.equal(h.state.baibaiCalls.length, 0);

    // 反向：设置是 cosmos，草稿记 baibai —— 走柏宝绘。
    h.state.settings.illustration_backend = { version: 1, active_id: 'cosmos' };
    await bridge.generateTheaterIllustration(baibaiDraft());
    assert.equal(h.state.generateCalls.length, 1);
    assert.equal(h.state.baibaiCalls.length, 1);
});

test('scene selection stamps whichever backend the settings currently pick', async t => {
    const h = harness(); t.after(h.close);
    const scene = await h.load('src/core/illustrationScene.js');

    h.state.settings.illustration_backend = { version: 1, active_id: 'baibai' };
    assert.equal((await scene.selectIllustrationScene({ theaterText: story })).backend, 'baibai');

    // 老用户没有这个键（或它认不出来）时回落默认后端，而不是抛错。
    h.state.settings.illustration_backend = { version: 1, active_id: 'removed-backend' };
    assert.equal((await scene.selectIllustrationScene({ theaterText: story })).backend, 'cosmos');
});

test('the seed reported by the backend is stored with the image, and omitted when absent', async t => {
    const h = harness(); t.after(h.close);
    const store = await h.load('src/core/illustrationStore.js');

    const saved = await store.saveGeneratedIllustrations('scene-seed', {
        draft: baibaiDraft(), seed: 987654, createdAt: Date.now(),
        images: [{ blob: png, width: 1, height: 1 }],
    });
    assert.equal(saved.images[0].seed, 987654);
    // 从记录文件读回来也要还在。
    assert.equal((await store.readSceneIllustrations('scene-seed')).images[0].seed, 987654);

    // 后端不报种子时不留空字段（Cosmos 就是这种）。
    const none = await store.saveGeneratedIllustrations('scene-noseed', {
        draft: draft(), createdAt: Date.now(), images: [{ blob: png, width: 1, height: 1 }],
    });
    assert.equal('seed' in none.images[0], false);
});

test('the panel hides what the active backend cannot honor, and restores it after a switch', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    h.state.settings.illustration_backend = { version: 1, active_id: 'baibai' };
    ui.openIllustrationWindow(data.createIllustrationTarget({ content: story, generationId: 'g-caps' }));
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    const node = name => h.document.querySelector(`[data-role="${name}"]`);
    await waitFor(() => !action('prepare').disabled);
    action('prepare').click();
    await waitFor(() => !action('generate').disabled);

    // 柏宝绘 + NAI：位置用不上，负面词不生效，画幅可以选。
    assert.equal(h.document.querySelector('.t-illustration-coordinates').hidden, true);
    assert.equal(node('negative-hint').hidden, false);
    assert.equal(node('size-field').hidden, false);
    assert.match(node('characters-hint').textContent, /画面中心/);

    // 切回 cosmos 再检测：位置编辑器回来，负面词提示消失。位置值本身没被删掉。
    h.state.settings.illustration_backend = { version: 1, active_id: 'cosmos' };
    action('detect').click();
    await waitFor(() => h.document.querySelector('.t-illustration-coordinates').hidden === false, 'positions restored');
    assert.equal(node('negative-hint').hidden, true);
    assert.equal(node('characters-hint').hidden, true);

    // 智绘姬：位置、分人物、画幅三样都收起来（它的请求里只有一个 prompt 字段）。
    h.state.extensionSettings['st-chatu8'] = chatu8Settings({ mode: 'sd' });
    h.state.settings.illustration_backend = { version: 1, active_id: 'chatu8' };
    action('detect').click();
    await waitFor(() => node('size-field').hidden === true, 'chatu8 capabilities applied');
    assert.equal(h.document.querySelector('.t-illustration-coordinates').hidden, true);
    assert.equal(node('characters').hidden, true);
    assert.equal(node('negative-hint').hidden, true, 'sd 渠道收这个字段');

    // 换成 banana：它那条处理器不读 negative_prompt，提示要出现（且不能点名别的后端）。
    h.state.extensionSettings['st-chatu8'] = chatu8Settings({ mode: 'banana' });
    action('detect').click();
    await waitFor(() => node('negative-hint').hidden === false, 'banana drops the negative prompt');
    assert.match(node('negative-hint').textContent, /不使用这里填写的负向提示词/);
    action('close').click();
});

test('a backend that drops the character prompts says so instead of letting the user guess', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    h.state.settings.illustration_backend = { version: 1, active_id: 'baibai' };
    // ComfyUI：它会把 characters 静默丢掉，并用 charactersApplied 如实回报。
    h.state.baibaiStatus = { backend: 'comfyui', configured: true, model: '默认工作流', supportsCharacters: false, reason: '' };
    h.state.baibaiCharactersApplied = false;
    const target = data.createIllustrationTarget({ content: story, generationId: 'g-applied' });
    ui.openIllustrationWindow(target);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    await waitFor(() => !action('prepare').disabled);
    action('prepare').click();
    await waitFor(() => !action('generate').disabled);
    // 不支持分人物提示词时整块收起。
    assert.equal(h.document.querySelector('[data-role="characters"]').hidden, true);
    action('generate').click();
    await waitFor(() => h.state.settings.illustration_index?.[target.sceneId], 'saved');
    await waitFor(() => /未使用分人物提示词/.test(h.document.querySelector('[data-role="status"]').textContent), 'notice shown');
    action('close').click();
});

test('the settings window switches the active backend and persists it immediately', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationSettingsWindow.js');
    ui.openIllustrationSettingsWindow();
    const select = h.document.querySelector('[data-role="backend-select"]');
    assert.deepEqual([...select.options].map(option => option.value), ['cosmos', 'baibai', 'chatu8']);
    assert.equal(select.value, 'cosmos', '没设过时默认选 cosmos');

    select.value = 'baibai';
    select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    assert.equal(h.state.settings.illustration_backend.active_id, 'baibai');
    // 状态行显示的是**选中那个后端**的就绪情况，切过去立刻知道能不能用。
    assert.match(h.document.querySelector('[data-role="backend-validation"]').textContent, /柏宝绘/);

    // 没装的要如实报「未检测到」，而不是默不作声。
    delete h.window.STBaiBaiImage;
    select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    assert.match(h.document.querySelector('[data-role="backend-validation"]').textContent, /未检测到柏宝绘/);
    h.document.querySelector('[data-action="close"]').click();
});

test('a backend that is gone still lets old records be read, adopted and exported', async t => {
    const h = harness(); t.after(h.close);
    const store = await h.load('src/core/illustrationStore.js');
    const portability = await h.load('src/core/illustrationPortability.js');
    const saved = await store.saveGeneratedIllustrations('scene-gone', {
        draft: baibaiDraft(), seed: 1, createdAt: Date.now(), images: [{ blob: png, width: 1, height: 1 }],
    });
    // 卸载柏宝绘之后：记录照读、采用照常、备份照出 —— 探测只在**出图**时发生。
    delete h.window.STBaiBaiImage;
    const record = await store.readSceneIllustrations('scene-gone');
    assert.equal(record.images[0].id, saved.images[0].id);
    assert.equal(store.selectedIllustration(record).id, saved.images[0].id);
    const bundle = await portability.exportIllustrationBackup([]);
    assert.equal(Object.keys(bundle.assets).length, 1);
});

/* ---------- 顶栏问号：静态说明收在一处 ---------- */

test('the panel keeps its static explanations behind one help button, not scattered in the body', async t => {
    const h = harness(); t.after(h.close);
    const data = await h.load('src/core/illustrationData.js');
    const panel = await h.load('src/ui/illustrationWindow.js');
    panel.openIllustrationWindow(data.createIllustrationTarget({ content: story, generationId: 'g-help' }));
    await waitFor(() => !h.document.querySelector('[data-action="prepare"]').disabled);

    const help = h.document.querySelector('.t-help');
    const button = help.querySelector('button');
    const popover = help.querySelector('.t-help-popover');
    const body = () => h.document.querySelector('.t-illustration-body');
    assert.equal(popover.hidden, true);
    assert.equal(button.getAttribute('aria-expanded'), 'false');

    button.click();
    assert.equal(popover.hidden, false);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    // 说明确实收进来了。
    assert.match(popover.textContent, /LoRA 触发词/);
    // 面板正文里不再散落着那条静态解释（气泡在顶栏，不属于正文）。
    assert.equal(/LoRA 触发词/.test(body().textContent), false, '静态说明不应还留在正文里');

    // 点别处收起：不占着界面。
    body().click();
    assert.equal(popover.hidden, true);
    // Esc 也收得掉。
    button.click();
    assert.equal(popover.hidden, false);
    h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(popover.hidden, true);
    h.document.querySelector('[data-action="close"]').click();
});

test('the settings and profile windows carry the same help affordance', async t => {
    const h = harness(); t.after(h.close);
    const settings = await h.load('src/ui/illustrationSettingsWindow.js');
    settings.openIllustrationSettingsWindow();
    const popover = h.document.querySelector('.t-illustration-settings-window .t-help-popover');
    assert.ok(popover, '设置窗顶栏应有问号');
    // 占位符与后端说明都由各自的清单驱动生成，加一个就自动出现在这里。
    assert.match(popover.textContent, /\{\{theater_text\}\}/);
    assert.match(popover.textContent, /柏宝绘/);
    // 而它是**关着**的：说明不该一进来就占着界面。
    assert.equal(popover.hidden, true);
    // 条件性的就绪状态仍然留在原位，没有被一起收走。
    assert.ok(h.document.querySelector('[data-role="backend-validation"]'));
    h.document.querySelector('.t-illustration-settings-window [data-action="close"]').click();

    const profiles = await h.load('src/ui/characterProfileWindow.js');
    profiles.openCharacterProfileWindow();
    assert.ok(h.document.querySelector('.t-profile-window .t-help-popover'), '档案窗顶栏应有问号');
    h.document.querySelector('.t-profile-window [data-action="close"]').click();
});

/* ---------- 顶栏按钮的样式归属 ---------- */

test('all three illustration headers use borderless icon buttons', async t => {
    // 顶栏那一簇（档案 / 设置 / 问号 / 关闭）一律 .t-icon-btn：无边框方形热区，
    // 间距由父级 gap 负责。谁要是在顶栏里写回 .t-btn，会立刻多出四个带框方块 ——
    // jsdom 看不见样式，只能这样钉住类名。
    const h = harness(); t.after(h.close);
    const data = await h.load('src/core/illustrationData.js');
    const panel = await h.load('src/ui/illustrationWindow.js');
    const settings = await h.load('src/ui/illustrationSettingsWindow.js');
    const profiles = await h.load('src/ui/characterProfileWindow.js');
    // 问号在 .t-help 里包了一层，仍是这一簇的按钮，按文档顺序一起数进来。
    const headerButtons = selector => [...h.document.querySelectorAll(`${selector} .t-panel-header-actions button`)];

    panel.openIllustrationWindow(data.createIllustrationTarget({ content: story, generationId: 'g-header' }));
    assert.deepEqual(headerButtons('.t-illustration-window').map(button => button.className),
        ['t-icon-btn', 't-icon-btn', 't-icon-btn', 't-icon-btn'],
        '配图面板顶栏：档案 → 设置 → 问号 → 关闭');
    h.document.querySelector('.t-illustration-window [data-action="close"]').click();

    settings.openIllustrationSettingsWindow();
    assert.deepEqual(headerButtons('.t-illustration-settings-window').map(button => button.className),
        ['t-icon-btn', 't-icon-btn'], '设置窗顶栏：问号 → 关闭');
    h.document.querySelector('.t-illustration-settings-window [data-action="close"]').click();

    profiles.openCharacterProfileWindow();
    assert.deepEqual(headerButtons('.t-profile-window').map(button => button.className),
        ['t-icon-btn', 't-icon-btn'], '档案窗顶栏：问号 → 关闭');
    h.document.querySelector('.t-profile-window [data-action="close"]').click();
});

/* ---------- 自动配图（单次演绎后） ---------- */

/** 自动配图的一次调用的标准入参。用例按需覆盖。 */
const autoArgs = (overrides = {}) => ({
    source: 'manual', generationId: 'g-auto', scriptId: 's-auto', scriptName: '自动配图剧本',
    content: story, ...overrides,
});
/** 与 illustrationAuto.js 用同一套输入算出的 sceneId（两边必须对得上，否则图存了但面板看不到）。 */
const autoSceneId = (data, overrides = {}) => data.createIllustrationTarget(autoArgs(overrides)).sceneId;

test('the auto-illustration gate rejects everything but a fresh manual round', async t => {
    const h = harness(); t.after(h.close);
    const auto = await h.load('src/core/illustrationAuto.js');
    const base = { enabled: true, content: story, hasImages: false, busy: false };

    assert.equal(auto.shouldAutoIllustrate({ ...base, source: 'manual' }).ok, true);
    // 开关是总闸：默认关，关着时连理由都不给（绝大多数用户走这条路径）。
    // ⚠ 逐字段断言而不是 deepEqual：夹具跑在 vm 里，跨 realm 的对象原型不同，
    //   node:assert/strict 的 deepEqual 会判「结构相同但不是同一个引用」。
    const off = auto.shouldAutoIllustrate({ ...base, enabled: false, source: 'manual' });
    assert.equal(off.ok, false);
    assert.equal(off.silent, true);
    // 续写 / 队列 / 自动演绎（同为 queue）/ 预览都不是「新一轮」。
    for (const source of ['user_continuation', 'queue', 'preview', '']) {
        assert.equal(auto.shouldAutoIllustrate({ ...base, source }).ok, false, `${source} 不该自动配图`);
    }
    // 正文空、这一轮已经有图 —— 静默跳过，不必打扰。
    for (const patch of [{ content: '  ' }, { hasImages: true }]) {
        const skipped = auto.shouldAutoIllustrate({ ...base, source: 'manual', ...patch });
        assert.equal(skipped.ok, false);
        assert.equal(skipped.silent, true);
    }
    // 上一张还在跑：跳过，但要说一声（否则用户会以为功能坏了）。
    const busy = auto.shouldAutoIllustrate({ ...base, source: 'manual', busy: true });
    assert.equal(busy.ok, false);
    assert.match(busy.reason, /还在生成/);

    // 默认关闭，且刻意没有 ensure：老用户缺这个键时读端一律按未勾处理。
    const defaults = await h.load('src/config/defaults.js');
    assert.equal(defaults.defaultSettings.illustration_auto.enabled, false);
});

test('auto-illustration refuses to spend a cent when the backend or the preset is unusable', async t => {
    const h = harness(); t.after(h.close);
    const auto = await h.load('src/core/illustrationAuto.js');
    h.state.settings.illustration_auto = { enabled: true };

    // 生图后端没装：连选景的 LLM 都不该发出去。
    delete h.window.CosmosVision;
    auto.maybeAutoIllustrate(autoArgs());
    await waitFor(() => h.state.toasts.length > 0, 'backend warning');
    assert.match(h.state.toasts[0][1], /未检测到 Cosmos Vision/);
    assert.equal(h.state.llmCalls.length, 0, '后端没就绪时不该发起选景调用');

    // 后端恢复了，但没有选景预设：同样零调用，并说清去处。
    h.state.toasts.length = 0;
    h.window.CosmosVision = {
        version: '1.3.0',
        generateImage: async options => ({ requestId: options.requestId, imageBlobs: [png], prompts: options.prompts }),
    };
    h.state.settings = { illustration_auto: { enabled: true } };
    auto.maybeAutoIllustrate(autoArgs());
    await waitFor(() => h.state.toasts.length > 0, 'preset warning');
    assert.match(h.state.toasts[0][1], /还没有选景预设/);
    assert.equal(h.state.llmCalls.length, 0, '没有预设时不该发起选景调用');
});

test('an enabled manual round selects, generates and saves on its own, then says so once', async t => {
    const h = harness(); t.after(h.close);
    const auto = await h.load('src/core/illustrationAuto.js');
    const data = await h.load('src/core/illustrationData.js');
    h.state.settings.illustration_auto = { enabled: true };

    auto.maybeAutoIllustrate(autoArgs());
    const sceneId = autoSceneId(data);
    await waitFor(() => h.state.settings.illustration_index?.[sceneId], 'saved without the panel');
    assert.equal(h.state.generateCalls.length, 1);
    assert.equal(h.state.uploads, 1, '图片应已上传到用户文件');
    // 只有一条提示，且是完成那条 —— 自动配图不弹灯箱、不加回内容区元素。
    assert.equal(h.state.toasts.length, 1);
    assert.equal(h.state.toasts[0][0], 'info');
    assert.match(h.state.toasts[0][1], /自动配图完成/);
    assert.equal(h.document.querySelector('.t-illustration-lightbox'), null);
    assert.equal(h.document.querySelector('.t-illustration-badge'), null);

    // 同一轮再触发一次：已经有图，静默跳过，不再花钱。
    auto.maybeAutoIllustrate(autoArgs());
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(h.state.generateCalls.length, 1, '同一轮不该配两次');
    assert.equal(h.state.toasts.length, 1, '跳过不该有提示');
});

test('a hanging auto job blocks the next one instead of paying twice', async t => {
    const h = harness(); t.after(h.close);
    const auto = await h.load('src/core/illustrationAuto.js');
    h.state.settings.illustration_auto = { enabled: true };
    // 第一次选景挂住不返回，模拟「还在通读正文」。
    h.state.llmHandler = () => new Promise(() => { });

    auto.maybeAutoIllustrate(autoArgs({ generationId: 'g-auto-1' }));
    await waitFor(() => h.state.llmCalls.length === 1, 'first job started');
    // 第二个是不同的 sceneId（连点两次单次演绎），按场景去重拦不住它 —— 只有单槽位能拦。
    auto.maybeAutoIllustrate(autoArgs({ generationId: 'g-auto-2' }));
    await waitFor(() => h.state.toasts.length > 0, 'skip notice');
    assert.match(h.state.toasts[0][1], /还在生成/);
    assert.equal(h.state.llmCalls.length, 1, '第二个任务不该再发一次选景调用');
});

test('auto-illustration carries the matched appearance profile, like the manual path does', async t => {
    const h = harness(); t.after(h.close);
    const auto = await h.load('src/core/illustrationAuto.js');
    h.state.settings.illustration_auto = { enabled: true };
    h.state.settings.character_profiles = {
        version: 2,
        entries: [{ id: 'p1', name: '阿离', kind: 'character', keywords: ['阿离'], content: '银发红瞳', cardKey: 'card:ali', enabled: true }],
    };
    h.state.cardKey = 'card:ali';

    auto.maybeAutoIllustrate(autoArgs({ generationId: 'g-auto-profile' }));
    await waitFor(() => h.state.llmCalls.length > 0, 'selection sent');
    const userContent = h.state.llmCalls[0].messages.find(message => message.role === 'user').content;
    assert.match(userContent, /【阿离】/, '命中的外观档案应自动带进人物资料');
    assert.match(userContent, /银发红瞳/);
});

test('a running auto job is mirrored into the panel, and can be cancelled there', async t => {
    const h = harness(); t.after(h.close);
    const auto = await h.load('src/core/illustrationAuto.js');
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    h.state.settings.illustration_auto = { enabled: true };
    h.state.llmHandler = () => new Promise(() => { });   // 挂在选景上

    auto.maybeAutoIllustrate(autoArgs({ generationId: 'g-auto-panel' }));
    await waitFor(() => h.state.llmCalls.length === 1, 'auto job started');

    // 面板打开的是同一轮 —— 它必须接管这个任务，否则用户看着空图库点「分析画面」就是付两次钱。
    const target = data.createIllustrationTarget(autoArgs({ generationId: 'g-auto-panel' }));
    ui.openIllustrationWindow(target);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    await waitFor(() => !action('cancel').hidden, 'auto job mirrored in');
    assert.match(h.document.querySelector('[data-role="status"]').textContent, /自动配图/);
    assert.equal(action('generate').disabled, true, '自动任务跑着时不该还能手动发起');
    assert.equal(action('prepare').disabled, true);

    action('cancel').click();
    await waitFor(() => action('cancel').hidden, 'cancelled');
    assert.equal(h.state.toasts.some(([kind, message]) => kind === 'info' && /自动配图已取消/.test(message)), true);
    // 取消后面板回到空闲：能重新点「分析画面」、输入框解禁。
    //（「生成图片」这会儿仍然禁用是对的 —— 这一轮还没有草稿。）
    assert.equal(action('prepare').disabled, false, '取消后应当能手动发起');
    assert.equal(h.document.querySelector('[data-field="text"]').disabled, false);
    action('close').click();
});

test('the auto-illustration hook sits on the success path of a real generation', async () => {
    // 夹具不加载 api.js（它拽着整条生成链路），所以这里用源码断言钉住接入点：
    // 必须在 pushSceneToHistory 成功之后，才能保证只认「成功的新一轮」。
    const api = stripped('src/core/api.js');
    const hook = api.indexOf('maybeAutoIllustrate(');
    assert.ok(hook > 0, 'api.js 的成功路径必须调用自动配图');
    assert.ok(hook > api.indexOf('pushSceneToHistory(finalOutput'), '接入点应在 pushSceneToHistory 之后');
    assert.ok(api.includes('import { maybeAutoIllustrate }'), '缺少 import');
});

test('the panel still opens when this round has nothing to illustrate yet', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');

    // 占位目标：稳定、与真实轮次不同 id、带着「为什么没得配」。
    const pending = data.createPendingIllustrationTarget({ scriptId: 's1', scriptName: '雨夜', reason: '这一轮还在生成中。' });
    const again = data.createPendingIllustrationTarget({ scriptId: 's1', scriptName: '雨夜', reason: '这一轮还在生成中。' });
    assert.equal(pending.sceneId, again.sceneId, '同一个剧本的占位目标应当稳定');
    assert.equal(pending.content, '');
    assert.equal(pending.unavailable, '这一轮还在生成中。');
    // 与真实轮次绝不会撞：真实轮次的散列输入里正文一定非空。
    assert.notEqual(pending.sceneId, data.createIllustrationTarget({ content: story, generationId: 'g-x', scriptId: 's1' }).sceneId);
    // 主界面取目标时必须走这条兜底（mainWindow.js 不在夹具里，只能源码断言）。
    const mainWindow = stripped('src/ui/mainWindow.js');
    assert.ok(/createPendingIllustrationTarget/.test(mainWindow), '取不到可用正文时要给占位目标，而不是抛错');

    // 面板照开：状态行说明原因，三个主操作都不可用，顶栏按钮照常。
    ui.openIllustrationWindow(pending);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    const status = () => h.document.querySelector('[data-role="status"]').textContent;
    await waitFor(() => h.document.querySelector('.t-illustration-window'), 'panel opened');
    assert.equal(h.document.querySelector('[data-field="text"]').value, '', '没有正文可带');
    assert.match(status(), /这一轮还在生成中/);
    for (const name of ['prepare', 'alternate', 'generate']) {
        assert.equal(action(name).disabled, true, `${name} 在没正文时不该可点`);
    }
    assert.equal(h.document.querySelector('.t-illustration-candidate'), null, '图库应当是空的');
    assert.equal(action('settings').disabled, false, '顶栏入口不受影响');
    assert.equal(action('profiles').disabled, false);
    action('close').click();
});

/* ---------- 智绘姬（st-chatu8）：借酒馆的事件总线出图 ---------- */

/** 它的状态全在 extension_settings["st-chatu8"] 里。用例在这里扮「已装好」的它。 */
const chatu8Settings = (overrides = {}) => ({ scriptEnabled: "true", mode: "sd", ...overrides });

/**
 * 扮 chatu8 那一侧：接到 generate-image-request 就回一条响应。
 * 返回收到的请求数组，方便断言我们发出去的是什么。
 */
function fakeChatu8(h, respond) {
    const seen = [];
    h.bus.on('generate-image-request', request => {
        seen.push(request);
        respond(request, h.bus);
    });
    return seen;
}

test('the chatu8 backend reads its state from the tavern settings, and reports honest capabilities', async t => {
    const h = harness(); t.after(h.close);
    const { chatu8Backend } = await h.load('src/core/illustrationBackends/chatu8.js');

    // 没装：只有一条能照着做的提示。
    assert.equal(chatu8Backend.probe().status, 'missing');
    assert.match(chatu8Backend.probe().reason, /未检测到智绘姬/);

    // 装了但没启用 —— 与「没装」分开报，用户知道去开哪个开关。
    h.state.extensionSettings['st-chatu8'] = chatu8Settings({ scriptEnabled: 'false' });
    assert.equal(chatu8Backend.probe().status, 'not_configured');
    assert.match(chatu8Backend.probe().reason, /没有启用/);

    // 启用了但渠道不能出图：这是它那边最常见的漏配，所以要说清去哪儿改。
    h.state.extensionSettings['st-chatu8'] = chatu8Settings({ mode: '' });
    assert.match(chatu8Backend.probe().reason, /还没有选渠道/);
    h.state.extensionSettings['st-chatu8'] = chatu8Settings({ mode: 'none' });
    assert.match(chatu8Backend.probe().reason, /「none」不能用来出图/);
    assert.equal(chatu8Backend.probe().status, 'not_configured');

    // 就绪：能力如实上报 —— 一次一张、没有分人物与位置、画幅由它自己决定。
    h.state.extensionSettings['st-chatu8'] = chatu8Settings({ mode: 'sd' });
    const ready = chatu8Backend.probe();
    assert.equal(ready.ready, true);
    assert.match(ready.reason, /Stable Diffusion/);
    // ⚠ 逐字段断言而不是 deepEqual：夹具跑在 vm 里，跨 realm 的对象原型不同，
    //   node:assert/strict 的 deepEqual 会判「结构相同但不是同一个引用」。
    const capabilities = chatu8Backend.probe().capabilities;
    assert.equal(capabilities.characterPrompts, false);
    assert.equal(capabilities.characterPositions, false);
    assert.equal(capabilities.characterNegative, false);
    assert.equal(capabilities.negativePrompt, true);
    assert.equal(capabilities.size, false, '画幅由它自己渠道里配的宽高决定，不从这里指定');
    assert.equal(capabilities.batch, false, '一个响应一张图');
    assert.equal(capabilities.streamPreview, false);
    // banana 那条处理器不读 negative_prompt，所以那里要把负向框收起来。
    h.state.extensionSettings['st-chatu8'] = chatu8Settings({ mode: 'banana' });
    assert.equal(chatu8Backend.probe().capabilities.negativePrompt, false);
});

test('a chatu8 request goes out on the tavern event bus and comes back as a saved picture', async t => {
    const h = harness(); t.after(h.close);
    const bridge = await h.load('src/core/cosmosVisionBridge.js');
    h.state.extensionSettings['st-chatu8'] = chatu8Settings({ mode: 'sd' });
    const seen = fakeChatu8(h, (request, bus) => {
        // 它就是这样回的：同一根总线、同一个 id、dataURL。
        bus.emit('generate-image-response', { id: request.id, success: true, imageData: pngDataUrl, prompt: request.prompt });
    });

    const result = await bridge.generateTheaterIllustration({ ...draft(), backend: 'chatu8' });
    assert.equal(seen.length, 1, '应当正好发出一条请求');
    assert.equal(seen[0].prompt, draft().prompts.positivePrompt);
    // 文档给的形状就是 null = 用它自己渠道里配的尺寸。
    assert.deepEqual([seen[0].width, seen[0].height], [null, null]);
    assert.ok(seen[0].id, 'id 必须带（响应靠它认领）');
    // 回的是 dataURL，解码后照样走同一条嗅探 + 校验路径。
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].blob.type, 'image/png');
    assert.deepEqual([result.images[0].width, result.images[0].height], [1, 1]);
    assert.equal(h.bus.listenerCount('generate-image-response'), 0, '拿到结果后要退订');
});

test('a chatu8 response for somebody else is ignored, and aborting stops waiting', async t => {
    const h = harness(); t.after(h.close);
    const bridge = await h.load('src/core/cosmosVisionBridge.js');
    h.state.extensionSettings['st-chatu8'] = chatu8Settings();

    // 先发一条别人的响应（前端卡、它的自动点击都可能同时在等），必须被忽略。
    // 刻意让它是一条**失败**：不按 id 过滤的实现会当场被它带崩，这样断言才咬得住。
    h.bus.on('generate-image-request', request => {
        h.bus.emit('generate-image-response', { id: 'someone-else', success: false, error: '别人的失败' });
        h.bus.emit('generate-image-response', { id: request.id, success: true, imageData: pngDataUrl, prompt: request.prompt });
    });
    const result = await bridge.generateTheaterIllustration({ ...draft(), backend: 'chatu8' });
    assert.equal(result.images.length, 1, '别人的那条不该认领，自己那条照样收得到');

    // 取消：它没有取消接口，所以只要求「本地不再等」，并把监听退掉。
    // 先让它别回话（模拟它那边还在算），否则这里根本等不到「挂着监听」的时刻。
    h.bus.clear('generate-image-request');
    const controller = new AbortController();
    const pending = bridge.generateTheaterIllustration({ ...draft(), backend: 'chatu8' }, { signal: controller.signal });
    await waitFor(() => h.bus.listenerCount('generate-image-response') === 1, 'listener attached while waiting');
    controller.abort();
    await assert.rejects(pending, error => error?.name === 'AbortError' || error?.code === 'ABORTED');
    assert.equal(h.bus.listenerCount('generate-image-response'), 0, '取消后必须退订');

    // 发出去没人接：不能无限等下去，要给一句能照着查的错。
    const { chatu8Backend } = await h.load('src/core/illustrationBackends/chatu8.js');
    await assert.rejects(
        chatu8Backend.generate(draft(), { timeoutMs: 20 }),
        error => error?.code === 'NOT_READY' && /没有回应/.test(error.message),
    );
    assert.equal(h.bus.listenerCount('generate-image-response'), 0, '超时也要退订');
});

test('chatu8 failures and stray video come back as plugin errors, never as a broken picture', async t => {
    const h = harness(); t.after(h.close);
    const bridge = await h.load('src/core/cosmosVisionBridge.js');
    h.state.extensionSettings['st-chatu8'] = chatu8Settings();

    // 它自己报的失败：把它的原话带上，别吞掉。
    const seen = fakeChatu8(h, (request, bus) => bus.emit('generate-image-response', {
        id: request.id, success: false, error: '额度不足', prompt: request.prompt,
    }));
    await assert.rejects(bridge.generateTheaterIllustration({ ...draft(), backend: 'chatu8' }),
        error => error?.code === 'GENERATION_FAILED' && /额度不足/.test(error.message));
    assert.equal(seen.length, 1);

    // 返回视频（我们从不发 {视频}，出现即说明它那边配置串了）：如实报错，别当图片存下去。
    h.bus.clear('generate-image-request');
    fakeChatu8(h, (request, bus) => bus.emit('generate-image-response', {
        id: request.id, success: true, imageData: pngDataUrl, isVideo: true, prompt: request.prompt,
    }));
    await assert.rejects(bridge.generateTheaterIllustration({ ...draft(), backend: 'chatu8' }),
        error => error?.code === 'GENERATION_FAILED' && /视频/.test(error.message));
});

/* ---------- 内容区不再有任何配图元素 ---------- */
test('the content area is never handed an illustration element to begin with', async () => {
    // 内容区那个按钮连同它的进行态通道一起删了：面板关着时后台任务只剩
    // 完成/失败那一条 toastr（见 illustrationWindow.js 的 notifyBackgroundResult）。
    // 这条测试防止有人「顺手」把按钮加回来。
    const windowSource = stripped('src/ui/illustrationWindow.js');
    assert.equal(/illustrationBadge|createIllustrationBadge/.test(windowSource), false,
        'illustrationWindow.js 不应再引用配图按钮');
    assert.equal(/bindMainIllustrations/.test(windowSource), false,
        '主界面那套绑定已删除，别留下一个没导出的死函数');
    assert.equal(/t-illustration-badge/.test(readFileSync(path.join(project, 'css/04-features/illustration.css'), 'utf8')), false,
        'CSS 里不该还留着配图按钮的样式');
    // 正文里唯一还产出配图标记的地方是 illustrationFigure（收藏阅读页与导出 HTML）。
    const data = stripped('src/core/illustrationData.js');
    assert.ok(/export function illustrationFigure/.test(data), 'illustrationFigure 是收藏与导出的唯一产出点，不能删');
});

test('favorites and HTML export still render the figure into the prose', async t => {
    const h = harness(); t.after(h.close);
    const data = await h.load('src/core/illustrationData.js');
    const store = await h.load('src/core/illustrationStore.js');
    const record = await store.saveGeneratedIllustration('scene-fig', { draft: draft(), image: { blob: png, width: 1, height: 1 } });
    const picture = store.selectedIllustration(record);
    // 走产品路径断言，而不是在测试里直接调 illustrationFigure ——
    // 主界面那条注入路径删掉之后，这个函数只剩收藏与导出两个消费者，删不得。
    const figure = data.illustrationFigure(picture);
    assert.match(figure, /^<figure data-titania-illustration="/);
    assert.match(figure, new RegExp(picture.filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(figure, /<figcaption/);
    // 没有图时产出空串，调用方（收藏分段 / 导出）靠它决定要不要拼这一段。
    assert.equal(data.illustrationFigure(null), '');
    assert.equal(data.illustrationFigure(undefined), '');
});

/* ---------- 配图删除与引用计数 ---------- */

/** 种一条「已搬家」的收藏，正文里带上给定的配图快照。 */
function seedFavorite(h, { id = 'f1', illustration = null } = {}) {
    const file = `/user/files/titania-fav-${id}.json`;
    const body = { v: 1, id, type: 'plain', html: '<p>收藏正文</p>' };
    if (illustration) body.illustration = illustration;
    h.state.files.set(file, new Blob([JSON.stringify(body)], { type: 'application/json' }));
    h.state.settings.favs_index = { version: 1, migratedAt: 1, entries: [{ id, type: 'plain', file, rev: 1 }] };
    return file;
}

test('the reference scanner unions scene records and favorites, and fails safe when a read breaks', async t => {
    const h = harness(); t.after(h.close);
    const store = await h.load('src/core/illustrationStore.js');
    const refs = await h.load('src/core/illustrationReferences.js');
    const B = '/user/files/titania-illustration-bbb.png';
    const C = '/user/files/titania-illustration-ccc.png';

    const record = await store.saveGeneratedIllustration('scene-ref', { draft: draft(), image: { blob: png, width: 1, height: 1 } });
    const inScene = store.selectedIllustration(record).filePath;
    seedFavorite(h, { id: 'f-1', illustration: { id: 'snap', filePath: B, draft: draft(), width: 1, height: 1, createdAt: 1 } });

    const found = await refs.findReferencedIllustrationPaths([inScene, B, C]);
    assert.deepEqual([...found.referenced].sort(), [B, inScene].sort());
    assert.deepEqual([...found.favoriteReferenced], [B], '要能区分"是收藏引用的"，确认框据此措辞');
    assert.equal(found.referenced.has(C), false);
    assert.equal(found.incomplete, false);

    // 打开面板所在的收藏要被排除：那个快照马上就要被清掉，算进去文件就永远留着成孤儿。
    const excluded = await refs.findReferencedIllustrationPaths([B], { excludeFavoriteId: 'f-1' });
    assert.equal(excluded.referenced.has(B), false);

    // 收藏正文读不出来时保守处理：证明不了"没人用"就不删字节。
    h.state.files.delete('/user/files/titania-fav-f-1.json');
    const broken = await refs.findReferencedIllustrationPaths([C]);
    assert.equal(broken.incomplete, true);
    assert.equal(broken.referenced.has(C), true, '读不全时全部按被引用处理');
});

test('deleting images repairs selectedId, keeps referenced files, and only then removes bytes', async t => {
    const h = harness(); t.after(h.close);
    const store = await h.load('src/core/illustrationStore.js');
    const record = await store.saveGeneratedIllustrations('scene-del', {
        draft: draft(), createdAt: Date.now(),
        images: [{ blob: png, width: 1, height: 1 }, { blob: png, width: 1, height: 1 }],
    });
    const [first, second] = record.images;
    assert.equal(record.selectedId, first.id, '第一张自动采用');

    const result = await store.deleteSceneIllustrations('scene-del', [first], {
        collectReferenced: async () => [first.filePath],
    });
    assert.deepEqual([...result.removedIds], [first.id]);
    assert.deepEqual([...result.keptReferenced], [first.filePath]);
    assert.deepEqual([...result.deletedFiles], []);
    assert.equal(result.record.selectedId, second.id, '采用图被删后自动接到剩余第一张');
    assert.equal(h.state.files.has(first.filePath), true, '仍被引用就不能删文件');

    const last = await store.deleteSceneIllustrations('scene-del', [second], { collectReferenced: async () => [] });
    assert.equal(last.record.selectedId, null, '一张不剩就置空');
    assert.deepEqual([...last.deletedFiles], [second.filePath]);
    assert.equal(h.state.files.has(second.filePath), false, '无人引用就该真的删掉');
    // ⚠ 这条是整件事的关键：悬空的 selectedId 会让 readSceneIllustrations 抛错，
    //   画廊、主界面按钮、导出、备份会一起坏。
    assert.equal((await store.readSceneIllustrations('scene-del')).images.length, 0, '记录仍必须可读');

    // 没注入引用查询时保守到底：只删记录，一个文件都不碰。
    const safe = await store.saveGeneratedIllustration('scene-safe', { draft: draft(), image: { blob: png, width: 1, height: 1 } });
    const picture = store.selectedIllustration(safe);
    await store.deleteSceneIllustrations('scene-safe', [{ id: picture.id, filePath: picture.filePath }]);
    assert.equal(h.state.files.has(picture.filePath), true, '未接线时宁可留孤儿也不能删文件');
});

test('rewriting a scene record reclaims the file it supersedes, but never on a failed commit', async t => {
    const h = harness(); t.after(h.close);
    const store = await h.load('src/core/illustrationStore.js');
    await store.saveGeneratedIllustration('scene-gc', { draft: draft(), image: { blob: png, width: 1, height: 1 } });
    const oldFile = h.state.settings.illustration_index['scene-gc'].file;
    assert.equal(h.state.files.has(oldFile), true);

    await store.saveGeneratedIllustration('scene-gc', { draft: draft(), image: { blob: png, width: 1, height: 1 } });
    const newFile = h.state.settings.illustration_index['scene-gc'].file;
    assert.notEqual(newFile, oldFile);
    assert.equal(h.state.files.has(oldFile), false, '被取代的旧记录要回收，否则会一直堆积');
    assert.equal(h.state.files.has(newFile), true);

    // 提交失败时指针会回滚 —— 那时旧记录仍是"正在用的那份"，提前删就等于删掉它。
    h.state.saveFails = true;
    await assert.rejects(store.saveGeneratedIllustration('scene-gc', { draft: draft(), image: { blob: png, width: 1, height: 1 } }));
    h.state.saveFails = false;
    assert.equal(h.state.settings.illustration_index['scene-gc'].file, newFile);
    assert.equal(h.state.files.has(newFile), true, '提交失败绝不该回收旧记录');
});

test('the delete button removes an image instead of adopting it', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const store = await h.load('src/core/illustrationStore.js');
    const target = data.createIllustrationTarget({ content: story, generationId: 'g-del-ui' });
    const record = await store.saveGeneratedIllustrations(target.sceneId, {
        draft: draft(), createdAt: Date.now(),
        images: [{ blob: png, width: 1, height: 1 }, { blob: png, width: 1, height: 1 }],
    });
    const [first, second] = record.images;
    ui.openIllustrationWindow(target);
    const button = id => h.document.querySelector(`[data-action="delete-image"][data-image-id="${id}"]`);
    await waitFor(() => button(first.id), 'delete button rendered');

    // ⚠ 回归：这个按钮同时带 data-image-id，派发若按属性存在性走就会变成「采用这张」。
    button(first.id).click();
    await waitFor(() => !button(first.id), 'removed from gallery');
    const after = await store.readSceneIllustrations(target.sceneId);
    assert.equal(after.images.some(image => image.id === first.id), false, '删掉而不是采用');
    assert.equal(after.selectedId, second.id);

    // 取消确认框：一个字都不动。
    h.state.confirmResult = false;
    button(second.id).click();
    await new Promise(resolve => setTimeout(resolve, 40));
    const unchanged = await store.readSceneIllustrations(target.sceneId);
    assert.deepEqual(Array.from(unchanged.images, image => image.id), [second.id]);
    h.state.confirmResult = true;
    h.document.querySelector('[data-action="close"]').click();
});

test('manage mode batches deletes and disables the action at zero selection', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const store = await h.load('src/core/illustrationStore.js');
    const target = data.createIllustrationTarget({ content: story, generationId: 'g-manage' });
    await store.saveGeneratedIllustrations(target.sceneId, {
        draft: draft(), createdAt: Date.now(),
        images: [{ blob: png, width: 1, height: 1 }, { blob: png, width: 1, height: 1 }],
    });
    ui.openIllustrationWindow(target);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    const count = () => h.document.querySelector('.t-illustration-select-count')?.textContent || '';
    await waitFor(() => action('enter-manage-images'), 'gallery rendered');

    action('enter-manage-images').click();
    await waitFor(() => action('select-all-images'), 'manage bar');
    assert.equal(action('delete-selected-images').disabled, true, '一张没选时批量删除应禁用');
    assert.equal(h.document.querySelectorAll('[data-select-image-id]').length, 2, '管理模式才出勾选框');
    assert.equal(h.document.querySelectorAll('[data-action="delete-image"]').length, 0, '管理模式下不给两个删除入口');

    const box = h.document.querySelector('[data-select-image-id]');
    box.checked = true;
    box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await waitFor(() => action('delete-selected-images').disabled === false, 'enabled after one');
    assert.match(count(), /已选择 1 张/);

    action('select-all-images').click();
    await waitFor(() => /已选择 2 张/.test(count()), 'all selected');
    action('delete-selected-images').click();
    await waitFor(() => !h.document.querySelector('.t-illustration-candidate'), 'all gone');
    assert.equal((await store.readSceneIllustrations(target.sceneId)).images.length, 0);
    h.document.querySelector('[data-action="close"]').click();
});

test('a file a favorite still points at survives deletion, and backup export keeps working', async t => {
    const h = harness(); t.after(h.close);
    const store = await h.load('src/core/illustrationStore.js');
    const refs = await h.load('src/core/illustrationReferences.js');
    const portability = await h.load('src/core/illustrationPortability.js');
    const record = await store.saveGeneratedIllustrations('scene-fav', {
        draft: draft(), createdAt: Date.now(),
        images: [{ blob: png, width: 1, height: 1 }, { blob: png, width: 1, height: 1 }],
    });
    const [kept, gone] = record.images;
    seedFavorite(h, { id: 'f-x', illustration: { id: 'snap', filePath: kept.filePath, draft: draft(), width: 1, height: 1, createdAt: 1 } });

    const result = await store.deleteSceneIllustrations('scene-fav', [kept, gone], {
        collectReferenced: async paths => (await refs.findReferencedIllustrationPaths(paths)).referenced,
    });
    assert.deepEqual([...result.keptReferenced], [kept.filePath]);
    assert.deepEqual([...result.deletedFiles], [gone.filePath]);
    assert.equal(h.state.files.has(kept.filePath), true, '收藏还在用它，文件必须留');

    // 最终判据：删完之后整个备份导出仍然成功。少一个被引用的文件它就会抛
    // 「已停止导出以免遗漏图片」并把整次备份废掉 —— 这才是引用计数存在的理由。
    const favorites = [{ id: 'f-x', illustration: { filePath: kept.filePath } }];
    const bundle = await portability.exportIllustrationBackup(favorites);
    assert.ok(bundle.assets[kept.filePath], '被引用的文件必须还在，否则这行之前的导出就已抛错');
});

test('deleting from a favorite clears its snapshot so the image cannot come back', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const store = await h.load('src/core/illustrationStore.js');
    const target = data.createIllustrationTarget({ content: story, generationId: 'g-fav-del' });
    const record = await store.saveGeneratedIllustration(target.sceneId, { draft: draft(), image: { blob: png, width: 1, height: 1 } });
    const picture = store.selectedIllustration(record);

    let writtenBack = 'unset';
    // 收藏目标：自带一份快照，并且带 favoriteId（引用扫描要把它排除掉）。
    ui.openIllustrationWindow({
        ...target,
        illustration: picture,
        favoriteId: 'fav-9',
        onSelected: async image => { writtenBack = image; },
    });
    const button = () => h.document.querySelector('[data-action="delete-image"]');
    await waitFor(() => button(), 'delete button');
    button().click();
    await waitFor(() => writtenBack !== 'unset', 'favorite written back');
    // 一张不剩 → 写回 null；favsWindow 对 null 的处理是删掉快照字段，
    // 于是下次 loadTarget 的 Object.hasOwn(current,"illustration") 为假，不会再注入（不复活）。
    assert.equal(writtenBack, null);
    assert.equal(h.state.files.has(picture.filePath), false, '快照已清，文件就该删掉');
    h.document.querySelector('[data-action="close"]').click();
});

test('the manage controls are disabled while a job is running', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const store = await h.load('src/core/illustrationStore.js');
    const target = data.createIllustrationTarget({ content: story, generationId: 'g-busy' });
    await store.saveGeneratedIllustration(target.sceneId, { draft: draft(), image: { blob: png, width: 1, height: 1 } });
    // 让选景挂住不返回，制造「忙」。
    h.state.llmHandler = () => new Promise(() => { });
    ui.openIllustrationWindow(target);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    await waitFor(() => !action('prepare').disabled);
    action('prepare').click();
    await waitFor(() => action('prepare').disabled, 'job started');
    assert.equal(action('enter-manage-images').disabled, true, '忙时管理按钮也要禁用');
    assert.equal(h.document.querySelector('[data-action="delete-image"]').disabled, true, '单张删除同样要禁用');
    h.document.querySelector('[data-action="close"]').click();
});

test('a new profile fills its trigger words from the name, until the user edits them', async t => {
    const h = harness(); t.after(h.close);
    const profiles = await h.load('src/ui/characterProfileWindow.js');
    profiles.openCharacterProfileWindow();
    const root = h.document.querySelector('.t-profile-window');
    const entries = () => h.state.settings.character_profiles.entries;
    // 跨 realm 的数组原型不同，deepEqual 会判不等，所以读出来先转成本 realm 的。
    const keywords = () => Array.from(entries()[0].keywords);
    // labeled() 把标签文字作为文本节点放在控件之前，据此定位这两个输入框。
    const fieldInput = text => [...root.querySelectorAll('label.t-illustration-field')]
        .find(el => el.textContent.startsWith(text))?.querySelector('input');
    const type = (input, value) => {
        input.value = value;
        input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    };

    root.querySelector('[data-action="add"]').click();
    assert.equal(entries().length, 1);
    // 新建出来叫「新档案」但触发词是空的 —— 那是个占位名，不该顺手塞成触发词。
    assert.deepEqual(keywords(), []);

    // 填名字 → 触发词自动跟上，而且输入框里**看得见**（不重画列表，只同步这一格的值）。
    type(fieldInput('档案名称'), '阿离');
    assert.deepEqual(keywords(), ['阿离']);
    assert.equal(fieldInput('触发词').value, '阿离');

    // 改名 → 触发词跟着改。
    type(fieldInput('档案名称'), '阿狸');
    assert.deepEqual(keywords(), ['阿狸']);

    // 用户自己写过触发词之后，改名不再覆盖它 —— 与「手打的永不被覆盖」同一原则。
    type(fieldInput('触发词'), '阿狸，小狸');
    type(fieldInput('档案名称'), '阿狸大人');
    assert.deepEqual(keywords(), ['阿狸', '小狸']);
    assert.equal(entries()[0].name, '阿狸大人');

    // 名字短于下限时给空数组，而不是填一个等着被规范化裁掉的值。
    type(fieldInput('触发词'), '');
    type(fieldInput('档案名称'), '狸');
    assert.deepEqual(keywords(), []);

    // 只留一条与名字相同的触发词时，改名让它跟着走（判定是无状态的，不靠「碰过没有」的标记）。
    type(fieldInput('档案名称'), '阿狸');
    assert.deepEqual(keywords(), ['阿狸']);
    type(fieldInput('档案名称'), '阿狸大人');
    assert.deepEqual(keywords(), ['阿狸大人']);

    h.document.querySelector('.t-profile-window [data-action="close"]').click();
});

/* ------------------------------------------------------------------ *
 * 「本次补充」（临时指令）—— 两条只能靠源码文本守住的契约
 *
 * 夹具刻意不加载 api.js（它拽着整条生成链路），所以这里只能做源码断言。
 * 之所以值得单列，是因为这两条坏起来都是**静默**的：不报错、不崩溃，
 * 只是提示词里少一段、或查看器里分段错位。
 * ------------------------------------------------------------------ */

test('临时指令独立成段，不得混进 [剧本指令] 的正文', () => {
    const api = stripped('src/core/api.js');

    // 两个组装点各登记一次分段长度（真实生成 + 预览）
    assert.equal((api.match(/sectionLengths\.tempInstruction/g) || []).length, 2,
        'sectionLengths.tempInstruction 应在 handleGenerate 与 buildPromptCompositionPreview 各出现一次');

    // 续写的三段长度求和必须恰好等于 promptBody.length 才拆段（applyScriptInstructionSectionLengths）。
    // 把补充段并进 processedPrompt 会让这个和立刻对不上，续写的三段拆分静默退化成一整块。
    const scriptBlockLines = api.split('\n').filter(line => line.includes('[剧本指令]'));
    assert.ok(scriptBlockLines.length > 0, '应能找到 [剧本指令] 块的构造处');
    for (const line of scriptBlockLines) {
        assert.equal(/本次补充/.test(line), false,
            '[剧本指令] 块里不得包含本次补充 —— 它必须独立成段拼在后面');
    }
});

test('提示词查看器的分段顺序与 user 串拼接顺序一致', () => {
    const debug = stripped('src/ui/debugWindow.js');
    const continuationIdx = debug.indexOf('["continuationInstruction"');
    const tempIdx = debug.indexOf('["tempInstruction"');

    assert.ok(continuationIdx >= 0, 'definitions 里应有 continuationInstruction');
    assert.ok(tempIdx >= 0, 'definitions 里应有 tempInstruction');
    // definitions 是"键 + 标签"的顺序表，查看器按累计长度连续切片。
    // 补充段拼在 [剧本指令] 块之后，所以它必须排在续写三段之后。
    assert.ok(tempIdx > continuationIdx,
        'tempInstruction 必须排在 continuationInstruction 之后，否则后面的分段会整体错位');

    const api = stripped('src/core/api.js');
    assert.ok(api.indexOf('user += tempInstructionBlock') > api.indexOf('user += scriptBlock'),
        '补充段必须在 scriptBlock 之后追加');
});

test('选用预设模式下补充段也要能进提示词', () => {
    const api = stripped('src/core/api.js');
    // 预设模式下整条 user 串不会被注入（预设条目 id 永远不等于 preset_user），
    // {{titaniaScript}} 是剧本正文的唯一通道 —— 漏了这行，预设模式用户就看不到补充。
    assert.equal((api.match(/titaniaScript: processedPrompt \+ tempInstructionBlock/g) || []).length, 2,
        '两个组装点的 titaniaScript 都应并上补充段');
});

test('tempInstruction.js 保持零依赖', () => {
    // 它被 core（api.js）与 ui（mainWindow/topBar）两侧同时引用：一旦引入 import，
    // 就会牵出 core↔ui 的依赖方向问题 —— 那正是它独立成模块要躲开的东西。
    // 真正的行为验证在 tests/tempInstruction.test.mjs：那边的 vm 夹具**不挂任何桩**，
    // 只要它多一条 import，加载就当场失败。这里是同一件事的快速失败版。
    assert.equal(/^\s*import\s/m.test(stripped('src/core/tempInstruction.js')), false,
        'tempInstruction.js 不得 import 任何模块');
});

test('功能总开关在 core 两个组装点与 ui 显隐处都加了闸', () => {
    // 设置页关掉「本次补充」后，三处必须都看不到它：api.js 的真实生成与预览两个组装点，
    // 以及 mainWindow 顶栏那条的显隐。少一处就会出现「关了还在用 / 关了还显示」的割裂。
    const api = stripped('src/core/api.js');
    assert.equal((api.match(/isTempInstructionFeatureEnabled\(/g) || []).length, 2,
        'api.js 应在 handleGenerate 与 buildPromptCompositionPreview 各闸一次');

    const main = stripped('src/ui/mainWindow.js');
    assert.ok(/isTempInstructionFeatureEnabled\(/.test(main),
        'mainWindow.js 的 updateTempInstructionUI 必须按开关决定那条的显隐');
});
