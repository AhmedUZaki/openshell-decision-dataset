#!/usr/bin/env bash
set -Eeuo pipefail

# Every version and setting comes from pins.env (one file for the whole project).
PINS_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pins.env"
[[ -f "$PINS_FILE" ]] || { echo "pins.env not found at $PINS_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source <(tr -d '\r' < "$PINS_FILE")
set +a
SOURCE_DIR="$HOME/.nemoclaw/source"

log() { printf '\n[portable-setup] %s\n' "$*"; }
fail() { printf '\n[portable-setup] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -ne 0 ]] || fail "Run this script as the normal Ubuntu user, not root."
grep -q '^VERSION_ID="\?24\.04' /etc/os-release || fail "Ubuntu 24.04 is required."
command -v docker >/dev/null 2>&1 || fail "Docker Desktop WSL integration is not available."
docker info >/dev/null 2>&1 || fail "Docker Desktop is not reachable from Ubuntu."

log "Installing required Ubuntu packages"
sudo apt-get update
sudo apt-get install -y ca-certificates curl git jq zstd binutils

if ! command -v ollama >/dev/null 2>&1 || ! ollama --version 2>&1 | grep -q "$OLLAMA_VERSION"; then
  log "Installing Ollama $OLLAMA_VERSION"
  installer_file="$(mktemp)"
  trap 'rm -f "${installer_file:-}"' EXIT
  curl -fsSL https://ollama.com/install.sh -o "$installer_file"
  OLLAMA_VERSION="$OLLAMA_VERSION" sh "$installer_file"
fi

log "Configuring the Ollama system service"
sudo install -d -m 0755 /etc/systemd/system/ollama.service.d
printf '%s\n' '[Service]' "Environment=\"OLLAMA_CONTEXT_LENGTH=$CONTEXT_WINDOW\"" \
  | sudo tee /etc/systemd/system/ollama.service.d/context-window.conf >/dev/null
# Keep the model in GPU memory for an hour so opening a conversation does not wait for a cold load (about 40 s).
printf '%s\n' '[Service]' 'Environment="OLLAMA_KEEP_ALIVE=1h"' \
  | sudo tee /etc/systemd/system/ollama.service.d/keep-alive.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now ollama
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://127.0.0.1:11434/api/version >/dev/null \
  || fail "Ollama did not become ready."

log "Downloading the only configured model: $MODEL"
ollama pull "$MODEL"

log "Preparing the pinned NemoClaw source"
if [[ -d "$SOURCE_DIR/.git" ]]; then
  current_origin="$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true)"
  [[ "$current_origin" == "https://github.com/NVIDIA/NemoClaw.git" ]] \
    || fail "$SOURCE_DIR exists but is not the NVIDIA NemoClaw checkout."
else
  [[ ! -e "$SOURCE_DIR" ]] || fail "$SOURCE_DIR exists and is not a Git checkout."
  mkdir -p "$(dirname "$SOURCE_DIR")"
  git init -q "$SOURCE_DIR"
  git -C "$SOURCE_DIR" remote add origin https://github.com/NVIDIA/NemoClaw.git
fi
git -C "$SOURCE_DIR" fetch --depth 1 origin "$NEMOCLAW_BASE"
git -C "$SOURCE_DIR" checkout -q --detach FETCH_HEAD
git -C "$SOURCE_DIR" fetch --depth 1 origin "$NEMOCLAW_BACKPORT"
for file in \
  src/lib/onboard/compatible-endpoint-smoke.ts \
  src/lib/onboard/compatible-endpoint-smoke.test.ts \
  src/lib/onboard/__test-helpers__/compatible-endpoint-smoke-helpers.ts; do
  git -C "$SOURCE_DIR" checkout FETCH_HEAD -- "$file"
done
[[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" == "$NEMOCLAW_BASE" ]] \
  || fail "The NemoClaw base commit does not match the manifest."
printf '%s\n' "$NEMOCLAW_VERSION" > "$SOURCE_DIR/.version"

log "Installing the pinned NemoClaw CLI without onboarding"
export NEMOCLAW_DISABLE_TELEMETRY=1
export NEMOCLAW_AGENT=openclaw
export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_REPO_ROOT="$SOURCE_DIR"
bash "$SOURCE_DIR/scripts/install.sh" --non-interactive --defer-onboarding
export PATH="$HOME/.local/bin:$PATH"
command -v nemoclaw >/dev/null 2>&1 || fail "NemoClaw CLI installation failed."

if nemoclaw list --json 2>/dev/null | jq -e --arg name "$SANDBOX_NAME" \
  '.. | objects | select(.name? == $name)' >/dev/null; then
  log "Sandbox $SANDBOX_NAME already exists; it was preserved."
else
  log "Creating $SANDBOX_NAME with local Ollama and $MODEL"
  export NEMOCLAW_PROVIDER=ollama
  export NEMOCLAW_MODEL="$MODEL"
  export NEMOCLAW_YES=1
  export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
  export NEMOCLAW_POLICY_TIER="$POLICY_TIER"
  export NEMOCLAW_DASHBOARD_PORT="$DASHBOARD_PORT"
  export NEMOCLAW_CONTEXT_WINDOW="$CONTEXT_WINDOW"
  export NEMOCLAW_MAX_TOKENS="$MAX_TOKENS"
  export NEMOCLAW_SANDBOX_GPU=0
  nemoclaw onboard --fresh --name "$SANDBOX_NAME" --control-ui-port "$DASHBOARD_PORT" \
    --no-sandbox-gpu --non-interactive --yes --yes-i-accept-third-party-software
fi

for preset in ${POLICY_EXTRA_PRESETS//,/ }; do
  log "Applying the $preset preset to $SANDBOX_NAME"
  nemoclaw "$SANDBOX_NAME" policy add "$preset" --yes
done

log "Verifying the recreated stack"
nemoclaw "$SANDBOX_NAME" connect --probe-only
ollama list | grep -F "$MODEL" >/dev/null || fail "The configured model is missing."
log "Installation completed successfully. Return to Windows and run Start OpenClaw Workspace.cmd."
