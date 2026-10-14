#!/bin/bash
# 端到端の動作検証 (ローカルで server/client を立てて probe を流す)
node _test/kill.js > /dev/null 2>&1; sleep 1; rm -f /tmp/*.log
# 自己署名証明書 (TLS エンドツーエンド検証用)。無ければ生成する
if [ ! -f /tmp/key.pem ] || [ ! -f /tmp/cert.pem ]; then
  openssl req -x509 -newkey rsa:2048 -keyout /tmp/key.pem -out /tmp/cert.pem \
    -days 2 -nodes -subj "/CN=127.0.0.1" >/dev/null 2>&1 && echo "(自己署名証明書を生成しました)"
fi
node _test/echo.js > /tmp/echo.log 2>&1 &
(cd server && PORT=18080 PROXY_TOKEN=testtoken123 node index.js) > /tmp/server.log 2>&1 &
sleep 2
(cd client && RENDER_URL=http://127.0.0.1:18080 PROXY_TOKEN=testtoken123 LOCAL_HTTP_PORT=18888 LOCAL_SOCKS_PORT=11080 node index.js) > /tmp/client.log 2>&1 &
sleep 2
timeout 80 node _test/probe.js > /tmp/probe.log 2>&1
echo "=== probe ==="; cat /tmp/probe.log
echo; echo "=== server ==="; grep -v "^$" /tmp/server.log | head -30
echo; echo "=== client (errors only) ==="; grep -iE "error|fail|refus" /tmp/client.log | head -20
node _test/kill.js > /dev/null 2>&1; true
