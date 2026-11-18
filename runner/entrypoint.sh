#!/bin/bash
set -e

if [ -z "$GITHUB_URL" ] || [ -z "$GITHUB_TOKEN" ]; then
  echo "You must set GITHUB_URL and GITHUB_TOKEN"
  exit 1
fi

cd /home/runner

# Register runner. GITHUB_URL is the org, so the runner joins one of its runner groups
# (RUNNER_GROUP, or the org's "Default" group if unset).
GROUP_ARGS=()
if [ -n "${RUNNER_GROUP:-}" ]; then
  GROUP_ARGS=(--runnergroup "$RUNNER_GROUP")
fi

./config.sh \
  --url "$GITHUB_URL" \
  --token "$GITHUB_TOKEN" \
  --ephemeral \
  --unattended \
  --name "$(hostname)-$(date +%s)" \
  --work _work \
  "${GROUP_ARGS[@]}"

# The registration token must not be visible to job code (it could register
# rogue runners for up to an hour), so drop it before the runner starts.
unset GITHUB_TOKEN

# Run one job, then exit
exec ./run.sh --disableupdate

