#!/usr/bin/env bash
# Makes sure NemoClaw's Ollama authentication proxy (port 11435) is running, and starts it when it is not.
# Sandboxes reach Ollama only through this proxy. It stops when Windows or WSL restarts, and then every sandbox
# inference request fails with HTTP 502. NemoClaw's own `connect` does not always restart it.
#
# It starts NemoClaw's own proxy script with the token NemoClaw already stored. It never prints, copies or changes
# the token, and it changes nothing when the proxy already answers. Output is one line:
#   running    the proxy already answered
#   started    the proxy was down and is running now
# Exit status 0 on success, 1 when it could not be started (the line says why).
# Run it from Windows with:  wsl.exe -d Ubuntu-24.04 -- bash -s < ensure-ollama-proxy.sh
set -u

state="$HOME/.nemoclaw"
port="$(cat "$state/ollama-proxy-port" 2>/dev/null || echo 11435)"
port="${port//[^0-9]/}"
[ -n "$port" ] || port=11435

# The proxy rejects an unauthenticated request with 401: that proves our proxy, and not any other service, owns the port.
answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$port/v1/models" 2>/dev/null)" = "401" ]; }

if answers; then echo "running"; exit 0; fi

if [ ! -s "$state/ollama-proxy-token" ]; then echo "not an Ollama setup: no proxy token in $state"; exit 0; fi

script="$state/source/scripts/ollama-auth-proxy.mts"
[ -f "$script" ] || { echo "NemoClaw proxy script not found: $script"; exit 1; }

node_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -n 1)/node"
[ -x "$node_bin" ] || node_bin="$(command -v node 2>/dev/null || true)"
[ -n "$node_bin" ] && [ -x "$node_bin" ] || { echo "Node.js was not found in Ubuntu"; exit 1; }

backend="$(cat "$state/ollama-backend" 2>/dev/null || echo http://127.0.0.1:11434)"
backend_port="$(printf '%s' "$backend" | sed -E 's#.*:([0-9]+).*#\1#')"
[ -n "$backend_port" ] || backend_port=11434

# Something else on the port would make the start fail: say so rather than killing it.
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$port$"; then
  echo "port $port is held by a process that is not the Ollama proxy"; exit 1
fi

# The token travels only in the environment of the new process.
log="${TMPDIR:-/tmp}/ollama-auth-proxy.log"
OLLAMA_PROXY_TOKEN="$(cat "$state/ollama-proxy-token")" OLLAMA_PROXY_PORT="$port" \
  OLLAMA_BACKEND_PORT="$backend_port" OLLAMA_BACKEND_URL="$backend" \
  setsid nohup "$node_bin" --no-warnings "$script" > "$log" 2>&1 < /dev/null &
pid=$!

for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if answers; then printf '%s' "$pid" > "$state/ollama-auth-proxy.pid"; echo "started"; exit 0; fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
echo "the Ollama proxy did not answer on port $port: $(tail -c 200 "$log" 2>/dev/null | tr '\n' ' ')"
exit 1
# end of script
