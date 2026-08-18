#!/usr/bin/env node
/**
 * scripts/css-audit.js —— CSS 分层规则审计
 *
 * 用法：
 *   node scripts/css-audit.js                  报告模式（仅 Phase 0 阻断项会致失败）
 *   node scripts/css-audit.js --strict         全部检查转为阻断（Phase 6 起）
 *   node scripts/css-audit.js --compare        与 scripts/.css-audit-baseline.json 对比增量
 *   node scripts/css-audit.js --update-baseline  写入当前快照为新基线
 *   node scripts/css-audit.js --verbose        打印每条违规的 file:line
 *
 * 这是防止 CSS 重构成果被后续开发劣化的唯一措施（plan.md §11）。
 * 检查项 A1–A21 对应 plan.md §11.1；A22 为本项目实际事故催生的补充项。
 *
 * 零运行时依赖：CSS 解析为本文件内手写的最小实现。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CSS_LAYERS, cssFileList } from '../css/manifest.js';
import { stripComments, makeLineLookup, parseCSS } from './lib/css-parse.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const STRICT = ARGS.includes('--strict');
const VERBOSE = ARGS.includes('--verbose');
const COMPARE = ARGS.includes('--compare');
const UPDATE_BASELINE = ARGS.includes('--update-baseline');
const BASELINE_PATH = path.join(ROOT, 'scripts', '.css-audit-baseline.json');

// ─────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────

/** 约定的响应式断点（plan.md §5.1）。指针类查询单独白名单。 */
const ALLOWED_BREAKPOINTS = [600, 768, 920];

/** 颜色字面量白名单（规则 R3a） */
const COLOR_KEYWORD_WHITELIST = ['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'none'];

/** 由宿主（SillyTavern / FontAwesome）提供的动画名，不视为悬空 */
const EXTERNAL_ANIMATIONS = new Set(['fa-spin', 'fa-beat', 'fa-fade', 'fa-flip', 'fa-pulse', 'fa-shake', 'fa-spin-pulse']);

/** Phase 0 即阻断的检查项（plan.md §11.1 左列 + 本项目补充的 A22 / A23） */
// A8 在 Phase 5b 期间提为阻断项：它抓的是「插件样式穿透到宿主 SillyTavern」，
// 与 B2（滚动条泄漏）同类，是本项目最严重的一类缺陷。提升时 A8 为 0 违规，
// 故零成本；此前正因为它只是报告级，input[list]::-webkit-calendar-picker-indicator
// 无作用域地重写整个 ST 的 datalist 指示器一直没被拦下。
const PHASE0_BLOCKING = new Set(['A8', 'A10', 'A11', 'A14', 'A15', 'A22', 'A23']);

// ─────────────────────────────────────────────────────────────
// 输入收集
// ─────────────────────────────────────────────────────────────

function layerOf(relPath) {
    const m = /^(\d\d-[a-z]+)\//.exec(relPath.replace(/\\/g, '/'));
    return m ? m[1] : '(未分层)';
}

function walkDir(dir, filter, acc = []) {
    if (!existsSync(dir)) return acc;
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.wrangler' || entry.startsWith('.')) continue;
        const p = path.join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) walkDir(p, filter, acc);
        else if (filter(p)) acc.push(p);
    }
    return acc;
}

function collectInputs() {
    const manifestList = cssFileList();

    // 1) 清单内的 CSS
    const cssFiles = manifestList.map(rel => {
        const abs = path.join(ROOT, 'css', rel);
        const raw = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
        return { rel, abs, raw, layer: layerOf(rel), source: 'css' };
    });

    // 2) settings.html 的内嵌 <style>（第 2 处样式来源，Phase 5 迁出）
    const htmlFiles = [];
    const settingsHtmlPath = path.join(ROOT, 'settings.html');
    if (existsSync(settingsHtmlPath)) {
        const html = readFileSync(settingsHtmlPath, 'utf8');
        const before = html.split(/<style[^>]*>/i)[0] ?? '';
        const startLine = before.split('\n').length;
        for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
            htmlFiles.push({
                rel: 'settings.html <style>', abs: settingsHtmlPath, raw: m[1],
                layer: '(内嵌 HTML)', source: 'html', lineOffset: startLine,
            });
        }
    }

    // 3) src/**/*.js（inline style 计数、JS 注入的 <style>、挂载点）
    const jsFiles = walkDir(path.join(ROOT, 'src'), p => p.endsWith('.js')).map(abs => ({
        rel: path.relative(ROOT, abs).replace(/\\/g, '/'),
        abs, raw: readFileSync(abs, 'utf8'), source: 'js',
    }));

    return { manifestList, cssFiles, htmlFiles, jsFiles };
}

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

const RE_HEX = /#[0-9a-fA-F]{3,8}\b/g;
const RE_RGB = /\brgba?\([^)]*\)/g;
const RE_VAR_USE = /var\(\s*(--[a-zA-Z0-9-]+)/g;
const RE_VAR_DECL = /(^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/g;

function countMatches(text, re) {
    const m = text.match(re);
    return m ? m.length : 0;
}

/** 从选择器串里提取类名 */
function classesIn(selector) {
    return [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(m => m[1]);
}

/** 顶层单类选择器（如 `.t-btn`、`.t-btn:hover`、`.t-btn.primary`），用于归属判断 */
function topLevelClassTargets(selector) {
    const out = new Set();
    for (const part of selector.split(',')) {
        const s = part.trim();
        if (!s) continue;
        // 只看最后一个组合子之后的部分，且不含 ID / 元素前置限定
        const last = s.split(/\s+|>|\+|~/).filter(Boolean).pop() || '';
        if (last.includes('#')) continue;
        const m = /^\.(-?[_a-zA-Z][\w-]*)/.exec(last);
        if (m) out.add(m[1]);
    }
    return [...out];
}

/** 规范化声明块用于字节级重复比较 */
function normalizeDecls(decls) {
    return decls
        .map(d => `${d.prop}:${d.value.replace(/\s+/g, ' ').trim().toLowerCase()}`)
        .sort()
        .join(';');
}

// ─────────────────────────────────────────────────────────────
// 检查框架
// ─────────────────────────────────────────────────────────────

const results = [];

/**
 * @param id      检查编号
 * @param rule    对应的分层规则（R1–R9）或 '—'
 * @param title   人类可读描述
 * @param fn      返回 { violations: [{loc, msg}], metrics: {}, skipped?: string }
 */
function check(id, rule, title, fn) {
    let out;
    try {
        out = fn() || {};
    } catch (err) {
        out = { violations: [{ loc: '-', msg: `检查自身抛错: ${err.message}` }] };
    }
    const violations = out.violations || [];
    const blocking = STRICT || PHASE0_BLOCKING.has(id);
    results.push({
        id, rule, title,
        violations,
        metrics: out.metrics || {},
        skipped: out.skipped || null,
        note: out.note || null,
        blocking,
        failed: !out.skipped && violations.length > 0 && blocking,
    });
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

const { manifestList, cssFiles, htmlFiles, jsFiles } = collectInputs();

// 所有样式来源（CSS 清单 + settings.html 内嵌）解析结果
const styleSources = [...cssFiles.filter(f => f.raw !== null), ...htmlFiles];
for (const f of styleSources) f.rules = parseCSS(f.raw, f.rel);

const byLayer = (layer) => styleSources.filter(f => f.layer === layer);
const componentFiles = byLayer('02-components');
const featureFiles = byLayer('04-features');
const tokenFiles = byLayer('00-tokens');

// ── A14：清单 ↔ 磁盘 双向一致 ────────────────────────────────
check('A14', '—', 'manifest.js 与磁盘双向一致', () => {
    const violations = [];
    for (const rel of manifestList) {
        if (!existsSync(path.join(ROOT, 'css', rel))) {
            violations.push({ loc: `css/${rel}`, msg: '清单列出但磁盘不存在' });
        }
    }
    const listed = new Set(manifestList.map(p => p.replace(/\\/g, '/')));
    const onDisk = walkDir(path.join(ROOT, 'css'), p => p.endsWith('.css'))
        .map(p => path.relative(path.join(ROOT, 'css'), p).replace(/\\/g, '/'));
    for (const rel of onDisk) {
        if (!listed.has(rel)) violations.push({ loc: `css/${rel}`, msg: '磁盘存在但清单未列出（探针主题误发布风险 R12）' });
    }
    return { violations, metrics: { 清单文件数: manifestList.length, 磁盘文件数: onDisk.length } };
});

// ── A15：main-window-legacy.css 紧跟 main-window.css ─────────
check('A15', '—', 'main-window-legacy.css 紧跟 main-window.css', () => {
    const i = manifestList.indexOf('04-features/main-window.css');
    const j = manifestList.indexOf('04-features/main-window-legacy.css');
    if (i === -1 || j === -1) return { skipped: '两个文件之一不在清单中' };
    if (j !== i + 1) {
        return { violations: [{ loc: 'css/manifest.js', msg: `顺序错误：main-window 在第 ${i + 1} 位，legacy 在第 ${j + 1} 位（应为第 ${i + 2} 位）` }] };
    }
    return { violations: [], metrics: { 位置: `${i + 1} → ${j + 1}` } };
});

// ── A10：禁止 @layer（ADR-03 / R9）─────────────────────────────
check('A10', 'R9', '禁止使用 CSS @layer', () => {
    const violations = [];
    for (const f of styleSources) {
        const css = stripComments(f.raw);
        const lineAt = makeLineLookup(css);
        for (const m of css.matchAll(/@layer\b/g)) {
            violations.push({ loc: `${f.rel}:${lineAt(m.index)}`, msg: '出现 @layer：未分层声明优先级高于所有分层声明，插件会被 ST 规则全面穿透（ADR-03）' });
        }
    }
    return { violations };
});

// ── A11：消费但未声明的 --t-* 变量 ───────────────────────────
// 三态判定：
//   CSS 层已声明          → 通过
//   仅由 JS 写在元素上     → 报告（这就是缺陷 B5 的隐式契约。它是数据驱动的正确
//                            用法，但 CSS 层缺兜底值，Phase 1 由 legacy-aliases.css 补）
//   CSS 与 JS 都没有       → 阻断（真正的错误：只能靠 var() fallback 里的硬编码色兜底）
check('A11', '—', '消费但未声明的 --t-* 变量', () => {
    const cssDeclared = new Set();
    const consumed = new Map(); // name -> [loc]

    for (const f of styleSources) {
        const css = stripComments(f.raw);
        const lineAt = makeLineLookup(css);
        for (const m of css.matchAll(RE_VAR_DECL)) cssDeclared.add(m[2]);
        for (const m of css.matchAll(RE_VAR_USE)) {
            if (!m[1].startsWith('--t-')) continue;
            if (!consumed.has(m[1])) consumed.set(m[1], []);
            consumed.get(m[1]).push(`${f.rel}:${lineAt(m.index)}`);
        }
    }

    // JS 侧声明：setProperty('--x', v)、jQuery .css({ '--x': v }) 对象字面量、模板串里的 --x: v
    const jsDeclared = new Map();
    for (const f of jsFiles) {
        const lineAt = makeLineLookup(f.raw);
        const add = (name, idx) => { if (!jsDeclared.has(name)) jsDeclared.set(name, `${f.rel}:${lineAt(idx)}`); };
        for (const m of f.raw.matchAll(/setProperty\(\s*['"`](--[a-zA-Z0-9-]+)/g)) add(m[1], m.index);
        for (const m of f.raw.matchAll(/['"`](--[a-zA-Z0-9-]+)['"`]\s*:/g)) add(m[1], m.index);
        for (const m of f.raw.matchAll(RE_VAR_DECL)) add(m[2], m.index);
    }

    const violations = [];
    const jsOnly = [];
    for (const [name, locs] of consumed) {
        if (cssDeclared.has(name)) continue;
        if (jsDeclared.has(name)) {
            jsOnly.push(`${name}（CSS 消费 ${locs.length} 次，由 ${jsDeclared.get(name)} 写入）`);
            continue;
        }
        violations.push({ loc: locs[0], msg: `${name} 被消费 ${locs.length} 次，CSS 与 JS 中均无声明` });
    }
    return {
        violations,
        metrics: {
            'CSS 已声明 --t-*': [...cssDeclared].filter(n => n.startsWith('--t-')).length,
            '被消费种类': consumed.size,
            '仅 JS 声明（B5）': jsOnly.length,
        },
        note: jsOnly.length
            ? `仅 JS 运行时声明、CSS 层无兜底值（B5）。刻意不在 :root 补默认值：\n           `
            + `--t-border-color 有 5 种互不相同的 fallback，补默认值会改色。\n           `
            + `详见 css/00-tokens/legacy-aliases.css 的说明，留待 Phase 4 按语义拆分。\n           `
            + jsOnly.join('\n           ')
            : null,
    };
});

// ── A22：悬空 animation 引用 / 孤儿 @keyframes ────────────────
// 本项不在 plan.md §11.1 原始清单中。2026-08-16 的事故：24 个 @keyframes 定义
// 被删除后未落地到新文件，22 个动画静默失效而无人发现。故列为 Phase 0 阻断项。
check('A22', 'R6', '悬空 animation 引用 / 孤儿 @keyframes', () => {
    const defined = new Map();   // name -> loc
    const referenced = new Map(); // name -> [loc]
    const KW = new Set(['none', 'inherit', 'initial', 'unset', 'revert', 'normal', 'infinite',
        'alternate', 'alternate-reverse', 'reverse', 'forwards', 'backwards', 'both',
        'running', 'paused', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out',
        'step-start', 'step-end', 'important']);

    // 样式来源 + JS 内联样式一并扫描（动画可能定义/引用在 JS 注入的 <style> 里）
    const all = [...styleSources.map(f => ({ rel: f.rel, raw: f.raw })), ...jsFiles.map(f => ({ rel: f.rel, raw: f.raw }))];
    for (const f of all) {
        const css = stripComments(f.raw);
        const lineAt = makeLineLookup(css);
        for (const m of css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)) {
            defined.set(m[1], `${f.rel}:${lineAt(m.index)}`);
        }
        for (const m of css.matchAll(/animation(?:-name)?\s*:\s*([^;}"'`]+)/g)) {
            for (const part of m[1].split(',')) {
                for (let tok of part.trim().split(/\s+/)) {
                    tok = tok.replace(/[()]/g, '');
                    if (!tok || KW.has(tok.toLowerCase())) continue;
                    if (/^[\d.]/.test(tok) || /^(cubic-bezier|steps)/.test(tok)) continue;
                    if (tok.startsWith('--') || tok.startsWith('$')) continue;
                    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(tok)) continue;
                    if (!referenced.has(tok)) referenced.set(tok, []);
                    referenced.get(tok).push(`${f.rel}:${lineAt(m.index)}`);
                }
            }
        }
    }

    const violations = [];
    for (const [name, locs] of referenced) {
        if (EXTERNAL_ANIMATIONS.has(name) || defined.has(name)) continue;
        violations.push({ loc: locs[0], msg: `animation: ${name} 无对应 @keyframes（引用 ${locs.length} 处）` });
    }
    for (const [name, loc] of defined) {
        if (!referenced.has(name)) violations.push({ loc, msg: `@keyframes ${name} 无人引用（孤儿定义）` });
    }
    return { violations, metrics: { 定义: defined.size, 引用种类: referenced.size } };
});

// ── A23：CSS 语法完整性（注释嵌套 / 花括号平衡）────────────────
// CSS 注释不能嵌套：`/* 外层 /* 内层 */ 其余正文 */` 中第一个 */ 就闭合了注释，
// 其后的注释正文变成非法 CSS —— 浏览器静默丢弃，不报错。写长段说明注释时极易踩到
// （本项目在 Phase 1 写 scope.css 时就踩过一次）。故列为阻断项。
check('A23', '—', 'CSS 语法完整性（注释嵌套 / 花括号平衡）', () => {
    const violations = [];
    for (const f of styleSources) {
        const src = f.raw;
        // 注释嵌套
        let i = 0, line = 1;
        while (i < src.length) {
            if (src[i] === '\n') { line++; i++; continue; }
            if (src[i] === '/' && src[i + 1] === '*') {
                const startLine = line;
                i += 2;
                let innerLine = null;
                while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
                    if (src[i] === '\n') line++;
                    if (src[i] === '/' && src[i + 1] === '*' && innerLine === null) innerLine = line;
                    i++;
                }
                if (innerLine !== null) {
                    violations.push({
                        loc: `${f.rel}:${startLine}`,
                        msg: `注释内第 ${innerLine} 行出现嵌套 /*，会提前闭合注释并使其后正文成为非法 CSS`,
                    });
                }
                i += 2;
                continue;
            }
            i++;
        }
        // 花括号平衡（在剥离注释与字符串之后）
        const stripped = stripComments(src);
        let depth = 0, minDepth = 0;
        for (let k = 0; k < stripped.length; k++) {
            const ch = stripped[k];
            if (ch === '"' || ch === "'") {
                const q = ch; k++;
                while (k < stripped.length && stripped[k] !== q) { if (stripped[k] === '\\') k++; k++; }
                continue;
            }
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth < minDepth) minDepth = depth; }
        }
        if (depth !== 0 || minDepth < 0) {
            violations.push({ loc: f.rel, msg: `花括号不平衡（净 ${depth}，最低 ${minDepth}）` });
        }
    }
    return { violations };
});

// ── A7：@keyframes 只能在 01-base/keyframes.css 且带 t- 前缀（R6）──
check('A7', 'R6', '@keyframes 集中声明且带 t- 前缀', () => {
    const violations = [];
    const HOME = '01-base/keyframes.css';
    const all = [...styleSources.map(f => ({ rel: f.rel, raw: f.raw })), ...jsFiles.map(f => ({ rel: f.rel, raw: f.raw }))];
    let total = 0;
    for (const f of all) {
        const css = stripComments(f.raw);
        const lineAt = makeLineLookup(css);
        for (const m of css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)) {
            total++;
            const loc = `${f.rel}:${lineAt(m.index)}`;
            if (f.rel !== HOME) violations.push({ loc, msg: `@keyframes ${m[1]} 应集中到 ${HOME}` });
            if (!m[1].startsWith('t-')) violations.push({ loc, msg: `@keyframes ${m[1]} 缺少 t- 前缀，会与 ST 及其它扩展撞名` });
        }
    }
    return { violations, metrics: { keyframes总数: total } };
});

// ── A8：全局伪元素选择器必须限定在插件作用域内（R7）───────────
// 判定方式：剥掉伪元素与其后的伪类，得到选择器的「主语」。
//   主语为空                    → 裸全局选择器，会泄漏到整个 SillyTavern
//   主语不含 t- / titania 标识   → 未限定在插件范围内
// 不按「前缀是否为 .t-root」判定：作用域也可以由属性选择器提供
// （见 01-base/scrollbar.css 的说明），只看前缀会把正确写法误报为违规。
check('A8', 'R7', '全局伪元素选择器带插件作用域', () => {
    const violations = [];
    // 表单控件类伪元素同样会穿透到宿主：Phase 5b 期间发现 input[list]::-webkit-calendar-picker-indicator
    // 无作用域地重写了整个 ST 的 datalist 指示器，而旧白名单抓不到它。
    const GLOBAL_PSEUDO = /::(-webkit-scrollbar[a-z-]*|-webkit-resizer|selection|placeholder|-moz-[a-z-]*placeholder|-webkit-input-placeholder|backdrop|-webkit-calendar-picker-indicator|-webkit-(inner|outer)-spin-button|-webkit-search-(cancel|decoration)-button|-webkit-file-upload-button|file-selector-button|-webkit-slider-(thumb|runnable-track)|-moz-range-(thumb|track|progress)|-webkit-(progress-bar|progress-value)|marker)/i;
    let scoped = 0, viaRoot = 0;
    for (const f of styleSources) {
        for (const r of f.rules) {
            if (r.isAtContainer || r.isKeyframes) continue;
            for (const part of r.selector.split(',')) {
                const s = part.trim();
                if (!s || !GLOBAL_PSEUDO.test(s)) continue;
                const subject = s
                    .replace(GLOBAL_PSEUDO, '')
                    .replace(/:[a-z-]+(\([^)]*\))?/gi, '')
                    .trim();
                if (!subject) {
                    violations.push({ loc: `${f.rel}:${r.line}`, msg: `裸全局伪元素选择器：${s}（会重写整个 SillyTavern，见 B2）` });
                    continue;
                }
                if (!/t-|titania/.test(subject)) {
                    violations.push({ loc: `${f.rel}:${r.line}`, msg: `伪元素选择器未限定在插件范围：${s}` });
                    continue;
                }
                scoped++;
                if (/\.t-root\b/.test(subject)) viaRoot++;
            }
        }
    }
    return {
        violations,
        metrics: { '已限定作用域的伪元素选择器': scoped, '其中用 .t-root': viaRoot },
        note: viaRoot < scoped ? 'Phase 1 给挂载点加 .t-root 后，应把作用域统一收敛为 .t-root' : null,
    };
});

// ── A9：!important 必须紧邻注释说明（R8）─────────────────────
check('A9', 'R8', '!important 紧邻注释说明其对抗的宿主规则', () => {
    const violations = [];
    let total = 0;
    for (const f of styleSources) {
        const lines = f.raw.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].includes('!important')) continue;
            total++;
            // 同行含注释，或往上找到的第一个非空行是注释 → 视为已说明
            if (/\/\*/.test(lines[i])) continue;
            let j = i - 1;
            while (j >= 0 && lines[j].trim() === '') j--;
            const prev = j >= 0 ? lines[j] : '';
            if (/\/\*|\*\//.test(prev)) continue;
            violations.push({ loc: `${f.rel}:${i + 1}`, msg: `!important 无注释说明：${lines[i].trim().slice(0, 70)}` });
        }
    }
    return { violations, metrics: { important总数: total } };
});

// ── A1：各层颜色字面量计数 ───────────────────────────────────
check('A1', '—', '各层颜色字面量计数', () => {
    const perLayer = {};
    let hex = 0, rgb = 0;
    for (const f of styleSources) {
        const css = stripComments(f.raw);
        const h = countMatches(css, RE_HEX);
        const r = countMatches(css, RE_RGB);
        hex += h; rgb += r;
        const key = f.layer;
        perLayer[key] = perLayer[key] || { hex: 0, rgb: 0 };
        perLayer[key].hex += h;
        perLayer[key].rgb += r;
    }
    const metrics = { hex字面量: hex, 'rgb/rgba字面量': rgb, 合计: hex + rgb };
    for (const [k, v] of Object.entries(perLayer)) metrics[`  ${k}`] = `hex ${v.hex} / rgb ${v.rgb}`;
    return { violations: [], metrics };
});

// ── A2：组件层禁止 ID 选择器（R2）────────────────────────────
check('A2', 'R2', '组件层禁止 ID 选择器', () => {
    if (!componentFiles.length) return { skipped: '02-components/ 尚未创建（Phase 2 起）' };
    const violations = [];
    for (const f of componentFiles) {
        for (const r of f.rules) {
            if (r.isAtContainer || r.isKeyframes) continue;
            if (/#[a-zA-Z]/.test(r.selector)) violations.push({ loc: `${f.rel}:${r.line}`, msg: `组件层出现 ID 选择器：${r.selector.slice(0, 70)}` });
        }
    }
    return { violations };
});

// ── A3：组件层禁止颜色字面量（R3a）───────────────────────────
check('A3', 'R3a', '组件层禁止颜色字面量', () => {
    if (!componentFiles.length) return { skipped: '02-components/ 尚未创建（Phase 2 起）' };
    const violations = [];
    for (const f of componentFiles) {
        for (const r of f.rules) {
            for (const d of r.decls) {
                const v = d.value.toLowerCase();
                if (COLOR_KEYWORD_WHITELIST.some(w => v === w)) continue;
                // 用非全局正则做 test，避免 lastIndex 残留导致漏判
                if (/#[0-9a-fA-F]{3,8}\b/.test(d.value) || /\brgba?\(/.test(d.value)) {
                    violations.push({ loc: `${f.rel}:${d.line}`, msg: `字面量颜色：${d.prop}: ${d.value.slice(0, 50)}` });
                }
            }
        }
    }
    return { violations };
});

// ── A4：组件层禁止直接引用原语层（R3b）──────────────────────
check('A4', 'R3b', '组件层禁止直接引用 --t-c-* 原语', () => {
    if (!componentFiles.length) return { skipped: '02-components/ 尚未创建（Phase 2 起）' };
    const violations = [];
    for (const f of componentFiles) {
        const css = stripComments(f.raw);
        const lineAt = makeLineLookup(css);
        for (const m of css.matchAll(/var\(\s*(--t-c-[a-zA-Z0-9-]+)/g)) {
            violations.push({ loc: `${f.rel}:${lineAt(m.index)}`, msg: `组件层直接引用原语 ${m[1]}，应改用语义 token` });
        }
    }
    return { violations };
});

// ── A5：feature 层禁止重定义组件类的视觉属性（R4）────────────
const VISUAL_PROPS = /^(color|background|background-color|background-image|border|border-[a-z-]+|box-shadow|font|font-[a-z-]+|border-radius|text-shadow|opacity|outline)$/;
check('A5', 'R4', 'feature 层禁止重定义组件类的视觉属性', () => {
    if (!componentFiles.length) return { skipped: '02-components/ 尚未创建（Phase 2 起）' };
    const componentClasses = new Set();
    for (const f of componentFiles) {
        for (const r of f.rules) {
            if (r.isAtContainer || r.isKeyframes) continue;
            for (const c of topLevelClassTargets(r.selector)) componentClasses.add(c);
        }
    }
    const violations = [];
    for (const f of featureFiles) {
        for (const r of f.rules) {
            if (r.isAtContainer || r.isKeyframes) continue;
            const hit = topLevelClassTargets(r.selector).filter(c => componentClasses.has(c));
            if (!hit.length) continue;
            for (const d of r.decls) {
                if (VISUAL_PROPS.test(d.prop)) {
                    violations.push({ loc: `${f.rel}:${d.line}`, msg: `重定义组件类 .${hit[0]} 的视觉属性 ${d.prop}（布局属性才允许）` });
                }
            }
        }
    }
    return { violations };
});

// ── A6：feature 之间禁止交叉引用类名（R5）────────────────────
check('A6', 'R5', 'feature 之间禁止交叉引用类名', () => {
    if (featureFiles.length < 2) return { skipped: '04-features/ 文件不足' };
    // 归属判定：某类名的规则条数在哪个 feature 文件里最多，即归属该文件。
    // 这是启发式（plan.md §7 要求的「类名前缀归属表」尚未人工整理），故仅报告。
    //
    // ⚠ 组件层已定义的类**不参与**归属推断。R5 管的是「feature 之间互相引用
    // 彼此的类名」；组件类属于 02-components，任何 feature 调整它都由 R4/A5 管
    // （且 A5 明确允许调布局属性）。不排除会让 .t-btn / .t-dialog-box /
    // .t-dialog-body / .t-form-group 这类共享组件被判成「某个 feature 的私有类」，
    // 逼着后续迁移为迁就误判去造一次性修饰类 —— 5b-4/5b-5 各被坑过一次。
    const componentOwned = new Set();
    for (const f of componentFiles) {
        for (const r of f.rules) {
            if (r.isAtContainer || r.isKeyframes) continue;
            for (const c of topLevelClassTargets(r.selector)) componentOwned.add(c);
        }
    }
    const owners = new Map(); // class -> Map(file -> count)
    for (const f of featureFiles) {
        for (const r of f.rules) {
            if (r.isAtContainer || r.isKeyframes) continue;
            for (const c of topLevelClassTargets(r.selector)) {
                if (componentOwned.has(c)) continue;
                if (!owners.has(c)) owners.set(c, new Map());
                const m = owners.get(c);
                m.set(f.rel, (m.get(f.rel) || 0) + 1);
            }
        }
    }
    const violations = [];
    for (const [cls, m] of owners) {
        if (m.size < 2) continue;
        const sorted = [...m].sort((a, b) => b[1] - a[1]);
        const [ownerFile, ownerCount] = sorted[0];
        for (const [file, count] of sorted.slice(1)) {
            violations.push({
                loc: file,
                msg: `.${cls} 归属 ${ownerFile}（${ownerCount} 条），但 ${file} 也定义了 ${count} 条`,
            });
        }
    }
    return { violations, note: '归属为启发式推断（按规则条数，已排除 02-components 已定义的类），需人工整理前缀归属表后转阻断' };
});

// ── A12：跨文件重复定义的顶层类 ──────────────────────────────
check('A12', '—', '跨文件重复定义的顶层类', () => {
    const map = new Map(); // class -> Set(file)
    for (const f of styleSources) {
        for (const r of f.rules) {
            if (r.isAtContainer || r.isKeyframes) continue;
            // 只统计「裸类」定义（选择器就是单个类，可带伪类），排除后代/组合选择器
            for (const part of r.selector.split(',')) {
                const s = part.trim();
                if (!s) continue;
                if (!/^\.(-?[_a-zA-Z][\w-]*)(:{1,2}[a-zA-Z-]+(\([^)]*\))?)*$/.test(s)) continue;
                const cls = /^\.(-?[_a-zA-Z][\w-]*)/.exec(s)[1];
                if (!map.has(cls)) map.set(cls, new Set());
                map.get(cls).add(f.rel);
            }
        }
    }
    const violations = [];
    for (const [cls, files] of map) {
        if (files.size > 1) violations.push({ loc: [...files].join(' + '), msg: `.${cls} 在 ${files.size} 个文件中重复定义` });
    }
    return { violations, metrics: { 冲突类数: violations.length } };
});

// ── A13：字节级重复声明块（≥4 声明）─────────────────────────
check('A13', '—', '字节级重复声明块（≥4 声明）', () => {
    const groups = new Map();
    for (const f of styleSources) {
        for (const r of f.rules) {
            if (r.isAtContainer || r.isKeyframes) continue;
            if (r.decls.length < 4) continue;
            const key = normalizeDecls(r.decls);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ sel: r.selector, loc: `${f.rel}:${r.line}`, n: r.decls.length });
        }
    }
    const violations = [];
    for (const [, arr] of groups) {
        if (arr.length < 2) continue;
        violations.push({
            loc: arr.map(a => a.loc).join(' + '),
            msg: `${arr.length} 处完全相同的 ${arr[0].n} 条声明：${arr.map(a => a.sel.slice(0, 28)).join(' | ')}`,
        });
    }
    return { violations, metrics: { 重复组数: violations.length } };
});

// ── A16 / A17：JS 里的 inline style ──────────────────────────
check('A16', '—', 'src/**/*.js 的 inline style 计数', () => {
    let staticCount = 0, dynamicCount = 0;
    const perFile = [];
    for (const f of jsFiles) {
        let s = 0, d = 0;
        for (const m of f.raw.matchAll(/style="([^"]*)"/g)) {
            if (m[1].includes('${')) d++; else s++;
        }
        if (s + d > 0) perFile.push({ rel: f.rel, s, d });
        staticCount += s; dynamicCount += d;
    }
    perFile.sort((a, b) => (b.s + b.d) - (a.s + a.d));
    const metrics = { 静态: staticCount, 数据驱动: dynamicCount, 合计: staticCount + dynamicCount };
    for (const p of perFile.slice(0, 5)) metrics[`  ${p.rel}`] = `${p.s + p.d}（静态 ${p.s}）`;
    return { violations: [], metrics };
});

check('A17', '—', 'inline style 中的硬编码颜色', () => {
    const violations = [];
    for (const f of jsFiles) {
        const lineAt = makeLineLookup(f.raw);
        for (const m of f.raw.matchAll(/style="([^"]*)"/g)) {
            const v = m[1];
            if (/#[0-9a-fA-F]{3,8}\b/.test(v) || /\brgba?\(/.test(v)) {
                const flat = v.replace(/\s+/g, ' ').trim();
                violations.push({ loc: `${f.rel}:${lineAt(m.index)}`, msg: `inline style 含硬编码颜色：${flat.slice(0, 60)}` });
            }
        }
    }
    return { violations, metrics: { 命中数: violations.length } };
});

// ── A18：@media 断点收敛（含 JS 侧 matchMedia）────────────────
check('A18', '—', '@media 断点在约定集合内', () => {
    const values = new Map(); // px -> count
    let blocks = 0, pointerQueries = 0;
    const violations = [];
    const record = (v, loc) => {
        values.set(v, (values.get(v) || 0) + 1);
        if (!ALLOWED_BREAKPOINTS.includes(v)) {
            violations.push({ loc, msg: `断点 ${v}px 不在约定 {${ALLOWED_BREAKPOINTS.join(', ')}} 内` });
        }
    };
    for (const f of styleSources) {
        for (const r of f.rules) {
            if (!r.isAtContainer || !/^@media/i.test(r.selector)) continue;
            blocks++;
            const px = [...r.selector.matchAll(/(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
            if (!px.length) { pointerQueries++; continue; } // 指针 / hover 类查询，白名单
            for (const v of px) record(v, `${f.rel}:${r.line}`);
        }
    }
    // JS 侧 matchMedia：必须与 CSS 断点同步，否则 JS/CSS 会在不同宽度切换
    let jsQueries = 0;
    for (const f of jsFiles) {
        const lineAt = makeLineLookup(f.raw);
        for (const m of f.raw.matchAll(/matchMedia\(\s*[`'"]([^`'"]+)[`'"]/g)) {
            jsQueries++;
            for (const p of m[1].matchAll(/(\d+(?:\.\d+)?)px/g)) record(Number(p[1]), `${f.rel}:${lineAt(m.index)}`);
        }
    }
    return {
        violations,
        metrics: {
            '@media 块': blocks,
            '其中指针/hover 查询': pointerQueries,
            'JS matchMedia': jsQueries,
            '不同断点': values.size,
            '断点分布': [...values].sort((a, b) => a[0] - b[0]).map(([v, n]) => `${v}px×${n}`).join(' '),
        },
    };
});

// ── A19：z-index 必须通过 var(--t-z-*) ──────────────────────
check('A19', '—', 'z-index 通过 token 声明', () => {
    const violations = [];
    const values = new Map();
    for (const f of styleSources) {
        for (const r of f.rules) {
            for (const d of r.decls) {
                if (d.prop !== 'z-index') continue;
                const v = d.value.replace(/!important/, '').trim();
                if (/var\(\s*--t-z-/.test(v)) continue;
                values.set(v, (values.get(v) || 0) + 1);
                violations.push({ loc: `${f.rel}:${d.line}`, msg: `z-index: ${v} 未使用 var(--t-z-*)` });
            }
        }
    }
    // JS 侧
    for (const f of jsFiles) {
        const lineAt = makeLineLookup(f.raw);
        for (const m of f.raw.matchAll(/z-?[iI]ndex["']?\s*[:=]\s*["']?(\d+)/g)) {
            values.set(m[1], (values.get(m[1]) || 0) + 1);
            violations.push({ loc: `${f.rel}:${lineAt(m.index)}`, msg: `JS 里硬编码 z-index: ${m[1]}` });
        }
    }
    return { violations, metrics: { 不同取值: values.size } };
});

// ── A20：transition: all ────────────────────────────────────
check('A20', '—', '禁止 transition: all', () => {
    const violations = [];
    let totalTransition = 0, allPoint2s = 0;
    for (const f of styleSources) {
        for (const r of f.rules) {
            for (const d of r.decls) {
                if (d.prop !== 'transition' && d.prop !== 'transition-property') continue;
                totalTransition++;
                if (!/(^|\s|,)all(\s|$|,)/.test(d.value)) continue;
                if (/^all\s+0\.2s/.test(d.value.trim())) allPoint2s++;
                violations.push({ loc: `${f.rel}:${d.line}`, msg: `transition: ${d.value.slice(0, 40)}（all 会把 width/height/transform 一起纳入过渡，移动端掉帧根因）` });
            }
        }
    }
    return {
        violations,
        metrics: { 'transition 声明总数': totalTransition, '含 all': violations.length, '其中 all 0.2s': allPoint2s },
    };
});

// ── A21：挂载点与 .t-root 覆盖情况 ─────────────────────────────
check('A21', '—', '挂载点清点与 .t-root 覆盖', () => {
    const sites = [];
    let tRootTags = 0;
    for (const f of jsFiles) {
        const lineAt = makeLineLookup(f.raw);
        for (const m of f.raw.matchAll(/\$\(\s*["']body["']\s*\)\s*\.\s*append/g)) {
            sites.push({ loc: `${f.rel}:${lineAt(m.index)}`, kind: 'body.append' });
        }
        for (const m of f.raw.matchAll(/ensureOverlay\s*\(/g)) {
            sites.push({ loc: `${f.rel}:${lineAt(m.index)}`, kind: 'ensureOverlay' });
        }
        tRootTags += (f.raw.match(/class="[^"]*\bt-root\b[^"]*"/g) || []).length;
    }
    const bodyAppend = sites.filter(s => s.kind === 'body.append').length;
    const overlay = sites.filter(s => s.kind === 'ensureOverlay').length;
    return {
        violations: [],
        metrics: {
            'body.append 调用点': bodyAppend,
            'ensureOverlay 调用点': overlay,
            '带 .t-root 的元素': tRootTags,
        },
        note: 'body.append 调用点数 ≠ 挂载根数（同一根可被多处复用、也有非根元素直接 append）。'
            + '新增窗口/弹窗根时记得带上 .t-root，否则该处会丢失排版基准（plan.md §8.2、风险 R5）',
    };
});

// ── A1 补充指标：规模与其它计数（用于与 plan.md §1.2 对比）───
function collectScaleMetrics() {
    let lines = 0, rules = 0, radius = 0, shadow = 0, fontSizePx = 0, fontSizeEm = 0, padding = 0, gap = 0;
    const radiusVals = new Set(), shadowVals = new Set();
    for (const f of styleSources) {
        lines += f.raw.split('\n').length;
        for (const r of f.rules) {
            if (!r.isAtContainer && !r.isKeyframes) rules++;
            for (const d of r.decls) {
                if (d.prop === 'border-radius') { radius++; radiusVals.add(d.value.trim().toLowerCase()); }
                if (d.prop === 'box-shadow') { shadow++; shadowVals.add(d.value.trim().toLowerCase()); }
                if (d.prop === 'font-size') { if (/px/.test(d.value)) fontSizePx++; else if (/em/.test(d.value)) fontSizeEm++; }
                if (d.prop === 'padding') padding++;
                if (d.prop === 'gap') gap++;
            }
        }
    }
    return {
        'CSS 总行数': lines,
        '规则条数': rules,
        'border-radius 声明 / 不同值': `${radius} / ${radiusVals.size}`,
        'box-shadow 声明 / 不同值': `${shadow} / ${shadowVals.size}`,
        'font-size (px / em)': `${fontSizePx} / ${fontSizeEm}`,
        'padding / gap 声明': `${padding} / ${gap}`,
    };
}

// ─────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────

const RESET = '\x1b[0m', DIM = '\x1b[2m', RED = '\x1b[31m', YEL = '\x1b[33m', GRN = '\x1b[32m', CYA = '\x1b[36m', BLD = '\x1b[1m';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => useColor ? `${code}${s}${RESET}` : String(s);

console.log('');
console.log(c(BLD, '  Titania Theater —— CSS 分层规则审计'));
console.log(c(DIM, `  模式：${STRICT ? '阻断（--strict）' : '报告（仅 Phase 0 阻断项会致失败）'}`));
console.log(c(DIM, `  样式来源：${cssFiles.filter(f => f.raw !== null).length} 个 CSS + ${htmlFiles.length} 个内嵌 <style>；JS：${jsFiles.length} 个`));
console.log('');

let failCount = 0, warnCount = 0, skipCount = 0;

for (const r of results) {
    const n = r.violations.length;
    let icon, label;
    if (r.skipped) { icon = c(DIM, '○'); label = c(DIM, `跳过 —— ${r.skipped}`); skipCount++; }
    else if (n === 0) { icon = c(GRN, '✓'); label = c(GRN, '通过'); }
    else if (r.blocking) { icon = c(RED, '✗'); label = c(RED, `${n} 处违规（阻断）`); failCount++; }
    else { icon = c(YEL, '!'); label = c(YEL, `${n} 处（报告）`); warnCount++; }

    const ruleTag = r.rule === '—' ? '    ' : c(CYA, r.rule.padEnd(4));
    console.log(`  ${icon} ${c(BLD, r.id.padEnd(4))}${ruleTag} ${r.title}`);
    console.log(`         ${label}`);

    for (const [k, v] of Object.entries(r.metrics)) {
        console.log(c(DIM, `         ${k}: ${v}`));
    }
    if (r.note) console.log(c(DIM, `         注：${r.note}`));

    if (n > 0) {
        const show = VERBOSE ? r.violations : r.violations.slice(0, 3);
        for (const v of show) console.log(c(DIM, `           · ${v.loc} — ${v.msg}`));
        if (!VERBOSE && n > 3) console.log(c(DIM, `           … 另有 ${n - 3} 处，加 --verbose 查看全部`));
    }
    console.log('');
}

console.log(c(BLD, '  规模指标（对照 plan.md §1.2）'));
for (const [k, v] of Object.entries(collectScaleMetrics())) {
    console.log(c(DIM, `    ${k}: ${v}`));
}
console.log('');

console.log(c(BLD, `  小结：${failCount} 项阻断 / ${warnCount} 项报告 / ${skipCount} 项跳过`));

// ── 基线快照 ─────────────────────────────────────────────────
function buildSnapshot() {
    const snap = { checks: {}, scale: collectScaleMetrics() };
    for (const r of results) {
        snap.checks[r.id] = { title: r.title, violations: r.skipped ? null : r.violations.length, metrics: r.metrics };
    }
    return snap;
}

const snapshot = buildSnapshot();

if (UPDATE_BASELINE) {
    writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    console.log(c(GRN, `  已写入基线：${path.relative(ROOT, BASELINE_PATH)}`));
} else if (COMPARE) {
    if (!existsSync(BASELINE_PATH)) {
        console.log(c(YEL, `  无基线文件，先运行：node scripts/css-audit.js --update-baseline`));
    } else {
        const base = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
        console.log('');
        console.log(c(BLD, '  与基线对比'));
        let any = false;
        for (const [id, cur] of Object.entries(snapshot.checks)) {
            const prev = base.checks?.[id];
            if (!prev || prev.violations === cur.violations) continue;
            any = true;
            const delta = (cur.violations ?? 0) - (prev.violations ?? 0);
            const arrow = delta > 0 ? c(RED, `+${delta} 恶化`) : c(GRN, `${delta} 改善`);
            console.log(`    ${id} ${cur.title}: ${prev.violations} → ${cur.violations}  ${arrow}`);
        }
        for (const [k, cur] of Object.entries(snapshot.scale)) {
            const prev = base.scale?.[k];
            if (prev === undefined || String(prev) === String(cur)) continue;
            any = true;
            console.log(`    ${k}: ${prev} → ${cur}`);
        }
        if (!any) console.log(c(DIM, '    无变化'));
    }
}

console.log('');
if (failCount > 0) {
    console.log(c(RED, `  ✗ 审计未通过：${failCount} 项阻断检查存在违规`));
    console.log('');
    process.exit(1);
}
console.log(c(GRN, '  ✓ 审计通过'));
console.log('');
