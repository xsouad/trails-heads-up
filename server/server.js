const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { gameOrder } = require('./gameData');
const {
  createRoom, joinRoom, joinAsSpectator, listPublicRooms, leaveRoom,
  findRoomBySocket, isSpectator, startGame, revealPlayer, voteEndGame,
  requestRematch, respondRematch, serializeRoomFor,
  markPlayerDisconnected, reconnectPlayer, removePlayerByClientId
} = require('./rooms');

function log(...args) { console.log(new Date().toISOString(), ...args); }

const app = express();
const server = http.createServer(app);
// Ping timing: generous enough that a phone screen locking or a few seconds of
// spotty signal doesn't even register as a drop at the transport level. Actual
// drops (closed tab, real disconnect) are further covered by the grace-period
// soft-disconnect handling below, which is what makes brief app-switching on
// mobile not show up as "X left the room".
const io = new Server(server, {
  pingInterval: 20000,
  pingTimeout: 20000
});

// clientId -> pending removal timeout. A player who drops isn't removed from
// their room right away; they're marked "disconnected" and get a grace window
// to reconnect (matched by clientId, which survives a socket.io reconnect,
// unlike socket.id) before they're actually removed and everyone is notified.
const DISCONNECT_GRACE_MS = 45000;
const pendingRemovals = new Map();

function cancelPendingRemoval(clientId) {
  if (!clientId) return;
  const timer = pendingRemovals.get(clientId);
  if (timer) { clearTimeout(timer); pendingRemovals.delete(clientId); }
}

app.use(express.static(path.join(__dirname, '../client')));

function broadcastRoom(room) {
  log('BROADCAST', room.code, 'players:', room.players.size, 'spectators:', room.spectators.size, 'ids:', Array.from(room.players.keys()));
  room.players.forEach((player, socketId) => {
    io.to(socketId).emit('roomState', serializeRoomFor(room, socketId));
  });
  room.spectators.forEach((spec, socketId) => {
    io.to(socketId).emit('roomState', serializeRoomFor(room, socketId));
  });
}

function notifyRoom(room, text) {
  room.players.forEach((p, socketId) => io.to(socketId).emit('notice', { text }));
  room.spectators.forEach((s, socketId) => io.to(socketId).emit('notice', { text }));
}

io.on('connection', (socket) => {
  log('CONNECT', socket.id);
  socket.emit('gameOrder', gameOrder);

  // A socket must never belong to more than one room at a time. Anything that puts a
  // socket into a room (create/join/spectate) calls this first to clean up any prior
  // membership -- this is what prevents someone ending up "host of two rooms at once"
  // or a stale player entry lingering in a room they've since left behind.
  function leaveAnyCurrentRoom(clientId) {
    const result = leaveRoom(socket.id);
    if (result.room && result.leftName) {
      log('AUTO-LEFT prior room before join/create', socket.id, 'room:', result.room.code, 'remaining players:', result.room.players.size);
      notifyRoom(result.room, result.wasSpectator ? `${result.leftName} stopped spectating.` : `${result.leftName} left the room.`);
      broadcastRoom(result.room);
    }
    // Also clean up any soft-disconnected ghost slot left behind under a stale
    // socket id for this same browser -- e.g. they backgrounded the tab on their
    // old room, then deliberately created/joined a different one before the old
    // room's grace-period timer fired.
    if (clientId) {
      cancelPendingRemoval(clientId);
      const ghost = removePlayerByClientId(clientId);
      if (ghost.room && ghost.leftName) {
        notifyRoom(ghost.room, ghost.wasSpectator ? `${ghost.leftName} stopped spectating.` : `${ghost.leftName} left the room.`);
        broadcastRoom(ghost.room);
      }
    }
    Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });
  }

  socket.on('listPublicRooms', (_, cb) => {
    cb && cb(listPublicRooms());
  });

  socket.on('createRoom', ({ name, avatar, visibility, clientId }, cb) => {
    leaveAnyCurrentRoom(clientId);
    const room = createRoom(socket.id, name || 'Player', avatar, visibility, clientId);
    socket.join(room.code);
    log('CREATE ROOM', room.code, 'host:', socket.id, 'name:', name);
    cb && cb({ ok: true, code: room.code });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ code, name, avatar, clientId }, cb) => {
    leaveAnyCurrentRoom(clientId);
    const result = joinRoom((code || '').toUpperCase(), socket.id, name || 'Player', avatar, clientId);
    if (result.error) { log('JOIN FAILED', socket.id, 'code:', code, 'error:', result.error); cb && cb({ ok: false, error: result.error }); return; }
    socket.join(result.room.code);
    log('JOIN OK', socket.id, 'name:', name, 'room:', result.room.code, 'player count now:', result.room.players.size, 'ids:', Array.from(result.room.players.keys()));
    cb && cb({ ok: true, code: result.room.code });
    broadcastRoom(result.room);
    notifyRoom(result.room, `${name || 'Player'} joined the room.`);
  });

  socket.on('joinAsSpectator', ({ code, name }, cb) => {
    leaveAnyCurrentRoom();
    const result = joinAsSpectator((code || '').toUpperCase(), socket.id, name || 'Spectator');
    if (result.error) { cb && cb({ ok: false, error: result.error }); return; }
    socket.join(result.room.code);
    cb && cb({ ok: true, code: result.room.code });
    broadcastRoom(result.room);
    notifyRoom(result.room, `${name || 'Spectator'} started spectating.`);
  });

  // A returning browser tab (reconnected after a soft disconnect, or just a plain
  // refresh) uses this to reclaim its existing player slot instead of the app
  // treating it as a brand new stranger. Matched by clientId, which the client
  // persists in localStorage and keeps sending across reconnects.
  socket.on('rejoin', ({ code, clientId, name, avatar }, cb) => {
    if (!code || !clientId) { cb && cb({ ok: false, error: 'Missing room code or client id.' }); return; }
    cancelPendingRemoval(clientId);
    const result = reconnectPlayer(code, clientId, socket.id, name, avatar);
    if (result.error) {
      log('REJOIN FAILED', socket.id, 'code:', code, 'clientId:', clientId, 'error:', result.error);
      cb && cb({ ok: false, error: result.error });
      return;
    }
    socket.join(result.room.code);
    log('REJOIN OK', socket.id, 'room:', result.room.code, 'clientId:', clientId);
    cb && cb({ ok: true });
    broadcastRoom(result.room);
  });

  socket.on('updateAvatar', ({ avatar }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || isSpectator(room, socket.id)) return;
    const player = room.players.get(socket.id);
    if (player) player.avatar = avatar;
    broadcastRoom(room);
  });

  socket.on('updateSettings', ({ cutoffTag, categories }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (cutoffTag) room.settings.cutoffTag = cutoffTag;
    if (categories) room.settings.categories = categories;
    log('UPDATE SETTINGS', room.code, 'now:', JSON.stringify(room.settings));
    broadcastRoom(room);
  });

  socket.on('startGame', (_, cb) => {
    const room = findRoomBySocket(socket.id);
    if (!room) { cb && cb({ ok: false, error: "You're not in a room right now. Please rejoin using the room code." }); return; }
    if (room.hostId !== socket.id) { cb && cb({ ok: false, error: 'Only the host can start the game.' }); return; }
    if (room.players.size < 2) { cb && cb({ ok: false, error: 'You need at least 2 players to start a game.' }); return; }
    log('START GAME requested', room.code, 'settings at start time:', JSON.stringify(room.settings));
    const result = startGame(room);
    if (result.error) { cb && cb({ ok: false, error: result.error }); return; }
    const assigned = Array.from(room.players.values()).map(p => ({ name: p.item && p.item.name, type: p.item && p.item.type, tag: p.item && p.item.tag }));
    log('START GAME assigned items', room.code, JSON.stringify(assigned));
    cb && cb({ ok: true });
    broadcastRoom(room);
  });

  socket.on('reveal', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'playing' || isSpectator(room, socket.id)) return;
    revealPlayer(room, socket.id);
    broadcastRoom(room);
  });

  socket.on('requestRematch', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id || room.phase !== 'ended') return;
    requestRematch(room);
    broadcastRoom(room);
  });

  socket.on('respondRematch', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || isSpectator(room, socket.id)) return;
    const result = respondRematch(room, socket.id);
    broadcastRoom(room);
    if (result && result.started && result.error) {
      io.to(socket.id).emit('notice', { text: `Couldn't start rematch: ${result.error}` });
    }
  });

  socket.on('voteEndGame', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || isSpectator(room, socket.id)) return;
    const result = voteEndGame(room, socket.id);
    if (result.ended) {
      notifyRoom(room, 'The room has been closed -- enough players voted to end the game.');
      room.players.forEach((p, sid) => io.to(sid).emit('roomClosed'));
      room.spectators.forEach((s, sid) => io.to(sid).emit('roomClosed'));
    } else {
      broadcastRoom(room);
    }
  });

  socket.on('kickPlayer', ({ targetId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (!targetId || targetId === socket.id || !room.players.has(targetId)) return;
    const kickedName = room.players.get(targetId).name;
    io.to(targetId).emit('kicked');
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) targetSocket.leave(room.code);
    const result = leaveRoom(targetId);
    if (result.room) {
      notifyRoom(result.room, `${kickedName} was removed from the room by the host.`);
      broadcastRoom(result.room);
    }
  });

  socket.on('leaveRoom', () => {
    handleLeave(socket, true);
  });

  socket.on('disconnect', (reason) => {
    log('DISCONNECT', socket.id, 'reason:', reason);
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    if (isSpectator(room, socket.id)) {
      // Spectators don't hold any hidden game state, so there's nothing worth
      // protecting with a grace period -- just drop them like before.
      handleLeave(socket, false);
      return;
    }
    const result = markPlayerDisconnected(socket.id);
    if (!result) return;
    const { room: r, player } = result;
    log('SOFT DISCONNECT, grace period started', socket.id, 'room:', r.code, 'clientId:', player.clientId);
    broadcastRoom(r);
    const timer = setTimeout(() => {
      pendingRemovals.delete(player.clientId);
      const stillThere = r.players.get(player.id);
      if (stillThere && stillThere.disconnected && stillThere.clientId === player.clientId) {
        log('GRACE PERIOD EXPIRED, removing player', player.id, 'room:', r.code);
        const leaveResult = leaveRoom(player.id);
        if (leaveResult.room && leaveResult.leftName) {
          notifyRoom(leaveResult.room, `${leaveResult.leftName} left the room.`);
          broadcastRoom(leaveResult.room);
        }
      }
    }, DISCONNECT_GRACE_MS);
    pendingRemovals.set(player.clientId, timer);
  });

  function handleLeave(socket, explicit) {
    const { room, leftName, wasSpectator } = leaveRoom(socket.id);
    if (room && leftName) {
      notifyRoom(room, wasSpectator ? `${leftName} stopped spectating.` : `${leftName} left the room.`);
      broadcastRoom(room);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Trails Heads Up listening on :${PORT}`));
