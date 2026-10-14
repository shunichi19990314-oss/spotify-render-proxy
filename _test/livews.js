// 本番 Render の wss://<host>/tunnel (モードA) を検証する
'use strict';
const WebSocket = require('ws');
const BASE = process.env.BASE || 'spotify-88jy.onrender.com';
const TOKEN = process.env.TK || '';

function tunnel(host, port, token) {
  return new Promise((res, rej) => {
    const ws = new WebSocket('wss://' + BASE + '/tunnel', ['proxy.v1.' + encodeURIComponent(token)],
      { perMessageDeflate: false, handshakeTimeout: 25000 });
    ws.binaryType = 'nodebuffer';
    const t = setTimeout(() => { try { ws.terminate(); } catch {} rej(new Error('timeout')); }, 25000);
    ws.on('unexpected-response', (_q, r) => { clearTimeout(t); rej(new Error('HTTP ' + r.statusCode)); });
    ws.on('error', (e) => { clearTimeout(t); rej(e); });
    ws.on('open', () => { ws.send(Buffer.from(JSON.stringify({ type: 'connect', host, port }) + '\n')); });
    let stage = 0, head = Buffer.alloc(0);
    ws.on('message', (d) => {
      if (stage) return;
      head = Buffer.concat([head, Buffer.from(d)]);
      const nl = head.indexOf(0x0a);
      if (nl === -1) return;
      stage = 1;
      clearTimeout(t);
      const line = head.slice(0, nl).toString().trim();
      if (!/^OK/.test(line)) { try { ws.terminate(); } catch {} return rej(new Error('refused: ' + line)); }
      res({ ws, rest: head.slice(nl + 1) });
    });
  });
}

let pass = 0, fail = 0;
const check = (n, ok, d) => { console.log(`${ok ? '✅' : '❌'} ${n.padEnd(46)} ${d || ''}`); ok ? pass++ : fail++; };

(async () => {
  console.log(`対象: wss://${BASE}/tunnel\n`);

  // --- 正しいトークンでトンネルを張り、その上で実際の TLS + HTTP を通す
  try {
    const { ws, rest } = await tunnel('open.spotify.com', 443, TOKEN);
    check('正しいトークンでトンネル確立', true, 'open.spotify.com:443');

    // ws のメッセージを Duplex に包んで TLS を張る。
    // (下層ソケットを直接 tls.connect に渡すと WS フレームを TLS レコードと
    //  誤認して "wrong version number" になる。実 client も同じくメッセージ単位で扱う)
    const { Duplex } = require('stream');
    const tls = require('tls');
    const wrap = new Duplex({
      write(chunk, enc, cb) { try { ws.send(chunk); } catch (e) { return cb(e); } cb(); },
      // 受信は ws.on('message') → wrap.push() で流し込むので _read は何もしない
      read() {},
      final(cb) { try { ws.close(); } catch {} cb(); },
    });
    ws.on('message', (d, bin) => { if (bin) wrap.push(Buffer.from(d)); });
    ws.on('close', () => wrap.push(null));
    if (rest && rest.length) wrap.push(rest);

    const sock = tls.connect({ socket: wrap, servername: 'open.spotify.com' });
    const result = await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('TLS/HTTP timeout')), 40000);
      sock.on('error', (e) => { clearTimeout(to); rej(e); });
      sock.on('secureConnect', () => {
        sock.write('GET / HTTP/1.1\r\nHost: open.spotify.com\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\nConnection: close\r\n\r\n');
        let buf = Buffer.alloc(0);
        sock.on('data', (d) => { buf = Buffer.concat([buf, d]); });
        sock.on('end', () => { clearTimeout(to); res(buf); });
        sock.on('close', () => { clearTimeout(to); res(buf); });
      });
    });
    const head = result.slice(0, 60).toString('latin1').split('\r\n')[0];
    check('トンネル上で TLS ハンドシェイク成功', /^HTTP\/1\.1 \d{3}/.test(head), head);
    check('Spotify の HTML が取れる', result.length > 50000, `${result.length} bytes`);
    try { sock.destroy(); } catch {}
    try { ws.terminate(); } catch {}
  } catch (e) {
    check('トンネル上で TLS+HTTP が通る', false, e.message);
  }

  // --- 誤トークンは拒否される
  {
    const r = await new Promise((res) => {
      const ws = new WebSocket('wss://' + BASE + '/tunnel', ['proxy.v1.wrongtoken'], { handshakeTimeout: 15000 });
      const t = setTimeout(() => { try { ws.terminate(); } catch {} res('timeout'); }, 15000);
      ws.on('unexpected-response', (_q, rr) => { clearTimeout(t); res('HTTP ' + rr.statusCode); });
      ws.on('open', () => { clearTimeout(t); ws.close(); res('opened(NG!)'); });
      ws.on('error', (e) => { clearTimeout(t); res('err ' + e.message); });
    });
    check('誤トークンは 401 で拒否', /401/.test(r), r);
  }
  // --- トークンなしも拒否される
  {
    const r = await new Promise((res) => {
      const ws = new WebSocket('wss://' + BASE + '/tunnel', [], { handshakeTimeout: 15000 });
      const t = setTimeout(() => { try { ws.terminate(); } catch {} res('timeout'); }, 15000);
      ws.on('unexpected-response', (_q, rr) => { clearTimeout(t); res('HTTP ' + rr.statusCode); });
      ws.on('open', () => { clearTimeout(t); ws.close(); res('opened(NG!)'); });
      ws.on('error', (e) => { clearTimeout(t); res('err ' + e.message); });
    });
    check('トークンなしは 401 で拒否', /401/.test(r), r);
  }
  // --- 存在しないホストは ERR が返る
  try {
    await tunnel('this-host-does-not-exist-xyz.invalid', 443, TOKEN);
    check('到達不能ホストは ERR を返す', false, 'OK が返ってきてしまった');
  } catch (e) {
    check('到達不能ホストは ERR を返す', /ERR/.test(e.message), e.message);
  }

  console.log(`\n${'='.repeat(62)}`);
  console.log(`モードA 結果: ${pass} pass / ${fail} fail`);
  console.log('='.repeat(62));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
