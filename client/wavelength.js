// Trails Wavelength. Same Firebase project as Guess Who, its own top-level
// "wavelength_rooms" node so the two games never collide even if someone
// reuses a room code between them.
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
// The database's security rules now require a signed-in auth token (rather
// than being wide open), so every code path that touches db.ref(...) awaits
// this first. It's anonymous sign-in -- no login screen, no password, it
// just gets a token in the background the instant the page loads.
const authReady = firebase.auth().signInAnonymously()
  .catch(e => { console.error('Anonymous sign-in failed', e); });

const svgns = "http://www.w3.org/2000/svg";
const WHEEL_CX = 200, WHEEL_CY = 200, WHEEL_R = 170, HOOD_R = 185;
const NOTCH_R0 = 186, NOTCH_R1 = 195, RAY_COUNT = 16;
// The hood handle travels along this radius, riding the rim between the
// wedges and the tick marks rather than sitting in a fixed corner.
const HANDLE_R = 178;
// 5 rounds each, alternating who's psychic, starting with the host -- 10 total.
const ROUNDS_PER_MATCH = 10;
const REVEAL_DISPLAY_MS = 15000;
const ORANGE = "#F0997B";
const TEAL = "#5DCAA5";
const PURPLE_BAND = "#AFA9EC";

// A grab bag of Trails-themed opposite word pairs for "Random" mode. "Shuffle"
// just draws a new one from here, as many times as the host wants before
// they're happy with it.
const WORD_PAIRS = [
  ["Erebonia","Calvard"],["Noble","Commoner"],["Ironblood","Reformist"],
  ["Guardian","Enforcer"],["Septian Church","Ouroboros"],["Thors Branch","Leeves Branch"],
  ["Orbal Gear","Combat Blade"],["Divine Knight","Panzer Soldat"],["Jaeger","Bracer"],
  ["Class VII","Class IX"],["North Ambria","South Ambria"],["Old Zemurian","Modern Zemurian"],
  ["Recluse","Field Study"],["Airship","Orbal Car"],["Trooper Meister","Prodigy"],
  ["Sunshine","Storm"],["Comfort Food","Battle Rations"],["Loud","Quiet"],
  ["Cat","Dog"],["Ice","Fire"]
];

function properMod(v,m){ return ((v % m) + m) % m; }
function polar(rad,angleDeg){
  const a = (180-angleDeg) * Math.PI/180;
  return [WHEEL_CX+rad*Math.cos(a), WHEEL_CY-rad*Math.sin(a)];
}
function sectorPath(a0,a1,r0,r1){
  const p0=polar(r1,a0), p1=polar(r1,a1);
  const p2=polar(r0,a1), p3=polar(r0,a0);
  const large = (a1-a0)>180 ? 1 : 0;
  return "M"+p0[0]+" "+p0[1]+" A"+r1+" "+r1+" 0 "+large+" 1 "+p1[0]+" "+p1[1]+" L"+p2[0]+" "+p2[1]+" A"+r0+" "+r0+" 0 "+large+" 0 "+p3[0]+" "+p3[1]+" Z";
}

function genCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s='';
  for(let i=0;i<4;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function genId(){ return 'p_'+Math.random().toString(36).slice(2,10); }
function randomPair(){ return WORD_PAIRS[Math.floor(Math.random()*WORD_PAIRS.length)]; }

let state = {
  screen: 'home', // home, lobby, pairing, playing, complete, opponentLeft
  code: null,
  playerId: genId(),
  playerName: '',
  room: null,
  isSpectator: false,
  joinIntent: null, // 'create' | 'join' | 'watch'
  joinCodeDraft: '',
  error: '',
  hadFullRoom: false,
  // local-only drag state, never written straight to Firebase on every frame
  localRotation: 90,
  localNeedle: 90,
  hoodOpen: 0,
  guesserHoodOpen: 0,
  // The hood handle has to actually reach the far side (point B) at some
  // point before a return to the near side (point A) counts as "closed and
  // locked" -- otherwise a tiny accidental nudge would lock in a target
  // nobody actually peeked at.
  psychicPeeked: false,
  guesserPeeked: false,
  notchesTarget: null // set once the psychic locks, so the reference marks survive
};

let roomRef = null;
let lastWriteAt = {};
function throttledSet(path, value, minGapMs){
  const now = Date.now();
  if(!lastWriteAt[path] || now-lastWriteAt[path] >= minGapMs){
    lastWriteAt[path] = now;
    db.ref(path).set(value);
  }
}
function forceSet(path, value){
  lastWriteAt[path] = Date.now();
  db.ref(path).set(value);
}

function attachRoomListener(code){
  if(roomRef) roomRef.off();
  roomRef = db.ref('wavelength_rooms/' + code);
  roomRef.on('value', snap=>{
    const room = snap.val();
    const playerCount = room && room.players ? Object.keys(room.players).length : 0;
    if(playerCount>=2) state.hadFullRoom = true;
    if(state.hadFullRoom && playerCount<2 && !state.isSpectator && state.screen!=='home' && state.screen!=='opponentLeft'){
      state.room = room;
      state.screen = 'opponentLeft';
      render();
      return;
    }
    if(room){
      const prevStatus = state.room && state.room.status;
      const prevRound = state.room && state.room.round;
      state.room = room;
      if(state.screen!=='home' && state.screen!=='opponentLeft'){
        state.screen = room.status;
      }
      // A fresh round (or a fresh pair, in custom mode) means the persistent
      // notches and local drag state from the previous target are stale.
      if((prevStatus !== room.status || prevRound !== room.round) && (room.status==='playing' || room.status==='pairing')){
        state.notchesTarget = null;
        state.hoodOpen = 0;
        state.guesserHoodOpen = 0;
        state.psychicPeeked = false;
        state.guesserPeeked = false;
      }
      if(room.status==='playing' && !room.locked){
        state.localRotation = room.rotation;
      }
      if(room.status==='playing'){
        state.localNeedle = room.needleAngle;
      }
      render();
    }
  });
}
function detachRoomListener(){ if(roomRef){ roomRef.off(); roomRef=null; } }

function myPlayer(){
  if(!state.room || !state.room.players) return null;
  return state.room.players[state.playerId] || null;
}
function isHost(){ return !!(state.room && state.room.hostId === state.playerId); }
function isPsychic(){ return !!(state.room && state.room.psychicId === state.playerId); }
function opponentEntry(){
  if(!state.room || !state.room.players) return null;
  const entries = Object.entries(state.room.players);
  const found = entries.find(([id])=>id!==state.playerId);
  return found ? { id: found[0], ...found[1] } : null;
}

// ---------- join / create / watch ----------

function openJoinModal(intent){
  state.joinIntent = intent;
  state.error = '';
  document.getElementById('wlJoinTitle').textContent =
    intent==='create' ? 'Create Room' : intent==='join' ? 'Join Room' : 'Watch a Room';
  const nameRow = document.getElementById('wlNameInput');
  const avatarBlock = document.querySelector('#wlJoinModal .avatar-builder');
  const avatarLabel = document.querySelector('#wlJoinModal label');
  // Watching doesn't need a name or avatar -- spectators are read-only and
  // never appear as a player in the room.
  const hideForWatch = intent === 'watch';
  nameRow.style.display = hideForWatch ? 'none' : '';
  avatarBlock.style.display = hideForWatch ? 'none' : '';
  avatarLabel.style.display = hideForWatch ? 'none' : '';
  document.getElementById('wlJoinConfirmBtn').textContent =
    intent==='create' ? 'Create Room' : intent==='join' ? 'Join Room' : 'Watch';
  document.getElementById('wlJoinError').textContent = '';
  if(typeof renderAvatarStage === 'function'){
    renderAvatarStage(document.getElementById('wlAvatarStage'), avatar);
  }
  document.getElementById('wlJoinModal').classList.add('active');
}
function closeJoinModal(){
  document.getElementById('wlJoinModal').classList.remove('active');
}

async function confirmJoinModal(){
  const intent = state.joinIntent;
  const name = document.getElementById('wlNameInput').value.trim();
  const errEl = document.getElementById('wlJoinError');
  if(intent !== 'watch' && !name){ errEl.textContent = 'Enter your name first'; return; }
  if(intent === 'create'){
    state.playerName = name;
    await createRoom();
    closeJoinModal();
  } else {
    const code = (state.joinCodeDraft || '').trim().toUpperCase();
    if(!code){ errEl.textContent = 'Enter a room code'; return; }
    if(intent === 'join' && name.toUpperCase() === code){
      errEl.textContent = "That's the room code, not a name -- put your actual name in the name field above.";
      return;
    }
    state.playerName = name;
    if(intent === 'join') await joinRoom(code);
    else await watchRoom(code);
    if(state.error){ errEl.textContent = state.error; return; }
    closeJoinModal();
  }
}

async function createRoom(){
  await authReady;
  const code = genCode();
  const room = {
    code,
    status: 'lobby',
    round: 0,
    hostId: state.playerId,
    psychicId: state.playerId,
    players: {
      [state.playerId]: { name: state.playerName, avatar: JSON.parse(JSON.stringify(avatar)), score: 0 }
    }
  };
  await db.ref('wavelength_rooms/' + code).set(room);
  db.ref('wavelength_rooms/' + code + '/players/' + state.playerId).onDisconnect().remove();
  state.code = code; state.room = room; state.screen = 'lobby';
  attachRoomListener(code);
  render();
}

async function joinRoom(code){
  state.error = '';
  await authReady;
  const snap = await db.ref('wavelength_rooms/' + code).get();
  const room = snap.val();
  if(!room){ state.error = 'Room not found'; render(); return; }
  const players = room.players || {};
  if(Object.keys(players).length>=2 && !players[state.playerId]){
    state.error = 'That room is full'; render(); return;
  }
  if(!players[state.playerId]){
    players[state.playerId] = { name: state.playerName, avatar: JSON.parse(JSON.stringify(avatar)), score: 0 };
  }
  room.players = players;
  if(Object.keys(players).length===2 && room.status==='lobby'){
    room.status = 'pairing';
    room.pairMode = room.pairMode || 'random';
    room.pair = randomPair();
  }
  await db.ref('wavelength_rooms/' + code).set(room);
  db.ref('wavelength_rooms/' + code + '/players/' + state.playerId).onDisconnect().remove();
  state.code = code; state.room = room; state.screen = room.status;
  attachRoomListener(code);
  render();
}

async function watchRoom(code){
  state.error = '';
  await authReady;
  const snap = await db.ref('wavelength_rooms/' + code).get();
  const room = snap.val();
  if(!room){ state.error = 'Room not found'; render(); return; }
  state.code = code; state.room = room; state.isSpectator = true; state.screen = room.status;
  attachRoomListener(code);
  render();
}

async function leaveRoom(){
  if(state.code && !state.isSpectator){
    const playerRef = db.ref('wavelength_rooms/' + state.code + '/players/' + state.playerId);
    try { await playerRef.onDisconnect().cancel(); await playerRef.remove(); } catch(e){}
  }
  detachRoomListener();
  stopCountdown();
  mountedPlayingKey = null;
  state = Object.assign({}, state, {
    screen:'home', code:null, playerId: genId(), room:null, isSpectator:false,
    joinIntent:null, error:'', hadFullRoom:false, localRotation:90, localNeedle:90,
    hoodOpen:0, guesserHoodOpen:0, psychicPeeked:false, guesserPeeked:false, notchesTarget:null
  });
  render();
}

// ---------- pairing phase (host-only) ----------

function setPairMode(mode){
  if(!isHost()) return;
  db.ref('wavelength_rooms/' + state.code).update({
    pairMode: mode,
    pair: mode==='random' ? randomPair() : { left:'', right:'' }
  });
}
function shuffleRandomPair(){
  if(!isHost()) return;
  db.ref('wavelength_rooms/' + state.code + '/pair').set(randomPair());
}
function updateCustomPair(side, value){
  if(!isHost()) return;
  db.ref('wavelength_rooms/' + state.code + '/pair/' + side).set(value);
}
async function startFirstRound(){
  if(!isHost()) return;
  const pair = state.room.pair;
  if(!pair || !pair.left || !pair.right) return;
  await db.ref('wavelength_rooms/' + state.code).update({
    status: 'playing', round: 1, psychicId: state.room.hostId,
    rotation: 90, needleAngle: 90, spun: false, locked: false, revealed: false,
    lastScore: null, revealedAt: null
  });
}
async function startNextRoundFromPairing(){
  if(!isHost()) return;
  const pair = state.room.pair;
  if(!pair || !pair.left || !pair.right) return;
  await db.ref('wavelength_rooms/' + state.code).update({
    status:'playing', rotation:90, needleAngle:90, spun:false, locked:false, revealed:false,
    lastScore: null, revealedAt: null
  });
}

// ---------- gameplay ----------

function effectiveTarget(rotation){ return properMod(rotation, 180); }

function drawWedges(target, revealNumbers){
  const g = document.getElementById('wlWedges');
  if(!g) return;
  g.innerHTML = '';
  const base = document.createElementNS(svgns,'path');
  base.setAttribute('d', sectorPath(0,180,20,WHEEL_R));
  base.setAttribute('fill', '#ffffff');
  g.appendChild(base);
  if(!revealNumbers) return;
  const zones = [
    [Math.max(0,target-4), Math.min(180,target+4), TEAL, 4],
    [Math.max(0,target-10), Math.max(0,target-4), PURPLE_BAND, 3],
    [Math.min(180,target+4), Math.min(180,target+10), PURPLE_BAND, 3],
    [Math.max(0,target-18), Math.max(0,target-10), ORANGE, 2],
    [Math.min(180,target+10), Math.min(180,target+18), ORANGE, 2]
  ];
  zones.forEach(z=>{
    if(z[1]<=z[0]) return;
    const path = document.createElementNS(svgns,'path');
    path.setAttribute('d', sectorPath(z[0],z[1],20,WHEEL_R));
    path.setAttribute('fill', z[2]);
    g.appendChild(path);
    const mid = (z[0]+z[1])/2;
    const p = polar(148, mid);
    const label = document.createElementNS(svgns,'text');
    label.setAttribute('x', p[0]); label.setAttribute('y', p[1]);
    label.setAttribute('text-anchor','middle');
    label.setAttribute('dominant-baseline','middle');
    label.setAttribute('font-size','20');
    label.setAttribute('font-weight','700');
    label.setAttribute('fill', z[3]===4 ? '#14213d' : '#ffffff');
    label.textContent = z[3];
    g.appendChild(label);
  });
}

function buildHoodDecor(){
  // wlHoodBase's own 'd' is owned entirely by applyHoodClip (called right
  // after this on every mount/sync) -- this only builds the decorative rays.
  const rays = document.getElementById('wlHoodRays');
  rays.innerHTML = '';
  for(let k=0;k<RAY_COUNT;k++){
    const ang = k * (360/RAY_COUNT);
    const p0 = polar(20, ang), p1 = polar(HOOD_R, ang);
    const line = document.createElementNS(svgns,'line');
    line.setAttribute('x1',p0[0]); line.setAttribute('y1',p0[1]);
    line.setAttribute('x2',p1[0]); line.setAttribute('y2',p1[1]);
    line.setAttribute('stroke','#6a5fa8');
    line.setAttribute('stroke-width','6');
    line.setAttribute('stroke-linecap','round');
    rays.appendChild(line);
  }
}
function setHoodRotation(angle){
  document.getElementById('wlHoodRays').setAttribute('transform', 'rotate(' + angle + ' ' + WHEEL_CX + ' ' + WHEEL_CY + ')');
}
function applyHoodClip(frac){
  const covered = 180*frac;
  const d = covered>=180 ? '' : sectorPath(covered,180,0,HOOD_R);
  // wlHoodBase gets its own 'd' set directly rather than relying only on the
  // clip-path -- clip-path support for the decorative rays is left as a nice
  // to have, but the actual cover (the part that hides the target from the
  // psychic while spinning) must never depend on it, since that's the one
  // piece that absolutely cannot silently fail to render.
  document.getElementById('wlHoodBase').setAttribute('d', d);
  document.getElementById('wlHoodClipPath').setAttribute('d', d || 'M0 0 Z');
  document.getElementById('wlHoodBorder').setAttribute('d', d);
}
// The handle itself rides along the rim: point A (angle 180, left) is fully
// closed, point B (angle 0, right) is fully open. frac and angle are two
// ways of describing the exact same position.
function fracToAngle(frac){ return 180 - 180*Math.max(0,Math.min(1,frac)); }
// NOTE: rawAngleFromEvent's own angle labeling runs the opposite direction
// to polar()'s (it returns ~180 when the pointer is physically on the right
// side of the wheel, ~0 when it's on the left) -- this has to mirror that or
// the handle renders somewhere that doesn't match where you're dragging,
// which is what made the drag feel broken/unresponsive.
function angleToFrac(angle){ return Math.max(0, Math.min(1, angle/180)); }
function setHoodHandlePosition(frac){
  const p = polar(HANDLE_R, fracToAngle(frac));
  const handle = document.getElementById('wlHoodHandle');
  handle.setAttribute('cx', p[0]);
  handle.setAttribute('cy', p[1]);
}
function setNeedleVisual(angle){
  const tip = polar(170, angle);
  document.getElementById('wlNeedle').setAttribute('x2', tip[0]);
  document.getElementById('wlNeedle').setAttribute('y2', tip[1]);
  document.getElementById('wlNeedleHandle').setAttribute('cx', tip[0]);
  document.getElementById('wlNeedleHandle').setAttribute('cy', tip[1]);
}
function drawNotches(target){
  const g = document.getElementById('wlNotches');
  g.innerHTML = '';
  if(target==null) return;
  [target-18,target-10,target-4,target+4,target+10,target+18].forEach(a=>{
    if(a<0 || a>180) return;
    const p0 = polar(NOTCH_R0,a), p1 = polar(NOTCH_R1,a);
    const line = document.createElementNS(svgns,'line');
    line.setAttribute('x1',p0[0]); line.setAttribute('y1',p0[1]);
    line.setAttribute('x2',p1[0]); line.setAttribute('y2',p1[1]);
    line.setAttribute('stroke','#6a5fa8');
    line.setAttribute('stroke-width','3');
    line.setAttribute('stroke-linecap','round');
    g.appendChild(line);
  });
  const tip = polar(NOTCH_R1, target);
  const dot = document.createElementNS(svgns,'circle');
  dot.setAttribute('cx',tip[0]); dot.setAttribute('cy',tip[1]); dot.setAttribute('r','4');
  dot.setAttribute('fill', ORANGE);
  g.appendChild(dot);
}

function toSvgPoint(svg,evt){
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}
function rawAngleFromEvent(svg,evt){
  const p = toSvgPoint(svg,evt);
  const dx=p.x-WHEEL_CX, dy=WHEEL_CY-p.y;
  return properMod(180-(Math.atan2(dy,dx)*180/Math.PI), 360);
}
function shortestDelta(from,to){ return properMod(to-from+180, 360) - 180; }

async function lockTarget(){
  state.notchesTarget = effectiveTarget(state.localRotation);
  await forceSet('wavelength_rooms/' + state.code + '/rotation', state.localRotation);
  forceSet('wavelength_rooms/' + state.code + '/locked', true);
}
async function revealAndScore(){
  const room = state.room;
  const target = effectiveTarget(room.rotation);
  const diff = Math.abs(state.localNeedle - target);
  const pts = diff<=4?4:diff<=10?3:diff<=18?2:0;
  const psychicId = room.psychicId;
  const psychicScore = (room.players[psychicId] && room.players[psychicId].score) || 0;
  const revealedAt = Date.now();
  await db.ref('wavelength_rooms/' + state.code).update({
    revealed: true,
    needleAngle: state.localNeedle,
    lastScore: pts,
    revealedAt,
    ['players/'+psychicId+'/score']: psychicScore + pts
  });
  setTimeout(advanceRound, REVEAL_DISPLAY_MS);
}
async function advanceRound(){
  const room = state.room;
  if(!room || room.status!=='playing') return;
  const nextRound = (room.round||1) + 1;
  const nextPsychic = opponentEntry() ? opponentEntry().id : room.psychicId;
  if(nextRound > ROUNDS_PER_MATCH){
    await db.ref('wavelength_rooms/' + state.code).update({ status:'complete' });
    return;
  }
  if(room.pairMode === 'random'){
    await db.ref('wavelength_rooms/' + state.code).update({
      status:'playing', round: nextRound, psychicId: nextPsychic,
      rotation:90, needleAngle:90, spun:false, locked:false, revealed:false,
      lastScore: null, revealedAt: null,
      pair: randomPair()
    });
  } else {
    await db.ref('wavelength_rooms/' + state.code).update({
      status:'pairing', round: nextRound, psychicId: nextPsychic,
      rotation:90, needleAngle:90, spun:false, locked:false, revealed:false,
      lastScore: null, revealedAt: null,
      pair: { left:'', right:'' }
    });
  }
}
async function playAgain(){
  if(!isHost()) return;
  const ids = Object.keys(state.room.players || {});
  const updates = { status:'pairing', round:0, pair:{left:'',right:''}, lastScore:null, revealedAt:null };
  ids.forEach(id=>{ updates['players/'+id+'/score'] = 0; });
  await db.ref('wavelength_rooms/' + state.code).update(updates);
}

// ---------- rendering ----------

let mountedPlayingKey = null;

function render(){
  const root = document.getElementById('wlRoot');
  if(state.screen==='playing' && state.room){
    const key = state.code + '|' + state.room.round;
    if(mountedPlayingKey !== key){
      root.innerHTML = renderPlaying();
      mountedPlayingKey = key;
      attachStaticHandlers();
      mountWheel();
    }
    syncPlayingScreen();
    return;
  }
  mountedPlayingKey = null;
  stopCountdown();
  if(state.screen==='home') root.innerHTML = renderHome();
  else if(state.screen==='lobby') root.innerHTML = renderLobby();
  else if(state.screen==='pairing') root.innerHTML = renderPairing();
  else if(state.screen==='complete') root.innerHTML = renderComplete();
  else if(state.screen==='opponentLeft') root.innerHTML = renderOpponentLeft();
  attachStaticHandlers();
}

function renderHome(){
  return `
    <div class="card center">
      <button type="button" class="primary" id="wlCreateBtn">Create Room</button>
      <div class="join-row">
        <input id="wlCodeInput" type="text" placeholder="Room code" maxlength="4" />
        <button type="button" class="secondary" id="wlJoinBtn">Join</button>
      </div>
      <div class="join-row">
        <input id="wlWatchCodeInput" type="text" placeholder="Room code" maxlength="4" />
        <button type="button" class="secondary wl-watch-btn" id="wlWatchBtn">Watch</button>
      </div>
      ${state.error ? `<p class="error-text">${state.error}</p>` : ''}
    </div>
  `;
}

function lobbyAvatarBlock(pid, p){
  return `<div class="wl-lobby-slot">
    <div class="avatar-stage small" id="wlLobbyAvatar_${pid}"></div>
    <p>${p.name}</p>
  </div>`;
}
function renderLobby(){
  const room = state.room;
  const players = room.players || {};
  const entries = Object.entries(players);
  return `
    <div class="card center">
      <p class="hint">Room code</p>
      <p class="room-code">${room.code}</p>
      <div class="wl-lobby-row">
        ${entries.map(([pid,p])=>lobbyAvatarBlock(pid,p)).join('')}
      </div>
      <p class="hint">${entries.length<2 ? 'Waiting for a second player to join...' : 'Starting...'}</p>
      ${state.isSpectator ? '' : '<button type="button" class="secondary" id="leaveBtn">Leave Room</button>'}
    </div>
  `;
}

function renderPairing(){
  const room = state.room;
  const mode = room.pairMode || 'random';
  const pair = room.pair || {left:'',right:''};
  const host = isHost();
  return `
    <div class="card center">
      <p class="hint">Round ${Math.max(1,room.round||1)} of ${ROUNDS_PER_MATCH} &middot; word pair</p>
      ${host ? `
        <div class="wl-mode-toggle">
          <button type="button" class="wl-mode-btn ${mode==='random'?'active':''}" data-wlpairmode="random">Random suggestions</button>
          <button type="button" class="wl-mode-btn ${mode==='custom'?'active':''}" data-wlpairmode="custom">Type your own</button>
        </div>
        ${mode==='random' ? `
          <div class="wl-pair-display">
            <span>${pair.left||'...'}</span><span class="wl-pair-vs">vs</span><span>${pair.right||'...'}</span>
          </div>
          <button type="button" class="secondary" id="wlShuffleBtn">Shuffle another pair</button>
          <button type="button" class="primary" id="wlStartRoundBtn">Use this pair</button>
        ` : `
          <div class="wl-pair-inputs">
            <input type="text" id="wlPairLeft" placeholder="Left word" maxlength="24" value="${(pair.left||'').replace(/"/g,'&quot;')}" />
            <input type="text" id="wlPairRight" placeholder="Right word" maxlength="24" value="${(pair.right||'').replace(/"/g,'&quot;')}" />
          </div>
          <button type="button" class="primary" id="wlStartRoundBtn" ${(!pair.left||!pair.right)?'disabled':''}>Start round</button>
        `}
      ` : `
        <p class="hint">The host is choosing this round's word pair...</p>
        <div class="wl-pair-display">
          <span>${pair.left||'...'}</span><span class="wl-pair-vs">vs</span><span>${pair.right||'...'}</span>
        </div>
      `}
    </div>
  `;
}

function renderWheelSvg(){
  return `
    <div class="wl-pair-flank">
      <span id="wlPairLeftLabel" class="wl-pair-flank-word left"></span>
      <span id="wlPairRightLabel" class="wl-pair-flank-word right"></span>
    </div>
    <svg id="wlSvg" viewBox="0 0 400 230" style="width:100%; height:auto; display:block;">
      <defs><clipPath id="wlHoodClip"><path id="wlHoodClipPath"></path></clipPath></defs>
      <g id="wlWedges"></g>
      <path id="wlHoodBase" fill="#3a3260"></path>
      <g id="wlHoodRays" clip-path="url(#wlHoodClip)"></g>
      <path id="wlHoodBorder" fill="none" stroke="var(--border-strong)" stroke-width="1"></path>
      <g id="wlNotches"></g>
      <line id="wlNeedle" x1="200" y1="200" x2="200" y2="30" stroke="#14213d" stroke-width="4" stroke-linecap="round"></line>
      <circle cx="200" cy="200" r="8" fill="#14213d"></circle>
      <circle id="wlNeedleHandle" cx="200" cy="30" r="14" fill="${ORANGE}" stroke="white" stroke-width="2" style="cursor:grab; display:none;"></circle>
      <text id="wlSpinHint" x="200" y="215" text-anchor="middle" font-size="12" fill="var(--text-secondary)">Drag the wheel to spin</text>
      <circle id="wlHoodHandle" cx="15" cy="200" r="12" fill="${ORANGE}" stroke="#fff" stroke-width="2" style="cursor:grab; touch-action:none;"></circle>
    </svg>
  `;
}

// Static shell for a round. Built once when the round number changes and
// never innerHTML-replaced again mid-round -- only individual attributes and
// text nodes get updated after this (see syncPlayingScreen), so an in-progress
// drag never gets its listeners yanked out from under it.
function renderPlaying(){
  return `
    <div class="card center wl-playing-card">
      <p class="hint" id="wlRoundLine"></p>
      <p class="wl-role-label" id="wlRoleLine"></p>
      <div class="wl-scoreboard" id="wlScoreboard"></div>
      <div class="wl-wheel-wrap" style="position:relative;">
        ${renderWheelSvg()}
      </div>
      <p class="status" id="wlStatusLine"></p>
      <div id="wlResultPanel" class="wl-result-panel"></div>
    </div>
    ${state.isSpectator ? '' : '<div class="center" style="margin-top:14px;"><button type="button" class="secondary" id="leaveBtn">Leave Room</button></div>'}
  `;
}

function renderComplete(){
  const room = state.room;
  const entries = Object.entries(room.players||{});
  const winnerLine = entries.length===2
    ? (entries[0][1].score===entries[1][1].score ? "It's a tie!" : (entries[0][1].score>entries[1][1].score ? entries[0][1].name+' wins!' : entries[1][1].name+' wins!'))
    : '';
  return `
    <div class="card center">
      <p class="gameover-title">Match complete</p>
      <div class="wl-scoreboard">
        ${entries.map(([pid,p])=>`<span>${p.name}: ${p.score||0}</span>`).join(' &nbsp; ')}
      </div>
      <p class="hint">${winnerLine}</p>
      ${state.isSpectator ? '' : '<button type="button" class="primary" id="wlPlayAgainBtn">Play again</button>'}
      ${state.isSpectator ? '' : '<button type="button" class="secondary" id="leaveBtn">Leave Room</button>'}
    </div>
  `;
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

// ---------- wiring ----------

// Handlers for whatever screen is currently mounted (everything except the
// in-round wheel itself, which mountWheel binds separately and only once per
// round -- see render()'s mount/sync split above).
function attachStaticHandlers(){
  const createBtn = document.getElementById('wlCreateBtn');
  if(createBtn) createBtn.addEventListener('click', ()=>openJoinModal('create'));

  const joinBtn = document.getElementById('wlJoinBtn');
  const codeInput = document.getElementById('wlCodeInput');
  if(joinBtn && codeInput) joinBtn.addEventListener('click', ()=>{ state.joinCodeDraft = codeInput.value; openJoinModal('join'); });

  const watchBtn = document.getElementById('wlWatchBtn');
  const watchCodeInput = document.getElementById('wlWatchCodeInput');
  if(watchBtn && watchCodeInput) watchBtn.addEventListener('click', ()=>{ state.joinCodeDraft = watchCodeInput.value; openJoinModal('watch'); });

  const leaveBtn = document.getElementById('leaveBtn');
  if(leaveBtn) leaveBtn.addEventListener('click', leaveRoom);

  if(state.room && state.room.players){
    Object.entries(state.room.players).forEach(([pid,p])=>{
      const node = document.getElementById('wlLobbyAvatar_' + pid);
      if(node && p.avatar && typeof renderAvatarStage === 'function') renderAvatarStage(node, p.avatar);
    });
  }

  document.querySelectorAll('[data-wlpairmode]').forEach(node=>{
    node.addEventListener('click', ()=>setPairMode(node.getAttribute('data-wlpairmode')));
  });
  const shuffleBtn = document.getElementById('wlShuffleBtn');
  if(shuffleBtn) shuffleBtn.addEventListener('click', shuffleRandomPair);
  const startRoundBtn = document.getElementById('wlStartRoundBtn');
  if(startRoundBtn) startRoundBtn.addEventListener('click', ()=>{
    if(!state.room.round){ startFirstRound(); } else { startNextRoundFromPairing(); }
  });
  const pairLeft = document.getElementById('wlPairLeft');
  const pairRight = document.getElementById('wlPairRight');
  if(pairLeft) pairLeft.addEventListener('change', e=>updateCustomPair('left', e.target.value));
  if(pairRight) pairRight.addEventListener('change', e=>updateCustomPair('right', e.target.value));

  const playAgainBtn = document.getElementById('wlPlayAgainBtn');
  if(playAgainBtn) playAgainBtn.addEventListener('click', playAgain);
}

// Binds the wheel's drag listeners exactly once per round. Every check inside
// reads live state.room fresh (never a captured snapshot), since locked/spun/
// revealed all change mid-round without the shell being rebuilt.
function mountWheel(){
  const svg = document.getElementById('wlSvg');
  if(!svg) return;
  buildHoodDecor();

  let draggingWheel=false, lastRaw=0;
  svg.addEventListener('pointerdown', e=>{
    if(!isPsychic() || state.isSpectator || state.room.locked || e.target.id==='wlNeedleHandle') return;
    draggingWheel=true; lastRaw=rawAngleFromEvent(svg,e); svg.setPointerCapture(e.pointerId); svg.style.cursor='grabbing';
    e.preventDefault();
  });
  svg.addEventListener('pointermove', e=>{
    if(draggingWheel){
      const raw = rawAngleFromEvent(svg,e);
      const delta = shortestDelta(lastRaw, raw);
      state.localRotation += delta;
      lastRaw = raw;
      setHoodRotation(state.localRotation);
      drawWedges(effectiveTarget(state.localRotation), true);
      const hint = document.getElementById('wlSpinHint');
      if(hint) hint.style.display = 'none';
      throttledSet('wavelength_rooms/' + state.code + '/rotation', state.localRotation, 70);
    }
  });
  svg.addEventListener('pointerup', ()=>{
    if(draggingWheel){
      draggingWheel=false; svg.style.cursor='auto';
      forceSet('wavelength_rooms/' + state.code + '/rotation', state.localRotation);
      forceSet('wavelength_rooms/' + state.code + '/spun', true);
    }
  });

  const handle = document.getElementById('wlNeedleHandle');
  let draggingNeedle=false;
  handle.addEventListener('pointerdown', e=>{
    if(isPsychic() || state.isSpectator || !state.room.locked || state.room.revealed) return;
    draggingNeedle=true; handle.setPointerCapture(e.pointerId); e.preventDefault();
  });
  handle.addEventListener('pointermove', e=>{
    if(draggingNeedle){
      state.localNeedle = Math.max(0, Math.min(180, rawAngleFromEvent(svg,e)));
      setNeedleVisual(state.localNeedle);
      throttledSet('wavelength_rooms/' + state.code + '/needleAngle', state.localNeedle, 70);
    }
  });
  handle.addEventListener('pointerup', ()=>{
    if(draggingNeedle){
      draggingNeedle=false;
      forceSet('wavelength_rooms/' + state.code + '/needleAngle', state.localNeedle);
    }
  });

  // The handle rides the rim from point A (closed, left) to point B (open,
  // right) exactly like the wheel's own spin and the needle -- dragging it
  // moves it along the arc, not sideways in a straight line, so its screen
  // position always matches how far open the cover actually is.
  const hoodHandle = document.getElementById('wlHoodHandle');
  let draggingHood=false;
  hoodHandle.addEventListener('pointerdown', e=>{
    if(state.isSpectator) return;
    const psychic = isPsychic();
    const room = state.room;
    if(psychic){
      if(!room.spun) return;
      // Once locked, the handle stays live only until it's been carried
      // back to point A -- that second drag is what reveals the notches.
      if(room.locked && state.hoodOpen <= 0.02) return;
    } else {
      if(!room.locked || room.revealed) return;
      if(state.guesserHoodOpen >= 0.98) return;
    }
    draggingHood=true;
    hoodHandle.setPointerCapture(e.pointerId); e.preventDefault();
  });
  hoodHandle.addEventListener('pointermove', e=>{
    if(draggingHood){
      let raw = rawAngleFromEvent(svg,e);
      // Natural drags dip below the flat baseline of the dial -- treat those
      // as still belonging to whichever end (A or B) they're closer to,
      // instead of the handle going dead or snapping to the wrong side.
      let angle;
      if(raw <= 180) angle = raw;
      else angle = (raw <= 270) ? 180 : 0;
      const frac = angleToFrac(angle);
      setHoodHandlePosition(frac);
      applyHoodClip(frac);
      if(isPsychic()){
        state.hoodOpen = frac;
        if(frac >= 0.9) state.psychicPeeked = true;
      } else {
        state.guesserHoodOpen = frac;
        if(frac >= 0.9) state.guesserPeeked = true;
      }
    }
  });
  hoodHandle.addEventListener('pointerup', ()=>{
    if(!draggingHood) return;
    draggingHood=false;
    if(isPsychic()){
      if(!state.room.locked){
        // Phase 1: opening to peek. Reaching point B locks the target right
        // there -- carrying it back to point A is a separate drag after this.
        if(state.hoodOpen >= 0.9 && state.psychicPeeked){
          state.hoodOpen = 1; applyHoodClip(1); setHoodHandlePosition(1);
          lockTarget();
        } else {
          state.hoodOpen = 0; applyHoodClip(0); setHoodHandlePosition(0);
        }
      } else {
        // Phase 2: already locked -- this drag is carrying the handle back
        // to point A to close the hood and reveal the reference notches.
        if(state.hoodOpen <= 0.1){
          state.hoodOpen = 0; applyHoodClip(0); setHoodHandlePosition(0);
        } else {
          state.hoodOpen = 1; applyHoodClip(1); setHoodHandlePosition(1);
        }
      }
    } else {
      if(state.guesserHoodOpen >= 0.9 && state.guesserPeeked){
        state.guesserHoodOpen = 1; applyHoodClip(1); setHoodHandlePosition(1); revealAndScore();
      } else {
        state.guesserHoodOpen = 0; applyHoodClip(0); setHoodHandlePosition(0);
      }
    }
  });
}

// Cheap per-update refresh: only touches text/attributes, never innerHTML's
// the svg or hood handle, so an active drag's listeners and pointer capture
// stay intact across every Firebase update that lands mid-round.
let countdownTimer = null;
function stopCountdown(){ if(countdownTimer){ clearInterval(countdownTimer); countdownTimer = null; } }

function syncPlayingScreen(){
  const room = state.room;
  if(!room) return;
  const psychic = isPsychic();
  const target = effectiveTarget(room.rotation);

  document.getElementById('wlRoundLine').textContent = `Round ${room.round} of ${ROUNDS_PER_MATCH}`;
  const pair = room.pair || {left:'',right:''};
  // The two clue words live right above the two ends of the dial itself
  // (like the real board's printed labels), not as a separate line of text
  // floating above the whole wheel.
  document.getElementById('wlPairLeftLabel').textContent = pair.left;
  document.getElementById('wlPairRightLabel').textContent = pair.right;
  document.getElementById('wlRoleLine').textContent = state.isSpectator ? 'Spectating' : (psychic ? "You're the psychic" : "You're guessing");
  document.getElementById('wlScoreboard').innerHTML = Object.entries(room.players||{}).map(([pid,p])=>`<span>${p.name}: ${p.score||0}</span>`).join(' &nbsp; ');

  const showNumbers = state.isSpectator || psychic || room.revealed;
  drawWedges(target, showNumbers);
  setHoodRotation(psychic ? state.localRotation : room.rotation);
  setNeedleVisual(state.localNeedle);
  drawNotches(psychic ? state.notchesTarget : null);

  const handle = document.getElementById('wlNeedleHandle');
  handle.style.display = (!psychic && !state.isSpectator) ? 'block' : 'none';
  const hint = document.getElementById('wlSpinHint');
  hint.style.display = (psychic && !room.spun) ? 'block' : 'none';

  const statusLine = document.getElementById('wlStatusLine');
  if(room.revealed){
    statusLine.textContent = '';
  } else if(state.isSpectator){
    statusLine.textContent = 'Watching this match.';
  } else if(psychic){
    statusLine.textContent = room.locked
      ? (state.hoodOpen <= 0.02
          ? 'Target locked. The tick marks around the rim still show roughly where the zones were.'
          : 'Locked in! Drag the handle back to close the hood.')
      : (room.spun ? 'Drag the hood open to peek -- it locks in as soon as you reach the other side.' : 'Drag anywhere on the wheel to spin it all the way around.');
  } else {
    statusLine.textContent = room.locked
      ? 'Drag the needle, then drag your own hood fully open to lock in your guess.'
      : 'Waiting for the psychic to spin and lock a target.';
  }

  const frac = psychic ? state.hoodOpen : state.guesserHoodOpen;
  applyHoodClip(room.revealed ? 1 : frac);
  setHoodHandlePosition(room.revealed ? 1 : frac);
  const hoodHandleEl = document.getElementById('wlHoodHandle');
  const canDragHood = !state.isSpectator && !room.revealed &&
    (psychic ? (room.spun && !(room.locked && state.hoodOpen <= 0.02)) : (room.locked && state.guesserHoodOpen < 0.98));
  hoodHandleEl.style.display = canDragHood ? 'block' : 'none';

  const resultPanel = document.getElementById('wlResultPanel');
  if(room.revealed && room.lastScore != null){
    const pts = room.lastScore;
    const label = pts===4 ? "Bullseye!" : pts===3 ? "So close!" : pts===2 ? "Close enough!" : "No points that round.";
    resultPanel.innerHTML = `<p class="wl-result-title">${label}</p><p class="wl-result-pts">+${pts} point${pts===1?'':'s'}</p><p class="wl-result-countdown" id="wlCountdownText"></p>`;
    resultPanel.classList.add('show');
    stopCountdown();
    const tick = ()=>{
      const remainMs = Math.max(0, REVEAL_DISPLAY_MS - (Date.now() - (room.revealedAt || Date.now())));
      const secs = Math.ceil(remainMs/1000);
      const el = document.getElementById('wlCountdownText');
      if(el) el.textContent = `Next round in ${secs}s`;
      if(remainMs<=0) stopCountdown();
    };
    tick();
    countdownTimer = setInterval(tick, 250);
  } else {
    resultPanel.classList.remove('show');
    resultPanel.innerHTML = '';
    stopCountdown();
  }
}

// ---------- static page chrome (avatar modal, how-to-play) ----------

document.getElementById('wlNameInput').addEventListener('input', e=>{ state.playerName = e.target.value; });
document.getElementById('wlJoinConfirmBtn').addEventListener('click', confirmJoinModal);
document.getElementById('wlJoinCloseBtn').addEventListener('click', closeJoinModal);
document.querySelectorAll('#wlJoinModal [data-wllayer]').forEach(node=>{
  node.addEventListener('click', ()=>{
    const layer = node.getAttribute('data-wllayer');
    const dir = parseInt(node.getAttribute('data-wldir'), 10);
    const count = effectiveLayerCount(layer);
    avatar[layer] = ((avatar[layer] - 1 + dir + count) % count) + 1;
    if(typeof saveAvatar === 'function') saveAvatar(avatar);
    renderAvatarStage(document.getElementById('wlAvatarStage'), avatar);
  });
});
document.getElementById('wlDiceBtn').addEventListener('click', ()=>{
  avatar.hat = Math.floor(Math.random() * effectiveLayerCount('hat')) + 1;
  avatar.face = Math.floor(Math.random() * effectiveLayerCount('face')) + 1;
  avatar.base = Math.floor(Math.random() * effectiveLayerCount('base')) + 1;
  if(typeof saveAvatar === 'function') saveAvatar(avatar);
  renderAvatarStage(document.getElementById('wlAvatarStage'), avatar);
});

// Drop page-1.png, page-2.png, page-3.png (etc) into
// client/assets/how-to-play-wavelength/ and this just works, same pattern as
// Guess Who's viewer. That folder isn't included in project zips going
// forward since you're managing those images directly yourself now.
const WL_HOW_TO_PLAY_PAGE_COUNT = 3;
let wlHowToPlayPage = 1;
function renderWlHowToPlayPage(){
  document.getElementById('wlHowToPlayImg').src = `assets/how-to-play-wavelength/page-${wlHowToPlayPage}.png`;
  document.getElementById('wlHowToPlayPageCount').textContent = `Page ${wlHowToPlayPage} of ${WL_HOW_TO_PLAY_PAGE_COUNT}`;
  document.getElementById('wlHowToPlayPrevBtn').disabled = wlHowToPlayPage === 1;
  document.getElementById('wlHowToPlayNextBtn').disabled = wlHowToPlayPage === WL_HOW_TO_PLAY_PAGE_COUNT;
}
document.getElementById('wlHowToPlayBtn').addEventListener('click', ()=>{
  wlHowToPlayPage = 1; renderWlHowToPlayPage();
  document.getElementById('wlHowToPlayOverlay').classList.add('active');
});
document.getElementById('wlHowToPlayCloseBtn').addEventListener('click', ()=>{
  document.getElementById('wlHowToPlayOverlay').classList.remove('active');
});
document.getElementById('wlHowToPlayPrevBtn').addEventListener('click', ()=>{
  if(wlHowToPlayPage>1){ wlHowToPlayPage-=1; renderWlHowToPlayPage(); }
});
document.getElementById('wlHowToPlayNextBtn').addEventListener('click', ()=>{
  if(wlHowToPlayPage<WL_HOW_TO_PLAY_PAGE_COUNT){ wlHowToPlayPage+=1; renderWlHowToPlayPage(); }
});
document.getElementById('wlHowToPlayOverlay').addEventListener('click', e=>{
  if(e.target.id==='wlHowToPlayOverlay') e.target.classList.remove('active');
});

render();
