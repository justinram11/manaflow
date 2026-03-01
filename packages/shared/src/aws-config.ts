/**
 * AWS EC2 provider configuration.
 *
 * AMI IDs are stored per-region. When a new AMI is built, copy it to
 * all target regions with `aws ec2 copy-image` and update this map.
 */

export interface AwsRegionConfig {
  amiId: string;
  subnetId: string;
  securityGroupId: string;
}

export interface AwsConfig {
  /** Default EC2 instance type (ARM/Graviton). */
  defaultInstanceType: string;
  /** Default region for new workspaces. */
  defaultRegion: string;
  /** Per-region configuration (AMI, subnet, SG). */
  regions: Record<string, AwsRegionConfig>;
}

/**
 * Build an AwsConfig from environment variables.
 *
 * Expected env vars (all JSON maps keyed by region):
 *   AWS_EC2_AMI_IDS          = {"us-east-2":"ami-xxx"}
 *   AWS_EC2_SUBNET_IDS       = {"us-east-2":"subnet-xxx"}
 *   AWS_EC2_SECURITY_GROUP_IDS = {"us-east-2":"sg-xxx"}
 */
export function buildAwsConfigFromEnv(env: {
  defaultInstanceType?: string;
  defaultRegion?: string;
  amiIds?: string;
  subnetIds?: string;
  securityGroupIds?: string;
}): AwsConfig {
  const defaultRegion = env.defaultRegion ?? "us-east-2";
  const defaultInstanceType = env.defaultInstanceType ?? "t4g.2xlarge";

  const amiIds: Record<string, string> = env.amiIds ? JSON.parse(env.amiIds) : {};
  const subnetIds: Record<string, string> = env.subnetIds ? JSON.parse(env.subnetIds) : {};
  const securityGroupIds: Record<string, string> = env.securityGroupIds
    ? JSON.parse(env.securityGroupIds)
    : {};

  const allRegions = new Set([
    ...Object.keys(amiIds),
    ...Object.keys(subnetIds),
    ...Object.keys(securityGroupIds),
  ]);

  const regions: Record<string, AwsRegionConfig> = {};
  for (const region of allRegions) {
    const amiId = amiIds[region];
    const subnetId = subnetIds[region];
    const securityGroupId = securityGroupIds[region];
    if (amiId && subnetId && securityGroupId) {
      regions[region] = { amiId, subnetId, securityGroupId };
    }
  }

  return { defaultInstanceType, defaultRegion, regions };
}

/** Standard workspace ports (same across all providers). */
export const WORKSPACE_PORTS = {
  exec: 39375,
  worker: 39377,
  vscode: 39378,
  proxy: 39379,
  vnc: 39380,
  devtools: 39381,
  pty: 39383,
} as const;
