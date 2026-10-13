// プロキシ経由でHTTP/HTTPSを取りに行く検証用
const http=require('http'),https=require('https');
const PROXY={host:'127.0.0.1',port:Number(process.env.PPORT||18888)};
function viaHttps(host,path){
  return new Promise((resolve,reject)=>{
    const req=http.request({host:PROXY.host,port:PROXY.port,method:'CONNECT',path:`${host}:443`});
    req.on('connect',(res,socket)=>{
      if(res.statusCode!==200)return reject(new Error('CONNECT '+res.statusCode));
      const r=https.request({host,path,servername:host,socket,agent:false,headers:{'User-Agent':'Mozilla/5.0','Accept':'*/*'},method:'GET'},(rs)=>{
        let n=0;const chunks=[];
        rs.on('data',c=>{n+=c.length;if(chunks.length<3)chunks.push(c);});
        rs.on('end',()=>resolve({status:rs.statusCode,len:n,ctype:rs.headers['content-type'],head:Buffer.concat(chunks).slice(0,120).toString('utf8').replace(/\s+/g,' ')}));
      });
      r.on('error',reject);r.end();
    });
    req.on('error',reject);req.end();
  });
}
function viaHttp(url){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const req=http.request({host:PROXY.host,port:PROXY.port,method:'GET',path:u.pathname+u.search,headers:{Host:u.host,Connection:'close'}},(rs)=>{
      let b='';rs.on('data',c=>b+=c);rs.on('end',()=>resolve({status:rs.statusCode,body:b.trim()}));
    });
    req.on('error',reject);req.end();
  });
}
(async()=>{
  try{ console.log('[plain http ]', JSON.stringify(await viaHttp('http://127.0.0.1:19090/hello?a=1'))); }catch(e){ console.log('[plain http ] ERR',e.message); }
  for(const [h,p] of [['open.spotify.com','/'],['api.spotify.com','/v1/me'],['accounts.spotify.com','/authorize']]){
    try{ const r=await viaHttps(h,p); console.log(`[https ${h}${p}]`, r.status, r.ctype, 'bytes='+r.len, '|', r.head); }
    catch(e){ console.log(`[https ${h}${p}] ERR`, e.message); }
  }
  // CONNECT トンネルの疎通 (raw echo)
  try{
    const net=require('net');
    const r=await new Promise((resolve,reject)=>{
      const rq=http.request({host:PROXY.host,port:PROXY.port,method:'CONNECT',path:'127.0.0.1:19091'});
      rq.on('connect',(res,socket)=>{
        if(res.statusCode!==200)return reject(new Error('CONNECT '+res.statusCode));
        socket.once('data',d=>{socket.destroy();resolve(d.toString());});
        socket.write('PING');
        setTimeout(()=>reject(new Error('echo timeout')),8000);
      });
      rq.on('error',reject);rq.end();
    });
    console.log('[connect raw echo]', JSON.stringify(r));
  }catch(e){ console.log('[connect raw echo] ERR',e.message); }

  // 自己署名 HTTPS サーバへの CONNECT (端到端で TLS が通るかの確認)
  try{
    const r=await new Promise((resolve,reject)=>{
      const rq=http.request({host:PROXY.host,port:PROXY.port,method:'CONNECT',path:'127.0.0.1:19443'});
      rq.on('connect',(res,socket)=>{
        if(res.statusCode!==200)return reject(new Error('CONNECT '+res.statusCode));
        const rr=https.request({host:'127.0.0.1',port:19443,path:'/tls-test',servername:'127.0.0.1',socket,agent:false,rejectUnauthorized:false,headers:{Host:'127.0.0.1:19443'}},(rs)=>{
          let b='';rs.on('data',c=>b+=c);rs.on('end',()=>resolve({status:rs.statusCode,body:b.trim()}));
        });
        rr.on('error',reject);rr.end();
      });
      rq.on('error',reject);rq.end();
      setTimeout(()=>reject(new Error('tls echo timeout')),15000);
    });
    console.log('[https over CONNECT (self-signed)]', JSON.stringify(r));
  }catch(e){ console.log('[https over CONNECT (self-signed)] ERR',e.message); }

  // SOCKS5 経由: raw TCP echo
  try{
    const r=await socksTest('127.0.0.1',19091,'PING-SOCKS');
    console.log('[socks5 raw echo]', JSON.stringify(r));
  }catch(e){ console.log('[socks5 raw echo] ERR',e.message); }

  // SOCKS5 経由 + TLS: 自己署名サーバ
  try{ console.log('[socks5 + TLS self-signed]', JSON.stringify(await socksTlsGet('127.0.0.1',19443,'/socks-tls',{rejectUnauthorized:false}))); }
  catch(e){ console.log('[socks5 + TLS self-signed] ERR',e.message); }

  // SOCKS5 経由 + TLS: 実 Spotify (証明書検証あり)
  try{ console.log('[socks5 + open.spotify.com]', JSON.stringify(await socksTlsGet('open.spotify.com',443,'/'))); }
  catch(e){ console.log('[socks5 + open.spotify.com] ERR',e.message); }

  setTimeout(()=>process.exit(0),300);
})();

function socksReq(host,port){
  const h=Buffer.from(host,'utf8');
  const b=Buffer.alloc(7+h.length);
  b[0]=0x05;b[1]=0x01;b[2]=0x00;b[3]=0x03;b[4]=h.length;h.copy(b,5);
  b.writeUInt16BE(port,5+h.length);
  return b;
}
function tlsHello(sni){
  const name=Buffer.from(sni,'utf8');
  const ext=Buffer.concat([Buffer.from([0x00,0x00]),Buffer.from([(name.length+3)>>8,(name.length+3)&0xff]),Buffer.from([name.length+1,0x00]),name]);
  const helloBody=Buffer.concat([
    Buffer.from([0x03,0x03]),                       // client version TLS1.2
    require('crypto').randomBytes(32),              // random
    Buffer.from([0x00]),                            // session id len
    Buffer.from([0x00,0x04,0x13,0x01,0x00,0x2f]),        // cipher suites: TLS_AES_128_GCM_SHA256 + RSA
    Buffer.from([0x01,0x00]),                       // compression: null
    Buffer.from([ext.length>>8,ext.length&0xff]),ext,
  ]);
  const hs=Buffer.concat([Buffer.from([0x01]),Buffer.from([0x00,(helloBody.length>>8)&0xff,helloBody.length&0xff]),helloBody]);
  return Buffer.concat([Buffer.from([0x16,0x03,0x01,hs.length>>8,hs.length&0xff]),hs]);
}

// ---------------- SOCKS5 ヘルパ ----------------
function socksConnect(host,port){
  const net=require('net');
  return new Promise((resolve,reject)=>{
    const c=net.connect(Number(process.env.SPORT||11080),'127.0.0.1',()=>{
      c.write(Buffer.from([0x05,0x01,0x00]));   // greeting: no-auth
    });
    let stage=0;
    const onGreet=(d)=>{
      if(d[0]!==0x05||d[1]!==0x00){ c.removeListener('data',onGreet); return reject(new Error('greet '+(d[1]||'?'))); }
      c.removeListener('data',onGreet);
      c.once('data',onReply);
      c.write(socksReq(host,port));
    };
    const onReply=(d)=>{
      c.removeListener('data',onReply);
      if(d[1]!==0x00) return reject(new Error('socks reply code '+d[1]));
      resolve(c);
    };
    c.once('data',onGreet);
    c.on('error',reject);
    setTimeout(()=>reject(new Error('socks connect timeout')),15000);
  });
}
function socksTest(host,port,payload){
  return new Promise(async (resolve,reject)=>{
    try{
      const c=await socksConnect(host,port);
      c.once('data',d=>{c.destroy();resolve(d.toString());});
      c.write(payload);
      setTimeout(()=>reject(new Error('echo timeout')),10000);
    }catch(e){reject(e);}
  });
}
function socksReq(host,port){
  const h=Buffer.from(host,'utf8');
  const b=Buffer.alloc(7+h.length);
  b[0]=0x05;b[1]=0x01;b[2]=0x00;b[3]=0x03;b[4]=h.length;h.copy(b,5);
  b.writeUInt16BE(port,5+h.length);
  return b;
}

// SOCKS5 トンネル上で TLS を張り、素の HTTP/1.1 リクエストを手書きして応答を拾う
function socksTlsGet(host,port,path,opt={}){
  const tls=require('tls');
  return new Promise(async (resolve,reject)=>{
    let raw;
    try{ raw=await socksConnect(host,port); }catch(e){ return reject(e); }
    const sock=tls.connect({socket:raw,servername:/^\d+\.\d+/.test(host)?undefined:host,...opt});
    const to=setTimeout(()=>reject(new Error('timeout')),25000);
    sock.on('error',e=>{clearTimeout(to);reject(e)});
    sock.on('secureConnect',()=>{
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: probe\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
      let buf='';
      sock.on('data',d=>{ buf+=d.toString('latin1'); });
      sock.on('end',()=>{
        clearTimeout(to);
        const m=/^HTTP\/1\.1 (\d{3})/.exec(buf);
        resolve({status:m?m[1]:null,headBytes:buf.length,
                 firstLine:(buf.split('\r\n')[0]||'').slice(0,60),
                 title:(/<title[^>]*>([^<]{0,60})/i.exec(buf)||[])[1]||undefined});
        try{sock.destroy()}catch{}
      });
      sock.on('close',()=>{clearTimeout(to);});
    });
  });
}
