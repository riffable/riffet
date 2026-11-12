#!/bin/bash
# Regenerates Riffet/Resources/canvas-layout.js (the canvas's fold and layout, with the web's tool
# titles in zh-Hans and en) for CanvasLayoutEngine.
set -euo pipefail
cd "$(dirname "$0")/../../.."
node apps/macos/scripts/canvas-layout/build.mjs
