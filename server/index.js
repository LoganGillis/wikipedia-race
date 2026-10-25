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
/** @type {Map<import('ws').WebSocket, string>} playerId by socket */
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
 * @typedef {object} Lobby
 * @property {string} code
 * @property {Map<string, Player>} players
 * @property {'waiting'|'racing'|'finished'} status
 * @property {WikiPage|null} startPage
 * @property {WikiPage|null} targetPage
 * @property {number|null} startedAt
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
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

async function fetchRandomArticles(count) {
  const url = new URL(WIKI_API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('list', 'random');
  url.searchParams.set('rnnamespace', '0');
  url.searchParams.set('rnlimit', String(count));
  url.searchParams.set('origin', '*');

  const res = await fetch(url, {
    headers: { 'User-Agent': 'WikipediaRace/1.0 (educational game; contact: github.com/LoganGillis/wikipedia-race)' },
  });
  if (!res.ok) throw new Error(`Wikipedia API HTTP ${res.status}`);
  const data = await res.json();
  const pages = data?.query?.random;
  if (!Array.isArray(pages) || pages.length < count) {
    throw new Error('Wikipedia API returned too few random pages');
  }
  return pages.map((p) => ({ title: p.title, url: wikiUrl(p.title) }));
}

async function pickStartAndTarget() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const [a, b] = await fetchRandomArticles(2);
    if (a.title !== b.title) return { startPage: a, targetPage: b };
  }
  throw new Error('Could not pick distinct start/target pages');
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

function lobbySnapshot(lobby) {
  return {
    code: lobby.code,
    status: lobby.status,
    startPage: lobby.startPage,
    targetPage: lobby.targetPage,
    startedAt: lobby.startedAt,
    players: [...lobby.players.values()].map(publicPlayer),
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
  broadcastLobby(lobby, 'lobby_update');

  // Drop empty waiting lobbies after a short grace (checked lazily on next ops)
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

function createLobby(ws, name) {
  const code = makeLobbyCode();
  const playerId = randomUUID();
  /** @type {Lobby} */
  const lobby = {
    code,
    players: new Map(),
    status: 'waiting',
    startPage: null,
    targetPage: null,
    startedAt: null,
  };
  const player = {
    id: playerId,
    name: String(name || 'Player').trim().slice(0, 24) || 'Player',
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
    name: String(name || 'Player').trim().slice(0, 24) || 'Player',
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
  socketPlayers.set(ws, playerId);
  send(ws, 'lobby_joined', { playerId, lobby: lobbySnapshot(lobby) });
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
    const { startPage, targetPage } = await pickStartAndTarget();
    lobby.startPage = startPage;
    lobby.targetPage = targetPage;
    lobby.startedAt = Date.now();
    lobby.status = 'racing';
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
  if (
    targetTitle &&
    player.currentTitle &&
    normalizeTitle(player.currentTitle) === normalizeTitle(targetTitle)
  ) {
    player.finished = true;
    player.finishedAt = Date.now();
  }

  const allFinished =
    lobby.players.size > 0 &&
    [...lobby.players.values()].every((p) => p.finished || !p.connected);
  if (allFinished && [...lobby.players.values()].some((p) => p.finished)) {
    lobby.status = 'finished';
  }

  broadcastLobby(lobby, 'lobby_update');
}

function normalizeTitle(t) {
  return String(t).replace(/_/g, ' ').trim().toLowerCase();
}

function leaveLobby(ws) {
  const playerId = socketPlayers.get(ws);
  if (!playerId) return;
  const lobby = findLobbyByPlayer(playerId);
  socketPlayers.delete(ws);
  if (!lobby) return;
  const leaving = lobby.players.get(playerId);
  lobby.players.delete(playerId);
  if (lobby.players.size === 0) {
    lobbies.delete(lobby.code);
    return;
  }
  if (leaving?.isHost) {
    const next = lobby.players.values().next().value;
    if (next) next.isHost = true;
  }
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
          createLobby(ws, msg.name);
          break;
        case 'join_lobby':
          joinLobby(ws, msg.code, msg.name);
          break;
        case 'start_race':
          await startRace(ws);
          break;
        case 'update_progress':
          updateProgress(ws, msg);
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
