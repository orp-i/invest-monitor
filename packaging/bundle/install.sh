#!/usr/bin/env sh
# Installs an extracted invest-monitor bundle into a permanent location and sets up its writable
# data/secrets directories. Run this from inside the extracted bundle (next to start.sh):
#   ./install.sh [install-dir] [--systemd]
# Default install-dir: $XDG_DATA_HOME/invest-monitor, or ~/.local/share/invest-monitor.
# Re-running install.sh (e.g. after extracting a newer bundle) refreshes the application code in place and
# leaves an existing install's data/, secrets/ and .env untouched.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE="$SCRIPT_DIR"

TARGET=""
WANT_SYSTEMD=0
for arg in "$@"; do
  case "$arg" in
    --systemd) WANT_SYSTEMD=1 ;;
    -h|--help)
      echo "Usage: $0 [install-dir] [--systemd]"
      exit 0
      ;;
    *) TARGET="$arg" ;;
  esac
done
: "${TARGET:=${XDG_DATA_HOME:-$HOME/.local/share}/invest-monitor}"
mkdir -p "$TARGET"
TARGET=$(CDPATH= cd -- "$TARGET" && pwd)

if [ "$SOURCE" = "$TARGET" ]; then
  echo "invest-monitor: already running from $TARGET; skipping copy" >&2
else
  echo "invest-monitor: installing into $TARGET" >&2
  # Only ever touch these known bundle entries — an existing install's data/, secrets/ and .env are never
  # in this list, so re-running install.sh upgrades the application code without disturbing user data.
  for entry in node node_modules apps packages config scripts package.json start.sh start.cmd install.sh README.txt .env.example; do
    [ -e "$SOURCE/$entry" ] || continue
    rm -rf "${TARGET:?}/$entry"
    cp -R "$SOURCE/$entry" "$TARGET/$entry"
  done
fi

mkdir -p "$TARGET/data/market-hot" "$TARGET/data/market-archive" "$TARGET/data/logs" "$TARGET/secrets"
chmod +x "$TARGET/start.sh" "$TARGET/install.sh" 2>/dev/null || true

TOKEN_FILE="$TARGET/secrets/ui_auth_token"
if [ ! -s "$TOKEN_FILE" ]; then
  NODE_BIN="$TARGET/node/bin/node"
  if [ ! -x "$NODE_BIN" ]; then NODE_BIN=$(command -v node 2>/dev/null || true); fi
  if [ -n "$NODE_BIN" ]; then
    "$NODE_BIN" -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))" > "$TOKEN_FILE"
  else
    # No Node available at install time (e.g. a --skip-node build with no system node yet): fall back to
    # /dev/urandom, widely available on Linux/macOS, for the same 48 hex characters (24 random bytes).
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$TOKEN_FILE"
  fi
  chmod 600 "$TOKEN_FILE" 2>/dev/null || true
  echo "invest-monitor: generated $TOKEN_FILE" >&2
fi

if [ ! -f "$TARGET/.env" ] && [ -f "$TARGET/.env.example" ]; then
  cp "$TARGET/.env.example" "$TARGET/.env"
  echo "invest-monitor: created $TARGET/.env from the example - edit it to add broker/LLM keys (or set them later from Settings / 账号设置 in the web UI)" >&2
fi

if [ "$WANT_SYSTEMD" = "1" ]; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/invest-monitor.service" <<EOF_UNIT
[Unit]
Description=invest-monitor (portfolio review tool)
After=network-online.target

[Service]
Type=simple
ExecStart=$TARGET/start.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF_UNIT
  echo "invest-monitor: wrote $UNIT_DIR/invest-monitor.service" >&2
  echo "invest-monitor: enable it with: systemctl --user enable --now invest-monitor" >&2
fi

echo "" >&2
echo "invest-monitor installed at $TARGET" >&2
echo "Start it with:  $TARGET/start.sh" >&2
echo "Then open:      http://127.0.0.1:8080  (default; override API_BIND_HOST/API_PORT in $TARGET/.env)" >&2
echo "Default login password is 123456 - change it from the web UI immediately after the first login." >&2
