// src/core/textRewriteCore.js
//
// 文本改写/删除的纯逻辑层：切分、关键词匹配、删除应用、规则评估与旧数据迁移。
// 这里不碰 DOM、网络、ST context，便于单测（见 tests/textRewrite.test.mjs）。
// UI 层（rewriteEntryButton.js）从本模块 import 这些函数，保持单一事实来源。

/* ===== 文本归一化 ===== */

export function normalizeToken(s) {
    return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizePunctuation(s) {
    return String(s || "")
        .replace(/，/g, ",")
        .replace(/；/g, ";")
        .replace(/：/g, ":")
        .replace(/[\t\f\v]+/g, " ");
}

export function parseCommaList(input) {
    return normalizePunctuation(input)
        .split(",")
        .map(x => normalizeToken(x))
        .filter(Boolean);
}

export function uniq(arr) {
    return [...new Set(arr)];
}

/* ===== 切分 ===== */

export function splitBySentence(text) {
    const src = String(text || "");
    if (!src.trim()) return [];

    const lines = src.split(/\r?\n/);
    const chunks = [];

    lines.forEach((line) => {
        if (!line.trim()) return;
        const arr = line.split(/(?<=[。！？!?])/u).filter(s => s.trim());
        if (arr.length === 0) {
            chunks.push(line);
        } else {
            chunks.push(...arr);
        }
    });

    return chunks;
}

export function splitByParagraph(text) {
    return String(text || "")
        .split(/\r?\n\s*\r?\n+/)
        .map(s => s.trim())
        .filter(Boolean);
}

export function splitText(text, splitMode) {
    return splitMode === "paragraph" ? splitByParagraph(text) : splitBySentence(text);
}

/* ===== 关键词匹配（主词 AND 附加词；任一命中即该组命中）===== */

export function matchKeywordRule(unitText, rule) {
    const anchorList = parseCommaList(String(rule?.anchor || ""));
    const extrasList = parseCommaList(String(rule?.extras || ""));
    if (anchorList.length === 0 || extrasList.length === 0) return false;
    const source = normalizeToken(unitText);
    const anchorHit = anchorList.some(kw => source.includes(kw));
    if (!anchorHit) return false;
    return extrasList.some(kw => source.includes(kw));
}

/* ===== 删除应用 ===== */

export function normalizeDeleteMode(mode) {
    const value = String(mode || "").trim().toLowerCase();
    // 兼容旧 action 名：delete→sentence，delete_range→fragment
    if (value === "fragment" || value === "delete_range") return "fragment";
    return "sentence";
}

/* 片段删除：从命中的字面片段删到单元末尾，保留句末标点，清理悬挂连接符。
   例：「他笑了，那笑声像碎玻璃一样脆。」+ fragment「那笑声像」→「他笑了。」
   片段不在单元内 → 原文不动（规则失配不误删）。 */
export function applyDeletesToUnit(unitText, mode, fragment) {
    const text = String(unitText || "");
    const normMode = normalizeDeleteMode(mode);
    if (normMode === "sentence") return "";
    const frag = String(fragment || "").trim();
    if (!frag) return text;
    const idx = text.indexOf(frag);
    if (idx < 0) return text;
    const tail = text.slice(idx + frag.length);
    const punct = /[。！？!?…]\s*$/.exec(tail);
    const rawHead = text.slice(0, idx);
    let cleanedHead = rawHead.replace(/[，、；,;]\s*$/, "");
    const closedByQuote = /[”」』）)]\s*$/.test(cleanedHead);
    let keptTail = punct && !closedByQuote ? punct[0] : "";
    const openMatch = /[（(]\s*$/.exec(cleanedHead);
    if (openMatch) {
        const closeChar = cleanedHead.endsWith("（") ? "）" : ")";
        cleanedHead = cleanedHead.replace(/[（(]\s*$/, closeChar);
        keptTail = "";
    }
    return cleanedHead + keptTail;
}

/* 通用顺序替换：entries=[{before, after}]，按在原文中的出现顺序，用游标逐个推进替换，
   同一段文本只消费一次。after==="" 即删除。改写与删除两条链路都复用它。 */
export function applyReplacements(sourceText, entries) {
    let out = String(sourceText || "");
    let cursor = 0;
    let replaced = 0;

    const ordered = (Array.isArray(entries) ? entries : [])
        .map(e => ({
            before: String(e?.before || ""),
            after: typeof e?.after === "string" ? e.after : "",
        }))
        .filter(e => e.before && e.after !== e.before)
        .map(e => ({ ...e, srcIdx: out.indexOf(e.before) }))
        .filter(e => e.srcIdx >= 0)
        .sort((a, b) => a.srcIdx - b.srcIdx);

    ordered.forEach((item) => {
        const idx = out.indexOf(item.before, cursor);
        if (idx < 0) return;
        out = out.slice(0, idx) + item.after + out.slice(idx + item.before.length);
        cursor = idx + item.after.length;
        replaced += 1;
    });

    return { text: out, replaced };
}

/* ===== 删除规则评估（本地确定性，无 LLM）=====
   rules: [{ anchor, extras, mode, fragment, enabled }]。返回命中单元与删后文本预览。 */
export function evaluateDeleteRules(text, splitMode, rules) {
    const mode = splitMode === "paragraph" ? "paragraph" : "sentence";
    const activeRules = (Array.isArray(rules) ? rules : []).filter(r => r && r.enabled !== false);
    const units = splitText(String(text || ""), mode);

    const unitResults = units.map((unit, idx) => {
        let matchedRule = null;
        for (const rule of activeRules) {
            if (matchKeywordRule(unit, rule)) {
                const rMode = normalizeDeleteMode(rule.mode);
                // 整句删除优先于片段删除（删得更彻底）
                if (!matchedRule || (rMode === "sentence" && normalizeDeleteMode(matchedRule.mode) === "fragment")) {
                    matchedRule = rule;
                }
                if (rMode === "sentence") break;
            }
        }
        const hit = !!matchedRule;
        const deleteMode = hit ? normalizeDeleteMode(matchedRule.mode) : null;
        const fragment = hit && deleteMode === "fragment" ? String(matchedRule.fragment || "") : "";
        return {
            unitIndex: idx + 1,
            text: unit,
            hit,
            deleteMode,
            fragment,
            after: hit ? applyDeletesToUnit(unit, deleteMode, fragment) : unit,
            matchedRule: hit ? { anchor: matchedRule.anchor, extras: matchedRule.extras } : null,
        };
    });

    const deleteUnits = unitResults.filter(u => u.hit);
    return {
        splitMode: mode,
        unitCount: unitResults.length,
        hitCount: deleteUnits.length,
        unitResults,
        deleteUnits,
    };
}

/* 删除单元 → 顺序替换条目（整句 after=""）。供 applyReplacements 回写全文。 */
export function buildDeleteReplacements(deleteUnits = []) {
    return (Array.isArray(deleteUnits) ? deleteUnits : []).map(u => ({
        before: String(u?.text || ""),
        after: applyDeletesToUnit(u?.text, u?.deleteMode, u?.fragment),
    }));
}

/* ===== 改写规则评估（命中后交给 LLM）=====
   categories: [{ id, name, bad_example, good_example, guidance, rules:[{anchor,extras}] }]。 */
export function evaluateRewriteRules(text, splitMode, categories) {
    const mode = splitMode === "paragraph" ? "paragraph" : "sentence";
    const cats = Array.isArray(categories) ? categories : [];
    const units = splitText(String(text || ""), mode);

    const unitResults = units.map((unit, idx) => {
        const matchedCategories = [];
        cats.forEach((cat) => {
            const matchedRules = (Array.isArray(cat.rules) ? cat.rules : [])
                .filter(rule => matchKeywordRule(unit, rule))
                .map(rule => ({ anchor: String(rule.anchor || ""), extras: String(rule.extras || "") }));
            if (matchedRules.length > 0) {
                matchedCategories.push({
                    categoryId: String(cat.id || ""),
                    categoryName: String(cat.name || ""),
                    guidance: String(cat.guidance || ""),
                    bad_example: String(cat.bad_example || ""),
                    good_example: String(cat.good_example || ""),
                    matchedRules,
                });
            }
        });
        return {
            unitIndex: idx + 1,
            text: unit,
            hit: matchedCategories.length > 0,
            matchedCategories,
        };
    });

    const hitUnits = unitResults.filter(u => u.hit);
    const hitCategoryIds = new Set();
    hitUnits.forEach(u => u.matchedCategories.forEach(c => hitCategoryIds.add(c.categoryId)));

    return {
        splitMode: mode,
        unitCount: unitResults.length,
        hitCount: hitUnits.length,
        categoryCount: hitCategoryIds.size,
        unitResults,
    };
}

/* ===== 旧数据结构迁移（纯结构变换，不填默认值）=====
   输入旧 rewrite_entry（含 schemes[*].categories[*].rules[*].action）。
   返回 { rewriteSchemes, deletionRules }：
   - action==="rewrite" 的规则留在改写方案（降为 {anchor, extras}）
   - action==="delete"/"delete_range" 收进扁平删除规则列表（mode=sentence|fragment）
   幂等性由调用方（已存在 item.rewrite 则不调用）保证。 */
export function splitLegacyRules(legacyItem) {
    const schemes = Array.isArray(legacyItem?.schemes) ? legacyItem.schemes : [];
    const deletionRules = [];

    const rewriteSchemes = schemes.map((scheme) => {
        const categories = (Array.isArray(scheme?.categories) ? scheme.categories : []).map((cat) => {
            const rewriteRules = [];
            (Array.isArray(cat?.rules) ? cat.rules : []).forEach((rule) => {
                const action = String(rule?.action || "rewrite").trim().toLowerCase();
                const anchor = String(rule?.anchor || "").trim();
                const extras = String(rule?.extras || "").trim();
                if (!anchor || !extras) return;
                if (action === "delete" || action === "delete_range") {
                    deletionRules.push({
                        anchor,
                        extras,
                        mode: action === "delete_range" ? "fragment" : "sentence",
                        fragment: action === "delete_range" ? String(rule?.fragment || "").trim() : "",
                        enabled: true,
                    });
                } else {
                    rewriteRules.push({ anchor, extras });
                }
            });
            return {
                id: String(cat?.id || ""),
                name: String(cat?.name || "").trim(),
                bad_example: String(cat?.bad_example || "").trim(),
                good_example: String(cat?.good_example || "").trim(),
                guidance: String(cat?.guidance || "").trim(),
                rules: rewriteRules,
            };
        }).filter(cat => cat.name);
        return {
            id: String(scheme?.id || ""),
            name: String(scheme?.name || "").trim(),
            categories,
        };
    }).filter(s => s.name);

    return { rewriteSchemes, deletionRules };
}
