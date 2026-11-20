#!/bin/sh
# Claimer runs only when its 3 variables are set. If it crashes it restarts by itself and the
# scraper is not touched. The scraper stays the main process (if it exits, Railway restarts both).
if [ -n "$BOT_TOKEN" ] && [ -n "$API_ID" ] && [ -n "$API_HASH" ]; then
  (
    cd /srv/claimer || exit 1
    while true; do
      /opt/py/bin/python -m app.main
      echo "[claimer] stopped, restarting in 5s"
      sleep 5
    done
  ) &
else
  echo "[claimer] BOT_TOKEN/API_ID/API_HASH not set, claimer is off"
fi
exec node index.js
