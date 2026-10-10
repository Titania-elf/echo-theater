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

/** 加载 storyOutlineWindow.js，7 个带宿主依赖的 import 全换成桩——parsePacingResponse 是纯逻辑，运行时不碰它们。 */
async function loadStoryOutline() {
    const context = vm.createContext({ console, String, Number, Boolean, Math, JSON, Array, Object });
    const uiPath = path.join(project, 'src/ui');
    const stubs = new Map([
        [path.join(project, 'src/core/context.js'), 'export const getContextData = async () => ({});'],
        [path.join(project, 'src/core/connection.js'), 'export const sendChatRequestWithConnection = async () => ""; export const getConnectionByProfileId = () => null; export const getActiveConnection = () => null;'],
        [path.join(project, 'src/core/apiProfileRegistry.js'), 'export const normalizeApiBaseUrl = u => u; export const normalizeRewriteCustomProfiles = p => p;'],
        [path.join(project, 'src/utils/dom.js'), 'export const ensureFeatureCss = () => {};'],
        [path.join(project, 'src/utils/storage.js'), 'export const getExtData = () => ({}); export const saveExtData = () => {};'],
        [path.join(project, 'src/utils/chatTagWhitelist.js'), 'export const parseTagWhitelistInput = () => []; export const extractTextByWhitelist = t => t;'],
        [path.join(uiPath, 'shared/apiConnectionEditor.js'), 'export const createApiConnectionEditor = () => ({}); export const mapConnectionProfilesToCustomProfiles = p => p; export const mapCustomProfilesToConnectionProfiles = p => p; export const renderApiConnectionEditorHTML = () => "";'],
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

test('面板接线：bubble 引入 pacingInjection 并武装指令', () => {
    const src = read('src/ui/sceneAdvanceBubble.js');
    assert.ok(src.includes('from "../core/pacingInjection.js"'), 'bubble 必须引入注入模块');
    assert.ok(src.includes('armPacingDirective'), '应用按钮要武装指令');
    assert.ok(src.includes('generatePacingAssessment'), '分析按钮要调判断');
});
