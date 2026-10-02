// SillyTavern Chat Completion 预设的 prompt_order 合并。
//
// 从 promptManager.js 原样搬出来共用：这是解析 ST 预设时唯一真正值得复用的部分，
// 而留在 promptManager 里会逼着「选景预设」模块也 import 它，
// 从而牵出 promptManager → helpers → storage 那条链（测试夹具的 helpers 桩没有
// estimateTokens，链上了会在 ESM 链接期直接炸）。本模块不 import 任何东西。

/**
 * 合并 ST 预设的 prompt_order 分组，得到一份规范顺序。
 *
 * 最完整的那一组定义基准顺序与重复项的启用态；其余分组只补进基准里没有的 identifier，
 * 按其前后最近一个已知 identifier 的相对位置插入。
 *
 * @param {object} preset ST Chat Completion 预设
 * @returns {{order: object[], stats: {group_count:number, reference_count:number, unique_count:number, duplicate_count:number, conflict_count:number}}}
 */
export function getPromptOrder(preset) {
    const groups = Array.isArray(preset?.prompt_order)
        ? preset.prompt_order
            .map(group => Array.isArray(group?.order) ? group.order : [])
            .filter(order => order.length > 0)
        : [];
    const getIdentifier = item => String(item?.identifier || "").trim();
    const getUniqueCount = order => new Set(order.map(getIdentifier).filter(Boolean)).size;
    const referenceCount = groups.reduce((total, order) => total + order.length, 0);

    if (groups.length === 0) {
        return {
            order: [],
            stats: { group_count: 0, reference_count: 0, unique_count: 0, duplicate_count: 0, conflict_count: 0 }
        };
    }

    // The most complete group defines the canonical order and duplicate enabled state.
    // Other groups still contribute every identifier that is absent from this backbone.
    let primaryIndex = 0;
    for (let index = 1; index < groups.length; index++) {
        if (getUniqueCount(groups[index]) > getUniqueCount(groups[primaryIndex])) primaryIndex = index;
    }

    const merged = [];
    const mergedIdentifiers = new Set();
    const enabledStates = new Map();

    for (const order of groups) {
        for (const item of order) {
            const identifier = getIdentifier(item);
            if (!identifier) continue;
            if (!enabledStates.has(identifier)) enabledStates.set(identifier, new Set());
            enabledStates.get(identifier).add(item?.enabled !== false);
        }
    }

    const appendUnique = item => {
        const identifier = getIdentifier(item);
        if (!identifier || mergedIdentifiers.has(identifier)) return;
        merged.push(item);
        mergedIdentifiers.add(identifier);
    };

    groups[primaryIndex].forEach(appendUnique);

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        if (groupIndex === primaryIndex) continue;
        const order = groups[groupIndex];

        for (let itemIndex = 0; itemIndex < order.length; itemIndex++) {
            const item = order[itemIndex];
            const identifier = getIdentifier(item);
            if (!identifier || mergedIdentifiers.has(identifier)) continue;

            const nextKnownIdentifier = order
                .slice(itemIndex + 1)
                .map(getIdentifier)
                .find(candidate => mergedIdentifiers.has(candidate));
            const insertAt = nextKnownIdentifier
                ? merged.findIndex(candidate => getIdentifier(candidate) === nextKnownIdentifier)
                : merged.length;

            merged.splice(insertAt, 0, item);
            mergedIdentifiers.add(identifier);
        }
    }

    return {
        order: merged,
        stats: {
            group_count: groups.length,
            reference_count: referenceCount,
            unique_count: merged.length,
            duplicate_count: referenceCount - merged.length,
            conflict_count: [...enabledStates.values()].filter(states => states.size > 1).length
        }
    };
}
