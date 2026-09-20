// ---------- Gameshow (WIP) ----------
// This whole page is the very first slice of a much bigger "Gameshow" mode
// (teams, host controls, quotes/trivia/screenshots rounds, hints, steals...)
// that's still being designed. For now this file only implements:
//   1. A password gate ("VANISVAN") in front of the real thing.
//   2. A standalone, single-player test harness for the "That Won't Be
//      Necessary" speed-naming minigame, reachable via a dev-only button
//      that bypasses the gate entirely so it can be iterated on before the
//      rest of the gameshow exists. Remove that button (search
//      "DEV TEST BUTTON" below) once the real gameshow is playable.
// No server/multiplayer wiring yet -- this is all local client state.

// Yellow theme, set directly on <body> (not just via CSS) so it applies
// reliably even in browsers without :has() support.
document.body.style.background = '#ffcc00';

const GS_PASSWORD = 'VANISVAN';

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
  screen: 'gate', // gate, hub, speedIntro, speedPlaying, speedResults
  passwordError: '',
  unlocked: false,
  speed: null // set by startSpeedRound()
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
  if (state.screen === 'gate') html = renderGate();
  else if (state.screen === 'hub') html = renderHub();
  else if (state.screen === 'speedIntro') html = renderSpeedIntro();
  else if (state.screen === 'speedPlaying') html = renderSpeedPlaying();
  else if (state.screen === 'speedResults') html = renderSpeedResults();
  gsRoot.innerHTML = html;
  attachHandlers();
}

function renderGate() {
  return `
    <div class="card center gs-gate-card">
      <p class="gs-wip-note">Sorry working on this &lt;3</p>
      <h2 class="gs-gate-title">Gameshow</h2>
      <p class="hint">This part of the site isn't open yet. If you know the code, go ahead.</p>
      <input type="text" id="gsPasswordInput" class="gs-password-input" placeholder="Enter code" autocomplete="off" autocapitalize="off" spellcheck="false" />
      <div class="error-msg">${state.passwordError}</div>
      <button type="button" class="primary" id="gsUnlockBtn">Enter</button>
    </div>
    <div class="card center gs-dev-card">
      <!-- DEV TEST BUTTON -- remove this whole .gs-dev-card block once the
           real gameshow (teams/host/rounds) is actually playable. This is
           purely so the speed-round minigame can be tried out standalone
           while everything else is still being built. -->
      <p class="hint">Dev-only, temporary:</p>
      <button type="button" class="secondary" id="gsDevTestBtn">🧪 Test: Speed Round</button>
    </div>
  `;
}

function renderHub() {
  return `
    <div class="card center">
      <h2 class="gs-gate-title">Gameshow</h2>
      <p class="hint">You're in. Most of this is still being built -- for now, here's the one piece that's ready to try.</p>
      <button type="button" class="primary" id="gsLaunchSpeedBtn">"That Won't Be Necessary" -- Speed Round</button>
    </div>
  `;
}

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
  const unlockBtn = document.getElementById('gsUnlockBtn');
  const pwInput = document.getElementById('gsPasswordInput');
  if (unlockBtn && pwInput) {
    const tryUnlock = () => {
      const val = pwInput.value.trim().toUpperCase();
      if (val === GS_PASSWORD) {
        state.unlocked = true;
        state.passwordError = '';
        state.screen = 'hub';
        render();
      } else {
        state.passwordError = "That's not it.";
        render();
        const again = document.getElementById('gsPasswordInput');
        if (again) again.focus();
      }
    };
    unlockBtn.addEventListener('click', tryUnlock);
    pwInput.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
  }

  const devBtn = document.getElementById('gsDevTestBtn');
  if (devBtn) devBtn.addEventListener('click', () => { state.screen = 'speedIntro'; render(); });

  const launchBtn = document.getElementById('gsLaunchSpeedBtn');
  if (launchBtn) launchBtn.addEventListener('click', () => { state.screen = 'speedIntro'; render(); });

  const backFromIntro = document.getElementById('gsBackFromIntroBtn');
  if (backFromIntro) backFromIntro.addEventListener('click', () => {
    state.screen = state.unlocked ? 'hub' : 'gate';
    render();
  });

  const startBtn = document.getElementById('gsStartSpeedBtn');
  if (startBtn) startBtn.addEventListener('click', startSpeedRound);

  const quitBtn = document.getElementById('gsQuitSpeedBtn');
  if (quitBtn) quitBtn.addEventListener('click', endSpeedRound);

  const playAgainBtn = document.getElementById('gsPlayAgainBtn');
  if (playAgainBtn) playAgainBtn.addEventListener('click', () => { state.screen = 'speedIntro'; render(); });

  const backToHub = document.getElementById('gsBackToHubBtn');
  if (backToHub) backToHub.addEventListener('click', () => {
    state.screen = state.unlocked ? 'hub' : 'gate';
    render();
  });

  wireSpeedInput();
}

// ---------- speed round logic ----------
let speedTimerHandle = null;

function gsNextTarget(s) {
  // Draw from a shuffled queue of the whole roster so nothing repeats until
  // everyone's been shown once, then reshuffle and keep going.
  if (!s.queue || s.queueIdx >= s.queue.length) {
    s.queue = gsShuffle(GS_CHARACTERS);
    s.queueIdx = 0;
  }
  const next = s.queue[s.queueIdx];
  s.queueIdx += 1;
  return next;
}

function startSpeedRound() {
  const s = {
    timeLeft: SPEED_ROUND_SECONDS,
    feed: [], // { name, ok, img }
    queue: [],
    queueIdx: 0,
    current: null
  };
  s.current = gsNextTarget(s);
  state.speed = s;
  state.screen = 'speedPlaying';
  render();
  const input = document.getElementById('gsSpeedInput');
  if (input) input.focus();

  clearInterval(speedTimerHandle);
  speedTimerHandle = setInterval(() => {
    state.speed.timeLeft -= 1;
    if (state.speed.timeLeft <= 0) {
      endSpeedRound();
      return;
    }
    // Only the timer number needs to live-update every tick -- re-rendering
    // the whole screen every second would also blow away whatever's
    // mid-type in the input. Patch just the timer text instead.
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
  // Substring match anywhere in the name (not just prefix) -- "van" should
  // surface "Van Arkride" AND "Kurt Vander"/"Mueller Vander".
  return GS_CHARACTERS.filter(c => c.name.toLowerCase().includes(q)).slice(0, 6);
}

// Checks the typed/picked name against the character currently on screen
// (not just "is this any known character" -- it has to be THIS one).
function gsSubmitGuess(guessedName) {
  const s = state.speed;
  if (!s || !s.current) return;
  const key = guessedName.trim().toLowerCase();
  if (!key) return;

  const target = s.current;
  const ok = key === target.name.toLowerCase();
  s.feed.push({ name: target.name, ok, img: gsImgUrl(target) });
  ok ? playTing() : playError();

  // Move on to the next character regardless of right/wrong -- that's what
  // keeps this a speed round rather than a stop-and-retry quiz.
  s.current = gsNextTarget(s);

  const input = document.getElementById('gsSpeedInput');
  if (input) { input.value = ''; }
  const suggestions = document.getElementById('gsSuggestions');
  if (suggestions) suggestions.innerHTML = '';

  // Patch the DOM directly instead of a full render() -- keeps focus in the
  // input and avoids losing keystrokes typed the instant after a guess lands.
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
      // If there's a dropdown showing, Enter always takes a suggestion --
      // the arrow-selected one if the player used the arrows, otherwise the
      // top one -- rather than submitting whatever's raw-typed so far.
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
