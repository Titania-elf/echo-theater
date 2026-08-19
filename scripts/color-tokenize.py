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
    (68, 68, 68, 1.0): '--t-color-border-strong',
    (102, 102, 102, 1.0): '--t-color-text-faint',
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
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    if len(h) == 4:
        h = ''.join(c * 2 for c in h[:3])
    if len(h) == 8:
        h = h[:6]
    if len(h) != 6:
        return None
    try:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return None


def canon(v):
    """把颜色写法归一化为 (r, g, b, alpha)。认不出的返回 None。"""
    # ⚠ 不要在这里去掉空格：现代写法 rgb(24 24 24) 靠空格分隔通道，
    # 去空格会变成 rgb(242424) 而解析失败（本项目的 token 就是空格写法）。
    v = v.strip().lower()
    if v.startswith('#'):
        r = hex2rgb(v)
        return r + (1.0,) if r else None
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
    defs = {}
    for f in sorted(os.listdir(TOKEN_DIR)):
        if not f.endswith('.css'):
            continue
        s = re.sub(r'/\*.*?\*/', '', open(os.path.join(TOKEN_DIR, f), encoding='utf-8').read(),
                   flags=re.S)
        for m in re.finditer(r'(--t-[\w-]+)\s*:\s*([^;]+);', s):
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


COLOR_RE = re.compile(r'#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\)')
DECL_RE = re.compile(r'(^|[;{\s])([-a-zA-Z]+)\s*:\s*([^;{}]*)')
COMMENT_RE = re.compile(r'/\*.*?\*/', re.S)
# 选择器里带字面量颜色的规则（调色板预览球）——整块跳过，见 _snap 里的说明与审计 A24
PALETTE_RULE = re.compile(
    r'\[[a-zA-Z-]+\s*[~^$*|]?=\s*"#[0-9a-fA-F]{3,8}"\][^{}]*\{[^{}]*\}')
# var(--x, <回退值>) 里的回退值区间 —— 属 B5，整段跳过，见 _snap 里的说明
VAR_FALLBACK = re.compile(r'var\(\s*--[\w-]+\s*,([^()]*(?:\([^()]*\)[^()]*)*)\)')


def eol_of(raw):
    crlf = raw.count('\r\n')
    return crlf, raw.count('\n') - crlf


def rewrite(path):
    raw = open(path, encoding='utf-8', newline='').read()
    crlf, lf = eol_of(raw)
    if crlf and lf:
        return None, '行尾混用（CRLF=%d LF=%d），跳过；先用 --normalize-eol' % (crlf, lf)
    spans = [(m.start(), m.end()) for m in COMMENT_RE.finditer(raw)]

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


def color_sequence(text, defs):
    """[(属性名, (最终颜色序列))]，用于证明计算值不变。"""
    text = COMMENT_RE.sub('', text)
    seq = []
    pat = re.compile(r'var\((--t-[\w-]+)(?:,[^()]*(?:\([^()]*\)[^()]*)*)?\)'
                     r'|#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\)')
    for dm in DECL_RE.finditer(text):
        colors = []
        for cm in pat.finditer(dm.group(3)):
            colors.append(resolve(defs, defs.get(cm.group(1), '')) if cm.group(1)
                          else canon(cm.group(0)))
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


def _snap(path, apply_it, scale, want_prop, want_color):
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
            if not k or k[3] < 0.99 or not want_color(k) or in_palette(vs + cm.start()):
                continue
            best, bd = None, 1e9
            for name, rgb in scale:
                d = delta_e(k, rgb + (1.0,))
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
# 合成用的两种代表背景：插件表面刻度的两端
COMPOSITE_BACKDROPS = ((17, 17, 17), (51, 51, 51))
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
            seq = []
            for cm in re.finditer(r'var\((--t-[\w-]+)(?:,[^()]*)?\)'
                                  r'|#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\)', dm.group(3)):
                seq.append(resolve(defs, defs.get(cm.group(1), '')) if cm.group(1)
                           else canon(cm.group(0)))
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
    ap.add_argument('--snap-alpha', action='store_true',
                    help='把色族半透明色的 alpha 吸附到该族阶梯（会改色；之后必跑 --check-state）')
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

    if a.snap_text or a.snap_surface or a.snap_alpha:
        from collections import Counter
        fn = (snap_text if a.snap_text else
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
                              '（半透明色差已合成到 #111/#333 两种底上取上界）'
                              if a.snap_alpha else ''))
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
        bad = tot = 0
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
                    bad += 1
                    if bad <= 12:
                        print('  X %s  %s %s -> %s %s' % (p, pb, sb, pa, sa))
                else:
                    n += len(sb)
            print('%-42s %4d 个颜色位一致' % (p, n))
        print('\n共 %d 个颜色位，不一致 %d 处' % (tot, bad))
        if bad:
            sys.exit(1)
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
