const { buildPool } = require('./gameData');

const rooms = new Map(); // code -> room

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function endGameThreshold(n) {
  // "more than half" -- 3 players needs 2, 2 needs 2, 4 needs 3, 5 needs 3
  return Math.floor(n / 2) + 1;
}

function createRoom(hostSocketId, hostName, hostAvatar, visibility) {
  const code = makeCode();
  const room = {
    code,
    hostId: hostSocketId,
    phase: 'lobby', // lobby | playing | ended
    visibility: visibility === 'public' ? 'public' : 'private',
    settings: { cutoffTag: 'KAI', categories: ['characters', 'events'] },
    players: new Map(),   // socketId -> player
    spectators: new Map(), // socketId -> { id, name }
    endGameVotes: new Set(),
    rematchRequested: false,
    rematchResponses: new Set()
  };
  room.players.set(hostSocketId, {
    id: hostSocketId, name: hostName, avatar: hostAvatar,
    item: null, revealed: false
  });
  rooms.set(code, room);
  return room;
}

function joinRoom(code, socketId, name, avatar) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found.' };
  if (room.phase !== 'lobby') return { error: 'That room has already started. You can join as a spectator instead if it\'s public.' };
  if (room.players.size >= 5) return { error: 'That room is full (5 players max).' };
  room.players.set(socketId, { id: socketId, name, avatar, item: null, revealed: false });
  return { room };
}

function joinAsSpectator(code, socketId, name) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found.' };
  if (room.visibility !== 'public') return { error: 'That room is private.' };
  room.spectators.set(socketId, { id: socketId, name: name || 'Spectator' });
  return { room };
}

function listPublicRooms() {
  return Array.from(rooms.values())
    .filter(r => r.visibility === 'public')
    .map(r => ({
      code: r.code,
      hostName: (r.players.get(r.hostId) || {}).name || 'Unknown host',
      playerCount: r.players.size,
      spectatorCount: r.spectators.size,
      phase: r.phase
    }));
}

// Removes a socket (player or spectator) from whatever room it's in.
// Returns { room, leftName, wasSpectator } -- room is null if the room no longer exists.
function leaveRoom(socketId) {
  for (const room of rooms.values()) {
    if (room.players.has(socketId)) {
      const leftName = room.players.get(socketId).name;
      room.players.delete(socketId);
      room.endGameVotes.delete(socketId);
      room.rematchResponses.delete(socketId);
      if (room.players.size === 0 && room.spectators.size === 0) {
        rooms.delete(room.code);
        return { room: null, leftName, wasSpectator: false };
      }
      if (room.hostId === socketId && room.players.size > 0) {
        room.hostId = room.players.keys().next().value; // promote next player
      }
      // If a rematch was pending and everyone remaining has now said yes, auto-start.
      maybeResolveRematch(room);
      return { room, leftName, wasSpectator: false };
    }
    if (room.spectators.has(socketId)) {
      const leftName = room.spectators.get(socketId).name;
      room.spectators.delete(socketId);
      if (room.players.size === 0 && room.spectators.size === 0) {
        rooms.delete(room.code);
        return { room: null, leftName, wasSpectator: true };
      }
      return { room, leftName, wasSpectator: true };
    }
  }
  return { room: null, leftName: null, wasSpectator: false };
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.has(socketId) || room.spectators.has(socketId)) return room;
  }
  return null;
}

function isSpectator(room, socketId) {
  return room.spectators.has(socketId);
}

function startGame(room) {
  const pool = buildPool(room.settings.cutoffTag, room.settings.categories);
  const playerIds = Array.from(room.players.keys());
  if (pool.length < playerIds.length) {
    return { error: `Not enough content for ${playerIds.length} players with the current cutoff/category settings (only ${pool.length} available). Pick a later cutoff or add a category.` };
  }
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  playerIds.forEach((id, i) => {
    const player = room.players.get(id);
    player.item = shuffled[i];
    player.revealed = false;
  });
  room.phase = 'playing';
  room.endGameVotes.clear();
  room.rematchRequested = false;
  room.rematchResponses.clear();
  return { room };
}

function revealPlayer(room, socketId) {
  const player = room.players.get(socketId);
  if (!player) return;
  player.revealed = true;
  const total = room.players.size;
  const revealedCount = Array.from(room.players.values()).filter(p => p.revealed).length;
  if (revealedCount >= total) {
    room.phase = 'ended';
  }
  return { revealedCount, total, ended: room.phase === 'ended' };
}

// Returns { votes, needed, ended }. If threshold is met, the room is deleted
// and `ended: true` is returned so the caller can notify everyone before removing them.
function voteEndGame(room, socketId) {
  if (room.endGameVotes.has(socketId)) room.endGameVotes.delete(socketId);
  else room.endGameVotes.add(socketId);
  const total = room.players.size;
  const needed = endGameThreshold(total);
  const votes = room.endGameVotes.size;
  const ended = votes >= needed;
  if (ended) rooms.delete(room.code);
  return { votes, needed, ended };
}

function requestRematch(room) {
  room.rematchRequested = true;
  room.rematchResponses.clear();
}

function respondRematch(room, socketId) {
  room.rematchResponses.add(socketId);
  return maybeResolveRematch(room);
}

// If a rematch is pending and every current player has said yes, start a new round.
function maybeResolveRematch(room) {
  if (!room.rematchRequested) return { started: false };
  const playerIds = Array.from(room.players.keys());
  const allIn = playerIds.length > 0 && playerIds.every(id => room.rematchResponses.has(id));
  if (allIn) {
    room.rematchRequested = false;
    room.rematchResponses.clear();
    const result = startGame(room);
    return { started: true, error: result.error };
  }
  return { started: false };
}

function restartRoom(room) {
  // Returns to the lobby without a full rematch vote (used if needed programmatically).
  room.players.forEach(p => { p.item = null; p.revealed = false; });
  room.phase = 'lobby';
  room.rematchRequested = false;
  room.rematchResponses.clear();
  room.endGameVotes.clear();
}

// Serializes room state for a specific recipient.
// - Players: their own item is hidden unless the room has ended.
// - Spectators: always see every item, no matter the phase.
function serializeRoomFor(room, recipientId) {
  const spectating = room.spectators.has(recipientId);
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    visibility: room.visibility,
    settings: room.settings,
    isSpectator: spectating,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      revealed: p.revealed,
      item: (spectating || room.phase === 'ended' || p.id !== recipientId) ? p.item : null,
      isSelf: p.id === recipientId
    })),
    revealedCount: Array.from(room.players.values()).filter(p => p.revealed).length,
    totalPlayers: room.players.size,
    spectatorCount: room.spectators.size,
    endGameVotes: room.endGameVotes.size,
    endGameNeeded: endGameThreshold(room.players.size),
    youVotedEndGame: room.endGameVotes.has(recipientId),
    rematchRequested: room.rematchRequested,
    rematchYes: Array.from(room.rematchResponses)
  };
}

module.exports = {
  rooms, createRoom, joinRoom, joinAsSpectator, listPublicRooms, leaveRoom,
  findRoomBySocket, isSpectator, startGame, revealPlayer, voteEndGame,
  requestRematch, respondRematch, restartRoom, serializeRoomFor
};
