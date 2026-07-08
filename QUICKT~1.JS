const { io } = require('socket.io-client');
const c1 = io('http://localhost:3000', { transports: ['websocket'] });
const c2 = io('http://localhost:3000', { transports: ['websocket'] });
let s1, s2;
c1.on('roomState', s => s1 = s);
c2.on('roomState', s => s2 = s);
const avatar = { base: 1, face: 1, hat: 1 };
async function wait(ms){return new Promise(r=>setTimeout(r,ms));}
(async () => {
  await Promise.all([new Promise(r=>c1.on('connect',r)), new Promise(r=>c2.on('connect',r))]);
  let code;
  await new Promise((res,rej)=>c1.emit('createRoom',{name:'A',avatar},r=>r.ok?(code=r.code,res()):rej(r.error)));
  await new Promise((res,rej)=>c2.emit('joinRoom',{code,name:'B',avatar},r=>r.ok?res():rej(r.error)));
  await wait(150);
  c1.emit('updateSettings',{cutoffTag:'FC',categories:['characters','events']});
  await wait(150);
  await new Promise((res)=>c1.emit('startGame',{},r=>{console.log('startGame with FC cutoff:',r); res();}));
  await wait(150);
  console.log('items:', s1.players.map(p=>p.item && p.item.name + ' ['+p.item.tag+']'));
  console.log('DONE');
  process.exit(0);
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
