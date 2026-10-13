import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(path.join(project, rel), 'utf8');

/**
 * 加载 pacingInjection.js，把 script.js（ST 宿主）与 logger 换成桩。
 * setExtensionPrompt 的每次调用记进 context 全局 __calls，供断言检查注入参数。
 */
async function loadPacingInjection() {
    const calls = [];
    const context = vm.createContext({ console, String, Number, Boolean, Math, JSON, __calls: calls });
    const scriptStub = `
        export const extension_prompt_types = { NONE:-1, IN_PROMPT:0, IN_CHAT:1, BEFORE_PROMPT:2 };
        export const extension_prompt_roles = { SYSTEM:0, USER:1, ASSISTANT:2 };
        export function setExtensionPrompt(key, value, position, depth, scan, role) {
            __calls.push({ key, value, position, depth, role });
        }
        export const eventSource = { on() {} };
        export const event_types = { GENERATION_ENDED: 'g', CHAT_CHANGED: 'c' };`;
    const corePath = path.join(project, 'src/core');
    const stubs = new Map([
        [path.resolve(corePath, '../../../../script.js'), scriptStub],
        [path.join(corePath, 'logger.js'), 'export const TitaniaLogger = { info(){}, warn(){}, error(){} };'],
    ]);
    const modules = new Map();
    const moduleFor = id => {
        if (!modules.has(id)) modules.set(id, new vm.SourceTextModule(stubs.get(id) ?? readFileSync(id, 'utf8'), { context, identifier: id }));
        return modules.get(id);
    };
    const entry = moduleFor(path.join(corePath, 'pacingInjection.js'));
    if (entry.status === 'unlinked') await entry.link((specifier, ref) => moduleFor(path.resolve(path.dirname(ref.identifier), specifier)));
    if (entry.status === 'linked') await entry.evaluate();
    return { ns: entry.namespace, calls };
}

/**
 * 加载 storyOutlineWindow.js，7 个带宿主依赖的 import 全换成桩——parsePacingResponse 是纯逻辑，运行时不碰它们。
 *
 * @param {{chat?: object[], extData?: object}} [opts]
 *        chat 传了才桩出 SillyTavern（读楼层的函数据此走真实分支）；不传则全局没有
 *        SillyTavern，那些函数按"无上下文"返回空——这正是老用例依赖的行为。
 */
async function loadStoryOutline(opts = {}) {
    const context = vm.createContext({
        console, String, Number, Boolean, Math, JSON, Array, Object,
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

/* ------------------------------------------------------------------ *
 * 一次性注入（pacingInjection）—— 行为
 * ------------------------------------------------------------------ */

test('武装：按 IN_CHAT 深度注入，内容带表头、角色按配置映射', async () => {
    const { ns, calls } = await loadPacingInjection();
    const ok = ns.armPacingDirective("本次放慢节奏", { depth: 2, role: "user" });
    assert.equal(ok, true);
    const last = calls.at(-1);
    assert.equal(last.position, 1, 'position 必须是 extension_prompt_types.IN_CHAT');
    assert.equal(last.depth, 2);
    assert.equal(last.role, 1, 'role=user → 1');
    assert.ok(last.value.startsWith("【叙事节奏提示】"), '注入内容必须带表头，和剧情正文区分');
    assert.ok(last.value.includes("本次放慢节奏"));
    assert.equal(ns.getArmedPacing().armed, true);
});

test('非法角色归 system、负深度归 0', async () => {
    const { ns, calls } = await loadPacingInjection();
    ns.armPacingDirective("x", { depth: -5, role: "wizard" });
    const last = calls.at(-1);
    assert.equal(last.role, 0, '未知角色 → system(0)');
    assert.equal(last.depth, 0, '负深度 → 0');
});

test('空指令等价于清除，返回 false', async () => {
    const { ns, calls } = await loadPacingInjection();
    const ok = ns.armPacingDirective("   ", {});
    assert.equal(ok, false);
    assert.equal(calls.at(-1).value, "", '清除就是把 value 置空串');
    assert.equal(ns.getArmedPacing().armed, false);
});

test('清除：置空注入并解除武装', async () => {
    const { ns, calls } = await loadPacingInjection();
    ns.armPacingDirective("先武装", {});
    ns.clearPacingDirective();
    const last = calls.at(-1);
    assert.equal(last.value, "");
    assert.equal(last.position, 1, '清除也走 IN_CHAT 通道');
    assert.equal(ns.getArmedPacing().armed, false);
});

/* ------------------------------------------------------------------ *
 * 判断解析（parsePacingResponse）—— 纯逻辑
 * ------------------------------------------------------------------ */

test('解析合法返回', async () => {
    const ns = await loadStoryOutline();
    const r = ns.parsePacingResponse(JSON.stringify({
        pacing_state: "拖沓", assessment: "原地打转", directive: "加快推进", focus: "推进场景", intensity: 4
    }));
    assert.equal(r.pacingState, "拖沓");
    assert.equal(r.directive, "加快推进");
    assert.equal(r.focus, "推进场景");
    assert.equal(r.intensity, 4);
});

test('directive 为空直接抛错', async () => {
    const ns = await loadStoryOutline();
    assert.throws(() => ns.parsePacingResponse(JSON.stringify({ pacing_state: "平稳", directive: "   " })));
    assert.throws(() => ns.parsePacingResponse("not json"));
});

test('非法 state 归平稳、intensity 夹到 1-5、缺字段容错', async () => {
    const ns = await loadStoryOutline();
    const r = ns.parsePacingResponse(JSON.stringify({ pacing_state: "飞快", directive: "d", intensity: 99 }));
    assert.equal(r.pacingState, "平稳");
    assert.equal(r.intensity, 5);
    assert.equal(r.focus, "");
    const r2 = ns.parsePacingResponse(JSON.stringify({ directive: "d", intensity: -3 }));
    assert.equal(r2.intensity, 1);
});

/* ------------------------------------------------------------------ *
 * 最近 N 层窗口（collectRecentChatText）—— 纯逻辑，靠桩出的 chat 驱动
 * ------------------------------------------------------------------ */

/** 5 楼聊天：0 开场 / 1 用户 / 2 角色 / 3 用户（空正文）/ 4 角色。 */
const CHAT_5 = [
    { mes: "开场白" },
    { mes: "用户说", is_user: true },
    { mes: "角色回复一" },
    { mes: "", is_user: true },
    { mes: "角色回复二" },
];

test('窗口按楼层切：抽不出正文的楼层占位，不从更早的楼层顶替', async () => {
    const ns = await loadStoryOutline({ chat: CHAT_5 });
    const text = ns.collectRecentChatText(2);
    assert.ok(text.includes("角色回复二"), '最新一楼必须在窗口里');
    assert.ok(text.includes("（本楼无可用正文）"), '滤空的第 3 楼要留占位，让模型知道这里有一层');
    assert.equal(text.includes("角色回复一"), false, '窗口只有 2 层，第 2 楼不能被顶替进来');
    assert.equal(text.includes("开场白"), false);
});

test('窗口不因隐藏/空楼层而变长：N 就是实际下发的最远楼层数', async () => {
    const ns = await loadStoryOutline({ chat: CHAT_5 });
    // 2 层 → 2 行（一行占位一行正文），不是"抽到 2 条正文为止"
    assert.equal(ns.collectRecentChatText(2).split("\n\n").length, 2);
    assert.equal(ns.collectRecentChatText(3).split("\n\n").length, 3);
});

test('withFloors 带上酒馆楼层号（盲盒导演据此回报 evidence_floor）', async () => {
    const ns = await loadStoryOutline({ chat: CHAT_5 });
    const text = ns.collectRecentChatText(2, { withFloors: true });
    assert.ok(text.includes("【#3 用户】"), '楼层号必须是对原始 chat 下标，不是窗口内序号');
    assert.ok(text.includes("【#4 角色】角色回复二"));
});

test('隐藏楼层计入窗口：includeHidden=false 时占位不读正文', async () => {
    const hiddenChat = [
        { mes: "真正文" },
        { mes: "摘要", is_system: true },
    ];
    const ns = await loadStoryOutline({ chat: hiddenChat });
    assert.equal(ns.collectRecentChatText(2, { includeHidden: true }), "【角色】真正文\n\n【背景】摘要");
    const off = ns.collectRecentChatText(2, { includeHidden: false });
    assert.equal(off.includes("摘要"), false, '不读隐藏楼层时正文不能漏出来');
    assert.equal(off.split("\n\n").length, 2, '但楼层仍要占位，窗口长度不变');
});

test('0 或不传楼层数＝不读正文', async () => {
    const ns = await loadStoryOutline({ chat: CHAT_5 });
    assert.equal(ns.collectRecentChatText(0), "");
    assert.equal(ns.collectRecentChatText(undefined), "");
});

test('没有 SillyTavern 上下文时返回空串，不抛错', async () => {
    const ns = await loadStoryOutline();
    assert.equal(ns.collectRecentChatText(3), "");
});

/* ------------------------------------------------------------------ *
 * 剧情推进的参考文本（getRollingOpeningText）—— 永远是"最新一条角色回复"
 * ------------------------------------------------------------------ */

test('参考文本取最新一条角色回复，用户楼层与隐藏楼层都跳过', async () => {
    const ns = await loadStoryOutline({
        chat: [
            { mes: "开场白" },
            { mes: "用户说", is_user: true },
            { mes: "角色回复一" },
            { mes: "导演写的一小段", is_system: true },
            { mes: "用户又说", is_user: true },
            { mes: "角色回复二" },
        ],
    });
    assert.equal(ns.getRollingOpeningText(), "角色回复二");
});

test('只有开场白时退回那一楼，不会空手交给模型', async () => {
    const ns = await loadStoryOutline({ chat: [{ mes: "开场白" }] });
    assert.equal(ns.getRollingOpeningText(), "开场白");
});

test('空聊天且无角色卡信息时返回空串，绝不抛错（不再有"未选择参考来源，已取消生成"）', async () => {
    const ns = await loadStoryOutline({ chat: [] });
    assert.equal(ns.getRollingOpeningText(), "");
    const noCtx = await loadStoryOutline();
    assert.equal(noCtx.getRollingOpeningText(), "");
});

/* ------------------------------------------------------------------ *
 * 接线契约（源码文本）
 * ------------------------------------------------------------------ */

test('pacingInjection 只依赖 ST 宿主（script.js）与 logger', () => {
    const src = read('src/core/pacingInjection.js');
    const imports = [...src.matchAll(/^\s*import\s[\s\S]*?from\s+["']([^"']+)["']/gm)].map(m => m[1]);
    assert.deepEqual(imports.sort(), ["../../../../script.js", "./logger.js"].sort());
});

test('节奏判断不触发开场白选择器（buildPacingPrompt 不碰 ensureOpeningTextForGeneration）', () => {
    const src = read('src/ui/storyOutlineWindow.js');
    const start = src.indexOf('function buildPacingPrompt');
    const end = src.indexOf('function parsePacingResponse');
    assert.ok(start >= 0 && end > start);
    assert.equal(src.slice(start, end).includes('ensureOpeningTextForGeneration'), false,
        'buildPacingPrompt 绝不能调开场白解析——那正是会弹选择器的入口');
});

test('剧情推进不弹选择器：generateRecommendations 用 resolveOpening＝最新回复', () => {
    const src = read('src/ui/storyOutlineWindow.js');
    const start = src.indexOf('async function generateRecommendations');
    const end = src.indexOf('async function generateOutline(');
    assert.ok(start >= 0 && end > start);
    const body = src.slice(start, end);
    assert.ok(body.includes('resolveOpening: getRollingOpeningText'),
        '剧情推荐必须绕开开场白/楼层选择器，否则点「推荐剧情」会弹「选择聊天记录参考来源」');
    assert.equal(body.includes('ensureOpeningTextForGeneration'), false);
});

test('runGenerationFlow 缺省仍走开场白解析，只有显式传 resolveOpening 才绕开', () => {
    const src = read('src/ui/storyOutlineWindow.js');
    const start = src.indexOf('async function runGenerationFlow');
    const end = src.indexOf('/* ================================================================== *', start);
    assert.ok(start >= 0 && end > start);
    const body = src.slice(start, end);
    assert.ok(body.includes('typeof cfg.resolveOpening === "function"'));
    assert.ok(body.includes(': ensureOpeningTextForGeneration'),
        '大纲生成/盲盒剧本生成没传 resolveOpening，必须继续走原来的（可选楼层）路径');
});

test('面板接线：bubble 引入 pacingInjection 并武装指令', () => {
    const src = read('src/ui/sceneAdvanceBubble.js');
    assert.ok(src.includes('from "../core/pacingInjection.js"'), 'bubble 必须引入注入模块');
    assert.ok(src.includes('armPacingDirective'), '应用按钮要武装指令');
    assert.ok(src.includes('generatePacingAssessment'), '分析按钮要调判断');
});
