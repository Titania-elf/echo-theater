// 入口：hash 路由。用 hash 是有意的 —— 不用配 SPA 回退，爬虫也抓不到内容
import { renderList } from "./list.js";
import { renderDetail } from "./detail.js";
import { renderMine } from "./mine.js";
import { renderEditor } from "./editor.js";
import { renderImport } from "./import.js";
import { renderAuthor } from "./author.js";
import { getSession, logoutSession, renderAuthSlot } from "./auth.js";
import { showMature, toggleMature } from "./rating.js";
import { el, mount, toast } from "./dom.js";

let authorized = false;
let bootId = 0;

const topbar = document.querySelector(".topbar");
const footer = document.querySelector(".footer");
const view = document.getElementById("view");

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
    if (!authorized) return;

    let pending;
    try {
        pending = dispatch();
    } catch (e) {
        return renderError(e);
    }
    return Promise.resolve(pending).catch(renderError);
}

function authLoginHref() {
    const returnTo = location.hash.startsWith("#/") ? location.hash : "#/";
    return `/api/auth/login?return_to=${encodeURIComponent(returnTo)}`;
}

function consumeAuthFeedback() {
    const url = new URL(location.href);
    const code = url.searchParams.get("auth_error");
    if (!code) return "";

    url.searchParams.delete("auth_error");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);

    if (code === "cancelled") return "登录未完成，你可以重新尝试。";
    return "Discord 登录暂时失败，请稍后重试。";
}

function echoBrand() {
    return [
        el("div", { class: "echo-mark", "aria-hidden": "true" }),
        el("p", { class: "access-kicker", text: "ECHO WORKSHOP" }),
        el("h1", { text: "回声工坊" })
    ];
}

function showAccessPage(kind, { message = "", session = null } = {}) {
    authorized = false;
    document.body.classList.add("auth-mode");
    topbar.hidden = true;
    footer.hidden = true;
    view.className = "view access-view";

    const content = [...echoBrand()];

    if (kind === "checking") {
        content.push(el("p", { class: "access-status", text: "正在确认登录状态…" }));
    } else if (kind === "guest") {
        content.push(
            el("p", { class: "access-lead", text: "发现、分享并管理回声剧场指令。" }),
            message ? el("p", { class: "access-notice", text: message }) : null,
            el("a", {
                class: "access-action",
                href: authLoginHref(),
                text: "使用 Discord 登录"
            }),
            el("p", {
                class: "access-privacy",
                text: "仅获取你的 Discord 昵称、头像和用户 ID，不读取邮箱或服务器列表。"
            })
        );
    } else if (kind === "banned") {
        content.push(
            el("p", { class: "access-lead", text: "此账号暂时无法访问回声工坊。" }),
            el("p", {
                class: "access-notice is-danger",
                text: "如有疑问，请在 Discord 联系管理员。"
            })
        );

        const exitBtn = el("button", { class: "access-secondary", text: "退出当前账号" });
        exitBtn.addEventListener("click", async () => {
            exitBtn.disabled = true;
            try {
                await logoutSession();
                location.hash = "#/";
                showAccessPage("guest", { message: "已退出当前账号。" });
            } catch (e) {
                toast(e?.message || "退出失败，请重试");
                exitBtn.disabled = false;
            }
        });
        content.push(exitBtn);

        if (session?.user?.name) {
            content.push(el("p", { class: "access-account", text: `当前账号：${session.user.name}` }));
        }
    } else {
        content.push(
            el("p", { class: "access-lead", text: "暂时无法连接回声工坊。" }),
            el("p", {
                class: "access-notice is-danger",
                text: message || "请检查网络连接后重试。"
            }),
            el("button", { class: "access-secondary", text: "重新连接", onclick: bootstrap })
        );
    }

    mount(el("section", { class: "access-page" }, [
        el("div", { class: `access-panel access-${kind}` }, content)
    ]));
}

async function handleLogout() {
    await logoutSession();
    location.hash = "#/";
    showAccessPage("guest", { message: "已安全退出。" });
}

function startApp(session) {
    authorized = true;
    document.body.classList.remove("auth-mode");
    topbar.hidden = false;
    footer.hidden = false;
    view.className = "view";
    renderAuthSlot(session, { onLogout: handleLogout });
    paintRatingToggle();
    route();
}

async function bootstrap() {
    const currentBoot = ++bootId;
    const feedback = consumeAuthFeedback();
    showAccessPage("checking");

    let session;
    try {
        session = await getSession({ force: true });
    } catch (e) {
        if (currentBoot !== bootId) return;
        showAccessPage("error", { message: e?.message });
        return;
    }

    if (currentBoot !== bootId) return;
    if (!session.logged_in) {
        showAccessPage("guest", { message: feedback });
        return;
    }
    if (session.banned) {
        showAccessPage("banned", { session });
        return;
    }

    startApp(session);
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

window.addEventListener("hashchange", () => {
    if (authorized) route();
});

bootstrap();
