#!/bin/bash
set -e

if [ -z "$GITHUB_URL" ] || [ -z "$GITHUB_TOKEN" ]; then
  echo "You must set GITHUB_URL and GITHUB_TOKEN"
  exit 1
fi

cd /home/runner

# Register runner
./config.sh \
  --url "$GITHUB_URL" \
  --token "$GITHUB_TOKEN" \
  --unattended \
  --ephemeral \
  --unattended \
  --name "$(hostname)-$(date +%s)" \
  --work _work

# Run one job, then exit
exec ./run.sh --disableupdate

