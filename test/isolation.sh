#!/bin/bash
# Integration tests for the network sandbox. Builds a throwaway copy of the real
# proxy + internal network (separate names, so it won't touch a live setup),
# then checks what a container on that network can and can't reach.
# Needs Docker and internet access. Works on Linux and Docker Desktop.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NET=p5-ci-test-internal
PROXY=p5-ci-test-proxy
CLIENT_IMAGE=curlimages/curl:8.10.1
PX=http://proxy:3128
PASS=0; FAIL=0

cleanup() {
  docker rm -f "$PROXY" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup

docker build -q -t p5-ci-test-proxy "$ROOT/proxy" >/dev/null || { echo "proxy build failed"; exit 1; }
docker network create --internal "$NET" >/dev/null || exit 1
docker run -d --name "$PROXY" --cap-drop=ALL --cap-add=SETUID --cap-add=SETGID \
  --security-opt no-new-privileges p5-ci-test-proxy >/dev/null || exit 1
docker network connect --alias proxy "$NET" "$PROXY"
sleep 3
docker pull -q "$CLIENT_IMAGE" >/dev/null

# Runs curl in a container hardened like the real runner; echoes curl's exit code.
run_curl() {
  docker run --rm --network "$NET" --cap-drop=ALL --security-opt no-new-privileges \
    --entrypoint curl "$CLIENT_IMAGE" -sf -o /dev/null --max-time 15 "$@" >/dev/null 2>&1
  echo $?
}
expect_ok()   { local name=$1; shift; local rc; rc=$(run_curl "$@"); check "$name" "$([ "$rc" = 0 ] && echo 1 || echo 0)" "exit $rc"; }
expect_fail() { local name=$1; shift; local rc; rc=$(run_curl "$@"); check "$name" "$([ "$rc" != 0 ] && echo 1 || echo 0)" "exit $rc"; }
check() {
  if [ "$2" = 1 ]; then PASS=$((PASS+1)); echo "ok   - $1"
  else FAIL=$((FAIL+1)); echo "FAIL - $1 ($3)"; fi
}

echo "-- no direct route out"
expect_fail "direct internet blocked (hostname)"   --noproxy '*' https://example.com
expect_fail "direct internet blocked (IP)"         --noproxy '*' https://1.1.1.1
expect_fail "cloud metadata IP unreachable"        --noproxy '*' http://169.254.169.254
expect_fail "host.docker.internal unreachable"     --noproxy '*' http://host.docker.internal

echo "-- proxy allowlist"
expect_ok   "allowed host works through proxy"     -x $PX https://github.com
expect_ok   "allowed subdomain works"              -x $PX https://api.github.com
expect_fail "lookalike domain blocked"             -x $PX https://evilgithub.com
expect_fail "unlisted domain blocked"              -x $PX https://example.com
expect_fail "metadata IP blocked via proxy"        -x $PX https://169.254.169.254
expect_fail "private IP blocked via proxy"         -x $PX https://192.168.1.1
expect_fail "loopback blocked via proxy"           -x $PX https://127.0.0.1
expect_fail "non-443 port blocked"                 -x $PX --proxytunnel http://github.com:8080
expect_fail "plain HTTP through proxy blocked"     -x $PX http://github.com

echo "-- container hardening"
caps=$(docker run --rm --cap-drop=ALL --security-opt no-new-privileges --network none --entrypoint sh "$CLIENT_IMAGE" -c 'grep CapEff /proc/self/status' 2>/dev/null)
check "all capabilities dropped" "$([[ "$caps" == *0000000000000000 ]] && echo 1 || echo 0)" "$caps"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
