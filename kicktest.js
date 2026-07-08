setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15000);
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const avatar = { base: 1, face: 1, hat: 1 };
function mk() { return io(URL, { transports: ['websocket'] }); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const host = mk(), guest = mk();
  let sh, sg, guestKicked = false;
  host.on('roomState', s => sh = s);
  guest.on('roomState', s => sg = s);
  guest.on('kicked', () => guestKicked = true);
  await Promise.all([host,guest].map(x => new Promise(r => x.on('connect', r))));
  let code;
  await new Promise((res,rej) => host.emit('createRoom', { name: 'Host', avatar, visibility: 'private' }, r => r.ok ? (code=r.code, res()) : rej(r.error)));
  await new Promise((res,rej) => guest.emit('joinRoom', { code, name: 'Guest', avatar }, r => r.ok ? res() : rej(r.error)));
  await wait(150);
  console.log('players before kick:', sh.players.map(p=>p.name));
  const guestId = sh.players.find(p => p.name === 'Guest').id;
  host.emit('kickPlayer', { targetId: guestId });
  await wait(200);
  console.log('players after kick:', sh.players.map(p=>p.name));
  console.log('guest received kicked event:', guestKicked);
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
