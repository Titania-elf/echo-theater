# CLAUDE.md —— 本项目的硬性约束

> 给后续 AI 会话的约束清单。改动 CSS 或 UI 前必读。
> 完整说明见 `CONTRIBUTING.md`，重构总计划见 `plan.md`。

## 绝对不要做的事

1. **不要手改 `index.js`。** 它是 `npm run build` 的生成物（1.6 MB）。源码在 `src/`，样式在 `css/`。
2. **不要使用 CSS `@layer`。** CSS 级联规定未分层声明优先级高于所有分层声明，
   一旦把插件 CSS 包进 `@layer`，插件外观会被宿主 SillyTavern 全面穿透。见 `plan.md` ADR-03。
3. **不要在 `css/01-base/keyframes.css` 之外声明 `@keyframes`**，且名字必须带 `t-` 前缀。
   无前缀会与 ST 及其它第三方扩展撞名。
4. **不要在 `build.js` 或 `src/utils/dom.js` 里手写 CSS 文件清单。**
   唯一数据源是 `css/manifest.js`。历史上这里写过两份并已漂移，导致开发模式下整个窗口无样式。
5. **不要写无作用域的全局选择器**（`::-webkit-scrollbar`、裸元素选择器等）。
   插件 `<style>` 注入在 `document.head`，晚于 ST 样式表，会直接重写整个 SillyTavern。

## 改完必须自查

```bash
npm run css:audit        # 报告模式；Phase 0 阻断项违规会退出码 1
npm run build            # 已配 prebuild，会自动先跑审计
```

`npm run build` 现在会在 CSS 清单与磁盘不一致时**直接失败**，不再静默产出残缺样式。

## CSS 分层规则 R1–R9

审计脚本 `scripts/css-audit.js` 逐条检查这些规则（检查项 A1–A22）。

| 规则 | 内容 |
|---|---|
| **R1** | `00-tokens/` 不引用任何其它层 |
| **R2** | `02-components/` 禁止 ID 选择器、`#t-*-view` 前缀、任何 feature 类名 |
| **R3a** | `02-components/` 禁止 hex / rgb / rgba 字面量。白名单：`transparent`、`currentColor`、`inherit` |
| **R3b** | `02-components/` 禁止直接引用 `--t-c-*`（原语层），只能用语义 token |
| **R4** | `04-features/` 禁止重定义组件类的**视觉**属性（color/background/border/box-shadow/font-*/border-radius）；**允许**调整**布局**属性（width/margin/grid-area/order/flex） |
| **R5** | `04-features/` 之间禁止互相引用彼此的类名 |
| **R6** | 所有 `@keyframes` 只能在 `01-base/keyframes.css` 声明，且必须 `t-` 前缀 |
| **R7** | 全局伪元素选择器必须以 `.t-root` 开头 |
| **R8** | 新增 `!important` 必须紧邻注释说明它在对抗哪条具体宿主规则 |
| **R9** | 禁止使用 `@layer`（见 R1–R9 上方第 2 条） |

## 排版单位约定

- **用 `em`，不用 `rem`。** UI 缩放靠容器上的 `font-size: calc(12px * var(--t-ui-font-scale))` 实现，
  `rem` 相对 `html` 根字号会完全绕过这个机制，导致缩放功能失效。
- 颜色 token 用 RGB 通道三元组（`--t-c-x-rgb: R G B`），消费时 `rgb(var(--t-c-x-rgb) / α)`，
  因为 `rgba()` 无法接收 hex 变量。**不使用 `color-mix()`**（兼容性）。

## 当前重构进度

`plan.md` 定义了 Phase 0–7。当前状态：

- **Phase 0 进行中**：已修 B1（清单漂移）、B3/B4（keyframes 撞名与重复）；已建审计脚本。
  待办：B2（滚动条泄漏）、视觉基线截图。
- `00-tokens/`、`02-components/`、`03-layout/`、`05-utilities/` **尚未创建**，
  故审计项 A2–A5 目前报告「跳过」。Phase 1/2 起才会生效。
- 已知缺陷 B5–B13、S1–S4 见 `plan.md` §2，**不要顺手改**，它们各有归属 Phase。
