#!/usr/bin/env bash
set -euo pipefail

# 이 스크립트가 있는 프로젝트 루트를 찾는다 (심볼릭 링크 없이 직접 실행된다고 가정).
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"

BIN_TARGET="$PROJECT_DIR/bin/claude-session-state.sh"
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
      */zsh) SHELL_RC="$HOME/.zshrc" ;;
      */bash) SHELL_RC="$HOME/.bashrc" ;;
      *) SHELL_RC="$HOME/.profile" ;;
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
echo "  claude-session-state start"
