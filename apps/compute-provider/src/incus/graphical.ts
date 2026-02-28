import { incusContainerExec } from "./cli.ts";

/**
 * Enable graphical services (fluxbox WM, Chrome devtools, CDP proxy) in the container.
 *
 * The Docker image disables these via a drop-in override on cmux.target, and the
 * openbox service file is not included. For Incus containers we:
 * 1. Create a cmux-fluxbox.service (using the installed fluxbox binary)
 * 2. Override cmux-devtools.service to depend on fluxbox instead of openbox
 * 3. Remove the Docker drop-in, enable everything, and start the services
 */
export async function enableGraphicalServices(
  containerName: string,
): Promise<void> {
  const setupScript = `
set -e

# Create fluxbox window manager service (fluxbox is installed, openbox is not)
cat > /usr/lib/systemd/system/cmux-fluxbox.service << 'UNIT'
[Unit]
Description=Cmux Fluxbox window manager
After=cmux-tigervnc.service
Requires=cmux-tigervnc.service

[Service]
Type=simple
Environment=DISPLAY=:1
Environment=HOME=/root
ExecStartPre=/bin/mkdir -p /var/log/cmux
ExecStartPre=/bin/sleep 1
ExecStart=/usr/bin/fluxbox
Restart=always
RestartSec=3
StandardOutput=append:/var/log/cmux/fluxbox.log
StandardError=append:/var/log/cmux/fluxbox.log

[Install]
WantedBy=cmux.target
UNIT

# Rewrite cmux-devtools.service to depend on fluxbox instead of openbox
cat > /usr/lib/systemd/system/cmux-devtools.service << 'UNIT'
[Unit]
Description=Cmux Chrome DevTools browser
After=cmux-fluxbox.service
Requires=cmux-fluxbox.service

[Service]
Type=simple
Environment=DISPLAY=:1
Environment=CDP_TARGET_HOST=127.0.0.1
Environment=CDP_TARGET_PORT=39382
Environment=CHROME_USER_DATA_DIR=/root/.config/chrome
ExecStartPre=/bin/mkdir -p /var/log/cmux
ExecStart=/usr/local/lib/cmux/cmux-start-chrome
Restart=always
RestartSec=3
TimeoutStopSec=30
StandardOutput=append:/var/log/cmux/chrome.log
StandardError=append:/var/log/cmux/chrome.log

[Install]
WantedBy=cmux.target
UNIT

# Remove the Docker-specific drop-in that excludes devtools from cmux.target
rm -f /etc/systemd/system/cmux.target.d/10-docker.conf

# Enable the services
ln -sf /usr/lib/systemd/system/cmux-fluxbox.service /etc/systemd/system/cmux.target.wants/cmux-fluxbox.service
ln -sf /usr/lib/systemd/system/cmux-devtools.service /etc/systemd/system/cmux.target.wants/cmux-devtools.service
ln -sf /usr/lib/systemd/system/cmux-cdp-proxy.service /etc/systemd/system/cmux.target.wants/cmux-cdp-proxy.service

# Reload and start
systemctl daemon-reload
systemctl start cmux-fluxbox.service
systemctl start cmux-devtools.service
systemctl start cmux-cdp-proxy.service
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
