# Acknowledgements

Riffet.app includes the libraries below. Full license texts for the bundled libraries are in the app at `Contents/Resources/Licenses/`; the others are in their source repositories. The bundled server lists its npm packages, with their license texts, in `Contents/Resources/server/bin/THIRD_PARTY_NOTICES.md`.

<!-- Hand-maintained. apps/macos/scripts/check-acknowledgements.mjs (CI) fails when project.yml,
Package.resolved or RiffetKit's Kotlin dependencies contain a library this file does not list. -->

## Swift packages

| Library | Identity | Version | License | Source | Full text |
| --- | --- | --- | --- | --- | --- |
| SwiftTerm | `swiftterm` | Package.resolved | MIT | https://github.com/migueldeicaza/SwiftTerm | `Licenses/SwiftTerm.txt` |
| Sparkle | `sparkle` | Package.resolved | MIT; includes bsdiff (BSD-2-Clause), sais-lite (MIT) and ed25519 (Zlib) | https://github.com/sparkle-project/Sparkle | `Licenses/Sparkle.txt` |
| KeyboardShortcuts | `keyboardshortcuts` | Package.resolved | MIT | https://github.com/sindresorhus/KeyboardShortcuts | `Licenses/KeyboardShortcuts.txt` |
| Swift Markdown | `swift-markdown` | Package.resolved | Apache-2.0 | https://github.com/apple/swift-markdown | `Licenses/swift-markdown.txt` |
| swift-cmark | `swift-cmark` | Package.resolved | BSD-2-Clause; includes houdini, buffer and utf8proc code (MIT) | https://github.com/swiftlang/swift-cmark | `Licenses/swift-cmark.txt` |
| Swift Argument Parser | `swift-argument-parser` | Package.resolved | Apache-2.0 with Runtime Library Exception; SwiftTerm's tools only, not linked | https://github.com/apple/swift-argument-parser | — |
| swift-png | `swift-png` | Package.resolved | Apache-2.0; SwiftTerm on non-Apple platforms only, not linked | https://github.com/tayloraswift/swift-png | — |
| h | `h` | Package.resolved | Apache-2.0; swift-png dependency, not linked | https://github.com/rarestype/h | — |

## Kotlin libraries (RiffetKit)

| Library | Identity | Version | License | Source |
| --- | --- | --- | --- | --- |
| Kotlin standard library | `org.jetbrains.kotlin:kotlin-stdlib` | libs.versions.toml `kotlin` | Apache-2.0 | https://github.com/JetBrains/kotlin |
| kotlinx.coroutines | `org.jetbrains.kotlinx:kotlinx-coroutines-*` | libs.versions.toml `coroutines` | Apache-2.0 | https://github.com/Kotlin/kotlinx.coroutines |
| kotlinx.serialization | `org.jetbrains.kotlinx:kotlinx-serialization-*` | libs.versions.toml `serialization` | Apache-2.0 | https://github.com/Kotlin/kotlinx.serialization |
| Ktor | `io.ktor:*` | libs.versions.toml `ktor` | Apache-2.0 | https://github.com/ktorio/ktor |
| kotlinx-io | `org.jetbrains.kotlinx:kotlinx-io-*` | Ktor's dependency | Apache-2.0 | https://github.com/Kotlin/kotlinx-io |
| atomicfu | `org.jetbrains.kotlinx:atomicfu` | Ktor's dependency | Apache-2.0 | https://github.com/Kotlin/kotlinx-atomicfu |
| SKIE runtime | `co.touchlab.skie:runtime-*` | libs.versions.toml `skie` | Apache-2.0 | https://github.com/touchlab/SKIE |

## Other

| Library | Identity | Version | License | Source | Full text |
| --- | --- | --- | --- | --- | --- |
| refractor and its dependencies, in `highlight.js` | `refractor` | package.json | MIT | https://github.com/wooorm/refractor | `Licenses/refractor.txt` |
| Inter (variable) | `Fonts/InterVariable.ttf` | 4.1 | OFL-1.1 | https://github.com/rsms/inter | `Licenses/Inter.txt` |
| JetBrains Mono (variable) | `Fonts/JetBrainsMono-Variable.ttf` | 2.304 | OFL-1.1 | https://github.com/JetBrains/JetBrainsMono | `Licenses/JetBrainsMono.txt` |
| Lucide icons, in `Icons.xcassets` | `lucide-react` | package.json | ISC | https://github.com/lucide-icons/lucide | `Licenses/lucide.txt` |
| Heroicons, in `Icons.xcassets/web` | `@heroicons/react` | package.json | MIT | https://github.com/tailwindlabs/heroicons | `Licenses/heroicons.txt` |
| Phosphor Icons, in `Icons.xcassets` | `@phosphor-icons/react` | package.json | MIT | https://github.com/phosphor-icons/react | `Licenses/phosphor.txt` |
| Tabler Icons, in `Icons.xcassets/tabler` | `tabler-icons` | 3.35.0 | MIT | https://github.com/tabler/tabler-icons | `Licenses/tabler.txt` |
| Material Symbols, in `Icons.xcassets/material-symbols` | `material-symbols` | apps/mobile/shared/NOTICE | Apache-2.0 | https://github.com/google/material-design-icons | `Licenses/material-symbols.txt` |
| Fluent System Icons, in `Icons.xcassets/fluent` | `@fluentui/svg-icons` | 1.1.345 | MIT | https://github.com/microsoft/fluentui-system-icons | `Licenses/fluent.txt` |
| Octicons, in `Icons.xcassets/octicons` | `@primer/octicons` | 19.42.0 | MIT | https://github.com/primer/octicons | `Licenses/octicons.txt` |
| Material Design Icons, in `Icons.xcassets/mdi` | `@mdi/svg` | 7.4.47 | Pictogrammers Free License (Apache-2.0) | https://github.com/Templarian/MaterialDesign | `Licenses/mdi.txt` |
| Remix Icon, in `Icons.xcassets/remix` | `remixicon` | 4.6.0 | Apache-2.0 | https://github.com/Remix-Design/RemixIcon | `Licenses/remix.txt` |
