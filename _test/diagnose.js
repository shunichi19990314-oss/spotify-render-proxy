// 本番プロキシの出力を解析して「アプリ初期化が失敗する原因」を突き止める
'use strict';
const https = require('https');
const zlib = require('zlib');

const BASE = process.env.BASE || 'spotify-88jy.onrender.com';
const TOKEN = process.env.TK || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function req(path, cookie) {
  return new Promise((resolve) => {
    const h = { 'User-Agent': UA, 'Accept': '*/*' };
    if (cookie) h.Cookie = cookie;
    const rq = https.request({ host: BASE, path, headers: h, servername: BASE }, (r) => {
      const cs = [];
      r.on('data', (c) => cs.push(c));
      r.on('end', () => {
        let buf = Buffer.concat(cs);
        const ce = (r.headers['content-encoding'] || '').toLowerCase();
        try {
          if (ce.includes('gzip')) buf = zlib.gunzipSync(buf);
          else if (ce.includes('br')) buf = zlib.brotliDecompressSync(buf);
        } catch (e) { return resolve({ status: r.statusCode, headers: r.headers, decodeErr: e.message, body: buf }); }
        resolve({ status: r.statusCode, headers: r.headers, body: buf, text: buf.toString('utf8') });
      });
    });
    rq.on('error', (e) => resolve({ err: e.message }));
    rq.setTimeout(90000, () => { rq.destroy(); resolve({ err: 'timeout' }); });
    rq.end();
  });
}

// 素の Spotify (比較用・書き換え前)
function direct(host, path) {
  return new Promise((resolve) => {
    const rq = https.request({ host, port: 443, path, headers: { 'User-Agent': UA, Accept: '*/*' }, servername: host }, (r) => {
      const cs = [];
      r.on('data', (c) => cs.push(c));
      r.on('end', () => {
        let buf = Buffer.concat(cs);
        const ce = (r.headers['content-encoding'] || '').toLowerCase();
        try { if (ce.includes('gzip')) buf = zlib.gunzipSync(buf); else if (ce.includes('br')) buf = zlib.brotliDecompressSync(buf); } catch {}
        resolve({ status: r.statusCode, headers: r.headers, text: buf.toString('utf8'), len: buf.length });
      });
    });
    rq.on('error', (e) => resolve({ err: e.message }));
    rq.setTimeout(60000, () => { rq.destroy(); resolve({ err: 'timeout' }); });
    rq.end();
  });
}

const SPOTIFY_HOST_RE = /https?:\/\/[a-z0-9.\-]*(?:spotify\.com|scdn\.co|spotifycdn\.com|spotilocal\.com)/gi;

(async () => {
  // 認証 Cookie を取る
  let r = await req(`/?t=${encodeURIComponent(TOKEN)}`);
  const cookie = ((r.headers['set-cookie'] || [])[0] || '').split(';')[0];
  console.log(`cookie: ${cookie ? '取得OK' : '失敗'}`);

  console.log('\n' + '='.repeat(74));
  console.log('【1】HTML の bootstrap データを調べる');
  console.log('='.repeat(74));
  r = await req('/', cookie);
  const html = r.text;
  console.log(`HTML: HTTP ${r.status}, ${html.length}B`);

  // Spotify の HTML に埋め込まれた初期状態 JSON を探す
  for (const key of ['__bootstrap_data', '__initial_state', 'bootstrapData', 'window.__', 'session', 'accessToken', 'market', 'locale']) {
    const i = html.indexOf(key);
    console.log(`  ${key.padEnd(18)} ${i === -1 ? 'なし' : 'あり @' + i}`);
  }
  // script type="application/json" を抽出
  const jsonBlocks = [...html.matchAll(/<script[^>]*type="application\/json"[^>]*id="([^"]*)"[^>]*>/g)].map(m => m[1]);
  console.log(`  JSON script ブロック id: ${JSON.stringify(jsonBlocks)}`);
  for (const id of jsonBlocks) {
    const m = new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`).exec(html);
    if (m) {
      const body = m[1];
      console.log(`\n  --- #${id} (${body.length}B) ---`);
      const hosts = [...new Set((body.match(SPOTIFY_HOST_RE) || []))];
      console.log(`  素の Spotify URL 残存: ${hosts.length}件`);
      hosts.slice(0, 10).forEach(h => console.log('     ★', h));
      const rewritten = (body.match(/\/__p__\//g) || []).length;
      console.log(`  書き換え済み /__p__/: ${rewritten}箇所`);
      console.log(`  先頭300字: ${body.slice(0, 300).replace(/\s+/g, ' ')}`);
    }
  }

  console.log('\n' + '='.repeat(74));
  console.log('【2】全 JS バンドルの書き換え漏れを調べる');
  console.log('='.repeat(74));
  const scripts = [...html.matchAll(/src="([^"]+\.js[^"]*)"/g)].map(m => m[1]);
  console.log(`script タグ: ${scripts.length}本`);
  scripts.forEach(s => console.log('  ', s.slice(0, 110)));

  for (const src of scripts) {
    if (!src.includes('__p__') && !src.includes('spotifycdn')) { console.log(`\n  [skip] 外部: ${src.slice(0, 70)}`); continue; }
    const rr = await req(src.startsWith('/') ? src : src, cookie);
    if (rr.err || rr.status !== 200) { console.log(`\n  ❌ ${src.slice(0, 80)} -> ${rr.err || 'HTTP ' + rr.status}`); continue; }
    const t = rr.text;
    const leftover = [...new Set((t.match(SPOTIFY_HOST_RE) || []))];
    const rew = (t.match(/\/__p__\//g) || []).length;
    console.log(`\n  ${src.split('/').pop().slice(0, 55)}`);
    console.log(`     ${(t.length / 1024 / 1024).toFixed(2)}MB / 書き換え${rew}箇所 / ★素のURL残存 ${leftover.length}件`);
    leftover.slice(0, 8).forEach(h => console.log('        残:', h));
  }

  console.log('\n' + '='.repeat(74));
  console.log('【3】起動時に叩かれる主要エンドポイントのプロキシ到達性');
  console.log('='.repeat(74));
  const boot = [
    '/__p__/clienttoken.spotify.com/token',
    '/__p__/apresolve.spotify.com/',
    '/__p__/api.spotify.com/v1/bootstrap-config',
    '/__p__/spclient.wg.spotify.com/bootstrap/v1/bootstrap/web',
    '/__p__/open.spotify.com/get_access_token?reason=transport&productType=web_player',
    '/__p__/exp.wg.spotify.com/v1/experiments',
  ];
  for (const p of boot) {
    const rr = await req(p, cookie);
    const body = (rr.text || '').slice(0, 110).replace(/\s+/g, ' ');
    console.log(`  HTTP ${String(rr.status).padEnd(4)} ${p}`);
    if (body) console.log(`        ${body}`);
  }

  console.log('\n' + '='.repeat(74));
  console.log('【4】JS 内にオリジン/ホスト名検証があるか');
  console.log('='.repeat(74));
  const mainJs = scripts.find(s => /web-player\.[a-f0-9]+\.js/.test(s) && !/vendor|encore/.test(s));
  if (mainJs) {
    const rr = await req(mainJs, cookie);
    const t = rr.text || '';
    console.log(`  対象: ${mainJs.split('/').pop()} (${(t.length / 1024 / 1024).toFixed(2)}MB)`);
    for (const pat of ['location.hostname', 'location.origin', 'location.host', 'window.location.href',
      'open.spotify.com', 'isTrusted', 'referrer', 'document.domain']) {
      const n = t.split(pat).length - 1;
      if (n) console.log(`    ${pat.padEnd(22)} ${n}箇所`);
    }
    // hostname を比較していそうな箇所を抽出
    let idx = -1, c = 0;
    while ((idx = t.indexOf('location.hostname', idx + 1)) > -1 && c < 5) {
      c++;
      console.log(`    文脈#${c}: ${JSON.stringify(t.slice(Math.max(0, idx - 120), idx + 120))}`.slice(0, 300));
    }
  }
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
