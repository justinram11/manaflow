# AWS EC2 Compute Provider — Design Decisions

## Architecture

- **Direct EC2 instances with AMI snapshots** (not Incus-on-EC2). Simpler stack, native AWS tooling, no nested virtualization overhead.
- **Follows the Morph provider pattern**: direct SDK calls from `apps/www`, no separate per-region daemon process.
- **ARM/Graviton** (`t4g.2xlarge` default). All devs on Apple Silicon, so architecture parity. ~20% cheaper than x86 equivalents.

## Networking

- **Tailscale mesh networking** with a dedicated cmux tailnet. Each EC2 workspace joins the tailnet on boot via ephemeral pre-authorized auth key with `tag:workspace` ACL tags.
- **Node sharing** to external tailnets (e.g., a developer's personal tailnet) via the Tailscale API, so devs access workspaces without joining the cmux tailnet directly.
- **No SSH required**. The HTTP exec daemon (`scripts/execd/main.go`) on port 39375 accepts `POST /exec` with JSON commands, returning JSONL-streamed stdout/stderr/exit. The AWS provider calls this over Tailscale.
- **Security groups** allow only: SSH from the cmux server IP (for initial setup/debugging) and Tailscale UDP (port 41641) from anywhere. All workspace traffic flows through the Tailscale tunnel.

## Sandbox Lifecycle

Three-state lifecycle with automatic transitions:

```
Running (1hr TTL) --> Stopped ($0 compute, EBS only ~$3.84/mo) --> Terminated (destroyed)
```

- **Running -> Stopped**: GC stops instances after 1 hour of inactivity. Compute costs drop to zero; only EBS storage charges remain.
- **Stopped -> Running**: Resume via `startInstance()` + Tailscale re-auth. ~60s cold start acceptable.
- **Stopped -> Terminated**: After 7-day archive timeout, the instance is terminated and Tailscale device deleted.
- **No warm pool** initially. On-demand launch with 60s cold start is acceptable for 10-15 concurrent sandboxes.

## Infrastructure

- **Terraform** (`infra/aws/`) provisions: VPC, internet gateway, public subnets, security group, IAM role/instance profile for workspaces, IAM policy for the cmux server.
- **Multi-region support**: central server in `us-east-2`, workspaces can launch in any configured region. AMIs can be copied cross-region via `copyAmiToRegion()`.
- **Golden AMI** built via `scripts/build-ami.sh`: Ubuntu 24.04 ARM base with Docker, Node.js 24, Bun, git, gh, noVNC, OpenVSCode Server, Tailscale, and the execd binary. Systemd services for execd and OpenVSCode.

## Standard Workspace Ports

| Port  | Service    |
|-------|------------|
| 39375 | exec daemon|
| 39377 | worker     |
| 39378 | vscode     |
| 39379 | proxy      |
| 39380 | vnc        |
| 39381 | devtools   |
| 39383 | pty        |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AWS_EC2_ACCESS_KEY_ID` | IAM credentials for EC2 management |
| `AWS_EC2_SECRET_ACCESS_KEY` | IAM credentials for EC2 management |
| `AWS_EC2_REGION` | Default region (e.g., `us-east-2`) |
| `AWS_EC2_INSTANCE_TYPE` | Default instance type (e.g., `t4g.2xlarge`) |
| `AWS_EC2_AMI_IDS` | JSON map of region to AMI ID |
| `AWS_EC2_SUBNET_IDS` | JSON map of region to subnet ID |
| `AWS_EC2_SECURITY_GROUP_IDS` | JSON map of region to security group ID |
| `TAILSCALE_API_KEY` | Tailscale API key for the cmux tailnet |
| `TAILSCALE_TAILNET` | Tailscale tailnet name |
| `TAILSCALE_SHARE_TO_TAILNETS` | JSON array of tailnets to share nodes with |

## Deployment Steps

1. Set the environment variables above in your deployment workspace.
2. Run `terraform apply` in `infra/aws/` to provision VPC, security groups, and IAM.
3. Run `scripts/build-ami.sh` to build the golden AMI (pass `--regions` to copy cross-region).
4. Set `SANDBOX_PROVIDER=aws` and configure the AMI/subnet/SG ID maps from Terraform outputs.
