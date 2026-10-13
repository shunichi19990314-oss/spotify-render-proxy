const http=require('http'),net=require('net'),crypto=require('crypto'),WebSocket=require('ws');
const BASE='http://127.0.0.1:18080';
const GOOD='goodtoken-abcdef123456';
function get(path,headers={}){return new Promise(r=>{http.get(BASE+path,{headers},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>r({s:res.statusCode,b:b.trim().slice(0,60)}))}).on('error',e=>r({err:e.message}))})}
function wsTry(proto){return new Promise(res=>{
  const w=new WebSocket('ws://127.0.0.1:18080/tunnel',proto?[proto]:[],{handshakeTimeout:5000});
  const t=setTimeout(()=>{try{w.terminate()}catch{};res('timeout')},5000);
  w.on('unexpected-response',(_q,r)=>{clearTimeout(t);res('HTTP '+r.statusCode)});
  w.on('open',()=>{clearTimeout(t);w.send(Buffer.from(JSON.stringify({type:'connect',host:'127.0.0.1',port:19091})+'\n'));
    w.once('message',d=>{const s=Buffer.from(d).toString();clearTimeout(t);try{w.terminate()}catch{};res('opened: '+s.slice(0,20).trim())});});
  w.on('error',e=>{clearTimeout(t);res('err '+e.message)});
})}
function directConnect(authHdr){return new Promise(res=>{
  const rq=http.request({host:'127.0.0.1',port:18080,method:'CONNECT',path:'127.0.0.1:19091',headers:authHdr?{[authHdr[0]]:authHdr[1]}:{}});
  const t=setTimeout(()=>{rq.destroy();res('timeout')},6000);
  rq.on('connect',(r,sock)=>{clearTimeout(t);
    if(r.statusCode!==200){sock.destroy();return res('CONNECT '+r.statusCode)}
    sock.once('data',d=>{sock.destroy();res('CONNECT 200 echo='+JSON.stringify(d.toString()))});
    sock.write('HI');});
  rq.on('error',e=>{clearTimeout(t);res('err '+e.message)});rq.end();
})}
(async()=>{
  console.log('GET /healthz                 :', JSON.stringify(await get('/healthz')));
  console.log('WS  正しいトークン            :', await wsTry('proxy.v1.'+encodeURIComponent(GOOD)));
  console.log('WS  誤ったトークン            :', await wsTry('proxy.v1.wrongtoken'));
  console.log('WS  トークンなし              :', await wsTry(null));
  console.log('直接CONNECT 認証なし          :', await directConnect(null));
  console.log('直接CONNECT 誤Bearer          :', await directConnect(['Authorization','Bearer nope']));
  console.log('直接CONNECT 正Bearer          :', await directConnect(['Authorization','Bearer '+GOOD]));
  console.log('直接CONNECT Proxy-Auth Basic  :', await directConnect(['Proxy-Authorization','Basic '+Buffer.from('user:'+GOOD).toString('base64')]));
  process.exit(0);
})();
