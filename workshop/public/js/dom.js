// DOM 工具
// 关键：纯原生 JS 没有框架帮你转义，所有陌生人输入的字符串一律走 textContent。
// 这个文件里没有任何 innerHTML —— 这是有意的，别加。

export function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);

    for (const [k, v] of Object.entries(props)) {
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;      // 唯一的文本写入方式
        else if (k === "dataset") Object.assign(node.dataset, v);
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
    }

    for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) continue;
        node.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
}

export function mount(...nodes) {
    const view = document.getElementById("view");
    view.replaceChildren(...nodes.filter(Boolean));
    window.scrollTo(0, 0);
}

let toastTimer;
export function toast(message) {
    const box = document.getElementById("toast");
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 2600);
}

export function fmtDate(sec) {
    if (!sec) return "";
    const d = new Date(sec * 1000);
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function loading(text = "加载中…") {
    return el("div", { class: "empty", text });
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // http 或旧浏览器下 clipboard API 不可用
        const ta = el("textarea", { style: "position:fixed;opacity:0" });
        ta.value = text;
        document.body.append(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
    }
}
