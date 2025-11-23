#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ">>> Rebuilding and installing CLI..."
"${SCRIPT_DIR}/build-cli.sh"

echo ""
echo ">>> Restarting Sandbox Server..."
"${SCRIPT_DIR}/cmux-cli.sh" server restart

echo ""
echo "✅ Dev environment reloaded!"
