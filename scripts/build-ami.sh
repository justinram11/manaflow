#!/usr/bin/env bash
#
# Build the cmux workspace golden AMI for AWS EC2 (ARM/Graviton).
#
# This script:
#   1. Launches a base Ubuntu 24.04 ARM instance
#   2. SSHs in and installs all workspace dependencies
#   3. Creates an AMI from the configured instance
#   4. Terminates the build instance
#   5. Optionally copies the AMI to other regions
#
# Prerequisites:
#   - AWS CLI v2 configured with credentials
#   - An existing VPC/subnet/SG (use infra/aws/main.tf first)
#   - A key pair for SSH access during build
#
# Usage:
#   ./scripts/build-ami.sh \
#     --region us-east-2 \
#     --subnet-id subnet-xxx \
#     --security-group-id sg-xxx \
#     --key-name my-key \
#     --key-file ~/.ssh/my-key.pem
#
# Optional:
#   --instance-type t4g.large       # Build instance type (default: t4g.large)
#   --copy-to-regions eu-west-1,ap-southeast-1
#   --ami-name "cmux-workspace-v1"  # AMI name (default: auto-generated)

set -euo pipefail

# --- Parse arguments ---
REGION="us-east-2"
INSTANCE_TYPE="t4g.large"
SUBNET_ID=""
SG_ID=""
KEY_NAME=""
KEY_FILE=""
COPY_TO_REGIONS=""
AMI_NAME="cmux-workspace-$(date +%Y%m%d-%H%M%S)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --instance-type) INSTANCE_TYPE="$2"; shift 2 ;;
    --subnet-id) SUBNET_ID="$2"; shift 2 ;;
    --security-group-id) SG_ID="$2"; shift 2 ;;
    --key-name) KEY_NAME="$2"; shift 2 ;;
    --key-file) KEY_FILE="$2"; shift 2 ;;
    --copy-to-regions) COPY_TO_REGIONS="$2"; shift 2 ;;
    --ami-name) AMI_NAME="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ -z "$SUBNET_ID" || -z "$SG_ID" || -z "$KEY_NAME" || -z "$KEY_FILE" ]]; then
  echo "Required: --subnet-id, --security-group-id, --key-name, --key-file"
  exit 1
fi

echo "=== Building cmux workspace AMI ==="
echo "Region: $REGION"
echo "Instance type: $INSTANCE_TYPE"
echo "AMI name: $AMI_NAME"

# --- Find latest Ubuntu 24.04 ARM AMI ---
echo "Finding base Ubuntu 24.04 ARM AMI..."
BASE_AMI=$(aws ec2 describe-images \
  --region "$REGION" \
  --owners 099720109477 \
  --filters \
    "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*" \
    "Name=architecture,Values=arm64" \
    "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
  --output text)

echo "Base AMI: $BASE_AMI"

# --- Launch build instance ---
echo "Launching build instance..."
INSTANCE_ID=$(aws ec2 run-instances \
  --region "$REGION" \
  --image-id "$BASE_AMI" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --subnet-id "$SUBNET_ID" \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":48,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=cmux-ami-builder}]" \
  --query 'Instances[0].InstanceId' \
  --output text)

echo "Build instance: $INSTANCE_ID"

# Cleanup on exit
cleanup() {
  echo "Terminating build instance $INSTANCE_ID..."
  aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID" || true
}
trap cleanup EXIT

# --- Wait for instance to be running ---
echo "Waiting for instance to be running..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"

PUBLIC_IP=$(aws ec2 describe-instances \
  --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

echo "Build instance IP: $PUBLIC_IP"

# --- Wait for SSH to be available ---
echo "Waiting for SSH..."
for i in $(seq 1 30); do
  if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -i "$KEY_FILE" "ubuntu@$PUBLIC_IP" true 2>/dev/null; then
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "SSH timeout"
    exit 1
  fi
  sleep 5
done

echo "SSH connected"

# --- Run setup script on the instance ---
echo "Installing workspace dependencies..."
ssh -o StrictHostKeyChecking=no -i "$KEY_FILE" "ubuntu@$PUBLIC_IP" 'sudo bash -s' << 'SETUP_SCRIPT'
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive

# --- System updates ---
apt-get update
apt-get upgrade -y

# --- Core tools ---
apt-get install -y \
  curl wget git unzip jq htop tmux \
  build-essential pkg-config libssl-dev \
  ca-certificates gnupg lsb-release \
  xvfb fluxbox x11vnc tigervnc-standalone-server \
  socat net-tools iproute2

# --- Docker ---
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# --- Node.js 24 ---
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs

# --- Bun ---
curl -fsSL https://bun.sh/install | bash
ln -sf /root/.bun/bin/bun /usr/local/bin/bun

# --- Git (latest) ---
add-apt-repository -y ppa:git-core/ppa
apt-get update
apt-get install -y git

# --- GitHub CLI ---
(type -p wget >/dev/null || apt-get install wget -y) \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update \
  && apt-get install gh -y

# --- noVNC (web-based VNC client) ---
git clone --depth 1 https://github.com/novnc/noVNC.git /opt/noVNC
git clone --depth 1 https://github.com/novnc/websockify.git /opt/noVNC/utils/websockify
ln -sf /opt/noVNC/vnc.html /opt/noVNC/index.html

# --- OpenVSCode Server ---
OPENVSCODE_VERSION="1.96.4"
ARCH="arm64"
curl -fsSL "https://github.com/nicedoc/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_VERSION}/openvscode-server-v${OPENVSCODE_VERSION}-linux-${ARCH}.tar.gz" \
  | tar xz -C /opt/
mv "/opt/openvscode-server-v${OPENVSCODE_VERSION}-linux-${ARCH}" /opt/openvscode-server

# --- Tailscale ---
curl -fsSL https://tailscale.com/install.sh | sh

# --- cmux exec daemon ---
# Build from source (Go is needed temporarily)
apt-get install -y golang-go
mkdir -p /tmp/execd-build
# The execd binary will be copied from the repo during AMI build
# For now, create a placeholder that will be replaced
cat > /tmp/execd-build/main.go << 'EXECD_GO'
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"os"
	"sync"
	"time"
)

type execRequest struct {
	Command   string `json:"command"`
	TimeoutMs *int   `json:"timeout_ms"`
}

type execEvent struct {
	Type    string `json:"type"`
	Data    string `json:"data,omitempty"`
	Code    *int   `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

func writeJSONLine(w io.Writer, flusher http.Flusher, event execEvent) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err = w.Write(append(payload, '\n')); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

func readPipe(ctx context.Context, reader io.Reader, eventType string, wg *sync.WaitGroup, w io.Writer, flusher http.Flusher) {
	defer wg.Done()
	scanner := bufio.NewScanner(reader)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return
		default:
		}
		line := strings.TrimRight(scanner.Text(), "\r")
		if line == "" {
			continue
		}
		if err := writeJSONLine(w, flusher, execEvent{Type: eventType, Data: line}); err != nil {
			return
		}
	}
}

func execHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	var payload execRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		return
	}

	command := strings.TrimSpace(payload.Command)
	if command == "" {
		http.Error(w, "Command is required", http.StatusBadRequest)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/jsonlines")
	w.WriteHeader(http.StatusOK)

	ctx := context.Background()
	var cancel context.CancelFunc
	if payload.TimeoutMs != nil && *payload.TimeoutMs > 0 {
		ctx, cancel = context.WithTimeout(ctx, time.Duration(*payload.TimeoutMs)*time.Millisecond)
	} else {
		ctx, cancel = context.WithCancel(ctx)
	}
	defer cancel()

	go func() {
		select {
		case <-r.Context().Done():
			cancel()
		case <-ctx.Done():
		}
	}()

	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", command)
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		exitCode := 127
		_ = writeJSONLine(w, flusher, execEvent{Type: "error", Message: err.Error()})
		_ = writeJSONLine(w, flusher, execEvent{Type: "exit", Code: &exitCode})
		return
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go readPipe(r.Context(), stdout, "stdout", &wg, w, flusher)
	go readPipe(r.Context(), stderr, "stderr", &wg, w, flusher)

	waitErr := cmd.Wait()
	wg.Wait()

	exitCode := 0
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
	}
	_ = writeJSONLine(w, flusher, execEvent{Type: "exit", Code: &exitCode})
}

func main() {
	portFlag := flag.Int("port", 39375, "port to listen on")
	flag.Parse()
	port := *portFlag
	if env := os.Getenv("EXECD_PORT"); env != "" {
		if v, err := strconv.Atoi(env); err == nil {
			port = v
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/exec", execHandler)

	log.Printf("cmux exec daemon listening on :%d", port)
	if err := (&http.Server{Addr: fmt.Sprintf(":%d", port), Handler: mux, ReadHeaderTimeout: 10 * time.Second}).ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
EXECD_GO
cd /tmp/execd-build && CGO_ENABLED=0 go build -o /usr/local/bin/cmux-execd main.go
rm -rf /tmp/execd-build
apt-get remove -y golang-go && apt-get autoremove -y

# --- systemd services ---

# Exec daemon
cat > /etc/systemd/system/cmux-execd.service << 'EOF'
[Unit]
Description=cmux exec daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cmux-execd
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

# OpenVSCode Server
cat > /etc/systemd/system/cmux-vscode.service << 'EOF'
[Unit]
Description=cmux OpenVSCode Server
After=network.target

[Service]
Type=simple
ExecStart=/opt/openvscode-server/bin/openvscode-server --host 0.0.0.0 --port 39378 --without-connection-token
Restart=always
RestartSec=2
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
EOF

# VNC server (Xvfb + TigerVNC + noVNC)
cat > /etc/systemd/system/cmux-xvfb.service << 'EOF'
[Unit]
Description=cmux Xvfb display server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :1 -screen 0 1920x1080x24
Restart=always

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/cmux-tigervnc.service << 'EOF'
[Unit]
Description=cmux TigerVNC server
After=cmux-xvfb.service
Requires=cmux-xvfb.service

[Service]
Type=simple
ExecStart=/usr/bin/x0vncserver -display :1 -rfbport 5900 -SecurityTypes None
Restart=always
Environment=DISPLAY=:1

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/cmux-novnc.service << 'EOF'
[Unit]
Description=cmux noVNC web client
After=cmux-tigervnc.service

[Service]
Type=simple
ExecStart=/opt/noVNC/utils/novnc_proxy --vnc localhost:5900 --listen 39380
Restart=always

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/cmux-fluxbox.service << 'EOF'
[Unit]
Description=cmux Fluxbox window manager
After=cmux-xvfb.service
Requires=cmux-xvfb.service

[Service]
Type=simple
ExecStart=/usr/bin/fluxbox
Restart=always
Environment=DISPLAY=:1

[Install]
WantedBy=multi-user.target
EOF

# PTY server (placeholder — will use the one from the sandbox image)
cat > /etc/systemd/system/cmux-pty.service << 'EOF'
[Unit]
Description=cmux PTY server
After=network.target

[Service]
Type=simple
# This will be configured with the actual PTY binary from the sandbox image
ExecStart=/bin/true
Restart=no

[Install]
WantedBy=multi-user.target
EOF

# Enable services to start on boot
systemctl enable cmux-execd cmux-vscode cmux-xvfb cmux-tigervnc cmux-novnc cmux-fluxbox
systemctl enable docker
# Tailscale is enabled but not started — user-data will call `tailscale up`
systemctl enable tailscaled

# --- Create workspace directory ---
mkdir -p /root/workspace

# --- Cleanup ---
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
journalctl --vacuum-time=1s

echo "=== Setup complete ==="
SETUP_SCRIPT

echo "Setup complete on build instance"

# --- Stop the instance before creating AMI ---
echo "Stopping instance for clean AMI creation..."
aws ec2 stop-instances --region "$REGION" --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-stopped --region "$REGION" --instance-ids "$INSTANCE_ID"

# --- Create AMI ---
echo "Creating AMI: $AMI_NAME..."
AMI_ID=$(aws ec2 create-image \
  --region "$REGION" \
  --instance-id "$INSTANCE_ID" \
  --name "$AMI_NAME" \
  --description "cmux workspace golden AMI (ARM/Graviton)" \
  --tag-specifications "ResourceType=image,Tags=[{Key=Name,Value=$AMI_NAME},{Key=cmux:type,Value=workspace-snapshot}]" \
  --query 'ImageId' \
  --output text)

echo "AMI created: $AMI_ID"

# Wait for AMI to be available
echo "Waiting for AMI to be available (this may take several minutes)..."
aws ec2 wait image-available --region "$REGION" --image-ids "$AMI_ID"
echo "AMI is available: $AMI_ID"

# --- Copy to other regions ---
if [[ -n "$COPY_TO_REGIONS" ]]; then
  IFS=',' read -ra REGIONS <<< "$COPY_TO_REGIONS"
  for TARGET_REGION in "${REGIONS[@]}"; do
    echo "Copying AMI to $TARGET_REGION..."
    COPY_AMI_ID=$(aws ec2 copy-image \
      --region "$TARGET_REGION" \
      --source-region "$REGION" \
      --source-image-id "$AMI_ID" \
      --name "$AMI_NAME" \
      --description "cmux workspace golden AMI (copied from $REGION)" \
      --query 'ImageId' \
      --output text)
    echo "  $TARGET_REGION: $COPY_AMI_ID"
  done
fi

echo ""
echo "=== AMI Build Complete ==="
echo "Region: $REGION"
echo "AMI ID: $AMI_ID"
echo "AMI Name: $AMI_NAME"
echo ""
echo "Set this in your .env:"
echo "  AWS_EC2_AMI_IDS={\"$REGION\":\"$AMI_ID\"}"
