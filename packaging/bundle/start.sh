#!/usr/bin/env sh
# Starts invest-monitor from a portable bundle (built by packaging/build-bundle.mjs). Run this script from
# anywhere; it locates the bundle root from its own path, so `./start.sh` and `/path/to/start.sh` both work.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR"

NODE_BIN="$ROOT/node/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  # The bundle can be built with --skip-node (CI/dev use); fall back to a system Node in that case.
  if command -v node >/dev/null 2>&1; then
    NODE_BIN=$(command -v node)
    echo "invest-monitor: no bundled Node runtime at $ROOT/node; using system node ($NODE_BIN)" >&2
  else
    echo "invest-monitor: no Node runtime found at $NODE_BIN and no system 'node' on PATH." >&2
    exit 1
  fi
fi

export NODE_ENV=production

# Sensible bundle-local defaults. Each only applies when the variable is not already set in the calling
# shell, so `API_PORT=9090 ./start.sh` (or exporting first) still overrides it; secrets below come only
# from the bundle's own .env, loaded further down. UI_AUTH_MODE stays fixed at "password" here, matching
# every other distribution mode (Docker hardcodes the same value) rather than being user-overridable.
: "${APP_CONFIG_PATH:=$ROOT/config/portfolio.yaml}"
: "${APP_CONFIG_EXAMPLE_PATH:=$ROOT/config/portfolio.example.yaml}"
: "${SQLITE_PATH:=$ROOT/data/invest.sqlite}"
: "${MARKET_HOT_PATH:=$ROOT/data/market-hot/market.sqlite}"
: "${MARKET_ARCHIVE_DIR:=$ROOT/data/market-archive}"
: "${LOG_DIR:=$ROOT/data/logs}"
UI_AUTH_MODE=password
: "${UI_AUTH_TOKEN_FILE:=$ROOT/secrets/ui_auth_token}"
: "${API_BIND_HOST:=127.0.0.1}"
: "${API_PORT:=8080}"
: "${WEB_DIST_DIR:=$ROOT/apps/web/dist}"
export APP_CONFIG_PATH APP_CONFIG_EXAMPLE_PATH SQLITE_PATH MARKET_HOT_PATH MARKET_ARCHIVE_DIR LOG_DIR \
  UI_AUTH_MODE UI_AUTH_TOKEN_FILE API_BIND_HOST API_PORT WEB_DIST_DIR

mkdir -p "$ROOT/data/market-hot" "$ROOT/data/market-archive" "$ROOT/data/logs" "$(dirname "$UI_AUTH_TOKEN_FILE")"

# UI_AUTH_MODE=password still requires UI_AUTH_TOKEN_FILE to be a readable, non-empty file at startup (the
# password itself is stored separately, in the database); create one on first run if it is missing or empty.
if [ ! -s "$UI_AUTH_TOKEN_FILE" ]; then
  "$NODE_BIN" -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))" > "$UI_AUTH_TOKEN_FILE"
  chmod 600 "$UI_AUTH_TOKEN_FILE" 2>/dev/null || true
  echo "invest-monitor: generated $UI_AUTH_TOKEN_FILE" >&2
fi

echo "invest-monitor: starting on http://${API_BIND_HOST}:${API_PORT} (data: $ROOT/data)" >&2
exec "$NODE_BIN" --env-file-if-exists="$ROOT/.env" "$ROOT/apps/server/dist/main.js"
