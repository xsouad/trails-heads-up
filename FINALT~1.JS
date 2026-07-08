setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15000);
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const avatar = { base: 1, face: 1, hat: 1 };
function mk() { return io(URL, { transports: ['websocket'] }); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const host = mk(), guest = mk();
  let sh, sg;
  host.on('roomState', s => sh = s);
  guest.on('roomState', s => sg = s);
  await Promise.all([host, guest].map(x => new Promise(r => x.on('connect', r))));

  let code;
  await new Promise((res,rej) => host.emit('createRoom', { name: 'Host', avatar, visibility: 'public' }, r => r.ok ? (code=r.code, res()) : rej(r.error)));
  await wait(150);
  console.log('after create, host sees players:', sh.players.map(p=>p.name));

  await new Promise((res,rej) => guest.emit('joinRoom', { code, name: 'Guest', avatar }, r => r.ok ? res() : rej(r.error)));
  await wait(200);
  console.log('after guest joins:');
  console.log('  host sees players:', sh.players.map(p=>p.name), 'count matches state.players.length:', sh.players.length);
  console.log('  guest sees players:', sg.players.map(p=>p.name));
  console.log('  host isHost check (hostId===host.id):', sh.hostId === host.id);
  console.log('  guest isHost check (should be false):', sg.hostId === guest.id);

  await new Promise(res => host.emit('startGame', {}, r => { console.log('start with 2 players:', r); res(); }));

  console.log('DONE');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
