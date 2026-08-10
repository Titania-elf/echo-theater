// src/utils/chatHistoryBlacklist.js

/**
 * Parse blacklist rules in the form "start end;", one rule per line.
 * The separator is the whitespace between the two markers; markers cannot
 * contain whitespace or semicolons so malformed input is unambiguous.
 */
export function parseChatHistoryBlacklistInput(input) {
    const rules = [];
    const lines = String(input || "").split(/\r?\n/);

    lines.forEach((line, index) => {
        const source = line.trim();
        if (!source) return;

        if (!source.endsWith(";")) {
            console.warn(`Titania: 忽略第 ${index + 1} 条无效聊天历史黑名单规则：缺少英文分号`);
            return;
        }

        const body = source.slice(0, -1).trim();
        const separator = body.search(/\s/);
        if (separator <= 0) {
            console.warn(`Titania: 忽略第 ${index + 1} 条无效聊天历史黑名单规则：需要填写开始标记和结束标记`);
            return;
        }

        const start = body.slice(0, separator);
        const end = body.slice(separator).trim();
        if (!start || !end || /\s/.test(start) || /\s/.test(end) || start.includes(";") || end.includes(";")) {
            console.warn(`Titania: 忽略第 ${index + 1} 条无效聊天历史黑名单规则：标记不能包含空格或分号`);
            return;
        }

        rules.push({ start, end });
    });

    return rules;
}

/**
 * Remove complete start/end marker blocks from one chat message.
 * Unclosed blocks are preserved to avoid deleting unrelated conversation.
 */
export function removeChatHistoryBlacklist(text, rules = []) {
    let result = String(text || "");
    if (!result || !Array.isArray(rules) || rules.length === 0) return result;

    for (const rule of rules) {
        if (!rule?.start || !rule?.end) continue;

        let cursor = 0;
        let output = "";
        let changed = false;

        while (cursor < result.length) {
            const startIndex = result.indexOf(rule.start, cursor);
            if (startIndex === -1) {
                output += result.slice(cursor);
                break;
            }

            const endIndex = result.indexOf(rule.end, startIndex + rule.start.length);
            if (endIndex === -1) {
                output += result.slice(cursor);
                break;
            }

            output += result.slice(cursor, startIndex);
            cursor = endIndex + rule.end.length;
            changed = true;
        }

        if (changed) result = output;
    }

    return result;
}
