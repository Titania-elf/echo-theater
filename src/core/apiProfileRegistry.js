// src/core/apiProfileRegistry.js

import { openai_setting_names, openai_settings, oai_settings } from "../../../openai.js";

export function normalizeApiBaseUrl(inputUrl) {
    return String(inputUrl || "")
        .trim()
        .replace(/\/+$/, "")
        .replace(/\/chat\/completions$/, "")
        .replace(/\/v1\/models$/, "")
        .replace(/\/models$/, "");
}

export function ensureMainApiProfiles(config = {}) {
    const cfg = config && typeof config === "object" ? config : {};
    let profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];

    if (profiles.length === 0) {
        profiles = [
            { id: "st_sync", name: "🔗 跟随 SillyTavern (主连接)", type: "internal", readonly: true },
            { id: "default", name: "默认自定义", type: "custom", url: cfg.url || "", key: cfg.key || "", model: cfg.model || "gpt-3.5-turbo" },
        ];
    }

    profiles = profiles.map((profile, idx) => {
        const id = String(profile?.id || `custom_${Date.now()}_${idx}`).trim();
        const type = profile?.type === "internal" ? "internal" : "custom";
        const fallbackName = type === "internal" ? "🔗 跟随 SillyTavern (主连接)" : `自定义方案 ${idx + 1}`;
        return {
            id,
            name: String(profile?.name || fallbackName).trim() || fallbackName,
            type,
            readonly: profile?.readonly === true,
            url: String(profile?.url || "").trim(),
            key: String(profile?.key || "").trim(),
            model: String(profile?.model || "gpt-3.5-turbo").trim() || "gpt-3.5-turbo",
        };
    });

    if (!profiles.some((p) => p.id === "st_sync")) {
        profiles.unshift({ id: "st_sync", name: "🔗 跟随 SillyTavern (主连接)", type: "internal", readonly: true, url: "", key: "", model: "gpt-3.5-turbo" });
    }

    const activeId = String(cfg.active_profile_id || "").trim();
    const active_profile_id = profiles.some((p) => p.id === activeId)
        ? activeId
        : (profiles.find((p) => p.type !== "internal")?.id || profiles[0]?.id || "default");

    return { profiles, active_profile_id };
}

export function normalizeRewriteCustomProfiles(inputProfiles = [], fallback = null) {
    const list = Array.isArray(inputProfiles) ? inputProfiles : [];
    const rows = list
        .map((item, idx) => {
            const id = String(item?.id || `rewrite_custom_${Date.now()}_${idx}`).trim();
            const name = String(item?.name || `方案 ${idx + 1}`).trim() || `方案 ${idx + 1}`;
            return {
                id,
                name,
                api_url: String(item?.api_url || "").trim(),
                api_key: String(item?.api_key || "").trim(),
                model: String(item?.model || "").trim(),
            };
        })
        .filter((item) => item.id);

    if (rows.length > 0) return rows;

    const base = fallback || {};
    return [{
        id: `rewrite_custom_${Date.now()}`,
        name: "方案 1",
        api_url: String(base.api_url || "").trim(),
        api_key: String(base.api_key || "").trim(),
        model: String(base.model || "").trim(),
    }];
}

function resolveModelFromStPreset(preset, sourceText) {
    const src = String(sourceText || "").toLowerCase();
    if (src.includes("claude")) return String(preset?.claude_model || "");
    if (src.includes("custom")) return String(preset?.custom_model || "");
    if (src.includes("openrouter")) return String(preset?.openrouter_model || "");
    if (src.includes("makersuite") || src.includes("google")) return String(preset?.google_model || "");
    if (src.includes("vertex")) return String(preset?.vertexai_model || "");
    if (src.includes("deepseek")) return String(preset?.deepseek_model || "");
    if (src.includes("groq")) return String(preset?.groq_model || "");
    if (src.includes("perplexity")) return String(preset?.perplexity_model || "");
    if (src.includes("cohere")) return String(preset?.cohere_model || "");
    if (src.includes("mistral")) return String(preset?.mistralai_model || "");
    if (src.includes("ai21")) return String(preset?.ai21_model || "");
    if (src.includes("xai")) return String(preset?.xai_model || "");
    if (src.includes("moonshot")) return String(preset?.moonshot_model || "");
    if (src.includes("fireworks")) return String(preset?.fireworks_model || "");
    if (src.includes("siliconflow")) return String(preset?.siliconflow_model || "");
    if (src.includes("openai")) return String(preset?.openai_model || "");
    return String(preset?.custom_model || preset?.openai_model || preset?.claude_model || preset?.openrouter_model || "");
}

export function getStPresetProfiles() {
    try {
        const nameMap = openai_setting_names && typeof openai_setting_names === "object" ? openai_setting_names : {};
        const settingsList = Array.isArray(openai_settings) ? openai_settings : [];
        return Object.keys(nameMap).map((name) => {
            const idx = Number(nameMap[name]);
            const preset = Number.isInteger(idx) && idx >= 0 ? settingsList[idx] : null;
            const source = String(preset?.chat_completion_source || oai_settings?.chat_completion_source || "");
            return {
                id: `st:${name}`,
                name,
                source,
                api_url: normalizeApiBaseUrl(String(preset?.custom_url || preset?.reverse_proxy || "").trim()),
                api_key: "",
                model: resolveModelFromStPreset(preset, source).trim(),
            };
        });
    } catch {
        return [];
    }
}
