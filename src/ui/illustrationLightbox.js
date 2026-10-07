// 配图灯箱：把一张配图放大看，正文与面板都不参与。
//
// 唯一的入口是**配图面板图库里的那张缩略图**（以前它是个 target="_blank" 的链接，
// 点开是浏览器的新标签页）。正文里从来没有配图元素，收藏阅读页与导出的 HTML
// 仍然是正文内嵌图（见 illustrationData.js 的 illustrationFigure）。
//
// ⚠ 挂载点是**配图面板自己的 root**（.t-root.t-illustration-window），不是 #t-overlay：
//   面板 root 带 z-index: 20060，是一个自成一层的作用域；#t-overlay 带
//   isolation: isolate + z-index: 20000，挂进去的灯箱会被关在 20000 那一层，
//   而面板在 20060 —— 灯箱会整块藏在面板后面。
//   挂在面板 root 里则是同一层叠上下文的后代，必然盖在面板内容之上，
//   而且随面板一起从 DOM 上消失。
//
// ⚠ 它**不占浮层名额**（不走 floatingWindow.js 的 claim）：灯箱不是窗口，
//   它只是在面板里铺满一层。代价是面板关闭时不会连带关掉它 ——
//   面板必须在自己的 close() 里显式调它的 close()，否则挂在 document 上的
//   Esc 监听会留下来，变成一个关不掉的幽灵（面板 root 已经从 DOM 上摘走了）。

const CLOSE_ICON = "fa-solid fa-xmark";

/**
 * 打开灯箱。
 *
 * @param {object} options
 * @param {object} options.image 要看的配图（已保存记录，normalizeSavedIllustration 的形状）。
 *   **必填**：调用方先在图库里找到那一张再开灯箱，找不到就别开 —— 一个没有图的大黑幕
 *   比什么都不做更让人困惑。
 * @param {HTMLElement} [options.container] 挂载点，缺省 document.body
 * @param {() => void} [options.onClose] 关闭后回调
 * @returns {{element:HTMLElement, close:Function}}
 */
export function openIllustrationLightbox({ image, container = null, onClose = null } = {}) {
    const root = document.createElement("div");
    root.className = "t-root t-illustration-lightbox";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "配图大图");
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

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "t-illustration-lightbox-close";
    closeButton.title = "关闭";
    closeButton.setAttribute("aria-label", "关闭");
    const closeIcon = document.createElement("i");
    closeIcon.className = CLOSE_ICON;
    closeButton.append(closeIcon);

    root.append(backdrop, stage, caption, closeButton);
    (container || document.body).append(root);

    let disposed = false;
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

    img.src = image.filePath || "";
    // 给了原始尺寸就带上，让浏览器在图片加载前就能算好布局、不跳动。
    if (image.width) img.width = image.width;
    if (image.height) img.height = image.height;
    const summary = image.draft?.scene?.summary || "";
    img.alt = summary || "配图";
    caption.textContent = summary;
    caption.hidden = !summary;

    backdrop.addEventListener("click", close);
    closeButton.addEventListener("click", close);
    document.addEventListener("keydown", onKeydown, true);
    closeButton.focus?.();

    return { element: root, close };
}
