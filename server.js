'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 4321;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 2000;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const PUBLIC_DIR = path.join(__dirname, 'public');

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
        resolve({ ok: true, sessions, fetchedAt: Date.now() });
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
