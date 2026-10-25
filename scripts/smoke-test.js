'use strict';

const { WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3847;
const WS_URL = process.env.WS_URL || `ws://127.0.0.1:${PORT}/ws`;
const HEALTH = process.env.HEALTH_URL || `http://127.0.0.1:${PORT}/health`;

function connect() {
  const ws = new WebSocket(WS_URL);
  const buffer = [];
  const waiters = [];

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].predicate(msg)) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
        return;
      }
    }
    buffer.push(msg);
  });

  ws.wait = (predicate, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      for (let i = 0; i < buffer.length; i++) {
        if (predicate(buffer[i])) {
          const msg = buffer.splice(i, 1)[0];
          resolve(msg);
          return;
        }
      }
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error('Timeout waiting for message'));
      }, timeoutMs);
      waiters.push({ predicate, resolve, reject, timer });
    });

  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function main() {
  console.log('GET', HEALTH);
  const healthRes = await fetch(HEALTH);
  if (!healthRes.ok) throw new Error(`Health HTTP ${healthRes.status}`);
  const health = await healthRes.json();
  console.log('health:', health);
  if (!health.ok) throw new Error('Health not ok');

  const ws = await connect();
  await ws.wait((m) => m.type === 'hello');

  ws.send(JSON.stringify({ type: 'create_lobby', name: 'SmokeTester' }));
  const created = await ws.wait((m) => m.type === 'lobby_created');
  console.log('lobby:', created.lobby.code, 'name:', created.lobby.players[0].name);
  if (created.lobby.players[0].name !== 'SmokeTester') {
    throw new Error('Full name not preserved');
  }

  const ws2 = await connect();
  await ws2.wait((m) => m.type === 'hello');
  ws2.send(
    JSON.stringify({ type: 'join_lobby', code: created.lobby.code, name: 'OtherPlayer' })
  );
  await ws2.wait((m) => m.type === 'lobby_joined');
  await ws.wait((m) => m.type === 'lobby_update');
  console.log('second player joined');

  ws.send(JSON.stringify({ type: 'start_race' }));
  const started = await ws.wait(
    (m) => m.type === 'race_started' || m.type === 'error',
    20000
  );
  if (started.type === 'error') throw new Error(started.message);
  await ws2.wait((m) => m.type === 'race_started', 20000);

  const { startPage, targetPage, startedAt, status } = started.lobby;
  console.log('status:', status);
  console.log('start:', startPage.title);
  console.log('target:', targetPage.title);
  if (startPage.title === targetPage.title) throw new Error('Start === target');
  if (!startedAt) throw new Error('Missing startedAt');

  ws.send(
    JSON.stringify({
      type: 'update_progress',
      clicks: 3,
      currentTitle: startPage.title,
      currentUrl: startPage.url,
    })
  );
  const updated = await ws.wait((m) => m.type === 'lobby_update');
  const me = updated.lobby.players.find((p) => p.id === created.playerId);
  if (me.clicks !== 3) throw new Error('Click update failed');
  console.log('clicks after update:', me.clicks);

  const sourcePath = '/wiki/' + encodeURIComponent(startPage.title.replace(/ /g, '_'));
  // Server normalizeWikiPath decodes; send a clean path
  const sourcePathClean = '/wiki/' + startPage.title.replace(/ /g, '_');
  const targetPath = '/wiki/Some_Claimed_Article';

  const claimWait = ws2.wait((m) => m.type === 'link_claimed');
  ws.send(JSON.stringify({ type: 'link_claim', sourcePath: sourcePathClean, targetPath }));
  const claimed = await claimWait;
  console.log('claim:', claimed.claim.sourcePath, '→', claimed.claim.targetPath);
  if (claimed.claim.playerName !== 'SmokeTester') throw new Error('claim name wrong');

  const cursorWait = ws2.wait((m) => m.type === 'cursor_update');
  ws.send(
    JSON.stringify({
      type: 'cursor_update',
      x: 0.25,
      y: 0.75,
      pagePath: sourcePathClean,
    })
  );
  const cursor = await cursorWait;
  console.log('cursor:', cursor.playerName, cursor.x, cursor.y);
  if (cursor.playerId !== created.playerId) throw new Error('cursor playerId mismatch');

  const unclaimWait = ws2.wait((m) => m.type === 'link_unclaimed');
  ws.send(
    JSON.stringify({ type: 'link_unclaim', sourcePath: sourcePathClean, targetPath })
  );
  const unclaimed = await unclaimWait;
  console.log('unclaimed count:', (unclaimed.claims || []).length);
  if (!unclaimed.claims?.length) throw new Error('expected unclaimed claims array');

  const ws3 = await connect();
  await ws3.wait((m) => m.type === 'hello');
  ws3.send(JSON.stringify({ type: 'create_lobby', name: '  Tester Name  ' }));
  const c3 = await ws3.wait((m) => m.type === 'lobby_created');
  if (c3.lobby.players[0].name !== 'Tester Name') {
    throw new Error(`Name sanitize failed: ${c3.lobby.players[0].name}`);
  }
  console.log('sanitized name ok:', c3.lobby.players[0].name);

  ws.close();
  ws2.close();
  ws3.close();
  console.log('\nSMOKE OK');
}

main().catch((err) => {
  console.error('\nSMOKE FAILED:', err.message);
  process.exit(1);
});
