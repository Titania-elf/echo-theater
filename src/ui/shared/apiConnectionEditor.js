// src/ui/shared/apiConnectionEditor.js

import { normalizeApiBaseUrl } from "../../core/apiProfileRegistry.js";

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function getById($root, id) {
    if (!$root || !$root.length || !id) return $();
    return $root.find(`#${id}`);
}

function uniqStrings(values) {
    return [...new Set((Array.isArray(values) ? values : []).map((v) => String(v || "").trim()).filter(Boolean))];
}

function defaultModelFetcher({ apiUrl, apiKey }) {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return fetch(`${apiUrl}/models`, { method: "GET", headers })
        .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        })
        .then((json) => {
            const list = Array.isArray(json?.data) ? json.data : (Array.isArray(json?.models) ? json.models : []);
            return uniqStrings(list.map((item) => (typeof item === "string" ? item : item?.id)));
        });
}

function normalizeProfile(profile, idx = 0, defaultModel = "gpt-3.5-turbo") {
    const type = profile?.type === "internal" ? "internal" : "custom";
    const id = String(profile?.id || `profile_${Date.now()}_${idx}`).trim();
    const name = String(profile?.name || (type === "internal" ? "跟随主连接" : `方案 ${idx + 1}`)).trim() || `方案 ${idx + 1}`;
    return {
        id,
        type,
        readonly: profile?.readonly === true,
        name,
        url: String(profile?.url || "").trim(),
        key: String(profile?.key || "").trim(),
        model: String(profile?.model || defaultModel).trim() || defaultModel,
    };
}

function buildUniqueProfileId(rawId, idx, usedIds) {
    const base = String(rawId || `profile_${Date.now()}_${idx}`).trim() || `profile_${Date.now()}_${idx}`;
    if (!usedIds.has(base)) {
        usedIds.add(base);
        return base;
    }

    let seed = 1;
    let candidate = `${base}_${seed}`;
    while (usedIds.has(candidate)) {
        seed += 1;
        candidate = `${base}_${seed}`;
    }
    usedIds.add(candidate);
    return candidate;
}

function normalizeProfilesWithUniqueIds(profiles, defaultModel = "gpt-3.5-turbo") {
    const usedIds = new Set();
    return (Array.isArray(profiles) ? profiles : []).map((profile, idx) => {
        const normalized = normalizeProfile(profile, idx, defaultModel);
        normalized.id = buildUniqueProfileId(normalized.id, idx, usedIds);
        return normalized;
    });
}

export function mapCustomProfilesToConnectionProfiles(customProfiles, defaultModel = "gpt-3.5-turbo") {
    const list = Array.isArray(customProfiles) ? customProfiles : [];
    return list.map((profile, idx) => normalizeProfile({
        id: profile?.id,
        name: profile?.name,
        type: "custom",
        readonly: false,
        url: profile?.api_url,
        key: profile?.api_key,
        model: profile?.model || defaultModel,
    }, idx, defaultModel));
}

export function mapConnectionProfilesToCustomProfiles(connectionProfiles, defaultModel = "gpt-3.5-turbo") {
    return (Array.isArray(connectionProfiles) ? connectionProfiles : [])
        .filter((profile) => String(profile?.type || "custom") !== "internal")
        .map((profile, idx) => {
            const normalized = normalizeProfile(profile, idx, defaultModel);
            return {
                id: normalized.id,
                name: normalized.name,
                api_url: normalized.url,
                api_key: normalized.key,
                model: normalized.model,
            };
        });
}

export function renderApiConnectionEditorHTML(options = {}) {
    const ids = options.ids || {};
    const labels = {
        profile: "API 方案",
        profileName: "方案名称",
        apiUrl: "API 地址",
        apiKey: "API Key",
        model: "模型",
        stream: "开启流式传输 (Streaming)",
        maxTokens: "输出 Token 限制 (max_tokens)",
        ...(options.labels || {}),
    };
    const placeholders = {
        apiUrl: "https://api.example.com/v1",
        apiKey: "sk-...",
        profileName: "方案名称",
        ...(options.placeholders || {}),
    };
    const classes = {
        input: "t-input",
        select: "t-input",
        profileSelect: "t-input",
        button: "t-btn",
        ...(options.classes || {}),
    };
    const flags = {
        showProfileName: true,
        showDeleteProfile: true,
        showStream: false,
        showMaxTokens: false,
        showManualModelInput: false,
        ...(options.flags || {}),
    };
    const values = {
        stream: true,
        maxTokens: 4096,
        statusText: "填写 API 后可刷新模型列表",
        ...(options.values || {}),
    };

    const profileNameBlock = flags.showProfileName
        ? `<div id="${escapeHtml(ids.profileMetaId || "")}"><label class="t-form-label">${escapeHtml(labels.profileName)}</label><input id="${escapeHtml(ids.profileNameId || "")}" class="${escapeHtml(classes.input)}" value="" placeholder="${escapeHtml(placeholders.profileName)}"></div>`
        : "";

    const streamBlock = flags.showStream
        ? `<div class="t-form-group"><label style="cursor:pointer; display:flex; align-items:center;"><input type="checkbox" id="${escapeHtml(ids.streamId || "")}" ${values.stream ? "checked" : ""} style="margin-right:10px;"> ${escapeHtml(labels.stream)}</label></div>`
        : "";

    const maxTokensBlock = flags.showMaxTokens
        ? `<div class="t-form-group" style="margin-top:15px; padding-top:15px; border-top:1px solid var(--t-color-border);">
                <label class="t-form-label">${escapeHtml(labels.maxTokens)}</label>
                <div style="display:flex; align-items:center; gap:10px;">
                    <input type="number" id="${escapeHtml(ids.maxTokensId || "")}" class="${escapeHtml(classes.input)}" value="${escapeHtml(values.maxTokens)}" min="256" max="32768" step="256" style="width:120px;">
                    <span style="font-size:0.85em; color:var(--t-color-text-muted);">范围: 256 ~ 32768</span>
                </div>
                ${values.maxTokensHintHtml || ""}
            </div>`
        : "";

    return `
        <div class="t-form-group">
            <label class="t-form-label">${escapeHtml(labels.profile)}</label>
            <div class="t-prof-header">
                <select id="${escapeHtml(ids.profileSelectId || "")}" class="${escapeHtml(classes.profileSelect)}"></select>
                <button id="${escapeHtml(ids.profileAddId || "")}" class="${escapeHtml(classes.button)}" title="新建方案"><i class="fa-solid fa-plus"></i></button>
                ${flags.showDeleteProfile ? `<button id="${escapeHtml(ids.profileDeleteId || "")}" class="${escapeHtml(classes.button)}" title="删除当前方案" style="color:var(--t-color-danger);"><i class="fa-solid fa-trash"></i></button>` : ""}
            </div>
            ${profileNameBlock}
            <div id="${escapeHtml(ids.profileTipId || "")}" class="t-conn-hint"></div>
        </div>
        <div style="height:1px; background:var(--t-color-border); margin:20px 0;"></div>
        <div id="${escapeHtml(ids.fieldsWrapId || "")}">
            <div class="t-form-group">
                <label class="t-form-label">${escapeHtml(labels.apiUrl)}</label>
                <input id="${escapeHtml(ids.apiUrlId || "")}" class="${escapeHtml(classes.input)}" placeholder="${escapeHtml(placeholders.apiUrl)}">
                <div id="${escapeHtml(ids.urlHintId || "")}" style="font-size:0.8em; color:var(--t-color-text-faint); margin-top:5px; display:none;"><i class="fa-solid fa-link"></i> 正在读取 ST 全局设置：<span id="${escapeHtml(ids.stUrlDisplayId || "")}"></span></div>
            </div>
            <div class="t-form-group"><label class="t-form-label">${escapeHtml(labels.apiKey)}</label><input id="${escapeHtml(ids.apiKeyId || "")}" type="password" class="${escapeHtml(classes.input)}" placeholder="${escapeHtml(placeholders.apiKey)}"></div>
            <div class="t-form-group">
                <label class="t-form-label">${escapeHtml(labels.model)}</label>
                ${flags.showManualModelInput ? `<div style="display:flex; gap:10px; margin-bottom:8px;"><select id="${escapeHtml(ids.modelModeId || "")}" class="${escapeHtml(classes.select)}" style="width:auto; cursor:pointer;"><option value="list">获取列表</option><option value="manual">手动填写</option></select></div>` : ""}
                <div id="${escapeHtml(ids.modelListWrapId || "")}" style="display:flex; gap:10px;"><select id="${escapeHtml(ids.modelId || "")}" class="${escapeHtml(classes.select)}" style="cursor:pointer;"></select><button id="${escapeHtml(ids.fetchModelsId || "")}" class="${escapeHtml(classes.button)}" title="获取模型列表">🔄 获取列表</button></div>
                ${flags.showManualModelInput ? `<div id="${escapeHtml(ids.modelManualWrapId || "")}" style="display:none;"><input id="${escapeHtml(ids.modelInputId || "")}" class="${escapeHtml(classes.input)}" placeholder="模型 ID，例如：gpt-4o"></div>` : ""}
                <div id="${escapeHtml(ids.statusId || "")}" class="t-conn-hint">${escapeHtml(values.statusText)}</div>
            </div>
        </div>
        ${streamBlock}
        ${maxTokensBlock}
    `;
}

export function createApiConnectionEditor(options = {}) {
    const $root = options.root;
    const ids = options.ids || {};
    const defaultModel = String(options.defaultModel || "gpt-3.5-turbo").trim() || "gpt-3.5-turbo";
    const normalizeUrl = typeof options.normalizeUrl === "function" ? options.normalizeUrl : normalizeApiBaseUrl;
    const modelFetcher = typeof options.modelFetcher === "function" ? options.modelFetcher : defaultModelFetcher;
    const showManualModelInput = options.showManualModelInput === true;
    const autoFetchDelay = Number.isFinite(Number(options.autoFetchDelayMs)) ? Number(options.autoFetchDelayMs) : 500;
    const createProfileIdPrefix = String(options.profileIdPrefix || "custom").trim() || "custom";
    const statusTexts = {
        default: "填写 API 后可刷新模型列表",
        missingUrl: "请先填写 API 地址",
        loading: "正在获取模型列表...",
        empty: "未返回可用模型",
        success: (count) => `已获取 ${count} 个模型`,
        failed: (msg) => `模型获取失败：${msg}`,
        manual: "手动填写模型 ID，不会请求模型列表。",
        internalTip: "当前使用 ST 主连接，连接参数由 ST 管理。",
        customTip: "当前使用自定义方案，URL/Key/模型会保存到该方案。",
        ...(options.statusTexts || {}),
    };

    let state = {
        profiles: normalizeProfilesWithUniqueIds(options.profiles, defaultModel),
        activeProfileId: String(options.activeProfileId || "").trim(),
    };

    if (state.profiles.length === 0) {
        state.profiles = [normalizeProfile({ id: `${createProfileIdPrefix}_${Date.now()}`, name: "方案 1", type: "custom", url: "", key: "", model: defaultModel }, 0, defaultModel)];
    }
    if (!state.profiles.some((p) => p.id === state.activeProfileId)) {
        state.activeProfileId = state.profiles.find((p) => p.type !== "internal")?.id || state.profiles[0]?.id || "";
    }

    let autoFetchTimer = null;
    let modelInputMode = "list";
    let modelRequestVersion = 0;

    const emitChange = () => {
        if (typeof options.onChange === "function") {
            options.onChange({ profiles: state.profiles.map((p) => ({ ...p })), activeProfileId: state.activeProfileId });
        }
    };

    const setStatus = (text, tone = "muted") => {
        const $status = getById($root, ids.statusId);
        if (!$status.length) return;
        $status.text(String(text || ""));
        if ($status.hasClass("t-rewrite-status")) {
            $status.removeClass("ok err muted warn").addClass(tone);
        }
    };

    const findActiveProfileIndex = () => state.profiles.findIndex((p) => p.id === state.activeProfileId);
    const findActiveProfile = () => state.profiles[findActiveProfileIndex()] || null;

    const persistCurrentProfileInputs = () => {
        const idx = findActiveProfileIndex();
        if (idx === -1) return;
        const profile = state.profiles[idx];
        if (profile.type === "internal" || profile.readonly) return;

        const $name = getById($root, ids.profileNameId);
        const $url = getById($root, ids.apiUrlId);
        const $key = getById($root, ids.apiKeyId);
        const $model = getById($root, ids.modelId);
        const $modelInput = getById($root, ids.modelInputId);

        if ($name.length) {
            profile.name = String($name.val() || "").trim() || profile.name;
        }
        if ($url.length) {
            profile.url = normalizeUrl($url.val());
        }
        if ($key.length) {
            profile.key = String($key.val() || "").trim();
        }
        if (modelInputMode === "manual" && $modelInput.length) {
            profile.model = String($modelInput.val() || "").trim() || defaultModel;
        } else if ($model.length) {
            profile.model = String($model.val() || "").trim() || defaultModel;
        }
        emitChange();
    };

    const render = () => {
        const $select = getById($root, ids.profileSelectId);
        const $name = getById($root, ids.profileNameId);
        const $del = getById($root, ids.profileDeleteId);
        const $url = getById($root, ids.apiUrlId);
        const $key = getById($root, ids.apiKeyId);
        const $model = getById($root, ids.modelId);
        const $fetchBtn = getById($root, ids.fetchModelsId);
        const $modelMode = getById($root, ids.modelModeId);
        const $modelInput = getById($root, ids.modelInputId);
        const $modelListWrap = getById($root, ids.modelListWrapId);
        const $modelManualWrap = getById($root, ids.modelManualWrapId);
        const $urlHint = getById($root, ids.urlHintId);
        const $stUrlDisplay = getById($root, ids.stUrlDisplayId);
        const $tip = getById($root, ids.profileTipId);

        $select.empty();
        state.profiles.forEach((profile) => {
            $select.append(`<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`);
        });
        $select.val(state.activeProfileId);

        const profile = findActiveProfile();
        if (!profile) return;

        const isInternal = profile.type === "internal";
        if ($name.length) {
            $name.val(profile.name || "").prop("disabled", isInternal || profile.readonly === true);
        }
        if ($del.length) {
            $del.prop("disabled", isInternal || profile.readonly === true).css("opacity", isInternal || profile.readonly ? 0.5 : 1);
        }

        if (isInternal) {
            $url.val("").prop("disabled", true).prop("placeholder", "(由 ST 托管)");
            $key.val("").prop("disabled", true).prop("placeholder", "(由 ST 托管)");
            $model.empty().append("<option selected>(ST 设置)</option>").prop("disabled", true);
            $modelMode.prop("disabled", true);
            $modelInput.prop("disabled", true).val("");
            $fetchBtn.prop("disabled", true).text("🔄 获取列表");
            $modelListWrap.show();
            $modelManualWrap.hide();
            if ($urlHint.length) {
                const stUrl = typeof options.getInternalUrl === "function" ? String(options.getInternalUrl() || "未知") : "未知";
                if ($stUrlDisplay.length) $stUrlDisplay.text(stUrl || "未知");
                $urlHint.show();
            }
            if ($tip.length) $tip.text(statusTexts.internalTip);
            setStatus(statusTexts.default, "muted");
            return;
        }

        $url.val(profile.url || "").prop("disabled", false).prop("placeholder", options.apiUrlPlaceholder || "https://api.example.com/v1");
        $key.val(profile.key || "").prop("disabled", false).prop("placeholder", options.apiKeyPlaceholder || "sk-...");
        $model.prop("disabled", false);
        $modelMode.prop("disabled", !showManualModelInput).val(modelInputMode);
        $modelInput.prop("disabled", modelInputMode !== "manual").val(profile.model || defaultModel);
        $fetchBtn.prop("disabled", modelInputMode === "manual").text("🔄 获取列表");
        $modelListWrap.toggle(modelInputMode !== "manual");
        $modelManualWrap.toggle(modelInputMode === "manual");
        if ($urlHint.length) $urlHint.hide();
        if ($tip.length) $tip.text(statusTexts.customTip);

        const currentModel = profile.model || defaultModel;
        const hasCurrentModel = $model.find("option").toArray().some((option) => String(option.value) === currentModel);
        if (!hasCurrentModel) {
            $model.empty().append(`<option value="${escapeHtml(currentModel)}" selected>${escapeHtml(currentModel)}</option>`);
        }
        $model.val(currentModel);
    };

    const createProfile = () => {
        const customCount = state.profiles.filter((p) => p.type !== "internal").length;
        const uniqueId = buildUniqueProfileId(`${createProfileIdPrefix}_${Date.now()}`, customCount, new Set(state.profiles.map((p) => String(p.id || "").trim()).filter(Boolean)));
        return normalizeProfile({
            id: uniqueId,
            name: `新方案 ${customCount + 1}`,
            type: "custom",
            url: "",
            key: "",
            model: defaultModel,
        }, customCount, defaultModel);
    };

    const fetchModels = async (showToast = false) => {
        persistCurrentProfileInputs();
        if (modelInputMode === "manual") return [];
        const profile = findActiveProfile();
        const $model = getById($root, ids.modelId);
        const $fetchBtn = getById($root, ids.fetchModelsId);
        if (!profile || profile.type === "internal") return [];

        const apiUrl = normalizeUrl(profile.url);
        if (!apiUrl) {
            setStatus(statusTexts.missingUrl, "warn");
            if (showToast && window.toastr) window.toastr.warning(statusTexts.missingUrl);
            return [];
        }

        const requestVersion = ++modelRequestVersion;
        try {
            $fetchBtn.prop("disabled", true).text("...");
            setStatus(statusTexts.loading, "muted");
            const models = uniqStrings(await modelFetcher({ apiUrl, apiKey: profile.key, profile, state: { ...state } }));
            if (requestVersion !== modelRequestVersion || profile.id !== state.activeProfileId) return [];
            if (!models.length) {
                setStatus(statusTexts.empty, "warn");
                return [];
            }

            const selectedModel = profile.model || defaultModel;
            const displayModels = uniqStrings([selectedModel, ...models]);
            $model.empty();
            displayModels.forEach((m) => {
                const label = m === selectedModel && !models.includes(m) ? `${m}（当前）` : m;
                $model.append(`<option value="${escapeHtml(m)}" ${m === selectedModel ? "selected" : ""}>${escapeHtml(label)}</option>`);
            });
            setStatus(typeof statusTexts.success === "function" ? statusTexts.success(models.length) : statusTexts.success, "ok");
            emitChange();
            if (showToast && window.toastr) {
                window.toastr.success(typeof statusTexts.success === "function" ? statusTexts.success(models.length) : statusTexts.success);
            }
            return models;
        } catch (error) {
            if (requestVersion !== modelRequestVersion || profile.id !== state.activeProfileId) return [];
            const msg = error?.message || "未知错误";
            setStatus(typeof statusTexts.failed === "function" ? statusTexts.failed(msg) : statusTexts.failed, "err");
            if (showToast && window.toastr) {
                window.toastr.error(msg);
            }
            return [];
        } finally {
            if (requestVersion === modelRequestVersion) {
                $fetchBtn.prop("disabled", false).text("🔄 获取列表");
            }
        }
    };

    const bind = () => {
        const $select = getById($root, ids.profileSelectId);
        const $add = getById($root, ids.profileAddId);
        const $del = getById($root, ids.profileDeleteId);
        const $fetch = getById($root, ids.fetchModelsId);
        const $name = getById($root, ids.profileNameId);
        const $url = getById($root, ids.apiUrlId);
        const $key = getById($root, ids.apiKeyId);
        const $model = getById($root, ids.modelId);
        const $modelMode = getById($root, ids.modelModeId);
        const $modelInput = getById($root, ids.modelInputId);

        $select.on("change", () => {
            const nextActiveProfileId = String($select.val() || "").trim();
            persistCurrentProfileInputs();
            modelRequestVersion += 1;
            state.activeProfileId = nextActiveProfileId;
            render();
            emitChange();
            const active = findActiveProfile();
            if (active && active.type !== "internal" && modelInputMode !== "manual" && options.autoFetchOnProfileSwitch !== false) {
                setTimeout(() => {
                    fetchModels(false);
                }, 100);
            }
        });

        $add.on("click", (e) => {
            e.preventDefault();
            persistCurrentProfileInputs();
            const profile = typeof options.createProfile === "function"
                ? normalizeProfile(options.createProfile({ state: { ...state } }) || createProfile(), state.profiles.length, defaultModel)
                : createProfile();
            state.profiles.push(profile);
            state.activeProfileId = profile.id;
            render();
            emitChange();
        });

        $del.on("click", (e) => {
            e.preventDefault();
            const active = findActiveProfile();
            if (!active || active.type === "internal" || active.readonly) return;
            if (!window.confirm("删除方案？")) return;
            state.profiles = state.profiles.filter((p) => p.id !== active.id);
            if (state.profiles.length === 0) state.profiles.push(createProfile());
            state.activeProfileId = state.profiles.find((p) => p.type !== "internal")?.id || state.profiles[0]?.id || "";
            render();
            emitChange();
        });

        $name.on("input", persistCurrentProfileInputs);
        $model.on("change", persistCurrentProfileInputs);
        $modelInput.on("input", persistCurrentProfileInputs);
        $modelMode.on("change", () => {
            persistCurrentProfileInputs();
            modelRequestVersion += 1;
            modelInputMode = String($modelMode.val() || "list") === "manual" ? "manual" : "list";
            render();
            setStatus(modelInputMode === "manual" ? statusTexts.manual : statusTexts.default, "muted");
        });
        $url.on("input", () => {
            persistCurrentProfileInputs();
            if (autoFetchTimer) clearTimeout(autoFetchTimer);
            if (options.autoFetchOnInput === true) {
                autoFetchTimer = setTimeout(() => {
                    fetchModels(false);
                }, autoFetchDelay);
            }
        });
        $key.on("input", () => {
            persistCurrentProfileInputs();
            if (autoFetchTimer) clearTimeout(autoFetchTimer);
            if (options.autoFetchOnInput === true) {
                autoFetchTimer = setTimeout(() => {
                    fetchModels(false);
                }, autoFetchDelay);
            }
        });

        $fetch.on("click", (e) => {
            e.preventDefault();
            fetchModels(true);
        });

        render();
        emitChange();
    };

    const setState = (nextState = {}) => {
        modelRequestVersion += 1;
        const nextProfiles = Array.isArray(nextState.profiles) ? nextState.profiles : state.profiles;
        state.profiles = normalizeProfilesWithUniqueIds(nextProfiles, defaultModel);
        state.activeProfileId = String(nextState.activeProfileId || state.activeProfileId || "").trim();
        if (!state.profiles.some((p) => p.id === state.activeProfileId)) {
            state.activeProfileId = state.profiles.find((p) => p.type !== "internal")?.id || state.profiles[0]?.id || "";
        }
        render();
        emitChange();
    };

    const getState = () => ({
        profiles: state.profiles.map((p) => ({ ...p })),
        activeProfileId: state.activeProfileId,
    });

    return {
        bind,
        render,
        setState,
        getState,
        fetchModels,
        persistCurrentProfileInputs,
        setStatus,
    };
}
