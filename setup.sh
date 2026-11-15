#!/bin/bash
# Sets up everything the orchestrator needs on this machine. Safe to re-run.
#
#   sudo ./setup.sh [--nvidia] [--recreate-network] [--force]
#
#   --nvidia            install/configure the NVIDIA container toolkit (for GPU_MODE=nvidia)
#   --recreate-network  remove and recreate the internal runner network
#   --force             proceed even if runner containers are currently running (kills them)
set -euo pipefail

NET=p5-ci-internal
PROXY=p5-ci-proxy
SERVICE=p5-ci-orchestrator
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NVIDIA=0
RECREATE=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --nvidia) NVIDIA=1 ;;
    --recreate-network) RECREATE=1 ;;
    --force) FORCE=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0 $*" >&2
  exit 1
fi
OPERATOR="${SUDO_USER:-root}"

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
docker build -t p5-ci-runner "$ROOT/runner"
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

if [ "$HAVE_SERVICE" -eq 1 ]; then
  systemctl start "$SERVICE"
fi

echo
echo "Setup complete."
echo "  Network: $NET (internal)    Proxy: $PROXY (alias: proxy, port 3128)"
echo "  Run the orchestrator with GPU_MODE=$([ "$NVIDIA" -eq 1 ] && echo nvidia || echo dri)"
