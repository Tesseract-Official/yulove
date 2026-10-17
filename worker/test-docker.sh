#!/usr/bin/env bash
# Builds the worker image and tests it the way it runs in production (the Fargate task in
# infra/src/stacks/worker-stack.ts):
#
#   - platform linux/amd64
#   - read-only root filesystem
#   - a disk-backed volume at /work (Fargate's ephemeral storage), not a RAM disk
#   - the default Linux capabilities (the worker needs setuid, setgid and kill)
#   - 4 vCPU and 8 GB
#
# 1. runs the whole test suite in the `test` image (production plus Vitest);
# 2. starts the `production` image against unreachable queues, sends it SIGTERM and checks that
#    it drains and exits 0.
#
# Fake AWS credentials are put in the worker's own environment to prove that student programs
# never see them. --pids-limit is not part of the Fargate task; it only protects this machine in
# case a fork bomb test were ever to get out of hand.
set -euo pipefail

cd "$(dirname "$0")"

PLATFORM=linux/amd64
TEST_IMAGE="${WORKER_TEST_IMAGE:-yulove-worker-test}"
PROD_IMAGE="${WORKER_IMAGE:-yulove-worker}"

docker build --platform "$PLATFORM" --target test --tag "$TEST_IMAGE" .
docker build --platform "$PLATFORM" --target production --tag "$PROD_IMAGE" .

FARGATE_LIKE=(
  --platform "$PLATFORM"
  --read-only
  --volume /work
  --memory=8g
  --cpus=4
  --pids-limit=2048
)

echo "== tests, in the test image =="
docker run --rm "${FARGATE_LIKE[@]}" \
  --env AWS_ACCESS_KEY_ID=AKIAFAKEFAKEFAKEFAKE \
  --env AWS_SECRET_ACCESS_KEY=fake-secret-that-programs-must-never-see \
  --env AWS_SESSION_TOKEN=fake-session-token \
  --env AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/v2/credentials/fake \
  --env TMPDIR=/work/.tmp \
  --env VITEST_CACHE_DIR=/work/.vite \
  --env XDG_DATA_HOME=/work/.xdg \
  "$TEST_IMAGE" \
  sh -c 'mkdir -p /work/.tmp /work/.vite /work/.xdg && npx vitest run --configLoader runner "$@"' sh "$@"

echo "== SIGTERM, in the production image =="
NAME="yulove-worker-smoke-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

docker run --detach --name "$NAME" "${FARGATE_LIKE[@]}" \
  --env EXECUTE_QUEUE_URL=http://127.0.0.1:9/execute.fifo \
  --env RESULTS_QUEUE_URL=http://127.0.0.1:9/results.fifo \
  --env BUCKET_NAME=smoke-test \
  --env WORKER_CONCURRENCY=2 \
  --env AWS_REGION=ap-south-1 \
  --env AWS_ACCESS_KEY_ID=fake \
  --env AWS_SECRET_ACCESS_KEY=fake \
  "$PROD_IMAGE" >/dev/null

# Matching on a captured string, not with `grep -q` at the end of a pipe: grep stopping early would
# make `docker logs` fail with SIGPIPE, and pipefail would turn that into a false error.
contains() { [[ "$1" == *"$2"* ]]; }

LOGS=""
for _ in $(seq 1 40); do
  LOGS=$(docker logs "$NAME" 2>&1 || true)
  if contains "$LOGS" '"event":"started"'; then break; fi
  sleep 0.5
done
contains "$LOGS" '"event":"started"' || { echo "The worker did not start:"; echo "$LOGS"; exit 1; }

STARTED=$(date +%s)
docker stop --time 20 "$NAME" >/dev/null # SIGTERM, then SIGKILL after 20 s
ELAPSED=$(( $(date +%s) - STARTED ))
EXIT_CODE=$(docker inspect --format '{{.State.ExitCode}}' "$NAME")

LOGS=$(docker logs "$NAME" 2>&1 || true)
echo "$LOGS"

[ "$EXIT_CODE" = "0" ] || { echo "Expected exit code 0 after SIGTERM, got $EXIT_CODE"; exit 1; }
[ "$ELAPSED" -lt 15 ] || { echo "Shutdown took ${ELAPSED}s: it did not stop promptly"; exit 1; }
contains "$LOGS" '"event":"signal"' || { echo "No signal event was logged"; exit 1; }
contains "$LOGS" '"event":"stopped"' || { echo "The worker did not report a clean stop"; exit 1; }
echo "SIGTERM: drained and exited 0 in ${ELAPSED}s"
