'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  connection: $('connection'),
  serverUrl: $('serverUrl'),
  playerName: $('playerName'),
  createMode: $('createMode'),
  btnConnect: $('btnConnect'),
  btnCreate: $('btnCreate'),
  btnJoin: $('btnJoin'),
  joinCode: $('joinCode'),
  error: $('error'),
  setup: $('setup'),
  lobbyPanel: $('lobbyPanel'),
  lobbyCode: $('lobbyCode'),
  youName: $('youName'),
  modeLabel: $('modeLabel'),
  raceStatus: $('raceStatus'),
  modeControls: $('modeControls'),
  modeHint: $('modeHint'),
  hostModeRow: $('hostModeRow'),
  pickActions: $('pickActions'),
  pickUrl: $('pickUrl'),
  btnUseTab: $('btnUseTab'),
  btnSubmitPick: $('btnSubmitPick'),
  btnModeClassic: $('btnModeClassic'),
  btnModePick: $('btnModePick'),
  winnerBanner: $('winnerBanner'),
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
  if (nameDirty && fromDraft) return fromDraft;
  return fromInput || fromDraft;
}

function playerNameById(lobby, id) {
  return lobby.players?.find((p) => p.id === id)?.name || 'Player';
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
    if (!serverUrlDirty && document.activeElement !== els.serverUrl) {
      els.serverUrl.value = state.serverUrl || '';
    }
    if (!nameDirty && document.activeElement !== els.playerName) {
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
  els.modeLabel.textContent = lobby.mode === 'pick' ? 'Pick' : 'Classic';

  const isHost = Boolean(me?.isHost);
  const waiting = lobby.status === 'waiting';
  const racing = lobby.status === 'racing' || lobby.status === 'finished';

  if (lobby.status === 'waiting' && lobby.mode === 'pick') {
    const phase = lobby.pickPhase || 'start';
    if (phase === 'start') {
      els.raceStatus.textContent = `${playerNameById(lobby, lobby.startPickerId)} picks START`;
    } else if (phase === 'target') {
      els.raceStatus.textContent = `${playerNameById(lobby, lobby.targetPickerId)} picks TARGET`;
    } else {
      els.raceStatus.textContent = 'Pages set — host can start';
    }
  } else {
    els.raceStatus.textContent = ({
      waiting: 'Waiting in lobby',
      racing: 'Racing',
      finished: 'Finished',
    })[lobby.status] || lobby.status;
  }

  // Mode controls while waiting
  els.modeControls.hidden = !waiting;
  if (waiting) {
    els.hostModeRow.hidden = !isHost;
    els.btnModeClassic.classList.toggle('active', lobby.mode !== 'pick');
    els.btnModePick.classList.toggle('active', lobby.mode === 'pick');

    if (lobby.mode === 'pick') {
      const phase = lobby.pickPhase || 'start';
      const myTurn =
        (phase === 'start' && state.playerId === lobby.startPickerId) ||
        (phase === 'target' && state.playerId === lobby.targetPickerId);
      els.pickActions.hidden = !myTurn;
      if (phase === 'start') {
        els.modeHint.textContent = myTurn
          ? 'Your turn: set the START article (open it on Wikipedia, then Use current tab).'
          : `Waiting for ${playerNameById(lobby, lobby.startPickerId)} to set START.`;
      } else if (phase === 'target') {
        els.modeHint.textContent = myTurn
          ? 'Your turn: set the TARGET article.'
          : `Waiting for ${playerNameById(lobby, lobby.targetPickerId)} to set TARGET.`;
      } else {
        els.pickActions.hidden = true;
        els.modeHint.textContent = `Start: ${lobby.startPage?.title || '—'} → Target: ${lobby.targetPage?.title || '—'}`;
      }
    } else {
      els.pickActions.hidden = true;
      els.modeHint.textContent = 'Classic: host starts to get random start & target pages.';
    }
  }

  // Winner banner
  const winners = (lobby.players || []).filter((p) => p.finished).sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
  if (winners.length) {
    const w = winners[0];
    const time = lobby.startedAt && w.finishedAt ? formatStopwatch(w.finishedAt - lobby.startedAt) : '—';
    els.winnerBanner.hidden = false;
    els.winnerBanner.textContent = `🏆 ${w.name} wins! ${w.clicks} clicks · ${time}`;
  } else {
    els.winnerBanner.hidden = true;
    els.winnerBanner.textContent = '';
  }

  // Start button
  if (isHost && waiting) {
    if (lobby.mode === 'pick') {
      els.btnStart.hidden = !(lobby.startPage && lobby.targetPage);
      els.btnStart.textContent = 'Start race';
    } else {
      els.btnStart.hidden = false;
      els.btnStart.textContent = 'Start race';
    }
  } else {
    els.btnStart.hidden = true;
  }

  els.raceMeta.hidden = !racing && !(waiting && (lobby.startPage || lobby.targetPage));

  if (lobby.startPage) {
    els.startPage.textContent = lobby.startPage.title;
    els.startPage.href = lobby.startPage.url;
  } else {
    els.startPage.textContent = '—';
    els.startPage.removeAttribute('href');
  }
  if (lobby.targetPage) {
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

    let role = '';
    if (lobby.mode === 'pick' && waiting) {
      if (p.id === lobby.startPickerId) role += ' · start picker';
      if (p.id === lobby.targetPickerId) role += ' · target picker';
    }

    const name = document.createElement('span');
    name.textContent =
      p.name +
      (p.isHost ? ' (host)' : '') +
      (p.id === state.playerId ? ' · you' : '') +
      role +
      (p.finished ? ' 🏆' : '') +
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
  chrome.runtime.sendMessage(
    { type: 'create_lobby', name, mode: els.createMode.value },
    () => {
      nameDirty = false;
      refresh();
    }
  );
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

els.btnModeClassic.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'set_mode', mode: 'classic' }, refresh);
});
els.btnModePick.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'set_mode', mode: 'pick' }, refresh);
});

function submitPick(title, url) {
  const lobby = latestState?.lobby;
  if (!lobby || lobby.mode !== 'pick') return;
  const role = lobby.pickPhase === 'target' ? 'target' : 'start';
  chrome.runtime.sendMessage({ type: 'set_pick_page', role, title, url }, refresh);
}

els.btnSubmitPick.addEventListener('click', () => {
  const raw = els.pickUrl.value.trim();
  if (!raw) return;
  if (/^https?:\/\//i.test(raw)) submitPick('', raw);
  else submitPick(raw, '');
});

els.btnUseTab.addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.url || !/wikipedia\.org\/wiki\//i.test(tab.url)) {
    els.error.hidden = false;
    els.error.textContent = 'Open a Wikipedia article tab first';
    return;
  }
  submitPick(tab.title?.replace(/ - Wikipedia$/i, '') || '', tab.url);
});


function navigateRaceTab(ev) {
  const a = ev.currentTarget;
  const url = a.getAttribute('href');
  if (!url || url === '#') {
    ev.preventDefault();
    return;
  }
  ev.preventDefault();
  chrome.runtime.sendMessage({ type: 'navigate_race_tab', url }, () => {
    refresh();
  });
}
els.startPage.addEventListener('click', navigateRaceTab);
els.targetPage.addEventListener('click', navigateRaceTab);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'state' && msg.state) render(msg.state);
});

refresh();
setInterval(refresh, 1000);
