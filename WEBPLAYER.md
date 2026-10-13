# モードC: Spotify Web Player を「Render のサイトの中で」開く

**ローカルに何もインストールせず、Render の URL を開くだけで Spotify Web Player を使う**ための方式です。

```
ブラウザ  ───► https://<app>.onrender.com/  ───► *.spotify.com / *.scdn.co / *.spotifycdn.com
          (通信先は Render だけ)              (Spotify と話すのは Render だけ)
```

あなたのネットワークが Spotify をブロックしていても、**ブラウザは Render としか通信しない**ため
接続できます。これがモードA（ローカル client）との決定的な違いです。

---

## 使いかた（3ステップ）

### 1. デプロイ

[`DEPLOY.md`](DEPLOY.md) の Step 1〜4 と同じです。`render.yaml` に `WEBPLAYER=1` が
入っているので、Blueprint でデプロイするだけで有効になります。

### 2. 認証ゲートでトークンを入力

ブラウザで開く:

```
https://<アプリ名>.onrender.com/
```

初回は認証ページ（`/__gate__`）にリダイレクトされます。
Render の **Environment** タブにある `PROXY_TOKEN` の値を入力して送信してください。

> トークンは **HttpOnly Cookie** として保存され、以降は入更不要です。
> Cookie は **Spotify には転送されません**（`stripAuthCookie()` で除去してから中継します）。
> URL に残したくないため、`?t=` で渡した場合も即座に Cookie に焼き直してリダイレクトします。

### 3. ログインして再生

あとは通常の Spotify Web Player と同じように使えます。

---

## 付属ページ

| URL | 用途 |
|---|---|
| `/` | Spotify Web Player 本体 |
| `/__gate__` | 認証ページ（トークン入力） |
| **`/__diag__`** | **診断ページ。** 各 Spotify エンドポイントがプロキシ経由で取れるかを一括検査 |
| `/sw.js` | Service Worker（自動で登録されます） |
| `/healthz` | ヘルスチェック（Render 用・認証不要） |

### 動かなくなったときは、まず `/__diag__` を開く

**「検査を実行」ボタンを押して、結果のスクリーンショットかログをそのまま報告してください。**
どこが壊れているか即座に切り分けられます。

| 結果 | 意味 |
|---|---|
| 全部 OK なのに再生できない | → **Widevine DRM が原因**（下記の「未検証のリスク」参照） |
| `open.spotify.com (HTML)` が NG | プロキシ自体が壊れている。Render の Logs を確認 |
| `api.spotify.com` が 401 | ✅ **これは正常**（トークン無しなので 401 が正解＝到達している） |
| SW 状態が「未登録」 | ページを **2回リロード**（初回登録時は次のロードから有効） |

---

## 仕組み（3重の URL 書き換え）

ブラウザから Spotify への直接アクセスを **0** にするため、3段構えにしています。

### (a) HTML / JS / CSS / JSON の本文書き換え

```
https://api.spotify.com/v1/me          →  /__p__/api.spotify.com/v1/me
//i.scdn.co/image/abc                  →  /__p__/i.scdn.co/image/abc
"https:\/\/spclient.wg.spotify.com\/x" →  "\/__p__\/spclient.wg.spotify.com\/x"   (JSONエスケープ形も対応)
wss://dealer.spotify.com/...           →  変更しない（(c) が担当）
https://www.google.com/recaptcha/...   →  変更しない（Spotify 以外は素通し）
```

検証結果: **HTML で 33 箇所、1.5MB の vendor JS バンドルで 31 箇所**を書き換え、
素の Spotify 絶対 URL の残存は **0 件**でした。

### (b) Service Worker（本命）

JS が**実行時に組み立てる** URL は静的な文字列置換では捕捉できません。
そこで `/sw.js` が全 fetch を傍受し、Spotify ドメイン宛てなら自オリジン経由に書き換えます。

```js
if (url.origin === self.location.origin) return;   // 既にプロキシ形 → 素通し
if (!SP.test(url.hostname)) return;                // Spotify 以外 → 素通し
const target = new URL('/__p__/' + url.hostname + url.pathname + url.search, self.location.origin);
event.respondWith(fetch(target, { ... credentials: 'include' }));
```

**これが本命の防御線**で、(a) は補助です。

### (c) WebSocket シム

Service Worker は **WebSocket を傍受できません**。そのため HTML の `<head>` 直後に
`window.WebSocket` を差し替えるスクリプトを注入し、`wss://dealer.spotify.com/...` を
`wss://<app>.onrender.com/__ws__/dealer.spotify.com/...` に書き換えます。
サーバ側は素の TLS 接続を張って HTTP Upgrade をそのまま中継します。

### その他の処理

| 項目 | 内容 |
|---|---|
| **CSP** | `content-security-policy` / `x-frame-options` を除去 |
| **Origin / Referer** | `https://open.spotify.com` を名乗らせる（DRM ライセンス検証対策） |
| **Cookie** | `Domain` を落として `Path=/` に統一（全 Spotify ホストが同一オリジンになるため共有される） |
| **Location** | リダイレクト先も `/__p__/host/...` に書き換え（プロキシ外へ出さない） |
| **圧縮** | gzip/br を展開 → 書き換え → gzip 再圧縮（帯域節約） |
| **バイナリ** | 音声・画像は**書き換えずストリーム素通し**（Range リクエストも透過） |
| **オープンプロキシ防止** | `*.spotify.com` / `*.scdn.co` / `*.spotifycdn.com` 以外は **403**。クラウドのメタデータ IP (`169.254.169.254`) も遮断 |

---

## ⚠️ 未検証のリスク（正直にお伝えします）

**サンドボックスにはブラウザがないため、「実際に音が鳴るか」は検証できていません。**
プロキシ層（HTML / JS / API / 画像 / リダイレクト / WebSocket / 認証 / セキュリティ）は
**35 項目すべて実 Spotify に対して検証済み**ですが、以下は**あなたのブラウザでしか確認できません**。

### 1. Widevine DRM（最大のリスク）

`vendor~web-player.js` を解析した結果、Spotify は **Shaka Player** を使っており、
次の分岐になっていました:

```js
if (typeof navigator.requestMediaKeySystemAccess == "function" && ...)
    return log("Using native EME...");   // ← Chrome/Firefox はここ＝実 Widevine
...
return ts(), "v0.1b";                     // ← ポリフィルはレガシー環境のみ
```

つまり**モダンブラウザでは本物の Widevine が使われます**。
ライセンス要求自体は fetch/XHR なので Service Worker が傍受して Origin を書き換えられますが、
**Spotify 側が Origin / Referer を検証して non-Spotify オリジンを拒否する可能性**があります。

- ✅ **うまくいく場合**: ライセンス取得 → 通常通り再生
- ❌ **ダメな場合**: 曲を押すと「再生できません」等のエラー

こればかりは実際に試すしかありません。`/__diag__` が全部 OK なのに再生できない場合は、
**ほぼ確実にこれが原因**です。

### 2. JS 側のオリジン検証

Spotify の JS が `location.hostname` を見て、未知のドメインでは動作を止める可能性があります。

### 3. バンドルのハッシュ更新

`web-player.b97fd96d.js` のように**ファイル名にハッシュが含まれる**ため、
Spotify が更新すると URL が変わります。ただし本文は HTML から動的に取得するので
**通常は自動追従します**（ハードコードしていないため）。

### 4. 規約

Web Player のクライアントをリバースプロキシで再配信する行為は、
モードA（通信の中継）より**明確に Spotify の利用規約に抵触します**。
アカウント停止リスクはモードA より高いと考えてください。

---

## それでも動かない場合の現実的な選択肢

| 選択肢 | 音 | ローカル作業 | 費用 |
|---|---|---|---|
| **モードC（本方式）** | 未検証 | **不要** | $0〜7 |
| **モードA（ローカル client）** | ✅ **検証済み・確実** | `npm start` が必要 | $0〜7 |
| **ブラウザ拡張にする** | ✅ 確実 | 拡張の1回だけのインストール | $0〜7 |

**モードA は既に実 Spotify に対して動作検証済み**で、確実に音が鳴ります。
モードC が DRM で失敗した場合は、モードA に戻るのが確実です。
（両モードは同一サービス内で共存しているので、デプロイし直す必要はありません）

---

## 検証結果（`npm run test:webplayer`）

実 Spotify エンドポイントに対して 35 項目を実行:

```
=== 1. ヘルスチェック ===
✅ /healthz が 200                                 HTTP 200
✅ webplayer enabled と表示
=== 2. 認証ゲート ===
✅ 認証なし / は 302 → /__gate__                     HTTP 302 loc=/__gate__
✅ /__gate__ が 200 でトークン入力フォーム              HTTP 200
✅ 認証なし /__p__/ は 401                           HTTP 401
=== 3. ?t= で Cookie 発行 ===
✅ ?t= が 302                                      HTTP 302 loc=/
✅ HttpOnly Cookie が焼かれる                        __proxy_auth=...; Path=/; HttpOnly; SameSite=Lax; Secure
✅ 誤トークンは 302 → gate のまま                      HTTP 302 loc=/__gate__
=== 4. Spotify HTML のプロキシ（最重要）===
✅ / が 200                                        HTTP 200 167591B
✅ CSP ヘッダが除去されている                          removed
✅ x-frame-options が除去されている
✅ SW 登録コードが注入されている
✅ WebSocket シムが注入されている
✅ Spotify URL が書き換わっている                      /__p__/ が 33 箇所
✅ 素の Spotify 絶対URLが残っていない                   clean
=== 5. Service Worker ===
✅ /sw.js が 200 + JS  ✅ Service-Worker-Allowed: /  ✅ SW が Spotify ドメインを判定
=== 6. JS バンドルのプロキシ（4MB級）===
✅ vendor JS が 200                                HTTP 200 1.50MB
✅ JS 内の URL も書き換わっている                      /__p__/ が 31 箇所
✅ Shaka/EME コードが保持されている
=== 7. Web API のプロキシ ===
✅ api.spotify.com が到達 (401 が正解)               HTTP 401
✅ search API が到達 (401 が正解)                    HTTP 401
=== 8. 画像 CDN のプロキシ（バイナリ素通し）===
✅ i.scdn.co 画像が取得できる                         HTTP 200 15475B ct=image/jpeg
=== 9. アカウント/ログイン系 ===
✅ accounts.spotify.com が到達                      HTTP 307
✅ Location が /__p__/ 形に書き換わっている             loc=/__p__/open.spotify.com/login
✅ Location に素の spotify.com が残っていない
=== 10. SPA ルーティング（prefix なしパス）===
✅ /playlist/... が open.spotify.com に転送          HTTP 200 167706B
=== 11. 診断ページ ===   ✅ /__diag__ が 200
=== 12. 許可外ホストの遮断（オープンプロキシ化防止）===
✅ example.com は 403 で拒否
✅ メタデータIP(169.254.169.254)は拒否
=== 13. WebSocket プロキシ (/__ws__/) ===
✅ WS プロキシが応答を返す (ハングしない)                HTTP 401  ← dealer.spotify.com に到達
✅ 許可外ホストへの WS は拒否 (403)
=== 14. 既存のトンネル方式にリグレッションがないか ===
✅ /tunnel がゲートにハイジャックされない
```

既存のモードA/B も全項目パス（リグレッションなし）を別途確認済みです。

---

## 環境変数

| Key | 既定 | 説明 |
|---|---|---|
| `WEBPLAYER` | `1` | `0` でモードC を無効化（モードA/B のみになる） |
| `VERBOSE` | `0` | `1` で全プロキシリクエストをログ出力 |
| `PROXY_TOKEN` | — | **必須**。認証ゲートのトークン |
| `PUBLIC` | `0` | `1` で認証を無効化。**絶対に使わないこと** |

---

## 帯域について（重要）

モードC は**音声ストリームが Render を通過する**ため、モードA と同じ帯域を消費します。
無料枠の 5GB/月 は高音質で **約 69 時間**です。
詳細は [`DEPLOY.md` の「無料枠の現実」](DEPLOY.md#️-無料枠の現実必ず読む) を参照してください。
