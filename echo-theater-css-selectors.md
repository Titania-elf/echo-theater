# 回声小剧场 CSS 选择器参考清单

> 适用版本：Titania Theater（回声小剧场）1.14.x 结构
> 
> 说明：本清单面向有前端基础的用户，用于在自定义 CSS 时快速定位对应 UI 区域。

## 使用建议

- 优先使用 `.t-` 前缀类与 `#t-` / `#titania-` 前缀 ID。
- 状态类常见：`.active`、`.selected`、`.show`、`.inactive`、`.is-active`。
- 移动端差异通常在 `@media (max-width: 600px)` 或相近断点下。
- 建议将样式写入插件的“自定义 CSS 样式”编辑器中，便于统一管理。

---

## 1) 基础窗口与通用组件

- `.t-overlay`：全屏遮罩层
- `.t-box`：通用弹窗容器（多数窗口基类）
- `.t-header`：弹窗头部栏
- `.t-title-main`：主标题文字
- `.t-title-sub`：副标题文字
- `.t-btn`：通用按钮
- `.t-btn.primary`：主按钮
- `.t-tool-btn`：小型工具按钮
- `.t-icon-btn`：图标按钮
- `.t-close`：关闭按钮
- `.t-input`（常见为 `.t-box .t-input`）：输入框/文本域

---

## 2) 悬浮球与侧滑菜单

- `#titania-float-btn`：悬浮球本体
- `#titania-timer`：悬浮球计时器
- `#titania-slide-menu`：侧滑菜单容器
- `.t-menu-icon-btn`：菜单图标按钮基础样式
- `.t-menu-icon-btn.main`：剧场入口按钮
- `.t-menu-icon-btn.lore`：设定提取按钮
- `.t-menu-icon-btn.outline`：故事大纲按钮
- `.t-menu-icon-btn.settings`：设置按钮
- `.t-menu-icon-btn.favs`：收藏按钮
- `.t-menu-icon-btn.scripts`：剧本管理按钮
- `.t-menu-icon-btn.debug`：调试按钮
- `.t-menu-icon-btn.model`：模型切换按钮
- `.t-menu-icon-btn.cancel`：中止按钮
- `.t-menu-icon-btn.recall`：记忆召回按钮
- `#titania-menu-backdrop`：菜单外部点击遮罩

---

## 3) 主演绎窗口

- `#t-main-view`：主窗口容器
- `.t-content-wrapper`：内容区外层
- `.t-content-area`：滚动内容区
- `#t-output-content`：模型输出渲染根容器
- `.t-content-iframe`：输出 iframe
- `.t-top-bar`：顶部操作栏
- `.t-bottom-bar`：底部操作栏
- `.t-history-toggle`：历史开关块
- `.t-mode-toggle` / `.t-mode-btn`：生成模式切换
- `.t-trigger-card`：当前剧本卡片
- `.t-filter-btn` / `.t-dice-btn`：筛选与随机按钮
- `.t-run-group` / `.t-run-btn`：主运行按钮组
- `.t-run-single`：单次演绎按钮
- `.t-run-queue`：队列演绎按钮
- `.t-btn-grid`：底部左侧小按钮
- `.t-btn-aux`：底部右侧小按钮
- `.t-stats-hud`：内容统计 HUD
- `.t-page-nav` / `.t-page-prev` / `.t-page-next`：翻页按钮

---

## 4) 世界书选择器（主窗口内）

- `.t-wi-selector`：世界书选择器面板
- `.t-wi-layout`：左右布局容器
- `.t-wi-books-pane` / `.t-wi-books-list`：左侧书列表区
- `.t-wi-book-item`：书项
- `.t-wi-book-item.selected`：选中书项
- `.t-wi-entry-pane` / `.t-wi-entry-list`：右侧条目区
- `.t-wi-entry`：条目卡片
- `.t-wi-entry.selected`：选中条目
- `.t-wi-preview-modal` / `.t-wi-preview-box`：条目预览弹窗

---

## 5) 队列设置面板

- `.t-queue-settings`：队列设置弹窗
- `.t-queue-mode-btn`：模式切换按钮
- `.t-queue-script-list`：剧本列表
- `.t-queue-script-item`：剧本项
- `.t-queue-script-item.selected`：选中剧本项
- `.t-queue-progress`：队列进度条容器
- `.t-queue-progress-bar`：进度条

---

## 6) 剧本管理器

- `#t-mgr-view`：管理器主窗
- `.t-mgr-sidebar`：左侧分类栏
- `.t-mgr-sb-item`：分类项
- `.t-mgr-sb-item.active`：当前分类
- `.t-mgr-main`：主内容区
- `.t-mgr-toolbar`：工具栏
- `.t-mgr-list`：剧本列表
- `.t-mgr-item`：剧本项
- `.t-mgr-item-title`：剧本标题
- `.t-mgr-item-desc`：剧本描述
- `.t-selector-panel`：剧本选择器面板

---

## 7) 收藏 / 图鉴

- `.t-fav-container`：收藏窗口容器
- `.t-fav-toolbar`：顶部工具栏
- `.t-fav-grid-area`：内容区域
- `.t-fav-carousel-stage`：轮播舞台
- `.t-fav-card`：收藏卡片
- `.t-fav-card.is-active`：当前激活卡片
- `.t-fav-card-bg`：背景层
- `.t-fav-card-poster`：主图层
- `.t-fav-card-overlay`：叠加层
- `.t-fav-card-content`：文字信息层

> 备注：旧提示中偶见 `.t-fav-item`，当前主要卡片选择器为 `.t-fav-card`。

---

## 8) 设置窗口（插件内部弹窗）

- `#t-settings-view`：设置主窗
- `.t-set-nav`：左侧导航
- `.t-set-tab-btn`：标签按钮
- `.t-set-content`：右侧内容区
- `.t-set-page.active`：当前激活页
- `.t-code-editor`：CSS 编辑器文本域
- `.t-css-hints`：选择器提示列表容器
- `.t-css-hint-item`：提示项

---

## 9) SillyTavern 扩展设置抽屉（settings.html）

- `#titania-settings-drawer`：抽屉根节点
- `.titania-panel-grid`：卡片网格
- `.titania-panel-card`：信息卡片
- `.titania-switch-row`：开关行
- `.titania-update-btn`：更新按钮
- `.titania-mini-btn`：导入/导出按钮

---

## 10) 快速示例

```css
/* 统一弹窗背景与圆角 */
.t-box {
  background: #161a22;
  border-radius: 14px;
}

/* 主窗口标题色 */
.t-title-main {
  background: none;
  -webkit-text-fill-color: #ffd27a;
  color: #ffd27a;
}

/* 悬浮球边框增强 */
#titania-float-btn {
  border-width: 3px;
  box-shadow: 0 0 16px rgba(255, 210, 122, 0.4);
}

/* 主演绎内容区域内边距 */
.t-content-area {
  padding: 12px;
}
```

---

## 11) 维护说明

- 该清单基于当前代码结构整理，插件后续更新可能新增或重命名选择器。
- 建议每次升级后对照 `css/*.css` 与 `settings.html` 快速复核。
