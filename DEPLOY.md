# デプロイ手順（完全版）

このドキュメントだけで、**ゼロから「Spotify がプロキシ経由で開く」状態**まで持っていけます。
所要時間の目安: **初回 15〜20 分**（Render のビルド待ちを含む）

```
あなたのPC                                    Render
┌──────────────────────────┐          ┌───────────────────────┐
│ ブラウザ                  │          │  spotify-proxy        │
│   │                      │          │                       │
│   ▼                      │ WebSocket│                       │
│ client/index.js          │═════════►│  server/index.js      │──► open.spotify.com
│  127.0.0.1:8888 (HTTP)   │  (認証付) │  認証 + TCPトンネル    │──► api.spotify.com
│  127.0.0.1:1080 (SOCKS5) │          │                       │──► *.scdn.co
└──────────────────────────┘          └───────────────────────┘
        ▲                                      ▲
   【Step 5 で起動】                    【Step 2 でデプロイ】
```

---

## 目次

- [Step 0: 前提](#step-0-前提)
- [Step 1: Render アカウントを作る](#step-1-render-アカウントを作る)
- [Step 2: サーバを Render にデプロイする](#step-2-サーバを-render-にデプロイする)
- [Step 3: PROXY_TOKEN を取得する](#step-3-proxy_token-を取得する)
- [Step 4: サーバが動いているか確認する](#step-4-サーバが動いているか確認する)
- [Step 5: 手元でクライアントを起動する](#step-5-手元でクライアントを起動する)
- [Step 6: 疎通確認する](#step-6-疎通確認する)
- [Step 7: ブラウザにプロキシを設定する](#step-7-ブラウザにプロキシを設定する)
- [Step 8: Spotify を開く](#step-8-spotify-を開く)
- [⚠️ 無料枠の現実（必ず読む）](#️-無料枠の現実必ず読む)
- [有料プランにする](#有料プランにする)
- [スリープさせない（任意）](#スリープさせない任意)
- [トラブルシュート](#トラブルシュート)
- [片付け（使わなくなったら）](#片付け使わなくなったら)

---

## Step 0: 前提

| 必要なもの | 確認方法 |
|---|---|
| GitHub アカウント | 本リポジトリが見られれば OK |
| Node.js 18 以上（手元PC） | `node -v` → v18.x 以上 |
| Git | `git --version` |
| 支払い情報 | **不要**（無料枠で試せます） |

本リポジトリをまだ clone していない場合:

```bash
git clone https://github.com/shunichi19990314-oss/spotify-render-proxy.git
cd spotify-render-proxy
```

---

## Step 1: Render アカウントを作る

1. https://dashboard.render.com/register を開く
2. **GitHub** でサインアップするのがおすすめ
   → 後の Step 2 でリポジトリ選択が自動になり、認証も不要になります
3. メール認証を済ませる

> 無料の **Hobby ワークスペース**が自動で作られます（月額 $0 / 帯域 5GB 込み）。

---

## Step 2: サーバを Render にデプロイする

### 方法 A: Blueprint（おすすめ・3クリック）

リポジトリ直下の `render.yaml` が自動的に読み込まれ、**サービス名・ビルドコマンド・環境変数まで全部入り**で生成されます。

1. ダッシュボード左上の **New +** をクリック
2. **Blueprint** を選択
3. GitHub アカウントを連携（初回のみ）→ リポジトリ一覧から **`spotify-render-proxy`** を選ぶ
4. **Apply** をクリック

これで完了です。Render が以下を自動でやってくれます:

- `spotify-proxy` という Web Service を作成
- `server/` を Root Directory として認識
- `npm install --omit=dev` でビルド → `npm start` で起動
- `/healthz` でヘルスチェック
- **`PROXY_TOKEN` をランダム生成**（← Step 3 で使います）
- push のたびに自動再デプロイ

ビルドは **1〜3 分**かかります。ログに以下が出れば成功です:

```
==> Your service is live 🎉
```

### 方法 B: 手動で Web Service を作る

Blueprint が使えない場合（別リポジトリにしたい等）はこちら。

1. **New +** → **Web Service**
2. リポジトリ `spotify-render-proxy` を選択 → **Connect**
3. 以下を**正確に**入力:

| 項目 | 入力値 |
|---|---|
| Name | `spotify-proxy`（任意） |
| Region | **Singapore**（日本から近い。後述） |
| Branch | `main` |
| Root Directory | `server` ← **重要。空にすると動きません** |
| Runtime | **Node** |
| Build Command | `npm install --omit=dev` |
| Start Command | `npm start` |
| Instance Type / Plan | **Free** |

4. **Advanced** を開いて環境変数を追加:

| Key | Value | 備考 |
|---|---|---|
| `PROXY_TOKEN` | *(Generate をクリック)* | Render が自動生成してくれます |
| `PUBLIC` | `0` | **`1` にしないこと** |
| `NODE_VERSION` | `20.11.1` | 任意 |
| `MAX_TUNNELS` | `50` | 任意 |

5. **Health Check Path** に `/healthz`
6. **Create Web Service** をクリック

### 🌏 リージョンの選び方（重要）

**リージョン＝あなたの出口 IP の国**です。Spotify からは
「その国のユーザー」として見えるため、**カタログ・配信地域・言語に影響します**。

| リージョン | 出口IPの国 | 日本からのレイテンシ |
|---|---|---|
| `singapore` | シンガポール | **◎ 最も速い（~70ms）** |
| `oregon`（既定） | 米国西部 | △ (~110ms) |
| `ohio` / `virginia` | 米国東部 | ✕ (~160ms) |
| `frankfurt` | ドイツ | ✕ (~230ms) |
| `sydney` | オーストラリア | △ (~150ms) |

音質・操作の応答性に直結するので、**理由がなければ `singapore` を推奨**します。
Blueprint の場合は `render.yaml` の `# region: singapore` のコメントを外してください。

---

## Step 3: PROXY_TOKEN を取得する

1. 作成したサービス（`spotify-proxy`）を開く
2. 左メニューの **Environment** をクリック
3. `PROXY_TOKEN` の行にある **目のアイコン（👁 / Reveal）** をクリック
4. 表示された文字列を**コピー**（base64 の 43 文字程度）

```
例: Xk3vQ9mZpL2nR7tYwB4cDfGhJkMnPqRsTuVwXyZ0aBc=
```

> 🔐 **このトークンはパスワードと同じ**です。
> GitHub の Issue やスクリーンショットに載せないでください。
> 漏らした場合は Environment で **Edit → Regenerate** すれば即無効化できます。

---

## Step 4: サーバが動いているか確認する

ブラウザで以下を開いてください（`<アプリ名>` は Render が付けた名前。
サービスの **Settings** 上部、または URL バーで見られます）:

```
https://<アプリ名>.onrender.com/healthz
```

**期待される結果:**

```
spotify-render-proxy ok
```

これが出ればサーバ側は完璧です。

| 表示 | 意味 | 対処 |
|---|---|---|
| `spotify-render-proxy ok` | ✅ 正常 | 次へ |
| Render のローディングページ | スリープから復帰中 | **約1分待ってリロード** |
| `404` / `Service not found` | URL が間違っている | サービス名を確認 |
| `502` / `Application failed to respond` | 起動失敗 | Step 2 の Root Directory が `server` か確認 |

---

## Step 5: 手元でクライアントを起動する

### 5-1. 依存関係をインストール

```bash
cd spotify-render-proxy/client
npm install
```

`ws` が 1 パッケージ入るだけです（数秒で終わります）。

### 5-2. 起動

**macOS / Linux:**

```bash
RENDER_URL=https://<アプリ名>.onrender.com \
PROXY_TOKEN='<Step3でコピーした値>' \
npm start
```

**Windows (PowerShell):**

```powershell
$env:RENDER_URL="https://<アプリ名>.onrender.com"
$env:PROXY_TOKEN="<Step3でコピーした値>"
npm start
```

**Windows (cmd.exe):**

```cmd
set RENDER_URL=https://<アプリ名>.onrender.com
set PROXY_TOKEN=<Step3でコピーした値>
npm start
```

**`.env` ファイルに書いておく場合（おすすめ・毎回の入力が不要）:**

```bash
cp ../.env.example .env
# .env を編集して RENDER_URL と PROXY_TOKEN を書き込む
node --env-file=.env index.js
```

> `.env` は `.gitignore` 済みなので、誤って push されることはありません。

### 5-3. 起動成功の表示

```
2026-10-13T14:20:01.123Z HTTP プロキシ   ->  http://127.0.0.1:8888
2026-10-13T14:20:01.124Z SOCKS5 プロキシ ->  socks5://127.0.0.1:1080
2026-10-13T14:20:01.125Z --- 設定値 ---------------------------------------------------
```

**このターミナルは閉じないでください。** 閉じるとプロキシが止まります。

---

## Step 6: 疎通確認する

**別のターミナル**を開いて:

```bash
# ① Spotify Web Player が取れるか
curl -x http://127.0.0.1:8888 -sS -o /dev/null -w "HTTP %{http_code} / %{size_download} bytes\n" \
  https://open.spotify.com/
```

**期待される結果:**

```
HTTP 200 / 310000 bytes   ← 30万バイト前後なら成功
```

```bash
# ② Web API が reachable か（トークン無しなので 401 が「正解」）
curl -x http://127.0.0.1:8888 -sS https://api.spotify.com/v1/me
```

```json
{ "error": { "status": 401, "message": "Missing/invalid/expired access token" } }
```

↑ **401 が返るのは正常**です。「Spotify のサーバまで届いたが認証情報がない」という意味で、
トンネルが通っている証拠です。`502` や `timeout` なら接続に問題があります。

```bash
# ③ 出口 IP が Render のリージョンになっているか
curl -x http://127.0.0.1:8888 -sS https://api.ipify.org ; echo
```

→ **シンガポール/米国の IP** が出れば、プロキシ経由で外に出られています。
日本の IP が出た場合は、プロキシを通っていません。

```bash
# ④ SOCKS5 も確認
curl --socks5-hostname 127.0.0.1:1080 -sS -o /dev/null -w "SOCKS5: HTTP %{http_code}\n" \
  https://open.spotify.com/
```

---

## Step 7: ブラウザにプロキシを設定する

### Firefox（一番おすすめ）

Firefox だけが **OS と独立したプロキシ設定**を持ちます。
つまり「Firefox だけプロキシ経由、他のアプリは通常」という干净的な使い分けができます。

1. 右上 `☰` → **設定**
2. 検索ボックスに「**プロキシ**」と入力
3. **ネットワーク設定** の `設定...` ボタンをクリック
4. **手動でプロキシを設定する** を選択
5. 入力:

   | 項目 | 値 |
   |---|---|
   | HTTP プロキシ | `127.0.0.1` |
   | ポート | `8888` |
   | ☑ **このプロキシを HTTPS でも使用する** | **必ずチェック** |
   | SOCKS ホスト | `127.0.0.1` |
   | ポート | `1080` |
   | ☑ SOCKS v5 | v5 を選択 |

6. **OK** で保存

> `pac/proxy.pac` を使う場合は、代わりに「**自動プロキシ設定 URL**」に
> `file:///Users/<あなた>/spotify-render-proxy/pac/proxy.pac`
> を入れると、**Spotify 関連ドメインだけ**がプロキシを通ります（他サイトは通常速度）。

### Chrome / Edge / Brave

これらは **OS のプロキシ設定を共有**します。全通信を通したくない場合は PAC を使ってください。

**macOS:**
1. システム設定 → **ネットワーク** → 使用中の回線（Wi-Fi 等）→ **詳細**
2. **プロキシ** タブ
3. 「**自動プロキシ構成**」を ON → URL に
   `file:///Users/<あなた>/spotify-render-proxy/pac/proxy.pac`
4. **OK** → **適用**

**Windows:**
1. 設定 → **ネットワークとインターネット** → **プロキシ**
2. 「**セットアップ スクリプトを使用する**」→ **セットアップ**
3. スクリプトの URL に `C:\Users\<あなた>\spotify-render-proxy\pac\proxy.pac`
   （または `file:///C:/Users/.../proxy.pac`）
4. **保存**

> 手動で全部通す場合は「手動セットアップ」→ アドレス `127.0.0.1` / ポート `8888`

**Linux (GNOME):**
設定 → ネットワーク → **ネットワークプロキシ** → 「自動」→ PAC のパスを入力

### 設定を解除するとき

忘れずに **プロキシ設定を OFF / 自動検出に戻す**か、`client` を止めると
ブラウザがネットに繋がらなくなります（`127.0.0.1:8888` が死ぬため）。

---

## Step 8: Spotify を開く

```
https://open.spotify.com/
```

- ログインして再生してみてください
- サーバ側の Render ログ（**Logs** タブ）に、接続がリアルタイムで表示されます:

```
tunnel open open.spotify.com:443 (11ms, active=1)
tunnel open api.spotify.com:443 (7ms, active=2)
tunnel open accounts.spotify.com:443 (5ms, active=3)
tunnel open spclient.wg.spotify.com:443 (9ms, active=4)
```

↑ こう出ていれば完全に正常です。

### Spotify デスクトップアプリの場合

アプリ自体にプロキシ設定はありません。OS レベルで **SOCKS5 `127.0.0.1:1080`** を
指定するか、`proxychains` 経由で起動します。

```bash
# macOS (brew install proxychains-ng)
proxychains4 -q -f <(echo "socks5 127.0.0.1:1080") \
  /Applications/Spotify.app/Contents/MacOS/Spotify
```

---

## ⚠️ 無料枠の現実（必ず読む）

**音楽ストリーミングは帯域を大量に消費します。** Render の無料枠で
常用する前に、この数字を理解しておいてください。
（2026年4月の Render 料金改定で、Hobby ワークスペースの込み帯域は
**100GB → 5GB** に大幅削減されました）

### 帯域の目安

| Spotify 音質 | ビットレート | 1時間あたり | **5GB で聴ける時間** |
|---|---|---|---|
| 低 | 96 kbps | 43 MB | 約 116 時間 |
| 標準 | 128 kbps | 58 MB | 約 87 時間 |
| 高 | 160 kbps | 72 MB | **約 69 時間** |
| 最高 | 320 kbps | 144 MB | **約 35 時間** |

つまり高音質で **1日2時間聴くと、約1ヶ月で 5GB を使い切ります。**
（初回ロードの HTML/JS/ジャケット画像で数 MB が別途かかります）

### 5GB を超えるとどうなるか

| 支払い方法の登録 | 挙動 |
|---|---|
| **登録なし** | ⛔ **ワークスペース内の全 Free サービスが当月末まで停止** |
| 登録あり | ✅ 超過分を **$0.15/GB** で請求（100時間/月 ≈ 7.2GB ≈ **超過 $0.33**） |

### その他の無料枠の制限

| 制限 | 内容 | 実務上の影響 |
|---|---|---|
| **スリープ** | 15 分間 inbound トラフィックがないと停止 | 再開に**約1分**。その間は接続失敗 |
| **インスタンス時間** | 750 時間/月 | 24時間起動 = 730 時間。**1サービスなら収まるがギリギリ** |
| **発信トラフィック** | 「異常に多い外部への通信」は**停止される可能性あり** | プロキシはこれに該当しうる ⚠️ |
| **ファイルシステム** | 再起動で消える | 本構成は状態を持たないので**影響なし** |
| **スケール / SSH** | 不可 | 影響なし |

### 結論としての推奨

| 用途 | おすすめ構成 | 月額 |
|---|---|---|
| **まず試す / 時々** | Hobby WS + **Free** compute | **$0** |
| **毎日 1〜2 時間聴く** | Hobby WS + **Starter** compute + **支払い方法登録** | **$7** + 超過 $0.15/GB |
| **ヘビーユース** | **Pro** WS ($25, 25GB込) + Starter compute | **$32** |
| **月 100 時間以上** | Render 以外の選択肢も検討（後述） | — |

---

## 有料プランにする

### コンピュートプランを変更（スリープをなくす）

1. サービスを開く → 右上の **Settings**
2. **Instance Type** の項目
3. **Free** → **Starter（512 MB / 0.5 CPU, $7/月）** を選択
4. **Save Changes** → 自動で再デプロイ

これで **スリープしなくなり、常に応答が即座**になります。

> ⚠️ **プランを上げても帯域（5GB）は増えません。**
> 帯域は**ワークスペースプラン**（Hobby→Pro）で決まります。

### ワークスペースプランを上げる（帯域を増やす）

1. **Account Settings** → **Billing**
2. Workspace plan を **Hobby（5GB）** → **Pro（$25/月, 25GB）** に変更

### 支払い方法だけ登録する（一番コスパが良い）

コンピュートは Free のまま、**カードだけ登録**しておくと、
帯域超過時に「停止」ではなく「$0.15/GB の請求」になります。
月に数時間しか聴かないなら、**$0 のまま**運用できます。

---

## スリープさせない（任意）

無料枠のスリープ（15分無通信 → 復帰に約1分）を避けたい場合、
**外部から定期的に `/healthz` を叩く**方法があります。

### 方法1: GitHub Actions（無料・おすすめ）

Public リポジトリなら GitHub Actions は無料で使えます。
`.github/workflows/keepalive.yml` を追加:

```yaml
name: keepalive
on:
  schedule:
    - cron: '*/10 * * * *'   # 10分ごと
  workflow_dispatch: {}
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - run: curl -sS -m 90 -o /dev/null -w "%{http_code}\n" https://<アプリ名>.onrender.com/healthz
```

> ⚠️ 注意:
> - 24時間稼働させると **730 時間/月** を消費し、無料枠 750 時間をほぼ使い切ります
> - GitHub Actions の cron は**混雑時に数分遅延**することがあります
> - そもそも「常時稼働させたい」なら **Starter ($7/月) の方が確実で安い**です

### 方法2: 外部の cron サービス

[cron-job.org](https://cron-job.org/) などで 10 分間隔の GET を登録するだけでも OK です。

---

## トラブルシュート

### クライアント起動時

| エラー | 原因 | 対処 |
|---|---|---|
| `RENDER_URL を指定してください` | 環境変数が渡っていない | 変数名のスペル、`.env` の読み込みを確認 |
| `ws rejected (HTTP 401)` | **トークン不一致** | Step 3 で再コピー。引用符 `'` で囲む |
| `ws rejected (HTTP 404)` | URL のパスが間違い | `RENDER_URL` は `https://xxx.onrender.com` **まで**（`/tunnel` を付けない） |
| `ECONNREFUSED 127.0.0.1:8888` | ポートが使用中 | `LOCAL_HTTP_PORT=8889 npm start` で変更 |
| `tunnel handshake timeout` | サーバがスリープ中 | **約1分待って**再実行 |

### ブラウザで開けない

| 症状 | 対処 |
|---|---|
| `接続できませんでした` / `PROXY_CONNECTION_REFUSED` | `client` が起動しているか。ターミナルを閉じていないか |
| 最初に 1 分ほど固まる | Render がスリープから復帰中。**待てば繋がります** |
| 白紙ページ / 一部だけ読めない | `pac/proxy.pac` の `SPOTIFY_HOSTS` に不足ドメインあり。追加する |
| 再生できるが操作が効かない | `dealer.spotify.com` `spclient.wg.spotify.com` をプロキシへ |
| ログインできない | `accounts.spotify.com` がプロキシを通っているか確認 |
| **音が出ない** | 音声は `audio-fa.scdn.co` `audio4-fa.scdn.co`。**ここが DIRECT だと無音になります** |

### 原因の切り分け方

**① サーバは生きているか**

```bash
curl -sS https://<アプリ名>.onrender.com/healthz
```

**② トンネルは通っているか**（Render の Logs タブを見る）

```
tunnel open open.spotify.com:443 (11ms, active=1)   ← 出ていれば疎通OK
tunnel fail xxx -> ENOTFOUND                        ← DNS 解決失敗
ERR 503 too-many-tunnels                            ← 同時接続上限
```

**③ ローカルプロキシは生きているか**

```bash
curl -x http://127.0.0.1:8888 -sS -o /dev/null -w "%{http_code}\n" https://example.com/
```

**④ 出口 IP は変わっているか**

```bash
curl -x http://127.0.0.1:8888 -sS https://api.ipify.org; echo
curl -sS https://api.ipify.org; echo   # 直接接続（比較用）
```

この 2 つが**別の IP** なら、プロキシは正しく機能しています。

---

## 片付け（使わなくなったら）

**放置すると帯域を消費し続け、他の Free サービスが停止する原因になります。**

1. **ブラウザのプロキシ設定を解除**（自動検出に戻す）
2. `client` を `Ctrl+C` で停止
3. Render でサービスを削除:
   サービス → **Settings** → 最下部の **Delete Web Service**
4. 必要なら Blueprint も削除:
   **Blueprints** → 該当 → **Settings** → **Delete Blueprint**

> Blueprint 経由で作った場合、**サービスだけ消しても Blueprint が再生成することがあります。**
> 必ず Blueprint 側も削除してください。

---

## 参考: 動作検証済み項目

本リポジトリの `_test/run.sh` により、以下を実機の Spotify エンドポイントに対して確認済みです。

| テスト | 結果 |
|---|---|
| HTTPS `open.spotify.com/`（CONNECT 経由） | ✅ 200 / 310,150 bytes |
| HTTPS `api.spotify.com/v1/me` | ✅ 401（想定通り＝疎通OK） |
| HTTPS `accounts.spotify.com/authorize` | ✅ 303 |
| SOCKS5 + TLS `open.spotify.com` | ✅ 200 / 313,284 bytes |
| CONNECT / SOCKS5 生 TCP エコー | ✅ |
| TLS（自己署名証明書）経由 | ✅ 200 |
| 同時 7 トンネル | ✅ 混線なし |
| 認証（正しい / 誤り / なし） | ✅ 通過 / 401 / 407 |

```bash
npm install && npm test          # 端到端テスト（実 Spotify にもアクセス）
npm run test:auth                # 認証まわり
npm run test:direct              # 直接 HTTP プロキシ（モードB）
```
