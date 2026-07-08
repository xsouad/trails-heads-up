setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 20000);
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const avatar = { base: 1, face: 1, hat: 1 };
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const host = io(URL, { transports: ['websocket'] });
  let hostState;
  const originalId = await new Promise(res => host.on('connect', () => res(host.id)));
  host.on('roomState', s => hostState = s);
  console.log('host original id:', originalId);

  let code;
  await new Promise((res,rej) => host.emit('createRoom', { name: 'Host', avatar, visibility: 'private' }, r => r.ok ? (code=r.code, res()) : rej(r.error)));
  await wait(150);
  console.log('room created:', code, 'players:', hostState.players.length);

  // Simulate an abrupt transport drop (not a clean disconnect) on the host connection.
  let reconnected = false;
  host.io.on('reconnect', () => { reconnected = true; });
  host.io.engine.close();

  // wait for it to reconnect on its own
  await wait(3000);
  console.log('host new id:', host.id, 'changed:', host.id !== originalId, 'client-side reconnect fired:', reconnected, 'socket.connected:', host.connected);

  // Now have a second player join, and see if the ORIGINAL host connection gets the update.
  const guest = io(URL, { transports: ['websocket'] });
  let guestConnected = false;
  guest.on('connect', () => guestConnected = true);
  await new Promise(res => guest.on('connect', res));
  await new Promise((res,rej) => guest.emit('joinRoom', { code, name: 'Guest', avatar }, r => r.ok ? res() : rej(r.error)));
  await wait(400);

  console.log('host sees player count after reconnect + guest join (should be 2):', hostState.players.length);
  console.log('host still recognized as host:', hostState.hostId === host.id);

  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
