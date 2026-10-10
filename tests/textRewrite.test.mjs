import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = await import(pathToFileURL(path.join(project, 'src/core/textRewriteCore.js')).href);

const {
    splitBySentence, splitByParagraph, splitText,
    matchKeywordRule, normalizeDeleteMode,
    applyDeletesToUnit, applyReplacements,
    evaluateDeleteRules, buildDeleteReplacements, evaluateRewriteRules,
    splitLegacyRules,
} = core;

test('splitBySentence 按中文句末标点切分，保留标点', () => {
    assert.deepEqual(splitBySentence('他来了。她走了！'), ['他来了。', '她走了！']);
    assert.deepEqual(splitBySentence(''), []);
});

test('splitByParagraph 按空行切分', () => {
    assert.deepEqual(splitByParagraph('第一段\n\n第二段'), ['第一段', '第二段']);
    assert.equal(splitText('a。b。', 'sentence').length, 2);
    assert.equal(splitText('x\n\ny', 'paragraph').length, 2);
});

test('matchKeywordRule 要求主词与附加词各命中其一', () => {
    const rule = { anchor: '笑, 哭', extras: '声, 眼泪' };
    assert.equal(matchKeywordRule('他的笑声很响', rule), true);   // 笑 + 声
    assert.equal(matchKeywordRule('他微笑着', rule), false);       // 有主词无附加词
    assert.equal(matchKeywordRule('一片眼泪', rule), false);       // 有附加词无主词
    assert.equal(matchKeywordRule('x', { anchor: '', extras: 'a' }), false);
});

test('applyDeletesToUnit 整句删除返回空串', () => {
    assert.equal(applyDeletesToUnit('整句删掉。', 'sentence'), '');
});

test('applyDeletesToUnit 片段删除：从片段删到句尾并保留句末标点', () => {
    assert.equal(applyDeletesToUnit('他笑了，那笑声像碎玻璃一样脆。', 'fragment', '那笑声像'), '他笑了。');
});

test('applyDeletesToUnit 片段不在句内则原样返回', () => {
    assert.equal(applyDeletesToUnit('他笑了。', 'fragment', '不存在'), '他笑了。');
});

test('applyDeletesToUnit 闭引号收尾时不重复终止符', () => {
    assert.equal(applyDeletesToUnit('“走吧。”那笑声像铃。', 'fragment', '那笑声像'), '“走吧。”');
});

test('normalizeDeleteMode 兼容旧 action 名', () => {
    assert.equal(normalizeDeleteMode('delete_range'), 'fragment');
    assert.equal(normalizeDeleteMode('delete'), 'sentence');
    assert.equal(normalizeDeleteMode(''), 'sentence');
});

test('applyReplacements 按出现顺序游标推进，不重复消费', () => {
    const { text, replaced } = applyReplacements('AA BB AA', [
        { before: 'AA', after: 'X' },
        { before: 'BB', after: 'Y' },
    ]);
    // 只替换首个 AA 与 BB（游标推进后第二个 AA 不再被首条消费）
    assert.equal(replaced, 2);
    assert.equal(text, 'X Y AA');
});

test('evaluateDeleteRules + applyReplacements 做整句/片段删除', () => {
    const src = '他笑了，那笑声像玻璃一样脆。她哭了。无关句。';
    const rules = [
        { anchor: '笑', extras: '声', mode: 'fragment', fragment: '那笑声像', enabled: true },
        { anchor: '哭', extras: '她', mode: 'sentence', enabled: true },
    ];
    const result = evaluateDeleteRules(src, 'sentence', rules);
    assert.equal(result.hitCount, 2);
    const applied = applyReplacements(src, buildDeleteReplacements(result.deleteUnits));
    assert.equal(applied.text, '他笑了。无关句。');
});

test('evaluateDeleteRules 跳过未启用规则', () => {
    const rules = [{ anchor: '笑', extras: '声', mode: 'sentence', enabled: false }];
    assert.equal(evaluateDeleteRules('笑声。', 'sentence', rules).hitCount, 0);
});

test('evaluateRewriteRules 命中单元携带分类指导', () => {
    const categories = [{
        id: 'c1', name: '心理直述', guidance: '改白描', bad_example: '他很愤怒', good_example: '他攥紧拳头',
        rules: [{ anchor: '愤怒', extras: '他' }],
    }];
    const r = evaluateRewriteRules('他很愤怒。天气晴。', 'sentence', categories);
    assert.equal(r.hitCount, 1);
    assert.equal(r.categoryCount, 1);
    const hit = r.unitResults.find(u => u.hit);
    assert.equal(hit.matchedCategories[0].guidance, '改白描');
    assert.equal(hit.matchedCategories[0].good_example, '他攥紧拳头');
});

test('splitLegacyRules 把旧 action 规则分流到改写/删除两套', () => {
    const legacy = {
        schemes: [{
            id: 's1', name: '方案一', categories: [{
                id: 'c1', name: '分类一', guidance: 'g', bad_example: 'b', good_example: 'go',
                rules: [
                    { anchor: '笑', extras: '声', action: 'rewrite' },
                    { anchor: '哭', extras: '她', action: 'delete' },
                    { anchor: '走', extras: '他', action: 'delete_range', fragment: '那' },
                ],
            }],
        }],
    };
    const { rewriteSchemes, deletionRules } = splitLegacyRules(legacy);
    // 改写方案保留，分类只剩改写规则
    assert.equal(rewriteSchemes.length, 1);
    assert.equal(rewriteSchemes[0].categories[0].rules.length, 1);
    assert.equal(rewriteSchemes[0].categories[0].guidance, 'g');
    // 删除规则抽出两条，mode 映射正确
    assert.equal(deletionRules.length, 2);
    assert.equal(deletionRules.find(r => r.anchor === '哭').mode, 'sentence');
    const frag = deletionRules.find(r => r.anchor === '走');
    assert.equal(frag.mode, 'fragment');
    assert.equal(frag.fragment, '那');
});
