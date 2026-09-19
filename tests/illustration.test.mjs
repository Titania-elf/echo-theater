import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const png = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9yQAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' });
const story = '深夜门口，两人隔着半开的门对视。';
const draft = () => ({
    version: 1, imageSource: 'novelai', model: 'nai-test',
    scene: { summary: '深夜门口的重逢。' },
    prompts: { positivePrompt: 'two people, doorway, night', negativePrompt: '', characterPrompts: [{ positivePrompt: 'black hair', negativePrompt: '', position: { x: 0.3, y: 0.5 } }] },
});
const capabilities = () => ({
    apiVersion: '1.0', ready: true, enabled: true, defaultImageSource: 'novelai',
    features: { theaterPrompt: true, providedContext: true }, limits: { maxTextChars: 10000, maxImages: 1 },
    imageSources: [{ id: 'novelai', label: 'NovelAI', ready: true, model: 'nai-test' }],
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
    const state = { settings: {}, files: new Map(), uploads: 0, saveFails: false, prepareCalls: [], generateCalls: [] };
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
    };
    const context = vm.createContext({
        console, Blob, Buffer, Uint8Array, TextEncoder, AbortController, structuredClone,
        setTimeout, clearTimeout, atob, btoa, crypto: globalThis.crypto,
        window, document: window.document, CustomEvent: window.CustomEvent,
        MutationObserver: window.MutationObserver, Option: window.Option, URL: window.URL,
        FileReader: TestFileReader, __environment: environment,
        fetch: async (url, options) => {
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
        [path.join(project, 'src/utils/helpers.js'), 'export const getSnippet = x => x; export const parseMeta = () => ({ char: "角色", script: "剧本" }); export const exportAsHtmlFile = async () => {};'],
        ['host:script', 'export const getRequestHeaders = () => ({ "Content-Type": "application/json" });'],
    ]);
    const modules = new Map();
    function moduleFor(id) {
        if (!modules.has(id)) modules.set(id, new vm.SourceTextModule(sources.get(id) ?? readFileSync(id, 'utf8'), { context, identifier: id }));
        return modules.get(id);
    }
    async function load(relative) {
        const module = moduleFor(path.join(project, relative));
        if (module.status === 'unlinked') await module.link((specifier, ref) => moduleFor(specifier === '../../../../script.js' ? 'host:script' : path.resolve(path.dirname(ref.identifier), specifier)));
        if (module.status === 'linked') await module.evaluate();
        return module.namespace;
    }
    window.CosmosVision = {
        apiVersion: '1.0', getCapabilities: async () => capabilities(),
        preparePrompt: async (request, control) => {
            state.prepareCalls.push({ request, control });
            return draft();
        },
        generate: async (request, control) => {
            state.generateCalls.push({ request, control });
            return { requestId: control.requestId, draft: request.draft, images: [{ blob: png, mimeType: 'image/png', width: 1, height: 1, seed: 12 }] };
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

test('bridge rejects missing API, unsupported version, missing summary and non-image payload', async t => {
    const h = harness(); t.after(h.close);
    const bridge = await h.load('src/core/cosmosVisionBridge.js');
    const api = h.window.CosmosVision;
    delete h.window.CosmosVision;
    await assert.rejects(bridge.getCosmosCapabilities(), /公开接口/);
    h.window.CosmosVision = { ...api, apiVersion: '2.0' };
    await assert.rejects(bridge.getCosmosCapabilities(), /版本不兼容/);
    h.window.CosmosVision = api;
    const data = await h.load('src/core/illustrationData.js');
    // 画面描述缺失应拒绝；不再要求逐字摘录正文原文。
    assert.throws(() => data.normalizeIllustrationDraft({ ...draft(), scene: {} }), /画面描述/);
    await assert.rejects(data.validateIllustrationBlob(new Blob(['<html>Error</html>'], { type: 'image/png' })), /格式不符/);
    const clean = data.normalizeIllustrationDraft({ ...draft(), apiKey: 'must-not-persist' });
    assert.equal('apiKey' in clean, false);
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
    h.window.CosmosVision.generate = async (request, control) => {
        called = true;
        return new Promise(resolve => { deliver = () => resolve({ requestId: control.requestId, draft: request.draft, images: [{ blob: png, mimeType: 'image/png', width: 1, height: 1 }] }); });
    };
    const controller = new AbortController();
    const pending = bridge.generateTheaterIllustration(draft(), { signal: controller.signal });
    await waitFor(() => called);
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    deliver();
    assert.equal(h.state.uploads, 0);
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
    assert.equal(h.state.prepareCalls[0].request.theaterText, story);
    assert.equal(h.state.prepareCalls[0].request.context.mode, 'provided');
    h.document.querySelector('[data-field="positive"]').value = 'edited scene';
    h.document.querySelector('[data-character="0"][data-key="positivePrompt"]').value = 'white hair';
    action('generate').click();
    await waitFor(() => saved, 'saved picture');
    assert.equal(h.state.generateCalls[0].request.draft.prompts.positivePrompt, 'edited scene');
    assert.equal(h.state.generateCalls[0].request.draft.prompts.characterPrompts[0].positivePrompt, 'white hair');
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
    h.window.CosmosVision.generate = (request, control) => {
        h.state.generateCalls.push({ request, control });
        return new Promise(resolve => { deliver = () => resolve({ requestId: control.requestId, draft: request.draft, images: [{ blob: png, mimeType: 'image/png', width: 1, height: 1, seed: 7 }] }); });
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
    let prepareControl = null;
    h.window.CosmosVision.preparePrompt = (request, control) => {
        h.state.prepareCalls.push({ request, control });
        prepareControl = control;
        return new Promise(() => {});
    };
    const target = data.createIllustrationTarget({ content: story, generationId: 'g-reattach' });
    ui.openIllustrationWindow(target);
    const action = name => h.document.querySelector(`[data-action="${name}"]`);
    const status = () => h.document.querySelector('[data-role="status"]').textContent;
    await waitFor(() => !action('prepare').disabled, 'API ready');
    action('prepare').click();
    await waitFor(() => prepareControl, 'analysis started');
    action('close').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    ui.openIllustrationWindow(target);
    await waitFor(() => !action('cancel').hidden, 'cancel visible after reopen');
    assert.match(status(), /正在分析剧场/);
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
