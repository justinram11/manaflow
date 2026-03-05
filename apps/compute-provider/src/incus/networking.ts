import { incusContainerExec } from "./cli.ts";
import { incusCommand } from "./cli.ts";

/**
 * Configure IPv4 networking inside a freshly launched container.
 *
 * Docker-exported images may not have a DHCP client. We try dhclient first,
 * then fall back to static IP assignment using the Incus bridge subnet.
 */
export async function configureContainerNetwork(
  containerName: string,
): Promise<void> {
  // Try dhclient first
  const dhcpResult = await incusContainerExec(containerName, [
    "bash",
    "-c",
    "command -v dhclient >/dev/null 2>&1 && dhclient eth0 -v 2>&1 && cat /etc/resolv.conf",
  ]);

  if (dhcpResult.exitCode === 0) {
    console.log(
      `[incus-provider] Network configured via DHCP in ${containerName}`,
    );
    return;
  }

  // Fallback: assign a static IP using the Incus bridge subnet
  console.log(
    `[incus-provider] DHCP unavailable in ${containerName}, using static IP fallback`,
  );

  // Get bridge network config from Incus
  const networkResult = await incusCommand([
    "network", "show", "incusbr0", "--format", "json",
  ]);

  if (networkResult.exitCode !== 0) {
    console.error(
      `[incus-provider] Failed to get bridge config: ${networkResult.stderr}`,
    );
    return;
  }

  const networkConfig = JSON.parse(networkResult.stdout) as {
    config: Record<string, string>;
  };
  const bridgeCidr = networkConfig.config["ipv4.address"]; // e.g. "10.61.176.1/24"
  if (!bridgeCidr) {
    console.error("[incus-provider] No IPv4 address on incusbr0");
    return;
  }

  const [gatewayIp, prefixLen] = bridgeCidr.split("/");
  // Generate a unique IP from container name hash (range .2-.254)
  const hash = containerName.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const hostPart = (hash % 253) + 2;
  const subnet = gatewayIp.split(".").slice(0, 3).join(".");
  const containerIp = `${subnet}.${hostPart}`;

  const result = await incusContainerExec(containerName, [
    "bash",
    "-c",
    [
      `ip addr add ${containerIp}/${prefixLen} dev eth0 2>/dev/null || true`,
      `ip route add default via ${gatewayIp} 2>/dev/null || true`,
      `printf 'nameserver ${gatewayIp}\\n' > /etc/resolv.conf`,
      `echo "Static IP: ${containerIp}"`,
    ].join(" && "),
  ]);

  if (result.exitCode !== 0) {
    console.error(
      `[incus-provider] Static IP fallback failed in ${containerName}: ${result.stderr}`,
    );
  } else {
    console.log(
      `[incus-provider] ${result.stdout.trim()} in ${containerName}`,
    );
  }
}
