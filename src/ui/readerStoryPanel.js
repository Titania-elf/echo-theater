import {
    getReaderStoryView, getReaderStoryConfig, saveReaderStoryConfig, readerStoryProfiles,
    getReaderStoryEvidence, startReaderStoryIndex, stopReaderStoryIndex, subscribeReaderStory,
} from '../core/readerStory.js';
import { collectRewriteTextGroups, rangeForRewriteMatch } from './textRewriteDom.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const button = (action, label, attributes = '') => `<button type="button" class="t-reader-index-button" data-reader-action="${action}" ${attributes}>${escape(label)}</button>`;
const proof = (reference, label = '原文依据') => button('source', label, `data-reader-reference="${escape(JSON.stringify(reference))}"`);
const KINDS = { situation: '处境', location: '地点', relationship: '人物关系', knowledge: '知情边界', promise: '承诺与约定' };

function chatSignature(ctx) {
    return JSON.stringify(ctx?.chat?.map(message => [message?.mes, message?.extra?.display_text, message?.swipe_id,
        message?.is_user, message?.is_system, message?.is_hidden, message?.extra?.is_hidden, message?.disabled]));
}

/** Reader-owned annotations; no wrappers or edits are inserted into the original chat. */
export function createReaderStoryPanel(root, { refreshBody, close }) {
    const document = root.ownerDocument;
    const window = document.defaultView;
    const opening = globalThis.SillyTavern?.getContext?.();
    let signature = chatSignature(opening);
    let readFloor = -1;
    let tab = 'scenes';
    let selectedPerson = '';
    let selectedEcho = '';
    let source = null;
    let localError = '';
    let sidebarOpen = true;
    let disposed = false;
    let scrollTimer = null;
    let lastScroll = 0;
    let nameRanges = [];
    const scroll = root.querySelector('#t-reader-scroll');
    const sidebar = root.querySelector('[data-reader-sidebar]');
    const config = getReaderStoryConfig();
    sidebar.innerHTML = `<div class="t-reader-index-heading"><strong>阅读资料</strong>${button('toggle', '收起')}</div>
        <p class="t-reader-index-position" data-reader-position>尚未读完楼层</p>
        <div class="t-reader-index-tabs" role="tablist" aria-label="阅读资料">
            ${[['scenes', '场景目录'], ['people', '人物此刻'], ['echoes', '伏笔回声']].map(([name, label]) => `<button type="button" role="tab" data-reader-tab="${name}" aria-selected="${name === tab}">${label}</button>`).join('')}
        </div>
        <div class="t-reader-index-content" data-reader-content></div>
        <div class="t-reader-index-runtime">
            <p data-reader-index-status></p><p class="t-reader-index-error" data-reader-error hidden></p>
            <div class="t-reader-index-actions">${button('index', '整理索引')}${button('stop', '停止', 'disabled')}</div>
            <details class="t-reader-index-settings"><summary>整理设置</summary>
                <label>连接方案<select data-reader-profile><option value="">当前工具箱连接</option>${readerStoryProfiles().map(profile => `<option value="${escape(profile.id)}" ${profile.id === config.profile_id ? 'selected' : ''}>${escape(profile.name)}</option>`).join('')}</select></label>
                <label>模型覆盖<input data-reader-model value="${escape(config.model)}" placeholder="留空使用方案模型"></label>
                <label>正文标签<input data-reader-whitelist value="${escape(config.tag_whitelist)}" placeholder="可留空；例如 正文, content"></label>
                <label>上下文上限（token）<input type="number" min="1000" max="64000" data-reader-budget value="${config.context_tokens}"></label>
                <p>调用所选模型逐楼整理，结果保存在当前聊天。停止或关闭阅读窗口会保留已完成部分。</p>
                ${button('save-settings', '保存设置')}${button('rebuild', '重新整理')}
            </details>
        </div>`;

    function stillHere() {
        const current = globalThis.SillyTavern?.getContext?.();
        return !disposed && root.isConnected && current?.chat === opening?.chat && current?.chatMetadata === opening?.chatMetadata
            && current?.chatId === opening?.chatId && current?.groupId === opening?.groupId && current?.characterId === opening?.characterId;
    }

    function gotoFloor(index) {
        const floors = Array.from(root.querySelectorAll('[data-reader-floor]'));
        const target = floors.find(element => Number(element.dataset.readerFloor) >= index);
        if (!target) { localError = '这段正文被阅读筛选隐藏，可调整“用户楼层”或“其他隐藏楼层”后定位。'; render(); return; }
        readFloor = Number(target.dataset.readerFloor) - 1;
        source = null; selectedEcho = ''; localError = '';
        const prose = target.querySelector('[data-reader-prose]') || target;
        const top = prose.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
        scroll.scrollTo?.({ top, behavior: 'auto' });
        if (!scroll.scrollTo) scroll.scrollTop = top;
        lastScroll = scroll.scrollTop;
        render();
    }

    function renderPeople(view) {
        if (!view.characters.length) return '<p class="t-reader-index-empty">这里还没有人物资料。整理索引后，在楼层末尾点“查看这一刻”，或读过该楼层。</p>';
        const person = view.characters.find(item => item.id === selectedPerson);
        if (selectedPerson && !person) selectedPerson = '';
        if (!person) return `<p class="t-reader-index-hint">选择人物查看此时的处境、关系和知情边界。高亮的正文姓名也可点击。</p>
            ${view.characters.map(item => button('person', item.name, `data-reader-person="${escape(item.id)}"`)).join('')}`;
        return `${button('people-list', '全部人物')}<h3>${escape(person.name)}</h3>${person.aliases.length ? `<p class="t-reader-index-hint">${escape(person.aliases.join(' / '))}</p>` : ''}
            ${Object.entries(KINDS).map(([kind, label]) => {
                const facts = person.facts.filter(fact => fact.kind === kind);
                return facts.length ? `<section class="t-reader-index-card"><h4>${label}</h4>${facts.map(fact => `<p>${escape(fact.text)}</p>${proof(fact.evidence, `第 ${fact.evidence.floor} 楼依据`)}`).join('')}</section>` : '';
            }).join('') || '<p class="t-reader-index-empty">已出现，尚未提取到有原文依据的状态。</p>'}`;
    }

    function renderEchoes(view) {
        const echo = view.echoes.find(item => item.id === selectedEcho);
        if (selectedEcho && !echo) selectedEcho = '';
        if (echo) return `${button('echo-list', '全部回声')}<h3>${escape(echo.title)}</h3>
            <p class="t-reader-index-hint">${echo.certainty === 'explicit' ? '正文出现了对应回应' : '可能关联，仍需核对原文'}</p><p>${escape(echo.explanation)}</p>
            <section class="t-reader-index-card"><h4>较早线索 · 第 ${echo.clue.floor} 楼</h4><blockquote>${escape(echo.clue.quote)}</blockquote>${proof(echo.clue)}</section>
            <section class="t-reader-index-card"><h4>当前回应 · 第 ${echo.reply.floor} 楼</h4><blockquote>${escape(echo.reply.quote)}</blockquote>${proof(echo.reply)}</section>`;
        return `${view.echoes.length ? view.echoes.map(item => button('echo', `${item.certainty === 'possible' ? '待确认 · ' : ''}${item.title} · 第 ${item.reply.floor} 楼`, `data-reader-echo="${escape(item.id)}"`)).join('') : '<p class="t-reader-index-empty">截至此处，还没有已出现的伏笔回应。</p>'}
            ${view.threads.filter(thread => thread.status !== 'resolved').length ? `<h3>此时尚未解开的线索</h3>${view.threads.filter(thread => thread.status !== 'resolved').map(thread => `<section class="t-reader-index-card"><h4>${escape(thread.title)}</h4><p>${escape(thread.question)}</p>${proof(thread.clue, '最早线索')}</section>`).join('')}` : ''}`;
    }

    function renderContent(view) {
        if (source) {
            if (source.floor > readFloor) source = null;
            else {
                try {
                    const original = getReaderStoryEvidence(source, readFloor);
                    return `${button('back', '返回资料')}<h3>第 ${original.index} 楼原文</h3><blockquote>${escape(original.quote)}</blockquote>
                        ${button('goto', '定位正文', `data-reader-index="${original.index}"`)}<pre class="t-reader-index-source">${escape(original.text)}</pre>`;
                } catch (cause) { source = null; localError = cause.message; }
            }
        }
        if (tab === 'people') return renderPeople(view);
        if (tab === 'echoes') return renderEchoes(view);
        return `${view.scenes.length ? view.scenes.map(scene => `<button type="button" class="t-reader-scene-entry" data-reader-action="goto" data-reader-index="${scene.start}">
            <strong>${escape(scene.title)}</strong><small>第 ${scene.start}～${scene.end} 楼${scene.pending ? ' · 待整理' : ''}</small>${scene.place ? `<span>${escape(scene.place)}</span>` : ''}</button>`).join('') : '<p class="t-reader-index-empty">未找到可提取的正文。</p>'}
            <p class="t-reader-index-hint">未读场景先显示编号。整理索引会按地点、时间与主要冲突划分场景；尚未整理时使用原文分隔。</p>`;
    }

    function decorate(view) {
        nameRanges = [];
        const visibleEchoes = new Map();
        for (const echo of view.echoes) {
            const items = visibleEchoes.get(echo.reply.floor) || [];
            items.push(echo); visibleEchoes.set(echo.reply.floor, items);
        }
        for (const section of root.querySelectorAll('[data-reader-floor]')) {
            const index = Number(section.dataset.readerFloor);
            const marker = section.querySelector('[data-reader-echo-markers]');
            if (marker) marker.innerHTML = (visibleEchoes.get(index) || []).map(echo => button('echo', `${echo.certainty === 'possible' ? '待确认关联' : '伏笔回声'} ↶`, `data-reader-echo="${escape(echo.id)}"`)).join('');
            if (index > readFloor) continue;
            const content = section.querySelector('[data-reader-prose]');
            if (!content) continue;
            const groups = collectRewriteTextGroups(content);
            for (const person of view.characters) {
                if (person.introducedAt > index) continue;
                for (const name of [...new Set([person.name, ...person.aliases])].filter(value => value.length > 1)) {
                    if (view.characters.filter(item => item.name === name || item.aliases.includes(name)).length > 1) continue;
                    for (const group of groups) {
                        let cursor = 0;
                        let from;
                        while ((from = group.text.indexOf(name, cursor)) >= 0) {
                            cursor = from + name.length;
                            if (/^[\w ]+$/.test(name) && (/[\w]/.test(group.text[from - 1] || '') || /[\w]/.test(group.text[cursor] || ''))) continue;
                            const covered = group.spans.filter(span => span.end > from && span.start < cursor);
                            if (covered.some(span => !span.node)) continue;
                            const range = rangeForRewriteMatch(document, { from, to: cursor, covered });
                            if (range) nameRanges.push({ range, personId: person.id });
                        }
                    }
                }
            }
        }
        if (window.CSS?.highlights && window.Highlight) window.CSS.highlights.set('titania-reader-people', new window.Highlight(...nameRanges.map(item => item.range)));
    }

    function render() {
        if (!stillHere()) { if (!disposed) close(); return; }
        const current = globalThis.SillyTavern.getContext();
        const changed = chatSignature(current);
        if (changed !== signature) { signature = changed; refreshBody(); readFloor = Math.min(readFloor, current.chat.length - 1); }
        let view;
        try { view = getReaderStoryView(readFloor); }
        catch (cause) { sidebar.querySelector('[data-reader-content]').textContent = cause.message; return; }
        sidebar.hidden = !sidebarOpen;
        root.querySelector('[data-reader-action="toggle"]').setAttribute('aria-expanded', String(sidebarOpen));
        sidebar.querySelector('[data-reader-position]').textContent = readFloor < 0 ? '尚未读完楼层 · 在楼层末尾查看这一刻' : `阅读位置：第 ${readFloor} 楼 · 资料截至第 ${view.asOf < 0 ? '—' : view.asOf} 楼`;
        sidebar.querySelectorAll('[data-reader-tab]').forEach(element => element.setAttribute('aria-selected', String(element.dataset.readerTab === tab)));
        sidebar.querySelector('[data-reader-content]').innerHTML = renderContent(view);
        const state = view.busy ? '正在逐楼整理' : view.status === 'complete' ? '整理完成' : view.status === 'paused' ? '已停止' : '阅读索引';
        sidebar.querySelector('[data-reader-index-status]').textContent = `${state} · ${view.processed}/${view.total} 楼${view.invalidated ? ` · ${view.invalidated} 楼资料因原文变化需重新整理` : ''}`;
        const alert = sidebar.querySelector('[data-reader-error]');
        alert.hidden = !(localError || view.error); alert.textContent = localError || view.error;
        sidebar.querySelector('[data-reader-action="index"]').disabled = view.busy || view.generating || !view.available || !view.total;
        sidebar.querySelector('[data-reader-action="index"]').textContent = view.processed ? '增量整理' : '整理索引';
        sidebar.querySelector('[data-reader-action="stop"]').disabled = !view.busy;
        sidebar.querySelector('[data-reader-action="rebuild"]').disabled = view.busy || view.generating;
        sidebar.querySelector('[data-reader-action="save-settings"]').disabled = view.busy;
        decorate(view);
    }

    async function onClick(event) {
        const toggle = event.target.closest('[data-reader-tab]');
        const action = event.target.closest('[data-reader-action]');
        if (toggle) { tab = toggle.dataset.readerTab; source = null; render(); return; }
        if (!action) {
            if (!event.target.closest('[data-reader-prose]') || event.target.closest('a, button, input, select, textarea, iframe')) return;
            const hit = nameRanges.find(item => typeof item.range.getClientRects === 'function' && Array.from(item.range.getClientRects()).some(rect =>
                event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom));
            if (hit) { selectedPerson = hit.personId; tab = 'people'; sidebarOpen = true; source = null; render(); }
            return;
        }
        event.preventDefault();
        localError = '';
        try {
            switch (action.dataset.readerAction) {
                case 'toggle': sidebarOpen = !sidebarOpen; break;
                case 'at': readFloor = Number(action.dataset.readerIndex); tab = 'people'; sidebarOpen = true; selectedPerson = ''; source = null; break;
                case 'goto': gotoFloor(Number(action.dataset.readerIndex)); return;
                case 'person': selectedPerson = action.dataset.readerPerson; tab = 'people'; source = null; break;
                case 'people-list': selectedPerson = ''; break;
                case 'echo': selectedEcho = action.dataset.readerEcho; tab = 'echoes'; sidebarOpen = true; source = null; break;
                case 'echo-list': selectedEcho = ''; break;
                case 'source': source = JSON.parse(action.dataset.readerReference); break;
                case 'back': source = null; break;
                case 'stop': stopReaderStoryIndex(); break;
                case 'save-settings':
                    saveReaderStoryConfig({ profile_id: sidebar.querySelector('[data-reader-profile]').value,
                        model: sidebar.querySelector('[data-reader-model]').value, tag_whitelist: sidebar.querySelector('[data-reader-whitelist]').value,
                        context_tokens: Number(sidebar.querySelector('[data-reader-budget]').value) });
                    break;
                case 'index': case 'rebuild': await startReaderStoryIndex({ rebuild: action.dataset.readerAction === 'rebuild' }); break;
            }
        } catch (cause) { localError = String(cause.message || cause); }
        render();
    }

    function onScroll() {
        if (scroll.scrollTop === lastScroll) return;
        lastScroll = scroll.scrollTop;
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
            if (!stillHere()) return;
            const line = scroll.getBoundingClientRect().top + 24;
            const completed = Array.from(root.querySelectorAll('[data-reader-floor]')).filter(element => element.getBoundingClientRect().bottom <= line);
            readFloor = completed.length ? Number(completed.at(-1).dataset.readerFloor) : -1;
            render();
        }, 100);
    }

    root.addEventListener('click', onClick);
    scroll.addEventListener('scroll', onScroll, { passive: true });
    const unsubscribe = subscribeReaderStory(render);
    render();
    return {
        refresh: render,
        gotoFloor,
        dispose() {
            disposed = true; unsubscribe(); clearTimeout(scrollTimer);
            root.removeEventListener('click', onClick); scroll.removeEventListener('scroll', onScroll);
            window.CSS?.highlights?.delete('titania-reader-people');
            stopReaderStoryIndex();
        },
    };
}
