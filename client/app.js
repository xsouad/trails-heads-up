const socket = io();

// ---------- persistence: name, avatar, client identity, current room ----------
// Uses sessionStorage (not localStorage) on purpose: it's scoped per browser tab
// instead of shared across every tab on the site. That means opening several
// tabs (to test a multiplayer room solo) gives each tab its own independent
// identity automatically, no incognito windows needed. It also means a full
// page refresh naturally starts fresh -- which we make explicit below by
// clearing it entirely on pagehide, so "reload the page" always means "start
// over" while leaving a room via the in-app button (no reload involved) still
// keeps your name/avatar for next time.
const STORAGE_KEYS = {
  clientId: 'trailsHeadsUp_clientId',
  name: 'trailsHeadsUp_name',
  room: 'trailsHeadsUp_room'
};
// Avatar's own storage key/save/load functions now live in avatar-shared.js
// (AVATAR_STORAGE_KEY, saveAvatar, loadAvatar) since Guess Who needs them too.

function getClientId() {
  let id = sessionStorage.getItem(STORAGE_KEYS.clientId);
  if (!id) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('c-' + Math.random().toString(36).slice(2) + Date.now());
    sessionStorage.setItem(STORAGE_KEYS.clientId, id);
  }
  return id;
}
const clientId = getClientId();

function saveName(name) { sessionStorage.setItem(STORAGE_KEYS.name, name); }
function loadName() { return sessionStorage.getItem(STORAGE_KEYS.name) || ''; }

function saveCurrentRoom(code, wasSpectator) {
  sessionStorage.setItem(STORAGE_KEYS.room, JSON.stringify({ code, wasSpectator: !!wasSpectator }));
}
function loadCurrentRoom() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEYS.room)); }
  catch (e) { return null; }
}
function clearCurrentRoom() { sessionStorage.removeItem(STORAGE_KEYS.room); }

// Proactively tell the server we're leaving the moment the page starts to unload
// (refresh, close tab, navigate away) instead of waiting for the connection to
// time out, AND wipe this tab's saved identity so a reload always starts fresh
// rather than silently rejoining as the same player.
window.addEventListener('pagehide', () => {
  if (socket.connected) socket.emit('leaveRoom');
  sessionStorage.removeItem(STORAGE_KEYS.clientId);
  sessionStorage.removeItem(STORAGE_KEYS.name);
  sessionStorage.removeItem(AVATAR_STORAGE_KEY);
  sessionStorage.removeItem(STORAGE_KEYS.room);
});

// LAYER_COUNTS, BONUS_HAT_COUNT, and the `avatar` variable itself now live in
// avatar-shared.js (loaded before this file), shared with Guess Who.
let gameOrder = [];
let mySocketId = null;
let currentRoomState = null;
let isHost = false;
let selectedVisibility = 'private';
// No default cutoff/categories -- the host has to actively pick both for a
// room's first game, so a spoiler cutoff can never be silently left at "allow
// everything" just because nobody happened to click a chip.
let selectedCutoff = null;
let selectedCategories = new Set();
let pendingSpectate = null; // room code we're trying to spectate
let timerInterval = null;
let timerStartedAt = null;

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function startGameTimer(startedAt, elementId) {
  if (timerInterval && timerStartedAt === startedAt) {
    // already running for this round, just make sure the right element is being updated
  }
  clearInterval(timerInterval);
  timerStartedAt = startedAt;
  const el = document.getElementById(elementId);
  function tick() {
    if (el) el.textContent = '\u23F1 ' + formatElapsed(Date.now() - startedAt);
  }
  tick();
  timerInterval = setInterval(tick, 1000);
}

function stopGameTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  stopRedrawHintTimer();
}

// ---------- redraw window countdown + button greying ----------
let redrawHintInterval = null;
function tickRedrawWindow(startedAt, windowMs) {
  const hint = document.getElementById('redrawHint');
  const remaining = windowMs - (Date.now() - startedAt);
  if (remaining > 0) {
    if (hint) hint.textContent = `You have ${Math.ceil(remaining / 1000)}s to redraw a card`;
  } else {
    if (hint) hint.textContent = 'Redraw window closed';
    document.querySelectorAll('.redraw-btn').forEach(btn => {
      btn.disabled = true;
      btn.classList.add('expired');
    });
    clearInterval(redrawHintInterval);
    redrawHintInterval = null;
  }
}
function startRedrawHintTimer(startedAt, windowMs) {
  clearInterval(redrawHintInterval);
  tickRedrawWindow(startedAt, windowMs);
  redrawHintInterval = setInterval(() => tickRedrawWindow(startedAt, windowMs), 1000);
}
function stopRedrawHintTimer() {
  clearInterval(redrawHintInterval);
  redrawHintInterval = null;
  const hint = document.getElementById('redrawHint');
  if (hint) hint.textContent = '';
}

// ---------- screen switching ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ---------- notices/toasts ----------
function showNotice(text) {
  const bar = document.getElementById('noticeBar');
  const toast = document.createElement('div');
  toast.className = 'notice-toast';
  toast.textContent = text;
  bar.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}
socket.on('notice', (n) => showNotice(n.text));
socket.on('kicked', () => {
  showNotice('You were removed from the room by the host.');
  currentRoomState = null;
  clearCurrentRoom();
  stopGameTimer();
  showScreen('screen-home');
  document.getElementById('bottomBar').style.display = 'none';
  { const w = document.querySelector('.cheat-input-game-wrap'); if (w) w.classList.remove('visible'); }
  refreshPublicRooms();
});
socket.on('roomClosed', () => {
  showNotice('The room was closed.');
  currentRoomState = null;
  clearCurrentRoom();
  stopGameTimer();
  showScreen('screen-home');
  document.getElementById('bottomBar').style.display = 'none';
  { const w = document.querySelector('.cheat-input-game-wrap'); if (w) w.classList.remove('visible'); }
});

// ---------- avatar builder ----------
// renderAvatarStage/effectiveLayerCount/cheatAccessoriesUnlocked now live in
// avatar-shared.js. Just keep the local helper that targets this page's
// specific #avatarStage element.
function refreshAvatarStage() {
  renderAvatarStage(document.getElementById('avatarStage'), avatar);
}

document.querySelectorAll('.arrow-row button').forEach(btn => {
  btn.addEventListener('click', () => {
    const layer = btn.dataset.layer;
    const dir = parseInt(btn.dataset.dir, 10);
    const count = effectiveLayerCount(layer);
    avatar[layer] = ((avatar[layer] - 1 + dir + count) % count) + 1;
    saveAvatar(avatar);
    refreshAvatarStage();
  });
});
document.getElementById('diceBtn').addEventListener('click', () => {
  avatar = {
    base: 1 + Math.floor(Math.random() * effectiveLayerCount('base')),
    face: 1 + Math.floor(Math.random() * effectiveLayerCount('face')),
    hat: 1 + Math.floor(Math.random() * effectiveLayerCount('hat'))
  };
  saveAvatar(avatar);
  refreshAvatarStage();
});
refreshAvatarStage();

// ---------- hidden cheat inputs ----------
// Each input is visually invisible (see .cheat-input in style.css) and only
// listens for Enter. Wrong phrases and stray keystrokes are silently ignored
// and the field clears itself either way, so there's never any visible trace.
function wireCheatInput(inputId, secretPhrase, onMatch) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const val = el.value.trim().toUpperCase();
    el.value = '';
    el.blur();
    if (val === secretPhrase) onMatch();
  });
}
wireCheatInput('cheatInputHome', 'SPINSTELLE', () => {
  cheatAccessoriesUnlocked = true;
  showNotice('Cheat code inputted correctly!');
});
wireCheatInput('cheatInputGame', 'VANISVAN', () => {
  socket.emit('cheatPrank', {});
  showNotice('Cheat code inputted correctly!');
});

// Restore the player's last-used name so they don't have to retype it every
// time they come back.
(function restoreName() {
  const nameInputEl = document.getElementById('nameInput');
  const savedName = loadName();
  if (savedName) nameInputEl.value = savedName;
  nameInputEl.addEventListener('input', () => saveName(nameInputEl.value));
})();

// ---------- visibility toggle ----------
document.querySelectorAll('#visibilityRow .category-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#visibilityRow .category-chip').forEach(c => c.classList.remove('selected'));
    chip.classList.add('selected');
    selectedVisibility = chip.dataset.visibility;
  });
});

// ---------- home: create / join ----------
document.getElementById('createRoomBtn').addEventListener('click', () => {
  const name = document.getElementById('nameInput').value.trim() || 'Player';
  saveName(name);
  socket.emit('createRoom', { name, avatar, visibility: selectedVisibility, clientId }, (res) => {
    if (!res.ok) { document.getElementById('homeError').textContent = res.error; return; }
    saveCurrentRoom(res.code, false);
    showScreen('screen-lobby');
  });
});

document.getElementById('joinRoomBtn').addEventListener('click', () => {
  const name = document.getElementById('nameInput').value.trim() || 'Player';
  const code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
  if (!code) { document.getElementById('homeError').textContent = 'Enter a room code.'; return; }
  saveName(name);
  socket.emit('joinRoom', { code, name, avatar, clientId }, (res) => {
    if (!res.ok) { document.getElementById('homeError').textContent = res.error; return; }
    saveCurrentRoom(res.code, false);
    showScreen('screen-lobby');
  });
});

// ---------- public room browser ----------
function refreshPublicRooms() {
  socket.emit('listPublicRooms', {}, (list) => {
    const container = document.getElementById('publicRoomList');
    container.innerHTML = '';
    if (!list.length) {
      container.innerHTML = '<div class="public-room-empty">No public games right now.</div>';
      return;
    }
    list.forEach(r => {
      const row = document.createElement('div');
      row.className = 'public-room-row';
      const label = document.createElement('span');
      label.textContent = `${r.hostName}'s room (${r.playerCount}/5 players, ${r.phase}), ${r.spectatorCount} watching`;
      row.appendChild(label);

      if (r.phase === 'lobby') {
        const joinBtn = document.createElement('button');
        joinBtn.textContent = 'Join';
        joinBtn.addEventListener('click', () => {
          const name = document.getElementById('nameInput').value.trim() || 'Player';
          saveName(name);
          socket.emit('joinRoom', { code: r.code, name, avatar, clientId }, (res) => {
            if (!res.ok) { document.getElementById('homeError').textContent = res.error; return; }
            saveCurrentRoom(res.code, false);
            showScreen('screen-lobby');
          });
        });
        row.appendChild(joinBtn);
      } else if (r.phase === 'playing' || r.phase === 'ended') {
        const watchBtn = document.createElement('button');
        watchBtn.textContent = 'Watch';
        watchBtn.addEventListener('click', () => {
          const name = document.getElementById('nameInput').value.trim() || 'Spectator';
          saveName(name);
          socket.emit('joinAsSpectator', { code: r.code, name }, (res) => {
            if (!res.ok) { document.getElementById('homeError').textContent = res.error; return; }
            saveCurrentRoom(r.code, true);
          });
        });
        row.appendChild(watchBtn);
      }
      container.appendChild(row);
    });
  });
}
document.getElementById('refreshPublicBtn').addEventListener('click', refreshPublicRooms);

// Clicking the dimmed backdrop (not the card itself) closes a popup, same as the
// explicit close/cancel buttons.
function wireClickAwayToClose(overlayId, onClose) {
  const overlay = document.getElementById(overlayId);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) onClose();
  });
}
wireClickAwayToClose('zoomOverlay', () => document.getElementById('zoomOverlay').classList.remove('active'));
wireClickAwayToClose('leaveConfirmOverlay', () => document.getElementById('leaveConfirmOverlay').classList.remove('active'));

// ---------- how to play page-flip viewer ----------
const HOW_TO_PLAY_PAGE_COUNT = 4;
let howToPlayPage = 1;
function renderHowToPlayPage() {
  document.getElementById('howToPlayImg').src = `assets/how-to-play/page-${howToPlayPage}.png`;
  document.getElementById('howToPlayPageCount').textContent = `Page ${howToPlayPage} of ${HOW_TO_PLAY_PAGE_COUNT}`;
  document.getElementById('howToPlayPrevBtn').disabled = howToPlayPage === 1;
  document.getElementById('howToPlayNextBtn').disabled = howToPlayPage === HOW_TO_PLAY_PAGE_COUNT;
}
document.getElementById('howToPlayBtn').addEventListener('click', () => {
  howToPlayPage = 1;
  renderHowToPlayPage();
  document.getElementById('howToPlayOverlay').classList.add('active');
});
document.getElementById('howToPlayCloseBtn').addEventListener('click', () => {
  document.getElementById('howToPlayOverlay').classList.remove('active');
});
document.getElementById('howToPlayPrevBtn').addEventListener('click', () => {
  if (howToPlayPage > 1) { howToPlayPage -= 1; renderHowToPlayPage(); }
});
document.getElementById('howToPlayNextBtn').addEventListener('click', () => {
  if (howToPlayPage < HOW_TO_PLAY_PAGE_COUNT) { howToPlayPage += 1; renderHowToPlayPage(); }
});
wireClickAwayToClose('howToPlayOverlay', () => document.getElementById('howToPlayOverlay').classList.remove('active'));

// ---------- lobby settings ----------
socket.on('connect', () => {
  console.log('[socket connect]', socket.id, 'was previously:', mySocketId);
  mySocketId = socket.id;
  refreshPublicRooms();
  // If we think we're already in a room (this is a reconnect after a dropped
  // connection, e.g. the phone was backgrounded, or just a page refresh), try to
  // silently reclaim that player slot instead of landing back on the home screen
  // as a stranger. The server matches us by clientId, not socket.id.
  const saved = loadCurrentRoom();
  if (saved && saved.code && !saved.wasSpectator) {
    const name = document.getElementById('nameInput').value.trim() || loadName() || 'Player';
    socket.emit('rejoin', { code: saved.code, clientId, name, avatar }, (res) => {
      if (!res || !res.ok) {
        console.log('[rejoin failed]', res && res.error);
        clearCurrentRoom();
      }
      // On success the server's roomState broadcast (sent as part of the
      // rejoin) restores the right screen automatically.
    });
  }
});
socket.on('disconnect', (reason) => {
  console.log('[socket disconnect]', socket.id, 'reason:', reason);
});

// Both of these render purely from selectedCutoff/selectedCategories, which are
// kept in sync with the server's actual room.settings (not just local clicks) by
// the roomState handler further down every time the lobby is (re)entered. That's
// what stops a chip from looking pre-selected for a brand new room just because
// it was picked in a previous room in this same tab -- the new room's settings
// really are unset, so as soon as roomState comes in for it, these get
// re-rendered with nothing highlighted.
function renderCutoffChips() {
  const cutoffRow = document.getElementById('cutoffRow');
  cutoffRow.innerHTML = '';
  gameOrder.forEach(g => {
    const chip = document.createElement('div');
    chip.className = 'tag-chip' + (g.tag === selectedCutoff ? ' selected' : '');
    chip.textContent = g.tag;
    chip.title = g.title;
    chip.addEventListener('click', () => {
      selectedCutoff = g.tag;
      socket.emit('updateSettings', { cutoffTag: selectedCutoff });
      renderCutoffChips();
    });
    cutoffRow.appendChild(chip);
  });
}
socket.on('gameOrder', (order) => {
  gameOrder = order;
  renderCutoffChips();
});

const CATEGORY_DEFS = [
  { key: 'characters', label: 'Characters', enabled: true },
  { key: 'events', label: 'Events', enabled: true },
  { key: 'locations', label: 'Locations (coming soon)', enabled: false }
];
function renderCategoryChips() {
  const row = document.getElementById('categoryRow');
  row.innerHTML = '';
  CATEGORY_DEFS.forEach(cat => {
    const chip = document.createElement('div');
    chip.className = 'category-chip' + (selectedCategories.has(cat.key) ? ' selected' : '') + (cat.enabled ? '' : ' disabled');
    chip.textContent = cat.label;
    if (cat.enabled) {
      chip.addEventListener('click', () => {
        if (selectedCategories.has(cat.key)) selectedCategories.delete(cat.key);
        else selectedCategories.add(cat.key);
        socket.emit('updateSettings', { categories: Array.from(selectedCategories) });
        renderCategoryChips();
      });
    }
    row.appendChild(chip);
  });
}
renderCategoryChips();

document.getElementById('startGameBtn').addEventListener('click', () => {
  socket.emit('startGame', {}, (res) => {
    document.getElementById('lobbyError').textContent = res.ok ? '' : res.error;
  });
});

document.getElementById('revealBtn').addEventListener('click', (e) => {
  socket.emit('reveal');
  e.target.disabled = true;
  e.target.textContent = 'Waiting on others…';
});

// ---------- leave room (with confirmation) ----------
document.getElementById('leaveRoomBtn').addEventListener('click', () => {
  document.getElementById('leaveConfirmOverlay').classList.add('active');
});
document.getElementById('cancelLeaveBtn').addEventListener('click', () => {
  document.getElementById('leaveConfirmOverlay').classList.remove('active');
});
document.getElementById('confirmLeaveBtn').addEventListener('click', () => {
  socket.emit('leaveRoom');
  document.getElementById('leaveConfirmOverlay').classList.remove('active');
  currentRoomState = null;
  clearCurrentRoom();
  stopGameTimer();
  document.getElementById('bottomBar').style.display = 'none';
  { const w = document.querySelector('.cheat-input-game-wrap'); if (w) w.classList.remove('visible'); }
  showScreen('screen-home');
  refreshPublicRooms();
});

// ---------- end game vote ----------
document.getElementById('endGameBtn').addEventListener('click', () => {
  socket.emit('voteEndGame');
});

// ---------- rematch ----------
document.getElementById('askRematchBtn').addEventListener('click', () => {
  socket.emit('requestRematch');
});
document.getElementById('acceptRematchBtn').addEventListener('click', (e) => {
  socket.emit('respondRematch');
  e.target.disabled = true;
  e.target.textContent = 'Waiting on others…';
});

// ---------- item card rendering (image w/ text fallback + caption) ----------
function buildItemCardContent(item) {
  const wrap = document.createElement('div');
  wrap.className = 'item-card-content';
  if (item.image) {
    const img = document.createElement('img');
    img.src = `assets/items/${item.type === 'character' ? 'characters' : 'events'}/${item.image}`;
    img.onerror = () => { img.remove(); };
    wrap.appendChild(img);
  }
  const caption = document.createElement('div');
  caption.textContent = item.name;
  wrap.appendChild(caption);
  return wrap;
}

function openZoom(item) {
  const card = document.getElementById('zoomCard');
  card.innerHTML = '';
  if (item.image) {
    const img = document.createElement('img');
    img.src = `assets/items/${item.type === 'character' ? 'characters' : 'events'}/${item.image}`;
    img.onerror = () => img.remove();
    card.appendChild(img);
  }
  const text = document.createElement('div');
  text.style.fontSize = '1.1rem';
  text.style.fontWeight = 'bold';
  text.textContent = item.name;
  card.appendChild(text);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => document.getElementById('zoomOverlay').classList.remove('active'));
  card.appendChild(closeBtn);
  document.getElementById('zoomOverlay').classList.add('active');
}

// ---------- board rendering (shared by playing / ended / spectating) ----------
// `opts.allowRedraw` turns on the small redraw-request icon for everyone's card
// except your own (only meaningful during an active round -- see Section 2 of
// the redraw feature: only players OTHER than the card holder can tell it's a
// repeat, since the holder can't see their own item).
function renderBoard(container, players, opts) {
  opts = opts || {};
  container.innerHTML = '';
  players.forEach(p => {
    const cell = document.createElement('div');
    cell.className = 'board-player';

    // Every card in a row reserves the same amount of space for the redraw
    // button, even the self card (which never gets a real one) -- otherwise
    // cards without a button sit noticeably higher than ones with it, which is
    // the "cards floating up" misalignment.
    if (opts.allowRedraw) {
      if (!p.isSelf) {
        const votes = p.redrawVotes || [];
        const needed = p.redrawNeeded || 0;
        const iVoted = votes.includes(mySocketId);
        const windowMs = opts.redrawWindowMs || 30000;
        const expired = opts.startedAt ? (Date.now() - opts.startedAt > windowMs) : false;
        const redrawBtn = document.createElement('button');
        redrawBtn.type = 'button';
        redrawBtn.className = 'redraw-btn' + (expired ? ' expired' : '') + (iVoted ? ' voted' : '');
        redrawBtn.textContent = votes.length > 0 ? `↻ ${votes.length}/${needed}` : '↻';
        redrawBtn.title = expired
          ? 'The redraw window for this round has closed.'
          : (iVoted ? 'Waiting on everyone else to approve…' : "Think they've already had this one? Ask for a redraw.");
        redrawBtn.disabled = expired || iVoted;
        redrawBtn.addEventListener('click', () => {
          socket.emit('requestRedraw', { targetId: p.id }, (res) => {
            if (res && !res.ok) showNotice(res.error);
          });
        });
        cell.appendChild(redrawBtn);
      } else {
        const spacer = document.createElement('div');
        spacer.className = 'redraw-btn redraw-btn-spacer';
        cell.appendChild(spacer);
      }
    }

    const bubble = document.createElement('div');
    if (p.item) {
      bubble.className = 'item-bubble';
      bubble.appendChild(buildItemCardContent(p.item));
      bubble.addEventListener('click', () => openZoom(p.item));
    } else {
      bubble.className = 'item-bubble self-hidden';
      bubble.textContent = p.isSelf ? "It's a secret… to you at least." : 'Hidden';
    }

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'board-avatar';
    renderAvatarStage(avatarDiv, p.avatar);

    const nameEl = document.createElement('div');
    nameEl.className = 'board-name';
    nameEl.textContent = p.name + (p.revealed ? ' ✅' : '') + (p.disconnected ? ' (reconnecting…)' : '');

    const nameWrap = document.createElement('div');
    nameWrap.className = 'board-name-wrap';
    nameWrap.appendChild(avatarDiv);
    nameWrap.appendChild(nameEl);

    cell.appendChild(bubble);
    cell.appendChild(nameWrap);
    container.appendChild(cell);
  });
}

// ---------- lobby player list ----------
function renderLobbyList(players) {
  const list = document.getElementById('lobbyPlayerList');
  list.innerHTML = '';
  document.getElementById('playerCount').textContent = players.length;
  players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    const mini = document.createElement('div');
    mini.className = 'mini-avatar';
    renderAvatarStage(mini, p.avatar);
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = p.name + (p.disconnected ? ' (reconnecting…)' : '');
    chip.appendChild(mini);
    chip.appendChild(name);
    if (p.id === currentRoomState.hostId) {
      const badge = document.createElement('div');
      badge.className = 'host-badge';
      badge.textContent = 'HOST';
      chip.appendChild(badge);
    } else if (isHost) {
      const kickBtn = document.createElement('button');
      kickBtn.className = 'kick-btn';
      kickBtn.textContent = 'Kick';
      kickBtn.addEventListener('click', () => {
        socket.emit('kickPlayer', { targetId: p.id });
      });
      chip.appendChild(kickBtn);
    }
    list.appendChild(chip);
  });
}

// ---------- rematch avatar row with checkmarks ----------
function renderRematchList(players, rematchYes) {
  const list = document.getElementById('rematchAvatarList');
  list.innerHTML = '';
  players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'player-chip' + (rematchYes.includes(p.id) ? ' rematch-yes' : '');
    const mini = document.createElement('div');
    mini.className = 'mini-avatar';
    renderAvatarStage(mini, p.avatar);
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = p.name;
    chip.appendChild(mini);
    chip.appendChild(name);
    if (rematchYes.includes(p.id)) {
      const tick = document.createElement('div');
      tick.className = 'rematch-tick';
      tick.textContent = '✓ yes';
      chip.appendChild(tick);
    }
    list.appendChild(chip);
  });
}

// ---------- main state handler ----------
socket.on('roomState', (state) => {
  console.log('[roomState received]', 'phase:', state.phase, 'players:', state.players.length, state.players.map(p => p.name), 'mySocketId:', mySocketId, 'socket.id now:', socket.id, 'connected:', socket.connected);
  currentRoomState = state;
  isHost = state.hostId === mySocketId;
  document.getElementById('lobbyCode').textContent = state.code;

  const bottomBar = document.getElementById('bottomBar');
  bottomBar.style.display = 'flex';
  // The VANISVAN input only ever matters while a round is actually playing
  // (and never for spectators), so it's hidden the rest of the time instead of
  // sitting around on every screen.
  const cheatGameWrap = document.querySelector('.cheat-input-game-wrap');
  if (cheatGameWrap) {
    cheatGameWrap.classList.toggle('visible', !state.isSpectator && state.phase === 'playing');
  }
  const endGameBtn = document.getElementById('endGameBtn');
  endGameBtn.textContent = state.youVotedEndGame
    ? `Cancel End-Game Vote (${state.endGameVotes}/${state.endGameNeeded})`
    : `End Game (${state.endGameVotes}/${state.endGameNeeded})`;
  endGameBtn.style.display = (!state.isSpectator && state.phase === 'playing') ? 'block' : 'none';

  if (state.isSpectator) {
    showScreen('screen-spectate');
    renderBoard(document.getElementById('spectateBoard'), state.players, {});
    document.getElementById('spectatorCountSpectate').textContent = `${state.spectatorCount} spectator(s) watching`;
    return;
  }

  if (state.phase === 'lobby') {
    showScreen('screen-lobby');
    document.getElementById('hostSettings').style.display = isHost ? 'block' : 'none';
    document.getElementById('guestWaiting').style.display = isHost ? 'none' : 'block';
    renderLobbyList(state.players);
    // Always repaint the cutoff/category chips from the room's real settings
    // rather than trusting whatever was last clicked in this tab -- this is what
    // keeps a brand new room from visually looking like it already has a cutoff
    // picked when it actually doesn't.
    selectedCutoff = state.settings.cutoffTag;
    selectedCategories = new Set(state.settings.categories || []);
    renderCutoffChips();
    renderCategoryChips();
  } else if (state.phase === 'playing') {
    showScreen('screen-game');
    if (state.startedAt) startGameTimer(state.startedAt, 'gameTimer');
    if (state.startedAt) startRedrawHintTimer(state.startedAt, state.redrawWindowMs || 30000);
    renderBoard(document.getElementById('gameBoard'), state.players, {
      allowRedraw: true, startedAt: state.startedAt, redrawWindowMs: state.redrawWindowMs
    });
    document.getElementById('revealCounter').textContent = `${state.revealedCount}/${state.totalPlayers} ready to reveal`;
    document.getElementById('spectatorCountGame').textContent = state.spectatorCount ? `${state.spectatorCount} spectator(s) watching` : '';
    const me = state.players.find(p => p.id === mySocketId);
    const revealBtn = document.getElementById('revealBtn');
    if (me && me.revealed) {
      revealBtn.disabled = true;
      revealBtn.textContent = 'Waiting on others…';
    } else {
      revealBtn.disabled = false;
      revealBtn.textContent = "I'm Ready to Reveal";
    }
  } else if (state.phase === 'ended') {
    showScreen('screen-ended');
    stopGameTimer();
    if (state.startedAt) {
      const el = document.getElementById('endedTimer');
      if (el) el.textContent = 'Round took ' + formatElapsed(Date.now() - state.startedAt);
    }
    renderBoard(document.getElementById('endedBoard'), state.players, {});

    const askBtn = document.getElementById('askRematchBtn');
    const waitingMsg = document.getElementById('rematchWaitingHost');
    const voteCard = document.getElementById('rematchVoteCard');
    const acceptBtn = document.getElementById('acceptRematchBtn');

    if (!state.rematchRequested) {
      voteCard.style.display = 'none';
      askBtn.style.display = isHost ? 'block' : 'none';
      waitingMsg.style.display = isHost ? 'none' : 'block';
    } else {
      askBtn.style.display = 'none';
      waitingMsg.style.display = 'none';
      voteCard.style.display = 'block';
      renderRematchList(state.players, state.rematchYes);
      const me = state.players.find(p => p.id === mySocketId);
      const alreadyIn = state.rematchYes.includes(mySocketId);
      acceptBtn.disabled = alreadyIn;
      acceptBtn.textContent = alreadyIn ? 'Waiting on others…' : "Yes, I'm in!";
    }
  }
});
