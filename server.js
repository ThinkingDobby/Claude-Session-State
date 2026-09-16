'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 4321;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 2000;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PID_FILE = path.join(__dirname, '.server.pid');
const LOG_FILE = path.join(__dirname, '.server.log');

// sessionId -> 트랜스크립트가 들어있는 프로젝트 디렉터리 이름.
// cwd를 그대로 인코딩해서 추정하면 안 된다 (worktree 이동 등으로 실제 저장 위치와 어긋날 수 있음).
const transcriptDirCache = new Map();

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

// 트랜스크립트 파일은 append-only라서 mtime이 곧 마지막 요청/응답 시각과 같다.
async function attachLastActivity(sessions) {
  await Promise.all(sessions.map(async (session) => {
    if (!session.sessionId) return;
    const transcriptPath = await findTranscriptPath(session.sessionId);
    if (!transcriptPath) return;
    try {
      const stat = await fs.promises.stat(transcriptPath);
      session.lastActivityAt = stat.mtimeMs;
    } catch (_) {
      // 폴링 사이 파일이 사라졌을 수 있음, 무시
    }
  }));
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

async function pollAndBroadcast() {
  const data = await fetchSessions();
  lastPayload = data;
  const chunk = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(chunk);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/sessions') {
    const data = lastPayload || await fetchSessions();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
    return;
  }

  if (req.url === '/api/restart' && req.method === 'POST') {
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

server.listen(PORT, () => {
  console.log(`claude-session-state 대시보드 실행 중: http://localhost:${PORT}`);
  console.log(`(${POLL_INTERVAL_MS}ms마다 "${CLAUDE_BIN} agents --json --all" 폴링)`);
});
