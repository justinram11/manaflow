import { eq } from "drizzle-orm";
import type { DbClient } from "../connection";
import { providerSnapshots } from "../schema/provider-snapshots";
import { resolveTeamId } from "../queries/teams";

export function createProviderSnapshot(
  db: DbClient,
  opts: {
    providerId: string;
    teamSlugOrId: string;
    externalId: string;
    name: string;
    stateful?: boolean;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const now = Date.now();
  const id = crypto.randomUUID();

  db.insert(providerSnapshots)
    .values({
      id,
      providerId: opts.providerId,
      teamId,
      externalId: opts.externalId,
      name: opts.name,
      stateful: opts.stateful ?? false,
      createdAt: now,
    })
    .run();

  return { id };
}

export function deleteProviderSnapshot(db: DbClient, id: string) {
  db.delete(providerSnapshots).where(eq(providerSnapshots.id, id)).run();
}
