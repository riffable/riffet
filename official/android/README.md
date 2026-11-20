Build, run and observe Android projects in Riffet without Android Studio's Sync and indexing. The host runs the tasks (logs, cancellation, artifacts, recovery after a restart); the first run plan for an installed package still needs confirmation.

## Before you start

- The project has a Gradle build at its root or one or two levels below. App modules come from `include` in settings, the build scripts and the `output-metadata.json` of existing build outputs (projects that add modules through a settings plugin are detected too). Variant and applicationId prefer the values recorded in the outputs, then `buildTypes` and `productFlavors`.
- With several devices, the one in `ANDROID_SERIAL` is used.

## Usage

- The Settings tab shows whether adb and a JDK were found, connected devices, and recent build tasks.
- Android view: Run (build, install and launch, like Android Studio's Run), Build APK (package only), Unit Tests, Lint, Clean, Crashes, Screenshot. Gradle tasks share one lock.
- Configs view: the project's Android Studio run configurations (`.run/*.run.xml`, `.idea/runConfigurations`, `.idea/workspace.xml`), grouped by Studio folder. Shell Script and Gradle configurations are supported and run the way Studio runs them.
- Logcat view: follows the app by pid and switches to the new process after a restart. It is a view of its own, so following the log does not lock the build buttons. Time, pid, tid, tag, level and message are columns; filters use Android Studio's syntax: `tag:Foo`, `-tag:Bar`, `tag~:regex`, `level:W` (W and above), plain words search the message. Clicking a tag or other column adds it as a filter; Option-click excludes it.
- Diagnostics: Kotlin, javac, AAPT, Gradle summary, Lint, failed unit tests and app crashes (with Caused by); click to jump to the source line. Crash stacks and test failure locations are resolved by script against the source list under the Gradle root.
- Actions are grouped as Check / Device / Project; logs are coloured by rule and repeated Gradle task lines are folded.
- Parameters (module, variant, device) are declared; until the host form is drawn the defaults are used: `:app` or the app module named like the project, the debug variant and the first device.

Other trusted plugins can register a workspace handler through the `workspaces` service (`workspaces.ts`) to take over the app list, build plan, diagnostics and run configuration commands for a kind of workspace, for example to hand builds to a remote system. A handler declares `riffet.android` in its own `requires`.

## Development

This package is the public reference implementation of a task provider: providers, views, commands and diagnostics are declared with `@riffet/plugin-api`; see the [plugin documentation](../../docs/PLUGINS.md).

```sh
riffet plugin pack official/android --out /tmp/riffet-android.tgz
riffet plugin install /tmp/riffet-android.tgz --trusted --yes

# Develop: build, link to the local Riffet, watch changes and reload
riffet plugin dev official/android
```

`pack` reads the current sources each time, then builds, validates and archives them. The archive does not include tests. Run unit tests from the repository root with `npx vitest run official/android`.

You can also import the archive on the Web or Mac plugins page and install it after explicitly ticking "Trust this plugin". Uninstalling keeps settings and data.
