#!/bin/bash
# Web Player リバースプロキシの検証
node _test/kill.js > /dev/null 2>&1; sleep 1; rm -f /tmp/wp*.log
node _test/echo.js > /tmp/wp-echo.log 2>&1 &
(cd server && PORT=18080 PROXY_TOKEN=goodtoken-abcdef123456 VERBOSE=1 node index.js) > /tmp/wp-server.log 2>&1 &
sleep 2
WPORT=18080 WTOKEN=goodtoken-abcdef123456 timeout 170 node _test/webplayer.js
echo; echo "=== server log (末尾40行) ==="; tail -40 /tmp/wp-server.log
node _test/kill.js > /dev/null 2>&1; true
