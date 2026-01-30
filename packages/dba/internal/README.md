# DBA CLI (Internal)

This document is for maintainers working on `packages/dba`.

## How it works (high level)

- Entry point: `cmd/dba/main.go` wires version/build info, sets `DBA_DEV=1` for dev builds, and invokes the Cobra CLI.
- Commands: `internal/cli/*` defines Cobra commands. Most commands are directory-scoped (use the current working directory unless a path or `--instance` is provided).
- Auth: `internal/auth` handles Stack Auth login, caches tokens, and fetches team info. Tokens and cached profile live under `~/.config/cmux`.
- State: `internal/state` maps absolute local paths to Morph instance IDs in `~/.config/cmux/dba_state_{dev,prod}.json`.
- VM API: `internal/vm` talks to Convex HTTP endpoints to create/resume/stop instances, exec commands, fetch SSH, and sync files (rsync over SSH).

## Install (make `dba` available on PATH)

Pick one of the options below so you can run `dba --help` directly.

Option A: Makefile install (copies to `/usr/local/bin`)

```bash
cd packages/dba
make build
sudo make install
```

Option B: Go install to a user bin dir

```bash
cd packages/dba
GOBIN="$HOME/.local/bin" go install ./cmd/dba
export PATH="$HOME/.local/bin:$PATH"
```

Verify:

```bash
dba --help
dba version
```

## Run (local dev)

```bash
dba auth login
dba up
dba code
dba sync
dba down
```

Notes:
- Use `dba up <path>` to bind a specific directory.
- Use `--instance=<id>` to target a VM directly, bypassing directory lookup.
- Set `DBA_DEV=1` to force dev auth/config. Set `DBA_PROD=1` to avoid auto-dev mode.

## Test

```bash
cd packages/dba
go test ./...
```

Quick smoke checks:

```bash
dba --help
dba auth login
```
