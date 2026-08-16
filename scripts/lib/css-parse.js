/**
 * scripts/lib/css-parse.js —— 最小 CSS 解析（零依赖）
 *
 * 原先内联在 scripts/css-audit.js 里，css-color-diff.js 需要同一份解析结果
 * 才能保证「审计看到的规则」与「diff 看到的规则」是同一套。
 * 按 CLAUDE.md 的教训（同一份数据/逻辑写两份必然漂移），提取为共享模块。
 *
 * 本文件是 css-audit.js 内联版本的逐字节搬迁，未改任何行为。
 */

/** 用等长空白替换注释，保留换行以维持行号 */
export function stripComments(css) {
    let out = '';
    let i = 0;
    while (i < css.length) {
        if (css[i] === '/' && css[i + 1] === '*') {
            const end = css.indexOf('*/', i + 2);
            const stop = end === -1 ? css.length : end + 2;
            for (let j = i; j < stop; j++) out += css[j] === '\n' ? '\n' : ' ';
            i = stop;
            continue;
        }
        if (css[i] === '"' || css[i] === "'") {
            const q = css[i];
            out += css[i++];
            while (i < css.length && css[i] !== q) {
                if (css[i] === '\\') { out += css[i++]; if (i < css.length) out += css[i++]; continue; }
                out += css[i++];
            }
            if (i < css.length) out += css[i++];
            continue;
        }
        out += css[i++];
    }
    return out;
}

export function makeLineLookup(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    return (offset) => {
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
        }
        return lo + 1;
    };
}

/** 找到与 css[open] 处 '{' 匹配的 '}' 的下标；字符串内的花括号会被跳过 */
export function matchBrace(css, open) {
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        const ch = css[i];
        if (ch === '"' || ch === "'") {
            const q = ch; i++;
            while (i < css.length && css[i] !== q) { if (css[i] === '\\') i++; i++; }
            continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return i; }
    }
    return css.length - 1;
}

export const CONTAINER_AT = /^@(media|supports|container|layer|document|scope)\b/i;
export const KEYFRAMES_AT = /^@(-[a-z]+-)?keyframes\b/i;

/**
 * 解析为规则数组。每条规则：
 *   { selector, atStack, line, body, isKeyframes, decls:[{prop, value, line}] }
 */
export function parseCSS(raw, label) {
    const css = stripComments(raw);
    const lineAt = makeLineLookup(css);
    const rules = [];

    function walk(start, end, atStack) {
        let i = start;
        let bufStart = i;
        let buf = '';
        while (i < end) {
            const ch = css[i];
            if (ch === '"' || ch === "'") {
                const q = ch; buf += ch; i++;
                while (i < end && css[i] !== q) { if (css[i] === '\\') { buf += css[i++]; } buf += css[i++]; }
                if (i < end) buf += css[i++];
                continue;
            }
            if (ch === '{') {
                const prelude = buf.trim();
                const bodyStart = i + 1;
                const bodyEnd = matchBrace(css, i);
                const lead = buf.length - buf.trimStart().length;
                const line = lineAt(Math.min(bufStart + lead, css.length - 1));
                if (CONTAINER_AT.test(prelude)) {
                    rules.push({ selector: prelude, atStack: [...atStack], line, body: '', isAtContainer: true, isKeyframes: false, decls: [], file: label });
                    walk(bodyStart, bodyEnd, [...atStack, prelude]);
                } else {
                    const body = css.slice(bodyStart, bodyEnd);
                    rules.push({
                        selector: prelude,
                        atStack: [...atStack],
                        line,
                        body,
                        isAtContainer: false,
                        isKeyframes: KEYFRAMES_AT.test(prelude),
                        decls: parseDecls(body, bodyStart, lineAt),
                        file: label,
                    });
                }
                i = bodyEnd + 1;
                buf = ''; bufStart = i;
                continue;
            }
            if (ch === '}') { i++; buf = ''; bufStart = i; continue; }
            buf += ch;
            i++;
        }
    }

    /** 提取顶层声明（跳过嵌套块，例如 @keyframes 内的步骤块） */
    function parseDecls(body, bodyOffset, lineAt) {
        const decls = [];
        let i = 0, segStart = 0;
        while (i < body.length) {
            const ch = body[i];
            if (ch === '"' || ch === "'") {
                const q = ch; i++;
                while (i < body.length && body[i] !== q) { if (body[i] === '\\') i++; i++; }
                i++; continue;
            }
            if (ch === '{') { i = matchBrace(body, i) + 1; segStart = i; continue; }
            if (ch === ';') {
                pushDecl(body.slice(segStart, i), segStart);
                i++; segStart = i; continue;
            }
            i++;
        }
        pushDecl(body.slice(segStart), segStart);
        return decls;

        function pushDecl(seg, off) {
            const s = seg.trim();
            if (!s) return;
            const ci = s.indexOf(':');
            if (ci <= 0) return;
            decls.push({
                prop: s.slice(0, ci).trim().toLowerCase(),
                value: s.slice(ci + 1).trim(),
                line: lineAt(bodyOffset + off),
            });
        }
    }

    walk(0, css.length, []);
    return rules;
}
