'use strict';

if (globalThis.__wrContentLoaded) {
  // Re-injected; ask existing instance to refresh
  try {
    chrome.runtime.sendMessage({ type: 'get_state' }, () => {});
  } catch (_) {}
} else {
(function wrMain() {
globalThis.__wrContentLoaded = true;

/**
 * Wikipedia Race content script
 *
 * Click counter:
 * - Article link click → +1 (pending flag; applied on next page show)
 * - Browser Back → −1 (floored at 0), including bfcache restores via `pageshow`
 * - Race-start / programmatic navigations do NOT count (seed + stack stores
 *   {path, clicks} so only real link clicks increment)
 *
 * Cursors: offsets relative to #mw-content-text (article root); receivers
 * place via that node's getBoundingClientRect so layout/sidebar drift is low.
 * Remote cursors only render when pagePath matches the current article.
 *
 * Claims: take a link → red strikethrough for others; Back releases claim.
 */

const STACK_KEY = '__wr_stack';
const INDEX_KEY = '__wr_index';
const PENDING_KEY = '__wr_pending';
const CLAIM_EDGES_KEY = '__wr_claim_edges';
const SEED_KEY = '__wr_seed_next';

const CURSOR_COLORS = [
  '#3d8bfd', '#3dd68c', '#f5a524', '#f31260', '#a78bfa', '#22d3ee', '#fb7185',
];

/** @type {{ playerId: string|null, playerName: string, racing: boolean, claims: any[], lobby: any|null }} */
let raceCtx = {
  playerId: null,
  playerName: '',
  racing: false,
  claims: [],
  lobby: null,
};

/** @type {Map<string, HTMLElement>} */
const cursorEls = new Map();
/** @type {Map<string, { name: string, contentX: number, contentY: number }>} */
const cursorPositions = new Map();
let cursorLayer = null;
let lastCursorSent = 0;
let claimsStyleEl = null;
let bootstrapped = false;

function canonicalWikiPath(input) {
  if (!input) return null;
  let p = String(input).trim();
  try {
    if (p.startsWith('http://') || p.startsWith('https://')) p = new URL(p).pathname;
  } catch {
    return null;
  }
  if (!p.startsWith('/wiki/')) return null;
  p = p.split('?')[0].split('#')[0];
  let rest = p.slice('/wiki/'.length);
  try {
    rest = decodeURIComponent(rest);
  } catch (_) {}
  rest = rest.replace(/ /g, '_');
  if (!rest || rest.includes(':')) return null;
  return '/wiki/' + rest;
}

function pathsEqual(a, b) {
  const ca = canonicalWikiPath(a);
  const cb = canonicalWikiPath(b);
  return Boolean(ca && cb && ca === cb);
}

function articlePathFromUrl(href) {
  return canonicalWikiPath(href);
}

function currentArticlePath() {
  return articlePathFromUrl(location.href);
}

function articleTitleFromLocation() {
  const path = currentArticlePath();
  if (!path) return document.title.replace(/ - Wikipedia$/, '');
  return decodeURIComponent(path.slice('/wiki/'.length)).replace(/_/g, ' ');
}

function isArticlePath(pathname) {
  if (!pathname.startsWith('/wiki/')) return false;
  const rest = pathname.slice('/wiki/'.length);
  try {
    return !decodeURIComponent(rest).includes(':');
  } catch {
    return !rest.includes(':');
  }
}

/** Normalize legacy string[] stacks to {path, clicks}[]. */
function loadStack() {
  try {
    const raw = sessionStorage.getItem(STACK_KEY);
    const stack = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(stack)) return [];
    return stack.map((entry, i) => {
      if (entry && typeof entry === 'object' && entry.path) {
        return { path: entry.path, clicks: Math.max(0, Number(entry.clicks) || 0) };
      }
      return { path: String(entry), clicks: i };
    });
  } catch {
    return [];
  }
}

function saveStack(stack, index) {
  try {
    sessionStorage.setItem(STACK_KEY, JSON.stringify(stack));
    sessionStorage.setItem(INDEX_KEY, String(index));
  } catch (_) {}
}

function loadIndex() {
  try {
    const n = Number(sessionStorage.getItem(INDEX_KEY));
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

function loadPending() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function savePending(pending) {
  try {
    if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch (_) {}
}

function loadClaimEdges() {
  try {
    const raw = sessionStorage.getItem(CLAIM_EDGES_KEY);
    const edges = raw ? JSON.parse(raw) : [];
    return Array.isArray(edges) ? edges : [];
  } catch {
    return [];
  }
}

function saveClaimEdges(edges) {
  try {
    sessionStorage.setItem(CLAIM_EDGES_KEY, JSON.stringify(edges));
  } catch (_) {}
}

function consumeSeedFlag() {
  try {
    if (sessionStorage.getItem(SEED_KEY) === '1') {
      sessionStorage.removeItem(SEED_KEY);
      return true;
    }
  } catch (_) {}
  return false;
}

function resetNavForNewRace() {
  try {
    sessionStorage.removeItem(STACK_KEY);
    sessionStorage.removeItem(INDEX_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    sessionStorage.removeItem(CLAIM_EDGES_KEY);
    sessionStorage.setItem(SEED_KEY, '1');
  } catch (_) {}
}

function report(kind, clicks) {
  const msg = {
    type: 'wiki_nav',
    kind,
    clicksHint: clicks,
  };
  // Server finishes whenever currentUrl/title matches the target. Only
  // in-article link clicks may carry location so inspect / typed URL /
  // seed / Back loads cannot false-win.
  if (kind === 'link_click') {
    msg.title = articleTitleFromLocation();
    msg.url = location.href;
  }
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function releaseClaimsBeyondClicks(newClicks) {
  const edges = loadClaimEdges();
  if (edges.length <= newClicks) return;
  const released = edges.splice(newClicks);
  saveClaimEdges(edges);
  if (!released.length) return;
  chrome.runtime
    .sendMessage({ type: 'link_unclaim', claims: released })
    .catch(() => {});
  for (const edge of released) {
    raceCtx.claims = raceCtx.claims.filter(
      (c) =>
        !(c.sourcePath === edge.sourcePath && c.targetPath === edge.targetPath)
    );
  }
  refreshClaimsUi();
}

function entryPath(entry) {
  return entry && typeof entry === 'object' ? entry.path : entry;
}

/**
 * Reconcile navigation stack. Clicks only increase on pending link clicks.
 */
function reconcileNavigation() {
  const path = currentArticlePath();
  const prevIndex = loadIndex();
  let stack = loadStack();
  let index = prevIndex;
  const pending = loadPending();
  const seeded = consumeSeedFlag();

  if (!path) {
    const clicks = index >= 0 && stack[index] ? stack[index].clicks : 0;
    return { clicks, kind: 'page_load' };
  }

  // New race seed (or cleared stack before start-page navigation)
  if (seeded || !stack.length || index < 0) {
    stack = [{ path, clicks: 0 }];
    index = 0;
    savePending(null);
    saveStack(stack, index);
    if (seeded) saveClaimEdges([]);
    return { clicks: 0, kind: 'page_load' };
  }

  if (
    pending &&
    pending.targetPath === path &&
    (index < 0 || pending.fromPath === entryPath(stack[index]))
  ) {
    const prevClicks = stack[index]?.clicks ?? 0;
    stack = stack.slice(0, index + 1);
    stack.push({ path, clicks: prevClicks + 1 });
    index = stack.length - 1;
    savePending(null);
    saveStack(stack, index);
    const edges = loadClaimEdges();
    if (edges.length > prevClicks + 1) {
      edges.length = prevClicks + 1;
      saveClaimEdges(edges);
    }
    return { clicks: prevClicks + 1, kind: 'link_click' };
  }

  // Match existing history entry (Back / Forward / refresh / bfcache)
  let found = -1;
  if (index >= 0 && index < stack.length && entryPath(stack[index]) === path) {
    found = index;
  } else {
    for (let i = index - 1; i >= 0; i--) {
      if (entryPath(stack[i]) === path) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      for (let i = index + 1; i < stack.length; i++) {
        if (entryPath(stack[i]) === path) {
          found = i;
          break;
        }
      }
    }
    if (found < 0) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (entryPath(stack[i]) === path) {
          found = i;
          break;
        }
      }
    }
  }

  if (found >= 0) {
    savePending(null);
    saveStack(stack, found);
    const clicks = stack[found].clicks;
    let kind = 'page_load';
    if (found < prevIndex) kind = 'back';
    else if (found > prevIndex) kind = 'forward_nav';
    if (found < prevIndex) {
      releaseClaimsBeyondClicks(clicks);
    }
    return { clicks, kind };
  }

  // Unknown path without pending (race start nav, typed URL, redirect):
  // keep the same click count — do NOT increment.
  const prevClicks = stack[index]?.clicks ?? 0;
  stack = stack.slice(0, index + 1);
  stack.push({ path, clicks: prevClicks });
  index = stack.length - 1;
  savePending(null);
  saveStack(stack, index);
  return { clicks: prevClicks, kind: 'page_load' };
}

function onPageShow() {
  const { clicks, kind } = reconcileNavigation();
  report(kind, clicks);
  if (kind === 'link_click') {
    maybeAnnounceTargetReached();
  }
  clearCursors();
  refreshClaimsUi();
  
/* Keep MV3 service worker + WS alive while on Wikipedia during a lobby/race */
let wrKeepalivePort = null;
function connectKeepalivePort() {
  try {
    wrKeepalivePort = chrome.runtime.connect({ name: 'wr-keepalive' });
    wrKeepalivePort.onDisconnect.addListener(() => {
      wrKeepalivePort = null;
      setTimeout(connectKeepalivePort, 1000);
    });
  } catch (_) {
    setTimeout(connectKeepalivePort, 2000);
  }
}
connectKeepalivePort();
setInterval(() => {
  const inLobby =
    raceCtx.lobby ||
    raceCtx.racing ||
    sessionStorage.getItem('__wr_racing') === '1';
  if (!inLobby) return;
  try {
    if (wrKeepalivePort) wrKeepalivePort.postMessage({ type: 'ping' });
  } catch (_) {
    connectKeepalivePort();
  }
  chrome.runtime.sendMessage({ type: 'keepalive', source: 'content' }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'get_state' }, (res) => {
    if (chrome.runtime.lastError || !res?.state) return;
    applyState(res.state);
  });
}, 15000);

syncRaceContext();
}

document.addEventListener(
  'click',
  (ev) => {
    if (
      ev.defaultPrevented ||
      ev.button !== 0 ||
      ev.metaKey ||
      ev.ctrlKey ||
      ev.shiftKey ||
      ev.altKey
    ) {
      return;
    }
    const a = ev.target.closest && ev.target.closest('a[href]');
    if (!a) return;

    let url;
    try {
      url = new URL(a.href, location.href);
    } catch {
      return;
    }
    if (url.origin !== location.origin) return;
    if (!isArticlePath(url.pathname)) return;
    if (url.pathname === location.pathname && url.search === location.search) return;

    const targetPath = articlePathFromUrl(url.href);
    const fromPath = currentArticlePath();
    if (!targetPath || !fromPath) return;

    const inRace = raceCtx.racing || sessionStorage.getItem('__wr_racing') === '1';
    if (inRace) raceCtx.racing = true;
    if (inRace && isClaimedByOther(fromPath, targetPath)) {
      ev.preventDefault();
      ev.stopPropagation();
      flashClaimed(a);
      return;
    }

    savePending({ targetPath, fromPath });

    if (inRace) {
      const stack = loadStack();
      const idx = loadIndex();
      const curClicks = idx >= 0 && stack[idx] ? stack[idx].clicks : 0;
      const edges = loadClaimEdges();
      edges.length = curClicks;
      const src = canonicalWikiPath(fromPath) || fromPath;
      const dst = canonicalWikiPath(targetPath) || targetPath;
      edges.push({ sourcePath: src, targetPath: dst });
      saveClaimEdges(edges);

      // Optimistic local claim so others' styling applies after broadcast;
      // also mark for self visibility
      if (!raceCtx.claims.some((c) => pathsEqual(c.sourcePath, src) && pathsEqual(c.targetPath, dst))) {
        raceCtx.claims.push({
          sourcePath: src,
          targetPath: dst,
          playerId: raceCtx.playerId || 'local',
          playerName: raceCtx.playerName || 'You',
        });
      }

      chrome.runtime
        .sendMessage({
          type: 'link_claim',
          sourcePath: src,
          targetPath: dst,
        })
        .catch(() => {});
    }
  },
  true
);

window.addEventListener('pageshow', () => {
  bootstrapped = true;
  onPageShow();
});

window.addEventListener('popstate', () => {
  onPageShow();
});

setTimeout(() => {
  if (!bootstrapped) onPageShow();
}, 0);

/* ─── Race context / claims / cursors ─── */

function syncRaceContext() {
  chrome.runtime.sendMessage({ type: 'get_state' }, (res) => {
    if (chrome.runtime.lastError || !res?.state) return;
    applyState(res.state);
  });
}

function applyState(state) {
  const lobby = state.lobby || null;
  raceCtx.playerId = state.playerId || null;
  raceCtx.playerName = state.playerName || '';
  raceCtx.lobby = lobby;
  raceCtx.racing = lobby?.status === 'racing';
  try {
    if (raceCtx.racing) sessionStorage.setItem('__wr_racing', '1');
    else if (lobby?.status !== 'finished') sessionStorage.removeItem('__wr_racing');
  } catch (_) {}
  if (Array.isArray(lobby?.claims)) {
    raceCtx.claims = lobby.claims.map((c) => ({
      ...c,
      sourcePath: canonicalWikiPath(c.sourcePath) || c.sourcePath,
      targetPath: canonicalWikiPath(c.targetPath) || c.targetPath,
    }));
  }
  if (!raceCtx.racing && lobby?.status !== 'finished') {
    clearCursors();
  }
  refreshClaimsUi();
  renderHud();
  renderVictory();
}

function isClaimedByOther(sourcePath, targetPath) {
  return raceCtx.claims.some(
    (c) =>
      pathsEqual(c.sourcePath, sourcePath) &&
      pathsEqual(c.targetPath, targetPath) &&
      c.playerId !== raceCtx.playerId
  );
}

function flashClaimed(a) {
  a.classList.add('wr-claim-flash');
  setTimeout(() => a.classList.remove('wr-claim-flash'), 400);
}

function refreshClaimsUi() {
  ensureClaimsStyle();
  const sourcePath = currentArticlePath();
  document.querySelectorAll('a.wr-claimed-link').forEach((el) => {
    el.classList.remove('wr-claimed-link');
    if (el.dataset.wrTitleOrig != null) {
      el.title = el.dataset.wrTitleOrig;
      delete el.dataset.wrTitleOrig;
    } else {
      el.removeAttribute('title');
    }
  });
  if (!raceCtx.racing || !sourcePath) return;

  const claimedHere = raceCtx.claims.filter((c) => pathsEqual(c.sourcePath, sourcePath));
  if (!claimedHere.length) return;

  const byTarget = new Map();
  for (const c of claimedHere) {
    const key = canonicalWikiPath(c.targetPath) || c.targetPath;
    byTarget.set(key, c);
  }

  const byTargetCanon = new Map();
  for (const [tp, claim] of byTarget) {
    const c = canonicalWikiPath(tp) || tp;
    byTargetCanon.set(c, claim);
  }

  document
    .querySelectorAll(
      '#content a[href], #bodyContent a[href], #mw-content-text a[href], main a[href], .mw-parser-output a[href]'
    )
    .forEach((a) => {
      const tp = articlePathFromUrl(a.href);
      if (!tp || !byTargetCanon.has(tp)) return;
      const claim = byTargetCanon.get(tp);
      a.classList.add('wr-claimed-link');
      if (a.dataset.wrTitleOrig == null) {
        a.dataset.wrTitleOrig = a.title || '';
      }
      a.title =
        claim.playerId === raceCtx.playerId
          ? 'You took this link (others see it as taken)'
          : `Taken by ${claim.playerName || 'another player'}`;
    });
}

function ensureClaimsStyle() {
  if (claimsStyleEl) return;
  claimsStyleEl = document.createElement('style');
  claimsStyleEl.id = 'wr-claims-style';
  claimsStyleEl.textContent = `
    a.wr-claimed-link,
    a.wr-claimed-link:visited,
    a.wr-claimed-link:link {
      color: #cc0000 !important;
      text-decoration: line-through !important;
      text-decoration-color: #cc0000 !important;
      cursor: not-allowed !important;
      opacity: 0.85 !important;
    }
    a.wr-claim-flash {
      background: rgba(204, 0, 0, 0.2) !important;
    }
    #wr-cursor-layer {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483646;
      overflow: hidden;
    }
    .wr-cursor {
      position: absolute;
      /* Tip of the arrow path is ~top-left of the SVG; pin that to (left, top). */
      transform: translate(-1px, -1px);
      transition: left 40ms linear, top 40ms linear;
      display: flex;
      align-items: center;
      gap: 6px;
      will-change: left, top;
      z-index: 2147483647;
    }
    .wr-cursor.is-offscreen { visibility: hidden; }
    .wr-cursor svg { display: block; width: 24px; height: 28px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.55)); }
    .wr-cursor-label {
      font: 700 13px/1.25 system-ui, sans-serif;
      color: #fff;
      background: #0b1220;
      border-radius: 6px;
      padding: 3px 8px;
      white-space: nowrap;
      border: 2px solid #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,.45);
      text-shadow: 0 1px 0 rgba(0,0,0,.4);
    }
  `;
  (document.head || document.documentElement).appendChild(claimsStyleEl);
}

function getContentRoot() {
  return (
    document.querySelector('#mw-content-text') ||
    document.querySelector('#bodyContent') ||
    document.querySelector('#content') ||
    document.documentElement
  );
}

/** Pointer → offsets relative to the article content root (viewport-stable via rect). */
function pointerToContentOffset(clientX, clientY) {
  const rect = getContentRoot().getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function contentOffsetToViewport(contentX, contentY) {
  const rect = getContentRoot().getBoundingClientRect();
  return {
    left: rect.left + contentX,
    top: rect.top + contentY,
  };
}

function ensureCursorLayer() {
  if (cursorLayer && cursorLayer.isConnected) return cursorLayer;
  ensureClaimsStyle();
  cursorLayer = document.createElement('div');
  cursorLayer.id = 'wr-cursor-layer';
  document.documentElement.appendChild(cursorLayer);
  return cursorLayer;
}

function colorForId(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return CURSOR_COLORS[h % CURSOR_COLORS.length];
}

function upsertCursor(playerId, playerName, contentX, contentY) {
  if (!raceCtx.racing && sessionStorage.getItem('__wr_racing') !== '1') return;
  if (playerId && raceCtx.playerId && playerId === raceCtx.playerId) return;
  cursorPositions.set(playerId, {
    name: playerName || 'Player',
    contentX: Number(contentX) || 0,
    contentY: Number(contentY) || 0,
  });
  renderCursor(playerId);
}

function renderCursor(playerId) {
  const pos = cursorPositions.get(playerId);
  if (!pos) return;
  const layer = ensureCursorLayer();
  let el = cursorEls.get(playerId);
  if (!el) {
    el = document.createElement('div');
    el.className = 'wr-cursor';
    const color = colorForId(playerId);
    el.innerHTML = `
      <svg width="24" height="28" viewBox="0 0 18 22" xmlns="http://www.w3.org/2000/svg">
        <path d="M1 1 L1 17 L5.5 13.5 L9 21 L12 19.5 L8.5 12 L15 12 Z"
          fill="${color}" stroke="#fff" stroke-width="1.4"/>
      </svg>
      <span class="wr-cursor-label" style="border-color:${color};background:${color}"></span>
    `;
    layer.appendChild(el);
    cursorEls.set(playerId, el);
  }
  el.querySelector('.wr-cursor-label').textContent = pos.name;
  // Content-root offsets → viewport for the fixed overlay (survives scroll/resize)
  const { left, top } = contentOffsetToViewport(pos.contentX, pos.contentY);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  const margin = 40;
  const off =
    left < -margin ||
    top < -margin ||
    left > window.innerWidth + margin ||
    top > window.innerHeight + margin;
  el.classList.toggle('is-offscreen', off);
}

function repositionAllCursors() {
  for (const id of cursorPositions.keys()) renderCursor(id);
}

function removeCursor(playerId) {
  cursorPositions.delete(playerId);
  const el = cursorEls.get(playerId);
  if (el) {
    el.remove();
    cursorEls.delete(playerId);
  }
}

function clearCursors() {
  for (const id of [...cursorEls.keys()]) removeCursor(id);
  cursorPositions.clear();
  if (cursorLayer) {
    cursorLayer.remove();
    cursorLayer = null;
  }
}

document.addEventListener(
  'mousemove',
  (ev) => {
    if (!raceCtx.racing && sessionStorage.getItem('__wr_racing') !== '1') return;
    raceCtx.racing = true;
    const now = performance.now();
    if (now - lastCursorSent < 50) return; // ~20 Hz
    lastCursorSent = now;
    const pagePath = currentArticlePath();
    const { x, y } = pointerToContentOffset(ev.clientX, ev.clientY);
    chrome.runtime
      .sendMessage({
        type: 'cursor_update',
        // Offsets relative to #mw-content-text (or bodyContent/content fallback)
        x,
        y,
        pagePath,
      })
      .catch(() => {});
  },
  { passive: true }
);

window.addEventListener('scroll', repositionAllCursors, { passive: true });
window.addEventListener('resize', repositionAllCursors);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'state' && msg.state) {
    applyState(msg.state);
    return;
  }
  if (msg.type === 'remote_cursor') {
    if (!raceCtx.racing && sessionStorage.getItem('__wr_racing') !== '1') return;
    raceCtx.racing = true;
    const myPath = currentArticlePath();
    const remotePath = msg.pagePath ? canonicalWikiPath(msg.pagePath) : null;
    // Different article (or missing pagePath) → hide; never show cross-page cursors
    if (!remotePath || !myPath || !pathsEqual(remotePath, myPath)) {
      removeCursor(msg.playerId);
      return;
    }
    upsertCursor(msg.playerId, msg.playerName, msg.x, msg.y);
    return;
  }
  if (msg.type === 'cursor_leave') {
    removeCursor(msg.playerId);
    return;
  }
  if (msg.type === 'link_claimed' && msg.claim) {
    raceCtx.racing = true;
    try { sessionStorage.setItem('__wr_racing', '1'); } catch (_) {}
    const c = {
      ...msg.claim,
      sourcePath: canonicalWikiPath(msg.claim.sourcePath) || msg.claim.sourcePath,
      targetPath: canonicalWikiPath(msg.claim.targetPath) || msg.claim.targetPath,
    };
    const exists = raceCtx.claims.some(
      (x) => pathsEqual(x.sourcePath, c.sourcePath) && pathsEqual(x.targetPath, c.targetPath)
    );
    if (!exists) raceCtx.claims.push(c);
    else {
      raceCtx.claims = raceCtx.claims.map((x) =>
        pathsEqual(x.sourcePath, c.sourcePath) && pathsEqual(x.targetPath, c.targetPath) ? c : x
      );
    }
    // Apply red/strikethrough immediately — do not wait for nav or popup
    refreshClaimsUi();
    const here = currentArticlePath();
    if (here && pathsEqual(here, c.sourcePath)) {
      document
        .querySelectorAll(
          '#content a[href], #bodyContent a[href], #mw-content-text a[href], main a[href], .mw-parser-output a[href]'
        )
        .forEach((a) => {
          const tp = articlePathFromUrl(a.href);
          if (tp && pathsEqual(tp, c.targetPath)) flashClaimed(a);
        });
    }
    return;
  }
  if (msg.type === 'link_unclaimed') {
    const list = Array.isArray(msg.claims)
      ? msg.claims
      : msg.claim
        ? [msg.claim]
        : msg.sourcePath && msg.targetPath
          ? [{ sourcePath: msg.sourcePath, targetPath: msg.targetPath }]
          : [];
    if (list.length) {
      raceCtx.claims = raceCtx.claims.filter(
        (c) =>
          !list.some(
            (u) =>
              pathsEqual(c.sourcePath, u.sourcePath) &&
              pathsEqual(c.targetPath, u.targetPath)
          )
      );
      refreshClaimsUi();
    }
    return;
  }
  if (msg.type === 'claims_reset') {
    raceCtx.claims = [];
    raceCtx.racing = true;
    try {
      sessionStorage.setItem('__wr_racing', '1');
    } catch (_) {}
    resetNavForNewRace();
    refreshClaimsUi();
    clearCursors();
  }
});

syncRaceContext();

let claimsMoTimer = null;
const mo = new MutationObserver(() => {
  if (!raceCtx.racing && sessionStorage.getItem('__wr_racing') !== '1') return;
  if (claimsMoTimer) return;
  claimsMoTimer = setTimeout(() => {
    claimsMoTimer = null;
    refreshClaimsUi();
  }, 50);
});
mo.observe(document.documentElement, { childList: true, subtree: true });


/* ─── Side HUD + victory banner ─── */

let hudRoot = null;
let hudCollapsed = false;
let hudTimer = null;
let victoryShownFor = null;

function formatSw(ms) {
  if (ms == null || ms < 0) return '00:00.0';
  const totalTenths = Math.floor(ms / 100);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + tenths;
}

function ensureHud() {
  ensureClaimsStyle();
  if (!document.getElementById('wr-hud-style')) {
    const st = document.createElement('style');
    st.id = 'wr-hud-style';
    st.textContent = `
      #wr-hud {
        position: fixed; top: 72px; right: 12px; z-index: 2147483645;
        width: 260px; max-height: calc(100vh - 96px); overflow: auto;
        background: rgba(15,20,25,0.94); color: #e7ecf3;
        border: 1px solid #2d3a4d; border-radius: 12px;
        font: 12px/1.4 system-ui, sans-serif;
        box-shadow: 0 8px 28px rgba(0,0,0,.35);
        pointer-events: auto;
      }
      #wr-hud.collapsed { width: auto; }
      #wr-hud.collapsed .wr-hud-body { display: none; }
      #wr-hud header {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px; padding: 8px 10px; cursor: pointer;
        border-bottom: 1px solid #2d3a4d; font-weight: 700;
      }
      #wr-hud .wr-hud-body { padding: 10px; }
      #wr-hud .row { display: flex; justify-content: space-between; gap: 8px; margin: 4px 0; }
      #wr-hud .muted { color: #8b9bb4; }
      #wr-hud .big { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
      #wr-hud ul { list-style: none; margin: 6px 0 0; padding: 0; }
      #wr-hud li {
        display: flex; justify-content: space-between; gap: 6px;
        padding: 4px 6px; margin-bottom: 3px; border-radius: 6px; background: #121a26;
      }
      #wr-hud li.you { outline: 1px solid #3d8bfd; }
      #wr-hud li.done { color: #3dd68c; }
      #wr-hud .hint { margin-top: 8px; font-size: 11px; color: #8b9bb4; }
      #wr-victory {
        position: fixed; inset: 0; z-index: 2147483647;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,0.45); pointer-events: auto;
      }
      #wr-victory .card {
        background: #1a2332; color: #e7ecf3; border-radius: 16px;
        padding: 22px 26px; max-width: 420px; text-align: center;
        border: 2px solid #3dd68c; box-shadow: 0 12px 40px rgba(0,0,0,.5);
        font: 14px/1.45 system-ui, sans-serif;
      }
      #wr-victory h2 { margin: 0 0 8px; font-size: 22px; color: #3dd68c; }
      #wr-victory button {
        margin-top: 14px; border: 0; border-radius: 8px; padding: 8px 14px;
        background: #3d8bfd; color: #fff; font-weight: 600; cursor: pointer;
      }
    `;
    (document.head || document.documentElement).appendChild(st);
  }
  if (!hudRoot || !hudRoot.isConnected) {
    hudRoot = document.createElement('div');
    hudRoot.id = 'wr-hud';
    hudRoot.innerHTML = '<header><span>Wikipedia Race</span><span class="wr-hud-toggle">▾</span></header><div class="wr-hud-body"></div>';
    document.documentElement.appendChild(hudRoot);
    hudRoot.querySelector('header').addEventListener('click', () => {
      hudCollapsed = !hudCollapsed;
      hudRoot.classList.toggle('collapsed', hudCollapsed);
      hudRoot.querySelector('.wr-hud-toggle').textContent = hudCollapsed ? '▸' : '▾';
    });
  }
  return hudRoot;
}

function renderHud() {
  const lobby = raceCtx.lobby;
  if (!lobby || (lobby.status !== 'racing' && lobby.status !== 'finished' && lobby.status !== 'waiting')) {
    if (hudRoot) hudRoot.remove();
    hudRoot = null;
    if (hudTimer) { clearInterval(hudTimer); hudTimer = null; }
    return;
  }
  // Show HUD in waiting (pick/lobby) and during/after race
  const root = ensureHud();
  const body = root.querySelector('.wr-hud-body');
  const me = lobby.players?.find((p) => p.id === raceCtx.playerId);
  const mode = lobby.mode === 'pick' ? 'Pick' : 'Classic';
  let statusLine = lobby.status;
  if (lobby.status === 'waiting' && lobby.mode === 'pick') {
    statusLine = lobby.pickPhase === 'ready' ? 'Pick: ready' : 'Pick: ' + (lobby.pickPhase || 'start');
  } else if (lobby.status === 'racing') statusLine = 'Racing';
  else if (lobby.status === 'finished') statusLine = 'Finished';

  const clicks = me?.clicks ?? 0;
  let sw = '00:00.0';
  if (lobby.startedAt && (lobby.status === 'racing' || lobby.status === 'finished')) {
    const end = me?.finished && me.finishedAt ? me.finishedAt : Date.now();
    sw = formatSw(end - lobby.startedAt);
  }

  const players = (lobby.players || [])
    .slice()
    .sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return (a.finishedAt || 0) - (b.finishedAt || 0);
      return (a.clicks || 0) - (b.clicks || 0);
    })
    .map((p) => {
      const cls = [p.id === raceCtx.playerId ? 'you' : '', p.finished ? 'done' : ''].filter(Boolean).join(' ');
      const meta = p.finished && lobby.startedAt && p.finishedAt
        ? p.clicks + ' · ' + formatSw(p.finishedAt - lobby.startedAt)
        : String(p.clicks ?? 0);
      return '<li class="' + cls + '"><span>' + escapeHtml(p.name) + (p.finished ? ' 🏆' : '') + '</span><span class="muted">' + meta + '</span></li>';
    })
    .join('');

  body.innerHTML = `
    <div class="row"><span class="muted">Lobby</span><span>${escapeHtml(lobby.code || '')} · ${mode}</span></div>
    <div class="row"><span class="muted">Status</span><span>${escapeHtml(statusLine)}</span></div>
    <div class="row"><span class="muted">Start</span><span>${escapeHtml(lobby.startPage?.title || '—')}</span></div>
    <div class="row"><span class="muted">Target</span><span>${escapeHtml(lobby.targetPage?.title || '—')}</span></div>
    <div class="row"><span class="muted">Clicks</span><span class="big">${clicks}</span></div>
    <div class="row"><span class="muted">Time</span><span class="big" id="wr-hud-sw">${sw}</span></div>
    <div class="muted" style="margin-top:8px;text-transform:uppercase;font-size:10px;letter-spacing:.04em">Players</div>
    <ul>${players}</ul>
    <p class="hint">Taken links are red + struck through. Back frees your last claim.</p>
  `;

  if (!hudTimer && lobby.status === 'racing') {
    hudTimer = setInterval(() => {
      const el = document.getElementById('wr-hud-sw');
      const lob = raceCtx.lobby;
      if (!el || !lob?.startedAt) return;
      const m = lob.players?.find((p) => p.id === raceCtx.playerId);
      const end = m?.finished && m.finishedAt ? m.finishedAt : Date.now();
      el.textContent = formatSw(end - lob.startedAt);
    }, 100);
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getWinners(lobby) {
  if (!lobby?.players) return [];
  return lobby.players
    .filter((p) => p.finished)
    .slice()
    .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
}

function renderVictory() {
  const lobby = raceCtx.lobby;
  const winners = getWinners(lobby);
  if (!winners.length) {
    const existing = document.getElementById('wr-victory');
    if (existing && lobby?.status !== 'finished') {
      /* keep dismissed banner away */
    }
    return;
  }
  const first = winners[0];
  const key = first.id + ':' + (first.finishedAt || '');
  if (victoryShownFor === key && document.getElementById('wr-victory')) return;
  if (victoryShownFor === key + ':dismissed') return;
  victoryShownFor = key;

  ensureClaimsStyle();
  let wrap = document.getElementById('wr-victory');
  if (wrap) wrap.remove();
  wrap = document.createElement('div');
  wrap.id = 'wr-victory';
  const time = lobby.startedAt && first.finishedAt ? formatSw(first.finishedAt - lobby.startedAt) : '—';
  const you = first.id === raceCtx.playerId;
  wrap.innerHTML = `
    <div class="card">
      <h2>${you ? 'You win!' : 'We have a winner!'}</h2>
      <p><strong>${escapeHtml(first.name)}</strong> reached <strong>${escapeHtml(lobby.targetPage?.title || 'the target')}</strong></p>
      <p>${first.clicks ?? 0} clicks · ${time}</p>
      <button type="button" id="wr-victory-dismiss">Nice</button>
    </div>
  `;
  document.documentElement.appendChild(wrap);
  wrap.querySelector('#wr-victory-dismiss').addEventListener('click', () => {
    victoryShownFor = key + ':dismissed';
    wrap.remove();
  });
}

function maybeAnnounceTargetReached() {
  const lobby = raceCtx.lobby;
  if (!lobby || lobby.status !== 'racing' || !lobby.targetPage) return;
  const path = currentArticlePath();
  const targetPath = canonicalWikiPath(lobby.targetPage.url) ||
    canonicalWikiPath('/wiki/' + String(lobby.targetPage.title || '').replace(/ /g, '_'));
  if (!path || !targetPath || !pathsEqual(path, targetPath)) return;
  const me = lobby.players?.find((p) => p.id === raceCtx.playerId);
  if (me?.finished) return;
  // Force progress update with location so server marks finish (link_click only path)
  const stack = loadStack();
  const idx = loadIndex();
  const clicks = idx >= 0 && stack[idx] ? stack[idx].clicks : me?.clicks ?? 0;
  report('link_click', clicks);
}


})(); // wrMain
}
