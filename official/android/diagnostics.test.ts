import { describe, expect, it } from 'vitest';
import { parseAndroidLog, parseGradleLog } from './diagnostics.js';
import { childBlocks, includedModules } from './project.js';
import { parseConfigurations } from './configs.js';

const ROOT = '/Users/dev/sample';
const context = {
  relativize: (path: string) => (path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : undefined),
};

const LOG = `> Task :app:preBuild UP-TO-DATE
> Task :app:processDebugResources FAILED
ERROR: ${ROOT}/app/src/main/res/layout/activity_main.xml:14: AAPT: error: attribute android:textColr not found.

> Task :app:compileDebugKotlin FAILED
w: file://${ROOT}/app/src/main/kotlin/com/example/Util.kt:3:1 Parameter 'unused' is never used
w: file://${ROOT}/app/src/main/kotlin/com/example/Util.kt:3:1 Parameter 'unused' is never used
e: file://${ROOT}/app/src/main/kotlin/com/example/Main.kt:12:5 Unresolved reference: render
e: file:///Users/dev/.gradle/generated/Gen.kt:2:1 Redeclaration: Gen
e: ${ROOT}/app/src/main/kotlin/Old.kt: (7, 9): Type mismatch: inferred type is String but Int was expected

> Task :app:compileDebugJavaWithJavac FAILED
${ROOT}/app/src/main/java/com/example/Legacy.java:21: error: cannot find symbol
        render();
        ^
  symbol:   method render()
  location: class Legacy
${ROOT}/app/src/main/java/com/example/Legacy.java:30: warning: [deprecation] open() in Store has been deprecated
2 errors

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileDebugKotlin'.
> Compilation error. See log for more details

* Try:
> Run with --stacktrace option to get the stack trace.
> Run with --info or --debug option to get more log output.

BUILD FAILED in 12s
`;

describe('parseGradleLog', () => {
  it('reads Kotlin, javac, AAPT and the Gradle summary, with project-relative paths', () => {
    expect(parseGradleLog(LOG, context)).toEqual([
      { severity: 'error', message: 'attribute android:textColr not found.', file: 'app/src/main/res/layout/activity_main.xml', line: 14 },
      { severity: 'warning', message: "Parameter 'unused' is never used", file: 'app/src/main/kotlin/com/example/Util.kt', line: 3, column: 1 },
      { severity: 'error', message: 'Unresolved reference: render', file: 'app/src/main/kotlin/com/example/Main.kt', line: 12, column: 5 },
      // Outside the project: the message stays, the location goes.
      { severity: 'error', message: 'Redeclaration: Gen' },
      { severity: 'error', message: 'Type mismatch: inferred type is String but Int was expected', file: 'app/src/main/kotlin/Old.kt', line: 7, column: 9 },
      { severity: 'error', message: 'cannot find symbol', file: 'app/src/main/java/com/example/Legacy.java', line: 21 },
      { severity: 'warning', message: '[deprecation] open() in Store has been deprecated', file: 'app/src/main/java/com/example/Legacy.java', line: 30 },
      { severity: 'error', message: "Execution failed for task ':app:compileDebugKotlin'.\n> Compilation error. See log for more details" },
    ]);
  });

  it('reports nothing for a build that succeeded', () => {
    expect(parseGradleLog('> Task :app:assembleDebug\n\nBUILD SUCCESSFUL in 4s\n31 actionable tasks: 31 executed\n', context)).toEqual([]);
  });
});

const CRASH = `riffet-android package com.example
11-10 12:00:00.100  4321  4321 E AndroidRuntime: FATAL EXCEPTION: main
11-10 12:00:00.100  4321  4321 E AndroidRuntime: Process: com.example, PID: 4321
11-10 12:00:00.100  4321  4321 E AndroidRuntime: java.lang.RuntimeException: Unable to start activity
11-10 12:00:00.100  4321  4321 E AndroidRuntime: \tat android.app.ActivityThread.performLaunchActivity(ActivityThread.java:3449)
11-10 12:00:00.100  4321  4321 E AndroidRuntime: \tat com.example.Main$onCreate$1.invoke(Main.kt:42)
11-10 12:00:00.100  4321  4321 E AndroidRuntime: Caused by: java.lang.IllegalStateException: boom
11-10 12:00:00.100  4321  4321 E AndroidRuntime: \tat com.example.Store.load(Store.kt:17)
11-10 12:00:01.000  9999  9999 E AndroidRuntime: FATAL EXCEPTION: main
11-10 12:00:01.000  9999  9999 E AndroidRuntime: Process: com.other, PID: 9999
11-10 12:00:01.000  9999  9999 E AndroidRuntime: java.lang.NullPointerException
riffet-android frame com.example.Main$onCreate$1.invoke(Main.kt:42)\t${ROOT}/app/src/main/kotlin/com/example/Main.kt:42
riffet-android frame com.example.Store.load(Store.kt:17)\t${ROOT}/app/src/main/kotlin/com/example/Store.kt:17
`;

describe('parseAndroidLog', () => {
  it("reads the app's crash at the root cause's first project frame, then the frames in the project", () => {
    expect(parseAndroidLog(CRASH, context)).toEqual([
      { severity: 'error', message: 'java.lang.RuntimeException: Unable to start activity\nCaused by: java.lang.IllegalStateException: boom', file: 'app/src/main/kotlin/com/example/Store.kt', line: 17 },
      { severity: 'warning', message: 'at com.example.Main$onCreate$1.invoke(Main.kt:42)', file: 'app/src/main/kotlin/com/example/Main.kt', line: 42 },
      { severity: 'warning', message: 'at com.example.Store.load(Store.kt:17)', file: 'app/src/main/kotlin/com/example/Store.kt', line: 17 },
    ]);
  });
});

describe('build scripts', () => {
  it('reads included modules and the named blocks of a container', () => {
    expect(includedModules(`include(":app", ":feature:home")\ninclude ':legacy'\nproject(':legacy').projectDir = file('old/legacy')`))
      .toEqual([[':app', 'app'], [':feature:home', 'feature/home'], [':legacy', 'old/legacy']]);
    expect(childBlocks(`debug { applicationIdSuffix ".debug" }\n  create("staging") {\n initWith(getByName("debug")) }\n release {}`).map(item => item.name))
      .toEqual(['debug', 'staging', 'release']);
  });
});

describe('IDE entries', () => {
  it("runs a Shell Script configuration as Studio does, from the project's directory", () => {
    const xml = `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Android-Build-Demo" type="ShConfigurationType" folderName="Android-Scripts">
    <option name="SCRIPT_PATH" value="$PROJECT_DIR$/build.sh" />
    <option name="SCRIPT_OPTIONS" value="assemble &quot;demo&quot; --fast " />
    <option name="SCRIPT_WORKING_DIRECTORY" value="$PROJECT_DIR$" />
    <option name="INTERPRETER_PATH" value="/bin/bash" />
    <option name="INTERPRETER_OPTIONS" value="--login" />
    <option name="EXECUTE_SCRIPT_FILE" value="true" />
    <envs><env name="FAST" value="1" /></envs>
  </configuration>
  <configuration name="demo" type="AndroidRunConfigurationType" />
</component>`;
    expect(parseConfigurations(xml)).toEqual([
      { name: 'Android-Build-Demo', folder: 'Android-Scripts', cwd: '', command: ['bash', '--login', './build.sh', 'assemble', 'demo', '--fast'], env: { FAST: '1' } },
    ]);
  });
});
