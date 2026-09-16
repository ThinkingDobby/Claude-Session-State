#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${CLAUDE_SESSION_STATE_REPO:-https://github.com/ThinkingDobby/Claude-Session-State.git}"
SOURCE_DIR="${CLAUDE_SESSION_STATE_DIR:-$HOME/.local/share/claude-session-state}"
INSTALL_DIR="${CLAUDE_SESSION_STATE_BIN_DIR:-$HOME/.local/bin}"
LINK_PATH="$INSTALL_DIR/claude-session-state"

echo "== claude-session-state 설치 =="

if ! command -v node >/dev/null 2>&1; then
  echo "오류: node가 설치되어 있지 않습니다. Node.js 18 이상을 설치한 뒤 다시 실행하세요." >&2
  exit 1
fi

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "오류: Node.js 18 이상이 필요합니다 (현재: $(node -v))." >&2
  exit 1
fi

# curl | bash 로 실행되면 BASH_SOURCE 가 실제 파일을 가리키지 않는다.
# 옆에 bin/ 이 있으면 클론된 저장소 안에서 실행된 것으로 본다.
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/bin/claude-session-state.sh" ]; then
  PROJECT_DIR="$SCRIPT_DIR"
  echo "저장소에서 실행: $PROJECT_DIR"
else
  # 단독 실행. 소스를 고정 위치에 받아둔다.
  if ! command -v git >/dev/null 2>&1; then
    echo "오류: git이 설치되어 있지 않습니다." >&2
    exit 1
  fi

  if [ -d "$SOURCE_DIR/.git" ]; then
    echo "기존 설치 갱신: $SOURCE_DIR"
    git -C "$SOURCE_DIR" pull --ff-only
  elif [ -e "$SOURCE_DIR" ]; then
    echo "오류: $SOURCE_DIR 가 이미 있지만 git 저장소가 아닙니다. 직접 지우고 다시 실행하세요." >&2
    exit 1
  else
    echo "소스 내려받기: $SOURCE_DIR"
    mkdir -p "$(dirname "$SOURCE_DIR")"
    git clone --depth 1 "$REPO_URL" "$SOURCE_DIR"
  fi

  PROJECT_DIR="$SOURCE_DIR"
fi

BIN_TARGET="$PROJECT_DIR/bin/claude-session-state.sh"

if [ ! -f "$BIN_TARGET" ]; then
  echo "오류: 실행 스크립트를 찾을 수 없습니다: $BIN_TARGET" >&2
  exit 1
fi

chmod +x "$BIN_TARGET"

mkdir -p "$INSTALL_DIR"
ln -sf "$BIN_TARGET" "$LINK_PATH"
echo "심볼릭 링크 생성: $LINK_PATH -> $BIN_TARGET"

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    echo "$INSTALL_DIR 은 이미 PATH에 등록되어 있습니다."
    ;;
  *)
    SHELL_RC=""
    case "${SHELL:-}" in
      */zsh)
        SHELL_RC="$HOME/.zshrc"
        ;;
      */bash)
        # macOS 터미널은 bash 를 로그인 쉘로 띄우는데, 로그인 쉘은 .bashrc 가 아니라
        # .bash_profile 을 읽는다. 여기에 쓰지 않으면 새 터미널에서도 PATH 가 안 잡힌다.
        if [ "$(uname -s)" = "Darwin" ]; then
          SHELL_RC="$HOME/.bash_profile"
        else
          SHELL_RC="$HOME/.bashrc"
        fi
        ;;
      *)
        SHELL_RC="$HOME/.profile"
        ;;
    esac

    LINE="export PATH=\"$INSTALL_DIR:\$PATH\""
    if [ -f "$SHELL_RC" ] && grep -qF "$LINE" "$SHELL_RC"; then
      echo "$SHELL_RC 에 이미 PATH 설정이 있습니다."
    else
      printf '\n# claude-session-state\n%s\n' "$LINE" >> "$SHELL_RC"
      echo "$SHELL_RC 에 PATH 설정을 추가했습니다. 새 터미널을 열거나 다음을 실행하세요: source $SHELL_RC"
    fi
    ;;
esac

echo ""
echo "설치 완료. 아래 명령어로 시작하세요:"
echo "  $LINK_PATH start"
