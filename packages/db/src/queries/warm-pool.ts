import { eq, and } from "drizzle-orm";
import type { DbClient } from "../connection";
import { warmPool } from "../schema/index";

/**
 * Find ready instances for a given team.
 */
export function getReadyInstances(db: DbClient, teamId: string) {
  return db
    .select()
    .from(warmPool)
    .where(and(eq(warmPool.teamId, teamId), eq(warmPool.status, "ready")))
    .all();
}

/**
 * Find provisioning instances for a given team.
 */
export function getProvisioningInstances(db: DbClient, teamId: string) {
  return db
    .select()
    .from(warmPool)
    .where(
      and(eq(warmPool.teamId, teamId), eq(warmPool.status, "provisioning")),
    )
    .all();
}
