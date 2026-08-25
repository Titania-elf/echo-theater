# 回声小剧场 · 自定义 CSS 选择器速查

适用版本：5.2.7 · 范围：**仅小剧场功能链路**（入口 → 主界面 → 生成 → 阅读 → 续写 → 收藏 → 调试）

入口：插件设置页 → 外观 → 自定义 CSS。写完点「保存所有配置」生效。

---

## 一、先读这三条

### 1. 你的 CSS 加载在最后，同特异度下你赢

插件样式注入为 `<style id="titania-theater-bundled-css">`，你的 CSS 注入为 `<style id="t-custom-style">`，两者都在 `<head>`，**你的在后面**。所以同特异度的规则你会胜出，一般**不需要 `!important`**。

但特异度仍要够。例如插件写的是 `#t-main-view .t-header .t-header-actions .t-icon-btn`（特异度 1,3,0），你只写 `.t-icon-btn`（0,1,0）是盖不住的。照抄插件的选择器层级最稳。

### 2. `.t-root` 是插件的作用域根

所有插件窗口的最外层都带 `.t-root`，它定义了字号基准（`12px × 缩放`）、字体、文字色。想全局调插件 UI 的字号，改这里：

```css
.t-root { --t-ui-font-scale: 1.15; }
```

### 3. ⚠️ 生成出来的小剧场内容，外部 CSS 改不到

这是最容易白花时间的一点。AI 生成的 HTML 被渲染进 **Shadow DOM**：

```
#t-output-content
└── div.t-shadow-host          ← 在普通 DOM 里，你能选中
    └── #shadow-root (open)    ← 边界，选择器无法穿过
        ├── <style>            ← 插件在内部写死的基础样式
        └── div.t-shadow-content
            └── ……AI 生成的 HTML……
```

`.t-shadow-content` 及其内部**任何**元素，写在自定义 CSS 里都不会命中。收藏馆阅读器（`#t-read-content`）同理。

**你仍然可以做的三件事：**

```css
/* ① 给宿主本身加边距、背景、滤镜 —— 宿主在普通 DOM 里 */
.t-shadow-host {
    padding: 12px 16px;
    filter: saturate(1.1);
}

/* ② 用 CSS 变量穿透进去。自定义属性会跨 Shadow 边界继承 */
#t-output-content { --t-font-global: "LXGW WenKai", serif; }

/* ③ 整体缩放（内容区字号被插件写死为 14px，无法单独改） */
.t-shadow-host { zoom: 1.1; }
```

⚠️ `.t-shadow-host` 的 `width` 和 `min-height` 由插件写成**行内样式**，改这两个属性需要 `!important`。其余属性（`padding` / `background` / `filter` / `zoom` / `border` …）正常生效。

内容区字号固定 14px 是**刻意设计**（不随 UI 缩放变化）。想改只能用 `zoom` 整体缩放宿主。

续写历史里的内容预览用的是 `<iframe sandbox="">`（`.t-cont-history-full iframe`），同样无法从外部注入样式。

---

## 二、主界面结构

主界面有两套布局，通过 `#t-main-view` 上的类区分：

- `.t-layout-modern` —— 新版工具箱布局（默认）
- `.t-layout-legacy` —— 经典版布局

**只想改一套布局时，务必带上布局类**，否则会同时影响另一套。

两者并不对称：新版是**基线**，插件对 `.t-layout-modern` 没有写任何规则（那些不带前缀的 `.t-top-bar` / `.t-bottom-bar` 规则就是给新版用的）；经典版靠 `#t-main-view.t-layout-legacy .xxx` 后置覆盖基线。所以：

- 改新版 → 可以直接写 `.t-top-bar { … }`，但记得它也会作用到经典版，要隔离就写 `#t-main-view.t-layout-modern .t-top-bar`
- 改经典版 → 必须写到 `#t-main-view.t-layout-legacy .t-top-bar`（0/1,2,0 才盖得住插件的同名规则）

```
div#t-overlay.t-overlay.t-root                    ← 遮罩层
└── div#t-main-view.t-box.t-root.t-layout-modern  ← 窗口本体
    ├── div.t-header.t-shrink-0                   ← 第一栏：标题栏
    │   ├── div.t-title-container
    │   │   ├── div.t-title-main                  「回声小剧场」
    │   │   └── div.t-title-sub#t-title-sub       「✨ 主演: …」
    │   └── div.t-header-actions                  右侧图标组
    ├── div.t-top-bar                             ← 第二栏：操作栏（两套布局不同）
    ├── div.t-content-wrapper                     ← 第三栏：内容区
    │   ├── div.t-stats-hud#t-stats-hud           统计条
    │   ├── div.t-tools-rail#t-tools-rail         右上竖排图标栏（新版）
    │   ├── div.t-content-area
    │   │   ├── button.t-page-nav.t-page-prev     翻页
    │   │   ├── button.t-page-nav.t-page-next
    │   │   ├── div.t-page-indicator              「1/1」
    │   │   ├── div.t-cont-inline-actions         续写分支浮标
    │   │   └── div#t-output-content              ★ 生成内容容器（内部是 Shadow DOM）
    │   ├── div.t-toolbox-backdrop                工具箱遮罩（新版）
    │   └── aside.t-toolbox-panel                 工具箱抽屉（新版）
    └── div.t-bottom-bar                          ← 第四栏：底栏（两套布局不同）
```

### 窗口级状态类（都加在 `#t-main-view` 上）

| 选择器 | 何时出现 |
|---|---|
| `#t-main-view.t-layout-modern` | 新版布局 |
| `#t-main-view.t-layout-legacy` | 经典版布局 |
| `#t-main-view.t-zen-mode` | 沉浸阅读模式（隐藏各栏，只留内容） |
| `#t-main-view.t-toolbox-open` | 工具箱抽屉展开（新版） |

---

## 三、入口

### 酒馆内的入口按钮

| 选择器 | 说明 |
|---|---|
| `#titania-outline-entry-btn` | 发送键左边的工具箱入口按钮 |
| `#titania-outline-entry-menu` | 点开后的菜单容器 |
| `.t-outline-entry-item` | 菜单项 |
| `#t-outline-entry-open-theater` | 菜单里的「回声小剧场」项 |
| `#chat .titania-inject-btn` | 消息楼层上的「注入小剧场」按钮 |

### 悬浮球

| 选择器 | 说明 |
|---|---|
| `#titania-float-btn` | 悬浮球本体 |
| `#titania-float-btn img` | 用户上传的球面图片 |
| `#titania-float-btn.t-loading` | 生成中 |
| `#titania-float-btn.t-loading.t-anim-ripple` | 生成中 · 脉冲波纹动画 |
| `#titania-float-btn.t-loading.t-anim-arc` | 生成中 · 电磁闪烁动画 |
| `#titania-float-btn.t-notify` | 有新内容的呼吸灯 |
| `#titania-timer` | 计时器气泡 |
| `#titania-timer.show` / `.done` | 显示中 / 已完成 |
| `#titania-slide-menu` | 横向图标菜单容器 |
| `#titania-slide-menu.show` | 菜单展开 |
| `#titania-menu-backdrop` | 菜单的点击外部关闭遮罩 |
| `.t-menu-icon-btn` | 菜单里的图标按钮 |
| `.t-menu-icon-btn.main` | 其中的「小剧场」按钮 |
| `.t-menu-icon-btn.favs` / `.scripts` / `.debug` / `.cancel` / `.model` / `.settings` | 收藏 / 剧本 / 调试 / 中止 / 切模型 / 设置 |

悬浮球的尺寸和配色由设置页写成**行内 CSS 变量**（`--t-size` / `--t-bg-color` / `--t-border-color-rgba`）。行内样式优先级高于你的样式表，想改这三项需要提升特异度或用 `!important`：

```css
#titania-float-btn { --t-size: 64px !important; }
```

---

## 四、标题栏（两套布局共用）

| 选择器 | 说明 |
|---|---|
| `.t-header` | 标题栏容器 |
| `.t-title-container` | 左侧标题区 |
| `.t-title-main` | 主标题「回声小剧场」 |
| `.t-title-sub` / `#t-title-sub` | 副标题行 |
| `#t-char-name` | 副标题里的角色名 |
| `.t-header-actions` | 右侧图标组容器 |
| `.t-icon-btn` | 图标按钮通用类 |
| `#t-btn-workshop` | 回声工坊 |
| `#t-btn-favs` | 收藏夹 |
| `#t-btn-worldinfo` | 世界书筛选 |
| `#t-btn-profiles` | API 方案 |
| `#t-btn-settings` | 设置 |
| `#t-btn-theme` | 深/浅主题切换（固定槽位） |
| `#t-btn-more` | 「更多」（仅有溢出项时出现） |
| `.t-close` / `#t-btn-close` | 关闭 |
| `#t-more-popover` | 「更多」弹层（复用 `.t-filter-popover` 样式） |
| `.t-more-item` | 弹层里的功能项 |
| `.t-more-pin` | 功能项右侧的图钉（提升到标题栏） |

标题栏图标是用户自选的，最多 5 个，**没上栏的会进「更多」**。所以针对某个标题栏图标写样式时，它可能当前不在标题栏里，而在「更多」弹层中（此时命中的是 `.t-more-item`）。

这些图标的 id 由代码按注册表拼接而成（`t-btn-` + 功能 id），在源码里搜不到字面量，但运行时确实存在。

---

## 五、第二栏：操作栏

### 新版（`.t-layout-modern`）—— 单行胶囊条

| 选择器 | 说明 |
|---|---|
| `.t-top-bar` | 整条 |
| `.t-mode-chip` / `#t-mode-toggle` | 生成模式胶囊按钮 |
| `.t-mode-chip-icon` / `-label` / `-caret` | 胶囊内的图标 / 文字 / 下拉箭头 |
| `.t-mode-chip[aria-expanded="true"]` | 菜单展开态 |
| `#t-mode-popover` | 模式下拉弹层 |
| `.t-trigger-card` / `#t-trigger-btn` | 剧本卡（点击切换剧本） |
| `.t-trigger-name` / `#t-lbl-name` | 剧本名 |
| `.t-trigger-desc` / `#t-lbl-desc-mini` | 剧本简介 |
| `.t-cat-tag` / `#t-lbl-cat` | 分类标签 |
| `.t-cat-tag.is-category` | 分类存在（着色） |
| `.t-cat-tag.is-missing` | 剧本已删除（中性灰） |
| `.t-chevron` | 剧本卡右侧箭头 |
| `.t-history-group` | 历史开关组 |
| `.t-topbar-toggle` | 图标开关本体 |
| `.t-topbar-toggle-icon` / `-text` | 开关的图标 / 文字（文字为视觉隐藏） |
| `.t-topbar-toggle.is-on` | 开启态 |
| `.t-subtoggle` | 「只要角色发言」子开关 |
| `.t-subtoggle.is-collapsed` | 父开关关闭时的收起态 |
| `.t-trigger-actions` | 右侧动作簇 |
| `.t-filter-btn` / `#t-btn-filter` | 筛选 |
| `.t-filter-btn.active-filter` | 已设筛选 |
| `.t-dice-btn` / `#t-btn-dice` | 随机剧本 |

### 经典版（`.t-layout-legacy`）—— 三簇布局

选择器需带布局前缀，例如 `#t-main-view.t-layout-legacy .t-mode-btn`。

| 选择器（省略前缀） | 说明 |
|---|---|
| `.t-history-group` | 历史开关组 |
| `.t-history-toggle` / `#t-history-toggle` | 「读取聊天历史」开关 |
| `.t-history-toggle.is-on` | 开启态 |
| `.t-toggle-label` / `.t-toggle-icon` / `.t-toggle-text` | 开关的标签 / 图标 / 文字 |
| `.t-subtoggle` / `#t-ai-only-toggle` | 「只要角色发言」子开关 |
| `.t-mode-toggle` / `#t-mode-toggle` | 三连模式按钮外壳 |
| `.t-mode-btn` | 单个模式按钮 |
| `.t-mode-btn.active` | 当前模式 |
| `.t-mode-btn-icon` | 模式按钮图标 |
| `.t-mobile-row` | 剧本卡 + 动作簇所在行 |
| `.t-trigger-card` / `.t-trigger-main` / `.t-trigger-sub` | 剧本卡及其两行 |
| `.t-filter-btn` / `.t-dice-btn` | 筛选 / 随机 |

⚠️ `#t-mode-toggle` 在两套布局里是**不同元素**：新版是胶囊按钮本体，经典版是三连按钮的外壳。

### 筛选与下拉弹层（共用）

| 选择器 | 说明 |
|---|---|
| `.t-filter-popover` / `#t-filter-popover` | 弹层容器 |
| `.t-filter-item` | 弹层条目 |
| `.t-filter-item.active` | 当前选中 |
| `.t-filter-item-icon` | 条目图标 |
| `.t-filter-sep` | 分隔线 |
| `.t-filter-check` | 选中勾 |

---

## 六、第三栏：内容区

| 选择器 | 说明 |
|---|---|
| `.t-content-wrapper` | 内容区外层 |
| `.t-content-area` | 内容区（滚动容器） |
| `#t-output-content` | ★ 生成内容容器 |
| `#t-output-content > div` | 内容容器的直接子级（即 `.t-shadow-host`） |
| `.t-shadow-host` | Shadow DOM 宿主 —— **能改到的最内层** |
| `.t-output-placeholder` | 空状态占位 |
| `.t-output-placeholder i` / `-text` | 占位图标 / 文字 |

### 统计条

| 选择器 | 说明 |
|---|---|
| `.t-stats-hud` / `#t-stats-hud` | 统计条容器 |
| `.t-stats-item` / `.t-stats-sep` | 单项 / 分隔符 |
| `.t-stats-label` / `.t-stats-value` | 标签 / 数值 |
| `#t-stat-model` / `#t-stat-total` / `#t-stat-chinese` / `#t-stat-time` | 模型 / 字符 / 中文 / 耗时 |

### 翻页与提示

| 选择器 | 说明 |
|---|---|
| `.t-page-nav` | 翻页按钮 |
| `.t-page-prev` / `.t-page-next` | 上一个 / 下一个 |
| `.t-page-nav:disabled` | 不可用 |
| `.t-page-indicator` | 页码「1/1」 |
| `.t-new-content-indicator` | 「后台生成中」指示器 |
| `.t-goto-live-btn` | 「跳到最新」按钮 |
| `.t-generation-complete-notification` | 生成完成通知条 |
| `.t-gcn-content` / `.t-gcn-view-btn` / `.t-gcn-close-btn` | 通知的正文 / 查看 / 关闭 |

### 右上工具栏

新版是竖排图标栏：

| 选择器 | 说明 |
|---|---|
| `.t-tools-rail` / `#t-tools-rail` | 容器 |
| `.t-tools-icon` | 图标按钮 |
| `.t-tools-icon.active` | 激活态 |
| `.t-tools-icon.is-faved` | 已收藏（爱心变实心） |
| `#t-tool-zen` | 沉浸阅读 |
| `#t-tool-edit-content` | 编辑内容 |
| `#t-btn-like` | 收藏结果 |

经典版是一个按钮弹出菜单（需带 `.t-layout-legacy` 前缀）：

| 选择器（省略前缀） | 说明 |
|---|---|
| `.t-tools-btn` / `#t-btn-tools` | 竖三点按钮 |
| `.t-tools-btn.zen-active` | 沉浸模式中 |
| `.t-tools-panel` / `#t-tools-panel` | 弹出菜单 |
| `.t-tools-item` | 菜单项 |

---

## 七、第四栏：底栏

### 新版 —— 常驻续写输入条

| 选择器 | 说明 |
|---|---|
| `.t-bottom-bar` | 整条 |
| `.t-continuation-stack` | 两行容器 |
| `.t-continuation-shortcuts-row` | 快捷指令行 |
| `.t-continuation-shortcuts` | 可横滑的快捷按钮区 |
| `.t-continuation-shortcuts-fixed` | 右侧固定按钮区 |
| `.t-shortcut-btn` | 快捷指令按钮（自然续写 / 推进剧情 / …） |
| `.t-shortcut-btn.t-shortcut-compose` | 「完整编辑器」 |
| `.t-shortcut-btn.t-shortcut-toolbox` | 「工具」 |
| `.t-continuation-quick` | 输入行容器 |
| `.t-continuation-quick:focus-within` | 输入聚焦态 |
| `.t-continuation-input-wrap` | 输入框外壳 |
| `.t-continuation-input-wrap textarea` / `#t-continuation-quick-input` | 输入框 |
| `.t-continuation-history-btn` | 续写历史按钮 |
| `.t-continuation-context-btn` | 上下文按钮 |
| `.t-continuation-context-btn.active` | 弹层展开 |
| `.t-continuation-replay` | 重新演绎 |
| `.t-continuation-send` | 发送 |
| `.t-continuation-send.is-stop` | 生成中（变为中止） |
| `.t-continuation-context-popover` | 上下文弹层 |
| `.t-continuation-context-head` | 弹层标题 |
| `.t-continuation-stepper` | 轮数加减器 |
| `.t-continuation-context-stats` | 轮数下方的统计 |
| `.t-continuation-context-stats.is-warning` | 超预算警告 |

### 新版 —— 工具箱抽屉

| 选择器 | 说明 |
|---|---|
| `.t-toolbox-backdrop` | 遮罩 |
| `.t-toolbox-panel` | 抽屉本体 |
| `.t-toolbox-open .t-toolbox-panel` | 展开态 |
| `.t-toolbox-header` | 抽屉头 |
| `.t-toolbox-close` | 收起按钮 |
| `.t-toolbox-body` | 抽屉主体 |
| `.t-toolbox-section` | 分区 |
| `.t-toolbox-section-title` | 分区标题 |
| `.t-toolbox-grid` | 按钮网格 |
| `.t-toolbox-action` | 功能按钮 |
| `.t-toolbox-action.active` / `.inactive` | 激活 / 停用 |
| `.t-toolbox-action-wide` | 通栏按钮 |
| `.t-toolbox-stop` | 底部「中止当前生成」 |
| `.t-toolbox-stop.is-active` | 生成中 |

抽屉里的具体按钮：`#t-btn-copy`（复制源码）、`#t-btn-new`（新建剧本）、`#t-btn-edit`（编辑剧本）、`#t-btn-run-queue`（开始队列）、`#t-btn-queue-settings`（队列设置）、`#t-btn-debug`（审查 Prompt）、`#t-btn-diagnostics`（诊断日志）、`#t-btn-stop`（中止）。

### 经典版底栏（需带 `.t-layout-legacy` 前缀）

| 选择器（省略前缀） | 说明 |
|---|---|
| `.t-bot-left` | 左侧 2×2 工具网格 |
| `.t-btn-grid` | 网格里的小按钮 |
| `.t-bot-center` | 中间演绎区 |
| `.t-run-group` | 双按钮组 |
| `.t-run-btn` | 演绎按钮 |
| `.t-run-single` | 单次演绎 |
| `.t-run-queue` | 队列生成 |
| `.t-run-queue.active` / `.inactive` | 队列开 / 关 |
| `.t-bot-right` | 右侧辅助区 |
| `.t-btn-aux` | 辅助按钮 |
| `.t-btn-diag` | 诊断日志 |
| `.t-btn-stop` | 中止 |
| `#t-btn-edit` | 编辑剧本 |

---

## 八、剧本选择器

点击剧本卡后从主界面内弹出。

| 选择器 | 说明 |
|---|---|
| `.t-selector-panel` / `#t-selector-panel` | 面板容器 |
| `.t-sel-header` | 顶部搜索行 |
| `.t-sel-search-input` | 搜索框 |
| `.t-sel-sort-select` | 排序下拉 |
| `.t-sel-body` | 主体 |
| `.t-sel-sidebar` | 左侧分类栏 |
| `.t-sel-cat-btn` | 分类按钮 |
| `.t-sel-cat-btn.active` | 当前分类 |
| `.t-sel-grid` | 剧本卡网格 |
| `.t-sel-grid-empty` | 空状态 |
| `.t-script-card` | 剧本卡 |
| `.t-card-title` / `.t-card-desc` / `.t-card-stats` | 卡片标题 / 简介 / 统计 |
| `.t-sel-footer` | 底部栏 |

---

## 九、队列生成

| 选择器 | 说明 |
|---|---|
| `.t-queue-settings` / `#t-queue-settings` | 队列设置面板 |
| `.t-queue-body` / `.t-queue-section` / `.t-queue-label` / `.t-queue-row` | 主体 / 分区 / 标签 / 行 |
| `.t-queue-mode-toggle` | 模式切换组 |
| `.t-queue-mode-btn` | 模式按钮 |
| `.t-queue-mode-btn.active` | 当前模式 |
| `.t-queue-control` | 数量控件 |
| `.t-queue-num-btn` / `.t-queue-num-value` | 加减按钮 / 数值 |
| `.t-queue-select` | 下拉 |
| `.t-queue-script-list` | 剧本列表 |
| `.t-queue-script-item` | 列表项 |
| `.t-queue-script-item.selected` | 已选 |
| `.t-queue-script-name` / `-cat` | 剧本名 / 分类 |
| `.t-queue-status` / `.t-queue-actions` | 状态 / 操作区 |
| `.t-queue-progress` | 进度条容器 |
| `.t-queue-progress-bar` | 进度条 |
| `.t-queue-progress-bar.animated` | 运行中动画 |
| `.t-queue-running-indicator` | 运行中指示器 |

---

## 十、续写

### 续写操作台（完整编辑器）

| 选择器 | 说明 |
|---|---|
| `.t-content-editor` / `#t-continuation-editor` | 面板容器 |
| `.t-cont-composer-head` | 头部 |
| `.t-cont-composer-icon` / `-title` / `-subtitle` | 图标 / 标题 / 副标题 |
| `.t-cont-composer-hint` | 提示文字 |
| `.t-cont-composer-section` / `-label` | 分区 / 标签 |
| `#t-cont-input` | 指令输入框 |
| `.t-cont-count-row` / `.t-cont-char-count` | 字数行 / 字数 |
| `.t-cont-recent-list` / `.t-cont-recent-item` / `.t-cont-recent-empty` | 最近指令列表 / 项 / 空态 |
| `.t-cont-inject-box` / `-head` / `-label` / `-row` | 上下文注入区及其头、标签、行 |
| `.t-cont-rounds-total` | 总轮数 |
| `.t-cont-context-estimate` | 预估 token |
| `.t-cont-context-estimate.is-over-budget` | 超预算 |
| `#t-cont-close` | 关闭 |

### 内容区上的分支浮标

| 选择器 | 说明 |
|---|---|
| `.t-cont-inline-actions` / `#t-cont-inline-actions` | 浮标容器 |
| `.t-cont-inline-actions.is-menu-open` | 菜单展开 |
| `#t-cont-inline-label` | 分支标签文字 |
| `#t-cont-inline-branch` | 分支按钮 |
| `.t-cont-inline-branch-menu` | 分支菜单 |
| `.t-cont-inline-branch-option` | 菜单项 |
| `#t-cont-inline-edit-regenerate` | 修改指令并重生成 |
| `#t-cont-inline-regenerate` | 直接重生成 |
| `.t-cont-regeneration-note` | 重生成说明 |

### 续写历史面板

| 选择器 | 说明 |
|---|---|
| `.t-cont-history-panel` / `#t-continuation-history` | 面板容器 |
| `.t-cont-history-panel.is-managing` | 批量管理模式 |
| `.t-cont-history-header` | 面板头 |
| `.t-cont-history-heading` | 标题行 |
| `.t-cont-history-scope` | 范围切换（当前角色 / 全部） |
| `.t-cont-history-body` | 主体 |
| `.t-cont-history-empty` | 空态 |
| `.t-cont-history-session` | 会话分组 |
| `.t-cont-history-session.is-open` | 展开 |
| `.t-cont-history-session-toggle` | 会话折叠头 |
| `.t-cont-history-branch` | 分支 |
| `.t-cont-history-branch.is-active` | 当前分支 |
| `.t-cont-history-branch-title` | 分支标题 |
| `.t-cont-history-branch-chevron` | 折叠箭头 |
| `.t-cont-history-branch-no` | 分支编号 |
| `.t-cont-history-round` | 单轮 |
| `.t-cont-history-round-head` / `-title` | 轮次头 / 标题 |
| `.t-cont-history-toggle` | 轮次展开按钮 |
| `.t-cont-history-instruction` | 该轮指令 |
| `.t-cont-history-preview` | 内容摘要 |
| `.t-cont-history-full` | 完整预览（内部 iframe，无法注入样式） |
| `.t-cont-history-actions` | 轮次操作区 |
| `.t-cont-history-bulk-bar` | 批量操作条 |
| `.t-cont-history-cross-hint` | 跨角色提示 |

---

## 十一、内容编辑器

编辑生成结果的 HTML 源码。

| 选择器 | 说明 |
|---|---|
| `.t-content-editor` / `#t-content-editor` | 面板容器 |
| `.t-ce-header` | 头部（同时带 `.t-panel-header`） |
| `.t-ce-body` | 主体 |
| `.t-ce-body--stack` | 纵向堆叠变体 |
| `.t-ce-textarea` / `#t-ce-textarea` | 源码输入框 |
| `.t-ce-textarea--grow` | 自动撑高变体 |
| `.t-ce-footer` | 底部（同时带 `.t-panel-footer`） |
| `.t-ce-stats` / `#t-ce-char-count` | 字数区 / 字数 |
| `.t-ce-actions` | 按钮区 |
| `#t-ce-cancel` / `#t-ce-preview` / `#t-ce-save` | 取消 / 预览 / 保存 |
| `#t-ce-close` | 关闭 |

---

## 十二、收藏馆

| 选择器 | 说明 |
|---|---|
| `.t-fav-container` / `#t-favs-view` | 窗口本体 |
| `.t-fav-toolbar` | 工具栏 |
| `.t-fav-tools-drawer` / `.t-fav-drawer-toggle` | 工具抽屉 / 开关 |
| `.t-fav-filter-select` / `.t-fav-search` | 筛选下拉 / 搜索框 |
| `.t-fav-view-toggle` | 视图切换（紧凑 / 海报） |
| `.t-fav-mode-compact` | 紧凑视图（挂在容器上） |
| `.t-fav-grid-area` / `.t-fav-grid` | 网格区 / 网格 |
| `.t-fav-grid.edit-mode` | 批量编辑模式（**只有此态下 `.t-fav-grid` 才是 CSS Grid**） |
| `.t-fav-empty` / `.t-fav-char-empty` | 空态 |
| `.t-fav-card` | 收藏卡 |
| `.t-fav-card.is-active` / `.selected` | 当前 / 已勾选 |
| `.t-fav-card-bg` / `.t-fav-card-poster` / `.t-fav-card-overlay` | 卡片背景 / 海报 / 蒙层 |
| `.t-fav-card-content` / `-header` / `-footer` | 卡片内容 / 头 / 脚 |
| `.t-fav-card-script` / `-char` / `-snippet` | 剧本名 / 角色 / 摘要 |
| `.t-fav-card-checkbox` | 勾选框 |
| `.t-fav-card-chain` / `.t-fav-chain-badge` | 续写链卡片 / 链标记 |
| `.t-fav-carousel-stage` / `-nav` / `-thumbs` | 海报舞台 / 左右翻页 / 缩略图条 |
| `.t-fav-thumb` | 缩略图 |
| `.t-fav-thumb.is-active` | 当前 |
| `.t-fav-reader` / `#t-fav-reader` | 阅读器 |
| `.t-fav-reader.show` | 阅读器打开 |
| `.t-read-header` / `.t-read-actions` | 阅读器头 / 操作区 |
| `.t-read-more-wrap` / `.t-read-more-menu` / `.t-read-more-btn` | 「更多」区 / 菜单 / 按钮 |
| `.t-read-more-menu button.danger` | 危险操作项 |
| `.t-read-body` | 阅读器主体 |
| `#t-read-content` | ★ 收藏内容容器（内部同样是 Shadow DOM） |
| `#t-read-capture-zone` | 导出图片的截取区 |
| `#t-read-open-window.has-interactive` | 含互动内容时的「新窗口打开」 |
| `.t-img-mgr-overlay` / `.t-img-mgr-box` | 配图管理弹窗 |
| `.t-img-list` / `.t-img-item` / `.t-img-preview` | 配图列表 / 项 / 预览 |
| `.t-fav-export-sheet` / `-backdrop` / `-btn` | 导出选项面板 / 遮罩 / 按钮 |

---

## 十三、提示词查看器与诊断

| 选择器 | 说明 |
|---|---|
| `#t-debug-view` | 提示词查看器窗口 |
| `#t-debug-view .t-prompt-source-bar` | 数据来源切换栏 |
| `#t-debug-view .t-prompt-source-tab` | 来源标签 |
| `#t-debug-view .t-prompt-source-tab.active` | 当前来源 |
| `#t-debug-view .t-prompt-info-btn` / `.t-prompt-info-popover` | 说明按钮 / 弹层 |
| `#t-debug-view .t-prompt-summary` | 概要区 |
| `#t-debug-view .t-prompt-count` | 条目/token 计数 |
| `#t-debug-view .t-prompt-tool-btn` | 工具按钮（展开全部等） |
| `#t-debug-view .t-prompt-sections` | 条目列表 |
| `#t-debug-view .t-prompt-section-card` | 单条条目卡 |
| `#t-debug-view .t-prompt-section-card.expanded` | 展开态 |
| `#t-debug-view .t-prompt-role-system` | system 角色卡 |
| `#t-debug-view .t-prompt-role-user` | user 角色卡 |
| `#t-debug-view .t-prompt-role-assistant` | assistant 角色卡 |
| `#t-debug-view .t-prompt-role-label` | 角色标签 |
| `#t-debug-view .t-prompt-name` / `.t-prompt-order` | 条目名 / 序号 |
| `#t-debug-view .t-prompt-section-preview` | 折叠时的摘要 |
| `#t-debug-view .t-prompt-section-content` | 展开后的全文 |
| `#t-debug-view .t-prompt-token-count` | token 数 |
| `#t-debug-view .t-prompt-empty` | 空态 |
| `#t-diagnostics-view` | 诊断日志窗口 |
| `.t-dbg-title-row` | 两个窗口共用的标题行 |
| `.t-diag-notice-band` / `.t-diag-actions` | 提示条 / 操作区 |
| `.t-diag-guide` / `-title` / `-body` | 排查指引 |
| `.t-diag-log-section` / `-title` / `-hint` | 日志区 |
| `#t-diag-log-viewer` | 日志视图 |
| `.t-diag-log-empty` | 日志空态 |
| `#t-diag-clear` / `#t-diag-export` | 清空 / 导出 |

按角色给提示词条目上色是最常见的用法：

```css
#t-debug-view .t-prompt-role-system   { border-left: 3px solid #b794f4; }
#t-debug-view .t-prompt-role-user     { border-left: 3px solid #63b3ed; }
#t-debug-view .t-prompt-role-assistant{ border-left: 3px solid #68d391; }
```

---

## 十四、注入到聊天正文

| 选择器 | 说明 |
|---|---|
| `#t-chat-inject-overlay` | 遮罩层 |
| `.t-chat-inject-window` | 窗口 |
| `.t-chat-inject-body` | 主体 |
| `.t-chat-inject-target` | 目标楼层信息 |
| `.t-chat-inject-visible` | 「对 AI 可见」选项 |
| `.t-chat-inject-list` | 可注入小剧场列表 |
| `.t-chat-inject-item` | 列表项 |
| `.t-chat-inject-item-name` / `-time` / `-preview` | 名称 / 时间 / 摘要 |
| `.t-chat-inject-empty` / `-title` / `-hint` | 空态 |

---

## 十五、世界书筛选

决定哪些世界书条目进入小剧场提示词。

| 选择器 | 说明 |
|---|---|
| `.t-wi-selector` / `#t-wi-selector` | 面板容器 |
| `.t-wi-tabs` / `.t-wi-tab-btn` | 标签栏 / 标签 |
| `.t-wi-tab-btn.active` / `.t-wi-tab-count` | 当前标签 / 计数 |
| `.t-wi-layout` | 两栏布局 |
| `.t-wi-books-pane` / `-header` / `-list` | 左侧世界书栏 |
| `.t-wi-book-item` | 世界书项 |
| `.t-wi-book-item.selected` | 已选 |
| `.t-wi-book-item-dot` / `.active` | 状态点 / 启用中 |
| `.t-wi-booklist-empty` | 空态 |
| `.t-wi-entry-pane` / `-header` / `-title` / `-tools` | 右侧条目栏 |
| `.t-wi-entry-pane-badge.active` / `.inactive` | 启用 / 禁用计数徽标 |
| `.t-wi-entry-search` | 搜索框 |
| `.t-wi-entry-search.has-query .t-wi-search-clear` | 有输入时的清除按钮 |
| `.t-wi-hide-disabled` | 「隐藏已禁用」开关 |
| `.t-wi-entry-list` / `.t-wi-entry` | 条目列表 / 条目 |
| `.t-wi-entry.selected` | 已勾选 |
| `.t-wi-entry-check` / `-content` / `-title` / `-preview` | 勾选框 / 内容 / 标题 / 摘要 |
| `.t-wi-entry-badge--constant` | 蓝灯（常驻）条目 |
| `.t-wi-entry-badge--disabled` | 酒馆已禁用 |
| `.t-wi-uid` | 条目 UID |
| `.t-wi-title-hit` | 搜索命中高亮 |
| `.t-wi-preview-modal` / `-box` / `-content` | 条目预览弹窗 |
| `.t-wi-load-error` | 加载失败提示 |
| `#t-wi-stat` | 底部统计 |

---

## 十六、剧本管理器

| 选择器 | 说明 |
|---|---|
| `#t-mgr-view` | 窗口本体 |
| `.t-mgr-body` | 主体 |
| `.t-mgr-sidebar` / `.t-mgr-sb-group` / `.t-mgr-sb-title` | 左侧分类栏 |
| `.t-mgr-sb-item` | 分类项 |
| `.t-mgr-sb-item.active` | 当前分类 |
| `#t-mgr-cat-list` | 分类列表 |
| `.t-mgr-main` | 右侧主区 |
| `.t-mgr-toolbar` / `.t-mgr-search` / `.t-mgr-sort` | 工具栏 / 搜索 / 排序 |
| `.t-mgr-overview` / `.t-mgr-ov-meta` / `.t-mgr-ov-top` / `.t-mgr-ov-item` | 统计概览 |
| `.t-mgr-list` / `.t-mgr-item` | 剧本列表 / 项 |
| `.t-mgr-item-title` / `-desc` / `-stats` / `-meta` | 标题 / 简介 / 统计 / 元信息 |
| `.t-mgr-tag` | 标签 |
| `.t-mgr-tag--preset` | 官方预设标签 |
| `.t-mgr-item-check-col` | 勾选列 |
| `.t-batch-active` | 批量模式（挂在容器上） |
| `.t-batch-elem` | 仅批量模式可见的元素 |
| `.t-mgr-footer-bar` | 底部操作条 |

---

## 十七、通用组件

这些类在小剧场各界面里反复出现，改一处会全局生效。

| 选择器 | 说明 |
|---|---|
| `.t-root` | 插件作用域根（字号/字体/文字色基准） |
| `.t-overlay` | 全屏遮罩 |
| `.t-box` | 窗口本体 |
| `.t-header` | 窗口标题栏 |
| `.t-panel-header` / `.t-panel-footer` | 面板头 / 脚 |
| `.t-title-container` / `.t-title-main` / `.t-title-sub` | 标题区 |
| `.t-close` | 关闭按钮（× 字形） |
| `.t-tool-btn` | 工具按钮 |
| `.t-tool-btn.t-btn-danger` | 危险态工具按钮 |
| `.t-btn` | 标准按钮 |
| `.t-btn--primary` / `--secondary` / `--danger` / `--success` / `--brand` / `--ghost` / `--quiet` / `--glass` | 按钮变体 |
| `.t-btn--xs` / `--sm` / `--lg` / `--block` / `--inline` | 按钮尺寸 |
| `.t-btn.active` / `.is-active` / `:disabled` | 按钮状态 |
| `.t-btn__icon` | 按钮内图标 |
| `.t-icon-btn` | 纯图标按钮 |
| `.t-dialog-overlay` / `.t-dialog-box` / `.t-dialog-panel` | 对话框遮罩 / 盒 / 面板 |
| `.t-dialog-header` / `.t-dialog-body` / `.t-dialog-footer` / `.t-dialog-close` | 对话框各部件 |
| `.t-dialog-body--flush` / `--tight` / `--clip` / `--stack` | 对话框主体变体 |
| `.t-form-group` / `.t-form-label` | 表单组 / 标签 |
| `.t-root .t-box .t-input` | 输入框（见下方特异度说明） |
| `.t-root .t-choice-input` | 勾选/单选控件（见下方特异度说明） |
| `.t-flex-1` / `.is-hidden` / `.t-shrink-0` | 布局工具类 |

⚠️ 输入框和勾选控件的插件规则**自带祖先层级**：`.t-root.t-box .t-input`（0,3,0）与 `.t-root .t-choice-input`（0,2,0）。只写 `.t-input { ... }`（0,1,0）不会生效，必须照抄同样的层级：

```css
.t-root .t-box .t-input { border-color: #7dd3fc; }
.t-root .t-choice-input { accent-color: #7dd3fc; }
```

滚动条样式对**所有** `t-` / `titania-` 前缀的元素及其后代生效，通过 token 调整：

```css
.t-root {
    --t-color-scrollbar-thumb: rgb(120 140 160 / .5);
    --t-color-scrollbar-thumb-hover: rgb(140 165 190 / .7);
}
```

---

## 十八、主题变量

改 token 比改具体规则更省事，一处生效全局，且深浅主题都跟着走。

深色主题是 `:root` 的无条件声明；浅色主题通过 `documentElement` 上的 `data-t-theme="light"` 生效（深色是**移除该属性**，不存在 `data-t-theme="dark"`）。

```css
/* 两种主题都改 */
:root { --t-color-accent: #7dd3fc; }

/* 只改浅色主题 */
:root[data-t-theme="light"] { --t-color-accent: #0284c7; }
```

### 常用 token

| 类别 | Token |
|---|---|
| 背景层 | `--t-color-bg` `--t-color-surface` `--t-color-surface-inset` `--t-color-surface-sunken` `--t-color-surface-elevated` `--t-color-surface-hover` `--t-color-surface-active` |
| 文字 | `--t-color-text` `--t-color-text-strong` `--t-color-text-secondary` `--t-color-text-label` `--t-color-text-muted` `--t-color-text-dim` `--t-color-text-faint` `--t-color-text-disabled` `--t-color-text-on-accent` |
| 描边 | `--t-color-border` `--t-color-border-subtle` `--t-color-border-strong` `--t-color-border-bright` `--t-color-border-control` `--t-color-border-glass` |
| 强调色 | `--t-color-accent` `--t-color-accent-hover` `--t-color-accent-active` `--t-color-accent-soft` `--t-color-accent-border` |
| 品牌色 | `--t-color-brand` `--t-color-brand-strong` `--t-color-brand-soft` `--t-color-brand-border` |
| 语义色 | `--t-color-success` `--t-color-warning` `--t-color-danger` `--t-color-notify`（各自另有 `-soft` / `-border` 变体） |
| 窗口 | `--t-color-window-header` `--t-color-panel-header` `--t-color-dialog-surface` `--t-color-dialog-scrim` `--t-color-scrim` |
| 圆角 | `--t-radius-window` `--t-radius-container` `--t-radius-panel` `--t-radius-control` `--t-radius-inline` `--t-radius-track` `--t-radius-circle` |
| 字体 | `--t-font-global` `--t-font-size-root` `--t-ui-font-scale` |
| 滚动条 | `--t-color-scrollbar-thumb` `--t-color-scrollbar-thumb-hover` `--t-color-scrollbar-thumb-active` |
| 焦点 | `--t-color-focus-ring` |

⚠️ 设置页里配了自定义字体时，插件会把 `--t-font-global` 写成 `:root` 的**行内样式**，你在样式表里对 `:root` 设同名变量会失效。改到更内层即可：

```css
.t-root { --t-font-global: "LXGW WenKai", serif; }
```

---

## 十九、常用配方

```css
/* 1. 主界面加宽、圆角更柔和 */
#t-main-view {
    max-width: 1100px;
    border-radius: 14px;
}

/* 2. 内容区留白，让生成内容不贴边 */
.t-shadow-host { padding: 16px 20px; }

/* 3. 只改经典版布局的演绎按钮 */
#t-main-view.t-layout-legacy .t-run-single {
    background: linear-gradient(135deg, #7c3aed, #4c1d95);
}

/* 4. 沉浸阅读时给内容区加深底色 */
#t-main-view.t-zen-mode .t-content-area {
    background: rgb(0 0 0 / .35);
}

/* 5. 生成中的悬浮球换个颜色 */
#titania-float-btn.t-loading {
    box-shadow: 0 0 18px rgb(124 58 237 / .8);
}

/* 6. 收藏馆批量编辑模式改成固定两列（普通视图的 .t-fav-grid 不是 Grid） */
.t-fav-grid.edit-mode { grid-template-columns: repeat(2, 1fr); }

/* 7. 缩小整个插件 UI（不影响生成内容字号） */
.t-root { --t-ui-font-scale: .9; }

/* 8. 隐藏统计条 */
.t-stats-hud { display: none !important; }

/* 9. 手机端把第二栏的剧本简介藏掉腾出宽度 */
@media screen and (max-width: 600px) {
    .t-trigger-desc { display: none; }
}
```

---

## 二十、本文档的范围

**已收录**：入口按钮与悬浮球、主界面（两套布局全部四栏）、内容区与翻页、工具箱、剧本选择器、队列生成、续写（操作台 / 历史 / 分支浮标）、内容编辑器、收藏馆、提示词查看器与诊断、注入聊天正文、世界书筛选、剧本管理器、通用组件与主题变量。

**未收录**（属于其他功能界面）：文本改写、故事大纲与细纲、设定维护＆聊天总结、记忆召回、向量化清洗预览、回声工坊、插件设置页本体。

**改不到的地方**：生成内容内部（Shadow DOM）、收藏阅读器内容内部（Shadow DOM）、续写历史的完整预览（iframe）、提示词条目编辑弹窗（独立 Shadow DOM，用 `all: initial` 完全隔离）。
