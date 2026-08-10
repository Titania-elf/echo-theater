// 列表页：400 条全内存搜索 + 排序，不做虚拟滚动
import { el, mount, loading } from "./dom.js";
import { fetchList } from "./api.js";
import { filterByRating } from "./rating.js";
import { scriptCard, avatar, authorLink } from "./card.js";

const state = { q: "", category: "", sort: "hot" };

// 热度：下载量 + 30 天半衰的时间新鲜度。默认不用"最新"，垃圾投稿会自己沉底
function hotScore(s, nowSec) {
    const days = Math.max(0, (nowSec - (s.updated_at || 0)) / 86400);
    return Math.log(1 + (s.downloads || 0)) + Math.exp(-days / 30) * 1.2;
}

function sortItems(items, mode) {
    const nowSec = Math.floor(Date.now() / 1000);
    const list = [...items];
    if (mode === "new") return list.sort((a, b) => b.updated_at - a.updated_at);
    if (mode === "downloads") return list.sort((a, b) => b.downloads - a.downloads);
    return list.sort((a, b) => hotScore(b, nowSec) - hotScore(a, nowSec));
}

function matches(s, q) {
    if (!q) return true;
    const hay = `${s.name} ${s.desc} ${s.category} ${s.tags.join(" ")} ${s.author.name}`.toLowerCase();
    return hay.includes(q);   // 中文子串匹配，不分词，反而更符合直觉
}

/** 前三名给奖牌，之后给序号 */
const RANK_MARK = ["🥇", "🥈", "🥉"];

/**
 * 精选条：横向可滑动的热门榜。
 * 没做大轮播是因为工坊没有配图字段，大卡片只能拿色块填，
 * 而且一次只露一条，条目少的时候特别空。
 */
function featuredStrip(items) {
    const top = sortItems(items, "hot").slice(0, 10);
    if (top.length < 3) return null;   // 太少就不摆榜，显得寒酸

    return el("section", { class: "featured" }, [
        el("div", { class: "featured-head" }, [
            el("h2", { text: "🔥 本期热门" }),
            el("span", { class: "featured-hint", text: "横向滑动查看更多" })
        ]),
        el("div", { class: "featured-strip" }, top.map((s, i) =>
            el("article", {
                class: `f-card${i < 3 ? " is-top" : ""}`,
                onclick: () => { location.hash = `#/s/${s.id}`; }
            }, [
                el("span", { class: "f-rank", text: RANK_MARK[i] || String(i + 1) }),
                el("div", { class: "f-body" }, [
                    el("h3", { class: "f-title", text: s.name }),
                    el("div", { class: "f-meta" }, [
                        avatar(s.author, 20),
                        authorLink(s.author, { anonymous: s.anonymous }),
                        el("span", { class: "f-dl", text: `↓ ${s.downloads || 0}` })
                    ])
                ])
            ])
        ))
    ]);
}

export async function renderList() {
    mount(loading());

    let data;
    try {
        data = await fetchList();
    } catch (e) {
        mount(el("div", { class: "empty", text: `加载失败：${e.message}` }));
        return;
    }

    const all = filterByRating(data.items || []);
    const categories = [...new Set(all.map(s => s.category).filter(Boolean))].sort();
    const cardsBox = el("div", { class: "cards" });
    const countLabel = el("span", { text: "" });

    // 分类做成一排 chip 直接露出来：之前藏在下拉里，
    // 站长专门给投稿分了类，藏起来等于白分
    const chipBox = el("div", { class: "chips" });

    const paintChips = () => {
        chipBox.replaceChildren(
            el("button", {
                class: `chip${state.category === "" ? " is-on" : ""}`,
                text: "全部",
                onclick: () => { state.category = ""; paint(); }
            }),
            ...categories.map(c => el("button", {
                class: `chip${state.category === c ? " is-on" : ""}`,
                text: c,
                onclick: () => { state.category = state.category === c ? "" : c; paint(); }
            }))
        );
    };

    const paint = () => {
        const q = state.q.trim().toLowerCase();
        const hits = sortItems(
            all.filter(s => matches(s, q) && (!state.category || s.category === state.category)),
            state.sort
        );
        countLabel.textContent = hits.length === all.length
            ? `共 ${all.length} 条指令`
            : `${hits.length} / ${all.length} 条`;
        cardsBox.replaceChildren(
            ...(hits.length ? hits.map(scriptCard) : [el("div", { class: "empty", text: "没有匹配的指令" })])
        );
        paintChips();
    };

    const search = el("input", {
        type: "search", placeholder: "搜索名称、简介、标签、作者…", value: state.q,
        oninput: e => { state.q = e.target.value; paint(); }
    });

    const sortSel = el("select", {
        onchange: e => { state.sort = e.target.value; paint(); }
    }, [
        el("option", { value: "hot", text: "按热度" }),
        el("option", { value: "new", text: "按最新" }),
        el("option", { value: "downloads", text: "按下载量" })
    ]);
    sortSel.value = state.sort;

    paint();

    mount(
        featuredStrip(all),
        el("div", { class: "toolbar" }, [search, sortSel]),
        categories.length ? chipBox : null,
        el("div", { class: "meta list-count" }, [countLabel]),
        cardsBox
    );
}
