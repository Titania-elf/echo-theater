import { isProtectedRewriteElement } from '../core/textRewritePatch.js';

const BLOCK_TAGS = new Set(['P', 'DIV', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'MAIN']);

/** Snapshot static prose in separate blocks; protected components are hard boundaries. */
export function collectRewriteTextGroups(container, whitelist = []) {
    const groups = [];
    let current = { text: '', spans: [] };
    const flush = () => { if (current.text.trim()) groups.push(current); current = { text: '', spans: [] }; };
    const append = (text, node = null) => {
        current.spans.push({ node, start: current.text.length, end: current.text.length + text.length, original: text });
        current.text += text;
    };
    const visit = element => {
        for (const child of element.childNodes) {
            if (child.nodeType === 3) { append(child.data, child); continue; }
            if (child.nodeType !== 1) continue;
            if (child.tagName === 'BR') { append('\n'); continue; }
            const attributes = Array.from(child.attributes).map(attr => `${attr.name}="${attr.value}"`).join(' ');
            const style = child.ownerDocument.defaultView?.getComputedStyle(child);
            const component = Object.keys(child).some(key => /^(?:__vue|__react|_reactRoot)/.test(key));
            if (component || child.hidden || child.getAttribute('aria-hidden') === 'true' ||
                style?.display === 'none' || style?.visibility === 'hidden' ||
                isProtectedRewriteElement(child.tagName, attributes, whitelist)) { flush(); continue; }
            const block = BLOCK_TAGS.has(child.tagName) || ['block', 'flex', 'grid', 'table', 'list-item'].includes(style?.display);
            if (block) flush();
            visit(child);
            if (block) flush();
        }
    };
    const rootStyle = container?.ownerDocument.defaultView?.getComputedStyle(container);
    const rootComponent = container && Object.keys(container).some(key => /^(?:__vue|__react|_reactRoot)/.test(key));
    if (container && !rootComponent && !container.closest('[hidden], [aria-hidden="true"], .TH-render, [contenteditable="true"]') && rootStyle?.display !== 'none' && rootStyle?.visibility !== 'hidden') visit(container);
    flush();
    return groups;
}

/** Use the whole source run as context. Identical standalone runs are preview-only. */
export function locateRewriteRange(groups, projection, patch) {
    const run = patch.run;
    const anchor = run.text.trim();
    if (!anchor || projection.runs.filter(item => item.text.trim() === anchor).length !== 1) return { reason: '重复段落无法确定显示顺序，仅保留预览' };
    const matches = [];
    for (const group of groups) {
        let cursor = 0;
        let start;
        while ((start = group.text.indexOf(anchor, cursor)) >= 0) {
            matches.push({ group, start });
            cursor = start + anchor.length;
        }
    }
    if (matches.length !== 1) return { reason: matches.length ? '显示中存在多个相同正文，无法唯一定位' : '当前前端未显示可对应的静态正文（可能在 iframe 或动态组件中）' };
    const { group, start } = matches[0];
    const leading = run.text.length - run.text.trimStart().length;
    const from = start + patch.local - leading;
    const to = from + patch.before.length;
    if (from < start || to > start + anchor.length || group.text.slice(from, to) !== patch.before) return { reason: '原文空白或显示格式无法可靠对应' };
    const covered = group.spans.filter(span => span.end > from && span.start < to);
    if (!covered.length || covered.some(span => !span.node)) return { reason: '替换范围跨越前端换行结构，仅保留预览' };
    return { group, from, to, covered, reason: '' };
}

export function buildRewriteDomChanges(plans) {
    const edits = new Map();
    for (const { patch, range } of plans) {
        range.covered.forEach((span, index) => {
            const list = edits.get(span.node) || [];
            list.push({ start: Math.max(0, range.from - span.start), end: Math.min(span.original.length, range.to - span.start), after: index === 0 ? patch.replacement : '' });
            edits.set(span.node, list);
        });
    }
    return Array.from(edits, ([node, list]) => {
        const original = node.data;
        let after = original;
        let boundary = original.length;
        for (const edit of list.sort((a, b) => b.start - a.start)) {
            if (edit.end > boundary) throw new Error('显示补丁范围发生重叠');
            after = after.slice(0, edit.start) + edit.after + after.slice(edit.end);
            boundary = edit.start;
        }
        return { node, parent: node.parentNode, original, after };
    });
}

export function rewriteDomStillMatches(container, changes) {
    return !!container?.isConnected && changes.every(change => container.contains(change.node) && change.node.parentNode === change.parent && change.node.data === change.original);
}

export function applyRewriteDomChanges(changes) {
    // Keep every Text node, element, listener and iframe instance intact.
    for (const change of changes) change.node.data = change.after;
}

export function rollbackRewriteDomChanges(changes) {
    for (const change of changes) {
        if (change.node.parentNode === change.parent && change.node.data === change.after) change.node.data = change.original;
    }
}

export function rangeForRewriteMatch(document, match) {
    if (match.reason || !match.covered?.length) return null;
    const first = match.covered[0];
    const last = match.covered.at(-1);
    const range = document.createRange();
    range.setStart(first.node, match.from - first.start);
    range.setEnd(last.node, match.to - last.start);
    return range;
}
