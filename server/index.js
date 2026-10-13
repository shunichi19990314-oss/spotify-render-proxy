#!/usr/bin/env node
'use strict';

/**
 * spotify-render-proxy / server
 * ---------------------------------------------------------------
 * Render (Web Service) 上で動く「認証付きフォワードプロキシ」です。
 *
 * 提供モードは2つ:
 *
 *  (A) WebSocket トンネルモード  ... 推奨
 *      Render のエッジ LB は素の HTTP CONNECT をそのまま通してくれない
 *      ことがあるため、CONNECT トンネルを WebSocket の中に包んで流します。
 *      クライアント側は同梱の client/index.js を使います。
 *
 *  (B) 直接 HTTP プロキシモード
 *      GET/POST 等の絶対URIリクエストの転送と CONNECT トンネルを直接受け付けます。
 *      LB が素の CONNECT を通す環境 (自前VPS / Railway / Fly.io など) では
 *      client を挟まずにブラウザから直接プロキシ指定できます。
 *
 * 認証:
 *   - (A) WebSocket の subprotocol に "proxy.v1.<TOKEN>" を含める
 *   - (B) Authorization: Bearer <TOKEN>  (または Proxy-Authorization: Basic)
 *   PUBLIC=1 を設定すると認証を無効化できますが、
 *   「誰でも使えるオープンプロキシ」になるため本番では絶対に使わないでください。
 */

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.PROXY_TOKEN || '';
const PUBLIC = process.env.PUBLIC === '1';
const CONNECT_TIMEOUT = Number(process.env.CONNECT_TIMEOUT || 10_000);
const MAX_BODY = 8 * 1024 * 1024;

const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), ...a);
const warn = (...a) => console.warn(ts(), ...a);

// ---------------------------------------------------------------- helpers
function parseTarget(hostHeader) {
  // "open.spotify.com:443" | "[::1]:8080" | "example.com"
  const s = String(hostHeader || '');
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    const host = s.slice(1, end);
    const port = s.slice(end + 1).replace(':', '');
    return { host, port: Number(port) || 443 };
  }
  const i = s.lastIndexOf(':');
  if (i === -1) return { host: s, port: 443 };
  const host = s.slice(0, i);
  const port = Number(s.slice(i + 1));
  return { host, port: Number.isFinite(port) && port > 0 ? port : 443 };
}

/** リクエストヘッダから Hop-by-hop を除いた配列を作る */
function forwardHeaders(rawHeaders, { dropHost = false, dropProxyAuth = true } = {}) {
  const hopByHop = new Set([
    'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
    'te', 'trailer', 'upgrade',
  ]);
  if (dropProxyAuth) {
    hopByHop.add('proxy-authorization');
  }
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const lower = name.toLowerCase();
    if (hopByHop.has(lower)) continue;
    if (dropHost && lower === 'host') continue;
    out.push(name, rawHeaders[i + 1]);
  }
  return out;
}

function bearerToken(req) {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) return m[1].trim();
  const proxyAuth = req.headers['proxy-authorization'] || '';
  const b = /^Basic\s+(.+)$/i.exec(proxyAuth.trim());
  if (b) {
    const decoded = Buffer.from(b[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    return idx === -1 ? decoded : decoded.slice(idx + 1);
  }
  return '';
}

function tokenOk(got) {
  if (PUBLIC) return true;
  if (!TOKEN) return false;
  if (typeof got !== 'string' || got.length === 0) return false;
  // タイミング攻撃を避けるため桁数も内容も一定時間比較する
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function safePipe(src, dst) {
  src.pipe(dst);
  src.on('error', (e) => {
    if (e.code !== 'ECONNRESET' && e.code !== 'EPIPE') warn('pipe src error:', e.code || e.message);
    dst.destroy();
  });
  dst.on('error', (e) => {
    if (e.code !== 'ECONNRESET' && e.code !== 'EPIPE') warn('pipe dst error:', e.code || e.message);
    src.destroy();
  });
}

// ------------------------------------------------------------- HTTP server
const server = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];

  // Render のヘルスチェック
  if (path === '/healthz' || path === '/health' || path === '/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('spotify-render-proxy ok\n');
    return;
  }

  // ------------------------------------- (B) 直接 HTTP プロキシ (絶対URI)
  if (/^https?:\/\//i.test(req.url || '')) {
    if (!tokenOk(bearerToken(req))) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Bearer realm="spotify-proxy"' });
      res.end('proxy authentication required\n');
      return;
    }
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end('bad request url\n');
      return;
    }
    const chunks = [];
    let size = 0;
    let aborted = false;

    const send = () => {
      const body = Buffer.concat(chunks);
      const isHttps = target.protocol === 'https:';
      const lib = isHttps ? require('https') : http;
      const headers = forwardHeaders(req.rawHeaders, { dropHost: true });
      headers.push('Host', target.host);
      const port = target.port || (isHttps ? 443 : 80);

      const up = lib.request(
        {
          host: target.hostname,
          port,
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers,
          servername: isHttps ? target.hostname : undefined,
        },
        (ures) => {
          const outHeaders = [];
          for (let i = 0; i < ures.rawHeaders.length; i += 2) {
            const n = ures.rawHeaders[i].toLowerCase();
            if (['transfer-encoding', 'connection', 'keep-alive'].includes(n)) continue;
            outHeaders.push(ures.rawHeaders[i], ures.rawHeaders[i + 1]);
          }
          res.writeHead(ures.statusCode || 502, outHeaders);
          ures.pipe(res);
          ures.on('error', () => res.destroy());
        },
      );
      up.on('error', (e) => {
        warn(`HTTP proxy fail ${target.host} -> ${e.code || e.message}`);
        if (!res.headersSent) res.writeHead(502).end(`bad gateway: ${e.code || e.message}\n`);
        else res.destroy();
      });
      if (body.length) up.write(body);
      up.end();
    };

    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        res.writeHead(413).end('payload too large\n');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) send(); });
    req.on('error', () => { aborted = true; });
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found (this endpoint is a proxy, see README)\n');
});

// (B) 直接 CONNECT  (Node は CONNECT を 'request' ではなく 'connect' イベントで渡す)
server.on('connect', (req, clientSocket, head) => {
  if (!tokenOk(bearerToken(req))) {
    if (clientSocket.writable) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Bearer realm="spotify-proxy"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    }
    return;
  }
  const { host, port } = parseTarget(req.url);
  const t0 = Date.now();
  const upstream = net.connect({ host, port });
  upstream.setTimeout(CONNECT_TIMEOUT);

  const bye = () => { try { upstream.destroy(); } catch {} try { clientSocket.destroy(); } catch {} };

  upstream.once('connect', () => {
    log(`CONNECT ok  ${host}:${port} (${Date.now() - t0}ms)`);
    if (head && head.length) upstream.write(head);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    safePipe(clientSocket, upstream);
    safePipe(upstream, clientSocket);
    upstream.setTimeout(0);
  });
  upstream.on('timeout', () => {
    warn(`CONNECT timeout ${host}:${port}`);
    if (clientSocket.writable) clientSocket.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
    bye();
  });
  upstream.on('error', (e) => {
    warn(`CONNECT fail ${host}:${port} -> ${e.code || e.message}`);
    if (clientSocket.writable) clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
    bye();
  });
  clientSocket.on('error', bye);
  clientSocket.on('close', bye);
});

// ---------------------------------------------------------------- tunnel
// 1 トンネル = 1 WebSocket 接続。
//
//   クライアント ──WSフレーム──► サーバ : {"type":"connect",host,port}\n
//   サーバ ──WSフレーム──► クライアント : "OK\n" または "ERR <code> <reason>\n"
//   以降、双方向のバイナリフレーム = ターゲットとの生 TCP ストリーム
//   (ハンドシェイクフレームにデータを相乗りさせることはできない)
//
// TLS の中身は一切解釈しない (純粋な TCP トンネル)。
// perMessageDeflate は無効にしてあるため、バイナリは完全な透過転送になる。
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 4096,             // 制御フレームは小さい。実データは生ソケット側で流れる
  perMessageDeflate: false,
  // 認証トークンを運ぶ subprotocol ("proxy.v1.<TOKEN>") をそのまま受理させる
  handleProtocols: (protocols) => {
    for (const p of protocols) if (p.startsWith('proxy.v1.')) return p;
    return false;
  },
});

let active = 0;
const MAX_TUNNELS = Number(process.env.MAX_TUNNELS || 50);

/** エラー行を WS フレームで送ってから接続を落とす */
function sendErr(ws, line) {
  try {
    ws.send(Buffer.from(line), () => { try { ws.terminate(); } catch {} });
  } catch {
    try { ws.terminate(); } catch {}
  }
}

wss.on('connection', (ws, req) => {
  const who = req.socket.remoteAddress;
  ws.on('error', () => {});   // 握りつぶし (close で後始末する)

  ws.once('message', (msg, isBinary) => {
    if (!isBinary) return sendErr(ws, 'ERR 400 binary-required\n');
    const buf = Buffer.from(msg);
    const sep = buf.indexOf(0x0a);
    if (sep === -1) return sendErr(ws, 'ERR 400 bad-frame\n');

    let meta;
    try { meta = JSON.parse(buf.slice(0, sep).toString('utf8')); }
    catch { return sendErr(ws, 'ERR 400 bad-json\n'); }

    if (meta.type !== 'connect' || typeof meta.host !== 'string' || !Number.isInteger(meta.port)
        || meta.port < 1 || meta.port > 65535 || meta.host.length > 253) {
      return sendErr(ws, 'ERR 400 bad-meta\n');
    }
    if (active >= MAX_TUNNELS) {
      warn(`too many tunnels (${active}) — refusing ${meta.host}:${meta.port}`);
      return sendErr(ws, 'ERR 503 too-many-tunnels\n');
    }

    const target = `${meta.host}:${meta.port}`;
    const t0 = Date.now();

    // ハンドシェイクフレームには「メタ情報のみ」を許可する。
    // 同じフレームに先頭データを相乗りさせると、サーバが OK に同梱して
    // エコーバックしてしまう (＝自分のリクエストが応答として返る) ため禁止。
    if (buf.length > sep + 1) return sendErr(ws, 'ERR 400 trailing-data-in-handshake\n');

    const upstream = net.connect({ host: meta.host, port: meta.port });
    upstream.setTimeout(CONNECT_TIMEOUT);
    active++;

    let done = false;
    const teardown = () => {
      if (done) return;
      done = true;
      active--;
      try { upstream.destroy(); } catch {}
      try { ws.terminate(); } catch {}
    };

    // --- ターゲット -> クライアント
    upstream.on('data', (d) => {
      if (ws.readyState === ws.OPEN) ws.send(d);
    });
    upstream.on('error', (e) => {
      if (!done) {
        warn(`tunnel fail ${target} -> ${e.code || e.message} (${Date.now() - t0}ms)`);
        sendErr(ws, `ERR 502 ${e.code || 'unreachable'}\n`);
      }
      teardown();
    });
    upstream.on('timeout', () => {
      if (!done) {
        warn(`tunnel timeout ${target}`);
        sendErr(ws, 'ERR 504 timeout\n');
      }
      teardown();
    });
    // 注意: upstream の 'end'/'close' で teardown してはいけない。
    // 'connect' より先に閉じると "OK" すら送れず、原因が分からなくなるため。
    // クライアントが接続を閉じたとき (ws 'close') にまとめて後始末する。

    // --- クライアント -> ターゲット
    ws.on('message', (d, bin) => {
      if (bin && upstream.writable) upstream.write(Buffer.from(d));
    });
    ws.on('close', teardown);
    ws.on('error', teardown);

    upstream.once('connect', () => {
      log(`tunnel open ${target} (${Date.now() - t0}ms, active=${active})`);
      ws.send(Buffer.from('OK\n'), (e) => {
        if (e) { warn(`handshake write fail ${target}: ${e.message}`); teardown(); }
      });
      upstream.setTimeout(0);            // 接続後のアイドルタイムアウトは解除
    });
  });

  ws.on('close', () => log(`WS closed ${who}`));
});

// WS のハンドシェイク (subprotocol でトークンを受ける)
server.on('upgrade', (req, socket, head) => {
  const path = (req.url || '').split('?')[0];
  if (path !== '/tunnel') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const requested = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const chosen = requested.find((p) => p.startsWith('proxy.v1.')) || null;

  if (!PUBLIC) {
    const got = chosen ? decodeURIComponent(chosen.slice('proxy.v1.'.length)) : bearerToken(req);
    if (!tokenOk(got)) {
      warn(`WS auth rejected from ${req.socket.remoteAddress}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;
server.requestTimeout = 0;

server.listen(PORT, () => {
  log(`listening on :${PORT}  mode=${PUBLIC ? 'PUBLIC(no-auth)' : 'token'}  token=${TOKEN ? 'set' : 'MISSING'}`);
  if (!PUBLIC && !TOKEN) warn('PROXY_TOKEN が未設定です。全リクエストを 407/401 で拒否します。');
});

const shutdown = () => { log('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
