# dba CLI

DevBox Agent (DBA) - Cloud VMs for development.

## Installation

```bash
cd packages/dba
make build
./bin/dba --help
```

## Quick Start

```bash
# 1. Login
dba auth login

# 2. Create a VM
dba start                     # Creates VM, returns ID (e.g., dba_abc123)
dba start ./my-project        # Creates VM and syncs directory

# 3. Access the VM
dba code dba_abc123           # Open VS Code in browser
dba ssh dba_abc123            # SSH into VM
dba vnc dba_abc123            # Open VNC desktop in browser

# 4. Work with the VM
dba exec dba_abc123 "npm install"    # Run commands
dba sync dba_abc123 ./my-project     # Sync files to VM

# 5. Manage VM lifecycle
dba pause dba_abc123          # Pause (preserves state, saves cost)
dba resume dba_abc123         # Resume paused VM
dba delete dba_abc123         # Delete VM permanently

# 6. List VMs
dba ls                        # List all your VMs
```

## Commands

### Authentication

| Command | Description |
|---------|-------------|
| `dba auth login` | Login via browser (opens auth URL) |
| `dba auth logout` | Logout and clear credentials |
| `dba auth status` | Show authentication status |
| `dba auth whoami` | Show current user |

### VM Lifecycle

| Command | Description |
|---------|-------------|
| `dba start [path]` | Create new VM, optionally sync directory |
| `dba start --snapshot <id>` | Create VM from specific snapshot |
| `dba delete <id>` | Delete VM permanently |
| `dba pause <id>` | Pause VM (preserves state) |
| `dba resume <id>` | Resume paused VM |

### Accessing VMs

| Command | Description |
|---------|-------------|
| `dba code <id>` | Open VS Code in browser |
| `dba vnc <id>` | Open VNC desktop in browser |
| `dba ssh <id>` | SSH into VM |

### Working with VMs

| Command | Description |
|---------|-------------|
| `dba exec <id> "<command>"` | Run a command in VM |
| `dba sync <id> <path>` | Sync local directory to VM |
| `dba sync <id> <path> --pull` | Pull files from VM to local |

### Listing and Status

| Command | Description |
|---------|-------------|
| `dba ls` | List all VMs (aliases: `list`, `ps`) |
| `dba status <id>` | Show VM status and URLs |

### Browser Automation

| Command | Description |
|---------|-------------|
| `dba computer snapshot <id>` | Get accessibility tree (interactive elements) |
| `dba computer open <id> <url>` | Navigate browser to URL |
| `dba computer click <id> <selector>` | Click an element (@ref or CSS) |
| `dba computer type <id> <text>` | Type text into focused element |
| `dba computer fill <id> <selector> <value>` | Clear and fill an input field |
| `dba computer press <id> <key>` | Press a key (enter, tab, escape, etc.) |
| `dba computer scroll <id> <direction>` | Scroll page (up, down, left, right) |
| `dba computer screenshot <id> [file]` | Take a screenshot |
| `dba computer back <id>` | Navigate back in history |
| `dba computer forward <id>` | Navigate forward in history |
| `dba computer reload <id>` | Reload current page |
| `dba computer url <id>` | Get current page URL |
| `dba computer title <id>` | Get current page title |
| `dba computer wait <id> <selector>` | Wait for element |
| `dba computer hover <id> <selector>` | Hover over element |

### Other

| Command | Description |
|---------|-------------|
| `dba version` | Show version info |
| `dba completion <shell>` | Generate shell autocompletions (bash/fish/powershell/zsh) |
| `dba help [command]` | Show help for any command |

## Global Flags

| Flag | Description |
|------|-------------|
| `-h, --help` | Show help for a command |
| `--json` | Output as JSON |
| `-v, --verbose` | Verbose output |

## Command Details

### `dba auth <command>`

Login, logout, and check authentication status.

```bash
dba auth login
dba auth logout
dba auth status
dba auth whoami
```

### `dba code <id>`

Open VS Code for a VM in your browser.

```bash
dba code dba_abc123
```

### `dba vnc <id>`

Open the VNC desktop for a VM in your browser.

```bash
dba vnc dba_abc123
```

### `dba ssh <id>`

SSH into a VM.

```bash
dba ssh dba_abc123
```

### `dba completion <shell>`

Generate autocompletion scripts for your shell.

```bash
dba completion bash
dba completion fish
dba completion powershell
dba completion zsh
```

```bash
dba completion <shell> --no-descriptions
```

#### Bash

```bash
source <(dba completion bash)
```

```bash
dba completion bash > /etc/bash_completion.d/dba
```

```bash
dba completion bash > $(brew --prefix)/etc/bash_completion.d/dba
```

#### Fish

```bash
dba completion fish | source
```

```bash
dba completion fish > ~/.config/fish/completions/dba.fish
```

#### PowerShell

```bash
dba completion powershell | Out-String | Invoke-Expression
```

#### Zsh

```bash
echo "autoload -U compinit; compinit" >> ~/.zshrc
```

```bash
source <(dba completion zsh)
```

```bash
dba completion zsh > "${fpath[1]}/_dba"
```

```bash
dba completion zsh > $(brew --prefix)/share/zsh/site-functions/_dba
```

### `dba help [command]`

Show help for any command.

```bash
dba help
dba help start
dba start --help
```

### `dba version`

Print version information.

```bash
dba version
```

### `dba start [path]`

Create a new VM. Optionally sync a local directory.

```bash
dba start                       # Create VM (no sync)
dba start .                     # Create VM, sync current directory
dba start ./my-project          # Create VM, sync specific directory
dba start --snapshot=snap_xxx   # Create from specific snapshot
```

**Output:**
```
Creating VM...
VM created: dba_abc123
Waiting for VM to be ready...

✓ VM is ready!
  ID:       dba_abc123
  VS Code:  https://vscode-morphvm-xxx.http.cloud.morph.so
  VNC:      https://vnc-morphvm-xxx.http.cloud.morph.so
```

### `dba pause <id>`

Pause a VM by its ID. The VM state is preserved and can be resumed later.

```bash
dba pause dba_abc123
```

### `dba resume <id>`

Resume a paused VM by its ID.

```bash
dba resume dba_abc123
```

### `dba delete <id>`

Delete a VM by its ID.

```bash
dba delete dba_abc123
```

### `dba exec <id> "<command>"`

Execute a command in a VM.

```bash
dba exec dba_abc123 "ls -la"
dba exec dba_abc123 "npm install"
dba exec dba_abc123 "whoami && pwd && uname -a"
```

**Output:**
```
root
/root
Linux morphvm 5.10.225 #1 SMP Sun Dec 15 19:32:42 EST 2024 x86_64 GNU/Linux
```

### `dba sync <id> <path>`

Sync a local directory to/from a VM. Files are synced to `/home/user/project/` in the VM.

```bash
dba sync dba_abc123 .                  # Push current directory to VM
dba sync dba_abc123 ./my-project       # Push specific directory to VM
dba sync dba_abc123 ./output --pull    # Pull from VM to local
```

**Excluded by default:** `.git`, `node_modules`, `.next`, `dist`, `build`, `__pycache__`, `.venv`, `venv`, `target`

### `dba ls`

List all your VMs. Aliases: `list`, `ps`

```bash
dba ls
```

**Output:**
```
ID                   STATUS     VS CODE URL
-------------------- ---------- ----------------------------------------
dba_abc123           running
dba_def456           paused
```

### `dba status <id>`

Show detailed status of a VM.

```bash
dba status dba_abc123
```

**Output:**
```
ID:       dba_abc123
Status:   running
VS Code:  https://vscode-morphvm-xxx.http.cloud.morph.so
VNC:      https://vnc-morphvm-xxx.http.cloud.morph.so
```

### `dba computer <command>`

Browser automation commands for controlling Chrome in the VNC desktop via CDP.

#### `dba computer snapshot <id>`

Get an accessibility tree snapshot showing interactive elements.

```bash
dba computer snapshot dba_abc123
```

**Output:**
```
URL: https://example.com
Title: Example Domain

@e1: link "More information..."
@e2: heading "Example Domain"
```

#### `dba computer open <id> <url>`

Navigate the browser to a URL.

```bash
dba computer open dba_abc123 https://google.com
```

#### `dba computer click <id> <selector>`

Click an element by ref (from snapshot) or CSS selector.

```bash
dba computer click dba_abc123 @e1           # Click by ref
dba computer click dba_abc123 "#submit"     # Click by CSS selector
dba computer click dba_abc123 ".btn-login"  # Click by class
```

#### `dba computer type <id> <text>`

Type text into the currently focused element.

```bash
dba computer type dba_abc123 "hello world"
```

#### `dba computer fill <id> <selector> <value>`

Clear an input field and fill it with a new value.

```bash
dba computer fill dba_abc123 @e2 "user@example.com"
dba computer fill dba_abc123 "#email" "user@example.com"
```

#### `dba computer press <id> <key>`

Press a keyboard key.

```bash
dba computer press dba_abc123 enter
dba computer press dba_abc123 tab
dba computer press dba_abc123 escape
```

**Common keys:** `enter`, `tab`, `escape`, `backspace`, `delete`, `space`, `up`, `down`, `left`, `right`

#### `dba computer scroll <id> <direction> [amount]`

Scroll the page. Default amount is 300 pixels.

```bash
dba computer scroll dba_abc123 down
dba computer scroll dba_abc123 up 500
```

**Directions:** `up`, `down`, `left`, `right`

#### `dba computer screenshot <id> [output-file]`

Take a screenshot. If no file is specified, outputs base64-encoded PNG.

```bash
dba computer screenshot dba_abc123                    # Output base64
dba computer screenshot dba_abc123 screenshot.png    # Save to file
dba computer screenshot dba_abc123 --full-page       # Full page capture
```

#### `dba computer back/forward/reload <id>`

Navigation history controls.

```bash
dba computer back dba_abc123
dba computer forward dba_abc123
dba computer reload dba_abc123
```

#### `dba computer url/title <id>`

Get current page URL or title.

```bash
dba computer url dba_abc123     # Output: https://example.com
dba computer title dba_abc123   # Output: Example Domain
```

#### `dba computer wait <id> <selector>`

Wait for an element to be in a specific state.

```bash
dba computer wait dba_abc123 "#content"                   # Wait for visible
dba computer wait dba_abc123 "#loading" --state=hidden    # Wait for hidden
dba computer wait dba_abc123 ".modal" --timeout=10000     # Custom timeout
```

**States:** `visible` (default), `hidden`, `attached`

#### `dba computer hover <id> <selector>`

Hover over an element.

```bash
dba computer hover dba_abc123 @e5
dba computer hover dba_abc123 ".dropdown-trigger"
```

## Examples

### Typical Development Workflow

```bash
# Start of day: create or resume a VM
dba start ./my-project
# → dba_abc123

# Work on your code
dba code dba_abc123        # Opens VS Code in browser

# Run commands
dba exec dba_abc123 "npm run dev"

# Sync changes
dba sync dba_abc123 ./my-project

# End of day: pause to save costs
dba pause dba_abc123

# Next day: resume where you left off
dba resume dba_abc123
```

### Multiple VMs

```bash
# Create multiple VMs for different tasks
dba start ./frontend    # → dba_frontend1
dba start ./backend     # → dba_backend1

# Work on them independently
dba code dba_frontend1
dba code dba_backend1

# List all
dba ls
```

### Browser Automation

```bash
# Navigate to a website
dba computer open dba_abc123 https://github.com/login

# Get interactive elements
dba computer snapshot dba_abc123
# Output:
# @e1: textbox "Username or email address"
# @e2: textbox "Password"
# @e3: button "Sign in"

# Fill in the login form
dba computer fill dba_abc123 @e1 "username"
dba computer fill dba_abc123 @e2 "password"

# Click the submit button
dba computer click dba_abc123 @e3

# Wait for page to load
dba computer wait dba_abc123 ".dashboard"

# Take a screenshot
dba computer screenshot dba_abc123 result.png
```

### Pull Files from VM

```bash
# After building/generating files in VM
dba exec dba_abc123 "npm run build"

# Pull the output
dba sync dba_abc123 ./dist --pull
```

### Shell Completion

```bash
# Bash
dba completion bash > /etc/bash_completion.d/dba

# Zsh
dba completion zsh > "${fpath[1]}/_dba"

# Fish
dba completion fish > ~/.config/fish/completions/dba.fish

# PowerShell
dba completion powershell | Out-String | Invoke-Expression
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DBA_DEV=1` | Use development environment |

## Development

```bash
# Build
make build

# Run directly
go run ./cmd/dba --help

# Build with race detector
make build-race
```

## Testing Browser Automation

The browser automation commands use a worker daemon running inside the VM that wraps `agent-browser` (Vercel's CLI tool) and connects to Chrome via CDP.

### Architecture

```
CLI (your machine)
    │
    ├─→ dba exec: read /var/run/dba/worker-token
    │
    ↓
Worker daemon (https://worker-xxx.http.cloud.morph.so:39377)
    │ Bearer token auth required
    ↓
agent-browser --cdp 9222
    │ localhost only
    ↓
Chrome CDP (127.0.0.1:9222)
```

### Manual Testing on Existing VM

If the VM doesn't have the worker daemon set up yet, you can install it manually:

```bash
# 1. Install agent-browser
go run ./cmd/dba exec <id> "npm install -g agent-browser"

# 2. Upload the worker daemon script
cat packages/dba/worker/server.js | base64 | tr -d '\n' > /tmp/worker_b64.txt
B64=$(cat /tmp/worker_b64.txt)
go run ./cmd/dba exec <id> "echo '$B64' | base64 -d > /usr/local/bin/dba-worker && chmod +x /usr/local/bin/dba-worker"

# 3. Create token directory and start worker
go run ./cmd/dba exec <id> "mkdir -p /var/run/dba"
go run ./cmd/dba exec <id> "nohup node /usr/local/bin/dba-worker > /var/log/dba-worker.log 2>&1 &"

# 4. Verify worker is running
go run ./cmd/dba exec <id> "curl -s http://localhost:39377/health"
# Output: {"status":"ok"}

# 5. Get the auth token
go run ./cmd/dba exec <id> "cat /var/run/dba/worker-token"
```

### Test Commands

```bash
# Get accessibility tree (shows interactive elements with refs like @e1, @e2)
go run ./cmd/dba computer snapshot <id>

# Navigate to a URL
go run ./cmd/dba computer open <id> "https://example.com"

# Get snapshot after navigation
go run ./cmd/dba computer snapshot <id>

# Click an element by ref
go run ./cmd/dba computer click <id> @e2

# Take a screenshot
go run ./cmd/dba computer screenshot <id> /tmp/test.png

# Verify screenshot
file /tmp/test.png
# Output: /tmp/test.png: PNG image data, 1920 x 1080, 8-bit/color RGB, non-interlaced
```

### Test Worker API Directly (inside VM)

```bash
# Get the token
TOKEN=$(go run ./cmd/dba exec <id> "cat /var/run/dba/worker-token")

# Test health (no auth required)
go run ./cmd/dba exec <id> "curl -s http://localhost:39377/health"

# Test snapshot with auth
go run ./cmd/dba exec <id> "curl -s -X POST http://localhost:39377/snapshot -H 'Authorization: Bearer $TOKEN'"

# Test open URL
go run ./cmd/dba exec <id> "curl -s -X POST http://localhost:39377/open -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"url\":\"https://google.com\"}'"

# Test without auth (should fail)
go run ./cmd/dba exec <id> "curl -s -X POST http://localhost:39377/snapshot"
# Output: {"error":"Unauthorized","message":"Valid Bearer token required"}
```

### Rebuilding the Snapshot

To include agent-browser and the worker daemon in new VMs:

```bash
cd /path/to/cmux/apps/devbox/scripts
python create_base_snapshot.py
```

This runs `setup_base_snapshot.sh` which:
1. Installs agent-browser globally via npm
2. Embeds the dba-worker script at `/usr/local/bin/dba-worker`
3. Creates a systemd service `dba-worker.service`
4. Configures Chrome to listen on `127.0.0.1:9222` only (not externally accessible)
