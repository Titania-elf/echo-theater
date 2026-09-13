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
            // ⚠ theme-light.css 必须紧跟在 theme-dark.css **之后**：两者选择器
            //   特异度不同（:root vs :root[data-t-theme="light"]），本来靠特异度
            //   就能胜出，但顺序放前面会让人误以为可以互换。由 scripts/css-audit.js
            //   的 A14 断言文件存在，顺序由本清单唯一决定。
            //   本文件由 scripts/gen-theme-light.py 生成，勿手改。
            'theme-light.css',     // 浅色主题：只覆盖需要变的 token（231 条）
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
            // 原生表单控件的作用域内重置（Phase 6c-5）。与 scrollbar.css 同类：
            // 都是「ST 用元素级选择器定了样式、插件必须在自己作用域内夺回」。
            // ⚠ 必须排在 02-components/ **之前**：本文件用 (0,1,1) 级选择器，
            //   靠层叠顺序之外的特异度差让组件类继续胜出，顺序前置只是双保险。
            'form-controls.css',
            'keyframes.css',   // 全库唯一的 @keyframes 声明处（规则 R6）
        ]
    },

    // 【第 2 层:语义化组件】禁止页面/ID 选择器与颜色字面量（R2/R3a/R3b）
    {
        layer: '02-components', files: [
            'window.css',      // 窗口外壳（目前只有 .t-header）
            'panel.css',       // 窗口内分区面板的头/脚
            'settings-shell.css', // 设置界面外壳：中性灰基础 + 冷玻璃修饰
            'dialog.css',
            'button.css',
            'icon-button.css',
            'field.css',
            'choice-input.css',
            'radio-card.css',
            '_legacy.css',     // ⚠ 旧类名 → 新实现映射，必须在全部组件之后（Phase 7 删除）
        ]
    },

    // 【第 3 层:布局原语】只负责排列与间距，不定义组件视觉
    {
        layer: '03-layout', files: [
            'button-groups.css',
            // Phase 5b-2 新增。收口高频布局基元（.t-flex-1 / .is-hidden）。
            // ⚠ 加新 utility 前必须先重跑全库频次盘点，理由见该文件头部注释。
            'utilities.css',
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
            // 主窗口的剧本选择器面板。原先整段写在 manager.css 里，但 13 个类名
            // 全部只被 mainWindow.js 消费、剧本管理器一个都不用（Phase 4c 拆出）。
            // 位置按归属排；这些类全库仅此一处定义，故位置对层叠无影响。
            'script-picker.css',
            // Phase 4f 从 main-window.css 按类名前缀拆出（纯搬运）。必须排在
            // main-window-legacy.css **之后**才能满足 A15；这是安全的 ——
            // legacy 只覆盖底栏 / run 按钮 / 工具面板一族，不碰这四个家族。
            'wi-selector.css',      // .t-wi-*   世界书条目选择器
            'continuation.css',     // .t-cont-* / .t-continuation-*  主动续写
            'queue.css',            // .t-queue-*  队列设置窗口与进度条
            'content-editor.css',   // .t-ce-*   内容编辑器
            // ST 扩展设置抽屉 + 更新弹窗。原先一半在 settings.css 前 273 行、
            // 一半在 settings.html 的内联 <style> 里（缺陷 B10），Phase 4g 合并至此。
            // 内联 <style> 原在 body,层叠上晚于 head 注入的插件 CSS;这里的选择器
            // 全库仅此一处定义、宿主与其余第三方扩展亦无同名类,故位置无影响。
            'settings-drawer.css',
            'settings.css',
            'manager.css',
            'workshop.css',    // ← dom.js 原先漏掉的文件(B1)
            'favs.css',
            'debug.css',
            // story-outline 的 dialog 尺寸已通过组件修饰类隔离,不再依赖加载顺序。
            'story-outline.css',
            // 以下为从 JS 运行时注入迁出的样式。它们原先靠「注入得晚」无条件取胜，
            // 现在服从层叠顺序；因全部带 ID 作用域，位置对结果无影响。
            'outline-entry-menu.css',
            'rewrite.css',
            // Phase 5b-11 从 src/core/api.js 的内联 style 迁出。
            // 选择器全库唯一（#t-confirm-* / .t-confirm-*），位置对层叠无影响。
            'confirm-dialog.css',
            // 注入 ST DOM 的元素（依 ADR-02 独立于插件组件体系，且不加 .t-root）。
            // 放在最末：这些样式原先靠运行时注入取胜，此位置保持其原有优先级。
            'st-embedded.css',
        ]
    },

    // 尚未创建的层：05-utilities。
    // 审计 A14 要求清单与磁盘完全一致，故未创建的文件不得预先列出。
];

/** 展开为相对 css/ 的有序路径列表,如 '01-base/base.css' */
export function cssFileList() {
    return CSS_LAYERS.flatMap(({ layer, files }) => files.map(f => `${layer}/${f}`));
}
