import { buildPromptTextFromTheater } from "../core/chatInjector.js";
import { getCosmosCapabilities, prepareTheaterIllustration, generateTheaterIllustration } from "../core/cosmosVisionBridge.js";
import { readSceneIllustrations, saveGeneratedIllustration, selectSceneIllustration, selectedIllustration } from "../core/illustrationStore.js";
import { escapeIllustrationHtml as escape, illustrationFigure, normalizeIllustrationDraft, normalizeSavedIllustration } from "../core/illustrationData.js";
import { exportAsHtmlFile } from "../utils/helpers.js";

const PROGRESS_LABELS = { queued: "正在排队…", analyzing: "正在分析剧场、选择画面…", generating: "正在生成图片…", downloading: "正在接收图片…" };
// 会话与任务都放在模块级：面板关掉后选景与生图继续跑，重新打开同一场景能接着看进度和结果。
const sessions = new Map();
let activeView = null;
let closeActiveWindow = null;

function showError(error) {
    return error?.name === "AbortError" || error?.code === "ABORTED"
        ? "已取消等待。后端可能仍在计算；需要时可重新发起。"
        : String(error?.message || "配图操作失败，请重试。");
}

function sessionFor(sceneId, initialText) {
    if (!sessions.has(sceneId)) {
        sessions.set(sceneId, { text: initialText || "", request: "", participants: "", draft: null, pending: null, previousScenes: [], adopted: undefined, notice: "", job: null });
    }
    return sessions.get(sceneId);
}

function notifyView(sceneId) {
    if (activeView?.sceneId === sceneId) activeView.sync();
}

function jobProgress(job) {
    return event => {
        job.status = PROGRESS_LABELS[event.stage] || "正在处理…";
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
    current.record = await saveGeneratedIllustration(currentTarget.sceneId, current.pending);
    const image = selectedIllustration(current.record);
    await currentTarget.onSelected?.(image);
    current.adopted = image;
    current.pending = null;
    current.notice = "配图已保存。可在下方挑选图片，或沿用提示词重新生成。";
    return current.record;
}

/** target 为固定的正文快照；onSelected 可由收藏页注入，始终操作原收藏。 */
export function openIllustrationWindow(targetOrTargets) {
    closeActiveWindow?.();
    const targets = Array.isArray(targetOrTargets) ? targetOrTargets : [targetOrTargets];
    if (!targets.length) return;
    const previousFocus = document.activeElement;
    const root = document.createElement("div");
    root.className = "t-root t-illustration-window";
    root.innerHTML = `
        <section class="t-illustration-panel" role="dialog" aria-labelledby="t-illustration-title">
            <div class="t-panel-header">
                <strong id="t-illustration-title">场景配图</strong>
                <button type="button" class="t-btn" data-action="close" aria-label="关闭配图面板">关闭</button>
            </div>
            <div class="t-illustration-body">
                <label class="t-illustration-field">配图内容<select class="t-input" data-field="target"></select></label>
                <p class="t-illustration-hint">为选中的这一轮剧场挑选一个画面。切换正文后，本次任务仍属于这里显示的内容。</p>
                <div class="t-illustration-connection"><span data-role="connection">正在检测 Cosmos Vision…</span><button class="t-btn" type="button" data-action="detect">重新检测</button></div>
                <label class="t-illustration-field">生图来源<select class="t-input" data-field="source"></select></label>
                <p class="t-illustration-hint">画幅、画风和采样设置沿用 Cosmos Vision 的配置。</p>
                <label class="t-illustration-field">想画什么（可选）<textarea class="t-input" data-field="request" rows="2" placeholder="例如：画雨中重逢的瞬间，远景，偏冷色"></textarea></label>
                <details class="t-illustration-details"><summary>正文与人物资料</summary>
                    <label class="t-illustration-field">本次配图素材<textarea class="t-input" data-field="text" rows="6"></textarea></label>
                    <label class="t-illustration-field">人物外观等补充资料（可选）<textarea class="t-input" data-field="participants" rows="3" placeholder="可以补充发色、服装等信息；留空则根据正文选景。"></textarea></label>
                </details>
                <div class="t-illustration-actions"><button class="t-btn primary" type="button" data-action="prepare">分析画面</button><button class="t-btn" type="button" data-action="alternate">换个画面</button></div>
                <div data-role="draft" hidden>
                    <p class="t-illustration-summary" data-role="summary"></p>
                    <details class="t-illustration-details"><summary>编辑绘画提示词</summary>
                        <label class="t-illustration-field">正向提示词<textarea class="t-input" data-field="positive" rows="5"></textarea></label>
                        <label class="t-illustration-field">负向提示词<textarea class="t-input" data-field="negative" rows="3"></textarea></label>
                        <div data-role="characters"></div>
                    </details>
                    <button class="t-btn primary" type="button" data-action="generate">生成图片</button>
                </div>
                <div class="t-illustration-status" role="status" aria-live="polite" data-role="status"></div>
                <div class="t-illustration-actions"><button class="t-btn" type="button" data-action="cancel" hidden>取消等待</button><button class="t-btn" type="button" data-action="save" hidden>重试保存</button></div>
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
            role("summary").textContent = draft.scene.summary;
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
        return normalizeIllustrationDraft(draft, session.text);
    }

    function renderGallery() {
        const images = session?.record?.images || [];
        role("gallery").innerHTML = images.length ? `<strong>已保存的配图</strong><div class="t-illustration-candidates">${images.map(image => `
            <article class="t-illustration-candidate">
                <a href="${image.filePath}" target="_blank" rel="noopener"><img src="${image.filePath}" loading="lazy" alt="${escape(image.draft.scene.summary)}"></a>
                <p>${escape(image.draft.scene.summary)}</p>
                <div class="t-illustration-actions"><button class="t-btn" type="button" data-image-id="${escape(image.id)}">${session.record.selectedId === image.id ? "当前配图" : "采用这张"}</button><a class="t-btn" href="${image.filePath}" download>下载</a></div>
            </article>`).join("")}</div><div class="t-illustration-actions"><button class="t-btn" type="button" data-image-id="">暂不展示配图</button><button class="t-btn" type="button" data-action="export">导出图文 HTML</button></div>` : "";
        if (pendingUrl && session?.pending !== renderedPending) { URL.revokeObjectURL(pendingUrl); pendingUrl = null; }
        if (session?.pending && session.pending !== renderedPending) {
            pendingUrl = URL.createObjectURL(session.pending.image.blob);
        }
        renderedPending = session?.pending || null;
        role("pending").hidden = !pendingUrl;
        if (pendingUrl) role("pending-image").src = pendingUrl;
        else role("pending-image").removeAttribute("src");
        updateControls();
    }

    async function detect() {
        const sequence = ++detectionSequence;
        ready = false;
        updateControls();
        try {
            const capabilities = await getCosmosCapabilities();
            if (disposed || sequence !== detectionSequence) return;
            const previous = session?.draft?.imageSource || field("source").value || capabilities.defaultImageSource;
            field("source").replaceChildren();
            for (const source of capabilities.imageSources) {
                const option = new Option(`${source.label}${source.ready ? "" : "（未配置）"}`, source.id);
                option.disabled = !source.ready;
                option.title = source.reason || "";
                field("source").add(option);
            }
            field("source").value = capabilities.imageSources.some(item => item.id === previous && item.ready)
                ? previous : (capabilities.imageSources.find(item => item.ready)?.id || "");
            ready = Boolean(field("source").value);
            role("connection").textContent = ready ? "Cosmos Vision 已连接" : "请先在 Cosmos Vision 配置一个生图来源。";
        } catch (error) {
            if (disposed || sequence !== detectionSequence) return;
            role("connection").textContent = showError(error);
        }
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
        field("text").value = session.text;
        field("request").value = session.request;
        field("participants").value = session.participants;
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
        if (event.target === field("source")) { session.draft = null; renderDraft(); }
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
        const current = session, currentTarget = target;
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
            // 来源与「换个画面」的历史在点击时固定，面板随后关掉也不影响这次任务。
            const imageSource = field("source").value;
            const alternate = operation === "alternate";
            startJob(current, currentTarget, "prepare", async job => {
                job.status = PROGRESS_LABELS.analyzing;
                notifyView(job.sceneId);
                const draft = await prepareTheaterIllustration({
                    mode: "theater", imageSource, theaterText: current.text,
                    context: { mode: "provided", source: { client: "titania-theater", sceneId: currentTarget.sceneId }, participants: current.participants, history: [] },
                    specialRequest: current.request,
                    ...(alternate ? { previousScenes: current.previousScenes.slice(-6) } : {}),
                }, { signal: job.controller.signal, onProgress: jobProgress(job) });
                current.draft = draft;
                current.previousScenes.push(draft.scene);
                current.notice = "画面已选好。可以展开修改提示词，再生成图片。";
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
                current.pending = await generateTheaterIllustration(draft, { signal: job.controller.signal, onProgress: jobProgress(job) });
                job.phase = "saving";
                job.status = "正在保存配图…";
                notifyView(job.sceneId);
                await persistPending(current, currentTarget);
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
        root.remove();
        window.removeEventListener("cosmos-vision:ready", detect);
        window.removeEventListener("cosmos-vision:capabilities-changed", detect);
        if (closeActiveWindow === close) closeActiveWindow = null;
        if (previousFocus?.isConnected) previousFocus.focus();
        // 待保存图片与后台任务保留在内存，关窗后重新打开可以继续；普通会话保持有界。
        for (const [key, value] of sessions) {
            if (sessions.size <= 20) break;
            if (!value.pending && !value.job && key !== target.sceneId) sessions.delete(key);
        }
    }
    closeActiveWindow = close;
    window.addEventListener("cosmos-vision:ready", detect);
    window.addEventListener("cosmos-vision:capabilities-changed", detect);
    void loadTarget(0);
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
