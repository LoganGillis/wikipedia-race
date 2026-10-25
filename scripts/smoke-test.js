'use strict';

const { WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3847;
const WS_URL = process.env.WS_URL || `ws://127.0.0.1:${PORT}/ws`;
const HEALTH = process.env.HEALTH_URL || `http://127.0.0.1:${PORT}/health`;

function waitMessage(ws, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timeout waiting for message')), timeoutMs);
    const onMsg = (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(t);
        ws.off('message', onMsg);
        resolve(msg);
      }
    };
    ws.on('message', onMsg);
  });
}

async function main() {
  console.log('GET', HEALTH);
  const healthRes = await fetch(HEALTH);
  if (!healthRes.ok) throw new Error(`Health HTTP ${healthRes.status}`);
  const health = await healthRes.json();
  console.log('health:', health);
  if (!health.ok) throw new Error('Health not ok');

  console.log('WS connect', WS_URL);
  const ws = new WebSocket(WS_URL);

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const hello = await waitMessage(ws, (m) => m.type === 'hello');
  console.log('hello:', hello.message);

  ws.send(JSON.stringify({ type: 'create_lobby', name: 'SmokeTester' }));
  const created = await waitMessage(ws, (m) => m.type === 'lobby_created');
  console.log('lobby:', created.lobby.code, 'players:', created.lobby.players.length);
  if (!created.lobby?.code) throw new Error('No lobby code');

  ws.send(JSON.stringify({ type: 'start_race' }));
  const started = await waitMessage(
    ws,
    (m) => m.type === 'race_started' || m.type === 'error',
    20000
  );
  if (started.type === 'error') throw new Error(started.message);

  const { startPage, targetPage, startedAt, status } = started.lobby;
  console.log('status:', status);
  console.log('start:', startPage.title, '→', startPage.url);
  console.log('target:', targetPage.title, '→', targetPage.url);
  console.log('startedAt:', startedAt);

  if (!startPage?.title || !targetPage?.title) throw new Error('Missing pages');
  if (startPage.title === targetPage.title) throw new Error('Start === target');
  if (status !== 'racing') throw new Error('Expected racing status');
  if (!startedAt) throw new Error('Missing startedAt');

  // Simulate progress
  ws.send(
    JSON.stringify({
      type: 'update_progress',
      clicks: 3,
      currentTitle: startPage.title,
      currentUrl: startPage.url,
    })
  );
  const updated = await waitMessage(ws, (m) => m.type === 'lobby_update');
  const me = updated.lobby.players.find((p) => p.id === created.playerId);
  console.log('clicks after update:', me.clicks);
  if (me.clicks !== 3) throw new Error('Click update failed');

  // Second player join attempt on racing lobby should fail
  const ws2 = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    ws2.once('open', resolve);
    ws2.once('error', reject);
  });
  await waitMessage(ws2, (m) => m.type === 'hello');
  ws2.send(JSON.stringify({ type: 'join_lobby', code: created.lobby.code, name: 'Late' }));
  const late = await waitMessage(ws2, (m) => m.type === 'error' || m.type === 'lobby_joined');
  console.log('late join:', late.type, late.message || '');
  if (late.type !== 'error') throw new Error('Expected late join to fail');

  ws2.close();
  ws.close();
  console.log('\nSMOKE OK');
}

main().catch((err) => {
  console.error('\nSMOKE FAILED:', err.message);
  process.exit(1);
});
