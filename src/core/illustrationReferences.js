// 配图引用计数：判断某张图的文件还有没有人在用。
//
// 为什么删图前必须问这个问题：收藏存的是同一批文件的**快照**（`favsStore` 把整条图片
// 记录塞进收藏体，含同一个 filePath，不是复制字节）。删掉一个仍被引用的文件，
// 收藏页会变成碎图 —— 而碎图在显示时**不报错**，只画一个破图标；真正的代价是
// `loadAsset` 遇到 404 会抛错**中止整个备份导出**（「已停止导出以免遗漏图片」）。
// 判断错一次，用户的完整备份就废了。
//
// 本模块刻意放在 illustrationStore 与 favsStore **之上**：store 不能依赖 favsStore
// （favs 依赖配图路径工具，会绕成环）。所以 store 通过注入回调拿结果，见
// illustrationStore.deleteSceneIllustrations。

import { getExtData } from "../utils/storage.js";
import { ILLUSTRATION_INDEX_KEY, collectIllustrationPaths } from "./illustrationData.js";
import { readSceneIllustrations } from "./illustrationStore.js";
import { ensureFavBody, isFavsMigrated, listFavsForUi } from "./favsStore.js";

/** 读取收藏正文的并发上限：逐个 await 在收藏多时慢得离谱，全并发又会同时开太多请求。 */
const FAVORITE_SCAN_CONCURRENCY = 8;

/** 有并发上限地遍历。worker 抛错由调用方处理，这里不吞。 */
async function forEachLimited(items, limit, worker) {
    const queue = [...items];
    const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (queue.length) await worker(queue.shift());
    });
    await Promise.all(runners);
}

/**
 * 在候选路径里，找出仍被**任何场景记录**或**任何收藏**引用的那些。
 *
 * 读不出来的记录或收藏一律保守处理：置 `incomplete` 并把全部候选当作仍被引用 ——
 * 证明不了"没人用"就不删字节，宁可留孤儿文件。
 *
 * @param {Iterable<string>} paths 候选路径（一般就是要删的那几张图）
 * @param {object} [options]
 * @param {string|number} [options.excludeFavoriteId]
 *   当前打开面板所在的收藏。调用方若打算同时清掉它的快照，就得在这里排除，
 *   否则确认框会把一个马上就要被清掉的文件说成"会保留"。
 * @returns {Promise<{referenced:Set<string>, favoriteReferenced:Set<string>, incomplete:boolean}>}
 */
export async function findReferencedIllustrationPaths(paths, options = {}) {
    const candidates = new Set([...paths].map(path => String(path || "")).filter(Boolean));
    const referenced = new Set();
    const favoriteReferenced = new Set();
    let incomplete = false;
    if (!candidates.size) return { referenced, favoriteReferenced, incomplete };

    // 早退：候选全部已确认被引用时就没必要再读了。删一张没被收藏用过的图时帮不上忙
    //（那要读完才知道"没有"），但批量删里混着被引用的图时能省下大半。
    const settled = () => referenced.size >= candidates.size;

    /** @param {*} value @param {boolean} fromFavorite */
    const scan = (value, fromFavorite) => {
        for (const path of collectIllustrationPaths(value)) {
            if (!candidates.has(path)) continue;
            referenced.add(path);
            if (fromFavorite) favoriteReferenced.add(path);
        }
    };

    // 场景侧：索引里每个 sceneId 一条记录。
    for (const sceneId of Object.keys(getExtData()[ILLUSTRATION_INDEX_KEY] || {})) {
        if (settled()) break;
        try {
            scan(await readSceneIllustrations(sceneId), false);
        } catch {
            incomplete = true;
        }
    }

    // 收藏侧。
    if (!settled()) {
        if (isFavsMigrated()) {
            const entries = listFavsForUi() || [];
            const targets = entries.filter(entry => String(entry?.id) !== String(options.excludeFavoriteId ?? ""));
            await forEachLimited(targets, FAVORITE_SCAN_CONCURRENCY, async entry => {
                if (settled()) return;
                try {
                    // ensureFavBody 就地补齐正文（含 illustration / items），同一个对象。
                    scan(await ensureFavBody(entry), true);
                } catch {
                    incomplete = true;
                }
            });
        } else {
            // 还没搬家：收藏正文就内联在设置里，直接扫。
            scan(getExtData().favs || [], true);
        }
    }

    if (incomplete) {
        // 保守兜底：读不全就不敢说"没人引用"，全部按被引用处理（只删记录、保留文件）。
        for (const path of candidates) referenced.add(path);
    }
    return { referenced, favoriteReferenced, incomplete };
}
