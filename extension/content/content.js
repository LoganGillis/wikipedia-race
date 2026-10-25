'use strict';

/**
 * Wikipedia Race content script
 *
 * Click counter:
 * - Article link click → +1 (pending flag; applied on next page show)
 * - Browser Back → −1 (floored at 0), including bfcache restores via `pageshow`
 * - Race-start / programmatic navigations do NOT count (seed + stack stores
 *   {path, clicks} so only real link clicks increment)
 *
 * Cursors: pageX/pageY (document space); receivers convert with scroll so
 * cursors stick to article content while scrolling.
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

/** @type {{ playerId: string|null, playerName: string, racing: boolean, claims: any[] }} */
let raceCtx = {
  playerId: null,
  playerName: '',
  racing: false,
  claims: [],
};

/** @type {Map<string, HTMLElement>} */
const cursorEls = new Map();
/** @type {Map<string, { name: string, pageX: number, pageY: number }>} */
const cursorPositions = new Map();
let cursorLayer = null;
let lastCursorSent = 0;
let claimsStyleEl = null;
let bootstrapped = false;

function articlePathFromUrl(href) {
  try {
    const u = new URL(href, location.href);
    if (!u.pathname.startsWith('/wiki/')) return null;
    const rest = decodeURIComponent(u.pathname.slice('/wiki/'.length));
    if (!rest || rest.includes(':')) return null;
    return '/wiki/' + rest;
  } catch {
    return null;
  }
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
  chrome.runtime.sendMessage({
    type: 'wiki_nav',
    kind,
    clicksHint: clicks,
    title: articleTitleFromLocation(),
    url: location.href,
  }).catch(() => {});
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
  refreshClaimsUi();
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

    if (raceCtx.racing && isClaimedByOther(fromPath, targetPath)) {
      ev.preventDefault();
      ev.stopPropagation();
      flashClaimed(a);
      return;
    }

    savePending({ targetPath, fromPath });

    if (raceCtx.racing) {
      const stack = loadStack();
      const idx = loadIndex();
      const curClicks = idx >= 0 && stack[idx] ? stack[idx].clicks : 0;
      const edges = loadClaimEdges();
      edges.length = curClicks;
      edges.push({ sourcePath: fromPath, targetPath });
      saveClaimEdges(edges);

      chrome.runtime
        .sendMessage({
          type: 'link_claim',
          sourcePath: fromPath,
          targetPath,
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
  const lobby = state.lobby;
  raceCtx.playerId = state.playerId || null;
  raceCtx.playerName = state.playerName || '';
  raceCtx.racing = lobby?.status === 'racing';
  if (Array.isArray(lobby?.claims)) raceCtx.claims = lobby.claims;
  // Do not reset nav stack here — that would wipe mid-race on script reinject.
  // Race start uses claims_reset + session seed (see service worker).
  if (!raceCtx.racing) {
    clearCursors();
  }
  refreshClaimsUi();
}

function isClaimedByOther(sourcePath, targetPath) {
  return raceCtx.claims.some(
    (c) =>
      c.sourcePath === sourcePath &&
      c.targetPath === targetPath &&
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

  const claimedHere = raceCtx.claims.filter((c) => c.sourcePath === sourcePath);
  if (!claimedHere.length) return;

  const byTarget = new Map();
  for (const c of claimedHere) byTarget.set(c.targetPath, c);

  document
    .querySelectorAll('#content a[href], #bodyContent a[href], #mw-content-text a[href]')
    .forEach((a) => {
      const tp = articlePathFromUrl(a.href);
      if (!tp || !byTarget.has(tp)) return;
      const claim = byTarget.get(tp);
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
      transform: translate(-2px, -2px);
      transition: left 50ms linear, top 50ms linear;
      display: flex;
      align-items: center;
      gap: 4px;
      will-change: left, top;
    }
    .wr-cursor.is-offscreen { visibility: hidden; }
    .wr-cursor svg { display: block; filter: drop-shadow(0 1px 1px rgba(0,0,0,.4)); }
    .wr-cursor-label {
      font: 600 11px/1.2 system-ui, sans-serif;
      color: #fff;
      background: rgba(15, 20, 25, 0.85);
      border-radius: 4px;
      padding: 2px 6px;
      white-space: nowrap;
      border: 1px solid rgba(255,255,255,.2);
    }
  `;
  (document.head || document.documentElement).appendChild(claimsStyleEl);
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

function upsertCursor(playerId, playerName, pageX, pageY) {
  if (!raceCtx.racing) return;
  if (playerId && playerId === raceCtx.playerId) return;
  cursorPositions.set(playerId, {
    name: playerName || 'Player',
    pageX: Number(pageX) || 0,
    pageY: Number(pageY) || 0,
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
      <svg width="18" height="22" viewBox="0 0 18 22" xmlns="http://www.w3.org/2000/svg">
        <path d="M1 1 L1 17 L5.5 13.5 L9 21 L12 19.5 L8.5 12 L15 12 Z"
          fill="${color}" stroke="#fff" stroke-width="1"/>
      </svg>
      <span class="wr-cursor-label" style="border-color:${color}"></span>
    `;
    layer.appendChild(el);
    cursorEls.set(playerId, el);
  }
  el.querySelector('.wr-cursor-label').textContent = pos.name;
  // Convert document coords → viewport for the fixed overlay
  const left = pos.pageX - window.scrollX;
  const top = pos.pageY - window.scrollY;
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
    if (!raceCtx.racing) return;
    const now = performance.now();
    if (now - lastCursorSent < 50) return; // ~20 Hz
    lastCursorSent = now;
    chrome.runtime
      .sendMessage({
        type: 'cursor_update',
        // Document/page space so scroll doesn't desync remote cursors
        x: ev.pageX,
        y: ev.pageY,
        pagePath: currentArticlePath(),
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
    if (!raceCtx.racing) return;
    const myPath = currentArticlePath();
    if (msg.pagePath && myPath && msg.pagePath !== myPath) {
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
    const c = msg.claim;
    const exists = raceCtx.claims.some(
      (x) => x.sourcePath === c.sourcePath && x.targetPath === c.targetPath
    );
    if (!exists) raceCtx.claims.push(c);
    refreshClaimsUi();
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
      const keys = new Set(list.map((c) => `${c.sourcePath}::${c.targetPath}`));
      raceCtx.claims = raceCtx.claims.filter(
        (c) => !keys.has(`${c.sourcePath}::${c.targetPath}`)
      );
      refreshClaimsUi();
    }
    return;
  }
  if (msg.type === 'claims_reset') {
    raceCtx.claims = [];
    resetNavForNewRace();
    refreshClaimsUi();
    clearCursors();
  }
});

syncRaceContext();

const mo = new MutationObserver(() => {
  if (raceCtx.racing) refreshClaimsUi();
});
mo.observe(document.documentElement, { childList: true, subtree: true });
