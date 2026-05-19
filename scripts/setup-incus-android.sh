#!/usr/bin/env bash
set -euo pipefail

# Import the cmux-sandbox-android Docker image into Incus.
#
# This mirrors scripts/setup-incus.sh but targets a separate image/alias so it
# does NOT disturb the existing `cmux-sandbox` image.
#
# Prerequisites:
#   - Incus already installed and initialised (run scripts/setup-incus.sh first)
#   - The base `cmux-sandbox` Docker image already built
#
# Usage:
#   docker build -t cmux-sandbox -f packages/sandbox/Dockerfile .          # base
#   docker build -t cmux-sandbox-android -f packages/sandbox/Dockerfile.android .
#   bash scripts/setup-incus-android.sh

DOCKER_IMAGE="${DOCKER_IMAGE:-cmux-sandbox-android:latest}"
IMAGE_ALIAS="${INCUS_ANDROID_IMAGE:-cmux-sandbox-android}"

if ! command -v incus &>/dev/null; then
  echo "Incus is not installed. Run scripts/setup-incus.sh first." >&2
  exit 1
fi

echo "=== Importing ${IMAGE_ALIAS} image into Incus ==="

import_docker_image() {
  # Incus 6.x requires separate metadata + rootfs tarballs.
  echo "Exporting Docker image ${DOCKER_IMAGE} → Incus..."

  TMPDIR_IMG=$(mktemp -d)
  trap 'rm -rf "$TMPDIR_IMG"' EXIT

  # Create a throwaway container to export its rootfs.
  CID=$(docker create "$DOCKER_IMAGE")
  docker export "$CID" > "$TMPDIR_IMG/rootfs.tar"
  docker rm "$CID" > /dev/null

  cat > "$TMPDIR_IMG/metadata.yaml" << EOF
architecture: x86_64
creation_date: $(date +%s)
properties:
  description: cmux sandbox android emulator image
  os: ubuntu
  release: noble
EOF
  tar czf "$TMPDIR_IMG/metadata.tar.gz" -C "$TMPDIR_IMG" metadata.yaml

  incus image import "$TMPDIR_IMG/metadata.tar.gz" "$TMPDIR_IMG/rootfs.tar" --alias "$IMAGE_ALIAS"
  echo "Imported '$IMAGE_ALIAS' from Docker."
}

if incus image list --format json | grep -q "\"$IMAGE_ALIAS\""; then
  echo "Image '$IMAGE_ALIAS' already exists. Delete it first to reimport:"
  echo "  incus image delete $IMAGE_ALIAS"
  exit 0
fi

if docker image inspect "$DOCKER_IMAGE" &>/dev/null 2>&1; then
  import_docker_image
else
  echo "No local Docker image '$DOCKER_IMAGE' found." >&2
  echo "Build it first:" >&2
  echo "  docker build -t cmux-sandbox-android -f packages/sandbox/Dockerfile.android ." >&2
  exit 1
fi

echo ""
echo "=== Done ==="
echo "Available images:"
incus image list --format table
echo ""
echo "To rebuild and reimport:"
echo "  docker build -t cmux-sandbox-android -f packages/sandbox/Dockerfile.android ."
echo "  incus image delete $IMAGE_ALIAS"
echo "  bash scripts/setup-incus-android.sh"
