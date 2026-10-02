// 模型返回的宽松 JSON 提取。纯函数，不依赖酒馆、Cosmos 或任何界面模块。
//
// 为什么要容错：结构化输出并非到处可用 —— responseFormat 只在自定义连接上生效，
// 走 ST 主连接时拿不到 json_schema，模型会用代码围栏、中文引号、单引号、尾逗号、
// 未转义换行等各种方式包装同一个对象。这里把「解析成功」的尝试穷举掉，
// 失败就返回 null，由调用方决定报什么错，不在本模块抛业务错误。
//
// 注：src/ui/rewriteEntryButton.js 与 src/ui/storyOutlineWindow.js 各有一份私有实现，
// 它们与 400/422 回退重试、条目 schema 是耦合的，此处不强行收敛，避免回归。

/** 智能引号（中英文弯引号）→ 直引号 */
function normalizeSmartQuotes(text) {
    return String(text || "").replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

/** 尾逗号：`{"a":1,}` / `[1,2,]` */
function dropTrailingCommas(text) {
    return String(text || "").replace(/,\s*([}\]])/g, "$1");
}

/** 单引号键 → 双引号键：`{'a': 1}` → `{"a": 1}` */
function quoteSingleQuotedKeys(text) {
    return String(text || "").replace(/([{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'\s*:/g, '$1"$2":');
}

/** 单引号值 → 双引号值：`{"a": 'x'}` → `{"a": "x"}`，内部双引号转义 */
function quoteSingleQuotedValues(text) {
    return String(text || "").replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, value) => {
        const escaped = String(value).replace(/\\'/g, "'").replace(/"/g, '\\"');
        return `: "${escaped}"`;
    });
}

/**
 * 修掉字符串字面量里未转义的换行，以及未闭合的字符串与括号。
 * 模型把多行文本直接塞进 JSON 字符串是最常见的坏格式。
 *
 * 这里刻意不做「先把跨行值折叠回一行」的预处理：那种正则的前瞻分支有歧义，
 * 遇到 `{"a":"第一行\n第二行","b":2}` 会把 `","b":2` 一并吞进字符串，
 * 产出**能解析但内容错误**的结果。逐字符扫描已经能正确转义字符串内换行，
 * 宁可在这里解析失败让调用方重试，也不能静默给出错的数据。
 */
function stabilizeBrokenJson(text) {
    const raw = String(text || "");
    if (!raw) return "";

    let out = "";
    let inString = false;
    let escaped = false;

    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        if (inString) {
            if (escaped) { out += char; escaped = false; continue; }
            if (char === "\\") { out += char; escaped = true; continue; }
            if (char === '"') { out += char; inString = false; continue; }
            if (char === "\n" || char === "\r") { out += "\\n"; continue; }
            out += char;
            continue;
        }
        if (char === '"') inString = true;
        out += char;
    }
    if (inString) out += '"';

    out = dropTrailingCommas(out);

    // 数出仍未闭合的括号并按序补齐，让被截断的回复也能解析出前面的字段。
    let braces = 0;
    let brackets = 0;
    for (let index = 0; index < out.length; index += 1) {
        const char = out[index];
        if (char === "{") braces += 1;
        else if (char === "}") braces = Math.max(0, braces - 1);
        else if (char === "[") brackets += 1;
        else if (char === "]") brackets = Math.max(0, brackets - 1);
    }
    if (brackets > 0) out += "]".repeat(brackets);
    if (braces > 0) out += "}".repeat(braces);

    return out.trim();
}

/** 收集所有值得一试的候选文本：原文、代码块内容、首个花括号片段。 */
function buildCandidates(raw) {
    const text = String(raw || "");
    const attempts = [text.trim()];

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) attempts.push(fenced[1].trim());

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) attempts.push(text.slice(start, end + 1).trim());

    return attempts.filter(Boolean);
}

/**
 * 从模型回复里尽力解析出一个 JSON 对象。
 * @param {string} raw 模型原始回复
 * @returns {object|null} 解析出的对象；失败返回 null
 */
export function extractJsonObject(raw) {
    for (const attempt of buildCandidates(raw)) {
        const base = normalizeSmartQuotes(attempt);
        const repaired = quoteSingleQuotedValues(quoteSingleQuotedKeys(dropTrailingCommas(base)));
        const variants = [base, repaired, stabilizeBrokenJson(base), stabilizeBrokenJson(repaired)];
        for (const variant of variants) {
            try {
                const parsed = JSON.parse(variant);
                // 顶层必须是对象：数组交给调用方自行处理，这里只认对象。
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
            } catch {
                // 试下一个候选
            }
        }
    }
    return null;
}
