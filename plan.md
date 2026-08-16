# UI / CSS 架构重构执行计划

> **版本**:1.0
> **制定日期**:2026-08-16
> **适用项目版本**:5.2.5
> **状态**:待启动(Phase 0 未开始)

## 阅读指引

本文是**执行计划**,不是设计随笔。使用方式:

- 每个 Phase 都有**任务清单 / 完成判据 / 回滚方式**,可独立发版。
- 第 2 节的缺陷清单可**立即动手**,不依赖任何前置。
- 第 5 节的 token 定义是**可直接落盘的草稿**,不需要二次设计。
- 第 3 节的决策记录说明了**为什么不做某些事**,改主意前请先读它。
- 第 11 节的审计脚本是**防回归的唯一措施**,不要跳过。

本计划的核心原则:**渐进式、每步可发版、Phase 1 视觉零变化、不重写业务逻辑。**

---

## 0. 目标与非目标

### 0.1 目标

建立可长期维护的四层结构:

```
功能视图 (feature)
    ↓ 只做布局,不定义组件视觉
语义化 UI 组件 (component)
    ↓ 只消费语义 token,不含字面量
Design Tokens (semantic → primitive)
    ↓
Theme (dark / light / …)
```

达成后:

- 所有按钮、输入框、卡片、弹窗、标签页有单一视觉规范
- 页面之间不再各自定义一套按钮样式
- 主题切换只改主题变量,不改任何组件文件
- 新增组件可直接复用既有组件样式
- inline style 与 JS 硬编码视觉样式降到接近零

### 0.2 非目标(本计划明确不做)

| 不做 | 原因 |
|---|---|
| 制作日间(Light)主题 | 本次只建架构。Light Theme 的落地方式见第 15 节 |
| 为"更好看"改动 UI 布局 | 布局变更与架构重构必须分离,否则回归无法归因 |
| 重写业务逻辑 | 19 个 `ui/*.js` 的渲染逻辑一行不动(除类名替换与 inline style 迁移) |
| 引入 UI 组件库 / 框架 | 见 ADR-01 |
| 使用 CSS `@layer` | 见 ADR-03 |
| 使用 CSS 预处理器(Sass/Less) | 见 ADR-05 |
| 把 CSS 合并成单文件 | 分层目录是本方案的核心产出 |
| 删除全部 CSS 重写 | 全程保留兼容层,逐组件迁移 |
| 做 `follow-st` 跟随酒馆主题 | 见 ADR-06(降级为范围外备注) |

---

## 1. 现状实测基线

以下全部为 5.2.5 实测值,作为验收对比基准。

### 1.1 规模

| 项目 | 值 |
|---|---|
| CSS 文件 | 12 个 / **14,509 行** / 约 2,059 条规则 |
| 最大文件 | `main-window.css` 3,771 行(518 规则)、`lore-review.css` 2,351 行(349 规则) |
| 样式来源 | **3 处**:`css/*.css`、`settings.html` 内嵌 `<style>`(121 行)、JS 运行时注入 `<style>`(8 处) |
| CSS 清单 | **2 份手写且已漂移**(`build.js:22` 12 个 / `dom.js:18` 11 个) |
| UI JS | 19 个 `ui/*.js`;`$()` 1,872 次、`.html()` 155 次、`innerHTML` 32 次 |
| 运行时依赖 | **0 个**;devDependency 仅 `esbuild ^0.24` |
| 产物 | `index.js` 1.67 MB(未压缩) |

### 1.2 硬编码与重复(验收对照表)

| 指标 | 现状 | Phase 7 目标 |
|---|---:|---:|
| hex 颜色字面量 | 1,181 | < 60 |
| rgb/rgba 字面量 | 749 | < 40 |
| **颜色字面量合计** | **1,930** | **< 100** |
| CSS 变量(已声明) | 8 | ~110 |
| CSS 变量(消费但未声明) | 3 | 0 |
| `border-radius` 声明 / 不同值 | 315 / ~30 | 315 / 8 |
| `box-shadow` 声明 / 不同值 | 112 / ~40 | 112 / 9 |
| `font-size` 声明(px / em) | 418(151 / 262) | 418(< 15 / 余下) |
| `transition` 声明 / `all 0.2s` | 134 / 45 | 134 / 0 |
| `padding` / `gap` 声明 | 476 / 325 | 同数量,值全部 token 化 |
| `z-index` 不同值(CSS + JS) | 37 + 10 | 8 |
| `!important` | 76 | < 20(每处带注释) |
| `@media` 块 / 不同断点 | 34 / 10 | 34 / 3 |
| `@keyframes` | 25(3 组重复 + 2 个无前缀) | ~18(全部 `t-` 前缀) |
| inline `style="…"`(静态 / 数据驱动) | 583(556 / 27) | ~30(0 / ~30) |
| 含硬编码颜色的 inline style | 255 | 0 |
| jQuery `.css()` / `.style.x=` / `cssText` | 86 / 21 / 8 | < 20 / < 10 / < 4 |
| 按钮类名 / 基态规则 | 61 / 68 | ~12 / ~25 |
| 卡片类名 | 44 | ~6 |
| 弹窗系统 / 相关类名 | 3 套 / 33 | 1 套 / ~12 |
| 空态·加载类名 | 23 | ~4 |
| 字节级重复声明块(≥4 声明) | 23 组 | 0 |
| 跨文件冲突定义的类 | 5 个 | 0 |
| **CSS 总行数** | **14,509** | **9,000 ~ 10,500** |

### 1.3 配色碎片化(各文件强调色家族命中次数)

| 文件 | 金 `#bfa15f` | Chakra 蓝灰 | 青绿 | 紫粉 | 红 | 绿 | 琥珀 |
|---|---:|---:|---:|---:|---:|---:|---:|
| favs.css | **28** | · | · | · | 1 | · | · |
| lore-review.css | 4 | **126** | · | · | 10 | 22 | 13 |
| memory-recall.css | · | · | · | **24** | 1 | · | · |
| story-outline.css | 3 | · | **32** | · | 2 | · | · |
| floating.css | · | 11 | **32** | 6 | 6 | · | · |
| main-window.css | **45** | **51** | 10 | · | · | · | 1 |
| settings.css | 12 | 14 | 15 | 3 | 1 | · | · |
| settings.html `<style>` | · | 第 13 套(`#d8e4f0`/`#93a8bb`/`#dce7f3`/`#d5e2ef`,在 12 个 CSS 里 0 次出现) | | | | | |

`lore-review.css` 的 126 处是 **Chakra UI 默认色板原值**(`#90cdf4`=blue.200、`#4299e1`=blue.500、`#a0aec0`=gray.400、`#48bb78`=green.400、`#f56565`=red.400、`#4a5568`=gray.600),与项目金色品牌无关,属整段复制引入的第二套设计语言。

---

## 2. 已确认缺陷清单

以下均已定位到 `file:line`,**属于 bug 而非风格问题,Phase 0 直接修**。

| # | 缺陷 | 位置 | 后果 |
|---|---|---|---|
| **B1** | CSS 清单漂移:`dom.js` 缺 `workshop.css` | `src/utils/dom.js:18-31` vs `build.js:22-36` | **开发模式(未打包)下工坊窗口完全无样式** |
| **B2** | 全局滚动条泄漏 | `css/base.css:236-252` 的 `::-webkit-scrollbar` 无作用域 | 插件 `<style>` 在 `document.head` 注入,晚于 ST 样式表 → **重写了整个 SillyTavern 的滚动条**(ST 自己在 `public/style.css:168` 定义) |
| **B3** | keyframes 全局命名冲突 | `base.css:255` `@keyframes fadeIn`、`manager.css:259` `@keyframes slideUp` | 无 `t-` 前缀,与 ST 及其它第三方扩展的同名动画冲突 |
| **B4** | keyframes 重复家族 | `floating.css:45/141/182` 的 `t-ripple-*`/`t-arc-*`/`t-notify-glow` ↔ `settings.css:407/451/506` 的 `p-ripple-*`/`p-arc-*`/`p-notify-glow` | 悬浮球动画改一次要改两处(真球 + 设置页预览球) |
| **B5** | 变量被消费但从未声明 | `--t-border-color`(14 次)、`--t-border-color-rgba`(4 次)、`--t-bg-color`(1 次),仅由 `floatingBtn.js:604-609` 写在元素上 | 全部靠 `var(x, fallback)` 兜底,fallback 里埋了 5 个不同硬编码色(`#444`/`#90cdf4`/`#a29bfe`/`#74b9ff`/`#55efc4`) |
| **B6** | 跨功能样式污染 | `story-outline.css:13` `.t-dialog-overlay`、`:31` `.t-dialog-box` 在**顶层**重定义;该文件在打包序列**最末** | **污染 lore-review 的全部对话框**(`max-height` 被改为 `min(82dvh,82vh)`) |
| **B7** | 同名类冲突定义 | `.t-btn-danger`:`floating.css:741`(`#e74c3c` + `!important`)vs `lore-review.css:1567`(`#f56565`) | 后写的定义失效,靠 `!important` + 打包顺序维持偶然平衡 |
| **B8** | 弹窗根缺排版基准 | `.t-dialog-box`、`.t-model-dialog-box`、`.t-imp-modal`、`.t-outline-add-sheet`、`.t-fav-export-sheet`、`.titania-update-dialog` **6 个根**均无 `font-size` / `font-family` | 其内 `em` 字号相对 ST body 解析;**用户「UI 缩放」设置在这些弹窗内完全失效** |
| **B9** | 硬编码字体绕过用户设置 | `floating.css` `.t-model-dialog-box` 写死 `font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif` | 忽略 `--t-font-global`,用户自定义字体在该弹窗无效 |
| **B10** | 同一组件跨文件切分 | `.titania-mini-btn` 主体在 `settings.html:227`,但 `.is-update` 变体在 `settings.css:77` | 改这个组件要同时改 HTML 与 CSS 两处 |
| **B11** | 同文件内重复定义 | `manager.css:358` `.t-sel-cat-btn`(`padding:8px 12px; radius:4px`)与文件后段第二处(`padding:6px 12px; bg:#222`) | 后者静默覆盖前者 |
| **B12** | 同一组件三份独立实现 | `.t-set-tab-btn`:`settings.css:310`(全局)、`lore-review.css:975`(`#t-lore-settings-dialog` 提权)、`story-outline.css:64`(`#t-outline-prompt-manager` 提权,与 settings 版**逐字节相同**),另有 3 个移动端变体 | 6 段规则 / 3 套数值 / 2 处 ID 提权 |
| **B13** | 基础组件定义错误需双处打补丁 | `base.css:178` `.t-icon-btn` 是 `1.2em` 裸图标 + `margin-left`,点击热区仅字形本身;`main-window.css:25` 用 4 层选择器修正,`workshop.css` 复制同一段修正 | 注释已明确记录原因,但无人敢改源头 |

### 2.1 结构性阻碍(非 bug,但阻塞 Light Theme)

| # | 内容 | 位置 | 说明 |
|---|---|---|---|
| **S1** | 输入框被 `!important` 钉死为深色 | `base.css:205-227`,注释写明「强制覆盖亮色主题」 | **只要这三行在,插件自己的 Light Theme 物理上不可能。** 这是「先解决架构再做日间主题」的最直接证据 |
| **S2** | 61 个原生表单控件未样式化 | JS 模板中 45 个 `checkbox` + 16 个 `radio`(`<input>` 共 134 个,仅 58 个带 class) | 直接继承 ST 主题渲染 → 插件在 ST 亮色主题下「半黑半白」 |
| **S3** | `--t-theme` 语义重载 | 金色同时充当「品牌色」(`workshop.css` 卡片强调)与「焦点/激活色」(`base.css:219` input focus、`manager.css` 分类激活) | 而事实上的交互色是 `#90cdf4`(64 次)。二者必须拆开,因为金色在浅底上对比度不足 |
| **S4** | 两套 primary 约定 | `.t-btn.primary`(`base.css:137`,粉渐变,6 个 JS 文件使用)vs `.t-btn-primary`(`lore-review.css:444`,蓝渐变,3 个 JS 文件使用) | 同一插件内「主按钮」有两种长相 |

---

## 3. 决策记录(ADR)

> 改变以下任一决策前,请先读它的理由。

### ADR-01:不引入 UI 组件库 / 框架

**决策**:采用「自建 CSS-only 语义层 + 定点复用 ST 能力 + 手抄 Open Props 尺度参考」。

**依据**:

| 方案 | 判定 | 理由 |
|---|---|---|
| React / Vue / Element / Ant | ✗ 拒绝 | 需引入 130 KB / 34 KB 运行时 + 重写 19 个 `ui/*.js`;组件库 reset 会碰 `body` 污染 ST;需新增构建插件 |
| Shoelace 等 Web Components | ✗ 拒绝 | 需把 `<button class="t-btn">` 改成 `<sl-button>` 并把 1,872 处 jQuery 事件委托改为自定义事件监听 = 重写全部 UI 层。且 **Shadow DOM 会切断 `$(document).on('click','.t-xxx')` 委托模式**,而项目全靠它 |
| Pico.css / Water.css | ✗ 拒绝 | classless 设计直接给 `button`/`input` 元素选择器上样式 → **与 ST 共享 document 会立即污染整个 SillyTavern** |
| **Open Props** | ⚠ 有条件采纳 | 纯变量集、零 JS、无元素选择器。但**只抄不装**:把需要的 ~40 个尺度值手抄进 `primitives.css`,不加为依赖(总量不到 60 行,不值得建立依赖关系) |
| 复用 ST 能力 | ✓ 定点采纳 | 见 ADR-02 |
| **自建 CSS-only 语义层** | ✓ **主方案** | 与「模板字符串 + jQuery」渲染范式 100% 契合;0 KB 运行时;无需新构建工具 |

**关键判断**:问题的本质不是「缺组件」,而是「缺 token 和缺组件契约」——这两件事 CSS-only 方案能完全解决。且本次真实工作量在**删 12,000 行重复**,不在写新 CSS;组件库替代不了这件事。

### ADR-02:定点复用 SillyTavern 的能力,但不依赖其 token

**采纳**:

- **Toast:完全用 ST 的 `toastr`,不自建。** 已有 253 处调用,自建纯属负债。
- **简单确认/输入弹窗:评估改用 ST 的 `callGenericPopup`**(当前 0 次使用)。ST 已提供遮罩 / ESC / 焦点陷阱,可直接减少一批 33 个弹窗类名。
- **注入到 ST DOM 的按钮保持独立,不进插件组件体系。** `chatInjectButton.js:58` 的 `className = "mes_button titania-inject-btn fa-solid …"` 是**故意**继承 ST 的 `.mes_button`;`main-window.css:3618` 的注释已写明「挂在 ST 的 `.extraMesButtons` 里,继承 `.mes_button` 的尺寸与交互,只改配色」。这类元素必须与 ST 消息按钮融合,而非与插件 UI 融合。**同类:`.titania-recall-btn`。**

**不采纳**:

- **不把 `--SmartTheme*` 当作 token 层。** ST 只暴露 16 个 `--SmartTheme*`(共 109 个 CSS 变量),**没有表面层级 / 间距 / 圆角 / 阴影尺度**;且属 ST 内部实现,升级可能改名。现有 8 处引用(全在 `memory-recall.css`)的**带 fallback 写法是正确的,应保持**。

### ADR-03:禁止使用 CSS `@layer`

**决策**:分层只在「目录组织 + 文件拼接顺序 + 审计规则」层面实现,**不使用 `@layer` 语法**。

**理由**:CSS 级联规定**未分层声明的优先级高于所有分层声明**。已实测 **SillyTavern 全库 `@layer` 命中 0 处**。一旦把插件 CSS 包进 `@layer`,在特异性相同时插件规则会**全面输给 ST 规则**,外观被宿主主题穿透——这恰是 S1 那三行 `!important` 当初在防的事。

**替代**:特异性由 `.t-root` 作用域根提供的两级选择器保证(见第 8 节)。

### ADR-04:颜色 token 必须使用 RGB 通道三元组

**决策**:原语层以 `--t-c-*-rgb: R G B`(空格分隔)为主体,语义层用 `rgb(var(--t-c-x-rgb) / α)` 消费。

**理由**:现状有 **749 个 `rgba()` 字面量**,其中 `rgba(255,255,255,α)` 119 次、`rgba(144,205,244,α)` 48 次、`rgba(191,161,95,α)` 23 次。`rgba()` **无法接收 hex 变量**,若只定义 `--t-accent: #90cdf4`,这 190+ 处半透明用法全都无法 token 化,主题切换会大量残留硬编码。

**明确不使用 `color-mix()`**:需 Chrome 111+ / FF 113+(2023),对老旧移动端 WebView 有风险。空格分隔 + 斜杠 alpha 自 Chrome 65 / FF 52 起支持,覆盖面足够。

### ADR-05:排版单位用 `em`,不用 `rem`,不引入预处理器

**`em` 而非 `rem`**:UI 缩放功能的实现方式是在容器上写 `font-size: calc(12px * var(--t-ui-font-scale))`(`settingsWindow.js:2353` 把 `--t-ui-font-scale` 写到 `documentElement`)。**`rem` 相对 `html` 根字号,会完全绕过这个机制,导致缩放功能失效。** 现有 262 个 `em` 是正确的,151 个 `px` 才是 bug。

**不引入 Sass/Less**:纯 CSS 自定义属性已满足全部需求,且运行时可变(预处理器变量不行)——而运行时可变正是主题切换的前提。引入预处理器只会增加构建复杂度并削弱主题能力。

### ADR-06:`follow-st`(跟随酒馆主题)降级为范围外备注

**决策**:不作为交付项,**且明确不用它作为 Phase 6 的验证手段**。

**理由**:

1. **验证路径最脆弱**:它依赖 ST 内部变量名(见风险 R6),用最不稳定的依赖验证自己的机制,逻辑不成立。
2. **验证不到位**:ST 只有 16 个变量,45 个语义 token 里**大部分仍停在暗色默认值上未被触发**。看似「切换成功」,实际没证明 token 层完整可达——而这是 Phase 6 唯一需要证明的事。
3. **它是新功能,不是测试夹具**:拿一个要跟 ST 版本赛跑的用户可见功能当验收标准,会把成本永久化。

**技术可行性仍然成立**(依据:ST 暴露 16 个 `--SmartTheme*`;`memory-recall.css` 已有 8 处正确用法),但价值有限(只能跟随主色调)、维护成本明确。**若将来要做,它是 Light Theme 之后的可选项,不是前置条件。**

**Phase 6 改用一次性内部探针主题验证,见第 12.7 节。**

---

## 4. 目标目录结构

```
css/
├── manifest.js                   ★ 单一数据源:有序文件清单
│                                   build.js 与 dom.js 都从此读取(修 B1)
│
├── 00-tokens/                    【第 0 层:Design Tokens】
│   ├── primitives.css              灰阶 / 色相 / 尺度梯级(与主题无关)
│   ├── semantic.css                语义 token 的声明与文档注释
│   ├── theme-dark.css              暗色主题:语义 → 原语绑定(= 当前视觉)
│   ├── theme-light.css             ← Phase 6 之后新增,本计划不创建
│   └── legacy-aliases.css          ⚠ 旧变量名 → 新 token(Phase 7 删除)
│
├── 01-base/                      【第 1 层:作用域与基础】
│   ├── scope.css                   ★ .t-root:字体基准 / color-scheme / 盒模型
│   ├── typography.css              .t-root 内的标题 / 正文 / 代码基础排版
│   ├── scrollbar.css               ★ 从 base.css 迁出并加作用域(修 B2)
│   └── keyframes.css               ★ 全部 keyframes 集中 + t- 前缀(修 B3/B4)
│
├── 02-components/                【第 2 层:语义化组件】禁止页面/ID 选择器
│   ├── button.css                  .t-btn + 6 变体 + 4 尺寸
│   ├── icon-button.css             .t-icon-btn(修正热区,修 B13)
│   ├── field.css                   .t-input / .t-textarea / .t-select / .t-field
│   ├── switch.css                  .t-switch / .t-checkbox / .t-radio(解 S2)
│   ├── card.css                    .t-card + __head/__body/__footer + --interactive
│   ├── panel.css                   .t-panel + __head/__body/__footer
│   ├── window.css                  .t-box + .t-header / .t-footer
│   ├── dialog.css                  .t-dialog(遮罩/容器/头/体/脚/关闭)+ .t-sheet
│   ├── tabs.css                    .t-tabs / .t-tab / .t-segmented(解 B12)
│   ├── badge.css                   .t-badge / .t-tag
│   ├── menu.css                    .t-menu / .t-menu__item(仅视觉,不含定位逻辑)
│   ├── hint.css                    .t-hint(内联提示条)
│   ├── empty-state.css             .t-empty
│   ├── spinner.css                 .t-spinner / .t-skeleton
│   └── _legacy.css                 ⚠ 旧类名 → 新实现映射(Phase 7 删除)
│
├── 03-layout/                    【第 3 层:布局原语】无颜色,只有排列
│   ├── stack.css                   .t-row / .t-col / .t-gap-{2xs..3xl}
│   ├── grid.css                    .t-grid / .t-grid--auto
│   └── responsive.css              断点约定与共用响应式辅助
│
├── 04-features/                  【第 4 层:功能视图】只允许布局 + 该功能独有视觉
│   ├── main-window.css             ← 从 3,771 行拆分
│   ├── main-window-legacy.css        (必须紧跟 main-window.css)
│   ├── wi-selector.css             ← 拆出:世界书条目选择器
│   ├── continuation.css            ← 拆出:主动续写历史
│   ├── queue.css                   ← 拆出:队列设置弹窗 + 进度条
│   ├── content-editor.css          ← 拆出:内容编辑器
│   ├── lore-review.css
│   ├── story-outline.css
│   ├── favs.css
│   ├── workshop.css
│   ├── manager.css
│   ├── debug.css
│   ├── memory-recall.css
│   ├── settings.css
│   ├── settings-drawer.css         ★ 从 settings.html 的 <style> 迁出(修 B10)
│   ├── floating.css
│   └── st-embedded.css             ★ 注入 ST DOM 的元素(.titania-inject-btn 等)
│                                     依 ADR-02 独立于插件组件体系
│
└── 05-utilities/                 【第 5 层:工具类】数量严格受限
    ├── state.css                   .is-hidden / .is-loading / .is-disabled / .is-active
    └── text.css                    .t-text-muted / .t-text-faint / .t-truncate / .t-mono
```

### 结构决策说明

**为什么把 `main-window.css` 拆成 5 个文件?**
它 3,771 行里含 3 个独立弹窗(队列设置、内容编辑器、世界书选择器)和 2 个独立面板(续写历史、统计 HUD)。这些与「主窗口」是**组合关系而非归属关系**——世界书选择器同时被 legacy 与 modern 两套布局使用,续写历史有自己的移动端逻辑。拆开后单文件回到 400~900 行,且移动端规则与自身相邻,而非散落在 10 个 `@media` 块里。

**为什么叫 `04-features` 而不是 `pages`?**
它们不是「页」:`floating.css` 是常驻 UI,`settings-drawer.css` 挂在 ST 抽屉里,`memory-recall.css` 是覆盖层。用 `features` 可避免「页面」一词带来的「整块独占」错觉,也更容易接受 R4/R5 两条禁止规则。

**为什么 `_legacy.css` 与 `legacy-aliases.css` 要单独成文件?**
因为它们的存在意义就是**被删除**。集中在两个带明确注释的文件里,Phase 7 的动作就是「删两个文件 + 跑审计」,而不是「在 14,000 行里考古」。

---

## 5. Design Token 定义(可直接落盘草稿)

> **原则:不发明新颜色。** 全部初始值取自现有高频实测值,所以 Phase 1 落地后视觉零变化。

### 5.1 `00-tokens/primitives.css`

```css
/* ============================================================
   原语层 —— 与主题无关的原始尺度。只被 semantic / theme 层消费。
   组件层禁止直接引用本文件的任何变量(见规则 R3b)。
   ============================================================ */
:root {
  /* ---- 中性阶:收敛现状 25 个值 → 14 阶 ---- */
  --t-c-neutral-0-rgb:   18  18  18;   /* #121212  现 10 次,窗口底 */
  --t-c-neutral-1-rgb:   26  26  26;   /* #1a1a1a  合并 #181818/#1a1a1a/#1d1d1d */
  --t-c-neutral-2-rgb:   30  30  30;   /* #1e1e1e  现 26 次 */
  --t-c-neutral-3-rgb:   34  34  34;   /* #222     合并 #222/#232323/#242424 */
  --t-c-neutral-4-rgb:   42  42  42;   /* #2a2a2a  合并 #252525/#2a2a2a/#2b2b2b/#2d2d2d */
  --t-c-neutral-5-rgb:   51  51  51;   /* #333     现 74 次,单值最高频 */
  --t-c-neutral-6-rgb:   58  58  58;   /* #3a3a3a  合并 #383838/#3a3a3a */
  --t-c-neutral-7-rgb:   68  68  68;   /* #444     现 42 次 */
  --t-c-neutral-8-rgb:  102 102 102;   /* #666     合并 #555/#666/#777 */
  --t-c-neutral-9-rgb:  136 136 136;   /* #888     现 35 次 */
  --t-c-neutral-10-rgb: 170 170 170;   /* #aaa     合并 #999/#aaa/#bbb */
  --t-c-neutral-11-rgb: 204 204 204;   /* #ccc     合并 #ccc/#ddd */
  --t-c-neutral-12-rgb: 238 238 238;   /* #eee     现 22 次 */
  --t-c-neutral-13-rgb: 255 255 255;   /* #fff     现 59 次 */

  /* ---- 色相:全部取自现有高频值,不新增 ---- */
  --t-c-gold-rgb:   191 161  95;   /* #bfa15f  48 次,品牌 */
  --t-c-blue-rgb:   144 205 244;   /* #90cdf4  64 次,交互(第二高频且原本无变量) */
  --t-c-mint-rgb:    85 239 196;   /* #55efc4  18 次,通知 */
  --t-c-red-rgb:    255 107 107;   /* #ff6b6b  收敛 4 个红(#ff6b6b/#f56565/#e74c3c/#ff9d9d) */
  --t-c-green-rgb:   72 187 120;   /* #48bb78  收敛 2 套绿 */
  --t-c-amber-rgb:  245 158  11;   /* #f59e0b  收敛 3 个黄(#f59e0b/#feca57/#ecc94b) */
  --t-c-violet-rgb: 162 155 254;   /* #a29bfe  装饰 */

  /* ---- 间距:4pt 基准 ---- */
  --t-space-2xs: 2px;    /* gap 2px ×6 */
  --t-space-xs:  4px;    /* gap 4px ×17 */
  --t-space-sm:  6px;    /* gap 6px ×55 */
  --t-space-md:  8px;    /* gap 8px ×98 + padding 8px ×27 —— 主力 */
  --t-space-lg:  12px;   /* gap 12px ×13 + padding 12px ×25 */
  --t-space-xl:  16px;
  --t-space-2xl: 20px;
  --t-space-3xl: 24px;

  /* ---- 间距过渡别名 ⚠ ----
     项目现存「4 倍数」与「5 倍数」两套间距系统。10px/15px 是最高频的 5 倍数值。
     故意用值命名(通常是反模式),因为它们的唯一用途就是被删除。
     Phase 1 只做「字面量 → 变量」等价替换;Phase 7 才归并,单独发版。 */
  --t-space-10: 10px;   /* 119 处(padding 44 + gap 75)→ 目标归入 md(8) 或 lg(12) */
  --t-space-15: 15px;   /*  27 处 → 目标归入 xl(16) */

  /* ---- 圆角 ---- */
  --t-radius-xs:   3px;    /* 12 次 */
  --t-radius-sm:   4px;    /* 40 次 */
  --t-radius-md:   6px;    /* 64 次 —— 控件默认(见下方决策) */
  --t-radius-lg:   8px;    /* 60 次 —— 卡片默认 */
  --t-radius-xl:   10px;   /* 29 次 */
  --t-radius-2xl:  12px;   /* 16 次 —— 窗口 */
  --t-radius-pill: 999px;  /* 10 次 */
  --t-radius-full: 50%;    /* 22 次 —— 圆形图标钮 */
  /* 已决策:控件(button/input/select/badge)= md(6px);
             容器(card/panel)= lg(8px);窗口/弹窗 = 2xl(12px)。
     现有 11 个散值(5/7/11/14/15/16/20/25/30/50/99px)全部归入最近档。 */

  /* ---- 字号:相对容器基准的 em 梯级(见 ADR-05,禁用 rem)---- */
  --t-font-size-2xs: 0.72em;  /* ≈9px   合并 0.66/0.7/0.72/0.74 */
  --t-font-size-xs:  0.8em;   /* ≈10px  合并 0.75/0.78/0.8/0.82 */
  --t-font-size-sm:  0.85em;  /* ≈10px  合并 0.84/0.85/0.86/0.88 */
  --t-font-size-md:  0.9em;   /* ≈11px  现 61 次,最高频 */
  --t-font-size-base:1em;     /* =12px */
  --t-font-size-lg:  1.1em;
  --t-font-size-xl:  1.25em;  /* 合并 1.2/1.3 */
  --t-font-size-2xl: 1.5em;

  --t-font-weight-normal:   400;
  --t-font-weight-medium:   500;
  --t-font-weight-semibold: 600;
  --t-font-weight-bold:     700;  /* 现有 22 处写 `bold`,统一为数值 */
  --t-font-weight-black:    800;  /* .t-title-main */

  --t-line-height-tight:   1.2;
  --t-line-height-snug:    1.35;
  --t-line-height-base:    1.5;
  --t-line-height-relaxed: 1.6;

  /* ---- 时长与缓动 ---- */
  --t-duration-instant: 0.1s;
  --t-duration-fast:    0.16s;  /* 合并现有 0.16/0.18 系列 */
  --t-duration-base:    0.2s;   /* 现 60 次 */
  --t-duration-slow:    0.3s;
  --t-duration-slower:  0.45s;

  --t-ease-standard: cubic-bezier(0.2, 0, 0.2, 1);
  --t-ease-out:      ease-out;
  --t-ease-spring:   cubic-bezier(0.34, 1.56, 0.64, 1);  /* 现有 ×2 */
  --t-ease-decel:    cubic-bezier(0.16, 1, 0.3, 1);      /* 现有 ×1 */

  /* ---- 层级预算(收敛 CSS 37 + JS 10 个值)---- */
  --t-z-base:    0;
  --t-z-raised:  10;
  --t-z-sticky:  100;
  --t-z-float:   9000;    /* 悬浮球 / 计时器 / 滑出菜单 */
  --t-z-overlay: 20000;   /* 主遮罩(保持现值) */
  --t-z-window:  20010;   /* 窗口(现 20001) */
  --t-z-dialog:  20100;   /* 二级弹窗(现也是 20001 —— 与窗口同级,现在靠 DOM 顺序侥幸生效) */
  --t-z-popover: 20200;   /* 下拉 / 选择器 / 更多菜单 */
  --t-z-toast:   20300;

  /* ---- 字体族(沿用现值)---- */
  --t-font-global: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                   "Helvetica Neue", Arial, sans-serif;
  --t-font-mono:   "Consolas", "Monaco", "Courier New", monospace;
  --t-ui-font-scale: 1;
  /* UI 基准字号 —— 用于给 B8 那 6 个漏掉基准的弹窗根统一补上 */
  --t-font-size-root: calc(12px * var(--t-ui-font-scale, 1));
}
```

**断点约定**(CSS 变量不能用于 `@media`,靠约定 + 审计脚本):

```
--t-bp-mobile   600px    主断点(现 16 次)
--t-bp-tablet   768px    次断点(现 CSS 12 次 + JS 4 次)
--t-bp-desktop  920px    宽屏(现 JS 1 次)
```

需归并的散值:`480 / 620 / 700 / 769 / 900px`。JS 侧 `matchMedia` 字符串集中到一处常量导出,避免 JS/CSS 断点不同步。

### 5.2 `00-tokens/theme-dark.css`

```css
/* ============================================================
   暗色主题 —— 语义 token 到原语的绑定。等价于当前视觉的形式化。
   ============================================================ */
:root,
:root[data-t-theme="dark"] {

  /* ---- 表面层(elevation)---- */
  --t-color-bg:              rgb(var(--t-c-neutral-0-rgb));       /* 窗口底 */
  --t-color-surface:         rgb(var(--t-c-neutral-2-rgb));       /* 面板 */
  --t-color-surface-raised:  rgb(var(--t-c-neutral-4-rgb));       /* 卡片 / 控件底 */
  --t-color-surface-sunken:  rgb(var(--t-c-neutral-1-rgb));       /* 输入框底 / 代码块 */
  --t-color-surface-hover:   rgb(var(--t-c-neutral-13-rgb) / .08);/* 替换 31 次 rgba(255,255,255,.08) */
  --t-color-surface-active:  rgb(var(--t-c-neutral-13-rgb) / .15);/* 替换 21 次 */
  --t-color-scrim:           rgb(0 0 0 / .6);                     /* 遮罩 */

  /* ---- 文本 ---- */
  --t-color-text:            rgb(var(--t-c-neutral-12-rgb));
  --t-color-text-strong:     rgb(var(--t-c-neutral-13-rgb));
  --t-color-text-secondary:  rgb(var(--t-c-neutral-10-rgb));
  --t-color-text-muted:      rgb(var(--t-c-neutral-9-rgb));
  --t-color-text-faint:      rgb(var(--t-c-neutral-8-rgb));   /* #666 —— 42 次 + 大量 inline */
  --t-color-text-on-accent:  rgb(var(--t-c-neutral-0-rgb));

  /* ---- 边框 ---- */
  --t-color-border:          rgb(var(--t-c-neutral-5-rgb));       /* #333 —— 74 次 */
  --t-color-border-strong:   rgb(var(--t-c-neutral-7-rgb));       /* #444 */
  --t-color-border-subtle:   rgb(var(--t-c-neutral-13-rgb) / .1); /* 替换 39 次 */

  /* ---- 强调 / 交互(蓝)---- */
  --t-color-accent:          rgb(var(--t-c-blue-rgb));
  --t-color-accent-hover:    rgb(var(--t-c-blue-rgb) / .85);
  --t-color-accent-active:   rgb(var(--t-c-blue-rgb) / .7);
  --t-color-accent-soft:     rgb(var(--t-c-blue-rgb) / .12);  /* 替换 14+9 次 */
  --t-color-accent-border:   rgb(var(--t-c-blue-rgb) / .35);  /* 替换 13+7 次 */
  --t-color-focus-ring:      rgb(var(--t-c-blue-rgb) / .4);

  /* ---- 品牌(金)—— 与 accent 显式分离,解决 S3 ---- */
  --t-color-brand:           rgb(var(--t-c-gold-rgb));
  --t-color-brand-soft:      rgb(var(--t-c-gold-rgb) / .14);  /* = 现 .t-btn-soft 的值 */
  --t-color-brand-border:    rgb(var(--t-c-gold-rgb) / .55);

  /* ---- 反馈色 ---- */
  --t-color-danger:          rgb(var(--t-c-red-rgb));
  --t-color-danger-soft:     rgb(var(--t-c-red-rgb) / .2);
  --t-color-danger-border:   rgb(var(--t-c-red-rgb) / .4);
  --t-color-success:         rgb(var(--t-c-green-rgb));
  --t-color-success-soft:    rgb(var(--t-c-green-rgb) / .2);
  --t-color-warning:         rgb(var(--t-c-amber-rgb));
  --t-color-warning-soft:    rgb(var(--t-c-amber-rgb) / .2);
  --t-color-notify:          rgb(var(--t-c-mint-rgb));

  /* ---- 阴影 ---- */
  --t-shadow-xs: 0 1px  3px rgb(0 0 0 / .2);
  --t-shadow-sm: 0 2px  8px rgb(0 0 0 / .2);   /* 现有 ×2 */
  --t-shadow-md: 0 4px 15px rgb(0 0 0 / .3);   /* 现有 ×1 */
  --t-shadow-lg: 0 10px 30px rgb(0 0 0 / .5);  /* 现有 ×3,弹窗 */
  --t-shadow-xl: 0 10px 40px rgb(0 0 0 / .8);  /* 现有 ×6,主窗口 */
  --t-shadow-focus: 0 0 0 3px var(--t-color-focus-ring);  /* 推广现有雏形 ×3 */
  --t-shadow-glow-accent:  0 4px 14px rgb(var(--t-c-blue-rgb)  / .35);
  --t-shadow-glow-success: 0 4px 14px rgb(var(--t-c-green-rgb) / .35);
  --t-shadow-glow-danger:  0 4px 14px rgb(var(--t-c-red-rgb)   / .35);
  --t-shadow-inset-hairline: inset 0 1px 0 rgb(255 255 255 / .06);
  /* 以上 4 个 glow 替换现有 12 个各不相同的
     "0 4~6px 12~20px rgba(强调色, .3~.5)" */

  /* ---- 复合过渡:按交互场景而非按属性 ----
     同时用于消灭 45 处 `transition: all 0.2s`(`all` 会把
     width/height/transform/box-shadow 一起纳入过渡,是移动端掉帧根因) */
  --t-transition-hover:  background-color var(--t-duration-base) var(--t-ease-standard),
                         border-color     var(--t-duration-base) var(--t-ease-standard),
                         color            var(--t-duration-base) var(--t-ease-standard);
  --t-transition-focus:  box-shadow   var(--t-duration-fast) var(--t-ease-out),
                         border-color var(--t-duration-fast) var(--t-ease-out);
  --t-transition-active: transform var(--t-duration-instant) var(--t-ease-out);
  --t-transition-dialog: opacity   var(--t-duration-slow) var(--t-ease-decel),
                         transform var(--t-duration-slow) var(--t-ease-decel);
  --t-transition-modal:  opacity    var(--t-duration-base) var(--t-ease-out),
                         visibility var(--t-duration-base) var(--t-ease-out);

  /* ---- 渐变(必须单独 token 化:颜色 token 不会自动适配渐变)---- */
  --t-gradient-title:   linear-gradient(135deg, #e0c3fc 0%, #ff9a9e 100%);
  --t-gradient-accent:  linear-gradient(90deg,  #4a9eff, #667eea);
  --t-gradient-notify:  linear-gradient(90deg,  #55efc4, #00cec9);
  --t-gradient-surface: linear-gradient(180deg, rgb(255 255 255 / .04),
                                                rgb(255 255 255 / .015));
}
```

### 5.3 `00-tokens/legacy-aliases.css` ⚠ Phase 7 删除

```css
/* ============================================================
   过渡兼容层 —— 让 12 个 CSS 文件里现存的 var() 引用继续工作。
   Phase 7 删除本文件。删除前需确认审计脚本报告零引用。
   ============================================================ */
:root {
  /* 现有 5 个颜色变量 */
  --t-theme:    var(--t-color-brand);
  --t-notify:   var(--t-color-notify);
  --t-bg-dark:  var(--t-color-bg);
  --t-bg-panel: var(--t-color-surface);
  --t-border:   var(--t-color-border);

  /* 补上 B5:被消费但从未声明的 3 个,消除隐式契约。
     注意 floatingBtn.js:604-609 仍会在 #titania-float-btn 元素上覆盖它们,
     这是正确的数据驱动用法(用户可自定义悬浮球配色),不要改。 */
  --t-border-color:      var(--t-color-accent);
  --t-border-color-rgba: var(--t-color-accent-border);
  --t-bg-color:          var(--t-color-surface-raised);
}
```

---

## 6. 组件契约与旧类名映射

### 6.1 命名约定

```
.t-btn                  块
.t-btn__icon            元素
.t-btn--primary         变体(视觉语义)
.t-btn--sm              尺寸
.is-active / .is-loading / .is-selected / .is-hidden    状态(JS 切换)
[disabled] / :disabled  原生状态优先
```

沿用 `t-` 前缀。`is-` 前缀有既有先例(`settings.html` 的 `.is-export` / `.is-import` / `.is-update`)。变体用双横线是为了在 61 个现有类名里 grep 时能一眼区分「组件变体」与「独立组件」。

### 6.2 组件优先级与取舍

| 组件 | 现状重复量 | 判定 | Phase |
|---|---|---|---|
| **Button** | 61 类 / 68 规则 | ★★★ 必做 | 2 |
| **IconButton** | 10 个同义类 | ★★★ 必做 | 2 |
| **Input / Textarea / Select** | 32 条基态规则 / 3 种填充约定 | ★★★ 必做 | 3 |
| **Switch / Checkbox / Radio** | 61 个原生未样式化控件 | ★★★ 必做(Light Theme 必要条件) | 3 |
| **Dialog / Sheet** | 33 类 / 3 套系统 / 12 条声明字节重复 | ★★★ 必做 | 4 |
| **Window / Panel** | 3 套 header/footer 字节重复 | ★★★ 必做 | 4 |
| **Card** | 44 类 / 8+ 套实现 | ★★★ 必做 | 4 |
| **Tabs / Segmented** | 3 份独立定义 + 6 同义类 | ★★★ 必做 | 4 |
| **EmptyState** | 23 个同义类 | ★★☆ 应做(零风险) | 4 |
| **Spinner / Skeleton** | 3 类 + 重复 keyframes | ★★☆ 应做 | 0 + 4 |
| **Badge / Tag** | 14 类(含 2 个版本徽章) | ★★☆ 应做 | 4 |
| **Hint** | 17 类 | ★☆☆ 部分做 | 4 |
| **Menu / Dropdown** | 4 套 | ★☆☆ **只统一视觉,不统一定位与外点关闭逻辑** | 4 |
| **Progress** | 2 类 | ★☆☆ 可选 | — |
| **Toast** | — | ✗ **不做**:已有 253 处 `toastr`,ST 完全覆盖 | — |
| **List / Row** | 各窗口列表行 | ✗ **不做**:条目/剧本/收藏/评论语义差异过大,强行抽象会产生比重复更糟的耦合 | — |

> **「不抽象」的判断同样重要。过度抽象会制造新的耦合,与本次目标相反。**

### 6.3 Button 目标实现

```css
/* 02-components/button.css —— 只消费语义 token,禁止页面选择器与字面量 */
.t-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--t-space-sm);
  padding: var(--t-space-md) var(--t-space-lg);
  min-height: 32px;
  border: 1px solid var(--t-color-border-strong);
  border-radius: var(--t-radius-md);
  background: var(--t-color-surface-raised);
  color: var(--t-color-text);
  font-family: inherit;
  font-size: var(--t-font-size-md);
  font-weight: var(--t-font-weight-semibold);
  line-height: var(--t-line-height-tight);
  text-align: center;
  cursor: pointer;
  transition: var(--t-transition-hover);
  -webkit-tap-highlight-color: transparent;
}
.t-btn:hover:not(:disabled)  { background: var(--t-color-surface-hover); }
.t-btn:active:not(:disabled) { background: var(--t-color-surface-active); }
.t-btn:focus-visible         { outline: none; box-shadow: var(--t-shadow-focus); }
.t-btn:disabled              { opacity: .6; cursor: not-allowed; }

/* 6 个变体,覆盖全部 7 类现有语义 */
.t-btn--primary   { background: var(--t-color-accent);
                    color: var(--t-color-text-on-accent); border-color: transparent; }
.t-btn--secondary { /* = 默认基态,保留类名以显式化语义 */ }
.t-btn--danger    { background: var(--t-color-danger-soft);  color: var(--t-color-danger);
                    border-color: var(--t-color-danger-border); }
.t-btn--success   { background: var(--t-color-success-soft); color: var(--t-color-success);
                    border-color: transparent; }
.t-btn--brand     { background: var(--t-color-brand-soft);   color: var(--t-color-brand);
                    border-color: var(--t-color-brand-border); }   /* = 现 .t-btn-soft */
.t-btn--ghost     { background: transparent; border-color: transparent;
                    color: var(--t-color-text-secondary); }

/* 4 个尺寸,覆盖现有 12 种 padding 组合 */
.t-btn--xs    { padding: var(--t-space-xs) var(--t-space-md);  min-height: 22px;
                font-size: var(--t-font-size-xs); border-radius: var(--t-radius-sm); }
.t-btn--sm    { padding: var(--t-space-sm) var(--t-space-lg);  min-height: 28px;
                font-size: var(--t-font-size-sm); }
.t-btn--lg    { padding: var(--t-space-lg) var(--t-space-2xl); min-height: 40px;
                font-size: var(--t-font-size-base); }
.t-btn--block { width: 100%; }
```

### 6.4 旧类名 → 新实现映射表

`02-components/_legacy.css` 按此表实现。**Phase 2 期间 JS 一行不改**,视觉立即统一;类名替换在 Phase 2 之后按窗口分批做。

| 目标 | 旧类名 |
|---|---|
| `.t-btn--primary` | `.t-btn.primary`、`.t-btn-primary`、`.t-recall-btn-primary`、`.t-recall-search-btn`、`.t-hint-btn.primary`、`.t-goto-live-btn`、`.t-gcn-view-btn` |
| `.t-btn`(默认/secondary) | `.t-btn`、`.t-recall-btn-secondary`、`.t-mobile-nav-btn`、`.t-mobile-back-btn`、`.t-hint-btn`、`.t-queue-mode-btn`、`.t-queue-num-btn`、`.t-filter-btn`、`.t-dice-btn`、`.t-btn-grid`、`.t-btn-aux`、`.t-run-btn` |
| `.t-btn--danger` | `.t-btn-danger`(**2 份冲突定义收敛为 1 份**)、`.t-btn-stop`、`.t-plan-delete-btn` |
| `.t-btn--success` | `.t-btn-success` |
| `.t-btn--brand` | `.t-btn-soft` |
| `.t-btn--ghost.t-btn--xs` | `.t-tool-btn`、`.t-btn-xs`(**2 份定义**)、`.t-act-btn`、`.t-quick-btn`、`.t-quick-btn-all`、`.t-recall-action-btn`、`.t-outline-mini-btn`、`.t-outline-row-btn`、`.t-prompt-tool-btn`、`.t-shortcut-btn`、`.t-continuation-history-btn`、`.t-continuation-context-btn`、`.t-mgr-cat-edit-btn`、`.t-plan-name-btn`、`.t-read-more-btn`、`.t-hint-btn.dismiss`、`.t-btn-diag`、`.t-prompt-info-btn` |
| `.t-icon-btn`(修正热区) | `.t-icon-btn`、`.t-menu-icon-btn`、`.t-tools-btn`、`.t-prompt-icon-btn`、`.t-gcn-close-btn`、`.t-wi-preview-btn`、`.t-plan-item-nav-btn`、`.t-close`、`.t-dialog-close`、`.t-window-close`、`.t-model-dialog-close`(**后 4 个字节级重复**) |
| `.t-tab` / `.t-segmented` | `.t-set-tab-btn`(**3 份定义**)、`.t-wi-tab-btn`、`.t-mode-btn`、`.t-sel-cat-btn`(**同文件 2 份**)、`.t-mgr-sb-item` |
| → `03-layout`(布局容器,非按钮) | `.t-build-index-buttons`、`.t-hide-quick-btns`、`.t-quick-btns`、`.t-control-buttons`、`.t-btn-row`、`.t-mobile-nav-btns` |
| **保持独立,不进组件体系** | `.titania-inject-btn`、`.titania-recall-btn`(注入 ST DOM,依 ADR-02 继承 `.mes_button`);`#titania-float-btn`(悬浮球,形态唯一);`.titania-mini-btn`(设置抽屉,需与 ST 抽屉观感一致 —— 但要合并 B10 的两处定义) |

### 6.5 Input 统一与 `!important` 拆除路径

**顺序不可颠倒**(这是全案技术上最微妙的一环,直接触碰宿主对抗层):

1. 建立 `.t-root` 作用域根,给第 8 节清单里**所有**挂载点加上;
2. 在 `.t-root` 内用 `color-scheme: dark` **接管原生控件**(checkbox / radio / range / select 箭头 / 内部滚动条)—— 一次解决 S2 的一半,且不需要重写那 61 个控件;
3. 组件层用 `.t-root .t-input { … }` 提供两级特异性(0,2,0),足以压过 ST 绝大多数单类规则(0,1,0),**从而不再需要 `!important`**;
4. 只有实测确认某条 ST 规则仍穿透时才保留个别 `!important`,并**注释写明具体是哪条 ST 规则**——把「防御性 important」变成「有据可查的 important」。

**预期**:76 处 `!important` 中约 50~60 处可删除。`memory-recall.css` 的 28 处需单独审查(它用 `!important` 覆盖 `--SmartThemeBlurTintColor`,属跨主题边界的特殊情况)。

**填充约定统一建议**:3 种约定(不透明 `#1a1a1a`/`#222`/`#2a2a2a`/`#252525`、半透明黑 `rgba(0,0,0,.2~.3)`、蓝调半透明 `rgba(8,12,16,.75)`)统一到 **`--t-color-surface-sunken`**,因为它在 ST 深/浅主题下都不突兀。

---

## 7. CSS 分层规则(R1–R9)

> 写进 `CONTRIBUTING.md` 与 `CLAUDE.md`,并由审计脚本(第 11 节)检查。
> **这一节是防止重构成果被后续开发劣化的核心。**

| 规则 | 内容 | 审计检查 |
|---|---|---|
| **R1** | `00-tokens/` 不引用任何其它层 | 静态扫描 |
| **R2** | `02-components/` **禁止** ID 选择器、`#t-*-view` 前缀、任何 feature 类名 | 正则:组件文件内 `#` 开头选择器 |
| **R3a** | `02-components/` **禁止** hex / rgb / rgba 字面量。白名单:`transparent`、`currentColor`、`inherit` | 正则计数 = 0 |
| **R3b** | `02-components/` **禁止**直接引用 `--t-c-*`(原语层),只能用语义 token | 正则:组件文件内 `var(--t-c-` |
| **R4** | `04-features/` **禁止**重定义组件类的**视觉**属性(color/background/border/box-shadow/font-*/border-radius)。**允许**调整其**布局**属性(width/margin/grid-area/order/flex) | 解析选择器 + 属性白名单 |
| **R5** | `04-features/` 之间**禁止**互相引用彼此的类名(修 B6 并防复发) | 类名前缀归属表 |
| **R6** | 所有 `@keyframes` 只能在 `01-base/keyframes.css` 声明,且必须 `t-` 前缀 | 全库扫描 |
| **R7** | 全局伪元素选择器(`::-webkit-scrollbar` 等)必须以 `.t-root` 开头(修 B2 并防复发) | 正则 |
| **R8** | 新增 `!important` 必须紧邻注释说明它在对抗哪条具体宿主规则 | 上一行含注释 |
| **R9** | **禁止使用 `@layer`**(见 ADR-03) | 关键字扫描 |

---

## 8. 作用域根 `.t-root` 与挂载点清单

### 8.1 `01-base/scope.css`

```css
.t-root {
  /* 排版基准 —— 一次性修掉 B8 / B9 */
  font-family: var(--t-font-global);
  font-size: var(--t-font-size-root);   /* calc(12px * var(--t-ui-font-scale, 1)) */
  line-height: var(--t-line-height-base);
  color: var(--t-color-text);

  /* 接管原生控件配色:checkbox / radio / range / select 箭头 / 内部滚动条。
     解决 S2 的一半;Light Theme 时只需在 [data-t-theme="light"] 下切为 light */
  color-scheme: dark;
}
.t-root, .t-root *, .t-root *::before, .t-root *::after { box-sizing: border-box; }
```

### 8.2 必须添加 `.t-root` 的挂载点(实测清单)

> 此清单是本次分析的独立产出:它把「插件 UI 的边界」第一次显式列出来了。
> 当前这个边界是隐式的、靠 `t-` 前缀猜的。

| 挂载点 | 来源 |
|---|---|
| `#t-overlay` | `dom.js` `ensureOverlay()` |
| 12 处 `.t-box` 窗口根 | mainWindow(modern `layouts/modern.js:44` / legacy `layouts/legacy.js:25`)、workshop、favs、recall、diagnostics 等 |
| `.t-dialog-overlay`、`.t-model-dialog-overlay`、`.titania-update-overlay`、`.titania-recall-overlay`、`.t-ws-preview-overlay`、`.t-img-mgr-overlay` | 各 window JS |
| `.t-imp-modal`、`.t-wi-preview-modal` | manager / main-window |
| `.t-outline-add-sheet`、`.t-fav-export-sheet` | story-outline / favs |
| `#titania-float-btn`、`#titania-timer`、`#titania-slide-menu`、`#titania-menu-backdrop` | `floatingBtn.js:612-613, 352-353` |
| `#titania-settings-drawer` | `settings.html:2` |
| `outlineEntryButton` / `rewriteEntryButton` / `chatInjectButton` 的菜单容器 | 各 entry JS |

**注意**:注入 ST DOM 的**按钮本体**(`.titania-inject-btn` / `.titania-recall-btn`)**不加** `.t-root` —— 依 ADR-02 它们要继承 ST 的 `.mes_button` 观感,不是插件 UI。

**背景**:项目现有两套挂载策略并存 —— `ensureOverlay()`(进 `#t-overlay`,该容器设了 `font-size: calc(12px * var(--t-ui-font-scale)) !important`)与 `$("body").append(...)`(直接挂 body,**约 15 处**)。`.t-root` 的作用就是让两者统一。

---

## 9. 主题架构

### 9.1 机制:token 在 `:root`,主题由 `documentElement` 属性切换

```css
/* 00-tokens/theme-dark.css */
:root, :root[data-t-theme="dark"] { /* … */ }

/* 00-tokens/theme-light.css —— Phase 6 之后新增 */
:root[data-t-theme="light"] { /* 同一批 token 名,不同值 */ }
:root[data-t-theme="light"] .t-root { color-scheme: light; }
```

```js
// 切换 —— 与现有 --t-ui-font-scale 的写法完全同构
document.documentElement.setAttribute('data-t-theme', mode);
```

**为什么 token 放 `:root` 而不是 `.t-root`**:

1. 全部 token 带 `--t-` 前缀,**不会与 ST 或其它扩展冲突**(实测 ST 的 109 个变量无一以 `t-` 开头);
2. 项目现状已在 `:root` 声明 8 个 `--t-*`,**这是延续而非改弦易辙**,迁移风险最低;
3. 插件有约 15 处元素直接挂 `body`,token 放 `:root` 保证**任何挂载点都拿得到**,不会出现「新弹窗忘加 `.t-root` 就变成无色」的脆弱性;
4. 对 AI 生成内容区(`css_themes` 用户 CSS、`helpers.js` 的 scoped HTML)也可用,是额外收益。

**备选(Phase 6 后再评估)**:token 声明在 `.t-root`、`[data-t-theme] .t-root` 覆盖。好处是完全不碰 `:root`、支持同页两主题共存;代价是 `.t-root` 漏加即失效。**若届时挂载点清单已被审计脚本覆盖,可平滑升级。**

### 9.2 主题层的边界:token 化不了的东西

诚实列出,避免 Phase 6 / Light Theme 时出现「以为改一处结果改一百处」的落差。

| 内容 | 现状量 | 处理方式 |
|---|---|---|
| 装饰性渐变 | 约 25 处 `linear-/radial-gradient` | 必须**额外定义 `--t-gradient-*`**;颜色 token 不会自动适配渐变。浅色下可能需要完全不同的配方 |
| `-webkit-background-clip: text` 渐变标题 | `base.css` `.t-title-main` / `.t-title-sub` | 浅底上粉紫渐变对比度不足,Light 主题需单独覆写甚至改纯色 |
| `filter: brightness(1.06)` 类 hover | 约 3~5 处(如 `settings.html` `.titania-mini-btn:hover`) | 浅色下「提亮」= 「变白」= 视觉变淡。需改为 token 化的显式 hover 色 |
| `backdrop-filter: blur()` | 约 10 处 | 值本身与主题无关,但需配合不同的 `--t-color-scrim` |
| 保留的少量 `!important`(< 20) | Phase 3 后残留 | 它们是为对抗 ST **深色**主题写的,浅色下可能需要相反方向,须逐条 review |
| emoji / 图片资源 | `appearance.content` | 与主题无关,不处理 |
| 用户自定义 CSS(`css_themes`)与 AI 生成内容的内联 `<style>` | `helpers.js` 多处 | **明确划在插件主题系统之外**。这是内容区,不是 UI 区 |

---

## 10. 构建改造

### 10.1 `css/manifest.js`(单一数据源,修 B1)

```js
// css/manifest.js —— build.js 与 src/utils/dom.js 的唯一数据源。
// 顺序即拼接顺序。顺序语义从注释升级为数据结构,并由审计脚本断言。
export const CSS_LAYERS = [
  { layer: '00-tokens', files: [
      'primitives.css', 'semantic.css', 'theme-dark.css', 'legacy-aliases.css',
  ]},
  { layer: '01-base', files: [
      'scope.css', 'typography.css', 'scrollbar.css', 'keyframes.css',
  ]},
  { layer: '02-components', files: [
      'window.css', 'panel.css', 'card.css', 'dialog.css',
      'button.css', 'icon-button.css', 'field.css', 'switch.css',
      'tabs.css', 'badge.css', 'menu.css', 'hint.css',
      'empty-state.css', 'spinner.css',
      '_legacy.css',            // 必须在全部组件之后
  ]},
  { layer: '03-layout', files: ['stack.css', 'grid.css', 'responsive.css'] },
  { layer: '04-features', files: [
      'main-window.css',
      'main-window-legacy.css', // ⚠ 必须紧跟 main-window.css(经典布局靠后置覆盖)
      'wi-selector.css', 'continuation.css', 'queue.css', 'content-editor.css',
      'settings.css', 'settings-drawer.css', 'manager.css', 'workshop.css',
      'favs.css', 'debug.css', 'lore-review.css', 'memory-recall.css',
      'story-outline.css', 'floating.css', 'st-embedded.css',
  ]},
  { layer: '05-utilities', files: ['state.css', 'text.css'] },
];

/** 展开为相对 css/ 的有序路径列表 */
export function cssFileList() {
  return CSS_LAYERS.flatMap(({ layer, files }) => files.map(f => `${layer}/${f}`));
}
```

### 10.2 改造点

| 文件 | 改动 |
|---|---|
| `build.js:20-49` | `bundleCSS()` 改为 `import { cssFileList } from './css/manifest.js'` 并遍历;保留 `/* === path === */` 分隔注释 |
| `build.js:52-89` | `injectCSSPlugin` 的 `onLoad` 逻辑不变(继续劫持 `dom.js`) |
| `src/utils/dom.js:17-44` | `loadCssFiles()` 改为从 `manifest.js` 读取。**这一步直接修掉 B1** |
| `package.json` | 新增 `"css:audit": "node scripts/css-audit.js"`;`build` 前置该脚本(Phase 6 起为阻断) |

---

## 11. 审计脚本规格(`scripts/css-audit.js`)

> **这是唯一能防止本次重构在半年内被重新劣化的措施。**
> 考虑到现状问题主要是 AI 辅助逐次叠加产生的,**防回归比重构本身更重要**。

### 11.1 检查项

| ID | 检查 | Phase 0 | Phase 6 起 |
|---|---|---|---|
| A1 | 各层字面量计数(hex / rgb / rgba),按文件报告 | 报告 | 组件层 = 0 则通过 |
| A2 | R2:组件层出现 ID 选择器 | 报告 | **阻断** |
| A3 | R3a:组件层出现颜色字面量(白名单外) | 报告 | **阻断** |
| A4 | R3b:组件层引用 `var(--t-c-` 原语 | 报告 | **阻断** |
| A5 | R4:feature 层重定义组件类的视觉属性 | 报告 | **阻断** |
| A6 | R5:feature 之间交叉引用类名 | 报告 | **阻断** |
| A7 | R6:`@keyframes` 出现在非 `01-base/keyframes.css`,或无 `t-` 前缀 | 报告 | **阻断** |
| A8 | R7:全局伪元素选择器无 `.t-root` 前缀 | 报告 | **阻断** |
| A9 | R8:`!important` 上一行无注释 | 报告 | **阻断** |
| A10 | R9:出现 `@layer` | **阻断** | **阻断** |
| A11 | 消费但未声明的 `--t-*` 变量 | **阻断** | **阻断** |
| A12 | 跨文件重复定义的顶层类 | 报告 | **阻断** |
| A13 | 字节级重复声明块(≥4 声明) | 报告 | 报告 |
| A14 | `manifest.js` 列出的文件是否都存在 / 目录里是否有未列出的文件 | **阻断** | **阻断** |
| A15 | `main-window-legacy.css` 是否紧跟 `main-window.css` | **阻断** | **阻断** |
| A16 | `src/**/*.js` 中 `style="…"` 计数(区分静态 / 含 `${}`) | 报告 | 静态数 > 阈值则阻断 |
| A17 | `src/**/*.js` 中含硬编码颜色的 `style="…"` | 报告 | **阻断** |
| A18 | `@media` 断点是否在 {600, 768, 920} + 指针查询白名单内 | 报告 | **阻断** |
| A19 | `z-index` 是否全部通过 `var(--t-z-*)` | 报告 | **阻断** |
| A20 | `transition: all` 出现次数 | 报告 | **阻断** |
| A21 | 挂载点清单核对:扫描 `$("body").append` / `ensureOverlay()` 调用点,比对第 8.2 节清单 | 报告 | 报告 |

### 11.2 输出

- 人类可读摘要(与第 1.2 节基线表同构,便于逐 Phase 对比)
- `scripts/.css-audit-baseline.json` 快照,支持 `--compare` 显示增量
- 阻断模式下退出码非 0

---

## 12. 分阶段执行计划

### 总览

| Phase | 内容 | 视觉变化 | 风险 | 可发版 |
|---|---|---|---|---|
| **0** | 地基与护栏:修 B1–B4、审计脚本、视觉基线 | 无(修 B2 属恢复 ST 原样) | 低 | ✅ |
| **1** | Design Tokens + `.t-root` + 兼容别名 | 无(弹窗字体极小变化) | 低 | ✅ |
| **2** | Button / IconButton 统一 | **有**(primary 配色统一) | 中 | ✅ |
| **3** | Input / Select / Switch 统一 + 拆 `!important` | 有(输入框填充统一) | **高** | ✅ |
| **4** | Dialog / Window / Card / Panel / Tabs + 拆 main-window.css | 有(弹窗尺寸/圆角统一) | 中 | ✅ |
| **5** | 清理 583 处 inline style(4 批) | 极小 | 低 | ✅ 每批 |
| **6** | Theme Layer 收口 + 审计转阻断 + `__probe` 验证 | 无 | 低 | ✅ |
| **7** | 删兼容层 / 归并间距 / z-index / 断点收口 | 有(1~2px 位移) | 中 | ✅ |

---

### 12.1 Phase 0 —— 地基与护栏

**必须最先做。不动任何视觉,只修基础设施与已确认 bug。**

**任务**

- [ ] 建立 `css/manifest.js`(第 10.1 节),`build.js` 与 `dom.js` 改为从它读取 → **修 B1**
- [ ] `base.css` 的 `::-webkit-scrollbar` 系列迁到 `01-base/scrollbar.css` 并加 `.t-root` 前缀 → **修 B2**
- [ ] 25 个 `@keyframes` 集中到 `01-base/keyframes.css`;`fadeIn` → `t-fade-in`、`slideUp` → `t-slide-up`(同步改所有 `animation:` 引用)→ **修 B3**
- [ ] 合并 `t-ripple-*`/`p-ripple-*`、`t-arc-*`/`p-arc-*`、`t-notify-glow`/`p-notify-glow` 三组 → **修 B4**
- [ ] 建立 `scripts/css-audit.js`,A1–A21 全部实现;A10/A11/A14/A15 为阻断,其余为报告
- [ ] `package.json` 增加 `css:audit` 脚本
- [ ] **建立视觉基线**:12 个主要窗口 + 6 个弹窗 × {PC, 768px, 600px} × {ST 默认深色主题, 一个 ST 浅色主题} 截图归档到 `docs/baseline/`
- [ ] 写入 `CONTRIBUTING.md` / `CLAUDE.md`:R1–R9 九条规则

**完成判据**

- `npm run css:audit` 跑通并输出与第 1.2 节一致的基线数字
- 开发模式(`dom.js` 路径,未打包)下工坊窗口有样式
- SillyTavern 的滚动条恢复原生外观
- 悬浮球动画(真球 + 设置页预览球)无回归,且改一处两处同时生效
- 全部基线截图与改动前逐一比对无差异

**回滚**:每项独立提交,可单独 revert。

---

### 12.2 Phase 1 —— Design Tokens(视觉零变化)

**任务**

- [ ] 落盘 `00-tokens/primitives.css`(第 5.1 节)
- [ ] 落盘 `00-tokens/semantic.css`(语义 token 声明 + 文档注释)
- [ ] 落盘 `00-tokens/theme-dark.css`(第 5.2 节)
- [ ] 落盘 `00-tokens/legacy-aliases.css`(第 5.3 节)→ **修 B5**
- [ ] 落盘 `01-base/scope.css`(第 8.1 节)
- [ ] 给第 8.2 节清单里**所有**挂载点加 `.t-root` 类
- [ ] 删除 `floating.css` `.t-model-dialog-box` 的硬编码 `font-family` → **修 B9**
- [ ] **不替换任何字面量。** 本阶段只「提供」token

**完成判据**

- 截图与 Phase 0 基线一致(允许的例外见下)
- 6 个弹窗(B8 清单)内「UI 缩放」设置**开始生效**
- 审计 A11(未声明变量)= 0

**已知且需确认接受的视觉变化**

- `.t-model-dialog-box` 的字体从 Segoe UI 变为 `--t-font-global`(修 B9 的必然结果,属修 bug)
- B8 那 6 个弹窗内的 `em` 字号基准从「ST body 字号」变为「12px × scale」——**这可能是本 Phase 最明显的变化**,需逐个弹窗确认排版仍合理

**回滚**:token 文件为纯新增,删除 `manifest.js` 里的 `00-tokens` / `01-base` 条目即可完全回退。

---

### 12.3 Phase 2 —— 统一 Button(收益最大)

**任务**

- [ ] 落盘 `02-components/button.css`(第 6.3 节)
- [ ] 落盘 `02-components/icon-button.css`,修正热区(带 padding 的方形热区,间距交给父级 `gap`)
- [ ] **删除** `main-window.css:25-42` 与 `workshop.css` 里的两处 `.t-icon-btn` 补丁 → **修 B13**
- [ ] 落盘 `02-components/_legacy.css`,按第 6.4 节映射表实现。**JS 一行不改**
- [ ] 删除 `.t-btn-danger` 的重复定义(`floating.css:741` + `lore-review.css:1567` → 1 份),连带删除相关 3 处 `!important` → **修 B7**
- [ ] 合并 `.t-sel-cat-btn` 在 `manager.css` 内的 2 份定义 → **修 B11**
- [ ] 6 个布局容器类(`.t-btn-row` 等)迁到 `03-layout`
- [ ] **产品决策**:`.t-btn.primary`(粉)与 `.t-btn-primary`(蓝)二选一 → **解 S4**
- [ ] 之后按窗口分批把 JS 里旧类名换成 `t-btn t-btn--primary` 等新写法(11 个文件,11 个独立提交)

**完成判据**

- 按钮基态规则 68 → ≤ 25;按钮类名 61 → ≤ 12
- 审计 A3(button.css 字面量)= 0
- 每个窗口的按钮逐一截图确认
- `.t-icon-btn` 点击热区在 PC 与移动端均 ≥ 32×32px

**风险与回滚**

- primary 配色统一是**唯一不可逆的视觉决策**,单独成提交、单独发版说明
- **建议选蓝**(`--t-color-accent`):它是使用面更广的交互色(64 次 vs 4 次),且粉渐变在浅色主题下不可用

---

### 12.4 Phase 3 —— 统一表单控件 + 拆 `!important`(风险最高)

**任务**

- [ ] 落盘 `02-components/field.css`,收敛 32 条基态规则;填充统一到 `--t-color-surface-sunken`
- [ ] 落盘 `02-components/switch.css`(`.t-switch` / `.t-checkbox` / `.t-radio`)
- [ ] `color-scheme: dark` 落地,接管 45 个 checkbox + 16 个 radio + 5 个 range → **解 S2**
- [ ] 按第 6.5 节顺序拆除 `base.css:205-227` 的 3 处 input `!important` → **解 S1**
- [ ] 逐条审查 `memory-recall.css` 的 28 处 `!important`,保留的加注释(R8)

**完成判据**

- `!important` 76 → < 20,且每处紧邻注释说明对抗的具体 ST 规则
- **在 ST 深色 + 浅色 + 至少一个第三方 ST 主题下各截图验证一遍**:输入框、下拉框、复选框不再「半黑半白」
- 审计 A9 通过

**风险与回滚**

- 这是全案风险最高的一步(直接触碰宿主对抗层)
- 建议**先只拆 `base.css` 的 3 处**,发版观察一个版本周期,再处理 `memory-recall.css` 的 28 处
- 若出现穿透:回退到 `!important` 并在注释中记录**具体是哪条 ST 规则**——即使回退,这个记录也是净收益

---

### 12.5 Phase 4 —— 容器类组件统一 + 拆分大文件

**任务**

- [ ] 落盘 `02-components/dialog.css`,合并 3 套弹窗系统(`.t-dialog-*` / `.t-model-dialog-*` / `*-sheet` + `.t-imp-modal`)
- [ ] **删除** `story-outline.css:13/31` 污染全局的 `.t-dialog-overlay` / `.t-dialog-box` 顶层定义,改为 `#t-outline-prompt-manager` 局部覆盖或 `--size` 变体类 → **修 B6**
- [ ] 落盘 `window.css` + `panel.css`,合并 `.t-wi-*` / `.t-queue-*` / `.t-ce-*` 三套 header/footer(消除 6 组字节重复)
- [ ] 落盘 `card.css`,收敛 44 个卡片类名
- [ ] 落盘 `tabs.css`,收敛 `.t-set-tab-btn` 的 3 份定义 + 6 个同义类 → **修 B12**
- [ ] 落盘 `badge.css` / `empty-state.css` / `spinner.css` / `hint.css` / `menu.css`
- [ ] **评估**把简单确认/输入弹窗改用 ST 的 `callGenericPopup`(依 ADR-02)
- [ ] 拆分 `main-window.css`(3,771 行)为 `main-window` / `wi-selector` / `continuation` / `queue` / `content-editor` 五个文件
- [ ] 合并 `.titania-mini-btn` 在 `settings.html` 与 `settings.css:77` 的两处定义 → **修 B10**

**完成判据**

- 字节级重复声明块 23 组 → 0(审计 A13)
- 跨文件冲突定义 5 → 0(审计 A12)
- `.t-dialog-*` 只有一处顶层定义
- **拆分前后 diff 规则总数与选择器集合,断言完全一致**
- `main-window-legacy.css` 仍紧跟 `main-window.css`(审计 A15)

---

### 12.6 Phase 5 —— 清理 inline style

按性质分四批。**27 处数据驱动的必须保留**,并统一改为写 CSS 自定义属性(`workshopWindow.js:255` 的 `style="--card-accent:…"` 已是正确范式)。

| 批次 | 目标 | 数量 | 说明 |
|---|---|---:|---|
| **5a** | `display:none` → `.is-hidden` | 47 | 最简单,先做 |
| **5b** | 纯布局 → `03-layout` 工具类 | 231 | `.t-row` / `.t-gap-md` / `.t-mt-lg` |
| **5c** | **纯视觉 → 组件类(优先)** | 112 | 收益最高:255 处含硬编码颜色的 inline 主要在此 |
| **5d** | 混合 → 拆分为「视觉进组件类 + 布局进工具类」 | 162 | 最费力 |

**推进顺序(按收益)**:`settingsWindow.js`(201 处,占 34%)→ `mainWindow.js`(71)→ `loreReviewWindow.js`(58)→ `scriptManager.js`(57)→ `storyOutlineWindow.js`(47)→ 其余。

**同时**:把 `settings.html:141-261` 的 121 行内嵌 `<style>` 迁到 `04-features/settings-drawer.css`,并把它那第 13 套配色(`#d8e4f0` / `#93a8bb` / `#dce7f3` / `#d5e2ef`)映射到 token。

**已识别的可复用模式**(现状 inline 里已是事实组件,只是没有名字):

```
style="margin-top:15px; padding-top:15px; border-top:1px solid #333;"   ×4  → .t-divider-section
style="background:#181818; padding:15px; border-radius:6px;
       border:1px solid #333; margin-bottom:20px;"                       ×4  → .t-card--info
style="font-size:0.75em; color:#666;"                                    ×7  → .t-text-faint.t-text-xs
```

**完成判据**

- `style="…"` 583 → ~30(仅数据驱动)
- 含硬编码颜色的 inline 255 → 0(审计 A17)
- `settings.html` 内不再有 `<style>` 块与 inline style

---

### 12.7 Phase 6 —— Theme Layer 收口与穷尽式验证

**任务**

- [ ] `semantic.css` 与 `theme-dark.css` 解耦审查:确认**任何组件文件不再直接引用原语层**(审计 A4)
- [ ] 补齐 `--t-gradient-*`、`--t-color-scrim`、`--t-shadow-*` 等「主题相关但非纯颜色」的 token
- [ ] 审计脚本升级为**阻断模式**(第 11.1 节右列)
- [ ] `defaults.js` 的 `appearance` 增加 `ui_theme: "dark"`;`settingsWindow.js` 增加切换控件,回调写 `data-t-theme`
- [ ] **穷尽式验证:建立一次性探针主题**(见下)

**探针主题验证(替代原先的 `follow-st` 方案,见 ADR-06)**

```css
/* 00-tokens/theme-__probe.css —— 仅开发期。Phase 6 结束即删,不进 manifest 发布清单 */
:root[data-t-theme="__probe"] {
  /* 全部 45 个语义 token 改为刺眼且彼此可区分的值 */
  --t-color-bg:             #ff00ff;
  --t-color-surface:        #00ff00;
  --t-color-surface-raised: #00ffff;
  --t-color-surface-sunken: #ffa500;
  --t-color-text:           #ff0000;
  --t-color-text-muted:     #0000ff;
  --t-color-border:         #ffff00;
  /* …其余 38 个同理 */
}
```

**判据**:切到 `__probe` 后,**12 个窗口 + 6 个弹窗里不应残留任何一处原本的深色配色**。任何仍是深灰的像素,就是一处绕过 token 层的漏网点(硬编码字面量 / 漏改的 inline style / 组件文件直接引用原语)。

**为什么用探针而不用真实主题**:它是**穷尽式**的(强制触发全部 45 个 token)、不需要 ST 配合、不受 ST 改名影响、验证完即删。用 `follow-st` 验证只能触发 16 个变量,大部分 token 不会被检验(ADR-06)。

**完成判据**

- 审计脚本阻断模式下 `npm run build` 通过
- `__probe` 主题下无深色残留
- `dark` 主题截图与 Phase 0 基线一致
- 删除 `theme-__probe.css`

---

### 12.8 Phase 7 —— 删除旧 CSS 与最终收口

**任务**

- [ ] 删除 `02-components/_legacy.css`(前提:审计确认 JS 侧零旧类名引用)
- [ ] 删除 `00-tokens/legacy-aliases.css`(前提:审计确认零旧变量引用)
- [ ] **归并间距过渡别名**:`--t-space-10`(119 处)→ `md`/`lg`,`--t-space-15`(27 处)→ `xl`
- [ ] z-index 全面收口到 8 个 token;逐个核对 `99999 !important` / `100000` / `30070` 的真实需求(审计 A19)
- [ ] 断点从 10 个归并到 3 个;JS 侧 `matchMedia` 字符串集中导出(审计 A18)
- [ ] 消灭剩余 `transition: all`(审计 A20)

**完成判据**

- CSS 总行数 14,509 → 9,000~10,500
- 第 1.2 节全部指标达到目标列
- 审计脚本全部检查项通过

**风险**

- **间距归并是唯一会产生系统性 1~2px 位移的步骤。** 按文件分批 + 截图对比,**单独发版并在 changelog 说明**
- 密集列表可能出现换行位置改变,需重点检查 `favsWindow` / `scriptManager` / `loreReviewWindow` 的长列表

---

## 13. 风险登记表

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| **R1** | 拆 `!important` 导致 ST 主题穿透(Phase 3) | 中 | 高 | `.t-root` 两级特异性先行;深/浅/第三方三种 ST 主题逐一截图;分两批发版;保留个别带注释的 important |
| **R2** | primary 配色统一必然改变外观(Phase 2) | **必然** | 中 | 产品决策而非技术问题。单独提交 + 单独发版说明。建议选蓝(浅色主题可用) |
| **R3** | 间距归并产生累计位移(Phase 7) | 高 | 中 | Phase 1 只替换不归并;Phase 7 才归并,按文件分批 + 截图对比 |
| **R4** | 误用 `@layer` 导致插件被 ST 全面穿透 | 低(已识别) | **极高** | ADR-03 明确禁止;R9 + 审计 A10 阻断 |
| **R5** | `.t-root` 漏加到某挂载点 → 该处失去字体基准 | 中 | 中 | 挂载点清单入库(8.2);审计 A21 扫描 `$("body").append` / `ensureOverlay()` 调用点比对清单 |
| **R6** | `--SmartTheme*` 在 ST 升级后改名 | 中 | 低 | 全部引用强制带 fallback(现有 8 处写法已正确);且 ADR-06 已把 `follow-st` 移出范围 |
| **R7** | `rgb(var(--x-rgb) / α)` 兼容性 | 低 | 中 | 空格分隔 + 斜杠 alpha 自 Chrome 65 / FF 52 起支持。**明确不用 `color-mix()`**(Chrome 111+) |
| **R8** | 1.67 MB 的 `index.js` 是生成物,有人误改 | 中 | 高 | 强化 banner 提示(现有 banner 已指向源码);`CONTRIBUTING.md` 写明 |
| **R9** | **重构后被后续 AI 辅助开发重新劣化** | **高** | 高 | **最大的长期风险。** R1–R9 写进 `CLAUDE.md` 让后续会话有约束;审计脚本 Phase 6 起阻断构建 |
| **R10** | 拆分 `main-window.css` 时遗漏或错序 | 中 | 中 | 拆分前后 diff 规则总数与选择器集合,断言完全一致;审计 A15 保证 legacy 紧跟 |
| **R11** | 迁移期间新功能开发与重构冲突 | 中 | 中 | 每 Phase 保持可发版;`_legacy.css` 让新代码用旧类名也不会坏 |
| **R12** | 探针主题误发布(Phase 6) | 低 | 中 | 不写进 `manifest.js`;审计 A14 会因「目录里有未列出文件」而报错 |

---

## 14. 验收指标汇总

以第 1.2 节表格为唯一验收依据,由 `npm run css:audit --compare` 自动比对。

**关键门槛**:

| 门槛 | Phase |
|---|---|
| 审计脚本可运行并产出基线 | 0 |
| 未声明变量 = 0 | 1 |
| 组件层颜色字面量 = 0 | 2(button)/ 6(全部) |
| `!important` < 20 且全部带注释 | 3 |
| 字节级重复块 = 0、跨文件冲突 = 0 | 4 |
| 含硬编码颜色的 inline style = 0 | 5 |
| `__probe` 主题下无深色残留 | 6 |
| CSS 总行数 ≤ 10,500 | 7 |

---

## 15. 最终问题:重构完成后新增 Light Theme 需要改哪些地方?

### 15.1 主体工作:1 个新文件 + 2 行注册 + 1 个设置项

**① 新增 `css/00-tokens/theme-light.css`** —— 重新绑定约 45 个语义 token:

```css
:root[data-t-theme="light"] {
  /* 表面 */
  --t-color-bg:              #f7f8fa;
  --t-color-surface:         #ffffff;
  --t-color-surface-raised:  #f0f2f5;
  --t-color-surface-sunken:  #eaecef;
  --t-color-surface-hover:   rgb(0 0 0 / .04);
  --t-color-surface-active:  rgb(0 0 0 / .08);
  --t-color-scrim:           rgb(0 0 0 / .35);
  /* 文本 */
  --t-color-text:            #1f2328;
  --t-color-text-strong:     #0d1117;
  --t-color-text-secondary:  #57606a;
  --t-color-text-muted:      #6e7781;
  --t-color-text-faint:      #8c959f;
  --t-color-text-on-accent:  #ffffff;
  /* 边框 */
  --t-color-border:          #d0d7de;
  --t-color-border-strong:   #afb8c1;
  --t-color-border-subtle:   rgb(0 0 0 / .08);
  /* 色相:覆盖原语层 —— 浅底上 #90cdf4 / #bfa15f 对比度不足 */
  --t-c-blue-rgb:  49 130 206;
  --t-c-gold-rgb: 141 111  45;
  /* 阴影:浅色主题必须更浅 */
  --t-shadow-lg: 0 10px 30px rgb(0 0 0 / .12);
  --t-shadow-xl: 0 10px 40px rgb(0 0 0 / .16);
  /* 渐变:必须单独给 */
  --t-gradient-title: linear-gradient(135deg, #6b4fbb 0%, #c2185b 100%);
}
:root[data-t-theme="light"] .t-root { color-scheme: light; }
```

**② `css/manifest.js`** 的 `00-tokens` 层加入 `'theme-light.css'`。

**③ 设置项**:`defaults.js` 的 `appearance.ui_theme` 增加 `"light"` 选项(Phase 6 已建好切换机制,无需新代码路径)。

**以上就是全部主体工作。不需要碰任何组件文件、任何 feature 文件、任何 JS 模板。**

### 15.2 仍需处理的残留(约占总工作量 20~30%)

Token 化不了的东西不会因为架构好就消失。**诚实列出**:

| 项目 | 工作量 |
|---|---|
| 装饰性渐变(约 25 处)——需为每个 `--t-gradient-*` 写浅色配方 | 中(6~8 个 token) |
| `-webkit-background-clip:text` 渐变标题(`.t-title-main` / `.t-title-sub`)——浅底对比度不足,可能改纯色 | 小(2 处) |
| `filter: brightness(1.06)` 类 hover ——浅色下「提亮」= 「变白」,需改为显式 token 化 hover 色 | 小(3~5 处) |
| `backdrop-filter: blur()` 的模糊强度在浅底上观感不同,需微调 | 小 |
| Phase 3 保留的 < 20 处 `!important` ——它们为对抗 ST **深色**主题而写,浅色下可能需相反方向 | 小~中,逐条 review |
| **对比度审查** ——浅色主题最易踩的坑是「muted 文字看不见」:`--t-color-text-faint` 在浅底上需要比深底上**更深** | 中,建议按 WCAG AA 逐项校验 |
| 视觉回归:12 窗口 × 6 弹窗 × 3 断点 × 新主题 | 中 |

### 15.3 结论

**「改 1 个文件 + 2 行注册 + 1 个设置项」是准确的核心答案;完整交付一个高质量 Light Theme 还需额外处理约 20 个渐变 / 滤镜 / 对比度残留点。**

与现状对比才是本次重构的真正价值:

| | 现在做 Light Theme | 重构后做 Light Theme |
|---|---|---|
| 需修改的颜色出现点 | **1,930 个字面量 + 255 处 inline** | **约 45 个 token + ~20 个残留点** |
| 需触碰的文件 | 12 CSS + 16 JS + 1 HTML = **29 个** | **1 新增 + 3 改动 = 4 个** |
| 被 `!important` 锁死的组件 | 输入框(**物理上不可能变浅色**) | 无 |
| 原生 checkbox/radio 配色 | 61 个各自失控 | `color-scheme` 一处切换 |
| 结构性阻碍 | 两套 primary、3 套弹窗、13 套配色互相冲突 | 已收敛为单一契约 |
| 回归风险 | 极高(改哪漏哪) | 可控(token 层是唯一变更面) |

这也是「上次让 AI 直接加日间主题效果很差」的机械原因:**当时它面对的是 1,930 个互不相关的颜色决策点,而不是 45 个。这不是模型能力问题,是架构上没有可供修改的收口点。**

---

## 附录 A:建议的起步顺序

1. **先做 Phase 0**(零视觉变化,修 4 个确认 bug + 建护栏)—— 独立价值最高,风险最低,且为后续所有 Phase 提供验证基础。
2. Phase 1 与 Phase 0 可连续做(都不改视觉)。
3. Phase 2 前需先做一次**产品决策**:primary 用蓝还是粉。
4. Phase 3 建议**单独发版并观察一个版本周期**(风险最高)。
5. Phase 5 可与 Phase 4 并行(不同文件,冲突面小)。

## 附录 B:本计划依据的实测命令

用于复现基线数字:

```bash
# 规模
wc -l css/*.css

# 颜色字面量
grep -ohE '#[0-9a-fA-F]{3,8}\b' css/*.css | wc -l
grep -ohE 'rgba?\([^)]*\)' css/*.css | wc -l

# 变量声明 vs 消费
grep -ohE '^\s*--[a-zA-Z0-9-]+\s*:' css/*.css | tr -d ' :' | sort -u
grep -ohE 'var\(--[a-zA-Z0-9-]+' css/*.css | sort | uniq -c | sort -rn

# inline style
grep -c 'style="' -r src --include=*.js | grep -v ':0' | sort -t: -k2 -rn

# 按钮类名
grep -ohE '\.[a-zA-Z0-9_-]*(btn|button)[a-zA-Z0-9_-]*' css/*.css | sort -u | wc -l

# 跨文件冲突定义 / 字节级重复块:见 scripts/css-audit.js 的 A12 / A13
```
