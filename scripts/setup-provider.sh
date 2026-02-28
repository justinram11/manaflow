#!/usr/bin/env bash
set -euo pipefail

# cmux Provider Daemon Setup Script
# Usage: curl -fsSL https://<server>/api/providers/setup | bash -s -- --token <TOKEN> --server <URL>
#
# Options:
#   --token <TOKEN>        Provider registration token (required)
#   --server <URL>         cmux server URL (required)
#   --daemon-dir <PATH>    Override daemon code location (for local dev)

TOKEN=""
SERVER_URL=""
DAEMON_DIR_OVERRIDE=""
CONFIG_DIR="$HOME/.cmux/provider"
DAEMON_DIR="$HOME/.cmux/provider-daemon"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --token)
      TOKEN="$2"
      shift 2
      ;;
    --server)
      SERVER_URL="$2"
      shift 2
      ;;
    --daemon-dir)
      DAEMON_DIR_OVERRIDE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$TOKEN" || -z "$SERVER_URL" ]]; then
  echo "Usage: setup-provider.sh --token <TOKEN> --server <SERVER_URL>"
  exit 1
fi

# Use override if provided
if [[ -n "$DAEMON_DIR_OVERRIDE" ]]; then
  DAEMON_DIR="$DAEMON_DIR_OVERRIDE"
fi

# Detect platform
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "==> Platform: $PLATFORM ($ARCH)"

# Install bun if missing
if ! command -v bun &>/dev/null; then
  echo "==> Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

echo "==> Bun version: $(bun --version)"

# Platform-specific dependency checks
case "$PLATFORM" in
  linux)
    if ! command -v incus &>/dev/null; then
      echo "==> Warning: incus not found. Install it for compute capabilities."
      echo "    See: https://linuxcontainers.org/incus/docs/main/installing/"
    fi
    ;;
  darwin)
    if ! xcode-select -p &>/dev/null; then
      echo "==> Warning: Xcode Command Line Tools not found."
      echo "    Install with: xcode-select --install"
    fi
    ;;
esac

# Install daemon code (skip if --daemon-dir was provided or already exists)
if [[ -z "$DAEMON_DIR_OVERRIDE" ]]; then
  if [[ -f "$DAEMON_DIR/src/index.ts" ]]; then
    echo "==> Daemon code already exists at $DAEMON_DIR, updating..."
  else
    echo "==> Downloading provider daemon to $DAEMON_DIR..."
    mkdir -p "$DAEMON_DIR"
  fi

  # Download daemon package from the server
  if curl -fsSL "$SERVER_URL/api/providers/daemon-package" -o "/tmp/cmux-provider-daemon.tar.gz" 2>/dev/null; then
    tar -xzf /tmp/cmux-provider-daemon.tar.gz -C "$DAEMON_DIR"
    rm -f /tmp/cmux-provider-daemon.tar.gz
  else
    echo "==> Warning: Could not download daemon package from server."
    echo "    The daemon code must be installed manually at: $DAEMON_DIR"
    echo "    For local development, use: --daemon-dir /path/to/packages/provider-daemon"
  fi
fi

# Install dependencies if package.json exists
if [[ -f "$DAEMON_DIR/package.json" ]]; then
  echo "==> Installing daemon dependencies..."
  (cd "$DAEMON_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
fi

# Verify daemon entry point exists
if [[ ! -f "$DAEMON_DIR/src/index.ts" ]]; then
  echo "==> Error: Daemon entry point not found at $DAEMON_DIR/src/index.ts"
  echo "    Use --daemon-dir to point to an existing installation."
  exit 1
fi

echo "==> Daemon code: $DAEMON_DIR"

# Write config
echo "==> Writing config to $CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/config.json" <<EOF
{
  "serverUrl": "$SERVER_URL",
  "token": "$TOKEN"
}
EOF

# Install systemd service (Linux) or launchd plist (macOS)
case "$PLATFORM" in
  linux)
    # Prefer user-level systemd if available (no sudo required)
    if systemctl --user status &>/dev/null 2>&1; then
      echo "==> Installing user-level systemd service..."
      SYSTEMD_DIR="$HOME/.config/systemd/user"
      mkdir -p "$SYSTEMD_DIR"
      SERVICE_FILE="$SYSTEMD_DIR/cmux-provider.service"
      cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=cmux Provider Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=CMUX_SERVER_URL=$SERVER_URL
Environment=CMUX_PROVIDER_TOKEN=$TOKEN
ExecStart=$(which bun) run $DAEMON_DIR/src/index.ts
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable cmux-provider
      systemctl --user start cmux-provider
      echo "==> Service installed and started: cmux-provider (user)"
      echo "    Check status: systemctl --user status cmux-provider"
      echo "    View logs:    journalctl --user -u cmux-provider -f"
    else
      echo "==> Installing system-level systemd service..."
      SERVICE_FILE="/etc/systemd/system/cmux-provider.service"
      sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=cmux Provider Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
Environment=PATH=$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=CMUX_SERVER_URL=$SERVER_URL
Environment=CMUX_PROVIDER_TOKEN=$TOKEN
ExecStart=$(which bun) run $DAEMON_DIR/src/index.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
      sudo systemctl daemon-reload
      sudo systemctl enable cmux-provider
      sudo systemctl start cmux-provider
      echo "==> Service installed and started: cmux-provider"
      echo "    Check status: sudo systemctl status cmux-provider"
      echo "    View logs:    sudo journalctl -u cmux-provider -f"
    fi
    ;;
  darwin)
    echo "==> Installing launchd plist..."
    PLIST_PATH="$HOME/Library/LaunchAgents/com.cmux.provider.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cmux.provider</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/.bun/bin/bun</string>
    <string>run</string>
    <string>$DAEMON_DIR/src/index.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CMUX_SERVER_URL</key>
    <string>$SERVER_URL</string>
    <key>CMUX_PROVIDER_TOKEN</key>
    <string>$TOKEN</string>
    <key>PATH</key>
    <string>$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/.cmux/provider/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.cmux/provider/daemon.err</string>
</dict>
</plist>
EOF
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"
    echo "==> Service installed and started: com.cmux.provider"
    echo "    Check logs: tail -f $HOME/.cmux/provider/daemon.log"
    ;;
esac

echo ""
echo "==> Setup complete! The provider daemon will connect to $SERVER_URL"
echo "    Config: $CONFIG_DIR/config.json"
