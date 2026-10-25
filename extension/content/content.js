'use strict';

/**
 * Tracks Wikipedia in-page navigations for the race click counter.
 * +1 when the user follows an article link; −1 on browser Back (never below 0).
 * History state is used so Back/Forward can be distinguished.
 */

const RACE_KEY = '__wikipedia_race_clicks';

function isArticlePath(pathname) {
  return pathname.startsWith('/wiki/') &&
    !pathname.includes(':') && // skip Special:, Help:, etc. roughly
    !pathname.startsWith('/wiki/Special:');
}

function articleTitleFromLocation() {
  const path = location.pathname;
  if (!path.startsWith('/wiki/')) return document.title.replace(/ - Wikipedia$/, '');
  const raw = decodeURIComponent(path.slice('/wiki/'.length)).replace(/_/g, ' ');
  // Filter non-article namespaces that slipped through
  if (raw.includes(':')) return raw;
  return raw;
}

function report(kind, extra = {}) {
  chrome.runtime.sendMessage({
    type: 'wiki_nav',
    kind,
    title: articleTitleFromLocation(),
    url: location.href,
    ...extra,
  }).catch(() => {});
}

function ensureHistoryState() {
  const state = history.state && typeof history.state === 'object' ? history.state : {};
  if (state[RACE_KEY] == null) {
    const clicks = 0;
    history.replaceState({ ...state, [RACE_KEY]: clicks }, '');
  }
}

function bumpHistoryClicks(delta) {
  const state = history.state && typeof history.state === 'object' ? history.state : {};
  const prev = typeof state[RACE_KEY] === 'number' ? state[RACE_KEY] : 0;
  const next = Math.max(0, prev + delta);
  // When leaving via link, pushState is done by the browser on navigation;
  // we set on the *current* entry before unload isn't reliable. Instead we
  // store intended clicks in sessionStorage for the next page load.
  try {
    sessionStorage.setItem(RACE_KEY, String(next));
    sessionStorage.setItem(RACE_KEY + '_pendingKind', delta > 0 ? 'link_click' : 'back');
  } catch (_) {}
  return next;
}

// Capture clicks on article links inside #content / #bodyContent
document.addEventListener(
  'click',
  (ev) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) {
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
    // Same-page hash-only
    if (url.pathname === location.pathname && url.search === location.search) return;

    bumpHistoryClicks(1);
  },
  true
);

window.addEventListener('popstate', () => {
  // Browser Back / Forward. Compare stored click on this history entry vs previous hint.
  const state = history.state && typeof history.state === 'object' ? history.state : {};
  let entryClicks = typeof state[RACE_KEY] === 'number' ? state[RACE_KEY] : null;
  let prev;
  try {
    prev = Number(sessionStorage.getItem(RACE_KEY) || '0');
  } catch {
    prev = 0;
  }

  if (entryClicks == null) {
    // No race marker on this entry — treat as Back (undo one click).
    entryClicks = Math.max(0, prev - 1);
    history.replaceState({ ...state, [RACE_KEY]: entryClicks }, '');
    try {
      sessionStorage.setItem(RACE_KEY, String(entryClicks));
    } catch (_) {}
    report('back', { clicksHint: entryClicks });
    return;
  }

  try {
    sessionStorage.setItem(RACE_KEY, String(entryClicks));
  } catch (_) {}

  if (entryClicks < prev) {
    report('back', { clicksHint: entryClicks });
  } else if (entryClicks > prev) {
    report('forward_nav', { clicksHint: entryClicks });
  } else {
    report('page_load', { clicksHint: entryClicks });
  }
});

function onPageReady() {
  ensureHistoryState();
  let pendingKind = null;
  let clicks = 0;
  try {
    pendingKind = sessionStorage.getItem(RACE_KEY + '_pendingKind');
    clicks = Number(sessionStorage.getItem(RACE_KEY) || '0');
    sessionStorage.removeItem(RACE_KEY + '_pendingKind');
  } catch (_) {}

  const state = history.state && typeof history.state === 'object' ? history.state : {};
  history.replaceState({ ...state, [RACE_KEY]: clicks }, '');

  if (pendingKind === 'link_click') {
    report('link_click', { clicksHint: clicks });
  } else if (pendingKind === 'back') {
    report('back', { clicksHint: clicks });
  } else {
    report('page_load', { clicksHint: clicks });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onPageReady);
} else {
  onPageReady();
}
