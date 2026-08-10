// 登录状态：全局缓存一份，避免每次切页都打 /api/auth/me
import { el, toast } from "./dom.js";
import { whoami, logout } from "./api.js";

let cached = null;

export async function getSession({ force = false } = {}) {
    if (cached && !force) return cached;
    try {
        cached = await whoami();
    } catch {
        cached = { logged_in: false };
    }
    return cached;
}

export async function renderAuthSlot() {
    const slot = document.getElementById("authSlot");
    const session = await getSession();

    // 批量导入入口只对站长显示。这里只是 UI 开关，
    // 真正的权限校验在 /api/admin/* 接口里
    const navImport = document.getElementById("navImport");
    if (navImport) navImport.hidden = !(session.logged_in && session.is_admin);

    if (!session.logged_in) {
        slot.replaceChildren(
            el("a", { href: "/api/auth/login" }, [el("button", { text: "Discord 登录" })])
        );
        return;
    }

    const onLogout = async () => {
        await logout().catch(() => {});
        cached = null;
        toast("已退出");
        location.hash = "#/";
        renderAuthSlot();
    };

    slot.replaceChildren(
        session.user.avatar ? el("img", { src: session.user.avatar, alt: "" }) : null,
        el("span", { text: session.user.name }),
        el("button", { text: "退出", onclick: onLogout })
    );
}
