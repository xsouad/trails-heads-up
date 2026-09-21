// ---------- Gameshow (WIP) ----------
// Slice 1: a standalone "That Won't Be Necessary" speed-round test harness.
// Slice 2: the multiplayer lobby -- join, pick a position (Host / Team A /
// Team B / Spectator with a seat) on a "stage" (screen up top, podiums and
// theater seats below, matching the sketch), and the Team A vs Team B
// naming minigame.
// Still not built: the actual board (quotes/trivia/screenshots columns),
// hints, steal, and hooking the speed round in as the real comeback trigger.

document.body.style.background = '#ffcc00';

const socket = io();

const STORAGE_KEY = 'trailsGameshow_clientId';
function getClientId() {
  let id = sessionStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = 'gs_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
const clientId = getClientId();

// `avatar`, `saveAvatar`, `loadAvatar`, `effectiveLayerCount`, and
// `renderAvatarStage` all come from avatar-shared.js -- the exact same
// layered base/face/hat system Heads Up and Guess Who use, so a player's
// avatar carries over between games instead of Gameshow inventing its own.

// Character list, shared with Heads Up/Guess Who -- same file, same image
// folder convention (assets/items/characters/<image>).
let GS_CHARACTERS = [];
async function loadGsCharacters() {
  const res = await fetch('data/characters.json');
  const data = await res.json();
  GS_CHARACTERS = data.map(c => ({ name: c.name, img: c.image }));
}
function gsImgUrl(c) { return 'assets/items/characters/' + encodeURIComponent(c.img); }

function gsShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let state = {
  screen: 'landing', // landing, avatarSetup, stage (lobby/naming/ready all live on the stage), speedIntro, speedPlaying, speedResults
  myName: '',
  joinCodeInput: '',
  error: '',
  room: null, // last gsRoomState payload from the server
  avatarConfirmed: false,
  showHostModal: false,
  hostAuthError: '',
  showHowToPlay: false,
  speed: null, // set by startSpeedRound() -- the standalone test harness
  comebackMode: false, // true while playing the speed round AS the in-game comeback trigger
  screenNotices: [], // { id, text } -- rendered on the TV screen (or the floating bar pre-game)
  pendingRooms: [], // Pending Games list on the landing screen
  clapMuted: false,
  clapVolume: 0.6,
  zoomImageSrc: null, // set to open the screenshot lightbox
  leaderboard: [] // global speed-round leaderboard, shared by every visitor
};

// ---------- clap volume / mute (persisted across visits) ----------
const GS_CLAP_PREF_KEY = 'trailsGameshow_clapPrefs';
(function loadClapPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(GS_CLAP_PREF_KEY));
    if (p && typeof p === 'object') {
      if (typeof p.muted === 'boolean') state.clapMuted = p.muted;
      if (typeof p.volume === 'number') state.clapVolume = p.volume;
    }
  } catch (e) { /* ignore */ }
})();
function saveClapPrefs() {
  try { localStorage.setItem(GS_CLAP_PREF_KEY, JSON.stringify({ muted: state.clapMuted, volume: state.clapVolume })); } catch (e) { /* ignore */ }
}

// ---------- speed round leaderboard (global, shared server-side) ----------
// Used to be per-browser (localStorage) -- now the server keeps one shared
// list and broadcasts it to everyone whenever a new score is saved, so
// every visitor sees the same leaderboard instead of only their own runs.
function refreshGsLeaderboard() {
  socket.emit('gsGetLeaderboard', null, (entries) => {
    state.leaderboard = entries || [];
    if (state.screen === 'speedIntro' || state.screen === 'speedResults') render();
  });
}
socket.on('gsLeaderboardUpdate', (entries) => {
  state.leaderboard = entries || [];
  if (state.screen === 'speedIntro' || state.screen === 'speedResults') render();
});

const gsRoot = document.getElementById('gsRoot');

// Notices (hint-taken, etc.) render ON the TV screen when there is one
// (lobby/naming/ready/playing all have a screen); before that (landing,
// Build Your Character) there's nowhere on-screen to put them, so they fall
// back to the small floating bar.
let gsNoticeSeq = 0;
function showGsNotice(text) {
  const id = ++gsNoticeSeq;
  state.screenNotices.push({ id, text });
  renderScreenNotices();
  setTimeout(() => {
    state.screenNotices = state.screenNotices.filter(n => n.id !== id);
    renderScreenNotices();
  }, 4500);
}
function renderScreenNotices() {
  const onScreen = document.getElementById('gsScreenNotices');
  const target = onScreen || document.getElementById('gsNoticeBar');
  if (!target) return;
  target.innerHTML = state.screenNotices.map(n => `<div class="notice-toast ${onScreen ? 'gs-onscreen-notice' : ''}">${n.text}</div>`).join('');
}

socket.on('gsNotice', ({ text }) => showGsNotice(text));

// Throttle live-typing emissions so we don't flood the socket on every
// keystroke -- fires at most once per 150ms, cosmetic mirroring only.
function throttleTyping(fn, ms = 150) {
  let last = 0, pending = null;
  return () => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(); }
    else {
      clearTimeout(pending);
      pending = setTimeout(() => { last = Date.now(); fn(); }, ms - (now - last));
    }
  };
}

// Host-only read-only peek at an unopened cell, shown as a small overlay
// so the host can decide whether it needs rerolling before opening it.
function showGsCellPreview(content, column) {
  const host = document.querySelector('.gs-tv-screen') || document.getElementById('gsRoot');
  const existing = document.getElementById('gsCellPreviewOverlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'gsCellPreviewOverlay';
  overlay.className = 'gs-preview-overlay';
  let inner = '';
  if (column === 'screenshots') {
    inner = `<img src="${content.answer || content.hint}" class="gs-preview-img" alt="Screenshot" />`;
  } else if (column === 'quotes') {
    inner = `<div class="gs-preview-text">"${content.text}"</div>`;
  } else if (column === 'trivia') {
    inner = `<div class="gs-preview-text">${content.question}</div><div class="gs-preview-answer">${content.answer}</div>`;
  } else {
    inner = `<div class="gs-preview-text">${content.text || content.question || ''}</div>`;
  }
  overlay.innerHTML = `<div class="gs-preview-box">${inner}<button type="button" class="secondary gs-tiny-btn" id="gsClosePreviewBtn">Close</button></div>`;
  (host || document.body).appendChild(overlay);
  const closeBtn = document.getElementById('gsClosePreviewBtn');
  if (closeBtn) closeBtn.addEventListener('click', () => overlay.remove());
}

// Self-service Phone a Friend: a competitor clicking their own team's
// unused phone icon gets a quick "who do you want to call" picker instead
// of having to ask the host to do it for them. Same overlay mechanics as
// the cell preview above.
function showGsPhonePicker(team) {
  const room = state.room;
  if (!room) return;
  const spectators = room.players.filter(p => p.role === 'spectator');
  const existing = document.getElementById('gsPhonePickerOverlay');
  if (existing) existing.remove();
  if (!spectators.length) { showGsNotice('No one in the audience to call yet.'); return; }
  const host = document.querySelector('.gs-tv-screen') || document.getElementById('gsRoot');
  const overlay = document.createElement('div');
  overlay.id = 'gsPhonePickerOverlay';
  overlay.className = 'gs-preview-overlay';
  overlay.innerHTML = `
    <div class="gs-preview-box">
      <p class="gs-preview-text" style="margin-bottom:10px;">Who do you want to call?</p>
      <div class="gs-phone-picker-list">
        ${spectators.map(s => `<button type="button" class="secondary gs-small-btn" data-phone-pick="${s.id}">${s.name}</button>`).join('')}
      </div>
      <button type="button" class="secondary gs-tiny-btn" id="gsClosePhonePickerBtn" style="margin-top:10px;">Cancel</button>
    </div>
  `;
  (host || document.body).appendChild(overlay);
  overlay.querySelectorAll('[data-phone-pick]').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('gsUsePhoneAFriend', { team, spectatorId: btn.dataset.phonePick }, (res) => {
        if (!res || !res.ok) showGsNotice((res && res.error) || "Couldn't place the call.");
      });
      overlay.remove();
    });
  });
  const closeBtn = document.getElementById('gsClosePhonePickerBtn');
  if (closeBtn) closeBtn.addEventListener('click', () => overlay.remove());
}
socket.on('gsClap', ({ name }) => { playClap(); });
socket.on('connect', () => { if (!state.room) refreshGsPendingRooms(); });
socket.on('gsRoomState', (room) => {
  state.room = room;
  // Avatar customization happens AFTER you're in a room, not before --
  // first time we land here this session, detour through the builder.
  if (state.screen === 'landing') {
    state.screen = state.avatarConfirmed ? 'stage' : 'avatarSetup';
  }
  // "That Won't Be Necessary" comeback trigger: if the host just picked ME
  // to attempt it, drop straight into the existing speed-round mechanic --
  // reusing the standalone minigame instead of rebuilding it.
  if (room.board && room.board.comeback && room.board.comeback.stage === 'active' && room.board.comeback.playerId === socket.id && !state.comebackMode) {
    state.comebackMode = true;
    startSpeedRound();
    return;
  }
  // While the attempting player is mid-comeback-round, that screen is
  // owned entirely by the local speed-round harness (its own timer,
  // its own DOM updates on every keystroke/guess) -- it never needs a
  // fresh render from room state. Their own throttled gsComebackTyping/
  // gsComebackLive emits were causing a gsRoomState broadcast to bounce
  // straight back at them roughly every 150ms, which rebuilt the whole
  // screen (render() replaces gsRoot.innerHTML) and wiped out the
  // autocomplete suggestions list and any in-flight dropdown selection
  // out from under them every time -- that's the "dropdown glitching,
  // can't press Enter to pick a name" bug. Skipping the render entirely
  // here removes the cause instead of patching around the symptom.
  if (state.comebackMode) return;
  render();
});

window.addEventListener('pagehide', () => {
  if (state.room && socket.connected) socket.emit('gsLeaveRoom');
});

// ---------- tiny synthesized sound effects (no audio files needed) ----------
let audioCtx = null;
function gsBeep({ freq, duration, type = 'sine', endFreq = null, volume = 0.18 }) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, audioCtx.currentTime + duration);
    gain.gain.setValueAtTime(volume, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + duration);
  } catch (e) { /* audio not available -- silently skip, never block gameplay on this */ }
}
function playTing() { gsBeep({ freq: 880, endFreq: 1320, duration: 0.18, type: 'sine', volume: 0.2 }); }
function playError() { gsBeep({ freq: 220, endFreq: 110, duration: 0.28, type: 'sawtooth', volume: 0.14 }); }

// A "clap" isn't a nice sine tone -- it's a short burst of filtered noise.
// Layer a handful of these with tiny random offsets to sound like a little
// crowd clapping rather than one single slap.
function playClap() {
  if (state.clapMuted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const claps = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < claps; i++) {
      const delay = i * (0.03 + Math.random() * 0.03);
      const bufSize = audioCtx.sampleRate * 0.06;
      const buffer = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let j = 0; j < bufSize; j++) data[j] = (Math.random() * 2 - 1) * (1 - j / bufSize);
      const noise = audioCtx.createBufferSource();
      noise.buffer = buffer;
      const filter = audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1500 + Math.random() * 800;
      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(state.clapVolume * 0.5, audioCtx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + 0.08);
      noise.connect(filter); filter.connect(gain); gain.connect(audioCtx.destination);
      noise.start(audioCtx.currentTime + delay);
    }
  } catch (e) { /* audio not available -- silently skip */ }
}

// ---------- render ----------
// render() rebuilds the ENTIRE screen from a string template on every call
// (every socket broadcast, every timer tick, every other player's action --
// not just your own). That's fine for static content, but it destroys and
// recreates every <input> from scratch each time, wiping out whatever the
// person was mid-typing into it and stealing focus -- with live-typing now
// broadcasting on every keystroke, that could fire many times a second and
// made every input field in the app effectively unusable. Save/restore the
// focused input's identity, value and cursor position across the rebuild so
// typing is never interrupted by a re-render that has nothing to do with
// what you're typing.
function captureFocusedInput() {
  const el = document.activeElement;
  if (!el || !gsRoot.contains(el)) return null;
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return null;
  if (!el.id) return null;
  return { id: el.id, value: el.value, selectionStart: el.selectionStart, selectionEnd: el.selectionEnd };
}
function restoreFocusedInput(saved) {
  if (!saved) return;
  const el = document.getElementById(saved.id);
  if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return;
  el.value = saved.value;
  el.focus();
  try { el.setSelectionRange(saved.selectionStart, saved.selectionEnd); } catch (e) { /* ignore */ }
}

function render() {
  const focused = captureFocusedInput();
  let html = '';
  if (state.screen === 'landing') html = renderLanding();
  else if (state.screen === 'avatarSetup') html = renderAvatarSetup();
  else if (state.screen === 'stage') html = renderStage();
  else if (state.screen === 'speedIntro') html = renderSpeedIntro();
  else if (state.screen === 'speedPlaying') html = renderSpeedPlaying();
  else if (state.screen === 'speedResults') html = renderSpeedResults();
  gsRoot.innerHTML = html;
  // Avatars are rendered as real layered images (not string HTML) -- fill
  // in every placeholder left behind by the string templates above.
  document.querySelectorAll('[data-avatar-for]').forEach(el => {
    const p = state.room && state.room.players.find(pl => pl.id === el.dataset.avatarFor);
    if (p) renderAvatarStage(el, p.avatar);
  });
  const stage = document.getElementById('avatarStage');
  if (stage) renderAvatarStage(stage, avatar);
  renderScreenNotices();
  attachHandlers();
  restoreFocusedInput(focused);
}

function myPlayer() {
  if (!state.room) return null;
  return state.room.players.find(p => p.id === socket.id) || null;
}

// ---------- landing ----------
function renderLanding() {
  return `
    <a href="#" id="gsHowToPlayBtn" class="how-to-play-link gs-landing-htp">How to Play</a>

    <div class="card center">
      <h2 class="gs-gate-title">Gameshow</h2>

      <div class="error-msg">${state.error}</div>

      <button type="button" class="primary" id="gsCreateRoomBtn">Create Room</button>

      <div class="join-row gs-join-row">
        <input type="text" id="gsJoinCodeInput" placeholder="Room code" maxlength="4" value="${state.joinCodeInput}" autocomplete="off" />
        <button type="button" class="secondary" id="gsJoinRoomBtn">Join Room</button>
      </div>
    </div>

    <div class="card gs-pending-card">
      <div class="gs-pending-header">
        <p class="gs-section-title">Pending Games</p>
        <button type="button" class="secondary gs-tiny-btn" id="gsRefreshPendingBtn">Refresh</button>
      </div>
      ${renderPendingRooms()}
    </div>

    <div class="card center gs-dev-card">
      <!-- DEV TEST BUTTON -- remove once the real board is playable. Just a
           standalone way to try the speed-round minigame with no room. -->
      <p class="hint">Dev-only, temporary:</p>
      <button type="button" class="secondary" id="gsDevTestBtn">🧪 Test: Speed Round</button>
    </div>

    ${renderHowToPlayModal()}
  `;
}

function renderPendingRooms() {
  if (!state.pendingRooms.length) return '<p class="hint">No games waiting.</p>';
  return `
    <div class="public-room-list gs-pending-list">
      ${state.pendingRooms.map(r => `
        <div class="public-room-row">
          <span>${r.hostName}'s room</span>
          <button type="button" class="secondary gs-tiny-btn" data-join-pending="${r.code}">Join</button>
        </div>
      `).join('')}
    </div>
  `;
}

function refreshGsPendingRooms() {
  socket.emit('gsListPendingRooms', null, (list) => {
    state.pendingRooms = list || [];
    if (state.screen === 'landing') render();
  });
}

function renderHowToPlayModal() {
  return `
    <div class="zoom-overlay ${state.showHowToPlay ? 'active' : ''}" id="gsHowToPlayModal">
      <div class="zoom-card" style="max-width:420px; text-align:left;">
        <h3 style="margin-top:0; text-align:center;">Gameshow (WIP)</h3>
        <p>Create or join a room, then build your avatar. Pick Host (needs the code), Team A, Team B, or a spectator seat.</p>
        <p>Once both teams have people in and everyone's hit Ready, the host starts a quick minigame where each team names itself and votes on the winner.</p>
        <p>The actual quiz board (quotes, trivia, screenshots) is still being built. This is just the lobby so far.</p>
        <button type="button" class="close-btn" id="gsCloseHowToPlayBtn" style="margin-top:10px; display:block; margin-left:auto; margin-right:auto;">Close</button>
      </div>
    </div>
  `;
}

// ---------- avatar setup (shown once, right after joining/creating a room) ----------
// Name and avatar are both picked here, right after the room exists --
// not on the landing screen.
function renderAvatarSetup() {
  return `
    <div class="card center">
      <h2 class="gs-gate-title">Build Your Character</h2>

      <div class="avatar-builder">
        <div class="avatar-stage" id="avatarStage"></div>
        <div class="arrow-row">
          <button type="button" data-layer="hat" data-dir="-1">&lt;</button>
          <span class="layer-label">Accessories</span>
          <button type="button" data-layer="hat" data-dir="1">&gt;</button>
        </div>
        <div class="arrow-row">
          <button type="button" data-layer="face" data-dir="-1">&lt;</button>
          <span class="layer-label">Face</span>
          <button type="button" data-layer="face" data-dir="1">&gt;</button>
        </div>
        <div class="arrow-row">
          <button type="button" data-layer="base" data-dir="-1">&lt;</button>
          <span class="layer-label">Color</span>
          <button type="button" data-layer="base" data-dir="1">&gt;</button>
        </div>
        <button type="button" class="dice-btn" id="diceBtn">Randomize</button>
      </div>

      <div class="gs-name-continue-stack">
        <input type="text" id="gsAvatarNameInput" class="gs-password-input gs-name-input-full" placeholder="Your name" maxlength="24" value="${state.myName.replace(/"/g, '&quot;')}" autocomplete="off" />
        <button type="button" class="primary gs-continue-btn" id="gsConfirmAvatarBtn">Continue</button>
      </div>

      <div class="error-msg">${state.error}</div>
    </div>
  `;
}

// ---------- stage (persistent screen + podiums + spectator seats) ----------

// Empty and occupied podiums render the EXACT SAME set of elements (avatar
// zone, block, name zone) at the same fixed sizes -- only their content
// differs. That's what stops the "picking a podium makes everything jump"
// bug: since every podium is always the same height whether it's taken or
// not, the row's height (and everything's vertical position) never
// changes when someone joins.
function renderPodium(teamKey) {
  const room = state.room;
  const me = myPlayer();
  const members = {};
  room.players.forEach(p => { if (p.role === teamKey && p.slot != null) members[p.slot] = p; });
  const board = room.board;
  // Persistent-for-the-game podium markers: a lightbulb once this team has
  // used ANY hint, a caution triangle once they've pulled off ANY steal --
  // shown once, on whichever slot is occupied first, not repeated per
  // player.
  const hintUsed = !!(board && board.hints && board.hints[teamKey] < STARTING_HINTS_CLIENT);
  const stealUsed = !!(board && board.stealUsedBy && board.stealUsedBy[teamKey]);
  const firstOccupiedSlot = [0, 1, 2].find(i => members[i]);
  const slots = [0, 1, 2].map(slotIdx => {
    const occ = members[slotIdx];
    const mine = occ && me && occ.id === me.id;
    const isEmpty = !occ;
    const tag = isEmpty ? 'button' : 'div';
    const attrs = isEmpty ? `type="button" data-join-team="${teamKey}" data-join-slot="${slotIdx}"` : '';
    // The green "ready" tint is a lobby-only signal -- a player's `ready`
    // flag itself is never cleared server-side once set, so without gating
    // this on phase === 'lobby' the podium block stayed green forever
    // after the game actually started instead of reverting to the team's
    // own blue/red.
    const showReady = room.phase === 'lobby' && occ && occ.ready;
    const showMarkers = occ && slotIdx === firstOccupiedSlot && (hintUsed || stealUsed);
    return `
      <${tag} class="gs-podium ${isEmpty ? 'empty' : 'occupied'} ${mine ? 'mine' : ''} ${showReady ? 'is-ready' : ''}" ${attrs}>
        <div class="gs-podium-avatar-wrap">
          ${occ ? `<div class="gs-podium-avatar" data-avatar-for="${occ.id}"></div>` : '<span class="gs-podium-plus">+</span>'}
          ${showMarkers ? `<span class="gs-podium-markers">${hintUsed ? '<span class="gs-podium-marker" title="This team has used a hint">💡</span>' : ''}${stealUsed ? '<span class="gs-podium-marker" title="This team has stolen a question">⚠️</span>' : ''}</span>` : ''}
        </div>
        <div class="gs-podium-block ${teamKey}"></div>
        <div class="gs-podium-name">${occ ? occ.name : ' '}</div>
      </${tag}>
    `;
  });
  return `<div class="gs-team-column ${teamKey}">${slots.join('')}</div>`;
}

// Once Phone a Friend is used, the called spectator's avatar moves to stand
// next to the host -- a little visual "they're on the phone with the host"
// touch instead of just a text label.
function calledPhoneFriend(room) {
  if (!room.board || !room.board.phoneAFriend) return null;
  for (const team of ['teamA', 'teamB']) {
    const pf = room.board.phoneAFriend[team];
    if (pf && pf.used && pf.spectatorId) return pf;
  }
  return null;
}

function renderHostSlot() {
  const room = state.room;
  const me = myPlayer();
  const host = room.players.find(p => p.role === 'host');
  const mine = host && me && host.id === me.id;
  const calledFriend = calledPhoneFriend(room);
  return `
    <div class="gs-host-slot ${host ? 'occupied' : 'empty'} ${mine ? 'mine' : ''}">
      <div class="gs-podium-avatar-wrap">
        ${host ? `<div class="gs-podium-avatar" data-avatar-for="${host.id}"></div>` : ''}
        ${calledFriend ? `
          <div class="gs-phone-friend-avatar" title="${calledFriend.spectatorName}: Phone a Friend">
            <div class="gs-podium-avatar small" data-avatar-for="${calledFriend.spectatorId}"></div>
            <span class="gs-phone-friend-icon">📞</span>
          </div>
        ` : ''}
      </div>
      <div class="gs-host-label">GAMESHOW HOST</div>
      <div class="gs-host-action">
        ${host
          ? `<div class="gs-podium-name">${host.name}</div>`
          : `<button type="button" class="secondary gs-small-btn" id="gsOpenHostBoxBtn">Become Host</button>`}
      </div>
    </div>
  `;
}

// A modal (not inline in the floor) so opening it never reflows/squashes
// the team columns next to the host slot -- that was the "typing the host
// code breaks the whole layout" bug.
function renderHostModal() {
  return `
    <div class="zoom-overlay ${state.showHostModal ? 'active' : ''}" id="gsHostModal">
      <div class="zoom-card">
        <h3 style="margin-top:0;">Gameshow Host</h3>
        <input type="password" id="gsHostPasswordInput" class="gs-password-input" placeholder="Host code" autocomplete="off" />
        <div class="error-msg">${state.hostAuthError}</div>
        <button type="button" class="primary" id="gsBecomeHostBtn">Enter</button>
        <button type="button" class="close-btn" id="gsCancelHostBtn">Cancel</button>
      </div>
    </div>
  `;
}

function renderSeat(seat) {
  const room = state.room;
  const me = myPlayer();
  const occ = room.players.find(p => p.role === 'spectator' && p.seat === seat);
  if (occ) {
    const mine = me && occ.id === me.id;
    return `
      <div class="gs-seat occupied ${mine ? 'mine' : ''}">
        <div class="gs-seat-avatar" data-avatar-for="${occ.id}"></div>
        <span class="gs-seat-name">${occ.name}</span>
      </div>
    `;
  }
  return `
    <button type="button" class="gs-seat empty" data-seat="${seat}">
      <span class="gs-seat-num">${seat}</span>
    </button>
  `;
}

function clapVolIcon() {
  if (state.clapMuted || state.clapVolume <= 0) return '🔇';
  if (state.clapVolume < 0.5) return '🔈';
  if (state.clapVolume < 0.9) return '🔉';
  return '🔊';
}

function renderClapArea() {
  const room = state.room;
  const me = myPlayer();
  if (!me || me.role !== 'spectator') return '';
  // Clapping only makes sense once there's an actual game to react to --
  // not while everyone's still picking seats or naming their teams. Hidden
  // entirely (not just grayed out) until then.
  const allowed = room.phase !== 'lobby' && room.phase !== 'naming';
  if (!allowed) return '';
  return `
    <div class="center gs-clap-area">
      <button type="button" class="primary" id="gsClapBtn">👏 Clap</button>
      <button type="button" class="secondary gs-tiny-btn" id="gsClapVolBtn" title="Clap volume: click to cycle">${clapVolIcon()}</button>
    </div>
  `;
}

function renderScreenLobby() {
  const room = state.room;
  const competitors = room.players.filter(p => p.role === 'teamA' || p.role === 'teamB');
  const readyCount = competitors.filter(p => p.ready).length;
  let statusLine;
  if (!competitors.length) statusLine = 'Waiting for players to join a team.';
  else if (readyCount < competitors.length) statusLine = `${readyCount}/${competitors.length} competitors ready.`;
  else statusLine = 'Everyone is ready. Waiting on the host.';
  return `
    <div class="gs-screen-roomcode">${room.code}</div>
    <p class="gs-screen-sub">Share this code with everyone joining. Pick your spot below.</p>
    <p class="gs-screen-status">${statusLine}</p>
  `;
}

function everyoneVotedClient(room, team) {
  const t = room[team];
  if (!t.candidates.length) return false;
  const members = room.players.filter(p => p.role === team);
  return members.every(p => Object.prototype.hasOwnProperty.call(t.votes, p.id));
}

function everyoneSubmittedClient(room, team) {
  const t = room[team];
  const members = room.players.filter(p => p.role === team);
  if (!members.length) return false;
  return members.every(p => t.candidates.some(c => c.by === p.id));
}

// Sequential naming, one team at a time -- Team A does its whole
// submit-then-vote cycle before Team B even starts. Two screens only, and
// each one shows NOTHING beyond what's described below (no boxes, no
// mixed submit+vote view):
//
// Screen 1 (submit): title, team label, one input. Nothing else -- Enter
// submits, there's no separate button.
// Screen 2 (vote): "Vote for your favorite" + every submitted name as a
// stacked pill. Clicking your pick turns it green; everyone not on this
// team (spectators, the other team, host) watches the same pill list
// read-only, so they can see what got submitted.
const NAMING_ANNOUNCE_MS = 2200;

function renderNameSubmitScreen(team, label) {
  return `
    <h3 class="gs-screen-title">Recommend a name for your Team</h3>
    <p class="gs-section-title" style="text-align:center;">${label}</p>
    <input type="text" id="gsNameInput_${team}" class="gs-name-solo-input" placeholder="Suggest a team name" maxlength="30" autocomplete="off" />
  `;
}

function renderNameVoteScreen(team, label, interactive) {
  const room = state.room;
  const t = room[team];
  const me = myPlayer();
  const myVote = me ? t.votes[me.id] : undefined;
  return `
    <h3 class="gs-screen-title">Vote for your favorite</h3>
    <div class="gs-candidate-list">
      ${t.candidates.map((c, idx) => `
        <button type="button" class="secondary gs-vote-btn gs-vote-pill ${myVote === idx ? 'voted' : ''}" ${interactive ? `data-team="${team}" data-idx="${idx}"` : 'disabled'}>${c.text}</button>
      `).join('')}
    </div>
  `;
}

function renderScreenNaming() {
  const room = state.room;
  const me = myPlayer();
  const iAmHost = room.hostId === socket.id;

  const announce = room.namingAnnounce;
  if (announce && Date.now() - announce.at < NAMING_ANNOUNCE_MS) {
    const label = announce.team === 'teamA' ? 'Team A' : 'Team B';
    return `
      <div class="gs-takeover">
        <div class="gs-takeover-box good">
          <p class="gs-takeover-text">${label} is now ${announce.name}!</p>
        </div>
      </div>
    `;
  }

  const team = room.namingTeam;
  if (!team) return `<p class="hint center-text">Locking in names...</p>`;
  const label = team === 'teamA' ? 'Team A' : 'Team B';
  const onThisTeam = me && me.role === team;
  const iSubmitted = onThisTeam && room[team].candidates.some(c => c.by === me.id);

  // "Nothing else" applies to the submit screen and the spectator takeover
  // (screenshots 42/44) -- the host's lock-in control only ever appears
  // alongside the vote screen, never on top of those two.
  if (onThisTeam && !iSubmitted) {
    return renderNameSubmitScreen(team, label);
  }
  if (!onThisTeam && !everyoneSubmittedClient(room, team)) {
    return `
      <div class="gs-takeover">
        <div class="gs-takeover-box">
          <p class="gs-takeover-text">${label} is coming up with a name!</p>
        </div>
      </div>
    `;
  }

  const readyToLock = everyoneVotedClient(room, team);
  const lockBtn = iAmHost ? `
    <div class="center" style="margin-top:14px;">
      <button type="button" class="primary gs-small-btn" id="gsFinishNamingBtn" ${readyToLock ? '' : 'disabled'}>Lock In ${label}'s Name</button>
    </div>
  ` : '';

  return `${renderNameVoteScreen(team, label, onThisTeam)}${lockBtn}`;
}

function renderTeamReadyRow(team) {
  const room = state.room;
  const members = room.players.filter(p => p.role === team);
  return `
    <div class="gs-ready-team">
      <p class="gs-ready-label">${team === 'teamA' ? 'TEAM A' : 'TEAM B'} is called: <strong>${room[team].name || (team === 'teamA' ? 'Team A' : 'Team B')}</strong></p>
      <div class="gs-avatar-row">
        ${members.map(p => `
          <div class="gs-mini-avatar-wrap">
            <div class="gs-mini-avatar" data-avatar-for="${p.id}"></div>
            <span>${p.name}</span>
          </div>
        `).join('') || '<p class="hint">No members.</p>'}
      </div>
    </div>
  `;
}

function renderScreenReady() {
  const room = state.room;
  const iAmHost = room.hostId === socket.id;
  return `
    ${renderTeamReadyRow('teamA')}
    ${renderTeamReadyRow('teamB')}
    ${iAmHost ? `
      <div class="center" style="margin-top:10px;">
        <button type="button" class="primary" id="gsStartGameBtn">Start Game</button>
      </div>
    ` : `<p class="gs-screen-status">Teams are locked in. Waiting for the host to start the game.</p>`}
  `;
}

// ---------- the actual quiz board (quotes / trivia / screenshots) ----------
const COLUMN_LABELS = { quotes: 'Quotes', trivia: 'Trivia', screenshots: 'Screenshots' };
const STARTING_HINTS_CLIENT = 3; // mirrors gameshowBoard.js's STARTING_HINTS
const STEAL_ANNOUNCE_MS = 5000; // full-screen "TEAM X is stealing" takeover duration

function teamLabel(team) {
  const room = state.room;
  if (!room) return team;
  return room[team] && room[team].name ? room[team].name : (team === 'teamA' ? 'Team A' : 'Team B');
}

function otherTeam(team) { return team === 'teamA' ? 'teamB' : 'teamA'; }

// Hints and Phone a Friend show as discrete icon boxes -- lit while
// available, grayed out/crossed once used -- instead of a single "count"
// number, matching the reference board layout.
// A competitor can now take their OWN team's hint directly (clicking a
// still-lit bulb), not just wait on the host to give it -- matches the
// same self-service pattern the STEAL button already used.
function renderHintStack(team) {
  const room = state.room;
  const me = myPlayer();
  const canSelfServe = me && me.role === team;
  const hintsLeft = room.board.hints[team];
  const hintIcons = Array.from({ length: STARTING_HINTS_CLIENT }, (_, i) => {
    const lit = i < hintsLeft;
    const clickable = lit && canSelfServe && i === hintsLeft - 1; // only the next one to spend is clickable
    return `<span class="gs-icon-box ${team} ${lit ? 'lit' : 'spent'} ${clickable ? 'clickable' : ''}" ${clickable ? `data-take-hint="${team}"` : ''} title="${lit ? (clickable ? 'Click to take this hint' : 'Hint available') : 'Hint used'}">💡</span>`;
  }).join('');
  return `<div class="gs-icon-stack">${hintIcons}</div>`;
}

// Phone a Friend is its own separate button, not grouped with the hints.
// Same self-service idea -- a competitor can click their own unused phone
// icon to place the call themselves instead of waiting on the host.
function renderPhoneButton(team) {
  const room = state.room;
  const me = myPlayer();
  const canSelfServe = me && me.role === team;
  const pf = room.board.phoneAFriend[team];
  const clickable = !pf.used && canSelfServe;
  return `<span class="gs-icon-box gs-phone-icon ${team} ${pf.used ? 'spent' : 'lit'} ${clickable ? 'clickable' : ''}" ${clickable ? `data-take-phone="${team}"` : ''} title="${pf.used ? `Phone a Friend used (${pf.spectatorName})` : (clickable ? 'Click to call a spectator' : 'Phone a Friend available')}">📞</span>`;
}

function renderScoreboard() {
  const room = state.room;
  const iAmHost = room.hostId === socket.id;
  // Reference order, outer-to-inner: Phone, Hints, Box -- phone is the
  // outermost icon on each side, hints sit between it and the box.
  const block = (team, alignEnd) => `
    <div class="gs-score-row ${alignEnd ? 'reversed' : ''}">
      ${!alignEnd ? renderPhoneButton(team) : ''}
      ${!alignEnd ? renderHintStack(team) : ''}
      <div class="gs-score-block ${team}">
        <span class="gs-score-label">${teamLabel(team)}</span>
        <span class="gs-score-value">${room.board.scores[team]}</span>
        ${iAmHost ? `<button type="button" class="gs-hint-mini-btn" data-hint-team="${team}" ${room.board.hints[team] <= 0 ? 'disabled' : ''} title="Give ${teamLabel(team)} a hint">+Hint</button>` : ''}
      </div>
      ${alignEnd ? renderHintStack(team) : ''}
      ${alignEnd ? renderPhoneButton(team) : ''}
    </div>
  `;
  return `<div class="gs-scoreboard">${block('teamA', false)}${block('teamB', true)}</div>`;
}

function renderPhoneRow(iAmHost) {
  const room = state.room;
  const spectators = room.players.filter(p => p.role === 'spectator');
  const teamsToShow = ['teamA', 'teamB'].filter(team => {
    const pf = room.board.phoneAFriend[team];
    return pf.used || spectators.length > 0;
  });
  if (!teamsToShow.length) return ''; // nobody in the audience and nothing used -- nothing to show
  return `
    <div class="gs-hint-row">
      ${teamsToShow.map(team => {
        const pf = room.board.phoneAFriend[team];
        return `
          <div class="gs-hint-block">
            <span class="gs-hint-team">${teamLabel(team)}</span>
            <span class="gs-phone-status">${pf.used ? `📞 used (${pf.spectatorName})` : '📞 available'}</span>
            ${iAmHost && !pf.used ? `
              <select class="gs-phone-select" data-phone-team="${team}">
                <option value="">Pick spectator...</option>
                ${spectators.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
              </select>
              <button type="button" class="secondary gs-small-btn" data-phone-go="${team}">Use</button>
            ` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderBoardGrid(iAmHost) {
  const room = state.room;
  const rows = [0, 1, 2, 3, 4];
  const cols = ['quotes', 'trivia', 'screenshots'];
  const canAct = iAmHost && !room.board.active && room.phase === 'playing';
  return `
    ${iAmHost ? `<p class="gs-status-line" style="margin-bottom:8px;">Up next: <strong>${teamLabel(room.board.turnTeam)}</strong></p>` : ''}
    <table class="gs-board-grid">
      <thead><tr>${cols.map(c => `<th>${COLUMN_LABELS[c]}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows.map(row => `
          <tr>
            ${cols.map(col => {
              const cell = room.board.cells.find(c => c.column === col && c.row === row);
              if (!cell) return '<td></td>';
              if (cell.used) return `<td class="gs-cell used">&nbsp;</td>`;
              return `<td class="gs-cell ${canAct ? 'clickable' : ''}">
                <span class="gs-cell-value-btn" ${canAct ? `data-open-cell="${cell.id}"` : ''}>$${cell.value}</span>
                ${canAct ? `<button type="button" class="gs-reroll-btn" data-preview-cell="${cell.id}" title="Peek at this question">👁</button>` : ''}
                ${canAct ? `<button type="button" class="gs-reroll-btn" data-reroll-cell="${cell.id}" title="Swap this question for another">🔀</button>` : ''}
              </td>`;
            }).join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${canAct ? `
      <div class="center gs-board-host-controls">
        <select id="gsBonusTeamSelect">
          <option value="teamA">${teamLabel('teamA')}</option>
          <option value="teamB">${teamLabel('teamB')}</option>
        </select>
        <button type="button" class="secondary gs-small-btn" id="gsTriggerBonusBtn" ${room.board.bonusRemaining > 0 ? '' : 'disabled'}>Bonus Question ($500${room.board.bonusRemaining ? `, ${room.board.bonusRemaining} left` : ''})</button>
      </div>
    ` : ''}
  `;
}

// One compact bottom bar: timer on the left, team name on the right. This
// is the ONLY place the turn team's name appears on this panel now (it
// used to repeat 3x between a banner, a section title, and a waiting
// line) -- the countdown is visible to EVERYONE watching, including
// spectators, so the whole room can see how long is left before steal
// opens up.
function renderStatusBar(active) {
  const secs = active.stage === 'answering' ? Math.max(0, Math.ceil((active.deadline - Date.now()) / 1000)) + 's' : '--';
  return `
    <div class="gs-status-bar">
      <span class="gs-timer-box" id="gsTurnTimer">${secs}</span>
      <span class="gs-team-box">${teamLabel(active.turnTeam)}</span>
    </div>
  `;
}

// A short one-line status for the audience (spectators) -- no boxes, no
// controls, just what's happening right now.
function spectatorStatusLine(active) {
  if (active.stage === 'answering') return `${teamLabel(active.turnTeam)} is answering...`;
  if (active.stealTeam) {
    if (active.stealJudged) return active.stealJudged === 'correct' ? `${teamLabel(active.stealTeam)} stole it!` : `${teamLabel(active.stealTeam)} missed the steal.`;
    return `${teamLabel(active.stealTeam)} is attempting a steal...`;
  }
  if (active.turnJudged === 'correct') return `${teamLabel(active.turnTeam)} got it right!`;
  if (active.turnJudged === 'wrong') return `${teamLabel(active.turnTeam)} was wrong.`;
  if (active.timedOut) return `${teamLabel(active.turnTeam)} ran out of time.`;
  return 'Judging...';
}

function renderHostHint(active) {
  if (active.column === 'quotes') {
    return `<div class="gs-host-hint"><p class="gs-host-hint-label">HOST ONLY</p><p>Said by <strong>${active.content.character}</strong> (<em>${active.content.game || ''}</em>)</p></div>`;
  }
  if (active.column === 'trivia' || active.column === 'bonus') {
    return `<div class="gs-host-hint"><p class="gs-host-hint-label">HOST ONLY</p><p>Answer: <strong>${active.content.answer}</strong>${active.content.by ? ` <span class="hint">(submitted by ${active.content.by})</span>` : ''}</p></div>`;
  }
  if (active.column === 'screenshots') {
    if (active.stage === 'revealed') return '';
    return `<div class="gs-host-hint"><p class="gs-host-hint-label">HOST ONLY: Answer</p><img class="gs-cell-screenshot small" src="${active.content.answer}" alt="Answer" /></div>`;
  }
  return '';
}

function renderAnswerArea(iAmHost, active) {
  const me = myPlayer();
  const turnTeam = active.turnTeam;
  const isMyTurnTeam = me && me.role === turnTeam;
  let box;
  if (active.stage === 'answering') {
    if (active.turnLocked) {
      box = `<p class="gs-locked-answer">Locked in. Waiting on host.</p>`;
    } else if (isMyTurnTeam) {
      box = `<div class="join-row"><input type="text" id="gsAnswerInput" maxlength="200" placeholder="Your team's answer" /><button type="button" class="secondary" id="gsSubmitAnswerBtn">Submit</button></div>`;
    } else if (active.turnTyping) {
      // Live preview of what the other team is currently typing.
      box = `<p class="gs-locked-answer gs-live-typing">"${active.turnTyping}"</p>`;
    } else {
      box = `<p class="hint">Waiting...</p>`;
    }
  } else if (active.turnJudged === 'timeout' && !active.stealTeam) {
    // "Time ran out" is a status for the moment right after the clock
    // expires -- once a steal is claimed, the steal block below takes over
    // as the thing to look at, so this stops showing rather than sticking
    // around next to it (turnJudged stays 'timeout' forever, it never
    // resets, so gating on !stealTeam is what makes this go away).
    box = `<p class="gs-judge-result wrong">Time ran out.</p>`;
  } else if (active.turnJudged === 'timeout') {
    box = '';
  } else {
    // Guard against a null/empty answer rendering as the literal text
    // "null" (happens when the host judges without a submitted answer,
    // e.g. a screenshots question judged purely on the picture).
    box = active.turnAnswer ? `<p class="gs-locked-answer">"${active.turnAnswer}"</p>` : '';
    if (active.turnJudged) {
      box += `<p class="gs-judge-result ${active.turnJudged}">${active.turnJudged === 'correct' ? 'Correct' : 'Wrong'}</p>`;
    } else if (iAmHost) {
      box += `<div class="gs-judge-btns"><button type="button" class="secondary gs-small-btn" id="gsJudgeCorrectBtn">Correct</button><button type="button" class="secondary gs-small-btn" id="gsJudgeWrongBtn">Wrong</button></div>`;
    }
  }
  return `<div class="gs-answer-block">${box}</div>`;
}

// Self-service: no host offer needed. The non-turn team gets a STEAL
// button the moment the answer is revealed as wrong/timed out, but it's
// disabled/grayed until the full 60s clock has actually elapsed (checked
// server-side too, in claimSteal) -- pressing it early does nothing.
function renderStealArea(iAmHost, active, viewerKind) {
  const me = myPlayer();
  if (active.stage !== 'revealed') return '';
  const eligibleToSteal = active.turnJudged === 'wrong' || active.turnJudged === 'timeout';
  if (!active.stealTeam && eligibleToSteal) {
    const stealTeam = otherTeam(active.turnTeam);
    const remaining = Math.max(0, Math.ceil((active.deadline - Date.now()) / 1000));
    const canClaim = remaining <= 0;
    const mine = viewerKind === 'competitor' && me && me.role === stealTeam;
    if (!mine) {
      return `<div class="center gs-steal-wait"><p class="hint">${teamLabel(stealTeam)} can steal${remaining > 0 ? ` in ${remaining}s` : ' now'}.</p></div>`;
    }
    return `
      <div class="center gs-steal-wait">
        <button type="button" class="primary gs-steal-btn" id="gsClaimStealBtn" ${canClaim ? '' : 'disabled'}>
          ${canClaim ? 'STEAL!' : `STEAL (unlocks in ${remaining}s)`}
        </button>
      </div>
    `;
  }
  if (!active.stealTeam) return '';
  const mine = me && me.role === active.stealTeam;
  let inner;
  if (active.stealAnswer == null) {
    inner = mine
      ? `<div class="join-row"><input type="text" id="gsStealInput" maxlength="200" placeholder="Steal answer" /><button type="button" class="secondary" id="gsSubmitStealBtn">Submit</button></div>`
      : `<p class="hint">Waiting on ${teamLabel(active.stealTeam)}'s steal answer...</p>`;
  } else {
    inner = `<p class="gs-locked-answer">"${active.stealAnswer}"</p>` + (active.stealJudged
      ? `<p class="gs-judge-result ${active.stealJudged}">${active.stealJudged === 'correct' ? 'Stole it!' : `Wrong. Loses ${Math.floor(active.value / 2)} pts.`}</p>`
      : iAmHost ? `<div class="gs-judge-btns"><button type="button" class="secondary gs-small-btn" id="gsJudgeStealCorrect">Correct</button><button type="button" class="secondary gs-small-btn" id="gsJudgeStealWrong">Wrong</button></div>` : '');
  }
  return `<div class="gs-steal-block"><p class="gs-section-title">Steal: ${teamLabel(active.stealTeam)}</p>${inner}</div>`;
}

// Full-screen 5s takeover shown to EVERYONE the instant a steal is
// claimed, before the normal steal answer UI appears.
function renderStealTakeover(active) {
  return `
    <div class="gs-takeover">
      <div class="gs-takeover-box">
        <p class="gs-takeover-text">${teamLabel(active.stealTeam)}<br/>HAVE STOLEN THE QUESTION</p>
      </div>
    </div>
  `;
}

const JUDGE_ANNOUNCE_MS = 2200;
function renderJudgeTakeover(correct) {
  return `
    <div class="gs-takeover">
      <div class="gs-takeover-box ${correct ? 'good' : 'bad'}">
        <p class="gs-takeover-text">${correct ? 'Correct' : 'Wrong'}</p>
      </div>
    </div>
  `;
}

// Any full-screen takeover state active right now for this cell (steal
// claim, or a just-judged correct/wrong) -- checked once so the scoreboard
// can be hidden alongside it, keeping the screen a uniform size no matter
// which state is showing.
function activeTakeover(active) {
  if (active.stealTeam && active.stealAnnouncedAt && (Date.now() - active.stealAnnouncedAt < STEAL_ANNOUNCE_MS)) {
    return { type: 'steal' };
  }
  if (active.stealJudged && active.stealJudgedAt && (Date.now() - active.stealJudgedAt < JUDGE_ANNOUNCE_MS)) {
    return { type: 'judge', correct: active.stealJudged === 'correct' };
  }
  if (active.turnJudged && (active.turnJudged === 'correct' || active.turnJudged === 'wrong') && active.turnJudgedAt && (Date.now() - active.turnJudgedAt < JUDGE_ANNOUNCE_MS)) {
    return { type: 'judge', correct: active.turnJudged === 'correct' };
  }
  return null;
}

function renderActiveCellPanel(iAmHost) {
  const room = state.room;
  const active = room.board.active;
  const me = myPlayer();
  const viewerKind = iAmHost ? 'host' : (me && (me.role === 'teamA' || me.role === 'teamB') ? 'competitor' : 'spectator');

  const takeover = activeTakeover(active);
  if (takeover) return takeover.type === 'steal' ? renderStealTakeover(active) : renderJudgeTakeover(takeover.correct);

  // Once revealed, screenshots show the full/original answer image to
  // everyone (not just the host) instead of just the cropped hint.
  const shotSrc = (active.column === 'screenshots' && active.stage === 'revealed' && active.content.answer) ? active.content.answer : active.content.hint;
  const promptHtml = active.column === 'screenshots'
    ? `<div class="gs-cell-screenshot-frame" data-zoom-img="${shotSrc}"><img class="gs-cell-screenshot" src="${shotSrc}" alt="Screenshot" /></div>`
    : `<p class="gs-cell-prompt">${active.column === 'quotes' ? `"${active.content.text}"` : active.content.question}</p>`;

  // Spectators (and, by extension, anyone just watching) get a simplified
  // panel: category, prompt, one line of status. No answer boxes, no host
  // controls -- but the timer+team bar IS visible to them too.
  if (viewerKind === 'spectator') {
    return `
      <div class="gs-active-cell">
        <p class="gs-cell-value">$${active.value}: ${COLUMN_LABELS[active.column] || 'Bonus'}</p>
        ${promptHtml}
        ${renderStatusBar(active)}
        <p class="gs-status-line">${spectatorStatusLine(active)}</p>
        ${renderStealArea(iAmHost, active, viewerKind)}
      </div>
    `;
  }

  const canClose = active.turnJudged === 'correct' || (active.turnJudged && (!active.stealTeam || active.stealJudged));

  return `
    <div class="gs-active-cell">
      <p class="gs-cell-value">$${active.value}: ${COLUMN_LABELS[active.column] || 'Bonus'}</p>
      ${promptHtml}
      ${iAmHost ? renderHostHint(active) : ''}
      ${renderStatusBar(active)}
      ${renderAnswerArea(iAmHost, active)}
      ${renderStealArea(iAmHost, active, viewerKind)}
      ${iAmHost ? `
        <div class="center" style="margin-top:10px;">
          ${active.stage === 'answering' ? `<button type="button" class="primary" id="gsRevealAnswerBtn">Reveal Answer</button>` : ''}
          ${active.stage === 'revealed' && canClose ? `<button type="button" class="primary" id="gsCloseCellBtn">Close Question</button>` : ''}
          <button type="button" class="secondary gs-small-btn" id="gsAbandonCellBtn">Cancel Question</button>
        </div>
      ` : ''}
    </div>
  `;
}

// Announce/active stages now use the same full-screen takeover look as the
// steal takeover, instead of a small inline banner -- and unlike the 5s
// steal takeover, "announcing" has NO auto-timeout: it stays up until the
// host clicks Begin Round, since they need that time to explain the rules.
function renderComebackTakeover(iAmHost, cb) {
  if (cb.stage === 'announcing') {
    return `
      <div class="gs-takeover">
        <div class="gs-takeover-box">
          <p class="gs-takeover-text">That Won't Be Necessary<br/>${cb.playerName} (${teamLabel(cb.team)})</p>
          ${iAmHost ? `<button type="button" class="primary gs-small-btn" id="gsBeginComebackBtn">Begin Round</button>` : ''}
        </div>
      </div>
    `;
  }
  if (cb.stage === 'done') {
    // Same full-screen treatment as every other announcement (steal claim,
    // host felt nice, etc) instead of an inline banner that grew the
    // screen taller than the rest of the game.
    return `
      <div class="gs-takeover">
        <div class="gs-takeover-box good">
          <p class="gs-takeover-text">${cb.playerName} got ${teamLabel(cb.team)} ${cb.points} point${cb.points === 1 ? '' : 's'}!</p>
          ${iAmHost ? `<button type="button" class="secondary gs-small-btn" id="gsClearComebackBtn">Dismiss</button>` : ''}
        </div>
      </div>
    `;
  }
  // active -- spectators/host/other team get the same live view the
  // attempting player sees on their own screen, including the character
  // picture (was missing here before, text-only).
  const live = cb.live || { points: 0, timeLeft: SPEED_ROUND_SECONDS, typing: '', img: null };
  return `
    <div class="gs-takeover">
      <div class="gs-takeover-box">
        <p class="gs-takeover-timer">${live.timeLeft != null ? live.timeLeft : ''}s</p>
        ${live.img ? `<img class="gs-comeback-live-img" src="${live.img}" alt="" />` : ''}
        <p class="gs-takeover-text">${cb.playerName}: ${live.points} pt${live.points === 1 ? '' : 's'}</p>
        ${live.typing ? `<p class="gs-takeover-typing">"${live.typing}"</p>` : ''}
      </div>
    </div>
  `;
}

function renderComebackArea(iAmHost) {
  const room = state.room;
  const cb = room.board.comeback;
  if (cb) {
    // announcing/active/done are ALL handled by renderComebackTakeover from
    // renderScreenBoard now (full-screen, scoreboard hidden, uniform size)
    // -- nothing left for this function to draw while a comeback exists.
    return '';
  }

  if (!iAmHost || room.board.active) return '';
  const gap = Math.abs(room.board.scores.teamA - room.board.scores.teamB);
  if (gap < 1000) return '';
  const losingTeam = room.board.scores.teamA < room.board.scores.teamB ? 'teamA' : 'teamB';
  const members = room.players.filter(p => p.role === losingTeam);
  if (!members.length) return '';
  return `
    <div class="gs-comeback-trigger">
      <p class="hint">${teamLabel(losingTeam)} is down by ${gap}. Trigger the comeback round?</p>
      <select id="gsComebackPlayerSelect">
        ${members.map(m => `<option value="${m.id}">${m.name}</option>`).join('')}
      </select>
      <button type="button" class="secondary gs-small-btn" id="gsStartComebackBtn" data-team="${losingTeam}">That Won't Be Necessary</button>
    </div>
  `;
}

function renderZoomLightbox() {
  return `
    <div class="zoom-overlay ${state.zoomImageSrc ? 'active' : ''}" id="gsZoomLightbox">
      <div class="zoom-card gs-zoom-card">
        ${state.zoomImageSrc ? `<img src="${state.zoomImageSrc}" alt="Screenshot, enlarged" />` : ''}
        <button type="button" class="close-btn" id="gsCloseZoomBtn">Close</button>
      </div>
    </div>
  `;
}

const HOST_NICE_MS = 4000;

function renderGameOverScreen(iAmHost) {
  const room = state.room;
  const winner = room.board.scores.teamA === room.board.scores.teamB ? null : (room.board.scores.teamA > room.board.scores.teamB ? 'teamA' : 'teamB');
  const winners = winner ? room.players.filter(p => p.role === winner) : [];
  return `
    <div class="gs-takeover">
      <div class="gs-takeover-box">
        <p class="gs-takeover-text">${winner ? `${teamLabel(winner)} WON!` : "IT'S A TIE!"}</p>
        ${winners.length ? `<div class="gs-winner-avatars">${winners.map(p => `<div class="gs-mini-avatar-wrap"><div class="gs-mini-avatar" data-avatar-for="${p.id}"></div><span>${p.name}</span></div>`).join('')}</div>` : ''}
        ${iAmHost ? `<button type="button" class="primary gs-small-btn" id="gsReplayGameBtn">Play Again</button>` : ''}
      </div>
    </div>
  `;
}

function renderHostNiceTakeover() {
  return `
    <div class="gs-takeover">
      <div class="gs-takeover-box good">
        <p class="gs-takeover-text">THE HOST FELT NICE</p>
      </div>
    </div>
  `;
}

// Hint-taken / Phone a Friend both show as a big-screen takeover now
// instead of a small toast, same treatment as every other announcement.
const HINT_ANNOUNCE_MS = 3200;
function renderHintAnnounceTakeover(announce) {
  const label = teamLabel(announce.team);
  const text = announce.kind === 'phone'
    ? `${label} is calling a friend from the audience!`
    : `${label} has taken a hint.`;
  return `
    <div class="gs-takeover">
      <div class="gs-takeover-box">
        <p class="gs-takeover-text">${text}</p>
      </div>
    </div>
  `;
}

// Host-only correction console: add/subtract points for either team.
function renderHostConsole() {
  return `
    <div class="gs-host-console">
      <select id="gsScoreTeamSelect">
        <option value="teamA">${teamLabel('teamA')}</option>
        <option value="teamB">${teamLabel('teamB')}</option>
      </select>
      <input type="number" id="gsScoreAmountInput" class="gs-score-amount-input" placeholder="+/- pts" />
      <button type="button" class="secondary gs-tiny-btn" id="gsAdjustScoreBtn">Apply</button>
    </div>
  `;
}

function renderScreenBoard() {
  const room = state.room;
  const iAmHost = room.hostId === socket.id;

  if (room.phase === 'finished') return renderGameOverScreen(iAmHost);

  const hostNiceActive = room.board.hostNice && (Date.now() - room.board.hostNice.at < HOST_NICE_MS);
  if (hostNiceActive) return renderHostNiceTakeover();

  const hintAnnounceActive = room.board.hintAnnounce && (Date.now() - room.board.hintAnnounce.at < HINT_ANNOUNCE_MS);
  if (hintAnnounceActive) return renderHintAnnounceTakeover(room.board.hintAnnounce);

  const cb = room.board.comeback;
  if (cb && (cb.stage === 'announcing' || cb.stage === 'active' || cb.stage === 'done')) return renderComebackTakeover(iAmHost, cb);

  const cellTakeover = room.board.active ? activeTakeover(room.board.active) : null;
  if (cellTakeover) {
    return cellTakeover.type === 'steal' ? renderStealTakeover(room.board.active) : renderJudgeTakeover(cellTakeover.correct);
  }

  return `
    ${renderScoreboard()}
    ${iAmHost ? renderHostConsole() : ''}
    ${renderComebackArea(iAmHost)}
    ${room.board.active ? renderActiveCellPanel(iAmHost) : renderBoardGrid(iAmHost)}
    ${!room.board.active && !cb ? renderPhoneRow(iAmHost) : ''}
  `;
}

function renderStage() {
  const room = state.room;
  let screenInner = '';
  // Team B's "is now X!" announce fires in the same tick the room flips to
  // 'ready' -- catch it here too, or the announce would never actually be
  // seen before the screen jumps straight to the ready view.
  const namingAnnounceLive = room.namingAnnounce && Date.now() - room.namingAnnounce.at < NAMING_ANNOUNCE_MS;
  if (room.phase === 'naming' || (room.phase === 'ready' && namingAnnounceLive)) screenInner = renderScreenNaming();
  else if (room.phase === 'ready') screenInner = renderScreenReady();
  else if (room.phase === 'playing' || room.phase === 'finished') screenInner = renderScreenBoard();
  else screenInner = renderScreenLobby();

  const me = myPlayer();
  const iAmHost = room.hostId === socket.id;
  const iAmCompetitor = me && (me.role === 'teamA' || me.role === 'teamB');
  const teamA = room.players.filter(p => p.role === 'teamA');
  const teamB = room.players.filter(p => p.role === 'teamB');
  const bothTeamsReady = teamA.length >= 1 && teamB.length >= 1;
  const everyoneReadied = [...teamA, ...teamB].every(p => p.ready);
  const canStartNaming = bothTeamsReady && everyoneReadied;

  return `
    <div class="gs-tv-screen ${room.phase === 'playing' || room.phase === 'finished' ? 'in-game' : ''}">
      <div id="gsScreenNotices" class="gs-screen-notices"></div>
      <div class="gs-tv-screen-inner">${screenInner}</div>
    </div>

    <div class="gs-floor">
      ${renderPodium('teamA')}
      ${renderHostSlot()}
      ${renderPodium('teamB')}
    </div>

    <div class="gs-spectator-row">
      ${Array.from({ length: room.maxSpectatorSeats }, (_, i) => i + 1).map(renderSeat).join('')}
    </div>

    ${renderClapArea()}

    ${renderPlayerRoster()}

    ${iAmHost && room.phase === 'lobby' ? `
      <div class="center">
        <button type="button" class="primary" id="gsStartNamingBtn" ${canStartNaming ? '' : 'disabled'}>Start Team Naming</button>
      </div>
    ` : ''}

    <div class="center gs-bottom-row">
      ${iAmCompetitor && room.phase === 'lobby' ? `
        <button type="button" class="secondary gs-small-btn ${me.ready ? 'is-ready' : ''}" id="gsReadyToggleBtn">${me.ready ? '✅ Ready' : 'Ready'}</button>
      ` : ''}
      <button type="button" class="secondary gs-tiny-btn gs-leave-btn" id="gsLeaveRoomBtn">Leave</button>
    </div>

    ${renderHostModal()}
    ${renderZoomLightbox()}
  `;
}

// Small, persistent "who's here" list -- replaces the old floating "X
// joined the room" toasts, which just got noisy. Sits right above the
// Start Team Naming / Leave Room row.
function renderPlayerRoster() {
  const room = state.room;
  const roleLabel = (p) => {
    if (p.role === 'host') return 'Host';
    if (p.role === 'teamA') return teamLabel('teamA');
    if (p.role === 'teamB') return teamLabel('teamB');
    if (p.role === 'spectator') return 'Spectator';
    return 'Picking a spot';
  };
  const players = room.players.slice().sort((a, b) => a.name.localeCompare(b.name));
  return `
    <div class="gs-roster">
      <p class="gs-roster-title">In this room (${players.length})</p>
      <div class="gs-roster-list">
        ${players.map(p => `<span class="gs-roster-chip">${p.name} <em>${roleLabel(p)}</em></span>`).join('')}
      </div>
    </div>
  `;
}

// ---------- standalone speed-round test harness (unchanged mechanic) ----------
const SPEED_ROUND_SECONDS = 60;
const NAMES_PER_POINT = 5;
const POINTS_PER_TIER = 100; // each tier of 5 correct names is worth 100 game points

function renderLeaderboard() {
  const board = state.leaderboard || [];
  if (!board.length) return '<p class="hint">No scores yet. Be the first!</p>';
  return `
    <ol class="gs-leaderboard-list">
      ${board.map(entry => `<li><span class="gs-leaderboard-name">${entry.name}</span><span class="gs-leaderboard-points">${entry.points} pt${entry.points === 1 ? '' : 's'} <span class="gs-leaderboard-detail">(${entry.correctCount} correct, ${entry.wrongCount} wrong)</span></span></li>`).join('')}
    </ol>
  `;
}

function renderSpeedIntro() {
  return `
    <div class="card center">
      <h2 class="gs-gate-title">That Won't Be Necessary</h2>
      <p class="hint">
        A character's picture shows up on screen. Type their name (or pick
        it from the dropdown) as fast as you can, then the next one appears.
        Every ${NAMES_PER_POINT} correct names earns ${POINTS_PER_TIER} points. ${SPEED_ROUND_SECONDS} seconds on the clock.
      </p>
      <button type="button" class="primary" id="gsStartSpeedBtn">Start (${SPEED_ROUND_SECONDS}s)</button>
      <div style="margin-top:10px;"><button type="button" class="secondary" id="gsBackFromIntroBtn">Back</button></div>
    </div>
    <div class="card center">
      <p class="gs-section-title">Leaderboard</p>
      ${renderLeaderboard()}
    </div>
  `;
}

function renderSpeedPlaying() {
  const s = state.speed;
  const correctCount = s.feed.filter(f => f.ok).length;
  const points = Math.floor(correctCount / NAMES_PER_POINT) * POINTS_PER_TIER;
  const progressInTier = correctCount % NAMES_PER_POINT;
  return `
    <div class="${state.comebackMode ? 'gs-comeback-screen' : 'card gs-speed-card'}">
      ${state.comebackMode ? '<p class="gs-comeback-onscreen-title">That Won\'t Be Necessary</p>' : ''}
      <div class="gs-speed-topbar">
        <div class="gs-speed-timer ${s.timeLeft <= 10 ? 'urgent' : ''}" id="gsTimer">${s.timeLeft}s</div>
        <div class="gs-speed-score">
          <span class="gs-speed-points">${points} pt${points === 1 ? '' : 's'}</span>
          <span class="gs-speed-progress">${progressInTier}/${NAMES_PER_POINT} to next</span>
        </div>
      </div>

      <div class="gs-target-wrap">
        <div class="gs-target-frame">
          <img id="gsTargetImg" src="${gsImgUrl(s.current)}" alt="Who is this?" />
        </div>
      </div>

      <div class="gs-speed-input-wrap">
        <input type="text" id="gsSpeedInput" class="gs-speed-input" placeholder="Who is this? Type their name..." autocomplete="off" autocapitalize="off" spellcheck="false" />
        <div class="gs-speed-suggestions" id="gsSuggestions"></div>
      </div>

      <div class="gs-speed-feed" id="gsFeed">
        ${s.feed.slice().reverse().map(f => `
          <div class="gs-feed-row ${f.ok ? 'ok' : 'bad'}">
            ${f.img ? `<img src="${f.img}" alt="" />` : ''}
            <span class="gs-feed-name">${f.name}</span>
            <span class="gs-feed-mark">${f.ok ? 'RIGHT' : 'WRONG'}</span>
          </div>
        `).join('')}
      </div>

      <div class="center" style="margin-top:12px;">
        <button type="button" class="secondary" id="gsQuitSpeedBtn">End Early</button>
      </div>
    </div>
  `;
}

function renderSpeedResults() {
  const s = state.speed;
  const correctCount = s.feed.filter(f => f.ok).length;
  const wrongCount = s.feed.length - correctCount;
  const points = Math.floor(correctCount / NAMES_PER_POINT) * POINTS_PER_TIER;
  return `
    <div class="card center">
      <h2 class="gs-gate-title">Time's up!</h2>
      <p class="gs-result-points">${points} point${points === 1 ? '' : 's'}</p>
      <p class="hint">${correctCount} correct &middot; ${wrongCount} wrong &middot; ${s.feed.length} total guesses</p>
      ${s.savedToLeaderboard ? `<p class="gs-screen-status" style="color:#1c7a2e;">Saved to the leaderboard!</p>` : `
        <div class="join-row gs-name-submit-row" style="max-width:320px; margin:12px auto 0;">
          <input type="text" id="gsLeaderboardNameInput" placeholder="Your name" maxlength="24" value="${state.myName.replace(/"/g, '&quot;')}" />
          <button type="button" class="secondary" id="gsSaveScoreBtn">Save Score</button>
        </div>
      `}
      <button type="button" class="primary" id="gsPlayAgainBtn" style="margin-top:14px;">Play Again</button>
      <div style="margin-top:10px;"><button type="button" class="secondary" id="gsBackToHubBtn">Back</button></div>
    </div>
    <div class="card center">
      <p class="gs-section-title">Leaderboard</p>
      ${renderLeaderboard()}
    </div>
  `;
}

// ---------- handlers ----------
function attachHandlers() {
  // avatar builder (landing only, but harmless to try wiring elsewhere)
  document.querySelectorAll('.arrow-row button').forEach(btn => {
    btn.addEventListener('click', () => {
      const layer = btn.dataset.layer;
      const dir = parseInt(btn.dataset.dir, 10);
      const count = effectiveLayerCount(layer);
      avatar[layer] = ((avatar[layer] - 1 + dir + count) % count) + 1;
      saveAvatar(avatar);
      const stageEl = document.getElementById('avatarStage');
      if (stageEl) renderAvatarStage(stageEl, avatar);
    });
  });
  const diceBtn = document.getElementById('diceBtn');
  if (diceBtn) diceBtn.addEventListener('click', () => {
    avatar = {
      base: 1 + Math.floor(Math.random() * effectiveLayerCount('base')),
      face: 1 + Math.floor(Math.random() * effectiveLayerCount('face')),
      hat: 1 + Math.floor(Math.random() * effectiveLayerCount('hat'))
    };
    saveAvatar(avatar);
    const stageEl = document.getElementById('avatarStage');
    if (stageEl) renderAvatarStage(stageEl, avatar);
  });

  // landing -- just create/join here; name + avatar happen next, together,
  // on the Build Your Character screen.
  const createBtn = document.getElementById('gsCreateRoomBtn');
  if (createBtn) createBtn.addEventListener('click', () => {
    socket.emit('gsCreateRoom', { name: 'Player', avatar, clientId }, (res) => {
      if (!res.ok) { state.error = res.error || 'Could not create room.'; render(); }
    });
  });

  const joinCodeInput = document.getElementById('gsJoinCodeInput');
  if (joinCodeInput) joinCodeInput.addEventListener('input', e => { state.joinCodeInput = e.target.value.toUpperCase(); });

  const joinBtn = document.getElementById('gsJoinRoomBtn');
  if (joinBtn) joinBtn.addEventListener('click', () => {
    if (!state.joinCodeInput.trim()) { state.error = 'Enter a room code.'; render(); return; }
    socket.emit('gsJoinRoom', { code: state.joinCodeInput.trim(), name: 'Player', avatar, clientId }, (res) => {
      if (!res.ok) { state.error = res.error || 'Could not join room.'; render(); }
    });
  });

  const devBtn = document.getElementById('gsDevTestBtn');
  if (devBtn) devBtn.addEventListener('click', () => { state.screen = 'speedIntro'; refreshGsLeaderboard(); render(); });

  const refreshPendingBtn = document.getElementById('gsRefreshPendingBtn');
  if (refreshPendingBtn) refreshPendingBtn.addEventListener('click', refreshGsPendingRooms);

  document.querySelectorAll('[data-join-pending]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.joinCodeInput = btn.dataset.joinPending;
      socket.emit('gsJoinRoom', { code: state.joinCodeInput, name: 'Player', avatar, clientId }, (res) => {
        if (!res.ok) { state.error = res.error || 'Could not join room.'; render(); }
      });
    });
  });

  const howToPlayBtn = document.getElementById('gsHowToPlayBtn');
  if (howToPlayBtn) howToPlayBtn.addEventListener('click', (e) => { e.preventDefault(); state.showHowToPlay = true; render(); });
  const closeHowToPlayBtn = document.getElementById('gsCloseHowToPlayBtn');
  if (closeHowToPlayBtn) closeHowToPlayBtn.addEventListener('click', () => { state.showHowToPlay = false; render(); });

  // avatar setup (shown once, right after joining/creating a room)
  const avatarNameInput = document.getElementById('gsAvatarNameInput');
  if (avatarNameInput) avatarNameInput.addEventListener('input', e => { state.myName = e.target.value; });

  const confirmAvatarBtn = document.getElementById('gsConfirmAvatarBtn');
  if (confirmAvatarBtn) confirmAvatarBtn.addEventListener('click', () => {
    if (!state.myName.trim()) { state.error = 'Enter a name first.'; render(); return; }
    state.error = '';
    socket.emit('gsSetProfile', { name: state.myName.trim(), avatar }, (res) => {
      if (!res.ok) { showGsNotice(res.error || "Couldn't save your character."); return; }
      state.avatarConfirmed = true;
      state.screen = 'stage';
      render();
    });
  });

  // stage: leave
  const leaveBtn = document.getElementById('gsLeaveRoomBtn');
  if (leaveBtn) leaveBtn.addEventListener('click', () => {
    socket.emit('gsLeaveRoom');
    state.room = null;
    state.avatarConfirmed = false;
    state.showHostModal = false;
    state.screen = 'landing';
    render();
    refreshGsPendingRooms();
  });

  // stage: host slot (modal, so it never disturbs the floor layout)
  const openHostBoxBtn = document.getElementById('gsOpenHostBoxBtn');
  if (openHostBoxBtn) openHostBoxBtn.addEventListener('click', () => {
    state.showHostModal = true;
    state.hostAuthError = '';
    render();
    const pwInput = document.getElementById('gsHostPasswordInput');
    if (pwInput) pwInput.focus();
  });

  const cancelHostBtn = document.getElementById('gsCancelHostBtn');
  if (cancelHostBtn) cancelHostBtn.addEventListener('click', () => {
    state.showHostModal = false;
    state.hostAuthError = '';
    render();
  });

  const becomeHostBtn = document.getElementById('gsBecomeHostBtn');
  if (becomeHostBtn) becomeHostBtn.addEventListener('click', () => {
    const pwInput = document.getElementById('gsHostPasswordInput');
    const password = pwInput ? pwInput.value.trim().toUpperCase() : '';
    socket.emit('gsSetRole', { role: 'host', password }, (res) => {
      state.hostAuthError = res.ok ? '' : (res.error || 'Wrong password.');
      if (res.ok) state.showHostModal = false;
      render();
    });
  });
  const hostPwInput = document.getElementById('gsHostPasswordInput');
  if (hostPwInput) hostPwInput.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('gsBecomeHostBtn').click(); });

  // stage: podiums (join team at the specific slot clicked)
  document.querySelectorAll('[data-join-team]').forEach(btn => {
    btn.addEventListener('click', () => {
      const slot = parseInt(btn.dataset.joinSlot, 10);
      socket.emit('gsSetRole', { role: btn.dataset.joinTeam, slot }, (res) => {
        if (!res.ok) showGsNotice(res.error || "Couldn't join that team.");
      });
    });
  });

  // stage: spectator seats
  document.querySelectorAll('.gs-seat.empty').forEach(btn => {
    btn.addEventListener('click', () => {
      const seat = parseInt(btn.dataset.seat, 10);
      socket.emit('gsSetRole', { role: 'spectator', seat }, (res) => {
        if (!res.ok) showGsNotice(res.error || "Couldn't sit there.");
      });
    });
  });

  const readyToggleBtn = document.getElementById('gsReadyToggleBtn');
  if (readyToggleBtn) readyToggleBtn.addEventListener('click', () => {
    socket.emit('gsToggleReady', null, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't update ready status.");
    });
  });

  document.querySelectorAll('[data-zoom-img]').forEach(el => {
    el.addEventListener('click', () => { state.zoomImageSrc = el.dataset.zoomImg; render(); });
  });
  const closeZoomBtn = document.getElementById('gsCloseZoomBtn');
  if (closeZoomBtn) closeZoomBtn.addEventListener('click', () => { state.zoomImageSrc = null; render(); });
  const zoomOverlay = document.getElementById('gsZoomLightbox');
  if (zoomOverlay) zoomOverlay.addEventListener('click', (e) => { if (e.target === zoomOverlay) { state.zoomImageSrc = null; render(); } });

  const clapBtn = document.getElementById('gsClapBtn');
  if (clapBtn) clapBtn.addEventListener('click', () => socket.emit('gsClap'));

  const clapVolBtn = document.getElementById('gsClapVolBtn');
  if (clapVolBtn) clapVolBtn.addEventListener('click', () => {
    // Cycle full -> half -> muted -> full, so one button covers both
    // "turn it down" and "turn it off" without a slider.
    if (state.clapMuted) { state.clapMuted = false; state.clapVolume = 1; }
    else if (state.clapVolume > 0.5) { state.clapVolume = 0.4; }
    else { state.clapMuted = true; }
    saveClapPrefs();
    render();
  });

  const startNamingBtn = document.getElementById('gsStartNamingBtn');
  if (startNamingBtn) startNamingBtn.addEventListener('click', () => {
    socket.emit('gsStartNaming', null, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't start naming.");
    });
  });

  // naming
  // Naming's submit screen is deliberately just the one input, nothing
  // else -- Enter is the only way to submit.
  document.querySelectorAll('.gs-name-solo-input').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || !input.value.trim()) return;
      const team = input.id.replace('gsNameInput_', '');
      socket.emit('gsSubmitTeamName', { team, text: input.value }, (res) => {
        if (!res.ok) showGsNotice(res.error || "Couldn't submit.");
      });
    });
  });

  document.querySelectorAll('.gs-vote-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('gsVoteTeamName', { team: btn.dataset.team, candidateIdx: parseInt(btn.dataset.idx, 10) }, (res) => {
        if (!res.ok) showGsNotice(res.error || "Couldn't vote.");
      });
    });
  });

  const finishNamingBtn = document.getElementById('gsFinishNamingBtn');
  if (finishNamingBtn) finishNamingBtn.addEventListener('click', () => {
    socket.emit('gsFinishNaming', null, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't lock in names.");
    });
  });

  // board: start game
  const startGameBtn = document.getElementById('gsStartGameBtn');
  if (startGameBtn) startGameBtn.addEventListener('click', () => {
    socket.emit('gsStartGame', null, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't start the game.");
    });
  });

  // board: open a cell / reroll a cell's question / trigger a bonus question
  document.querySelectorAll('[data-open-cell]').forEach(el => {
    el.addEventListener('click', () => {
      socket.emit('gsOpenCell', { cellId: el.dataset.openCell }, (res) => {
        if (!res.ok) showGsNotice(res.error || "Couldn't open that question.");
      });
    });
  });

  document.querySelectorAll('[data-reroll-cell]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      socket.emit('gsRerollCell', { cellId: btn.dataset.rerollCell }, (res) => {
        // The $ value on an unopened cell never changes, so without an
        // explicit confirmation there's no visible sign the swap worked --
        // that's almost certainly why this looked "broken."
        if (res.ok) showGsNotice('Swapped for a different question.');
        else showGsNotice(res.error || "Couldn't swap that question.");
      });
    });
  });

  const triggerBonusBtn = document.getElementById('gsTriggerBonusBtn');
  if (triggerBonusBtn) triggerBonusBtn.addEventListener('click', () => {
    const select = document.getElementById('gsBonusTeamSelect');
    const team = select ? select.value : 'teamA';
    socket.emit('gsTriggerBonus', { team }, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't trigger the bonus question.");
    });
  });

  const replayGameBtn = document.getElementById('gsReplayGameBtn');
  if (replayGameBtn) replayGameBtn.addEventListener('click', () => {
    socket.emit('gsReplayGame', null, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't start a new game.");
    });
  });

  // board: submit the turn team's answer
  const submitAnswerBtn = document.getElementById('gsSubmitAnswerBtn');
  if (submitAnswerBtn) submitAnswerBtn.addEventListener('click', () => {
    const me = myPlayer();
    const input = document.getElementById('gsAnswerInput');
    if (!input || !input.value.trim() || !me) return;
    socket.emit('gsSubmitAnswer', { team: me.role, text: input.value }, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't submit.");
    });
  });

  // Live-typing mirror: cosmetic only, never trusted for judging.
  const answerInput = document.getElementById('gsAnswerInput');
  if (answerInput) answerInput.addEventListener('input', throttleTyping(() => {
    socket.emit('gsTypingAnswer', { text: answerInput.value }, () => {});
  }));

  const revealBtn = document.getElementById('gsRevealAnswerBtn');
  if (revealBtn) revealBtn.addEventListener('click', () => {
    socket.emit('gsRevealAnswer', null, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't reveal.");
    });
  });

  const judgeCorrectBtn = document.getElementById('gsJudgeCorrectBtn');
  if (judgeCorrectBtn) judgeCorrectBtn.addEventListener('click', () => {
    socket.emit('gsJudgeAnswer', { correct: true }, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't judge.");
    });
  });
  const judgeWrongBtn = document.getElementById('gsJudgeWrongBtn');
  if (judgeWrongBtn) judgeWrongBtn.addEventListener('click', () => {
    socket.emit('gsJudgeAnswer', { correct: false }, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't judge.");
    });
  });

  const claimStealBtn = document.getElementById('gsClaimStealBtn');
  if (claimStealBtn) claimStealBtn.addEventListener('click', () => {
    const room = state.room;
    const active = room.board.active;
    const me = myPlayer();
    if (!me) return;
    socket.emit('gsClaimSteal', { team: me.role }, (res) => {
      if (!res.ok) showGsNotice(res.error || "Can't steal yet.");
    });
  });

  const submitStealBtn = document.getElementById('gsSubmitStealBtn');
  if (submitStealBtn) submitStealBtn.addEventListener('click', () => {
    const input = document.getElementById('gsStealInput');
    if (!input || !input.value.trim()) return;
    socket.emit('gsSubmitSteal', { text: input.value }, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't submit steal.");
    });
  });

  const stealInput = document.getElementById('gsStealInput');
  if (stealInput) stealInput.addEventListener('input', throttleTyping(() => {
    socket.emit('gsTypingAnswer', { text: stealInput.value, steal: true }, () => {});
  }));

  // host mini-console: manual score correction ("The Host felt nice")
  const adjustScoreBtn = document.getElementById('gsAdjustScoreBtn');
  if (adjustScoreBtn) adjustScoreBtn.addEventListener('click', () => {
    const teamSelect = document.getElementById('gsScoreTeamSelect');
    const amountInput = document.getElementById('gsScoreAmountInput');
    const team = teamSelect ? teamSelect.value : '';
    const amount = amountInput ? parseInt(amountInput.value, 10) : 0;
    if (!team || !amount) { showGsNotice('Pick a team and an amount first.'); return; }
    socket.emit('gsAdjustScore', { team, amount }, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't adjust score.");
      else if (amountInput) amountInput.value = '';
    });
  });

  // host: preview an unopened cell's content before deciding to reroll it
  document.querySelectorAll('[data-preview-cell]').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('gsPreviewCell', { cellId: btn.dataset.previewCell }, (res) => {
        if (!res.ok) { showGsNotice(res.error || "Couldn't preview."); return; }
        showGsCellPreview(res.content, res.column);
      });
    });
  });

  const judgeStealCorrect = document.getElementById('gsJudgeStealCorrect');
  if (judgeStealCorrect) judgeStealCorrect.addEventListener('click', () => {
    socket.emit('gsJudgeSteal', { correct: true }, (res) => { if (!res.ok) showGsNotice(res.error || 'Error.'); });
  });
  const judgeStealWrong = document.getElementById('gsJudgeStealWrong');
  if (judgeStealWrong) judgeStealWrong.addEventListener('click', () => {
    socket.emit('gsJudgeSteal', { correct: false }, (res) => { if (!res.ok) showGsNotice(res.error || 'Error.'); });
  });

  const closeCellBtn = document.getElementById('gsCloseCellBtn');
  if (closeCellBtn) closeCellBtn.addEventListener('click', () => {
    socket.emit('gsCloseCell', null, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't close.");
    });
  });

  // Escape hatch: if a question ever gets stuck (mid-judgment, mid-steal,
  // whatever), the host can always bail out and get the board back.
  const abandonCellBtn = document.getElementById('gsAbandonCellBtn');
  if (abandonCellBtn) abandonCellBtn.addEventListener('click', () => {
    socket.emit('gsAbandonCell', null, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't cancel.");
    });
  });

  // board: hints + phone a friend
  document.querySelectorAll('[data-hint-team]').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('gsGiveHint', { team: btn.dataset.hintTeam }, (res) => {
        if (!res.ok) showGsNotice(res.error || "Couldn't give hint.");
      });
    });
  });

  document.querySelectorAll('[data-phone-go]').forEach(btn => {
    btn.addEventListener('click', () => {
      const team = btn.dataset.phoneGo;
      const select = document.querySelector(`[data-phone-team="${team}"]`);
      const spectatorId = select ? select.value : '';
      if (!spectatorId) { showGsNotice('Pick a spectator first.'); return; }
      socket.emit('gsUsePhoneAFriend', { team, spectatorId }, (res) => {
        if (!res.ok) showGsNotice(res.error || "Couldn't use Phone a Friend.");
      });
    });
  });

  // Self-service: a competitor taking their own team's hint or Phone a
  // Friend directly, instead of waiting on the host's console above.
  document.querySelectorAll('[data-take-hint]').forEach(el => {
    el.addEventListener('click', () => {
      socket.emit('gsGiveHint', { team: el.dataset.takeHint }, (res) => {
        if (!res.ok) showGsNotice(res.error || "Couldn't take that hint.");
      });
    });
  });

  document.querySelectorAll('[data-take-phone]').forEach(el => {
    el.addEventListener('click', () => showGsPhonePicker(el.dataset.takePhone));
  });

  // board: comeback trigger
  const startComebackBtn = document.getElementById('gsStartComebackBtn');
  if (startComebackBtn) startComebackBtn.addEventListener('click', () => {
    const select = document.getElementById('gsComebackPlayerSelect');
    const playerId = select ? select.value : '';
    if (!playerId) { showGsNotice('Pick a player first.'); return; }
    socket.emit('gsStartComeback', { team: startComebackBtn.dataset.team, playerId }, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't start the comeback round.");
    });
  });

  const beginComebackBtn = document.getElementById('gsBeginComebackBtn');
  if (beginComebackBtn) beginComebackBtn.addEventListener('click', () => {
    socket.emit('gsBeginComeback', null, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't begin the round.");
    });
  });

  const clearComebackBtn = document.getElementById('gsClearComebackBtn');
  if (clearComebackBtn) clearComebackBtn.addEventListener('click', () => {
    socket.emit('gsClearComebackBanner', null, (res) => {
      if (!res.ok) showGsNotice(res.error || 'Error.');
    });
  });

  // speed round test harness
  const startBtn = document.getElementById('gsStartSpeedBtn');
  if (startBtn) startBtn.addEventListener('click', startSpeedRound);

  const backFromIntro = document.getElementById('gsBackFromIntroBtn');
  if (backFromIntro) backFromIntro.addEventListener('click', () => { state.screen = 'landing'; render(); });

  const quitBtn = document.getElementById('gsQuitSpeedBtn');
  if (quitBtn) quitBtn.addEventListener('click', endSpeedRound);

  const saveScoreBtn = document.getElementById('gsSaveScoreBtn');
  if (saveScoreBtn) saveScoreBtn.addEventListener('click', () => {
    const nameInput = document.getElementById('gsLeaderboardNameInput');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) { showGsNotice('Enter a name first.'); return; }
    const s = state.speed;
    const correctCount = s.feed.filter(f => f.ok).length;
    const wrongCount = s.feed.length - correctCount;
    const points = Math.floor(correctCount / NAMES_PER_POINT) * POINTS_PER_TIER;
    socket.emit('gsSubmitLeaderboardScore', { name, points, correctCount, wrongCount }, (res) => {
      if (!res || !res.ok) { showGsNotice('Could not save your score.'); return; }
      s.savedToLeaderboard = true;
      render();
    });
  });

  const playAgainBtn = document.getElementById('gsPlayAgainBtn');
  if (playAgainBtn) playAgainBtn.addEventListener('click', () => { state.screen = 'speedIntro'; refreshGsLeaderboard(); render(); });

  const backToHub = document.getElementById('gsBackToHubBtn');
  if (backToHub) backToHub.addEventListener('click', () => { state.screen = 'landing'; render(); });

  wireSpeedInput();
  wireTurnTimer();
}

// ---------- live board timers: 60s answer countdown, steal-unlock
// countdown, and the 5s steal-takeover expiry ----------
let turnTimerHandle = null;
function wireTurnTimer() {
  clearInterval(turnTimerHandle);
  turnTimerHandle = null;
  const room = state.room;
  if (!room) return;

  // "Team X is now Y!" naming announce expiry.
  if (room.namingAnnounce) {
    const msLeft = NAMING_ANNOUNCE_MS - (Date.now() - room.namingAnnounce.at);
    if (msLeft > 0) { turnTimerHandle = setTimeout(render, msLeft + 50); return; }
  }

  if (!room.board) return;

  // "Host felt nice" takeover expiry.
  if (room.board.hostNice) {
    const msLeft = HOST_NICE_MS - (Date.now() - room.board.hostNice.at);
    if (msLeft > 0) { turnTimerHandle = setTimeout(render, msLeft + 50); return; }
  }

  // Hint-taken / Phone a Friend takeover expiry.
  if (room.board.hintAnnounce) {
    const msLeft = HINT_ANNOUNCE_MS - (Date.now() - room.board.hintAnnounce.at);
    if (msLeft > 0) { turnTimerHandle = setTimeout(render, msLeft + 50); return; }
  }

  const active = room.board.active;
  if (!active) return;

  // Any active takeover (steal claim, or a just-judged correct/wrong) --
  // force a re-render right when it expires so the screen swaps back to
  // the normal panel.
  const takeover = activeTakeover(active);
  if (takeover) {
    const at = active.stealAnnouncedAt || active.stealJudgedAt || active.turnJudgedAt;
    const windowMs = takeover.type === 'steal' ? STEAL_ANNOUNCE_MS : JUDGE_ANNOUNCE_MS;
    const msLeft = windowMs - (Date.now() - at);
    if (msLeft > 0) { turnTimerHandle = setTimeout(render, msLeft + 50); return; }
  }

  if (active.stage === 'answering') {
    const tick = () => {
      const r = state.room;
      const a = r && r.board && r.board.active;
      if (!a || a.stage !== 'answering') { clearInterval(turnTimerHandle); return; }
      const remaining = Math.max(0, Math.ceil((a.deadline - Date.now()) / 1000));
      const el = document.getElementById('gsTurnTimer');
      if (el) el.textContent = remaining + 's';
      if (remaining <= 0) clearInterval(turnTimerHandle);
    };
    tick();
    turnTimerHandle = setInterval(tick, 500);
    return;
  }

  // Steal-unlock countdown: nothing to claim, or already claimed -- no
  // ticking UI needed.
  if (active.stage === 'revealed' && !active.stealTeam && (active.turnJudged === 'wrong' || active.turnJudged === 'timeout')) {
    const remaining = active.deadline - Date.now();
    if (remaining > 0) { turnTimerHandle = setTimeout(render, remaining + 50); return; }
  }
}

// ---------- speed round logic ----------
let speedTimerHandle = null;

function gsNextTarget(s) {
  if (!s.queue || s.queueIdx >= s.queue.length) {
    s.queue = gsShuffle(GS_CHARACTERS);
    s.queueIdx = 0;
  }
  const next = s.queue[s.queueIdx];
  s.queueIdx += 1;
  return next;
}

function startSpeedRound() {
  const s = { timeLeft: SPEED_ROUND_SECONDS, feed: [], queue: [], queueIdx: 0, current: null };
  s.current = gsNextTarget(s);
  state.speed = s;
  state.screen = 'speedPlaying';
  render();
  const input = document.getElementById('gsSpeedInput');
  if (input) input.focus();

  clearInterval(speedTimerHandle);
  speedTimerHandle = setInterval(() => {
    state.speed.timeLeft -= 1;
    if (state.speed.timeLeft <= 0) { endSpeedRound(); return; }
    const timerEl = document.getElementById('gsTimer');
    if (timerEl) {
      timerEl.textContent = state.speed.timeLeft + 's';
      timerEl.classList.toggle('urgent', state.speed.timeLeft <= 10);
    }
    // During the comeback round, keep everyone else's shared big-screen
    // countdown ticking too, not just updating on each guess.
    if (state.comebackMode) {
      const correctCount = state.speed.feed.filter(f => f.ok).length;
      const points = Math.floor(correctCount / NAMES_PER_POINT) * POINTS_PER_TIER;
      socket.emit('gsComebackLive', { points, correctCount, timeLeft: state.speed.timeLeft, img: gsImgUrl(state.speed.current) }, () => {});
    }
  }, 1000);
}

function endSpeedRound() {
  clearInterval(speedTimerHandle);
  speedTimerHandle = null;
  if (state.comebackMode) {
    const correctCount = state.speed.feed.filter(f => f.ok).length;
    const points = Math.floor(correctCount / NAMES_PER_POINT) * POINTS_PER_TIER;
    socket.emit('gsFinishComeback', { points }, () => {});
    state.comebackMode = false;
    state.screen = 'stage';
    render();
    return;
  }
  state.screen = 'speedResults';
  refreshGsLeaderboard();
  render();
}

function gsFindMatches(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return GS_CHARACTERS.filter(c => c.name.toLowerCase().includes(q)).slice(0, 6);
}

function gsSubmitGuess(guessedName) {
  const s = state.speed;
  if (!s || !s.current) return;
  const key = guessedName.trim().toLowerCase();
  if (!key) return;

  const target = s.current;
  const ok = key === target.name.toLowerCase();
  s.feed.push({ name: target.name, ok, img: gsImgUrl(target) });
  ok ? playTing() : playError();

  s.current = gsNextTarget(s);

  const input = document.getElementById('gsSpeedInput');
  // Selecting a suggestion is a click on a DIV, not the input, so focus
  // silently moves away from the box -- explicitly grab it back every time
  // so the player never has to reclick before typing the next name.
  if (input) { input.value = ''; input.focus(); }
  const suggestions = document.getElementById('gsSuggestions');
  if (suggestions) suggestions.innerHTML = '';

  const targetImg = document.getElementById('gsTargetImg');
  if (targetImg) targetImg.src = gsImgUrl(s.current);

  const topbar = document.querySelector('.gs-speed-topbar');
  const feedEl = document.getElementById('gsFeed');
  const correctCount = s.feed.filter(f => f.ok).length;
  const points = Math.floor(correctCount / NAMES_PER_POINT) * POINTS_PER_TIER;
  if (topbar) {
    const progressInTier = correctCount % NAMES_PER_POINT;
    topbar.querySelector('.gs-speed-points').textContent = `${points} pt${points === 1 ? '' : 's'}`;
    topbar.querySelector('.gs-speed-progress').textContent = `${progressInTier}/${NAMES_PER_POINT} to next`;
  }
  // During the comeback round, let everyone else (host/spectators/other
  // team) watch this live on the shared TV screen instead of only seeing
  // this player's own private view.
  if (state.comebackMode) {
    socket.emit('gsComebackLive', { points, correctCount, img: gsImgUrl(s.current) }, () => {});
  }
  if (feedEl) {
    const row = document.createElement('div');
    row.className = 'gs-feed-row ' + (ok ? 'ok' : 'bad');
    const last = s.feed[s.feed.length - 1];
    row.innerHTML = `${last.img ? `<img src="${last.img}" alt="" />` : ''}<span class="gs-feed-name">${last.name}</span><span class="gs-feed-mark">${ok ? 'RIGHT' : 'WRONG'}</span>`;
    feedEl.insertBefore(row, feedEl.firstChild);
  }
}

function wireSpeedInput() {
  const input = document.getElementById('gsSpeedInput');
  const suggestionsBox = document.getElementById('gsSuggestions');
  if (!input || !suggestionsBox) return;

  let activeIndex = -1;

  function renderSuggestions() {
    const matches = gsFindMatches(input.value);
    activeIndex = -1;
    suggestionsBox.innerHTML = matches.map((c, i) => `
      <div class="gs-suggestion-row" data-idx="${i}" data-name="${c.name.replace(/"/g, '&quot;')}">
        <img src="${gsImgUrl(c)}" alt="" />
        <span>${c.name}</span>
      </div>
    `).join('');
  }

  input.addEventListener('input', renderSuggestions);
  input.addEventListener('input', throttleTyping(() => {
    if (state.comebackMode) socket.emit('gsComebackTyping', { text: input.value }, () => {});
  }));

  input.addEventListener('keydown', e => {
    const rows = Array.from(suggestionsBox.querySelectorAll('.gs-suggestion-row'));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!rows.length) return;
      activeIndex = Math.min(activeIndex + 1, rows.length - 1);
      rows.forEach((r, i) => r.classList.toggle('active', i === activeIndex));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      activeIndex = Math.max(activeIndex - 1, 0);
      rows.forEach((r, i) => r.classList.toggle('active', i === activeIndex));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (rows.length) {
        const pick = rows[activeIndex >= 0 ? activeIndex : 0];
        gsSubmitGuess(pick.dataset.name);
      } else if (input.value.trim()) {
        gsSubmitGuess(input.value);
      }
    }
  });

  suggestionsBox.addEventListener('click', e => {
    const row = e.target.closest('.gs-suggestion-row');
    if (row) gsSubmitGuess(row.dataset.name);
  });
}

loadGsCharacters().then(render);
if (socket.connected) refreshGsPendingRooms();
