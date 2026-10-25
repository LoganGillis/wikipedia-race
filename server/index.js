'use strict';

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT) || 3847;
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** @type {Map<string, Lobby>} */
const lobbies = new Map();
/** @type {Map<import('ws').WebSocket, string>} */
const socketPlayers = new Map();

/**
 * @typedef {object} Player
 * @property {string} id
 * @property {string} name
 * @property {import('ws').WebSocket|null} ws
 * @property {boolean} connected
 * @property {number} clicks
 * @property {string|null} currentTitle
 * @property {string|null} currentUrl
 * @property {boolean} finished
 * @property {number|null} finishedAt
 * @property {boolean} isHost
 */

/**
 * @typedef {object} WikiPage
 * @property {string} title
 * @property {string} url
 */

/**
 * @typedef {object} LinkClaim
 * @property {string} sourcePath
 * @property {string} targetPath
 * @property {string} playerId
 * @property {string} playerName
 */

/**
 * @typedef {object} Lobby
 * @property {string} code
 * @property {Map<string, Player>} players
 * @property {'waiting'|'racing'|'finished'} status
 * @property {'classic'|'pick'} mode
 * @property {'start'|'target'|'ready'|null} pickPhase
 * @property {string|null} startPickerId
 * @property {string|null} targetPickerId
 * @property {WikiPage|null} startPage
 * @property {WikiPage|null} targetPage
 * @property {number|null} startedAt
 * @property {LinkClaim[]} claims
 */

function makeLobbyCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (lobbies.has(code));
  return code;
}

function wikiUrl(title) {
  const slug = String(title).trim().replace(/ /g, '_');
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(slug).replace(/%2F/gi, '/')}`;
}

/** Canonical article path: /wiki/Title_With_Underscores (decoded, spaces→_). */
function normalizeWikiPath(path) {
  if (!path || typeof path !== 'string') return null;
  let p = path.trim();
  try {
    if (p.startsWith('http://') || p.startsWith('https://')) {
      p = new URL(p).pathname;
    }
  } catch {
    return null;
  }
  if (!p.startsWith('/wiki/')) return null;
  p = p.split('?')[0].split('#')[0];
  let rest = p.slice('/wiki/'.length);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    /* keep */
  }
  rest = rest.replace(/ /g, '_');
  if (!rest || rest.includes(':')) return null;
  return '/wiki/' + rest;
}

function pageFromTitleOrUrl(title, url) {
  let t = String(title || '').trim();
  let u = String(url || '').trim();
  if (!t && u) {
    const path = normalizeWikiPath(u);
    if (path) t = path.slice('/wiki/'.length).replace(/_/g, ' ');
  }
  if (!t) return null;
  if (!u) u = wikiUrl(t);
  const path = normalizeWikiPath(u) || normalizeWikiPath('/wiki/' + t.replace(/ /g, '_'));
  if (!path) return null;
  const normalizedTitle = path.slice('/wiki/'.length).replace(/_/g, ' ');
  return { title: normalizedTitle, url: wikiUrl(normalizedTitle) };
}

async function fetchRandomArticles(count) {
  const url = new URL(WIKI_API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('list', 'random');
  url.searchParams.set('rnnamespace', '0');
  url.searchParams.set('rnlimit', String(count));
  url.searchParams.set('origin', '*');

  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'WikipediaRace/1.2 (educational game; contact: github.com/LoganGillis/wikipedia-race)',
        },
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Wikipedia API HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`Wikipedia API HTTP ${res.status}`);
      const data = await res.json();
      const pages = data?.query?.random;
      if (!Array.isArray(pages) || pages.length < count) {
        throw new Error('Wikipedia API returned too few random pages');
      }
      return pages.map((p) => ({ title: p.title, url: wikiUrl(p.title) }));
    } catch (err) {
      lastErr = err;
      if (attempt < 4) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('Wikipedia API failed');
}

async function pickStartAndTarget() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const [a, b] = await fetchRandomArticles(2);
    if (a.title !== b.title) return { startPage: a, targetPage: b };
  }
  throw new Error('Could not pick distinct start/target pages');
}

/** Resolve redirects to the canonical article (Gray wolf → Wolf). */
async function resolveWikiPage(page) {
  if (!page) return null;
  let title = page.title ? String(page.title).trim() : '';
  if (!title && page.url) {
    const path = normalizeWikiPath(page.url);
    if (path) title = path.slice('/wiki/'.length).replace(/_/g, ' ');
  }
  if (!title) return null;
  const url = new URL(WIKI_API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('redirects', '1');
  url.searchParams.set('titles', title);
  url.searchParams.set('origin', '*');
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'WikipediaRace/1.2 (educational game; contact: github.com/LoganGillis/wikipedia-race)',
        },
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return pageFromTitleOrUrl(title, page.url);
      const data = await res.json();
      const pages = data?.query?.pages;
      if (!pages || typeof pages !== 'object') return pageFromTitleOrUrl(title, page.url);
      const first = Object.values(pages)[0];
      if (!first || first.missing != null || !first.title) {
        return pageFromTitleOrUrl(title, page.url);
      }
      return { title: first.title, url: wikiUrl(first.title) };
    } catch {
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
    }
  }
  return pageFromTitleOrUrl(title, page.url);
}

function sanitizeName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 24) || 'Player';
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    connected: p.connected,
    clicks: p.clicks,
    currentTitle: p.currentTitle,
    currentUrl: p.currentUrl,
    finished: p.finished,
    finishedAt: p.finishedAt,
    isHost: p.isHost,
  };
}

function assignPickers(lobby) {
  const list = [...lobby.players.values()];
  const host = list.find((p) => p.isHost) || list[0];
  const other = list.find((p) => p.id !== host?.id) || host;
  lobby.startPickerId = host?.id || null;
  lobby.targetPickerId = other?.id || null;
}

function lobbySnapshot(lobby) {
  return {
    code: lobby.code,
    status: lobby.status,
    mode: lobby.mode || 'classic',
    pickPhase: lobby.pickPhase,
    startPickerId: lobby.startPickerId,
    targetPickerId: lobby.targetPickerId,
    startPage: lobby.startPage,
    targetPage: lobby.targetPage,
    startedAt: lobby.startedAt,
    players: [...lobby.players.values()].map(publicPlayer),
    claims: lobby.claims.slice(),
  };
}

function send(ws, type, payload = {}) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcastLobby(lobby, type, extra = {}) {
  const snap = lobbySnapshot(lobby);
  for (const p of lobby.players.values()) {
    send(p.ws, type, { lobby: snap, ...extra });
  }
}

function broadcastRaw(lobby, type, payload, exceptPlayerId = null) {
  for (const p of lobby.players.values()) {
    if (exceptPlayerId && p.id === exceptPlayerId) continue;
    send(p.ws, type, payload);
  }
}

function findLobbyByPlayer(playerId) {
  for (const lobby of lobbies.values()) {
    if (lobby.players.has(playerId)) return lobby;
  }
  return null;
}

function detachSocket(ws) {
  const playerId = socketPlayers.get(ws);
  if (!playerId) return;
  socketPlayers.delete(ws);
  const lobby = findLobbyByPlayer(playerId);
  if (!lobby) return;
  const player = lobby.players.get(playerId);
  if (!player) return;
  player.ws = null;
  player.connected = false;
  broadcastRaw(lobby, 'cursor_leave', { playerId }, null);
  broadcastLobby(lobby, 'lobby_update');

  const anyConnected = [...lobby.players.values()].some((p) => p.connected);
  if (!anyConnected && lobby.status === 'waiting') {
    setTimeout(() => {
      const still = lobbies.get(lobby.code);
      if (!still) return;
      const connected = [...still.players.values()].some((p) => p.connected);
      if (!connected && still.status === 'waiting') {
        lobbies.delete(still.code);
      }
    }, 60_000);
  }
}

function createLobby(ws, name, mode) {
  const code = makeLobbyCode();
  const playerId = randomUUID();
  const resolvedMode = mode === 'pick' ? 'pick' : 'classic';
  /** @type {Lobby} */
  const lobby = {
    code,
    players: new Map(),
    status: 'waiting',
    mode: resolvedMode,
    pickPhase: resolvedMode === 'pick' ? 'start' : null,
    startPickerId: null,
    targetPickerId: null,
    startPage: null,
    targetPage: null,
    startedAt: null,
    claims: [],
  };
  const player = {
    id: playerId,
    name: sanitizeName(name),
    ws,
    connected: true,
    clicks: 0,
    currentTitle: null,
    currentUrl: null,
    finished: false,
    finishedAt: null,
    isHost: true,
  };
  lobby.players.set(playerId, player);
  assignPickers(lobby);
  lobbies.set(code, lobby);
  socketPlayers.set(ws, playerId);
  send(ws, 'lobby_created', { playerId, lobby: lobbySnapshot(lobby) });
}

function joinLobby(ws, code, name) {
  const normalized = String(code || '').trim().toUpperCase();
  const lobby = lobbies.get(normalized);
  if (!lobby) {
    send(ws, 'error', { message: 'Lobby not found' });
    return;
  }
  if (lobby.status !== 'waiting') {
    send(ws, 'error', { message: 'Race already in progress' });
    return;
  }
  const playerId = randomUUID();
  const player = {
    id: playerId,
    name: sanitizeName(name),
    ws,
    connected: true,
    clicks: 0,
    currentTitle: null,
    currentUrl: null,
    finished: false,
    finishedAt: null,
    isHost: false,
  };
  lobby.players.set(playerId, player);
  if (lobby.mode === 'pick') assignPickers(lobby);
  socketPlayers.set(ws, playerId);
  send(ws, 'lobby_joined', { playerId, lobby: lobbySnapshot(lobby) });
  broadcastLobby(lobby, 'lobby_update');
}


function resumeSession(ws, msg) {
  const code = String(msg.code || '').trim().toUpperCase();
  const playerId = String(msg.playerId || '').trim();
  const lobby = lobbies.get(code);
  if (!lobby || !playerId) {
    send(ws, 'error', { message: 'Cannot resume — lobby not found' });
    return;
  }
  const player = lobby.players.get(playerId);
  if (!player) {
    send(ws, 'error', { message: 'Cannot resume — player not in lobby' });
    return;
  }
  // Detach any stale socket mapped to this player
  if (player.ws && player.ws !== ws) {
    try {
      socketPlayers.delete(player.ws);
    } catch (_) {}
  }
  // If this ws was mapped to someone else, clear that
  const prev = socketPlayers.get(ws);
  if (prev && prev !== playerId) {
    const otherLobby = findLobbyByPlayer(prev);
    const other = otherLobby?.players.get(prev);
    if (other && other.ws === ws) {
      other.ws = null;
      other.connected = false;
    }
  }
  player.ws = ws;
  player.connected = true;
  if (msg.name) player.name = sanitizeName(msg.name);
  socketPlayers.set(ws, playerId);
  send(ws, 'lobby_joined', { playerId, lobby: lobbySnapshot(lobby), resumed: true });
  broadcastLobby(lobby, 'lobby_update');
}

function setMode(ws, mode) {
  const playerId = socketPlayers.get(ws);
  if (!playerId) return;
  const lobby = findLobbyByPlayer(playerId);
  if (!lobby) return;
  const player = lobby.players.get(playerId);
  if (!player?.isHost) {
    send(ws, 'error', { message: 'Only the host can change mode' });
    return;
  }
  if (lobby.status !== 'waiting') {
    send(ws, 'error', { message: 'Cannot change mode after race start' });
    return;
  }
  const next = mode === 'pick' ? 'pick' : 'classic';
  lobby.mode = next;
  lobby.startPage = null;
  lobby.targetPage = null;
  if (next === 'pick') {
    lobby.pickPhase = 'start';
    assignPickers(lobby);
  } else {
    lobby.pickPhase = null;
    lobby.startPickerId = null;
    lobby.targetPickerId = null;
  }
  broadcastLobby(lobby, 'lobby_update');
}

async function setPickPage(ws, msg) {
  const playerId = socketPlayers.get(ws);
  if (!playerId) return;
  const lobby = findLobbyByPlayer(playerId);
  if (!lobby) return;
  if (lobby.status !== 'waiting' || lobby.mode !== 'pick') {
    send(ws, 'error', { message: 'Not in Pick mode waiting lobby' });
    return;
  }
  const role = msg.role === 'target' ? 'target' : 'start';
  const allowedId = role === 'start' ? lobby.startPickerId : lobby.targetPickerId;
  if (playerId !== allowedId) {
    send(ws, 'error', { message: `Not your turn to pick the ${role} page` });
    return;
  }
  let page = pageFromTitleOrUrl(msg.title, msg.url);
  if (!page) {
    send(ws, 'error', { message: 'Invalid Wikipedia article' });
    return;
  }
  page = (await resolveWikiPage(page)) || page;
  if (role === 'start') {
    lobby.startPage = page;
    if (lobby.targetPage && normalizeTitle(lobby.targetPage.title) === normalizeTitle(page.title)) {
      lobby.targetPage = null;
    }
    lobby.pickPhase = lobby.targetPage ? 'ready' : 'target';
  } else {
    if (lobby.startPage && normalizeTitle(lobby.startPage.title) === normalizeTitle(page.title)) {
      send(ws, 'error', { message: 'Target must differ from start' });
      return;
    }
    lobby.targetPage = page;
    lobby.pickPhase = lobby.startPage ? 'ready' : 'start';
  }
  broadcastLobby(lobby, 'lobby_update');
}

async function startRace(ws) {
  const playerId = socketPlayers.get(ws);
  if (!playerId) {
    send(ws, 'error', { message: 'Not in a lobby' });
    return;
  }
  const lobby = findLobbyByPlayer(playerId);
  if (!lobby) {
    send(ws, 'error', { message: 'Lobby not found' });
    return;
  }
  const player = lobby.players.get(playerId);
  if (!player?.isHost) {
    send(ws, 'error', { message: 'Only the host can start the race' });
    return;
  }
  if (lobby.status !== 'waiting') {
    send(ws, 'error', { message: 'Race already started' });
    return;
  }

  send(ws, 'race_preparing', {});
  try {
    let startPage;
    let targetPage;
    if (lobby.mode === 'pick') {
      if (!lobby.startPage || !lobby.targetPage) {
        send(ws, 'error', { message: 'Pick mode needs both start and target pages' });
        return;
      }
      startPage = (await resolveWikiPage(lobby.startPage)) || lobby.startPage;
      targetPage = (await resolveWikiPage(lobby.targetPage)) || lobby.targetPage;
      if (normalizeTitle(startPage.title) === normalizeTitle(targetPage.title)) {
        send(ws, 'error', { message: 'Start and target must be different' });
        return;
      }
    } else {
      ({ startPage, targetPage } = await pickStartAndTarget());
    }

    lobby.startPage = startPage;
    lobby.targetPage = targetPage;
    lobby.startedAt = Date.now();
    lobby.status = 'racing';
    lobby.pickPhase = null;
    lobby.claims = [];
    for (const p of lobby.players.values()) {
      p.clicks = 0;
      p.currentTitle = startPage.title;
      p.currentUrl = startPage.url;
      p.finished = false;
      p.finishedAt = null;
    }
    broadcastLobby(lobby, 'race_started');
  } catch (err) {
    console.error('Failed to start race:', err);
    send(ws, 'error', { message: err.message || 'Failed to pick Wikipedia pages' });
  }
}

function updateProgress(ws, payload) {
  const playerId = socketPlayers.get(ws);
  if (!playerId) return;
  const lobby = findLobbyByPlayer(playerId);
  if (!lobby || lobby.status !== 'racing') return;
  const player = lobby.players.get(playerId);
  if (!player || player.finished) return;

  if (typeof payload.clicks === 'number' && Number.isFinite(payload.clicks)) {
    player.clicks = Math.max(0, Math.floor(payload.clicks));
  }
  if (typeof payload.currentTitle === 'string') {
    player.currentTitle = payload.currentTitle.slice(0, 200);
  }
  if (typeof payload.currentUrl === 'string') {
    player.currentUrl = payload.currentUrl.slice(0, 500);
  }

  const targetTitle = lobby.targetPage?.title;
  const targetPath =
    normalizeWikiPath(lobby.targetPage?.url) ||
    (targetTitle
      ? normalizeWikiPath('/wiki/' + String(targetTitle).replace(/ /g, '_'))
      : null);
  const currentPath =
    normalizeWikiPath(player.currentUrl) ||
    (player.currentTitle
      ? normalizeWikiPath('/wiki/' + String(player.currentTitle).replace(/ /g, '_'))
      : null);
  // Prefer canonical path match (survives Gray wolf → Wolf once target is resolved).
  const pathHit = Boolean(targetPath && currentPath && targetPath === currentPath);
  const titleHit =
    Boolean(targetTitle) &&
    Boolean(player.currentTitle) &&
    normalizeTitle(player.currentTitle) === normalizeTitle(targetTitle);
  if ((pathHit || titleHit) && !player.finished) {
    player.finished = true;
    player.finishedAt = Date.now();
    // First to target wins — end the race for everyone immediately
    lobby.status = 'finished';
  }

  broadcastLobby(lobby, 'lobby_update');

  // If not finished yet, resolve redirects async (Gray wolf → Wolf) and re-check.
  if (!player.finished && lobby.status === 'racing' && (player.currentUrl || player.currentTitle)) {
    maybeFinishViaCanonical(lobby, player).catch((err) => {
      console.error('canonical finish check failed:', err);
    });
  }
}

async function maybeFinishViaCanonical(lobby, player) {
  if (!lobby || lobby.status !== 'racing' || !player || player.finished) return;
  if (!lobby.targetPage) return;
  const [cur, tgt] = await Promise.all([
    resolveWikiPage({ title: player.currentTitle, url: player.currentUrl }),
    resolveWikiPage(lobby.targetPage),
  ]);
  if (!cur || !tgt) return;
  if (lobby.status !== 'racing' || player.finished) return;
  if (normalizeTitle(cur.title) !== normalizeTitle(tgt.title)) return;
  // Upgrade stored target to canonical so everyone sees the real article
  lobby.targetPage = tgt;
  player.currentTitle = cur.title;
  player.currentUrl = cur.url;
  player.finished = true;
  player.finishedAt = Date.now();
  lobby.status = 'finished';
  broadcastLobby(lobby, 'lobby_update');
}

function normalizeTitle(t) {
  return String(t).replace(/_/g, ' ').trim().toLowerCase();
}

function handleCursor(ws, msg) {
  const playerId = socketPlayers.get(ws);
  if (!playerId) return;
  const lobby = findLobbyByPlayer(playerId);
  if (!lobby || lobby.status !== 'racing') return;
  const player = lobby.players.get(playerId);
  if (!player) return;
  const x = Number(msg.x);
  const y = Number(msg.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const pagePath = normalizeWikiPath(msg.pagePath) || '';
  broadcastRaw(
    lobby,
    'cursor_update',
    {
      playerId,
      playerName: player.name,
      x: Math.max(0, x),
      y: Math.max(0, y),
      pagePath,
    },
    playerId
  );
}

function handleLinkClaim(ws, msg) {
  const playerId = socketPlayers.get(ws);
  if (!playerId) return;
  const lobby = findLobbyByPlayer(playerId);
  if (!lobby || lobby.status !== 'racing') return;
  const player = lobby.players.get(playerId);
  if (!player) return;

  const sourcePath = normalizeWikiPath(msg.sourcePath);
  const targetPath = normalizeWikiPath(msg.targetPath);
  if (!sourcePath || !targetPath) return;

  const exists = lobby.claims.some(
    (c) => c.sourcePath === sourcePath && c.targetPath === targetPath
  );
  if (exists) {
    const claim = lobby.claims.find(
      (c) => c.sourcePath === sourcePath && c.targetPath === targetPath
    );
    // Broadcast to everyone (including claimer) for UI sync
    broadcastRaw(lobby, 'link_claimed', { claim }, null);
    return;
  }

  const claim = {
    sourcePath,
    targetPath,
    playerId,
    playerName: player.name,
  };
  lobby.claims.push(claim);
  broadcastRaw(lobby, 'link_claimed', { claim }, null);
}

function handleLinkUnclaim(ws, msg) {
  const playerId = socketPlayers.get(ws);
  if (!playerId) return;
  const lobby = findLobbyByPlayer(playerId);
  if (!lobby || lobby.status !== 'racing') return;

  /** @type {LinkClaim[]} */
  let toRemove = [];
  if (Array.isArray(msg.claims) && msg.claims.length) {
    for (const raw of msg.claims) {
      const sourcePath = normalizeWikiPath(raw.sourcePath);
      const targetPath = normalizeWikiPath(raw.targetPath);
      if (!sourcePath || !targetPath) continue;
      const hit = lobby.claims.find(
        (c) =>
          c.sourcePath === sourcePath &&
          c.targetPath === targetPath &&
          c.playerId === playerId
      );
      if (hit) toRemove.push(hit);
    }
  } else {
    const sourcePath = normalizeWikiPath(msg.sourcePath);
    const targetPath = normalizeWikiPath(msg.targetPath);
    if (sourcePath && targetPath) {
      const hit = lobby.claims.find(
        (c) =>
          c.sourcePath === sourcePath &&
          c.targetPath === targetPath &&
          c.playerId === playerId
      );
      if (hit) toRemove.push(hit);
    }
  }
  if (!toRemove.length) return;

  const keys = new Set(toRemove.map((c) => `${c.sourcePath}::${c.targetPath}`));
  lobby.claims = lobby.claims.filter(
    (c) => !keys.has(`${c.sourcePath}::${c.targetPath}`)
  );
  broadcastRaw(lobby, 'link_unclaimed', { claims: toRemove }, null);
}

function resetPlayersForNewRound(lobby) {
  for (const p of lobby.players.values()) {
    p.clicks = 0;
    p.currentTitle = null;
    p.currentUrl = null;
    p.finished = false;
    p.finishedAt = null;
  }
  lobby.claims = [];
  lobby.startedAt = null;
}

/**
 * Host-only: after a finished race, start another round in the same lobby.
 * Classic → immediately roll new pages and race.
 * Pick → back to waiting so pickers choose again, then host Start race.
 */
async function nextRound(ws) {
  const playerId = socketPlayers.get(ws);
  if (!playerId) {
    send(ws, 'error', { message: 'Not in a lobby' });
    return;
  }
  const lobby = findLobbyByPlayer(playerId);
  if (!lobby) {
    send(ws, 'error', { message: 'Lobby not found' });
    return;
  }
  const player = lobby.players.get(playerId);
  if (!player?.isHost) {
    send(ws, 'error', { message: 'Only the host can start the next round' });
    return;
  }
  if (lobby.status !== 'finished') {
    send(ws, 'error', { message: 'Next round is only available after a finished race' });
    return;
  }

  resetPlayersForNewRound(lobby);

  if (lobby.mode === 'pick') {
    lobby.status = 'waiting';
    lobby.startPage = null;
    lobby.targetPage = null;
    lobby.pickPhase = 'start';
    assignPickers(lobby);
    broadcastLobby(lobby, 'lobby_update');
    return;
  }

  // Classic: new random pages, go straight into racing
  send(ws, 'race_preparing', {});
  try {
    const { startPage, targetPage } = await pickStartAndTarget();
    lobby.startPage = startPage;
    lobby.targetPage = targetPage;
    lobby.startedAt = Date.now();
    lobby.status = 'racing';
    lobby.pickPhase = null;
    for (const p of lobby.players.values()) {
      p.clicks = 0;
      p.currentTitle = startPage.title;
      p.currentUrl = startPage.url;
      p.finished = false;
      p.finishedAt = null;
    }
    broadcastLobby(lobby, 'race_started');
  } catch (err) {
    console.error('Failed to start next round:', err);
    lobby.status = 'waiting';
    lobby.startPage = null;
    lobby.targetPage = null;
    broadcastLobby(lobby, 'lobby_update');
    send(ws, 'error', { message: err.message || 'Failed to start next round' });
  }
}

function leaveLobby(ws) {
  const playerId = socketPlayers.get(ws);
  if (!playerId) return;
  const lobby = findLobbyByPlayer(playerId);
  socketPlayers.delete(ws);
  if (!lobby) return;
  const leaving = lobby.players.get(playerId);
  lobby.players.delete(playerId);
  broadcastRaw(lobby, 'cursor_leave', { playerId }, null);
  if (lobby.players.size === 0) {
    lobbies.delete(lobby.code);
    return;
  }
  if (leaving?.isHost) {
    for (const p of lobby.players.values()) p.isHost = false;
    const next =
      [...lobby.players.values()].find((p) => p.connected) ||
      lobby.players.values().next().value;
    if (next) next.isHost = true;
  }
  if (lobby.mode === 'pick' && lobby.status === 'waiting') assignPickers(lobby);
  broadcastLobby(lobby, 'lobby_update');
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'wikipedia-race',
    lobbies: lobbies.size,
    uptime: process.uptime(),
  });
});

app.get('/api/lobbies/:code', (req, res) => {
  const lobby = lobbies.get(String(req.params.code || '').toUpperCase());
  if (!lobby) return res.status(404).json({ error: 'not found' });
  res.json(lobbySnapshot(lobby));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  send(ws, 'hello', { message: 'Connected to Wikipedia Race server' });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send(ws, 'error', { message: 'Invalid JSON' });
      return;
    }
    const type = msg.type;
    try {
      switch (type) {
        case 'create_lobby':
          createLobby(ws, msg.name, msg.mode);
          break;
        case 'join_lobby':
          joinLobby(ws, msg.code, msg.name);
          break;
        case 'resume_session':
          resumeSession(ws, msg);
          break;
        case 'set_mode':
          setMode(ws, msg.mode);
          break;
        case 'set_pick_page':
          await setPickPage(ws, msg);
          break;
        case 'start_race':
          await startRace(ws);
          break;
        case 'next_round':
          await nextRound(ws);
          break;
        case 'update_progress':
          updateProgress(ws, msg);
          break;
        case 'cursor_update':
          handleCursor(ws, msg);
          break;
        case 'link_claim':
          handleLinkClaim(ws, msg);
          break;
        case 'link_unclaim':
          handleLinkUnclaim(ws, msg);
          break;
        case 'leave_lobby':
          leaveLobby(ws);
          break;
        case 'ping':
          send(ws, 'pong', { t: Date.now() });
          break;
        default:
          send(ws, 'error', { message: `Unknown type: ${type}` });
      }
    } catch (err) {
      console.error('Handler error:', err);
      send(ws, 'error', { message: err.message || 'Server error' });
    }
  });

  ws.on('close', () => detachSocket(ws));
  ws.on('error', () => detachSocket(ws));
});

server.listen(PORT, () => {
  console.log(`Wikipedia Race server listening on http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
});
