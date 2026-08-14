// 指令卡片和作者头像：列表页、作者页、精选条都用这一套，避免三处各写一份
import { el, fmtDate } from "./dom.js";

/** 头像色板。按作者 ID 取模，同一作者永远同一个颜色 */
const AVATAR_COLORS = [
    "linear-gradient(135deg, #8b7cf6, #5b4bc4)",
    "linear-gradient(135deg, #62b6e8, #3a7fb5)",
    "linear-gradient(135deg, #f28ba8, #c25f7d)",
    "linear-gradient(135deg, #56d4a8, #2b9e7a)",
    "linear-gradient(135deg, #e0a3f5, #9a6fc4)",
    "linear-gradient(135deg, #f2b56b, #c07f36)"
];

export function avatarColor(id) {
    const key = String(id || "anon");
    let sum = 0;
    for (let i = 0; i < key.length; i++) sum += key.charCodeAt(i);
    return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

/**
 * 作者头像。
 * 结构是「色块打底 + 图片盖在上层」：Discord CDN 在部分网络下连不上，
 * 加载失败时把 img 摘掉就露出底下的首字色块。
 */
export function avatar(author, size = 28) {
    const name = author?.name || "匿名作者";
    const box = el("span", {
        class: "avatar",
        style: `width:${size}px;height:${size}px;background:${avatarColor(author?.id)}`
    }, [
        el("span", { class: "avatar-initial", text: [...name][0] || "?" })
    ]);

    // hash 会拼进 URL，先按 Discord 的格式校验一遍，不合规就只用色块
    if (author?.avatar && author?.id && /^[a-zA-Z0-9_]+$/.test(author.avatar)) {
        const ext = author.avatar.startsWith("a_") ? "gif" : "png";
        const img = el("img", {
            class: "avatar-img",
            src: `https://cdn.discordapp.com/avatars/${encodeURIComponent(author.id)}/${author.avatar}.${ext}?size=64`,
            alt: ""
        });
        img.addEventListener("error", () => img.remove());
        box.append(img);
    }
    return box;
}

/** 作者名：非匿名的可点进作者页 */
export function authorLink(author, { anonymous = false } = {}) {
    if (anonymous || !author?.id) {
        return el("span", { class: "author-name", text: author?.name || "匿名作者" });
    }
    return el("a", {
        class: "author-name is-link",
        href: `#/u/${author.id}`,
        text: author.name,
        onclick: e => e.stopPropagation()   // 别触发卡片本身的跳转
    });
}

/** 热度阈值：到这个下载量就点亮 */
const HOT = 30;

export function heat(downloads) {
    const n = Number(downloads) || 0;
    return el("span", { class: `heat${n >= HOT ? " is-hot" : ""}`, title: "下载量" }, [
        el("span", { text: `↓ ${n}` })
    ]);
}

/** 网格里的指令卡片 */
export function scriptCard(s) {
    return el("div", {
        class: "s-card",
        style: `--accent-line:${avatarColor(s.author?.id)}`,
        onclick: () => { location.hash = `#/s/${s.id}`; }
    }, [
        el("div", { class: "s-card-head" }, [
            avatar(s.author, 26),
            authorLink(s.author, { anonymous: s.anonymous }),
            heat(s.downloads)
        ]),
        el("h3", { class: "s-card-title", text: s.name }),
        el("p", { class: "s-card-desc", text: s.desc || "作者没有写简介" }),
        el("div", { class: "s-card-tags" }, [
            s.category && el("span", { class: "tag cat", text: s.category }),
            s.rating === "mature" && el("span", { class: "tag mature", text: "成人向" }),
            ...(s.tags || []).slice(0, 3).map(t => el("span", { class: "tag", text: `#${t}` })),
            el("span", { class: "tag ghost", text: `v${s.version || 1}` })
        ]),
        el("div", { class: "s-card-foot" }, [
            el("span", { text: fmtDate(s.created_at || s.updated_at) })
        ])
    ]);
}
