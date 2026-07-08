setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15000);
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const avatar = { base: 1, face: 1, hat: 1 };
function mk() { return io(URL, { transports: ['websocket'] }); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const a = mk();
  let sa;
  a.on('roomState', s => sa = s);
  await new Promise(r => a.on('connect', r));

  let code1, code2;
  await new Promise((res,rej) => a.emit('createRoom', { name: 'A', avatar, visibility: 'public' }, r => r.ok ? (code1=r.code, res()) : rej(r.error)));
  await wait(150);
  console.log('room1 created:', code1, 'phase:', sa.phase, 'hostId==me:', sa.hostId === a.id);

  await new Promise((res,rej) => a.emit('createRoom', { name: 'A', avatar, visibility: 'public' }, r => r.ok ? (code2=r.code, res()) : rej(r.error)));
  await wait(150);
  console.log('room2 created:', code2, 'phase:', sa.phase, 'hostId==me:', sa.hostId === a.id);

  await new Promise(res => a.emit('listPublicRooms', {}, list => {
    console.log('public rooms now:', list.map(r => ({code:r.code, players:r.playerCount})));
    res();
  }));

  const b = mk();
  let sb;
  b.on('roomState', s => sb = s);
  await new Promise(r => b.on('connect', r));
  await new Promise((res,rej) => b.emit('joinRoom', { code: code2, name: 'B', avatar }, r => r.ok ? res() : rej(r.error)));
  await wait(200);
  console.log('B isHost (should be false):', sb.hostId === b.id);
  console.log('room2 player count seen by A/B (should be 2/2):', sa.players.length, sb.players.length);
  console.log('A still host of room2:', sa.hostId === a.id);

  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
