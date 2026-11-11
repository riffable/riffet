#!/usr/bin/env bash
# Restart the Riffet service on this machine with a known-good binding, and
# without letting the caller's shell environment leak into the daemon.
#
# Why this exists instead of `riffet restart`:
#   * `riffet start` always carries the wrapper's `--no-auth`, and token-free
#     access may only bind to loopback, so it can never (re)start a LAN
#     deployment; `riffet restart` replays the running daemon's own arguments,
#     but falls back to the wrapper's 127.0.0.1 as soon as the service is
#     already stopped. Either way a LAN deployment can end up loopback-only.
#   * Both hand the caller's environment to the daemon. Riffet terminals
#     inherit it, so an agent session's ANTHROPIC_* / CLAUDE_CODE_* / CURSOR_*
#     reach every agent started from the UI afterwards.
#   * Neither waits for turns in flight, and a restart marks the ones that were
#     dispatching as interrupted.
#
# A fourth failure mode is self-inflicted and cost this deployment a restart on
# 2026-10-08: the idle wait means the script finishes only once the calling
# agent's own turn ends, and the harness kills the tool process group at that
# moment. The script was killed between stopping the daemon (17:42:33) and
# starting it again, leaving the service down. The commit phase now runs in a
# session of its own, so the caller's death cannot interrupt it.
#
# So this script: validates the target before touching anything, waits for
# in-flight turns, starts from a clean login-shell environment, and verifies
# the daemon answers on its own address and on the LAN address.
#
# Exit codes: 0 ok · 1 usage/environment · 2 stop or start failed
#             3 verification after restart failed · 4 timed out waiting for idle

set -euo pipefail

# Kept for the detached re-exec below, before the argument parser consumes them.
ORIGINAL_ARGS=("$@")

# Unlike node, bash does not resolve the installed symlink, so follow it here:
# calling ~/.local/bin/riffet-restart must still find the repository it points at.
resolve_script() {
  local target=${BASH_SOURCE[0]} dir
  while [[ -L $target ]]; do
    dir=$(cd -- "$(dirname -- "$target")" && pwd)
    target=$(readlink -- "$target")
    [[ $target == /* ]] || target="$dir/$target"
  done
  printf '%s/%s\n' "$(cd -- "$(dirname -- "$target")" && pwd)" "$(basename -- "$target")"
}
SCRIPT_PATH=$(resolve_script)
SCRIPT_DIR=$(dirname -- "$SCRIPT_PATH")
ROOT=${RIFFET_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}
ENTRY="$ROOT/dist/cli.js"
PNPM_BIN=${RIFFET_PNPM:-pnpm}

STATE_DIR=${RIFFET_STATE_DIR:-$HOME/.local/share/riffet}
HOST=${RIFFET_HOST:-0.0.0.0}
PORT=${RIFFET_PORT:-4337}
CLI_PATH=${RIFFET_CLI:-cursor-agent}

AUTH=1                 # --no-auth drops token login (loopback only)
MODE=restart           # restart | check
WAIT_IDLE=180          # seconds to wait for running turns before restarting
# 非交互调用方（stdout 是管道，通常是 agent 的工具调用）的等待上限。它比交互默认值大
# 得多，因为被等的那个会话往往就是调用方自己：它要等调用方把这一轮干完。
AGENT_WAIT_IDLE=${RIFFET_RESTART_AGENT_WAIT:-900}
FORCE=0
DO_BUILD=0
SHOW_TOKEN=0
DRY_RUN=0
LOG_PATH=''            # --log: where the detached commit phase writes

# Toolchain locations the daemon's terminals need. Only exported when the
# directory exists, so the script still works on a machine without them.
JAVA_HOME_DIR=${JAVA_HOME:-}
ANDROID_HOME_DIR=${ANDROID_HOME:-/usr/lib/android-sdk}
PNPM_HOME_DIR=${PNPM_HOME:-$HOME/.local/share/pnpm}

usage() {
  cat <<'EOF'
riffet-restart —— 正确重启本机的 Riffet 服务（局域网模式）

默认行为：校验目标地址可用 → 等待执行中的会话跑完 → 停止服务 → 用干净的登录环境
         以 --host 0.0.0.0 --auth 启动 → 校验服务地址与局域网地址都健康。
         等待与「停→起」这一段在独立会话里执行：调用方（通常是某个 agent 的一轮）
         中途结束也不会把它杀在半路，把服务留在「已停未起」的状态。
         非交互调用（stdout 是管道，例如 agent 的工具调用）会立刻返回，不在这里等：
         那个调用方往往正是被等待的会话本身，同步等下去就是死锁。此时退出码 0 只表示
         「已受理」，结果看日志；要事后能读到日志，请显式传一个自己能访问的 --log
         （默认的 $TMPDIR 在部分 agent 沙箱里每次调用都是独立的）。

用法：riffet-restart [选项]

选项：
  --host <host>        监听地址（默认 0.0.0.0，即局域网；环境变量 RIFFET_HOST）
                       注意：默认值不会跟随当前绑定，换地址要显式指定
  --port <port>        端口（默认 4337，环境变量 RIFFET_PORT）
  --cli <cmd>          Agent CLI 入口（默认 cursor-agent，环境变量 RIFFET_CLI）
  --state-dir <path>   数据目录（默认 ~/.local/share/riffet）
  --root <path>        项目根目录（默认脚本所在的仓库，环境变量 RIFFET_ROOT）
  --no-auth            关闭登录令牌；只能绑定回环地址，局域网会被拒绝
  --wait-idle <sec>    等待会话空闲的上限秒数（默认 180；0 表示不等待）
                       非交互调用未显式指定时用 900s（RIFFET_RESTART_AGENT_WAIT 可覆盖）
  --force              有会话正在执行时也直接重启（会打断当前轮次）
  --build              重启前先执行 pnpm build（构建失败则不动现有服务）
  --log <path>         独立会话的执行日志（默认 /tmp/riffet-restart-<时间>.log）
  --token              额外打印带令牌的登录地址
  --dry-run            只打印将要执行的步骤，不做任何改动
  --check              只体检当前服务，不重启；健康退出码 0，异常非零
  -h, --help           显示本帮助

沿用规则：`--allow-host`、`--workspace`、`--mdns` / `--no-mdns` 会从运行中实例的
启动参数里沿用（脚本没有它们的默认值，丢掉会静默改变访问方式）；监听地址、端口和
`--cli` 由上面的选项决定。无法沿用的参数会明确告警。

例：
  riffet-restart                     # 常规重启（局域网 + 令牌登录）
  riffet-restart --build             # 改完服务端代码，构建后再重启
  riffet-restart --wait-idle 0       # 不等待，立刻重启
  riffet-restart --check             # 体检，不重启
EOF
}

log()  { printf '[riffet-restart] %s\n' "$*"; }
warn() { printf '[riffet-restart] 警告：%s\n' "$*" >&2; }
fail() { local code=$1; shift; printf '[riffet-restart] 错误：%s\n' "$*" >&2; exit "$code"; }

# --- arguments -------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case $1 in
    --host)      HOST=${2:?--host 需要参数}; shift 2 ;;
    --port)      PORT=${2:?--port 需要参数}; shift 2 ;;
    --cli)       CLI_PATH=${2:?--cli 需要参数}; shift 2 ;;
    --state-dir) STATE_DIR=${2:?--state-dir 需要参数}; shift 2 ;;
    --root)      ROOT=${2:?--root 需要参数}; ENTRY="$ROOT/dist/cli.js"; shift 2 ;;
    --no-auth)   AUTH=0; shift ;;
    --wait-idle) WAIT_IDLE=${2:?--wait-idle 需要秒数}; shift 2 ;;
    --force)     FORCE=1; shift ;;
    --build)     DO_BUILD=1; shift ;;
    --log)       LOG_PATH=${2:?--log 需要路径}; shift 2 ;;
    --token)     SHOW_TOKEN=1; shift ;;
    --dry-run)   DRY_RUN=1; shift ;;
    --check)     MODE=check; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           usage >&2; fail 1 "未知参数：$1" ;;
  esac
done

# Reject typos before anything is stopped: the server would only catch these
# after the daemon is already down.
[[ $PORT =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) \
  || fail 1 "端口必须是 1–65535 的整数：$PORT"
[[ $WAIT_IDLE =~ ^[0-9]+$ ]] || fail 1 "--wait-idle 必须是非负整数：$WAIT_IDLE"
case $HOST in
  '') fail 1 "监听地址不能为空" ;;
  *\ *|*\'*|*\"*|*\\*) fail 1 "监听地址包含空白或引号：$HOST" ;;
esac

DAEMON_JSON="$STATE_DIR/daemon.json"
SOCK="$STATE_DIR/tmux.sock"

# The quoting helpers below assume a bash-compatible login shell. It is used to
# ask the user's own shell what PATH it has, and never to run the daemon: a
# login shell re-runs /etc/zprofile, path_helper and ~/.zprofile, which would
# throw away the PATH this script just resolved.
LOGIN_SHELL=${SHELL:-/bin/bash}
case $(basename -- "$LOGIN_SHELL") in
  bash|zsh|fish) ;;
  *) LOGIN_SHELL=/bin/bash ;;
esac
[[ -x $LOGIN_SHELL ]] || LOGIN_SHELL=/bin/bash

# --- environment ------------------------------------------------------------
# Two concerns, deliberately kept apart:
#
#   * credentials. An agent session exports its own ANTHROPIC_* / CLAUDE_CODE_*
#     / CURSOR_* and a terminal opened afterwards would inherit them. Those are
#     *removed* from the environment the daemon gets.
#   * completeness. The daemon must run the toolchain the user installed. It is
#     *not* rebuilt from an allowlist: an allowlist cannot know that this
#     machine keeps node, dsh and pnpm in ~/.local/bin/node/bin, only its user's
#     ~/.zshrc does. Rebuilding was the previous behaviour; it cost this
#     deployment its DSH backend on 2026-10-09 and, more quietly, moved the
#     whole service onto a node runtime the user had not chosen.
#
# So: scrub the leak-prone names, then take PATH from the user's own shell with
# fallbacks. Deprecated RIFFET_* names are still honoured by the served CLI.
LEAKED_PREFIXES=(ANTHROPIC_ CLAUDE_ CLAUDE_CODE_ CURSOR_ MIRAGE_ SSH_ RIFFET_RESTART_)
LEAKED_KEYS=(TMUX TMUX_PANE OLDPWD SHLVL _ PROMPT_COMMAND)
if [[ -n ${RIFFET_ENV_DROP:-} ]]; then
  # shellcheck disable=SC2206
  LEAKED_PREFIXES+=(${RIFFET_ENV_DROP})
fi

# `compgen -e` and process substitution need bash, and ${name^^} needs bash 4
# while macOS ships bash 3.2 — hence the explicit tr.
leaked_names() {
  local name upper prefix
  while IFS= read -r name; do
    upper=$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')
    for prefix in "${LEAKED_KEYS[@]}"; do
      [[ $upper == "$prefix" ]] && { printf '%s\n' "$name"; continue 2; }
    done
    for prefix in "${LEAKED_PREFIXES[@]}"; do
      [[ $upper == "$prefix"* ]] && { printf '%s\n' "$name"; continue 2; }
    done
  done < <(compgen -e)
}

# Remove the caller's agent credentials and state the identity we do want.
scrub_environment() {
  local name
  while IFS= read -r name; do unset "$name"; done < <(leaked_names)
  [[ -n ${HOME:-} ]] || HOME=$(cd ~ 2>/dev/null && pwd)
  export HOME
  export USER=$(id -un) LOGNAME=$(id -un) SHELL="$LOGIN_SHELL"
  export TERM="${TERM:-xterm-256color}" LANG="${LANG:-en_US.UTF-8}"
}

# bash has no `timeout`, and macOS ships none either, so a hung startup file is
# killed by a background watcher rather than by `timeout`.
run_with_timeout() {
  local seconds=$1; shift
  local pid watcher rc=0
  "$@" &
  pid=$!
  ( sleep "$seconds"
    kill -0 "$pid" 2>/dev/null && kill -TERM "$pid" 2>/dev/null
    sleep 1
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  watcher=$!
  wait "$pid" 2>/dev/null || rc=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  return $rc
}

# A PATH we are willing to believe: single line, and pointing at real
# directories. Interactive startup files print banners and some of them exit
# non-zero, so "printed something" is not evidence enough.
plausible_path() {
  local value=$1 dir found=0
  [[ -n $value && $value != *$'\n'* && $value != *$'\r'* ]] || return 1
  local IFS=:
  for dir in $value; do
    [[ -n $dir && -d $dir ]] && found=$(( found + 1 ))
  done
  (( found >= 2 ))
}

# Ask the user's own shell for its PATH. `-i` is what matters: bash and zsh read
# ~/.bashrc and ~/.zshrc only interactively, and that is where nvm, asdf, mise,
# pnpm and a user-local npm prefix are normally put. `-lc` is the second attempt
# because it is cheaper and still covers /etc/profile.d and ~/.profile.
capture_login_path() {
  local shell=$1 begin='__RIFFET_PATH_BEGIN__' end='__RIFFET_PATH_END__'
  local tmp out body
  tmp=$(mktemp)
  out=''
  if run_with_timeout 5 "$shell" -ilc "printf '%s%s%s' '$begin' \"\$PATH\" '$end'" >"$tmp" 2>/dev/null; then
    out=$(cat "$tmp")
  elif run_with_timeout 5 "$shell" -lc "printf '%s%s%s' '$begin' \"\$PATH\" '$end'" >"$tmp" 2>/dev/null; then
    out=$(cat "$tmp")
  fi
  rm -f "$tmp"
  body=${out#*$begin}
  [[ $body == "$out" ]] && return 1
  body=${body%%$end*}
  plausible_path "$body" || return 1
  printf '%s\n' "$body"
}

# Directories the daemon and its terminals need regardless of what PATH said.
# The TypeScript side appends the same set; this keeps the script's own view
# (node, pnpm for --build) consistent with the daemon it starts.
path_additions() {
  local dir node_dir
  for dir in \
    "${JAVA_HOME_DIR:-}/bin" \
    "${ANDROID_HOME_DIR:-}/platform-tools" \
    "${ANDROID_HOME_DIR:-}/tools" \
    "${PNPM_HOME_DIR:-}/bin" \
    "$HOME/.local/bin" "$HOME/.local/bin/node/bin"; do
    [[ -n $dir && -d $dir ]] && printf '%s\n' "$dir"
  done
  node_dir=$(dirname "$(command -v node 2>/dev/null || true)" 2>/dev/null || true)
  [[ -n $node_dir && -d $node_dir ]] && printf '%s\n' "$node_dir"
}

# PATH precedence: the user's own shell, then whatever we inherited, then the
# platform default — each one only accepted if it looks like a real PATH.
resolve_environment() {
  local captured='' merged='' dir
  PATH_SOURCE='当前环境'
  captured=$(capture_login_path "$LOGIN_SHELL" 2>/dev/null) || captured=''
  if [[ -n $captured ]] && plausible_path "$captured"; then
    merged=$captured
    PATH_SOURCE='登录 shell'
    # Pinning it means the daemon resolves the same directories this script saw,
    # and `riffet doctor` can say where the PATH came from.
    export RIFFET_PATH="$captured"
    log "环境：PATH 取自 ${LOGIN_SHELL}（登录 shell），$(printf '%s' "$merged" | tr ':' '\n' | wc -l | tr -d ' ') 个目录"
  elif plausible_path "${PATH:-}"; then
    merged=${PATH}
    log "环境：登录 shell 没有给出可用 PATH，沿用当前环境的 PATH"
  else
    merged='/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    PATH_SOURCE='系统默认'
    warn "环境：PATH 不可用，回退到系统默认值"
  fi
  while IFS= read -r dir; do
    [[ -n $dir ]] || continue
    case ":$merged:" in *":$dir:"*) ;; *) merged="$merged:$dir" ;; esac
  done < <(path_additions)
  export PATH=$merged
}

# Warn (never fail) about agent CLIs this machine cannot see: not every machine
# needs every backend, but a restart log should say what the daemon will not
# be able to start.
report_missing_clis() {
  local tool missing=()
  for tool in dsh cursor-agent claude codex droid traex; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if (( ${#missing[@]} > 0 )); then
    warn "PATH 里找不到：${missing[*]}（对应后端在本机不可用；riffet doctor 可看详情）"
  fi
}


# --- helpers ---------------------------------------------------------------
loopback_host() {
  case $(printf '%s' "$1" | tr '[:upper:]' '[:lower:]') in
    127.0.0.1|localhost|::1|::ffff:127.0.0.1) return 0 ;;
    *) return 1 ;;
  esac
}

wildcard_host() { [[ $1 == 0.0.0.0 || $1 == :: || $1 == '[::]' ]]; }

# First non-loopback IPv4, or empty. BSD/macOS has no `hostname -I`, and its
# absence must never fail the script.
lan_ip() {
  local candidate='' ip
  for ip in $(hostname -I 2>/dev/null || true); do
    case $ip in *:*) continue ;; esac
    candidate=$ip
    break
  done
  if [[ -z $candidate ]] && command -v ipconfig >/dev/null 2>&1; then
    candidate=$(ipconfig getifaddr en0 2>/dev/null || true)
  fi
  printf '%s\n' "$candidate"
  return 0
}

# Probe address of a daemon: a wildcard or loopback bind answers on 127.0.0.1,
# a specific bind only on that address.
daemon_base_url() {
  local host=$1 port=$2
  if loopback_host "$host" || wildcard_host "$host"; then
    printf 'http://127.0.0.1:%s' "$port"
  elif [[ $host == *:* ]]; then
    printf 'http://[%s]:%s' "$host" "$port"
  else
    printf 'http://%s:%s' "$host" "$port"
  fi
}

pid_alive() {
  [[ ${1:-} =~ ^[0-9]+$ ]] && (( $1 > 0 )) && kill -0 "$1" 2>/dev/null
}

# The node the daemon will run under. PATH is resolved first, so a user who
# keeps their own node (nvm, asdf, mise, a custom prefix) gets that one rather
# than whichever node a bare system PATH happens to expose: global packages,
# and the native modules compiled against them, belong to one runtime.
resolve_node() {
  local candidate
  for candidate in \
    "$(command -v node 2>/dev/null || true)" \
    "$HOME/.local/bin/node/bin/node" \
    "$HOME/.local/bin/node" \
    /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [[ -n $candidate && -x $candidate ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

# Whoever listens on the target port, as "<pid>\t<description>"; empty when free
# or when no listener tool is available. Best effort: never fails the script.
port_listener() {
  local line='' pid='' desc=''
  if command -v ss >/dev/null 2>&1; then
    line=$( { ss -tlnp 2>/dev/null || true; } | awk -v p=":$PORT" '$4 ~ p"$" {print; exit}' )
    pid=$(printf '%s' "$line" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p')
    desc=$line
  elif command -v lsof >/dev/null 2>&1; then
    pid=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sed -n '1p' || true)
    if [[ -n $pid ]]; then desc="lsof: pid $pid"; fi
  fi
  printf '%s\t%s\n' "$pid" "$desc"
}

# Read the running daemon's record. Empty values mean "no daemon record".
read_daemon() {
  DAEMON_PID=''; DAEMON_HOST=''; DAEMON_PORT=''; DAEMON_INSTANCE=''; DAEMON_ARGS=''
  DAEMON_ARGV=()
  [[ -f $DAEMON_JSON ]] || return 0
  eval "$(DAEMON_JSON="$DAEMON_JSON" "$NODE_BIN" - <<'NODE'
const fs = require('fs');
const quote = (value) => "'" + String(value).split("'").join("'\\''") + "'";
try {
  const record = JSON.parse(fs.readFileSync(process.env.DAEMON_JSON, 'utf8'));
  const args = record.args ?? [];
  process.stdout.write(`DAEMON_PID=${quote(record.pid ?? '')}\n`);
  process.stdout.write(`DAEMON_HOST=${quote(record.host ?? '')}\n`);
  process.stdout.write(`DAEMON_PORT=${quote(record.port ?? '')}\n`);
  process.stdout.write(`DAEMON_INSTANCE=${quote(record.instanceId ?? '')}\n`);
  process.stdout.write(`DAEMON_ARGS=${quote(args.join(' '))}\n`);
  process.stdout.write(`DAEMON_ARGV=(${args.map(quote).join(' ')})\n`);
} catch {
  process.stdout.write("DAEMON_PID=''\nDAEMON_HOST=''\nDAEMON_PORT=''\nDAEMON_INSTANCE=''\nDAEMON_ARGS=''\nDAEMON_ARGV=()\n");
}
NODE
)"
}

# Health probe. With an expected instanceId the body must carry that instance,
# so a foreign listener on the port cannot pass as our daemon.
health_ok() {
  local url=$1 expect=${2:-} body
  body=$(curl -fsS -m 3 "$url/health" 2>/dev/null) || return 1
  if [[ -n $expect ]]; then
    [[ $body == *"\"instanceId\":\"$expect\""* ]]
  else
    [[ $body == *'"ok":true'* ]]
  fi
}

terminal_count() {
  command -v tmux >/dev/null 2>&1 || { printf '0\n'; return 0; }
  [[ -S $SOCK ]] || { printf '0\n'; return 0; }
  tmux -S "$SOCK" ls 2>/dev/null | wc -l | tr -d ' '
}

# Sessions with a turn in flight, asked of the daemon at $1.
# Prints "<count>\t<titles>"; fails if the state cannot be read, which the
# caller treats as a warning.
busy_sessions() {
  local base=$1 jar body='' token=''
  jar=$(mktemp)
  if ! body=$(curl -fsS -m 3 -b "$jar" "$base/api/sessions" 2>/dev/null); then
    # Token-free loopback access needs no login; a token deployment does.
    [[ -f $STATE_DIR/access-token ]] && token=$(<"$STATE_DIR/access-token")
    if [[ -n $token ]] && curl -fsS -m 3 -c "$jar" -X POST "$base/api/auth/login" \
        -H 'content-type: application/json' \
        --data-binary "$(printf '{"token":"%s"}' "$token")" >/dev/null 2>&1; then
      body=$(curl -fsS -m 3 -b "$jar" "$base/api/sessions" 2>/dev/null) || body=''
    fi
  fi
  rm -f "$jar"
  [[ -n $body ]] || return 1
  # Read from stdin: a large session list must not have to fit in one env var.
  printf '%s' "$body" | "$NODE_BIN" -e '
    const sessions = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const busy = sessions.filter((s) => s.state === "running");
    process.stdout.write(`${busy.length}\t${busy.map((s) => s.title).join(" | ")}`);
  '
}

# Options the script has no default for, carried over from the running daemon so
# a restart does not silently drop LAN access (--allow-host), a project
# (--workspace) or mDNS advertising (--no-mdns).
inherit_flags() {
  local i=0 arg out=()
  while (( i < ${#DAEMON_ARGV[@]} )); do
    arg=${DAEMON_ARGV[i]}
    case $arg in
      --allow-host|--workspace)
        if (( i + 1 < ${#DAEMON_ARGV[@]} )); then
          out+=("$arg" "${DAEMON_ARGV[i+1]}")
          i=$((i + 1))
        fi ;;
      --mdns|--no-mdns) out+=("$arg") ;;
      serve|--no-token|--auth|--no-auth) ;;
      --state-dir|--host|--port|--cli) i=$((i + 1)) ;;
      *) if [[ $arg == --* ]]; then warn "未沿用当前实例的启动参数：$arg"; fi ;;
    esac
    i=$((i + 1))
  done
  if (( ${#out[@]} > 0 )); then printf '%q ' "${out[@]}"; fi
}

# macOS ships no setsid(1); perl, which it does ship, can make the same
# setsid(2) call before exec'ing the command.
can_detach() {
  command -v setsid >/dev/null 2>&1 && return 0
  command -v perl >/dev/null 2>&1 && perl -MPOSIX -e 1 >/dev/null 2>&1
}

in_new_session() {
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@"
  elif can_detach; then
    # setsid() only fails for a process-group leader; running attached is still better than not at all.
    perl -MPOSIX=setsid -e 'setsid(); exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!\n"' -- "$@"
  else
    "$@"
  fi
}

# The log can hold a login URL with the access token, so nobody else may read it.
private_file() {
  ( umask 077 && : >>"$1" ) && chmod 600 "$1"
}

# Run a command in the environment resolved above, in its own session when
# possible (so the daemon outlives the caller; the CLI detaches it as well,
# this is belt and braces). Output is captured so a failure can be reported in
# order. A *non-login* shell on purpose: a login shell would re-read the profile
# and overwrite the PATH we just resolved.
run_detached() {
  local out
  out=$(mktemp)
  in_new_session "${BASH:-/bin/bash}" -c "$1" >"$out" 2>&1 || {
    cat "$out" >&2; rm -f "$out"; return 1; }
  cat "$out"
  rm -f "$out"
}

# Stream a command's output in the same environment, without detaching.
run_in_environment() {
  "${BASH:-/bin/bash}" -c "$1"
}

start_daemon() {
  run_detached "exec $(printf '%q' "$NODE_BIN") $(printf '%q' "$ENTRY") $(daemon_flags)"
}

daemon_flags() {
  local flags=(start --state-dir "$STATE_DIR" --host "$HOST" --port "$PORT" --cli "$CLI_PATH" --no-token)
  if [[ $AUTH -eq 1 ]]; then flags+=(--auth); else flags+=(--no-auth); fi
  printf '%q ' "${flags[@]}"
  inherit_flags
}

# The daemon must not carry the caller's agent environment into its terminals.
# Best effort: /proc does not exist on macOS, and a false alarm must not fail
# an otherwise good restart. The pattern is derived from the same lists that
# scrub_environment() removes, so the two cannot drift apart.
check_env_clean() {
  local pid=$1 environ leaked prefixes keys
  environ=/proc/$pid/environ
  [[ -r $environ ]] || return 0
  prefixes=$(printf '%s\n' "${LEAKED_PREFIXES[@]}" | paste -sd '|' -)
  keys=$(printf '%s\n' "${LEAKED_KEYS[@]}" | paste -sd '|' -)
  leaked=$(tr '\0' '\n' <"$environ" | sed -n 's/=.*//p' \
    | grep -E "^(${prefixes})|^(${keys})$" \
    | sort -u | tr '\n' ' ' || true)
  if [[ -n $leaked ]]; then
    warn "守护进程环境里混入了调用方变量：${leaked% }（终端里的 agent 会继承它们）"
    return 1
  fi
  return 0
}

# The daemon's own account of the environment it resolved: PATH source, the
# directories it added, and the variables it scrubbed. One line in the log is
# what makes a failed restart on a remote machine explainable.
report_environment() {
  local base=$1 jar token='' body='' summary=''
  jar=$(mktemp)
  if ! body=$(curl -fsS -m 3 -b "$jar" "$base/api/doctor" 2>/dev/null); then
    [[ -f $STATE_DIR/access-token ]] && token=$(<"$STATE_DIR/access-token")
    if [[ -n $token ]] && curl -fsS -m 3 -c "$jar" -X POST "$base/api/auth/login" \
        -H 'content-type: application/json' \
        --data-binary "$(printf '{\"token\":\"%s\"}' "$token")" >/dev/null 2>&1; then
      body=$(curl -fsS -m 5 -b "$jar" "$base/api/doctor" 2>/dev/null) || body=''
    fi
  fi
  rm -f "$jar"
  [[ -n $body ]] || { warn "无法读取守护进程的环境报告（/api/doctor）"; return 0; }
  summary=$(BODY="$body" "$NODE_BIN" -e '
    try {
      const report = JSON.parse(process.env.BODY).environment ?? {};
      const path = report.path ?? {};
      const lines = [
        `PATH 来源：${path.source ?? "unknown"}${path.note ? `（${path.note}）` : ""}`,
        `node：${report.node?.path ?? "?"} ${report.node?.version ?? ""}`,
        `补齐目录：${(path.added ?? []).length} 个`,
        `清洗变量：${(report.dropped ?? []).join(" ") || "无"}`,
      ];
      process.stdout.write(lines.join("\n"));
    } catch { process.exit(1); }
  ' 2>/dev/null) || summary=''
  if [[ -n $summary ]]; then
    while IFS= read -r line; do log "$line"; done <<<"$summary"
  fi
}

# Report the deployment's state. Returns non-zero only when it is unhealthy;
# a loopback-only bind or an unclean environment is a warning, not a failure.
report_state() {
  local url lan busy count titles token='' healthy=0
  read_daemon
  log "数据目录：$STATE_DIR"
  log "持久终端：$(terminal_count) 个（存放在 ${SOCK}，重启服务不影响）"
  if [[ -z $DAEMON_PID ]] || ! pid_alive "$DAEMON_PID"; then
    log "服务状态：已停止"
    return 1
  fi
  url=$(daemon_base_url "$DAEMON_HOST" "$DAEMON_PORT")
  log "服务状态：运行中 · PID $DAEMON_PID · ${DAEMON_HOST}:${DAEMON_PORT}"
  log "启动参数：$(printf '%s' "$DAEMON_ARGS")"

  if health_ok "$url" "$DAEMON_INSTANCE"; then
    log "服务健康检查：通过 · $url/"
    healthy=1
  else
    warn "$url/health 未返回当前实例（可能是端口被别的进程占用）"
  fi

  lan=$(lan_ip)
  if loopback_host "$DAEMON_HOST"; then
    warn "只监听回环地址：局域网（http://${lan:-<本机IP>}:$DAEMON_PORT/）访问不到"
  elif [[ -z $lan ]]; then
    warn "找不到本机局域网地址，无法验证其它设备是否可达"
  elif health_ok "http://$lan:$DAEMON_PORT" "$DAEMON_INSTANCE"; then
    log "局域网健康检查：通过 · http://$lan:$DAEMON_PORT/"
  else
    warn "局域网地址健康检查失败（绑定 ${DAEMON_HOST}）"
    healthy=0
  fi

  if busy=$(busy_sessions "$url"); then
    count=${busy%%$'\t'*}; titles=${busy#*$'\t'}
    if [[ $count == 0 ]]; then
      log "会话状态：没有执行中的轮次"
    else
      log "会话状态：$count 个会话正在执行${titles:+（${titles}）}"
    fi
  else
    warn "无法读取会话状态（接口未应答或需要登录）"
  fi
  check_env_clean "$DAEMON_PID" || true
  report_environment "$url"

  if [[ $AUTH -eq 1 ]]; then
    log "访问方式：需要登录令牌（令牌在 $STATE_DIR/access-token）"
    if [[ $SHOW_TOKEN -eq 1 && -f $STATE_DIR/access-token ]]; then
      token=$(<"$STATE_DIR/access-token")
      log "登录地址：http://${lan:-127.0.0.1}:$DAEMON_PORT/?token=$token"
    fi
  else
    log "访问方式：免令牌（仅限本机回环）"
  fi
  [[ $healthy -eq 1 ]]
}

# --- preflight: never touch a healthy service before these pass -------------
command -v curl >/dev/null 2>&1 || fail 1 "找不到 curl"
[[ -f $ENTRY ]] || fail 1 "尚未构建：找不到 ${ENTRY}（先在 $ROOT 执行 pnpm build，或用 --root 指定仓库）"

# The environment every process below inherits: credentials removed, PATH taken
# from the user's own shell. This runs before node is resolved so the daemon
# comes up under the user's node, not whichever node a system PATH exposes.
scrub_environment
resolve_environment

NODE_BIN=$(resolve_node) || true
[[ -n ${NODE_BIN:-} ]] || fail 1 "找不到 node"
# Verify the entry actually runs under the chosen node before stopping anything:
# a node whose native modules do not load (node-pty is a native addon) would
# otherwise leave the service stopped and unstartable.
"$NODE_BIN" "$ENTRY" --version >/dev/null 2>&1 \
  || fail 1 "${NODE_BIN} 无法运行 ${ENTRY}（node 版本或原生模块不匹配？）"
report_missing_clis
# An IP-shaped host must be a real IP; a name is left to the server to resolve.
if [[ $HOST =~ ^[0-9.]+$ ]]; then
  "$NODE_BIN" -e 'process.exit(require("node:net").isIP(process.argv[1]) ? 0 : 1)' "$HOST" \
    || fail 1 "监听地址不是合法的 IP：$HOST"
fi
if ! loopback_host "$HOST" && [[ $AUTH -eq 0 ]]; then
  fail 1 "免令牌访问只能绑定回环地址；局域网请去掉 --no-auth（服务端同样会拒绝）"
fi

read_daemon
RUNNING=0
if pid_alive "${DAEMON_PID:-}"; then RUNNING=1; fi

# A listener on the target port that is not the daemon we are about to stop
# means the restart cannot succeed: refuse while the service is still up.
listener=$(port_listener)
listener_pid=${listener%%$'\t'*}
listener_desc=${listener#*$'\t'}
if [[ -n $listener_pid && ( $RUNNING -eq 0 || $listener_pid != "$DAEMON_PID" ) ]]; then
  fail 1 "端口 $PORT 已被其它进程占用（pid ${listener_pid}）：$listener_desc"
fi

if [[ $MODE == check ]]; then
  if report_state; then exit 0; else exit 3; fi
fi

# --- build (before stopping: a broken build leaves the service up) ----------
if [[ $DO_BUILD -eq 1 ]]; then
  log "构建：在 $ROOT 执行 $PNPM_BIN build"
  if [[ $DRY_RUN -eq 0 ]]; then
    run_in_environment "cd $(printf '%q' "$ROOT") && exec $(printf '%q' "$PNPM_BIN") build" \
      || fail 2 "构建失败，现有服务保持不变"
  fi
fi

if [[ $DRY_RUN -eq 1 ]]; then
  if [[ $RUNNING -eq 1 ]]; then
    log "预演：将停止 PID $DAEMON_PID"
  else
    log "预演：服务当前已停止"
  fi
  inherited=''
  if [[ $RUNNING -eq 1 ]]; then inherited=$(inherit_flags); fi
  log "预演：将以 $HOST:$PORT 启动（$([[ $AUTH -eq 1 ]] && printf '令牌登录' || printf '免令牌')，cli=${CLI_PATH}）${inherited:+，沿用：$inherited}"
  exit 0
fi

# --- detach the commit phase ------------------------------------------------
# Everything below changes state, and the caller is usually an agent: when its
# turn ends while this call is still running (which is exactly what the idle
# wait below waits for), several harnesses kill the whole tool process group.
# Being killed just after the stop is how this deployment was left down on
# 2026-10-08 17:42 — the daemon shut down cleanly at 17:42:33 and no start ever
# followed. So the wait and the stop→start window run in a session of their
# own; this process only reports where the log went.
#
# "Only reports" has to include not waiting for that session, which is the
# fifth failure mode and cost this deployment a restart on 2026-10-08 22:53:
# when the caller is itself the busy session being waited for, waiting here is
# a deadlock — the caller's turn cannot end while its own tool call is
# outstanding — and it resolves only by hitting the idle deadline and failing.
# A piped stdout means nobody is reading this inline anyway, so a
# non-interactive caller is told where the log is and returned to immediately.
if [[ ${WDETACH_MARKER:-0} != 1 ]]; then
  if ! can_detach; then
    warn "找不到 setsid，也没有可用的 perl（POSIX 模块）：重启只能在当前会话里执行，调用方若被中断，服务可能停在「已停未起」。安装 util-linux（setsid）或 perl 可避免"
    # Without either the restart cannot be detached — but --log was still promised, and a
    # non-interactive caller reads the outcome from that file. Send the rest of this run there.
    if [[ -n $LOG_PATH && ! -t 1 ]]; then private_file "$LOG_PATH"; exec >"$LOG_PATH" 2>&1; fi
  else
    LOG_PATH=${LOG_PATH:-${TMPDIR:-/tmp}/riffet-restart-$(date +%Y%m%d-%H%M%S).log}
    private_file "$LOG_PATH" || fail 1 "无法创建日志文件：$LOG_PATH"
    child_args=(${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"})
    if [[ ! -t 1 && " ${ORIGINAL_ARGS[*]-} " != *" --wait-idle "* ]]; then
      child_args+=(--wait-idle "$AGENT_WAIT_IDLE")
    fi
    in_new_session env "WDETACH_MARKER=1" "$SCRIPT_PATH" ${child_args[@]+"${child_args[@]}"} --log "$LOG_PATH" \
      >"$LOG_PATH" 2>&1 &
    child=$!
    if [[ -t 1 ]]; then
      # 人在终端调用时，调用方自己不在被等待的会话里，等结果并把日志摊开更有用。
      log "重启在独立会话中执行（调用方可以安全结束本轮）：$LOG_PATH"
      code=0
      wait "$child" || code=$?
      if [[ -s $LOG_PATH ]]; then
        printf '\n' >&2
        tail -n 30 "$LOG_PATH" >&2
      fi
      log "重启日志：$LOG_PATH · 退出码 $code"
      exit "$code"
    fi
    # 非交互调用：立刻返回，否则就是上面那个死锁。调用方按日志判结果——成功以
    # 「重启完成」收尾，失败以「错误：」收尾。
    log "非交互调用：重启已在独立会话中继续，这里不阻塞等待（等待上限 ${AGENT_WAIT_IDLE}s；--wait-idle 可覆盖）"
    log "退出码 0 表示「已受理」，不代表重启已完成；结果见日志：$LOG_PATH"
    exit 0
  fi
fi
# 标记只服务于上面这一次判定，用完立即丢弃：它若随本进程传进守护进程，就会被
# 守护进程的终端与 agent 会话继承，让它们发起的下一次重启误判「已经脱离」，
# 把等待与停→起内联跑在调用方进程里——调用方一轮结束就正好停在「已停未起」。
unset WDETACH_MARKER
log "独立会话中执行重启（PID $$），调用方已脱离"

# --- wait for in-flight turns ----------------------------------------------
# Asked of the running daemon's own address, which is not necessarily the
# target address when the binding is being changed.
if [[ $RUNNING -eq 1 && $FORCE -eq 0 && ${WAIT_IDLE:-0} -gt 0 ]]; then
  running_url=$(daemon_base_url "$DAEMON_HOST" "$DAEMON_PORT")
  deadline=$(( SECONDS + WAIT_IDLE ))
  announced=0
  while :; do
    if busy=$(busy_sessions "$running_url"); then
      count=${busy%%$'\t'*}; titles=${busy#*$'\t'}
    else
      warn "无法读取会话状态，无法确认是否有轮次在执行；继续重启可能打断它们"
      break
    fi
    [[ $count == 0 ]] && break
    if (( SECONDS >= deadline )); then
      fail 4 "仍有 $count 个会话在执行（${titles:-无标题}）；重启会打断这些轮次。稍后重试，或用 --force 强制重启、--wait-idle 0 跳过等待"
    fi
    if (( announced == 0 )); then
      log "等待 $count 个执行中的会话结束（上限 ${WAIT_IDLE}s；--force 可跳过）"
      announced=1
    fi
    sleep 3
  done
  if (( announced == 1 )); then log "会话已空闲，继续重启"; fi
fi

# --- start preflight --------------------------------------------------------
# The environment was resolved and verified before anything was stopped; here we
# only restate what the daemon will run under, so the log explains the restart.
log "环境：node=${NODE_BIN} · PATH 来源=${PATH_SOURCE}"

# --- stop -------------------------------------------------------------------
if [[ $RUNNING -eq 1 ]]; then
  log "停止服务（PID ${DAEMON_PID}）"
  "$NODE_BIN" "$ENTRY" stop --state-dir "$STATE_DIR" \
    || fail 2 "停止失败；服务可能仍在运行，请看 $STATE_DIR/server.log"
else
  log "服务当前已停止，直接启动"
fi

# --- start ------------------------------------------------------------------
log "启动：$HOST:$PORT · cli=$CLI_PATH · $([[ $AUTH -eq 1 ]] && printf '令牌登录' || printf '免令牌')"
start_daemon || fail 2 "启动失败，请看 $STATE_DIR/server.log"

# --- verify -----------------------------------------------------------------
read_daemon
if [[ -z $DAEMON_PID ]] || ! pid_alive "$DAEMON_PID"; then
  fail 3 "启动后没有存活的守护进程，请看 $STATE_DIR/server.log"
fi
if [[ $DAEMON_HOST != "$HOST" || $DAEMON_PORT != "$PORT" ]]; then
  fail 3 "守护进程实际绑定 ${DAEMON_HOST}:${DAEMON_PORT}，与目标 ${HOST}:${PORT} 不一致"
fi
if health_ok "$(daemon_base_url "$DAEMON_HOST" "$DAEMON_PORT")" "$DAEMON_INSTANCE"; then
  :
else
  fail 3 "${DAEMON_HOST}:${DAEMON_PORT} 的 /health 校验失败，请看 $STATE_DIR/server.log"
fi
if ! loopback_host "$HOST"; then
  lan=$(lan_ip)
  if [[ -z $lan ]]; then
    warn "找不到本机局域网地址，无法验证其它设备是否可达"
  elif ! health_ok "http://$lan:$PORT" "$DAEMON_INSTANCE"; then
    warn "局域网地址 $lan:$PORT 校验失败；服务在运行，但别的机器可能连不上"
  fi
fi
check_env_clean "$DAEMON_PID" || true

log "重启完成"
if ! report_state; then
  fail 3 "重启后体检未通过，请看 $STATE_DIR/server.log"
fi
