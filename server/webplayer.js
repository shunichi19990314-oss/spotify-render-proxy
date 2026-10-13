'use strict';

/**
 * webplayer.js — Spotify Web Player を Render のオリジン上で動かすリバースプロキシ
 * ================================================================================
 *
 * ■ なぜこれが必要か（検証済みの制約）
 *   1. open.spotify.com は CSP `frame-ancestors 'self'` を返す
 *      → iframe 埋め込みはブラウザが描画を拒否する（埋め込み不可）
 *   2. 公式 Embed / Web Playback SDK は中身が全て Spotify 側 CDN 参照
 *      → ブラウザが Spotify に直接接続するため、ブロック下では読み込み自体が失敗
 *   3. したがって「ブラウザは Render とだけ通信し、Render が Spotify と通信する」
 *      構成にするしかない
 *
 * ■ アーキテクチャ
 *   ブラウザ ──► Render (このオリジン)  ──► *.spotify.com / *.scdn.co / *.spotifycdn.com
 *
 *   URL の三重の防御で、Spotify への直接アクセスを 0 にする:
 *     (a) HTML/JS/CSS/JSON の本文を書き換え
 *         https://api.spotify.com/v1/x  ->  /__p__/api.spotify.com/v1/x
 *     (b) Service Worker (sw.js) が「実行時に組み立てられた URL」を傍受して書き換え
 *         → JS 本文の完全な解析が不要になる（ここが要）
 *     (c) window.WebSocket をパッチして wss://dealer.spotify.com を /__ws__/ 経由に
 *         → Service Worker は WebSocket を傍受できないため、別途シムが必要
 *
 * ■ 既知の未解決リスク（正直に明記）
 *   ・Widevine DRM: web-player の vendor バンドルを解析した結果、Shaka Player が
 *     「native EME があれば実 Widevine を使う」分岐になっていた。
 *     ライセンス要求は fetch/XHR なので SW が傍受して Origin を書き換えられるが、
 *     Spotify 側が Origin/Referer を検証して拒否する可能性がある。
 *     → これは実ブラウザでしか確認できない。/__diag__ で切り分けること。
 *   ・Spotify がバンドルのハッシュ付きファイル名を更新すると書き換え対象が変わる。
 */

const https = require('https');
const zlib = require('zlib');

// ------------------------------------------------------------------ 定数
const SPOTIFY_TLDS = ['spotify.com', 'scdn.co', 'spotifycdn.com', 'spotilocal.com'];
const HOST_RE = new RegExp(
  '(?:^|\\.)(' + SPOTIFY_TLDS.map((d) => d.replace(/\./g, '\\.')).join('|') + ')$',
  'i',
);
const isSpotifyHost = (h) => HOST_RE.test(String(h || '').toLowerCase().replace(/:\d+$/, ''));

// 書き換え対象の Content-Type（それ以外はバイナリとして素通し）
const REWRITE_CT =
  /^(text\/(html|css|javascript|plain|xml)|application\/(javascript|x-javascript|json|manifest\+json|xml|ld\+json|rss\+xml)|image\/svg\+xml)/i;
const MAX_REWRITE_BYTES = 24 * 1024 * 1024; // これを超えたら書き換えず素通し

// Spotify は Bot 的な UA を弾くことがあるため、実在ブラウザを名乗る
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const P = '/__p__/'; // HTTP リバースプロキシのパス prefix
const W = '/__ws__/'; // WebSocket プロキシのパス prefix

// ホスト名マッチ用の正規表現ソース（URL 文字列書き換えに使う）
const HOST_ALT = '(?:[a-z0-9\\-]+\\.)*(?:spotify\\.com|scdn\\.co|spotifycdn\\.com|spotilocal\\.com)';
// 通常形  https://api.spotify.com/...  や  //i.scdn.co/...
// 先頭の (?<![a-z]:) は "wss://" / "ws://" を除外する否定後読み。
// WebSocket は静的書き換えではなく、HTML に注入する window.WebSocket シムが担当する。
const RE_PLAIN = new RegExp('(?<![a-z:])(https?:)?//(' + HOST_ALT + ')(?=[/"\'\\s\\\\)>,;:]|$)', 'gi');
// JSON エスケープ形  https:\/\/api.spotify.com\/...
const RE_ESCAPED = new RegExp('https?:\\\\/\\\\/(' + HOST_ALT + ')', 'gi');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
// これらはオリジンが変わるので送ってはいけない / 受け取ってはいけない
const STRIP_REQ = new Set(['host', 'origin', 'referer', 'cookie', 'accept-encoding', ...HOP_BY_HOP]);
const STRIP_RES = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'strict-transport-security', 'report-to', 'nel',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  ...HOP_BY_HOP,
]);

// ------------------------------------------------------------------ 本文書き換え
/** Spotify ドメインへの絶対 URL を、自オリジンのパス prefix 形に書き換える */
function rewriteText(text) {
  let out = text.replace(RE_PLAIN, (_m, proto, host) => `${P}${host}`);
  out = out.replace(RE_ESCAPED, (_m, host) => `\\/__p__\\/${host}`);
  return out;
}

/** HTML に Service Worker 登録 + WebSocket シムを注入する */
const INJECT = `
<script>/* injected by spotify-render-proxy */
(function(){
  var SP=/(^|\\.)(spotify\\.com|scdn\\.co|spotifycdn\\.com|spotilocal\\.com)$/i;
  try{
    var NativeWS=window.WebSocket;
    function PatchedWS(url,protocols){
      try{
        var u=new URL(url,location.href);
        if(u.origin!==location.origin && SP.test(u.hostname)){
          url=(location.protocol==='https:'?'wss://':'ws://')+location.host+'${W}'+u.hostname+u.pathname+u.search;
        }
      }catch(e){}
      return protocols===undefined?new NativeWS(url):new NativeWS(url,protocols);
    }
    PatchedWS.prototype=NativeWS.prototype;
    ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){PatchedWS[k]=NativeWS[k];});
    window.WebSocket=PatchedWS;
  }catch(e){console.error('[proxy] WS shim failed',e);}
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('/sw.js',{scope:'/'})
      .then(function(r){console.log('[proxy] SW registered',r.scope);})
      .catch(function(e){console.error('[proxy] SW registration FAILED',e);});
  }else{console.warn('[proxy] Service Worker not supported');}
})();
</script>`;

function injectHtml(html) {
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + INJECT + html.slice(m.index + m[0].length);
  // <head> が無ければ先頭に
  return INJECT + html;
}

// ------------------------------------------------------------------ 圧縮
function decompressor(encoding) {
  const e = String(encoding || '').toLowerCase();
  if (e.includes('br')) return zlib.createBrotliDecompress();
  if (e.includes('gzip')) return zlib.createGunzip();
  if (e.includes('deflate')) return zlib.createInflate();
  return null;
}

// ------------------------------------------------------------------ Service Worker
const SW_SOURCE = `/* spotify-render-proxy Service Worker
 * 実行時に JS が組み立てた Spotify への絶対 URL を傍受し、
 * 自オリジンのリバースプロキシ経由に書き換える。
 * (HTML/JS 本文の書き換えだけでは捕捉できない URL のための安全網)
 */
const SP = /(^|\\.)(spotify\\.com|scdn\\.co|spotifycdn\\.com|spotilocal\\.com)$/i;
const PREFIX = '${P}';

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PUT' &&
      req.method !== 'DELETE' && req.method !== 'HEAD' && req.method !== 'OPTIONS') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // 自オリジン宛ては既にプロキシ形なので素通し
  if (url.origin === self.location.origin) return;
  // Spotify 系以外は素通し（Google reCAPTCHA 等は直接アクセスさせる）
  if (!SP.test(url.hostname)) return;

  const target = new URL(PREFIX + url.hostname + url.pathname + url.search, self.location.origin);

  event.respondWith((async () => {
    try {
      const init = {
        method: req.method,
        headers: req.headers,
        mode: 'cors',
        credentials: 'include',
        redirect: 'follow',
        cache: 'no-store',
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        init.body = req.body;
        init.duplex = 'half';
      }
      return await fetch(target, init);
    } catch (err) {
      return new Response('[proxy] SW fetch failed: ' + err + '\\n' + target.href,
                          { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  })());
});
`;

// ------------------------------------------------------------------ 診断ページ
function diagPage() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<title>spotify-render-proxy 診断</title>
<style>
 body{font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#121212;color:#fff;margin:0;padding:24px}
 h1{font-size:20px} table{border-collapse:collapse;width:100%;max-width:900px;margin-top:12px}
 th,td{border:1px solid #333;padding:8px 10px;text-align:left;vertical-align:top}
 th{background:#1db954;color:#000} code{background:#222;padding:2px 5px;border-radius:3px}
 .ok{color:#1db954;font-weight:700} .ng{color:#ff4d4d;font-weight:700} .warn{color:#ffb020;font-weight:700}
 button{background:#1db954;color:#000;border:0;padding:10px 18px;border-radius:20px;font-weight:700;cursor:pointer;font-size:14px}
 #log{background:#000;padding:12px;border-radius:6px;max-width:900px;white-space:pre-wrap;font:12px/1.5 monospace;margin-top:12px;max-height:300px;overflow:auto}
 a{color:#1db954}
</style></head><body>
<h1>spotify-render-proxy 診断ページ</h1>
<p>各 Spotify エンドポイントが<b>このオリジン経由</b>で取得できるかを検査します。</p>
<button id="run">検査を実行</button>
<button id="sw" style="background:#333;color:#fff">SW 状態を確認</button>
<a href="/"><button style="background:#fff">→ Web Player を開く</button></a>
<table><thead><tr><th>対象</th><th>結果</th><th>詳細</th></tr></thead><tbody id="rows"></tbody></table>
<div id="log"></div>
<script>
const T=[
 ['open.spotify.com (HTML)','${P}open.spotify.com/','text'],
 ['open.spotifycdn.com (JS)','${P}open.spotifycdn.com/cdn/build/web-player/vendor~web-player.b415aea9.js','js'],
 ['api.spotify.com (REST)','${P}api.spotify.com/v1/me','json401'],
 ['spclient.wg.spotify.com','${P}spclient.wg.spotify.com/','any'],
 ['i.scdn.co (画像)','${P}i.scdn.co/image/ab67616d0000b273000b2e1c1c1f0f0a0a0a0a0a','img'],
 ['accounts.spotify.com','${P}accounts.spotify.com/','any'],
];
const rows=document.getElementById('rows'),logEl=document.getElementById('log');
function log(s){logEl.textContent+=s+'\\n';logEl.scrollTop=logEl.scrollHeight;}
document.getElementById('sw').onclick=async()=>{
  if(!('serviceWorker' in navigator))return log('Service Worker 非対応ブラウザです');
  const r=await navigator.serviceWorker.getRegistration('/');
  log(r?('SW 登録あり: scope='+r.scope+' active='+(!!r.active)+' state='+(r.active&&r.active.state)):'SW 未登録 (page をリロードしてください)');
  log('controller='+(navigator.serviceWorker.controller?'あり(このページは制御下)':'なし(リロードが必要)'));
};
document.getElementById('run').onclick=async()=>{
  rows.innerHTML='';logEl.textContent='';
  log('controller='+(navigator.serviceWorker.controller?'あり':'なし'));
  for(const [name,url,kind] of T){
    const tr=document.createElement('tr');
    tr.innerHTML='<td>'+name+'</td><td>…</td><td></td>';rows.appendChild(tr);
    const t0=performance.now();
    try{
      const r=await fetch(url,{cache:'no-store'});
      const ms=Math.round(performance.now()-t0);
      const ct=r.headers.get('content-type')||'';
      let detail='HTTP '+r.status+' / '+ct.slice(0,40)+' / '+ms+'ms';
      let cls='ok';
      if(kind==='json401'){
        const b=await r.text();
        detail+=' body='+b.slice(0,90);
        cls=(r.status===401)?'ok':'warn'; // 401 が「届いている」証拠
      }else if(r.status>=400){ cls='ng'; }
      else if(kind==='text'){ const b=await r.text(); detail+=' / '+b.length+'B'; if(!/<html/i.test(b))cls='warn'; }
      else if(kind==='js'){ const b=await r.text(); detail+=' / '+(b.length/1024).toFixed(0)+'KB';
        detail+=' / 書き換え='+(b.includes('${P}')?'★あり':'なし'); }
      else if(kind==='img'){ const b=await r.arrayBuffer(); detail+=' / '+b.byteLength+'B'; }
      tr.children[1].innerHTML='<span class="'+cls+'">'+(cls==='ok'?'OK':cls==='warn'?'WARN':'NG')+'</span>';
      tr.children[2].textContent=detail;
      log((cls==='ok'?'[OK]  ':cls==='warn'?'[WARN]':'[NG]  ')+name+' -> '+detail);
    }catch(e){
      tr.children[1].innerHTML='<span class="ng">ERR</span>';
      tr.children[2].textContent=e.message;
      log('[ERR] '+name+' -> '+e.message);
    }
  }
  log('--- 完了 ---');
};
</script></body></html>`;
}

// ------------------------------------------------------------------ 認証ゲート
const AUTH_COOKIE = '__proxy_auth';

/** 自分用の認証 Cookie を Cookie ヘッダから取り除く（Spotify に送らないため） */
function stripAuthCookie(cookieHeader) {
  if (!cookieHeader) return '';
  return cookieHeader
    .split(';')
    .map((s) => s.trim())
    .filter((kv) => kv && kv.split('=')[0] !== AUTH_COOKIE)
    .join('; ');
}

/** トークン入力ページ（?t= で受け取り HttpOnly Cookie を焼いてから / へ） */
function gatePage(message) {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>spotify-render-proxy — 認証</title>
<style>
 body{font:15px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;background:#121212;color:#fff;
      margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
 .card{background:#181818;border:1px solid #282828;border-radius:12px;padding:32px;max-width:440px;width:100%}
 h1{font-size:19px;margin:0 0 6px} p{color:#b3b3b3;margin:0 0 20px;font-size:13px}
 label{display:block;font-size:12px;color:#b3b3b3;margin-bottom:6px}
 input{width:100%;box-sizing:border-box;background:#2a2a2a;border:1px solid #3a3a3a;color:#fff;
       padding:11px 12px;border-radius:6px;font:13px monospace}
 input:focus{outline:none;border-color:#1db954}
 button{width:100%;margin-top:16px;background:#1db954;color:#000;border:0;padding:13px;
        border-radius:24px;font-weight:700;font-size:14px;cursor:pointer}
 button:hover{background:#1ed760}
 .err{background:#3a1d1d;border:1px solid #ff4d4d;color:#ff8a8a;padding:10px 12px;
      border-radius:6px;font-size:13px;margin-bottom:16px}
 .hint{margin-top:18px;font-size:12px;color:#777;border-top:1px solid #282828;padding-top:14px}
 code{background:#2a2a2a;padding:1px 5px;border-radius:3px;color:#1db954}
</style></head><body><div class="card">
<h1>🔒 spotify-render-proxy</h1>
<p>このプロキシは認証が必要です。<br>Render の <b>Environment</b> タブにある
<code>PROXY_TOKEN</code> の値を入力してください。</p>
${message ? `<div class="err">${message}</div>` : ''}
<form method="GET" action="/">
  <label for="t">PROXY_TOKEN</label>
  <input id="t" name="t" type="password" autocomplete="off" autofocus required
         placeholder="例: Xk3vQ9mZpL2nR7tYwB4cDfGhJk...">
  <button type="submit">認証して Web Player を開く</button>
</form>
<div class="hint">
  認証情報は <b>HttpOnly Cookie</b> として保存され、Spotify には転送されません。<br>
  トークンは <code>/?t=&lt;TOKEN&gt;</code> の形で直接開いても構いません。
</div>
</div></body></html>`;
}


// ------------------------------------------------------------------ プロキシ本体
/**
 * @param {object} o
 * @param {function} o.log
 * @param {function} o.warn
 * @param {function} o.tokenOk   (token:string) => boolean
 * @param {boolean}  o.PUBLIC    true なら認証をスキップ（非推奨）
 */
function createWebPlayer(o = {}) {
  const log = o.log || (() => {});
  const warn = o.warn || (() => {});
  const tokenOk = typeof o.tokenOk === 'function' ? o.tokenOk : () => false;
  const PUBLIC = o.PUBLIC === true;

  /** リクエストからトークンを取り出す（Cookie / Bearer / ?t= の順） */
  function getAuth(req) {
    if (PUBLIC) return { via: 'public', value: '' };
    const m = new RegExp('(?:^|;\\s*)' + AUTH_COOKIE + '=([^;]+)').exec(req.headers.cookie || '');
    if (m) {
      const v = decodeURIComponent(m[1]);
      if (tokenOk(v)) return { via: 'cookie', value: v };
    }
    const b = /^Bearer\s+(.+)$/i.exec((req.headers.authorization || '').trim());
    if (b && tokenOk(b[1].trim())) return { via: 'bearer', value: b[1].trim() };
    try {
      const u = new URL(req.url, 'http://localhost');
      const t = u.searchParams.get('t');
      if (t && tokenOk(t)) return { via: 'query', value: t };
    } catch { /* ignore */ }
    return null;
  }

  /** リクエストヘッダをアップロード用に組み立てる */
  function upstreamHeaders(req, host, targetPath) {
    const h = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const lower = name.toLowerCase();
      if (STRIP_REQ.has(lower)) continue;
      h[name] = req.rawHeaders[i + 1];
    }
    h.Host = host;
    h['User-Agent'] = req.headers['user-agent'] || BROWSER_UA;
    // Spotify から見ても自然な Origin/Referer を名乗る（DRM ライセンス要求の検証対策）
    h.Origin = 'https://open.spotify.com';
    h.Referer = 'https://open.spotify.com/';
    h['Accept-Encoding'] = 'gzip, deflate, br';
    // 自分用の認証 Cookie を Spotify に漏らさないよう除去して転送する
    const ck = stripAuthCookie(req.headers.cookie);
    if (ck) h.Cookie = ck;
    return h;
  }

  /** Set-Cookie を自オリジン用に書き換える（Domain を落とし Path=/ に） */
  function rewriteSetCookie(rawList) {
    if (!rawList) return undefined;
    const arr = Array.isArray(rawList) ? rawList : [rawList];
    return arr.map((c) => {
      const parts = c.split(';');
      const out = [parts[0]];
      for (const p of parts.slice(1)) {
        const t = p.trim();
        const k = t.split('=')[0].toLowerCase();
        if (k === 'domain') continue; // 自オリジンに付けるため Domain は捨てる
        if (k === 'path') continue; // Path=/ に統一
        if (k === 'samesite') { out.push('SameSite=Lax'); continue; }
        out.push(t);
      }
      out.push('Path=/');
      return out.join('; ');
    });
  }

  /** Location ヘッダ（リダイレクト先）を自オリジン形に書き換える */
  function rewriteLocation(loc) {
    if (!loc) return loc;
    try {
      const u = new URL(loc, 'https://open.spotify.com');
      if (!isSpotifyHost(u.hostname)) return loc; // Spotify 以外はそのまま
      return `${P}${u.hostname}${u.pathname}${u.search}`;
    } catch {
      return rewriteText(loc);
    }
  }

  /**
   * 1 リクエストをプロキシする。
   * @param {string} host  接続先ホスト
   * @param {string} path  接続先パス (query 含む)
   */
  function proxy(req, res, host, path) {
    const t0 = Date.now();
    const headers = upstreamHeaders(req, host, path);

    const up = https.request(
      { host, port: 443, method: req.method, path: path || '/', headers, servername: host },
      (ures) => {
        const ct = String(ures.headers['content-type'] || '');
        const ce = String(ures.headers['content-encoding'] || '');
        const needRewrite = REWRITE_CT.test(ct);

        // ---- レスポンスヘッダを組み立てる
        const outHeaders = [];
        for (let i = 0; i < ures.rawHeaders.length; i += 2) {
          const name = ures.rawHeaders[i];
          const lower = name.toLowerCase();
          if (STRIP_RES.has(lower)) continue;
          if (lower === 'set-cookie') continue; // 下で加工する
          if (lower === 'location') continue; // 下で加工する
          // 書き換える場合は長さ・圧縮・型を自分で付け直すので元のは捨てる
          if (needRewrite && (lower === 'content-length' || lower === 'content-encoding' || lower === 'content-type')) continue;
          outHeaders.push(name, ures.rawHeaders[i + 1]);
        }
        const sc = rewriteSetCookie(ures.headers['set-cookie']);
        if (sc) sc.forEach((c) => outHeaders.push('Set-Cookie', c));
        if (ures.headers.location) outHeaders.push('Location', rewriteLocation(ures.headers.location));

        // ---- バイナリ（音声・画像等）はストリーム素通し
        if (!needRewrite) {
          res.writeHead(ures.statusCode || 502, outHeaders.slice());
          ures.pipe(res);
          ures.on('error', () => res.destroy());
          res.on('close', () => ures.destroy());
          if (o.verbose) log(`proxy ${host}${path.slice(0, 60)} -> ${ures.statusCode} (stream)`);
          return;
        }

        // ---- テキスト系はバッファして書き換える
        const chunks = [];
        let size = 0;
        let tooBig = false;
        const stream = decompressor(ce);
        const src = stream ? ures.pipe(stream) : ures;
        // 展開済みなので Content-Encoding は付けてはいけない（付けると二重展開される）
        const passthroughHeaders = outHeaders.slice();

        src.on('data', (c) => {
          if (tooBig) return;
          size += c.length;
          if (size > MAX_REWRITE_BYTES) {
            // 想定より大きい: 書き換えを諦めてそのまま流す（既に溜めた分も先に吐く）
            tooBig = true;
            warn(`proxy body too large (${size}B) ${host}${path} — 書き換えず素通しします`);
            res.writeHead(ures.statusCode || 502, passthroughHeaders);
            for (const ch of chunks) res.write(ch);
            chunks.length = 0;
            src.pipe(res);
            src.on('error', () => res.destroy());
            return;
          }
          chunks.push(c);
        });
        src.on('error', (e) => {
          if (tooBig) return;
          warn(`proxy decompress fail ${host}${path}: ${e.message}`);
          if (!res.headersSent) res.writeHead(502).end('bad gateway (decompress)\n');
          else res.destroy();
        });
        src.on('end', () => {
          if (tooBig) return;
          let body = Buffer.concat(chunks).toString('utf8');
          const before = body.length;
          if (/text\/html/i.test(ct)) {
            body = injectHtml(body);
            body = rewriteText(body);
          } else {
            body = rewriteText(body);
          }
          const gz = zlib.gzipSync(Buffer.from(body, 'utf8'));
          // Node の writeHead 配列形式は「フラットな [key, value, key, value, ...]」
          res.writeHead(ures.statusCode || 502, outHeaders.concat([
            'Content-Type', ct,
            'Content-Encoding', 'gzip',
            'Content-Length', String(gz.length),
            'Vary', 'Accept-Encoding',
          ]));
          res.end(gz);
          const hits = (body.match(/\/__p__\//g) || []).length;
          if (o.verbose || hits > 0) {
            log(`proxy ${host}${path.slice(0, 50)} -> ${ures.statusCode} ${before}B rewritten(${hits}) ${Date.now() - t0}ms`);
          }
        });
      },
    );

    up.on('error', (e) => {
      warn(`proxy fail ${host}${path} -> ${e.code || e.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`[spotify-render-proxy] upstream error: ${e.code || e.message}\nhost=${host} path=${path}\n`);
      } else res.destroy();
    });
    up.setTimeout(Number(process.env.CONNECT_TIMEOUT || 15000), () => {
      warn(`proxy timeout ${host}${path}`);
      up.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });

    req.pipe(up);
    req.on('error', () => up.destroy());
  }

  /** リクエスト URL から (host, path) を解決する */
  function resolveTarget(req) {
    let pathname = req.url || '/';
    let search = '';
    const q = pathname.indexOf('?');
    if (q !== -1) { search = pathname.slice(q); pathname = pathname.slice(0, q); }

    // /__p__/<host>/<path>
    if (pathname.startsWith(P)) {
      const rest = pathname.slice(P.length);
      const i = rest.indexOf('/');
      const host = (i === -1 ? rest : rest.slice(0, i)).toLowerCase();
      const path = (i === -1 ? '/' : rest.slice(i)) + search;
      if (!host) return null;
      return { host, path };
    }
    // 予約パス以外は open.spotify.com へ（SPA のクライアントサイドルーティング用）
    return { host: 'open.spotify.com', path: pathname + search };
  }

  /** HTTP リクエストハンドラ。処理したら true を返す */
  function handle(req, res) {
    const pathname = (req.url || '/').split('?')[0];

    // index.js が自分で処理するパス（ヘルスチェック / WS トンネル）は触らない
    if (pathname === '/healthz' || pathname === '/health' || pathname === '/__status__' || pathname === '/tunnel') {
      return false;
    }

    // ---- 認証ゲート（ここだけは認証不要）
    if (pathname === '/__gate__') {
      if (getAuth(req)) { res.writeHead(302, { Location: '/' }); res.end(); return true; }
      const body = Buffer.from(gatePage(), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(body);
      return true;
    }

    // ---- 認証チェック
    const auth = getAuth(req);
    if (!auth) {
      // API/asset には 302 ではなく 401 を返す（SW の fetch が HTML を受け取ると混乱するため）
      if (pathname.startsWith(P) || pathname.startsWith('/__')) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('[spotify-render-proxy] authentication required. open /__gate__\n');
        return true;
      }
      res.writeHead(302, { Location: '/__gate__' });
      res.end();
      return true;
    }

    // ?t= で渡された場合は HttpOnly Cookie に焼き直してから、t を除いた URL へ移動
    // （トークンが URL/履歴/Referer に残るのを防ぐ）
    if (auth.via === 'query') {
      let clean = '/';
      try {
        const u = new URL(req.url, 'http://localhost');
        u.searchParams.delete('t');
        clean = u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
      } catch { /* ignore */ }
      res.writeHead(302, {
        'Set-Cookie': `${AUTH_COOKIE}=${encodeURIComponent(auth.value)}; Path=/; HttpOnly; SameSite=Lax; Secure`,
        Location: clean || '/',
        'Cache-Control': 'no-store',
      });
      res.end();
      log('auth: cookie issued via ?t=');
      return true;
    }

    // ---- Service Worker
    if (pathname === '/sw.js') {
      const body = Buffer.from(SW_SOURCE, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': body.length,
        'Service-Worker-Allowed': '/',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return true;
    }

    // ---- 診断ページ
    if (pathname === '/__diag__') {
      const body = Buffer.from(diagPage(), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(body);
      return true;
    }

    // ---- プロキシ対象: 明示的 (/__p__/<host>/...) か、SPA ルーティングのフォールバック
    if (pathname.startsWith('/__p__/')) {
      const t = resolveTarget(req);
      if (!t) { res.writeHead(400).end('bad proxy path\n'); return true; }
      if (!isSpotifyHost(t.host)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`[spotify-render-proxy] host not allowed: ${t.host}\n`);
        return true;
      }
      proxy(req, res, t.host, t.path);
      return true;
    }

    // その他の /__* 内部パスは index.js に返す
    if (pathname.startsWith('/__')) return false;

    // prefix なしのパスは open.spotify.com へ（SPA のクライアントサイドルーティング用）
    const t = resolveTarget(req);
    if (!t) { res.writeHead(400).end('bad proxy path\n'); return true; }
    proxy(req, res, t.host, t.path);
    return true;
  }

  /** WebSocket プロキシ (upgrade)。処理したら true */
  function handleUpgrade(req, socket, head) {
    const pathname = (req.url || '/').split('?')[0];
    if (!pathname.startsWith(W)) return false;

    const search = (req.url || '').slice(pathname.length);
    const rest = pathname.slice(W.length);
    const i = rest.indexOf('/');
    const host = (i === -1 ? rest : rest.slice(0, i)).toLowerCase();
    const path = (i === -1 ? '/' : rest.slice(i)) + search;

    if (!isSpotifyHost(host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }

    log(`ws-proxy -> ${host}${path.slice(0, 60)}`);

    // Spotify の WS エンドポイントへ素の TCP を張り、HTTP upgrade をそのまま中継する
    const net = require('net');
    const tls = require('tls');
    const upstream = tls.connect({ host, port: 443, servername: host }, () => {
      const lines = [`${req.method} ${path} HTTP/1.1`];
      const raw = req.rawHeaders;
      for (let k = 0; k < raw.length; k += 2) {
        const n = raw[k].toLowerCase();
        if (n === 'host' || n === 'origin' || n === 'referer' || n === 'cookie') continue;
        lines.push(`${raw[k]}: ${raw[k + 1]}`);
      }
      lines.push(`Host: ${host}`);
      lines.push('Origin: https://open.spotify.com');
      if (req.headers.cookie) lines.push(`Cookie: ${req.headers.cookie}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);

      upstream.pipe(socket);
      socket.pipe(upstream);
      const bye = () => { try { socket.destroy(); } catch {} try { upstream.destroy(); } catch {} };
      socket.on('error', bye); socket.on('close', bye);
      upstream.on('error', bye); upstream.on('close', bye);
    });
    upstream.on('error', (e) => {
      warn(`ws-proxy fail ${host} -> ${e.code || e.message}`);
      try { socket.destroy(); } catch {}
    });
    socket.on('error', () => { try { upstream.destroy(); } catch {} });
    void net;
    return true;
  }

  return { handle, handleUpgrade, isSpotifyHost };
}

module.exports = { createWebPlayer, isSpotifyHost, rewriteText, injectHtml };
