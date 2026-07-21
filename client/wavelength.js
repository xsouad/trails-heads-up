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

const svgns = "http://www.w3.org/2000/svg";
const WHEEL_CX = 200, WHEEL_CY = 200, WHEEL_R = 170, HOOD_R = 185;
const NOTCH_R0 = 190, NOTCH_R1 = 204, RAY_COUNT = 16;
const ROUNDS_PER_MATCH = 7;
const ORANGE = "#F0997B";
const TEAL = "#5DCAA5";
const PURPLE_BAND = "#AFA9EC";

// A grab bag of Trails-themed opposite word pairs for "Random" mode. "Shuffle"
// just draws a new one from here, as many times as the players want before
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

function showWlNotice(text){
  const bar = document.getElementById('wlNoticeBar');
  if(!bar) return;
  const toast = document.createElement('div');
  toast.className = 'notice-toast';
  toast.textContent = text;
  bar.appendChild(toast);
  setTimeout(()=>{ toast.remove(); }, 4500);
}

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
  lastRawAngle: 0,
  draggingWheel: false,
  draggingHood: false,
  draggingNeedle: false,
  notchesTarget: null // set once the psychic locks, so the reference marks survive
};

let roomRef = null;
let lastWriteAt = {};
function throttledSet(path, value, minGapMs){
  const now = Date.now();
  const key = path;
  if(!lastWriteAt[key] || now-lastWriteAt[key] >= minGapMs){
    lastWriteAt[key] = now;
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
      const wasPlaying = state.room && state.room.status;
      state.room = room;
      if(state.screen!=='home' && state.screen!=='opponentLeft'){
        state.screen = room.status;
      }
      // A fresh round (or a fresh pair, in custom mode) means the persistent
      // notches from the previous target are stale -- clear them so the
      // psychic doesn't mistake old marks for the new one.
      if(wasPlaying !== room.status && (room.status==='playing' || room.status==='pairing')){
        state.notchesTarget = null;
        state.hoodOpen = 0;
        state.guesserHoodOpen = 0;
      }
      if(room.status==='playing' && !room.locked){
        state.localRotation = room.rotation;
      }
      if(room.status==='playing'){
        state.localNeedle = room.needleAngle;
      }
      updateRoundFade(room);
      render();
    }
  });
}
function detachRoomListener(){ if(roomRef){ roomRef.off(); roomRef=null; } }

// Instead of the game snapping straight into the next round's fresh layout,
// this fades the whole board to the background color the instant a reveal
// happens, resets underneath while hidden, then fades back in once the new
// round's data has arrived -- no jarring instant reset.
let prevLastScore = undefined;
function updateRoundFade(room){
  const fade = document.getElementById('wlRoundFade');
  if(!fade) return;
  if(room.lastScore != null && prevLastScore == null){
    fade.classList.add('show');
  } else if(room.lastScore == null && prevLastScore != null){
    requestAnimationFrame(()=>{ fade.classList.remove('show'); });
  }
  prevLastScore = room.lastScore;
}

function myPlayer(){
  if(!state.room || !state.room.players) return null;
  return state.room.players[state.playerId] || null;
}
function isPsychic(){
  return !!(state.room && state.room.psychicId === state.playerId);
}
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
  state = Object.assign({}, state, {
    screen:'home', code:null, playerId: genId(), room:null, isSpectator:false,
    joinIntent:null, error:'', hadFullRoom:false, localRotation:90, localNeedle:90,
    hoodOpen:0, guesserHoodOpen:0, notchesTarget:null
  });
  render();
}

// ---------- pairing phase ----------

function setPairMode(mode){
  if(state.isSpectator) return;
  db.ref('wavelength_rooms/' + state.code).update({
    pairMode: mode,
    pair: mode==='random' ? randomPair() : { left:'', right:'' },
    pairReady: null
  });
}
function shuffleRandomPair(){
  if(state.isSpectator) return;
  db.ref('wavelength_rooms/' + state.code + '/pair').set(randomPair());
}
function updateCustomPair(side, value){
  if(state.isSpectator) return;
  db.ref('wavelength_rooms/' + state.code + '/pair/' + side).set(value);
  db.ref('wavelength_rooms/' + state.code + '/pairReady').set(null);
}
function agreeToPair(){
  if(state.isSpectator) return;
  const pair = state.room.pair || {};
  if(!pair.left || !pair.right) return;
  db.ref('wavelength_rooms/' + state.code + '/pairReady/' + state.playerId).set(true);
}
async function startFirstRound(){
  if(state.isSpectator) return;
  const pair = state.room.pair;
  if(!pair || !pair.left || !pair.right) return;
  await db.ref('wavelength_rooms/' + state.code).update({
    status: 'playing', round: 1, psychicId: state.room.hostId,
    rotation: 90, needleAngle: 90, spun: false, locked: false, revealed: false, lastScore: null
  });
}

// ---------- gameplay ----------

function effectiveTarget(rotation){ return properMod(rotation, 180); }

function drawWedges(target, revealNumbers){
  const g = document.getElementById('wlWedges');
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
  const base = document.getElementById('wlHoodBase');
  base.setAttribute('d', sectorPath(0,360,0,HOOD_R));
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
  const d = covered>=180 ? 'M0 0 Z' : sectorPath(covered,180,0,HOOD_R);
  document.getElementById('wlHoodClipPath').setAttribute('d', d);
  document.getElementById('wlHoodBorder').setAttribute('d', covered>=180 ? '' : d);
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
  forceSet('wavelength_rooms/' + state.code + '/locked', true);
  forceSet('wavelength_rooms/' + state.code + '/rotation', state.localRotation);
  render();
}
async function revealAndScore(){
  const room = state.room;
  const target = effectiveTarget(room.rotation);
  const diff = Math.abs(state.localNeedle - target);
  const pts = diff<=4?4:diff<=10?3:diff<=18?2:0;
  const psychicId = room.psychicId;
  const psychicScore = (room.players[psychicId] && room.players[psychicId].score) || 0;
  await db.ref('wavelength_rooms/' + state.code).update({
    revealed: true,
    needleAngle: state.localNeedle,
    lastScore: pts,
    ['players/'+psychicId+'/score']: psychicScore + pts
  });
  setTimeout(advanceRound, 1600);
}
async function advanceRound(){
  const room = state.room;
  if(!room) return;
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
      pair: randomPair()
    });
  } else {
    await db.ref('wavelength_rooms/' + state.code).update({
      status:'pairing', round: nextRound, psychicId: nextPsychic,
      rotation:90, needleAngle:90, spun:false, locked:false, revealed:false,
      pair: { left:'', right:'' }, pairReady: null
    });
  }
}
async function playAgain(){
  if(state.isSpectator) return;
  const ids = Object.keys(state.room.players || {});
  const updates = { status:'pairing', round:0, pair:{left:'',right:''}, pairReady:null };
  ids.forEach(id=>{ updates['players/'+id+'/score'] = 0; });
  await db.ref('wavelength_rooms/' + state.code).update(updates);
}

// ---------- rendering ----------

function render(){
  const root = document.getElementById('wlRoot');
  if(state.screen==='home') root.innerHTML = renderHome();
  else if(state.screen==='lobby') root.innerHTML = renderLobby();
  else if(state.screen==='pairing') root.innerHTML = renderPairing();
  else if(state.screen==='playing') root.innerHTML = renderPlaying();
  else if(state.screen==='complete') root.innerHTML = renderComplete();
  else if(state.screen==='opponentLeft') root.innerHTML = renderOpponentLeft();
  attachHandlers();
}

function renderHome(){
  return `
    <div class="card center">
      <button type="button" class="primary" id="wlCreateBtn">Create Room</button>
      <div class="join-row">
        <input id="wlCodeInput" type="text" placeholder="Room code" maxlength="4" />
        <button type="button" id="wlJoinBtn">Join</button>
      </div>
      <div class="join-row">
        <input id="wlWatchCodeInput" type="text" placeholder="Room code" maxlength="4" />
        <button type="button" class="secondary" id="wlWatchBtn">Watch</button>
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
  const psychic = room.psychicId === state.playerId;
  const ready = room.pairReady || {};
  const bothReady = Object.keys(ready).length>=2 && Object.values(ready).every(Boolean);
  return `
    <div class="card center">
      <p class="hint">Round ${Math.max(1,room.round||1)} of ${ROUNDS_PER_MATCH} &middot; pick a word pair</p>
      <div class="wl-mode-toggle">
        <button type="button" class="wl-mode-btn ${mode==='random'?'active':''}" data-wlpairmode="random" ${state.isSpectator?'disabled':''}>Random suggestions</button>
        <button type="button" class="wl-mode-btn ${mode==='custom'?'active':''}" data-wlpairmode="custom" ${state.isSpectator?'disabled':''}>Agree on your own</button>
      </div>
      ${mode==='random' ? `
        <div class="wl-pair-display">
          <span>${pair.left||'...'}</span><span class="wl-pair-vs">vs</span><span>${pair.right||'...'}</span>
        </div>
        ${state.isSpectator ? '' : `
          <button type="button" class="secondary" id="wlShuffleBtn">Shuffle another pair</button>
          <button type="button" class="primary" id="wlStartRoundBtn">Use this pair</button>
        `}
      ` : `
        <div class="wl-pair-inputs">
          <input type="text" id="wlPairLeft" placeholder="Left word" maxlength="24" value="${(pair.left||'').replace(/"/g,'&quot;')}" ${state.isSpectator?'disabled':''} />
          <input type="text" id="wlPairRight" placeholder="Right word" maxlength="24" value="${(pair.right||'').replace(/"/g,'&quot;')}" ${state.isSpectator?'disabled':''} />
        </div>
        ${state.isSpectator ? '' : `<button type="button" class="secondary" id="wlAgreeBtn" ${ready[state.playerId]?'disabled':''}>${ready[state.playerId] ? 'Waiting on the other player...' : 'I agree to this pair'}</button>`}
        <p class="hint">${bothReady ? 'Both players agreed!' : 'Both players need to agree before the round can start.'}</p>
        ${(bothReady && !state.isSpectator) ? `<button type="button" class="primary" id="wlStartRoundBtn">Start round</button>` : ''}
      `}
    </div>
  `;
}

function renderWheelSvg(){
  return `
    <svg id="wlSvg" viewBox="0 0 400 230" style="width:100%; height:auto; display:block;">
      <defs><clipPath id="wlHoodClip"><path id="wlHoodClipPath"></path></clipPath></defs>
      <g id="wlWedges"></g>
      <g clip-path="url(#wlHoodClip)">
        <path id="wlHoodBase" fill="#3a3260"></path>
        <g id="wlHoodRays"></g>
      </g>
      <path id="wlHoodBorder" fill="none" stroke="var(--border-strong)" stroke-width="1"></path>
      <g id="wlNotches"></g>
      <line id="wlNeedle" x1="200" y1="200" x2="200" y2="30" stroke="#14213d" stroke-width="4" stroke-linecap="round"></line>
      <circle cx="200" cy="200" r="8" fill="#14213d"></circle>
      <circle id="wlNeedleHandle" cx="200" cy="30" r="14" fill="${ORANGE}" stroke="white" stroke-width="2" style="cursor:grab; display:none;"></circle>
      <text id="wlSpinHint" x="200" y="215" text-anchor="middle" font-size="12" fill="var(--text-secondary)">Drag the wheel to spin</text>
    </svg>
    <div id="wlHoodHandle" class="wl-hood-handle" title="Drag to peek">
      <i class="ti ti-arrows-horizontal" aria-hidden="true"></i>
    </div>
  `;
}

function renderPlaying(){
  const room = state.room;
  const psychic = isPsychic();
  const pair = room.pair || {left:'',right:''};
  return `
    <div class="card center">
      <p class="hint">Round ${room.round} of ${ROUNDS_PER_MATCH}</p>
      <div class="wl-pair-display small">
        <span>${pair.left}</span><span class="wl-pair-vs">vs</span><span>${pair.right}</span>
      </div>
      <p class="wl-role-label">${state.isSpectator ? 'Spectating' : (psychic ? "You're the psychic" : "You're guessing")}</p>
      <div class="wl-scoreboard">
        ${Object.entries(room.players||{}).map(([pid,p])=>`<span>${p.name}: ${p.score||0}</span>`).join(' &nbsp; ')}
      </div>
      <div class="wl-wheel-wrap" style="position:relative;">
        ${renderWheelSvg()}
      </div>
      <p class="status" id="wlStatusLine"></p>
      ${room.lastScore!=null ? `<p class="wl-score-toast">${room.lastScore>0 ? 'Scored '+room.lastScore+' points!' : 'No points that round.'} Starting next round...</p>` : ''}
      ${state.isSpectator ? '' : '<button type="button" class="secondary" id="leaveBtn" style="margin-top:14px;">Leave Room</button>'}
    </div>
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

function attachHandlers(){
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
    if(state.room.status==='lobby' || !state.room.round){ startFirstRound(); }
    else {
      db.ref('wavelength_rooms/' + state.code).update({
        status:'playing', rotation:90, needleAngle:90, spun:false, locked:false, revealed:false
      });
    }
  });
  const pairLeft = document.getElementById('wlPairLeft');
  const pairRight = document.getElementById('wlPairRight');
  if(pairLeft) pairLeft.addEventListener('change', e=>updateCustomPair('left', e.target.value));
  if(pairRight) pairRight.addEventListener('change', e=>updateCustomPair('right', e.target.value));
  const agreeBtn = document.getElementById('wlAgreeBtn');
  if(agreeBtn) agreeBtn.addEventListener('click', agreeToPair);

  const playAgainBtn = document.getElementById('wlPlayAgainBtn');
  if(playAgainBtn) playAgainBtn.addEventListener('click', playAgain);

  if(state.screen==='playing') wireWheel();
}

function wireWheel(){
  const room = state.room;
  const svg = document.getElementById('wlSvg');
  if(!svg) return;
  const psychic = isPsychic();
  const target = effectiveTarget(room.rotation);

  buildHoodDecor();
  // The guesser (and any spectator, deliberately, since watching is meant to
  // show everything) always gets the numbers; a plain guesser only gets them
  // after reveal.
  const showNumbers = state.isSpectator || psychic || room.revealed;
  drawWedges(target, showNumbers);
  setHoodRotation(psychic ? state.localRotation : room.rotation);
  setNeedleVisual(state.localNeedle);
  drawNotches(psychic ? state.notchesTarget : null);

  const handle = document.getElementById('wlNeedleHandle');
  handle.style.display = (!psychic && !state.isSpectator) ? 'block' : 'none';
  document.getElementById('wlSpinHint').style.display = (psychic && !room.spun) ? 'block' : 'none';

  const statusLine = document.getElementById('wlStatusLine');
  if(state.isSpectator){
    statusLine.textContent = 'Watching this match.';
  } else if(psychic){
    statusLine.textContent = room.locked
      ? 'Target locked. The tick marks around the rim still show roughly where the zones were.'
      : (room.spun ? 'Drag the hood open to peek, then closed to lock it in.' : 'Drag anywhere on the wheel to spin it all the way around.');
  } else {
    statusLine.textContent = room.locked
      ? 'Drag the needle, then drag your own hood fully open to lock in your guess.'
      : 'Waiting for the psychic to spin and lock a target.';
  }

  const frac = psychic ? state.hoodOpen : state.guesserHoodOpen;
  applyHoodClip(room.revealed ? 1 : frac);

  let draggingWheel=false, lastRaw=0;
  svg.addEventListener('pointerdown', e=>{
    if(!psychic || state.isSpectator || room.locked || e.target.id==='wlNeedleHandle') return;
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
      document.getElementById('wlSpinHint').style.display = 'none';
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

  let draggingNeedle=false;
  handle.addEventListener('pointerdown', e=>{
    if(!room.locked || room.revealed) return;
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

  const hoodHandle = document.getElementById('wlHoodHandle');
  let draggingHood=false, startX=0, startVal=0;
  hoodHandle.addEventListener('pointerdown', e=>{
    if(state.isSpectator) return;
    if(psychic && (!room.spun || room.locked)) return;
    if(!psychic && (!room.locked || room.revealed)) return;
    draggingHood=true; startX=e.clientX; startVal= psychic ? state.hoodOpen : state.guesserHoodOpen;
    hoodHandle.setPointerCapture(e.pointerId); e.preventDefault();
  });
  hoodHandle.addEventListener('pointermove', e=>{
    if(draggingHood){
      const rect = svg.getBoundingClientRect();
      const val = Math.max(0, Math.min(1, startVal + (e.clientX-startX)/rect.width));
      if(psychic) state.hoodOpen = val; else state.guesserHoodOpen = val;
      applyHoodClip(val);
    }
  });
  hoodHandle.addEventListener('pointerup', ()=>{
    if(!draggingHood) return;
    draggingHood=false;
    if(psychic){
      if(state.hoodOpen < 0.15){ state.hoodOpen = 0; applyHoodClip(0); lockTarget(); }
      else { state.hoodOpen = 0; applyHoodClip(0); }
    } else {
      if(state.guesserHoodOpen > 0.92){ state.guesserHoodOpen = 1; applyHoodClip(1); revealAndScore(); }
      else { state.guesserHoodOpen = 0; applyHoodClip(0); }
    }
  });
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
// Guess Who's viewer.
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
