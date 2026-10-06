import { buildPromptTextFromTheater } from "../core/chatInjector.js";
import { detectIllustrationBackend, generateTheaterIllustration } from "../core/cosmosVisionBridge.js";
import { resolveActiveBackendId, subscribeBackendReady } from "../core/illustrationBackends/registry.js";
import { selectIllustrationScene } from "../core/illustrationScene.js";
import { composeProfileBlock, matchCharacterProfiles, readCharacterProfiles } from "../core/characterProfiles.js";
import { getExtData } from "../utils/storage.js";
import { openIllustrationSettingsWindow } from "./illustrationSettingsWindow.js";
import { openCharacterProfileWindow } from "./characterProfileWindow.js";
import { deleteSceneIllustrations, readSceneIllustrations, saveGeneratedIllustrations, selectSceneIllustration, selectedIllustration } from "../core/illustrationStore.js";
import { findReferencedIllustrationPaths } from "../core/illustrationReferences.js";
import { escapeIllustrationHtml as escape, illustrationFigure, normalizeIllustrationDraft, normalizeSavedIllustration } from "../core/illustrationData.js";
import { exportAsHtmlFile } from "../utils/helpers.js";
import { claimFloatingWindow, releaseFloatingWindow } from "./shared/floatingWindow.js";
import { createHelpTip } from "./shared/helpPopover.js";
import { createIllustrationBadge } from "./illustrationBadge.js";
import { openIllustrationLightbox } from "./illustrationLightbox.js";
import {
    clearIllustrationActivity, getIllustrationActivity,
    setIllustrationActivity, subscribeIllustrationActivity,
} from "../core/illustrationActivity.js";

// 选景跑在本插件自己的 LLM 上，生图才交给 Cosmos，所以只有这两个阶段；
// 生图的百分比来自 ComfyUI 的步数回调，NovelAI 非流式则没有进度。
const PROGRESS_LABELS = { selecting: "正在通读正文、选择画面…", generating: "正在生成图片…" };
/** 流式过程图的更新间隔：帧率再高也不值得每帧都换 object URL 并触发重绘。 */
const PREVIEW_THROTTLE_MS = 150;

/**
 * 顶栏问号里的**静态**说明：永远成立的那些解释性文字。
 *
 * 条件性的提示一律留在原地 —— 「当前后端把人物位置固定在画面中心」「这次没用上分人物
 * 提示词」「保存失败请重试」只在该出现的那一刻出现；收进这里等于用户最需要看到它时看不到。
 * 判断标准：这句话对任何一轮配图都成立吗？成立才放这里。
 */
const PANEL_HELP = [
    {
        heading: "怎么用",
        lines: [
            "选一轮剧场内容 → 「分析画面」挑出适合落笔的瞬间 → 可以改提示词 → 「生成图片」。",
            "「换个画面」会重新选景，并把此前选过的画面作为排除参考。",
            "排除只是要求，不是保证：正文里若只有一个可落笔的瞬间，模型可以复用同一幅 —— 真复用了面板会明说。想指定画面就写进「本次额外要求」，它优先于选景要求。",
            "切换正文不改变任务归属：正在跑的那次仍属于发起时的那一轮内容。",
        ],
    },
    {
        heading: "提示词只写「画面里有什么」",
        lines: [
            "质量词、画师串、画风预设、LoRA 触发词与画幅采样器一律由生图后端追加，这里再写一遍就会重复叠加。",
            "所以面板里显示的提示词不等于最终发给后端的内容。",
            "画面张数与图源同样由后端决定：用哪个模型、出几张，小剧场都无法指定。",
        ],
    },
    {
        heading: "生图后端",
        lines: [
            "在「场景配图设置」里切换；顶栏下方的状态行显示它当前是否可用。",
            "草稿落盘时会记下当时用的后端，所以换后端重画不用重新选景。",
            "后端卸载后，已保存图片的浏览、采用、下载与导出都不受影响，只有再点「生成图片」才会报错。",
        ],
    },
    {
        heading: "人物外观档案",
        lines: [
            "顶栏的通讯录图标。为角色记一次外观，之后进这个角色的配图会自动带上。",
            "命中的档案会填进「人物资料」并预勾选；你手打的内容永远不会被覆盖。",
        ],
    },
];
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
            // 画幅：只给支持指定画幅的后端显示。与 request/participants 同为会话级
            //（草稿 DTO 不记它，刷新页面后重开会丢）。
            size: "",
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

/** 任务类型 → 进行态阶段。选景与生图在主界面按钮上是两种说法。 */
function activityPhaseFor(kind) {
    return kind === "prepare" ? "selecting" : "generating";
}

/**
 * 两次选景是不是同一幅画面。取值优先级与 illustrationPresets 的 formatPreviousScenes 一致
 * （摘要 → 摘录 → 提示词），否则刚推进排除表的那一条与下次比对的键对不上。
 */
function sceneIdentity(entry) {
    return String(entry?.summary || entry?.sourceExcerpt || entry?.positivePrompt || "").trim();
}

/**
 * 模型有没有听「换一个」。选景要求说的是「选**唯一一个最适合**的瞬间」，正文不变时它
 * 完全可能给出同一个答案；不说一声的话，用户看到的就是一模一样的摘要，只会以为功能坏了。
 */
function repeatsPreviousScene(previousScenes, picked) {
    const key = sceneIdentity(picked);
    return Boolean(key) && previousScenes.some(item => sceneIdentity(item) === key);
}

function jobProgress(job) {
    return event => {
        const label = PROGRESS_LABELS[event.stage] || "正在处理…";
        const percent = Number.isFinite(event.fraction) ? ` ${Math.round(event.fraction * 100)}%` : "";
        job.status = `${label}${percent}`;
        // 关窗后台跑时，主界面那个按钮是用户唯一能看到进度的地方。
        setIllustrationActivity(job.sceneId, activityPhaseFor(job.kind), job.status);
        notifyView(job.sceneId);
    };
}

/** 后台任务：只在显式取消或刷新页面时结束，面板关闭不再中断，进度与结果都写回会话。 */
function startJob(current, currentTarget, kind, operation) {
    if (current.job) return current.job;
    const job = { sceneId: currentTarget.sceneId, kind, status: "", phase: "running", controller: new AbortController(), error: null };
    current.job = job;
    current.notice = "";
    const phase = activityPhaseFor(kind);
    setIllustrationActivity(job.sceneId, phase, PROGRESS_LABELS[phase] || "");
    job.promise = Promise.resolve()
        .then(() => operation(job))
        .catch(error => {
            job.error = error;
            current.notice = showError(error);
            // 取消不是失败：把按钮收回静止，别让它一直转着。
            if (error?.name === "AbortError" || error?.code === "ABORTED") clearIllustrationActivity(job.sceneId);
            else setIllustrationActivity(job.sceneId, "error", current.notice);
        })
        .finally(() => {
            if (current.job === job) current.job = null;
            if (!job.error) clearIllustrationActivity(job.sceneId);
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
    // 这里自报进行态，因为它也能从「重试保存」那条独立路径进来（不经过 startJob）。
    setIllustrationActivity(currentTarget.sceneId, "saving", "正在保存配图…");
    try {
        current.record = await saveGeneratedIllustrations(currentTarget.sceneId, current.pending);
    } catch (error) {
        setIllustrationActivity(currentTarget.sceneId, "error", showError(error));
        throw error;
    }
    const image = selectedIllustration(current.record);
    await currentTarget.onSelected?.(image);
    current.adopted = image;
    current.pending = null;
    current.notice = "配图已保存。可在下方挑选图片，或沿用提示词重新生成。";
    // 清掉进行态：保存成功后 mutateScene 会派发 titania:illustrations-changed，
    // 按钮随之换成「有图」的样子。
    clearIllustrationActivity(currentTarget.sceneId);
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
                <div class="t-panel-header-actions" data-role="header-actions">
                    <button type="button" class="t-btn" data-action="profiles" title="人物外观档案" aria-label="人物外观档案"><i class="fa-solid fa-address-book"></i></button>
                    <button type="button" class="t-btn" data-action="settings" title="场景配图设置：选景预设" aria-label="场景配图设置"><i class="fa-solid fa-gear"></i></button>
                    <button type="button" class="t-btn" data-action="close" title="关闭配图面板" aria-label="关闭配图面板"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="t-illustration-body">
                <label class="t-illustration-field">配图内容<select class="t-input" data-field="target"></select></label>
                <div class="t-illustration-connection"><span data-role="connection">正在检测生图后端…</span><button class="t-btn" type="button" data-action="detect">重新检测</button></div>
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
                        <label class="t-illustration-field" data-role="size-field" hidden>画幅<select class="t-input" data-field="size">
                            <option value="">默认（由后端决定）</option>
                            <option value="portrait">竖幅</option>
                            <option value="landscape">横幅</option>
                        </select></label>
                        <label class="t-illustration-field">正向提示词<textarea class="t-input" data-field="positive" rows="5"></textarea></label>
                        <label class="t-illustration-field">负向提示词<textarea class="t-input" data-field="negative" rows="3"></textarea></label>
                        <p class="t-illustration-hint" data-role="negative-hint" hidden></p>
                        <div data-role="characters"></div>
                        <p class="t-illustration-hint" data-role="characters-hint" hidden></p>
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
    // 静态说明统一收进顶栏的问号，界面本身只留操作。
    const help = createHelpTip({ title: "场景配图", sections: PANEL_HELP });
    role("header-actions").insertBefore(help.root, action("close"));
    targets.forEach((target, index) => field("target").add(new Option(target.label || target.scriptName, String(index))));
    let target = targets[0], session, localBusy = false, ready = false, disposed = false;
    // 当前生图后端由设置决定；能力（人物位置 / 负面词 / 指定画幅）由适配层按后端推导，
    // 未就绪时为 null —— 那表示「还不知道」，界面保持原样而不是瞎猜。
    let activeBackendId = "cosmos", activeCapabilities = null;
    let unsubscribeBackends = () => { };
    let selectionSequence = 0, detectionSequence = 0, pendingUrl = null, renderedDraft, renderedPending;
    // 「管理」多选态的 UI 状态。放面板局部而不是 session：它们是临时的界面状态，
    // 关窗即弃，不该跟着会话留存。loadTarget 时会重置。
    let managing = false;
    const selectedImageIds = new Set();
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
        // 管理模式的工具栏按钮不带 data-image-id，要单独禁；勾选框已被上面那条
        // "input, textarea, select" 覆盖。
        root.querySelectorAll("[data-image-id], [data-manage-control]").forEach(el => { el.disabled = busy; });
        // ⚠ 批量删除的禁用态还要看勾选数，不能只跟 busy 走 —— 上面那条 forEach 会把
        //   渲染时写下的 disabled 一并冲掉，于是"一张没选"时按钮又变成可点的了。
        const bulk = root.querySelector('[data-action="delete-selected-images"]');
        if (bulk) bulk.disabled = busy || selectedImageIds.size === 0;
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
        // characters 的 innerHTML 会把 X/Y 节点整个重建，所以能力收起要在这之后再做一遍。
        renderCapabilities();
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
        // 后台任务可能同时增删图片，把已经不在的勾选剔掉，免得计数虚高、删除时报"找不到"。
        for (const id of [...selectedImageIds]) if (!images.some(image => image.id === id)) selectedImageIds.delete(id);

        const toolbar = managing
            ? `<div class="t-illustration-gallery-bar">
                    <span class="t-illustration-select-count">已选择 ${selectedImageIds.size} 张</span>
                    <button class="t-btn" type="button" data-manage-control data-action="select-all-images">全选</button>
                    <button class="t-btn" type="button" data-manage-control data-action="deselect-all-images">取消全选</button>
                    <button class="t-btn t-btn-danger" type="button" data-manage-control data-action="delete-selected-images" ${selectedImageIds.size ? "" : "disabled"}>删除选中</button>
                    <button class="t-btn" type="button" data-manage-control data-action="exit-manage-images">退出管理</button>
                </div>`
            : `<div class="t-illustration-gallery-bar"><button class="t-btn" type="button" data-manage-control data-action="enter-manage-images">管理</button></div>`;

        role("gallery").innerHTML = images.length ? `<strong>已保存的配图</strong>${toolbar}<div class="t-illustration-candidates">${images.map(image => {
            // 摘要可能为空（用户自写的预设未必要求模型返回它），此时不出那个 <p>，免得留个空行。
            const summary = image.draft.scene.summary || "";
            const picked = selectedImageIds.has(image.id);
            return `
            <article class="t-illustration-candidate${picked ? " is-selected" : ""}">
                ${managing ? `<label class="t-illustration-select"><input type="checkbox" data-select-image-id="${escape(image.id)}" ${picked ? "checked" : ""}> 选择</label>` : ""}
                <a href="${image.filePath}" target="_blank" rel="noopener"><img src="${image.filePath}" loading="lazy" alt="${escape(summary || "配图")}"></a>
                ${summary ? `<p>${escape(summary)}</p>` : ""}
                <div class="t-illustration-actions"><button class="t-btn" type="button" data-image-id="${escape(image.id)}">${session.record.selectedId === image.id ? "当前配图" : "采用这张"}</button><a class="t-btn" href="${image.filePath}" download>下载</a>${managing ? "" : `<button class="t-btn t-btn-danger" type="button" data-action="delete-image" data-image-id="${escape(image.id)}" title="删除这张配图" aria-label="删除这张配图"><i class="fa-solid fa-trash"></i></button>`}</div>
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
     * 删除若干张配图：先报清后果，再写回收藏快照，最后才真删。
     *
     * ⚠ 顺序：收藏写回必须**早于** deleteSceneIllustrations —— 引用扫描不能把
     *   我们马上要清掉的那个收藏算进去，否则那个文件会永远留着成为孤儿。
     *   写回抛错时直接中止，此时什么都还没删。
     */
    async function deleteImages(targets) {
        if (!targets.length) return;
        const current = session, currentTarget = target;
        const ids = new Set(targets.map(item => String(item.id)));
        const wasAdopted = ids.has(String(current.record?.selectedId));

        role("status").textContent = "正在检查图片引用…";
        let reference;
        try {
            reference = await findReferencedIllustrationPaths(targets.map(item => item.filePath), {
                excludeFavoriteId: currentTarget.favoriteId,
            });
        } finally {
            if (!disposed) role("status").textContent = "";
        }

        const lines = [targets.length > 1
            ? `确定删除选中的 ${targets.length} 张配图？此操作不可撤销。`
            : "确定删除这张配图？此操作不可撤销。"];
        if (reference.favoriteReferenced.size) lines.push(`其中 ${reference.favoriteReferenced.size} 张仍被收藏引用，图片文件会保留。`);
        if (wasAdopted) lines.push("这是当前采用的配图，删除后会改用剩余的第一张。");
        if (reference.incomplete) lines.push("有收藏正文读取失败，为避免误删，本次不会删除任何图片文件。");
        if (!confirm(lines.join(""))) return;

        // 收藏快照：采用图被删时要跟着更新/清掉，否则下次 loadTarget 会把它重新注入，图"复活"。
        // 传 null 走 favsWindow 的 delete 分支，快照字段直接消失。
        if (Object.hasOwn(currentTarget, "illustration") && wasAdopted) {
            const remaining = current.record.images.filter(image => !ids.has(String(image.id)));
            await currentTarget.onSelected?.(remaining[0] || null);
        }

        const result = await deleteSceneIllustrations(currentTarget.sceneId, targets, {
            collectReferenced: paths => findReferencedIllustrationPaths(paths).then(found => found.referenced),
        });
        current.record = result.record;
        current.adopted = selectedIllustration(result.record);
        // ⚠ 刻意**不**把 session.draft 换成接位那张的草稿：删除不是采用，
        //   静默替换用户改过的提示词很意外。
        selectedImageIds.clear();
        managing = false;
        const bits = [`已删除 ${result.removedIds.length} 张配图`];
        if (result.deletedFiles.length) bits.push(`删除文件 ${result.deletedFiles.length} 个`);
        if (result.keptReferenced.length) bits.push(`${result.keptReferenced.length} 个文件仍被引用已保留`);
        if (result.failedFiles.length) bits.push(`${result.failedFiles.length} 个文件删除失败`);
        current.notice = `${bits.join("，")}。`;
    }

    /**
     * 按当前后端的能力收起 / 标注对不上的控件。
     *
     * 只在**就绪**时降级 —— 后端还没装好就说「它不支持人物位置」是瞎猜，
     * 而且用户往往想先把提示词写好再去装插件。
     * 位置值本身留在草稿里不动，切回支持它的后端就还在。
     */
    function renderCapabilities() {
        const caps = activeCapabilities;
        const coordinates = root.querySelectorAll(".t-illustration-coordinates");
        if (!caps) {
            role("size-field").hidden = true;
            role("negative-hint").hidden = true;
            role("characters-hint").hidden = true;
            role("characters").hidden = false;
            coordinates.forEach(node => { node.hidden = false; });
            return;
        }
        role("size-field").hidden = !caps.size;
        coordinates.forEach(node => { node.hidden = !caps.characterPositions; });
        role("characters").hidden = !caps.characterPrompts;

        // 分人物提示词与人物位置是两件事：整块不支持时别提位置，免得说了半句。
        const characterHint = !caps.characterPrompts
            ? "当前生图后端不支持分人物提示词，这一部分不会进入提示词。"
            : !caps.characterPositions
                ? "当前生图后端把人物位置固定在画面中心，X / Y 不会生效。"
                : "";
        role("characters-hint").hidden = !characterHint;
        role("characters-hint").textContent = characterHint;

        const negativeHint = caps.negativePrompt
            ? ""
            : "当前生图后端在 NovelAI 下使用你渠道配置的负向词，这里填写的不会生效。";
        role("negative-hint").hidden = !negativeHint;
        role("negative-hint").textContent = negativeHint;
    }

    /**
     * 探测当前生图后端。后端由设置决定，状态与文案（未安装 / 旧版接口 /
     * 没配好 / 已连接）由适配层给出。
     */
    function detect() {
        const sequence = ++detectionSequence;
        // 每次都重读设置：在设置窗里换过后端，回到面板点「重新检测」就能生效。
        activeBackendId = resolveActiveBackendId(getExtData());
        const state = detectIllustrationBackend(activeBackendId);
        if (disposed || sequence !== detectionSequence) return;
        ready = state.ready;
        activeCapabilities = state.ready ? state.capabilities : null;
        role("connection").textContent = state.reason;
        renderCapabilities();
        updateControls();
    }

    async function loadTarget(index) {
        target = targets[index];
        const sequence = ++selectionSequence;
        const current = target;
        session = sessionFor(current.sceneId, buildPromptTextFromTheater(current.content));
        // 换轮次时退出管理模式：勾选是上一轮的，留着只会误删。
        managing = false;
        selectedImageIds.clear();
        // 后端可能在设置窗里被换过，每次载入重新读一次；探测在 finally 里做。
        activeBackendId = resolveActiveBackendId(getExtData());
        // 读取记录期间不接受后台任务的界面同步，避免画到半截状态上。
        view.sceneId = "";
        localBusy = true;
        ready = false;
        // 首次进入这个场景时把命中的外观档案填进「人物资料」，之后交给勾选条。
        applyAutoProfiles(session);
        field("text").value = session.text;
        field("request").value = session.request;
        field("participants").value = session.participants;
        field("size").value = session.size || "";
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
            // 「换个画面」靠内存里的历史排除已选过的画面，刷新页面就没了。用记录里当前采用的那一幅
            // 补种，否则重开页面后点「换个画面」不带任何排除信息，模型会把同一幅原样再选一次。
            if (!session.previousScenes.length && session.draft?.scene) {
                session.previousScenes.push({ ...session.draft.scene, positivePrompt: session.draft.prompts?.positivePrompt || "" });
            }
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
        if (event.target === field("target")) { void loadTarget(Number(event.target.value)); return; }
        // 画幅是会话级的，不进草稿 —— 与「想画什么」「人物资料」同一种输入。
        if (event.target === field("size")) { session.size = event.target.value; return; }
        // 多选：重画一次以更新计数与「删除选中」的禁用态。
        const selectId = event.target.dataset?.selectImageId;
        if (selectId) {
            if (event.target.checked) selectedImageIds.add(selectId);
            else selectedImageIds.delete(selectId);
            renderGallery();
        }
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
        // ⚠ 删除相关的分支必须全部排在最下面那个 `hasAttribute("data-image-id")` 处理器**之前**：
        //   那个处理器按属性存在性派发，不是按 data-action 相等。单张删除按钮同时带着
        //   data-image-id（那样 updateControls 才会在忙时禁用它），一旦落到它手里就成了「采用这张」。
        if (operation === "delete-image") {
            void run(async () => {
                const id = button.dataset.imageId;
                const image = current.record?.images.find(item => String(item.id) === String(id));
                if (image) await deleteImages([image]);
            });
            return;
        }
        if (operation === "enter-manage-images") { managing = true; selectedImageIds.clear(); renderGallery(); return; }
        if (operation === "exit-manage-images") { managing = false; selectedImageIds.clear(); renderGallery(); return; }
        if (operation === "select-all-images" || operation === "deselect-all-images") {
            selectedImageIds.clear();
            if (operation === "select-all-images") (current.record?.images || []).forEach(image => selectedImageIds.add(image.id));
            renderGallery();
            return;
        }
        if (operation === "delete-selected-images") {
            void run(async () => {
                const targets = (current.record?.images || []).filter(image => selectedImageIds.has(image.id));
                if (targets.length) await deleteImages(targets);
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
                const picked = { ...draft.scene, positivePrompt: draft.prompts.positivePrompt };
                const repeated = alternate && repeatsPreviousScene(current.previousScenes, picked);
                current.previousScenes.push(picked);
                // 摘录被丢弃时说一句：面板上没有摘录行，既可能是模型没给，也可能是它编的
                // 那段对不上正文，不区分的话用户只会以为这个功能坏了。
                current.notice = repeated
                    // 「本次额外要求」是唯一能压过选景要求的入口（选景要求里写着它优先），
                    // 所以重复时给的是这条出路，而不是让用户反复点同一个按钮。
                    ? "模型又选了同一幅画面，多半是正文里只有一个可落笔的瞬间。想指定别的画面，写进「本次额外要求」。"
                    : draft.excerptDropped
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
            // 分派依据是草稿自己记的 backend。用户换了后端设置就重新盖章 ——
            // 提示词是后端无关的（只有内容、没有风格），所以换后端重画不必重新选景。
            if (draft.backend !== activeBackendId) draft = normalizeIllustrationDraft({ ...draft, backend: activeBackendId });
            current.draft = draft;
            startJob(current, currentTarget, "generate", async job => {
                job.status = PROGRESS_LABELS.generating;
                notifyView(job.sceneId);
                try {
                    const result = await generateTheaterIllustration(draft, {
                        signal: job.controller.signal,
                        onProgress: jobProgress(job),
                        size: current.size || undefined,
                        // 只有流式的后端会推过程图（Cosmos + NovelAI）；其余不会走到这里。
                        onStreamPreview: event => {
                            if (!event.blob) return;
                            const now = Date.now();
                            if (now - previewUpdatedAt < PREVIEW_THROTTLE_MS) return;
                            previewUpdatedAt = now;
                            current.previewBlob = event.blob;
                            notifyView(job.sceneId);
                        },
                    });
                    // 张数由后端自己决定（Cosmos 按它的 imageCount，柏宝绘一次一张），成批入库。
                    // seed 是后端报回来的实际种子，存下来才能照原样复现这一张。
                    current.pending = { images: result.images, draft, seed: result.seed, createdAt: Date.now() };
                    job.phase = "saving";
                    job.status = "正在保存配图…";
                    notifyView(job.sceneId);
                    await persistPending(current, currentTarget);
                    if (result.dropped) current.notice += ` 本次返回 ${result.images.length + result.dropped} 张，超过上限的 ${result.dropped} 张未保存。`;
                    // 用户填了分人物提示词、后端却没用上（通常是模型/后端不支持）：如实说一句，
                    // 否则他只会以为画面画错了。不降级把角色拼进正向提示词 —— 那会画出多份重叠躯干。
                    const wantsCharacters = draft.prompts.characterPrompts.some(character => character.positivePrompt.trim());
                    if (wantsCharacters && result.applied?.characters === false) {
                        current.notice += " 本次未使用分人物提示词（当前后端或模型不支持），画面按整幅描述生成。";
                    }
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
        // 退掉所有已注册后端的就绪事件，别让关掉的面板继续被通知。
        unsubscribeBackends();
        // 说明气泡打开时在 document 上挂了关闭监听，随窗口一起收掉，否则会一直累积。
        help.close();
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
    // 订阅**所有**已注册后端的就绪事件：插件加载顺序不固定，我们可能比它先跑起来。
    // 用户手动装好后也能靠「重新检测」补上。
    unsubscribeBackends = subscribeBackendReady(() => detect());
    // 档案管理窗口改完就通知面板重画勾选条，不必重开面板。
    const profilesChanged = () => { if (!disposed) { renderProfileChips(); updateControls(); } };
    window.addEventListener("titania:character-profiles-changed", profilesChanged);
    void loadTarget(Math.min(Math.max(0, Number(initialIndex) || 0), targets.length - 1));
    action("close").focus();
}

/**
 * 主界面的配图入口：内容区底部中间那个按钮 + 灯箱。
 *
 * 图片**不再插进正文**。正文往往是自带底色的卡片（内置预设就要求模型输出
 * 「羊皮纸纹理背景」这类 CSS），插在开头只会把正文顶出屏幕。采用图改为只在按钮里
 * 体现，点开灯箱看大图。
 *
 * 收藏页与导出 HTML **仍然是图文一体** —— 它们直接用 illustrationFigure
 * （见 illustrationData.js 上那条「不可删」的注释）。
 *
 * ⚠ 灯箱要挂 #t-overlay，不能挂 .t-content-wrapper：后者带 transform: translateZ(0)
 *   与 overflow: hidden，会把 position:fixed 的后代整个裁掉。
 *   按钮正相反，必须挂进 .t-content-wrapper —— 它是定位祖先且不滚动。
 */
export function bindMainIllustrations(getTarget) {
    const content = document.getElementById("t-output-content");
    if (!content) return () => { };
    // 定位祖先。夹具里可能没有 .t-content-wrapper，所以留一条回落。
    const container = content.closest(".t-content-wrapper") || content.parentElement || document.body;
    const overlay = document.getElementById("t-overlay");
    let disposed = false, sequence = 0, timer, lightbox = null;
    let currentKey = "", currentImage = null, currentError = "";

    const badge = createIllustrationBadge({ container, onActivate: activate });

    function openPanel() {
        try { openIllustrationWindow(getTarget()); }
        catch (error) { if (window.toastr) window.toastr.warning(showError(error), "Titania Echo"); }
    }

    function openLightbox() {
        lightbox = openIllustrationLightbox({
            image: currentImage,
            container: overlay || document.body,
            onSwap: openPanel,
            onClose: () => { lightbox = null; },
        });
    }

    /** busy 与 error 都去面板：那里能看进度、能取消、能重试保存。 */
    function activate(state) {
        if (state.mode === "image") openLightbox();
        else openPanel();
    }

    function draw() {
        if (disposed) return;
        badge.update({
            image: currentImage,
            error: currentError,
            activity: currentKey ? getIllustrationActivity(currentKey) : null,
        });
        // 灯箱开着时跟着换图；图没了就关掉，别留一张已不属于这一轮的图。
        if (lightbox) {
            if (currentImage) lightbox.update(currentImage);
            else lightbox.close();
        }
    }

    const refresh = async (force = false) => {
        let target;
        try { target = getTarget(); } catch { target = null; }
        const key = target?.sceneId || "";
        // 同一轮次算过一次就不再重算 —— 流式期间这个函数会被高频触发而配图并没变。
        // 记录变化（采用 / 隐藏 / 重新生成）走 titania:illustrations-changed（force）进来。
        if (!force && key === currentKey) return;
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
        draw();
    };

    // ⚠ 这 80ms 防抖是承重的，别删：翻页时内容先渲染并派发 titania:scene-rendered，
    //   generation result 之后才更新，同步刷新会读到上一轮的 target。
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 80); };
    // 换轮次一律经过 renderGeneratedContent，它必然派发这个事件 —— 所以它是场景切换
    // 的可靠信号，原先那个 MutationObserver 的独有价值（Shadow DOM 内部变化）正是它覆盖的。
    window.addEventListener("titania:scene-rendered", schedule);
    const changed = () => void refresh(true);
    window.addEventListener("titania:illustrations-changed", changed);
    const unsubscribeActivity = subscribeIllustrationActivity(() => draw());
    void refresh(true);

    return () => {
        disposed = true;
        clearTimeout(timer);
        window.removeEventListener("titania:scene-rendered", schedule);
        window.removeEventListener("titania:illustrations-changed", changed);
        unsubscribeActivity();
        lightbox?.close();
        lightbox = null;
        badge.destroy();
    };
}
