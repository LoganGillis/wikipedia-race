# Wikipedia Race

Multiplayer Wikipedia racing game: join a lobby, race from a **start** article to a **target** on English Wikipedia. First to the target wins. Clicks and elapsed time are tracked live for everyone.

This repo contains:

- **`server/`** — Node.js + Express + WebSocket lobby/race server
- **`extension/`** — Chrome Manifest V3 extension (popup + content script + service worker)

## Features

- Create / join lobby with a short code
- **Classic mode**: host starts → server picks two distinct random articles via the MediaWiki API
- **Pick mode**: players take turns choosing the start and target (paste URL/title or **Use current tab**); host starts when both are set
- Click counter: **+1** per article link navigation; **browser Back** undoes a click (never below 0), including bfcache restores
- Race start always seeds **0 clicks** on the start page
- **Stopwatch** counting up from race start
- Extension **popup** shows live: lobby, mode, name, connection, start/target, clicks, stopwatch, player list, winner banner
- **On-page side HUD** (collapsible) on Wikipedia during lobby/race: mode, pages, your clicks, stopwatch, player list, claim hint
- **Victory overlay** on Wikipedia for all players when someone reaches the target (winner name, clicks, time); popup winner banner too
- **Live shared cursors** during a race (labeled pointers in **document/page space**, so they track content while scrolling)
- **Claimed links**: when you take an in-article link, others still on that page see it **red + crossed out** and cannot follow it; **Backing out releases the claim**

## Requirements

- Node.js 18+
- Google Chrome (or Chromium) for the extension

## Run the server

```bash
cd wikipedia-race
npm install
npm start
```

Server defaults to **http://localhost:3847**  
WebSocket: **ws://localhost:3847/ws**  
Health: `GET /health`

Optional: `PORT=4000 npm start`

Public demo (if your VPS is up): `ws://51.81.33.210:3849/ws` (extension default).

## Load the Chrome extension

1. Start the server (above) or use the public WS URL.
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** → select the **`extension/`** folder inside the repo (the folder that contains `manifest.json`), **not** the repo root.
5. Pin **Wikipedia Race** from the puzzle-piece menu.
6. Open the popup:
   - Confirm server URL
   - Enter your name
   - Choose **Classic** or **Pick**, then **Create lobby** (or enter a code and **Join**)
7. **Classic**: host clicks **Start race**. **Pick**: the start picker sets the start page, then the target picker sets the target (Use current tab works well); host starts when both are ready.
8. A Wikipedia tab opens on the start page. Navigate toward the target; watch the **side HUD** and popup.

## Smoke test (no Chrome GUI)

With the server running in another terminal:

```bash
npm run smoke
```

Checks health, classic race (clicks, claims, page-space cursors, finish detection), and Pick mode (page picks + start).

## Protocol (WebSocket JSON)

Client → server:

| type | fields |
|------|--------|
| `create_lobby` | `name`, optional `mode` (`classic` \| `pick`) |
| `join_lobby` | `code`, `name` |
| `set_mode` | `mode` (host, waiting only) |
| `set_pick_page` | `role` (`start` \| `target`), `title` and/or `url` |
| `start_race` | (host only) |
| `update_progress` | `clicks`, `currentTitle`, `currentUrl` |
| `link_claim` / `link_unclaim` | `sourcePath`, `targetPath` |
| `cursor_update` | `x`, `y`, `pagePath` (page coordinates) |
| `leave_lobby` | |
| `ping` | |

Server → client: `hello`, `lobby_created`, `lobby_joined`, `lobby_update`, `race_preparing`, `race_started`, `link_claimed`, `link_unclaimed`, `cursor_update`, `error`, `pong`.

Lobby payloads include `code`, `status`, `mode`, `pickPhase`, picker ids, `startPage`, `targetPage`, `startedAt`, and `players[]` (with `finished` / `finishedAt` when someone wins).

## Project layout

```
wikipedia-race/
  server/index.js
  extension/
    manifest.json
    background/service-worker.js
    content/content.js
    popup/popup.{html,css,js}
    icons/
  scripts/smoke-test.js
  package.json
  README.md
```

## Deploy (VPS)

If the game server runs on a VPS (e.g. under `~/wikipedia-race`):

```bash
cd ~/wikipedia-race && git pull && sudo systemctl restart wikipedia-race
```

Reload the Chrome extension (`chrome://extensions` → Reload) after pulling extension changes.

## License

MIT
