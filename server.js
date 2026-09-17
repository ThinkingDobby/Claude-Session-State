'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 4321;
// 기본은 루프백. 이 대시보드는 세션 경로 등 로컬 정보를 인증 없이 노출하므로
// 모든 인터페이스에 열지 않는다. 다른 기기에서 봐야 하면 SSH 터널을 쓴다.
const HOST = process.env.HOST || '127.0.0.1';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 2000;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// 트랜스크립트는 첨부와 도구 결과 때문에 수 MB까지 커진다.
// 최근 대화만 보여주면 되므로 파일 끝부분만 읽는다.
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
// 스크린샷 같은 첨부가 들어간 세션은 꼬리 512KB에 대화가 몇 개 안 들어온다.
// 원하는 턴 수가 찰 때까지 범위를 넓히되 상한을 둔다.
const TRANSCRIPT_MAX_TAIL_BYTES = 8 * 1024 * 1024;
// 세션에 선택된 모델은 마지막 assistant 레코드에 남는다.
// 매 폴링마다 파일을 다시 읽지 않도록 mtime 과 시간 간격으로 캐싱한다.
const MODEL_TAIL_BYTES = 256 * 1024;
const MODEL_REFRESH_MS = 15000;
const TRANSCRIPT_MAX_TURNS = 20;
const TRANSCRIPT_MAX_CHARS = 2000;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 백그라운드 작업 id 는 짧은 16진수다. 셸로 넘기기 전에 형식을 확인한다.
const JOB_ID_RE = /^[0-9a-f]{4,16}$/i;
const PID_FILE = path.join(__dirname, '.server.pid');
const LOG_FILE = path.join(__dirname, '.server.log');

// sessionId -> 트랜스크립트가 들어있는 프로젝트 디렉터리 이름.
// cwd를 그대로 인코딩해서 추정하면 안 된다 (worktree 이동 등으로 실제 저장 위치와 어긋날 수 있음).
const transcriptDirCache = new Map();

// sessionId -> { model, mtimeMs, checkedAt }
const sessionModelCache = new Map();

async function findTranscriptPath(sessionId) {
  const cachedDir = transcriptDirCache.get(sessionId);
  if (cachedDir) {
    const cachedPath = path.join(CLAUDE_PROJECTS_DIR, cachedDir, `${sessionId}.jsonl`);
    try {
      await fs.promises.access(cachedPath);
      return cachedPath;
    } catch (_) {
      transcriptDirCache.delete(sessionId);
    }
  }

  let entries;
  try {
    entries = await fs.promises.readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  } catch (_) {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(CLAUDE_PROJECTS_DIR, entry.name, `${sessionId}.jsonl`);
    try {
      await fs.promises.access(candidate);
      transcriptDirCache.set(sessionId, entry.name);
      return candidate;
    } catch (_) {
      // 이 디렉터리는 아님, 다음으로
    }
  }
  return null;
}

// 파일 끝에서부터 거슬러 올라가며 가장 최근 assistant 레코드의 모델을 찾는다.
async function findSessionModel(sessionId, transcriptPath, mtimeMs) {
  const cached = sessionModelCache.get(sessionId);
  // 파일이 그대로면 모델도 그대로다.
  if (cached && cached.mtimeMs === mtimeMs) return cached.model;
  // 활발한 세션은 mtime 이 계속 바뀌므로 재확인 간격을 둔다.
  if (cached && Date.now() - cached.checkedAt < MODEL_REFRESH_MS) return cached.model;

  let model = cached ? cached.model : null;
  try {
    const { text } = await readTranscriptTail(transcriptPath, MODEL_TAIL_BYTES);
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line.includes('"model"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (entry.type === 'assistant' && entry.message && entry.message.model) {
        model = entry.message.model;
        break;
      }
    }
  } catch (_) {
    // 읽기에 실패하면 직전 값을 그대로 쓴다.
  }

  sessionModelCache.set(sessionId, { model, mtimeMs, checkedAt: Date.now() });
  return model;
}

// 트랜스크립트 파일은 append-only라서 mtime이 곧 마지막 요청/응답 시각과 같다.
async function attachLastActivity(sessions) {
  await Promise.all(sessions.map(async (session) => {
    if (!session.sessionId) return;
    const transcriptPath = await findTranscriptPath(session.sessionId);
    if (!transcriptPath) return;
    try {
      const stat = await fs.promises.stat(transcriptPath);
      session.lastActivityAt = stat.mtimeMs;
      session.model = await findSessionModel(session.sessionId, transcriptPath, stat.mtimeMs);
    } catch (_) {
      // 폴링 사이 파일이 사라졌을 수 있음, 무시
    }
  }));

  // 끝난 세션의 캐시는 정리한다.
  const liveIds = new Set(sessions.map((session) => session.sessionId).filter(Boolean));
  for (const sessionId of sessionModelCache.keys()) {
    if (!liveIds.has(sessionId)) sessionModelCache.delete(sessionId);
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function fetchSessions() {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, ['agents', '--json', '--all'], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: (stderr || err.message).trim(), sessions: [], fetchedAt: Date.now() });
        return;
      }
      try {
        const sessions = JSON.parse(stdout);
        attachLastActivity(sessions).then(() => {
          resolve({ ok: true, sessions, fetchedAt: Date.now() });
        });
      } catch (parseErr) {
        resolve({ ok: false, error: `JSON 파싱 실패: ${parseErr.message}`, sessions: [], fetchedAt: Date.now() });
      }
    });
  });
}

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('찾을 수 없음');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const sseClients = new Set();
let lastPayload = null;
let restarting = false;

// 현재 프로세스가 완전히 내려간 뒤 같은 설정으로 새 서버를 띄우는 분리된 셸을 남기고 종료한다.
// PID 파일도 갱신해서 bin/claude-session-state.sh 의 stop/status 와 어긋나지 않게 한다.
function restartSelf() {
  if (restarting) return;
  restarting = true;

  const script = [
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.1; done`,
    `cd ${JSON.stringify(__dirname)}`,
    `nohup ${JSON.stringify(process.execPath)} server.js >> ${JSON.stringify(LOG_FILE)} 2>&1 &`,
    `echo $! > ${JSON.stringify(PID_FILE)}`,
  ].join('\n');

  const child = spawn('/bin/bash', ['-c', script], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  for (const res of sseClients) {
    try { res.end(); } catch (_) { /* 이미 닫힌 연결 */ }
  }
  sseClients.clear();
  server.close();
  setTimeout(() => process.exit(0), 200);
}

// 루프백 바인딩만으로는 브라우저에서 오는 요청을 막지 못한다.
// 악성 페이지가 localhost 로 POST 를 보낼 수 있으므로 출처를 확인한다.
// 브라우저가 아닌 클라이언트(curl 등)는 두 헤더 모두 보내지 않으므로 통과시킨다.
function isSameOriginRequest(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';

  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (_) {
    return false;
  }
}

async function readTranscriptTail(filePath, tailBytes) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - tailBytes);
    const fromStart = start === 0;
    const length = size - start;
    if (length === 0) return { text: '', fromStart: true };

    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString('utf8');
    if (fromStart) return { text, fromStart };

    // 중간부터 읽었다면 첫 줄은 깨진 JSON이므로 버린다.
    const firstNewline = text.indexOf('\n');
    return { text: firstNewline === -1 ? '' : text.slice(firstNewline + 1), fromStart };
  } finally {
    await handle.close();
  }
}

// 턴이 충분히 모일 때까지 읽는 범위를 넓혀가며 다시 파싱한다.
async function collectRecentTurns(filePath) {
  let tailBytes = TRANSCRIPT_TAIL_BYTES;
  let turns = [];

  while (true) {
    const { text, fromStart } = await readTranscriptTail(filePath, tailBytes);
    turns = buildTurns(text);
    if (turns.length >= TRANSCRIPT_MAX_TURNS) break;
    if (fromStart || tailBytes >= TRANSCRIPT_MAX_TAIL_BYTES) break;
    tailBytes = Math.min(tailBytes * 4, TRANSCRIPT_MAX_TAIL_BYTES);
  }

  return turns;
}

// assistant 는 text 블록만, user 는 문자열이나 text 블록만 취한다.
// thinking / tool_use / tool_result 는 대화 미리보기에 넣지 않는다.
function extractTurnText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

// 시스템이 끼워 넣는 블록은 사용자가 실제로 입력한 내용이 아니다.
function stripInjectedBlocks(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g, '')
    .replace(/<command-[a-z]+>[\s\S]*?<\/command-[a-z]+>/g, '')
    .trim();
}

function buildTurns(rawText) {
  const turns = [];
  for (const line of rawText.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    if (entry.isSidechain) continue;

    const cleaned = stripInjectedBlocks(extractTurnText(entry.message));
    if (!cleaned) continue;

    const truncated = cleaned.length > TRANSCRIPT_MAX_CHARS;
    turns.push({
      role: entry.type,
      timestamp: entry.timestamp || null,
      text: truncated ? `${cleaned.slice(0, TRANSCRIPT_MAX_CHARS)}…` : cleaned,
      truncated,
    });
  }
  return turns;
}

// claude rm 은 워크트리까지 지우며, 커밋되지 않은 변경이 있으면 거부한다.
// 그래서 성공을 가정하지 않고 명령 출력을 그대로 돌려준다.
function removeBackgroundJob(jobId, res) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  if (!JOB_ID_RE.test(jobId)) {
    send(400, { ok: false, error: '유효하지 않은 작업 ID' });
    return;
  }

  execFile(CLAUDE_BIN, ['rm', jobId], { timeout: 30000 }, (err, stdout, stderr) => {
    const output = `${stdout || ''}${stderr || ''}`.trim();
    if (err) {
      send(200, { ok: false, error: output || err.message });
      return;
    }
    // 폴링을 기다리지 않고 바로 반영되도록 즉시 갱신한다.
    pollAndBroadcast();
    send(200, { ok: true, output });
  });
}

async function handleTranscript(sessionId, res) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  if (!SESSION_ID_RE.test(sessionId)) {
    send(400, { ok: false, error: '유효하지 않은 세션 ID' });
    return;
  }

  const transcriptPath = await findTranscriptPath(sessionId);
  if (!transcriptPath) {
    send(404, { ok: false, error: '이 세션의 대화 기록을 찾을 수 없습니다.' });
    return;
  }

  try {
    const turns = await collectRecentTurns(transcriptPath);
    send(200, { ok: true, sessionId, turns: turns.slice(-TRANSCRIPT_MAX_TURNS) });
  } catch (err) {
    send(500, { ok: false, error: `대화 기록을 읽지 못했습니다: ${err.message}` });
  }
}

async function pollAndBroadcast() {
  const data = await fetchSessions();
  lastPayload = data;
  const chunk = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(chunk);
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (requestUrl.pathname === '/api/transcript') {
    await handleTranscript(requestUrl.searchParams.get('sessionId') || '', res);
    return;
  }

  if (req.url === '/api/sessions') {
    const data = lastPayload || await fetchSessions();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
    return;
  }

  if (requestUrl.pathname === '/api/background/remove' && req.method === 'POST') {
    if (!isSameOriginRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '허용되지 않은 출처의 요청' }));
      return;
    }
    removeBackgroundJob(requestUrl.searchParams.get('id') || '', res);
    return;
  }

  if (req.url === '/api/restart' && req.method === 'POST') {
    if (!isSameOriginRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '허용되지 않은 출처의 요청' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    restartSelf();
    return;
  }

  if (req.url === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);

    if (lastPayload) {
      res.write(`data: ${JSON.stringify(lastPayload)}\n\n`);
    }

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  serveStatic(req, res);
});

pollAndBroadcast();
setInterval(pollAndBroadcast, POLL_INTERVAL_MS);

server.listen(PORT, HOST, () => {
  console.log(`claude-session-state 대시보드 실행 중: http://localhost:${PORT} (바인딩: ${HOST})`);
  console.log(`(${POLL_INTERVAL_MS}ms마다 "${CLAUDE_BIN} agents --json --all" 폴링)`);
});
