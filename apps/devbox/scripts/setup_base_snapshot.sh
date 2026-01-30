#!/bin/bash
# scripts/setup_base_snapshot.sh
# Run this ONCE on a fresh Morph VM to create the reusable base snapshot
#
# This script installs all required software for the DBA development environment:
# - Chrome with CDP for browser automation
# - TigerVNC + XFCE for visual desktop
# - noVNC for web-based VNC access
# - code-server for VS Code in browser
# - Docker for containerized development
# - nginx as reverse proxy
# - Devbox/Nix for package management
#
# Usage:
#   ./setup_base_snapshot.sh
#
# After running, save as snapshot with:
#   morph snapshot create --digest="dba-base-v1"

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo ""
    echo -e "${GREEN}=== $1 ===${NC}"
}

echo "=============================================="
echo "       DBA Base Snapshot Setup Script        "
echo "=============================================="
echo ""
echo "Started at: $(date)"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    log_error "Please run as root"
    exit 1
fi

# -----------------------------------------------------------------------------
# Step 1/13: System packages
# -----------------------------------------------------------------------------
log_step "Step 1/13: Installing system packages"

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    curl wget git build-essential \
    xfce4 xfce4-goodies dbus-x11 \
    tigervnc-standalone-server \
    nginx \
    python3 python3-pip python3-venv \
    fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
    ca-certificates gnupg lsb-release \
    jq netcat-openbsd \
    sudo openssh-server

log_info "System packages installed"

# -----------------------------------------------------------------------------
# Step 2/13: Install Chrome
# -----------------------------------------------------------------------------
log_step "Step 2/13: Installing Google Chrome"

# Add Google Chrome repository
wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list

apt-get update
apt-get install -y google-chrome-stable

# Verify Chrome installation
if command -v google-chrome &> /dev/null; then
    CHROME_VERSION=$(google-chrome --version)
    log_info "Chrome installed: $CHROME_VERSION"
else
    log_error "Chrome installation failed"
    exit 1
fi

# -----------------------------------------------------------------------------
# Step 3/13: Install Node.js (for agent-browser and other tools)
# -----------------------------------------------------------------------------
log_step "Step 3/13: Installing Node.js"

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Verify Node installation
NODE_VERSION=$(node --version)
NPM_VERSION=$(npm --version)
log_info "Node.js installed: $NODE_VERSION"
log_info "npm installed: $NPM_VERSION"

# Install agent-browser globally
npm install -g @anthropic/agent-browser || log_warn "agent-browser installation skipped (may not be published yet)"

# -----------------------------------------------------------------------------
# Step 4/13: Install Docker
# -----------------------------------------------------------------------------
log_step "Step 4/13: Installing Docker"

# Detect OS (Ubuntu or Debian)
. /etc/os-release
DOCKER_OS="$ID"
log_info "Detected OS: $DOCKER_OS ($VERSION_CODENAME)"

# Add Docker's official GPG key
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/$DOCKER_OS/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

# Add Docker repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$DOCKER_OS \
  $VERSION_CODENAME stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update

# Install Docker packages
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin

# Verify Docker installation
if command -v docker &> /dev/null; then
    DOCKER_VERSION=$(docker --version)
    log_info "Docker installed: $DOCKER_VERSION"
else
    log_error "Docker installation failed"
    exit 1
fi

# Enable and start Docker
systemctl enable docker
systemctl start docker

# Verify Docker is running
if docker info &>/dev/null; then
    log_info "Docker daemon is running"
else
    log_warn "Docker daemon may not be running yet"
fi

log_info "Docker installation complete"

# -----------------------------------------------------------------------------
# Step 5/13: Install Devbox
# -----------------------------------------------------------------------------
log_step "Step 5/13: Installing Devbox"

curl -fsSL https://get.jetify.com/devbox | bash -s -- -f

# Verify Devbox installation
if command -v devbox &> /dev/null; then
    DEVBOX_VERSION=$(devbox version 2>/dev/null || echo "installed")
    log_info "Devbox installed: $DEVBOX_VERSION"
else
    log_warn "Devbox installation may require shell restart"
fi

# -----------------------------------------------------------------------------
# Step 6/13: Install code-server
# -----------------------------------------------------------------------------
log_step "Step 6/13: Installing code-server"

curl -fsSL https://code-server.dev/install.sh | sh

# Verify code-server installation
if command -v code-server &> /dev/null; then
    CODE_SERVER_VERSION=$(code-server --version | head -1)
    log_info "code-server installed: $CODE_SERVER_VERSION"
else
    log_error "code-server installation failed"
    exit 1
fi

# -----------------------------------------------------------------------------
# Step 7/13: Install noVNC
# -----------------------------------------------------------------------------
log_step "Step 7/13: Installing noVNC"

git clone --depth 1 https://github.com/novnc/noVNC.git /opt/noVNC
git clone --depth 1 https://github.com/novnc/websockify.git /opt/noVNC/utils/websockify

# Make noVNC launch script executable
chmod +x /opt/noVNC/utils/novnc_proxy

log_info "noVNC installed to /opt/noVNC"

# -----------------------------------------------------------------------------
# Step 8/13: Create dba user
# -----------------------------------------------------------------------------
log_step "Step 8/13: Creating dba user"

# Create user if doesn't exist
if ! id "dba" &>/dev/null; then
    useradd -m -s /bin/bash dba
    log_info "Created user 'dba'"
else
    log_info "User 'dba' already exists"
fi

# Add to sudoers
echo "dba ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/dba
chmod 440 /etc/sudoers.d/dba

# Add dba user to docker group
usermod -aG docker dba
log_info "User 'dba' added to docker group"

log_info "User 'dba' configured with sudo access"

# -----------------------------------------------------------------------------
# Step 9/13: Configure VNC
# -----------------------------------------------------------------------------
log_step "Step 9/13: Configuring VNC"

# Create VNC directory
mkdir -p /home/dba/.vnc

# Create VNC startup script for XFCE
cat > /home/dba/.vnc/xstartup << 'EOF'
#!/bin/bash
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
export XDG_SESSION_TYPE=x11

# Start D-Bus
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then
    eval $(dbus-launch --sh-syntax)
    export DBUS_SESSION_BUS_ADDRESS
fi

# Start XFCE
exec startxfce4
EOF

chmod +x /home/dba/.vnc/xstartup
chown -R dba:dba /home/dba/.vnc

log_info "VNC configured"

# -----------------------------------------------------------------------------
# Step 10/13: Create systemd services
# -----------------------------------------------------------------------------
log_step "Step 10/13: Creating systemd services"

# VNC Server service
cat > /etc/systemd/system/vncserver.service << 'EOF'
[Unit]
Description=TigerVNC Server for DBA
After=network.target

[Service]
Type=simple
User=dba
Group=dba
Environment=DISPLAY=:1
Environment=HOME=/home/dba

# Kill any existing VNC server on display :1
ExecStartPre=-/usr/bin/vncserver -kill :1
ExecStartPre=/bin/sleep 1

# Start Xvnc directly
ExecStart=/usr/bin/Xvnc :1 \
    -geometry 1920x1080 \
    -depth 24 \
    -rfbport 5901 \
    -SecurityTypes None \
    -localhost no \
    -AlwaysShared \
    -AcceptKeyEvents \
    -AcceptPointerEvents \
    -SendCutText \
    -AcceptCutText

ExecStop=/usr/bin/vncserver -kill :1
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

log_info "Created vncserver.service"

# XFCE Session service
cat > /etc/systemd/system/xfce-session.service << 'EOF'
[Unit]
Description=XFCE Desktop Session
After=vncserver.service
Requires=vncserver.service

[Service]
Type=simple
User=dba
Group=dba
Environment=DISPLAY=:1
Environment=HOME=/home/dba
Environment=XDG_SESSION_TYPE=x11

# Wait for VNC to be ready
ExecStartPre=/bin/bash -c 'for i in {1..30}; do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.5; done'

# Start XFCE
ExecStart=/usr/bin/startxfce4

Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

log_info "Created xfce-session.service"

# Chrome with CDP service
cat > /etc/systemd/system/chrome-cdp.service << 'EOF'
[Unit]
Description=Chrome with Chrome DevTools Protocol
After=xfce-session.service
Requires=xfce-session.service

[Service]
Type=simple
User=dba
Group=dba
Environment=DISPLAY=:1
Environment=HOME=/home/dba

# Wait for XFCE to be ready
ExecStartPre=/bin/bash -c 'for i in {1..60}; do pgrep -u dba xfwm4 > /dev/null && break; sleep 0.5; done'
ExecStartPre=/bin/sleep 2

ExecStart=/usr/bin/google-chrome \
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
    --disable-background-networking \
    --disable-client-side-phishing-detection \
    --disable-component-update \
    --disable-hang-monitor \
    --disable-popup-blocking \
    --disable-prompt-on-repost \
    --metrics-recording-only \
    --safebrowsing-disable-auto-update \
    --password-store=basic \
    --use-mock-keychain \
    --user-data-dir=/home/dba/.chrome-dba \
    about:blank

Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

log_info "Created chrome-cdp.service"

# noVNC service
cat > /etc/systemd/system/novnc.service << 'EOF'
[Unit]
Description=noVNC Web VNC Client
After=vncserver.service
Requires=vncserver.service

[Service]
Type=simple
Environment=HOME=/root

# Wait for VNC to be ready
ExecStartPre=/bin/bash -c 'for i in {1..30}; do nc -z localhost 5901 && break; sleep 0.5; done'

ExecStart=/opt/noVNC/utils/novnc_proxy \
    --vnc localhost:5901 \
    --listen 6080

Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

log_info "Created novnc.service"

# code-server service
cat > /etc/systemd/system/code-server.service << 'EOF'
[Unit]
Description=code-server IDE
After=network.target

[Service]
Type=simple
User=dba
Group=dba
Environment=HOME=/home/dba
Environment=PASSWORD=
WorkingDirectory=/home/dba

ExecStart=/usr/bin/code-server \
    --bind-addr 0.0.0.0:10080 \
    --auth none \
    --disable-telemetry \
    /home/dba/workspace

Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

log_info "Created code-server.service"

# Reload systemd
systemctl daemon-reload

# -----------------------------------------------------------------------------
# Step 11/13: Configure nginx
# -----------------------------------------------------------------------------
log_step "Step 11/13: Configuring nginx"

cat > /etc/nginx/sites-available/dba << 'EOF'
# DBA nginx configuration
# Routes all services through port 80

upstream code_server {
    server 127.0.0.1:10080;
}

upstream app_server {
    server 127.0.0.1:10000;
}

upstream novnc {
    server 127.0.0.1:6080;
}

upstream chrome_cdp {
    server 127.0.0.1:9222;
}

server {
    listen 80 default_server;
    server_name _;

    # Increase timeouts for WebSocket connections
    proxy_connect_timeout 7d;
    proxy_send_timeout 7d;
    proxy_read_timeout 7d;

    # code-server (VS Code IDE)
    location /code/ {
        proxy_pass http://code_server/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Accept-Encoding gzip;
    }

    # App (developer's application on port 10000)
    location /app/ {
        proxy_pass http://app_server/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # noVNC (web-based VNC)
    location /vnc/ {
        proxy_pass http://novnc/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # noVNC websocket connection
    location /websockify {
        proxy_pass http://novnc/websockify;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    # Chrome DevTools Protocol (for agent-browser)
    location /cdp/ {
        proxy_pass http://chrome_cdp/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host localhost;
    }

    # CDP JSON endpoints
    location /json {
        proxy_pass http://chrome_cdp/json;
        proxy_http_version 1.1;
        proxy_set_header Host localhost;
    }

    # DevTools WebSocket
    location ~ ^/devtools/.*$ {
        proxy_pass http://chrome_cdp;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host localhost;
    }

    # Health check endpoint
    location /health {
        access_log off;
        return 200 'DBA VM is healthy\n';
        add_header Content-Type text/plain;
    }

    # Root - redirect to VNC by default
    location = / {
        return 302 /vnc/;
    }
}
EOF

# Enable the site
ln -sf /etc/nginx/sites-available/dba /etc/nginx/sites-enabled/dba

# Remove default site
rm -f /etc/nginx/sites-enabled/default

# Test nginx configuration
nginx -t

log_info "nginx configured"

# -----------------------------------------------------------------------------
# Step 12/13: Create workspace directory and final setup
# -----------------------------------------------------------------------------
log_step "Step 12/13: Final setup"

# Create workspace directory
mkdir -p /home/dba/workspace
mkdir -p /home/dba/.chrome-dba
chown -R dba:dba /home/dba/workspace
chown -R dba:dba /home/dba/.chrome-dba

# Create a welcome file in workspace
cat > /home/dba/workspace/README.md << 'EOF'
# DBA Workspace

This is your development workspace in the Morph Cloud VM.

## Quick Links

- VS Code: http://localhost/code/
- VNC: http://localhost/vnc/
- Your App: http://localhost/app/ (when running)

## Getting Started

1. Clone your repository here
2. Use `devbox init` to set up your development environment
3. Start your dev server on port 10000

## Docker

Docker and Docker Compose are pre-installed:
```bash
docker --version
docker compose --version
```

Run containerized services:
```bash
docker run -d -p 5432:5432 postgres
docker compose up -d
```

## Port Mappings

| Service | Port |
|---------|------|
| Your App | 10000 |
| code-server | 10080 |
| Chrome CDP | 9222 |
| VNC | 5901 |
| noVNC | 6080 |
| nginx | 80 |

EOF
chown dba:dba /home/dba/workspace/README.md

# Enable services
systemctl enable vncserver
systemctl enable xfce-session
systemctl enable chrome-cdp
systemctl enable novnc
systemctl enable code-server
systemctl enable nginx

log_info "Services enabled"

# -----------------------------------------------------------------------------
# Step 13/13: Start services and verify
# -----------------------------------------------------------------------------
log_step "Step 13/13: Starting and verifying services"

# Start services in order
systemctl start nginx
log_info "Started nginx"

systemctl start vncserver
sleep 2
log_info "Started vncserver"

systemctl start xfce-session
sleep 3
log_info "Started xfce-session"

systemctl start novnc
log_info "Started novnc"

systemctl start code-server
log_info "Started code-server"

systemctl start chrome-cdp
sleep 5
log_info "Started chrome-cdp"

# Wait for all services to fully initialize
log_info "Waiting for services to initialize..."
sleep 10

# -----------------------------------------------------------------------------
# Verification
# -----------------------------------------------------------------------------
echo ""
echo "=============================================="
echo "              VERIFICATION                    "
echo "=============================================="
echo ""

FAILED=0

check_service() {
    local name=$1
    if systemctl is-active --quiet "$name"; then
        echo -e "${GREEN}[OK]${NC} $name is running"
    else
        echo -e "${RED}[FAIL]${NC} $name is NOT running"
        FAILED=1
    fi
}

check_port() {
    local port=$1
    local name=$2
    if nc -z localhost "$port" 2>/dev/null; then
        echo -e "${GREEN}[OK]${NC} $name (port $port) is listening"
    else
        echo -e "${RED}[FAIL]${NC} $name (port $port) is NOT listening"
        FAILED=1
    fi
}

# Check systemd services
check_service "vncserver"
check_service "xfce-session"
check_service "chrome-cdp"
check_service "novnc"
check_service "code-server"
check_service "nginx"
check_service "docker"

echo ""

# Check ports
check_port 80 "nginx"
check_port 5901 "VNC"
check_port 6080 "noVNC"
check_port 9222 "Chrome CDP"
check_port 10080 "code-server"

echo ""

# Check Chrome CDP specifically
echo "Chrome CDP Version:"
CHROME_CDP=$(curl -s http://localhost:9222/json/version 2>/dev/null || echo "")
if [ -n "$CHROME_CDP" ]; then
    echo "$CHROME_CDP" | jq -r '.Browser // "Unknown"'
else
    echo -e "${RED}[FAIL]${NC} Chrome CDP not responding"
    FAILED=1
fi

echo ""

# Check Docker specifically
echo "Docker Version:"
DOCKER_VER=$(docker --version 2>/dev/null || echo "")
if [ -n "$DOCKER_VER" ]; then
    echo -e "${GREEN}[OK]${NC} $DOCKER_VER"
else
    echo -e "${RED}[FAIL]${NC} Docker not responding"
    FAILED=1
fi

# -----------------------------------------------------------------------------
# Create marker file
# -----------------------------------------------------------------------------
touch /dba_base_snapshot_valid
echo "DBA_SNAPSHOT_VERSION=1.0" > /dba_snapshot_info
echo "DBA_SNAPSHOT_DATE=$(date -Iseconds)" >> /dba_snapshot_info

echo ""
echo "=============================================="
if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}       SETUP COMPLETED SUCCESSFULLY!        ${NC}"
    echo "=============================================="
    echo ""
    echo "All services are running. You can now:"
    echo "  1. Save this VM as a snapshot"
    echo "  2. Use this snapshot as the base for DBA workspaces"
    echo ""
    echo "Marker file created: /dba_base_snapshot_valid"
else
    echo -e "${RED}       SETUP COMPLETED WITH ERRORS          ${NC}"
    echo "=============================================="
    echo ""
    echo "Some services failed to start. Please check:"
    echo "  journalctl -u <service-name> -n 50"
    echo ""
    exit 1
fi

echo "Completed at: $(date)"
