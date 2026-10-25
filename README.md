# Wikipedia Race

Multiplayer Wikipedia racing game: join a lobby, get the same random English Wikipedia **start** and **target** articles, then navigate by clicking links. First to the target wins (lowest clicks / fastest time are both visible).

This repo contains:

- **`server/`** — Node.js + Express + WebSocket lobby/race server
- **`extension/`** — Chrome Manifest V3 extension (popup + content script + service worker)

## Features (MVP)

- Create / join lobby with a short code
- Host starts the race → server picks two distinct random articles via the MediaWiki API
- Click counter: **+1** per article link navigation; **browser Back** undoes a click (never below 0), including bfcache restores
- **Stopwatch** counting up from race start (not a countdown)
- Extension popup shows live: lobby code, your name, connection status, start/target title+URL, clicks, stopwatch, player list / race status
- **Live shared cursors** during a race (labeled pointers in **document/page space**, so they track content while scrolling)
- **Claimed links**: when you take an in-article link, others still on that page see it **red + crossed out** and cannot follow it; **Backing out releases the claim** so others can take it again

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

## Load the Chrome extension

1. Start the server (above).
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** → select the **`extension/`** folder inside the repo (the folder that contains `manifest.json`), **not** the repo root. Loading `wikipedia-race/` itself fails with “Manifest file is missing”.
5. Pin **Wikipedia Race** from the puzzle-piece menu.
6. Open the popup:
   - Confirm server URL (`ws://localhost:3847/ws`)
   - Enter your name
   - **Create lobby** or enter a code and **Join**
7. Host clicks **Start race** — a Wikipedia tab opens on the start page. Navigate toward the target; watch clicks + stopwatch in the popup.

## Smoke test (no Chrome GUI)

With the server running in another terminal:

```bash
npm run smoke
```

This opens a WebSocket client, creates a lobby, starts a race, and checks that distinct start/target pages were returned.

## Protocol (WebSocket JSON)

Client → server:

| type | fields |
|------|--------|
| `create_lobby` | `name` |
| `join_lobby` | `code`, `name` |
| `start_race` | (host only) |
| `update_progress` | `clicks`, `currentTitle`, `currentUrl` |
| `leave_lobby` | |
| `ping` | |

Server → client: `hello`, `lobby_created`, `lobby_joined`, `lobby_update`, `race_preparing`, `race_started`, `error`, `pong`. Each lobby payload includes `code`, `status`, `startPage`, `targetPage`, `startedAt`, and `players[]`.

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

## Known gaps / next steps

- Full Chrome GUI testing (popup live updates, Back undo) still needs a real browser pass
- No auth, skins, avatars, or persistent leaderboards yet
- Click counting relies on content-script heuristics + `sessionStorage` / `history.state`; edge cases (middle-click, external redirects) are out of MVP scope
- Remote server needs `host_permissions` updated if not localhost


## Deploy (VPS)

If the game server runs on a VPS (e.g. under `~/wikipedia-race`):

```bash
cd ~/wikipedia-race && git pull && sudo systemctl restart wikipedia-race
```

Reload the Chrome extension (chrome://extensions → Reload) after pulling extension changes.

## License

MIT
