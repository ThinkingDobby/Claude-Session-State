# claude-session-state

로컬에서 실행 중인 Claude Code 세션(대화형 + 백그라운드) 상태를 실시간으로 보여주는 대시보드.
`claude agents --json --all`을 주기적으로 읽어 SSE로 브라우저에 스트리밍한다.

## 요구사항

- Node.js 18 이상
- Claude Code CLI (`claude` 명령어가 PATH에 있어야 함)

## 설치

```bash
git clone <이 저장소 URL>
cd claude-session-state
./install.sh
```

`install.sh`가 하는 일:

- `bin/claude-session-state.sh`를 실행 가능하게 만든다.
- `~/.local/bin/claude-session-state` 심볼릭 링크를 생성한다.
- `~/.local/bin`이 PATH에 없으면 쉘 설정 파일(`.zshrc`/`.bashrc`/`.profile`)에 자동으로 추가한다.

설치 위치를 바꾸고 싶다면 환경변수로 지정할 수 있다:

```bash
CLAUDE_SESSION_STATE_BIN_DIR="$HOME/bin" ./install.sh
```

설치 후 PATH 변경을 적용하려면 새 터미널을 열거나 안내된 대로 `source`를 실행한다.

## 사용법

설치가 끝나면 어느 디렉토리에서든 아래 명령어를 그대로 쓸 수 있다.

```bash
claude-session-state          # 서버 시작(이미 떠 있으면 생략) + 브라우저 열기
claude-session-state start    # 위와 동일
claude-session-state stop     # 서버 종료
claude-session-state restart  # 재시작
claude-session-state status   # 현재 상태 확인
```

포트를 바꾸고 싶으면 `PORT` 환경변수를 쓴다 (기본값 4321):

```bash
PORT=5000 claude-session-state start
```

## 참고

- 서버 PID는 프로젝트 루트의 `.server.pid`에, 로그는 `.server.log`에 남는다 (둘 다 git에서 제외됨).
- 이미 같은 포트를 다른 프로세스가 쓰고 있으면 새로 띄우지 않고 그 프로세스를 그대로 사용한다고 안내한다. 이 경우 `stop`으로 종료할 수 없으니 해당 프로세스를 직접 종료해야 한다.
- 저장소를 옮기거나 심볼릭 링크가 아닌 방식으로 다시 설치하고 싶다면 `install.sh`를 다시 실행하면 된다(멱등적으로 동작).

## 삭제

```bash
rm ~/.local/bin/claude-session-state
```

필요하면 클론한 프로젝트 디렉토리도 삭제한다.
