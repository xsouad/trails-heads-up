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

function createRoom(hostSocketId, hostName, hostAvatar, visibility, clientId) {
  const code = makeCode();
  const room = {
    code,
    hostId: hostSocketId,
    phase: 'lobby', // lobby | playing | ended
    visibility: visibility === 'public' ? 'public' : 'private',
    // No default cutoff/categories on purpose -- the host must explicitly pick
    // both before the first game in this room can start. This is what closes the
    // hole where a room could silently start with the full spoiler range (KAI)
    // just because nobody happened to click a cutoff chip.
    settings: { cutoffTag: null, categories: [] },
    players: new Map(),   // socketId -> player
    spectators: new Map(), // socketId -> { id, name }
    endGameVotes: new Set(),
    rematchRequested: false,
    rematchResponses: new Set(),
    // targetPlayerId -> Set of voter socket ids who've approved redrawing that
    // player's card (see requestRedraw below).
    redrawVotes: new Map()
  };
  room.players.set(hostSocketId, {
    id: hostSocketId, name: hostName, avatar: hostAvatar,
    item: null, revealed: false,
    clientId: clientId || null, disconnected: false, disconnectedAt: null
  });
  rooms.set(code, room);
  return room;
}

function joinRoom(code, socketId, name, avatar, clientId) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found.' };
  if (room.phase !== 'lobby') return { error: 'That room has already started. You can join as a spectator instead if it\'s public.' };
  if (room.players.size >= 5) return { error: 'That room is full (5 players max).' };
  room.players.set(socketId, {
    id: socketId, name, avatar, item: null, revealed: false,
    clientId: clientId || null, disconnected: false, disconnectedAt: null
  });
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
      room.redrawVotes.delete(socketId);
      room.redrawVotes.forEach(voteSet => voteSet.delete(socketId));
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

// Finds a player anywhere in the room by their persistent clientId (survives a
// socket reconnect, unlike socket.id).
function findPlayerByClientId(room, clientId) {
  if (!clientId) return null;
  for (const p of room.players.values()) {
    if (p.clientId === clientId) return p;
  }
  return null;
}

// Soft-disconnect: mark a player as temporarily gone without removing them from
// the room. This is what lets a brief mobile backgrounding (locking the phone,
// answering a text) avoid immediately showing up as "X left the room" to everyone
// else -- the caller is expected to start a grace-period timer and only actually
// remove them (via leaveRoom) if they haven't reconnected by the time it expires.
function markPlayerDisconnected(socketId) {
  for (const room of rooms.values()) {
    const player = room.players.get(socketId);
    if (player) {
      player.disconnected = true;
      player.disconnectedAt = Date.now();
      return { room, player };
    }
  }
  return null;
}

// Reunites a returning browser tab with its existing player slot, matched by the
// persistent clientId the browser sends rather than the transient socket id
// (which is different after every reconnect). Re-keys the player's Map entry to
// the new socket id and clears the disconnected flag.
function reconnectPlayer(code, clientId, newSocketId, name, avatar) {
  const room = rooms.get((code || '').toUpperCase());
  if (!room) return { error: 'Room not found.' };
  const player = findPlayerByClientId(room, clientId);
  if (!player) return { error: 'No matching player in that room.' };
  const oldSocketId = player.id;
  if (oldSocketId !== newSocketId) {
    room.players.delete(oldSocketId);
    if (room.hostId === oldSocketId) room.hostId = newSocketId;
    player.id = newSocketId;
    room.players.set(newSocketId, player);
  }
  player.disconnected = false;
  player.disconnectedAt = null;
  if (name) player.name = name;
  if (avatar) player.avatar = avatar;
  return { room, player };
}

// Same idea as leaveRoom, but matched by clientId instead of socket id. Used to
// clean up a stale "still disconnected" ghost entry if the same browser starts
// fresh in a brand new room before the old room's grace-period timer has fired.
function removePlayerByClientId(clientId) {
  if (!clientId) return { room: null, leftName: null, wasSpectator: false };
  for (const room of rooms.values()) {
    for (const [sid, p] of room.players.entries()) {
      if (p.clientId === clientId) return leaveRoom(sid);
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

// True Fisher-Yates shuffle. The old `array.sort(() => Math.random() - 0.5)`
// trick looks random but is NOT uniformly distributed -- V8's sort algorithm
// (and most engines') reuses comparisons in ways that bias the result, especially
// on small arrays, which is exactly why some characters kept turning up far more
// often than others (or several rounds in a row) while others never appeared.
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startGame(room) {
  if (!room.settings.cutoffTag) {
    return { error: 'Pick a spoiler cutoff before starting.' };
  }
  if (!room.settings.categories || room.settings.categories.length === 0) {
    return { error: 'Pick at least one category (characters or events) before starting.' };
  }
  const pool = buildPool(room.settings.cutoffTag, room.settings.categories);
  const playerIds = Array.from(room.players.keys());
  if (pool.length < playerIds.length) {
    return { error: `Not enough content for ${playerIds.length} players with the current cutoff/category settings (only ${pool.length} available). Pick a later cutoff or add a category.` };
  }
  const shuffled = shuffleArray(pool);
  playerIds.forEach((id, i) => {
    const player = room.players.get(id);
    player.item = shuffled[i];
    player.revealed = false;
  });
  room.phase = 'playing';
  room.startedAt = Date.now();
  room.endGameVotes.clear();
  room.rematchRequested = false;
  room.rematchResponses.clear();
  room.redrawVotes.clear();
  // Fresh round, fresh start -- clear any prank swap from a previous round so
  // it doesn't carry over into the next one.
  room.players.forEach(p => { if (p.avatar && p.avatar.prank) p.avatar.prank = false; });
  return { room };
}

// How long after a round starts players are allowed to request a redraw for
// someone. Kept in sync with the 30s window shown/greyed-out on the client.
const REDRAW_WINDOW_MS = 30000;

function itemKey(item) {
  return item ? `${item.type}:${item.name}` : null;
}

// Lets any player OTHER than the target flag that the target's card looks like
// a repeat from an earlier round (the target can't see their own card, so they
// can't know -- only the people looking at it floating above their head can).
// Requires every other player in the room (everyone except the target) to
// approve before the redraw actually happens, and only works within the first
// REDRAW_WINDOW_MS of the round.
function requestRedraw(room, targetId, voterId) {
  if (room.phase !== 'playing') return { error: 'Redraws only work during an active round.' };
  if (!room.startedAt || Date.now() - room.startedAt > REDRAW_WINDOW_MS) {
    return { error: 'The redraw window for this round has closed.' };
  }
  if (voterId === targetId) return { error: "You can't request a redraw for your own card." };
  const target = room.players.get(targetId);
  const voter = room.players.get(voterId);
  if (!target || !voter) return { error: 'Player not found.' };

  if (!room.redrawVotes.has(targetId)) room.redrawVotes.set(targetId, new Set());
  const votes = room.redrawVotes.get(targetId);
  votes.add(voterId);

  const otherIds = Array.from(room.players.keys()).filter(id => id !== targetId);
  const needed = otherIds.length;
  const approved = needed > 0 && otherIds.every(id => votes.has(id));

  if (!approved) {
    return { votes: votes.size, needed, approved: false };
  }

  // Everyone else agreed -- redraw the target into a new item that's not
  // currently held by anyone else in the room (including their own old item).
  const pool = buildPool(room.settings.cutoffTag, room.settings.categories);
  const heldKeys = new Set(Array.from(room.players.values()).map(p => itemKey(p.item)));
  const candidates = pool.filter(item => !heldKeys.has(itemKey(item)));
  room.redrawVotes.delete(targetId);
  if (candidates.length === 0) {
    return { error: 'No unique items left to redraw into.', approved: false };
  }
  const shuffled = shuffleArray(candidates);
  target.item = shuffled[0];
  target.revealed = false;
  return { votes: 0, needed, approved: true, targetName: target.name };
}

// Turns anyone currently on face_6 into the prank avatar. face_6 is only
// reachable via the SPINSTELLE cheat (see client/app.js), so this is meant to
// be triggered as the follow-up to that -- see the VANISVAN cheat handler in
// server.js. Returns the list of affected player names.
function applyPrankSwap(room) {
  const affected = [];
  room.players.forEach(p => {
    if (p.avatar && p.avatar.face === 6 && !p.avatar.prank) {
      p.avatar = Object.assign({}, p.avatar, { prank: true });
      affected.push(p.name);
    }
  });
  return affected;
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
  room.redrawVotes.clear();
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
    startedAt: room.startedAt || null,
    visibility: room.visibility,
    settings: room.settings,
    isSpectator: spectating,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      revealed: p.revealed,
      disconnected: !!p.disconnected,
      item: (spectating || room.phase === 'ended' || p.id !== recipientId) ? p.item : null,
      isSelf: p.id === recipientId,
      redrawVotes: room.redrawVotes.has(p.id) ? Array.from(room.redrawVotes.get(p.id)) : [],
      redrawNeeded: Math.max(0, room.players.size - 1)
    })),
    redrawWindowMs: REDRAW_WINDOW_MS,
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
  requestRematch, respondRematch, restartRoom, serializeRoomFor,
  findPlayerByClientId, markPlayerDisconnected, reconnectPlayer, removePlayerByClientId,
  requestRedraw, REDRAW_WINDOW_MS, applyPrankSwap
};
