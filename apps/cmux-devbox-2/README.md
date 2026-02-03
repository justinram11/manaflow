# cmux

Go CLI for managing E2B cloud sandboxes with VSCode, VNC, and browser automation.

**API:** `/api/v2/cmux/*`

## Build & Install

```bash
cd apps/cmux

# Dev build (uses dev defaults)
make build-dev
make install-dev  # → /usr/local/bin/cmux

# Production build (requires ldflags)
make build STACK_PROJECT_ID=... CONVEX_SITE_URL=...
```

## Quick Start

```bash
# Login (shares credentials with cmux-devbox)
cmux login

# Create a sandbox
cmux start --name my-dev -t austin-dev

# List sandboxes
cmux ls -t austin-dev

# Run a command
cmux exec <id> "echo hello" -t austin-dev

# Open VSCode
cmux open <id> -t austin-dev

# Stop sandbox
cmux stop <id> -t austin-dev
```

## Commands

```
AUTH
  login              Login via browser
  logout             Logout
  whoami             Show current user/team

SANDBOX LIFECYCLE
  start              Create new sandbox (aliases: create, new)
    --name, -n       Name for the sandbox
    --template, -T   E2B template ID
    --open, -o       Open VSCode after creation
  ls                 List sandboxes
  get <id>           Get sandbox details
  stop <id>          Stop sandbox (alias: kill)
  extend <id>        Extend sandbox timeout
    --seconds        Timeout in seconds (default: 3600)

EXECUTE
  exec <id> <cmd>    Run command
    --timeout        Command timeout in seconds (default: 30)

ACCESS
  open <id>          Open VSCode in browser
    --vnc            Open VNC instead

OTHER
  templates          List available E2B templates
  version            Print version info
    -v               Show commit and build time

GLOBAL FLAGS
  --team, -t         Team slug (required)
  --json             Output as JSON
  -v, --verbose      Verbose output
```

## Test Commands

```bash
# 1. Build and install
cd apps/cmux
make build-dev && make install-dev

# 2. Login (if not already)
cmux login

# 3. List sandboxes
cmux ls -t austin-dev

# 4. Create a sandbox
cmux start --name test-sandbox -t austin-dev

# 5. Test commands (replace <id> with actual ID like cmux_abc123)
cmux get <id> -t austin-dev
cmux exec <id> "uname -a" -t austin-dev
cmux exec <id> "ls -la" -t austin-dev
cmux open <id> -t austin-dev
cmux extend <id> --seconds 7200 -t austin-dev

# 6. Cleanup
cmux stop <id> -t austin-dev
```

## Architecture

```
cmux CLI
       │
       ▼
  /api/v2/cmux/*  (Convex HTTP)
       │
       ▼
   E2B API  (server-side, E2B_API_KEY protected)
       │
       ▼
  E2B Sandbox (VSCode, VNC, Chrome)
```

- **Auth:** Stack Auth (shared with cmux-devbox)
- **API:** `/api/v2/cmux/*` endpoints
- **E2B API key:** Server-side only (via Convex internal actions)
