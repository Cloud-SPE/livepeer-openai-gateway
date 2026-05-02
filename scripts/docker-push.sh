#!/usr/bin/env bash
# Push the registry-tagged bridge image. Same arg-resolution as docker-tag.sh:
#   1. First positional arg
#   2. $BRIDGE_VERSION env
#   3. Default: 3.0.2
#
# Repo defaults to tztcloud/livepeer-openai-gateway; override via $BRIDGE_IMAGE_REPO.
# Operator must be logged in to the registry (`docker login`) before running.

set -euo pipefail

REPO="${BRIDGE_IMAGE_REPO:-tztcloud/livepeer-openai-gateway}"
VERSION="${1:-${BRIDGE_VERSION:-3.0.2}}"
TARGET="${REPO}:${VERSION}"

if ! docker image inspect "${TARGET}" >/dev/null 2>&1; then
  echo "error: ${TARGET} not found locally." >&2
  echo "       Run \`npm run docker:tag\` (after \`npm run docker:build\`) first." >&2
  exit 1
fi

docker push "${TARGET}"
echo "pushed: ${TARGET}"
