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

async function classicRaceFlow() {
  const ws = await connect();
  await ws.wait((m) => m.type === 'hello');

  ws.send(JSON.stringify({ type: 'create_lobby', name: 'SmokeTester', mode: 'classic' }));
  const created = await ws.wait((m) => m.type === 'lobby_created');
  console.log('classic lobby:', created.lobby.code, 'mode:', created.lobby.mode);
  if (created.lobby.mode !== 'classic') throw new Error('expected classic mode');
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
      x: 420.5,
      y: 880,
      pagePath: sourcePathClean,
    })
  );
  const cursor = await cursorWait;
  console.log('cursor:', cursor.playerName, cursor.x, cursor.y);
  if (cursor.playerId !== created.playerId) throw new Error('cursor playerId mismatch');
  if (cursor.x !== 420.5 || cursor.y !== 880) throw new Error('page-space cursor coords mangled');

  const unclaimWait = ws2.wait((m) => m.type === 'link_unclaimed');
  ws.send(
    JSON.stringify({ type: 'link_unclaim', sourcePath: sourcePathClean, targetPath })
  );
  const unclaimed = await unclaimWait;
  console.log('unclaimed count:', (unclaimed.claims || []).length);
  if (!unclaimed.claims?.length) throw new Error('expected unclaimed claims array');

  // Finish by landing on target (path match) — first wins ends race for all
  const finishWait = ws2.wait(
    (m) =>
      m.type === 'lobby_update' &&
      m.lobby.status === 'finished' &&
      m.lobby.players.some((p) => p.id === created.playerId && p.finished)
  );
  ws.send(
    JSON.stringify({
      type: 'update_progress',
      clicks: 5,
      currentTitle: targetPage.title,
      currentUrl: targetPage.url,
    })
  );
  const finished = await finishWait;
  const winner = finished.lobby.players.find((p) => p.id === created.playerId);
  if (!winner.finished || !winner.finishedAt) throw new Error('finish detection failed');
  if (finished.lobby.status !== 'finished') throw new Error('race should end for everyone');
  console.log('finish ok (race ended):', winner.name, winner.clicks, 'clicks');

  ws.close();
  ws2.close();
}

async function resumeSessionFlow() {
  const host = await connect();
  await host.wait((m) => m.type === 'hello');
  host.send(JSON.stringify({ type: 'create_lobby', name: 'ResumeHost', mode: 'classic' }));
  const created = await host.wait((m) => m.type === 'lobby_created');
  const code = created.lobby.code;
  const playerId = created.playerId;

  const guest = await connect();
  await guest.wait((m) => m.type === 'hello');
  guest.send(JSON.stringify({ type: 'join_lobby', code, name: 'ResumeGuest' }));
  await guest.wait((m) => m.type === 'lobby_joined');
  await host.wait((m) => m.type === 'lobby_update');

  host.send(JSON.stringify({ type: 'start_race' }));
  const started = await host.wait((m) => m.type === 'race_started' || m.type === 'error', 20000);
  if (started.type === 'error') throw new Error(started.message);
  await guest.wait((m) => m.type === 'race_started', 20000);

  // Simulate SW death: drop host socket, reconnect, resume same playerId
  host.close();
  await new Promise((r) => setTimeout(r, 200));
  const host2 = await connect();
  await host2.wait((m) => m.type === 'hello');
  host2.send(
    JSON.stringify({
      type: 'resume_session',
      code,
      playerId,
      name: 'ResumeHost',
    })
  );
  const resumed = await host2.wait(
    (m) => m.type === 'lobby_joined' || m.type === 'error',
    10000
  );
  if (resumed.type === 'error') throw new Error(resumed.message);
  if (resumed.playerId !== playerId) throw new Error('resume playerId mismatch');
  if (resumed.lobby.status !== 'racing') throw new Error('expected racing after resume');
  console.log('resume ok:', playerId.slice(0, 8), 'still in', code);

  // Cursor from resumed host should reach guest
  const sourcePathClean =
    '/wiki/' + String(started.lobby.startPage.title).replace(/ /g, '_');
  const cursorWait = guest.wait((m) => m.type === 'cursor_update');
  host2.send(
    JSON.stringify({
      type: 'cursor_update',
      x: 111,
      y: 222,
      pagePath: sourcePathClean,
    })
  );
  const cursor = await cursorWait;
  if (cursor.playerId !== playerId) throw new Error('resumed cursor playerId wrong');
  console.log('resumed cursor ok');

  // Instant claim broadcast after resume
  const claimWait = guest.wait((m) => m.type === 'link_claimed');
  host2.send(
    JSON.stringify({
      type: 'link_claim',
      sourcePath: sourcePathClean,
      targetPath: '/wiki/Resume_Claim_Target',
    })
  );
  const claimed = await claimWait;
  if (claimed.claim.playerId !== playerId) throw new Error('resumed claim playerId wrong');
  console.log('resumed claim ok');

  host2.close();
  guest.close();
}

async function pickModeFlow() {
  const host = await connect();
  await host.wait((m) => m.type === 'hello');
  host.send(JSON.stringify({ type: 'create_lobby', name: 'PickHost', mode: 'pick' }));
  const created = await host.wait((m) => m.type === 'lobby_created');
  if (created.lobby.mode !== 'pick') throw new Error('expected pick mode');
  if (created.lobby.pickPhase !== 'start') throw new Error('expected pickPhase start');
  console.log('pick lobby:', created.lobby.code, 'phase:', created.lobby.pickPhase);

  const guest = await connect();
  await guest.wait((m) => m.type === 'hello');
  guest.send(
    JSON.stringify({ type: 'join_lobby', code: created.lobby.code, name: 'PickGuest' })
  );
  await guest.wait((m) => m.type === 'lobby_joined');
  const afterJoin = await host.wait((m) => m.type === 'lobby_update');
  if (!afterJoin.lobby.startPickerId || !afterJoin.lobby.targetPickerId) {
    throw new Error('pickers not assigned');
  }
  console.log(
    'pickers start=',
    afterJoin.lobby.startPickerId.slice(0, 8),
    'target=',
    afterJoin.lobby.targetPickerId.slice(0, 8)
  );

  // Host sets start (host is always start picker when alone then reassigned)
  const startPicker = afterJoin.lobby.startPickerId;
  const targetPicker = afterJoin.lobby.targetPickerId;
  const startWs = startPicker === created.playerId ? host : guest;
  const targetWs = targetPicker === created.playerId ? host : guest;
  const startPid = startPicker;
  const targetPid = targetPicker;

  startWs.send(
    JSON.stringify({
      type: 'set_pick_page',
      role: 'start',
      title: 'Python (programming language)',
      url: 'https://en.wikipedia.org/wiki/Python_(programming_language)',
    })
  );
  const afterStart = await host.wait(
    (m) => m.type === 'lobby_update' && m.lobby.startPage
  );
  if (!afterStart.lobby.startPage?.title) throw new Error('start page not set');
  if (afterStart.lobby.pickPhase !== 'target') throw new Error('expected target phase');
  console.log('pick start set:', afterStart.lobby.startPage.title);

  targetWs.send(
    JSON.stringify({
      type: 'set_pick_page',
      role: 'target',
      title: 'JavaScript',
      url: 'https://en.wikipedia.org/wiki/JavaScript',
    })
  );
  const afterTarget = await host.wait(
    (m) => m.type === 'lobby_update' && m.lobby.targetPage && m.lobby.pickPhase === 'ready'
  );
  console.log('pick target set:', afterTarget.lobby.targetPage.title);

  host.send(JSON.stringify({ type: 'start_race' }));
  const started = await host.wait(
    (m) => m.type === 'race_started' || m.type === 'error',
    10000
  );
  if (started.type === 'error') throw new Error(started.message);
  await guest.wait((m) => m.type === 'race_started', 10000);
  if (started.lobby.startPage.title !== 'Python (programming language)') {
    throw new Error('pick start not used');
  }
  if (started.lobby.targetPage.title !== 'JavaScript') {
    throw new Error('pick target not used');
  }
  console.log('pick race started with chosen pages');

  // Mode switch on new lobby
  const ws3 = await connect();
  await ws3.wait((m) => m.type === 'hello');
  ws3.send(JSON.stringify({ type: 'create_lobby', name: '  Tester Name  ', mode: 'classic' }));
  const c3 = await ws3.wait((m) => m.type === 'lobby_created');
  if (c3.lobby.players[0].name !== 'Tester Name') {
    throw new Error(`Name sanitize failed: ${c3.lobby.players[0].name}`);
  }
  ws3.send(JSON.stringify({ type: 'set_mode', mode: 'pick' }));
  const switched = await ws3.wait(
    (m) => m.type === 'lobby_update' && m.lobby.mode === 'pick'
  );
  if (switched.lobby.pickPhase !== 'start') throw new Error('mode switch failed');
  console.log('sanitized name + mode switch ok');

  host.close();
  guest.close();
  ws3.close();
}

async function main() {
  console.log('GET', HEALTH);
  const healthRes = await fetch(HEALTH);
  if (!healthRes.ok) throw new Error(`Health HTTP ${healthRes.status}`);
  const health = await healthRes.json();
  console.log('health:', health);
  if (!health.ok) throw new Error('Health not ok');

  await classicRaceFlow();
  await pickModeFlow();
  await resumeSessionFlow();
  console.log('\nSMOKE OK');
}

main().catch((err) => {
  console.error('\nSMOKE FAILED:', err.message);
  process.exit(1);
});
