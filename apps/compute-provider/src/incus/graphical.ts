import { readFileSync } from "node:fs";
import { incusContainerExec } from "./cli.ts";

const loadRepoAsset = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), "utf-8");

const CMUX_TARGET_UNIT = loadRepoAsset("../../../../configs/systemd/cmux.target");
const CMUX_OPENBOX_UNIT = loadRepoAsset("../../../../configs/systemd/cmux-openbox.service");
const CMUX_TIGERVNC_UNIT = loadRepoAsset("../../../../configs/systemd/cmux-tigervnc.service");
const CMUX_DEVTOOLS_UNIT = loadRepoAsset("../../../../configs/systemd/cmux-devtools.service");
const CMUX_START_CHROME = loadRepoAsset("../../../../configs/systemd/bin/cmux-start-chrome");

const CMUX_VNC_PROXY_UNIT = `[Unit]
Description=Cmux VNC websocket proxy
After=cmux-tigervnc.service
Requires=cmux-tigervnc.service

[Service]
Type=simple
ExecStartPre=/bin/mkdir -p /var/log/cmux
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 39380 127.0.0.1:5901
Restart=always
RestartSec=3
StandardOutput=append:/var/log/cmux/vnc-proxy.log
StandardError=append:/var/log/cmux/vnc-proxy.log

[Install]
WantedBy=cmux.target
`;

/**
 * Enable graphical services (Openbox WM, Chrome browser, TigerVNC, noVNC/websockify)
 * in the container.
 *
 * Incus snapshots can lag behind the current systemd/unit layout, so this bootstrap
 * writes the required units and helper script every launch instead of assuming they
 * already exist in the image.
 */
export async function enableGraphicalServices(
  containerName: string,
): Promise<void> {
  const setupScript = `
set -e

mkdir -p /usr/local/lib/cmux /etc/systemd/system/cmux.target.wants /var/log/cmux

cat > /usr/lib/systemd/system/cmux.target <<'UNIT'
${CMUX_TARGET_UNIT}
UNIT

cat > /usr/lib/systemd/system/cmux-openbox.service <<'UNIT'
${CMUX_OPENBOX_UNIT}
UNIT

cat > /usr/lib/systemd/system/cmux-tigervnc.service <<'UNIT'
${CMUX_TIGERVNC_UNIT}
UNIT

cat > /usr/lib/systemd/system/cmux-devtools.service <<'UNIT'
${CMUX_DEVTOOLS_UNIT}
UNIT

cat > /usr/lib/systemd/system/cmux-vnc-proxy.service <<'UNIT'
${CMUX_VNC_PROXY_UNIT}
UNIT

cat > /usr/local/lib/cmux/cmux-start-chrome <<'SCRIPT'
${CMUX_START_CHROME}
SCRIPT
chmod +x /usr/local/lib/cmux/cmux-start-chrome

# Remove the Docker-specific drop-in that disables graphical extras.
rm -f /etc/systemd/system/cmux.target.d/10-docker.conf

# Ensure the graphical units are enabled from cmux.target.
ln -sf /usr/lib/systemd/system/cmux.target /etc/systemd/system/multi-user.target.wants/cmux.target
ln -sf /usr/lib/systemd/system/cmux-openbox.service /etc/systemd/system/cmux.target.wants/cmux-openbox.service
ln -sf /usr/lib/systemd/system/cmux-devtools.service /etc/systemd/system/cmux.target.wants/cmux-devtools.service
ln -sf /usr/lib/systemd/system/cmux-tigervnc.service /etc/systemd/system/cmux.target.wants/cmux-tigervnc.service
ln -sf /usr/lib/systemd/system/cmux-vnc-proxy.service /etc/systemd/system/cmux.target.wants/cmux-vnc-proxy.service

systemctl daemon-reload
systemctl enable cmux.target cmux-openbox.service cmux-devtools.service cmux-tigervnc.service cmux-vnc-proxy.service
systemctl restart cmux-tigervnc.service
systemctl restart cmux-openbox.service
systemctl restart cmux-devtools.service
systemctl restart cmux-vnc-proxy.service
`.trim();

  const result = await incusContainerExec(containerName, [
    "bash",
    "-c",
    setupScript,
  ]);

  if (result.exitCode !== 0) {
    console.error(
      `[incus-provider] Failed to enable graphical services in ${containerName}: ${result.stderr}`,
    );
  } else {
    console.log(
      `[incus-provider] Graphical services enabled in ${containerName}`,
    );
  }
}

/**
 * Enable Android display services (Xvfb :2, TigerVNC :2, VNC WS proxy) in the container.
 *
 * These services are NOT part of cmux.target — they are started on demand only when
 * the sandbox is launched with `displays: ["android"]`.
 */
export async function enableSimulatorDisplays(
  containerName: string,
): Promise<void> {
  const result = await incusContainerExec(containerName, [
    "systemctl",
    "start",
    "cmux-android-xvfb.service",
    "cmux-android-tigervnc.service",
    "cmux-android-vnc-proxy.service",
  ]);

  if (result.exitCode !== 0) {
    console.error(
      `[incus-provider] Failed to enable Android display services in ${containerName}: ${result.stderr}`,
    );
  } else {
    console.log(
      `[incus-provider] Android display services enabled in ${containerName}`,
    );
  }
}
