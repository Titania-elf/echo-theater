import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractRewriteProjection, mapRewriteUnits, prepareSourcePatch, applySourcePatches } from '../src/core/textRewritePatch.js';
import { splitText } from '../src/core/textRewriteCore.js';
import { captureRewriteTarget, commitRewritePatches, persistRewriteTarget } from '../src/core/textRewriteWriteback.js';
import { collectRewriteTextGroups } from '../src/ui/textRewriteDom.js';

const unitsFor = (projection, mode = 'sentence') => splitText(projection.text, mode).map((text, i) => ({ unitIndex: i + 1, text }));
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(raw, html, { whitelist = '', message = {}, mode = 'sentence' } = {}) {
    const dom = new JSDOM(`<body><div id="chat"><div class="mes" mesid="0"><div class="mes_text">${html}</div></div></div></body>`);
    const container = dom.window.document.querySelector('.mes_text');
    const msg = { mes: raw, ...message };
    const ctx = { chat: [msg], chatMetadata: {}, chatId: 'chatA', groupId: null, characterId: 0, characters: [{ name: '角色', avatar: 'a.png' }] };
    let current = ctx;
    let display = container;
    let saves = 0;
    let notifications = 0;
    const projection = extractRewriteProjection(raw, whitelist);
    const target = captureRewriteTarget(ctx, 0, projection, container);
    const units = unitsFor(projection, mode);
    const options = {
        getContext: () => current, getContainer: () => display, isGenerating: () => false,
        persist: async () => { saves++; }, notify: async () => { notifications++; },
    };
    return {
        dom, container, msg, ctx, projection, target, units, options,
        setContext: value => { current = value; }, setDisplay: value => { display = value; },
        get saves() { return saves; }, get notifications() { return notifications; },
        commit: (pairs, overrides = {}) => commitRewritePatches(target, units, new Map(pairs), { ...options, ...overrides }),
    };
}

test('白名单支持中文，按源文顺序提取，缺失时不回退到全文', () => {
    const p = extractRewriteProjection('<旁白>甲。</旁白><正文>乙。</正文><状态栏>状态。</状态栏>', '正文,旁白');
    assert.equal(p.text, '甲。\n\n乙。');
    assert.equal(extractRewriteProjection('<正文>甲。</正文>', 'content').text, '');
    assert.match(extractRewriteProjection('<正文>甲。</正文>', 'content').reason, /未回退/);
    assert.match(extractRewriteProjection('甲。', '???').reason, /格式无效/);
});

test('保护状态、脚本中的标签、注释、内联代码和封闭/未封闭代码块', () => {
    const raw = '甲。\n<script>let html = "<div>不要改。</div>";</script><style>.x { color: red; }</style><!-- 不要改。 -->\n`不要改。`\n```html\n<div>不要改。</div>\n```\n乙。\n~~~\n不要改。';
    const p = extractRewriteProjection(raw);
    assert.deepEqual(unitsFor(p).map(unit => unit.text.trim()), ['甲。', '乙。']);
    assert.equal(extractRewriteProjection('<状态栏>甲。</状态栏><div data-state="1">乙。</div><div class="status-card">丙。</div>').text, '');
});

test('不闭合或错配标签保守停止提取', () => {
    for (const raw of ['<正文>甲。', '<正文><span>甲。</正文>', '<script>甲。']) {
        assert.equal(extractRewriteProjection(raw).text, '');
        assert.ok(extractRewriteProjection(raw).reason);
    }
});

test('实体映射保留字符位置，补丁外的字节完全不变', () => {
    const raw = '<正文 data-unused="x">A &amp; B。</正文>';
    // data attributes are intentionally protected.
    assert.equal(extractRewriteProjection(raw, '正文').text, '');
    const source = '<正文> A &amp; B。&#x1F642;。</正文><状态栏>信任：10</状态栏>';
    const p = extractRewriteProjection(source, '正文');
    const mapped = mapRewriteUnits(p, unitsFor(p));
    const patch = prepareSourcePatch(mapped[0], 'C & D。');
    assert.equal(patch.reason, '');
    assert.equal(applySourcePatches(source, [patch]), '<正文> C &amp; D。&#x1F642;。</正文><状态栏>信任：10</状态栏>');
});

test('跨标签的段落、复杂 Markdown、可执行输出均只预览', async () => {
    const p = extractRewriteProjection('<正文>甲<span>乙</span>丙。</正文>', '正文');
    const cross = mapRewriteUnits(p, [{ unitIndex: 1, text: p.text }])[0];
    assert.ok(prepareSourcePatch(cross, '新句。').reason);
    for (const raw of ['他**非常**愤怒。', '[链接](url)。', '> 他很愤怒。']) {
        const f = fixture(raw, '他非常愤怒。');
        const r = await f.commit([[1, '他攥紧拳头。']]);
        assert.equal(r.applied, 0);
        assert.equal(f.msg.mes, raw);
    }
    for (const replacement of ['<script>alert(1)</script>', '**新句。**', '新句。\n另一段。']) {
        const f = fixture('原句。', '<p>原句。</p>');
        const r = await f.commit([[1, replacement]]);
        assert.equal(r.applied, 0);
        assert.match(r.entries[0].reason, /格式|换行/);
    }
});

test('内联标签内外保持完整句子供模型预览，但不跨标签写回', () => {
    const p = extractRewriteProjection('<正文>他<span>很</span>愤怒。</正文>', '正文');
    assert.equal(p.text, '他很愤怒。');
    const mapped = mapRewriteUnits(p, unitsFor(p));
    assert.equal(mapped.length, 1);
    assert.match(prepareSourcePatch(mapped[0], '他攥紧拳头。').reason, /跨越/);
});

test('保存未结束时下一批写回保持预览，避免两个补丁互相覆盖', async () => {
    const f = fixture('原句。', '<p>原句。</p>');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = f.commit([[1, '新句。']], { persist: () => gate });
    const projection = extractRewriteProjection(f.msg.mes);
    const target = captureRewriteTarget(f.ctx, 0, projection, f.container);
    const second = await commitRewritePatches(target, unitsFor(projection), new Map([[1, '另一句。']]), f.options);
    assert.equal(second.applied, 0); assert.match(second.entries[0].reason, /仍在保存/);
    release(); assert.equal((await first).applied, 1);
    assert.equal(f.msg.mes, '新句。');
});

test('原文补丁拒绝重叠', () => {
    assert.throws(() => applySourcePatches('abc', [{ start: 0, end: 2, after: 'x' }, { start: 1, end: 3, after: 'y' }]), /重叠/);
});

test('改写保留原文标签、状态与前端字节，只发专用通知', async () => {
    const raw = '<正文>他很愤怒。</正文><状态栏>信任：尚未恢复</状态栏><iframe src="about:blank"></iframe>';
    const f = fixture(raw, '<div class="prose"><p>他很愤怒。</p></div><div class="status-card">信任：尚未恢复</div><iframe src="about:blank"></iframe>', { whitelist: '正文' });
    const iframe = f.container.querySelector('iframe');
    const frameWindow = iframe.contentWindow;
    frameWindow.storyState = { progress: 42 };
    const paragraph = f.container.querySelector('p');
    const node = paragraph.firstChild;
    const parentNodes = Array.from(f.container.childNodes);
    let clicks = 0;
    paragraph.addEventListener('click', () => clicks++);
    const r = await f.commit([[1, '他攥紧了拳头。']]);
    assert.equal(r.applied, 1);
    assert.equal(f.msg.mes, '<正文>他攥紧了拳头。</正文><状态栏>信任：尚未恢复</状态栏><iframe src="about:blank"></iframe>');
    assert.equal(paragraph.firstChild, node);
    assert.deepEqual(Array.from(f.container.childNodes), parentNodes);
    assert.equal(iframe.contentWindow, frameWindow);
    assert.equal(frameWindow.storyState.progress, 42);
    paragraph.click(); assert.equal(clicks, 1);
    assert.equal(f.notifications, 1); assert.equal(f.saves, 1);
    assert.equal(f.msg.extra.titania_rewrite_done, true);
    assert.equal(Object.hasOwn(f.msg, 'message'), false);
});

test('同一节点上的多句和重复句按源位置改写', async () => {
    const f = fixture('<正文>重复。重复。尾声。</正文><状态栏>重复。</状态栏>', '<p>重复。重复。尾声。</p><div class="status-card">重复。</div>', { whitelist: '正文' });
    const node = f.container.querySelector('p').firstChild;
    const r = await f.commit([[2, '第二句。'], [3, '结束。']]);
    assert.equal(r.applied, 2);
    assert.equal(node.data, '重复。第二句。结束。');
    assert.equal(f.msg.mes, '<正文>重复。第二句。结束。</正文><状态栏>重复。</状态栏>');
});

test('重复独立段落或无法对应的显示顺序保持原文', async () => {
    const f = fixture('<正文><p>重复。</p><p>重复。</p></正文>', '<p>重复。</p><p>重复。</p>', { whitelist: '正文' });
    const r = await f.commit([[2, '第二句。']]);
    assert.equal(r.applied, 0); assert.match(r.entries[0].reason, /重复/);
    assert.equal(f.saves, 0);
});

test('保留静态内联元素与其 Text 节点，不移除被清空的包装', async () => {
    const f = fixture('他很愤怒。', '<p><q>他很</q><em>愤怒。</em></p>');
    const elements = Array.from(f.container.querySelectorAll('*'));
    const nodes = elements.filter(el => el.firstChild?.nodeType === 3).map(el => el.firstChild);
    const r = await f.commit([[1, '他攥紧拳头。']]);
    assert.equal(r.applied, 1);
    assert.deepEqual(Array.from(f.container.querySelectorAll('*')), elements);
    assert.equal(nodes[0].data, '他攥紧拳头。'); assert.equal(nodes[1].data, '');
    assert.ok(nodes.every(node => node.isConnected));
});

test('静态正文与 iframe/动态区域相邻时只修改静态正文', async () => {
    const f = fixture('<正文>甲。</正文><正文>乙。</正文>', '<p>甲。</p><div class="TH-render"><iframe></iframe><p>乙。</p></div>', { whitelist: '正文' });
    const widget = f.container.querySelector('.TH-render');
    const before = widget.innerHTML;
    const r = await f.commit([[1, '新甲。'], [2, '新乙。']]);
    assert.equal(r.applied, 1); assert.equal(r.preview, 1);
    assert.equal(f.msg.mes, '<正文>新甲。</正文><正文>乙。</正文>');
    assert.equal(widget.innerHTML, before);
    assert.equal(r.entries[1].status, 'preview');
});

test('iframe 内独立正文不自动写回，也不触发重渲染', async () => {
    const f = fixture('<正文>原句。</正文>', '<iframe></iframe>', { whitelist: '正文' });
    const iframe = f.container.querySelector('iframe');
    iframe.contentDocument.body.textContent = '原句。';
    const r = await f.commit([[1, '新句。']]);
    assert.equal(r.applied, 0); assert.match(r.entries[0].reason, /iframe/);
    assert.equal(iframe.contentDocument.body.textContent, '原句。'); assert.equal(f.saves, 0);
});

test('状态、表单、隐藏元素和 Vue/React 根不会作为正文目标', () => {
    const f = fixture('原句。', '<div class="status-card">原句。</div><button>原句。</button><p hidden>原句。</p><div id="vue"><p>原句。</p></div><div id="react">原句。</div>');
    f.container.querySelector('#vue').__vue_app__ = {};
    f.container.querySelector('#react').__reactFiber123 = {};
    assert.equal(collectRewriteTextGroups(f.container).length, 0);
});

test('不同段落和受保护组件不能被拼接成一次匹配', async () => {
    for (const html of ['<p>他很</p><p>愤怒。</p>', '<p>他很<button>按钮</button>愤怒。</p>']) {
        const f = fixture('他很愤怒。', html);
        assert.equal((await f.commit([[1, '新句。']])).applied, 0);
    }
});

test('普通段落与 CRLF 换行使用源位置，保留原换行字节', async () => {
    const f = fixture('甲。\r\n乙。\r\n\r\n丙。', '<p>甲。<br>乙。</p><p>丙。</p>');
    const r = await f.commit([[2, '新乙。'], [3, '新丙。']]);
    assert.equal(r.applied, 2);
    assert.equal(f.msg.mes, '甲。\r\n新乙。\r\n\r\n新丙。');
});

test('删除共用安全补丁，只删正文并保留前端实例', async () => {
    const f = fixture('<正文>甲。乙。</正文><状态栏>甲。</状态栏>', '<p>甲。乙。</p><div class="status-card">甲。</div>', { whitelist: '正文' });
    const node = f.container.querySelector('p').firstChild;
    const r = await f.commit([[1, '']], { action: 'delete' });
    assert.equal(r.applied, 1); assert.equal(node.data, '乙。');
    assert.equal(f.msg.mes, '<正文>乙。</正文><状态栏>甲。</状态栏>');
    assert.equal(f.msg.extra.titania_delete_done, true);
});

test('聊天、消息对象、原文或 swipe 改变后拒绝旧模型结果', async () => {
    const mutations = [
        f => f.setContext({ ...f.ctx, chatId: 'chatB' }),
        f => f.setContext({ ...f.ctx, chat: [...f.ctx.chat] }),
        f => f.ctx.chat[0] = { ...f.msg },
        f => f.msg.mes = '用户的新编辑。',
        f => f.msg.swipe_id = 1,
    ];
    for (const mutate of mutations) {
        const f = fixture('原句。', '<p>原句。</p>'); mutate(f);
        const before = f.msg.mes;
        assert.equal((await f.commit([[1, '新句。']])).applied, 0);
        assert.equal(f.msg.mes, before); assert.equal(f.saves, 0);
    }
});

test('楼层缺失或重新挂载时只保留预览', async () => {
    for (const detach of [f => f.container.remove(), f => f.setDisplay(f.container.cloneNode(true))]) {
        const f = fixture('原句。', '<p>原句。</p>'); detach(f);
        const r = await f.commit([[1, '新句。']]);
        assert.equal(r.applied, 0); assert.equal(f.msg.mes, '原句。'); assert.equal(f.saves, 0);
    }
});

test('生成期间禁止提交', async () => {
    const f = fixture('原句。', '<p>原句。</p>');
    const r = await f.commit([[1, '新句。']], { isGenerating: () => true });
    assert.equal(r.applied, 0); assert.match(r.entries[0].reason, /正在生成/);
});

test('只更新活动 swipe 和镜像缓存，保留其他 swipe 与所有其他字段', async () => {
    const raw = '<正文>原句。</正文>';
    const f = fixture(raw, '<p>原句。</p>', { whitelist: '正文', message: {
        message: raw, swipe_id: 1, swipes: ['旧 swipe', raw],
        extra: { display_text: raw, custom: { value: 12 } },
        swipe_info: [{ extra: { display_text: '旧缓存' } }, { extra: { display_text: raw, owned: true } }],
    } });
    const custom = f.msg.extra.custom;
    const r = await f.commit([[1, '新句。']]);
    assert.equal(r.applied, 1); assert.deepEqual(f.msg.swipes, ['旧 swipe', '<正文>新句。</正文>']);
    assert.equal(f.msg.message, f.msg.mes); assert.equal(f.msg.extra.display_text, f.msg.mes);
    assert.equal(f.msg.swipe_info[1].extra.display_text, f.msg.mes);
    assert.equal(f.msg.swipe_info[0].extra.display_text, '旧缓存');
    assert.equal(f.msg.extra.custom, custom); assert.equal(f.msg.swipe_info[1].extra.owned, true);
});

test('无效 swipe、来源别名分歧或独立显示缓存禁止提交', async () => {
    const cases = [
        { swipe_id: -1, swipes: ['原句。'] },
        { swipes: ['原句。'] },
        { swipe_id: 0, swipes: ['不同内容。'] },
        { message: '不同内容。' },
        { extra: { display_text: '<p>独立缓存</p>' } },
        { swipe_id: 0, swipes: ['原句。'], swipe_info: [{ extra: { display_text: '独立缓存' } }] },
    ];
    for (const message of cases) {
        const f = fixture('原句。', '<p>原句。</p>', { message });
        const before = clone(f.msg);
        assert.equal((await f.commit([[1, '新句。']])).applied, 0);
        assert.deepEqual(f.msg, before);
    }
});

test('null 显示缓存仍使用原文，保持缓存原状', async () => {
    const f = fixture('原句。', '<p>原句。</p>', { message: { extra: { display_text: null } } });
    assert.equal((await f.commit([[1, '新句。']])).applied, 1);
    assert.equal(f.msg.extra.display_text, null);
});

test('保存失败恢复原文、显示节点和本插件标记，保留第三方数据', async () => {
    const f = fixture('原句。', '<p>原句。</p>', { message: { extra: { custom: 3, titania_rewrite_done: false } } });
    const node = f.container.querySelector('p').firstChild;
    const before = clone(f.msg);
    const r = await f.commit([[1, '新句。']], { persist: async () => { throw new Error('disk'); } });
    assert.equal(r.applied, 0); assert.match(r.entries[0].reason, /保存/);
    assert.deepEqual(f.msg, before); assert.equal(node.data, '原句。'); assert.equal(f.notifications, 0);
});

test('回滚保留原来缺失或空值的 extra 字段形态', async () => {
    for (const message of [{}, { extra: null }, { extra: undefined }]) {
        const f = fixture('原句。', '<p>原句。</p>', { message });
        const had = Object.hasOwn(f.msg, 'extra');
        const original = f.msg.extra;
        await f.commit([[1, '新句。']], { persist: async () => { throw new Error('save'); } });
        assert.equal(Object.hasOwn(f.msg, 'extra'), had);
        assert.equal(f.msg.extra, original);
    }
});

test('保存期间出现用户新编辑，回滚不覆盖新内容', async () => {
    const f = fixture('原句。', '<p>原句。</p>');
    const node = f.container.querySelector('p').firstChild;
    const r = await f.commit([[1, '新句。']], { persist: async () => {
        f.msg.mes = '用户新编辑。'; node.data = '用户新编辑。';
        f.msg.extra.custom = 7;
        throw new Error('changed');
    } });
    assert.equal(r.applied, 0); assert.equal(f.msg.mes, '用户新编辑。'); assert.equal(node.data, '用户新编辑。');
    assert.equal(f.msg.extra.custom, 7);
});

test('通知失败不撤销已保存的改写和 Diff 状态', async () => {
    const f = fixture('原句。', '<p>原句。</p>');
    const r = await f.commit([[1, '新句。']], { notify: async () => { throw new Error('listener'); } });
    assert.equal(r.applied, 1); assert.equal(r.entries[0].status, 'applied');
    assert.equal(f.msg.mes, '新句。'); assert.equal(r.notificationError, 'listener');
});

test('宿主吞掉保存错误时，回读能发现失败并保存恢复原文', async () => {
    const f = fixture('原句。', '<p>原句。</p>');
    let disk = [{ chat_metadata: {} }, clone(f.msg)];
    let calls = 0;
    const host = {
        getContext: () => f.ctx, getHeaders: () => ({}),
        save: async () => { if (++calls > 1) disk = [{ chat_metadata: {} }, clone(f.msg)]; },
        fetch: async () => ({ ok: true, json: async () => disk }),
    };
    const r = await f.commit([[1, '新句。']], {
        persist: (target, text) => persistRewriteTarget(target, text, host),
        restore: target => persistRewriteTarget(target, target.projection.raw, host),
    });
    assert.equal(r.applied, 0); assert.equal(calls, 2); assert.equal(disk[1].mes, '原句。');
});

test('回读验证正确楼层与 swipe，支持单聊和群聊', async () => {
    for (const group of [false, true]) {
        const f = fixture('原句。', '<p>原句。</p>', { message: { swipe_id: 0, swipes: ['原句。'] } });
        if (group) { f.ctx.groupId = 'groupA'; f.target.key = JSON.stringify([f.ctx.chatId, f.ctx.groupId, f.ctx.characters[0].avatar]); }
        let disk;
        const host = {
            getContext: () => f.ctx, getHeaders: () => ({ token: 'test' }),
            save: async () => { disk = [{ chat_metadata: {} }, clone(f.msg)]; },
            fetch: async (url, options) => {
                assert.equal(url, group ? '/api/chats/group/get' : '/api/chats/get');
                const body = JSON.parse(options.body);
                assert.equal(group ? body.id : body.file_name, 'chatA');
                return { ok: true, json: async () => disk };
            },
        };
        assert.equal((await f.commit([[1, '新句。']], { persist: (target, text) => persistRewriteTarget(target, text, host) })).applied, 1);
    }
});

test('相同结果不保存也不设置自动完成标记', async () => {
    const f = fixture('原句。', '<p>原句。</p>');
    const r = await f.commit([[1, '原句。']]);
    assert.equal(r.entries[0].status, 'unchanged'); assert.equal(r.applied, 0); assert.equal(f.saves, 0);
    assert.equal(f.msg.extra, undefined);
});
