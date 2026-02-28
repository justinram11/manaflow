import { eq, and } from "drizzle-orm";
import type { DbClient } from "../connection";
import { teams, teamMemberships } from "../schema/index";

export function setTeamSlug(db: DbClient, teamId: string, slug: string) {
  db.update(teams)
    .set({ slug, updatedAt: Date.now() })
    .where(eq(teams.teamId, teamId))
    .run();
}

export function setTeamName(db: DbClient, teamId: string, name: string) {
  db.update(teams)
    .set({ name, updatedAt: Date.now() })
    .where(eq(teams.teamId, teamId))
    .run();
}

export function upsertTeam(
  db: DbClient,
  args: {
    teamId: string;
    displayName?: string;
    profileImageUrl?: string;
    clientMetadata?: unknown;
    clientReadOnlyMetadata?: unknown;
    serverMetadata?: unknown;
    createdAtMillis?: number;
  },
) {
  const now = Date.now();
  const existing = db
    .select()
    .from(teams)
    .where(eq(teams.teamId, args.teamId))
    .get();

  if (existing) {
    db.update(teams)
      .set({
        displayName: args.displayName ?? existing.displayName,
        profileImageUrl: args.profileImageUrl ?? existing.profileImageUrl,
        clientMetadata: args.clientMetadata ?? existing.clientMetadata,
        clientReadOnlyMetadata:
          args.clientReadOnlyMetadata ?? existing.clientReadOnlyMetadata,
        serverMetadata: args.serverMetadata ?? existing.serverMetadata,
        updatedAt: now,
      })
      .where(eq(teams.teamId, args.teamId))
      .run();
  } else {
    db.insert(teams)
      .values({
        teamId: args.teamId,
        displayName: args.displayName ?? null,
        profileImageUrl: args.profileImageUrl ?? null,
        clientMetadata: args.clientMetadata ?? null,
        clientReadOnlyMetadata: args.clientReadOnlyMetadata ?? null,
        serverMetadata: args.serverMetadata ?? null,
        createdAtMillis: args.createdAtMillis ?? now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

export function ensureTeamMembership(
  db: DbClient,
  teamId: string,
  userId: string,
) {
  const now = Date.now();
  const existing = db
    .select()
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.teamId, teamId),
        eq(teamMemberships.userId, userId),
      ),
    )
    .get();

  if (existing) {
    db.update(teamMemberships)
      .set({ updatedAt: now })
      .where(eq(teamMemberships.id, existing.id))
      .run();
  } else {
    db.insert(teamMemberships)
      .values({
        teamId,
        userId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}
