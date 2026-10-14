#!/bin/bash
# 本番 (Render) デプロイの検証
#   BASE=<アプリ名>.onrender.com  TK=<PROXY_TOKEN>  bash _test/run6.sh
: "${BASE:?BASE に <アプリ名>.onrender.com を指定してください}"
: "${TK:?TK に PROXY_TOKEN を指定してください}"
cd "$(dirname "$0")/.." || exit 1
[ -d _test/node_modules/ws ] || (cd _test && npm install --no-audit --no-fund >/dev/null 2>&1)
echo "########## モードC: Web Player リバースプロキシ ##########"
BASE="$BASE" TK="$TK" timeout 400 node _test/live.js
echo
echo "########## モードA: WS トンネル (wss://<host>/tunnel 直接) ##########"
BASE="$BASE" TK="$TK" timeout 300 node _test/livews.js
echo
echo "########## モードA: ローカル client 経由 (要: client を起動しておく) ##########"
if [ "${SKIP_CLIENT:-0}" != "1" ]; then
  [ -d client/node_modules/ws ] || (cd client && npm install --no-audit --no-fund >/dev/null 2>&1)
  (cd client && RENDER_URL="https://$BASE" PROXY_TOKEN="$TK" \
     LOCAL_HTTP_PORT="${PPORT:-18888}" LOCAL_SOCKS_PORT="${SPORT:-1080}" node index.js) > /tmp/live-client.log 2>&1 &
  CPID=$!
  sleep 6
  PHOST=127.0.0.1 PPORT="${PPORT:-18888}" SPORT="${SPORT:-1080}" timeout 300 node _test/liveclient.js
  RC=$?
  kill $CPID 2>/dev/null
  echo "--- client ログ (エラーのみ) ---"; grep -iE "error|fail|refus" /tmp/live-client.log | head -5
  exit $RC
else
  echo "(SKIP_CLIENT=1 のためスキップ)"
fi
