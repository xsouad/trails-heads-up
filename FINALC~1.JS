setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15000);
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const avatar = { base: 1, face: 1, hat: 1 };
function mk() { return io(URL, { transports: ['websocket'] }); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
(async () => {
  const a = mk(), b = mk();
  let sa;
  a.on('roomState', s => sa = s);
  await Promise.all([a,b].map(x => new Promise(r => x.on('connect', r))));
  let code;
  await new Promise((res,rej) => a.emit('createRoom', { name:'A', avatar, visibility:'private' }, r => r.ok?(code=r.code,res()):rej(r.error)));
  await new Promise((res,rej) => b.emit('joinRoom', { code, name:'B', avatar }, r => r.ok?res():rej(r.error)));
  await wait(150);
  await new Promise(res => a.emit('startGame', {}, r => { console.log('start:', r); res(); }));
  await wait(150);
  console.log('startedAt present:', typeof sa.startedAt, sa.startedAt);
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
