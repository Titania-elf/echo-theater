import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 只加载 helpers.js，用来测它的纯字符串清洗函数。
 *
 * 它顶层 import 了三个带宿主依赖的模块（storage / illustrationPortability /
 * chatHistoryBlacklist），这里整块换成桩 —— 被测的 sanitize* 是纯函数，
 * 运行时根本不碰它们，桩只需存在以便链接。
 */
async function loadHelpers() {
    const context = vm.createContext({ console, TextEncoder, JSON, Math, Date });
    const stubs = new Map([
        [path.join(project, 'src/utils/storage.js'), 'export const getExtData = () => ({});'],
        [path.join(project, 'src/core/illustrationPortability.js'), 'export const embedIllustrationsInHtml = async html => html;'],
        [path.join(project, 'src/utils/chatHistoryBlacklist.js'), 'export const parseChatHistoryBlacklistInput = () => []; export const removeChatHistoryBlacklist = html => html;'],
    ]);
    const modules = new Map();
    const moduleFor = id => {
        if (!modules.has(id)) modules.set(id, new vm.SourceTextModule(stubs.get(id) ?? readFileSync(id, 'utf8'), { context, identifier: id }));
        return modules.get(id);
    };
    const entry = moduleFor(path.join(project, 'src/utils/helpers.js'));
    if (entry.status === 'unlinked') await entry.link((specifier, ref) => moduleFor(path.resolve(path.dirname(ref.identifier), specifier)));
    if (entry.status === 'linked') await entry.evaluate();
    return entry.namespace;
}

const CARD = '<div class="card"><p>雨还在下。</p></div>';

test('the <小剧场> wrapper wins over the heuristic, so chatter around it cannot leak in', async () => {
    const helpers = await loadHelpers();

    // 最典型的失败：HTML 之前那句说明里恰好含 <div> 字样。启发式会把它当成正文起点。
    const wrapped = `好的，我用 <div> 做一个卡片：\n<小剧场>\n${CARD}\n</小剧场>\n希望你喜欢！`;
    assert.equal(helpers.sanitizeAIOutput(wrapped), CARD);

    // 同一份内容去掉外壳，启发式就露怯了 —— 这条对照说明外壳到底解决了什么。
    const bare = `好的，我用 <div> 做一个卡片：\n${CARD}\n希望你喜欢！`;
    assert.notEqual(helpers.sanitizeAIOutput(bare), CARD, '没有外壳时启发式会带上前面的说明');

    // 标签紧贴内容、带换行、带空白都要认。
    assert.equal(helpers.sanitizeAIOutput(`<小剧场>${CARD}</小剧场>`), CARD);
    assert.equal(helpers.sanitizeAIOutput(`  <小剧场>\n  ${CARD}\n  </小剧场>  `), CARD);
});

test('a truncated wrapper keeps everything after the opening tag instead of losing the body', async () => {
    const helpers = await loadHelpers();
    // 流式被截断 / 模型忘了闭合：宁可多留，也不能把正文丢掉。
    assert.equal(helpers.sanitizeAIOutput(`<小剧场>\n${CARD}`), CARD);
    assert.equal(helpers.sanitizeAIOutput(`前言\n<小剧场>${CARD}`), CARD);
});

test('without any wrapper the old heuristic behaviour is preserved', async () => {
    const helpers = await loadHelpers();
    // 老预设不会自动更新，用户也可能改掉那条约束 —— 这条回退必须一直在。
    assert.equal(helpers.sanitizeAIOutput(`这是一段前言\n${CARD}`), CARD);
    assert.equal(helpers.sanitizeAIOutput('```html\n' + CARD + '\n```'), CARD);
    assert.equal(helpers.sanitizeAIOutput(`<thinking>想一下</thinking>\n${CARD}`), CARD);
    // 原样返回、不做无中生有的改动。
    assert.equal(helpers.sanitizeAIOutput(CARD), CARD);
    assert.equal(helpers.sanitizeAIOutput(''), '');
    assert.equal(helpers.sanitizeAIOutput(null), '');
});

test('the streaming cleaner strips the wrapper so it never becomes an extra element', async () => {
    const helpers = await loadHelpers();
    // 外壳是未定义标签：不会显示成文字，但会多套一层元素，模型自写的 CSS
    // 若依赖「根元素是内容的直接子节点」就会错位。所以流式阶段就得剥掉。
    assert.equal(helpers.sanitizeAIOutputLite(`<小剧场>${CARD}</小剧场>`), CARD);
    assert.equal(helpers.sanitizeAIOutputLite(`<小剧场>${CARD}`), CARD);

    // 标签正写到一半时也要挡住，否则会在画面上闪一下。
    assert.equal(helpers.sanitizeAIOutputLite(`${CARD}<小`), CARD);
    assert.equal(helpers.sanitizeAIOutputLite(`${CARD}</小剧`), CARD);
    assert.equal(helpers.sanitizeAIOutputLite(`${CARD}<`), CARD);

    // 但不能误伤正文里本来就有的 `<`：后面已经闭合、或长得不像外壳标签就不动。
    assert.equal(helpers.sanitizeAIOutputLite('1 < 2 成立'), '1 < 2 成立');
    assert.equal(helpers.sanitizeAIOutputLite(`${CARD}<span>`), `${CARD}<span>`);
});
