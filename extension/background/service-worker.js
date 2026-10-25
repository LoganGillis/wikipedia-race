'use strict';

const DEFAULT_SERVER = 'ws://localhost:3847/ws';

/** @type {WebSocket|null} */
let socket = null;
/** @type {ReturnType<typeof setInterval>|null} */
let reconnectTimer = null;
let intentionalClose = false;

const defaultState = () => ({
  serverUrl: DEFAULT_SERVER,
  connectionStatus: 'disconnected', // disconnected | connecting | connected | error
  lastError: null,
  playerId: null,
  playerName: '',
  lobby: null, // full lobby snapshot from server
});

async function loadState() {
  const stored = await chrome.storage.session.get(['raceState']);
  return { ...defaultState(), ...(stored.raceState || {}) };
}

async function saveState(partial) {
  const current = await loadState();
  const next = { ...current, ...partial };
  await chrome.storage.session.set({ raceState: next });
  // Also mirror key fields to local for popup durability across SW restarts
  await chrome.storage.local.set({
    serverUrl: next.serverUrl,
    playerName: next.playerName,
  });
  broadcastToPopup({ type: 'state', state: next });
  return next;
}

function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function toWsUrl(input) {
  let u = String(input || DEFAULT_SERVER).trim();
  if (!u) u = DEFAULT_SERVER;
  if (u.startsWith('http://')) u = 'ws://' + u.slice(7);
  if (u.startsWith('https://')) u = 'wss://' + u.slice(8);
  if (!u.includes('/ws')) {
    u = u.replace(/\/$/, '') + '/ws';
  }
  return u;
}

async function connect() {
  const state = await loadState();
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  intentionalClose = false;
  const url = toWsUrl(state.serverUrl);
  await saveState({ connectionStatus: 'connecting', lastError: null, serverUrl: url });

  try {
    socket = new WebSocket(url);
  } catch (err) {
    await saveState({ connectionStatus: 'error', lastError: String(err.message || err) });
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', async () => {
    await saveState({ connectionStatus: 'connected', lastError: null });
  });

  socket.addEventListener('message', async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    await handleServerMessage(msg);
  });

  socket.addEventListener('close', async () => {
    socket = null;
    if (!intentionalClose) {
      await saveState({ connectionStatus: 'disconnected' });
      scheduleReconnect();
    } else {
      await saveState({ connectionStatus: 'disconnected' });
    }
  });

  socket.addEventListener('error', async () => {
    await saveState({ connectionStatus: 'error', lastError: 'WebSocket error' });
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2500);
}

function send(type, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ type, ...payload }));
  return true;
}

async function handleServerMessage(msg) {
  switch (msg.type) {
    case 'hello':
      break;
    case 'lobby_created':
    case 'lobby_joined':
      await saveState({
        playerId: msg.playerId,
        lobby: msg.lobby,
        lastError: null,
      });
      if (msg.lobby?.status === 'racing' && msg.lobby.startPage?.url) {
        openRaceTab(msg.lobby.startPage.url);
      }
      break;
    case 'race_started':
      await saveState({ lobby: msg.lobby, lastError: null });
      if (msg.lobby?.startPage?.url) {
        openRaceTab(msg.lobby.startPage.url);
      }
      break;
    case 'lobby_update':
    case 'race_preparing':
      if (msg.lobby) await saveState({ lobby: msg.lobby });
      break;
    case 'error':
      await saveState({ lastError: msg.message || 'Server error' });
      break;
    case 'pong':
      break;
    default:
      break;
  }
}

async function openRaceTab(url) {
  const tabs = await chrome.tabs.query({ url: ['https://*.wikipedia.org/*'] });
  if (tabs[0]?.id) {
    await chrome.tabs.update(tabs[0].id, { url, active: true });
  } else {
    await chrome.tabs.create({ url, active: true });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'get_state') {
      sendResponse({ state: await loadState() });
      return;
    }
    if (msg.type === 'set_server_url') {
      intentionalClose = true;
      if (socket) socket.close();
      socket = null;
      intentionalClose = false;
      await saveState({ serverUrl: toWsUrl(msg.serverUrl), lobby: null, playerId: null });
      await connect();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'set_name') {
      await saveState({ playerName: String(msg.name || '').slice(0, 24) });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'create_lobby') {
      const state = await loadState();
      const name = msg.name || state.playerName || 'Player';
      await saveState({ playerName: name });
      if (!(await ensureConnected())) {
        sendResponse({ ok: false, error: 'Not connected' });
        return;
      }
      send('create_lobby', { name });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'join_lobby') {
      const state = await loadState();
      const name = msg.name || state.playerName || 'Player';
      await saveState({ playerName: name });
      if (!(await ensureConnected())) {
        sendResponse({ ok: false, error: 'Not connected' });
        return;
      }
      send('join_lobby', { code: msg.code, name });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'start_race') {
      send('start_race');
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'leave_lobby') {
      send('leave_lobby');
      await saveState({ lobby: null, playerId: null });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'wiki_nav') {
      await onWikiNav(msg);
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: 'unknown' });
  })();
  return true;
});

async function ensureConnected() {
  const state = await loadState();
  if (state.connectionStatus === 'connected' && socket?.readyState === WebSocket.OPEN) {
    return true;
  }
  await connect();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (socket?.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

async function onWikiNav(msg) {
  const state = await loadState();
  if (!state.lobby || state.lobby.status !== 'racing') return;
  const me = state.lobby.players?.find((p) => p.id === state.playerId);
  let clicks = me?.clicks ?? 0;

  if (msg.kind === 'link_click' || msg.kind === 'forward_nav') {
    clicks += 1;
  } else if (msg.kind === 'back') {
    clicks = Math.max(0, clicks - 1);
  } else if (msg.kind === 'page_load' && typeof msg.clicksHint === 'number') {
    clicks = Math.max(0, msg.clicksHint);
  }

  send('update_progress', {
    clicks,
    currentTitle: msg.title || null,
    currentUrl: msg.url || null,
  });
}

// Seed local prefs then connect
chrome.storage.local.get(['serverUrl', 'playerName'], async (local) => {
  const patch = {};
  if (local.serverUrl) patch.serverUrl = local.serverUrl;
  if (local.playerName) patch.playerName = local.playerName;
  if (Object.keys(patch).length) await saveState(patch);
  connect();
});

chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    if (socket?.readyState === WebSocket.OPEN) send('ping');
    else connect();
  }
});
