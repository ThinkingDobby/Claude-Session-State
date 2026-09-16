'use strict';

const gridEl = document.getElementById('grid');
const kanbanEl = document.getElementById('kanban');
const emptyEl = document.getElementById('empty-state');
const errorEl = document.getElementById('error-banner');
const lastUpdatedEl = document.getElementById('last-updated');
const connDot = document.getElementById('conn-dot');
const notifyBtn = document.getElementById('notify-btn');
const kanbanToggleBtn = document.getElementById('kanban-toggle');
const settingsBtn = document.getElementById('settings-btn');
const settingsDialog = document.getElementById('settings-dialog');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const restartBtn = document.getElementById('restart-btn');
const filterButtons = document.querySelectorAll('#filters button');

let currentSessions = [];
let previousByPid = new Map();
let activeFilter = 'all';
let notifyEnabled = Notification && Notification.permission === 'granted';
let kanbanEnabled = false;
let copiedSessionId = null;

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

function formatElapsed(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}

function shortCwd(cwd) {
  const home = cwd && cwd.startsWith('/Users/') ? cwd.replace(/^\/Users\/[^/]+/, '~') : cwd;
  return home;
}

// UUID 전체는 카드에 너무 길어서 앞 8자만 보여주고, 전체 값은 title/복사로 제공한다.
function shortSessionId(sessionId) {
  return `${sessionId.slice(0, 8)}…`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // 비보안 컨텍스트 등 클립보드 API가 막힌 경우 폴백
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch (_) {
    return false;
  }
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
  if (rawValue === 'waiting') return 'waiting';
  const cls = classify(rawValue);
  return cls === 'busy' || cls === 'idle' ? cls : 'other';
}

const BUCKET_ORDER = ['busy', 'waiting', 'idle', 'other'];
const BUCKET_LABELS = { busy: '작업 중', waiting: '입력 필요', idle: '대기 중', other: '기타' };
const RANK_ORDER = { busy: 0, waiting: 1, idle: 2, other: 3 };

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

function buildCardElement(session) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.key = sessionKey(session);

  const raw = rawStatus(session);
  const cls = raw === 'waiting' ? 'waiting' : classify(raw);
  const idLabel = session.pid != null ? `pid ${session.pid}` : `id ${session.id || ''}`;
  const sid = session.sessionId || '';
  const copied = sid && sid === copiedSessionId;
  const sidHtml = sid
    ? ` · sid <span class="card-sid${copied ? ' copied' : ''}" role="button" tabindex="0" data-sid="${escapeHtml(sid)}" title="세션 ID: ${escapeHtml(sid)} (클릭하면 복사)">${escapeHtml(copied ? '복사됨!' : shortSessionId(sid))}</span>`
    : '';
  card.innerHTML = `
    <div class="card-top">
      <div class="card-name" title="${escapeHtml(session.name || '')}">${escapeHtml(displayName(session))}</div>
      <span class="badge badge-${cls}">${escapeHtml(statusLabel(raw))}</span>
    </div>
    <div class="card-cwd">${escapeHtml(shortCwd(session.cwd) || '')}</div>
    <div class="card-meta">
      <span>${escapeHtml(session.kind || '')} · ${escapeHtml(idLabel)}${sidHtml}</span>
      <span title="시작 시각">${escapeHtml(formatElapsed(session.startedAt))} 🕐</span>
    </div>
    ${session.lastActivityAt ? `
    <div class="card-meta card-meta-secondary">
      <span></span>
      <span title="마지막 요청 시각">${escapeHtml(formatElapsed(session.lastActivityAt))} 💬</span>
    </div>` : ''}
  `;
  return card;
}

function renderGrid(filtered) {
  kanbanEl.hidden = true;
  gridEl.hidden = false;
  gridEl.innerHTML = '';

  const sorted = [...filtered].sort((a, b) => {
    const rank = (s) => RANK_ORDER[filterBucket(rawStatus(s))];
    const r = rank(a) - rank(b);
    return r !== 0 ? r : b.startedAt - a.startedAt;
  });

  for (const session of sorted) {
    gridEl.appendChild(buildCardElement(session));
  }
}

function renderKanban(filtered) {
  gridEl.hidden = true;
  kanbanEl.hidden = false;
  kanbanEl.innerHTML = '';

  const buckets = new Map(BUCKET_ORDER.map((b) => [b, []]));
  for (const session of filtered) {
    buckets.get(filterBucket(rawStatus(session))).push(session);
  }

  for (const bucket of BUCKET_ORDER) {
    const sessions = buckets.get(bucket).sort((a, b) => b.startedAt - a.startedAt);
    const column = document.createElement('div');
    column.className = 'kanban-column';
    column.innerHTML = `
      <div class="kanban-column-header">
        <span>${escapeHtml(BUCKET_LABELS[bucket])}</span>
        <span class="kanban-count">${sessions.length}</span>
      </div>
      <div class="kanban-column-body"></div>
    `;
    const body = column.querySelector('.kanban-column-body');
    for (const session of sessions) {
      body.appendChild(buildCardElement(session));
    }
    kanbanEl.appendChild(column);
  }
}

function render() {
  const filtered = currentSessions.filter((s) => activeFilter === 'all' || filterBucket(rawStatus(s)) === activeFilter);

  emptyEl.hidden = filtered.length > 0;

  if (activeFilter === 'all' && kanbanEnabled) {
    renderKanban(filtered);
  } else {
    renderGrid(filtered);
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

settingsBtn.addEventListener('click', () => {
  settingsDialog.showModal();
});

settingsCloseBtn.addEventListener('click', () => {
  settingsDialog.close();
});

settingsDialog.addEventListener('click', (event) => {
  if (event.target === settingsDialog) {
    settingsDialog.close();
  }
});

function updateKanbanToggleButton() {
  kanbanToggleBtn.classList.toggle('on', kanbanEnabled);
  kanbanToggleBtn.textContent = kanbanEnabled ? '🗂 칸반 보기 켜짐' : '🗂 칸반 보기 꺼짐';
}

updateKanbanToggleButton();

kanbanToggleBtn.addEventListener('click', () => {
  kanbanEnabled = !kanbanEnabled;
  updateKanbanToggleButton();
  render();
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

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  // 먼저 기존 프로세스가 내려갈 시간을 준 뒤 새 서버가 응답할 때까지 폴링한다.
  await new Promise((r) => setTimeout(r, 600));
  while (Date.now() < deadline) {
    try {
      const res = await fetch('/api/sessions', { cache: 'no-store' });
      if (res.ok) return true;
    } catch (_) {
      // 아직 새 서버가 뜨지 않음
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

restartBtn.addEventListener('click', async () => {
  if (!confirm('서버를 재시작할까요?')) return;

  restartBtn.disabled = true;
  restartBtn.textContent = '🔄 재시작 중…';

  try {
    await fetch('/api/restart', { method: 'POST' });
  } catch (_) {
    // 응답 직후 서버가 종료되면서 연결이 끊길 수 있음, 정상 흐름
  }

  const alive = await waitForServer(15000);
  if (alive) {
    location.reload();
  } else {
    restartBtn.disabled = false;
    restartBtn.textContent = '🔄 서버 재시작';
    alert('서버가 다시 응답하지 않습니다. 터미널에서 claude-session-state restart 를 실행해 주세요.');
  }
});

async function handleSessionIdActivate(target) {
  const sid = target.dataset.sid;
  if (!sid) return;
  const ok = await copyText(sid);
  if (!ok) {
    alert(`클립보드 복사에 실패했습니다. 세션 ID: ${sid}`);
    return;
  }
  copiedSessionId = sid;
  render();
  setTimeout(() => {
    if (copiedSessionId === sid) {
      copiedSessionId = null;
      render();
    }
  }, 1200);
}

[gridEl, kanbanEl].forEach((container) => {
  container.addEventListener('click', (event) => {
    const target = event.target.closest('.card-sid');
    if (target) handleSessionIdActivate(target);
  });
  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target.closest('.card-sid');
    if (target) {
      event.preventDefault();
      handleSessionIdActivate(target);
    }
  });
});

connectStream();
setInterval(render, 1000);
