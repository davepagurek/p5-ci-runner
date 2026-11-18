#!/bin/bash
# Sets up everything the orchestrator needs on this machine. Safe to re-run.
#
#   sudo ./setup.sh [--nvidia] [--daemon [--runner-group NAME] [--reconfigure]] [--recreate-network] [--force]
#
#   --nvidia            install/configure the NVIDIA container toolkit (for GPU_MODE=nvidia)
#   --daemon            also run the orchestrator at startup (systemd) and rebuild the runner image weekly
#   --runner-group NAME with --daemon: register runners into this runner group instead of the org's Default group
#   --reconfigure       with --daemon: re-prompt for the org and GitHub App instead of reusing the saved ones
#   --recreate-network  remove and recreate the internal runner network
#   --force             proceed even if runner containers are currently running (kills them)
set -euo pipefail

NET=p5-ci-internal
PROXY=p5-ci-proxy
SERVICE=p5-ci-orchestrator
UPDATE_SERVICE=p5-ci-image-update
ENV_FILE=/etc/p5-ci-orchestrator.env
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NVIDIA=0
DAEMON=0
RECONFIGURE=0
RECREATE=0
FORCE=0
RUNNER_GROUP_FLAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --nvidia) NVIDIA=1 ;;
    --daemon) DAEMON=1 ;;
    --runner-group)
      [ $# -ge 2 ] || { echo "--runner-group needs a name" >&2; exit 1; }
      RUNNER_GROUP_FLAG="$2"; shift ;;
    --reconfigure) RECONFIGURE=1 ;;
    --recreate-network) RECREATE=1 ;;
    --force) FORCE=1 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done
if [ -n "$RUNNER_GROUP_FLAG" ] && [ "$DAEMON" -ne 1 ]; then
  echo "--runner-group only applies with --daemon (otherwise set RUNNER_GROUP when running the orchestrator)." >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0 $*" >&2
  exit 1
fi
OPERATOR="${SUDO_USER:-root}"

if [ "$DAEMON" -eq 1 ]; then
  NODE="$(command -v node || true)"
  if [ -z "$NODE" ] || [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
    echo "--daemon needs Node.js 18 or newer on the host (found: ${NODE:-none})." >&2
    exit 1
  fi
fi

# --- Docker ------------------------------------------------------------------
if ! command -v docker >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
fi

groupadd docker 2>/dev/null || true
if [ "$OPERATOR" != "root" ] && ! id -nG "$OPERATOR" | grep -qw docker; then
  usermod -aG docker "$OPERATOR"
  echo "Added $OPERATOR to the docker group (log out and back in for it to apply)."
fi

# --- NVIDIA ------------------------------------------------------------------
if [ "$NVIDIA" -eq 1 ]; then
  if ! command -v nvidia-smi >/dev/null; then
    echo "--nvidia given but nvidia-smi not found; install the NVIDIA driver first." >&2
    exit 1
  fi
  if ! command -v nvidia-ctk >/dev/null; then
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      > /etc/apt/sources.list.d/nvidia-container-toolkit.list
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y nvidia-container-toolkit
  fi
  nvidia-ctk runtime configure --runtime=docker
  systemctl restart docker
fi

# --- Don't clobber running jobs ---------------------------------------------
if docker network inspect "$NET" >/dev/null 2>&1; then
  RUNNERS="$(docker ps -q --filter "network=$NET" | grep -v "^$(docker ps -q --filter "name=^${PROXY}$")$" || true)"
  if [ -n "$RUNNERS" ] && [ "$FORCE" -ne 1 ]; then
    echo "Runner containers are using $NET. Wait for them to finish or pass --force." >&2
    exit 1
  fi
fi

HAVE_SERVICE=0
if systemctl list-unit-files "$SERVICE.service" 2>/dev/null | grep -q "$SERVICE"; then
  HAVE_SERVICE=1
  systemctl stop "$SERVICE"
fi

# --- Build images ------------------------------------------------------------
"$ROOT/update-image.sh"
docker build -t p5-ci-proxy "$ROOT/proxy"

# --- Network -----------------------------------------------------------------
docker ps -aq --filter "network=$NET" | xargs -r docker rm -f
if [ "$RECREATE" -eq 1 ]; then
  docker network rm "$NET" 2>/dev/null || true
fi
# --internal: containers on it have no route out except via other containers on it.
docker network inspect "$NET" >/dev/null 2>&1 || docker network create --internal "$NET"

# --- Proxy -------------------------------------------------------------------
docker rm -f "$PROXY" 2>/dev/null || true
# Starts on the default bridge (egress), then also joins the internal network.
docker run -d --name "$PROXY" --restart unless-stopped \
  --cap-drop=ALL --cap-add=SETUID --cap-add=SETGID \
  --security-opt no-new-privileges \
  "$PROXY"
docker network connect --alias proxy "$NET" "$PROXY"

# --- Daemon (optional) -------------------------------------------------------
if [ "$DAEMON" -eq 1 ]; then
  OWNER=""; RUNNER_GROUP=""; APP_CLIENT_ID=""; APP_PRIVATE_KEY_PATH=""
  if [ -f "$ENV_FILE" ] && [ "$RECONFIGURE" -ne 1 ]; then . "$ENV_FILE"; fi
  if [ -z "$OWNER" ]; then read -rp "GitHub organization (e.g. processing): " OWNER; fi
  if [ -n "$RUNNER_GROUP_FLAG" ]; then RUNNER_GROUP="$RUNNER_GROUP_FLAG"; fi
  if [ -z "$APP_CLIENT_ID" ]; then
    read -rp "GitHub App client ID: " APP_CLIENT_ID
    read -rp "Full path to the app's private key (.pem): " KEY_SRC
    KEY_SRC="${KEY_SRC/#\~/$(getent passwd "$OPERATOR" | cut -d: -f6)}"
    # The orchestrator (running as $OPERATOR) reads this itself, unlike the env file which systemd reads as root
    APP_PRIVATE_KEY_PATH=/etc/p5-ci-orchestrator.pem
    install -m 600 -o "$OPERATOR" "$KEY_SRC" "$APP_PRIVATE_KEY_PATH"
  fi

  GPU_MODE=dri
  [ "$NVIDIA" -eq 1 ] && GPU_MODE=nvidia
  install -m 600 /dev/null "$ENV_FILE"
  {
    printf 'GPU_MODE=%s\nOWNER=%s\nAPP_CLIENT_ID=%s\nAPP_PRIVATE_KEY_PATH=%s\n' \
      "$GPU_MODE" "$OWNER" "$APP_CLIENT_ID" "$APP_PRIVATE_KEY_PATH"
    # Quoted since group names can contain spaces (systemd and the shell both accept this)
    [ -n "$RUNNER_GROUP" ] && printf 'RUNNER_GROUP="%s"\n' "$RUNNER_GROUP"
    true
  } > "$ENV_FILE"

  cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=p5 CI runner orchestrator
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
User=$OPERATOR
WorkingDirectory=$ROOT/orchestrator
EnvironmentFile=$ENV_FILE
ExecStart=$NODE server.mjs
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF

  cat > "/etc/systemd/system/$UPDATE_SERVICE.service" <<EOF
[Unit]
Description=Rebuild the p5 CI runner image
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$ROOT/update-image.sh
EOF

  cat > "/etc/systemd/system/$UPDATE_SERVICE.timer" <<EOF
[Unit]
Description=Weekly rebuild of the p5 CI runner image

[Timer]
OnCalendar=weekly
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE.service" "$UPDATE_SERVICE.timer"
  systemctl restart "$SERVICE.service"
  systemctl start "$UPDATE_SERVICE.timer"
elif [ "$HAVE_SERVICE" -eq 1 ]; then
  systemctl start "$SERVICE"
fi

echo
echo "Setup complete."
echo "  Network: $NET (internal)    Proxy: $PROXY (alias: proxy, port 3128)"
if [ "$DAEMON" -eq 1 ]; then
  echo "  Orchestrator service: $SERVICE (logs: journalctl -u $SERVICE -f)"
  echo "  Weekly image rebuild: $UPDATE_SERVICE.timer"
else
  echo "  Run the orchestrator with GPU_MODE=$([ "$NVIDIA" -eq 1 ] && echo nvidia || echo dri)"
fi
