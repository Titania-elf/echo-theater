// 作者主页：资料 + 他的公开投稿
//
// 匿名投稿不会出现在这里 —— 服务端查询就带了 anonymous = 0，
// 否则「匿名」只是卡片上不显示名字，从作者页照样能反查出来。
import { el, mount, loading, fmtDate } from "./dom.js";
import { fetchAuthor } from "./api.js";
import { filterByRating } from "./rating.js";
import { scriptCard, avatar } from "./card.js";

export async function renderAuthor(id) {
    mount(loading());

    let data;
    try {
        data = await fetchAuthor(id);
    } catch (e) {
        mount(el("div", { class: "empty", text: e.message }));
        return;
    }

    const { author, stats } = data;
    const items = filterByRating(data.items || []);

    mount(
        el("div", { class: "author-hero" }, [
            avatar(author, 64),
            el("div", { class: "author-hero-meta" }, [
                el("h1", { class: "author-hero-name", text: author.name }),
                el("div", { class: "author-hero-stats" }, [
                    el("span", { text: `${stats.count} 条公开投稿` }),
                    el("span", { text: `累计下载 ${stats.downloads}` }),
                    author.joined_at && el("span", { text: `${fmtDate(author.joined_at)} 加入` })
                ])
            ])
        ]),

        items.length
            ? el("div", { class: "cards" }, items.map(scriptCard))
            : el("div", { class: "empty", text: "这位作者还没有公开的投稿" })
    );
}
