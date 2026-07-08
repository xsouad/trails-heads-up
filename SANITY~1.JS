setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15000);
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const avatar = { base: 1, face: 1, hat: 1 };
function mk() { return io(URL, { transports: ['websocket'] }); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
(async () => {
  const host = mk(), guest = mk();
  let events = [];
  host.on('roomState', s => events.push({players: s.players.length, phase: s.phase}));
  await Promise.all([host,guest].map(x => new Promise(r => x.on('connect', r))));
  let code;
  await new Promise((res,rej) => host.emit('createRoom', { name: 'Host', avatar, visibility: 'public' }, r => r.ok ? (code=r.code, res()) : rej(r.error)));
  await new Promise((res,rej) => guest.emit('joinRoom', { code, name: 'Guest', avatar }, r => r.ok ? res() : rej(r.error)));
  await wait(200);
  await new Promise(res => host.emit('startGame', {}, r => { console.log('start:', r); res(); }));
  await wait(150);
  console.log('sequence of roomState events received by host:', events);
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
