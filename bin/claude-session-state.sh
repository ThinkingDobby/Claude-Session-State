#!/usr/bin/env bash
set -euo pipefail

# 심볼릭 링크로 실행돼도 실제 프로젝트 경로를 찾도록 링크를 따라간다.
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
BIN_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
PROJECT_DIR="$(cd -P "$BIN_DIR/.." && pwd)"

PORT="${PORT:-4321}"
PID_FILE="$PROJECT_DIR/.server.pid"
LOG_FILE="$PROJECT_DIR/.server.log"
URL="http://localhost:$PORT"
ACTION="${1:-start}"

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

port_responding() {
  curl -s -o /dev/null "$URL"
}

start_server() {
  if is_running; then
    echo "이미 실행 중: $URL (pid $(cat "$PID_FILE"))"
    return
  fi

  if port_responding; then
    rm -f "$PID_FILE"
    echo "포트 $PORT 에서 이미 다른 프로세스가 서버를 띄우고 있어 그대로 사용합니다: $URL"
    return
  fi

  cd "$PROJECT_DIR"
  nohup node server.js > "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  disown

  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    port_responding && break
    sleep 0.2
  done

  if kill -0 "$pid" 2>/dev/null && port_responding; then
    echo "서버 시작됨: $URL (pid $pid, 로그: $LOG_FILE)"
  else
    rm -f "$PID_FILE"
    echo "서버 시작 실패. 로그 확인:"
    tail -n 20 "$LOG_FILE" || true
    exit 1
  fi
}

stop_server() {
  if is_running; then
    kill "$(cat "$PID_FILE")"
    rm -f "$PID_FILE"
    echo "서버 종료됨"
  elif port_responding; then
    echo "포트 $PORT 의 서버는 이 스크립트가 시작한 것이 아니라 직접 종료할 수 없습니다."
  else
    echo "실행 중인 서버가 없습니다"
  fi
}

open_browser() {
  if command -v open >/dev/null 2>&1; then
    open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"
  else
    echo "브라우저를 자동으로 열 수 없습니다. $URL 을 직접 열어주세요."
  fi
}

case "$ACTION" in
  start)
    start_server
    open_browser
    ;;
  stop)
    stop_server
    ;;
  restart)
    stop_server
    start_server
    open_browser
    ;;
  status)
    if is_running; then
      echo "실행 중: $URL (pid $(cat "$PID_FILE"))"
    elif port_responding; then
      echo "실행 중(외부 프로세스): $URL"
    else
      echo "중지됨"
    fi
    ;;
  *)
    echo "사용법: claude-session-state [start|stop|restart|status]"
    exit 1
    ;;
esac
