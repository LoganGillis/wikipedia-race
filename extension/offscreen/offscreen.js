'use strict';
// Keeps the MV3 service worker from going idle while a race/lobby is active.
// The SW creates this document; we ping it on an interval so the WS stays up.
setInterval(() => {
  chrome.runtime.sendMessage({ type: 'keepalive', source: 'offscreen' }).catch(() => {});
}, 20000);

chrome.runtime.sendMessage({ type: 'keepalive', source: 'offscreen' }).catch(() => {});
