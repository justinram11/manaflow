#!/usr/bin/env bash
set -euo pipefail

BASE_IMAGE="${1:-}"
VM_NAME="${2:-cmux-ios-dev}"
VM_MEMORY_MIB="${3:-8192}"
VM_CPU_COUNT="${4:-4}"

if [[ -z "${BASE_IMAGE}" ]]; then
  echo "Usage: tart-create-vm.sh <base-image> [vm-name] [memory-mib] [cpu-count]" >&2
  exit 1
fi

if ! command -v tart >/dev/null 2>&1; then
  echo "tart is not installed or not on PATH" >&2
  exit 1
fi

if ! tart list | awk '{print $1}' | grep -Fxq "${VM_NAME}"; then
  tart clone "${BASE_IMAGE}" "${VM_NAME}"
fi

tart set "${VM_NAME}" --memory "${VM_MEMORY_MIB}" --cpu "${VM_CPU_COUNT}"

echo "VM ready: ${VM_NAME}"
