const http=require('http');
function abs(url,auth){return new Promise(res=>{
  const u=new URL(url);
  const rq=http.request({host:'127.0.0.1',port:18080,method:'GET',path:url,headers:auth?{Authorization:'Bearer '+auth,Host:u.host}:{Host:u.host}},r=>{
    let b='';r.on('data',c=>b+=c);r.on('end',()=>res({s:r.statusCode,b:b.trim().slice(0,70)}))});
  rq.on('error',e=>res({err:e.message}));rq.setTimeout(8000,()=>{rq.destroy();res({err:'timeout'})});rq.end();
})}
(async()=>{
  console.log('絶対URI GET 認証なし :', JSON.stringify(await abs('http://127.0.0.1:19090/direct',null)));
  console.log('絶対URI GET 誤トークン:', JSON.stringify(await abs('http://127.0.0.1:19090/direct','bad')));
  console.log('絶対URI GET 正トークン:', JSON.stringify(await abs('http://127.0.0.1:19090/direct?x=1',process.argv[2])));
  process.exit(0);
})();
