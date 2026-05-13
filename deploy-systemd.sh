#!/usr/bin/env bash
set -euo pipefail

APP_DIR_DEFAULT="/home/hxp/code/tools/claudecodeui"
SERVICE_NAME_DEFAULT="cloudcli"
PORT_DEFAULT="8250"
DATA_DIR_DEFAULT="/var/lib/cloudcli"

APP_DIR="${APP_DIR:-$APP_DIR_DEFAULT}"
SERVICE_NAME="${SERVICE_NAME:-$SERVICE_NAME_DEFAULT}"
PORT="${PORT:-$PORT_DEFAULT}"
PLATFORM_MODE="${PLATFORM_MODE:-false}"
DATA_DIR="${DATA_DIR:-$DATA_DIR_DEFAULT}"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Please run as root: sudo $0" >&2
  exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "APP_DIR not found: $APP_DIR" >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "$NODE_BIN" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi

UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
EXEC_START="${NODE_BIN} ${APP_DIR}/dist-server/server/index.js"

DEFAULT_LEGACY_DB="/home/hxp/.cloudcli/auth.db"
DEFAULT_SYSTEM_DB="${DATA_DIR}/auth.db"
DATABASE_PATH="${DATABASE_PATH:-}"
if [[ -z "$DATABASE_PATH" ]]; then
  DATABASE_PATH="$DEFAULT_SYSTEM_DB"
fi

mkdir -p "$DATA_DIR"

echo "[1/5] Skip build step (manual build expected)"
echo "Tip: run 'npm ci && npm run build' as a normal user in $APP_DIR before starting the service."

echo "[2/5] Write systemd unit: $UNIT_PATH"
cat > "$UNIT_PATH" <<EOF
[Unit]
Description=CloudCLI Web UI (${SERVICE_NAME})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=SERVER_PORT=${PORT}
Environment=VITE_IS_PLATFORM=${PLATFORM_MODE}
Environment=DATABASE_PATH=${DATABASE_PATH}
ExecStart=${EXEC_START}
Restart=on-failure
RestartSec=2
KillSignal=SIGINT
TimeoutStopSec=15
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

echo "[3/5] Reload systemd"
systemctl daemon-reload

echo "[4/5] Enable service on boot"
systemctl enable "${SERVICE_NAME}.service"

echo "[5/5] Restart service"
systemctl restart "${SERVICE_NAME}.service"
