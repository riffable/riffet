# Third-party notices

Riffet for iOS includes the third-party software below. Full license texts for the Swift
packages ship in the app's `Licenses/` folder; the others are in the upstream repositories
at the listed addresses. Transitive dependencies not listed here are documented in each
library's published artifacts.

## Swift packages

| Library | License | Source |
| --- | --- | --- |
| SwiftTerm | MIT | https://github.com/migueldeicaza/SwiftTerm |
| Swift Markdown | Apache-2.0 | https://github.com/apple/swift-markdown |
| swift-cmark (Swift Markdown's parser) | BSD-2-Clause; includes MIT-licensed houdini, buffer and utf8proc code | https://github.com/swiftlang/swift-cmark |

## Kotlin and Compose libraries in RiffetKit

RiffetKit is Riffet's own Kotlin framework. It links the following third-party libraries.

| Library | License | Source |
| --- | --- | --- |
| Kotlin standard library | Apache-2.0 | https://github.com/JetBrains/kotlin |
| kotlinx.coroutines | Apache-2.0 | https://github.com/Kotlin/kotlinx.coroutines |
| kotlinx.serialization | Apache-2.0 | https://github.com/Kotlin/kotlinx.serialization |
| Ktor client (Darwin engine) | Apache-2.0 | https://github.com/ktorio/ktor |
| kotlinx-io (Ktor dependency) | Apache-2.0 | https://github.com/Kotlin/kotlinx-io |
| atomicfu (Ktor dependency) | Apache-2.0 | https://github.com/Kotlin/kotlinx-atomicfu |
| Compose Multiplatform (runtime, ui, foundation, material3) | Apache-2.0 | https://github.com/JetBrains/compose-multiplatform |
| Skiko (Compose Multiplatform rendering backend) | Apache-2.0 | https://github.com/JetBrains/skiko |
| multiplatform-markdown-renderer | Apache-2.0 | https://github.com/mikepenz/multiplatform-markdown-renderer |
| JetBrains Markdown parser (markdown-renderer dependency) | Apache-2.0 | https://github.com/JetBrains/markdown |
| kotlinx-collections-immutable (markdown-renderer dependency) | Apache-2.0 | https://github.com/Kotlin/kotlinx.collections.immutable |
| Coil 3 (coil-compose, coil-network-ktor3) | Apache-2.0 | https://github.com/coil-kt/coil |
| Okio (Coil dependency) | Apache-2.0 | https://github.com/square/okio |
| SKIE runtime | Apache-2.0 | https://github.com/touchlab/SKIE |

## Bundled JavaScript

| Component | License | Source |
| --- | --- | --- |
| highlight.js (refractor and its dependencies) | MIT | https://github.com/wooorm/refractor |

The full refractor text is in `Licenses/refractor.txt`; the bundle also keeps the upstream
legal comments.

## Vendored assets and ported code

| Component | License | Source |
| --- | --- | --- |
| Termux terminal-emulator (VT engine ported to Kotlin) | Apache-2.0 | https://github.com/termux/termux-app |
| Material Symbols (icon paths) | Apache-2.0 | https://fonts.google.com/icons |
| Lucide (star icon) | ISC | https://lucide.dev |

The Material Symbols text is in `Licenses/material-symbols.txt`; notices for the ported
terminal engine are in `Licenses/termux.txt`; Riffet's own Apache-2.0 license and NOTICE
are in `Licenses/Apache-2.0.txt` and `Licenses/NOTICE.txt`.
