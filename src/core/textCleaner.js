// src/core/textCleaner.js
// 文本清洗模块 - 用于向量化前的文本预处理

import { getExtData } from "../utils/storage.js";
import { TitaniaLogger } from "./logger.js";

/**
 * 获取文本清洗配置
 * @returns {object} 清洗配置对象
 */
export function getTextCleaningConfig() {
    const data = getExtData();
    const embeddingConfig = data.embedding_config || {};
    return embeddingConfig.text_cleaning || {
        remove_html_tags: true,
        remove_style_tags: true,
        remove_thinking_tags: true,
        remove_ooc_tags: true,
        remove_system_tags: true,
        remove_markdown: false,
        remove_macro_residue: true,
        remove_bracket_markers: true,
        remove_bracket_content: true,
        custom_tags_to_remove: "",
        min_text_length: 20
    };
}

/**
 * 移除指定 XML/HTML 标签及其内容
 * @param {string} text - 原始文本
 * @param {string[]} tags - 要移除的标签名数组
 * @returns {string} 清洗后的文本
 */
function removeTagsWithContent(text, tags) {
    if (!text || !tags || tags.length === 0) return text;

    let result = text;
    for (const tag of tags) {
        // 匹配 <tag>...</tag> 和 <tag attr>...</tag>（支持多行）
        const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
        result = result.replace(regex, '');
    }
    return result;
}

/**
 * 移除 HTML 标签但保留文本内容
 * @param {string} text - 原始文本
 * @returns {string} 清洗后的文本
 */
function removeHtmlTagsKeepContent(text) {
    if (!text) return text;
    // 移除所有 HTML 标签，保留标签内的文本
    return text.replace(/<[^>]*>/g, '');
}

/**
 * 移除 Markdown 格式
 * @param {string} text - 原始文本
 * @returns {string} 清洗后的文本
 */
function removeMarkdownFormatting(text) {
    if (!text) return text;

    let result = text;

    // 粗体 **text** 或 __text__
    result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
    result = result.replace(/__([^_]+)__/g, '$1');

    // 斜体 *text* 或 _text_（注意避免误匹配）
    result = result.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');
    result = result.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '$1');

    // 删除线 ~~text~~
    result = result.replace(/~~([^~]+)~~/g, '$1');

    // 行内代码 `code`
    result = result.replace(/`([^`]+)`/g, '$1');

    // 代码块 ```...```
    result = result.replace(/```[\s\S]*?```/g, '');

    // 标题标记 # ## ### 等
    result = result.replace(/^#{1,6}\s+/gm, '');

    // 列表标记 - * + 和 1. 2. 等
    result = result.replace(/^\s*[-*+]\s+/gm, '');
    result = result.replace(/^\s*\d+\.\s+/gm, '');

    // 链接 [text](url)
    result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    // 图片 ![alt](url)
    result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

    return result;
}

/**
 * 移除宏残留
 * @param {string} text - 原始文本
 * @returns {string} 清洗后的文本
 */
function removeMacroResidue(text) {
    if (!text) return text;
    // 移除 {{...}} 格式的宏
    return text.replace(/\{\{[^}]+\}\}/g, '');
}

/**
 * 移除方括号标记（仅移除特定系统标记）
 * @param {string} text - 原始文本
 * @returns {string} 清洗后的文本
 */
function removeBracketMarkers(text) {
    if (!text) return text;
    // 移除常见的系统标记 [System] [OOC] [Note] [Author's Note] 等
    return text.replace(/\[(System|OOC|Note|Author'?s?\s*Note|TL|T\/L|Narrator|A\/N)[^\]]*\]/gi, '');
}

/**
 * 移除所有方括号及其内容
 * @param {string} text - 原始文本
 * @returns {string} 清洗后的文本
 */
function removeBracketContent(text) {
    if (!text) return text;
    // 移除所有 [...] 格式的内容（包括括号本身）
    // 使用非贪婪匹配，避免跨括号匹配
    return text.replace(/\[[^\]]*\]/g, '');
}

/**
 * 规范化空白字符
 * @param {string} text - 原始文本
 * @returns {string} 清洗后的文本
 */
function normalizeWhitespace(text) {
    if (!text) return text;

    let result = text;

    // 将多个连续换行压缩为两个
    result = result.replace(/\n{3,}/g, '\n\n');

    // 将多个连续空格压缩为一个
    result = result.replace(/[ \t]+/g, ' ');

    // 移除行首行尾空格
    result = result.split('\n').map(line => line.trim()).join('\n');

    return result.trim();
}

/**
 * 清洗文本用于向量化
 * 根据用户配置的选项进行清洗
 * @param {string} text - 原始文本
 * @param {object} [customConfig] - 自定义配置（可选，覆盖默认配置）
 * @returns {string} 清洗后的文本
 */
export function cleanTextForEmbedding(text, customConfig = null) {
    if (!text || typeof text !== 'string') return '';

    const config = customConfig || getTextCleaningConfig();
    let cleaned = text;

    // 1. 移除 <style> 标签及其内容（必须在移除HTML标签之前）
    if (config.remove_style_tags) {
        cleaned = removeTagsWithContent(cleaned, ['style', 'script']);
    }

    // 2. 移除思考标签及内容
    if (config.remove_thinking_tags) {
        cleaned = removeTagsWithContent(cleaned, ['thinking', 'think', 'thought', 'thoughts']);
    }

    // 3. 移除 OOC 标签及内容
    if (config.remove_ooc_tags) {
        cleaned = removeTagsWithContent(cleaned, ['ooc', 'OOC']);
    }

    // 4. 移除系统/元信息标签及内容
    if (config.remove_system_tags) {
        cleaned = removeTagsWithContent(cleaned, [
            'system', 'note', 'notes', 'meta', 'debug',
            'comment', 'aside', 'internal', 'analysis',
            'reflection', 'planning', 'author_note'
        ]);
    }

    // 5. 处理自定义标签
    if (config.custom_tags_to_remove && config.custom_tags_to_remove.trim()) {
        const customTags = config.custom_tags_to_remove
            .split(',')
            .map(tag => tag.trim())
            .filter(tag => tag.length > 0 && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(tag));

        if (customTags.length > 0) {
            cleaned = removeTagsWithContent(cleaned, customTags);
        }
    }

    // 6. 移除 HTML 标签（保留文本内容）
    if (config.remove_html_tags) {
        cleaned = removeHtmlTagsKeepContent(cleaned);
    }

    // 7. 移除 Markdown 格式
    if (config.remove_markdown) {
        cleaned = removeMarkdownFormatting(cleaned);
    }

    // 8. 移除宏残留
    if (config.remove_macro_residue) {
        cleaned = removeMacroResidue(cleaned);
    }

    // 9. 移除方括号标记（仅特定系统标记）
    if (config.remove_bracket_markers) {
        cleaned = removeBracketMarkers(cleaned);
    }

    // 10. 移除所有方括号及其内容
    if (config.remove_bracket_content) {
        cleaned = removeBracketContent(cleaned);
    }

    // 11. 规范化空白
    cleaned = normalizeWhitespace(cleaned);

    return cleaned;
}

/**
 * 检查清洗后的文本是否有效（满足最小长度要求）
 * @param {string} cleanedText - 清洗后的文本
 * @param {number} [minLength] - 最小长度（可选，默认使用配置值）
 * @returns {boolean} 是否有效
 */
export function isValidCleanedText(cleanedText, minLength = null) {
    if (!cleanedText || typeof cleanedText !== 'string') return false;

    const config = getTextCleaningConfig();
    const threshold = minLength !== null ? minLength : (config.min_text_length || 20);

    return cleanedText.trim().length >= threshold;
}

/**
 * 批量清洗文本数组
 * @param {string[]} texts - 原始文本数组
 * @param {object} [customConfig] - 自定义配置
 * @returns {Array<{original: string, cleaned: string, isValid: boolean}>} 清洗结果数组
 */
export function batchCleanTexts(texts, customConfig = null) {
    if (!texts || !Array.isArray(texts)) return [];

    const config = customConfig || getTextCleaningConfig();

    return texts.map(text => {
        const cleaned = cleanTextForEmbedding(text, config);
        const isValid = isValidCleanedText(cleaned, config.min_text_length);

        return {
            original: text,
            cleaned,
            isValid
        };
    });
}

/**
 * 获取清洗统计信息
 * @param {string} original - 原始文本
 * @param {string} cleaned - 清洗后的文本
 * @returns {object} 统计信息
 */
export function getCleaningStats(original, cleaned) {
    const originalLength = original ? original.length : 0;
    const cleanedLength = cleaned ? cleaned.length : 0;
    const removedChars = originalLength - cleanedLength;
    const reductionPercent = originalLength > 0
        ? Math.round((removedChars / originalLength) * 100)
        : 0;

    return {
        originalLength,
        cleanedLength,
        removedChars,
        reductionPercent
    };
}

/**
 * 预览清洗效果（用于 UI 显示）
 * @param {string} sampleText - 示例文本
 * @returns {object} 预览结果
 */
export function previewCleaning(sampleText) {
    const cleaned = cleanTextForEmbedding(sampleText);
    const stats = getCleaningStats(sampleText, cleaned);
    const isValid = isValidCleanedText(cleaned);

    return {
        original: sampleText,
        cleaned,
        stats,
        isValid
    };
}