setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15000);
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const avatar = { base: 1, face: 1, hat: 1 };
function mk() { return io(URL, { transports: ['websocket'] }); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
(async () => {
  // Test 1: bad cutoffTag should fail-safe to FC-only, not leak everything
  const a = mk(), b = mk();
  await Promise.all([a,b].map(x => new Promise(r => x.on('connect', r))));
  let code;
  await new Promise((res,rej) => a.emit('createRoom', { name:'A', avatar, visibility:'private' }, r => r.ok?(code=r.code,res()):rej(r.error)));
  await new Promise((res,rej) => b.emit('joinRoom', { code, name:'B', avatar }, r => r.ok?res():rej(r.error)));
  await wait(150);
  a.emit('updateSettings', { cutoffTag: 'NOT_A_REAL_TAG', categories: ['characters','events'] });
  await wait(150);
  let sa;
  a.on('roomState', s => sa = s);
  await new Promise(res => a.emit('startGame', {}, r => { console.log('start with bad cutoffTag:', r); res(); }));
  await wait(150);
  console.log('items assigned with bad cutoffTag (should ALL be FC-tagged, order 1):', sa.players.map(p => p.item && p.item.tag));

  // Test 2: normal CS3 cutoff should never include KAI
  const c = mk(), d = mk();
  await Promise.all([c,d].map(x => new Promise(r => x.on('connect', r))));
  let code2;
  await new Promise((res,rej) => c.emit('createRoom', { name:'C', avatar, visibility:'private' }, r => r.ok?(code2=r.code,res()):rej(r.error)));
  await new Promise((res,rej) => d.emit('joinRoom', { code:code2, name:'D', avatar }, r => r.ok?res():rej(r.error)));
  await wait(150);
  c.emit('updateSettings', { cutoffTag: 'CS3', categories: ['events'] });
  await wait(150);
  let sc;
  c.on('roomState', s => sc = s);
  await new Promise(res => c.emit('startGame', {}, r => { console.log('start with CS3+events only:', r); res(); }));
  await wait(150);
  console.log('items assigned (should be type=event, tag <= CS3 order):', sc.players.map(p => p.item && [p.item.type, p.item.tag]));

  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
