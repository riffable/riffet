#!/bin/bash
# Regenerates Riffet/Resources/highlight.js (refractor + the web preview's grammars) for CodeHighlighter.
set -euo pipefail
cd "$(dirname "$0")/../../.."
node_modules/.bin/esbuild apps/macos/scripts/highlighter/entry.mjs --bundle --minify --format=iife --platform=neutral --main-fields=module,main --legal-comments=eof --outfile=apps/macos/Riffet/Resources/highlight.js
