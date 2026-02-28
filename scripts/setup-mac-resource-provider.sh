#!/bin/bash
# Setup script for cmux Mac Resource Provider
# Usage: curl -fsSL <server>/api/resource-providers/setup | bash -s -- --token <TOKEN> --server <URL>

set -euo pipefail

TOKEN=""
SERVER_URL=""
INSTALL_DIR="$HOME/.cmux/mac-resource-provider"
PLIST_PATH="$HOME/Library/LaunchAgents/sh.cmux.mac-resource-provider.plist"
LOG_DIR="$HOME/.cmux/logs"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)
      TOKEN="$2"
      shift 2
      ;;
    --server)
      SERVER_URL="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$TOKEN" || -z "$SERVER_URL" ]]; then
  echo "Usage: setup-mac-resource-provider.sh --token <TOKEN> --server <URL>"
  exit 1
fi

echo "==> cmux Mac Resource Provider Setup"
echo "    Server: $SERVER_URL"

# Verify prerequisites
echo ""
echo "==> Checking prerequisites..."

if ! command -v xcodebuild &>/dev/null; then
  echo "ERROR: xcodebuild not found. Install Xcode from the App Store."
  exit 1
fi
echo "    ✓ xcodebuild found: $(xcodebuild -version | head -1)"

if ! command -v xcrun &>/dev/null; then
  echo "ERROR: xcrun not found. Install Xcode command line tools: xcode-select --install"
  exit 1
fi
echo "    ✓ xcrun found"

# Check for simulator runtimes
if xcrun simctl list runtimes 2>/dev/null | grep -q "iOS"; then
  echo "    ✓ iOS Simulator runtimes available"
else
  echo "WARNING: No iOS Simulator runtimes found. Install them in Xcode > Settings > Platforms."
fi

# Install bun if missing
if ! command -v bun &>/dev/null; then
  echo ""
  echo "==> Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  echo "    ✓ bun installed"
else
  echo "    ✓ bun found: $(bun --version)"
fi

# Create directories
echo ""
echo "==> Setting up directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$LOG_DIR"
mkdir -p "$HOME/Library/LaunchAgents"

# Write config
echo ""
echo "==> Writing config..."
cat > "$INSTALL_DIR/config.json" << EOF
{
  "serverUrl": "$SERVER_URL",
  "token": "$TOKEN",
  "maxConcurrentBuilds": 2
}
EOF
chmod 600 "$INSTALL_DIR/config.json"
echo "    ✓ Config written to $INSTALL_DIR/config.json"

# Download daemon package from server (or use local monorepo if available)
echo ""
echo "==> Downloading daemon..."
BUNDLE_URL="$SERVER_URL/api/resource-providers/daemon-bundle"
BUNDLE_PATH="$INSTALL_DIR/daemon-bundle.tar.gz"

if curl -fsSL -o "$BUNDLE_PATH" "$BUNDLE_URL" 2>/dev/null; then
  echo "    ✓ Downloaded daemon bundle"
  cd "$INSTALL_DIR"
  tar -xzf daemon-bundle.tar.gz
  rm -f daemon-bundle.tar.gz
else
  echo "    ⚠ Could not download daemon bundle from server."
  echo "    Attempting to clone from git..."

  if command -v git &>/dev/null; then
    REPO_URL="${SERVER_URL%/}"
    # Try to clone just the mac-resource-provider package
    if [[ -d "$INSTALL_DIR/src" ]]; then
      echo "    Using existing source in $INSTALL_DIR/src"
    else
      echo "    Please copy packages/mac-resource-provider/ to $INSTALL_DIR/"
      echo "    Then run: cd $INSTALL_DIR && bun install"
      echo ""
      echo "    After that, reload the service:"
      echo "    launchctl unload $PLIST_PATH 2>/dev/null; launchctl load $PLIST_PATH"
      # Continue to write the plist anyway so it's ready
    fi
  fi
fi

# Install dependencies if package.json exists
if [[ -f "$INSTALL_DIR/package.json" ]]; then
  echo ""
  echo "==> Installing dependencies..."
  cd "$INSTALL_DIR"
  bun install --production 2>/dev/null || bun install
  echo "    ✓ Dependencies installed"
fi

# Create launchd plist
echo ""
echo "==> Installing launchd service..."
BUN_PATH=$(command -v bun)
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.cmux.mac-resource-provider</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN_PATH</string>
    <string>run</string>
    <string>$INSTALL_DIR/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.bun/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/mac-resource-provider.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/mac-resource-provider.error.log</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
EOF

echo "    ✓ Plist written to $PLIST_PATH"

# Load the service
echo ""
echo "==> Starting service..."
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"
echo "    ✓ Service loaded"

echo ""
echo "==> Setup complete!"
echo ""
echo "    Service status: launchctl list | grep cmux"
echo "    View logs:      tail -f $LOG_DIR/mac-resource-provider.log"
echo "    Stop service:   launchctl unload $PLIST_PATH"
echo "    Start service:  launchctl load $PLIST_PATH"
echo ""
echo "    The daemon will automatically connect to $SERVER_URL"
echo "    and show as 'online' in your cmux settings."
