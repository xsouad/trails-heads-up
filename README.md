# Trails Heads Up — initial working version

A real-time multiplayer "Heads Up!" style party game themed around the Legend of Heroes:
Trails series. This is a working Node.js + Socket.io app (not a static HTML mockup) —
it needs to be run with Node to actually work, since it depends on a live server for
rooms, player sync, and privacy (hiding your own item from you).

## What's implemented (initial version)

- Room creation with a join code (2–5 players).
- Host-only room settings: spoiler cutoff picker (FC → KAI tag chips, pulled live from
  `data/gameOrder.json`) and category picker (Characters / Events; Locations is present
  as a disabled "coming soon" chip since there's no Locations data yet).
- Avatar customization: 3 cyclable layers (skin/base color, face, hat) using your
  uploaded sprites, left/right arrows per layer, plus a randomize button. The avatar
  carries over unchanged from customization into the actual game.
- Lobby screen showing everyone who's joined with their live avatar.
- Random, unique item assignment per round — pulled from `data/characters.json` and
  `data/events.json`, filtered by the host's cutoff + category settings. Server rejects
  starting the game if the filtered pool is smaller than the player count.
- Each player's assigned item is hidden from themselves and visible to everyone else,
  the whole round — enforced server-side (not just hidden in the UI), so there's no way
  to cheat by reading the page source or network tab.
- Item display rule: shows the image if `assets/items/characters/<file>` or
  `assets/items/events/<file>` exists, with the name/description captioned underneath;
  falls back to text-only if the image is missing (true today for basically everything,
  since no character/event art has been supplied yet — see "Adding images" below).
- Click any item bubble to zoom in.
- Responsive layout: full avatar + item above the head on desktop; compact
  avatar + name + item row on narrow/mobile screens (CSS media query at 480px).
- Reveal mechanic: each player clicks "I'm Ready to Reveal," a live `X/N` counter
  updates for everyone, and once everyone's clicked, the round ends and everyone can
  see their own item. Host gets a "Play Again" button that returns the room to the
  lobby with the same settings so they can adjust before the next round.

## Running it locally

```
npm install
npm start
```

Then open `http://localhost:3000` in a few browser tabs (or on your phone on the same
wifi via `http://<your-computer's-local-ip>:3000`) to test with multiple "players."

## Adding character/event images later

Drop image files into:

- `client/assets/items/characters/`
- `client/assets/items/events/`

using the exact filename from the `Image Filename` column in
`trails_content_bank_v5.xlsx` (e.g. `rean_schwarzer.png`). No code changes or restart
needed — the client tries to load the image and falls back to text automatically if
it's missing.

## Adding a Locations category

There's no Locations tab in the spreadsheet yet. Once one exists (same columns as
Events), add a `data/locations.json` the same way `gameData.js` loads characters/events,
add it to `buildPool()` in `server/gameData.js`, and flip `enabled: true` for the
"Locations" entry in `CATEGORY_DEFS` in `client/app.js`.

## Hosting this online (so friends can join from anywhere, not just your wifi)

This needs a host that keeps a persistent Node process running with WebSocket support —
Netlify alone won't work for the server half. Good options: Render, Railway, or Fly.io
(all have free/cheap tiers and support Node + WebSockets directly). Deploy this whole
folder as-is; `npm start` is the start command, and it reads `PORT` from the environment
already, which those platforms set automatically.

## Known gaps / next steps (see the open questions in the original spec doc)

- Locations category isn't wired up yet (no data source).
- No reconnect handling if someone's browser refreshes mid-round (they'd rejoin as a new
  player rather than resuming their seat) — worth adding if that comes up in testing.
- Avatar layer contents (skin/face/hat) match exactly what you uploaded; if you add more
  sprite variants later, just drop them in `client/assets/avatar/<layer>/` following the
  `<layer>_N.png` naming pattern and bump the count in `LAYER_COUNTS` in `client/app.js`.
