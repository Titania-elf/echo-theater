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
const png = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9yQAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' });
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

function harness() {
    const dom = new JSDOM('<!doctype html><body><div id="t-output-content"></div></body>', { url: 'http://localhost:8000/' });
    const state = {
        settings: seededPresets(), files: new Map(), uploads: 0, saveFails: false,
        generateCalls: [], llmCalls: [],
        // 选景 LLM 的默认实现；单个用例可替换成挂起、报错或返回坏格式。
        llmHandler: () => sceneReply(),
        // 角色身份桩：默认没有角色卡（等同群聊/无卡），用例按需覆盖。
        cardKey: '', cards: [], characterDescription: '',
        // 确认框：默认放行，用例可改成 false 来测「用户点了取消」。
        confirmResult: true, promptResult: null,
        // STscript 变量存储桩。选景的变量沙箱会经 SillyTavern.getContext() 快照/还原它们，
        // 用例可以预置内容来验证「构建后必须还原」。
        chatMetadata: { variables: {} },
        extensionSettings: { variables: { global: {} } },
    };
    const { window } = dom;
    window.URL.createObjectURL = URL.createObjectURL;
    window.URL.revokeObjectURL = URL.revokeObjectURL;
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
        SillyTavern: { getContext: () => ({ chatMetadata: state.chatMetadata, extensionSettings: state.extensionSettings }) },
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
        [path.join(project, 'src/utils/userFiles.js'), 'export const { uploadTextFile, fetchTextFile } = __environment; export const utf8ByteLength = x => x.length; export const deleteUserFile = async () => {}; export const verifyUserFiles = async () => true;'],
        [path.join(project, 'src/core/chatInjector.js'), 'export const { buildPromptTextFromTheater } = __environment;'],
        [path.join(project, 'src/core/logger.js'), 'export const TitaniaLogger = { warn() {}, error() {}, info() {} };'],
        // 选景走插件自有 LLM：这里只桩掉连接层，不引入 ST 宿主模块。
        [path.join(project, 'src/core/connection.js'), 'export const { getActiveConnection, sendChatRequestWithConnection } = __environment;'],
        // 角色身份来自 ST 上下文；夹具里同样桩掉，避免拉进 world-info.js 等宿主模块。
        [path.join(project, 'src/core/context.js'), 'export const { getCharacterCardKey, listCharacterCards, getCurrentCharacterDescription } = __environment;'],
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
    // Cosmos dev 分支交付的薄接口：只有 version 与 generateImage，没有能力协商。
    // 返回的是裸 Blob（无类型、无尺寸），由适配层嗅探补齐。
    window.CosmosVision = {
        version: '1.3.0',
        generateImage: async options => {
            state.generateCalls.push(options);
            return { requestId: options.requestId, imageBlobs: [png], prompts: options.prompts };
        },
    };
    return { ...state, state, load, window, document: window.document, close: () => window.close() };
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
    // 画面描述不再是必填：输出契约只要求 positivePrompt，模型不会再返回 summary。
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

test('panel can retry saving without paying for another image; new displayed scene never receives old result', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const first = data.createIllustrationTarget({ content: story, generationId: 'first' });
    const second = data.createIllustrationTarget({ content: '另一幕', generationId: 'second' });
    let displayed = first;
    const unbind = ui.bindMainIllustrations(() => displayed);
    t.after(unbind);
    ui.openIllustrationWindow(first);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    await waitFor(() => !action('prepare').disabled);
    action('prepare').click();
    await waitFor(() => !action('generate').disabled);
    h.state.saveFails = true;
    action('generate').click();
    await waitFor(() => !action('save').hidden && !action('save').disabled);
    displayed = second;
    h.window.dispatchEvent(new h.window.CustomEvent('titania:scene-rendered'));
    await new Promise(resolve => setTimeout(resolve, 100));
    h.state.saveFails = false;
    action('save').click();
    await waitFor(() => action('save').hidden);
    assert.equal(h.state.generateCalls.length, 1);
    assert.ok(h.state.settings.illustration_index[first.sceneId]);
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

test('main content renders the adopted image at the head of the theater content', async t => {
    const h = harness(); t.after(h.close);
    const ui = await h.load('src/ui/illustrationWindow.js');
    const data = await h.load('src/core/illustrationData.js');
    const store = await h.load('src/core/illustrationStore.js');
    const content = `<p>清晨，雨还没停。</p><p>${story}</p><p>她合上门。</p>`;
    const target = data.createIllustrationTarget({ content, generationId: 'g-inline', scriptId: 'script-inline' });
    const record = await store.saveGeneratedIllustration(target.sceneId, { draft: draft(), image: { blob: png, width: 1, height: 1 } });
    const picture = store.selectedIllustration(record);
    // 正文在 Shadow DOM 里渲染，配图要跟着正文一起渲染在开头。
    const container = h.document.getElementById('t-output-content');
    const host = h.document.createElement('div');
    host.className = 't-shadow-host';
    host.attachShadow({ mode: 'open' }).innerHTML = `<div class="t-shadow-content">${content}</div>`;
    container.append(host);
    const unbind = ui.bindMainIllustrations(() => target);
    t.after(unbind);
    const shadowContent = host.shadowRoot.querySelector('.t-shadow-content');
    await waitFor(() => shadowContent.querySelector('[data-titania-illustration]'), 'illustration at the head');
    const figure = shadowContent.querySelector('[data-titania-illustration]');
    assert.equal(figure.getAttribute('data-titania-illustration'), picture.id);
    assert.equal(shadowContent.firstElementChild, figure);
    assert.equal(figure.nextElementSibling.textContent, '清晨，雨还没停。');
    // 流式重绘会重建整块正文，配图要按缓存补回开头
    container.innerHTML = '';
    const nextHost = h.document.createElement('div');
    nextHost.className = 't-shadow-host';
    nextHost.attachShadow({ mode: 'open' }).innerHTML = `<div class="t-shadow-content">${content}</div>`;
    container.append(nextHost);
    h.window.dispatchEvent(new h.window.CustomEvent('titania:scene-rendered'));
    const nextContent = nextHost.shadowRoot.querySelector('.t-shadow-content');
    await waitFor(() => nextContent.querySelector('[data-titania-illustration]'), 'restored illustration');
    assert.equal(nextContent.firstElementChild, nextContent.querySelector('[data-titania-illustration]'));
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

test('excerpt mismatch is rejected at selection time but never on read paths', async t => {
    const h = harness(); t.after(h.close);
    const data = await h.load('src/core/illustrationData.js');
    const text = '深夜门口，两人隔着半开的门对视。';

    assert.equal(data.assertIllustrationExcerpt({ scene: { sourceExcerpt: '两人隔着半开的门对视' } }, text) ? 'ok' : 'x', 'ok');
    assert.throws(() => data.assertIllustrationExcerpt({ scene: { sourceExcerpt: '两人在雨中拥抱' } }, text), /不是正文中的连续原文/);
    // 摘录是可选的：模型没给就不拦，它只是给用户看的对照片段。
    assert.ok(data.assertIllustrationExcerpt({ scene: {} }, text));

    // 关键：读路径拿不到正文，所以校验绝不能进 normalize，否则所有旧记录都会渲染失败。
    assert.ok(data.normalizeIllustrationDraft({ ...draft(), scene: { summary: 'x', sourceExcerpt: '正文里根本没有这句' } }));
    assert.ok(data.normalizeSavedIllustration({ id: 'i', filePath: '/user/files/titania-illustration-a1.png', draft: draftV1(), width: 1, height: 1, createdAt: 0 }));
});

test('a reply carrying only the positive prompt is a complete, usable draft', async t => {
    const h = harness(); t.after(h.close);
    const data = await h.load('src/core/illustrationData.js');
    const scene = await h.load('src/core/illustrationScene.js');

    // 托管条目的「输出格式」现在只要求这一个字段，模型不会再给摘要、摘录、
    // 负向词与人物分段提示词 —— 整条链路必须照常走通。
    const minimal = scene.draftFromSceneReply('{"positivePrompt":"two people, doorway, night"}', '深夜门口，两人对视。');
    assert.equal(minimal.prompts.positivePrompt, 'two people, doorway, night');
    assert.equal(minimal.scene.summary, '', '摘要落成空串，供渲染端判空');
    assert.equal('sourceExcerpt' in minimal.scene, false);
    assert.equal(minimal.prompts.negativePrompt, '', '缺省负向词落成空串');
    // ⚠ 不写 deepEqual(…, [])：草稿来自 vm 沙箱，数组原型与测试侧不同，严格深比较会挂。
    assert.equal(minimal.prompts.characterPrompts.length, 0, '缺省人物分段落成空数组');
    // 空数组必须能原样发给 Cosmos（契约要求它始终是数组）
    assert.ok(Array.isArray(minimal.prompts.characterPrompts));

    // 空摘要不能在图题里留壳：illustrationFigure 是图库/收藏/导出/正文共用的唯一产出点
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

test('scene selection reports NO_SCENE, repairs one bad reply, and refuses invented excerpts', async t => {
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

    // 编造的原文摘录是内容问题，重发同一段提示词并不能可靠修好，所以不重试。
    calls = 0;
    h.state.llmHandler = () => { calls += 1; return sceneReply({ sourceExcerpt: '正文里根本没有这句' }); };
    await assert.rejects(scene.selectIllustrationScene({ theaterText: text }), error => error.code === 'EXCERPT_MISMATCH');
    assert.equal(calls, 1);

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
    const stripped = file => readFileSync(path.join(project, file), 'utf8')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const file of ['src/core/illustrationScene.js', 'src/core/cosmosVisionBridge.js', 'src/ui/illustrationWindow.js']) {
        assert.equal(/cancelGeneration|GlobalState/.test(stripped(file)), false, `${file} 不应引用全局生成状态`);
    }
    // 配图面板只能读 target.cardKey，绝不能现读当前聊天的角色身份 ——
    // 那会在 B 聊天给 A 的收藏配图时，把 B 的角色档案套到 A 的画面上。
    assert.equal(/getContextData|getCharacterCardKey/.test(stripped('src/ui/illustrationWindow.js')), false,
        'illustrationWindow.js 不应读当前聊天的角色身份');
    // 选景只跑 STscript 变量宏（预设在条目里 setvar、后段 getvar，不求值它们整份预设就是死的），
    // 但绝不走 ST 的全套宏引擎：那会连带展开 {{char}} / {{user}} / {{description}}，
    // 同样是在读当前聊天，会串到别的收藏上。
    for (const file of ['src/core/illustrationPresets.js', 'src/ui/illustrationSettingsWindow.js', 'src/core/illustrationScene.js']) {
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
    assert.equal(profiles.ensureCharacterProfiles(data), false);
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
