const firebaseConfig = {
  apiKey: "AIzaSyB4oGsOWnIruvGI0pij9K8yv8b-YRnva98",
  authDomain: "kiseki-guess-who.firebaseapp.com",
  databaseURL: "https://kiseki-guess-who-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "kiseki-guess-who",
  storageBucket: "kiseki-guess-who.firebasestorage.app",
  messagingSenderId: "728571863195",
  appId: "1:728571863195:web:ec5e84d41cdd0b2092a63e"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// Character list and images are shared with Trails Heads Up -- one list to
// maintain instead of two. IDs are generated from each name since Heads Up's
// data doesn't have its own id field, only name/tag/image.
let CHARACTERS = [];
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
// Characters excluded from Guess Who specifically -- Heads Up still uses the
// full shared list untouched, this only filters what shows up here.
const EXCLUDED_FROM_GUESSWHO = new Set(['Olaf Craig']);

async function loadCharacters() {
  const res = await fetch('data/characters.json');
  const data = await res.json();
  CHARACTERS = data
    .filter(c => !EXCLUDED_FROM_GUESSWHO.has(c.name))
    .map(c => ({ id: slugify(c.name), name: c.name, img: c.image }));
}

function imgUrl(c){ return 'assets/items/characters/' + encodeURIComponent(c.img); }

function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

const BOARD_SIZE = 32;

function buildBoardWithSecrets(secretIds){
  const uniqueSecrets = [...new Set(secretIds)];
  const others = CHARACTERS.map(c=>c.id).filter(id=>!uniqueSecrets.includes(id));
  const fillCount = Math.max(0, BOARD_SIZE - uniqueSecrets.length);
  const fill = shuffle(others).slice(0, fillCount);
  return shuffle([...uniqueSecrets, ...fill]);
}

function boardChars(){
  if(!state.room || !state.room.boardIds) return [];
  return state.room.boardIds.map(id=>CHARACTERS.find(c=>c.id===id)).filter(Boolean);
}

function genCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s='';
  for(let i=0;i<4;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function genId(){ return 'p_'+Math.random().toString(36).slice(2,10); }

const gwRoot = document.getElementById('gwRoot');

// Small top-of-page toast, mirroring Heads Up's showNotice, for things like
// the placeholder "instructions coming soon" message until real how-to-play
// content is added for this game.
function showGwNotice(text){
  const bar = document.getElementById('gwNoticeBar');
  if(!bar) return;
  const toast = document.createElement('div');
  toast.className = 'notice-toast';
  toast.textContent = text;
  bar.appendChild(toast);
  setTimeout(()=>{ toast.remove(); }, 4500);
}

let state = {
  screen:'home',
  code:null,
  playerId:genId(),
  playerName:'',
  room:null,
  isSpectator:false,
  eliminated:new Set(),
  search:'',
  pickSelection:null,
  guessSelection:null,
  guessPanelOpen:false,
  guessSearch:'',
  guessResult:null,
  confettiPlayed:false,
  error:'',
  watchError:'',
  loading:false,
  hadFullRoom:false
};

let roomRef = null;

function attachRoomListener(code){
  if(roomRef) roomRef.off();
  roomRef = db.ref('rooms/' + code);
  roomRef.on('value', snap=>{
    const room = snap.val();
    const playerCount = room && room.players ? Object.keys(room.players).length : 0;
    if(playerCount>=2) state.hadFullRoom = true;
    // Someone who was there is gone -- either they hit Leave Room or their
    // connection dropped (onDisconnect cleans up their slot automatically in
    // that case too). Only fire once, and not while just sitting on the home
    // screen or already looking at this same notice.
    if(state.hadFullRoom && playerCount<2 && state.screen!=='home' && state.screen!=='opponentLeft'){
      state.room = room;
      state.screen = 'opponentLeft';
      render();
      return;
    }
    if(room){
      state.room = room;
      syncScreen();
      render();
    }
  });
}

function detachRoomListener(){
  if(roomRef){ roomRef.off(); roomRef=null; }
}

function syncScreen(){
  const room = state.room;
  if(!room || !state.code) return;
  if(state.screen==='home') return;
  if(room.status==='lobby'){
    state.screen='lobby';
  }else if(room.status==='picking'){
    if(state.screen==='game'){
      state.eliminated = new Set();
      state.pickSelection = null;
      state.guessPanelOpen = false;
      state.guessSearch = '';
      state.search = '';
      state.guessResult = null;
      state.confettiPlayed = false;
    }
    state.screen='pick';
  }else if(room.status==='playing' || room.status==='over'){
    state.screen='game';
  }
}

function myPlayer(){
  if(!state.room || !state.room.players) return null;
  return state.room.players[state.playerId] || null;
}
function oppPlayer(){
  if(!state.room || !state.room.players) return null;
  const entries = Object.entries(state.room.players);
  const found = entries.find(([id])=>id!==state.playerId);
  return found ? found[1] : null;
}

async function createRoom(){
  if(!state.playerName.trim()){ state.error='Enter your name first'; render(); return; }
  state.error=''; state.loading=true; render();
  const code = genCode();
  const room = {
    code,
    status:'lobby',
    boardIds: null,
    players:{
      [state.playerId]: { name: state.playerName.trim(), avatar: JSON.parse(JSON.stringify(avatar)), secret: null }
    },
    winner:null
  };
  await db.ref('rooms/' + code).set(room);
  // If this tab closes, crashes, or loses connection without a clean Leave
  // Room click, Firebase's own server-side hook removes this player's slot
  // automatically -- that's what lets the other player find out even if we
  // never got the chance to say goodbye ourselves.
  db.ref('rooms/' + code + '/players/' + state.playerId).onDisconnect().remove();
  state.code=code; state.room=room; state.screen='lobby'; state.loading=false;
  attachRoomListener(code);
  render();
}

async function joinRoom(codeInput){
  const code = codeInput.trim().toUpperCase();
  if(!state.playerName.trim()){ state.error='Enter your name first'; render(); return; }
  if(!code){ state.error='Enter a room code'; render(); return; }
  state.error=''; state.loading=true; render();
  const snap = await db.ref('rooms/' + code).get();
  const room = snap.val();
  if(!room){ state.error='Room not found'; state.loading=false; render(); return; }
  const players = room.players || {};
  const playerCount = Object.keys(players).length;
  if(playerCount>=2 && !players[state.playerId]){
    state.error='That room is full'; state.loading=false; render(); return;
  }
  if(!players[state.playerId]){
    players[state.playerId] = { name: state.playerName.trim(), avatar: JSON.parse(JSON.stringify(avatar)), secret: null };
  }
  room.players = players;
  if(Object.keys(players).length===2 && room.status==='lobby'){
    room.status='picking';
  }
  await db.ref('rooms/' + code).set(room);
  db.ref('rooms/' + code + '/players/' + state.playerId).onDisconnect().remove();
  state.code=code; state.room=room; state.loading=false;
  state.screen='lobby';
  syncScreen();
  attachRoomListener(code);
  render();
}

// A third (or later) person can't join a 2-player Guess Who match, but they
// can watch it live -- read-only, both players' secrets visible, no picking
// or guessing controls. This never writes into room.players.
async function watchRoom(codeInput){
  const code = codeInput.trim().toUpperCase();
  if(!code){ state.watchError='Enter a room code'; render(); return; }
  state.watchError=''; state.loading=true; render();
  const snap = await db.ref('rooms/' + code).get();
  const room = snap.val();
  if(!room){ state.watchError='Room not found'; state.loading=false; render(); return; }
  state.code=code; state.room=room; state.isSpectator=true; state.loading=false;
  state.screen='lobby';
  syncScreen();
  attachRoomListener(code);
  render();
}

function selectPick(charId){
  if(state.isSpectator) return;
  const me = myPlayer();
  if(me && me.secret) return;
  state.pickSelection = state.pickSelection===charId ? null : charId;
  render();
}

async function lockInPick(){
  if(state.isSpectator) return;
  const room = state.room;
  const me = myPlayer();
  if(!room || !me || me.secret || !state.pickSelection) return;
  const charId = state.pickSelection;
  await db.ref('rooms/' + state.code + '/players/' + state.playerId + '/secret').set(charId);
  const players = room.players || {};
  players[state.playerId].secret = charId;
  const allPicked = Object.keys(players).length===2 && Object.values(players).every(p=>p.secret);
  if(allPicked){
    const secretIds = Object.values(players).map(p=>p.secret);
    const boardIds = buildBoardWithSecrets(secretIds);
    await db.ref('rooms/' + state.code).update({ status:'playing', boardIds });
  }
}

function toggleFlip(charId){
  if(state.isSpectator) return;
  if(state.eliminated.has(charId)) state.eliminated.delete(charId);
  else state.eliminated.add(charId);
  render();
}

function toggleGuessPanel(){
  if(state.isSpectator) return;
  state.guessPanelOpen = !state.guessPanelOpen;
  state.guessResult = null;
  if(!state.guessPanelOpen){ state.guessSearch=''; }
  render();
}

async function guessChar(charId){
  if(state.isSpectator) return;
  const room = state.room;
  const opp = oppPlayer();
  if(!room || !opp || room.status==='over') return;
  if(charId===opp.secret){
    await db.ref('rooms/' + state.code).update({ status:'over', winner:state.playerId });
    state.guessPanelOpen = false;
    state.guessResult = null;
  }else{
    state.guessResult = 'miss';
    render();
  }
}

async function requestRematch(){
  if(state.isSpectator || !state.code) return;
  await db.ref('rooms/' + state.code + '/rematch').set({ requestedBy: state.playerId });
}

async function respondRematch(accept){
  if(state.isSpectator) return;
  const room = state.room;
  if(!room || !state.code) return;
  if(accept){
    const playerIds = Object.keys(room.players || {});
    const updates = { status:'picking', boardIds:null, winner:null, rematch:null };
    playerIds.forEach(id=>{ updates['players/'+id+'/secret'] = null; });
    await db.ref('rooms/' + state.code).update(updates);
  }else{
    await db.ref('rooms/' + state.code + '/rematch').remove();
  }
}

function launchConfetti(){
  const colors = ['#7f77dd','#1d9e75','#ef9f27','#e24b4a','#378add','#d4537e'];
  const container = document.createElement('div');
  container.style.position='fixed';
  container.style.top='0';
  container.style.left='0';
  container.style.width='100%';
  container.style.height='100%';
  container.style.pointerEvents='none';
  container.style.overflow='hidden';
  container.style.zIndex='999';
  for(let i=0;i<70;i++){
    const piece = document.createElement('div');
    const size = 6 + Math.random()*6;
    piece.style.position='absolute';
    piece.style.width=size+'px';
    piece.style.height=(size*1.6)+'px';
    piece.style.background=colors[Math.floor(Math.random()*colors.length)];
    piece.style.left=(Math.random()*100)+'%';
    piece.style.top='-20px';
    piece.style.opacity='0.9';
    piece.style.borderRadius='1px';
    const duration = 2.2 + Math.random()*1.6;
    const delay = Math.random()*0.4;
    const rotation = 360 + Math.random()*720;
    piece.style.animation = `confettiFall ${duration}s ease-in ${delay}s forwards`;
    piece.style.setProperty('--rot', rotation+'deg');
    container.appendChild(piece);
  }
  document.body.appendChild(container);
  setTimeout(()=>{ container.remove(); }, 4200);
}

async function leaveRoom(){
  if(state.code && !state.isSpectator){
    const playerRef = db.ref('rooms/' + state.code + '/players/' + state.playerId);
    try {
      await playerRef.onDisconnect().cancel();
      await playerRef.remove();
    } catch(e) { /* best effort -- if this fails, onDisconnect still cleans it up */ }
  }
  detachRoomListener();
  state = {
    screen:'home', code:null, playerId:genId(), playerName:state.playerName,
    room:null, isSpectator:false, eliminated:new Set(), search:'', pickSelection:null,
    guessSelection:null, guessPanelOpen:false, guessSearch:'', guessResult:null,
    error:'', watchError:'', loading:false, hadFullRoom:false
  };
  render();
}

function filteredFullChars(searchVal){
  if(!searchVal.trim()) return CHARACTERS;
  const q = searchVal.trim().toLowerCase();
  return CHARACTERS.filter(c=>c.name.toLowerCase().includes(q));
}

function filteredBoardChars(searchVal){
  const board = boardChars();
  const s = searchVal !== undefined ? searchVal : state.search;
  if(!s.trim()) return board;
  const q = s.trim().toLowerCase();
  return board.filter(c=>c.name.toLowerCase().includes(q));
}

function renderOpponentLeft(){
  return `
    <div class="card center">
      <p class="gameover-title" style="margin-top:0;">Your opponent left the room</p>
      <p class="hint" style="margin-bottom:18px;">The match can't continue without them.</p>
      <button type="button" class="secondary" id="leaveBtn">Return to Main Menu</button>
    </div>
  `;
}

function renderHome(){
  // Reuses Heads Up's own card/avatar-stage/arrow-row/dice-btn/button classes
  // (defined, unscoped, in style.css) so this looks and behaves exactly like
  // Heads Up's home screen -- same sprites, same shared avatar state, same
  // rounded colorful buttons -- just recolored to the purple Guess Who theme
  // via #app-guesswho overrides in guesswho.css.
  return `
    <div class="card">
      <label>Your avatar</label>
      <div class="avatar-stage" id="gwAvatarStage"></div>
      <div class="arrow-row">
        <button type="button" data-gwlayer="hat" data-gwdir="-1">&lt;</button>
        <span class="layer-label">Accessories</span>
        <button type="button" data-gwlayer="hat" data-gwdir="1">&gt;</button>
      </div>
      <div class="arrow-row">
        <button type="button" data-gwlayer="face" data-gwdir="-1">&lt;</button>
        <span class="layer-label">Face</span>
        <button type="button" data-gwlayer="face" data-gwdir="1">&gt;</button>
      </div>
      <div class="arrow-row">
        <button type="button" data-gwlayer="base" data-gwdir="-1">&lt;</button>
        <span class="layer-label">Color</span>
        <button type="button" data-gwlayer="base" data-gwdir="1">&gt;</button>
      </div>
      <button type="button" class="dice-btn" id="gwDiceBtn">Randomize</button>
    </div>

    <div class="card">
      <input id="nameInput" type="text" placeholder="Your name" value="${state.playerName.replace(/"/g,'&quot;')}" maxlength="20" />
      <button type="button" class="primary" id="createBtn">Create a Room</button>
      <div class="error-msg">${state.error}</div>
    </div>

    <div class="card">
      <p><strong>Join a game</strong></p>
      <div class="join-row">
        <input id="codeInput" type="text" placeholder="ROOM CODE" maxlength="4" />
        <button type="button" class="secondary" id="joinBtn">Join Room</button>
      </div>
    </div>

    <div class="card">
      <p><strong>Watch a game</strong></p>
      <p class="subtitle" style="margin:-4px 0 12px; font-size:0.85rem;">Can't join a match that already has two players, but you can watch it live.</p>
      <div class="join-row">
        <input id="watchCodeInput" type="text" placeholder="ROOM CODE" maxlength="4" />
        <button type="button" class="secondary" id="watchBtn">Watch</button>
      </div>
      <div class="error-msg">${state.watchError}</div>
    </div>
  `;
}

function renderLobby(){
  const players = state.room && state.room.players ? Object.entries(state.room.players) : [];
  const playerChips = players.map(([pid, p])=>`
    <div class="lobby-player-chip">
      <div class="avatar-stage avatar-stage-mini" id="gwLobbyAvatar_${pid}"></div>
      <span>${p.name}${pid===state.playerId ? ' (you)' : ''}</span>
    </div>
  `).join('');
  return `
    <div class="card center">
      ${state.isSpectator ? '<p class="hint">You are spectating this room</p>' : '<p class="hint">Share this code with your friend</p>'}
      <div class="code-display">${state.code}</div>
      <div class="lobby-player-row">${playerChips}</div>
      <p class="status-line">Waiting for opponent to join${players.length<2?'<span class="spinner"></span>':''}</p>
      <div style="margin-top:16px"><button type="button" class="secondary" id="leaveBtn">${state.isSpectator ? 'Stop Watching' : 'Leave Room'}</button></div>
    </div>
  `;
}

function renderPick(){
  const me = myPlayer();
  const opp = oppPlayer();

  if(state.isSpectator){
    const entries = state.room && state.room.players ? Object.values(state.room.players) : [];
    return `
      <div class="card">
        <p class="panel-title"><span>Both players are picking a secret character</span></p>
        ${entries.map(p=>`<p class="status-line">${p.name}: ${p.secret ? 'Locked in' : 'Still choosing'}${p.secret ? '' : '<span class="spinner"></span>'}</p>`).join('')}
        <div style="margin-top:16px; text-align:center;"><button type="button" class="secondary" id="leaveBtn">Stop Watching</button></div>
      </div>
    `;
  }

  const picked = me && me.secret;
  const pickedChar = picked ? CHARACTERS.find(c=>c.id===me.secret) : null;
  const chars = filteredFullChars(state.search);
  return `
    <div class="card">
      <p class="panel-title">
        <span>Pick your secret character (${CHARACTERS.length} total)</span>
        <span class="pill ${picked?'you':''}">${picked ? 'Locked in' : 'Choose, then lock in'}</span>
      </p>
      ${picked ? `
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:14px;">
          <img class="secret-portrait" src="${imgUrl(pickedChar)}" alt="${pickedChar.name}" />
          <div>
            <p style="margin:0; font-weight:600;">${pickedChar.name}</p>
            <p class="hint" style="margin:2px 0 0;">This is your secret character. Keep it hidden!</p>
          </div>
        </div>
      ` : `
        <div class="search-row"><input id="searchInput" type="text" placeholder="Search a name..." value="${state.search.replace(/"/g,'&quot;')}" /></div>
        <div class="grid">
          ${chars.map(c=>`
            <div class="card-tile ${state.pickSelection===c.id ? 'selected':''}" data-pick="${c.id}">
              <img src="${imgUrl(c)}" alt="${c.name}" loading="lazy" />
              <div class="cname">${c.name}</div>
            </div>
          `).join('')}
        </div>
        <div class="row" style="align-items:center; margin-top:12px">
          <div class="hint" style="flex:2">${state.pickSelection ? 'Selected: '+CHARACTERS.find(c=>c.id===state.pickSelection).name : 'Tap a character to select it'}</div>
          <button type="button" id="lockInBtn" ${!state.pickSelection?'disabled':''} style="flex:1">Lock in</button>
        </div>
      `}
      <p class="status-line">${opp ? (opp.secret ? opp.name+' has locked in their character' : opp.name+' is still choosing'+'<span class="spinner"></span>') : ''}</p>
    </div>
  `;
}

function renderGameOver(){
  const room = state.room;
  const players = room.players ? Object.values(room.players) : [];
  const me = myPlayer();
  const opp = oppPlayer();

  if(state.isSpectator){
    const winnerEntry = room.players ? Object.entries(room.players).find(([id])=>id===room.winner) : null;
    const winnerName = winnerEntry ? winnerEntry[1].name : 'Someone';
    return `
      <div class="card gameover-screen">
        <div class="gameover-icon">🏆</div>
        <p class="gameover-title">${winnerName} wins!</p>
        <div class="reveal-row">
          ${players.map(p=>{
            const c = p.secret ? CHARACTERS.find(x=>x.id===p.secret) : null;
            return `
              <div class="reveal-item">
                <p class="reveal-label">${p.name}'s character</p>
                ${c ? `<img src="${imgUrl(c)}" alt="${c.name}" />` : ''}
                <p class="reveal-name">${c ? c.name : ''}</p>
              </div>
            `;
          }).join('')}
        </div>
        <div style="margin-top:14px;"><button type="button" class="secondary" id="leaveBtn">Stop Watching</button></div>
      </div>
    `;
  }

  const iWon = room.winner===state.playerId;
  const mySecretChar = me && me.secret ? CHARACTERS.find(c=>c.id===me.secret) : null;
  const oppSecretChar = opp && opp.secret ? CHARACTERS.find(c=>c.id===opp.secret) : null;
  const rematch = room.rematch;
  const iRequested = rematch && rematch.requestedBy===state.playerId;
  const theyRequested = rematch && opp && rematch.requestedBy!==state.playerId;

  let rematchSection = '';
  if(theyRequested){
    rematchSection = `
      <p class="hint" style="margin-bottom:10px;">${opp.name} wants to play again</p>
      <div class="row">
        <button type="button" id="acceptRematchBtn">Yes, rematch</button>
        <button type="button" class="secondary" id="declineRematchBtn">No thanks</button>
      </div>
    `;
  }else if(iRequested){
    rematchSection = `<p class="status-line">Waiting for ${opp ? opp.name : 'opponent'} to respond${'<span class="spinner"></span>'}</p>`;
  }else{
    rematchSection = `<button type="button" id="rematchBtn" style="width:100%">Play again</button>`;
  }

  return `
    <div class="card gameover-screen">
      <div class="gameover-icon">${iWon ? '🏆' : '🔎'}</div>
      <p class="gameover-title">${iWon ? 'You win!' : (opp ? opp.name+' wins!' : 'Game over')}</p>
      <p class="gameover-sub">${iWon ? 'Nice deducing.' : 'Better luck next round.'}</p>
      <div class="reveal-row">
        <div class="reveal-item">
          <p class="reveal-label">Your character</p>
          ${mySecretChar ? `<img src="${imgUrl(mySecretChar)}" alt="${mySecretChar.name}" />` : ''}
          <p class="reveal-name">${mySecretChar ? mySecretChar.name : ''}</p>
        </div>
        <div class="reveal-item">
          <p class="reveal-label">${opp ? opp.name+"'s character" : "Opponent's character"}</p>
          ${oppSecretChar ? `<img src="${imgUrl(oppSecretChar)}" alt="${oppSecretChar.name}" />` : ''}
          <p class="reveal-name">${oppSecretChar ? oppSecretChar.name : ''}</p>
        </div>
      </div>
      ${rematchSection}
      <div style="margin-top:14px;"><button type="button" class="secondary" id="leaveBtn">Leave Room</button></div>
    </div>
  `;
}

function renderGame(){
  const room = state.room;
  const over = room && room.status==='over';
  if(over) return renderGameOver();

  const board = filteredBoardChars();

  if(state.isSpectator){
    const players = room.players ? Object.values(room.players) : [];
    return `
      <div class="game">
        <div class="id-row">
          ${players.map(p=>{
            const c = p.secret ? CHARACTERS.find(x=>x.id===p.secret) : null;
            return `
              <div class="id-card">
                ${c ? `<img class="id-photo" src="${imgUrl(c)}" alt="${c.name}" />` : `<div class="id-silhouette">?</div>`}
                <p class="id-label">${c ? c.name : ''}</p>
                <p class="id-sub">${p.name}'s character</p>
              </div>
            `;
          }).join('')}
        </div>

        <div class="card">
          <p class="panel-title"><span>Board (view only while spectating)</span></p>
          <div class="grid">
            ${board.map(c=>`
              <div class="card-tile">
                <div class="img-wrap">
                  <img src="${imgUrl(c)}" alt="${c.name}" loading="lazy" />
                </div>
                <div class="cname">${c.name}</div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="center">
          <button type="button" class="secondary" id="leaveBtn">Stop Watching</button>
        </div>
      </div>
    `;
  }

  const me = myPlayer();
  const opp = oppPlayer();
  const mySecretChar = me && me.secret ? CHARACTERS.find(c=>c.id===me.secret) : null;

  const guessPanel = state.guessPanelOpen ? `
    <div class="card" style="border-color:var(--accent);">
      <p class="panel-title">
        <span>Guess the character (search the ${BOARD_SIZE} on the board)</span>
        <button type="button" class="secondary" id="closeGuessBtn" style="padding:4px 10px; font-size:12px;">Close</button>
      </p>
      <div class="search-row"><input id="guessSearchInput" type="text" placeholder="Search a name..." value="${state.guessSearch.replace(/"/g,'&quot;')}" autofocus /></div>
      ${state.guessResult==='miss' ? `<p class="hint" style="color:var(--danger); margin-bottom:8px;">Not quite, try again.</p>` : ''}
      <div class="grid">
        ${filteredBoardChars(state.guessSearch).map(c=>`
          <div class="card-tile" data-guess="${c.id}">
            <img src="${imgUrl(c)}" alt="${c.name}" loading="lazy" />
            <div class="cname">${c.name}</div>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  return `
    <div class="game">
      <div class="id-row">
        <div class="id-card">
          ${mySecretChar ? `<img class="id-photo" src="${imgUrl(mySecretChar)}" alt="${mySecretChar.name}" />` : `<div class="id-silhouette">?</div>`}
          <p class="id-label">${mySecretChar ? mySecretChar.name : ''}</p>
          <p class="id-sub">Your character</p>
        </div>
        <div class="id-card guess-card" id="openGuessBtn">
          <div class="id-silhouette">?</div>
          <p class="id-label">?????</p>
          <p class="id-sub">Guess who?</p>
        </div>
      </div>

      ${guessPanel}

      <div class="card">
        <p class="panel-title">
          <span>Board. Click to flip down characters you've ruled out</span>
          <span class="pill opp" style="display:flex; align-items:center; gap:6px;">
            <span class="avatar-stage avatar-stage-mini" id="gwOppAvatar"></span>
            ${opp ? opp.name : 'opponent'}
          </span>
        </p>
        <div class="search-row"><input id="searchInput2" type="text" placeholder="Search a name..." value="${state.search.replace(/"/g,'&quot;')}" /></div>
        <div class="grid">
          ${board.map(c=>`
            <div class="card-tile ${state.eliminated.has(c.id)?'eliminated':''}" data-flip="${c.id}">
              <div class="img-wrap">
                <img src="${imgUrl(c)}" alt="${c.name}" loading="lazy" />
                <div class="x-mark"></div>
              </div>
              <div class="cname">${c.name}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="center">
        <button type="button" class="secondary" id="leaveBtn">Leave Game</button>
      </div>
    </div>
  `;
}

function render(){
  const prevGrid = document.querySelector('.grid');
  const prevScroll = prevGrid ? prevGrid.scrollTop : 0;
  const prevWindowScroll = window.scrollY;

  let html='';
  if(state.screen==='home') html = renderHome();
  else if(state.screen==='lobby') html = renderLobby();
  else if(state.screen==='pick') html = renderPick();
  else if(state.screen==='game') html = renderGame();
  else if(state.screen==='opponentLeft') html = renderOpponentLeft();

  gwRoot.innerHTML = html;
  attachHandlers();

  const newGrid = document.querySelector('.grid');
  if(newGrid) newGrid.scrollTop = prevScroll;
  window.scrollTo(0, prevWindowScroll);

  if(state.screen==='game' && state.room && state.room.status==='over'){
    const iWon = state.room.winner===state.playerId;
    if(iWon && !state.confettiPlayed){
      state.confettiPlayed = true;
      launchConfetti();
    }
  }
}

function attachHandlers(){
  const nameInput = document.getElementById('nameInput');
  if(nameInput) nameInput.addEventListener('input', e=>{ state.playerName = e.target.value; });

  const createBtn = document.getElementById('createBtn');
  if(createBtn) createBtn.addEventListener('click', createRoom);

  const joinBtn = document.getElementById('joinBtn');
  const codeInput = document.getElementById('codeInput');
  if(joinBtn && codeInput) joinBtn.addEventListener('click', ()=>joinRoom(codeInput.value));
  if(codeInput) codeInput.addEventListener('keydown', e=>{ if(e.key==='Enter') joinRoom(codeInput.value); });

  const gwHowToPlayBtn = document.getElementById('gwHowToPlayBtn');
  if(gwHowToPlayBtn) gwHowToPlayBtn.addEventListener('click', ()=>{
    showGwNotice('Instructions for Trails Guess Who are coming soon!');
  });

  const watchBtn = document.getElementById('watchBtn');
  const watchCodeInput = document.getElementById('watchCodeInput');
  if(watchBtn && watchCodeInput) watchBtn.addEventListener('click', ()=>watchRoom(watchCodeInput.value));
  if(watchCodeInput) watchCodeInput.addEventListener('keydown', e=>{ if(e.key==='Enter') watchRoom(watchCodeInput.value); });

  const leaveBtn = document.getElementById('leaveBtn');
  if(leaveBtn) leaveBtn.addEventListener('click', leaveRoom);

  ['searchInput','searchInput2'].forEach(id=>{
    const node = document.getElementById(id);
    if(node){
      node.addEventListener('input', e=>{
        const pos = e.target.selectionStart;
        state.search = e.target.value;
        render();
        const again = document.getElementById(id);
        if(again){ again.focus(); again.setSelectionRange(pos,pos); }
      });
    }
  });

  const guessSearchInput = document.getElementById('guessSearchInput');
  if(guessSearchInput){
    guessSearchInput.addEventListener('input', e=>{
      const pos = e.target.selectionStart;
      state.guessSearch = e.target.value;
      render();
      const again = document.getElementById('guessSearchInput');
      if(again){ again.focus(); again.setSelectionRange(pos,pos); }
    });
  }

  document.querySelectorAll('[data-pick]').forEach(node=>{
    node.addEventListener('click', ()=>selectPick(node.getAttribute('data-pick')));
  });

  const lockInBtn = document.getElementById('lockInBtn');
  if(lockInBtn) lockInBtn.addEventListener('click', lockInPick);

  document.querySelectorAll('[data-flip]').forEach(node=>{
    node.addEventListener('click', ()=>{ toggleFlip(node.getAttribute('data-flip')); });
  });

  const openGuessBtn = document.getElementById('openGuessBtn');
  if(openGuessBtn) openGuessBtn.addEventListener('click', toggleGuessPanel);

  const closeGuessBtn = document.getElementById('closeGuessBtn');
  if(closeGuessBtn) closeGuessBtn.addEventListener('click', toggleGuessPanel);

  document.querySelectorAll('[data-guess]').forEach(node=>{
    node.addEventListener('click', ()=>guessChar(node.getAttribute('data-guess')));
  });

  const rematchBtn = document.getElementById('rematchBtn');
  if(rematchBtn) rematchBtn.addEventListener('click', requestRematch);

  const acceptRematchBtn = document.getElementById('acceptRematchBtn');
  if(acceptRematchBtn) acceptRematchBtn.addEventListener('click', ()=>respondRematch(true));

  const declineRematchBtn = document.getElementById('declineRematchBtn');
  if(declineRematchBtn) declineRematchBtn.addEventListener('click', ()=>respondRematch(false));

  // Avatar builder on the home screen. This reuses the exact same shared
  // `avatar` object, LAYER_COUNTS/effectiveLayerCount, and renderAvatarStage
  // helper that app.js defines for Heads Up, so a player's look carries over
  // between the two games automatically.
  const gwAvatarStage = document.getElementById('gwAvatarStage');
  if(gwAvatarStage && typeof renderAvatarStage === 'function'){
    renderAvatarStage(gwAvatarStage, avatar);
  }

  document.querySelectorAll('[data-gwlayer]').forEach(node=>{
    node.addEventListener('click', ()=>{
      const layer = node.getAttribute('data-gwlayer');
      const dir = parseInt(node.getAttribute('data-gwdir'), 10);
      const count = effectiveLayerCount(layer);
      avatar[layer] = ((avatar[layer] - 1 + dir + count) % count) + 1;
      if(typeof saveAvatar === 'function') saveAvatar(avatar);
      const stage = document.getElementById('gwAvatarStage');
      if(stage) renderAvatarStage(stage, avatar);
    });
  });

  const gwDiceBtn = document.getElementById('gwDiceBtn');
  if(gwDiceBtn){
    gwDiceBtn.addEventListener('click', ()=>{
      avatar.hat = Math.floor(Math.random() * effectiveLayerCount('hat')) + 1;
      avatar.face = Math.floor(Math.random() * effectiveLayerCount('face')) + 1;
      avatar.base = Math.floor(Math.random() * effectiveLayerCount('base')) + 1;
      if(typeof saveAvatar === 'function') saveAvatar(avatar);
      const stage = document.getElementById('gwAvatarStage');
      if(stage) renderAvatarStage(stage, avatar);
    });
  }

  // Mini avatars in the lobby, one per player, rendered from whatever avatar
  // each of them saved when they created/joined the room (their own avatar
  // for "you", the opponent's synced-from-Firebase avatar for the other).
  if(state.room && state.room.players){
    Object.entries(state.room.players).forEach(([pid, p])=>{
      const node = document.getElementById('gwLobbyAvatar_' + pid);
      if(node && p.avatar && typeof renderAvatarStage === 'function'){
        renderAvatarStage(node, p.avatar);
      }
    });
  }

  // Mini avatar next to the opponent's name badge during the game itself.
  const gwOppAvatar = document.getElementById('gwOppAvatar');
  if(gwOppAvatar){
    const opp = oppPlayer();
    if(opp && opp.avatar && typeof renderAvatarStage === 'function'){
      renderAvatarStage(gwOppAvatar, opp.avatar);
    }
  }
}

loadCharacters().then(render);
