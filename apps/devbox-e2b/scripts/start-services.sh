#!/bin/bash
# Start all services for the cmux E2B sandbox
# Services: OpenVSCode, Chrome CDP, VNC, noVNC, worker daemon

echo "[cmux-e2b] Starting services..."

# Always generate a fresh auth token on startup (security: each instance gets unique token)
AUTH_TOKEN_FILE="/home/user/.worker-auth-token"
VSCODE_TOKEN_FILE="/home/user/.vscode-token"
BOOT_ID_FILE="/home/user/.token-boot-id"

AUTH_TOKEN=$(openssl rand -hex 32)
echo "$AUTH_TOKEN" > "$AUTH_TOKEN_FILE"
chmod 644 "$AUTH_TOKEN_FILE"
chown user:user "$AUTH_TOKEN_FILE"

echo "[cmux-e2b] Auth token generated: ${AUTH_TOKEN:0:8}..."

# Create VSCode connection token file (same as worker auth)
echo "$AUTH_TOKEN" > "$VSCODE_TOKEN_FILE"
chmod 644 "$VSCODE_TOKEN_FILE"
chown user:user "$VSCODE_TOKEN_FILE"

# Save current boot ID so worker-daemon knows not to regenerate token
BOOT_ID=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo "unknown")
echo "$BOOT_ID" > "$BOOT_ID_FILE"
chmod 644 "$BOOT_ID_FILE"
chown user:user "$BOOT_ID_FILE"
echo "[cmux-e2b] Boot ID saved: ${BOOT_ID:0:8}..."

# Set user password to auth token for SSH/rsync access
echo "user:$AUTH_TOKEN" | sudo chpasswd
echo "[cmux-e2b] SSH password set to auth token"

# Start SSH server on port 10000
echo "[cmux-e2b] Starting SSH server on port 10000..."
# Create privilege separation directory (required by sshd)
sudo mkdir -p /run/sshd
sudo chmod 755 /run/sshd
# Generate host keys if missing
sudo ssh-keygen -A 2>/dev/null || true
# Start sshd on port 10000
sudo /usr/sbin/sshd -p 10000
SSH_PORT=10000
echo "[cmux-e2b] SSH available on port $SSH_PORT (user: user, password: auth token)"

# VNC password not needed - auth proxy validates tokens before allowing access
echo "[cmux-e2b] VNC auth handled by token proxy (no VNC password needed)"

# Start D-Bus for desktop environment
echo "[cmux-e2b] Starting D-Bus..."
sudo mkdir -p /run/dbus 2>/dev/null || true
sudo dbus-daemon --system --fork 2>/dev/null || true

# Start VNC server on display :1 (port 5901) - no password, auth handled by proxy
echo "[cmux-e2b] Starting VNC server on display :1 (no password - auth via proxy)..."
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true
vncserver :1 -geometry 1920x1080 -depth 24 -SecurityTypes None 2>/dev/null &
sleep 3

# Start VNC auth proxy on port 39380 (serves noVNC + proxies WebSocket to VNC)
# This replaces the separate noVNC proxy - architecture matches Morph Go proxy
echo "[cmux-e2b] Starting VNC auth proxy on port 39380..."
node /usr/local/bin/vnc-auth-proxy.js &

# Start OpenVSCode Server on port 39378 with connection token
echo "[cmux-e2b] Starting OpenVSCode Server on port 39378 (with token auth)..."
/opt/openvscode-server/bin/openvscode-server \
    --host 0.0.0.0 \
    --port 39378 \
    --connection-token-file "$VSCODE_TOKEN_FILE" \
    --telemetry-level off \
    --disable-workspace-trust \
    --server-data-dir /home/user/.openvscode-server/data \
    --user-data-dir /home/user/.openvscode-server/data \
    --extensions-dir /home/user/.openvscode-server/extensions \
    /home/user/workspace 2>/dev/null &

# Start Chrome in headless mode with CDP on port 9222
echo "[cmux-e2b] Starting Chrome CDP on port 9222..."
google-chrome \
    --headless=new \
    --remote-debugging-port=9222 \
    --remote-debugging-address=0.0.0.0 \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --disable-software-rasterizer \
    --window-size=1920,1080 \
    --no-first-run \
    --no-default-browser-check \
    --disable-default-apps \
    --disable-extensions \
    --disable-sync \
    --disable-translate \
    --user-data-dir=/home/user/.chrome-data \
    about:blank 2>/dev/null &

# Start worker daemon on port 39377
echo "[cmux-e2b] Starting worker daemon on port 39377..."
node /usr/local/bin/worker-daemon.js &

echo "[cmux-e2b] All services started!"
echo "[cmux-e2b] Services:"
echo "  - VSCode:  http://localhost:39378?tkn=$AUTH_TOKEN"
echo "  - Worker:  http://localhost:39377 (use Bearer token)"
echo "  - VNC:     http://localhost:39380?tkn=$AUTH_TOKEN"
echo "  - Chrome:  http://localhost:9222"
echo ""
echo "[cmux-e2b] Auth token stored at: $AUTH_TOKEN_FILE"
echo "[cmux-e2b] Both VSCode and VNC use ?tkn= for authentication"

# Keep running
tail -f /dev/null
