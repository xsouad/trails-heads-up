const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { gameOrder } = require('./gameData');
const {
  createRoom, joinRoom, leaveRoom, findRoomBySocket,
  startGame, revealPlayer, restartRoom, serializeRoomFor
} = require('./rooms');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '../client')));

function broadcastRoom(room) {
  room.players.forEach((player, socketId) => {
    io.to(socketId).emit('roomState', serializeRoomFor(room, socketId));
  });
}

io.on('connection', (socket) => {
  socket.emit('gameOrder', gameOrder);

  socket.on('createRoom', ({ name, avatar }, cb) => {
    const room = createRoom(socket.id, name || 'Player', avatar);
    socket.join(room.code);
    cb && cb({ ok: true, code: room.code });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ code, name, avatar }, cb) => {
    const result = joinRoom((code || '').toUpperCase(), socket.id, name || 'Player', avatar);
    if (result.error) { cb && cb({ ok: false, error: result.error }); return; }
    socket.join(result.room.code);
    cb && cb({ ok: true, code: result.room.code });
    broadcastRoom(result.room);
  });

  socket.on('updateAvatar', ({ avatar }) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
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
    if (!room || room.hostId !== socket.id) { cb && cb({ ok: false, error: 'Only the host can start.' }); return; }
    const result = startGame(room);
    if (result.error) { cb && cb({ ok: false, error: result.error }); return; }
    cb && cb({ ok: true });
    broadcastRoom(room);
  });

  socket.on('reveal', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'playing') return;
    revealPlayer(room, socket.id);
    broadcastRoom(room);
  });

  socket.on('restartGame', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    restartRoom(room);
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    const { room } = leaveRoom(socket.id);
    if (room) broadcastRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Trails Heads Up listening on :${PORT}`));
