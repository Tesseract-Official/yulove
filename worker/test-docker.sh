#!/usr/bin/env bash
# Builds the worker image and runs the whole test suite inside it, in a container locked down the
# way the worker is meant to run: read-only root filesystem, a writable volume only for /work, and
# only the capabilities the worker needs. Fake AWS credentials are set in the worker's own
# environment to prove that student programs never see them.
set -euo pipefail

cd "$(dirname "$0")"

IMAGE="${WORKER_IMAGE:-yulove-worker}"
docker build --tag "$IMAGE" .

docker run --rm \
  --read-only \
  --tmpfs /work:rw,exec,mode=755,size=1g \
  --cap-drop=ALL \
  --cap-add=CHOWN --cap-add=SETUID --cap-add=SETGID --cap-add=KILL \
  --cap-add=DAC_OVERRIDE --cap-add=FOWNER \
  --pids-limit=2048 \
  --memory=4g \
  --cpus=4 \
  --env AWS_ACCESS_KEY_ID=AKIAFAKEFAKEFAKEFAKE \
  --env AWS_SECRET_ACCESS_KEY=fake-secret-that-programs-must-never-see \
  --env AWS_SESSION_TOKEN=fake-session-token \
  --env AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/v2/credentials/fake \
  --env TMPDIR=/work/.tmp \
  --env VITEST_CACHE_DIR=/work/.vite \
  --env XDG_DATA_HOME=/work/.xdg \
  "$IMAGE" \
  sh -c 'mkdir -p /work/.tmp /work/.vite /work/.xdg && npx vitest run --configLoader runner "$@"' sh "$@"
