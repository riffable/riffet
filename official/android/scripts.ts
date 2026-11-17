// The shell scripts of the tasks that are more than one command. Every value from the project
// (a Gradle task, a package name) is a positional argument, never part of the script text, so a
// build script cannot inject shell. They run with `/bin/sh` in the Gradle root, `$0` being the file.

import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginHost } from '@riffet/plugin-api';

/** The marker lines the scripts print for `diagnostics.ts`. */
export const MARK = 'riffet-android';

const written = new Map<string, Promise<string>>();

/**
 * A script as a file in the plugin's data directory, named by its content, so a plan is `sh <file> <args>`:
 * an installed package's plan may not carry line breaks, and a changed script is a new file whose plan
 * is approved again.
 */
export function scriptFile(host: PluginHost, text: string): Promise<string> {
  const body = `${text.trim()}\n`;
  const name = `${createHash('sha256').update(body).digest('hex').slice(0, 16)}.sh`;
  let path = written.get(name);
  if (!path) {
    path = (async () => {
      const dir = join(await host.stateDir(), 'scripts');
      await mkdir(dir, { recursive: true });
      const file = join(dir, name);
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, body, { mode: 0o644 });
      await rename(temporary, file);
      return file;
    })();
    path.catch(() => written.delete(name));
    written.set(name, path);
  }
  return path;
}

/**
 * `resolve <log>`: the project files of the stack frames in a log, one line each,
 * `riffet-android frame <frame>\t<absolute path>:<line>`. A frame is either `pkg.Class.method(File.kt:12)`
 * (a crash) or `at File.kt:12` at the end of a line (Gradle's short test failure). Library and
 * platform frames are skipped; the sources are listed once from git, or found without it.
 */
const RESOLVE = String.raw`
resolve() {
  [ -s "$1" ] || return 0
  { git ls-files -co --exclude-standard -- '*.kt' '*.java' 2>/dev/null || find . \( -name build -o -name .gradle -o -name .git -o -name node_modules \) -prune -o -type f \( -name '*.kt' -o -name '*.java' \) -print | sed 's|^\./||'; } > "$1.src"
  awk -v root="$PWD" '
    function ends(text, tail) { return length(text) >= length(tail) && substr(text, length(text) - length(tail) + 1) == tail }
    FNR == NR { files[++count] = "/" $0; next }
    {
      rest = $0
      while (match(rest, /[A-Za-z_][A-Za-z0-9_$.]*\([A-Za-z0-9_]+\.(kt|java):[0-9]+\)|at [A-Za-z0-9_]+\.(kt|java):[0-9]+$/)) {
        frame = substr(rest, RSTART, RLENGTH); rest = substr(rest, RSTART + RLENGTH)
        if (frame in seen || resolved >= 200) continue
        seen[frame] = 1
        if (frame ~ /^(android|androidx|java|javax|kotlin|kotlinx|dalvik|sun|libcore|jdk|junit|okhttp3|okio|retrofit2)\./ || frame ~ /^(com\.android|com\.google|org\.junit|org\.gradle|org\.jetbrains)\./) continue
        if (frame ~ /^at /) { location = substr(frame, 4); dir = "" }
        else {
          open = index(frame, "("); location = substr(frame, open + 1, length(frame) - open - 1)
          parts = split(substr(frame, 1, open - 1), segment, "."); dir = ""
          for (i = 1; i <= parts && segment[i] !~ /^[A-Z_$]/; i++) dir = dir segment[i] "/"
        }
        colon = index(location, ":"); file = substr(location, 1, colon - 1); number = substr(location, colon + 1)
        tail = "/" dir file
        for (i = 1; i <= count; i++) if (ends(files[i], tail)) { printf "MARK frame %s\t%s%s:%s\n", frame, root, files[i], number; resolved++; break }
      }
    }' "$1.src" "$1"
  rm -f "$1.src"
}
`.replaceAll('MARK frame', `${MARK} frame`);

/** `$1` Gradle (`./gradlew`), `$2` the install task, `$3` the variant's `output-metadata.json`, `$4` the application id read from the build script. */
export const INSTALL_AND_RUN = String.raw`
set -u
gradle="$1"; shift
"$gradle" "$1" --console=plain || exit $?
pkg=$(sed -n 's/.*"applicationId": *"\([^"]*\)".*/\1/p' "$2" 2>/dev/null | head -n 1)
[ -n "$pkg" ] || pkg="$3"
[ -n "$pkg" ] || { echo "error: unknown applicationId"; exit 1; }
# adb shell joins its arguments into a device-side command line: only plain names go into it.
case "$pkg" in *[!A-Za-z0-9._]*) echo "error: unexpected applicationId $pkg"; exit 1 ;; esac
act=$(adb shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER "$pkg" 2>/dev/null | tr -d '\r' | tail -n 1)
case "$act" in *[!A-Za-z0-9._/]*) act= ;; esac
case "$act" in
  */*) adb shell am start -n "$act" ;;
  *) adb shell monkey -p "$pkg" -c android.intent.category.LAUNCHER 1 >/dev/null && echo "Started $pkg" ;;
esac
`;

/** `$1` Gradle, `$2` the test task; failed tests are followed by where their assertions are. */
export const UNIT_TEST = String.raw`
${RESOLVE}
gradle="$1"; shift
out=$(mktemp)
trap 'rm -f "$out" "$out.code"' EXIT
{ "$gradle" "$1" --console=plain 2>&1; echo $? > "$out.code"; } | tee "$out"
code=$(cat "$out.code")
[ "$code" = 0 ] || resolve "$out"
exit "$code"
`;

/** `$1` the package; the crashes of its processes in the device's crash buffer, then where their frames are in the project. */
export const CRASHES = String.raw`
${RESOLVE}
printf '${MARK} package %s\n' "$1"
all=$(mktemp)
out=$(mktemp)
trap 'rm -f "$all" "$out"' EXIT
adb logcat -d -b crash -v threadtime > "$all" || { cat "$all"; exit 1; }
if [ -n "$1" ]; then
  awk -v pkg="$1" 'NR == FNR { if (index($0, "Process: " pkg ",") || index($0, "Process: " pkg ":")) pids[$3] = 1; next } ($3 in pids)' "$all" "$all" > "$out"
else
  cp "$all" "$out"
fi
if [ -s "$out" ]; then cat "$out"; else echo "No crashes of $1"; fi
resolve "$out"
`;

/**
 * `$1` the package. Follows the app's log by pid, starting over whenever the app (re)starts, until
 * cancelled; on cancel, where the frames of what it saw are in the project. Exits 143 so a cancelled
 * log reads as cancelled.
 */
export const LOGCAT = String.raw`
${RESOLVE}
pkg="$1"
out=$(mktemp)
current=
follower=
waited=0
# The follower's pid is tee's; the adb client before it is ended by what it follows.
unfollow() {
  [ -n "$follower" ] && kill "$follower" 2>/dev/null
  [ -n "$current" ] && pkill -f "logcat -v threadtime --pid=$current" 2>/dev/null
  follower=
}
stop() {
  unfollow
  resolve "$out"
  rm -f "$out"
  exit 143
}
trap stop TERM INT HUP
printf '${MARK} package %s\n' "$pkg"
while :; do
  pid=$(adb shell pidof -s "$pkg" 2>/dev/null | tr -d '\r')
  if [ "$pid" != "$current" ] || [ -z "$current$pid" ]; then
    unfollow
    if [ -n "$pid" ]; then
      printf -- '--- %s (%s) ---\n' "$pkg" "$pid"
      adb logcat -v threadtime --pid="$pid" | tee -a "$out" &
      follower=$!
    elif [ -n "$current" ] || [ "$waited" = 0 ]; then
      printf -- '--- %s … ---\n' "$pkg"
      waited=1
    fi
    current="$pid"
  fi
  sleep 2 &
  wait $!
done
`;

/** Takes a screenshot into `build/riffet/` of the Gradle root, replacing the previous one. */
export const SCREENSHOT = String.raw`
mkdir -p build/riffet || exit 1
rm -f build/riffet/screen-*.png
file="build/riffet/screen-$(date +%Y%m%d-%H%M%S).png"
adb exec-out screencap -p > "$file" || exit $?
[ -s "$file" ] || { rm -f "$file"; echo "error: empty screenshot"; exit 1; }
echo "$file"
`;
