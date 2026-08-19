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


def main():
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument('files', nargs='*')
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--verify', action='store_true')
    ap.add_argument('--report', action='store_true')
    ap.add_argument('--normalize-eol', action='store_true')
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
