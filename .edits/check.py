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
sys.exit(r.returncode)
