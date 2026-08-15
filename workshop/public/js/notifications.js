import { el, mount, loading, fmtDate, toast } from "./dom.js";
import { myNotifications, readNotifications } from "./api.js";

export async function refreshNotificationBadge() {
    const badge = document.getElementById("notificationBadge");
    if (!badge) return;
    try {
        const data = await myNotifications();
        badge.textContent = data.unread > 99 ? "99+" : String(data.unread || "");
        badge.hidden = !data.unread;
    } catch { badge.hidden = true; }
}

export async function renderNotifications() {
    mount(loading("正在加载通知…"));
    let data;
    try { data = await myNotifications(); }
    catch (e) { mount(el("div", { class: "empty", text: `加载失败：${e.message}` })); return; }
    const text = n => n.type === "author_reply"
        ? `${n.actor_name || "投稿作者"} 回复了你在《${n.script_name || "已下架投稿"}》下的评论`
        : `${n.actor_name || "一位用户"} 评论了你的投稿《${n.script_name || "已下架投稿"}》`;
    const open = async n => {
        if (!n.read_at) await readNotifications([n.id]).catch(() => {});
        location.hash = `#/comment/${n.script_id}/${n.comment_id}`;
    };
    const markAll = el("button", { text: "全部标为已读", disabled: !data.unread, onclick: async () => {
        try { await readNotifications(); toast("已全部标为已读"); refreshNotificationBadge(); renderNotifications(); } catch (e) { toast(e.message); }
    }});
    mount(
        el("div", { class: "row notifications-head" }, [el("h1", { text: "通知" }), el("span", { class: "spacer" }), markAll]),
        data.items.length ? el("div", { class: "notification-list" }, data.items.map(n => el("button", {
            class: `notification-item${n.read_at ? "" : " is-unread"}`, onclick: () => open(n)
        }, [el("span", { class: "notification-dot" }), el("span", { class: "notification-copy" }, [
            el("strong", { text: text(n) }), el("small", { text: fmtDate(n.created_at) })
        ])]))) : el("div", { class: "empty", text: "还没有通知" })
    );
}
