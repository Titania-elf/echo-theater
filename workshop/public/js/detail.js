// 详情页：网页端不能直接写进插件，所以这里给的是「复制 JSON」
import { el, mount, loading, fmtDate, toast, copyText } from "./dom.js";
import { fetchScript, countDownload, report } from "./api.js";
import { avatar, authorLink } from "./card.js";

/** 与插件 user_scripts 结构对齐，多带 source_* 用于后续更新检测 */
function toPluginJson(s) {
    return JSON.stringify({
        id: s.id,
        name: s.name,
        category: s.category || "",
        desc: s.desc || "",
        prompt: s.prompt,
        source: "workshop",
        source_id: s.id,
        source_version: s.version
    }, null, 2);
}

export async function renderDetail(id) {
    mount(loading());

    let s;
    try {
        s = await fetchScript(id);
    } catch (e) {
        mount(el("div", { class: "empty", text: `加载失败：${e.message}` }));
        return;
    }

    const onCopyJson = async () => {
        if (await copyText(toPluginJson(s))) {
            countDownload(s.id);
            toast("已复制 JSON，在插件里选择「导入」即可");
        } else {
            toast("复制失败，请手动选中复制");
        }
    };

    const onCopyPrompt = async () => {
        toast(await copyText(s.prompt) ? "已复制指令内容" : "复制失败，请手动选中复制");
    };

    const onReport = async () => {
        const reason = prompt("请简要说明举报理由：");
        if (!reason?.trim()) return;
        try {
            await report(s.id, reason.trim());
            toast("已提交，感谢反馈");
        } catch (e) {
            toast(e.message);
        }
    };

    mount(
        el("div", { class: "detail" }, [
            el("a", { href: "#/", text: "← 返回列表", style: "font-size:13px;color:var(--muted)" }),
            el("h1", { text: s.name }),
            el("div", { class: "meta detail-author" }, [
                avatar(s.author, 24),
                authorLink(s.author, { anonymous: s.anonymous }),
                el("span", { text: `${fmtDate(s.updated_at)} · ↓ ${s.downloads} · v${s.version}` })
            ]),
            el("div", { class: "meta", style: "margin-bottom:12px" }, [
                s.category && el("span", { class: "tag", text: s.category }),
                s.anonymous && el("span", { class: "tag", text: "匿名投稿" }),
                s.rating === "mature" && el("span", { class: "tag mature", text: "成人向" }),
                ...s.tags.map(t => el("span", { class: "tag", text: t }))
            ]),
            s.desc && el("p", { text: s.desc, style: "color:var(--muted)" }),
            el("div", { class: "actions" }, [
                el("button", { class: "primary", text: "复制 JSON（用于插件导入）", onclick: onCopyJson }),
                el("button", { text: "复制指令原文", onclick: onCopyPrompt }),
                el("span", { class: "spacer" }),
                el("button", { class: "danger", text: "举报", onclick: onReport })
            ]),
            // 纯文本展示，绝不渲染 —— 这里的内容全是陌生人写的
            el("div", { class: "prompt-box", text: s.prompt })
        ])
    );
}
