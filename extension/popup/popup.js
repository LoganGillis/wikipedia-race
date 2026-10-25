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

function render(state) {
  latestState = state;
  setConnectionBadge(state.connectionStatus || 'disconnected');

  if (document.activeElement !== els.serverUrl) {
    els.serverUrl.value = state.serverUrl || '';
  }
  if (document.activeElement !== els.playerName) {
    els.playerName.value = state.playerName || '';
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
  els.youName.textContent = state.playerName || '—';
  els.raceStatus.textContent = ({
    waiting: 'Waiting in lobby',
    racing: 'Racing',
    finished: 'Finished',
  })[lobby.status] || lobby.status;

  const me = lobby.players?.find((p) => p.id === state.playerId);
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

els.btnConnect.addEventListener('click', () => {
  chrome.runtime.sendMessage(
    { type: 'set_server_url', serverUrl: els.serverUrl.value },
    () => {
      chrome.runtime.sendMessage({ type: 'set_name', name: els.playerName.value }, refresh);
    }
  );
});

els.btnCreate.addEventListener('click', () => {
  chrome.runtime.sendMessage(
    { type: 'create_lobby', name: els.playerName.value },
    refresh
  );
});

els.btnJoin.addEventListener('click', () => {
  chrome.runtime.sendMessage(
    {
      type: 'join_lobby',
      code: els.joinCode.value.trim().toUpperCase(),
      name: els.playerName.value,
    },
    refresh
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
