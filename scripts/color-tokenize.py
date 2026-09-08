#!/usr/bin/env python3
"""Phase 6 颜色 token 化工具 —— 等值替换 + 自证。

为什么需要它：目标是「深色 ↔ 浅色主题切换」，要求所有颜色都走 token。
04-features 里原有 1783 个写死的颜色，其中一部分与现有 token **逐值相同**，
可以零视觉变化地替换掉；本脚本只做这一部分，并能机械自证。

用法
----
  python scripts/color-tokenize.py --report                 # 只报告：还有哪些精确匹配可替换
  python scripts/color-tokenize.py <css文件...>             # dry-run
  python scripts/color-tokenize.py <css文件...> --apply     # 实际替换
  python scripts/color-tokenize.py <css文件...> --verify    # 与 HEAD 比对，证明计算值不变
  python scripts/color-tokenize.py <css文件...> --tokenize-shadow --apply
                                                            # 阴影 -> --t-shadow-* token

映射表 MAP 是**手写**的，不自动猜。同一个颜色值可能对应多个 token，
故按属性角色区分：color→text / background*→surface / border*|outline*→border / *shadow*→shadow。
候选 token 语义都很窄、需人工判断的一律不进 MAP（会在 --report 里列出）。

已知限制
--------
* 行尾混用的文件会被跳过（整体重写会统一行尾、产出巨量无关 diff，见交接文档 §5b）。
  先用 --normalize-eol 单独归一化（本仓库 blob 是 LF，这类归一化通常不产生 git diff）。
* 不处理渐变里的颜色停靠点之外的写法；只认 #hex 与 rgb()/rgba()。
* --verify 只证明「计算值不变」，不证明「选择器命中没变」—— 后者由 css:audit 与
  scripts/verify-inline-migration.py 负责。
"""
import argparse
import colorsys
import io
import os
import re
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

TOKEN_DIR = 'css/00-tokens'
FEATURE_DIR = 'css/04-features'

# ── 手写映射：canonical (r,g,b,a) -> token 名，或 {角色: token} ──
MAP = {
    (144, 205, 244, 1.0): '--t-color-accent',
    (191, 161, 95, 1.0): '--t-color-brand',
    (255, 255, 255, 1.0): '--t-color-text-strong',
    (68, 68, 68, 1.0): {'border': '--t-color-border-strong',
                        'surface': '--t-color-surface-hover-solid'},
    (102, 102, 102, 1.0): {'text': '--t-color-text-faint',
                           'border': '--t-color-border-mid'},
    # ⚠ 上面两条从「一个 token 通吃所有角色」改成按角色分。Phase 6b-20 把工具
    #   扩到 01-base 时才暴露：#666 只有 --t-color-text-faint（文字角色），
    #   拿它去填 .t-tool-btn 的 border 就是把文字 token 当描边用；#444 同理
    #   （只有 --t-color-border-strong，却要当 .t-tool-btn:hover 的底）。
    #   改成 dict 不影响既有替换 —— 实测 04-features 里这两个值已无字面量。
    (204, 204, 204, 1.0): {'text': '--t-color-text-label'},
    (85, 85, 85, 1.0): {'border': '--t-color-border-bright',
                        'text': '--t-color-text-disabled'},
    (255, 255, 255, 0.2): {'surface': '--t-color-scrollbar-thumb'},
    (255, 255, 255, 0.4): {'surface': '--t-color-scrollbar-thumb-hover'},
    # ⚠ 白 /.2 与 /.4 只作 surface 映射：main-window.css 里还有一处
    #   `color: rgba(255,255,255,.4)`，那是文字，不能套滚动条 token。
    (136, 136, 136, 1.0): '--t-color-text-muted',
    (42, 42, 42, 1.0): '--t-color-surface-raised',
    (170, 170, 170, 1.0): '--t-color-text-secondary',
    (26, 26, 26, 1.0): '--t-color-surface-sunken',
    (238, 238, 238, 1.0): '--t-color-text',
    (160, 174, 192, 1.0): '--t-color-dialog-close',
    (85, 239, 196, 1.0): '--t-color-notify',
    (30, 30, 30, 1.0): '--t-color-surface',
    (24, 24, 24, 1.0): '--t-color-surface-inset',
    (17, 17, 17, 1.0): '--t-color-surface-well',
    (58, 58, 58, 1.0): '--t-color-border-control',
    (162, 155, 254, 1.0): '--t-color-decor',
    (255, 107, 107, 1.0): '--t-color-danger',
    (203, 213, 224, 1.0): '--t-color-dialog-label',
    (113, 128, 150, 1.0): '--t-color-text-cool-muted',
    (72, 187, 120, 1.0): '--t-color-success',
    (245, 158, 11, 1.0): '--t-color-warning',
    (169, 191, 209, 1.0): '--t-glass-text-secondary',
    (18, 22, 29, 1.0): '--t-glass-body',
    (255, 255, 255, 0.03): '--t-color-surface-veil',
    (255, 255, 255, 0.06): '--t-color-surface-hover-subtle',
    (255, 255, 255, 0.14): '--t-color-field-glass-border',
    (255, 255, 255, 0.18): '--t-color-border-glass',
    (144, 205, 244, 0.12): '--t-color-accent-soft',
    (144, 205, 244, 0.22): '--t-color-accent-soft-strong',
    (144, 205, 244, 0.3): '--t-color-accent-border-subtle',
    (144, 205, 244, 0.35): '--t-color-accent-border',
    (144, 205, 244, 0.4): '--t-color-focus-ring',
    (144, 205, 244, 0.55): '--t-color-field-glass-focus-border',
    (144, 205, 244, 0.6): '--t-color-accent-border-hover',
    (191, 161, 95, 0.14): '--t-color-brand-soft',
    (191, 161, 95, 0.55): '--t-color-brand-border',
    (72, 187, 120, 0.1): '--t-color-success-veil-subtle',
    (72, 187, 120, 0.2): '--t-color-success-soft',
    (72, 187, 120, 0.3): '--t-color-success-border-subtle',
    (245, 158, 11, 0.1): '--t-color-warning-veil-subtle',
    (245, 158, 11, 0.2): '--t-color-warning-soft',
    (245, 158, 11, 0.3): '--t-color-warning-border-subtle',
    (255, 107, 107, 0.4): '--t-color-danger-border',
    (120, 150, 170, 0.3): '--t-color-border-cool',
    (7, 11, 18, 0.9): '--t-glass-field',
    (22, 27, 36, 0.6): '--t-glass-row',
    (28, 34, 44, 0.7): '--t-glass-row-head',
    (34, 42, 54, 0.7): '--t-glass-row-hover',
    # ── 按属性角色区分 ──
    (51, 51, 51, 1.0): {'border': '--t-color-border'},
    (255, 255, 255, 0.10): {'border': '--t-color-border-subtle'},
    (255, 255, 255, 0.08): {'border': '--t-color-border-faint',
                            'surface': '--t-color-surface-hover'},
    (204, 204, 204, 1.0): {'text': '--t-color-text-label'},
    (226, 232, 240, 1.0): {'text': '--t-color-text-cool'},
    (18, 18, 18, 1.0): {'surface': '--t-color-bg'},
    (144, 205, 244, 0.10): {'surface': '--t-color-accent-veil',
                            'shadow': '--t-color-field-dialog-ring'},
    # ⚠ 下面这些**刻意只映射 background / color，不映射 box-shadow**。
    # 黑色半透明用作阴影时，浅色主题下应当**仍然是深色**；若映到
    # --t-color-surface-* / --t-color-scrim 这类表面 token，切到浅色主题时
    # 阴影会跟着变亮而消失。阴影应改用整条 --t-shadow-* token，属另一步。
    (0, 0, 0, 0.2): {'surface': '--t-color-surface-recess'},
    (0, 0, 0, 0.3): {'surface': '--t-color-surface-recess-strong'},
    (0, 0, 0, 0.85): {'surface': '--t-color-dialog-scrim-strongest'},
    (36, 36, 36, 1.0): {'surface': '--t-color-panel-header'},
    (0, 206, 201, 0.1): {'surface': '--t-color-field-dialog-notify-ring'},
    (0, 206, 201, 1.0): {'text': '--t-color-field-dialog-notify'},
    (185, 216, 238, 1.0): {'text': '--t-glass-tab-text-active'},
    (220, 233, 244, 1.0): {'text': '--t-color-field-glass-text'},
}

# 刻意不进 MAP（候选 token 语义都很窄或需人工判断，见交接文档 §6）：
#   #222222        候选 field-focus / set-tab-hover-surface / surface-option
#   #ffffff .05    只有 glass 系候选，用在非 glass 文件里语义不对
#   #ffffff .10 作 background   只有 dialog-close-hover
#   #ffffff .15    候选 border-hover-subtle / field-dialog-border / surface-active
#   #333333 作 background       只有 surface-code（专指 <code> 片）
#   #90cdf4 .16    候选 field-glass-focus-ring / glass-tab-active-surface


def hex2rgb(h):
    """返回 (r, g, b, alpha)。认不出的返回 None。

    ⚠ 必须解析 4 位与 8 位 hex 的 **alpha 字节**。早期版本直接 `h = h[:6]` 把它
    截掉，于是 `#4a9eff33`（20% 的淡蓝洗色）被读成不透明蓝 —— 一旦对它做 token 化
    就会把淡洗色改成实心色块，而**自证抓不到**：HEAD 侧与工作区侧走的是同一个
    坏解析，两边都得出 alpha=1.0，逐位比对完全一致。
    这类「解析器共用的偏差」是自证的盲区，只能靠单独校验解析器本身来发现。
    全库当时有 2 处（wi-selector.css 的 #4a9eff33 / #ff9f4333）。
    """
    h = h.lstrip('#')
    a = 1.0
    if len(h) in (3, 4):
        if len(h) == 4:
            a = int(h[3] * 2, 16) / 255.0
        h = ''.join(c * 2 for c in h[:3])
    elif len(h) == 8:
        a = int(h[6:8], 16) / 255.0
        h = h[:6]
    if len(h) != 6:
        return None
    try:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (round(a, 3),)
    except ValueError:
        return None


# CSS 颜色关键字。
# ⚠ 为什么必须认：Phase 6b-20 把 01-base/base.css 的 `color: white` 换成 token 时，
#   --verify 报「颜色位数变了 19 -> 20」—— 因为 COLOR_RE 只认 #hex 与 rgb()/rgba()，
#   关键字在 HEAD 侧**根本没进颜色序列**。也就是说关键字写法对统计与自证**双向隐形**：
#   既不计入「剩余字面量」，改动它也无法自证等价。
#   实测全库当时只有那 1 处（其余 grep 命中都是含颜色词的 token 名与注释），
#   但缺这张表意味着以后任何人写 `color: white` 都会静默逃过所有检查。
#   只收无歧义的基本关键字；transparent/currentColor/inherit 属 R3a 白名单，不在此列。
COLOR_KEYWORDS = {
    'white': (255, 255, 255, 1.0),
    'black': (0, 0, 0, 1.0),
    'red': (255, 0, 0, 1.0),
    'lime': (0, 255, 0, 1.0),
    'blue': (0, 0, 255, 1.0),
    'yellow': (255, 255, 0, 1.0),
    'cyan': (0, 255, 255, 1.0),
    'aqua': (0, 255, 255, 1.0),
    'magenta': (255, 0, 255, 1.0),
    'fuchsia': (255, 0, 255, 1.0),
    'silver': (192, 192, 192, 1.0),
    'gray': (128, 128, 128, 1.0),
    'grey': (128, 128, 128, 1.0),
    'maroon': (128, 0, 0, 1.0),
    'olive': (128, 128, 0, 1.0),
    'green': (0, 128, 0, 1.0),
    'purple': (128, 0, 128, 1.0),
    'teal': (0, 128, 128, 1.0),
    'navy': (0, 0, 128, 1.0),
    'orange': (255, 165, 0, 1.0),
    'pink': (255, 192, 203, 1.0),
    'gold': (255, 215, 0, 1.0),
}
# 关键字的词边界：前后都不能是标识符字符或连字符，否则 `white-space` / `--t-c-gold-rgb`
# 会被误当成颜色。
KEYWORD_RE = re.compile(r'(?<![-\w])(%s)(?![-\w])' % '|'.join(COLOR_KEYWORDS))


def canon(v):
    """把颜色写法归一化为 (r, g, b, alpha)。认不出的返回 None。"""
    # ⚠ 不要在这里去掉空格：现代写法 rgb(24 24 24) 靠空格分隔通道，
    # 去空格会变成 rgb(242424) 而解析失败（本项目的 token 就是空格写法）。
    v = v.strip().lower()
    if v in COLOR_KEYWORDS:
        return COLOR_KEYWORDS[v]
    if v.startswith('#'):
        return hex2rgb(v)
    m = re.match(r'rgba?\(([^)]*)\)$', v)
    if not m:
        return None
    # ⚠ 必须同时支持逗号与空格分隔：现代写法 rgb(24 24 24) / rgb(R G B / a) 很常见，
    # 本项目的 token 就是这么写的。早期版本只按逗号切，导致这类 token 在分析里
    # 被解析成 None、整批精确匹配对分析隐形（踩过一次）。
    parts = [p for p in re.split(r'[,\s]+', m.group(1).replace('/', ' , ')) if p]
    try:
        n = [float(p.rstrip('%')) for p in parts[:4]]
    except ValueError:
        return None
    if len(n) < 3:
        return None
    return (int(n[0]), int(n[1]), int(n[2]), round(n[3] if len(n) > 3 else 1.0, 3))


def role_of(prop):
    p = prop.lower()
    if p == 'color':
        return 'text'
    if p.startswith('background'):
        return 'surface'
    if p.startswith(('border', 'outline')):
        return 'border'
    if 'shadow' in p:
        return 'shadow'
    return 'other'


def token_defs():
    """当前生效的 token 定义（= 深色主题）。

    ⚠ 只收**无条件 `:root {}`** 块里的声明。Phase 6c 加了
      `00-tokens/theme-light.css`，它的选择器是 `:root[data-t-theme="light"]`；
      早先这里是「把 00-tokens/ 下所有 --t-*: 都收进一个 dict」，于是按字母序
      theme-light 覆盖了 theme-dark，所有自证瞬间拿浅色值去比 HEAD 的深色值 ——
      --verify 一次报出 **272 处**「超容差」，而 CSS 一个字都没动。
      加一个主题文件就让全部自证静默失效，是这一路最隐蔽的一次。
    """
    defs = {}
    for f in sorted(os.listdir(TOKEN_DIR)):
        if not f.endswith('.css'):
            continue
        s = re.sub(r'/\*.*?\*/', '', open(os.path.join(TOKEN_DIR, f), encoding='utf-8').read(),
                   flags=re.S)
        # 逐个规则块取，只要选择器恰好是 :root（允许 .t-root 之类的并列）
        for bm in re.finditer(r'([^{}]+)\{([^{}]*)\}', s):
            sels = [x.strip() for x in bm.group(1).split(',')]
            if not any(x == ':root' for x in sels):
                continue
            for m in re.finditer(r'(--t-[\w-]+)\s*:\s*([^;]+);', bm.group(2)):
                defs[m.group(1)] = m.group(2).strip()
    return defs


def resolve(defs, expr, depth=0):
    """把 token 表达式逐层解析成最终 (r,g,b,a)。"""
    if depth > 8:
        return None
    e = expr.strip()
    m = re.fullmatch(r'var\((--t-[\w-]+)(?:,[^)]*)?\)', e)
    if m:
        return resolve(defs, defs.get(m.group(1), ''), depth + 1) if m.group(1) in defs else None
    m = re.fullmatch(r'rgba?\(\s*var\((--t-[\w-]+)\)\s*(?:/\s*([\d.]+))?\s*\)', e)
    if m:
        nums = re.findall(r'\d+', defs.get(m.group(1), ''))
        if len(nums) >= 3:
            a = float(m.group(2)) if m.group(2) else 1.0
            return (int(nums[0]), int(nums[1]), int(nums[2]), round(a, 3))
        return None
    return canon(e)


# 「一个颜色字面量」的模式片段。**只在这里写一次**，下面 COLOR_RE 与 COLOR_OR_VAR
# 都由它拼出来。
# ⚠ 为什么必须共用：这个项目里「同一个模式写两份然后只修了一份」已经出过两次 ——
#   6b-12 是 color_sequence 与 bg_map 各写一份（--verify 说零变化、--check-state 却
#   报假回归）；6b-20 是 COLOR_RE 加了颜色关键字而 COLOR_OR_VAR 没加
#   （改 `color: white` 时 --verify 报「颜色位数变了」这种假违规）。
#   两次的症状都是「两个自证工具对同一份 CSS 给出矛盾结论」。
_LITERAL = (r'#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\)'
            r'|(?<![-\w])(?:%s)(?![-\w])' % '|'.join(COLOR_KEYWORDS))

# 声明值里的一个颜色字面量（供改写用）。
COLOR_RE = re.compile(_LITERAL)
DECL_RE = re.compile(r'(^|[;{\s])([-a-zA-Z]+)\s*:\s*([^;{}]*)')
COMMENT_RE = re.compile(r'/\*.*?\*/', re.S)
# 选择器里带字面量颜色的规则（调色板预览球）——整块跳过，见 _snap 里的说明与审计 A24
PALETTE_RULE = re.compile(
    r'\[[a-zA-Z-]+\s*[~^$*|]?=\s*"#[0-9a-fA-F]{3,8}"\][^{}]*\{[^{}]*\}')
# var(--x, <回退值>) 里的回退值区间 —— 属 B5，整段跳过，见 _snap 里的说明
VAR_FALLBACK = re.compile(r'var\(\s*--[\w-]+\s*,([^()]*(?:\([^()]*\)[^()]*)*)\)')


# 声明值里的「一个颜色」：token 引用或字面量。
# ⚠ 第 ① 支必须排在第 ② 支之前。feature 层从 Phase 6b-12 起会出现
#   `rgb(var(--t-accent-x-rgb) / .25)`：若先匹配到内层的 `var(--t-accent-x-rgb)`，
#   它解析出的是三元组字符串 `74 158 255`（canon 认不出 → None），
#   **alpha 会被整段丢掉**，两侧都得出 None 而"比对通过"。
# ⚠ 这个模式**只能有一份**。它原先在 color_sequence() 与 bg_map() 里各写了一遍，
#   于是修了前者、后者仍带着 bug —— --verify 说「1905 个颜色位零变化」的同一批改动，
#   --check-state 却报出一处「毁掉了可见反馈」的假回归（两侧都解析成 None 而相等）。
#   两个自证工具对同一份 CSS 给出矛盾结论，只可能是其中一个的解析器坏了。
COLOR_OR_VAR = re.compile(r'(rgba?\(\s*var\(--t-[\w-]+\)\s*(?:/\s*[\d.]+\s*)?\))'
                          r'|var\((--t-[\w-]+)(?:,[^()]*(?:\([^()]*\)[^()]*)*)?\)'
                          r'|' + _LITERAL)


def resolve_match(defs, cm):
    """把 COLOR_OR_VAR 的一个匹配解析成 (r,g,b,a)；解析不出返回 None。"""
    if cm.group(1):
        return resolve(defs, cm.group(1))
    if cm.group(2):
        return resolve(defs, defs.get(cm.group(2), ''))
    return canon(cm.group(0))


def resolve_multi(defs, cm, depth=0):
    """同 resolve_match，但能展开**含多个颜色**的 token（渐变、阴影配方）。

    返回颜色列表。为什么需要：`--t-gradient-brand-bar` 的值是
    `linear-gradient(to bottom, #ff9a9e, #fad0c4)`，resolve() 认不出、给 None。
    于是把 feature 里的字面量渐变换成该 token 时，HEAD 侧是 2 个颜色位、
    工作区侧是 1 个 None —— --verify 会报「颜色位数变了」这种**假违规**，
    而真正的等价性它反而证明不了。展开后两侧都是 2 个颜色位，可以逐位比。
    这也让所有 --t-gradient-* / --t-shadow-* 的消费点第一次真正进入自证范围。
    """
    single = resolve_match(defs, cm)
    if single is not None:
        return [single]
    name = cm.group(2)
    if not name or depth > 6:
        return [None]
    expr = defs.get(name)
    if not expr:
        return [None]
    out = []
    for m in COLOR_OR_VAR.finditer(expr):
        out.extend(resolve_multi(defs, m, depth + 1))
    return out or [None]


def eol_of(raw):
    crlf = raw.count('\r\n')
    return crlf, raw.count('\n') - crlf


def rewrite(path):
    raw = open(path, encoding='utf-8', newline='').read()
    crlf, lf = eol_of(raw)
    if crlf and lf:
        return None, '行尾混用（CRLF=%d LF=%d），跳过；先用 --normalize-eol' % (crlf, lf)
    spans = [(m.start(), m.end()) for m in COMMENT_RE.finditer(raw)]
    # ⚠ 与 _snap / tokenize_hue 同两条护栏。这里**曾经漏掉**，是个只差一步就会
    #   触发的 bug：MAP 里有 (85,239,196)->--t-color-notify，而
    #   01-base/keyframes.css 有 4 处 `var(--t-border-color, #55efc4)`。
    #   本函数此前只在 04-features 上跑过（那里没有这类回退值），一旦扩到 01-base
    #   就会改写 var() 的回退值 —— 那是 B5（CLAUDE.md 列为刻意推迟），
    #   且 --verify / color_sequence 只解析 var() 外层 token、**看不见回退值**，
    #   等于改了没有任何自证能发现。
    skip = [(m.start(), m.end()) for m in PALETTE_RULE.finditer(raw)]
    skip += [(m.start(1), m.end(1)) for m in VAR_FALLBACK.finditer(raw)]

    def in_comment(i):
        return any(a <= i < b for a, b in spans)

    out, last, done = [], 0, 0
    for dm in DECL_RE.finditer(raw):
        if in_comment(dm.start(2)):
            continue
        role = role_of(dm.group(2))
        vs, ve = dm.start(3), dm.end(3)
        seg, pieces, pos = raw[vs:ve], [], 0
        for cm in COLOR_RE.finditer(seg):
            k = canon(cm.group(0))
            if k is None:
                continue
            if any(a <= vs + cm.start() < b for a, b in skip):
                continue
            t = MAP.get(k)
            if isinstance(t, dict):
                t = t.get(role)
            if not t:
                continue
            pieces.append(seg[pos:cm.start()])
            pieces.append('var(%s)' % t)
            pos = cm.end()
            done += 1
        if pieces:
            out.append(raw[last:vs])
            out.append(''.join(pieces) + seg[pos:])
            last = ve
    out.append(raw[last:])
    new = ''.join(out)
    assert eol_of(new) == (crlf, lf), '%s 行尾变了' % path
    return (new, done), None


# 名字像颜色、但值不是颜色的属性。必须排除，否则它们会被算成「带颜色的声明」。
# ⚠ Phase 6c-3 踩到的：`color-scheme` 以 color 开头，HEAD 侧值是关键字 `dark`
#   （不匹配 COLOR_RE、不计入），改成 `var(--t-color-scheme)` 后匹配了
#   COLOR_OR_VAR 的 var 分支、被计入 —— --verify 于是报「scope.css 带颜色的
#   声明数变了 3 -> 4」这种**假违规**，而一条永久的假违规会掩盖真的。
#   role_of() 对它返回 'other' 已经是对的，问题出在声明枚举阶段无条件扫全部属性。
NON_COLOR_PROPS = frozenset(['color-scheme', 'color-interpolation',
                             'color-interpolation-filters', 'color-rendering'])


def color_sequence(text, defs):
    """[(属性名, (最终颜色序列))]，用于证明计算值不变。"""
    text = COMMENT_RE.sub('', text)
    seq = []
    for dm in DECL_RE.finditer(text):
        if dm.group(2).lower() in NON_COLOR_PROPS:
            continue
        colors = []
        for cm in COLOR_OR_VAR.finditer(dm.group(3)):
            colors.extend(resolve_multi(defs, cm))
        if colors:
            seq.append((dm.group(2).lower(), tuple(colors)))
    return seq


def cmd_report():
    """列出仍存在的、与现有 token 逐值相同的字面量。"""
    defs = token_defs()
    from collections import Counter, defaultdict
    tok = defaultdict(list)
    for k, v in defs.items():
        if k.startswith('--t-c-') or not k.startswith(('--t-color', '--t-glass')):
            continue
        r = resolve(defs, v)
        if r:
            tok[r].append(k)
    hits = defaultdict(Counter)
    for f in sorted(os.listdir(FEATURE_DIR)):
        if not f.endswith('.css'):
            continue
        s = COMMENT_RE.sub('', open(os.path.join(FEATURE_DIR, f), encoding='utf-8').read())
        for dm in DECL_RE.finditer(s):
            for cm in COLOR_RE.finditer(dm.group(3)):
                k = canon(cm.group(0))
                if k and k in tok:
                    hits[k][dm.group(2).lower()] += 1
    n = sum(sum(c.values()) for c in hits.values())
    print('仍可等值替换：%d 个取值 / %d 处' % (len(hits), n))
    for k in sorted(hits, key=lambda x: -sum(hits[x].values())):
        hx = '#%02x%02x%02x' % k[:3] + ('' if k[3] == 1.0 else ' /%.2f' % k[3])
        print('  %-16s %3d 处  %-52s  %s' % (
            hx, sum(hits[k].values()), ' '.join(sorted(tok[k])),
            ' '.join('%s×%d' % x for x in hits[k].most_common(3))))



# ══════════════════════════════════════════════════════════════════════
# Phase 6b：把「同一角色里彼此接近的颜色」吸附到刻度上
#
# 与上面的等值替换不同，这一步**会改色**。做法是给每个角色定一条刻度，
# 把字面量吸附到最近的一档，并算出感知色差 ΔE(CIE76)：
#   ΔE<1 肉眼不可辨 / 1-2 极难辨 / 2-4 细看可辨 / 4-8 明显 / >8 显著
# 只有 ΔE <= SNAP_MAX_DE 才替换，超出的一律报出、人工处理。
# ══════════════════════════════════════════════════════════════════════
SNAP_MAX_DE = 8.0

# 中性灰文字刻度（10 档；--soft/-dim/-disabled 是 Phase 6b 补的）
TEXT_NEUTRAL_SCALE = [
    ('--t-color-text-strong', (255, 255, 255)),
    ('--t-color-text', (238, 238, 238)),
    ('--t-color-text-soft', (221, 221, 221)),
    ('--t-color-text-label', (204, 204, 204)),
    ('--t-color-text-secondary', (170, 170, 170)),
    ('--t-color-text-muted', (136, 136, 136)),
    ('--t-color-text-dim', (119, 119, 119)),
    ('--t-color-text-faint', (102, 102, 102)),
    ('--t-color-text-disabled', (85, 85, 85)),
    # 近黑 = 浅底 / 亮色徽章上的文字，是独立一档
    ('--t-color-text-on-accent', (18, 18, 18)),
]


def _lin(c):
    c /= 255.0
    return c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4


def _lab(rgb):
    r, g, b = (_lin(x) for x in rgb[:3])
    x, y, z = (r * .4124 + g * .3576 + b * .1805, r * .2126 + g * .7152 + b * .0722,
               r * .0193 + g * .1192 + b * .9505)

    def f(t):
        return t ** (1 / 3) if t > .008856 else 7.787 * t + 16 / 116
    fx, fy, fz = f(x / .95047), f(y), f(z / 1.08883)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def delta_e(a, b):
    import math
    return math.sqrt(sum((p - q) ** 2 for p, q in zip(_lab(a), _lab(b))))


def is_neutral(rgb, tol=18):
    return max(rgb[:3]) - min(rgb[:3]) <= tol


def snap_text(path, apply_it):
    """把 color: 上的不透明中性灰吸附到 TEXT_NEUTRAL_SCALE。返回 (变更列表, 超阈值列表)"""
    return _snap(path, apply_it, TEXT_NEUTRAL_SCALE, lambda p: p.lower() == 'color',
                 lambda k: is_neutral(k))


# ── 冷调文字刻度（5 档）─────────────────────────────────────────────────
# ⚠ 为什么要单独一条：6b-1 的中性灰刻度只收 R≈G≈B 的灰（容差 18），冷调文字
# （#d8e8f6 冷暖差 +30、#a9bfd3 +42）全部被排除在外，于是它们在「全局最近邻」里
# 找不到家 —— 一度被误判成「无合并结构」。实测拿**对的词汇表**（--t-glass-text* 这族）
# 去比，story-outline 的 32 个冷调文字取值里有 30 个落在 ΔE<=8 内。
# 教训：**「没有合并结构」这个结论，只在候选词汇表正确时才成立。**
#
# --soft 与 --tertiary 是本批新增，填两处实测出的空档：
#   (205,220,235) 一带 5 处，到 text(226,232,240) 差 ΔE 10、到 secondary 差 13
#   (150,167,182) 一带 12 处，到 secondary 差 ΔE 7、到 muted 差 9
TEXT_COOL_SCALE = [
    ('--t-glass-text-bright', (215, 231, 245)),     # 新增，最亮（人口重心，15 处）
    ('--t-glass-text', (226, 232, 240)),            # cool-12，已存在，正文
    ('--t-glass-text-soft', (203, 213, 224)),       # cool-11，新增，次要正文
    ('--t-glass-text-secondary', (169, 191, 209)),  # cool-10，已存在，说明文字
    ('--t-glass-text-tertiary', (160, 174, 192)),   # cool-9，新增，更弱
    ('--t-glass-text-faint', (142, 162, 180)),      # 新增，填 cool-8/9 之间的空档
    ('--t-glass-text-muted', (120, 150, 170)),      # cool-8，已存在，最弱
]
# 档数是实测挑的：5 档时有 50 处落在「明显」(ΔE4-8)；补 (215,231,245) 降到 30；
# 再补 (142,162,180) 降到 12；第 8 档只再少 1 处，不值得。
# 冷调判定：蓝通道明显高于红通道，且亮度在文字区间内。
# 阈值 12 的下界要高于中性刻度的容差（18 是按 max-min 算的，这里按 b-r 算），
# 两条刻度的收集集合刻意不重叠 —— 重叠会让同一处被两条刻度抢。
COOL_TEXT_MIN_BR = 12


def is_cool_text(k):
    r, g, b = k[:3]
    # ⚠ 必须有饱和度上限：只用 b-r>=12 会把青绿 #81ecec(b-r=107) 与浅红 #ff9d9d
    # 一类**强调色**也收进来，它们到冷灰刻度最远差 ΔE 72，纯属误收。
    # 冷灰文字的 max-min 实测都在 45 以内（#a9bfd3 是 40）。
    return (b - r >= COOL_TEXT_MIN_BR and max(k[:3]) - min(k[:3]) <= 55
            and 90 <= max(k[:3]) <= 250)


def snap_text_cool(path, apply_it):
    """把 color: 上的**冷调**不透明文字色吸附到 TEXT_COOL_SCALE。"""
    return _snap(path, apply_it, TEXT_COOL_SCALE, lambda p: p.lower() == 'color',
                 is_cool_text)


# ── 冷玻璃暗底：候选是成对的 (rgb, alpha) ──────────────────────────────
# ⚠ 与前几批的关键差异：这一段是**二维**的（冷色阶 × alpha）。前面几批要么只吸
# alpha（色族固定）、要么只吸颜色（不透明），这里两者都要动，所以候选必须写成
# 成对的值，判据用合成 ΔE 一次性判两个维度。
#
# ⚠ 只有 --t-glass-panel 是本批新增：实测 6 处字面量卡在 .70(row-head) 与
# .85(card) 之间的 .72~.75，到两边最近档都差 ΔE 8~9。补这一档后降到 ΔE<=3。
GLASS_DARK_SCALE = [
    ('--t-glass-row', (22, 27, 36, 0.60)),            # 已存在
    ('--t-glass-row-head', (28, 34, 44, 0.70)),       # 已存在
    ('--t-glass-row-hover', (34, 42, 54, 0.70)),      # 已存在
    ('--t-glass-panel', (12, 17, 22, 0.74)),          # 6b-9 新增，填 .70/.85 之间
    # ⚠ 这一档的值是**按人口重心挑的**，不是随手挂在 cool-1 上：新 token 的值可以
    # 自由选，就该让实测分布决定。挂 cool-1(10,15,22)/.75 时「明显」档 14 处；
    # 取重心 (12,17,22)/.74 后降到 9 处。
    ('--t-glass-card', (10, 15, 22, 0.85)),           # 已存在
    ('--t-glass-field', (7, 11, 18, 0.90)),           # 已存在
    ('--t-glass-nav', (18, 24, 33, 0.90)),            # 已存在
    ('--t-glass-window', (18, 22, 29, 0.95)),         # 已存在
    ('--t-color-dialog-surface', (30, 30, 35, 0.98)),  # 已存在
    ('--t-glass-body', (18, 22, 29, 1.00)),           # 已存在
    ('--t-color-window-header', (36, 37, 48, 1.00)),  # 已存在
]


def is_cool_dark(k):
    r, g, b = k[:3]
    # ⚠ 必须要求**蓝通道最高**（b >= g）。只判 b - r >= 4 会把绿调暗底
    # rgba(14,22,18,*)（rewrite.css 的命中/改后底色，g=22 > b=18）也收进来，
    # 它到冷调候选最近差 ΔE 8.8~9.8，是误收 —— 绿调该归它自己的族。
    return max(k[:3]) <= 60 and b - r >= 4 and b >= g and k[3] >= 0.005


def snap_glass_dark(path, apply_it):
    """把冷调暗底吸附到 GLASS_DARK_SCALE（同时吸颜色与 alpha）。"""
    return _snap(path, apply_it, GLASS_DARK_SCALE,
                 lambda p: role_of(p) == 'surface', is_cool_dark, paired=True)


# ── 中性暗色：描边与底色必须分开，用各自的 token 族 ─────────────────────
# ⚠ 这一段暴露了一个此前没抓到的错配：31 处**不透明中性描边**（34~85 灰）
# 若拿「暗色表面」候选去比，会被匹配到 surface-code / surface-raised / panel-header
# 上 —— 那是表面 token。描边该比 --t-color-border* 族。
# 教训与 6b-2/6b-6 同源：**角色不同就必须换候选族，否则会得到"能过阈值但语义错"的映射。**
BORDER_NEUTRAL_SCALE = [
    ('--t-color-border-dim', (34, 34, 34)),      # 6b-10 新增，填 51 以下的空档
    ('--t-color-border', (51, 51, 51)),          # 已存在
    ('--t-color-border-control', (58, 58, 58)),  # 已存在
    ('--t-color-border-strong', (68, 68, 68)),   # 已存在
    ('--t-color-border-bright', (85, 85, 85)),   # 6b-10 新增，10 处 #555 描边
]

# 中性暗底（含半透明），候选成对。跨度 <= 6 才算中性 —— 用 8 会把绿调的
# rgba(14,22,18,*)（跨度 8）收进来，那是 rewrite 的命中底色，属绿调族。
SURFACE_DARK_SCALE = [
    ('--t-color-surface-recess', (0, 0, 0, 0.20)),
    ('--t-color-surface-recess-strong', (0, 0, 0, 0.30)),
    ('--t-color-scrim', (0, 0, 0, 0.60)),
    ('--t-color-dialog-scrim-outline', (0, 0, 0, 0.65)),
    ('--t-color-dialog-scrim', (0, 0, 0, 0.70)),
    ('--t-color-dialog-scrim-strong', (0, 0, 0, 0.80)),
    ('--t-color-dialog-scrim-strongest', (0, 0, 0, 0.85)),
    ('--t-color-surface-well', (17, 17, 17, 1.0)),
    ('--t-color-bg', (18, 18, 18, 1.0)),
    ('--t-color-surface-inset', (24, 24, 24, 1.0)),
    ('--t-color-surface-sunken', (26, 26, 26, 1.0)),
    ('--t-color-surface', (30, 30, 30, 1.0)),
    ('--t-color-surface-elevated', (34, 34, 34, 1.0)),
    ('--t-color-surface-raised', (42, 42, 42, 1.0)),
]


def is_neutral_dark_border(k):
    return (k[3] >= 0.99 and max(k[:3]) <= 90
            and max(k[:3]) - min(k[:3]) <= 6)


def is_neutral_dark_surface(k):
    return (k[3] >= 0.005 and max(k[:3]) <= 60
            and max(k[:3]) - min(k[:3]) <= 6)


# ── 青绿族（故事大纲窗主色）：一个色相 × 8 档 alpha ────────────────────
# ⚠ 用 paired 模式而不是 snap_alpha：本族的 1.00 档也要参与（snap_alpha 只收
# alpha < 0.99 的半透明），且要覆盖 text 角色（snap_alpha 只做 surface/border）。
TEAL_ANCHOR = (129, 236, 236)
TEAL_SCALE = [
    ('--t-color-teal-veil', TEAL_ANCHOR + (0.10,)),
    ('--t-color-teal-soft-strong', TEAL_ANCHOR + (0.25,)),
    ('--t-color-teal-border-subtle', TEAL_ANCHOR + (0.32,)),
    ('--t-color-teal-border', TEAL_ANCHOR + (0.50,)),
    ('--t-color-teal-border-hover', TEAL_ANCHOR + (0.60,)),
    ('--t-color-teal-strong', TEAL_ANCHOR + (0.75,)),
    ('--t-color-teal', TEAL_ANCHOR + (1.00,)),
]


def is_teal(k):
    # 严格只收 #81ecec 本身：近似变体 #72e4d1 / #85eedc / #a9e9da 偏绿，
    # 合进来要差 ΔE 12.9，是另一族（见 theme-dark.css 的说明）。
    return k[3] >= 0.005 and delta_e(k[:3] + (1.0,), TEAL_ANCHOR + (1.0,)) <= 3.0


def snap_teal(path, apply_it):
    return _snap(path, apply_it, TEAL_SCALE,
                 lambda p: role_of(p) in ('surface', 'border', 'text'),
                 is_teal, paired=True)


def snap_neutral_dark(path, apply_it):
    """描边与底色各用自己的族，结果合并。"""
    c1, o1, e1 = _snap(path, apply_it, BORDER_NEUTRAL_SCALE,
                       lambda p: role_of(p) == 'border', is_neutral_dark_border)
    if e1:
        return None, None, e1
    c2, o2, e2 = _snap(path, apply_it, SURFACE_DARK_SCALE,
                       lambda p: role_of(p) == 'surface', is_neutral_dark_surface,
                       paired=True)
    if e2:
        return None, None, e2
    return c1 + c2, o1 + o2, None


# ── 表面色刻度（不透明中性灰，9 档，由深到浅）──────────────────────────
# ⚠ 与文字刻度有两点本质不同，见交接文档 §6b：
#   1) 表面是**嵌套**的：父子元素差一档就是视觉层级本身。两个不同取值吸到同一档，
#      会让边界或 hover 反馈直接消失。故 --snap-surface 之后必须跑 --check-state。
#   2) 带色偏的暗底（favs 的暖金 #201912、glass 的冷蓝 #1a2027）是刻意设计，
#      吸到中性灰会抹掉设计意图。故本刻度**只接受纯灰**（R=G=B，容差 4），
#      色偏的暗底留给「暖色族 / 冷玻璃族」两段单独处理。
# 下面刻意**不含**角色名 token：panel-header(36) / surface-code(51) /
# set-nav-surface(24) / set-tab-hover-surface(34) / field-focus(34) /
# dialog-surface(30,30,35) 各有明确角色，浅色主题下会与泛用底色分叉，
# 不能被泛用底色抢用（否则将来调 <code> 芯片会连带改掉一堆无关面板）。
SURFACE_NEUTRAL_SCALE = [
    ('--t-color-surface-well', (17, 17, 17)),
    ('--t-color-bg', (18, 18, 18)),
    ('--t-color-surface-inset', (24, 24, 24)),
    ('--t-color-surface-sunken', (26, 26, 26)),
    ('--t-color-surface', (30, 30, 30)),
    ('--t-color-surface-elevated', (34, 34, 34)),
    ('--t-color-surface-raised', (42, 42, 42)),
    ('--t-color-surface-high', (51, 51, 51)),
    ('--t-color-surface-highest', (85, 85, 85)),
]

PURE_GRAY_TOL = 4


def snap_surface(path, apply_it):
    """把 background* 上的不透明纯灰吸附到 SURFACE_NEUTRAL_SCALE。"""
    return _snap(path, apply_it, SURFACE_NEUTRAL_SCALE,
                 lambda p: role_of(p) == 'surface', lambda k: is_neutral(k, PURE_GRAY_TOL))


def _snap(path, apply_it, scale, want_prop, want_color, paired=False):
    """paired=False：scale 是 [(token, (r,g,b))]，只吸颜色、alpha 必须为 1。
       paired=True ：scale 是 [(token, (r,g,b,a))]，同时吸颜色与 alpha，
                     判据用合成 ΔE（半透明色的观感取决于盖在什么底上）。"""
    raw = open(path, encoding='utf-8', newline='').read()
    crlf, lf = eol_of(raw)
    if crlf and lf:
        return None, None, '行尾混用，跳过'
    spans = [(m.start(), m.end()) for m in COMMENT_RE.finditer(raw)]
    # 调色板预览规则的整块区间：选择器里带字面量颜色（[data-color="#xxx"]）的，
    # 其 background 就是要把那个 hex 画出来给用户看，token 化会让浅色主题下预览说谎。
    # 审计 A24 是同一条规则的常驻护栏；这里是源头拦截。
    skip = [(m.start(), m.end()) for m in PALETTE_RULE.finditer(raw)]
    # var() 的回退值区间：`var(--t-bg-color, #2b2b2b)` 里的 #2b2b2b 不是「这个元素的
    # 底色」，而是「运行时变量没设时的默认」—— 那是 B5，CLAUDE.md 把它列为刻意推迟、
    # 需独立一步的项（四个变量各有不同 fallback，补单一默认值会改色）。
    # 更要紧的是 --verify / color_sequence 只解析 var() 的**外层** token，
    # 改动回退值它一律看不见，等于没有自证。故整段跳过。
    skip += [(m.start(1), m.end(1)) for m in VAR_FALLBACK.finditer(raw)]

    def in_comment(i):
        return any(a <= i < b for a, b in spans)

    def in_palette(i):
        return any(a <= i < b for a, b in skip)

    out, last, changes, over = [], 0, [], []
    for dm in DECL_RE.finditer(raw):
        if not want_prop(dm.group(2)) or in_comment(dm.start(2)):
            continue
        vs, ve = dm.start(3), dm.end(3)
        seg, pieces, pos = raw[vs:ve], [], 0
        for cm in COLOR_RE.finditer(seg):
            k = canon(cm.group(0))
            if not k or not want_color(k) or in_palette(vs + cm.start()):
                continue
            if not paired and k[3] < 0.99:
                continue
            best, bd = None, 1e9
            for name, ref in scale:
                d = (alpha_delta_e(k, ref) if paired else delta_e(k, ref + (1.0,)))
                if d < bd:
                    best, bd = name, d
            if bd > SNAP_MAX_DE:
                over.append((path, cm.group(0), best, bd))
                continue
            pieces.append(seg[pos:cm.start()])
            pieces.append('var(%s)' % best)
            pos = cm.end()
            changes.append((path, cm.group(0), best, bd))
        if pieces:
            out.append(raw[last:vs])
            out.append(''.join(pieces) + seg[pos:])
            last = ve
    out.append(raw[last:])
    new = ''.join(out)
    assert eol_of(new) == (crlf, lf), '%s 行尾变了' % path
    if apply_it and changes:
        open(path, 'w', encoding='utf-8', newline='').write(new)
    return changes, over, None


# ══════════════════════════════════════════════════════════════════════
# Phase 6b-3 起：色族 alpha 阶
#
# ⚠ 这一段**不能用 Lab 最近邻**（前两段的做法）。实测品牌金 #bfa15f 一个颜色就
# 出现在 24 个不同 alpha 上；在 Lab 空间做最近邻时，同 alpha 带内只有别的色族
# 可选，会给出 ΔE 40-100 的荒谬结果（红→绿、金→蓝）。
#
# 正确做法两步：① 先按色相归族（与原语族色比 ΔE）② 再把 alpha 吸到该族的标准阶梯。
#
# ⚠ 色差也不能直接比 rgba：半透明色的观感取决于它合成到什么背景上。
# Δalpha=0.05 在浅背景上几乎看不见、在深背景上是可见的。故 `alpha_delta_e()`
# 把新旧两色**分别合成到插件最深与最浅的两种底色上**（#111 / #333），取较大的
# 那个 ΔE 作为判据 —— 这样无论元素实际坐在哪种底上，可见变化都被这个上界罩住。
# ══════════════════════════════════════════════════════════════════════
# 合成用的代表背景。
# ⚠ 必须包含一个**亮**背景。实测 `rgba(0,0,0,.04)` → `rgba(0,0,0,.20)`：
#   在 #111 上差 ΔE 0.7、在 #333 上 3.7、在 **#ccc 上 12.2**。
#   黑色蒙层在深底上几乎看不出 alpha 差异，但收藏窗的 `.t-fav-card-overlay`
#   之类是**盖在用户图片上**的，那里 alpha 差异一目了然。
#   只用深背景会让判据在这类位置严重低估，把明显的变化放过去。
# 取三种背景的**最大** ΔE 作上界，比逐个排除选择器更可靠。
# ⚠ 加亮背景只会让门槛更严，不会放宽 —— 且对白色叠加是无操作（白叠加的色差在
#   深背景上最大，亮背景上反而趋零），所以 6b-6 及之前几批的判据不受影响。
COMPOSITE_BACKDROPS = ((17, 17, 17), (51, 51, 51), (204, 204, 204))
# alpha 低于此值视为「透明」：那是渐变淡出止点，RGB 无意义，吸附会让淡出失效。
# ⚠ 只挡真正的 0。早期设成 0.03，把 rgba(255,255,255,.015) 这类**极淡的白色洗色**
# 也挡掉了 9 处 —— 那是真实的设计选择（合成后与 .03 只差 ΔE 1.4），不是淡出止点。
MIN_MEANINGFUL_ALPHA = 0.005


def over(fg, backdrop):
    """把 (r,g,b,a) 合成到不透明背景上，返回不透明 rgb。"""
    a = fg[3]
    return tuple(int(round(a * fg[i] + (1 - a) * backdrop[i])) for i in range(3))


def alpha_delta_e(c1, c2):
    """半透明色的感知差：分别合成到两种代表背景，取较大的 ΔE（可见变化的上界）。"""
    return max(delta_e(over(c1, b), over(c2, b)) for b in COMPOSITE_BACKDROPS)


# 色族锚点与各族的 alpha 阶梯。
# ⚠ 阶梯里**已存在的 token 一律保留其原有 alpha，不在吸附批次里改它的值**——
# 改一个已有 token 的值会连带改掉它现有消费者的外观，那属于另一种变化，
# 混在同一批里就无法归因（本项目没有视觉基线）。所以 brand 的 .55 保留为一档，
# 另在 .45 加一档，而不是把 .55 挪成 .45。
ALPHA_FAMILIES = [
    {
        'name': 'brand 品牌金',
        'anchor': (191, 161, 95),
        'max_de': 1.0,          # 只收 #bfa15f 本身；近金变体单独评估，见交接文档 §6b-3
        'ladder': [
            (0.08, '--t-color-brand-veil'),
            (0.14, '--t-color-brand-soft'),            # 已存在
            (0.20, '--t-color-brand-soft-strong'),
            (0.30, '--t-color-brand-border-subtle'),
            (0.45, '--t-color-brand-border-soft'),
            (0.55, '--t-color-brand-border'),          # 已存在
            (0.75, '--t-color-brand-strong'),
        ],
    },
    {
        # ⚠ 阶梯里刻意**不含角色名 token**，与 6b-2 的表面刻度同一条理由：
        # --t-color-field-dialog-ring(.10) / -field-glass-focus-ring(.16) /
        # --t-glass-tab-active-surface(.16) / --t-color-focus-ring(.40) /
        # -field-glass-focus-border(.55) / --t-glass-tab-active-border(.86)
        # 各有明确角色，浅色主题下会与泛用蓝分叉，不能被泛用底色/描边抢用。
        'name': 'accent 交互蓝',
        'anchor': (144, 205, 244),
        'max_de': 1.0,
        'ladder': [
            (0.10, '--t-color-accent-veil'),           # 已存在
            (0.12, '--t-color-accent-soft'),           # 已存在
            (0.22, '--t-color-accent-soft-strong'),    # 已存在
            (0.30, '--t-color-accent-border-subtle'),  # 已存在
            (0.35, '--t-color-accent-border'),         # 已存在
            (0.45, '--t-color-accent-border-strong'),  # 6b-4 新增，填 .35→.60 的空档
            (0.60, '--t-color-accent-border-hover'),   # 已存在
            (0.70, '--t-color-accent-active'),         # 已存在
            (0.85, '--t-color-accent-hover'),          # 已存在
        ],
    },
    {
        # 冷灰蓝：#7896aa 就是 --t-color-border-cool 的色，且全部 17 处都用在
        # border/border-top 上，token 名正好对，一档就够（人口全在 .25-.35）。
        # 零新增 token。散落的近似冷灰（#b0bec5/#bdc7d2/#a8c9e0… 9 个值各 1 处）
        # 刻意不并：那是个别选择不是漂移，合成 ΔE 最大 8.6，需逐个判断，留长尾批。
        'name': 'cool 冷灰蓝',
        'anchor': (120, 150, 170),
        'max_de': 1.0,
        'ladder': [
            (0.30, '--t-color-border-cool'),           # 已存在
        ],
    },
    # ── 白叠加：必须按角色分族 ──────────────────────────────────────────
    # 白色半透明在本项目里是两套独立词汇：surface-*（叠在底色上做 hover/active）
    # 与 border-*（描边）。同一个 alpha 在两个角色下该用不同 token，
    # 所以这里拆成两族、各自一条阶梯。两族**都零新增 token** —— 现有档位够用。
    {
        'name': '白叠加（底色）',
        'anchor': (255, 255, 255),
        'max_de': 1.0,
        'roles': ('surface',),
        'ladder': [
            (0.03, '--t-color-surface-veil'),          # 已存在
            (0.06, '--t-color-surface-hover-subtle'),  # 已存在
            (0.08, '--t-color-surface-hover'),         # 已存在
            (0.15, '--t-color-surface-active'),        # 已存在
        ],
    },
    {
        'name': '白叠加（描边）',
        'anchor': (255, 255, 255),
        'max_de': 1.0,
        'roles': ('border',),
        'ladder': [
            (0.08, '--t-color-border-faint'),          # 已存在
            (0.10, '--t-color-border-subtle'),         # 已存在
            (0.15, '--t-color-border-hover-subtle'),   # 已存在
            (0.18, '--t-color-border-glass'),          # 已存在
        ],
    },
    # ── 黑叠加（底色）：零新增 token ─────────────────────────────────────
    # ⚠ 这一族最危险，因为「黑蒙层盖在图片上」与「盖在插件深底上」的观感差别极大。
    # 判据靠 COMPOSITE_BACKDROPS 里那个亮背景挡住 —— 见该常量的注释。
    # 阶梯里刻意跳过 .65（`--t-color-dialog-scrim-outline`，细纲专用）与 .80
    # （与 .85 只差 Δ.05、且都是 dialog 专名），避免泛用蒙层抢角色名 token。
    {
        'name': '黑叠加（底色）',
        'anchor': (0, 0, 0),
        'max_de': 1.0,
        'roles': ('surface',),
        'ladder': [
            (0.20, '--t-color-surface-recess'),          # 已存在
            (0.30, '--t-color-surface-recess-strong'),   # 已存在
            (0.60, '--t-color-scrim'),                   # 已存在
            (0.70, '--t-color-dialog-scrim'),            # 已存在
            (0.85, '--t-color-dialog-scrim-strongest'),  # 已存在
        ],
    },
    {
        # 弹窗/窗口表面：#1e1e23 正是 --t-color-dialog-surface 的色（30 30 35）。
        'name': '弹窗表面',
        'anchor': (30, 30, 35),
        'max_de': 1.0,
        'roles': ('surface',),
        'ladder': [
            (0.98, '--t-color-dialog-surface'),          # 已存在
        ],
    },
]


def snap_alpha(path, apply_it, families=None):
    """把色族半透明色的 alpha 吸附到该族阶梯。shadow 角色刻意不处理（见 §6a）。

    族可带 'roles' 限定只在某些角色上生效 —— 白色半透明在本项目里是
    surface-* 与 border-* 两套独立词汇，同一 alpha 在两个角色下该用不同 token。
    """
    families = families or ALPHA_FAMILIES
    raw = open(path, encoding='utf-8', newline='').read()
    crlf, lf = eol_of(raw)
    if crlf and lf:
        return None, None, '行尾混用，跳过'
    spans = [(m.start(), m.end()) for m in COMMENT_RE.finditer(raw)]
    skip = [(m.start(), m.end()) for m in PALETTE_RULE.finditer(raw)]
    skip += [(m.start(1), m.end(1)) for m in VAR_FALLBACK.finditer(raw)]

    out, last, changes, over_list = [], 0, [], []
    for dm in DECL_RE.finditer(raw):
        # 只做 surface / border：shadow 的彩色光晕应转整条 --t-shadow-*（另一步）
        role = role_of(dm.group(2))
        if role not in ('surface', 'border'):
            continue
        if any(a <= dm.start(2) < b for a, b in spans):
            continue
        vs, ve = dm.start(3), dm.end(3)
        seg, pieces, pos = raw[vs:ve], [], 0
        for cm in COLOR_RE.finditer(seg):
            k = canon(cm.group(0))
            if not k or not (MIN_MEANINGFUL_ALPHA <= k[3] < 0.99):
                continue
            if any(a <= vs + cm.start() < b for a, b in skip):
                continue
            fam = None
            for f in families:
                if 'roles' in f and role not in f['roles']:
                    continue
                if delta_e(k[:3] + (1.0,), f['anchor'] + (1.0,)) <= f['max_de']:
                    fam = f
                    break
            if fam is None:
                continue
            tok, ta = min(((t, a) for a, t in fam['ladder']),
                          key=lambda x: abs(x[1] - k[3]))
            d = alpha_delta_e(k, k[:3] + (ta,))
            rec = (path, cm.group(0), tok, d, k[3], ta)
            if d > SNAP_MAX_DE:
                over_list.append(rec)
                continue
            pieces.append(seg[pos:cm.start()])
            pieces.append('var(%s)' % tok)
            pos = cm.end()
            changes.append(rec)
        if pieces:
            out.append(raw[last:vs])
            out.append(''.join(pieces) + seg[pos:])
            last = ve
    out.append(raw[last:])
    new = ''.join(out)
    assert eol_of(new) == (crlf, lf), '%s 行尾变了' % path
    if apply_it and changes:
        open(path, 'w', encoding='utf-8', newline='').write(new)
    return changes, over_list, None


# ══════════════════════════════════════════════════════════════════════
# --check-state：状态对塌陷检测
#
# 吸附刻度的唯一真实危险是**把 base 与它的 :hover / .active 吸到同一档**——
# 交互反馈会静默消失，而审计与「计算值不变」自证都发现不了（值确实变了，
# 但变得"合理"）。这里把每个选择器的最终 background 序列算出来，找出
# 「S 与 S+状态后缀」这类对，报告二者颜色序列相同的情况。
#
# 与 HEAD 比对，只报**新增**的塌陷 —— 项目里本来就有同色的状态对（例如
# 只靠 border 变化做反馈），那些不是本次引入的。
# ══════════════════════════════════════════════════════════════════════
STATE_TAIL = re.compile(
    r'(?::hover|:focus(?:-visible|-within)?|:active|:disabled|:checked'
    r'|:not\([^()]*\)|\.active|\.inactive|\.selected|\.is-[\w-]+|\.expanded|\.open'
    r'|\[aria-[^\]]*\])+$')


def bg_map(text, defs, want_role='surface'):
    """{单个选择器: [(at-rule 上下文, 该角色的最终颜色序列), ...]}，按出现顺序。

    ⚠ 上下文必须一起返回：@media 块里的 base 与全局的 :hover 是**同时生效**的
    （media 规则叠加在全局之上），所以配对是对的 —— 但塌陷只在那个视口下发生。
    不带上下文的报告会让人误判成全局回归（踩过一次）。
    """
    text = COMMENT_RE.sub(lambda m: ' ' * len(m.group(0)), text)
    out = {}
    # 先记录每个 at-rule 块的字符区间，供反查上下文
    blocks = []
    for am in re.finditer(r'@[\w-]+[^{}]*\{', text):
        i, depth = am.end(), 1
        while i < len(text) and depth:
            if text[i] == '{':
                depth += 1
            elif text[i] == '}':
                depth -= 1
            i += 1
        blocks.append((am.start(), i, re.sub(r'\s+', ' ', am.group(0)[:-1].strip())))

    def ctx_at(i):
        return ' / '.join(c for a, b, c in blocks if a <= i < b)

    for rm in re.finditer(r'([^{}]+)\{([^{}]*)\}', text):
        sels, body = rm.group(1), rm.group(2)
        if '@' in sels:
            continue
        colors = None
        for dm in DECL_RE.finditer(body):
            if role_of(dm.group(2)) != want_role:
                continue
            seq = [resolve_match(defs, cm) for cm in COLOR_OR_VAR.finditer(dm.group(3))]
            if seq:
                colors = tuple(seq)
        if colors is None:
            continue
        ctx = ctx_at(rm.start(1))
        for s in sels.split(','):
            s = re.sub(r'\s+', ' ', s.strip())
            if s:
                out.setdefault(s, []).append((ctx, colors))
    return out


def last_color(entries):
    return entries[-1][1]


def state_pairs(m):
    """[(base选择器, 状态选择器)]，只保留 base 也有 background 的对。"""
    pairs = []
    for s in m:
        b = STATE_TAIL.sub('', s).strip()
        if b and b != s and b in m:
            pairs.append((b, s))
    return pairs


def seq_delta_e(a, b):
    """两条颜色序列的感知差（逐位取最大）。无法比较时返回 -1。

    用 alpha_delta_e 而非 delta_e：它对不透明色会退化成 delta_e
    （不透明色合成到任何底上都是它自己），所以是严格的推广，两种情况都能用。
    """
    if a is None or b is None or len(a) != len(b):
        return -1.0
    worst = 0.0
    for x, y in zip(a, b):
        if x is None or y is None:
            return -1.0
        worst = max(worst, alpha_delta_e(x, y))
    return worst


# ══════════════════════════════════════════════════════════════════════
# Phase 6b-12 起：色相三元组 token 化（--tokenize-hue）
#
# 为什么换掉前面几批的「吸附」做法：强调色的人口**不是漂移**。实测 04-features
# 里 106 个不同的强调色三元组，把它们按 ΔE≤8 合并只需 56 个 token，
# 但要付 **75 处肉眼明显（ΔE 4–8）的变色** —— 那是重新配色，不是重构。
# 分档实测：
#     阈值 ΔE≤0 → 99 个 token，0 处改色
#          ΔE≤4 → 85 个 token，23 处改色（全在 ΔE 2–4，需凑近才看得出）
#          ΔE≤8 → 56 个 token，101 处改色，其中 75 处明显
# 从 ≤4 走到 ≤8 只省 29 个 token 却付 75 处明显变色，明显不划算。
# 故强调色**按原值 token 化，不合并**（ΔE<2 的同角色重复才合并，那是不可感知的）。
#
# 为什么 token 只存三元组、不给每个 alpha 档起名（与 teal/brand 那几族不同）：
# 实测有 197 个 (色相, alpha) 组合，两层模式要写约 300 条声明；而 **alpha 本来就不
# 随主题变**（浅色主题改的是色相，不是发光的不透明度），把 alpha 编进 token 名
# 对「能换主题」零贡献，只是把 token 层撑成 3 倍。#e7ca8f 一个色相就有 10 个 alpha。
#
# ⚠ 这是 feature 层第一次出现 `*-rgb` 三元组 token。它**只能**出现在 rgb()/rgba()
#   里面；直接写 `color: var(--t-accent-azure-rgb)` 会产出非法声明并**静默失效**
#   （浏览器丢弃该声明，元素继承父级颜色，看起来"差不多对"）。审计 A25 挡这条。
#
# ⚠ 三元组的值声明在 theme-dark.css 而非 primitives.css：它们是深色主题专用的
#   取值（浅底上的蓝不能是 #74b9ff），而 primitives.css 自称「与主题无关」。
#   theme-light.css 覆盖同名 token 即可换主题。
#
# 键是 (r,g,b)，值是 token 名。alpha 一律保留原值。
HUE_TOKENS = {
    # ── 蓝 / 靛 / 紫（Phase 6b-12，54 处）──
    # 全库有一个统一写法：`linear-gradient(135deg, <本色>, <同色相的深版>)`，
    # 用于图标与按钮填充。故命名用 <色相> / <色相>-deep 表达这层配对关系，
    # 浅色主题照着把「配对关系」搬过去即可。
    (74, 158, 255): '--t-accent-azure-rgb',            # #4a9eff 15 处 6 文件：主交互蓝
    (116, 185, 255): '--t-accent-azure-light-rgb',     # #74b9ff 14 处：文字/描边用的浅版
    (102, 126, 234): '--t-accent-indigo-rgb',          # #667eea  7 处：记忆回溯窗身份色
    (162, 155, 254): '--t-accent-violet-rgb',          # #a29bfe  5 处 = --t-c-violet-rgb
    (144, 205, 244): '--t-accent-sky-rgb',             # #90cdf4  5 处 = --t-c-blue-rgb
    (106, 176, 255): '--t-accent-azure-pale-rgb',      # #6ab0ff  2 处：运行队列渐变亮端
    (90, 175, 255): '--t-accent-azure-hover-rgb',      # #5aafff  1 处：该渐变 hover 起点
    (122, 192, 255): '--t-accent-azure-hover-pale-rgb',  # #7ac0ff 1 处：该渐变 hover 亮端
    (45, 127, 211): '--t-accent-azure-deep-rgb',       # #2d7fd3  1 处：剧场图标渐变暗端
    (47, 95, 138): '--t-accent-azure-dim-rgb',         # #2f5f8a  1 处：调试窗激活态描边
    (66, 153, 225): '--t-accent-azure-mid-rgb',        # #4299e1  1 处：进度条渐变起点
    (108, 92, 231): '--t-accent-indigo-deep-rgb',      # #6c5ce7  1 处：设定提取图标渐变暗端

    # ── 红（Phase 6b-13，57 处）──
    # 26 个取值其实是三条语义线：危险操作(danger) / 错误提示(error) / 警告(warn)，
    # 外加几组「同一组件的 base+hover 配对」。命名按语义线走；跨多种角色用的
    # 取值改用「色相+明度」名（-soft / -pale），免得名字说谎。
    # ⚠ 只并了两对**同值手误**：#ff7676→#ff7675（ΔE 0.5）、#f08f8f→#ef8f8f（ΔE 0.4），
    #   都远低于可辨阈值 1.0。其余一律保留原值 —— 理由见本表上方的分档实测。
    # ⚠ #d95757 与 #e86868 是 .t-continuation-send.is-stop 的 base / :hover，
    #   差 ΔE 6.1，**不能并**（并了交互反馈就没了，--check-state 会报）。
    # ⚠ #ff6b6b 在 settings.css 里另有一条 .t-color-swatch[data-color="#ff6b6b"]，
    #   贡献 2 次文本出现（选择器 + background），由 PALETTE_RULE 整块跳过
    #   （审计 A24）。故文件里 grep 到 16 次，实改 14 处。
    (255, 107, 107): '--t-accent-danger-rgb',           # #ff6b6b 14 处 6 文件 = --t-c-red-rgb
    (231, 76, 60): '--t-accent-error-rgb',              # #e74c3c  8 处：错误横幅 / 错误头
    (255, 118, 117): '--t-accent-red-soft-rgb',         # #ff7675  5 处：跨警告/错误/删除三角色
    (245, 101, 101): '--t-accent-error-soft-rgb',       # #f56565  3 处：空索引态 / Event 标记
    (255, 138, 138): '--t-accent-danger-text-rgb',      # #ff8a8a  2 处：中止钮文字
    (238, 136, 136): '--t-accent-warn-red-rgb',         # #ee8888  2 处：改写设置的警告分类
    (255, 184, 184): '--t-accent-error-pale-rgb',       # #ffb8b8  2 处：更新卡片错误文字
    (220, 70, 70): '--t-accent-error-fill-rgb',         # #dc4646  2 处：更新卡片错误底
    (255, 100, 100): '--t-accent-error-border-rgb',     # #ff6464  2 处：更新卡片错误描边
    (255, 168, 176): '--t-accent-mature-rgb',           # #ffa8b0  2 处：工坊成人分级标签
    (239, 143, 143): '--t-accent-red-pale-rgb',         # #ef8f8f  2 处：危险菜单文字 + 改写错误状态
    (248, 113, 113): '--t-accent-danger-bulk-border-rgb',  # #f87171 1 处：批量栏危险描边
    (185, 28, 28): '--t-accent-danger-bulk-fill-rgb',   # #b91c1c  1 处：批量栏危险底
    (217, 87, 87): '--t-accent-danger-fill-rgb',        # #d95757  1 处：停止钮实底
    (232, 104, 104): '--t-accent-danger-fill-hover-rgb',  # #e86868 1 处：停止钮 hover 实底
    (221, 102, 102): '--t-accent-danger-icon-rgb',      # #dd6666  1 处：危险菜单项图标
    (220, 60, 60): '--t-accent-danger-menu-fill-rgb',   # #dc3c3c  1 处：危险菜单 hover 底
    (255, 180, 180): '--t-accent-danger-menu-hover-rgb',  # #ffb4b4 1 处：危险菜单 hover 文字
    (238, 90, 90): '--t-accent-danger-deep-rgb',        # #ee5a5a  1 处：中止图标渐变暗端
    (255, 71, 87): '--t-accent-danger-vivid-rgb',       # #ff4757  1 处：中止图标描边
    (252, 129, 129): '--t-accent-error-text-rgb',       # #fc8181  1 处：错误状态文字
    (224, 136, 136): '--t-accent-diff-before-rgb',      # #e08888  1 处：改写对比「原文」描边
    (255, 157, 157): '--t-accent-danger-plan-rgb',      # #ff9d9d  1 处：大纲删除钮
    (126, 56, 71): '--t-accent-mature-border-rgb',      # #7e3847  1 处：成人分级描边（深酒红）

    # ── 金 / 琥珀（Phase 6b-14，60 处）──
    # 21 个取值分两条线：
    #   亮琥珀（S、V 都高）= **状态色** —— 警告文字、调试身份色、分类标记
    #   暖金（低饱和）    = **品牌与羊皮纸质感** —— 收藏窗、续写说明文字、legacy 运行钮
    # 两条线在浅色主题下的走向不同（状态色要保持醒目，暖金要压成深棕），故分开命名。
    # ⚠ #e7ca8f 一个色相散在 **10 个 alpha** 上（.09 .3 .32 .42 .5 .7 .75 .86 .95 1.0），
    #   是全库 alpha 漂移最重的一处 —— 也正是「alpha 不进 token 名」这个决定省下最多
    #   声明的地方（否则光它一族就要 10 条）。
    # ⚠ #d4c08b(底) 与 #d4b06b/#e5d1a0(hover 渐变两端) 是 legacy 单次运行钮的
    #   base / :hover，不能并。#d4c08b 与 #d9c18a 差 ΔE 2.1 但分属 surface / text
    #   两种角色、两个文件，按角色分档的规矩也不并。
    (231, 202, 143): '--t-accent-fav-gold-rgb',         # #e7ca8f 15 处：收藏窗暖金主色
    (255, 159, 67): '--t-accent-orange-rgb',            # #ff9f43 10 处：调试身份色
    (212, 165, 116): '--t-accent-tan-rgb',              # #d4a574  6 处：剧本管理图标褐金
    (254, 202, 87): '--t-accent-warn-rgb',              # #feca57  5 处：警告文字
    (245, 158, 11): '--t-accent-amber-rgb',             # #f59e0b  5 处 = --t-c-amber-rgb
    (191, 161, 95): '--t-accent-brand-rgb',             # #bfa15f  3 处 = --t-c-gold-rgb
    (228, 196, 120): '--t-accent-fav-gold-focus-rgb',   # #e4c478  2 处：收藏窗输入框 focus
    (208, 181, 117): '--t-accent-gold-hover-rgb',       # #d0b575  2 处：续写钮 hover
    (201, 185, 143): '--t-accent-parchment-rgb',        # #c9b98f  1 处：续写分支选项
    (183, 169, 137): '--t-accent-parchment-dim-rgb',    # #b7a989  1 处：续写历史指令
    (154, 138, 99): '--t-accent-parchment-faint-rgb',   # #9a8a63  1 处：续写跨话提示
    (156, 143, 111): '--t-accent-fav-gold-dim-rgb',     # #9c8f6f  1 处：收藏窗菜单图标
    (211, 191, 143): '--t-accent-gold-text-rgb',        # #d3bf8f  1 处：剧本管理概览项
    (217, 193, 138): '--t-accent-gold-text-warm-rgb',   # #d9c18a  1 处：工坊回复强调
    (212, 192, 139): '--t-accent-gold-fill-rgb',        # #d4c08b  1 处：legacy 单次运行钮底
    (212, 176, 107): '--t-accent-gold-fill-hover-rgb',  # #d4b06b  1 处：其 hover 渐变暗端
    (229, 209, 160): '--t-accent-gold-fill-hover-pale-rgb',  # #e5d1a0 1 处：其 hover 渐变亮端
    (246, 173, 85): '--t-accent-amber-soft-rgb',        # #f6ad55  1 处：Character 分类标记
    (251, 191, 36): '--t-accent-amber-bright-rgb',      # #fbbf24  1 处：诊断钮 hover 文字
    (242, 194, 125): '--t-accent-warn-pale-rgb',        # #f2c27d  1 处：改写状态「警告」

    # ── 青绿 / 薄荷 / 绿（Phase 6b-15，77 处）──
    # 27 个取值是**五个互不相干的身份**，不是一族的漂移：
    #   ① 扩展更新（settings-drawer，#62d9bc 12 处 + 3 个配套）
    #   ② 故事大纲的两套按钮渐变（.t-outline-add-fab 系 / .t-hub-primary-action）
    #   ③ 通知与成功绿（mint / green 两个原语 + 各窗自己的成功色）
    #   ④ 改写命中（与红族的 --t-accent-diff-before-rgb 配对）
    #   ⑤ 悬浮球上的模型选择 / 计时器
    # ⚠ 两套大纲按钮渐变的色相不同（#30a6ad 偏青 / #3494ac 偏蓝，差 ΔE 13.3），
    #   不是同一个颜色写歪了 —— 是两个按钮层级刻意不同。
    # ⚠ #62d9bc(base) 与 #78e4c9(:hover) 差 ΔE 5.2，是真交互反馈，不能并。
    # ⚠ #55efc4 在 settings.css 有 1 处调色板预览球，由 PALETTE_RULE 跳过。
    (98, 217, 188): '--t-accent-update-rgb',            # #62d9bc 13 处：扩展更新身份色
    (120, 228, 201): '--t-accent-update-hover-rgb',     # #78e4c9  2 处：更新钮 hover
    (114, 239, 208): '--t-accent-update-text-rgb',      # #72efd0  2 处：更新状态/导出钮文字
    (169, 233, 218): '--t-accent-update-code-rgb',      # #a9e9da  1 处：更新日志里的 code
    (129, 236, 236): '--t-accent-teal-rgb',             # #81ecec  8 处 = --t-c-teal-rgb（全是光晕）
    (85, 239, 196): '--t-accent-mint-rgb',              # #55efc4  8 处 = --t-c-mint-rgb
    (74, 222, 128): '--t-accent-interactive-rgb',       # #4ade80  5 处：收藏窗「可交互」标记
    (122, 203, 159): '--t-accent-diff-after-rgb',       # #7acb9f  5 处：改写命中/「改后」（配对 -diff-before）
    (48, 166, 173): '--t-accent-outline-btn-rgb',       # #30a6ad  3 处：大纲主按钮渐变暗端
    (74, 206, 172): '--t-accent-outline-btn-pale-rgb',  # #4aceac  3 处：同上渐变亮端
    (114, 228, 209): '--t-accent-outline-btn-border-rgb',  # #72e4d1 3 处：同上描边
    (52, 148, 172): '--t-accent-hub-btn-rgb',           # #3494ac  3 处：场景中枢主按钮渐变暗端
    (72, 187, 120): '--t-accent-green-rgb',             # #48bb78  3 处 = --t-c-green-rgb
    (44, 150, 152): '--t-accent-outline-btn-glow-rgb',  # #2c9698  2 处：大纲主按钮光晕
    (104, 211, 145): '--t-accent-green-light-rgb',      # #68d391  2 处：快捷筛选激活态文字
    (0, 206, 201): '--t-accent-model-rgb',              # #00cec9  4 处：悬浮球「模型选择」图标
    (0, 217, 255): '--t-accent-timer-rgb',              # #00d9ff  1 处：悬浮球计时器
    (26, 116, 120): '--t-accent-outline-fab-glow-rgb',  # #1a7478  1 处：大纲新增 FAB 的光晕
    (84, 192, 172): '--t-accent-hub-btn-pale-rgb',      # #54c0ac  1 处：中枢按钮渐变亮端
    (133, 238, 220): '--t-accent-hub-btn-border-rgb',   # #85eedc  1 处：中枢按钮描边
    (121, 217, 168): '--t-accent-diff-after-text-rgb',  # #79d9a8  1 处：改写「改后」文字
    (102, 170, 153): '--t-accent-ok-dim-rgb',           # #66aa99  1 处：改写分类状态「正常」
    (46, 204, 113): '--t-accent-green-vivid-rgb',       # #2ecc71  1 处：统计项「正常」图标
    (0, 184, 148): '--t-accent-emerald-rgb',            # #00b894  1 处：生成完成通知的查看钮
    (76, 175, 80): '--t-accent-recall-ok-rgb',          # #4caf50  1 处：记忆回溯「可用」徽章
    (0, 255, 127): '--t-accent-recall-avail-rgb',       # #00ff7f  1 处：记忆回溯「可用」底

    # ── 黄 + 紫 + 带色偏暗底（Phase 6b-16，38 处）──
    # 这一批**零合并**：族内最近的两两也差 ΔE 4.0（#6a4d2b↔#604929、#552222↔#4e1a1f），
    # 没有一个到得了手误级阈值。故全部保留原值，色差严格为 0。
    # 亮点是好几个暗底能与前几批的强调色**配对**，浅色主题要成对调：
    #   #184433 ↔ --t-accent-diff-after-rgb    改写「改后」的绿
    #   #4e1a1f ↔ --t-accent-diff-before-rgb   改写「原文」的红
    #   #4a2530 ↔ --t-accent-mature-rgb/-border 工坊成人分级
    #   #23496c ↔ --t-accent-azure-dim-rgb     调试窗工具钮激活态
    # ⚠ #ffd93d 在 settings.css 另有 1 处调色板预览球，由 PALETTE_RULE 跳过。
    (255, 217, 61): '--t-accent-fav-yellow-rgb',        # #ffd93d  7 处：收藏夹身份色
    (236, 201, 75): '--t-accent-lore-update-rgb',       # #ecc94b  6 处：设定审阅「有更新」
    (241, 196, 15): '--t-accent-warn-log-rgb',          # #f1c40f  2 处：警告日志文字
    (243, 227, 178): '--t-accent-fav-chain-rgb',        # #f3e3b2  1 处：收藏链徽章
    (255, 234, 167): '--t-accent-stat-time-rgb',        # #ffeaa7  1 处：主窗耗时读数
    (199, 146, 234): '--t-accent-role-assistant-rgb',   # #c792ea  2 处：调试窗 assistant 角色标
    (118, 75, 162): '--t-accent-recall-rgb',            # #764ba2  2 处：记忆回溯身份色（深紫）
    (159, 122, 234): '--t-accent-lore-item-rgb',        # #9f7aea  1 处：Item 分类色标
    (24, 68, 51): '--t-accent-diff-after-fill-rgb',     # #184433  3 处：改写「改后」暗绿底
    (78, 26, 31): '--t-accent-diff-before-fill-rgb',    # #4e1a1f  1 处：改写「原文」暗红底
    (84, 64, 38): '--t-accent-fav-fill-rgb',            # #544026  2 处：收藏窗激活态/导出主钮底
    (96, 73, 41): '--t-accent-fav-fill-soft-rgb',       # #604929  1 处：无图卡片海报底
    (106, 77, 43): '--t-accent-fav-fill-warm-rgb',      # #6a4d2b  1 处：收藏窗容器暖光
    (58, 90, 58): '--t-accent-fav-edit-border-rgb',     # #3a5a3a  1 处：收藏工具栏编辑态描边
    (74, 37, 48): '--t-accent-mature-fill-rgb',         # #4a2530  2 处：工坊成人分级底
    (85, 34, 34): '--t-accent-mgr-footer-border-rgb',   # #552222  1 处：剧本管理页脚描边
    (42, 74, 58): '--t-accent-recall-ok-fill-rgb',      # #2a4a3a  1 处：回溯「可用」徽章底
    (74, 42, 42): '--t-accent-recall-bad-fill-rgb',     # #4a2a2a  1 处：回溯「不可用」徽章底
    (35, 73, 108): '--t-accent-azure-dim-fill-rgb',     # #23496c  1 处：调试工具钮激活底
    (34, 48, 64): '--t-accent-slot-hover-rgb',          # #223040  1 处：提示词插入槽 hover 底

    # ── Phase 6b-17 顺带收口的单值 ──
    (255, 214, 214): '--t-accent-danger-bulk-text-rgb',  # #ffd6d6 1 处：批量栏危险项文字
    #   与 6b-13 建的 -bulk-border(#f87171) / -bulk-fill(#b91c1c) 是同一组件的第三块。
    #   ⚠ 它 r-b=41 看着"很暖"，但 g==b，是淡红不是米色 —— 到奶油刻度差 ΔE 14.7，
    #     故走精确值而非 CREAM_TEXT_SCALE（is_cream_text 用 g-b>=6 把它挡在外面）。

    # ── Phase 6b-18 的两个「暗红」（被 is_warm_dark 的 g>b 挡在暖棕刻度之外）──
    (26, 16, 18): '--t-accent-diff-before-deep-rgb',   # rgba(26,16,18,.74) 1 处
    #   .t-rewrite-diff-before 渐变的第二个止点，第一个止点已是
    #   --t-accent-diff-before-fill-rgb —— 同一条渐变，浅色主题要一起调。
    (42, 26, 26): '--t-accent-mgr-footer-rgb',         # #2a1a1a 1 处
    #   .t-mgr-footer-bar 的底，其描边已是 --t-accent-mgr-footer-border-rgb。

    # ── Phase 6b-19：冷调余料里走精确值的 8 个 ──
    # ⚠ 这 8 条同时起「护栏」作用：tokenize_hue 先查 HUE_TOKENS、再查刻度组，
    #   所以列在这里的值**不可能**被下面的 SKY_TEXT_SCALE 误吸。
    #   这很要紧，因为 #a0b0c0 与 #dff1ff 的色度完全相同（b-r 都是 32），
    #   谓词只能靠亮度分开它们（L 71.1 vs 94.2），边界很紧。
    (154, 207, 245): '--t-accent-import-rgb',          # #9acff5 1 处：导入钮身份色
    #   它的兄弟 .is-export(#72efd0) / .is-update(#62d9bc) 在 6b-15 都是精确 token，
    #   所以它也走精确值而非刻度（进刻度会差 ΔE 5.4，且破坏三兄弟的并列关系）。
    (8, 37, 30): '--t-accent-update-text-on-rgb',      # #08251e 3 处：更新钮上的文字
    (194, 238, 217): '--t-accent-diff-after-tag-rgb',  # #c2eed9 1 处：改写命中标签文字
    (106, 128, 144): '--t-glass-text-dim-rgb',         # #6a8090 2 处：改写设置的计数与提示
    (111, 123, 143): '--t-glass-text-dim-cool-rgb',    # #6f7b8f 1 处：注入项时间戳
    (119, 131, 138): '--t-glass-text-hint-rgb',        # #77838a 1 处：锁定项的拖拽提示
    (160, 176, 192): '--t-glass-text-disabled-rgb',    # #a0b0c0 1 处：大纲导航钮 disabled
    (74, 85, 104): '--t-glass-text-faintest-rgb',      # #4a5568 2 处：分隔线与空态图标
    #   ⚠ 这 5 个冷灰各只出现 1~2 处、散在 4 个窗口，两两差 ΔE 4.6~15。
    #     按「取值多且各只出现一两次 ⇒ 漂移」本该合并，但它们到已有
    #     --t-glass-text-faint(142,162,180) 最近也差 ΔE 13.3，得新建 2~3 档，
    #     而合并后仍有 1~2 处落在 ΔE 4.6（可辨）。7 处的规模不值得为此改色，
    #     故先精确 token 化。日后要合并只是改 token 的值，不必再动 feature。

    # ── Phase 6b-20：01-base 的标题装饰色 ──
    (255, 154, 158): '--t-accent-rose-rgb',            # #ff9a9e 1 处：标题装饰条的光晕
    #   另外三条渐变（.t-title-main / .t-title-sub / .t-title-container::before）
    #   改为直接消费已存在、但从 Phase 1 起一直零消费者的 --t-gradient-title /
    #   -title-sub / -brand-bar；那三个 token 内部再引用
    #   -rose / -peach / -lilac 三元组，于是 token 层与 feature 层不会再各存一份。

    # ══ Phase 6b-21：非阴影的收尾 51 处 ══════════════════════════════════
    # 黑蒙层拆成两个 token —— 值相同、**浅色主题下走向相反**（第六次「同值不同角色」）：
    #   -scrim-media 盖在用户封面图上，是可读性蒙层，浅色主题下**仍要是黑**；
    #   -scrim-panel 是 UI 面板与页面背景遮罩，浅色主题下要翻成浅色。
    #   合并成一个就锁死了，而这个错误在深色下完全看不出来。
    (0, 0, 0): {'surface': '--t-scrim-media-rgb'},
    #   ⚠ 必须按角色门控：#000000 另有 56 处在 box-shadow 里，属刻意延后的阴影批次
    #     （阴影要整条变成 --t-shadow-* token，不是只换颜色）。不写 role 就会连带改掉。
    #   ⚠ 这条只对「favs 卡片」那 4 处成立；另 3 处 UI 面板（设定编辑器 / 统计 HUD /
    #     大纲抽屉背景）必须手改成 -scrim-panel-rgb —— 工具按值映射、分不出语义。
    (7, 7, 7): {'surface': '--t-scrim-media-rgb'},      # #070707 2 处，并入 #000
    #   合成 ΔE：alpha .08 上 0.00、.52 上 2.02（已含 #ccc 亮底上界）。
    (14, 22, 18): '--t-accent-diff-after-fill-deep-rgb',  # #0e1612 3 处
    #   改写「改后 / 命中」渐变的第二止点，第一止点是 --t-accent-diff-after-fill-rgb。
    (18, 26, 34): '--t-glass-nav-rgb',                 # #121a22 2 处：大纲导航钮 base+disabled
    (26, 26, 46): '--t-glass-pre-rgb',                 # #1a1a2e 2 处：设定审阅的 <pre> 块
    (30, 45, 58): '--t-accent-outline-btn-alt-rgb',     # #1e2d3a 1 处：全场景生成钮
    (26, 42, 26): '--t-accent-fav-edit-fill-rgb',       # #1a2a1a 1 处：收藏工具栏编辑态底
    #   其描边是 6b-16 建的 --t-accent-fav-edit-border-rgb(#3a5a3a)。
    (25, 35, 25): '--t-accent-success-fill-rgb',        # #192319 1 处：生成完成通知底
    (30, 30, 30): {'surface': '--t-surface-rgb'},       # #1e1e1e 2 处（alpha .5/.6）
    (51, 51, 51): {'surface': '--t-surface-high-rgb',
                   'text': '--t-glass-placeholder-rgb'},
    #   ⚠ #333333 同时是「工具图标 hover 底(.8)」与「工坊占位图标的文字」——
    #     第七次「同值不同角色」。浅色主题下前者要变浅、后者要变深，方向相反。
    (100, 100, 100): {'surface': '--t-surface-mid-rgb'},  # #646464 1 处，并入 #666
    #   合成 ΔE 在 alpha .3 上是 **0.00** —— 两个值在该透明度下完全不可分。
    (102, 102, 102): {'surface': '--t-surface-mid-rgb'},
    (176, 190, 197): '--t-accent-settings-rgb',         # #b0bec5 3 处：设置图标身份色
    #   悬浮球设置图标的「静息+发光+描边」三件套，2 处底 + 1 处描边同值。
    (177, 189, 201): '--t-glass-miss-rgb',              # #b1bdc9 1 处
    (189, 199, 210): '--t-glass-miss-rgb',              # #bdc7d2 1 处，并入
    (176, 188, 201): '--t-glass-miss-rgb',              # #b0bcc9 1 处，并入
    #   ⚠ 这三处是改写窗「未命中」的**同一族**（标签底 .12 + 标签描边 .35 + 行描边 .28），
    #     合到 #b6c1cd 一档最大合成 ΔE 1.0。跨 surface / border 两种角色共用一个 token
    #     在这里是对的：它们是同一个组件的同一个视觉状态。
    (85, 105, 122): '--t-glass-insert-rgb',             # #55697a 2 处：插入槽的线与标签描边
    (168, 201, 224): '--t-glass-border-blue-rgb',       # #a8c9e0 1 处
    (154, 192, 216): '--t-glass-border-blue-rgb',       # #9ac0d8 1 处，并入
    (160, 184, 204): '--t-glass-border-blue-rgb',       # #a0b8cc 1 处，并入
    #   故事大纲的三条浅蓝描边，合到 #a0c2d5 一档最大合成 ΔE 1.9。
    (131, 170, 196): '--t-glass-border-blue-dim-rgb',   # #83aac4 1 处
    (140, 160, 178): '--t-glass-border-blue-dim-rgb',   # #8ca0b2 1 处，并入
    #   合到 #85a7be 一档最大合成 ΔE 1.1。
    (52, 61, 67): '--t-glass-locked-border-rgb',        # #343d43 1 处
    (62, 74, 81): '--t-glass-locked-border-hover-rgb',  # #3e4a51 1 处
    #   ⚠ 这两个是 .t-prompt-entry-card.is-locked 的 base / :hover，差 ΔE 5.6 ——
    #     **不能并**，并了 hover 反馈就没了（--check-state 会报）。
    (70, 65, 56): '--t-glass-panel-warm-rgb',           # #464138 1 处：续写历史面板描边
    (255, 236, 201): '--t-accent-fav-checkbox-rgb',     # #ffecc9 1 处：收藏卡片勾选框描边
    (255, 255, 255): {'text': '--t-text-white-rgb',
                      'border': '--t-text-white-rgb',
                      'other': '--t-text-white-rgb'},
    #   9 处，散在 8 个 alpha 上：.1 .15 .3 .35 .4 .5 .8 .85 —— 与现有
    #   --t-color-text-strong(不透明白) 全部错开，一处都走不了旧 token；
    #   三元组形式一条声明覆盖全部 alpha。
    #   ⚠ 同样按角色门控：surface 与 shadow 上的白色叠加已有 --t-color-surface-* /
    #     --t-shadow-* 两族在管，不能被这条抢走。
    (169, 136, 136): '--t-glass-btn-warm-rgb',          # #a98888 1 处：续写历史头部钮
    (16, 22, 31): '--t-glass-footer-rgb',               # #10161f 1 处：设定设置对话框页脚底
}

# 手误级同值合并（远低于可辨阈值）。键并入值。
# ⚠ 只收「同一个颜色被打成两种写法」这一类：同文件、同族、同角色，且 ΔE <= 1.2。
#   真正差半档的一律不并 —— 强调色的分档实测见 HUE_TOKENS 上方
#   （ΔE<=8 要付 75 处明显变色）。
HUE_ALIASES = {
    (255, 118, 118): (255, 118, 117),   # #ff7676 -> #ff7675  ΔE 0.5
    (240, 143, 143): (239, 143, 143),   # #f08f8f -> #ef8f8f  ΔE 0.4
    (229, 200, 140): (231, 202, 143),   # #e5c88c -> #e7ca8f  ΔE 0.9
    (100, 220, 190): (98, 217, 188),    # #64dcbe -> #62d9bc  不透明 ΔE 1.2
    #                                     （实际用在 alpha .35 上，合成 ΔE 0.42）
}
for _k, _v in HUE_ALIASES.items():
    HUE_TOKENS[_k] = HUE_TOKENS[_v]


# ══════════════════════════════════════════════════════════════════════
# Phase 6b-17 起：三元组**刻度**吸附（HUE_SNAP_GROUPS）
#
# 与上面的 HUE_TOKENS（逐值精确替换）互补，用在**另一种人口形态**上。
# 判据是这一路测出来的、最有用的一条：
#
#     取值多、每个只出现一两次  ⇒ 漂移，该合并
#     取值少、各占十几处        ⇒ 身份，不该合并
#
# 强调色是后者（#4a9eff 一个值 15 处、#e7ca8f 一个值 15 处），所以 6b-12~16 按原值
# token 化；暖调文字是前者（18 个取值 / 20 处，收藏窗一个窗口就用了 11 个几乎一样
# 的奶油色，两两差 ΔE 1–4），没人会刻意为一个窗口挑 11 个相近的米色，那是漂移。
#
# ⚠ 谓词必须写窄。这条规则已经踩过三次（6b-8 的饱和度上限、6b-9 的 b>=g、
#   6b-10 的中性容差）：谓词一宽就会把别的族收进来、强行匹配到本族刻度上，
#   而审计与「计算值不变」自证**都发现不了**。
# ⚠ 色差用合成 ΔE：这些色多数用在 alpha < 1 上，合成后的可见差比不透明 ΔE 更小，
#   直接比不透明值会高估变化、把本可安全合并的挡在门外。
HUE_SNAP_GROUPS = []


def is_cream_text(k):
    """暖调奶油文字：低饱和的暖白/米色，用于正文与说明。

    ⚠ 三个条件都是必要的，缺一个就会误收：
      · not accent（S<25 或 V<25）—— 否则会把品牌金 #bfa15f 一类收进来
      · r - b >= 8               —— 排除纯灰与冷灰
      · g - b >= 6               —— **排除粉红**。#ffd6d6 的 r-b 是 41、看着"很暖"，
                                    但它 g == b，是淡红不是米色，到奶油刻度差 ΔE 14.7。
                                    只判 r-b 会把它强行吸到 #e4dccc 上。
      · L >= 50                  —— 暖调**暗底**（#201912 一族，L<20）归 6b-18 的
                                    表面刻度，不能被文字刻度抢走。
    """
    r, g, b = k[:3]
    h, s, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
    if s * 100 >= 25 and v * 100 >= 25:
        return False
    return r - b >= 8 and g - b >= 6 and _lab(k[:3])[0] >= 50


# 暖调奶油文字阶（8 档）。人口 18 个取值 / 20 处，两两差 ΔE 1–4 —— 典型漂移：
# 收藏窗一个窗口就用了 11 个几乎一样的米色（#e2dccc #e4dbc9 #e8e0d2 #efe4cb
# #eaddc5 #f5e6c2 #d1c4a9 #c4b699 #b7aaa0 #8d866f #f3e3b2），每个只出现一两次。
#
# 档位按**实测人口重心**挑，不是等分：亮端 L 88–92 挤了 9 个取值，暗端 L 56–70
# 只有 2 个。7 档时 #f4e2bc / #eaddc5 会落在 ΔE 4.3 / 4.4（肉眼可辨），
# 补上 #efe0c1 这一档后**明显档清零**，最大 ΔE 降到 3.2。
CREAM_TEXT_SCALE = [
    ((246, 241, 230), '--t-cream-0-rgb'),   # #f6f1e6  L95  近白暖白
    ((242, 229, 198), '--t-cream-1-rgb'),   # #f2e5c6  L92  亮米（吃 5 处，人口重心）
    ((239, 224, 193), '--t-cream-2-rgb'),   # #efe0c1  L90  6b-17 新增，专治上面那 2 处
    ((228, 220, 204), '--t-cream-3-rgb'),   # #e4dccc  L88  正文米（吃 4 处）
    ((217, 210, 194), '--t-cream-4-rgb'),   # #d9d2c2  L84  次要说明
    ((201, 188, 159), '--t-cream-5-rgb'),   # #c9bc9f  L77  弱说明（吃 3 处）
    ((183, 170, 160), '--t-cream-6-rgb'),   # #b7aaa0  L70  取消钮一类
    ((141, 134, 111), '--t-cream-7-rgb'),   # #8d866f  L56  空态提示（最弱）
]

HUE_SNAP_GROUPS.append({
    'name': '暖调奶油文字阶',
    'roles': ('text',),
    'pick': is_cream_text,
    'tiers': CREAM_TEXT_SCALE,
    'max_de': 8.0,
})


def is_warm_dark(k):
    """暖调暗底（棕色系）。

    ⚠ `g > b` 是关键，它把**棕**与**暗红**分开：
      · 棕（#201912 一族，g 在 r 与 b 之间）—— 13 个取值两两差 ΔE 0.5~2.5，是漂移
      · 暗红（#1a1012 g<b、#2a1a1a g==b）—— 它们各自与已有的红族 token 配对
        （.t-rewrite-diff-before 的渐变止点、.t-mgr-footer-bar 的底），是身份不是漂移
    ⚠ `r - b >= 4` 而非文字刻度用的 8：极暗色的通道差本就被压缩，
      用 8 会把 #120f0b（r-b=7，收藏卡片渐变的最暗止点）漏掉。
    ⚠ L < 50 与 is_cream_text 的 L >= 50 互补，两条刻度不会互抢。
    """
    r, g, b = k[:3]
    if _lab(k[:3])[0] >= 50:
        return False
    return r - b >= 4 and g > b


# 暖调暗底阶（6 档）。人口 13 个取值 / 15 处，几乎全在收藏窗，两两差 ΔE 0.5~2.5 ——
# 比奶油文字漂移得更极端（#312516↔#302415 差 0.5、#201912↔#1f1811 也是 0.5）。
#
# ⚠ 档位必须让 `.t-fav-card-bg.no-img` 的**渐变三个止点**保持可区分：
#     radial-gradient(..., #3a2d1e 0%, #201912 48%, #120f0b 100%)
#   它们分别落在 T0 / T3 / T5，跨度没被压掉。若只设 3~4 档，中间止点会被吸到与
#   端点同档，渐变就塌成纯色 —— 这类「同一条渐变的止点被合并」是 --check-state
#   看不见的（它只比 base 与 :hover），只能靠设计档位时手动核对。
#
# ⚠ 这条刻度**不是**中性表面刻度的替代。CLAUDE.md 的护栏说「表面刻度只接受纯灰
#   （R=G=B，容差 4）」，正是为了不让收藏窗的暖金底被吸成中性灰、抹掉设计意图。
#   本刻度保留暖色偏，是对那条护栏的补充而非违反。
WARM_SURFACE_SCALE = [
    ((58, 45, 30), '--t-warm-surface-0-rgb'),    # #3a2d1e L19.5 卡片渐变顶
    ((51, 38, 23), '--t-warm-surface-1-rgb'),    # #332617 L16.3 网格/舞台/激活底（吃 5 处）
    ((43, 31, 18), '--t-warm-surface-2-rgb'),    # #2b1f12 L12.8 窗口底
    ((31, 26, 20), '--t-warm-surface-3-rgb'),    # #1f1a14 L 9.8 抽屉/菜单/渐变中段（吃 4 处）
    ((27, 23, 16), '--t-warm-surface-4-rgb'),    # #1b1710 L 7.4 导出面板（吃 3 处）
    ((18, 15, 11), '--t-warm-surface-5-rgb'),    # #120f0b L 4.5 卡片渐变底
]

HUE_SNAP_GROUPS.append({
    'name': '暖调暗底阶',
    'roles': ('surface',),
    'pick': is_warm_dark,
    'tiers': WARM_SURFACE_SCALE,
    'max_de': 8.0,
})


# 冷灰族的原语取值。is_sky_text 用它作排除表 —— 见该函数注释的第四条。
# 与 primitives.css 的 --t-c-cool-6..12 一一对应；改那边记得同步这里。
COOL_GRAY_PRIMS = {
    (74, 85, 104),      # --t-c-cool-6   #4a5568  Chakra gray.600
    (113, 128, 150),    # --t-c-cool-7   #718096  Chakra gray.500
    (120, 150, 170),    # --t-c-cool-8   #7896aa
    (160, 174, 192),    # --t-c-cool-9   #a0aec0  Chakra gray.400
    (169, 191, 209),    # --t-c-cool-10  #a9bfd1
    (203, 213, 224),    # --t-c-cool-11  #cbd5e0  Chakra gray.300
    (226, 232, 240),    # --t-c-cool-12  #e2e8f0  Chakra gray.200
}


def is_sky_text(k):
    """冷调浅蓝文字（不是冷灰，也不是纯蓝强调色）。

    ⚠ 这一族正是 6b-8 建 --t-glass-text* 时**超阈值剩下的**那批：它们比冷灰族
      饱和得多（#9cc3ea 的 b-r 有 78），到最近的 --t-glass-text-secondary
      差 ΔE 12，属误配 —— 与 6b-11 青绿族同一个原因（词汇表缺一族）。

    ⚠ 三个条件都必要：
      · b > g       —— 排除薄荷 #c2eed9（g > b），它属改写命中一族
      · b - r >= 26 —— 排除**冷灰**。只写 >= 20 会把 #cbd5e0(b-r=21，即
                       --t-glass-text-soft / --t-c-cool-11) 收进来，那是 6b-8
                       已归位的冷灰族，被强行吸到浅蓝档上就是误配。
                       本族人口里最低的 b-r 是 #dff1ff 的 32，26 有安全余量。
      · L >= 76     —— 排除 #a0b0c0(L71.1)。注意它与 #dff1ff(L94.2) 的**色度完全
                       相同**（b-r 都是 32），亮度是唯一能分开二者的量，边界很紧。
                       故 #a0b0c0 同时列在 HUE_TOKENS 里作第二道护栏。
      · 不在 COOL_GRAY_PRIMS 里 —— 光靠上面三条挡不住 #a9bfd1(--t-c-cool-10)：
                       它 L=76.4、b-r=40，两项都过线，而 L 门槛已贴着本族最暗的
                       #9cc3ea(L77.3)、抬不动了。冷灰族的取值是**已枚举的原语**，
                       直接列成排除表比继续调阈值可靠。
    """
    if k[:3] in COOL_GRAY_PRIMS:
        return False
    r, g, b = k[:3]
    return b > g and b - r >= 26 and _lab(k[:3])[0] >= 76


# 冷调浅蓝文字阶（4 档）。人口 9 个取值 / 13 处，L 77–94，两两差 ΔE 1.3–6。
# 顶档 #d7ecfd 是实测挑的：换成复用已有的 --t-glass-text-bright(215,231,245) 时
# .t-wi-title-hit 会差 ΔE 5.4（可辨）；换成人口重心 #dcefff 仍差 4.9；
# 取 #d7ecfd 后**「明显」档清零**，最大 ΔE 降到 3.9。多一个 token 换掉一处可见变化。
# ⚠ 别再往上加第 5 档：实测加了之后 --t-glass-text-bright 会变成零消费者
#   （按人口补档，别补「看起来该有」的档）。
SKY_TEXT_SCALE = [
    ((215, 236, 253), '--t-sky-text-0-rgb'),   # #d7ecfd L92 最亮（选中项/区块标题，3 处）
    ((184, 217, 239), '--t-sky-text-1-rgb'),   # #b8d9ef L85 区块标题/移动端头（4 处）
    ((168, 218, 246), '--t-sky-text-2-rgb'),   # #a8daf6 L85 激活态（2 处）
    ((156, 195, 234), '--t-sky-text-3-rgb'),   # #9cc3ea L77 序号/列头（4 处）
]

HUE_SNAP_GROUPS.append({
    'name': '冷调浅蓝文字阶',
    'roles': ('text',),
    'pick': is_sky_text,
    'tiers': SKY_TEXT_SCALE,
    'max_de': 8.0,
})


def snap_group_for(role, k):
    """返回 (token, 合成ΔE)；没有匹配的组返回 (None, None)。"""
    for g in HUE_SNAP_GROUPS:
        if role not in g['roles'] or not g['pick'](k):
            continue
        best, bd = None, 1e9
        for rgb, tok in g['tiers']:
            d = alpha_delta_e(k, rgb + (k[3],))
            if d < bd:
                best, bd = tok, d
        if best is not None and bd <= g['max_de']:
            return best, bd
        return None, bd          # 命中了组但超阈值 —— 交给调用方报告
    return None, None


def fmt_a(a):
    """alpha 按 CSS 习惯写法输出：1 省略、0.25 写 .25。"""
    s = ('%g' % round(a, 4))
    return s[1:] if s.startswith('0.') else s


# ── Phase 6b-22：阴影（--tokenize-shadow）────────────────────────────
#
# 阴影的 token 形状与前 21 批**不同**：token 持有「颜色 + alpha」，几何留在消费点。
# 理由：
#   · alpha 必须进 token。浅色主题下同样的黑投影会显得脏重，生成器用 R-D
#     「alpha × 0.55」处理；而 R-D 是按 token 名前缀匹配、改 token 值里的 alpha 的。
#     若写成前 21 批那种 `rgb(var(--x-rgb) / .56)`，alpha 在消费点，R-D 碰不到，
#     36 处黑投影会在浅色主题下按全强度渲染。
#   · 几何不进 token。38 处里有 31 条不同几何，一处一 token 等于没收敛；而按几何
#     吸附**没有可用的感知度量**（ΔE 量得了颜色，量不了 blur 半径），属设计判断。
#
# 曾考虑但**没有采用**的更紧凑写法：
#     --t-shadow-ink-rgb: 0 0 0;  --t-shadow-dim: 1;   /* 浅色覆盖为 .55 */
#     box-shadow: 0 22px 58px rgb(var(--t-shadow-ink-rgb) / calc(.56 * var(--t-shadow-dim)));
#   只要 4 个 token（而非 19 个），alpha 还留在消费点、漂移保持可见，并且与现有
#   8 个整条配方 token 统一到同一个旋钮上（R-D/R-E 可整条删掉），两主题下数值
#   逐位等价。放弃的唯一原因：**本环境无法验证 calc() 用在 rgb() 的 alpha 位**，
#   而它的失败模式是「整条声明被丢弃 → 阴影静默消失」，一次波及 49 处。
#   A25 就是为这类静默失效加的。故本批只用仓库里已验证可用的构造（纯 var() 代换）。
#   等能在浏览器里实测后再考虑换成 calc 写法。
SHADOW_TOKENS = {
    # 黑投影：14 档。并到现有 4 档 {.2 .3 .5 .8} 要付 18 处 ΔE>4（明显），
    # 最坏 8.31 —— 阴影 alpha 直接在亮底上移动 L，比色相敏感得多。
    ((0, 0, 0), .2): '--t-shadow-ink-20',
    ((0, 0, 0), .24): '--t-shadow-ink-24',
    ((0, 0, 0), .28): '--t-shadow-ink-28',
    ((0, 0, 0), .3): '--t-shadow-ink-30',
    ((0, 0, 0), .35): '--t-shadow-ink-35',
    ((0, 0, 0), .44): '--t-shadow-ink-44',
    ((0, 0, 0), .45): '--t-shadow-ink-45',
    ((0, 0, 0), .48): '--t-shadow-ink-48',
    ((0, 0, 0), .5): '--t-shadow-ink-50',
    ((0, 0, 0), .55): '--t-shadow-ink-55',
    ((0, 0, 0), .56): '--t-shadow-ink-56',
    ((0, 0, 0), .6): '--t-shadow-ink-60',
    ((0, 0, 0), .72): '--t-shadow-ink-72',
    ((0, 0, 0), .82): '--t-shadow-ink-82',
    # 白/奶油高光：名字带 sheen 才会走 R-E（保持白、alpha × 0.7）而非 R-D
    ((255, 255, 255), .05): '--t-shadow-sheen-05',
    ((255, 255, 255), .1): '--t-shadow-sheen-10',
    ((255, 255, 255), .22): '--t-shadow-sheen-22',
    ((255, 245, 222), .05): '--t-shadow-sheen-cream-05',
    ((255, 240, 210), .06): '--t-shadow-sheen-cream-06',
    # 有色投影
    ((17, 34, 54), .28): '--t-shadow-navy-28',
}

# 辉光不是投影：颜色引用强调色三元组、alpha 留消费点（沿用 --t-shadow-glow-* 写法）。
# 挂进 --t-shadow-* 会走 R-D「只减淡」，浅底上一个更淡的蓝就看不见了。
SHADOW_HUE = {(100, 168, 214): '--t-accent-sky-glow-rgb'}


def _norm_recipe(v):
    """把一条阴影值归一化成可比字符串：颜色统一写法、空白折叠。

    ⚠ 必须连**几何**一起比。--verify 只提取颜色序列，看不见 blur/offset ——
      所以「整条配方等值替换」的等价性不能靠 --verify 证明，只能在改写时就
      按归一化后的整条字符串精确匹配来保证。这是本批唯一一处 --verify 覆盖不到
      的地方，故在这里做成硬条件（不等就不换）。
    """
    def f(m):
        k = canon(m.group(0))
        if not k:
            return m.group(0)
        a = '' if k[3] >= 0.999 else ' / %s' % fmt_a(k[3])
        return 'rgb(%d %d %d%s)' % (k[0], k[1], k[2], a)
    return ' '.join(COLOR_RE.sub(f, v).split())


def tokenize_shadow(path, apply_it):
    """阴影字面量 -> token。零变色。两条路径，先整条后逐值：

      ① 整条配方逐字等于现成 --t-shadow-<尺寸> -> 换成 var(--t-shadow-<尺寸>)
         （几何也必须逐字相同，见 _norm_recipe）
      ② 其余：把每个颜色字面量换成 var(--t-shadow-ink-NN) 等；辉光换成
         rgb(var(--t-accent-sky-glow-rgb) / α)

    返回 (变更列表, 未命中列表, 错误)，签名与 _snap / tokenize_hue 对齐。
    """
    raw = open(path, encoding='utf-8', newline='').read()
    crlf, lf = eol_of(raw)
    if crlf and lf:
        return None, None, '行尾混用，跳过'
    spans = [(m.start(), m.end()) for m in COMMENT_RE.finditer(raw)]
    # 与 tokenize_hue 同两道护栏：调色板预览球（A24）与 var() 回退值（B5）。
    # ⚠ 回退值这道对本批是**真的会命中**：keyframes.css 有 2 处
    #   `box-shadow: 0 0 5px var(--t-border-color, #55efc4)`，回退位里的
    #   #55efc4 不许动，而它正好在一条 box-shadow 上。
    skip = [(m.start(), m.end()) for m in PALETTE_RULE.finditer(raw)]
    skip += [(m.start(1), m.end(1)) for m in VAR_FALLBACK.finditer(raw)]

    recipes = {}
    for n, v in token_defs().items():
        if n.startswith('--t-shadow-') and 'var(' not in v:
            recipes[_norm_recipe(v)] = n

    out, last, changes, miss = [], 0, [], []
    for dm in DECL_RE.finditer(raw):
        if any(a <= dm.start(3) < b for a, b in spans):
            continue
        if 'shadow' not in dm.group(2):
            continue
        vs, ve = dm.start(3), dm.end(3)
        seg = raw[vs:ve]
        if not COLOR_RE.search(seg):
            continue
        if any(a <= vs + m.start() < b
               for m in COLOR_RE.finditer(seg) for a, b in skip):
            continue

        # ① 整条配方
        hit = recipes.get(_norm_recipe(seg))
        if hit:
            out.append(raw[last:vs])
            out.append('var(%s)' % hit)
            last = ve
            changes.append((path, ' '.join(seg.split()), hit, 0.0))
            continue

        # ② 逐个颜色字面量
        pieces, pos = [], 0
        for cm in COLOR_RE.finditer(seg):
            k = canon(cm.group(0))
            if not k:
                continue
            tok = SHADOW_TOKENS.get((k[:3], round(k[3], 3)))
            if tok:
                rep = 'var(%s)' % tok
            else:
                hue = SHADOW_HUE.get(k[:3])
                if not hue:
                    miss.append((path, cm.group(0), '无对应 token', 0.0))
                    continue
                rep = ('rgb(var(%s))' % hue if k[3] >= 0.999
                       else 'rgb(var(%s) / %s)' % (hue, fmt_a(k[3])))
                tok = hue
            pieces.append(seg[pos:cm.start()])
            pieces.append(rep)
            pos = cm.end()
            changes.append((path, cm.group(0), tok, 0.0))
        if pieces:
            out.append(raw[last:vs])
            out.append(''.join(pieces) + seg[pos:])
            last = ve
    out.append(raw[last:])
    new = ''.join(out)
    assert eol_of(new) == (crlf, lf), '%s 行尾变了' % path
    if apply_it and changes:
        open(path, 'w', encoding='utf-8', newline='').write(new)
    return changes, miss, None


def tokenize_hue(path, apply_it):
    """把色相三元组改写成 rgb(var(--token) / α)。

    两条路径：
      ① HUE_TOKENS 逐值精确匹配 —— 零变色（强调色走这条，见其上方说明）
      ② HUE_SNAP_GROUPS 刻度吸附 —— 会改色，逐处报合成 ΔE（漂移人口走这条）

    返回 (变更列表, 超阈值列表, 错误)。签名与 _snap 对齐，好共用 main() 的汇总代码。
    """
    raw = open(path, encoding='utf-8', newline='').read()
    crlf, lf = eol_of(raw)
    if crlf and lf:
        return None, None, '行尾混用，跳过'
    spans = [(m.start(), m.end()) for m in COMMENT_RE.finditer(raw)]
    # 与 _snap 同两条护栏：调色板预览球（审计 A24）与 var() 回退值（B5）。
    skip = [(m.start(), m.end()) for m in PALETTE_RULE.finditer(raw)]
    skip += [(m.start(1), m.end(1)) for m in VAR_FALLBACK.finditer(raw)]
    out, last, changes, over = [], 0, [], []
    for dm in DECL_RE.finditer(raw):
        if any(a <= dm.start(2) < b for a, b in spans):
            continue
        role = role_of(dm.group(2))
        vs, ve = dm.start(3), dm.end(3)
        seg, pieces, pos = raw[vs:ve], [], 0
        for cm in COLOR_RE.finditer(seg):
            k = canon(cm.group(0))
            if not k:
                continue
            if any(a <= vs + cm.start() < b for a, b in skip):
                continue
            de = 0.0
            tok = HUE_TOKENS.get(k[:3])
            if isinstance(tok, dict):
                # 按角色分（与 MAP 同机制）。角色不在表里就跳过 —— 这是**门控**而非
                # 遗漏：#000000 有 56 处在 box-shadow 里、属刻意延后的阴影批次，
                # 只登记 {'surface': ...} 才能不把它们一起改掉。
                tok = tok.get(role)
            if tok is None:
                tok, de = snap_group_for(role, k)
                if tok is None:
                    # de 非 None 表示命中了某个组但超阈值 —— 必须报出来，
                    # 否则「谓词收进来却没改」会静默变成漏改。
                    if de is not None:
                        over.append((path, cm.group(0), '刻度内最近档', de))
                    continue
            rep = ('rgb(var(%s))' % tok if k[3] >= 0.999
                   else 'rgb(var(%s) / %s)' % (tok, fmt_a(k[3])))
            pieces.append(seg[pos:cm.start()])
            pieces.append(rep)
            pos = cm.end()
            changes.append((path, cm.group(0), tok, de))
        if pieces:
            out.append(raw[last:vs])
            out.append(''.join(pieces) + seg[pos:])
            last = ve
    out.append(raw[last:])
    new = ''.join(out)
    assert eol_of(new) == (crlf, lf), '%s 行尾变了' % path
    if apply_it and changes:
        open(path, 'w', encoding='utf-8', newline='').write(new)
    return changes, over, None


def cmd_check_state(files):
    defs = token_defs()
    total = new = real = 0
    # ⚠ 必须同时查底色与描边：6b-3 改的一半是描边，而「base 与 hover 的描边被吸到
    # 同一档」跟底色塌陷是同一类 bug（交互反馈静默消失）。只查 background 会漏掉一半。
    for role, label in (('surface', '底色'), ('border', '描边')):
        for p in files:
            r = subprocess.run(['git', 'show', 'HEAD:' + p], capture_output=True)
            old = (bg_map(r.stdout.decode('utf-8'), defs, role)
                   if not r.returncode else {})
            cur = bg_map(open(p, encoding='utf-8').read(), defs, role)
            for b, st in state_pairs(cur):
                if last_color(cur[b]) != last_color(cur[st]):
                    continue
                total += 1
                had_both = b in old and st in old
                was_same = had_both and last_color(old[b]) == last_color(old[st])
                if was_same:
                    verdict = 'HEAD 里本来就同色，非本次引入'
                else:
                    new += 1
                    # ⚠ 关键区分：HEAD 里这一对本来差多少？若本就不可辨（ΔE<2），
                    # 说明「反馈」是别的属性给的（多半是 background），合档没有
                    # 真的破坏交互 —— 必须与「毁掉了可见反馈」分开报，
                    # 否则护栏只会响、不可行动。
                    d = (seq_delta_e(last_color(old[b]), last_color(old[st]))
                         if had_both else -1.0)
                    if d < 0:
                        verdict = '★ 本次新增塌陷（HEAD 侧无法比较，需人工看）'
                        real += 1
                    elif d < 2.0:
                        verdict = ('◦ 本次合档，但 HEAD 里两者仅差 ΔE %.1f（本就不可辨）'
                                   ' —— 反馈来自其它属性，非真回归' % d)
                    else:
                        verdict = ('★★ 本次新增塌陷，且 HEAD 里两者差 ΔE %.1f'
                                   '（毁掉了可见反馈）' % d)
                        real += 1
                print('  %s  [%s]' % (os.path.basename(p), label))
                print('      base  %-46s %s' % (b, cur[b][-1][0] or '（全局）'))
                print('      state %-46s %s' % (st, cur[st][-1][0] or '（全局）'))
                print('      %s' % verdict)
    print('\n状态对同色共 %d 处（底色+描边）：本次新增 %d 处，其中真回归 %d 处'
          % (total, new, real))
    return real


def main():
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument('files', nargs='*')
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--verify', action='store_true')
    ap.add_argument('--report', action='store_true')
    ap.add_argument('--normalize-eol', action='store_true')
    ap.add_argument('--snap-text', action='store_true',
                    help='把 color: 上的中性灰吸附到文字刻度（会改色，逐处报 ΔE）')
    ap.add_argument('--snap-surface', action='store_true',
                    help='把 background 上的纯灰吸附到表面刻度（会改色；之后必跑 --check-state）')
    ap.add_argument('--snap-text-cool', action='store_true',
                    help='把 color: 上的冷调文字色吸附到冷调刻度（会改色，逐处报 ΔE）')
    ap.add_argument('--snap-glass-dark', action='store_true',
                    help='把冷调暗底吸附到冷玻璃刻度（同时吸颜色与 alpha）')
    ap.add_argument('--snap-teal', action='store_true',
                    help='青绿族：一个色相 × 8 档 alpha（含不透明档与 text 角色）')
    ap.add_argument('--snap-neutral-dark', action='store_true',
                    help='中性暗色：描边与底色各用自己的 token 族')
    ap.add_argument('--snap-alpha', action='store_true',
                    help='把色族半透明色的 alpha 吸附到该族阶梯（会改色；之后必跑 --check-state）')
    ap.add_argument('--tokenize-hue', action='store_true',
                    help='把 HUE_TOKENS 里的色相三元组改写成 rgb(var(--x-rgb) / α)，零变色')
    ap.add_argument('--tokenize-shadow', action='store_true',
                    help='阴影字面量 -> --t-shadow-* token（持颜色+alpha，几何留消费点），零变色')
    ap.add_argument('--tol', type=float, default=0.0,
                    help='--verify 允许的逐位感知差上界（默认 0 = 严格相等）。'
                         '只用于放过 HUE_ALIASES 那种手误级合并；每处仍会连 ΔE 打出来')
    ap.add_argument('--check-state', action='store_true',
                    help='检测 base 与其 :hover/.active 是否被吸到同一档（交互反馈消失）')
    ap.add_argument('-h', '--help', action='store_true')
    a = ap.parse_args()
    if a.help:
        print(__doc__)
        return
    if a.report:
        cmd_report()
        return
    files = a.files or [os.path.join(FEATURE_DIR, f).replace(os.sep, '/')
                        for f in sorted(os.listdir(FEATURE_DIR)) if f.endswith('.css')]

    if a.check_state:
        sys.exit(1 if cmd_check_state(files) else 0)

    if a.normalize_eol:
        for p in files:
            raw = open(p, encoding='utf-8', newline='').read()
            crlf, lf = eol_of(raw)
            if crlf and lf:
                nl = '\r\n' if crlf >= lf else '\n'
                open(p, 'w', encoding='utf-8', newline='').write(
                    raw.replace('\r\n', '\n').replace('\n', nl))
                print('%-42s 行尾归一化 CRLF=%d LF=%d -> 全 %s' % (
                    p, crlf, lf, 'CRLF' if nl == '\r\n' else 'LF'))
        return

    if (a.snap_text or a.snap_surface or a.snap_alpha or a.snap_text_cool
            or a.snap_glass_dark or a.snap_neutral_dark
            or a.snap_teal or a.tokenize_hue or a.tokenize_shadow):
        from collections import Counter
        fn = (snap_text if a.snap_text else
              snap_text_cool if a.snap_text_cool else
              snap_glass_dark if a.snap_glass_dark else
              snap_teal if a.snap_teal else
              snap_neutral_dark if a.snap_neutral_dark else
              tokenize_hue if a.tokenize_hue else
              tokenize_shadow if a.tokenize_shadow else
              snap_surface if a.snap_surface else snap_alpha)
        allc, allo = [], []
        for p in files:
            c, o, err = fn(p, a.apply)
            if err:
                print('%-42s %s' % (p, err))
                continue
            allc += c
            allo += o
        band = Counter()
        for rec in allc:
            d = rec[3]
            band['ΔE<1' if d < 1 else 'ΔE1-2' if d < 2 else 'ΔE2-4' if d < 4 else 'ΔE4-8'] += 1
        print('%s：吸附 %d 处，超阈值(ΔE>%.0f)未动 %d 处' % (
            '已应用' if a.apply else 'DRY-RUN', len(allc), SNAP_MAX_DE, len(allo)))
        print('色差分布：%s%s' % (dict(band),
                              '（半透明色差已合成到 #111/#333/#ccc 三种底上取上界；'
                              '含亮底是为了不低估「黑蒙层盖在图片上」的变化）'
                              if (a.snap_alpha or a.snap_glass_dark or a.snap_teal) else ''))
        agg = Counter()
        for rec in allc:
            agg[(rec[1].lower(), rec[2], round(rec[3], 1))] += 1
        print()
        print('%-30s -> %-34s %6s %5s' % ('原值', 'token', 'ΔE', '处数'))
        for (v, t, d), n in sorted(agg.items(), key=lambda x: -x[1]):
            print('%-30s -> %-34s %6.1f %5d' % (v, t, d, n))
        if allo:
            print()
            print('超阈值、需人工处理：')
            for rec in allo:
                print('  %-40s %-22s 最近档 %-30s ΔE %.1f' % (rec[0], rec[1], rec[2], rec[3]))
        return

    if a.verify:
        defs = token_defs()
        bad = tot = worst_n = 0
        worst = 0.0
        for p in files:
            r = subprocess.run(['git', 'show', 'HEAD:' + p], capture_output=True)
            if r.returncode:
                continue
            before = color_sequence(r.stdout.decode('utf-8'), defs)
            after = color_sequence(open(p, encoding='utf-8').read(), defs)
            if len(before) != len(after):
                print('!! %s 带颜色的声明数变了 %d -> %d' % (p, len(before), len(after)))
                bad += 1
                continue
            n = 0
            for (pb, sb), (pa, sa) in zip(before, after):
                tot += len(sb)
                if pb != pa or sb != sa:
                    # 逐位算感知差：--tol 允许「已知的手误级合并」通过，
                    # 但仍把每一处连同 ΔE 打出来，绝不静默放过。
                    d = seq_delta_e(sb, sa)
                    worst = max(worst, d)
                    if d < 0 or d > a.tol:
                        bad += 1
                    else:
                        worst_n += 1
                        n += len(sb)
                    if bad <= 12 or (0 <= d <= a.tol):
                        print('  %s %s  %s %s -> %s %s  ΔE %s' % (
                            'X' if (d < 0 or d > a.tol) else '~', p, pb, sb, pa, sa,
                            '无法比较' if d < 0 else '%.2f' % d))
                    elif bad == 13:
                        print('  … 超容差的明细只打前 12 条，'
                              '**总数看下面的汇总行**（别去数上面的 X）')
                else:
                    n += len(sb)
            print('%-42s %4d 个颜色位一致' % (p, n))
        print('\n共 %d 个颜色位，超出容差 %d 处' % (tot, bad))
        if bad:
            sys.exit(1)
        if worst_n:
            print('OK：%d 处在容差 ΔE<=%.2f 内（最大 %.2f），其余计算值零变化'
                  % (worst_n, a.tol, worst))
        else:
            print('OK：计算值零变化')
        return

    total = 0
    for p in files:
        res, err = rewrite(p)
        if err:
            print('%-42s %s' % (p, err))
            continue
        new, done = res
        total += done
        if done:
            print('%-42s 替换 %3d 处' % (p, done))
            if a.apply:
                open(p, 'w', encoding='utf-8', newline='').write(new)
    print('\n%s：共替换 %d 处' % ('已应用' if a.apply else 'DRY-RUN', total))


main()
