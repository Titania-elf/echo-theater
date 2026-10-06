// 内容区底部中间的配图按钮：主界面唯一常驻的配图入口。
//
// 它是**纯图标圆钮**，文案走 title 与 aria-label，不占版面。
//
// 为什么要四种状态，而不是「有图就显示」：配图任务可以在面板关掉之后继续跑
// （既有语义），那时它是唯一能告诉用户「还在转」的地方；失败时也是面板关着时
// 唯一还看得见的提示。
//
// 它不 import 配图面板 —— 点击做什么由调用方通过 onActivate 决定，
// 于是它既能开灯箱也能开面板，而不必知道这两者的存在。

const MODE_HIDDEN = "hidden";
const MODE_BUSY = "busy";
const MODE_IMAGE = "image";
const MODE_ERROR = "error";

/** 进行态里算「忙」的阶段；error 与 idle 不算，它们不转圈。 */
const BUSY_PHASES = new Set(["selecting", "generating", "saving"]);

const ICON_BUSY = "fa-solid fa-spinner fa-spin";
const ICON_IMAGE = "fa-solid fa-image";
const ICON_ERROR = "fa-solid fa-triangle-exclamation";

/** 入场动画结束后必须摘掉类。jsdom 不触发 animationend，这条兜底同时服务测试。 */
const ENTRANCE_FALLBACK_MS = 400;

/**
 * 由（进行态、图、错误）推导按钮模式。纯函数，单独导出便于直接测。
 *
 * 优先级 busy > image > error > hidden。
 * **有图时让图胜出**：否则一次后台任务失败会让「看图」这个入口永久消失。
 * 失败本身仍由面板状态行与后台 toastr 呈现，不会被吞掉。
 *
 * @returns {"hidden"|"busy"|"image"|"error"}
 */
export function deriveBadgeMode({ image, activity, error } = {}) {
    if (activity && BUSY_PHASES.has(activity.phase)) return MODE_BUSY;
    if (image) return MODE_IMAGE;
    if (activity?.phase === "error" || error) return MODE_ERROR;
    return MODE_HIDDEN;
}

/**
 * 造一个配图按钮并挂进 container。
 *
 * @param {object} options
 * @param {HTMLElement} options.container 挂载点（应为 .t-content-wrapper：它是定位祖先且不滚动）
 * @param {(state:object) => void} [options.onActivate] 点击回调，收到当前状态
 * @returns {{element:HTMLElement, update:Function, destroy:Function}}
 */
export function createIllustrationBadge({ container, onActivate } = {}) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "t-illustration-badge";
    // ⚠ 属性名必须与正文配图那两个区分开：data-titania-illustration / -notice 既是
    //   旧正文清理逻辑的选择器，也是既有测试的选择器。复用会被误删，也会让那条测试翻转。
    element.setAttribute("data-titania-illustration-badge", "");
    element.hidden = true;

    const icon = document.createElement("i");
    icon.className = `t-illustration-badge-icon ${ICON_IMAGE}`;
    element.append(icon);
    container?.append(element);

    let state = { mode: MODE_HIDDEN, image: null, activity: null, error: "" };
    // 只记「上一次为哪张图播过入场动画」。**隐藏时刻意不清空** —— 流式期间按钮会
    // 藏了又现，同一张图反复播动画会很吵。
    let animatedImageId = null;
    let animationTimer = 0;

    function stopEntrance() {
        if (animationTimer) { clearTimeout(animationTimer); animationTimer = 0; }
        element.classList.remove("is-entering");
    }

    function playEntrance() {
        stopEntrance();
        // 读一次布局属性，让同一帧内重新加类也能重启动画。
        void element.offsetWidth;
        element.classList.add("is-entering");
        animationTimer = setTimeout(stopEntrance, ENTRANCE_FALLBACK_MS);
    }

    element.addEventListener("animationend", stopEntrance);
    element.addEventListener("click", () => {
        if (state.mode !== MODE_HIDDEN) onActivate?.(state);
    });

    /**
     * 重画。幂等且便宜，可以随便调。
     * @param {{image?:object|null, activity?:object|null, error?:string}} [next]
     */
    function update(next = {}) {
        const image = next.image || null;
        const activity = next.activity || null;
        const error = String(next.error || "");
        const mode = deriveBadgeMode({ image, activity, error });
        state = { mode, image, activity, error };

        element.dataset.state = mode;
        element.hidden = mode === MODE_HIDDEN;

        let text = "";
        if (mode === MODE_BUSY) {
            icon.className = `t-illustration-badge-icon ${ICON_BUSY}`;
            text = activity?.message || "正在配图…";
        } else if (mode === MODE_IMAGE) {
            icon.className = `t-illustration-badge-icon ${ICON_IMAGE}`;
            text = "查看配图";
        } else if (mode === MODE_ERROR) {
            icon.className = `t-illustration-badge-icon ${ICON_ERROR}`;
            text = error || activity?.message || "配图读取失败，可打开场景配图面板重试。";
        }
        if (mode !== MODE_HIDDEN) {
            // 纯图标钮：文案只做悬浮提示与无障碍名称。
            element.title = text;
            element.setAttribute("aria-label", text);
        } else {
            element.removeAttribute("title");
            element.removeAttribute("aria-label");
        }

        // 只在**换了一张图**时播入场动画；进行态、错误态、以及同一张图藏了再现都不播。
        if (mode === MODE_IMAGE && image?.id && image.id !== animatedImageId) playEntrance();
        if (image?.id) animatedImageId = image.id;

        return state;
    }

    function destroy() {
        stopEntrance();
        element.removeEventListener("animationend", stopEntrance);
        element.remove();
    }

    return { element, update, destroy };
}
