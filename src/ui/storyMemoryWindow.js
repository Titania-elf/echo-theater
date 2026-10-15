import {
    getStoryMemoryView, subscribeStoryMemory, setStoryMemoryEnabled, runStoryMemory,
    saveStoryMemoryConfig, editStoryMemoryItem, editStoryMemoryNarrative, undoStoryMemory, readStoryMemorySources,
} from '../core/storyMemory.js';
import { getAllProfiles } from '../core/connection.js';
import { claimFloatingWindow, releaseFloatingWindow } from './shared/floatingWindow.js';
import { ensureFeatureCss } from '../utils/dom.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const STATUS = { idle: '等待下一段剧情', summarizing: '正在后台整理…', waiting: '已整理，等待生成结束后应用', rebuilding: '正文有变化，正在重整', error: '暂未完成，正文已保留' };
const THREAD_STATUS = { open: '未解决', progress: '有进展', resolved: '已解决' };
const TABS = [['current', '当前剧情'], ['relationships', '人物关系'], ['threads', '伏笔与约定'], ['records', '整理记录'], ['preview', '注入预览'], ['settings', '运行设置']];
let closeWindow = null;

export function openStoryMemoryWindow() {
    closeWindow?.();
    ensureFeatureCss('story-memory.css');
    const root = document.createElement('div');
    root.className = 't-overlay t-root t-memory-overlay';
    root.innerHTML = `<section class="t-box t-memory-window" role="dialog" aria-modal="true" aria-labelledby="t-memory-title">
        <header class="t-header"><div class="t-memory-title"><i class="fa-solid fa-brain"></i><div><strong id="t-memory-title">故事记忆</strong><small data-role="chat-name"></small></div></div>
            <button type="button" class="t-tool-btn" data-action="close" aria-label="关闭故事记忆"><i class="fa-solid fa-xmark"></i></button></header>
        <div class="t-memory-toolbar"><label class="t-memory-toggle"><input type="checkbox" data-role="enabled"> 后台自动整理</label>
            <span class="t-memory-status" data-role="status" role="status" aria-live="polite"></span>
            <button type="button" class="t-btn" data-action="run"><i class="fa-solid fa-wand-magic-sparkles"></i> 立即整理</button></div>
        <div class="t-memory-metrics" data-role="metrics"></div><div class="t-memory-error" data-role="error" role="alert" hidden></div>
        <nav class="t-memory-tabs" aria-label="记忆内容">${TABS.map(([id, label]) => `<button type="button" class="t-btn" data-tab="${id}">${label}</button>`).join('')}</nav>
        <main class="t-memory-body" data-role="body"></main>
        <footer class="t-memory-footer">记忆随当前聊天保存 · 暂停自动整理后，已有记忆继续注入</footer>
    </section>`;
    let tab = 'current';
    let editor = null;
    let source = null;
    let settingsDraft = null;
    let previousKey = '';
    let localBusy = false;
    let localError = '';
    const priorFocus = document.activeElement;
    let unsubscribe = () => {};
    const close = () => {
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
    const itemActions = (kind, item) => {
        const attrs = `data-kind="${kind}" data-id="${escape(item.id)}"`;
        return `<div class="t-memory-card-actions">${button('edit', '编辑', attrs)}${button('lock', item.locked ? '解锁' : '锁定', attrs)}${button('history', '来源与变化', attrs)}</div>`;
    };
    function renderItem(kind, item) {
        return `<article class="t-memory-card${item.locked ? ' is-locked' : ''}"><div class="t-memory-card-heading"><strong>${escape(item.title)}</strong>
            <span class="t-memory-badge">${item.locked ? '已锁定' : kind === 'threads' ? THREAD_STATUS[item.status] : item.manual ? '人工维护' : '关系'}</span></div>
            <p class="t-memory-text">${escape(item.body)}</p>${itemActions(kind, item)}
            ${item.pending ? `<details class="t-memory-pending"><summary>有新的修改建议</summary><strong>${escape(item.pending.title)}</strong><p class="t-memory-text">${escape(item.pending.body)}</p>
                ${kind === 'threads' ? `<small>${THREAD_STATUS[item.pending.status]}</small>` : ''}
                <blockquote>${escape(item.pending.source.evidence)}</blockquote><div class="t-memory-card-actions">${button('accept', '采用建议', `data-kind="${kind}" data-id="${escape(item.id)}"`)}${button('dismiss', '忽略', `data-kind="${kind}" data-id="${escape(item.id)}"`)}</div></details>` : ''}</article>`;
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

    function renderSettings(view) {
        settingsDraft ||= { ...view.config };
        const numeric = (key, label, min, max, hint) => `<label class="t-memory-field"><span>${label}</span><input class="t-input" type="number" data-setting="${key}" value="${escape(settingsDraft[key])}" min="${min}" max="${max}" step="1"><small>${hint}</small></label>`;
        const profiles = getAllProfiles();
        const missing = settingsDraft.profile_id && !profiles.some(profile => profile.id === settingsDraft.profile_id);
        return `<div class="t-memory-settings"><p class="t-memory-hint">这些参数在各聊天间共用；自动整理开关按聊天分别保存。</p>
            <div class="t-memory-settings-grid"><label class="t-memory-field"><span>总结 API 方案</span><select class="t-input" data-setting="profile_id"><option value="">跟随工具箱当前方案</option>
                ${missing ? `<option value="${escape(settingsDraft.profile_id)}" selected>原方案已不存在，请重新选择</option>` : ''}
                ${profiles.map(profile => `<option value="${escape(profile.id)}" ${settingsDraft.profile_id === profile.id ? 'selected' : ''}>${escape(profile.name)}</option>`).join('')}</select><small>方案在工具箱的 API 配置中管理。</small></label>
            <label class="t-memory-field"><span>总结模型覆盖（可选）</span><input class="t-input" data-setting="model" value="${escape(settingsDraft.model)}"><small>留空沿用所选方案的模型。</small></label>
            ${numeric('keep_floors', '至少保留最近楼层', 2, 500, '切分会向前延伸到完整对话开头。')}
            ${numeric('trigger_tokens', '旧正文触发量（预计 token）', 100, 100000, '达到 token 或楼层条件之一便开始整理。')}
            ${numeric('trigger_floors', '旧正文触发楼层数', 2, 1000, '只计入可读正文，隐藏的系统消息不计入。')}
            ${numeric('batch_tokens', '单次正文读取上限（预计 token）', 1000, 100000, '每次处理一段完整对话，超大单组不会截断后隐藏。')}
            ${numeric('memory_tokens', '注入记忆目标预算（预计 token）', 300, 20000, '历史脉络及锁定条目优先完整保留；超预算会显示。')}
            ${numeric('inject_depth', '注入深度', 0, 1000, '0紧贴最新消息；默认4，让最近正文在记忆之后。')}</div>
            ${button('save-settings', '保存运行设置')}</div>`;
    }

    function renderContent(view) {
        const memory = view.memory;
        if (!view.available) return '<div class="t-memory-empty"><i class="fa-solid fa-comments"></i><p>打开一段角色聊天后，即可为这段故事建立记忆。</p></div>';
        if (source) return `<div class="t-memory-section-heading"><strong>${escape(source.title)}</strong>${button('close-source', '返回')}</div>
            ${source.links?.length ? `<div class="t-memory-card-actions">${source.links.map(entry => button('segment-source', `查看第 ${entry.start}～${entry.end} 楼原文`, `data-start="${entry.start}" data-end="${entry.end}"`)).join('')}</div>` : ''}
            <pre class="t-memory-source">${escape(source.text)}</pre>`;
        if (editor) return renderEditor();
        if (tab === 'settings') return renderSettings(view);
        if (tab === 'preview') return `<p class="t-memory-hint">以下内容通过独立提示词持续注入，不添加聊天楼层。估算约 ${view.injection.tokens} token。</p>
            ${view.injection.overBudget ? '<p class="t-memory-error">历史脉络和锁定条目已超过目标预算，请精简内容或提高预算。</p>' : ''}
            ${view.injection.omitted.length ? `<p class="t-memory-error">本轮预算未容纳：${escape(view.injection.omitted.join('、'))}。条目仍保存在记忆中，可锁定重要条目或提高预算。</p>` : ''}
            <pre class="t-memory-source">${escape(view.injection.text || '尚未建立记忆。')}</pre>`;
        if (tab === 'current') return `<div class="t-memory-section-heading"><strong>故事走到了哪里</strong>${button('edit-narrative', '编辑')}</div>
            <div class="t-memory-current-grid"><article class="t-memory-card"><h3>历史脉络</h3><p class="t-memory-text">${escape(memory.recap || '开启后台自动整理后，较早正文会在这里形成连续的剧情脉络。')}</p></article>
            <article class="t-memory-card"><h3>截至整理范围的剧情状态</h3><p class="t-memory-text">${escape(memory.scene || '保留地点、处境、目标及未解决的冲突；最新发展继续由最近正文提供。')}</p></article></div>
            <div class="t-memory-overview"><span>人物关系 <strong>${memory.relationships.length}</strong></span><span>未解决事项 <strong>${memory.threads.filter(item => item.status !== 'resolved').length}</strong></span><span>已归档事项 <strong>${memory.threads.filter(item => item.status === 'resolved').length}</strong></span></div>`;
        if (tab === 'relationships' || tab === 'threads') {
            const items = memory[tab];
            const active = items.filter(item => item.status !== 'resolved');
            const archived = items.filter(item => item.status === 'resolved');
            return `<div class="t-memory-section-heading"><strong>${tab === 'relationships' ? '关系、矛盾与知情边界' : '悬念、承诺与未完成目标'}</strong>${button('add', '新增条目', `data-kind="${tab}"`)}</div>
                ${active.length ? `<div class="t-memory-card-grid">${active.map(item => renderItem(tab, item)).join('')}</div>` : '<p class="t-memory-empty">还没有条目。自动整理会从正文中提取，也可以手动添加。</p>'}
                ${archived.length ? `<details class="t-memory-archive"><summary>已解决 · ${archived.length} 项</summary><div class="t-memory-card-grid">${archived.map(item => renderItem(tab, item)).join('')}</div></details>` : ''}`;
        }
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
        if (previousKey && previousKey !== view.key) { editor = null; source = null; settingsDraft = null; localError = ''; }
        previousKey = view.key;
        root.querySelector('[data-role="chat-name"]').textContent = view.chatName || '当前聊天';
        const enabled = root.querySelector('[data-role="enabled"]');
        enabled.checked = view.memory.enabled;
        enabled.disabled = !view.available || view.generating || localBusy || !!writingView(view);
        root.querySelector('[data-role="status"]').textContent = view.status === 'idle' && !view.memory.enabled ? '自动整理已暂停' : STATUS[view.status];
        root.querySelector('[data-action="run"]').disabled = !view.available || !view.memory.enabled || view.busy || view.generating || localBusy;
        const end = view.memory.segments.at(-1)?.end;
        root.querySelector('[data-role="metrics"]').textContent = `${end == null ? '尚未整理正文' : `已整理至第 ${end} 楼`} · 至少保留最近 ${view.config.keep_floors} 楼 · 记忆约 ${view.injection.tokens} token${view.batch ? ` · 待整理第 ${view.batch.start}～${view.batch.end} 楼` : ''}`;
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
        const focusField = body.contains(focused) ? (focused.dataset.field || focused.dataset.setting) : '';
        const focusAttribute = focused?.dataset.field ? 'data-field' : 'data-setting';
        const selection = focusField && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
        body.innerHTML = renderContent(view);
        body.scrollTop = scroll;
        body.querySelectorAll('[data-action]').forEach(element => {
            if (['close-source', 'cancel-edit'].includes(element.dataset.action)) return;
            if (view.busy || view.generating || localBusy) element.disabled = true;
        });
        if (focusField) {
            const replacement = body.querySelector(`[${focusAttribute}="${focusField}"]`);
            replacement?.focus({ preventScroll: true });
            if (selection) replacement?.setSelectionRange?.(...selection);
        }
    }
    function writingView(view) { return view.busy && view.status !== 'summarizing' && view.status !== 'waiting'; }

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
        if (event.target.dataset.setting && settingsDraft) settingsDraft[event.target.dataset.setting] = event.target.value;
    });
    root.addEventListener('change', event => {
        if (event.target.dataset.role === 'enabled') {
            const checked = event.target.checked;
            void perform(() => setStoryMemoryEnabled(checked));
        }
        if (event.target.dataset.field && editor) editor[event.target.dataset.field] = event.target.value;
        if (event.target.dataset.setting && settingsDraft) settingsDraft[event.target.dataset.setting] = event.target.value;
    });
    root.addEventListener('click', event => {
        const target = event.target.closest('button');
        if (!target || target.disabled) return;
        if (target.dataset.tab) { tab = target.dataset.tab; editor = null; source = null; settingsDraft = null; render(); return; }
        const action = target.dataset.action;
        const view = getStoryMemoryView();
        const kind = target.dataset.kind;
        const item = kind ? view.memory[kind]?.find(entry => entry.id === target.dataset.id) : null;
        if (action === 'close') close();
        else if (action === 'run') void perform(() => runStoryMemory(true));
        else if (action === 'undo' || action === 'undo-all') void perform(() => undoStoryMemory(action === 'undo-all'));
        else if (action === 'save-settings') void perform(() => { saveStoryMemoryConfig(settingsDraft); settingsDraft = null; });
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
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'Tab') {
            const focusable = [...root.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary')];
            const first = focusable[0]; const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    }
    document.addEventListener('keydown', onKeydown, true);
    root.addEventListener('click', event => { if (event.target === root) close(); });
    unsubscribe = subscribeStoryMemory(render);
    render();
    root.querySelector('[data-action="close"]').focus();
    return close;
}
