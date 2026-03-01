/**
 * Low-level AWS EC2 operations for the cmux sandbox provider.
 *
 * Uses the AWS SDK v3 to manage EC2 instances as sandbox workspaces.
 * Each sandbox is a single EC2 instance launched from a golden AMI.
 */

import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
  StopInstancesCommand,
  StartInstancesCommand,
  TerminateInstancesCommand,
  CreateImageCommand,
  DescribeImagesCommand,
  DeregisterImageCommand,
  CopyImageCommand,
  type _InstanceType,
  type Tag,
} from "@aws-sdk/client-ec2";

/** Minimal info we track per EC2 workspace instance. */
export interface Ec2InstanceInfo {
  instanceId: string;
  state: string;
  region: string;
  publicIp?: string;
  privateIp?: string;
  tags: Record<string, string>;
}

/** Create an EC2 client for the given region. */
export function createEc2Client(region: string, credentials?: {
  accessKeyId: string;
  secretAccessKey: string;
}): EC2Client {
  return new EC2Client({
    region,
    ...(credentials ? { credentials } : {}),
  });
}

/** Tag key prefix for cmux metadata. */
const TAG_PREFIX = "cmux:";

function cmuxTags(metadata: Record<string, string>): Tag[] {
  return Object.entries(metadata).map(([key, value]) => ({
    Key: `${TAG_PREFIX}${key}`,
    Value: value,
  }));
}

function parseCmuxTags(tags: Tag[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const tag of tags ?? []) {
    if (tag.Key?.startsWith(TAG_PREFIX) && tag.Value !== undefined) {
      result[tag.Key.slice(TAG_PREFIX.length)] = tag.Value;
    }
  }
  return result;
}

/**
 * Launch a new EC2 instance from an AMI.
 *
 * The user-data script configures Tailscale on first boot.
 */
export async function launchInstance(
  client: EC2Client,
  opts: {
    amiId: string;
    instanceType: string;
    securityGroupId: string;
    subnetId: string;
    userData: string;
    metadata: Record<string, string>;
  },
): Promise<{ instanceId: string }> {
  const nameTag = opts.metadata["sandbox-id"] ?? `cmux-${Date.now()}`;

  const res = await client.send(
    new RunInstancesCommand({
      ImageId: opts.amiId,
      InstanceType: opts.instanceType as _InstanceType,
      MinCount: 1,
      MaxCount: 1,
      SecurityGroupIds: [opts.securityGroupId],
      SubnetId: opts.subnetId,
      UserData: Buffer.from(opts.userData).toString("base64"),
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: [
            { Key: "Name", Value: nameTag },
            ...cmuxTags(opts.metadata),
          ],
        },
      ],
      // EBS root volume — gp3 for better performance
      BlockDeviceMappings: [
        {
          DeviceName: "/dev/sda1",
          Ebs: {
            VolumeSize: 48,
            VolumeType: "gp3",
            DeleteOnTermination: true,
          },
        },
      ],
    }),
  );

  const instanceId = res.Instances?.[0]?.InstanceId;
  if (!instanceId) {
    throw new Error("EC2 RunInstances returned no instance ID");
  }

  return { instanceId };
}

/** Wait for an instance to reach a target state (e.g. "running", "stopped"). */
export async function waitForInstanceState(
  client: EC2Client,
  instanceId: string,
  targetState: string,
  timeoutMs = 120_000,
): Promise<Ec2InstanceInfo> {
  const start = Date.now();
  const interval = 3_000;

  while (Date.now() - start < timeoutMs) {
    const info = await describeInstance(client, instanceId);
    if (!info) {
      throw new Error(`Instance ${instanceId} not found`);
    }
    if (info.state === targetState) {
      return info;
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(
    `Instance ${instanceId} did not reach state "${targetState}" within ${timeoutMs}ms`,
  );
}

/** Get instance details. */
export async function describeInstance(
  client: EC2Client,
  instanceId: string,
): Promise<Ec2InstanceInfo | null> {
  const res = await client.send(
    new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
  );

  const instance = res.Reservations?.[0]?.Instances?.[0];
  if (!instance) return null;

  return {
    instanceId: instance.InstanceId ?? instanceId,
    state: instance.State?.Name ?? "unknown",
    region: "", // filled in by caller
    publicIp: instance.PublicIpAddress ?? undefined,
    privateIp: instance.PrivateIpAddress ?? undefined,
    tags: parseCmuxTags(instance.Tags),
  };
}

/** Stop an instance (preserves EBS, $0 compute). */
export async function stopInstance(
  client: EC2Client,
  instanceId: string,
): Promise<void> {
  await client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
}

/** Start a stopped instance. */
export async function startInstance(
  client: EC2Client,
  instanceId: string,
): Promise<void> {
  await client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
}

/** Terminate an instance (permanent deletion). */
export async function terminateInstance(
  client: EC2Client,
  instanceId: string,
): Promise<void> {
  await client.send(
    new TerminateInstancesCommand({ InstanceIds: [instanceId] }),
  );
}

/** Create an AMI from a running or stopped instance. */
export async function createAmi(
  client: EC2Client,
  instanceId: string,
  name: string,
): Promise<string> {
  const res = await client.send(
    new CreateImageCommand({
      InstanceId: instanceId,
      Name: name,
      Description: `cmux workspace snapshot: ${name}`,
      NoReboot: false,
      TagSpecifications: [
        {
          ResourceType: "image",
          Tags: [
            { Key: "Name", Value: name },
            { Key: `${TAG_PREFIX}type`, Value: "workspace-snapshot" },
            { Key: `${TAG_PREFIX}source-instance`, Value: instanceId },
          ],
        },
      ],
    }),
  );

  const imageId = res.ImageId;
  if (!imageId) {
    throw new Error("CreateImage returned no image ID");
  }
  return imageId;
}

/** List AMIs owned by this account with cmux tags. */
export async function listAmis(
  client: EC2Client,
): Promise<Array<{ imageId: string; name: string; createdAt: string; state: string }>> {
  const res = await client.send(
    new DescribeImagesCommand({
      Owners: ["self"],
      Filters: [
        { Name: `tag:${TAG_PREFIX}type`, Values: ["workspace-snapshot"] },
      ],
    }),
  );

  return (res.Images ?? []).map((img) => ({
    imageId: img.ImageId ?? "",
    name: img.Name ?? "",
    createdAt: img.CreationDate ?? "",
    state: img.State ?? "unknown",
  }));
}

/** Deregister (delete) an AMI. */
export async function deregisterAmi(
  client: EC2Client,
  imageId: string,
): Promise<void> {
  await client.send(new DeregisterImageCommand({ ImageId: imageId }));
}

/** Copy an AMI to another region. */
export async function copyAmiToRegion(
  sourceClient: EC2Client,
  sourceRegion: string,
  sourceImageId: string,
  targetRegion: string,
  name: string,
): Promise<string> {
  const targetClient = createEc2Client(targetRegion);
  const res = await targetClient.send(
    new CopyImageCommand({
      SourceRegion: sourceRegion,
      SourceImageId: sourceImageId,
      Name: name,
      Description: `cmux workspace snapshot (copied from ${sourceRegion})`,
    }),
  );

  const imageId = res.ImageId;
  if (!imageId) {
    throw new Error("CopyImage returned no image ID");
  }
  return imageId;
}

/**
 * List all cmux workspace instances across a region.
 * Used for GC/orphan reconciliation.
 */
export async function listCmuxInstances(
  client: EC2Client,
): Promise<Ec2InstanceInfo[]> {
  const res = await client.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${TAG_PREFIX}app`, Values: ["cmux"] },
        {
          Name: "instance-state-name",
          Values: ["running", "stopped", "pending", "stopping"],
        },
      ],
    }),
  );

  const instances: Ec2InstanceInfo[] = [];
  for (const reservation of res.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      instances.push({
        instanceId: instance.InstanceId ?? "",
        state: instance.State?.Name ?? "unknown",
        region: "",
        publicIp: instance.PublicIpAddress ?? undefined,
        privateIp: instance.PrivateIpAddress ?? undefined,
        tags: parseCmuxTags(instance.Tags),
      });
    }
  }

  return instances;
}
