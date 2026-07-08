const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { gameOrder } = require('./gameData');
const {
  createRoom, joinRoom, joinAsSpectator, listPublicRooms, leaveRoom,
  findRoomBySocket, isSpectator, startGame, revealPlayer, voteEndGame,
  requestRematch, respondRematch, serializeRoomFor
} = require('./rooms');

function log(...args) { console.log(new Date().toISOString(), ...args); }

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
  function leaveAnyCurrentRoom() {
    const result = leaveRoom(socket.id);
    if (result.room && result.leftName) {
      log('AUTO-LEFT prior room before join/create', socket.id, 'room:', result.room.code, 'remaining players:', result.room.players.size);
      notifyRoom(result.room, result.wasSpectator ? `${result.leftName} stopped spectating.` : `${result.leftName} left the room.`);
      broadcastRoom(result.room);
    }
    Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });
  }

  socket.on('listPublicRooms', (_, cb) => {
    cb && cb(listPublicRooms());
  });

  socket.on('createRoom', ({ name, avatar, visibility }, cb) => {
    leaveAnyCurrentRoom();
    const room = createRoom(socket.id, name || 'Player', avatar, visibility);
    socket.join(room.code);
    log('CREATE ROOM', room.code, 'host:', socket.id, 'name:', name);
    cb && cb({ ok: true, code: room.code });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ code, name, avatar }, cb) => {
    leaveAnyCurrentRoom();
    const result = joinRoom((code || '').toUpperCase(), socket.id, name || 'Player', avatar);
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
    broadcastRoom(room);
  });

  socket.on('startGame', (_, cb) => {
    const room = findRoomBySocket(socket.id);
    if (!room) { cb && cb({ ok: false, error: "You're not in a room right now. Please rejoin using the room code." }); return; }
    if (room.hostId !== socket.id) { cb && cb({ ok: false, error: 'Only the host can start the game.' }); return; }
    if (room.players.size < 2) { cb && cb({ ok: false, error: 'You need at least 2 players to start a game.' }); return; }
    const result = startGame(room);
    if (result.error) { cb && cb({ ok: false, error: result.error }); return; }
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
    handleLeave(socket, false);
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
