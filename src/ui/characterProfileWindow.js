// 人物外观档案管理窗口：小剧场场景配图专用。
//
// 独立窗口而不是塞进设置页签，是有原因的：设置窗口的改动只在点「保存所有配置」时
// 才落盘，而配图面板是另一个界面，中间那段时间它会读到旧档案。这里一律即时落盘。

import { getExtData, saveExtData } from "../utils/storage.js";
import {
    CHARACTER_PROFILES_KEY, CARD_KEY_PREFIX, CHARACTER_PROFILES_VERSION, MAX_PROFILE_BLOCK_CHARS,
    MIN_KEYWORD_LENGTH, createCharacterProfile, readCharacterProfiles,
} from "../core/characterProfiles.js";
import { getCharacterCardKey, getCurrentCharacterDescription, getCurrentUserPersona, listCharacterCards } from "../core/context.js";
import { claimFloatingWindow, isFloatingWindowDisplaced, releaseFloatingWindow } from "./shared/floatingWindow.js";

/** 通知配图面板重画勾选条。本窗口不监听这个事件，否则自己每改一次就整体重画、输入框失焦。 */
function notifyProfilesChanged() {
    window.dispatchEvent(new CustomEvent("titania:character-profiles-changed"));
}

/** 角色卡描述常带 HTML，导入时先剥标签，给一个干净的初值。 */
function stripHtml(value) {
    return String(value ?? "").replace(/<[^>]*>/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function bindingLabel(cardKey) {
    return cardKey ? cardKey.slice(CARD_KEY_PREFIX.length) : "不绑定角色卡";
}

/**
 * 打开人物外观档案管理窗口。
 * @param {object} [options]
 * @param {() => void} [options.onClose] 用户主动关闭后回调（用于回到配图面板）
 * @returns {() => void} 关闭函数
 */
export function openCharacterProfileWindow(options = {}) {
    const { onClose } = options;
    const root = document.createElement("div");
    root.className = "t-root t-profile-window";
    root.innerHTML = `
        <section class="t-profile-panel" role="dialog" aria-labelledby="t-profile-title">
            <div class="t-panel-header">
                <strong id="t-profile-title">人物外观档案</strong>
                <button type="button" class="t-btn" data-action="close" title="关闭档案管理" aria-label="关闭档案管理"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="t-profile-body">
                <p class="t-illustration-hint">
                    为角色写一次外观，之后进这个角色的配图会自动带上。绑定角色卡后在该角色的聊天里必中；
                    没绑定的靠触发词在正文里匹配。档案只描述「画面里有什么」——质量词、画师串与预设仍由 Cosmos Vision 追加。
                    <br>你自己（用户设定）也能这么记一份：导入后不绑卡，靠名字在正文里匹配。
                    <br>群聊里没有单一角色卡，绑定不会生效，请用触发词，或到配图面板里手动勾选。
                </p>
                <div class="t-profile-actions">
                    <button type="button" class="t-btn primary" data-action="add" title="新建一条外观档案" aria-label="新建档案"><i class="fa-solid fa-plus"></i></button>
                    <button type="button" class="t-btn" data-action="import" title="从当前打开的角色卡导入描述" aria-label="从当前角色卡导入"><i class="fa-solid fa-id-card"></i></button>
                    <button type="button" class="t-btn" data-action="import-persona" title="从当前用户设定（Persona）导入描述" aria-label="从当前用户设定导入"><i class="fa-solid fa-user"></i></button>
                    <span class="t-illustration-hint" data-role="status"></span>
                </div>
                <div class="t-profile-list" data-role="list"></div>
            </div>
        </section>`;
    document.body.append(root);

    const role = name => root.querySelector(`[data-role="${name}"]`);
    const action = name => root.querySelector(`[data-action="${name}"]`);
    let disposed = false;
    let draggedId = "";

    /**
     * 就地改档案并落盘。
     * @param {(list: object[]) => void} mutate 直接改数组
     * @param {boolean} rerender 结构性改动（增删/排序/停用）才需要整体重画；
     *   文本输入**不要**重画，否则正在编辑的输入框会失焦。
     */
    function writeEntries(mutate, rerender = false) {
        const data = getExtData();
        const current = data[CHARACTER_PROFILES_KEY];
        if (!current || !Array.isArray(current.entries)) {
            data[CHARACTER_PROFILES_KEY] = { version: CHARACTER_PROFILES_VERSION, entries: [] };
        }
        mutate(data[CHARACTER_PROFILES_KEY].entries);
        saveExtData();
        notifyProfilesChanged();
        if (rerender && !disposed) renderList();
    }

    function withEntry(id, apply) {
        return list => {
            const found = list.find(item => item.id === id);
            if (found) apply(found);
        };
    }

    function labeled(labelText, control) {
        const wrap = document.createElement("label");
        wrap.className = "t-illustration-field";
        wrap.append(document.createTextNode(labelText), control);
        return wrap;
    }

    function textInput(value, placeholder, onInput) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "t-input";
        input.value = value;
        input.placeholder = placeholder;
        input.addEventListener("input", () => onInput(input.value));
        return input;
    }

    function cardSelect(entry) {
        const select = document.createElement("select");
        select.className = "t-input";
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "不绑定角色卡";
        select.append(none);
        const cards = listCharacterCards();
        for (const card of cards) {
            const option = document.createElement("option");
            option.value = card.cardKey;
            option.textContent = card.name;
            select.append(option);
        }
        // 绑定的卡可能已不在本地（换过安装、删过卡）：补一个占位项，免得选择被静默清空。
        if (entry.cardKey && !cards.some(card => card.cardKey === entry.cardKey)) {
            const stale = document.createElement("option");
            stale.value = entry.cardKey;
            stale.textContent = `${bindingLabel(entry.cardKey)}（本地已找不到）`;
            select.append(stale);
        }
        select.value = entry.cardKey;
        select.addEventListener("change", () => writeEntries(withEntry(entry.id, target => { target.cardKey = select.value; })));
        return select;
    }

    function buildCard(entry) {
        const card = document.createElement("article");
        card.className = "t-profile-card";
        card.dataset.profileId = entry.id;
        card.draggable = true;

        const header = document.createElement("div");
        header.className = "t-profile-card-header";

        const grip = document.createElement("span");
        grip.className = "t-profile-grip";
        grip.title = "拖动排序";
        grip.textContent = "⠿";

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = `t-profile-toggle${entry.enabled ? " is-on" : ""}`;
        toggle.textContent = entry.enabled ? "启用" : "停用";
        toggle.title = entry.enabled ? "点击停用：停用后不参与匹配" : "点击启用";
        toggle.addEventListener("click", () => writeEntries(withEntry(entry.id, target => { target.enabled = !target.enabled; }), true));

        const del = document.createElement("button");
        del.type = "button";
        del.className = "t-btn";
        del.title = "删除这条档案";
        del.setAttribute("aria-label", "删除这条档案");
        const trash = document.createElement("i");
        trash.className = "fa-solid fa-trash";
        del.append(trash);
        del.addEventListener("click", () => {
            if (!confirm(`确定删除外观档案「${entry.name || "未命名角色"}」吗？`)) return;
            writeEntries(list => {
                const index = list.findIndex(item => item.id === entry.id);
                if (index >= 0) list.splice(index, 1);
            }, true);
        });

        header.append(grip, toggle, del);
        card.append(header);

        card.append(labeled("档案名称", textInput(entry.name, "例如：阿离", value => {
            writeEntries(withEntry(entry.id, target => { target.name = value; }));
        })));

        card.append(labeled("触发词（逗号分隔）", textInput(entry.keywords.join("，"), "例如：阿离，小离，离姑娘", value => {
            // 中英文逗号与顿号都收；长度下限由 characterProfiles 规范化时统一裁掉。
            const keywords = value.split(/[,，、]/).map(text => text.trim()).filter(Boolean);
            writeEntries(withEntry(entry.id, target => { target.keywords = keywords; }));
        })));

        card.append(labeled("绑定角色卡", cardSelect(entry)));

        const content = document.createElement("textarea");
        content.className = "t-input";
        content.rows = 5;
        content.value = entry.content;
        content.placeholder = "例如：银白长发，红瞳，常穿深色长外套，左耳有一枚银色耳环。";
        const counter = document.createElement("p");
        counter.className = "t-illustration-hint";
        const refreshCounter = () => {
            counter.textContent = `当前 ${content.value.length} 字符 · ${bindingLabel(entry.cardKey)}`;
        };
        content.addEventListener("input", () => {
            writeEntries(withEntry(entry.id, target => { target.content = content.value; }));
            refreshCounter();
        });
        refreshCounter();
        card.append(labeled(`外观描写（最多 ${MAX_PROFILE_BLOCK_CHARS} 字符）`, content), counter);

        card.addEventListener("dragstart", event => {
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
            const rect = card.getBoundingClientRect();
            const insertBefore = event.clientY < rect.top + rect.height / 2;
            writeEntries(list => {
                const from = list.findIndex(item => item.id === sourceId);
                if (from < 0) return;
                const [moved] = list.splice(from, 1);
                const base = list.findIndex(item => item.id === entry.id);
                if (base < 0) { list.push(moved); return; }
                list.splice(insertBefore ? base : base + 1, 0, moved);
            }, true);
            draggedId = "";
        });

        return card;
    }

    function renderList() {
        const list = role("list");
        list.replaceChildren();
        const items = readCharacterProfiles(getExtData());
        if (!items.length) {
            const empty = document.createElement("p");
            empty.className = "t-illustration-hint";
            empty.textContent = "还没有档案。点「新建档案」，或用上面两个导入按钮把当前角色卡 / 用户设定的描述拉进来当草稿。";
            list.append(empty);
            return;
        }
        for (const entry of items) list.append(buildCard(entry));
    }

    function importFromCard() {
        const description = stripHtml(getCurrentCharacterDescription());
        if (!description) {
            role("status").textContent = "当前聊天没有可导入的角色卡描述。";
            return;
        }
        // getCharacterCardKey 在群聊里退回 name: 键，characterProfiles 会把非 card: 的键丢掉，
        // 于是群聊导入得到的是一份无绑定草稿 —— 与「群聊不按卡绑定」的约定一致。
        const cardKey = getCharacterCardKey();
        const name = listCharacterCards().find(card => card.cardKey === cardKey)?.name || "导入的角色";
        const created = { ...createCharacterProfile(name), content: description, cardKey };
        writeEntries(list => list.push(created), true);
        role("status").textContent = cardKey.startsWith(CARD_KEY_PREFIX)
            ? `已导入「${name}」的角色卡描述，可在下面继续精简。`
            : "已导入描述，但当前是群聊，无法绑定角色卡。";
    }

    function importFromPersona() {
        const { name, description } = getCurrentUserPersona();
        const content = stripHtml(description);
        if (!content) {
            role("status").textContent = "当前没有启用中的用户设定（Persona）可导入。";
            return;
        }
        // 用户设定不属于任何一张角色卡，所以不填 cardKey —— 绑上去会在别的角色的聊天里
        // 也强行带入。名字才是它该用的匹配依据。
        const label = name || "我";
        const created = { ...createCharacterProfile(label), content, keywords: name ? [name] : [] };
        writeEntries(list => list.push(created), true);
        // 短于下限的名字会被规范化当场剔除（单字几乎命中任何正文），明说一句，
        // 免得用户以为导入失败了 —— 档案本身是进去了的。
        role("status").textContent = name.length < MIN_KEYWORD_LENGTH
            ? `已导入「${label}」的用户设定，但名字短于 ${MIN_KEYWORD_LENGTH} 字，没能写成触发词，请手动补一个。`
            : `已导入「${label}」的用户设定，触发词已填好，可在下面继续精简。`;
    }

    root.addEventListener("click", event => {
        const button = event.target.closest("button");
        if (!button || button.disabled) return;
        const operation = button.dataset.action;
        if (operation === "close") { close(); return; }
        if (operation === "add") { writeEntries(list => list.push(createCharacterProfile("新档案")), true); return; }
        if (operation === "import") { importFromCard(); return; }
        if (operation === "import-persona") { importFromPersona(); return; }
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
    renderList();
    action("close").focus();
    return close;
}
