// 人物外观档案管理窗口：小剧场场景配图专用。
//
// 独立窗口而不是塞进设置页签，是有原因的：设置窗口的改动只在点「保存所有配置」时
// 才落盘，而配图面板是另一个界面，中间那段时间它会读到旧档案。这里一律即时落盘。
//
// 布局分两层：顶上一分为二的标签栏（角色档案 / 用户档案，默认停在角色档案），
// 下面是当前这一组的紧凑小卡网格，点一张就地展开成整行的编辑区。
// 两组同时铺在一屏里会互相挤，切页签才看得清哪一组有什么。
// 原先更糟：每条都摊开成通栏大卡（一条近 250px 高），档案一多就得靠滚动找 ——
// 用户的原话是「要改动某个角色就得找半天」。
//
// ⚠ 下面这些类名与场景配图设置窗（选景预设编辑器）**共用**，规则一个字都不能改：
//   .t-profile-window / -panel / -body / -card-header / -grip / -toggle
// 改它们会把预设编辑器一起改掉。本窗口自己的布局一律用 .t-profile-groups /
// -group / -grid / -tile / -tile-body 这些新名字，共用类只按原样复用。
// 反过来 .t-profile-expand 是预设编辑器独占的，可以放心复用（自带 flex:1 + 省略号）。
//
// ⚠ 分组只是**展示**上的分区。底层数组仍是扁平一条，顺序决定「最多自动带入 4 条」
// 取谁。所以组内拖动只重排该组占用的下标，另一组的绝对位置原地不动 —— 详见 reorderWithinKind。

import { getExtData, saveExtData } from "../utils/storage.js";
import {
    CHARACTER_PROFILES_KEY, CARD_KEY_PREFIX, CHARACTER_PROFILES_VERSION,
    MIN_KEYWORD_LENGTH, PROFILE_KIND_CHARACTER, PROFILE_KIND_USER,
    createCharacterProfile, ensureCharacterProfiles, isAutoKeywords, keywordsFromName,
    profileKind, readCharacterProfiles,
} from "../core/characterProfiles.js";
import { getCharacterCardKey, getCurrentCharacterDescription, getCurrentUserPersona, listCharacterCards } from "../core/context.js";
import { claimFloatingWindow, isFloatingWindowDisplaced, releaseFloatingWindow } from "./shared/floatingWindow.js";
import { createHelpTip } from "./shared/helpPopover.js";

/**
 * 顶栏问号里的**静态**说明：这档案是干什么的、什么时候会被用上。
 * 条件性的东西留在原位 —— 命中数、字数计数、空列表提示都只在当时有意义。
 */
const PROFILE_HELP = [
    {
        heading: "干什么用的",
        lines: [
            "为角色写一次外观，之后进这个角色的配图会自动带上 —— 正文没写发色服装时，画面才不会飘。",
            "档案只描述「画面里有什么」。质量词、画师串与预设仍由生图后端追加，写在这里会重复叠加。",
        ],
    },
    {
        heading: "两组档案",
        lines: [
            "**角色档案**：给某个角色写的。绑定了角色卡的，进这个角色的任何聊天都必中。",
            "**用户档案**：给你自己（{{user}} / Persona）写的，恒定不绑卡，只按触发词匹配。",
            "归属记在档案里，不是靠绑没绑卡推出来的 —— 没绑卡的角色档案仍然属于角色档案。",
            "分组只是方便找。拖动排序只能在同组内进行；要换组，用编辑区里的「归属与绑定」下拉。",
        ],
    },
    {
        heading: "什么时候会被用上",
        lines: [
            "绑定了角色卡的：进这个角色的任何聊天都必中，绑定用的是角色卡身份（基于头像文件名）。",
            "没绑定的、或绑定没命中的：按触发词在本轮正文里匹配，触发词至少两个字符。",
            "触发词默认跟着档案名走：填个名字它就自动填好；你自己写过之后它就归你，改名不再覆盖。",
            "单次最多自动带入 4 条，按列表顺序取。命中的会填进配图面板的「人物资料」并预勾选，你手打的内容永远不会被覆盖。",
        ],
    },
    {
        heading: "从哪儿导入",
        lines: [
            "「从当前角色卡导入」读当前打开那张卡的描述原文，导入后归入角色档案并自动绑定该卡。",
            "「从当前用户设定导入」读当前生效的 Persona 正文，归入用户档案、不绑卡 —— 用户设定不属于任何一张卡，绑上去会在别的角色的聊天里也被强行带入。",
        ],
    },
    {
        heading: "群聊",
        lines: [
            "群聊里没有单一角色卡，绑定不会生效（{{char}} 不指向具体成员）。请用触发词匹配，或到配图面板里手动勾选。",
            "一对一里绑定的档案不会跟着角色进群。",
        ],
    },
];

/** 两个页签。顺序即横栏里的左右顺序，第一个是进窗时的默认页签。 */
const GROUPS = [
    {
        kind: PROFILE_KIND_CHARACTER,
        title: "角色档案",
        empty: "还没有角色档案。点「新建档案」，或用「从当前角色卡导入」把当前角色卡的描述拉进来当草稿。",
    },
    {
        kind: PROFILE_KIND_USER,
        title: "用户档案",
        empty: "还没有用户档案。用「从当前用户设定导入」把你的 Persona 记一份在这里。",
    },
];

/**
 * 绑定下拉里代表「用户本人」的哨兵值。
 * 不可能与卡键相撞：卡键一定有 card: 前缀。
 */
const USER_BINDING_VALUE = "__user__";

/** 通知配图面板重画勾选条。本窗口不监听这个事件，否则自己每改一次就整体重画、输入框失焦。 */
function notifyProfilesChanged() {
    window.dispatchEvent(new CustomEvent("titania:character-profiles-changed"));
}

/** 角色卡描述常带 HTML，导入时先剥标签，给一个干净的初值。 */
function stripHtml(value) {
    return String(value ?? "").replace(/<[^>]*>/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** 档案归属的显示名。用户档案说「用户本人」，角色档案有绑定就报卡名。 */
function ownerLabel(entry) {
    if (profileKind(entry) === PROFILE_KIND_USER) return "用户本人";
    return entry.cardKey ? entry.cardKey.slice(CARD_KEY_PREFIX.length) : "不绑定角色卡";
}

/** 收起态卡片上的那一行摘要：归属与体量，够用来认出是哪一条。 */
function tileMeta(entry) {
    return `${ownerLabel(entry)} · ${String(entry.content ?? "").length} 字符`;
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
                <div class="t-panel-header-actions" data-role="header-actions">
                    <button type="button" class="t-icon-btn" data-action="close" title="关闭档案管理" aria-label="关闭档案管理"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="t-profile-body">
                <div class="t-profile-actions">
                    <button type="button" class="t-btn primary" data-action="add" title="新建一条外观档案" aria-label="新建档案"><i class="fa-solid fa-plus"></i></button>
                    <button type="button" class="t-btn" data-action="import" title="从当前打开的角色卡导入描述" aria-label="从当前角色卡导入"><i class="fa-solid fa-id-card"></i></button>
                    <button type="button" class="t-btn" data-action="import-persona" title="从当前用户设定（Persona）导入描述" aria-label="从当前用户设定导入"><i class="fa-solid fa-user"></i></button>
                    <span class="t-illustration-hint" data-role="status"></span>
                </div>
                <div class="t-profile-tabs" data-role="tabs" role="tablist"></div>
                <div class="t-profile-groups" data-role="list"></div>
            </div>
        </section>`;
    document.body.append(root);

    const role = name => root.querySelector(`[data-role="${name}"]`);
    const action = name => root.querySelector(`[data-action="${name}"]`);
    // 静态说明统一收进顶栏的问号，界面本身只留操作。
    const help = createHelpTip({ title: "人物外观档案", sections: PROFILE_HELP });
    role("header-actions").insertBefore(help.root, action("close"));
    let disposed = false;
    /** 展开的卡片 id。只活在本次开窗期间，不持久化 —— 关窗即弃，重开是全折叠。 */
    const expandedIds = new Set();
    /** 当前页签。进窗默认角色档案；关窗不记，重开也回到角色档案。 */
    let activeKind = GROUPS[0].kind;
    let draggedId = "";
    let draggedKind = "";

    /**
     * 就地改档案并落盘。
     * @param {(list: object[]) => void} mutate 直接改数组
     * @param {boolean} rerender 结构性改动（增删/换组/排序/停用）才需要整体重画；
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
        if (rerender && !disposed) renderGroups();
    }

    function withEntry(id, apply) {
        return list => {
            const found = list.find(item => item.id === id);
            if (found) apply(found);
        };
    }

    /**
     * 读当前档案并做一次防御性规范化。
     * 生产路径上 getExtData() 已经跑过 ensureCharacterProfiles，但测试夹具的 getExtData
     * 是裸桩，这里补一次，视图才不会依赖「上游一定规范化过」。
     */
    function currentEntries() {
        const data = getExtData();
        ensureCharacterProfiles(data);
        return readCharacterProfiles(data);
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

    /** 归属与绑定：三选一 —— 不绑卡 / 用户本人 / 某张角色卡。选了就换组，所以要重画。 */
    function bindingSelect(entry) {
        const select = document.createElement("select");
        select.className = "t-input";
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "不绑定角色卡";
        select.append(none);
        const self = document.createElement("option");
        self.value = USER_BINDING_VALUE;
        self.textContent = "用户本人（{{user}}）";
        select.append(self);
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
            stale.textContent = `${entry.cardKey.slice(CARD_KEY_PREFIX.length)}（本地已找不到）`;
            select.append(stale);
        }
        select.value = profileKind(entry) === PROFILE_KIND_USER ? USER_BINDING_VALUE : entry.cardKey;
        select.addEventListener("change", () => {
            const wasUser = profileKind(entry) === PROFILE_KIND_USER;
            writeEntries(withEntry(entry.id, target => {
                if (select.value === USER_BINDING_VALUE) {
                    target.kind = PROFILE_KIND_USER;
                    // 归属换成用户就必须解绑：绑卡的用户档案在下拉里表达不出来，也退不回去。
                    target.cardKey = "";
                } else {
                    target.kind = PROFILE_KIND_CHARACTER;
                    target.cardKey = select.value;
                }
            }), true);
            // 换了组就等于从当前页签里消失。不说一句的话，看着就像这条档案被删了。
            if (wasUser !== (select.value === USER_BINDING_VALUE)) {
                role("status").textContent = select.value === USER_BINDING_VALUE
                    ? `「${entry.name || "未命名角色"}」已移到用户档案。`
                    : `「${entry.name || "未命名角色"}」已移到角色档案。`;
            }
        });
        return select;
    }

    function buildTileBody(entry, syncSummary) {
        const body = document.createElement("div");
        body.className = "t-profile-tile-body";

        // 触发词默认跟着档案名走：新建档案时只要填个名字，触发词就自动有了，不必再手打一遍。
        // 一旦用户自己改过，就不再动它 —— 与「人物资料」那条「手打的永不被覆盖」同一原则。
        const keywordsInput = textInput(entry.keywords.join("，"), "例如：阿离，小离，离姑娘", value => {
            // 中英文逗号与顿号都收；长度下限由 characterProfiles 规范化时统一裁掉。
            const keywords = value.split(/[,，、]/).map(text => text.trim()).filter(Boolean);
            writeEntries(withEntry(entry.id, target => { target.keywords = keywords; }));
        });

        body.append(labeled("档案名称", textInput(entry.name, "例如：阿离", value => {
            writeEntries(withEntry(entry.id, target => {
                // 判定要在改名字**之前**做：这条规则比较的正是「触发词是否仍等于当前名字」。
                const follow = isAutoKeywords(target);
                target.name = value;
                if (!follow) return;
                target.keywords = keywordsFromName(value);
                // 不重画列表（那会把输入焦点和光标位置一起弄丢），只同步这一格的值。
                keywordsInput.value = target.keywords.join("，");
            }));
            // 卡片头与摘要行是折叠时唯一可见的部分，打字时不跟着变就会一直显示旧名字。
            syncSummary();
        })));

        body.append(labeled("触发词（逗号分隔）", keywordsInput));

        body.append(labeled("归属与绑定", bindingSelect(entry)));

        const content = document.createElement("textarea");
        content.className = "t-input";
        content.rows = 5;
        content.value = entry.content;
        content.placeholder = "例如：银白长发，红瞳，常穿深色长外套，左耳有一枚银色耳环。";
        const counter = document.createElement("p");
        counter.className = "t-illustration-hint";
        const refreshCounter = () => {
            counter.textContent = `当前 ${content.value.length} 字符 · ${ownerLabel(entry)}`;
        };
        content.addEventListener("input", () => {
            writeEntries(withEntry(entry.id, target => { target.content = content.value; }));
            refreshCounter();
            syncSummary();
        });
        refreshCounter();
        body.append(labeled("外观描写", content), counter);

        const del = document.createElement("button");
        del.type = "button";
        del.className = "t-btn t-btn-danger";
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
            });
            // 陈旧 id 本身无害（只查还在列表里的），删掉纯粹是卫生。
            expandedIds.delete(entry.id);
            renderGroups();
        });
        const foot = document.createElement("div");
        foot.className = "t-profile-tile-foot";
        foot.append(del);
        body.append(foot);

        return body;
    }

    function buildTile(entry) {
        const open = expandedIds.has(entry.id);
        const card = document.createElement("article");
        card.className = `t-profile-tile${open ? " is-expanded" : ""}`;
        card.dataset.profileId = entry.id;
        card.dataset.kind = profileKind(entry);
        card.draggable = true;

        const header = document.createElement("div");
        header.className = "t-profile-card-header";

        const grip = document.createElement("span");
        grip.className = "t-profile-grip";
        grip.title = "拖动排序（只能在同组内拖动）";
        grip.textContent = "⠿";

        const expand = document.createElement("button");
        expand.type = "button";
        expand.className = "t-profile-expand";
        expand.setAttribute("aria-expanded", String(open));
        expand.title = open ? "收起" : "展开编辑";
        expand.textContent = `${open ? "▾" : "▸"} ${entry.name || "未命名角色"}`;
        expand.addEventListener("click", () => toggleExpanded(entry.id));

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = `t-profile-toggle${entry.enabled ? " is-on" : ""}`;
        toggle.textContent = entry.enabled ? "启用" : "停用";
        toggle.title = entry.enabled ? "点击停用：停用后不参与匹配" : "点击启用";
        toggle.addEventListener("click", () => writeEntries(withEntry(entry.id, target => { target.enabled = !target.enabled; }), true));

        header.append(grip, expand, toggle);
        card.append(header);

        const meta = document.createElement("p");
        meta.className = "t-profile-tile-meta";
        meta.textContent = tileMeta(entry);
        card.append(meta);

        // 打字时只改这一行与卡片头，不重画列表（重画会丢焦点）。
        const syncSummary = () => {
            meta.textContent = tileMeta(entry);
            expand.textContent = `${expandedIds.has(entry.id) ? "▾" : "▸"} ${entry.name || "未命名角色"}`;
        };

        if (open) card.append(buildTileBody(entry, syncSummary));

        // 点卡片空白处也能展开；点在控件上就交给控件自己处理。
        card.addEventListener("click", event => {
            if (event.target.closest("button, input, textarea, select, label, .t-profile-grip")) return;
            toggleExpanded(entry.id);
        });
        bindDrag(card, entry);
        return card;
    }

    // --- 拖动排序 ---

    function clearDropMarks(scope) {
        for (const tile of (scope || root).querySelectorAll(".t-profile-tile")) {
            tile.classList.remove("is-drop-before", "is-drop-after");
        }
    }

    function markDropTarget(card, after) {
        for (const tile of root.querySelectorAll(".t-profile-tile")) {
            tile.classList.toggle("is-drop-before", tile === card && !after);
            tile.classList.toggle("is-drop-after", tile === card && after);
        }
    }

    /**
     * 落点在目标卡片之前还是之后。
     *
     * 网格里不能只比 Y：两列时指针停在一张卡的下半部，按 Y 会判成「插到它之后」，
     * 也就等于插到右卡之前，视觉上像跳了一格。所以先看同一行还有没有下一张卡 ——
     * 有就交给 X 决定（歧义消失），没有才用 Y。
     *
     * 三种情形都收敛：一行最后一张的「之后」与下一行第一张的「之前」本来就是同一个下标，
     * 所以走 Y 分支落在同一个边界上；单列时每张卡的后继都在新行、一律走 Y，
     * 与改动前的行为逐字等价。
     */
    function dropAfter(event, card) {
        const rect = card.getBoundingClientRect();
        const nextRect = card.nextElementSibling?.getBoundingClientRect?.();
        const sameRow = Boolean(nextRect) && Math.abs(nextRect.top - rect.top) < rect.height / 2;
        return sameRow
            ? event.clientX >= rect.left + rect.width / 2
            : event.clientY >= rect.top + rect.height / 2;
    }

    /** 拖动结束后的组内 id 顺序。 */
    function reorderedIds(kind, sourceId, targetId, after) {
        const ids = currentEntries().filter(entry => profileKind(entry) === kind).map(entry => entry.id);
        const from = ids.indexOf(sourceId);
        if (from < 0 || !ids.includes(targetId)) return null;
        ids.splice(from, 1);
        // 移除源之后目标的下标会左移，所以要在移除之后再找一次。
        const landing = ids.indexOf(targetId);
        if (landing < 0) return null;
        ids.splice(after ? landing + 1 : landing, 0, sourceId);
        return ids;
    }

    /**
     * 只重排某一组本身占用的那几个下标 —— 另一组的元素一个都不动，下标也不动。
     * 用赋值而不是 splice：数组长度与其它元素的位置都保持不变。
     *
     * 为什么不整体重组（角色全排前、用户全排后）：那样一次**组内**拖动就会挪动另一组
     * 所有条目的绝对下标。角色档案一旦超过 MAX_MATCHED_PROFILES 条，用户档案就永远被
     * 挤出上限、再也不自动带入 —— 而这个后果在分组界面里完全看不见。展示上的分区不该
     * 渗进匹配优先级。
     */
    function reorderWithinKind(kind, ids) {
        if (!ids) return;
        writeEntries(list => {
            const byId = new Map(list.map(item => [item.id, item]));
            const slots = [];
            list.forEach((item, index) => { if (profileKind(item) === kind) slots.push(index); });
            slots.forEach((index, i) => {
                const moved = byId.get(ids[i]);
                if (moved) list[index] = moved;
            });
        }, true);
    }

    function bindDrag(card, entry) {
        card.addEventListener("dragstart", event => {
            // 展开的编辑区在可拖动的卡片内部：没有这条，在输入框里选词会把整张卡拖走。
            if (event.target.closest?.("input, textarea, select, button, a")) {
                event.preventDefault();
                return;
            }
            draggedId = entry.id;
            draggedKind = profileKind(entry);
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", entry.id);
            }
            card.classList.add("is-dragging");
        });
        card.addEventListener("dragend", () => {
            card.classList.remove("is-dragging");
            draggedId = "";
            draggedKind = "";
            clearDropMarks();
        });
        card.addEventListener("dragover", event => {
            // 页签把两组隔开了，所以归属检查现在只是兜底 —— 除非以后又让两组同屏，
            // 否则渲染出来的卡片必然同组。留着是因为它比「拖动跨组」的后果便宜得多。
            // 组不同就什么都不做，**故意不 preventDefault**：浏览器自己给出禁止光标，也不画插入线。
            if (!draggedId || draggedKind !== profileKind(entry)) return;
            event.preventDefault();
            markDropTarget(card, dropAfter(event, card));
        });
        card.addEventListener("dragleave", event => {
            if (event.target === card) clearDropMarks(card);
        });
        card.addEventListener("drop", event => {
            event.preventDefault();
            const sourceId = draggedId || event.dataTransfer?.getData("text/plain") || "";
            const after = dropAfter(event, card);
            const kind = profileKind(entry);
            clearDropMarks();
            draggedId = "";
            draggedKind = "";
            // 兜底判定：不信用 dragover 那道，在实时列表里再确认一次归属一致（见上面那段）。
            const source = currentEntries().find(item => item.id === sourceId);
            if (!source || source.id === entry.id || profileKind(source) !== kind) return;
            reorderWithinKind(kind, reorderedIds(kind, source.id, entry.id, after));
        });
    }

    // --- 渲染 ---

    function toggleExpanded(id) {
        if (expandedIds.has(id)) expandedIds.delete(id);
        else expandedIds.add(id);
        renderGroups();
    }

    /** 横栏：两个等宽页签，各带条数 —— 另一组有没有东西一眼看得到，不用点进去确认。 */
    function renderTabs(counts) {
        const host = role("tabs");
        host.replaceChildren();
        for (const group of GROUPS) {
            const active = group.kind === activeKind;
            const tab = document.createElement("button");
            tab.type = "button";
            tab.className = `t-profile-tab${active ? " is-active" : ""}`;
            tab.dataset.action = "switch-tab";
            tab.dataset.tab = group.kind;
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-selected", String(active));
            tab.append(document.createTextNode(`${group.title} `));
            const count = document.createElement("span");
            count.className = "t-profile-tab-count";
            count.dataset.role = `count-${group.kind}`;
            count.textContent = String(counts.get(group.kind) || 0);
            tab.append(count);
            host.append(tab);
        }
    }

    function buildGroup(group, entries) {
        const section = document.createElement("section");
        section.className = "t-profile-group";
        section.dataset.kind = group.kind;

        const grid = document.createElement("div");
        grid.className = "t-profile-grid";
        grid.dataset.role = `grid-${group.kind}`;
        if (!entries.length) {
            const empty = document.createElement("p");
            empty.className = "t-profile-tile-empty t-illustration-hint";
            empty.textContent = group.empty;
            grid.append(empty);
        }
        for (const entry of entries) grid.append(buildTile(entry));

        section.append(grid);
        return section;
    }

    function renderGroups() {
        const items = currentEntries();
        // 删掉的条目可能还留在展开集合里；只清已不存在的，展开状态本身跨重画保留。
        const present = new Set(items.map(item => item.id));
        for (const id of [...expandedIds]) if (!present.has(id)) expandedIds.delete(id);

        const counts = new Map(GROUPS.map(group => [
            group.kind,
            items.filter(entry => profileKind(entry) === group.kind).length,
        ]));
        renderTabs(counts);

        const host = role("list");
        host.replaceChildren();
        // 只渲染当前页签那一组：两组同时铺开正是「挤在一起」的来源。
        const group = GROUPS.find(item => item.kind === activeKind) || GROUPS[0];
        host.append(buildGroup(group, items.filter(entry => profileKind(entry) === group.kind)));
    }

    /** 新建 / 导入之后切到它所在的那一组、展开并滚进视野，省掉「加完了还得自己找一遍」。 */
    function revealEntry(id, kind) {
        activeKind = kind;
        expandedIds.add(id);
        renderGroups();
        // jsdom 不实现 scrollIntoView，必须可选调用，否则测试直接炸。
        root.querySelector(`[data-profile-id="${id}"]`)?.scrollIntoView?.({ block: "nearest" });
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
        writeEntries(list => list.push(created));
        revealEntry(created.id, PROFILE_KIND_CHARACTER);
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
        // 用户设定不属于任何一张角色卡，所以归入用户档案、不填 cardKey —— 绑上去会在别的
        // 角色的聊天里也强行带入。名字才是它该用的匹配依据。
        const label = name || "我";
        const created = { ...createCharacterProfile(label, PROFILE_KIND_USER), content, keywords: name ? [name] : [] };
        writeEntries(list => list.push(created));
        // 导入的档案落在用户档案组，所以要连同页签一起切过去，否则它会「消失在看不见的那一页」。
        revealEntry(created.id, PROFILE_KIND_USER);
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
        if (operation === "switch-tab") {
            const next = GROUPS.find(group => group.kind === button.dataset.tab);
            if (next && next.kind !== activeKind) {
                activeKind = next.kind;
                renderGroups();
            }
            return;
        }
        if (operation === "add") {
            const created = createCharacterProfile("新档案");
            writeEntries(list => list.push(created));
            revealEntry(created.id, PROFILE_KIND_CHARACTER);
            return;
        }
        if (operation === "import") { importFromCard(); return; }
        if (operation === "import-persona") { importFromPersona(); return; }
    });

    function close() {
        if (disposed) return;
        disposed = true;
        // 被别的窗口顶掉时不要回面板，否则会「顶掉 → 回面板 → 面板又顶掉」来回打乒乓。
        const displaced = isFloatingWindowDisplaced();
        releaseFloatingWindow(close);
        // 说明气泡打开时在 document 上挂了关闭监听，随窗口一起收掉。
        help.close();
        root.remove();
        if (!displaced) onClose?.();
    }

    claimFloatingWindow(close);
    renderGroups();
    action("close").focus();
    return close;
}
