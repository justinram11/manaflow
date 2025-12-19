"use node";

import { internalAction } from "./_generated/server";
import { env } from "../_shared/convex-env";
import {
  createMorphCloudClient,
  listInstancesInstanceGet,
  pauseInstanceInstanceInstanceIdPausePost,
  type InstanceModel,
} from "@cmux/morphcloud-openapi-client";

const HOURS_THRESHOLD = 20;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const BATCH_SIZE = 5;

/**
 * Pauses all Morph instances that have been running for more than 20 hours.
 * Called by the daily cron job at 4 AM Pacific Time.
 */
export const pauseOldMorphInstances = internalAction({
  args: {},
  handler: async () => {
    // Only run in production to avoid dev crons affecting prod instances
    if (!env.CONVEX_IS_PRODUCTION) {
      console.log("[morphInstanceMaintenance] Skipping: not in production");
      return;
    }

    const morphApiKey = env.MORPH_API_KEY;
    if (!morphApiKey) {
      console.error("[morphInstanceMaintenance] MORPH_API_KEY not configured");
      return;
    }

    const morphClient = createMorphCloudClient({
      auth: morphApiKey,
    });

    // List all instances
    const listResponse = await listInstancesInstanceGet({
      client: morphClient,
    });

    if (listResponse.error) {
      console.error(
        "[morphInstanceMaintenance] Failed to list instances:",
        listResponse.error
      );
      return;
    }

    const instances = listResponse.data?.data ?? [];
    if (instances.length === 0) {
      console.log("[morphInstanceMaintenance] No instances found");
      return;
    }

    const now = Date.now();
    const thresholdMs = HOURS_THRESHOLD * MILLISECONDS_PER_HOUR;

    // Filter for ready instances older than the threshold
    const staleActiveInstances = instances
      .filter((instance: InstanceModel) => instance.status === "ready")
      .filter((instance: InstanceModel) => {
        const createdMs = instance.created * 1000;
        return now - createdMs > thresholdMs;
      })
      .sort((a: InstanceModel, b: InstanceModel) => a.created - b.created);

    if (staleActiveInstances.length === 0) {
      console.log(
        `[morphInstanceMaintenance] No active instances older than ${HOURS_THRESHOLD} hours`
      );
      return;
    }

    console.log(
      `[morphInstanceMaintenance] Found ${staleActiveInstances.length} active instance(s) older than ${HOURS_THRESHOLD} hours`
    );

    let successCount = 0;
    let failureCount = 0;

    // Process instances in batches to balance speed and rate limiting
    for (let i = 0; i < staleActiveInstances.length; i += BATCH_SIZE) {
      const batch = staleActiveInstances.slice(i, i + BATCH_SIZE);
      console.log(
        `[morphInstanceMaintenance] Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} instances)`
      );

      const results = await Promise.allSettled(
        batch.map(async (instance: InstanceModel) => {
          const ageHours = Math.floor(
            (now - instance.created * 1000) / MILLISECONDS_PER_HOUR
          );
          console.log(
            `[morphInstanceMaintenance] Pausing ${instance.id} (${ageHours}h old)...`
          );

          const pauseResponse = await pauseInstanceInstanceInstanceIdPausePost({
            client: morphClient,
            path: { instance_id: instance.id },
          });

          if (pauseResponse.error) {
            throw new Error(JSON.stringify(pauseResponse.error));
          }

          console.log(`[morphInstanceMaintenance] Paused ${instance.id}`);
          return instance.id;
        })
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const instance = batch[j];
        if (result.status === "fulfilled") {
          successCount++;
        } else {
          failureCount++;
          console.error(
            `[morphInstanceMaintenance] Failed to pause ${instance.id}:`,
            result.reason
          );
        }
      }
    }

    console.log(
      `[morphInstanceMaintenance] Finished: ${successCount} paused, ${failureCount} failed`
    );
  },
});
