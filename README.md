# spotify-render-proxy

**Render 上に「認証付きフォワードプロキシ」を立て、そこ経由で Spotify を開く**ための一式です。

> 📘 **デプロイ手順はこちら → [`DEPLOY.md`](DEPLOY.md)**
> （スクリーンショット級の詳しさで、ゼロから Spotify が開くところまで書いてあります）

```
 あなたのPC                                        Render (Web Service)
┌────────────────────────────┐                ┌──────────────────────────────┐
│ ブラウザ / Spotify / curl   │                │  server/index.js             │
│        │                   │                │   ・認証 (PROXY_TOKEN)       │
│        ▼                   │   WebSocket    │   ・TCP トンネル             │
│ client/index.js            │ ═════════════► │                              │──► open.spotify.com:443
│  127.0.0.1:8888  (HTTP)    │  wss://...     │                              │──► api.spotify.com:443
│  127.0.0.1:1080  (SOCKS5)  │   /tunnel      │                              │──► accounts.spotify.com:443
└────────────────────────────┘                └──────────────────────────────┘
```

## なぜ「WebSocket に包む」のか

Render のエッジ LB は **HTTP/1.1 のリクエストと WebSocket** しか通しません。
ブラウザが普通のプロキシとして使う `CONNECT` メソッドは、そのままでは LB に弾かれます。

そこで本構成では:

1. ローカルの `client` が、ブラウザから見ると**ごく普通の HTTP / SOCKS5 プロキシ**として振る舞う
2. `client` は受け取った CONNECT 要求を **WebSocket の中に入れて** Render まで運ぶ
3. Render 側の `server` が WS を終端し、そこから**素の TCP 接続**を Spotify へ張る
4. 以降は双方向のバイナリフレーム = 生 TCP ストリーム（TLS の中身は一切解釈しない）

> なお `server` は**素の HTTP プロキシモードも同時に持っています**（後述「モードB」）。
> Render 以外の、CONNECT をそのまま通せるホスト（自前 VPS / Fly.io / Railway など）に置く場合は
> `client` を挟まずブラウザから直接プロキシ指定できます。

---

## ⚠️ 先に読むこと（重要）

- **Spotify の利用規約**は、地域制限の回避を目的としたプロキシ/VPN 利用を禁止しています。
  アカウントの停止・地域判定の不整合（再生不可・カタログ差異）が起こり得ます。
  **自己責任**で、かつ自分が正当に利用できる範囲でのみ使ってください。
- **Render 無料枠には「帯域 5GB/月」の壁があります**（2026年4月の改定で 100GB→5GB に削減）。
  Spotify の高音質(160kbps)ストリーミングは **約 69 時間/月** で上限に達し、
  支払い方法を登録していない場合は**ワークスペース内の全 Free サービスが当月末まで停止**します。
  → 詳しくは [`DEPLOY.md` の「無料枠の現実」](DEPLOY.md#️-無料枠の現実必ず読む) を**必ず**お読みください。
- **Render の無料プランは 15 分無通信でスリープ**し、復帰に約 1 分かかります。
  毎日使うなら Starter（$7/月）を推奨します。
- `PROXY_TOKEN` を付けずに公開すると**誰でも使えるオープンプロキシ**になり、
  不正中継・踏み台に使われてアカウント停止や法的リスクにつながります。**必ずトークンを設定してください。**
- Render の利用規約上、他者へのプロキシ提供（リセリング）は認められていません。自分の利用に留めてください。

---

## ディレクトリ構成

```
spotify-render-proxy/
├── DEPLOY.md                # ★ デプロイ手順（完全版）
├── render.yaml              # Render Blueprint（これを渡すだけでデプロイできる）
├── .env.example             # 環境変数の一覧と説明
├── .gitignore
├── server/                  # ★ Render にデプロイする側
│   ├── index.js             #    プロキシ本体（WS トンネル + 直接 HTTP/CONNECT）
│   └── package.json
├── client/                  # ★ 自分のPCで動かす側
│   ├── index.js             #    ローカル HTTP(8888) / SOCKS5(1080) プロキシ
│   └── package.json
├── pac/
│   └── proxy.pac            # Spotify だけプロキシに通す自動構成スクリプト
├── extras/
│   ├── autostart.md         # client を常駐させる設定例 (systemd / launchd / タスクスケジューラ)
│   └── keepalive.yml.example# Render のスリープ防止用 GitHub Actions (任意)
└── _test/                   # 動作検証スクリプト（デプロイには不要）
    ├── run.sh               #    端到端の統合テスト（実 Spotify にもアクセスします）
    ├── run3.sh              #    認証まわりのテスト
    ├── run4.sh              #    直接 HTTP プロキシ（モードB）のテスト
    ├── probe.js             #    検証本体
    ├── echo.js              #    ローカルのエコーサーバ (HTTP / TCP / TLS自己署名)
    ├── kill.js              #    テスト用プロセスの後始末
    └── auth.js / directhttp.js
```

---

## 1. Render にデプロイする

> 📘 **詳細な手順・スクリーンショット相当の説明・リージョン選び・トラブルシュートは
> [`DEPLOY.md`](DEPLOY.md) にまとめてあります。** 以下は最短経路の要約です。

### 方法A: Blueprint（おすすめ）

1. このフォルダを GitHub リポジトリに push する
2. Render ダッシュボード → **New +** → **Blueprint** → リポジトリを選択
3. `render.yaml` が読まれ、`spotify-proxy` サービスが自動生成される
4. **Environment** タブで `PROXY_TOKEN` の値を確認・コピーする
   （`generateValue: true` により Render がランダム文字列を自動生成しています）
5. デプロイ完了後、`https://<あなたのアプリ名>.onrender.com/healthz` を開いて
   `spotify-render-proxy ok` が出れば成功

### 方法B: 手動で Web Service を作る

| 項目 | 値 |
|---|---|
| Runtime | **Node** |
| Root Directory | `server` |
| Build Command | `npm install --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/healthz` |
| Plan | Free（試用）/ Starter（常用） |

環境変数:

| Key | Value | 説明 |
|---|---|---|
| `PROXY_TOKEN` | 長いランダム文字列 | **必須**。`openssl rand -hex 24` で生成 |
| `PUBLIC` | `0` | `1` にすると認証なし。**変えないこと** |
| `MAX_TUNNELS` | `50` | 同時トンネル数の上限 |
| `CONNECT_TIMEOUT` | `10000` | ターゲットへの TCP 接続タイムアウト(ms) |
| `NODE_VERSION` | `20.11.1` | Node のバージョン固定 |

### ローカルで試すだけなら

```bash
cd server
npm install
PROXY_TOKEN=$(openssl rand -hex 24) PORT=8080 npm start
```

---

## 2. クライアントを起動する（自分のPC）

```bash
cd client
npm install

RENDER_URL=https://<あなたのアプリ名>.onrender.com \
PROXY_TOKEN=<サーバと同じトークン> \
npm start
```

`.env` ファイルに書いておく場合は `.env.example` をコピーしてください
（`node --env-file=.env index.js` で読み込めます / Node 20.6+）。

起動すると次の 2 つがローカルに開きます:

| 用途 | アドレス |
|---|---|
| HTTP / HTTPS プロキシ | `http://127.0.0.1:8888` |
| SOCKS5 プロキシ | `socks5://127.0.0.1:1080` |

### 動作確認

```bash
# HTTP プロキシ経由で Spotify Web Player を取得
curl -x http://127.0.0.1:8888 -sS -o /dev/null -w "%{http_code} %{size_download}\n" \
  https://open.spotify.com/
# → 200 310000 前後が出れば成功

# Web API（トークン無しなので 401 が返るのが正常 = トンネルは通っている）
curl -x http://127.0.0.1:8888 -sS https://api.spotify.com/v1/me
# → { "error": { "status": 401, "message": "Missing/invalid/expired access token" } }

# 自分の出口 IP が Render のリージョンになっているか確認
curl -x http://127.0.0.1:8888 -sS https://api.ipify.org ; echo

# SOCKS5 経由
curl --socks5-hostname 127.0.0.1:1080 -sS -o /dev/null -w "%{http_code}\n" \
  https://open.spotify.com/
```

---

## 3. ブラウザ／アプリから Spotify を開く

### Firefox（推奨・一番きれい）

Firefox は OS 設定と独立したプロキシ設定を持っています。

1. `設定` → 検索窓に「プロキシ」→ **ネットワーク設定** の `設定...`
2. **手動でプロキシを設定する** を選択
   - HTTP プロキシ: `127.0.0.1` / ポート: `8888`
   - **このプロキシを HTTPS でも使用する** にチェック
   - SOCKS ホスト: `127.0.0.1` / ポート: `1080` / **SOCKS v5**
3. `proxy.pac` を使う場合は「自動プロキシ設定 URL」に
   `file:///Users/you/spotify-render-proxy/pac/proxy.pac`
4. https://open.spotify.com/ を開く

### Chrome / Edge / Safari

これらは OS のプロキシ設定を使います。全通信を通したくない場合は `pac/proxy.pac` を
「自動構成スクリプト」として指定するのが安全です。

- **macOS**: システム設定 → ネットワーク → 詳細 → プロキシ →
  「自動プロキシ構成」を ON にして `proxy.pac` のパスを入力
- **Windows**: 設定 → ネットワークとインターネット → プロキシ →
  「セットアップ スクリプトを使用する」→ `C:\pac\proxy.pac`
- **Linux (GNOME)**: 設定 → ネットワーク → ネットワークプロキシ → 自動

### Spotify デスクトップアプリ

アプリ自体にプロキシ設定はありません。`SOCKS5 (127.0.0.1:1080)` を OS レベルで
指定するか、`proxychains` 等を使って起動してください。

```bash
# macOS (Homebrew の proxychains-ng)
proxychains4 -q -f <(echo -e "socks5 127.0.0.1:1080") /Applications/Spotify.app/Contents/MacOS/Spotify
```

### CLI・スクリプトから

```bash
export https_proxy=http://127.0.0.1:8888
export http_proxy=http://127.0.0.1:8888
export all_proxy=socks5://127.0.0.1:1080
```

---

## モードB: 直接 HTTP プロキシとして使う（client 不要）

`server` は WebSocket トンネルに加えて、**素の HTTP プロキシ**としても動きます。
CONNECT をそのまま通せるホスト（自前 VPS / Fly.io / Railway / Docker など）に置く場合や、
サーバ側スクリプトから叩く場合に便利です。

```bash
# 絶対 URI 形式の GET 転送
curl -x http://<host>:8080 -H "Authorization: Bearer $PROXY_TOKEN" \
  https://api.spotify.com/v1/me

# CONNECT トンネル
curl -x http://<host>:8080 -H "Authorization: Bearer $PROXY_TOKEN" \
  https://open.spotify.com/

# Proxy-Authorization: Basic でも可 (パスワード欄にトークンを入れる)
curl -x http://user:$PROXY_TOKEN@<host>:8080 https://open.spotify.com/

# ヘルスチェック（認証不要）
curl http://<host>:8080/healthz
```

認証に失敗すると `407 Proxy Authentication Required` が返ります。

> **Render では モードB の CONNECT は LB に弾かれることがあります。**
> Render で使う場合は必ず `client` を挟むモードA を使ってください。
> モードB の GET/POST 転送は Render でも動きます。

---

## 仕組み（プロトコル）

WebSocket は 1 トンネルにつき 1 本。ハンドシェイクは以下の通りです。

```
client ──► server :  {"type":"connect","host":"open.spotify.com","port":443}\n      [バイナリフレーム]
server ──► client :  OK\n                                                            [バイナリフレーム]
                 └─ または  ERR <code> <reason>\n  (例: ERR 502 ENOTFOUND)

以降、双方向のバイナリフレーム = ターゲットとの生 TCP ストリーム
```

設計上のポイント:

- **ハンドシェイクフレームにデータを相乗りさせてはいけない。**
  相乗りさせるとサーバが `OK` に同梱してエコーバックしてしまう（実装時に踏んだ落とし穴）。
  先頭データは必ず `OK` を受け取った後に別フレームで送る。
- `perMessageDeflate: false`（両側）。圧縮は CPU を食うだけで、
  すでに圧縮されている音声/画像ストリームには効果がありません。
- **1 トンネル = 1 WebSocket**。多重化しないので、
  リスナの取り違えやストリームの混線が構造的に発生しません。
- `MAX_TUNNELS` / `MAX_CONCURRENT` で同時接続数に上限をかけています。
- 認証トークンは WebSocket の **subprotocol** (`proxy.v1.<TOKEN>`) で運びます。
  WS のハンドシェイクは通常の HTTP リクエストなので、Render の LB をそのまま通過します。

---

## トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| `ws rejected (HTTP 401)` | `PROXY_TOKEN` がサーバと一致していない。Render の Environment を確認 |
| `ws rejected (HTTP 404)` | `RENDER_URL` の末尾に `/tunnel` を付けていないか。URL は `https://xxx.onrender.com` まで |
| 最初だけ数十秒待たされる | Render 無料プランのスリープ復帰。`/healthz` を先に叩くと起きる |
| `ERR 502 ENOTFOUND` | サーバ側で DNS 解決に失敗。ターゲットのホスト名を確認 |
| `ERR 503 too-many-tunnels` | `MAX_TUNNELS` 超過。値を上げるか接続を減らす |
| ブラウザで接続が切れる | `client` プロセスが落ちている。ログを確認 |
| Spotify Web Player が白紙 | 一部のドメインが PAC に入っていない。`pac/proxy.pac` の `SPOTIFY_HOSTS` に追加 |
| 音は出るが操作できない | `dealer.spotify.com` / `spclient.wg.spotify.com` をプロキシに通す |

サーバ側のログには、トンネルの開閉が以下のように出ます:

```
2026-10-13T10:00:59.246Z tunnel open open.spotify.com:443 (11ms, active=1)
2026-10-13T10:00:59.469Z tunnel open api.spotify.com:443 (7ms, active=2)
```

---

## 動作検証済み

`_test/run.sh` による端到端のテスト結果（ローカルで server + client を起動し、
ローカルのエコーサーバと**実物の Spotify エンドポイント**に対して実行）:

| テスト | 結果 |
|---|---|
| プレーン HTTP 転送（origin-form） | ✅ 200 |
| HTTPS `open.spotify.com/`（CONNECT） | ✅ 200 / 310,150 bytes（Web Player HTML） |
| HTTPS `api.spotify.com/v1/me` | ✅ 401（トークン無しなので想定通り＝疎通OK） |
| HTTPS `accounts.spotify.com/authorize` | ✅ 303（リダイレクト） |
| CONNECT 生 TCP エコー | ✅ `PONG:PING` |
| CONNECT + TLS（自己署名証明書） | ✅ 200 |
| SOCKS5 生 TCP エコー | ✅ `PONG:PING-SOCKS` |
| SOCKS5 + TLS（自己署名証明書） | ✅ 200 |
| SOCKS5 + TLS `open.spotify.com` | ✅ 200 / 313,284 bytes |
| 同時 7 トンネル | ✅ 混線なし |
| 認証: 正しいトークン | ✅ 通過 |
| 認証: 誤ったトークン | ✅ WS 401 / CONNECT 407 |
| 認証: トークンなし | ✅ WS 401 / CONNECT 407 |
| 直接 HTTP プロキシ（絶対URI, モードB） | ✅ 200（認証時のみ） |

```bash
# 手元で再現する
./_test/run.sh    # 端到端（実 Spotify にもアクセスします）
./_test/run3.sh   # 認証まわり
./_test/run4.sh   # 直接 HTTP プロキシ
```

---

## ライセンス / 免責

このコードは学習・検証目的で提供されています。
Spotify および Render の利用規約、ならびにあなたの居住国の法令を遵守した上で、
**自己責任**において使用してください。本ソフトウェアの利用によって生じたいかなる損害についても
作者は責任を負いません。
