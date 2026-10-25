'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  connection: $('connection'),
  serverUrl: $('serverUrl'),
  playerName: $('playerName'),
  btnConnect: $('btnConnect'),
  btnCreate: $('btnCreate'),
  btnJoin: $('btnJoin'),
  joinCode: $('joinCode'),
  error: $('error'),
  setup: $('setup'),
  lobbyPanel: $('lobbyPanel'),
  lobbyCode: $('lobbyCode'),
  youName: $('youName'),
  raceStatus: $('raceStatus'),
  raceMeta: $('raceMeta'),
  startPage: $('startPage'),
  targetPage: $('targetPage'),
  clickCount: $('clickCount'),
  stopwatch: $('stopwatch'),
  playerList: $('playerList'),
  btnStart: $('btnStart'),
  btnLeave: $('btnLeave'),
};

let latestState = null;
let stopwatchTimer = null;
/** Draft name captured on every input — survives blur/re-render races on Create/Join. */
let nameDraft = '';
let nameDirty = false;
let serverUrlDraft = '';
let serverUrlDirty = false;
let hydrated = false;

function setConnectionBadge(status) {
  els.connection.textContent = ({
    connected: 'Connected',
    connecting: 'Connecting…',
    disconnected: 'Disconnected',
    error: 'Error',
  })[status] || status;
  els.connection.className = `status status-${status}`;
}

function formatStopwatch(ms) {
  if (ms == null || ms < 0) return '00:00.0';
  const totalTenths = Math.floor(ms / 100);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${tenths}`;
}

function tickStopwatch() {
  const lobby = latestState?.lobby;
  if (!lobby?.startedAt || (lobby.status !== 'racing' && lobby.status !== 'finished')) {
    els.stopwatch.textContent = '00:00.0';
    return;
  }
  const me = lobby.players?.find((p) => p.id === latestState.playerId);
  const end = me?.finished && me.finishedAt ? me.finishedAt : Date.now();
  els.stopwatch.textContent = formatStopwatch(end - lobby.startedAt);
}

function readPlayerName() {
  const fromInput = String(els.playerName.value || '').trim();
  const fromDraft = String(nameDraft || '').trim();
  // Prefer whichever is longer / current — draft wins ties when dirty
  if (nameDirty && fromDraft) return fromDraft;
  return fromInput || fromDraft;
}

function render(state) {
  latestState = state;
  setConnectionBadge(state.connectionStatus || 'disconnected');

  if (!hydrated) {
    serverUrlDraft = state.serverUrl || '';
    els.serverUrl.value = serverUrlDraft;
    nameDraft = state.playerName || '';
    els.playerName.value = nameDraft;
    hydrated = true;
  } else {
    // Never clobber in-progress typing. Only sync from state when field is clean.
    if (!serverUrlDirty && document.activeElement !== els.serverUrl) {
      els.serverUrl.value = state.serverUrl || '';
    }
    if (!nameDirty && document.activeElement !== els.playerName) {
      // Keep showing what the user typed (nameDraft) if present; else state
      const show = nameDraft || state.playerName || '';
      if (els.playerName.value !== show) els.playerName.value = show;
    }
  }

  if (state.lastError) {
    els.error.hidden = false;
    els.error.textContent = state.lastError;
  } else {
    els.error.hidden = true;
    els.error.textContent = '';
  }

  const lobby = state.lobby;
  if (!lobby) {
    els.setup.hidden = false;
    els.lobbyPanel.hidden = true;
    if (stopwatchTimer) {
      clearInterval(stopwatchTimer);
      stopwatchTimer = null;
    }
    return;
  }

  els.setup.hidden = true;
  els.lobbyPanel.hidden = false;
  els.lobbyCode.textContent = lobby.code;

  const me = lobby.players?.find((p) => p.id === state.playerId);
  els.youName.textContent = me?.name || state.playerName || nameDraft || '—';
  els.raceStatus.textContent = ({
    waiting: 'Waiting in lobby',
    racing: 'Racing',
    finished: 'Finished',
  })[lobby.status] || lobby.status;

  const isHost = Boolean(me?.isHost);
  els.btnStart.hidden = !(isHost && lobby.status === 'waiting');

  const racing = lobby.status === 'racing' || lobby.status === 'finished';
  els.raceMeta.hidden = !racing;

  if (racing && lobby.startPage) {
    els.startPage.textContent = lobby.startPage.title;
    els.startPage.href = lobby.startPage.url;
  } else {
    els.startPage.textContent = '—';
    els.startPage.removeAttribute('href');
  }

  if (racing && lobby.targetPage) {
    els.targetPage.textContent = lobby.targetPage.title;
    els.targetPage.href = lobby.targetPage.url;
  } else {
    els.targetPage.textContent = '—';
    els.targetPage.removeAttribute('href');
  }

  els.clickCount.textContent = String(me?.clicks ?? 0);
  tickStopwatch();
  if (!stopwatchTimer && racing) {
    stopwatchTimer = setInterval(tickStopwatch, 100);
  }

  els.playerList.innerHTML = '';
  for (const p of lobby.players || []) {
    const li = document.createElement('li');
    if (p.id === state.playerId) li.classList.add('you');
    if (p.finished) li.classList.add('done');
    if (!p.connected) li.classList.add('offline');

    const name = document.createElement('span');
    name.textContent =
      p.name +
      (p.isHost ? ' (host)' : '') +
      (p.id === state.playerId ? ' · you' : '') +
      (!p.connected ? ' · offline' : '');

    const meta = document.createElement('span');
    meta.className = 'meta';
    if (lobby.status === 'waiting') {
      meta.textContent = p.connected ? 'ready' : 'away';
    } else if (p.finished && lobby.startedAt && p.finishedAt) {
      meta.textContent = `${p.clicks} clicks · ${formatStopwatch(p.finishedAt - lobby.startedAt)}`;
    } else {
      meta.textContent = `${p.clicks} clicks`;
    }

    li.appendChild(name);
    li.appendChild(meta);
    els.playerList.appendChild(li);
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'get_state' }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res?.state) render(res.state);
  });
}

els.playerName.addEventListener('input', () => {
  nameDraft = els.playerName.value;
  nameDirty = true;
});

els.serverUrl.addEventListener('input', () => {
  serverUrlDraft = els.serverUrl.value;
  serverUrlDirty = true;
});

// Capture name on pointerdown BEFORE blur+render can wipe the input value
function armNameCapture(btn) {
  btn.addEventListener('pointerdown', () => {
    nameDraft = els.playerName.value || nameDraft;
    nameDirty = true;
  });
}
armNameCapture(els.btnCreate);
armNameCapture(els.btnJoin);
armNameCapture(els.btnConnect);

els.btnConnect.addEventListener('click', () => {
  const name = readPlayerName();
  nameDraft = name;
  const url = els.serverUrl.value || serverUrlDraft;
  serverUrlDirty = false;
  chrome.runtime.sendMessage({ type: 'set_server_url', serverUrl: url }, () => {
    chrome.runtime.sendMessage({ type: 'set_name', name }, () => {
      nameDirty = false;
      refresh();
    });
  });
});

els.btnCreate.addEventListener('click', () => {
  const name = readPlayerName();
  nameDraft = name;
  chrome.runtime.sendMessage({ type: 'create_lobby', name }, () => {
    nameDirty = false;
    refresh();
  });
});

els.btnJoin.addEventListener('click', () => {
  const name = readPlayerName();
  nameDraft = name;
  chrome.runtime.sendMessage(
    {
      type: 'join_lobby',
      code: els.joinCode.value.trim().toUpperCase(),
      name,
    },
    () => {
      nameDirty = false;
      refresh();
    }
  );
});

els.btnStart.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'start_race' }, refresh);
});

els.btnLeave.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'leave_lobby' }, refresh);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'state' && msg.state) render(msg.state);
});

refresh();
setInterval(refresh, 1000);
