// 顶栏的问号：把**静态说明**收在一处，界面本身只留操作。
//
// 只收「永远成立」的解释性文字。条件性的提示一律留在原地 —— 比如
// 「当前后端把人物位置固定在画面中心」「预设校验失败」「还没保存过配图」，
// 它们只在相关的那一刻出现；收进这个气泡里，等于用户最需要看到它的那一刷看不到。
//
// 结构一律用 createElement 搭，不拼 HTML 串：说明文字里含有 {{占位符}} 这类
// 看起来像标签的内容，走 innerHTML 迟早会被谁当成标记解析。

/** 每个分区的形状：{ heading?, lines?: string[], terms?: [{term, text}] }。 */

function buildSection(section) {
    const block = document.createElement("div");
    block.className = "t-help-section";

    if (section.heading) {
        const heading = document.createElement("div");
        heading.className = "t-help-heading";
        heading.textContent = section.heading;
        block.append(heading);
    }
    if (Array.isArray(section.terms) && section.terms.length) {
        const list = document.createElement("dl");
        list.className = "t-help-terms";
        for (const item of section.terms) {
            const term = document.createElement("dt");
            const code = document.createElement("code");
            code.textContent = item.term;
            term.append(code);
            const text = document.createElement("dd");
            text.textContent = item.text;
            list.append(term, text);
        }
        block.append(list);
    }
    if (Array.isArray(section.lines) && section.lines.length) {
        const list = document.createElement("ul");
        list.className = "t-help-lines";
        for (const line of section.lines) {
            const entry = document.createElement("li");
            entry.textContent = line;
            list.append(entry);
        }
        block.append(list);
    }
    return block;
}

/**
 * 造一个「问号 + 说明气泡」，返回可直接放进顶栏的容器。
 *
 * 气泡随窗口一起被移除，但打开时挂在 document 上的关闭监听不会自己消失 ——
 * 窗口关闭时必须调一次 close()，否则监听会一直累积。
 *
 * @param {object} options
 * @param {string} [options.label] 按钮的无障碍名称与悬浮提示
 * @param {string} [options.title] 气泡里的标题
 * @param {Array} [options.sections] 分区列表
 * @param {string} [options.action] 给按钮的 data-action（该窗口若按此派发点击）
 * @returns {{root: HTMLElement, close: () => void}}
 */
export function createHelpTip({ label = "使用说明", title = "使用说明", sections = [], action = "" } = {}) {
    const root = document.createElement("span");
    root.className = "t-help";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "t-btn";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-expanded", "false");
    if (action) button.dataset.action = action;
    const icon = document.createElement("i");
    icon.className = "fa-solid fa-circle-question";
    button.append(icon);

    const popover = document.createElement("div");
    popover.className = "t-help-popover";
    popover.hidden = true;
    const heading = document.createElement("div");
    heading.className = "t-help-title";
    heading.textContent = title;
    popover.append(heading);
    for (const section of sections) popover.append(buildSection(section));

    root.append(button, popover);

    let open = false;
    function onDocumentClick(event) {
        // 点在容器之外才收起；点问号本身交给按钮自己的处理器去切换，免得关了又开。
        if (!root.contains(event.target)) setOpen(false);
    }
    function onKeydown(event) {
        if (event.key === "Escape") setOpen(false);
    }
    function setOpen(next) {
        if (open === next) return;
        open = next;
        popover.hidden = !next;
        button.setAttribute("aria-expanded", String(next));
        if (next) {
            // 捕获阶段：这样即使点在别处某个 stopPropagation 的处理器上也能收起。
            document.addEventListener("click", onDocumentClick, true);
            document.addEventListener("keydown", onKeydown);
        } else {
            document.removeEventListener("click", onDocumentClick, true);
            document.removeEventListener("keydown", onKeydown);
        }
    }

    button.addEventListener("click", () => setOpen(!open));

    return { root, close: () => setOpen(false) };
}
