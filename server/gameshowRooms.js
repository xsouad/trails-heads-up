// In-memory room state for the Gameshow lobby: joining, role selection
// (Host / Team A / Team B / Spectator with seats), and the team-naming
// minigame. This is the "everyone joins, picks a position" slice -- the
// actual board (quotes/trivia/screenshots, hints, steal) is a separate,
// later piece per the spec.

const MAX_TEAM_SIZE = 3;
const MAX_SPECTATOR_SEATS = 8; // 2 even rows of 4
const HOST_PASSWORD = 'VANISVAN';

const rooms = new Map(); // code -> room

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newRoom(code) {
  return {
    code,
    hostId: null,
    hostClientId: null,
    players: new Map(), // socketId -> { id, name, avatar, clientId, role, seat }
    teamA: { name: null, locked: false, candidates: [], votes: {} },
    teamB: { name: null, locked: false, candidates: [], votes: {} },
    phase: 'lobby', // lobby -> naming -> ready
    createdAt: Date.now()
  };
}

function createRoom() {
  const code = makeCode();
  const room = newRoom(code);
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get((code || '').toUpperCase()) || null;
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.has(socketId)) return room;
  }
  return null;
}

function joinRoom(code, socketId, name, avatar, clientId) {
  const room = getRoom(code);
  if (!room) return { error: "That room code doesn't exist." };
  room.players.set(socketId, {
    id: socketId,
    name: (name || 'Player').slice(0, 24),
    // Same layered base/face/hat avatar system as Heads Up/Guess Who
    // (see avatar-shared.js) -- not a color swatch.
    avatar: avatar || { base: 1, face: 1, hat: 1 },
    clientId,
    role: 'unassigned',
    seat: null,
    ready: false
  });
  return { room };
}

function teamCount(room, team) {
  let n = 0;
  room.players.forEach(p => { if (p.role === team) n += 1; });
  return n;
}

function takenSeats(room) {
  const seats = new Set();
  room.players.forEach(p => { if (p.role === 'spectator' && p.seat != null) seats.add(p.seat); });
  return seats;
}

function clearHostIfSelf(room, socketId) {
  if (room.hostId === socketId) { room.hostId = null; room.hostClientId = null; }
}

function setRole(room, socketId, role, opts = {}) {
  const player = room.players.get(socketId);
  if (!player) return { error: 'Not in this room.' };

  if (role === 'host') {
    if (opts.password !== HOST_PASSWORD) return { error: 'Wrong password.' };
    if (room.hostId && room.hostId !== socketId) return { error: 'This room already has a host.' };
    player.role = 'host';
    player.seat = null;
    room.hostId = socketId;
    room.hostClientId = player.clientId;
    return { room };
  }

  if (role === 'teamA' || role === 'teamB') {
    if (player.role !== role && teamCount(room, role) >= MAX_TEAM_SIZE) {
      return { error: `That team is already full (${MAX_TEAM_SIZE}/${MAX_TEAM_SIZE}).` };
    }
    clearHostIfSelf(room, socketId);
    // Switching teams (or joining fresh) always clears readiness -- a
    // stale "ready" from a different seat shouldn't carry over.
    if (player.role !== role) player.ready = false;
    player.role = role;
    player.seat = null;
    return { room };
  }

  if (role === 'spectator') {
    const taken = takenSeats(room);
    let seat = opts.seat;
    if (seat != null) {
      if (seat < 1 || seat > MAX_SPECTATOR_SEATS) return { error: 'Invalid seat.' };
      if (taken.has(seat) && player.seat !== seat) return { error: 'That seat is taken.' };
    } else {
      seat = null;
      for (let i = 1; i <= MAX_SPECTATOR_SEATS; i++) { if (!taken.has(i)) { seat = i; break; } }
      if (seat == null) return { error: 'All spectator seats are full.' };
    }
    clearHostIfSelf(room, socketId);
    player.role = 'spectator';
    player.seat = seat;
    player.ready = false;
    return { room };
  }

  if (role === 'unassigned') {
    clearHostIfSelf(room, socketId);
    player.role = 'unassigned';
    player.seat = null;
    player.ready = false;
    return { room };
  }

  return { error: 'Unknown role.' };
}

function setAvatar(room, socketId, avatarObj) {
  const player = room.players.get(socketId);
  if (!player) return { error: 'Not in this room.' };
  if (!avatarObj || typeof avatarObj !== 'object') return { error: 'Invalid avatar.' };
  player.avatar = {
    base: avatarObj.base || 1,
    face: avatarObj.face || 1,
    hat: avatarObj.hat || 1
  };
  return { room };
}

function toggleReady(room, socketId) {
  const player = room.players.get(socketId);
  if (!player) return { error: 'Not in this room.' };
  if (player.role !== 'teamA' && player.role !== 'teamB') {
    return { error: 'Only competitors need to ready up.' };
  }
  player.ready = !player.ready;
  return { room };
}

function allCompetitorsReady(room) {
  let anyCompetitor = false;
  for (const p of room.players.values()) {
    if (p.role === 'teamA' || p.role === 'teamB') {
      anyCompetitor = true;
      if (!p.ready) return false;
    }
  }
  return anyCompetitor;
}

function removeBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.has(socketId)) {
      const player = room.players.get(socketId);
      room.players.delete(socketId);
      if (room.hostId === socketId) { room.hostId = null; room.hostClientId = null; }
      if (room.players.size === 0) rooms.delete(room.code);
      return { room, leftName: player.name, wasHost: player.role === 'host' };
    }
  }
  return {};
}

// ---------- team naming minigame ----------

function startNamingPhase(room, socketId) {
  if (room.hostId !== socketId) return { error: 'Only the host can start the naming round.' };
  if (teamCount(room, 'teamA') < 1 || teamCount(room, 'teamB') < 1) {
    return { error: 'Both teams need at least 1 member first.' };
  }
  if (!allCompetitorsReady(room)) {
    return { error: 'Not everyone has readied up yet.' };
  }
  room.phase = 'naming';
  room.teamA = { name: null, locked: false, candidates: [], votes: {} };
  room.teamB = { name: null, locked: false, candidates: [], votes: {} };
  return { room };
}

function submitNameCandidate(room, socketId, team, text) {
  const t = room[team];
  if (!t || room.phase !== 'naming' || t.locked) return { error: 'Naming is closed for this team.' };
  const player = room.players.get(socketId);
  if (!player || player.role !== team) return { error: 'Not on this team.' };
  const clean = (text || '').trim().slice(0, 30);
  if (!clean) return { error: 'Enter a name first.' };
  const existingIdx = t.candidates.findIndex(c => c.by === socketId);
  if (existingIdx >= 0) t.candidates[existingIdx].text = clean;
  else t.candidates.push({ by: socketId, byName: player.name, text: clean });
  return { room };
}

function voteNameCandidate(room, socketId, team, candidateIdx) {
  const t = room[team];
  if (!t || room.phase !== 'naming' || t.locked) return { error: 'Naming is closed for this team.' };
  const player = room.players.get(socketId);
  if (!player || player.role !== team) return { error: 'Not on this team.' };
  if (!t.candidates[candidateIdx]) return { error: "That option doesn't exist." };
  t.votes[socketId] = candidateIdx;
  return { room };
}

function tallyTeamName(room, team) {
  const t = room[team];
  if (!t.candidates.length) { t.locked = true; return; }
  const tally = {};
  Object.values(t.votes).forEach(idx => { tally[idx] = (tally[idx] || 0) + 1; });
  let bestIdx = 0, bestVotes = -1;
  t.candidates.forEach((c, idx) => {
    const v = tally[idx] || 0;
    if (v > bestVotes) { bestVotes = v; bestIdx = idx; }
  });
  t.name = t.candidates[bestIdx].text;
  t.locked = true;
}

function finishNamingPhase(room, socketId) {
  if (room.hostId !== socketId) return { error: 'Only the host can lock in team names.' };
  tallyTeamName(room, 'teamA');
  tallyTeamName(room, 'teamB');
  room.phase = 'ready';
  return { room };
}

function serialize(room) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: Array.from(room.players.values()),
    teamA: room.teamA,
    teamB: room.teamB,
    maxTeamSize: MAX_TEAM_SIZE,
    maxSpectatorSeats: MAX_SPECTATOR_SEATS
  };
}

module.exports = {
  createRoom, getRoom, joinRoom, findRoomBySocket, setRole, removeBySocket,
  setAvatar, toggleReady, allCompetitorsReady,
  startNamingPhase, submitNameCandidate, voteNameCandidate, finishNamingPhase,
  serialize, MAX_TEAM_SIZE, MAX_SPECTATOR_SEATS
};
