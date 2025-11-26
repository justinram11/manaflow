#!/bin/bash
# Wrapper script to open URLs on the host machine via the sandbox server.
# This is used as a replacement for xdg-open/open inside sandboxes.
# Uses a Unix socket for reliable communication from sandboxes.

set -e

URL="$1"

if [ -z "$URL" ]; then
    echo "Usage: open-url <url>" >&2
    exit 1
fi

# Unix socket path for communication with the sandbox daemon
SOCKET_PATH="${CMUX_OPEN_URL_SOCKET:-/var/run/cmux/open-url.sock}"

# Try Unix socket first (most reliable for sandboxes)
if [ -S "$SOCKET_PATH" ]; then
    # Send URL via socket and read response
    RESPONSE=$(echo "$URL" | socat - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null || true)
    if [ "$RESPONSE" = "OK" ]; then
        exit 0
    elif [ -n "$RESPONSE" ]; then
        echo "$RESPONSE" >&2
        exit 1
    fi
fi

# Fallback to HTTP if socket not available (e.g., running outside sandbox)
PORT="${CMUX_SANDBOX_PORT:-46831}"
ENCODED_URL=$(printf '%s' "$URL" | python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=''))")

for HOST in "localhost" "10.0.0.1" "172.17.0.1" "host.docker.internal"; do
    if curl -sf --connect-timeout 1 --max-time 3 "http://${HOST}:${PORT}/open-url?url=${ENCODED_URL}" >/dev/null 2>&1; then
        exit 0
    fi
done

# Try to find gateway IP dynamically
GATEWAY=$(ip route | grep default | awk '{print $3}' 2>/dev/null || true)
if [ -n "$GATEWAY" ]; then
    if curl -sf --connect-timeout 1 --max-time 3 "http://${GATEWAY}:${PORT}/open-url?url=${ENCODED_URL}" >/dev/null 2>&1; then
        exit 0
    fi
fi

echo "Failed to open URL: $URL" >&2
echo "Socket path: $SOCKET_PATH (exists: $([ -S "$SOCKET_PATH" ] && echo yes || echo no))" >&2
exit 1
