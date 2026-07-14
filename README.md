# Trails Heads Up (initial working version)

A real-time multiplayer "Heads Up!" style party game themed around the Legend of Heroes:
Trails series. This is a working Node.js + Socket.io app, not a static HTML mockup. It
needs to be run with Node to actually work, since it depends on a live server for rooms,
player sync, and privacy (hiding your own item from you).

## New in this update

- **Leave Room button** (always visible at the bottom) with a confirmation dialog.
  Leaving or disconnecting (closed tab, refresh, crash) now broadcasts a toast notice
  ("X left the room") to everyone else instead of the game looking stuck.
- **End Game vote**, shown only during an active round: any player can click "End Game"
  to cast a vote; once more than half of current players have voted (e.g. 2 of 3, 3 of
  5), the room closes for everyone immediately.
- **Public/private rooms**: choose visibility when creating a room. Public rooms show up
  in a browsable list on the home screen with a live player/spectator count, offering a
  "Join" button while the room is still in its lobby (awaiting start) and a "Watch"
  button once it's in progress.
- **Spectator mode**: anyone can join a public room in progress as a spectator instead
  of one of the 2-5 players. Spectators see every player's item with no privacy
  restriction, and a spectator count is shown to the active players during the round.
- **Rematch consensus screen**: at the end of a round, the host can click "Ask for
  Rematch." Everyone sees a banner and an avatar row with a checkmark next to whoever's
  said yes so far; once every remaining player has agreed, a new round starts
  automatically with the same settings.
- Clearer errors: trying to start with fewer than 2 players now says "You need at least
  2 players to start a game" instead of a misleading host-permission message.

## What's implemented

- Room creation with a join code (2-5 players).
- Host-only room settings: spoiler cutoff picker (FC through KAI tag chips, pulled live
  from `data/gameOrder.json`) and category picker (Characters / Events; Locations is
  present as a disabled "coming soon" chip since there's no Locations data yet).
- Avatar customization: 3 cyclable layers (skin/base color, face, hat) using your
  uploaded sprites, left/right arrows per layer, plus a randomize button. The avatar
  carries over unchanged from customization into the actual game.
- Lobby screen showing everyone who's joined with their live avatar.
- Random, unique item assignment per round, pulled from `data/characters.json` and
  `data/events.json`, filtered by the host's cutoff and category settings. Server
  rejects starting the game if the filtered pool is smaller than the player count.
- Each player's assigned item is hidden from themselves and visible to everyone else for
  the whole round. This is enforced server-side (not just hidden in the UI), so there's
  no way to cheat by reading the page source or network tab.
- Item display rule: shows the image if `assets/items/characters/<file>` or
  `assets/items/events/<file>` exists, with the name/description captioned underneath;
  falls back to text-only if the image is missing (true today for basically everything,
  since no character/event art has been supplied yet; see "Adding images" below).
- Click any item bubble to zoom in.
- Responsive layout: full avatar + item above the head on desktop; compact
  avatar + name + item row on narrow/mobile screens (CSS media query at 480px).
- Reveal mechanic: each player clicks "I'm Ready to Reveal," a live `X/N` counter
  updates for everyone, and once everyone's clicked, the round ends and everyone can see
  their own item.

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
needed; the client tries to load the image and falls back to text automatically if it's
missing.

## Adding a Locations category

There's no Locations tab in the spreadsheet yet. Once one exists (same columns as
Events), add a `data/locations.json` the same way `gameData.js` loads characters/events,
add it to `buildPool()` in `server/gameData.js`, and flip `enabled: true` for the
"Locations" entry in `CATEGORY_DEFS` in `client/app.js`.

## Hosting this online (so friends can join from anywhere, not just your wifi)

This needs a host that keeps a persistent Node process running with WebSocket support.
Netlify alone won't work for the server half. Good options: Render, Railway, or Fly.io
(all have free/cheap tiers and support Node + WebSockets directly). Deploy this whole
folder as-is; `npm start` is the start command, and it reads `PORT` from the environment
already, which those platforms set automatically.

## Reconnecting and remembering your name/avatar

Your name and avatar customization are now saved in your browser and restored
automatically the next time you open the app, even after leaving a room and coming
back. Each browser also gets a persistent identity, so if your connection drops for
a bit (locking your phone, a spotty signal, backgrounding the app to answer a text),
you get a 45 second grace window to reconnect and silently reclaim your seat instead
of the room treating you as a stranger. Other players will briefly see
"(reconnecting...)" next to your name during that window. If you don't reconnect in
time, you're removed from the room like normal and everyone is notified you left.

## Known gaps / next steps

- Locations category isn't wired up yet (no data source).
- Spectators don't get the same reconnect grace period as players (a dropped spectator
  just needs to rejoin via the room code and hit Watch again). Since spectators don't
  hold any hidden game state, this was left out of scope for the reconnect work above.
- Avatar layer contents (skin/face/hat) match exactly what you uploaded; if you add more
  sprite variants later, just drop them in `client/assets/avatar/<layer>/` following the
  `<layer>_N.png` naming pattern and bump the count in `LAYER_COUNTS` in `client/app.js`.
