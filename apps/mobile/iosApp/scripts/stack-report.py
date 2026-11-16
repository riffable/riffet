#!/usr/bin/env python3
"""Main-thread stack budget of a Debug build of the iPhone app (docs/design/system/ios.md §2.0).

    python3 apps/mobile/iosApp/scripts/stack-report.py <Riffet.app/Riffet> [--top N]

Reports the app's largest stack frames (a Debug build keeps every temporary of a view body on the
stack) and the deepest view types (SwiftUI resolves a page's whole type recursively on first display).
Exits 1 when a frame or a type is over the limits below. A simulator build reads the same as a device one.
"""
import re
import subprocess
import sys

FRAME_LIMIT = 64 * 1024
DEPTH_LIMIT = 26
# One-shot set-up that never runs inside a view body: theme catalogue, terminal colours.
FRAME_EXEMPT = re.compile(r'one-time initialization|IOSTerminal|RiffetPaletteValues\.init|ThemeStore')


def demangle(names):
    out = subprocess.run(['xcrun', 'swift-demangle', '--simplified'], input='\n'.join(names), capture_output=True, text=True)
    return out.stdout.splitlines()


def frames(binary):
    dis = subprocess.run(['xcrun', 'llvm-objdump', '-d', '--no-show-raw-insn', binary], capture_output=True, text=True).stdout
    sizes, current = {}, None
    for line in dis.splitlines():
        head = re.match(r'^[0-9a-f]+ <(.+)>:', line)
        if head:
            current = head.group(1) if head.group(1).startswith('_$s6Riffet') else None
            continue
        if current:
            sub = re.search(r'\bsub\s+sp, sp, #(0x[0-9a-f]+|\d+)(, lsl #12)?', line)
            if sub:
                sizes[current] = sizes.get(current, 0) + int(sub.group(1), 0) * (4096 if sub.group(2) else 1)
    rows = sorted(sizes.items(), key=lambda row: -row[1])[:200]
    return [(size, name) for (_, size), name in zip(rows, demangle([symbol for symbol, _ in rows]))]


def depths(binary):
    listing = [line.split()[-1] for line in subprocess.run(['nm', binary], capture_output=True, text=True).stdout.splitlines() if line.strip()]
    symbols = [symbol for symbol in listing if symbol.endswith('MR')]
    # The app's own view types, to name the page a deep type belongs to.
    ours = set()
    for symbol in listing:
        match = re.match(r'_\$s6Riffet(\d+)', symbol)
        if match and symbol.endswith('VMn'):
            ours.add(symbol[match.end():match.end() + int(match.group(1))])
    rows = []
    for name in demangle(symbols):
        level = deepest = 0
        for char in name:
            if char == '<':
                level += 1
                deepest = max(deepest, level)
            elif char == '>':
                level -= 1
        owner = next((word for word in re.findall(r'[A-Za-z_]\w*', name) if word in ours), '?')
        rows.append((deepest, owner))
    return sorted(set(rows), key=lambda row: -row[0])


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    binary = sys.argv[1]
    top = int(sys.argv[sys.argv.index('--top') + 1]) if '--top' in sys.argv else 15
    failed = False

    print('Largest stack frames')
    for size, name in frames(binary)[:top]:
        over = size > FRAME_LIMIT and not FRAME_EXEMPT.search(name)
        failed |= over
        print(f'  {size // 1024:5d} KB{"  over" if over else ""}  {name[:150]}')

    print('Deepest view types')
    for depth, owner in depths(binary)[:top]:
        over = depth > DEPTH_LIMIT
        failed |= over
        print(f'  {depth:5d}{"  over" if over else ""}  {owner}')

    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
