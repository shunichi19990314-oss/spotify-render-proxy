#!/bin/bash
node _test/kill.js > /dev/null 2>&1; sleep 1; rm -f /tmp/*.log
node _test/echo.js > /tmp/echo.log 2>&1 &
(cd server && PORT=18080 PROXY_TOKEN=goodtoken-abcdef123456 node index.js) > /tmp/server.log 2>&1 &
sleep 2
timeout 60 node _test/auth.js
echo; echo "=== server log ==="; cat /tmp/server.log
node _test/kill.js > /dev/null 2>&1; true
