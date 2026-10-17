import {
    getStoryMemoryView, subscribeStoryMemory, setStoryMemoryEnabled, runStoryMemory,
    editStoryMemoryItem, editStoryMemoryNarrative, undoStoryMemory, readStoryMemorySources,
} from '../core/storyMemory.js';
import { openStoryMemorySettingsWindow } from './storyMemorySettingsWindow.js';
import { graphFocusNames, relationNames, renderMemoryGraph } from './storyMemoryGraph.js';
import { claimFloatingWindow, releaseFloatingWindow } from './shared/floatingWindow.js';
import { ensureFeatureCss } from '../utils/dom.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const STATUS = { idle: '等待下一段剧情', summarizing: '正在后台整理…', waiting: '已整理，等待生成结束后应用', rebuilding: '正文有变化，正在重整', error: '暂未完成，正文已保留' };
const THREAD_STATUS = { open: '未解决', progress: '有进展', resolved: '已解决' };
const TABS = [
    ['current', '当前剧情', 'fa-compass'],
    ['relationships', '人物关系', 'fa-user-group'],
    ['threads', '伏笔与约定', 'fa-link'],
    ['records', '整理记录', 'fa-clock-rotate-left'],
    ['preview', '注入预览', 'fa-eye'],
];
let closeWindow = null;

export function openStoryMemoryWindow() {
    closeWindow?.();
    ensureFeatureCss('story-memory.css');
    const root = document.createElement('div');
    root.className = 't-overlay t-root t-memory-overlay';
    root.innerHTML = `<section class="t-box t-memory-window" role="dialog" aria-modal="true" aria-labelledby="t-memory-title">
        <header class="t-header"><div class="t-memory-title"><i class="fa-solid fa-brain"></i><div><strong id="t-memory-title">故事记忆</strong><small data-role="chat-name"></small></div></div>
            <div class="t-memory-header-actions"><button type="button" class="t-tool-btn" data-action="settings" title="运行设置" aria-label="打开运行设置"><i class="fa-solid fa-gear"></i></button>
            <button type="button" class="t-tool-btn" data-action="close" aria-label="关闭故事记忆"><i class="fa-solid fa-xmark"></i></button></div></header>
        <div class="t-memory-toolbar"><label class="t-memory-toggle"><input type="checkbox" data-role="enabled"> 后台自动整理</label>
            <span class="t-memory-status" data-role="status" role="status" aria-live="polite"></span>
            <button type="button" class="t-btn" data-action="run"><i class="fa-solid fa-wand-magic-sparkles"></i> 立即整理</button></div>
        <div class="t-memory-metrics" data-role="metrics"></div><div class="t-memory-error" data-role="error" role="alert" hidden></div>
        <nav class="t-memory-tabs" aria-label="记忆内容">${TABS.map(([id, label, icon]) => `<button type="button" class="t-btn" data-tab="${id}" aria-label="${label}"><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${label}</span><span class="t-memory-tab-count" data-count="${id}"></span></button>`).join('')}</nav>
        <main class="t-memory-body" data-role="body"></main>
        <footer class="t-memory-footer">记忆随当前聊天保存 · 暂停自动整理后，已有记忆继续注入</footer>
    </section>`;
    let tab = 'current';
    let editor = null;
    let source = null;
    let settingsClose = null;
    let filter = 'all';
    let query = '';
    let graphSelection = '';
    let graphOpen = true;
    const expanded = new Set();
    let previousKey = '';
    let localBusy = false;
    let localError = '';
    const priorFocus = document.activeElement;
    let unsubscribe = () => {};
    const close = () => {
        settingsClose?.();
        unsubscribe();
        document.removeEventListener('keydown', onKeydown, true);
        root.remove();
        releaseFloatingWindow(close);
        if (closeWindow === close) closeWindow = null;
        if (priorFocus?.isConnected) priorFocus.focus?.();
    };
    closeWindow = close;
    claimFloatingWindow(close);
    document.body.appendChild(root);

    const field = (label, name, value, multiline = true) => `<label class="t-memory-field"><span>${escape(label)}</span>${multiline
        ? `<textarea class="t-input" data-field="${name}" rows="5">${escape(value)}</textarea>`
        : `<input class="t-input" data-field="${name}" value="${escape(value)}" maxlength="200">`}</label>`;
    const button = (action, text, attrs = '') => `<button type="button" class="t-btn" data-action="${action}" ${attrs}>${text}</button>`;
    const iconButton = (action, icon, label, attrs = '') => `<button type="button" class="t-icon-btn t-memory-icon-btn" data-action="${action}" title="${escape(label)}" aria-label="${escape(label)}" ${attrs}><i class="fa-solid ${icon}" aria-hidden="true"></i></button>`;
    const badge = (text, cls) => `<span class="t-memory-badge ${cls}">${escape(text)}</span>`;
    const avatarClass = name => {
        let hash = 0;
        for (const char of String(name || '')) hash = (hash * 31 + (char.codePointAt(0) || 0)) >>> 0;
        return hash % 4;
    };
    const person = name => {
        const text = String(name || '').trim();
        if (!text) return '';
        return `<span class="t-memory-person"><span class="t-memory-avatar t-memory-avatar--${avatarClass(text)}">${escape([...text][0] || '?')}</span><strong>${escape(text)}</strong></span>`;
    };
    function textBlock(text, key, placeholder = '') {
        const value = String(text || '').trim();
        if (!value) return `<p class="t-memory-empty-inline">${escape(placeholder || '暂无内容')}</p>`;
        const long = value.length > 180;
        const open = expanded.has(key);
        return `<p class="t-memory-text${long && !open ? ' is-clamped' : ''}">${escape(value)}</p>${long
            ? `<button type="button" class="t-memory-more" data-action="expand" data-key="${escape(key)}">${open ? '收起' : '展开全文'}</button>`
            : ''}`;
    }
    function sourceChips(item) {
        const seen = new Set();
        const sources = [];
        for (const source of item.sources || []) {
            const start = Number(source.start);
            const end = Number(source.end);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            const key = `${start}-${end}`;
            if (seen.has(key)) continue;
            seen.add(key);
            sources.push({ start, end });
        }
        if (!sources.length) return '<span class="t-memory-hint">无原文来源</span>';
        const chips = sources.slice(0, 2).map(source => `<button type="button" class="t-memory-source-chip" data-action="segment-source" data-start="${source.start}" data-end="${source.end}" title="查看第 ${source.start}～${source.end} 楼原文"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> 第 ${source.start}～${source.end} 楼</button>`).join('');
        const rest = sources.length > 2 ? `<span class="t-memory-source-chip is-static">+${sources.length - 2}</span>` : '';
        return `<div class="t-memory-sources">${chips}${rest}</div>`;
    }
    function renderSuggestion(item, kind) {
        const pending = item.pending;
        if (!pending) return '';
        const status = kind === 'threads' && pending.status ? `<span>· ${THREAD_STATUS[pending.status] || ''}</span>` : '';
        const titleChange = pending.title && pending.title !== item.title ? `<p class="t-memory-suggestion-title">标题：${escape(pending.title)}</p>` : '';
        const evidence = pending.source?.evidence ? `<blockquote>${escape(pending.source.evidence)}</blockquote>` : '';
        const attrs = `data-kind="${kind}" data-id="${escape(item.id)}"`;
        return `<div class="t-memory-suggestion">
            <div class="t-memory-suggestion-head"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><strong>有新的修改建议</strong>${status}</div>
            <div class="t-memory-suggestion-grid"><div><small>现在</small><p>${escape(item.body || '')}</p></div><div><small>建议</small><p>${escape(pending.body || '')}</p></div></div>
            ${titleChange}${evidence}
            <div class="t-memory-card-actions">${button('accept', '采用建议', attrs)}${button('dismiss', '忽略', attrs)}</div>
        </div>`;
    }
    function cardActions(kind, item) {
        const attrs = `data-kind="${kind}" data-id="${escape(item.id)}"`;
        return `<div class="t-memory-card-actions t-memory-icon-actions">${iconButton('edit', 'fa-pen', '编辑', attrs)}${iconButton('lock', item.locked ? 'fa-lock-open' : 'fa-lock', item.locked ? '解锁' : '锁定', attrs)}${iconButton('history', 'fa-clock-rotate-left', '来源与变化', attrs)}</div>`;
    }
    function defaultBadges(kind, item) {
        const badges = [];
        if (kind === 'threads') badges.push(badge(THREAD_STATUS[item.status] || THREAD_STATUS.open, `is-${item.status || 'open'}`));
        if (item.locked) badges.push(badge('已锁定', 'is-locked'));
        if (item.manual) badges.push(badge('人工维护', 'is-manual'));
        if (item.pending) badges.push(badge('待确认', 'is-pending'));
        if (kind === 'relationships' && !item.locked && !item.manual) badges.push(badge('自动整理', 'is-auto'));
        return badges.join('');
    }
    function renderRelationship(item, focusNames) {
        const [left, right] = relationNames(item.title);
        const focused = focusNames.length > 0 && focusNames.some(name => `${left}\n${right}\n${item.title}\n${item.body}`.includes(name));
        return `<article class="t-memory-card t-memory-rel-card${item.locked ? ' is-locked' : ''}${item.pending ? ' is-pending' : ''}${focused ? ' is-focus' : ''}" data-card-kind="relationships" data-card-id="${escape(item.id)}">
            <div class="t-memory-rel-head"><div class="t-memory-rel-people">${person(left)}${right ? `<i class="fa-solid fa-arrow-right-long" aria-hidden="true"></i>${person(right)}` : ''}</div><div class="t-memory-badges">${defaultBadges('relationships', item)}</div></div>
            ${renderSuggestion(item, 'relationships')}
            ${textBlock(item.body, `rel:${item.id}`, '尚无关系描述。')}
            <div class="t-memory-card-footer">${sourceChips(item)}${cardActions('relationships', item)}</div>
        </article>`;
    }
    function threadStatusIcon(status) {
        return status === 'resolved' ? 'fa-circle-check' : status === 'progress' ? 'fa-circle-half-stroke' : 'fa-circle';
    }
    function renderThread(item, focusNames, focusThreadId) {
        const status = item.status || 'open';
        const focused = focusThreadId ? item.id === focusThreadId : focusNames.some(name => `${item.title}\n${item.body}`.includes(name));
        return `<article class="t-memory-card t-memory-thread-card is-${status}${item.locked ? ' is-locked' : ''}${item.pending ? ' is-pending' : ''}${focused ? ' is-focus' : ''}" data-card-kind="threads" data-card-id="${escape(item.id)}">
            <div class="t-memory-thread-head"><span class="t-memory-status-icon is-${status}" aria-hidden="true"><i class="fa-solid ${threadStatusIcon(status)}"></i></span><strong>${escape(item.title)}</strong><div class="t-memory-badges">${defaultBadges('threads', item)}</div></div>
            ${renderSuggestion(item, 'threads')}
            ${textBlock(item.body, `thread:${item.id}`, '尚无内容。')}
            <div class="t-memory-card-footer">${sourceChips(item)}${cardActions('threads', item)}</div>
        </article>`;
    }
    function filterDefs(kind) {
        return kind === 'relationships'
            ? [['all', '全部'], ['pending', '待确认'], ['locked', '已锁定'], ['manual', '人工维护']]
            : [['all', '全部'], ['open', '未解决'], ['progress', '有进展'], ['resolved', '已解决'], ['pending', '待确认']];
    }
    function filterCounts(items) {
        return {
            all: items.length,
            pending: items.filter(item => item.pending).length,
            locked: items.filter(item => item.locked).length,
            manual: items.filter(item => item.manual).length,
            open: items.filter(item => (item.status || 'open') === 'open').length,
            progress: items.filter(item => item.status === 'progress').length,
            resolved: items.filter(item => item.status === 'resolved').length,
        };
    }
    function renderFilterBar(kind, items) {
        const counts = filterCounts(items);
        return `<div class="t-memory-filterbar"><div class="t-memory-pills" role="group" aria-label="筛选">${filterDefs(kind).map(([value, label]) => `<button type="button" class="t-memory-pill${filter === value ? ' is-active' : ''}" data-action="set-filter" data-filter="${value}">${label}<span>${counts[value] || 0}</span></button>`).join('')}</div>
            <label class="t-memory-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" data-role="memory-search" value="${escape(query)}" placeholder="搜索${kind === 'relationships' ? '人物或关系' : '伏笔或约定'}" aria-label="搜索${kind === 'relationships' ? '人物或关系' : '伏笔或约定'}"></label></div>`;
    }
    function visibleItems(items) {
        const term = query.trim().toLowerCase();
        return items.filter(item => {
            if (term && !`${item.title || ''}\n${item.body || ''}`.toLowerCase().includes(term)) return false;
            if (filter === 'all') return true;
            if (filter === 'pending') return !!item.pending;
            if (filter === 'locked') return !!item.locked;
            if (filter === 'manual') return !!item.manual;
            return (item.status || 'open') === filter;
        });
    }
    function statTile(tabName, filterValue, count, label, icon) {
        return `<button type="button" class="t-memory-stat" data-jump-tab="${tabName}" data-jump-filter="${filterValue}"><i class="fa-solid ${icon}" aria-hidden="true"></i><strong>${count}</strong><span>${label}</span></button>`;
    }
    function graphPanel(memory, focusNames, focusThreadId) {
        const label = graphSelection.startsWith('c:')
            ? graphSelection.slice(2)
            : graphSelection.startsWith('t:')
                ? (memory.threads.find(item => `t:${item.id}` === graphSelection)?.title || '所选伏笔')
                : '';
        return `<section class="t-memory-graph-panel">
            <div class="t-memory-graph-head"><strong><i class="fa-solid fa-diagram-project" aria-hidden="true"></i> 关系图</strong>
                <div class="t-memory-card-actions">${graphSelection ? button('clear-graph', '清除聚焦') : ''}${button('toggle-graph', graphOpen ? '收起' : '展开')}</div></div>
            ${graphOpen ? renderMemoryGraph(memory, { selected: graphSelection }) : ''}
            ${graphSelection ? `<p class="t-memory-graph-focus">已聚焦：${escape(label)}${focusThreadId ? ' · 只显示这条伏笔' : focusNames.length ? ` · 只显示涉及 ${escape(focusNames.join('、'))} 的条目` : ''}</p>` : ''}
        </section>`;
    }
    function renderCurrent(view) {
        const memory = view.memory;
        const segments = memory.segments || [];
        const last = segments.at(-1);
        const end = last?.end;
        const total = view.total || 0;
        const pct = total > 0 && end != null ? Math.min(100, Math.round(((end + 1) / total) * 100)) : 0;
        const pending = [...memory.relationships, ...memory.threads].filter(item => item.pending).length;
        const activeThreads = memory.threads.filter(item => item.status !== 'resolved').length;
        const pendingTab = memory.threads.some(item => item.pending) ? 'threads' : 'relationships';
        const recap = String(memory.recap || '').trim();
        const beats = recap ? recap.split(/\n+/).filter(Boolean) : [];
        const timeline = beats.length > 1
            ? beats.map((beat, index) => `<div class="t-memory-beat">${textBlock(beat, `current:recap:${index}`)}</div>`).join('')
            : `<div class="t-memory-beat">${textBlock(recap, 'current:recap', '开启后台自动整理后，较早正文会在这里形成连续的剧情脉络。')}</div>`;
        const lastLabel = last?.createdAt ? escape(new Date(last.createdAt).toLocaleString()) : '';
        return `<div class="t-memory-section-heading"><strong><i class="fa-solid fa-compass" aria-hidden="true"></i> 故事走到了哪里</strong>${button('edit-narrative', '编辑')}</div>
            <div class="t-memory-progress"><div class="t-memory-progress-meta"><span><i class="fa-solid fa-circle-dot" aria-hidden="true"></i> ${end == null ? '尚未整理正文' : `已整理至第 ${end} 楼`}</span><span>最近 ${view.config.keep_floors} 楼保留原文</span></div><div class="t-memory-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="整理进度"><span style="width:${pct}%"></span></div></div>
            <div class="t-memory-stats">${statTile('records', 'all', segments.length, '整理段数', 'fa-layer-group')}${statTile('relationships', 'all', memory.relationships.length, '人物关系', 'fa-user-group')}${statTile('threads', 'all', activeThreads, '未解决伏笔', 'fa-link')}${statTile(pendingTab, 'pending', pending, '待确认建议', 'fa-wand-magic-sparkles')}</div>
            <div class="t-memory-current-grid">
                <article class="t-memory-card t-memory-timeline"><div class="t-memory-card-heading"><h3><i class="fa-solid fa-book-open" aria-hidden="true"></i> 历史脉络</h3>${last ? `<small>截至第 ${last.end} 楼</small>` : ''}</div><div class="t-memory-timeline-body">${timeline}</div><div class="t-memory-timeline-foot"><span>起</span><span>现在</span></div></article>
                <article class="t-memory-card t-memory-now"><div class="t-memory-card-heading"><h3><i class="fa-solid fa-location-dot" aria-hidden="true"></i> 此刻</h3><small>${end == null ? '尚未整理' : `截至第 ${end} 楼`}</small></div>${textBlock(String(memory.scene || ''), 'current:scene', '保留地点、处境、目标及未解决的冲突；最新发展继续由最近正文提供。')}<div class="t-memory-now-foot">${last ? `<button type="button" class="t-memory-link" data-jump-tab="records" data-jump-filter="all"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i> 最近整理：第 ${last.start}～${last.end} 楼${lastLabel ? ` · ${lastLabel}` : ''}</button>` : '<span class="t-memory-hint">还没有整理记录。</span>'}</div></article>
            </div>`;
    }
    function renderThreadGroups(items, focusNames, focusThreadId) {
        const groups = [['open', '未解决'], ['progress', '有进展'], ['resolved', '已解决']];
        return groups.map(([status, label]) => {
            const groupItems = items.filter(item => (item.status || 'open') === status);
            if (!groupItems.length) return '';
            const cards = groupItems.map(item => renderThread(item, focusNames, focusThreadId)).join('');
            if (status === 'resolved') {
                return `<details class="t-memory-archive t-memory-group"${filter === 'resolved' ? ' open' : ''}><summary><span class="t-memory-group-dot is-resolved" aria-hidden="true"></span>${label} · ${groupItems.length} 项</summary><div class="t-memory-card-grid">${cards}</div></details>`;
            }
            return `<section class="t-memory-group"><h4 class="t-memory-group-head"><span class="t-memory-group-dot is-${status}" aria-hidden="true"></span><strong>${label}</strong><span>${groupItems.length}</span></h4><div class="t-memory-card-grid">${cards}</div></section>`;
        }).join('');
    }
    function emptyState(kind) {
        return `<div class="t-memory-empty"><i class="fa-solid ${kind === 'relationships' ? 'fa-user-group' : 'fa-link'}" aria-hidden="true"></i><p>${kind === 'relationships' ? '还没有人物关系。自动整理会从正文中提取，也可以手动添加。' : '还没有伏笔与约定。自动整理会从正文中提取，也可以手动添加。'}</p>${button('add', '新增条目', `data-kind="${kind}"`)}</div>`;
    }
    function emptyFiltered() {
        return `<div class="t-memory-empty"><i class="fa-solid fa-filter-circle-xmark" aria-hidden="true"></i><p>${graphSelection ? '已按关系图聚焦，但没有匹配的条目。' : '没有符合筛选条件的条目。'}</p><div class="t-memory-card-actions">${button('clear-filter', '清除筛选')}</div></div>`;
    }
    function renderItemsTab(view, kind) {
        const memory = view.memory;
        const items = kind === 'relationships' ? memory.relationships : memory.threads;
        if (!items.length) return emptyState(kind);
        const focusNames = graphFocusNames(memory, graphSelection);
        const focusThreadId = graphSelection.startsWith('t:') ? graphSelection.slice(2) : '';
        let shown = visibleItems(items);
        if (graphSelection) {
            shown = shown.filter(item => kind === 'relationships'
                ? focusNames.some(name => `${item.title || ''}\n${item.body || ''}`.includes(name))
                : (focusThreadId ? item.id === focusThreadId : focusNames.some(name => `${item.title || ''}\n${item.body || ''}`.includes(name))));
        }
        const heading = kind === 'relationships' ? '关系、矛盾与知情边界' : '悬念、承诺与未完成目标';
        return `${graphPanel(memory, focusNames, focusThreadId)}
            <div class="t-memory-section-heading"><strong>${heading}</strong>${button('add', '新增条目', `data-kind="${kind}"`)}</div>
            ${renderFilterBar(kind, items)}
            ${graphSelection ? `<p class="t-memory-focus-hint">关系图聚焦中，只显示相关条目。${button('clear-graph', '清除')}</p>` : ''}
            ${shown.length
                ? (kind === 'relationships' ? `<div class="t-memory-card-grid">${shown.map(item => renderRelationship(item, focusNames)).join('')}</div>` : renderThreadGroups(shown, focusNames, focusThreadId))
                : emptyFiltered()}`;
    }

    function renderEditor() {
        let html = `<div class="t-memory-section-heading"><strong>${editor.kind === 'narrative' ? '编辑剧情记忆' : editor.kind === 'summary' ? '编辑分段摘要' : editor.kind === 'relationships' ? '编辑人物关系' : '编辑伏笔与约定'}</strong></div>`;
        if (editor.kind === 'narrative') html += field('历史脉络', 'recap', editor.recap) + field('截至整理范围的剧情状态', 'scene', editor.scene);
        else if (editor.kind === 'summary') html += field('分段摘要（用于归档；当前注入脉络可在「当前剧情」编辑）', 'summary', editor.summary);
        else {
            html += field(editor.kind === 'relationships' ? '关系方向，例如「林岚 → 顾舟」' : '悬念、承诺或目标', 'title', editor.title, false);
            html += field(editor.kind === 'relationships' ? '当前态度、变化原因、矛盾和知情边界' : '类型、事实、进展和知情边界', 'body', editor.body);
            if (editor.kind === 'threads') html += `<label class="t-memory-field"><span>状态</span><select class="t-input" data-field="status">${Object.entries(THREAD_STATUS).map(([value, label]) => `<option value="${value}" ${editor.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
        }
        return `<div class="t-memory-editor">${html}<p class="t-memory-hint">人工编辑的条目在自动整理时保留，新变化会作为建议展示。</p><div class="t-memory-card-actions">${button('save-edit', '保存')}${button('cancel-edit', '取消')}</div></div>`;
    }

    function renderContent(view) {
        const memory = view.memory;
        if (!view.available) return '<div class="t-memory-empty"><i class="fa-solid fa-comments"></i><p>打开一段角色聊天后，即可为这段故事建立记忆。</p></div>';
        if (source) return `<div class="t-memory-section-heading"><strong>${escape(source.title)}</strong>${button('close-source', '返回')}</div>
            ${source.links?.length ? `<div class="t-memory-card-actions">${source.links.map(entry => button('segment-source', `查看第 ${entry.start}～${entry.end} 楼原文`, `data-start="${entry.start}" data-end="${entry.end}"`)).join('')}</div>` : ''}
            <pre class="t-memory-source">${escape(source.text)}</pre>`;
        if (editor) return renderEditor();
        if (tab === 'preview') return `<p class="t-memory-hint">以下内容通过独立提示词持续注入，不添加聊天楼层。估算约 ${view.injection.tokens} token（记忆 ${view.injection.memoryTokens} · 最近分段 ${view.injection.recentTokens} · 旧事召回 ${view.injection.recallTokens}）。</p>
            ${view.injection.overBudget ? '<p class="t-memory-error">历史脉络和锁定条目已超过目标预算，请精简内容或提高预算。</p>' : ''}
            ${view.injection.omitted.length ? `<p class="t-memory-error">本轮预算未容纳：${escape(view.injection.omitted.join('、'))}。条目仍保存在记忆中，可锁定重要条目或提高预算。</p>` : ''}
            ${view.injection.recent?.length ? `<p class="t-memory-hint">本轮直接注入最近整理的分段：${escape(view.injection.recent.map(entry => entry.title).join('、'))}。这些摘要只压缩过一次，比历史脉络更细。</p>` : ''}
            ${view.injection.recentOmitted?.length ? `<p class="t-memory-error">最近分段预算未容纳：${escape(view.injection.recentOmitted.join('、'))}。可提高「最近分段摘要最多占多少 token」或减少注入段数。</p>` : ''}
            ${view.injection.recalled?.length ? `<p class="t-memory-hint">本轮从旧段落召回：${escape(view.injection.recalled.map(entry => entry.title).join('、'))}。召回只按最近对话的关键词匹配，不代表这些旧事一定与本轮有关。</p>` : ''}
            ${view.injection.recallOmitted?.length ? `<p class="t-memory-error">召回预算未容纳：${escape(view.injection.recallOmitted.join('、'))}。可提高「召回内容最多占多少 token」或减少召回段数。</p>` : ''}
            <pre class="t-memory-source">${escape(view.injection.text || '尚未建立记忆。')}</pre>`;
        if (tab === 'current') return renderCurrent(view);
        if (tab === 'relationships' || tab === 'threads') return renderItemsTab(view, tab);
        return `<div class="t-memory-section-heading"><strong>已整理 ${memory.segments.length} 段</strong><div class="t-memory-card-actions">${button('undo', '撤销最近整理', memory.segments.length ? '' : 'disabled')}${button('undo-all', '撤销全部整理', memory.segments.length ? '' : 'disabled')}</div></div>
            <p class="t-memory-hint">撤销会恢复对应正文，并暂停自动整理。原先由你或其他插件隐藏的楼层保持原状态。</p>
            ${[...memory.segments].reverse().map(segment => `<article class="t-memory-card"><div class="t-memory-card-heading"><strong>第 ${segment.start}～${segment.end} 楼</strong><small>${escape(new Date(segment.createdAt).toLocaleString())}</small></div>
                <p class="t-memory-text">${escape(segment.summary)}</p><div class="t-memory-card-actions">${button('segment-source', '查看原文', `data-start="${segment.start}" data-end="${segment.end}"`)}${button('edit-summary', '编辑摘要', `data-id="${escape(segment.id)}"`)}</div></article>`).join('') || '<p class="t-memory-empty">尚未整理。最近正文会完整保留，较早正文达到触发条件后自动处理。</p>'}`;
    }

    function render() {
        if (!root.isConnected) return;
        let view;
        try { view = getStoryMemoryView(); }
        catch (cause) {
            root.querySelector('[data-role="body"]').textContent = cause.message;
            return;
        }
        if (previousKey && previousKey !== view.key) {
            editor = null; source = null; localError = '';
            filter = 'all'; query = ''; graphSelection = ''; expanded.clear();
        }
        previousKey = view.key;
        root.querySelector('[data-role="chat-name"]').textContent = view.chatName || '当前聊天';
        const enabled = root.querySelector('[data-role="enabled"]');
        enabled.checked = view.memory.enabled;
        enabled.disabled = !view.available || view.generating || localBusy || !!writingView(view);
        root.querySelector('[data-role="status"]').textContent = view.status === 'idle' && !view.memory.enabled ? '自动整理已暂停' : STATUS[view.status];
        root.querySelector('[data-action="run"]').disabled = !view.available || !view.memory.enabled || view.busy || view.generating || localBusy;
        const end = view.memory.segments.at(-1)?.end;
        root.querySelector('[data-role="metrics"]').textContent = `${end == null ? '尚未整理正文' : `已整理至第 ${end} 楼`} · 至少保留最近 ${view.config.keep_floors} 楼 · 记忆约 ${view.injection.tokens} token${view.batch ? ` · 待整理第 ${view.batch.start}～${view.batch.end} 楼` : ''}`;
        const counts = {
            relationships: view.memory.relationships.length,
            threads: view.memory.threads.filter(item => item.status !== 'resolved').length,
            records: view.memory.segments.length,
        };
        root.querySelectorAll('[data-count]').forEach(element => {
            const count = counts[element.dataset.count];
            element.textContent = count ? String(count) : '';
        });
        const alert = root.querySelector('[data-role="error"]');
        alert.hidden = !(localError || view.error);
        alert.textContent = localError || view.error;
        root.querySelectorAll('[data-tab]').forEach(element => {
            element.classList.toggle('is-active', element.dataset.tab === tab);
            element.setAttribute('aria-current', element.dataset.tab === tab ? 'page' : 'false');
        });
        const body = root.querySelector('[data-role="body"]');
        const scroll = body.scrollTop;
        const focused = document.activeElement;
        const focusedSearch = body.contains(focused) && focused?.dataset?.role === 'memory-search' ? focused : null;
        const focusedNode = body.contains(focused) && focused?.matches?.('[data-node]') ? focused.dataset.node : '';
        const searchRange = focusedSearch && typeof focusedSearch.selectionStart === 'number'
            ? [focusedSearch.selectionStart, focusedSearch.selectionEnd]
            : null;
        const focusField = body.contains(focused) ? (focused.dataset.field || focused.dataset.setting) : '';
        const focusAttribute = focused?.dataset.field ? 'data-field' : 'data-setting';
        const selection = focusField && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
        body.innerHTML = renderContent(view);
        body.scrollTop = scroll;
        body.querySelectorAll('[data-action]').forEach(element => {
            if (['close-source', 'cancel-edit'].includes(element.dataset.action)) return;
            if (view.busy || view.generating || localBusy) element.disabled = true;
        });
        if (focusedSearch) {
            const input = body.querySelector('[data-role="memory-search"]');
            input?.focus({ preventScroll: true });
            if (searchRange) input?.setSelectionRange?.(...searchRange);
        } else if (focusField) {
            const replacement = body.querySelector(`[${focusAttribute}="${focusField}"]`);
            replacement?.focus({ preventScroll: true });
            if (selection) replacement?.setSelectionRange?.(...selection);
        } else if (focusedNode) {
            const replacement = [...body.querySelectorAll('[data-node]')].find(element => element.dataset.node === focusedNode);
            replacement?.focus({ preventScroll: true });
        }
    }
    function writingView(view) { return view.busy && view.status !== 'summarizing' && view.status !== 'waiting'; }

    function switchTab(next, filterValue = 'all') {
        tab = next;
        filter = filterValue;
        query = '';
        graphSelection = '';
        editor = null;
        source = null;
        render();
    }

    async function perform(callback) {
        localError = '';
        localBusy = true;
        render();
        try { await callback(); }
        catch (cause) {
            localError = cause.message || String(cause);
            const alert = root.querySelector('[data-role="error"]');
            if (alert) { alert.hidden = false; alert.textContent = cause.message || String(cause); }
            globalThis.toastr?.error?.(cause.message || String(cause), '故事记忆');
        } finally { localBusy = false; render(); }
    }
    root.addEventListener('input', event => {
        if (event.target.dataset.field && editor) editor[event.target.dataset.field] = event.target.value;
        if (event.target.dataset.role === 'memory-search') { query = event.target.value; render(); }
    });
    root.addEventListener('change', event => {
        if (event.target.dataset.role === 'enabled') {
            const checked = event.target.checked;
            void perform(() => setStoryMemoryEnabled(checked));
        }
        if (event.target.dataset.field && editor) editor[event.target.dataset.field] = event.target.value;
        if (event.target.dataset.role === 'memory-search') { query = event.target.value; render(); }
    });
    root.addEventListener('click', event => {
        const node = event.target.closest?.('[data-node]');
        if (node) {
            graphSelection = graphSelection === node.dataset.node ? '' : node.dataset.node;
            render();
            return;
        }
        const target = event.target.closest('button');
        if (!target || target.disabled) return;
        if (target.dataset.jumpTab) { switchTab(target.dataset.jumpTab, target.dataset.jumpFilter || 'all'); return; }
        if (target.dataset.tab) { switchTab(target.dataset.tab); return; }
        const action = target.dataset.action;
        const view = getStoryMemoryView();
        const kind = target.dataset.kind;
        const item = kind ? view.memory[kind]?.find(entry => entry.id === target.dataset.id) : null;
        if (action === 'close') close();
        else if (action === 'settings') {
            settingsClose?.();
            settingsClose = openStoryMemorySettingsWindow({ onClose: () => { settingsClose = null; } });
        }
        else if (action === 'run') void perform(() => runStoryMemory(true));
        else if (action === 'undo' || action === 'undo-all') void perform(() => undoStoryMemory(action === 'undo-all'));
        else if (action === 'set-filter') { filter = target.dataset.filter || 'all'; render(); }
        else if (action === 'toggle-graph') { graphOpen = !graphOpen; render(); }
        else if (action === 'clear-graph') { graphSelection = ''; render(); }
        else if (action === 'clear-filter') { filter = 'all'; query = ''; graphSelection = ''; render(); }
        else if (action === 'expand') {
            const key = target.dataset.key;
            if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
            render();
        }
        else if (action === 'add' || action === 'edit') {
            editor = { kind, id: item?.id || '', title: item?.title || '', body: item?.body || '', status: item?.status || 'open' }; render();
        } else if (action === 'lock' || action === 'accept' || action === 'dismiss') void perform(() => editStoryMemoryItem(kind, item.id, {}, action));
        else if (action === 'history') {
            source = { title: item.title, links: item.sources || [], text: [
                ...(item.sources || []).map(entry => `第 ${entry.start}～${entry.end} 楼\n依据：${entry.evidence || ''}`),
                ...(item.history || []).map(entry => `变化前（${new Date(entry.at).toLocaleString()}）\n${entry.title}\n${entry.body}${kind === 'threads' ? `\n${THREAD_STATUS[entry.status] || ''}` : ''}`),
            ].join('\n\n') || '这是手动新增的条目，暂无原文来源。' }; render();
        } else if (action === 'segment-source') {
            source = { title: `第 ${target.dataset.start}～${target.dataset.end} 楼原文`, text: readStoryMemorySources(Number(target.dataset.start), Number(target.dataset.end)) }; render();
        } else if (action === 'edit-narrative') { editor = { kind: 'narrative', recap: view.memory.recap, scene: view.memory.scene }; render(); }
        else if (action === 'edit-summary') { const segment = view.memory.segments.find(entry => entry.id === target.dataset.id); editor = { kind: 'summary', segmentId: segment.id, summary: segment.summary }; render(); }
        else if (action === 'save-edit') void perform(async () => {
            if (editor.kind === 'narrative' || editor.kind === 'summary') await editStoryMemoryNarrative(editor);
            else await editStoryMemoryItem(editor.kind, editor.id, editor);
            editor = null;
        });
        else if (action === 'cancel-edit') { editor = null; render(); }
        else if (action === 'close-source') { source = null; render(); }
    });
    function onKeydown(event) {
        // 设置窗口打开时，键盘归它管；否则按 Esc 会连故事记忆一起关掉。
        if (settingsClose) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'Tab') {
            const focusable = [...root.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [data-node]')];
            const first = focusable[0]; const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    }
    root.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const node = event.target.closest?.('[data-node]');
        if (!node) return;
        event.preventDefault();
        graphSelection = graphSelection === node.dataset.node ? '' : node.dataset.node;
        render();
    });
    document.addEventListener('keydown', onKeydown, true);
    root.addEventListener('click', event => { if (event.target === root) close(); });
    unsubscribe = subscribeStoryMemory(render);
    render();
    root.querySelector('[data-action="close"]').focus();
    return close;
}
