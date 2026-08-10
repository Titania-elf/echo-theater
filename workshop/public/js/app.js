// 入口：hash 路由。用 hash 是有意的 —— 不用配 SPA 回退，爬虫也抓不到内容
import { renderList } from "./list.js";
import { renderDetail } from "./detail.js";
import { renderMine } from "./mine.js";
import { renderEditor } from "./editor.js";
import { renderImport } from "./import.js";
import { renderAuthor } from "./author.js";
import { renderAuthSlot } from "./auth.js";
import { showMature, toggleMature } from "./rating.js";
import { el, mount } from "./dom.js";

function markNav(name) {
    document.querySelectorAll("[data-nav]").forEach(a => {
        a.classList.toggle("active", a.dataset.nav === name);
    });
}

function dispatch() {
    const hash = location.hash.replace(/^#/, "") || "/";
    const [, head, arg] = hash.split("/");

    if (head === "s" && arg) { markNav("list"); return renderDetail(arg); }
    if (head === "u" && arg) { markNav("list"); return renderAuthor(arg); }
    if (head === "mine") { markNav("mine"); return renderMine(); }
    if (head === "new") { markNav("mine"); return renderEditor(null); }
    if (head === "edit" && arg) { markNav("mine"); return renderEditor(arg); }
    if (head === "import") { markNav("import"); return renderImport(); }
    if (!head) { markNav("list"); return renderList(); }

    markNav("list");
    mount(el("div", { class: "empty", text: "页面不存在" }));
}

/**
 * 渲染失败的兜底。
 * 页面上必须留下痕迹 —— 否则 view 里还是上一个占位状态（比如「正在加载…」），
 * 看起来就像请求卡住了，而真正的错误只躺在控制台里。
 */
function renderError(e) {
    console.error("[workshop] 渲染失败", e);
    mount(el("div", { class: "empty" }, [
        el("p", { text: "这个页面没能加载出来" }),
        el("p", { class: "summary", text: String(e?.message || e) }),
        el("button", { text: "重试", onclick: () => route() })
    ]));
}

/**
 * dispatch 的两种失败方式都要接住：
 *   1. 同步抛错 —— render 函数还没返回就崩了，比如 mount(...) 的参数在求值时出错
 *   2. 返回的 promise 被 reject —— render 内部没自己 catch 的异步错误
 * 只接一种都会留下静默失败的缺口，所以 try 和 catch 都要有。
 */
function route() {
    let pending;
    try {
        pending = dispatch();
    } catch (e) {
        return renderError(e);
    }
    return Promise.resolve(pending).catch(renderError);
}

function paintRatingToggle() {
    const box = document.getElementById("ratingToggle");
    box.textContent = showMature() ? "当前：显示全部内容（点击关闭）" : "当前：仅全年龄（点击切换）";
    box.onclick = () => {
        toggleMature();
        paintRatingToggle();
        // 走 route 而不是直接 renderList，是为了同样吃到上面的错误兜底
        if (!location.hash || location.hash === "#/") route();
    };
}

window.addEventListener("hashchange", route);

renderAuthSlot();
paintRatingToggle();
route();
