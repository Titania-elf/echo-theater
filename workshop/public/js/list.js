// 列表页：400 条全内存搜索 + 排序，不做虚拟滚动
import { el, mount, loading } from "./dom.js";
import { fetchList } from "./api.js";
import { filterByRating } from "./rating.js";
import { scriptCard, avatar, authorLink } from "./card.js";

const state = { q: "", category: "", sort: "newest" };

// 热度：下载量 + 30 天半衰的时间新鲜度
function hotScore(s, nowSec) {
    const days = Math.max(0, (nowSec - (s.updated_at || 0)) / 86400);
    return Math.log(1 + (s.downloads || 0)) + Math.exp(-days / 30) * 1.2;
}

function sortItems(items, mode) {
    const nowSec = Math.floor(Date.now() / 1000);
    const list = [...items];
    if (mode === "hot") return list.sort((a, b) => hotScore(b, nowSec) - hotScore(a, nowSec));
    if (mode === "downloads") return list.sort((a, b) => b.downloads - a.downloads);
    return list.sort((a, b) =>
        (b.created_at || b.updated_at || 0) - (a.created_at || a.updated_at || 0)
        || (b.updated_at || 0) - (a.updated_at || 0)
        || String(b.id).localeCompare(String(a.id))
    );
}

function matches(s, q) {
    if (!q) return true;
    const hay = `${s.name} ${s.desc} ${s.category} ${s.tags.join(" ")} ${s.author.name}`.toLowerCase();
    return hay.includes(q);   // 中文子串匹配，不分词，反而更符合直觉
}

/** 前三名给奖牌，之后给序号 */
const RANK_MARK = ["🥇", "🥈", "🥉"];

/** 给隐藏滚动条的横向榜单补上桌面鼠标交互。 */
function enableFeaturedStripScroll(strip) {
    let pointerId = null;
    let dragStartX = 0;
    let dragStartScrollLeft = 0;
    let dragging = false;
    let suppressClick = false;

    strip.addEventListener("wheel", event => {
        if (event.ctrlKey || strip.scrollWidth <= strip.clientWidth) return;

        const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY;
        const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
                ? strip.clientWidth
                : 1;
        const delta = rawDelta * scale;
        const maxScrollLeft = strip.scrollWidth - strip.clientWidth;
        const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, strip.scrollLeft + delta));

        // 到达横条边缘后，把滚轮交还给页面，避免桌面端被困在榜单上。
        if (!delta || nextScrollLeft === strip.scrollLeft) return;

        event.preventDefault();
        strip.scrollLeft = nextScrollLeft;
    }, { passive: false });

    strip.addEventListener("pointerdown", event => {
        if (event.pointerType !== "mouse" || event.button !== 0) return;

        pointerId = event.pointerId;
        dragStartX = event.clientX;
        dragStartScrollLeft = strip.scrollLeft;
        dragging = false;
        suppressClick = false;
        strip.setPointerCapture(pointerId);
    });

    strip.addEventListener("pointermove", event => {
        if (event.pointerId !== pointerId) return;

        const deltaX = event.clientX - dragStartX;
        if (!dragging && Math.abs(deltaX) < 5) return;

        dragging = true;
        suppressClick = true;
        strip.classList.add("is-dragging");
        strip.scrollLeft = dragStartScrollLeft - deltaX;
        event.preventDefault();
    });

    const finishDrag = event => {
        if (event.pointerId !== pointerId) return;

        pointerId = null;
        strip.classList.remove("is-dragging");
        if (dragging) event.preventDefault();
        dragging = false;

        // pointerup 后 click 会同步触发，下一轮任务再解除误点击拦截。
        setTimeout(() => { suppressClick = false; }, 0);
    };

    strip.addEventListener("pointerup", finishDrag);
    strip.addEventListener("pointercancel", finishDrag);
    strip.addEventListener("lostpointercapture", finishDrag);
    strip.addEventListener("dragstart", event => event.preventDefault());
    strip.addEventListener("click", event => {
        if (!suppressClick) return;
        event.preventDefault();
        event.stopPropagation();
    }, true);
}

/**
 * 精选条：横向可滑动的榜单。首页摆两条，语义不同：
 *   1. 近 7 天新作热度 —— 窗口内新上传、且已有人下载的，按下载量排（newWorksStrip）
 *   2. 工坊总榜       —— 全站累计下载前 10（allTimeStrip）
 *
 * 没做大轮播是因为工坊没有配图字段，大卡片只能拿色块填，
 * 而且一次只露一条，条目少的时候特别空。
 *
 * @param {object[]} items 已排好序的条目
 * @param {{title: string, hint?: string, medals?: boolean}} opts
 */
function featuredStrip(items, opts) {
    const strip = el("div", { class: "featured-strip" }, items.map((s, i) =>
        el("article", {
            class: `f-card${opts.medals && i < 3 ? " is-top" : ""}`,
            onclick: () => { location.hash = `#/s/${s.id}`; }
        }, [
            el("span", {
                class: "f-rank",
                text: (opts.medals && RANK_MARK[i]) || String(i + 1)
            }),
            el("div", { class: "f-body" }, [
                el("h3", { class: "f-title", text: s.name }),
                el("div", { class: "f-meta" }, [
                    avatar(s.author, 20),
                    authorLink(s.author, { anonymous: s.anonymous }),
                    el("span", { class: "f-dl", text: `↓ ${s.downloads || 0}` })
                ])
            ])
        ])
    ));
    enableFeaturedStripScroll(strip);

    return el("section", { class: "featured" }, [
        el("div", { class: "featured-head" }, [
            el("h2", { text: opts.title }),
            opts.hint ? el("span", { class: "featured-hint", text: opts.hint }) : null
        ]),
        strip
    ]);
}

/**
 * 「近 7 天新作热度」的窗口链。
 *
 * 为什么是滚动小时窗而不是自然周：自然周每逢周一凌晨归零，榜单恰好在流量重启
 * 的时刻最空；滚动窗口连续移动，没有这个悬崖，也完全不用管时区
 * （Workers 跑在 UTC，用户在 +08，按自然周切会差 8 小时）。
 *
 * 为什么用 created_at 而不是 updated_at：老剧本改一下不该重新算作「新上传」。
 * 现有的 hotScore() 就是拿 updated_at 当新鲜度，编辑一次就能刷新，这里不沿用。
 *
 * 为什么要求 downloads ≥ 1：横幅说的是「受欢迎」，把 ↓0 的排进去就名不副实了。
 * 窗口内没人达标时逐级放宽，标题跟着变 —— 宁可显示「近一月」，不显示假的「近 7 天热度」。
 *
 * ⚠ 刻意不按曝光时长归一（如 downloads / 小时数）。看着更公平，实际没必要：
 *   横条有 10 个位置，而按当前投稿节奏（≤5 条/周）窗口里通常只有 3–5 条，
 *   没有任何条目会被挤掉 —— 排序只决定先后，不决定去留。
 *   而归一化会让「↓3 排在 ↓5 上面」，读者看到的数字和顺序矛盾，反而更糊。
 */
const NEW_WORK_WINDOWS = [
    { hours: 24 * 7, label: "🔥 近 7 天新作热度" },
    { hours: 24 * 14, label: "🔥 近两周新作热度" },
    { hours: 24 * 30, label: "🔥 近一月新作热度" }
];

function pickNewWorks(items, nowSec) {
    for (const win of NEW_WORK_WINDOWS) {
        const from = nowSec - win.hours * 3600;
        const hits = items
            .filter(s => (s.created_at || 0) >= from && (s.downloads || 0) > 0)
            .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
            .slice(0, 10);
        // 门槛是 1 而不是 3：按 ≤5 条/周的节奏，要求 3 条会让横幅频繁整块消失、
        // 首屏跟着跳。这条横条的作用是露出新作，露 1 条也比空着有用。
        if (hits.length >= 1) return { items: hits, label: win.label, hours: win.hours };
    }
    return null;
}

function newWorksStrip(all) {
    const picked = pickNewWorks(all, Math.floor(Date.now() / 1000));
    if (!picked) return null;   // 连 30 天内都没有被下载过的新作，整条隐藏

    return featuredStrip(picked.items, {
        title: picked.label,
        hint: `${picked.items.length} 部作品`,
        medals: false   // 只有 3–5 条时挂奖牌是在给噪声发奖，用朴素序号
    });
}

/** 工坊总榜：全站累计下载。奖牌留给这里 —— 400 条里排前三才有意义 */
function allTimeStrip(all) {
    const top = [...all]
        .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
        .slice(0, 10);
    if (top.length < 3) return null;   // 太少就不摆榜，显得寒酸

    return featuredStrip(top, {
        title: "🏆 工坊总榜",
        hint: "横向滑动查看更多",
        medals: true
    });
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
            ...(hits.length
                ? hits.map(scriptCard)
                : [el("div", {
                    class: "empty",
                    text: all.length ? "没有匹配的指令" : (data.items?.length ? "当前内容范围没有可见投稿" : "工坊里还没有投稿")
                })])
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
        el("option", { value: "newest", text: "按最新发布" }),
        el("option", { value: "hot", text: "按热度" }),
        el("option", { value: "downloads", text: "按下载量" })
    ]);
    sortSel.value = state.sort;

    paint();

    mount(
        el("header", { class: "workshop-home-head" }, [
            el("img", { class: "workshop-home-mark", src: "/1786768560798.png", alt: "" }),
            el("div", { class: "workshop-home-copy" }, [
                el("p", { class: "workshop-home-kicker", text: "ECHO BOOK CLUB" }),
                el("h1", { text: "回声工坊" }),
                el("p", { class: "workshop-home-subtitle", text: "收录值得反复演绎的剧本指令，也把每一位创作者的回声留在这里。" })
            ])
        ]),
        newWorksStrip(all),
        allTimeStrip(all),
        el("div", { class: "toolbar" }, [search, sortSel]),
        categories.length ? chipBox : null,
        el("div", { class: "meta list-count" }, [countLabel]),
        cardsBox
    );
}
