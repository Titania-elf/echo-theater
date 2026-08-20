# -*- coding: utf-8 -*-
r"""从 theme-dark.css + primitives.css 推导出 theme-light.css。

为什么用生成器而不是手写 200 个值
--------------------------------
浅色主题要决定的量是 35 个原语 + 约 130 个族三元组 + 37 个语义整色/渐变/阴影配方。
手写会做成「200 个互不相关的拍脑袋值」，没人能复核，也无法回答「为什么这个是这样」。
写成规则则有三个好处：
  ① 规则本身可复核（下面每条都写了理由）
  ② 深色主题日后加 token，重跑一次就跟上，不会漏
  ③ 出问题时改的是**一条规则**，不是几十个值

推导规则
--------
R-A 阶梯（中性 / 冷调 / 奶油 / 暖底）：**在 Lab 里翻转 L\***（L → 100−L），保留 a/b。
    保留 a/b 是关键：中性阶 a=b=0，翻转即纯灰镜像；冷调阶带蓝味、暖底带黄味，
    翻转 L 而不动 a/b 能把「冷/暖的性格」原样搬到浅色主题，只反转明暗。
    直接按索引镜像（neutral-i ← neutral-(13-i)）也能得到中性阶的结果，但对冷调阶
    会连色偏一起换掉，故统一用 L 翻转。

R-B 强调色：保留 Lab 的**色相角与彩度**，仅把 L 压到 [38, 55]。
    只有 L>60 的才压（深色主题里的强调色多在 L 65~90，白底上对比度不足）；
    本来就暗的（大纲按钮的 #30a6ad L~60、暗底一族）保持不动。
    保留色相角 = 「蓝还是蓝、金还是金」，九个图标的身份不会串。
    ⚠ 这会让同族内「亮/暗」两档的顺序**反转**（azure L66→34、azure-light L74→26）。
      那是对的：深色主题里 -light 是给文字用的更亮版，白底上文字需要的恰是更暗版。

R-C 压暗类叠加（rgb(0 0 0 / α)）：**保持黑，不变**。
    -recess / -scrim / -dialog-scrim 在两种主题下都是「压暗」，白底上黑色低透明度
    就是浅灰，语义与观感都成立。翻成白色反而会让凹陷变成凸起。

R-D 阴影：保持黑，**alpha × 0.55**。
    浅色主题下同样的黑投影会显得脏重 —— 这是浅色主题最常见的翻车点。
    ⚠ 只有这一条改了 alpha。其余规则一律不动 alpha（alpha 不随主题变，是
      Phase 6b-12 那个决定的前提）。

R-E 白色内高光（--t-shadow-inset-*）：保持白，alpha × 0.7。
    它模拟的是「光从上方来」的物理高光，两种主题下都是白的，只需减弱。

例外（EXCEPTIONS）
-----------------
三个语义 token 无法靠原语翻转得到正确结果 —— 它们与另一个语义 token 共用原语，
但浅色主题下需要的目标不同。实测冲突只有这三个，全在中性阶上。
"""
import io
import os
import re
import sys
import importlib.util

spec = importlib.util.spec_from_file_location('ct', 'scripts/color-tokenize.py')
ct = importlib.util.module_from_spec(spec)
sys.argv = ['x', '--help']
spec.loader.exec_module(ct)

TOK = 'css/00-tokens'
OUT = os.path.join(TOK, 'theme-light.css')


# ── Lab 往返 ──────────────────────────────────────────────────────────
def _inv_lin(c):
    return 12.92 * c if c <= .0031308 else 1.055 * (c ** (1 / 2.4)) - .055


def lab_to_rgb_raw(L, a, b):
    """不钳位，返回浮点 0..1 三元组 —— 用于判断是否超出 sRGB 色域。"""
    fy = (L + 16) / 116.0
    fx, fz = fy + a / 500.0, fy - b / 200.0

    def g(t):
        return t ** 3 if t ** 3 > .008856 else (t - 16 / 116.0) / 7.787
    x, y, z = g(fx) * .95047, g(fy), g(fz) * 1.08883
    return (x * 3.2406 + y * -1.5372 + z * -.4986,
            x * -.9689 + y * 1.8758 + z * .0415,
            x * .0557 + y * -.2040 + z * 1.0570)


def lab_to_rgb(L, a, b):
    """Lab -> sRGB。**超出色域时按比例降彩度**，而不是逐通道钳位。

    ⚠ 这一步是必需的。第一版直接钳通道，结果 --t-accent-azure(L66→34) 与
      -azure-light(L74→26) 都因 R 通道钳到 0 而变成 `0 92 180` / `0 94 156` ——
      同族「亮/暗」两档几乎撞在一起，区分丢了。深色主题里的强调色彩度很高，
      压低 L 后大量落在 sRGB 之外，钳位会把不同的颜色压成同一个。
      按比例降彩度能保住**色相角**与**两档之间的明度差**，只牺牲一点鲜艳度。
    """
    for i in range(41):
        s = 1.0 - i * 0.025
        lin = lab_to_rgb_raw(L, a * s, b * s)
        if all(-0.0005 <= v <= 1.0005 for v in lin):
            break
    return tuple(max(0, min(255, int(round(_inv_lin(max(0.0, v)) * 255)))) for v in lin)


def flip_L(rgb):
    """R-A：翻转 L*，保留 a/b。"""
    L, a, b = ct._lab(rgb)
    return lab_to_rgb(100.0 - L, a, b)


LIGHT_BG = (239, 239, 239)   # = 生成后的 --t-c-neutral-0（页面/窗口底）


def _rel_lum(c):
    def f(v):
        v /= 255.0
        return v / 12.92 if v <= .03928 else ((v + .055) / 1.055) ** 2.4
    return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2])


def contrast(a, b):
    la, lb = _rel_lum(a), _rel_lum(b)
    return (max(la, lb) + .05) / (min(la, lb) + .05)


def darken_accent(rgb):
    """R-B：保色相与彩度，把 L 从深色区间 [60,100] **线性压缩**到 [55,30]。

    ⚠ 这条规则试过三个版本，前两个都因为「瞄准固定目标」而把同族兄弟压成一个值：
        ① clamp(100−L, 38, 55)：azure(L66) 与 azure-light(L74) 的 100−L 是 34 与 26，
           **双双被钳到 38**，ΔE 从 12.5 掉到 0.9。
        ② 二分到「刚好 4.5:1 对比度」：把不同明度的兄弟一起推到同一个亮度上 ——
           azure-light ↔ azure-mid 从 ΔE 12.5 塌到 **0.1**，另有 4 对同类塌陷。
      教训：**瞄准一个固定目标值本身就是收敛器**，无论目标是 L 还是对比度。
      线性压缩保持单调与间距，实测 0 对真塌陷。

    代价是有些暖色系达不到 4.5:1（品牌金 3.9、危险红 3.6、调试橙 4.4）——
    因为 Lab 的 L 与 WCAG 亮度不是一回事，同一个 L 上黄色系的实际对比度更低。
    这些**不静默强制**，由生成器末尾的对比度报告列出来交人决定：
    压暖色系会同时破坏它与同族兄弟的关系，是设计取舍，不该由脚本替人做。
    """
    L, a, b = ct._lab(rgb)
    if L <= 60:
        return rgb                       # 本来就够暗（大纲按钮、各种暗底）
    nL = 55.0 - (L - 60.0) * (55.0 - 30.0) / 40.0
    return lab_to_rgb(nL, a, b)


# ── 分类：token 名 -> 规则 ────────────────────────────────────────────
LADDER = re.compile(r'^--t-(c-neutral|c-cool|cream|warm-surface)-\d+-rgb$')
ACCENT_TRIPLE = re.compile(r'^--t-(accent|sky-text|glass|surface|c)-[\w-]*rgb$')
KEEP_BLACK = re.compile(r'^--t-(color-surface-recess|color-scrim|color-dialog-scrim|scrim)')
SHADOW = re.compile(r'^--t-shadow-')

# 三个必须单独给值的语义 token。理由见文件头「例外」。
EXCEPTIONS = {
    '--t-color-text-on-accent': (
        'rgb(255 255 255)',
        '压在强调色按钮**上面**的文字。深色主题里它是近黑(#121212)，因为那时强调色\n'
        '       很亮(L 75~90)；浅色主题按 R-B 把强调色压暗到 L 30~55 之后，压在上面的\n'
        '       字必须**翻成白色**。\n'
        '       ⚠ 这个例外一开始写反了（也给了深色值）—— 因为「深色主题用深色字」看着\n'
        '         像个不变量，其实它是「强调色亮」的推论，前提在浅色主题下正好反过来。\n'
        '       它与 --t-color-bg 共用 --t-c-neutral-0，故必须单独覆盖。16 处消费者。'),
    '--t-color-surface-high': (
        'rgb(233 235 238)',
        '与 --t-color-border(66 处) 共用 --t-c-neutral-5。翻转后描边得到中灰\n'
        '       （白底上正好），但表面需要的是**浅灰**，两者目标不同，故单独给值。'),
    '--t-color-surface-hover-solid': (
        'rgb(224 227 232)',
        '与 --t-color-border-strong(42 处) 共用 --t-c-neutral-7，同上。'),
}


def parse_decls(path):
    """[(token名, 值)]，注释已剥掉。"""
    src = re.sub(r'/\*.*?\*/', '', open(path, encoding='utf-8').read(), flags=re.S)
    return [(m.group(1), m.group(2).strip())
            for m in re.finditer(r'(--t-[\w-]+)\s*:\s*([^;]+);', src)]


def emit_rgb(t):
    return '%d %d %d' % t


def transform_value(name, val):
    """把一条深色主题的值转成浅色主题的值；返回 None 表示无需覆盖。"""
    triple = re.match(r'^(\d+)\s+(\d+)\s+(\d+)$', val)
    if triple:
        rgb = tuple(int(x) for x in triple.groups())
        if LADDER.match(name):
            return emit_rgb(flip_L(rgb)), 'R-A'
        if name.startswith('--t-scrim-'):
            return None, None                     # R-C：黑蒙层不动
        if name == '--t-text-white-rgb':
            return emit_rgb((0, 0, 0)), 'R-C'     # 白字叠加 -> 黑字叠加
        if re.match(r'^--t-surface-\w*-?rgb$', name) or name.startswith('--t-glass-'):
            return emit_rgb(flip_L(rgb)), 'R-A'
        return emit_rgb(darken_accent(rgb)), 'R-B'

    if SHADOW.match(name):
        def f(m):
            a = float(m.group(1))
            return '/ %.3f' % (a * (0.7 if 'inset' in name else 0.55))
        return re.sub(r'/\s*([\d.]+)', f, val), ('R-E' if 'inset' in name else 'R-D')

    if KEEP_BLACK.match(name):
        return None, None

    # 其余：把值里的每个颜色字面量按「阶梯」处理（这些是窗口底/面板底/文字等）
    out, last, rule = [], 0, None
    for m in ct.COLOR_RE.finditer(val):
        k = ct.canon(m.group(0))
        if not k:
            continue
        rgb = flip_L(k[:3]) if 'text' in name or 'surface' in name or 'header' in name \
            or 'field' in name or 'nav' in name or 'dialog-surface' in name \
            else darken_accent(k[:3])
        rule = 'R-A' if rgb != darken_accent(k[:3]) or 'text' in name else 'R-B'
        out.append(val[last:m.start()])
        out.append('rgb(%s%s)' % (emit_rgb(rgb),
                                  '' if k[3] >= 0.999 else ' / %s' % ct.fmt_a(k[3])))
        last = m.end()
    if not out:
        return None, None
    out.append(val[last:])
    return ''.join(out), rule


HEADER = '''/* ============================================================
   00-tokens/theme-light.css —— 浅色主题

   ⚠ 本文件由 `python scripts/gen-theme-light.py` 生成，**不要手改**。
     要调整就改生成器里的规则或 EXCEPTIONS 表，然后重跑。
     手改会在下次重跑时被覆盖，而且会让「规则」与「结果」不一致、无法复核。

   为什么用生成器：浅色主题要决定 %d 个量。手写会做成一堆互不相关的拍脑袋值，
   没人能复核，也回答不了「为什么这个是这样」。写成规则则：规则本身可复核、
   深色主题日后加 token 重跑就跟上、出问题改的是一条规则而不是几十个值。

   推导规则（详见生成器文件头）：
     R-A 阶梯类  在 Lab 里翻转 L*（L → 100−L），**保留 a/b**
                 —— 中性阶得到纯灰镜像；冷调/暖底/奶油阶保留冷暖性格，只反转明暗
     R-B 强调色  保留色相角与彩度，把 L 从 [60,100] **线性压缩**到 [55,30]
                 —— 九个图标的身份色不会串；同族「亮/暗」两档顺序会反转，那是对的
                 ⚠ 必须是压缩、不能瞄准固定目标：clamp 到某个 L、或二分到「刚好
                   4.5:1 对比度」，两种写法都会把同族兄弟推到同一个值上（实测
                   分别塌陷 1 对与 5 对）。**瞄准固定目标本身就是收敛器。**
     R-C 压暗叠加 保持黑不变 —— 白底上黑色低透明度就是浅灰，翻成白会让凹陷变凸起
     R-D 阴影    保持黑，alpha × 0.55 —— 同样的黑投影在浅底上显得脏重
     R-E 内高光  保持白，alpha × 0.7 —— 它模拟「光从上方来」，两种主题下都是白的

   ⚠ 只有 R-D / R-E 改了 alpha。其余一律不动 —— 「alpha 不随主题变」是
     Phase 6b-12 那个「token 只存色相」决定的前提。

   生成器末尾跑两个自检，两个都是必需的：
     · 同族塌陷检查 —— 深色下可辨的同族两档，浅色下必须仍可辨。
       浅色主题是**新增**的值，没有「原值」可比，所以「计算值不变」那套自证在这里
       完全失效，只能拿「同族相对关系」当不变量。R-B 的两次 bug 都是它抓出来的。
     · 对比度检查 —— 文字类 token 对浅色窗口底若不足 4.5:1 就列出来，
       但**不自动压暗**：压了会破坏它与同族兄弟的关系，属设计取舍，
       不该由脚本替人做。当前有 %d 个偏低，多数是暖色系（Lab 的 L 与 WCAG 亮度
       不是一回事，同一个 L 上黄红系的实际对比度更低）。
       ⚠ 这个数字由生成器实时代入，不是写死的 —— 它依赖 04-features 里各 token
         的**实际消费角色**统计，6b 的每一批改色都会让它变（曾经写死 25，
         几批之后实际已是 26）。生成物里写死会变的数字，下次重跑就是错的。

   作用域：`:root[data-t-theme="light"]`，由 src/ui/settingsWindow.js 的
   applyUITheme() 写到 documentElement 上。必须排在 theme-dark.css **之后**
   （见 css/manifest.js），否则同优先级下先声明的会被覆盖。
   ============================================================ */
:root[data-t-theme="light"] {
'''


def main():
    prim = parse_decls(os.path.join(TOK, 'primitives.css'))
    dark = parse_decls(os.path.join(TOK, 'theme-dark.css'))
    rows, skipped, by_rule = [], [], {}
    seen = set()
    for name, val in prim + dark:
        if name in seen:
            continue
        seen.add(name)
        if 'var(' in val:
            continue                       # 派生 token，自动跟随
        if name in EXCEPTIONS:
            continue                       # 例外单独输出
        if not ct.COLOR_RE.search(val) and not re.match(r'^\d+\s+\d+\s+\d+$', val):
            continue                       # 不是颜色（圆角/时长/字体等）
        new, rule = transform_value(name, val)
        if new is None:
            skipped.append(name)
            continue
        rows.append((name, new, rule, val))
        by_rule[rule] = by_rule.get(rule, 0) + 1

    # ⚠ 低对比度清单必须在**写文件之前**算出来：HEADER 里要代入它的个数。
    #   写死那个数字会随 04-features 的角色统计漂移（曾写死 25，几批后已是 26）。
    low = contrast_low(rows)

    with io.open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(HEADER % (len(rows) + len(EXCEPTIONS), len(low)))
        f.write('    /* ---- 例外：与另一个语义 token 共用原语、但浅色主题下目标不同 ----\n'
                '       实测冲突只有这三处，全在中性阶上。 */\n')
        for name, (val, why) in EXCEPTIONS.items():
            f.write('    %s: %s;\n    /* %s */\n' % (name, val, why))
        last = None
        for name, new, rule, old in rows:
            grp = rule
            if grp != last:
                f.write('\n    /* ---- 规则 %s ---- */\n' % grp)
                last = grp
            f.write('    %s: %s;   /* 深色: %s */\n' % (name, new, old))
        f.write('}\n')

    print('生成 %s' % OUT)
    print('  覆盖 %d 条（含 %d 条例外）' % (len(rows) + len(EXCEPTIONS), len(EXCEPTIONS)))
    for r, n in sorted(by_rule.items()):
        print('    %-4s %3d 条' % (r, n))
    print('  按 R-C 保持不变、不输出：%d 条（%s）'
          % (len(skipped), ' '.join(skipped[:6]) + (' …' if len(skipped) > 6 else '')))
    check_collapse(rows)
    check_contrast(low)


def text_role_tokens():
    """真正用在 color: 上的 token 名集合（用于对比度报告的筛选）。

    必须按**实际消费角色**筛，不能按名字猜：--t-c-neutral-2-rgb 名字里没有
    "surface" 字样却是表面色，按名字筛会把十几个表面原语当成文字报低对比度。
    """
    out = set()
    prim_of = {}
    defs = ct.token_defs()
    for n, v in defs.items():
        for m in re.finditer(r'var\((--t-[\w-]+)\)', v):
            prim_of.setdefault(m.group(1), set()).add(n)
    role_cnt = {}
    for d in ('css/01-base', 'css/02-components', 'css/03-layout', 'css/04-features'):
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith('.css'):
                continue
            raw = ct.COMMENT_RE.sub(' ', open(os.path.join(d, fn), encoding='utf-8').read())
            for dm in re.finditer(r'([-a-zA-Z]+)\s*:\s*([^;{}]*)', raw):
                r = ct.role_of(dm.group(1))
                for m in re.finditer(r'var\((--t-[\w-]+)', dm.group(2)):
                    role_cnt.setdefault(m.group(1), {}).setdefault(r, 0)
                    role_cnt[m.group(1)][r] += 1
    for tok, rc in role_cnt.items():
        rc = {k: v for k, v in rc.items() if k in ('surface', 'border', 'text')}
        if rc and max(rc, key=rc.get) == 'text':
            out.add(tok)
            for p in re.finditer(r'var\((--t-[\w-]+)\)', defs.get(tok, '')):
                out.add(p.group(1))
    return out


def contrast_low(rows):
    """文字类 token 里对浅色窗口底不足 4.5:1 的那些，返回 [(token, rgb, 对比度)]。

    与 check_contrast 分开是因为 HEADER 里要代入它的**个数**，而 HEADER 在写文件
    时就要成型 —— 所以计算与打印必须可以分两次调用。
    """
    texts = text_role_tokens()
    low = []
    for name, new, rule, old in rows:
        m = re.match(r'^(\d+)\s+(\d+)\s+(\d+)$', new)
        if not m or name not in texts:
            continue
        v = tuple(int(x) for x in m.groups())
        c = contrast(v, LIGHT_BG)
        if c < 4.5:
            low.append((name, v, c))
    return low


def check_contrast(low):
    """报告文字类 token 在浅色窗口底上的对比度是否达 4.5:1。只报告，不强制。"""
    print('  对比度检查（文字类 token 对浅色窗口底 %s）：' % (LIGHT_BG,))
    if not low:
        print('    OK：全部达 4.5:1')
        return
    print('    %d 个低于 4.5:1 —— **刻意不自动压暗**（压了会破坏它与同族兄弟的关系，'
          '属设计取舍）：' % len(low))
    for name, v, c in sorted(low, key=lambda x: x[2]):
        print('    %-42s %-14s %.2f:1' % (name, str(v), c))


def check_collapse(rows):
    """浅色主题版的 --check-state：深色下能分辨的两个 token，浅色下不能塌陷。

    ⚠ 这个检查是必需的，不是锦上添花。生成器的两处 bug 都是靠它暴露的：
      ① 逐通道钳位把 azure / azure-light 压成 ΔE 0.9
      ② clamp(100−L, 38, 55) 把同族两档双双钳到 L38
      两者在深色主题下毫无痕迹，审计与「计算值不变」自证也都看不见 ——
      因为浅色主题是**新增**的值，没有「原值」可比。只能拿「同族相对关系」当不变量。
    """
    vals = {}
    for name, new, rule, old in rows:
        t = re.match(r'^(\d+)\s+(\d+)\s+(\d+)$', new)
        o = re.match(r'^(\d+)\s+(\d+)\s+(\d+)$', old)
        if t and o:
            vals[name] = (tuple(int(x) for x in o.groups()),
                          tuple(int(x) for x in t.groups()))
    names = sorted(vals)
    bad = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            # 只比同族（token 名去掉尾部修饰后前缀相同），跨族撞色无所谓
            pa = re.sub(r'-(rgb)$', '', a).rsplit('-', 1)[0]
            pb = re.sub(r'-(rgb)$', '', b).rsplit('-', 1)[0]
            if pa != pb:
                continue
            d0 = ct.delta_e(vals[a][0] + (1.,), vals[b][0] + (1.,))
            d1 = ct.delta_e(vals[a][1] + (1.,), vals[b][1] + (1.,))
            if d0 >= 2.0 and d1 < 2.0:
                bad.append((a, b, d0, d1))
    print('  同族塌陷检查：比对 %d 个三元组' % len(names))
    # ⚠ 按深色侧的 ΔE 分级，否则报告不可执行 —— 与 --check-state 同一条经验：
    #   深色侧本来就只差 ΔE 2~3 的两档，浅色侧掉到 1.8 不是回归，是「本就不可辨」。
    real = [x for x in bad if x[2] >= 3.0]
    marginal = [x for x in bad if x[2] < 3.0]
    for a, b, d0, d1 in sorted(real, key=lambda x: x[3]):
        print('    ✗✗ %s ↔ %s   深色 ΔE %.1f -> 浅色 ΔE %.1f  （真塌陷，需处理）'
              % (a, b, d0, d1))
    for a, b, d0, d1 in sorted(marginal, key=lambda x: x[3]):
        print('    ◦  %s ↔ %s   深色 ΔE %.1f -> 浅色 ΔE %.1f  （深色侧本就不可辨，非回归）'
              % (a, b, d0, d1))
    if not real:
        print('    OK：无真塌陷（深色下可辨的同族两档，浅色下仍可辨）')
    else:
        print('    共 %d 对真塌陷 —— 需调整规则或给例外' % len(real))


main()

