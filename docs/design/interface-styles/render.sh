#!/bin/zsh
# Render every [data-frame] of each draft page to out/<draft>-<frame>.png at 2x.
# Usage: ./render.sh [riffet riffet-next]. A frame declares its size: data-frame="main" data-size="1440x900".
cd "${0:A:h}"
mkdir -p out
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
(( $# )) || set -- riffet riffet-next
for d in "$@"; do
  grep -o 'data-frame="[^"]*" data-size="[0-9x]*"' "pages/$d/index.html" | while read -r line; do
    name=$(echo $line | sed -E 's/.*data-frame="([^"]*)".*/\1/')
    size=$(echo $line | sed -E 's/.*data-size="([0-9x]*)".*/\1/' | tr x ,)
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
      --window-size=$size --virtual-time-budget=1500 \
      --screenshot="$PWD/out/$d-$name.png" "file://$PWD/pages/$d/index.html?only=$name" >/dev/null 2>&1
    echo "out/$d-$name.png"
  done
done
