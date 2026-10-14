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
/**
 * Spotify ドメインへの絶対 URL を、自オリジンのプロキシ URL に書き換える。
 *
 * ★ 必ず「絶対 URL」で出力すること。
 *   相対パス (/__p__/host/...) にすると、Spotify 側のコードにある
 *   base 引数なしの new URL(x) が
 *     TypeError: Failed to construct 'URL': Invalid URL
 *   で例外を投げてアプリ全体が落ちる（実測で確認）。
 *   特に new URL(i.redirectToUrl) / new URL(p.fetchData.url) は
 *   サーバ応答 JSON から URL を読むため、JSON 書き換えも絶対である必要がある。
 *
 * origin が空（Host ヘッダ不明）の場合のみ相対形にフォールバックする。
 */
function rewriteText(text, origin) {
  const o = origin || '';
  // JSON エスケープ形 (https:\/\/host) 用にスラッシュをエスケープした origin
  const oEsc = o.replace(/\//g, '\\/');
  let out = text.replace(RE_PLAIN, (_m, _proto, host) => `${o}${P}${host}`);
  out = out.replace(RE_ESCAPED, (_m, host) => `${oEsc}\\/__p__\\/${host}`);
  return out;
}

/** リクエストから自オリジン (https://host) を組み立てる */
function originOf(req) {
  // Render の LB 背後では x-forwarded-proto: https が入る。
  // ローカルで直接 HTTP 接続した場合は socket の暗号化状態から判定する。
  const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = fwd || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = req.headers.host || req.headers['x-forwarded-host'];
  return host ? `${proto}://${host}` : '';
}

/**
 * HTML の <head> 直後に注入するシム。
 *
 * ★ なぜ Service Worker だけでは不十分か
 *   SW は「登録された次のナビゲーション」からしかページを制御できない。
 *   つまり初回ロードでは SW が効いておらず、JS が実行時に組み立てた
 *   https://api.spotify.com/... 等がそのまま Spotify に直行して失敗する
 *   (ブロック下ではそこで "エラーが発生したようです" 画面になる)。
 *
 *   そこで fetch / XHR / WebSocket / sendBeacon / 動的 src を
 *   『同期的に・初回ロードから』書き換えるシムを注入する。
 *   SW は保険として併用する。
 */
const SRP_VERSION = '4';

const INJECT = `
<script data-srp-version="${SRP_VERSION}">/* injected by spotify-render-proxy */
(function(){
  if (window.__srpInstalled) return;
  window.__srpInstalled = true;

  var SP = /(^|\\.)(spotify\\.com|scdn\\.co|spotifycdn\\.com|spotilocal\\.com)$/i;
  var PREFIX = '/__p__/';
  var ABS_PREFIX = location.origin + PREFIX;   // 書き換えは常に絶対 URL で行う
  var WSPREFIX = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/__ws__/';
  var log = [];
  window.__srp_log = log;                 // コンソールから window.__srp_log で確認できる
  window.__srp_stats = { rewritten: 0, escaped: 0 };
  function note(kind, from, to) {
    if (log.length < 400) log.push(kind + ' ' + from + (to ? ' -> ' + to : ''));
    if (kind === 'ESCAPE') window.__srp_stats.escaped++;
    else window.__srp_stats.rewritten++;
    if (kind === 'ESCAPE' && window.console) console.warn('[spotify-proxy] 書き換え漏れ?', from);
  }

  /**
   * 絶対URL -> 自オリジンのプロキシ URL
   * ★ 必ず「絶対 URL」を返すこと。相対パスを返すと Spotify 側コードの
   *   base 引数なし new URL(x) が "Invalid URL" で例外になり起動に失敗する。
   */
  function rw(u) {
    if (typeof u !== 'string' || !u) return u;
    if (u.indexOf(ABS_PREFIX) === 0) return u;           // 既にプロキシ形(絶対)
    if (u.indexOf(PREFIX) === 0) return location.origin + u;  // 相対形は絶対へ補正
    var url;
    try { url = new URL(u, location.href); } catch (e) { return u; }
    if (!url.host) return u;
    if (url.origin === location.origin) return u;        // 自オリジン
    if (!SP.test(url.hostname)) return u;                // Spotify 以外 (Google 等) は素通し
    var out = ABS_PREFIX + url.hostname + url.pathname + url.search;
    note('rewrite', u, out);
    return out;
  }

  // ---------- (1) fetch ----------
  try {
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          if (typeof input === 'string') input = rw(input);
          else if (input instanceof URL) input = rw(input.href);
          else if (input && typeof input.url === 'string') {
            var nu = rw(input.url);
            if (nu !== input.url) input = new Request(nu, input);
          }
        } catch (e) {}
        return origFetch.call(this, input, init);
      };
    }
  } catch (e) { console.error('[spotify-proxy] fetch shim failed', e); }

  // ---------- (2) XMLHttpRequest ----------
  try {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { if (arguments.length > 1) arguments[1] = rw(url); } catch (e) {}
      return origOpen.apply(this, arguments);
    };
  } catch (e) { console.error('[spotify-proxy] XHR shim failed', e); }

  // ---------- (3) WebSocket (SW では傍受できないため必須) ----------
  try {
    var NativeWS = window.WebSocket;
    function PatchedWS(url, protocols) {
      try {
        var u = new URL(url, location.href);
        if (u.origin !== location.origin && SP.test(u.hostname)) {
          var nu = WSPREFIX + u.hostname + u.pathname + u.search;
          note('ws-rewrite', url, nu);
          url = nu;
        }
      } catch (e) {}
      return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    }
    PatchedWS.prototype = NativeWS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { PatchedWS[k] = NativeWS[k]; });
    window.WebSocket = PatchedWS;
  } catch (e) { console.error('[spotify-proxy] WS shim failed', e); }

  // ---------- (4) navigator.sendBeacon ----------
  try {
    if (navigator.sendBeacon) {
      var origBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (u, d) { return origBeacon(rw(u), d); };
    }
  } catch (e) {}

  // ---------- (5) 動的に設定される src / href ----------
  try {
    [['HTMLImageElement', 'src'], ['HTMLScriptElement', 'src'], ['HTMLMediaElement', 'src'],
     ['HTMLSourceElement', 'src'], ['HTMLIFrameElement', 'src'], ['HTMLLinkElement', 'href']
    ].forEach(function (pair) {
      var Ctor = window[pair[0]], prop = pair[1];
      if (!Ctor || !Ctor.prototype) return;
      var d = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
      if (!d || !d.set || !d.get) return;
      Object.defineProperty(Ctor.prototype, prop, {
        configurable: true, enumerable: d.enumerable,
        get: function () { return d.get.call(this); },
        set: function (v) { try { v = rw(v); } catch (e) {} d.set.call(this, v); },
      });
    });
  } catch (e) { console.error('[spotify-proxy] src shim failed', e); }

  // ---------- (6) 書き換え漏れの検出 (診断用) ----------
  // パッチを通らずに Spotify へ出て行こうとしたリクエストを拾って警告する
  try {
    window.addEventListener('error', function (e) {
      var t = e && e.target;
      if (t && (t.src || t.href)) {
        var s = String(t.src || t.href);
        if (/^(https?:)?\\/\\//.test(s) && SP.test((function () { try { return new URL(s, location.href).hostname; } catch (x) { return ''; } })())) {
          note('ESCAPE', s);
        }
      }
    }, true);
  } catch (e) {}

  // ---------- (7) Service Worker (保険) ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(function (reg) {
        console.log('[spotify-proxy] SW registered, scope=' + reg.scope +
          ', controlling=' + !!navigator.serviceWorker.controller);
      })
      .catch(function (e) { console.error('[spotify-proxy] SW registration FAILED', e); });
  }

  // ---------- (8) JS エラーの収集 ----------
  // DevTools を開けない環境でも原因を追えるよう、エラーをサーバへ送る。
  var errors = [];
  function pushErr(s) {
    s = String(s).slice(0, 400);
    if (errors.length < 60 && errors.indexOf(s) === -1) errors.push(s);
  }
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && t !== window && (t.src || t.href)) {
      pushErr('resource-load-failed: ' + (t.tagName || '?') + ' ' + (t.src || t.href));
      return;
    }
    pushErr('onerror: ' + (e && e.message) + ' @' + (e && e.filename) + ':' + (e && e.lineno));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    pushErr('unhandledrejection: ' + ((r && (r.message || r.statusText)) || r));
  });
  var origErr = console.error;
  try {
    console.error = function () {
      try { pushErr('console.error: ' + Array.prototype.slice.call(arguments).map(String).join(' ').slice(0, 300)); } catch (x) {}
      return origErr.apply(this, arguments);
    };
  } catch (e) {}

  // ---------- (9) サーバへの診断レポート送信 ----------
  var VER = document.currentScript ? document.currentScript.getAttribute('data-srp-version') : '?';
  window.__srp_ver = VER;   // 診断ページから参照できるようにする
  function snapshot() {
    return {
      v: VER,
      href: location.href.slice(0, 200),
      swController: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      stats: window.__srp_stats,
      log: log.slice(-120),
      errors: errors.slice(-40),
      boot: {
        title: (document.title || '').slice(0, 80),
        bodyLen: (document.body ? document.body.innerHTML.length : 0),
        // Spotify のエラー画面が出ていないか
        errorScreen: /エラーが発生した|Something went wrong|page could not be loaded/i.test(
          document.body ? document.body.innerText.slice(0, 4000) : ''),
        hasRoot: !!document.getElementById('main') || !!document.querySelector('#app,#root,[data-testid]'),
      },
    };
  }
  function report() {
    try {
      var payload = JSON.stringify(snapshot());
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/__report__', new Blob([payload], { type: 'application/json' }));
      } else {
        origFetch.call(window, '/__report__', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true,
        });
      }
    } catch (e) {}
  }
  window.__srp_report = report;      // 手動送信用
  window.__srp_snapshot = snapshot;  // 状態確認用
  // 起動直後から一定間隔で送る（初回ロードの問題を確実に捕捉する）
  [2000, 6000, 12000, 25000, 45000].forEach(function (ms) { setTimeout(report, ms); });
  window.addEventListener('pagehide', report);

  // ---------- (10) 画面上のステータスバッジ（コンソール不要で状態が見える）----------
  try {
    var badge = document.createElement('div');
    badge.id = '__srp_badge';
    badge.setAttribute('style',
      'all:initial;position:fixed;right:10px;bottom:10px;z-index:2147483647;' +
      'background:rgba(18,18,18,.94);color:#eaeaea;border:1px solid #1db954;border-radius:8px;' +
      'padding:7px 10px;font:12px/1.5 system-ui,sans-serif;cursor:pointer;max-width:290px;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.5)');
    document.documentElement.appendChild(badge);
    function paint() {
      var st = window.__srp_stats;
      var bad = errors.length || st.escaped;
      badge.innerHTML =
        '<div style="color:#1db954;font-weight:700">spotify-proxy shim v' + VER + '</div>' +
        '<div>URL書換 <b style="color:#1db954">' + st.rewritten + '</b> / 逃し <b style="color:' +
          (st.escaped ? '#ff6b6b' : '#1db954') + '">' + st.escaped + '</b> / エラー <b style="color:' +
          (errors.length ? '#ff6b6b' : '#1db954') + '">' + errors.length + '</b></div>' +
        '<div style="color:#999;font-size:11px">SW制御: ' +
          (navigator.serviceWorker && navigator.serviceWorker.controller ? 'あり' : 'なし') +
          ' — クリックで詳細ログ</div>';
      badge.style.borderColor = bad ? '#ff6b6b' : '#1db954';
    }
    paint();
    setInterval(function () { paint(); report(); }, 8000);
    badge.addEventListener('click', function () { window.open('/__log__', '_blank'); });
  } catch (e) {}

  console.log('[spotify-proxy] shim v' + VER +
    ' installed (fetch/XHR/WebSocket/src は初回ロードから書き換え有効)');
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

// ------------------------------------------------------------------ テレメトリ
// コンソール/DevTools を使えない環境でも診断できるように、
// ①プロキシした全リクエスト ②ブラウザ側から送られてきた診断レポート を
// サーバのメモリ上に保持し、/__log__ から JSON で取り出せるようにする。
const MAX_REQ_LOG = Number(process.env.LOG_REQ || 400);
const MAX_ERR_LOG = 200;
const MAX_REPORTS = 40;
const reqLog = [];
const errLog = [];
const reports = [];

function pushRing(arr, item, max) {
  arr.push(item);
  while (arr.length > max) arr.shift();
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
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>spotify-render-proxy 診断</title>
<style>
 body{font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#121212;color:#fff;margin:0;padding:24px}
 h1{font-size:20px;margin:0 0 4px} p{color:#b3b3b3;margin:0 0 16px;font-size:13px}
 table{border-collapse:collapse;width:100%;max-width:980px;margin-top:12px}
 th,td{border:1px solid #333;padding:8px 10px;text-align:left;vertical-align:top;word-break:break-all}
 th{background:#1db954;color:#000}
 .ok{color:#1db954;font-weight:700} .ng{color:#ff4d4d;font-weight:700} .warn{color:#ffb020;font-weight:700}
 button{background:#1db954;color:#000;border:0;padding:10px 18px;border-radius:20px;font-weight:700;cursor:pointer;font-size:14px;margin-right:8px}
 button.sec{background:#333;color:#fff}
 #log{background:#000;padding:12px;border-radius:6px;max-width:980px;white-space:pre-wrap;font:12px/1.5 monospace;margin-top:12px;max-height:340px;overflow:auto}
 a{color:#1db954} .note{background:#1c1c1c;border-left:3px solid #1db954;padding:10px 12px;max-width:980px;font-size:12px;color:#bbb;margin-top:14px}
</style></head><body>
<h1>🔍 spotify-render-proxy 診断</h1>
<p>各 Spotify エンドポイントが<b>このオリジン経由</b>で取得できるかを検査します。
「OK」＝プロキシが正しく中継できている、という意味です。</p>
<button id="run">検査を実行</button>
<button id="sw" class="sec">SW 状態</button>
<button id="shim" class="sec">shim 状態</button>
<a href="/"><button class="sec">→ Web Player</button></a>
<a href="/__log__"><button class="sec">→ ログ</button></a>
<table><thead><tr><th>対象</th><th>結果</th><th>詳細</th></tr></thead><tbody id="rows"></tbody></table>
<div class="note">
<b>判定の意味</b><br>
・<span class="ok">OK</span> = プロキシが中継できた（<b>401 / 404 / 307 でも Spotify に到達していれば OK</b>。
   Spotify 自身が返す応答なので正常です）<br>
・<span class="ng">NG</span> = プロキシ自体が失敗（<code>502</code> + 本文が <code>[spotify-render-proxy]</code> で始まる）<br>
・ログインしていない場合、<code>api.spotify.com/v1/me</code> が <b>401</b> になるのは<b>正常</b>です
</div>
<div id="log"></div>
<script>
const P = '${P}';
const rows = document.getElementById('rows'), logEl = document.getElementById('log');
function log(s){ logEl.textContent += s + '\\n'; logEl.scrollTop = logEl.scrollHeight; }

// 私たち自身のプロキシが返すエラーかどうか
function isProxyError(status, body){
  return status === 502 && /\\[spotify-render-proxy\\]/.test(body || '');
}

// 固定リスト + トップページから動的に拾った実在の JS/画像 URL
async function buildTargets(){
  const T = [
    ['open.spotify.com (HTML)',      P+'open.spotify.com/',                                   'html'],
    ['api.spotify.com (REST)',       P+'api.spotify.com/v1/me',                               'json401'],
    ['accounts.spotify.com',         P+'accounts.spotify.com/',                               'redirect'],
    ['spclient.wg.spotify.com',      P+'spclient.wg.spotify.com/',                            'reachable'],
    ['apresolve.spotify.com',        P+'apresolve.spotify.com/',                              'json'],
    ['clienttoken.spotify.com',      P+'clienttoken.spotify.com/v1/clienttoken',              'reachable'],
    ['i.scdn.co (実在する画像)',      P+'i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228','img'],
  ];
  try{
    const r = await fetch('/', {cache:'no-store'});
    const html = await r.text();
    const js = (html.match(/src="([^"]+\\.js[^"]*)"/) || [])[1];
    if (js) T.splice(1, 0, ['JS バンドル (実URL)', js.startsWith('/') ? js : js, 'js']);
    const img = (html.match(/https?:\\/\\/[a-z0-9.\\-]*scdn\\.co\\/[^"')\\s]+/) || [])[0];
    if (img) T.push(['画像 (HTML内から抽出)', img, 'img']);
    T.push(['HTMLの書き換え状況', '/', 'rewriteCount']);
  }catch(e){ log('[warn] トップページ取得失敗: ' + e.message); }
  return T;
}

async function runOne(name, url, kind){
  const tr = document.createElement('tr');
  tr.innerHTML = '<td>'+name+'</td><td>…</td><td></td>';
  rows.appendChild(tr);
  const t0 = performance.now();
  try{
    const r = await fetch(url, {cache:'no-store'});
    const ms = Math.round(performance.now() - t0);
    const ct = r.headers.get('content-type') || '';
    let detail = 'HTTP '+r.status+' / '+ct.slice(0,38)+' / '+ms+'ms';
    let cls = 'ok', label = 'OK';

    if (kind === 'html'){
      const b = await r.text();
      detail += ' / '+b.length+'B';
      if (r.status !== 200 || !/<html/i.test(b)) { cls='ng'; label='NG'; }
      else if (!b.includes('data-srp-version')) { cls='warn'; label='WARN(shim無し)'; }
    } else if (kind === 'rewriteCount'){
      const b = await r.text();
      const n = (b.match(/\\/__p__\\//g) || []).length;
      const left = b.match(/https?:\\/\\/[a-z0-9.\\-]*(?:spotify\\.com|scdn\\.co|spotifycdn\\.com)/gi) || [];
      detail = '書き換え '+n+' 箇所 / 素の絶対URL残存 '+left.length+' 件';
      if (n < 5) { cls='ng'; label='NG'; }
      else if (left.length) { cls='warn'; label='WARN(残存'+left.length+')'; }
    } else if (kind === 'js'){
      const b = await r.text();
      const n = (b.match(/\\/__p__\\//g) || []).length;
      detail += ' / '+(b.length/1024).toFixed(0)+'KB / 書き換え'+n+'箇所';
      if (r.status !== 200) { cls='ng'; label='NG'; }
      else if (!n) { cls='warn'; label='WARN(書換0)'; }
    } else if (kind === 'json401'){
      const b = await r.text();
      detail += ' body='+b.slice(0,80).replace(/\\s+/g,' ');
      // 401 = Spotify に到達したが未認証 = プロキシとしては正常
      if (isProxyError(r.status, b)) { cls='ng'; label='NG'; }
    } else if (kind === 'json'){
      const b = await r.text();
      detail += ' body='+b.slice(0,70).replace(/\\s+/g,' ');
      if (isProxyError(r.status, b)) { cls='ng'; label='NG'; }
    } else if (kind === 'redirect'){
      detail += ' loc='+(r.headers.get('location')||'-').slice(0,60);
      if (isProxyError(r.status, await r.clone().text())) { cls='ng'; label='NG'; }
      else if (r.status < 300 || r.status >= 400) { cls='warn'; label='WARN'; }
    } else if (kind === 'img'){
      const b = await r.arrayBuffer();
      detail += ' / '+b.byteLength+'B';
      if (r.status !== 200 || b.byteLength < 500) { cls='ng'; label='NG'; }
    } else { // reachable
      const b = await r.text();
      detail += ' body='+b.slice(0,60).replace(/\\s+/g,' ');
      if (isProxyError(r.status, b)) { cls='ng'; label='NG'; }
    }
    tr.children[1].innerHTML = '<span class="'+cls+'">'+label+'</span>';
    tr.children[2].textContent = detail;
    log((cls==='ok'?'[OK]  ':cls==='warn'?'[WARN]':'[NG]  ') + name + ' -> ' + detail);
  }catch(e){
    tr.children[1].innerHTML = '<span class="ng">ERR</span>';
    tr.children[2].textContent = e.message;
    log('[ERR] ' + name + ' -> ' + e.message);
  }
}

document.getElementById('sw').onclick = async () => {
  if (!('serviceWorker' in navigator)) return log('Service Worker 非対応ブラウザです');
  const r = await navigator.serviceWorker.getRegistration('/');
  log(r ? ('SW 登録あり: scope='+r.scope+' active='+(!!r.active)+' state='+(r.active&&r.active.state))
        : 'SW 未登録（ページをリロードしてください）');
  log('controller='+(navigator.serviceWorker.controller ? 'あり（このページは制御下）' : 'なし（リロードが必要）'));
};
document.getElementById('shim').onclick = () => {
  log('shim 導入='+(window.__srpInstalled ? 'はい' : 'いいえ') +
      ' / stats=' + JSON.stringify(window.__srp_stats || null));
  const l = window.__srp_log || [];
  log('書き換えログ ' + l.length + ' 件（先頭10）:');
  l.slice(0,10).forEach(x => log('   ' + x));
};
document.getElementById('run').onclick = async () => {
  rows.innerHTML = ''; logEl.textContent = '';
  log('controller=' + (navigator.serviceWorker.controller ? 'あり' : 'なし'));
  log('shim=' + (window.__srpInstalled ? 'v' + (window.__srp_ver || '?') : '未導入'));
  const T = await buildTargets();
  for (const [n, u, k] of T) await runOne(n, u, k);
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

/** /__log__ の HTML ダッシュボード。DevTools を使えない環境でもブラウザだけで診断できる */
function logPage(payload) {
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>spotify-render-proxy ログ</title>
<style>
 body{font:13px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;background:#121212;color:#eaeaea;margin:0;padding:18px}
 h1{font-size:17px;margin:0 0 4px} h2{font-size:14px;margin:22px 0 6px;color:#1db954}
 .sub{color:#999;font-size:12px;margin-bottom:10px}
 button{background:#1db954;color:#000;border:0;padding:8px 16px;border-radius:18px;font-weight:700;cursor:pointer;font-size:12px;margin-right:8px}
 button.sec{background:#333;color:#fff}
 table{border-collapse:collapse;width:100%;margin-bottom:6px;font-size:12px}
 th,td{border-bottom:1px solid #2a2a2a;padding:4px 7px;text-align:left;vertical-align:top;word-break:break-all}
 th{background:#1c1c1c;color:#aaa;position:sticky;top:0}
 tr.bad td{background:#3a1d1d} tr.warn td{background:#3a321d}
 .n{color:#1db954;font-weight:700} .b{color:#ff6b6b;font-weight:700} .y{color:#ffb020;font-weight:700}
 pre{background:#000;padding:10px;border-radius:6px;overflow:auto;font:11px/1.5 monospace;max-height:340px;white-space:pre-wrap}
 .box{background:#181818;border:1px solid #282828;border-radius:8px;padding:12px;margin-bottom:10px}
 .kv{display:flex;gap:18px;flex-wrap:wrap}
 .kv div{background:#1c1c1c;padding:8px 12px;border-radius:6px}
 .kv b{display:block;font-size:19px;color:#1db954}
 code{background:#222;padding:1px 5px;border-radius:3px;color:#1db954}
 a{color:#1db954}
</style></head><body>
<h1>📋 spotify-render-proxy ログ</h1>
<div class="sub">このページはコンソール不要で診断情報を確認できます。自動更新: 5秒ごと</div>
<div>
  <button onclick="load()">今すぐ更新</button>
  <button class="sec" onclick="location.href='/'">Web Player を開く</button>
  <button class="sec" onclick="location.href='/__diag__'">接続テスト</button>
  <label style="font-size:12px;color:#aaa"><input type="checkbox" id="auto" checked> 自動更新</label>
</div>
<div class="box" id="sum" style="margin-top:14px"></div>
<h2>① ブラウザから届いた診断レポート（最重要）</h2>
<div id="reports">読み込み中…</div>
<h2>② エラー（4xx / 5xx / アップストリーム失敗）</h2>
<div id="errors">読み込み中…</div>
<h2>③ プロキシしたリクエスト（新しい順）</h2>
<div id="reqs">読み込み中…</div>
<h2>④ 生 JSON</h2>
<pre id="raw">読み込み中…</pre>
<script>
let DATA=null;
const esc=s=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const ago=t=>{const s=Math.max(0,Math.round((Date.now()-t)/1000));return s<60?s+'秒前':Math.floor(s/60)+'分前'};
function statusCls(s){return s>=500?'b':s>=400?'y':'n'}
async function load(){
  try{
    const r=await fetch('/__log__.json',{cache:'no-store'});
    DATA=await r.json();
    render();
  }catch(e){document.getElementById('sum').innerHTML='<span class="b">取得失敗: '+esc(e.message)+'</span>';}
}
function render(){
  const d=DATA;
  document.getElementById('sum').innerHTML=
    '<div class="kv">'+
    '<div><b>'+d.counters.requests+'</b>リクエスト</div>'+
    '<div><b>'+d.counters.errors+'</b>エラー</div>'+
    '<div><b>'+d.counters.reports+'</b>レポート</div>'+
    '<div><b>'+esc(d.generatedAt.slice(11,19))+'</b>更新時刻</div>'+
    '</div>';

  // ① レポート
  if(!d.reports.length){
    document.getElementById('reports').innerHTML='<div class="box"><span class="y">まだレポートが届いていません。</span><br>'+
      'Web Player (<a href="/">/</a>) を開いて 10 秒ほど待つと、ここに診断情報が自動的に送られてきます。</div>';
  } else {
    let h='<table><tr><th>時刻</th><th>shim</th><th>SW制御</th><th>書換</th><th>逃し</th><th>エラー</th><th>ページ</th></tr>';
    d.reports.forEach(r=>{
      const errN=(r.errors||[]).length;
      h+='<tr class="'+(errN?'bad':(r.stats&&r.stats.escaped?'warn':''))+'">'+
         '<td>'+ago(r.t)+'</td><td>'+esc(r.v)+'</td>'+
         '<td>'+(r.swController?'<span class="n">はい</span>':'<span class="y">いいえ</span>')+'</td>'+
         '<td class="n">'+((r.stats&&r.stats.rewritten)||0)+'</td>'+
         '<td class="'+((r.stats&&r.stats.escaped)?'b':'n')+'">'+((r.stats&&r.stats.escaped)||0)+'</td>'+
         '<td class="'+(errN?'b':'n')+'">'+errN+'</td>'+
         '<td>'+esc((r.href||'').slice(0,60))+'</td></tr>';
    });
    h+='</table>';
    d.reports.slice(0,4).forEach((r,i)=>{
      if((r.errors||[]).length || (r.log||[]).filter(x=>/ESCAPE/.test(x)).length){
        h+='<div class="box"><b>レポート #'+(i+1)+' の詳細 ('+ago(r.t)+')</b>';
        if((r.errors||[]).length){
          h+='<div style="margin-top:6px"><span class="b">■ JS エラー ('+r.errors.length+')</span><pre>'+
             r.errors.map(esc).join('\\n')+'</pre></div>';
        }
        const esc_=(r.log||[]).filter(x=>/ESCAPE/.test(x));
        if(esc_.length){
          h+='<div style="margin-top:6px"><span class="y">■ 書き換え漏れ ('+esc_.length+')</span><pre>'+
             esc_.map(esc).join('\\n')+'</pre></div>';
        }
        h+='</div>';
      }
    });
    document.getElementById('reports').innerHTML=h;
  }

  // ② エラー
  if(!d.errors.length){document.getElementById('errors').innerHTML='<div class="box"><span class="n">エラーなし</span></div>';}
  else{
    let h='<table><tr><th>時刻</th><th>種別</th><th>status/code</th><th>host</th><th>path</th></tr>';
    d.errors.slice(0,60).forEach(e=>{
      h+='<tr class="bad"><td>'+ago(e.t)+'</td><td>'+esc(e.kind)+'</td>'+
         '<td class="b">'+esc(e.status||e.code||'')+'</td><td>'+esc(e.host)+'</td><td>'+esc(e.path)+'</td></tr>';
    });
    document.getElementById('errors').innerHTML=h+'</table>';
  }

  // ③ リクエスト
  {
    let h='<table><tr><th>時刻</th><th>status</th><th>ms</th><th>host</th><th>path</th></tr>';
    d.requests.slice(0,80).forEach(r=>{
      h+='<tr class="'+(r.status>=400?'bad':'')+'"><td>'+ago(r.t)+'</td>'+
         '<td class="'+statusCls(r.status)+'">'+r.status+'</td><td>'+r.ms+'</td>'+
         '<td>'+esc(r.host)+'</td><td>'+esc((r.path||'').slice(0,90))+'</td></tr>';
    });
    document.getElementById('reqs').innerHTML=h+'</table>';
  }

  document.getElementById('raw').textContent=JSON.stringify(d.reports.slice(0,3),null,1);
}
load();
setInterval(()=>{if(document.getElementById('auto').checked)load()},5000);
</script></body></html>`;
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

  /**
   * Location ヘッダ（リダイレクト先）を自オリジンの絶対 URL に書き換える。
   * 相対だと JS 側の new URL() で壊れるため、必ず絶対形で返す。
   */
  function rewriteLocation(loc, origin) {
    if (!loc) return loc;
    try {
      const u = new URL(loc, 'https://open.spotify.com');
      if (!isSpotifyHost(u.hostname)) return loc; // Spotify 以外はそのまま
      return `${origin || ''}${P}${u.hostname}${u.pathname}${u.search}`;
    } catch {
      return rewriteText(loc, origin);
    }
  }

  /**
   * 1 リクエストをプロキシする。
   * @param {string} host  接続先ホスト
   * @param {string} path  接続先パス (query 含む)
   */
  function proxy(req, res, host, path) {
    const t0 = Date.now();
    const origin = originOf(req);       // 書き換え後の絶対 URL の基準
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
        if (ures.headers.location) outHeaders.push('Location', rewriteLocation(ures.headers.location, origin));

        pushRing(reqLog, {
          t: Date.now(), host, path: String(path).slice(0, 220),
          status: ures.statusCode, ms: Date.now() - t0,
          ct: ct.slice(0, 40), bytes: Number(ures.headers['content-length'] || 0),
        }, MAX_REQ_LOG);
        if (ures.statusCode >= 400) {
          pushRing(errLog, { t: Date.now(), kind: 'http', host, path: String(path).slice(0, 220), status: ures.statusCode }, MAX_ERR_LOG);
        }

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
          const ok2xx = (ures.statusCode || 0) >= 200 && (ures.statusCode || 0) < 300;
          if (/text\/html/i.test(ct)) {
            // シム注入は正常応答の HTML ドキュメントに限定する
            // (CDN が返す 404 エラーページ等に注入しても意味がなく肥大化するだけ)
            if (ok2xx) body = injectHtml(body);
            body = rewriteText(body, origin);
          } else {
            body = rewriteText(body, origin);
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
      pushRing(errLog, { t: Date.now(), kind: 'upstream', host, path: String(path).slice(0, 220), code: e.code || e.message }, MAX_ERR_LOG);
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
      // API/asset/SW には 302 ではなく 401 を返す。
      // 302 にすると /sw.js が HTML(ゲートページ) を返し、
      // ブラウザが「SW の MIME 型が違う」エラーで登録に失敗するため。
      if (pathname.startsWith(P) || pathname.startsWith('/__') || pathname === '/sw.js') {
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

    // ---- ブラウザからの診断レポート受信 (コンソール不要の要)
    //      注入した shim が fetch/sendBeacon で POST してくる。
    if (pathname === '/__report__') {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 512 * 1024) { req.destroy(); return; }   // 512KB 上限
        chunks.push(c);
      });
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
        if (parsed && typeof parsed === 'object') {
          pushRing(reports, {
            t: Date.now(),
            ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim(),
            v: String(parsed.v || '').slice(0, 10),
            href: String(parsed.href || '').slice(0, 200),
            swController: parsed.swController === true,
            stats: parsed.stats || {},
            log: Array.isArray(parsed.log) ? parsed.log.slice(-120).map((x) => String(x).slice(0, 240)) : [],
            errors: Array.isArray(parsed.errors) ? parsed.errors.slice(-40).map((x) => String(x).slice(0, 400)) : [],
            boot: parsed.boot || {},
          }, MAX_REPORTS);
        }
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
      });
      req.on('error', () => { if (!res.headersSent) res.writeHead(400).end(); });
      return true;
    }

    // ---- 収集したログの出力
    //      /__log__.json : 機械可読 (サンドボックスから取得して解析する)
    //      /__log__      : HTML ダッシュボード (コンソール不要でブラウザから確認できる)
    if (pathname === '/__log__.json' || pathname === '/__log__') {
      const payload = {
        generatedAt: new Date().toISOString(),
        counters: { requests: reqLog.length, errors: errLog.length, reports: reports.length },
        // 直近のエラー (4xx/5xx とアップストリーム失敗)
        errors: errLog.slice(-60).reverse(),
        // ブラウザから届いた診断レポート (新しい順)
        reports: reports.slice(-12).reverse(),
        // 直近のリクエスト
        requests: reqLog.slice(-120).reverse(),
      };
      if (pathname === '/__log__.json') {
        const b = Buffer.from(JSON.stringify(payload, null, 1), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
        res.end(b);
        return true;
      }
      const b = Buffer.from(logPage(payload), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
      res.end(b);
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
