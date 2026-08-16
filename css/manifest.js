// css/manifest.js —— CSS 清单的唯一数据源
//
// build.js(打包内联)与 src/utils/dom.js(开发模式 <link>)都必须从这里读取。
// 在此之前两处各自手写清单并已漂移:dom.js 漏了 workshop.css,导致开发模式下
// 工坊窗口完全无样式(缺陷 B1)。请勿在其它地方再写第二份清单。
//
// ⚠ 数组顺序 = 拼接顺序 = 层叠顺序。改动顺序会改变视觉,须配合截图比对。
// 顺序约束由 scripts/css-audit.js 断言(A14 文件存在性 / A15 legacy 紧跟主文件)。

export const CSS_LAYERS = [
    // 【第 1 层:作用域与基础】
    // Phase 1 起 base.css 将拆分为 scope.css / typography.css / scrollbar.css
    {
        layer: '01-base', files: [
            'base.css',
            'keyframes.css',   // 全库唯一的 @keyframes 声明处(规则 R6)
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
        ]
    },

    // 后续 Phase 新增的层(00-tokens / 02-components / 03-layout / 05-utilities)
    // 在此按顺序插入。当前尚未创建,故不列出 —— 审计 A14 要求清单与磁盘完全一致。
];

/** 展开为相对 css/ 的有序路径列表,如 '01-base/base.css' */
export function cssFileList() {
    return CSS_LAYERS.flatMap(({ layer, files }) => files.map(f => `${layer}/${f}`));
}
