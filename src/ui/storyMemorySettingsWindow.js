// 故事记忆 · 运行设置
//
// 从故事记忆窗口顶栏的齿轮进入。独立成窗而不是占一个页签，是因为它调的是
// 跨聊天共用的参数，和「当前剧情 / 人物关系」这类阅读内容不是同一件事。
// 所有数值都不设上限：上限该填多少取决于用户所用的模型，插件不替它猜。

import { getStoryMemoryConfig, saveStoryMemoryConfig } from '../core/storyMemory.js';
import { getAllProfiles } from '../core/connection.js';
import { ensureFeatureCss } from '../utils/dom.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

/**
 * 打开故事记忆的运行设置窗口。
 * @param {object} [options]
 * @param {() => void} [options.onClose] 关闭后回调，供打开它的窗口恢复键盘处理
 * @returns {() => void} 关闭函数
 */
export function openStoryMemorySettingsWindow(options = {}) {
    ensureFeatureCss('story-memory.css');
    const { onClose } = options;
    const root = document.createElement('div');
    root.className = 't-overlay t-root t-memory-settings-overlay';
    let draft = { ...getStoryMemoryConfig() };
    const priorFocus = document.activeElement;
    let closed = false;

    const close = () => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKeydown, true);
        root.remove();
        if (priorFocus?.isConnected) priorFocus.focus?.();
        onClose?.();
    };

    const numeric = (key, label, min, hint) => `<label class="t-memory-field"><span>${label}</span>
        <input class="t-input" type="number" data-setting="${key}" value="${escape(draft[key])}" min="${min}" step="1">
        <small>${hint}</small></label>`;

    function render() {
        const profiles = getAllProfiles();
        const missing = draft.profile_id && !profiles.some(profile => profile.id === draft.profile_id);
        root.innerHTML = `<section class="t-box t-memory-settings-window" role="dialog" aria-modal="true" aria-labelledby="t-memory-settings-title">
            <header class="t-header"><div class="t-memory-title"><i class="fa-solid fa-gear"></i><div>
                <strong id="t-memory-settings-title">运行设置</strong><small>故事记忆 · 跨聊天共用</small></div></div>
                <button type="button" class="t-tool-btn" data-action="close" aria-label="关闭运行设置"><i class="fa-solid fa-xmark"></i></button></header>
            <main class="t-memory-settings-body">
                <p class="t-memory-hint">这些参数在各聊天间共用。自动整理开关仍按聊天分别保存。</p>
                <div class="t-memory-settings-grid">
                    <label class="t-memory-field t-memory-settings-wide"><span>整理时用哪个 API 方案</span><select class="t-input" data-setting="profile_id"><option value="">跟随工具箱当前方案</option>
                        ${missing ? `<option value="${escape(draft.profile_id)}" selected>原方案已不存在，请重新选择</option>` : ''}
                        ${profiles.map(profile => `<option value="${escape(profile.id)}" ${draft.profile_id === profile.id ? 'selected' : ''}>${escape(profile.name)}</option>`).join('')}</select>
                        <small>整理用哪个模型由所选方案决定。方案本身在工具箱的 API 配置里管理。</small></label>
                    ${numeric('keep_floors', '最近多少楼不整理', 2, '这几楼始终留在正文里。整理范围会向前避让到一段完整对话的开头。')}
                    ${numeric('inject_depth', '记忆插在对话的哪个位置', 0, '0＝紧贴最新一条消息；默认 4，让最近几楼的正文排在记忆之后。')}
                    ${numeric('trigger_tokens', '未整理的正文攒到多少 token 就开始整理', 1, '和下面那条楼层数满足任意一个就触发；两个都调大＝整理得更少更晚。')}
                    ${numeric('trigger_floors', '未整理的正文攒到多少楼就开始整理', 1, '只算读得到的正文，隐藏的系统消息不计入。')}
                    ${numeric('batch_tokens', '一次整理最多读多少 token', 1, '每次成段处理，超大的单段不会只读一半再把剩下藏起来。')}
                    ${numeric('max_output_tokens', '一次整理最多写回多少 token', 1, '整理请求的回复长度上限。段落内容多时可调大；太小会因返回不完整而保留正文。')}
                    ${numeric('memory_tokens', '每次注入的记忆最多占多少 token', 1, '历史脉络和锁定的条目优先完整保留；放不下的会在「注入预览」里列出来。')}
                    ${numeric('recent_segments', '每次直接注入最近几段摘要', 0, '这些摘要每段只压缩过一次，不再参与后续改写，比历史脉络更细。0＝不注入。')}
                    ${numeric('recent_tokens', '最近分段摘要最多占多少 token', 0, '独立预算，不挤占历史脉络和旧事召回。')}
                    ${numeric('recall_segments', '每次最多召回几段旧事', 0, '按最近对话里的名字和关键词，从已整理的旧段落中挑出相关片段。0＝关闭召回。')}
                    ${numeric('recall_tokens', '召回内容最多占多少 token', 0, '单独预留的预算，不挤占上面的记忆预算；0＝关闭召回。')}
                </div>
            </main>
            <footer class="t-memory-settings-footer">
                <span class="t-memory-hint" data-role="status" role="status" aria-live="polite"></span>
                <div class="t-memory-card-actions">
                    <button type="button" class="t-btn" data-action="cancel">取消</button>
                    <button type="button" class="t-btn" data-action="save">保存设置</button>
                </div>
            </footer>
        </section>`;
    }

    function syncDraft() {
        // 保存后回读规范化结果：非法值会被落回默认值，界面必须显示真正生效的数。
        draft = { ...getStoryMemoryConfig() };
        root.querySelectorAll('[data-setting]').forEach(input => {
            input.value = draft[input.dataset.setting] ?? '';
        });
    }

    function onKeydown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...root.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }

    root.addEventListener('input', event => {
        if (event.target.dataset.setting) draft[event.target.dataset.setting] = event.target.value;
    });
    root.addEventListener('change', event => {
        if (event.target.dataset.setting) draft[event.target.dataset.setting] = event.target.value;
    });
    root.addEventListener('click', event => {
        if (event.target === root) { close(); return; }
        const target = event.target.closest('button');
        if (!target || target.disabled) return;
        if (target.dataset.action === 'close' || target.dataset.action === 'cancel') close();
        else if (target.dataset.action === 'save') {
            saveStoryMemoryConfig(draft);
            syncDraft();
            const status = root.querySelector('[data-role="status"]');
            if (status) status.textContent = '已保存';
        }
    });
    document.addEventListener('keydown', onKeydown, true);
    render();
    document.body.appendChild(root);
    root.querySelector('[data-setting="profile_id"]')?.focus();
    return close;
}
