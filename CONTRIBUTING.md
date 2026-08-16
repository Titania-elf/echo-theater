# CONTRIBUTING —— Titania Theater 开发约定

本文是 CSS / UI 层的开发规范。重构总计划见 `plan.md`，AI 会话的精简约束见 `CLAUDE.md`。

---

## 1. 构建

```bash
npm install              # 仅一个 devDependency：esbuild
npm run build            # 打包到根目录 index.js（会先自动跑 css:audit）
npm run build:watch      # 监听模式
```

**`index.js` 是生成物，不要手改。** 它有 1.6 MB，由 `src/entry.js` 打包而来。
banner 注释已指向源码仓库，但仍有人误改过——请从 `src/` 与 `css/` 下手。

### 两种样式加载模式

| 模式 | 机制 | 入口 |
|---|---|---|
| 打包（发布） | `build.js` 的 `injectCSSPlugin` 劫持 `dom.js`，把全部 CSS 内联成一个 `<style>` | `loadCssFiles()` |
| 开发（未打包） | `dom.js` 按清单逐个插入 `<link>` | `loadCssFiles()` |

两者的文件清单**必须**来自同一数据源 `css/manifest.js`。历史上两处各写一份并已漂移
（`dom.js` 漏了 `workshop.css`），导致开发模式下工坊窗口完全无样式。

`bundleCSS()` 在清单文件缺失时会**直接失败并退出码 1**。它原先是静默 `existsSync` 跳过，
结果 2026-08 的目录重构把 CSS 移进分层目录后，构建静默产出了零行 CSS 而无人发现。

---

## 2. CSS 目录分层

```
css/
├── manifest.js        ★ 单一数据源：有序文件清单（顺序 = 层叠顺序）
├── 00-tokens/         Design Tokens（尚未创建，Phase 1）
├── 01-base/           作用域与基础
│   ├── base.css         （待 Phase 1 拆分为 scope/typography/scrollbar）
│   └── keyframes.css  ★ 全库唯一的 @keyframes 声明处
├── 02-components/     语义化组件（尚未创建，Phase 2–4）
├── 03-layout/         布局原语（尚未创建）
├── 04-features/       功能视图：只允许布局 + 该功能独有视觉
└── 05-utilities/      工具类（尚未创建）
```

分层**只在目录组织 + 拼接顺序 + 审计规则**层面实现，**不使用 CSS `@layer` 语法**。
理由见 `plan.md` ADR-03：未分层声明优先级高于所有分层声明，用了 `@layer` 会被宿主穿透。

---

## 3. 分层规则 R1–R9

| 规则 | 内容 | 审计项 |
|---|---|---|
| **R1** | `00-tokens/` 不引用任何其它层 | — |
| **R2** | `02-components/` 禁止 ID 选择器、`#t-*-view` 前缀、任何 feature 类名 | A2 |
| **R3a** | `02-components/` 禁止 hex / rgb / rgba 字面量。白名单：`transparent`、`currentColor`、`inherit` | A3 |
| **R3b** | `02-components/` 禁止直接引用 `--t-c-*` 原语，只能用语义 token | A4 |
| **R4** | `04-features/` 禁止重定义组件类的**视觉**属性；**允许**调整**布局**属性 | A5 |
| **R5** | `04-features/` 之间禁止互相引用彼此的类名 | A6 |
| **R6** | 所有 `@keyframes` 只能在 `01-base/keyframes.css` 声明，且必须 `t-` 前缀 | A7 / A22 |
| **R7** | 全局伪元素选择器必须以 `.t-root` 开头 | A8 |
| **R8** | 新增 `!important` 必须紧邻注释说明它在对抗哪条具体宿主规则 | A9 |
| **R9** | 禁止使用 `@layer` | A10 |

### R4 的判定边界

允许 feature 层调整组件的**布局**：`width` / `height` / `margin` / `flex` / `grid-area` / `order` / `position`。
禁止调整**视觉**：`color` / `background*` / `border*` / `box-shadow` / `font*` / `border-radius` / `opacity` / `outline`。

理由：同一个按钮在不同页面可以有不同尺寸和位置，但不该有不同长相。

### R8 的写法

```css
/* 对抗 ST public/style.css:412 的 .drawer-content input 背景色 */
background-color: var(--t-color-surface-sunken) !important;
```

「防御性 important」要变成「有据可查的 important」——注释里写清具体是哪条宿主规则。

---

## 4. 审计脚本

```bash
npm run css:audit            # 报告模式（默认）
npm run css:audit:strict     # 全部检查转阻断（Phase 6 起的目标状态）
npm run css:audit:compare    # 与基线对比，显示增量
npm run css:audit:baseline   # 更新基线快照
node scripts/css-audit.js --verbose   # 打印每条违规的 file:line
```

零运行时依赖，CSS 解析是 `scripts/css-audit.js` 内手写的最小实现。

### 阻断策略

**当前（Phase 0）阻断**：A10（`@layer`）、A11（未声明变量）、A14（清单↔磁盘）、
A15（legacy 紧跟主文件）、A22（悬空动画）。其余为报告。

`prebuild` 钩子让 `npm run build` 自动先跑审计，阻断项违规会拦住构建。

### A11 的三态判定

| 状态 | 处理 |
|---|---|
| CSS 层已声明 | 通过 |
| 仅由 JS 写在元素上 | 报告——数据驱动的正确用法，但 CSS 层缺兜底值（缺陷 B5） |
| CSS 与 JS 都没有 | **阻断**——只能靠 `var()` fallback 里的硬编码色兜底 |

### A22 的来历

这一项不在 `plan.md` §11.1 的原始清单里。2026-08-16：24 个 `@keyframes` 定义在目录重构中
被删除后未落地到新文件，22 个动画（45 个引用点）静默失效，而 CSS 不会为未定义的
`animation-name` 报任何错。故列为 Phase 0 阻断项。

---

## 5. 排版与颜色约定

**用 `em`，不用 `rem`。** UI 缩放的实现是在容器上写
`font-size: calc(12px * var(--t-ui-font-scale))`（`settingsWindow.js` 把变量写到 `documentElement`）。
`rem` 相对 `html` 根字号，会完全绕过这个机制，导致缩放功能失效。

**颜色 token 用 RGB 通道三元组：**

```css
/* 原语层 */
--t-c-blue-rgb: 144 205 244;
/* 语义层消费，可带 alpha */
--t-color-accent-soft: rgb(var(--t-c-blue-rgb) / .12);
```

因为 `rgba()` 无法接收 hex 变量，而项目有 749 处 `rgba()` 字面量需要 token 化。
**不使用 `color-mix()`**：需 Chrome 111+，对老旧移动端 WebView 有风险。

**不引入 CSS 预处理器。** 纯自定义属性已满足需求，且运行时可变——这正是主题切换的前提。

---

## 6. 与 SillyTavern 的边界

插件与 ST 共享同一个 `document`，所以：

- **定点复用 ST 能力**：Toast 一律用 ST 的 `toastr`（已有 253 处调用），不自建。
- **不把 `--SmartTheme*` 当 token 层**：ST 只暴露 16 个，没有层级/间距/圆角/阴影尺度，
  且属内部实现可能改名。现有引用**必须带 fallback**。
- **注入 ST DOM 的按钮保持独立**：`.titania-inject-btn` / `.titania-recall-btn` 故意继承
  ST 的 `.mes_button`，要与 ST 消息按钮融合，**不进插件组件体系**，也**不加** `.t-root`。

---

## 7. 提交约定

沿用现有风格：`fix：…` / `feat：…`（全角冒号）。

重构相关的改动请：
- 每项独立提交，可单独 revert
- 视觉有变化的改动**单独成提交**并在 changelog 说明
- 拆分大文件时，diff 前后的规则总数与选择器集合，断言完全一致
