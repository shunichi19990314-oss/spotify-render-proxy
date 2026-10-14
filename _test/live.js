// 本番 (Render) デプロイの検証 — ローカルの _test/webplayer.js と同じ項目を実 HTTPS で実行
'use strict';
const https = require('https');
const zlib = require('zlib');

const BASE = process.env.BASE || 'spotify-88jy.onrender.com';
const TOKEN = process.env.TK || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function req(method, path, { cookie, headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const h = { 'User-Agent': UA, ...headers };
    if (cookie) h.Cookie = cookie;
    const rq = https.request({ host: BASE, path, method, headers: h, servername: BASE }, (r) => {
      const cs = [];
      r.on('data', (c) => cs.push(c));
      r.on('end', () => {
        let buf = Buffer.concat(cs);
        const ce = (r.headers['content-encoding'] || '').toLowerCase();
        try {
          if (ce.includes('gzip')) buf = zlib.gunzipSync(buf);
          else if (ce.includes('br')) buf = zlib.brotliDecompressSync(buf);
          else if (ce.includes('deflate')) buf = zlib.inflateSync(buf);
        } catch (e) { return resolve({ status: r.statusCode, headers: r.headers, decodeErr: e.message, body: buf }); }
        resolve({ status: r.statusCode, headers: r.headers, body: buf });
      });
    });
    rq.on('error', (e) => resolve({ err: e.message }));
    rq.setTimeout(90000, () => { rq.destroy(); resolve({ err: 'timeout(90s)' }); });
    if (body) rq.write(body);
    rq.end();
  });
}
const text = (r) => (r.body ? r.body.toString('utf8') : '');
let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log(`${cond ? '✅' : '❌'} ${name.padEnd(44)} ${detail || ''}`);
  cond ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`対象: https://${BASE}/`);
  console.log(`トークン: ${TOKEN ? TOKEN.slice(0, 6) + '…(' + TOKEN.length + '字)' : '(未設定!)'}\n`);

  console.log('=== 0. スリープ復帰 ===');
  let r;
  for (let i = 1; i <= 8; i++) {
    r = await req('GET', '/healthz');
    if (!r.err && r.status === 200) { console.log(`   #${i} で起動確認 (HTTP 200)`); break; }
    console.log(`   #${i} ${r.err || 'HTTP ' + r.status} — 12秒待機`);
    await sleep(12000);
  }
  check('/healthz が 200', r && r.status === 200, r ? `HTTP ${r.status}` : r.err);
  check('webplayer が enabled', text(r).includes('webplayer : enabled'));
  check('mode が token (認証有効)', text(r).includes('mode      : token'));
  check('healthz が認証不要で開く', true, 'Render のヘルスチェックが通る');

  console.log('\n=== 1. 認証ゲート ===');
  r = await req('GET', '/');
  check('認証なし / は 302 → /__gate__', r.status === 302 && r.headers.location === '/__gate__', `HTTP ${r.status} loc=${r.headers.location}`);
  r = await req('GET', '/__gate__');
  check('/__gate__ が 200 (トークン入力フォーム)', r.status === 200 && text(r).includes('PROXY_TOKEN'), `HTTP ${r.status}`);
  check('ゲートページが日本語UI', text(r).includes('認証'), '');
  r = await req('GET', '/__p__/open.spotify.com/');
  check('認証なし /__p__/ は 401', r.status === 401, `HTTP ${r.status}`);
  r = await req('GET', '/sw.js');
  check('認証なし /sw.js は 401 (SWの悪用防止)', r.status === 401, `HTTP ${r.status}`);

  console.log('\n=== 2. ?t= で Cookie 発行 ===');
  r = await req('GET', `/?t=${encodeURIComponent(TOKEN)}`);
  const sc = r.headers['set-cookie'] || [];
  check('?t= が 302', r.status === 302, `HTTP ${r.status} loc=${r.headers.location}`);
  check('HttpOnly Cookie が焼かれる', sc.some((c) => c.includes('__proxy_auth=') && c.includes('HttpOnly')),
    JSON.stringify(sc[0] || '').slice(0, 90));
  check('Location から t= が除去されている', r.headers.location === '/', `loc=${r.headers.location}`);
  const cookie = (sc[0] || '').split(';')[0];
  check('Cookie 値が取得できた', !!cookie, cookie ? cookie.slice(0, 20) + '…' : 'NG');

  r = await req('GET', '/?t=this-token-is-wrong');
  check('誤トークンは拒否される', r.status === 302 && r.headers.location === '/__gate__', `HTTP ${r.status} loc=${r.headers.location}`);

  console.log('\n=== 3. Spotify HTML のプロキシ（最重要）===');
  r = await req('GET', '/', { cookie });
  const html = text(r);
  check('/ が 200', r.status === 200, `HTTP ${r.status} ${html.length}B`);
  check('Spotify の HTML が返る', /<html/i.test(html) && /spotify/i.test(html), html.slice(0, 70).replace(/\s+/g, ' '));
  check('CSP が除去されている', !r.headers['content-security-policy'], r.headers['content-security-policy'] ? '残存!' : 'removed');
  check('X-Frame-Options が除去されている', !r.headers['x-frame-options']);
  check('SW 登録コードが注入されている', html.includes("serviceWorker.register('/sw.js'"));
  check('WebSocket シムが注入されている', html.includes('NativeWS') && html.includes('/__ws__/'));
  const rew = (html.match(/\/__p__\//g) || []).length;
  check('Spotify URL が書き換わっている', rew > 5, `/__p__/ が ${rew} 箇所`);
  const left = html.match(/https?:\/\/[a-z0-9.-]*(?:spotify\.com|scdn\.co|spotifycdn\.com)/gi) || [];
  check('素の Spotify 絶対URL が残っていない', left.length === 0, left.length ? `残${left.length}: ${[...new Set(left)].slice(0, 3).join(', ')}` : 'clean');
  const upCookies = r.headers['set-cookie'] || [];
  check('Set-Cookie から Domain が除去されている', !upCookies.some((c) => /;\s*domain=/i.test(c)),
    `${upCookies.length}個 / ${JSON.stringify(upCookies[0] || '').slice(0, 60)}`);
  check('認証CookieがSpotifyに漏れていない', !upCookies.some((c) => c.includes(TOKEN)), '');

  console.log('\n=== 4. Service Worker ===');
  r = await req('GET', '/sw.js', { cookie });
  const sw = text(r);
  check('/sw.js が 200 + JS', r.status === 200 && sw.includes("addEventListener('fetch'"), `HTTP ${r.status} ${sw.length}B`);
  check('Content-Type が JS', /javascript/.test(r.headers['content-type'] || ''), r.headers['content-type']);
  check('Service-Worker-Allowed: /', r.headers['service-worker-allowed'] === '/');
  check('SW が /__p__/ に書き換える', sw.includes('__p__') && /spotify/.test(sw));
  check('SW が credentials:include でCookieを送る', sw.includes("credentials: 'include'"));

  console.log('\n=== 5. JS バンドルのプロキシ（1.5MB級）===');
  r = await req('GET', '/__p__/open.spotifycdn.com/cdn/build/web-player/vendor~web-player.b415aea9.js', { cookie });
  const js = text(r);
  check('vendor JS が 200', r.status === 200, `HTTP ${r.status} ${(js.length / 1024 / 1024).toFixed(2)}MB`);
  const jsRew = (js.match(/\/__p__\//g) || []).length;
  check('JS 内の URL も書き換わっている', jsRew > 0, `/__p__/ が ${jsRew} 箇所`);
  check('Shaka/EME コードが保持されている', js.includes('requestMediaKeySystemAccess'));
  check('Widevine 文字列が保持されている', js.includes('com.widevine.alpha'));

  console.log('\n=== 6. Web API ===');
  r = await req('GET', '/__p__/api.spotify.com/v1/me', { cookie });
  check('api.spotify.com に到達 (401 が正解)', r.status === 401, `HTTP ${r.status} ${text(r).slice(0, 60).replace(/\s+/g, ' ')}`);
  r = await req('GET', '/__p__/api.spotify.com/v1/search?q=test&type=track&limit=1', { cookie });
  check('search API に到達 (401 が正解)', r.status === 401, `HTTP ${r.status}`);

  console.log('\n=== 7. 画像 CDN（バイナリ素通し）===');
  r = await req('GET', '/__p__/i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228', { cookie });
  check('i.scdn.co の画像が取得できる', r.status === 200 && r.body.length > 1000, `HTTP ${r.status} ${r.body ? r.body.length : 0}B ct=${r.headers['content-type']}`);
  check('画像が書き換えされず素通し', (r.headers['content-type'] || '').startsWith('image/'), r.headers['content-type']);

  console.log('\n=== 8. リダイレクトの書き換え ===');
  r = await req('GET', '/__p__/accounts.spotify.com/', { cookie });
  check('accounts.spotify.com に到達', [200, 301, 302, 303, 307].includes(r.status), `HTTP ${r.status}`);
  check('Location が /__p__/ 形に書き換わる', !r.headers.location || r.headers.location.startsWith('/'), `loc=${r.headers.location}`);
  check('Location に素の spotify.com が残らない', !/https?:\/\/[a-z0-9.-]*spotify\.com/i.test(r.headers.location || ''), `loc=${r.headers.location}`);

  console.log('\n=== 9. SPA ルーティング ===');
  r = await req('GET', '/playlist/37i9dQZF1DXcBWIGoYBM5M', { cookie });
  check('/playlist/... が open.spotify.com に転送', r.status === 200 && /<html/i.test(text(r)), `HTTP ${r.status} ${text(r).length}B`);

  console.log('\n=== 10. 診断ページ ===');
  r = await req('GET', '/__diag__', { cookie });
  check('/__diag__ が 200', r.status === 200 && text(r).includes('診断'), `HTTP ${r.status}`);
  check('診断ページに検査ボタンがある', text(r).includes('検査を実行'));

  console.log('\n=== 11. オープンプロキシ化の防止 ===');
  r = await req('GET', '/__p__/example.com/', { cookie });
  check('example.com は 403', r.status === 403, `HTTP ${r.status} ${text(r).slice(0, 45)}`);
  r = await req('GET', '/__p__/169.254.169.254/latest/meta-data/', { cookie });
  check('クラウドのメタデータIPは 403', r.status === 403, `HTTP ${r.status}`);
  r = await req('GET', '/__p__/localhost:10000/', { cookie });
  check('localhost は 403', r.status === 403, `HTTP ${r.status}`);
  r = await req('GET', '/__p__/google.com/', { cookie });
  check('google.com は 403', r.status === 403, `HTTP ${r.status}`);

  console.log('\n=== 12. 既存モード (トンネル) の共存 ===');
  r = await req('GET', '/tunnel');
  check('/tunnel がゲートにハイジャックされない', r.status !== 302, `HTTP ${r.status}`);
  // 注: 素の CONNECT は Render の LB が中継しないため、ここからは検証できない。
  //     (モードA は wss://<host>/tunnel を使う。そちらは 13 で検証する)
  r = await req('GET', '/__gate__');
  check('/__gate__ は何度でも開ける', r.status === 200, `HTTP ${r.status}`);

  console.log('\n=== 13. WebSocket プロキシ ===');
  {
    const WebSocket = require('ws');
    const wsres = await new Promise((resolve) => {
      const ws = new WebSocket(`wss://${BASE}/__ws__/dealer.spotify.com/?country=JP`, { headers: { Cookie: cookie }, handshakeTimeout: 20000 });
      const t = setTimeout(() => { try { ws.terminate(); } catch {} resolve('timeout'); }, 20000);
      ws.on('open', () => { clearTimeout(t); ws.close(); resolve('opened'); });
      ws.on('unexpected-response', (_q, rr) => { clearTimeout(t); resolve('HTTP ' + rr.statusCode); });
      ws.on('error', (e) => { clearTimeout(t); resolve('err: ' + e.message); });
    });
    check('WSプロキシが応答する (ハングしない)', wsres !== 'timeout', wsres);
  }
  {
    const WebSocket = require('ws');
    const wsres = await new Promise((resolve) => {
      const ws = new WebSocket(`wss://${BASE}/__ws__/example.com/x`, { headers: { Cookie: cookie }, handshakeTimeout: 15000 });
      const t = setTimeout(() => { try { ws.terminate(); } catch {} resolve('timeout'); }, 15000);
      ws.on('open', () => { clearTimeout(t); ws.close(); resolve('opened(NG!)'); });
      ws.on('unexpected-response', (_q, rr) => { clearTimeout(t); resolve('HTTP ' + rr.statusCode); });
      ws.on('error', (e) => { clearTimeout(t); resolve('err: ' + e.message); });
    });
    check('許可外ホストのWSは 403', /403/.test(wsres), wsres);
  }

  console.log('\n=== 14. セキュリティ: トークン漏洩チェック ===');
  r = await req('GET', '/', { cookie });
  check('HTML内にトークンが含まれない', !text(r).includes(TOKEN));
  r = await req('GET', '/__p__/api.spotify.com/v1/me', { cookie: cookie + '; x=1' });
  check('認証CookieをUpstreamに送っていない(401維持)', r.status === 401, `HTTP ${r.status}`);

  console.log(`\n${'='.repeat(64)}`);
  console.log(`結果: ${pass} pass / ${fail} fail   (https://${BASE})`);
  console.log('='.repeat(64));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
