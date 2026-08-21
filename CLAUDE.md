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

审计脚本 `scripts/css-audit.js` 逐条检查这些规则（检查项 A1–A24）。
其中 **8 项为阻断项**（违规直接让 `npm run build` 失败）：
`A8 A10 A11 A14 A15 A22 A23 A24`。

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

> 详细进度、方法与全部踩坑记录在 **`未完成.md`**（交接文档，以它为准）。
> `plan.md` 是原始计划，其中不少条目已被实测否决，**不要照它动手**。

`plan.md` 定义了 Phase 0–7。截至 2026-08-19：

- **Phase 0–4 全部收尾。** 组件层已建 10 个文件；`03-layout/` 已建。
  ⚠ 计划里「建 card.css」「建五个小组件」「换 callGenericPopup」等条目
  **均已盘点后否决**，理由与证据表在 `未完成.md` §4。
- **Phase 5 已到可行下限**：inline style 静态数 556 → 360，A17 261 → 8
  （4 个是永久例外：送进 iframe `srcdoc` / 独立 HTML 导出的标记必须留字面量）。
- **Phase 7-1 / 7-2 已完成**：死代码归零（−1,837 行 / −10%）、A9 归零。
- **当前在 Phase 6b**：把 `04-features/` 的颜色字面量吸附到统一刻度，
  **1,783 → 916**。这是唯一真正卡住「能换主题」的数字。

### ⚠ 用户已把目标收窄 —— 动手前先读这条

用户明确表示**只要「能换主题」这一个核心目标，且是深色 ↔ 浅色切换**。
两项已明确**不做**：`z-index` token 化（40 个不同值，会改堆叠顺序）、
A16 剩余约 360 处静态内联的全量清理（属卫生问题，机会主义地做）。

用户会**逐个提交检查外观**，所以 Phase 6b 起可以成批改色 —— 但每批必须
单独提交、自带感知色差 ΔE 分档汇总。

### Phase 6b 的两道护栏（改颜色前必读）

1. **吸附会让 hover 反馈静默消失。** base 与它的 `:hover` 吸到同一档，
   交互反馈就没了，而审计与「计算值不变」自证**都发现不了**。
   改完必跑 `python scripts/color-tokenize.py --check-state`。
2. **带色偏的暗底是刻意设计。** 收藏窗的暖金、玻璃面板的冷蓝，
   吸成中性灰会抹掉设计意图。表面刻度只接受纯灰（R=G=B，容差 4）。

### Phase 6b 的三条硬规矩

1. **调色板预览色不许 token 化。** `.t-color-swatch[data-color="#90cdf4"]`
   画的就是用户挑的那个 hex，换成 token 后浅色主题下预览会说谎。
   审计 **A24**（阻断项）守这条。
2. **`var(--x, <回退值>)` 里的回退值不许动。** 那是 B5（下方「刻意推迟」第 3 条），
   且等价性自证只解析 `var()` 外层 token、看不见回退值。
3. **逐行配对 git diff 的 `-`/`+` 行不是等价性证明。** 插了注释就会整体错位、
   报出假违规。要用结构化不变量（比对 `[(属性, 最终颜色序列)]`）。


### 刻意推迟的三项（不是遗漏，改前先读理由）

1. **`.t-root` 上的 `line-height: 1.5`**（plan.md §8.1 列了，本项目未落地）
   ST 的 body 没设 line-height，插件现在继承浏览器默认（约 1.2）。设成 1.5 会让
   所有未自行声明 line-height 的元素行距变大、窗口高度改变。plan.md §12.2 的
   「已知视觉变化」清单漏了这一条，应独立成一步实施并单独比对。
2. ~~**`.t-root` 上的 `color-scheme: dark`**（属 Phase 3）~~
   **已完成，本条曾长期过期、误导过后续会话。** `color-scheme: dark` 其实早在
   Phase 3 就落地在 `css/01-base/scope.css` 上（该文件注释里写明了），
   而本清单一直把它列作"待办"。Phase 6c-3 又把它改成
   `color-scheme: var(--t-color-scheme)` 随主题翻转（`dark` / `light`）。
   仍**刻意**留在作用域外的两处，理由写在 `scope.css` 文件尾：
   ST 扩展设置抽屉（10 个原生控件，加 `.t-root` 会连字号基准一起改）、
   `openPromptEntryEditor` 的 shadow DOM（`all: initial` 隔离的深色孤岛，
   两种主题下都是深色，其内部写死 `dark` 是对的）。
3. **B5 的 4 个变量不在 `:root` 补默认值**
   `--t-border-color` 有 5 种互不相同的 fallback（`#55efc4`/`#a29bfe`/`#90cdf4`/
   `#74b9ff`/`#444`），补任何单一默认值都会改色（最直接是设置页预览球的呼吸光晕由青变蓝）。
   详见 `css/00-tokens/legacy-aliases.css` 的说明。

### 没有视觉基线 —— 但用户会逐个提交检查

按用户决定，跳过了 plan.md §12.1 要求的基线截图归档，所以**视觉回归只能靠人工发现**，
无法自动归因到具体某一步。

用户已表示**每次提交都会看一遍外观**，这解掉了「不能改色」的死结。代价是：

- **每批只做一件事、单独提交。** 两种变化混在一批里，用户发现问题时就无法归因。
- **改色的批次必须在提交信息里给出感知色差 ΔE 分档汇总**，让用户能只看
  「ΔE 4–8（明显）」那一档，而不是逐处比对。
- 仍然优先用机械自证（`npm run css:audit:compare`、打包 CSS 逐行 diff、
  `scripts/color-tokenize.py --verify` 的结构化比对）先把「本不该变的」证明为没变。

### 已确认的死代码（已删除，勿照 plan.md 的描述去"修"）

`t-model-dialog-*`（floating.css 内 21 条规则）与 `.titania-recall-overlay`
（memory-recall.css 内 2 条）在 `src/` 中零引用，**已在 Phase 4a-3 / 7-1 删除**。
plan.md 的 B8/B9 把 `.t-model-dialog-box` 当作活跃弹窗根来描述，那是错的。

Phase 7-1 已把**全部**零引用 CSS 规则删完（−1,837 行 / −10%）。
盘点方法与两类必须保留的假阳性判定见 `未完成.md` §7。

