'use strict';

const DEFAULT_SERVER = 'ws://51.81.33.210:3849/ws';

/** @type {WebSocket|null} */
let socket = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let reconnectTimer = null;
let intentionalClose = false;

const defaultState = () => ({
  serverUrl: DEFAULT_SERVER,
  connectionStatus: 'disconnected',
  lastError: null,
  playerId: null,
  playerName: '',
  lobby: null,
});

async function loadState() {
  const stored = await chrome.storage.session.get(['raceState']);
  return { ...defaultState(), ...(stored.raceState || {}) };
}

async function saveState(partial) {
  const current = await loadState();
  const next = { ...current, ...partial };
  await chrome.storage.session.set({ raceState: next });
  await chrome.storage.local.set({
    serverUrl: next.serverUrl,
    playerName: next.playerName,
  });
  broadcastToExtension({ type: 'state', state: next });
  return next;
}

function broadcastToExtension(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
  forwardToWikiTabs(msg);
}

async function forwardToWikiTabs(msg) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://*.wikipedia.org/*'] });
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
      }
    }
  } catch (_) {}
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
    await saveState({ connectionStatus: 'disconnected' });
    if (!intentionalClose) scheduleReconnect();
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
      forwardToWikiTabs({ type: 'claims_reset' });
      if (msg.lobby?.startPage?.url) {
        openRaceTab(msg.lobby.startPage.url);
      }
      break;
    case 'lobby_update':
    case 'race_preparing':
      if (msg.lobby) await saveState({ lobby: msg.lobby });
      break;
    case 'cursor_update':
      forwardToWikiTabs({
        type: 'remote_cursor',
        playerId: msg.playerId,
        playerName: msg.playerName,
        x: msg.x,
        y: msg.y,
        pagePath: msg.pagePath,
      });
      break;
    case 'cursor_leave':
      forwardToWikiTabs({ type: 'cursor_leave', playerId: msg.playerId });
      break;
    case 'link_claimed':
      await mergeClaim(msg.claim);
      forwardToWikiTabs({ type: 'link_claimed', claim: msg.claim });
      break;
    case 'link_unclaimed':
      await removeClaims(msg.claims || (msg.claim ? [msg.claim] : []), msg.sourcePath, msg.targetPath);
      forwardToWikiTabs({
        type: 'link_unclaimed',
        claims: msg.claims,
        claim: msg.claim,
        sourcePath: msg.sourcePath,
        targetPath: msg.targetPath,
      });
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

async function mergeClaim(claim) {
  if (!claim) return;
  const state = await loadState();
  if (!state.lobby) return;
  const claims = Array.isArray(state.lobby.claims) ? state.lobby.claims.slice() : [];
  const exists = claims.some(
    (c) => c.sourcePath === claim.sourcePath && c.targetPath === claim.targetPath
  );
  if (!exists) claims.push(claim);
  await saveState({ lobby: { ...state.lobby, claims } });
}

async function removeClaims(list, sourcePath, targetPath) {
  const state = await loadState();
  if (!state.lobby) return;
  let claims = Array.isArray(state.lobby.claims) ? state.lobby.claims.slice() : [];
  if (Array.isArray(list) && list.length) {
    const keys = new Set(list.map((c) => `${c.sourcePath}::${c.targetPath}`));
    claims = claims.filter((c) => !keys.has(`${c.sourcePath}::${c.targetPath}`));
  } else if (sourcePath && targetPath) {
    claims = claims.filter(
      (c) => !(c.sourcePath === sourcePath && c.targetPath === targetPath)
    );
  }
  await saveState({ lobby: { ...state.lobby, claims } });
}

async function openRaceTab(url) {
  const tabs = await chrome.tabs.query({ url: ['https://*.wikipedia.org/*'] });
  if (tabs[0]?.id) {
    await chrome.tabs.update(tabs[0].id, { url, active: true });
  } else {
    await chrome.tabs.create({ url, active: true });
  }
}

function sanitizeName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 24);
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
      const playerName = sanitizeName(msg.name);
      await saveState({ playerName });
      sendResponse({ ok: true, playerName });
      return;
    }
    if (msg.type === 'create_lobby') {
      const state = await loadState();
      const name = sanitizeName(msg.name) || state.playerName || 'Player';
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
      const name = sanitizeName(msg.name) || state.playerName || 'Player';
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
    if (msg.type === 'cursor_update') {
      send('cursor_update', {
        x: msg.x,
        y: msg.y,
        pagePath: msg.pagePath,
      });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'link_claim') {
      send('link_claim', {
        sourcePath: msg.sourcePath,
        targetPath: msg.targetPath,
      });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'link_unclaim') {
      send('link_unclaim', {
        sourcePath: msg.sourcePath,
        targetPath: msg.targetPath,
        claims: msg.claims,
      });
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

  // Prefer absolute clicksHint from content script (nav stack) to avoid drift
  if (typeof msg.clicksHint === 'number' && Number.isFinite(msg.clicksHint)) {
    clicks = Math.max(0, Math.floor(msg.clicksHint));
  } else if (msg.kind === 'link_click' || msg.kind === 'forward_nav') {
    clicks += 1;
  } else if (msg.kind === 'back') {
    clicks = Math.max(0, clicks - 1);
  }

  send('update_progress', {
    clicks,
    currentTitle: msg.title || null,
    currentUrl: msg.url || null,
  });
}

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
