// 配图灯箱：把当前采用图放大看，正文完全不参与。
//
// ⚠ 它**不占浮层名额**（不走 floatingWindow.js 的 claim）—— 所以配图面板开着时也能
//   看大图，而不是把面板顶掉。灯箱与面板是可以并存的：点「换一张」开面板，
//   采用别的图之后灯箱会跟着更新。
//
// ⚠ 挂载点由调用方给，必须是不被 `.t-content-wrapper` 裁剪的容器（用 #t-overlay）。
//   那个 wrapper 带 transform: translateZ(0) + overflow: hidden，既是 position:fixed
//   后代的包含块、又会把它裁掉 —— 灯箱挂进去会整个看不见。

const CLOSE_ICON = "fa-solid fa-xmark";

/**
 * 打开灯箱。
 *
 * @param {object} options
 * @param {object|null} [options.image] 已保存的配图记录（normalizeSavedIllustration 的形状）
 * @param {HTMLElement} [options.container] 挂载点，缺省 document.body
 * @param {() => void} [options.onSwap] 点「换一张」时回调（调用方去开配图面板）
 * @param {() => void} [options.onClose] 关闭后回调
 * @returns {{element:HTMLElement, update:Function, close:Function}}
 */
export function openIllustrationLightbox({ image = null, container = null, onSwap = null, onClose = null } = {}) {
    const root = document.createElement("div");
    root.className = "t-root t-illustration-lightbox";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "场景配图");
    root.tabIndex = -1;

    const backdrop = document.createElement("div");
    backdrop.className = "t-illustration-lightbox-backdrop";

    // 舞台是滚动容器：竖图保持原尺寸纵向滚动，横图缩到宽度内。
    const stage = document.createElement("div");
    stage.className = "t-illustration-lightbox-stage";
    const img = document.createElement("img");
    img.className = "t-illustration-lightbox-image";
    img.alt = "";
    stage.append(img);

    const caption = document.createElement("p");
    caption.className = "t-illustration-lightbox-caption";
    caption.hidden = true;

    const actions = document.createElement("div");
    actions.className = "t-illustration-lightbox-actions";
    const swap = document.createElement("button");
    swap.type = "button";
    swap.className = "t-btn";
    swap.textContent = "换一张";
    actions.append(swap);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "t-illustration-lightbox-close";
    closeButton.title = "关闭";
    closeButton.setAttribute("aria-label", "关闭");
    const closeIcon = document.createElement("i");
    closeIcon.className = CLOSE_ICON;
    closeButton.append(closeIcon);

    root.append(backdrop, stage, caption, actions, closeButton);
    (container || document.body).append(root);

    let disposed = false;
    let renderedId = "";
    // 先记下焦点，再把自己的关闭按钮聚焦 —— 顺序反了就还原不回去。
    const restoreFocus = document.activeElement;

    /**
     * Esc 关闭。用**捕获阶段 + stopPropagation**：禅模式与工具箱也在 document 上听
     * keydown，不拦的话关灯箱会顺带把它们一起切了。
     */
    function onKeydown(event) {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        close();
    }

    function close() {
        if (disposed) return;
        disposed = true;
        document.removeEventListener("keydown", onKeydown, true);
        root.remove();
        if (restoreFocus?.isConnected) restoreFocus.focus?.();
        onClose?.();
    }

    /** 换图时原地更新；传 null 等价于关闭。同一张图重复调用直接跳过。 */
    function update(next) {
        if (disposed) return;
        if (!next) { close(); return; }
        if (next.id && next.id === renderedId) return;
        renderedId = next.id || "";
        img.src = next.filePath || "";
        // 给了原始尺寸就带上，让浏览器在图片加载前就能算好布局、不跳动。
        if (next.width) img.width = next.width;
        if (next.height) img.height = next.height;
        const summary = next.draft?.scene?.summary || "";
        img.alt = summary || "配图";
        caption.textContent = summary;
        caption.hidden = !summary;
    }

    backdrop.addEventListener("click", close);
    closeButton.addEventListener("click", close);
    swap.addEventListener("click", () => onSwap?.());
    document.addEventListener("keydown", onKeydown, true);

    update(image);
    closeButton.focus?.();

    return { element: root, update, close };
}
