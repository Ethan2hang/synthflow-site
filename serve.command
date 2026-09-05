#!/bin/bash
# Double-click on macOS: serves this folder and opens the site in your browser.
cd "$(dirname "$0")"
PORT=4400
( sleep 1; open "http://localhost:$PORT" ) &
echo "SynthFlow site → http://localhost:$PORT  (close this window to stop)"
python3 -m http.server $PORT --bind 127.0.0.1
