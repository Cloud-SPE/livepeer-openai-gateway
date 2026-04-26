#!/usr/bin/env bash
# Re-tag the local docker:build output for a registry push.
#
# Resolves the target version with this priority:
#   1. First positional arg (e.g. `npm run docker:tag -- v0.8.11`)
#   2. $BRIDGE_VERSION env (e.g. `BRIDGE_VERSION=v0.8.11 npm run docker:tag`)
#   3. Default: v0.8.10
#
# The repo path defaults to `tztcloud/livepeer-openai-gateway` (matches
# compose.prod.yaml's BRIDGE_IMAGE default). Override with $BRIDGE_IMAGE_REPO.

set -euo pipefail

REPO="${BRIDGE_IMAGE_REPO:-tztcloud/livepeer-openai-gateway}"
VERSION="${1:-${BRIDGE_VERSION:-v0.8.10}}"

if ! docker image inspect openai-livepeer-bridge:local >/dev/null 2>&1; then
  echo "error: openai-livepeer-bridge:local not found locally." >&2
  echo "       Run \`npm run docker:build\` first." >&2
  exit 1
fi

TARGET="${REPO}:${VERSION}"
docker tag openai-livepeer-bridge:local "${TARGET}"
echo "tagged: ${TARGET}"
