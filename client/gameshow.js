// ---------- Gameshow (WIP) ----------
// Slice 1 (done earlier): a standalone "That Won't Be Necessary" speed-round
// test harness, reachable without a room via a dev button.
// Slice 2 (this pass): the actual multiplayer lobby -- people join a room,
// pick a position (Host, needs the VANISVAN password / Team A / Team B /
// Spectator with a seat), and the Team A vs Team B naming minigame.
// Still not built: the actual board (quotes/trivia/screenshots columns),
// hints, steal, and the "That Won't Be Necessary" comeback trigger hooked
// into a real match -- those come next.

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

const AVATAR_COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#f4a261', '#9b5de5', '#ff6392', '#606c38', '#118ab2'];

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
  screen: 'landing', // landing, lobby, naming, ready, speedIntro, speedPlaying, speedResults
  myName: '',
  myColor: AVATAR_COLORS[0],
  joinCodeInput: '',
  error: '',
  room: null, // last gsRoomState payload from the server
  hostPasswordDraft: '',
  hostAuthError: '',
  showSeatPicker: false,
  speed: null // set by startSpeedRound() -- the standalone test harness
};

const gsRoot = document.getElementById('gsRoot');

function showGsNotice(text) {
  const bar = document.getElementById('gsNoticeBar');
  if (!bar) return;
  const toast = document.createElement('div');
  toast.className = 'notice-toast';
  toast.textContent = text;
  bar.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

function showGsClapToast(name) {
  const bar = document.getElementById('gsNoticeBar');
  if (!bar) return;
  const toast = document.createElement('div');
  toast.className = 'notice-toast gs-clap-toast';
  toast.textContent = `👏 ${name} claps!`;
  bar.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

socket.on('gsNotice', ({ text }) => showGsNotice(text));
socket.on('gsClap', ({ name }) => showGsClapToast(name));
socket.on('gsRoomState', (room) => {
  state.room = room;
  if (state.screen === 'landing') {
    state.screen = room.phase === 'naming' ? 'naming' : (room.phase === 'ready' ? 'ready' : 'lobby');
  } else if (room.phase === 'naming' && state.screen === 'lobby') {
    state.screen = 'naming';
  } else if (room.phase === 'ready' && (state.screen === 'lobby' || state.screen === 'naming')) {
    state.screen = 'ready';
  } else if (room.phase === 'lobby' && (state.screen === 'naming' || state.screen === 'ready')) {
    state.screen = 'lobby';
  }
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

// ---------- render ----------
function render() {
  let html = '';
  if (state.screen === 'landing') html = renderLanding();
  else if (state.screen === 'lobby') html = renderLobby();
  else if (state.screen === 'naming') html = renderNaming();
  else if (state.screen === 'ready') html = renderReady();
  else if (state.screen === 'speedIntro') html = renderSpeedIntro();
  else if (state.screen === 'speedPlaying') html = renderSpeedPlaying();
  else if (state.screen === 'speedResults') html = renderSpeedResults();
  gsRoot.innerHTML = html;
  attachHandlers();
}

function myPlayer() {
  if (!state.room) return null;
  return state.room.players.find(p => p.id === socket.id) || null;
}

// ---------- landing ----------
function renderLanding() {
  return `
    <div class="card center">
      <h2 class="gs-gate-title">Gameshow</h2>
      <p class="hint">Still very much a work in progress -- pick a name, then create or join a room.</p>

      <input type="text" id="gsNameInput" class="gs-password-input" placeholder="Your name" maxlength="24" value="${state.myName.replace(/"/g, '&quot;')}" autocomplete="off" />

      <div class="gs-color-row">
        ${AVATAR_COLORS.map(c => `<button type="button" class="gs-color-swatch ${c === state.myColor ? 'active' : ''}" data-color="${c}" style="background:${c};"></button>`).join('')}
      </div>

      <div class="error-msg">${state.error}</div>

      <button type="button" class="primary" id="gsCreateRoomBtn">Create Room</button>

      <div class="gs-join-row">
        <input type="text" id="gsJoinCodeInput" class="gs-password-input gs-join-input" placeholder="Room code" maxlength="4" value="${state.joinCodeInput}" autocomplete="off" />
        <button type="button" class="secondary" id="gsJoinRoomBtn">Join Room</button>
      </div>
    </div>

    <div class="card center gs-dev-card">
      <!-- DEV TEST BUTTON -- remove once the real board is playable. Just a
           standalone way to try the speed-round minigame with no room. -->
      <p class="hint">Dev-only, temporary:</p>
      <button type="button" class="secondary" id="gsDevTestBtn">🧪 Test: Speed Round</button>
    </div>
  `;
}

// ---------- lobby ----------
function renderPlayerChip(p) {
  return `
    <div class="gs-chip">
      <span class="gs-chip-dot" style="background:${(p.avatar && p.avatar.color) || '#999'};">${(p.avatar && p.avatar.initial) || p.name[0].toUpperCase()}</span>
      <span class="gs-chip-name">${p.name}</span>
    </div>
  `;
}

function renderLobby() {
  const room = state.room;
  const me = myPlayer();
  const myRole = me ? me.role : 'unassigned';
  const teamA = room.players.filter(p => p.role === 'teamA');
  const teamB = room.players.filter(p => p.role === 'teamB');
  const host = room.players.find(p => p.role === 'host');
  const spectators = room.players.filter(p => p.role === 'spectator');
  const unassigned = room.players.filter(p => p.role === 'unassigned');
  const seatMap = {};
  spectators.forEach(p => { seatMap[p.seat] = p; });

  const iAmHost = room.hostId === socket.id;
  const bothTeamsReady = teamA.length >= 1 && teamB.length >= 1;

  return `
    <div class="card center">
      <h2 class="gs-gate-title">Room ${room.code}</h2>
      <p class="hint">Share this code so everyone else can join.</p>
      <button type="button" class="secondary" id="gsLeaveRoomBtn">Leave Room</button>
    </div>

    <div class="card">
      <p class="gs-section-title">Host</p>
      ${host ? renderPlayerChip(host) : `
        <div class="gs-role-pick">
          <input type="password" id="gsHostPasswordInput" class="gs-password-input" placeholder="Host code" ${myRole === 'host' ? 'disabled' : ''} />
          <button type="button" class="secondary" id="gsBecomeHostBtn" ${myRole === 'host' ? 'disabled' : ''}>Become Host</button>
        </div>
        <div class="error-msg">${state.hostAuthError}</div>
      `}
      ${host && myRole === 'host' ? `<p class="hint">You're the host. Only you can start naming and (later) run the board.</p>` : ''}
    </div>

    <div class="gs-teams-row">
      <div class="card gs-team-card">
        <p class="gs-section-title">Team A (${teamA.length}/${room.maxTeamSize})</p>
        <div class="gs-chip-list">${teamA.map(renderPlayerChip).join('') || '<p class="hint">No one yet.</p>'}</div>
        <button type="button" class="secondary gs-role-btn" data-role="teamA" ${myRole === 'teamA' ? 'disabled' : ''}>${myRole === 'teamA' ? 'You\'re on this team' : 'Join Team A'}</button>
      </div>
      <div class="card gs-team-card">
        <p class="gs-section-title">Team B (${teamB.length}/${room.maxTeamSize})</p>
        <div class="gs-chip-list">${teamB.map(renderPlayerChip).join('') || '<p class="hint">No one yet.</p>'}</div>
        <button type="button" class="secondary gs-role-btn" data-role="teamB" ${myRole === 'teamB' ? 'disabled' : ''}>${myRole === 'teamB' ? 'You\'re on this team' : 'Join Team B'}</button>
      </div>
    </div>

    <div class="card">
      <p class="gs-section-title">Spectators (${spectators.length}/${room.maxSpectatorSeats})</p>
      <div class="gs-seat-grid">
        ${Array.from({ length: room.maxSpectatorSeats }, (_, i) => i + 1).map(seat => {
          const occ = seatMap[seat];
          const isMe = occ && me && occ.id === me.id;
          return `
            <button type="button" class="gs-seat ${occ ? 'occupied' : ''} ${isMe ? 'mine' : ''}" data-seat="${seat}" ${occ && !isMe ? 'disabled' : ''}>
              ${occ ? `<span class="gs-chip-dot" style="background:${occ.avatar.color};">${occ.avatar.initial}</span><span class="gs-seat-name">${occ.name}</span>` : `<span class="gs-seat-num">${seat}</span>`}
            </button>
          `;
        }).join('')}
      </div>
      ${myRole === 'spectator' ? `<button type="button" class="primary" id="gsClapBtn">👏 Clap</button>` : ''}
    </div>

    ${unassigned.length ? `
      <div class="card">
        <p class="gs-section-title">Just joined</p>
        <div class="gs-chip-list">${unassigned.map(renderPlayerChip).join('')}</div>
      </div>
    ` : ''}

    ${iAmHost ? `
      <div class="card center">
        <button type="button" class="primary" id="gsStartNamingBtn" ${bothTeamsReady ? '' : 'disabled'}>Start Team Naming</button>
        ${bothTeamsReady ? '' : '<p class="hint">Both teams need at least 1 member first.</p>'}
      </div>
    ` : ''}
  `;
}

// ---------- naming ----------
function renderNameColumn(team, label) {
  const room = state.room;
  const t = room[team];
  const me = myPlayer();
  const onThisTeam = me && me.role === team;
  const myVote = me ? t.votes[me.id] : undefined;
  const tally = {};
  Object.values(t.votes).forEach(idx => { tally[idx] = (tally[idx] || 0) + 1; });

  return `
    <div class="card gs-team-card">
      <p class="gs-section-title">${label}</p>
      ${onThisTeam ? `
        <div class="gs-name-submit-row">
          <input type="text" id="gsNameInput_${team}" class="gs-password-input" placeholder="Suggest a team name" maxlength="30" />
          <button type="button" class="secondary gs-submit-name-btn" data-team="${team}">Submit</button>
        </div>
      ` : ''}
      <div class="gs-candidate-list">
        ${t.candidates.length ? t.candidates.map((c, idx) => `
          <div class="gs-candidate-row ${myVote === idx ? 'voted' : ''}">
            <span class="gs-candidate-text">"${c.text}" <span class="hint">-- ${c.byName}</span></span>
            <span class="gs-candidate-votes">${tally[idx] || 0} vote${(tally[idx] || 0) === 1 ? '' : 's'}</span>
            ${onThisTeam ? `<button type="button" class="secondary gs-vote-btn" data-team="${team}" data-idx="${idx}">${myVote === idx ? 'Voted' : 'Vote'}</button>` : ''}
          </div>
        `).join('') : '<p class="hint">No suggestions yet.</p>'}
      </div>
    </div>
  `;
}

function renderNaming() {
  const room = state.room;
  const iAmHost = room.hostId === socket.id;
  return `
    <div class="card center">
      <h2 class="gs-gate-title">Naming Your Teams</h2>
      <p class="hint">Everyone can watch live -- only team members can suggest and vote.</p>
    </div>
    <div class="gs-teams-row">
      ${renderNameColumn('teamA', 'Team A')}
      ${renderNameColumn('teamB', 'Team B')}
    </div>
    ${iAmHost ? `
      <div class="card center">
        <button type="button" class="primary" id="gsFinishNamingBtn">Lock In Team Names</button>
      </div>
    ` : `<div class="card center"><p class="hint">Waiting for the host to lock in the names...</p></div>`}
  `;
}

// ---------- ready ----------
function renderReady() {
  const room = state.room;
  return `
    <div class="card center">
      <h2 class="gs-gate-title">${room.teamA.name || 'Team A'} vs ${room.teamB.name || 'Team B'}</h2>
      <p class="hint">The board (quotes, trivia, screenshots, hints, steal) is being built next -- this screen will turn into the real game. For now, positions and team names are locked in.</p>
      <button type="button" class="secondary" id="gsLeaveRoomBtn">Leave Room</button>
    </div>
  `;
}

// ---------- standalone speed-round test harness (unchanged mechanic) ----------
const SPEED_ROUND_SECONDS = 60;
const NAMES_PER_POINT = 5;

function renderSpeedIntro() {
  return `
    <div class="card center">
      <h2 class="gs-gate-title">That Won't Be Necessary</h2>
      <p class="hint">
        A character's picture shows up on screen -- type their name (or pick
        it from the dropdown) as fast as you can, then the next one appears.
        Every ${NAMES_PER_POINT} correct names earns 1 point. ${SPEED_ROUND_SECONDS} seconds on the clock.
      </p>
      <button type="button" class="primary" id="gsStartSpeedBtn">Start (${SPEED_ROUND_SECONDS}s)</button>
      <div style="margin-top:10px;"><button type="button" class="secondary" id="gsBackFromIntroBtn">Back</button></div>
    </div>
  `;
}

function renderSpeedPlaying() {
  const s = state.speed;
  const correctCount = s.feed.filter(f => f.ok).length;
  const points = Math.floor(correctCount / NAMES_PER_POINT);
  const progressInTier = correctCount % NAMES_PER_POINT;
  return `
    <div class="card gs-speed-card">
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
  const points = Math.floor(correctCount / NAMES_PER_POINT);
  return `
    <div class="card center">
      <h2 class="gs-gate-title">Time's up!</h2>
      <p class="gs-result-points">${points} point${points === 1 ? '' : 's'}</p>
      <p class="hint">${correctCount} correct &middot; ${wrongCount} wrong &middot; ${s.feed.length} total guesses</p>
      <button type="button" class="primary" id="gsPlayAgainBtn">Play Again</button>
      <div style="margin-top:10px;"><button type="button" class="secondary" id="gsBackToHubBtn">Back</button></div>
    </div>
  `;
}

// ---------- handlers ----------
function attachHandlers() {
  // landing
  const nameInput = document.getElementById('gsNameInput');
  if (nameInput) nameInput.addEventListener('input', e => { state.myName = e.target.value; });

  document.querySelectorAll('.gs-color-swatch').forEach(btn => {
    btn.addEventListener('click', () => { state.myColor = btn.dataset.color; render(); });
  });

  const createBtn = document.getElementById('gsCreateRoomBtn');
  if (createBtn) createBtn.addEventListener('click', () => {
    if (!state.myName.trim()) { state.error = 'Enter a name first.'; render(); return; }
    const avatar = { color: state.myColor, initial: state.myName.trim()[0].toUpperCase() };
    socket.emit('gsCreateRoom', { name: state.myName.trim(), avatar, clientId }, (res) => {
      if (!res.ok) { state.error = res.error || 'Could not create room.'; render(); }
    });
  });

  const joinCodeInput = document.getElementById('gsJoinCodeInput');
  if (joinCodeInput) joinCodeInput.addEventListener('input', e => { state.joinCodeInput = e.target.value.toUpperCase(); });

  const joinBtn = document.getElementById('gsJoinRoomBtn');
  if (joinBtn) joinBtn.addEventListener('click', () => {
    if (!state.myName.trim()) { state.error = 'Enter a name first.'; render(); return; }
    if (!state.joinCodeInput.trim()) { state.error = 'Enter a room code.'; render(); return; }
    const avatar = { color: state.myColor, initial: state.myName.trim()[0].toUpperCase() };
    socket.emit('gsJoinRoom', { code: state.joinCodeInput.trim(), name: state.myName.trim(), avatar, clientId }, (res) => {
      if (!res.ok) { state.error = res.error || 'Could not join room.'; render(); }
    });
  });

  const devBtn = document.getElementById('gsDevTestBtn');
  if (devBtn) devBtn.addEventListener('click', () => { state.screen = 'speedIntro'; render(); });

  // lobby
  const leaveBtn = document.getElementById('gsLeaveRoomBtn');
  if (leaveBtn) leaveBtn.addEventListener('click', () => {
    socket.emit('gsLeaveRoom');
    state.room = null;
    state.screen = 'landing';
    render();
  });

  const becomeHostBtn = document.getElementById('gsBecomeHostBtn');
  if (becomeHostBtn) becomeHostBtn.addEventListener('click', () => {
    const pwInput = document.getElementById('gsHostPasswordInput');
    const password = pwInput ? pwInput.value.trim().toUpperCase() : '';
    socket.emit('gsSetRole', { role: 'host', password }, (res) => {
      state.hostAuthError = res.ok ? '' : (res.error || 'Wrong password.');
      render();
    });
  });

  document.querySelectorAll('.gs-role-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('gsSetRole', { role: btn.dataset.role }, (res) => {
        if (!res.ok) { showGsNotice(res.error || "Couldn't switch roles."); }
      });
    });
  });

  document.querySelectorAll('.gs-seat').forEach(btn => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => {
      const seat = parseInt(btn.dataset.seat, 10);
      socket.emit('gsSetRole', { role: 'spectator', seat }, (res) => {
        if (!res.ok) { showGsNotice(res.error || "Couldn't sit there."); }
      });
    });
  });

  const clapBtn = document.getElementById('gsClapBtn');
  if (clapBtn) clapBtn.addEventListener('click', () => socket.emit('gsClap'));

  const startNamingBtn = document.getElementById('gsStartNamingBtn');
  if (startNamingBtn) startNamingBtn.addEventListener('click', () => {
    socket.emit('gsStartNaming', null, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't start naming.");
    });
  });

  // naming
  document.querySelectorAll('.gs-submit-name-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const team = btn.dataset.team;
      const input = document.getElementById('gsNameInput_' + team);
      if (!input || !input.value.trim()) return;
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

  // speed round test harness
  const startBtn = document.getElementById('gsStartSpeedBtn');
  if (startBtn) startBtn.addEventListener('click', startSpeedRound);

  const backFromIntro = document.getElementById('gsBackFromIntroBtn');
  if (backFromIntro) backFromIntro.addEventListener('click', () => { state.screen = 'landing'; render(); });

  const quitBtn = document.getElementById('gsQuitSpeedBtn');
  if (quitBtn) quitBtn.addEventListener('click', endSpeedRound);

  const playAgainBtn = document.getElementById('gsPlayAgainBtn');
  if (playAgainBtn) playAgainBtn.addEventListener('click', () => { state.screen = 'speedIntro'; render(); });

  const backToHub = document.getElementById('gsBackToHubBtn');
  if (backToHub) backToHub.addEventListener('click', () => { state.screen = 'landing'; render(); });

  wireSpeedInput();
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
  }, 1000);
}

function endSpeedRound() {
  clearInterval(speedTimerHandle);
  speedTimerHandle = null;
  state.screen = 'speedResults';
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
  if (input) { input.value = ''; }
  const suggestions = document.getElementById('gsSuggestions');
  if (suggestions) suggestions.innerHTML = '';

  const targetImg = document.getElementById('gsTargetImg');
  if (targetImg) targetImg.src = gsImgUrl(s.current);

  const topbar = document.querySelector('.gs-speed-topbar');
  const feedEl = document.getElementById('gsFeed');
  if (topbar) {
    const correctCount = s.feed.filter(f => f.ok).length;
    const points = Math.floor(correctCount / NAMES_PER_POINT);
    const progressInTier = correctCount % NAMES_PER_POINT;
    topbar.querySelector('.gs-speed-points').textContent = `${points} pt${points === 1 ? '' : 's'}`;
    topbar.querySelector('.gs-speed-progress').textContent = `${progressInTier}/${NAMES_PER_POINT} to next`;
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
