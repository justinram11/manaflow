# syntax=docker/dockerfile:1.7-labs

ARG RUST_VERSION=1.91.0
ARG DOCKER_VERSION=27.4.0
ARG DOCKER_COMPOSE_VERSION=2.29.7
ARG BUILDKIT_VERSION=0.15.2

FROM rust:${RUST_VERSION}-bullseye AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
  pkg-config \
  libssl-dev \
  clang \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY packages/sandbox/Cargo.toml packages/sandbox/Cargo.lock ./
COPY packages/sandbox/src ./src

RUN cargo build --release --bin cmux --bin cmux-sandboxd

FROM ubuntu:24.04 AS dind-installer

ARG DOCKER_VERSION
ARG DOCKER_COMPOSE_VERSION
ARG BUILDKIT_VERSION

SHELL ["/bin/bash", "-c"]

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  wget \
  jq \
  iptables \
  iproute2 \
  && rm -rf /var/lib/apt/lists/*

RUN <<'EOF'
set -euo pipefail
arch="$(uname -m)"
case "$arch" in
  x86_64) docker_arch="x86_64"; buildkit_arch="linux-amd64" ;;
  aarch64) docker_arch="aarch64"; buildkit_arch="linux-arm64" ;;
  *) echo "Unsupported architecture: ${arch}" >&2; exit 1 ;;
esac

wget -O /tmp/docker.tgz "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_VERSION}.tgz"
tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1

mkdir -p /usr/local/lib/docker/cli-plugins
wget -O /usr/local/lib/docker/cli-plugins/docker-compose \
  "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-linux-${docker_arch}"
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

wget -O /tmp/buildkit.tgz "https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/buildkit-v${BUILDKIT_VERSION}.${buildkit_arch}.tar.gz"
tar -xzf /tmp/buildkit.tgz -C /tmp
install -m 0755 /tmp/bin/buildkitd /usr/local/bin/buildkitd
install -m 0755 /tmp/bin/buildctl /usr/local/bin/buildctl
rm -rf /tmp/buildkit.tgz /tmp/bin
EOF

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt-get update && apt-get install -y --no-install-recommends \
  bubblewrap \
  iproute2 \
  iptables \
  iputils-ping \
  uidmap \
  fuse-overlayfs \
  util-linux \
  systemd \
  systemd-sysv \
  dbus \
  ca-certificates \
  curl \
  bash \
  tini \
  python3 \
  python3-venv \
  tmux \
  lsof \
  htop \
  btop \
  unzip \
  sudo \
  && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    mv /root/.local/bin/uv /usr/local/bin/uv

RUN update-alternatives --set iptables /usr/sbin/iptables-legacy || true
RUN mkdir -p /var/lib/cmux/sandboxes

COPY --from=dind-installer /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dind-installer /usr/local/bin/dockerd /usr/local/bin/dockerd
COPY --from=dind-installer /usr/local/bin/docker-init /usr/local/bin/docker-init
COPY --from=dind-installer /usr/local/bin/docker-proxy /usr/local/bin/docker-proxy
COPY --from=dind-installer /usr/local/bin/containerd /usr/local/bin/containerd
COPY --from=dind-installer /usr/local/bin/containerd-shim-runc-v2 /usr/local/bin/containerd-shim-runc-v2
COPY --from=dind-installer /usr/local/bin/runc /usr/local/bin/runc
COPY --from=dind-installer /usr/local/bin/ctr /usr/local/bin/ctr
COPY --from=dind-installer /usr/local/bin/buildctl /usr/local/bin/buildctl
COPY --from=dind-installer /usr/local/bin/buildkitd /usr/local/bin/buildkitd
COPY --from=dind-installer /usr/local/lib/docker/cli-plugins/ /usr/local/lib/docker/cli-plugins/

COPY --from=builder /workspace/target/release/cmux-sandboxd /usr/local/bin/cmux-sandboxd
COPY --from=builder /workspace/target/release/cmux /usr/local/bin/cmux

COPY packages/sandbox/scripts/bootstrap-dind.sh /usr/local/bin/bootstrap-dind.sh
RUN chmod +x /usr/local/bin/bootstrap-dind.sh

# systemd service units
COPY packages/sandbox/systemd/dockerd.service /etc/systemd/system/dockerd.service
COPY packages/sandbox/systemd/buildkitd.service /etc/systemd/system/buildkitd.service
COPY packages/sandbox/systemd/cmux-sandboxd.service /etc/systemd/system/cmux-sandboxd.service
RUN echo "CMUX_SANDBOX_PORT=46831" > /etc/default/cmux-sandboxd
RUN mkdir -p /etc/systemd/system/multi-user.target.wants && \
  ln -s /etc/systemd/system/dockerd.service /etc/systemd/system/multi-user.target.wants/dockerd.service && \
  ln -s /etc/systemd/system/buildkitd.service /etc/systemd/system/multi-user.target.wants/buildkitd.service && \
  ln -s /etc/systemd/system/cmux-sandboxd.service /etc/systemd/system/multi-user.target.wants/cmux-sandboxd.service

ENV CMUX_SANDBOX_PORT=46831 \
  DOCKER_HOST=unix:///var/run/docker.sock

EXPOSE 46831
VOLUME ["/var/lib/docker", "/var/lib/cmux/sandboxes"]

ENV container=docker
STOPSIGNAL SIGRTMIN+3
VOLUME ["/sys/fs/cgroup"]
ENTRYPOINT ["/sbin/init"]
