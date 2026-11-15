#!/bin/bash
# Rebuilds the runner image against the latest GitHub runner release, smoke tests it, and only then replaces p5-ci-runner:latest.
# Safe to run while jobs are running: the next job uses the new image.
# Run by setup.sh, and weekly by the p5-ci-image-update timer if installed with --daemon.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANDIDATE=p5-ci-runner:candidate

RELEASE="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)"
VERSION="$(echo "$RELEASE" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)"
SHA256="$(echo "$RELEASE" | sed -n 's/.*BEGIN SHA linux-x64 -->\([0-9a-f]\{64\}\)<!-- END SHA linux-x64.*/\1/p' | head -1)"

if [ -z "$VERSION" ] || [ -z "$SHA256" ]; then
  echo "Could not determine the latest runner version/checksum from GitHub" >&2
  exit 1
fi

echo "Building runner image with actions/runner $VERSION"
docker build --pull --no-cache \
  --build-arg RUNNER_VERSION="$VERSION" \
  --build-arg RUNNER_SHA256="$SHA256" \
  -t "$CANDIDATE" "$ROOT/runner"

echo "Smoke testing"
docker run --rm --entrypoint bash "$CANDIDATE" -c './bin/Runner.Listener --version && google-chrome --version && node --version'

docker tag "$CANDIDATE" p5-ci-runner:latest
docker rmi "$CANDIDATE" >/dev/null
echo "p5-ci-runner:latest is now actions/runner $VERSION"
