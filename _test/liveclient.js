// モードA を「本番 Render 経由」で検証する。
// 事前に client/index.js を本番 RENDER_URL に向けて起動しておくこと:
//   cd client && RENDER_URL=https://<app>.onrender.com PROXY_TOKEN=<token> npm start
// その後:
//   node _test/liveclient.js
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const PROXY_HOST = process.env.PHOST || '127.0.0.1';
const HTTP_PORT = Number(process.env.PPORT || 18888);
const SOCKS_PORT = Number(process.env.SPORT || 1080);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

let pass = 0, fail = 0;
const check = (n, ok, d) => { console.log(`${ok ? '✅' : '❌'} ${n.padEnd(46)} ${d || ''}`); ok ? pass++ : fail++; };

/** ローカル HTTP プロキシ経由で CONNECT → TLS → HTTP */
function viaHttps(host, path) {
  return new Promise((resolve, reject) => {
    const rq = http.request({ host: PROXY_HOST, port: HTTP_PORT, method: 'CONNECT', path: `${host}:443` });
    rq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error('CONNECT ' + res.statusCode));
      const r = https.request({
        host, path, servername: host, socket, agent: false, method: 'GET',
        headers: { 'User-Agent': UA, Accept: '*/*' },
      }, (rs) => {
        let n = 0; const cs = [];
        rs.on('data', (c) => { n += c.length; if (cs.length < 4) cs.push(c); });
        rs.on('end', () => resolve({
          status: rs.statusCode, len: n,
          head: Buffer.concat(cs).slice(0, 90).toString('utf8').replace(/\s+/g, ' '),
        }));
      });
      r.on('error', reject);
      r.setTimeout(60000, () => { r.destroy(); reject(new Error('request timeout')); });
      r.end();
    });
    rq.on('error', reject);
    rq.setTimeout(60000, () => { rq.destroy(); reject(new Error('connect timeout')); });
    rq.end();
  });
}

/** ローカル SOCKS5 プロキシ経由で TCP → TLS → 素の HTTP/1.1 */
function viaSocksTls(host, port) {
  return new Promise((resolve, reject) => {
    const c = net.connect(SOCKS_PORT, PROXY_HOST, () => c.write(Buffer.from([0x05, 0x01, 0x00])));
    let stage = 0;
    c.on('data', (d) => {
      if (stage === 0) {
        stage = 1;
        const h = Buffer.from(host);
        const b = Buffer.alloc(7 + h.length);
        b[0] = 5; b[1] = 1; b[2] = 0; b[3] = 3; b[4] = h.length;
        h.copy(b, 5); b.writeUInt16BE(port, 5 + h.length);
        c.write(b);
        return;
      }
      if (stage === 1) {
        stage = 2;
        if (d[1] !== 0) return reject(new Error('socks reply code ' + d[1]));
        const sock = tls.connect({ socket: c, servername: host }, () => {
          sock.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${UA}\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
          let buf = Buffer.alloc(0);
          sock.on('data', (x) => { buf = Buffer.concat([buf, x]); });
          const done = () => resolve({ bytes: buf.length, first: buf.slice(0, 40).toString('latin1').split('\r\n')[0] });
          sock.on('end', done);
          sock.on('close', () => { if (buf.length) done(); });
        });
        sock.on('error', reject);
      }
    });
    c.on('error', reject);
    c.setTimeout(60000, () => { c.destroy(); reject(new Error('socks timeout')); });
  });
}

(async () => {
  console.log(`対象: ローカルプロキシ ${PROXY_HOST}:${HTTP_PORT} (HTTP) / :${SOCKS_PORT} (SOCKS5)`);
  console.log('      → 本番 Render 経由で実 Spotify に到達するはず\n');

  console.log('=== HTTP プロキシ経由 (CONNECT トンネル) ===');
  // 期待値: open=200, api=401(トークン無しなので正解), accounts=3xx(ログインへリダイレクト)
  const targets = [
    ['open.spotify.com', '/', (s) => s === 200],
    ['api.spotify.com', '/v1/me', (s) => s === 401],
    ['accounts.spotify.com', '/', (s) => s >= 300 && s < 400],
    ['accounts.spotify.com', '/authorize', (s) => s >= 300 && s < 400],
  ];
  for (const [h, p, ok] of targets) {
    try {
      const r = await viaHttps(h, p);
      check(`HTTPS ${h}${p}`, ok(r.status), `HTTP ${r.status} / ${r.len}B`);
      if (h === 'open.spotify.com') console.log(`     → ${r.head}`);
    } catch (e) { check(`HTTPS ${h}${p}`, false, e.message); }
  }

  console.log('\n=== SOCKS5 経由 + TLS ===');
  try {
    const r = await viaSocksTls('open.spotify.com', 443);
    check('SOCKS5+TLS open.spotify.com', /^HTTP\/1\.1 200/.test(r.first) && r.bytes > 50000, `${r.first} / ${r.bytes}B`);
  } catch (e) { check('SOCKS5+TLS open.spotify.com', false, e.message); }

  console.log(`\n${'='.repeat(62)}`);
  console.log(`モードA(本番経由) 結果: ${pass} pass / ${fail} fail`);
  console.log('='.repeat(62));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
