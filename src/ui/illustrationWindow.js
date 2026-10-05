import { buildPromptTextFromTheater } from "../core/chatInjector.js";
import { detectIllustrationBackend, generateTheaterIllustration } from "../core/cosmosVisionBridge.js";
import { selectIllustrationScene } from "../core/illustrationScene.js";
import { composeProfileBlock, matchCharacterProfiles, readCharacterProfiles } from "../core/characterProfiles.js";
import { getExtData } from "../utils/storage.js";
import { openIllustrationSettingsWindow } from "./illustrationSettingsWindow.js";
import { openCharacterProfileWindow } from "./characterProfileWindow.js";
import { readSceneIllustrations, saveGeneratedIllustrations, selectSceneIllustration, selectedIllustration } from "../core/illustrationStore.js";
import { escapeIllustrationHtml as escape, illustrationFigure, normalizeIllustrationDraft, normalizeSavedIllustration } from "../core/illustrationData.js";
import { exportAsHtmlFile } from "../utils/helpers.js";
import { claimFloatingWindow, releaseFloatingWindow } from "./shared/floatingWindow.js";

// 选景跑在本插件自己的 LLM 上，生图才交给 Cosmos，所以只有这两个阶段；
// 生图的百分比来自 ComfyUI 的步数回调，NovelAI 非流式则没有进度。
const PROGRESS_LABELS = { selecting: "正在通读正文、选择画面…", generating: "正在生成图片…" };
/** 流式过程图的更新间隔：帧率再高也不值得每帧都换 object URL 并触发重绘。 */
const PREVIEW_THROTTLE_MS = 150;
// 会话与任务都放在模块级：面板关掉后选景与生图继续跑，重新打开同一场景能接着看进度和结果。
const sessions = new Map();
let activeView = null;

function showError(error) {
    return error?.name === "AbortError" || error?.code === "ABORTED"
        ? "已取消等待。后端可能仍在计算；需要时可重新发起。"
        : String(error?.message || "配图操作失败，请重试。");
}

function sessionFor(sceneId, initialText) {
    if (!sessions.has(sceneId)) {
        sessions.set(sceneId, {
            text: initialText || "", request: "", participants: "", draft: null, pending: null,
            previewBlob: null, previousScenes: [], adopted: undefined, notice: "", job: null,
            // 外观档案：profileIds 是勾选态，profileBlocks 记下我们插入过的那几块原文，
            // 取消勾选时只移除仍逐字存在的那块 —— 用户改过的内容永不删除。
            profileIds: [], profileBlocks: {}, profilesInitialized: false,
        });
    }
    return sessions.get(sceneId);
}

function notifyView(sceneId) {
    if (activeView?.sceneId === sceneId) activeView.sync();
}

function jobProgress(job) {
    return event => {
        const label = PROGRESS_LABELS[event.stage] || "正在处理…";
        const percent = Number.isFinite(event.fraction) ? ` ${Math.round(event.fraction * 100)}%` : "";
        job.status = `${label}${percent}`;
        notifyView(job.sceneId);
    };
}

/** 后台任务：只在显式取消或刷新页面时结束，面板关闭不再中断，进度与结果都写回会话。 */
function startJob(current, currentTarget, kind, operation) {
    if (current.job) return current.job;
    const job = { sceneId: currentTarget.sceneId, kind, status: "", phase: "running", controller: new AbortController(), error: null };
    current.job = job;
    current.notice = "";
    job.promise = Promise.resolve()
        .then(() => operation(job))
        .catch(error => { job.error = error; current.notice = showError(error); })
        .finally(() => {
            if (current.job === job) current.job = null;
            if (activeView?.sceneId === job.sceneId) activeView.sync();
            else notifyBackgroundResult(job);
        });
    notifyView(job.sceneId);
    return job;
}

/** 面板关着时任务照样跑完，用一条提示收尾，避免结果静默落在会话里。 */
function notifyBackgroundResult(job) {
    if (!window.toastr) return;
    const titles = { prepare: "场景配图：画面已选好，重新打开配图面板即可继续。", generate: "场景配图：图片已生成并保存。" };
    if (job.error) window.toastr.warning(showError(job.error), "Titania Echo");
    else if (titles[job.kind]) window.toastr.info(titles[job.kind], "Titania Echo");
}

/** 生成成功后立即保存；面板关掉也继续，保存失败时图片留在会话里等「重试保存」。 */
async function persistPending(current, currentTarget) {
    current.record = await saveGeneratedIllustrations(currentTarget.sceneId, current.pending);
    const image = selectedIllustration(current.record);
    await currentTarget.onSelected?.(image);
    current.adopted = image;
    current.pending = null;
    current.notice = "配图已保存。可在下方挑选图片，或沿用提示词重新生成。";
    return current.record;
}

/** target 为固定的正文快照；onSelected 可由收藏页注入，始终操作原收藏。 */
/**
 * 打开场景配图面板。
 * @param {object|object[]} targetOrTargets 固定的正文快照
 * @param {number} [initialIndex] 初始选中的那一轮（从设置窗返回时用来回到同一轮）
 */
export function openIllustrationWindow(targetOrTargets, initialIndex = 0) {
    const targets = Array.isArray(targetOrTargets) ? targetOrTargets : [targetOrTargets];
    if (!targets.length) return;
    const previousFocus = document.activeElement;
    const root = document.createElement("div");
    root.className = "t-root t-illustration-window";
    root.innerHTML = `
        <section class="t-illustration-panel" role="dialog" aria-labelledby="t-illustration-title">
            <div class="t-panel-header">
                <strong id="t-illustration-title">场景配图</strong>
                <div style="display:flex; align-items:center; gap:8px;">
                    <button type="button" class="t-btn" data-action="profiles" title="人物外观档案" aria-label="人物外观档案"><i class="fa-solid fa-address-book"></i></button>
                    <button type="button" class="t-btn" data-action="settings" title="场景配图设置：选景预设" aria-label="场景配图设置"><i class="fa-solid fa-gear"></i></button>
                    <button type="button" class="t-btn" data-action="close" title="关闭配图面板" aria-label="关闭配图面板"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="t-illustration-body">
                <label class="t-illustration-field">配图内容<select class="t-input" data-field="target"></select></label>
                <p class="t-illustration-hint">为选中的这一轮剧场挑选一个画面。切换正文后，本次任务仍属于这里显示的内容。</p>
                <div class="t-illustration-connection"><span data-role="connection">正在检测 Cosmos Vision…</span><button class="t-btn" type="button" data-action="detect">重新检测</button></div>
                <p class="t-illustration-hint">画面由本插件的 API 方案选出；画幅、画风、质量词与预设沿用 Cosmos Vision 的配置，不在这里选择。</p>
                <label class="t-illustration-field">想画什么（可选）<textarea class="t-input" data-field="request" rows="2" placeholder="例如：画雨中重逢的瞬间，远景，偏冷色"></textarea></label>
                <details class="t-illustration-details"><summary>正文与人物资料</summary>
                    <label class="t-illustration-field">本次配图素材<textarea class="t-input" data-field="text" rows="6"></textarea></label>
                    <div class="t-illustration-field">人物外观档案
                        <div class="t-profile-chips" data-role="profiles"></div>
                    </div>
                    <label class="t-illustration-field">人物外观等补充资料（可选）<textarea class="t-input" data-field="participants" rows="3" placeholder="选中的外观档案会自动填到这里，也可以直接手写；留空则完全根据正文选景。"></textarea></label>
                </details>
                <div class="t-illustration-actions"><button class="t-btn primary" type="button" data-action="prepare">分析画面</button><button class="t-btn" type="button" data-action="alternate">换个画面</button></div>
                <div data-role="draft" hidden>
                    <p class="t-illustration-summary" data-role="summary"></p>
                    <p class="t-illustration-hint" data-role="excerpt" hidden></p>
                    <details class="t-illustration-details"><summary>编辑绘画提示词</summary>
                        <p class="t-illustration-hint">这里只写「画面里有什么」。质量词、画师串、画风预设与 LoRA 触发词由 Cosmos Vision 追加，重复填写会叠加。</p>
                        <label class="t-illustration-field">正向提示词<textarea class="t-input" data-field="positive" rows="5"></textarea></label>
                        <label class="t-illustration-field">负向提示词<textarea class="t-input" data-field="negative" rows="3"></textarea></label>
                        <div data-role="characters"></div>
                    </details>
                    <button class="t-btn primary" type="button" data-action="generate">生成图片</button>
                </div>
                <div class="t-illustration-status" role="status" aria-live="polite" data-role="status"></div>
                <div class="t-illustration-actions"><button class="t-btn" type="button" data-action="cancel" hidden>取消等待</button><button class="t-btn" type="button" data-action="save" hidden>重试保存</button></div>
                <div class="t-illustration-preview" data-role="preview" hidden><p class="t-illustration-hint">生成中的过程图，仅供预览。</p><img alt="生成中的预览" data-role="preview-image"></div>
                <div class="t-illustration-pending" data-role="pending" hidden><p>图片已生成，等待保存。</p><img alt="待保存的配图" data-role="pending-image"></div>
                <div class="t-illustration-gallery" data-role="gallery"></div>
            </div>
        </section>`;
    document.body.append(root);
    const field = name => root.querySelector(`[data-field="${name}"]`);
    const role = name => root.querySelector(`[data-role="${name}"]`);
    const action = name => root.querySelector(`[data-action="${name}"]`);
    targets.forEach((target, index) => field("target").add(new Option(target.label || target.scriptName, String(index))));
    let target = targets[0], session, localBusy = false, ready = false, disposed = false;
    let selectionSequence = 0, detectionSequence = 0, pendingUrl = null, renderedDraft, renderedPending;
    // 过程图与「已生成待保存」是两种状态：前者只预览，后者才启用「重试保存」。
    let previewUrl = null, renderedPreviewBlob = null, previewUpdatedAt = 0;
    const isBusy = () => localBusy || Boolean(session?.job);
    // 后台任务通过 activeView 找到当前面板；面板不在时任务照常写会话。
    const view = { sceneId: "", sync: () => refreshFromState() };
    activeView = view;

    function updateControls() {
        const busy = isBusy();
        const job = session?.job;
        root.querySelectorAll("input, textarea, select").forEach(el => { el.disabled = busy; });
        for (const name of ["prepare", "alternate", "generate"]) action(name).disabled = busy || !ready || !session?.record || (name !== "prepare" && !session?.draft);
        action("detect").disabled = busy;
        // 关闭面板不再中断任务，取消只对正在跑的后台任务有意义。
        action("cancel").hidden = !job || job.phase === "saving";
        action("save").hidden = !session?.pending;
        action("save").disabled = busy;
        // 勾选条不在 "input, textarea, select" 里，要单独禁用，
        // 否则任务跑着也能改「人物资料」，字段会与在跑的请求分叉。
        root.querySelectorAll("[data-profile-id]").forEach(el => { el.disabled = busy; });
        root.querySelectorAll("[data-image-id]").forEach(el => { el.disabled = busy; });
        field("target").disabled = busy || targets.length === 1;
    }

    /** 面板内容统一从会话重画；后台任务完成时也走这里。 */
    function refreshFromState() {
        if (disposed || !session) return;
        role("status").textContent = session.job?.status
            || session.notice
            || (session.pending ? "上次生成的图片尚未保存，可以继续保存。" : "");
        // 草稿换了才重画输入框：进度刷新不能冲掉用户正在编辑的提示词。
        if (session.draft !== renderedDraft) { renderedDraft = session.draft; renderDraft(); }
        renderGallery();
    }

    function renderDraft() {
        const draft = session?.draft;
        role("draft").hidden = !draft;
        if (draft) {
            // 摘要可能为空：用户自写的预设未必要求模型返回它，旧存档里也没有。
            // 该 <p> 是常显的，不隐藏就会在面板上留一个空行。
            const summary = draft.scene.summary || "";
            role("summary").hidden = !summary;
            role("summary").textContent = summary;
            const excerpt = draft.scene.sourceExcerpt || "";
            role("excerpt").hidden = !excerpt;
            role("excerpt").textContent = excerpt ? `原文摘录：${excerpt}` : "";
            field("positive").value = draft.prompts.positivePrompt;
            field("negative").value = draft.prompts.negativePrompt;
            role("characters").innerHTML = draft.prompts.characterPrompts.map((character, index) => `
                <fieldset class="t-illustration-character"><legend>人物 ${index + 1}</legend>
                    <label class="t-illustration-field">正向提示词<textarea class="t-input" data-character="${index}" data-key="positivePrompt" rows="2">${escape(character.positivePrompt)}</textarea></label>
                    <label class="t-illustration-field">负向提示词<textarea class="t-input" data-character="${index}" data-key="negativePrompt" rows="2">${escape(character.negativePrompt)}</textarea></label>
                    <div class="t-illustration-coordinates">${["x", "y"].map(axis => `<label>${axis.toUpperCase()} <input class="t-input" type="number" min="0" max="1" step="0.05" data-character="${index}" data-key="${axis}" value="${character.position[axis]}"></label>`).join("")}</div>
                </fieldset>`).join("");
        }
        updateControls();
    }

    function readDraft() {
        const draft = structuredClone(session.draft);
        draft.prompts.positivePrompt = field("positive").value;
        draft.prompts.negativePrompt = field("negative").value;
        root.querySelectorAll("[data-character]").forEach(input => {
            const character = draft.prompts.characterPrompts[Number(input.dataset.character)];
            if (input.dataset.key === "x" || input.dataset.key === "y") character.position[input.dataset.key] = Number(input.value);
            else character[input.dataset.key] = input.value;
        });
        return normalizeIllustrationDraft(draft);
    }

    /**
     * 流式过程图只保留最新一帧，每换一帧都必须回收上一帧的 object URL，
     * 否则长生成会一路泄漏 blob URL。与 session.pending 分开显示：
     * 过程图只是预览，「重试保存」只对真正生成完的待保存图片开放。
     */
    function syncPreview() {
        const blob = session?.previewBlob || null;
        if (blob !== renderedPreviewBlob) {
            if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
            if (blob) previewUrl = URL.createObjectURL(blob);
            renderedPreviewBlob = blob;
        }
        role("preview").hidden = !previewUrl;
        if (previewUrl) role("preview-image").src = previewUrl;
        else role("preview-image").removeAttribute("src");
    }

    // --- 人物外观档案 ---

    /**
     * 档案改动「人物资料」时同步会话与 DOM。
     * 面板里只有 loadTarget 会写这个字段（refreshFromState/renderDraft/renderGallery 都不碰），
     * 所以程序化改值必须两处都写；且**不要**派发 input 事件 —— 那个监听器会把草稿清掉。
     */
    function syncParticipantsField() {
        field("participants").value = session.participants;
    }

    function insertProfileBlock(current, entry) {
        const block = composeProfileBlock(entry);
        if (!block) return;
        current.profileBlocks[entry.id] = block;
        if (!current.profileIds.includes(entry.id)) current.profileIds.push(entry.id);
        const text = String(current.participants || "").trim();
        if (text.includes(block)) return;
        current.participants = text ? `${text}\n\n${block}` : block;
    }

    /** 取消勾选：只有那一块仍逐字存在时才移除；用户已在块内改过就只取消勾选，不动文本。 */
    function removeProfileBlock(current, id) {
        const block = current.profileBlocks[id];
        current.profileIds = current.profileIds.filter(item => item !== id);
        if (!block || !String(current.participants || "").includes(block)) return;
        current.participants = current.participants.replace(block, "").replace(/\n{3,}/g, "\n\n").trim();
    }

    function renderProfileChips() {
        const holder = role("profiles");
        const profiles = readCharacterProfiles(getExtData()).filter(entry => entry.enabled !== false);
        holder.replaceChildren();
        if (!profiles.length) {
            const empty = document.createElement("span");
            empty.className = "t-illustration-hint";
            empty.textContent = "还没有外观档案。可以点「管理外观档案」新建一份，或直接在下方手填。";
            holder.append(empty);
            return;
        }
        for (const entry of profiles) {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "t-profile-chip";
            chip.dataset.profileId = entry.id;
            // 一律 textContent：档案名与角色卡描述都可能含 HTML。
            chip.textContent = entry.name || "未命名角色";
            chip.classList.toggle("is-on", session.profileIds.includes(entry.id));
            chip.disabled = isBusy();
            chip.title = entry.cardKey ? `已绑定角色卡：${entry.cardKey.slice("card:".length)}` : "未绑定角色卡，靠触发词匹配";
            holder.append(chip);
        }
    }

    /** 会话首次建立时自动带入命中的档案；之后只由用户通过勾选条增删。 */
    function applyAutoProfiles(current) {
        if (current.profilesInitialized) return;
        current.profilesInitialized = true;
        const matched = matchCharacterProfiles(readCharacterProfiles(getExtData()), {
            cardKey: target.cardKey,
            // 只用正文匹配。把 participants 也算进去的话，档案自动填入后自己就成了
            // 匹配依据，匹配不再幂等、且依赖操作顺序。
            text: current.text,
        });
        for (const entry of matched) insertProfileBlock(current, entry);
    }

    function renderGallery() {
        const images = session?.record?.images || [];
        role("gallery").innerHTML = images.length ? `<strong>已保存的配图</strong><div class="t-illustration-candidates">${images.map(image => {
            // 摘要可能为空（用户自写的预设未必要求模型返回它），此时不出那个 <p>，免得留个空行。
            const summary = image.draft.scene.summary || "";
            return `
            <article class="t-illustration-candidate">
                <a href="${image.filePath}" target="_blank" rel="noopener"><img src="${image.filePath}" loading="lazy" alt="${escape(summary || "配图")}"></a>
                ${summary ? `<p>${escape(summary)}</p>` : ""}
                <div class="t-illustration-actions"><button class="t-btn" type="button" data-image-id="${escape(image.id)}">${session.record.selectedId === image.id ? "当前配图" : "采用这张"}</button><a class="t-btn" href="${image.filePath}" download>下载</a></div>
            </article>`;
        }).join("")}</div><div class="t-illustration-actions"><button class="t-btn" type="button" data-image-id="">暂不展示配图</button><button class="t-btn" type="button" data-action="export">导出图文 HTML</button></div>` : "";
        if (pendingUrl && session?.pending !== renderedPending) { URL.revokeObjectURL(pendingUrl); pendingUrl = null; }
        if (session?.pending && session.pending !== renderedPending) {
            // 一批里可能有多张（Cosmos 的张数由它自己决定），预览显示采用的那张。
            pendingUrl = URL.createObjectURL(session.pending.images[0].blob);
        }
        renderedPending = session?.pending || null;
        role("pending").hidden = !pendingUrl;
        if (pendingUrl) role("pending-image").src = pendingUrl;
        else role("pending-image").removeAttribute("src");
        syncPreview();
        updateControls();
    }

    /**
     * 探测生图后端。新接口没有能力协商，只能按方法存在性判断是否可用；
     * 具体状态（未安装 / 旧版接口 / 就绪）与文案都由适配层给出。
     */
    function detect() {
        const sequence = ++detectionSequence;
        const state = detectIllustrationBackend();
        if (disposed || sequence !== detectionSequence) return;
        ready = state.ready;
        role("connection").textContent = state.reason;
        updateControls();
    }

    async function loadTarget(index) {
        target = targets[index];
        const sequence = ++selectionSequence;
        const current = target;
        session = sessionFor(current.sceneId, buildPromptTextFromTheater(current.content));
        // 读取记录期间不接受后台任务的界面同步，避免画到半截状态上。
        view.sceneId = "";
        localBusy = true;
        ready = false;
        // 首次进入这个场景时把命中的外观档案填进「人物资料」，之后交给勾选条。
        applyAutoProfiles(session);
        field("text").value = session.text;
        field("request").value = session.request;
        field("participants").value = session.participants;
        renderProfileChips();
        role("status").textContent = "正在读取配图记录…";
        renderDraft();
        try {
            const record = await readSceneIllustrations(current.sceneId);
            if (disposed || sequence !== selectionSequence) return;
            // 收藏持有自己的采用图快照；浏览收藏不会被同源场景的后续换图改变。
            if (Object.hasOwn(current, "illustration")) {
                const adopted = session.adopted === undefined ? current.illustration : session.adopted;
                const saved = adopted ? normalizeSavedIllustration(adopted) : null;
                if (saved && !record.images.some(image => image.id === saved.id)) record.images.push(saved);
                record.selectedId = saved?.id || null;
            }
            session.record = record;
            session.draft ||= selectedIllustration(record)?.draft || null;
            renderDraft();
            renderGallery();
        } catch (error) {
            session.notice = showError(error);
            session.record = null;
        } finally {
            if (!disposed && sequence === selectionSequence) {
                localBusy = false;
                view.sceneId = current.sceneId;
                refreshFromState();
                void detect();
            }
        }
    }

    async function run(operation) {
        if (isBusy()) return;
        localBusy = true;
        updateControls();
        try { await operation(); }
        catch (error) { session.notice = showError(error); }
        finally {
            localBusy = false;
            refreshFromState();
        }
    }

    root.addEventListener("input", event => {
        if (!session) return;
        const key = event.target.dataset.field;
        if (["text", "request", "participants"].includes(key)) {
            session[key] = event.target.value;
            session.draft = null;
            renderDraft();
        }
    });
    root.addEventListener("change", event => {
        if (event.target === field("target")) void loadTarget(Number(event.target.value));
    });
    root.addEventListener("click", event => {
        const button = event.target.closest("button");
        if (!button || button.disabled) return;
        const operation = button.dataset.action;
        if (operation === "close") { close(); return; }
        if (operation === "cancel") { session?.job?.controller.abort(); return; }
        if (operation === "detect") {
            if (!session?.record) void loadTarget(Number(field("target").value));
            else void detect();
            return;
        }
        if (operation === "settings") {
            const index = Number(field("target").value) || 0;
            // 设置窗/档案窗关掉后回到本面板，且回到同一轮：会话按 sceneId 复用，
            // 草稿、人物资料、画廊与正在跑的任务都还在。
            openIllustrationSettingsWindow({ onClose: () => openIllustrationWindow(targets, index) });
            return;
        }
        if (operation === "profiles") {
            const index = Number(field("target").value) || 0;
            openCharacterProfileWindow({ onClose: () => openIllustrationWindow(targets, index) });
            return;
        }
        const current = session, currentTarget = target;
        if (button.dataset.profileId) {
            const id = button.dataset.profileId;
            const entry = readCharacterProfiles(getExtData()).find(item => item.id === id);
            if (!entry) return;
            if (current.profileIds.includes(id)) removeProfileBlock(current, id);
            else insertProfileBlock(current, entry);
            syncParticipantsField();
            renderProfileChips();
            updateControls();
            return;
        }
        if (operation === "save") {
            void run(async () => { await persistPending(current, currentTarget); });
            return;
        }
        if (operation === "export") {
            void run(async () => {
                await exportAsHtmlFile(currentTarget.content + illustrationFigure(selectedIllustration(current.record)), currentTarget.scriptName);
                current.notice = "图文 HTML 已导出。";
            });
            return;
        }
        if (operation === "prepare" || operation === "alternate") {
            if (current.pending) { role("status").textContent = "请先保存上次生成的图片。"; return; }
            const alternate = operation === "alternate";
            // 素材与「换个画面」的历史在点击时固定，面板随后关掉也不影响这次任务。
            const request = {
                theaterText: current.text,
                participants: current.participants,
                specialRequest: current.request,
                ...(alternate ? { previousScenes: current.previousScenes.slice(-6) } : {}),
            };
            startJob(current, currentTarget, "prepare", async job => {
                job.status = PROGRESS_LABELS.selecting;
                notifyView(job.sceneId);
                // 选景走本插件自己的 API 方案（默认跟随当前激活方案），不再依赖 Cosmos 的提示词 LLM。
                const draft = await selectIllustrationScene(request, { signal: job.controller.signal });
                current.draft = draft;
                // 连同正面提示词一起存：用户自写的预设可能不返回摘要，formatPreviousScenes
                // 要回落到它才能拼出「已经选过的画面」。draft.scene 本身不含这个字段。
                current.previousScenes.push({ ...draft.scene, positivePrompt: draft.prompts.positivePrompt });
                // 摘录被丢弃时说一句：面板上没有摘录行，既可能是模型没给，也可能是它编的
                // 那段对不上正文，不区分的话用户只会以为这个功能坏了。
                current.notice = draft.excerptDropped
                    ? "画面已选好，但模型给的原文摘录与正文对不上，已丢弃。可以展开修改提示词，再生成图片。"
                    : "画面已选好。可以展开修改提示词，再生成图片。";
            });
            return;
        }
        if (operation === "generate") {
            if (!current?.draft || current.pending) {
                role("status").textContent = current?.pending ? "请先保存上次生成的图片。" : "";
                return;
            }
            let draft;
            try { draft = readDraft(); } catch (error) { role("status").textContent = showError(error); return; }
            current.draft = draft;
            startJob(current, currentTarget, "generate", async job => {
                job.status = PROGRESS_LABELS.generating;
                notifyView(job.sceneId);
                try {
                    const result = await generateTheaterIllustration(draft, {
                        signal: job.controller.signal,
                        onProgress: jobProgress(job),
                        // NovelAI 流式会推过程图；非流式与 ComfyUI 不会走到这里。
                        onStreamPreview: event => {
                            if (!event.blob) return;
                            const now = Date.now();
                            if (now - previewUpdatedAt < PREVIEW_THROTTLE_MS) return;
                            previewUpdatedAt = now;
                            current.previewBlob = event.blob;
                            notifyView(job.sceneId);
                        },
                    });
                    // Cosmos 的张数由它自己的设置决定，调用方无法强制 1 张，所以成批入库。
                    current.pending = { images: result.images, draft, createdAt: Date.now() };
                    job.phase = "saving";
                    job.status = "正在保存配图…";
                    notifyView(job.sceneId);
                    await persistPending(current, currentTarget);
                    if (result.dropped) current.notice += ` 本次返回 ${result.images.length + result.dropped} 张，超过上限的 ${result.dropped} 张未保存。`;
                } finally {
                    // 过程图不跨任务留存，否则失败后旧帧会一直挂在界面上。
                    current.previewBlob = null;
                }
            });
            return;
        }
        if (button.hasAttribute("data-image-id")) {
            void run(async () => {
                const id = button.dataset.imageId || null;
                const image = current.record.images.find(item => item.id === id);
                current.record = await selectSceneIllustration(currentTarget.sceneId, id, image);
                current.adopted = selectedIllustration(current.record);
                await currentTarget.onSelected?.(current.adopted);
                if (image) current.draft = image.draft;
                current.notice = id ? "已更换当前配图。" : "已隐藏当前配图，已保存的图片仍可重新采用。";
            });
        }
    });

    function close() {
        // 关闭只解除界面绑定：选景与生图在后台继续，结果留在会话里等下次打开。
        if (session?.draft && !isBusy()) {
            try { session.draft = readDraft(); } catch { /* 未完成的输入不覆盖有效草稿。 */ }
        }
        disposed = true;
        if (activeView === view) activeView = null;
        if (pendingUrl) URL.revokeObjectURL(pendingUrl);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        root.remove();
        // 新版公开接口只派发这一个事件；能力变化事件已经不存在了。
        window.removeEventListener("cosmos-vision:api-ready", detect);
        window.removeEventListener("titania:character-profiles-changed", profilesChanged);
        releaseFloatingWindow(close);
        if (previousFocus?.isConnected) previousFocus.focus();
        // 待保存图片与后台任务保留在内存，关窗后重新打开可以继续；普通会话保持有界。
        for (const [key, value] of sessions) {
            if (sessions.size <= 20) break;
            if (!value.pending && !value.job && key !== target.sceneId) sessions.delete(key);
        }
    }
    claimFloatingWindow(close);
    // Cosmos 加载完成会派发 api-ready；用户手动装好扩展后也能靠「重新检测」补上。
    window.addEventListener("cosmos-vision:api-ready", detect);
    // 档案管理窗口改完就通知面板重画勾选条，不必重开面板。
    const profilesChanged = () => { if (!disposed) { renderProfileChips(); updateControls(); } };
    window.addEventListener("titania:character-profiles-changed", profilesChanged);
    void loadTarget(Math.min(Math.max(0, Number(initialIndex) || 0), targets.length - 1));
    action("close").focus();
}

const SCENE_ILLUSTRATION_SELECTOR = "[data-titania-illustration],[data-titania-illustration-notice]";

/** 正文内容根：优先 Shadow DOM 内容节点，回退到光 DOM 容器。 */
function findSceneContentRoot(container) {
    return container.querySelector(".t-shadow-host")?.shadowRoot?.querySelector(".t-shadow-content") || container;
}

function clearSceneIllustration(root) {
    root?.querySelectorAll(SCENE_ILLUSTRATION_SELECTOR).forEach(node => node.remove());
}

function hasSceneIllustration(root) {
    return Boolean(root?.querySelector(SCENE_ILLUSTRATION_SELECTOR));
}

function buildSceneIllustrationNotice(message) {
    const notice = document.createElement("p");
    notice.setAttribute("data-titania-illustration-notice", "");
    notice.style.cssText = "margin:16px 0;text-align:center;font-size:13px;opacity:0.75";
    notice.textContent = message;
    return notice;
}

/**
 * 采用的配图放在正文开头，与正文一同渲染。
 * 流式重绘会连配图一起清掉，这里按缓存补回；原始正文与续写输入始终是纯文本。
 */
export function bindMainIllustrations(getTarget) {
    const content = document.getElementById("t-output-content");
    if (!content) return () => {};
    let disposed = false, sequence = 0, timer;
    let currentKey = "", currentImage = null, currentError = "";

    function draw() {
        const root = findSceneContentRoot(content);
        if (!root) return;
        clearSceneIllustration(root);
        if (currentImage) {
            const holder = document.createElement("div");
            holder.innerHTML = illustrationFigure(currentImage);
            const figure = holder.firstElementChild;
            if (figure) {
                // 配图放在正文开头，跟着正文一起渲染。
                root.prepend(figure);
                return;
            }
        }
        if (currentError) root.prepend(buildSceneIllustrationNotice(currentError));
    }

    const refresh = async (force = false) => {
        let target;
        try { target = getTarget(); } catch { target = null; }
        const key = target?.sceneId || "";
        // 同一轮次且配图仍在正文里时无需重画；流式重绘清掉配图后由这里补回。
        if (!force && key === currentKey && (!key || hasSceneIllustration(findSceneContentRoot(content)))) return;
        if (force || key !== currentKey) {
            currentKey = key;
            currentImage = null;
            currentError = "";
            const request = ++sequence;
            if (key) {
                try {
                    const record = await readSceneIllustrations(key);
                    if (disposed || request !== sequence) return;
                    currentImage = selectedIllustration(record);
                } catch {
                    if (disposed || request !== sequence) return;
                    currentError = "配图读取失败，可打开场景配图面板重试。";
                }
            } else if (disposed || request !== sequence) return;
        }
        if (!disposed) draw();
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 80); };
    const observer = new MutationObserver(schedule);
    observer.observe(content, { childList: true, subtree: true });
    // Shadow DOM 更新不会冒泡到宿主观察器；渲染器显式通知完成/流式状态。
    window.addEventListener("titania:scene-rendered", schedule);
    const changed = () => void refresh(true);
    window.addEventListener("titania:illustrations-changed", changed);
    void refresh(true);
    return () => {
        disposed = true;
        clearTimeout(timer);
        observer.disconnect();
        window.removeEventListener("titania:scene-rendered", schedule);
        window.removeEventListener("titania:illustrations-changed", changed);
        clearSceneIllustration(findSceneContentRoot(content));
    };
}
