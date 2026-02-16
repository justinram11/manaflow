#!/usr/bin/env bash
#
# setup-firecracker.sh — Download Firecracker, kernel, and create base rootfs
# from the cmux Docker image for use as a Firecracker sandbox provider.
#
# Usage:
#   ./scripts/setup-firecracker.sh [--rootfs-size 20G] [--image manaflow/cmux:latest]
#
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────
FC_DIR="${HOME}/.cmux/firecracker"
FC_VERSION="v1.10.1"
KERNEL_VERSION="6.1.102"
ROOTFS_SIZE="20G"
DOCKER_IMAGE="docker.io/manaflow/cmux:latest"
ARCH="$(uname -m)"

# ── Parse args ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rootfs-size) ROOTFS_SIZE="$2"; shift 2 ;;
    --image)       DOCKER_IMAGE="$2"; shift 2 ;;
    --fc-version)  FC_VERSION="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--rootfs-size SIZE] [--image DOCKER_IMAGE] [--fc-version VERSION]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Map architecture to Firecracker naming
case "$ARCH" in
  x86_64)  FC_ARCH="x86_64" ;;
  aarch64) FC_ARCH="aarch64" ;;
  *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "=== Firecracker Setup ==="
echo "  Directory:    ${FC_DIR}"
echo "  FC version:   ${FC_VERSION}"
echo "  Architecture: ${FC_ARCH}"
echo "  Docker image: ${DOCKER_IMAGE}"
echo "  Rootfs size:  ${ROOTFS_SIZE}"
echo ""

# ── Check prerequisites ──────────────────────────────────────────────
for cmd in curl tar docker truncate mkfs.ext4; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: Required command '$cmd' not found. Please install it."
    exit 1
  fi
done

if [ ! -e /dev/kvm ]; then
  echo "WARNING: /dev/kvm not found. Firecracker requires KVM support."
  echo "  Ensure KVM is enabled and accessible to your user."
fi

# ── Create directory structure ────────────────────────────────────────
mkdir -p "${FC_DIR}/snapshots"
echo "Created directory structure at ${FC_DIR}"

# ── 1. Download Firecracker binary ────────────────────────────────────
FC_BIN="${FC_DIR}/firecracker"
if [ -f "$FC_BIN" ]; then
  echo "Firecracker binary already exists at ${FC_BIN}, skipping download."
else
  echo "Downloading Firecracker ${FC_VERSION} for ${FC_ARCH}..."
  FC_URL="https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-${FC_ARCH}.tgz"
  TMPDIR_FC="$(mktemp -d)"
  curl -fSL "$FC_URL" -o "${TMPDIR_FC}/firecracker.tgz"
  tar -xzf "${TMPDIR_FC}/firecracker.tgz" -C "${TMPDIR_FC}"
  cp "${TMPDIR_FC}/release-${FC_VERSION}-${FC_ARCH}/firecracker-${FC_VERSION}-${FC_ARCH}" "$FC_BIN"
  chmod +x "$FC_BIN"
  rm -rf "$TMPDIR_FC"
  echo "Firecracker binary installed at ${FC_BIN}"
fi

# ── 2. Download kernel ────────────────────────────────────────────────
KERNEL_BIN="${FC_DIR}/vmlinux"
if [ -f "$KERNEL_BIN" ]; then
  echo "Kernel already exists at ${KERNEL_BIN}, skipping download."
else
  echo "Downloading vmlinux kernel (${KERNEL_VERSION})..."
  KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/${FC_ARCH}/vmlinux-${KERNEL_VERSION}"
  curl -fSL "$KERNEL_URL" -o "$KERNEL_BIN"
  echo "Kernel installed at ${KERNEL_BIN}"
fi

# ── 3. Create base rootfs from Docker image ───────────────────────────
ROOTFS="${FC_DIR}/cmux-base.ext4"
if [ -f "$ROOTFS" ]; then
  echo "Base rootfs already exists at ${ROOTFS}, skipping creation."
  echo "  To recreate, delete it first: rm ${ROOTFS}"
else
  echo "Creating base rootfs from Docker image ${DOCKER_IMAGE}..."

  # Pull the image if needed (skip if local-only)
  docker pull "$DOCKER_IMAGE" 2>/dev/null || echo "  Using local image (pull skipped)"

  # Create a temporary container and export its filesystem
  CONTAINER_ID=$(docker create "$DOCKER_IMAGE")
  TMPDIR_ROOTFS="$(mktemp -d)"
  TARBALL="${TMPDIR_ROOTFS}/rootfs.tar"

  echo "  Exporting container filesystem..."
  docker export "$CONTAINER_ID" > "$TARBALL"
  docker rm "$CONTAINER_ID" >/dev/null

  # Create a sparse ext4 image
  echo "  Creating sparse ext4 image (${ROOTFS_SIZE})..."
  truncate -s "$ROOTFS_SIZE" "$ROOTFS"
  mkfs.ext4 -F -q "$ROOTFS"

  # Mount and extract
  MOUNT_DIR="${TMPDIR_ROOTFS}/mnt"
  mkdir -p "$MOUNT_DIR"

  echo "  Mounting and extracting filesystem (requires sudo)..."
  sudo mount -o loop "$ROOTFS" "$MOUNT_DIR"
  sudo tar -xf "$TARBALL" -C "$MOUNT_DIR"

  # Configure networking inside the rootfs
  echo "  Configuring network (static IP on eth0)..."
  sudo mkdir -p "${MOUNT_DIR}/etc/systemd/network"
  sudo tee "${MOUNT_DIR}/etc/systemd/network/10-eth0.network" >/dev/null <<'NETEOF'
[Match]
Name=eth0

[Network]
DHCP=no

[Address]
# Placeholder — overwritten per-VM at boot via kernel cmdline or init script

[Route]
# Default route — overwritten per-VM
NETEOF

  # Create an init script that configures networking from kernel command line
  sudo tee "${MOUNT_DIR}/etc/systemd/system/fc-net-setup.service" >/dev/null <<'SVCEOF'
[Unit]
Description=Firecracker Network Setup
Before=network-online.target
After=systemd-networkd.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/fc-net-setup.sh

[Install]
WantedBy=multi-user.target
SVCEOF

  sudo tee "${MOUNT_DIR}/usr/local/bin/fc-net-setup.sh" >/dev/null <<'SCRIPTEOF'
#!/bin/bash
# Parse network config from kernel command line
# Format: fc_net=<guest_ip>/<prefix>,<gateway_ip>
FC_NET=$(grep -oP 'fc_net=\K[^ ]+' /proc/cmdline || true)
if [ -z "$FC_NET" ]; then
  echo "fc-net-setup: no fc_net= on cmdline, skipping"
  exit 0
fi

GUEST_CIDR=$(echo "$FC_NET" | cut -d',' -f1)
GATEWAY=$(echo "$FC_NET" | cut -d',' -f2)

ip addr add "$GUEST_CIDR" dev eth0
ip link set eth0 up
ip route add default via "$GATEWAY" dev eth0

# Set up DNS
echo "nameserver 8.8.8.8" > /etc/resolv.conf
echo "nameserver 8.8.4.4" >> /etc/resolv.conf

echo "fc-net-setup: configured eth0 with $GUEST_CIDR via $GATEWAY"
SCRIPTEOF

  sudo chmod +x "${MOUNT_DIR}/usr/local/bin/fc-net-setup.sh"

  # Enable the network setup service
  sudo ln -sf /etc/systemd/system/fc-net-setup.service \
    "${MOUNT_DIR}/etc/systemd/system/multi-user.target.wants/fc-net-setup.service" 2>/dev/null || true

  # Create a port-forwarding service that DNATs from VM eth0 to sandbox internal IP.
  # This bridges the gap between the host-to-VM port forwarding and the sandbox container.
  echo "  Configuring port-forwarding service..."
  sudo tee "${MOUNT_DIR}/etc/systemd/system/fc-port-forward.service" >/dev/null <<'PFEOF'
[Unit]
Description=Firecracker sandbox port forwarding
After=cmux-sandboxd.service fc-net-setup.service
Requires=cmux-sandboxd.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/fc-port-forward.sh

[Install]
WantedBy=multi-user.target
PFEOF

  sudo tee "${MOUNT_DIR}/usr/local/bin/fc-port-forward.sh" >/dev/null <<'PFSCRIPT'
#!/bin/bash
# Wait for cmux-sandboxd to create a sandbox, then set up iptables DNAT
# from the VM's eth0 interface to the sandbox's internal IP for all service ports.
set -euo pipefail

SANDBOXD_URL="http://127.0.0.1:46831"
# Ports exposed by the sandbox container (VSCode, worker, proxy, VNC, devtools, PTY, exec)
PORTS="39375 39377 39378 39379 39380 39381 39383"

# Wait for sandboxd to be healthy
echo "fc-port-forward: waiting for sandboxd..."
for _ in $(seq 1 120); do
  if curl -sf "$SANDBOXD_URL/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Wait for a sandbox to be created (provider creates one after health check passes)
echo "fc-port-forward: waiting for sandbox creation..."
SANDBOX_IP=""
for _ in $(seq 1 300); do
  # Parse first sandbox's IP using grep (no python/jq dependency)
  SANDBOX_IP=$(curl -sf "$SANDBOXD_URL/sandboxes" 2>/dev/null \
    | grep -oP '"sandbox_ip"\s*:\s*"\K[^"]+' \
    | head -1) || true
  if [ -n "$SANDBOX_IP" ]; then
    break
  fi
  sleep 1
done

if [ -z "$SANDBOX_IP" ]; then
  echo "fc-port-forward: no sandbox found after timeout, skipping"
  exit 0
fi

# Get VM's eth0 IP for OUTPUT chain rules
ETH0_IP=$(ip -4 addr show eth0 | grep -oP 'inet \K[\d.]+') || true

# Enable IP forwarding
sysctl -w net.ipv4.ip_forward=1 >/dev/null

# Set up DNAT for each port
for port in $PORTS; do
  # PREROUTING: incoming packets from outside the VM
  iptables -t nat -A PREROUTING -i eth0 -p tcp --dport "$port" -j DNAT --to "$SANDBOX_IP:$port"
  # OUTPUT: locally-originated packets (e.g., sandboxd health checks)
  if [ -n "$ETH0_IP" ]; then
    iptables -t nat -A OUTPUT -p tcp -d "$ETH0_IP" --dport "$port" -j DNAT --to "$SANDBOX_IP:$port"
  fi
done

# Allow forwarded traffic to/from sandbox
iptables -A FORWARD -d "$SANDBOX_IP" -j ACCEPT
iptables -A FORWARD -s "$SANDBOX_IP" -j ACCEPT

echo "fc-port-forward: DNAT to $SANDBOX_IP for ports: $PORTS"
PFSCRIPT

  sudo chmod +x "${MOUNT_DIR}/usr/local/bin/fc-port-forward.sh"

  # Enable the port-forwarding service
  sudo ln -sf /etc/systemd/system/fc-port-forward.service \
    "${MOUNT_DIR}/etc/systemd/system/multi-user.target.wants/fc-port-forward.service" 2>/dev/null || true

  # Ensure systemd is the init system (create symlink if missing)
  if [ ! -e "${MOUNT_DIR}/sbin/init" ] && [ -e "${MOUNT_DIR}/lib/systemd/systemd" ]; then
    sudo ln -sf /lib/systemd/systemd "${MOUNT_DIR}/sbin/init"
  fi

  # Set hostname
  echo "cmux-sandbox" | sudo tee "${MOUNT_DIR}/etc/hostname" >/dev/null

  # Ensure /dev nodes exist (some are needed at boot before devtmpfs)
  sudo mkdir -p "${MOUNT_DIR}/dev"

  # Clean up mount
  sudo umount "$MOUNT_DIR"
  rm -rf "$TMPDIR_ROOTFS"

  echo "Base rootfs created at ${ROOTFS}"
fi

# ── 4. Set up sudo helper ─────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FC_HELPER="${SCRIPT_DIR}/fc-helper.sh"

if [ -f "$FC_HELPER" ]; then
  echo ""
  echo "=== Sudo Configuration ==="
  echo "  The fc-helper.sh script needs passwordless sudo."
  echo "  Add the following line to /etc/sudoers.d/cmux-firecracker:"
  echo ""
  echo "  $(whoami) ALL=(ALL) NOPASSWD: ${FC_HELPER}"
  echo ""
  echo "  Run:"
  echo "    echo '$(whoami) ALL=(ALL) NOPASSWD: ${FC_HELPER}' | sudo tee /etc/sudoers.d/cmux-firecracker"
  echo "    sudo chmod 440 /etc/sudoers.d/cmux-firecracker"
fi

# ── 5. Verify ─────────────────────────────────────────────────────────
echo ""
echo "=== Setup Complete ==="
echo "  Firecracker binary: ${FC_BIN}"
echo "  Kernel:             ${KERNEL_BIN}"
echo "  Base rootfs:        ${ROOTFS}"
echo "  Snapshots dir:      ${FC_DIR}/snapshots/"
echo ""
echo "  To verify: ${FC_BIN} --version"
"$FC_BIN" --version 2>/dev/null || echo "  (run manually to verify)"
