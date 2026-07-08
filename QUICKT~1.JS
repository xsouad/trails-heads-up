setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15000);
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const avatar = { base: 1, face: 1, hat: 1 };
function mk() { return io(URL, { transports: ['websocket'] }); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const solo = mk();
  await new Promise(r => solo.on('connect', r));
  let code;
  await new Promise((res,rej) => solo.emit('createRoom', { name: 'Solo', avatar, visibility: 'public' }, r => r.ok ? (code=r.code, res()) : rej(r.error)));
  await new Promise(res => solo.emit('startGame', {}, r => { console.log('solo start (expect min-2-players error):', r); res(); }));

  const joiner = mk();
  await new Promise(r => joiner.on('connect', r));
  let js;
  joiner.on('roomState', s => js = s);
  await new Promise(res => joiner.emit('listPublicRooms', {}, list => { console.log('public list phase:', list.map(r=>r.phase)); res(); }));
  await new Promise((res,rej) => joiner.emit('joinRoom', { code, name: 'Joiner', avatar }, r => r.ok ? res() : rej(r.error)));
  await wait(150);
  await new Promise(res => solo.emit('startGame', {}, r => { console.log('start with 2 players:', r); res(); }));

  console.log('DONE');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
