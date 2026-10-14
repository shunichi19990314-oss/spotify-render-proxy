// 注入される shim を、ブラウザ風のスタブ環境で実行して挙動を検証する
'use strict';
const fs = require('fs');
const vm = require('vm');
const { injectHtml } = require('../server/webplayer.js');

// shim 本体を取り出す
const html = injectHtml('<!DOCTYPE html><html><head></head><body></body></html>');
const m = /<script data-srp-version="(\d+)">([\s\S]*?)<\/script>/.exec(html);
if (!m) { console.error('shim を抽出できませんでした'); process.exit(2); }
const SHIM = m[2];
console.log(`shim version ${m[1]} (${SHIM.length}B) をスタブ環境で実行します\n`);

// ---- ブラウザ風のスタブ ----
const calls = { fetch: [], xhr: [], ws: [], beacon: [], imgSrc: [] };

function makeSandbox(origin) {
  const URLImpl = URL;
  class FakeRequest {
    // 実ブラウザと同じく url は第1引数から取る（init で上書きされない）
    constructor(url, init) {
      this.url = url;
      if (init) { this.method = init.method; this.headers = init.headers; }
    }
  }
  class FakeXHR {
    constructor() { this.method = null; this.url = null; }
    open(method, url) { this.method = method; this.url = url; calls.xhr.push(url); }
  }
  FakeXHR.prototype.open = FakeXHR.prototype.open;

  class FakeWS {
    constructor(url, protocols) { this.url = url; calls.ws.push(url); }
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;

  const imgSrcs = [];
  class HTMLImageElement {
    constructor() { this._src = ''; }
    get src() { return this._src; }
    set src(v) { this._src = v; imgSrcs.push(v); calls.imgSrc.push(v); }
  }
  class HTMLScriptElement extends HTMLImageElement {}
  class HTMLMediaElement extends HTMLImageElement {}
  class HTMLSourceElement extends HTMLImageElement {}
  class HTMLIFrameElement extends HTMLImageElement {}
  class HTMLLinkElement {
    constructor() { this._href = ''; }
    get href() { return this._href; }
    set href(v) { this._href = v; }
  }

  const listeners = {};
  const sandbox = {
    URL: URLImpl,
    Request: FakeRequest,
    XMLHttpRequest: FakeXHR,
    WebSocket: FakeWS,
    HTMLImageElement, HTMLScriptElement, HTMLMediaElement, HTMLSourceElement,
    HTMLIFrameElement, HTMLLinkElement,
    location: new URLImpl(origin),
    console: { log: () => {}, warn: (a) => calls.fetch.push('WARN:' + a), error: (a) => calls.fetch.push('ERR:' + a) },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    navigator: {
      sendBeacon: (u) => { calls.beacon.push(u); return true; },
      serviceWorker: { register: () => Promise.resolve({ scope: '/' }) },
    },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    document: { currentScript: { getAttribute: () => m[1] } },
    fetch: function (input, init) {
      calls.fetch.push(typeof input === 'string' ? input : (input && input.url));
      return Promise.resolve({ ok: true });
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

const ORIGIN = 'https://spotify-88jy.onrender.com';
let pass = 0, fail = 0;
const check = (n, ok, d) => { console.log(`${ok ? '✅' : '❌'} ${n.padEnd(50)} ${d || ''}`); ok ? pass++ : fail++; };

const sb = makeSandbox(ORIGIN);
vm.runInContext(SHIM, sb);

check('shim が例外なく実行された', sb.__srpInstalled === true);
check('デバッグ用 window.__srp_log が用意された', Array.isArray(sb.__srp_log));

console.log('\n--- fetch の書き換え ---');
const cases = [
  ['https://api.spotify.com/v1/me', '/__p__/api.spotify.com/v1/me'],
  ['https://open.spotify.com/playlist/x', '/__p__/open.spotify.com/playlist/x'],
  ['https://spclient.wg.spotify.com/a/b?c=1', '/__p__/spclient.wg.spotify.com/a/b?c=1'],
  ['https://i.scdn.co/image/abc', '/__p__/i.scdn.co/image/abc'],
  ['https://audio-fa.scdn.co/audio/x', '/__p__/audio-fa.scdn.co/audio/x'],
  ['/local/path', '/local/path'],                                        // 自オリジンはそのまま
  ['https://www.google.com/recaptcha/x', 'https://www.google.com/recaptcha/x'], // 非Spotifyは素通し
];
for (const [input, expect] of cases) {
  calls.fetch.length = 0;
  sb.fetch(input);
  const got = calls.fetch.filter((x) => !/^(WARN|ERR):/.test(x))[0];
  check(`fetch(${input.slice(0, 42)})`, got === expect, `-> ${got}`);
}

console.log('\n--- Request オブジェクトを渡した場合 ---');
calls.fetch.length = 0;
sb.fetch(new sb.Request('https://api.spotify.com/v1/search?q=x'));
{
  const got = calls.fetch.filter((x) => !/^(WARN|ERR):/.test(x))[0];
  check('fetch(new Request("https://api.spotify.com/..."))', got === '/__p__/api.spotify.com/v1/search?q=x', `-> ${got}`);
}

console.log('\n--- XMLHttpRequest の書き換え ---');
{
  const x = new sb.XMLHttpRequest();
  x.open('GET', 'https://api.spotify.com/v1/me');
  check('XHR.open の URL が書き換わる', calls.xhr[0] === '/__p__/api.spotify.com/v1/me', `-> ${calls.xhr[0]}`);
}

console.log('\n--- WebSocket の書き換え ---');
{
  new sb.WebSocket('wss://dealer.spotify.com/?country=JP');
  check('wss://dealer.spotify.com が /__ws__/ へ', calls.ws[0] === 'wss://spotify-88jy.onrender.com/__ws__/dealer.spotify.com/?country=JP', `-> ${calls.ws[0]}`);
  calls.ws.length = 0;
  new sb.WebSocket('wss://echo.example.com/x');
  check('非Spotify の WS は素通し', calls.ws[0] === 'wss://echo.example.com/x', `-> ${calls.ws[0]}`);
}

console.log('\n--- sendBeacon / 動的 src ---');
{
  sb.navigator.sendBeacon('https://pixel.spotify.com/event');
  check('sendBeacon が書き換わる', calls.beacon[0] === '/__p__/pixel.spotify.com/event', `-> ${calls.beacon[0]}`);

  const img = new sb.HTMLImageElement();
  img.src = 'https://i.scdn.co/image/xyz';
  check('img.src が書き換わる', img.src === '/__p__/i.scdn.co/image/xyz', `-> ${img.src}`);

  const link = new sb.HTMLLinkElement();
  link.href = 'https://encore.scdn.co/a.css';
  check('link.href が書き換わる', link.href === '/__p__/encore.scdn.co/a.css', `-> ${link.href}`);
}

console.log('\n--- 統計 ---');
console.log('   rewritten:', sb.__srp_stats.rewritten, '/ escaped:', sb.__srp_stats.escaped);
check('書き換えが実際にカウントされている', sb.__srp_stats.rewritten > 5, `${sb.__srp_stats.rewritten}件`);

console.log(`\n${'='.repeat(66)}`);
console.log(`shim 検証結果: ${pass} pass / ${fail} fail`);
console.log('='.repeat(66));
process.exit(fail ? 1 : 0);
