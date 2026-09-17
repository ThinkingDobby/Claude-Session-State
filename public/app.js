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
const transcriptDialog = document.getElementById('transcript-dialog');
const transcriptTitle = document.getElementById('transcript-title');
const transcriptSubtitle = document.getElementById('transcript-subtitle');
const transcriptBody = document.getElementById('transcript-body');
const transcriptCloseBtn = document.getElementById('transcript-close-btn');
const transcriptRemoveBtn = document.getElementById('transcript-remove-btn');
const backgroundToggleBtn = document.getElementById('background-toggle');
const filterButtons = document.querySelectorAll('#filters button');

// 설정은 브라우저에 그대로 저장한다. 서버나 DB 를 끌어들일 만한 양이 아니다.
const SETTINGS_PREFIX = 'css.';

function loadSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(SETTINGS_PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(SETTINGS_PREFIX + key, JSON.stringify(value));
  } catch (_) {
    // 사생활 보호 모드 등에서 실패할 수 있다. 저장만 못할 뿐 동작에는 지장 없다.
  }
}

let currentSessions = [];
let previousByPid = new Map();
let activeFilter = loadSetting('filter', 'all');
let notifyEnabled = typeof Notification !== 'undefined'
  && Notification.permission === 'granted'
  && loadSetting('notify', true);
let showBackground = loadSetting('showBackground', false);
let kanbanEnabled = loadSetting('kanban', false);
let copiedKey = null;

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
  if (rawValue === 'crashed') return 'failed';
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
  crashed: '비정상 종료',
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

// claude-fable-5-1 -> Fable 5.1, claude-haiku-4-5-20251001 -> Haiku 4.5
function formatModelName(model) {
  if (!model) return '';
  const cleaned = String(model)
    .replace(/^claude-/, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '');
  const parts = cleaned.split('-').filter(Boolean);
  if (!parts.length) return '';
  const family = parts.shift();
  const label = family.charAt(0).toUpperCase() + family.slice(1);
  const version = parts.join('.');
  return version ? `${label} ${version}` : label;
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

function isHidden(session) {
  return !showBackground && session.kind === 'background';
}

function diffAndNotify(nextByKey) {
  for (const [key, session] of nextByKey) {
    if (isHidden(session)) continue;
    const prev = previousByPid.get(key);
    const prevRaw = prev && rawStatus(prev);
    const nextRaw = rawStatus(session);
    if (prev && prevRaw === 'busy' && nextRaw !== 'busy') {
      notify(`✅ ${displayName(session)} 작업 완료`, shortCwd(session.cwd));
    }
  }
  for (const [key, prev] of previousByPid) {
    if (isHidden(prev)) continue;
    if (!nextByKey.has(key) && rawStatus(prev) === 'busy') {
      notify(`⏹ ${displayName(prev)} 세션 종료됨`, shortCwd(prev.cwd));
    }
  }
}

// 카드 DOM 을 매 렌더마다 새로 만들면 마우스가 올라가 있던 요소가 사라져서
// 호버 테두리가 1초마다 깜빡인다. 그래서 요소를 키로 재사용하고 바뀐 값만 갱신한다.
const cardElements = new Map();
const kanbanColumns = new Map();

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// 복사 가능한 값 하나를 그리는 공통 처리. 표시값과 복사값이 다를 수 있다.
function applyCopyTarget(el, key, copyValue, displayValue, title) {
  const copied = key === copiedKey;
  setText(el, copied ? '복사됨' : displayValue);
  el.classList.toggle('copied', copied);
  if (el.dataset.copyKey !== key) el.dataset.copyKey = key;
  if (el.dataset.copyValue !== copyValue) el.dataset.copyValue = copyValue;
  if (el.title !== title) el.title = title;
}

function createCardShell() {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-top">
      <div class="card-name"></div>
      <span class="badge"></span>
    </div>
    <div class="card-cwd"></div>
    <div class="card-meta">
      <span><span class="card-kind"></span><span class="card-ident-wrap" hidden> · <span class="card-ident-label"></span> <span class="card-copy card-ident" role="button" tabindex="0"></span></span><span class="card-sid-wrap" hidden> · sid <span class="card-copy card-sid" role="button" tabindex="0"></span></span></span>
      <span class="card-started" title="시작 시각"></span>
    </div>
    <div class="card-meta card-meta-secondary" hidden>
      <span class="card-model" title="이 세션에 선택된 모델"></span>
      <span class="card-activity" title="마지막 요청 시각"></span>
    </div>
  `;
  return card;
}

function updateCard(card, session, key) {
  const raw = rawStatus(session);
  const cls = raw === 'waiting' ? 'waiting' : classify(raw);
  const sid = session.sessionId || '';

  if (sid) {
    card.dataset.sessionId = sid;
    card.dataset.sessionName = session.name || '';
  } else {
    delete card.dataset.sessionId;
    delete card.dataset.sessionName;
  }

  card.dataset.sessionKind = session.kind || '';
  card.dataset.statusLabel = statusLabel(raw);
  if (session.kind === 'background' && session.id) {
    card.dataset.jobId = session.id;
  } else {
    delete card.dataset.jobId;
  }

  const nameEl = card.querySelector('.card-name');
  setText(nameEl, displayName(session));
  const fullName = session.name || '';
  if (nameEl.title !== fullName) nameEl.title = fullName;

  const badge = card.querySelector('.badge');
  const badgeClass = `badge badge-${cls}`;
  if (badge.className !== badgeClass) badge.className = badgeClass;
  setText(badge, statusLabel(raw));

  setText(card.querySelector('.card-cwd'), shortCwd(session.cwd) || '');
  setText(card.querySelector('.card-kind'), session.kind || '');

  // pid 가 있으면 pid 를, 없으면 백그라운드 작업 id 를 보여준다. 둘 다 복사 대상이다.
  const identValue = session.pid != null ? String(session.pid) : (session.id || '');
  const identLabel = session.pid != null ? 'pid' : 'id';
  const identWrap = card.querySelector('.card-ident-wrap');
  identWrap.hidden = !identValue;
  if (identValue) {
    setText(card.querySelector('.card-ident-label'), identLabel);
    applyCopyTarget(
      card.querySelector('.card-ident'),
      `${key}:ident`,
      identValue,
      identValue,
      `${identLabel} ${identValue} (클릭하면 복사)`,
    );
  }

  const sidWrap = card.querySelector('.card-sid-wrap');
  sidWrap.hidden = !sid;
  if (sid) {
    applyCopyTarget(
      card.querySelector('.card-sid'),
      `${key}:sid`,
      sid,
      shortSessionId(sid),
      `세션 ID: ${sid} (클릭하면 복사)`,
    );
  }

  setText(card.querySelector('.card-started'), `${formatElapsed(session.startedAt)} 🕐`);

  const modelName = formatModelName(session.model);
  card.dataset.sessionModel = modelName;

  const secondary = card.querySelector('.card-meta-secondary');
  secondary.hidden = !session.lastActivityAt && !modelName;
  setText(card.querySelector('.card-model'), modelName);
  setText(
    card.querySelector('.card-activity'),
    session.lastActivityAt ? `${formatElapsed(session.lastActivityAt)} 💬` : '',
  );
}

function buildCardElement(session) {
  const key = sessionKey(session);
  let card = cardElements.get(key);
  if (!card) {
    card = createCardShell();
    card.dataset.key = key;
    cardElements.set(key, card);
  }
  updateCard(card, session, key);
  return card;
}

// 구성과 순서가 그대로면 DOM 을 아예 건드리지 않는다.
function syncChildren(container, elements) {
  const current = container.children;
  if (current.length === elements.length) {
    let same = true;
    for (let i = 0; i < elements.length; i += 1) {
      if (current[i] !== elements[i]) {
        same = false;
        break;
      }
    }
    if (same) return;
  }
  container.replaceChildren(...elements);
}

function renderGrid(filtered) {
  kanbanEl.hidden = true;
  gridEl.hidden = false;

  const sorted = [...filtered].sort((a, b) => {
    const rank = (s) => RANK_ORDER[filterBucket(rawStatus(s))];
    const r = rank(a) - rank(b);
    return r !== 0 ? r : b.startedAt - a.startedAt;
  });

  syncChildren(gridEl, sorted.map((session) => buildCardElement(session)));
}

function getKanbanColumn(bucket) {
  let column = kanbanColumns.get(bucket);
  if (!column) {
    column = document.createElement('div');
    column.className = 'kanban-column';
    column.innerHTML = `
      <div class="kanban-column-header">
        <span>${escapeHtml(BUCKET_LABELS[bucket])}</span>
        <span class="kanban-count">0</span>
      </div>
      <div class="kanban-column-body"></div>
    `;
    kanbanColumns.set(bucket, column);
  }
  return column;
}

function renderKanban(filtered) {
  gridEl.hidden = true;
  kanbanEl.hidden = false;

  const buckets = new Map(BUCKET_ORDER.map((b) => [b, []]));
  for (const session of filtered) {
    buckets.get(filterBucket(rawStatus(session))).push(session);
  }

  const columns = BUCKET_ORDER.map((bucket) => {
    const sessions = buckets.get(bucket).sort((a, b) => b.startedAt - a.startedAt);
    const column = getKanbanColumn(bucket);
    setText(column.querySelector('.kanban-count'), String(sessions.length));
    syncChildren(column.querySelector('.kanban-column-body'), sessions.map((session) => buildCardElement(session)));
    return column;
  });

  syncChildren(kanbanEl, columns);
}

// 사라진 세션의 카드 요소는 캐시에서 지운다.
function pruneCardElements() {
  const liveKeys = new Set(currentSessions.filter((s) => !isHidden(s)).map((session) => sessionKey(session)));
  for (const key of cardElements.keys()) {
    if (!liveKeys.has(key)) cardElements.delete(key);
  }
}

function render() {
  const filtered = currentSessions
    .filter((s) => !isHidden(s))
    .filter((s) => activeFilter === 'all' || filterBucket(rawStatus(s)) === activeFilter);

  emptyEl.hidden = filtered.length > 0;

  if (activeFilter === 'all' && kanbanEnabled) {
    renderKanban(filtered);
  } else {
    renderGrid(filtered);
  }

  pruneCardElements();
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
    saveSetting('filter', activeFilter);
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
  saveSetting('kanban', kanbanEnabled);
  updateKanbanToggleButton();
  render();
});

function updateBackgroundToggleButton() {
  backgroundToggleBtn.classList.toggle('on', showBackground);
  backgroundToggleBtn.textContent = showBackground ? '🌙 표시함' : '🌙 숨김';
}

updateBackgroundToggleButton();

backgroundToggleBtn.addEventListener('click', () => {
  showBackground = !showBackground;
  saveSetting('showBackground', showBackground);
  updateBackgroundToggleButton();
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

  saveSetting('notify', notifyEnabled);
  updateNotifyButton();
});

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

async function handleCopyActivate(target) {
  const value = target.dataset.copyValue;
  const key = target.dataset.copyKey;
  if (!value) return;
  const ok = await copyText(value);
  if (!ok) {
    alert(`클립보드 복사에 실패했습니다: ${value}`);
    return;
  }
  copiedKey = key;
  render();
  setTimeout(() => {
    if (copiedKey === key) {
      copiedKey = null;
      render();
    }
  }, 1200);
}

const ROLE_LABELS = { user: '나', assistant: 'Claude' };

function formatTurnTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ko-KR');
}

function renderTranscriptStatus(message) {
  transcriptBody.innerHTML = `<div class="transcript-status">${escapeHtml(message)}</div>`;
}

function renderTranscriptTurns(turns) {
  if (!turns.length) {
    renderTranscriptStatus('표시할 대화가 없습니다.');
    return;
  }

  transcriptBody.innerHTML = turns.map((turn) => `
    <div class="transcript-turn transcript-turn-${turn.role === 'user' ? 'user' : 'assistant'}">
      <div class="transcript-turn-head">
        <span class="transcript-role">${escapeHtml(ROLE_LABELS[turn.role] || turn.role)}</span>
        <span>${escapeHtml(formatTurnTime(turn.timestamp))}</span>
        ${turn.truncated ? '<span>· 일부만 표시</span>' : ''}
      </div>
      <p class="transcript-text">${escapeHtml(turn.text)}</p>
    </div>
  `).join('');

  // 가장 최근 대화가 아래쪽이므로 끝으로 스크롤한다.
  transcriptBody.scrollTop = transcriptBody.scrollHeight;
}

let transcriptJobId = null;
let transcriptJobState = '';

async function openTranscript(card) {
  const sessionId = card.dataset.sessionId;
  const sessionName = card.dataset.sessionName;
  const modelName = card.dataset.sessionModel;

  transcriptJobId = card.dataset.jobId || null;
  transcriptJobState = card.dataset.statusLabel || '';
  transcriptRemoveBtn.hidden = !transcriptJobId;
  transcriptDialog.classList.toggle('for-background', card.dataset.sessionKind === 'background');
  transcriptRemoveBtn.disabled = false;
  transcriptRemoveBtn.textContent = '세션 삭제';

  transcriptTitle.textContent = sessionName || '최근 대화';
  transcriptSubtitle.textContent = modelName ? `${modelName} · sid ${sessionId}` : `sid ${sessionId}`;
  renderTranscriptStatus('불러오는 중…');
  transcriptDialog.showModal();

  try {
    const res = await fetch(`/api/transcript?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
    const payload = await res.json();
    if (!payload.ok) {
      renderTranscriptStatus(payload.error || '대화를 불러오지 못했습니다.');
      return;
    }
    renderTranscriptTurns(payload.turns || []);
  } catch (err) {
    renderTranscriptStatus(`대화를 불러오지 못했습니다: ${err.message}`);
  }
}

transcriptCloseBtn.addEventListener('click', () => {
  transcriptDialog.close();
});

// claude rm 은 되돌릴 수 없고 워크트리까지 지우므로 확인을 받고,
// 명령이 거부하면 그 출력을 그대로 보여준다.
transcriptRemoveBtn.addEventListener('click', async () => {
  const jobId = transcriptJobId;
  if (!jobId) return;
  const stateNote = transcriptJobState ? `\n현재 상태: ${transcriptJobState}` : '';
  if (!confirm(`백그라운드 세션 ${jobId} 을(를) 삭제할까요?${stateNote}\n대화 기록과 워크트리가 함께 삭제되며 되돌릴 수 없습니다.`)) return;

  transcriptRemoveBtn.disabled = true;
  transcriptRemoveBtn.textContent = '삭제 중…';

  try {
    const res = await fetch(`/api/background/remove?id=${encodeURIComponent(jobId)}`, { method: 'POST' });
    const payload = await res.json();
    if (payload.ok) {
      transcriptDialog.close();
      return;
    }
    alert(`삭제하지 못했습니다.\n\n${payload.error || '알 수 없는 오류'}`);
  } catch (err) {
    alert(`삭제 요청에 실패했습니다: ${err.message}`);
  }

  transcriptRemoveBtn.disabled = false;
  transcriptRemoveBtn.textContent = '세션 삭제';
});

transcriptDialog.addEventListener('click', (event) => {
  if (event.target === transcriptDialog) {
    transcriptDialog.close();
  }
});

[gridEl, kanbanEl].forEach((container) => {
  container.addEventListener('click', (event) => {
    const target = event.target.closest('.card-copy');
    if (target) {
      handleCopyActivate(target);
      return;
    }

    const card = event.target.closest('.card');
    if (card && card.dataset.sessionId) {
      openTranscript(card);
    }
  });
  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target.closest('.card-copy');
    if (target) {
      event.preventDefault();
      handleCopyActivate(target);
    }
  });
});

filterButtons.forEach((btn) => {
  btn.classList.toggle('active', btn.dataset.filter === activeFilter);
});

connectStream();
setInterval(render, 1000);
