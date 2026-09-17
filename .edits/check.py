"""Extract every <script> block from the chatroom and syntax-check it with Node.

The browser tells you a page is broken only by refusing to work; `node --check`
names the line. Run this after every edit.
"""
import io, os, re, subprocess, sys

NODE = r"C:\Program Files\Adobe\Adobe Photoshop 2026\node.exe"
HTML = 'mingus-chatroom.html'
OUT = os.path.join('.edits', '_extracted.js')

s = io.open(HTML, encoding='utf-8', newline='').read().replace('\r\n', '\n')

blocks = []
for m in re.finditer(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', s, re.S):
    # line number the block starts on, so Node's errors map back to the HTML
    line = s.count('\n', 0, m.start(1)) + 1
    blocks.append((line, m.group(1)))

if not blocks:
    print('no inline script blocks found')
    sys.exit(1)

# pad each block so reported line numbers match the HTML file exactly
parts, at = [], 1
for line, code in blocks:
    parts.append('\n' * (line - at))
    parts.append(code)
    at = line + code.count('\n')
io.open(OUT, 'w', encoding='utf-8', newline='\n').write(''.join(parts))

r = subprocess.run([NODE, '--check', OUT], capture_output=True, text=True)
if r.returncode == 0:
    total = sum(c.count('\n') for _, c in blocks)
    print('OK  %d inline script block(s), %d lines  — line numbers match %s'
          % (len(blocks), total, HTML))
else:
    print('SYNTAX ERROR (line numbers are %s line numbers):\n' % HTML)
    print(r.stdout or '', r.stderr or '')
# ---------------------------------------------------------------------------
# Top-level object globals referenced above their own declaration.
#
# This caught nothing the parser could: `var DN={...}` at the bottom of the
# file while startup read it 8000 lines earlier. A var hoists as undefined and
# its assignment runs where it is written, so the first read threw and took the
# whole page down - icon picker gone, nobody able to log in, and `node --check`
# perfectly happy the entire time.
#
# A reference above the declaration is only FATAL if it is evaluated during
# top-level execution, which this cannot know - so it warns and leaves the
# judgement to a human, or better, to actually loading the page.
# ---------------------------------------------------------------------------
import re as _re

def _early_global_refs(src):
    lines = src.split('\n')
    decls = {}
    for i, ln in enumerate(lines):
        m = _re.match(r'^var ([A-Za-z_$][\w$]*)\s*=\s*\{', ln)
        if m:
            decls.setdefault(m.group(1), i + 1)
    # Only top-level statements can run before the declaration does. Anything
    # indented is inside a function or block and will not have executed yet, so
    # flagging it is noise - and noise is how a warning gets ignored.
    out = []
    for name, dline in sorted(decls.items(), key=lambda kv: kv[1]):
        pat = _re.compile(r'(?<![\w$.])' + _re.escape(name) + r'\s*[.\[]')
        for i in range(dline - 1):
            ln = lines[i]
            if ln[:1] in (' ', '	'):            # not at top level
                continue
            bare = ln.strip()
            if bare.startswith(('*', '/*', '//')):  # a comment mentioning it
                continue
            if ('typeof ' + name) in ln:            # explicitly guarded
                continue
            if not pat.search(ln):
                continue
            out.append((name, dline, i + 1, bare[:72]))
            break
    return out

_warns = _early_global_refs(s)
if _warns:
    print('')
    print('WARN  object globals referenced above their own declaration:')
    for name, dline, uline, txt in _warns:
        print('      %-14s declared line %-6d first seen line %-6d  %s' % (name, dline, uline, txt))
    print('      Harmless if only read inside functions called later.')
    print('      FATAL if read during startup - load the page and check the console.')

sys.exit(r.returncode)
