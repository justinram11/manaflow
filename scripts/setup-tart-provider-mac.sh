#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SERVER_URL=""
PROVIDER_TOKEN=""
DAEMON_DIR="${REPO_ROOT}/packages/provider-daemon"
INSTALL_PROVIDER=0
INSTALL_HOST_PROVIDER=0
INSTALL_BREW=1
INSTALL_TART=1
INSTALL_ORCHARD=0
CREATE_VM=0
START_VM=0
BASE_IMAGE=""
VM_NAME="cmux-ios-dev"
VM_MEMORY_MIB="8192"
VM_CPU_COUNT="4"
BOOT_TIMEOUT_SEC="300"
HOST_RUNNER_DIR="${HOME}/.cmux/bin"
HOST_RUNNER_PATH="${HOST_RUNNER_DIR}/tart-run-vm"
HOST_LOG_DIR="${HOME}/.cmux/logs"
HOST_TART_PLIST="${HOME}/Library/LaunchAgents/com.cmux.tart-cmux-ios-dev.plist"

usage() {
  cat <<'EOF'
Usage: setup-tart-provider-mac.sh [options]

Options:
  --server-url <url>         cmux server URL
  --provider-token <token>   cmux provider registration token
  --daemon-dir <path>        Provider daemon directory (legacy host provider only)
  --install-host-provider    Install the old host-side provider daemon instead of the Tart guest provider
  --no-brew                  Skip Homebrew installation
  --no-tart                  Skip Tart installation
  --install-orchard          Install Orchard alongside Tart
  --create-vm                Clone/configure a Tart VM after install
  --start-vm                 Start the VM after creation
  --base-image <ref>         Tart base image reference for clone
  --vm-name <name>           Tart VM name (default: cmux-ios-dev)
  --vm-memory-mib <mib>      Tart VM memory in MiB (default: 8192)
  --vm-cpu <count>           Tart VM CPU count (default: 4)
  --boot-timeout-sec <sec>   Seconds to wait for Tart guest exec readiness (default: 300)
  --help                     Show this help text

Notes:
  - This script is intended to be run locally on an Apple Silicon Mac.
  - If --server-url and --provider-token are provided, the default behavior is
    to install the provider daemon inside the Tart VM and configure the host to
    auto-start that VM on login/boot.
  - Use --install-host-provider only for the legacy direct host simulator mode.
  - VM creation requires a Tart base image reference such as a Cirrus macOS image.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url)
      SERVER_URL="${2:-}"
      shift 2
      ;;
    --provider-token)
      PROVIDER_TOKEN="${2:-}"
      shift 2
      ;;
    --daemon-dir)
      DAEMON_DIR="${2:-}"
      shift 2
      ;;
    --install-host-provider)
      INSTALL_HOST_PROVIDER=1
      shift
      ;;
    --no-brew)
      INSTALL_BREW=0
      shift
      ;;
    --no-tart)
      INSTALL_TART=0
      shift
      ;;
    --install-orchard)
      INSTALL_ORCHARD=1
      shift
      ;;
    --create-vm)
      CREATE_VM=1
      shift
      ;;
    --start-vm)
      START_VM=1
      shift
      ;;
    --base-image)
      BASE_IMAGE="${2:-}"
      shift 2
      ;;
    --vm-name)
      VM_NAME="${2:-}"
      shift 2
      ;;
    --vm-memory-mib)
      VM_MEMORY_MIB="${2:-}"
      shift 2
      ;;
    --vm-cpu)
      VM_CPU_COUNT="${2:-}"
      shift 2
      ;;
    --boot-timeout-sec)
      BOOT_TIMEOUT_SEC="${2:-}"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "${CREATE_VM}" -eq 1 && -z "${BASE_IMAGE}" ]]; then
  echo "--create-vm requires --base-image" >&2
  exit 1
fi

if [[ -n "${SERVER_URL}" || -n "${PROVIDER_TOKEN}" ]]; then
  if [[ -z "${SERVER_URL}" || -z "${PROVIDER_TOKEN}" ]]; then
    echo "--server-url and --provider-token must be provided together" >&2
    exit 1
  fi
  INSTALL_PROVIDER=1
fi

if ! [[ "${BOOT_TIMEOUT_SEC}" =~ ^[0-9]+$ ]] || [[ "${BOOT_TIMEOUT_SEC}" -lt 1 ]]; then
  echo "--boot-timeout-sec must be a positive integer" >&2
  exit 1
fi

PLATFORM="$(uname -s)"
ARCH="$(uname -m)"

if [[ "${PLATFORM}" != "Darwin" ]]; then
  echo "This script only supports macOS hosts" >&2
  exit 1
fi

if [[ "${ARCH}" != "arm64" ]]; then
  echo "This script expects Apple Silicon (arm64). Found: ${ARCH}" >&2
  exit 1
fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode Command Line Tools are required. Run: xcode-select --install" >&2
  exit 1
fi

ensure_brew() {
  if command -v brew >/dev/null 2>&1; then
    return
  fi

  if [[ "${INSTALL_BREW}" -ne 1 ]]; then
    echo "Homebrew is required but --no-brew was passed" >&2
    exit 1
  fi

  NONINTERACTIVE=1 /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
}

load_brew_env() {
  if [[ -x "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    return
  fi

  if command -v brew >/dev/null 2>&1; then
    local brew_bin
    brew_bin="$(command -v brew)"
    eval "$("${brew_bin}" shellenv)"
  fi
}

ensure_formula() {
  local formula="$1"
  if brew list "${formula}" >/dev/null 2>&1; then
    return
  fi
  brew install "${formula}"
}

configure_provider() {
  "${REPO_ROOT}/scripts/setup-provider.sh" \
    --token "${PROVIDER_TOKEN}" \
    --server "${SERVER_URL}" \
    --daemon-dir "${DAEMON_DIR}"
}

shell_quote() {
  printf "%q" "$1"
}

run_with_timeout() {
  local timeout_sec="$1"
  shift

  python3 - "$timeout_sec" "$@" <<'PY'
import subprocess
import sys

timeout = float(sys.argv[1])
cmd = sys.argv[2:]

try:
    completed = subprocess.run(cmd, timeout=timeout, check=False)
except subprocess.TimeoutExpired:
    sys.exit(124)

sys.exit(completed.returncode)
PY
}

ensure_tart_vm() {
  local vm_name="$1"
  local base_image="$2"
  local memory_mib="$3"
  local cpu_count="$4"

  if ! tart list | awk '{print $1}' | grep -Fxq "${vm_name}"; then
    tart clone "${base_image}" "${vm_name}"
  fi

  tart set "${vm_name}" --memory "${memory_mib}" --cpu "${cpu_count}"
}

vm_exists() {
  local vm_name="$1"
  tart list | awk '$1 == "local" { print $2 }' | grep -Fxq "${vm_name}"
}

vm_is_running() {
  local vm_name="$1"
  tart list | awk -v name="${vm_name}" '$1 == "local" && $2 == name && $NF == "running" { found = 1 } END { exit(found ? 0 : 1) }'
}

uninstall_legacy_host_provider() {
  local plist_path="${HOME}/Library/LaunchAgents/com.cmux.provider.plist"
  local launchd_domain="gui/$(id -u)"
  if [[ -f "${plist_path}" ]]; then
    echo "==> Removing legacy host-side provider launch agent"
    launchctl bootout "${launchd_domain}" "${plist_path}" >/dev/null 2>&1 || true
    rm -f "${plist_path}"
  fi
  rm -f "${HOME}/.cmux/provider/config.json"
}

install_tart_runner_script() {
  mkdir -p "${HOST_RUNNER_DIR}" "${HOST_LOG_DIR}"
  cat > "${HOST_RUNNER_PATH}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: tart-run-vm <vm-name>" >&2
  exit 1
fi

VM_NAME="$1"
export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"

exec /opt/homebrew/bin/tart run "${VM_NAME}"
EOF
  chmod +x "${HOST_RUNNER_PATH}"
}

install_tart_launch_agent() {
  local vm_name="$1"
  local launchd_domain="gui/$(id -u)"
  mkdir -p "${HOME}/Library/LaunchAgents" "${HOST_LOG_DIR}"
  cat > "${HOST_TART_PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cmux.tart-cmux-ios-dev</string>
  <key>ProgramArguments</key>
  <array>
    <string>${HOST_RUNNER_PATH}</string>
    <string>${vm_name}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${HOST_LOG_DIR}/tart-${vm_name}.log</string>
  <key>StandardErrorPath</key>
  <string>${HOST_LOG_DIR}/tart-${vm_name}.log</string>
</dict>
</plist>
EOF

  launchctl bootout "${launchd_domain}" "${HOST_TART_PLIST}" >/dev/null 2>&1 || true
  launchctl bootstrap "${launchd_domain}" "${HOST_TART_PLIST}"
  launchctl enable "${launchd_domain}/com.cmux.tart-cmux-ios-dev"
}

start_tart_vm() {
  local vm_name="$1"

  if vm_is_running "${vm_name}"; then
    echo "==> Tart VM ${vm_name} already running"
    return
  fi

  launchctl kickstart -k "gui/$(id -u)/com.cmux.tart-cmux-ios-dev" >/dev/null 2>&1 || true

  if vm_is_running "${vm_name}"; then
    echo "==> Started ${vm_name} via launchd"
    return
  fi

  nohup "${HOST_RUNNER_PATH}" "${vm_name}" >"${HOST_LOG_DIR}/tart-${vm_name}.log" 2>&1 &
  echo "==> Started ${vm_name}; logs: ${HOST_LOG_DIR}/tart-${vm_name}.log"
}

wait_for_tart_guest() {
  local vm_name="$1"
  local timeout_sec="$2"
  local start_time
  start_time="$(date +%s)"

  echo "==> Waiting for Tart guest agent in ${vm_name}"
  while true; do
    if run_with_timeout 10 tart exec "${vm_name}" /usr/bin/true >/dev/null 2>&1; then
      return 0
    fi

    if (( "$(date +%s)" - start_time >= timeout_sec )); then
      echo "Timed out waiting for Tart guest agent in ${vm_name}" >&2
      return 1
    fi
    sleep 5
  done
}

build_guest_provider_bundle() {
  local bundle_dir="$1"

  rm -rf "${bundle_dir}"
  mkdir -p \
    "${bundle_dir}/provider-daemon" \
    "${bundle_dir}/mac-resource-provider"

  cp -R "${REPO_ROOT}/packages/provider-daemon/src" "${bundle_dir}/provider-daemon/"
  cp -R "${REPO_ROOT}/packages/mac-resource-provider/src" "${bundle_dir}/mac-resource-provider/"
  cp "${REPO_ROOT}/packages/provider-daemon/package.json" "${bundle_dir}/provider-daemon/package.json"
  cp "${REPO_ROOT}/packages/provider-daemon/tsconfig.json" "${bundle_dir}/provider-daemon/tsconfig.json"
  cp "${REPO_ROOT}/packages/mac-resource-provider/package.json" \
    "${bundle_dir}/mac-resource-provider/package.json"
  cp "${REPO_ROOT}/packages/mac-resource-provider/tsconfig.json" \
    "${bundle_dir}/mac-resource-provider/tsconfig.json"
  cp "${REPO_ROOT}/tsconfig.base.json" "${bundle_dir}/tsconfig.base.json"

  python3 - "${bundle_dir}/provider-daemon/package.json" <<'PY'
import json
import pathlib
import sys

package_path = pathlib.Path(sys.argv[1])
package_data = json.loads(package_path.read_text())
package_data["dependencies"]["@cmux/mac-resource-provider"] = "file:../mac-resource-provider"
package_path.write_text(json.dumps(package_data, indent=2) + "\n")
PY
}

install_guest_provider() {
  local vm_name="$1"
  local server_url="$2"
  local provider_token="$3"
  local bundle_dir
  local quoted_server_url
  local quoted_provider_token

  quoted_server_url="$(shell_quote "${server_url}")"
  quoted_provider_token="$(shell_quote "${provider_token}")"

  wait_for_tart_guest "${vm_name}" "${BOOT_TIMEOUT_SEC}"

  bundle_dir="$(mktemp -d)"
  build_guest_provider_bundle "${bundle_dir}"

  echo "==> Copying cmux provider runtime bundle into Tart VM ${vm_name}"
  tar -C "${bundle_dir}" -czf - . | \
    tart exec -i "${vm_name}" /bin/sh -lc \
      "mkdir -p \"\$HOME/.cmux/runtime\" && \
       rm -rf \"\$HOME/.cmux/runtime/provider-daemon\" \"\$HOME/.cmux/runtime/mac-resource-provider\" && \
       tar -xzf - -C \"\$HOME/.cmux/runtime\""

  echo "==> Installing cmux provider daemon inside Tart VM ${vm_name}"
  cat "${REPO_ROOT}/scripts/setup-provider.sh" | \
    tart exec -i "${vm_name}" /bin/sh -lc \
      "cat > /tmp/setup-provider.sh && chmod +x /tmp/setup-provider.sh && /tmp/setup-provider.sh --server ${quoted_server_url} --token ${quoted_provider_token} --daemon-dir \"\$HOME/.cmux/runtime/provider-daemon\" && rm -f /tmp/setup-provider.sh"

  rm -rf "${bundle_dir}"

  echo "==> Disabling screen lock and enabling auto-login in guest VM"
  run_with_timeout 30 tart exec "${vm_name}" /bin/sh -lc \
    "defaults write com.apple.screensaver idleTime -int 0 && \
     defaults write com.apple.screensaver askForPassword -int 0 && \
     defaults write com.apple.screensaver askForPasswordDelay -int 0 && \
     defaults -currentHost write com.apple.screensaver idleTime -int 0 && \
     defaults -currentHost write com.apple.screensaver askForPassword -int 0 && \
     defaults write com.apple.loginwindow autoLoginUser -string \"\$(whoami)\" && \
     sudo defaults write /Library/Preferences/com.apple.RemoteManagement VNCAlwaysStartOnConsole -bool true && \
     sudo defaults write /Library/Preferences/com.apple.RemoteManagement ScreenSharingEnableAudio -bool false && \
     sudo defaults write /Library/Preferences/com.apple.RemoteDesktop DOCAllowAudioCapture -bool false && \
     sudo defaults write /Library/Preferences/com.apple.loginwindow DisableScreenLockImmediate -bool true && \
     sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \
       -activate -configure -allowAccessFor -allUsers -privs -all \
       -clientopts -setreqperm -reqperm no \
       -setvnclegacy -vnclegacy yes -setvncpw -vncpw admin \
       -restart -agent && \
     sysadminctl -screenLock off -password admin 2>/dev/null || true"

  echo "==> Verifying guest provider launch agent"
  run_with_timeout 20 tart exec "${vm_name}" /bin/sh -lc \
    "launchctl list | grep -i com.cmux.provider || true"
}

echo "==> Host: $(scutil --get ComputerName 2>/dev/null || hostname)"
echo "==> Ensuring Homebrew"
ensure_brew
load_brew_env

if ! command -v brew >/dev/null 2>&1; then
  echo "brew is still unavailable after installation" >&2
  exit 1
fi

brew tap cirruslabs/cli >/dev/null 2>&1 || true

if [[ "${INSTALL_TART}" -eq 1 ]]; then
  echo "==> Installing Tart"
  ensure_formula "cirruslabs/cli/tart"
  tart --version
fi

if [[ "${INSTALL_ORCHARD}" -eq 1 ]]; then
  echo "==> Installing Orchard"
  ensure_formula "cirruslabs/cli/orchard"
  orchard version || true
fi

if [[ "${INSTALL_PROVIDER}" -eq 1 ]]; then
  if [[ "${INSTALL_HOST_PROVIDER}" -eq 1 ]]; then
    echo "==> Installing legacy host-side cmux provider daemon"
    configure_provider
  else
    uninstall_legacy_host_provider
  fi
fi

if [[ "${CREATE_VM}" -eq 1 ]]; then
  echo "==> Creating/configuring Tart VM ${VM_NAME}"
  ensure_tart_vm "${VM_NAME}" "${BASE_IMAGE}" "${VM_MEMORY_MIB}" "${VM_CPU_COUNT}"
elif [[ "${INSTALL_PROVIDER}" -eq 1 && "${INSTALL_HOST_PROVIDER}" -ne 1 ]]; then
  if ! vm_exists "${VM_NAME}"; then
    echo "Tart VM ${VM_NAME} does not exist. Re-run with --create-vm --base-image <ref> or choose an existing VM name." >&2
    exit 1
  fi
fi

if vm_exists "${VM_NAME}"; then
  echo "==> Installing Tart auto-start launch agent"
  install_tart_runner_script
  install_tart_launch_agent "${VM_NAME}"
fi

if [[ "${START_VM}" -eq 1 || ( "${INSTALL_PROVIDER}" -eq 1 && "${INSTALL_HOST_PROVIDER}" -ne 1 ) ]]; then
  echo "==> Starting Tart VM ${VM_NAME}"
  start_tart_vm "${VM_NAME}"
fi

if [[ "${INSTALL_PROVIDER}" -eq 1 && "${INSTALL_HOST_PROVIDER}" -ne 1 ]]; then
  install_guest_provider "${VM_NAME}" "${SERVER_URL}" "${PROVIDER_TOKEN}"
fi

echo "==> Complete"
