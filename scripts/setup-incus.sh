#!/usr/bin/env bash
set -euo pipefail

# Setup Incus for cmux sandbox provider
# This script installs Incus, initialises the default storage pool and network,
# imports the cmux sandbox OCI image, and verifies the installation.

echo "=== Installing Incus ==="

if command -v incus &>/dev/null; then
  echo "Incus is already installed: $(incus version)"
else
  # Ubuntu / Debian
  if command -v apt-get &>/dev/null; then
    sudo mkdir -p /etc/apt/keyrings/
    curl -fsSL https://pkgs.zabbly.com/key.asc | sudo gpg --dearmor -o /etc/apt/keyrings/zabbly.gpg
    echo "deb [signed-by=/etc/apt/keyrings/zabbly.gpg] https://pkgs.zabbly.com/incus/stable $(. /etc/os-release && echo "$VERSION_CODENAME") main" | sudo tee /etc/apt/sources.list.d/zabbly-incus-stable.list
    sudo apt-get update
    sudo apt-get install -y incus
  else
    echo "Unsupported distro – please install Incus manually: https://linuxcontainers.org/incus/docs/main/installing/"
    exit 1
  fi
fi

echo ""
echo "=== Initialising Incus (auto) ==="
sudo incus admin init --auto 2>/dev/null || echo "(already initialised)"

echo ""
echo "=== Adding current user to incus-admin group ==="
if ! groups "$USER" | grep -q incus-admin; then
  sudo usermod -aG incus-admin "$USER"
  echo "Added $USER to incus-admin group. You may need to log out and back in."
else
  echo "$USER is already in incus-admin group."
fi

echo ""
echo "=== Importing cmux sandbox image ==="

IMAGE_ALIAS="cmux-sandbox"

import_docker_image() {
  # Incus 6.x requires separate metadata + rootfs tarballs.
  # docker save produces an OCI layout that Incus rejects, so we export
  # the filesystem via docker create/export instead.
  echo "Exporting Docker image cmux-sandbox:latest → Incus..."

  TMPDIR_IMG=$(mktemp -d)
  trap 'rm -rf "$TMPDIR_IMG"' EXIT

  # Create a throwaway container to export its rootfs
  CID=$(docker create cmux-sandbox:latest)
  docker export "$CID" > "$TMPDIR_IMG/rootfs.tar"
  docker rm "$CID" > /dev/null

  # Create the metadata tarball Incus expects
  cat > "$TMPDIR_IMG/metadata.yaml" << EOF
architecture: x86_64
creation_date: $(date +%s)
properties:
  description: cmux sandbox container image
  os: ubuntu
  release: noble
EOF
  tar czf "$TMPDIR_IMG/metadata.tar.gz" -C "$TMPDIR_IMG" metadata.yaml

  incus image import "$TMPDIR_IMG/metadata.tar.gz" "$TMPDIR_IMG/rootfs.tar" --alias "$IMAGE_ALIAS"
  echo "Imported '$IMAGE_ALIAS' from Docker."
}

if incus image list --format json | grep -q "\"$IMAGE_ALIAS\""; then
  echo "Image '$IMAGE_ALIAS' already exists. Delete it first to reimport."
else
  if docker image inspect cmux-sandbox:latest &>/dev/null 2>&1; then
    import_docker_image
  else
    echo "No local Docker image 'cmux-sandbox:latest' found."
    echo "Please build the sandbox image first, then re-run this script."
    echo ""
    echo "  docker build -t cmux-sandbox -f packages/sandbox/Dockerfile ."
  fi
fi

echo ""
echo "=== Verifying installation ==="

echo "Incus version: $(incus version)"
echo "Available images:"
incus image list --format table

echo ""
echo "Launching test container..."
TEST_CONTAINER="cmux-test-$(date +%s)"
if incus image list --format json | grep -q "\"$IMAGE_ALIAS\""; then
  incus launch "$IMAGE_ALIAS" "$TEST_CONTAINER" --config security.nesting=true
  sleep 2
  echo "Test container status:"
  incus list "$TEST_CONTAINER" --format table
  echo "Cleaning up test container..."
  incus delete "$TEST_CONTAINER" --force
  echo "Test passed!"
else
  echo "Skipping test — no '$IMAGE_ALIAS' image available."
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Set these environment variables in your .env:"
echo "  SANDBOX_PROVIDER=incus"
echo "  INCUS_IMAGE=$IMAGE_ALIAS"
echo ""
echo "To rebuild and reimport the image:"
echo "  docker build -t cmux-sandbox -f packages/sandbox/Dockerfile ."
echo "  incus image delete $IMAGE_ALIAS"
echo "  bash scripts/setup-incus.sh"
