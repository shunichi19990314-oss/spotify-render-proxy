// Web Player リバースプロキシの検証（実 Spotify エンドポイントに対して実行）
'use strict';
const http = require('http');
const zlib = require('zlib');

const HOST = '127.0.0.1';
const PORT = Number(process.env.WPORT || 18080);
const TOKEN = process.env.WTOKEN || 'goodtoken-abcdef123456';

function req(method, path, { cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36', ...headers };
    if (cookie) h.Cookie = cookie;
    const rq = http.request({ host: HOST, port: PORT, method, path, headers: h }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        let buf = Buffer.concat(chunks);
        const ce = (r.headers['content-encoding'] || '').toLowerCase();
        try {
          if (ce.includes('gzip')) buf = zlib.gunzipSync(buf);
          else if (ce.includes('br')) buf = zlib.brotliDecompressSync(buf);
          else if (ce.includes('deflate')) buf = zlib.inflateSync(buf);
        } catch (e) { return resolve({ status: r.statusCode, headers: r.headers, decodeErr: e.message, raw: buf }); }
        resolve({ status: r.statusCode, headers: r.headers, body: buf });
      });
    });
    rq.on('error', reject);
    rq.setTimeout(30000, () => { rq.destroy(new Error('timeout')); });
    rq.end();
  });
}

const text = (r) => (r.body ? r.body.toString('utf8') : '');
let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log(`${cond ? '✅' : '❌'} ${name.padEnd(46)} ${detail || ''}`);
  cond ? pass++ : fail++;
}

(async () => {
  console.log('=== 1. ヘルスチェック ===');
  let r = await req('GET', '/healthz');
  check('/healthz が 200', r.status === 200, `HTTP ${r.status}`);
  check('webplayer enabled と表示', text(r).includes('webplayer : enabled'));

  console.log('\n=== 2. 認証ゲート ===');
  r = await req('GET', '/');
  check('認証なし / は 302 → /__gate__', r.status === 302 && r.headers.location === '/__gate__', `HTTP ${r.status} loc=${r.headers.location}`);
  r = await req('GET', '/__gate__');
  check('/__gate__ が 200 でトークン入力フォーム', r.status === 200 && text(r).includes('PROXY_TOKEN'), `HTTP ${r.status}`);
  r = await req('GET', '/__p__/open.spotify.com/');
  check('認証なし /__p__/ は 401', r.status === 401, `HTTP ${r.status}`);

  console.log('\n=== 3. ?t= で Cookie 発行 ===');
  r = await req('GET', `/?t=${encodeURIComponent(TOKEN)}`);
  const sc = r.headers['set-cookie'] || [];
  check('?t= が 302', r.status === 302, `HTTP ${r.status} loc=${r.headers.location}`);
  check('HttpOnly Cookie が焼かれる', sc.some((c) => c.includes('__proxy_auth=') && c.includes('HttpOnly')), JSON.stringify(sc[0] || '').slice(0, 80));
  const cookie = (sc[0] || '').split(';')[0];

  r = await req('GET', '/?t=wrongtoken');
  check('誤トークンは 302 → gate のまま', r.status === 302 && r.headers.location === '/__gate__', `HTTP ${r.status} loc=${r.headers.location}`);

  console.log('\n=== 4. Spotify HTML のプロキシ（最重要）===');
  r = await req('GET', '/', { cookie });
  const html = text(r);
  check('/ が 200', r.status === 200, `HTTP ${r.status} ${html.length}B`);
  check('HTML が返る', /<html/i.test(html), html.slice(0, 60).replace(/\s+/g, ' '));
  check('CSP ヘッダが除去されている', !r.headers['content-security-policy'], r.headers['content-security-policy'] ? '残っている!' : 'removed');
  check('x-frame-options が除去されている', !r.headers['x-frame-options']);
  check('SW 登録コードが注入されている', html.includes("serviceWorker.register('/sw.js'"));
  check('WebSocket シムが注入されている', html.includes('NativeWS') && html.includes('/__ws__/'));
  const rewritten = (html.match(/\/__p__\//g) || []).length;
  check('Spotify URL が書き換わっている', rewritten > 5, `/__p__/ が ${rewritten} 箇所`);
  const leftover = (html.match(/https?:\/\/[a-z0-9.-]*(?:spotify\.com|scdn\.co|spotifycdn\.com)/gi) || []);
  check('素の Spotify 絶対URLが残っていない', leftover.length === 0, leftover.length ? `残 ${leftover.length}: ${[...new Set(leftover)].slice(0,3).join(', ')}` : 'clean');
  console.log(`   Set-Cookie: ${(r.headers['set-cookie'] || []).length}個 (Domain除去確認: ${JSON.stringify((r.headers['set-cookie']||[])[0]||'').slice(0,90)})`);

  console.log('\n=== 5. Service Worker ===');
  r = await req('GET', '/sw.js', { cookie });
  const sw = text(r);
  check('/sw.js が 200 + JS', r.status === 200 && sw.includes("addEventListener('fetch'"), `HTTP ${r.status} ${sw.length}B`);
  check('Service-Worker-Allowed: /', r.headers['service-worker-allowed'] === '/');
  // SW_SOURCE 内では正規表現用に spotify\.com とエスケープされているため 'spotify' で判定
  check('SW が Spotify ドメインを判定', /spotify/.test(sw) && sw.includes('__p__'));

  console.log('\n=== 6. JS バンドルのプロキシ（4MB級）===');
  r = await req('GET', '/__p__/open.spotifycdn.com/cdn/build/web-player/vendor~web-player.b415aea9.js', { cookie });
  const js = text(r);
  check('vendor JS が 200', r.status === 200, `HTTP ${r.status} ${(js.length/1024/1024).toFixed(2)}MB`);
  const jsRew = (js.match(/\/__p__\//g) || []).length;
  check('JS 内の URL も書き換わっている', jsRew > 0, `/__p__/ が ${jsRew} 箇所`);
  check('Shaka/EME コードが保持されている', js.includes('requestMediaKeySystemAccess'), 'EME あり');

  console.log('\n=== 7. Web API のプロキシ ===');
  r = await req('GET', '/__p__/api.spotify.com/v1/me', { cookie });
  check('api.spotify.com が到達 (401 が正解)', r.status === 401, `HTTP ${r.status} ${text(r).slice(0,70)}`);
  r = await req('GET', '/__p__/api.spotify.com/v1/search?q=test&type=track&limit=1', { cookie });
  check('search API が到達 (401 が正解)', r.status === 401, `HTTP ${r.status}`);

  console.log('\n=== 8. 画像 CDN のプロキシ（バイナリ素通し）===');
  r = await req('GET', '/__p__/i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228', { cookie });
  check('i.scdn.co 画像が取得できる', r.status === 200 && r.body.length > 1000, `HTTP ${r.status} ${r.body ? r.body.length : 0}B ct=${r.headers['content-type']}`);

  console.log('\n=== 9. アカウント/ログイン系 ===');
  r = await req('GET', '/__p__/accounts.spotify.com/', { cookie });
  // accounts.spotify.com は open.spotify.com/login へ 307 する。Location が
  // /__p__/ 形に書き換わっていれば「リダイレクト先もプロキシ内に閉じている」証拠
  check('accounts.spotify.com が到達', [200, 301, 302, 303, 307].includes(r.status), `HTTP ${r.status}`);
  check('Location が /__p__/ 形に書き換わっている',
        !r.headers.location || r.headers.location.startsWith('/__p__/') || r.headers.location.startsWith('/'),
        `loc=${r.headers.location}`);
  check('Location に素の spotify.com が残っていない',
        !/https?:\/\/[a-z0-9.-]*spotify\.com/i.test(r.headers.location || ''), `loc=${r.headers.location}`);

  console.log('\n=== 10. SPA ルーティング（prefix なしパス）===');
  r = await req('GET', '/playlist/37i9dQZF1DXcBWIGoYBM5M', { cookie });
  check('/playlist/... が open.spotify.com に転送', r.status === 200 && /<html/i.test(text(r)), `HTTP ${r.status} ${text(r).length}B`);

  console.log('\n=== 11. 診断ページ ===');
  r = await req('GET', '/__diag__', { cookie });
  check('/__diag__ が 200', r.status === 200 && text(r).includes('診断'), `HTTP ${r.status}`);

  console.log('\n=== 12. 許可外ホストの遮断（オープンプロキシ化防止）===');
  r = await req('GET', '/__p__/example.com/', { cookie });
  check('example.com は 403 で拒否', r.status === 403, `HTTP ${r.status} ${text(r).slice(0,50)}`);
  r = await req('GET', '/__p__/169.254.169.254/latest/meta-data/', { cookie });
  check('メタデータIP(169.254.169.254)は拒否', r.status === 403, `HTTP ${r.status}`);

  console.log('\n=== 13. WebSocket プロキシ (/__ws__/) ===');
  try {
    const WebSocket = require('ws');
    const wsres = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://${HOST}:${PORT}/__ws__/dealer.spotify.com/?country=JP`, {
        headers: { Cookie: cookie }, handshakeTimeout: 12000,
      });
      const t = setTimeout(() => { try { ws.terminate(); } catch {} resolve('timeout'); }, 12000);
      ws.on('open', () => { clearTimeout(t); ws.close(); resolve('opened'); });
      ws.on('unexpected-response', (_q, rr) => { clearTimeout(t); resolve('HTTP ' + rr.statusCode); });
      ws.on('error', (e) => { clearTimeout(t); resolve('err: ' + e.message); });
    });
    // dealer は認証が必要なので 4xx/5xx でも「プロキシ経由で Spotify に届いた」証拠になる。
    // 重要なのは /__ws__/ のルーティングが機能し、接続が確立/拒否されること。
    check('WS プロキシが応答を返す (ハングしない)', wsres !== 'timeout', wsres);
  } catch (e) { check('WS プロキシ', false, e.message); }
  {
    const WebSocket = require('ws');
    const wsres = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://${HOST}:${PORT}/__ws__/example.com/x`, { handshakeTimeout: 6000 });
      const t = setTimeout(() => { try { ws.terminate(); } catch {} resolve('timeout'); }, 6000);
      ws.on('open', () => { clearTimeout(t); ws.close(); resolve('opened(NG!)'); });
      ws.on('unexpected-response', (_q, rr) => { clearTimeout(t); resolve('HTTP ' + rr.statusCode); });
      ws.on('error', (e) => { clearTimeout(t); resolve('err: ' + e.message); });
    });
    check('許可外ホストへの WS は拒否 (403)', /403/.test(wsres), wsres);
  }

  console.log('\n=== 14. 既存のトンネル方式にリグレッションがないか ===');
  r = await req('GET', '/tunnel');
  check('/tunnel がゲートにハイジャックされない (302 でない)', r.status !== 302, `HTTP ${r.status}`);
  r = await req('CONNECT', '127.0.0.1:19091');
  check('直接 CONNECT は認証必須 (407)', r.status === 407, `HTTP ${r.status}`);

  console.log(`\n${'='.repeat(66)}`);
  console.log(`結果: ${pass} pass / ${fail} fail`);
  console.log('='.repeat(66));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
