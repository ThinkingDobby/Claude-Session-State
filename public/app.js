'use strict';

const gridEl = document.getElementById('grid');
const emptyEl = document.getElementById('empty-state');
const errorEl = document.getElementById('error-banner');
const lastUpdatedEl = document.getElementById('last-updated');
const connDot = document.getElementById('conn-dot');
const notifyBtn = document.getElementById('notify-btn');
const filterButtons = document.querySelectorAll('#filters button');

let currentSessions = [];
let previousByPid = new Map();
let activeFilter = 'all';
let notifyEnabled = Notification && Notification.permission === 'granted';

// interactive 세션은 status 필드, background 세션은 state 필드를 쓴다.
function rawStatus(session) {
  return session.status || session.state || '';
}

function classify(rawValue) {
  if (rawValue === 'busy' || rawValue === 'running') return 'busy';
  if (rawValue === 'idle' || rawValue === 'waiting') return 'idle';
  if (rawValue === 'completed' || rawValue === 'done') return 'completed';
  if (rawValue === 'failed' || rawValue === 'error') return 'failed';
  if (rawValue === 'stopped' || rawValue === 'exited' || rawValue === 'killed') return 'stopped';
  return 'other';
}

const STATUS_LABELS = {
  busy: '작업 중',
  running: '작업 중',
  idle: '대기 중',
  waiting: '입력 필요',
  completed: '완료',
  done: '완료',
  failed: '실패',
  error: '실패',
  stopped: '중지됨',
  exited: '중지됨',
  killed: '중지됨',
};

function statusLabel(rawValue) {
  return STATUS_LABELS[rawValue] || rawValue || '알 수 없음';
}

function sessionKey(session) {
  return session.pid != null ? `p:${session.pid}` : `i:${session.id || session.sessionId}`;
}

function displayName(session) {
  const name = session.name || '(이름 없음)';
  return name.length > 48 ? `${name.slice(0, 45)}…` : name;
}

function formatElapsed(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}초 전 시작`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전 시작`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전 시작`;
  const days = Math.floor(hours / 24);
  return `${days}일 전 시작`;
}

function shortCwd(cwd) {
  const home = cwd && cwd.startsWith('/Users/') ? cwd.replace(/^\/Users\/[^/]+/, '~') : cwd;
  return home;
}

function notify(title, body) {
  if (!notifyEnabled) return;
  try {
    new Notification(title, { body });
  } catch (_) {
    // Notification 생성 실패는 조용히 무시 (권한 취소 등 일시적 상황)
  }
}

function filterBucket(rawValue) {
  const cls = classify(rawValue);
  return cls === 'busy' || cls === 'idle' ? cls : 'other';
}

function diffAndNotify(nextByKey) {
  for (const [key, session] of nextByKey) {
    const prev = previousByPid.get(key);
    const prevRaw = prev && rawStatus(prev);
    const nextRaw = rawStatus(session);
    if (prev && prevRaw === 'busy' && nextRaw !== 'busy') {
      notify(`✅ ${displayName(session)} 작업 완료`, shortCwd(session.cwd));
    }
  }
  for (const [key, prev] of previousByPid) {
    if (!nextByKey.has(key) && rawStatus(prev) === 'busy') {
      notify(`⏹ ${displayName(prev)} 세션 종료됨`, shortCwd(prev.cwd));
    }
  }
}

function render() {
  const filtered = currentSessions.filter((s) => activeFilter === 'all' || filterBucket(rawStatus(s)) === activeFilter);

  emptyEl.hidden = filtered.length > 0;
  gridEl.innerHTML = '';

  const sorted = [...filtered].sort((a, b) => {
    const rank = (s) => (filterBucket(rawStatus(s)) === 'busy' ? 0 : filterBucket(rawStatus(s)) === 'idle' ? 1 : 2);
    const r = rank(a) - rank(b);
    return r !== 0 ? r : b.startedAt - a.startedAt;
  });

  for (const session of sorted) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.key = sessionKey(session);

    const raw = rawStatus(session);
    const cls = raw === 'waiting' ? 'waiting' : classify(raw);
    const idLabel = session.pid != null ? `pid ${session.pid}` : `id ${session.id || ''}`;
    card.innerHTML = `
      <div class="card-top">
        <div class="card-name" title="${escapeHtml(session.name || '')}">${escapeHtml(displayName(session))}</div>
        <span class="badge badge-${cls}">${escapeHtml(statusLabel(raw))}</span>
      </div>
      <div class="card-cwd">${escapeHtml(shortCwd(session.cwd) || '')}</div>
      <div class="card-meta">
        <span>${escapeHtml(session.kind || '')} · ${escapeHtml(idLabel)}</span>
        <span>${escapeHtml(formatElapsed(session.startedAt))}</span>
      </div>
    `;
    gridEl.appendChild(card);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function applyPayload(payload) {
  if (!payload.ok) {
    errorEl.hidden = false;
    errorEl.textContent = `claude agents --json 실행 실패: ${payload.error}`;
  } else {
    errorEl.hidden = true;
  }

  const nextByKey = new Map((payload.sessions || []).map((s) => [sessionKey(s), s]));
  diffAndNotify(nextByKey);
  previousByPid = nextByKey;
  currentSessions = payload.sessions || [];

  lastUpdatedEl.textContent = `마지막 갱신: ${new Date(payload.fetchedAt).toLocaleTimeString('ko-KR')}`;
  render();
}

function connectStream() {
  const es = new EventSource('/api/stream');

  es.onopen = () => {
    connDot.className = 'dot dot-connected';
  };

  es.onmessage = (event) => {
    try {
      applyPayload(JSON.parse(event.data));
    } catch (_) {
      // 잘못된 프레임은 무시하고 다음 이벤트를 기다림
    }
  };

  es.onerror = () => {
    connDot.className = 'dot dot-disconnected';
  };
}

filterButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    filterButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    render();
  });
});

function updateNotifyButton() {
  notifyBtn.classList.toggle('on', notifyEnabled);
  notifyBtn.textContent = notifyEnabled ? '🔔 알림 켜짐' : '🔔 알림 허용';
}

updateNotifyButton();

notifyBtn.addEventListener('click', async () => {
  if (!('Notification' in window)) {
    alert('이 브라우저는 알림을 지원하지 않습니다.');
    return;
  }

  if (notifyEnabled) {
    notifyEnabled = false;
  } else if (Notification.permission === 'granted') {
    notifyEnabled = true;
  } else {
    const permission = await Notification.requestPermission();
    notifyEnabled = permission === 'granted';
  }

  updateNotifyButton();
});

if ('Notification' in window && Notification.permission === 'granted') {
  notifyBtn.classList.add('on');
  notifyBtn.textContent = '🔔 알림 켜짐';
}

connectStream();
setInterval(render, 1000);
