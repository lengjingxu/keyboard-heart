const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function httpJson(p, m='GET') { return new Promise((res, rej) => { const r = http.request({host:'127.0.0.1',port:9344,path:p,method:m}, x => { let b=''; x.on('data',c=>b+=c); x.on('end',()=>res(JSON.parse(b))); }); r.on('error',rej); r.end(); }); }
(async () => {
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--remote-debugging-port=9344','--user-data-dir=/tmp/kh-promo-profile','--headless=new','--no-first-run','--window-size=2880,1620','about:blank'], {stdio:'ignore'});
  let ver=null; for (let i=0;i<40&&!ver;i++){ await sleep(400); try{ ver=await httpJson('/json/version'); }catch{} }
  const t = await httpJson('/json/new?about:blank','PUT');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.on('open',res);ws.on('error',rej);});
  let mid=0; const pend=new Map();
  ws.on('message', raw => { const m = JSON.parse(raw);
    if (m.method === 'Runtime.exceptionThrown') console.log('PAGE EXC line', m.params.exceptionDetails.lineNumber, ':', (m.params.exceptionDetails.exception?.description||'').slice(0,300));
    if (m.id && pend.has(m.id)) { const {resolve,reject}=pend.get(m.id); pend.delete(m.id); m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result); } });
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++mid;pend.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const ev=async e=>(await call('Runtime.evaluate',{expression:e,returnByValue:true})).result.value;
  await call('Runtime.enable'); await call('Page.enable');
  await call('Page.navigate',{url:'file:///Users/leng/Desktop/codepro/homeassistant/keyboard_heart/promo/scene3d.html'});
  await sleep(6000);
  console.log('ready:', await ev('window.__ready === true'));
  ws.close(); chrome.kill();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
