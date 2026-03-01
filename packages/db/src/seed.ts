import { getDb, closeDb } from "./connection";
import { teams, teamMemberships, users } from "./schema/index";
import { eq, and } from "drizzle-orm";

const SHARED_TEAM = {
  teamId: "local-team-00000000-0000-0000-0000-000000000001",
  slug: "senes",
  displayName: "Senes",
};

// Same seed data used by the local auth system
const LOCAL_USERS = [
  {
    id: "local-user-00000000-0000-0000-0000-000000000010",
    email: "justin@getsenes.com",
    displayName: "Justin",
    teamSlug: "justin",
    teamId: "local-team-00000000-0000-0000-0000-000000000010",
  },
  {
    id: "local-user-00000000-0000-0000-0000-000000000020",
    email: "colby@getsenes.com",
    displayName: "Colby",
    teamSlug: "colby",
    teamId: "local-team-00000000-0000-0000-0000-000000000020",
  },
];

console.log("Seeding database...");
const db = getDb();

// Upsert shared team
const existingSharedTeam = db
  .select()
  .from(teams)
  .where(eq(teams.teamId, SHARED_TEAM.teamId))
  .get();

if (!existingSharedTeam) {
  const now = Date.now();
  db.insert(teams)
    .values({
      id: SHARED_TEAM.teamId,
      teamId: SHARED_TEAM.teamId,
      slug: SHARED_TEAM.slug,
      displayName: SHARED_TEAM.displayName,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  console.log(`  Created shared team: ${SHARED_TEAM.slug} (${SHARED_TEAM.teamId})`);
} else {
  console.log(`  Shared team already exists: ${SHARED_TEAM.slug}`);
}

for (const u of LOCAL_USERS) {
  const now = Date.now();

  // Upsert personal team
  const existingTeam = db
    .select()
    .from(teams)
    .where(eq(teams.teamId, u.teamId))
    .get();

  if (!existingTeam) {
    db.insert(teams)
      .values({
        id: u.teamId,
        teamId: u.teamId,
        slug: u.teamSlug,
        displayName: `${u.displayName}'s Team`,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    console.log(`  Created team: ${u.teamSlug} (${u.teamId})`);
  } else {
    console.log(`  Team already exists: ${u.teamSlug}`);
  }

  // Upsert user (default to shared team)
  const existingUser = db
    .select()
    .from(users)
    .where(eq(users.userId, u.id))
    .get();

  if (!existingUser) {
    db.insert(users)
      .values({
        id: u.id,
        userId: u.id,
        primaryEmail: u.email,
        displayName: u.displayName,
        selectedTeamId: SHARED_TEAM.teamId,
        selectedTeamDisplayName: SHARED_TEAM.displayName,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    console.log(`  Created user: ${u.displayName} (${u.id})`);
  } else {
    console.log(`  User already exists: ${u.displayName}`);
  }

  // Upsert personal team membership
  const existingMembership = db
    .select()
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.teamId, u.teamId),
        eq(teamMemberships.userId, u.id),
      ),
    )
    .get();

  if (!existingMembership) {
    db.insert(teamMemberships)
      .values({
        teamId: u.teamId,
        userId: u.id,
        role: "owner",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    console.log(`  Created membership: ${u.displayName} -> ${u.teamSlug}`);
  } else {
    console.log(`  Membership already exists: ${u.displayName} -> ${u.teamSlug}`);
  }

  // Upsert shared team membership
  const existingSharedMembership = db
    .select()
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.teamId, SHARED_TEAM.teamId),
        eq(teamMemberships.userId, u.id),
      ),
    )
    .get();

  if (!existingSharedMembership) {
    db.insert(teamMemberships)
      .values({
        teamId: SHARED_TEAM.teamId,
        userId: u.id,
        role: "member",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    console.log(`  Created membership: ${u.displayName} -> ${SHARED_TEAM.slug}`);
  } else {
    console.log(`  Membership already exists: ${u.displayName} -> ${SHARED_TEAM.slug}`);
  }
}

console.log("Seed complete.");
closeDb();
