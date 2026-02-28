import { incusContainerExec } from "./cli.ts";

/**
 * Configure IPv4 networking inside a freshly launched container.
 *
 * Docker-exported images have no DHCP client configuration or systemd-networkd.
 * We run dhclient to obtain a DHCP lease from the Incus bridge's dnsmasq,
 * which gives us a proper IP, default route, and DNS — and ensures NAT works
 * (Incus only NATs traffic from known DHCP leases).
 */
export async function configureContainerNetwork(
  containerName: string,
): Promise<void> {
  const result = await incusContainerExec(containerName, [
    "bash",
    "-c",
    "dhclient eth0 -v 2>&1 && cat /etc/resolv.conf",
  ]);

  if (result.exitCode !== 0) {
    console.error(
      `[incus-provider] Failed to configure network in ${containerName}: ${result.stderr}`,
    );
  } else {
    console.log(
      `[incus-provider] Network configured via DHCP in ${containerName}`,
    );
  }
}
