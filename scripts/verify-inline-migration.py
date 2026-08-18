"""Phase 5b 迁移验证器 —— 断言「inline style 搬进 CSS 后计算值不变」。

为什么需要它：Phase 5a 只改值的写法（位置与特异性不动），可以用逐字节比对自证；
5b 改变的是「哪条规则命中该元素」，内联原本无条件压过一切，搬进 CSS 后可能被
更高特异性的既有规则夺走。本工具从改动前(git)与改动后(工作区)的**同一段标记**
自动抽取元素树，按位置对齐，再对每条原内联声明做层叠求解并比对。

用法：
  python scripts/verify-inline-migration.py <js文件> <起始标记> <结束标记> <挂载点> [before-ref]

  <挂载点>  该段标记被 append 到的祖先，形如 "t-box,t-root,#t-main-view"
  [before-ref]  默认 HEAD

例：
  python scripts/verify-inline-migration.py src/ui/mainWindow.js       'const recentHtml = recent.length' 'const $host = $("#t-main-view")'       "t-box,t-root,#t-main-view" bdc50c0

已知限制（都会如实报出，不会静默跳过）：
  * 元素数改变即报错退出 —— 按位置对齐要求 DOM 结构不变，这也是 5b 的纪律。
  * 只解析后代组合子；含 > + ~ :: [ 的选择器统计为「不支持」并打印条数，
    需另行筛查其末段能否命中本组件（见交接文档 §5b 的做法）。
  * 只比对无 @media 的桌面态，且跳过 :hover/:focus 等状态伪类。
  * class/id 里的 ${...} 插值按「去掉占位符保留静态前缀」处理；
    完全由插值决定的 token 会被丢弃（其值在验证期未知）。

  ⚠ 上面最后一条是**沉默的盲区**，不会报错也不会计入 checked：
    把 style="color: ${cond ? 'A' : 'B'}" 改成
    class="x ${cond ? 't-ok' : 't-bad'}" 时，整个类名都是插值 → 被丢弃 →
    该元素看起来「没带内联声明」而被跳过。凡本批用了三元表达式切类，
    必须另做手工核：枚举全库「声明了目标属性、且末段选择器能匹配该元素」
    的规则，再按祖先链筛。做法与一次实例见交接文档 §5b「5b-4 的三条经验」。
"""

import re
import sys
import io
import json
import subprocess
from collections import defaultdict

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

VOID = {'input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'area', 'col', 'embed', 'track', 'wbr'}
PH = '\x01'


def read_head(path):
    ref = sys.argv[5] if len(sys.argv) > 5 else 'HEAD'
    r = subprocess.run(['git', 'show', ref + ':' + path], capture_output=True)
    return r.stdout.decode('utf-8')


def strip_interp(s):
    out = []
    i = 0
    while i < len(s):
        if s[i] == '$' and i + 1 < len(s) and s[i + 1] == '{':
            d = 1
            j = i + 2
            while j < len(s) and d:
                if s[j] == '{':
                    d += 1
                elif s[j] == '}':
                    d -= 1
                j += 1
            out.append(PH)
            i = j
        else:
            out.append(s[i])
            i += 1
    return ''.join(out)


TAG = re.compile(r'<(/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^<>"]|"[^"]*")*?)(/?)>', re.S)


def attrs_of(raw):
    d = {}
    for m in re.finditer(r'([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"', raw):
        d[m.group(1).lower()] = m.group(2)
    return d


def parse(markup):
    els = []
    stack = []
    for m in TAG.finditer(markup):
        closing, tag, raw, selfclose = m.group(1), m.group(2).lower(), m.group(3), m.group(4)
        if closing:
            for k in range(len(stack) - 1, -1, -1):
                if stack[k][0] == tag:
                    del stack[k:]
                    break
            continue
        a = attrs_of(raw)
        # A class token may be partly interpolated, e.g. class="t-x${cond?' is-y':''}".
        # Strip the placeholder and keep the static prefix; drop tokens that are
        # entirely interpolated (their value is unknown at verify time).
        cls = []
        for c in a.get('class', '').split():
            c = c.replace(PH, '')
            if c:
                cls.append(c)
        eid = a.get('id', '').replace(PH, '')
        decls = {}
        for d in a.get('style', '').split(';'):
            if ':' not in d:
                continue
            k, v = d.split(':', 1)
            k = k.strip().lower()
            v = v.strip()
            if not k or PH in k or PH in v:
                continue
            decls[k] = v
        els.append({
            'tag': tag, 'cls': cls, 'id': eid, 'decls': decls,
            'chain': [(t, list(c), i) for t, c, i in stack],
            'path': '/'.join(t for t, _, _ in stack) + '/' + tag,
        })
        if not selfclose and tag not in VOID:
            stack.append((tag, cls, eid))
    return els


def load_rules():
    out = subprocess.run(
        ['node', '-e', "import('./css/manifest.js').then(m=>console.log(JSON.stringify(m.cssFileList())))"],
        capture_output=True, text=True).stdout
    files = json.loads(out)
    rules = []
    unsup = []
    order = 0
    for rel in files:
        src = re.sub(r'/\*.*?\*/', '', open('css/' + rel, encoding='utf-8').read(), flags=re.S)
        i = 0
        cond = []
        buf = ''
        while i < len(src):
            ch = src[i]
            if ch == '{':
                head = buf.strip()
                buf = ''
                if head.startswith('@'):
                    cond.append(head)
                    i += 1
                    continue
                d = 1
                j = i + 1
                while j < len(src) and d:
                    if src[j] == '{':
                        d += 1
                    elif src[j] == '}':
                        d -= 1
                    j += 1
                decls = {}
                for x in src[i + 1:j - 1].split(';'):
                    if ':' in x:
                        k, v = x.split(':', 1)
                        decls[k.strip().lower()] = v.strip()
                for sel in head.split(','):
                    sel = sel.strip()
                    if not sel:
                        continue
                    order += 1
                    if re.search(r'[>+~]|::|\[', sel):
                        unsup.append((sel, rel))
                    else:
                        rules.append((order, ' & '.join(cond), sel, decls, rel))
                i = j
                continue
            if ch == '}':
                if cond:
                    cond.pop()
                buf = ''
                i += 1
                continue
            buf += ch
            i += 1
    return rules, unsup


STATE_PSEUDO = {':hover', ':focus', ':active', ':disabled', ':checked', ':focus-within', ':focus-visible'}


def compound_ok(comp, el):
    tag, cls, eid = el
    m = re.match(r'^([a-zA-Z][a-zA-Z0-9]*)?(.*)$', comp)
    if m.group(1) and m.group(1).lower() != tag:
        return False
    for tok in re.findall(r'[.#][A-Za-z0-9_-]+|:[a-z-]+(?:\([^)]*\))?', m.group(2)):
        if tok[0] == '.':
            if tok[1:] not in cls:
                return False
        elif tok[0] == '#':
            if tok[1:] != eid:
                return False
        else:
            if tok in STATE_PSEUDO:
                return False
            if tok not in (':last-child', ':first-child', ':not(:disabled)'):
                return False
    return True


def matches(sel, chain):
    comps = sel.split()
    if not compound_ok(comps[-1], chain[-1]):
        return False

    def rec(ci, ei):
        if ci < 0:
            return True
        if ei < 0:
            return False
        if compound_ok(comps[ci], chain[ei]) and rec(ci - 1, ei - 1):
            return True
        return rec(ci, ei - 1)
    return rec(len(comps) - 2, len(chain) - 2)


def spec(sel):
    return (len(re.findall(r'#[A-Za-z0-9_-]+', sel)),
            len(re.findall(r'\.[A-Za-z0-9_-]+', sel)) + len(re.findall(r':(?!:)[a-z-]+', sel)),
            len(re.findall(r'(?:^|[\s>+~])([a-z][a-z0-9]*)', sel)))


def resolve(rules, chain, props):
    win = {}
    for o, cond, sel, decls, rel in rules:
        if cond:
            continue
        if not matches(sel, chain):
            continue
        s = spec(sel)
        for p in props:
            if p in decls:
                cur = win.get(p)
                if cur is None or (s, o) >= (cur[0], cur[1]):
                    win[p] = (s, o, decls[p], sel, rel)
    return win


def region(text, start_marker, end_marker):
    i = text.find(start_marker)
    if i < 0:
        raise SystemExit('start marker not found: %r' % start_marker)
    j = text.find(end_marker, i)
    if j < 0:
        raise SystemExit('end marker not found: %r' % end_marker)
    return text[i:j]


def main():
    path, start_marker, end_marker, mount = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    mcls = [x for x in mount.split(',') if x and not x.startswith('#')]
    mid = [x[1:] for x in mount.split(',') if x.startswith('#')]
    MOUNT = [('html', [], ''), ('body', [], ''), ('div', mcls, mid[0] if mid else '')]

    before = parse(strip_interp(region(read_head(path), start_marker, end_marker)))
    after = parse(strip_interp(region(open(path, encoding='utf-8').read(), start_marker, end_marker)))

    rules, unsup = load_rules()
    if len(before) != len(after):
        print('!! element count differs: before %d after %d -- DOM structure changed, '
              'positional alignment invalid' % (len(before), len(after)))
        raise SystemExit(1)
    n_inline = sum(1 for e in before if e['decls'])
    print('region: %d elements; %d carried inline style, %d declarations'
          % (len(before), n_inline, sum(len(e['decls']) for e in before)))

    bad = checked = kept = 0
    for e, ae in zip(before, after):
        if e['tag'] != ae['tag']:
            print('  !! tag mismatch at same position: %s vs %s' % (e['tag'], ae['tag']))
            bad += 1
            continue
        if not e['decls']:
            continue
        chain = MOUNT + [(t, c, i) for t, c, i in ae['chain']] + [(ae['tag'], ae['cls'], ae['id'])]
        win = resolve(rules, chain, list(e['decls'].keys()))
        for p, v in e['decls'].items():
            # 本批未迁、仍留在内联里的声明：只核值有没有变，不去 CSS 里找规则。
            # 没有这一步，部分迁移的区段会把所有未迁声明都报成 <no rule>。
            still = ae['decls'].get(p)
            if still is not None:
                if re.sub(r'\s+', '', still) != re.sub(r'\s+', '', v):
                    bad += 1
                    print('  X <%s class="%s" id="%s">  %s: 仍是内联但值变了 %r -> %r'
                          % (ae['tag'], ' '.join(ae['cls']), ae['id'], p, v, still))
                else:
                    kept += 1
                continue
            checked += 1
            g = win.get(p)
            gv = g[2] if g else '<no rule>'
            if re.sub(r'\s+', '', gv) != re.sub(r'\s+', '', v):
                bad += 1
                if bad <= 30:
                    tail = ('  <- %s @%s' % (g[3], g[4])) if g else ''
                    print('  X <%s class="%s" id="%s">  %s: was %r now %r%s'
                          % (ae['tag'], ' '.join(ae['cls']), ae['id'], p, v, gv, tail))
    print('\nchecked %d (element,property) pairs; mismatch %d' % (checked, bad))
    if kept:
        print('本批未迁、仍为内联且值未变: %d 对（不算已验证，只是本批不涉及）' % kept)
    print('unsupported selectors skipped: %d' % len(unsup))


main()
