#!/bin/sh
# Installs the Custom Claude Frontend node worker and pairs it with the orchestrator.
# Usage (from the Nodes view): curl -fsSL <url>/api/nodes/install.sh | sh -s -- <url> <pairing code>
set -eu

say() { printf '%s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1; }

main() {
  URL="${1:?orchestrator URL missing}"
  CODE="${2:?pairing code missing}"
  DIR="${CCF_NODE_HOME:-$HOME/.ccf-node}"

  [ "$(uname -s)" = Linux ] || say "Note: nodes are only tested on Linux."

  if ! need git; then
    if need apt-get; then
      say "Installing git..."
      sudo apt-get update -qq && sudo apt-get install -y -qq git
    else
      say "Please install git, then run this again."; exit 1
    fi
  fi

  if ! need node || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
    if need apt-get; then
      say "Installing Node.js 22 from NodeSource..."
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y -qq nodejs
    else
      say "Please install Node.js 22.13 or newer (https://nodejs.org), then run this again."; exit 1
    fi
  fi

  mkdir -p "$DIR"
  cd "$DIR"
  for f in worker.mjs package.json post-hook.mjs; do
    curl -fsSL "$URL/api/nodes/worker/$f" -o "$f"
  done
  say "Installing the worker's dependencies (the Agent SDK and its Claude Code)..."
  npm install --omit=dev --no-audit --no-fund --loglevel=error

  node worker.mjs pair "$URL" "$CODE"

  if need systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/ccf-node.service" <<UNIT
[Unit]
Description=Custom Claude Frontend node worker
After=network-online.target

[Service]
ExecStart=$(command -v node) $DIR/worker.mjs run
Restart=always
RestartSec=5
Environment=PATH=$PATH
Environment=CCF_NODE_HOME=$DIR

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now ccf-node.service
    # Lets the user service start at boot, before anyone logs in.
    loginctl enable-linger "$(id -un)" 2>/dev/null || sudo loginctl enable-linger "$(id -un)" 2>/dev/null ||
      say "To start the worker at boot without logging in, run: sudo loginctl enable-linger $(id -un)"
    say "Done. The worker runs as the systemd user service ccf-node (logs: journalctl --user -u ccf-node -f)."
  else
    say "Done. systemd isn't available here, so start the worker yourself: node $DIR/worker.mjs run"
  fi
}

# Everything runs from main, so the whole script is read before any of it runs (it arrives through a pipe).
main "$@"
