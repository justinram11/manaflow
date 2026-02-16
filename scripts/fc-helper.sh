#!/usr/bin/env bash
#
# fc-helper.sh — Sudo helper for Firecracker operations.
# This script is called by the www server via:
#   sudo scripts/fc-helper.sh <command> [args...]
#
# It handles operations that require root: spawning Firecracker, TAP
# device management, iptables rules, and snapshot operations.
#
# Security: This script is added to sudoers with NOPASSWD for the
# deploy user. It validates all arguments before executing.
#
set -euo pipefail

COMMAND="${1:-}"
shift || true

usage() {
  echo "Usage: fc-helper.sh <command> [args...]"
  echo ""
  echo "Commands:"
  echo "  spawn <fc_bin> <socket_path> [--daemonize]"
  echo "      Start a Firecracker process listening on the given Unix socket."
  echo ""
  echo "  tap-create <tap_name> <host_ip> <prefix_len>"
  echo "      Create a TAP device and assign the host-side IP."
  echo ""
  echo "  tap-delete <tap_name>"
  echo "      Delete a TAP device."
  echo ""
  echo "  nat-setup <tap_name> <guest_ip> <outbound_iface>"
  echo "      Set up MASQUERADE for outbound traffic from a guest."
  echo ""
  echo "  nat-teardown <tap_name> <guest_ip> <outbound_iface>"
  echo "      Remove MASQUERADE rules for a guest."
  echo ""
  echo "  port-forward-add <host_port> <guest_ip> <guest_port> <outbound_iface>"
  echo "      Add DNAT rule to forward host_port to guest_ip:guest_port."
  echo ""
  echo "  port-forward-del <host_port> <guest_ip> <guest_port> <outbound_iface>"
  echo "      Remove DNAT rule."
  echo ""
  echo "  kill <pid>"
  echo "      Kill a Firecracker process by PID."
  echo ""
  echo "  copy-rootfs <src> <dst>"
  echo "      Copy a rootfs file (sparse-aware)."
  echo ""
  exit 1
}

# Validate that a string looks like a safe path (no shenanigans)
validate_path() {
  local p="$1"
  if [[ "$p" =~ [[:space:]] || "$p" =~ \.\. || "$p" =~ ^\- ]]; then
    echo "ERROR: Invalid path: $p" >&2
    exit 1
  fi
}

# Validate a TAP device name (alphanumeric + underscore, max 15 chars)
validate_tap() {
  local tap="$1"
  if ! [[ "$tap" =~ ^[a-zA-Z0-9_]{1,15}$ ]]; then
    echo "ERROR: Invalid TAP name: $tap" >&2
    exit 1
  fi
}

# Validate an IP address (basic check)
validate_ip() {
  local ip="$1"
  if ! [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: Invalid IP address: $ip" >&2
    exit 1
  fi
}

# Validate a port number
validate_port() {
  local port="$1"
  if ! [[ "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "ERROR: Invalid port: $port" >&2
    exit 1
  fi
}

# Validate a PID
validate_pid() {
  local pid="$1"
  if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    echo "ERROR: Invalid PID: $pid" >&2
    exit 1
  fi
}

case "$COMMAND" in
  spawn)
    FC_BIN="${1:-}"
    SOCKET_PATH="${2:-}"
    DAEMONIZE="${3:-}"
    [ -z "$FC_BIN" ] || [ -z "$SOCKET_PATH" ] && usage
    validate_path "$FC_BIN"
    validate_path "$SOCKET_PATH"

    if [ ! -x "$FC_BIN" ]; then
      echo "ERROR: Firecracker binary not found or not executable: $FC_BIN" >&2
      exit 1
    fi

    # Remove stale socket if it exists
    rm -f "$SOCKET_PATH"

    if [ "$DAEMONIZE" = "--daemonize" ]; then
      LOG_FILE="${SOCKET_PATH%.sock}.log"
      "$FC_BIN" --api-sock "$SOCKET_PATH" >"$LOG_FILE" 2>&1 &
      FC_PID=$!
      # Wait for socket to appear and make it accessible to the calling user
      for _i in $(seq 1 50); do
        if [ -S "$SOCKET_PATH" ]; then
          chmod 0666 "$SOCKET_PATH"
          break
        fi
        sleep 0.1
      done
      echo "$FC_PID"
    else
      exec "$FC_BIN" --api-sock "$SOCKET_PATH"
    fi
    ;;

  tap-create)
    TAP_NAME="${1:-}"
    HOST_IP="${2:-}"
    PREFIX_LEN="${3:-}"
    [ -z "$TAP_NAME" ] || [ -z "$HOST_IP" ] || [ -z "$PREFIX_LEN" ] && usage
    validate_tap "$TAP_NAME"
    validate_ip "$HOST_IP"

    ip tuntap add dev "$TAP_NAME" mode tap
    ip addr add "${HOST_IP}/${PREFIX_LEN}" dev "$TAP_NAME"
    ip link set "$TAP_NAME" up
    echo "Created TAP device $TAP_NAME with IP ${HOST_IP}/${PREFIX_LEN}"
    ;;

  tap-delete)
    TAP_NAME="${1:-}"
    [ -z "$TAP_NAME" ] && usage
    validate_tap "$TAP_NAME"

    ip link set "$TAP_NAME" down 2>/dev/null || true
    ip tuntap del dev "$TAP_NAME" mode tap 2>/dev/null || true
    echo "Deleted TAP device $TAP_NAME"
    ;;

  nat-setup)
    TAP_NAME="${1:-}"
    GUEST_IP="${2:-}"
    OUTBOUND_IFACE="${3:-}"
    [ -z "$TAP_NAME" ] || [ -z "$GUEST_IP" ] || [ -z "$OUTBOUND_IFACE" ] && usage
    validate_tap "$TAP_NAME"
    validate_ip "$GUEST_IP"

    # Enable IP forwarding
    sysctl -w net.ipv4.ip_forward=1 >/dev/null

    # MASQUERADE for outbound traffic from guest
    iptables -t nat -A POSTROUTING -o "$OUTBOUND_IFACE" -s "$GUEST_IP" -j MASQUERADE
    # Allow forwarding for this TAP
    iptables -A FORWARD -i "$TAP_NAME" -o "$OUTBOUND_IFACE" -j ACCEPT
    iptables -A FORWARD -i "$OUTBOUND_IFACE" -o "$TAP_NAME" -m state --state RELATED,ESTABLISHED -j ACCEPT
    echo "NAT setup for $GUEST_IP via $OUTBOUND_IFACE"
    ;;

  nat-teardown)
    TAP_NAME="${1:-}"
    GUEST_IP="${2:-}"
    OUTBOUND_IFACE="${3:-}"
    [ -z "$TAP_NAME" ] || [ -z "$GUEST_IP" ] || [ -z "$OUTBOUND_IFACE" ] && usage
    validate_tap "$TAP_NAME"
    validate_ip "$GUEST_IP"

    iptables -t nat -D POSTROUTING -o "$OUTBOUND_IFACE" -s "$GUEST_IP" -j MASQUERADE 2>/dev/null || true
    iptables -D FORWARD -i "$TAP_NAME" -o "$OUTBOUND_IFACE" -j ACCEPT 2>/dev/null || true
    iptables -D FORWARD -i "$OUTBOUND_IFACE" -o "$TAP_NAME" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
    echo "NAT teardown for $GUEST_IP via $OUTBOUND_IFACE"
    ;;

  port-forward-add)
    HOST_PORT="${1:-}"
    GUEST_IP="${2:-}"
    GUEST_PORT="${3:-}"
    OUTBOUND_IFACE="${4:-}"
    [ -z "$HOST_PORT" ] || [ -z "$GUEST_IP" ] || [ -z "$GUEST_PORT" ] || [ -z "$OUTBOUND_IFACE" ] && usage
    validate_port "$HOST_PORT"
    validate_ip "$GUEST_IP"
    validate_port "$GUEST_PORT"

    # DNAT incoming traffic from any interface (PREROUTING) and local traffic (OUTPUT)
    # Note: no -i restriction — traffic may arrive on any interface (LAN, Tailscale, etc.)
    iptables -t nat -A PREROUTING -p tcp --dport "$HOST_PORT" -j DNAT --to-destination "${GUEST_IP}:${GUEST_PORT}"
    iptables -t nat -A OUTPUT -p tcp --dport "$HOST_PORT" -j DNAT --to-destination "${GUEST_IP}:${GUEST_PORT}"
    # Allow DNAT'd packets through the FORWARD chain (needed for external connections)
    iptables -A FORWARD -d "$GUEST_IP" -p tcp --dport "$GUEST_PORT" -j ACCEPT
    echo "Port forward: host:${HOST_PORT} -> ${GUEST_IP}:${GUEST_PORT}"
    ;;

  port-forward-del)
    HOST_PORT="${1:-}"
    GUEST_IP="${2:-}"
    GUEST_PORT="${3:-}"
    OUTBOUND_IFACE="${4:-}"
    [ -z "$HOST_PORT" ] || [ -z "$GUEST_IP" ] || [ -z "$GUEST_PORT" ] || [ -z "$OUTBOUND_IFACE" ] && usage
    validate_port "$HOST_PORT"
    validate_ip "$GUEST_IP"
    validate_port "$GUEST_PORT"

    iptables -t nat -D PREROUTING -p tcp --dport "$HOST_PORT" -j DNAT --to-destination "${GUEST_IP}:${GUEST_PORT}" 2>/dev/null || true
    iptables -t nat -D OUTPUT -p tcp --dport "$HOST_PORT" -j DNAT --to-destination "${GUEST_IP}:${GUEST_PORT}" 2>/dev/null || true
    iptables -D FORWARD -d "$GUEST_IP" -p tcp --dport "$GUEST_PORT" -j ACCEPT 2>/dev/null || true
    echo "Port forward removed: host:${HOST_PORT} -> ${GUEST_IP}:${GUEST_PORT}"
    ;;

  kill)
    PID="${1:-}"
    [ -z "$PID" ] && usage
    validate_pid "$PID"

    # Only kill if the process is actually a Firecracker process
    PROC_NAME=$(cat "/proc/${PID}/comm" 2>/dev/null || echo "")
    if [ "$PROC_NAME" = "firecracker" ]; then
      kill "$PID" 2>/dev/null || true
      echo "Killed Firecracker process $PID"
    else
      echo "ERROR: PID $PID is not a Firecracker process (comm=$PROC_NAME)" >&2
      exit 1
    fi
    ;;

  copy-rootfs)
    SRC="${1:-}"
    DST="${2:-}"
    [ -z "$SRC" ] || [ -z "$DST" ] && usage
    validate_path "$SRC"
    validate_path "$DST"

    cp --reflink=auto --sparse=always "$SRC" "$DST"
    echo "Copied rootfs: $SRC -> $DST"
    ;;

  iptables-list)
    echo "=== NAT PREROUTING ==="
    iptables -t nat -L PREROUTING -n -v --line-numbers 2>/dev/null || echo "(empty)"
    echo ""
    echo "=== NAT OUTPUT ==="
    iptables -t nat -L OUTPUT -n -v --line-numbers 2>/dev/null || echo "(empty)"
    echo ""
    echo "=== NAT POSTROUTING ==="
    iptables -t nat -L POSTROUTING -n -v --line-numbers 2>/dev/null || echo "(empty)"
    echo ""
    echo "=== FORWARD ==="
    iptables -L FORWARD -n -v --line-numbers 2>/dev/null || echo "(empty)"
    echo ""
    echo "=== DOCKER-USER ==="
    iptables -L DOCKER-USER -n -v --line-numbers 2>/dev/null || echo "(empty)"
    echo ""
    echo "=== DOCKER-FORWARD ==="
    iptables -L DOCKER-FORWARD -n -v --line-numbers 2>/dev/null || echo "(empty)"
    ;;

  *)
    echo "ERROR: Unknown command: $COMMAND" >&2
    usage
    ;;
esac
