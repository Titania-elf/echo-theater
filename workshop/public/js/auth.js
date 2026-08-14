// 登录状态：全局缓存一份，避免每次切页都打 /api/auth/me
import { el, toast } from "./dom.js";
import { whoami, logout } from "./api.js";

let cached = null;

export async function getSession({ force = false } = {}) {
    if (cached && !force) return cached;
    cached = await whoami();
    return cached;
}

export async function logoutSession() {
    await logout();
    cached = null;
}

export function renderAuthSlot(session, { onLogout } = {}) {
    const slot = document.getElementById("authSlot");

    // 批量导入入口只对站长显示。这里只是 UI 开关，
    // 真正的权限校验在 /api/admin/* 接口里
    const navImport = document.getElementById("navImport");
    if (navImport) navImport.hidden = !(session.logged_in && session.is_admin);

    if (!session.logged_in) {
        slot.replaceChildren();
        return;
    }

    const logoutBtn = el("button", { text: "退出" });
    logoutBtn.addEventListener("click", async () => {
        logoutBtn.disabled = true;
        try {
            await onLogout?.();
        } catch (e) {
            toast(e?.message || "退出失败，请重试");
            logoutBtn.disabled = false;
        }
    });

    const avatar = session.user.avatar
        ? el("img", { src: session.user.avatar, alt: "" })
        : null;

    if (avatar) {
        avatar.addEventListener("error", () => avatar.remove(), { once: true });
    }

    slot.replaceChildren(
        avatar,
        el("span", { text: session.user.name }),
        logoutBtn
    );
}
