// Rewrite-only extraction. Offsets always refer to the untouched message source.
export const REWRITE_STATIC_TAGS = new Set([
    'p', 'div', 'span', 'q', 'em', 'strong', 'i', 'b', 'u', 's', 'del', 'mark',
    'small', 'sub', 'sup', 'blockquote', 'section', 'article', 'main',
    'content', 'dialogue', 'narration', '正文', '对话', '旁白',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'source', 'embed', 'area', 'base', 'col', 'param', 'track']);
const PROTECTED_TAGS = new Set(['script', 'style', 'iframe', 'pre', 'code', 'svg', 'math', 'canvas', 'template', 'html', 'head', 'body', 'button', 'a', 'form', 'select', 'textarea', 'details', 'table', 'audio', 'video', 'object']);
const INLINE_TAGS = new Set(['span', 'q', 'em', 'strong', 'i', 'b', 'u', 's', 'del', 'mark', 'small', 'sub', 'sup']);
const STATE_NAME = /(?:状态|面板|属性|数值|资料|信息栏|status|state|stats|widget|component|react|vue|th-render)/i;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»' };

export function parseRewriteWhitelist(input) {
    return [...new Set(String(input || '').split(/[,，\n]/).map(tag => tag.trim().replace(/^<|>$/g, '').toLowerCase())
        .filter(tag => /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(tag)))];
}

export function isProtectedRewriteElement(name, attributes = '', whitelist = []) {
    const tag = String(name).toLowerCase();
    return PROTECTED_TAGS.has(tag) || STATE_NAME.test(tag) ||
        (!REWRITE_STATIC_TAGS.has(tag) && !whitelist.includes(tag)) ||
        /\bon[\w]+\s*=|\b(?:contenteditable|data-[\w-]+)\b/i.test(attributes) ||
        /\b(?:class|id)\s*=\s*["'][^"']*(?:状态|status|state|stats|card|panel|widget|render|component)[^"']*["']/i.test(attributes);
}

function codeRanges(raw) {
    const ranges = [];
    const fences = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/gm;
    let opening;
    while ((opening = fences.exec(raw))) {
        const marker = opening[1];
        const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*(?:\\r?\\n|$)`, 'gm');
        closing.lastIndex = fences.lastIndex;
        const end = closing.exec(raw);
        const stop = end ? closing.lastIndex : raw.length;
        ranges.push([opening.index, stop]);
        fences.lastIndex = stop;
    }
    const inline = /(`+)[^`\r\n]*\1/g;
    let match;
    while ((match = inline.exec(raw))) {
        if (!ranges.some(([a, b]) => a <= match.index && match.index < b)) ranges.push([match.index, inline.lastIndex]);
    }
    return ranges.sort((a, b) => a[0] - b[0]);
}

function decodeRun(raw, start, end) {
    let text = '';
    const map = [];
    let unsupportedEntity = false;
    for (let i = start; i < end;) {
        if (raw[i] === '\r' && raw[i + 1] === '\n') {
            text += '\n'; map.push({ start: i, end: i + 2 }); i += 2; continue;
        }
        const entity = raw[i] === '&' ? /^&(#x[\da-f]+|#\d+|[a-z]+);/i.exec(raw.slice(i, end)) : null;
        let value = raw[i];
        let length = 1;
        if (entity) {
            const key = entity[1];
            if (key[0] === '#') {
                const code = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
                value = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
            } else value = ENTITIES[key.toLowerCase()];
            if (value === undefined) { value = entity[0]; unsupportedEntity = true; }
            length = entity[0].length;
        }
        text += value;
        for (let j = 0; j < value.length; j++) map.push({ start: i, end: i + length });
        i += length;
    }
    return { text, map, start, end, unsupportedEntity };
}

export function extractRewriteProjection(source, whitelistInput = '') {
    const raw = String(source ?? '');
    const whitelist = parseRewriteWhitelist(whitelistInput);
    const runs = [];
    const stack = [];
    let reason = '';
    if (String(whitelistInput).trim() && !whitelist.length) reason = '提取白名单格式无效';
    const protectedRanges = codeRanges(raw);
    const tokens = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[\p{L}_][\p{L}\p{N}_:-]*(?:\s[^<>]*?)?\s*\/?>/gu;
    let cursor = 0;
    let matchedWhitelist = false;
    const append = (start, end) => {
        if (reason || stack.some(item => item.blocked) || (whitelist.length && !stack.some(item => whitelist.includes(item.tag)))) return;
        const cuts = protectedRanges.filter(([a, b]) => b > start && a < end);
        let pos = start;
        for (const [a, b] of cuts) {
            if (a > pos) runs.push(decodeRun(raw, pos, Math.min(a, end)));
            pos = Math.max(pos, b);
        }
        if (pos < end) runs.push(decodeRun(raw, pos, end));
    };
    let token;
    while ((token = tokens.exec(raw))) {
        if (protectedRanges.some(([a, b]) => a <= token.index && token.index < b)) continue;
        append(cursor, token.index);
        cursor = tokens.lastIndex;
        if (token[0].startsWith('<!')) continue;
        const tag = /^<\/?([\p{L}_][\p{L}\p{N}_:-]*)/u.exec(token[0])[1].toLowerCase();
        if (token[0].startsWith('</')) {
            if (stack.at(-1)?.tag !== tag) { reason = '原文标签结构无法可靠对应'; break; }
            stack.pop();
        } else {
            if (whitelist.includes(tag)) matchedWhitelist = true;
            if (['script', 'style', 'iframe', 'pre', 'code'].includes(tag) && !token[0].endsWith('/>')) {
                const close = new RegExp(`</${tag}\\s*>`, 'gi');
                close.lastIndex = cursor;
                if (!close.exec(raw)) { reason = '原文含有未闭合的前端或代码区域'; break; }
                cursor = tokens.lastIndex = close.lastIndex;
                continue;
            }
            if (!VOID_TAGS.has(tag) && !token[0].endsWith('/>')) stack.push({ tag, blocked: isProtectedRewriteElement(tag, token[0], whitelist) });
        }
    }
    append(cursor, raw.length);
    if (stack.length) reason = '原文含有未闭合的标签';
    if (whitelist.length && !matchedWhitelist) reason = '未找到白名单标签，未回退到全文';
    let text = '';
    const usable = reason ? [] : runs.flatMap(run => {
        // Markdown paragraphs become separate DOM blocks. Keep their source ranges separate too.
        const separators = /\r?\n\s*\r?\n+/g;
        const parts = [];
        let pos = run.start;
        let match;
        while ((match = separators.exec(raw.slice(run.start, run.end)))) {
            const stop = run.start + match.index;
            if (pos < stop) parts.push(decodeRun(raw, pos, stop));
            pos = stop + match[0].length;
        }
        if (pos < run.end) parts.push(decodeRun(raw, pos, run.end));
        return parts;
    }).filter(run => run.text.trim());
    for (const [index, run] of usable.entries()) {
        if (text) {
            const gap = raw.slice(usable[index - 1].end, run.start);
            const tags = Array.from(gap.matchAll(/<\/?([\p{L}_][\p{L}\p{N}_:-]*)[^<>]*>/gu));
            const inlineOnly = tags.length && !gap.replace(/<[^<>]*>/g, '').trim() && tags.every(match =>
                INLINE_TAGS.has(match[1].toLowerCase()) && !isProtectedRewriteElement(match[1], match[0], whitelist));
            if (!inlineOnly) text += '\n\n';
        }
        run.projectionStart = text.length;
        text += run.text;
        run.projectionEnd = text.length;
    }
    return { raw, text, runs: usable, whitelist, reason };
}

export function mapRewriteUnits(projection, units) {
    let cursor = 0;
    return units.map(unit => {
        const before = String(unit.text || '');
        const start = before ? projection.text.indexOf(before, cursor) : -1;
        if (start >= 0) cursor = start + before.length;
        const run = projection.runs.find(item => item.projectionStart <= start && item.projectionEnd >= start + before.length);
        const local = run ? start - run.projectionStart : -1;
        return { ...unit, run, local, reason: run ? '' : '该单元跨越标签或受保护区域，仅保留预览' };
    });
}

export function prepareSourcePatch(mappedUnit, after) {
    const { run } = mappedUnit;
    const original = String(mappedUnit.text || '');
    const before = original.trim();
    const local = mappedUnit.local + original.length - original.trimStart().length;
    const replacement = String(after ?? '').trim();
    let reason = mappedUnit.reason;
    if (run?.unsupportedEntity) reason = '正文包含暂不支持的字符实体';
    // Formatting adapters need their own source/DOM mapping; plain prose is safe here.
    const markup = /[`*_~\\<>]|\[[^\]]*\]|^\s*(?:#{1,6}\s|>\s|[-+]\s|\d+[.)]\s)/m;
    if (run && markup.test(run.text)) reason = '正文包含 Markdown 或嵌套格式，需要专用适配，仅保留预览';
    if (markup.test(replacement) || /[\r\n]/.test(replacement)) reason = '改写结果包含格式或换行，仅保留预览';
    if (!run || local < 0 || run.text.slice(local, local + before.length) !== before) reason ||= '原文位置无法可靠对应';
    if (reason) return { reason };
    const first = run.map[local];
    const last = run.map[local + before.length - 1];
    if (!first || !last || (local > 0 && run.map[local - 1].end > first.start) ||
        (local + before.length < run.map.length && run.map[local + before.length].start < last.end)) return { reason: '替换范围切开了字符实体' };
    return { start: first.start, end: last.end, after: replacement.replace(/&/g, '&amp;'), before, replacement, run, local, reason: '' };
}

export function applySourcePatches(raw, patches) {
    let output = raw;
    let boundary = raw.length;
    for (const patch of [...patches].sort((a, b) => b.start - a.start)) {
        if (patch.start < 0 || patch.end > boundary || patch.start >= patch.end) throw new Error('原文补丁范围重叠或失效');
        output = output.slice(0, patch.start) + patch.after + output.slice(patch.end);
        boundary = patch.start;
    }
    return output;
}
