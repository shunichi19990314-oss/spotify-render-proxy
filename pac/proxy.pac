// proxy.pac — Spotify 関連ドメインだけをプロキシ経由にする
//
// 使い方 (Windows/macOS/Linux いずれも):
//   1. このファイルをどこかに置く (例: C:\pac\proxy.pac)
//   2. OS のプロキシ設定で「自動構成スクリプト (PAC)」に
//        file:///C:/pac/proxy.pac     (Windows)
//        file:///Users/you/pac/proxy.pac  (macOS)
//      を指定する
//   3. ブラウザを再起動
//
// メリット: 全通信をプロキシに通さないので、Spotify 以外の速度・プライバシーに影響しない。
//
// 注意: PAC には認証情報を書けません。認証は同梱の client が
//       WebSocket の subprotocol で透過的に行うため、ここは素のアドレス指定でOKです。

const PROXY = 'PROXY 127.0.0.1:8888';   // client/index.js が開けているローカルプロキシ
const DIRECT_FALLBACK = 'DIRECT';

// Spotify が使うドメイン (前方/後方一致)
const SPOTIFY_HOSTS = [
  'open.spotify.com',
  'accounts.spotify.com',
  'api.spotify.com',
  'spclient.wg.spotify.com',
  'apresolve.spotify.com',
  'gue1-spclient.spotify.com',
  'dealer.spotify.com',
  'gew1-spclient.spotify.com',
  'audio-fa.scdn.co',
  'audio4-fa.scdn.co',
  'scdn.co',
  'spotify.com',
  'spotifycdn.com',
  'spotify.map.fastly.net',
  'spotilocal.com',
];

function matches(host) {
  host = (host || '').toLowerCase();
  for (const d of SPOTIFY_HOSTS) {
    if (host === d) return true;
    if (host.endsWith('.' + d)) return true;   // サブドメイン
  }
  return false;
}

function FindProxyForURL(url, host) {
  if (isPlainHostName(host)) return DIRECT_FALLBACK;          // "http://intranet" 等
  if (shExpMatch(host, '127.0.0.1') || shExpMatch(host, 'localhost')) return DIRECT_FALLBACK;
  if (isInNet(dnsResolve(host), '192.168.0.0', '255.255.0.0')) return DIRECT_FALLBACK;
  if (isInNet(dnsResolve(host), '10.0.0.0', '255.0.0.0')) return DIRECT_FALLBACK;

  if (matches(host)) return PROXY + '; ' + DIRECT_FALLBACK;  // 失敗したら直接接続
  return DIRECT_FALLBACK;
}
