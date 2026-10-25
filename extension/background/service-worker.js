'use strict';

const DEFAULT_SERVER = 'ws://51.81.33.210:3849/ws';
const CONTENT_SCRIPT_FILE = 'content/content.js';

/** @type {WebSocket|null} */
let socket = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let reconnectTimer = null;
let intentionalClose = false;
let offscreenCreating = null;
/** @type {number|null} */
let lastRaceTabId = null;

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

async function listWikiTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter(
    (t) => t.id != null && t.url && /https?:\/\/[^/]*wikipedia\.org\//i.test(t.url)
  );
}

async function ensureContentInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_FILE],
    });
  } catch (_) {
    /* already injected or restricted */
  }
}

async function ensureAllWikiContentInjected() {
  const tabs = await listWikiTabs();
  await Promise.all(tabs.map((t) => ensureContentInjected(t.id)));
  return tabs;
}

async function forwardToWikiTabs(msg) {
  try {
    const tabs = await listWikiTabs();
    await Promise.all(
      tabs.map(async (tab) => {
        try {
          await chrome.tabs.sendMessage(tab.id, msg);
        } catch (_) {
          await ensureContentInjected(tab.id);
          try {
            await chrome.tabs.sendMessage(tab.id, msg);
          } catch (__) {
            /* give up on this tab */
          }
        }
      })
    );
  } catch (_) {}
}

async function pushRaceFlagsToWikiTabs() {
  const tabs = await ensureAllWikiContentInjected();
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          try {
            sessionStorage.setItem('__wr_racing', '1');
          } catch (_) {}
        },
      });
    } catch (_) {}
  }
  const state = await loadState();
  await forwardToWikiTabs({ type: 'state', state });
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

async function ensureOffscreen() {
  if (!chrome.offscreen) return;
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (contexts && contexts.length) return;
  } catch (_) {
    // getContexts may be unavailable; try create anyway
  }
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['WORKERS'],
        justification:
          'Keep the multiplayer WebSocket alive while the service worker would otherwise sleep during a Wikipedia race',
      });
    } catch (err) {
      const msg = String(err?.message || err);
      if (!/already exists|Only a single/i.test(msg)) {
        console.warn('offscreen create failed', msg);
      }
    } finally {
      offscreenCreating = null;
    }
  })();
  await offscreenCreating;
}

async function maybeCloseOffscreen() {
  if (!chrome.offscreen) return;
  const state = await loadState();
  if (state.lobby) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch (_) {}
}

async function tryResumeSession() {
  const state = await loadState();
  if (!state.lobby?.code || !state.playerId) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  send('resume_session', {
    code: state.lobby.code,
    playerId: state.playerId,
    name: state.playerName || '',
  });
}

async function connect() {
  const state = await loadState();
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  intentionalClose = false;
  const url = toWsUrl(state.serverUrl);
  await saveState({ connectionStatus: 'connecting', lastError: null, serverUrl: url });
  if (state.lobby) await ensureOffscreen();

  try {
    socket = new WebSocket(url);
  } catch (err) {
    await saveState({ connectionStatus: 'error', lastError: String(err.message || err) });
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', async () => {
    await saveState({ connectionStatus: 'connected', lastError: null });
    await tryResumeSession();
    const st = await loadState();
    if (st.lobby?.status === 'racing') {
      await pushRaceFlagsToWikiTabs();
    } else if (st.lobby) {
      await ensureAllWikiContentInjected();
      await forwardToWikiTabs({ type: 'state', state: st });
    }
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
  }, 800);
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
      await ensureOffscreen();
      if (msg.lobby?.status === 'racing') {
        await pushRaceFlagsToWikiTabs();
        if (msg.lobby.startPage?.url && !msg.resumed) {
          openRaceTab(msg.lobby.startPage.url);
        }
      } else {
        await ensureAllWikiContentInjected();
      }
      break;
    case 'race_started':
      await saveState({ lobby: msg.lobby, lastError: null });
      await ensureOffscreen();
      await pushRaceFlagsToWikiTabs();
      if (msg.lobby?.startPage?.url) {
        await openRaceTab(msg.lobby.startPage.url);
      }
      break;
    case 'lobby_update':
    case 'race_preparing':
      if (msg.lobby) {
        await saveState({ lobby: msg.lobby });
        if (msg.lobby.status === 'racing') {
          await ensureOffscreen();
          await ensureAllWikiContentInjected();
        }
      }
      break;
    case 'cursor_update':
      await ensureAllWikiContentInjected();
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
      await ensureAllWikiContentInjected();
      forwardToWikiTabs({ type: 'link_claimed', claim: msg.claim });
      break;
    case 'link_unclaimed':
      await removeClaims(msg.claims || (msg.claim ? [msg.claim] : []), msg.sourcePath, msg.targetPath);
      await ensureAllWikiContentInjected();
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

async function seedRaceNavigationInWikiTabs() {
  const tabs = await ensureAllWikiContentInjected();
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          try {
            sessionStorage.removeItem('__wr_stack');
            sessionStorage.removeItem('__wr_index');
            sessionStorage.removeItem('__wr_pending');
            sessionStorage.removeItem('__wr_claim_edges');
            sessionStorage.setItem('__wr_seed_next', '1');
            sessionStorage.setItem('__wr_racing', '1');
          } catch (_) {}
        },
      });
    } catch (_) {}
    chrome.tabs.sendMessage(tab.id, { type: 'claims_reset' }).catch(() => {});
  }
}

async function preferRaceTab() {
  if (lastRaceTabId != null) {
    try {
      const tab = await chrome.tabs.get(lastRaceTabId);
      if (tab?.id != null && tab.url && /https?:\/\/[^/]*wikipedia\.org\//i.test(tab.url)) {
        return tab;
      }
    } catch (_) {
      lastRaceTabId = null;
    }
  }
  const tabs = await listWikiTabs();
  return tabs[0] || null;
}

async function openRaceTab(url, { seed = true } = {}) {
  if (seed) await seedRaceNavigationInWikiTabs();
  const existing = await preferRaceTab();
  let tabId;
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { url, active: true });
    tabId = existing.id;
  } else {
    const created = await chrome.tabs.create({ url, active: true });
    tabId = created.id;
  }
  if (tabId != null) lastRaceTabId = tabId;
  // After navigation settles, re-inject + push state
  setTimeout(async () => {
    await pushRaceFlagsToWikiTabs();
  }, 1200);
}

function sanitizeName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 24);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'wr-keepalive') return;
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'ping') {
      port.postMessage({ type: 'pong', t: Date.now() });
      if (socket?.readyState === WebSocket.OPEN) send('ping');
      else connect();
    }
  });
  port.onDisconnect.addListener(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'keepalive' || msg.type === 'get_state') {
      const state = await loadState();
      if (state.lobby) await ensureOffscreen();
      if (!(socket && socket.readyState === WebSocket.OPEN)) {
        await connect();
      } else if (msg.type === 'keepalive') {
        send('ping');
      }
      if (msg.type === 'get_state') {
        sendResponse({ state });
      } else {
        sendResponse({ ok: true, connectionStatus: (await loadState()).connectionStatus });
      }
      return;
    }
    if (msg.type === 'set_server_url') {
      intentionalClose = true;
      if (socket) socket.close();
      socket = null;
      intentionalClose = false;
      await saveState({ serverUrl: toWsUrl(msg.serverUrl), lobby: null, playerId: null });
      await maybeCloseOffscreen();
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
      await ensureOffscreen();
      send('create_lobby', { name, mode: msg.mode === 'pick' ? 'pick' : 'classic' });
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
      await ensureOffscreen();
      send('join_lobby', { code: msg.code, name });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'start_race') {
      send('start_race');
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'set_mode') {
      send('set_mode', { mode: msg.mode });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'set_pick_page') {
      send('set_pick_page', {
        role: msg.role,
        title: msg.title,
        url: msg.url,
      });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'leave_lobby') {
      send('leave_lobby');
      await saveState({ lobby: null, playerId: null });
      await maybeCloseOffscreen();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'wiki_nav') {
      await onWikiNav(msg);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'cursor_update') {
      if (!(socket && socket.readyState === WebSocket.OPEN)) {
        await ensureConnected();
        await tryResumeSession();
      }
      const ok = send('cursor_update', {
        x: msg.x,
        y: msg.y,
        pagePath: msg.pagePath,
      });
      sendResponse({ ok });
      return;
    }
    if (msg.type === 'link_claim') {
      if (!(socket && socket.readyState === WebSocket.OPEN)) {
        await ensureConnected();
        await tryResumeSession();
      }
      const ok = send('link_claim', {
        sourcePath: msg.sourcePath,
        targetPath: msg.targetPath,
      });
      sendResponse({ ok });
      return;
    }
    if (msg.type === 'link_unclaim') {
      if (!(socket && socket.readyState === WebSocket.OPEN)) {
        await ensureConnected();
        await tryResumeSession();
      }
      send('link_unclaim', {
        sourcePath: msg.sourcePath,
        targetPath: msg.targetPath,
        claims: msg.claims,
      });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'navigate_race_tab') {
      const url = String(msg.url || '').trim();
      if (!url || !/^https?:\/\/[^/]*wikipedia\.org\//i.test(url)) {
        sendResponse({ ok: false, error: 'invalid url' });
        return;
      }
      // Inspect start/target: reuse race tab, do NOT re-seed nav stack mid-race
      await openRaceTab(url, { seed: false });
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
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (socket?.readyState === WebSocket.OPEN) {
      await tryResumeSession();
      return true;
    }
  }
  return false;
}

async function onWikiNav(msg) {
  const state = await loadState();
  if (!state.lobby || state.lobby.status !== 'racing') return;
  const me = state.lobby.players?.find((p) => p.id === state.playerId);
  let clicks = me?.clicks ?? 0;

  if (typeof msg.clicksHint === 'number' && Number.isFinite(msg.clicksHint)) {
    clicks = Math.max(0, Math.floor(msg.clicksHint));
  } else if (msg.kind === 'link_click') {
    clicks += 1;
  } else if (msg.kind === 'back') {
    clicks = Math.max(0, clicks - 1);
  } else if (msg.kind === 'forward_nav') {
    clicks += 1;
  }

  if (state.lobby.players && state.playerId) {
    const players = state.lobby.players.map((p) =>
      p.id === state.playerId
        ? {
            ...p,
            clicks,
            currentTitle: msg.title || p.currentTitle,
            currentUrl: msg.url || p.currentUrl,
          }
        : p
    );
    await saveState({ lobby: { ...state.lobby, players } });
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
  const state = await loadState();
  if (state.lobby) await ensureOffscreen();
  connect();
});

chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'keepAlive') return;
  const state = await loadState();
  if (state.lobby) await ensureOffscreen();
  if (socket?.readyState === WebSocket.OPEN) send('ping');
  else connect();
});
