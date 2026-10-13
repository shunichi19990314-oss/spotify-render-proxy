# client を常駐させる（任意）

手元の PC で `client/index.js` を自動起動させておくための設定例です。
使わない場合はこのフォルダごと無視して構いません。

---

## Linux (systemd user service)

`~/.config/systemd/user/spotify-proxy-client.service` に配置してください。

```ini
[Unit]
Description=Spotify Render Proxy Client
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/YOU/spotify-render-proxy/client
Environment=RENDER_URL=https://your-app-name.onrender.com
Environment=PROXY_TOKEN=your-token-here
Environment=LOCAL_HTTP_PORT=8888
Environment=LOCAL_SOCKS_PORT=1080
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now spotify-proxy-client
systemctl --user status spotify-proxy-client
journalctl --user -u spotify-proxy-client -f     # ログ
```

> 環境変数をファイルに書きたくない場合は `EnvironmentFile=%h/.config/spotify-proxy.env`
> を使い、そのファイルを `chmod 600` してください。

---

## macOS (launchd)

`~/Library/LaunchAgents/com.user.spotify-proxy-client.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.user.spotify-proxy-client</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOU/spotify-render-proxy/client/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/YOU/spotify-render-proxy/client</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>RENDER_URL</key><string>https://your-app-name.onrender.com</string>
    <key>PROXY_TOKEN</key><string>your-token-here</string>
    <key>LOCAL_HTTP_PORT</key><string>8888</string>
    <key>LOCAL_SOCKS_PORT</key><string>1080</string>
  </dict>

  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/spotify-proxy-client.log</string>
  <key>StandardErrorPath</key><string>/tmp/spotify-proxy-client.err</string>
</dict>
</plist>
```

```bash
launchctl load  ~/Library/LaunchAgents/com.user.spotify-proxy-client.plist
launchctl unload ~/Library/LaunchAgents/com.user.spotify-proxy-client.plist
tail -f /tmp/spotify-proxy-client.log
```

> `node` のパスは `which node` で確認してください（Apple Silicon + Homebrew なら
> `/opt/homebrew/bin/node` のことが多いです）。

---

## Windows (タスクスケジューラ)

`start-client.cmd` を作っておくと手軽です:

```bat
@echo off
set RENDER_URL=https://your-app-name.onrender.com
set PROXY_TOKEN=your-token-here
cd /d C:\Users\YOU\spotify-render-proxy\client
node index.js
```

タスクスケジューラで「ログオン時」トリガー + この .cmd を指定すれば自動起動します。
