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
  comebackMode: false // true while playing the speed round AS the in-game comeback trigger
};

// ---------- speed round leaderboard (client-side, this browser only) ----------
const GS_LEADERBOARD_KEY = 'trailsGameshow_speedLeaderboard';
function loadLeaderboard() {
  try {
    const parsed = JSON.parse(localStorage.getItem(GS_LEADERBOARD_KEY));
    if (Array.isArray(parsed)) return parsed;
  } catch (e) { /* ignore malformed/missing data */ }
  return [];
}
function saveScoreToLeaderboard(name, points, correctCount) {
  const board = loadLeaderboard();
  board.push({ name: (name || 'Player').slice(0, 24), points, correctCount, date: Date.now() });
  board.sort((a, b) => (b.points - a.points) || (b.correctCount - a.correctCount));
  const trimmed = board.slice(0, 10);
  try { localStorage.setItem(GS_LEADERBOARD_KEY, JSON.stringify(trimmed)); } catch (e) { /* storage unavailable -- skip */ }
  return trimmed;
}

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
  attachHandlers();
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

    <div class="card center gs-dev-card">
      <!-- DEV TEST BUTTON -- remove once the real board is playable. Just a
           standalone way to try the speed-round minigame with no room. -->
      <p class="hint">Dev-only, temporary:</p>
      <button type="button" class="secondary" id="gsDevTestBtn">🧪 Test: Speed Round</button>
    </div>

    ${renderHowToPlayModal()}
  `;
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

      <div class="join-row gs-name-continue-row">
        <input type="text" id="gsAvatarNameInput" class="gs-password-input" placeholder="Your name" maxlength="24" value="${state.myName.replace(/"/g, '&quot;')}" autocomplete="off" />
        <button type="button" class="primary" id="gsConfirmAvatarBtn">Continue</button>
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
  const slots = [0, 1, 2].map(slotIdx => {
    const occ = members[slotIdx];
    const mine = occ && me && occ.id === me.id;
    const isEmpty = !occ;
    const tag = isEmpty ? 'button' : 'div';
    const attrs = isEmpty ? `type="button" data-join-team="${teamKey}" data-join-slot="${slotIdx}"` : '';
    return `
      <${tag} class="gs-podium ${isEmpty ? 'empty' : 'occupied'} ${mine ? 'mine' : ''} ${occ && occ.ready ? 'is-ready' : ''}" ${attrs}>
        <div class="gs-podium-avatar-wrap">
          ${occ ? `<div class="gs-podium-avatar" data-avatar-for="${occ.id}"></div>` : '<span class="gs-podium-plus">+</span>'}
        </div>
        <div class="gs-podium-block ${teamKey}"></div>
        <div class="gs-podium-name">${occ ? occ.name : ' '}</div>
      </${tag}>
    `;
  });
  return `<div class="gs-team-column ${teamKey}">${slots.join('')}</div>`;
}

function renderHostSlot() {
  const room = state.room;
  const me = myPlayer();
  const host = room.players.find(p => p.role === 'host');
  const mine = host && me && host.id === me.id;
  return `
    <div class="gs-host-slot ${host ? 'occupied' : 'empty'} ${mine ? 'mine' : ''}">
      <div class="gs-podium-avatar-wrap">
        ${host ? `<div class="gs-podium-avatar" data-avatar-for="${host.id}"></div>` : ''}
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

function renderNameColumn(team, label) {
  const room = state.room;
  const t = room[team];
  const me = myPlayer();
  const onThisTeam = me && me.role === team;
  const myVote = me ? t.votes[me.id] : undefined;
  const tally = {};
  Object.values(t.votes).forEach(idx => { tally[idx] = (tally[idx] || 0) + 1; });

  return `
    <div class="gs-team-card">
      <p class="gs-section-title">${label}</p>
      ${onThisTeam ? `
        <div class="join-row gs-name-submit-row">
          <input type="text" id="gsNameInput_${team}" placeholder="Suggest a team name" maxlength="30" />
          <button type="button" class="secondary gs-submit-name-btn" data-team="${team}">Submit</button>
        </div>
      ` : ''}
      <div class="gs-candidate-list">
        ${t.candidates.length ? t.candidates.map((c, idx) => `
          <div class="gs-candidate-row ${myVote === idx ? 'voted' : ''}">
            <span class="gs-candidate-text">"${c.text}" <span class="hint">by ${c.byName}</span></span>
            <span class="gs-candidate-votes">${tally[idx] || 0} vote${(tally[idx] || 0) === 1 ? '' : 's'}</span>
            ${onThisTeam ? `<button type="button" class="secondary gs-vote-btn" data-team="${team}" data-idx="${idx}">${myVote === idx ? 'Voted' : 'Vote'}</button>` : ''}
          </div>
        `).join('') : '<p class="hint">No suggestions yet.</p>'}
      </div>
    </div>
  `;
}

function everyoneVotedClient(room, team) {
  const t = room[team];
  if (!t.candidates.length) return false;
  const members = room.players.filter(p => p.role === team);
  return members.every(p => Object.prototype.hasOwnProperty.call(t.votes, p.id));
}

function renderScreenNaming() {
  const room = state.room;
  const me = myPlayer();
  const iAmHost = room.hostId === socket.id;
  // Competitors only see their own team's suggestions -- host and
  // spectators watch both live.
  const canSee = (team) => iAmHost || !me || me.role === 'spectator' || me.role === team;

  const cols = ['teamA', 'teamB'].map(team => {
    const label = team === 'teamA' ? 'Team A' : 'Team B';
    if (canSee(team)) return renderNameColumn(team, label);
    return `<div class="gs-team-card gs-hidden-col"><p class="gs-section-title">${label}</p><p class="hint">Only ${label} can see their own suggestions.</p></div>`;
  }).join('');

  const readyToLock = everyoneVotedClient(room, 'teamA') && everyoneVotedClient(room, 'teamB');

  return `
    <h3 class="gs-screen-title">Recommend a name for your Team</h3>
    <div class="gs-naming-cols">${cols}</div>
    ${iAmHost
      ? `<div class="center">
          <button type="button" class="primary" id="gsFinishNamingBtn" ${readyToLock ? '' : 'disabled'}>Lock In Team Names</button>
          ${readyToLock ? '' : '<p class="hint">Waiting for everyone on both teams to vote.</p>'}
        </div>`
      : `<p class="hint center-text">Waiting for the host to lock in the names...</p>`}
  `;
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

function teamLabel(team) {
  const room = state.room;
  if (!room) return team;
  return room[team] && room[team].name ? room[team].name : (team === 'teamA' ? 'Team A' : 'Team B');
}

function otherTeam(team) { return team === 'teamA' ? 'teamB' : 'teamA'; }

function renderScoreboard() {
  const room = state.room;
  const iAmHost = room.hostId === socket.id;
  const block = (team) => `
    <div class="gs-score-block ${team}">
      <span class="gs-score-label">${teamLabel(team)} <span class="gs-hint-inline" title="Hints remaining">💡${room.board.hints[team]}</span></span>
      <span class="gs-score-value">${room.board.scores[team]}</span>
      ${iAmHost ? `<button type="button" class="gs-hint-mini-btn" data-hint-team="${team}" ${room.board.hints[team] <= 0 ? 'disabled' : ''} title="Give ${teamLabel(team)} a hint">+Hint</button>` : ''}
    </div>
  `;
  return `<div class="gs-scoreboard">${block('teamA')}${block('teamB')}</div>`;
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

function renderTurnBanner(active, viewerKind) {
  if (viewerKind === 'spectator') return ''; // spectators just watch -- no turn/timer clutter
  if (active.stage !== 'answering') return '';
  const secs = Math.max(0, Math.ceil((active.deadline - Date.now()) / 1000));
  return `<p class="gs-turn-banner">${teamLabel(active.turnTeam)}'s turn: <span id="gsTurnTimer">${secs}s</span></p>`;
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
    return `<div class="gs-host-hint"><p class="gs-host-hint-label">HOST ONLY: Answer</p><img class="gs-cell-screenshot small" src="${active.content.answer}" alt="Answer" /></div>`;
  }
  return '';
}

function renderAnswerArea(iAmHost, active) {
  const me = myPlayer();
  const turnTeam = active.turnTeam;
  const isMyTurnTeam = me && me.role === turnTeam;
  let box;
  if (active.stage === 'answering' && !active.timedOut) {
    if (active.turnLocked) {
      box = `<p class="gs-locked-answer">${teamLabel(turnTeam)} locked in an answer. Waiting on the host.</p>`;
    } else if (isMyTurnTeam) {
      box = `<div class="join-row"><input type="text" id="gsAnswerInput" maxlength="200" placeholder="Your team's answer" /><button type="button" class="secondary" id="gsSubmitAnswerBtn">Submit</button></div>`;
    } else {
      box = `<p class="hint">Waiting on ${teamLabel(turnTeam)}...</p>`;
    }
  } else if (active.timedOut) {
    box = `<p class="gs-judge-result wrong">Time ran out. No answer given.</p>`;
  } else {
    box = `<p class="gs-locked-answer">"${active.turnAnswer}"</p>`;
    if (active.turnJudged) {
      box += `<p class="gs-judge-result ${active.turnJudged}">${active.turnJudged === 'correct' ? '✅ Correct' : '❌ Wrong'}</p>`;
    } else if (iAmHost) {
      box += `<div class="gs-judge-btns"><button type="button" class="secondary gs-small-btn" id="gsJudgeCorrectBtn">Correct</button><button type="button" class="secondary gs-small-btn" id="gsJudgeWrongBtn">Wrong</button></div>`;
    }
  }
  return `<div class="gs-answer-block"><p class="gs-section-title">${teamLabel(turnTeam)}</p>${box}</div>`;
}

function renderStealArea(iAmHost, active) {
  const me = myPlayer();
  if (active.stage !== 'revealed') return '';
  const canOffer = iAmHost && !active.stealTeam && (active.turnJudged === 'wrong' || active.turnJudged === 'timeout');
  if (canOffer) {
    const stealTeam = otherTeam(active.turnTeam);
    return `<div class="center" style="margin-top:10px;"><button type="button" class="secondary gs-small-btn" id="gsOfferStealBtn">Offer Steal to ${teamLabel(stealTeam)}</button></div>`;
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
      ? `<p class="gs-judge-result ${active.stealJudged}">${active.stealJudged === 'correct' ? '✅ Stole it!' : `❌ Wrong. Loses ${Math.floor(active.value / 2)} pts.`}</p>`
      : iAmHost ? `<div class="gs-judge-btns"><button type="button" class="secondary gs-small-btn" id="gsJudgeStealCorrect">Correct</button><button type="button" class="secondary gs-small-btn" id="gsJudgeStealWrong">Wrong</button></div>` : '');
  }
  return `<div class="gs-steal-block"><p class="gs-section-title">Steal: ${teamLabel(active.stealTeam)}</p>${inner}</div>`;
}

function renderActiveCellPanel(iAmHost) {
  const room = state.room;
  const active = room.board.active;
  const me = myPlayer();
  const viewerKind = iAmHost ? 'host' : (me && (me.role === 'teamA' || me.role === 'teamB') ? 'competitor' : 'spectator');
  const promptHtml = active.column === 'screenshots'
    ? `<img class="gs-cell-screenshot" src="${active.content.hint}" alt="Screenshot hint" />`
    : `<p class="gs-cell-prompt">${active.column === 'quotes' ? `"${active.content.text}"` : active.content.question}</p>`;

  // Spectators (and, by extension, anyone just watching) get the bare
  // minimum: category, prompt, one line of status. No boxes, no controls.
  if (viewerKind === 'spectator') {
    return `
      <div class="gs-active-cell">
        <p class="gs-cell-value">$${active.value}: ${COLUMN_LABELS[active.column] || 'Bonus'}</p>
        ${promptHtml}
        <p class="gs-status-line">${spectatorStatusLine(active)}</p>
      </div>
    `;
  }

  const canClose = active.turnJudged === 'correct' || (active.turnJudged && (!active.stealTeam || active.stealJudged));

  return `
    <div class="gs-active-cell">
      <p class="gs-cell-value">$${active.value}: ${COLUMN_LABELS[active.column] || 'Bonus'}</p>
      ${renderTurnBanner(active, viewerKind)}
      ${promptHtml}
      ${iAmHost ? renderHostHint(active) : ''}
      ${renderAnswerArea(iAmHost, active)}
      ${renderStealArea(iAmHost, active)}
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

function renderComebackArea(iAmHost) {
  const room = state.room;
  const cb = room.board.comeback;
  if (cb) {
    if (cb.stage === 'announcing') {
      return `
        <div class="gs-comeback-banner">
          <p class="gs-comeback-title">🎤 That Won't Be Necessary!</p>
          <p>${cb.playerName} (${teamLabel(cb.team)}) is about to attempt the comeback round...</p>
          ${iAmHost ? `<button type="button" class="primary gs-small-btn" id="gsBeginComebackBtn">Begin Round</button>` : `<p class="hint">Waiting for the host to start it.</p>`}
        </div>
      `;
    }
    if (cb.stage === 'active') {
      const live = cb.live || { points: 0, img: null };
      return `
        <div class="gs-comeback-banner">
          <p class="gs-comeback-title">🎤 ${cb.playerName} is attempting the comeback round for ${teamLabel(cb.team)}!</p>
          ${live.img ? `<img class="gs-comeback-live-img" src="${live.img}" alt="" />` : ''}
          <p class="gs-comeback-live-score">${live.points} pt${live.points === 1 ? '' : 's'} so far</p>
        </div>
      `;
    }
    return `
      <div class="gs-comeback-banner">
        <p>${cb.playerName} scored <strong>${cb.points}</strong> point${cb.points === 1 ? '' : 's'} for ${teamLabel(cb.team)} in the comeback round!</p>
        ${iAmHost ? `<button type="button" class="secondary gs-small-btn" id="gsClearComebackBtn">Dismiss</button>` : ''}
      </div>
    `;
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

function renderScreenBoard() {
  const room = state.room;
  const iAmHost = room.hostId === socket.id;
  if (room.phase === 'finished') {
    const winner = room.board.scores.teamA === room.board.scores.teamB ? null : (room.board.scores.teamA > room.board.scores.teamB ? 'teamA' : 'teamB');
    return `
      ${renderScoreboard()}
      <h3 class="gs-screen-title">Game Over!</h3>
      <p class="gs-screen-status">${winner ? `${teamLabel(winner)} wins!` : "It's a tie!"}</p>
      ${iAmHost ? `<div class="center"><button type="button" class="primary" id="gsReplayGameBtn">Play Again (New Board)</button></div>` : ''}
    `;
  }
  return `
    ${renderScoreboard()}
    ${renderComebackArea(iAmHost)}
    ${room.board.active ? renderActiveCellPanel(iAmHost) : renderBoardGrid(iAmHost)}
    ${!room.board.active && !room.board.comeback ? renderPhoneRow(iAmHost) : ''}
  `;
}

function renderStage() {
  const room = state.room;
  let screenInner = '';
  if (room.phase === 'naming') screenInner = renderScreenNaming();
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

    ${iAmHost && room.phase === 'lobby' ? `
      <div class="center">
        <button type="button" class="primary" id="gsStartNamingBtn" ${canStartNaming ? '' : 'disabled'}>Start Team Naming</button>
      </div>
    ` : ''}

    <div class="center gs-bottom-row">
      ${iAmCompetitor && room.phase === 'lobby' ? `
        <button type="button" class="secondary gs-small-btn ${me.ready ? 'is-ready' : ''}" id="gsReadyToggleBtn">${me.ready ? '✅ Ready' : 'Ready'}</button>
      ` : ''}
      <button type="button" class="secondary gs-small-btn gs-leave-btn" id="gsLeaveRoomBtn">Leave Room</button>
    </div>

    ${renderHostModal()}
  `;
}

// ---------- standalone speed-round test harness (unchanged mechanic) ----------
const SPEED_ROUND_SECONDS = 60;
const NAMES_PER_POINT = 5;
const POINTS_PER_TIER = 100; // each tier of 5 correct names is worth 100 game points

function renderLeaderboard() {
  const board = loadLeaderboard();
  if (!board.length) return '<p class="hint">No scores yet. Be the first!</p>';
  return `
    <ol class="gs-leaderboard-list">
      ${board.map(entry => `<li><span class="gs-leaderboard-name">${entry.name}</span><span class="gs-leaderboard-points">${entry.points} pt${entry.points === 1 ? '' : 's'}</span></li>`).join('')}
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
      <p class="gs-section-title">Leaderboard (this browser)</p>
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
      <p class="gs-section-title">Leaderboard (this browser)</p>
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
  if (devBtn) devBtn.addEventListener('click', () => { state.screen = 'speedIntro'; render(); });

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
      socket.emit('gsRerollCell', { cellId: btn.dataset.rerollCell }, (res) => {
        if (!res.ok) showGsNotice(res.error || "Couldn't swap that question.");
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

  const offerStealBtn = document.getElementById('gsOfferStealBtn');
  if (offerStealBtn) offerStealBtn.addEventListener('click', () => {
    const room = state.room;
    const active = room.board.active;
    socket.emit('gsOpenSteal', { team: otherTeam(active.turnTeam) }, (res) => {
      if (!res.ok) showGsNotice(res.error || "Couldn't offer steal.");
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
    const points = Math.floor(correctCount / NAMES_PER_POINT) * POINTS_PER_TIER;
    saveScoreToLeaderboard(name, points, correctCount);
    s.savedToLeaderboard = true;
    render();
  });

  const playAgainBtn = document.getElementById('gsPlayAgainBtn');
  if (playAgainBtn) playAgainBtn.addEventListener('click', () => { state.screen = 'speedIntro'; render(); });

  const backToHub = document.getElementById('gsBackToHubBtn');
  if (backToHub) backToHub.addEventListener('click', () => { state.screen = 'landing'; render(); });

  wireSpeedInput();
  wireTurnTimer();
}

// ---------- live 60s turn countdown (board) ----------
let turnTimerHandle = null;
function wireTurnTimer() {
  clearInterval(turnTimerHandle);
  turnTimerHandle = null;
  const room = state.room;
  if (!room || !room.board || !room.board.active || room.board.active.stage !== 'answering') return;
  const tick = () => {
    const r = state.room;
    if (!r || !r.board || !r.board.active || r.board.active.stage !== 'answering') { clearInterval(turnTimerHandle); return; }
    const remaining = Math.max(0, Math.ceil((r.board.active.deadline - Date.now()) / 1000));
    const el = document.getElementById('gsTurnTimer');
    if (el) el.textContent = remaining + 's';
    if (remaining <= 0) clearInterval(turnTimerHandle);
  };
  tick();
  turnTimerHandle = setInterval(tick, 500);
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
