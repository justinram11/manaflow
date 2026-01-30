# dba CLI

DevBox Agent CLI - Cloud VMs for development.

## Quick Start

```bash
# Build
cd packages/dba
make build

# Login
./bin/dba auth login

# Create a VM (syncs your project directory)
./bin/dba start ./my-project
# → dba_abc123

# Use the ID for all commands
./bin/dba code dba_abc123      # Open VS Code
./bin/dba ssh dba_abc123       # SSH into VM
./bin/dba sync dba_abc123 .    # Sync files
./bin/dba pause dba_abc123     # Pause (preserves state)
./bin/dba resume dba_abc123    # Resume
./bin/dba delete dba_abc123    # Delete VM
```

## Commands

| Command | Description |
|---------|-------------|
| `dba start [path]` | Create new VM, optionally sync directory |
| `dba delete <id>` | Delete VM |
| `dba pause <id>` | Pause VM (preserves state) |
| `dba resume <id>` | Resume paused VM |
| `dba code <id>` | Open VS Code in browser |
| `dba vnc <id>` | Open VNC desktop in browser |
| `dba ssh <id>` | SSH into VM |
| `dba exec <id> "cmd"` | Run command in VM |
| `dba sync <id> <path>` | Sync local directory to VM |
| `dba sync <id> <path> --pull` | Pull files from VM |
| `dba status <id>` | Show VM status |
| `dba ls` | List all VMs (aliases: `list`, `ps`) |

### Authentication

| Command | Description |
|---------|-------------|
| `dba auth login` | Login via browser |
| `dba auth logout` | Logout and clear credentials |
| `dba auth status` | Show authentication status |
| `dba auth whoami` | Show current user (alias for status) |

### Other

| Command | Description |
|---------|-------------|
| `dba version` | Show version info |

## Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |
| `-v, --verbose` | Verbose output |

## Multiple VMs

You can create multiple VMs from the same directory:

```bash
# Create multiple VMs
dba start ./my-project    # → dba_abc123
dba start ./my-project    # → dba_def456

# Work with them independently
dba code dba_abc123
dba code dba_def456

# List all
dba ls
```

## Development

```bash
# Build
make build

# Run
./bin/dba --help

# Or run directly
go run ./cmd/dba --help
```

## Dev Mode

Set `DBA_DEV=1` to use development environment:

```bash
DBA_DEV=1 ./bin/dba auth login
```
