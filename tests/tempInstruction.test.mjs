import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 加载 tempInstruction.js。
 *
 * 它刻意零 import（理由见该文件头），所以这里不需要 cleaning.test.mjs 那样的
 * stub 表 —— 链接时不会向宿主求任何东西。这条"零依赖"本身也是被测契约的一部分：
 * 一旦有人给它加了 import，下面第一个用例的加载就会当场失败。
 */
async function loadModule() {
    const context = vm.createContext({ console, String, Object, Boolean, JSON, Math, Date });
    const modules = new Map();
    const moduleFor = id => {
        if (!modules.has(id)) modules.set(id, new vm.SourceTextModule(readFileSync(id, 'utf8'), { context, identifier: id }));
        return modules.get(id);
    };
    const entry = moduleFor(path.join(project, 'src/core/tempInstruction.js'));
    if (entry.status === 'unlinked') await entry.link((specifier, ref) => moduleFor(path.resolve(path.dirname(ref.identifier), specifier)));
    if (entry.status === 'linked') await entry.evaluate();
    return entry.namespace;
}

const m = await loadModule();
const {
    TEMP_INSTRUCTION_HEADER,
    buildTempInstructionBlock,
    isTempInstructionGenerationSource,
    isTempInstructionFeatureEnabled,
    getTempInstructionDraft,
    setTempInstructionDraft,
    getActiveTempInstruction,
    hasActiveTempInstruction,
    getActiveTempInstructionScriptId,
    consumeTempInstruction,
    takeActiveTempInstruction,
    clearActiveTempInstruction,
    clearTempInstruction
} = m;

const BODY = '这次让主角保持沉默，只写环境。';

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

test('空输入不产出空段', () => {
    // 空串会让 sectionLengths 多出一段零长切片，查看器里表现为一段无名空条
    for (const empty of ['', '   ', '\n\t ', null, undefined]) {
        assert.equal(buildTempInstructionBlock(empty), '', `输入 ${JSON.stringify(empty)} 应产出空串`);
    }
});

test('普通口径的块结构', () => {
    const block = buildTempInstructionBlock(BODY);
    assert.equal(block, `\n\n${TEMP_INSTRUCTION_HEADER}\n（在上述剧本基础上，本次创作额外遵循以下要求；与上文冲突时以本节为准）\n${BODY}`);
});

test('续写口径换掉"在上述剧本基础上"这半句', () => {
    // 主动续写时剧本正文根本不在提示词里，沿用它就是假话
    const block = buildTempInstructionBlock(BODY, { continuation: true });
    assert.ok(block.includes('续写'), '续写口径应说明本次续写');
    assert.ok(!block.includes('在上述剧本基础上'), '续写口径不得声称"在上述剧本基础上"');
    assert.ok(block.includes(BODY), '原文必须原样保留');
});

test('原文两端空白被裁掉，块尾不留空白', () => {
    // 查看器按累计长度连续切片：块尾多一个空格，后面所有分段就全错位
    const block = buildTempInstructionBlock(`\n  ${BODY}  \n`);
    assert.equal(block, buildTempInstructionBlock(BODY));
    assert.equal(block, block.trimEnd());
    assert.ok(block.endsWith(BODY), '块尾必须恰好是原文，无尾随空白');
});

test('块长等于它在正文末尾新增的字节数', () => {
    // sectionLengths.tempInstruction 记的是 block.length，而 user 串末尾追加的
    // 也是这同一个串 —— 两者必须逐字符对齐，否则切片错位
    const body = '原有的剧本正文';
    const block = buildTempInstructionBlock(BODY);
    assert.equal(body.length + block.length, (body + block).length);
});

/* ------------------------------------------------------------------ *
 * 生成来源守卫
 * ------------------------------------------------------------------ */

test('只有手动演绎与主动续写允许携带', () => {
    assert.equal(isTempInstructionGenerationSource('manual'), true);
    assert.equal(isTempInstructionGenerationSource('user_continuation'), true);
    // 队列批量与 ST 事件自动演绎都是 silent=true → source 为 queue
    assert.equal(isTempInstructionGenerationSource('queue'), false);
    assert.equal(isTempInstructionGenerationSource('preview'), false);
    assert.equal(isTempInstructionGenerationSource(''), false);
    assert.equal(isTempInstructionGenerationSource(undefined), false);
});

/* ------------------------------------------------------------------ *
 * 功能总开关
 * ------------------------------------------------------------------ */

test('功能开关默认开启，只有显式 false 才算关', () => {
    // 默认开启的既有功能：老用户设置里没有这个键，getExtData 不深合并 → undefined，
    // 必须仍判成开启，否则他们一直在用的输入框会被静默抹掉
    assert.equal(isTempInstructionFeatureEnabled(undefined), true, '整个 data 缺失 → 开启');
    assert.equal(isTempInstructionFeatureEnabled({}), true, '没有 temp_instruction 键 → 开启');
    assert.equal(isTempInstructionFeatureEnabled({ temp_instruction: {} }), true, '有键无 enabled → 开启');
    assert.equal(isTempInstructionFeatureEnabled({ temp_instruction: { enabled: true } }), true);
    assert.equal(isTempInstructionFeatureEnabled({ temp_instruction: { enabled: false } }), false, '显式 false 才关');
});

/* ------------------------------------------------------------------ *
 * 状态机
 * ------------------------------------------------------------------ */

test('草稿读写会 trim', () => {
    setTempInstructionDraft('  abc  ');
    assert.equal(getTempInstructionDraft(), 'abc');
    setTempInstructionDraft('');
    assert.equal(getTempInstructionDraft(), '');
});

test('consume 把草稿变成已生效快照并清空草稿', () => {
    clearTempInstruction();
    setTempInstructionDraft(BODY);
    const applied = consumeTempInstruction('script-a');

    assert.equal(applied, BODY);
    assert.equal(getTempInstructionDraft(), '', '用完必须自动清空草稿');
    assert.equal(getActiveTempInstruction('script-a'), BODY);
    assert.equal(hasActiveTempInstruction('script-a'), true);
    assert.equal(getActiveTempInstructionScriptId(), 'script-a');
});

test('快照只认它自己的剧本', () => {
    clearTempInstruction();
    setTempInstructionDraft(BODY);
    consumeTempInstruction('script-a');

    // 换剧本 / 翻到别的剧本的稿子上续写，都必须拿不到
    assert.equal(getActiveTempInstruction('script-b'), '');
    assert.equal(hasActiveTempInstruction('script-b'), false);
    assert.equal(getActiveTempInstruction(''), '');
});

test('空草稿 consume 出空快照（= 重演丢弃快照）', () => {
    clearTempInstruction();
    setTempInstructionDraft(BODY);
    consumeTempInstruction('script-a');
    // 重演时草稿已被上次消费清空 → 快照被置空，正好是"重新演绎丢弃快照"
    assert.equal(consumeTempInstruction('script-a'), '');
    assert.equal(getActiveTempInstruction('script-a'), '');
    assert.equal(getActiveTempInstructionScriptId(), '');
});

test('take 取出即清除（撤销）', () => {
    clearTempInstruction();
    setTempInstructionDraft(BODY);
    consumeTempInstruction('script-a');

    // 逐字段比：沙箱对象与测试进程不同 realm，deepStrictEqual 会因原型不同而失败
    const taken = takeActiveTempInstruction();
    assert.equal(taken?.scriptId, 'script-a');
    assert.equal(taken?.text, BODY);
    assert.equal(getActiveTempInstruction('script-a'), '', '撤销后快照必须消失');
    assert.equal(takeActiveTempInstruction(), null, '没有快照时返回 null，调用方据此不必撤销');
});

test('clearActive 只清快照、不动草稿', () => {
    clearTempInstruction();
    setTempInstructionDraft(BODY);
    consumeTempInstruction('script-a');
    setTempInstructionDraft('新写的');
    clearActiveTempInstruction();

    assert.equal(getActiveTempInstruction('script-a'), '');
    assert.equal(getTempInstructionDraft(), '新写的', '清快照不该顺手把用户正在打的字弄没');
});

test('clearTempInstruction 草稿与快照一起清（换剧本）', () => {
    setTempInstructionDraft(BODY);
    consumeTempInstruction('script-a');
    setTempInstructionDraft('半截');
    clearTempInstruction();

    assert.equal(getTempInstructionDraft(), '');
    assert.equal(getActiveTempInstruction('script-a'), '');
    assert.equal(getActiveTempInstructionScriptId(), '');
});

test('无 scriptId 时不留下永不匹配的死快照', () => {
    clearTempInstruction();
    setTempInstructionDraft(BODY);
    assert.equal(consumeTempInstruction(''), '');
    assert.equal(getActiveTempInstructionScriptId(), '');
});
