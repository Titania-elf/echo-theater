// css/manifest.js —— CSS 清单的唯一数据源
//
// build.js(打包内联)与 src/utils/dom.js(开发模式 <link>)都必须从这里读取。
// 在此之前两处各自手写清单并已漂移:dom.js 漏了 workshop.css,导致开发模式下
// 工坊窗口完全无样式(缺陷 B1)。请勿在其它地方再写第二份清单。
//
// ⚠ 数组顺序 = 拼接顺序 = 层叠顺序。改动顺序会改变视觉,须配合截图比对。
// 顺序约束由 scripts/css-audit.js 断言(A14 文件存在性 / A15 legacy 紧跟主文件)。

export const CSS_LAYERS = [
    // 【第 0 层:Design Tokens】必须最先加载：其余各层都消费这里的变量
    {
        layer: '00-tokens', files: [
            'primitives.css',      // 与主题无关的原始尺度（组件层禁止直接引用，R3b）
            'semantic.css',        // 语义角色中不随主题变化的部分（圆角/间距/排版）
            'theme-dark.css',      // 暗色主题：语义 → 原语绑定（= 当前视觉）
            // 'theme-light.css',  ← Phase 6 之后新增
            'legacy-aliases.css',  // ⚠ 旧变量名 → 新 token（Phase 7 删除）
        ]
    },

    // 【第 1 层:作用域与基础】
    // Phase 1 起 base.css 将继续拆分为 typography.css 等
    {
        layer: '01-base', files: [
            'scope.css',       // ★ .t-root：插件 UI 的作用域根（修 B8/B9）
            'base.css',
            'scrollbar.css',   // 带作用域的滚动条外观（修 B2）
            'keyframes.css',   // 全库唯一的 @keyframes 声明处（规则 R6）
        ]
    },

    // 【第 2 层:语义化组件】禁止页面/ID 选择器与颜色字面量（R2/R3a/R3b）
    {
        layer: '02-components', files: [
            'button.css',
            'icon-button.css',
            '_legacy.css',     // ⚠ 旧类名 → 新实现映射，必须在全部组件之后（Phase 7 删除）
        ]
    },

    // 【第 4 层:功能视图】
    // 顺序沿用 5.2.5 build.js 的原始顺序,保证层叠结果逐字节不变。
    {
        layer: '04-features', files: [
            'floating.css',
            'main-window.css',
            // ⚠ 必须紧跟 main-window.css:经典布局靠后置覆盖少量冲突规则(审计 A15)
            'main-window-legacy.css',
            'settings.css',
            'manager.css',
            'workshop.css',    // ← dom.js 原先漏掉的文件(B1)
            'favs.css',
            'debug.css',
            'lore-review.css',
            'memory-recall.css',
            // ⚠ story-outline.css 目前在最末,其顶层 .t-dialog-* 定义会污染
            //   lore-review 的对话框(缺陷 B6)。Phase 4 修复,届时可前移。
            'story-outline.css',
            // 以下为从 JS 运行时注入迁出的样式。它们原先靠「注入得晚」无条件取胜，
            // 现在服从层叠顺序；因全部带 ID 作用域，位置对结果无影响。
            'outline-entry-menu.css',
            // ⚠ 必须晚于 lore-review.css：清洗预览原先是运行时注入的，
            //   层叠上晚于 lore-review.css，此顺序保持其原有优先级。
            'cleaning-preview.css',
            'rewrite.css',
            // 注入 ST DOM 的元素（依 ADR-02 独立于插件组件体系，且不加 .t-root）。
            // 放在最末：这些样式原先靠运行时注入取胜，此位置保持其原有优先级。
            'st-embedded.css',
        ]
    },

    // 尚未创建的层：03-layout / 05-utilities（Phase 2b 起）。
    // 审计 A14 要求清单与磁盘完全一致，故未创建的文件不得预先列出。
];

/** 展开为相对 css/ 的有序路径列表,如 '01-base/base.css' */
export function cssFileList() {
    return CSS_LAYERS.flatMap(({ layer, files }) => files.map(f => `${layer}/${f}`));
}
