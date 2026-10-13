#!/usr/bin/env node
'use strict';

/**
 * spotify-render-proxy / client
 * ---------------------------------------------------------------
 * ローカルに「普通のプロキシ」を生やし、その中身を Render 上のサーバまで
 * WebSocket トンネルで運びます。
 *
 *   ブラウザ / curl / npm  ──►  127.0.0.1:8888 (このプロセス)
 *                                        │  wss://<your-app>.onrender.com/tunnel
 *                                        ▼
 *                                   Render サービス ──► open.spotify.com:443
 *
 * ローカルで待ち受けるポート:
 *   - HTTP  プロキシ  http://127.0.0.1:8888    (CONNECT トンネル + 素のHTTP転送)
 *   - SOCKS5 プロキシ socks5://127.0.0.1:1080  (任意のTCP / Spotifyデスクトップ等)
 *
 * 使い方:
 *   RENDER_URL=https://your-app.onrender.com PROXY_TOKEN=xxxx node index.js
 */

const http = require('http');
const net = require('net');
const { PassThrough } = require('stream');
const WebSocket = require('ws');

const RENDER_URL = process.env.RENDER_URL || process.env.SERVER_URL || '';
const TOKEN = process.env.PROXY_TOKEN || '';
const LOCAL_HTTP_PORT = Number(process.env.LOCAL_HTTP_PORT || 8888);
const LOCAL_SOCKS_PORT = Number(process.env.LOCAL_SOCKS_PORT || 1080);
const DISABLE_SOCKS = process.env.DISABLE_SOCKS === '1';
const HANDSHAKE_TIMEOUT = Number(process.env.HANDSHAKE_TIMEOUT || 25_000);

const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), ...a);
const warn = (...a) => console.warn(ts(), ...a);

if (!RENDER_URL) {
  console.error('RENDER_URL を指定してください (例: https://my-proxy.onrender.com)');
  process.exit(1);
}
if (!TOKEN) warn('PROXY_TOKEN が未設定です。サーバ側が認証必須なら接続できません。');

const WS_URL = RENDER_URL.replace(/^http/, 'ws').replace(/\/$/, '') + '/tunnel';
const SUBPROTOCOL = `proxy.v1.${encodeURIComponent(TOKEN)}`;

// ------------------------------------------- WS 接続ファクトリ (1トンネル=1接続)
// 共有 WS にハンドシェイクリスナが積み上がる事故を避けるため、
// トンネルごとに独立した WebSocket を張り、役目が終われば閉じる。
// 同時実行数は MAX_CONCURRENT で上限をかける。
let active = 0;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 16);

/**
 * Render 上のサーバまで WebSocket を張り、ターゲット host:port への
 * TCP トンネルを確立する。
 *
 *   送信: {"type":"connect",host,port}\n
 *   応答: "OK\n" または "ERR <code> <reason>\n"
 *   以降: 双方向のバイナリフレーム = 生 TCP ストリーム
 *   (ハンドシェイクフレームにデータを相乗りさせることはできない)
 *
 * cb(err, { inbound, outbound, close })
 *   inbound  : server -> local  (Readable)
 *   outbound : local  -> server (Writable)
 */
function dialTunnel(host, port, cb) {
  if (active >= MAX_CONCURRENT) {
    return cb(new Error(`too many local tunnels (max ${MAX_CONCURRENT})`));
  }
  active++;

  const sock = new WebSocket(WS_URL, [SUBPROTOCOL], {
    perMessageDeflate: false,   // バイナリ透過なので圧縮は無駄に CPU を食うだけ
    handshakeTimeout: 20_000,
  });
  sock.binaryType = 'nodebuffer';

  const inbound = new PassThrough();   // server -> local
  const outbound = new PassThrough();  // local  -> server
  let done = false;
  let settled = false;

  const cleanup = () => {
    if (done) return;
    done = true;
    active--;
    try { sock.removeAllListeners(); } catch {}
    try { sock.terminate(); } catch {}
    try { inbound.destroy(); } catch {}
    try { outbound.destroy(); } catch {}
  };

  outbound.on('data', (d) => {
    if (sock.readyState === sock.OPEN) sock.send(d);
  });
  outbound.on('error', cleanup);

  const timer = setTimeout(() => fail(new Error('tunnel handshake timeout')), HANDSHAKE_TIMEOUT);

  const fail = (e) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cleanup();
    cb(e);
  };

  sock.on('error', (e) => {
    if (!settled) return fail(e);
    warn(`tunnel ${host}:${port} error: ${e.message}`);
    inbound.end();
    cleanup();
  });
  sock.on('close', (code) => {
    if (!settled) return fail(new Error(`ws closed before handshake (code=${code})`));
    inbound.end();
    cleanup();
  });
  sock.on('unexpected-response', (_req, res) => {
    fail(new Error(`ws rejected (HTTP ${res.statusCode}) — RENDER_URL / PROXY_TOKEN を確認してください`));
  });

  // ---- ハンドシェイク: 最初の 1 フレーム目 ("OK..." / "ERR...") を待つ
  let head = Buffer.alloc(0);
  const onHandshake = (data, isBinary) => {
    if (!isBinary) return;
    head = Buffer.concat([head, Buffer.from(data)]);
    const nl = head.indexOf(0x0a);
    if (nl === -1) {
      if (head.length > 4096) fail(new Error('bad handshake'));
      return;
    }
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    sock.removeListener('message', onHandshake);

    const line = head.slice(0, nl).toString('utf8').trim();
    const rest = head.slice(nl + 1);
    if (!/^OK\b/.test(line)) { cleanup(); return cb(new Error('tunnel refused: ' + line)); }

    // 通常モード: 以降は届いたバイナリフレームをそのまま inbound へ
    sock.on('message', (d, bin) => {
      if (bin && !done) inbound.write(Buffer.from(d));
    });
    if (rest.length) inbound.write(rest);   // 本来は空。来てもそのまま流す
    cb(null, { inbound, outbound, close: cleanup });
  };

  sock.on('open', () => {
    sock.on('message', onHandshake);
    sock.send(Buffer.from(JSON.stringify({ type: 'connect', host, port }) + '\n'));
  });
}

/**
 * トンネルを張り、必要ならハンドシェイク完了後に initialPayload を送る。
 * initialPayload は必ず "OK" を受け取った「後」に流すこと
 * (前に流すとサーバがまだターゲットへ繋いでいないので消える)。
 */
function openTunnel(host, port, initialPayload, cb) {
  dialTunnel(host, port, (err, t) => {
    if (err) return cb(err, null);
    if (initialPayload && initialPayload.length) t.outbound.write(initialPayload);
    cb(null, t);
  });
}

/** トンネルとローカルソケットを相互接続する共通処理 */
function bridge(tunnel_, local, head) {
  if (head && head.length) tunnel_.outbound.write(head);
  local.on('data', (d) => tunnel_.outbound.write(d));
  tunnel_.inbound.on('data', (d) => { if (local.writable) local.write(d); });

  const bye = () => {
    try { local.destroy(); } catch {}
    try { tunnel_.outbound.end(); } catch {}
    tunnel_.close();
  };
  tunnel_.inbound.on('end', bye);
  tunnel_.inbound.on('error', bye);
  local.on('error', bye);
  local.on('close', bye);
}

// ------------------------------------------------------- ローカル HTTP プロキシ
/**
 * "host:port" / "[v6]:port" / "host" を分解する。
 * defaultPort は用途で変わる (CONNECT=443, 素のHTTP=80)。
 */
function parseAuthority(v, defaultPort) {
  const s = String(v || '');
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return { host: s.slice(1, end), port: Number(s.slice(end + 1).replace(':', '')) || defaultPort };
  }
  const i = s.lastIndexOf(':');
  if (i === -1) return { host: s, port: defaultPort };
  return { host: s.slice(0, i), port: Number(s.slice(i + 1)) || defaultPort };
}

const httpProxy = http.createServer((req, res) => {
  // 素の HTTP (非TLS) の転送。
  // プロキシ仕様には 2 種類の書き方があるので両対応:
  //   absolute-form : GET http://host/path HTTP/1.1
  //   origin-form   : GET /path HTTP/1.1 + Host: host   (ブラウザ/curl はこちら)
  //
  // 実装方針: HTTP を再構築せず「受け取ったリクエスト行/ヘッダをそのまま
  // トンネルに流し、戻ってきたバイト列をそのままクライアントに返す」
  // 素通し方式にする。余計な解釈を挟まないので挙動が予測しやすい。
  let host, port, path;
  if (/^https?:\/\//i.test(req.url)) {
    try {
      const u = new URL(req.url);
      host = u.hostname;
      port = Number(u.port) || 80;
      path = `${u.pathname}${u.search}`;
    } catch { res.writeHead(400).end('bad url\n'); return; }
  } else {
    const a = parseAuthority(req.headers.host, 80);
    host = a.host; port = a.port;
    path = req.url;
  }
  if (!host) { res.writeHead(400).end('missing host\n'); return; }

  // リクエスト行 + ヘッダを生のバイト列として組み立てる
  const lines = [`${req.method} ${path} HTTP/1.1`];
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    const n = raw[i].toLowerCase();
    if (n === 'proxy-connection' || n === 'proxy-authorization') continue;
    lines.push(`${raw[i]}: ${raw[i + 1]}`);
  }
  const head = Buffer.from(lines.join('\r\n') + '\r\n\r\n');

  const sock = res.socket;            // クライアント側の生ソケット
  res.socket = null;                  // Node の応答処理を放棄して所有権を奪う
  res.destroy();

  openTunnel(host, port, head, (err, t) => {
    if (err) {
      warn(`HTTP fail ${host}:${port} -> ${err.message}`);
      try { sock.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); } catch {}
      return;
    }
    req.on('data', (d) => t.outbound.write(d));
    req.on('end', () => t.outbound.end());
    t.inbound.on('data', (d) => { if (sock.writable) sock.write(d); });
    const bye = () => { try { sock.destroy(); } catch {} t.close(); };
    t.inbound.on('end', bye);
    t.inbound.on('error', bye);
    sock.on('error', bye);
    sock.on('close', bye);
    req.on('error', bye);
  });
});

httpProxy.on('connect', (req, clientSocket, head) => {
  // CONNECT のターゲットは "host:port" 形式。ポート省略時は 443。
  const { host, port } = parseAuthority(req.url || req.headers.host, 443);
  openTunnel(host, port, null, (err, t) => {
    if (err) {
      warn(`CONNECT fail ${host}:${port} -> ${err.message}`);
      if (clientSocket.writable) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    if (clientSocket.writable) clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    bridge(t, clientSocket, head);
  });
});

httpProxy.on('error', (e) => warn('local http proxy error:', e.message));
httpProxy.on('clientError', (_e, sock) => { try { sock.destroy(); } catch {} });

httpProxy.listen(LOCAL_HTTP_PORT, '127.0.0.1', () => {
  log(`HTTP プロキシ   ->  http://127.0.0.1:${LOCAL_HTTP_PORT}`);
});

// ------------------------------------------------------ ローカル SOCKS5 プロキシ
if (!DISABLE_SOCKS) {
  const socksServer = net.createServer((client) => {
    client.on('error', () => {});

    client.once('data', (greet) => {
      if (greet.length < 3 || greet[0] !== 0x05) return client.destroy();
      const noAuth = Array.from(greet.slice(2, 2 + greet[1])).includes(0x00);
      if (!noAuth) { client.write(Buffer.from([0x05, 0xff])); return client.destroy(); }
      client.write(Buffer.from([0x05, 0x00]));

      client.once('data', (buf) => {
        if (buf.length < 7 || buf[0] !== 0x05 || buf[1] !== 0x01) return client.destroy();
        const atyp = buf[3];
        let host, port, offset;
        if (atyp === 0x01) {
          host = Array.from(buf.slice(4, 8)).join('.');
          port = buf.readUInt16BE(8); offset = 10;
        } else if (atyp === 0x03) {
          const len = buf[4];
          host = buf.slice(5, 5 + len).toString('utf8');
          port = buf.readUInt16BE(5 + len); offset = 7 + len;
        } else if (atyp === 0x04) {
          const b = buf.slice(4, 20); const parts = [];
          for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(i).toString(16));
          host = parts.join(':'); port = buf.readUInt16BE(20); offset = 22;
        } else {
          client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return client.destroy();
        }
        const rest = buf.slice(offset);

        openTunnel(host, port, null, (err, t) => {
          if (err) {
            warn(`SOCKS fail ${host}:${port} -> ${err.message}`);
            client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return client.destroy();
          }
          const reply = Buffer.alloc(10);
          reply[0] = 0x05; reply[1] = 0x00; reply[2] = 0x00; reply[3] = 0x01;
          reply.writeUInt16BE(port, 8);
          client.write(reply);
          bridge(t, client, rest);
        });
      });
    });
  });

  socksServer.listen(LOCAL_SOCKS_PORT, '127.0.0.1', () => {
    log(`SOCKS5 プロキシ ->  socks5://127.0.0.1:${LOCAL_SOCKS_PORT}`);
  });
  socksServer.on('error', (e) => warn('socks server error:', e.message));
}

log('--- 設定値 ---------------------------------------------------');
log(`  HTTP/HTTPS :  http://127.0.0.1:${LOCAL_HTTP_PORT}`);
if (!DISABLE_SOCKS) log(`  SOCKS5     :  127.0.0.1:${LOCAL_SOCKS_PORT}`);
log('  Firefox    :  設定 > ネットワーク設定 > 手動で上記を指定 (HTTPSも同じポート)');
log('  curl       :  curl -x http://127.0.0.1:8888 -I https://open.spotify.com/');
log('  環境変数   :  export https_proxy=http://127.0.0.1:8888');
log('--------------------------------------------------------------');
