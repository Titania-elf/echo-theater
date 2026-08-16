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

- **Phase 0 已完成**：修 B1（清单漂移）、B2（滚动条泄漏）、B3/B4（keyframes 撞名与重复）；
  建立 `scripts/css-audit.js` 护栏（A1–A23）。
- **Phase 1 已完成**：`00-tokens/` 四个文件（158 个 token）+ `01-base/scope.css`；
  49 处挂载点已加 `.t-root`；修 B9。**未替换任何字面量** —— Phase 1 只「提供」token，
  组件层与 feature 层的字面量替换从 Phase 2 起逐步进行。
- `02-components/`、`03-layout/`、`05-utilities/` **尚未创建**，
  故审计项 A2–A5 报告「跳过」而非「通过」。Phase 2 起才会生效。
- 已知缺陷 B5–B13、S1–S4 见 `plan.md` §2，**不要顺手改**，它们各有归属 Phase。

### 刻意推迟的三项（不是遗漏，改前先读理由）

1. **`.t-root` 上的 `line-height: 1.5`**（plan.md §8.1 列了，本项目未落地）
   ST 的 body 没设 line-height，插件现在继承浏览器默认（约 1.2）。设成 1.5 会让
   所有未自行声明 line-height 的元素行距变大、窗口高度改变。plan.md §12.2 的
   「已知视觉变化」清单漏了这一条，应独立成一步实施并单独比对。
2. **`.t-root` 上的 `color-scheme: dark`**（属 Phase 3）
   ST 的 body 设了 `color-scheme: only light`，这是 S2 的根因。改为 dark 会让
   66 个原生 checkbox/radio/range 外观立刻翻转，需在 ST 深/浅/第三方主题下逐一验证。
3. **B5 的 4 个变量不在 `:root` 补默认值**
   `--t-border-color` 有 5 种互不相同的 fallback（`#55efc4`/`#a29bfe`/`#90cdf4`/
   `#74b9ff`/`#444`），补任何单一默认值都会改色（最直接是设置页预览球的呼吸光晕由青变蓝）。
   详见 `css/00-tokens/legacy-aliases.css` 的说明。

### 没有视觉基线

按用户决定，跳过了 plan.md §12.1 要求的基线截图归档。因此**视觉回归只能靠人工发现**，
无法自动归因到具体某一步。改动视觉相关内容时请格外保守，并优先用
`npm run css:audit:compare` 与打包 CSS 的逐行 diff 做验证。

### 已确认的死代码（勿照 plan.md 的描述去"修"）

`t-model-dialog-*`（floating.css 内 21 条规则）与 `.titania-recall-overlay`
（memory-recall.css 内 2 条）在 `src/` 中**零引用**。plan.md 的 B8/B9 把
`.t-model-dialog-box` 当作活跃弹窗根来描述，实际它已是死代码。

