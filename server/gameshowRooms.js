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
    namingTeam: null, // 'teamA' | 'teamB' | null -- whose turn it is to name, sequential not simultaneous
    namingAnnounce: null, // { team, name, at } -- brief "Team X is now Y!" takeover after a team locks in
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
    slot: null, // which of the 3 podium slots on their team (0/1/2)
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

function takenSlots(room, team) {
  const slots = new Set();
  room.players.forEach(p => { if (p.role === team && p.slot != null) slots.add(p.slot); });
  return slots;
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
    player.slot = null;
    room.hostId = socketId;
    room.hostClientId = player.clientId;
    return { room };
  }

  if (role === 'teamA' || role === 'teamB') {
    // Teams lock in once the actual game starts -- no switching podiums or
    // jumping to the other team mid-game. Spectating is still always open.
    if ((room.phase === 'playing' || room.phase === 'finished')) {
      return { error: 'Teams are locked in for this game. You can still spectate.' };
    }
    if (player.role !== role && teamCount(room, role) >= MAX_TEAM_SIZE) {
      return { error: `That team is already full (${MAX_TEAM_SIZE}/${MAX_TEAM_SIZE}).` };
    }
    // Which specific podium (0/1/2) -- picking a taken one (that isn't
    // already yours) is rejected rather than silently bumping someone.
    const taken = takenSlots(room, role);
    let slot = opts.slot;
    if (slot != null) {
      if (slot < 0 || slot > 2) return { error: 'Invalid podium.' };
      if (taken.has(slot) && !(player.role === role && player.slot === slot)) {
        return { error: 'Someone is already standing there.' };
      }
    } else {
      slot = null;
      for (let i = 0; i < MAX_TEAM_SIZE; i++) { if (!taken.has(i)) { slot = i; break; } }
      if (slot == null) return { error: `That team is already full (${MAX_TEAM_SIZE}/${MAX_TEAM_SIZE}).` };
    }
    clearHostIfSelf(room, socketId);
    // Switching teams (or joining fresh) always clears readiness -- a
    // stale "ready" from a different seat shouldn't carry over.
    if (player.role !== role) player.ready = false;
    player.role = role;
    player.seat = null;
    player.slot = slot;
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
    player.slot = null;
    player.ready = false;
    return { room };
  }

  if (role === 'unassigned') {
    clearHostIfSelf(room, socketId);
    player.role = 'unassigned';
    player.seat = null;
    player.slot = null;
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

// Name + avatar are picked together on the "Build Your Character" screen,
// right after joining/creating a room (not on the landing screen), so they
// get saved together too.
function setProfile(room, socketId, name, avatarObj) {
  const player = room.players.get(socketId);
  if (!player) return { error: 'Not in this room.' };
  const clean = (name || '').trim().slice(0, 24);
  if (!clean) return { error: 'Enter a name first.' };
  player.name = clean;
  const avatarResult = setAvatar(room, socketId, avatarObj);
  if (avatarResult.error) return avatarResult;
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
  // Sequential, not simultaneous: Team A names itself completely (submit,
  // then vote) before Team B even starts.
  room.namingTeam = 'teamA';
  room.namingAnnounce = null;
  return { room };
}

function submitNameCandidate(room, socketId, team, text) {
  const t = room[team];
  if (!t || room.phase !== 'naming' || t.locked) return { error: 'Naming is closed for this team.' };
  if (team !== room.namingTeam) return { error: "It's not your team's turn to name yet." };
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
  if (team !== room.namingTeam) return { error: "It's not your team's turn to name yet." };
  const player = room.players.get(socketId);
  if (!player || player.role !== team) return { error: 'Not on this team.' };
  if (!t.candidates[candidateIdx]) return { error: "That option doesn't exist." };
  t.votes[socketId] = candidateIdx;
  return { room };
}

// Everyone on the team has submitted at least one suggestion -- this is
// what flips spectators/the other team over from the "Team X is coming up
// with a name!" takeover to being able to watch the vote screen.
function everyoneSubmitted(room, team) {
  const t = room[team];
  for (const p of room.players.values()) {
    if (p.role === team && !t.candidates.some(c => c.by === p.id)) return false;
  }
  return teamCount(room, team) > 0;
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

function everyoneVoted(room, team) {
  const t = room[team];
  if (!t.candidates.length) return false; // nothing to vote on yet
  for (const p of room.players.values()) {
    if (p.role === team && !(p.id in t.votes)) return false;
  }
  return true;
}

// Locks in whichever team currently has the turn (room.namingTeam), shows a
// brief "Team X is now Y!" takeover, then either hands the turn to Team B
// or -- if Team B just finished -- moves the room on to the ready phase.
function finishNamingPhase(room, socketId) {
  if (room.hostId !== socketId) return { error: 'Only the host can lock in a team name.' };
  const team = room.namingTeam;
  if (!team) return { error: 'Naming is already finished.' };
  if (!everyoneVoted(room, team)) {
    return { error: 'Everyone on this team needs to vote first.' };
  }
  tallyTeamName(room, team);
  room.namingAnnounce = { team, name: room[team].name, at: Date.now() };
  if (team === 'teamA') {
    room.namingTeam = 'teamB';
  } else {
    room.namingTeam = null;
    room.phase = 'ready';
  }
  return { room };
}

// For the landing screen's "Pending Games" list -- rooms still filling up
// (lobby/naming/ready), mirroring Heads Up's public room browser.
// Every room shows here, whatever phase it's in -- a spectator should be
// able to find and join a game in progress from this list too, not just
// before it starts. The client labels "playing"/"finished" differently
// from "waiting for players" so it's clear what you're walking into.
function listPendingRooms() {
  return Array.from(rooms.values())
    .map(r => {
      const host = r.hostId ? r.players.get(r.hostId) : null;
      let teamACount = 0, teamBCount = 0, spectatorCount = 0;
      r.players.forEach(p => {
        if (p.role === 'teamA') teamACount += 1;
        else if (p.role === 'teamB') teamBCount += 1;
        else if (p.role === 'spectator') spectatorCount += 1;
      });
      return {
        code: r.code,
        hostName: host ? host.name : 'No host yet',
        teamACount, teamBCount, spectatorCount,
        phase: r.phase
      };
    });
}

function serialize(room) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: Array.from(room.players.values()),
    teamA: room.teamA,
    teamB: room.teamB,
    namingTeam: room.namingTeam || null,
    namingAnnounce: room.namingAnnounce || null,
    maxTeamSize: MAX_TEAM_SIZE,
    maxSpectatorSeats: MAX_SPECTATOR_SEATS
  };
}

module.exports = {
  createRoom, getRoom, joinRoom, findRoomBySocket, setRole, removeBySocket,
  setAvatar, setProfile, toggleReady, allCompetitorsReady,
  startNamingPhase, submitNameCandidate, voteNameCandidate, finishNamingPhase, everyoneVoted, everyoneSubmitted,
  serialize, listPendingRooms, MAX_TEAM_SIZE, MAX_SPECTATOR_SEATS
};
