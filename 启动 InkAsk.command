#!/bin/zsh
# ─────────────────────────────────────────────────────────────────────────────
# InkAsk 启动面板（本地工作副本）
#
# 双击本文件即可打开面板：先做体检，再把本地服务拉起来，然后给出
# 状态 / 启动 / 停止 / 重启 / 打开浏览器 / 日志 / 重建 / 开发模式 的菜单。
#
# 和发布包里的「启动 InkAsk.command」是同一个入口点（都跑 npm start、都要求
# Node.js 22+），多了服务管理与状态显示；发布包那份是前台一次性启动。
#
# 命令行（不进菜单，方便脚本和排障）：
#   ./启动\ InkAsk.command --check          只体检，不启动；有问题时退出码 1
#   ./启动\ InkAsk.command --start          后台启动并等到 /api/status 就绪
#   ./启动\ InkAsk.command --start --dev    开发模式（vite 5173 + API 8787）
#   ./启动\ InkAsk.command --status         运行中退出码 0，未运行 1
#   ./启动\ InkAsk.command --stop
#   ./启动\ InkAsk.command --restart
#   ./启动\ InkAsk.command --open           打开浏览器（服务需已运行）
#   ./启动\ InkAsk.command --log            打印服务日志末尾
#   ./启动\ InkAsk.command --build          重新生成 dist/
#   ./启动\ InkAsk.command --menu           强制进菜单（stdin 不是终端时也能测）
#
# 环境变量：
#   PORT=8787               服务端口（server/index.ts 读同名变量）
#   INKASK_STATE_DIR        日志与 PID 目录（默认 ~/Library/Logs/InkAsk）
#   INKASK_NO_AUTOSTART=1   打开面板时不自动拉起服务
# ─────────────────────────────────────────────────────────────────────────────

setopt pipefail

SCRIPT=${0:A}
ROOT=${SCRIPT:h}
PORT=${PORT:-8787}
DEV_PORT=${DEV_PORT:-5173}
BASE="http://127.0.0.1:${PORT}"
DEV_BASE="http://127.0.0.1:${DEV_PORT}"
NODE_MIN=22

if [[ "$(uname -s)" == Darwin ]]; then
  STATE=${INKASK_STATE_DIR:-$HOME/Library/Logs/InkAsk}
else
  STATE=${INKASK_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/inkask}
fi
LOG=$STATE/server.log
BUILD_LOG=$STATE/build.log
PIDFILE=$STATE/server.pid

cd -- "$ROOT" || exit 1
mkdir -p "$STATE" 2>/dev/null

if [[ -t 1 ]]; then
  C0=$'\e[0m'; CB=$'\e[1m'; CD=$'\e[2m'
  CG=$'\e[32m'; CY=$'\e[33m'; CR=$'\e[31m'; CC=$'\e[36m'
else
  C0=; CB=; CD=; CG=; CY=; CR=; CC=
fi

# ── 基础工具 ────────────────────────────────────────────────────────────────

have() { command -v "$1" >/dev/null 2>&1 }

load_node_env() {
  have node && return 0
  # 从 Finder 启动时 PATH 可能不含 nvm/fnm 的 node，尽力补一次。
  [[ -s $HOME/.nvm/nvm.sh ]] && source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  if ! have node; then
    for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do
      [[ -x $dir/node ]] && { PATH="$dir:$PATH"; export PATH; break }
    done
  fi
  have node
}

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null }

# 监听某端口的进程（没有就返回空）
pid_on_port() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n 1 }

http_ok() { curl -fsS -m 2 -o /dev/null "$1" 2>/dev/null }

cmdline_of() { ps -p "$1" -o command= 2>/dev/null }

# 某 PID 的全部后代（用于结束 npm → concurrently → tsx/vite 这一串）
descendants() {
  ps -Ao pid=,ppid= | awk -v root="$1" '
    { parent[$1] = $2 }
    END {
      queue[1] = root; head = 1; tail = 1
      while (head <= tail) {
        node = queue[head++]
        for (candidate in parent)
          if (parent[candidate] == node) queue[++tail] = candidate
      }
      for (i = 2; i <= tail; i++) print queue[i]
    }'
}

# ── PID 文件：mode|supervisorPid|port|startedAt ─────────────────────────────

state_mode()  { [[ -f $PIDFILE ]] && cut -d'|' -f1 "$PIDFILE" }
state_pid()   { [[ -f $PIDFILE ]] && cut -d'|' -f2 "$PIDFILE" }
state_port()  { [[ -f $PIDFILE ]] && cut -d'|' -f3 "$PIDFILE" }
state_since() { [[ -f $PIDFILE ]] && cut -d'|' -f4 "$PIDFILE" }

# PID 已死但文件还在 ⇒ 清掉，避免把上一次的残留当成本次状态
prune_stale_state() {
  [[ -f $PIDFILE ]] || return 0
  local pid=$(state_pid)
  [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null && return 0
  rm -f "$PIDFILE"
}

is_running() {
  prune_stale_state
  local pid=$(state_pid)
  [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null
}

current_urls() {
  if [[ "$(state_mode)" == dev ]]; then
    print -r -- "$DEV_BASE"
    print -r -- "$BASE"
  else
    print -r -- "$BASE"
  fi
}

wait_ready() {
  local url=$1 pid=$2 i=0
  while (( i < 80 )); do
    http_ok "$url/api/status" && return 0
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.5
    (( i++ ))
  done
  return 1
}

# ── 体检 ────────────────────────────────────────────────────────────────────

dep_ready()    { [[ -x node_modules/.bin/tsx ]] }
assets_ready() { [[ -f public/ocr-assets/worker.min.js && -d public/pdf-assets/wasm ]] }
dist_present() { [[ -f dist/index.html ]] }

# dist 落后于源码？返回 1 表示落后
dist_fresh() {
  dist_present || return 1
  [[ -z $(find index.html package.json vite.config.ts tsconfig.json src server \
            -newer dist/index.html -print -quit 2>/dev/null) ]]
}

inkask_git() {
  have git || return 1
  git -C "$ROOT" log -1 --format='%h %cs' -- . 2>/dev/null
}

inkask_dirty() {
  have git || return 1
  [[ -n $(git -C "$ROOT" status --porcelain -- . 2>/dev/null) ]]
}

model_line() {
  local json
  json=$(curl -fsS -m 2 "$BASE/api/status" 2>/dev/null) || return 1
  node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      let j;
      try { j = JSON.parse(s) } catch { return process.stdout.write("状态读取失败") }
      const head = j.configured ? `已配置 · ${j.providerId} / ${j.model}` : "未配置（页面「API 与模板」里填）";
      process.stdout.write(`${head} · context ${j.contextBudget} · 图片 ${j.supportsImages ? "开" : "关"}`);
    })' <<<"$json"
}

ensure_prereqs() {
  if ! load_node_env || ! have npm; then
    print -r -- "${CR}没有找到 Node.js / npm${C0}。请先安装 Node.js ${NODE_MIN} 或更新版本：https://nodejs.org/"
    return 1
  fi
  local major=$(node_major)
  if (( ${major:-0} < NODE_MIN )); then
    print -r -- "${CR}需要 Node.js ${NODE_MIN} 或更新版本，当前 $(node -v)${C0}"
    return 1
  fi
  if ! dep_ready; then
    print "首次启动：安装依赖（npm ci，需要网络）…"
    npm ci || { print -r -- "${CR}npm ci 失败${C0}"; return 1; }
  fi
  if ! assets_ready; then
    print "补齐 PDF / OCR 本地运行资源（npm run prepare:assets）…"
    npm run prepare:assets || { print -r -- "${CR}运行资源准备失败${C0}"; return 1; }
  fi
  if ! dist_present; then
    print "没有找到构建产物 dist/，先构建一次…"
    build_assets || return 1
  fi
  return 0
}

check_report() {
  load_node_env
  local bad=0
  print -r -- "${CB}InkAsk 体检${C0}  ${CD}$ROOT${C0}"
  print -r -- "  目录      $ROOT"

  if ! have node; then
    print -r -- "  Node      ${CR}未安装${C0}（需要 ${NODE_MIN}+）"
    bad=1
  else
    local major=$(node_major)
    if (( ${major:-0} < NODE_MIN )); then
      print -r -- "  Node      ${CR}$(node -v) 太低${C0}（需要 ${NODE_MIN}+）"
      bad=1
    else
      print -r -- "  Node      ${CG}$(node -v)${C0} · npm $(npm -v 2>/dev/null)"
    fi
  fi

  if dep_ready; then
    print -r -- "  依赖      ${CG}node_modules 就绪${C0}"
  else
    print -r -- "  依赖      ${CY}未安装${C0}（首次启动会自动 npm ci）"
    bad=1
  fi

  if assets_ready; then
    print -r -- "  运行资源  ${CG}pdf-assets / ocr-assets 就绪${C0}"
  else
    print -r -- "  运行资源  ${CY}缺 pdf-assets 或 ocr-assets${C0}（启动时自动 prepare:assets）"
    bad=1
  fi

  if ! dist_present; then
    print -r -- "  构建      ${CY}dist/ 缺失${C0}（启动时自动构建）"
    bad=1
  elif dist_fresh; then
    print -r -- "  构建      ${CG}dist/ 与源码同步${C0} · $(basename "$(ls -t dist/assets/index-*.js 2>/dev/null | head -n 1)")"
  else
    print -r -- "  构建      ${CY}dist/ 落后于源码${C0}（菜单 6 重新构建）"
  fi

  local git_version=$(inkask_git)
  if [[ -n $git_version ]]; then
    local dirty=""
    inkask_dirty && dirty="${CY} · 有未提交改动${C0}"
    print -r -- "  版本      $git_version$dirty"
  fi

  is_running && print -r -- "  服务      ${CG}已在运行${C0} PID $(state_pid) · $(state_mode) · ${(j:, :)$(current_urls)}" \
              || print -r -- "  服务      ${CD}未运行${C0}"

  if [[ $bad -eq 0 ]]; then
    print -r -- "${CG}体检通过${C0}：双击打开面板即可用，或 --start 直接拉起服务。"
    return 0
  fi
  print -r -- "${CY}体检有提示项${C0}：上面的橙色项会在启动时自动补齐；Node 不达标需要手动装。"
  return 1
}

# ── 启动 / 停止 ─────────────────────────────────────────────────────────────

# 新会话 + 新进程组地启动（node 的 detached 在 POSIX 上就是 setsid）：
# 关面板、关终端窗口都不会把它带走；停止时按进程组整组结束。
launch_detached() {
  local script='
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const [log, ...cmd] = process.argv.slice(1);
    const fd = fs.openSync(log, "a");
    const child = spawn(cmd[0], cmd.slice(1), {
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: process.cwd(),
      env: process.env,
    });
    child.on("error", () => process.exit(1));
    child.unref();
    process.stdout.write(String(child.pid));
  '
  node -e "$script" -- "$LOG" "$@" 2>/dev/null
}

start_server() {
  local mode=${1:-prod}
  if is_running; then
    print -r -- "服务已在运行（$(state_mode) 模式）：${(j:, :)$(current_urls)}"
    return 0
  fi
  local busy=$(pid_on_port "$PORT")
  if [[ -n $busy ]]; then
    print -r -- "${CR}端口 ${PORT} 已被 PID ${busy} 占用${C0}：$(cmdline_of "$busy")"
    print -r -- "先在菜单里选 2 停止它，或换端口：PORT=8790 再启动。"
    return 1
  fi
  ensure_prereqs || return 1

  [[ -f $LOG ]] && mv -f "$LOG" "$LOG.prev"
  local -a cmd=(npm start)
  [[ $mode == dev ]] && cmd=(npm run dev)
  print -r -- "启动（$mode）：${(j: :)cmd} · 日志 $LOG"
  local pid=$(launch_detached "${cmd[@]}")
  if [[ -z $pid ]]; then
    print -r -- "${CR}启动失败：没能创建服务进程${C0}"
    tail -n 20 "$LOG" 2>/dev/null
    return 1
  fi
  printf '%s|%s|%s|%s\n' "$mode" "$pid" "$PORT" "$(date +%s)" >"$PIDFILE"

  local url=$BASE
  [[ $mode == dev ]] && url=$DEV_BASE
  if wait_ready "$url" "$pid"; then
    print -r -- "${CG}已就绪${C0}：$url"
    [[ $mode == dev ]] && print -r -- "  （开发模式：页面 ${DEV_BASE}，API ${BASE}）"
    return 0
  fi
  print -r -- "${CR}启动没成功${C0}，日志末尾："
  tail -n 25 "$LOG" 2>/dev/null
  stop_server >/dev/null 2>&1
  return 1
}

stop_server() {
  prune_stale_state
  local pid=$(state_pid) pgid="" group=""
  local -a targets
  if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then
    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
    (( ${pgid:-0} == ${pid:-0} )) && group=$pid   # 只有「组长」才能按组结束
    targets+=(${(f)"$(descendants "$pid")"})
    targets+=($pid)
  fi
  local port lp
  for port in $PORT $DEV_PORT; do
    lp=$(pid_on_port $port)
    [[ -n $lp ]] && targets+=($lp)
  done
  targets=(${(u)targets})

  if (( ${#targets} == 0 )); then
    rm -f "$PIDFILE"
    print -r -- "服务未在运行。"
    return 0
  fi

  if [[ -n $group ]]; then
    print -r -- "停止进程组 -${group}（连 npm / tsx / vite 一起）"
    kill -TERM -"$group" 2>/dev/null
  else
    print -r -- "停止进程：${(j:, :)targets}"
  fi
  local t
  for t in $targets; do kill -TERM "$t" 2>/dev/null; done

  local i=0 alive=1
  while (( i < 24 )); do
    alive=0
    for t in $targets; do kill -0 "$t" 2>/dev/null && alive=1; done
    [[ -n $group ]] && pgrep -q -g "$group" 2>/dev/null && alive=1
    (( alive == 0 )) && break
    sleep 0.25
    (( i++ ))
  done
  [[ -n $group ]] && kill -KILL -"$group" 2>/dev/null
  for t in $targets; do kill -0 "$t" 2>/dev/null && kill -KILL "$t" 2>/dev/null; done
  rm -f "$PIDFILE"

  sleep 0.3
  if [[ -n $(pid_on_port "$PORT") ]]; then
    print -r -- "${CR}端口 ${PORT} 仍被占用${C0}：$(cmdline_of "$(pid_on_port "$PORT")")"
    return 1
  fi
  print -r -- "${CG}已停止${C0}"
  return 0
}

restart_server() {
  local mode=$(state_mode)
  [[ -z $mode ]] && mode=prod
  if is_running; then
    stop_server || return 1
  elif [[ -n $(pid_on_port "$PORT") ]]; then
    print -r -- "${CY}端口 ${PORT} 上是外部进程${C0}：$(cmdline_of "$(pid_on_port "$PORT")")"
    print -r -- "先选 2 停止，再启动。"
    return 1
  fi
  start_server "$mode"
}

open_browser() {
  local url=$1
  if ! is_running; then
    print -r -- "服务没在运行，先启动（菜单 1 或 --start）。"
    return 1
  fi
  if ! http_ok "$url"; then
    print -r -- "${CY}服务还没响应${C0}（可能正在启动）：$url"
    return 1
  fi
  if [[ "$(uname -s)" == Darwin ]]; then
    open "$url" && print -r -- "已在浏览器打开：$url"
  else
    print -r -- "请手动打开：$url"
  fi
}

show_log() {
  if [[ ! -f $LOG ]]; then
    print -r -- "还没有日志（服务从没由本面板启动过）。日志路径：$LOG"
    return 0
  fi
  print -r -- "${CD}── $LOG（末尾 40 行）──${C0}"
  tail -n 40 "$LOG"
  print -r -- "${CD}──────────────────────────────${C0}"
}

build_assets() {
  if ! load_node_env || ! dep_ready; then
    print -r -- "${CR}依赖还没装好，先启动一次让面板自动 npm ci${C0}"
    return 1
  fi
  print "构建：npm run build（tsc --noEmit + vite build）"
  local t0=$(date +%s)
  if npm run build >>"$BUILD_LOG" 2>&1; then
    print -r -- "${CG}构建完成${C0} · $(( $(date +%s) - t0 ))s · $(basename "$(ls -t dist/assets/index-*.js 2>/dev/null | head -n 1)")"
    return 0
  fi
  print -r -- "${CR}构建失败${C0}，末尾："
  tail -n 25 "$BUILD_LOG" 2>/dev/null
  return 1
}

# ── 面板 ────────────────────────────────────────────────────────────────────

render_panel() {
  prune_stale_state
  local mode=$(state_mode) pid=$(state_pid) et="" svc_line=""

  if is_running; then
    et=$(ps -p "$pid" -o etime= 2>/dev/null | tr -d ' ')
    if http_ok "$BASE/api/status"; then
      local -a urls=(${(f)"$(current_urls)"})
      svc_line="${CG}● 运行中${C0}  ${CC}${(j: · :)urls}${C0}  ${CD}PID ${pid} · 已运行 ${et}${C0}"
    else
      svc_line="${CY}● 启动中${C0}  PID ${pid} · 还没响应"
    fi
  else
    local busy=$(pid_on_port "$PORT")
    if [[ -n $busy ]]; then
      svc_line="${CY}● 端口 ${PORT} 被 PID ${busy} 占着（不是本面板启动的）${C0}"
    else
      svc_line="${CD}○ 未运行${C0}"
    fi
  fi

  local node_desc="—"
  if load_node_env; then
    node_desc="$(node -v)"
    dep_ready && node_desc+=" · 依赖就绪" || node_desc+=" · ${CY}依赖未装${C0}"
    assets_ready || node_desc+=" · ${CY}运行资源缺${C0}"
  else
    node_desc="${CR}未找到 node${C0}"
  fi

  local build_desc
  if ! dist_present; then
    build_desc="${CY}dist/ 缺失${C0}"
  elif dist_fresh; then
    build_desc="${CG}与源码同步${C0} ${CD}$(basename "$(ls -t dist/assets/index-*.js 2>/dev/null | head -n 1)")${C0}"
  else
    build_desc="${CY}落后于源码（按 6 重建）${C0}"
  fi

  local version=$(inkask_git)
  [[ -z $version ]] && version="非 git 目录"
  inkask_dirty && version+=" ${CY}· 有未提交改动${C0}"

  print
  print -r -- "${CB}══ InkAsk 启动面板 ══════════════════════════════════════════════${C0}"
  print -r -- " ${CD}目录${C0}    $ROOT"
  print -r -- " ${CD}版本${C0}    $(node -p 'require("./package.json").version' 2>/dev/null || echo '?') · $version"
  print -r -- " ${CD}Node${C0}    $node_desc ${CD}(需要 ${NODE_MIN}+)${C0}"
  print -r -- " ${CD}构建${C0}    $build_desc"
  print -r -- " ${CD}状态${C0}    $svc_line"
  if is_running && http_ok "$BASE/api/status"; then
    print -r -- " ${CD}模型${C0}    $(model_line)"
  fi
  print -r -- " ${CD}日志${C0}    $LOG"
  print -r -- "${CD}───────────────────────────────────────────────────────────────${C0}"
  print -r -- "  ${CB}1${C0} 启动   ${CB}2${C0} 停止   ${CB}3${C0} 重启   ${CB}4${C0} 打开浏览器"
  print -r -- "  ${CB}5${C0} 日志   ${CB}6${C0} 重建   ${CB}7${C0} 开发模式  ${CB}8${C0} 项目目录"
  print -r -- "  ${CB}9${C0} 刷新   ${CB}q${C0} 退出"
  print -r -- "${CD}───────────────────────────────────────────────────────────────${C0}"
}

confirm_stop_foreign() {
  local busy=$(pid_on_port "$PORT")
  print -r -- "${CY}端口 ${PORT} 上不是本面板启动的进程${C0}：$(cmdline_of "$busy")"
  print -n -- "确认停止它？[y/N] "
  local a
  read -r a
  [[ $a == [yY]* ]] && stop_server || print -r -- "已取消。"
}

# Ctrl+C：zsh 的 read 会把被打断的读操作接着等下去（实测），只置标记是回不到循环的，
# 所以在 trap 里直接打印收场提示并退出（服务留在后台，给一条停止命令）。
typeset -g ASK_ON_EXIT=0
on_int() {
  print -r -- ""
  if is_running; then
    print -r -- "已中断。服务继续在后台：$(current_urls | head -n 1)"
    print -r -- "停止：\"$SCRIPT\" --stop"
  else
    print -r -- "已中断。"
  fi
  exit 130
}
trap on_int INT

menu_loop() {
  local choice
  ASK_ON_EXIT=0

  if (( ! ${INKASK_NO_AUTOSTART:-0} )) && ! is_running; then
    if [[ -z $(pid_on_port "$PORT") ]]; then
      print -r -- "${CD}面板启动时顺手把服务拉起来（要跳过请设 INKASK_NO_AUTOSTART=1）${C0}"
      start_server prod
    fi
  fi

  while :; do
    render_panel
    print -n -- "选择 › "
    read -r choice || break
    choice=${choice//[[:space:]]/}

    case $choice in
      1) start_server prod ;;
      2)
        if is_running; then stop_server
        elif [[ -n $(pid_on_port "$PORT") ]]; then confirm_stop_foreign
        else print -r -- "服务没在运行。"
        fi ;;
      3) restart_server ;;
      4) open_browser "$(current_urls | head -n 1)" ;;
      5) show_log ;;
      6) build_assets ;;
      7)
        if is_running && [[ "$(state_mode)" != dev ]]; then
          print -r -- "先停掉正式服务再进开发模式。"
          stop_server && start_server dev
        else
          start_server dev
        fi ;;
      8) [[ "$(uname -s)" == Darwin ]] && open "$ROOT" || print -r -- "$ROOT" ;;
      9) ;;
      q|Q) ASK_ON_EXIT=1; break ;;
      *) print -r -- "可选 1-9 或 q。" ;;
    esac
    print
  done

  if is_running; then
    if (( ASK_ON_EXIT )); then
      print -n -- "服务还在后台（$(state_mode) · $(state_pid)）。退出面板时停掉它？[y/N] "
      local a
      read -r a
      if [[ $a == [yY]* ]]; then
        stop_server
      else
        print -r -- "服务继续在跑：$(current_urls | head -n 1)　（以后用 --stop 停）"
      fi
    else
      # Ctrl+C / Ctrl+D 走这条：不回问，服务留着，给一句怎么停。
      print -r -- "服务继续在后台：$(current_urls | head -n 1)　（停止：$(printf '%s' "$SCRIPT" | sed 's/ /\\ /g') --stop，或再开面板按 2）"
    fi
  fi
  print -r -- "面板已退出。"
}

usage() {
  sed -n '5,26p' "$SCRIPT" | sed 's/^# \{0,1\}//'
}

# ── 入口 ────────────────────────────────────────────────────────────────────

action=""
dev=0
force_menu=0
for arg in "$@"; do
  case $arg in
    --check) action=check ;;
    --start) action=start ;;
    --stop) action=stop ;;
    --restart) action=restart ;;
    --status) action=status ;;
    --open) action=open ;;
    --log) action=log ;;
    --build) action=build ;;
    --menu) action=menu; force_menu=1 ;;
    --dev) dev=1 ;;
    --no-autostart) export INKASK_NO_AUTOSTART=1 ;;
    -h|--help) usage; exit 0 ;;
    *) print -r -- "未知参数：$arg"; print -r -- "试试 --help"; exit 2 ;;
  esac
done

case $action in
  check)
    check_report; exit $? ;;
  start)
    [[ $dev -eq 1 ]] && start_server dev || start_server prod
    exit $? ;;
  stop)
    stop_server; exit $? ;;
  restart)
    restart_server; exit $? ;;
  status)
    prune_stale_state
    if is_running; then
      print -r -- "running  $(state_mode)  pid=$(state_pid)  url=$(current_urls | head -n 1)"
      http_ok "$BASE/api/status" && print -r -- "model    $(model_line)"
      exit 0
    fi
    busy=$(pid_on_port "$PORT")
    if [[ -n $busy ]]; then
      print -r -- "foreign  port=${PORT}  pid=${busy}  $(cmdline_of "$busy")"
      exit 1
    fi
    print -r -- "stopped"
    exit 1 ;;
  open)
    open_browser "$(current_urls | head -n 1)"; exit $? ;;
  log)
    show_log; exit 0 ;;
  build)
    build_assets; exit $? ;;
  menu)
    menu_loop; exit 0 ;;
esac

# 没给参数：终端里进面板，管道/脚本里只报状态，避免卡住
if [[ -t 0 ]]; then
  menu_loop
else
  render_panel
  print -r -- "${CD}（stdin 不是终端，没进菜单；要用菜单请加 --menu）${C0}"
fi
