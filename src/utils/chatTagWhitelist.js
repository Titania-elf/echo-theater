// src/utils/chatTagWhitelist.js

export function parseTagWhitelistInput(input) {
    return String(input || "")
        .split(/[,，\n]/)
        .map(tag => tag.trim())
        .map(tag => tag.replace(/^<|>$/g, "").toLowerCase())
        .filter(tag => tag.length > 0 && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(tag));
}

export function extractTextByWhitelist(rawHtml, whitelist = []) {
    const src = String(rawHtml || "");
    if (!src.trim()) return "";

    if (Array.isArray(whitelist) && whitelist.length > 0) {
        const extracted = [];
        for (const tag of whitelist) {
            const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
            let match;
            while ((match = regex.exec(src)) !== null) {
                const inner = String(match[1] || "").trim();
                if (inner) extracted.push(inner);
            }
        }

        if (extracted.length > 0) {
            return extracted.join("\n").replace(/<[^>]*>?/gm, "").replace(/\n{3,}/g, "\n\n").trim();
        }
    }

    return src.replace(/<[^>]*>?/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}
