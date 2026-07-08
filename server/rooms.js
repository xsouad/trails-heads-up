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

function createRoom(hostSocketId, hostName, hostAvatar) {
  const code = makeCode();
  const room = {
    code,
    hostId: hostSocketId,
    phase: 'lobby', // lobby | playing | ended
    settings: { cutoffTag: 'KAI', categories: ['characters', 'events'] },
    players: new Map() // socketId -> player
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
  if (room.phase !== 'lobby') return { error: 'That room has already started.' };
  if (room.players.size >= 5) return { error: 'That room is full (5 players max).' };
  room.players.set(socketId, { id: socketId, name, avatar, item: null, revealed: false });
  return { room };
}

function leaveRoom(socketId) {
  for (const room of rooms.values()) {
    if (room.players.has(socketId)) {
      room.players.delete(socketId);
      if (room.players.size === 0) {
        rooms.delete(room.code);
        return { room: null };
      }
      if (room.hostId === socketId) {
        room.hostId = room.players.keys().next().value; // promote next player
      }
      return { room };
    }
  }
  return { room: null };
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.has(socketId)) return room;
  }
  return null;
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

function restartRoom(room) {
  room.players.forEach(p => { p.item = null; p.revealed = false; });
  room.phase = 'lobby';
}

// Serializes room state for a specific recipient: hides that player's own item
// unless the room has ended (full reveal), in which case everyone sees everything.
function serializeRoomFor(room, recipientId) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    settings: room.settings,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      revealed: p.revealed,
      item: (p.id !== recipientId || room.phase === 'ended') ? p.item : null,
      isSelf: p.id === recipientId
    })),
    revealedCount: Array.from(room.players.values()).filter(p => p.revealed).length,
    totalPlayers: room.players.size
  };
}

module.exports = { rooms, createRoom, joinRoom, leaveRoom, findRoomBySocket, startGame, revealPlayer, restartRoom, serializeRoomFor };
