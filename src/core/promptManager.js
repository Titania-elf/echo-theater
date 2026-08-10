// 提示词方案模型与统一消息构造器

import { estimateTokens } from "../utils/helpers.js";

export const DEFAULT_CONTENT_PROMPT = "You are a creative engine. Output ONLY valid HTML content inside a <div> with Inline CSS. Do NOT use markdown code blocks. Language: Chinese.";

export const DEFAULT_VISUAL_PROMPT = `You are a Visual Director creating an immersive HTML scene.

[Process]
1. Analyze the mood/emotion of the scenario
2. Choose visual effects that represent the mood
3. Generate HTML with embedded <style>

[Technical Rules]
1. Output HTML with <style> block
2. Use CSS animations, gradients, shadows freely
3. No markdown code blocks
4. Language: Chinese`;

export const TITANIA_OUTPUT_CONTRACT = `你正在生成可直接渲染的小剧场内容。

[输出要求]
1. 根据随后提供的“小剧场指令”完成创作，不要复述或解释指令。
2. 输出必须是完整、有效且可直接嵌入页面的 HTML 片段。
3. 使用 HTML 结构与 CSS 对内容进行视觉编排，使样式服务于场景氛围、叙事层次和阅读体验。
4. 可以使用内联样式或片段内的 <style>，但不要输出 <html>、<head>、<body> 等完整文档外壳。
5. 不要输出 Markdown 代码块、实现说明、前言、总结或 HTML 之外的文本。
6. 保证结构闭合，不要依赖外部脚本、外部样式表或网络资源。
7. 默认使用中文，除非小剧场指令另有要求。
8. 内容表达优先于装饰。保持正文清晰、层次明确；视觉效果应增强内容，不得遮挡、压缩或干扰阅读。`;

const BUILTIN_MODES = ["narrative", "visual"];
const EDITOR_VIEWS = [...BUILTIN_MODES, "preset"];
const MESSAGE_ROLES = ["system", "user", "assistant"];
const REMOVED_MARKERS = new Set(["charPersonality"]);
const DYNAMIC_MARKERS = new Set([
    "personaDescription",
    "charDescription",
    "worldInfoBefore",
    "worldInfoAfter",
    "chatHistory",
    "scenario",
    "dialogueExamples",
    "titaniaScript"
]);
const BASIC_MACRO_CONTEXT_KEYS = {
    char: "charName",
    user: "userName",
    persona: "userDesc",
    description: "persona"
};
const DYNAMIC_MARKER_CONTEXT_KEYS = {
    personaDescription: "userDesc",
    charDescription: "persona",
    worldInfoBefore: "worldInfoBefore",
    worldInfoAfter: "worldInfoAfter",
    chatHistory: "chatHistory",
    scenario: "scenario",
    dialogueExamples: "dialogueExamples",
    titaniaScript: "titaniaScript"
};

function createEntryId(prefix = "entry") {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createBuiltinScheme(mode, systemContent) {
    return {
        id: mode,
        name: mode === "visual" ? "氛围美化" : "内容优先",
        type: "builtin",
        entries: [
            { id: `${mode}_system`, name: "系统提示词", role: "system", type: "text", enabled: true, content: systemContent },
            { id: `${mode}_user`, name: "生成上下文", role: "user", type: "text", enabled: true, content: "" }
        ]
    };
}

export function createDefaultPromptManager() {
    return {
        version: 4,
        editor_view: "narrative",
        active_preset_id: "",
        builtin: {
            narrative: createBuiltinScheme("narrative", DEFAULT_CONTENT_PROMPT),
            visual: createBuiltinScheme("visual", DEFAULT_VISUAL_PROMPT)
        },
        presets: []
    };
}

/**
 * 初始化新模型，并将旧 custom_prompts 一次性迁移到内置方案。
 * @returns {boolean} 是否创建或修复了模型
 */
export function ensurePromptManager(data) {
    let changed = false;
    const defaults = createDefaultPromptManager();
    const manager = data.prompt_manager;

    if (!manager || typeof manager !== "object") {
        data.prompt_manager = defaults;
        const legacy = data.custom_prompts || {};
        if (legacy.override_enabled === true) {
            const content = String(legacy.content_mode || "").trim();
            const visual = String(legacy.visual_mode || "").trim();
            if (content) data.prompt_manager.builtin.narrative.entries[0].content = content;
            if (visual) data.prompt_manager.builtin.visual.entries[0].content = visual;
        }
        changed = true;
    } else {
        const previousVersion = Number(manager.version) || 1;
        manager.version = 4;
        if (previousVersion !== 4) changed = true;
        manager.editor_view = EDITOR_VIEWS.includes(manager.editor_view) ? manager.editor_view : "narrative";
        manager.active_preset_id = typeof manager.active_preset_id === "string" ? manager.active_preset_id : "";
        manager.builtin = manager.builtin && typeof manager.builtin === "object" ? manager.builtin : {};
        for (const mode of BUILTIN_MODES) {
            if (!manager.builtin[mode] || !Array.isArray(manager.builtin[mode].entries)
                || !manager.builtin[mode].entries.some(entry => entry?.role === "system")) {
                manager.builtin[mode] = defaults.builtin[mode];
                changed = true;
            }
        }
        if (previousVersion < 2 && data.custom_prompts?.override_enabled === true) {
            const content = String(data.custom_prompts.content_mode || "").trim();
            const visual = String(data.custom_prompts.visual_mode || "").trim();
            const contentEntry = manager.builtin.narrative.entries.find(entry => entry?.role === "system");
            const visualEntry = manager.builtin.visual.entries.find(entry => entry?.role === "system");
            if (content && contentEntry) contentEntry.content = content;
            if (visual && visualEntry) visualEntry.content = visual;
            changed = true;
        }
        manager.presets = Array.isArray(manager.presets) ? manager.presets : [];
        if (previousVersion < 3) {
            for (const preset of manager.presets) {
                if (!Array.isArray(preset?.entries)) continue;
                preset.entries = preset.entries.filter(entry => {
                    const marker = entry?.marker || entry?.source_identifier;
                    return !REMOVED_MARKERS.has(marker);
                });
                for (const entry of preset.entries) {
                    const inferredMarker = entry.marker || entry.source_identifier;
                    if (DYNAMIC_MARKERS.has(inferredMarker)) {
                        entry.type = "dynamic";
                        entry.marker = inferredMarker;
                    }
                }
            }
            changed = true;
        }
        for (const preset of manager.presets) {
            if (ensureTitaniaPresetEntries(preset)) changed = true;
        }
        if (manager.active_preset_id && !manager.presets.some(preset => preset?.id === manager.active_preset_id)) {
            manager.active_preset_id = manager.presets[0]?.id || "";
            changed = true;
        }
    }

    return changed;
}

export function getPresetEntrySummary(preset) {
    return (preset?.entries || []).map((entry, index) => ({
        index: index + 1,
        id: entry.id,
        name: entry.name || entry.source_identifier || `条目 ${index + 1}`,
        role: entry.role || "user",
        type: entry.type || "text",
        marker: entry.marker || "",
        enabled: entry.enabled !== false,
        required: entry.required === true,
        readonly: entry.readonly === true,
        custom: entry.custom === true,
        content: entry.content || ""
    }));
}

/**
 * 创建一条用户自建的预设条目。
 * 字段与 normalizeChatCompletionPreset 产出的条目保持一致，只多一个 custom 标记：
 * 界面靠它区分「预设自带的」和「用户后加的」，只有后者允许删除。
 */
export function createCustomPresetEntry(overrides = {}) {
    return {
        id: createEntryId("custom"),
        source_identifier: null,
        name: "自定义条目",
        role: "system",
        type: "text",
        marker: null,
        enabled: true,
        required: false,
        custom: true,
        content: "",
        ...overrides
    };
}

/**
 * 用户可插入新条目的下标上限（含）。
 * ensureTitaniaPresetEntries 会把两条受管条目钉在队尾，插到它们之后的条目会被重排，
 * 所以界面只在这个下标之前提供插入点，避免「插了但没插在那儿」的意外。
 */
export function getPresetInsertLimit(preset) {
    const entries = preset?.entries;
    if (!Array.isArray(entries)) return 0;
    const managedIndex = entries.findIndex(isTitaniaManagedEntry);
    return managedIndex < 0 ? entries.length : managedIndex;
}

export function getPromptScheme(data, mode = "narrative") {
    ensurePromptManager(data);
    const manager = data.prompt_manager;
    if (mode === "preset") {
        const activePreset = manager.presets.find(preset => preset?.id === manager.active_preset_id);
        return activePreset ? JSON.parse(JSON.stringify(activePreset)) : null;
    }
    const normalizedMode = BUILTIN_MODES.includes(mode) ? mode : "narrative";
    const scheme = JSON.parse(JSON.stringify(manager.builtin[normalizedMode]));
    const defaultContent = normalizedMode === "visual" ? DEFAULT_VISUAL_PROMPT : DEFAULT_CONTENT_PROMPT;

    const systemEntry = scheme.entries.find(entry => entry?.role === "system") || scheme.entries[0];
    if (systemEntry && !String(systemEntry.content || "").trim()) {
        systemEntry.content = defaultContent;
    }
    return scheme;
}

function getPromptOrder(preset) {
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

function getMarkerNameFromContent(content) {
    const exact = String(content || "").trim().match(/^\{\{\s*([\w-]+)\s*\}\}$/);
    return exact ? exact[1] : "";
}

function getDeclaredMarker(definition, identifier) {
    const markerField = definition?.marker;
    let declared = "";
    if (markerField === true) declared = identifier;
    else if (typeof markerField === "string") declared = markerField.trim();
    else if (markerField && typeof markerField === "object") {
        declared = String(markerField.identifier || markerField.name || markerField.key || "").trim();
    }
    return declared || getMarkerNameFromContent(definition?.content);
}

function isAssistantPrefill(entry) {
    return entry.role === "assistant" && String(entry.content || "").trim().length > 0;
}

function createTitaniaScriptEntry() {
    return {
        id: "titania_script_instruction",
        source_identifier: null,
        name: "小剧场指令",
        role: "user",
        type: "dynamic",
        marker: "titaniaScript",
        enabled: true,
        required: true,
        readonly: true,
        content: ""
    };
}

function createTitaniaOutputContractEntry() {
    return {
        id: "titania_output_contract",
        source_identifier: null,
        name: "小剧场输出规范",
        role: "system",
        type: "text",
        marker: null,
        enabled: true,
        required: true,
        readonly: true,
        content: TITANIA_OUTPUT_CONTRACT
    };
}

function isTitaniaManagedEntry(entry) {
    return entry?.id === "titania_output_contract"
        || entry?.id === "titania_script_instruction"
        || entry?.marker === "titaniaScript";
}

// 逐字段比对，等价于旧实现里 JSON.stringify 的深比较（规范条目字段全为原始值）
function isCanonicalEntry(entry, canonical) {
    if (!entry || typeof entry !== "object") return false;
    const keys = Object.keys(canonical);
    if (Object.keys(entry).length !== keys.length) return false;
    return keys.every(key => entry[key] === canonical[key]);
}

/**
 * 快速判断预设是否已满足 Titania 条目的全部不变量，命中则可跳过重建。
 * 不变量：恰好两个受管条目，相邻且顺序为「输出规范 → 小剧场指令」，
 * 位于尾部 assistant 预填之前，且字段与当前规范值一致。
 */
function hasCanonicalTitaniaEntries(entries) {
    let firstIndex = -1;
    let managedCount = 0;
    for (let i = 0; i < entries.length; i++) {
        if (!isTitaniaManagedEntry(entries[i])) continue;
        if (firstIndex === -1) firstIndex = i;
        managedCount++;
    }
    if (managedCount !== 2) return false;

    if (!isCanonicalEntry(entries[firstIndex], createTitaniaOutputContractEntry())) return false;
    if (!isCanonicalEntry(entries[firstIndex + 1], createTitaniaScriptEntry())) return false;

    // 插入点应尽量靠后：前一条不能是 assistant 预填，其后必须全是 assistant 预填
    const isPrefill = entry => !!entry && typeof entry === "object" && isAssistantPrefill(entry);
    if (firstIndex > 0 && isPrefill(entries[firstIndex - 1])) return false;
    for (let i = firstIndex + 2; i < entries.length; i++) {
        if (!isPrefill(entries[i])) return false;
    }
    return true;
}

export function ensureTitaniaPresetEntries(preset) {
    if (!preset || !Array.isArray(preset.entries)) return false;
    if (hasCanonicalTitaniaEntries(preset.entries)) return false;
    const previous = JSON.stringify(preset.entries);
    preset.entries = preset.entries.filter(entry => (
        entry?.id !== "titania_output_contract"
        && entry?.id !== "titania_script_instruction"
        && entry?.marker !== "titaniaScript"
    ));
    let insertAt = preset.entries.length;
    while (insertAt > 0 && isAssistantPrefill(preset.entries[insertAt - 1])) insertAt--;
    preset.entries.splice(insertAt, 0, createTitaniaOutputContractEntry(), createTitaniaScriptEntry());
    return JSON.stringify(preset.entries) !== previous;
}

/**
 * 将 SillyTavern Chat Completion 预设转换为插件内部的有序方案。
 * prompt_order 是唯一的顺序和 enabled 来源，prompts 只提供条目内容。
 */
export function normalizeChatCompletionPreset(preset, options = {}) {
    if (!preset || typeof preset !== "object") throw new Error("预设数据无效");

    const promptDefinitions = Array.isArray(preset.prompts) ? preset.prompts : [];
    const definitions = new Map();
    for (const item of promptDefinitions) {
        const identifier = String(item?.identifier || "").trim();
        if (identifier && !definitions.has(identifier)) definitions.set(identifier, item);
    }

    const promptOrderResult = getPromptOrder(preset);
    const promptOrder = promptOrderResult.order;
    const entries = [];
    const usedIdentifiers = new Set();
    let missingDefinitionCount = 0;
    let removedMarkerCount = 0;

    for (const orderItem of promptOrder) {
        const identifier = String(orderItem?.identifier || "").trim();
        if (!identifier || usedIdentifiers.has(identifier)) continue;
        const definition = definitions.get(identifier);
        if (!definition) {
            missingDefinitionCount++;
            continue;
        }
        let content = String(definition.content || "");
        const declaredMarker = getDeclaredMarker(definition, identifier);
        if (REMOVED_MARKERS.has(identifier) || REMOVED_MARKERS.has(declaredMarker)) {
            removedMarkerCount++;
            continue;
        }
        const marker = DYNAMIC_MARKERS.has(declaredMarker) ? declaredMarker : "";
        if (declaredMarker && !marker && !content.trim()) content = `{{${declaredMarker}}}`;

        entries.push({
            id: createEntryId(`st_${identifier.replace(/[^a-zA-Z0-9_-]/g, "_")}`),
            source_identifier: identifier,
            name: String(definition.name || definition.title || identifier),
            role: MESSAGE_ROLES.includes(definition.role) ? definition.role : "user",
            type: marker ? "dynamic" : "text",
            marker: marker || null,
            enabled: orderItem.enabled !== false,
            required: false,
            content
        });
        usedIdentifiers.add(identifier);
    }

    const normalized = { entries };
    ensureTitaniaPresetEntries(normalized);

    return {
        id: options.id || createEntryId("preset"),
        name: options.name || preset.name || "导入预设",
        type: "preset",
        source: "sillytavern_chat_completion",
        imported_at: Date.now(),
        entries: normalized.entries,
        model_settings: {
            model: preset.model || "",
            temperature: preset.temperature,
            top_p: preset.top_p,
            max_tokens: preset.openai_max_tokens ?? preset.max_tokens
        },
        import_stats: {
            ...promptOrderResult.stats,
            imported_count: entries.length,
            missing_definition_count: missingDefinitionCount,
            removed_marker_count: removedMarkerCount
        }
    };
}

function resolveMacro(marker, runtimeContext, originalText) {
    if (REMOVED_MARKERS.has(marker)) return "";
    if (DYNAMIC_MARKERS.has(marker)) {
        const contextKey = DYNAMIC_MARKER_CONTEXT_KEYS[marker] || marker;
        return String(runtimeContext[contextKey] || "");
    }
    const contextKey = BASIC_MACRO_CONTEXT_KEYS[String(marker || "").toLowerCase()];
    if (contextKey) return String(runtimeContext[contextKey] || "");
    if (Object.prototype.hasOwnProperty.call(runtimeContext, marker)) {
        return String(runtimeContext[marker] || "");
    }
    return originalText;
}

function resolveEntryContent(entry, contentByEntry, runtimeContext) {
    let content = Object.prototype.hasOwnProperty.call(contentByEntry, entry.id)
        ? String(contentByEntry[entry.id] || "")
        : String(entry.content || "");
    content = content.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (match, marker) => resolveMacro(marker, runtimeContext, match));
    if (entry.marker) content = resolveMacro(entry.marker, runtimeContext, `{{${entry.marker}}}`);
    return content;
}

export function buildPromptMessageDetails(scheme, contentByEntry = {}, runtimeContext = {}) {
    if (!scheme || !Array.isArray(scheme.entries)) return [];
    return scheme.entries
        .filter(entry => entry?.enabled !== false)
        .map(entry => {
            const content = resolveEntryContent(entry, contentByEntry, runtimeContext);
            return {
                entryId: entry.id || "",
                sourceIdentifier: entry.source_identifier || null,
                name: entry.name || entry.source_identifier || "未命名条目",
                role: MESSAGE_ROLES.includes(entry.role) ? entry.role : "user",
                type: entry.type || "text",
                marker: entry.marker || null,
                required: entry.required === true,
                content,
                chars: content.length,
                tokens: estimateTokens(content)
            };
        })
        .filter(message => message.content.length > 0)
        .map((message, index) => ({ ...message, index }));
}

/**
 * 将方案条目转换成标准 API 消息。条目顺序和角色均由方案决定。
 */
export function buildPromptMessages(scheme, contentByEntry = {}, runtimeContext = {}) {
    return buildPromptMessageDetails(scheme, contentByEntry, runtimeContext)
        .map(({ role, content }) => ({ role, content }));
}
