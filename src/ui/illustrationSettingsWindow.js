// 场景配图设置窗口：选景预设管理。
//
// 从场景配图面板顶栏右上角进入。刻意做成独立窗口而不是塞进小剧场设置对话框：
// 设置对话框的改动要等「保存所有配置」才落盘，而配图面板是另一个界面，
// 中间那段时间它会读到旧值。这里一律即时落盘。

import { getExtData, saveExtData } from "../utils/storage.js";
import {
    ILLUSTRATION_PRESETS_KEY, PLACEHOLDER_NAMES,
    createPresetEntry, createUserPreset, ensureIllustrationPresets, isChatCompletionPreset, isManagedEntry,
    listPresets, managedEntryDefault, readChatCompletionPreset, resolveActivePreset,
    serializeIllustrationPreset, validatePresetForSelection,
} from "../core/illustrationPresets.js";
import { claimFloatingWindow, isFloatingWindowDisplaced, releaseFloatingWindow } from "./shared/floatingWindow.js";

/**
 * 打开场景配图设置窗口。
 * @param {object} [options]
 * @param {() => void} [options.onClose] 用户主动关闭后回调（用于回到配图面板）
 * @returns {() => void} 关闭函数
 */
export function openIllustrationSettingsWindow(options = {}) {
    const { onClose } = options;
    const root = document.createElement("div");
    root.className = "t-root t-illustration-settings-window";
    root.innerHTML = `
        <section class="t-profile-panel" role="dialog" aria-labelledby="t-illustration-settings-title">
            <div class="t-panel-header">
                <strong id="t-illustration-settings-title">场景配图设置</strong>
                <button type="button" class="t-btn" data-action="close" title="关闭设置" aria-label="关闭设置"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="t-profile-body">
                <div style="font-weight:bold; color:var(--t-color-accent); margin-bottom:8px;">选景预设</div>
                <p class="t-illustration-hint">
                    预设决定送给选景模型的消息。条目按顺序拼成消息，素材靠占位符进入：
                    ${PLACEHOLDER_NAMES.map(name => `<code>{{${name}}}</code>`).join(" ")}
                    <br>选景用的是小剧场当前的 API 方案（设置 → API 连接），与本预设相互独立。
                    <strong>变量宏会展开</strong>：<code>{{setvar::名::值}}</code>、<code>{{getvar::名}}</code>
                    等 10 个 STscript 变量宏可用，跨条目共享，且只在本次选景内有效——选景结束后变量会还原，
                    不写进你的聊天存档。<strong>{{char}}、{{user}} 这类读当前聊天的宏不会展开。</strong>
                </p>
                <div class="t-profile-actions">
                    <select class="t-input" data-role="preset-select" style="width:auto; min-width:180px;"></select>
                    <button type="button" class="t-btn primary" data-action="new-preset" title="新建预设（自动带上小剧场的选景条目）" aria-label="新建预设"><i class="fa-solid fa-plus"></i></button>
                    <button type="button" class="t-btn" data-action="rename-preset" title="重命名当前预设" aria-label="重命名当前预设"><i class="fa-solid fa-pen"></i></button>
                    <button type="button" class="t-btn" data-action="delete-preset" title="删除当前预设" aria-label="删除当前预设"><i class="fa-solid fa-trash"></i></button>
                    <button type="button" class="t-btn" data-action="import" title="导入预设：酒馆 Chat Completion 预设，或本插件导出的选景预设" aria-label="导入预设"><i class="fa-solid fa-file-import"></i></button>
                    <button type="button" class="t-btn" data-action="export" title="导出当前预设为 JSON" aria-label="导出当前预设"><i class="fa-solid fa-file-export"></i></button>
                    <input type="file" accept=".json,application/json" data-role="file" style="display:none;">
                </div>
                <p class="t-illustration-hint" data-role="validation"></p>
                <div class="t-profile-list" data-role="entries"></div>
                <p class="t-illustration-hint" data-role="entry-actions"></p>
            </div>
        </section>`;
    document.body.append(root);

    const role = name => root.querySelector(`[data-role="${name}"]`);
    const action = name => root.querySelector(`[data-action="${name}"]`);
    let disposed = false;
    let draggedId = "";
    // 条目默认折叠：一次能看到全部条目，要改哪条再点开。只活在本次开窗期间，不持久化。
    const expandedIds = new Set();

    function toggleExpanded(id) {
        if (expandedIds.has(id)) expandedIds.delete(id);
        else expandedIds.add(id);
        render();
    }

    // --- 状态读写（一律即时落盘） ---

    // 读取端防御性自调一次：正常路径上 getExtData() 已经 ensure 过了，
    // 但这个窗口也会在别处（测试夹具整块替换 storage）被打开，不能假设一定跑过。
    const state = () => {
        const data = getExtData();
        ensureIllustrationPresets(data);
        return data[ILLUSTRATION_PRESETS_KEY];
    };
    const activePreset = () => resolveActivePreset(getExtData());
    const livePreset = () => state().presets.find(item => item.id === state().active_preset_id) || null;

    function commit() {
        saveExtData();
        if (!disposed) render();
    }

    /**
     * 改一条条目。
     * 默认**不重画**——文本输入时 DOM 已经是用户刚敲的样子，
     * 重画会重建整个列表、把输入框的焦点和光标位置一起弄丢。
     */
    function patchEntry(id, patch, { rerender = false } = {}) {
        const entry = livePreset()?.entries.find(item => item.id === id);
        if (entry) Object.assign(entry, patch);
        saveExtData();
        if (disposed) return;
        // 内容变了要重算占位符校验（但不必重建条目 DOM）。
        renderValidation();
        if (rerender) render();
    }

    function deleteEntry(id) {
        const live = livePreset();
        if (!live) return;
        live.entries = live.entries.filter(item => item.id !== id);
        commit();
    }

    function restoreEntry(id) {
        const factory = managedEntryDefault(id);
        const entry = livePreset()?.entries.find(item => item.id === id);
        if (!factory || !entry) return;
        // 只还原内容：启用状态与位置是用户当前的编排意图，不该被这个按钮改掉。
        entry.content = factory.content;
        commit();
    }

    function reorderEntries(orderedIds) {
        const live = livePreset();
        if (!live) return;
        live.entries.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
        commit();
    }

    function insertEntry(position) {
        const live = livePreset();
        if (!live) return;
        const entry = createPresetEntry();
        live.entries.splice(Math.min(Math.max(0, position), live.entries.length), 0, entry);
        expandedIds.add(entry.id);   // 新条目直接展开，省得再点一下才能写内容
        commit();
    }

    // --- 渲染 ---

    function renderToolbar() {
        const presets = listPresets(getExtData());
        const active = state().active_preset_id;
        const select = role("preset-select");
        select.replaceChildren();
        if (!presets.length) {
            const option = document.createElement("option");
            option.value = "";
            option.textContent = "还没有预设";
            select.append(option);
        } else {
            for (const preset of presets) {
                const option = document.createElement("option");
                option.value = preset.id;
                option.textContent = preset.name;
                select.append(option);
            }
        }
        select.value = presets.some(item => item.id === active) ? active : "";
        const hasActive = Boolean(select.value);
        action("rename-preset").disabled = !hasActive;
        action("delete-preset").disabled = !hasActive;
        action("export").disabled = !hasActive;
    }

    function renderValidation() {
        const node = role("validation");
        const preset = activePreset();
        if (!preset) {
            node.textContent = "还没有选景预设，配图暂时不可用。导入一份预设，或新建一份。";
            node.style.color = "var(--t-color-danger, #e06c75)";
            return;
        }
        const check = validatePresetForSelection(preset);
        if (check.ok) {
            node.textContent = `当前预设「${preset.name}」可以选景。`;
            node.style.color = "";
        } else {
            node.textContent = `⚠ ${check.reason}`;
            node.style.color = "var(--t-color-danger, #e06c75)";
        }
    }

    function labeled(labelText, control) {
        const wrap = document.createElement("label");
        wrap.className = "t-illustration-field";
        wrap.append(document.createTextNode(labelText), control);
        return wrap;
    }

    /** 图标按钮的内容用建元素而不是 innerHTML：本窗口的动态 DOM 一律不拼 HTML 串。 */
    function iconElement(className) {
        const icon = document.createElement("i");
        icon.className = className;
        return icon;
    }

    function button(label, iconClass, title, onClick) {
        const element = document.createElement("button");
        element.type = "button";
        element.className = "t-btn";
        element.title = title;
        element.setAttribute("aria-label", label);
        element.append(iconElement(iconClass));
        element.addEventListener("click", onClick);
        return element;
    }

    function buildEntrySummary(entry, index) {
        const header = document.createElement("div");
        header.className = "t-profile-card-header";

        const grip = document.createElement("span");
        grip.className = "t-profile-grip";
        grip.title = "拖动排序";
        grip.textContent = "⠿";

        const order = document.createElement("span");
        // 用独立类名：和启用开关共用一个类会让 querySelector 先命中序号，点它没有任何反应。
        order.className = "t-profile-order";
        order.textContent = `#${index + 1}`;

        const open = expandedIds.has(entry.id);
        const expand = document.createElement("button");
        expand.type = "button";
        expand.className = "t-profile-expand";
        expand.dataset.expand = entry.id;
        expand.title = open ? "收起" : "展开编辑";
        // 折叠着也把关键信息摊在标题上，不必逐个点开确认。
        const tags = [entry.role, entry.enabled ? "" : "已停用"].filter(Boolean).join(" · ");
        expand.textContent = `${open ? "▾" : "▸"} ${entry.name || "未命名条目"}（${tags}）`;
        expand.addEventListener("click", () => toggleExpanded(entry.id));

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = `t-profile-toggle${entry.enabled ? " is-on" : ""}`;
        toggle.textContent = entry.enabled ? "启用" : "停用";
        toggle.title = entry.enabled ? "点击停用：停用后不参与选景" : "点击启用";
        // 按钮标签本身要跟着变，得重画这一块。
        toggle.addEventListener("click", () => patchEntry(entry.id, { enabled: !entry.enabled }, { rerender: true }));

        header.append(grip, order, expand, toggle);
        // 托管条目可改写、可停用、可排序，但不给删 —— 靠单条「恢复默认内容」还原。
        if (isManagedEntry(entry.id)) {
            header.append(button("恢复默认内容", "fa-solid fa-rotate-left", "把这条恢复为小剧场的默认内容", () => {
                if (!confirm(`确定把「${entry.name}」恢复为默认内容吗？你对它的修改会丢失。`)) return;
                restoreEntry(entry.id);
            }));
        } else {
            header.append(button("删除这条条目", "fa-solid fa-trash", "删除这条条目", () => {
                if (!confirm(`确定删除条目「${entry.name || "未命名"}」吗？`)) return;
                deleteEntry(entry.id);
            }));
        }
        return header;
    }

    /** 展开后才建这块；输入时只更新提示与校验，绝不整块重画（那会丢焦点）。 */
    function buildEntryBody(entry) {
        const body = document.createElement("div");
        body.className = "t-profile-entry-body";

        const name = document.createElement("input");
        name.type = "text";
        name.className = "t-input";
        name.value = entry.name;
        name.addEventListener("input", () => patchEntry(entry.id, { name: name.value }));
        body.append(labeled("条目名称", name));

        const roleSelect = document.createElement("select");
        roleSelect.className = "t-input";
        for (const value of ["system", "user", "assistant"]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            roleSelect.append(option);
        }
        roleSelect.value = entry.role;
        roleSelect.addEventListener("change", () => patchEntry(entry.id, { role: roleSelect.value }, { rerender: true }));
        body.append(labeled("消息角色", roleSelect));

        const content = document.createElement("textarea");
        content.className = "t-input";
        content.rows = 6;
        content.value = entry.content;
        const stat = document.createElement("p");
        stat.className = "t-illustration-hint";
        const refreshStat = () => {
            const names = [...new Set([...content.value.matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)].map(match => match[1]))];
            // 变量宏带 ::，上面那个占位符正则匹配不到，单独认一遍，免得写成变量却显示「不含占位符」。
            const vars = [...new Set([...content.value.matchAll(/\{\{\s*(?:get|set|add|inc|dec)(?:global)?var::\s*([^:}]+)/gi)]
                .map(match => match[1].trim()).filter(Boolean))];
            const parts = [];
            if (names.length) parts.push(`占位符：${names.join("、")}`);
            if (vars.length) parts.push(`变量：${vars.join("、")}`);
            stat.textContent = parts.length ? parts.join(" · ") : "这条不含占位符或变量";
        };
        content.addEventListener("input", () => { patchEntry(entry.id, { content: content.value }); refreshStat(); });
        refreshStat();
        body.append(labeled("内容", content), stat);

        return body;
    }

    function buildEntryCard(entry, index) {
        const card = document.createElement("article");
        card.className = "t-profile-card";
        card.dataset.entryId = entry.id;
        card.draggable = true;
        card.append(buildEntrySummary(entry, index));
        if (expandedIds.has(entry.id)) card.append(buildEntryBody(entry));

        card.addEventListener("dragstart", event => {
            // 从输入控件上起手是要选文字，不是拖这一条。
            if (event.target.closest("input, textarea, select")) { event.preventDefault(); return; }
            draggedId = entry.id;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", entry.id);
            card.classList.add("is-dragging");
        });
        card.addEventListener("dragend", () => card.classList.remove("is-dragging"));
        card.addEventListener("dragover", event => event.preventDefault());
        card.addEventListener("drop", event => {
            event.preventDefault();
            const sourceId = draggedId || event.dataTransfer.getData("text/plain");
            if (!sourceId || sourceId === entry.id) return;
            const ids = (activePreset()?.entries || []).map(item => item.id).filter(id => id !== sourceId);
            const rect = card.getBoundingClientRect();
            const insertAfter = event.clientY >= rect.top + rect.height / 2;
            const base = ids.indexOf(entry.id);
            if (base < 0) return;
            ids.splice(insertAfter ? base + 1 : base, 0, sourceId);
            draggedId = "";
            reorderEntries(ids);
        });

        return card;
    }

    /** 还没配置过任何预设：不要给一个空列表，直接把两条出路摆出来。 */
    function renderSetup() {
        const list = role("entries");
        list.replaceChildren();
        const box = document.createElement("div");
        box.className = "t-profile-card";
        const title = document.createElement("p");
        title.style.cssText = "margin:0 0 8px; font-weight:bold;";
        title.textContent = "还没有选景预设";
        const hint = document.createElement("p");
        hint.className = "t-illustration-hint";
        hint.textContent = "「分析画面」需要一份预设来决定送给模型的消息。导入酒馆预设或本插件导出的预设，会自动补上小剧场的选景条目；新建则直接得到一份可用的默认配置。";
        const actions = document.createElement("div");
        actions.className = "t-profile-actions";
        const importBtn = document.createElement("button");
        importBtn.type = "button";
        importBtn.className = "t-btn primary";
        importBtn.textContent = "导入预设";
        importBtn.addEventListener("click", () => role("file").click());
        const newBtn = document.createElement("button");
        newBtn.type = "button";
        newBtn.className = "t-btn";
        newBtn.textContent = "新建预设";
        newBtn.addEventListener("click", () => createPreset());
        actions.append(importBtn, newBtn);
        box.append(title, hint, actions);
        list.append(box);
        role("entry-actions").textContent = "";
    }

    function renderEntries() {
        const preset = activePreset();
        const list = role("entries");
        list.replaceChildren();
        preset.entries.forEach((entry, index) => list.append(buildEntryCard(entry, index)));

        const actions = role("entry-actions");
        actions.replaceChildren();
        const note = document.createElement("span");
        note.className = "t-illustration-hint";
        note.textContent = "带 ↺ 的是小剧场补上的条目：可改写、可停用、可排序，但不能删，改坏了用 ↺ 还原。";
        actions.append(note, button("新增条目", "fa-solid fa-plus", "在当前预设末尾新增一条条目", () => insertEntry(preset.entries.length)));
    }

    function render() {
        if (disposed) return;
        renderToolbar();
        renderValidation();
        // 没有生效的预设就一律走引导；有预设但 active 悬空的情况 ensure 已经回落过了。
        if (activePreset()) renderEntries();
        else renderSetup();
    }

    // --- 交互 ---

    function createPreset() {
        const preset = createUserPreset("新预设");
        state().presets.push(preset);
        state().active_preset_id = preset.id;
        // 刚建的预设直接把条目摊开，省得再点一下才能写。
        for (const entry of preset.entries) expandedIds.add(entry.id);
        commit();
    }

    role("preset-select").addEventListener("change", event => {
        state().active_preset_id = event.target.value;
        commit();
    });

    root.addEventListener("click", event => {
        const button = event.target.closest("button");
        if (!button || button.disabled) return;
        const operation = button.dataset.action;
        if (operation === "close") { close(); return; }
        if (operation === "new-preset") { createPreset(); return; }
        if (operation === "rename-preset") {
            const live = livePreset();
            if (!live) return;
            const name = prompt("预设名称", live.name);
            if (name === null) return;
            live.name = String(name).trim() || live.name;
            commit();
            return;
        }
        if (operation === "delete-preset") {
            const live = livePreset();
            if (!live) return;
            if (!confirm(`确定删除预设「${live.name}」吗？`)) return;
            state().presets = state().presets.filter(item => item.id !== live.id);
            // 还有别的预设就接着用第一份，别把界面丢进「未配置」状态。
            state().active_preset_id = state().presets[0]?.id || "";
            commit();
            return;
        }
        if (operation === "import") { role("file").click(); return; }
        if (operation === "export") {
            const preset = activePreset();
            if (!preset) return;
            const blob = new Blob([JSON.stringify(serializeIllustrationPreset(preset), null, 4)], { type: "application/json;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `${(preset.name || "选景预设").replace(/[\\/:*?"<>|]/g, "_")}.json`;
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
            return;
        }
    });

    role("file").addEventListener("change", function () {
        const file = this.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const raw = JSON.parse(String(reader.result || ""));
                if (!isChatCompletionPreset(raw)) throw new Error("这不像一份预设文件");
                const preset = readChatCompletionPreset(raw, { name: file.name.replace(/\.json$/i, "") });
                const existing = state().presets.findIndex(item => item.name === preset.name);
                // 同名导入覆盖原预设，保留它的 id，免得把 active 指丢。
                if (existing >= 0) preset.id = state().presets[existing].id;
                if (existing >= 0) state().presets[existing] = preset;
                else state().presets.push(preset);
                state().active_preset_id = preset.id;
                commit();
                const skipped = preset.droppedContextEntries ? `，跳过 ${preset.droppedContextEntries} 条上下文注入条目` : "";
                if (window.toastr) {
                    toastr.success(
                        `已导入 ${preset.importedEntries} 条，并补上小剧场的选景条目${skipped}`,
                        `选景预设：${preset.name}`,
                    );
                }
            } catch (error) {
                if (window.toastr) toastr.error(`预设导入失败：${error?.message || error}`, "Titania");
            } finally {
                this.value = "";
            }
        };
        reader.readAsText(file);
    });

    function close() {
        if (disposed) return;
        disposed = true;
        // 被别的窗口顶掉时不要回面板，否则会「顶掉 → 回面板 → 面板又顶掉」来回打乒乓。
        const displaced = isFloatingWindowDisplaced();
        releaseFloatingWindow(close);
        root.remove();
        if (!displaced) onClose?.();
    }

    claimFloatingWindow(close);
    render();
    action("close").focus();
    return close;
}
